# -*- coding: utf-8 -*-
"""
菜单项 / 菜单组 / 部门组织架构管理后端服务（Python + Flask + MySQL）
------------------------------------------------------------
· 同时托管前端静态页面，页面与 API 同源，避免跨域问题；
· 统一入出参 JSON：请求 {JSON}，响应 {code, message, data}；
· **所有读写数据库的接口都要带登录 token**（参数 token / 请求头 X-Token / Authorization: Bearer），
  只有 /api/auth/login 与 /api/auth/captcha 免登录；token 无效 / 已过期统一返回 code=401；
· **单点登录（SSO）**：一次登录签发一个 token，全站（main.html 与所有 iframe 子页）共享同一份登录态；
  token 有效期默认 8 小时（config.TOKEN_TTL_HOURS，可用环境变量 TOKEN_TTL_HOURS 覆盖），
  过期后由框架页 main.html 统一跳转登录页（子页不自行跳转，见 js/api.js 的 401 汇聚逻辑）；
· 路由与前端 js/api.js 完全对齐：
    GET  /api/menu/list    /api/menu/detail  /api/menu/check  /api/menu/nextcode
    POST /api/menu/add     /api/menu/update  /api/menu/delete
    GET  /api/group/list   /api/group/detail /api/group/check /api/group/tree
    GET  /api/group/nextcode                 # 菜单组编号自动生成（MNG + 4 位流水号）
    POST /api/group/add    /api/group/update /api/group/delete
    GET  /api/groupitem/list   /api/groupitem/detail        # 菜单组项目（groupId 必填）
    POST /api/groupitem/add    /api/groupitem/update        # 批量追加 / 全量同步
    POST /api/groupitem/delete                              # 删除单条关联
    GET  /api/org/list     /api/org/detail   /api/org/check /api/org/tree
    GET  /api/org/nextcode                                  # 部门编号自动生成（DPT + 4 位流水号）
    POST /api/org/add      /api/org/update   /api/org/delete # 部门组织架构
    GET  /api/emp/list     /api/emp/detail   /api/emp/check
    GET  /api/emp/nextcode                                  # 工号自动生成（E + 5 位流水号）
    POST /api/emp/add      /api/emp/update   /api/emp/delete # 员工信息（邮箱必填 + 格式校验）
    POST /api/emparchive/archive                            # 员工信息归档（整表快照，返回批次 / 条数）
    GET  /api/emparchive/batches                            # 历次归档批次（归档时间 + 记录数，倒序）
    GET  /api/emparchive/list                               # 某批次（batchId）的员工列表（分页 / 关键字）
    GET  /api/useinfo/list   /api/useinfo/detail  /api/useinfo/check
    GET  /api/useinfo/empoptions                            # 员工下拉（是否已有账号，供建账号用）
    POST /api/useinfo/add     /api/useinfo/update  /api/useinfo/delete
    POST /api/useinfo/batch                                 # 按员工批量创建账号（初始密码 888888）
    POST /api/useinfo/resetpwd                              # 批量重置密码为 888888
    POST /api/useinfo/setroles                              # 批量设置角色（全量替换）
    POST /api/auth/login   /api/auth/logout                 # 登录（账号+MD5 密码 → token，有效期 8 小时）/ 退出登录
    GET  /api/auth/captcha                                  # 生成运算表达式验证码（一次性 / 5 分钟有效）
    POST /api/auth/sendcode    /api/auth/resetbyemail        # 忘记密码：邮箱验证码（服务信箱发信）/ 验证码 + 新密码重置
    POST /api/auth/changepwd                                # 登录后自助改密（原密码 + 新密码，改完作废 token）
    GET  /api/nav                                           # 左侧导航（按登录用户角色菜单权限过滤）
    GET  /api/auth/me                                       # 按 token 反查当前登录用户
    GET  /api/dptmgr/list                                   # 部门负责人设置列表（部门 + 负责人）
    POST /api/dptmgr/set   /api/dptmgr/delete               # 设置 / 清除负责人（一个部门一个负责人）
    GET  /api/role/list    /api/role/detail  /api/role/check
    POST /api/role/add     /api/role/update  /api/role/delete # 用户角色（UUID 主键，角色名唯一）
    GET  /api/rolepower/list  /api/rolepower/tree            # 角色权限（按角色查授权 / 权限树）
    POST /api/rolepower/save  /api/rolepower/clear           # 角色权限（全量替换 / 清空）
    GET  /api/rolepower/buttons                              # 角色已授权的页面按钮清单
    GET  /api/pageopbtn/list  /api/pageopbtn/pages           # 页面操作按钮（列表 / 页面下拉）
    POST /api/pageopbtn/scan  /api/pageopbtn/update  /api/pageopbtn/delete
                                                             # 页面操作按钮（自动收录 / 维护 / 删除）
    GET  /api/serviceemail/list  /api/serviceemail/detail  /api/serviceemail/check
    POST /api/serviceemail/add   /api/serviceemail/update  /api/serviceemail/delete
    POST /api/serviceemail/enabled                         # 服务信箱（UUID 主键，全表只能有一条启用）
    POST /api/serviceemail/test                            # 服务信箱：测试 IMAP / SMTP 连接
    GET  /api/mail/status   /api/mail/list   /api/mail/detail   # 邮箱助手：状态 / 收件箱·发件箱 / 读信
    POST /api/mail/sync     /api/mail/send   /api/mail/mark     # 邮箱助手：收件（自动+手动）/ 发信 / 已读
                                                             #   发信可带附件 attachments=[{name,size,type,data(base64)}]
                                                             #   （内容只进 MIME，不落库；库里只记名称与大小 attachInfo）
    POST /api/mail/delete                                     # 邮箱助手：删除邮件
    GET  /api/empmail/status  /api/empmail/list  /api/empmail/detail
    POST /api/empmail/save    /api/empmail/test   /api/empmail/sync
    POST /api/empmail/send    /api/empmail/mark   /api/empmail/delete
                                                             # 我的邮箱：员工个人信箱助手
                                                             #   （一人一条配置；邮件按 empId 强隔离，
                                                             #     后端只认 token 反查员工ID；
                                                             #     autoSync=1 的信箱由后台线程自动收件）
    GET  /api/dbinfo/list  /api/dbinfo/detail  /api/dbinfo/check /api/dbinfo/types
    POST /api/dbinfo/add   /api/dbinfo/update  /api/dbinfo/delete /api/dbinfo/enabled
                                                             # 数据中心：数据库连接对象（多数据库类型，密码加密存储）
    POST /api/dbinfo/test                                     # 数据中心：测试连接（能列出实例即视为连通）
    POST /api/dbinfo/scan                                     # 数据中心：扫描可用实例（库）列表
    GET  /api/dbinfo/tables    /api/dbinfo/columns            # 数据中心：扫描表 / 视图 / 字段（只读元数据）
    POST /api/dbinfo/sqlrun                                   # 数据中心：SQL 工作台执行一条只读查询（SELECT/SHOW/...）
    POST /api/dbinfo/rows                                     # 数据中心：表 / 视图数据分页（排序 + 过滤，只读）
    GET  /api/report/list  /api/report/detail  /api/report/check /api/report/categories
    GET  /api/report/connections  /api/report/databases  /api/report/tables  /api/report/columns
                                                              # 数据中心 · 报表设计器：报表信息 + 数据源元数据
    POST /api/report/add   /api/report/update  /api/report/delete /api/report/enabled
    POST /api/report/copy                                     # 数据中心：复制报表（新编码，默认停用）
    POST /api/report/preview                                  # 数据中心：报表预览（未保存也能预览，只读查询）
    POST /api/report/run                                      # 数据中心：按 id / code 调用报表（累加调用次数）
    GET  /api/project/list  /api/project/detail /api/project/check /api/project/nextcode
    GET  /api/project/types /api/project/options
    POST /api/project/add   /api/project/update /api/project/delete /api/project/enabled
    POST /api/project/importdoc                         # Word（.docx / .docm）→ 富文本 HTML（本地解析失败时兜底）
                                                             # 项目管理：项目信息（PRO + 6 位流水号，仅本人 + 公用可见；
                                                             #             项目说明为富文本，保存时按白名单清洗）
    GET  /api/projectdir/list   /api/projectdir/detail /api/projectdir/tree
    POST /api/projectdir/add    /api/projectdir/update /api/projectdir/delete
    POST /api/projectdir/enabled
                                                             # 项目管理：项目目录（多级文件夹 / 树形选择 / 删除时内容上移）
    GET  /api/projectfile/list  /api/projectfile/detail /api/projectfile/types
    GET  /api/projectfile/download
    GET  /api/preview/pdf                                    # 项目文件在线预览（doc/docx/ppt/pptx 服务端转 PDF）
    POST /api/projectfile/upload /api/projectfile/update /api/projectfile/delete
    POST /api/projectfile/enabled
                                                             # 项目管理：项目文件（上传 / 下载 / dirId 目录归属 / 仅本人 + 公用可见）
    GET  /api/workplan/list  /api/workplan/detail /api/workplan/nextcode
    GET  /api/workplan/people /api/workplan/orders            # 选人数据源（组织树 + 员工 + 项目组成员）/ 我的任务列表
    POST /api/workplan/add   /api/workplan/update /api/workplan/delete
    POST /api/workplan/save                                  # 工作计划：整图保存 plan + tasks[]（事务内全量替换任务）
                                                             #   任务类型 task / milestone / summary；preTaskIds 前置依赖；progress 完成百分比
                                                             #   execStatus / actualStartDate / actualEndDate / execRemark = 执行记录
                                                             #   计划「已启动」时，保存即给新增且已填人的任务补派工单并通知
                                                             #   （返回体追加 dispatched / notified / mailed）
    POST /api/workplan/start                                 # 启动：一任务一工单 + 责任人与参与人员的站内消息 / 通知邮件（幂等补派）
    POST /api/workplan/exec                                  # 执行记录回填：工单 → 按 taskId 更新关联任务（我的任务页调用）
                                                             #   /workplan/orders 与 /workplan/detail 双向 JOIN，工单与任务一一对应
    POST /api/workplan/importtasks                           # Excel 导入：base64 xlsx → 预览行 + 逐行错误（只解析，不落库）
    GET  /api/workplan/importtemplate                        # Excel 导入模板下载（表头 + 批注 + 下拉 + 填写说明）
    GET  /api/sysdict/list   /api/sysdict/detail  /api/sysdict/check
    GET  /api/sysdict/tree   /api/sysdict/options
    POST /api/sysdict/add    /api/sysdict/update  /api/sysdict/delete /api/sysdict/enabled
                                                             # 系统配置：系统字典键（UUID / 英文名唯一 / 上级 / 显示序号）
    GET  /api/sysdictitems/list  /api/sysdictitems/detail /api/sysdictitems/check
    POST /api/sysdictitems/add   /api/sysdictitems/update  /api/sysdictitems/delete
    POST /api/sysdictitems/enabled
                                                             # 系统配置：字典键值明细（按 dictId 归属 / 键唯一）
    GET  /api/syspara/list   /api/syspara/detail  /api/syspara/check
    POST /api/syspara/add    /api/syspara/update  /api/syspara/delete /api/syspara/enabled
                                                             # 系统配置：系统参数（UUID / 英文名唯一 / 参数值 / 显示序号）
启动：
    python server/app.py            # 默认 http://127.0.0.1:8808/
"""
import datetime
import json
import mimetypes
import os
import re
import sys
import traceback
from urllib.parse import quote

