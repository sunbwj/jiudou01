# -*- coding: utf-8 -*-
"""
应用架构服务：应用信息（appinfos）+ 库 / 表 / 视图 / 存储过程 / 字段 + 版本脚本
----------------------------------------------------------------------------
两个服务，分别挂在 /api/appinfo/* 与 /api/appschema/*：

AppInfoService（应用信息）
  · 一个应用对应**一个**数据库连接对象：appinfos.dbConnId 唯一索引兜住，允许为空（纯手工应用）；
  · 应用编码 APP + 4 位流水号；可见性沿用数据中心（本人创建 + 他人公用）；
  · 连接下拉只给出「启用、可见、且没有被别的应用占用」的连接。

AppSchemaService（应用结构）
  · 结构树**只读本地表**（appschemadbs / appschemaobjs / appschemacols），扫描只是同步器 ——
    手工录入与扫描写同一套表，靠 source（scan/manual/import）+ locked 区分；
  · 每次保存（手工增删改 / 扫描导入 / DDL 导入）生成一条**草稿版本**，带整库快照；
    点「发布」才生成正式版号 + 正向 / 回滚脚本（按 appinfos.dbType 方言渲染）；
  · 脚本**永不自动执行**：状态 pending → 人工确认 → applied / failed / skipped，执行结果回写；
  · 与真实数据库对比只由人工触发：实时扫描右侧 → 与设计态快照比对 → 结果落库留存。

设计口径（与 db/appschema.sql 头部注释一致）：
  · 删除是物理删除（唯一索引才能正常工作），历史在版本快照里；
  · 扫描同步只删「source=scan 且未锁定」的对象，手工录入的不会被冲掉；
  · 对比 / 生成脚本都基于**快照**，不在请求里反复重算历史结构。
"""
import base64
import datetime
import hashlib
import json
import math
import re
import uuid
import zlib

import connector
import column_lineage
import comment_lineage
import schema_ddl
import schema_export
import schema_parse
from db import DuplicateError, dump_row, execute, query_all, query_one, transaction
from errors import BizError

RE_UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')

LOGIN_EMP_SQL = 'SELECT `empId` AS `empId` FROM `useinfo` WHERE `id`=%s LIMIT 1'

APP_TYPE_OPTIONS = [
    {'value': 'web', 'label': 'Web 应用'},
    {'value': 'service', 'label': '后台服务'},
    {'value': 'app', 'label': '移动应用'},
    {'value': 'middleware', 'label': '中间件'},
    {'value': 'other', 'label': '其它'},
]
ENV_OPTIONS = [
    {'value': 'dev', 'label': '开发'},
    {'value': 'test', 'label': '测试'},
    {'value': 'prod', 'label': '生产'},
]
OBJ_TYPE_LABELS = {'table': '表', 'view': '视图', 'procedure': '存储过程', 'function': '函数',
                   'trigger': '触发器', 'index': '索引'}
# 结构树的展示顺序：表 / 视图在前（它们才是主体），依附于表的索引、触发器随后，
# 过程与函数最后。别用 objType 的字母序 —— 'function' / 'index' 会排到 'table' 前面。
OBJ_TYPE_ORDER = {'table': 0, 'view': 1, 'index': 2, 'trigger': 3, 'procedure': 4, 'function': 5}
VERSION_STATUS_LABELS = {
    'draft': '草稿', 'released': '已发布', 'applied': '已执行',
    'superseded': '已被取代', 'discarded': '已丢弃',
}
SCRIPT_STATUS_LABELS = {
    'pending': '待执行', 'applied': '已执行', 'failed': '执行失败', 'skipped': '外部执行',
}
DIFF_LABELS = {
    'same': '一致', 'designOnly': '仅设计有（待建）', 'dbOnly': '仅实库有（未纳管）',
    'attrDiff': '属性不一致', 'orderDiff': '顺序不同',
}
LINEAGE_KIND_LABELS = {
    'view': '视图', 'trigger': '触发器', 'procedure': '存储过程', 'function': '函数',
    'comment': '字段注解',
}
# 一条边是怎么得出来的：SQL 表达式解析 / 注释里明写的引用 / 注释里的中文口径反查 / 人工标注
LINEAGE_ORIGIN_LABELS = {
    'sql': 'SQL 推导', 'ref': '注解引用', 'calc': '注解口径', 'manual': '人工标注',
}
# 人工可以标注的子类型：直接派生（值怎么算）+ 间接影响（决定取哪些行 / 怎么分组）
LINEAGE_SUB_DIRECT = ('IDENTITY', 'TRANSFORMATION', 'AGGREGATION', 'CONDITIONAL')
LINEAGE_SUB_INDIRECT = ('JOIN', 'FILTER', 'GROUP_BY', 'SORT', 'WINDOW')
# 血缘类型 / 子类型：口径对齐 OpenLineage ColumnLineageDatasetFacet 的 transformations
LINEAGE_TYPE_LABELS = {'DIRECT': '直接派生', 'INDIRECT': '间接影响'}
LINEAGE_SUB_LABELS = {
    'IDENTITY': '原样', 'TRANSFORMATION': '计算', 'AGGREGATION': '聚合',
    'JOIN': '连接条件', 'FILTER': '过滤条件', 'GROUP_BY': '分组',
    'SORT': '排序', 'WINDOW': '窗口', 'CONDITIONAL': '条件',
}


def _text(value):
    return '' if value is None else str(value).strip()


def _bool(value, default=False):
    if value is None:
        return default
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


def _uuid(value, label='参数 id'):
    text = _text(value).lower()
    if not text:
        raise BizError('%s 不能为空（应为 UUID）' % label)
    if not RE_UUID.match(text):
        raise BizError('%s 不合法（应为 UUID）' % label)
    return text


def _json_loads(raw, default=None):
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


def _dump_json_field(obj):
    """变更明细里的 before / after 留档 JSON

    库级变更（首次导入 = 整库新增）的 after 是**整库结构**（600 表 ≈ 2MB），原样写一条
    INSERT 会顶到 `max_allowed_packet`；超过 64KB 的同样 zlib 压缩，小的照旧存明文
    （方便直接查库看）。读取用 _load_json_field（version() 目前不回传这两个字段，纯留档）。
    """
    if obj is None:
        return None
    text = json.dumps(obj, ensure_ascii=False)
    if len(text) <= 65536:
        return text
    return SNAP_PREFIX + base64.b64encode(zlib.compress(text.encode('utf-8'), 6)).decode('ascii')


def _load_json_field(text):
    """_dump_json_field 的逆向（兼容历史明文行）"""
    if isinstance(text, str) and text.startswith(SNAP_PREFIX):
        try:
            return json.loads(zlib.decompress(base64.b64decode(text[len(SNAP_PREFIX):])).decode('utf-8'))
        except (TypeError, ValueError, zlib.error):
            return None
    return _json_loads(text, None)


def _sha1(text):
    return hashlib.sha1(text.encode('utf-8')).hexdigest()


# ---------------------------------------------------------------------
# 版本快照的落库格式
# ---------------------------------------------------------------------
# 整库结构快照随表数线性增长（600 张表 ≈ 2MB JSON），而 MySQL 一条语句的包大小受
# `max_allowed_packet` 限制（本机默认才 1MB）→ 直接 INSERT 整串会抛
# `1153 Got a packet bigger than 'max_allowed_packet' bytes`，扫描在最后一步失败。
# 所以落库前 zlib 压缩 + base64（实测 2.11MB → 0.23MB，约 1/9），读取时按前缀识别。
# 历史明文快照（没有前缀）照旧能读，不需要迁移数据。
SNAP_PREFIX = 'zlib:'


def _dump_snapshot(snap):
    raw = json.dumps(snap, ensure_ascii=False).encode('utf-8')
    return SNAP_PREFIX + base64.b64encode(zlib.compress(raw, 6)).decode('ascii')


def _load_snapshot(text, default=None):
    """`appschemavers.snapshot` 落库文本 → 快照字典（压缩 / 明文两种都认）"""
    if not text:
        return _empty_snapshot() if default is None else default
    if isinstance(text, str) and text.startswith(SNAP_PREFIX):
        try:
            raw = zlib.decompress(base64.b64decode(text[len(SNAP_PREFIX):]))
            return json.loads(raw.decode('utf-8'))
        except (TypeError, ValueError, zlib.error):
            return _empty_snapshot() if default is None else default
    return _json_loads(text, _empty_snapshot() if default is None else default)


def _now():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _time_text(value):
    """datetime → 'YYYY-MM-DD HH:MM:SS'

    Flask 默认把 datetime 序列化成 RFC 822（`Tue, 17 Nov 2026 15:49:40 GMT`），
    前端 `slice(0, 16)` 会切出「Tue, 17 Nov 2026」这种怪东西 —— 这里统一成字符串。
    """
    if not value:
        return ''
    if hasattr(value, 'strftime'):
        return value.strftime('%Y-%m-%d %H:%M:%S')
    return str(value)


def _multi_values(value):
    """多选筛选参数 → 去重后的值列表。

    兼容三种写法：单个值（`web`）、逗号串（`web,service`）、列表；
    顺手吃掉首尾空白、空段与重复值，前端怎么传都不会拼出非法 SQL。
    """
    if isinstance(value, (list, tuple)):
        parts = list(value)
    else:
        parts = _text(value).split(',')
    out = []
    for one in parts:
        text = _text(one)
        if text and text not in out:
            out.append(text)
    return out


def _in_clause(column, values):
    """`col` IN (…) 的 SQL 片段 + 参数；values 为空时返回 ('', [])（调用方直接跳过）"""
    values = list(values or [])
    if not values:
        return '', []
    return '%s IN (%s)' % (column, ', '.join(['%s'] * len(values))), values


def _empty_snapshot():
    return {'databases': []}


def _sorted_columns(table):
    cols = list((table or {}).get('columns') or [])
    return sorted(cols, key=lambda one: (int(one.get('ordinal') or 0), str(one.get('colName') or '')))


def _col_key(name):
    """列名在 `uk_appschemacols` 里的比较口径（判重必须按这个来）

    唯一索引建在 utf8mb4_general_ci 上，比较规则是「大小写不敏感 + 忽略尾随空格」：
    `'ID'` 与 `'id'`、`'NAME'` 与 `'NAME '` 在 MySQL 眼里是同一条，同时 INSERT 就报
    Duplicate entry。所以落库前先用这个键判重，别拿 Python 的精确字符串去比。

    **只 rstrip，不能 strip**：前导空白是 Oracle 里真实存在的字符（有些历史建表脚本把
    换行混进了带引号的标识符，ALL_TAB_COLUMNS 原样返回 `'\\nGEN_MED_SF'`），它与
    `'GEN_MED_SF'` 是两列，strip 掉就变成同名，扫描直接崩。
    """
    return str(name or '').rstrip().upper()


def _marks(count):
    """IN 子句的占位符：`_marks(3)` → `%s,%s,%s`（批量查库别再逐条建连）"""
    return ','.join(['%s'] * int(count))


def _lineage_row(row):
    """血缘边（DB 行）→ 前端结构：类型 / 来源都带中文标签，页面不用再查表"""
    kind = _text(row.get('kind'))
    link = _text(row.get('linkType')) or 'DIRECT'
    sub = _text(row.get('subType'))
    origin = _text(row.get('origin')) or 'sql'
    depth = int(row.get('depth') or 0)
    return {
        'id': _text(row.get('id')),
        'dbName': _text(row.get('dbName')),
        'targetObj': _text(row.get('targetObj')), 'targetType': _text(row.get('targetType')),
        'targetCol': _text(row.get('targetCol')),
        'sourceObj': _text(row.get('sourceObj')), 'sourceType': _text(row.get('sourceType')),
        'sourceCol': _text(row.get('sourceCol')),
        'transform': _text(row.get('transform')), 'via': _text(row.get('via')),
        'depth': depth, 'kind': kind,
        'kindLabel': LINEAGE_KIND_LABELS.get(kind, kind),
        'linkType': link, 'linkTypeLabel': LINEAGE_TYPE_LABELS.get(link, link),
        'subType': sub, 'subTypeLabel': LINEAGE_SUB_LABELS.get(sub, sub),
        'origin': origin, 'originLabel': LINEAGE_ORIGIN_LABELS.get(origin, origin),
        'masked': bool(int(row.get('masked') or 0)),
        'depthLabel': '直接来源' if depth == 0 else '经 %d 层视图' % depth,
        # 人工标注：空 = 机器解析出来的边（页面上手工边要画成虚线并显示标注）
        'note': _text(row.get('note')),
        'manualBy': _text(row.get('manualBy')),
        'updateTime': _time_text(row.get('updateTime')),
        'editable': origin == 'manual',
    }


def _ordered_columns(columns):
    """按「实库真实位置」排序并连续化 → [(位置从 1 开始, 列)]

    connector 各方言都会把位置带回来（MySQL / SQL Server 用 information_schema 的
    ORDINAL_POSITION、PostgreSQL 用 ordinal_position、SQLite 用 PRAGMA 的 cid、Oracle 用
    COLUMN_ID）。带不上位置（或位置为 0）时才退回列表下标。
    设计态落库的 ordinal 必须是这个位置，不能靠「SELECT 结果碰巧有序」—— 排序不稳定、
    多 schema 同名表串列时字段顺序会整体错位。
    """
    items = [one for one in (columns or [])
             if isinstance(one, dict) and _text(one.get('colName') or one.get('name'))]

    def _pos(pair):
        idx0, one = pair
        try:
            want = int(one.get('ordinal') or 0)
        except (TypeError, ValueError):
            want = 0
        return (want if want > 0 else idx0 + 1, idx0)

    ordered = sorted(enumerate(items), key=_pos)
    return [(pos + 1, one) for pos, (_, one) in enumerate(ordered)]


# =====================================================================
# 快照与差异（纯函数，不碰数据库，便于单测）
# =====================================================================
def diff_snapshots(before, after):
    """
    两个结构快照 → 变更列表（按「库 → 对象 → 字段」逐层比对）

    :return [{objType, dbName, objName, action, detail, before, after}]
      · objType：db / table / view / procedure
      · action ：create / alter / drop
      · objName：库名.对象名（字段级差异折进对象的 detail，便于「按表查历史」）
    """
    before = before or _empty_snapshot()
    after = after or _empty_snapshot()
    before_dbs = dict((one.get('dbName'), one) for one in (before.get('databases') or []))
    after_dbs = dict((one.get('dbName'), one) for one in (after.get('databases') or []))
    changes = []

    for db_name in sorted(after_dbs.keys()):
        if db_name not in before_dbs:
            changes.append({'objType': 'db', 'dbName': db_name, 'objName': db_name, 'action': 'create',
                            'detail': '新增库 %s' % db_name, 'before': None, 'after': after_dbs[db_name]})
    for db_name in sorted(before_dbs.keys()):
        if db_name not in after_dbs:
            changes.append({'objType': 'db', 'dbName': db_name, 'objName': db_name, 'action': 'drop',
                            'detail': '删除库 %s' % db_name, 'before': before_dbs[db_name], 'after': None})
            # 整库消失时，库里的对象也要逐条记删除，否则回滚 / 正向脚本都是空的
            for obj in (before_dbs[db_name].get('objects') or []):
                changes.append({'objType': obj.get('objType') or 'table', 'dbName': db_name,
                                'objName': '%s.%s' % (db_name, obj.get('objName')), 'action': 'drop',
                                'detail': '删除%s %s' % (
                                    OBJ_TYPE_LABELS.get(obj.get('objType'), '对象'), obj.get('objName')),
                                'before': obj, 'after': None})

    for db_name in sorted(after_dbs.keys()):
        if db_name not in before_dbs:
            # 新库下的对象一并算新增（按对象逐条记，脚本才能生成建表语句）
            for obj in (after_dbs[db_name].get('objects') or []):
                changes.append({'objType': obj.get('objType') or 'table', 'dbName': db_name,
                                'objName': '%s.%s' % (db_name, obj.get('objName')),
                                'action': 'create', 'detail': '新增%s %s' % (
                                    OBJ_TYPE_LABELS.get(obj.get('objType'), '对象'), obj.get('objName')),
                                'before': None, 'after': obj})
            continue
        before_objs = dict((one.get('objName'), one) for one in (before_dbs[db_name].get('objects') or []))
        after_objs = dict((one.get('objName'), one) for one in (after_dbs[db_name].get('objects') or []))
        for obj_name in sorted(after_objs.keys()):
            obj = after_objs[obj_name]
            if obj_name not in before_objs:
                changes.append({'objType': obj.get('objType') or 'table', 'dbName': db_name,
                                'objName': '%s.%s' % (db_name, obj_name), 'action': 'create',
                                'detail': '新增%s %s' % (
                                    OBJ_TYPE_LABELS.get(obj.get('objType'), '对象'), obj_name),
                                'before': None, 'after': obj})
                continue
            old = before_objs[obj_name]
            detail = _object_diff_detail(old, obj)
            if detail:
                changes.append({'objType': obj.get('objType') or 'table', 'dbName': db_name,
                                'objName': '%s.%s' % (db_name, obj_name), 'action': 'alter',
                                'detail': detail, 'before': old, 'after': obj})
        for obj_name in sorted(before_objs.keys()):
            if obj_name in after_objs:
                continue
            old = before_objs[obj_name]
            changes.append({'objType': old.get('objType') or 'table', 'dbName': db_name,
                            'objName': '%s.%s' % (db_name, obj_name), 'action': 'drop',
                            'detail': '删除%s %s' % (OBJ_TYPE_LABELS.get(old.get('objType'), '对象'), obj_name),
                            'before': old, 'after': None})
    return changes


_DDL_DEFINER = re.compile(r'\bDEFINER\s*=\s*(?:`[^`]*`|[\w.%$-]+)\s*@\s*(?:`[^`]*`|[\w.%$-]+)', re.I)


def _ddl_key(text):
    """DDL 归一，只用于判断「定义是否一致」

      · 去掉 `DEFINER=xx@yy`：开发库是 sa@localhost、生产库可能是 app@10.%，
        同一份视图定义换个环境就会多出这串，逐字符比较全是假差异；
      · 空白折叠、去结尾分号 —— 只差换行 / 大小写空格的同一定义不该算差异。
    """
    out = _DDL_DEFINER.sub('', str(text or ''))
    out = re.sub(r'\s+', ' ', out).strip()
    return out.rstrip(';').strip()


def _object_diff_detail(old, new):
    """对象级差异摘要：注释 / DDL / 字段增删改 / 顺序"""
    parts = []
    if str(old.get('objComment') or '').strip() != str(new.get('objComment') or '').strip():
        parts.append('修改注释')
    if str(old.get('objType') or '') != str(new.get('objType') or ''):
        parts.append('对象类型变化')
    if str(old.get('objType') or 'table') != 'table':
        if _ddl_key(old.get('ddl')) != _ddl_key(new.get('ddl')):
            parts.append('修改定义')
        return '；'.join(parts)
    old_cols = dict((one.get('colName'), one) for one in (old.get('columns') or []))
    new_cols = dict((one.get('colName'), one) for one in (new.get('columns') or []))
    added = [one for one in new_cols if one not in old_cols]
    dropped = [one for one in old_cols if one not in new_cols]
    changed = []
    for name in new_cols:
        if name in old_cols and _col_signature(old_cols[name]) != _col_signature(new_cols[name]):
            changed.append(name)
    if added:
        parts.append('新增字段 %s' % '、'.join(added[:5]) + ('…' if len(added) > 5 else ''))
    if dropped:
        parts.append('删除字段 %s' % '、'.join(dropped[:5]) + ('…' if len(dropped) > 5 else ''))
    if changed:
        parts.append('修改字段 %s' % '、'.join(changed[:5]) + ('…' if len(changed) > 5 else ''))
    old_order = [one.get('colName') for one in _sorted_columns(old)]
    new_order = [one.get('colName') for one in _sorted_columns(new)]
    if old_order != new_order and not (added or dropped):
        parts.append('字段顺序变化')
    return '；'.join(parts)


def _col_signature(col):
    keys = ('dataType', 'length', 'nullable', 'defaultValue', 'isPk', 'isAutoInc', 'colComment')
    out = []
    for key in keys:
        value = col.get(key)
        if key in ('nullable', 'isPk', 'isAutoInc'):
            out.append(bool(value))
        else:
            out.append('' if value is None else str(value).strip())
    return tuple(out)


COL_ATTR_LABELS = (('nullable', '可空'), ('defaultValue', '默认值'),
                   ('isPk', '主键'), ('isAutoInc', '自增'), ('colComment', '注释'))


def _col_type_text(col):
    """字段类型的一行文本：varchar(100) / decimal(10,2) / int"""
    col = col or {}
    logical = _text(col.get('dataType')) or '?'
    length = _text(col.get('length'))
    return '%s(%s)' % (logical, length) if length else logical


def _col_attr_text(key, value):
    if key == 'nullable':
        return '允许' if value else '不允许'
    if key in ('isPk', 'isAutoInc'):
        return '是' if value else '否'
    if key == 'colComment':
        text = _text(value)
        return '「%s」' % text if text else '空'
    text = _text(value)
    return text if text else '空'


def _col_brief(col):
    """字段定义的一行文本：varchar(100) 非空 默认 'x' 主键 注释「名称」"""
    col = col or {}
    parts = [_col_type_text(col), '允许空' if bool(col.get('nullable', True)) else '非空']
    default = _text(col.get('defaultValue'))
    if default:
        parts.append('默认 %s' % default)
    if col.get('isPk'):
        parts.append('主键')
    if col.get('isAutoInc'):
        parts.append('自增')
    comment = _text(col.get('colComment'))
    if comment:
        parts.append('注释「%s」' % comment)
    return ' '.join(parts)


def _keep_extra_columns(left_tbl, right_tbl):
    """保守目标表：设计态的列 + 实库多出来的列（排在末尾）

    不勾「包含删除语句」时，用它当 after —— 这样 `alter_table` 只会出
    ADD COLUMN / MODIFY COLUMN，不会把实库多出来的列 DROP 掉（避免误删数据）。
    """
    cols = list(_sorted_columns(left_tbl))
    names = set(str(one.get('colName')) for one in cols)
    for one in _sorted_columns(right_tbl):
        if str(one.get('colName')) in names:
            continue
        cols.append(dict(one, ordinal=len(cols) + 1))
    return dict(left_tbl, columns=cols)


def _cut_message(text, limit=480):
    text = _text(text)
    return text if len(text) <= limit else text[:limit - 1] + '…'


def _order_fix_statements(db_type, before_tbl, after_tbl):
    """列顺序差异 → 重排语句（只有 MySQL / MariaDB 能改列位置）

    :return (语句列表, 备注, 已重排的列名列表)
            备注非空表示这个方言改不了顺序，脚本里要说明；
            列名列表给调用方去重：这些 MODIFY 已经带上了设计态的完整列定义，
            同列的属性修改语句不必再重复一遍。
    """
    db_type = schema_ddl.normalize_db_type(db_type)
    want = [str(one.get('colName')) for one in _sorted_columns(after_tbl)]
    have = [str(one.get('colName')) for one in _sorted_columns(before_tbl)]
    if want == have:
        return [], '', []
    if db_type not in ('mysql', 'mariadb'):
        return [], ('该方言不支持调整列顺序（设计 %s / 实库 %s），已跳过；'
                    '需要时请重建表' % (','.join(want), ','.join(have))), []
    cols = dict((str(one.get('colName')), one) for one in _sorted_columns(after_tbl))
    name = schema_ddl.quote(db_type, after_tbl.get('objName'), '表名')
    idx = 0
    while idx < min(len(want), len(have)) and want[idx] == have[idx]:
        idx += 1
    out, moved = [], []
    for pos in range(idx, len(want)):
        col = cols.get(want[pos])
        if not col:
            continue
        where = 'FIRST' if pos == 0 else 'AFTER %s' % schema_ddl.quote(db_type, want[pos - 1])
        out.append('ALTER TABLE %s MODIFY COLUMN %s %s'
                   % (name, schema_ddl.render_column(db_type, col), where))
        moved.append(want[pos])
    return out, '', moved


def _modify_column_name(statement):
    """从 `ALTER TABLE x MODIFY COLUMN <name> …` 里取出列名（只认 MySQL 反引号写法）

    取不到返回空串 —— 调用方据此跳过，不做任何猜测式去重。
    """
    mark = ' MODIFY COLUMN '
    if mark not in statement:
        return ''
    rest = statement.split(mark, 1)[1]
    if not rest.startswith('`'):
        return ''
    end = rest.find('`', 1)
    return rest[1:end] if end > 1 else ''


