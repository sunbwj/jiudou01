# -*- coding: utf-8 -*-
"""
通知链接口径验证（进程内，不需要启动 Web 服务，不碰数据库）
------------------------------------------------------------
背景：部署到服务器后，站内消息与通知邮件里推的还是 http://127.0.0.1:8808/xxx.html
（老实现用 SERVER_HOST + SERVER_PORT 拼），收件人点开就是访问自己的电脑。

现在的口径：
  · 站内消息（IM）→ **相对路径**：换 IP / 域名 / 端口 / 反向代理都不会失效；
  · 邮件正文   → **绝对地址**：PUBLIC_BASE_URL 配置 > 当次请求的访问地址 > 相对路径兜底，
                 任何情况下都不再使用 SERVER_HOST。

用法：python server/test_notify_link.py
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config
import linkctx
import service

PASS = 0
FAIL = 0


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, ('→ ' + str(extra)) if extra else ''))


def reset():
    """回到「没有请求上下文、没有配置」的干净状态"""
    linkctx.clear_origin()
    config.PUBLIC_BASE_URL = ''


def main():
    svc = service.project_plan_service

    print('\n--- 1. 相对路径工具 ---')
    reset()
    check("rel_url 补前导斜杠", svc._rel_url('workplan-design.html?a=1')
          == '/workplan-design.html?a=1', svc._rel_url('workplan-design.html?a=1'))
    check("rel_url 不重复加斜杠", svc._rel_url('/project-detail.html?id=1')
          == '/project-detail.html?id=1', svc._rel_url('/project-detail.html?id=1'))
    check("rel_url 空值 → '/'", svc._rel_url('') == '/' and svc._rel_url(None) == '/',
          repr(svc._rel_url(None)))

    print('\n--- 2. 没有配置、没有请求：绝对地址退化为相对路径（不写死 127.0.0.1）---')
    url = svc._abs_url('workplan-design.html?id=P1')
    check('abs_url 退化相对路径', url == '/workplan-design.html?id=P1', url)
    check('没有出现 127.0.0.1 / localhost',
          '127.0.0.1' not in url and 'localhost' not in url, url)
    check('没有出现服务端监听端口拼接', str(config.SERVER_PORT) not in url, url)

    print('\n--- 3. 请求上下文：用浏览器实际访问的地址 ---')
    import app as app_mod
    with app_mod.app.test_request_context('/main.html'):
        app_mod.app.preprocess_request()          # 触发 before_request 绑定基址
        got = svc._abs_url('workplan-design.html?id=P1')
        check('取到当次请求的基址', got == 'http://localhost/workplan-design.html?id=P1', got)
        rel = svc._rel_url('workplan-design.html?id=P1')
        check('站内消息仍是相对路径', rel == '/workplan-design.html?id=P1', rel)
    linkctx.clear_origin()
    check('请求结束后不再残留基址', svc._abs_url('a.html') == '/a.html', svc._abs_url('a.html'))

    print('\n--- 4. PUBLIC_BASE_URL 配置优先 ---')
    config.PUBLIC_BASE_URL = 'https://jiudou.example.com/'
    check('配置生效且裁掉尾斜杠',
          svc._abs_url('a.html') == 'https://jiudou.example.com/a.html',
          svc._abs_url('a.html'))
    with app_mod.app.test_request_context('/main.html'):
        app_mod.app.preprocess_request()
        check('配置优先于请求地址',
              svc._abs_url('a.html') == 'https://jiudou.example.com/a.html',
              svc._abs_url('a.html'))
    linkctx.clear_origin()
    reset()

    print('\n--- 5. 工作计划变更通知：消息相对、邮件绝对 ---')
    fake = service.WorkPlanService()
    pushes, mails = [], []
    fake._change_receivers = lambda plan, ch, old_rows=None: [1001]
    fake._employee = lambda emp_id, cache=None: {'nameCn': '张三',
                                                 'email': 'zhangsan@example.com'}
    fake._wp_push = lambda me, emp_id, title, content, html='': (
        pushes.append((content, html)) or True)
    fake._enqueue_mail = lambda plan_id, task_id, emp_id, email, subject, body, body_html: (
        mails.append((body, body_html)) or True)
    linkctx.set_origin('http://192.168.1.20:9000')
    out = fake._notify_changes({'id': 'P1', 'planName': '测试计划'},
                              [{'summary': '调整了任务时间'}], 1, '管理员')
    check('产生了站内消息与邮件草稿',
          len(pushes) == 1 and len(mails) == 1, (len(pushes), len(mails)))
    msg_html = pushes[0][1] if pushes else ''
    mail_html = mails[0][1] if mails else ''
    check('站内消息链接是相对路径',
          'href="/workplan-design.html?id=P1"' in msg_html, msg_html)
    check('邮件链接是绝对地址（带部署后的主机）',
          'href="http://192.168.1.20:9000/workplan-design.html?id=P1"' in mail_html, mail_html)
    check('站内消息里没有 127.0.0.1', '127.0.0.1' not in msg_html, msg_html)
    check('邮件里没有 127.0.0.1', '127.0.0.1' not in mail_html, mail_html)
    check('两封内容都保留 target/rel', 'target="_blank"' in msg_html
          and 'rel="noopener"' in mail_html, (msg_html, mail_html))
    linkctx.clear_origin()
    print('  （变更通知汇总：%s）' % out)

    print('\n--- 6. 源码守卫：不再用 SERVER_HOST 拼 URL ---')
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, 'service.py'), 'r', encoding='utf-8') as fh:
        src = fh.read()
    check('service.py 不再出现 SERVER_HOST 拼地址',
          not re.search(r"SERVER_HOST[\s\S]{0,80}?%s:%s", src), '仍有旧拼法')
    check('通知链接统一走 linkctx',
          'linkctx.rel_url' in src and 'linkctx.abs_url' in src)
    check('app.py 在请求入口绑定访问基址',
          'linkctx.set_origin(request.url_root)' in open(
              os.path.join(here, 'app.py'), 'r', encoding='utf-8').read())
    check('app.py 请求结束清掉基址（线程复用不串）',
          'linkctx.clear_origin()' in open(
              os.path.join(here, 'app.py'), 'r', encoding='utf-8').read())

    print('\n结果：通过 %d 项，失败 %d 项' % (PASS, FAIL))
    print('（说明：邮件里的主机取「当次访问地址」，所以部署后不用改配置就是对的；'
          '走反向代理/内外网分离时再填 PUBLIC_BASE_URL）')
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
