# -*- coding: utf-8 -*-
"""
mail-probe.py —— 邮箱客户端配置自检（只用标准库，不连数据库、不依赖项目代码）
---------------------------------------------------------------------
为什么需要它：阿里 / 腾讯 / 网易的**企业邮箱**在认证失败时往往只回一句
    LOGIN failed.
既不说原因，也不区分「密码不对 / 用了网页密码 / IMAP 被管理员关了 / 账号被限制」。
这个脚本把 IMAP / SMTP 的原始对话完整打出来，能直接看出卡在哪一步：

  · 连不上        -> 网络 / 端口 / SSL（服务器地址或防火墙问题）
  · greeting 之后 LOGIN NO  -> 账号或密码 / 授权码不对，或没开客户端登录
  · LOGIN OK 但 SELECT NO   -> 登录成功但没有 IMAP 权限（管理员关掉了 IMAP），或邮箱未初始化
  · SMTP 535       -> 发件侧授权失败（通常是同一份密码 / 授权码的问题）

用法（在装好本系统的机器上，用自带的 python 跑）：
    runtime\\python\\python.exe mail-probe.py --email me@corp.com --password 授权码
    runtime\\python\\python.exe mail-probe.py --email me@corp.com --password 授权码 \\
        --imap imap.qiye.aliyun.com --smtp smtp.qiye.aliyun.com
    # 只测收件 / 只测发件
    ... --no-smtp      /      ... --no-imap
    # 怀疑账号名不该带域名时，追加试一次「@ 前面那截」
    ... --try-short-user
"""
from __future__ import print_function

import argparse
import imaplib
import smtplib
import socket
import ssl
import sys

IMAP_TIMEOUT = 15
SMTP_TIMEOUT = 15
KNOWN = (
    ('imap.qiye.aliyun.com', '阿里企业邮箱'),
    ('imap.aliyun.com', '阿里邮箱'),
    ('imap.exmail.qq.com', '腾讯企业邮'),
    ('imap.qiye.163.com', '网易企业邮'),
    ('imap.163.com', '网易 163'),
    ('imap.qq.com', 'QQ 邮箱'),
    ('imap.263.net', '263 企业邮箱'),
    ('outlook.office365.com', 'Outlook'),
    ('imap.gmail.com', 'Gmail'),
)

ADVICE = {
    '阿里企业邮箱': [
        '第三方客户端只能用「三方客户端安全密码」，网页登录密码无效',
        '网页版 -> 设置 -> 查看更多设置 -> 账户与安全 -> 账户安全 -> 三方客户端登录安全管理 -> 生成新密码（16 位，只显示一次）',
        '管理员需已开启「第三方客户端登录」，并给该账号开启 POP3/IMAP/SMTP 服务；账号要填完整邮箱地址',
    ],
    '阿里邮箱': [
        '密码栏要填「三方客户端安全密码 / 独立密码」，不是网页登录密码',
        '网页版 -> 设置 里确认已开启 IMAP / SMTP 服务',
    ],
    '腾讯企业邮': [
        '密码栏要填「客户端专用密码」：网页版 -> 设置 -> 客户端设置 -> 生成专用密码',
        '管理员需在管理后台确认已允许 IMAP / SMTP 服务',
    ],
    '网易企业邮': [
        '密码栏要填「客户端授权密码」：网页版 -> 设置 -> 客户端授权密码 -> 新增',
        '确认已开启 IMAP / SMTP 服务',
    ],
    '网易 163': [
        '必须用 16 位「客户端授权码」，不是登录密码：网页版 -> 设置 -> POP3/SMTP/IMAP -> 开启并新增授权码',
    ],
    'QQ 邮箱': [
        '必须用「授权码」：QQ 邮箱网页版 -> 设置 -> 账号 -> POP3/IMAP 服务 -> 开启并生成授权码',
    ],
}


def label_of(host):
    text = (host or '').strip().lower()
    for known, name in KNOWN:
        if text == known:
            return name
    return '自定义域名'


