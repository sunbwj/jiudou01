# -*- coding: utf-8 -*-
"""
邮件协议层：服务信箱的收件（IMAP）与发件（SMTP）
------------------------------------------------------------
· 只用 Python 标准库（imaplib / smtplib / email），不引入第三方依赖；
· 服务器地址默认按邮箱域名推断（QQ / 163 / 126 / 新浪 / 阿里 / Outlook / Gmail / 企业域名），
  也可以在「服务信箱设置」里手工填写 smtpHost / smtpPort / imapHost / imapPort 覆盖；
· 收件只 **只读** 打开 INBOX（readonly=True）并按 UID 取最近 N 封，不改动邮箱里的已读状态；
· 密码（邮箱授权码）在库里加密保存：encrypt_secret / decrypt_secret（轻量混淆，防明文直读；
  生产环境建议改用 KMS / Vault 之类的密钥托管）；
· 所有网络操作都带超时，失败抛 MailError（message 可直接展示给用户）。
"""
import base64
import datetime
import email
import hashlib
import html as html_lib
import imaplib
import mimetypes
import re
import smtplib
import socket
import ssl
from email import encoders
from email.header import decode_header
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, parseaddr, parsedate_to_datetime

import config


class MailError(Exception):
    """邮件协议异常：message 直接给前端展示"""

    def __init__(self, message):
        super(MailError, self).__init__(message)
        self.message = message


# ---------------------------------------------------------------- 密码加解密 ----------------------------------------------------------------
_MAGIC = 'enc:v1:'


def _secret_key():
    return hashlib.sha256(('jiudou-service-email|' + str(config.MAIL_SECRET)).encode('utf-8')).digest()


def encrypt_secret(text):
    """加密密码 / 授权码（XOR 流 + base64，带版本前缀，便于将来更换算法）"""
    text = '' if text is None else str(text)
    if not text:
        return ''
    key = _secret_key()
    raw = text.encode('utf-8')
    out = bytearray(len(raw))
    for i, byte in enumerate(raw):
        out[i] = byte ^ key[i % len(key)]
    return _MAGIC + base64.b64encode(bytes(out)).decode('ascii')


def decrypt_secret(text):
    """解密；不是本模块加密的内容（历史明文）原样返回，保证兼容"""
    text = '' if text is None else str(text)
    if not text:
        return ''
    if not text.startswith(_MAGIC):
        return text
    try:
        raw = base64.b64decode(text[len(_MAGIC):].encode('ascii'))
    except Exception:
        return ''
    key = _secret_key()
    out = bytearray(len(raw))
    for i, byte in enumerate(raw):
        out[i] = byte ^ key[i % len(key)]
    try:
        return bytes(out).decode('utf-8')
    except Exception:
        return ''


# ---------------------------------------------------------------- 服务商推断 ----------------------------------------------------------------
# 常见邮箱服务商的服务器（默认端口：IMAP 993 / SMTP 465）
PROVIDERS = {
    'qq.com': ('imap.qq.com', 993, 'smtp.qq.com', 465, 'QQ 邮箱'),
    'foxmail.com': ('imap.qq.com', 993, 'smtp.qq.com', 465, 'QQ 邮箱'),
    'vip.qq.com': ('imap.qq.com', 993, 'smtp.qq.com', 465, 'QQ 邮箱'),
    '163.com': ('imap.163.com', 993, 'smtp.163.com', 465, '网易 163'),
    '126.com': ('imap.126.com', 993, 'smtp.126.com', 465, '网易 126'),
    'yeah.net': ('imap.yeah.net', 993, 'smtp.yeah.net', 465, '网易 yeah'),
    'sina.com': ('imap.sina.com', 993, 'smtp.sina.com', 465, '新浪邮箱'),
    'sina.cn': ('imap.sina.cn', 993, 'smtp.sina.cn', 465, '新浪邮箱'),
    'sohu.com': ('imap.sohu.com', 993, 'smtp.sohu.com', 465, '搜狐邮箱'),
    'aliyun.com': ('imap.aliyun.com', 993, 'smtp.aliyun.com', 465, '阿里邮箱'),
    '139.com': ('imap.139.com', 993, 'smtp.139.com', 465, '移动 139'),
    '189.cn': ('imap.189.cn', 993, 'smtp.189.cn', 465, '电信 189'),
    'outlook.com': ('outlook.office365.com', 993, 'smtp.office365.com', 587, 'Outlook'),
    'hotmail.com': ('outlook.office365.com', 993, 'smtp.office365.com', 587, 'Hotmail'),
    'live.com': ('outlook.office365.com', 993, 'smtp.office365.com', 587, 'Outlook'),
    'gmail.com': ('imap.gmail.com', 993, 'smtp.gmail.com', 465, 'Gmail'),
}
RE_EMAIL = re.compile(r'^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$')

