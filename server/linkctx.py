# -*- coding: utf-8 -*-
"""通知链接的站点基址（站内消息 / 邮件里的可点击链接）

为什么要有这个模块
--------------------------------------------------------------------
以前 ProjectPlanService._abs_url() 用 SERVER_HOST + SERVER_PORT 拼链接，
SERVER_HOST 默认又是 127.0.0.1，于是部署到服务器后，站内消息和通知邮件里
推的都是 http://127.0.0.1:8808/xxx.html —— 收件人点开等于访问**自己的电脑**。

现在的两条口径
--------------------------------------------------------------------
· 站内消息（IM）：一律用**相对路径**（rel_url）。浏览器按当前站点解析，
  换 IP、换域名、换端口、走反向代理都不会失效。
· 邮件正文：邮件客户端没有站点上下文，必须绝对地址（abs_url）。基址取：

      1. 配置 PUBLIC_BASE_URL（conf/settings.json 或环境变量，部署时写对外地址）
      2. 当次请求的访问基址 request.url_root（浏览器用什么地址访问，就用什么）
      3. 都没有 → 退化成相对路径，**绝不写死 127.0.0.1**

第 2 条的取值由 app.py 的 before_request 写入（contextvars 按请求隔开），
所以后台线程（邮件队列 worker）里读到的永远是第 1 条或空。
"""
import contextvars

import config

_ORIGIN = contextvars.ContextVar('notify_origin', default='')


def set_origin(origin):
    """记录当次请求的访问基址（app.py before_request 调用）"""
    _ORIGIN.set((origin or '').strip().rstrip('/'))


def clear_origin():
    _ORIGIN.set('')


def configured_origin():
    """配置里的对外基址（没配就是空串）"""
    return (getattr(config, 'PUBLIC_BASE_URL', '') or '').strip().rstrip('/')


def origin():
    """当前生效的基址：配置优先，其次当次请求，最后空串"""
    return configured_origin() or _ORIGIN.get() or ''


def rel_url(path):
    """相对路径：'/workplan-design.html?id=xx'（站内消息用这个）"""
    return '/' + str(path or '').lstrip('/')


def abs_url(path):
    """绝对地址：基址 + 相对路径（邮件用这个）；没有基址时退回相对路径"""
    p = rel_url(path)
    base = origin()
    return (base + p) if base else p