def guess_hosts(email, imap_host, imap_port, smtp_host, smtp_port):
    domain = email.split('@')[-1].lower() if '@' in email else ''
    if not imap_host:
        imap_host = 'imap.' + domain if domain else ''
    if not smtp_host:
        smtp_host = 'smtp.' + domain if domain else ''
    return imap_host, imap_port, smtp_host, smtp_port


def mask(secret):
    text = secret or ''
    if len(text) <= 4:
        return '*' * len(text)
    return text[:2] + '*' * (len(text) - 4) + text[-2:]


def probe_imap(email, password, host, port, use_ssl, try_short_user):
    print('\n===== IMAP %s:%s (SSL=%s) =====' % (host, port, 'on' if use_ssl else 'off'))
    if not host:
        print('  [ERR] 没有 IMAP 服务器地址')
        return False
    try:
        if use_ssl:
            conn = imaplib.IMAP4_SSL(host, int(port), timeout=IMAP_TIMEOUT)
        else:
            conn = imaplib.IMAP4(host, int(port), timeout=IMAP_TIMEOUT)
    except (socket.error, ssl.SSLError, OSError) as exc:
        print('  [ERR] 连接失败：%s' % exc)
        print('        排查：地址 / 端口是否写对；公司网络是否放行 %s；是否需要 SSL' % port)
        return False
    except imaplib.IMAP4.error as exc:
        print('  [ERR] 服务器握手失败：%s' % exc)
        return False
    print('  已连接，服务器问候：%s' % (conn.welcome or b'').decode('utf-8', 'replace'))

    ok = False
    try:
        print('  CAPABILITY：%s' % (conn.capability()[1] or ''))
    except Exception as exc:
        print('  CAPABILITY 读取失败（不影响判断）：%s' % exc)

    users = [email]
    if try_short_user and '@' in email:
        users.append(email.split('@')[0])
    for user in users:
        try:
            conn.login(user, password)
            print('  LOGIN 成功（用户名：%s）' % user)
            ok = True
            break
        except imaplib.IMAP4.abort as exc:
            print('  LOGIN 中断（连接被服务器关闭）：%s' % exc)
            break
        except imaplib.IMAP4.error as exc:
            print('  LOGIN 失败（用户名：%s）：%s' % (user, exc))
            continue
    if not ok:
        try:
            conn.logout()
        except Exception:
            pass
        return False

    # 登录成功不代表能用：管理员可能只放开了认证没放开 IMAP
    for box in ('INBOX',):
        try:
            typ, data = conn.select(box, readonly=True)
            print('  SELECT %s：%s %s' % (box, typ, data))
            if typ != 'OK':
                print('  -> 登录成功但打不开收件箱：多半是邮箱后台没有开启 IMAP 服务（需管理员开启），'
                      '或账号首次使用尚未初始化')
        except Exception as exc:
            print('  SELECT %s 异常：%s' % (box, exc))
    try:
        typ, data = conn.list()
        boxes = len((data or [])[0].split(b'\r\n')) if data and data[0] else 0
        print('  LIST：%s，邮箱文件夹 %d 个' % (typ, boxes))
    except Exception as exc:
        print('  LIST 失败：%s' % exc)
    try:
        conn.logout()
    except Exception:
        pass
    return True


