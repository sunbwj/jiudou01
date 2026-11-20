# -*- coding: utf-8 -*-
"""配置：数据库连接与 HTTP 服务参数

取值优先级（从高到低）：
  1. 环境变量（部署/调试时临时覆盖）
  2. 外置配置文件 conf/settings.json（安装包写这个文件，改端口/换库不用动代码）
  3. 下面代码里的默认值

为什么要有第 2 层：后端代码在安装包里是编译成 .pyc 发布的（没有 .py），
如果配置只写死在代码里，客户想改端口就得重新编译发版。所以凡是「会变」的参数
都走 settings.json，pyc 里只留读取逻辑。

settings.json 为扁平结构，键名与下面的环境变量名完全一致，例如：
  {"DB_HOST": "127.0.0.1", "DB_PORT": 3307, "SERVER_PORT": 8808}
以 _ 开头的键会被忽略（方便写注释）。文件不存在或用不了时，行为与老版本完全一致。
"""
import io
import json
import os

SETTINGS_FILE = os.getenv('APP_SETTINGS') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'conf', 'settings.json')


def _load_settings():
    """读外置配置；任何异常都静默回落到默认值，绝不能因为配置文件坏了起不来"""
    try:
        # utf-8-sig：兼容用记事本另存出来的带 BOM 的 json
        with io.open(SETTINGS_FILE, 'r', encoding='utf-8-sig') as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


_SETTINGS = _load_settings()


def _get(name, default):
    value = os.environ.get(name)
    if value not in (None, ''):
        return value
    value = _SETTINGS.get(name)
    if value not in (None, ''):
        return value
    return default


def _int(name, default):
    try:
        return int(str(_get(name, default)).strip())
    except (TypeError, ValueError):
        return int(default)


def _float(name, default):
    try:
        return float(str(_get(name, default)).strip())
    except (TypeError, ValueError):
        return float(default)


DB_CONFIG = {
    'host': _get('DB_HOST', 'localhost'),
    'port': _int('DB_PORT', '3306'),
    'user': _get('DB_USER', 'sa'),
    'password': _get('DB_PASSWORD', 'roger2019'),
    'database': _get('DB_NAME', 'rogerorm'),
    'charset': 'utf8mb4',
    'autocommit': True,
}

SERVER_HOST = _get('SERVER_HOST', '127.0.0.1')
SERVER_PORT = _int('SERVER_PORT', '8808')

# 通知邮件里链接的对外基址，形如 http://192.168.1.20:8808 或 https://jiudou.example.com
# 留空：按收件人当次访问的地址（request.url_root）自动推，部署后基本不用配。
# 只有在「后端跑在内网、用户从外网/反向代理进来」时才需要写死对外地址。
PUBLIC_BASE_URL = _get('PUBLIC_BASE_URL', '')

# 登录令牌（token）有效期：默认 8 小时，可用 TOKEN_TTL_HOURS 覆盖（支持小数，如 0.5 = 30 分钟）
TOKEN_TTL_HOURS = _float('TOKEN_TTL_HOURS', '8')
TOKEN_TTL_SECONDS = int(round(TOKEN_TTL_HOURS * 3600))