# 手工填写服务器地址时，按 IMAP 主机名反查服务商（企业邮箱用自有域名，靠域名推不出来，
# 只能看服务器地址；识别出来只影响页面显示的名称与认证失败提示，不影响连接参数）
HOST_PROVIDERS = (
    ('imap.qiye.aliyun.com', '阿里企业邮箱'),
    ('imap.aliyun.com', '阿里邮箱'),
    ('imap.exmail.qq.com', '腾讯企业邮'),
    ('imap.qiye.163.com', '网易企业邮'),
    ('imap.263.net', '263 企业邮箱'),
    ('outlook.office365.com', 'Outlook'),
    ('imap.gmail.com', 'Gmail'),
)


def provider_of(address):
    """按邮箱域名给出服务器配置与显示名/provider 名称"""
    addr = (address or '').strip().lower()
    domain = addr.split('@')[-1] if '@' in addr else ''
    hit = PROVIDERS.get(domain)
    if hit:
        imap_host, imap_port, smtp_host, smtp_port, label = hit
        return {'imapHost': imap_host, 'imapPort': imap_port,
                'smtpHost': smtp_host, 'smtpPort': smtp_port, 'provider': label,
                'inferred': True}
    # 企业自有域名：按 imap.<domain> / smtp.<domain> 猜测
    return {'imapHost': ('imap.' + domain) if domain else '', 'imapPort': 993,
            'smtpHost': ('smtp.' + domain) if domain else '', 'smtpPort': 465,
            'provider': '自定义域名', 'inferred': True}


def provider_label_by_host(host):
    """按 IMAP 主机名识别服务商（识别不出返回空串）"""
    text = str(host or '').strip().lower()
    if not text:
        return ''
    for known, label in HOST_PROVIDERS:
        if text == known:
            return label
    return ''


def servers_of(account):
    """
    合并「手工配置」与「自动推断」：手工填了就用手工的
    :param account dict 含 email / imapHost / imapPort / smtpHost / smtpPort / useSsl
    """
    guess = provider_of((account or {}).get('email'))
    use_ssl = int((account or {}).get('useSsl', 1) or 0) == 1
    imap_host = (account.get('imapHost') or guess['imapHost'] or '').strip()
    smtp_host = (account.get('smtpHost') or guess['smtpHost'] or '').strip()
    try:
        imap_port = int(account.get('imapPort') or guess['imapPort'])
    except (TypeError, ValueError):
        imap_port = guess['imapPort']
    try:
        smtp_port = int(account.get('smtpPort') or guess['smtpPort'])
    except (TypeError, ValueError):
        smtp_port = guess['smtpPort']
    return {
        'imapHost': imap_host, 'imapPort': imap_port,
        'smtpHost': smtp_host, 'smtpPort': smtp_port,
        'useSsl': use_ssl,
        'provider': provider_label_by_host(imap_host) or guess['provider']
    }


# ---------------------------------------------------------------- 解码工具 ----------------------------------------------------------------
def decode_mime(text):
    """解码邮件头里的 MIME 编码（=?UTF-8?B?...?=），失败原样返回"""
    if text is None:
        return ''
    if not isinstance(text, str):
        text = str(text)        # 某些邮件头会被 email 库解析成 Header 对象
    if isinstance(text, bytes):
        try:
            return text.decode('utf-8', 'ignore')
        except Exception:
            return ''
    parts = []
    try:
        for chunk, charset in decode_header(text):
            if isinstance(chunk, bytes):
                try:
                    parts.append(chunk.decode(charset or 'utf-8', 'ignore'))
                except Exception:
                    parts.append(chunk.decode('utf-8', 'ignore'))
            else:
                parts.append(chunk)
    except Exception:
        return str(text)
    return ''.join(parts).strip()


