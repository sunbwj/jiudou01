# -*- coding: utf-8 -*-
"""
邮件富文本协议层验证（纯函数，不连数据库 / 不发信）
------------------------------------------------------------
覆盖「阅读邮件与写邮件支持富文本」里和后端有关的两个纯函数：
  · html_to_text：HTML 正文 → 纯文本（邮件的 text/plain 备选部分、列表摘要、判空）
  · clean_html ：发信前的兜底清洗（危险标签 / on* 事件 / javascript: 协议）
以及 build_message 的 MIME 结构：
  · 有 body_html → multipart/alternative(text/plain + text/html)，HTML 部分就是编辑器产出的片段；
  · 没有 body_html → 保持旧行为（纯文本按 \\n → <br> 转成 HTML）；
  · 带附件 → multipart/mixed 包住 alternative，附件单独一段；
  · 只给 body_html 不给 body → 纯文本部分自动从 HTML 反抽，不会发出「空的纯文本」。
用法：python server/test_mail_richtext.py
"""
import inspect
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mail_client

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


def parts_of(msg):
    """把 build_message 的结果拆成 {content_type: payload_text}（只处理两层结构）"""
    out = {}
    for part in msg.walk():
        ctype = part.get_content_type()
        if ctype in ('multipart/alternative', 'multipart/mixed'):
            continue
        payload = part.get_payload(decode=True)
        text = payload.decode('utf-8') if payload else ''
        out.setdefault(ctype, text)
    return out


