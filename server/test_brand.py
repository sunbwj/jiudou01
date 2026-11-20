# -*- coding: utf-8 -*-
"""
系统品牌公开接口（GET /api/auth/brand）验证
-------------------------------------------
登录页要在**没有 token** 的情况下显示系统名称 / 英文名 / 图标，所以后端单独开了一个只读三键的
公开动作（不能把整张 syspara 免鉴权，那里还有维护公告之类的内部信息）。本脚本核对：

  · 返回值只有 app_name / app_ennme / app_ico 三个键，一个不多；
  · 值与 syspara 里 enabled=1 的对应记录一致（某个键没配就是空串，不返回别的默认值）；
  · 已在 app.py 的免登录白名单里（源码静态检查，避免把整张参数表放开）；
  · ACTIONS 里只允许 GET，不存在写入口；
  · 其它系统参数（app_desc / app_version 等）不会被带出来；
  · 8808 在线时顺带做一次真实 HTTP 校验：无 token 取品牌成功、无 token 取 syspara/list 仍然 401。

只读：只查库，不写任何数据。

用法：python server/test_brand.py
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db  # noqa: E402
import service  # noqa: E402

PASS = 0
FAIL = 0
svc = service.auth_service
KEYS = ('app_name', 'app_ennme', 'app_ico')


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, ('→ ' + str(extra)) if extra else ''))


def db_values():
    rows = db.query_all('SELECT `paraNameEn`,`paraValue` FROM `syspara` WHERE `enabled`=1')
    out = {}
    for row in rows or []:
        out[str(row.get('paraNameEn') or '').strip()] = str(row.get('paraValue') or '').strip()
    return out


def http_json(url, timeout=5):
    """不带任何 token 的 GET；返回 (status, dict)"""
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode('utf-8')
        try:
            return exc.code, json.loads(body)
        except ValueError:
            return exc.code, {}


def main():
    print('\n--- 1. 进程内调用：只回白名单三键 ---')
    data = svc.brand({})
    check('返回 dict', isinstance(data, dict), type(data))
    check('键集合 = app_name / app_ennme / app_ico',
          set(data.keys()) == set(KEYS), sorted(data.keys()))

    print('\n--- 2. 取值与 syspara 一致（不是写死的默认值）---')
    want = db_values()
    for key in KEYS:
        expected = want.get(key, '')
        check('%s = 库里启用的参数值（%s）' % (key, expected or '未配置 → 空串'),
              data.get(key) == expected, data.get(key))

    print('\n--- 3. 不夹带其它系统参数 ---')
    leaked = [k for k in data.keys() if k not in KEYS]
    check('没有多余的键（app_desc / app_version / 维护公告等不外泄）', not leaked, leaked)

    print('\n--- 4. 注册表与免登录白名单 ---')
    check('ACTIONS 里有 brand → brand()，且只允许 GET',
          service.ACTIONS.get('brand') == ('brand', ['GET']), service.ACTIONS.get('brand'))
    app_src = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app.py')
    with open(app_src, 'r', encoding='utf-8') as fp:
        src = fp.read()
    free_block = re.search(r'TOKEN_FREE_ACTIONS\s*=\s*\((.*?)\)\s*\n', src, re.S)
    check('app.py 的 TOKEN_FREE_ACTIONS 里含 (\'auth\', \'brand\')',
          bool(free_block) and "'brand'" in free_block.group(1),
          free_block.group(1).strip() if free_block else '未找到 TOKEN_FREE_ACTIONS')
    check('syspara 整表**没有**被免登录放开',
          bool(free_block) and "'syspara'" not in free_block.group(1))

    print('\n--- 5. 真实 HTTP（8808 在线时才跑）---')
    base = 'http://127.0.0.1:8808'
    try:
        status, body = http_json(base + '/api/health', timeout=3)
        online = status == 200
    except Exception:
        online = False
    if not online:
        print('  （8808 未启动，跳过 HTTP 校验）')
    else:
        status, body = http_json(base + '/api/auth/brand')
        check('无 token 取品牌 → code 0', status == 200 and body.get('code') == 0, body.get('message'))
        payload = body.get('data') or {}
        check('HTTP 返回同样只有三键', set(payload.keys()) == set(KEYS), sorted(payload.keys()))
        check('HTTP 返回的名称与库里一致', payload.get('app_name') == want.get('app_name', ''),
              payload.get('app_name'))
        status2, body2 = http_json(base + '/api/syspara/list?enabled=1')
        check('无 token 读整张系统参数表仍然 401（没有连带放开）',
              body2.get('code') == 401, '%s %s' % (status2, body2.get('message')))

    print('\n===== test_brand 结果：%d 通过 / %d 失败 =====' % (PASS, FAIL))


if __name__ == '__main__':
    main()
    sys.exit(1 if FAIL else 0)