def _safe_dt(value):
    """邮件头时间 → 'YYYY-MM-DD HH:MM:SS'；解析不了用当前时间"""
    try:
        dt = parsedate_to_datetime(value)
        if dt.tzinfo is not None:
            dt = dt.astimezone().replace(tzinfo=None)
        return dt.strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _body_of(msg):
    """拆出纯文本正文与 HTML 正文（优先 text/plain，附件跳过）"""
    text_parts, html_parts, has_attach = [], [], False
    for part in msg.walk():
        ctype = str(part.get_content_type() or '').lower()
        # Content-Disposition 可能是 email.header.Header 对象（不能直接 .lower()）
        disposition = str(part.get('Content-Disposition') or '').lower()
        try:
            filename = part.get_filename()
        except Exception:
            filename = None
        if filename or 'attachment' in disposition:
            has_attach = True
            continue
        if ctype == 'text/plain':
            try:
                text_parts.append(part.get_payload(decode=True).decode(part.get_content_charset() or 'utf-8', 'ignore'))
            except Exception:
                pass
        elif ctype == 'text/html':
            try:
                html_parts.append(part.get_payload(decode=True).decode(part.get_content_charset() or 'utf-8', 'ignore'))
            except Exception:
                pass
    return '\n'.join([t for t in text_parts if t]).strip(), \
        '\n'.join([h for h in html_parts if h]).strip(), has_attach


def _attach_filename(part):
    """附件文件名：MIME 编码头（=?utf-8?B?...?= / RFC2231）解码成可读中文名"""
    try:
        name = part.get_filename()
    except Exception:
        name = None
    if not name:
        return 'attachment'
    try:
        pieces = decode_header(str(name))
        out = []
        for text, charset in pieces:
            out.append(text.decode(charset or 'utf-8', 'ignore')
                       if isinstance(text, bytes) else str(text))
        name = ''.join(out)
    except Exception:
        name = str(name)
    return (name or '').strip() or 'attachment'


def _is_attach_part(part):
    """与 _body_of 完全一致的附件判定（有文件名或 Content-Disposition: attachment）"""
    disposition = str(part.get('Content-Disposition') or '').lower()
    try:
        filename = part.get_filename()
    except Exception:
        filename = None
    return bool(filename or 'attachment' in disposition)


def _attachments_of(msg):
    """
    把 MIME 里的附件拆成 [{name, size, contentType, data}]
      · data 是解码后的二进制；超大附件（单个 / 单封合计超 config 上限）data=None，
        只保留名字与大小 —— 避免把几十 MB 的东西读进内存 / 写进磁盘，下载列表里标「未保存」；
      · 收件走的是 IMAP RFC822，附件本来就随整封信一起下载了，这里解析不产生额外网络开销。
    """
    one_max = int(config.MAIL_INBOX_ATTACH_MB) * 1024 * 1024
    total_max = int(config.MAIL_INBOX_TOTAL_MB) * 1024 * 1024
    out, total = [], 0
    for part in msg.walk():
        ctype = str(part.get_content_type() or '').lower()
        if ctype.startswith('multipart/') or not _is_attach_part(part):
            continue
        try:
            data = part.get_payload(decode=True) or b''
        except Exception:
            data = b''
        name = _attach_filename(part)
        size = len(data)
        content_type = ctype if ctype not in ('', 'application/octet-stream') else \
            (mimetypes.guess_type(name)[0] or 'application/octet-stream')
        keep = bool(data) and size <= one_max and total + size <= total_max
        if keep:
            total += size
        out.append({'name': name[:250], 'size': size, 'contentType': content_type[:150],
                    'data': data if keep else None})
    return out


def _message_dict(msg, uid_text):
    """一封 RFC822 原始邮件 → 收件入库用的统一结构（fetch_inbox / fetch_one 共用）"""
    body_text, body_html, has_attach = _body_of(msg)
    from_name, from_addr = parseaddr(decode_mime(msg.get('From')))
    attachments = _attachments_of(msg)
    return {
        'uid': uid_text,
        'messageId': (msg.get('Message-ID') or '')[:250],
        'fromAddr': (from_addr or '')[:250],
        'fromName': (from_name or from_addr or '')[:120],
        'toAddr': decode_mime(msg.get('To'))[:2000],
        'ccAddr': decode_mime(msg.get('Cc'))[:2000],
        'subject': (decode_mime(msg.get('Subject')) or '(无主题)')[:500],
        'sentTime': _safe_dt(msg.get('Date')),
        'bodyText': body_text,
        'bodyHtml': body_html,
        'hasAttach': 1 if (has_attach or attachments) else 0,
        'attachments': attachments,
    }


