# -*- coding: utf-8 -*-
"""
邮箱认证失败提示 / 密码归一化 / 服务商识别（纯函数，不联网、不连库）
---------------------------------------------------------------------
覆盖：
  1) 密码首尾的空白、全角空格、BOM、零宽字符被裁掉，中间字符不动；
  2) 阿里企业邮箱（自定义域名 + imap.qiye.aliyun.com）给的是「客户端专用密码」指引，
     并且保留服务器原文 "LOGIN failed."；
  3) 163 / QQ / 腾讯企业邮 / 未知企业域名各自给出可执行的排查顺序；
  4) 手工填 IMAP 主机时服务商名称按主机名识别（不再是「自定义域名」）；
  5) 空密码不发网络请求，直接给明确提示。

运行：python server/test_mail_login_hint.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mail_client

PASS = 0
FAIL = 0


def check(name, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  ok   %s' % name)
    else:
        FAIL += 1
        print('  FAIL %s %s' % (name, ('| ' + str(detail)) if detail else ''))


ALI_HOSTS = {'imapHost': 'imap.qiye.aliyun.com', 'imapPort': 993,
             'smtpHost': 'smtp.qiye.aliyun.com', 'smtpPort': 465, 'useSsl': 1}

print('\n--- 1. 密码归一化 ---')
check('裁掉尾随空格', mail_client._clean_password('abc123  ') == 'abc123',
      repr(mail_client._clean_password('abc123  ')))
check('裁掉首部全角空格', mail_client._clean_password('\u3000abc123') == 'abc123',
      repr(mail_client._clean_password('\u3000abc123')))
check('裁掉 BOM / 零宽', mail_client._clean_password('\ufeffab\u200bc\u200d') == 'abc',
      repr(mail_client._clean_password('\ufeffab\u200bc\u200d')))
check('中间字符不动', mail_client._clean_password(' a b-c@1 ') == 'a b-c@1',
      repr(mail_client._clean_password(' a b-c@1 ')))
check('None / 空串安全', mail_client._clean_password(None) == '' and
      mail_client._clean_password('') == '')

print('\n--- 2. 阿里企业邮箱提示 ---')
err = mail_client._login_error('boss@szyc-data.com', Exception("b'LOGIN failed.'"), '收件邮箱', ALI_HOSTS)
print('    ' + err)
check('提到三方客户端安全密码', '客户端安全密码' in err, err)
check('提到管理员开启 IMAP', 'IMAP' in err and '管理员' in err, err)
check('保留服务器原文', 'LOGIN failed.' in err, err)
check('收件 / 发件标签正确',
      err.startswith('收件邮箱登录失败') and
      mail_client._login_error('a@b.com', Exception('x'), '发件邮箱', ALI_HOSTS).startswith('发件邮箱登录失败'))
check('提示长度 ≤ 200 字（lastError 只有 255 字节）', len(err) <= 200, len(err))

print('\n--- 3. 其它服务商 ---')
h163 = mail_client.auth_hint('u@163.com', {'imapHost': 'imap.163.com'})
check('163 → 授权码', '授权码' in h163, h163)
hqq = mail_client.auth_hint('u@qq.com', {'imapHost': 'imap.qq.com'})
check('QQ → 授权码', '授权码' in hqq, hqq)
htx = mail_client.auth_hint('u@corp.com', {'imapHost': 'imap.exmail.qq.com'})
check('腾讯企业邮 → 客户端专用密码', '客户端专用密码' in htx, htx)
h163q = mail_client.auth_hint('u@corp.com', {'imapHost': 'imap.qiye.163.com'})
check('网易企业邮 → 授权密码', '授权密码' in h163q, h163q)
hunk = mail_client.auth_hint('u@corp.com', {'imapHost': 'mail.corp.com'})
check('未知企业邮不给错的服务商指引', hunk == '', hunk)
eunk = mail_client._login_error('u@corp.com', Exception("b'LOGIN failed.'"), '收件邮箱',
                                {'imapHost': 'mail.corp.com'})
check('未知域名给通用排查顺序', '服务器没有说明原因' in eunk and '①' in eunk, eunk)

print('\n--- 4. 服务商识别（手工填 host） ---')
srv = mail_client.servers_of(dict(ALI_HOSTS, email='boss@szyc-data.com'))
check('阿里企业邮箱', srv['provider'] == '阿里企业邮箱', srv['provider'])
check('端口 / SSL 原样保留', srv['imapPort'] == 993 and srv['smtpPort'] == 465 and srv['useSsl'] == 1,
      str(srv))
srv2 = mail_client.servers_of({'email': 'u@163.com'})
check('按域名推断仍是网易 163', srv2['provider'] == '网易 163' and srv2['imapHost'] == 'imap.163.com',
      str(srv2))
srv3 = mail_client.servers_of({'email': 'u@corp.com'})
check('自定义域名仍叫自定义域名', srv3['provider'] == '自定义域名', srv3['provider'])

print('\n--- 5. 空密码不发请求 ---')
try:
    mail_client._imap_connect(mail_client.servers_of(dict(ALI_HOSTS, email='boss@szyc-data.com')),
                              'boss@szyc-data.com', '  \u3000 ')
    check('空密码应抛 MailError', False)
except mail_client.MailError as exc:
    check('空密码应抛 MailError 且提示明确', '密码 / 授权码为空' in exc.message, exc.message)
except Exception as exc:
    check('空密码应抛 MailError（而不是别的异常）', False, repr(exc))

try:
    mail_client.send_mail('boss@szyc-data.com', 'x', ALI_HOSTS, [], '主题', '正文')
    check('无收件人应抛 MailError', False)
except mail_client.MailError as exc:
    check('无收件人应抛 MailError', '收件人' in exc.message, exc.message)

print('\n结果：%d 通过 / %d 失败' % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
