# -*- coding: utf-8 -*-
"""
数据中心：数据库连接与结构扫描（只读）
------------------------------------------------------------
· 连接信息来自 `dbinfomgr` 表（host / port / dbName / username / password / charset / extraParams）；
· 扫描只用系统元数据（MySQL 的 information_schema、SQLite 的 sqlite_master / PRAGMA、
  PostgreSQL 的 pg_catalog / information_schema、SQL Server 的 INFORMATION_SCHEMA、Oracle 的 ALL_* 视图），
  **不碰任何业务数据**，也不做任何写操作；
· 本机验证过的类型：MySQL / MariaDB（PyMySQL）、SQLite（标准库 sqlite3）、
  Oracle（python-oracledb **瘦模式**：纯 Python，不用装 Oracle Instant Client）、
  SQL Server（pymssql，wheel 自带 FreeTDS，不用另装客户端）；
  PostgreSQL 走同一套接口，但需要先安装驱动（psycopg2），
  缺驱动时抛 ConnError 给出「装什么」的明确提示，而不是一堆堆栈；
· 密码加密：`enc:v1:` + XOR 流 + base64（密钥取 config.DBINFO_SECRET），接口只回掩码。
"""
import base64
import datetime
import decimal
import hashlib
import json
import math
import os
import re
import sqlite3
import time

import config


class ConnError(Exception):
    """连接 / 扫描异常：message 直接展示给用户"""

    def __init__(self, message):
        super(ConnError, self).__init__(message)
        self.message = message


# ---------------------------------------------------------------- 数据库类型 ----------------------------------------------------------------
# hasFile=True 表示用文件而不是 主机:端口 连接（SQLite）
DB_TYPES = [
    {'value': 'mysql', 'label': 'MySQL', 'port': 3306, 'hasFile': False, 'driver': 'pymysql'},
    {'value': 'mariadb', 'label': 'MariaDB', 'port': 3306, 'hasFile': False, 'driver': 'pymysql'},
    {'value': 'postgresql', 'label': 'PostgreSQL', 'port': 5432, 'hasFile': False, 'driver': 'psycopg2'},
    {'value': 'oracle', 'label': 'Oracle', 'port': 1521, 'hasFile': False, 'driver': 'oracledb'},
    {'value': 'sqlserver', 'label': 'SQL Server', 'port': 1433, 'hasFile': False, 'driver': 'pymssql'},
    {'value': 'sqlite', 'label': 'SQLite', 'port': 0, 'hasFile': True, 'driver': 'sqlite3'},
]
DB_TYPE_MAP = {one['value']: one for one in DB_TYPES}
# MySQL 自带的系统库：列表里标注出来（默认排在最后）
MYSQL_SYSTEM_DBS = ('information_schema', 'mysql', 'performance_schema', 'sys')


def type_options():
    """下拉选项：值 / 中文名 / 默认端口 / 是否文件型（SQLite）"""
    return [{'value': one['value'], 'label': one['label'], 'port': one['port'],
             'hasFile': one['hasFile']} for one in DB_TYPES]


def type_label(db_type):
    one = DB_TYPE_MAP.get(str(db_type or '').lower())
    return one['label'] if one else str(db_type or '')


def default_port(db_type):
    one = DB_TYPE_MAP.get(str(db_type or '').lower())
    return one['port'] if one else 3306


def is_known_type(db_type):
    return str(db_type or '').lower() in DB_TYPE_MAP


def is_file_type(db_type):
    one = DB_TYPE_MAP.get(str(db_type or '').lower())
    return bool(one and one['hasFile'])


# ---------------------------------------------------------------- 密码加解密 ----------------------------------------------------------------
_MAGIC = 'enc:v1:'


def _key():
    return hashlib.sha256(('jiudou-dbinfo|' + str(config.DBINFO_SECRET)).encode('utf-8')).digest()


def encrypt_secret(text):
    text = '' if text is None else str(text)
    if not text:
        return ''
    key = _key()
    raw = text.encode('utf-8')
    out = bytearray(len(raw))
    for i, byte in enumerate(raw):
        out[i] = byte ^ key[i % len(key)]
    return _MAGIC + base64.b64encode(bytes(out)).decode('ascii')


def decrypt_secret(text):
    text = '' if text is None else str(text)
    if not text:
        return ''
    if not text.startswith(_MAGIC):        # 兼容历史明文
        return text
    try:
        raw = base64.b64decode(text[len(_MAGIC):].encode('ascii'))
    except Exception:
        return ''
    key = _key()
    out = bytearray(len(raw))
    for i, byte in enumerate(raw):
        out[i] = byte ^ key[i % len(key)]
    try:
        return bytes(out).decode('utf-8')
    except Exception:
        return ''


# ---------------------------------------------------------------- 连接参数整理 ----------------------------------------------------------------
def _extra_kv(text):
    """'a=1&b=2' → {'a': '1', 'b': '2'}（容错：忽略空项 / 无等号项）"""
    out = {}
    for part in str(text or '').replace(';', '&').split('&'):
        part = part.strip()
        if not part or '=' not in part:
            continue
        key, _, value = part.partition('=')
        key, value = key.strip(), value.strip()
        if key:
            out[key] = value
    return out


def _int_or(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _clean_exc(exc):
    """异常整理成一句人话（去 bytes 包裹 / 压缩空白 / 截断）"""
    text = str(exc)
    text = text.replace("b'", '').replace('"', "'").strip("' ")
    text = text.replace('\\r\\n', ' ').replace('\\n', ' ')
    return ' '.join(text.split())[:220]


def _import(driver, label, package):
    try:
        return __import__(driver)
    except Exception:
        raise ConnError('未安装 %s 驱动（%s），暂时无法扫描这类数据库。'
                        '安装后即时生效：pip install %s' % (label, driver, package))


def _require(conf, key, label, db_type):
    value = str((conf or {}).get(key) or '').strip()
    if not value:
        raise ConnError('%s 的「%s」不能为空' % (type_label(db_type), label))
    return value


# ---------------------------------------------------------------- MySQL / MariaDB ----------------------------------------------------------------
def _mysql_connect(conf):
    pymysql = _import('pymysql', 'MySQL / MariaDB', 'pymysql')
    extra = _extra_kv(conf.get('extraParams'))
    kwargs = {
        'host': _require(conf, 'host', '主机地址', 'mysql'),
        'port': _int_or(conf.get('port'), default_port('mysql')),
        'user': str(conf.get('username') or ''),
        'password': decrypt_secret(conf.get('password')),
        'charset': str(conf.get('charset') or 'utf8mb4'),
        'connect_timeout': config.DBINFO_TIMEOUT,
        'read_timeout': config.DBINFO_READ_TIMEOUT,
        'write_timeout': config.DBINFO_READ_TIMEOUT,
        'cursorclass': pymysql.cursors.Cursor,
    }
    # 只放行少量安全参数（不覆盖 host/user/password 等，避免连接串被改成别的库）
    if 'unix_socket' in extra:
        kwargs['unix_socket'] = extra['unix_socket']
    if _int_or(extra.get('connect_timeout'), 0) > 0:
        kwargs['connect_timeout'] = min(_int_or(extra['connect_timeout'], 8), 60)
    if str(extra.get('ssl') or '').lower() in ('1', 'true', 'yes'):
        kwargs['ssl'] = {}
    try:
        return pymysql.connect(**kwargs)
    except Exception as exc:
        raise ConnError('连接 MySQL 失败（%s:%s）：%s'
                        % (kwargs['host'], kwargs['port'], _clean_exc(exc)))


def _mysql_databases(conf):
    conn = _mysql_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SHOW DATABASES')
        names = [str(row[0]) for row in cur.fetchall()]
        counts = {}
        try:
            cur.execute('SELECT TABLE_SCHEMA, COUNT(*) FROM information_schema.TABLES '
                        'GROUP BY TABLE_SCHEMA')
            counts = dict((str(r[0]), int(r[1] or 0)) for r in cur.fetchall())
        except Exception:
            counts = {}
    except Exception as exc:
        raise ConnError('读取实例列表失败：%s' % _clean_exc(exc))
    finally:
        try:
            conn.close()
        except Exception:
            pass
    current = str(conf.get('dbName') or '').strip()
    out = []
    for name in names[:config.DBINFO_MAX_DATABASES]:
        out.append({'name': name, 'tableCount': counts.get(name, 0),
                    'system': name in MYSQL_SYSTEM_DBS, 'current': name == current})
    out.sort(key=lambda one: (0 if one['current'] else (2 if one['system'] else 1), one['name']))
    return {'databases': out, 'engine': 'mysql', 'server': '%s:%s' % (conf.get('host'), conf.get('port'))}


def _mysql_tables(conf, database):
    conn = _mysql_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT '
                    'FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s '
                    'ORDER BY TABLE_TYPE, TABLE_NAME', (database,))
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取表 / 视图失败：%s' % _clean_exc(exc))
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return _rows_to_tables(rows)


def _mysql_columns(conf, database, table):
    conn = _mysql_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, '
                    '       EXTRA, COLUMN_COMMENT, ORDINAL_POSITION '
                    'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s '
                    'ORDER BY ORDINAL_POSITION', (database, table))
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取字段失败：%s' % _clean_exc(exc))
    finally:
        try:
            conn.close()
        except Exception:
            pass
    out = []
    for row in rows[:config.DBINFO_MAX_COLUMNS]:
        out.append({
            'name': str(row[0]),
            'dataType': str(row[1]),
            'nullable': str(row[2]).upper() == 'YES',
            'key': str(row[3] or ''),            # PRI / UNI / MUL
            'defaultValue': '' if row[4] is None else str(row[4]),
            'extra': str(row[5] or ''),
            'comment': str(row[6] or ''),
            # 实库里的真实列位置：设计态的 ordinal 直接用它，别靠「查询结果碰巧有序」推断
            'ordinal': int(row[7] or 0) if len(row) > 7 else 0,
        })
    return {'columns': out, 'total': len(rows)}


# ---------------------------------------------------------------- SQLite ----------------------------------------------------------------
def _sqlite_path(conf):
    path = str(conf.get('dbName') or conf.get('host') or '').strip()
    if not path:
        raise ConnError('SQLite 请把库文件路径填到「默认库 / 文件路径」里（例如 E:/data/demo.db）')
    if not os.path.isfile(path):
        raise ConnError('SQLite 库文件不存在：%s' % path)
    return path


def _sqlite_connect(conf):
    try:
        return sqlite3.connect(_sqlite_path(conf), timeout=config.DBINFO_TIMEOUT)
    except ConnError:
        raise
    except Exception as exc:
        raise ConnError('打开 SQLite 库失败：%s' % _clean_exc(exc))


def _sqlite_databases(conf):
    path = _sqlite_path(conf)
    conn = _sqlite_connect(conf)
    try:
        cur = conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','view') "
                           "AND name NOT LIKE 'sqlite_%'")
        count = int((cur.fetchone() or [0])[0] or 0)
    finally:
        conn.close()
    name = os.path.basename(path)
    return {'databases': [{'name': name, 'tableCount': count, 'system': False, 'current': True,
                           'path': path}],
            'engine': 'sqlite', 'server': path}