def _raw_of_payload(payload):
    """IMAP FETCH 的返回值里挑出 RFC822 原始字节"""
    for item in payload or []:
        if isinstance(item, tuple) and len(item) > 1:
            return item[1]
    return None


# ---------------------------------------------------------------- 常见失败原因提示 ----------------------------------------------------------------
def auth_hint(address, hosts=None):
    """
    针对常见邮箱给出「为什么会认证失败」的具体指引
      · 网易（163/126/yeah）与 QQ 邮箱都必须用「客户端授权码」，不能用网页登录密码；
      · 阿里 / 腾讯 / 网易的**企业邮箱**除了授权码，还需要管理员在后台开启 IMAP/SMTP；
      · 同时要在邮箱网页版里开启 IMAP / SMTP 服务，否则即使授权码正确也会被拒。
    企业邮箱用的是自有域名，光看地址推不出服务商，所以同时参考 IMAP 主机名。
    """
    domain = (address or '').split('@')[-1].strip().lower()
    host = ' '.join(str((hosts or {}).get(k) or '') for k in ('imapHost', 'smtpHost')).lower()
    lab = provider_label_by_host((hosts or {}).get('imapHost'))
    if domain in ('163.com', '126.com', 'yeah.net', 'vip.163.com', 'vip.126.com', '188.com'):
        return ('163/126/yeah 邮箱必须使用「客户端授权码」而不是登录密码：'
                '登录邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 新增授权码，'
                '把 16 位授权码填到「密码 / 授权码」里再保存；同时确认地址拼写正确（如 163.com 不是 163.ccom）')
    if domain in ('qq.com', 'foxmail.com', 'vip.qq.com'):
        return ('QQ / Foxmail 邮箱必须使用「授权码」而不是 QQ 登录密码：'
                'QQ 邮箱网页版 → 设置 → 账号 → POP3/IMAP 服务 → 开启并生成授权码')
    if domain in ('aliyun.com', 'aliyun.cn') or 'aliyun' in host or lab == '阿里企业邮箱':
        return ('阿里邮箱第三方客户端只能用「三方客户端安全密码」（16 位，只显示一次），'
                '网页登录密码无效：网页版 → 设置 → 查看更多设置 → 账户与安全 → 账户安全 → '
                '三方客户端登录安全管理 → 生成新密码；并请管理员确认已开启「第三方客户端登录」'
                '与该账号的 POP3/IMAP/SMTP 服务；账号要填完整邮箱地址')
    if domain in ('exmail.qq.com',) or 'exmail.qq.com' in host or lab == '腾讯企业邮':
        return ('腾讯企业邮要填「客户端专用密码」，不是网页登录密码：网页版 → 设置 → 客户端设置 → '
                '生成专用密码；并请管理员确认已开启 IMAP/SMTP 服务')
    if domain in ('qiye.163.com',) or 'qiye.163.com' in host or lab == '网易企业邮':
        return ('网易企业邮要填「客户端授权密码」：网页版 → 设置 → 客户端授权密码 → 新增；'
                '并由管理员确认已开启 IMAP/SMTP 服务')
    if domain in ('outlook.com', 'hotmail.com', 'live.com', 'office365.com') or 'office365' in host:
        return 'Outlook 需要在账户安全设置中启用「双重验证 + 应用密码」，或确认租户未禁用 SMTP AUTH'
    return ''


def _login_error(address, exc, label='邮箱', hosts=None):
    """
    把认证失败整理成一句用户能照着做的提示（label 用来区分收件 / 发件）
      · 有的服务器只回一句「LOGIN failed.」，什么都不说（阿里邮箱就是这样），
        这时给出通用排查顺序，比原样把服务器的话扔给用户有用得多；
      · 提示放在前面、服务器原文放后面：lastError 字段只有 255 字，原文通常很短，不会被截掉。
    """
    hint = auth_hint(address, hosts)
    text = _clean_exc(exc)
    if not hint:
        hint = ('服务器没有说明原因，请按顺序排查：① 地址是否填完整（含 @域名）；'
                '② 密码栏填的是不是「客户端专用密码 / 授权码」（很多邮箱不接受网页登录密码）；'
                '③ 邮箱后台是否已开启 IMAP / SMTP（企业邮箱需管理员开启）')
    return '%s登录失败（%s）：%s' % (label, hint, text)