from flask import Flask, jsonify, redirect, request, send_from_directory
from flask_sock import Sock
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_ROOT = os.path.abspath(os.path.join(BASE_DIR, '..'))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from config import SERVER_HOST, SERVER_PORT  # noqa: E402
from config import TOKEN_TTL_HOURS  # noqa: E402
from service import ACTIONS, SERVICES, emp_message_service  # noqa: E402
from service import BizError  # noqa: E402
from db import query_one  # noqa: E402
from im_presence import presence, Conn, HEARTBEAT, dumps, enqueue  # noqa: E402
import linkctx  # noqa: E402  通知链接基址（站内消息用相对路径、邮件用绝对地址）

app = Flask(__name__, static_folder=WEB_ROOT, static_url_path='')

# 语音消息等音频附件的 MIME：Python 默认把 .webm 认成 video/webm，部分浏览器
# 在 <audio> 里会拒绝 video/*；这里按「音频优先」登记，保证静态服务回 audio/*。
for _ext, _mime in (('.webm', 'audio/webm'), ('.ogg', 'audio/ogg'),
                    ('.m4a', 'audio/mp4'), ('.mp3', 'audio/mpeg'), ('.wav', 'audio/wav')):
    mimetypes.add_type(_mime, _ext)
# 响应中的中文不做 \uXXXX 转义，统一 UTF-8 输出
app.json.ensure_ascii = False
# WebSocket 支持（站内消息 IM 实时推送）；flask-sock 复用 Flask 的路由与请求上下文
sock = Sock(app)