def _item_upgrade_sql(db_type, item, include_drop=False):
    """单条对比差异 → (给实库升级用的语句列表, 备注)

    方向固定「实库 → 设计态」：before 取实库定义，after 取设计态定义。
      · 实库多出的对象默认**不生成 DROP**（避免误删数据），要显式 include_drop；
      · 库级差异不出 CREATE / DROP DATABASE：环境与权限差异太大，交人工；
      · 视图 / 存储过程改定义按「先删后建」重建。
    """
    db_type = schema_ddl.normalize_db_type(db_type)
    left, right = item.get('left'), item.get('right')          # left=设计态 right=实库
    kind = str((left or right or {}).get('objType') or item.get('objType') or 'table')
    if kind == 'db' or str(item.get('objType') or '') == 'db':
        return [], '库级差异不生成语句：库的创建 / 删除涉及环境与权限，请人工确认'
    label = OBJ_TYPE_LABELS.get(kind, '对象')
    if left and not right:
        if kind == 'table':
            return schema_ddl.create_table(db_type, left), ''
        if not str(left.get('ddl') or '').strip():
            return [], '%s没有保存定义（ddl），无法自动生成，请先补定义再发布' % label
        return _create_statements(db_type, left), ''
    if right and not left:
        if not include_drop:
            return [], '实库多出的对象：默认不生成删除语句（勾选「包含删除语句」才生成）'
        return schema_ddl.drop_object(db_type, right), ''
    if kind != 'table':
        if not str(left.get('ddl') or '').strip():
            return [], '%s没有保存定义（ddl），无法自动生成，请先补定义再发布' % label
        create = _create_statements(db_type, left)
        if 'OR REPLACE' in str(left.get('ddl') or '').upper():
            return create, '%s按 CREATE OR REPLACE 原地重建' % label
        return schema_ddl.drop_object(db_type, right) + create, '%s按「先删后建」重建' % label
    target = left if include_drop else _keep_extra_columns(left, right)
    statements = schema_ddl.alter_table(db_type, right, target)
    # 列顺序只按「设计态的列」对齐：实库多出来的列不参与重排（保留模式下列会被留在末尾）
    more, note, moved = _order_fix_statements(db_type, right, left)
    if moved:
        # 重排语句本身带设计态的完整列定义（含位置），同列的属性修改语句去掉，避免同一列改两遍
        stones = set(moved)
        statements = [one for one in statements
                      if _modify_column_name(one) not in stones]
    dropped = [str(one.get('colName')) for one in _sorted_columns(right)
               if str(one.get('colName')) not in set(str(one2.get('colName'))
                                                     for one2 in _sorted_columns(left))]
    notes = [note] if note else []
    if moved:
        notes.append('另按设计态调整了 %d 个字段的顺序（MODIFY … AFTER）' % len(moved))
    if dropped and not include_drop:
        notes.append('实库多出的字段 %s 默认不生成 DROP COLUMN（会丢数据）；'
                     '需要彻底对齐时勾选「包含删除语句」'
                     % ('、'.join(dropped[:5]) + ('…' if len(dropped) > 5 else '')))
    return statements + more, '；'.join(notes)


def _col_compare(lobj, robj):
    """设计态表 vs 实库表 → {diffType, message, details}

    details 一条 = 一个「到底哪里不一样」，页面上逐行展示，也是升级脚本的依据：
      addCol（实库缺字段要加）/ dropCol（实库多字段要删）/ alterCol（属性不同）/
      order（顺序不同）/ comment（表注释不同）
    """
    lcols = _sorted_columns(lobj)
    rcols = _sorted_columns(robj)
    lmap = dict((str(one.get('colName')), one) for one in lcols)
    rmap = dict((str(one.get('colName')), one) for one in rcols)
    lorder = [str(one.get('colName')) for one in lcols]
    rorder = [str(one.get('colName')) for one in rcols]
    details, parts = [], []

    for name in lorder:
        if name in rmap:
            continue
        text = '实库缺字段「%s」：新增 %s' % (name, _col_brief(lmap[name]))
        details.append({'kind': 'addCol', 'colName': name, 'text': text})
        parts.append('新增字段 %s' % name)
    for name in rorder:
        if name in lmap:
            continue
        text = '实库多字段「%s」（设计态没有）：%s' % (name, _col_brief(rmap[name]))
        details.append({'kind': 'dropCol', 'colName': name, 'text': text})
        parts.append('删除字段 %s' % name)
    for name in lorder:
        old, new = rmap.get(name), lmap.get(name)
        if not old or not new:
            continue
        fields = []
        if _col_type_text(old) != _col_type_text(new):
            fields.append({'key': 'type', 'label': '类型',
                           'from': _col_type_text(old), 'to': _col_type_text(new)})
        for key, label in COL_ATTR_LABELS:
            a, b = old.get(key), new.get(key)
            same = (bool(a) == bool(b)) if key in ('nullable', 'isPk', 'isAutoInc') \
                else (_text(a) == _text(b))
            if same:
                continue
            fields.append({'key': key, 'label': label,
                           'from': _col_attr_text(key, a), 'to': _col_attr_text(key, b)})
        if not fields:
            continue
        details.append({'kind': 'alterCol', 'colName': name, 'fields': fields,
                        'text': '字段「%s」不同：%s' % (name, '，'.join(
                            '%s %s → %s' % (one['label'], one['from'], one['to'])
                            for one in fields))})
        parts.append('修改字段 %s' % name)
    if not details:
        if lorder != rorder:
            details.append({'kind': 'order',
                            'text': '字段顺序不同：设计 %s；实库 %s'
                                    % (', '.join(lorder) or '空', ', '.join(rorder) or '空')})
            parts.append('字段顺序不同')
        old_comment = _text(lobj.get('objComment'))
        new_comment = _text(robj.get('objComment'))
        if old_comment != new_comment:
            details.append({'kind': 'comment', 'text': '表注释「%s」→「%s」'
                                                      % (old_comment or '空', new_comment or '空')})
            parts.append('表注释不同')

    diff_type = ''
    if any(one['kind'] == 'addCol' for one in details):
        diff_type = 'designOnly'
    if any(one['kind'] == 'dropCol' for one in details):
        diff_type = diff_type or 'dbOnly'
    if any(one['kind'] in ('alterCol', 'comment') for one in details):
        diff_type = 'attrDiff'
    if not diff_type and details:
        diff_type = 'orderDiff'
    if not details:
        return {'diffType': 'same', 'message': '', 'details': []}
    message = ('共 %d 项：' % len(details) if len(details) > 1 else '') + '；'.join(parts)
    return {'diffType': diff_type, 'message': _cut_message(message), 'details': details}


def _item_details(item):
    """一条对比差异 → 逐行明细（页面「说明」列逐行展示，脚本头注释也用它）"""
    left, right = item.get('left'), item.get('right')
    kind = str((left or right or {}).get('objType') or item.get('objType') or 'table')
    diff_type = str(item.get('diffType') or 'same')
    if diff_type == 'same':
        return []
    if left and right and kind == 'table':
        return _col_compare(left, right)['details']
    if left and not right:
        if kind == 'table':
            return [{'kind': 'create', 'text': '实库没有这张表，按设计态建表（%d 个字段）'
                                              % len(left.get('columns') or [])}]
        return [{'kind': 'create', 'text': '实库没有这个%s，按设计态创建' % OBJ_TYPE_LABELS.get(kind, '对象')}]
    if right and not left:
        if kind == 'table':
            return [{'kind': 'drop', 'text': '实库有、设计态没有（未纳管，%d 个字段）；默认脚本不含删除语句'
                                             % len(right.get('columns') or [])}]
        return [{'kind': 'drop', 'text': '实库有、设计态没有这个%s；默认脚本不含删除语句'
                                         % OBJ_TYPE_LABELS.get(kind, '对象')}]
    return [{'kind': 'rebuild', 'text': '定义不同，脚本按设计态的新定义重建（可原地替换的直接替换）'}]


def _dialect_family(db_type):
    """方言族：MySQL 与 MariaDB 归一族（同语法、同 information_schema），其余各自成一族。

    对比时「实库连接」和「设计态应用」必须同族 —— 设计态只存逻辑类型，跨方言比对会把每一列
    都判成类型不一致，生成的脚本也没法在实库上执行。
    """
    value = schema_ddl.normalize_db_type(db_type)
    return 'mysql' if value in ('mysql', 'mariadb') else value


def _upgrade_plan(db_type, items, target_db, include_drop=False):
    """差异项 → 升级脚本计划（实库 → 设计态）

    语句顺序：先建（表）→ 再改 → 再重建视图 / 存储过程 → 最后删（默认不生成）。
    :return {'groups': [...], 'statements': [...], 'counts': {对象名: 语句数},
             'notes': {对象名: 备注}, 'errors': [...], 'brief': {...}}
    """
    db_type = schema_ddl.normalize_db_type(db_type)
    action_rank = {'designOnly': 0, 'attrDiff': 1, 'orderDiff': 1, 'dbOnly': 2, 'same': 9}
    # 表先建，然后才是依附于它的索引 / 触发器；视图、过程、函数最后（可能引用表与彼此）
    type_rank = {'table': 0, 'index': 1, 'trigger': 2, 'view': 3, 'procedure': 4, 'function': 5,
                 'db': 6}
    todo = [one for one in (items or []) if one.get('diffType') != 'same']
    todo.sort(key=lambda one: (action_rank.get(one.get('diffType'), 5),
                               type_rank.get(str(one.get('objType') or 'table'), 5),
                               str(one.get('objName') or '')))
    groups, counts, notes, errors, statements = [], {}, {}, [], []
    for one in todo:
        name = str(one.get('objName') or '')
        try:
            sql, note = _item_upgrade_sql(db_type, one, include_drop)
        except Exception as exc:                       # 单个对象失败不影响其它对象
            sql, note = [], '生成失败：%s' % (str(exc) or exc.__class__.__name__)
            errors.append('%s：%s' % (name, str(exc) or exc.__class__.__name__))
        counts[name] = len(sql)
        if note:
            notes[name] = note
        statements.extend(sql)
        groups.append({'objName': name, 'objType': str(one.get('objType') or 'table'),
                       'diffType': one.get('diffType'),
                       'diffLabel': DIFF_LABELS.get(one.get('diffType'), one.get('diffType')),
                       'statements': sql, 'note': note,
                       'details': [d.get('text') for d in (one.get('details') or []) if d.get('text')]})
    covered = [one for one in groups if one['statements']]
    brief = {'dbType': db_type, 'dbTypeLabel': schema_ddl.db_label(db_type),
             'dbName': target_db or '', 'includeDrop': bool(include_drop),
             'count': len(statements), 'objects': len(covered),
             'diffCount': len(todo), 'skipped': len(groups) - len(covered),
             'errors': len(errors)}
    return {'groups': groups, 'statements': statements, 'counts': counts,
            'notes': notes, 'errors': errors, 'brief': brief}


def _upgrade_text(db_type, groups, meta):
    """升级脚本分组 → 可直接执行的完整文本（每条语句前带注释，说明它在修哪条差异）"""
    db_type = schema_ddl.normalize_db_type(db_type)
    title = '%s 结构升级脚本（实库 → 设计态%s）' % (
        meta.get('appName') or '应用',
        '，目标库 %s' % meta.get('dbName') if meta.get('dbName') else '')
    blocks = [schema_ddl.header(db_type, 'forward', title, meta.get('notes') or [],
                                source='应用架构 · 实库对比升级（脚本不会自动执行，请人工确认后执行）')]
    for group in groups or []:
        if not group.get('statements'):
            continue
        lines = ['-- ------------------------------------------------------------',
                 '-- [%s] %s · %s · %d 条语句'
                 % (OBJ_TYPE_LABELS.get(group.get('objType'), '对象'), group.get('objName'),
                    group.get('diffLabel') or '', len(group['statements']))]
        for text in (group.get('details') or []):
            lines.append('--   · %s' % text)
        if group.get('note'):
            lines.append('--   注意：%s' % group['note'])
        lines.append('-- ------------------------------------------------------------')
        blocks.append('\n'.join(lines) + '\n' + schema_ddl.join_statements(db_type, group['statements']))
    skipped = [one for one in (groups or []) if not one.get('statements')]
    if skipped:
        lines = ['-- ------------------------------------------------------------',
                 '-- 以下 %d 项差异没有生成语句，需要人工处理：' % len(skipped)]
        for one in skipped:
            lines.append('--   · %s%s' % (one.get('objName'),
                                          ('：' + one['note']) if one.get('note') else ''))
        lines.append('-- ------------------------------------------------------------')
        blocks.append('\n'.join(lines))
    return '\n\n'.join(blocks) + '\n'


def build_scripts(db_type, before, after):
    """
    两个快照 → (正向语句, 回滚语句, 无法生成的原因列表)
      · 正向：before → after；回滚：after → before（回滚脚本只保证结构可回，
        被删掉的**数据**无法恢复，脚本头部会写明）；
      · 库（database）本身不生成 CREATE DATABASE：权限与环境差异太大，只出表级脚本；
      · 一条对象失败不影响其它对象，失败原因收集到 errors 里（页面上直接展示）。
    """
    db_type = schema_ddl.normalize_db_type(db_type)
    forward, errors = _statements_for(db_type, diff_snapshots(before, after), 'forward')
    rollback, back_errors = _statements_for(db_type, diff_snapshots(after, before), 'rollback')
    for one in back_errors:
        errors.append('回滚：' + one)
    return forward, rollback, errors


def _statements_for(db_type, changes, kind):
    order = {'create': 0, 'alter': 1, 'drop': 2}
    type_order = {'table': 0, 'view': 1, 'procedure': 2, 'db': 3}
    if kind == 'rollback':
        # 回滚反着来：先删后建，避免依赖打架
        order = {'drop': 0, 'alter': 1, 'create': 2}
        type_order = {'view': 0, 'procedure': 1, 'table': 2, 'db': 3}
    items = sorted([one for one in changes if one.get('objType') != 'db'],
                   key=lambda one: (order.get(one.get('action'), 9),
                                    type_order.get(one.get('objType'), 9),
                                    str(one.get('objName') or '')))
    statements, errors = [], []
    for one in items:
        action = one.get('action')
        obj = one.get('after') if action != 'drop' else one.get('before')
        try:
            if action == 'create':
                statements.extend(_create_statements(db_type, obj))
            elif action == 'drop':
                statements.extend(schema_ddl.drop_object(db_type, obj))
            else:
                statements.extend(_alter_statements(db_type, one.get('before'), one.get('after')))
        except Exception as exc:                     # 单个对象失败不影响其它对象
            errors.append('%s：%s' % (one.get('objName'), str(exc) or exc.__class__.__name__))
    return statements, errors


def _create_statements(db_type, obj):
    return schema_ddl.create_object(db_type, obj)


def _alter_statements(db_type, before, after):
    kind = str((after or before).get('objType') or 'table')
    if kind != 'table':
        # 视图 / 存储过程：先删后建（PostgreSQL 的 CREATE OR REPLACE 不能改列，统一用重建更稳）
        return schema_ddl.drop_object(db_type, before) + _create_statements(db_type, after)
    return schema_ddl.alter_table(db_type, before, after)


def summarize(changes):
    """变更列表 → 一句话摘要（版本列表 / 历史时间线用）"""
    counts = {'create': 0, 'alter': 0, 'drop': 0}
    for one in changes or []:
        counts[one.get('action') or 'alter'] = counts.get(one.get('action') or 'alter', 0) + 1
    parts = []
    if counts.get('create'):
        parts.append('新增 %d' % counts['create'])
    if counts.get('alter'):
        parts.append('修改 %d' % counts['alter'])
    if counts.get('drop'):
        parts.append('删除 %d' % counts['drop'])
    return '，'.join(parts) if parts else '无变更'