_INVISIBLE_CHARS = '\ufeff\u200b\u200c\u200d'      # BOM / 零宽字符：正常密码里不会有人故意用


def _clean_password(password):
    """
    密码 / 授权码归一化：去掉首尾空白，以及夹在里面的不可见字符
      · 从网页复制授权码时经常带上尾随空格、全角空格（\\u3000）、零宽字符或 BOM，
        肉眼完全看不出来，但会让 LOGIN 直接失败（阿里邮箱只回一句 "LOGIN failed."）；
      · 空白只裁首尾（密码中间可能真有空格），BOM / 零宽字符则整串剔除（不可能是有意为之）。
    """
    text = '' if password is None else str(password)
    for ch in _INVISIBLE_CHARS:
        text = text.replace(ch, '')
    return text.strip(' \t\r\n\u3000\u00a0')



# ---------------------------------------------------------------- IMAP 收件 ----------------------------------------------------------------
# imaplib 的命令表里默认没有 ID 命令，直接 _simple_command('ID', ...) 会抛 KeyError: 'ID'；
# 这里把它登记成「认证前后都可用」，否则网易邮箱（163/126/yeah）收件时会一直返回
# "EXAMINE Unsafe Login. Please contact kefu@188.com for help"。
imaplib.Commands.setdefault('ID', ('NONAUTH', 'AUTH', 'SELECTED'))


def _imap_send_id(conn, address):
    """
    网易（163 / 126 / yeah）要求客户端在登录后先发送 ID 命令声明身份
    （名称 / 版本 / 厂商），否则后续 SELECT / EXAMINE 会返回
    "Unsafe Login. Please contact kefu@188.com for help"，表现为「无法打开收件箱」。
    这是 IMAP 的扩展能力（CAPABILITY 里带 ID 才有效），失败不影响主流程。
    """
    try:
        args = ('("name" "JiudouMail" "version" "1.0" "vendor" "jiudou" '
                '"support-email" "%s")' % (address or ''))
        typ, data = conn._simple_command('ID', args)
        try:
            conn._untagged_response(typ, [data], 'ID')
        except Exception:
            pass
        return typ == 'OK'
    except Exception:
        return False                # 服务器不支持 ID 时忽略


def _select_error(mailbox, data):
    """SELECT / EXAMINE 失败时给出可执行的说明（网易的 Unsafe Login 是最常见的一种）"""
    reason = _clean_exc(data)
    low = reason.lower()
    if 'unsafe login' in low:
        return ('无法打开收件箱（%s）：邮箱服务端判定为「非授信客户端登录」（%s）。'
                '163/126 等网易邮箱要求客户端在登录后先声明客户端身份，程序已自动声明；'
                '若仍出现，请到邮箱网页版确认已开启 IMAP 服务，并在 10 分钟后再试'
                '（短时间内频繁登录/连接过多会被临时限制）' % (mailbox, reason))
    if 'login' in low and 'frequency' in low:
        return '无法打开收件箱（%s）：登录过于频繁，请稍后再试（%s）' % (mailbox, reason)
    return '无法打开收件箱（%s）：%s' % (mailbox, reason)


def _imap_connect(srv, address, password):
    password = _clean_password(password)
    if not password:
        raise MailError('收件邮箱登录失败：密码 / 授权码为空，请在「设置」里重新填写并保存')
    try:
        conn = imaplib.IMAP4_SSL(srv['imapHost'], srv['imapPort'], timeout=config.MAIL_TIMEOUT)
    except (socket.error, ssl.SSLError) as exc:
        raise MailError('连接收件服务器 %s:%s 失败：%s' % (srv['imapHost'], srv['imapPort'], _clean_exc(exc)))
    try:
        conn.login(address, password)
    except imaplib.IMAP4.error as exc:
        try:
            conn.logout()
        except Exception:
            pass
        raise MailError(_login_error(address, exc, '收件邮箱', srv))
    _imap_send_id(conn, address)    # 网易邮箱必需：登录后声明客户端身份
    return conn


def _clean_exc(exc):
    """把异常整理成一句人话（去掉 b'...' 包裹与多余空白，避免把 bytes 表示直接抛给用户）"""
    text = str(exc)
    text = re.sub(r"b'([^']*)'", r"\1", text)        # (535, b'Error: ...') → (535, Error: ...)
    text = re.sub(r"^b['\"]|['\"]$", '', text.strip())
    text = text.replace('\\r\\n', ' ').replace('\\n', ' ')
    return re.sub(r'\s+', ' ', text)[:180]