def ok(data=None, message='ok'):
    return jsonify({'code': 0, 'message': message, 'data': data})


def fail(message, code=500):
    return jsonify({'code': code, 'message': message, 'data': None})


# 免登录白名单：只有「登录」「取验证码」本身，以及「忘记密码」的两步（此时用户还没有 token）；
# auth/brand 只回系统品牌三个键（登录页要显示系统名称 / 英文名 / 图标），不暴露其它系统参数
TOKEN_FREE_ACTIONS = (('auth', 'login'), ('auth', 'captcha'),
                      ('auth', 'sendcode'), ('auth', 'resetbyemail'),
                      ('auth', 'brand'))


def token_of(params):
    """取请求里的登录令牌：参数 token → 请求头 X-Token → Authorization: Bearer"""
    token = ''
    if isinstance(params, dict):
        token = str(params.get('token') or '').strip()
    if not token:
        token = (request.headers.get('X-Token') or '').strip()
    if not token:
        auth = (request.headers.get('Authorization') or '').strip()
        if auth.lower().startswith('bearer '):
            token = auth[7:].strip()
    return token


def token_row(token):
    """按 token 取出 useinfo 中的登录行（不做有效期判断）；找不到返回 None
    · 必须带 `empId`：WebSocket 握手 `_ws_auth()` 要靠它反查员工（HTTP 接口用 `_loginUserId` 再查）"""
    if not token:
        return None
    from db import query_one
    return query_one('SELECT `id`,`account`,`enabled`,`empId`,`token`,`tokenExpireTime` '
                     'FROM `useinfo` WHERE `token`=%s LIMIT 1', (token,))


def token_user(token):
    """按 token 反查启用状态、且**未过期**的登录用户；无效 / 停用 / 已过期返回 None"""
    row = token_row(token)
    if not row or int(row.get('enabled') or 0) != 1:
        return None
    expire = row.get('tokenExpireTime')
    if expire and expire <= datetime.datetime.now():
        return None
    return row


def require_login(params):
    """
    统一登录校验：**所有读写数据库的接口都必须带有效 token**，否则 401
      · 缺 token → 「缺少登录凭证（token），请先登录」
      · token 无效（不存在 / 已被新登录顶替 / 已退出）→ 「登录已失效，请重新登录」
      · token 超过有效期（默认 8 小时）→ 「登录已超时（有效期 8 小时），请重新登录」
      · 账号被停用 → 「账号已停用，请重新登录」
    通过后把 _token / _loginUserId 放进参数（业务字段白名单会过滤掉，不影响入库）
    """
    token = token_of(params)
    if not token:
        raise BizError('缺少登录凭证（token），请先登录', 401)
    row = token_row(token)
    if not row:
        raise BizError('登录已失效，请重新登录', 401)
    if int(row.get('enabled') or 0) != 1:
        raise BizError('账号已停用，请重新登录', 401)
    expire = row.get('tokenExpireTime')
    if expire and expire <= datetime.datetime.now():
        # 过期即作废，避免脏 token 继续被反查（失败也不影响 401 返回）
        try:
            from db import execute
            execute('UPDATE `useinfo` SET `token`=NULL, `tokenExpireTime`=NULL '
                    'WHERE `token`=%s AND (`tokenExpireTime` IS NULL OR `tokenExpireTime`<=NOW())', (token,))
        except Exception:
            pass
        raise BizError('登录已超时（有效期 %s 小时），请重新登录' % token_ttl_text(), 401)
    if isinstance(params, dict):
        params['_token'] = token
        params['_loginUserId'] = row['id']
    return row


def token_ttl_text():
    """令牌有效期的人话描述：8 → 「8」，0.5 → 「0.5」"""
    hours = TOKEN_TTL_HOURS
    return ('%d' % hours) if float(hours).is_integer() else ('%g' % hours)


