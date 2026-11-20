# -*- coding: utf-8 -*-
"""
字段级血缘解析（纯函数，不连库）
--------------------------------------------------------------------------------
输入是**文本**：视图定义、触发器 / 存储过程 / 函数体、生成列表达式。
输出是「哪个输出字段由哪些来源字段算出来的」，带转换表达式。

为什么必须解析 SQL 文本：库表结构只有列名 / 类型 / 注释，
推不出 «b.c 来自 a.x»；能推出列级血缘的只有带表达式的东西 ——
视图的 SELECT、DML 的 SET / SELECT 列表、（MySQL）生成列的 GENERATED AS。

解析靠 sqlglot（纯 Python，mysql / postgres / oracle / tsql / sqlite 一套 API）：
  · `qualify()` 先把 `*` 展开、给未限定列补上表别名、校验列名 —— 这一步解决
    八成麻烦（SELECT * / join 同名列 / 别名）；
  · 再沿 select 列表把每个投影里的 Column 回溯到真实表；CTE 与派生表要下钻，
    所以用 `build_scope()` 拿作用域树，而不是自己爬 AST。
  · 视图套视图不在这里展开（本模块不认识业务对象），由调用方（app_schema）按
    「来源表名是不是另一个视图」递归，并负责防环与深度上限。

解析不了的情况（动态 SQL、变量、`SELECT *` 展开失败、未纳管的表）**不抛异常**：
降级成 note，让页面显式告诉用户「这条没解析出来」，而不是静默当作没有血缘。

输出分两类（对齐 OpenLineage 的 ColumnLineageDatasetFacet）：
  · DIRECT  —— 输出值由来源值算出（IDENTITY 原样 / TRANSFORMATION 计算 / AGGREGATION 聚合），
               逐列记录，是「这个字段从哪来」；
  · INDIRECT—— 来源只决定「哪些行、什么顺序、怎么分组」（FILTER / JOIN / GROUP_BY / SORT /
               WINDOW），影响该对象的全部输出列，所以按**整表级**返回（rowDeps），
               不摊到每个字段上 —— 否则 N 个过滤列 × M 个输出列，图会变成密集交叉。
"""
import logging
import re

import sqlglot
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import build_scope

import schema_parse

# sqlglot 遇到它不认识的语法（比如触发器里的 NEW.xxx、过程里的控制流）会 warning 后
# 退回成 Command 节点。我们本来就靠 try/except 判断"解析成功没有"，这行日志只会把
# 服务日志和测试输出刷满 —— 静音到 ERROR，真出错时的 ConnError / note 照旧。
logging.getLogger('sqlglot').setLevel(logging.ERROR)

# 应用结构里的方言名 → sqlglot 方言名（不认识的一律按 mysql 试，宁可解析失败也不阻断）
_DIALECTS = {
    'mysql': 'mysql', 'mariadb': 'mysql',
    'postgresql': 'postgres', 'postgres': 'postgres',
    'oracle': 'oracle',
    'sqlserver': 'tsql', 'mssql': 'tsql',
    'sqlite': 'sqlite',
}

MAX_DEPTH = 6              # CTE / 派生表下钻深度（超过就当解析不了，别在病态 SQL 上转圈）

# ---- 血缘类型（对齐 OpenLineage ColumnLineageDatasetFacet）-------------------
# DIRECT  ：输出值由来源值算出来（IDENTITY 原样 / TRANSFORMATION 计算 / AGGREGATION 聚合）
# INDIRECT：来源不提供值，但决定「哪些行存在、行的顺序、怎么分组」——
#           过滤、连接键、分组、排序、窗口分区。这类依赖**影响全部输出列**，
#           所以落库时 targetCol 留空（整表级），不摊到每个字段上。
#           摊到字段上会变成 N 个过滤列 × M 个输出列的密集交叉，图就没法看了。
DIRECT = 'DIRECT'
INDIRECT = 'INDIRECT'

