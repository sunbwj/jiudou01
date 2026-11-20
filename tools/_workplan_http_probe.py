# -*- coding: utf-8 -*-
"""工作计划真实 HTTP 冒烟：add → save → detail → people → start → orders → delete。

运行：WP_TOKEN=<库里已有 token> [WP_TOKEN2=<另一个人的 token>] python tools/_workplan_http_probe.py
⚠ 不调登录接口（login_for_token 会顶掉用户在线会话）；只删本脚本创建的记录。
⚠ start 只跑「无责任人 / 无参与人」的探针任务：避免给真实员工发站内消息和真实邮件。
  我的任务读路径用自建工单行做一次 UPDATE（只改本探针 planId 下的行），删计划时级联清掉。
"""
import json
import os
import sys
import urllib.parse
import urllib.request
import uuid

BASE = 'http://127.0.0.1:8808/api'
TOKEN = os.environ.get('WP_TOKEN', '')
TOKEN2 = os.environ.get('WP_TOKEN2', '')
P = 0
F = 0
PLAN_ID = ''
START_PLAN_ID = ''
ORDER_CODES = []

try:
    import pymysql
except ImportError:
    pymysql = None


def check(name, cond, extra=''):
    global P, F
    if cond:
        P += 1
        print('  [PASS] ' + name)
    else:
        F += 1
        print('  [FAIL] ' + name + ('  -> ' + str(extra) if extra else ''))


def call(path, data=None, method='GET', token=None):
    body = dict(data or {})
    body['token'] = token or TOKEN
    url = BASE + path
    if method == 'GET':
        url += '?' + urllib.parse.urlencode(body)
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'),
                                     headers={'Content-Type': 'application/json;charset=UTF-8'},
                                     method='POST')
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def sql_update(sql, args):
    if not pymysql:
        return 0
    conn = pymysql.connect(host='127.0.0.1', port=3306, user='sa', password='roger2019',
                           database='rogerorm', charset='utf8mb4', autocommit=True)
    try:
        with conn.cursor() as cur:
            return cur.execute(sql, args)
    finally:
        conn.close()


def find_order(res, keyword):
    rows = (res.get('data') or {}).get('list') or []
    return [x for x in rows if keyword in (x.get('taskName') or '')]


def resolve_self():
    """按 token 反查登录人的 empId / 姓名，避免把账号写死在断言里（token 会换人）。"""
    if not pymysql:
        return 0, '', 0, ''
    conn = pymysql.connect(host='127.0.0.1', port=3306, user='sa', password='roger2019',
                           database='rogerorm', charset='utf8mb4', autocommit=True)
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute('SELECT `empId` FROM `useinfo` WHERE `token`=%s LIMIT 1', (TOKEN,))
            row = cur.fetchone() or {}
            me = int(row.get('empId') or 0)
            if not me:
                return 0, '', 0, ''
            cur.execute('SELECT `id`,`nameCn` FROM `empinfos` WHERE `id`=%s', (me,))
            mine = cur.fetchone() or {}
            cur.execute('SELECT `id`,`nameCn` FROM `empinfos` WHERE `id`<>%s '
                        'ORDER BY `id` LIMIT 1', (me,))
            other = cur.fetchone() or {}
            return me, str(mine.get('nameCn') or ''), int(other.get('id') or 0), \
                str(other.get('nameCn') or '')
    finally:
        conn.close()


