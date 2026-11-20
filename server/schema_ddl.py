# -*- coding: utf-8 -*-
"""
五方言 DDL 生成器（纯函数，不连数据库、不读表）
------------------------------------------------------------------
用途：应用架构（appschema）把「逻辑类型」的结构描述渲染成各类数据库的建表 / 改表脚本。

支持方言：mysql / mariadb、postgresql、oracle、sqlserver、sqlite

设计口径：
  · 设计态**只存逻辑类型**（VARCHAR / INT / DECIMAL / DATETIME ...），物理类型由本模块按方言渲染。
    这样手工维护一个 Oracle 应用时不用为每个字段选 VARCHAR2，也不会出现「varchar / VARCHAR / string」
    三种写法混在一张表里；
  · 字段注释：MySQL 内联 COMMENT，PostgreSQL / Oracle 用 COMMENT ON，SQL Server 用
    sp_addextendedproperty，SQLite 不支持（脚本里用注释行说明）；
  · 改列：MySQL MODIFY COLUMN、PostgreSQL ALTER COLUMN TYPE + SET/DROP、Oracle MODIFY、
    SQL Server ALTER COLUMN、**SQLite 走重建表（12 步简化版）**；
  · SQLite 不支持改类型 / 加约束 / 删约束，遇到这类变更整表重建（新建 _new → 复制 → 删旧 → 改名）；
  · 生成的语句**不带分号**，由 join_statements() 统一加；SQL Server 用 GO 分批。

对外：
  LOGICAL_TYPES            逻辑类型下拉（前端直接用）
  canonical_type(raw)      物理类型 → (逻辑类型, 长度)
  render_column / create_table / alter_table / drop_object / create_object
  join_statements(db_type, statements)
  header(db_type, kind, title, notes)
"""
import re

# ---------------------------------------------------------------- 逻辑类型 ----
# hasLength：是否需要长度 / 精度（VARCHAR 要长度，DECIMAL 要精度，DATETIME 不要）
LOGICAL_TYPES = [
    {'value': 'VARCHAR', 'label': '变长字符串', 'hasLength': True, 'lengthHint': '如 100'},
    {'value': 'CHAR', 'label': '定长字符串', 'hasLength': True, 'lengthHint': '如 10'},
    {'value': 'TEXT', 'label': '长文本', 'hasLength': False},
    {'value': 'INT', 'label': '整数', 'hasLength': False},
    {'value': 'BIGINT', 'label': '长整数', 'hasLength': False},
    {'value': 'SMALLINT', 'label': '短整数', 'hasLength': False},
    {'value': 'DECIMAL', 'label': '精确小数', 'hasLength': True, 'lengthHint': '如 12,2'},
    {'value': 'FLOAT', 'label': '单精度小数', 'hasLength': False},
    {'value': 'DOUBLE', 'label': '双精度小数', 'hasLength': False},
    {'value': 'BOOLEAN', 'label': '布尔', 'hasLength': False},
    {'value': 'DATE', 'label': '日期', 'hasLength': False},
    {'value': 'DATETIME', 'label': '日期时间', 'hasLength': False},
    {'value': 'TIME', 'label': '时间', 'hasLength': False},
    {'value': 'BLOB', 'label': '二进制', 'hasLength': False},
    {'value': 'JSON', 'label': 'JSON', 'hasLength': False},
    {'value': 'UUID', 'label': 'UUID', 'hasLength': False},
]
TYPE_VALUES = [one['value'] for one in LOGICAL_TYPES]

DB_LABELS = {
    'mysql': 'MySQL', 'mariadb': 'MariaDB', 'postgresql': 'PostgreSQL',
    'oracle': 'Oracle', 'sqlserver': 'SQL Server', 'sqlite': 'SQLite',
}

# 物理类型（小写、去空格）→ 逻辑类型。扫描导入时用它把 information_schema 的
# 类型文本折成逻辑类型；匹配不上的按 VARCHAR 兜底（宁可宽松，也不要导入失败）。
_RAW_TYPE_MAP = {
    'varchar': 'VARCHAR', 'varchar2': 'VARCHAR', 'nvarchar': 'VARCHAR', 'nvarchar2': 'VARCHAR',
    'char': 'CHAR', 'nchar': 'CHAR', 'bpchar': 'CHAR',
    'text': 'TEXT', 'tinytext': 'TEXT', 'mediumtext': 'TEXT', 'longtext': 'TEXT',
    'clob': 'TEXT', 'nclob': 'TEXT', 'ntext': 'TEXT',
    'int': 'INT', 'integer': 'INT', 'int4': 'INT', 'mediumint': 'INT', 'number': 'INT',
    'bigint': 'BIGINT', 'int8': 'BIGINT',
    'smallint': 'SMALLINT', 'int2': 'SMALLINT', 'tinyint': 'SMALLINT',
    'decimal': 'DECIMAL', 'numeric': 'DECIMAL', 'dec': 'DECIMAL', 'money': 'DECIMAL',
    'float': 'FLOAT', 'real': 'FLOAT', 'binary_float': 'FLOAT',
    'double': 'DOUBLE', 'double precision': 'DOUBLE', 'binary_double': 'DOUBLE',
    'bool': 'BOOLEAN', 'boolean': 'BOOLEAN', 'bit': 'BOOLEAN',
    'date': 'DATE',
    'datetime': 'DATETIME', 'datetime2': 'DATETIME', 'smalldatetime': 'DATETIME',
    'timestamp': 'DATETIME', 'timestamp without time zone': 'DATETIME',
    'timestamptz': 'DATETIME', 'timestamp with time zone': 'DATETIME',
    'time': 'TIME', 'time without time zone': 'TIME',
    'blob': 'BLOB', 'tinyblob': 'BLOB', 'mediumblob': 'BLOB', 'longblob': 'BLOB',
    'bytea': 'BLOB', 'varbinary': 'BLOB', 'binary': 'BLOB', 'image': 'BLOB',
    'raw': 'BLOB', 'long raw': 'BLOB',
    'json': 'JSON', 'jsonb': 'JSON',
    'uuid': 'UUID', 'uniqueidentifier': 'UUID',
}