SUB_IDENTITY = 'IDENTITY'            # 原样搬运（a ← a）
SUB_TRANSFORMATION = 'TRANSFORMATION'  # 表达式计算（concat(a,b)）
SUB_AGGREGATION = 'AGGREGATION'      # 跨行聚合（sum(a)）
SUB_JOIN = 'JOIN'                    # 连接条件
SUB_FILTER = 'FILTER'                # WHERE / HAVING / QUALIFY
SUB_GROUP_BY = 'GROUP_BY'            # 分组
SUB_SORT = 'SORT'                    # 排序
SUB_WINDOW = 'WINDOW'                # 窗口分区 / 窗口内排序

_AGG_RE = re.compile(r'\b(count|sum|avg|average|min|max|total|group_concat|string_agg|'
                     r'listagg|array_agg|stddev|stddev_pop|stddev_samp|variance|var_pop|'
                     r'var_samp|median|percentile_?\w*|ntile|row_number|rank|dense_rank|'
                     r'lag|lead|first_value|last_value|nth_value)\s*\(', re.I)
# 值被哈希 / 加密 / 掩码后，依赖还在但原值不往下游传播（合规影响分析要用）
_MASK_RE = re.compile(r'\b(md5|sha1|sha2?|hash|crc32|crypt|encrypt|aes_encrypt|aes_decrypt|'
                      r'pgp_sym_\w+|mask\w*|redact\w*)\s*\(', re.I)



def dialect_of(db_type):
    """应用方言 → sqlglot 方言"""
    return _DIALECTS.get(str(db_type or '').strip().lower(), 'mysql')


def _low(text):
    return str(text or '').strip().strip('`"[]').lower()


def _q_schema(schema):
    """把「对象 → 列清单」适配成 sqlglot 认的 schema

    sqlglot 的 qualify 需要 `{表: {列: 类型}}`；这里列的类型一律给 varchar（只用来展开 * 和
    校验列存在，类型本身不参与血缘）。表名 / 列名同时放原名、小写、大写三份：
    MySQL 小写、Oracle 大写，qualify 按方言做标识符归一，放三份最省心。
    """
    out = {}
    for name, cols in (schema or {}).items():
        if not name:
            continue
        col_map = {}
        for col in (cols or []):
            col_map[col] = 'varchar'
            col_map[str(col).lower()] = 'varchar'
            col_map[str(col).upper()] = 'varchar'
        for key in (str(name), str(name).lower(), str(name).upper()):
            out.setdefault(key, {}).update(col_map)
    return out


def _source_of(scope, table_name):
    """在当前作用域里按名字（大小写不敏感）找来源：返回 exp.Table / Scope / None"""
    if not table_name:
        return None
    sources = getattr(scope, 'sources', None) or {}
    if table_name in sources:
        return sources[table_name]
    want = _low(table_name)
    for name, src in sources.items():
        if _low(name) == want:
            return src
    return None


def _sources_of(scope):
    """当前作用域能看到的来源名（用于「单表查询省略表名」的兜底）"""
    return [name for name in (getattr(scope, 'sources', None) or {})]


def _find_projection(scope, col_name):
    """在作用域的输出列里按名字找投影（找不到 = 该列来自 * 或拼错）"""
    want = _low(col_name)
    try:
        selects = scope.expression.selects
    except Exception:                              # noqa: BLE001  —— Union 作用域没有 selects
        return None
    for proj in selects:
        if _low(proj.alias_or_name) == want:
            return proj
    return None


