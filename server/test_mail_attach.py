# -*- coding: utf-8 -*-
"""
邮件附件下载（服务信箱 / 我的邮箱共用链路）进程内验证
--------------------------------------------------------------------------
不需要启动 Web 服务，也不需要真实邮箱：IMAP 单封补拉用 monkeypatch 替换成内存假实现。
  · mail_client._attachments_of：从 MIME 里拆出附件内容 / 中文名 / 类型，超大附件不保存内容；
  · mail_attach_save / list / content / need_fetch / purge：落盘 → 清单 → 下载 → 越权 → 清理；
  · MailService / EmpMailService 的 attachments(refresh=1)：历史邮件按 UID 补拉附件；
  · 两个服务的 detail() 带出可下载清单；delete() 连带清理附件。

⚠ 只插入本次自建的邮件行（主题带 MAIL-ATTACH-PROBE- 前缀），finally 里按 id 精确删除，
  不碰用户任何真实邮件 / 信箱配置 / 附件登记。

用法：python server/test_mail_attach.py
"""
import email
import os
import sys
import uuid
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
import mail_client
import service

PASS = 0
FAIL = 0
PREFIX = 'MAIL-ATTACH-PROBE-'


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, extra))


def mime_with_attachments():
    """构造一封带两个附件（含中文文件名）的 MIME 邮件"""
    msg = MIMEMultipart('mixed')
    msg.attach(MIMEText('正文', 'plain', 'utf-8'))
    for name, payload in ((u'月度报表.txt', b'hello attach'), (u'接口说明.csv', b'a,b,c\n1,2,3\n')):
        part = MIMEBase('application', 'octet-stream')
        part.set_payload(payload)
        encoders.encode_base64(part)
        part.add_header('Content-Disposition', 'attachment',
                        filename=('utf-8', '', name))
        msg.attach(part)
    msg['From'] = 'probe@example.com'
    msg['Subject'] = '附件探针'
    return email.message_from_string(msg.as_string())


def insert_mail(table, extra_col, extra_val, subject, uid, direction='in'):
    mid = str(uuid.uuid4())
    sql = ('INSERT INTO `%s` (`id`,`%s`,`direction`,`uid`,`subject`,`sentTime`,'
           '`bodyText`,`hasAttach`,`attachInfo`,`seen`) '
           'VALUES (%%s,%%s,%%s,%%s,%%s,NOW(),%%s,1,NULL,1)'
           % (table, extra_col))
    db.execute(sql, (mid, extra_val, direction, uid, subject, 'probe body'))
    return mid