def _sqlite_tables(conf, database):
    conn = _sqlite_connect(conf)
    try:
        rows = conn.execute("SELECT name, type, 0, '' FROM sqlite_master "
                            "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' "
                            "ORDER BY type, name").fetchall()
    finally:
        conn.close()
    return _rows_to_tables(rows)


def _sqlite_columns(conf, database, table):
    conn = _sqlite_connect(conf)
    try:
        rows = conn.execute('PRAGMA table_info("%s")' % str(table).replace('"', '""')).fetchall()
    finally:
        conn.close()
    out = []
    for row in rows[:config.DBINFO_MAX_COLUMNS]:
        # cid, name, type, notnull, dflt_value, pk —— cid 从 0 开始，就是声明的列顺序
        out.append({
            'name': str(row[1]),
            'dataType': str(row[2] or ''),
            'nullable': not int(row[3] or 0),
            'key': 'PRI' if int(row[5] or 0) else '',
            'defaultValue': '' if row[4] is None else str(row[4]),
            'extra': '',
            'comment': '',
            'ordinal': int(row[0] or 0) + 1,
        })
    return {'columns': out, 'total': len(rows)}


# ---------------------------------------------------------------- PostgreSQL / Oracle / SQL Server（需装驱动） ----------------------------------------------------------------
def _pg_connect(conf):
    psycopg2 = _import('psycopg2', 'PostgreSQL', 'psycopg2-binary')
    extra = _extra_kv(conf.get('extraParams'))
    kwargs = {
        'host': _require(conf, 'host', '主机地址', 'postgresql'),
        'port': _int_or(conf.get('port'), default_port('postgresql')),
        'user': str(conf.get('username') or ''),
        'password': decrypt_secret(conf.get('password')),
        'dbname': str(conf.get('dbName') or 'postgres'),
        'connect_timeout': config.DBINFO_TIMEOUT,
        # psycopg2 没有独立的读超时，用服务端 statement_timeout 挡住跑不完的语句
        # （大库扫描 / 慢查询时不会无限期挂着，也不会因为太短而扫到一半被掐）
        'options': '-c statement_timeout=%d' % (max(int(config.DBINFO_READ_TIMEOUT), 1) * 1000),
    }
    if extra.get('sslmode'):
        kwargs['sslmode'] = extra['sslmode']
    try:
        return psycopg2.connect(**kwargs)
    except Exception as exc:
        raise ConnError('连接 PostgreSQL 失败：%s' % _clean_exc(exc))


def _pg_databases(conf):
    conn = _pg_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname')
        names = [str(row[0]) for row in cur.fetchall()]
    except Exception as exc:
        raise ConnError('读取实例列表失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    current = str(conf.get('dbName') or '')
    out = [{'name': n, 'tableCount': 0, 'system': n in ('postgres',), 'current': n == current}
           for n in names[:config.DBINFO_MAX_DATABASES]]
    out.sort(key=lambda one: (0 if one['current'] else 1, one['name']))
    return {'databases': out, 'engine': 'postgresql',
            'server': '%s:%s' % (conf.get('host'), conf.get('port'))}


def _pg_tables(conf, database):
    conf = dict(conf, dbName=database)          # PostgreSQL 的「库」要切到目标库上查
    conn = _pg_connect(conf)
    try:
        cur = conn.cursor()
        # 只取 search_path 里的 schema（默认 public）：一个库里可以有多个 schema 且表名重名，
        # 不限定 schema 会把别的 schema 的同名表也列出来，字段还会串在一起。
        cur.execute('SELECT table_name, table_type FROM information_schema.tables '
                    'WHERE table_schema = ANY(current_schemas(false)) '
                    'ORDER BY table_type, table_name')
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取表 / 视图失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    return _rows_to_tables(rows)


def _pg_columns(conf, database, table):
    conf = dict(conf, dbName=database)
    conn = _pg_connect(conf)
    try:
        cur = conn.cursor()
        # 必须同时限定 schema：否则多 schema 下同名表的字段会合并成一个列表，
        # 字段数翻倍、ordinal 也会穿插，导入设计态后顺序全乱。
        cur.execute('SELECT column_name, data_type, is_nullable, column_default, '
                    '       (SELECT count(*) FROM information_schema.key_column_usage k '
                    '         WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name '
                    '           AND k.column_name = c.column_name '
                    '           AND k.constraint_name LIKE %s), '
                    '       ordinal_position '
                    'FROM information_schema.columns c '
                    'WHERE c.table_schema = ANY(current_schemas(false)) AND c.table_name = %s '
                    'ORDER BY ordinal_position', ('%pkey%', table))
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取字段失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    out = []
    for row in rows[:config.DBINFO_MAX_COLUMNS]:
        out.append({'name': str(row[0]), 'dataType': str(row[1]),
                    'nullable': str(row[2]).upper() == 'YES',
                    'key': 'PRI' if int(row[4] or 0) else '',
                    'defaultValue': '' if row[3] is None else str(row[3]),
                    'extra': '', 'comment': '',
                    'ordinal': int(row[5] or 0) if len(row) > 5 else 0})
    return {'columns': out, 'total': len(rows)}


MSSQL_CHARSETS = ('UTF-8', 'GBK', 'GB18030', 'CP936', 'CP1252', 'ISO-8859-1')


def _mssql_charset(conf):
    """pymssql 需要 FreeTDS 认识的字符集名（MySQL 那套 utf8mb4 不行），不认识就退回 UTF-8

    默认就用 UTF-8（别改成 CP936）：UTF-8 下 nvarchar / nchar 的 Unicode 数据（含 emoji、
    生僻字）原样正确，而 CP936 客户端遇到 GBK 表示不了的字符会直接抛
    `'gbk' codec can't encode character`，把整条查询搞挂。
    varchar 的乱码在 UTF-8 下另用 `_mssql_fix_text()` 逐值还原，不需要动连接字符集。
    """
    text = str((conf or {}).get('charset') or '').strip()
    for one in MSSQL_CHARSETS:
        if text.lower() == one.lower():
            return one
    return 'UTF-8'


# SQL Server 老实例（TDS 7.1）里 varchar 列存的是库排序规则的代码页字节（中文库 = CP936/GBK）。
# FreeTDS 在 client charset=UTF-8 时拿不到列的排序规则，会把这些字节**当成 ISO-8859-1 逐字节映射**
# 成 U+0080..U+00FF，前端看到的就是「ÐìêÝÁú」这种乱码。还原办法：按 latin-1 编回原始字节，
# 再按 GBK 解码 —— 无损，且不用改连接字符集（nvarchar 不受影响）。
_MSSQL_CJK = re.compile(u'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')


def _mssql_fix_text(value):
    """把「被当成 ISO-8859-1 的 GBK 字节」还原成中文；不像乱码就原样返回

    判据（都成立才改）：① 整串都在 latin-1 可表示范围内 —— 逐字节映射才会这样；
    ② 按 GBK 解出来有汉字，且不像「西欧文本碰巧解出 1 个汉字」：
       汉字数 ≥ 2，或者整串只有 1 个汉字（占比 100%，比如「收」）。
    「Müller」这类会解出「M黮ler」（1 个汉字占 1/5），被 ② 挡掉；「ABCÖÐÎÄ」→「ABC中文」照常还原。
    """
    if not isinstance(value, str) or not value:
        return value
    low = False
    for ch in value:
        code = ord(ch)
        if code > 0xff:                 # 出现 latin-1 以外的字符 → 不是逐字节映射的产物
            return value
        if code >= 0x80:
            low = True
    if not low:
        return value                     # 纯 ASCII，不用管
    try:
        fixed = value.encode('latin-1').decode('gbk')
    except Exception:
        return value
    if not fixed:
        return value
    hit = len(_MSSQL_CJK.findall(fixed))
    if hit >= 2:
        return fixed
    if hit == 1:
        solid = len(re.sub(r'\s', '', fixed)) or 1
        return fixed if solid == 1 else value
    return value



def _mssql_connect(conf):
    """
    SQL Server 连接（pymssql，wheel 里自带 FreeTDS，不需要另装客户端）
      · 老实例 / 证书过期的机器，TLS 握手会被直接掐断（DB-Lib 20002 TDS server connection failed）；
        这类情况自动把这条连接降级成「不加密」（encryption='off'）再连一次，其它错误不重试，
        免得每次多等一个超时；
      · extraParams 里可以手工指定：`tds_version=7.3`、`encryption=require`（覆盖自动判断）；
      · 登录被拒（18456）/ 打不开库（4060）翻译成中文，别让用户对着 DB-Lib 错误码猜。
    """
    pymssql = _import('pymssql', 'SQL Server', 'pymssql')
    host = _require(conf, 'host', '主机地址', 'sqlserver')
    port = str(_int_or(conf.get('port'), default_port('sqlserver')))
    extra = _extra_kv((conf or {}).get('extraParams')) or {}
    base = {
        'server': host,
        'port': port,
        'user': str(conf.get('username') or ''),
        'password': decrypt_secret(conf.get('password')),
        'database': str(conf.get('dbName') or 'master'),
        'login_timeout': config.DBINFO_TIMEOUT,
        'timeout': config.DBINFO_READ_TIMEOUT,       # 单条语句等待时间（pymssql: 秒）
        'charset': _mssql_charset(conf),
    }
    for key in ('tds_version', 'encryption'):
        if extra.get(key):
            base[key] = extra[key]

    attempts = [dict(base)]
    if not base.get('encryption'):
        attempts.append(dict(base, encryption='off'))     # 老服务器的 TLS 握手失败时兜底

    last = None
    for index, kwargs in enumerate(attempts):
        try:
            return pymssql.connect(**kwargs)
        except Exception as exc:
            last = exc
            message = str(exc)
            # 只有「TDS 握手失败」（20002）才值得关掉加密再试一次
            if not (index == 0 and '20002' in message):
                break
    message = str(last)
    if '18456' in message:
        raise ConnError('连接 SQL Server 失败：登录失败（账号或密码不对，或被禁用）'
                        '，请检查用户名 / 密码')
    if '4060' in message:
        raise ConnError('连接 SQL Server 失败：打不开数据库「%s」（库不存在，或该账号没有权限）'
                        % base['database'])
    raise ConnError('连接 SQL Server 失败：%s' % _clean_exc(last))


def _mssql_databases(conf):
    conn = _mssql_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT name FROM sys.databases ORDER BY name')
        names = [str(row[0]) for row in cur.fetchall()]
    except Exception as exc:
        raise ConnError('读取实例列表失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    current = str(conf.get('dbName') or '')
    out = [{'name': n, 'tableCount': 0, 'system': n in ('master', 'model', 'msdb', 'tempdb'),
            'current': n == current} for n in names[:config.DBINFO_MAX_DATABASES]]
    out.sort(key=lambda one: (0 if one['current'] else (2 if one['system'] else 1), one['name']))
    return {'databases': out, 'engine': 'sqlserver',
            'server': '%s:%s' % (conf.get('host'), conf.get('port'))}


def _mssql_tables(conf, database):
    conn = _mssql_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT TABLE_NAME, TABLE_TYPE FROM [%s].INFORMATION_SCHEMA.TABLES '
                    'WHERE TABLE_SCHEMA = SCHEMA_NAME() '
                    'ORDER BY TABLE_TYPE, TABLE_NAME' % str(database).replace(']', ']]'))
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取表 / 视图失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    return _rows_to_tables(rows)


def _mssql_columns(conf, database, table):
    conn = _mssql_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION '
                    'FROM [%s].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = %%s '
                    'AND TABLE_SCHEMA = SCHEMA_NAME() '
                    'ORDER BY ORDINAL_POSITION' % str(database).replace(']', ']]'), (table,))
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取字段失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    out = []
    for row in rows[:config.DBINFO_MAX_COLUMNS]:
        out.append({'name': str(row[0]), 'dataType': str(row[1]),
                    'nullable': str(row[2]).upper() == 'YES', 'key': '',
                    'defaultValue': '' if row[3] is None else str(row[3]),
                    'extra': '', 'comment': '',
                    'ordinal': int(row[4] or 0) if len(row) > 4 else 0})
    return {'columns': out, 'total': len(rows)}