def _resolve_column(scope, col, depth, visited):
    """把一个 Column 回溯成来源（可能多个：表达式里引用了多张表的列）"""
    tname = col.table or ''
    cname = col.name or ''
    if not cname:
        return []
    if not tname:
        # 单表查询允许不写表名；多表又不限定 → 无法判断归属，明说而不是瞎猜
        names = _sources_of(scope)
        if len(names) == 1:
            tname = names[0]
        else:
            return [{'obj': '', 'col': cname, 'note': '列名没有表限定，无法判断来自哪张表'}]
    src = _source_of(scope, tname)
    if src is None:
        # 表不在设计态（未纳管 / 跨库 / 动态表名）：仍记一条来源，页面标「未纳管」
        return [{'obj': tname, 'col': cname, 'note': '来源表不在设计态（未纳管或跨库）'}]
    if isinstance(src, exp.Table):
        return [{'obj': src.name, 'col': cname, 'note': ''}]
    # CTE / 派生表：下钻到它的输出列
    if depth >= MAX_DEPTH or id(src) in visited:
        return [{'obj': '', 'col': cname, 'note': '嵌套层数过深或存在循环，未能继续展开'}]
    proj = _find_projection(src, cname)
    if proj is None:
        return [{'obj': '', 'col': cname, 'note': '子查询里找不到该列（可能是 * 未展开）'}]
    visited.add(id(src))
    try:
        return _resolve_projection(src, proj, depth + 1, visited)
    finally:
        visited.discard(id(src))


def _resolve_projection(scope, proj, depth, visited):
    out = []
    for col in proj.find_all(exp.Column):
        out.extend(_resolve_column(scope, col, depth, visited))
    return out


def _expr_text(proj, dialect):
    """投影的表达式原文（去掉别名），给页面显示「怎么算出来的」"""
    try:
        body = proj.unalias() if hasattr(proj, 'unalias') else proj.this
        return body.sql(dialect=dialect)[:500]
    except Exception:                              # noqa: BLE001
        return ''


def _bare(expr):
    """表达式 / 列名的比较口径：去引号、去空白、小写（`e . `NAME`` → `e.name`）"""
    text = re.sub(r'[`"\[\]]', '', str(expr or ''))
    return re.sub(r'\s+', '', text).lower()


def transform_kind(expr, col_name):
    """判断一列是怎么来的：原样 / 计算 / 聚合

    只看表达式本身，不需要连库：
      · `name` 或 `e.name` → IDENTITY（值原样搬过去）；
      · 含 count / sum / avg / row_number 等跨行函数 → AGGREGATION（改一行会影响整组结果）；
      · 其余（concat、case、加减乘除、cast…）→ TRANSFORMATION。
    """
    body = _bare(expr)
    if body and (body == _bare(col_name) or body.split('.')[-1] == _bare(col_name)):
        return SUB_IDENTITY
    if _AGG_RE.search(str(expr or '')):
        return SUB_AGGREGATION
    return SUB_TRANSFORMATION


def is_masked(expr):
    """表达式里带 md5 / sha / encrypt / mask 之类 → 原值不再向下游传播"""
    return bool(_MASK_RE.search(str(expr or '')))


def _rows_of(node):
    """一处条件（Where / Join.on / Group / Order）里引用到的列"""
    if node is None:
        return []
    try:
        return list(node.find_all(exp.Column))
    except Exception:                              # noqa: BLE001
        return []


