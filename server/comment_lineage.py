# -*- coding: utf-8 -*-
"""
字段注解（colComment）驱动的血缘抽取（纯函数，不连库）
--------------------------------------------------------------------------------
和 column_lineage.py 的分工：
  · column_lineage 从**表达式**推血缘（视图 SELECT、过程 INSERT/UPDATE），依赖 DDL 文本，
    推不出来的地方只能留 note；
  · 本模块从**人写的字段注释**里抽血缘。真实库里的注释经常直接写着出处，例如

        emp_msgs.attachId      附件ID（empmsgfiles.id，空=纯文字）
        projectdirs.parentId   上级目录ID（projectdirs.id，空=项目根目录）
        empimgroupmembers.empId 成员工号（empinfos.id = useinfo.empId）
        APP_XCJCXXB.TKXXBUUID  条款信息表UUID(APP_TKXXB.UUID)
        EMR_..._RECORD.GEN_MED_SF 总费用=一般医疗服务费+一般操作治疗费+护理费+…

    前四类是「表.列」的点号引用，直接可判；最后一类是**中文口径**，要用其它字段的
    中文注释当字典反查回列名。两类都抽，但可信度不同，落库时用 origin 区分：
    点号引用是「作者明说的出处」，中文口径是「按名字猜回来的」，页面要分别标注。

为什么值得做：这类信息只有人知道（外键语义、口径公式），SQL 解析永远拿不到；
而它又确实存在库里，白白烂在注释里。两者合并后，一条字段的「从哪来」才完整 ——
SQL 说有取值链、注释说有业务出处，对不上的地方本身就是治理线索。

不做的事（刻意的）：
  · 不做模糊匹配 / 近义词 / 编辑距离 —— 中文注释误命中一次就是一条假血缘，
    比没有更糟；
  · 不猜没写来源的注释 —— 只有作者真的写了才抽，宁缺毋滥；
  · 不抛异常 —— 注释是给人看的自由文本，解析器得容忍一切脏数据。
"""
import re

# ---- 边的来源（落库到 appschemalink.origin）---------------------------------
ORIGIN_SQL = 'sql'          # 表达式解析出来（column_lineage）
ORIGIN_REF = 'ref'          # 注释里的「表.列」点号引用 —— 作者明说
ORIGIN_CALC = 'calc'        # 注释里的中文口径，按中文名反查回来 —— 推断

# 点号引用：两边都得是合法标识符。左边至少 2 字符，避免把 `e.g` / `i.e` 当表名；
# 前后不能再接标识符字符（防止把 a.b.c 的 a.b 截出来）。
_IDENT = r'[A-Za-z_][A-Za-z0-9_$]{1,60}'
_DOT_REF = re.compile(r'(?<![A-Za-z0-9_$.])(' + _IDENT + r')\s*\.\s*(' + _IDENT + r')(?![A-Za-z0-9_$])')

# 点号引用的黑名单：这些不是表名（缩写、域名、扩展名、版本号前缀）
_NOT_TABLE = {
    'e.g', 'i.e', 'etc', 'eg', 'ie', 'vs', 'cf', 'al', 'fig', 'no', 'v', 'ver', 'version',
    'www', 'http', 'https', 'com', 'cn', 'net', 'org', 'html', 'htm', 'sql', 'jpg', 'jpeg',
    'png', 'gif', 'pdf', 'xls', 'xlsx', 'doc', 'docx', 'csv', 'txt', 'zip', 'rar', 'json',
    'xml', 'java', 'python', 'js', 'css', 'md', 'log', 'bak', 'tmp', 'exe', 'dll',
}

# 中文口径：左侧是字段的中文名（或本字段自身的说明），右侧是 A + B + C / A>=B+C 之类。
# 只认「加」和「减」，乘除在费用口径里几乎不出现，认了反而容易把「100*0.5」当公式。
_CALC_OP = re.compile(r'[+＋]')
# 口径里切分出来的中文词：连续中文 / 字母数字下划线，长度 2 起
_CN_TOKEN = re.compile(r'[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9]{1,30}')

# 注释里的换行会把词切断（真实数据里「护理\n费」就是被硬换行拆开的），
# 所以匹配前先把换行去掉 —— 但保留原文用于展示。
_NL = re.compile(r'[\r\n]+')


