# -*- coding: utf-8 -*-
"""
缺陷 / 问题管理服务验证（进程内，连真实 MySQL）
---------------------------------------------------------------------
覆盖：登记（编号 / 必填校验）/ 评估时间线（三种结论 + 必填校验）/
     确认缺陷（三组责任人校验 → 1 计划 + 3 任务 + 3 工单）/ 工作量统计排除验收工单 /
     重复确认拦截 / 清理自建残骸。

运行：python server/test_bug_service.py
⚠ 站内消息与邮件全部 mock 掉（不打扰任何人），只清理本脚本自建的 bug / 计划 / 工单。
"""
import base64
import datetime
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
import service

PASS = 0
FAIL = 0
svc = service.bug_service
wp = service.work_plan_service

# 所有通知就地吞掉：本脚本只验证落库与链路，不发真消息 / 真邮件
service.project_plan_service._push_message = lambda *a, **k: True
service.project_plan_service._send_mail = lambda *a, **k: (True, '')

LOGIN_ID = '91638e48-7830-4644-8b9e-1b7dda75c333'      # useinfo.id（empId=1 别文进）
EMP_ID = 1
MARK = '[冒烟勿用] ' + datetime.datetime.now().strftime('%m%d%H%M%S')


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


def first_emps(n=3):
    rows = db.query_all('SELECT `id`,`nameCn` FROM `empinfos` ORDER BY `id` LIMIT %s', (n,))
    return [service.dump_row(r) for r in (rows or [])]


def first_project():
    row = db.query_one('SELECT `id`,`projectName` FROM `projectinfos` WHERE `enabled`=1 '
                       'ORDER BY `projectCode` LIMIT 1')
    return (service.dump_row(row) if row else {}) or {}


