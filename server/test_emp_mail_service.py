# -*- coding: utf-8 -*-
"""
员工个人邮箱助手「按员工强隔离」进程内验证（无需启动 Web 服务 / 无需登录）
--------------------------------------------------------------------------
直接 import service.EmpMailService 并连真实 MySQL，用两个真实员工的 useinfo.id
构造 _loginUserId，绕过 HTTP 直接调业务方法，重点验证：
  · 列表 / 详情 / 标记 / 删除 / 发件 / 配置 全部只作用于当前登录员工；
  · 前端伪造 empId 无效；拿别人的邮件 id 查不到、改不动、删不掉；
  · save 一人一条（重复保存是更新不是新增）；autoSync 开关生效；
  · sync_all 只挑「启用 + 自动收件」的信箱。

IMAP / SMTP 用 monkeypatch 替换成内存假实现，不连真实邮箱；所有写入的测试数据
在 finally 里按本次专用的邮箱前缀清理干净，不碰任何既有业务数据。

⚠ 选测试账号时必须排除「已配置个人信箱 / 已有个人邮件」的员工，否则 save() 会覆盖
  用户真实配置、page() 的 total 断言也会被真实邮件打乱（2026-11-06 实测踩过）。

用法：python server/test_emp_mail_service.py
"""
import datetime
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
import mail_client
import service

PASS = 0
FAIL = 0
PREFIX = 'emp-mail-probe-'          # 本次测试数据专用前缀


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, extra))