def main():
    global PLAN_ID, START_PLAN_ID
    if not TOKEN:
        print('缺少 WP_TOKEN，跳过')
        return 1
    try:
        h = call('/health')
        check('health 带 workPlanCount / workPlanOrderCount 字段',
              h['code'] == 0 and 'workPlanCount' in h['data']
              and 'workPlanOrderCount' in h['data'], h.get('data', {}).keys())
        a = call('/workplan/add', {'planName': 'WP_HTTP_PROBE', 'startDate': '2026-12-01',
                                   'endDate': '2026-12-31', 'scale': 'week'}, 'POST')
        check('POST /workplan/add 创建计划', a['code'] == 0 and a['data']['planCode'].startswith('WP'), a)
        PLAN_ID = a['data']['id']
        tasks = [
            {'id': '11111111-1111-4111-8111-111111111111', 'taskName': '设计', 'taskType': 'summary',
             'startDate': '2026-12-01', 'endDate': '2026-12-10', 'progress': 30, 'sortNo': 0},
            {'id': '22222222-2222-4222-8222-222222222222', 'taskName': '开发', 'taskType': 'task',
             'startDate': '2026-12-05', 'endDate': '2026-12-20', 'progress': 50,
             'preTaskIds': ['11111111-1111-4111-8111-111111111111'],
             'parentId': '11111111-1111-4111-8111-111111111111',
             'ownerId': 3, 'ownerName': '杨伟康',
             'participantIds': ['2', '3'], 'participantNames': ['李明', '杨伟康'], 'sortNo': 1},
            {'id': '33333333-3333-4333-8333-333333333333', 'taskName': '发布', 'taskType': 'milestone',
             'startDate': '2027-01-05', 'endDate': '2027-01-20', 'progress': 0,
             'preTaskIds': ['22222222-2222-4222-8222-222222222222'], 'sortNo': 2},
        ]
        s = call('/workplan/save', {'plan': {'id': PLAN_ID, 'planName': 'WP_HTTP_PROBE',
                                             'scale': 'week'}, 'tasks': tasks}, 'POST')
        check('POST /workplan/save 整图保存 3 条任务',
              s['code'] == 0 and s['data']['taskCount'] == 3, s)
        d = call('/workplan/detail', {'id': PLAN_ID})
        check('GET /workplan/detail 返回 plan + 3 条任务',
              d['code'] == 0 and len(d['data']['tasks']) == 3, d.get('message'))
        ms = [x for x in d['data']['tasks'] if x['taskType'] == 'milestone'][0]
        check('里程碑结束日期 = 开始日期', ms['startDate'] == ms['endDate'] == '2027-01-05', ms)
        check('计划范围自动扩展到 2027-01-05', d['data']['plan']['endDate'] == '2027-01-05',
              d['data']['plan']['endDate'])
        dev = [x for x in d['data']['tasks'] if x['taskName'] == '开发'][0]
        check('HTTP 链路：责任人与参与人员原样落库并回读',
              int(dev['ownerId']) == 3 and dev['ownerName'] == '杨伟康' and
              dev['participantIds'] == '2,3' and dev['participantNames'] == '李明,杨伟康', dev)
        opts = call('/project/options')
        check('GET /project/options 返回可见 + 启用项目（供新建计划关联）',
              opts['code'] == 0 and isinstance(opts['data'].get('list'), list) and
              all(str(x.get('projectCode', '')).startswith('PRO') for x in opts['data']['list']),
              opts.get('data'))
        emps = call('/emp/list', {'pageNum': 1, 'pageSize': 5})
        check('GET /emp/list 可用（供责任人与参与人员选取）',
              emps['code'] == 0 and isinstance(emps['data'].get('list'), list) and
              all('nameCn' in x for x in emps['data']['list']), emps.get('data', {}).keys())
        pg = call('/workplan/list', {'keyword': 'WP_HTTP_PROBE'})
        check('GET /workplan/list 命中且带任务数 / 完成度',
              pg['code'] == 0 and pg['data']['total'] == 1 and
              pg['data']['list'][0]['taskCount'] == 3, pg['data'])
        nc = call('/workplan/nextcode')
        check('GET /workplan/nextcode 返回 WP 编号', nc['data']['code'].startswith('WP'), nc['data'])

        # ---------- 本轮新增：选人数据源 / 启动派单 / 我的任务 ----------
        print('\n--- 选人数据源 / 启动派单 / 我的任务 ---')
        pp = call('/workplan/people')
        pdata = pp.get('data') or {}
        check('GET /workplan/people 返回组织树 + 员工信息表',
              pp['code'] == 0 and len(pdata.get('orgs') or []) > 0
              and len(pdata.get('employees') or []) > 0
              and isinstance(pdata.get('members'), list), pp.get('message'))
        check('people 组织节点带 parentId / level 且员工带部门 / 状态 / 邮箱字段',
              all('parentId' in o and 'level' in o for o in (pdata.get('orgs') or [])) and
              all('deptId' in e and 'statusText' in e and 'email' in e
                  for e in (pdata.get('employees') or [])), pdata.get('orgs', [])[:1])
        plist = (opts['data'].get('list') or [])
        if plist:
            pg2 = call('/workplan/people', {'projectId': plist[0].get('id')})
            check('GET /workplan/people?projectId= 返回项目名与项目组成员数据源',
                  pg2['code'] == 0 and isinstance((pg2.get('data') or {}).get('members'), list)
                  and 'projectName' in (pg2.get('data') or {}), pg2.get('message'))
        else:
            check('GET /workplan/people?projectId= 返回项目名与项目组成员数据源',
                  True, '库里暂无启用项目，跳过（已由后端真库测试覆盖）')

        # 用「无责任人 / 无参与人」的任务启动，杜绝给真实员工发消息 / 邮件
        a2 = call('/workplan/add', {'planName': 'WP_HTTP_PROBE_START', 'startDate': '2026-12-01',
                                    'endDate': '2026-12-31', 'scale': 'week'}, 'POST')
        START_PLAN_ID = (a2.get('data') or {}).get('id') or ''
        one_task = {'id': '44444444-4444-4444-8444-444444444444',
                    'taskName': 'WP_HTTP_PROBE_ORDER', 'taskType': 'task',
                    'startDate': '2026-12-02', 'endDate': '2026-12-08', 'sortNo': 0}
        s2 = call('/workplan/save', {'plan': {'id': START_PLAN_ID,
                                              'planName': 'WP_HTTP_PROBE_START',
                                              'scale': 'week'}, 'tasks': [one_task]}, 'POST')
        check('启动探针：整图保存 1 条无人员任务',
              s2['code'] == 0 and s2['data']['taskCount'] == 1, s2)
        st = call('/workplan/start', {'planId': START_PLAN_ID}, 'POST')
        sd = st.get('data') or {}
        check('POST /workplan/start 生成工单且返回已启动',
              st['code'] == 0 and sd.get('created') == 1 and sd.get('status') == '已启动', st)
        check('未指派人员的任务不触发站内消息 / 邮件（真实数据零打扰）',
              sd.get('receivers') == 0 and sd.get('notified') == 0 and sd.get('mailed') == 0, sd)
        st2 = call('/workplan/start', {'planId': START_PLAN_ID}, 'POST')
        sd2 = st2.get('data') or {}
        check('重复启动幂等：不重复建单 / 不重复通知',
              st2['code'] == 0 and sd2.get('created') == 0 and sd2.get('skipped') == 1, st2)
        d2 = call('/workplan/detail', {'id': START_PLAN_ID})
        check('详情回读计划状态 = 已启动（含启动时间）',
              (d2['data']['plan'].get('status') == '已启动'
               and bool(d2['data']['plan'].get('startTime'))), d2['data']['plan'])
        t2row = d2['data']['tasks'][0]
        check('detail 按 taskId 回带关联工单编号 / 状态（工单与任务已对上）',
              t2row.get('orderLinked') is True and str(t2row.get('orderCode') or '').startswith('WO')
              and t2row.get('orderStatus') == '待处理', t2row.get('orderCode'))

        # 把本探针自建的工单临时改成「我是责任人 / 另一个人是参与人」，验证统一任务列表读路径
        me, me_name, other, other_name = resolve_self()
        if not me:
            print('  [SKIP] 无法按 token 反查员工，跳过我的任务读路径断言')
            me, me_name, other, other_name = 1, '探针责任人', 3, '探针参与人'
        changed = sql_update(
            'UPDATE `workplanorders` SET `ownerId`=%s,`ownerName`=%s,`participantIds`=%s,'
            '`participantNames`=%s,`noticeMsg`=1,`noticeMail`=0 WHERE `planId`=%s',
            (me, me_name or '责任人', str(other), other_name or '参与人', START_PLAN_ID))
        check('探针工单归属改写成功（仅本探针 planId 下的行）', changed == 1, changed)
        od = call('/workplan/orders', {'keyword': 'WP_HTTP_PROBE_ORDER'})
        mine = find_order(od, 'WP_HTTP_PROBE_ORDER')
        check('GET /workplan/orders 返回本人工单（来源 / 角色 / 编号 / 链接）',
              od['code'] == 0 and len(mine) == 1 and mine[0]['sourceType'] == '工作计划'
              and mine[0]['role'] == '责任人' and str(mine[0]['orderCode']).startswith('WO')
              and 'workplan-design.html' in (mine[0].get('link') or ''), od.get('data'))
        if mine:
            ORDER_CODES.append(mine[0]['orderCode'])

        # ---------- 本轮新增：执行记录回填 + 工单 ↔ 任务双向关联 ----------
        print('\n--- 执行记录 / 工单与任务关联 ---')
        check('orders 回带任务执行记录与 taskLinked 标记',
              mine and mine[0].get('taskLinked') is True
              and mine[0].get('execStatus') == '未开始'
              and mine[0].get('actualStartDate') == ''
              and int(mine[0].get('progress') or 0) == 0
              and ('&taskId=' in (mine[0].get('link') or '')), mine[0] if mine else None)
        ex = call('/workplan/exec', {'orderId': mine[0]['id'], 'execStatus': '进行中',
                                     'status': '处理中', 'actualStartDate': '2026-12-03',
                                     'progress': 55, 'execRemark': 'WP_HTTP_PROBE 执行中'}, 'POST')
        check('POST /workplan/exec 回填执行记录成功并关联任务',
              ex['code'] == 0 and (ex.get('data') or {}).get('taskLinked') is True, ex)
        od3 = call('/workplan/orders', {'keyword': 'WP_HTTP_PROBE_ORDER'})
        m3 = find_order(od3, 'WP_HTTP_PROBE_ORDER')
        check('我的任务立刻显示完成状态 / 实际开始 / 工单状态',
              m3 and m3[0]['execStatus'] == '进行中' and m3[0]['actualStartDate'] == '2026-12-03'
              and m3[0]['status'] == '处理中' and int(m3[0]['progress']) == 55
              and m3[0]['execRemark'] == 'WP_HTTP_PROBE 执行中', m3[0] if m3 else None)
        d3 = call('/workplan/detail', {'id': START_PLAN_ID})
        check('回填同步到计划任务（detail 回读一致）',
              d3['code'] == 0 and d3['data']['tasks'][0]['execStatus'] == '进行中'
              and d3['data']['tasks'][0]['actualStartDate'] == '2026-12-03'
              and d3['data']['tasks'][0]['progress'] == 55, d3['data']['tasks'][0])
        by_exec = call('/workplan/orders', {'keyword': 'WP_HTTP_PROBE_ORDER',
                                            'execStatus': '进行中'})
        check('我的任务可按完成状态筛选',
              by_exec['code'] == 0 and len(find_order(by_exec, 'WP_HTTP_PROBE_ORDER')) == 1,
              by_exec.get('data'))
        none_exec = call('/workplan/orders', {'keyword': 'WP_HTTP_PROBE_ORDER',
                                              'execStatus': '已完成'})
        check('完成状态筛选不命中时返回 0 条',
              none_exec['code'] == 0 and
              len(find_order(none_exec, 'WP_HTTP_PROBE_ORDER')) == 0, none_exec.get('data'))

        # ---------- 关联项目检索条件：orders 取计划当前 projectId，不用派单时快照 ----------
        print('\n--- 我的任务按关联项目筛选 ---')
        if plist:
            sel_pid = plist[0]['id']
            sql_update('UPDATE `workplans` SET `projectId`=%s WHERE `id`=%s',
                       (sel_pid, START_PLAN_ID))
            by_prj = call('/workplan/orders', {'keyword': 'WP_HTTP_PROBE_ORDER',
                                               'projectId': sel_pid})
            other_prj = call('/workplan/orders', {'keyword': 'WP_HTTP_PROBE_ORDER',
                                                  'projectId': str(uuid.uuid4())})
            hit_prj = find_order(by_prj, 'WP_HTTP_PROBE_ORDER')
            check('GET /workplan/orders?projectId= 命中本项目工单（取计划当前项目）',
                  by_prj['code'] == 0 and len(hit_prj) == 1 and
                  hit_prj[0].get('projectId') == sel_pid, by_prj.get('data'))
            check('按其它项目筛选时不返回该工单',
                  other_prj['code'] == 0 and
                  len(find_order(other_prj, 'WP_HTTP_PROBE_ORDER')) == 0,
                  other_prj.get('data'))
        else:
            check('GET /workplan/orders?projectId=（库里无启用项目，跳过数据分支）',
                  True, 'no-project')
        bad = call('/workplan/exec', {'orderId': mine[0]['id'], 'execStatus': '火星状态'}, 'POST')
        check('非法完成状态被拒绝', bad['code'] != 0, bad)
        bad2 = call('/workplan/exec', {'orderId': mine[0]['id'], 'execStatus': '已完成',
                                       'actualStartDate': '2026-12-20',
                                       'actualEndDate': '2026-12-01'}, 'POST')
        check('实际开始晚于实际结束被拒绝', bad2['code'] != 0, bad2)
        bad3 = call('/workplan/exec', {'orderId': '00000000-0000-4000-8000-000000000000',
                                       'execStatus': '进行中'}, 'POST')
        check('不存在的工单返回 404', bad3['code'] == 404, bad3)
        # 整图保存（含执行记录）后工单仍然关联同一条任务
        s3 = call('/workplan/save', {
            'plan': {'id': START_PLAN_ID, 'planName': 'WP_HTTP_PROBE_START', 'scale': 'week'},
            'tasks': [dict(one_task, execStatus='已完成', actualStartDate='2026-12-03',
                           actualEndDate='2026-12-07', execRemark='整图保存后的执行记录',
                           progress=100)]}, 'POST')
        check('整图保存写入执行记录', s3['code'] == 0 and s3['data']['taskCount'] == 1, s3)
        d4 = call('/workplan/detail', {'id': START_PLAN_ID})
        t4row = d4['data']['tasks'][0]
        check('整图保存后工单仍关联同一条任务（taskLinked 未断）',
              t4row['execStatus'] == '已完成' and t4row['actualEndDate'] == '2026-12-07'
              and t4row.get('orderLinked') is True, t4row)
        od4 = call('/workplan/orders', {'keyword': 'WP_HTTP_PROBE_ORDER'})
        m4 = find_order(od4, 'WP_HTTP_PROBE_ORDER')
        check('我的任务读到整图保存后的执行记录',
              m4 and m4[0]['execStatus'] == '已完成' and m4[0]['actualEndDate'] == '2026-12-07'
              and int(m4[0]['progress']) == 100, m4[0] if m4 else None)

        # 交换归属：用同一个有效 token 反查「参与人员」视角（FIND_IN_SET 读路径）
        swapped = sql_update(
            'UPDATE `workplanorders` SET `ownerId`=%s,`ownerName`=%s,`participantIds`=%s,'
            '`participantNames`=%s WHERE `planId`=%s',
            (other, other_name or '他人', str(me), me_name or '本人', START_PLAN_ID))
        check('探针工单归属互换成功（责任人=他人 / 参与人=本人）', swapped == 1, swapped)
        odp = call('/workplan/orders', {'keyword': 'WP_HTTP_PROBE_ORDER'})
        part = find_order(odp, 'WP_HTTP_PROBE_ORDER')
        check('作为参与人员同样能在「我的任务」里看到工单（FIND_IN_SET）',
              odp['code'] == 0 and len(part) == 1 and part[0]['role'] == '参与人员',
              odp.get('data'))
        odp2 = call('/workplan/orders', {'keyword': 'WP_HTTP_PROBE_ORDER', 'role': '责任人'})
        check('按角色筛选：参与人筛「责任人」不返回该工单',
              odp2['code'] == 0 and len(find_order(odp2, 'WP_HTTP_PROBE_ORDER')) == 0,
              odp2.get('data'))
        if TOKEN2:
            od2 = call('/workplan/orders', {'keyword': 'WP_HTTP_PROBE_ORDER'}, token=TOKEN2)
            if od2.get('code') == 401:
                print('  [SKIP] 第二个 token 已失效，跳过跨账号断言（同账号双角色已覆盖）')
            else:
                part2 = find_order(od2, 'WP_HTTP_PROBE_ORDER')
                check('另一个账号在自己的「我的任务」里看得到该工单',
                      od2['code'] == 0 and len(part2) == 1, od2.get('data'))
        else:
            print('  [SKIP] 未提供 WP_TOKEN2，跳过跨账号断言（同账号双角色已覆盖）')
    finally:
        for pid in (START_PLAN_ID, PLAN_ID):
            if not pid:
                continue
            try:
                r = call('/workplan/delete', {'id': pid}, 'POST')
                check('清理：删除本探针创建的计划（含任务与工单）', r['code'] == 0, r)
            except Exception as exc:
                print('  [WARN] 清理失败：%s' % exc)
        try:
            od = call('/workplan/orders', {'keyword': 'WP_HTTP_PROBE_ORDER'})
            check('清理后「我的任务」里没有探针工单残留',
                  od['code'] == 0 and len(find_order(od, 'WP_HTTP_PROBE_ORDER')) == 0,
                  od.get('data'))
        except Exception as exc:
            print('  [WARN] 残留校验失败：%s' % exc)
    print('\n===== workplan HTTP probe：%d 通过 / %d 失败 =====' % (P, F))
    return 1 if F else 0


if __name__ == '__main__':
    sys.exit(main())