def main():
    print('--- 1. html_to_text：HTML → 纯文本 ---')
    t1 = mail_client.html_to_text('<p>第一段</p><p>第二段</p>')
    check('块级标签转换成换行', t1 == '第一段\n第二段', repr(t1))
    t2 = mail_client.html_to_text('a<br>b<br/>c')
    check('<br> / <br/> 转换成换行', t2 == 'a\nb\nc', repr(t2))
    t3 = mail_client.html_to_text('<ul><li>一</li><li>二</li></ul>')
    check('列表项前加圆点', '· 一' in t3 and '· 二' in t3, repr(t3))
    t4 = mail_client.html_to_text('<b>加粗</b>与<span style="color:#f56c6c">红字</span>')
    check('去掉标签只留文字', t4 == '加粗与红字', repr(t4))
    t5 = mail_client.html_to_text('<p>a&nbsp;b &amp; c &lt;d&gt;</p>')
    check('HTML 实体被还原（&nbsp; / &amp; / &lt;）', t5 == 'a b & c <d>', repr(t5))
    t6 = mail_client.html_to_text('<style>.x{color:red}</style><script>alert(1)</script><p>正文</p>')
    check('script / style 内容不进纯文本', t6 == '正文' and 'alert' not in t6, repr(t6))
    t7 = mail_client.html_to_text('<p>a</p><p></p><p></p><p>b</p>')
    check('最多保留一个空行（不出现连续空行）', '\n\n\n' not in t7, repr(t7))
    check('空入参返回空串', mail_client.html_to_text('') == '' and
          mail_client.html_to_text(None) == '')

    print('\n--- 2. clean_html：发信前的兜底清洗 ---')
    dirty = ('<div onclick="alert(1)">x</div><script>alert(2)</script>'
             '<iframe src="http://evil"></iframe><img src="a.png" onerror="alert(3)">'
             '<a href="javascript:alert(4)">链</a>')
    c = mail_client.clean_html(dirty)
    check('去掉 <script> 标签与内容', '<script' not in c and 'alert(2)' not in c, c[:80])
    check('去掉 <iframe>', '<iframe' not in c, c[:80])
    check('去掉 on* 事件属性', 'onclick' not in c and 'onerror' not in c, c[:80])
    check('javascript: 协议被中和', 'javascript:' not in c, c[:80])
    check('保留正常标签与文字', '<div' in c and '链' in c and 'a.png' in c, c[:80])
    check('空入参返回空串', mail_client.clean_html('') == '' and
          mail_client.clean_html(None) == '')

    print('\n--- 3. build_message：富文本正文的 MIME 结构 ---')
    msg = mail_client.build_message(
        'service@jiudou.com', '服务信箱', ['client@example.com'], [], '周报',
        '纯文本正文', body_html='<b>加粗</b>与<span style="color:#f56c6c">红字</span><ol><li>要点</li></ol>')
    check('顶层是 multipart/alternative', msg.get_content_type() == 'multipart/alternative',
          msg.get_content_type())
    parts = parts_of(msg)
    check('同时有 text/plain 与 text/html 两部分',
          'text/plain' in parts and 'text/html' in parts, str(sorted(parts.keys())))
    check('HTML 部分就是编辑器产出的片段',
          '<b>加粗</b>' in parts['text/html'] and '<ol>' in parts['text/html'],
          parts['text/html'][:120])
    check('HTML 部分带统一字体基线（14px/1.7）', 'font:14px/1.7' in parts['text/html'],
          parts['text/html'][:80])
    check('纯文本部分用调用方给的 body（原样、不带标签）',
          parts['text/plain'].strip() == '纯文本正文' and '<b>' not in parts['text/plain'],
          repr(parts['text/plain'][:80]))
    check('主题 / 收件人正确',
          msg.get('Subject') == '周报' and 'client@example.com' in str(msg.get('To')),
          '%s / %s' % (msg.get('Subject'), msg.get('To')))

    print('\n--- 4. build_message：纯文本邮件（保持旧行为） ---')
    old = mail_client.build_message('service@jiudou.com', '服务信箱',
                                    ['c@example.com'], [], '纯文本', '第一行\n第二行')
    oparts = parts_of(old)
    check('纯文本也带 HTML 部分（\\n → <br>）',
          '第一行<br>第二行' in oparts['text/html'], oparts['text/html'][:100])
    check('纯文本邮件无 <b> 等格式标签', '<b>' not in oparts['text/html'])

    print('\n--- 5. build_message：只给 HTML 时自动反抽纯文本 ---')
    only_html = mail_client.build_message('s@j.com', '服务信箱', ['c@example.com'], [],
                                          '只有 HTML', '', body_html='<p>只有富文本</p>')
    hp = parts_of(only_html)
    check('text/plain 部分不为空（自动从 HTML 反抽）',
          '只有富文本' in hp['text/plain'], hp['text/plain'][:60])

    print('\n--- 6. build_message：带附件时 mixed 包住 alternative ---')
    att = [{'name': '清单.txt', 'data': b'hello', 'contentType': 'text/plain'}]
    mixed = mail_client.build_message('s@j.com', '服务信箱', ['c@example.com'], [],
                                      '带附件', '正文', att, body_html='<b>粗</b>')
    check('顶层是 multipart/mixed', mixed.get_content_type() == 'multipart/mixed',
          mixed.get_content_type())
    check('第一段仍是 alternative（正文二选一）',
          mixed.get_payload(0).get_content_type() == 'multipart/alternative',
          mixed.get_payload(0).get_content_type())
    mp = parts_of(mixed)
    check('附件被单独挂载且文件名正确',
          any('清单.txt' in str(p.get_filename()) for p in mixed.walk()
              if p.get_content_type() == 'text/plain' and p.get_filename()),
          str([p.get_filename() for p in mixed.walk()]))
    check('带附件时 HTML 正文仍然保留', '<b>粗</b>' in mp['text/html'], mp.get('text/html', '')[:80])

    print('\n--- 7. 接口签名：send_mail 接受 body_html ---')
    sig = inspect.signature(mail_client.send_mail)
    check('send_mail(..., body_html=...) 参数存在', 'body_html' in sig.parameters, str(sig))
    bsig = inspect.signature(mail_client.build_message)
    check('build_message(..., body_html=...) 参数存在', 'body_html' in bsig.parameters, str(bsig))

    print('\n结果：通过 %d 项，失败 %d 项' % (PASS, FAIL))
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
