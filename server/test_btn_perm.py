# -*- coding: utf-8 -*-
"""
「页面按钮可用性」后端验证（进程内，无需 Web 服务）
----------------------------------------------------
把 role_power_service.my_buttons 的结果与库里的授权逐项核对：
  · 没有登录上下文 → 401；
  · 用户角色来自 useinforoleset（多角色取并集）；
  · pages 里每个 pagePath 的按钮数量 = pageopbtn 里该页启用的按钮数；
  · allowed 标记 = 该角色在 usergrouppagebtnset 里有启用授权；
  · allowedTotal = 统计口径一致；没有角色的用户 unrestricted=True。

只读：不改任何授权数据。

用法：python server/test_btn_perm.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
import service

PASS = 0
FAIL = 0
svc = service.role_power_service


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, ('→ ' + str(extra)) if extra else ''))


def main():
    print('\n--- 1. 未登录 → 401 ---')
    try:
        svc.my_buttons({})
        check('无 _loginUserId 被拒绝', False)
    except service.BizError as exc:
        check('无 _loginUserId 被拒绝（401）', exc.code == 401, exc.code)

    # 挑一个绑定了角色的账号
    row = db.query_one(
        'SELECT u.`id`, u.`account`, u.`empId` FROM `useinfo` u '
        'JOIN `useinforoleset` r ON r.`userId`=u.`id` '
        'WHERE u.`enabled`=1 GROUP BY u.`id`, u.`account`, u.`empId` '
        'ORDER BY COUNT(r.`roleId`) DESC LIMIT 1')
    if not row:
        print('库里没有「已分配角色」的账号，跳过')
        return
    uid, account = str(row['id']), row['account']

    print('\n--- 2. 角色来自 useinforoleset（%s） ---' % account)
    data = svc.my_buttons({'_loginUserId': uid})
    expect_roles = set(str(r['roleId']) for r in (db.query_all(
        'SELECT `roleId` FROM `useinforoleset` WHERE `userId`=%s', (uid,)) or []))
    check('返回的角色集合 = 库里的用户角色',
          set(data.get('roleIds') or []) == expect_roles,
          '%s vs %s' % (data.get('roleIds'), sorted(expect_roles)))
    check('有角色的用户不受「不限」豁免', data.get('unrestricted') is False, data.get('unrestricted'))

    print('\n--- 3. 页面 / 按钮清单与 pageopbtn 对齐 ---')
    btn_rows = db.query_all(
        'SELECT `id`,`pagePath`,`btnId` FROM `pageopbtn` WHERE `enabled`=1') or []
    pages = data.get('pages') or {}
    by_page = {}
    for r in btn_rows:
        by_page.setdefault(str(r['pagePath']).lower(), []).append(str(r['btnId']))
    check('返回的页面数与 pageopbtn 一致', set(pages.keys()) == set(by_page.keys()),
          '缺少=%s 多出=%s' % (sorted(set(by_page) - set(pages)), sorted(set(pages) - set(by_page))))
    sample_page = 'emp.html' if 'emp.html' in by_page else sorted(by_page)[0]
    got_btns = set(b['btnId'] for b in (pages.get(sample_page) or {}).get('buttons', []))
    check('%s 的按钮集合与库里一致（%d 个）' % (sample_page, len(by_page[sample_page])),
          got_btns == set(by_page[sample_page]), '%s vs %s' % (sorted(got_btns), sorted(set(by_page[sample_page]))))

    print('\n--- 4. allowed 标记与授权表一致 ---')
    granted = set()
    if expect_roles:
        marks = ','.join(['%s'] * len(expect_roles))
        for r in (db.query_all(
                'SELECT DISTINCT `pageOpBtnId` FROM `usergrouppagebtnset` '
                'WHERE `enabled`=1 AND `roleId` IN (%s)' % marks, tuple(expect_roles)) or []):
            granted.add(str(r['pageOpBtnId']))
    id_by_pair = {}
    for r in btn_rows:
        id_by_pair[(str(r['pagePath']).lower(), str(r['btnId']))] = str(r['id'])
    wrong = []
    for path, item in pages.items():
        for b in item.get('buttons', []):
            expect = id_by_pair.get((path, b['btnId'])) in granted
            if bool(b.get('allowed')) != expect:
                wrong.append((path, b['btnId'], b.get('allowed'), expect))
    check('每个按钮的 allowed 都与授权表一致', not wrong, wrong[:5])
    check('allowedTotal = 已授权且仍登记的按钮数',
          int(data.get('allowedTotal') or 0) == len(granted & set(id_by_pair.values())),
          '%s vs %s' % (data.get('allowedTotal'), len(granted & set(id_by_pair.values()))))

    print('\n--- 5. 没有角色的用户 → 不限制 ---')
    no_role = db.query_one(
        'SELECT u.`id` FROM `useinfo` u LEFT JOIN `useinforoleset` r ON r.`userId`=u.`id` '
        'WHERE r.`id` IS NULL LIMIT 1')
    if no_role:
        d2 = svc.my_buttons({'_loginUserId': str(no_role['id'])})
        check('无角色用户 unrestricted=True', d2.get('unrestricted') is True, d2.get('unrestricted'))
        check('无角色用户 allowedTotal=0', int(d2.get('allowedTotal') or 0) == 0, d2.get('allowedTotal'))
    else:
        print('  （库里没有无角色账号，跳过该项）')


if __name__ == '__main__':
    main()
    print('\n===== test_btn_perm 结果：%d 通过 / %d 失败 =====' % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)