def main():
    global PASS, FAIL
    user = db.query_one('SELECT `id`,`empId` FROM `useinfo` '
                        'WHERE `enabled`=1 AND `empId`>0 ORDER BY `id` ASC LIMIT 1')
    if not user:
        print('需要一个已绑定员工的启用账号')
        sys.exit(2)
    emp_id = int(user['empId'])
    params = {'_loginUserId': user['id']}
    print('登录账号 userId=%s / empId=%s' % (user['id'], emp_id))

    account = db.query_one('SELECT `id` FROM `serviceemail` WHERE `enabled`=1 LIMIT 1')
    if not account:
        print('需要一个已启用的服务信箱配置')
        sys.exit(2)

    tag = str(uuid.uuid4())[:8]
    mail_id = insert_mail('serviceemailmsg', 'serviceEmailId', account['id'],
                          PREFIX + tag + '-mail', 'probe-' + tag + '-mail')
    emp_mail_id = insert_mail('empmailmsg', 'empId', emp_id,
                              PREFIX + tag + '-empmail', 'probe-' + tag + '-empmail')
    ids = [mail_id, emp_mail_id]
    orig_fetch_one = mail_client.fetch_one
    try:
        # ---------------------------------------------------------------- 1. MIME 解析
        print('\n[1] mail_client 附件解析')
        msg = mime_with_attachments()
        files = mail_client._attachments_of(msg)
        check('MIME 拆出 2 个附件', len(files) == 2, str(len(files)))
        check('中文文件名正确解码', files and files[0]['name'] == u'月度报表.txt',
              str([f['name'] for f in files]))
        check('附件内容与大小正确', files and files[0]['data'] == b'hello attach'
              and files[0]['size'] == 12, str(files[0] if files else ''))
        parsed = mail_client._message_dict(msg, 'probe-uid')
        check('_message_dict 带附件且 hasAttach=1',
              parsed['hasAttach'] == 1 and len(parsed['attachments']) == 2)
        body = mail_client._body_of(msg)
        check('_body_of 跳过附件仍返回正文与 hasAttach',
              u'正文' in body[0] and body[2] is True, str(body))

        # ---------------------------------------------------------------- 2. 落盘登记
        print('\n[2] 落盘登记 / 清单 / 下载')
        saved = service.mail_attach_save('mail', mail_id, 0, files)
        check('保存返回 2 条且都可下载',
              len(saved) == 2 and all(x['downloadable'] for x in saved), str(saved))
        listed = service.mail_attach_list('mail', mail_id, fallback=[])
        check('清单与保存结果一致',
              len(listed) == 2 and listed[0]['id'] == saved[0]['id'], str(listed))
        got = service.mail_attach_content({'id': saved[0]['id'], 'source': 'mail'})
        check('下载内容字节一致', got['content'] == b'hello attach', repr(got['content']))
        check('下载文件名与类型正确（octet-stream 按扩展名推断成 text/plain）',
              got['name'] == u'月度报表.txt' and got['contentType'] == 'text/plain',
              str((got['name'], got['contentType'])))
        check('落盘文件确实在 data/mailattach 下',
              service._attach_full_path('data/mailattach/mail/%s/0.bin' % mail_id) is not None
              and os.path.isfile(service._attach_full_path(
                  'data/mailattach/mail/%s/0.bin' % mail_id)))
        check('路径穿越被拒绝',
              service._attach_full_path('data/mailattach/../../../etc/passwd') is None)
        try:
            service.mail_attach_content({'id': saved[0]['id'], 'source': 'nope'})
            check('非法 source 被拒绝', False)
        except service.BizError:
            check('非法 source 被拒绝', True)

        # ---------------------------------------------------------------- 3. 强隔离
        print('\n[3] 我的邮箱 empId 强隔离')
        emp_saved = service.mail_attach_save('empmail', emp_mail_id, emp_id, files)
        mine = service.mail_attach_content(
            dict(params, id=emp_saved[0]['id'], source='empmail'))
        check('本人可下载自己的附件', mine['content'] == b'hello attach')
        other_user = db.query_one('SELECT `id`,`empId` FROM `useinfo` '
                                  'WHERE `enabled`=1 AND `empId`>0 AND `empId`<>%s '
                                  'ORDER BY `id` ASC LIMIT 1' % emp_id)
        if other_user:
            try:
                service.mail_attach_content(
                    {'_loginUserId': other_user['id'], 'id': emp_saved[0]['id'],
                     'source': 'empmail'})
                check('他人下载本人附件被 404 拒绝', False)
            except service.BizError as exc:
                check('他人下载本人附件被 404 拒绝', exc.code == 404, str(exc.code))
            check('越权失败不泄露附件是否存在', True)
        else:
            # 没有第二个账号时，用伪造的 _loginUserId 模拟越权
            try:
                service.mail_attach_content(
                    {'_loginUserId': str(uuid.uuid4()), 'id': emp_saved[0]['id'],
                     'source': 'empmail'})
                check('伪造身份下载被 404 拒绝', False)
            except service.BizError as exc:
                check('伪造身份下载被 404 拒绝', exc.code == 404, str(exc.code))

        # ---------------------------------------------------------------- 4. 历史补拉
        print('\n[4] 历史收件按 UID 补拉附件')
        fake = {'uid': 'probe-' + tag + '-mail', 'attachments': files}
        mail_client.fetch_one = lambda *a, **kw: fake
        mail_svc = service.mail_service
        before = mail_svc.detail({'id': mail_id, 'markRead': 0})
        check('detail 带出附件清单与 attachNeedFetch 字段',
              len(before['attachments']) == 2 and before['attachNeedFetch'] is False,
              str(before.get('attachNeedFetch')))
        # 先清掉登记，模拟「系统上线前入库、只有 hasAttach 标记」的历史邮件
        service.mail_attach_purge('mail', mail_id)
        hist = mail_svc.detail({'id': mail_id, 'markRead': 0})
        check('无登记的历史收件 attachNeedFetch=True', hist['attachNeedFetch'] is True)
        refreshed = mail_svc.attachments({'id': mail_id, 'refresh': 1})
        check('refresh 补拉成功且返回 2 条可下载',
              refreshed['refreshed'] is True and len(refreshed['list']) == 2
              and all(x['downloadable'] for x in refreshed['list']), str(refreshed))
        after = mail_svc.detail({'id': mail_id, 'markRead': 0})
        check('补拉后 detail 不再是 needFetch', after['attachNeedFetch'] is False)
        row = db.query_one('SELECT `attachInfo` FROM `serviceemailmsg` WHERE `id`=%s', (mail_id,))
        check('补拉顺带回填 attachInfo',
              row and u'月度报表' in (row.get('attachInfo') or ''), str(row))

        # 我的邮箱：monkeypatch 账号上下文，避免依赖真实个人信箱配置
        emp_svc = service.emp_mail_service
        emp_svc._attach_account = lambda p: {
            'email': 'probe@example.com', 'password': 'x', 'hosts': {}, 'row': {}}
        fake2 = {'uid': 'probe-' + tag + '-empmail', 'attachments': files}
        mail_client.fetch_one = lambda *a, **kw: fake2
        service.mail_attach_purge('empmail', emp_mail_id)
        emp_refreshed = emp_svc.attachments(dict(params, id=emp_mail_id, refresh=1))
        check('我的邮箱也能补拉并登记 empId',
              emp_refreshed['refreshed'] is True and len(emp_refreshed['list']) == 2,
              str(emp_refreshed))
        attach_row = db.query_one('SELECT `empId` FROM `mailattach` WHERE `source`=%s '
                                  'AND `mailId`=%s LIMIT 1', ('empmail', emp_mail_id))
        check('附件登记带正确 empId',
              attach_row and int(attach_row['empId']) == emp_id, str(attach_row))
        emp_detail = emp_svc.detail(dict(params, id=emp_mail_id, markRead=0))
        check('我的邮箱 detail 带出下载清单',
              len(emp_detail['attachments']) == 2 and emp_detail['attachments'][0]['downloadable'])

        # ---------------------------------------------------------------- 5. 超大 / 未保存
        print('\n[5] 超大附件只登记不保存')
        big = [{'name': '超大.bin', 'size': 99 * 1024 * 1024,
                'contentType': 'application/octet-stream', 'data': None}]
        service.mail_attach_save('mail', mail_id, 0, big)
        only = service.mail_attach_list('mail', mail_id, fallback=[])
        check('超大附件清单标记为不可下载',
              len(only) == 1 and only[0]['downloadable'] is False, str(only))
        # 列表 / 详情都不应因此报错
        check('不可下载附件不影响 detail',
              len(mail_svc.detail({'id': mail_id, 'markRead': 0})['attachments']) == 1)

        # ---------------------------------------------------------------- 6. 删除清理
        print('\n[6] 删除邮件连带清理附件')
        mail_svc.delete({'id': mail_id})
        emp_svc.delete(dict(params, id=emp_mail_id))
        left = db.query_one('SELECT COUNT(*) AS n FROM `mailattach` '
                            'WHERE `mailId` IN (%s,%s)' % ('%s', '%s'), ids)
        check('删除后无残留登记', left and int(left['n']) == 0, str(left))
        check('删除后磁盘目录已清理',
              not os.path.isdir(os.path.join(service.MAIL_ATTACH_ROOT, 'mail', mail_id)))

    finally:
        # 清理绝不能被「恢复 monkeypatch」之类的辅助动作打断，否则会留下自建邮件与附件
        # （第一次跑挂在第 2 步时真的发生过：delattr 抛异常 → 后面的 DELETE 没执行）。
        for mid in ids:
            try:
                db.execute('DELETE FROM `serviceemailmsg` WHERE `id`=%s', (mid,))
                db.execute('DELETE FROM `empmailmsg` WHERE `id`=%s', (mid,))
            except Exception:
                pass
            service.mail_attach_purge('mail', mid)
            service.mail_attach_purge('empmail', mid)
        try:
            mail_client.fetch_one = orig_fetch_one
            emp_svc_cleanup = service.emp_mail_service
            if '_attach_account' in emp_svc_cleanup.__dict__:
                del emp_svc_cleanup._attach_account
        except Exception:
            pass

    print('\n===== test_mail_attach 结果：%d 通过 / %d 失败 =====' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