def main():
    svc = service.emp_mail_service
    # 取两个「启用 + 已绑定员工 + 没有任何真实个人邮箱数据」的账号，作为甲 / 乙。
    # 绝不能选到已经在用「我的邮箱」的员工：save() 会 UPDATE 掉人家的配置。
    users = db.query_all(
        'SELECT u.`id`,u.`empId` FROM `useinfo` u '
        'WHERE u.`enabled`=1 AND u.`empId`>0 '
        '  AND NOT EXISTS (SELECT 1 FROM `empemailbox` b WHERE b.`empId`=u.`empId`) '
        '  AND NOT EXISTS (SELECT 1 FROM `empmailmsg` m WHERE m.`empId`=u.`empId`) '
        'ORDER BY u.`id` ASC LIMIT 2')
    if len(users) < 2:
        print('需要至少 2 个已绑定员工的启用账号，当前只有 %d 个' % len(users))
        sys.exit(2)
    a, b = users[0], users[1]
    aid, bid = int(a['empId']), int(b['empId'])
    pa = {'_loginUserId': a['id']}
    pb = {'_loginUserId': b['id']}
    print('员工甲 empId=%s / 员工乙 empId=%s' % (aid, bid))

    box_a = PREFIX + 'a@example.com'
    box_b = PREFIX + 'b@example.com'
    ids = []

    # ---- 假 IMAP / SMTP：不连真实邮箱 ----
    fake_mails = [{
        'uid': 'probe-uid-1', 'messageId': '<probe-1@example.com>',
        'fromAddr': 'sender@example.com', 'fromName': '发件人',
        'toAddr': box_a, 'ccAddr': '', 'subject': '进程内验证邮件',
        'sentTime': '2026-11-06 10:00:00', 'bodyText': '正文', 'bodyHtml': '',
        'hasAttach': 0,
    }]
    orig_fetch = mail_client.fetch_inbox
    orig_send = mail_client.send_mail
    orig_query_all = service.query_all
    mail_client.fetch_inbox = lambda *args, **kwargs: list(fake_mails)
    mail_client.send_mail = lambda *args, **kwargs: None

    # sync_all() 默认会扫「全库」启用自动收件的信箱。线上已有员工真实信箱，
    # 这里必须把范围收窄到本次两个测试员工，否则会往真实员工名下写验证邮件。
    def scoped_sync_query(sql, *a, **kw):
        rows = orig_query_all(sql, *a, **kw)
        if 'empemailbox' in sql and 'autoSync' in sql:
            return [r for r in (rows or []) if int(r.get('empId') or 0) in (aid, bid)]
        return rows

    service.query_all = scoped_sync_query

    try:
        # ---------- 0. 时间格式化：收件后 status 曾报 'str' has no attribute 'strftime' ----------
        print('\n--- 0. 时间字段格式化幂等（回归） ---')
        t = datetime.datetime(2026, 11, 6, 19, 18, 49)
        check('time_text(datetime) 输出标准格式',
              service.time_text(t) == '2026-11-06 19:18:49', str(service.time_text(t)))
        check('time_text(已格式化字符串) 不抛 AttributeError',
              service.time_text('2026-11-06 19:18:49') == '2026-11-06 19:18:49')
        check('time_text(date) 不抛',
              service.time_text(datetime.date(2026, 11, 6)) == '2026-11-06 00:00:00')
        check('time_text(None / 空串) 返回空串',
              service.time_text(None) == '' and service.time_text('') == '')
        check('dump_row() 的结果再喂 time_text 幂等（正是线上 500 的场景）',
              service.time_text(db.dump_row({'t': t})['t']) == '2026-11-06 19:18:49')

        # ---------- 0b. 未配置 status：suggestEmail 取员工信息表邮箱 ----------
        print('\n--- 0b. 首次配置预填（suggestEmail） ---')
        emp_a = db.query_one('SELECT `email` FROM `empinfos` WHERE `id`=%s LIMIT 1', (aid,))
        st0 = svc.status(pa)
        check('未配置 status 带 suggestEmail（取自 empinfos.email）',
              st0.get('suggestEmail') == ((emp_a or {}).get('email') or ''),
              '%r vs %r' % (st0.get('suggestEmail'), (emp_a or {}).get('email')))
        check('未配置 status 的 email / hasPassword 仍为空（不带默认值）',
              st0.get('email') == '' and st0.get('hasPassword') is False and
              not st0.get('configured'))

        # ---------- 1. 配置：一人一条 + 密码不外泄 ----------
        print('\n--- 1. 个人信箱配置（一人一条 / 强隔离） ---')
        cfg = dict(pa, email=box_a, password='probe-secret', displayName='甲的邮箱',
                   useSsl=1, enabled=1, autoSync=1, smtpHost='', smtpPort='',
                   imapHost='', imapPort='', remark='进程内验证')
        r = svc.save(cfg)
        check('甲保存配置后 configured=True', bool(r.get('configured')), str(r)[:200])
        check('配置归属是甲（empId 取自 token，不受前端影响）', r.get('empId') == aid, str(r.get('empId')))
        check('返回体不含 password 明文', 'password' not in r or not r.get('password'), str(r)[:200])
        check('返回 hasPassword=True', bool(r.get('hasPassword')), str(r.get('hasPassword')))
        check('自动收件默认开启', bool(r.get('autoSync')), str(r.get('autoSync')))

        # 前端伪造 empId 想写进别人的名下
        forged = dict(cfg, empId=bid)
        r2 = svc.save(forged)
        check('前端伪造 empId=乙 无效（仍写甲）', r2.get('empId') == aid, str(r2.get('empId')))
        rows = db.query_all('SELECT * FROM `empemailbox` WHERE `empId` IN (%s,%s)', (aid, bid))
        check('甲只有一条配置（重复 save 是更新）',
              len([x for x in rows if int(x['empId']) == aid]) == 1, str(len(rows)))
        check('乙名下没有因为伪造参数多出配置',
              len([x for x in rows if int(x['empId']) == bid]) == 0, str(len(rows)))

        # 乙也配一个自己的
        cfgb = dict(pb, email=box_b, password='probe-secret-b', displayName='乙的邮箱',
                    useSsl=1, enabled=1, autoSync=0, smtpHost='', smtpPort='',
                    imapHost='', imapPort='', remark='进程内验证')
        rb = svc.save(cfgb)
        check('乙的配置归属是乙', rb.get('empId') == bid, str(rb.get('empId')))
        check('乙关闭自动收件生效', not rb.get('autoSync'), str(rb.get('autoSync')))

        # ---------- 2. 收件 / 列表：按 empId 隔离 ----------
        print('\n--- 2. 收件与列表隔离 ---')
        sync_a = svc.sync(pa)
        check('甲收件成功', sync_a.get('fetched') == 1 and sync_a.get('saved') == 1, str(sync_a)[:200])
        check('收件返回 empId 是甲', sync_a.get('empId') == aid, str(sync_a.get('empId')))

        # 收件会写入 lastSyncTime；紧接着的 status() / save() 都走 _box_view()，
        # 以前对 dump_row() 出来的字符串再调 .strftime() → 线上「收件报服务异常」。
        st = svc.status(pa)
        check('收件后 status() 不抛 AttributeError', bool(st.get('configured')), str(st)[:160])
        check('status().lastSyncTime 是格式化字符串',
              isinstance(st.get('lastSyncTime'), str) and len(st.get('lastSyncTime') or '') == 19,
              str(st.get('lastSyncTime')))
        check('status() 仍按 empId 隔离', st.get('empId') == aid, str(st.get('empId')))
        st2 = svc.save(dict(cfg, password=''))      # 密码留空 = 不修改，只验证保存后的 status 链路
        check('收件后再保存设置不抛 AttributeError', st2.get('empId') == aid, str(st2)[:160])
        list_a = svc.page(pa)
        list_b = svc.page(pb)
        check('甲能看到自己刚收的邮件', list_a.get('total') == 1, str(list_a.get('total')))
        check('乙看不到甲的邮件', list_b.get('total') == 0, str(list_b.get('total')))
        check('列表返回 empId 是各自本人',
              list_a.get('empId') == aid and list_b.get('empId') == bid,
              '%s/%s' % (list_a.get('empId'), list_b.get('empId')))
        mail_id = list_a['list'][0]['id']
        ids.append(mail_id)

        # 前端伪造 empId 查列表
        forged_list = svc.page(dict(pa, empId=bid))
        check('列表里伪造 empId=乙 无效', forged_list.get('empId') == aid, str(forged_list.get('empId')))

        # ---------- 3. 详情 / 标记 / 删除：越权一律无效 ----------
        print('\n--- 3. 详情 / 标记 / 删除越权防护 ---')
        d = svc.detail(dict(pa, id=mail_id, markRead=0))
        check('甲能读自己的邮件', d.get('id') == mail_id, str(d.get('id'))[:40])
        denied = False
        try:
            svc.detail(dict(pb, id=mail_id, markRead=0))
        except service.BizError as exc:
            denied = (exc.code == 404)
        check('乙读甲的邮件被拒（404 不泄露存在性）', denied)
        marked = svc.mark(dict(pb, ids=[mail_id], seen=1))
        check('乙标记甲的邮件 updated=0', marked.get('updated') == 0, str(marked))
        still_unread = db.query_one('SELECT `seen` FROM `empmailmsg` WHERE `id`=%s', (mail_id,))
        check('甲的邮件仍是未读（未被乙改动）', int(still_unread['seen']) == 0)
        deleted = svc.delete(dict(pb, ids=[mail_id]))
        check('乙删除甲的邮件 deleted=0', deleted.get('deleted') == 0, str(deleted))
        exists = db.query_one('SELECT COUNT(*) AS n FROM `empmailmsg` WHERE `id`=%s', (mail_id,))
        check('甲的邮件仍然存在', int(exists['n']) == 1)

        # ---------- 4. 发件：发件人固定取本人配置 ----------
        print('\n--- 4. 发件隔离（发件人固定取本人信箱） ---')
        sent = svc.send(dict(pa, to='to@example.com', cc='', subject='进程内验证发件',
                             body='正文内容', fromAddr='hacker@example.com'))
        ids.append(sent['id'])
        check('发件成功并入库', bool(sent.get('id')), str(sent)[:150])
        check('发件返回 counts 只统计甲', sent.get('counts', {}).get('sent') == 1,
              str(sent.get('counts')))
        sent_row = db.query_one('SELECT `empId`,`fromAddr` FROM `empmailmsg` WHERE `id`=%s',
                                (sent['id'],))
        check('发件归属是甲', int(sent_row['empId']) == aid, str(sent_row['empId']))
        check('发件人取本人配置，忽略前端伪造 fromAddr',
              sent_row['fromAddr'] == box_a, str(sent_row['fromAddr']))
        sent_b = svc.page(dict(pb, folder='sent'))
        check('乙的发件箱看不到甲发的邮件', sent_b.get('total') == 0, str(sent_b.get('total')))

        # ---------- 5. 后台自动收件只挑启用 + autoSync=1 ----------
        print('\n--- 5. 后台自动收件范围 ---')
        results = svc.sync_all()
        emails = [x.get('email') for x in results]
        check('自动收件包含甲（autoSync=1）', box_a in emails, str(emails))
        check('自动收件不包含乙（autoSync=0）', box_b not in emails, str(emails))
        check('自动收件结果带 empId 且是甲',
              all(x.get('empId') == aid for x in results), str(results)[:200])

    finally:
        mail_client.fetch_inbox = orig_fetch
        mail_client.send_mail = orig_send
        service.query_all = orig_query_all
        # 清理：只删本次两个员工名下的验证邮件 + 专用前缀的配置。
        # 一律用参数化查询（execute(sql, args)），不在 SQL 里用 % 格式化，
        # 否则 LIKE 通配符 '%' 会和 Python 的 % 占位符打架。
        try:
            db.execute('DELETE FROM `empmailmsg` WHERE `empId` IN (%s,%s) '
                       'AND (`subject` LIKE %s OR `subject` LIKE %s '
                       'OR `fromAddr` IN (%s,%s))',
                       (aid, bid, '进程内验证%', '【演示】%', box_a, box_b))
            if ids:
                holders = ','.join(['%s'] * len(ids))
                db.execute('DELETE FROM `empmailmsg` WHERE `id` IN (' + holders + ')', ids)
        except Exception as exc:
            print('清理邮件失败（请手工检查）：%s' % exc)
        try:
            db.execute('DELETE FROM `empemailbox` WHERE `email` LIKE %s', (PREFIX + '%',))
        except Exception as exc:
            print('清理配置失败（请手工检查）：%s' % exc)

    print('\n结果：通过 %d 项，失败 %d 项' % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