def _oracle_call_timeout(conn):
    """给 Oracle 连接设「单次调用」超时（毫秒）

    大库扫描要跑很多条语句，给足 config.DBINFO_READ_TIMEOUT；驱动版本太老
    不支持 call_timeout 就算了，不能因为设不了超时就把连接丢掉。
    """
    try:
        conn.call_timeout = max(int(config.DBINFO_READ_TIMEOUT), 1) * 1000
    except Exception:                            # noqa: BLE001
        pass


def _oracle_connect(conf):
    """
    Oracle 连接（python-oracledb 纯 Python 瘦模式，不需要 Oracle Instant Client）
      · 「数据库名」既可以填服务名（Service Name，12c+ 常见，如 ORCLPDB1），也可以填 SID（老库常用，如 ORCL）；
        默认先按服务名连，只有报「服务名没注册 / SID 不认识」（ORA-12505 / 12514）时才再按 SID 试一次，
        其它错误（连不上监听、密码错）不再重试，避免拖慢界面；
      · tcp_connect_timeout 用 config.DBINFO_TIMEOUT，主机填错时不会长时间卡住。
    """
    oracledb = _import('oracledb', 'Oracle', 'oracledb')
    host = _require(conf, 'host', '主机地址', 'oracle')
    port = _int_or(conf.get('port'), default_port('oracle'))
    database = str(conf.get('dbName') or '').strip()
    if not database:
        raise ConnError('Oracle 的「数据库名」不能为空：请填写服务名（Service Name，如 ORCLPDB1）'
                        '或 SID（如 ORCL）')
    user = str(conf.get('username') or '')
    password = decrypt_secret(conf.get('password'))
    attempts = [{'service_name': database}, {'sid': database}]
    last, tried = None, 0
    for index, kwargs in enumerate(attempts):
        try:
            dsn = oracledb.makedsn(host, port, **kwargs)
        except Exception as exc:                 # 少见：某些版本不支持某个参数
            last = exc
            break
        tried += 1
        try:
            try:
                conn = oracledb.connect(user=user, password=password, dsn=dsn,
                                        tcp_connect_timeout=config.DBINFO_TIMEOUT)
            except TypeError:                    # 厚模式（Instant Client）不认识这个参数
                conn = oracledb.connect(user=user, password=password, dsn=dsn)
            _oracle_call_timeout(conn)
            return conn
        except Exception as exc:
            last = exc
            # 只有「服务名 / SID 对不上」才值得换一种写法重试，其它错误（连不上 / 密码错）直接抛
            if not (index == 0 and re.search(r'ORA-125(05|14)', str(exc))):
                break
    hint = ('（服务名和 SID 都试过了，请检查数据库名）' if tried > 1 else
            '（请检查主机、端口、数据库名 / SID 与账号）')
    raise ConnError('连接 Oracle 失败：%s %s' % (_clean_exc(last), hint))


def _oracle_databases(conf):
    conn = _oracle_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME')
        names = [str(row[0]) for row in cur.fetchall()]
    except Exception as exc:
        raise ConnError('读取实例列表失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    current = str(conf.get('username') or '').upper()
    out = [{'name': n, 'tableCount': 0, 'system': n in ('SYS', 'SYSTEM'),
            'current': n == current} for n in names[:config.DBINFO_MAX_DATABASES]]
    out.sort(key=lambda one: (0 if one['current'] else (2 if one['system'] else 1), one['name']))
    return {'databases': out, 'engine': 'oracle',
            'server': '%s:%s' % (conf.get('host'), conf.get('port'))}


def _oracle_tables(conf, database):
    conn = _oracle_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT t.TABLE_NAME, 'BASE TABLE', t.NUM_ROWS, c.COMMENTS "
            "FROM ALL_TABLES t "
            "LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME "
            "     AND c.TABLE_TYPE = 'TABLE' "
            "WHERE t.OWNER = :o "
            "UNION ALL "
            "SELECT v.VIEW_NAME, 'VIEW', NULL, c.COMMENTS "
            "FROM ALL_VIEWS v "
            "LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = v.OWNER AND c.TABLE_NAME = v.VIEW_NAME "
            "     AND c.TABLE_TYPE = 'VIEW' "
            "WHERE v.OWNER = :o "
            "ORDER BY 2, 1", {'o': str(database).upper()})
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取表 / 视图失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    return _rows_to_tables(rows)


def _oracle_column_dicts(rows):
    """ALL_TAB_COLUMNS ⋈ ALL_COL_COMMENTS 的查询结果 → 设计态的字段结构

    列顺序固定为：COLUMN_NAME, DATA_TYPE, NULLABLE, DATA_DEFAULT, COLUMN_ID, COMMENTS。
    **第 6 列是字段注释**（早期这里漏了注释，扫进设计态后 colComment 全是空的，
    对比时还会把手工维护的注释判成「清空」）。
    """
    out = []
    for row in (rows or [])[:config.DBINFO_MAX_COLUMNS]:
        cells = list(row or ())
        out.append({'name': str(cells[0] if len(cells) > 0 else ''),
                    'dataType': str(cells[1] if len(cells) > 1 else ''),
                    'nullable': str(cells[2] if len(cells) > 2 else '').upper() == 'Y',
                    'key': '',
                    'defaultValue': '' if (len(cells) < 4 or cells[3] is None) else str(cells[3]),
                    'extra': '',
                    'comment': str(cells[5] or '') if len(cells) > 5 else '',
                    'ordinal': int(cells[4] or 0) if len(cells) > 4 else 0})
    return out


def _oracle_columns(conf, database, table):
    conn = _oracle_connect(conf)
    try:
        cur = conn.cursor()
        # 字段注释在 ALL_COL_COMMENTS 里（COMMENTS），不 join 就永远拿不到；
        # 表 / 视图的字段都在 ALL_TAB_COLUMNS 里，视图同样有注释。
        cur.execute('SELECT c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, c.DATA_DEFAULT, c.COLUMN_ID, '
                    '       m.COMMENTS '
                    'FROM ALL_TAB_COLUMNS c '
                    'LEFT JOIN ALL_COL_COMMENTS m '
                    '       ON m.OWNER = c.OWNER AND m.TABLE_NAME = c.TABLE_NAME '
                    '      AND m.COLUMN_NAME = c.COLUMN_NAME '
                    'WHERE c.OWNER = :o AND c.TABLE_NAME = :t '
                    'ORDER BY c.COLUMN_ID', {'o': str(database).upper(), 't': str(table).upper()})
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取字段失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    return {'columns': _oracle_column_dicts(rows), 'total': len(rows)}


# ---------------------------------------------------------------- 统一出口 ----------------------------------------------------------------
def _rows_to_tables(rows):
    """
    查询结果 → {tables:[...], counts:{table, view}}
      · 列顺序：表名、类型（BASE TABLE / VIEW），行数、注释可选；
      · **允许只给两列**（Oracle / SQL Server 的系统视图就只有名字和类型，行数、注释不一定有），
        以前这里直接取 row[2]，只给两列时会抛 tuple index out of range。
    """
    out = []
    table_n = view_n = 0
    for row in (rows or [])[:config.DBINFO_MAX_TABLES]:
        cells = list(row or ())
        name = cells[0] if len(cells) > 0 else ''
        raw_type = str((cells[1] if len(cells) > 1 else '') or '').upper()
        kind = 'view' if 'VIEW' in raw_type else 'table'
        if kind == 'view':
            view_n += 1
        else:
            table_n += 1
        try:
            rows_num = int((cells[2] if len(cells) > 2 else 0) or 0)
        except (TypeError, ValueError):
            rows_num = 0
        out.append({'name': str(name), 'kind': kind, 'rows': rows_num,
                    'comment': str((cells[3] if len(cells) > 3 else '') or '')})
    return {'tables': out, 'counts': {'table': table_n, 'view': view_n},
            'total': len(rows or [])}


_HANDLERS = {
    'mysql': (_mysql_databases, _mysql_tables, _mysql_columns),
    'mariadb': (_mysql_databases, _mysql_tables, _mysql_columns),
    'postgresql': (_pg_databases, _pg_tables, _pg_columns),
    'sqlserver': (_mssql_databases, _mssql_tables, _mssql_columns),
    'oracle': (_oracle_databases, _oracle_tables, _oracle_columns),
    'sqlite': (_sqlite_databases, _sqlite_tables, _sqlite_columns),
}


def _handlers_of(conf):
    db_type = str((conf or {}).get('dbType') or '').lower()
    pair = _HANDLERS.get(db_type)
    if not pair:
        raise ConnError('暂不支持该数据库类型：%s（可选：%s）'
                        % (db_type or '空', ' / '.join(one['value'] for one in DB_TYPES)))
    return pair


def default_database(conf):
    """
    连接对象里指定的「默认库 / 实例」——**扫描导入只认这一个目标，不做全库扫描**。

      · mysql / mariadb / postgresql / sqlserver：就是 dbinfomgr.dbName 里填的库名；
      · sqlite：dbName 存的是库文件路径，设计态的「库」用文件名（与 _sqlite_databases 保持一致）；
      · oracle：dbName 是服务名 / SID（连库用），设计态的「库」等于 schema，默认取登录账号自己的 schema
        （要扫别的 schema 就在扫描时显式指定）；
      · 没填时返回空串 —— 调用方必须提示「连接没指定扫描目标」，而不是退化成扫全部。
    """
    conf = conf or {}
    name = str(conf.get('dbName') or '').strip()
    if not name:
        return ''
    db_type = str(conf.get('dbType') or '').lower()
    if db_type == 'sqlite':
        return os.path.basename(name.replace('\\', '/'))
    if db_type == 'oracle':
        return str(conf.get('username') or '').strip().upper()
    return name


def databases(conf):
    """
    列出连接可访问的实例（库）：{databases:[{name,tableCount,system,current}], engine, server}

    注意：这里**只列名字**（SHOW DATABASES / pg_database / sys.databases …），不读表与字段。
    真正的「扫描导入」只针对一个库 —— 见 default_database()，别再拿全量列表去逐个扫。
    """
    return _handlers_of(conf)[0](conf)


def tables(conf, database):
    """扫描某实例下的表与视图：{tables:[{name,kind,rows,comment}], counts:{table,view}}"""
    name = str(database or '').strip()
    if not name:
        raise ConnError('请先选择要扫描的实例（库）')
    return _handlers_of(conf)[1](conf, name)


