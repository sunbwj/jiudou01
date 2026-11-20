# -*- coding: utf-8 -*-
"""
SQL 解析器：把粘贴进来的 DDL 文本解析成结构化变更（纯函数，不连库）
------------------------------------------------------------------
用途：应用架构页的「DDL 导入」——把建表 / 改表语句落到设计态，而不是去改真实数据库。

支持（按 appinfos.dbType 选方言，语法差异主要影响标识符与类型，解析本身是宽容的）：
  CREATE TABLE [IF NOT EXISTS] 表名 ( 字段定义, 主键, ... )
  ALTER  TABLE 表名 ADD [COLUMN] ...
  ALTER  TABLE 表名 DROP [COLUMN] 列名
  ALTER  TABLE 表名 MODIFY [COLUMN] ...
  ALTER  TABLE 表名 ALTER [COLUMN] 列名 TYPE ... / SET NOT NULL / SET DEFAULT ...
  ALTER  TABLE 表名 CHANGE [COLUMN] 旧名 新名 ...
  ALTER  TABLE 表名 RENAME [COLUMN] 旧名 TO 新名 / RENAME TO 新表名
  ALTER  TABLE 表名 ADD | DROP CONSTRAINT / PRIMARY KEY
  DROP   TABLE | VIEW | PROCEDURE 名
  CREATE [OR REPLACE] VIEW 名 AS ...        （原文整段保存，不做翻译）
  CREATE [OR REPLACE] PROCEDURE | FUNCTION 名 ...（原文整段保存）
  COMMENT ON TABLE 名 IS '...'
  COMMENT ON COLUMN 表.列 IS '...'

解析规则：
  · 支持 `x` / "x" / [x] 三种标识符引号，库名.表名会拆成 qualifier + name；
  · 不认识的语句**直接报错并带原句**，绝不静默丢弃（静默丢是这类功能最容易埋的雷）；
  · 类型一律折成逻辑类型（见 schema_ddl.canonical_type），长度单独保存。
"""
import re

import schema_ddl

# CREATE TABLE 里这些词出现在字段名之后，表示「类型结束、约束开始」
_ATTR_WORDS = ('not', 'null', 'default', 'auto_increment', 'autoincrement', 'identity',
               'primary', 'unique', 'comment', 'collate', 'references', 'check',
               'generated', 'constraint', 'on', 'character', 'using')

_TABLE_CONSTRAINT_HEADS = ('primary', 'unique', 'key', 'index', 'constraint', 'foreign', 'check')


def _strip_comments(sql):
    """去掉 -- 行注释与 /* */ 块注释（不动字符串里的内容）"""
    out = []
    i = 0
    n = len(sql)
    quote = ''
    while i < n:
        ch = sql[i]
        if quote:
            out.append(ch)
            if ch == quote:
                # 处理 '' 转义
                if i + 1 < n and sql[i + 1] == quote:
                    out.append(sql[i + 1])
                    i += 2
                    continue
                quote = ''
            i += 1
            continue
        if ch in ("'", '"', '`'):
            quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == '[':
            quote = ']'
            out.append(ch)
            i += 1
            continue
        if ch == '-' and i + 1 < n and sql[i + 1] == '-':
            while i < n and sql[i] != '\n':
                i += 1
            continue
        if ch == '/' and i + 1 < n and sql[i + 1] == '*':
            i += 2
            while i + 1 < n and not (sql[i] == '*' and sql[i + 1] == '/'):
                i += 1
            i += 2
            continue
        out.append(ch)
        i += 1
    return ''.join(out)


