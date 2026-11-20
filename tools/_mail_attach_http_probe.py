# -*- coding: utf-8 -*-
"""
邮件附件下载真实 HTTP 冒烟探针（8808 同源）
--------------------------------------------------------------------------
用数据库里**已有的 token**（只读，绝不重新登录，避免顶掉用户在线会话），
在真库里插入本次专用的邮件行与附件登记，验证：
  · 无 token → 401；有效 token → 附件清单接口正常；
  · /api/mailattach/download 返回二进制字节 + 中文 Content-Disposition；
  · 我的邮箱附件按 empId 强隔离（别人的 token 下载 404）；
  · 清理后无残留。

用法：MAIL_TOKEN=<token> MAIL_OTHER_TOKEN=<另一个员工的token> python tools/_mail_attach_http_probe.py
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'server'))
import db                                    # noqa: E402
import service                               # noqa: E402

BASE = os.getenv('MAIL_BASE', 'http://127.0.0.1:8808')
TOKEN = os.getenv('MAIL_TOKEN', '')
OTHER_TOKEN = os.getenv('MAIL_OTHER_TOKEN', '')
PASS = 0
FAIL = 0


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, extra))


def call(path, token=None, method='GET', data=None, binary=False):
    url = BASE + path
    if token:
        url += ('&' if '?' in path else '?') + 'token=' + urllib.parse.quote(token)
    body = None
    headers = {'Content-Type': 'application/json;charset=UTF-8'}
    if data is not None:
        body = json.dumps(data).encode('utf-8') if method == 'POST' else None
        if method == 'GET':
            url += '&' + urllib.parse.urlencode(data)
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            ctype = resp.headers.get('Content-Type', '')
            if binary and 'json' not in ctype:
                return resp.status, raw, dict(resp.headers)
            return resp.status, json.loads(raw.decode('utf-8', 'ignore')), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw.decode('utf-8', 'ignore')), dict(exc.headers)
        except ValueError:
            return exc.code, raw, dict(exc.headers)


def main():
    global PASS, FAIL
    if not TOKEN:
        print('请设置 MAIL_TOKEN（数据库 useinfo.token 里已有的有效令牌）')
        return 2
    me = db.query_one('SELECT `empId` FROM `useinfo` WHERE `token`=%s', (TOKEN,))
    if not me:
        print('MAIL_TOKEN 在库里找不到')
        return 2
    emp_id = int(me['empId'])
    acc = db.query_one('SELECT `id` FROM `serviceemail` WHERE `enabled`=1 LIMIT 1')
    tag = str(uuid.uuid4())[:8]
    subject = 'MAIL-ATTACH-HTTP-PROBE-' + tag
    mail_id, emp_mail_id = str(uuid.uuid4()), str(uuid.uuid4())
    files = [
        {'name': u'探针附件.txt', 'size': 12, 'contentType': 'text/plain', 'data': b'hello attach'},
        {'name': u'只读清单.bin', 'size': 99 * 1024 * 1024,
         'contentType': 'application/octet-stream', 'data': None},
    ]
    try:
        for table, owner_col, owner_val, mid, uid in (
                ('serviceemailmsg', 'serviceEmailId', acc['id'] if acc else '', mail_id, 'p-' + tag + '-m'),
                ('empmailmsg', 'empId', emp_id, emp_mail_id, 'p-' + tag + '-e')):
            db.execute('INSERT INTO `%s` (`id`,`%s`,`direction`,`uid`,`subject`,`sentTime`,'
                       '`bodyText`,`hasAttach`,`attachInfo`,`seen`) '
                       'VALUES (%%s,%%s,\'in\',%%s,%%s,NOW(),%%s,1,NULL,1)'
                       % (table, owner_col),
                       (mid, owner_val, uid, subject, 'probe body'))
        saved_mail = service.mail_attach_save('mail', mail_id, 0, files)
        saved_emp = service.mail_attach_save('empmail', emp_mail_id, emp_id, files)

        # ---- 1. 鉴权 ----
        status, body, _ = call('/api/mail/attachments?id=' + mail_id)
        check('无 token 访问附件清单返回 401',
              status == 200 and body.get('code') == 401, str((status, body)))

        # ---- 2. 清单接口 ----
        status, body, _ = call('/api/mail/attachments?id=' + mail_id, TOKEN)
        check('服务信箱附件清单返回 2 条',
              status == 200 and body.get('code') == 0 and
              len(body['data']['list']) == 2, str(body)[:200])
        check('清单里第一条可下载、第二条标未保存',
              body.get('data', {}).get('list', [{}])[0].get('downloadable') is True and
              body['data']['list'][1].get('downloadable') is False,
              str(body.get('data', {}).get('list'))[:200])
        check('已有登记的邮件不再提示需要补拉',
              body.get('data', {}).get('needFetch') is False,
              str(body.get('data', {}).get('needFetch')))
        status, body2, _ = call('/api/empmail/attachments?id=' + emp_mail_id, TOKEN)
        check('我的邮箱附件清单返回 2 条',
              status == 200 and body2.get('code') == 0 and
              len(body2['data']['list']) == 2, str(body2)[:200])

        # ---- 3. 二进制下载 ----
        status, raw, headers = call('/api/mailattach/download?source=mail&id=' + saved_mail[0]['id'],
                                    TOKEN, binary=True)
        check('服务信箱附件下载返回正确字节', status == 200 and raw == b'hello attach',
              str((status, raw[:40])))
        check('下载响应带中文文件名与附件类型',
              'attachment' in headers.get('Content-Disposition', '') and
              'text/plain' in headers.get('Content-Type', ''),
              str((headers.get('Content-Disposition'), headers.get('Content-Type'))))
        status, raw2, _ = call('/api/mailattach/download?source=empmail&id=' + saved_emp[0]['id'],
                               TOKEN, binary=True)
        check('我的邮箱附件本人可下载', status == 200 and raw2 == b'hello attach',
              str((status, raw2[:40])))

        # ---- 4. 越权 / 未保存 ----
        if OTHER_TOKEN:
            other = db.query_one('SELECT `empId` FROM `useinfo` WHERE `token`=%s',
                                 (OTHER_TOKEN,))
            if other and int(other['empId']) != emp_id:
                status, body3, _ = call(
                    '/api/mailattach/download?source=empmail&id=' + saved_emp[0]['id'],
                    OTHER_TOKEN, binary=True)
                check('他人 token 下载我的邮箱附件被 404',
                      isinstance(body3, dict) and body3.get('code') == 404,
                      str(body3)[:160])
        status, body4, _ = call('/api/mailattach/download?source=mail&id=' + saved_mail[1]['id'],
                                TOKEN, binary=True)
        check('未保存内容的附件下载给出 404 提示',
              isinstance(body4, dict) and body4.get('code') == 404, str(body4)[:160])
        status, body5, _ = call('/api/mailattach/download?source=mail&id=' + str(uuid.uuid4()),
                                TOKEN, binary=True)
        check('不存在的附件 id 返回 404',
              isinstance(body5, dict) and body5.get('code') == 404, str(body5)[:160])

        # ---- 5. detail 接口带清单 ----
        status, detail, _ = call('/api/mail/detail?id=' + mail_id, TOKEN)
        check('读信详情带出可下载附件清单',
              status == 200 and detail.get('code') == 0 and
              len(detail['data'].get('attachments') or []) == 2 and
              detail['data']['attachments'][0].get('downloadable') is True,
              str(detail.get('data', {}).get('attachments'))[:200])
        status, emp_detail, _ = call('/api/empmail/detail?id=' + emp_mail_id, TOKEN)
        check('我的邮箱读信详情带出清单',
              status == 200 and emp_detail.get('code') == 0 and
              len(emp_detail['data'].get('attachments') or []) == 2,
              str(emp_detail.get('data', {}).get('attachments'))[:200])
    finally:
        for mid in (mail_id, emp_mail_id):
            for table in ('serviceemailmsg', 'empmailmsg'):
                try:
                    db.execute('DELETE FROM `%s` WHERE `id`=%%s' % table, (mid,))
                except Exception:
                    pass
            service.mail_attach_purge('mail', mid)
            service.mail_attach_purge('empmail', mid)
        left = db.query_one('SELECT COUNT(*) AS n FROM `mailattach` WHERE `mailId` IN (%s,%s)'
                            % ('%s', '%s'), (mail_id, emp_mail_id))
        print('清理后残留附件登记：%s' % (left['n'] if left else '?'))
        print('清理后残留邮件行：%s' % db.query_one(
            'SELECT COUNT(*) AS n FROM `serviceemailmsg` WHERE `subject`=%s', (subject,))['n'])

    print('\n===== mail_attach_http_probe 结果：%d 通过 / %d 失败 =====' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