def columns(conf, database, table):
    """扫描某张表 / 视图的字段：{columns:[{name,dataType,nullable,key,defaultValue,extra,comment}]}"""
    name = str(database or '').strip()
    tbl = str(table or '').strip()
    if not name:
        raise ConnError('请先选择要扫描的实例（库）')
    if not tbl:
        raise ConnError('请先选择要查看字段的表或视图')
    return _handlers_of(conf)[2](conf, name, tbl)


def test(conf):
    """测试连接：能列出实例即视为连通；返回 {ok, engine, server, databases, elapsed}"""
    started = __import__('time').time()
    res = databases(conf)
    return {'ok': True, 'engine': res.get('engine') or conf.get('dbType'),
            'server': res.get('server') or '', 'databases': len(res.get('databases') or []),
            'elapsed': int((__import__('time').time() - started) * 1000)}


# ---------------------------------------------------------------- 存储过程 / 函数（应用架构扫描用） ----------------------------------------------------------------
# 说明：过程与函数都收 —— 名字 + 类型（procedure / function）+ 注释 + 正文（能取到就取）。
#       正文取法各方言不同：MySQL 走 SHOW CREATE、PostgreSQL 走 pg_get_functiondef、
#       SQL Server 走 OBJECT_DEFINITION；Oracle 要 DBMS_METADATA（默认没授权）所以正文留空，
#       页面上可以手工粘贴，发布时按原文输出。
def _first_create(cur, sql):
    """执行 SHOW CREATE 类语句，从结果里挑以 CREATE 开头的那一列"""
    cur.execute(sql)
    for row in (cur.fetchall() or []):
        for cell in row:
            text = str(cell or '')
            if text.lower().lstrip().startswith('create'):
                return text
    return ''


def _qi(name):
    return '`%s`' % str(name).replace('`', '``')


def _mysql_routines(conf, database):
    conn = _mysql_connect(conf)
    out = []
    try:
        cur = conn.cursor()
        cur.execute('SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_COMMENT '
                    'FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=%s '
                    'ORDER BY ROUTINE_TYPE, ROUTINE_NAME', (database,))
        rows = cur.fetchall()
        for row in rows[:200]:
            name = str(row[0] or '')
            rtype = str(row[1] or '').upper()
            ddl = ''
            try:
                ddl = _first_create(cur, 'SHOW CREATE %s %s'
                                    % ('FUNCTION' if rtype == 'FUNCTION' else 'PROCEDURE',
                                       '%s.%s' % (_qi(database), _qi(name))))
            except Exception:                  # 没权限 / 老版本 → 正文留空，不影响收录
                ddl = ''
            out.append({'name': name, 'type': 'function' if rtype == 'FUNCTION' else 'procedure',
                        'comment': str(row[2] or ''), 'ddl': ddl})
    except Exception as exc:
        raise ConnError('读取存储过程失败：%s' % _clean_exc(exc))
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return {'routines': out, 'total': len(out)}


def _pg_routines(conf, database):
    conf = dict(conf, dbName=database)
    conn = _pg_connect(conf)
    try:
        cur = conn.cursor()
        try:
            cur.execute("SELECT p.proname, COALESCE(d.description,''), p.prokind, "
                        "pg_get_functiondef(p.oid) "
                        "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
                        "LEFT JOIN pg_description d ON d.objoid=p.oid AND d.objsubid=0 "
                        "WHERE n.nspname = ANY(current_schemas(false)) "
                        "AND p.prokind IN ('p','f') ORDER BY p.proname")
            rows = cur.fetchall()
        except Exception:
            conn.rollback()                    # PG 10 及更早没有 prokind
            cur.execute("SELECT p.proname, COALESCE(d.description,''), 'p', '' "
                        "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
                        "LEFT JOIN pg_description d ON d.objoid=p.oid AND d.objsubid=0 "
                        "WHERE n.nspname = ANY(current_schemas(false)) ORDER BY p.proname")
            rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取存储过程失败：%s' % _clean_exc(exc))
    finally:
        try:
            conn.close()
        except Exception:
            pass
    out = [{'name': str(r[0]), 'type': 'function' if str(r[2] or 'p') == 'f' else 'procedure',
            'comment': str(r[1] or ''), 'ddl': str(r[3] or '')}
           for r in rows[:200]]
    return {'routines': out, 'total': len(out)}


def _mssql_routines(conf, database):
    conn = _mssql_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute("SELECT name, type, OBJECT_DEFINITION(object_id) FROM sys.objects "
                    "WHERE type IN ('P','FN','IF','TF','FS','FT') AND is_ms_shipped = 0 "
                    "ORDER BY name")
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取存储过程失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    out = [{'name': str(r[0]), 'type': 'function' if str(r[1] or '').upper().strip() != 'P' else 'procedure',
            'comment': '', 'ddl': str(r[2] or '')} for r in rows[:200]]
    return {'routines': out, 'total': len(out)}


def _lob_text(value):
    """CLOB / BLOB 取文本：DBMS_METADATA.GET_DDL 有时代理层会把结果包成 LOB 对象"""
    if value is None:
        return ''
    if isinstance(value, bytes):
        return value.decode('utf-8', 'replace')
    read = getattr(value, 'read', None)
    if callable(read):
        try:
            data = read()
        except Exception:
            return ''
        return data.decode('utf-8', 'replace') if isinstance(data, bytes) else str(data or '')
    return str(value)


def _oracle_routine_ddl(cur, source_map, owner, name, rtype):
    """取 Oracle 过程 / 函数正文

    两条路，按可靠性排序：
      1. DBMS_METADATA.GET_DDL → 标准 `CREATE OR REPLACE ...` 原文（最准，含 DETERMINISTIC / AUTHID 等属性），
         但要求 SELECT_CATALOG_ROLE（或对象属主），10g 起默认不给普通账号；
      2. ALL_SOURCE 按 LINE 顺序拼接 → 纯源码（`FUNCTION xxx(...) RETURN ... IS ... END;`），
         前面补一句 `CREATE OR REPLACE ` 就是可执行脚本。只有当前 schema 能看到的对象（这正好是扫描范围）。
    取不到就留空，不影响对象收录 —— 页面上可以手工粘贴，发布时按原文输出。
    """
    kind = 'FUNCTION' if rtype == 'function' else 'PROCEDURE'
    try:
        cur.execute("SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) FROM dual", [kind, name, owner])
        row = cur.fetchone()
        text = _lob_text(row[0] if row else '').strip()
        if text:
            return text
    except Exception:                          # 没权限 / 老版本 → 走 ALL_SOURCE
        rollback = getattr(getattr(cur, 'connection', None), 'rollback', None)
        if callable(rollback):
            try:
                rollback()
            except Exception:                  # 回滚失败也不能把整批扫描带下去
                pass
    body = (source_map.get((str(name).upper(), kind)) or '').strip()
    if not body:
        return ''
    if not body.upper().startswith('CREATE'):
        body = 'CREATE OR REPLACE ' + body
    return body


def _oracle_routines(conf, database):
    conn = _oracle_connect(conf)
    out = []
    try:
        cur = conn.cursor()
        cur.execute("SELECT OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS "
                    "WHERE OWNER = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') "
                    "AND OBJECT_TYPE IN ('PROCEDURE','FUNCTION') "
                    "ORDER BY OBJECT_TYPE, OBJECT_NAME")
        rows = cur.fetchall()
        # 先把源码一次性读回来（一条 SQL），再逐个试 GET_DDL：没有 SELECT_CATALOG_ROLE 时
        # 不至于每个对象都要多跑一次失败查询（远程库往返很贵）
        source_map = {}
        try:
            cur.execute("SELECT NAME, TYPE, TEXT FROM ALL_SOURCE "
                        "WHERE OWNER = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') "
                        "AND TYPE IN ('PROCEDURE','FUNCTION') ORDER BY NAME, TYPE, LINE")
            for row in (cur.fetchall() or []):
                key = (str(row[0] or '').upper(), str(row[1] or '').upper())
                source_map[key] = source_map.get(key, '') + _lob_text(row[2])
        except Exception:
            conn.rollback()                    # 源码读不到就只靠 GET_DDL
            source_map = {}
        owner = ''
        try:
            cur.execute("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM dual")
            row = cur.fetchone()
            owner = str(row[0] or '') if row else ''
        except Exception:
            owner = ''
        for one in rows[:200]:
            name = str(one[0] or '')
            rtype = 'function' if str(one[1] or '').upper() == 'FUNCTION' else 'procedure'
            out.append({'name': name, 'type': rtype, 'comment': '',
                        'ddl': _oracle_routine_ddl(cur, source_map, owner, name, rtype)})
    except Exception as exc:
        raise ConnError('读取存储过程失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    return {'routines': out, 'total': len(out)}


def _sqlite_routines(conf, database):
    return {'routines': [], 'total': 0}


_ROUTINE_HANDLERS = {
    'mysql': _mysql_routines, 'mariadb': _mysql_routines, 'postgresql': _pg_routines,
    'sqlserver': _mssql_routines, 'oracle': _oracle_routines, 'sqlite': _sqlite_routines,
}


def routines(conf, database):
    """扫描某实例下的存储过程 / 函数：{routines:[{name,type,comment,ddl}], total}"""
    db_type = str((conf or {}).get('dbType') or '').lower()
    handler = _ROUTINE_HANDLERS.get(db_type)
    if not handler:
        raise ConnError('暂不支持该数据库类型：%s' % (db_type or '空'))
    name = str(database or '').strip()
    if not name and db_type != 'sqlite':
        raise ConnError('请先选择要扫描的实例（库）')
    return handler(conf, name)


# ---------------------------------------------------------------- 索引 / 触发器（应用架构扫描用） ----------------------------------------------------------------
# 说明：索引与触发器都是**依附于表**的对象，名字只在「表内」唯一（MySQL 尤其如此），
#       所以上层落地时 objName 会拼成「表名.对象名」，避免两张表的同名索引互相覆盖。
MAX_AUX_OBJECTS = 2000          # 索引 / 触发器最多收这么多个，超了就截断（页面上有提示）
_QUOTE_CACHE = {}


def _q(name):
    """MySQL 风格的标识符加反引号（只在本模块内部给 MySQL 拼 DDL 用）"""
    return '`%s`' % str(name).replace('`', '``')


def _aux_result(key, items, supported=True):
    items = [one for one in items if one.get('name')][:MAX_AUX_OBJECTS]
    return {key: items, 'total': len(items), 'supported': supported}


def _mysql_indexes(conf, database):
    """索引：一次读全库（information_schema.STATISTICS），主键索引跳过（字段上已用 isPk 表达）"""
    conn = _mysql_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART '
                    'FROM information_schema.STATISTICS '
                    'WHERE TABLE_SCHEMA=%s AND INDEX_NAME<>%s '
                    'ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX', (database, 'PRIMARY'))
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取索引失败：%s' % _clean_exc(exc))
    finally:
        try:
            conn.close()
        except Exception:
            pass
    grouped = {}
    for row in rows:
        tbl, idx = str(row[0] or ''), str(row[1] or '')
        if not tbl or not idx:
            continue
        key = (tbl, idx)
        one = grouped.get(key)
        if not one:
            one = grouped[key] = {'table': tbl, 'name': idx,
                                  'unique': not int(row[2] or 0), 'columns': [], 'ddl': ''}
        col = str(row[4] or '')
        if col:
            part = int(row[5] or 0)
            one['columns'].append('%s(%d)' % (col, part) if part else col)
    out = []
    for (tbl, idx), one in grouped.items():
        cols = ', '.join(_q(c) for c in one['columns'])
        one['ddl'] = 'CREATE %sINDEX %s ON %s (%s)' % ('UNIQUE ' if one['unique'] else '',
                                                       _q(idx), _q(tbl), cols)
        one['comment'] = _index_comment(one['unique'], one['columns'])
        one['objName'] = '%s.%s' % (tbl, idx)
        out.append(one)
    out.sort(key=lambda one: (one['table'], one['name']))
    return _aux_result('indexes', out)


