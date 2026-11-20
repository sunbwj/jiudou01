# -*- coding: utf-8 -*-
"""
项目组服务「进程内」验证（无需启动 Web 服务）
--------------------------------------------------
直接 import service.project_member_service 连真实 MySQL，用真实员工的 useinfo.id 构造
_loginUserId（绕开 HTTP），重点验证：
  · 权限：无登录上下文 → 401；projectId 非法 / 项目不存在 → 明确报错；
  · 查询：新项目成员为空、返回项目名 / 编号 / 是否可发邮件；
  · 保存：传空成员表 = 不改动、也不产生任何通知（added / removed / notified / mailed 全 0）；
  · 数据落库与清理：projectmembers 行数对得上，结束后按 projectId 清干净（不碰业务数据）。

注意：**这里不测「新增成员」**——那会真的给同事发站内消息与通知邮件；
新增链路走联调探针验证（保存 → added/notified/mailed + noticeMsg/noticeMail 落库）。

用法：python server/test_project_member_service.py
"""
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
import service

PASS = 0
FAIL = 0
svc = service.project_member_service


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, ('→ ' + str(extra)) if extra else ''))


def main():
    row = db.query_one('SELECT `id`,`empId` FROM `useinfo` WHERE `enabled`=1 AND `empId`>0 '
                       'ORDER BY `account` ASC LIMIT 1')
    if not row:
        print('库里没有可用的登录账号，跳过')
        return
    uid, emp_id = row['id'], int(row['empId'])

    pid = str(uuid.uuid4())
    name = 'ZZ项目组测试-' + pid[:8]
    code = 'PRO9' + pid[:5].upper()
    db.execute('INSERT INTO `projectinfos` (`id`,`projectCode`,`projectName`,`projectType`,'
               '`projectStatus`,`ispub`,`createEname`,`createempinfosid`) '
               'VALUES (%s,%s,%s,%s,%s,1,%s,%s)',
               (pid, code, name, '研发', '未开始', '测试', emp_id))
    try:
        print('\n--- 1. 权限与参数校验 ---')
        try:
            svc.members({'projectId': pid})
            check('无登录上下文被拒绝', False)
        except service.BizError as exc:
            check('无登录上下文被拒绝（401）', exc.code == 401, exc.code)

        try:
            svc.members({'projectId': 'not-a-uuid', '_loginUserId': uid})
            check('projectId 非法被拒绝', False)
        except service.BizError as exc:
            check('projectId 非法被拒绝', '不合法' in exc.message, exc.message)

        try:
            svc.members({'projectId': str(uuid.uuid4()), '_loginUserId': uid})
            check('项目不存在 → 404', False)
        except service.BizError as exc:
            check('项目不存在 → 404', exc.code == 404 and '不存在' in exc.message, exc.message)

        print('\n--- 2. 查询空成员表 ---')
        data = svc.members({'projectId': pid, '_loginUserId': uid})
        check('新项目成员为空', data.get('list') == [] and data.get('memberCount') == 0, data)
        check('返回项目名 / 编号 / 邮件可用标记',
              data.get('projectName') == name and data.get('projectCode') == code
              and 'emailEnabled' in data, data)

        print('\n--- 3. 空保存：不产生通知 ---')
        saved = svc.save_members({'projectId': pid, 'memberIds': [], '_loginUserId': uid})
        check('空保存 added/removed 均为 0',
              saved.get('added') == 0 and saved.get('removed') == 0, saved)
        check('空保存没有站内消息 / 邮件', saved.get('notified') == 0 and saved.get('mailed') == 0, saved)
        check('空保存后成员仍为 0', saved.get('memberCount') == 0, saved)

        left = db.query_one('SELECT COUNT(*) AS n FROM `projectmembers` WHERE `projectId`=%s', (pid,))
        check('projectmembers 无残留行', int(left['n']) == 0, left)
    finally:
        db.execute('DELETE FROM `projectmembers` WHERE `projectId`=%s', (pid,))
        db.execute('DELETE FROM `projectinfos` WHERE `id`=%s', (pid,))

    gone = db.query_one('SELECT COUNT(*) AS n FROM `projectinfos` WHERE `id`=%s', (pid,))
    check('测试项目已清理', int(gone['n']) == 0, gone)


if __name__ == '__main__':
    main()
    print('\n===== test_project_member_service 结果：%d 通过 / %d 失败 =====' % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)
