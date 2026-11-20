# -*- coding: utf-8 -*-
"""
工作计划：变更规则验证（进程内，连真实 MySQL）
---------------------------------------------------------------------
覆盖：
  1) 非本人创建的计划：不能删除任务节点、不能停止计划（403）；
  2) 已启动的计划不能重复启动；
  3) 任务变更自动生成变更日志（字段级明细）并推送 IM + 邮件；
  4) 任务未完成前可多次提交执行记录，支持多附件，附件可预览；
  5) 任务标记完成后禁止再提交执行记录。

运行：python server/test_workplan_rules.py
⚠ 只创建并删除本脚本 RUNP 前缀的测试数据，不动任何用户真实记录。
"""
import datetime
import os
import shutil
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
import service

PASS = 0
FAIL = 0
RUNP = 'WP_RULE_' + datetime.datetime.now().strftime('%Y%m%d%H%M%S') + '_'
svc = service.work_plan_service

# 不打真实 IM / 邮件：替换为内存统计
SENT = {'msg': [], 'mail': []}


def fake_push(me, emp, title, content, content_html=''):
    SENT['msg'].append((emp, title, content, content_html))
    return True


def fake_mail(to_list, subject, body, body_html=''):
    SENT['mail'].append((list(to_list), subject, body, body_html))
    return True, ''


service.project_plan_service._push_message = fake_push
service.project_plan_service._send_mail = fake_mail


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


def uid_of(emp_id):
    row = db.query_one('SELECT `id` FROM `useinfo` WHERE `empId`=%s LIMIT 1', (emp_id,))
    return str(row['id']) if row else ''


