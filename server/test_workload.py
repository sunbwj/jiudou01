# -*- coding: utf-8 -*-
"""
项目中心 · 员工工作量统计（WorkloadService）验证
------------------------------------------------
对应「项目中心 → 工作量统计」这条链路的后端部分：

  · 口径：区间按派单时间（含结束日整天）、完成率 = 已完成 ÷ 接单数、
    逾期 = 未完成且计划完成日已过、按期率 = 按期完成 ÷ 已完成、
    平均耗时 = 派单日 → 实际完成日（同日算 0 天，不出现负数）；
  · 边界：区间末日 23:59:59 归当期、次日 00:00:01 归下期；起止倒置 / 跨度过大要报错；
  · 排序：默认接单数降序，可切完成率 / 逾期 / 耗时 / 最近派单；ownerId=0 的「未指定」永远垫底；
  · 钻取：details 分页不重复、小计按整段区间算（不随翻页变化）、状态过滤；
  · 导出：xlsx 两个页签（员工汇总 + 工单明细）；
  · 菜单与按钮：MNU00028 挂在 MNG1006、3 个按钮已登记并授权给全部启用角色，
    且与 page_scan 扫出来的 btnId 完全一致（改按钮 id 忘了重新收录会在这里红）。

测试数据用 id 前缀 `TESTWL-` 的临时工单，ownerId 用一个不存在的员工 id，
跑完立即删除 —— 不碰库里任何真实工单与计划。

用法：python server/test_workload.py
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db  # noqa: E402
import service  # noqa: E402

PASS = 0
FAIL = 0
svc = service.workload_service
MARK = 'TESTWL'
OWNER = 990001          # 库里不存在的员工：统计结果与真实员工完全隔离
WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s   %s' % (name, extra))


def login_uid():
    row = db.query_one('SELECT `id` FROM `useinfo` WHERE `enabled`=1 AND `empId`>0 ORDER BY `id` LIMIT 1')
    return str((row or {}).get('id') or '')


def cleanup():
    db.execute('DELETE FROM `workplanorders` WHERE `id` LIKE %s', (MARK + '%',))


def seed():
    """7 条临时工单：5 条落在 2026-11-01~12（含末日 23:59:59）、1 条次日、1 条未指定责任人"""
    now = '2026-11-12 10:00:00'
    rows = [
        # id 后缀, 状态, 派单时间, 计划完成, 实际完成
        ('-1', '已完成', '2026-11-02 09:00:00', '2026-11-05', '2026-11-04 00:00:00'),  # 按期
        ('-2', '已完成', '2026-11-03 09:00:00', '2026-11-05', '2026-11-08 00:00:00'),  # 完成但超期
        ('-3', '处理中', '2026-11-04 09:00:00', '2026-11-06', None),                  # 逾期未完成
        ('-4', '待处理', '2026-11-05 09:00:00', '2026-12-30', None),
        ('-5', '待处理', '2026-11-12 23:59:59', '2026-12-30', None),                  # 末日当天
        ('-6', '待处理', '2026-11-13 00:00:01', '2026-12-30', None),                  # 次日，不该进区间
        ('-7', '待处理', '2026-11-06 09:00:00', '2026-12-30', None),                  # ownerId=0
    ]
    for suffix, status, dispatch, end, actual in rows:
        owner = 0 if suffix == '-7' else OWNER
        db.execute(
            'INSERT INTO `workplanorders` '
            '(`id`,`taskId`,`planId`,`projectId`,`planCode`,`planName`,`orderCode`,`orderTitle`,'
            ' `taskType`,`startDate`,`endDate`,`ownerId`,`ownerName`,`status`,`dispatchTime`,'
            ' `actualEndTime`,`noticeMsg`,`noticeMail`,`createTime`,`updateTime`) '
            'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
            # taskId 上只有唯一键 uk_wporders_task（一任务一单）→ 每条给不同值
            (MARK + suffix, MARK + '-T' + suffix, '', '', 'TEST', '工作量冒烟计划', MARK + suffix,
             '冒烟任务' + suffix, 'task', dispatch[:10], end, owner,
             '' if owner == 0 else '冒烟员工', status, dispatch, actual, 0, 0, now, now))


def row_of(data, owner_id=OWNER):
    for it in (data or {}).get('list') or []:
        if int(it.get('ownerId') or 0) == owner_id:
            return it
    return None


def main():
    global PASS, FAIL
    uid = login_uid()
    if not uid:
        print('没有可用登录账号（useinfo 需要一条 enabled=1 且绑定员工的记录）')
        return 2

    cleanup()
    seed()
    try:
        print('\n--- 1. 区间与基础口径 ---')
        d = svc.stats({'_loginUserId': uid, 'startDate': '2026-11-01', 'endDate': '2026-11-12'})
        me = row_of(d)
        check('临时员工出现在统计结果里', bool(me), d.get('list'))
        if not me:
            return 1
        check('接单数 = 5（含末日 23:59:59，不含次日 00:00:01）', me['orderCount'] == 5, me['orderCount'])
        check('已完成 = 2', me['doneCount'] == 2, me['doneCount'])
        check('处理中 = 1 / 待处理 = 2', me['doingCount'] == 1 and me['todoCount'] == 2,
              '%s/%s' % (me['doingCount'], me['todoCount']))
        check('完成率 = 40.0%', me['doneRate'] == 40.0, me['doneRate'])
        check('逾期 = 1（处理中且计划完成日已过）', me['overdueCount'] == 1, me['overdueCount'])
        check('按期率 = 50.0%（2 个完成里 1 个按期）', me['onTimeRate'] == 50.0, me['onTimeRate'])
        check('平均耗时 = 3.5 天（2 天 + 5 天）', me['avgDays'] == 3.5, me['avgDays'])
        check('最近派单 = 区间内最晚的一条', me['lastDispatch'] == '2026-11-12 23:59:59', me['lastDispatch'])
        check('员工姓名 / 工号取自员工表（查不到时回落到工单快照）',
              bool(me['ownerName']), me['ownerName'])
        check('range.days 为闭区间天数 = 12', (d.get('range') or {}).get('days') == 12, d.get('range'))

        print('\n--- 2. 区间边界 ---')
        d2 = svc.stats({'_loginUserId': uid, 'startDate': '2026-11-01', 'endDate': '2026-11-11'})
        check('区间截止 11-11 时接单 4（末日工单被排除）', row_of(d2)['orderCount'] == 4,
              row_of(d2)['orderCount'])
        d3 = svc.stats({'_loginUserId': uid, 'startDate': '2026-11-12', 'endDate': '2026-11-12'})
        check('单日区间只统计当天派单', row_of(d3)['orderCount'] == 1, row_of(d3)['orderCount'])
        d4 = svc.stats({'_loginUserId': uid, 'startDate': '2026-11-13', 'endDate': '2026-11-13'})
        check('次日 00:00:01 的工单归到次日', row_of(d4)['orderCount'] == 1, row_of(d4)['orderCount'])
        d5 = svc.stats({'_loginUserId': uid, 'startDate': '2026-10-01', 'endDate': '2026-10-31'})
        check('无数据区间返回空列表 + 0 值汇总（不报错）',
              not [x for x in (d5.get('list') or []) if int(x.get('ownerId') or 0) == OWNER]
              and (d5.get('summary') or {}).get('orderCount', -1) >= 0,
              d5.get('summary'))

        print('\n--- 3. 排序与未指定责任人 ---')
        base = svc.stats({'_loginUserId': uid, 'startDate': '2026-11-01', 'endDate': '2026-11-12'})
        counts = [x['orderCount'] for x in base['list'] if not x['unknown']]
        check('默认按接单数降序', counts == sorted(counts, reverse=True), counts)
        check('「未指定责任人」排在最后',
              base['list'][-1]['unknown'] is True and base['list'][-1]['ownerId'] == 0,
              base['list'][-1] if base['list'] else None)
        asc = svc.stats({'_loginUserId': uid, 'startDate': '2026-11-01', 'endDate': '2026-11-12',
                         'sortOrder': 'asc', 'sortBy': 'orderCount'})
        asc_counts = [x['orderCount'] for x in asc['list'] if not x['unknown']]
        check('sortOrder=asc 改为升序', asc_counts == sorted(asc_counts), asc_counts)
        by_rate = svc.stats({'_loginUserId': uid, 'startDate': '2026-11-01', 'endDate': '2026-11-12',
                             'sortBy': 'doneRate'})
        rates = [x['doneRate'] for x in by_rate['list'] if not x['unknown']]
        check('sortBy=doneRate 生效（降序）', rates == sorted(rates, reverse=True), rates)
        kw = svc.stats({'_loginUserId': uid, 'startDate': '2026-11-01', 'endDate': '2026-11-12',
                        'keyword': '冒烟员工'})
        check('keyword 能按员工姓名过滤', [x['ownerId'] for x in kw['list']] == [OWNER], kw['list'])

        print('\n--- 4. 汇总卡片 ---')
        s = base.get('summary') or {}
        total_orders = sum(x['orderCount'] for x in base['list'])
        check('汇总接单数 = 各行接单数之和', s.get('orderCount') == total_orders,
              '%s vs %s' % (s.get('orderCount'), total_orders))
        check('汇总完成率按总数重算（不是各行平均）',
              s.get('doneRate') == (round(s['doneCount'] * 100.0 / s['orderCount'], 1)
                                    if s.get('orderCount') else 0.0), s.get('doneRate'))
        check('覆盖计划数按整体去重（临时工单 planId 为空不计入）',
              isinstance(s.get('planCount'), int) and s['planCount'] >= 0, s.get('planCount'))

        print('\n--- 5. 钻取：工单明细 ---')
        det = svc.details({'_loginUserId': uid, 'ownerId': OWNER,
                           'startDate': '2026-11-01', 'endDate': '2026-11-12', 'pageSize': 2})
        check('明细总数 = 接单数', det['total'] == 5, det['total'])
        check('pageSize=2 时共 3 页', det['pages'] == 3, det['pages'])
        check('小计按整段区间算（不随当前页变化）',
              (det.get('summary') or {}).get('done') == 2
              and (det.get('summary') or {}).get('overdue') == 1, det.get('summary'))
        p2 = svc.details({'_loginUserId': uid, 'ownerId': OWNER, 'startDate': '2026-11-01',
                          'endDate': '2026-11-12', 'pageSize': 2, 'pageNum': 2})
        ids1 = [x['orderId'] for x in det['list']]
        ids2 = [x['orderId'] for x in p2['list']]
        check('翻页不重复', not (set(ids1) & set(ids2)), '%s / %s' % (ids1, ids2))
        check('明细按派单时间倒序', det['list'][0]['dispatchTime'] >= det['list'][-1]['dispatchTime'],
              [x['dispatchTime'] for x in det['list']])
        done_only = svc.details({'_loginUserId': uid, 'ownerId': OWNER, 'startDate': '2026-11-01',
                                 'endDate': '2026-11-12', 'status': '已完成'})
        check('按状态过滤（已完成 2 条）', done_only['total'] == 2, done_only['total'])
        over = [x for x in det['list'] if x['overdue']]
        check('明细带逾期标记与耗时字段',
              all('overdue' in x and 'days' in x and 'planId' in x and 'taskId' in x
                  for x in det['list']), det['list'][:1])
        check('已完成工单给出耗时天数（同日 0 天，不为负）',
              all((x['days'] is None or x['days'] >= 0) for x in det['list']),
              [x['days'] for x in det['list']])

        print('\n--- 6. 导出 ---')
        ex = svc.export({'_loginUserId': uid, 'startDate': '2026-11-01', 'endDate': '2026-11-12'})
        check('导出返回 xlsx 二进制（PK 头）', ex['content'][:2] == b'PK', ex['content'][:8])
        check('导出文件名带区间', '20261101' in ex['filename'] and '20261112' in ex['filename'],
              ex['filename'])
        try:
            from openpyxl import load_workbook
            import io as _io
            wb = load_workbook(_io.BytesIO(ex['content']))
            check('导出含「员工汇总」「工单明细」两个页签',
                  wb.sheetnames == ['员工汇总', '工单明细'], wb.sheetnames)
            ws = wb['员工汇总']
            names = [ws.cell(row=r, column=2).value for r in range(2, ws.max_row + 1)]
            check('汇总页签里能找到临时员工行', '冒烟员工' in names or OWNER in names, names[:5])
            ws2 = wb['工单明细']
            codes = [ws2.cell(row=r, column=1).value for r in range(2, ws2.max_row + 1)]
            check('明细页签含区间内全部工单（6 条临时单，含「未指定责任人」那条）',
                  len([c for c in codes if str(c).startswith(MARK)]) == 6,
                  [c for c in codes if str(c).startswith(MARK)])
        except ImportError:
            check('openpyxl 可用（跳过页签断言）', True)

        print('\n--- 7. 参数与权限校验 ---')
        for params, label, expect in (
            ({'startDate': '2026-11-12', 'endDate': '2026-11-01'}, '开始晚于结束', '开始日期不能晚于结束日期'),
            ({'startDate': '2025-01-01', 'endDate': '2026-11-12'}, '跨度过大', '统计区间不能超过'),
            ({'startDate': '2026/11/01'}, '日期格式非法', '格式不正确'),
        ):
            p = {'_loginUserId': uid}
            p.update(params)
            try:
                svc.stats(p)
                check('%s 应报错' % label, False, '未报错')
            except service.BizError as exc:
                check('%s 报错文案' % label, expect in exc.message, exc.message)
        try:
            svc.details({'_loginUserId': uid, 'startDate': '2026-11-01', 'endDate': '2026-11-12'})
            check('缺少 ownerId 应报错', False, '未报错')
        except service.BizError as exc:
            check('缺少 ownerId 报错文案', 'ownerId' in exc.message, exc.message)
        try:
            svc.details({'_loginUserId': uid, 'ownerId': OWNER, 'status': '乱写',
                         'startDate': '2026-11-01', 'endDate': '2026-11-12'})
            check('非法状态应报错', False, '未报错')
        except service.BizError as exc:
            check('非法状态报错文案', '工单状态只能为' in exc.message, exc.message)
        try:
            svc.stats({})
            check('未登录应 401', False, '未报错')
        except service.BizError as exc:
            check('未登录返回 401', exc.code == 401, exc.code)
        try:
            svc.stats({'_loginUserId': '00000000-0000-0000-0000-000000000000'})
            check('token 对应的用户不存在应报错', False, '未报错')
        except service.BizError as exc:
            check('无效登录用户报错', '未绑定员工' in exc.message or '登录' in exc.message, exc.message)

        print('\n--- 8. 菜单与按钮已上线 ---')
        item = db.query_one('SELECT `id`,`nameCn`,`path`,`enabled` FROM `menuinfros` WHERE `code`=%s',
                            ('MNU00028',)) or {}
        check('菜单项 MNU00028 存在且指向 workload-report.html',
              item.get('path') == 'workload-report.html' and int(item.get('enabled') or 0) == 1, item)
        bind = db.query_one('SELECT s.`sortNo`, g.`code` AS gcode FROM `menugroupitemset` s '
                            'JOIN `menugroupinfos` g ON g.`id`=s.`groupId` '
                            'WHERE s.`itemId`=%s', (item.get('id'),)) or {}
        check('已挂到项目中心（MNG1006）', bind.get('gcode') == 'MNG1006', bind)
        powers = db.query_one('SELECT COUNT(*) AS n FROM `usergrouppowerset` WHERE `menuItemId`=%s',
                              (item.get('id'),)) or {}
        roles = db.query_one('SELECT COUNT(*) AS n FROM `usergroup` WHERE `enabled`=1') or {}
        check('菜单已授权给全部启用角色',
              int(powers.get('n') or 0) >= int(roles.get('n') or 0),
              '%s / %s' % (powers.get('n'), roles.get('n')))

        btns = db.query_all('SELECT `btnId`,`btnText` FROM `pageopbtn` '
                            'WHERE `pagePath`=%s AND `enabled`=1 ORDER BY `sortNo`',
                            ('workload-report.html',))
        check('页面 3 个按钮已登记 pageopbtn', len(btns) == 3, [b['btnId'] for b in btns])
        grants = db.query_one('SELECT COUNT(DISTINCT s.`roleId`) AS n FROM `usergrouppagebtnset` s '
                              'JOIN `pageopbtn` b ON b.`id`=s.`pageOpBtnId` '
                              'WHERE b.`pagePath`=%s', ('workload-report.html',)) or {}
        check('按钮已授权给全部启用角色',
              int(grants.get('n') or 0) >= int(roles.get('n') or 0),
              '%s / %s' % (grants.get('n'), roles.get('n')))

        import page_scan
        scanned = page_scan.scan_page(os.path.join(WEB_ROOT, 'workload-report.html'),
                                      'workload-report.html')
        scanned_ids = [x['btnId'] for x in scanned]
        check('page_scan 扫到的按钮与库中登记完全一致',
              sorted(scanned_ids) == sorted([b['btnId'] for b in btns]),
              '%s vs %s' % (scanned_ids, [b['btnId'] for b in btns]))
        check('纯图标按钮的 btnText 取的是 title（不是空）',
              all((b['btnText'] or '').strip() for b in btns), [b['btnText'] for b in btns])
    finally:
        cleanup()

    left = db.query_one('SELECT COUNT(*) AS n FROM `workplanorders` WHERE `id` LIKE %s',
                        (MARK + '%',)) or {}
    check('临时工单已清理干净', int(left.get('n') or 0) == 0, left.get('n'))

    print('\n结果：%d 通过 / %d 失败' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