def collect_params():
    """GET 取 query string；POST 优先取 JSON body，其次表单；
    统一补一个 _clientIp（登录时写入 useinfo.lastLoginIp，业务表按字段白名单过滤，不受影响）"""
    if request.method == 'GET':
        data = request.args.to_dict()
    else:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            data = request.form.to_dict()
    if isinstance(data, dict):
        forwarded = (request.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
        data['_clientIp'] = forwarded or (request.remote_addr or '')
        data['_userAgent'] = (request.headers.get('User-Agent') or '')[:200]
    return data


@app.before_request
def bind_site_origin():
    """记录本次请求访问的基址（如 http://192.168.1.20:8808），供通知邮件拼绝对链接。

    站内消息用相对路径，不依赖它；邮件必须有绝对地址，而绝对地址只能来自
    「浏览器实际用的地址」或 PUBLIC_BASE_URL —— 绝不再用 SERVER_HOST（那是服务端
    监听地址，默认 127.0.0.1，部署后收件人点开就是自己的电脑）。
    """
    try:
        linkctx.set_origin(request.url_root)
    except Exception:
        linkctx.clear_origin()


@app.teardown_request
def unbind_site_origin(exc=None):
    """请求结束就清掉基址：线程池复用线程时，下一个请求/后台任务不会捡到上一个请求的地址"""
    try:
        linkctx.clear_origin()
    except Exception:
        pass


@app.after_request
def add_cors(resp):
    origin = request.headers.get('Origin')
    # file:// 直接打开页面时 Origin 为字符串 "null"，此时必须回以 * 才能放行跨域
    resp.headers['Access-Control-Allow-Origin'] = '*' if (not origin or origin == 'null') else origin
    resp.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    resp.headers['Access-Control-Allow-Credentials'] = 'true'
    ctype = resp.headers.get('Content-Type', '')
    if 'application/json' in ctype and 'charset' not in ctype.lower():
        resp.headers['Content-Type'] = 'application/json; charset=utf-8'
    return resp


@app.route('/')
def index():
    return redirect('/main.html')


@app.route('/api/health')
def health():
    """健康检查：带有效 token 时返回各表条数（会查库）；未登录只回服务存活（不碰数据库）"""
    from db import query_one
    params = collect_params()
    if not token_user(token_of(params)):
        return ok({'service': 'ok', 'authenticated': False}, '服务正常')
    try:
        menu_count = query_one('SELECT COUNT(*) AS cnt FROM `menuinfros`')['cnt']
        group_count = query_one('SELECT COUNT(*) AS cnt FROM `menugroupinfos`')['cnt']
        group_item_count = query_one('SELECT COUNT(*) AS cnt FROM `menugroupitemset`')['cnt']
        try:
            org_count = query_one('SELECT COUNT(*) AS cnt FROM `OrganizationStructure`')['cnt']
        except Exception:
            org_count = 0
        try:
            emp_count = query_one('SELECT COUNT(*) AS cnt FROM `empinfos`')['cnt']
        except Exception:
            emp_count = 0
        try:
            dpt_mgr_count = query_one('SELECT COUNT(*) AS cnt FROM `dptmgrset`')['cnt']
        except Exception:
            dpt_mgr_count = 0
        try:
            role_count = query_one('SELECT COUNT(*) AS cnt FROM `usergroup`')['cnt']
        except Exception:
            role_count = 0
        try:
            role_power_count = query_one('SELECT COUNT(*) AS cnt FROM `usergrouppowerset`')['cnt']
        except Exception:
            role_power_count = 0
        try:
            page_op_btn_count = query_one('SELECT COUNT(*) AS cnt FROM `pageopbtn`')['cnt']
        except Exception:
            page_op_btn_count = 0
        try:
            role_btn_count = query_one('SELECT COUNT(*) AS cnt FROM `usergrouppagebtnset`')['cnt']
        except Exception:
            role_btn_count = 0
        try:
            emp_archive_count = query_one('SELECT COUNT(*) AS cnt FROM `empinfoarchive`')['cnt']
            emp_archive_batch_count = query_one(
                'SELECT COUNT(DISTINCT `batchId`) AS cnt FROM `empinfoarchive`')['cnt']
        except Exception:
            emp_archive_count = 0
            emp_archive_batch_count = 0
        try:
            user_count = query_one('SELECT COUNT(*) AS cnt FROM `useinfo`')['cnt']
            user_role_count = query_one('SELECT COUNT(*) AS cnt FROM `useinforoleset`')['cnt']
        except Exception:
            user_count = 0
            user_role_count = 0
        try:
            db_info_count = query_one('SELECT COUNT(*) AS cnt FROM `dbinfomgr`')['cnt']
        except Exception:
            db_info_count = 0
        try:
            report_count = query_one('SELECT COUNT(*) AS cnt FROM `reportinfos`')['cnt']
        except Exception:
            report_count = 0
        try:
            project_count = query_one('SELECT COUNT(*) AS cnt FROM `projectinfos`')['cnt']
            project_file_count = query_one('SELECT COUNT(*) AS cnt FROM `projectfiles`')['cnt']
        except Exception:
            project_count = 0
            project_file_count = 0
        try:
            project_dir_count = query_one('SELECT COUNT(*) AS cnt FROM `projectdirs`')['cnt']
        except Exception:      # 老库没跑 db/projectdirs.sql 时不影响其它计数
            project_dir_count = 0
        try:
            work_plan_count = query_one('SELECT COUNT(*) AS cnt FROM `workplans`')['cnt']
            work_plan_task_count = query_one('SELECT COUNT(*) AS cnt FROM `workplantasks`')['cnt']
            work_plan_order_count = query_one('SELECT COUNT(*) AS cnt FROM `workplanorders`')['cnt']
        except Exception:      # 老库没跑 db/workplan.sql 时不影响其它计数
            work_plan_count = 0
            work_plan_task_count = 0
            work_plan_order_count = 0
        try:
            sys_dict_count = query_one('SELECT COUNT(*) AS cnt FROM `sysdict`')['cnt']
            sys_dict_item_count = query_one('SELECT COUNT(*) AS cnt FROM `sysdictitems`')['cnt']
            sys_para_count = query_one('SELECT COUNT(*) AS cnt FROM `syspara`')['cnt']
        except Exception:
            sys_dict_count = 0
            sys_dict_item_count = 0
            sys_para_count = 0
        try:
            service_email_count = query_one('SELECT COUNT(*) AS cnt FROM `serviceemail`')['cnt']
            mail_count = query_one('SELECT COUNT(*) AS cnt FROM `serviceemailmsg`')['cnt']
            mail_unread_count = query_one(
                "SELECT COUNT(*) AS cnt FROM `serviceemailmsg` WHERE `direction`='in' AND `seen`=0")['cnt']
        except Exception:
            service_email_count = 0
            mail_count = 0
            mail_unread_count = 0
        try:
            emp_mailbox_count = query_one('SELECT COUNT(*) AS cnt FROM `empemailbox`')['cnt']
            emp_mail_count = query_one('SELECT COUNT(*) AS cnt FROM `empmailmsg`')['cnt']
        except Exception:      # 老库没跑 db/emp-mail.sql 时不影响其它计数
            emp_mailbox_count = 0
            emp_mail_count = 0
        try:
            emp_msg_count = query_one('SELECT COUNT(*) AS cnt FROM `emp_msgs`')['cnt']
            emp_msg_unread_count = query_one(
                'SELECT COUNT(*) AS cnt FROM `emp_msgs` WHERE `readStatus`=0')['cnt']
        except Exception:      # 老库没跑 db/emp-message.sql 时不影响其它计数
            emp_msg_count = 0
            emp_msg_unread_count = 0
        return ok({'service': 'ok', 'authenticated': True,
                   'menuCount': menu_count, 'groupCount': group_count,
                   'groupItemCount': group_item_count, 'orgCount': org_count,
                   'empCount': emp_count, 'dptMgrCount': dpt_mgr_count,
                   'roleCount': role_count, 'rolePowerCount': role_power_count,
                   'pageOpBtnCount': page_op_btn_count, 'roleBtnCount': role_btn_count,
                   'empArchiveCount': emp_archive_count, 'empArchiveBatchCount': emp_archive_batch_count,
                   'userCount': user_count, 'userRoleCount': user_role_count,
                   'serviceEmailCount': service_email_count, 'mailCount': mail_count,
                   'mailUnreadCount': mail_unread_count,
                   'empMailboxCount': emp_mailbox_count, 'empMailCount': emp_mail_count,
                   'empMsgCount': emp_msg_count, 'empMsgUnreadCount': emp_msg_unread_count,
                   'dbInfoCount': db_info_count,
                   'reportCount': report_count,
                   'projectCount': project_count, 'projectFileCount': project_file_count,
                   'projectDirCount': project_dir_count,
                   'workPlanCount': work_plan_count, 'workPlanTaskCount': work_plan_task_count,
                   'workPlanOrderCount': work_plan_order_count,
                   'sysDictCount': sys_dict_count, 'sysDictItemCount': sys_dict_item_count,
                   'sysParaCount': sys_para_count},
                  '服务正常')
    except Exception as exc:
        return fail('数据库不可用：%s' % exc)


@app.route('/api/nav', methods=['GET', 'OPTIONS'])
def nav():
    """左侧导航：按菜单组 / 菜单项 / 菜单组项目设置实时生成，
    并按当前登录用户所属角色的菜单权限过滤（参数 token=登录令牌；调试可用 roleId 指定角色）"""
    if request.method == 'OPTIONS':
        return ('', 204)
    params = collect_params()
    try:
        require_login(params)             # 导航同样要求登录（roleId 只是「按角色预览」的附加过滤）
        from service import build_nav
        return ok(build_nav(params))
    except BizError as exc:          # 未登录 / token 失效（401）等业务异常
        return fail(exc.message, exc.code)
    except Exception:
        traceback.print_exc()
        return fail('服务异常：%s' % traceback.format_exc(limit=1).strip().splitlines()[-1])


@app.route('/api/report/export', methods=['POST', 'OPTIONS'])
def report_export():
    """数据中心 · 报表导出（Excel / PDF）：返回二进制文件，导出的是**全部查询结果**

    单独开一条路由（而不是走通用的 /api/<biz>/<action>），因为这里要返回文件流而不是 JSON。
    Werkzeug 的静态规则优先于 /api/<biz>/<action>，所以不会被通用路由截走。
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    params = collect_params()
    try:
        require_login(params)
        from service import report_service
        result = report_service.export_file(params)
        resp = app.response_class(result['content'], mimetype=result['mimetype'])
        name = result['filename']
        ascii_name = name.encode('ascii', 'ignore').decode('ascii') or 'report'
        resp.headers['Content-Disposition'] = \
            'attachment; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, quote(name))
        resp.headers['Content-Length'] = str(len(result['content']))
        resp.headers['Cache-Control'] = 'no-store'
        # 把行数 / 是否截断带给前端（不占响应体，读 header 即可）
        resp.headers['X-Report-Row-Count'] = str(result['rowCount'])
        resp.headers['X-Report-Truncated'] = '1' if result['truncated'] else '0'
        return resp
    except BizError as exc:
        return fail(exc.message, exc.code)
    except Exception:
        traceback.print_exc()
        return fail('导出失败：%s' % traceback.format_exc(limit=1).strip().splitlines()[-1])


@app.route('/api/preview/pdf', methods=['GET', 'OPTIONS'])
def preview_pdf():
    """项目文件在线预览（Word / PowerPoint → PDF）：返回二进制文件流。

    单独开一条路由（而不是走通用的 /api/<biz>/<action>），因为要返回文件流而不是 JSON。
    业务校验（可见性 / 启停 / 扩展名）都在 ProjectFileService.preview_pdf 里。
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    params = collect_params()
    try:
        require_login(params)
        from service import project_file_service
        result = project_file_service.preview_pdf(params)
        resp = app.response_class(result['content'], mimetype='application/pdf')
        name = result['filename']
        ascii_name = name.encode('ascii', 'ignore').decode('ascii') or 'preview'
        resp.headers['Content-Disposition'] = \
            'inline; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, quote(name))
        resp.headers['Content-Length'] = str(len(result['content']))
        resp.headers['Cache-Control'] = 'no-store'
        return resp
    except BizError as exc:
        return fail(exc.message, exc.code)
    except Exception:
        traceback.print_exc()
        return fail('预览服务异常：%s' % traceback.format_exc(limit=1).strip().splitlines()[-1])


@app.route('/api/appschema/exportdocs', methods=['GET', 'POST', 'OPTIONS'])
def appschema_export_docs():
    """应用结构 · 导出表结构文档（Excel / Word）：返回文件流。

    单独开一条路由（不走通用 /api/<biz>/<action>），因为要下发文件而不是 JSON；
    取的是设计态（本地表），不会去连真实数据库。
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    params = collect_params()
    try:
        require_login(params)
        from service import app_schema_service
        result = app_schema_service.export_docs(params)
        resp = app.response_class(result['content'], mimetype=result['mimetype'])
        name = result['filename']
        ascii_name = name.encode('ascii', 'ignore').decode('ascii') or ('app-schema.' + result['format'])
        resp.headers['Content-Disposition'] = \
            'attachment; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, quote(name))
        resp.headers['Content-Length'] = str(len(result['content']))
        resp.headers['Cache-Control'] = 'no-store'
        # 表数 / 字段数给前端提示用（不占响应体）
        resp.headers['X-Table-Count'] = str(result.get('count', 0))
        resp.headers['X-Col-Count'] = str(result.get('colCount', 0))
        return resp
    except BizError as exc:
        return fail(exc.message, exc.code)
    except Exception:
        traceback.print_exc()
        return fail('导出失败：%s' % traceback.format_exc(limit=1).strip().splitlines()[-1])


@app.route('/api/workplan/exportorders', methods=['GET', 'OPTIONS'])
def workplan_export_orders():
    """计划工单导出 Excel（当前筛选条件，全部行）：返回 xlsx 二进制流。"""
    if request.method == 'OPTIONS':
        return ('', 204)
    params = collect_params()
    try:
        require_login(params)
        from service import work_plan_service
        result = work_plan_service.export_orders(params)
        resp = app.response_class(result['content'], mimetype=result['mimetype'])
        name = result['filename']
        ascii_name = name.encode('ascii', 'ignore').decode('ascii') or 'workplan-orders.xlsx'
        resp.headers['Content-Disposition'] = \
            'attachment; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, quote(name))
        resp.headers['Content-Length'] = str(len(result['content']))
        resp.headers['Cache-Control'] = 'no-store'
        resp.headers['X-Row-Count'] = str(result.get('rowCount', 0))
        return resp
    except BizError as exc:
        return fail(exc.message, exc.code)
    except Exception:
        traceback.print_exc()
        return fail('导出失败：%s' % traceback.format_exc(limit=1).strip().splitlines()[-1])


@app.route('/api/workload/export', methods=['GET', 'OPTIONS'])
def workload_export():
    """员工工作量统计导出 Excel（汇总 + 工单明细两个页签）：返回 xlsx 二进制流。"""
    if request.method == 'OPTIONS':
        return ('', 204)
    params = collect_params()
    try:
        require_login(params)
        from service import workload_service
        result = workload_service.export(params)
        resp = app.response_class(result['content'], mimetype=result['mimetype'])
        name = result['filename']
        ascii_name = name.encode('ascii', 'ignore').decode('ascii') or 'workload-report.xlsx'
        resp.headers['Content-Disposition'] = \
            'attachment; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, quote(name))
        resp.headers['Content-Length'] = str(len(result['content']))
        resp.headers['Cache-Control'] = 'no-store'
        resp.headers['X-Row-Count'] = str(result.get('rowCount', 0))
        return resp
    except BizError as exc:
        return fail(exc.message, exc.code)
    except Exception:
        traceback.print_exc()
        return fail('导出失败：%s' % traceback.format_exc(limit=1).strip().splitlines()[-1])


@app.route('/api/workplan/importtemplate', methods=['GET', 'OPTIONS'])
def workplan_import_template():
    """下载「工作计划 → 导入任务」模板：表头 + 单元格批注 + 下拉 + 填写说明，返回 xlsx 二进制流。

    单独开一条路由（而不是走通用 /api/<biz>/<action>），因为要返回文件流而不是 JSON；
    模板内容由 service.WorkPlanService.IMPORT_COLUMNS 生成，与解析共用同一份列定义。
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    params = collect_params()
    try:
        require_login(params)
        from service import work_plan_service
        result = work_plan_service.import_template(params)
        resp = app.response_class(result['content'], mimetype=result['mimetype'])
        name = result['filename']
        # ASCII 兜底名：中文名 encode('ascii','ignore') 会只剩「.xlsx」这种光秃秃的扩展名，
        # 老客户端/下载器会存成隐藏文件，所以剥完还得判断一下再回退到英文名。
        ascii_name = (name.encode('ascii', 'ignore').decode('ascii') or '').strip()
        if not ascii_name or ascii_name.startswith('.'):
            ascii_name = 'workplan-import-template.xlsx'
        resp.headers['Content-Disposition'] = \
            'attachment; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, quote(name))
        resp.headers['Content-Length'] = str(len(result['content']))
        resp.headers['Cache-Control'] = 'no-store'
        return resp
    except BizError as exc:
        return fail(exc.message, exc.code)
    except Exception:
        traceback.print_exc()
        return fail('模板生成失败：%s' % traceback.format_exc(limit=1).strip().splitlines()[-1])


@app.route('/api/workplan/execraw', methods=['GET', 'OPTIONS'])
def workplan_execraw():
    """执行记录附件原始文件流：图片 / PDF / 文本 / Office 组件预览都从这里取。

    单独开一条路由（返回二进制而不是 JSON），业务校验在 WorkPlanService.exec_raw：
    附件存在 → 关联计划可见 → 文件在 server/uploads/workplan/ 下。
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    params = collect_params()
    try:
        require_login(params)
        from service import work_plan_service
        result = work_plan_service.exec_raw(params)
        resp = app.response_class(result['content'], mimetype=result['contentType'])
        name = result['filename']
        ascii_name = name.encode('ascii', 'ignore').decode('ascii') or 'attachment'
        resp.headers['Content-Disposition'] = \
            'inline; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, quote(name))
        resp.headers['Content-Length'] = str(len(result['content']))
        resp.headers['Cache-Control'] = 'no-store'
        return resp
    except BizError as exc:
        return fail(exc.message, exc.code)
    except Exception:
        traceback.print_exc()
        return fail('附件读取失败：%s' % traceback.format_exc(limit=1).strip().splitlines()[-1])


@app.route('/api/workplan/execpdf', methods=['GET', 'OPTIONS'])
def workplan_execpdf():
    """执行记录附件里的 Word / PowerPoint → PDF（旧格式在线预览，复用项目文件的转换器）。"""
    if request.method == 'OPTIONS':
        return ('', 204)
    params = collect_params()
    try:
        require_login(params)
        from service import work_plan_service
        result = work_plan_service.exec_pdf(params)
        resp = app.response_class(result['content'], mimetype='application/pdf')
        name = result['filename']
        ascii_name = name.encode('ascii', 'ignore').decode('ascii') or 'preview'
        resp.headers['Content-Disposition'] = \
            'inline; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, quote(name))
        resp.headers['Content-Length'] = str(len(result['content']))
        resp.headers['Cache-Control'] = 'no-store'
        return resp
    except BizError as exc:
        return fail(exc.message, exc.code)
    except Exception:
        traceback.print_exc()
        return fail('预览服务异常：%s' % traceback.format_exc(limit=1).strip().splitlines()[-1])

@app.route('/api/mailattach/download', methods=['GET', 'OPTIONS'])
def mail_attach_download():
    """邮件附件下载（服务信箱 / 我的邮箱共用）：返回二进制流，文件名用表里的原始中文名。

    单独开一条路由（而不是走通用 /api/<biz>/<action>），因为要返回文件流而不是 JSON。
    · require_login 保证必须带有效 token；
    · empmail 来源在 service.mail_attach_content 里按 token 反查 empId 强隔离；
    · 只放行 data/mailattach/ 下自己写的文件，防目录穿越。
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    params = collect_params()
    try:
        require_login(params)
        from service import mail_attach_content
        result = mail_attach_content(params)
        resp = app.response_class(result['content'], mimetype=result['contentType'])
        name = result['name']
        # 附件名来自外部邮件，先剥掉引号 / 分号 / 路径符再放进 filename="..."，防响应头注入
        ascii_name = re.sub(r'[^A-Za-z0-9._-]', '_',
                            name.encode('ascii', 'ignore').decode('ascii')) or 'attachment'
        resp.headers['Content-Disposition'] = \
            'attachment; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, quote(name))
        resp.headers['Content-Length'] = str(len(result['content']))
        resp.headers['Cache-Control'] = 'no-store'
        return resp
    except BizError as exc:
        return fail(exc.message, exc.code)
    except Exception:
        traceback.print_exc()
        return fail('附件下载失败：%s' % traceback.format_exc(limit=1).strip().splitlines()[-1])


@app.route('/api/<biz>/<action>', methods=['GET', 'POST', 'OPTIONS'])
def api(biz, action):
    if request.method == 'OPTIONS':
        return ('', 204)
    service = SERVICES.get(biz)
    if service is None:
        return fail('接口不存在：/api/%s/%s' % (biz, action), 404)
    action_cfg = ACTIONS.get(action)
    if action_cfg is None:
        return fail('接口不存在：/api/%s/%s' % (biz, action), 404)
    method_name, allow_methods = action_cfg
    if request.method not in allow_methods:
        return fail('该接口仅支持 %s 请求' % '/'.join(allow_methods), 405)
    handler = getattr(service, method_name, None)
    if handler is None:     # 如 /api/menu/tree：菜单项没有层级
        return fail('接口不存在：/api/%s/%s' % (biz, action), 404)

    params = collect_params()
    try:
        if (biz, action) not in TOKEN_FREE_ACTIONS:
            require_login(params)         # 读写数据库前必须验证登录 token
        result = handler(params)
        return ok(result)
    except BizError as exc:
        return fail(exc.message, exc.code)
    except Exception:
        traceback.print_exc()
        return fail('服务异常：%s' % traceback.format_exc(limit=1).strip().splitlines()[-1])


@app.route('/<path:filename>')
def static_files(filename):
    """静态资源（HTML/CSS/JS）：禁止缓存，避免旧版本影响联调"""
    if filename.startswith('api/'):
        return fail('接口不存在：/%s' % filename, 404)
    full = os.path.join(WEB_ROOT, filename)
    if not os.path.isfile(full):
        return fail('资源不存在：%s' % filename, 404)
    resp = send_from_directory(WEB_ROOT, filename)
    if filename.endswith(('.html', '.js', '.css')):
        resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.errorhandler(404)
def handle_404(e):
    return fail('资源不存在', 404)


@app.errorhandler(500)
def handle_500(e):
    return fail('服务内部错误', 500)


# =====================================================================
# 站内消息 · WebSocket 实时通道（IM / WebQQ 风格）
# ---------------------------------------------------------------------
# 协议与 server/im_presence.py 的模块 docstring 保持一致。
# =====================================================================
def _ws_auth(token):
    """按 token 反查启用且未过期的登录用户，返回 (user_id, emp_id)；失败返回 (None, 0)"""
    if not token:
        return None, 0
    row = token_user(token)
    if not row:
        return None, 0
    emp_id = int(row.get('empId') or 0)
    if not emp_id:
        return None, 0
    return row['id'], emp_id


def _emp_brief(emp_id):
    """当前登录员工的基础信息（用于 serverHello 的 meInfo）"""
    try:
        row = query_one(
            'SELECT `id`,`nameCn`,`code`,`deptId`,`jobTitle`,`status` FROM `empinfos` WHERE `id`=%s',
            (emp_id,))
    except Exception:
        row = None
    if not row:
        return {'empId': emp_id, 'name': '员工' + str(emp_id), 'code': '', 'deptId': 0,
                'deptName': '', 'jobTitle': '', 'status': 0, 'avatarText': '?'}
    dname = ''
    try:
        drow = query_one('SELECT `nameCn` FROM `OrganizationStructure` WHERE `id`=%s',
                         (int(row.get('deptId') or 0),))
        dname = (drow.get('nameCn') or '') if drow else ''
    except Exception:
        dname = ''
    name = (row.get('nameCn') or '').strip() or ('员工' + str(emp_id))
    return {
        'empId': int(row['id']), 'name': name, 'code': row.get('code') or '',
        'deptId': int(row.get('deptId') or 0), 'deptName': dname,
        'jobTitle': row.get('jobTitle') or '', 'status': int(row.get('status') or 0),
        'avatarText': name[:1],
    }


@sock.route('/ws/msg')
def ws_msg(ws):
    """站内消息 WebSocket 主入口：
      · 鉴权（token 取 ?token= 查询参数，或首条 hello 消息）
      · 注册在线 → 广播上线 → 下发联系人快照（serverHello）
      · 主循环：drain 出站队列（本连接独占，避免多线程同 socket 发送）+ 处理 send/read/typing/ping
      · 断线：注销在线 → 广播下线
    """
    from flask import request as _req
    token = ''
    try:
        token = (_req.args.get('token') or '').strip()
    except Exception:
        token = ''
    user_id, emp_id = _ws_auth(token)

    # 没在 URL 带 token，等一条 hello（最多 10s）
    if not emp_id:
        try:
            first = ws.receive(timeout=10)
        except Exception:
            first = None
        token = ''
        if isinstance(first, str):
            try:
                hello = json.loads(first)
                if isinstance(hello, dict) and hello.get('type') == 'hello':
                    token = (hello.get('token') or '').strip()
            except Exception:
                token = ''
        user_id, emp_id = _ws_auth(token)

    if not emp_id:
        try:
            ws.send(dumps({'type': 'authFail', 'message': '登录已失效，请重新登录'}))
        except Exception:
            pass
        try:
            ws.close()
        except Exception:
            pass
        return

    # 注册在线
    conn = Conn(ws, emp_id)
    presence.register(emp_id, conn)
    # 通知其它在线员工：我上线了
    presence.broadcast(dumps({'type': 'presence', 'empId': emp_id, 'online': True}),
                       exclude_emp_id=emp_id)

    # 下发联系人快照（含在线态、未读、最近消息）+ 我加入的群（群未读 / 最近一条）
    try:
        snap = emp_message_service.contacts({'_loginUserId': user_id})
        contact_list = snap.get('list', [])
        online_count = snap.get('onlineCount', 0)
    except Exception:
        contact_list, online_count = [], presence.online_count()
    try:
        groups = emp_message_service.groups({'_loginUserId': user_id}).get('list', [])
    except Exception:
        groups = []

    try:
        ws.send(dumps({
            'type': 'serverHello',
            'me': emp_id,
            'meInfo': _emp_brief(emp_id),
            'contacts': contact_list,
            'groups': groups,
            'onlineCount': online_count,
        }))
    except Exception:
        presence.unregister(emp_id, conn)
        return

    try:
        while True:
            # 1) drain 出站队列：本连接自己消费，保持单线程安全
            while not conn.out_q.empty():
                try:
                    item = conn.out_q.get_nowait()
                except Exception:
                    break
                try:
                    ws.send(item)
                except Exception:
                    raise

            # 2) 心跳阻塞等待入站（超时后回到 1 继续 drain 出站队列）
            try:
                raw = ws.receive(timeout=HEARTBEAT)
            except Exception:
                break
            if raw is None:
                continue

            # 3) 解析并分发
            try:
                msg = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            t = msg.get('type')
            if t == 'ping':
                try:
                    ws.send(dumps({'type': 'pong'}))
                except Exception:
                    break
            elif t == 'send':
                _ws_on_send(conn, emp_id, msg)
            elif t == 'read':
                _ws_on_read(conn, emp_id, msg)
            elif t == 'typing':
                _ws_on_typing(conn, emp_id, msg)
            # 'hello' 重复 / 未知类型：忽略
    except Exception:
        pass
    finally:
        presence.unregister(emp_id, conn)
        # 通知其它人：我下线了
        try:
            presence.broadcast(dumps({'type': 'offline', 'empId': emp_id, 'online': False}),
                               exclude_emp_id=emp_id)
        except Exception:
            pass


def _ws_on_send(conn, emp_id, msg):
    """发送：落库 → 推送给收件人（私聊）或全体群成员（群聊）→ 给发件人回执（ack，带 tempId）。

    · 私聊：to = 对方 empId；
    · 群聊：groupId 非空（此时忽略 to，后端按群成员推送，自己不需要收到自己的推送）；
    · 媒体：msgType（text/image/file）+ attachId（必须是本人上传的附件）。
    """
    to = int(msg.get('to') or 0)
    gid = str(msg.get('groupId') or '').strip()
    content = msg.get('content')
    msg_type = str(msg.get('msgType') or 'text').strip().lower() or 'text'
    attach_id = str(msg.get('attachId') or '').strip()
    content_html = str(msg.get('contentHtml') or '')
    at_emp_ids = msg.get('atEmpIds') or ''
    if not gid and not to:
        enqueue(conn, {'type': 'ack', 'tempId': msg.get('tempId'), 'error': '收件人或群无效'})
        return
    if (content is None or not str(content).strip()) and not content_html.strip() and not attach_id:
        enqueue(conn, {'type': 'ack', 'tempId': msg.get('tempId'), 'error': '消息内容不能为空'})
        return
    try:
        created = emp_message_service.persist_send(
            emp_id, [to] if not gid else [0], content or '',
            msg.get('title', ''), msg_type, attach_id, gid,
            content_html=content_html, at_emp_ids=at_emp_ids)
    except BizError as exc:
        enqueue(conn, {'type': 'ack', 'tempId': msg.get('tempId'), 'error': exc.message})
        return
    except Exception as exc:
        enqueue(conn, {'type': 'ack', 'tempId': msg.get('tempId'), 'error': '发送失败：%s' % exc})
        return
    for c in created:
        frame = {
            'type': 'msg', 'id': c['id'], 'senderId': c['senderId'],
            'receiverId': c['receiverId'], 'senderName': c.get('senderName', ''),
            'content': c['content'], 'contentHtml': c.get('contentHtml') or '',
            'atEmpIds': c.get('atEmpIds') or '',
            'sendTime': c['sendTime'], 'title': c['title'],
            'msgType': c.get('msgType') or 'text', 'attachId': c.get('attachId') or '',
            'attach': c.get('attach') or None, 'groupId': c.get('groupId') or '',
        }
        if gid:
            # 群消息：推给除自己以外的全体成员（在线的才发）
            for member_id in emp_message_service.group_member_ids(gid):
                if member_id == emp_id:
                    continue
                presence.push_to(member_id, dumps(frame))
        else:
            presence.push_to(to, dumps(frame))
    first = created[0]
    enqueue(conn, {
        'type': 'ack', 'id': first['id'], 'senderId': first['senderId'],
        'receiverId': first['receiverId'], 'content': first['content'],
        'contentHtml': first.get('contentHtml') or '',
        'atEmpIds': first.get('atEmpIds') or '',
        'sendTime': first['sendTime'], 'title': first['title'], 'tempId': msg.get('tempId'),
        'msgType': first.get('msgType') or 'text', 'attachId': first.get('attachId') or '',
        'attach': first.get('attach') or None, 'groupId': first.get('groupId') or '',
    })


def _ws_on_read(conn, emp_id, msg):
    """已读：把对方发给我的消息标记已读，并通知对方（read 回执）"""
    peer = int(msg.get('peerId') or 0)
    if not peer:
        return
    try:
        emp_message_service.mark_peer_raw(emp_id, peer)
    except Exception:
        pass
    presence.push_to(peer, dumps({'type': 'read', 'peerId': emp_id}))


def _ws_on_typing(conn, emp_id, msg):
    """输入中：透传给对方"""
    to = int(msg.get('to') or 0)
    if not to:
        return
    presence.push_to(to, dumps({'type': 'typing', 'from': emp_id, 'on': bool(msg.get('on'))}))


def serve():
    """启动 HTTP 服务。

    单独抽成函数是为了安装包：后端发布时 .py 全部编译成 .pyc（没有 __main__ 可挂），
    由 app/server/main.py 这个唯一的源码启动器 `import app` 后调用本函数。
    直接 `python app.py` 运行时行为与以前完全一致。
    """
    print('Menu admin server: http://%s:%d/' % (SERVER_HOST, SERVER_PORT))
    print('Web root: %s' % WEB_ROOT)
    # 服务信箱自动收件：后台线程按 config.MAIL_SYNC_MINUTES 周期拉取收件箱（可用环境变量关闭）
    try:
        from service import start_mail_worker
        start_mail_worker()
    except Exception as exc:
        print('自动收件线程启动失败（不影响主服务）：%s' % exc)
    # 工作计划变更邮件队列：保存只入队，由这个线程重试发送（避免保存请求等 SMTP 超时）
    try:
        from service import start_workplan_mail_worker
        start_workplan_mail_worker()
    except Exception as exc:
        print('工作计划通知队列线程启动失败（不影响主服务）：%s' % exc)
    app.run(host=SERVER_HOST, port=SERVER_PORT, debug=False, threaded=True)


if __name__ == '__main__':
    serve()