def main():
    uid_admin = uid_of(1)
    uid_other = uid_of(30)
    if not uid_admin or not uid_other:
        print('  [SKIP] 缺少 empId=1 / empId=30 的登录账号')
        return 0
    plan_id = ''
    exec_ids = []
    task_a = str(__import__('uuid').uuid4())
    task_b = str(__import__('uuid').uuid4())

    def plan_payload(tasks):
        return {'_loginUserId': uid_admin, 'plan': {
            'planName': RUNP + '规则验证', 'startDate': '2026-11-01',
            'endDate': '2026-11-30', 'scale': 'day', 'ispub': 1}, 'tasks': tasks}

    try:
        print('\n--- 1. 创建 / 变更日志 / 通知 ---')
        res = svc.save(plan_payload([
            {'id': task_a, 'taskName': '任务A', 'startDate': '2026-11-01',
             'endDate': '2026-11-05', 'ownerId': 1, 'ownerName': '别文进'},
            {'id': task_b, 'taskName': '任务B', 'startDate': '2026-11-06',
             'endDate': '2026-11-10', 'ownerId': 1, 'ownerName': '别文进'},
        ]))
        plan_id = res['id']
        check('创建计划成功', bool(plan_id), res)
        logs0 = svc.changelogs({'_loginUserId': uid_admin, 'planId': plan_id})['list']
        check('创建计划时任务新增也写入变更日志', logs0 and any(x['action'] == 'add' for x in logs0),
              logs0[:1])

        SENT['msg'].clear()
        SENT['mail'].clear()
        res2 = svc.save({'_loginUserId': uid_admin, 'plan': {
            'id': plan_id, 'planName': RUNP + '规则验证', 'startDate': '2026-11-01',
            'endDate': '2026-11-30', 'scale': 'day', 'ispub': 1}, 'tasks': [
            {'id': task_a, 'taskName': '任务A', 'startDate': '2026-11-01',
             'endDate': '2026-11-07', 'ownerId': 1, 'ownerName': '别文进'},
            {'id': task_b, 'taskName': '任务B', 'startDate': '2026-11-06',
             'endDate': '2026-11-10', 'ownerId': 1, 'ownerName': '别文进'},
        ]})
        check('保存返回变更数 1', res2.get('changes') == 1, res2)
        logs = svc.changelogs({'_loginUserId': uid_admin, 'planId': plan_id})['list']
        upd_logs = [x for x in logs if x['action'] == 'update']
        check('变更日志含字段级明细（结束日期）',
              upd_logs and '结束日期' in (upd_logs[0]['detail'] or ''), logs[:2])
        check('变更推送了即时消息', len(SENT['msg']) >= 1, SENT['msg'])
        qrow = db.query_one('SELECT COUNT(*) AS n FROM `workplanmailqueue` WHERE `planId`=%s',
                            (plan_id,)) or {}
        check('变更邮件写入后台队列（保存不等待 SMTP）', int(qrow.get('n') or 0) >= 1, qrow)
        svc.process_mail_queue(50)
        sent_row = db.query_one("SELECT COUNT(*) AS n FROM `workplanmailqueue` "
                                "WHERE `planId`=%s AND `status`='sent'", (plan_id,)) or {}
        check('后台队列发送邮件成功', int(sent_row.get('n') or 0) >= 1 and len(SENT['mail']) >= 1,
              (sent_row, SENT['mail'][:1]))

        # 1.1 上级 / 前置任务变更：变更历史必须显示任务名，不能出现任务 ID
        res3 = svc.save({'_loginUserId': uid_admin, 'plan': {
            'id': plan_id, 'planName': RUNP + '规则验证', 'startDate': '2026-11-01',
            'endDate': '2026-11-30', 'scale': 'day', 'ispub': 1}, 'tasks': [
            {'id': task_a, 'taskName': '任务A', 'startDate': '2026-11-01',
             'endDate': '2026-11-07', 'ownerId': 1, 'ownerName': '别文进'},
            {'id': task_b, 'taskName': '任务B', 'startDate': '2026-11-06',
             'endDate': '2026-11-10', 'ownerId': 1, 'ownerName': '别文进',
             'parentId': task_a, 'preTaskIds': task_a},
        ]})
        check('设置上级 / 前置任务保存成功', res3.get('changes') == 1, res3)
        logs3 = svc.changelogs({'_loginUserId': uid_admin, 'planId': plan_id})['list']
        upd3 = [x for x in logs3 if x['action'] == 'update' and '上级任务' in (x['detail'] or '')]
        detail3 = (upd3[0]['detail'] if upd3 else '')
        check('变更历史上级 / 前置任务显示任务名（不出现任务 ID）',
              bool(upd3) and '任务A' in detail3 and task_a not in detail3,
              detail3)

        # 1.2 历史日志里已经存成 ID 的，读取时也转换为任务名
        svc._log_change(plan_id, task_b, '任务B', 'update', '修改任务「任务B」',
                        '前置任务：%s → 空\n上级任务：%s → 空' % (task_a, task_a),
                        uid_admin, '管理员')
        logs4 = svc.changelogs({'_loginUserId': uid_admin, 'planId': plan_id})['list']
        legacy = [x for x in logs4 if '前置任务' in (x['detail'] or '')]
        check('历史变更日志读取时把任务 ID 转换为任务名',
              bool(legacy) and '任务A' in legacy[0]['detail'] and task_a not in legacy[0]['detail'],
              legacy[0]['detail'] if legacy else '')

        SENT['msg'].clear()
        task_c = str(__import__('uuid').uuid4())
        svc.save({'_loginUserId': uid_admin, 'plan': {
            'id': plan_id, 'planName': RUNP + '规则验证', 'startDate': '2026-11-01',
            'endDate': '2026-11-30', 'scale': 'day', 'ispub': 1}, 'tasks': [
            {'id': task_a, 'taskName': '任务A', 'startDate': '2026-11-01',
             'endDate': '2026-11-07', 'ownerId': 1, 'ownerName': '别文进'},
            {'id': task_b, 'taskName': '任务B', 'startDate': '2026-11-06',
             'endDate': '2026-11-10', 'ownerId': 1, 'ownerName': '别文进'},
            {'id': task_c, 'taskName': '任务C', 'startDate': '2026-11-11',
             'endDate': '2026-11-15', 'ownerId': 30, 'ownerName': '测试'},
        ]})
        check('新增任务也通知到该任务的责任人（empId=30）',
              any(m[0] == 30 for m in SENT['msg']), SENT['msg'])

        check('变更消息用姓名 / 字典名，不含员工 id / 工单编号',
              all('WO' not in m[2] and '别文进' in m[2] for m in SENT['msg']),
              SENT['msg'][:1])
        check('变更消息 / 邮件链接可点击（<a href>）',
              all('<a href=' in m[3] for m in SENT['msg']) and
              all('<a href=' in m[3] for m in SENT['mail']),
              SENT['mail'][:1])
        # 1.5 无变化保存：不应推送；改动参与人员：新参与人也要收到
        SENT['msg'].clear()
        SENT['mail'].clear()
        cur_tasks = svc.detail({'_loginUserId': uid_admin, 'id': plan_id})['tasks']
        res0 = svc.save({'_loginUserId': uid_admin, 'plan': {
            'id': plan_id, 'planName': RUNP + '规则验证', 'startDate': '2026-11-01',
            'endDate': '2026-11-30', 'scale': 'day', 'ispub': 1}, 'tasks': cur_tasks})
        check('无任务变化的保存不推送通知（并给出提示）',
              res0.get('changes') == 0 and not SENT['msg'] and not SENT['mail'] and
              '未检测到任务变化' in (res0.get('message') or ''), res0.get('message'))

        for t in cur_tasks:
            if t['id'] == task_a:
                t['participantIds'] = str(30)
                t['participantNames'] = '测试'
        SENT['msg'].clear()
        SENT['mail'].clear()
        res1 = svc.save({'_loginUserId': uid_admin, 'plan': {
            'id': plan_id, 'planName': RUNP + '规则验证', 'startDate': '2026-11-01',
            'endDate': '2026-11-30', 'scale': 'day', 'ispub': 1}, 'tasks': cur_tasks})
        check('修改参与人员后，新参与人也收到变更通知',
              any(m[0] == 30 for m in SENT['msg']), SENT['msg'])

        # 1.6 邮件 / 站内消息瞬时失败：各重试一次后送达
        mail_calls = {'n': 0}
        push_calls = {'n': 0}
        real_mail = service.project_plan_service._send_mail
        real_push = service.project_plan_service._push_message

        def flaky_mail(to_list, subject, body, body_html=''):
            mail_calls['n'] += 1
            if mail_calls['n'] == 1:
                return False, '模拟 SMTP 瞬时失败'
            SENT['mail'].append((list(to_list), subject))
            return True, ''

        def flaky_push(me2, emp, title, content, content_html=''):
            push_calls['n'] += 1
            if push_calls['n'] == 1:
                return False
            SENT['msg'].append((emp, title, content, content_html))
            return True

        service.project_plan_service._send_mail = flaky_mail
        service.project_plan_service._push_message = flaky_push
        try:
            for t in cur_tasks:
                if t['id'] == task_b:
                    t['progress'] = 60
            res2 = svc.save({'_loginUserId': uid_admin, 'plan': {
                'id': plan_id, 'planName': RUNP + '规则验证', 'startDate': '2026-11-01',
                'endDate': '2026-11-30', 'scale': 'day', 'ispub': 1}, 'tasks': cur_tasks})
            svc.process_mail_queue(50)      # 第一次：模拟 SMTP 失败 → 转为 retry
            svc.process_mail_queue(50)      # 第二次：重试成功 → sent
        finally:
            service.project_plan_service._send_mail = real_mail
            service.project_plan_service._push_message = real_push
        retry_row = db.query_one("SELECT * FROM `workplanmailqueue` WHERE `planId`=%s "
                                 "AND `attempts`>=2 ORDER BY `createTime` DESC LIMIT 1",
                                 (plan_id,)) or {}
        check('邮件发送失败自动重试并最终送达',
              (retry_row.get('status') == 'sent') and mail_calls['n'] >= 2,
              (retry_row.get('status'), retry_row.get('attempts'), mail_calls['n']))
        check('站内消息瞬时失败自动重试并送达',
              res2.get('notified', 0) >= 1 and push_calls['n'] >= 2,
              (res2.get('notified'), push_calls['n']))

        print('\n--- 2. 启动幂等 ---')
        st = svc.start({'_loginUserId': uid_admin, 'planId': plan_id})
        check('首次启动成功', st.get('status') == '已启动', st)
        ok, msg = raises(lambda: svc.start({'_loginUserId': uid_admin, 'planId': plan_id}), '已启动')
        check('已启动的计划不能重复启动', ok, msg)

        print('\n--- 3. 非创建人权限 ---')
        tasks = svc.detail({'_loginUserId': uid_other, 'id': plan_id})['tasks']
        keep = [t for t in tasks if t['taskName'] == '任务A']
        ok, msg = raises(lambda: svc.save({'_loginUserId': uid_other, 'plan': {
            'id': plan_id, 'planName': RUNP + '规则验证', 'startDate': '2026-11-01',
            'endDate': '2026-11-30', 'scale': 'day', 'ispub': 1}, 'tasks': keep}),
            '不能删除任务节点')
        check('非创建人删除任务被拒绝', ok, msg)
        ok, msg = raises(lambda: svc.stop({'_loginUserId': uid_other, 'planId': plan_id}),
                         '只有计划创建人')
        check('非创建人停止计划被拒绝', ok, msg)
        ok, msg = raises(lambda: svc.delete({'_loginUserId': uid_admin, 'id': plan_id}), '执行中')
        check('执行中的计划不能删除（只能停止）', ok, msg)
        stopped = svc.stop({'_loginUserId': uid_admin, 'planId': plan_id})
        check('创建人可以停止计划', stopped.get('status') == '已停止', stopped)

        print('\n--- 4. 多次执行记录 + 多附件 ---')
        uid_row = db.query_one('SELECT `id` FROM `useinfo` WHERE `empId`=1 LIMIT 1')
        orders = svc.orders({'_loginUserId': uid_admin, 'pageNum': 1, 'pageSize': 200})['list']
        mine = [o for o in orders if o.get('planId') == plan_id]
        if not mine:
            check('找到计划工单', False)
            return 1
        oid = mine[0]['id']
        po = svc.plan_orders({'_loginUserId': uid_admin, 'planId': plan_id})
        check('计划工单接口返回该计划全部工单',
              po.get('total', 0) >= 1 and
              all(x.get('planId') == plan_id for x in po.get('list') or []), po.get('total'))
        seq = [(1 if x.get('projectKey') == '__none__' else 0, x.get('projectName') or '',
                x.get('planCode') or '', x.get('orderCode') or '') for x in po.get('list') or []]
        check('工单按项目 / 计划编号 / 工单号排序', seq == sorted(seq), seq[:3])
        check('计划工单回带执行 / 变更条数与可见项目选项',
              all(('execCount' in x and 'changeCount' in x) for x in po.get('list') or []) and
              isinstance(po.get('projects'), list), po.get('projects'))
        exp = svc.export_orders({'_loginUserId': uid_admin, 'planId': plan_id})
        check('计划工单可导出 Excel（xlsx 文件头 / 行数）',
              (exp.get('content') or b'')[:2] == b'PK' and exp.get('rowCount', 0) >= 1,
              (exp.get('rowCount'), len(exp.get('content') or b'')))
        po_st = svc.plan_orders({'_loginUserId': uid_admin, 'planId': plan_id,
                                  'status': '待处理,已完成'})
        check('工单状态支持多选过滤',
              all(x.get('status') in ('待处理', '已完成') for x in po_st.get('list') or []),
              po_st.get('total'))
        po_ex = svc.plan_orders({'_loginUserId': uid_admin, 'planId': plan_id,
                                  'execStatus': '未开始,进行中'})
        check('执行状态支持多选过滤',
              all(x.get('execStatus') in ('未开始', '进行中') for x in po_ex.get('list') or []),
              po_ex.get('total'))
        po_none = svc.plan_orders({'_loginUserId': uid_admin, 'projectId': '__none__'})
        check('未关联项目的计划可单独汇总',
              isinstance(po_none.get('summary'), list) and
              all(x.get('projectKey') == '__none__' for x in po_none.get('list') or []),
              po_none.get('total'))
        check('我的任务工单回带变更历史条数',
              (mine[0].get('changeCount') or 0) >= 1, mine[0].get('changeCount'))
        payload = {'_loginUserId': uid_admin, 'orderId': oid, 'execStatus': '进行中',
                   'status': '处理中', 'progress': 30, 'execRemark': '第一次执行',
                   'title': '执行记录一',
                   'files': [
                       {'name': 'a.txt', 'data': 'data:text/plain;base64,' +
                        service.base64.b64encode(b'hello').decode('ascii')},
                       {'name': 'b.png', 'data': 'data:image/png;base64,' +
                        service.base64.b64encode(b'\x89PNG\r\n\x1a\n').decode('ascii')},
                   ]}
        r1 = svc.exec_record(payload)
        exec_ids.append(r1.get('execId'))
        check('第 1 次执行记录提交成功（2 个附件）',
              bool(r1.get('execId')) and len(r1.get('files', [])) == 2, r1)
        r2 = svc.exec_record(dict(payload, execRemark='第二次执行', title='执行记录二'))
        exec_ids.append(r2.get('execId'))
        check('未完成状态下可再次提交', r2.get('execId') != r1.get('execId'), r2)
        lst = svc.execs({'_loginUserId': uid_admin, 'orderId': oid})['list']
        check('执行记录列表返回 2 条', len(lst) == 2, [x['title'] for x in lst])
        preview = svc.execfile({'_loginUserId': uid_admin, 'id': lst[0]['files'][0]['id']})
        check('附件可预览（dataUrl）', bool(preview.get('dataUrl')), preview.get('mime'))
        raw = svc.exec_raw({'_loginUserId': uid_admin, 'id': lst[0]['files'][0]['id']})
        check('附件原始流可供 FilePreview 在线浏览',
              bool(raw.get('content')) and bool(raw.get('contentType')),
              raw.get('contentType'))
        logs2 = svc.changelogs({'_loginUserId': uid_admin, 'planId': plan_id})['list']
        check('执行记录写入变更日志（exec）', any(x['action'] == 'exec' for x in logs2))

        print('\n--- 5. 完成后禁止再提交 ---')
        tasks = svc.detail({'_loginUserId': uid_admin, 'id': plan_id})['tasks']
        for t in tasks:
            if t['id'] == r1['taskId']:
                t['execStatus'] = '已完成'
        svc.save({'_loginUserId': uid_admin, 'plan': {
            'id': plan_id, 'planName': RUNP + '规则验证', 'startDate': '2026-11-01',
            'endDate': '2026-11-30', 'scale': 'day', 'ispub': 1}, 'tasks': tasks})
        ok, msg = raises(lambda: svc.exec_record(dict(payload, execRemark='完成后补充')), '已完成')
        check('已完成任务禁止再提交', ok, msg)
        ok, msg = raises(lambda: svc.delete({'_loginUserId': uid_other, 'id': plan_id}), '非本人')
        check('非创建人不能删除计划', ok, msg)
        deleted = svc.delete({'_loginUserId': uid_admin, 'id': plan_id})
        check('停止后创建人可以删除计划', deleted.get('deleted') == 1, deleted)
    finally:
        if plan_id:
            for sql in ('DELETE FROM `workplanexecfiles` WHERE `execId` IN '
                        '(SELECT `id` FROM `workplanexecs` WHERE `planId`=%s)',
                        'DELETE FROM `workplanexecs` WHERE `planId`=%s',
                        'DELETE FROM `workplanmailqueue` WHERE `planId`=%s',
                        'DELETE FROM `workplanchangelogs` WHERE `planId`=%s',
                        'DELETE FROM `workplanorders` WHERE `planId`=%s',
                        'DELETE FROM `workplantasks` WHERE `planId`=%s',
                        'DELETE FROM `workplans` WHERE `id`=%s'):
                try:
                    db.execute(sql, (plan_id,))
                except Exception:
                    traceback.print_exc()
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads', 'workplan')
        for eid in exec_ids:
            if eid:
                shutil.rmtree(os.path.join(root, eid), ignore_errors=True)
        if plan_id:
            print('  [clean] 已清理测试计划 %s' % plan_id)
    return 1 if FAIL else 0


if __name__ == '__main__':
    code = main()
    print('\n===== 结果：%d 通过 / %d 失败 =====' % (PASS, FAIL))
    sys.exit(code)