def _flat(text):
    """去掉换行和多余空白，供匹配用（中文词被换行拆开是这批数据里最常见的问题）"""
    return re.sub(r'\s+', '', str(text or ''))


def _low(text):
    return str(text or '').strip().strip('`"[]').lower()


class Index(object):
    """全应用的字段字典：对象名 / 列名 / 中文注释 → 字段

    一次扫描建好，供所有字段共用。三张表：
      · objs   {小写对象名: {'objName':原名, 'cols': {小写列名: 原列名}, 'objType':类型}}
      · cn     {小写中文注释: [(objName, colName)]}   —— 中文口径反查用
      · cn_in  {小写中文注释: [(objName, colName)]}   —— 只收「自身名称型」的短注释
    """

    def __init__(self, objects):
        """:param objects [{objName, objType, columns: [{colName, colComment}]}]"""
        self.objs = {}
        self.cn = {}
        self.cn_in = {}
        for obj in (objects or []):
            name = str(obj.get('objName') or '').strip()
            if not name:
                continue
            key = _low(name)
            entry = self.objs.setdefault(key, {'objName': name, 'objType':
                                               str(obj.get('objType') or ''),
                                               'cols': {}})
            for col in (obj.get('columns') or []):
                col_name = str(col.get('colName') or '').strip()
                if not col_name:
                    continue
                entry['cols'][_low(col_name)] = col_name
                cn = _flat(col.get('colComment'))
                if not cn or len(cn) > 24:
                    continue
                # 「自身名称型」：注释里没有别的标点、不是一整句话，才配当字典项。
                # 像「总费用=…+…」这种口径公式不能反过来当别人的名字。
                if any(ch in cn for ch in '（(）)，,。;；:：=<>') or '+' in cn:
                    continue
                self.cn_in.setdefault(cn, []).append((name, col_name))
                self.cn.setdefault(cn, []).append((name, col_name))

    # ---- 查询 ------------------------------------------------------------
    def has_obj(self, name):
        return _low(name) in self.objs

    def col_exists(self, obj_name, col_name):
        one = self.objs.get(_low(obj_name)) or {}
        return _low(col_name) in (one.get('cols') or {})

    def real_obj(self, name):
        return (self.objs.get(_low(name)) or {}).get('objName') or name

    def real_col(self, obj_name, col_name):
        one = self.objs.get(_low(obj_name)) or {}
        return (one.get('cols') or {}).get(_low(col_name)) or col_name

    def lookup_cn(self, word, prefer_obj=None):
        """中文词 → 字段。同表优先，其次全库唯一命中；命中多个又不属于本表就放弃
        （多义的中文名反查回来必然是错的，宁可漏）。"""
        hits = self.cn_in.get(word) or []
        if not hits:
            return None
        if prefer_obj:
            same = [one for one in hits if _low(one[0]) == _low(prefer_obj)]
            if same:
                return same[0]
        # 去掉自我引用（口径里提到了字段自己的中文名，不算来源）
        others = [one for one in hits if not (prefer_obj and _low(one[0]) == _low(prefer_obj))]
        if len(others) == 1:
            return others[0]
        return None


def parse_refs(comment, index, self_obj=None, self_col=None):
    """抽注释里的「表.列」点号引用

    :return (sources, notes)
        sources: [{obj, col, expr, note}]   expr 固定为空 —— 注解里没有表达式
        notes:   [str]  值得告诉用户的疑点（引用了未纳管的表、列名对不上）
    """
    text = str(comment or '')
    sources, notes = [], []
    seen = set()
    for hit in _DOT_REF.finditer(text):
        table, col = hit.group(1), hit.group(2)
        if _low(table) in _NOT_TABLE:
            continue
        # 版本号 / 小数：`v1.5` 左边是 v1（数字结尾），不当表名
        if table[-1].isdigit() or col[0].isdigit():
            continue
        if not index.has_obj(table):
            # 保留了但标未纳管：跨库 / 没扫描的表，页面用灰字提示，不能当没有
            key = (_low(table), _low(col))
            if key in seen:
                continue
            seen.add(key)
            sources.append({'obj': table, 'col': col, 'expr': '', 'note': '注解引用的表不在设计态'})
            continue
        real_obj = index.real_obj(table)
        if not index.col_exists(real_obj, col):
            key = (_low(table), _low(col))
            if key in seen:
                continue
            seen.add(key)
            notes.append('注解写的是 %s.%s，但 %s 里没有这个字段（可能是笔误或旧版本）'
                         % (table, col, real_obj))
            continue
        real_col = index.real_col(real_obj, col)
        # 自引用（projectdirs.parentId 写「projectdirs.id」）是树形结构的合法来源，保留
        key = (_low(real_obj), _low(real_col))
        if key in seen:
            continue
        seen.add(key)
        sources.append({'obj': real_obj, 'col': real_col, 'expr': '', 'note': ''})
    return sources, notes