def fetch_inbox(address, password, hosts=None, limit=None, mailbox='INBOX'):
    """
    拉取收件箱最近 limit 封邮件（按 UID 倒序取，只读打开，不影响邮箱已读状态）
    :return list[dict]  每封：uid / messageId / fromAddr / fromName / toAddr / ccAddr / subject /
                              sentTime / bodyText / bodyHtml / hasAttach / attachments
    """
    srv = servers_of(dict(hosts or {}, email=address))
    limit = int(limit or config.MAIL_FETCH_LIMIT)
    conn = _imap_connect(srv, address, password)
    out = []
    try:
        typ, data = conn.select(mailbox, readonly=True)
        if typ != 'OK':
            raise MailError(_select_error(mailbox, data))
        typ, data = conn.uid('search', None, 'ALL')
        if typ != 'OK':
            raise MailError('读取邮件列表失败：%s' % _clean_exc(data))
        uids = (data or [b''])[0].split()
        for uid in uids[-limit:][::-1]:            # 最新的在前
            uid_text = uid.decode('ascii', 'ignore') if isinstance(uid, bytes) else str(uid)
            typ, payload = conn.uid('fetch', uid_text, '(RFC822)')
            if typ != 'OK' or not payload:
                continue
            raw = _raw_of_payload(payload)
            if not raw:
                continue
            out.append(_message_dict(email.message_from_bytes(raw), uid_text))
    finally:
        try:
            conn.close()
        except Exception:
            pass
        try:
            conn.logout()
        except Exception:
            pass
    return out


def fetch_one(address, password, uid, hosts=None, mailbox='INBOX'):
    """
    按 IMAP UID 补拉**单封**历史邮件（用于把历史收件的附件内容补存到下载列表）
      · 只读打开，不改邮箱已读状态；找不到 / 已被删除返回 None；
      · 返回结构与 fetch_inbox 的单封完全一致（含 attachments 二进制内容）。
    """
    srv = servers_of(dict(hosts or {}, email=address))
    conn = _imap_connect(srv, address, password)
    try:
        typ, data = conn.select(mailbox, readonly=True)
        if typ != 'OK':
            raise MailError(_select_error(mailbox, data))
        uid_text = str(uid)
        typ, payload = conn.uid('fetch', uid_text, '(RFC822)')
        if typ != 'OK':
            raise MailError('读取邮件附件失败：%s' % _clean_exc(payload))
        raw = _raw_of_payload(payload)
        if not raw:
            return None
        return _message_dict(email.message_from_bytes(raw), uid_text)
    finally:
        try:
            conn.close()
        except Exception:
            pass
        try:
            conn.logout()
        except Exception:
            pass


# ---------------------------------------------------------------- SMTP 发件 ----------------------------------------------------------------
def _attach_part(msg, name, data, content_type=''):
    """
    把一个附件挂到 msg 上
      · 内容 base64 编码（SMTP 只允许 7bit ASCII，二进制必须编码，否则中文/图片会损坏）；
      · 文件名用 RFC 2231 的 UTF-8 形式（filename=('utf-8','',name)），中文名在 Outlook / 网页邮箱里不会乱码。
    :param name str 文件名（可含中文）
    :param data bytes 文件原始内容
    """
    ctype = (content_type or '').split(';')[0].strip().lower()
    if not ctype or '/' not in ctype:
        ctype = mimetypes.guess_type(name)[0] or 'application/octet-stream'
    maintype, _, subtype = ctype.partition('/')
    if not maintype or not subtype:
        maintype, subtype = 'application', 'octet-stream'
    part = MIMEBase(maintype, subtype)
    part.set_payload(data)
    encoders.encode_base64(part)
    part.add_header('Content-Disposition', 'attachment', filename=('utf-8', '', name))
    msg.attach(part)