def main():
    prj = first_project()
    check('取到一个启用项目（登记必填项）', bool(prj.get('id')), prj)
    if not prj.get('id'):
        print('  没有启用的项目，无法继续')
        return

    print('\n== 1. 登记 ==')
    base = {
        '_loginUserId': LOGIN_ID,
        'title': MARK + ' 结算页提交后金额翻倍',
        'projectId': prj['id'], 'projectName': prj['projectName'],
        'happenTime': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
        'sourceType': '客户现场',
        'receiverId': EMP_ID,
        'description': '客户现场：购物车 3 件商品，点击提交后应付金额变成 2 倍。',
        'descriptionHtml': '<p>客户现场：购物车 3 件商品，点击提交后应付金额变成 2 倍。</p>',
    }
    ok, msg = raises(lambda: svc.add(dict(base, receiverId=0)), '接收人员')
    check('缺接收人时拒绝登记', ok, msg)
    ok, msg = raises(lambda: svc.add(dict(base, title='')), '标题')
    check('缺标题时拒绝登记', ok, msg)
    ok, msg = raises(lambda: svc.add(dict(base, description='', descriptionHtml='')), '描述')
    check('缺问题描述时拒绝登记', ok, msg)

    res = svc.add(base)
    bug_id = res['id']
    check('登记成功并生成 BUG 编号', bool(bug_id) and res.get('bugCode', '').startswith('BUG'), res)
    bug = svc._row(bug_id)
    check('初始状态为「待评估」', bug.get('status') == '待评估', bug.get('status'))
    check('接收人 / 创建人落库', int(bug.get('receiverId') or 0) == EMP_ID and int(bug.get('reporterId') or 0) == EMP_ID)
    check('验收人默认 = 创建人', int(bug.get('acceptOwnerId') or 0) == EMP_ID)

    print('\n== 2. 列表与详情 ==')
    page = svc.page({'_loginUserId': LOGIN_ID, 'keyword': 'BUG', 'pageNum': 1, 'pageSize': 50})
    check('列表能查到新登记的缺陷', any(str(r.get('id')) == bug_id for r in page['list']), page['total'])
    detail = svc.detail({'_loginUserId': LOGIN_ID, 'id': bug_id})
    check('详情评估时间线初始为空', detail['evaluations'] == [])
    check('详情还没有关联工单', detail['orders'] == [])

    print('\n== 3. 附件（base64 → 落盘 → 详情带出） ==')
    sample = b'bug attachment sample 2026'
    up = svc.upload({'_loginUserId': LOGIN_ID, 'bugId': bug_id,
                     'files': [{'name': '现场截图.txt', 'size': len(sample),
                                'data': base64.b64encode(sample).decode('ascii')}]})
    check('附件上传成功', len(up.get('files') or []) == 1, up)
    fid = ((up.get('files') or [{}])[0]).get('id')
    detail = svc.detail({'_loginUserId': LOGIN_ID, 'id': bug_id})
    check('详情带出附件列表', len(detail.get('files') or []) == 1, detail.get('files'))
    f = svc.file_data({'_loginUserId': LOGIN_ID, 'id': fid})
    check('附件读取还原内容',
          base64.b64decode(f['dataUrl'].split(';base64,', 1)[1]) == sample, f.get('name'))
    ok, msg = raises(lambda: svc.upload({'_loginUserId': LOGIN_ID, 'bugId': bug_id,
                                         'files': [{'name': '坏.txt', 'data': '!!!'}]}), '不合法')
    check('非法 base64 被拒绝', ok, msg)

    print('\n== 4. 评估（时间线追加） ==')
    ok, msg = raises(lambda: svc.evaluate({'_loginUserId': LOGIN_ID, 'id': bug_id,
                                           'result': '随便'}), '评估结论')
    check('非法评估结论被拒绝', ok, msg)
    ok, msg = raises(lambda: svc.evaluate({'_loginUserId': LOGIN_ID, 'id': bug_id,
                                           'result': '是缺陷'}), '严重级别')
    check('确认为缺陷但未定级时拒绝', ok, msg)
    ok, msg = raises(lambda: svc.evaluate({'_loginUserId': LOGIN_ID, 'id': bug_id,
                                           'result': '非缺陷'}), '原因')
    check('判为非缺陷但未填原因时拒绝', ok, msg)

    svc.evaluate({'_loginUserId': LOGIN_ID, 'id': bug_id, 'result': '需补充信息',
                  'reason': '请补充控制台报错与订单号'})
    bug = svc._row(bug_id)
    check('「需补充信息」退回待评估', bug.get('status') == '待评估', bug.get('status'))

    svc.evaluate({'_loginUserId': LOGIN_ID, 'id': bug_id, 'result': '是缺陷', 'level': 'P1',
                  'reason': '复现确认，金额计算重复累加', 'reasonHtml': '<p>复现确认，金额计算重复累加</p>'})
    bug = svc._row(bug_id)
    check('「是缺陷」后状态流转为已确认', bug.get('status') == '已确认', bug.get('status'))
    check('定级写入 P1', bug.get('level') == 'P1', bug.get('level'))
    detail = svc.detail({'_loginUserId': LOGIN_ID, 'id': bug_id})
    check('评估时间线累计 2 条（含退回）', len(detail['evaluations']) == 2, len(detail['evaluations']))
    check('时间线按旧→新排序', detail['evaluations'][0]['result'] == '需补充信息'
          and detail['evaluations'][-1]['result'] == '是缺陷')

    print('\n== 5. 确认缺陷 → 生成修复工单 ==')
    today = datetime.date.today()
    d1 = today.strftime('%Y-%m-%d')
    d2 = (today + datetime.timedelta(days=3)).strftime('%Y-%m-%d')
    # 三位责任人必须是不同的人：三人相同的话「三张工单各自归属」这类问题测不出来
    emps = first_emps(3)
    check('取到 3 个不同员工（研发 / 测试 / 验收）', len(emps) == 3, emps)
    DEV_ID, TEST_ID, ACC_ID = [int(e['id']) for e in emps]
    base_confirm = {
        '_loginUserId': LOGIN_ID, 'id': bug_id,
        'devOwnerId': DEV_ID, 'devStartDate': d1, 'devEndDate': d2,
        'testOwnerId': TEST_ID, 'testStartDate': d1, 'testEndDate': d2,
        'acceptOwnerId': ACC_ID, 'acceptStartDate': d1, 'acceptEndDate': d2,
    }
    ok, msg = raises(lambda: svc.confirm(dict(base_confirm, testOwnerId=0)), '测试责任人')
    check('缺测试责任人时拒绝生成', ok, msg)
    ok, msg = raises(lambda: svc.confirm(dict(base_confirm, devStartDate=d2, devEndDate=d1)),
                     '开始日期')
    check('研发开始晚于结束时拒绝', ok, msg)

    res = svc.confirm(base_confirm)
    plan_id = res.get('planId')
    check('生成修复计划（WP 编号）', bool(plan_id) and str(res.get('planCode', '')).startswith('WP'), res)
    check('派发 3 张工单', int(res.get('orders') or 0) == 3, res.get('orders'))

    bug = svc._row(bug_id)
    check('缺陷状态转「已转工单」', bug.get('status') == '已转工单', bug.get('status'))
    check('缺陷回写 planId', str(bug.get('planId')) == str(plan_id))
    check('三组责任人落库且互不覆盖',
          int(bug.get('devOwnerId') or 0) == DEV_ID
          and int(bug.get('testOwnerId') or 0) == TEST_ID
          and int(bug.get('acceptOwnerId') or 0) == ACC_ID,
          (bug.get('devOwnerId'), bug.get('testOwnerId'), bug.get('acceptOwnerId')))
    check('三组起止时间落库', str(bug.get('devEndDate'))[:10] == d2
          and str(bug.get('acceptStartDate'))[:10] == d1)

    tasks = db.query_all('SELECT `orderKind`,`ownerId`,`startDate`,`endDate`,`taskName` '
                         'FROM `workplantasks` WHERE `planId`=%s ORDER BY `orderKind`', (plan_id,))
    tasks = [service.dump_row(r) for r in (tasks or [])]
    kinds = sorted([str(t.get('orderKind')) for t in tasks])
    check('计划下 3 条任务，来源标记完整', kinds == ['bug-accept', 'bug-dev', 'bug-test'], kinds)
    task_owner = dict((str(t.get('orderKind')), int(t.get('ownerId') or 0)) for t in tasks)
    check('任务责任人 = 各自责任人（研发 / 测试 / 验收）',
          task_owner == {'bug-dev': DEV_ID, 'bug-test': TEST_ID, 'bug-accept': ACC_ID},
          task_owner)

    orders = db.query_all('SELECT `orderCode`,`orderKind`,`ownerId`,`status`,`dispatchTime`,`taskId` '
                          'FROM `workplanorders` WHERE `planId`=%s', (plan_id,))
    orders = [service.dump_row(r) for r in (orders or [])]
    okinds = sorted([str(o.get('orderKind')) for o in orders])
    check('生成 3 张工单且来源标记正确', okinds == ['bug-accept', 'bug-dev', 'bug-test'], okinds)
    order_owner = dict((str(o.get('orderKind')), int(o.get('ownerId') or 0)) for o in orders)
    check('三张工单分别派给各自责任人（不再都归验收人）',
          order_owner == {'bug-dev': DEV_ID, 'bug-test': TEST_ID, 'bug-accept': ACC_ID},
          order_owner)
    check('工单均已派单（dispatchTime 有值）', all(o.get('dispatchTime') for o in orders))
    check('工单状态为待处理', all(str(o.get('status')) == '待处理' for o in orders))
    check('工单编号均为 WO 前缀', all(str(o.get('orderCode', '')).startswith('WO') for o in orders))

    plan = db.query_one('SELECT `status`,`planCode` FROM `workplans` WHERE `id`=%s', (plan_id,))
    plan = service.dump_row(plan) if plan else {}
    check('修复计划已启动', str(plan.get('status')) == '已启动', plan.get('status'))

    detail = svc.detail({'_loginUserId': LOGIN_ID, 'id': bug_id})
    check('详情能带出 3 张工单', len(detail['orders']) == 3, len(detail['orders']))

    ok, msg = raises(lambda: svc.confirm(base_confirm), '修复工单')
    check('重复确认被拦截', ok, msg)
    ok, msg = raises(lambda: svc.evaluate({'_loginUserId': LOGIN_ID, 'id': bug_id,
                                           'result': '是缺陷', 'level': 'P2'}), '不能再评估')
    check('已转工单后不能再评估', ok, msg)

    print('\n== 6. 工作量统计口径 ==')
    wsvc = service.workload_service
    w_start, w_end = wsvc._range({})
    stats = wsvc.stats({'_loginUserId': LOGIN_ID})
    rows = dict((int(it.get('ownerId') or 0), it) for it in (stats.get('list') or []))

    def sql_count(emp_id, exclude_accept):
        sql = ("SELECT COUNT(*) AS n FROM `workplanorders` WHERE `ownerId`=%s "
               "AND `dispatchTime` IS NOT NULL "
               "AND `dispatchTime` >= %s AND `dispatchTime` < DATE_ADD(%s, INTERVAL 1 DAY)")
        if exclude_accept:
            sql += " AND IFNULL(`orderKind`,'')<>'bug-accept'"
        row = db.query_one(sql, (emp_id, w_start, w_end))
        return int((row or {}).get('n') or 0)

    dev_row = rows.get(DEV_ID)
    check('统计里能取到研发责任人', bool(dev_row), '未找到')
    if dev_row:
        check('研发工单计入接单数', int(dev_row.get('orderCount') or 0) >= 1,
              dev_row.get('orderCount'))
    check('验收工单不计入统计（按 orderKind 排除后与库内一致）',
          int((rows.get(ACC_ID) or {}).get('orderCount') or 0) == sql_count(ACC_ID, True),
          ((rows.get(ACC_ID) or {}).get('orderCount'), sql_count(ACC_ID, True)))
    check('验收工单本身只落在验收人名下（研发 / 测试单未被合并）',
          sql_count(ACC_ID, False) - sql_count(ACC_ID, True) >= 1
          and sql_count(DEV_ID, True) >= 1 and sql_count(TEST_ID, True) >= 1,
          (sql_count(ACC_ID, False), sql_count(ACC_ID, True)))

    print('\n== 7. 关闭 ==')
    ok, msg = raises(lambda: svc.close({'_loginUserId': LOGIN_ID, 'id': bug_id}), '原因')
    check('关闭未填原因时拒绝', ok, msg)
    svc.close({'_loginUserId': LOGIN_ID, 'id': bug_id, 'closeReason': '冒烟验证完成，关闭'})
    bug = svc._row(bug_id)
    check('关闭后状态为已关闭', bug.get('status') == '已关闭', bug.get('status'))

    print('\n== 8. 清理自建数据 ==')
    try:
        db.execute('DELETE FROM `workplanorders` WHERE `planId`=%s', (plan_id,))
        db.execute('DELETE FROM `workplantasks` WHERE `planId`=%s', (plan_id,))
        db.execute('DELETE FROM `workplanchangelogs` WHERE `planId`=%s', (plan_id,))
        db.execute('DELETE FROM `workplans` WHERE `id`=%s', (plan_id,))
        db.execute('DELETE FROM `bugevaluations` WHERE `bugId`=%s', (bug_id,))
        db.execute('DELETE FROM `bugfiles` WHERE `bugId`=%s', (bug_id,))
        db.execute('DELETE FROM `buginfos` WHERE `id`=%s', (bug_id,))
        shutil.rmtree(os.path.join(svc.UPLOAD_ROOT, bug_id), ignore_errors=True)
        check('测试附件目录已清理', not os.path.isdir(os.path.join(svc.UPLOAD_ROOT, bug_id)))
        left = db.query_one('SELECT COUNT(*) AS n FROM `bugfiles` WHERE `bugId`=%s', (bug_id,))
        check('测试附件记录已删除', int((left or {}).get('n') or 0) == 0)
        left = db.query_one('SELECT COUNT(*) AS n FROM `buginfos` WHERE `id`=%s', (bug_id,))
        check('测试缺陷已删除', int((left or {}).get('n') or 0) == 0)
        left = db.query_one('SELECT COUNT(*) AS n FROM `workplantasks` WHERE `planId`=%s', (plan_id,))
        check('测试任务已删除', int((left or {}).get('n') or 0) == 0)
        left = db.query_one('SELECT COUNT(*) AS n FROM `workplanorders` WHERE `planId`=%s', (plan_id,))
        check('测试工单已删除', int((left or {}).get('n') or 0) == 0)
    except Exception as exc:
        check('清理测试数据', False, exc)

    print('\n===== %d passed, %d failed =====' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