def probe_smtp(email, password, host, port, use_ssl):
    print('\n===== SMTP %s:%s (SSL=%s) =====' % (host, port, 'on' if use_ssl else 'off'))
    if not host:
        print('  [ERR] 没有 SMTP 服务器地址')
        return False
    try:
        if use_ssl:
            client = smtplib.SMTP_SSL(host, int(port), timeout=SMTP_TIMEOUT)
            client.ehlo()
        else:
            client = smtplib.SMTP(host, int(port), timeout=SMTP_TIMEOUT)
            client.ehlo()
            if client.has_extn('starttls'):
                client.starttls()
                client.ehlo()
    except (socket.error, ssl.SSLError, smtplib.SMTPException) as exc:
        print('  [ERR] 连接失败：%s' % exc)
        return False
    print('  已连接，服务器问候：%s' % (client.ehlo_resp or b'').decode('utf-8', 'replace')[:200])
    ok = False
    try:
        code, resp = client.login(email, password)
        print('  AUTH 成功：%s %s' % (code, resp))
        ok = True
    except smtplib.SMTPAuthenticationError as exc:
        code, resp = exc.smtp_code, exc.smtp_error
        print('  AUTH 失败：%s %s' % (code, resp.decode('utf-8', 'replace') if isinstance(resp, bytes) else resp))
        print('  -> 发件侧和收件侧用的是同一份密码 / 授权码，收件失败的话这里也一定失败')
    except smtplib.SMTPException as exc:
        print('  AUTH 异常：%s' % exc)
    finally:
        try:
            client.quit()
        except Exception:
            pass
    return ok


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--email', required=True, help='完整邮箱地址')
    ap.add_argument('--password', required=True, help='密码 / 授权码 / 客户端专用密码')
    ap.add_argument('--imap', default='', help='IMAP 服务器，留空按域名猜 imap.<域名>')
    ap.add_argument('--imap-port', default=993, type=int)
    ap.add_argument('--smtp', default='', help='SMTP 服务器，留空按域名猜 smtp.<域名>')
    ap.add_argument('--smtp-port', default=465, type=int)
    ap.add_argument('--no-ssl', action='store_true', help='不用 SSL（走 143 / 25 + STARTTLS）')
    ap.add_argument('--no-imap', action='store_true', help='跳过收件侧')
    ap.add_argument('--no-smtp', action='store_true', help='跳过发件侧')
    ap.add_argument('--try-short-user', action='store_true', help='登录失败时再试一次「@ 前面那截」当用户名')
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(errors='replace')       # 老控制台遇到个别字符别整个崩掉
    except Exception:
        pass

    email = args.email.strip()
    imap_host, imap_port, smtp_host, smtp_port = guess_hosts(
        email, args.imap.strip(), args.imap_port, args.smtp.strip(), args.smtp_port)
    use_ssl = not args.no_ssl
    name = label_of(imap_host or smtp_host)

    print('邮箱：%s' % email)
    print('密码：%s（长度 %d）' % (mask(args.password), len(args.password)))
    print('服务商：%s' % name)
    print('收件：%s:%s   发件：%s:%s' % (imap_host, imap_port, smtp_host, smtp_port))
    if args.password != args.password.strip() or any(c in args.password for c in '\u3000\ufeff\u200b'):
        print('注意：这个密码的首尾有空白或不可见字符，系统会自动去掉；'
              '但如果中间夹了空格，请重新复制一遍')

    imap_ok = True
    smtp_ok = True
    if not args.no_imap:
        imap_ok = probe_imap(email, args.password.strip(), imap_host, imap_port, use_ssl, args.try_short_user)
    if not args.no_smtp:
        smtp_ok = probe_smtp(email, args.password.strip(), smtp_host, smtp_port, use_ssl)

    print('\n===== 结论 =====')
    print('收件（IMAP）：%s' % ('成功' if imap_ok else '失败'))
    print('发件（SMTP）：%s' % ('成功' if smtp_ok else '失败'))
    if imap_ok and smtp_ok:
        print('两侧都通，可以把这份配置填进系统了。')
        return 0
    tips = ADVICE.get(name) or [
        '账号要填完整邮箱地址（含 @域名）',
        '密码栏填「客户端专用密码 / 授权码」，很多邮箱不接受网页登录密码',
        '企业邮箱需要管理员在后台开启 IMAP / SMTP 服务',
    ]
    print('按下面顺序排查（%s）：' % name)
    for i, tip in enumerate(tips, 1):
        print('  %d) %s' % (i, tip))
    print('  4) 确认账号没有被停用 / 域名没有过期；同一账号短时间内反复失败可能被临时限制，等 10 分钟再试')
    return 1


if __name__ == '__main__':
    sys.exit(main())