def _mysql_triggers(conf, database):
    conn = _mysql_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, '
                    '       ACTION_STATEMENT, ACTION_ORDER '
                    'FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=%s '
                    'ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME', (database,))
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取触发器失败：%s' % _clean_exc(exc))
    finally:
        try:
            conn.close()
        except Exception:
            pass
    out = []
    for row in rows:
        name, tbl = str(row[0] or ''), str(row[1] or '')
        if not name or not tbl:
            continue
        timing = str(row[2] or 'BEFORE').upper()
        event = str(row[3] or 'INSERT').upper()
        body = str(row[4] or '').strip()
        out.append({
            'table': tbl, 'name': name, 'objName': '%s.%s' % (tbl, name),
            'timing': timing, 'event': event,
            'comment': '%s %s' % (timing, event),
            'ddl': 'CREATE TRIGGER %s %s %s ON %s FOR EACH ROW %s'
                   % (_q(name), timing, event, _q(tbl), body),
        })
    return _aux_result('triggers', out)


_TRG_TIMING = re.compile(r'\b(INSTEAD\s+OF|BEFORE|AFTER)\b', re.I)
_TRG_EVENT = re.compile(r'\b(INSERT|UPDATE|DELETE)\b', re.I)
_TRG_ON = re.compile(r'\s+ON\s+', re.I)


def _trigger_comment(ddl):
    """触发器副标题：从建触发器原文里抠「时机 + 事件」

    树上已经用徽标写了「触发器」，副标题再写一遍就是「触发器 触发器」，
    所以这里只回 `BEFORE INSERT` / `AFTER UPDATE OR DELETE` 这类信息；
    抠不出来回空串（页面按空处理）。
    """
    text = str(ddl or '')
    hit = _TRG_TIMING.search(text)
    if not hit:
        return ''
    head = text[hit.end():]
    cut = _TRG_ON.search(head)
    if cut:
        head = head[:cut.start()]
    timing = re.sub(r'\s+', ' ', hit.group(1).upper())
    events = []
    for one in _TRG_EVENT.finditer(head):
        event = one.group(1).upper()
        if event not in events:
            events.append(event)
    if not events:
        return timing
    return '%s %s' % (timing, ' / '.join(events))


def _index_columns(ddl):
    """从 CREATE INDEX 原文里抠字段清单（PG / SQLite 的元数据不直接给）

    取 `ON` 之后的第一组括号内容，按顶层逗号切开，去掉引号；PG 还会带
    `col DESC` / `col text_pattern_ops` 这类修饰，只留第一个词。
    """
    text = str(ddl or '')
    upper = text.upper()
    pos = upper.find(' ON ')
    start = text.find('(', pos + 1 if pos >= 0 else 0)
    if start < 0:
        return []
    depth, buf = 0, []
    for ch in text[start:]:
        if ch == '(':
            depth += 1
            if depth == 1:
                continue
        elif ch == ')':
            depth -= 1
            if depth == 0:
                break
        buf.append(ch)
    out, piece = [], []
    for ch in buf:
        if ch == ',':
            if piece:
                out.append(''.join(piece))
            piece = []
        else:
            piece.append(ch)
    if piece:
        out.append(''.join(piece))
    cols = []
    for one in out:
        name = one.strip().strip('"`[]').strip()
        name = re.split(r'\s+', name)[0] if name else ''
        if name:
            cols.append(name)
    return cols


def _index_comment(unique, columns):
    """索引副标题：`唯一 (a, b)` / `普通 (a)`（徽标已写「索引」，不再重复）"""
    cols = ', '.join(columns or [])
    head = '唯一 ' if unique else '普通 '
    return '%s(%s)' % (head, cols) if cols else head.strip()


def _pg_indexes(conf, database):
    """PostgreSQL：pg_indexes.indexdef 就是可直接执行的 CREATE INDEX；跳过主键（*_pkey）"""
    conf = dict(conf, dbName=database)
    conn = _pg_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute("SELECT tablename, indexname, indexdef FROM pg_indexes "
                    "WHERE schemaname = ANY(current_schemas(false)) "
                    "AND indexname NOT LIKE '%%_pkey' ORDER BY tablename, indexname")
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取索引失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    out = []
    for row in rows:
        tbl, idx, ddl = str(row[0] or ''), str(row[1] or ''), str(row[2] or '')
        if not tbl or not idx:
            continue
        uniq = 'UNIQUE INDEX' in ddl.upper()
        cols = _index_columns(ddl)
        out.append({'table': tbl, 'name': idx, 'objName': '%s.%s' % (tbl, idx),
                    'unique': uniq, 'columns': cols,
                    'comment': _index_comment(uniq, cols), 'ddl': ddl})
    return _aux_result('indexes', out)


def _pg_triggers(conf, database):
    conf = dict(conf, dbName=database)
    conn = _pg_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) '
                    'FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid '
                    'JOIN pg_namespace n ON n.oid = c.relnamespace '
                    'WHERE NOT t.tgisinternal AND n.nspname = ANY(current_schemas(false)) '
                    'ORDER BY c.relname, t.tgname')
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取触发器失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    out = []
    for row in rows:
        tbl, name, ddl = str(row[0] or ''), str(row[1] or ''), str(row[2] or '')
        if not tbl or not name:
            continue
        out.append({'table': tbl, 'name': name, 'objName': '%s.%s' % (tbl, name),
                    'comment': _trigger_comment(ddl), 'ddl': ddl})
    return _aux_result('triggers', out)


def _sqlite_indexes(conf, database):
    """SQLite：sqlite_master.sql 就是建索引原文；自动索引（sql 为 NULL）跳过"""
    conn = _sqlite_connect(conf)
    try:
        rows = conn.execute("SELECT tbl_name, name, sql FROM sqlite_master "
                            "WHERE type='index' AND sql IS NOT NULL "
                            "ORDER BY tbl_name, name").fetchall()
    finally:
        conn.close()
    out = []
    for row in rows:
        tbl, name, ddl = str(row[0] or ''), str(row[1] or ''), str(row[2] or '')
        if not tbl or not name:
            continue
        uniq = 'UNIQUE' in ddl.upper()
        cols = _index_columns(ddl)
        out.append({'table': tbl, 'name': name, 'objName': '%s.%s' % (tbl, name),
                    'unique': uniq, 'columns': cols,
                    'comment': _index_comment(uniq, cols), 'ddl': ddl})
    return _aux_result('indexes', out)


def _sqlite_triggers(conf, database):
    conn = _sqlite_connect(conf)
    try:
        rows = conn.execute("SELECT tbl_name, name, sql FROM sqlite_master "
                            "WHERE type='trigger' AND sql IS NOT NULL "
                            "ORDER BY tbl_name, name").fetchall()
    finally:
        conn.close()
    out = []
    for row in rows:
        tbl, name, ddl = str(row[0] or ''), str(row[1] or ''), str(row[2] or '')
        if not tbl or not name:
            continue
        out.append({'table': tbl, 'name': name, 'objName': '%s.%s' % (tbl, name),
                    'comment': _trigger_comment(ddl), 'ddl': ddl})
    return _aux_result('triggers', out)


def _mssql_indexes(conf, database):
    conn = _mssql_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT t.name, i.name, i.is_unique, c.name, ic.key_ordinal '
                    'FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id '
                    'JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id '
                    'JOIN sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id '
                    'WHERE t.is_ms_shipped = 0 AND i.is_primary_key = 0 AND i.type > 0 '
                    'ORDER BY t.name, i.name, ic.key_ordinal')
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取索引失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    grouped = {}
    for row in rows:
        tbl, idx = str(row[0] or ''), str(row[1] or '')
        if not tbl or not idx:
            continue
        one = grouped.get((tbl, idx))
        if not one:
            one = grouped[(tbl, idx)] = {'table': tbl, 'name': idx, 'unique': bool(row[2]),
                                         'columns': [], 'ddl': ''}
        if row[3]:
            one['columns'].append(str(row[3]))
    out = []
    for (tbl, idx), one in grouped.items():
        cols = ', '.join('[%s]' % str(c).replace(']', ']]') for c in one['columns'])
        one['ddl'] = 'CREATE %sINDEX [%s] ON [%s] (%s)' % ('UNIQUE ' if one['unique'] else '',
                                                          idx, tbl, cols)
        one['comment'] = _index_comment(one['unique'], one['columns'])
        one['objName'] = '%s.%s' % (tbl, idx)
        out.append(one)
    out.sort(key=lambda one: (one['table'], one['name']))
    return _aux_result('indexes', out)


def _mssql_triggers(conf, database):
    conn = _mssql_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute('SELECT t.name, tr.name, OBJECT_DEFINITION(tr.object_id) '
                    'FROM sys.triggers tr JOIN sys.tables t ON t.object_id = tr.parent_id '
                    'WHERE tr.is_ms_shipped = 0 ORDER BY t.name, tr.name')
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取触发器失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    out = []
    for row in rows:
        tbl, name, ddl = str(row[0] or ''), str(row[1] or ''), str(row[2] or '')
        if not tbl or not name:
            continue
        out.append({'table': tbl, 'name': name, 'objName': '%s.%s' % (tbl, name),
                    'comment': _trigger_comment(ddl), 'ddl': ddl})
    return _aux_result('triggers', out)


def _oracle_indexes(conf, database):
    conn = _oracle_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute("SELECT i.TABLE_NAME, i.INDEX_NAME, i.UNIQUENESS, c.COLUMN_NAME, c.COLUMN_POSITION "
                    "FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS c "
                    "  ON c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME "
                    "WHERE i.OWNER = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') "
                    "  AND i.INDEX_TYPE <> 'LOB' "
                    "  AND i.INDEX_NAME NOT IN (SELECT INDEX_NAME FROM ALL_CONSTRAINTS "
                    "     WHERE CONSTRAINT_TYPE = 'P' AND OWNER = i.OWNER AND INDEX_NAME IS NOT NULL) "
                    "ORDER BY i.TABLE_NAME, i.INDEX_NAME, c.COLUMN_POSITION")
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取索引失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    grouped = {}
    for row in rows:
        tbl, idx = str(row[0] or ''), str(row[1] or '')
        if not tbl or not idx:
            continue
        one = grouped.get((tbl, idx))
        if not one:
            one = grouped[(tbl, idx)] = {'table': tbl, 'name': idx,
                                         'unique': str(row[2] or '').upper() == 'UNIQUE',
                                         'columns': [], 'ddl': ''}
        if row[3]:
            one['columns'].append(str(row[3]))
    out = []
    for (tbl, idx), one in grouped.items():
        cols = ', '.join('"%s"' % c.replace('"', '""') for c in one['columns'])
        one['ddl'] = 'CREATE %sINDEX "%s" ON "%s" (%s)' % ('UNIQUE ' if one['unique'] else '',
                                                          idx, tbl, cols)
        one['comment'] = _index_comment(one['unique'], one['columns'])
        one['objName'] = '%s.%s' % (tbl, idx)
        out.append(one)
    out.sort(key=lambda one: (one['table'], one['name']))
    return _aux_result('indexes', out)