def _scope_rowdeps(scope, dialect):
    """整表级依赖：这个查询用哪些列决定「哪些行 / 行的顺序 / 怎么分组」

    WHERE / HAVING / QUALIFY → FILTER，JOIN ON → JOIN，GROUP BY → GROUP_BY，
    ORDER BY → SORT，窗口的 PARTITION BY / ORDER BY → WINDOW。
    这些列不决定字段的值，但值变了结果集就变，影响分析必须算上（OpenLineage 的 INDIRECT）。
    """
    expr = getattr(scope, 'expression', None)
    if expr is None:
        return []
    parts = []
    where = expr.args.get('where')
    if where is not None:
        parts.append((where, SUB_FILTER))
    having = expr.args.get('having')
    if having is not None:
        parts.append((having, SUB_FILTER))
    qualify_node = expr.args.get('qualify')
    if qualify_node is not None:
        parts.append((qualify_node, SUB_FILTER))
    group = expr.args.get('group')
    if group is not None:
        parts.append((group, SUB_GROUP_BY))
    order = expr.args.get('order')
    if order is not None:
        parts.append((order, SUB_SORT))
    for join in (expr.args.get('joins') or []):
        on = join.args.get('on') if hasattr(join, 'args') else None
        if on is not None:
            parts.append((on, SUB_JOIN))
    # 窗口函数：PARTITION BY / ORDER BY 的列影响每一行的取值，归 WINDOW
    try:
        selects = list(expr.selects)
    except Exception:                              # noqa: BLE001
        selects = []
    for proj in selects:
        for win in proj.find_all(exp.Window):
            for key in ('partition_by', 'order'):
                node = win.args.get(key)
                if node is None:
                    continue
                if isinstance(node, list):
                    for one in node:
                        parts.append((one, SUB_WINDOW))
                else:
                    parts.append((node, SUB_WINDOW))

    out = []
    for node, sub in parts:
        try:
            text = node.sql(dialect=dialect)[:500]
        except Exception:                          # noqa: BLE001
            text = ''
        for col in _rows_of(node):
            for src in _resolve_column(scope, col, 0, set()):
                if not src.get('obj'):
                    continue
                out.append({'obj': src['obj'], 'col': src.get('col') or '',
                            'subType': sub, 'expr': text, 'note': src.get('note') or ''})
    return out


def _dedup_deps(deps):
    """同一「来源列 + 作用」只留一条（表达式留第一条）"""
    out, seen = [], set()
    for one in deps:
        key = (_low(one.get('obj')), _low(one.get('col')), one.get('subType') or '')
        if key in seen:
            continue
        seen.add(key)
        out.append(one)
    return out


def _parse_node(sql, dialect):
    """解析一条 SQL；视图 DDL（CREATE VIEW ...）自动取里面的查询部分"""
    node = sqlglot.parse_one(sql, dialect=dialect)
    if isinstance(node, exp.Create):
        node = node.expression
    return node


def parse_query(sql, db_type, schema, target_cols=None):
    """解析一条查询 / 视图定义 → 输出列的来源清单

    :param schema       设计态已知的 {对象名: [列名]}，用于展开 * 与补全别名
    :param target_cols  输出列清单（视图的字段顺序）；给了就按**位置**对齐，
                        这样 `SELECT *` 或列名对不上时也能落到正确的字段上
    :return {'ok': bool, 'note': str, 'columns': [{col, expr, sources: [{obj, col, note}]}]}
    """
    dialect = dialect_of(db_type)
    text = str(sql or '').strip()
    if not text:
        return {'ok': False, 'note': '没有可解析的定义文本', 'columns': []}
    try:
        node = _parse_node(text, dialect)
    except Exception as exc:                       # noqa: BLE001  —— 语法不认识 / 方言不支持
        return {'ok': False, 'note': 'SQL 解析失败：%s' % _clean(exc), 'columns': []}
    if node is None:
        return {'ok': False, 'note': '这是 CREATE 语句但没有查询部分', 'columns': []}

    note = ''
    try:
        node = qualify(node, schema=_q_schema(schema), dialect=dialect,
                       validate_qualify_columns=False)
    except Exception as exc:                       # noqa: BLE001  —— 引用了解析不了的表
        note = '未经 schema 校验（%s），列归属按语句里的别名推断' % _clean(exc)

    try:
        root = build_scope(node)
    except Exception as exc:                       # noqa: BLE001
        return {'ok': False, 'note': '作用域解析失败：%s' % _clean(exc), 'columns': []}
    if root is None:
        return {'ok': False, 'note': '无法确定查询作用域', 'columns': []}

    scopes = []
    if isinstance(node, exp.Union):
        scopes = list(getattr(root, 'union_scopes', None) or [])
    if not scopes:
        scopes = [root]

    merged, order, rowdeps = {}, [], []
    for scope in scopes:
        try:
            selects = scope.expression.selects
        except Exception:                          # noqa: BLE001
            continue
        for idx, proj in enumerate(selects):
            col_name = proj.alias_or_name or ('col%d' % (idx + 1))
            # 位置对齐优先：视图的字段顺序是确定的，* 展开后名字可能带前缀
            if target_cols and idx < len(target_cols):
                col_name = target_cols[idx]
            key = _low(col_name)
            if key not in merged:
                merged[key] = {'col': col_name, 'expr': _expr_text(proj, dialect), 'sources': []}
                order.append(key)
            merged[key]['sources'].extend(_resolve_projection(scope, proj, 0, set()))
        rowdeps.extend(_scope_rowdeps(scope, dialect))

    columns = []
    for key in order:
        one = merged[key]
        one['sources'] = _dedup(one['sources'])
        # 每条来源标上「怎么来的」：原样 / 计算 / 聚合；脱敏的单独打标，
        # 影响分析时能回答「这个字段的值还会不会被原样传下去」
        for src in one['sources']:
            src['linkType'] = DIRECT
            src['subType'] = transform_kind(one['expr'], src.get('col'))
            src['masked'] = 1 if is_masked(one['expr']) else 0
        columns.append(one)
    return {'ok': True, 'note': note, 'columns': columns, 'rowDeps': _dedup_deps(rowdeps)}


