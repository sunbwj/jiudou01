# -*- coding: utf-8 -*-
"""
项目计划 v2 服务验证（进程内）：计划 → 事项 → 工单 + 附件 + 通知
"""
import base64
import datetime
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
import service

PASS = 0
FAIL = 0
RUNP = 'PLAN2' + datetime.datetime.now().strftime('%Y%m%d%H%M%S') + '_'
svc = service.project_plan_service


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, ('→ ' + str(extra)) if extra else ''))


def main():
    row = db.query_one('SELECT u.`id`,u.`empId` FROM `useinfo` u '
                       'JOIN `useinforoleset` r ON r.`userId`=u.`id` '
                       'WHERE u.`enabled`=1 AND u.`empId`>0 LIMIT 1')
    if not row:
        print('没有可用账号，跳过')
        return
    uid, emp_id = str(row['id']), int(row['empId'])

    pid = str(uuid.uuid4())
    db.execute('INSERT INTO `projectinfos` (`id`,`projectCode`,`projectName`,`projectType`,'
               '`projectStatus`,`ispub`,`createEname`,`createempinfosid`) '
               'VALUES (%s,%s,%s,%s,%s,1,%s,%s)',
               (pid, 'PRO9' + pid[:5].upper(), RUNP + '项目', '研发', '未开始', '测试', emp_id))
    plan_id = item_ids = None
    try:
        print('\n--- 1. 权限 / 参数校验 ---')
        try:
            svc.page({})
            check('无登录 401', False)
        except service.BizError as exc:
            check('无登录 401', exc.code == 401, exc.code)
        try:
            svc.add({'projectId': str(uuid.uuid4()), '_loginUserId': uid})
            check('项目不存在 404', False)
        except service.BizError as exc:
            check('项目不存在 404', exc.code == 404, exc.message)

        print('\n--- 2. 创建计划（PL + 6 位） ---')
        plan = svc.add({'projectId': pid, 'planName': RUNP + '一期计划',
                        'startDate': '2026-11-10', 'endDate': '2026-12-20',
                        'planDesc': '一期实施', '_loginUserId': uid})
        plan_id = plan['id']
        check('计划编号 PL + 6 位', plan['planCode'].startswith('PL') and len(plan['planCode']) == 8,
              plan['planCode'])

        print('\n--- 3. 新增事项：IT 编号 + 一事项一工单 + 通知责任人 ---')
        item = svc.item_add({'planId': plan_id, 'itemName': RUNP + '需求调研', 'itemType': '事项',
                             'itemDesc': '调研', 'inputCond': '合同', 'milestoneOut': '调研报告',
                             'startTime': '2026-11-10 09:00', 'endTime': '2026-11-12 18:00',
                             'ownerId': emp_id, 'participantIds': [emp_id], 'status': '待执行',
                             '_loginUserId': uid})
        item_ids = item['id']
        check('事项编号 IT + 6 位', item['itemCode'].startswith('IT') and len(item['itemCode']) == 8,
              item['itemCode'])
        check('自动生成工单 WO + 6 位', item['orderCode'].startswith('WO') and len(item['orderCode']) == 8,
              item['orderCode'])
        check('指定责任人后 notified=1', item['notified'] == 1, item)
        msg = db.query_one("SELECT `content`,`title` FROM emp_msgs WHERE `receiverId`=%s "
                           "AND `title`='计划事项通知' ORDER BY `sendTime` DESC LIMIT 1", (emp_id,))
        check('站内消息含事项链接', bool(msg) and 'project-plan-item-form.html' in msg['content']
              and 'itemId=' in msg['content'], (msg or {}).get('content', '')[:120])
        files = svc.item_files({'itemId': item_ids, '_loginUserId': uid})
        check('新事项附件为空', files['total'] == 0, files['total'])

        print('\n--- 4. 事项列表 / 详情 ---')
        items = svc.items({'planId': plan_id, '_loginUserId': uid})
        check('计划下有 1 个事项', items['total'] == 1, items['total'])
        one = items['list'][0]
        check('列表带工单号 / 状态 / 责任人',
              one['orderCode'] and one['status'] == '待执行' and int(one['ownerId']) == emp_id, one)
        detail = svc.item_detail({'id': item_ids, '_loginUserId': uid})
        check('详情带项目名 / 计划编号 / 附件清单',
              detail['projectName'] and detail['planCode'] == plan['planCode'] and detail['files'] == [],
              {k: detail.get(k) for k in ('projectName', 'planCode')})

        print('\n--- 5. 事项附件：上传 / 列表 / 下载 / 删除 ---')
        raw = b'hello plan attachment'
        up = svc.item_file_add({'itemId': item_ids, 'fileName': '说明.txt',
                                'data': 'data:text/plain;base64,' + base64.b64encode(raw).decode(),
                                '_loginUserId': uid})
        check('附件已上传', bool(up.get('id')) and up['fileName'] == '说明.txt', up)
        check('文件类型识别为文档', svc.item_files({'itemId': item_ids, '_loginUserId': uid})['list'][0]['fileType'] == '文档')
        dl = svc.item_file_download({'id': up['id'], '_loginUserId': uid})
        check('下载地址可用', dl['url'].startswith('/data/planfiles/'), dl.get('url'))
        svc.item_file_delete({'id': up['id'], '_loginUserId': uid})
        check('删除后附件为空', svc.item_files({'itemId': item_ids, '_loginUserId': uid})['total'] == 0)

        print('\n--- 6. 状态字典 ---')
        st = svc.statuses()
        check('状态下拉来自字典（4 项）',
              set(st['statuses']) == {'待执行', '执行中', '完成', '异常'} and st['dictNameEn'] == 'project_plan_item_status',
              st)
        try:
            svc.item_update({'id': item_ids, 'planId': plan_id, 'itemName': RUNP + 'x',
                             'status': '不存在的状态', '_loginUserId': uid})
            check('非法状态被拒', False)
        except service.BizError as exc:
            check('非法状态被拒', '字典' in exc.message, exc.message)

        print('\n--- 7. 启动计划：给无工单事项补派 ---')
        db.execute('DELETE FROM `projectworkorders` WHERE `itemId`=%s', (item_ids,))
        started = svc.start({'planId': plan_id, '_loginUserId': uid})
        check('启动补派 1 张工单', started['created'] == 1, started)
        orders = svc.orders({'planId': plan_id, '_loginUserId': uid})
        check('工单清单 1 条且挂在该事项上', orders['total'] == 1 and orders['list'][0]['itemId'] == item_ids,
              orders['total'])
        again = svc.start({'planId': plan_id, '_loginUserId': uid})
        check('再次启动不重复派单', again['created'] == 0, again)

        print('\n--- 8. 删除事项 / 删除计划级联 ---')
        svc.item_delete({'id': item_ids, '_loginUserId': uid})
        check('删除事项后工单为 0',
              db.query_one('SELECT COUNT(*) AS n FROM projectworkorders WHERE itemId=%s', (item_ids,))['n'] == 0)
        item2 = svc.item_add({'planId': plan_id, 'itemName': RUNP + '联调', 'ownerId': emp_id,
                              '_loginUserId': uid})
        item_ids = item2['id']
        svc.delete({'id': plan_id, '_loginUserId': uid})
        check('删除计划后事项 / 工单为 0',
              db.query_one('SELECT COUNT(*) AS n FROM projectplanitems WHERE planId=%s', (plan_id,))['n'] == 0 and
              db.query_one('SELECT COUNT(*) AS n FROM projectworkorders WHERE planId=%s', (plan_id,))['n'] == 0)
        plan_id = None
    finally:
        if plan_id:
            db.execute('DELETE FROM `projectplanitemfiles` WHERE `projectId`=%s', (pid,))
            db.execute('DELETE FROM `projectworkorders` WHERE `projectId`=%s', (pid,))
            db.execute('DELETE FROM `projectplanitems` WHERE `projectId`=%s', (pid,))
            db.execute('DELETE FROM `projectplans` WHERE `id`=%s', (plan_id,))
        db.execute('DELETE FROM `projectinfos` WHERE `id`=%s', (pid,))
        db.execute("DELETE FROM `emp_msgs` WHERE `receiverId`=%s AND `title` IN ('计划事项通知','工单派送')",
                   (emp_id,))

    check('测试数据已清理',
          db.query_one('SELECT COUNT(*) AS n FROM projectinfos WHERE id=%s', (pid,))['n'] == 0)


if __name__ == '__main__':
    main()
    print('\n===== test_project_plan_service(v2) 结果：%d 通过 / %d 失败 =====' % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)