# =====================================================================
# 应用信息
# =====================================================================
class AppInfoService(object):
    """
    应用信息（appinfos，UUID 主键）
      · 编码 APP + 4 位流水号，唯一；
      · dbConnId 唯一 → 一个连接只能挂一个应用；为空表示纯手工维护（不扫描）；
      · 列表带库数 / 对象数 / 表数，页面不用再点进去数；
      · 删除应用会连带删除它的结构、版本与脚本（历史随应用一起消失，二次确认）。
    """

    table = 'appinfos'
    label = '应用'
    CODE_PREFIX = 'APP'
    CODE_DIGITS = 4
    CODE_MAX = 9999

    # ---------------- 小工具 ----------------
    def _login_emp_id(self, params):
        params = params or {}
        user_id = _text(params.get('_loginUserId'))
        if user_id:
            try:
                row = query_one(LOGIN_EMP_SQL, (user_id,))
            except Exception:
                row = None
            if row and row.get('empId'):
                return int(row['empId'])
        return None

    def _visibility(self, params):
        emp_id = self._login_emp_id(params)
        if not emp_id:
            return '', []
        return ' (`a`.`createempinfosid`=%s OR `a`.`ispub`=1)', [emp_id]

    def _find(self, uid):
        row = query_one('SELECT * FROM `appinfos` WHERE `id`=%s', (uid,))
        if not row:
            raise BizError('应用不存在或已被删除', 404)
        return row

    def _attach(self, rows):
        for it in rows:
            it['status'] = bool(int(it.get('status') if it.get('status') is not None else 1))
            it['ispub'] = bool(int(it.get('ispub') if it.get('ispub') is not None else 1))
            it['ispubText'] = '公用' if it['ispub'] else '私有'
            it['dbType'] = schema_ddl.normalize_db_type(it.get('dbType'))
            it['dbTypeLabel'] = schema_ddl.db_label(it['dbType'])
            it['appTypeLabel'] = ''
            for one in APP_TYPE_OPTIONS:
                if one['value'] == it.get('appType'):
                    it['appTypeLabel'] = one['label']
            for one in ENV_OPTIONS:
                if one['value'] == it.get('env'):
                    it['envLabel'] = one['label']
            it['hasConn'] = bool(it.get('dbConnId'))
            it['dbCount'] = int(it.get('dbCount') or 0)
            it['objCount'] = int(it.get('objCount') or 0)
            it['tableCount'] = int(it.get('tableCount') or 0)
            it['lastScanTime'] = it.get('lastScanTime') or ''
            it['lastError'] = it.get('lastError') or ''
            it['ownerName'] = it.get('ownerName') or ''
            it['deptName'] = it.get('deptName') or ''
            it['connName'] = it.get('connName') or ''
            it['createempinfosid'] = int(it.get('createempinfosid') or 0)
        return rows

    def _next_code(self):
        pattern = '^%s[0-9]{%d}$' % (self.CODE_PREFIX, self.CODE_DIGITS)
        rows = query_all('SELECT `code` FROM `appinfos` WHERE `code` REGEXP %s', (pattern,)) or []
        max_seq = 0
        for row in rows:
            try:
                seq = int(str(row.get('code'))[len(self.CODE_PREFIX):])
            except (TypeError, ValueError):
                continue
            max_seq = max(max_seq, seq)
        seq = max_seq + 1
        while seq <= self.CODE_MAX:
            code = '%s%0*d' % (self.CODE_PREFIX, self.CODE_DIGITS, seq)
            if not query_one('SELECT `id` FROM `appinfos` WHERE `code`=%s', (code,)):
                return code
            seq += 1
        raise BizError('应用编码已超出上限（%s）' % ('%s%0*d' % (self.CODE_PREFIX, self.CODE_DIGITS, self.CODE_MAX)))

    # ---------------- 查询 ----------------
    def next_code(self, params=None):
        return {'code': self._next_code()}

    def meta(self, params=None):
        """表单下拉：应用类型 / 环境 / 数据库类型 / 逻辑类型"""
        return {'appTypes': APP_TYPE_OPTIONS, 'envs': ENV_OPTIONS,
                'dbTypes': connector.type_options(),
                'logicalTypes': schema_ddl.LOGICAL_TYPES,
                'objTypes': [{'value': key, 'label': value} for key, value in OBJ_TYPE_LABELS.items()]}

    def page(self, params):
        params = params or {}
        where, args = [], []
        vis_sql, vis_args = self._visibility(params)
        if vis_sql:
            where.append(vis_sql)
            args.extend(vis_args)
        keyword = _text(params.get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            where.append('(`a`.`code` LIKE %s OR `a`.`name` LIKE %s OR `a`.`shortName` LIKE %s '
                         'OR `a`.`description` LIKE %s)')
            args.extend([like, like, like, like])
        app_types = _multi_values(params.get('appType'))
        in_sql, in_args = _in_clause('`a`.`appType`', app_types)
        if in_sql:
            where.append(in_sql)
            args.extend(in_args)
        db_types = [schema_ddl.normalize_db_type(one) for one in _multi_values(params.get('dbType'))]
        db_types = [one for i, one in enumerate(db_types) if one not in db_types[:i]]
        in_sql, in_args = _in_clause('`a`.`dbType`', db_types)
        if in_sql:
            where.append(in_sql)
            args.extend(in_args)
        status = params.get('status')
        if status is not None and str(status).strip() != '':
            where.append('`a`.`status`=%s')
            args.append(1 if _bool(status, True) else 0)
        where_sql = (' WHERE ' + ' AND '.join(where)) if where else ''
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 10), 1), 200)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        total_row = query_one('SELECT COUNT(*) AS n FROM `appinfos` `a`' + where_sql, args)
        total = int(total_row['n']) if total_row else 0
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        sql = (
            'SELECT `a`.*, `c`.`name` AS `connName`, `c`.`dbType` AS `connDbType`, '
            '       `o`.`nameCn` AS `ownerName`, `d`.`nameCn` AS `deptName`, '
            '       (SELECT COUNT(*) FROM `appschemadbs` `x` WHERE `x`.`appId`=`a`.`id`) AS `dbCount`, '
            '       (SELECT COUNT(*) FROM `appschemaobjs` `y` JOIN `appschemadbs` `z` ON `z`.`id`=`y`.`dbId` '
            '         WHERE `z`.`appId`=`a`.`id`) AS `objCount`, '
            '       (SELECT COUNT(*) FROM `appschemaobjs` `y2` JOIN `appschemadbs` `z2` ON `z2`.`id`=`y2`.`dbId` '
            '         WHERE `z2`.`appId`=`a`.`id` AND `y2`.`objType`=%s) AS `tableCount` '
            'FROM `appinfos` `a` '
            'LEFT JOIN `dbinfomgr` `c` ON `c`.`id`=`a`.`dbConnId` '
            'LEFT JOIN `empinfos` `o` ON `o`.`id`=`a`.`ownerEmpId` '
            'LEFT JOIN `OrganizationStructure` `d` ON `d`.`id`=`a`.`deptId`'
            + where_sql +
            ' ORDER BY `a`.`status` DESC, `a`.`code` ASC, `a`.`id` ASC LIMIT %s OFFSET %s')
        rows = query_all(sql, ['table'] + args + [page_size, (page_num - 1) * page_size])
        return {'list': self._attach([dump_row(r) for r in rows]), 'total': total,
                'pageNum': page_num, 'pageSize': page_size, 'pages': pages}

    def detail(self, params):
        uid = _uuid((params or {}).get('id'))
        row = query_one(
            'SELECT `a`.*, `c`.`name` AS `connName`, `c`.`dbType` AS `connDbType`, '
            '       `o`.`nameCn` AS `ownerName`, `d`.`nameCn` AS `deptName` '
            'FROM `appinfos` `a` LEFT JOIN `dbinfomgr` `c` ON `c`.`id`=`a`.`dbConnId` '
            'LEFT JOIN `empinfos` `o` ON `o`.`id`=`a`.`ownerEmpId` '
            'LEFT JOIN `OrganizationStructure` `d` ON `d`.`id`=`a`.`deptId` WHERE `a`.`id`=%s', (uid,))
        if not row:
            raise BizError('应用不存在或已被删除', 404)
        return self._attach([dump_row(row)])[0]

    def check(self, params):
        field = _text((params or {}).get('field')) or 'code'
        if field not in ('code', 'name'):
            raise BizError('不支持的唯一性校验字段：' + field)
        value = _text((params or {}).get('value'))
        if not value:
            return {'unique': True}
        self_id = _text((params or {}).get('id'))
        row = query_one('SELECT `id` FROM `appinfos` WHERE `%s`=%%s AND `id`<>%%s LIMIT 1' % field,
                        (value, self_id))
        return {'unique': row is None}

    def options(self, params=None):
        """应用下拉（启用 + 可见），供结构页 / 其它模块选应用"""
        params = params or {}
        where = ['`a`.`status`=1']
        args = []
        vis_sql, vis_args = self._visibility(params)
        if vis_sql:
            where.append(vis_sql)
            args.extend(vis_args)
        rows = query_all('SELECT `a`.`id`,`a`.`code`,`a`.`name`,`a`.`dbType` FROM `appinfos` `a` WHERE '
                         + ' AND '.join(where) + ' ORDER BY `a`.`code`', args)
        return {'list': [dump_row(r) for r in rows]}

    def connections(self, params=None):
        """可用连接下拉：启用的 + 可见的 + 没被别的应用占用（当前应用自己占着的除外）"""
        params = params or {}
        app_id = _text(params.get('appId'))
        emp_id = self._login_emp_id(params)
        where = ['`enabled`=1']
        args = []
        if emp_id:
            where.append('(`createempinfosid`=%s OR `ispub`=1)')
            args.append(emp_id)
        if app_id:
            where.append('(`id` NOT IN (SELECT `dbConnId` FROM `appinfos` WHERE `dbConnId` IS NOT NULL '
                         'AND `id`<>%s))')
            args.append(app_id)
        else:
            where.append('(`id` NOT IN (SELECT `dbConnId` FROM `appinfos` WHERE `dbConnId` IS NOT NULL))')
        rows = query_all('SELECT `id`,`name`,`dbType`,`host`,`port`,`dbName` FROM `dbinfomgr` WHERE '
                         + ' AND '.join(where) + ' ORDER BY `name`', args)
        out = []
        for row in rows:
            one = dump_row(row)
            one['dbType'] = str(one.get('dbType') or 'mysql').lower()
            one['dbTypeLabel'] = connector.type_label(one['dbType'])
            out.append(one)
        return {'list': out}

    # ---------------- 写入 ----------------
    def _normalize(self, data, current=None):
        data = data or {}
        current = current or {}
        name = _text(data.get('name')) or _text(current.get('name'))
        if not name:
            raise BizError('应用名称不能为空')
        if len(name) > 100:
            raise BizError('应用名称最多 100 个字符')
        code = _text(data.get('code')) or _text(current.get('code'))
        if code and not re.match(r'^[A-Za-z0-9_-]{2,40}$', code):
            raise BizError('应用编码只允许字母、数字、下划线、短横线（2-40 位）')
        app_type = _text(data.get('appType')) or _text(current.get('appType')) or 'web'
        if app_type not in [one['value'] for one in APP_TYPE_OPTIONS]:
            app_type = 'other'
        env = _text(data.get('env')) or _text(current.get('env')) or 'prod'
        if env not in [one['value'] for one in ENV_OPTIONS]:
            env = 'prod'
        db_type = schema_ddl.normalize_db_type(_text(data.get('dbType')) or _text(current.get('dbType')) or 'mysql')
        conn_id = _text(data.get('dbConnId'))
        if 'dbConnId' in data and not conn_id:
            conn_id = ''
        picked = {
            'name': name,
            'shortName': _text(data.get('shortName'))[:50] or None,
            'appType': app_type,
            'dbType': db_type,
            'env': env,
            'description': _text(data.get('description'))[:500] or None,
            'ownerEmpId': self._int_or_none(data.get('ownerEmpId'), current.get('ownerEmpId')),
            'deptId': self._int_or_none(data.get('deptId'), current.get('deptId')),
        }
        if code:
            picked['code'] = code.upper() if code.upper().startswith('APP') else code
        if 'dbConnId' in data:
            picked['dbConnId'] = conn_id or None
        elif current:
            picked['dbConnId'] = current.get('dbConnId')      # 局部更新不能把已绑定的连接冲掉
        if 'status' in data:
            picked['status'] = 1 if _bool(data.get('status'), True) else 0
        if 'ispub' in data:
            picked['ispub'] = 1 if _bool(data.get('ispub'), True) else 0
        # 选了连接：类型跟连接对象一致（避免「MySQL 的连接 + Oracle 的脚本」这种荒唐组合）
        if picked.get('dbConnId'):
            conn = query_one('SELECT `id`,`name`,`dbType` FROM `dbinfomgr` WHERE `id`=%s',
                             (picked['dbConnId'],))
            if not conn:
                raise BizError('所选数据库连接不存在或已被删除')
            conn_type = schema_ddl.normalize_db_type(conn.get('dbType'))
            if 'dbType' in data and picked['dbType'] != conn_type:
                raise BizError('数据库类型与所选连接不一致：连接「%s」是 %s，应用填的是 %s'
                               % (conn.get('name'), connector.type_label(conn_type),
                                  connector.type_label(picked['dbType'])))
            picked['dbType'] = conn_type
        return picked

    @staticmethod
    def _int_or_none(value, fallback=None):
        if value is None or str(value).strip() == '':
            if fallback is None or str(fallback).strip() == '':
                return None
            try:
                return int(fallback)
            except (TypeError, ValueError):
                return None
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            raise BizError('部门 / 负责人必须是数字ID')

    def _assert_conn_free(self, conn_id, self_id=''):
        if not conn_id:
            return
        row = query_one('SELECT `id`,`name` FROM `appinfos` WHERE `dbConnId`=%s AND `id`<>%s LIMIT 1',
                        (conn_id, self_id))
        if row:
            raise BizError('该数据库连接已绑定应用「%s」，一个连接只能对应一个应用' % row.get('name'))

    def add(self, data):
        data = data or {}
        picked = self._normalize(data)
        picked['code'] = picked.get('code') or self._next_code()
        self._assert_conn_free(picked.get('dbConnId'))
        if query_one('SELECT `id` FROM `appinfos` WHERE `code`=%s LIMIT 1', (picked['code'],)):
            raise BizError('应用编码【%s】已存在，请重新取号' % picked['code'])
        picked['id'] = str(uuid.uuid4())
        picked.setdefault('status', 1)
        picked.setdefault('ispub', 1)
        picked['createempinfosid'] = self._login_emp_id(data)
        columns = ','.join('`%s`' % c for c in picked.keys())
        holders = ','.join(['%s'] * len(picked))
        try:
            execute('INSERT INTO `appinfos` (%s) VALUES (%s)' % (columns, holders),
                    list(picked.values()))
        except DuplicateError:
            raise BizError('应用编码【%s】或数据库连接已被占用，请刷新后重试' % picked['code'])
        return self.detail({'id': picked['id']})

    def update(self, data):
        data = data or {}
        uid = _uuid(data.get('id'))
        current = self._find(uid)
        picked = self._normalize(data, current)
        self._assert_conn_free(picked.get('dbConnId'), uid)
        if picked.get('code'):
            row = query_one('SELECT `id` FROM `appinfos` WHERE `code`=%s AND `id`<>%s LIMIT 1',
                            (picked['code'], uid))
            if row:
                raise BizError('应用编码【%s】已存在' % picked['code'])
        assignments = ','.join('`%s`=%%s' % c for c in picked.keys())
        try:
            execute('UPDATE `appinfos` SET %s, `lastError`=NULL WHERE `id`=%%s' % assignments,
                    list(picked.values()) + [uid])
        except DuplicateError:
            raise BizError('应用编码或数据库连接已被占用')
        return self.detail({'id': uid})

    def delete(self, params):
        uid = _uuid((params or {}).get('id'))
        app = self._find(uid)
        db_ids = [one['id'] for one in (query_all('SELECT `id` FROM `appschemadbs` WHERE `appId`=%s',
                                                  (uid,)) or [])]
        ver_ids = [one['id'] for one in (query_all('SELECT `id` FROM `appschemavers` WHERE `appId`=%s',
                                                   (uid,)) or [])]
        cmp_ids = [one['id'] for one in (query_all('SELECT `id` FROM `appschemacompares` WHERE `appId`=%s',
                                                   (uid,)) or [])]

        def run(cur):
            for db_id in db_ids:
                cur.execute('DELETE `c` FROM `appschemacols` `c` JOIN `appschemaobjs` `o` ON `o`.`id`=`c`.`objId` '
                            'WHERE `o`.`dbId`=%s', (db_id,))
                cur.execute('DELETE FROM `appschemaobjs` WHERE `dbId`=%s', (db_id,))
            cur.execute('DELETE FROM `appschemadbs` WHERE `appId`=%s', (uid,))
            for ver_id in ver_ids:
                cur.execute('DELETE FROM `appschemachanges` WHERE `verId`=%s', (ver_id,))
                cur.execute('DELETE FROM `appschemascripts` WHERE `verId`=%s', (ver_id,))
            cur.execute('DELETE FROM `appschemavers` WHERE `appId`=%s', (uid,))
            for cmp_id in cmp_ids:
                cur.execute('DELETE FROM `appschemacompareitems` WHERE `compareId`=%s', (cmp_id,))
            cur.execute('DELETE FROM `appschemacompares` WHERE `appId`=%s', (uid,))
            cur.execute('DELETE FROM `appinfos` WHERE `id`=%s', (uid,))
        transaction(run)
        item = self._attach([dump_row(app)])[0]
        item['message'] = '应用「%s」及其结构、版本、脚本、对比记录已删除' % app.get('name')
        return item

    def enabled(self, params):
        params = params or {}
        uid = _uuid(params.get('id'))
        app = self._find(uid)
        on = 1 if _bool(params.get('status', params.get('enabled', 1)), True) else 0
        execute('UPDATE `appinfos` SET `status`=%s WHERE `id`=%s', (on, uid))
        item = self.detail({'id': uid})
        item['message'] = '应用「%s」已%s' % (app.get('name'), '启用' if on else '停用')
        return item