def _dedup(sources):
    """同一来源只留一条；note 合并"""
    out, seen = [], {}
    for one in sources:
        key = (_low(one.get('obj')), _low(one.get('col')))
        if key in seen:
            if one.get('note') and one['note'] not in seen[key]['note']:
                seen[key]['note'] = (seen[key]['note'] + '；' + one['note']).strip('；')
            continue
        seen[key] = {'obj': one.get('obj') or '', 'col': one.get('col') or '',
                     'note': one.get('note') or ''}
        out.append(seen[key])
    return out


def _clean(exc):
    """异常信息压成一行（sqlglot 的报错带整段 SQL 与行号，页面放不下）"""
    text = str(exc or '').replace('\n', ' ')
    return text[:180]


def parse_writes(text, db_type, schema):
    """从触发器 / 存储过程 / 函数体里抽写入血缘

    过程体是「多条语句」的文本，sqlglot 不认 PL/SQL 块（BEGIN ... END），所以先按分号切成
    单条（复用 schema_parse.split_statements），再逐条看是不是 INSERT / UPDATE。
    切不干净 / 语法不认识的那几条直接跳过并记 note —— 过程里 90% 是这类，不能因此整体失败。

    :return {'statements': [{table, cols: [{col, expr, sources}], kind}], 'notes': [str]}
    """
    text = str(text or '')
    first = _parse_writes_with(text, db_type, schema)
    if first['statements'] or not _DML_HEADS.search(text):
        return first
    # 一条都没解析出来，但文本里确实写着 INSERT / UPDATE：设计态里的定义可能是从**另一种库**
    # 导进来的（真实数据里就有「应用方言 mysql，过程体却是 Oracle PL/SQL」）。
    # 换几个方言再试，能出结果就用，并在 note 里写清用的是哪个方言 —— 别让页面显示「0 条血缘」。
    for alt in ('oracle', 'postgres', 'tsql'):
        if alt == dialect_of(db_type):
            continue
        second = _parse_writes_with(text, {'oracle': 'oracle', 'postgres': 'postgresql',
                                          'tsql': 'sqlserver'}[alt], schema)
        if second['statements']:
            second['notes'].insert(0, '按 %s 方言解析（与应用方言 %s 不一致：定义可能是从另一种数据库导入的）'
                                   % (alt, dialect_of(db_type)))
            return second
    first['notes'].append('检测到写入语句，但一条都没解析出来（PL/SQL 块、变量赋值或动态 SQL；'
                          '字段血缘需要人工确认）')
    return first