def parse_calc(comment, index, self_obj=None, self_col=None):
    """抽注释里的中文口径：`总费用=一般医疗服务费+一般操作治疗费+…`

    步骤：找 `=` 或 `>=`，取右侧；按 `+` 切成中文词；每个词当注释字典反查字段。
    只保留能唯一定位到的词，反查不到的记进 notes —— 让「口径里有 3 个词没对上」
    这件事在页面上看得见，而不是悄悄少了三条边。

    :return (sources, notes)
    """
    text = _flat(comment)
    if not text:
        return [], []
    m = re.search(r'[=≥>]=?', text)
    if not m:
        return [], []
    left = text[:m.start()]
    right = text[m.end():]
    if not left or not right:
        return [], []
    # 右侧必须真的是「加总」：至少出现一个 +，否则就是普通说明（`1=启用，0=停用`）
    if '+' not in right and '＋' not in right:
        return [], []
    if len(right) < 4:
        return [], []

    sources, notes, seen = [], [], set()
    miss = []
    for word in _CN_TOKEN.findall(right):
        if len(word) < 2:
            continue
        hit = index.lookup_cn(word, prefer_obj=self_obj)
        if not hit:
            miss.append(word)
            continue
        obj, col = hit
        key = (_low(obj), _low(col))
        if key in seen:
            continue
        # 口径里提到自己不算来源
        if self_obj and self_col and key == (_low(self_obj), _low(self_col)):
            continue
        seen.add(key)
        sources.append({'obj': obj, 'col': col, 'expr': '', 'note': ''})
    if sources and miss:
        notes.append('口径「%s」里 %d 个词没能反查到字段：%s'
                     % (left[:40], len(miss), '、'.join(miss[:6])))
    return sources, notes


def parse_column(comment, index, obj_name, col_name):
    """一个字段的注解 → 来源清单（点号引用在前，中文口径在后）

    :return {'sources': [{obj, col, note, origin, subType}], 'notes': [str], 'calc': str}
        origin: ref / calc，落库到 appschemalink.origin
        calc  : 口径原文（给页面显示「这个公式是从注释里认出来的」）
    """
    text = str(comment or '').strip()
    if not text:
        return {'sources': [], 'notes': [], 'calc': ''}

    refs, ref_notes = parse_refs(text, index, obj_name, col_name)
    calcs, calc_notes = parse_calc(text, index, obj_name, col_name)

    # 点号引用已经覆盖的字段，别再被中文口径重复加一遍（同一条边不要两个 origin）
    covered = {(_low(one['obj']), _low(one['col'])) for one in refs}
    out = []
    for one in refs:
        one = dict(one)
        one['origin'] = ORIGIN_REF
        # 注解没写表达式：自引用是树形父节点，算 IDENTITY；其余多半是外键搬运
        one['subType'] = 'IDENTITY' if _low(one['obj']) == _low(obj_name) else 'TRANSFORMATION'
        out.append(one)
    for one in calcs:
        key = (_low(one['obj']), _low(one['col']))
        if key in covered:
            continue
        one = dict(one)
        one['origin'] = ORIGIN_CALC
        one['subType'] = 'AGGREGATION'
        out.append(one)

    calc_text = ''
    flat = _flat(text)
    m = re.search(r'([^=≥>]{1,40})[=≥>]=?(.+)$', flat)
    if m and ('+' in m.group(2) or '＋' in m.group(2)):
        calc_text = flat[:200]

    return {'sources': out, 'notes': ref_notes + calc_notes, 'calc': calc_text}