# =====================================================================
# 应用结构（库 / 对象 / 字段 / 版本 / 脚本 / 对比）
# =====================================================================
class AppSchemaService(object):
    """
    应用结构管理：
      tree        应用 → 库 → 表 / 视图 / 存储过程（字段懒加载）
      dbadd/dbupdate/dbdel          库维护
      objadd/objupdate/objdel       表 / 视图 / 存储过程维护
      cols/colsave/coldel           字段维护（colsave 支持批量，一次保存一版）
      scan                          从连接指定的那一个库扫描导入（写设计态 + 出版本；不做全库扫描）
  scaninfo                      扫描前取「扫哪个库」：连接名 + 默认库 + 可访问库名单（只列名）
      importddl / parse            粘贴 CREATE / ALTER 语句落到设计态
      versions/version/publish     草稿与正式版、生成脚本
      scriptstatus                 人工确认执行后回写状态
      compare/compares/compareitems 与真实数据库对比（仅人工触发，结果留存）
    """

    # ---------------- 基础 ----------------
    def _app(self, app_id):
        uid = _uuid(app_id, '应用 id')
        row = query_one('SELECT * FROM `appinfos` WHERE `id`=%s', (uid,))
        if not row:
            raise BizError('应用不存在或已被删除', 404)
        return row

    def _db(self, db_id):
        uid = _uuid(db_id, '库 id')
        row = query_one('SELECT * FROM `appschemadbs` WHERE `id`=%s', (uid,))
        if not row:
            raise BizError('库不存在或已被删除', 404)
        return row

    def _obj(self, obj_id):
        uid = _uuid(obj_id, '对象 id')
        row = query_one('SELECT * FROM `appschemaobjs` WHERE `id`=%s', (uid,))
        if not row:
            raise BizError('对象不存在或已被删除', 404)
        return row

    def _login_emp_id(self, params):
        params = params or {}
        user_id = _text(params.get('_loginUserId'))
        if user_id:
            try:
                row = query_one(LOGIN_EMP_SQL, (user_id,))
            except Exception:
                row = None
            if row and row.get('empId'):
                return int(row['empId'])
        return None

    def _conn_conf(self, app, conn_id='', params=None):
        """
        连接对象 → connector 配置（密码解密只留在内存）

          · 不传 conn_id：用应用绑定的那个连接（扫描、对比的默认口径）；
          · 传 conn_id：用指定的另一个连接 —— **对比线上生产库**时就是靠它，
            否则一个应用只能对着绑定的开发库比，永远生不出上线升级脚本；
          · 指定的连接同样要过可见性（本人创建 / 他人公用），免得拿别人的私有连接当跳板。
        """
        want = _text(conn_id)
        bound = _text(app.get('dbConnId'))
        target = want or bound
        if not target:
            raise BizError('该应用还没有绑定数据库连接（纯手工维护），不能扫描或对比；'
                           '如果只是要对比线上库，请在对比面板里直接选一个连接')
        row = query_one('SELECT * FROM `dbinfomgr` WHERE `id`=%s', (target,))
        if not row:
            if want:
                raise BizError('选中的数据库连接不存在或已被删除，请重新选择')
            raise BizError('应用绑定的数据库连接已被删除，请先在「应用信息」里重新绑定')
        if want and want != bound and not self._conn_visible(row, self._login_emp_id(params)):
            raise BizError('没有权限使用数据库连接【%s】：它不是你创建的，也没有标为「公用」'
                           % (row.get('name') or ''))
        return {
            'id': row.get('id'), 'name': row.get('name'), 'dbType': row.get('dbType'),
            'host': row.get('host'), 'port': row.get('port'), 'dbName': row.get('dbName'),
            'username': row.get('username'), 'password': connector.decrypt_secret(row.get('password')),
            'charset': row.get('charset'), 'extraParams': row.get('extraParams'),
        }

    @staticmethod
    def _conn_visible(row, emp_id):
        """连接可见性口径与「数据库连接」页一致：本人创建 OR 他人标为公用；拿不到员工 ID 时不过滤"""
        if not emp_id:
            return True
        if str(row.get('ispub') if row.get('ispub') is not None else 1) == '1':
            return True
        owner = row.get('createempinfosid')
        return owner is not None and int(owner or 0) in (0, int(emp_id))

    def _scan_target(self, conf, params):
        """
        解析本次扫描目标 —— **只允许一个库 / 实例**
          · params.database：显式指定（扫描弹窗的下拉就是它），必须能在连接里访问到；
          · 否则用连接对象里的「默认库」（dbinfomgr.dbName）；没填就报错，绝不退化成扫全部；
          · params.all=1：唯一的全库入口（显式逃生口，页面不提供）。
        :return (target, scan_all)  scan_all 为 True 时 target 为空
        """
        params = params or {}
        explicit = _text(params.get('database'))
        if _bool(params.get('all')) and not explicit:
            return '', True
        target = explicit or connector.default_database(conf)
        if not target:
            raise BizError('连接【%s】没有指定「默认库」，无法确定扫描哪一个库：请先到「数据库连接」里'
                           '把默认库填成要扫描的那一个（Oracle 填服务名 / SID、SQLite 填库文件路径），'
                           '或在扫描时选一个库' % (conf.get('name') or conf.get('id') or ''))
        return target, False

    @staticmethod
    def _match_db(all_dbs, target, conf):
        """在可访问库里定位目标库：先精确匹配；Oracle / SQL Server / PostgreSQL 再退一步忽略大小写"""
        want = str(target or '').strip()
        if not want:
            return []
        for one in all_dbs or []:
            if str(one.get('name')) == want:
                return [one]
        db_type = str((conf or {}).get('dbType') or '').lower()
        if db_type in ('oracle', 'sqlserver', 'postgresql', 'mariadb', 'mysql'):
            for one in all_dbs or []:
                if str(one.get('name')).lower() == want.lower():
                    return [one]
        return []

    # ---------------- 快照 ----------------
    def _snapshot(self, app_id):
        """整个应用的结构快照：库 → 对象 → 字段

        **只发 3 条 SQL**：db.execute() 每次都新建连接，早先按对象逐个查字段
        （518 个对象 = 518 次建连）单这一项就要 20 秒，前端 15 秒的普通超时必然先掐。
        现在库 / 对象 / 字段各一条 `IN (...)` 批量取，再在内存里按 dbId、objId 归组；
        排序仍保持「库 sortNo,dbName → 对象 objType,objName → 字段 ordinal,colName」，
        快照内容与逐条查时逐字节一致（版本 hash 不会因为这次改动漂移）。
        """
        dbs = query_all('SELECT * FROM `appschemadbs` WHERE `appId`=%s ORDER BY `sortNo`, `dbName`',
                        (app_id,)) or []
        out = {'databases': []}
        if not dbs:
            return out
        db_ids = [one['id'] for one in dbs]
        objs = query_all('SELECT * FROM `appschemaobjs` WHERE `dbId` IN (%s) '
                         'ORDER BY `dbId`, `objType`, `objName`' % _marks(len(db_ids)),
                         tuple(db_ids)) or []
        obj_ids = [one['id'] for one in objs]
        cols = query_all('SELECT * FROM `appschemacols` WHERE `objId` IN (%s) '
                         'ORDER BY `objId`, `ordinal`, `colName`' % _marks(len(obj_ids)),
                         tuple(obj_ids)) if obj_ids else []
        objs_by_db, cols_by_obj = {}, {}
        for one in objs:
            objs_by_db.setdefault(one['dbId'], []).append(one)
        for one in cols:
            cols_by_obj.setdefault(one['objId'], []).append(self._col_dict(one))
        for db in dbs:
            obj_list = []
            for obj in objs_by_db.get(db['id'], []):
                obj_list.append({
                    'objName': obj.get('objName'), 'objType': obj.get('objType'),
                    'objComment': obj.get('objComment') or '', 'engine': obj.get('engine') or '',
                    'charset': obj.get('charset') or '', 'ddl': obj.get('ddl') or '',
                    'columns': cols_by_obj.get(obj['id'], []),
                })
            out['databases'].append({'dbName': db.get('dbName'), 'dbComment': db.get('dbComment') or '',
                                     'charset': db.get('charset') or '', 'objects': obj_list})
        return out

    @staticmethod
    def _col_dict(row):
        return {
            'colName': row.get('colName'),
            'ordinal': int(row.get('ordinal') or 0),
            'dataType': row.get('dataType') or 'VARCHAR',
            'length': row.get('length') or '',
            'nullable': bool(int(row.get('nullable') if row.get('nullable') is not None else 1)),
            'defaultValue': '' if row.get('defaultValue') is None else str(row.get('defaultValue')),
            'isPk': bool(int(row.get('isPk') or 0)),
            'isAutoInc': bool(int(row.get('isAutoInc') or 0)),
            'colComment': row.get('colComment') or '',
        }

    def _snapshot_of(self, app_id):
        snap = self._snapshot(app_id)
        return snap, _sha1(json.dumps(snap, ensure_ascii=False, sort_keys=True))

    # ---------------- 版本 ----------------
    def _latest_version(self, app_id, kind=None, statuses=None):
        where = ['`appId`=%s']
        args = [app_id]
        if kind:
            where.append('`kind`=%s')
            args.append(kind)
        if statuses:
            where.append('`status` IN (%s)' % ','.join(['%s'] * len(statuses)))
            args.extend(statuses)
        return query_one('SELECT * FROM `appschemavers` WHERE ' + ' AND '.join(where)
                         + ' ORDER BY `seq` DESC LIMIT 1', args)

    def _record_version(self, app, source, summary=None, operator=None):
        """
        保存 → 一条草稿版本（内容与上一版没有变化就不出版本，避免空版本淹没历史）
        :return 新版本行 / None（无变化）
        """
        snap, snap_hash = self._snapshot_of(app['id'])
        prev = query_one('SELECT * FROM `appschemavers` WHERE `appId`=%s AND `status`<>%s '
                         'ORDER BY `seq` DESC LIMIT 1', (app['id'], 'discarded'))
        if prev and prev.get('snapHash') == snap_hash:
            return None
        before = _load_snapshot(prev.get('snapshot')) if prev else _empty_snapshot()
        changes = diff_snapshots(before, snap)
        if not changes:
            return None
        row = query_one('SELECT COALESCE(MAX(`seq`),0) AS `mx` FROM `appschemavers` WHERE `appId`=%s',
                        (app['id'],))
        seq = int((row or {}).get('mx') or 0) + 1
        ver_id = str(uuid.uuid4())
        text = summary or summarize(changes)
        execute('INSERT INTO `appschemavers` (`id`,`appId`,`kind`,`seq`,`baseVerId`,`source`,`status`,'
                '`summary`,`changeCount`,`snapshot`,`snapHash`,`operatorEmpId`) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (ver_id, app['id'], 'draft', seq, prev.get('id') if prev and prev.get('kind') == 'release' else None,
                 source, 'draft', text[:500], len(changes),
                 _dump_snapshot(snap), snap_hash, operator))
        self._save_changes(ver_id, changes)
        return query_one('SELECT * FROM `appschemavers` WHERE `id`=%s', (ver_id,))

    def _save_changes(self, ver_id, changes):
        execute('DELETE FROM `appschemachanges` WHERE `verId`=%s', (ver_id,))
        for one in changes:
            execute('INSERT INTO `appschemachanges` (`id`,`verId`,`objType`,`objName`,`action`,`detail`,'
                    '`beforeJson`,`afterJson`) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                    (str(uuid.uuid4()), ver_id, one.get('objType'), str(one.get('objName'))[:300],
                     one.get('action'), str(one.get('detail') or '')[:500],
                     _dump_json_field(one.get('before')), _dump_json_field(one.get('after'))))

    def _touch(self, app_id, source='manual', summary=None, operator=None):
        app = self._app(app_id) if not isinstance(app_id, dict) else app_id
        ver = self._record_version(app, source, summary, operator)
        return ver

    # ---------------- 树 ----------------
    def tree(self, params):
        params = params or {}
        app = self._app(params.get('appId'))
        dbs = query_all('SELECT * FROM `appschemadbs` WHERE `appId`=%s ORDER BY `sortNo`, `dbName`',
                        (app['id'],)) or []
        out = []
        for db in dbs:
            objs = query_all(
                'SELECT `o`.*, (SELECT COUNT(*) FROM `appschemacols` `c` WHERE `c`.`objId`=`o`.`id`) AS `colCount` '
                'FROM `appschemaobjs` `o` WHERE `o`.`dbId`=%s',
                (db['id'],)) or []
            objs = sorted(objs, key=lambda one: (OBJ_TYPE_ORDER.get(str(one.get('objType')), 9),
                                                 str(one.get('objName') or '')))
            out.append({
                'id': db['id'], 'dbName': db.get('dbName'), 'dbComment': db.get('dbComment') or '',
                'charset': db.get('charset') or '', 'source': db.get('source'),
                'locked': bool(int(db.get('locked') or 0)),
                'objects': [{
                    'id': one['id'], 'objName': one.get('objName'), 'objType': one.get('objType'),
                    'objComment': one.get('objComment') or '', 'colCount': int(one.get('colCount') or 0),
                    'source': one.get('source'), 'locked': bool(int(one.get('locked') or 0)),
                    'typeLabel': OBJ_TYPE_LABELS.get(one.get('objType'), '对象'),
                } for one in objs],
            })
        latest = self._latest_version(app['id'])
        draft = self._latest_version(app['id'], 'draft', ['draft'])
        release = self._latest_version(app['id'], 'release', ['released', 'applied'])
        # 连接对象指定的「默认库」：扫描 / 对比的默认目标，页面用它预选下拉
        conn_db, conn_name = '', ''
        if app.get('dbConnId'):
            conn = query_one('SELECT `name`,`dbType`,`dbName`,`username` FROM `dbinfomgr` WHERE `id`=%s',
                             (app['dbConnId'],))
            if conn:
                conn_name = conn.get('name') or ''
                conn_db = connector.default_database({'dbType': conn.get('dbType'),
                                                     'dbName': conn.get('dbName'),
                                                     'username': conn.get('username')})
        return {
            'app': {'id': app['id'], 'code': app.get('code'), 'name': app.get('name'),
                    'dbType': schema_ddl.normalize_db_type(app.get('dbType')),
                    'dbTypeLabel': schema_ddl.db_label(app.get('dbType')),
                    'hasConn': bool(app.get('dbConnId')),
                    'lastScanTime': _time_text(app.get('lastScanTime')),
                    'lastError': app.get('lastError') or '',
                    'connName': conn_name, 'connDbName': _text(conn_db)},
            'databases': out,
            'dbCount': len(out),
            'objCount': sum(len(one['objects']) for one in out),
            'latest': self._ver_brief(latest),
            'draft': self._ver_brief(draft),
            'release': self._ver_brief(release),
        }

    def _ver_brief(self, row):
        if not row:
            return None
        return {'id': row.get('id'), 'kind': row.get('kind'), 'status': row.get('status'),
                'seq': row.get('seq'), 'versionNo': row.get('versionNo') or '',
                'summary': row.get('summary') or '', 'changeCount': int(row.get('changeCount') or 0),
                'statusLabel': VERSION_STATUS_LABELS.get(row.get('status'), row.get('status')),
                'createTime': _time_text(row.get('createTime')),
                'releaseTime': _time_text(row.get('releaseTime'))}

    # ---------------- 库 ----------------
    def dbadd(self, params):
        params = params or {}
        app = self._app(params.get('appId'))
        name = _text(params.get('dbName'))
        if not name:
            raise BizError('库名不能为空')
        if len(name) > 120:
            raise BizError('库名最多 120 个字符')
        row = query_one('SELECT `id` FROM `appschemadbs` WHERE `appId`=%s AND `dbName`=%s',
                        (app['id'], name))
        if row:
            raise BizError('库【%s】已存在' % name)
        sort_row = query_one('SELECT COALESCE(MAX(`sortNo`),0) AS `mx` FROM `appschemadbs` WHERE `appId`=%s',
                             (app['id'],))
        db_id = str(uuid.uuid4())
        execute('INSERT INTO `appschemadbs` (`id`,`appId`,`dbName`,`dbComment`,`charset`,`source`,`sortNo`) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s)',
                (db_id, app['id'], name, _text(params.get('dbComment'))[:200] or None,
                 _text(params.get('charset'))[:40] or None, 'manual',
                 int((sort_row or {}).get('mx') or 0) + 1))
        self._touch(app, 'manual', '手工新增库 %s' % name, self._login_emp_id(params))
        return self.tree({'appId': app['id']})

    def dbupdate(self, params):
        params = params or {}
        db = self._db(params.get('id'))
        app = self._app(db['appId'])
        name = _text(params.get('dbName')) or db.get('dbName')
        if name != db.get('dbName'):
            row = query_one('SELECT `id` FROM `appschemadbs` WHERE `appId`=%s AND `dbName`=%s AND `id`<>%s',
                            (app['id'], name, db['id']))
            if row:
                raise BizError('库【%s】已存在' % name)
        execute('UPDATE `appschemadbs` SET `dbName`=%s, `dbComment`=%s, `charset`=%s, `locked`=%s, '
                '`sortNo`=%s WHERE `id`=%s',
                (name, _text(params.get('dbComment'))[:200] or None, _text(params.get('charset'))[:40] or None,
                 1 if _bool(params.get('locked')) else 0,
                 int(params.get('sortNo') or db.get('sortNo') or 0), db['id']))
        self._touch(app, 'manual', '修改库 %s' % name, self._login_emp_id(params))
        return self.tree({'appId': app['id']})

    def dbdel(self, params):
        params = params or {}
        db = self._db(params.get('id'))
        app = self._app(db['appId'])
        def run(cur):
            # 库里对象多时（几百上千张表），逐条 DELETE 要几千次往返 —— 删一次库能等到超时；
            # 这里用子查询一次删完字段，再删对象、删库，三条语句搞定。
            cur.execute('DELETE FROM `appschemacols` WHERE `objId` IN '
                        '(SELECT `id` FROM `appschemaobjs` WHERE `dbId`=%s)', (db['id'],))
            cur.execute('DELETE FROM `appschemaobjs` WHERE `dbId`=%s', (db['id'],))
            cur.execute('DELETE FROM `appschemadbs` WHERE `id`=%s', (db['id'],))
        transaction(run)
        self._touch(app, 'manual', '删除库 %s' % db.get('dbName'), self._login_emp_id(params))
        return self.tree({'appId': app['id']})

    # ---------------- 对象 ----------------
    def _obj_payload(self, params, current=None):
        current = current or {}
        name = _text(params.get('objName')) or _text(current.get('objName'))
        if not name:
            raise BizError('对象名不能为空')
        if len(name) > 120:
            raise BizError('对象名最多 120 个字符')
        obj_type = _text(params.get('objType')) or _text(current.get('objType')) or 'table'
        if obj_type not in OBJ_TYPE_LABELS:
            raise BizError('对象类型只能是 %s' % ' / '.join(sorted(OBJ_TYPE_LABELS)))
        return {
            'objName': name,
            'objType': obj_type,
            'objComment': _text(params.get('objComment'))[:500] or None,
            'engine': _text(params.get('engine'))[:40] or None,
            'charset': _text(params.get('charset'))[:40] or None,
            'ddl': _text(params.get('ddl')) or None,
            'locked': 1 if _bool(params.get('locked')) else 0,
        }

    def objadd(self, params):
        params = params or {}
        db = self._db(params.get('dbId'))
        app = self._app(db['appId'])
        payload = self._obj_payload(params)
        if query_one('SELECT `id` FROM `appschemaobjs` WHERE `dbId`=%s AND `objName`=%s',
                     (db['id'], payload['objName'])):
            raise BizError('对象【%s】已存在' % payload['objName'])
        if payload['objType'] != 'table' and not payload.get('ddl'):
            raise BizError('非表对象（视图 / 过程 / 函数 / 触发器 / 索引）必须填写定义（DDL 原文）')
        obj_id = str(uuid.uuid4())
        execute('INSERT INTO `appschemaobjs` (`id`,`dbId`,`objType`,`objName`,`objComment`,`engine`,'
                '`charset`,`ddl`,`source`,`locked`) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (obj_id, db['id'], payload['objType'], payload['objName'], payload['objComment'],
                 payload['engine'], payload['charset'], payload['ddl'], 'manual', payload['locked']))
        self._touch(app, 'manual', '手工新增%s %s' % (OBJ_TYPE_LABELS[payload['objType']], payload['objName']),
                    self._login_emp_id(params))
        self._touch_lineage(app)          # 新增视图 / 过程：血缘跟着重算（失败不影响保存）
        return {'id': obj_id, 'tree': self.tree({'appId': app['id']})}

    def objupdate(self, params):
        params = params or {}
        obj = self._obj(params.get('id'))
        db = self._db(obj['dbId'])
        app = self._app(db['appId'])
        payload = self._obj_payload(params, obj)
        if payload['objName'] != obj.get('objName'):
            if query_one('SELECT `id` FROM `appschemaobjs` WHERE `dbId`=%s AND `objName`=%s AND `id`<>%s',
                         (db['id'], payload['objName'], obj['id'])):
                raise BizError('对象【%s】已存在' % payload['objName'])
        execute('UPDATE `appschemaobjs` SET `objName`=%s, `objType`=%s, `objComment`=%s, `engine`=%s, '
                '`charset`=%s, `ddl`=%s, `locked`=%s WHERE `id`=%s',
                (payload['objName'], payload['objType'], payload['objComment'], payload['engine'],
                 payload['charset'], payload['ddl'], payload['locked'], obj['id']))
        self._touch(app, 'manual', '修改%s %s' % (OBJ_TYPE_LABELS.get(payload['objType'], '对象'),
                                               payload['objName']), self._login_emp_id(params))
        self._touch_lineage(app)          # 定义改了（视图 / 过程 / 触发器）：血缘跟着重算
        return {'id': obj['id'], 'tree': self.tree({'appId': app['id']})}

    def objdel(self, params):
        params = params or {}
        obj = self._obj(params.get('id'))
        db = self._db(obj['dbId'])
        app = self._app(db['appId'])
        def run(cur):
            cur.execute('DELETE FROM `appschemacols` WHERE `objId`=%s', (obj['id'],))
            cur.execute('DELETE FROM `appschemaobjs` WHERE `id`=%s', (obj['id'],))
        transaction(run)
        self._touch(app, 'manual', '删除%s %s' % (OBJ_TYPE_LABELS.get(obj.get('objType'), '对象'),
                                               obj.get('objName')), self._login_emp_id(params))
        self._touch_lineage(app)          # 对象没了：它的血缘边要一起消失
        return self.tree({'appId': app['id']})

    # ---------------- 字段 ----------------
    def cols(self, params):
        params = params or {}
        obj = self._obj(params.get('objId'))
        db = self._db(obj['dbId'])
        rows = query_all('SELECT * FROM `appschemacols` WHERE `objId`=%s ORDER BY `ordinal`, `colName`',
                         (obj['id'],)) or []
        return {
            'object': {'id': obj['id'], 'objName': obj.get('objName'), 'objType': obj.get('objType'),
                       'objComment': obj.get('objComment') or '', 'ddl': obj.get('ddl') or '',
                       'dbName': db.get('dbName'), 'appId': db.get('appId'),
                       'typeLabel': OBJ_TYPE_LABELS.get(obj.get('objType'), '对象')},
            'list': [dict(self._col_dict(one), id=one['id'], source=one.get('source'),
                          locked=bool(int(one.get('locked') or 0))) for one in rows],
        }

    def _col_payload(self, params):
        name = _text(params.get('colName'))
        if not name:
            raise BizError('字段名不能为空')
        if len(name) > 120:
            raise BizError('字段名最多 120 个字符')
        data_type = _text(params.get('dataType') or 'VARCHAR').upper()
        if data_type not in schema_ddl.TYPE_VALUES:
            raise BizError('不支持的字段类型：%s' % data_type)
        length = _text(params.get('length'))[:20]
        if length and not re.match(r'^\d+(\s*,\s*\d+)?$', length):
            raise BizError('字段长度只允许数字，或「精度,小数位」（如 100、12,2）')
        is_pk = 1 if _bool(params.get('isPk')) else 0
        # 主键不允许为空：页面勾了「主键」还留着「可空」时按 NOT NULL 存，
        # 否则生成出来的 DDL 会是 `PRIMARY KEY NULL` 这种自相矛盾的写法
        nullable = 0 if is_pk else (1 if _bool(params.get('nullable'), True) else 0)
        return {
            'colName': name, 'dataType': data_type, 'length': length or None,
            'nullable': nullable,
            'defaultValue': _text(params.get('defaultValue'))[:255] or None,
            'isPk': is_pk,
            'isAutoInc': 1 if _bool(params.get('isAutoInc')) else 0,
            'colComment': _text(params.get('colComment'))[:500] or None,
            'locked': 1 if _bool(params.get('locked')) else 0,
        }

    def colsave(self, params):
        """
        保存字段：params.cols 可以是数组（批量粘贴 / 导入），也可以单条
          · 有 id → 更新（保留 ordinal）；没有 id → 追加到末尾；
          · 一次请求只出一条草稿版本。
        """
        params = params or {}
        obj = self._obj(params.get('objId'))
        db = self._db(obj['dbId'])
        app = self._app(db['appId'])
        raw_list = params.get('cols')
        if raw_list is None:
            raw_list = [params]
        if not isinstance(raw_list, list) or not raw_list:
            raise BizError('没有要保存的字段')
        existing = query_all('SELECT * FROM `appschemacols` WHERE `objId`=%s ORDER BY `ordinal`',
                             (obj['id'],)) or []
        max_ordinal = 0
        for one in existing:
            max_ordinal = max(max_ordinal, int(one.get('ordinal') or 0))
        seen = {}
        for one in existing:
            seen[str(one.get('colName'))] = one['id']
        saved = []
        for raw in raw_list:
            payload = self._col_payload(raw or {})
            col_id = _text((raw or {}).get('id'))
            if col_id:
                current = self._col_of(obj['id'], col_id)
                if not current:
                    raise BizError('字段不存在或已被删除')
                if payload['colName'] != current.get('colName') and payload['colName'] in seen:
                    raise BizError('字段【%s】已存在' % payload['colName'])
                seen.pop(str(current.get('colName')), None)
                seen[payload['colName']] = col_id
                execute('UPDATE `appschemacols` SET `colName`=%s, `dataType`=%s, `length`=%s, `nullable`=%s, '
                        '`defaultValue`=%s, `isPk`=%s, `isAutoInc`=%s, `colComment`=%s, `locked`=%s '
                        'WHERE `id`=%s',
                        (payload['colName'], payload['dataType'], payload['length'], payload['nullable'],
                         payload['defaultValue'], payload['isPk'], payload['isAutoInc'],
                         payload['colComment'], payload['locked'], col_id))
                saved.append(col_id)
            else:
                if payload['colName'] in seen:
                    raise BizError('字段【%s】已存在' % payload['colName'])
                max_ordinal += 1
                col_id = str(uuid.uuid4())
                execute('INSERT INTO `appschemacols` (`id`,`objId`,`colName`,`ordinal`,`dataType`,`length`,'
                        '`nullable`,`defaultValue`,`isPk`,`isAutoInc`,`colComment`,`source`,`locked`) '
                        'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                        (col_id, obj['id'], payload['colName'], max_ordinal, payload['dataType'],
                         payload['length'], payload['nullable'], payload['defaultValue'], payload['isPk'],
                         payload['isAutoInc'], payload['colComment'], 'manual', payload['locked']))
                seen[payload['colName']] = col_id
                saved.append(col_id)
        self._touch(app, 'manual', '维护%s %s 的字段（%d 个）'
                    % (OBJ_TYPE_LABELS.get(obj.get('objType'), '对象'), obj.get('objName'), len(saved)),
                    self._login_emp_id(params))
        return self.cols({'objId': obj['id'], '_loginUserId': params.get('_loginUserId')})

    def _col_of(self, obj_id, col_id):
        row = query_one('SELECT * FROM `appschemacols` WHERE `id`=%s AND `objId`=%s', (col_id, obj_id))
        return dump_row(row) if row else None

    def coldel(self, params):
        params = params or {}
        obj = self._obj(params.get('objId'))
        db = self._db(obj['dbId'])
        app = self._app(db['appId'])
        col_id = _uuid(params.get('id'), '字段 id')
        col = query_one('SELECT * FROM `appschemacols` WHERE `id`=%s AND `objId`=%s', (col_id, obj['id']))
        if not col:
            raise BizError('字段不存在或已被删除')
        execute('DELETE FROM `appschemacols` WHERE `id`=%s', (col_id,))
        self._touch(app, 'manual', '删除字段 %s.%s' % (obj.get('objName'), col.get('colName')),
                    self._login_emp_id(params))
        return self.cols({'objId': obj['id'], '_loginUserId': params.get('_loginUserId')})

    # ---------------- 扫描导入 ----------------
    def _upsert_db(self, app_id, db_name, charset=None):
        row = query_one('SELECT * FROM `appschemadbs` WHERE `appId`=%s AND `dbName`=%s',
                        (app_id, db_name))
        if row:
            return row['id']
        sort_row = query_one('SELECT COALESCE(MAX(`sortNo`),0) AS `mx` FROM `appschemadbs` WHERE `appId`=%s',
                             (app_id,))
        db_id = str(uuid.uuid4())
        execute('INSERT INTO `appschemadbs` (`id`,`appId`,`dbName`,`charset`,`source`,`sortNo`) '
                'VALUES (%s,%s,%s,%s,%s,%s)',
                (db_id, app_id, db_name, charset, 'scan', int((sort_row or {}).get('mx') or 0) + 1))
        return db_id

    def _upsert_obj(self, db_id, obj_type, name, comment='', rows=0, ddl=''):
        row = query_one('SELECT * FROM `appschemaobjs` WHERE `dbId`=%s AND `objName`=%s', (db_id, name))
        if row:
            if int(row.get('locked') or 0):
                return row['id'], False      # 锁定对象：扫描不覆盖
            execute('UPDATE `appschemaobjs` SET `objType`=%s, `objComment`=%s, `rowCount`=%s, '
                    '`ddl`=COALESCE(NULLIF(%s,\'\'), `ddl`) WHERE `id`=%s',
                    (obj_type, comment or None, int(rows or 0), ddl or '', row['id']))
            return row['id'], False
        obj_id = str(uuid.uuid4())
        execute('INSERT INTO `appschemaobjs` (`id`,`dbId`,`objType`,`objName`,`objComment`,`rowCount`,'
                '`ddl`,`source`) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                (obj_id, db_id, obj_type, name, comment or None, int(rows or 0), ddl or None, 'scan'))
        return obj_id, True

    def _sync_columns(self, obj_id, columns, source='scan'):
        """字段同步：存在则更新（锁定的保留原值），新增则插入，缺失的删除（手工录入的保留）

        columns 兼容两种形状：
          · 扫描结果：{name, dataType:'varchar(100)', nullable, key:'PRI', extra, defaultValue, comment}
          · 解析 / 手工：{colName, dataType:'VARCHAR'(逻辑类型), length, nullable, isPk, isAutoInc, colComment}
        """
        existing = query_all('SELECT * FROM `appschemacols` WHERE `objId`=%s', (obj_id,)) or []
        by_key = {}
        for one in existing:
            by_key.setdefault(_col_key(one.get('colName')), one)
        used = set(by_key.keys())
        seen = set()                            # 本次扫描真正落库的列（判「实库没了」用）
        added = updated = kept = 0
        dup_names = []
        # 三条批量语句（新增 / 更新 / 只调顺序）+ 一条批量删除，最后在一个事务里一次性写完。
        # 早期写法是「一列一句 execute」，而 execute 每次都会新建一条数据库连接：
        # 600 张表 × 20 列 ≈ 一万多次连接，扫描就慢在这儿（远程库更明显）。
        inserts, updates, reorders, drop_ids = [], [], [], []
        # 列顺序：按实库位置（见 _ordered_columns）落库，位置连续化 1..n
        for pos, col in _ordered_columns(columns):
            # 列名保留实库原样（只去尾随空格），前导 / 内嵌的换行是真实标识符的一部分；
            # 同名判定统一走 _col_key（见它上面的注释，别改成精确比字符串）。
            name = str(col.get('colName') or col.get('name') or '').rstrip()
            if not name.strip():
                continue
            if len(name) > 120:
                # colName 是 VARCHAR(120)：Oracle 12.2 起标识符可到 128 字节，超长的一律跳过
                # （截断会把两个长名截成同一个，又撞回唯一索引），让它进告警里人工处理。
                if name not in dup_names:
                    dup_names.append(name)
                continue
            key = _col_key(name)
            if key in used and by_key.get(key) is None:
                # 本次扫描里出现了「MySQL 看来重复」的列（同一列写了两遍，或只差大小写 /
                # 尾随空格）：跳过并记账，绝不能再 INSERT 一条 —— 那就是 Duplicate entry。
                if name not in dup_names:
                    dup_names.append(name)
                continue
            used.add(key)
            seen.add(key)
            raw_type = _text(col.get('dataType'))
            if raw_type.upper() in schema_ddl.TYPE_VALUES:
                logical, length = raw_type.upper(), _text(col.get('length'))
            else:
                logical, length = schema_ddl.canonical_type(raw_type)
            payload = {
                'dataType': logical, 'length': length or None,
                'nullable': 1 if col.get('nullable', True) else 0,
                'defaultValue': ('' if col.get('defaultValue') is None else str(col.get('defaultValue'))[:255]),
                'isPk': 1 if (str(col.get('key') or '').upper() == 'PRI' or col.get('isPk')) else 0,
                'isAutoInc': 1 if ('auto_increment' in str(col.get('extra') or '').lower()
                                   or col.get('isAutoInc')) else 0,
                'colComment': (str(col.get('colComment') or col.get('comment') or '')[:500] or None),
            }
            current = by_key.get(key)
            if current:
                if int(current.get('locked') or 0):
                    kept += 1
                    reorders.append((pos, current['id']))
                    continue
                updates.append((pos, payload['dataType'], payload['length'], payload['nullable'],
                                payload['defaultValue'], payload['isPk'], payload['isAutoInc'],
                                payload['colComment'], current['id']))
                updated += 1
            else:
                inserts.append((str(uuid.uuid4()), obj_id, name, pos, payload['dataType'],
                                payload['length'], payload['nullable'], payload['defaultValue'],
                                payload['isPk'], payload['isAutoInc'], payload['colComment'], source))
                added += 1
        dropped = 0
        for one in existing:
            if _col_key(one.get('colName')) in seen:
                continue
            if int(one.get('locked') or 0) or str(one.get('source')) == 'manual':
                continue                       # 手工录入的字段，扫描不能删
            drop_ids.append((one['id'],))
            dropped += 1
        if reorders or updates or inserts or drop_ids:
            def run(cur):
                if reorders:
                    cur.executemany('UPDATE `appschemacols` SET `ordinal`=%s WHERE `id`=%s', reorders)
                if updates:
                    cur.executemany('UPDATE `appschemacols` SET `ordinal`=%s, `dataType`=%s, `length`=%s, '
                                    '`nullable`=%s, `defaultValue`=%s, `isPk`=%s, `isAutoInc`=%s, '
                                    '`colComment`=%s WHERE `id`=%s', updates)
                if inserts:
                    cur.executemany('INSERT INTO `appschemacols` (`id`,`objId`,`colName`,`ordinal`,'
                                    '`dataType`,`length`,`nullable`,`defaultValue`,`isPk`,`isAutoInc`,'
                                    '`colComment`,`source`) '
                                    'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', inserts)
                if drop_ids:
                    # 一次删完：主键 in 列表，避免一列一个连接（列数可能上千）
                    marks = ','.join(['%s'] * len(drop_ids))
                    cur.execute('DELETE FROM `appschemacols` WHERE `id` IN (' + marks + ')', drop_ids)
            transaction(run)
        return added, updated, dropped, kept, dup_names

    def scan_info(self, params):
        """
        扫描前给页面用：连接信息 + 「默认库」+ 该连接能访问的库名单
          · 这里**只列库名**（不读表 / 字段），页面据此把「扫描目标」默认选中连接的默认库，
            并且只允许选一个 —— 扫描的范围由连接对象决定，不是把实例里所有库都扫一遍；
          · 连接没填默认库**不算错误**（needPick=true）：让用户在弹窗里现场选一个，别把人卡在
            「先去改连接」这一步；只有未绑定 / 已删除 / 连不上才进 error；
          · params.connId 可换成**另一个**连接（实库对比面板「选连接 → 选库」就复用它）：
            默认还是应用绑定的连接。
        """
        params = params or {}
        app = self._app(params.get('appId'))
        conn_id = _text(params.get('connId'))
        out = {'hasConn': bool(app.get('dbConnId')), 'connId': conn_id or app.get('dbConnId') or '',
               'connName': '', 'dbType': schema_ddl.normalize_db_type(app.get('dbType')),
               'dbTypeLabel': schema_ddl.db_label(app.get('dbType')),
               'target': '', 'needPick': False, 'databases': [], 'error': ''}
        if conn_id and conn_id != _text(app.get('dbConnId')):
            out['hasConn'] = True          # 显式指定了连接：不依赖应用绑定
        if not out['hasConn']:
            out['error'] = '这个应用没有绑定数据库连接（纯手工维护），不能扫描'
            return out
        try:
            conf = self._conn_conf(app, conn_id, params)
        except BizError as exc:
            out['error'] = exc.message
            return out
        out['connName'] = conf.get('name') or ''
        out['connHost'] = conf.get('host') or ''
        out['connPort'] = conf.get('port') or ''
        out['dbType'] = schema_ddl.normalize_db_type(conf.get('dbType'))
        out['dbTypeLabel'] = schema_ddl.db_label(conf.get('dbType'))
        out['target'] = connector.default_database(conf)
        try:
            res = connector.databases(conf)
        except connector.ConnError as exc:
            out['error'] = exc.message
            return out
        out['databases'] = [{'name': str(one.get('name') or ''), 'system': bool(one.get('system')),
                             'current': bool(one.get('current')),
                             'tableCount': int(one.get('tableCount') or 0)}
                            for one in (res.get('databases') or [])]
        if not out['target']:
            out['needPick'] = True          # 连接没填默认库：弹窗里现场选一个（单选），照旧只扫一个库
        return out

    def compare_conns(self, params):
        """
        实库对比的「可选连接」清单：只列**同方言族**且可见的连接（本人创建的 + 他人标为公用的）

          · 不在这里连库、不读库名单（一个连接一个往返，列表里有 20 个连接就卡十几秒）：
            选中连接后再调 scaninfo?connId= 取它能访问的库；
          · 方言不同的一律不列：设计态按 appinfos.dbType 渲染脚本，实库换方言没法逐字段比，
            比出来全是「类型不一致」的噪音，升级脚本也不能执行。
        """
        params = params or {}
        app = self._app(params.get('appId'))
        emp_id = self._login_emp_id(params)
        app_type = schema_ddl.normalize_db_type(app.get('dbType'))
        family = _dialect_family(app_type)
        where = ['1=1']
        args = []
        if emp_id:
            where.append('(`createempinfosid`=%s OR `createempinfosid` IS NULL OR `createempinfosid`=0 '
                         'OR `ispub`=1)')
            args.append(emp_id)
        rows = query_all('SELECT `id`,`name`,`dbType`,`host`,`port`,`dbName`,`username`,`enabled`,'
                         '`ispub`,`createempinfosid` FROM `dbinfomgr` WHERE ' + ' AND '.join(where)
                         + ' ORDER BY `name`', args) or []
        bound = _text(app.get('dbConnId'))
        out = []
        for row in rows:
            live_type = schema_ddl.normalize_db_type(row.get('dbType'))
            if _dialect_family(live_type) != family:
                continue
            out.append({
                'id': row.get('id'), 'name': row.get('name') or '',
                'dbType': live_type, 'dbTypeLabel': schema_ddl.db_label(live_type),
                'host': row.get('host') or '', 'port': row.get('port') or '',
                'defaultDb': connector.default_database({
                    'dbType': row.get('dbType'), 'dbName': row.get('dbName'),
                    'username': row.get('username')}),
                'enabled': bool(int(row.get('enabled') or 0)),
                'ispub': bool(int(row.get('ispub') if row.get('ispub') is not None else 1)),
                'isBound': _text(row.get('id')) == bound,
            })
        return {'appId': app['id'], 'appDbType': app_type,
                'appDbTypeLabel': schema_ddl.db_label(app_type),
                'boundConnId': bound, 'list': out}

    def scan(self, params):
        """
        从应用绑定的连接扫描结构并导入设计态（首次导入也走这里）
          · **只扫连接对象指定的那一个库 / 实例**（dbinfomgr.dbName → connector.default_database）；
            连接没指定就拒绝扫描 —— 不做「全库扫描」，免得把同一实例里别人的库、系统库一并纳管；
          · params.database 可以换成同一个连接下的**另一个**库（单选，页面的扫描弹窗就是它）；
          · params.all=1 是显式逃生口（运维特批才用，页面不提供），才会扫该连接下全部非系统库；
          · 只同步本次扫到的库；没扫到的库不删（可能只是没权限）；
          · 表 / 视图：存在则更新，缺失且 source=scan 且未锁定的删除；手工录入的保留；
          · 字段：同上（手工录入 / 锁定的字段不会被删）；
          · 结束后出一条草稿版本（有变化才出）。
        :param params {appId, database, all}
        """
        params = params or {}
        app = self._app(params.get('appId'))
        conf = self._conn_conf(app)
        only_db, scan_all = self._scan_target(conf, params)
        max_tables = 600
        stats = {'databases': 0, 'tables': 0, 'views': 0, 'procedures': 0, 'functions': 0,
                 'indexes': 0, 'triggers': 0, 'columns': 0,
                 'added': 0, 'updated': 0, 'dropped': 0, 'kept': 0, 'skipped': 0, 'warnings': [],
                 'target': only_db, 'scope': 'all' if scan_all else 'single'}
        try:
            result = connector.databases(conf)
        except connector.ConnError as exc:
            self._mark_scan(app['id'], False, exc.message)
            raise BizError(exc.message)
        all_dbs = result.get('databases') or []
        if scan_all:
            dbs = [one for one in all_dbs if not one.get('system')]
            if not dbs:
                raise BizError('连接【%s】下没有可导入的库' % (conf.get('name') or ''))
        else:
            dbs = self._match_db(all_dbs, only_db, conf)
            if not dbs:
                names = [str(one.get('name')) for one in all_dbs if not one.get('system')][:12]
                raise BizError('连接【%s】里找不到库 / 实例【%s】：它下面能访问的是 %s；'
                               '请检查连接对象的「默认库」，或在扫描时选对库'
                               % (conf.get('name') or '', only_db, '、'.join(names) or '（无）'))
        scanned_dbs = set()
        for db in dbs:
            db_name = str(db.get('name') or '')
            if not db_name:
                continue
            db_id = self._upsert_db(app['id'], db_name)
            scanned_dbs.add(db_name)
            stats['databases'] += 1
            try:
                table_res = connector.tables(conf, db_name)
            except connector.ConnError as exc:
                stats['warnings'].append('%s：%s' % (db_name, exc.message))
                continue
            table_list = (table_res.get('tables') or [])[:max_tables]
            if len(table_res.get('tables') or []) > max_tables:
                stats['warnings'].append('%s 表太多（%d），只导入了前 %d 张'
                                         % (db_name, len(table_res.get('tables') or []), max_tables))
            seen_objs = {}
            for table in table_list:
                name = str(table.get('name') or '')
                if not name:
                    continue
                kind = 'view' if str(table.get('kind') or '').lower() == 'view' else 'table'
                ddl = ''
                try:                       # 只给视图取原文；表的结构由字段描述重建，避免依赖 SHOW CREATE
                    if kind == 'view':
                        ddl = self._view_ddl(conf, db_name, name)
                except Exception:
                    ddl = ''
                obj_id, created = self._upsert_obj(db_id, kind, name, table.get('comment') or '',
                                                  table.get('rows') or 0, ddl)
                seen_objs[name] = obj_id
                stats['views' if kind == 'view' else 'tables'] += 1
                if created:
                    stats['added'] += 1
                try:
                    col_res = connector.columns(conf, db_name, name)
                except connector.ConnError as exc:
                    stats['warnings'].append('%s.%s 字段读取失败：%s' % (db_name, name, exc.message))
                    continue
                cols = col_res.get('columns') or []
                added, updated, dropped, kept, col_dups = self._sync_columns(obj_id, cols)
                if col_dups:
                    # 库里同一张表出现了「MySQL 看来同名」的列（只差大小写 / 尾随空格，
                    # 或把同一个列名返回了两遍）：只保留第一条，其余跳过，扫描不再中断。
                    stats['warnings'].append('%s.%s 有 %d 个列名异常（重复 / 超长）被跳过：%s'
                                             % (db_name, name, len(col_dups), '、'.join(col_dups[:5])))
                stats['columns'] += len(cols)
                stats['added'] += added
                stats['updated'] += updated
                stats['dropped'] += dropped
                stats['kept'] += kept
            # 存储过程 / 函数（不是所有库都支持，取不到就跳过，不算失败）
            try:
                proc_res = connector.routines(conf, db_name)
                for proc in (proc_res.get('routines') or [])[:max_tables]:
                    pname = str(proc.get('name') or '')
                    if not pname:
                        continue
                    ptype = 'function' if str(proc.get('type') or '').lower() == 'function' else 'procedure'
                    obj_id, created = self._upsert_obj(db_id, ptype, pname,
                                                      proc.get('comment') or '', 0, proc.get('ddl') or '')
                    seen_objs[pname] = obj_id
                    stats[ptype + 's'] = int(stats.get(ptype + 's') or 0) + 1
                    if ptype == 'procedure':
                        stats['procedures'] += 1
                    if created:
                        stats['added'] += 1
            except Exception as exc:
                stats['warnings'].append('%s 存储过程未导入：%s' % (db_name, str(exc)[:120]))
            # 索引 / 触发器：依附于表，objName 存成「表名.对象名」（索引名只在表内唯一）
            # 注意返回键是 indexes / triggers（不是 index + 's'），别再拼错
            for aux_kind, aux_key, getter in (('index', 'indexes', connector.indexes),
                                              ('trigger', 'triggers', connector.triggers)):
                try:
                    aux_res = getter(conf, db_name)
                except Exception as exc:
                    stats['warnings'].append('%s %s未导入：%s'
                                             % (db_name, OBJ_TYPE_LABELS.get(aux_kind, '对象'), str(exc)[:120]))
                    continue
                if not aux_res.get('supported', True):
                    stats['warnings'].append('%s 该方言暂不支持扫描%s'
                                             % (db_name, OBJ_TYPE_LABELS.get(aux_kind, '对象')))
                    continue
                for one in aux_res.get(aux_key) or []:
                    aname = str(one.get('objName') or one.get('name') or '')
                    if not aname:
                        continue
                    obj_id, created = self._upsert_obj(db_id, aux_kind, aname,
                                                      one.get('comment') or '', 0, one.get('ddl') or '')
                    seen_objs[aname] = obj_id
                    stats[aux_key] = int(stats.get(aux_key) or 0) + 1
                    if created:
                        stats['added'] += 1
            # 扫描缺失的对象：只删「source=scan 且未锁定」（批量删，别一个对象一条连接）
            gone = []
            for one in query_all('SELECT `id`,`objName`,`source`,`locked` FROM `appschemaobjs` WHERE `dbId`=%s',
                                 (db_id,)) or []:
                if str(one.get('objName')) in seen_objs:
                    continue
                if int(one.get('locked') or 0) or str(one.get('source')) == 'manual':
                    stats['kept'] += 1
                    continue
                gone.append((one['id'],))
                stats['dropped'] += 1
            if gone:
                marks = ','.join(['%s'] * len(gone))

                def drop_run(cur):
                    cur.execute('DELETE FROM `appschemacols` WHERE `objId` IN (' + marks + ')', gone)
                    cur.execute('DELETE FROM `appschemaobjs` WHERE `id` IN (' + marks + ')', gone)
                transaction(drop_run)
        self._mark_scan(app['id'], True, '')
        self._touch_lineage(app)          # 结构刚扫完：血缘跟着重算（算失败不影响扫描结果）
        scope_label = '全部库' if scan_all else (only_db or '')
        ver = self._record_version(app, 'scan',
                                  '扫描导入 %s：库 %d、表 %d、视图 %d、索引 %d、触发器 %d、'
                                  '存储过程 %d、函数 %d、字段 %d'
                                  % (scope_label, stats['databases'], stats['tables'], stats['views'],
                                     stats['indexes'], stats['triggers'], stats['procedures'],
                                     stats['functions'], stats['columns']),
                                  self._login_emp_id(params))
        stats['version'] = self._ver_brief(ver)
        stats['dbType'] = schema_ddl.normalize_db_type(app.get('dbType'))
        stats['dbTypeLabel'] = schema_ddl.db_label(app.get('dbType'))
        return stats

    def _view_ddl(self, conf, db_name, view_name):
        """取视图定义原文：MySQL 用 SHOW CREATE VIEW（只读，connector 的 query 会回滚）"""
        db_type = str((conf or {}).get('dbType') or '').lower()
        if db_type not in ('mysql', 'mariadb'):
            return ''
        sql = 'SHOW CREATE VIEW `%s`.`%s`' % (str(db_name).replace('`', '``'), str(view_name).replace('`', '``'))
        res = connector.query(conf, db_name, sql, 5)
        for row in (res.get('rows') or []):
            for cell in row:
                text = str(cell or '')
                if text.lower().startswith('create'):
                    return text
        return ''

    def _mark_scan(self, app_id, ok, message):
        try:
            if ok:
                execute('UPDATE `appinfos` SET `lastScanTime`=%s, `lastError`=NULL WHERE `id`=%s',
                        (_now(), app_id))
            else:
                execute('UPDATE `appinfos` SET `lastError`=%s WHERE `id`=%s',
                        ((message or '扫描失败')[:500], app_id))
        except Exception:
            pass

    # ---------------- DDL 导入 ----------------
    def parse(self, params):
        """只解析不落库：页面「预览」按钮用，返回将要执行的变更摘要"""
        params = params or {}
        app = self._app(params.get('appId'))
        sql = params.get('sql')
        if not _text(sql):
            raise BizError('请粘贴要导入的 SQL')
        try:
            ops = schema_parse.parse_sql(app.get('dbType'), sql)
        except ValueError as exc:
            raise BizError('解析失败：%s' % exc)
        return {'ops': self._ops_brief(ops), 'count': len(ops)}

    @staticmethod
    def _ops_brief(ops):
        out = []
        for op in ops:
            name = op.get('name') or ''
            target = ('%s.%s' % (op.get('qualifier'), name)) if op.get('qualifier') else name
            label = {
                'create_table': '建表', 'alter_add_column': '新增字段', 'alter_drop_column': '删除字段',
                'alter_modify_column': '修改字段', 'alter_rename_column': '重命名字段',
                'alter_rename_modify_column': '重命名并改类型', 'alter_rename_table': '重命名表',
                'alter_column_nullable': '改可空', 'alter_column_default': '改默认值',
                'alter_pk': '改主键', 'alter_drop_pk': '删主键', 'alter_index': '索引（不纳入设计态）',
                'alter_drop_index': '删索引（不纳入设计态）', 'drop_object': '删除对象',
                'create_object': '创建视图/过程', 'comment_table': '表注释',
                'comment_column': '字段注释',
            }.get(op.get('op'), op.get('op'))
            if op.get('op') in ('alter_add_column', 'alter_drop_column', 'alter_modify_column',
                                'alter_rename_modify_column', 'alter_column_nullable',
                                'alter_column_default'):
                col = op.get('column')
                col_name = col.get('colName') if isinstance(col, dict) else col
                target = '%s.%s' % (target, col_name or '')
            out.append({'op': op.get('op'), 'label': label, 'target': target,
                        'message': op.get('message') or ''})
        return out

    def importddl(self, params):
        """
        把 CREATE / ALTER / DROP / COMMENT ON 语句应用到设计态（**不动真实数据库**）
          · 同名对象存在 → 合并（ALTER 语义）；不存在 → 新建；
          · 一次导入只出一条草稿版本，来源记 import；
          · 返回逐条执行结果，页面上能直接看到「哪句改了哪张表」。
        """
        params = params or {}
        app = self._app(params.get('appId'))
        sql = params.get('sql')
        if not _text(sql):
            raise BizError('请粘贴要导入的 SQL')
        try:
            ops = schema_parse.parse_sql(app.get('dbType'), sql)
        except ValueError as exc:
            raise BizError('解析失败：%s' % exc)
        default_db = _text(params.get('dbName'))
        logs = []
        for op in ops:
            try:
                logs.append(self._apply_op(app, op, default_db))
            except BizError:
                raise
            except Exception as exc:
                logs.append({'ok': False, 'message': '执行失败：%s' % (str(exc) or exc.__class__.__name__),
                             'target': op.get('name') or ''})
        ver = self._record_version(app, 'import', 'DDL 导入：%d 条语句' % len(ops),
                                   self._login_emp_id(params))
        return {'logs': logs, 'count': len(ops), 'version': self._ver_brief(ver),
                'tree': self.tree({'appId': app['id']})}

    def _apply_op(self, app, op, default_db=''):
        kind = op.get('op')
        db_name = op.get('qualifier') or default_db or self._default_db_name(app['id'])
        if not db_name:
            raise BizError('语句里没有库名，请在上方选择（或填写）要导入的库')
        db_id = self._upsert_db(app['id'], db_name)
        if kind == 'create_table':
            table = op.get('table') or {}
            name = table.get('objName') or op.get('name')
            obj_id, created = self._upsert_obj(db_id, 'table', name, table.get('objComment') or '')
            # 建表语句按「覆盖字段」处理（同名表视作重建结构，更符合粘贴 DDL 的直觉）
            execute('DELETE FROM `appschemacols` WHERE `objId`=%s', (obj_id,))
            self._sync_columns(obj_id, table.get('columns') or [], source='import')
            return {'ok': True, 'target': '%s.%s' % (db_name, name),
                    'message': '建表（%s）' % ('新建' if created else '覆盖字段')}
        if kind == 'create_object':
            name = op.get('name')
            obj_id, created = self._upsert_obj(db_id, op.get('objType') or 'view', name, '', 0, op.get('ddl') or '')
            return {'ok': True, 'target': '%s.%s' % (db_name, name),
                    'message': ('新建' if created else '更新') + ('视图' if op.get('objType') == 'view' else '存储过程')}
        if kind == 'drop_object':
            row = query_one('SELECT * FROM `appschemaobjs` WHERE `dbId`=%s AND `objName`=%s',
                            (db_id, op.get('name')))
            if not row:
                return {'ok': True, 'target': '%s.%s' % (db_name, op.get('name')), 'message': '对象不存在，忽略'}
            execute('DELETE FROM `appschemacols` WHERE `objId`=%s', (row['id'],))
            execute('DELETE FROM `appschemaobjs` WHERE `id`=%s', (row['id'],))
            return {'ok': True, 'target': '%s.%s' % (db_name, op.get('name')), 'message': '删除对象'}
        # 下面是 ALTER 系列：先定位对象
        row = query_one('SELECT * FROM `appschemaobjs` WHERE `dbId`=%s AND `objName`=%s',
                        (db_id, op.get('name')))
        if not row:
            raise BizError('对象【%s.%s】不存在，请先导入建表语句' % (db_name, op.get('name')))
        obj_id = row['id']
        target = '%s.%s' % (db_name, op.get('name'))
        if kind == 'alter_add_column':
            col = op.get('column') or {}
            if query_one('SELECT `id` FROM `appschemacols` WHERE `objId`=%s AND `colName`=%s',
                         (obj_id, col.get('colName'))):
                raise BizError('字段【%s】已存在' % col.get('colName'))
            self._insert_col(obj_id, col)
            return {'ok': True, 'target': target, 'message': '新增字段 %s' % col.get('colName')}
        if kind == 'alter_drop_column':
            col_name = op.get('column')
            row2 = query_one('SELECT `id` FROM `appschemacols` WHERE `objId`=%s AND `colName`=%s',
                             (obj_id, col_name))
            if not row2:
                return {'ok': True, 'target': target, 'message': '字段不存在，忽略'}
            execute('DELETE FROM `appschemacols` WHERE `id`=%s', (row2['id'],))
            return {'ok': True, 'target': target, 'message': '删除字段 %s' % col_name}
        if kind in ('alter_modify_column', 'alter_rename_modify_column'):
            col = op.get('column') or {}
            old_name = op.get('from') if kind == 'alter_rename_modify_column' else col.get('colName')
            row2 = query_one('SELECT * FROM `appschemacols` WHERE `objId`=%s AND `colName`=%s',
                             (obj_id, old_name))
            if not row2:
                raise BizError('字段【%s】不存在' % old_name)
            partial = op.get('partial') or []
            data = dict(col)
            if partial:
                for key in ('dataType', 'length', 'nullable', 'defaultValue', 'isPk', 'isAutoInc', 'colComment'):
                    if key not in partial and key in ('dataType', 'length'):
                        data[key] = row2.get(key)
            execute('UPDATE `appschemacols` SET `colName`=%s, `dataType`=%s, `length`=%s, `nullable`=%s, '
                    '`defaultValue`=%s, `isPk`=%s, `isAutoInc`=%s, `colComment`=%s WHERE `id`=%s',
                    (data.get('colName') or row2.get('colName'), data.get('dataType') or row2.get('dataType'),
                     data.get('length'), 1 if data.get('nullable', row2.get('nullable')) else 0,
                     data.get('defaultValue') if data.get('defaultValue') is not None else row2.get('defaultValue'),
                     1 if data.get('isPk', row2.get('isPk')) else 0,
                     1 if data.get('isAutoInc', row2.get('isAutoInc')) else 0,
                     data.get('colComment') if data.get('colComment') is not None else row2.get('colComment'),
                     row2['id']))
            return {'ok': True, 'target': target, 'message': '修改字段 %s' % (data.get('colName') or old_name)}
        if kind == 'alter_rename_column':
            row2 = query_one('SELECT `id` FROM `appschemacols` WHERE `objId`=%s AND `colName`=%s',
                             (obj_id, op.get('from')))
            if not row2:
                raise BizError('字段【%s】不存在' % op.get('from'))
            execute('UPDATE `appschemacols` SET `colName`=%s WHERE `id`=%s', (op.get('to'), row2['id']))
            return {'ok': True, 'target': target, 'message': '字段重命名 %s → %s' % (op.get('from'), op.get('to'))}
        if kind in ('alter_column_nullable', 'alter_column_default'):
            row2 = query_one('SELECT * FROM `appschemacols` WHERE `objId`=%s AND `colName`=%s',
                             (obj_id, op.get('column')))
            if not row2:
                raise BizError('字段【%s】不存在' % op.get('column'))
            if kind == 'alter_column_nullable':
                execute('UPDATE `appschemacols` SET `nullable`=%s WHERE `id`=%s',
                        (1 if op.get('nullable') else 0, row2['id']))
                return {'ok': True, 'target': target, 'message': '字段 %s 改为%s' % (
                    op.get('column'), '可空' if op.get('nullable') else '非空')}
            execute('UPDATE `appschemacols` SET `defaultValue`=%s WHERE `id`=%s',
                    (op.get('defaultValue') or None, row2['id']))
            return {'ok': True, 'target': target, 'message': '字段 %s 默认值改为 %s' % (
                op.get('column'), op.get('defaultValue') or '空')}
        if kind == 'alter_rename_table':
            new_name = op.get('to')
            if query_one('SELECT `id` FROM `appschemaobjs` WHERE `dbId`=%s AND `objName`=%s',
                         (db_id, new_name)):
                raise BizError('对象【%s】已存在' % new_name)
            execute('UPDATE `appschemaobjs` SET `objName`=%s WHERE `id`=%s', (new_name, obj_id))
            return {'ok': True, 'target': target, 'message': '表重命名为 %s' % new_name}
        if kind == 'alter_pk':
            execute('UPDATE `appschemacols` SET `isPk`=0 WHERE `objId`=%s', (obj_id,))
            for col_name in (op.get('pk') or []):
                execute('UPDATE `appschemacols` SET `isPk`=1, `nullable`=0 WHERE `objId`=%s AND `colName`=%s',
                        (obj_id, col_name))
            return {'ok': True, 'target': target, 'message': '主键设置为 %s' % '、'.join(op.get('pk') or [])}
        if kind == 'alter_drop_pk':
            execute('UPDATE `appschemacols` SET `isPk`=0 WHERE `objId`=%s', (obj_id,))
            return {'ok': True, 'target': target, 'message': '已清除主键标记'}
        if kind == 'comment_table':
            execute('UPDATE `appschemaobjs` SET `objComment`=%s WHERE `id`=%s', (op.get('comment') or None, obj_id))
            return {'ok': True, 'target': target, 'message': '表注释已更新'}
        if kind == 'comment_column':
            execute('UPDATE `appschemacols` SET `colComment`=%s WHERE `objId`=%s AND `colName`=%s',
                    (op.get('comment') or None, obj_id, op.get('column')))
            return {'ok': True, 'target': '%s.%s' % (target, op.get('column')), 'message': '字段注释已更新'}
        if kind in ('alter_index', 'alter_drop_index'):
            return {'ok': True, 'target': target, 'skipped': True,
                    'message': '索引变更暂不纳入设计态，已跳过（脚本仍可由数据库侧维护）'}
        raise BizError('暂不支持的语句类型：%s' % kind)

    def _default_db_name(self, app_id):
        row = query_one('SELECT `dbName` FROM `appschemadbs` WHERE `appId`=%s ORDER BY `sortNo` LIMIT 1',
                        (app_id,))
        return row.get('dbName') if row else ''

    def _insert_col(self, obj_id, col):
        row = query_one('SELECT COALESCE(MAX(`ordinal`),0) AS `mx` FROM `appschemacols` WHERE `objId`=%s',
                        (obj_id,))
        execute('INSERT INTO `appschemacols` (`id`,`objId`,`colName`,`ordinal`,`dataType`,`length`,'
                '`nullable`,`defaultValue`,`isPk`,`isAutoInc`,`colComment`,`source`) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (str(uuid.uuid4()), obj_id, col.get('colName'), int((row or {}).get('mx') or 0) + 1,
                 col.get('dataType') or 'VARCHAR', col.get('length') or None,
                 1 if col.get('nullable', True) else 0, col.get('defaultValue') or None,
                 1 if col.get('isPk') else 0, 1 if col.get('isAutoInc') else 0,
                 col.get('colComment') or None, 'import'))

    # ---------------- 版本与脚本 ----------------
    def versions(self, params):
        params = params or {}
        app = self._app(params.get('appId'))
        rows = query_all('SELECT * FROM `appschemavers` WHERE `appId`=%s ORDER BY `seq` DESC',
                         (app['id'],)) or []
        out = []
        for row in rows:
            one = self._ver_brief(dump_row(row))
            one['source'] = row.get('source')
            one['operatorEmpId'] = int(row.get('operatorEmpId') or 0)
            one['remark'] = row.get('remark') or ''
            one['publishEmpId'] = int(row.get('publishEmpId') or 0)
            scripts = query_all('SELECT `kind`,`status`,`id` FROM `appschemascripts` WHERE `verId`=%s',
                                (row['id'],)) or []
            one['scripts'] = [{'id': s['id'], 'kind': s['kind'], 'status': s['status'],
                               'statusLabel': SCRIPT_STATUS_LABELS.get(s['status'], s['status'])}
                              for s in scripts]
            out.append(one)
        return {'list': out, 'dbType': schema_ddl.normalize_db_type(app.get('dbType')),
                'dbTypeLabel': schema_ddl.db_label(app.get('dbType'))}

    def version(self, params):
        params = params or {}
        ver_id = _uuid(params.get('verId') or params.get('id'), '版本 id')
        row = query_one('SELECT * FROM `appschemavers` WHERE `id`=%s', (ver_id,))
        if not row:
            raise BizError('版本不存在或已被删除', 404)
        app = self._app(row['appId'])
        changes = query_all('SELECT * FROM `appschemachanges` WHERE `verId`=%s ORDER BY `objType`, `objName`',
                            (ver_id,)) or []
        scripts = query_all('SELECT * FROM `appschemascripts` WHERE `verId`=%s ORDER BY `kind`',
                            (ver_id,)) or []
        draft = self._latest_version(app['id'], 'draft', ['draft'])
        return {
            'version': dict(self._ver_brief(dump_row(row)), source=row.get('source'),
                            remark=row.get('remark') or '', baseVerId=row.get('baseVerId') or '',
                            canPublish=bool(row.get('kind') == 'draft' and row.get('status') == 'draft'
                                            and draft and draft.get('id') == row.get('id'))),
            'app': {'id': app['id'], 'code': app.get('code'), 'name': app.get('name'),
                    'dbType': schema_ddl.normalize_db_type(app.get('dbType')),
                    'dbTypeLabel': schema_ddl.db_label(app.get('dbType'))},
            # beforeJson / afterJson 只是留档（库级变更那条带整库结构，可能有几百 KB，
            # 压缩后是 zlib: base64），页面不用，别往响应里塞。
            'changes': [dict(dump_row(one), before=None, after=None, beforeJson=None, afterJson=None)
                        for one in changes],
            'scripts': [dict(dump_row(one), kindLabel='正向' if one.get('kind') == 'forward' else '回滚',
                             statusLabel=SCRIPT_STATUS_LABELS.get(one.get('status'), one.get('status')))
                        for one in scripts],
        }

    def publish(self, params):
        """
        发布草稿：生成正式版号 + 正向 / 回滚脚本（脚本状态 pending，**不会自动执行**）
          · 变更以「上一个正式版」为基准重算，跨多个草稿也能一次发布；
          · 没有变更 / 不是草稿 / 不是最新草稿都会拒绝。
        """
        params = params or {}
        ver_id = _uuid(params.get('verId') or params.get('id'), '版本 id')
        row = query_one('SELECT * FROM `appschemavers` WHERE `id`=%s', (ver_id,))
        if not row:
            raise BizError('版本不存在或已被删除', 404)
        if row.get('kind') != 'draft' or row.get('status') != 'draft':
            raise BizError('只有草稿版本可以发布')
        app = self._app(row['appId'])
        latest_draft = self._latest_version(app['id'], 'draft', ['draft'])
        if latest_draft and latest_draft.get('id') != ver_id:
            raise BizError('存在更新的草稿，请发布最新草稿')
        last_release = self._latest_version(app['id'], 'release', ['released', 'applied', 'superseded'])
        before = _load_snapshot(last_release.get('snapshot')) if last_release else _empty_snapshot()
        after = _load_snapshot(row.get('snapshot'))
        changes = diff_snapshots(before, after)
        if not changes:
            raise BizError('这个草稿与上一个正式版没有差异，不需要发布')
        db_type = schema_ddl.normalize_db_type(app.get('dbType'))
        forward, rollback, errors = build_scripts(db_type, before, after)
        if not forward:
            raise BizError('没有生成任何语句：%s' % ('；'.join(errors) if errors else '变更里只有库级差异'))
        release_no = query_one('SELECT COUNT(*) AS `n` FROM `appschemavers` WHERE `appId`=%s AND `kind`=%s',
                               (app['id'], 'release'))
        version_no = 'v%d' % (int((release_no or {}).get('n') or 0) + 1)
        summary = _text(params.get('summary')) or summarize(changes)
        remark = _text(params.get('remark'))[:500] or None
        notes = list(errors)
        forward_text = schema_ddl.header(
            db_type, 'forward', '%s %s 结构变更（%s）' % (app.get('name'), version_no,
                                                         schema_ddl.db_label(db_type)),
            notes) + '\n\n' + schema_ddl.join_statements(db_type, forward)
        rollback_text = schema_ddl.header(
            db_type, 'rollback', '%s %s 回滚脚本（%s）' % (app.get('name'), version_no,
                                                          schema_ddl.db_label(db_type)),
            notes + ['回滚只恢复结构，已删除的数据无法找回，请先备份']) \
            + '\n\n' + schema_ddl.join_statements(db_type, rollback)
        def run(cur):
            cur.execute('UPDATE `appschemavers` SET `kind`=%s, `status`=%s, `versionNo`=%s, `summary`=%s, '
                        '`changeCount`=%s, `releaseTime`=%s, `publishEmpId`=%s, `remark`=%s WHERE `id`=%s',
                        ('release', 'released', version_no, summary[:500], len(changes), _now(),
                         self._login_emp_id(params), remark, ver_id))
            cur.execute('DELETE FROM `appschemascripts` WHERE `verId`=%s', (ver_id,))
            for kind, text in (('forward', forward_text), ('rollback', rollback_text)):
                cur.execute('INSERT INTO `appschemascripts` (`id`,`verId`,`dbType`,`kind`,`scriptText`,'
                            '`checksum`,`status`) VALUES (%s,%s,%s,%s,%s,%s,%s)',
                            (str(uuid.uuid4()), ver_id, db_type, kind, text, _sha1(text), 'pending'))
            # 之前的正式版标为「已被取代」（脚本保留，可能已经在生产跑过一半）
            cur.execute('UPDATE `appschemavers` SET `status`=%s WHERE `appId`=%s AND `id`<>%s '
                        'AND `kind`=%s AND `status` IN (%s,%s)',
                        ('superseded', app['id'], ver_id, 'release', 'released', 'applied'))
            cur.execute('DELETE FROM `appschemachanges` WHERE `verId`=%s', (ver_id,))
        transaction(run)
        self._save_changes(ver_id, changes)
        result = self.version({'verId': ver_id})
        result['generated'] = {'forward': len(forward), 'rollback': len(rollback), 'errors': errors}
        return result

    def discard(self, params):
        params = params or {}
        ver_id = _uuid(params.get('verId') or params.get('id'), '版本 id')
        row = query_one('SELECT * FROM `appschemavers` WHERE `id`=%s', (ver_id,))
        if not row:
            raise BizError('版本不存在或已被删除', 404)
        if row.get('kind') != 'draft' or row.get('status') != 'draft':
            raise BizError('只有草稿可以丢弃')
        execute('UPDATE `appschemavers` SET `status`=%s WHERE `id`=%s', ('discarded', ver_id))
        return {'id': ver_id, 'message': '草稿已丢弃'}

    def scriptstatus(self, params):
        """
        人工确认后的执行结果回写（页面上的「标记已执行 / 执行失败 / 外部执行」）
          · 永远不会自动调用，只在用户点确认后调用；
          · 记录确认人 / 执行人 / 时间 / 失败原因，历史里可查。
        """
        params = params or {}
        sid = _uuid(params.get('id'), '脚本 id')
        row = query_one('SELECT * FROM `appschemascripts` WHERE `id`=%s', (sid,))
        if not row:
            raise BizError('脚本不存在或已被删除', 404)
        status = _text(params.get('status')) or 'applied'
        if status not in SCRIPT_STATUS_LABELS:
            raise BizError('不支持的脚本状态：%s' % status)
        emp_id = self._login_emp_id(params)
        error = _text(params.get('execError'))[:500] or None
        execute('UPDATE `appschemascripts` SET `status`=%s, `confirmEmpId`=%s, `confirmTime`=%s, '
                '`execEmpId`=%s, `execTime`=%s, `execError`=%s WHERE `id`=%s',
                (status, emp_id, _now(), emp_id if status in ('applied', 'failed') else None,
                 _now() if status in ('applied', 'failed', 'skipped') else None, error, sid))
        if status == 'applied':
            execute('UPDATE `appschemavers` SET `status`=%s WHERE `id`=%s AND `status`=%s',
                    ('applied', row['verId'], 'released'))
        out = dump_row(query_one('SELECT * FROM `appschemascripts` WHERE `id`=%s', (sid,)))
        out['statusLabel'] = SCRIPT_STATUS_LABELS.get(status, status)
        return out

    # ---------------- 与真实库对比 ----------------
    def _scan_snapshot(self, app, only_db='', conn_id='', params=None):
        """
        实时扫描实库 → 与设计态同构的快照（不落库，只用于对比）
          · 同样**只扫一个库**：显式 dbName 优先，否则用连接对象的默认库；两者都没有就直接报错，
            不退化成「全库对比」—— 全库对比会把同一实例里别人的库全算成「实库有、设计无」的噪音；
          · conn_id 可以指定**另一个连接**（线上生产库）：对比的目标是「部署前那台机器上的结构」，
            不一定是应用绑定的开发库。
        :return (snapshot, snapTime, targetDb)
        """
        conf = self._conn_conf(app, conn_id, params)
        target = _text(only_db) or connector.default_database(conf)
        if not target:
            raise BizError('连接【%s】没有指定「默认库」，无法对比：请先到「数据库连接」里指定要对比的那一个库'
                           % (conf.get('name') or conf.get('id') or ''))
        try:
            result = connector.databases(conf)
        except connector.ConnError as exc:
            raise BizError(exc.message)
        dbs = self._match_db(result.get('databases') or [], target, conf)
        if not dbs:
            raise BizError('连接【%s】里找不到库 / 实例【%s】，无法对比'
                           % (conf.get('name') or '', target))
        snap = {'databases': []}
        for db in dbs[:1]:
            db_name = str(db.get('name') or '')
            if not db_name:
                continue
            entry = {'dbName': db_name, 'dbComment': '', 'objects': []}
            try:
                table_res = connector.tables(conf, db_name)
            except connector.ConnError:
                continue
            for table in (table_res.get('tables') or [])[:600]:
                name = str(table.get('name') or '')
                if not name:
                    continue
                kind = 'view' if str(table.get('kind') or '').lower() == 'view' else 'table'
                cols = []
                if kind == 'table':
                    try:
                        col_res = connector.columns(conf, db_name, name)
                        # 位置要和设计态口径一致（连续 1..n），否则对比会把「顺序」算成差异
                        for pos, col in _ordered_columns(col_res.get('columns')):
                            logical, length = schema_ddl.canonical_type(col.get('dataType'))
                            cols.append({
                                'colName': col.get('name'), 'ordinal': pos,
                                'dataType': logical, 'length': length,
                                'nullable': bool(col.get('nullable', True)),
                                'defaultValue': '' if col.get('defaultValue') is None else str(col.get('defaultValue')),
                                'isPk': str(col.get('key') or '').upper() == 'PRI',
                                'isAutoInc': 'auto_increment' in str(col.get('extra') or '').lower(),
                                'colComment': str(col.get('comment') or ''),
                            })
                    except connector.ConnError:
                        cols = []
                # 视图原文取不到（没权限 / 方言不支持 / 被只读守卫拦）不该让整次对比失败，
                # 顶多是这条视图不参与「定义是否一致」的判断（原行为在扫描路径里也是这么兜的）
                view_ddl = ''
                if kind == 'view':
                    try:
                        view_ddl = self._view_ddl(conf, db_name, name)
                    except Exception:              # noqa: BLE001
                        view_ddl = ''
                entry['objects'].append({'objName': name, 'objType': kind,
                                         'objComment': str(table.get('comment') or ''),
                                         'ddl': view_ddl,
                                         'columns': cols})
            # 设计态收了索引 / 触发器 / 过程 / 函数，实库侧也必须收 —— 否则对比会把它们全算成
            # 「仅设计有（待建）」的噪音，升级脚本还会重复建一遍。
            # 返回键必须显式写成 indexes / triggers：'index' + 's' 会得到 'indexs'，
            # 取不到值时实库侧索引全丢 → 设计态索引会被整体误判成「仅设计有（待建）」。
            for aux_kind, aux_key, getter in (('index', 'indexes', connector.indexes),
                                              ('trigger', 'triggers', connector.triggers)):
                try:
                    aux = getter(conf, db_name)
                except Exception:
                    continue
                for one in (aux.get(aux_key) or []):
                    aname = str(one.get('objName') or one.get('name') or '')
                    if not aname:
                        continue
                    entry['objects'].append({'objName': aname, 'objType': aux_kind,
                                             'objComment': str(one.get('comment') or ''),
                                             'ddl': str(one.get('ddl') or ''), 'columns': []})
            try:
                for one in (connector.routines(conf, db_name).get('routines') or []):
                    rname = str(one.get('name') or '')
                    if not rname:
                        continue
                    rtype = 'function' if str(one.get('type') or '').lower() == 'function' else 'procedure'
                    entry['objects'].append({'objName': rname, 'objType': rtype,
                                             'objComment': str(one.get('comment') or ''),
                                             'ddl': str(one.get('ddl') or ''), 'columns': []})
            except Exception:
                pass
            snap['databases'].append(entry)
        return snap, _now(), str(dbs[0].get('name') or target)

    def _compare_items(self, left, right, only_db='', design_db=''):
        """设计态 vs 实库 → 对比明细（表级一条，字段级差异在 details 里逐条列）

        :param only_db 只比这一个库：对比同样只针对「扫描到的那一个库」，
               设计态里其它库不参与比对（否则会把别人的库全算成「实库没扫到」的噪音，
               升级脚本也没法只覆盖目标库）。
        :param design_db 实库库名与设计态库名不同时（开发库 db_dev / 生产库 db_prod），
               把设计态的 design_db 当作实库的 only_db 来比 —— 升级脚本里的库名仍用实库的，
               因为脚本是在实库上执行的。
        """
        items = []
        left_dbs = dict((one.get('dbName'), one) for one in (left.get('databases') or []))
        right_dbs = dict((one.get('dbName'), one) for one in (right.get('databases') or []))
        if design_db and only_db and design_db != only_db:
            hit = left_dbs.get(design_db)
            left_dbs = {only_db: dict(hit, dbName=only_db)} if hit else {}
        if only_db:
            left_dbs = dict((key, one) for key, one in left_dbs.items() if key == only_db)
            right_dbs = dict((key, one) for key, one in right_dbs.items() if key == only_db)
        for db_name in sorted(set(list(left_dbs.keys()) + list(right_dbs.keys()))):
            if db_name not in left_dbs:
                items.append({'diffType': 'dbOnly', 'objType': 'db', 'objName': db_name,
                              'left': None, 'right': {'dbName': db_name},
                              'message': '实库有、设计态没有这个库'})
                continue
            if db_name not in right_dbs:
                items.append({'diffType': 'designOnly', 'objType': 'db', 'objName': db_name,
                              'left': {'dbName': db_name}, 'right': None,
                              'message': '设计态有这个库，实库没扫到（可能没权限或库已删）'})
                continue
            lobjs = dict((one.get('objName'), one) for one in (left_dbs[db_name].get('objects') or []))
            robjs = dict((one.get('objName'), one) for one in (right_dbs[db_name].get('objects') or []))
            for name in sorted(set(list(lobjs.keys()) + list(robjs.keys()))):
                full = '%s.%s' % (db_name, name)
                if name not in robjs:
                    items.append({'diffType': 'designOnly', 'objType': lobjs[name].get('objType'),
                                  'objName': full, 'left': lobjs[name], 'right': None,
                                  'message': '设计有、实库无（待执行建表脚本）'})
                    continue
                if name not in lobjs:
                    items.append({'diffType': 'dbOnly', 'objType': robjs[name].get('objType'),
                                  'objName': full, 'left': None, 'right': robjs[name],
                                  'message': '实库有、设计无（未纳管）'})
                    continue
                lobj, robj = lobjs[name], robjs[name]
                if str(lobj.get('objType')) != str(robj.get('objType')):
                    items.append({'diffType': 'attrDiff', 'objType': lobj.get('objType'), 'objName': full,
                                  'left': lobj, 'right': robj, 'message': '对象类型不一致'})
                    continue
                if str(lobj.get('objType')) != 'table':
                    # 视图 / 触发器 / 过程 / 函数按定义比。任一侧没存定义就不比定义：
                    # 设计态里很多视图是早期扫描留下的空 ddl（读真实定义那条路以前被只读守卫挡掉），
                    # 硬比会让每条视图都变成「定义不同」的假差异，升级脚本也跟着冒错。
                    lkey, rkey = _ddl_key(lobj.get('ddl')), _ddl_key(robj.get('ddl'))
                    same = (lkey == rkey) if (lkey and rkey) else True
                    items.append({'diffType': 'same' if same else 'attrDiff',
                                  'objType': lobj.get('objType'), 'objName': full,
                                  'left': lobj, 'right': robj,
                                  'message': '' if same else '%s定义不同'
                                             % OBJ_TYPE_LABELS.get(str(lobj.get('objType')), '对象')})
                    continue
                detail = _col_compare(lobj, robj)
                items.append({'diffType': detail['diffType'] or 'same', 'objType': 'table', 'objName': full,
                              'left': lobj, 'right': robj, 'message': detail['message'],
                              'details': detail['details']})
        for one in items:
            one.setdefault('details', _item_details(one))
        return items


    def compare(self, params):
        """
        人工触发的「设计态 vs 实库」对比：实时扫描实库 → 比对 → 结果落库留存
          · 不自动执行、不后台定时；每次点都产生一条对比记录（含实库数据时间点）；
          · params.connId：用**另一个连接**当实库（典型场景：上线前拿线上生产库连接比一次，
            生成部署升级脚本）；不传就用应用绑定的连接；
          · params.dbName：实库侧要比的库；params.designDb：实库库名与设计态库名不同时，
            指定设计态里对应的那个库（不传则先按同名找，设计态只有一个库时自动对上）；
          · 返回前 500 条明细（完整明细可按 compareitems 分页取）。
        """
        params = params or {}
        app = self._app(params.get('appId'))
        conn_id = _text(params.get('connId'))
        only_db = _text(params.get('dbName'))
        design_db = _text(params.get('designDb'))
        conf = self._conn_conf(app, conn_id, params)
        app_db_type = schema_ddl.normalize_db_type(app.get('dbType'))
        live_db_type = schema_ddl.normalize_db_type(conf.get('dbType'))
        if _dialect_family(app_db_type) != _dialect_family(live_db_type):
            raise BizError('实库连接【%s】是 %s，而这个应用的设计态方言是 %s：方言不同，'
                           '逐字段比对与升级脚本都没有意义，请换一个同方言的连接'
                           % (conf.get('name') or '', schema_ddl.db_label(live_db_type),
                              schema_ddl.db_label(app_db_type)))
        left_kind = _text(params.get('leftKind')) or 'design'
        left_ver = None
        if left_kind == 'draft':
            row = self._latest_version(app['id'], 'draft', ['draft'])
            left = _load_snapshot(row.get('snapshot')) if row else self._snapshot(app['id'])
            left_ver = row
        elif left_kind == 'release':
            row = self._latest_version(app['id'], 'release', ['released', 'applied'])
            left = _load_snapshot(row.get('snapshot')) if row else self._snapshot(app['id'])
            left_ver = row
        else:
            left = self._snapshot(app['id'])
        right, snap_time, target_db = self._scan_snapshot(app, only_db, conn_id, params)
        design_dbs = [str(one.get('dbName') or '') for one in (left.get('databases') or [])]
        design_db = self._cmp_design_db(design_db, target_db, design_dbs, conf)
        items = self._compare_items(left, right, target_db, design_db)
        db_type = live_db_type
        include_drop = _bool(params.get('includeDrop'))
        upgrade = _upgrade_plan(db_type, items, target_db, include_drop)
        for one in items:
            one['upgradeCount'] = upgrade['counts'].get(one.get('objName'), 0)
            note = upgrade['notes'].get(one.get('objName'))
            if note:
                one['upgradeNote'] = note
        counts = {'same': 0, 'designOnly': 0, 'dbOnly': 0, 'attrDiff': 0, 'orderDiff': 0}
        for one in items:
            counts[one['diffType']] = counts.get(one['diffType'], 0) + 1
        cmp_id = str(uuid.uuid4())
        diff_count = len(items) - counts.get('same', 0)
        execute('INSERT INTO `appschemacompares` (`id`,`appId`,`leftKind`,`leftVerId`,`dbType`,`dbName`,'
                '`connId`,`connName`,`designDb`,`snapTime`,`sameCount`,`addCount`,`dropCount`,`alterCount`,'
                '`itemCount`,`operatorEmpId`,`remark`) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (cmp_id, app['id'], left_kind, (left_ver or {}).get('id'), db_type,
                 target_db or None, conf.get('id'), (conf.get('name') or '')[:100] or None,
                 design_db or None, snap_time, counts.get('same', 0), counts.get('designOnly', 0),
                 counts.get('dbOnly', 0), counts.get('attrDiff', 0) + counts.get('orderDiff', 0),
                 len(items), self._login_emp_id(params),
                 ('差异 %d 项' % diff_count) if diff_count else '完全一致'))
        def run(cur):
            for one in items[:3000]:
                cur.execute('INSERT INTO `appschemacompareitems` (`id`,`compareId`,`diffType`,`objType`,'
                            '`objName`,`leftJson`,`rightJson`,`message`) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                            (str(uuid.uuid4()), cmp_id, one['diffType'], one.get('objType') or 'table',
                             str(one.get('objName'))[:300],
                             json.dumps(one.get('left'), ensure_ascii=False) if one.get('left') else None,
                             json.dumps(one.get('right'), ensure_ascii=False) if one.get('right') else None,
                             str(one.get('message') or '')[:500] or None))
        transaction(run)
        return {
            'id': cmp_id, 'appId': app['id'], 'leftKind': left_kind, 'snapTime': snap_time,
            'dbType': db_type,
            'dbTypeLabel': schema_ddl.db_label(db_type),
            'dbName': target_db,
            'connId': conf.get('id') or '', 'connName': conf.get('name') or '',
            'connHost': conf.get('host') or '', 'connPort': conf.get('port') or '',
            'designDb': design_db or '',
            'outsideDbs': sorted(set(design_dbs) - set([design_db or target_db])),
            'counts': counts, 'diffCount': diff_count, 'itemCount': len(items),
            'upgrade': upgrade['brief'],
            'items': [dict(one, diffLabel=DIFF_LABELS.get(one['diffType'], one['diffType']))
                      for one in items[:500]],
            'truncated': len(items) > 500,
        }

    @staticmethod
    def _cmp_design_db(design_db, only_db, design_dbs, conf):
        """本次对比要用设计态的哪个库（实库库名与设计态库名可能不同）

          · 显式传了 designDb：必须在设计态里存在；
          · 没传：先按同名找；设计态只有**一个**库时自动对上（开发库 db_dev / 生产库 db_prod
            这种命名不同但结构同源的场景，不该逼人先去改名）；
          · 设计态有多个库且没有同名：报错让人选，绝不自己猜一个 —— 猜错会把整库算成差异。
        """
        if not design_dbs:
            return ''
        if design_db:
            if design_db in design_dbs:
                return design_db
            raise BizError('设计态里没有库【%s】，现有：%s' % (design_db, '、'.join(design_dbs[:12])))
        if only_db and only_db in design_dbs:
            return only_db
        if len(design_dbs) == 1:
            return design_dbs[0]
        raise BizError('实库里的库【%s】在设计态没有同名库：请在「对应设计态库」里选一个（现有：%s）'
                       % (only_db, '、'.join(design_dbs[:12])))

    def compares(self, params):
        params = params or {}
        app = self._app(params.get('appId'))
        rows = query_all('SELECT * FROM `appschemacompares` WHERE `appId`=%s ORDER BY `createTime` DESC LIMIT 50',
                         (app['id'],)) or []
        out = []
        for row in rows:
            one = dump_row(row)
            one['dbTypeLabel'] = schema_ddl.db_label(row.get('dbType'))
            one['diffCount'] = int(one.get('addCount') or 0) + int(one.get('dropCount') or 0) \
                + int(one.get('alterCount') or 0)
            out.append(one)
        return {'list': out}

    def compareitems(self, params):
        params = params or {}
        cmp_id = _uuid(params.get('compareId') or params.get('id'), '对比 id')
        row = query_one('SELECT * FROM `appschemacompares` WHERE `id`=%s', (cmp_id,))
        if not row:
            raise BizError('对比记录不存在', 404)
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 100), 1), 500)
        except (TypeError, ValueError):
            page_num, page_size = 1, 100
        where = ['`compareId`=%s']
        args = [cmp_id]
        diff_type = _text(params.get('diffType'))
        if diff_type:
            where.append('`diffType`=%s')
            args.append(diff_type)
        keyword = _text(params.get('keyword'))
        if keyword:
            where.append('`objName` LIKE %s')
            args.append('%' + keyword + '%')
        where_sql = ' WHERE ' + ' AND '.join(where)
        total_row = query_one('SELECT COUNT(*) AS n FROM `appschemacompareitems`' + where_sql, args)
        total = int(total_row['n']) if total_row else 0
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        rows = query_all('SELECT * FROM `appschemacompareitems`' + where_sql
                         + ' ORDER BY `diffType`, `objName` LIMIT %s OFFSET %s',
                         args + [page_size, (page_num - 1) * page_size]) or []
        db_type = self._app_db_type(row.get('appId'))
        include_drop = _bool(params.get('includeDrop'))
        items = []
        for one in rows:
            item = self._rebuild_item(one)
            if item['diffType'] != 'same':
                sql, note = _item_upgrade_sql(db_type, item, include_drop)
                item['upgradeCount'] = len(sql)
                if note:
                    item['upgradeNote'] = note
            else:
                item['upgradeCount'] = 0
            item['diffLabel'] = DIFF_LABELS.get(item['diffType'], item['diffType'])
            items.append(item)
        head = dump_row(row)
        head['snapTime'] = _time_text(row.get('snapTime'))
        return {'head': head, 'list': items,
                'total': total, 'pageNum': page_num, 'pageSize': page_size, 'pages': pages,
                'counts': {'same': row.get('sameCount'), 'designOnly': row.get('addCount'),
                           'dbOnly': row.get('dropCount'), 'attrDiff': row.get('alterCount')}}

    # ---------------- 升级脚本（实库 → 设计态） ----------------
    def _app_db_type(self, app_id):
        row = query_one('SELECT `dbType` FROM `appinfos` WHERE `id`=%s', (app_id,))
        return schema_ddl.normalize_db_type((row or {}).get('dbType'))

    def _cmp_rows(self, cmp_row):
        return query_all('SELECT * FROM `appschemacompareitems` WHERE `compareId`=%s '
                         'ORDER BY `diffType`, `objName`', (cmp_row['id'],)) or []

    @staticmethod
    def _rebuild_item(row):
        """落库明细行 → 内存差异项

        明细表只存了左右两侧定义的 JSON 和一句 message，逐条明细（details）与升级语句
        在这里现算 —— 这样**历史对比记录**也能看到「到底哪里不一样」并导出脚本，
        不需要为了新字段做数据迁移。
        """
        left = _json_loads(row.get('leftJson'), None)
        right = _json_loads(row.get('rightJson'), None)
        item = {'diffType': _text(row.get('diffType')) or 'same',
                'objType': _text(row.get('objType')) or 'table',
                'objName': _text(row.get('objName')),
                'left': left, 'right': right,
                'message': _text(row.get('message')) or ''}
        details = None
        if left and right and item['objType'] == 'table':
            detail = _col_compare(left, right)
            item['diffType'] = detail['diffType'] or item['diffType']
            details = detail['details']
            item['message'] = detail['message'] or item['message']
        item['details'] = details if details is not None else _item_details(item)
        return item

    def _cmp_context(self, cmp_row, app_row, items, plan):
        """脚本头部的口径说明（谁、什么时候、比了哪个库、哪些差异没出语句）"""
        conn_name = _text(cmp_row.get('connName')) or '（历史记录未记录连接）'
        notes = [
            '来源：与实库对比（%s）· 实库连接 %s · 实库数据时间点 %s · 目标库 %s'
            % (str(cmp_row.get('id') or '')[:8], conn_name, _time_text(cmp_row.get('snapTime')),
               cmp_row.get('dbName') or '未指定'),
            '对比基准：%s' % {'design': '当前设计态', 'draft': '最新草稿', 'release': '最新正式版'}
            .get(_text(cmp_row.get('leftKind')) or 'design', '当前设计态'),
            '差异汇总：仅设计有 %s 项 / 仅实库有 %s 项 / 属性不一致 %s 项（共 %d 条明细）'
            % (cmp_row.get('addCount') or 0, cmp_row.get('dropCount') or 0,
               (int(cmp_row.get('alterCount') or 0)), len(items)),
            '脚本只覆盖库【%s】的对象；不会自动执行，执行前请先备份' % (cmp_row.get('dbName') or ''),
        ]
        design_db = _text(cmp_row.get('designDb'))
        if design_db and design_db != _text(cmp_row.get('dbName')):
            notes.append('设计态库【%s】对应实库库【%s】：脚本里的库名按实库写'
                         % (design_db, cmp_row.get('dbName') or ''))
        if not plan['brief']['includeDrop'] and int(cmp_row.get('dropCount') or 0) > 0:
            notes.append('实库多出的 %s 个对象默认**不生成** DROP 语句（避免误删数据），'
                         '需要时勾选「包含删除语句」再导出' % cmp_row.get('dropCount'))
        if plan['errors']:
            notes.append('有 %d 个对象生成失败，见脚本末尾的清单' % len(plan['errors']))
        return {'appName': (app_row or {}).get('name') or '', 'dbName': cmp_row.get('dbName') or '',
                'notes': notes}

    def compareupgrade(self, params):
        """
        某次对比记录 → 给实库升级用的脚本（现算，不落库）

          · 方向固定「实库 → 设计态」：把实库改成设计态的样子；
          · 历史记录同样能导出（明细里存了左右两侧的定义，重放即可）；
          · includeDrop=1 才生成删除语句，默认不删（DROP 会丢数据）。
        """
        params = params or {}
        cmp_id = _uuid(params.get('compareId') or params.get('id'), '对比 id')
        row = query_one('SELECT * FROM `appschemacompares` WHERE `id`=%s', (cmp_id,))
        if not row:
            raise BizError('对比记录不存在', 404)
        app_row = query_one('SELECT * FROM `appinfos` WHERE `id`=%s', (row.get('appId'),)) or {}
        db_type = schema_ddl.normalize_db_type(row.get('dbType') or app_row.get('dbType'))
        include_drop = _bool(params.get('includeDrop'))
        items = [self._rebuild_item(one) for one in self._cmp_rows(row)]
        plan = _upgrade_plan(db_type, items, row.get('dbName'), include_drop)
        text = _upgrade_text(db_type, plan['groups'], self._cmp_context(row, app_row, items, plan))
        return {'compareId': cmp_id, 'appId': row.get('appId'), 'snapTime': _time_text(row.get('snapTime')),
                'dbName': row.get('dbName') or '', 'dbType': db_type,
                'connId': row.get('connId') or '', 'connName': row.get('connName') or '',
                'designDb': row.get('designDb') or '',
                'dbTypeLabel': schema_ddl.db_label(db_type), 'includeDrop': include_drop,
                'count': plan['brief']['count'], 'objects': plan['brief']['objects'],
                'diffCount': plan['brief']['diffCount'], 'skipped': plan['brief']['skipped'],
                'errors': plan['errors'], 'text': text,
                'groups': [{'objName': one['objName'], 'objType': one['objType'],
                            'diffType': one['diffType'], 'diffLabel': one['diffLabel'],
                            'details': one['details'], 'note': one['note'],
                            'statements': one['statements']} for one in plan['groups']]}

    def compareexport(self, params):
        """
        批量导出升级脚本：一次把多条对比记录的升级语句合成一份 .sql

          · ids 传了 → 只导这几条（最多 50 条）；不传 → 取这个应用最近 20 条有差异的记录；
          · 每条记录一段，段头写明时间点 / 目标库 / 差异数，整份能直接执行，也能只挑一段跑。
        """
        params = params or {}
        app = self._app(params.get('appId'))
        include_drop = _bool(params.get('includeDrop'))
        ids = [one for one in _multi_values(params.get('ids') or params.get('compareIds'))
               if RE_UUID.match(one)][:50]
        if ids:
            rows = query_all('SELECT * FROM `appschemacompares` WHERE `appId`=%s AND `id` IN (%s) '
                             'ORDER BY `createTime` DESC' % ('%s', ','.join(['%s'] * len(ids))),
                             [app['id']] + ids) or []
        else:
            rows = query_all('SELECT * FROM `appschemacompares` WHERE `appId`=%s '
                             'ORDER BY `createTime` DESC LIMIT 40', (app['id'],)) or []
            rows = [one for one in rows
                    if (int(one.get('addCount') or 0) + int(one.get('dropCount') or 0)
                        + int(one.get('alterCount') or 0)) > 0][:20]
        if not rows:
            raise BizError('这个应用还没有「有差异」的对比记录：先在对比页点「开始对比」')
        db_type = schema_ddl.normalize_db_type(rows[0].get('dbType') or app.get('dbType'))
        files, blocks, total = [], [], 0
        for idx, row in enumerate(rows):
            items = [self._rebuild_item(one) for one in self._cmp_rows(row)]
            plan = _upgrade_plan(db_type, items, row.get('dbName'), include_drop)
            text = _upgrade_text(db_type, plan['groups'], self._cmp_context(row, app, items, plan))
            total += plan['brief']['count']
            diff_count = (int(row.get('addCount') or 0) + int(row.get('dropCount') or 0)
                          + int(row.get('alterCount') or 0))
            head = ('-- ############################################################\n'
                    '-- 第 %d/%d 段 · 对比 %s · 实库连接 %s · 实库时间点 %s\n'
                    '-- 目标库 %s · 差异 %d 项 · 升级语句 %d 条\n'
                    '-- ############################################################'
                    % (idx + 1, len(rows), str(row.get('id') or '')[:8],
                       row.get('connName') or '未记录', _time_text(row.get('snapTime')),
                       row.get('dbName') or '', diff_count, plan['brief']['count']))
            blocks.append(head + '\n\n' + text)
            files.append({'id': row.get('id'), 'snapTime': _time_text(row.get('snapTime')),
                          'dbName': row.get('dbName') or '',
                          'connId': row.get('connId') or '', 'connName': row.get('connName') or '',
                          'designDb': row.get('designDb') or '', 'diffCount': diff_count,
                          'count': plan['brief']['count'], 'objects': plan['brief']['objects'],
                          'errors': plan['errors']})
        stamp = datetime.datetime.now().strftime('%Y%m%d%H%M')
        return {'appId': app['id'], 'count': len(files), 'statements': total,
                'includeDrop': include_drop, 'dbType': db_type,
                'dbTypeLabel': schema_ddl.db_label(db_type),
                'fileName': '%s_upgrade_%s.sql' % (app.get('code') or 'app', stamp),
                'text': '\n\n\n'.join(blocks), 'files': files}

    # ---------------- 导出表结构文档（Excel / Word） ----------------
    def export_docs(self, params):
        """
        把勾选的表（不传 ids 就是全部表 / 视图）导成结构说明文档

          · 内容取**设计态**（appschemadbs / objs / cols），不连真实库、不触发扫描；
          · 文档含应用信息、每张表的中文名（objComment）、字段中文名（colComment）、导出时间 / 导出人；
          · Excel = 应用信息 / 表清单 / 字段明细 三个页签；Word = 应用信息表 + 表清单 + 每表一节；
          · 返回文件二进制（由 app.py 的 /api/appschema/exportdocs 直接下发）。
        """
        params = params or {}
        app = self._app(params.get('appId'))
        fmt = _text(params.get('format') or params.get('fmt')).lower() or 'xlsx'
        fmt = {'xls': 'xlsx', 'excel': 'xlsx', 'doc': 'docx', 'word': 'docx'}.get(fmt, fmt)
        if fmt not in ('xlsx', 'docx'):
            raise BizError('只支持导出 Excel（xlsx）或 Word（docx）')

        ids = [one for one in _multi_values(params.get('ids') or params.get('objIds'))
               if RE_UUID.match(one)]
        sql = ('SELECT `o`.`id`, `o`.`objType`, `o`.`objName`, `o`.`objComment`, '
               '`o`.`sortNo`, `d`.`dbName`, `d`.`dbComment`, `d`.`sortNo` AS `dbSort` '
               'FROM `appschemaobjs` `o` JOIN `appschemadbs` `d` ON `d`.`id`=`o`.`dbId` '
               'WHERE `d`.`appId`=%s')
        args = [app['id']]
        if ids:
            sql += ' AND `o`.`id` IN (%s)' % ','.join(['%s'] * len(ids))
            args += ids
        else:
            # 没勾选就是「这个应用的全部表 / 视图」：过程 / 函数 / 触发器 / 索引没有字段，不进结构文档
            sql += " AND `o`.`objType` IN ('table','view')"
        rows = query_all(sql, args) or []
        if ids and not rows:
            raise BizError('勾选的对象不属于这个应用（或已被删除），请刷新后重试')
        if not rows:
            raise BizError('这个应用还没有表可以导出：先扫描导入或手工新增库 / 表')

        # 排序：库顺序 → 库名 → 对象类型（表在前）→ 对象名；文档里按库分段更好读
        rows = sorted(rows, key=lambda one: (int(one.get('dbSort') or 0), str(one.get('dbName') or ''),
                                             OBJ_TYPE_ORDER.get(str(one.get('objType')), 9),
                                             str(one.get('objName') or '')))

        # 字段一次批量取回（几百张表逐条查会把导出拖成几十秒），再按 objId 分组
        cols_map = {}
        obj_ids = [one['id'] for one in rows]
        for start in range(0, len(obj_ids), 400):
            chunk = obj_ids[start:start + 400]
            crows = query_all('SELECT `objId`,`colName`,`ordinal`,`dataType`,`length`,`nullable`,'
                              '`defaultValue`,`isPk`,`isAutoInc`,`colComment` FROM `appschemacols` '
                              'WHERE `objId` IN (%s) ORDER BY `objId`, `ordinal`, `colName`'
                              % ','.join(['%s'] * len(chunk)), chunk) or []
            for one in crows:
                cols_map.setdefault(one['objId'], []).append(self._col_dict(one))

        tables = []
        for one in rows:
            tables.append({
                'id': one['id'], 'dbName': one.get('dbName') or '', 'objName': one.get('objName') or '',
                'objType': one.get('objType') or 'table',
                'typeLabel': OBJ_TYPE_LABELS.get(one.get('objType'), '表'),
                'objComment': one.get('objComment') or '',
                'cols': cols_map.get(one['id'], []),
            })

        # 应用信息（部门 / 负责人 / 连接都是名称，导出后离开系统也能看懂）
        dept_name, owner_name, conn_name, target_db = '', '', '', ''
        if app.get('deptId'):
            row = query_one('SELECT `nameCn` FROM `OrganizationStructure` WHERE `id`=%s',
                            (app.get('deptId'),))
            dept_name = (row or {}).get('nameCn') or ''
        if app.get('ownerEmpId'):
            row = query_one('SELECT `nameCn` FROM `empinfos` WHERE `id`=%s', (app.get('ownerEmpId'),))
            owner_name = (row or {}).get('nameCn') or ''
        if app.get('dbConnId'):
            conn = query_one('SELECT `name`,`dbType`,`dbName`,`username` FROM `dbinfomgr` WHERE `id`=%s',
                             (app.get('dbConnId'),))
            if conn:
                conn_name = conn.get('name') or ''
                target_db = _text(connector.default_database({'dbType': conn.get('dbType'),
                                                              'dbName': conn.get('dbName'),
                                                              'username': conn.get('username')}))
        emp_id = self._login_emp_id(params)
        exporter = ''
        if emp_id:
            row = query_one('SELECT `nameCn` FROM `empinfos` WHERE `id`=%s', (emp_id,))
            exporter = (row or {}).get('nameCn') or ''

        app_type_label = next((one['label'] for one in APP_TYPE_OPTIONS
                               if one['value'] == _text(app.get('appType'))), _text(app.get('appType')))
        env_label = next((one['label'] for one in ENV_OPTIONS
                          if one['value'] == _text(app.get('env'))), _text(app.get('env')))
        meta = {
            'appCode': app.get('code') or '', 'appName': app.get('name') or '',
            'appShort': app.get('shortName') or '',
            'appTypeLabel': app_type_label, 'envLabel': env_label,
            'dbTypeLabel': schema_ddl.db_label(app.get('dbType')),
            'deptName': dept_name, 'ownerName': owner_name,
            'connName': conn_name, 'targetDb': target_db,
            'description': app.get('description') or '',
            'exportTime': _now(), 'exporter': exporter,
            'tableCount': len(tables), 'colCount': sum(len(one['cols']) for one in tables),
            'scopeText': ('勾选 %d 张表 / 视图' % len(tables)) if ids else '全部表 / 视图（%d 张）' % len(tables),
        }
        try:
            if fmt == 'xlsx':
                content = schema_export.build_xlsx(meta, tables)
                mimetype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            else:
                content = schema_export.build_docx(meta, tables)
                mimetype = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        except schema_export.ExportError as exc:
            raise BizError(str(exc))

        stamp = datetime.datetime.now().strftime('%Y%m%d%H%M')
        return {'content': content, 'mimetype': mimetype,
                'filename': '%s_表结构_%s.%s' % (app.get('code') or 'APP', stamp, fmt),
                'format': fmt, 'count': len(tables), 'colCount': meta['colCount'],
                'exportTime': meta['exportTime']}

    # ---------------- 字段级血缘 ----------------
    def _touch_lineage(self, app):
        """结构 / 定义变更后顺手重算血缘

        不能让它把主流程带崩：血缘是辅助视图，解析失败只该在血缘页面提示，
        不该让扫描 / 保存直接报错（这类分析最容易被一条怪 SQL 拖垮整条流程）。
        """
        try:
            return self._rebuild_lineage(app)
        except Exception as exc:                   # noqa: BLE001
            return {'error': '血缘重算失败：%s' % str(exc)[:200]}

    def lineagebuild(self, params):
        """重建字段血缘（人工点「重新分析」；扫描成功与保存定义后也会自动跑）

        只读设计态里的**定义文本**，不连真实库：
          · 视图的 SELECT → 输出列 ← 来源列；
          · 触发器 / 存储过程 / 函数的 INSERT / UPDATE → 被写的列 ← 表达式里的列；
          · 视图套视图递归展开到基表，`via` 记途经链，深度上限见 column_lineage.MAX_DEPTH。
        """
        app = self._app((params or {}).get('appId'))
        return self._rebuild_lineage(app)

    # ---- 手工维护 / 图形化标注（origin=manual，重新分析不会被覆盖）----
    def _lineage_index(self, app_id):
        """应用内 table/view 的「对象 + 字段」索引，一条 SQL 取全

        返回 {对象名 key: {'objName': 真实写法, 'objType': table/view, 'dbName': 库名,
                          'cols': {列名 key: 真实列名}}}
          · 校验手工连线的端点用 —— 拼错一个列名就会造出一条永远对不上的边，比没标还糟；
          · key 走 `_col_key`（大小写不敏感 + 只 rstrip），与唯一索引 uk_appschemalink 同口径。
        """
        rows = query_all(
            'SELECT `o`.`objName` AS `objName`, `o`.`objType` AS `objType`, '
            '`d`.`dbName` AS `dbName`, `c`.`colName` AS `colName` '
            'FROM `appschemaobjs` `o` JOIN `appschemadbs` `d` ON `d`.`id`=`o`.`dbId` '
            'LEFT JOIN `appschemacols` `c` ON `c`.`objId`=`o`.`id` '
            "WHERE `d`.`appId`=%s AND `o`.`objType` IN ('table','view')", (app_id,)) or []
        out = {}
        for one in rows:
            name = _text(one.get('objName'))
            if not name:
                continue
            bucket = out.setdefault(_col_key(name), {
                'objName': name, 'objType': _text(one.get('objType')) or 'table',
                'dbName': _text(one.get('dbName')), 'cols': {}})
            col = _text(one.get('colName'))
            if col:
                bucket['cols'].setdefault(_col_key(col), col)
        return out

    def _lineage_emp_name(self, params):
        """当前登录人中文名（标注人；取不到就不写，不编造）"""
        emp_id = self._login_emp_id(params)
        if not emp_id:
            return ''
        try:
            row = query_one('SELECT `nameCn` FROM `empinfos` WHERE `id`=%s', (emp_id,))
        except Exception:                              # noqa: BLE001
            row = None
        return _text((row or {}).get('nameCn'))

    def lineageedgesave(self, params):
        """手工保存一条血缘边（新增 / 改标注 / 把自动边转为手工）

        参数：
          · id          已有的边 → 就地转成手工并改标注（这是「修正机器算错的那条」的入口，
                        端点不可改：换端点等于换一条边，删了重建更清楚）；
          · targetObj/targetCol   目标（被写入 / 派生的那端）；INDIRECT 边 targetCol 可空；
          · sourceObj/sourceCol   来源端（必须有具体字段，否则这条边没有意义）；
          · linkType    DIRECT 直接派生 / INDIRECT 间接影响；
          · subType     直接：IDENTITY/TRANSFORMATION/AGGREGATION/CONDITIONAL；
                        间接：JOIN/FILTER/GROUP_BY/SORT/WINDOW；
          · note        标注说明（≤500 字）；transform 可留空（人工补充表达式说明）。

        保存后这条边 origin=manual，重新分析时**不会被覆盖**（`_rebuild_lineage` 跳过同 key 的边）。
        """
        params = params or {}
        app = self._app(params.get('appId'))
        index = self._lineage_index(app['id'])

        link = (_text(params.get('linkType')) or 'DIRECT').upper()
        if link not in ('DIRECT', 'INDIRECT'):
            raise BizError('血缘类型只能是 DIRECT（直接派生）或 INDIRECT（间接影响）')
        sub = _text(params.get('subType')).upper() or ('TRANSFORMATION' if link == 'DIRECT' else 'FILTER')
        allowed = LINEAGE_SUB_DIRECT if link == 'DIRECT' else LINEAGE_SUB_INDIRECT
        if sub not in allowed:
            raise BizError('子类型【%s】不适用于%s，可选：%s'
                           % (sub, LINEAGE_TYPE_LABELS.get(link), '、'.join(allowed)))
        note = _text(params.get('note'))[:500]
        transform = _text(params.get('transform'))[:500]
        edge_id = _text(params.get('id'))

        def canon(obj_want, col_want, need_col, label):
            """对象 / 字段名 → 设计态里的真实写法（并且必须存在）"""
            key = _col_key(obj_want)
            if not key or key not in index:
                raise BizError('对象【%s】不在这个应用的设计态里（%s）：先扫描或手工建表，再标血缘'
                               % (_text(obj_want) or '（空）', label))
            obj = index[key]
            col = _text(col_want)
            if not col:
                if need_col:
                    raise BizError('%s字段不能为空（没有字段的血缘边指不到任何东西）' % label)
                return obj, ''
            real = obj['cols'].get(_col_key(col))
            if not real:
                raise BizError('%s字段【%s】在【%s】里不存在：检查拼写，或先在字段明细里补上这个字段'
                               % (label, col, obj['objName']))
            return obj, real

        old = None
        if edge_id:
            old = query_one('SELECT * FROM `appschemalink` WHERE `id`=%s AND `appId`=%s',
                            (edge_id, app['id']))
            if not old:
                raise BizError('这条血缘记录不存在或已被删除', 404)
            # 端点锁定：只改类型 / 标注。前端的编辑弹窗也据此把端点置灰
            t_key = _col_key(old.get('targetObj'))
            s_key = _col_key(old.get('sourceObj'))
            t_obj = index.get(t_key) or {'objName': _text(old.get('targetObj')),
                                         'objType': _text(old.get('targetType')) or 'table',
                                         'dbName': _text(old.get('dbName')), 'cols': {}}
            s_obj = index.get(s_key) or {'objName': _text(old.get('sourceObj')),
                                         'objType': _text(old.get('sourceType')) or 'table',
                                         'dbName': _text(old.get('dbName')), 'cols': {}}
            t_col = _text(old.get('targetCol'))
            s_col = _text(old.get('sourceCol'))
        else:
            t_obj, t_col = canon(params.get('targetObj'), params.get('targetCol'),
                                 link == 'DIRECT', '目标')
            s_obj, s_col = canon(params.get('sourceObj'), params.get('sourceCol'), True, '来源')

        if _col_key(t_obj['objName']) == _col_key(s_obj['objName']) \
                and _col_key(t_col) == _col_key(s_col):
            raise BizError('来源与目标是同一个字段（%s.%s）：血缘不能指向自己'
                           % (t_obj['objName'], t_col or '整表'))
        who = self._lineage_emp_name(params)
        stamp = _now()

        # 同一条逻辑边已经有了（多半是解析出来的）→ 收编成手工，保留它原来的 transform
        same = None
        if not edge_id:
            same = query_one(
                'SELECT `id` FROM `appschemalink` WHERE `appId`=%s AND `targetObj`=%s '
                'AND `targetCol`=%s AND `sourceObj`=%s AND `sourceCol`=%s AND `linkType`=%s '
                'AND `subType`=%s LIMIT 1',
                (app['id'], t_obj['objName'], t_col, s_obj['objName'], s_col, link, sub))

        new_id = edge_id or (_text((same or {}).get('id')) if same else str(uuid.uuid4()))

        def write(cur):
            if same and not edge_id:
                cur.execute('UPDATE `appschemalink` SET `origin`=%s, `note`=%s, `manualBy`=%s, '
                            '`updateTime`=%s WHERE `id`=%s',
                            ('manual', note or None, who or None, stamp, new_id))
                return
            if edge_id:
                cur.execute(
                    'UPDATE `appschemalink` SET `origin`=%s, `linkType`=%s, `subType`=%s, '
                    '`note`=%s, `manualBy`=%s, `updateTime`=%s, `transform`=%s WHERE `id`=%s',
                    ('manual', link, sub, note or None, who or None, stamp,
                     (transform or _text(old.get('transform'))) or None, edge_id))
                return
            cur.execute(
                'INSERT INTO `appschemalink` (`id`,`appId`,`dbName`,`targetObj`,`targetType`,'
                '`targetCol`,`sourceObj`,`sourceType`,`sourceCol`,`transform`,`via`,`depth`,`kind`,'
                '`linkType`,`subType`,`masked`,`origin`,`note`,`manualBy`,`updateTime`) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (new_id, app['id'], t_obj['dbName'] or s_obj['dbName'], t_obj['objName'],
                 t_obj['objType'], t_col, s_obj['objName'], s_obj['objType'], s_col,
                 transform or None, '', 0, 'manual', link, sub, 0, 'manual',
                 note or None, who or None, stamp))

        transaction(write)
        self._refresh_lineage_meta(app['id'])
        row = query_one('SELECT * FROM `appschemalink` WHERE `id`=%s', (new_id,)) or {}
        return {'saved': True, 'edge': _lineage_row(row), 'manualBy': who}

    def lineageedgedel(self, params):
        """删掉一条**手工**血缘边：自动解析出来的边不给删（删了下次重算又回来，白删）

        要删解析边，先「转为手工标注」（lineageedgesave 传 id）再删 —— 这一步是故意的：
        免得有人以为删掉就永久生效，结果一次重新分析又长出来。
        """
        params = params or {}
        app = self._app(params.get('appId'))
        edge_id = _text(params.get('id'))
        if not edge_id:
            raise BizError('缺少要删除的血缘记录 id')
        row = query_one('SELECT * FROM `appschemalink` WHERE `id`=%s AND `appId`=%s',
                        (edge_id, app['id']))
        if not row:
            raise BizError('这条血缘记录不存在或已被删除', 404)
        if (_text(row.get('origin')) or 'sql') != 'manual':
            raise BizError('这条是自动解析出来的血缘（%s），删了下次「重新分析」还会长回来：'
                           '若要纠正它，先把它转为手工标注再改 / 删'
                           % LINEAGE_ORIGIN_LABELS.get(_text(row.get('origin')) or 'sql', '自动'))
        transaction(lambda cur: cur.execute('DELETE FROM `appschemalink` WHERE `id`=%s', (edge_id,)))
        self._refresh_lineage_meta(app['id'])
        return {'deleted': True, 'id': edge_id}

    def _refresh_lineage_meta(self, app_id):
        """手工增删边之后把 meta 的边数同步过去（页面顶部的「血缘 N 条」不能被人工操作算漏）"""
        try:
            row = query_one('SELECT COUNT(*) AS `c` FROM `appschemalink` WHERE `appId`=%s',
                            (app_id,)) or {}
            transaction(lambda cur: cur.execute(
                'UPDATE `appschemalinkmeta` SET `edgeCount`=%s WHERE `appId`=%s',
                (int(row.get('c') or 0), app_id)))
        except Exception:                              # noqa: BLE001
            pass                                       # 计数不准不影响功能，别把保存整挂

    def lineage(self, params):
        """查字段血缘：某对象的字段清单（带上/下游条数）+ 指定字段的上游 / 下游明细

        返回三块，口径与写库时一致：
          · fields  字段清单，计数只算 DIRECT（值从哪来 / 值被谁拿去算）；
          · up      这个字段的值**从哪来** —— 只有 DIRECT；
          · down    谁在用它 —— DIRECT（拿去算）与 INDIRECT（拿去做过滤 / 连接 / 分组）都算，
                    这样改一列时能一并看到「它还是某视图的过滤条件」；
          · rowDeps 这个对象的**整表依赖**（targetCol 为空）—— 决定取哪些行、怎么分组、什么顺序。
        """
        params = params or {}
        app = self._app(params.get('appId'))
        obj_name = _text(params.get('objName'))
        col_name = _text(params.get('colName'))
        meta = query_one('SELECT * FROM `appschemalinkmeta` WHERE `appId`=%s', (app['id'],)) or {}
        db_type = schema_ddl.normalize_db_type(app.get('dbType'))
        out = {
            'appId': app['id'], 'builtAt': _time_text(meta.get('builtAt')),
            'edgeCount': int(meta.get('edgeCount') or 0),
            'objectCount': int(meta.get('objectCount') or 0),
            'noteCount': int(meta.get('noteCount') or 0),
            'dbType': db_type, 'dbTypeLabel': schema_ddl.db_label(db_type),
            'objName': obj_name, 'objType': '', 'fields': [], 'up': [], 'down': [],
            'rowDeps': [], 'directCount': 0, 'indirectCount': 0, 'notes': [],
            'originCounts': {'sql': 0, 'ref': 0, 'calc': 0, 'manual': 0},
        }
        if not out['builtAt']:
            out['notes'] = [{'objName': '', 'objType': '',
                             'reason': '还没有分析过：点「重新分析」生成字段血缘'}]
            return out

        for one in query_all('SELECT `linkType`, COUNT(*) AS `c` FROM `appschemalink` '
                             'WHERE `appId`=%s GROUP BY `linkType`', (app['id'],)) or []:
            key = 'indirectCount' if _text(one.get('linkType')).upper() == 'INDIRECT' else 'directCount'
            out[key] = int(one.get('c') or 0)
        for one in query_all('SELECT `origin`, COUNT(*) AS `c` FROM `appschemalink` '
                             'WHERE `appId`=%s GROUP BY `origin`', (app['id'],)) or []:
            out['originCounts'][_text(one.get('origin')) or 'sql'] = int(one.get('c') or 0)

        note_rows = query_all('SELECT `objName`,`objType`,`reason` FROM `appschemalinknote` '
                              'WHERE `appId`=%s' + (' AND `objName`=%s' if obj_name else '')
                              + ' ORDER BY `objName` LIMIT 200',
                              (app['id'], obj_name) if obj_name else (app['id'],)) or []
        out['notes'] = [{'objName': one.get('objName') or '', 'objType': one.get('objType') or '',
                         'reason': one.get('reason') or ''} for one in note_rows]
        if not obj_name:
            return out

        row = query_one('SELECT `o`.`id`,`o`.`objType` FROM `appschemaobjs` `o` '
                        'JOIN `appschemadbs` `d` ON `d`.`id`=`o`.`dbId` '
                        'WHERE `d`.`appId`=%s AND `o`.`objName`=%s', (app['id'], obj_name))
        out['objType'] = (row or {}).get('objType') or ''
        fields = []
        if row:
            fields = query_all('SELECT `colName`,`colComment`,`isPk` FROM `appschemacols` '
                               'WHERE `objId`=%s ORDER BY `ordinal`, `colName`', (row['id'],)) or []
        up_rows = query_all("SELECT * FROM `appschemalink` WHERE `appId`=%s AND `targetObj`=%s "
                            "AND `linkType`='DIRECT'"
                            + (' AND `targetCol`=%s' if col_name else '')
                            + ' ORDER BY `depth`, `targetCol`, `sourceObj`, `sourceCol`',
                            (app['id'], obj_name) + ((col_name,) if col_name else ())) or []
        # 下游含 INDIRECT：这一列可能没被拿去算，但被某个视图当成了过滤 / 连接条件，
        # 改它照样会让那个视图的结果变 —— 评估影响必须看得见
        down_rows = query_all('SELECT * FROM `appschemalink` WHERE `appId`=%s AND `sourceObj`=%s'
                              + (' AND `sourceCol`=%s' if col_name else '')
                              + ' ORDER BY `linkType`, `targetObj`, `targetCol`',
                              (app['id'], obj_name) + ((col_name,) if col_name else ())) or []
        row_deps = query_all("SELECT * FROM `appschemalink` WHERE `appId`=%s AND `targetObj`=%s "
                             "AND `linkType`='INDIRECT' ORDER BY `subType`, `sourceObj`, `sourceCol`",
                             (app['id'], obj_name)) or []
        # 字段清单：设计态字段优先（没血缘的字段也要能看到），血缘里出现的额外字段补充上去
        counts = {}
        for one in up_rows:
            key = _col_key(one.get('targetCol'))
            counts.setdefault(key, {'up': 0, 'down': 0})['up'] += 1
        for one in down_rows:
            key = _col_key(one.get('sourceCol'))
            counts.setdefault(key, {'up': 0, 'down': 0})['down'] += 1
        seen = set()
        for one in fields:
            key = _col_key(one.get('colName'))
            seen.add(key)
            fields_out = {'colName': one.get('colName'), 'colComment': one.get('colComment') or '',
                          'isPk': bool(int(one.get('isPk') or 0)),
                          'upCount': counts.get(key, {}).get('up', 0),
                          'downCount': counts.get(key, {}).get('down', 0)}
            out['fields'].append(fields_out)
        for key, cnt in counts.items():
            if key in seen:
                continue
            out['fields'].append({'colName': key, 'colComment': '', 'isPk': False,
                                  'upCount': cnt['up'], 'downCount': cnt['down']})
        out['up'] = [_lineage_row(one) for one in up_rows]
        out['down'] = [_lineage_row(one) for one in down_rows]
        out['rowDeps'] = [_lineage_row(one) for one in row_deps]
        return out

    def _rebuild_lineage(self, app):
        """重建一个应用的血缘：解析 → 展开视图链 → 整体替换（先删后插，不留半套数据）

        落两类边（口径对齐 OpenLineage 的 columnLineage facet）：
          · DIRECT   逐列：「这个字段的值由哪些字段算出」，带 IDENTITY / TRANSFORMATION / AGGREGATION；
          · INDIRECT 整表：「哪些字段决定了取哪些行、怎么分组、什么顺序」（FILTER / JOIN /
            GROUP_BY / SORT / WINDOW），targetCol 留空 —— 它影响全部输出列，摊到每列会爆炸。
        """
        snap = self._snapshot(app['id'])
        db_type = schema_ddl.normalize_db_type(app.get('dbType'))
        notes, direct, indirect, parsed_objs = [], [], [], 0
        # 对象 / 列清单按**全应用**合并：视图可能引用另一个库里的表，而且「视图套视图」展开时
        # 要找的那个视图不一定和来源在同一个库 —— 只留当前库的局部变量会漏（这是踩过的坑）。
        objs_all, schema_all, obj_db, idx_objs = {}, {}, {}, []
        for db in snap.get('databases') or []:
            db_name = _text(db.get('dbName'))
            for obj in db.get('objects') or []:
                name = _text(obj.get('objName'))
                if not name:
                    continue
                objs_all[_col_key(name)] = obj
                obj_db[_col_key(name)] = db_name
                if str(obj.get('objType')) in ('table', 'view'):
                    schema_all[name] = [_text(one.get('colName')) for one in (obj.get('columns') or [])]
                    # 注释血缘的字典源：字段注释是自由文本，得先建好「对象 → 列 → 注释」
                    # 才能反查「口径里提到的中文名是哪个字段」
                    idx_objs.append({
                        'objName': name, 'objType': str(obj.get('objType') or ''),
                        'columns': [{'colName': _text(one.get('colName')),
                                     'colComment': _text(one.get('colComment'))}
                                    for one in (obj.get('columns') or [])],
                    })
            for obj in db.get('objects') or []:
                name = _text(obj.get('objName'))
                otype = str(obj.get('objType') or '')
                ddl = str(obj.get('ddl') or '')
                if otype not in ('view', 'trigger', 'procedure', 'function') or not ddl.strip():
                    continue
                parsed_objs += 1
                if otype == 'view':
                    cols = [_text(one.get('colName')) for one in (obj.get('columns') or [])]
                    res = column_lineage.parse_query(ddl, db_type, schema_all, cols)
                    if not res.get('ok'):
                        notes.append((name, otype, res.get('note') or '解析失败'))
                        continue
                    if res.get('note'):
                        notes.append((name, otype, res['note']))
                    miss = 0
                    for col in res.get('columns') or []:
                        for src in col.get('sources') or []:
                            if not src.get('obj'):
                                miss += 1
                                continue
                            direct.append({'dbName': db_name, 'target': name, 'ttype': 'view',
                                           'tcol': col.get('col') or '', 'sobj': src.get('obj'),
                                           'scol': src.get('col') or '',
                                           'expr': col.get('expr') or '', 'kind': 'view',
                                           'subType': src.get('subType') or '',
                                           'masked': int(src.get('masked') or 0)})
                    if miss:
                        notes.append((name, otype, '%d 处来源没能定位到具体表 / 字段（列名没写表别名，或引用了动态表名）' % miss))
                    for dep in res.get('rowDeps') or []:
                        indirect.append({'dbName': db_name, 'target': name, 'ttype': 'view',
                                         'sobj': dep.get('obj') or '', 'scol': dep.get('col') or '',
                                         'subType': dep.get('subType') or 'FILTER',
                                         'expr': dep.get('expr') or '', 'kind': 'view'})
                    continue
                res = column_lineage.parse_writes(ddl, db_type, schema_all)
                for reason in res.get('notes') or []:
                    notes.append((name, otype, reason))
                for stmt in res.get('statements') or []:
                    for col in stmt.get('cols') or []:
                        for src in col.get('sources') or []:
                            if not src.get('obj'):
                                continue
                            direct.append({'dbName': db_name, 'target': stmt.get('table') or '',
                                           'ttype': 'table', 'tcol': col.get('col') or '',
                                           'sobj': src.get('obj'), 'scol': src.get('col') or '',
                                           'expr': col.get('expr') or '', 'kind': otype,
                                           'subType': src.get('subType') or '',
                                           'masked': int(src.get('masked') or 0)})
                    for dep in stmt.get('deps') or []:
                        indirect.append({'dbName': db_name, 'target': stmt.get('table') or '',
                                         'ttype': 'table', 'sobj': dep.get('obj') or '',
                                         'scol': dep.get('col') or '',
                                         'subType': dep.get('subType') or 'FILTER',
                                         'expr': dep.get('expr') or '', 'kind': otype})

        # 视图字段 → 它的直接来源（用于把「视图套视图」展开到基表）
        view_edges = {}
        for one in direct:
            if str(objs_all.get(_col_key(one['target']), {}).get('objType')) != 'view':
                continue
            key = (_col_key(one['target']), _col_key(one['tcol']))
            view_edges.setdefault(key, []).append(one)

        def is_view(name):
            return str((objs_all.get(_col_key(name)) or {}).get('objType') or '') == 'view'

        def expand(obj, col, expr, depth, seen, chain):
            """把来源逐层展开到基表；遇到环 / 太深就停在当前对象（并留痕）"""
            key = (_col_key(obj), _col_key(col))
            inner = view_edges.get(key)
            if inner and key not in seen and depth < column_lineage.MAX_DEPTH:
                out = []
                for one in inner:
                    out.extend(expand(one['sobj'], one['scol'], one['expr'], depth + 1,
                                      seen | {key}, chain + [obj]))
                return out
            if is_view(obj) and key not in seen:
                notes.append((obj, 'view', '字段【%s】没能展开到基表（视图定义里找不到该列，或层数过深）' % col))
            return [{'obj': obj, 'col': col, 'expr': expr, 'depth': depth,
                     'via': ' > '.join(chain), 'isView': is_view(obj)}]

        merged = {}
        for one in direct:
            for leaf in expand(one['sobj'], one['scol'], one['expr'], 0, set(), []):
                key = (one['target'], one['tcol'], leaf['obj'], leaf['col'],
                       'DIRECT', one.get('subType') or '')
                if key in merged:
                    if leaf['depth'] < merged[key]['depth']:
                        merged[key] = dict(merged[key], depth=leaf['depth'], via=leaf['via'],
                                           transform=leaf['expr'])
                    continue
                merged[key] = {'dbName': one['dbName'], 'target': one['target'],
                               'ttype': one['ttype'], 'tcol': one['tcol'],
                               'sobj': leaf['obj'], 'scol': leaf['col'],
                               'transform': leaf['expr'], 'via': leaf['via'],
                               'depth': leaf['depth'], 'kind': one['kind'],
                               'linkType': 'DIRECT', 'subType': one.get('subType') or '',
                               'masked': int(one.get('masked') or 0),
                               'stype': 'view' if leaf['isView'] else 'table'}
        # 整表级依赖不展开：它记的是「这个视图 / 这句话用了哪些列做过滤、连接、分组、排序」，
        # 跟着视图链往下推没有意义（内层视图过滤的是它自己的结果集，不是外层的结果集）
        for one in indirect:
            if not one['sobj']:
                continue
            key = (one['target'], '', one['sobj'], one['scol'], 'INDIRECT', one['subType'])
            if key in merged:
                continue
            merged[key] = {'dbName': one['dbName'], 'target': one['target'],
                           'ttype': one['ttype'], 'tcol': '',
                           'sobj': one['sobj'], 'scol': one['scol'],
                           'transform': one['expr'], 'via': '',
                           'depth': 0, 'kind': one['kind'],
                           'linkType': 'INDIRECT', 'subType': one['subType'], 'masked': 0,
                           'stype': 'view' if is_view(one['sobj']) else 'table'}

        # ---- 注释血缘：从字段注释里抽「表.列」引用与中文口径 --------------------
        # 为什么放在 SQL 之后：SQL 是机器算的（表达式就在那儿），优先采信；注释是作者写的，
        # 补的是 SQL 够不着的地方 —— 外键语义、「取自某表某列」、费用口径公式。
        # 同一逻辑边（目标列 + 来源列）只留一条：已经有 SQL 边的就不再插注释边，
        # 否则图上同一对字段会出现两条线，看起来像两条不同的依赖。
        covered = {(one['target'], one['tcol'], one['sobj'], one['scol'])
                   for one in merged.values() if one['linkType'] == 'DIRECT'}
        idx = comment_lineage.Index(idx_objs)
        for one in idx_objs:
            obj_name = one['objName']
            ttype = 'view' if one['objType'] == 'view' else 'table'
            db_name = obj_db.get(_col_key(obj_name)) or ''
            for col in one['columns']:
                res = comment_lineage.parse_column(col.get('colComment'), idx,
                                                   obj_name, col.get('colName'))
                for reason in res.get('notes') or []:
                    notes.append((obj_name, ttype, reason))
                for src in res.get('sources') or []:
                    tcol = _text(col.get('colName'))
                    sobj = _text(src.get('obj'))
                    scol = _text(src.get('col'))
                    if not tcol or not sobj or not scol:
                        continue
                    if (obj_name, tcol, sobj, scol) in covered:
                        continue
                    covered.add((obj_name, tcol, sobj, scol))
                    sub = src.get('subType') or 'TRANSFORMATION'
                    mkey = (obj_name, tcol, sobj, scol, 'DIRECT', sub)
                    if mkey in merged:
                        continue
                    merged[mkey] = {
                        'dbName': db_name, 'target': obj_name, 'ttype': ttype,
                        'tcol': tcol, 'sobj': sobj, 'scol': scol,
                        'transform': _text(res.get('calc')), 'via': '',
                        'depth': 0, 'kind': 'comment',
                        'linkType': 'DIRECT', 'subType': sub, 'masked': 0,
                        'origin': src.get('origin') or comment_lineage.ORIGIN_REF,
                        'stype': 'view' if is_view(sobj) else 'table',
                    }

        rows = [(str(uuid.uuid4()), app['id'], one['dbName'], one['target'], one['ttype'],
                 one['tcol'], one['sobj'], one['stype'], one['scol'],
                 (one['transform'] or '')[:500], (one['via'] or '')[:300],
                 int(one['depth']), one['kind'],
                 one['linkType'], one['subType'], int(one['masked']),
                 one.get('origin') or 'sql')
                for one in merged.values()]

        # ---- 人工标注过的边：整体重建也不能碰 -------------------------------
        # 人标一条边是有成本的（要判断业务口径），而且它往往正是机器算不出来的那种。
        # 所以 origin=manual 的行一律保留：既不删除，也不允许解析结果在同 key 上重复插入
        # （同一对字段两条线，图上看起来像两条不同的依赖）。
        manual_rows = query_all("SELECT * FROM `appschemalink` WHERE `appId`=%s AND `origin`='manual'",
                                (app['id'],)) or []
        keep = set((_col_key(one.get('targetObj')), _col_key(one.get('targetCol')),
                    _col_key(one.get('sourceObj')), _col_key(one.get('sourceCol')),
                    _text(one.get('subType')))
                   for one in manual_rows)
        if keep:
            rows = [one for one in rows
                    if (_col_key(one[3]), _col_key(one[5]), _col_key(one[6]), _col_key(one[8]),
                        _text(one[14])) not in keep]

        direct_count = (sum(1 for one in rows if one[13] == 'DIRECT')
                        + sum(1 for one in manual_rows
                              if (_text(one.get('linkType')) or 'DIRECT').upper() != 'INDIRECT'))
        indirect_count = len(rows) + len(manual_rows) - direct_count
        # 按「边怎么来的」计数：页面上要能说清「这 300 条里 SQL 算出多少、注释补了多少、人标了多少」
        origin_counts = {'sql': 0, 'ref': 0, 'calc': 0, 'manual': len(manual_rows)}
        for one in merged.values():
            key = one.get('origin') or 'sql'
            origin_counts[key] = origin_counts.get(key, 0) + 1
        stamp = _now()
        total_edges = len(rows) + len(manual_rows)

        def write(cur):
            # 只重建机器算出来的边；手工边留给人工删除（lineageedgedel）
            cur.execute("DELETE FROM `appschemalink` WHERE `appId`=%s "
                        "AND (`origin` IS NULL OR `origin`<>'manual')", (app['id'],))
            cur.execute('DELETE FROM `appschemalinknote` WHERE `appId`=%s', (app['id'],))
            if rows:
                cur.executemany(
                    'INSERT INTO `appschemalink` (`id`,`appId`,`dbName`,`targetObj`,`targetType`,'
                    '`targetCol`,`sourceObj`,`sourceType`,`sourceCol`,`transform`,`via`,`depth`,`kind`,'
                    '`linkType`,`subType`,`masked`,`origin`) '
                    'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', rows)
            if notes:
                cur.executemany(
                    'INSERT INTO `appschemalinknote` (`id`,`appId`,`objName`,`objType`,`reason`) '
                    'VALUES (%s,%s,%s,%s,%s)',
                    [(str(uuid.uuid4()), app['id'], name, otype, (reason or '')[:500])
                     for name, otype, reason in notes])
            cur.execute('INSERT INTO `appschemalinkmeta` (`appId`,`builtAt`,`edgeCount`,'
                        '`objectCount`,`noteCount`,`dbType`) VALUES (%s,%s,%s,%s,%s,%s) '
                        'ON DUPLICATE KEY UPDATE `builtAt`=VALUES(`builtAt`),'
                        '`edgeCount`=VALUES(`edgeCount`),`objectCount`=VALUES(`objectCount`),'
                        '`noteCount`=VALUES(`noteCount`),`dbType`=VALUES(`dbType`)',
                        (app['id'], stamp, total_edges, parsed_objs, len(notes), db_type))
        transaction(write)
        return {'appId': app['id'], 'builtAt': _time_text(stamp), 'edgeCount': total_edges,
                'directCount': direct_count, 'indirectCount': indirect_count,
                'manualCount': len(manual_rows),
                'originCounts': origin_counts,
                'objectCount': parsed_objs, 'noteCount': len(notes),
                'dbType': db_type, 'dbTypeLabel': schema_ddl.db_label(db_type),
                'notes': [{'objName': name, 'objType': otype, 'reason': reason}
                          for name, otype, reason in notes[:50]]}




app_info_service = AppInfoService()
app_schema_service = AppSchemaService()