def _parse_writes_with(text, db_type, schema):
    """按指定方言解析一遍（parse_writes 会在方言不匹配时换几个再试）"""
    dialect = dialect_of(db_type)
    out, notes = [], []
    for stmt in schema_parse.split_statements(text):
        node = _parse_dml(stmt, dialect)
        if node is None:
            continue
        if isinstance(node, exp.Insert):
            one = _write_insert(node, db_type, schema)
        elif isinstance(node, exp.Update):
            one = _write_update(node, db_type, schema)
        else:
            continue
        if one is None:
            notes.append('有一段写入语句没解析出目标字段：%s' % stmt.replace('\n', ' ')[:80])
            continue
        if not one['cols']:
            notes.append('%s 的写入解析为空（可能用了变量或动态 SQL）' % one['table'])
            continue
        out.append(one)
    return {'statements': out, 'notes': notes}


# 过程体里语句常带 PL 块关键字（BEGIN ... / IF ... THEN / END;），sqlglot 只认单条 DML。
# 这里剥掉开头的控制关键字，必要时从第一个 DML 关键字处截断，剩下交给 parse_one 试。
_PL_HEADS = ('begin', 'declare', 'end', 'if', 'else', 'elseif', 'then', 'loop', 'while',
             'repeat', 'for', 'case', 'when', 'return', 'exception', 'block')
# 只认真正的写入语句：`INSERT INTO t` / `UPDATE t SET` / `MERGE INTO t`。
# 不能只写 \binsert\b —— 触发器 DDL 里的 `BEFORE INSERT ON t` 会被误判成
# 「写了数据但没解析出来」，页面上就会出现一堆假告警。
_DML_HEADS = re.compile(r'(\binsert\s+into\b|\bmerge\s+into\b|'
                        r'\bupdate\s+[`"\[\]\w.]+\s+set\b)', re.I)


def _parse_dml(stmt, dialect):
    """尽量把一条（可能带 PL 控制语句的）文本解析成 DML 节点"""
    text = str(stmt or '').strip()
    if not text:
        return None
    for candidate in (text, _strip_pl_head(text)):
        if not candidate:
            continue
        try:
            node = sqlglot.parse_one(candidate, dialect=dialect)
        except Exception:                          # noqa: BLE001
            continue
        if isinstance(node, (exp.Insert, exp.Update, exp.Merge)):
            return node
    hit = _DML_HEADS.search(text)
    if hit:
        tail = text[hit.start():]
        try:
            node = sqlglot.parse_one(tail, dialect=dialect)
            if isinstance(node, (exp.Insert, exp.Update, exp.Merge)):
                return node
        except Exception:                          # noqa: BLE001
            pass
    return None


def _strip_pl_head(text):
    """去掉开头的 BEGIN / IF ... THEN / END 之类，只留下 DML 部分"""
    out = text.strip()
    changed = True
    while changed:
        changed = False
        low = out.lower()
        for head in _PL_HEADS:
            if low.startswith(head + ' ') or low == head:
                out = out[len(head):].lstrip(' :;')
                changed = True
                break
        # `IF cond THEN` / `WHEN ... THEN`：把 THEN 之前的部分丢掉
        m = re.match(r'^(?:if|elseif|when)\b[^;]*?\bthen\b\s*', out, re.I | re.S)
        if m:
            out = out[m.end():]
            changed = True
    return out.strip()


def _alias_map(node):
    """UPDATE / INSERT 里的「别名 → 真实表名」映射（build_scope 不认 Update，手工建）"""
    out = {}
    for table in node.find_all(exp.Table):
        name = table.name
        if not name:
            continue
        out[_low(name)] = name
        alias = table.alias_or_name
        if alias:
            out[_low(alias)] = name
    return out