def split_statements(sql):
    """按分号切语句，跳过字符串 / 引号标识符里的分号；DELIMITER 段落按分隔符切。

    存储过程体的 END; 会被切成碎片 —— 这里对 CREATE PROCEDURE / FUNCTION / TRIGGER
    做一次合并：碎片里没出现 END 就继续往后拼，直到出现为止。
    """
    text = _strip_comments(str(sql or ''))
    # DELIMITER $$ 段：先把自定义分隔符换成 \x00，再按分号切，最后还原
    delim = None
    parts = []
    buf = []
    i = 0
    n = len(text)
    lower = text.lower()
    quote = ''
    while i < n:
        ch = text[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                if i + 1 < n and text[i + 1] == quote:
                    buf.append(text[i + 1])
                    i += 2
                    continue
                quote = ''
            i += 1
            continue
        if ch in ("'", '"', '`'):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == '[':
            quote = ']'
            buf.append(ch)
            i += 1
            continue
        if lower.startswith('delimiter ', i):
            # 只切换分隔符，DELIMITER 本身不进入语句
            j = text.find('\n', i)
            if j < 0:
                j = n
            token = text[i + 10:j].strip()
            delim = token or None
            i = j
            buf = []
            continue
        if delim and text.startswith(delim, i):
            stmt = ''.join(buf).strip()
            if stmt:
                parts.append(stmt)
            buf = []
            i += len(delim)
            continue
        if ch == ';':
            stmt = ''.join(buf).strip()
            if stmt:
                parts.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    tail = ''.join(buf).strip()
    if tail:
        parts.append(tail)

    # 合并被分号切碎的存储过程 / 函数 / 触发器
    merged = []
    pending = ''
    for one in parts:
        current = (pending + ';' + one) if pending else one
        head = current.strip().lower()
        is_routine = bool(re.match(r'^create\s+(or\s+replace\s+)?(procedure|function|trigger)\b', head))
        if is_routine and not re.search(r'\bend\b', head):
            pending = current
            continue
        merged.append(current)
        pending = ''
    if pending:
        merged.append(pending)
    return merged


def _unquote(name):
    text = str(name or '').strip()
    if len(text) >= 2 and text[0] in '`"[':
        close = ']' if text[0] == '[' else text[0]
        if text.endswith(close):
            inner = text[1:-1]
            return inner.replace(close * 2, close)
    return text


def _split_name(text):
    """'db.tbl' / `db`.`tbl` → ('db','tbl')；无库名时 qualifier 为空"""
    text = str(text or '').strip()
    quote = ''
    depth = 0
    for idx, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = ''
            continue
        if ch in ('`', '"', '['):
            quote = ch
            continue
        if ch == '.' and depth == 0:
            return _unquote(text[:idx]), _unquote(text[idx + 1:])
    return '', _unquote(text)


def _split_top(text, sep=','):
    """按分隔符切分，跳过括号与引号内部（字段定义里的 decimal(12,2) 不会被切开）"""
    out = []
    buf = []
    depth = 0
    quote = ''
    for ch in str(text or ''):
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = ''
            continue
        if ch in ("'", '"', '`'):
            quote = ch
            buf.append(ch)
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth = max(0, depth - 1)
        if ch == sep and depth == 0:
            one = ''.join(buf).strip()
            if one:
                out.append(one)
            buf = []
            continue
        buf.append(ch)
    one = ''.join(buf).strip()
    if one:
        out.append(one)
    return out


def _match_paren(text, start):
    """text[start] 是 '('，返回匹配的 ')' 下标；找不到返回 -1"""
    depth = 0
    quote = ''
    for idx in range(start, len(text)):
        ch = text[idx]
        if quote:
            if ch == quote:
                quote = ''
            continue
        if ch in ("'", '"', '`'):
            quote = ch
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0:
                return idx
    return -1


def _take_token(text, start=0):
    """从 start 起取一个「词」（引号整体算一个词），返回 (词, 结束下标)"""
    n = len(text)
    i = start
    while i < n and text[i].isspace():
        i += 1
    if i >= n:
        return '', i
    ch = text[i]
    if ch in ("'", '"', '`', '['):
        close = ']' if ch == '[' else ch
        j = i + 1
        buf = [ch]
        while j < n:
            buf.append(text[j])
            if text[j] == close:
                if j + 1 < n and text[j + 1] == close:
                    buf.append(text[j + 1])
                    j += 2
                    continue
                j += 1
                break
            j += 1
        return ''.join(buf).strip(), j
    j = i
    while j < n and (not text[j].isspace()) and text[j] not in ',()':
        j += 1
    return text[i:j].strip(), j


def _default_value(text, start):
    """取 DEFAULT 后面的值：引号串 / 数字 / 函数调用；返回 (值, 结束下标)"""
    n = len(text)
    i = start
    while i < n and text[i].isspace():
        i += 1
    if i >= n:
        return '', i
    if text[i] in ("'", '"'):
        value, end = _take_token(text, i)
        return _strip_quotes(value), end
    # 函数：CURRENT_TIMESTAMP() / now() / nextval('x')
    j = i
    while j < n and (text[j].isalnum() or text[j] in '_.$'):
        j += 1
    word = text[i:j]
    k = j
    while k < n and text[k].isspace():
        k += 1
    if k < n and text[k] == '(':
        end = _match_paren(text, k)
        if end > 0:
            return text[i:end + 1].strip(), end + 1
    return word.strip(), j


def _strip_quotes(text):
    text = str(text or '').strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        inner = text[1:-1]
        return inner.replace(text[0] * 2, text[0])
    return text


def _parse_column(text):
    """一条字段定义 → 字段 dict（逻辑类型 + 属性）；解析不了返回 None"""
    text = str(text or '').strip()
    if not text:
        return None
    name, end = _take_token(text, 0)
    col_name = _unquote(name)
    if not col_name:
        return None
    rest = text[end:].strip()
    # 类型：取到第一个属性关键字之前
    tokens = []
    pos = 0
    while pos < len(rest):
        word, new_pos = _take_token(rest, pos)
        if not word:
            break
        low = word.lower()
        if low in _ATTR_WORDS:
            break
        tokens.append(word)
        pos = new_pos
        # 类型后面紧跟括号（长度）时吞掉括号
        while pos < len(rest) and rest[pos].isspace():
            pos += 1
        if pos < len(rest) and rest[pos] == '(':
            close = _match_paren(rest, pos)
            if close < 0:
                raise ValueError('字段【%s】的类型括号不闭合：%s' % (col_name, rest[:60]))
            tokens[-1] = tokens[-1] + rest[pos:close + 1]
            pos = close + 1
    if not tokens:
        raise ValueError('字段【%s】缺少数据类型' % col_name)
    raw_type = ' '.join(tokens)
    logical, length = schema_ddl.canonical_type(raw_type)
    # PostgreSQL 的 SERIAL 系：类型本身就代表自增
    if raw_type.strip().lower() in ('serial', 'bigserial', 'smallserial'):
        logical = {'serial': 'INT', 'bigserial': 'BIGINT', 'smallserial': 'SMALLINT'}[raw_type.strip().lower()]

    attrs = rest[pos:]
    low_attrs = attrs.lower()
    nullable = not re.search(r'\bnot\s+null\b', low_attrs)
    is_pk = bool(re.search(r'\bprimary\s+key\b', low_attrs))
    is_auto = bool(re.search(r'\b(auto_increment|autoincrement|identity)\b', low_attrs))
    if re.search(r'\bgenerated\b[^,]*\bas\s+identity\b', low_attrs):
        is_auto = True
    if raw_type.strip().lower() in ('serial', 'bigserial', 'smallserial'):
        is_auto = True
    default = ''
    m = re.search(r'\bdefault\b', attrs, re.I)
    if m:
        default, _ = _default_value(attrs, m.end())
        if str(default).strip().upper() in ('NULL', 'NONE'):
            default = ''
    comment = ''
    m = re.search(r'\bcomment\s+', attrs, re.I)
    if m:
        raw, _ = _take_token(attrs, m.end())
        comment = _strip_quotes(raw)
    # 无显式 NOT NULL 但带主键：主键列按非空处理
    if is_pk:
        nullable = False
    return {
        'colName': col_name, 'dataType': logical, 'length': length,
        'nullable': nullable, 'defaultValue': default, 'isPk': is_pk,
        'isAutoInc': is_auto, 'colComment': comment,
    }


def _parse_pk(text):
    """PRIMARY KEY (a, b) / CONSTRAINT x PRIMARY KEY (a) → ['a','b']"""
    m = re.search(r'primary\s+key\s*\(([^)]*)\)', text, re.I)
    if not m:
        return []
    return [_unquote(one.strip()) for one in _split_top(m.group(1)) if one.strip()]


def _parse_create_table(stmt, db_type):
    m = re.match(r'^create\s+(?:temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?(.+?)\s*\(',
                 stmt, re.I | re.S)
    if not m:
        raise ValueError('无法解析建表语句：%s' % stmt[:80])
    qualifier, name = _split_name(m.group(1))
    open_at = stmt.find('(', m.start(1))
    close_at = _match_paren(stmt, open_at)
    if close_at < 0:
        raise ValueError('建表语句【%s】的括号不闭合' % name)
    body = stmt[open_at + 1:close_at]
    tail = stmt[close_at + 1:]
    columns = []
    pk_cols = []
    for part in _split_top(body):
        low = part.strip().lower()
        if not low:
            continue
        head = low.split()[0].strip('`"[')
        if head in _TABLE_CONSTRAINT_HEADS:
            found = _parse_pk(part)
            if found:
                pk_cols = found
            continue
        col = _parse_column(part)
        if col:
            columns.append(col)
    if not columns:
        raise ValueError('建表语句【%s】里没有解析到字段' % name)
    for col in columns:
        if col['colName'] in pk_cols:
            col['isPk'] = True
            col['nullable'] = False
    comment = ''
    m = re.search(r'comment\s*=?\s*', tail, re.I)
    if m:
        raw, _ = _take_token(tail, m.end())
        comment = _strip_quotes(raw)
    return {
        'op': 'create_table', 'qualifier': qualifier, 'name': name,
        'table': {'objName': name, 'objType': 'table', 'objComment': comment, 'columns': columns},
    }


def _parse_alter_table(stmt, db_type):
    m = re.match(r'^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(.+?)\s+(.+)$', stmt, re.I | re.S)
    if not m:
        raise ValueError('无法解析改表语句：%s' % stmt[:80])
    qualifier, name = _split_name(m.group(1))
    actions = _split_top(m.group(2))
    ops = []
    for action in actions:
        low = action.strip().lower()
        if not low:
            continue
        # RENAME TO / RENAME COLUMN a TO b / RENAME a TO b
        hit = re.match(r'^rename\s+(?:column\s+)?(.+)$', low, re.S)
        if hit:
            rest = action.strip()[len('rename'):].strip()
            if re.match(r'^to\s+', rest, re.I):
                target, _ = _take_token(rest, len('to'))
                ops.append({'op': 'alter_rename_table', 'qualifier': qualifier, 'name': name,
                            'to': _unquote(target)})
                continue
            rest = re.sub(r'^column\s+', '', rest, flags=re.I)
            to_pos = re.search(r'\bto\b', rest, re.I)
            if not to_pos:
                raise ValueError('无法解析重命名语句：%s' % action)
            old_name = _unquote(rest[:to_pos.start()].strip())
            new_name, _ = _take_token(rest, to_pos.end())
            ops.append({'op': 'alter_rename_column', 'qualifier': qualifier, 'name': name,
                        'from': old_name, 'to': _unquote(new_name)})
            continue
        # ADD ...
        if re.match(r'^add\b', low):
            rest = re.sub(r'^add\s+(column\s+)?', '', action.strip(), count=1, flags=re.I)
            if re.match(r'^(constraint|primary|unique|key|index|foreign|check)\b', rest, re.I):
                pk = _parse_pk(rest)
                if pk:
                    ops.append({'op': 'alter_pk', 'qualifier': qualifier, 'name': name, 'pk': pk})
                else:
                    ops.append({'op': 'alter_index', 'qualifier': qualifier, 'name': name,
                                'message': rest[:200]})
                continue
            col = _parse_column(rest)
            if not col:
                raise ValueError('无法解析新增字段：%s' % action[:80])
            ops.append({'op': 'alter_add_column', 'qualifier': qualifier, 'name': name, 'column': col})
            continue
        # DROP ...
        if re.match(r'^drop\b', low):
            rest = re.sub(r'^drop\s+', '', action.strip(), count=1, flags=re.I)
            if re.match(r'^(constraint|primary|key|index|foreign|check)\b', rest, re.I):
                ops.append({'op': 'alter_drop_pk' if 'primary' in rest.lower() else 'alter_drop_index',
                            'qualifier': qualifier, 'name': name, 'message': rest[:200]})
                continue
            rest = re.sub(r'^column\s+', '', rest, flags=re.I)
            col_name, _ = _take_token(rest, 0)
            ops.append({'op': 'alter_drop_column', 'qualifier': qualifier, 'name': name,
                        'column': _unquote(col_name)})
            continue
        # MODIFY / CHANGE（MySQL）
        if re.match(r'^modify\b', low):
            rest = re.sub(r'^modify\s+(column\s+)?', '', action.strip(), count=1, flags=re.I)
            col = _parse_column(rest)
            if not col:
                raise ValueError('无法解析修改字段：%s' % action[:80])
            ops.append({'op': 'alter_modify_column', 'qualifier': qualifier, 'name': name, 'column': col})
            continue
        if re.match(r'^change\b', low):
            rest = re.sub(r'^change\s+(column\s+)?', '', action.strip(), count=1, flags=re.I)
            old_name, end = _take_token(rest, 0)
            # CHANGE 旧名 新名 类型...：新名 + 定义直接交给 _parse_column
            col = _parse_column(rest[end:].strip())
            if not col:
                raise ValueError('无法解析重命名+改类型：%s' % action[:80])
            ops.append({'op': 'alter_rename_modify_column', 'qualifier': qualifier, 'name': name,
                        'from': _unquote(old_name), 'column': col})
            continue
        # ALTER [COLUMN] col TYPE t / SET NOT NULL / DROP NOT NULL / SET DEFAULT x
        if re.match(r'^alter\b', low):
            rest = re.sub(r'^alter\s+(column\s+)?', '', action.strip(), count=1, flags=re.I)
            col_name, end = _take_token(rest, 0)
            tail = rest[end:].strip()
            tail_low = tail.lower()
            if tail_low.startswith('type') or tail_low.startswith('set data type'):
                tail = re.sub(r'^(type|set\s+data\s+type)\s+', '', tail, flags=re.I)
                col = _parse_column('%s %s' % (col_name, tail))
                if not col:
                    raise ValueError('无法解析改类型：%s' % action[:80])
                # ALTER COLUMN ... TYPE 只改类型与长度，不能把 NOT NULL / 默认值一起冲掉
                ops.append({'op': 'alter_modify_column', 'qualifier': qualifier, 'name': name,
                            'column': col, 'partial': ['dataType', 'length']})
                continue
            if 'set not null' in tail_low:
                ops.append({'op': 'alter_column_nullable', 'qualifier': qualifier, 'name': name,
                            'column': _unquote(col_name), 'nullable': False})
                continue
            if 'drop not null' in tail_low:
                ops.append({'op': 'alter_column_nullable', 'qualifier': qualifier, 'name': name,
                            'column': _unquote(col_name), 'nullable': True})
                continue
            if tail_low.startswith('set default'):
                value, _ = _default_value(tail, len('set default'))
                ops.append({'op': 'alter_column_default', 'qualifier': qualifier, 'name': name,
                            'column': _unquote(col_name), 'defaultValue': value})
                continue
            if tail_low.startswith('drop default'):
                ops.append({'op': 'alter_column_default', 'qualifier': qualifier, 'name': name,
                            'column': _unquote(col_name), 'defaultValue': ''})
                continue
            raise ValueError('暂不支持的 ALTER 子句：%s' % action[:100])
        raise ValueError('暂不支持的 ALTER 子句：%s' % action[:100])
    return ops


def _parse_comment(stmt):
    m = re.match(r'^comment\s+on\s+(table|column)\s+(.+?)\s+is\s+(.+)$', stmt, re.I | re.S)
    if not m:
        raise ValueError('无法解析注释语句：%s' % stmt[:80])
    kind = m.group(1).lower()
    target = m.group(2).strip()
    raw_comment = m.group(3).strip()
    comment = _strip_quotes(raw_comment)
    if comment.upper() == 'NULL':
        comment = ''
    if kind == 'table':
        qualifier, name = _split_name(target)
        return [{'op': 'comment_table', 'qualifier': qualifier, 'name': name, 'comment': comment}]
    # COMMENT ON COLUMN 表.列 / 表.列  （'schema.tbl.col' 取最后两段）
    parts = _split_dotted(target)
    if len(parts) < 2:
        raise ValueError('无法解析注释目标：%s' % target)
    return [{'op': 'comment_column', 'qualifier': '', 'name': parts[-2],
             'column': parts[-1], 'comment': comment}]


def _split_dotted(text):
    """'schema.tbl.col' → ['schema','tbl','col']，尊重引号"""
    out = []
    buf = []
    quote = ''
    for ch in str(text or ''):
        if quote:
            if ch == quote:
                quote = ''
            buf.append(ch)
            continue
        if ch in ('`', '"', '['):
            quote = ']' if ch == '[' else ch
            buf.append(ch)
            continue
        if ch == '.':
            out.append(_unquote(''.join(buf)))
            buf = []
            continue
        buf.append(ch)
    out.append(_unquote(''.join(buf)))
    return [one.strip() for one in out if str(one).strip()]


def parse_sql(db_type, text):
    """
    解析一段 DDL 文本 → 变更列表（ops）
      · 每条 op 带 op 名称与目标（qualifier 库名 / name 对象名）；
      · 解析不了直接抛 ValueError（带原句），调用方转成页面上的行级错误。
    """
    statements = split_statements(text)
    if not statements:
        raise ValueError('没有解析到任何 SQL 语句')
    ops = []
    for stmt in statements:
        low = stmt.strip().lower()
        if not low:
            continue
        if re.match(r'^create\s+(or\s+replace\s+)?table\b', low):
            ops.append(_parse_create_table(stmt, db_type))
        elif re.match(r'^alter\s+table\b', low):
            ops.extend(_parse_alter_table(stmt, db_type))
        elif re.match(r'^drop\s+(table|view|procedure|function)\b', low):
            m = re.match(r'^drop\s+(table|view|procedure|function)\s+(?:if\s+exists\s+)?(.+)$',
                         stmt, re.I | re.S)
            obj_type = {'table': 'table', 'view': 'view',
                        'procedure': 'procedure', 'function': 'procedure'}[m.group(1).lower()]
            target = m.group(2).strip().split()[0]
            qualifier, name = _split_name(target)
            ops.append({'op': 'drop_object', 'objType': obj_type, 'qualifier': qualifier, 'name': name})
        elif re.match(r'^create\s+(or\s+replace\s+)?(view|procedure|function)\b', low):
            m = re.match(r'^create\s+(or\s+replace\s+)?(view|procedure|function)\s+(.+)$',
                         stmt, re.I | re.S)
            obj_type = 'view' if m.group(2).lower() == 'view' else 'procedure'
            rest = m.group(3).strip()
            name_tok, _ = _take_token(rest, 0)
            qualifier, name = _split_name(name_tok)
            ops.append({'op': 'create_object', 'objType': obj_type, 'qualifier': qualifier,
                        'name': name, 'ddl': stmt.strip(),
                        'replace': bool(m.group(1))})
        elif re.match(r'^comment\s+on\b', low):
            ops.extend(_parse_comment(stmt))
        else:
            raise ValueError('暂不支持的语句：%s' % stmt.strip()[:120])
    return ops