# 数值型（默认值不加引号）
_NUMERIC = ('INT', 'BIGINT', 'SMALLINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'BOOLEAN')


def db_label(db_type):
    return DB_LABELS.get(str(db_type or '').lower(), str(db_type or ''))


def normalize_db_type(db_type):
    value = str(db_type or '').strip().lower()
    if value == 'mssql':
        value = 'sqlserver'
    if value == 'pg' or value == 'postgres':
        value = 'postgresql'
    if value not in DB_LABELS:
        value = 'mysql'
    return value


def canonical_type(raw):
    """物理类型文本 → (逻辑类型, 长度)。如 'varchar(100)' → ('VARCHAR','100')；
    'number(12,2)' → ('DECIMAL','12,2')；'int(11) unsigned' → ('INT','')。"""
    text = str(raw or '').strip()
    if not text:
        return 'VARCHAR', ''
    length = ''
    raw_inner = ''
    m = re.search(r'\(([^)]*)\)', text)
    if m:
        raw_inner = re.sub(r'\s+', ' ', m.group(1)).strip()
        # nvarchar(max) / varchar(max)：SQL Server 的「不限长」按长文本处理
        if raw_inner.lower() == 'max':
            return 'TEXT', ''
        length = re.sub(r'\b(char|byte|character)\b', '', raw_inner, flags=re.I).strip()
        if length and not re.match(r'^\d+(\s*,\s*\d+)?$', length):
            length = ''            # 不是「数字」或「数字,数字」的，丢掉（如 enum 的枚举值）
    base = re.sub(r'\([^)]*\)', '', text).strip().lower()
    base = re.sub(r'\b(unsigned|zerofill|with(out)? time zone|identity)\b', '', base).strip()
    base = re.sub(r'\s+', ' ', base)
    logical = _RAW_TYPE_MAP.get(base)
    if not logical:
        for key, value in _RAW_TYPE_MAP.items():      # 'varchar2 ' 这类带尾巴的
            if base.startswith(key):
                logical = value
                break
    if not logical:
        logical = 'VARCHAR'
    # tinyint(1) 在 MySQL 里是布尔（扫描时按 BOOLEAN 理解更贴近业务）
    if logical == 'SMALLINT' and base == 'tinyint' and length == '1':
        logical = 'BOOLEAN'
    if logical == 'INT' and base == 'number' and length and ',' in length:
        logical = 'DECIMAL'
    # 只有字符串 / 精确小数需要长度，其余长度一律丢掉（避免 INT(11)、BOOLEAN(1) 这种无意义精度）
    if logical not in ('VARCHAR', 'CHAR', 'DECIMAL'):
        length = ''
    return logical, length


def _length_pair(length, default=''):
    """'12,2' → ('12','2')；'100' → ('100','')；空 → default 拆开"""
    text = str(length or '').strip() or str(default or '').strip()
    if not text:
        return '', ''
    parts = [one.strip() for one in text.split(',')]
    first = parts[0] if parts else ''
    second = parts[1] if len(parts) > 1 else ''
    return first, second


def _varchar_len(length, fallback='255'):
    first, _ = _length_pair(length, fallback)
    if not first or not first.isdigit():
        return fallback
    return first


# ---------------------------------------------------------------- 标识符 ----
_IDENT_RE = re.compile(r'^[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5 ]*$')


def quote(db_type, name, label='对象名'):
    """按方言给标识符加引号；名字不合规（空 / 含引号 / 分号等）直接抛 ValueError"""
    text = str(name or '').strip()
    if not text:
        raise ValueError('%s不能为空' % label)
    if len(text) > 120 or not _IDENT_RE.match(text):
        raise ValueError('%s不合法：%s（只允许字母、数字、下划线、中文与空格）' % (label, text[:40]))
    db_type = normalize_db_type(db_type)
    if db_type == 'sqlserver':
        return '[' + text.replace(']', ']]') + ']'
    if db_type in ('mysql', 'mariadb'):
        return '`' + text.replace('`', '``') + '`'
    return '"' + text.replace('"', '""') + '"'


def _literal(text):
    """字符串字面量（单引号转义两遍，防注入式拼接）"""
    return "'" + str(text).replace("'", "''") + "'"


def _nstr(db_type, text):
    """SQL Server 的扩展属性要用 N'...' 才不乱码"""
    return "N" + _literal(text) if normalize_db_type(db_type) == 'sqlserver' else _literal(text)


# ---------------------------------------------------------------- 类型渲染 ----
def render_type(db_type, logical, length='', auto_inc=False):
    """逻辑类型 → 方言物理类型（含精度）。auto_inc 只影响整数型。"""
    db_type = normalize_db_type(db_type)
    logical = str(logical or 'VARCHAR').upper()
    if logical not in TYPE_VALUES:
        logical = 'VARCHAR'
    n, scale = _length_pair(length)

    if logical == 'VARCHAR':
        size = _varchar_len(length)
        if db_type == 'oracle':
            return 'VARCHAR2(%s CHAR)' % size
        if db_type == 'sqlserver':
            return 'NVARCHAR(%s)' % size
        return 'VARCHAR(%s)' % size
    if logical == 'CHAR':
        size = _varchar_len(length, '10')
        if db_type == 'oracle':
            return 'CHAR(%s CHAR)' % size
        if db_type == 'sqlserver':
            return 'NCHAR(%s)' % size
        return 'CHAR(%s)' % size
    if logical == 'TEXT':
        return {'mysql': 'TEXT', 'mariadb': 'TEXT', 'postgresql': 'TEXT', 'oracle': 'CLOB',
                'sqlserver': 'NVARCHAR(MAX)', 'sqlite': 'TEXT'}[db_type]
    if logical in ('INT', 'BIGINT', 'SMALLINT'):
        if db_type == 'oracle':
            return {'INT': 'NUMBER(10)', 'BIGINT': 'NUMBER(19)', 'SMALLINT': 'NUMBER(5)'}[logical]
        if db_type == 'sqlserver':
            return {'INT': 'INT', 'BIGINT': 'BIGINT', 'SMALLINT': 'SMALLINT'}[logical]
        if db_type == 'postgresql':
            return {'INT': 'INTEGER', 'BIGINT': 'BIGINT', 'SMALLINT': 'SMALLINT'}[logical]
        if db_type == 'sqlite':
            return 'INTEGER'
        return {'INT': 'INT', 'BIGINT': 'BIGINT', 'SMALLINT': 'SMALLINT'}[logical]
    if logical == 'DECIMAL':
        p, s = _length_pair(length, '12,2')
        p = p if p.isdigit() else '12'
        s = s if s.isdigit() else '2'
        if db_type == 'oracle':
            return 'NUMBER(%s,%s)' % (p, s)
        if db_type == 'sqlserver':
            return 'DECIMAL(%s,%s)' % (p, s)
        if db_type == 'sqlite':
            return 'NUMERIC'
        return 'DECIMAL(%s,%s)' % (p, s)
    if logical == 'FLOAT':
        return {'mysql': 'FLOAT', 'mariadb': 'FLOAT', 'postgresql': 'REAL', 'oracle': 'BINARY_FLOAT',
                'sqlserver': 'REAL', 'sqlite': 'REAL'}[db_type]
    if logical == 'DOUBLE':
        return {'mysql': 'DOUBLE', 'mariadb': 'DOUBLE', 'postgresql': 'DOUBLE PRECISION',
                'oracle': 'BINARY_DOUBLE', 'sqlserver': 'FLOAT', 'sqlite': 'REAL'}[db_type]
    if logical == 'BOOLEAN':
        return {'mysql': 'TINYINT(1)', 'mariadb': 'TINYINT(1)', 'postgresql': 'BOOLEAN',
                'oracle': 'NUMBER(1)', 'sqlserver': 'BIT', 'sqlite': 'INTEGER'}[db_type]
    if logical == 'DATE':
        return {'mysql': 'DATE', 'mariadb': 'DATE', 'postgresql': 'DATE', 'oracle': 'DATE',
                'sqlserver': 'DATE', 'sqlite': 'DATE'}[db_type]
    if logical == 'DATETIME':
        return {'mysql': 'DATETIME', 'mariadb': 'DATETIME', 'postgresql': 'TIMESTAMP',
                'oracle': 'TIMESTAMP', 'sqlserver': 'DATETIME2', 'sqlite': 'DATETIME'}[db_type]
    if logical == 'TIME':
        # Oracle 没有纯 TIME 类型，用 DATE 兜住（脚本里会带注释说明）
        return {'mysql': 'TIME', 'mariadb': 'TIME', 'postgresql': 'TIME', 'oracle': 'DATE',
                'sqlserver': 'TIME', 'sqlite': 'TIME'}[db_type]
    if logical == 'BLOB':
        return {'mysql': 'LONGBLOB', 'mariadb': 'LONGBLOB', 'postgresql': 'BYTEA', 'oracle': 'BLOB',
                'sqlserver': 'VARBINARY(MAX)', 'sqlite': 'BLOB'}[db_type]
    if logical == 'JSON':
        return {'mysql': 'JSON', 'mariadb': 'LONGTEXT', 'postgresql': 'JSONB', 'oracle': 'CLOB',
                'sqlserver': 'NVARCHAR(MAX)', 'sqlite': 'TEXT'}[db_type]
    if logical == 'UUID':
        return {'mysql': 'CHAR(36)', 'mariadb': 'CHAR(36)', 'postgresql': 'UUID',
                'oracle': 'VARCHAR2(36 CHAR)', 'sqlserver': 'UNIQUEIDENTIFIER',
                'sqlite': 'VARCHAR(36)'}[db_type]
    return 'VARCHAR(255)'


def render_auto_inc(db_type, logical):
    """自增片段（MySQL / SQL Server / Oracle 跟在类型后；PostgreSQL 用 SERIAL 换类型；SQLite 单列主键特判）"""
    db_type = normalize_db_type(db_type)
    if db_type in ('mysql', 'mariadb'):
        return ' AUTO_INCREMENT'
    if db_type == 'sqlserver':
        return ' IDENTITY(1,1)'
    if db_type == 'oracle':
        return ' GENERATED BY DEFAULT AS IDENTITY'
    return ''


def render_default(db_type, raw, logical):
    """默认值渲染：空 → ''；表达式（CURRENT_TIMESTAMP 等）→ 方言写法；其余按类型决定是否加引号"""
    db_type = normalize_db_type(db_type)
    text = '' if raw is None else str(raw).strip()
    if not text:
        return ''
    upper = text.upper()
    if upper in ('NULL', 'NONE'):
        return ''
    if upper in ('CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()', 'NOW()', 'GETDATE()', 'SYSDATE',
                 'LOCALTIMESTAMP', 'CURRENT_DATE'):
        return {'mysql': 'CURRENT_TIMESTAMP', 'mariadb': 'CURRENT_TIMESTAMP',
                'postgresql': 'CURRENT_TIMESTAMP', 'oracle': 'SYSDATE',
                'sqlserver': 'GETDATE()', 'sqlite': 'CURRENT_TIMESTAMP'}[db_type]
    if upper in ('TRUE', 'FALSE'):
        if db_type in ('postgresql',):
            return upper
        return '1' if upper == 'TRUE' else '0'
    if str(logical).upper() == 'BOOLEAN' and text in ('0', '1'):
        if db_type == 'postgresql':
            return 'TRUE' if text == '1' else 'FALSE'
        return text
    if str(logical).upper() in _NUMERIC and re.match(r'^-?\d+(\.\d+)?$', text):
        return text
    if text.startswith("'") and text.endswith("'"):
        return text
    return _literal(text)


def render_null(nullable):
    return ' NULL' if nullable else ' NOT NULL'


# ---------------------------------------------------------------- 列渲染 ----
def render_column(db_type, col, quote_name=True):
    """一个字段的定义片段（不含注释，注释按方言单独出语句）

    属性顺序按各库的惯用顺序：类型 → NOT NULL → DEFAULT → AUTO_INCREMENT → COMMENT；
    主键 / 自增在 PostgreSQL 用 SERIAL 系类型表达，Oracle / SQL Server 的自增隐含非空。
    """
    db_type = normalize_db_type(db_type)
    name = quote(db_type, col.get('colName'), '字段名') if quote_name else str(col.get('colName'))
    logical = str(col.get('dataType') or 'VARCHAR').upper()
    auto_inc = bool(col.get('isAutoInc'))
    col_type = render_type(db_type, logical, col.get('length'), auto_inc)
    if db_type == 'postgresql' and auto_inc and logical in ('INT', 'BIGINT', 'SMALLINT'):
        col_type = {'INT': 'SERIAL', 'BIGINT': 'BIGSERIAL', 'SMALLINT': 'SMALLSERIAL'}[logical]
    parts = [name, col_type]
    implied_not_null = auto_inc and db_type in ('oracle', 'sqlserver', 'postgresql')
    if not col.get('nullable', True) and not implied_not_null:
        parts.append('NOT NULL')
    default = render_default(db_type, col.get('defaultValue'), logical)
    if default:
        parts.append('DEFAULT ' + default)
    if auto_inc:
        inc = render_auto_inc(db_type, logical).strip()
        if inc:
            parts.append(inc)
    if db_type in ('mysql', 'mariadb') and col.get('colComment'):
        parts.append('COMMENT ' + _literal(col.get('colComment')))
    return ' '.join([one for one in parts if one])


def _pk_cols(table):
    return [one for one in (table.get('columns') or []) if one.get('isPk')]


def _pk_clause(db_type, table):
    cols = _pk_cols(table)
    if not cols:
        return ''
    db_type = normalize_db_type(db_type)
    names = ','.join(quote(db_type, one.get('colName'), '字段名') for one in cols)
    name = str(table.get('objName') or 'table')
    if db_type == 'sqlserver':
        return 'CONSTRAINT %s PRIMARY KEY (%s)' % (quote(db_type, 'PK_' + name), names)
    if db_type in ('postgresql', 'oracle'):
        return 'CONSTRAINT %s PRIMARY KEY (%s)' % (quote(db_type, 'pk_' + name.lower()), names)
    return 'PRIMARY KEY (%s)' % names


def _comment_statements(db_type, db_name, table):
    """PG / Oracle / SQL Server 的注释语句（MySQL 内联、SQLite 不支持）"""
    db_type = normalize_db_type(db_type)
    out = []
    table_name = table.get('objName')
    if db_type == 'postgresql':
        if table.get('objComment'):
            out.append('COMMENT ON TABLE %s IS %s' % (quote(db_type, table_name), _literal(table.get('objComment'))))
        for col in (table.get('columns') or []):
            if col.get('colComment'):
                out.append('COMMENT ON COLUMN %s.%s IS %s' % (
                    quote(db_type, table_name), quote(db_type, col.get('colName')), _literal(col.get('colComment'))))
    elif db_type == 'oracle':
        if table.get('objComment'):
            out.append('COMMENT ON TABLE %s IS %s' % (quote(db_type, table_name), _literal(table.get('objComment'))))
        for col in (table.get('columns') or []):
            if col.get('colComment'):
                out.append('COMMENT ON COLUMN %s.%s IS %s' % (
                    quote(db_type, table_name), quote(db_type, col.get('colName')), _literal(col.get('colComment'))))
    elif db_type == 'sqlserver':
        if table.get('objComment'):
            out.append("EXEC sp_addextendedproperty 'MS_Description', %s, 'SCHEMA','dbo','TABLE',%s"
                       % (_nstr(db_type, table.get('objComment')), _nstr(db_type, table_name)))
        for col in (table.get('columns') or []):
            if col.get('colComment'):
                out.append("EXEC sp_addextendedproperty 'MS_Description', %s, 'SCHEMA','dbo','TABLE',%s,'COLUMN',%s"
                           % (_nstr(db_type, col.get('colComment')), _nstr(db_type, table_name),
                              _nstr(db_type, col.get('colName'))))
    return out


# ---------------------------------------------------------------- 建表 ----
def create_table(db_type, table, name_override=''):
    """CREATE TABLE + 注释（SQLite 会把注释写成 SQL 注释行，因为它不支持列注释）

    :param name_override 临时表名（SQLite 重建表时先用 t__new 建，再改名）
    """
    db_type = normalize_db_type(db_type)
    name = quote(db_type, name_override or table.get('objName'), '表名')
    cols = table.get('columns') or []
    if not cols:
        raise ValueError('表【%s】没有字段，无法生成建表脚本' % table.get('objName'))
    lines = []
    for col in cols:
        # SQLite：单个整数主键 + 自增 → 必须写成 INTEGER PRIMARY KEY AUTOINCREMENT
        if (db_type == 'sqlite' and col.get('isAutoInc') and col.get('isPk')
                and str(col.get('dataType') or '').upper() in ('INT', 'BIGINT', 'SMALLINT')
                and len(_pk_cols(table)) == 1):
            lines.append('  %s INTEGER PRIMARY KEY AUTOINCREMENT' % quote(db_type, col.get('colName')))
            continue
        lines.append('  ' + render_column(db_type, col))
    pk = _pk_clause(db_type, table)
    if pk and not (db_type == 'sqlite' and any('AUTOINCREMENT' in one for one in lines)):
        lines.append('  ' + pk)
    tail = ''
    if db_type in ('mysql', 'mariadb'):
        tail = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci'
        if table.get('objComment'):
            tail += ' COMMENT=' + _literal(table.get('objComment'))
    statements = ['CREATE TABLE %s (\n%s\n)%s' % (name, ',\n'.join(lines), tail)]
    statements.extend(_comment_statements(db_type, '', table))
    return statements


def create_view(db_type, view):
    """视图：优先用扫描 / 导入时保存的原文；没有原文就拒绝（不猜）"""
    ddl = str(view.get('ddl') or '').strip()
    if not ddl:
        raise ValueError('视图【%s】没有保存定义（ddl），无法生成脚本，请粘贴 CREATE VIEW 原文'
                         % view.get('objName'))
    return [ddl.rstrip(';')]


def create_procedure(db_type, proc):
    """存储过程：原样输出（跨方言无法翻译），MySQL 需要 DELIMITER 包裹多语句过程体"""
    db_type = normalize_db_type(db_type)
    ddl = str(proc.get('ddl') or '').strip()
    if not ddl:
        raise ValueError('存储过程【%s】没有保存定义（ddl），无法生成脚本，请粘贴 CREATE PROCEDURE 原文'
                         % proc.get('objName'))
    ddl = ddl.rstrip(';')
    if db_type in ('mysql', 'mariadb') and ';' in ddl:
        return ['DELIMITER $$', ddl + '$$', 'DELIMITER ;']
    return [ddl]


def create_function(db_type, func):
    """函数：和存储过程同一套路（原文输出，MySQL 的多语句体要 DELIMITER）"""
    db_type = normalize_db_type(db_type)
    ddl = str(func.get('ddl') or '').strip()
    if not ddl:
        raise ValueError('函数【%s】没有保存定义（ddl），无法生成脚本，请粘贴 CREATE FUNCTION 原文'
                         % func.get('objName'))
    ddl = ddl.rstrip(';')
    if db_type in ('mysql', 'mariadb') and ';' in ddl:
        return ['DELIMITER $$', ddl + '$$', 'DELIMITER ;']
    return [ddl]


def create_trigger(db_type, trigger):
    """触发器：扫描时已把完整 CREATE TRIGGER 存进 ddl（含 BEFORE/AFTER 与 FOR EACH ROW）"""
    db_type = normalize_db_type(db_type)
    ddl = str(trigger.get('ddl') or '').strip()
    if not ddl:
        raise ValueError('触发器【%s】没有保存定义（ddl），无法生成脚本，请粘贴 CREATE TRIGGER 原文'
                         % trigger.get('objName'))
    ddl = ddl.rstrip(';')
    if db_type in ('mysql', 'mariadb') and 'begin' in ddl.lower():
        return ['DELIMITER $$', ddl + '$$', 'DELIMITER ;']
    return [ddl]


def create_index(db_type, index):
    """索引：扫描 / 元数据给的 CREATE INDEX 原文直接用；没有原文按结构化字段拼"""
    db_type = normalize_db_type(db_type)
    ddl = str(index.get('ddl') or '').strip()
    if ddl:
        return [ddl.rstrip(';')]
    cols = [str(one).strip() for one in (index.get('columns') or []) if str(one).strip()]
    if not cols:
        raise ValueError('索引【%s】没有保存定义（ddl）也没有字段列表，无法生成脚本'
                         % index.get('objName'))
    owner, plain = split_qualified(index.get('objName'))
    if not owner:
        raise ValueError('索引【%s】缺少所属表名，无法生成脚本' % index.get('objName'))
    return ['CREATE %sINDEX %s ON %s (%s)'
            % ('UNIQUE ' if index.get('unique') else '',
               quote(db_type, plain, '索引名'), quote(db_type, owner, '表名'),
               ', '.join(quote(db_type, one, '字段名') for one in cols))]


def create_object(db_type, obj):
    """按 objType 分发建对象语句"""
    kind = str((obj or {}).get('objType') or 'table').lower()
    if kind == 'view':
        return create_view(db_type, obj)
    if kind == 'procedure':
        return create_procedure(db_type, obj)
    if kind == 'function':
        return create_function(db_type, obj)
    if kind == 'trigger':
        return create_trigger(db_type, obj)
    if kind == 'index':
        return create_index(db_type, obj)
    return create_table(db_type, obj)


def split_qualified(name):
    """'表名.对象名' → ('表名', '对象名')：索引 / 触发器依附于表，objName 是这么存的

    只按第一个点拆：索引名里出现点也不该被当成库名（库名不在 objName 里）。
    """
    text = str(name or '')
    if '.' not in text:
        return '', text
    owner, _, plain = text.partition('.')
    return owner, plain


def drop_object(db_type, obj):
    db_type = normalize_db_type(db_type)
    kind = str(obj.get('objType') or 'table').lower()
    owner, plain = split_qualified(obj.get('objName'))
    if owner and kind in ('index', 'trigger'):
        name, table = quote(db_type, plain, '对象名'), quote(db_type, owner, '表名')
    else:
        name, table = quote(db_type, obj.get('objName'), '对象名'), ''
    if kind == 'view':
        return ['DROP VIEW %s' % name]
    if kind == 'procedure':
        return ['DROP PROCEDURE %s' % name]
    if kind == 'function':
        return ['DROP FUNCTION %s' % name]
    if kind == 'trigger':
        if db_type == 'postgresql' and table:
            return ['DROP TRIGGER %s ON %s' % (name, table)]
        return ['DROP TRIGGER %s' % name]
    if kind == 'index':
        # MySQL / SQL Server 的 DROP INDEX 必须带表名，其余方言只要索引名
        if db_type in ('mysql', 'mariadb', 'sqlserver') and table:
            return ['DROP INDEX %s ON %s' % (name, table)]
        return ['DROP INDEX %s' % name]
    return ['DROP TABLE %s' % name]


# ---------------------------------------------------------------- 改表 ----
def _same_col(a, b):
    """字段是否等价（类型 / 长度 / 可空 / 默认值 / 注释 / 主键 / 自增）"""
    keys = ('dataType', 'length', 'nullable', 'defaultValue', 'colComment', 'isPk', 'isAutoInc')
    for key in keys:
        left = a.get(key)
        right = b.get(key)
        if key in ('nullable', 'isPk', 'isAutoInc'):
            left = bool(left)
            right = bool(right)
        else:
            left = '' if left is None else str(left).strip()
            right = '' if right is None else str(right).strip()
        if left != right:
            return False
    return True


def _col_index(cols):
    out = {}
    for one in cols or []:
        out[str(one.get('colName'))] = one
    return out


def _col_comment_statement(db_type, table_name, col):
    db_type = normalize_db_type(db_type)
    if not col.get('colComment'):
        return None
    name = quote(db_type, col.get('colName'))
    if db_type == 'postgresql' or db_type == 'oracle':
        return 'COMMENT ON COLUMN %s.%s IS %s' % (quote(db_type, table_name), name,
                                                  _literal(col.get('colComment')))
    if db_type == 'sqlserver':
        return ("EXEC sp_addextendedproperty 'MS_Description', %s, 'SCHEMA','dbo','TABLE',%s,'COLUMN',%s"
                % (_nstr(db_type, col.get('colComment')), _nstr(db_type, table_name), _nstr(db_type, col.get('colName'))))
    return None


def _sqlite_rebuild(table_before, table_after):
    """SQLite 改类型 / 改约束 / 改主键只能重建表：新建 _new → 复制同名字段 → 删旧 → 改名"""
    name = table_after.get('objName')
    tmp = str(name) + '__new'
    before_cols = _col_index(table_before.get('columns'))
    after_cols = table_after.get('columns') or []
    shared = [one.get('colName') for one in after_cols if str(one.get('colName')) in before_cols]
    statements = ['PRAGMA foreign_keys=OFF']
    statements.extend(create_table('sqlite', dict(table_after, objComment=None), name_override=tmp))
    if shared:
        cols = ','.join(quote('sqlite', one) for one in shared)
        statements.append('INSERT INTO "%s" (%s) SELECT %s FROM "%s"' % (tmp, cols, cols, name))
    statements.append('DROP TABLE "%s"' % name)
    statements.append('ALTER TABLE "%s" RENAME TO "%s"' % (tmp, name))
    statements.append('PRAGMA foreign_keys=ON')
    return statements


def alter_table(db_type, table_before, table_after):
    """
    两张表定义（同一张表的前后状态）→ 一组 DDL 语句
      · 新增 / 删除 / 修改字段、主键变化、表注释变化都会覆盖；
      · SQLite 遇到「改字段属性 / 改主键」会整表重建；
      · 语句顺序固定：先删后改再增，最后注释，保证依赖不打架。
    """
    db_type = normalize_db_type(db_type)
    table_name = table_after.get('objName') or table_before.get('objName')
    name = quote(db_type, table_name, '表名')
    before = _col_index(table_before.get('columns'))
    after = _col_index(table_after.get('columns'))
    added = [one for key, one in after.items() if key not in before]
    dropped = [one for key, one in before.items() if key not in after]
    changed = [after[key] for key in after if key in before and not _same_col(before[key], after[key])]
    pk_before = [one.get('colName') for one in _pk_cols(table_before)]
    pk_after = [one.get('colName') for one in _pk_cols(table_after)]

    if db_type == 'sqlite':
        # 只有「加字段」能直接 ALTER；其它一律重建
        if not dropped and not changed and pk_before == pk_after and table_before.get('objComment') == table_after.get('objComment'):
            out = []
            for col in added:
                out.append('ALTER TABLE %s ADD COLUMN %s' % (name, render_column(db_type, col)))
            return out
        return _sqlite_rebuild(table_before, table_after)

    statements = []
    if db_type in ('mysql', 'mariadb'):
        for col in dropped:
            statements.append('ALTER TABLE %s DROP COLUMN %s' % (name, quote(db_type, col.get('colName'))))
        for col in changed:
            statements.append('ALTER TABLE %s MODIFY COLUMN %s' % (name, render_column(db_type, col)))
        for col in added:
            statements.append('ALTER TABLE %s ADD COLUMN %s' % (name, render_column(db_type, col)))
        if pk_before != pk_after and (pk_before or pk_after):
            if pk_before:
                statements.append('ALTER TABLE %s DROP PRIMARY KEY' % name)
            if pk_after:
                cols = ','.join(quote(db_type, one) for one in pk_after)
                statements.append('ALTER TABLE %s ADD PRIMARY KEY (%s)' % (name, cols))
        old_comment = str(table_before.get('objComment') or '').strip()
        new_comment = str(table_after.get('objComment') or '').strip()
        if old_comment != new_comment:
            statements.append('ALTER TABLE %s COMMENT=%s' % (name, _literal(new_comment)))
        return statements

    if db_type == 'postgresql':
        for col in dropped:
            statements.append('ALTER TABLE %s DROP COLUMN %s' % (name, quote(db_type, col.get('colName'))))
        for col in changed:
            old = before[col.get('colName')]
            col_name = quote(db_type, col.get('colName'))
            if (str(old.get('dataType')), str(old.get('length'))) != (str(col.get('dataType')), str(col.get('length'))):
                statements.append('ALTER TABLE %s ALTER COLUMN %s TYPE %s USING %s::%s' % (
                    name, col_name, render_type(db_type, col.get('dataType'), col.get('length')),
                    col_name, render_type(db_type, col.get('dataType'), col.get('length'))))
            if bool(old.get('nullable')) != bool(col.get('nullable')):
                statements.append('ALTER TABLE %s ALTER COLUMN %s %s' % (
                    name, col_name, 'DROP NOT NULL' if col.get('nullable') else 'SET NOT NULL'))
            if str(old.get('defaultValue') or '') != str(col.get('defaultValue') or ''):
                default = render_default(db_type, col.get('defaultValue'), col.get('dataType'))
                statements.append('ALTER TABLE %s ALTER COLUMN %s %s' % (
                    name, col_name, ('SET DEFAULT ' + default) if default else 'DROP DEFAULT'))
            comment = _col_comment_statement(db_type, table_name, col)
            if comment:
                statements.append(comment)
        for col in added:
            statements.append('ALTER TABLE %s ADD COLUMN %s' % (name, render_column(db_type, col)))
        if pk_before != pk_after:
            if pk_before:
                statements.append('ALTER TABLE %s DROP CONSTRAINT %s' % (
                    name, quote(db_type, 'pk_' + str(table_name).lower())))
            if pk_after:
                cols = ','.join(quote(db_type, one) for one in pk_after)
                statements.append('ALTER TABLE %s ADD CONSTRAINT %s PRIMARY KEY (%s)' % (
                    name, quote(db_type, 'pk_' + str(table_name).lower()), cols))
        old_comment = str(table_before.get('objComment') or '').strip()
        new_comment = str(table_after.get('objComment') or '').strip()
        if old_comment != new_comment:
            statements.append('COMMENT ON TABLE %s IS %s' % (name, _literal(new_comment)))
        return statements

    if db_type == 'oracle':
        for col in dropped:
            statements.append('ALTER TABLE %s DROP COLUMN %s' % (name, quote(db_type, col.get('colName'))))
        for col in changed:
            old = before[col.get('colName')]
            col_name = quote(db_type, col.get('colName'))
            pieces = [render_type(db_type, col.get('dataType'), col.get('length'))]
            if bool(old.get('nullable')) != bool(col.get('nullable')):
                pieces.append('NULL' if col.get('nullable') else 'NOT NULL')
            default = render_default(db_type, col.get('defaultValue'), col.get('dataType'))
            if str(old.get('defaultValue') or '') != str(col.get('defaultValue') or ''):
                pieces.append('DEFAULT ' + default if default else 'DEFAULT NULL')
            statements.append('ALTER TABLE %s MODIFY (%s %s)' % (name, col_name, ' '.join(pieces)))
            comment = _col_comment_statement(db_type, table_name, col)
            if comment:
                statements.append(comment)
        for col in added:
            statements.append('ALTER TABLE %s ADD (%s)' % (name, render_column(db_type, col)))
        if pk_before != pk_after:
            if pk_before:
                statements.append('ALTER TABLE %s DROP CONSTRAINT %s' % (
                    name, quote(db_type, 'pk_' + str(table_name).lower())))
            if pk_after:
                cols = ','.join(quote(db_type, one) for one in pk_after)
                statements.append('ALTER TABLE %s ADD CONSTRAINT %s PRIMARY KEY (%s)' % (
                    name, quote(db_type, 'pk_' + str(table_name).lower()), cols))
        old_comment = str(table_before.get('objComment') or '').strip()
        new_comment = str(table_after.get('objComment') or '').strip()
        if old_comment != new_comment:
            statements.append('COMMENT ON TABLE %s IS %s' % (name, _literal(new_comment)))
        return statements

    if db_type == 'sqlserver':
        for col in dropped:
            statements.append('ALTER TABLE %s DROP COLUMN %s' % (name, quote(db_type, col.get('colName'))))
        for col in changed:
            new_col = dict(col)
            # SQL Server 改列时不能带 DEFAULT（默认值要单独建约束），这里只改类型与可空
            statements.append('ALTER TABLE %s ALTER COLUMN %s' % (
                name, render_column(db_type, dict(new_col, defaultValue=None))))
            comment = _col_comment_statement(db_type, table_name, col)
            if comment:
                statements.append(comment)
        for col in added:
            statements.append('ALTER TABLE %s ADD %s' % (name, render_column(db_type, col)))
            comment = _col_comment_statement(db_type, table_name, col)
            if comment:
                statements.append(comment)
        if pk_before != pk_after:
            if pk_before:
                statements.append('ALTER TABLE %s DROP CONSTRAINT %s' % (
                    name, quote(db_type, 'PK_' + str(table_name))))
            if pk_after:
                cols = ','.join(quote(db_type, one) for one in pk_after)
                statements.append('ALTER TABLE %s ADD CONSTRAINT %s PRIMARY KEY (%s)' % (
                    name, quote(db_type, 'PK_' + str(table_name)), cols))
        old_comment = str(table_before.get('objComment') or '').strip()
        new_comment = str(table_after.get('objComment') or '').strip()
        if old_comment != new_comment:
            statements.append("EXEC sp_addextendedproperty 'MS_Description', %s, 'SCHEMA','dbo','TABLE',%s"
                              % (_nstr(db_type, new_comment), _nstr(db_type, table_name)))
        return statements

    raise ValueError('暂不支持的数据库类型：%s' % db_type)


# ---------------------------------------------------------------- 组装 ----
def join_statements(db_type, statements):
    """语句列表 → 脚本文本。SQL Server 用 GO 分批，其余用分号。"""
    db_type = normalize_db_type(db_type)
    lines = []
    for one in statements or []:
        text = str(one or '').strip()
        if not text:
            continue
        if db_type == 'sqlserver':
            lines.append(text + '\nGO')
        elif text.startswith('DELIMITER'):
            lines.append(text)
        else:
            lines.append(text + ';')
    return '\n\n'.join(lines)


def header(db_type, kind='forward', title='', notes=None, source=''):
    """脚本头部注释：把「这是哪版、哪个方言、正向还是回滚、能不能直接执行」写在最上面"""
    db_type = normalize_db_type(db_type)
    lines = [
        '-- ============================================================',
        '-- %s' % (title or '应用结构变更脚本'),
        '-- 数据库类型 : %s' % db_label(db_type),
        '-- 脚本类型   : %s' % ('正向（按设计态修改数据库）' if kind == 'forward'
                              else '回滚（撤销本次变更，可能丢数据，务必先备份）'),
        '-- 生成方式   : %s' % (source or '应用架构 · 结构版本发布（脚本不会自动执行，需人工确认）'),
        '-- ============================================================',
    ]
    for one in (notes or []):
        if one:
            lines.append('-- ' + str(one))
    if db_type == 'sqlite':
        lines.append('-- 注意：SQLite 不支持修改列类型 / 约束，相关变更会整表重建，执行期间会锁库。')
    if db_type == 'oracle':
        lines.append('-- 注意：Oracle 的 DDL 隐式提交，失败可能留下「改了一半」的表，建议逐条执行。')
    if db_type == 'sqlserver':
        lines.append('-- 注意：语句之间用 GO 分批，请在 SSMS / sqlcmd 里整段执行。')
    return '\n'.join(lines)
