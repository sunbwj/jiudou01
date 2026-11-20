# -*- coding: utf-8 -*-
"""
后端接口联调测试（真实 HTTP 请求，JSON 入出参）
用法：
    python server/test_api.py            # 默认 http://127.0.0.1:8808
    python server/test_api.py http://127.0.0.1:9000
覆盖：健康检查、分页、关键字检索、启用状态筛选、详情、唯一性校验、
      新增（含重复拦截）、编辑、删除、菜单组可否绑定菜单项规则、静态页面可访问性。
"""
import io
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8808'
PASS = 0
FAIL = 0


# 全局登录令牌：所有接口都要求 token，除 /api/auth/login 与 /api/auth/captcha
TOKEN = {'value': '', 'account': ''}
# 免登录接口（这两个接口本身不许带 token 校验，否则无法登录）
TOKEN_FREE_PATHS = ('/api/auth/login', '/api/auth/captcha')


def _solve_captcha():
    """取一道验证码并算出答案，返回 (captchaId, 答案字符串)"""
    c = request('GET', '/api/auth/captcha', None, auth=False).get('data') or {}
    question = str(c.get('question') or '')
    m = re.match(r'^(\d+)\s+([+\-\u00d7])\s+(\d+)\s*=\s*\?$', question)
    if not m:
        return str(c.get('captchaId') or ''), ''
    a, op, b = int(m.group(1)), m.group(2), int(m.group(3))
    answer = a + b if op == '+' else (a - b if op == '-' else a * b)
    return str(c.get('captchaId') or ''), str(answer)


def first_account():
    """直接读库取第一个启用用户账号（用户列表接口本身也需要 token，不能用它来引导登录）"""
    try:
        import os
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from db import query_one
        row = query_one('SELECT `account` FROM `useinfo` WHERE `enabled`=1 ORDER BY `account` ASC LIMIT 1')
        return str(row['account']) if row else ''
    except Exception:
        return ''


def all_accounts():
    """直接读库取所有启用账号（用于登录兜底：管理员可能已经自助改过密码）"""
    try:
        import os
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from db import query_all
        rows = query_all('SELECT `account` FROM `useinfo` WHERE `enabled`=1 ORDER BY `account` ASC')
        return [str(r['account']) for r in (rows or [])]
    except Exception:
        return []


def try_login(account, password):
    """用一次验证码 + 账号密码换 token；成功返回 token，失败返回空串"""
    cid, answer = _solve_captcha()
    r = request('POST', '/api/auth/login',
                {'account': account, 'password': password, 'captchaId': cid, 'captchaCode': answer},
                auth=False)
    data = r.get('data') or {}
    if r.get('code') == 0 and data.get('token'):
        return str(data['token'])
    return ''


_LOGIN_ACCOUNT = {'value': ''}


def loginable_account(password='888888'):
    """挑一个「用初始密码仍能登录」的启用账号（管理员可能已自助改过密码，不能假定第一个账号就是 888888）"""
    if _LOGIN_ACCOUNT['value']:
        return _LOGIN_ACCOUNT['value']
    for acc in (all_accounts() or [first_account()]):
        if acc and try_login(acc, password):
            _LOGIN_ACCOUNT['value'] = acc
            return acc
    return first_account()


def login_for_token(account=None, password='888888'):
    """登录并缓存 token：指定账号只用它；否则按账号顺序逐个试（默认初始密码 888888 可能已被改掉）"""
    candidates = [account] if account else (all_accounts() or [first_account()])
    for one in candidates:
        token = try_login(one, password)
        if token:
            TOKEN['value'] = token
            TOKEN['account'] = one
            return token
    return TOKEN['value']


def request(method, path, data=None, auth=True):
    """
    发请求：auth=True（默认）时自动带上全局登录 token；
    auth=False 用于「验证无 token 会被拒绝」以及登录 / 取验证码本身。
    """
    payload = dict(data or {})
    auto_token = False
    if auth and path not in TOKEN_FREE_PATHS and not payload.get('token'):
        if not TOKEN['value']:
            login_for_token()
        if TOKEN['value']:
            payload['token'] = TOKEN['value']
            auto_token = True

    url = BASE + path
    body = None
    headers = {}
    if payload:
        if method == 'GET':
            url = url + '?' + urllib.parse.urlencode(payload)
        else:
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            headers['Content-Type'] = 'application/json;charset=UTF-8'
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'ignore')
        try:
            return json.loads(raw)
        except ValueError:
            return {'code': e.code, 'message': raw}
        # 注：后端业务错误也是 HTTP 200 + code，下面的 401 自动重登只针对接口层返回的 code


def get(path, data=None, auth=True):
    return request('GET', path, data, auth)


def post(path, data=None, auth=True):
    return request('POST', path, data, auth)


def request_raw(method, path, data=None, auth=True):
    """发请求但不解析 JSON（导出 Excel / PDF 这种二进制响应用）：返回 (status, headers, bytes)"""
    payload = dict(data or {})
    if auth and path not in TOKEN_FREE_PATHS and not payload.get('token'):
        if not TOKEN['value']:
            login_for_token()
        if TOKEN['value']:
            payload['token'] = TOKEN['value']
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload else None
    headers = {'Content-Type': 'application/json;charset=UTF-8'} if body else {}
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()


def is_dfs_order(items):
    """校验树形顺序：任一节点的父节点必须排在它之前（深度优先输出的基本约束）"""
    pos = {}
    for i, x in enumerate(items):
        pos[x.get('id')] = i
    for i, x in enumerate(items):
        pid = x.get('parentId') or 0
        if pid and pid in pos and pos[pid] > i:
            return False
    return True


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, extra))


def summary():
    print('')
    print('结果：通过 %d 项，失败 %d 项' % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)


def main():
    print('联调目标：%s' % BASE)

    print('\n--- 0. 健康检查 ---')
    r = get('/api/health')
    check('服务与数据库连通', r.get('code') == 0, str(r))
    data = r.get('data') or {}
    print('      菜单项 %s 条 / 菜单组 %s 条' % (data.get('menuCount'), data.get('groupCount')))
    # 基线条数：以当前库为准，避免手工新增的数据干扰断言
    MENU_BASE = int(data.get('menuCount') or 0)
    GROUP_BASE = int(data.get('groupCount') or 0)
    GI_BASE = int(data.get('groupItemCount') or 0)
    GI1_BASE = get('/api/groupitem/list', {'groupId': 1, 'pageSize': 200})['data']['total']
    TREE_ENABLED_BASE = len(get('/api/group/tree', {'enabled': 1})['data']['list'])

    print('\n--- 0b. 左侧导航 /api/nav（菜单组 + 菜单项 + 绑定关系） ---')

    # 导航已改为「按登录用户角色权限」加载：结构类用例统一用「系统管理员」角色（其权限为全量）
    _roles = (get('/api/role/list', {'pageNum': 1, 'pageSize': 50, 'keyword': '系统管理员'})
              .get('data') or {}).get('list') or []
    ADMIN_ROLE_ID = str(_roles[0]['id']) if _roles else ''
    check('取到「系统管理员」角色（用于导航权限用例）', bool(ADMIN_ROLE_ID), ADMIN_ROLE_ID)

    def get_nav(extra=None):
        params = {'roleId': ADMIN_ROLE_ID}
        if extra:
            params.update(extra)
        return get('/api/nav', params)

    r = get_nav()
    nd = (r.get('data') or {})
    groups = nd.get('groups') or []
    check('导航接口可访问并返回菜单组树', r.get('code') == 0 and len(groups) > 0, str(r)[:160])

    enabled_groups = get('/api/group/tree', {'enabled': 1})['data']['list']
    enabled_codes = set(x['code'] for x in enabled_groups)
    enabled_items = get('/api/menu/list', {'enabled': '1', 'pageSize': 200})['data']['list']
    enabled_item_codes = set(x['code'] for x in enabled_items)

    flat = []

    def walk(nodes):
        for n in nodes:
            flat.append(n)
            walk(n.get('children') or [])
    walk(groups)

    check('导航只含启用的菜单组（%d 个）' % len(enabled_groups),
          len(flat) == len(enabled_groups) and all(x['code'] in enabled_codes for x in flat),
          str([x['code'] for x in flat]))
    check('crumb 为层级路径（父级/自身）',
          all((x['crumb'] == x['nameCn']) if not x['parentId'] else x['crumb'].endswith('/' + x['nameCn'])
              for x in flat),
          str([x['crumb'] for x in flat]))

    leaf_items = []
    for n in flat:
        for it in (n.get('items') or []):
            leaf_items.append(it)
    check('菜单项只挂在「可否绑定菜单项=是」的节点上',
          all(n['hasChild'] for n in flat if n.get('items')),
          str([n['code'] for n in flat if n.get('items') and not n['hasChild']]))
    check('导航只含启用的菜单项', all(it['code'] in enabled_item_codes for it in leaf_items),
          str([it['code'] for it in leaf_items]))
    check('菜单项叶子带完整 crumb（含所属菜单组）',
          all('/' in it['crumb'] and it['crumb'].endswith('/' + it['nameCn']) for it in leaf_items),
          str([it['crumb'] for it in leaf_items]))
    check('同一菜单组内菜单项按显示序号升序',
          all(n['items'][i]['sortNo'] <= n['items'][i + 1]['sortNo']
              for n in flat if n.get('items') for i in range(len(n['items']) - 1)),
          str([[x['sortNo'] for x in n['items']] for n in flat if n.get('items')]))

    print('\n--- 0b2. 导航按「登录用户角色权限」过滤 ---')

    r = get('/api/nav', None, False)
    check('未登录（无 token / roleId）返回 401', r.get('code') == 401, str(r)[:120])
    r = get('/api/nav', {'token': 'x' * 32})
    check('无效 token 返回 401（前端据此回登录页）', r.get('code') == 401, str(r)[:120])
    r = get('/api/nav', {'roleId': 'abc'})
    check('非法 roleId 被拒绝', r.get('code') != 0 and 'roleId' in (r.get('message') or ''), str(r)[:120])
    r = get('/api/nav', {'roleId': '11111111-1111-4111-8111-111111111111'})
    check('不存在的角色返回业务错误', r.get('code') not in (0,), str(r)[:120])

    def nav_flat_items(data):
        out = []

        def walk(nodes):
            for n in nodes:
                for it in (n.get('items') or []):
                    out.append((int(n['id']), int(it['id']), it['code'], it['nameCn']))
                walk(n.get('children') or [])
        walk(data.get('groups') or [])
        return out

    nav_admin = (get_nav().get('data') or {})
    admin_items = nav_flat_items(nav_admin)
    check('系统管理员（全量授权）可见全部 %d 个菜单项' % len(admin_items),
          nav_admin.get('menuCount') == len(admin_items) and len(admin_items) >= 9,
          str(nav_admin.get('menuCount')))
    check('管理员导航含「用户信息管理」（已补授权）',
          any(x[2] == 'MNU00009' for x in admin_items),
          str([x[2] for x in admin_items]))
    check('响应带权限范围信息（roleIds / roleNames / scoped）',
          bool(nav_admin.get('roleIds')) and '系统管理员' in str(nav_admin.get('roleNames'))
          and nav_admin.get('scoped') is True,
          '%s / %s / %s' % (nav_admin.get('roleIds'), nav_admin.get('roleNames'), nav_admin.get('scoped')))

    # 普通用户：只授权了「帮助中心 / 修改密码」
    _prole = (get('/api/role/list', {'pageNum': 1, 'pageSize': 50, 'keyword': '普通用户'})
              .get('data') or {}).get('list') or []
    NORMAL_ROLE_ID = str(_prole[0]['id']) if _prole else ''
    nav_normal = (get_nav({'roleId': NORMAL_ROLE_ID}).get('data') or {})
    normal_items = nav_flat_items(nav_normal)
    # 普通用户：导航必须与「角色实际授权（enabled=1）」完全一致 —— 期望值按授权树动态取，
    # 避免库里的授权数据被人工调整（比如给普通用户开了报表中心）后测试误报
    _ptree = (get('/api/rolepower/tree', {'roleId': NORMAL_ROLE_ID}).get('data') or {})
    _granted_items, _granted_groups = [], []
    for _pg in (_ptree.get('groups') or []):
        for _pit in (_pg.get('items') or []):
            if _pit.get('checked'):
                _granted_items.append(_pit['nameCn'])
                _granted_groups.append(_pg['nameCn'])
    check('普通用户只看到被授权的菜单项（导航与授权数据一致）',
          sorted(x[3] for x in normal_items) == sorted(set(_granted_items)),
          str(sorted(x[3] for x in normal_items)) + ' vs 授权 ' + str(sorted(set(_granted_items))))
    check('未被授权的一级菜单组不出现（组名与授权数据一致）',
          sorted(g['nameCn'] for g in (nav_normal.get('groups') or [])) ==
          sorted(set(_granted_groups)),
          str([g['nameCn'] for g in (nav_normal.get('groups') or [])]) +
          ' vs 授权组 ' + str(sorted(set(_granted_groups))))
    check('普通用户看不到「系统管理 / 人力资源中心」等未授权菜单组',
          all(g['nameCn'] in set(_granted_groups) for g in (nav_normal.get('groups') or [])),
          str([g['nameCn'] for g in (nav_normal.get('groups') or [])]))

    # 没有任何授权的角色（种子里的「审计员」）：导航必须为空
    # ⚠ 当前库是真实配置数据，种子角色可能被删（本库只剩 系统管理员 / 普通用户 / 前端组）：
    #    角色不存在就跳过，别把「种子缺失」误判成代码缺陷；roleId 为空时后端会回落到
    #    token 口径（= 管理员全量导航），那样断言必然失败，不能拿空串去测。
    _arole = (get('/api/role/list', {'pageNum': 1, 'pageSize': 50, 'keyword': '审计员'})
              .get('data') or {}).get('list') or []
    AUDIT_ROLE_ID = str(_arole[0]['id']) if _arole else ''
    if AUDIT_ROLE_ID:
        nav_off = (get_nav({'roleId': AUDIT_ROLE_ID}).get('data') or {})
        check('无权限角色的导航为空（groups 为空且 empty=true）',
              not (nav_off.get('groups') or []) and nav_off.get('empty') is True,
              str(nav_off.get('groups'))[:80])
    else:
        print('      （库里没有「审计员」这个无权限角色，跳过「角色导航为空」校验）')

    # 同级排序：不仅「非递减」，还要真正由排序号驱动 —— 交换排序号后导航顺序必须跟着变（含恢复）
    print('\n--- 0c. 左侧导航：同级菜单组按排序号升序 / 组内菜单项按显示序号升序 ---')

    def nav_roots():
        return (get_nav()['data'] or {}).get('groups') or []

    def nav_find(gid, nodes=None):
        """在最新一次 /api/nav 结果里按 id 递归找节点（子节点可能在更深层级）"""
        for n in (nodes if nodes is not None else nav_roots()):
            if int(n['id']) == int(gid):
                return n
            found = nav_find(gid, n.get('children') or [])
            if found:
                return found
        return None

    def nav_host_with_items():
        """最新导航中第一个绑定 ≥2 个菜单项的节点（递归找）"""
        stack = list(nav_roots())
        while stack:
            n = stack.pop(0)
            if len(n.get('items') or []) >= 2:
                return n
            stack.extend(n.get('children') or [])
        return None

    def group_payload(gid):
        d = get('/api/group/detail', {'id': gid})['data']
        keys = ('id', 'parentId', 'sortNo', 'code', 'nameCn', 'nameEn', 'hasChild', 'path', 'icon', 'enabled')
        return dict((k, d.get(k)) for k in keys)

    roots_now = nav_roots()
    if len(roots_now) >= 2:
        g_a, g_b = roots_now[0], roots_now[1]
        pa, pb = group_payload(g_a['id']), group_payload(g_b['id'])
        try:
            # a 的排序号改成比 b 大 → 导航中 a 应排到 b 之后
            post('/api/group/update', dict(pa, sortNo=int(pb['sortNo']) + 5))
            order = [x['id'] for x in nav_roots()]
            check('同级菜单组按排序号升序（改大排序号后自动后移）',
                  order.index(g_a['id']) > order.index(g_b['id']),
                  'order=%s, a=%s(sortNo=%s) b=%s(sortNo=%s)'
                  % (order, g_a['id'], pb['sortNo'] + 5, g_b['id'], pb['sortNo']))
        finally:
            post('/api/group/update', pa)          # 恢复原排序号
        order = [x['id'] for x in nav_roots()]
        check('恢复排序号后导航顺序复原',
              order.index(g_a['id']) < order.index(g_b['id']), str(order))

        # 组内菜单项：把前两个菜单项的显示序号互换，导航中的先后必须跟着互换
        host = nav_host_with_items()
        if host:
            gid = host['id']
            rows = get('/api/groupitem/list', {'groupId': gid, 'pageSize': 200})['data']['list']
            pairs = [{'itemId': int(r['itemId']), 'sortNo': int(r['sortNo'])} for r in rows]
            first, second = pairs[0], pairs[1]
            swapped = [dict(p) for p in pairs]
            swapped[0]['sortNo'], swapped[1]['sortNo'] = second['sortNo'], first['sortNo']
            try:
                post('/api/groupitem/update', {'groupId': gid, 'items': swapped})
                node = nav_find(gid)
                ids = [it['id'] for it in ((node or {}).get('items') or [])]
                check('组内菜单项按显示序号升序（互换序号后顺序反转）',
                      len(ids) >= 2 and ids[0] == second['itemId'] and ids[1] == first['itemId'],
                      'group=%s ids=%s, expect first=%s second=%s'
                      % (gid, ids, second['itemId'], first['itemId']))
            finally:
                post('/api/groupitem/update', {'groupId': gid, 'items': pairs})
            node = nav_find(gid)
            ids = [it['id'] for it in ((node or {}).get('items') or [])]
            check('恢复显示序号后组内顺序复原',
                  len(ids) >= 2 and ids[0] == first['itemId'] and ids[1] == second['itemId'], str(ids))
        else:
            print('      （没有绑定 ≥2 个菜单项的菜单组，跳过组内序号的实建校验）')
    else:
        print('      （顶级菜单组不足 2 个，跳过同级排序的实建校验）')

    # 管理页列表加载方式：菜单组列表按「层级」加载（父前子后）、菜单项列表按「显示序号」升序
    print('\n--- 0d. 管理页列表加载：菜单组按层级 / 菜单项按显示序号 ---')

    def group_list():
        return get('/api/group/list', {'pageNum': 1, 'pageSize': 200})['data']['list']

    def menu_list():
        return get('/api/menu/list', {'pageNum': 1, 'pageSize': 200})['data']['list']

    gl = group_list()
    check('菜单组列表按层级加载（父组必在其下级之前）',
          bool(gl) and is_dfs_order(gl),
          str([(x['level'], x['sortNo'], x['nameCn']) for x in gl[:6]]))
    check('列表首位为顶级菜单组（level=1）',
          bool(gl) and int(gl[0]['level']) == 1,
          str([(x['level'], x['sortNo'], x['nameCn']) for x in gl[:3]]))

    ml = menu_list()
    check('菜单项列表返回显示序号字段',
          all('sortNo' in x for x in ml), str(ml[0].keys()) if ml else 'empty')
    check('菜单项列表按显示序号升序',
          all(int(ml[i].get('sortNo') or 0) <= int(ml[i + 1].get('sortNo') or 0) for i in range(len(ml) - 1)),
          str([(x.get('sortNo'), x['nameCn']) for x in ml]))

    # 实建：菜单组排序号改大 → 位置后移；菜单项显示序号改大 → 排到最后（均复原）
    if len(gl) >= 2:
        g_first = gl[0]
        g_payload = dict((k, g_first.get(k)) for k in
                         ('id', 'parentId', 'code', 'nameCn', 'nameEn', 'hasChild', 'path', 'icon', 'enabled'))
        try:
            post('/api/group/update', dict(g_payload, sortNo=int(gl[-1]['sortNo']) + 5))
            after = group_list()
            # 层级加载下该组若有下级会连子树一起后移，此处断言节点自身位置比原先（首位）靠后即可
            check('改大排序号后该菜单组（连同其子树）在列表中后移',
                  bool(after) and [x['id'] for x in after].index(g_first['id']) > 0,
                  str([(x['sortNo'], x['nameCn']) for x in after]))
        finally:
            post('/api/group/update', dict(g_payload, sortNo=g_first['sortNo']))
        check('恢复排序号后菜单组列表首位复原',
              group_list()[0]['id'] == g_first['id'], str(group_list()[0]['id']))

    if len(ml) >= 2:
        m_first = ml[0]
        m_payload = dict((k, m_first.get(k)) for k in
                         ('id', 'icon', 'code', 'nameCn', 'nameEn', 'path', 'enabled', 'remark'))
        try:
            post('/api/menu/update', dict(m_payload, sortNo=int(ml[-1].get('sortNo') or 0) + 10))
            after = menu_list()
            check('改大显示序号后该菜单项排到最后',
                  after[-1]['id'] == m_first['id'],
                  str([(x.get('sortNo'), x['nameCn']) for x in after]))
        finally:
            post('/api/menu/update', dict(m_payload, sortNo=m_first.get('sortNo')))
        check('恢复显示序号后菜单项列表首位复原',
              menu_list()[0]['id'] == m_first['id'], str(menu_list()[0]['id']))

    r = post('/api/menu/add', {'code': 'E99012', 'nameCn': '坏序号项', 'nameEn': 'BadSortNoItem', 'sortNo': 'abc'})
    check('显示序号非整数被拒绝', r.get('code') != 0 and '显示序号' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False)[:160])
    r = post('/api/menu/add', {'code': 'E99013', 'nameCn': '越界序号项', 'nameEn': 'BigSortNoItem', 'sortNo': 10000})
    check('显示序号越界被拒绝', r.get('code') != 0 and '显示序号' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False)[:160])

    # 演示种子数据（GRP0100 / MENU0100…）是否还在库里：
    # 用户当前库为真实配置数据（3 个菜单组 / 5 个菜单项），依赖种子 id 的分节只能跳过，避免误判为代码缺陷
    def _exists(biz, rid):
        return get('/api/%s/detail' % biz, {'id': rid}).get('code') == 0

    SEED_OK = all(_exists('group', i) for i in (1, 2, 3, 4, 10, 12)) \
        and all(_exists('menu', i) for i in (1, 2, 3, 4, 5, 6))
    print('      种子数据：%s' % ('存在，执行全部分节' if SEED_OK else '缺失，跳过菜单项/菜单组/菜单组项目分节'))

    if SEED_OK:
        # ===================== 菜单项 =====================
        print('\n--- 1. 菜单项：分页 ---')
        r = get('/api/menu/list', {'keyword': '', 'enabled': '', 'pageNum': 1, 'pageSize': 10})
        d = r.get('data') or {}
        check('首页 10 条、总数与库一致', r.get('code') == 0 and len(d.get('list', [])) == 10 and d.get('total') == MENU_BASE,
              json.dumps({k: d.get(k) for k in ('total', 'pageNum', 'pageSize', 'pages')}, ensure_ascii=False))
        check('分页信息完整 pages=2', d.get('pages') == 2 and d.get('pageNum') == 1 and d.get('pageSize') == 10)

        r2 = get('/api/menu/list', {'pageNum': 2, 'pageSize': 10})
        d2 = r2.get('data') or {}
        tail = max(0, MENU_BASE - 10)
        check('第二页为剩余 %d 条' % tail, len(d2.get('list', [])) == tail and d2.get('pageNum') == 2, str(len(d2.get('list', []))))

        r3 = get('/api/menu/list', {'pageNum': 99, 'pageSize': 10})
        d3 = r3.get('data') or {}
        check('页码越界自动钳制到末页', d3.get('pageNum') == d3.get('pages'), json.dumps(d3.get('pageNum')))

        print('\n--- 2. 菜单项：关键字检索（编号/中文名/英文名） ---')
        r = get('/api/menu/list', {'keyword': 'MENU0100'})
        check('按编号检索命中 1 条', r['data']['total'] == 1 and r['data']['list'][0]['code'] == 'MENU0100')
        r = get('/api/menu/list', {'keyword': '用户管理'})
        check('按中文名检索命中', r['data']['total'] == 1 and r['data']['list'][0]['nameEn'] == 'UserManagement')
        r = get('/api/menu/list', {'keyword': 'alertmonitor'})
        check('按英文名检索忽略大小写', r['data']['total'] == 1 and r['data']['list'][0]['code'] == 'MENU1500')

        print('\n--- 3. 菜单项：启用状态筛选 ---')
        r = get('/api/menu/list', {'enabled': '1'})
        check('启用=1 全部为启用', all(x['enabled'] for x in r['data']['list']))
        r = get('/api/menu/list', {'enabled': '0', 'pageSize': 200})
        check('启用=0 全部为停用', not any(x['enabled'] for x in r['data']['list']))
        # 停用项会在「菜单组项目」用例里用到；库里可能已没有停用菜单项，届时再临时补一条
        DISABLED_ID = r['data']['list'][0]['id'] if r['data']['list'] else 0

        print('\n--- 4. 菜单项：字段与类型 ---')
        row = get('/api/menu/list', {'pageSize': 1})['data']['list'][0]
        check('布尔字段 enabled 为 JSON true/false', isinstance(row['enabled'], bool), str(row.get('enabled')))
        check('时间字段为字符串 YYYY-MM-DD HH:MM:SS',
              isinstance(row['createTime'], str) and len(row['createTime']) == 19, str(row.get('createTime')))
        check('含 remark 功能说明字段', 'remark' in row)

        print('\n--- 5. 菜单项：详情 / 唯一性校验 ---')
        r = get('/api/menu/detail', {'id': 1})
        check('详情返回对象', r.get('code') == 0 and r['data']['id'] == 1 and r['data']['code'] == 'MENU0100')
        r = get('/api/menu/detail', {'id': 999999})
        check('不存在的 id 返回 404 与提示', r.get('code') == 404 and '不存在' in r.get('message', ''), str(r))
        r = get('/api/menu/check', {'field': 'code', 'value': 'MENU0100', 'id': 0})
        check('编号已存在 → unique=false', r['data']['unique'] is False)
        r = get('/api/menu/check', {'field': 'code', 'value': 'MENU0100', 'id': 1})
        check('编辑时排除自身 → unique=true', r['data']['unique'] is True)
        r = get('/api/menu/check', {'field': 'nameEn', 'value': 'UserManagement'})
        check('英文名重复 → unique=false', r['data']['unique'] is False)
        r = get('/api/menu/check', {'field': 'code', 'value': 'NOT-EXIST-CODE'})
        check('不存在的编号 → unique=true', r['data']['unique'] is True)

        print('\n--- 6. 菜单项：新增 / 编辑 / 删除 ---')
        r = post('/api/menu/add', {'code': 'MENU9001', 'nameCn': '联调测试菜单', 'nameEn': 'ApiTestMenu',
                                   'path': 'apitest.html', 'icon': 'star', 'enabled': 1, 'remark': '接口联调写入'})
        check('新增成功并返回 id', r.get('code') == 0 and r['data']['id'] > 0, json.dumps(r, ensure_ascii=False))
        new_id = r['data']['id'] if r.get('code') == 0 else None
        check('新增后 enabled 回传为布尔', r['data']['enabled'] is True)
        check('新增后自动生成创建时间', isinstance(r['data']['createTime'], str) and len(r['data']['createTime']) == 19)

        r = post('/api/menu/add', {'code': 'MENU9001', 'nameCn': '重复编号', 'nameEn': 'DupCodeMenu', 'path': 'x.html'})
        check('重复编号被拒绝', r.get('code') != 0 and '编号已存在' in r.get('message', ''), json.dumps(r, ensure_ascii=False))
        r = post('/api/menu/add', {'code': 'MENU9002', 'nameCn': '重复英文名', 'nameEn': 'UserManagement', 'path': 'x.html'})
        check('重复英文名被拒绝', r.get('code') != 0 and '英文名已存在' in r.get('message', ''), json.dumps(r, ensure_ascii=False))
        r = post('/api/menu/add', {'nameCn': '缺少编号', 'nameEn': 'NoCodeMenu'})
        check('必填校验：缺少编号被拒绝', r.get('code') != 0 and '编号' in r.get('message', ''))

        r = post('/api/menu/update', {'id': new_id, 'code': 'MENU9001', 'nameCn': '联调测试菜单(改)',
                                      'nameEn': 'ApiTestMenuEdit', 'path': 'apitest2.html', 'icon': 'flag',
                                      'enabled': 0, 'remark': '接口联调修改'})
        check('编辑成功', r.get('code') == 0 and r['data']['nameCn'] == '联调测试菜单(改)', json.dumps(r, ensure_ascii=False))
        check('编辑后 enabled=false 且时间已刷新', r['data']['enabled'] is False and r['data']['updateTime'] >= r['data']['createTime'])
        check('编辑后数据库落库（详情复核）',
              get('/api/menu/detail', {'id': new_id})['data']['nameEn'] == 'ApiTestMenuEdit')

        r = post('/api/menu/delete', {'id': new_id})
        check('删除成功', r.get('code') == 0 and r['data']['id'] == new_id)
        check('删除后不可访问', get('/api/menu/detail', {'id': new_id}).get('code') == 404)
        check('删除后总数回到基线 %d' % MENU_BASE, get('/api/menu/list', {'pageSize': 10})['data']['total'] == MENU_BASE)

        print('\n--- 6b. 菜单项：编号自动生成（MNU + 5 位流水号） ---')
        r = get('/api/menu/nextcode', {})
        check('接口可访问且返回编号', r.get('code') == 0 and bool(r['data'].get('code')), json.dumps(r, ensure_ascii=False))
        gen_code = (r.get('data') or {}).get('code') or ''
        check('编号格式 MNU + 5 位流水号', bool(re.match(r'^MNU\d{5}$', gen_code)), gen_code)
        check('生成的编号在库中不存在',
              get('/api/menu/check', {'field': 'code', 'value': gen_code, 'id': 0})['data']['unique'] is True)
        r = post('/api/menu/add', {'code': gen_code, 'nameCn': '流水号测试菜单', 'nameEn': 'AutoCodeMenu',
                                   'path': 'autocode.html', 'icon': 'star', 'enabled': 1})
        check('用生成的编号可正常新增', r.get('code') == 0, json.dumps(r, ensure_ascii=False))
        auto_id = r['data']['id'] if r.get('code') == 0 else None
        if auto_id:
            r2 = get('/api/menu/nextcode', {})
            seq1 = int(gen_code[3:])
            seq2 = int(((r2.get('data') or {}).get('code') or 'MNU00000')[3:])
            check('占用后流水号自动顺延 +1', seq2 == seq1 + 1, '%s -> %s' % (gen_code, (r2.get('data') or {}).get('code')))
            post('/api/menu/delete', {'id': auto_id})
            check('清理测试数据后总数回到基线', get('/api/menu/list', {'pageSize': 10})['data']['total'] == MENU_BASE)
            r3 = get('/api/menu/nextcode', {})
            check('删除后编号回到 %s' % gen_code, ((r3.get('data') or {}).get('code') or '') == gen_code,
                  json.dumps(r3, ensure_ascii=False))
        r = get('/api/group/nextcode', {})
        check('菜单组支持编号自动生成（MNG + 4 位流水号）',
              r.get('code') == 0 and bool(re.match(r'^MNG\d{4}$', (r.get('data') or {}).get('code', ''))),
              json.dumps(r, ensure_ascii=False))

        # ===================== 菜单组 =====================
        print('\n--- 7. 菜单组：分页与检索 ---')
        r = get('/api/group/list', {'pageNum': 1, 'pageSize': 10})
        d = r.get('data') or {}
        check('首页 10 条、总数与库一致', len(d.get('list', [])) == 10 and d.get('total') == GROUP_BASE)
        row = d['list'][0]
        check('含 hasChild 布尔字段', isinstance(row.get('hasChild'), bool), str(row.get('hasChild')))
        r = get('/api/group/list', {'keyword': 'GRP0100'})
        check('按编号检索', r['data']['total'] == 1 and r['data']['list'][0]['nameEn'] == 'SystemManagement')
        r = get('/api/group/list', {'keyword': '帮助中心'})
        check('按中文名检索', r['data']['total'] == 1 and r['data']['list'][0]['hasChild'] is False)
        r = get('/api/group/list', {'keyword': 'helpcenter'})
        check('按英文名检索忽略大小写', r['data']['total'] == 1)
        r = get('/api/group/list', {'enabled': '0'})
        check('启用状态筛选', (not any(x['enabled'] for x in r['data']['list'])) and r['data']['total'] > 0)

        print('\n--- 8. 菜单组：可否绑定菜单项 规则 ---')
        r = post('/api/group/add', {'code': 'GRP9001', 'nameCn': '联调测试组', 'nameEn': 'ApiTestGroup',
                                    'hasChild': 1, 'path': 'should-be-cleared.html', 'icon': 'star', 'enabled': 1})
        check('可否绑定菜单项=是：新增成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False))
        gid = r['data']['id'] if r.get('code') == 0 else None
        check('选「是」时 path 被清空', r['data']['path'] == '', json.dumps(r['data'].get('path')))
        check('选「是」时 hasChild 回传 true', r['data']['hasChild'] is True)

        r = post('/api/group/update', {'id': gid, 'code': 'GRP9001', 'nameCn': '联调测试组(改)',
                                       'nameEn': 'ApiTestGroupEdit', 'hasChild': 0, 'path': 'api-group.html',
                                       'icon': 'flag', 'enabled': 0})
        check('改为无子项并填写路径成功', r.get('code') == 0 and r['data']['path'] == 'api-group.html',
              json.dumps(r, ensure_ascii=False))
        check('无子项时 hasChild=false', r['data']['hasChild'] is False)

        r = post('/api/group/update', {'id': gid, 'code': 'GRP9001', 'nameCn': '联调测试组(改)',
                                       'nameEn': 'ApiTestGroupEdit', 'hasChild': 0, 'path': ''})
        check('无子项且路径为空也允许（路径非必填）', r.get('code') == 0 and r['data']['path'] == '',
              json.dumps(r, ensure_ascii=False))

        r = post('/api/group/add', {'code': 'GRP9001', 'nameCn': '重复组', 'nameEn': 'DupGroupX', 'hasChild': 1})
        check('菜单组重复编号被拒绝', r.get('code') != 0 and '编号已存在' in r.get('message', ''))
        r = get('/api/group/check', {'field': 'nameEn', 'value': 'SystemManagement'})
        check('菜单组英文名重复 → unique=false', r['data']['unique'] is False)

        r = post('/api/group/delete', {'id': gid})
        check('菜单组删除成功', r.get('code') == 0 and r['data']['id'] == gid)
        check('菜单组删除后不可访问', get('/api/group/detail', {'id': gid}).get('code') == 404)
        check('菜单组总数回到基线 %d' % GROUP_BASE, get('/api/group/list', {'pageSize': 10})['data']['total'] == GROUP_BASE)

        # ===================== 菜单组：多层级 =====================
        print('\n--- 8b. 菜单组：多层级 ---')
        r = get('/api/group/tree', {})
        tlist = (r.get('data') or {}).get('list', [])
        check('层级下拉返回全部 %d 条' % GROUP_BASE, r.get('code') == 0 and len(tlist) == GROUP_BASE, str(len(tlist)))
        check('层级下拉按树形顺序（父节点必在其子孙之前）',
              tlist and tlist[0]['level'] == 1 and is_dfs_order(tlist), str([x['level'] for x in tlist[:4]]))
        check('层级下拉 label 带缩进', tlist[1]['label'].startswith('　└'), tlist[1].get('label'))
        r = get('/api/group/tree', {'excludeId': 1})
        ids_ex = [x['id'] for x in r['data']['list']]
        check('excludeId 排除自身及所有后代', 1 not in ids_ex and 2 not in ids_ex and 3 not in ids_ex and 4 not in ids_ex)
        check('excludeId 保留无关节点', 5 in ids_ex and 10 in ids_ex)

        r = get('/api/group/list', {'pageNum': 1, 'pageSize': 20})
        rows = r['data']['list']
        check('列表默认按树形顺序输出（父节点必在其子孙之前）',
              rows and rows[0]['level'] == 1 and is_dfs_order(rows), str([x['level'] for x in rows[:4]]))
        check('列表含 level / parentName / childCount',
              'level' in rows[0] and 'parentName' in rows[0] and 'childCount' in rows[0])
        check('顶级菜单组 parentName 为空', rows[0]['parentName'] == '', str(rows[0].get('parentName')))
        check('顶级菜单组 childCount 正确', rows[0]['childCount'] == 2, str(rows[0].get('childCount')))
        check('二级菜单组 parentName 为上级名', rows[1]['parentName'] == '系统管理', str(rows[1].get('parentName')))

        # 指定上级新增 → 层级自动推导
        r = post('/api/group/add', {'code': 'GRP9101', 'nameCn': '四级测试组', 'nameEn': 'Lv4TestGroup',
                                    'parentId': 3, 'sortNo': 9, 'hasChild': 0, 'path': 'lv4.html',
                                    'icon': 'star', 'enabled': 1})
        check('指定上级新增成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False))
        lv4 = r['data']['id'] if r.get('code') == 0 else 0
        check('层级自动推导为 4 级', r['data'].get('level') == 4, str(r['data'].get('level')))
        check('新增后父级自动置为「可绑定菜单项（是）」',
              get('/api/group/detail', {'id': 3})['data']['hasChild'] is True)

        r = post('/api/group/add', {'code': 'GRP9102', 'nameCn': '五级测试组', 'nameEn': 'Lv5TestGroup',
                                    'parentId': lv4, 'hasChild': 0, 'path': 'lv5.html', 'icon': 'star', 'enabled': 1})
        check('五级新增成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False))
        lv5 = r['data']['id'] if r.get('code') == 0 else 0
        check('层级自动推导为 5 级', r['data'].get('level') == 5, str(r['data'].get('level')))

        r = post('/api/group/add', {'code': 'GRP9103', 'nameCn': '六级测试组', 'nameEn': 'Lv6TestGroup',
                                    'parentId': lv5, 'hasChild': 0, 'path': 'lv6.html', 'icon': 'star', 'enabled': 1})
        check('超过最大层级（5 级）被拒绝', r.get('code') != 0 and '级' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False))

        # 上级合法性
        r = post('/api/group/add', {'code': 'GRP9104', 'nameCn': '无效上级组', 'nameEn': 'BadParentGroup',
                                    'parentId': 999999, 'hasChild': 0, 'path': 'x.html', 'icon': 'star', 'enabled': 1})
        check('上级不存在被拒绝', r.get('code') != 0 and '上级' in r.get('message', ''), json.dumps(r, ensure_ascii=False))
        r = post('/api/group/update', {'id': lv4, 'code': 'GRP9101', 'nameCn': '四级测试组(自)',
                                       'nameEn': 'Lv4TestGroup', 'parentId': lv4, 'hasChild': 0, 'path': 'lv4.html'})
        check('上级设为自身被拒绝', r.get('code') != 0 and '自身' in r.get('message', ''), json.dumps(r, ensure_ascii=False))
        r = post('/api/group/update', {'id': 3, 'code': 'GRP0300', 'nameCn': '角色权限', 'nameEn': 'RolePermission',
                                       'parentId': lv4, 'hasChild': 0, 'path': 'role.html'})
        check('上级设为自己的下级被拒绝（防环）', r.get('code') != 0 and '下级' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False))

        # 移动整棵子树：子孙层级自动刷新
        r = post('/api/group/update', {'id': 1, 'code': 'GRP0100', 'nameCn': '系统管理', 'nameEn': 'SystemManagement',
                                       'parentId': 12, 'sortNo': 9, 'hasChild': 1, 'icon': 'setting', 'enabled': 1})
        check('移动整棵子树成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False))
        check('移动后自身层级重算', get('/api/group/detail', {'id': 1})['data']['level'] == 2,
              str(get('/api/group/detail', {'id': 1})['data'].get('level')))
        check('移动后子孙层级级联刷新（2级→3级）', get('/api/group/detail', {'id': 2})['data']['level'] == 3)
        check('移动后孙辈层级级联刷新（3级→4级）', get('/api/group/detail', {'id': 3})['data']['level'] == 4)
        post('/api/group/update', {'id': 1, 'code': 'GRP0100', 'nameCn': '系统管理', 'nameEn': 'SystemManagement',
                                   'parentId': 0, 'sortNo': 1, 'hasChild': 1, 'icon': 'setting', 'enabled': 1})
        check('还原为顶级后子孙层级回到 3 级', get('/api/group/detail', {'id': 3})['data']['level'] == 3)

        # parentId 过滤：只看该菜单组的下级
        r = get('/api/group/list', {'parentId': 1, 'pageSize': 50})
        ids_sub = [x['id'] for x in r['data']['list']]
        check('parentId 过滤只返回该子树', 2 in ids_sub and 3 in ids_sub and 4 in ids_sub and 1 not in ids_sub,
              str(ids_sub))

        # 删除：存在下级时拒绝；cascade=1 级联删除
        r = post('/api/group/delete', {'id': lv4})
        check('存在下级时删除被拒绝', r.get('code') != 0 and '下级' in r.get('message', ''), json.dumps(r, ensure_ascii=False))
        r = post('/api/group/delete', {'id': lv4, 'cascade': 1})
        check('级联删除成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False))
        check('级联删除后子孙不可访问', get('/api/group/detail', {'id': lv5}).get('code') == 404)
        # 复原测试期间被自动改写的「可否绑定菜单项」标记
        post('/api/group/update', {'id': 3, 'code': 'GRP0300', 'nameCn': '角色权限', 'nameEn': 'RolePermission',
                                   'parentId': 2, 'sortNo': 1, 'hasChild': 0, 'path': 'role.html',
                                   'icon': 'lock', 'enabled': 1})
        check('级联删除后总数回到基线', get('/api/group/list', {'pageSize': 10})['data']['total'] == GROUP_BASE)
        lv_after = [x['level'] for x in get('/api/group/list', {'pageSize': 50})['data']['list']]
        check('删除后层级数据完好（1/2/3 级齐全且无越级）',
              lv_after and lv_after[0] == 1 and 2 in lv_after and 3 in lv_after and max(lv_after) <= 3,
              str(lv_after[:6]))

        # ===================== 菜单组项目（菜单组 ↔ 菜单项） =====================
        print('\n--- 8c. 菜单组项目：查询 ---')
        r = get('/api/groupitem/list', {'pageSize': 50})
        check('未指定菜单组时拒绝查询', r.get('code') != 0 and '选择菜单组' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False))

        r = get('/api/groupitem/list', {'groupId': 1, 'pageSize': 50})
        gi = r.get('data') or {}
        check('菜单组 1 的菜单项共 %d 条' % GI1_BASE, r.get('code') == 0 and gi.get('total') == GI1_BASE, json.dumps(gi.get('total')))
        check('按显示序号升序输出',
              [x['sortNo'] for x in gi.get('list', [])] == [1, 2, 3],
              str([x['sortNo'] for x in gi.get('list', [])]))
        check('关联带出菜单组信息', gi['list'][0]['groupCode'] == 'GRP0100' and gi['list'][0]['groupNameCn'] == '系统管理')
        check('关联带出菜单项信息',
              gi['list'][0]['itemCode'] == 'MENU0100' and gi['list'][0]['itemNameCn'] == '菜单项管理'
              and gi['list'][0]['itemPath'] == 'menu.html')
        check('仅返回启用状态的菜单项', all(x['itemEnabled'] for x in gi['list']))

        r = get('/api/groupitem/list', {'groupId': 1, 'keyword': '操作日志', 'pageSize': 50})
        check('关键字只在当前菜单组内生效', r['data']['total'] == 1 and r['data']['list'][0]['itemCode'] == 'MENU0600')
        r = get('/api/groupitem/list', {'groupId': 1, 'keyword': '订单中心', 'pageSize': 50})
        check('其它菜单组的菜单项不出现在结果中', r['data']['total'] == 0, str(r['data']['total']))

        r = get('/api/groupitem/detail', {'id': 3})
        check('菜单组项目详情字段完整',
              r.get('code') == 0 and r['data']['groupId'] == 1 and r['data']['itemId'] == 6
              and r['data']['sortNo'] == 3 and isinstance(r['data']['enabled'], bool),
              json.dumps(r.get('data'), ensure_ascii=False)[:160])
        check('不存在的记录返回 404', get('/api/groupitem/detail', {'id': 999999}).get('code') == 404)

        print('\n--- 8c. 菜单组项目：批量新增 ---')
        r = post('/api/groupitem/add', {'groupId': 10, 'items': [{'itemId': 1, 'sortNo': 1}, {'itemId': 6, 'sortNo': 2}]})
        gi = r.get('data') or {}
        check('批量新增 2 条', r.get('code') == 0 and gi.get('added') == 2 and len(gi.get('list', [])) == 2,
              json.dumps({k: gi.get(k) for k in ('added', 'updated', 'removed')}))

        r = post('/api/groupitem/add', {'groupId': 10, 'items': [{'itemId': 1, 'sortNo': 9}]})
        gi = r.get('data') or {}
        check('重复新增：只更新显示序号，不重复插入',
              r.get('code') == 0 and gi.get('added') == 0 and gi.get('updated') == 1
              and len(gi.get('list', [])) == 2,
              json.dumps({k: gi.get(k) for k in ('added', 'updated')}))
        check('重复新增后序号已更新',
              [x['sortNo'] for x in gi['list']] == [2, 9], str([x['sortNo'] for x in gi['list']]))

        TMP_DISABLED_ID = 0
        if not DISABLED_ID:      # 库里没有停用项时临时造一条，用完立刻删除，不影响其它用例的条数基线
            rr = post('/api/menu/add', {'code': 'MNU90099', 'nameCn': '停用测试项', 'nameEn': 'DisabledItemTmp',
                                        'path': 'disabled.html', 'icon': 'close', 'enabled': 0})
            DISABLED_ID = (rr.get('data') or {}).get('id') or 0
            TMP_DISABLED_ID = DISABLED_ID
            check('库中没有停用项，已临时补一条用于本用例', rr.get('code') == 0 and DISABLED_ID,
                  json.dumps(rr, ensure_ascii=False))
        r = post('/api/groupitem/add', {'groupId': 10, 'items': [{'itemId': DISABLED_ID, 'sortNo': 3}]})
        check('停用的菜单项不能加入菜单组', r.get('code') != 0 and '已停用' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False))
        if TMP_DISABLED_ID:
            post('/api/menu/delete', {'id': TMP_DISABLED_ID})      # 清理临时补的停用项
        r = post('/api/groupitem/add', {'groupId': 10, 'items': [{'itemId': 999999, 'sortNo': 3}]})
        check('不存在的菜单项被拒绝', r.get('code') != 0 and '不存在' in r.get('message', ''))
        r = post('/api/groupitem/add', {'groupId': 10, 'items': []})
        check('未选择菜单项时被拒绝', r.get('code') != 0 and '至少选择一个' in r.get('message', ''))
        r = post('/api/groupitem/add', {'groupId': 999999, 'items': [{'itemId': 1, 'sortNo': 1}]})
        check('不存在的菜单组被拒绝', r.get('code') != 0 and '菜单组不存在' in r.get('message', ''))
        r = post('/api/groupitem/add', {'groupId': 10, 'items': [{'itemId': 7, 'sortNo': 10000}]})
        check('显示序号超出 0-9999 被拒绝', r.get('code') != 0 and '显示序号' in r.get('message', ''))

        print('\n--- 8c. 菜单组项目：全量同步与删除 ---')
        r = post('/api/groupitem/update', {'groupId': 10, 'items': [{'itemId': 1, 'sortNo': 7}]})
        gi = r.get('data') or {}
        check('全量同步：移除未勾选的、更新序号',
              r.get('code') == 0 and gi.get('removed') == 1 and len(gi.get('list', [])) == 1
              and gi['list'][0]['sortNo'] == 7,
              json.dumps({k: gi.get(k) for k in ('added', 'updated', 'removed')}))

        gi_del_id = gi['list'][0]['id']
        r = post('/api/groupitem/delete', {'id': gi_del_id})
        check('删除单条成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:120])
        check('删除后菜单组 10 已清空',
              get('/api/groupitem/list', {'groupId': 10, 'pageSize': 50})['data']['total'] == 0)
        check('其它菜单组的配置不受影响',
              get('/api/groupitem/list', {'groupId': 1, 'pageSize': 50})['data']['total'] == GI1_BASE)
        check('菜单组项目总数回到基线 %d' % GI_BASE,
              get('/api/health')['data']['groupItemCount'] == GI_BASE)

        print('\n--- 8c. 菜单组树：启用过滤与关键字 ---')
        r = get('/api/group/tree', {'enabled': 1})
        check('树只加载启用的菜单组（%d 条）' % TREE_ENABLED_BASE, len(r['data']['list']) == TREE_ENABLED_BASE, str(len(r['data']['list'])))
        check('树中不含已停用的菜单组',
              not any(x['code'] in ('GRP1300', 'GRP1500') for x in r['data']['list']))
        r = get('/api/group/tree', {'keyword': '角色权限'})
        gi_ids = [x['id'] for x in r['data']['list']]
        check('树按关键字过滤并保留祖先链', gi_ids == [1, 2, 3], str(gi_ids))
        r = get('/api/group/tree', {'keyword': 'GRP0100'})
        check('树按编号精确命中', [x['id'] for x in r['data']['list']] == [1],
              str([x['id'] for x in r['data']['list']]))

        r = get('/api/group/tree', {'enabled': 1})
        rows = dict((x['code'], x) for x in r['data']['list'])
        check('树返回 leaf（是否叶子节点）字段', 'leaf' in rows['GRP0100'])
        check('有下级的节点 leaf=false（系统管理）', rows['GRP0100']['leaf'] is False)
        check('无下级的节点 leaf=true（菜单配置）', rows['GRP0400']['leaf'] is True)
        check('可绑菜单标记 = hasChild 且为叶子节点',
              [x['code'] for x in r['data']['list'] if x['hasChild'] and x['leaf']]
              == ['GRP0400', 'GRP0800', 'GRP1400'],
              str([x['code'] for x in r['data']['list'] if x['hasChild'] and x['leaf']]))
        r = get('/api/group/tree', {'enabled': 1, 'keyword': 'GRP0100'})
        check('关键字过滤时 leaf 仍按全量下级判定（系统管理仍为分支）',
              r['data']['list'][0]['leaf'] is False, json.dumps(r['data']['list'][0], ensure_ascii=False))

    else:
        print('\n--- 跳过依赖种子数据的菜单项/菜单组/菜单组项目分节（当前库缺少 GRP/MENU 演示种子数据） ---')

    # ===================== 部门组织架构 =====================
    print('\n--- 8d. 部门组织架构：编号自动生成 ---')
    r = get('/api/org/nextcode')
    org_code = (r.get('data') or {}).get('code', '')
    check('编号接口返回 DPT + 4 位流水号', r.get('code') == 0 and re.match(r'^DPT\d{4}$', org_code) is not None,
          json.dumps(r, ensure_ascii=False))
    ORG_BASE = int(get('/api/health')['data'].get('orgCount') or 0)
    codes_before = set(x['code'] for x in get('/api/org/list', {'pageSize': 200})['data']['list'])
    check('生成的编号在库中不重复', org_code not in codes_before, org_code)
    r = get('/api/group/nextcode')
    check('菜单组编号接口返回 MNG + 4 位流水号',
          r.get('code') == 0 and re.match(r'^MNG\d{4}$', (r.get('data') or {}).get('code', '')) is not None,
          json.dumps(r, ensure_ascii=False))

    print('\n--- 8d. 部门组织架构：查询与树形顺序 ---')
    r = get('/api/org/list', {'pageSize': 200})
    org_rows = r['data']['list']
    check('部门共 %d 条' % ORG_BASE, r.get('code') == 0 and r['data']['total'] == ORG_BASE, str(r['data']['total']))
    check('默认按树形（父 → 子）深度优先输出', is_dfs_order(org_rows),
          str([(x['code'], x.get('parentName')) for x in org_rows])[:200])
    check('字段完整（编号/名称/职能/启用/上级/层级）',
          all(x['code'] and x['nameCn'] and 'duty' in x and isinstance(x['enabled'], bool)
              and 'parentName' in x and 'level' in x and 'childCount' in x for x in org_rows),
          json.dumps(org_rows[0], ensure_ascii=False)[:200])
    check('顶级部门上级名称为空', all(x['parentName'] == '' for x in org_rows if x['level'] == 1),
          str([(x['code'], x['parentName']) for x in org_rows if x['level'] == 1]))
    check('下级部门带出上级名称', all(x['parentName'] != '' for x in org_rows if x['level'] > 1),
          str([(x['code'], x['parentName']) for x in org_rows if x['level'] > 1]))
    check('pathNames 为层级全路径',
          all(not x['pathNames'] if x['level'] == 1 else x['pathNames'].endswith(x['parentName'])
              for x in org_rows),
          str([x['pathNames'] for x in org_rows][:4]))

    r = get('/api/org/list', {'keyword': '研发', 'pageSize': 200})
    check('关键字按名称/职能/编号检索', r['data']['total'] >= 1, str(r['data']['total']))
    r = get('/api/org/list', {'enabled': '1', 'pageSize': 200})
    check('启用状态筛选只返回启用的部门', all(x['enabled'] for x in r['data']['list']))
    r = get('/api/org/tree')
    tree = r['data']['list']
    check('层级下拉首项固定为「（顶级部门）」', tree[0]['id'] == 0 and '顶级部门' in tree[0]['nameCn'],
          json.dumps(tree[0], ensure_ascii=False))
    check('层级下拉按树形顺序输出', is_dfs_order([x for x in tree if x['id']]), str([x['id'] for x in tree]))

    print('\n--- 8d. 部门组织架构：新增与校验 ---')
    r = post('/api/org/add', {'code': org_code, 'nameCn': '自动化测试部', 'duty': '联调用例临时部门',
                              'parentId': 0, 'sortNo': 99, 'enabled': 1})
    org1 = (r.get('data') or {}).get('id') or 0
    check('新增顶级部门成功', r.get('code') == 0 and org1, json.dumps(r, ensure_ascii=False)[:160])
    check('新增后层级自动为 1 级', get('/api/org/detail', {'id': org1})['data']['level'] == 1)
    check('新增后编号沿用预取值', get('/api/org/detail', {'id': org1})['data']['code'] == org_code)

    r = post('/api/org/add', {'code': org_code, 'nameCn': '重名编号部门', 'parentId': 0, 'enabled': 1})
    check('编号重复被拒绝', r.get('code') != 0 and '编号' in r.get('message', ''), json.dumps(r, ensure_ascii=False))
    r = get('/api/org/check', {'field': 'code', 'value': org_code})
    check('查重接口判定编号已占用（unique=false）', (r.get('data') or {}).get('unique') is False,
          json.dumps(r, ensure_ascii=False))
    r = get('/api/org/check', {'field': 'code', 'value': 'DPT0000'})
    check('查重接口判定未使用的编号可用', (r.get('data') or {}).get('unique') is True,
          json.dumps(r, ensure_ascii=False))
    r = post('/api/org/add', {'code': 'DPT9999', 'nameCn': '', 'parentId': 0})
    check('部门名称必填', r.get('code') != 0 and '部门名称' in r.get('message', ''), json.dumps(r, ensure_ascii=False))
    r = post('/api/org/add', {'code': 'DPT9998', 'nameCn': '上级不存在', 'parentId': 999999})
    check('上级不存在被拒绝', r.get('code') != 0 and '上级' in r.get('message', ''), json.dumps(r, ensure_ascii=False))

    # 造到 5 级，验证第 6 级被拒绝
    code2 = get('/api/org/nextcode')['data']['code']
    r = post('/api/org/add', {'code': code2, 'nameCn': '自动化二级', 'parentId': org1, 'enabled': 1})
    org2 = (r.get('data') or {}).get('id') or 0
    org3 = (post('/api/org/add', {'code': get('/api/org/nextcode')['data']['code'],
                                  'nameCn': '自动化三级', 'parentId': org2, 'enabled': 1}).get('data') or {}).get('id') or 0
    org4 = (post('/api/org/add', {'code': get('/api/org/nextcode')['data']['code'],
                                  'nameCn': '自动化四级', 'parentId': org3, 'enabled': 1}).get('data') or {}).get('id') or 0
    org5 = (post('/api/org/add', {'code': get('/api/org/nextcode')['data']['code'],
                                  'nameCn': '自动化五级', 'parentId': org4, 'enabled': 1}).get('data') or {}).get('id') or 0
    check('逐级新增到 5 级成功', all([org1, org2, org3, org4, org5]), str([org1, org2, org3, org4, org5]))
    check('层级随上级自动推导（2/3/4/5 级）',
          [get('/api/org/detail', {'id': i})['data']['level'] for i in (org2, org3, org4, org5)] == [2, 3, 4, 5],
          str([get('/api/org/detail', {'id': i})['data']['level'] for i in (org2, org3, org4, org5)]))
    r = post('/api/org/add', {'code': get('/api/org/nextcode')['data']['code'],
                              'nameCn': '自动化六级', 'parentId': org5, 'enabled': 1})
    check('超过最大层级（5 级）被拒绝', r.get('code') != 0 and '级' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))

    print('\n--- 8d. 部门组织架构：编辑与防环 ---')
    r = get('/api/org/tree', {'excludeId': org2})
    ids_tree = [x['id'] for x in r['data']['list'] if x['id']]
    check('编辑时层级下拉排除自身与后代',
          org2 not in ids_tree and org3 not in ids_tree and org5 not in ids_tree and org1 in ids_tree,
          str(ids_tree))
    r = post('/api/org/update', {'id': org1, 'code': org_code, 'nameCn': '自动化测试部',
                                 'duty': '职能已修改', 'parentId': org1, 'sortNo': 99, 'enabled': 1})
    check('上级设为自身被拒绝', r.get('code') != 0 and '自身' in r.get('message', ''), json.dumps(r, ensure_ascii=False))
    r = post('/api/org/update', {'id': org1, 'code': org_code, 'nameCn': '自动化测试部',
                                 'parentId': org3, 'sortNo': 99, 'enabled': 1})
    check('上级设为自己的下级被拒绝（防环）', r.get('code') != 0 and '下级' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = post('/api/org/update', {'id': org2, 'code': code2, 'nameCn': '自动化二级',
                                 'parentId': 0, 'sortNo': 1, 'enabled': 1})
    check('子树提升为顶级成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False))
    check('移动后自身层级重算为 1 级', get('/api/org/detail', {'id': org2})['data']['level'] == 1)
    check('移动后子孙层级级联刷新（3→2 级）', get('/api/org/detail', {'id': org3})['data']['level'] == 2)
    check('移动后孙辈层级级联刷新（5→4 级）', get('/api/org/detail', {'id': org5})['data']['level'] == 4)
    r = post('/api/org/update', {'id': org2, 'code': code2, 'nameCn': '自动化二级',
                                 'duty': '职能说明已更新', 'parentId': org1, 'sortNo': 2, 'enabled': 1})
    check('编辑职能说明成功', r.get('code') == 0
          and get('/api/org/detail', {'id': org2})['data']['duty'] == '职能说明已更新',
          json.dumps(get('/api/org/detail', {'id': org2}).get('data'), ensure_ascii=False)[:160])
    check('编辑后仍为启用状态', get('/api/org/detail', {'id': org2})['data']['enabled'] is True)

    print('\n--- 8e. 部门组织架构：停用 / 删除保护（有启用下级时禁止） ---')
    r = post('/api/org/update', {'id': org2, 'code': code2, 'nameCn': '自动化二级',
                                 'duty': '职能说明已更新', 'parentId': org1, 'sortNo': 2, 'enabled': 0})
    check('有启用状态下级时停用本部门被拒绝',
          r.get('code') != 0 and '启用状态的下级部门' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False)[:200])
    check('被拒绝后启用状态保持不变', get('/api/org/detail', {'id': org2})['data']['enabled'] is True)
    r = post('/api/org/update', {'id': org1, 'code': org_code, 'nameCn': '自动化测试部',
                                 'parentId': 0, 'sortNo': 99, 'enabled': 0})
    check('隔代（孙辈）启用同样阻止停用',
          r.get('code') != 0 and '启用状态的下级部门' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False)[:200])
    r = post('/api/org/delete', {'id': org2, 'cascade': 1})
    check('有启用状态下级时删除（级联）被拒绝',
          r.get('code') != 0 and '启用状态的下级部门' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False)[:200])
    check('被拒绝后部门仍存在', get('/api/org/detail', {'id': org2}).get('code') == 0)
    # 叶子部门无下级 → 允许停用；此时其上级仍被拦截
    r = post('/api/org/update', {'id': org5, 'code': get('/api/org/detail', {'id': org5})['data']['code'],
                                 'nameCn': '自动化五级', 'parentId': org4, 'sortNo': 5, 'enabled': 0})
    check('叶子部门（无下级）允许停用', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:160])
    r = post('/api/org/update', {'id': org4, 'code': get('/api/org/detail', {'id': org4})['data']['code'],
                                 'nameCn': '自动化四级', 'parentId': org3, 'sortNo': 4, 'enabled': 0})
    check('下级已停用后本部门可停用', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:160])
    r = post('/api/org/update', {'id': org3, 'code': get('/api/org/detail', {'id': org3})['data']['code'],
                                 'nameCn': '自动化三级', 'parentId': org2, 'sortNo': 3, 'enabled': 0})
    check('启用链逐级停用后仍可继续停用上级', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:160])
    check('停用不影响层级（3/4/5 级）',
          [get('/api/org/detail', {'id': i})['data']['level'] for i in (org3, org4, org5)] == [3, 4, 5],
          str([get('/api/org/detail', {'id': i})['data']['level'] for i in (org3, org4, org5)]))
    # 子级全部停用后，本部门即可停用（保护只看「启用状态」的下级）
    r = post('/api/org/update', {'id': org2, 'code': code2, 'nameCn': '自动化二级',
                                 'duty': '职能说明已更新', 'parentId': org1, 'sortNo': 2, 'enabled': 0})
    check('子级全部停用后本部门可正常停用', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:200])
    check('停用成功且状态已落库', get('/api/org/detail', {'id': org2})['data']['enabled'] is False)

    print('\n--- 8d. 部门组织架构：删除 ---')
    r = post('/api/org/delete', {'id': org2})
    check('存在下级部门时删除被拒绝', r.get('code') != 0 and '下级' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = post('/api/org/delete', {'id': org2, 'cascade': 1})
    check('级联删除成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False))
    check('级联删除后子孙不可访问', get('/api/org/detail', {'id': org4}).get('code') == 404)
    post('/api/org/delete', {'id': org1})
    check('清理后部门总数回到基线 %d' % ORG_BASE,
          get('/api/org/list', {'pageSize': 200})['data']['total'] == ORG_BASE,
          str(get('/api/org/list', {'pageSize': 200})['data']['total']))
    check('清理后健康检查计数一致', int(get('/api/health')['data'].get('orgCount') or 0) == ORG_BASE)

    # ===================== 员工信息 =====================
    print('\n--- 8f. 员工信息：工号自动生成与查询 ---')
    EMP_BASE = int(get('/api/health')['data'].get('empCount') or 0)
    r = get('/api/emp/nextcode')
    emp_code = (r.get('data') or {}).get('code', '')
    check('工号接口返回 E + 5 位流水号',
          r.get('code') == 0 and re.match(r'^E\d{5}$', emp_code) is not None, json.dumps(r, ensure_ascii=False))
    r = get('/api/emp/list', {'pageSize': 200})
    emp_rows = r['data']['list']
    check('员工共 %d 条' % EMP_BASE, r.get('code') == 0 and r['data']['total'] == EMP_BASE, str(r['data']['total']))
    check('员工字段完整（工号/姓名/手机号/邮箱/在职状态/部门名）',
          all(x['code'] and x['nameCn'] and 'phone' in x and x['email'] and 'status' in x
              and 'statusText' in x and 'deptName' in x for x in emp_rows),
          json.dumps(emp_rows[0], ensure_ascii=False)[:200] if emp_rows else 'empty')
    check('列表按工号升序输出',
          [x['code'] for x in emp_rows] == sorted([x['code'] for x in emp_rows]),
          str([x['code'] for x in emp_rows])[:160])
    check('邮箱均符合邮箱格式',
          all(re.match(r'^[^@\s]+@[^@\s]+\.[A-Za-z0-9]+$', x['email']) for x in emp_rows),
          str([x['email'] for x in emp_rows])[:160])
    if emp_rows:
        one = emp_rows[0]
        r = get('/api/emp/list', {'keyword': one['nameCn'], 'pageSize': 200})
        check('关键字可按姓名检索', r['data']['total'] >= 1, str(r['data']['total']))
        r = get('/api/emp/list', {'keyword': one['email'], 'pageSize': 200})
        check('关键字可按邮箱检索', r['data']['total'] >= 1, str(r['data']['total']))
    r = get('/api/emp/list', {'status': '1', 'pageSize': 200})
    check('在职状态筛选只返回在职员工',
          all(int(x['status']) == 1 for x in r['data']['list']), str(len(r['data']['list'])))
    r = get('/api/emp/list', {'status': '0', 'pageSize': 200})
    check('在职状态筛选可查离职员工（可能为 0 条）',
          r.get('code') == 0 and all(int(x['status']) == 0 for x in r['data']['list']), str(r['data']['total']))

    print('\n--- 8f. 员工信息：新增与校验 ---')
    r = post('/api/emp/add', {'code': emp_code, 'nameCn': '自动化测试员工', 'gender': 1,
                              'phone': '13900139001', 'email': 'auto.emp@jiudou.com',
                              'deptId': 0, 'jobTitle': '测试岗', 'status': 1,
                              'hireDate': '2026-01-05', 'remark': '联调用例临时员工'})
    emp1 = (r.get('data') or {}).get('id') or 0
    check('新增员工成功', r.get('code') == 0 and emp1, json.dumps(r, ensure_ascii=False)[:200])
    check('新增后工号沿用预取值', get('/api/emp/detail', {'id': emp1})['data']['code'] == emp_code)
    check('新增后返回在职状态文案', get('/api/emp/detail', {'id': emp1})['data']['statusText'] == '在职')
    r = post('/api/emp/add', {'code': emp_code, 'nameCn': '重复工号', 'email': 'dup@jiudou.com'})
    check('工号重复被拒绝', r.get('code') != 0 and '工号' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = get('/api/emp/check', {'field': 'code', 'value': emp_code.lower()})
    check('查重接口大小写不敏感（unique=false）', (r.get('data') or {}).get('unique') is False,
          json.dumps(r, ensure_ascii=False))
    r = get('/api/emp/check', {'field': 'code', 'value': 'E99999'})
    check('未占用工号可用（unique=true）', (r.get('data') or {}).get('unique') is True)
    r = post('/api/emp/add', {'code': 'E99001', 'nameCn': '无邮箱员工'})
    check('邮箱必填被拒绝', r.get('code') != 0 and '邮箱' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = post('/api/emp/add', {'code': 'E99002', 'nameCn': '坏邮箱', 'email': 'abc@'})
    check('邮箱格式不正确被拒绝', r.get('code') != 0 and '格式' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = post('/api/emp/add', {'code': 'E99003', 'nameCn': '坏手机', 'email': 'ok@jiudou.com', 'phone': '12345'})
    check('手机号格式不正确被拒绝', r.get('code') != 0 and '手机号' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = post('/api/emp/add', {'code': 'E99004', 'nameCn': '坏状态', 'email': 'ok2@jiudou.com', 'status': 9})
    check('在职状态越界被拒绝', r.get('code') != 0 and '在职状态' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = post('/api/emp/add', {'code': 'E99005', 'nameCn': '坏部门', 'email': 'ok3@jiudou.com', 'deptId': 999999})
    check('所属部门不存在被拒绝', r.get('code') != 0 and '部门' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = post('/api/emp/add', {'code': 'E99006', 'nameCn': '坏日期', 'email': 'ok4@jiudou.com', 'hireDate': '2026/01/05'})
    check('入职日期格式错误被拒绝', r.get('code') != 0 and '日期' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))

    print('\n--- 8f. 员工信息：编辑与删除 ---')
    new_code = get('/api/emp/nextcode')['data']['code']
    r = post('/api/emp/update', {'id': emp1, 'code': new_code, 'nameCn': '自动化测试员工(改)',
                                 'gender': 2, 'phone': '13900139002', 'email': 'auto2.emp@jiudou.com',
                                 'deptId': 0, 'jobTitle': '高级测试岗', 'status': 2,
                                 'hireDate': '2026-02-01', 'remark': '已修改'})
    check('工号可编辑（改为新流水号成功）', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:200])
    d = get('/api/emp/detail', {'id': emp1})['data']
    check('编辑后各字段已落库',
          d['code'] == new_code and d['nameCn'] == '自动化测试员工(改)' and int(d['status']) == 2
          and d['jobTitle'] == '高级测试岗' and d['hireDate'] == '2026-02-01',
          json.dumps(d, ensure_ascii=False)[:220])
    check('编辑后在职状态文案同步为试用', d['statusText'] == '试用')
    r = post('/api/emp/update', {'id': emp1, 'code': new_code, 'nameCn': '空邮箱', 'email': ''})
    check('编辑时邮箱清空被拒绝', r.get('code') != 0 and '邮箱' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = post('/api/emp/delete', {'id': emp1})
    check('删除员工成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False))
    check('删除后不可访问', get('/api/emp/detail', {'id': emp1}).get('code') == 404)
    check('清理后员工总数回到基线 %d' % EMP_BASE,
          get('/api/emp/list', {'pageSize': 200})['data']['total'] == EMP_BASE,
          str(get('/api/emp/list', {'pageSize': 200})['data']['total']))
    check('清理后健康检查计数一致', int(get('/api/health')['data'].get('empCount') or 0) == EMP_BASE)

    # ---- 员工档案字段（出生日期 / 身份证 / 学历 / 院校 / 专业 / 证书 / 职称 / 照片） ----
    print('\n--- 8g. 员工信息：档案字段 ---')
    one = (get('/api/emp/list', {'pageSize': 1})['data']['list'] or [{}])[0]
    check('列表返回档案字段（出生日期/身份证/学历/院校/专业/证书/职称/照片）',
          all(k in one for k in ('birthDate', 'idCard', 'education', 'school', 'major',
                                 'certificates', 'titleName', 'photo', 'archiveText', 'avatarText')),
          json.dumps(one, ensure_ascii=False)[:240])
    check('出生日期按 YYYY-MM-DD 输出或为空',
          (not one.get('birthDate')) or re.match(r'^\d{4}-\d{2}-\d{2}$', one['birthDate']) is not None,
          str(one.get('birthDate')))
    check('学历 / 职称合成展示字段 archiveText',
          isinstance(one.get('archiveText'), str), str(one.get('archiveText')))

    acode = get('/api/emp/nextcode')['data']['code']
    photo_data = 'data:image/png;base64,' + 'A' * 4000
    r = post('/api/emp/add', {'code': acode, 'nameCn': '档案测试员工', 'email': 'archive.emp@jiudou.com',
                              'birthDate': '1990-05-20', 'idCard': '11010119900520123x',
                              'education': '硕士', 'school': '北京大学', 'major': '临床医学',
                              'certificates': '执业医师资格证', 'titleName': '主治医师',
                              'photo': photo_data})
    aid = (r.get('data') or {}).get('id') or 0
    check('带档案字段新增成功', r.get('code') == 0 and aid, json.dumps(r, ensure_ascii=False)[:200])
    d = get('/api/emp/detail', {'id': aid})['data'] if aid else {}
    check('档案字段全部落库',
          d.get('birthDate') == '1990-05-20' and d.get('idCard') == '11010119900520123X'
          and d.get('education') == '硕士' and d.get('school') == '北京大学'
          and d.get('major') == '临床医学' and d.get('certificates') == '执业医师资格证'
          and d.get('titleName') == '主治医师' and (d.get('photo') or '').startswith('data:image/png'),
          json.dumps(d, ensure_ascii=False)[:260])
    check('身份证末位自动转大写', (d.get('idCard') or '').endswith('X'), str(d.get('idCard')))
    check('档案摘要 = 学历 / 职称', d.get('archiveText') == '硕士 / 主治医师', str(d.get('archiveText')))
    check('有照片时 hasPhoto=true 且无姓名占位',
          d.get('hasPhoto') is True and d.get('avatarText') == '',
          json.dumps({'hasPhoto': d.get('hasPhoto'), 'avatarText': d.get('avatarText')}, ensure_ascii=False))
    r = post('/api/emp/update', {'id': aid, 'code': acode, 'nameCn': '档案测试员工',
                                 'email': 'archive.emp@jiudou.com', 'photo': ''})
    check('照片可清空（置空后 photo 为空串）',
          r.get('code') == 0 and get('/api/emp/detail', {'id': aid})['data']['photo'] == '',
          json.dumps(r, ensure_ascii=False)[:160])

    r = post('/api/emp/add', {'code': 'E99007', 'nameCn': '坏身份证', 'email': 'bad.id@jiudou.com',
                              'idCard': '12345678901234567'})
    check('身份证号位数不合法被拒绝', r.get('code') != 0 and '身份证' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = post('/api/emp/add', {'code': 'E99008', 'nameCn': '未来生日', 'email': 'bad.birth@jiudou.com',
                              'birthDate': '2099-01-01'})
    check('出生日期晚于今天被拒绝', r.get('code') != 0 and '出生日期' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = post('/api/emp/add', {'code': 'E99009', 'nameCn': '坏生日', 'email': 'bad.date@jiudou.com',
                              'birthDate': '1990/05/20'})
    check('出生日期格式错误被拒绝', r.get('code') != 0 and '出生日期' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False))
    r = post('/api/emp/add', {'code': 'E99010', 'nameCn': '大照片', 'email': 'big.photo@jiudou.com',
                              'photo': 'data:image/png;base64,' + 'A' * 410000})
    check('照片超出体积上限被拒绝', r.get('code') != 0 and '照片' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False)[:160])
    r = post('/api/emp/add', {'code': 'E99011', 'nameCn': '坏照片', 'email': 'bad.photo@jiudou.com',
                              'photo': 'ftp://example.com/a.png'})
    check('照片格式不正确被拒绝', r.get('code') != 0 and '照片' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False)[:160])

    r = post('/api/emp/delete', {'id': aid})
    check('删除档案测试员工成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False))
    check('清理后员工总数回到基线 %d' % EMP_BASE,
          get('/api/emp/list', {'pageSize': 200})['data']['total'] == EMP_BASE,
          str(get('/api/emp/list', {'pageSize': 200})['data']['total']))

    # ---- 含下级部门的人员查询（组织架构图双击查看人员） ----
    print('\n--- 8f. 员工信息：包含下级部门的人员查询 ---')
    dept_rows = get('/api/org/list', {'pageSize': 200})['data']['list']
    parent_with_kids = None
    for d in dept_rows:
        if d['childCount']:
            parent_with_kids = d
            break
    if parent_with_kids:
        pid = parent_with_kids['id']
        direct = get('/api/emp/list', {'deptId': pid, 'pageSize': 200})['data']['total']
        with_kids = get('/api/emp/list', {'deptId': pid, 'includeChildren': 1, 'pageSize': 200})['data']['total']
        check('includeChildren=1 的人数不少于仅本部门（%d ≥ %d）' % (with_kids, direct),
              with_kids >= direct, 'direct=%d, withKids=%d' % (direct, with_kids))
        titles = [x['deptName'] for x in
                  get('/api/emp/list', {'deptId': pid, 'includeChildren': 1, 'pageSize': 200})['data']['list']]
        check('结果覆盖到下级部门（返回里出现非本部门的员工时成立）',
              with_kids == direct or any(t and t != parent_with_kids['nameCn'] for t in titles),
              str(titles)[:160])
        check('不带 includeChildren 时仅返回本部门员工',
              all(x['deptId'] == pid for x in
                  get('/api/emp/list', {'deptId': pid, 'pageSize': 200})['data']['list']),
              str(direct))
    else:
        check('库中存在带下级的部门（用于验证含下级人员查询）', False, '未找到带下级部门的记录')

    # ===================== 部门负责人设置 =====================
    print('\n--- 8g. 部门负责人设置：设置 / 替换 / 清除 ---')
    DPT_MGR_BASE = int(get('/api/health')['data'].get('dptMgrCount') or 0)
    org_list = get('/api/org/list', {'pageSize': 200})['data']['list']
    emp_list = get('/api/emp/list', {'pageSize': 200})['data']['list']
    check('部门列表返回负责人字段（managerId/managerName）',
          all('managerId' in x and 'managerName' in x for x in org_list),
          json.dumps(org_list[0], ensure_ascii=False)[:160] if org_list else 'empty')
    if org_list and emp_list:
        # 选一个「未设置负责人」的部门做用例
        target = None
        for x in org_list:
            if not x['managerName']:
                target = x
                break
        if target is None:
            target = org_list[-1]
        dept_id = target['id']
        emp1, emp2 = emp_list[0], (emp_list[1] if len(emp_list) > 1 else emp_list[0])

        r = post('/api/dptmgr/set', {'deptId': dept_id, 'empId': emp1['id'], 'remark': '主责'})
        check('设置部门负责人成功', r.get('code') == 0 and (r.get('data') or {}).get('empId') == emp1['id'],
              json.dumps(r, ensure_ascii=False)[:200])
        d = get('/api/org/detail', {'id': dept_id})['data']
        check('部门详情带出负责人姓名', d['managerName'] == emp1['nameCn'] and d['managerId'] == emp1['id'],
              json.dumps({'managerName': d['managerName'], 'managerId': d['managerId']}, ensure_ascii=False))
        check('部门列表同样带出负责人（组织架构图 / 列表数据源）',
              any(x['id'] == dept_id and x['managerName'] == emp1['nameCn']
                  for x in get('/api/org/list', {'pageSize': 200})['data']['list']))

        r = post('/api/dptmgr/set', {'deptId': dept_id, 'empId': emp2['id']})
        check('同一部门重复设置即替换（不报错）', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:160])
        d = get('/api/org/detail', {'id': dept_id})['data']
        check('替换后负责人为新员工', d['managerId'] == emp2['id'] and d['managerName'] == emp2['nameCn'],
              json.dumps({'managerName': d['managerName']}, ensure_ascii=False))
        cnt = len([x for x in get('/api/dptmgr/list')['data']['list'] if x['deptId'] == dept_id])
        check('一个部门只保留一条负责人记录', cnt == 1, 'count=' + str(cnt))

        r = post('/api/dptmgr/set', {'deptId': 999999, 'empId': emp1['id']})
        check('部门不存在时设置被拒绝', r.get('code') != 0 and '部门' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False))
        r = post('/api/dptmgr/set', {'deptId': dept_id, 'empId': 999999})
        check('员工不存在时设置被拒绝', r.get('code') != 0 and '员工' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False))

        r = post('/api/dptmgr/delete', {'deptId': dept_id})
        check('清除负责人成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False))
        d = get('/api/org/detail', {'id': dept_id})['data']
        check('清除后部门负责人为空', d['managerName'] == '' and d['managerId'] == 0,
              json.dumps({'managerName': d['managerName']}, ensure_ascii=False))
        r = post('/api/dptmgr/delete', {'deptId': dept_id})
        check('重复清除返回业务错误（404）', r.get('code') == 404, json.dumps(r, ensure_ascii=False))
        check('清理后负责人数量回到基线 %d' % DPT_MGR_BASE,
              int(get('/api/health')['data'].get('dptMgrCount') or 0) == DPT_MGR_BASE,
              str(get('/api/health')['data'].get('dptMgrCount')))

    # ===================== 用户角色（UUID 主键） =====================
    print('')
    print('--- 8h. 用户角色：UUID 主键 / 英文名唯一 / 中文名启用状态内唯一 ---')
    health = get('/api/health')['data']
    check('健康检查返回角色数量', 'roleCount' in health, str(sorted(health.keys())))
    role_rows = (get('/api/role/list', {'pageNum': 1, 'pageSize': 200}).get('data') or {}).get('list') or []
    ROLE_BASE = len(role_rows)
    check('角色列表可访问（%d 条）' % ROLE_BASE, isinstance(role_rows, list), str(ROLE_BASE))
    if role_rows:
        check('角色主键为 36 位 UUID',
              all(re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                           str(x['id'])) for x in role_rows),
              str([x['id'] for x in role_rows])[:120])
        check('角色字段完整（中文名 / 英文名 / 说明 / 排序号 / 启用否）',
              all(('nameCn' in x and 'nameEn' in x and 'remark' in x
                   and 'sortNo' in x and 'enabled' in x) for x in role_rows),
              json.dumps(role_rows[0], ensure_ascii=False)[:220])
        check('接口不输出生成列 nameCnActive',
              all('nameCnActive' not in x for x in role_rows),
              str(sorted(role_rows[0].keys())))
        check('角色列表按排序号升序',
              all(int(role_rows[i]['sortNo']) <= int(role_rows[i + 1]['sortNo'])
                  for i in range(len(role_rows) - 1)),
              str([(x['sortNo'], x['nameCn']) for x in role_rows]))
        r = get('/api/role/list', {'keyword': role_rows[0]['nameCn'], 'pageSize': 200})
        check('关键字可按中文名检索', r['data']['total'] >= 1, str(r['data']['total']))
        r = get('/api/role/list', {'keyword': role_rows[0]['nameEn'], 'pageSize': 200})
        check('关键字可按英文名检索', r['data']['total'] >= 1, str(r['data']['total']))
        r = get('/api/role/list', {'keyword': role_rows[0]['id'], 'pageSize': 200})
        check('关键字可按角色ID检索', r['data']['total'] >= 1, str(r['data']['total']))
        r = get('/api/role/list', {'enabled': '0', 'pageSize': 200})
        check('启用否筛选只返回停用角色',
              all(not x['enabled'] for x in r['data']['list']), str(r['data']['total']))

        enabled_row = next((x for x in role_rows if x['enabled']), role_rows[0])
        r = get('/api/role/check', {'field': 'nameCn', 'value': enabled_row['nameCn'], 'enabled': 1})
        check('中文名查重（启用）：已占用判定为不唯一', (r.get('data') or {}).get('unique') is False,
              json.dumps(r, ensure_ascii=False))
        r = get('/api/role/check', {'field': 'nameCn', 'value': enabled_row['nameCn'], 'enabled': 0})
        check('中文名查重（停用）：判定为唯一', (r.get('data') or {}).get('unique') is True,
              json.dumps(r, ensure_ascii=False))
        r = get('/api/role/check', {'field': 'nameEn', 'value': enabled_row['nameEn']})
        check('英文名查重：已占用判定为不唯一', (r.get('data') or {}).get('unique') is False,
              json.dumps(r, ensure_ascii=False))

    stamp = str(int(time.time()))[-4:]
    new_cn = '自动化角色%s' % stamp
    new_en = 'AutoRole%s' % stamp
    r = post('/api/role/add', {'nameCn': new_cn, 'nameEn': new_en, 'remark': '联调用例角色',
                               'sortNo': 88, 'enabled': 1})
    role_id = (r.get('data') or {}).get('id') or ''
    check('新增角色成功且返回 UUID 主键',
          r.get('code') == 0 and re.match(
              r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', role_id) is not None,
          json.dumps(r, ensure_ascii=False)[:200] if r else 'empty')
    disabled_id = ''
    if role_id:
        d = get('/api/role/detail', {'id': role_id})['data']
        check('新增后字段落库（含英文名）',
              d['nameCn'] == new_cn and d['nameEn'] == new_en and d['remark'] == '联调用例角色'
              and int(d['sortNo']) == 88 and d['enabled'] is True
              and 'nameCnActive' not in d,
              json.dumps(d, ensure_ascii=False)[:220])

        r = post('/api/role/add', {'nameCn': '英文名重复角色', 'nameEn': new_en, 'enabled': 1})
        check('英文名重复被拒绝', r.get('code') != 0 and '英文名' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:160])
        r = post('/api/role/add', {'nameCn': new_cn, 'nameEn': 'OtherEn%s' % stamp, 'enabled': 1})
        check('中文名与启用角色重名被拒绝',
              r.get('code') != 0 and '已被其它启用状态的角色使用' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:200])
        r = post('/api/role/add', {'nameCn': new_cn, 'nameEn': 'DisabledDup%s' % stamp, 'enabled': 0})
        disabled_id = (r.get('data') or {}).get('id') or ''
        check('停用状态可与启用角色中文名相同（新增成功）',
              r.get('code') == 0 and bool(disabled_id) and r['data']['enabled'] is False,
              json.dumps(r, ensure_ascii=False)[:200])
        r = post('/api/role/add', {'nameCn': '缺英文名角色', 'enabled': 1})
        check('英文名必填被拒绝', r.get('code') != 0 and '英文名' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:160])
        r = post('/api/role/add', {'nameCn': '坏英文名', 'nameEn': '1abc', 'enabled': 1})
        check('英文名格式非法被拒绝', r.get('code') != 0 and '英文名' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:160])

        # 停用角色保持同名可保存；改成启用后与启用角色同名 → 拒绝
        if disabled_id:
            r = post('/api/role/update', {'id': disabled_id, 'nameCn': new_cn,
                                          'nameEn': 'DisabledDup%s' % stamp, 'enabled': 0})
            check('停用状态保持同名可保存', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:160])
            r = post('/api/role/update', {'id': disabled_id, 'nameCn': new_cn,
                                          'nameEn': 'DisabledDup%s' % stamp, 'enabled': 1})
            check('停用改启用后与启用角色重名被拒绝',
                  r.get('code') != 0 and '已被其它启用状态的角色使用' in r.get('message', ''),
                  json.dumps(r, ensure_ascii=False)[:200])

        r = get('/api/role/check', {'field': 'nameEn', 'value': new_en, 'id': role_id})
        check('英文名查重：排除自身时判定为唯一', (r.get('data') or {}).get('unique') is True,
              json.dumps(r, ensure_ascii=False))

        r = post('/api/role/update', {'id': role_id, 'nameCn': new_cn + '改', 'nameEn': new_en + 'Edit',
                                      'remark': '已修改', 'sortNo': 89, 'enabled': 0})
        check('编辑角色成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:200])
        d = get('/api/role/detail', {'id': role_id})['data']
        check('编辑后字段已更新且主键不变',
              d['id'] == role_id and d['nameCn'] == new_cn + '改' and d['nameEn'] == new_en + 'Edit'
              and d['enabled'] is False and int(d['sortNo']) == 89,
              json.dumps(d, ensure_ascii=False)[:220])

        r = post('/api/role/update', {'id': role_id, 'nameCn': new_cn + '改', 'nameEn': 'Bad Name'})
        check('编辑时英文名格式非法被拒绝', r.get('code') != 0 and '英文名' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:160])
        r = post('/api/role/update', {'id': role_id, 'nameCn': new_cn + '改', 'nameEn': new_en + 'Edit',
                                      'sortNo': 'abc'})
        check('排序号非整数被拒绝', r.get('code') != 0 and '排序号' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:160])
        r = post('/api/role/update', {'id': role_id, 'nameCn': '', 'nameEn': new_en + 'Edit'})
        check('中文名为空被拒绝', r.get('code') != 0 and '中文名' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:160])
        r = get('/api/role/detail', {'id': '123'})
        check('非法 id（非 UUID）被拒绝', r.get('code') != 0 and 'UUID' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:160])
        r = get('/api/role/detail', {'id': '00000000-0000-0000-0000-000000000000'})
        check('不存在的角色返回 404', r.get('code') == 404, json.dumps(r, ensure_ascii=False)[:120])
        r = post('/api/role/delete', {'id': role_id})
        check('删除角色成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:160])
        check('删除后不可访问', get('/api/role/detail', {'id': role_id}).get('code') == 404)
        if disabled_id:
            post('/api/role/delete', {'id': disabled_id})
        check('清理后角色数量回到基线 %d' % ROLE_BASE,
              int(get('/api/health')['data'].get('roleCount') or 0) == ROLE_BASE,
              str(get('/api/health')['data'].get('roleCount')))

    # ===================== 角色权限（usergrouppowerset，UUID 主键） =====================
    print('\n--- 8i. 角色权限：权限树 / 全量保存 / 清空（UUID 主键） ---')
    health = get('/api/health')['data']
    check('健康检查返回角色权限记录数', 'rolePowerCount' in health, str(sorted(health.keys())))

    role_rows = (get('/api/role/list', {'pageNum': 1, 'pageSize': 200}).get('data') or {}).get('list') or []
    target = None
    for one in role_rows:
        if one.get('nameCn') == '业务管理员' and one.get('enabled'):
            target = one
            break
    if not target:
        target = role_rows[0] if role_rows else None
    check('存在可配置权限的角色', target is not None, str(len(role_rows)))

    if target:
        rid = target['id']
        tree = get('/api/rolepower/tree', {'roleId': rid})['data']
        check('权限树按菜单组返回（含 items）',
              isinstance(tree.get('groups'), list) and len(tree['groups']) > 0,
              json.dumps(tree, ensure_ascii=False)[:200])
        check('权限树给出菜单项总数与已授权数',
              isinstance(tree.get('total'), int) and tree['total'] >= 1
              and isinstance(tree.get('checked'), int),
              'total=%s checked=%s' % (tree.get('total'), tree.get('checked')))
        first_group = tree['groups'][0]
        check('菜单组带层级路径 crumb 与组内计数',
              bool(first_group.get('crumb')) and first_group.get('itemCount') == len(first_group.get('items') or []),
              json.dumps(first_group, ensure_ascii=False)[:200])
        check('菜单项字段完整（菜单项ID / 编号 / 中文名 / 页面地址 / checked）',
              all(all(k in it for k in ('menuItemId', 'code', 'nameCn', 'path', 'checked'))
                  for it in first_group['items']),
              json.dumps(first_group['items'][:1], ensure_ascii=False)[:200])

        # 记录原始授权，测试结束后还原
        # ⚠ 必须用「授权记录列表」里的真实行（含整组授权 menuItemId=0），
        #   不能拿权限树的 checked 反推 —— 树里看不到整体授权，而 save(menuItemId=0) 会被展开，
        #   用树反推会把"展开出来的菜单项"当成原始授权写回，越跑越偏（踩过：普通用户莫名多了数据中心）。
        original = []
        for row in ((get('/api/rolepower/list', {'roleId': rid}).get('data') or {}).get('list') or []):
            if row.get('enabled'):
                original.append({'menuGroupId': int(row['menuGroupId']),
                                 'menuItemId': int(row['menuItemId'])})
        base_checked = len([1 for g in tree['groups'] for it in g['items'] if it.get('checked')])

        # ⚠ 按钮授权也记一份基线：本段的菜单全量替换不能把它一起清掉
        #   （踩过：/api/rolepower/clear 连按钮一起删，系统管理员从此全站按钮消失）。
        base_btn_checked = int(tree.get('buttonChecked') or 0)

        all_pairs = []
        for g in tree['groups']:
            for it in g['items']:
                all_pairs.append({'menuGroupId': g['menuGroupId'], 'menuItemId': it['menuItemId']})

        # 1) 只授 1 项
        r = post('/api/rolepower/save', {'roleId': rid, 'items': all_pairs[:1]})
        check('保存部分权限成功', r.get('code') == 0 and (r.get('data') or {}).get('saved') == 1,
              json.dumps(r, ensure_ascii=False)[:160])
        t2 = get('/api/rolepower/tree', {'roleId': rid})['data']
        check('保存后权限树只勾选 1 项', t2.get('checked') == 1, str(t2.get('checked')))

        # 2) 全量替换为全部取消（空数组）
        r = post('/api/rolepower/save', {'roleId': rid, 'items': []})
        check('保存空数组可清空该角色权限',
              r.get('code') == 0 and get('/api/rolepower/tree', {'roleId': rid})['data']['checked'] == 0,
              json.dumps(r, ensure_ascii=False)[:160])

        # 3) 整组授权（menuItemId=0）→ 展开为该组全部菜单项
        gid = tree['groups'][0]['menuGroupId']
        expect = tree['groups'][0]['itemCount']
        r = post('/api/rolepower/save', {'roleId': rid, 'items': [{'menuGroupId': gid, 'menuItemId': 0}]})
        check('整组授权（menuItemId=0）展开为组内全部菜单项',
              r.get('code') == 0 and (r.get('data') or {}).get('saved') == expect,
              json.dumps(r, ensure_ascii=False)[:160])
        t3 = get('/api/rolepower/tree', {'roleId': rid})['data']
        check('整组授权后该组全部勾选', t3.get('checked') == expect,
              '%s / %s' % (t3.get('checked'), expect))

        # 4) 菜单项不属于该菜单组 → 拒绝
        other = None
        for g in tree['groups']:
            if g['menuGroupId'] != gid and g['items']:
                other = g['items'][0]
                break
        if other:
            r = post('/api/rolepower/save', {'roleId': rid, 'items': [
                {'menuGroupId': gid, 'menuItemId': other['menuItemId']}]})
            check('菜单项不属于该菜单组时拒绝保存',
                  r.get('code') != 0 and '不属于' in r.get('message', ''),
                  json.dumps(r, ensure_ascii=False)[:200])

        # 5) 非法 roleId / 不存在的角色
        r = get('/api/rolepower/tree', {'roleId': '123'})
        check('roleId 非 UUID 被拒绝', r.get('code') != 0 and 'UUID' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:160])
        r = get('/api/rolepower/tree', {'roleId': '00000000-0000-0000-0000-000000000000'})
        check('roleId 对应角色不存在时返回 404', r.get('code') == 404,
              json.dumps(r, ensure_ascii=False)[:160])

        # 6) 授权记录列表：主键为 UUID，且带菜单组 / 菜单项名称
        r = get('/api/rolepower/list', {'roleId': rid})
        rows = (r.get('data') or {}).get('list') or []
        check('权限列表可访问且总数与树一致', r.get('code') == 0 and len(rows) == expect,
              '%s / %s' % (len(rows), expect))
        if rows:
            check('权限记录主键为 36 位 UUID',
                  re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                           str(rows[0]['id'])) is not None,
                  str(rows[0]['id']))
            check('权限记录带菜单组 / 菜单项名称',
                  bool(rows[0].get('menuGroupName')) and bool(rows[0].get('menuItemName')),
                  json.dumps(rows[0], ensure_ascii=False)[:200])

        # 7) 清空接口 —— 必须用**临时角色**验证：
        #    clear 是「菜单 + 按钮」一起删，而按钮授权没法从权限树完整还原
        #    （没挂到菜单项下的页面按钮根本不在树里），拿真实角色试会一次一次啃掉它的按钮授权
        #    （踩过：系统管理员按钮全站消失，见 db/restore-admin-btn-perm.sql）。
        stamp_now = int(time.time() * 1000) % 1000000
        tadd = post('/api/role/add', {'nameCn': '清空验证角色%d' % stamp_now,
                                      'nameEn': 'ClearProbe%d' % stamp_now,
                                      'remark': '联调用例临时角色（用例结束即删）',
                                      'sortNo': 99, 'enabled': 1})
        tmp_rid = (tadd.get('data') or {}).get('id') or ''
        if tmp_rid:
            all_btn_ids = []
            for g in tree['groups']:
                for it in g['items']:
                    for b in (it.get('buttons') or []):
                        if b['pageOpBtnId'] not in all_btn_ids:
                            all_btn_ids.append(b['pageOpBtnId'])
            post('/api/rolepower/save', {'roleId': tmp_rid, 'items': all_pairs[:3],
                                         'buttons': all_btn_ids[:5]})
            r = post('/api/rolepower/clear', {'roleId': tmp_rid})
            t_tmp = get('/api/rolepower/tree', {'roleId': tmp_rid})['data']
            check('清空接口删除全部授权（菜单 + 按钮）',
                  r.get('code') == 0 and t_tmp['checked'] == 0
                  and int(t_tmp.get('buttonChecked') or 0) == 0,
                  '%s / %s' % (json.dumps(r, ensure_ascii=False)[:80], t_tmp.get('buttonChecked')))
            post('/api/role/delete', {'id': tmp_rid})
        else:
            check('临时角色创建成功（清空接口验证用）', False, json.dumps(tadd, ensure_ascii=False)[:160])

        # 8) 还原原始授权（只提交 items）：菜单权限的全量替换不能误伤按钮授权
        r = post('/api/rolepower/save', {'roleId': rid, 'items': original})
        t_back = get('/api/rolepower/tree', {'roleId': rid})['data']
        check('还原原始授权（%d 项菜单，按钮授权不受影响 %d 个）' % (base_checked, base_btn_checked),
              r.get('code') == 0 and t_back['checked'] == base_checked
              and int(t_back.get('buttonChecked') or 0) == base_btn_checked,
              '%s / %s' % (t_back.get('checked'), t_back.get('buttonChecked')))

        # 9) 关键字过滤
        kw = tree['groups'][-1]['items'][0]['nameCn'][:2]
        t4 = get('/api/rolepower/tree', {'roleId': rid, 'keyword': kw})['data']
        check('权限树支持关键字过滤（命中项 ≤ 总数）',
              0 < t4.get('total', 0) <= tree['total'],
              '%s / %s' % (t4.get('total'), tree['total']))

    # ===================== 页面操作按钮（pageopbtn，UUID 主键 + 自动收录） =====================
    print('\n--- 8j. 页面操作按钮：自动收录 / 维护 / 删除（UUID 主键） ---')
    health = get('/api/health')['data']
    check('健康检查返回页面操作按钮数量', 'pageOpBtnCount' in health, str(sorted(health.keys())))

    r = post('/api/pageopbtn/scan', {})
    sc = r.get('data') or {}
    check('扫描页面自动收录成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:200])
    check('收录到多个页面的按钮（≥10 页 / ≥40 项）',
          int(sc.get('pages') or 0) >= 10 and int(sc.get('scanned') or 0) >= 40,
          json.dumps(sc, ensure_ascii=False))
    check('收录结果包含新增 / 更新 / 未变 / 失效四类计数',
          all(k in sc for k in ('added', 'updated', 'unchanged', 'missing')),
          json.dumps(sc, ensure_ascii=False))

    r2 = post('/api/pageopbtn/scan', {})
    sc2 = r2.get('data') or {}
    check('重复扫描幂等（无新增、全部未变）',
          int(sc2.get('added') or 0) == 0 and int(sc2.get('unchanged') or 0) == int(sc2.get('scanned') or 0),
          json.dumps(sc2, ensure_ascii=False))

    # 后端把 pageSize 裁到 200（全站按钮数会随页面增加而破 200），所以按「首页满 + 翻页取余」来验
    lst = get('/api/pageopbtn/list', {'pageNum': 1, 'pageSize': 500}).get('data') or {}
    rows = lst.get('list') or []
    btn_total = int(lst.get('total') or 0)
    check('列表可访问且总数与扫描一致（单页上限 200 由后端裁剪）',
          btn_total == int(sc2.get('total') or 0) and len(rows) == min(200, btn_total) and btn_total >= 40,
          '%s / %s / %s' % (len(rows), btn_total, sc2.get('total')))
    page2 = get('/api/pageopbtn/list', {'pageNum': 2, 'pageSize': 200}).get('data') or {}
    rest = page2.get('list') or []
    check('翻页取回余下的按钮且与首页无重复',
          len(rest) == max(0, btn_total - 200)
          and not (set(x['id'] for x in rest) & set(x['id'] for x in rows)),
          str(len(rest)))
    check('记录主键为 36 位 UUID',
          all(re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', str(x['id']))
              for x in rows[:10]),
          str([x['id'] for x in rows[:2]]))
    check('字段完整（所属页面 / 页面路径 / 按钮id / 按钮文本 / 启用否）',
          all(all(k in x for k in ('pageName', 'pagePath', 'btnId', 'btnText', 'enabled', 'sortNo'))
              for x in rows[:10]),
          json.dumps(rows[0], ensure_ascii=False)[:200])
    check('列表按页面路径 + 按钮顺序排列',
          [x['pagePath'] for x in rows] == sorted([x['pagePath'] for x in rows]),
          str([x['pagePath'] for x in rows[:5]]))

    # 关键字 / 页面 / 启用否筛选
    one = rows[0]
    r = get('/api/pageopbtn/list', {'keyword': one['btnId'], 'pageSize': 200})
    check('关键字可按按钮id检索', r['data']['total'] >= 1, str(r['data']['total']))
    r = get('/api/pageopbtn/list', {'pagePath': one['pagePath'], 'pageSize': 200})
    check('可按页面路径筛选',
          r['data']['total'] >= 1 and all(x['pagePath'] == one['pagePath'] for x in r['data']['list']),
          str(r['data']['total']))

    pages = (get('/api/pageopbtn/pages').get('data') or {}).get('list') or []
    check('页面下拉返回已收录页面',
          len(pages) >= 10 and all('pagePath' in p and 'total' in p for p in pages),
          json.dumps(pages[:2], ensure_ascii=False))

    # ---- 维护：编辑（停用 + 改文本） → 再扫描不应把停用状态改回来 ----
    target = rows[0]
    r = post('/api/pageopbtn/update', {'id': target['id'], 'pageName': target['pageName'],
                                       'btnText': '自动化改文案', 'enabled': 0, 'remark': '测试停用'})
    check('编辑按钮记录成功（文本 / 启用否）',
          r.get('code') == 0 and r['data']['btnText'] == '自动化改文案' and r['data']['enabled'] is False,
          json.dumps(r, ensure_ascii=False)[:200])

    post('/api/pageopbtn/scan', {})
    d = get('/api/pageopbtn/detail', {'id': target['id']})['data']
    check('重新收录会按页面同步按钮文本', d['btnText'] == target['btnText'], str(d['btnText']))
    check('重新收录不改动人工设置的停用状态', d['enabled'] is False, str(d['enabled']))

    r = post('/api/pageopbtn/update', {'id': target['id'], 'btnText': '', 'enabled': 1})
    check('按钮文本为空被拒绝', r.get('code') != 0 and '文本' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False)[:160])
    r = get('/api/pageopbtn/detail', {'id': 'not-a-uuid'})
    check('id 非 UUID 被拒绝', r.get('code') != 0 and 'UUID' in r.get('message', ''),
          json.dumps(r, ensure_ascii=False)[:160])
    r = get('/api/pageopbtn/detail', {'id': '00000000-0000-0000-0000-000000000000'})
    check('不存在的记录返回 404', r.get('code') == 404, json.dumps(r, ensure_ascii=False)[:120])

    # ---- 删除后重新扫描可恢复 ----
    # ⚠ 删除会级联清掉各角色对这个按钮的授权，而重新收录拿到的是**新 UUID**，
    #   授权不会自己回来 → 先记下「哪些角色有这个按钮」，补回时按新 id 换进去。
    #   （踩过：每跑一次接口回归，系统管理员就少一个 dbinfo.html 按钮的授权）
    target_roles = (get('/api/role/list', {'pageNum': 1, 'pageSize': 200}).get('data') or {}).get('list') or []
    target_grants = {}
    for _role in target_roles:
        _rows = (get('/api/rolepower/buttons', {'roleId': _role['id']}).get('data') or {}).get('list') or []
        _ids = [x['pageOpBtnId'] for x in _rows if x.get('enabled')]
        if any(str(x) == str(target['id']) for x in _ids):
            target_grants[_role['id']] = _ids

    base_total = int(get('/api/health')['data'].get('pageOpBtnCount') or 0)
    r = post('/api/pageopbtn/delete', {'id': target['id']})
    check('删除按钮记录成功', r.get('code') == 0, json.dumps(r, ensure_ascii=False)[:160])
    check('删除后总数减 1',
          int(get('/api/health')['data'].get('pageOpBtnCount') or 0) == base_total - 1,
          str(get('/api/health')['data'].get('pageOpBtnCount')))
    sc3 = post('/api/pageopbtn/scan', {}).get('data') or {}
    check('删除后重新收录会把按钮补回来',
          int(sc3.get('added') or 0) >= 1
          and int(get('/api/health')['data'].get('pageOpBtnCount') or 0) == base_total,
          json.dumps(sc3, ensure_ascii=False))

    # 把重新收录后的新 id 换回原来的授权位置
    new_btn_id = ''
    for _one in ((get('/api/pageopbtn/list',
                       {'pagePath': target['pagePath'], 'pageSize': 200}).get('data') or {}).get('list') or []):
        if _one.get('btnId') == target.get('btnId'):
            new_btn_id = _one['id']
    for _rid, _ids in target_grants.items():
        post('/api/rolepower/save',
             {'roleId': _rid,
              'buttons': [new_btn_id if str(x) == str(target['id']) else x for x in _ids]})
    if target_grants:
        _bl = (get('/api/rolepower/buttons',
                   {'roleId': list(target_grants.keys())[0]}).get('data') or {})
        check('重新收录后被删按钮的角色授权已按新 id 补回',
              bool(new_btn_id) and any(str(x['pageOpBtnId']) == str(new_btn_id)
                                       for x in (_bl.get('list') or [])),
              'new=%s rows=%s' % (new_btn_id, _bl.get('total')))

    # ---- 扫描不存在的目录：不新增、不报错、也不把已有记录标记失效 ----
    before_cnt = int(get('/api/health')['data'].get('pageOpBtnCount') or 0)
    r = post('/api/pageopbtn/scan', {'webRoot': 'Z:/no-such-dir'})
    check('扫描不存在的目录时返回 0 项而非报错',
          r.get('code') == 0 and (r.get('data') or {}).get('scanned') == 0,
          json.dumps(r, ensure_ascii=False)[:160])
    check('扫描不到任何按钮时不会把已有记录标记为「页面中已不存在」',
          int((r.get('data') or {}).get('missing') or 0) == 0
          and int(get('/api/health')['data'].get('pageOpBtnCount') or 0) == before_cnt,
          json.dumps(r.get('data'), ensure_ascii=False)[:160])

    # ===================== 角色页面按钮权限（usergrouppagebtnset，UUID 主键） =====================
    print('\n--- 8k. 角色页面按钮权限：权限树挂按钮 / 菜单+按钮一次保存 ---')
    health = get('/api/health')['data']
    check('健康检查返回角色按钮授权数', 'roleBtnCount' in health, str(sorted(health.keys())))

    role_rows = (get('/api/role/list', {'pageNum': 1, 'pageSize': 200}).get('data') or {}).get('list') or []
    target = None
    for one in role_rows:
        if one.get('nameCn') == '业务管理员' and one.get('enabled'):
            target = one
            break
    if not target:
        target = role_rows[0] if role_rows else None
    check('存在可配置按钮权限的角色', target is not None, str(len(role_rows)))

    if target:
        rid = target['id']
        tree = get('/api/rolepower/tree', {'roleId': rid})['data']
        check('权限树返回按钮总数 / 已授权数',
              isinstance(tree.get('buttonTotal'), int) and tree['buttonTotal'] >= 20
              and isinstance(tree.get('buttonChecked'), int),
              'btnTotal=%s btnChecked=%s' % (tree.get('buttonTotal'), tree.get('buttonChecked')))

        item_with_btn = None
        for g in tree['groups']:
            for it in g['items']:
                if it.get('buttonCount'):
                    item_with_btn = (g, it)
                    break
            if item_with_btn:
                break
        check('菜单项（页面）下挂载了操作按钮',
              item_with_btn is not None and item_with_btn[1]['buttonCount'] > 0,
              json.dumps(item_with_btn[1] if item_with_btn else {}, ensure_ascii=False)[:200])
        if item_with_btn:
            one_btn = item_with_btn[1]['buttons'][0]
            check('按钮字段完整（按钮记录ID 为 UUID / 按钮id / 文本 / checked / disabled）',
                  re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                           str(one_btn['pageOpBtnId'])) is not None
                  and one_btn.get('btnId') and one_btn.get('btnText')
                  and 'checked' in one_btn and 'disabled' in one_btn,
                  json.dumps(one_btn, ensure_ascii=False)[:200])
            check('菜单未授权时按钮标记为 disabled',
                  one_btn['disabled'] == (not item_with_btn[1]['checked']),
                  'itemChecked=%s disabled=%s' % (item_with_btn[1]['checked'], one_btn['disabled']))

        # 记录原始菜单 / 按钮授权，测试后还原
        # ⚠ 同 8i：原始菜单授权取真实记录（含整组 menuItemId=0），不要用权限树的 checked 反推
        origin_items = []
        for row in ((get('/api/rolepower/list', {'roleId': rid}).get('data') or {}).get('list') or []):
            if row.get('enabled'):
                origin_items.append({'menuGroupId': int(row['menuGroupId']),
                                     'menuItemId': int(row['menuItemId'])})
        base_item_checked = len([1 for g in tree['groups'] for it in g['items'] if it['checked']])
        origin_btns = []
        for row in (get('/api/rolepower/buttons', {'roleId': rid}).get('data') or {}).get('list') or []:
            if row['enabled']:
                origin_btns.append(row['pageOpBtnId'])

        # 取第一个有按钮的页面 + 其全部按钮
        g0 = item_with_btn[0]
        it0 = item_with_btn[1]
        page_btns = [b['pageOpBtnId'] for b in it0['buttons']]

        # 1) 菜单 + 按钮一次保存
        r = post('/api/rolepower/save', {'roleId': rid,
                                         'items': [{'menuGroupId': g0['menuGroupId'], 'menuItemId': it0['menuItemId']}],
                                         'buttons': page_btns})
        ok1 = r.get('code') == 0
        got = (r.get('data') or {})
        check('一次保存同时写入菜单权限与按钮权限',
              ok1 and got.get('saved') == 1 and got.get('savedButtons') == len(page_btns),
              json.dumps(r, ensure_ascii=False)[:200])
        t2 = get('/api/rolepower/tree', {'roleId': rid})['data']
        check('保存后菜单权限只剩 1 项', t2['checked'] == 1, str(t2['checked']))
        check('保存后按钮权限数目一致', t2['buttonChecked'] == len(page_btns),
              '%s / %s' % (t2['buttonChecked'], len(page_btns)))
        check('该页面的按钮全部为 checked', all(
              b['checked'] for g in t2['groups'] for it in g['items']
              for b in it['buttons'] if it['menuItemId'] == it0['menuItemId'] and b['btnId']),
              json.dumps([(b['btnId'], b['checked']) for g in t2['groups'] for it in g['items']
                          for b in it['buttons']][:5], ensure_ascii=False))

        # 2) 只提交按钮：菜单权限不受影响
        r = post('/api/rolepower/save', {'roleId': rid, 'buttons': page_btns[:1]})
        t3 = get('/api/rolepower/tree', {'roleId': rid})['data']
        check('仅提交按钮时菜单权限保持不变',
              r.get('code') == 0 and t3['checked'] == 1, '%s / %s' % (t3['checked'], 1))
        check('仅提交按钮时按钮权限按提交结果替换',
              t3['buttonChecked'] == 1, str(t3['buttonChecked']))

        # 3) 按钮授权清单接口
        bl = (get('/api/rolepower/buttons', {'roleId': rid}).get('data') or {})
        check('按钮授权清单可访问且带页面 / 按钮信息',
              bl.get('total') == 1 and bl['list'][0].get('pagePath') and bl['list'][0].get('btnText'),
              json.dumps(bl.get('list'), ensure_ascii=False)[:200])

        # 4) 非法按钮 id
        r = post('/api/rolepower/save', {'roleId': rid, 'buttons': ['123']})
        check('pageOpBtnId 非 UUID 被拒绝', r.get('code') != 0 and 'UUID' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:160])
        r = post('/api/rolepower/save', {'roleId': rid,
                                         'buttons': ['00000000-0000-0000-0000-000000000000']})
        check('pageOpBtnId 对应按钮不存在被拒绝',
              r.get('code') != 0 and '不存在' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:160])
        r = post('/api/rolepower/save', {'roleId': rid})
        check('items 与 buttons 都不提交时被拒绝',
              r.get('code') != 0 and '至少' in r.get('message', ''),
              json.dumps(r, ensure_ascii=False)[:160])

        # 5) 清空：菜单 + 按钮一起清
        r = post('/api/rolepower/clear', {'roleId': rid})
        t4 = get('/api/rolepower/tree', {'roleId': rid})['data']
        check('清空接口同时清掉菜单与按钮权限',
              r.get('code') == 0 and t4['checked'] == 0 and t4['buttonChecked'] == 0,
              json.dumps(r.get('data'), ensure_ascii=False)[:160])

        # 6) 删除 pageopbtn 记录 → 其角色授权被级联清理
        btn_row = (get('/api/pageopbtn/list', {'pagePath': it0['path'], 'pageSize': 200}).get('data') or {}).get('list') or []
        victim = None
        for one in btn_row:
            if str(one['id']) in [str(x) for x in page_btns]:
                victim = one
                break
        if victim:
            post('/api/rolepower/save', {'roleId': rid, 'items': origin_items, 'buttons': [victim['id']]})
            base_btn = int(get('/api/health')['data'].get('roleBtnCount') or 0)
            post('/api/pageopbtn/delete', {'id': victim['id']})
            # 断言口径：直接看「该角色的按钮清单里还有没有这个按钮」。
            # 早前用全局 usergrouppagebtnset 行数差值（删前后差 1），会随其他用例
            # 删/重建按钮（换 UUID）与执行顺序抖动，偶发假红过一次。
            after_btns = (get('/api/rolepower/buttons', {'roleId': rid}).get('data') or {}).get('list') or []
            after_ids = [str(x.get('pageOpBtnId')) for x in after_btns]
            check('删除页面按钮后其角色授权被级联清理',
                  str(victim['id']) not in after_ids,
                  'victim=%s after=%d global=%s/%s' % (victim['id'], len(after_ids), base_btn,
                                                       get('/api/health')['data'].get('roleBtnCount')))
            post('/api/pageopbtn/scan', {})        # 重新收录，把按钮补回来（新 UUID）

        # 7) 还原原始授权：按钮 id 要按「还在库里的」重新映射
        #    ⚠ 不能用权限树里的按钮反推：没挂到菜单项下的页面（各类 *-form.html、workplan-design、
        #      service-email…）的按钮根本不在树里，用树反推会把这些授权永久删掉（踩过：管理员少了 60 个）。
        alive_rows = (get('/api/pageopbtn/list', {'pageSize': 500}).get('data') or {}).get('list') or []
        alive_ids = set(str(r['id']) for r in alive_rows)
        by_path_btn = {}
        for r in alive_rows:
            by_path_btn[(r.get('pagePath') or '', r.get('btnId') or '')] = str(r['id'])
        keep_btns = []
        for bid in origin_btns:
            sid = str(bid)
            if sid in alive_ids:
                keep_btns.append(sid)
            elif victim and sid == str(victim['id']):
                # 被删掉重建的那个按钮：id 变了，按「页面 + btnId」找回新 id
                new_id = by_path_btn.get((victim.get('pagePath') or '', victim.get('btnId') or ''))
                if new_id:
                    keep_btns.append(new_id)
        r = post('/api/rolepower/save', {'roleId': rid, 'items': origin_items, 'buttons': keep_btns})
        t5 = get('/api/rolepower/tree', {'roleId': rid})['data']
        bl2 = (get('/api/rolepower/buttons', {'roleId': rid}).get('data') or {})
        check('还原原始菜单与按钮授权（%d 项菜单 / %d 个按钮）'
              % (base_item_checked, len(keep_btns)),
              r.get('code') == 0 and t5['checked'] == base_item_checked
              and int(bl2.get('total') or 0) == len(keep_btns),
              '%s / %s vs %s' % (t5['checked'], bl2.get('total'), len(keep_btns)))

    # ===================== 员工信息归档 =====================
    print('\n--- 8l. 员工信息归档（empinfoarchive，UUID 主键 / 整表快照） ---')

    def archive_batches():
        return get('/api/emparchive/batches').get('data') or {'list': [], 'total': 0}

    emp_page = get('/api/emp/list', {'pageNum': 1, 'pageSize': 500}).get('data') or {}
    emp_rows = emp_page.get('list') or []
    emp_total = int(emp_page.get('total') or 0)
    check('员工表有可归档数据（%d 条）' % emp_total, emp_total > 0, str(emp_total))

    batches_before = archive_batches()
    before_count = len(batches_before.get('list') or [])

    r = post('/api/emparchive/archive', {})
    arc1 = r.get('data') or {}
    batch_id = arc1.get('batchId') or ''
    check('归档接口返回成功', r.get('code') == 0, str(r)[:160])
    check('归档返回批次ID为 UUID',
          bool(re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', str(batch_id))),
          str(batch_id))
    check('归档返回归档时间（YYYY-MM-DD HH:mm:ss）',
          bool(re.match(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$', str(arc1.get('archiveTime') or ''))),
          str(arc1.get('archiveTime')))
    check('归档条数 = 员工表总数（%d）' % emp_total, int(arc1.get('total') or 0) == emp_total,
          '%s / %s' % (arc1.get('total'), emp_total))

    b1 = archive_batches()
    check('批次列表新增 1 个批次', len(b1.get('list') or []) == before_count + 1,
          '%s → %s' % (before_count, len(b1.get('list') or [])))
    first = (b1.get('list') or [{}])[0]
    check('批次按归档时间倒序（最新在最前）', first.get('batchId') == batch_id, str(first))
    check('批次记录数与归档条数一致', int(first.get('total') or 0) == emp_total,
          '%s / %s' % (first.get('total'), emp_total))

    # 批次内的员工列表
    pg = get('/api/emparchive/list', {'batchId': batch_id, 'pageNum': 1, 'pageSize': 10}).get('data') or {}
    rows = pg.get('list') or []
    check('批次员工列表可查询', (pg.get('total') or 0) == emp_total, str(pg.get('total')))
    check('列表分页字段完整（pageNum/pageSize/pages）',
          pg.get('pageNum') == 1 and pg.get('pageSize') == 10 and pg.get('pages') >= 1, str(pg.get('pages')))
    check('归档记录按工号升序', [x.get('code') for x in rows] == sorted([x.get('code') for x in rows]),
          str([x.get('code') for x in rows])[:80])
    one = rows[0] if rows else {}
    check('归档记录带 UUID 主键与 empId（原员工ID）',
          bool(re.match(r'^[0-9a-f]{8}-', str(one.get('id')))) and int(one.get('empId') or 0) > 0,
          '%s / %s' % (one.get('id'), one.get('empId')))
    # 库里确实存在「档案字段留空（NULL）」的真实员工（如老员工只录了姓名/手机），
    # 所以不能要求这些字段非空：断言的是「归档快照把源员工这 18 个业务字段一个不少地照抄」。
    FIELD_KEYS = ('code', 'nameCn', 'gender', 'phone', 'email', 'deptId', 'jobTitle', 'status',
                  'hireDate', 'birthDate', 'idCard', 'education', 'school', 'major',
                  'certificates', 'titleName', 'photo', 'remark')
    src = get('/api/emp/detail', {'id': one.get('empId')}).get('data') or {}
    field_diff = [k for k in FIELD_KEYS if
                  str(one.get(k) if one.get(k) is not None else '') !=
                  str(src.get(k) if src.get(k) is not None else '')]
    check('归档记录保留员工表全部业务字段（与源员工逐字段一致）',
          bool(src) and not field_diff, 'diff=%s' % field_diff)
    check('归档记录带展示字段（部门名 / 状态文案 / 性别文案）',
          bool(one.get('deptName')) and one.get('statusText') in ('在职', '试用', '离职')
          and one.get('genderText') in ('男', '女'),
          '%s / %s / %s' % (one.get('deptName'), one.get('statusText'), one.get('genderText')))
    emp_first = emp_rows[0] if emp_rows else {}
    check('快照内容与当前员工表一致（首条工号 / 姓名相同）',
          one.get('code') == emp_first.get('code') and one.get('nameCn') == emp_first.get('nameCn'),
          '%s vs %s' % (one.get('code'), emp_first.get('code')))

    # 关键字过滤
    kw = str(one.get('nameCn') or '')
    pg2 = get('/api/emparchive/list',
              {'batchId': batch_id, 'pageNum': 1, 'pageSize': 10, 'keyword': kw}).get('data') or {}
    check('批次员工列表支持关键字过滤（%s）' % kw, (pg2.get('total') or 0) >= 1, str(pg2.get('total')))

    # 再次归档 → 新批次，历史批次不变
    r = post('/api/emparchive/archive', {})
    arc2 = r.get('data') or {}
    check('可重复归档（生成新批次）',
          r.get('code') == 0 and arc2.get('batchId') and arc2.get('batchId') != batch_id, str(arc2)[:120])
    b2 = archive_batches()
    check('两个批次互不影响（各自记录数正确）',
          len(b2.get('list') or []) == before_count + 2 and
          sorted([int(x.get('total') or 0) for x in (b2.get('list') or [])])[-2:] ==
          [emp_total, emp_total],
          str([(x.get('batchId')[:8], x.get('total')) for x in (b2.get('list') or [])]))
    pg3 = get('/api/emparchive/list', {'batchId': batch_id, 'pageNum': 1, 'pageSize': 10}).get('data') or {}
    check('旧批次数据未被新归档覆盖', (pg3.get('total') or 0) == emp_total, str(pg3.get('total')))

    # 非法入参
    r = get('/api/emparchive/list', {'batchId': 'abc'})
    check('非法 batchId 返回业务错误', r.get('code') != 0 and 'batchId' in (r.get('message') or ''), str(r)[:120])
    r = get('/api/emparchive/list', {})
    check('缺少 batchId 返回业务错误', r.get('code') != 0, str(r)[:120])
    r = get('/api/emparchive/notexist', {})
    check('归档模块未知接口返回 404', r.get('code') == 404, str(r)[:120])
    r = get('/api/emparchive/archive')
    check('归档接口只接受 POST（GET 被拒）', r.get('code') not in (0,), str(r)[:120])

    h = get('/api/health').get('data') or {}
    check('健康检查输出归档相关计数', 'empArchiveBatchCount' in h or 'empArchiveCount' in h, str(sorted(h.keys())))

    # ===================== 用户信息（useinfo） =====================
    print('\n--- 8m. 用户信息（useinfo，UUID 主键 / 账号=员工手机号 / 密码 MD5） ---')
    RE_UUID_T = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    MD5_888888 = '21218cca77804d2ba1922c33e0151105'

    hh = get('/api/health').get('data') or {}
    check('健康检查输出用户相关计数', 'userCount' in hh and 'userRoleCount' in hh, str(sorted(hh.keys())))

    ul = get('/api/useinfo/list', {'pageNum': 1, 'pageSize': 50}).get('data') or {}
    check('用户列表可访问', (ul.get('total') or 0) >= 1, str(ul.get('total')))
    u0 = (ul.get('list') or [{}])[0] if (ul.get('list') or []) else {}
    check('用户主键为 UUID', bool(RE_UUID_T.match(str(u0.get('id') or ''))), str(u0.get('id')))
    check('接口不返回密码与 token（只给掩码 / 是否已有 token）',
          'password' not in u0 and 'token' not in u0 and u0.get('passwordMask') == '******'
          and u0.get('hasToken') is not None,
          str([k for k in ('password', 'token') if k in u0]))
    check('用户记录带出员工信息（工号 / 姓名 / 部门）',
          bool(u0.get('empCode')) and bool(u0.get('empName')) and 'deptName' in u0,
          '%s / %s / %s' % (u0.get('empCode'), u0.get('empName'), u0.get('deptName')))
    check('账号默认取员工手机号', str(u0.get('account')) == str(u0.get('phone')),
          '%s vs %s' % (u0.get('account'), u0.get('phone')))
    check('列表按账号升序',
          [x.get('account') for x in (ul.get('list') or [])] ==
          sorted([x.get('account') for x in (ul.get('list') or [])]),
          str([x.get('account') for x in (ul.get('list') or [])])[:80])

    eo = get('/api/useinfo/empoptions', {}).get('data') or {}
    check('员工下拉可访问并带 hasUser 标记',
          (eo.get('total') or 0) >= 1 and all('hasUser' in e for e in (eo.get('list') or [])),
          str(eo.get('total')))
    eo2 = get('/api/useinfo/empoptions', {'noUser': 1}).get('data') or {}
    check('noUser=1 只返回还没有账号的员工',
          all(not e.get('hasUser') for e in (eo2.get('list') or [])),
          str([(e.get('code'), e.get('hasUser')) for e in (eo2.get('list') or [])]))

    # ---- 造两个临时员工，验证单个创建 / 批量创建 / 重置密码 / 批量设角色 ----
    stamp = str(int(time.time()))[-6:]
    tail = ('%08d' % int(stamp))
    temps = []
    for idx in (1, 2):
        code = 'E9%s%d' % (stamp[-4:], idx)
        phone = ('139' + tail)[:11]
        phone = phone[:-1] + str(idx)
        r = post('/api/emp/add', {
            'code': code, 'nameCn': '用户测试%d' % idx, 'gender': 1, 'phone': phone,
            'email': 'usertest%s%d@jiudou.com' % (stamp, idx), 'deptId': 0, 'status': 1})
        if r.get('code') == 0:
            temps.append(r.get('data') or {})
    check('创建 2 个临时员工成功', len(temps) == 2, str([t.get('code') for t in temps]))
    emp_a = temps[0] if temps else {}
    emp_b = temps[1] if len(temps) > 1 else {}

    # 单个创建：不传账号 → 默认员工手机号；密码 888888
    ra = post('/api/useinfo/add', {'empId': emp_a.get('id'), 'remark': '接口测试'})
    ua = ra.get('data') or {}
    check('新增用户成功且账号默认为员工手机号',
          ra.get('code') == 0 and str(ua.get('account')) == str(emp_a.get('phone')),
          str(ra)[:160])
    check('新增用户返回 UUID 主键与密码掩码',
          bool(RE_UUID_T.match(str(ua.get('id') or ''))) and ua.get('passwordMask') == '******',
          str(ua.get('id')))
    if ua.get('id'):
        ua_id = ua.get('id')
    else:
        ua_id = ''

    rb = post('/api/useinfo/add', {'empId': emp_a.get('id')})
    check('同一员工重复创建被拒绝', rb.get('code') != 0 and '已创建过' in (rb.get('message') or ''),
          str(rb.get('message'))[:80])

    rbad = post('/api/useinfo/add', {'empId': emp_b.get('id'), 'account': 'a b'})
    check('非法账号格式被拒绝', rbad.get('code') != 0 and '账号' in (rbad.get('message') or ''),
          str(rbad.get('message'))[:80])

    ck = get('/api/useinfo/check', {'field': 'account', 'value': str(ua.get('account') or '')}).get('data') or {}
    check('账号唯一性校验：已存在返回不唯一', ck.get('unique') is False, str(ck))
    ck2 = get('/api/useinfo/check', {'field': 'account', 'value': 'zz_no_such_account'}).get('data') or {}
    check('账号唯一性校验：不存在返回唯一', ck2.get('unique') is True, str(ck2))

    # 重置密码（返回 888888）
    rp = post('/api/useinfo/resetpwd', {'ids': [ua_id]}).get('data') or {}
    check('重置密码返回 888888 且命中 1 个用户',
          rp.get('password') == '888888' and int(rp.get('reset') or 0) == 1, str(rp))
    rp2 = post('/api/useinfo/resetpwd', {'ids': []})
    check('重置密码未选用户被拒绝', rp2.get('code') != 0, str(rp2.get('message'))[:60])

    # 批量设置角色
    roles_all = get('/api/role/list', {'pageNum': 1, 'pageSize': 50}).get('data', {}).get('list') or []
    role_ids = [roles_all[0]['id'], roles_all[1]['id']] if len(roles_all) >= 2 else []
    if ua_id and role_ids:
        rs = post('/api/useinfo/setroles', {'ids': [ua_id], 'roleIds': role_ids}).get('data') or {}
        check('批量设置角色成功（1 用户 2 角色）',
              int(rs.get('users') or 0) == 1 and int(rs.get('roles') or 0) == 2, str(rs))
        ud = get('/api/useinfo/detail', {'id': ua_id}).get('data') or {}
        check('详情回读角色（名称拼接 + roleIds）',
              len(ud.get('roles') or []) == 2 and '、' in str(ud.get('roleNames') or ''),
              str(ud.get('roleNames')))
        rs0 = post('/api/useinfo/setroles', {'ids': [ua_id], 'roleIds': []}).get('data') or {}
        ud0 = get('/api/useinfo/detail', {'id': ua_id}).get('data') or {}
        check('批量设置角色传空数组即清空角色',
              int(rs0.get('roles') or 0) == 0 and len(ud0.get('roles') or []) == 0, str(ud0.get('roles')))

    # 编辑：改账号 / 停用
    if ua_id:
        new_acc = 'utest%s' % stamp
        ru = post('/api/useinfo/update', {'id': ua_id, 'account': new_acc, 'enabled': 0}).get('data') or {}
        check('编辑账号与启用状态成功', ru.get('account') == new_acc and ru.get('enabled') is False,
              '%s / %s' % (ru.get('account'), ru.get('enabled')))
        ru2 = post('/api/useinfo/update', {'id': ua_id, 'account': str(u0.get('account') or 'x')})
        check('编辑成已存在账号被拒绝', ru2.get('code') != 0, str(ru2.get('message'))[:80])

    # 批量创建（初始密码 888888）：emp_b 尚未建号
    rc = post('/api/useinfo/batch', {'empIds': [emp_b.get('id')], 'roleIds': role_ids[:1]}).get('data') or {}
    check('批量创建成功 1 个且返回初始密码 888888',
          int(rc.get('created') or 0) == 1 and rc.get('password') == '888888', str(rc)[:160])
    rc2 = post('/api/useinfo/batch', {'empIds': [emp_a.get('id'), emp_b.get('id')]}).get('data') or {}
    check('批量创建自动跳过已有账号的员工（skipped 带原因）',
          int(rc2.get('created') or 0) == 0 and len(rc2.get('skipped') or []) >= 1
          and all('reason' in s for s in (rc2.get('skipped') or [])),
          str(rc2.get('skipped'))[:120])
    rc3 = post('/api/useinfo/batch', {'empIds': []})
    check('批量创建未选员工被拒绝', rc3.get('code') != 0, str(rc3.get('message'))[:60])

    # 清理：删除测试用户与临时员工
    del_ids = []
    ul2 = get('/api/useinfo/list', {'pageNum': 1, 'pageSize': 500}).get('data', {}).get('list') or []
    for one in ul2:
        if one.get('empId') in (emp_a.get('id'), emp_b.get('id')):
            del_ids.append(one['id'])
    rd = post('/api/useinfo/delete', {'ids': del_ids})
    check('批量删除用户成功（%d 个）' % len(del_ids),
          rd.get('code') == 0 and int((rd.get('data') or {}).get('deleted') or 0) == len(del_ids),
          str(rd.get('data')))
    for one in (emp_a, emp_b):
        if one.get('id'):
            post('/api/emp/delete', {'id': one.get('id')})
    gone = get('/api/useinfo/detail', {'id': ua_id}) if ua_id else {'code': 404}
    check('删除后用户详情不可访问（404）', gone.get('code') == 404, str(gone)[:100])

    # 异常入参
    r_ex1 = get('/api/useinfo/detail', {'id': 'abc'})
    check('非法用户 id 返回业务错误', r_ex1.get('code') != 0, str(r_ex1.get('message'))[:80])
    r_ex2 = get('/api/useinfo/list', {'enabled': 'x'})
    check('非法启用状态不报 500（按停用处理）', r_ex2.get('code') == 0, str(r_ex2)[:100])
    r_ex3 = post('/api/useinfo/setroles', {'ids': ['00000000-0000-4000-8000-000000000000'],
                                          'roleIds': ['11111111-1111-4111-8111-111111111111']})
    check('不存在的角色被拒绝', r_ex3.get('code') != 0, str(r_ex3.get('message'))[:80])
    r_ex4 = get('/api/useinfo/notexist', {})
    check('用户模块未知接口返回 404', r_ex4.get('code') == 404, str(r_ex4)[:100])

    # ===================== 登录认证（auth） =====================
    print('\n--- 8n. 登录认证（auth：验证码 + 账号 + MD5 密码 → token） ---')

    def solve_captcha():
        """取一道验证码并算出答案，返回 (captchaId, 答案字符串)"""
        c = get('/api/auth/captcha').get('data') or {}
        question = str(c.get('question') or '')
        m = re.match(r'^(\d+)\s+([+\-\u00d7])\s+(\d+)\s*=\s*\?$', question)
        if not m:
            return str(c.get('captchaId') or ''), ''
        a, op, b = int(m.group(1)), m.group(2), int(m.group(3))
        answer = a + b if op == '+' else (a - b if op == '-' else a * b)
        return str(c.get('captchaId') or ''), str(answer)

    def do_login(account, password):
        cid, answer = solve_captcha()
        res = post('/api/auth/login', {'account': account, 'password': password,
                                       'captchaId': cid, 'captchaCode': answer})
        # 登录会刷新该用户的 token：同步到全局，后续接口自动带新 token
        if res.get('code') == 0 and (res.get('data') or {}).get('token'):
            TOKEN['value'] = str(res['data']['token'])
        return res

    # ---- 验证码本身 ----
    cap = get('/api/auth/captcha').get('data') or {}
    check('验证码接口返回 captchaId / 题目 / 有效期',
          bool(cap.get('captchaId')) and bool(re.match(r'^\d+\s+[+\-\u00d7]\s+\d+\s*=\s*\?$',
                                                      str(cap.get('question') or '')))
          and int(cap.get('expireIn') or 0) > 0,
          '%s / %s' % (cap.get('captchaId'), cap.get('question')))
    check('验证码响应不含答案字段', 'answer' not in cap and 'result' not in cap, str(sorted(cap.keys())))
    cap2 = get('/api/auth/captcha').get('data') or {}
    check('每次取题的 captchaId 都不同', cap2.get('captchaId') != cap.get('captchaId'),
          '%s / %s' % (str(cap.get('captchaId'))[:8], str(cap2.get('captchaId'))[:8]))

    ul3 = get('/api/useinfo/list', {'pageNum': 1, 'pageSize': 50}).get('data') or {}
    # 管理员可能已经自助改过密码，这里挑出「用初始密码 888888 仍能登录」的账号来跑登录用例
    loginable = []
    for u in (ul3.get('list') or []):
        acc = str(u.get('account') or '')
        if not acc or acc in loginable:
            continue
        if try_login(acc, '888888'):
            loginable.append(acc)
    if not loginable:
        loginable = all_accounts()[:1]
    login_user = {}
    for u in (ul3.get('list') or []):
        if str(u.get('account') or '') == loginable[0]:
            login_user = u
            break
    account = str(login_user.get('account') or loginable[0])
    login_for_token(account)          # 用这个账号的 token 继续后面的用例
    print('    （登录用例使用账号：%s）' % account)

    r = post('/api/auth/login', {'account': account, 'password': '888888'})
    check('不带验证码登录被拒绝', r.get('code') != 0 and '请输入验证码' in (r.get('message') or ''), str(r)[:120])

    cid_tmp, _ans = solve_captcha()
    r = post('/api/auth/login', {'account': account, 'password': '888888',
                                 'captchaId': cid_tmp, 'captchaCode': '999'})
    check('验证码答案错误被拒绝', r.get('code') != 0 and '验证码不正确' in (r.get('message') or ''), str(r)[:120])
    r = post('/api/auth/login', {'account': account, 'password': '888888',
                                 'captchaId': cid_tmp, 'captchaCode': '0'})
    check('验证码一次性：错误后同一 captchaId 立即作废',
          r.get('code') != 0 and '失效' in (r.get('message') or ''), str(r)[:120])
    r = post('/api/auth/login', {'account': account, 'password': '888888',
                                 'captchaId': 'not-exist-id', 'captchaCode': '1'})
    check('未知 captchaId 被拒绝', r.get('code') != 0 and '失效' in (r.get('message') or ''), str(r)[:120])

    # ---- 正常登录 ----
    r = do_login(account, '888888')
    lg = r.get('data') or {}
    token = str(lg.get('token') or '')
    check('验证码 + 正确密码登录成功', r.get('code') == 0, str(r)[:160])
    check('token 为 32 位十六进制', bool(re.match(r'^[0-9a-f]{32}$', token)), token[:12])
    check('返回登录时间（YYYY-MM-DD HH:mm:ss）与客户端IP',
          bool(re.match(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$', str(lg.get('loginTime') or '')))
          and bool(lg.get('loginIp')), '%s / %s' % (lg.get('loginTime'), lg.get('loginIp')))
    lu = lg.get('user') or {}
    check('返回登录用户信息（员工姓名 / 部门 / 角色）',
          bool(lu.get('empName')) and 'deptName' in lu and 'roles' in lu,
          '%s / %s' % (lu.get('empName'), lu.get('roleNames')))
    check('登录响应不泄露密码 / token 字段以外的敏感信息',
          'password' not in lu and 'token' not in lu, str([k for k in ('password', 'token') if k in lu]))

    r = get('/api/auth/me', {'token': token})
    check('按 token 可反查当前登录用户', r.get('code') == 0 and (r.get('data') or {}).get('account') == account,
          str(r)[:120])
    r = get('/api/auth/me', {'token': 'x' * 32})
    check('无效 token 返回 401', r.get('code') == 401, str(r)[:120])

    # 用登录 token 取导航：应只含该用户角色被授权的菜单
    nav_token = (get('/api/nav', {'token': token}).get('data') or {})
    check('带 token 取导航成功并按角色过滤（scope=token）',
          nav_token.get('code') is None and nav_token.get('scope') == 'token'
          and bool(nav_token.get('roleIds')),
          str(sorted(nav_token.keys()))[:120])
    hit_role_items = nav_flat_items(nav_token)
    admin_set = set((g, i) for (g, i, _c, _n) in admin_items)
    check('token 导航的菜单项都在该角色授权范围内',
          all((g, i) in admin_set for (g, i, _c, _n) in hit_role_items) or not hit_role_items,
          '%d items' % len(hit_role_items))

    after = get('/api/useinfo/list', {'keyword': account, 'pageSize': 10}).get('data', {}).get('list') or []
    hit = after[0] if after else {}
    check('登录成功后回写最近登录时间与客户端IP',
          bool(hit.get('lastLoginTime')) and bool(hit.get('lastLoginIp')),
          '%s / %s' % (hit.get('lastLoginTime'), hit.get('lastLoginIp')))
    check('登录后该用户标记为「已有 token」', hit.get('hasToken') is True, str(hit.get('hasToken')))

    r = post('/api/auth/logout', {'token': token})
    check('退出登录成功', r.get('code') == 0, str(r)[:100])
    r = get('/api/auth/me', {'token': token})
    check('退出后 token 立即失效（401）', r.get('code') == 401, str(r)[:120])
    login_for_token(account)          # 退出后重新登录，后续接口继续带新 token

    # ---- 账号密码错误（验证码每次都重新取） ----
    r = do_login(account, 'wrong-pwd')
    check('密码错误被拒绝且提示「账号或密码不正确」',
          r.get('code') != 0 and '账号或密码不正确' in (r.get('message') or ''), str(r)[:120])
    r = do_login('no_such_account_x', '888888')
    check('账号不存在同样提示「账号或密码不正确」',
          r.get('code') != 0 and '账号或密码不正确' in (r.get('message') or ''), str(r)[:120])
    cid_a, ans_a = solve_captcha()
    r = post('/api/auth/login', {'password': '888888', 'captchaId': cid_a, 'captchaCode': ans_a})
    check('缺少账号被拒绝', r.get('code') != 0 and '请输入登录账号' in (r.get('message') or ''), str(r)[:120])
    cid_b, ans_b = solve_captcha()
    r = post('/api/auth/login', {'account': account, 'captchaId': cid_b, 'captchaCode': ans_b})
    check('缺少密码被拒绝', r.get('code') != 0 and '请输入登录密码' in (r.get('message') or ''), str(r)[:120])

    # 停用账号不可登录（用另一个用户，避免把当前登录会话自身停掉）
    _others = [u for u in (ul3.get('list') or [])
               if str(u.get('account')) in loginable and str(u.get('account')) != account]
    other_u = _others[0] if _others else None
    if other_u and other_u.get('id'):
        other_acc = str(other_u.get('account') or '')
        post('/api/useinfo/update', {'id': other_u['id'], 'enabled': 0})
        r = do_login(other_acc, '888888')
        check('停用账号登录被拒绝（提示已停用）',
              r.get('code') != 0 and '停用' in (r.get('message') or ''), str(r)[:120])
        post('/api/useinfo/update', {'id': other_u['id'], 'enabled': 1})
        r2 = do_login(other_acc, '888888')
        check('恢复启用后可正常登录', r2.get('code') == 0, str(r2)[:120])
        post('/api/auth/logout', {'token': (r2.get('data') or {}).get('token') or ''})
        login_for_token(account)     # 回到管理员 token

    r = get('/api/auth/notexist', {})
    check('认证模块未知接口返回 404', r.get('code') == 404, str(r)[:100])

    # ===================== 全接口登录校验 =====================
    print('\n--- 8o. 所有数据接口必须带登录 token ---')
    protected = [
        ('/api/menu/list', {'pageNum': 1}),
        ('/api/menu/detail', {'id': 1}),
        ('/api/group/list', {'pageNum': 1}),
        ('/api/group/tree', {}),
        ('/api/groupitem/list', {'groupId': 1}),
        ('/api/org/list', {'pageNum': 1}),
        ('/api/emp/list', {'pageNum': 1}),
        ('/api/dptmgr/list', {}),
        ('/api/role/list', {'pageNum': 1}),
        ('/api/rolepower/tree', {'roleId': ADMIN_ROLE_ID}),
        ('/api/rolepower/buttons', {'roleId': ADMIN_ROLE_ID}),
        ('/api/pageopbtn/list', {}),
        ('/api/emparchive/batches', {}),
        ('/api/useinfo/list', {}),
        ('/api/useinfo/empoptions', {}),
        ('/api/auth/me', {}),
        ('/api/nav', {}),
    ]
    bad_ones = []
    for path, params in protected:
        r = get(path, params, False)
        if r.get('code') != 401:
            bad_ones.append('%s→%s' % (path, r.get('code')))
    check('无 token 访问 %d 个数据接口全部返回 401' % len(protected), not bad_ones, str(bad_ones)[:160])

    r = post('/api/menu/list', {'pageNum': 1}, False)
    check('无 token 的 POST 同样被拒绝（401）', r.get('code') == 401, str(r)[:120])

    # 写操作：无 token 必须被挡在写库之前
    before_total = int((get('/api/menu/list', {'pageNum': 1, 'pageSize': 1}).get('data') or {}).get('total') or 0)
    r = post('/api/menu/add', {'code': 'MNU_NOAUTH_TMP', 'nameCn': '未授权新增', 'nameEn': 'NoAuthTmp',
                               'path': 'noauth.html'}, False)
    after_total = int((get('/api/menu/list', {'pageNum': 1, 'pageSize': 1}).get('data') or {}).get('total') or 0)
    check('无 token 的新增被拒绝且没有写库（%d → %d）' % (before_total, after_total),
          r.get('code') == 401 and before_total == after_total, '%s / %s' % (r.get('code'), after_total))

    # 免登录白名单：验证码 + 登录本身
    r = get('/api/auth/captcha', None, False)
    check('取验证码不需要 token（登录前置）',
          r.get('code') == 0 and bool((r.get('data') or {}).get('captchaId')), str(r)[:100])
    cid_ok, ans_ok = _solve_captcha()
    r = request('POST', '/api/auth/login',
                {'account': account, 'password': '888888',
                 'captchaId': cid_ok, 'captchaCode': ans_ok}, auth=False)
    check('登录接口不需要 token 即可调用', r.get('code') == 0 and bool((r.get('data') or {}).get('token')),
          str(r)[:120])
    if (r.get('data') or {}).get('token'):
        TOKEN['value'] = str(r['data']['token'])      # 登录会刷新 token，同步后再继续后面的用例

    # 健康检查：未登录不查库（只回服务存活），带 token 才给条数
    r = get('/api/health', None, False)
    hd = r.get('data') or {}
    check('未登录访问 health 只回服务存活、不暴露条数',
          r.get('code') == 0 and hd.get('authenticated') is False and 'empCount' not in hd,
          str(sorted(hd.keys()))[:120])
    r = get('/api/health')
    hd2 = r.get('data') or {}
    check('带 token 访问 health 返回各表条数', hd2.get('authenticated') is True and 'empCount' in hd2,
          str(sorted(hd2.keys()))[:120])

    # 请求头方式（X-Token）同样被认可
    try:
        req = urllib.request.Request(BASE + '/api/menu/list?pageNum=1&pageSize=1',
                                     headers={'X-Token': TOKEN['value']}, method='GET')
        with urllib.request.urlopen(req, timeout=10) as resp:
            hres = json.loads(resp.read().decode('utf-8'))
    except Exception as exc:
        hres = {'code': -1, 'message': str(exc)}
    check('请求头 X-Token 方式同样通过校验', hres.get('code') == 0, str(hres)[:120])

    # 停用账号：其 token 立即失效（用另一个用户验证，避免影响当前会话）
    admin_token = TOKEN['value']
    _off_rows = (get('/api/useinfo/list', {'pageNum': 1, 'pageSize': 50}).get('data') or {}).get('list') or []
    off_user = _off_rows[-1] if _off_rows else None
    if off_user and off_user.get('id'):
        off_token = login_for_token(str(off_user.get('account') or ''))
        check('被测用户登录成功（准备停用）', bool(off_token), str(off_user.get('account')))
        post('/api/useinfo/update', {'id': off_user['id'], 'enabled': 0, 'token': off_token})
        r = get('/api/menu/list', {'pageNum': 1, 'pageSize': 1, 'token': off_token})
        check('账号停用后其 token 立即失效（401）', r.get('code') == 401, str(r)[:100])
        post('/api/useinfo/update', {'id': off_user['id'], 'enabled': 1, 'token': admin_token})
        TOKEN['value'] = admin_token
        r = get('/api/menu/list', {'pageNum': 1, 'pageSize': 1})
        check('恢复启用后管理员 token 仍可用', r.get('code') == 0, str(r)[:100])

    # ---------- 8.1 单点登录：token 全局共享 + 有效期 8 小时 ----------
    print('\n--- 8.1 单点登录令牌（有效期默认 8 小时） ---')
    login_account = loginable_account()
    cid_t, ans_t = _solve_captcha()
    r = request('POST', '/api/auth/login',
                {'account': login_account, 'password': '888888',
                 'captchaId': cid_t, 'captchaCode': ans_t}, auth=False)
    td = r.get('data') or {}
    check('登录返回令牌有效期：默认 8 小时 = 28800 秒',
          int(td.get('expireIn') or 0) == 28800 and abs(float(td.get('ttlHours') or 0) - 8.0) < 1e-6,
          'expireIn=%s ttlHours=%s' % (td.get('expireIn'), td.get('ttlHours')))
    check('登录返回过期时间点（YYYY-MM-DD HH:MM:SS）',
          bool(re.match(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$', str(td.get('expireTime') or ''))),
          str(td.get('expireTime')))
    check('登录返回体中不再包含 token 字段（用户详情不泄露令牌）',
          'token' not in (td.get('user') or {}), str(sorted((td.get('user') or {}).keys()))[:120])
    sso_token = str(td.get('token') or '')
    TOKEN['value'] = sso_token or TOKEN['value']

    # 同一 token 可同时访问多个接口 = 全局共享（框架页 + 各 iframe 子页共用一份登录态）
    share_ok = all([
        get('/api/menu/list', {'pageNum': 1, 'pageSize': 1, 'token': sso_token}).get('code') == 0,
        get('/api/emp/list', {'pageNum': 1, 'pageSize': 1, 'token': sso_token}).get('code') == 0,
        get('/api/nav', {'token': sso_token}).get('code') == 0,
        get('/api/auth/me', {'token': sso_token}).get('code') == 0,
    ])
    check('同一 token 可同时被框架页与各功能页使用（全局共享）', share_ok)

    me_data = get('/api/auth/me', {'token': sso_token}).get('data') or {}
    check('auth/me 返回剩余有效期 expireIn（0 < 剩余 <= 28800）',
          0 < int(me_data.get('expireIn') or 0) <= 28800,
          'expireIn=%s / expireTime=%s' % (me_data.get('expireIn'), me_data.get('expireTime')))

    try:
        import datetime as _dt
        import os
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from db import execute as _exec, query_one as _one

        db_row = _one('SELECT `tokenExpireTime`, `lastLoginTime` FROM `useinfo` WHERE `token`=%s',
                      (sso_token,))
        diff = None
        if db_row and db_row.get('tokenExpireTime') and db_row.get('lastLoginTime'):
            fmt = '%Y-%m-%d %H:%M:%S'
            diff = (_dt.datetime.strptime(str(db_row['tokenExpireTime']), fmt) -
                    _dt.datetime.strptime(str(db_row['lastLoginTime']), fmt)).total_seconds()
        check('库中 tokenExpireTime = 登录时间 + 8 小时',
              diff is not None and abs(diff - 28800) <= 5, 'diff=%s' % diff)

        # 手工把过期时间改成「1 秒前」→ 等价于登录满 8 小时后继续操作
        _exec('UPDATE `useinfo` SET `tokenExpireTime`=DATE_SUB(NOW(), INTERVAL 1 SECOND) '
              'WHERE `token`=%s', (sso_token,))
        r = get('/api/menu/list', {'pageNum': 1, 'pageSize': 1, 'token': sso_token})
        check('token 超过有效期后接口返回 401', r.get('code') == 401, str(r)[:120])
        check('超时提示明确为「登录已超时（有效期 8 小时）」',
              '超时' in (r.get('message') or '') and '8' in (r.get('message') or ''),
              str(r.get('message')))
        after = _one('SELECT `token`, `tokenExpireTime` FROM `useinfo` WHERE `account`=%s', (login_account,))
        check('超时 token 被服务端作废（token 置空，必须重新登录）',
              after is not None and not after.get('token'), str(after))
        r = get('/api/nav', {'token': sso_token})
        check('超时后导航接口同样返回 401（子页与框架页行为一致）', r.get('code') == 401, str(r)[:100])
    except ImportError as exc:
        check('直连数据库校验 token 有效期', False, str(exc))

    fresh_token = login_for_token(login_account)
    check('超时后重新登录可获得新 token（旧 token 不可复用）',
          bool(fresh_token) and fresh_token != sso_token, str(fresh_token)[:12])

    # ---------- 8.2 服务信箱（serviceemail）与邮箱助手（mail） ----------
    print('\n--- 8.2 服务信箱与邮箱助手 ---')
    # serviceemail 是**单例表**（全表只允许一条记录），而这里要测「首次新增 / 第二次被拒」，
    # 所以先把既有配置原样备份到内存（含加密后的密码与启用状态），临时清空表，
    # 结束后再按原 id 写回 —— 既有记录不丢、聊天记录（serviceemailmsg.serviceEmailId）也不会变成孤儿。
    pre = get('/api/serviceemail/list', {'pageNum': 1, 'pageSize': 200}).get('data') or {}
    pre_rows = pre.get('list') or []
    raw_backup = []
    _db_exec = None
    try:
        import os as _os_se
        sys.path.insert(0, _os_se.path.dirname(_os_se.path.abspath(__file__)))
        from db import query_all as _db_all, execute as _db_exec  # noqa: F401
        raw_backup = _db_all('SELECT * FROM `serviceemail`') or []
        _db_exec('DELETE FROM `serviceemail`')
    except Exception as exc:
        print('  [WARN] 无法直连数据库备份既有服务信箱：%s' % exc)

    first = get('/api/serviceemail/list', {'pageNum': 1, 'pageSize': 10})
    check('服务信箱列表接口可用', first.get('code') == 0 and isinstance(first.get('data'), dict),
          str(first)[:100])
    if _db_exec is not None:
        fd = first.get('data') or {}
        check('表已清空：列表为空（无记录 = 前端弹窗走新增）',
              int(fd.get('total') or 0) == 0 and not fd.get('list'), str(fd.get('total')))

    r = post('/api/serviceemail/add', {'email': 'service.api@qq.com', 'password': 'auth-code-1',
                                       'displayName': '接口测试信箱', 'enabled': 1, 'remark': '联调用'})
    sd = r.get('data') or {}
    se1 = str(sd.get('id') or '')
    check('新增服务信箱（启用）成功', r.get('code') == 0 and bool(se1), str(r)[:120])
    check('返回里不含 password 字段（密码只进不出）', 'password' not in sd, str(sorted(sd.keys()))[:120])
    check('返回只给 passwordMask / hasPassword',
          sd.get('passwordMask') == '******' and sd.get('hasPassword') is True,
          '%s / %s' % (sd.get('passwordMask'), sd.get('hasPassword')))
    check('QQ 邮箱自动推断收件/发件服务器',
          sd.get('imapHostText') == 'imap.qq.com' and int(sd.get('imapPortText') or 0) == 993
          and sd.get('smtpHostText') == 'smtp.qq.com' and int(sd.get('smtpPortText') or 0) == 465,
          '%s:%s / %s:%s' % (sd.get('imapHostText'), sd.get('imapPortText'),
                             sd.get('smtpHostText'), sd.get('smtpPortText')))
    check('新增时启用 → 成为当前启用的服务信箱',
          bool(sd.get('enabled')) and sd.get('email') == 'service.api@qq.com', str(sd.get('enabled')))

    r2 = post('/api/serviceemail/add', {'email': 'service.backup@163.com', 'password': 'auth-code-2',
                                        'enabled': 1})
    check('单例表：已有记录时新增第二条被拒绝',
          r2.get('code') != 0 and '一条' in (r2.get('message') or ''), str(r2.get('message'))[:120])
    lst = get('/api/serviceemail/list', {'pageNum': 1, 'pageSize': 10}).get('data') or {}
    check('被拒绝后表里仍然只有 1 条记录', int(lst.get('total') or 0) == 1, str(lst.get('total')))
    check('列表返回 enabledEmail 指向当前启用记录',
          lst.get('enabledEmail') == 'service.api@qq.com', str(lst.get('enabledEmail')))

    r = post('/api/serviceemail/add', {'email': 'service.api@qq.com', 'password': 'x'})
    check('重复邮箱被拒绝', r.get('code') != 0 and '已存在' in (r.get('message') or ''), str(r.get('message')))
    r = post('/api/serviceemail/add', {'email': 'no-password@qq.com'})
    check('密码为空被拒绝', r.get('code') != 0 and '密码' in (r.get('message') or ''), str(r.get('message')))
    r = post('/api/serviceemail/add', {'email': 'bad-email', 'password': 'x'})
    check('邮箱格式非法被拒绝', r.get('code') != 0 and '格式' in (r.get('message') or ''), str(r.get('message')))
    r = post('/api/serviceemail/add', {'email': 'port.test@qq.com', 'password': 'x', 'imapPort': '99999'})
    check('端口越界被拒绝', r.get('code') != 0 and '端口' in (r.get('message') or ''), str(r.get('message')))
    check('校验先于单例判断：报错仍然是「格式 / 密码 / 端口」而不是「只允许一条」',
          all(x not in (r.get('message') or '') for x in ('只允许一条',)), str(r.get('message'))[:80])
    r = get('/api/serviceemail/check', {'field': 'email', 'value': 'service.api@qq.com'})
    check('邮箱唯一性校验接口可用（自己占用了这个邮箱 → unique=false）',
          r.get('code') == 0 and (r.get('data') or {}).get('unique') is False, str(r)[:100])
    r = get('/api/serviceemail/check', {'field': 'email', 'value': 'service.api@qq.com', 'id': se1})
    check('唯一性校验排除自己（编辑自己时 unique=true）',
          r.get('code') == 0 and (r.get('data') or {}).get('unique') is True, str(r)[:100])

    r = post('/api/serviceemail/enabled', {'id': se1, 'enabled': 0})
    check('停用服务信箱成功', r.get('code') == 0 and not (r.get('data') or {}).get('enabled'), str(r)[:100])
    lst = get('/api/serviceemail/list', {'pageNum': 1, 'pageSize': 10}).get('data') or {}
    check('停用后 enabledEmail 为空（表里那一条还在）',
          int(lst.get('total') or 0) == 1 and not lst.get('enabledEmail'), str(lst.get('enabledEmail')))

    r = post('/api/serviceemail/update', {'id': se1, 'displayName': '改过的名称', 'password': ''})
    ud = r.get('data') or {}
    check('编辑服务信箱（密码留空）成功', r.get('code') == 0 and ud.get('displayName') == '改过的名称',
          str(ud.get('displayName')))
    check('密码留空时仍保留原密码', ud.get('hasPassword') is True, str(ud.get('hasPassword')))
    check('编辑不会变成第二条记录', int((get('/api/serviceemail/list',
                                          {'pageNum': 1, 'pageSize': 10}).get('data') or {}).get('total') or 0) == 1)

    # 邮箱助手：状态 / 列表 / 参数校验（不触发真实网络收发）
    st = get('/api/mail/status').get('data') or {}
    check('未启用任何服务信箱时 status.configured=false', st.get('configured') is False, str(st.get('configured')))
    check('status 引导文案指向右上角「设置」按钮', '设置' in str(st.get('message')), str(st.get('message')))
    r = get('/api/mail/list', {'folder': 'inbox'})
    check('未启用服务信箱时邮件列表返回业务错误', r.get('code') != 0 and '服务信箱' in (r.get('message') or ''),
          str(r.get('message')))
    r = post('/api/mail/sync', {})
    check('未启用服务信箱时收件返回业务错误', r.get('code') != 0 and '服务信箱' in (r.get('message') or ''),
          str(r.get('message')))
    r = post('/api/mail/send', {'to': 'a@b.com', 'subject': 's', 'body': 'b'})
    check('未启用服务信箱时发信返回业务错误', r.get('code') != 0 and '服务信箱' in (r.get('message') or ''),
          str(r.get('message')))

    post('/api/serviceemail/enabled', {'id': se1, 'enabled': 1})
    st = get('/api/mail/status').get('data') or {}
    check('启用后 status.configured=true 且带收件服务器信息',
          st.get('configured') is True and (st.get('servers') or {}).get('imapHost') == 'imap.qq.com',
          str(st.get('servers')))
    r = post('/api/mail/send', {'subject': 's', 'body': 'b'})
    check('发信缺少收件人被拒绝', r.get('code') != 0 and '收件人' in (r.get('message') or ''), str(r.get('message')))
    r = post('/api/mail/send', {'to': 'not-an-email', 'subject': 's', 'body': 'b'})
    check('收件人格式非法被拒绝', r.get('code') != 0 and '格式' in (r.get('message') or ''), str(r.get('message')))
    r = post('/api/mail/send', {'to': 'a@b.com', 'body': 'b'})
    check('发信缺少主题被拒绝', r.get('code') != 0 and '主题' in (r.get('message') or ''), str(r.get('message')))
    r = post('/api/mail/send', {'to': 'a@b.com', 'subject': 's'})
    check('发信缺少正文被拒绝', r.get('code') != 0 and '正文' in (r.get('message') or ''), str(r.get('message')))
    r = post('/api/mail/mark', {})
    check('标记已读需要先选择邮件', r.get('code') != 0 and '选择' in (r.get('message') or ''), str(r.get('message')))
    r = post('/api/mail/delete', {'id': 'not-a-uuid'})
    check('删除邮件校验 UUID', r.get('code') != 0 and 'id' in (r.get('message') or ''), str(r.get('message')))
    r = get('/api/mail/detail', {'id': '11111111-1111-4111-8111-111111111111'})
    check('读取不存在的邮件返回 404', r.get('code') == 404, str(r)[:100])

    # ---------- 8.2.1 写邮件附件：参数校验（全部在连 SMTP 之前拦掉，不会真的发信） ----------
    print('\n--- 8.2.1 写邮件附件（校验 + MIME 组装） ---')
    import base64 as _b64

    def b64_of(data):
        return _b64.b64encode(data).decode('ascii')

    def send_with(attachments, **extra):
        payload = {'to': 'a@b.com', 'subject': '附件测试', 'body': '正文'}
        payload.update(extra)
        payload['attachments'] = attachments
        return post('/api/mail/send', payload)

    too_many = [{'name': 'f%d.txt' % i, 'data': b64_of(b'x')} for i in range(6)]
    r = send_with(too_many)
    check('附件数量超过 5 个被拒绝',
          r.get('code') != 0 and '最多只能添加 5 个附件' in (r.get('message') or ''), str(r.get('message')))
    r = send_with([{'name': '空文件.txt', 'data': ''}])
    check('附件内容为空被拒绝',
          r.get('code') != 0 and '内容为空' in (r.get('message') or ''), str(r.get('message')))
    r = send_with([{'name': 'bad.txt', 'data': '!!!!'}])
    check('附件内容不是合法 base64 被拒绝',
          r.get('code') != 0 and '解析失败' in (r.get('message') or ''), str(r.get('message')))
    r = send_with([{'name': '', 'data': b64_of(b'x')}])
    check('附件缺少文件名被拒绝',
          r.get('code') != 0 and '文件名' in (r.get('message') or ''), str(r.get('message')))
    r = send_with('not-a-json')
    check('附件参数不是数组被拒绝',
          r.get('code') != 0 and '附件参数格式不正确' in (r.get('message') or ''), str(r.get('message')))
    big = b64_of(b'x' * (11 * 1024 * 1024))
    r = send_with([{'name': '大文件.bin', 'data': big}])
    check('单个附件超过 10 MB 被拒绝',
          r.get('code') != 0 and '超出单个附件上限' in (r.get('message') or ''), str(r.get('message')))

    # 离线单测：附件解析规则 + MIME 组装（不连网络，直接调用服务层）
    try:
        import os as _os
        import email as email_module
        sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
        from service import MailService, BizError
        import mail_client

        svc = MailService()
        parsed = svc._attachments([{
            'name': 'C:\\fakepath\\报价单 2026.xlsx', 'size': 3,
            'type': 'application/vnd.ms-excel',
            'data': 'data:application/vnd.ms-excel;base64,' + b64_of(b'abc')
        }])
        check('附件解析：去掉浏览器带的本地路径', parsed and parsed[0]['name'] == '报价单 2026.xlsx',
              str([one.get('name') for one in parsed]))
        check('附件解析：data URL 前缀可识别且解出原始字节',
              parsed and parsed[0]['data'] == b'abc' and parsed[0]['size'] == 3,
              str(parsed[0]['data'] if parsed else None))
        check('附件解析：留空即为无附件', svc._attachments(None) == [] and svc._attachments('') == [])
        check('附件大小转人话（B / KB / MB）',
              svc._size_text(512) == '512 B' and svc._size_text(2048) == '2.0 KB'
              and svc._size_text(3 * 1024 * 1024) == '3.0 MB',
              '%s / %s' % (svc._size_text(2048), svc._size_text(3 * 1024 * 1024)))
        try:
            svc._attachments([{'name': 'a.txt', 'data': b64_of(b'x')}] * 6)
            check('附件数量超限在服务层被拒绝', False, '没有抛 BizError')
        except BizError as exc:
            check('附件数量超限在服务层被拒绝', '最多只能添加 5 个附件' in exc.message, exc.message)

        msg = mail_client.build_message('service@jiudou.com', '九豆服务信箱', ['a@b.com'], ['c@d.com'],
                                        '月度服务报告', '第一行\n第二行',
                                        [{'name': '报价单.xlsx', 'data': b'PK\x03\x04abc'},
                                         {'name': '说明.txt', 'data': '中文内容'.encode('utf-8'),
                                          'contentType': 'text/plain'}])
        names = [p.get_filename() for p in msg.walk() if p.get_filename()]
        check('带附件时邮件结构为 multipart/mixed', msg.get_content_type() == 'multipart/mixed',
              msg.get_content_type())
        check('附件（含中文名）正确挂到 MIME 上', names == ['报价单.xlsx', '说明.txt'], str(names))
        text_parts = [p for p in msg.walk() if p.get_content_type() == 'text/plain'
                      and not p.get_filename()]
        check('带附件时正文仍保留纯文本段落', len(text_parts) == 1, str(len(text_parts)))
        dumps = [p.get_filename() for p in email_module.message_from_string(msg.as_string()).walk()
                 if p.get_filename()]
        check('邮件序列化再解析后附件名不乱码', dumps == ['报价单.xlsx', '说明.txt'], str(dumps))
        no_attach = mail_client.build_message('s@d.com', '', ['a@b.com'], [], 't', 'b')
        check('不带附件时仍是 multipart/alternative（兼容旧行为）',
              no_attach.get_content_type() == 'multipart/alternative', no_attach.get_content_type())
    except Exception as exc:
        check('附件离线用例执行异常：%s' % exc, False, '请检查 service.py / mail_client.py 的导入')

    post('/api/serviceemail/delete', {'id': se1})
    after = get('/api/serviceemail/list', {'pageNum': 1, 'pageSize': 200}).get('data') or {}
    left_emails = [str(x.get('email') or '').lower() for x in (after.get('list') or [])]
    check('测试数据已清理（service.api@qq.com 已删除）',
          'service.api@qq.com' not in left_emails, ','.join(left_emails)[:120])

    # 把既有配置原样写回（同一个 id + 同一份加密密码 + 原启用状态）→ 既有邮件不会变成孤儿
    if raw_backup and _db_exec is not None:
        restored = 0
        for raw in raw_backup:
            cols = [c for c in raw.keys() if c not in ('enabledFlag', 'singleFlag')]   # 生成列不能显式赋值
            try:
                _db_exec('INSERT INTO `serviceemail` (%s) VALUES (%s)'
                         % (','.join('`%s`' % c for c in cols), ','.join(['%s'] * len(cols))),
                         [raw[c] for c in cols])
                restored += 1
            except Exception as exc:
                print('  [WARN] 还原既有服务信箱失败：%s' % exc)
        got = get('/api/serviceemail/list', {'pageNum': 1, 'pageSize': 200}).get('data') or {}
        got_rows = got.get('list') or []
        check('既有服务信箱已原样还原（邮箱 / 启用状态 / id 都不变）',
              restored == len(raw_backup)
              and sorted(str(x.get('email')) for x in got_rows) == sorted(str(x.get('email')) for x in pre_rows)
              and [bool(x.get('enabled')) for x in got_rows] == [bool(x.get('enabled')) for x in pre_rows],
              '还原 %s 条 / 现有 %s 条' % (restored, len(got_rows)))
        if pre_rows:
            again = post('/api/serviceemail/add', {'email': 'probe.extra@qq.com', 'password': 'x'})
            check('还原后单例约束仍然生效（再加一条依旧被拒绝）',
                  again.get('code') != 0 and '一条' in (again.get('message') or ''),
                  str(again.get('message'))[:100])

    # ===================== 8.3 员工通讯录（只读） =====================
    print('\n--- 8.3 员工通讯录（只读：树 + 列表） ---')
    tree = get('/api/addressbook/tree')
    td = tree.get('data') or {}
    check('通讯录部门树接口可用', tree.get('code') == 0 and isinstance(td.get('list'), list), str(tree)[:100])
    check('部门树返回全员人数 totalStaff', 'totalStaff' in td and int(td.get('totalStaff') or 0) >= 0,
          str(td.get('totalStaff')))
    first_root = (td.get('list') or [{}])[0] if td.get('list') else {}
    check('部门树是嵌套结构（节点带 children / totalCount / directCount）',
          ('children' in first_root) and ('totalCount' in first_root) and ('directCount' in first_root),
          str(sorted(first_root.keys()))[:120])

    lst = get('/api/addressbook/list', {'pageNum': 1, 'pageSize': 5})
    ld = lst.get('data') or {}
    check('通讯录列表接口可用', lst.get('code') == 0 and isinstance(ld.get('list'), list), str(lst)[:100])
    items = ld.get('list') or []
    check('列表带分页信息（total / pageNum / pageSize / pages）',
          all(k in ld for k in ('total', 'pageNum', 'pageSize', 'pages')), str(sorted(ld.keys()))[:120])
    if items:
        keys = sorted(items[0].keys())
        banned = ['idCard', 'photo', 'education', 'school', 'major', 'certificates',
                  'titleName', 'birthDate', 'hireDate', 'remark', 'hasPhoto', 'password', 'token']
        leaked = [k for k in banned if k in keys]
        check('只返回通讯录字段（身份证 / 照片 / 学历 / 证书等档案字段不外泄）', not leaked, ','.join(leaked))
        need = ['code', 'nameCn', 'genderText', 'phone', 'email', 'deptName', 'jobTitle', 'statusText']
        check('通讯录字段齐全（工号 姓名 性别 手机 邮箱 部门 岗位 在职状态）',
              all(k in keys for k in need), ','.join(keys))
    else:
        check('只返回通讯录字段（身份证 / 照片 / 学历 / 证书等档案字段不外泄）', False, '列表为空，无法校验')
        check('通讯录字段齐全（工号 姓名 性别 手机 邮箱 部门 岗位 在职状态）', False, '列表为空')

    check('通讯录是只读的：add 接口不存在',
          post('/api/addressbook/add', {'nameCn': 'x'}).get('code') == 404,
          str(post('/api/addressbook/add', {'nameCn': 'x'}))[:80])
    check('通讯录是只读的：delete 接口不存在',
          post('/api/addressbook/delete', {'id': 1}).get('code') == 404,
          str(post('/api/addressbook/delete', {'id': 1}))[:80])
    check('通讯录是只读的：update 接口不存在',
          post('/api/addressbook/update', {'id': 1}).get('code') == 404,
          str(post('/api/addressbook/update', {'id': 1}))[:80])

    r = get('/api/addressbook/list', {'keyword': '不存在的人'})
    check('关键字检索无结果时 total=0',
          r.get('code') == 0 and int((r.get('data') or {}).get('total') or 0) == 0, str(r)[:100])
    r = get('/api/addressbook/list', {'status': 'abc'})
    check('在职状态非法时给出业务错误', r.get('code') != 0 and '状态' in (r.get('message') or ''),
          str(r.get('message'))[:80])
    r = get('/api/addressbook/list', {'pageSize': 9999})
    check('每页条数被收敛（<=200）', r.get('code') == 0 and
          int((r.get('data') or {}).get('pageSize') or 0) <= 200,
          str((r.get('data') or {}).get('pageSize')))
    check('通讯录接口同样需要登录 token',
          request('GET', '/api/addressbook/list', {}, auth=False).get('code') == 401 and
          request('GET', '/api/addressbook/tree', {}, auth=False).get('code') == 401)

    # ===================== 8.4 密码：忘记密码（邮箱验证码）/ 登录后改密 =====================
    print('\n--- 8.4 找回密码与自助改密（只测校验分支，不真的发信、不改任何账号密码） ---')

    def anon(path, body):
        """免登录接口：不带 token 直接调（sendcode / resetbyemail 在免登录白名单里）"""
        return request('POST', path, body, auth=False)

    r = anon('/api/auth/sendcode', {'email': ''})
    check('发送验证码：邮箱为空被拒绝',
          r.get('code') != 0 and '请输入登记的邮箱' in (r.get('message') or ''), str(r.get('message')))
    r = anon('/api/auth/sendcode', {'email': 'not-an-email'})
    check('发送验证码：邮箱格式非法被拒绝',
          r.get('code') != 0 and '格式不正确' in (r.get('message') or ''), str(r.get('message')))
    r = anon('/api/auth/sendcode', {'email': 'nobody-selftest@example.com'})
    check('发送验证码：未登记的邮箱被拒绝（提示去确认或联系管理员）',
          r.get('code') != 0 and '未在系统中登记' in (r.get('message') or ''), str(r.get('message')))
    check('sendcode 属于免登录接口（不带 token 也不会被 401 拦掉）', r.get('code') != 401, str(r)[:80])

    # 取一个「已登记邮箱」的真实账号（只读，不发信）
    try:
        import os as _os2
        sys.path.insert(0, _os2.path.dirname(_os2.path.abspath(__file__)))
        from db import query_one as _q1
        row = _q1("SELECT u.`account`, e.`email` FROM `useinfo` u "
                  "JOIN `empinfos` e ON e.`id`=u.`empId` "
                  "WHERE u.`enabled`=1 AND e.`email` IS NOT NULL AND e.`email`<>'' LIMIT 1")
    except Exception as exc:
        row = None
        print('   （读库取测试邮箱失败：%s）' % exc)
    if row:
        known_email = str(row['email'])
        r = anon('/api/auth/resetbyemail', {'email': known_email, 'code': '', 'newPassword': 'abc123'})
        check('重置密码：验证码为空被拒绝',
              r.get('code') != 0 and '请输入邮箱验证码' in (r.get('message') or ''), str(r.get('message')))
        r = anon('/api/auth/resetbyemail', {'email': known_email, 'code': '123',
                                           'newPassword': 'abc123'})
        check('重置密码：验证码不是 6 位被拒绝',
              r.get('code') != 0 and '6 位数字' in (r.get('message') or ''), str(r.get('message')))
        r = anon('/api/auth/resetbyemail', {'email': known_email, 'code': '123456',
                                           'newPassword': '123'})
        check('重置密码：新密码太短被拒绝（先校验密码再消费验证码）',
              r.get('code') != 0 and '至少 6 位' in (r.get('message') or ''), str(r.get('message')))
        r = anon('/api/auth/resetbyemail', {'email': known_email, 'code': '123456',
                                           'newPassword': '111111'})
        check('重置密码：重复单一字符的新密码被拒绝',
              r.get('code') != 0 and '同一个字符重复' in (r.get('message') or ''), str(r.get('message')))
        r = anon('/api/auth/resetbyemail', {'email': known_email, 'code': '123456',
                                           'newPassword': 'abc123'})
        check('重置密码：没先发验证码时提示先获取',
              r.get('code') != 0 and '请先点击' in (r.get('message') or ''), str(r.get('message')))
    else:
        for name in ('重置密码：验证码为空被拒绝', '重置密码：验证码不是 6 位被拒绝',
                     '重置密码：新密码太短被拒绝（先校验密码再消费验证码）',
                     '重置密码：重复单一字符的新密码被拒绝', '重置密码：没先发验证码时提示先获取'):
            check(name, False, '库里没有带邮箱的启用账号，跳过')

    r = request('POST', '/api/auth/changepwd', {'oldPassword': '888888', 'newPassword': 'abc123'},
                auth=False)
    check('自助改密：未登录返回 401', r.get('code') == 401, str(r)[:80])
    r = post('/api/auth/changepwd', {'oldPassword': 'definitely-wrong-pass', 'newPassword': 'abc123'})
    check('自助改密：原密码不正确被拒绝',
          r.get('code') != 0 and '原密码不正确' in (r.get('message') or ''), str(r.get('message')))

    # ===================== 8.5 数据中心：数据库连接 + 结构扫描 =====================
    print('\n--- 8.5 数据中心（数据库连接 / 实例·表·视图·字段扫描） ---')
    r = request('GET', '/api/dbinfo/list', {}, auth=False)
    check('数据中心接口需要登录 token', r.get('code') == 401, str(r)[:80])

    r = get('/api/dbinfo/types')
    types = ((r.get('data') or {}).get('list')) or []
    values = [t.get('value') for t in types]
    check('数据库类型下拉返回主流数据库',
          r.get('code') == 0 and 'mysql' in values and 'postgresql' in values and 'oracle' in values
          and 'sqlserver' in values and 'sqlite' in values, ','.join([str(v) for v in values]))
    check('类型里带默认端口（MySQL 3306 / PostgreSQL 5432）',
          any(t.get('value') == 'mysql' and int(t.get('port') or 0) == 3306 for t in types) and
          any(t.get('value') == 'postgresql' and int(t.get('port') or 0) == 5432 for t in types),
          str([(t.get('value'), t.get('port')) for t in types])[:120])

    name = '__dbinfo_selftest__'
    r = post('/api/dbinfo/add', {'name': '', 'dbType': 'mysql', 'host': '127.0.0.1'})
    check('新增连接：名称为空被拒绝', r.get('code') != 0 and '连接名称不能为空' in (r.get('message') or ''),
          str(r.get('message')))
    r = post('/api/dbinfo/add', {'name': 'x-unknown', 'dbType': 'db2'})
    check('新增连接：不支持的数据库类型被拒绝',
          r.get('code') != 0 and '不支持的数据库类型' in (r.get('message') or ''), str(r.get('message')))
    r = post('/api/dbinfo/add', {'name': 'x-nohost', 'dbType': 'mysql'})
    check('新增连接：非文件型缺少主机被拒绝',
          r.get('code') != 0 and '主机地址不能为空' in (r.get('message') or ''), str(r.get('message')))
    r = post('/api/dbinfo/add', {'name': 'x-sqlite', 'dbType': 'sqlite'})
    check('新增连接：SQLite 必须填库文件路径',
          r.get('code') != 0 and '库文件路径' in (r.get('message') or ''), str(r.get('message')))

    # Oracle：驱动（python-oracledb 瘦模式）已装好，只差库填错时的提示是否友好
    r = post('/api/dbinfo/add', {'name': 'x-oracle-nodb', 'dbType': 'oracle',
                                 'host': '127.0.0.1', 'port': 1521, 'username': 'x',
                                 'password': 'y'})
    check('新增连接：Oracle 必须填服务名 / SID',
          r.get('code') != 0 and 'Oracle' in (r.get('message') or '') and
          'SID' in (r.get('message') or ''), str(r.get('message'))[:100])
    r = post('/api/dbinfo/add', {'name': '__oracle_probe__', 'dbType': 'oracle',
                                 'host': '127.0.0.1', 'port': 1, 'dbName': 'ORCL',
                                 'username': 'x', 'password': 'y', 'enabled': 0})
    ora_id = str((r.get('data') or {}).get('id') or '')
    if ora_id:
        r = post('/api/dbinfo/test', {'id': ora_id})
        msg = str((r.get('data') or {}).get('message') or r.get('message') or '')
        check('Oracle 已装驱动：报的是「连接失败」而不是「未安装 oracledb」',
              r.get('code') != 0 and '未安装' not in msg and
              ('Oracle' in msg or '连接' in msg), msg[:120])
        post('/api/dbinfo/delete', {'id': ora_id})
    else:
        check('Oracle 已装驱动：报的是「连接失败」而不是「未安装 oracledb」', False,
              str(r.get('message'))[:100])

    # SQL Server：驱动（pymssql，自带 FreeTDS）同理，端口故意填 1，几毫秒就 refused
    r = post('/api/dbinfo/add', {'name': '__mssql_probe__', 'dbType': 'sqlserver',
                                 'host': '127.0.0.1', 'port': 1, 'dbName': 'master',
                                 'username': 'x', 'password': 'y', 'enabled': 0})
    ms_id = str((r.get('data') or {}).get('id') or '')
    if ms_id:
        r = post('/api/dbinfo/test', {'id': ms_id})
        msg = str((r.get('data') or {}).get('message') or r.get('message') or '')
        check('SQL Server 已装驱动：报的是「连接失败」而不是「未安装 pymssql」',
              r.get('code') != 0 and '未安装' not in msg and
              ('SQL Server' in msg or '连接' in msg), msg[:120])
        post('/api/dbinfo/delete', {'id': ms_id})
    else:
        check('SQL Server 已装驱动：报的是「连接失败」而不是「未安装 pymssql」', False,
              str(r.get('message'))[:100])
    r = post('/api/dbinfo/add', {'name': name, 'dbType': 'mysql', 'host': '127.0.0.1',
                                 'port': 3306, 'dbName': 'rogerorm', 'username': 'sa',
                                 'password': 'roger2019', 'charset': 'utf8mb4', 'enabled': 1,
                                 'remark': '自动化测试用，可删'})
    dbi = r.get('data') or {}
    db_id = str(dbi.get('id') or '')
    check('新增数据库连接（MySQL，指向本机）成功', r.get('code') == 0 and bool(db_id), str(r)[:120])
    check('接口不回显连接密码（只有掩码 / hasPassword）',
          'password' not in dbi and dbi.get('hasPassword') is True and dbi.get('passwordMask') == '******',
          str(sorted(dbi.keys()))[:140])
    check('返回里补齐展示字段（类型中文名 / 服务器 / 默认端口）',
          dbi.get('typeLabel') == 'MySQL' and str(dbi.get('serverText')) == '127.0.0.1:3306'
          and dbi.get('hasFile') is False, str(dbi.get('typeLabel')) + ' / ' + str(dbi.get('serverText')))
    check('新增时 ispub 不传默认公用（ispub=1 + 中文文案）',
          dbi.get('ispub') is True and dbi.get('ispubText') == '公用',
          '%s / %s' % (dbi.get('ispub'), dbi.get('ispubText')))
    me_db = get('/api/auth/me').get('data') or {}
    expect_db_emp = int(me_db.get('empId') or 0)
    check('新增时按当前登录员工自动带入 createempinfosid（页面不传）',
          expect_db_emp > 0 and int(dbi.get('createempinfosid') or 0) == expect_db_emp,
          '%s != %s' % (dbi.get('createempinfosid'), expect_db_emp))

    r = post('/api/dbinfo/add', {'name': name, 'dbType': 'mysql', 'host': '127.0.0.1', 'password': 'x'})
    check('连接名称重复被拒绝', r.get('code') != 0 and '已存在' in (r.get('message') or ''),
          str(r.get('message')))
    r = get('/api/dbinfo/check', {'field': 'name', 'value': name})
    r2 = get('/api/dbinfo/check', {'field': 'name', 'value': name, 'id': db_id})
    check('唯一性校验：同名时 unique=false，排除自身后 unique=true',
          (r.get('data') or {}).get('unique') is False and (r2.get('data') or {}).get('unique') is True,
          str(r) + ' / ' + str(r2))

    try:
        r = post('/api/dbinfo/test', {'id': db_id})
        test_msg = str((r.get('data') or {}).get('message') or '')
        check('测试连接通过（能列出实例）', r.get('code') == 0 and '连接成功' in test_msg, test_msg[:120])

        r = post('/api/dbinfo/scan', {'id': db_id})
        sd = r.get('data') or {}
        dbs = sd.get('databases') or []
        check('扫描出可用实例（库）列表', r.get('code') == 0 and len(dbs) > 0, '共 %d 个' % len(dbs))
        check('实例列表里标出当前库（rogerorm）',
              any(one.get('name') == 'rogerorm' and one.get('current') for one in dbs),
              str([one.get('name') for one in dbs])[:120])
        check('实例列表带表数量与系统库标记',
              all('tableCount' in one and 'system' in one for one in dbs[:1]),
              str(dbs[:1])[:140])
        detail_now = (get('/api/dbinfo/detail', {'id': db_id}).get('data') or {}).get('lastScanTime')
        check('扫描后回写最近扫描时间', detail_now not in (None, ''), str(detail_now))

        r = get('/api/dbinfo/tables', {'id': db_id, 'database': 'rogerorm'})
        td = r.get('data') or {}
        tables = td.get('tables') or []
        names = [one.get('name') for one in tables]
        check('扫描出库里的表与视图', r.get('code') == 0 and len(tables) > 5,
              '共 %d 个 / %s' % (len(tables), ','.join([str(n) for n in names[:6]])))
        check('表列表含 dbinfomgr 且标记 kind=table',
              any(one.get('name') == 'dbinfomgr' and one.get('kind') == 'table' for one in tables),
              ','.join([str(n) for n in names[:8]]))
        check('返回表 / 视图数量统计', isinstance(td.get('counts'), dict) and
              int((td.get('counts') or {}).get('table') or 0) >= 1, str(td.get('counts')))

        r = get('/api/dbinfo/columns', {'id': db_id, 'database': 'rogerorm', 'table': 'dbinfomgr'})
        cd = r.get('data') or {}
        cols = cd.get('columns') or []
        col_names = [one.get('name') for one in cols]
        check('扫描出表字段（含 name / enabled / password）', r.get('code') == 0 and
              'name' in col_names and 'enabled' in col_names and 'password' in col_names,
              ','.join([str(n) for n in col_names]))
        check('字段带类型 / 是否可空 / 主键标记',
              all('dataType' in one and 'nullable' in one and 'key' in one for one in cols[:3]) and
              any(one.get('name') == 'id' and one.get('key') == 'PRI' for one in cols),
              str(cols[:2])[:140])

        r = get('/api/dbinfo/tables', {'id': db_id, 'database': ''})
        check('扫描表时实例为空被拒绝', r.get('code') != 0 and '实例' in (r.get('message') or ''),
              str(r.get('message')))
        r = get('/api/dbinfo/columns', {'id': db_id, 'database': 'rogerorm', 'table': ''})
        check('扫描字段时表为空被拒绝', r.get('code') != 0 and '表或视图' in (r.get('message') or ''),
              str(r.get('message')))
        r = post('/api/dbinfo/scan', {'id': 'not-a-uuid'})
        check('扫描时 id 非法被拒绝', r.get('code') != 0 and 'id' in (r.get('message') or ''),
              str(r.get('message')))
        r = post('/api/dbinfo/scan', {'id': '11111111-1111-4111-8111-111111111111'})
        check('扫描不存在的连接返回 404', r.get('code') == 404, str(r)[:80])

        r = post('/api/dbinfo/enabled', {'id': db_id, 'enabled': 0})
        check('停用连接成功', r.get('code') == 0 and not (r.get('data') or {}).get('enabled'), str(r)[:80])
        r = post('/api/dbinfo/enabled', {'id': db_id, 'enabled': 1})
        check('启用连接成功', r.get('code') == 0 and (r.get('data') or {}).get('enabled') is True, str(r)[:80])

        r = post('/api/dbinfo/update', {'id': db_id, 'name': name, 'dbType': 'mysql',
                                        'host': '127.0.0.1', 'port': 3306, 'dbName': 'rogerorm',
                                        'username': 'sa', 'password': '', 'remark': '改过备注',
                                        'ispub': 0})
        ud = r.get('data') or {}
        check('编辑连接（密码留空不修改）成功',
              r.get('code') == 0 and ud.get('remark') == '改过备注' and ud.get('hasPassword') is True,
              str(ud.get('remark')) + ' / ' + str(ud.get('hasPassword')))
        check('编辑时可把公用改成私有（ispub=0 → 私有）',
              ud.get('ispub') is False and ud.get('ispubText') == '私有',
              '%s / %s' % (ud.get('ispub'), ud.get('ispubText')))
        check('编辑不覆盖创建人员工ID',
              int(ud.get('createempinfosid') or 0) == expect_db_emp, str(ud.get('createempinfosid')))
        r = post('/api/dbinfo/update', {'id': db_id, 'name': name, 'dbType': 'mysql',
                                        'host': '127.0.0.1', 'port': 3306, 'dbName': 'rogerorm',
                                        'username': 'sa', 'remark': '改过备注'})
        check('局部更新没带 ispub 时保留「私有」（不被冲回公用）',
              (r.get('data') or {}).get('ispub') is False, str((r.get('data') or {}).get('ispub')))
    finally:
        r = post('/api/dbinfo/delete', {'id': db_id})
        check('删除数据库连接成功', r.get('code') == 0, str(r)[:80])
        left = get('/api/dbinfo/list', {'keyword': '__dbinfo_selftest__'}).get('data') or {}
        check('测试数据已清理', int(left.get('total') or 0) == 0, str(left.get('total')))

    # ---- 连接对象可见性（2026-11-06 用户需求）：列表只加载「本用户创建的 + 他人标为公用的」 ----
    _vis_ids = []
    try:
        import os as _vos, sys as _vs, uuid as _vu
        _vs.path.insert(0, _vos.path.dirname(_vos.path.abspath(__file__)))
        from db import execute as _vexec, query_one as _vq

        _me = int((_vq('SELECT `empId` FROM `useinfo` WHERE `account`=%s LIMIT 1',
                       (TOKEN.get('account'),)) or {}).get('empId') or 0)
        check('当前测试账号已绑定员工（可见性过滤需要 empId）', _me > 0, str(_me))

        def _mk(name, ispub, emp_id):
            uid = str(_vu.uuid4())
            _vexec('INSERT INTO `dbinfomgr` (`id`,`name`,`dbType`,`host`,`port`,`dbName`,'
                   '`username`,`password`,`enabled`,`ispub`,`createempinfosid`) '
                   'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,1,%s,%s)',
                   (uid, name, 'mysql', '127.0.0.1', 3306, 'rogerorm', 'sa', '', ispub, emp_id))
            _vis_ids.append(uid)
            return uid

        _mk('__vis_mine_priv', 0, _me)         # 我建的私有
        _mk('__vis_mine_pub', 1, _me)          # 我建的公用
        _mk('__vis_other_priv', 0, 999999)     # 别人私有
        _mk('__vis_other_pub', 1, 999999)      # 别人公用

        def _vis_names(path, extra=None):
            body = {'keyword': '__vis_', 'pageSize': 50}
            body.update(extra or {})
            rr = get(path, body).get('data') or {}
            return sorted([str(one.get('name')) for one in (rr.get('list') or [])])

        expect = ['__vis_mine_priv', '__vis_mine_pub', '__vis_other_pub']
        got = _vis_names('/api/dbinfo/list')
        check('连接对象列表只加载本人创建的 + 他人标为公用的',
              got == expect, str(got))
        check('别人标为私有的连接在列表里看不到',
              '__vis_other_priv' not in got, str(got))
        got_conn = sorted([str(one.get('name')) for one in
                           ((get('/api/report/connections').get('data') or {}).get('list') or [])
                           if str(one.get('name') or '').startswith('__vis_')])
        check('报表设计器的数据源下拉与连接列表同口径（本人 + 他人公用）',
              got_conn == expect, str(got_conn))
        _vexec("UPDATE `dbinfomgr` SET `ispub`=1 WHERE `name`='__vis_other_priv'")
        got2 = _vis_names('/api/dbinfo/list')
        check('别人把私有改成公用的连接随后出现在列表里',
              '__vis_other_priv' in got2, str(got2))
        got2_conn = [str(one.get('name')) for one in
                     ((get('/api/report/connections').get('data') or {}).get('list') or [])
                     if str(one.get('name') or '').startswith('__vis_')]
        check('报表数据源下拉同步出现该连接',
              '__vis_other_priv' in got2_conn, str(sorted(got2_conn)))
        _vexec("UPDATE `dbinfomgr` SET `ispub`=0 WHERE `name`='__vis_other_priv'")
        _vexec("UPDATE `dbinfomgr` SET `ispub`=0 WHERE `name`='__vis_mine_pub'")
        got3 = _vis_names('/api/dbinfo/list')
        check('自己建的连接即使设为私有也始终可见',
              got3 == ['__vis_mine_priv', '__vis_mine_pub', '__vis_other_pub'], str(got3))
        check('自己的两份（私有一份 + 公用一份）都在列表里，仅他人私有不可见',
              '__vis_mine_priv' in got3 and '__vis_mine_pub' in got3 and
              '__vis_other_priv' not in got3, str(got3))
    finally:
        for _vid in _vis_ids:
            try:
                _vexec('DELETE FROM `dbinfomgr` WHERE `id`=%s', (_vid,))
            except Exception:
                pass

    # ===================== 8.6 数据中心：SQL 工作台（只读执行） =====================
    print('\n--- 8.6 数据中心 · SQL 工作台（只读执行） ---')
    r = request('POST', '/api/dbinfo/sqlrun', {'id': 'x', 'sql': 'SELECT 1'}, auth=False)
    check('SQL 执行接口需要登录 token', r.get('code') == 401, str(r)[:80])

    sql_name = '__dbinfo_sqlrun__'
    r = post('/api/dbinfo/add', {'name': sql_name, 'dbType': 'mysql', 'host': '127.0.0.1',
                                 'port': 3306, 'dbName': 'rogerorm', 'username': 'sa',
                                 'password': 'roger2019', 'charset': 'utf8mb4', 'enabled': 1})
    sql_id = str((r.get('data') or {}).get('id') or '')
    check('为 SQL 工作台准备一条本机 MySQL 连接', r.get('code') == 0 and bool(sql_id), str(r)[:100])

    def run_sql(sql, database='rogerorm', max_rows=None):
        body = {'id': sql_id, 'sql': sql, 'database': database}
        if max_rows is not None:
            body['maxRows'] = max_rows
        return post('/api/dbinfo/sqlrun', body)

    try:
        r = run_sql('')
        check('空 SQL 被拒绝', r.get('code') != 0 and '请输入要执行的 SQL' in (r.get('message') or ''),
              str(r.get('message')))
        r = run_sql('INSERT INTO dbinfomgr (`id`) VALUES ("x")')
        check('INSERT 被拒绝（只允许查询）',
              r.get('code') != 0 and '只允许执行查询语句' in (r.get('message') or ''), str(r.get('message')))
        r = run_sql('UPDATE useinfo SET `password`="x"')
        check('UPDATE 被拒绝', r.get('code') != 0 and '只允许执行查询语句' in (r.get('message') or ''),
              str(r.get('message')))
        r = run_sql('DROP TABLE dbinfomgr')
        check('DROP 被拒绝', r.get('code') != 0 and '只允许执行查询语句' in (r.get('message') or ''),
              str(r.get('message')))
        r = run_sql('SELECT 1; SELECT 2')
        check('一次只能执行一条语句',
              r.get('code') != 0 and '一次只能执行一条' in (r.get('message') or ''), str(r.get('message')))
        r = run_sql('WITH t AS (SELECT 1) DELETE FROM useinfo')
        check('WITH 里夹写操作也被拒绝',
              r.get('code') != 0 and '写操作关键字' in (r.get('message') or ''), str(r.get('message')))
        r = run_sql('SELECT * FROM dbinfomgr; -- 结尾注释')
        check('末尾只有注释时不算多语句', r.get('code') == 0, str(r.get('message'))[:100])
        r = run_sql('SHOW CREATE TABLE `dbinfomgr`')
        check('SHOW CREATE 按只读元数据放行（语句里的 CREATE 不算写操作）',
              r.get('code') == 0 and 'CREATE TABLE' in str((r.get('data') or {}).get('rows') or ''),
              str(r.get('message'))[:100])
        r = run_sql('SHOW CREATE TABLE `dbinfomgr`; DROP TABLE `dbinfomgr`')
        check('SHOW CREATE 后面夹写操作仍按多语句拒绝',
              r.get('code') != 0 and '一次只能执行一条' in (r.get('message') or ''),
              str(r.get('message'))[:100])

        r = run_sql("SELECT 1 AS a, '中文' AS b")
        d = r.get('data') or {}
        cols = [one.get('name') for one in (d.get('columns') or [])]
        rows = d.get('rows') or []
        check('查询成功返回字段与结果行',
              r.get('code') == 0 and cols == ['a', 'b'] and rows and rows[0][1] == '中文',
              str(cols) + ' / ' + str(rows)[:80])
        check('返回里带语句类型 / 耗时 / 实例 / 执行时间',
              d.get('statement') == 'SELECT' and d.get('elapsed') is not None and
              d.get('database') == 'rogerorm' and bool(d.get('executedAt')),
              str(d.get('statement')) + ' / ' + str(d.get('database')))
        check('返回里带连接信息（便于前端显示当前连接）',
              (d.get('connection') or {}).get('id') == sql_id, str(d.get('connection'))[:80])

        r = run_sql('SELECT `id`,`name` FROM dbinfomgr LIMIT 5')
        d = r.get('data') or {}
        check('指定实例能查到表数据（字段名原样返回）',
              r.get('code') == 0 and [one.get('name') for one in (d.get('columns') or [])] == ['id', 'name']
              and int(d.get('rowCount') or 0) >= 1, str(d.get('rowCount')))

        r = run_sql('SHOW TABLES')
        d = r.get('data') or {}
        check('SHOW 语句可用（表名做列名）',
              r.get('code') == 0 and str(((d.get('columns') or [{}])[0]).get('name')) == 'Tables_in_rogerorm',
              str(d.get('columns'))[:100])
        r = run_sql('DESC dbinfomgr')
        d = r.get('data') or {}
        check('DESC 语句可用（6 列结构信息）',
              r.get('code') == 0 and len(d.get('columns') or []) == 6, str(len(d.get('columns') or [])))

        r = run_sql('SELECT * FROM useinfo', max_rows=1)
        d = r.get('data') or {}
        check('超过 maxRows 会截断并标记 truncated',
              r.get('code') == 0 and d.get('truncated') is True and int(d.get('rowCount') or 0) == 1,
              str(d.get('rowCount')) + ' / ' + str(d.get('truncated')))
        check('截断时提示里说明只显示前 N 行', '截断' in (d.get('message') or ''), str(d.get('message'))[:80])

        r = run_sql('SELECT * FROM 不存在的表_selftest')
        check('表不存在时给出执行失败信息',
              r.get('code') != 0 and '执行失败' in (r.get('message') or ''), str(r.get('message'))[:100])
        detail = get('/api/dbinfo/detail', {'id': sql_id}).get('data') or {}
        check('SQL 执行失败不会写进连接的「最近错误」', not detail.get('lastError'),
              str(detail.get('lastError')))

        # 写操作既然被拦，库里条数不应变化
        before = (run_sql('SELECT COUNT(*) AS n FROM dbinfomgr').get('data') or {}).get('rows') or [[0]]
        run_sql('DELETE FROM dbinfomgr')
        after = (run_sql('SELECT COUNT(*) AS n FROM dbinfomgr').get('data') or {}).get('rows') or [[0]]
        check('被拒绝的写操作确实没有改动数据',
              str(before[0][0]) == str(after[0][0]), str(before) + ' → ' + str(after))

        r = post('/api/dbinfo/sqlrun', {'id': '11111111-1111-4111-8111-111111111111',
                                        'sql': 'SELECT 1'})
        check('连接不存在时 SQL 执行返回 404', r.get('code') == 404, str(r)[:80])
        r = post('/api/dbinfo/sqlrun', {'id': 'not-a-uuid', 'sql': 'SELECT 1'})
        check('连接 id 非法时被拒绝', r.get('code') != 0 and 'id' in (r.get('message') or ''),
              str(r.get('message'))[:80])
        r = post('/api/dbinfo/sqlrun', {'id': sql_id, 'sql': 'SELECT 1', 'maxRows': 99999})
        check('maxRows 超过上限时按上限收敛（不报错）', r.get('code') == 0, str(r.get('message'))[:80])
    finally:
        r = post('/api/dbinfo/delete', {'id': sql_id})
        check('删掉 SQL 工作台的测试连接', r.get('code') == 0, str(r)[:80])

    # ===================== 8.7 数据中心：表 / 视图数据浏览（分页 + 排序 + 过滤） =====================
    print('\n--- 8.7 数据中心 · 数据标签页（懒加载分页 / 排序 / 过滤） ---')
    r = request('POST', '/api/dbinfo/rows', {'id': 'x', 'table': 'useinfo'}, auth=False)
    check('取数接口需要登录 token', r.get('code') == 401, str(r)[:80])

    rows_name = '__dbinfo_rows__'
    r = post('/api/dbinfo/add', {'name': rows_name, 'dbType': 'mysql', 'host': '127.0.0.1',
                                 'port': 3306, 'dbName': 'rogerorm', 'username': 'sa',
                                 'password': 'roger2019', 'charset': 'utf8mb4', 'enabled': 1})
    rows_id = str((r.get('data') or {}).get('id') or '')
    check('为数据浏览准备一条本机 MySQL 连接', r.get('code') == 0 and bool(rows_id), str(r)[:100])

    def fetch_rows(**kwargs):
        body = {'id': rows_id, 'database': 'rogerorm'}
        body.update(kwargs)
        return post('/api/dbinfo/rows', body)

    try:
        r = fetch_rows(table='')
        check('没选表时提示先选表',
              r.get('code') != 0 and '一张表' in (r.get('message') or ''), str(r.get('message')))

        r = fetch_rows(table='useinfo', pageSize=2)
        d = r.get('data') or {}
        check('取第一页数据成功（pageSize=2）',
              r.get('code') == 0 and len(d.get('rows') or []) == 2 and int(d.get('total') or 0) >= 2,
              'rows=%s total=%s' % (len(d.get('rows') or []), d.get('total')))
        cols = d.get('columns') or []
        check('返回列名（字段名数组）', 'account' in cols and 'enabled' in cols, ','.join([str(c) for c in cols])[:120])
        check('返回分页信息（页码 / 每页 / 总页 / 是否还有更多）',
              int(d.get('pageNum') or 0) == 1 and int(d.get('pageSize') or 0) == 2 and
              int(d.get('pages') or 0) >= 2 and d.get('hasMore') is True,
              '%s / %s / %s / %s' % (d.get('pageNum'), d.get('pageSize'), d.get('pages'), d.get('hasMore')))

        r2 = fetch_rows(table='useinfo', pageSize=2, pageNum=2)
        d2 = r2.get('data') or {}
        first_1 = (d.get('rows') or [[None]])[0]
        first_2 = (d2.get('rows') or [[None]])[0]
        check('第二页数据与第一页不重复',
              r2.get('code') == 0 and int(d2.get('pageNum') or 0) == 2 and first_2 != first_1,
              'p1=%s p2=%s' % (str(first_1)[:40], str(first_2)[:40]))

        r = fetch_rows(table='useinfo', pageSize=100, orderBy='account', orderDir='desc')
        d3 = r.get('data') or {}
        acc_idx = [i for i, c in enumerate(cols) if c == 'account']
        accs = [row[acc_idx[0]] for row in (d3.get('rows') or [])] if acc_idx else []
        check('排序生效（account 降序）',
              r.get('code') == 0 and d3.get('orderBy') == 'account' and d3.get('orderDir') == 'desc'
              and accs == sorted(accs, reverse=True), str(accs)[:80])

        r = fetch_rows(table='useinfo', filters=[{'column': 'enabled', 'op': 'eq', 'value': 1}])
        check('过滤生效（enabled=1 时每行都是 1）',
              r.get('code') == 0 and all(int(row[[i for i, c in enumerate(cols) if c == 'enabled'][0]] or 0) == 1
                                         for row in ((r.get('data') or {}).get('rows') or [])),
              str((r.get('data') or {}).get('rows'))[:80])
        r = fetch_rows(table='useinfo', filters=[{'column': 'account', 'op': 'contains', 'value': 'zzz-no-hit'}])
        d4 = r.get('data') or {}
        check('过滤没有命中时返回 0 行且 total=0',
              r.get('code') == 0 and len(d4.get('rows') or []) == 0 and int(d4.get('total') or 0) == 0,
              'rows=%s total=%s' % (len(d4.get('rows') or []), d4.get('total')))
        r = fetch_rows(table='useinfo', filters=[{'column': 'lastLoginIp', 'op': 'notnull'}])
        check('「不为空」过滤可用', r.get('code') == 0, str(r.get('message'))[:80])
        r = fetch_rows(table='useinfo', filters=[{'column': 'token', 'op': 'null'}])
        check('「为空」过滤可用', r.get('code') == 0, str(r.get('message'))[:80])

        r = fetch_rows(table='useinfo`; DROP TABLE x; --')
        check('表名里带引号 / 分号被拒绝（注入防护）',
              r.get('code') != 0 and '不合法' in (r.get('message') or ''), str(r.get('message'))[:100])
        r = fetch_rows(table='useinfo', orderBy='id) --')
        check('排序字段带注入字符被拒绝',
              r.get('code') != 0 and '不合法' in (r.get('message') or ''), str(r.get('message'))[:100])
        r = fetch_rows(table='useinfo', filters=[{'column': 'id`', 'op': 'eq', 'value': '1'}])
        check('过滤字段带注入字符被拒绝',
              r.get('code') != 0 and '不合法' in (r.get('message') or ''), str(r.get('message'))[:100])
        r = fetch_rows(table='useinfo', filters=[{'column': 'id', 'op': 'between', 'value': '1'}])
        check('不支持的过滤方式被拒绝',
              r.get('code') != 0 and '不支持的过滤方式' in (r.get('message') or ''), str(r.get('message')))
        r = fetch_rows(table='useinfo', filters=[{'column': 'account', 'op': 'eq', 'value': "' OR 1=1 --"}])
        check('过滤值当参数绑定（引号不会造成注入）',
              r.get('code') == 0 and len((r.get('data') or {}).get('rows') or []) == 0,
              str((r.get('data') or {}).get('total')))

        r = fetch_rows(table='不存在的表_selftest')
        check('表不存在时给出友好错误',
              r.get('code') != 0 and '读取数据失败' in (r.get('message') or ''), str(r.get('message'))[:100])

        r = fetch_rows(table='useinfo', pageSize=99999)
        check('pageSize 超过上限时收敛到 500 以内',
              r.get('code') == 0 and int((r.get('data') or {}).get('pageSize') or 0) <= 500,
              str((r.get('data') or {}).get('pageSize')))

        r = fetch_rows(table='information_schema.TABLES')
        check('带点的表名被拒绝（避免跨库拼字符串）',
              r.get('code') != 0 and '不合法' in (r.get('message') or ''), str(r.get('message'))[:100])
    finally:
        r = post('/api/dbinfo/delete', {'id': rows_id})
        check('删掉数据浏览的测试连接', r.get('code') == 0, str(r)[:80])

    # ===================== 8.8 数据中心：报表设计器（报表信息 + 预览 + 调用） =====================
    print('\n--- 8.8 数据中心 · 报表设计器（列 / 参数 / 模板 / 预览 / 调用） ---')
    r = request('GET', '/api/report/list', None, auth=False)
    check('报表列表需要登录 token', r.get('code') == 401, str(r)[:80])

    rpt_conn_name = '__report_conn__'
    r = post('/api/dbinfo/add', {'name': rpt_conn_name, 'dbType': 'mysql', 'host': '127.0.0.1',
                                 'port': 3306, 'dbName': 'rogerorm', 'username': 'sa',
                                 'password': 'roger2019', 'charset': 'utf8mb4', 'enabled': 1})
    rpt_conn_id = str((r.get('data') or {}).get('id') or '')
    if r.get('code') != 0:                       # 已存在同名连接 → 查出来复用
        lst = get('/api/dbinfo/list', {'keyword': rpt_conn_name, 'pageSize': 50}).get('data') or {}
        for one in (lst.get('list') or []):
            if one.get('name') == rpt_conn_name:
                rpt_conn_id = str(one.get('id'))
    check('为报表用例准备一条本机 MySQL 连接', bool(rpt_conn_id), str(r)[:100])

    rpt_code = 'RPT_T_SELF'
    rpt_id = ''
    rpt_copy_id = ''
    try:
        r = get('/api/report/connections')
        d = r.get('data') or {}
        names = [one.get('name') for one in (d.get('list') or [])]
        check('数据源下拉只列出启用状态的连接',
              r.get('code') == 0 and rpt_conn_name in names, str(names)[:160])
        check('连接里不含密码等敏感字段',
              all('password' not in one for one in (d.get('list') or [])),
              str((d.get('list') or [{}])[0].keys())[:120])

        r = get('/api/report/databases', {'connId': rpt_conn_id})
        d = r.get('data') or {}
        check('扫出可用实例（库）', r.get('code') == 0 and len(d.get('databases') or []) >= 1,
              str([one.get('name') for one in (d.get('databases') or [])])[:140])
        r = get('/api/report/tables', {'connId': rpt_conn_id, 'database': 'rogerorm'})
        tables = (r.get('data') or {}).get('tables') or []
        check('扫出实例下的表 / 视图', r.get('code') == 0 and len(tables) > 3,
              str([one.get('name') for one in tables])[:140])
        r = get('/api/report/columns', {'connId': rpt_conn_id, 'database': 'rogerorm',
                                        'table': 'empinfos'})
        cols = (r.get('data') or {}).get('columns') or []
        check('扫出表的字段（含类型与注解）',
              r.get('code') == 0 and len(cols) > 3 and 'dataType' in (cols[0] if cols else {}),
              str([one.get('name') for one in cols])[:120])
        r = get('/api/report/tables', {'connId': 'not-a-uuid', 'database': 'rogerorm'})
        check('非法连接 id 被拒绝', r.get('code') != 0 and 'id' in (r.get('message') or ''),
              str(r.get('message'))[:80])

        r = post('/api/report/add', {'reportName': '缺连接的报表'})
        check('保存时缺数据源连接被拒绝',
              r.get('code') != 0 and '数据源连接' in (r.get('message') or ''), str(r.get('message'))[:80])
        r = post('/api/report/add', {'connId': rpt_conn_id})
        check('保存时缺报表名称被拒绝',
              r.get('code') != 0 and '名称不能为空' in (r.get('message') or ''), str(r.get('message'))[:80])
        r = post('/api/report/add', {'reportName': '编码非法', 'code': '报-表-01', 'connId': rpt_conn_id})
        check('报表编码非法被拒绝',
              r.get('code') != 0 and '编码只能用' in (r.get('message') or ''), str(r.get('message'))[:80])

        payload = {
            'code': rpt_code, 'reportName': '__报表自测__', 'reportNameEn': 'Self Test Report',
            'category': '自测分类',
            'connId': rpt_conn_id, 'databaseName': 'rogerorm', 'mainTable': 'empinfos',
            'sqlText': 'SELECT `code`, `nameCn` FROM `empinfos` '
                       'WHERE (`code` LIKE :kw OR :kw IS NULL OR :kw = \'\')',
            'columns': [
                {'field': 'code', 'label': '工号', 'width': 110},
                {'field': 'nameCn', 'label': '姓名', 'width': 100, 'align': 'center'},
                {'field': '年薪合计', 'label': '年薪合计', 'custom': 1},
            ],
            'params': [
                {'name': 'kw', 'label': '关键字', 'type': 'string', 'control': 'text',
                 'required': False, 'defaultValue': ''},
                {'name': 'topN', 'label': '条数', 'type': 'int', 'control': 'number',
                 'required': False, 'defaultValue': '0'},
            ],
            'design': {'title': '__报表自测__', 'subtitle': '副标题', 'headerText': '页眉',
                       'footerText': '页脚', 'zebra': True},
            'template': {'paper': 'A5', 'orientation': 'landscape', 'fontSize': 11,
                         'showPageNo': False},
            'description': '接口自测用，跑完即删',
            'enabled': 1,
        }
        r = post('/api/report/add', payload)
        d = r.get('data') or {}
        rpt_id = str(d.get('id') or '')
        check('新增报表成功并返回 UUID', r.get('code') == 0 and len(rpt_id) == 36, str(r)[:120])
        check('新增后版本号为 1、调用次数为 0',
              int(d.get('version') or 0) == 1 and int(d.get('runCount') or 0) == 0,
              '%s / %s' % (d.get('version'), d.get('runCount')))
        check('返回列定义（3 列，含对齐方式）',
              len(d.get('columns') or []) == 3 and (d.get('columns') or [{}])[0].get('label') == '工号',
              str(d.get('columns'))[:120])
        check('SQL 自定义列的 custom 标记随列定义保存并读回（2026-11-05）',
              (d.get('columns') or [{}, {}, {}])[2].get('custom') == 1 and
              (d.get('columns') or [{}, {}, {}])[0].get('custom') == 0,
              str((d.get('columns') or [{}])[2]))
        check('返回参数定义（2 个，含类型与控件）',
              len(d.get('params') or []) == 2 and (d.get('params') or [{}])[0].get('name') == 'kw',
              str(d.get('params'))[:120])
        check('返回画布设计与页面模板（含纸张方向）',
              (d.get('design') or {}).get('subtitle') == '副标题' and
              (d.get('template') or {}).get('paper') == 'A5' and
              (d.get('template') or {}).get('orientation') == 'landscape',
              str(d.get('template'))[:120])
        check('返回报表 SQL 原文',
              'empinfos' in str(d.get('sqlText') or ''), str(d.get('sqlText'))[:80])
        check('返回连接名称快照', d.get('connName') == rpt_conn_name, str(d.get('connName')))

        # ---- 创建人 / 修改人：取当前登录账号的员工姓名 + 员工ID（useinfo.empId → empinfos.nameCn）----
        me = get('/api/auth/me').get('data') or {}
        expect_creator = str(me.get('empName') or me.get('account') or '')
        expect_emp_id = int(me.get('empId') or 0)
        check('能取到当前登录人的姓名与员工ID（用于创建人）',
              bool(expect_creator) and expect_emp_id > 0,
              '%s / %s / %s' % (me.get('account'), me.get('empName'), me.get('empId')))
        check('新建报表的创建人姓名 = 当前登录人的员工姓名',
              str(d.get('createEname') or '') == expect_creator,
              '%s != %s' % (d.get('createEname'), expect_creator))
        check('新建报表的创建人员工ID = 当前登录人的员工ID',
              int(d.get('createempinfosid') or 0) == expect_emp_id, str(d.get('createempinfosid')))
        check('新建时修改人先与创建人一致（姓名 + 员工ID）',
              str(d.get('updateEname') or '') == expect_creator and
              int(d.get('updateempinfosid') or 0) == expect_emp_id,
              '%s / %s' % (d.get('updateEname'), d.get('updateempinfosid')))
        r = post('/api/report/add', dict(payload, code='RPT_T_WHO',
                                         createEname='冒名顶替', createempinfosid=999999,
                                         updateEname='冒名顶替', updateempinfosid=999999))
        spoof = r.get('data') or {}
        check('前端乱传 createEname / createempinfosid 不生效（以 token 反查为准）',
              r.get('code') == 0 and str(spoof.get('createEname') or '') == expect_creator and
              int(spoof.get('createempinfosid') or 0) == expect_emp_id,
              '%s / %s' % (spoof.get('createEname'), spoof.get('createempinfosid')))
        if spoof.get('id'):
            post('/api/report/delete', {'id': spoof.get('id')})

        # ---- 公开否（ispublic）：新报表默认私有，保存后详情可读回 ----
        check('新报表默认私有（ispublic=False）',
              d.get('ispublic') is False, str(d.get('ispublic')))
        r = post('/api/report/update', {'id': rpt_id, 'ispublic': 1})
        check('把报表设为公开后详情返回 ispublic=True',
              r.get('code') == 0 and (r.get('data') or {}).get('ispublic') is True,
              str((r.get('data') or {}).get('ispublic')))
        r = post('/api/report/update', {'id': rpt_id, 'ispublic': 0})
        check('再设回私有（ispublic=False）',
              r.get('code') == 0 and (r.get('data') or {}).get('ispublic') is False,
              str((r.get('data') or {}).get('ispublic')))

        # ---- 可见性过滤（2026-11-06 调整）：
        #      · 报表设计器清单 = **只加载本用户创建的**（含停用）
        #      · 报表中心      = 本用户创建的 + 他人设为公开（ispublic=1）且启用的
        # （直接在库里造一条「别人建的报表」，不依赖第二个可登录账号）
        _other_id = ''
        try:
            import os as _os, sys as _sys, uuid as _uuid
            _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
            from db import execute as _exec
            _other_id = str(_uuid.uuid4())
            _exec('INSERT INTO `reportinfos` (`id`,`code`,`reportName`,`enabled`,`ispublic`,'
                  '`createempinfosid`,`createEname`,`version`,`runCount`) '
                  'VALUES (%s,%s,%s,1,0,999999,%s,1,0)',
                  (_other_id, 'RPT_T_PUB1', '__他人报表可见性__', '别人建的'))

            def _total(path, kw):
                rr = get(path, {'keyword': kw, 'pageNum': 1, 'pageSize': 10})
                return int(((rr.get('data') or {}).get('total') or 0))

            check('别人的私有报表在我的清单里看不到',
                  _total('/api/report/list', 'RPT_T_PUB1') == 0,
                  str(_total('/api/report/list', 'RPT_T_PUB1')))
            check('别人的私有报表在报表中心也看不到',
                  _total('/api/report/center', 'RPT_T_PUB1') == 0,
                  str(_total('/api/report/center', 'RPT_T_PUB1')))
            _exec('UPDATE `reportinfos` SET `ispublic`=1 WHERE `id`=%s', (_other_id,))
            check('别人设为公开后，设计器清单里仍然看不到（清单只看本人创建的）',
                  _total('/api/report/list', 'RPT_T_PUB1') == 0,
                  str(_total('/api/report/list', 'RPT_T_PUB1')))
            check('别人设为公开后，报表中心能看到',
                  _total('/api/report/center', 'RPT_T_PUB1') == 1,
                  str(_total('/api/report/center', 'RPT_T_PUB1')))
            _exec('UPDATE `reportinfos` SET `ispublic`=0 WHERE `id`=%s', (_other_id,))
            check('重新设回私有后报表中心也看不到了',
                  _total('/api/report/center', 'RPT_T_PUB1') == 0,
                  str(_total('/api/report/center', 'RPT_T_PUB1')))
            check('自己创建的报表始终可见（公开与否都行）',
                  _total('/api/report/list', rpt_code) == 1,
                  str(_total('/api/report/list', rpt_code)))

            # ---- 2026-11-05：非本人创建的停用报表在报表中心不可显示（公开也不行）----
            _exec('UPDATE `reportinfos` SET `ispublic`=1, `enabled`=0 WHERE `id`=%s', (_other_id,))
            check('别人的公开但停用的报表在报表中心看不到',
                  _total('/api/report/center', 'RPT_T_PUB1') == 0,
                  str(_total('/api/report/center', 'RPT_T_PUB1')))
            _exec('UPDATE `reportinfos` SET `ispublic`=1, `enabled`=1 WHERE `id`=%s', (_other_id,))
            check('别人的公开报表重新启用后报表中心又能看到',
                  _total('/api/report/center', 'RPT_T_PUB1') == 1,
                  str(_total('/api/report/center', 'RPT_T_PUB1')))
            # 自己创建的停用报表仍然可见：把自己刚建的报表停用再查
            post('/api/report/enabled', {'id': rpt_id, 'enabled': 0})
            check('自己创建的停用报表仍然可见（方便继续编辑）',
                  _total('/api/report/list', rpt_code) == 1,
                  str(_total('/api/report/list', rpt_code)))
            post('/api/report/enabled', {'id': rpt_id, 'enabled': 1})
        finally:
            if _other_id:
                try:
                    from db import execute as _exec2
                    _exec2('DELETE FROM `reportinfos` WHERE `id`=%s', (_other_id,))
                except Exception:
                    pass

        r = post('/api/report/add', dict(payload))
        check('报表编码重复被拒绝',
              r.get('code') != 0 and '已存在' in (r.get('message') or ''), str(r.get('message'))[:80])
        r = get('/api/report/check', {'field': 'code', 'value': rpt_code})
        check('唯一性校验：已存在的编码不唯一',
              r.get('code') == 0 and (r.get('data') or {}).get('unique') is False,
              str(r.get('data')))
        r = get('/api/report/check', {'field': 'code', 'value': rpt_code, 'id': rpt_id})
        check('唯一性校验：排除自身后算唯一',
              (r.get('data') or {}).get('unique') is True, str(r.get('data')))

        r = post('/api/report/add', dict(payload, code='RPT_T_BAD1',
                                         params=[{'name': '1bad', 'label': 'x'}]))
        check('参数名非法被拒绝',
              r.get('code') != 0 and '参数名' in (r.get('message') or ''), str(r.get('message'))[:80])
        r = post('/api/report/add', dict(payload, code='RPT_T_BAD2',
                                         params=[{'name': 'a', 'type': 'string'},
                                                 {'name': 'a', 'type': 'string'}]))
        check('参数名重复被拒绝',
              r.get('code') != 0 and '重复' in (r.get('message') or ''), str(r.get('message'))[:80])
        r = post('/api/report/add', dict(payload, code='RPT_T_BAD3',
                                         params=[{'name': 'a', 'type': 'money'}]))
        check('参数类型不支持被拒绝',
              r.get('code') != 0 and '类型不支持' in (r.get('message') or ''), str(r.get('message'))[:80])
        r = post('/api/report/add', dict(payload, code='RPT_T_BAD4',
                                         columns=[{'field': 'a`drop'}]))
        check('字段名带反引号被拒绝（标识符白名单）',
              r.get('code') != 0 and '不合法' in (r.get('message') or ''), str(r.get('message'))[:80])

        r = get('/api/report/detail', {'id': rpt_id})
        d = r.get('data') or {}
        check('详情返回全量列定义与参数', len(d.get('columns') or []) == 3 and
              len(d.get('params') or []) == 2, str(r)[:100])

        # ---- 报表功能介绍（description）：多行保留、超长截断（更新在下面「8.8 更新」里一起验） ----
        check('详情返回保存时填的功能介绍',
              '接口自测用' in str(d.get('description') or ''), str(d.get('description'))[:60])
        long_desc = '第一行：接口自测用\n第二行：口径说明\n' + ('补' * 600)

        # ---- 英文报表名（reportNameEn，2026-11-06 用户需求）：保存后详情可读回 ----
        check('详情返回保存时填的英文报表名',
              d.get('reportNameEn') == 'Self Test Report', str(d.get('reportNameEn')))
        r = post('/api/report/update', {'id': rpt_id, 'reportNameEn': 'Self Test V2'})
        check('英文报表名可单独更新（其余字段不受影响）',
              r.get('code') == 0 and (r.get('data') or {}).get('reportNameEn') == 'Self Test V2' and
              (r.get('data') or {}).get('reportName') == payload.get('reportName'),
              str((r.get('data') or {}).get('reportNameEn')) + '/' +
              str((r.get('data') or {}).get('reportName')))
        r = post('/api/report/update', {'id': rpt_id, 'reportNameEn': ''})
        check('英文报表名可以清空',
              r.get('code') == 0 and not (r.get('data') or {}).get('reportNameEn'),
              str((r.get('data') or {}).get('reportNameEn')))
        post('/api/report/update', {'id': rpt_id, 'reportNameEn': 'Self Test Report'})

        # ---- 数据源连接快照（2026-11-06 用户需求）：
        #      保存时把连接对象全部访问信息快照进报表行，之后连接被改 / 被删也能照常执行 ----
        snap = d.get('connSnapshot') or {}
        check('详情返回数据源快照（类型 / 主机 / 端口 / 库 / 账号 / 字符集）',
              snap.get('dbType') == 'mysql' and snap.get('host') == '127.0.0.1' and
              int(snap.get('port') or 0) == 3306 and snap.get('dbName') == 'rogerorm' and
              snap.get('username') == 'sa' and snap.get('charset') == 'utf8mb4',
              str(snap)[:200])
        check('数据源快照里不回密码（只给 hasPassword 标记）',
              'password' not in snap and 'connPassword' not in d and bool(d.get('hasConnPassword')),
              str([k for k in snap.keys()])[:120])

        _snap_id, _snap_conn = '', ''
        try:
            import os as _os2, sys as _sys2
            _sys2.path.insert(0, _os2.path.dirname(_os2.path.abspath(__file__)))
            from db import query_one as _q1, execute as _exec2
            _snap_id = rpt_id
            row = _q1('SELECT `connType`,`connHost`,`connPort`,`connDbName`,`connUsername`,'
                      '`connPassword`,`connCharset`,`connExtraParams` FROM `reportinfos` '
                      'WHERE `id`=%s', (_snap_id,)) or {}
            check('连接快照随报表一起落库（reportinfos.connType/connHost/connPort/connDbName…）',
                  row.get('connType') == 'mysql' and row.get('connHost') == '127.0.0.1' and
                  int(row.get('connPort') or 0) == 3306 and row.get('connDbName') == 'rogerorm' and
                  row.get('connUsername') == 'sa' and row.get('connCharset') == 'utf8mb4',
                  str(row)[:200])
            check('落库的密码是密文（enc:v1: 前缀，不存明文）',
                  str(row.get('connPassword') or '').startswith('enc:v1:'),
                  str(row.get('connPassword'))[:12])

            # 把连接对象改坏（主机 / 密码都错）→ 报表仍按快照执行
            _snap_conn = rpt_conn_id
            before_conn = _q1('SELECT `host`,`password` FROM `dbinfomgr` WHERE `id`=%s',
                              (_snap_conn,)) or {}
            _exec2("UPDATE `dbinfomgr` SET `host`='0.0.0.0', `password`='enc:v1:broken' "
                   "WHERE `id`=%s", (_snap_conn,))
            # 用预览验证（同一套 _execute 执行链路，但不累加 runCount，不影响后面的调用计数断言）
            r = post('/api/report/preview', {'id': _snap_id, 'maxRows': 3})
            check('连接对象被改坏后，报表仍按保存时的快照正常执行',
                  r.get('code') == 0 and int((r.get('data') or {}).get('rowCount') or 0) >= 1,
                  '%s / %s' % (r.get('code'), str(r.get('message'))[:80]))
            _exec2('UPDATE `dbinfomgr` SET `host`=%s, `password`=%s WHERE `id`=%s',
                   (before_conn.get('host'), before_conn.get('password'), _snap_conn))
            r = post('/api/report/preview', {'id': _snap_id, 'maxRows': 3})
            check('连接恢复后报表照常可执行',
                  r.get('code') == 0 and int((r.get('data') or {}).get('rowCount') or 0) >= 1,
                  str(r.get('message'))[:60])
        finally:
            try:
                if _snap_conn:
                    _exec2('UPDATE `dbinfomgr` SET `host`=%s, `password`=%s WHERE `id`=%s',
                           (before_conn.get('host'), before_conn.get('password'), _snap_conn))
            except Exception:
                pass

        r = get('/api/report/detail', {'id': 'abc'})
        check('详情 id 非法被拒绝', r.get('code') != 0 and 'id' in (r.get('message') or ''),
              str(r.get('message'))[:80])

        # ---- 预览：自动拼 SELECT（没写 SQL 时按主表 + 列） ----
        r = post('/api/report/preview', {'connId': rpt_conn_id, 'databaseName': 'rogerorm',
                                         'mainTable': 'empinfos',
                                         'columns': [{'field': 'code', 'label': '工号'},
                                                     {'field': 'nameCn', 'label': '姓名'}],
                                         'paramValues': {}})
        d = r.get('data') or {}
        check('没写 SQL 时按主表 + 列自动拼查询',
              r.get('code') == 0 and 'SELECT' in str(d.get('sql') or '') and
              'empinfos' in str(d.get('sql') or ''), str(d.get('sql'))[:100])
        check('预览返回真实数据行', int(d.get('rowCount') or 0) >= 1, str(d.get('rowCount')))
        check('预览返回列映射（只有真的有结果的两列）',
              len(d.get('mapped') or []) == 2 and
              [one.get('index') for one in (d.get('mapped') or [])] == [0, 1],
              str(d.get('mapped'))[:160])
        check('预览带上执行的 SQL 与耗时信息',
              d.get('executedAt') and isinstance(d.get('elapsed'), int) and
              int(d.get('maxRows') or 0) > 0, '%s / %s' % (d.get('executedAt'), d.get('elapsed')))

        # ---- 预览：自定义 SQL + :参数 绑定 ----
        r = post('/api/report/preview', {'id': rpt_id, 'paramValues': {'kw': 'E0000%'}})
        d = r.get('data') or {}
        check('按已保存报表预览成功', r.get('code') == 0, str(r.get('message'))[:80])
        check('参数绑定后 SQL 里不再出现 :kw', ':kw' not in str(d.get('sql') or ''),
              str(d.get('sql'))[:100])
        check('参数值按名字回显', (d.get('paramValues') or {}).get('kw') == 'E0000%',
              str(d.get('paramValues')))
        check('SQL 只查 2 列时预览也只显示 2 列（多余列被忽略）',
              len(d.get('mapped') or []) == 2, str(d.get('mapped'))[:160])

        # ---- 引号内的参数：LIKE '%:kw%' 这种常见写法也要能绑定 ----
        r = post('/api/report/preview', {
            'connId': rpt_conn_id, 'databaseName': 'rogerorm',
            'sqlText': "SELECT `code`, `nameCn` FROM `empinfos` WHERE `code` LIKE '%:kw%'",
            'paramsJson': [{'name': 'kw', 'label': '工号', 'type': 'string'}],
            'paramValues': {'kw': 'E0000'}})
        d = r.get('data') or {}
        check("引号内的 :参数 也能绑定（LIKE '%:kw%'）",
              r.get('code') == 0 and int(d.get('rowCount') or 0) >= 1,
              '%s / %s' % (r.get('code'), str(r.get('message'))[:60]))
        check('引号内参数换成 CONCAT 拼接（值不拼进字符串字面量）',
              'CONCAT' in str(d.get('sql') or ''), str(d.get('sql'))[:120])
        check('引号内参数不影响返回列名',
              [one.get('name') for one in (d.get('columns') or [])] == ['code', 'nameCn'],
              str([one.get('name') for one in (d.get('columns') or [])]))
        r = post('/api/report/preview', {
            'connId': rpt_conn_id, 'databaseName': 'rogerorm',
            'sqlText': "SELECT `code` FROM `empinfos` WHERE `code` LIKE '%:kw%'",
            'paramsJson': [{'name': 'kw', 'label': '工号', 'type': 'string'}],
            'paramValues': {'kw': ''}})
        d = r.get('data') or {}
        check('引号内参数为空串时等价于不过滤（返回全部行）',
              r.get('code') == 0 and int(d.get('rowCount') or 0) >= 2,
              str(d.get('rowCount')))
        r = post('/api/report/preview', {
            'connId': rpt_conn_id, 'databaseName': 'rogerorm',
            'sqlText': "SELECT '10:30' AS t, '2026-11-02' AS d", 'paramValues': {}})
        d = r.get('data') or {}
        rows = d.get('rows') or []
        check('字符串里的冒号不会被误当参数',
              r.get('code') == 0 and len(rows) == 1 and str(rows[0][0]).startswith('10:30'),
              str(rows)[:80])

        r = post('/api/report/preview', {'connId': rpt_conn_id, 'databaseName': 'rogerorm',
                                         'sqlText': 'DELETE FROM empinfos'})
        check('预览里执行写操作被拒绝',
              r.get('code') != 0 and '只允许执行查询' in (r.get('message') or ''),
              str(r.get('message'))[:90])
        r = post('/api/report/preview', {'connId': rpt_conn_id, 'databaseName': 'rogerorm',
                                         'sqlText': 'SELECT * FROM empinfos WHERE code = :nope'})
        check('SQL 里的参数没定义时给出提示',
              r.get('code') != 0 and '没有定义' in (r.get('message') or ''), str(r.get('message'))[:90])
        r = post('/api/report/preview', {'connId': rpt_conn_id, 'databaseName': 'rogerorm',
                                         'mainTable': 'empinfos',
                                         'paramsJson': [{'name': 'need', 'label': '必填项',
                                                         'required': True}],
                                         'columns': [{'field': 'code'}], 'paramValues': {}})
        check('必填参数没填时提示先填写',
              r.get('code') != 0 and '请先填写报表参数' in (r.get('message') or ''),
              str(r.get('message'))[:90])
        r = post('/api/report/preview', {'connId': rpt_conn_id, 'databaseName': 'rogerorm',
                                         'mainTable': 'empinfos',
                                         'paramsJson': [{'name': 'n', 'type': 'int', 'label': '数字'}],
                                         'columns': [{'field': 'code'}],
                                         'paramValues': {'n': 'abc'}})
        check('参数值类型不对时提示',
              r.get('code') != 0 and '应为整数' in (r.get('message') or ''), str(r.get('message'))[:90])
        r = post('/api/report/preview', {'connId': rpt_conn_id, 'databaseName': 'rogerorm'})
        check('没主表也没 SQL 时给出提示',
              r.get('code') != 0 and '拖进画布' in (r.get('message') or ''), str(r.get('message'))[:90])

        # ---- 调用（run）：按 id / code，累加 runCount ----
        r = post('/api/report/run', {'code': rpt_code, 'paramValues': {}})
        d = r.get('data') or {}
        check('按编码调用报表成功', r.get('code') == 0, str(r.get('message'))[:80])
        check('调用返回报表元信息（编码 / 名称）',
              (d.get('report') or {}).get('code') == rpt_code and
              (d.get('report') or {}).get('reportName') == '__报表自测__',
              str(d.get('report')))
        check('调用后 runCount 变为 1', int(d.get('runCount') or 0) == 1, str(d.get('runCount')))
        r = post('/api/report/run', {'id': rpt_id, 'paramValues': {}})
        check('按 id 调用后 runCount 变为 2',
              r.get('code') == 0 and int((r.get('data') or {}).get('runCount') or 0) == 2,
              str((r.get('data') or {}).get('runCount')))
        r = post('/api/report/run', {'code': 'RPT-NOT-EXIST'})
        check('调用不存在的报表返回 404',
              r.get('code') == 404 and '不存在' in (r.get('message') or ''), str(r.get('message'))[:80])

        # ---- 复制 / 更新 / 启停 ----
        r = post('/api/report/copy', {'id': rpt_id})
        d = r.get('data') or {}
        rpt_copy_id = str(d.get('id') or '')
        check('复制报表生成新的一条', r.get('code') == 0 and rpt_copy_id and rpt_copy_id != rpt_id,
              str(d.get('code')))
        check('复制出来的编码自动往后排', str(d.get('code') or '') != rpt_code, str(d.get('code')))
        check('复制出来的名称带「副本」', '副本' in str(d.get('reportName') or ''),
              str(d.get('reportName')))
        check('复制出来的默认停用', d.get('enabled') is False, str(d.get('enabled')))
        check('复制出来的创建人 = 执行复制的人（姓名 + 员工ID）',
              str(d.get('createEname') or '') == expect_creator and
              int(d.get('createempinfosid') or 0) == expect_emp_id,
              '%s / %s' % (d.get('createEname'), d.get('createempinfosid')))

        # 版本号相对「更新前」+1（前面 ispublic 用例已经加过版本，不能写死 2）
        _ver_before = int((get('/api/report/detail', {'id': rpt_id}).get('data') or {}).get('version') or 0)
        r = post('/api/report/update', {'id': rpt_id, 'reportName': '__报表自测（改）__',
                                        'connId': rpt_conn_id, 'databaseName': 'rogerorm',
                                        'mainTable': 'empinfos',
                                        'columns': [{'field': 'code', 'label': '工号'}],
                                        'params': [], 'template': {'paper': 'A4'},
                                        'description': long_desc})
        d = r.get('data') or {}
        check('更新报表成功且版本号 +1',
              r.get('code') == 0 and int(d.get('version') or 0) == _ver_before + 1,
              str(d.get('version')))
        check('更新后列数收敛到 1、参数清空',
              len(d.get('columns') or []) == 1 and len(d.get('params') or []) == 0,
              '%s / %s' % (len(d.get('columns') or []), len(d.get('params') or [])))
        desc = str(d.get('description') or '')
        check('功能介绍随更新保存（换行原样保留）',
              desc.startswith('第一行：接口自测用\n第二行：口径说明'), repr(desc)[:70])
        check('功能介绍超过 500 字时截断到 500', len(desc) == 500, str(len(desc)))
        check('局部更新没带分类时保留原分类（不被清空）',
              str(d.get('category') or '') == '自测分类', str(d.get('category')))
        check('更新时不覆盖创建人（姓名 + 员工ID）',
              str(d.get('createEname') or '') == expect_creator and
              int(d.get('createempinfosid') or 0) == expect_emp_id,
              '%s / %s' % (d.get('createEname'), d.get('createempinfosid')))
        check('更新时刷新修改人（姓名 + 员工ID = 当前登录人）',
              str(d.get('updateEname') or '') == expect_creator and
              int(d.get('updateempinfosid') or 0) == expect_emp_id,
              '%s / %s' % (d.get('updateEname'), d.get('updateempinfosid')))
        r = get('/api/report/detail', {'id': rpt_id})
        check('详情里的功能介绍与更新时一致',
              str((r.get('data') or {}).get('description') or '') == desc,
              repr(str((r.get('data') or {}).get('description') or ''))[:40])

        r = post('/api/report/enabled', {'id': rpt_id, 'enabled': 0})
        check('停用报表成功并返回提示',
              r.get('code') == 0 and '已停用' in str((r.get('data') or {}).get('message')),
              str((r.get('data') or {}).get('message'))[:60])
        r = post('/api/report/run', {'code': rpt_code})
        check('停用后的报表不能调用',
              r.get('code') != 0 and '停用' in (r.get('message') or ''), str(r.get('message'))[:80])
        r = post('/api/report/enabled', {'id': rpt_id, 'enabled': 1})
        check('重新启用报表成功',
              r.get('code') == 0 and '已启用' in str((r.get('data') or {}).get('message')),
              str((r.get('data') or {}).get('message'))[:60])

        # ---- 工具箱组件（设计区）+ 列标对齐 ----
        r = post('/api/report/add', {
            'reportName': '__组件自测', 'category': '自测分类', 'connId': rpt_conn_id,
            'databaseName': 'rogerorm', 'mainTable': 'empinfos',
            'sqlText': 'SELECT `code`, `nameCn` FROM `empinfos`',
            'columns': [{'field': 'code', 'label': '工号', 'headerAlign': 'left',
                         'align': 'left', 'format': 'text', 'summary': 'none'},
                        {'field': 'nameCn', 'label': '姓名', 'headerAlign': 'boom'}],
            'design': {'title': '组件自测', 'elements': [
                {'id': 'e1', 'kind': 'label', 'x': -20, 'y': 10, 'w': 5, 'h': 30,
                 'text': '九豆报表', 'fontSize': 99, 'bold': 1, 'align': 'right',
                 'color': 'red'},
                {'id': 'e2', 'kind': 'box', 'x': 10, 'y': 50, 'w': 400, 'h': 200,
                 'border': True, 'borderColor': '#DCDFE6', 'bg': '#FAFAFA',
                 'radius': 6, 'padding': 10, 'children': [
                     {'kind': 'table', 'x': 0, 'y': 0, 'w': 380, 'h': 120},
                     {'kind': 'chart', 'x': 0, 'y': 130, 'w': 380, 'h': 180,
                      'chartType': 'pie', 'title': '按姓名', 'categoryField': 'code',
                      'valueField': 'nameCn', 'legend': 0}
                 ]},
                {'kind': 'line', 'x': 0, 'y': 300, 'w': 600, 'h': 8,
                 'dir': 'v', 'thickness': 20, 'color': '#f56c6c'},
                {'kind': 'image', 'x': 0, 'y': 320, 'w': 120, 'h': 80,
                 'src': 'javascript:alert(1)'},
                {'kind': 'bad-kind', 'x': 0, 'y': 0, 'w': 10, 'h': 10}
            ]}})
        el_id = (r.get('data') or {}).get('id')
        check('新增带设计区组件的报表成功', r.get('code') == 0 and bool(el_id),
              str(r.get('message'))[:80])
        d = r.get('data') or {}
        els = ((d.get('design') or {}).get('elements') or [])
        check('组件按 kind 保存，非法 kind 被丢弃', len(els) == 4 and
              [one.get('kind') for one in els] == ['label', 'box', 'line', 'image'],
              str([one.get('kind') for one in els]))
        label = els[0] if els else {}
        check('坐标 / 尺寸夹到合理范围', label.get('x') == 0 and label.get('w') == 20,
              '%s / %s' % (label.get('x'), label.get('w')))
        check('字号夹到 8~48、颜色非法时回默认',
              label.get('fontSize') == 48 and label.get('color') == '#303133',
              '%s / %s' % (label.get('fontSize'), label.get('color')))
        check('加粗按布尔保存', label.get('bold') is True, str(label.get('bold')))
        box = els[1] if len(els) > 1 else {}
        check('区域的子组件一起保存（表格 + 图表）',
              len(box.get('children') or []) == 2 and
              [one.get('kind') for one in box.get('children') or []] == ['table', 'chart'],
              str([one.get('kind') for one in box.get('children') or []]))
        chart = (box.get('children') or [{}, {}])[-1]
        check('图表类型 / 字段 / 图例保存正确',
              chart.get('chartType') == 'pie' and chart.get('categoryField') == 'code' and
              chart.get('legend') is False,
              '%s / %s / %s' % (chart.get('chartType'), chart.get('categoryField'),
                                chart.get('legend')))
        table = (box.get('children') or [{}])[0]
        check('表格组件默认 3 行 3 列、首行表头',
              table.get('rows') == 3 and table.get('cols') == 3 and
              table.get('headerRow') is True,
              '%s/%s/%s' % (table.get('rows'), table.get('cols'), table.get('headerRow')))
        check('没传 cells 时补成 3×3 的空格子',
              len(table.get('cells') or []) == 3 and
              all(line == ['', '', ''] for line in (table.get('cells') or [])),
              str(table.get('cells'))[:80])

        # ---- 表格组件：行 / 列 / 单元格内容自己填 ----
        r = post('/api/report/update', {'id': el_id, 'design': {'elements': [
            {'kind': 'table', 'x': 0, 'y': 0, 'w': 300, 'h': 150, 'rows': 3, 'cols': 4,
             'headerRow': 1, 'align': 'center',
             'cells': [['工号', '姓名'], ['E01'], []]}]}})
        check('保存带自定义行列的表格成功', r.get('code') == 0, str(r.get('message'))[:80])
        r = get('/api/report/detail', {'id': el_id})
        tbl = (((r.get('data') or {}).get('design') or {}).get('elements') or [{}])[0]
        check('表格的行 / 列 / 表头 / 对齐都保存了',
              tbl.get('rows') == 3 and tbl.get('cols') == 4 and
              tbl.get('headerRow') is True and tbl.get('align') == 'center',
              '%s/%s/%s/%s' % (tbl.get('rows'), tbl.get('cols'),
                               tbl.get('headerRow'), tbl.get('align')))
        grid = tbl.get('cells') or []
        check('单元格按 3×4 补齐（缺的补空、多的截掉）',
              len(grid) == 3 and all(len(line) == 4 for line in grid) and
              grid[0][:2] == ['工号', '姓名'] and grid[0][3] == '' and grid[2] == ['', '', '', ''],
              str(grid))
        check('单元格内容原样保留（不再镜像报表列）',
              grid[1][0] == 'E01' and grid[1][1] == '', str(grid))

        r = post('/api/report/update', {'id': el_id, 'design': {'elements': [
            {'kind': 'table', 'x': 0, 'y': 0, 'w': 300, 'h': 150, 'cells': 'not-json'}]}})
        check('表格内容不是合法 JSON 时给出提示',
              r.get('code') != 0 and 'JSON' in (r.get('message') or ''),
              str(r.get('message'))[:80])

        r = post('/api/report/update', {'id': el_id, 'design': {'elements': [
            {'kind': 'table', 'x': 0, 'y': 0, 'w': 300, 'h': 150, 'rows': 0, 'cols': 99,
             'headerRow': 0, 'align': 'boom', 'cells': [['a'] * 12] * 40}]}})
        r = get('/api/report/detail', {'id': el_id})
        tbl = (((r.get('data') or {}).get('design') or {}).get('elements') or [{}])[0]
        check('表格行列夹到 1~30 / 1~10，非法对齐回 left、表头布尔化',
              tbl.get('rows') == 1 and tbl.get('cols') == 10 and
              tbl.get('align') == 'left' and tbl.get('headerRow') is False,
              '%s/%s/%s/%s' % (tbl.get('rows'), tbl.get('cols'),
                               tbl.get('align'), tbl.get('headerRow')))
        check('超出上限的行 / 列被截掉（只剩 1 × 10）',
              len(tbl.get('cells') or []) == 1 and len((tbl.get('cells') or [[]])[0]) == 10,
              '%d 行' % len(tbl.get('cells') or []))

        # ---- 表格「列头显示」（showHeader）----
        r = post('/api/report/update', {'id': el_id, 'design': {'elements': [
            {'kind': 'table', 'x': 0, 'y': 0, 'w': 300, 'h': 150, 'rows': 3, 'cols': 2,
             'showHeader': 0, 'headerRow': 1,
             'cells': [['列1', '列2'], ['A', 'B'], ['C', 'D']]}]}})
        r = get('/api/report/detail', {'id': el_id})
        tbl = (((r.get('data') or {}).get('design') or {}).get('elements') or [{}])[0]
        check('表格「列头显示」可以设成否', tbl.get('showHeader') is False, str(tbl.get('showHeader')))
        check('列头显示=否 时列头样式仍原样存着（改回来用）',
              tbl.get('headerRow') is True, str(tbl.get('headerRow')))
        r = post('/api/report/update', {'id': el_id, 'design': {'elements': [
            {'kind': 'table', 'x': 0, 'y': 0, 'w': 300, 'h': 150, 'rows': 2, 'cols': 2,
             'cells': [['A', 'B'], ['C', 'D']]}]}})
        r = get('/api/report/detail', {'id': el_id})
        tbl = (((r.get('data') or {}).get('design') or {}).get('elements') or [{}])[0]
        check('不传「列头显示」时默认是（兼容老数据）', tbl.get('showHeader') is True,
              str(tbl.get('showHeader')))

        # ---- 数据表行号（design.showRowNo）：预览参数可覆盖 ----
        r = post('/api/report/update', {'id': el_id, 'design': {'showRowNo': 1}})
        r = get('/api/report/detail', {'id': el_id})
        check('行号设置随设计保存（showRowNo=true）',
              ((r.get('data') or {}).get('design') or {}).get('showRowNo') is True,
              str(((r.get('data') or {}).get('design') or {}).get('showRowNo')))
        r = post('/api/report/preview', {'id': el_id, 'paramValues': {}, 'showRowNo': 0})
        check('预览请求里的 showRowNo 能覆盖设计里的值',
              ((r.get('data') or {}).get('design') or {}).get('showRowNo') is False,
              str(((r.get('data') or {}).get('design') or {}).get('showRowNo')))

        # ---- 页眉 / 页脚：文字对齐 + Logo ----
        r = post('/api/report/update', {
            'id': el_id,
            'design': {'headerText': '九豆综合管理平台', 'headerAlign': 'right',
                       'footerText': '制表：自测', 'footerAlign': 'boom'},
            'template': {'headerLogo': 'assets/logo.svg', 'headerLogoPos': 'right',
                         'headerLogoHeight': 999, 'footerLogo': 'javascript:alert(1)'}})
        check('页眉页脚文字与对齐保存成功', r.get('code') == 0, str(r.get('message'))[:80])
        r = get('/api/report/detail', {'id': el_id})
        d0 = r.get('data') or {}
        des0 = d0.get('design') or {}
        tpl0 = d0.get('template') or {}
        check('页眉文字落库', des0.get('headerText') == '九豆综合管理平台',
              str(des0.get('headerText')))
        check('页眉对齐按白名单保留（right）', des0.get('headerAlign') == 'right',
              str(des0.get('headerAlign')))
        check('非法页脚对齐归一为 center', des0.get('footerAlign') == 'center',
              str(des0.get('footerAlign')))
        check('页眉 Logo 地址与位置保存（贴右）',
              tpl0.get('headerLogo') == 'assets/logo.svg' and tpl0.get('headerLogoPos') == 'right',
              '%s / %s' % (tpl0.get('headerLogo'), tpl0.get('headerLogoPos')))
        check('Logo 高度夹到 12~120', tpl0.get('headerLogoHeight') == 120,
              str(tpl0.get('headerLogoHeight')))
        check('页脚 Logo 非法地址被清空', tpl0.get('footerLogo') == '',
              str(tpl0.get('footerLogo')))

        line = els[2] if len(els) > 2 else {}
        check('线条方向与粗细夹取', line.get('dir') == 'v' and line.get('thickness') == 8,
              '%s / %s' % (line.get('dir'), line.get('thickness')))
        img = els[3] if len(els) > 3 else {}
        check('图像地址白名单（javascript: 被清空）', img.get('src') == '', str(img.get('src')))
        cols = d.get('columns') or []
        check('列标对齐保存成功', cols and cols[0].get('headerAlign') == 'left',
              str(cols[0].get('headerAlign') if cols else None))
        check('非法列标对齐归一为 center',
              len(cols) > 1 and cols[1].get('headerAlign') == 'center',
              str(cols[1].get('headerAlign') if len(cols) > 1 else None))

        r = post('/api/report/update', {'id': el_id, 'design': {
            'elements': [
                {'kind': 'box', 'x': 0, 'y': 0, 'w': 400, 'h': 200, 'children': [
                    {'kind': 'box', 'x': 0, 'y': 0, 'w': 200, 'h': 100, 'children': [
                        {'kind': 'label', 'x': 0, 'y': 0, 'w': 100, 'h': 30, 'text': '太深了'}]}]}]}})
        check('区域嵌套超过上限时给出明确提示',
              r.get('code') != 0 and '嵌套' in (r.get('message') or ''),
              str(r.get('message'))[:80])

        r = post('/api/report/update', {'id': el_id, 'design': {
            'elements': [{'kind': 'label', 'text': 'x'}] * 61}})
        check('组件超过 60 个时被拒绝',
              r.get('code') != 0 and '最多' in (r.get('message') or ''),
              str(r.get('message'))[:80])

        r = post('/api/report/update', {'id': el_id, 'design': {'elements': 'not-json'}})
        check('组件字段不是合法 JSON 时给出提示',
              r.get('code') != 0 and 'JSON' in (r.get('message') or ''),
              str(r.get('message'))[:80])

        # 恢复成可导出的样子（后面导出用例会用到）
        r = post('/api/report/update', {'id': el_id, 'design': {'elements': []}})
        check('组件清空后保存成功', r.get('code') == 0, str(r.get('message'))[:80])
        r = post('/api/report/delete', {'id': el_id})
        check('删掉组件用例的报表', r.get('code') == 0, str(r)[:80])

        # ---- 导出 Excel / PDF：导的是「全部查询结果」 ----
        # 先把报表的 SQL 换回不带参数的一条（前面的用例把它改成了带 :kw 的语句并清空了参数定义）
        r = post('/api/report/update', {
            'id': rpt_id,
            'sqlText': 'SELECT `code`, `nameCn` FROM `empinfos` ORDER BY `code`',
            'columns': [{'field': 'code', 'label': '工号', 'width': 120},
                        {'field': 'nameCn', 'label': '姓名', 'width': 120}]})
        check('为导出用例准备一条可执行的报表 SQL', r.get('code') == 0, str(r.get('message'))[:80])
        r = post('/api/report/preview', {'id': rpt_id, 'paramValues': {}})
        preview_rows = int((r.get('data') or {}).get('rowCount') or 0)

        status, headers, body = request_raw('POST', '/api/report/export',
                                            {'id': rpt_id, 'format': 'excel'}, auth=False)
        check('无 token 导出被拒绝', status >= 400 or b'"code":401' in body[:200],
              str(status))
        status, headers, body = request_raw('POST', '/api/report/export',
                                            {'id': rpt_id, 'format': 'excel'})
        check('导出 Excel 返回 200', status == 200 and len(body) > 2000, '%s / %s' % (status, len(body)))
        check('导出 Excel 是真正的 .xlsx（PK 头）', body[:2] == b'PK', str(body[:8]))
        check('Excel 的 Content-Type 正确',
              'spreadsheetml' in str(headers.get('Content-Type') or ''), str(headers.get('Content-Type')))
        disp = str(headers.get('Content-Disposition') or '')
        check('Excel 附件名带报表编码与 .xlsx 后缀',
              'attachment' in disp and 'RPT' in disp and '.xlsx' in disp, disp[:120])
        check('Excel 的响应头带上导出行数，且等于预览行数',
              str(headers.get('X-Report-Row-Count')) == str(preview_rows),
              '%s / %s' % (headers.get('X-Report-Row-Count'), preview_rows))

        status, headers, body = request_raw('POST', '/api/report/export',
                                            {'id': rpt_id, 'format': 'pdf'})
        check('导出 PDF 返回 200', status == 200 and len(body) > 1000, '%s / %s' % (status, len(body)))
        check('导出 PDF 是真正的 PDF（%PDF 头）', body[:5] == b'%PDF-', str(body[:8]))
        check('PDF 的 Content-Type 为 application/pdf',
              'application/pdf' in str(headers.get('Content-Type') or ''), str(headers.get('Content-Type')))
        check('PDF 附件名以 .pdf 结尾', '.pdf' in str(headers.get('Content-Disposition') or ''),
              str(headers.get('Content-Disposition'))[:120])

        r = post('/api/report/export', {'id': rpt_id, 'format': 'csv'})
        check('不支持的导出格式给出提示',
              r.get('code') != 0 and '不支持的导出格式' in (r.get('message') or ''),
              str(r.get('message'))[:90])

        status, headers, body = request_raw('POST', '/api/report/export',
                                            {'id': 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                                             'format': 'excel'})
        check('导出不存在的报表给出 404 提示',
              b'\\xe4\\xb8\\x8d\\xe5\\xad\\x98\\xe5\\x9c\\xa8' in body or b'\\u4e0d\\u5b58\\u5728' in body
              or b'404' in body, body[:160].decode('utf-8', 'ignore'))

        # 未保存的报表（直接给数据源 + SQL + 列）也能导出
        status, headers, body = request_raw('POST', '/api/report/export', {
            'connId': rpt_conn_id, 'databaseName': 'rogerorm', 'format': 'excel',
            'sqlText': 'SELECT `code`, `nameCn` FROM `empinfos` ORDER BY `code`',
            'columns': [{'field': 'code', 'label': '工号', 'width': 120},
                        {'field': 'nameCn', 'label': '姓名', 'width': 120}]})
        check('未保存的报表也能直接导出（按请求里的 SQL 与列）',
              status == 200 and body[:2] == b'PK', '%s / %s' % (status, len(body)))

        # ---- 设计区组件（区域 + 子组件）：导出要按「页面上的位置」还原，不能错位 ----
        width_design = {'elements': [
            {'kind': 'label', 'x': 10, 'y': 6, 'w': 300, 'h': 28,
             'text': '区域标题', 'fontSize': 18, 'bold': True},
            {'kind': 'box', 'x': 10, 'y': 44, 'w': 520, 'h': 200, 'border': True, 'padding': 10,
             'children': [
                 {'kind': 'label', 'x': 0, 'y': 0, 'w': 200, 'h': 24, 'text': '区域内文字'},
                 {'kind': 'chart', 'x': 210, 'y': 0, 'w': 290, 'h': 180, 'chartType': 'bar',
                  'categoryField': 'code', 'valueField': 'code', 'title': '按工号统计'},
                 {'kind': 'table', 'x': 0, 'y': 30, 'w': 200, 'h': 150}]}]}
        r = post('/api/report/update', {'id': rpt_id, 'design': width_design})
        check('带区域组件的报表保存成功', r.get('code') == 0, str(r.get('message'))[:80])
        r = get('/api/report/detail', {'id': rpt_id})
        els = ((r.get('data') or {}).get('design') or {}).get('elements') or []
        box = els[1] if len(els) > 1 else {}
        check('组件随 designJson 落库（区域里有 3 个子组件）',
              len(els) == 2 and len((box or {}).get('children') or []) == 3,
              '%d / %s' % (len(els), len((box or {}).get('children') or [])))

        status, headers, body = request_raw('POST', '/api/report/export',
                                           {'id': rpt_id, 'format': 'excel'})
        check('带组件的报表也能导出 Excel', status == 200 and body[:2] == b'PK',
              '%s / %s' % (status, len(body)))
        if body[:2] == b'PK':
            zf = zipfile.ZipFile(io.BytesIO(body))
            names = zf.namelist()
            wbxml = zf.read('xl/workbook.xml').decode('utf-8')
            sheet2 = ''
            if 'xl/worksheets/sheet2.xml' in names:
                sheet2 = zf.read('xl/worksheets/sheet2.xml').decode('utf-8')
            check('Excel 多出一页「报表版式」还原组件位置', '报表版式' in wbxml, wbxml[:120])
            check('版式页里有原生图表（图表组件 → Excel 图表）',
                  any(one.startswith('xl/charts/') for one in names), str(names)[:160])
            check('版式页保留区域与标签的合并单元格', '<mergeCell ' in sheet2, str(len(sheet2)))
            zf.close()

        status, headers, body = request_raw('POST', '/api/report/export',
                                           {'id': rpt_id, 'format': 'pdf'})
        check('带组件的报表也能导出 PDF', status == 200 and body[:5] == b'%PDF-', str(status))
        check('PDF 里画上了组件（体积明显大于纯表格版）', len(body) > 3000, str(len(body)))

        r = post('/api/report/update', {'id': rpt_id, 'design': {'elements': []}})
        check('导出用例结束后清空组件', r.get('code') == 0, str(r.get('message'))[:80])

        # ---- 列表 / 分类 ----
        r = get('/api/report/list', {'keyword': '__报表自测', 'pageNum': 1, 'pageSize': 10})
        d = r.get('data') or {}
        check('按关键字能查到报表', r.get('code') == 0 and int(d.get('total') or 0) >= 1,
              str(d.get('total')))
        first = (d.get('list') or [{}])[0]
        check('列表带列数 / 参数个数 / 纸张方向等摘要',
              'columnCount' in first and 'paramCount' in first and 'paperText' in first,
              str(sorted(first.keys()))[:160])
        check('列表不返回设计 JSON 全文（只给摘要）',
              'columnsJson' not in first and 'designJson' not in first,
              str(sorted(first.keys()))[:160])
        r = get('/api/report/list', {'category': '自测分类', 'pageNum': 1, 'pageSize': 10})
        check('按分类筛选有效',
              r.get('code') == 0 and int((r.get('data') or {}).get('total') or 0) >= 1,
              str((r.get('data') or {}).get('total')))
        r = get('/api/report/categories')
        cats = {one.get('value') for one in ((r.get('data') or {}).get('list') or [])}
        check('分类聚合计入「自测分类」', r.get('code') == 0 and '自测分类' in cats, str(cats)[:120])
        r = get('/api/report/list', {'connId': rpt_conn_id, 'enabled': 1})
        check('按连接与启用状态筛选可用',
              r.get('code') == 0 and int((r.get('data') or {}).get('total') or 0) >= 1,
              str((r.get('data') or {}).get('total')))

        # 启用优先：停用的报表一律排到下部（组内仍按更新时间倒序）
        r = get('/api/report/list', {'keyword': '__报表自测', 'pageNum': 1, 'pageSize': 20})
        rows = (r.get('data') or {}).get('list') or []
        seen_off, order_bad, order_txt = False, '', []
        for one in rows:
            on = bool(one.get('enabled'))
            order_txt.append('%s%s' % (one.get('code'), '(启用)' if on else '(停用)'))
            if not on:
                seen_off = True
            elif seen_off:
                order_bad = str(one.get('code'))
        check('设计器清单启用优先：停用的自动沉到下部',
              len(rows) >= 2 and not order_bad, ','.join(order_txt))

        # ---- 报表中心：只查启用状态的报表 ----
        r = request('GET', '/api/report/center', None, auth=False)
        check('报表中心需要登录 token', r.get('code') == 401, str(r)[:80])

        r = get('/api/report/center', {'keyword': '__报表自测', 'pageNum': 1, 'pageSize': 10})
        d = r.get('data') or {}
        check('报表中心能查到启用中的报表',
              r.get('code') == 0 and int(d.get('total') or 0) >= 1, str(d.get('total')))
        first = (d.get('list') or [{}])[0]
        check('报表中心返回的报表都是启用状态', first.get('enabled') is True, str(first.get('enabled')))
        check('报表中心不返回设计 JSON 全文（只给摘要）',
              'designJson' not in first and 'columnsJson' not in first,
              str(sorted(first.keys()))[:160])

        # 停用 → 报表中心查不到，但设计器清单里仍在
        r = post('/api/report/enabled', {'id': rpt_id, 'enabled': 0})
        check('把测试报表停用', r.get('code') == 0, str(r)[:80])
        r = get('/api/report/center', {'keyword': '__报表自测', 'pageNum': 1, 'pageSize': 10})
        check('停用的报表在报表中心查不到',
              r.get('code') == 0 and int((r.get('data') or {}).get('total') or 0) == 0,
              str((r.get('data') or {}).get('total')))
        r = get('/api/report/center', {'pageNum': 1, 'pageSize': 1})
        cats = {one.get('value') for one in ((r.get('data') or {}).get('categories') or [])}
        check('停用后报表中心的分类聚合里也没有它', '自测分类' not in cats, str(cats)[:160])
        r = get('/api/report/list', {'keyword': '__报表自测', 'pageNum': 1, 'pageSize': 10})
        check('停用的报表仍在设计器清单里（可继续编辑 / 启用）',
              int((r.get('data') or {}).get('total') or 0) >= 1,
              str((r.get('data') or {}).get('total')))
        r = get('/api/report/center', {'keyword': '__报表自测', 'enabled': 0})
        check('报表中心忽略客户端传来的 enabled=0（永远只给启用的）',
              int((r.get('data') or {}).get('total') or 0) == 0,
              str((r.get('data') or {}).get('total')))
        r = get('/api/report/center', {'keyword': '__报表自测', 'enabled': 1})
        check('传 enabled=1 也还是查不到停用报表',
              int((r.get('data') or {}).get('total') or 0) == 0,
              str((r.get('data') or {}).get('total')))

        r = post('/api/report/enabled', {'id': rpt_id, 'enabled': 1})
        check('把测试报表恢复为启用', r.get('code') == 0, str(r)[:80])
        r = get('/api/report/center', {'keyword': '__报表自测', 'pageNum': 1, 'pageSize': 10})
        check('恢复启用后报表中心又能查到',
              int((r.get('data') or {}).get('total') or 0) >= 1,
              str((r.get('data') or {}).get('total')))
        r = get('/api/report/center', {'pageNum': 1, 'pageSize': 1})
        cats = {one.get('value') for one in ((r.get('data') or {}).get('categories') or [])}
        check('报表中心的分类聚合只统计启用报表', '自测分类' in cats, str(cats)[:160])
        r = get('/api/report/center', {'category': '自测分类', 'pageNum': 1, 'pageSize': 10})
        check('报表中心按分类检索有效',
              r.get('code') == 0 and int((r.get('data') or {}).get('total') or 0) >= 1,
              str((r.get('data') or {}).get('total')))
        r = get('/api/report/center', {'keyword': '__报表自测', 'category': '不存在的分类'})
        check('报表中心关键词 + 分类是「与」关系',
              int((r.get('data') or {}).get('total') or 0) == 0,
              str((r.get('data') or {}).get('total')))
    finally:
        for one in (rpt_copy_id, rpt_id):
            if one:
                r = post('/api/report/delete', {'id': one})
                check('删掉报表测试数据', r.get('code') == 0, str(r)[:80])
        r = post('/api/dbinfo/delete', {'id': rpt_conn_id})
        check('删掉报表用例的测试连接', r.get('code') == 0, str(r)[:80])

    # ===================== 8.9 项目管理：项目信息 / 项目文件 =====================
    print('\n--- 8.9 项目管理（项目信息 / 项目文件） ---')
    import base64 as _b64
    import os as _os
    import uuid as _uuid
    _server_dir = _os.path.dirname(_os.path.abspath(__file__))
    if _server_dir not in sys.path:
        sys.path.insert(0, _server_dir)
    from db import execute as _sql

    PJ_TAG = '__接口自测项目__'
    pj_id, pf_id = '', ''
    ghost_pj, ghost_pf = '', ''
    # 清掉上次异常中断可能留下的测试数据
    _old = get('/api/project/list', {'keyword': PJ_TAG, 'pageSize': 200}).get('data') or {}
    for _it in (_old.get('list') or []):
        post('/api/project/delete', {'id': _it.get('id')})

    try:
        d = get('/api/project/types').get('data') or {}
        check('项目类型取自系统字典 project_type（9 项，含研发 / 数据分析 / 科研 / 其它）',
              d.get('typeSource') == 'dict' and d.get('typeDictNameEn') == 'project_type' and
              len(d.get('types') or []) == 9 and
              all(x in (d.get('types') or []) for x in ('研发', '数据分析', '科研', '其它')),
              str(d.get('types')))
        check('项目状态 5 种', len(d.get('statuses') or []) == 5, str(d.get('statuses')))
        nc = get('/api/project/nextcode').get('data') or {}
        check('项目编号规则 PRO + 6 位流水号',
              re.match(r'^PRO\d{6}$', str(nc.get('code') or '')) is not None, str(nc))

        r = post('/api/project/add', {
            'projectName': PJ_TAG, 'projectType': '研发', 'projectStatus': '进行中',
            'projectDesc': '接口自测说明', 'ispub': 0, 'enabled': 1,
            'projectCode': 'PRO999999'          # 前端伪造的编号必须被忽略
        })
        p = r.get('data') or {}
        pj_id = p.get('id') or ''
        check('新增项目成功且由后端自动生成编号',
              r.get('code') == 0 and re.match(r'^PRO\d{6}$', str(p.get('projectCode') or '')) is not None,
              str(p.get('projectCode')))
        check('前端传入的 projectCode 被忽略', p.get('projectCode') != 'PRO999999',
              str(p.get('projectCode')))
        check('创建人 / 创建人ID / 创建时间由后端自动带入',
              bool(p.get('createEname')) and int(p.get('createempinfosid') or 0) > 0 and
              bool(p.get('createTime')), str(p.get('createEname')))
        check('私有项目 ispub 返回 false', p.get('ispub') is False, str(p.get('ispub')))
        check('项目名称重复被拒',
              post('/api/project/add', {'projectName': PJ_TAG, 'projectType': '研发'}).get('code') != 0)
        check('非法项目类型被拒',
              post('/api/project/add', {'projectName': PJ_TAG + 'X',
                                       'projectType': '不存在'}).get('code') != 0)
        check('非法项目状态被拒',
              post('/api/project/add', {'projectName': PJ_TAG + 'Y',
                                       'projectStatus': '不存在'}).get('code') != 0)
        check('项目名称唯一性校验',
              (get('/api/project/check', {'field': 'projectName', 'value': PJ_TAG})
               .get('data') or {}).get('unique') is False)

        d = get('/api/project/list', {'keyword': PJ_TAG}).get('data') or {}
        check('列表检索到新项目且带文件数 / 公用否文案',
              int(d.get('total') or 0) == 1 and
              'fileCount' in (d.get('list') or [{}])[0] and
              (d.get('list') or [{}])[0].get('ispubText') == '私有', str(d)[:160])
        check('类型统计与列表同口径', (d.get('stats') or {}).get('研发', 0) >= 1, str(d.get('stats')))
        check('按类型筛选生效',
              int((get('/api/project/list', {'keyword': PJ_TAG, 'projectType': '实施'})
                   .get('data') or {}).get('total') or 0) == 0)
        check('按状态筛选生效',
              int((get('/api/project/list', {'keyword': PJ_TAG, 'projectStatus': '进行中'})
                   .get('data') or {}).get('total') or 0) == 1)
        check('按公用否筛选生效',
              int((get('/api/project/list', {'keyword': PJ_TAG, 'ispub': 0})
                   .get('data') or {}).get('total') or 0) == 1)
        check('项目详情返回完整字段',
              (get('/api/project/detail', {'id': pj_id}).get('data') or {}).get('projectName') == PJ_TAG)
        opts = (get('/api/project/options', {'keyword': PJ_TAG}).get('data') or {}).get('list') or []
        check('项目下拉含本人创建的项目', any(x.get('id') == pj_id for x in opts), str(opts)[:120])

        # —— 可见性：直接塞一条「他人私有」项目，接口必须查不到 ——
        ghost_pj = str(_uuid.uuid4())
        ghost_code = 'PRO' + (''.join(c for c in ghost_pj if c.isdigit()) + '000000')[:6]
        _sql('INSERT INTO `projectinfos` '
             '(`id`,`projectCode`,`projectName`,`projectType`,`projectStatus`,`ispub`,'
             ' `createempinfosid`,`createEname`,`enabled`) '
             'VALUES (%s,%s,%s,%s,%s,0,999999,%s,1)',
             (ghost_pj, ghost_code, PJ_TAG + '他人私有', '其它', '进行中', '别人'))
        check('他人私有项目不出现在列表',
              int((get('/api/project/list', {'keyword': PJ_TAG + '他人私有'})
                   .get('data') or {}).get('total') or 0) == 0)
        check('他人私有项目详情被拒（404）',
              get('/api/project/detail', {'id': ghost_pj}).get('code') == 404)
        _ghost_opts = (get('/api/project/options', {'keyword': '他人私有'}).get('data') or {}).get('list') or []
        check('他人私有项目不进项目下拉', all(x.get('id') != ghost_pj for x in _ghost_opts))

        r = post('/api/project/update', {
            'id': pj_id, 'projectName': PJ_TAG + '（改）', 'projectType': '实施',
            'projectStatus': '已完成', 'projectDesc': '改后说明', 'ispub': 1,
            'projectCode': 'PRO888888'
        })
        p2 = r.get('data') or {}
        check('编辑项目成功且类型 / 状态 / 公用否已更新',
              r.get('code') == 0 and p2.get('projectType') == '实施' and
              p2.get('projectStatus') == '已完成' and p2.get('ispub') is True, str(r)[:160])
        check('编辑不能改项目编号', p2.get('projectCode') == p.get('projectCode'),
              str(p2.get('projectCode')))
        check('停用项目成功',
              (post('/api/project/enabled', {'id': pj_id, 'enabled': 0})
               .get('data') or {}).get('enabled') is False)
        check('启用项目成功',
              (post('/api/project/enabled', {'id': pj_id, 'enabled': 1})
               .get('data') or {}).get('enabled') is True)

        # —— 项目文件 ——
        ftypes = (get('/api/projectfile/types').get('data') or {}).get('types') or []
        check('文件类型 7 种', len(ftypes) == 7 and '设计稿' in ftypes, str(ftypes))
        raw = '项目文件接口自测内容'.encode('utf-8')
        b64 = _b64.b64encode(raw).decode('ascii')
        r = post('/api/projectfile/upload', {
            'projectId': pj_id, 'fileName': '自测文件.txt', 'fileType': '文档',
            'fileDesc': '接口自测', 'ispub': 0, 'enabled': 1,
            'fileSize': len(raw), 'data': 'data:text/plain;base64,' + b64
        })
        f = r.get('data') or {}
        pf_id = f.get('id') or ''
        check('上传文件成功并返回 filePath / downloadUrl',
              r.get('code') == 0 and str(f.get('filePath') or '').startswith('data/projectfiles/') and
              str(f.get('downloadUrl') or '').startswith('/data/projectfiles/'), str(r)[:180])
        check('文件大小按实际字节记录（不是前端传值）',
              f.get('fileSize') == len(raw), str(f.get('fileSize')))
        check('项目编号 / 名称快照带入文件表',
              f.get('projectCode') == p.get('projectCode') and
              f.get('projectName') == PJ_TAG + '（改）', str(f.get('projectName')))
        check('上传人由后端自动带入', bool(f.get('uploadEname')) and
              int(f.get('uploadempinfosid') or 0) > 0, str(f.get('uploadEname')))
        check('上传到他人私有项目被拒',
              post('/api/projectfile/upload', {
                  'projectId': ghost_pj, 'fileName': 'x.txt', 'data': b64
              }).get('code') != 0)
        try:
            with urllib.request.urlopen(BASE + str(f.get('downloadUrl')), timeout=10) as _resp:
                _body = _resp.read()
            check('静态路径可下载且内容一致', _body.decode('utf-8', 'ignore') == raw.decode('utf-8'))
        except Exception as _exc:
            check('静态路径可下载且内容一致', False, str(_exc))

        d = get('/api/projectfile/list', {'projectId': pj_id}).get('data') or {}
        check('文件列表按项目筛选到 1 条', int(d.get('total') or 0) == 1, str(d)[:120])
        check('文件类型统计同口径', (d.get('stats') or {}).get('文档', 0) >= 1, str(d.get('stats')))
        check('文件列表含大小文案 / 下载地址',
              bool((d.get('list') or [{}])[0].get('fileSizeText')) and
              bool((d.get('list') or [{}])[0].get('downloadUrl')))
        check('按文件类型筛选生效',
              int((get('/api/projectfile/list', {'projectId': pj_id, 'fileType': '图片'})
                   .get('data') or {}).get('total') or 0) == 0)
        check('按关键字筛选生效',
              int((get('/api/projectfile/list', {'projectId': pj_id, 'keyword': '自测文件'})
                   .get('data') or {}).get('total') or 0) == 1)
        check('文件详情可查',
              (get('/api/projectfile/detail', {'id': pf_id}).get('data') or {}).get('fileName') == '自测文件.txt')
        check('下载地址接口带可见性校验',
              (get('/api/projectfile/download', {'id': pf_id}).get('data') or {}).get('downloadUrl') ==
              f.get('downloadUrl'))

        # —— 右栏文件列表按文件名排序（项目信息页左右分栏配套，2026-11-05） ——
        _sql('INSERT INTO `projectfiles` '
             '(`id`,`projectId`,`projectCode`,`projectName`,`fileType`,`fileName`,`filePath`,'
             ' `fileSize`,`ispub`,`uploadempinfosid`,`uploadEname`,`enabled`,`uploadTime`) '
             'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,1,%s,%s,1,%s)',
             (str(_uuid.uuid4()), pj_id, p.get('projectCode'), p.get('projectName'), '文档',
              PJ_TAG + 'A排序.txt', 'data/projectfiles/demo/sort.txt', 12,
              int(f.get('uploadempinfosid') or 0), '自测上传人', '2020-01-01 00:00:00'))
        _names = [x.get('fileName') for x in
                  ((get('/api/projectfile/list',
                        {'projectId': pj_id, 'orderBy': 'fileName'}).get('data') or {}).get('list') or [])]
        check('orderBy=fileName 按文件名升序（A排序 在 自测文件 之前）',
              len(_names) == 2 and _names[0] == PJ_TAG + 'A排序.txt', str(_names))
        _names2 = [x.get('fileName') for x in
                   ((get('/api/projectfile/list',
                         {'projectId': pj_id}).get('data') or {}).get('list') or [])]
        check('默认排序仍按上传时间倒序（自测文件 在前）',
              len(_names2) == 2 and _names2[0] == '自测文件.txt', str(_names2))
        _sql('DELETE FROM `projectfiles` WHERE `fileName`=%s', (PJ_TAG + 'A排序.txt',))

        # —— 可见性：他人私有文件 ——
        ghost_pf = str(_uuid.uuid4())
        _sql('INSERT INTO `projectfiles` '
             '(`id`,`projectId`,`projectCode`,`projectName`,`fileType`,`fileName`,`filePath`,'
             ' `fileSize`,`ispub`,`uploadempinfosid`,`uploadEname`,`enabled`) '
             'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,0,999999,%s,1)',
             (ghost_pf, pj_id, 'PRO999000', '他人私有文件', '文档',
              PJ_TAG + '他人私有.txt', 'data/projectfiles/demo/ghost.txt', 12, '别人'))
        check('他人私有文件不出现在列表',
              int((get('/api/projectfile/list', {'keyword': PJ_TAG + '他人私有'})
                   .get('data') or {}).get('total') or 0) == 0)
        check('他人私有文件详情被拒',
              get('/api/projectfile/detail', {'id': ghost_pf}).get('code') == 404)
        check('他人私有文件下载被拒',
              get('/api/projectfile/download', {'id': ghost_pf}).get('code') == 404)

        r = post('/api/projectfile/update', {'id': pf_id, 'fileType': '文档',
                                            'fileDesc': '改后说明', 'ispub': 1})
        f2 = r.get('data') or {}
        check('编辑文件元数据成功且路径 / 名称不变',
              r.get('code') == 0 and f2.get('fileName') == '自测文件.txt' and
              f2.get('filePath') == f.get('filePath') and f2.get('fileDesc') == '改后说明', str(r)[:160])
        check('停用文件成功',
              (post('/api/projectfile/enabled', {'id': pf_id, 'enabled': 0})
               .get('data') or {}).get('enabled') is False)
        check('停用文件不能下载',
              get('/api/projectfile/download', {'id': pf_id}).get('code') != 0)
        check('启用文件后恢复下载',
              (post('/api/projectfile/enabled', {'id': pf_id, 'enabled': 1})
               .get('data') or {}).get('enabled') is True and
              get('/api/projectfile/download', {'id': pf_id}).get('code') == 0)
        check('删除文件成功', post('/api/projectfile/delete', {'id': pf_id}).get('code') == 0)
        pf_id = ''

        # 重新上传一个文件，验证删除项目会级联清理
        r = post('/api/projectfile/upload', {
            'projectId': pj_id, 'fileName': '待级联清理.txt', 'fileType': '文档',
            'data': b64, 'fileSize': len(raw)
        })
        check('级联测试：再上传 1 个文件', r.get('code') == 0, str(r)[:120])
        r = post('/api/project/delete', {'id': pj_id})
        check('删除项目级联清理项目文件',
              r.get('code') == 0 and int((r.get('data') or {}).get('deletedFiles') or 0) >= 1,
              str(r)[:160])
        pj_id = ''
        check('级联后文件列表为空',
              int((get('/api/projectfile/list', {'keyword': '待级联清理'})
                   .get('data') or {}).get('total') or 0) == 0)
        check('项目编号删除后可被复用（取最大流水 +1）',
              re.match(r'^PRO\d{6}$',
                       str((get('/api/project/nextcode').get('data') or {}).get('code') or '')) is not None)
        h = get('/api/health').get('data') or {}
        check('健康检查带项目 / 项目文件表计数',
              'projectCount' in h and 'projectFileCount' in h, str(h)[:160])

        # —— 菜单 / 导航 / 首页卡片（首页按 /api/nav 的顶级菜单组动态渲染） ——
        from db import query_one as _one
        check('菜单表含「项目信息 / 项目文件」两个功能页',
              int(_one("SELECT COUNT(*) AS n FROM `menuinfros` "
                       "WHERE `path` IN ('project.html','project-file.html') AND `enabled`=1")['n']) == 2)
        # 组已更名为「项目中心」，且后续又挂了工作计划 / 我的任务 / 需求管理，
        # 因此这里只断言「项目信息 / 项目文件」两页确实绑在本组内，
        # 授权则按「组内全部启用菜单项都被覆盖」动态核对（逐项授权或整组 menuItemId=0 都算）。
        check('「项目中心」菜单组已绑定「项目信息 / 项目文件」两个页面',
              int(_one("SELECT COUNT(*) AS n FROM `menugroupitemset` s "
                       "JOIN `menugroupinfos` g ON g.`id`=s.`groupId` "
                       "JOIN `menuinfros` m ON m.`id`=s.`itemId` "
                       "WHERE g.`code`='MNG1006' AND s.`enabled`=1 AND m.`enabled`=1 "
                       "AND m.`path` IN ('project.html','project-file.html')")['n']) == 2)
        check('系统管理员已获「项目中心」组内全部页面的授权（逐项或整组）',
              int(_one("SELECT COUNT(DISTINCT s.`itemId`) AS n FROM `menugroupitemset` s "
                       "JOIN `menugroupinfos` g ON g.`id`=s.`groupId` "
                       "JOIN `menuinfros` m ON m.`id`=s.`itemId` AND m.`enabled`=1 "
                       "JOIN `usergrouppowerset` p ON p.`menuGroupId`=g.`id` AND p.`enabled`=1 "
                       " AND (p.`menuItemId`=0 OR p.`menuItemId`=s.`itemId`) "
                       "JOIN `usergroup` r ON r.`id`=p.`roleId` AND r.`nameEn`='SystemAdmin' "
                       "WHERE g.`code`='MNG1006' AND s.`enabled`=1")['n'])
              == int(_one("SELECT COUNT(*) AS n FROM `menugroupitemset` s "
                          "JOIN `menugroupinfos` g ON g.`id`=s.`groupId` "
                          "JOIN `menuinfros` m ON m.`id`=s.`itemId` AND m.`enabled`=1 "
                          "WHERE g.`code`='MNG1006' AND s.`enabled`=1")['n']))
        nav_data = get('/api/nav', {
            'roleId': 'a1b2c3d4-0001-4a1b-8c00-000000000001'
        }).get('data') or {}
        nav_text = json.dumps(nav_data.get('groups') or [], ensure_ascii=False)
        check('左侧导航（首页卡片同源）含「项目管理」与两个功能页',
              '项目管理' in nav_text and 'project.html' in nav_text and
              'project-file.html' in nav_text, nav_text[:180])
    finally:
        if pf_id:
            post('/api/projectfile/delete', {'id': pf_id})
        if pj_id:
            post('/api/project/delete', {'id': pj_id})
        if ghost_pf:
            _sql('DELETE FROM `projectfiles` WHERE `id`=%s', (ghost_pf,))
        if ghost_pj:
            _sql('DELETE FROM `projectinfos` WHERE `id`=%s', (ghost_pj,))

    # ===================== 8.10 系统配置：系统字典 / 字典键值 / 系统参数 =========
    print('\n--- 8.10 系统配置（sysdict / sysdictitems / syspara） ---')
    from db import query_all as _all, query_one as _one
    SC_TAG = '__接口自测系统配置__'

    def sc_cleanup():
        """按测试标记清理残留（真实库里可能有业务数据，只删本次标记的记录）"""
        for tbl, field in (('sysdictitems', 'itemValue'), ('sysdict', 'dictNameCn'),
                           ('syspara', 'paraNameCn')):
            try:
                for row in (_all('SELECT `id`,`%s` AS nm FROM `%s`' % (field, tbl)) or []):
                    if SC_TAG in str(row.get('nm') or ''):
                        _sql('DELETE FROM `%s` WHERE `id`=%%s' % tbl, (row['id'],))
            except Exception as exc:
                print('  [WARN] 清理 %s 残留失败：%s' % (tbl, exc))

    sc_cleanup()                      # 上次异常中断可能留下测试数据
    try:
        # ---------- 系统字典：新增 / UUID 主键 / 展示字段 ----------
        r = post('/api/sysdict/add', {
            'dictNameCn': SC_TAG + '父字典', 'dictNameEn': 'sc_test_parent',
            'sortNo': 1, 'remark': '接口自测：父字典', 'enabled': 1
        })
        a = r.get('data') or {}
        a_id = a.get('id') or ''
        check('新增系统字典成功且主键是 UUID',
              r.get('code') == 0 and re.match(
                  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                  str(a_id)) is not None, str(a_id))
        check('字典返回全部业务字段（中文名 / 英文名 / 上级 / 序号 / 说明 / 启用否 / 时间）',
              all(k in a for k in ('dictNameCn', 'dictNameEn', 'parentId', 'sortNo',
                                   'remark', 'enabled', 'createTime', 'updateTime')), str(a)[:180])
        check('字典补扩展展示字段 level / parentName / pathNames / itemCount',
              all(k in a for k in ('level', 'parentName', 'pathNames', 'itemCount')) and
              a.get('level') == 1 and a.get('itemCount') == 0, str(a.get('level')))
        check('顶级字典 parentId 为空、parentName 为空',
              not a.get('parentId') and not a.get('parentName'), str(a.get('parentId')))
        check('启用否返回布尔值', a.get('enabled') is True, str(a.get('enabled')))

        # ---------- 校验：必填 / 英文名格式 / 唯一 ----------
        check('键中文名为空被拒',
              post('/api/sysdict/add', {'dictNameEn': 'sc_test_no_cn'}).get('code') != 0)
        check('键英文名为空被拒',
              post('/api/sysdict/add', {'dictNameCn': SC_TAG + '空英文名'}).get('code') != 0)
        check('英文名以数字开头被拒',
              post('/api/sysdict/add', {'dictNameCn': SC_TAG + '数字开头',
                                       'dictNameEn': '1abc'}).get('code') != 0)
        check('英文名含中文被拒',
              post('/api/sysdict/add', {'dictNameCn': SC_TAG + '中文名',
                                       'dictNameEn': 'sc_中文'}).get('code') != 0)
        check('英文名含空格被拒',
              post('/api/sysdict/add', {'dictNameCn': SC_TAG + '空格名',
                                       'dictNameEn': 'sc test'}).get('code') != 0)
        check('中文名超过 150 字被拒',
              post('/api/sysdict/add', {'dictNameCn': SC_TAG + '超长' + 'x' * 150,
                                       'dictNameEn': 'sc_test_too_long_cn'}).get('code') != 0)
        check('英文名重复被拒（全局唯一）',
              post('/api/sysdict/add', {'dictNameCn': SC_TAG + '重名',
                                       'dictNameEn': 'sc_test_parent'}).get('code') != 0)
        check('check 已存在英文名返回 unique=false',
              (get('/api/sysdict/check', {'field': 'dictNameEn', 'value': 'sc_test_parent'})
               .get('data') or {}).get('unique') is False)
        check('check 新英文名返回 unique=true',
              (get('/api/sysdict/check', {'field': 'dictNameEn', 'value': 'sc_test_never_used'})
               .get('data') or {}).get('unique') is True)
        check('check 编辑自身时不算重复',
              (get('/api/sysdict/check', {'field': 'dictNameEn', 'value': 'sc_test_parent',
                                         'id': a_id}).get('data') or {}).get('unique') is True)
        check('check 不支持的字段被拒',
              get('/api/sysdict/check', {'field': 'remark', 'value': 'x'}).get('code') != 0)
        check('detail 返回完整字典',
              (get('/api/sysdict/detail', {'id': a_id}).get('data') or {}).get('dictNameEn') ==
              'sc_test_parent')
        check('detail 非法 id 被拒',
              get('/api/sysdict/detail', {'id': 'abc'}).get('code') != 0)
        check('detail 不存在的 UUID 返回 404',
              get('/api/sysdict/detail', {'id': str(_uuid.uuid4())}).get('code') == 404)

        # ---------- 树形上级：层级 / 防自身 / 防环 ----------
        r = post('/api/sysdict/add', {
            'dictNameCn': SC_TAG + '子字典', 'dictNameEn': 'sc_test_child',
            'parentId': a_id, 'sortNo': 2, 'enabled': 1
        })
        b = r.get('data') or {}
        b_id = b.get('id') or ''
        check('子字典新增成功并挂在父字典下',
              r.get('code') == 0 and b.get('parentId') == a_id, str(b.get('parentId')))
        check('子字典 level=2 / parentName / pathNames 已补全',
              b.get('level') == 2 and SC_TAG + '父字典' in str(b.get('parentName')) and
              SC_TAG + '父字典' in str(b.get('pathNames')),
              str(b.get('level')) + '/' + str(b.get('parentName')))
        check('上级字典不存在被拒（404）',
              post('/api/sysdict/add', {'dictNameCn': SC_TAG + '孤儿',
                                       'dictNameEn': 'sc_test_orphan',
                                       'parentId': str(_uuid.uuid4())}).get('code') == 404)
        check('上级字典不能是自己',
              post('/api/sysdict/update', {'id': b_id, 'parentId': b_id}).get('code') != 0)
        check('不能把字典移动到自己的下级字典之下（防环）',
              post('/api/sysdict/update', {'id': a_id, 'parentId': b_id}).get('code') != 0)
        tree = (get('/api/sysdict/tree').get('data') or {}).get('list') or []
        tmap = dict((str(x.get('id')), x) for x in tree)
        check('字典树包含父子两级且子级带缩进',
              a_id in tmap and b_id in tmap and tmap[b_id].get('level') == 2 and
              '└' in str(tmap[b_id].get('label')), str(tmap.get(b_id))[:140])
        check('字典树父节点 childCount=1 / leaf=false',
              int(tmap[a_id].get('childCount') or 0) == 1 and tmap[a_id].get('leaf') is False,
              str(tmap[a_id].get('childCount')))
        ex_tree = (get('/api/sysdict/tree', {'excludeId': a_id}).get('data') or {}).get('list') or []
        ex_ids = [str(x.get('id')) for x in ex_tree]
        check('tree(excludeId) 排除自身与全部后代',
              a_id not in ex_ids and b_id not in ex_ids, str(ex_ids)[:120])

        # ---------- 停用字典 / options / 列表筛选 / 排序 ----------
        r = post('/api/sysdict/add', {
            'dictNameCn': SC_TAG + '停用字典', 'dictNameEn': 'sc_test_off',
            'sortNo': 3, 'enabled': 0
        })
        c_id = (r.get('data') or {}).get('id') or ''
        check('可新增停用状态的字典',
              r.get('code') == 0 and (r.get('data') or {}).get('enabled') is False, str(r)[:120])
        opts = (get('/api/sysdict/options').get('data') or {}).get('list') or []
        opt_ids = [str(x.get('id')) for x in opts]
        check('options 只含启用字典（不含停用字典）',
              a_id in opt_ids and b_id in opt_ids and c_id not in opt_ids, str(opt_ids)[:140])
        check('options 每项带 label（中文名（英文名））',
              all('（' in str(x.get('label')) for x in opts if x.get('id') in (a_id, b_id)))
        d = get('/api/sysdict/list', {'keyword': SC_TAG}).get('data') or {}
        check('列表关键字检索命中 3 条测试字典',
              int(d.get('total') or 0) == 3 and len(d.get('list') or []) == 3, str(d)[:160])
        check('列表按 sortNo 升序（父1 / 子2 / 停用3）',
              [str(x.get('id')) for x in (d.get('list') or [])] == [a_id, b_id, c_id],
              str([x.get('sortNo') for x in (d.get('list') or [])]))
        check('按上级字典筛选只出子字典',
              int((get('/api/sysdict/list', {'keyword': SC_TAG, 'parentId': a_id})
                   .get('data') or {}).get('total') or 0) == 1)
        check('按启用状态=1 筛选 2 条',
              int((get('/api/sysdict/list', {'keyword': SC_TAG, 'enabled': 1})
                   .get('data') or {}).get('total') or 0) == 2)
        check('按启用状态=0 筛选 1 条',
              int((get('/api/sysdict/list', {'keyword': SC_TAG, 'enabled': 0})
                   .get('data') or {}).get('total') or 0) == 1)
        check('分页参数生效（pageSize=2 只回 2 条 / pages=2）',
              len((get('/api/sysdict/list', {'keyword': SC_TAG, 'pageSize': 2})
                   .get('data') or {}).get('list') or []) == 2 and
              int((get('/api/sysdict/list', {'keyword': SC_TAG, 'pageSize': 2})
                   .get('data') or {}).get('pages') or 0) == 2)

        r = post('/api/sysdict/update', {
            'id': a_id, 'dictNameCn': SC_TAG + '父字典（改）',
            'sortNo': 5, 'remark': '改后说明', 'enabled': 0
        })
        a2 = r.get('data') or {}
        check('编辑字典成功且中文名 / 序号 / 说明 / 启用否已更新',
              r.get('code') == 0 and a2.get('dictNameCn') == SC_TAG + '父字典（改）' and
              a2.get('sortNo') == 5 and a2.get('remark') == '改后说明' and
              a2.get('enabled') is False, str(r)[:180])
        check('编辑时未传英文名则保持原值', a2.get('dictNameEn') == 'sc_test_parent',
              str(a2.get('dictNameEn')))
        check('停用 / 启用字典成功',
              (post('/api/sysdict/enabled', {'id': a_id, 'enabled': 1})
               .get('data') or {}).get('enabled') is True and
              (post('/api/sysdict/enabled', {'id': a_id, 'enabled': 0})
               .get('data') or {}).get('enabled') is False)
        check('启停接口返回中文提示',
              '已启用' in str((post('/api/sysdict/enabled', {'id': a_id, 'enabled': 1})
                              .get('data') or {}).get('message')))

        # ---------- 字典键值：复合唯一 / 空键 / 归属字典 ----------
        r = post('/api/sysdictitems/add', {
            'dictId': a_id, 'itemKey': 'K1', 'itemValue': SC_TAG + '键值一',
            'sortNo': 1, 'remark': '接口自测', 'enabled': 1
        })
        i1 = r.get('data') or {}
        i1_id = i1.get('id') or ''
        check('新增键值成功且主键是 UUID',
              r.get('code') == 0 and re.match(
                  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                  str(i1_id)) is not None, str(i1_id))
        check('键值补所属字典中文名 / 英文名',
              i1.get('dictNameCn') == SC_TAG + '父字典（改）' and
              i1.get('dictNameEn') == 'sc_test_parent', str(i1)[:160])
        check('新增空键成功（纯枚举值）',
              post('/api/sysdictitems/add', {'dictId': a_id, 'itemKey': '',
                                            'itemValue': SC_TAG + '枚举二',
                                            'sortNo': 2}).get('code') == 0)
        check('不同字典下相同键可以共存',
              post('/api/sysdictitems/add', {'dictId': b_id, 'itemKey': 'K1',
                                            'itemValue': SC_TAG + '子字典值'}).get('code') == 0)
        check('同一字典下重复键被拒',
              post('/api/sysdictitems/add', {'dictId': a_id, 'itemKey': 'K1',
                                            'itemValue': SC_TAG + '重复键'}).get('code') != 0)
        check('check 同字典同键返回 unique=false',
              (get('/api/sysdictitems/check', {'field': 'itemKey', 'value': 'K1',
                                              'dictId': a_id}).get('data') or {}).get('unique') is False)
        check('check 编辑自身不算重复',
              (get('/api/sysdictitems/check', {'field': 'itemKey', 'value': 'K1',
                                              'dictId': a_id, 'id': i1_id})
               .get('data') or {}).get('unique') is True)
        check('check 缺 dictId 时返回 unique=true',
              (get('/api/sysdictitems/check', {'field': 'itemKey', 'value': 'K1'})
               .get('data') or {}).get('unique') is True)
        check('键值所属字典不存在被拒（404）',
              post('/api/sysdictitems/add', {'dictId': str(_uuid.uuid4()),
                                            'itemValue': SC_TAG + '孤儿值'}).get('code') == 404)
        check('键值为空被拒',
              post('/api/sysdictitems/add', {'dictId': a_id, 'itemValue': ''}).get('code') != 0)
        check('键超过 150 字被拒',
              post('/api/sysdictitems/add', {'dictId': a_id, 'itemKey': 'x' * 151,
                                            'itemValue': SC_TAG + '超长键'}).get('code') != 0)
        d = get('/api/sysdictitems/list', {'dictId': a_id}).get('data') or {}
        check('按 dictId 筛选键值只出 2 条', int(d.get('total') or 0) == 2, str(d)[:140])
        check('键值按 sortNo 升序',
              [int(x.get('sortNo') or 0) for x in (d.get('list') or [])] == [1, 2],
              str([x.get('sortNo') for x in (d.get('list') or [])]))
        check('键值列表关键字检索命中 3 条',
              int((get('/api/sysdictitems/list', {'keyword': SC_TAG})
                   .get('data') or {}).get('total') or 0) == 3)
        check('键值详情可查',
              (get('/api/sysdictitems/detail', {'id': i1_id}).get('data') or {}).get('itemKey') == 'K1')
        r = post('/api/sysdictitems/update', {
            'id': i1_id, 'dictId': a_id, 'itemKey': 'K1',
            'itemValue': SC_TAG + '键值一（改）', 'sortNo': 8, 'remark': '改后说明'
        })
        check('编辑键值成功且值 / 序号 / 说明已更新',
              r.get('code') == 0 and (r.get('data') or {}).get('sortNo') == 8 and
              (r.get('data') or {}).get('itemValue') == SC_TAG + '键值一（改）', str(r)[:160])
        check('停用 / 启用键值成功',
              (post('/api/sysdictitems/enabled', {'id': i1_id, 'enabled': 0})
               .get('data') or {}).get('enabled') is False and
              (post('/api/sysdictitems/enabled', {'id': i1_id, 'enabled': 1})
               .get('data') or {}).get('enabled') is True)
        i2_id = ''
        for _row in (get('/api/sysdictitems/list', {'dictId': a_id}).get('data') or {}).get('list') or []:
            if SC_TAG + '枚举二' in str(_row.get('itemValue')):
                i2_id = _row.get('id')
        check('删除键值成功',
              bool(i2_id) and post('/api/sysdictitems/delete', {'id': i2_id}).get('code') == 0)
        check('删除后父字典只剩 1 条键值',
              int((get('/api/sysdictitems/list', {'dictId': a_id})
                   .get('data') or {}).get('total') or 0) == 1)
        check('字典列表 itemCount 与键值数一致',
              int((get('/api/sysdict/detail', {'id': a_id}).get('data') or {}).get('itemCount') or 0) == 1)

        # ---------- 系统参数：英文名唯一 / 参数值 / 检索 ----------
        r = post('/api/syspara/add', {
            'paraNameCn': SC_TAG + '参数一', 'paraNameEn': 'sc_test_para_one',
            'paraValue': '九豆综合管理平台', 'sortNo': 1, 'remark': '接口自测', 'enabled': 1
        })
        p1 = r.get('data') or {}
        p1_id = p1.get('id') or ''
        check('新增系统参数成功且主键是 UUID',
              r.get('code') == 0 and re.match(
                  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                  str(p1_id)) is not None, str(p1_id))
        check('参数返回中文名 / 英文名 / 参数值 / 序号 / 说明 / 启用否',
              all(k in p1 for k in ('paraNameCn', 'paraNameEn', 'paraValue',
                                    'sortNo', 'remark', 'enabled')), str(p1)[:160])
        check('英文名允许点 / 横线 / 数字',
              post('/api/syspara/add', {'paraNameCn': SC_TAG + '参数二',
                                       'paraNameEn': 'sc_test_para.two-2',
                                       'paraValue': '8', 'sortNo': 2,
                                       'enabled': 0}).get('code') == 0)
        check('参数英文名重复被拒',
              post('/api/syspara/add', {'paraNameCn': SC_TAG + '重名参数',
                                       'paraNameEn': 'sc_test_para_one'}).get('code') != 0)
        check('参数英文名以数字开头被拒',
              post('/api/syspara/add', {'paraNameCn': SC_TAG + '数字开头',
                                       'paraNameEn': '2para'}).get('code') != 0)
        check('参数值超过 1000 字被拒',
              post('/api/syspara/add', {'paraNameCn': SC_TAG + '超长值',
                                       'paraNameEn': 'sc_test_para_long',
                                       'paraValue': 'x' * 1001}).get('code') != 0)
        check('check 参数英文名已存在返回 unique=false',
              (get('/api/syspara/check', {'field': 'paraNameEn',
                                         'value': 'sc_test_para_one'})
               .get('data') or {}).get('unique') is False)
        check('check 参数英文名不存在返回 unique=true',
              (get('/api/syspara/check', {'field': 'paraNameEn',
                                         'value': 'sc_test_para_new'})
               .get('data') or {}).get('unique') is True)
        d = get('/api/syspara/list', {'keyword': SC_TAG}).get('data') or {}
        check('参数列表关键字检索命中 2 条且按序号升序',
              int(d.get('total') or 0) == 2 and
              [int(x.get('sortNo') or 0) for x in (d.get('list') or [])] == [1, 2],
              str([x.get('paraNameEn') for x in (d.get('list') or [])]))
        check('参数列表能按「参数值」检索',
              int((get('/api/syspara/list', {'keyword': '九豆综合管理平台'})
                   .get('data') or {}).get('total') or 0) >= 1)
        check('按启用状态筛选参数生效',
              int((get('/api/syspara/list', {'keyword': SC_TAG, 'enabled': 0})
                   .get('data') or {}).get('total') or 0) == 1)
        check('参数详情可查',
              (get('/api/syspara/detail', {'id': p1_id}).get('data') or {}).get('paraValue') ==
              '九豆综合管理平台')
        r = post('/api/syspara/update', {
            'id': p1_id, 'paraNameCn': SC_TAG + '参数一（改）',
            'paraNameEn': 'sc_test_para_one', 'paraValue': '改后的值',
            'sortNo': 6, 'remark': '编辑后说明'
        })
        check('编辑参数成功且中文名 / 值 / 序号 / 说明已更新',
              r.get('code') == 0 and (r.get('data') or {}).get('paraValue') == '改后的值' and
              (r.get('data') or {}).get('sortNo') == 6, str(r)[:160])
        check('停用 / 启用参数成功',
              (post('/api/syspara/enabled', {'id': p1_id, 'enabled': 0})
               .get('data') or {}).get('enabled') is False and
              (post('/api/syspara/enabled', {'id': p1_id, 'enabled': 1})
               .get('data') or {}).get('enabled') is True)
        p2_id = ''
        for _row in (get('/api/syspara/list', {'keyword': SC_TAG}).get('data') or {}).get('list') or []:
            if _row.get('paraNameEn') == 'sc_test_para.two-2':
                p2_id = _row.get('id')
        check('删除参数成功',
              bool(p2_id) and post('/api/syspara/delete', {'id': p2_id}).get('code') == 0)

        # ---------- 级联删除：键值清理 + 子字典升为顶级 ----------
        r = post('/api/sysdict/delete', {'id': a_id})
        cas = r.get('data') or {}
        check('删除父字典成功并返回清理统计',
              r.get('code') == 0 and int(cas.get('deletedItems') or 0) == 1 and
              int(cas.get('detachedChildren') or 0) == 1, str(r)[:180])
        check('删除提示带清理条数与子字典数量',
              '清理 1 条键值' in str(cas.get('message')) and '1 个子字典' in str(cas.get('message')),
              str(cas.get('message')))
        check('父字典已不在列表',
              int((get('/api/sysdict/list', {'keyword': SC_TAG + '父字典（改）'})
                   .get('data') or {}).get('total') or 0) == 0)
        check('父字典下的键值已全部清理',
              int((get('/api/sysdictitems/list', {'dictId': a_id})
                   .get('data') or {}).get('total') or 0) == 0)
        b2 = get('/api/sysdict/detail', {'id': b_id}).get('data') or {}
        check('子字典升为顶级（parentId 为空 / level=1）',
              not b2.get('parentId') and b2.get('level') == 1, str(b2)[:160])

        # ---------- health / 菜单 / 授权 / 首页卡片同源 ----------
        h = get('/api/health').get('data') or {}
        check('健康检查带三张系统配置表计数',
              all(k in h for k in ('sysDictCount', 'sysDictItemCount', 'sysParaCount')),
              str(h)[:180])
        check('健康检查计数为整数',
              all(isinstance(h.get(k), int) for k in
                  ('sysDictCount', 'sysDictItemCount', 'sysParaCount')), str(h)[:180])
        check('菜单表含「系统字典 / 系统参数」两个启用页，字典键值页已停用（并入字典页右区）',
              int(_one("SELECT COUNT(*) AS n FROM `menuinfros` WHERE `path` IN "
                       "('sysdict.html','syspara.html') AND `enabled`=1")['n']) == 2 and
              int(_one("SELECT COUNT(*) AS n FROM `menuinfros` WHERE `path`='sysdict-item.html' "
                       "AND `enabled`=0")['n']) == 1)
        check('「系统配置」菜单组绑定 2 个启用页面（字典键值绑定已停用）',
              int(_one("SELECT COUNT(*) AS n FROM `menugroupitemset` s "
                       "JOIN `menugroupinfos` g ON g.`id`=s.`groupId` "
                       "WHERE g.`code`='MNG1007' AND s.`enabled`=1")['n']) == 2)
        # 与「项目中心」同理：不假设「整组授权（menuItemId=0）」这条历史写法，
        # 只要求系统管理员覆盖组内全部启用菜单项（逐项或整组都算）。
        check('系统管理员已获「系统配置」组内全部页面的授权（逐项或整组）',
              int(_one("SELECT COUNT(DISTINCT s.`itemId`) AS n FROM `menugroupitemset` s "
                       "JOIN `menugroupinfos` g ON g.`id`=s.`groupId` "
                       "JOIN `menuinfros` m ON m.`id`=s.`itemId` AND m.`enabled`=1 "
                       "JOIN `usergrouppowerset` p ON p.`menuGroupId`=g.`id` AND p.`enabled`=1 "
                       " AND (p.`menuItemId`=0 OR p.`menuItemId`=s.`itemId`) "
                       "JOIN `usergroup` r ON r.`id`=p.`roleId` AND r.`nameEn`='SystemAdmin' "
                       "WHERE g.`code`='MNG1007' AND s.`enabled`=1")['n'])
              == int(_one("SELECT COUNT(*) AS n FROM `menugroupitemset` s "
                          "JOIN `menugroupinfos` g ON g.`id`=s.`groupId` "
                          "JOIN `menuinfros` m ON m.`id`=s.`itemId` AND m.`enabled`=1 "
                          "WHERE g.`code`='MNG1007' AND s.`enabled`=1")['n']))
        check('三页共登记 25 个页面操作按钮（字典页 12 个，含右区 6 个键值按钮）',
              int(_one("SELECT COUNT(*) AS n FROM `pageopbtn` WHERE `pagePath` IN "
                       "('sysdict.html','sysdict-item.html','syspara.html')")['n']) == 25)
        check('字典页右区 6 个键值按钮已登记，旧「维护键值」按钮已移除',
              int(_one("SELECT COUNT(*) AS n FROM `pageopbtn` WHERE `pagePath`='sysdict.html' "
                       "AND `btnId` IN ('btnItemAdd','btnItemEdit','btnItemEnable',"
                       "'btnItemDisable','btnItemDelete','btnItemRefresh')")['n']) == 6 and
              int(_one("SELECT COUNT(*) AS n FROM `pageopbtn` WHERE `pagePath`='sysdict.html' "
                       "AND `btnId`='btnItems'")['n']) == 0)
        nav_data = get('/api/nav', {
            'roleId': 'a1b2c3d4-0001-4a1b-8c00-000000000001'
        }).get('data') or {}
        nav_text = json.dumps(nav_data.get('groups') or [], ensure_ascii=False)
        check('左侧导航（首页卡片同源）含「系统配置 / 系统字典 / 系统参数」，不再出现字典键值页',
              '系统配置' in nav_text and 'sysdict.html' in nav_text and
              'syspara.html' in nav_text and 'sysdict-item.html' not in nav_text, nav_text[:200])
    finally:
        sc_cleanup()              # 无论成功失败都不留测试残骸

    # ===================== 8.11 项目维护页：富文本说明 / Word 导入 ===============
    print('\n--- 8.11 项目维护页（富文本项目说明 / Word 导入） ---')
    import base64
    import zipfile as _zipfile
    from db import query_all as _pf_all, query_one as _pf_one
    PF_TAG = '__接口自测项目说明__'

    def pf_cleanup():
        for row in (_pf_all('SELECT `id`,`projectName` FROM `projectinfos`') or []):
            if PF_TAG in str(row.get('projectName') or ''):
                try:
                    post('/api/project/delete', {'id': row['id']})
                except Exception as exc:
                    print('  [WARN] 清理项目说明测试残留失败：%s' % exc)

    def make_docx(with_document=True):
        """内存构造一份最小 .docx（OOXML zip），供导入接口真实解析"""
        buf = io.BytesIO()
        with _zipfile.ZipFile(buf, 'w', _zipfile.ZIP_DEFLATED) as z:
            z.writestr('[Content_Types].xml', '<Types/>')
            if with_document:
                z.writestr('word/document.xml', '''<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>项目总体说明</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:i/><w:color w:val="1F4E79"/><w:sz w:val="28"/></w:rPr><w:t>正文第一段</w:t></w:r><w:r><w:t>，普通文字</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>阶段</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>交付物</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>''')
        return buf.getvalue()

    pf_cleanup()
    pf_id = ''
    try:
        # ---------- ① 结构：projectDesc 已扩为 MEDIUMTEXT ----------
        col = _pf_one("SELECT `DATA_TYPE` AS t FROM `information_schema`.`COLUMNS` "
                      "WHERE `TABLE_SCHEMA`='rogerorm' AND `TABLE_NAME`='projectinfos' "
                      "AND `COLUMN_NAME`='projectDesc'") or {}
        check('projectDesc 已迁移为 mediumtext（可存富文本 / Word 长文档）',
              str(col.get('t') or '').lower() == 'mediumtext', str(col))

        # ---------- ② 保存：长 HTML + 白名单清洗 + 纯文本摘要 ----------
        long_desc = ('<h2>项目背景</h2><p><b>需求说明：</b>' + '平台升级与功能验证。' * 120 +
                     '</p><table border="1"><tr><td>阶段</td><td>交付物</td></tr></table>')
        dirty = long_desc + '<script>alert(1)</script><p onclick="x()">危险内容</p>' + \
                '<img src="javascript:alert(2)"><span style="position:absolute;background:url(http://x)">红</span>'
        r = post('/api/project/add', {
            'projectName': PF_TAG + '富文本', 'projectType': '研发',
            'projectStatus': '进行中', 'projectDesc': dirty,
            'ispub': 0, 'enabled': 1
        })
        p = r.get('data') or {}
        pf_id = p.get('id') or ''
        check('新增项目成功（带富文本说明）', r.get('code') == 0 and bool(pf_id), str(r)[:160])
        check('项目编号仍由后端自动生成 PRO + 6 位',
              re.match(r'^PRO\d{6}$', str(p.get('projectCode') or '')) is not None,
              str(p.get('projectCode')))
        saved = str(p.get('projectDesc') or '')
        check('长 HTML 不再被 1000 字截断（MEDIUMTEXT 生效）',
              len(saved) > 1000 and '平台升级与功能验证。' in saved, str(len(saved)))
        check('保存前清洗掉 script / on* / javascript: / 危险 CSS',
              '<script' not in saved and 'onclick' not in saved and
              'javascript:' not in saved and 'position:absolute' not in saved and
              'url(' not in saved and '<img' not in saved,
              saved[-160:])
        check('保留合法排版标签（标题 / 加粗 / 表格）',
              '<h2>' in saved and '<b>' in saved and '<table' in saved and '<td>' in saved)
        plain = str(p.get('projectDescText') or '')
        check('附带纯文本摘要 projectDescText（无标签、≤200 字）',
              bool(plain) and '<' not in plain and len(plain) <= 200 and '项目背景' in plain,
              plain[:100])
        d = get('/api/project/detail', {'id': pf_id}).get('data') or {}
        check('详情返回同样的富文本与摘要',
              str(d.get('projectDesc') or '') == saved and d.get('projectDescText') == plain)
        lst = get('/api/project/list', {'keyword': PF_TAG}).get('data') or {}
        rows = lst.get('list') or []
        check('列表也带 projectDescText（页面 title 用纯文本）',
              len(rows) == 1 and rows[0].get('projectDescText') == plain, str(rows)[:160])

        # ---------- ③ 编辑：替换为 Word 导入的 HTML ----------
        word_html = '<h1 style="text-align:center">项目总体说明</h1><p>正文第一段</p>'
        r2 = post('/api/project/update', {
            'id': pf_id, 'projectName': PF_TAG + '富文本',
            'projectDesc': word_html, 'ispub': 1, 'enabled': 1
        })
        d2 = r2.get('data') or {}
        check('编辑项目说明为 Word 导入内容成功',
              r2.get('code') == 0 and str(d2.get('projectDesc') or '') == word_html,
              str(d2.get('projectDesc'))[:120])
        check('编辑后摘要同步更新', '项目总体说明' in str(d2.get('projectDescText') or ''),
              str(d2.get('projectDescText')))
        check('编辑仍不能改项目编号', d2.get('projectCode') == p.get('projectCode'))

        # ---------- ④ /api/project/importdoc：真实 docx 解析 ----------
        blob = make_docx()
        data_url = ('data:application/vnd.openxmlformats-officedocument.'
                    'wordprocessingml.document;base64,' + base64.b64encode(blob).decode('ascii'))
        imp = post('/api/project/importdoc', {'data': data_url, 'fileName': '接口自测说明书.docx'})
        w = imp.get('data') or {}
        wh = str(w.get('html') or '')
        check('导入 docx 成功（data URL）', imp.get('code') == 0 and bool(wh), str(imp)[:160])
        check('Word 标题 / 居中 / 加粗被转成 HTML',
              '<h1' in wh and 'text-align:center' in wh and 'font-weight:bold' in wh, wh[:160])
        check('Word 斜体 / 颜色 / 字号被保留',
              'font-style:italic' in wh and 'color:#1F4E79' in wh and 'font-size:14pt' in wh)
        check('Word 表格被转成 table / tr / td',
              '<table' in wh and '<tr>' in wh and '<td>' in wh and '交付物' in wh)
        check('导入结果不残留 OOXML 标签 / 脚本',
              'w:document' not in wh and '<script' not in wh and 'onclick' not in wh)
        check('导入返回纯文本 / 段落数 / 图片跳过数 / 文件名',
              '项目总体说明' in str(w.get('text') or '') and
              int(w.get('paragraphs') or 0) >= 3 and
              int(w.get('imagesSkipped') or 0) == 0 and
              w.get('fileName') == '接口自测说明书.docx', str(w)[:200])
        check('导入提示文案含文件名与段落数',
              '已导入' in str(w.get('message') or '') and '段落' in str(w.get('message') or ''),
              str(w.get('message')))
        pure_b64 = post('/api/project/importdoc', {
            'data': base64.b64encode(blob).decode('ascii'), 'fileName': '纯base64.docx'
        })
        check('纯 base64（无 data URL 前缀）同样可导入',
              pure_b64.get('code') == 0 and '项目总体说明' in
              str((pure_b64.get('data') or {}).get('html') or ''))

        # ---------- ⑤ 导入异常分支 ----------
        bad_cases = [
            ('旧版 .doc 被拒并提示另存为', {'data': base64.b64encode(blob).decode('ascii'),
                                       'fileName': '老格式.doc'}, '另存为'),
            ('非 Word 扩展名被拒', {'data': base64.b64encode(blob).decode('ascii'),
                                'fileName': '说明.txt'}, '只支持'),
            ('空内容被拒', {'data': '', 'fileName': '空.docx'}, '请先选择'),
            ('非法 base64 被拒', {'data': '@@@not-base64@@@', 'fileName': '坏.docx'}, 'Word'),
            ('非 zip 内容被拒', {'data': base64.b64encode(b'not a zip').decode('ascii'),
                              'fileName': '坏.docx'}, '损坏'),
            ('缺 word/document.xml 的 zip 被拒',
             {'data': base64.b64encode(make_docx(False)).decode('ascii'),
              'fileName': '空包.docx'}, '不是有效的 Word'),
        ]
        for label, payload, keyword in bad_cases:
            res = post('/api/project/importdoc', payload)
            check(label, res.get('code') != 0 and keyword in str(res.get('message') or ''),
                  str(res)[:140])

        # ---------- ⑥ 导入结果写回项目（完整闭环） ----------
        back = post('/api/project/update', {
            'id': pf_id, 'projectName': PF_TAG + '富文本',
            'projectDesc': wh, 'ispub': 1, 'enabled': 1
        })
        check('导入的 Word 内容可直接保存进项目说明',
              back.get('code') == 0 and
              str((back.get('data') or {}).get('projectDesc') or '') == wh,
              str(back.get('code')))

        # ---------- ⑦ 打页模式：表单页不是菜单项，但按钮已登记 ----------
        check('project-form.html 是打页表单，不占菜单项',
              int(_pf_one("SELECT COUNT(*) AS n FROM `menuinfros` "
                          "WHERE `path`='project-form.html'")['n']) == 0)
        check('项目维护页登记 4 个页面操作按钮',
              int(_pf_one("SELECT COUNT(*) AS n FROM `pageopbtn` "
                          "WHERE `pagePath`='project-form.html' AND `enabled`=1")['n']) == 4)
    finally:
        pf_cleanup()

    # ===================== 8.12 项目目录 projectdirs / 文件 dirId 归属 =============
    print('\n--- 8.12 项目目录（projectdirs / projectfiles.dirId） ---')
    DIR_TAG = '__接口自测目录项目__'
    dir_pj, dir_pj2, ghost_dir_id = '', '', ''
    dir_root_id, dir_child_id, dir_leaf_id, dir_pj2_id = '', '', '', ''
    dir_file_root, dir_file_child = '', ''

    def dir_cleanup():
        for row in (_pf_all('SELECT `id`,`projectName` FROM `projectinfos`') or []):
            if DIR_TAG in str(row.get('projectName') or ''):
                try:
                    post('/api/project/delete', {'id': row['id']})
                except Exception as exc:
                    print('  [WARN] 清理项目目录测试残留失败：%s' % exc)
        _sql("DELETE FROM `projectdirs` WHERE `dirName` LIKE %s", ('%__他人私有目录__%',))

    dir_cleanup()
    try:
        # ---------- ① 表结构 ----------
        _dcols = _pf_all('SELECT `COLUMN_NAME` AS c FROM `information_schema`.`COLUMNS` '
                         "WHERE `TABLE_SCHEMA`='rogerorm' AND `TABLE_NAME`='projectdirs'") or []
        _dset = set(str(x.get('c') or '') for x in _dcols)
        check('projectdirs 表含 ID/项目ID/上级ID/目录名/说明/公开否/启用否等字段',
              set(('id', 'projectId', 'parentId', 'dirName', 'dirDesc', 'ispub', 'enabled')) <= _dset,
              str(sorted(_dset)))
        _did = _pf_one("SELECT `DATA_TYPE` AS t, `CHARACTER_MAXIMUM_LENGTH` AS n "
                       "FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA`='rogerorm' "
                       "AND `TABLE_NAME`='projectdirs' AND `COLUMN_NAME`='id'") or {}
        check('projectdirs.id 为 CHAR(36) 的 UUID 主键',
              str(_did.get('t') or '').lower() == 'char' and int(_did.get('n') or 0) == 36,
              str(_did))
        check('projectfiles.dirId 列已落库（空=直接关联项目）',
              bool(_pf_one("SELECT `COLUMN_NAME` AS c FROM `information_schema`.`COLUMNS` "
                           "WHERE `TABLE_SCHEMA`='rogerorm' AND `TABLE_NAME`='projectfiles' "
                           "AND `COLUMN_NAME`='dirId'")))
        _dh = get('/api/health').get('data') or {}
        check('健康检查带 projectDirCount（项目目录表计数）',
              'projectDirCount' in _dh, str(_dh)[:160])

        # ---------- ② 建两个项目（B 用于跨项目目录校验） ----------
        r = post('/api/project/add', {'projectName': DIR_TAG, 'projectType': '研发',
                                     'ispub': 0, 'enabled': 1})
        dir_pj = (r.get('data') or {}).get('id') or ''
        check('目录用例：创建所属项目成功', r.get('code') == 0 and bool(dir_pj), str(r)[:160])
        r = post('/api/project/add', {'projectName': DIR_TAG + 'B', 'projectType': '实施',
                                     'ispub': 0, 'enabled': 1})
        dir_pj2 = (r.get('data') or {}).get('id') or ''
        check('目录用例：创建另一个项目成功', r.get('code') == 0 and bool(dir_pj2), str(r)[:160])

        # ---------- ③ 建三级目录 ----------
        r = post('/api/projectdir/add', {'projectId': dir_pj, 'dirName': '__目录一级__',
                                         'dirDesc': '一级说明', 'ispub': 1, 'enabled': 1})
        a = r.get('data') or {}
        dir_root_id = a.get('id') or ''
        check('新增一级目录成功（UUID / level=1 / 上级名为空）',
              r.get('code') == 0 and bool(dir_root_id) and a.get('level') == 1
              and a.get('parentName') == '', str(a)[:180])
        check('新增目录自动带入创建人 / 创建时间',
              bool(a.get('createEname')) and int(a.get('createempinfosid') or 0) > 0
              and bool(a.get('createTime')), str(a.get('createEname')))
        check('新增目录回显说明 / 公开否 / 启用否',
              a.get('dirDesc') == '一级说明' and a.get('ispub') is True
              and a.get('enabled') is True, str(a)[:180])
        r = post('/api/projectdir/add', {'projectId': dir_pj, 'parentId': dir_root_id,
                                         'dirName': '__目录二级__', 'dirDesc': '二级说明',
                                         'ispub': 0, 'enabled': 1})
        b = r.get('data') or {}
        dir_child_id = b.get('id') or ''
        check('新增二级目录成功（level=2 / 回显上级目录名）',
              r.get('code') == 0 and b.get('level') == 2
              and b.get('parentName') == '__目录一级__', str(b)[:180])
        check('私有目录 ispub 返回 false', b.get('ispub') is False, str(b.get('ispub')))
        r = post('/api/projectdir/add', {'projectId': dir_pj, 'parentId': dir_child_id,
                                         'dirName': '__目录三级__'})
        c = r.get('data') or {}
        dir_leaf_id = c.get('id') or ''
        check('新增三级目录成功（level=3）',
              r.get('code') == 0 and c.get('level') == 3, str(c)[:180])
        check('目录详情回显直属子目录数 childCount',
              int((get('/api/projectdir/detail', {'id': dir_root_id}).get('data') or {})
                  .get('childCount') or 0) == 1, str(dir_root_id))

        # ---------- ④ 列表 / 树 / 排除自身及后代 ----------
        d = get('/api/projectdir/list', {'projectId': dir_pj, 'pageSize': 50}).get('data') or {}
        check('目录列表按项目过滤返回 3 条', int(d.get('total') or 0) == 3, str(d)[:160])
        droot = get('/api/projectdir/list', {'projectId': dir_pj, 'parentId': 'root'}).get('data') or {}
        check('parentId=root 只返回一级目录', int(droot.get('total') or 0) == 1, str(droot)[:160])
        dsub = get('/api/projectdir/list', {'projectId': dir_pj,
                                            'parentId': dir_root_id}).get('data') or {}
        check('parentId=<目录ID> 返回其直接子目录',
              int(dsub.get('total') or 0) == 1
              and (dsub.get('list') or [{}])[0].get('dirName') == '__目录二级__', str(dsub)[:160])
        dkw = get('/api/projectdir/list', {'projectId': dir_pj,
                                           'keyword': '__目录三级__'}).get('data') or {}
        check('目录名 / 说明关键字检索生效', int(dkw.get('total') or 0) == 1, str(dkw)[:160])
        t = get('/api/projectdir/tree', {'projectId': dir_pj}).get('data') or {}
        tl = t.get('list') or []
        check('目录树返回深度优先扁平列表（一级→二级→三级）',
              int(t.get('total') or 0) == 3
              and [x.get('dirName') for x in tl] ==
              ['__目录一级__', '__目录二级__', '__目录三级__'],
              str([x.get('dirName') for x in tl]))
        check('目录树 level 递增且 label 带缩进 / └ 标记',
              [x.get('level') for x in tl] == [1, 2, 3]
              and str(tl[1].get('label') or '').startswith('　')
              and '└ ' in str(tl[2].get('label') or ''),
              str([x.get('label') for x in tl]))
        check('目录树 childCount / leaf 正确',
              int(tl[0].get('childCount') or 0) == 1 and tl[2].get('leaf') is True,
              str(tl)[:200])
        ex = get('/api/projectdir/tree', {'projectId': dir_pj,
                                          'excludeId': dir_root_id}).get('data') or {}
        check('tree excludeId 排除自身与全部后代', int(ex.get('total') or 0) == 0, str(ex)[:160])
        ex2 = get('/api/projectdir/tree', {'projectId': dir_pj,
                                           'excludeId': dir_child_id}).get('data') or {}
        check('tree excludeId 只排除该子树，父级仍保留',
              int(ex2.get('total') or 0) == 1
              and (ex2.get('list') or [{}])[0].get('dirName') == '__目录一级__', str(ex2)[:160])
        check('tree 缺 projectId 被拒', get('/api/projectdir/tree').get('code') != 0)

        # ---------- ⑤ 启停 / 编辑 / 各类非法入参 ----------
        r = post('/api/projectdir/enabled', {'id': dir_leaf_id, 'enabled': 0})
        check('停用目录生效并回中文提示',
              r.get('code') == 0 and (r.get('data') or {}).get('enabled') is False
              and '已停用' in str((r.get('data') or {}).get('message') or ''), str(r)[:180])
        r = post('/api/projectdir/enabled', {'id': dir_leaf_id, 'enabled': 1})
        check('重新启用目录生效', (r.get('data') or {}).get('enabled') is True, str(r)[:160])
        r = post('/api/projectdir/update', {'id': dir_leaf_id,
                                            'dirName': '__目录三级改__', 'dirDesc': '改后说明',
                                            'ispub': 0, 'enabled': 1})
        u = r.get('data') or {}
        check('编辑目录一次改名称 / 说明 / 公开否 / 启用否',
              r.get('code') == 0 and u.get('dirName') == '__目录三级改__'
              and u.get('dirDesc') == '改后说明' and u.get('ispub') is False, str(u)[:200])
        r = post('/api/projectdir/update', {'id': dir_leaf_id, 'parentId': dir_root_id})
        check('编辑上级目录生效（层级由 3 变 2）',
              r.get('code') == 0 and (r.get('data') or {}).get('level') == 2, str(r)[:180])
        check('改回原上级与原名（还原三级树）',
              post('/api/projectdir/update', {'id': dir_leaf_id,
                                              'parentId': dir_child_id,
                                              'dirName': '__目录三级__'}).get('code') == 0)
        check('同级同名目录被拒',
              post('/api/projectdir/add', {'projectId': dir_pj,
                                          'dirName': '__目录一级__'}).get('code') != 0)
        r = post('/api/projectdir/add', {'projectId': dir_pj, 'parentId': dir_root_id,
                                         'dirName': '__目录一级__'})
        check('不同上级下允许同名目录', r.get('code') == 0, str(r)[:160])
        if r.get('code') == 0:
            post('/api/projectdir/delete', {'id': (r.get('data') or {}).get('id')})
        check('上级目录不能是自己',
              post('/api/projectdir/update', {'id': dir_root_id,
                                              'parentId': dir_root_id}).get('code') != 0)
        check('上级目录不能是自己的子目录（防环）',
              post('/api/projectdir/update', {'id': dir_root_id,
                                              'parentId': dir_leaf_id}).get('code') != 0)
        check('上级目录不存在被拒',
              post('/api/projectdir/update', {'id': dir_root_id,
                                              'parentId': str(_uuid.uuid4())}).get('code') != 0)
        check('目录名为空被拒',
              post('/api/projectdir/add', {'projectId': dir_pj, 'dirName': ''}).get('code') != 0)
        check('所属项目不存在被拒',
              post('/api/projectdir/add', {'projectId': str(_uuid.uuid4()),
                                          'dirName': 'x'}).get('code') != 0)

        # ---------- ⑥ 文件与目录关联：不选目录=项目根 ----------
        _draw = '项目目录接口自测内容'.encode('utf-8')
        _db64 = _b64.b64encode(_draw).decode('ascii')
        r = post('/api/projectfile/upload', {
            'projectId': dir_pj, 'fileName': '__目录根文件__.txt', 'fileType': '文档',
            'data': 'data:text/plain;base64,' + _db64, 'fileSize': len(_draw)
        })
        fr = r.get('data') or {}
        dir_file_root = fr.get('id') or ''
        check('不选目录上传：文件 dirId 为空、直接关联项目',
              r.get('code') == 0 and fr.get('dirId') == '' and fr.get('dirName') == '',
              str(r)[:200])
        r = post('/api/projectfile/upload', {
            'projectId': dir_pj, 'dirId': dir_child_id, 'fileName': '__目录下文件__.txt',
            'fileType': '文档', 'data': 'data:text/plain;base64,' + _db64,
            'fileSize': len(_draw)
        })
        fc = r.get('data') or {}
        dir_file_child = fc.get('id') or ''
        check('选目录上传：文件带回 dirId 与目录名',
              r.get('code') == 0 and fc.get('dirId') == dir_child_id
              and fc.get('dirName') == '__目录二级__', str(r)[:200])
        check('文件详情同样回显 dirId / dirName',
              (get('/api/projectfile/detail', {'id': dir_file_child}).get('data') or {})
              .get('dirName') == '__目录二级__')
        fl = get('/api/projectfile/list', {'projectId': dir_pj, 'dirId': 'root'}).get('data') or {}
        check('dirId=root 只筛出未选目录的项目根文件',
              int(fl.get('total') or 0) == 1
              and (fl.get('list') or [{}])[0].get('id') == dir_file_root, str(fl)[:180])
        fl2 = get('/api/projectfile/list', {'projectId': dir_pj,
                                            'dirId': dir_child_id}).get('data') or {}
        check('dirId=<目录ID> 只筛出该目录下的文件',
              int(fl2.get('total') or 0) == 1
              and (fl2.get('list') or [{}])[0].get('id') == dir_file_child, str(fl2)[:180])
        t2 = get('/api/projectdir/tree', {'projectId': dir_pj}).get('data') or {}
        child_node = [x for x in (t2.get('list') or []) if x.get('id') == dir_child_id]
        check('目录树 fileCount 统计该目录下的文件数',
              bool(child_node) and int(child_node[0].get('fileCount') or 0) == 1,
              str(child_node)[:160])
        r = post('/api/projectfile/update', {'id': dir_file_root, 'dirId': dir_child_id})
        check('编辑文件可改所属目录', (r.get('data') or {}).get('dirId') == dir_child_id,
              str(r)[:180])
        r = post('/api/projectfile/update', {'id': dir_file_root, 'dirId': ''})
        check('编辑文件传空 dirId 可退回项目根',
              r.get('code') == 0 and (r.get('data') or {}).get('dirId') == '', str(r)[:180])

        # ---------- ⑦ 跨项目目录 / 可见性 ----------
        r = post('/api/projectdir/add', {'projectId': dir_pj2, 'dirName': '__B项目目录__'})
        dir_pj2_id = (r.get('data') or {}).get('id') or ''
        check('在另一个项目下也能建目录', r.get('code') == 0 and bool(dir_pj2_id), str(r)[:160])
        check('目录不会串到别的项目',
              int((get('/api/projectdir/list', {'projectId': dir_pj}).get('data') or {})
                  .get('total') or 0) == 3)
        check('上传时选到别的项目目录被拒',
              post('/api/projectfile/upload', {
                  'projectId': dir_pj, 'dirId': dir_pj2_id, 'fileName': 'x.txt',
                  'data': 'data:text/plain;base64,' + _db64
              }).get('code') != 0)
        ghost_dir_id = str(_uuid.uuid4())
        _sql('INSERT INTO `projectdirs` '
             '(`id`,`projectId`,`parentId`,`dirName`,`dirDesc`,`ispub`,`enabled`,'
             '`createEname`,`createempinfosid`) '
             'VALUES (%s,%s,NULL,%s,%s,0,1,%s,%s)',
             (ghost_dir_id, dir_pj, '__他人私有目录__', '不该可见', '别人', 999999))
        gl = get('/api/projectdir/list', {'projectId': dir_pj, 'pageSize': 50}).get('data') or {}
        gt = get('/api/projectdir/tree', {'projectId': dir_pj}).get('data') or {}
        check('他人私有目录不出现在目录列表 / 目录树',
              int(gl.get('total') or 0) == 3 and int(gt.get('total') or 0) == 3,
              'list=%s tree=%s' % (gl.get('total'), gt.get('total')))
        check('他人私有目录详情返回 404',
              get('/api/projectdir/detail', {'id': ghost_dir_id}).get('code') == 404)

        # ---------- ⑧ 删除目录：内容保留并上移，绝不删文件 ----------
        r = post('/api/projectdir/delete', {'id': dir_child_id})
        dd = r.get('data') or {}
        check('删除目录返回子目录上移 / 文件回根数量',
              r.get('code') == 0 and int(dd.get('movedDirs') or 0) == 1
              and int(dd.get('movedFiles') or 0) == 1, str(dd)[:200])
        check('删除目录的中文提示带上移 / 回根信息',
              '上移' in str(dd.get('message') or '') and '项目根' in str(dd.get('message') or ''),
              str(dd.get('message')))
        check('子目录上移到被删目录的上级',
              (get('/api/projectdir/detail', {'id': dir_leaf_id}).get('data') or {})
              .get('parentId') == dir_root_id)
        check('原目录下文件 dirId 置空但文件本身保留',
              (get('/api/projectfile/detail', {'id': dir_file_child}).get('data') or {})
              .get('dirId') == '')
        check('回根文件仍可正常下载',
              get('/api/projectfile/download', {'id': dir_file_child}).get('code') == 0)
        check('删除后目录树只剩一级与其上移的子目录',
              int((get('/api/projectdir/tree', {'projectId': dir_pj}).get('data') or {})
                  .get('total') or 0) == 2)
        check('再次删除叶子目录（无子目录 / 无文件）成功',
              post('/api/projectdir/delete', {'id': dir_leaf_id}).get('code') == 0)
        dir_leaf_id = ''

        # ---------- ⑨ 删除项目级联清理目录 ----------
        r = post('/api/project/delete', {'id': dir_pj})
        check('删除项目级联清理项目目录',
              r.get('code') == 0 and int((r.get('data') or {}).get('deletedDirs') or 0) >= 1,
              str(r)[:180])
        check('级联后 projectdirs 中该项目记录清零',
              int(_pf_one('SELECT COUNT(*) AS n FROM `projectdirs` WHERE `projectId`=%s',
                          (dir_pj,))['n']) == 0)
        dir_pj = ''
        post('/api/project/delete', {'id': dir_pj2})
        dir_pj2 = ''
    finally:
        for _pid in (dir_pj, dir_pj2):
            if _pid:
                try:
                    post('/api/project/delete', {'id': _pid})
                except Exception as exc:
                    print('  [WARN] 清理项目目录测试项目失败：%s' % exc)
        if ghost_dir_id:
            _sql('DELETE FROM `projectdirs` WHERE `id`=%s', (ghost_dir_id,))

    # ===================== 前端页面 =====================
    print('\n--- 9. 静态页面可访问 ---')
    for page in ('main.html', 'menu.html', 'menu-form.html', 'menu-group.html', 'menu-group-form.html',
                 'menu-group-item.html', 'menu-group-item-form.html', 'org.html', 'org-form.html', 'role.html', 'role-power.html', 'page-op-btn.html',
                 'emp.html', 'user.html', 'service-email.html', 'mail.html', 'address-book.html',
                 'dbinfo.html', 'report-designer.html', 'report-center.html',
                 'project.html', 'project-form.html', 'project-file.html',
                 'sysdict.html', 'sysdict-item.html', 'syspara.html',
                 'js/service-email.js', 'js/mail.js', 'js/address-book.js', 'js/report-designer.js',
                 'js/report-viewer.js', 'js/report-center.js',
                 'js/org.js', 'js/org-form.js', 'js/emp.js', 'js/menu-group-form.js',
                 'js/menu-group-item.js', 'js/menu-group-item-form.js', 'js/frame.js', 'js/layout.js',
                 'js/api.js', 'js/login.js', 'js/dbinfo.js',
                 'js/project.js', 'js/project-form.js', 'js/project-file.js',
                 'js/word-import.js',
                 'js/sysdict.js', 'js/sysdict-item.js', 'js/syspara.js'):
        try:
            req = urllib.request.Request(BASE + '/' + page, method='GET')
            with urllib.request.urlopen(req, timeout=10) as resp:
                ok_page = resp.status == 200 and len(resp.read()) > 0
        except Exception:
            ok_page = False
        check('可访问 %s' % page, ok_page)

    # 框架页改名：main.html 提供，旧 index.html 不再提供（错误响应是 200 + body.code=404）
    old_body = get('/index.html')
    check('旧框架页 index.html 已更名为 main.html（旧地址不再提供页面）',
          old_body.get('code') == 404 and not old_body.get('data'), str(old_body)[:120])

    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + '/', method='GET'), timeout=10) as resp:
            root_url = resp.geturl()
    except Exception:
        root_url = ''
    check('访问根路径 / 自动重定向到 main.html', str(root_url).endswith('/main.html'), str(root_url))

    print('\n--- 10. 异常入参 ---')
    r = get('/api/menu/detail', {'id': 'abc'})
    check('非法 id 返回业务错误', r.get('code') != 0 and 'id' in r.get('message', ''))
    r = get('/api/menu/check', {'field': 'remark', 'value': 'x'})
    check('不支持的校验字段被拒绝', r.get('code') != 0)
    r = get('/api/menu/notexist', {})
    check('不存在的接口返回 404', r.get('code') == 404)

    summary()


if __name__ == '__main__':
    main()