def _write_insert(node, db_type, schema):
    """INSERT INTO t (a, b) SELECT x, y ... → 目标列 ← 来源列（按位置对齐）

    除了逐列的值来源，SELECT 里的 WHERE / JOIN / GROUP BY 也一并带回：
    它们决定「插进去的是哪些行」，落库成目标表的整表级依赖（INDIRECT）。
    """
    dialect = dialect_of(db_type)
    table_node = node.this
    target_cols = []
    if isinstance(table_node, exp.Schema):
        target_cols = [c.name for c in table_node.expressions if isinstance(c, exp.Column) or c.name]
        table_node = table_node.this
    if not isinstance(table_node, exp.Table):
        return None
    table = table_node.name
    source_query = node.expression
    if isinstance(source_query, exp.Select) or isinstance(source_query, exp.Union):
        parsed = parse_query(source_query.sql(dialect=dialect), db_type, schema)
        cols = []
        for idx, one in enumerate(parsed.get('columns') or []):
            col_name = target_cols[idx] if idx < len(target_cols) else one.get('col')
            if not col_name:
                continue
            cols.append({'col': col_name, 'expr': one.get('expr') or '',
                         'sources': one.get('sources') or []})
        return {'table': table, 'cols': cols, 'kind': 'insert',
                'deps': parsed.get('rowDeps') or []}
    if isinstance(source_query, exp.Values):
        # INSERT ... VALUES (...) —— 常量赋值，列级没有来源（仍返回列，便于页面区分）
        cols = []
        for row in (source_query.expressions or []):
            for pos, value in enumerate(getattr(row, 'expressions', []) or []):
                if pos >= len(target_cols):
                    continue
                cols.append({'col': target_cols[pos], 'expr': value.sql(dialect=dialect)[:200],
                             'sources': []})
        return {'table': table, 'cols': cols, 'kind': 'insert', 'deps': []}
    return None


def _write_update(node, db_type, schema):
    """UPDATE t SET a = 表达式 → a ← 表达式里引用到的列（含 join 进来的表）

    WHERE 里的列不影响改成什么值，但决定改哪几行 → 记成目标表的 INDIRECT / FILTER。
    """
    dialect = dialect_of(db_type)
    table_node = node.this
    if not isinstance(table_node, exp.Table):
        return None
    table = table_node.name
    aliases = _alias_map(node)
    cols = []
    for assn in (node.expressions or []):
        if not isinstance(assn, exp.EQ):
            continue
        left = assn.this
        if not isinstance(left, exp.Column):
            continue
        sources = []
        for col in assn.expression.find_all(exp.Column):
            # UPDATE 单表时列常不写表名（SET name = concat(name,'x')），归属就是被更新的表；
            # 不兜这一下会全落成「列名没有表限定」，血缘等于白解析
            src = aliases.get(_low(col.table or '')) or (col.table or '') or table
            sources.append({'obj': src, 'col': col.name or '', 'note': ''})
        expr_text = assn.expression.sql(dialect=dialect)
        kind = transform_kind(expr_text, left.name)
        masked = 1 if is_masked(expr_text) else 0
        for src in _dedup(sources):
            src['linkType'] = DIRECT
            src['subType'] = kind
            src['masked'] = masked
        cols.append({'col': left.name,
                     'expr': expr_text[:500],
                     'sources': _dedup(sources)})
    deps = []
    where = node.args.get('where')
    if where is not None:
        try:
            text = where.sql(dialect=dialect)[:500]
        except Exception:                          # noqa: BLE001
            text = ''
        for col in where.find_all(exp.Column):
            src = aliases.get(_low(col.table or '')) or (col.table or '') or table
            if not src:
                continue
            deps.append({'obj': src, 'col': col.name or '',
                         'subType': SUB_FILTER, 'expr': text})
    return {'table': table, 'cols': cols, 'kind': 'update', 'deps': _dedup_deps(deps)}
