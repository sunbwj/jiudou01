# -*- coding: utf-8 -*-
"""
工作计划（Visio 风格）服务验证（进程内，连真实 MySQL）
---------------------------------------------------------------------
覆盖：权限 / 编号 / 空计划新建 / 整图保存（任务全量替换）/ 里程碑工期 0 /
     日期范围自动扩展 / 依赖环与父子环 / 可见性 / 删除级联 / 清理自建残骸。

运行：python server/test_workplan_service.py
⚠ 只创建并删除本脚本 RUNP 前缀的测试数据，不动任何用户真实记录。
"""
import datetime
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
import service

PASS = 0
FAIL = 0
RUNP = 'WP_TEST_' + datetime.datetime.now().strftime('%Y%m%d%H%M%S') + '_'
svc = service.work_plan_service


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, ('→ ' + str(extra)) if extra else ''))


def raises(fn, keyword=''):
    try:
        fn()
    except service.BizError as exc:
        return (not keyword or keyword in exc.message), exc.message
    except Exception as exc:
        return False, str(exc)
    return False, '未抛异常'


def main():
    # 测试不真发通知（保存时的变更通知会写库 / 发邮件），这里整体短路
    service.WorkPlanService._notify_changes = lambda self, *a, **k: {
        'notified': 0, 'mailed': 0, 'skippedMail': 0, 'errors': []}
    # 三页操作区改成标准 .toolbar 后必须能被 page_scan.py 收录（按钮权限体系）
    print('\n--- 0. 三页按钮纳入 pageopbtn 扫描 ---')
    import page_scan
    web_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    # workplan-design 里多出来的 1 个是「导入任务」（wpDBtnImport）
    wanted = {'workplan.html': 8, 'workplan-design.html': 18, 'workplan-task.html': 4}
    scanned = dict((p, len(page_scan.scan_page(os.path.join(web_root, p), p)))
                   for p in wanted)
    check('计划管理 / 工作计划 / 我的任务三页共收录 30 个按钮（新增工单 / 导入入口）',
          scanned == wanted, scanned)

    row = db.query_one('SELECT u.`id`,u.`empId` FROM `useinfo` u '
                       'WHERE u.`enabled`=1 AND u.`empId`>0 '
                       'AND u.`token` IS NOT NULL AND u.`token`<>"" LIMIT 1')
    if not row:
        print('没有可用账号，跳过')
        return
    uid, emp_id = str(row['id']), int(row['empId'])
    created_ids = [str(uuid.uuid4())]          # 他人私有记录（可见性用例）
    plan_id = None
    try:
        print('\n--- 1. 表结构 / 权限 / 参数校验 ---')
        tables = db.query_all("SHOW TABLES LIKE 'workplan%%'") or []
        check('workplans / workplantasks 两张表已建', len(tables) >= 2, len(tables))
        ok401, _ = raises(lambda: svc.page({}))
        check('无登录返回 401', ok401)
        ok_name, msg = raises(lambda: svc.add({'planName': '  ', '_loginUserId': uid}), '名称')
        check('空计划名被拒绝', ok_name, msg)
        ok_date, msg = raises(lambda: svc.add({
            'planName': RUNP + '倒置', 'startDate': '2026-12-31',
            'endDate': '2026-01-01', '_loginUserId': uid}), '不能晚于')
        check('日期倒置被拒绝', ok_date, msg)
        ok_scale, msg = raises(lambda: svc.add({
            'planName': RUNP + '刻度', 'scale': 'year', '_loginUserId': uid}), '时间刻度')
        check('非法时间刻度被拒绝', ok_scale, msg)

        print('\n--- 2. 编号预览 / 新建空计划 ---')
        code = svc.next_code({'_loginUserId': uid})['code']
        check('编号预览 WP + 6 位', code.startswith('WP') and len(code) == 8, code)
        added = svc.add({
            'planName': RUNP + '迭代工作计划', 'startDate': '2026-12-01',
            'endDate': '2026-12-31', 'planDesc': 'Visio 风格排期',
            'scale': 'week', 'skipWeekend': 1, 'ispub': 1, '_loginUserId': uid})
        plan_id = added['id']
        check('新建返回 WP 编号', added['planCode'].startswith('WP') and len(added['planCode']) == 8,
              added['planCode'])
        empty = svc.detail({'id': plan_id, '_loginUserId': uid})
        check('新建计划任务为空', empty['tasks'] == [] and empty['plan']['planName'].endswith('迭代工作计划'))

        print('\n--- 3. 整图保存：任务 / 里程碑 / 摘要 / 依赖 / 完成百分比 ---')
        t1, t2, t3 = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        tasks = [
            {'id': t1, 'taskName': '一、设计', 'taskType': 'summary',
             'startDate': '2026-12-01', 'endDate': '2026-12-10', 'progress': 50, 'sortNo': 0},
            {'id': t2, 'taskName': '原型设计', 'taskType': 'task', 'parentId': t1,
             'startDate': '2026-12-01', 'endDate': '2026-12-08', 'progress': 80,
             'preTaskIds': [], 'ownerName': '张三', 'ownerId': emp_id,
             'participantIds': [str(emp_id), '987654', str(emp_id)],
             'participantNames': ['张三', '李四', '张三'], 'sortNo': 1},
            {'id': t3, 'taskName': '设计评审', 'taskType': 'milestone',
             'startDate': '2027-01-05', 'endDate': '2027-01-20',
             'progress': 200, 'preTaskIds': [t2], 'sortNo': 2},
        ]
        saved = svc.save({'plan': {'id': plan_id, 'planName': RUNP + '迭代工作计划',
                                   'scale': 'week', 'skipWeekend': 1, 'ispub': 1},
                          'tasks': tasks, '_loginUserId': uid})
        check('整图保存返回任务数', saved['taskCount'] == 3, saved['taskCount'])
        d = svc.detail({'id': plan_id, '_loginUserId': uid})
        check('详情含 3 条任务且按 sortNo 排序',
              len(d['tasks']) == 3 and d['tasks'][0]['id'] == t1 and d['tasks'][2]['id'] == t3,
              [x['taskName'] for x in d['tasks']])
        ms = [x for x in d['tasks'] if x['taskType'] == 'milestone'][0]
        check('里程碑工期强制为 0（结束 = 开始）',
              ms['startDate'] == '2027-01-05' and ms['endDate'] == '2027-01-05',
              ms['startDate'] + '~' + ms['endDate'])
        check('完成百分比被夹到 0~100', ms['progress'] == 100, ms['progress'])
        check('前置依赖与父子层级落库',
              d['tasks'][2]['preTaskIds'] == t2 and d['tasks'][1]['parentId'] == t1,
              (d['tasks'][2]['preTaskIds'], d['tasks'][1]['parentId']))
        check('计划日期自动延伸到任务边界',
              d['plan']['startDate'] == '2026-12-01' and d['plan']['endDate'] == '2027-01-05',
              d['plan']['startDate'] + '~' + d['plan']['endDate'])
        task2 = [x for x in d['tasks'] if x['id'] == t2][0]
        check('责任人员工 ID 与姓名快照落库',
              int(task2['ownerId']) == emp_id and task2['ownerName'] == '张三',
              (task2['ownerId'], task2['ownerName']))
        check('参与人员 ID 去重、姓名按下标对齐（重名不被误删）',
              task2['participantIds'] == '%s,987654' % emp_id and
              task2['participantNames'] == '张三,李四',
              (task2['participantIds'], task2['participantNames']))
        check('未指定人员的任务给出空值而不是 None 报错',
              d['tasks'][0]['ownerId'] == 0 and d['tasks'][0]['ownerName'] == '' and
              d['tasks'][0]['participantIds'] == '' and d['tasks'][0]['participantNames'] == '',
              (d['tasks'][0]['ownerId'], d['tasks'][0]['participantIds']))
        cols = db.query_all("SELECT COLUMN_NAME FROM information_schema.COLUMNS "
                            "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='workplantasks'") or []
        names = set(str(c['COLUMN_NAME']) for c in cols)
        check('真库已补齐 ownerId / participantIds / participantNames 三列',
              {'ownerId', 'participantIds', 'participantNames'}.issubset(names),
              sorted(names & {'ownerId', 'participantIds', 'participantNames'}))
        many = svc._normalize_tasks([{'taskName': '限量',
                                      'participantIds': [str(i) for i in range(80)],
                                      'participantNames': ['N%d' % i for i in range(80)]}])
        check('参与人员超过 50 人被截断',
              len(many[0]['participantIds'].split(',')) == 50 and
              len(many[0]['participantNames'].split(',')) == 50,
              len(many[0]['participantIds'].split(',')))

        print('\n--- 4. 全量替换 / 校验分支 ---')
        saved2 = svc.save({'plan': {'id': plan_id, 'planName': RUNP + '迭代工作计划'},
                           'tasks': [{'id': t2, 'taskName': '仅剩一条',
                                      'startDate': '2026-12-02', 'endDate': '2026-12-03'}],
                           '_loginUserId': uid})
        d2 = svc.detail({'id': plan_id, '_loginUserId': uid})
        check('再保存按提交结果全量替换（3 → 1）',
              saved2['taskCount'] == 1 and len(d2['tasks']) == 1, len(d2['tasks']))
        check('缺失的 preTaskIds 被清成 None', d2['tasks'][0]['preTaskIds'] is None,
              d2['tasks'][0]['preTaskIds'])
        ok_type, msg = raises(lambda: svc.save({
            'plan': {'id': plan_id, 'planName': RUNP + '迭代工作计划'},
            'tasks': [{'taskName': 'X', 'taskType': 'unknown'}], '_loginUserId': uid}), '类型')
        check('非法任务类型被拒绝', ok_type, msg)
        # 真依赖环：两个互相引用
        a, b = str(uuid.uuid4()), str(uuid.uuid4())
        ok_cycle, msg = raises(lambda: svc.save({
            'plan': {'id': plan_id, 'planName': RUNP + '迭代工作计划'},
            'tasks': [
                {'id': a, 'taskName': 'A', 'preTaskIds': [b]},
                {'id': b, 'taskName': 'B', 'preTaskIds': [a]},
            ], '_loginUserId': uid}), '循环')
        check('前置依赖成环被拒绝', ok_cycle, msg)
        ok_parent, msg = raises(lambda: svc.save({
            'plan': {'id': plan_id, 'planName': RUNP + '迭代工作计划'},
            'tasks': [
                {'id': a, 'taskName': 'A', 'parentId': b},
                {'id': b, 'taskName': 'B', 'parentId': a},
            ], '_loginUserId': uid}), '循环')
        check('摘要任务父子成环被拒绝', ok_parent, msg)
        ok_many, msg = raises(lambda: svc.save({
            'plan': {'id': plan_id, 'planName': RUNP + '迭代工作计划'},
            'tasks': [{'taskName': 'T%d' % i} for i in range(201)],
            '_loginUserId': uid}), '最多')
        check('超过 200 条任务被拒绝', ok_many, msg)
        # 上述失败分支都不能破坏原图（事务回滚）
        d3 = svc.detail({'id': plan_id, '_loginUserId': uid})
        check('校验失败不破坏已有任务（事务回滚）', len(d3['tasks']) == 1, len(d3['tasks']))

        print('\n--- 5. 列表 / 可见性 / 更新 ---')
        page = svc.page({'keyword': RUNP, '_loginUserId': uid})
        check('关键字检索命中', page['total'] >= 1 and page['list'][0]['taskCount'] == 1,
              (page['total'], page['list'][0]['taskCount'] if page['list'] else None))
        check('列表带平均完成度', 'progress' in page['list'][0], page['list'][0].get('progress'))
        db.execute('INSERT INTO `workplans` (`id`,`planCode`,`planName`,`ispub`,'
                   '`createempinfosid`,`createEname`) VALUES (%s,%s,%s,0,%s,%s)',
                   (created_ids[0], 'WP9' + created_ids[0][:5].upper(),
                    RUNP + '他人私有', 999999 + emp_id, '测试'))
        page2 = svc.page({'keyword': RUNP + '他人私有', '_loginUserId': uid})
        check('他人私有计划不可见', page2['total'] == 0, page2['total'])
        ok403, msg = raises(lambda: svc.detail({'id': created_ids[0], '_loginUserId': uid}), '权限')
        check('直接访问他人私有计划返回 403', ok403, msg)
        upd = svc.update({'id': plan_id, 'planName': RUNP + '改名后计划',
                          'scale': 'month', '_loginUserId': uid})
        check('更新计划基础字段成功', upd['planCode'] == added['planCode'])
        d4 = svc.detail({'id': plan_id, '_loginUserId': uid})
        check('改名与刻度落库且任务未丢',
              d4['plan']['planName'].endswith('改名后计划') and d4['plan']['scale'] == 'month'
              and len(d4['tasks']) == 1)

        print('\n--- 6. 选人数据源 / 启动派单 / 我的任务 ---')
        people = svc.people({'projectId': '', '_loginUserId': uid})
        check('people 返回组织架构树 + 员工信息表（未关联项目时成员为空）',
              len(people['orgs']) > 0 and len(people['employees']) > 0 and
              people['members'] == [] and people['memberCount'] == 0,
              (len(people['orgs']), len(people['employees']), people['memberCount']))
        check('people 组织节点带 parentId / level（可渲染树层次）',
              all(o.get('parentId') is not None and o.get('level', 0) >= 1 and o.get('nameCn')
                  for o in people['orgs']))
        check('people 员工带部门 / 在职状态 / 邮箱',
              all('deptId' in e and 'status' in e and 'statusText' in e for e in people['employees'])
              and any(e.get('email') for e in people['employees']))
        proj = db.query_one('SELECT `id`,`projectName` FROM `projectinfos` ORDER BY `createTime` LIMIT 1')
        if proj:
            pm = svc.people({'projectId': str(proj['id']), '_loginUserId': uid})
            check('people 关联项目时返回项目组成员（来自 projectmembers）',
                  pm['projectId'] == str(proj['id']) and
                  pm['memberCount'] == len(pm['members']) and
                  all(m['fromGroup'] for m in pm['members']),
                  (pm['projectName'], pm['memberCount']))
        else:
            check('people 关联项目时返回项目组成员（库中暂无项目，跳过）', True)

        mail_rows = db.query_all('SELECT `id` FROM `empinfos` '
                                 'WHERE `email` IS NOT NULL AND `email`<>"" ORDER BY `id` LIMIT 3') or []
        mail_ids = [int(r['id']) for r in mail_rows]
        owner = emp_id if emp_id in mail_ids else (mail_ids[0] if mail_ids else emp_id)
        parts = [x for x in mail_ids if x != owner][:1]
        if emp_id not in [owner] + parts:
            parts.append(emp_id)                 # 保证 orders() 以当前登录人能看到工单
        t4 = str(uuid.uuid4())
        svc.save({'plan': {'id': plan_id, 'planName': RUNP + '改名后计划'},
                  'tasks': [{'id': t4, 'taskName': RUNP + '启动联调任务',
                             'startDate': '2026-12-05', 'endDate': '2026-12-10',
                             'ownerId': owner, 'ownerName': '测试责任人',
                             'participantIds': [str(x) for x in parts],
                             'participantNames': ['参与%d' % x for x in parts],
                             'progress': 10}], '_loginUserId': uid})
        pushed, mailed = [], []

        def fake_push(me, emp, title, content, content_html=''):
            pushed.append((me, emp, title, content, content_html))
            return True

        def fake_mail(to_list, subject, body, body_html=''):
            mailed.append((to_list, subject, body, body_html))
            return True, ''

        cls = service.WorkPlanService
        orig_push = cls.__dict__['_wp_push']          # staticmethod 对象，恢复时原样写回
        orig_had_mail = hasattr(service.project_plan_service, '_send_mail')
        cls._wp_push = staticmethod(fake_push)
        service.project_plan_service._send_mail = fake_mail   # 不真发邮件，避免测试污染真实信箱
        try:
            started = svc.start({'planId': plan_id, '_loginUserId': uid})
            again_err = ''
            try:
                svc.start({'planId': plan_id, '_loginUserId': uid})
            except service.BizError as exc:
                again_err = exc.message
            my_orders = svc.orders({'_loginUserId': uid})
        finally:
            cls._wp_push = orig_push
            if orig_had_mail:
                del service.project_plan_service._send_mail     # 还原成类上的实例方法

        receivers = sorted(set([owner] + parts))
        check('启动生成 1 张工单并返回「已启动」',
              started['created'] == 1 and started['status'] == '已启动', started)
        check('收件人 = 责任人 ∪ 参与人员（去重）',
              started['receivers'] == len(receivers) and started['notified'] == len(receivers),
              (started['receivers'], receivers))
        check('给每个收件人都推送站内即时消息（责任人 + 参与人员）',
              len(pushed) == len(receivers) and
              sorted(set(x[1] for x in pushed)) == receivers,
              [x[1] for x in pushed])
        check('消息正文用姓名 / 任务名，不含工单编号，链接可点击',
              all('WO' not in x[3] and 'workplan-design.html' in x[3] and
                  '打开任务' in x[3] and ('责任人' in x[3] or '参与人员' in x[3])
                  for x in pushed) and
              all('<a href=' in x[4] and 'target="_blank"' in x[4] for x in pushed))
        with_mail = []
        for rid in receivers:
            erow = db.query_one('SELECT `email` FROM `empinfos` WHERE `id`=%s LIMIT 1', (rid,)) or {}
            if erow.get('email'):
                with_mail.append(rid)
        check('每个有邮箱的收件人都收到通知邮件',
              len(mailed) == len(with_mail) and started['mailed'] == len(with_mail),
              (len(mailed), len(with_mail)))
        check('邮件标题 / 正文带任务名与计划名',
              all(RUNP + '启动联调任务' in x[1] or RUNP + '启动联调任务' in x[2]
                  for x in mailed))
        order = db.query_one('SELECT * FROM `workplanorders` WHERE `taskId`=%s LIMIT 1', (t4,)) or {}
        check('工单落库：WO 编号 / 任务类型 / 责任人 / 参与人 / 通知标记',
              bool(order) and str(order.get('orderCode', '')).startswith('WO') and
              int(order.get('ownerId') or 0) == owner and
              str(order.get('participantIds') or '') == ','.join(str(x) for x in parts) and
              int(order.get('noticeMsg') or 0) == 1 and int(order.get('noticeMail') or 0) == 1,
              (order.get('orderCode'), order.get('participantIds')))
        prow = db.query_one('SELECT `status`,`startTime`,`startEname` FROM `workplans` WHERE `id`=%s',
                            (plan_id,)) or {}
        check('计划落库为「已启动」并记录启动时间 / 启动人',
              prow.get('status') == '已启动' and bool(prow.get('startTime')) and
              bool(prow.get('startEname')), prow)
        check('已启动的计划不能重复启动（明确报错、不重复建单 / 通知）',
              '已启动' in (again_err or '') and len(pushed) == len(receivers),
              (again_err, len(pushed)))
        hit = [o for o in my_orders['list'] if o.get('orderCode') == order.get('orderCode')]
        check('我的任务包含本人工单（责任人或参与人）',
              len(hit) == 1 and hit[0]['sourceType'] == '工作计划' and
              hit[0]['role'] in ('责任人', '参与人员') and
              hit[0]['noticeMsg'] is True and hit[0]['noticeMail'] is True and
              hit[0]['link'].startswith('workplan-design.html?id='), hit)
        by_role = svc.orders({'role': '参与人员', '_loginUserId': uid})
        check('我的任务可按角色筛选',
              all(o['role'] == '参与人员' for o in by_role['list']))

        # 工单里的 projectId 是派单时快照；这里只改本脚本自建计划的关联项目，
        # orders 应当按「计划当前项目」返回，验证项目检索不会用到过期快照
        proj = db.query_one('SELECT `id` FROM `projectinfos` WHERE `enabled`=1 '
                            'ORDER BY `id` LIMIT 1') or {}
        pid = str(proj.get('id') or '')
        if pid:
            db.execute('UPDATE `workplans` SET `projectId`=%s WHERE `id`=%s', (pid, plan_id))
            hit_prj = [o for o in svc.orders({'projectId': pid, '_loginUserId': uid})['list']
                       if o.get('orderCode') == order.get('orderCode')]
            miss_prj = [o for o in svc.orders({'projectId': str(uuid.uuid4()),
                                               '_loginUserId': uid})['list']
                        if o.get('orderCode') == order.get('orderCode')]
            check('我的任务可按关联项目筛选（取计划当前项目而非工单快照）',
                  len(hit_prj) == 1 and hit_prj[0].get('projectId') == pid and
                  len(miss_prj) == 0, (hit_prj, miss_prj))
        else:
            check('我的任务可按关联项目筛选（库里无启用项目，跳过数据分支）', True, 'no-project')

        print('\n--- 6.5 执行记录 / 工单与任务双向关联 ---')
        d5 = svc.detail({'id': plan_id, '_loginUserId': uid})
        linked_task = [x for x in d5['tasks'] if x['id'] == t4][0]
        check('detail 按 taskId JOIN 回带关联工单编号 / 状态',
              linked_task['orderLinked'] is True and
              linked_task['orderCode'] == order.get('orderCode') and
              linked_task['orderStatus'] in ('待处理', '处理中', '已完成'),
              (linked_task.get('orderCode'), linked_task.get('orderStatus')))
        o5 = [o for o in svc.orders({'_loginUserId': uid})['list']
              if o.get('orderCode') == order.get('orderCode')][0]
        check('orders 按 taskId JOIN 回带任务执行记录与 taskLinked',
              o5['taskLinked'] is True and o5['taskId'] == t4 and
              o5['execStatus'] == '未开始' and o5['actualStartDate'] == '' and
              o5['progress'] == 10 and
              o5['link'].find('&taskId=' + t4) > -1, o5)
        # 整图保存带执行记录，并验证工单关联不会因为「先删任务再插回」而断掉
        svc.save({'plan': {'id': plan_id, 'planName': RUNP + '改名后计划'},
                  'tasks': [{'id': t4, 'taskName': RUNP + '启动联调任务',
                             'startDate': '2026-12-05', 'endDate': '2026-12-10',
                             'ownerId': owner, 'ownerName': '测试责任人',
                             'participantIds': [str(x) for x in parts],
                             'participantNames': ['参与%d' % x for x in parts],
                             'progress': 40, 'execStatus': '进行中',
                             'actualStartDate': '2026-12-06', 'actualEndDate': '',
                             'execRemark': '已启动开发联调'}], '_loginUserId': uid})
        d6 = svc.detail({'id': plan_id, '_loginUserId': uid})
        t6 = [x for x in d6['tasks'] if x['id'] == t4][0]
        check('整图保存写入完成状态 / 实际开始 / 执行说明',
              t6['execStatus'] == '进行中' and t6['actualStartDate'] == '2026-12-06' and
              t6['execRemark'] == '已启动开发联调',
              (t6['execStatus'], t6['actualStartDate'], t6['execRemark']))
        o6 = [o for o in svc.orders({'_loginUserId': uid})['list']
              if o.get('orderCode') == order.get('orderCode')][0]
        check('整图保存后工单仍关联到同一条任务（taskLinked=True）',
              o6['taskLinked'] is True and o6['execStatus'] == '进行中' and
              o6['actualStartDate'] == '2026-12-06' and o6['progress'] == 40, o6)
        bad_exec, msg = raises(lambda: svc.save({
            'plan': {'id': plan_id, 'planName': RUNP + '改名后计划'},
            'tasks': [{'id': t4, 'taskName': 'X', 'execStatus': '火星状态'}],
            '_loginUserId': uid}), '完成状态')
        check('非法完成状态被后端拒绝', bad_exec, msg)
        bad_date, msg = raises(lambda: svc.save({
            'plan': {'id': plan_id, 'planName': RUNP + '改名后计划'},
            'tasks': [{'id': t4, 'taskName': 'X', 'actualStartDate': '2026-12-20',
                       'actualEndDate': '2026-12-01'}],
            '_loginUserId': uid}), '实际开始时间')
        check('实际开始晚于实际结束被拒绝', bad_date, msg)
        # 从「我的任务」回填执行记录（不走整图保存）
        exec_res = svc.exec_record({
            'orderId': str(order['id']), 'execStatus': '已完成',
            'status': '已完成', 'actualStartDate': '2026-12-06',
            'execRemark': '联调通过，已验收', 'progress': 60, '_loginUserId': uid})
        check('exec_record 回填成功且关联到任务',
              exec_res['taskLinked'] is True and exec_res['taskId'] == t4 and
              exec_res['execStatus'] == '已完成' and exec_res['status'] == '已完成',
              exec_res)
        check('「已完成」自动补实际结束并把完成百分比置 100',
              exec_res['progress'] == 100 and
              exec_res['actualEndDate'] == datetime.date.today().strftime('%Y-%m-%d'),
              (exec_res['progress'], exec_res['actualEndDate']))
        d7 = svc.detail({'id': plan_id, '_loginUserId': uid})
        t7 = [x for x in d7['tasks'] if x['id'] == t4][0]
        check('回填后计划任务的执行记录同步更新',
              t7['execStatus'] == '已完成' and t7['progress'] == 100 and
              t7['execRemark'] == '联调通过，已验收' and bool(t7['actualEndDate']),
              (t7['execStatus'], t7['progress'], t7['actualEndDate']))
        o7 = [o for o in svc.orders({'_loginUserId': uid})['list']
              if o.get('orderCode') == order.get('orderCode')][0]
        check('我的任务立刻显示新的完成状态与实际起止',
              o7['execStatus'] == '已完成' and o7['status'] == '已完成' and
              o7['actualStartDate'] == '2026-12-06' and bool(o7['actualEndDate']) and
              o7['execRemark'] == '联调通过，已验收', o7)
        by_exec = svc.orders({'execStatus': '已完成', '_loginUserId': uid})
        check('我的任务可按完成状态筛选',
              len(by_exec['list']) >= 1 and
              all(o['execStatus'] == '已完成' for o in by_exec['list']))
        order_row = db.query_one('SELECT `status` FROM `workplanorders` WHERE `id`=%s',
                                 (str(order['id']),)) or {}
        check('工单状态落库为「已完成」', order_row.get('status') == '已完成', order_row)
        # 非责任人 / 非参与人不得回填（临时替换 _me，不新增任何账号）
        orig_me = svc._me
        svc._me = lambda params: (999999999, '路人')
        try:
            forbidden, msg = raises(lambda: svc.exec_record({
                'orderId': str(order['id']), 'execStatus': '进行中',
                '_loginUserId': uid}), '只有该工单')
        finally:
            svc._me = orig_me
        check('非工单相关人员不能填写执行记录（403）', forbidden, msg)

        print('\n--- 6.6 即时消息链路 / 已启动计划新增任务自动派单 ---')
        # _wp_push 必须真正走 ProjectPlanService 单例（早期按类名调用少传 self，
        # TypeError 被兜住 → 只发邮件不发即时消息，这里用桩函数固定住这条链路）
        calls = []

        def fake_persist(sender, receivers, content, title='', msg_type='text',
                         attach_id='', group_id='', content_html='', at_emp_ids=None):
            calls.append((sender, list(receivers), content, title, content_html))
            return [{'id': str(uuid.uuid4()), 'senderId': sender,
                     'receiverId': int(receivers[0]), 'senderName': '测试',
                     'content': content, 'contentHtml': content_html,
                     'sendTime': '2026-11-09 18:00:00',
                     'title': title, 'msgType': msg_type, 'attachId': '',
                     'attach': None, 'groupId': ''}]

        t8 = str(uuid.uuid4())
        service.emp_message_service.persist_send = fake_persist
        service.project_plan_service._send_mail = fake_mail
        try:
            push_ok = svc._wp_push(emp_id, owner, '标题', '正文', '<a href="https://x">打开</a>')
            saved_new = svc.save({
                'plan': {'id': plan_id, 'planName': RUNP + '改名后计划'},
                'tasks': [
                    {'id': t4, 'taskName': RUNP + '启动联调任务',
                     'startDate': '2026-12-05', 'endDate': '2026-12-10',
                     'ownerId': owner, 'ownerName': '测试责任人',
                     'participantIds': [str(x) for x in parts],
                     'participantNames': ['参与%d' % x for x in parts],
                     'progress': 40, 'execStatus': '进行中',
                     'actualStartDate': '2026-12-06', 'execRemark': '已启动开发联调'},
                    {'id': t8, 'taskName': RUNP + '新增联调任务',
                     'startDate': '2026-12-11', 'endDate': '2026-12-15',
                     'ownerId': owner, 'ownerName': '测试责任人',
                     'participantIds': [str(x) for x in parts],
                     'participantNames': ['参与%d' % x for x in parts]}],
                '_loginUserId': uid})
        finally:
            del service.emp_message_service.persist_send
            if orig_had_mail:
                del service.project_plan_service._send_mail

        check('_wp_push 真实调用即时消息服务（返回 True，发送人 / 收件人 / 富文本链接正确）',
              push_ok is True and bool(calls) and calls[0][0] == emp_id and
              calls[0][1] == [owner] and '<a href=' in (calls[0][4] or ''),
              (push_ok, calls[:1]))
        check('已启动计划保存新增任务：自动派 1 张工单并通知责任人 + 参与人员',
              saved_new.get('dispatched') == 1 and
              saved_new.get('notified') == len(receivers) and
              saved_new.get('mailed') == len(with_mail), saved_new)
        check('保存返回文案说明新增任务已派单 / 已通知',
              '新增任务已派工单' in str(saved_new.get('message')), saved_new.get('message'))
        new_order = db.query_one('SELECT * FROM `workplanorders` WHERE `taskId`=%s LIMIT 1',
                                 (t8,)) or {}
        check('新增任务的工单落库（WO 编号 / 责任人 / 消息标记）',
              bool(new_order) and str(new_order.get('orderCode', '')).startswith('WO') and
              int(new_order.get('ownerId') or 0) == owner and
              int(new_order.get('noticeMsg') or 0) == 1,
              (new_order.get('orderCode'), new_order.get('noticeMsg')))
        again_save = svc.save({
            'plan': {'id': plan_id, 'planName': RUNP + '改名后计划'},
            'tasks': [{'id': t4, 'taskName': RUNP + '启动联调任务',
                       'startDate': '2026-12-05', 'endDate': '2026-12-10',
                       'ownerId': owner, 'ownerName': '测试责任人'},
                      {'id': t8, 'taskName': RUNP + '新增联调任务',
                       'startDate': '2026-12-11', 'endDate': '2026-12-15',
                       'ownerId': owner, 'ownerName': '测试责任人'}],
            '_loginUserId': uid})
        check('重复保存不重复派单 / 不重复通知（幂等）',
              'dispatched' not in again_save and '新增任务已派工单' not in
              str(again_save.get('message')), again_save)

        print('\n--- 7. 删除级联 ---')
        # 此时计划处于「已启动」（6.6 派过工单），必须先停止才允许删除
        del_err = ''
        try:
            svc.delete({'id': plan_id, '_loginUserId': uid})
        except service.BizError as exc:
            del_err = exc.message
        check('执行中的计划不能直接删除（提示先停止）', '先停止' in del_err, del_err)
        svc.stop({'planId': plan_id, '_loginUserId': uid})
        deleted = svc.delete({'id': plan_id, '_loginUserId': uid})
        check('删除返回任务数', deleted['taskCount'] == 2, deleted['taskCount'])
        left = db.query_one('SELECT COUNT(*) AS n FROM `workplantasks` WHERE `planId`=%s',
                            (plan_id,))['n']
        check('任务被级联清理', int(left) == 0, left)
        left_orders = db.query_one('SELECT COUNT(*) AS n FROM `workplanorders` WHERE `planId`=%s',
                                   (plan_id,))['n']
        check('工单被级联清理（任务列表不留孤儿）', int(left_orders) == 0, left_orders)
        plan_id = None
    finally:
        # 只清理本脚本创建的数据
        try:
            if plan_id:
                db.execute('DELETE FROM `workplanorders` WHERE `planId`=%s', (plan_id,))
                db.execute('DELETE FROM `workplantasks` WHERE `planId`=%s', (plan_id,))
                db.execute('DELETE FROM `workplans` WHERE `id`=%s', (plan_id,))
            for cid in created_ids:
                db.execute('DELETE FROM `workplanorders` WHERE `planId`=%s', (cid,))
                db.execute('DELETE FROM `workplantasks` WHERE `planId`=%s', (cid,))
                db.execute('DELETE FROM `workplans` WHERE `id`=%s', (cid,))
            stale = db.query_all("SELECT `id` FROM `workplans` WHERE `planName` LIKE %s",
                                 (RUNP + '%',)) or []
            for s in stale:
                db.execute('DELETE FROM `workplanorders` WHERE `planId`=%s', (s['id'],))
                db.execute('DELETE FROM `workplantasks` WHERE `planId`=%s', (s['id'],))
                db.execute('DELETE FROM `workplans` WHERE `id`=%s', (s['id'],))
        except Exception as exc:
            print('  [WARN] 清理测试数据失败：%s' % exc)
    print('\n===== test_workplan_service 结果：%d 通过 / %d 失败 =====' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