# ------------------------------------------------------------ 服务信箱 / 邮箱助手 ------------------------------------------------------------
# 服务信箱密码（邮箱授权码）在库里加密保存；生产环境建议用环境变量注入独立密钥
MAIL_SECRET = _get('MAIL_SECRET', 'jiudou-service-email-2026')
# 网络超时（秒）：收件 / 发件 / 连接测试共用，避免邮箱不可达时请求一直挂住
MAIL_TIMEOUT = _int('MAIL_TIMEOUT', '15')
# 每次自动收件最多拉取多少封（按 UID 取最新的 N 封）
MAIL_FETCH_LIMIT = _int('MAIL_FETCH_LIMIT', '30')
# 自动收件间隔（分钟）：0 表示关闭后台自动收件（仍可手动点「收件」）
MAIL_SYNC_MINUTES = _int('MAIL_SYNC_MINUTES', '5')
# 服务启动后首次自动收件的延迟（秒）
MAIL_SYNC_DELAY = _int('MAIL_SYNC_DELAY', '20')
# 是否启用后台自动收件线程（联调 / 单测可置 0）
MAIL_AUTO_SYNC = _int('MAIL_AUTO_SYNC', '1')
# 写邮件附件：单封邮件最多几个附件 / 单个最大 MB / 合计最大 MB（前端 api 与后端 service 用同一套限制）
MAIL_MAX_ATTACHMENTS = _int('MAIL_MAX_ATTACHMENTS', '5')
MAIL_MAX_ATTACH_MB = _int('MAIL_MAX_ATTACH_MB', '10')
MAIL_MAX_TOTAL_MB = _int('MAIL_MAX_TOTAL_MB', '20')
# 收件附件落盘：单个 / 单封合计超过上限时只登记名称与大小，不保存内容（下载列表里标「未保存」）
MAIL_INBOX_ATTACH_MB = _int('MAIL_INBOX_ATTACH_MB', '10')
MAIL_INBOX_TOTAL_MB = _int('MAIL_INBOX_TOTAL_MB', '20')

# ------------------------------------------------------------ 数据中心（数据库连接 / 结构扫描） ------------------------------------------------------------
# 连接密码加密用的密钥（生产环境建议用环境变量注入；换掉后旧密文需要重新录入）
DBINFO_SECRET = _get('DBINFO_SECRET', 'jiudou-dbinfo-2026')
# 连库超时（秒）：扫描失败要尽快返回，不能让页面一直转圈
DBINFO_TIMEOUT = _int('DBINFO_TIMEOUT', '8')
# 读写 / 单次查询超时（秒）：大库扫描（几百张表逐张读 SHOW CREATE）、整库比对与慢查询都要留足时间，
# 否则驱动会在扫到一半时把连接掐掉，页面只看到「连接已断开」。
# 这是**单条语句**的超时（不是整次请求）：整个扫描 / 比对由前端 api.js 的 scanTimeout（30 分钟）兜底。
# 原来 120 秒在超大表读定义、跨库比对时仍会误杀，放宽到 300 秒。
DBINFO_READ_TIMEOUT = _int('DBINFO_READ_TIMEOUT', '300')
# 单次扫描最多返回多少条（防止一个超大实例把接口拖死）
DBINFO_MAX_DATABASES = _int('DBINFO_MAX_DATABASES', '200')
DBINFO_MAX_TABLES = _int('DBINFO_MAX_TABLES', '2000')
DBINFO_MAX_COLUMNS = _int('DBINFO_MAX_COLUMNS', '500')
# SQL 工作台：单次查询最多返回多少行（超出会截断并给出提示，避免把大表整个拉到浏览器）
DBINFO_SQL_MAX_ROWS = _int('DBINFO_SQL_MAX_ROWS', '200')

# ------------------------------------------------------------ 数据中心（报表设计器 / 报表信息） ------------------------------------------------------------
# 预览 / 调用时一次最多返回多少行（报表预览只看效果，不做大数据量导出）
REPORT_PREVIEW_ROWS = _int('REPORT_PREVIEW_ROWS', '500')
# 打印 / 导出（Excel、PDF）取「全部查询结果」时的行数上限：
# 预览只取 500 行图快，打印与导出会按这个上限重新查一次，尽量把整份结果都带上
REPORT_EXPORT_ROWS = _int('REPORT_EXPORT_ROWS', '20000')
# 单张报表最多允许定义多少个参数 / 多少列（防止画布被拖爆）
REPORT_MAX_PARAMS = _int('REPORT_MAX_PARAMS', '20')
REPORT_MAX_COLUMNS = _int('REPORT_MAX_COLUMNS', '60')
# 报表 SQL 最大字符数
REPORT_SQL_MAX_CHARS = _int('REPORT_SQL_MAX_CHARS', '20000')