def html_to_text(html):
    """HTML 正文 → 纯文本（邮件的 text/plain 备选部分、列表摘要、判空都用它）

    只做「够用」的粗转换：块级标签换行、<br> 换行、<li> 加圆点、去标签、解实体。
    不引 BeautifulSoup（部署环境只保证标准库）。
    """
    raw = '' if html is None else str(html)
    if not raw:
        return ''
    s = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', '', raw)
    s = re.sub(r'(?i)<br\s*/?>', '\n', s)
    s = re.sub(r'(?i)<li[^>]*>', '\n· ', s)
    s = re.sub(r'(?i)</(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article)\s*>',
               '\n', s)
    s = re.sub(r'(?s)<[^>]+>', '', s)
    s = html_lib.unescape(s)
    s = s.replace('\u00a0', ' ')
    s = re.sub(r'[ \t]+\n', '\n', s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def clean_html(html):
    """发信前的兜底清洗：去危险标签 / on* 事件 / javascript: 协议

    前端的富文本编辑器已经只产出白名单内的东西，这里是对「直接调接口」的第二层防线。
    真正渲染时的清洗在前端 RichText.sanitize()（DOM 遍历，比正则可靠）。
    """
    raw = '' if html is None else str(html)
    if not raw:
        return ''
    s = re.sub(r'(?is)<(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*>.*?</\1>', '', raw)
    s = re.sub(r'(?is)<(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*/?>', '', s)
    s = re.sub(r'(?i)\son[a-z]+\s*=\s*"[^"]*"', '', s)
    s = re.sub(r"(?i)\son[a-z]+\s*=\s*'[^']*'", '', s)
    s = re.sub(r'(?i)\son[a-z]+\s*=\s*[^\s>]+', '', s)
    s = re.sub(r'(?i)(href|src)\s*=\s*(["\'`])\s*javascript:[^"\']*\2', r'\1=\2#\2', s)
    return s


def build_message(address, display_name, to_list, cc_list, subject, body, attachments=None,
                  body_html=None):
    """
    组装一封邮件（纯文本 + HTML 正文，可选混合附件）
      · 无附件 → multipart/alternative（与旧行为一致，兼容性最好）；
      · 有附件 → multipart/mixed 包住 alternative（正文仍是 文本+HTML 二选一，附件各自一段）。
      · body_html 非空时直接用它做 HTML 部分（富文本正文），纯文本部分仍由调用方给的 body 决定；
        没给 body 就从 body_html 反抽（html_to_text）。
    :param attachments list[dict] 每项 {name, data(bytes), contentType(可空)}
    :return email.message.Message
    """
    raw_html = clean_html(body_html)
    body_text = str(body or '')
    if not body_text and raw_html:
        body_text = html_to_text(raw_html)
    if raw_html:
        html = ('<div style="font:14px/1.7 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;'
                'color:#303133;word-break:break-word">' + raw_html + '</div>')
    else:
        html = ('<div style="font:14px/1.7 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;color:#303133">'
                + body_text.replace('\n', '<br>') + '</div>')
    alt = MIMEMultipart('alternative')
    alt.attach(MIMEText(body_text, 'plain', 'utf-8'))
    alt.attach(MIMEText(html, 'html', 'utf-8'))
    files = [one for one in (attachments or []) if one and one.get('data') is not None]
    if files:
        msg = MIMEMultipart('mixed')
        msg.attach(alt)
        for one in files:
            _attach_part(msg, one.get('name') or 'attachment', one.get('data') or b'',
                         one.get('contentType') or '')
    else:
        msg = alt
    msg['Subject'] = subject or '(无主题)'
    msg['From'] = formataddr((decode_mime(display_name) or address.split('@')[0], address))
    msg['To'] = ', '.join(to_list or [])
    if cc_list:
        msg['Cc'] = ', '.join(cc_list)
    return msg


def send_mail(address, password, hosts, to_list, subject, body, cc_list=None, display_name='',
              attachments=None, body_html=None):
    """
    发送一封纯文本 + HTML 邮件（可带附件）
    :param body      纯文本正文（HTML 版的兜底 / 邮件客户端的纯文本模式）
    :param body_html 富文本正文（HTML 片段，留空则把 body 按换行转成 HTML）
    :param attachments list[dict] 每项 {name, data(bytes), contentType(可空)}；已由调用方校验大小与数量
    :raise MailError 连接 / 认证 / 发件失败
    """
    srv = servers_of(dict(hosts or {}, email=address))
    password = _clean_password(password)
    to_list = [x for x in (to_list or []) if x]
    cc_list = [x for x in (cc_list or []) if x]
    if not to_list:
        raise MailError('请填写收件人')
    msg = build_message(address, display_name, to_list, cc_list, subject, body, attachments,
                        body_html=body_html)

    try:
        if srv['useSsl']:
            client = smtplib.SMTP_SSL(srv['smtpHost'], srv['smtpPort'], timeout=config.MAIL_TIMEOUT)
        else:
            client = smtplib.SMTP(srv['smtpHost'], srv['smtpPort'], timeout=config.MAIL_TIMEOUT)
            client.ehlo()
            try:
                client.starttls()
                client.ehlo()
            except smtplib.SMTPException:
                pass
    except smtplib.SMTPException as exc:      # 注意：SMTPException 继承自 OSError，必须排在 socket 之前
        raise MailError('连接发件服务器 %s:%s 失败：%s' % (srv['smtpHost'], srv['smtpPort'], _clean_exc(exc)))
    except (socket.error, ssl.SSLError) as exc:
        raise MailError('连接发件服务器 %s:%s 失败：%s' % (srv['smtpHost'], srv['smtpPort'], _clean_exc(exc)))
    try:
        try:
            client.login(address, password)
        except smtplib.SMTPAuthenticationError as exc:
            raise MailError(_login_error(address, exc, '发件邮箱', srv))
        client.sendmail(address, to_list + cc_list, msg.as_string())
    except smtplib.SMTPSenderRefused as exc:
        raise MailError('发件被拒绝（可能是附件过大或收件人不受信任）：%s' % _clean_exc(exc))
    except smtplib.SMTPDataError as exc:
        raise MailError('邮件内容被服务器拒绝（常见原因：附件超过邮箱允许的大小）：%s' % _clean_exc(exc))
    finally:
        try:
            client.quit()
        except Exception:
            pass
    return {'to': to_list, 'cc': cc_list, 'subject': subject or '(无主题)',
            'attachments': [{'name': one.get('name'), 'size': len(one.get('data') or b'')}
                            for one in (attachments or [])]}



def test_connection(address, password, hosts=None):
    """
    测试服务信箱是否可用：IMAP 能登录 + SMTP 能登录
    :return {'imap': bool, 'smtp': bool, 'servers': {...}, 'messages': {...}}
    """
    srv = servers_of(dict(hosts or {}, email=address))
    password = _clean_password(password)
    result = {'imap': False, 'smtp': False, 'servers': srv, 'messages': {}}
    # IMAP：不光要能登录，还要能真正打开收件箱（163/126 未声明客户端身份时登录成功但 SELECT 会被拒）
    try:
        conn = _imap_connect(srv, address, password)
        try:
            typ, data = conn.select('INBOX', readonly=True)
        finally:
            try:
                conn.logout()
            except Exception:
                pass
        if typ != 'OK':
            raise MailError(_select_error('INBOX', data))
        result['imap'] = True
        result['messages']['imap'] = '收件服务连接成功（%s:%s，可打开收件箱）' % (srv['imapHost'], srv['imapPort'])
    except MailError as exc:
        result['messages']['imap'] = exc.message
    # SMTP
    try:
        if srv['useSsl']:
            client = smtplib.SMTP_SSL(srv['smtpHost'], srv['smtpPort'], timeout=config.MAIL_TIMEOUT)
        else:
            client = smtplib.SMTP(srv['smtpHost'], srv['smtpPort'], timeout=config.MAIL_TIMEOUT)
            client.ehlo()
            try:
                client.starttls()
                client.ehlo()
            except smtplib.SMTPException:
                pass
        try:
            client.login(address, password)
            result['smtp'] = True
            result['messages']['smtp'] = '发件服务连接成功（%s:%s）' % (srv['smtpHost'], srv['smtpPort'])
        finally:
            try:
                client.quit()
            except Exception:
                pass
    except smtplib.SMTPAuthenticationError as exc:   # 必须排在 OSError / socket 之前（SMTPException 是 OSError 子类）
        result['messages']['smtp'] = _login_error(address, exc, '发件邮箱', srv)
    except smtplib.SMTPException as exc:
        result['messages']['smtp'] = '连接发件服务器 %s:%s 失败：%s' % (srv['smtpHost'], srv['smtpPort'], _clean_exc(exc))
    except (socket.error, ssl.SSLError) as exc:
        result['messages']['smtp'] = '连接发件服务器 %s:%s 失败：%s' % (srv['smtpHost'], srv['smtpPort'], _clean_exc(exc))
    return result