def _oracle_triggers(conf, database):
    conn = _oracle_connect(conf)
    try:
        cur = conn.cursor()
        cur.execute("SELECT TABLE_NAME, TRIGGER_NAME, TRIGGER_TYPE, TRIGGERING_EVENT, TRIGGER_BODY, "
                    "       WHEN_CLAUSE FROM ALL_TRIGGERS "
                    "WHERE OWNER = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') "
                    "AND BASE_OBJECT_TYPE = 'TABLE' ORDER BY TABLE_NAME, TRIGGER_NAME")
        rows = cur.fetchall()
    except Exception as exc:
        raise ConnError('读取触发器失败：%s' % _clean_exc(exc))
    finally:
        conn.close()
    out = []
    for row in rows:
        tbl, name = str(row[0] or ''), str(row[1] or '')
        if not tbl or not name:
            continue
        raw_type = str(row[2] or 'BEFORE EACH ROW').upper()
        timing = 'INSTEAD OF' if 'INSTEAD OF' in raw_type else (
            'BEFORE' if raw_type.startswith('BEFORE') else 'AFTER')
        for_each = 'FOR EACH ROW' if 'EACH ROW' in raw_type else ''
        body = str(row[4] or '').strip()
        ddl = 'CREATE OR REPLACE TRIGGER "%s" %s %s ON "%s" %s\n%s' % (
            name, timing, str(row[3] or '').upper(), tbl, for_each, body)
        out.append({'table': tbl, 'name': name, 'objName': '%s.%s' % (tbl, name),
                    'comment': '%s %s' % (timing, str(row[3] or '').upper()), 'ddl': ddl})
    return _aux_result('triggers', out)


_INDEX_HANDLERS = {
    'mysql': _mysql_indexes, 'mariadb': _mysql_indexes, 'postgresql': _pg_indexes,
    'sqlserver': _mssql_indexes, 'oracle': _oracle_indexes, 'sqlite': _sqlite_indexes,
}
_TRIGGER_HANDLERS = {
    'mysql': _mysql_triggers, 'mariadb': _mysql_triggers, 'postgresql': _pg_triggers,
    'sqlserver': _mssql_triggers, 'oracle': _oracle_triggers, 'sqlite': _sqlite_triggers,
}


def indexes(conf, database):
    """扫描某实例的索引（一次读全库，别按表逐个查）

    :return {indexes:[{objName:'表.索引', table, name, unique, columns, comment, ddl}], total, supported}
    """
    return _aux_scan(_INDEX_HANDLERS, 'indexes', conf, database)


def triggers(conf, database):
    """扫描某实例的触发器：{triggers:[{objName:'表.触发器', table, name, comment, ddl}], total, supported}"""
    return _aux_scan(_TRIGGER_HANDLERS, 'triggers', conf, database)


def _aux_scan(handlers, key, conf, database):
    db_type = str((conf or {}).get('dbType') or '').lower()
    handler = handlers.get(db_type)
    if not handler:
        # 不认识的方言不算失败：扫描整体要能继续，缺的部分在页面上说明
        return {key: [], 'total': 0, 'supported': False}
    name = str(database or '').strip()
    if not name and db_type != 'sqlite':
        raise ConnError('请先选择要扫描的实例（库）')
    return handler(conf, name)



# ---------------------------------------------------------------- SQL 工作台（只读查询） ----------------------------------------------------------------
# 安全策略（数据中心的 SQL 区只用来「看数据」，不是数据库客户端）：
#   ① 只放行查询类语句（SELECT / SHOW / DESC / EXPLAIN / PRAGMA / WITH / VALUES / TABLE）；
#   ② 一次只允许一条语句（分号切分时跳过字符串字面量里的分号）；
#   ③ 语句里出现 insert / update / delete / drop / alter ... 一律拒绝（防止 WITH ... DELETE 这类绕法）；
#   ④ 取完结果**永远 rollback、绝不 commit**，就算前面判断漏了也写不进库；
#   ⑤ 行数上限 config.DBINFO_SQL_MAX_ROWS（默认 200），超出截断并告知前端。
QUERY_HEADS = ('select', 'show', 'desc', 'describe', 'explain', 'pragma',
               'with', 'values', 'table')
_WRITE_WORDS = re.compile(r'\b(insert|update|delete|replace|merge|alter|drop|truncate|create|'
                          r'rename|grant|revoke|call|execute|exec|lock|unlock|load|outfile|'
                          r'dumpfile|shutdown|kill|purge|vacuum|attach|detach)\b', re.I)
_COMMENT_HEAD = re.compile(r'^(?:\s+|--[^\n]*\n?|#[^\n]*\n?|/\*.*?\*/)+', re.S)
# 「SHOW CREATE TABLE/VIEW/... 」是**读元数据**：返回建表 / 建视图语句的原文，语句里天生就带
# CREATE 字样，按写操作关键字拦掉属于误杀（应用结构里取视图原文、SQL 工作台看结构都会踩）。
# 只放行这一种形态的 SHOW；写成 SHOW CREATE 之后再夹带别的语句，仍会被「一次只能一条」挡住。
_SHOW_CREATE = re.compile(r'^show\s+(?:full\s+)?create\s+[a-z_]+\s+\S', re.I)


def _split_sql(sql):
    """按分号切语句（跳过 '' / "" / `` 里的分号），返回非空语句列表"""
    out, buf = [], []
    quote = None
    text = str(sql or '')
    i = 0
    while i < len(text):
        ch = text[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                if i + 1 < len(text) and text[i + 1] == quote:      # '' 转义
                    buf.append(text[i + 1])
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if ch in ('\'', '"', '`'):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == ';':
            piece = ''.join(buf).strip()
            if piece:
                out.append(piece)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    piece = ''.join(buf).strip()
    if piece:
        out.append(piece)
    return out


def _strip_literals(text):
    """把字符串字面量换成空串（只用于关键字判断，避免 'update' 这样的取值被误判）"""
    out, quote, i = [], None, 0
    text = str(text or '')
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == quote:
                if i + 1 < len(text) and text[i + 1] == quote:
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if ch in ('\'', '"', '`'):
            quote = ch
            i += 1
            continue
        out.append(ch)
        i += 1
    return ''.join(out)


def _check_sql(sql):
    """校验并返回可执行的那一条语句（规则见上方注释）"""
    text = str(sql or '').strip()
    if not text:
        raise ConnError('请输入要执行的 SQL')
    pieces = [p for p in _split_sql(text) if _COMMENT_HEAD.sub('', p).strip()]
    if not pieces:
        raise ConnError('请输入要执行的 SQL')
    if len(pieces) > 1:
        raise ConnError('一次只能执行一条 SQL（检测到 %d 条），请只保留一条再执行' % len(pieces))
    stmt = pieces[0]
    body = _COMMENT_HEAD.sub('', stmt).strip()
    matched = re.match(r'([A-Za-z_]+)', body)
    head = matched.group(1).lower() if matched else ''
    if not head:
        raise ConnError('无法识别的 SQL 语句')
    if head not in QUERY_HEADS:
        raise ConnError('数据中心只允许执行查询语句（SELECT / SHOW / DESC / EXPLAIN / PRAGMA），'
                        '写操作（%s）已被禁止' % head.upper())
    # SHOW CREATE …：只读的元数据读取，语句正文里的 CREATE 不算写操作
    if _SHOW_CREATE.match(body):
        return head, stmt
    found = _WRITE_WORDS.search(_strip_literals(body))
    if found:
        raise ConnError('语句里包含写操作关键字「%s」，数据中心只允许查询，已终止执行'
                        % found.group(1).upper())
    return head, stmt


def _jsonable(value, mssql=False):
    """查询结果里的值转成前端能直接显示的东西（日期 / 小数 / 二进制都不抛异常）

    mssql=True 时额外把「被当成 ISO-8859-1 的 GBK 字节」还原成中文，
    见 `_mssql_fix_text()`（只用于 SQL Server 的结果集，别的库不动）。
    """
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _mssql_fix_text(value) if mssql else value
    if isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
        for codec in (('utf-8', 'gbk') if mssql else ('utf-8',)):
            try:
                return raw.decode(codec)
            except Exception:
                continue
        return '0x' + raw.hex()[:120]
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return str(value)
    if isinstance(value, decimal.Decimal):
        return str(value)
    return str(value)


def _fetch(cur, stmt, head, max_rows, label, args=None, mssql=False):
    """执行一条查询并取回结果（始终不提交事务）"""
    row_limit = max(1, int(max_rows or config.DBINFO_SQL_MAX_ROWS))
    started = time.time()
    try:
        if args:
            cur.execute(stmt, args)
        else:
            cur.execute(stmt)
    except Exception as exc:
        raise ConnError('%s 执行失败：%s' % (label, _clean_exc(exc)))
    desc = getattr(cur, 'description', None)
    if not desc:                                  # 没有结果集（极少数 PRAGMA / SHOW 变体）
        try:
            affected = int(cur.rowcount or 0)
        except (TypeError, ValueError):
            affected = 0
        return {'statement': head.upper(), 'columns': [], 'rows': [],
                'rowCount': affected, 'affected': affected, 'truncated': False,
                'elapsed': int((time.time() - started) * 1000),
                'message': '执行成功，影响 %d 行' % affected}
    names = [str(one[0]) for one in desc]
    try:
        rows = cur.fetchmany(row_limit + 1)
    except Exception as exc:
        raise ConnError('读取查询结果失败：%s' % _clean_exc(exc))
    truncated = len(rows) > row_limit
    rows = rows[:row_limit]
    out_rows = []
    for row in rows:
        try:
            out_rows.append([_jsonable(v, mssql) for v in row])
        except Exception:                          # 单行取值异常不影响整批
            out_rows.append([_jsonable(row[i], mssql) if i < len(row) else None
                             for i in range(len(names))])
    return {'statement': head.upper(),
            'columns': [{'name': n, 'index': i} for i, n in enumerate(names)],
            'rows': out_rows, 'rowCount': len(out_rows), 'affected': None,
            'truncated': truncated,
            'elapsed': int((time.time() - started) * 1000),
            'message': '执行成功，返回 %d 行%s' % (len(out_rows),
                                                  '（已截断，仅显示前 %d 行）' % row_limit
                                                  if truncated else '')}


def _query_conn(conf, database):
    """按类型开一个只读查询用的连接（MySQL / SQL Server 切库，PostgreSQL 换库，SQLite 单库）"""
    db_type = str((conf or {}).get('dbType') or '').lower()
    database = str(database or '').strip()
    if db_type in ('mysql', 'mariadb'):
        return _mysql_connect(conf), db_type, database
    if db_type == 'sqlite':
        return _sqlite_connect(conf), db_type, ''
    if db_type == 'postgresql':
        return _pg_connect(dict(conf, dbName=database or conf.get('dbName') or 'postgres')), db_type, database
    if db_type == 'sqlserver':
        return _mssql_connect(dict(conf, dbName=database or conf.get('dbName') or 'master')), db_type, database
    if db_type == 'oracle':
        return _oracle_connect(conf), db_type, database
    raise ConnError('暂不支持该数据库类型：%s' % (db_type or '空'))


def _open_conn(conf, database):
    """开连接 + （MySQL 系）切到页面上选中的实例；返回 (conn, dbType, database)"""
    conn, db_type, db = _query_conn(conf, database)
    if db_type in ('mysql', 'mariadb') and db:
        cur = None
        try:
            cur = conn.cursor()
            cur.execute('USE `%s`' % str(db).replace('`', '``'))
        except Exception as exc:
            raise ConnError('切换到实例「%s」失败：%s' % (db, _clean_exc(exc)))
        finally:
            try:
                if cur is not None:
                    cur.close()
            except Exception:
                pass
    return conn, db_type, db


def query(conf, database, sql, max_rows=None, values=None):
    """
    在目标连接上执行一条查询语句（只读）
    :param values dict 报表参数值：SQL 里的 :参数名 会换成方言占位符并按顺序绑定
    :return {statement, columns:[{name,index}], rows:[[...]], rowCount, truncated, elapsed, database, message}
    :raise ConnError 语句被拒绝 / 执行失败
    """
    db_type_of_conf = str((conf or {}).get('dbType') or '').lower()
    sql_args = None
    if values is not None:
        sql, sql_args = bind_params(sql, values, db_type_of_conf)
    head, stmt = _check_sql(sql)
    label = type_label((conf or {}).get('dbType'))
    # 没选实例时用连接里配的「默认库」（SQLite 是库文件，不需要切库）
    if not str(database or '').strip() and db_type_of_conf != 'sqlite':
        database = str((conf or {}).get('dbName') or '').strip()
    conn, db_type, db = _open_conn(conf, database)
    cur = None
    try:
        cur = conn.cursor()
        result = _fetch(cur, stmt, head, max_rows, label, sql_args,
                        mssql=(db_type == 'sqlserver'))
        result['dbType'] = db_type
        result['database'] = db or str((conf or {}).get('dbName') or '')
        result['executedAt'] = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        result['maxRows'] = max(1, int(max_rows or config.DBINFO_SQL_MAX_ROWS))
        # 回显给人看的 SQL：MySQL 系为了让 PyMySQL 的 % 格式化过关，字面量的 % 会临时双写成 %%，
        # 这里还原回去，前端 / 日志里看到的就是用户自己写的那条语句
        # Oracle 用 :1 绑定、字面量的 % 没被双写，不需要还原
        result['sql'] = (stmt.replace('%%', '%')
                         if (sql_args and db_type not in ('sqlite', 'oracle')) else stmt)
        result['bindCount'] = len(sql_args or [])
        return result
    finally:
        try:                                       # 绝不提交：即便判断漏了也写不进库
            conn.rollback()
        except Exception:
            pass
        try:
            if cur is not None:
                cur.close()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass


# ---------------------------------------------------------------- 数据浏览（表 / 视图数据：分页 + 排序 + 过滤） ----------------------------------------------------------------
# 与 SQL 工作台一样是**只读**的：只拼 SELECT，参数全部走占位符，标识符（表名 / 字段名）先做白名单校验再按方言加引号，
# 取完结果一律 rollback。排序与过滤只作用于这一页数据，不改目标库。
ROW_OPS = {
    'eq': '=', 'ne': '<>', 'gt': '>', 'ge': '>=', 'lt': '<', 'le': '<=',
    'contains': 'like', 'starts': 'like', 'ends': 'like',
    'null': 'is null', 'notnull': 'is not null',
}
ROW_FILTER_LABELS = {
    'eq': '等于', 'ne': '不等于', 'gt': '大于', 'ge': '大于等于', 'lt': '小于', 'le': '小于等于',
    'contains': '包含', 'starts': '开头是', 'ends': '结尾是',
    'null': '为空', 'notnull': '不为空',
}
# 标识符白名单：字母/数字/下划线（\w 在本项目里也覆盖中文）+ 少量常见符号；不允许引号、点、分号
_IDENT_RE = re.compile(r'^[\w $#@]+$')


def quote_ident(name, db_type, label='对象名'):
    """校验并按方言给标识符加引号（MySQL 反引号 / SQL Server 中括号 / 其余双引号）"""
    text = str(name or '').strip()
    if not text:
        raise ConnError('%s不能为空' % label)
    if len(text) > 64 or not _IDENT_RE.match(text):
        raise ConnError('%s不合法：%s（只允许字母、数字、下划线、中文与空格）' % (label, text[:40]))
    if db_type == 'sqlserver':
        return '[' + text.replace(']', ']]') + ']'
    if db_type in ('mysql', 'mariadb', 'sqlite'):
        return '`' + text.replace('`', '``') + '`'
    return '"' + text.replace('"', '""') + '"'


def _placeholder(db_type, index=1):
    """
    参数占位符（按方言）：
      · SQLite → ?
      · Oracle → :1 / :2 …（python-oracledb 的数字位置绑定；同一个 SQL 里要按顺序编号）
      · MySQL / PostgreSQL / SQL Server → %s（PyMySQL / psycopg2 / pymssql 的格式）
    :param index 第几个绑定值（从 1 开始，只有 Oracle 用得到）
    """
    if db_type == 'sqlite':
        return '?'
    if db_type == 'oracle':
        try:
            n = int(index)
        except (TypeError, ValueError):
            n = 1
        return ':%d' % max(1, n)
    return '%s'


# ---------------------------------------------------------------- 报表参数绑定 ----------------------------------------------------------------
# 报表 SQL 里用 :参数名 写占位（如 WHERE hireDate >= :beginDate AND deptId = :deptId），
# 由 bind_params 换成该方言的占位符并按出现顺序绑定值：
#   · 引号外的 :name 直接换占位符；
#   · **引号内的 :name 也支持**（很多人的写法是 LIKE '%:name%'）：把整个字符串字面量拆成
#     CONCAT('前缀', %s, '后缀')（SQLite / PostgreSQL 用 || 拼接，Oracle 用嵌套两参 CONCAT），
#     值仍然走占位符绑定，不拼字符串；
#   · 只替换「参数定义里真的有」的名字 —— 字符串里的时间 '10:30'、路径 'C:\\x' 不会被误伤；
#   · `::` 视为类型转换（PostgreSQL / Oracle），不当作参数；反引号里是标识符，不处理参数；
#   · 同一个参数可以出现多次（每次都会追加一份值）；
#   · 引号内的参数如果值为 None，按空串拼接（否则 CONCAT(…, NULL, …) 会让整行计算结果为 NULL，
#     报表一运行就是 0 行）；引号外的 None 保持 NULL，好让 `:x IS NULL` 这类判断还能用；
#   · MySQL 系占位符是 %s，PyMySQL 用 `sql % args` 做格式化，所以语句里**字面量的 %** 必须写成 %%，
#     否则 LIKE '%张%' 这种写法会报 "unsupported format character"（只在真的有参数绑定时才需要）。
_PARAM_RE = re.compile(r':([A-Za-z_][A-Za-z0-9_]*)')
_CONCAT_TYPES = ('sqlite', 'postgresql')


def _quote_literal(text):
    """把一段文本包成 SQL 字符串字面量（单引号按 '' 转义）"""
    return "'" + str(text).replace("'", "''") + "'"


def _concat_sql(pieces, db_type):
    """把「字面量 / 占位符」片段拼成一个表达式（各库的字符串拼接写法不同）"""
    if len(pieces) == 1:
        return pieces[0]
    if db_type in _CONCAT_TYPES:
        return ' || '.join(pieces)
    if db_type == 'oracle':                     # Oracle 的 CONCAT 只吃两个参数，只能嵌套
        out = pieces[0]
        for one in pieces[1:]:
            out = 'CONCAT(%s, %s)' % (out, one)
        return out
    return 'CONCAT(%s)' % ', '.join(pieces)


def _split_literal_params(raw, values):
    """把字符串字面量的内容按 :参数名 切开；没有可用参数时返回 (None, [])"""
    pieces, names, last, matched_any = [], [], 0, False
    i = 0
    while i < len(raw):
        if raw[i] == ':':
            found = _PARAM_RE.match(raw, i)
            if found and found.group(1) in values:
                if i > last:
                    pieces.append(raw[last:i])
                pieces.append(('param', found.group(1)))
                names.append(found.group(1))
                matched_any = True
                i = found.end()
                last = i
                continue
        i += 1
    if not matched_any:
        return None, []
    if last < len(raw):
        pieces.append(raw[last:])
    return pieces, names


def bind_params(sql, values, db_type):
    """把 SQL 里的 :参数名 换成方言占位符（引号内也能用）；返回 (新 SQL, 按顺序排列的参数值列表)"""
    text = str(sql or '')
    values = values or {}
    out, args = [], []

    def ph():
        """下一个占位符（Oracle 要 :1 :2 逐个编号，其它方言是定值）"""
        return _placeholder(db_type, len(args) + 1)

    i = 0
    while i < len(text):
        ch = text[i]

        # ---- 字符串字面量：支持 LIKE '%:name%' 这种写法 ----
        if ch in ('\'', '"'):
            quote = ch
            j = i + 1
            buf = []
            while j < len(text):
                if text[j] == quote:
                    if j + 1 < len(text) and text[j + 1] == quote:   # '' 转义
                        buf.append(quote)
                        j += 2
                        continue
                    break
                buf.append(text[j])
                j += 1
            closed = j < len(text)
            pieces, names = _split_literal_params(''.join(buf), values)
            if pieces is None:
                out.append(text[i:j + 1] if closed else text[i:])
            else:
                built = []
                for one in pieces:
                    if isinstance(one, tuple):
                        value = values.get(one[1])
                        built.append(ph())
                        args.append('' if value is None else value)
                    else:
                        built.append(_quote_literal(one))
                out.append(_concat_sql(built, db_type))
            i = (j + 1) if closed else len(text)
            continue

        # ---- 反引号里是标识符，不处理参数 ----
        if ch == '`':
            j = text.find('`', i + 1)
            if j < 0:
                out.append(text[i:])
                break
            out.append(text[i:j + 1])
            i = j + 1
            continue

        # ---- 引号外的 :参数名 ----
        if ch == ':':
            prev = text[i - 1] if i > 0 else ''
            nxt = text[i + 1] if i + 1 < len(text) else ''
            if prev == ':' or nxt == ':':                            # ::类型转换
                out.append(ch)
                i += 1
                continue
            matched = _PARAM_RE.match(text, i)
            if matched:
                name = matched.group(1)
                if name not in values:
                    raise ConnError('SQL 里的参数「:%s」没有定义，请在「报表参数」里补上' % name)
                # 先取占位符（编号依赖当前 args 长度），再追加值
                out.append(ph())
                args.append(values[name])
                i = matched.end()
                continue
        out.append(ch)
        i += 1
    stmt = ''.join(out)
    if args and _placeholder(db_type) == '%s':
        # 只有 %s 方言（PyMySQL / psycopg2 / pymssql 驱动还会再做一次 % 格式化）才需要把字面量里的 % 双写；
        # Oracle 用 :1 绑定，不能动 %（否则 LIKE '%x%' 会被写成 '%%x%%'）
        stmt = stmt.replace('%s', '\x00').replace('%', '%%').replace('\x00', '%s')
    return stmt, args


def auto_report_sql(db_type, table, fields):
    """报表没写 SQL 时：按主表 + 列定义自动拼 SELECT（标识符走白名单 + 方言引号）"""
    table_sql = quote_ident(table, db_type, '表或视图名')
    picked = []
    for name in (fields or []):
        text = str(name or '').strip()
        if text and text not in picked:
            picked.append(text)
    cols = [quote_ident(one, db_type, '字段名') for one in picked]
    return 'SELECT %s FROM %s' % (', '.join(cols) if cols else '*', table_sql)


def _filters_sql(filters, db_type, label='字段'):
    """
    过滤条件 → (WHERE 片段, 参数列表)
      · 支持 等于/不等于/大于/大于等于/小于/小于等于/包含/开头是/结尾是/为空/不为空；
      · 字段名走 quote_ident 白名单，值一律占位符绑定（不拼字符串，防注入）；
      · 「包含」类用 LIKE，用户输入的 % 与 _ 会被当成通配符（数据浏览器里这样更实用）。
    """
    items = filters or []
    if isinstance(items, str):
        try:
            items = json.loads(items) if items.strip() else []
        except ValueError:
            raise ConnError('过滤条件格式不正确（应为 JSON 数组）')
    if not isinstance(items, (list, tuple)):
        raise ConnError('过滤条件格式不正确（应为数组）')
    clauses, args = [], []

    def ph():
        """下一个占位符（Oracle 按 args 顺序编号）"""
        return _placeholder(db_type, len(args) + 1)

    for one in items:
        if not isinstance(one, dict):
            continue
        column = str(one.get('column') or '').strip()
        op = str(one.get('op') or 'eq').strip().lower()
        if not column:
            continue
        quoted = quote_ident(column, db_type, label)
        if op not in ROW_OPS:
            raise ConnError('不支持的过滤方式：%s' % op)
        if op == 'null':
            clauses.append('%s IS NULL' % quoted)
            continue
        if op == 'notnull':
            clauses.append('%s IS NOT NULL' % quoted)
            continue
        value = one.get('value')
        value = '' if value is None else str(value)
        if op == 'contains':
            clauses.append('%s LIKE %s' % (quoted, ph()))
            args.append('%' + value + '%')
            continue
        if op == 'starts':
            clauses.append('%s LIKE %s' % (quoted, ph()))
            args.append(value + '%')
            continue
        if op == 'ends':
            clauses.append('%s LIKE %s' % (quoted, ph()))
            args.append('%' + value)
            continue
        symbol = ROW_OPS[op]
        clauses.append('%s %s %s' % (quoted, symbol, ph()))
        args.append(value)
    return ((' WHERE ' + ' AND '.join(clauses)) if clauses else ''), args


def _page_sql(db_type, table_sql, where_sql, order_sql, size, offset, where_args,
              mssql_mode='offset'):
    """拼「取一页数据」的 SQL（各库分页写法不同）"""
    base = len(list(where_args or []))              # Oracle 的 :1..:N 要接着 WHERE 里已用的编号往下排
    ph = lambda n: _placeholder(db_type, base + n)  # noqa: E731
    if db_type == 'sqlserver':
        if str(mssql_mode or 'offset').lower() == 'rank':
            # SQL Server 2005 / 2008（以及兼容级别还停在 100 的库）没有 OFFSET … FETCH：
            # 用 ROW_NUMBER() 包一层子查询，外层按行号取区间；
            # __rn 只是排位用的辅助列，rows() 会把它从结果里剥掉，不会出现在网格里
            inner_order = order_sql.strip() or 'ORDER BY (SELECT NULL)'
            return ('SELECT * FROM (SELECT ROW_NUMBER() OVER (%s) AS __rn, * FROM %s%s) __t '
                    'WHERE __rn > %s AND __rn <= %s ORDER BY __rn'
                    % (inner_order, table_sql, where_sql, ph(1), ph(2)),
                    list(where_args) + [offset, offset + size])
        order = order_sql or ' ORDER BY (SELECT NULL)'      # SQL Server 的 OFFSET 必须有 ORDER BY
        return ('SELECT * FROM %s%s%s OFFSET %s ROWS FETCH NEXT %s ROWS ONLY'
                % (table_sql, where_sql, order, ph(1), ph(2)), list(where_args) + [offset, size])
    if db_type == 'oracle':
        return ('SELECT * FROM %s%s%s OFFSET %s ROWS FETCH NEXT %s ROWS ONLY'
                % (table_sql, where_sql, order_sql, ph(1), ph(2)), list(where_args) + [offset, size])
    return ('SELECT * FROM %s%s%s LIMIT %s OFFSET %s'
            % (table_sql, where_sql, order_sql, ph(1), ph(2)), list(where_args) + [size, offset])


# SQL Server 分页方式缓存：'offset'（2012+ 支持 OFFSET … FETCH）/ 'rank'（2005、2008 或兼容级别太低）
# key = host:port/库名 —— 同一个实例里不同库的兼容级别可能不同，所以带上库名
_MSSQL_PAGE_MODES = {}


def _mssql_cache_key(conf):
    conf = conf or {}
    return '%s:%s/%s' % (conf.get('host') or '', conf.get('port') or '', conf.get('dbName') or '')


def _mssql_page_mode(conn, conf):
    """
    先按服务器主版本号猜这台 SQL Server 能不能用 OFFSET … FETCH（2012 = 主版本 11 起才支持）
      · 2005 / 2008 直接写 OFFSET 会报 `102 Incorrect syntax near 'OFFSET'` → 改走 ROW_NUMBER；
      · 库的兼容级别还停在 2008（100）时，装在 2012+ 上同样不认 OFFSET —— 这种猜不出来，
        由 rows() 执行失败后回退并改写缓存；
      · 版本查不到（没权限等）就保守按老版本处理，反正 ROW_NUMBER 2005 起都有。
    """
    key = _mssql_cache_key(conf)
    if key in _MSSQL_PAGE_MODES:
        return _MSSQL_PAGE_MODES[key]
    mode = 'rank'
    cur = None
    try:
        cur = conn.cursor()
        cur.execute("SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(64))")
        row = cur.fetchone()
        major = int(str((row or [''])[0] or '').split('.')[0])
        mode = 'offset' if major >= 11 else 'rank'
    except Exception:
        mode = 'rank'
    finally:
        try:
            if cur is not None:
                cur.close()
        except Exception:
            pass
    _MSSQL_PAGE_MODES[key] = mode
    return mode



def rows(conf, database, table, page_num=1, page_size=100,
         order_by='', order_dir='', filters=None):
    """
    读某张表 / 视图的一页数据（只读）
    :param page_num int 页码（从 1 开始）
    :param page_size int 每页行数（1~500）
    :param order_by str 排序字段（空 = 不排序，按库默认顺序）
    :param order_dir str asc / desc
    :param filters list [{column, op, value}]
    :return {columns:[名称...], rows:[[...]], total, pageNum, pageSize, pages, hasMore,
             orderBy, orderDir, filters, elapsed, database, table, dbType}
    """
    db_type_of_conf = str((conf or {}).get('dbType') or '').lower()
    name = str(table or '').strip()
    if not name:
        raise ConnError('请先选择要查看数据的表或视图')
    try:
        page = max(1, int(page_num or 1))
    except (TypeError, ValueError):
        page = 1
    try:
        size = min(max(int(page_size or 100), 1), 500)
    except (TypeError, ValueError):
        size = 100
    offset = (page - 1) * size
    if not str(database or '').strip() and db_type_of_conf != 'sqlite':
        database = str((conf or {}).get('dbName') or '').strip()
    label = type_label(db_type_of_conf)
    conn, db_type, db = _open_conn(conf, database)
    started = time.time()
    cur = None
    try:
        table_sql = quote_ident(name, db_type, '表或视图名')
        where_sql, where_args = _filters_sql(filters, db_type)
        order_sql = ''
        order_col = ''
        if order_by:
            order_col = str(order_by).strip()
            direction = 'DESC' if str(order_dir or '').lower() == 'desc' else 'ASC'
            order_sql = ' ORDER BY ' + quote_ident(order_col, db_type) + ' ' + direction
        # 先探测 SQL Server 的分页语法（要单独开 cursor，放在 count 之前，免得抢同一个 cursor 上未读完的结果）
        mssql_mode = 'offset'
        if db_type == 'sqlserver':
            mssql_mode = _mssql_page_mode(conn, conf)
        cur = conn.cursor()
        total = None
        try:                                     # 总行数拿不到不影响看数据（大表 count 可能超时）
            cur.execute('SELECT COUNT(*) FROM %s%s' % (table_sql, where_sql), where_args)
            first = cur.fetchone()
            total = int(first[0] or 0) if first else 0
        except Exception:
            total = None
        sql, args = _page_sql(db_type, table_sql, where_sql, order_sql, size, offset, where_args,
                              mssql_mode=mssql_mode)
        try:
            cur.execute(sql, args)
        except Exception as exc:
            message = _clean_exc(exc)
            # 兼容级别还停在 2008（100）的库，即使装在 2012+ 也不认 OFFSET：
            # 换成 ROW_NUMBER 再试一次，并把结论记住（不用以后每一页都先失败一遍）
            if db_type == 'sqlserver' and mssql_mode == 'offset' and 'OFFSET' in message.upper():
                _MSSQL_PAGE_MODES[_mssql_cache_key(conf)] = 'rank'
                sql, args = _page_sql(db_type, table_sql, where_sql, order_sql, size, offset,
                                      where_args, mssql_mode='rank')
                try:
                    cur.execute(sql, args)
                except Exception as again:
                    raise ConnError('%s 读取数据失败：%s' % (label, _clean_exc(again)))
            else:
                raise ConnError('%s 读取数据失败：%s' % (label, message))
        desc = getattr(cur, 'description', None) or []
        names = [str(one[0]) for one in desc]
        try:
            raw = cur.fetchmany(size)
        except Exception as exc:
            raise ConnError('读取数据失败：%s' % _clean_exc(exc))
        out = []
        is_mssql = db_type == 'sqlserver'
        for row in raw:
            out.append([_jsonable(value, is_mssql) for value in row])
        # 老版本 SQL Server 用 ROW_NUMBER 分页时带出来的排位辅助列，别显示到网格里
        rank_at = -1
        for idx, one in enumerate(names):
            if one.lower() == '__rn':
                rank_at = idx
                break
        if rank_at >= 0:
            names.pop(rank_at)
            for one in out:
                if len(one) > rank_at:
                    one.pop(rank_at)
        pages = max(1, int(math.ceil(total / float(size)))) if total else 1
        has_more = (offset + len(out)) < total if total is not None else (len(out) >= size)
        return {'columns': names, 'rows': out, 'total': total,
                'pageNum': page, 'pageSize': size, 'pages': pages, 'hasMore': has_more,
                'orderBy': order_col,
                'orderDir': ('desc' if str(order_dir or '').lower() == 'desc' else 'asc') if order_col else '',
                'filters': [one for one in (filters or []) if isinstance(one, dict)],
                'elapsed': int((time.time() - started) * 1000),
                'database': db or str((conf or {}).get('dbName') or ''),
                'table': name, 'dbType': db_type}
    finally:
        try:                                     # 只读：绝不提交
            conn.rollback()
        except Exception:
            pass
        try:
            if cur is not None:
                cur.close()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass
