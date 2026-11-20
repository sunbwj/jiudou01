# -*- coding: utf-8 -*-
"""通用业务服务：菜单项与菜单组共用一套 CRUD 实现（与前端 api.js 的 createService 对称）"""
import base64
import datetime
import hashlib
import html as html_lib
import io
import json
import math
import os
import random
import re
import threading
import time
import traceback
import uuid
import zipfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

from db import DuplicateError, dump_row, execute, query_all, query_one, transaction
import config
import connector
import linkctx
import mail_client
import page_scan
import report_export
# 在线状态注册表（IM 实时性基础）：员工 empId -> 在线连接集合；仅依赖标准库，无循环依赖
from im_presence import dumps, presence

# 唯一索引冲突时的兜底提示（先查后写，此处仅兜底）
DEFAULT_DUP_MESSAGE = '记录已存在，请重新填写'


def notify_anchor(url, label=''):
    """通知里的可点击链接：IM 富文本与邮件 HTML 共用（URL 属性转义、label 文本转义）。"""
    safe_url = html_lib.escape(str(url or ''), quote=True)
    safe_label = html_lib.escape(str(label or url or ''))
    return '<a href="%s" target="_blank" rel="noopener">%s</a>' % (safe_url, safe_label)


def time_text(value):
    """数据库时间 → 'YYYY-MM-DD HH:MM:SS'；兼容 datetime / date / 已格式化字符串 / None。

    ⚠ dump_row() 已把 datetime 转成字符串，若对它的结果再调 .strftime() 就会抛
      AttributeError: 'str' object has no attribute 'strftime'（收件写入 lastSyncTime
      后，/api/empmail/status 与保存设置都曾因此 500）。统一走这里做幂等格式化。
    """
    if not value:
        return ''
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.strftime('%Y-%m-%d %H:%M:%S')
    return str(value)[:19]


from errors import BizError  # noqa: E402  业务异常（单独成模块，避免与 app_schema 循环 import）
from app_schema import app_info_service, app_schema_service  # noqa: E402  应用架构（应用信息 + 结构版本）


class CrudService(object):
    """
    :param table          表名
    :param label          业务名称（用于提示文案，如「菜单项」）
    :param fields         可写字段白名单
    :param bool_fields    需要以布尔形式输出的字段
    :param unique_fields  唯一性字段 [(字段, 中文名)]
    :param required       必填字段 [(字段, 中文名)]
    """

    # 列表默认排序（子类可覆写，如员工按工号升序）
    ORDER_BY = '`id` ASC'

    def __init__(self, table, label, fields, bool_fields=None,
                 unique_fields=None, required=None):
        self.table = table
        self.label = label
        self.fields = list(fields)
        self.bool_fields = list(bool_fields or [])
        self.unique_fields = list(unique_fields or [])
        self.required = list(required or [])

    # ---------------- 内部工具 ----------------
    @staticmethod
    def _to_bool(value):
        if value is None:
            return None
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        return str(value).strip().lower() in ('1', 'true', 'yes', 'on')

    @staticmethod
    def _to_int(value):
        return 1 if CrudService._to_bool(value) else 0

    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    def _serialize(self, row):
        data = dump_row(row)
        if not data:
            return None
        for field in self.bool_fields:
            if field in data:
                data[field] = self._to_bool(data[field])
        return data

    def _find_by_id(self, id_value):
        row = query_one('SELECT * FROM `%s` WHERE `id`=%%s' % self.table, (id_value,))
        if not row:
            raise BizError(self.label + '不存在或已被删除', 404)
        return row

    def _build_where(self, params):
        """检索条件：关键字（编号/中文名/英文名模糊匹配）+ 启用状态"""
        clauses = []
        args = []
        keyword = self._text(params.get('keyword'))
        if keyword:
            clauses.append('(`code` LIKE %s OR `nameCn` LIKE %s OR `nameEn` LIKE %s)')
            like = '%' + keyword + '%'
            args.extend([like, like, like])
        enabled = params.get('enabled')
        if enabled is not None and str(enabled).strip() != '':
            clauses.append('`enabled`=%s')
            args.append(self._to_int(enabled))
        where = (' WHERE ' + ' AND '.join(clauses)) if clauses else ''
        return where, args

    def _validate_unique(self, data, self_id=0):
        for field, name in self.unique_fields:
            value = self._text(data.get(field))
            if not value:
                continue
            row = query_one(
                'SELECT `id` FROM `%s` WHERE `%s`=%%s AND `id`<>%%s LIMIT 1' % (self.table, field),
                (value, self_id))
            if row:
                raise BizError(name + '已存在，请重新填写')

    def _validate_required(self, data):
        for field, name in self.required:
            if not self._text(data.get(field)):
                raise BizError(name + '不能为空')

    def _pick(self, data):
        """只保留白名单字段，并按类型归一化"""
        picked = {}
        for field in self.fields:
            if field not in data:
                continue
            value = data[field]
            if field in self.bool_fields:
                picked[field] = self._to_int(value)
            elif isinstance(value, str):
                picked[field] = value.strip()
            else:
                picked[field] = value
        return picked

    # ---------------- 对外业务方法 ----------------
    def page(self, params):
        where, args = self._build_where(params)
        try:
            page_num = int(params.get('pageNum') or 1)
            page_size = int(params.get('pageSize') or 10)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        if page_num < 1:
            page_num = 1
        if page_size < 1:
            page_size = 10
        if page_size > 200:
            page_size = 200

        total_row = query_one('SELECT COUNT(*) AS cnt FROM `%s`%s' % (self.table, where), args)
        total = int(total_row['cnt']) if total_row else 0
        pages = max(1, int(math.ceil(total * 1.0 / page_size)))
        if page_num > pages:
            page_num = pages

        rows = query_all(
            'SELECT * FROM `%s`%s ORDER BY %s LIMIT %%s OFFSET %%s' % (self.table, where, self.ORDER_BY),
            args + [page_size, (page_num - 1) * page_size])
        return {
            'list': [self._serialize(r) for r in rows],
            'total': total,
            'pageNum': page_num,
            'pageSize': page_size,
            'pages': pages,
        }

    def detail(self, params):
        try:
            id_value = int(params.get('id'))
        except (TypeError, ValueError):
            raise BizError('参数 id 不合法')
        return self._serialize(self._find_by_id(id_value))

    def check(self, params):
        field = self._text(params.get('field'))
        allowed = [f for f, _ in self.unique_fields]
        if field not in allowed:
            raise BizError('不支持的唯一性校验字段：' + field)
        value = self._text(params.get('value'))
        if not value:
            return {'unique': True}
        try:
            self_id = int(params.get('id') or 0)
        except (TypeError, ValueError):
            self_id = 0
        row = query_one(
            'SELECT `id` FROM `%s` WHERE `%s`=%%s AND `id`<>%%s LIMIT 1' % (self.table, field),
            (value, self_id))
        return {'unique': row is None}

    def add(self, data):
        self._validate_required(data)
        self._validate_unique(data)
        self.before_save(data, None)
        picked = self._pick(data)
        if not picked:
            raise BizError('没有可保存的字段')
        columns = ','.join('`%s`' % c for c in picked.keys())
        holders = ','.join(['%s'] * len(picked))
        try:
            new_id, _ = execute(
                'INSERT INTO `%s` (%s) VALUES (%s)' % (self.table, columns, holders),
                list(picked.values()))
        except DuplicateError:
            raise BizError(DEFAULT_DUP_MESSAGE)
        return self._serialize(query_one('SELECT * FROM `%s` WHERE `id`=%%s' % self.table, (new_id,)))

    def update(self, data):
        try:
            id_value = int(data.get('id'))
        except (TypeError, ValueError):
            raise BizError('参数 id 不合法')
        self._find_by_id(id_value)
        self._validate_required(data)
        self._validate_unique(data, id_value)
        self.before_save(data, id_value)
        picked = self._pick(data)
        if not picked:
            raise BizError('没有可更新的字段')
        assignments = ','.join('`%s`=%%s' % c for c in picked.keys())
        try:
            execute('UPDATE `%s` SET %s WHERE `id`=%%s' % (self.table, assignments),
                    list(picked.values()) + [id_value])
        except DuplicateError:
            raise BizError(DEFAULT_DUP_MESSAGE)
        return self._serialize(query_one('SELECT * FROM `%s` WHERE `id`=%%s' % self.table, (id_value,)))

    def delete(self, data):
        try:
            id_value = int(data.get('id'))
        except (TypeError, ValueError):
            raise BizError('参数 id 不合法')
        row = self._find_by_id(id_value)
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.table, (id_value,))
        return self._serialize(row)

    def before_save(self, data, id_value):
        """保存前的业务钩子，由子类覆写"""
        pass


class CodeMixin(object):
    """
    编号自动生成（菜单项 / 菜单组 / 部门共用）
      · 规则：CODE_PREFIX + CODE_DIGITS 位流水号，如 MNU00001 / MNG0001 / DPT0001
      · 取数：扫描库中符合「前缀 + N 位数字」的编号，取最大流水号 +1；库中没有该格式编号时从 1 开始
      · 上限：CODE_MAX，超出即提示；并发写入导致冲突时自动顺延
    """

    CODE_PREFIX = ''
    CODE_DIGITS = 5
    CODE_MAX = 99999

    def _format_code(self, seq):
        return '%s%0*d' % (self.CODE_PREFIX, self.CODE_DIGITS, seq)

    def next_code(self, params=None):
        pattern = '^%s[0-9]{%d}$' % (self.CODE_PREFIX, self.CODE_DIGITS)
        rows = query_all('SELECT `code` FROM `%s` WHERE `code` REGEXP %%s' % self.table, (pattern,))
        max_seq = 0
        for row in rows:
            code = self._text(row.get('code'))
            try:
                seq = int(code[len(self.CODE_PREFIX):])
            except (TypeError, ValueError):
                continue
            if seq > max_seq:
                max_seq = seq

        seq = max_seq + 1
        limit = self.CODE_MAX
        while seq <= limit:
            code = self._format_code(seq)
            row = query_one('SELECT `id` FROM `%s` WHERE `code`=%%s LIMIT 1' % self.table, (code,))
            if not row:
                return {'code': code}
            seq += 1        # 并发写入兜底：编号被占用则顺延
        raise BizError('编号已超出上限（%s），请联系管理员' % self._format_code(limit))


class MenuService(CodeMixin, CrudService):
    """
    菜单项：在通用 CRUD 之上增加「编号自动生成」（MNU + 5 位流水号，实现见 CodeMixin）
      · 显示序号 sortNo：0-9999 整数，查询结果列表按「显示序号升序（同序号按 id）」输出
    """

    CODE_PREFIX = 'MNU'
    CODE_DIGITS = 5
    CODE_MAX = 99999

    # 查询结果默认排序：显示序号升序，同序号按 id 升序（保证分页顺序稳定）
    ORDER_BY = '`sortNo` ASC, `id` ASC'

    MAX_SORT_NO = 9999

    def before_save(self, data, id_value):
        """显示序号归一化：空 → 0；非法 → 0；越界拒绝"""
        if 'sortNo' in data:
            raw = data.get('sortNo')
            try:
                sort_no = int(raw) if str(raw).strip() != '' else 0
            except (TypeError, ValueError):
                raise BizError('显示序号必须是整数')
            if sort_no < 0 or sort_no > self.MAX_SORT_NO:
                raise BizError('显示序号为 0-%d 之间的整数' % self.MAX_SORT_NO)
            data['sortNo'] = sort_no


class GroupService(CodeMixin, CrudService):
    """
    菜单组：在通用 CRUD 之上增加「多层级」与「编号自动生成（MNG + 4 位流水号）」能力
      · parentId = 0 表示顶级；level 由 parentId 自动推导（1 级起，最多 MAX_LEVEL 级）
      · 保存时校验：上级必须存在、不能是自身、不能是自己的下级（防环）、不超过最大层级
      · 可否绑定菜单项（hasChild）：无默认值，需显式选择；选「是」时清空功能页面路径，选「否」时路径非必填
      · 已有下级菜单组记录时强制为「是」
      · 查询：结果列表按「菜单组层级」加载——父 → 子深度优先（同级按排序号升序、同序号按 id）；
        检索命中行的高级不在结果批次内时该行作为局部根，仍保持父前子后；层级下拉 /tree 同为树形顺序
      · 删除：存在下级时默认拒绝，cascade=1 时可级联删除整棵子树
    """

    MAX_LEVEL = 5

    # 编号自动生成：MNG + 4 位流水号（如 MNG0001），实现见 CodeMixin
    CODE_PREFIX = 'MNG'
    CODE_DIGITS = 4
    CODE_MAX = 9999

    # ---------------- 层级工具 ----------------
    def _load_all(self):
        return query_all('SELECT * FROM `%s` ORDER BY `sortNo` ASC, `id` ASC' % self.table)

    def _child_count_map(self, rows):
        counts = {}
        for r in rows:
            pid = int(r['parentId'])
            counts[pid] = counts.get(pid, 0) + 1
        return counts

    def _descendant_ids(self, root_id, rows=None):
        """全部后代（子、孙…）ID 列表"""
        rows = self._load_all() if rows is None else rows
        result = []
        stack = [int(root_id)]
        while stack:
            cur = stack.pop()
            for r in rows:
                if int(r['parentId']) == cur:
                    cid = int(r['id'])
                    if cid not in result:
                        result.append(cid)
                        stack.append(cid)
        return result

    def _sorted_forest(self, rows):
        """把一批行按「父 → 子」的深度优先顺序展开；父不在批次内时该行作为局部根"""
        id_set = set(int(r['id']) for r in rows)
        by_parent = {}
        for r in rows:
            by_parent.setdefault(int(r['parentId']), []).append(r)
        for lst in by_parent.values():
            lst.sort(key=lambda x: (int(x['sortNo']), int(x['id'])))

        ordered = []

        def walk(node):
            ordered.append(node)
            for child in by_parent.get(int(node['id']), []):
                walk(child)

        for r in sorted([x for x in rows if int(x['parentId']) not in id_set],
                        key=lambda x: (int(x['sortNo']), int(x['id']))):
            walk(r)
        return ordered

    def _decorate(self, row, name_map, child_counts):
        """补充层级展示字段：上级名称、下级数量、层级全路径"""
        data = self._serialize(row)
        if not data:
            return None
        pid = int(row['parentId'])
        data['level'] = int(row['level'])
        data['parentName'] = name_map.get(pid, '')
        data['childCount'] = child_counts.get(int(row['id']), 0)
        chain = []
        cur = pid
        guard = 0
        while cur and cur in name_map and guard < self.MAX_LEVEL + 2:
            chain.insert(0, name_map[cur])
            cur = self._parent_map.get(cur, 0)
            guard += 1
        data['pathNames'] = ' / '.join(chain)
        return data

    # ---------------- 业务方法覆写 ----------------
    def page(self, params):
        rows = self._load_all()
        self._parent_map = dict((int(r['id']), int(r['parentId'])) for r in rows)
        name_map = dict((int(r['id']), r['nameCn']) for r in rows)
        child_counts = self._child_count_map(rows)

        keyword = self._text(params.get('keyword')).lower()
        enabled = params.get('enabled')
        parent_param = params.get('parentId')

        filtered = []
        for r in rows:
            if keyword and keyword not in ('%s %s %s' % (r['code'], r['nameCn'], r['nameEn'])).lower():
                continue
            if enabled is not None and str(enabled).strip() != '' and int(r['enabled']) != self._to_int(enabled):
                continue
            filtered.append(r)

        # parentId：只看该菜单组的下级（含所有层级）
        if parent_param is not None and str(parent_param).strip() != '' and str(parent_param).strip() != '0':
            try:
                root_id = int(parent_param)
            except (TypeError, ValueError):
                root_id = 0
            if root_id:
                keep = set(self._descendant_ids(root_id, rows))
                filtered = [r for r in filtered if int(r['id']) in keep]

        # 查询结果按「菜单组层级」加载：父 → 子深度优先（_sorted_forest 内同级按排序号升序、
        # 同序号按 id 升序；高级不在批次内的命中行作为局部根）；层级下拉 /tree 同为树形顺序
        ordered = self._sorted_forest(filtered)

        try:
            page_num = int(params.get('pageNum') or 1)
            page_size = int(params.get('pageSize') or 10)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        if page_num < 1:
            page_num = 1
        if page_size < 1:
            page_size = 10
        if page_size > 200:
            page_size = 200

        total = len(ordered)
        pages = max(1, int(math.ceil(total * 1.0 / page_size)))
        if page_num > pages:
            page_num = pages
        start = (page_num - 1) * page_size
        slice_rows = ordered[start:start + page_size]
        return {
            'list': [self._decorate(r, name_map, child_counts) for r in slice_rows],
            'total': total,
            'pageNum': page_num,
            'pageSize': page_size,
            'pages': pages,
        }

    def detail(self, params):
        try:
            id_value = int(params.get('id'))
        except (TypeError, ValueError):
            raise BizError('参数 id 不合法')
        row = self._find_by_id(id_value)
        rows = self._load_all()
        self._parent_map = dict((int(r['id']), int(r['parentId'])) for r in rows)
        name_map = dict((int(r['id']), r['nameCn']) for r in rows)
        child_counts = self._child_count_map(rows)
        return self._decorate(row, name_map, child_counts)

    def tree(self, params):
        """层级下拉数据：按树形顺序返回，label 已带缩进；excludeId 用于编辑时排除自身及后代
        可选过滤：enabled=1/0（启用状态）、keyword（编号 / 中文名 / 英文名，命中节点会保留其祖先链）"""
        rows = self._load_all()

        enabled = params.get('enabled')
        if enabled is not None and str(enabled).strip() != '':
            rows = [r for r in rows if int(r['enabled']) == self._to_int(enabled)]

        keyword = self._text(params.get('keyword')).lower()
        # 关键字过滤前先统计下级数量：保证 leaf（是否叶子节点）不受检索结果裁剪影响
        leaf_counts = self._child_count_map(rows)
        if keyword:
            parent_map = dict((int(r['id']), int(r['parentId'])) for r in rows)
            hit = []
            for r in rows:
                if keyword in ('%s %s %s' % (r['code'], r['nameCn'], r['nameEn'])).lower():
                    hit.append(int(r['id']))
            keep = set(hit)
            # 命中节点的祖先一并保留，否则树会断链
            for rid in hit:
                cur = parent_map.get(rid, 0)
                guard = 0
                while cur and guard < self.MAX_LEVEL + 2:
                    keep.add(cur)
                    cur = parent_map.get(cur, 0)
                    guard += 1
            rows = [r for r in rows if int(r['id']) in keep]

        name_map = dict((int(r['id']), r['nameCn']) for r in rows)
        child_counts = self._child_count_map(rows)
        try:
            exclude_id = int(params.get('excludeId') or 0)
        except (TypeError, ValueError):
            exclude_id = 0
        banned = set()
        if exclude_id:
            banned.add(exclude_id)
            banned.update(self._descendant_ids(exclude_id, rows))

        out = []
        for r in self._sorted_forest(rows):
            rid = int(r['id'])
            if rid in banned:
                continue
            level = int(r['level'])
            indent = ('　' * (level - 1)) + ('└ ' if level > 1 else '')
            out.append({
                'id': rid,
                'parentId': int(r['parentId']),
                'level': level,
                'code': r['code'],
                'nameCn': r['nameCn'],
                'nameEn': r['nameEn'],
                'childCount': child_counts.get(rid, 0),
                'hasChild': self._to_bool(r['hasChild']),
                'leaf': leaf_counts.get(rid, 0) == 0,     # 无下级菜单组（按启用过滤后的全量数据判定）
                'label': indent + r['nameCn'] + '（' + r['code'] + '）',
            })
        return {'list': out}

    def before_save(self, data, id_value):
        # 1) 上级菜单组校验 + 层级推导
        try:
            parent_id = int(data.get('parentId') or 0)
        except (TypeError, ValueError):
            parent_id = 0
        if parent_id < 0:
            parent_id = 0
        level = 1
        if parent_id:
            if id_value and parent_id == id_value:
                raise BizError('上级菜单组不能是自身')
            parent = query_one('SELECT `id`,`level`,`nameCn` FROM `%s` WHERE `id`=%%s' % self.table, (parent_id,))
            if not parent:
                raise BizError('上级菜单组不存在或已被删除')
            level = int(parent['level']) + 1
            if level > self.MAX_LEVEL:
                raise BizError('最多支持 %d 级菜单组，当前已是第 %d 级' % (self.MAX_LEVEL, level))
            if id_value and parent_id in self._descendant_ids(id_value):
                raise BizError('不能把菜单组移动到自己的下级菜单组之下')
        try:
            sort_no = int(data.get('sortNo') or 0)
        except (TypeError, ValueError):
            sort_no = 0
        data['parentId'] = parent_id
        data['level'] = level
        data['sortNo'] = sort_no

        # 2) 可否绑定菜单项：已存在下级记录时强制为「是」，避免与层级数据矛盾
        child_count = 0
        if id_value:
            row = query_one('SELECT COUNT(*) AS cnt FROM `%s` WHERE `parentId`=%%s' % self.table, (id_value,))
            child_count = int(row['cnt']) if row else 0
        if child_count:
            data['hasChild'] = 1

        # 3) 可否绑定菜单项：选「是」时不需要功能页面路径并清空；选「否」时路径可选（非必填）
        has_child = self._to_bool(data.get('hasChild'))
        if has_child:
            data['path'] = ''
        else:
            data['path'] = self._text(data.get('path'))

    def add(self, data):
        result = super(GroupService, self).add(data)
        parent_id = int(result.get('parentId') or 0)
        # 挂到某个上级之下后，上级必然「可绑定菜单项（是）」
        if parent_id:
            execute('UPDATE `%s` SET `hasChild`=1 WHERE `id`=%%s AND `hasChild`=0' % self.table, (parent_id,))
        return result

    def update(self, data):
        result = super(GroupService, self).update(data)
        self._sync_descendant_levels(int(result['id']))
        return result

    def _sync_descendant_levels(self, root_id):
        """上级变更后，逐层刷新子孙的 level"""
        rows = self._load_all()
        level_map = dict((int(r['id']), int(r['level'])) for r in rows)
        stack = [root_id]
        while stack:
            cur = stack.pop()
            cur_level = level_map.get(cur, 1)
            for r in rows:
                if int(r['parentId']) == cur:
                    cid = int(r['id'])
                    new_level = cur_level + 1
                    if int(r['level']) != new_level:
                        execute('UPDATE `%s` SET `level`=%%s WHERE `id`=%%s' % self.table, (new_level, cid))
                    level_map[cid] = new_level
                    stack.append(cid)

    def delete(self, data):
        try:
            id_value = int(data.get('id'))
        except (TypeError, ValueError):
            raise BizError('参数 id 不合法')
        row = self._find_by_id(id_value)
        rows = self._load_all()
        direct = [r for r in rows if int(r['parentId']) == id_value]
        descendants = self._descendant_ids(id_value, rows)
        if descendants and not self._to_bool(data.get('cascade')):
            raise BizError('该菜单组下还有 %d 个下级菜单组（共 %d 个后代），请先删除下级，或勾选级联删除'
                           % (len(direct), len(descendants)))
        if descendants:
            holders = ','.join(['%s'] * len(descendants))
            execute('DELETE FROM `%s` WHERE `id` IN (%s)' % (self.table, holders), descendants)
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.table, (id_value,))
        return self._serialize(row)


class GroupItemService(CrudService):
    """
    菜单组项目设置：菜单组（menugroupinfos）↔ 菜单项（menuinfros）的关联与组内显示序号
      · 查询 page：必须指定 groupId；只返回「启用状态」的菜单项（页面要求）
      · 新增 add：批量追加，已存在的关联只更新显示序号（幂等，不会重复插入）
      · 编辑 update：按提交结果全量同步 —— 新增勾选的、更新序号、移除未勾选的
      · 删除 delete：按关联记录 ID 删除单条
    """

    ITEM_TABLE = 'menuinfros'
    GROUP_TABLE = 'menugroupinfos'
    MAX_SORT_NO = 9999

    # ---------------- SQL ----------------
    def _join_sql(self):
        """关联查询：设置记录 + 菜单项信息 + 菜单组信息"""
        return (
            'SELECT s.*, m.`code` AS itemCode, m.`nameCn` AS itemNameCn, m.`nameEn` AS itemNameEn, '
            'm.`path` AS itemPath, m.`icon` AS itemIcon, m.`enabled` AS itemEnabled, '
            'm.`remark` AS itemRemark, g.`code` AS groupCode, g.`nameCn` AS groupNameCn '
            'FROM `%s` s '
            'INNER JOIN `%s` m ON m.`id`=s.`itemId` '
            'LEFT JOIN `%s` g ON g.`id`=s.`groupId`'
            % (self.table, self.ITEM_TABLE, self.GROUP_TABLE))

    def _serialize(self, row):
        data = super(GroupItemService, self)._serialize(row)
        if data and 'itemEnabled' in data:
            data['itemEnabled'] = self._to_bool(data['itemEnabled'])
        return data

    # ---------------- 参数解析 ----------------
    @staticmethod
    def _group_id(params, allow_zero=False):
        try:
            gid = int(params.get('groupId'))
        except (TypeError, ValueError):
            gid = 0
        if gid < 0:
            gid = 0
        if not gid and not allow_zero:
            raise BizError('请先选择菜单组')
        return gid

    def _check_group(self, group_id):
        row = query_one('SELECT `id`,`code`,`nameCn` FROM `%s` WHERE `id`=%%s' % self.GROUP_TABLE, (group_id,))
        if not row:
            raise BizError('菜单组不存在或已被删除')
        return row

    def _parse_items(self, data):
        """把提交的菜单项解析为 [(itemId, sortNo)]；支持 items 数组或 itemIds 逗号串"""
        raw = data.get('items')
        pairs = []
        if isinstance(raw, list):
            for one in raw:
                if not isinstance(one, dict):
                    continue
                try:
                    item_id = int(one.get('itemId'))
                except (TypeError, ValueError):
                    continue
                if item_id <= 0:
                    continue
                try:
                    sort_no = int(one.get('sortNo') or 0)
                except (TypeError, ValueError):
                    raise BizError('显示序号必须是整数')
                if sort_no < 0 or sort_no > self.MAX_SORT_NO:
                    raise BizError('显示序号为 0-%d 之间的整数' % self.MAX_SORT_NO)
                pairs.append((item_id, sort_no))
        else:
            raw_ids = self._text(data.get('itemIds'))
            if raw_ids:
                for part in raw_ids.split(','):
                    part = part.strip()
                    if not part:
                        continue
                    try:
                        item_id = int(part)
                    except (TypeError, ValueError):
                        continue
                    if item_id > 0:
                        pairs.append((item_id, 0))
        # 同一个菜单项重复提交时以最后一次为准
        uniq = {}
        ordered = []
        for item_id, sort_no in pairs:
            if item_id not in uniq:
                ordered.append(item_id)
            uniq[item_id] = sort_no
        return [(i, uniq[i]) for i in ordered]

    def _valid_items(self, pairs):
        """校验菜单项存在且处于启用状态"""
        for item_id, _ in pairs:
            row = query_one('SELECT `id`,`nameCn`,`enabled` FROM `%s` WHERE `id`=%%s' % self.ITEM_TABLE, (item_id,))
            if not row:
                raise BizError('菜单项不存在或已被删除：ID=%s' % item_id)
            if not self._to_bool(row['enabled']):
                raise BizError('菜单项【%s】已停用，不能加入菜单组' % row['nameCn'])

    def _existing_map(self, group_id):
        rows = query_all('SELECT `id`,`itemId`,`sortNo` FROM `%s` WHERE `groupId`=%%s' % self.table, (group_id,))
        return dict((int(r['itemId']), r) for r in rows)

    def _current_list(self, group_id):
        rows = query_all(self._join_sql() + ' WHERE s.`groupId`=%s AND m.`enabled`=1 '
                                            'ORDER BY s.`sortNo` ASC, s.`id` ASC', (group_id,))
        return [self._serialize(r) for r in rows]

    # ---------------- 业务方法 ----------------
    def page(self, params):
        group_id = self._group_id(params)
        clauses = ['s.`groupId`=%s', 'm.`enabled`=1']     # 页面要求：只展示启用状态的菜单项
        args = [group_id]
        keyword = self._text(params.get('keyword'))
        if keyword:
            clauses.append('(m.`code` LIKE %s OR m.`nameCn` LIKE %s OR m.`nameEn` LIKE %s)')
            like = '%' + keyword + '%'
            args.extend([like, like, like])
        where = ' WHERE ' + ' AND '.join(clauses)

        try:
            page_num = int(params.get('pageNum') or 1)
            page_size = int(params.get('pageSize') or 10)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        if page_num < 1:
            page_num = 1
        if page_size < 1:
            page_size = 10
        if page_size > 200:
            page_size = 200

        total_row = query_one('SELECT COUNT(*) AS cnt FROM `%s` s INNER JOIN `%s` m ON m.`id`=s.`itemId`%s'
                              % (self.table, self.ITEM_TABLE, where), args)
        total = int(total_row['cnt']) if total_row else 0
        pages = max(1, int(math.ceil(total * 1.0 / page_size)))
        if page_num > pages:
            page_num = pages

        rows = query_all(self._join_sql() + where + ' ORDER BY s.`sortNo` ASC, s.`id` ASC '
                                                    'LIMIT %s OFFSET %s',
                         args + [page_size, (page_num - 1) * page_size])
        return {
            'list': [self._serialize(r) for r in rows],
            'total': total,
            'pageNum': page_num,
            'pageSize': page_size,
            'pages': pages,
            'groupId': group_id,
        }

    def detail(self, params):
        try:
            id_value = int(params.get('id'))
        except (TypeError, ValueError):
            raise BizError('参数 id 不合法')
        row = query_one(self._join_sql() + ' WHERE s.`id`=%s', (id_value,))
        if not row:
            raise BizError('菜单组项目不存在或已被删除', 404)
        return self._serialize(row)

    def add(self, data):
        """批量追加：已存在的关联只更新显示序号"""
        group_id = self._group_id(data)
        self._check_group(group_id)
        pairs = self._parse_items(data)
        if not pairs:
            raise BizError('请至少选择一个菜单项')
        self._valid_items(pairs)

        exists = self._existing_map(group_id)
        added = updated = 0
        for item_id, sort_no in pairs:
            if item_id in exists:
                if int(exists[item_id]['sortNo']) != sort_no:
                    execute('UPDATE `%s` SET `sortNo`=%%s WHERE `id`=%%s' % self.table,
                            (sort_no, int(exists[item_id]['id'])))
                    updated += 1
            else:
                execute('INSERT INTO `%s` (`groupId`,`itemId`,`sortNo`,`enabled`) VALUES (%%s,%%s,%%s,1)'
                        % self.table, (group_id, item_id, sort_no))
                added += 1
        return {
            'groupId': group_id, 'added': added, 'updated': updated, 'removed': 0,
            'list': self._current_list(group_id)
        }

    def update(self, data):
        """全量同步：以提交结果为准，新增勾选的、更新序号、移除未勾选的"""
        group_id = self._group_id(data)
        self._check_group(group_id)
        pairs = self._parse_items(data)
        self._valid_items(pairs)

        exists = self._existing_map(group_id)
        wanted = dict(pairs)
        added = updated = removed = 0
        for item_id, sort_no in pairs:
            if item_id in exists:
                if int(exists[item_id]['sortNo']) != sort_no:
                    execute('UPDATE `%s` SET `sortNo`=%%s WHERE `id`=%%s' % self.table,
                            (sort_no, int(exists[item_id]['id'])))
                    updated += 1
            else:
                execute('INSERT INTO `%s` (`groupId`,`itemId`,`sortNo`,`enabled`) VALUES (%%s,%%s,%%s,1)'
                        % self.table, (group_id, item_id, sort_no))
                added += 1
        drop_ids = [int(exists[i]['id']) for i in exists if i not in wanted]
        if drop_ids:
            holders = ','.join(['%s'] * len(drop_ids))
            execute('DELETE FROM `%s` WHERE `id` IN (%s)' % (self.table, holders), drop_ids)
            removed = len(drop_ids)
        return {
            'groupId': group_id, 'added': added, 'updated': updated, 'removed': removed,
            'list': self._current_list(group_id)
        }

    def delete(self, data):
        try:
            id_value = int(data.get('id'))
        except (TypeError, ValueError):
            raise BizError('参数 id 不合法')
        row = query_one(self._join_sql() + ' WHERE s.`id`=%s', (id_value,))
        if not row:
            raise BizError('菜单组项目不存在或已被删除', 404)
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.table, (id_value,))
        return self._serialize(row)


MENU_FIELDS = ['icon', 'sortNo', 'code', 'nameCn', 'nameEn', 'path', 'enabled', 'remark']
GROUP_FIELDS = ['parentId', 'level', 'sortNo', 'icon', 'code', 'nameCn', 'nameEn', 'hasChild', 'path', 'enabled']
GROUP_ITEM_FIELDS = ['groupId', 'itemId', 'sortNo', 'enabled', 'remark']
ORG_FIELDS = ['parentId', 'level', 'sortNo', 'code', 'nameCn', 'duty', 'enabled']


class OrgService(CodeMixin, CrudService):
    """
    部门组织架构（OrganizationStructure）：多层级 + 编号自动生成
      · 编号：DPT + 4 位流水号（如 DPT0001），新增页由 /api/org/nextcode 预取，全局唯一
      · 层级：parentId = 0 表示顶级；level 由 parentId 自动推导（1 级起，最多 MAX_LEVEL 级）
      · 保存校验：上级必须存在、不能是自身、不能是自己的下级（防环）、不超过最大层级
      · 查询：默认按树形（父 → 子）深度优先顺序输出；关键字检索只返回命中记录
      · 停用 / 删除保护：后代中存在「启用状态」的部门时，不允许停用或删除本部门
      · 删除：存在下级部门时默认拒绝，cascade=1 时级联删除整棵子树
    """

    MAX_LEVEL = 5
    CODE_PREFIX = 'DPT'
    CODE_DIGITS = 4
    CODE_MAX = 9999

    # ---------------- 层级工具 ----------------
    def _load_all(self):
        return query_all('SELECT * FROM `%s` ORDER BY `sortNo` ASC, `id` ASC' % self.table)

    @staticmethod
    def _child_count_map(rows):
        counts = {}
        for r in rows:
            pid = int(r['parentId'])
            counts[pid] = counts.get(pid, 0) + 1
        return counts

    def _descendant_ids(self, root_id, rows=None):
        """全部后代（子、孙…）ID 列表"""
        rows = self._load_all() if rows is None else rows
        result = []
        stack = [int(root_id)]
        while stack:
            cur = stack.pop()
            for r in rows:
                if int(r['parentId']) == cur:
                    cid = int(r['id'])
                    if cid not in result:
                        result.append(cid)
                        stack.append(cid)
        return result

    def _enabled_descendants(self, root_id, rows=None):
        """后代中处于「启用状态」的部门（子、孙…；停用的下级仍继续向下检查）"""
        rows = self._load_all() if rows is None else rows
        root_id = int(root_id)
        by_parent = {}
        for r in rows:
            by_parent.setdefault(int(r['parentId']), []).append(r)
        out = []
        stack = [root_id]
        while stack:
            cur = stack.pop()
            for r in by_parent.get(cur, []):
                cid = int(r['id'])
                if cid == root_id:
                    continue
                if int(r['enabled']):
                    out.append(r)
                stack.append(cid)
        return out

    def _assert_no_enabled_children(self, root_id, action, rows=None):
        """停用 / 删除保护：后代里还有启用状态的部门时直接拒绝"""
        kids = self._enabled_descendants(root_id, rows)
        if not kids:
            return
        names = '、'.join([k['nameCn'] for k in kids[:3]])
        raise BizError('该部门下还有 %d 个启用状态的下级部门（%s%s），请先停用这些下级部门后再%s'
                       % (len(kids), names, '等' if len(kids) > 3 else '', action))

    @staticmethod
    def _sorted_forest(rows):
        """把一批行按「父 → 子」的深度优先顺序展开；父不在批次内时该行作为局部根"""
        id_set = set(int(r['id']) for r in rows)
        by_parent = {}
        for r in rows:
            by_parent.setdefault(int(r['parentId']), []).append(r)
        for lst in by_parent.values():
            lst.sort(key=lambda x: (int(x['sortNo']), int(x['id'])))

        ordered = []

        def walk(node):
            ordered.append(node)
            for child in by_parent.get(int(node['id']), []):
                walk(child)

        for r in sorted([x for x in rows if int(x['parentId']) not in id_set],
                        key=lambda x: (int(x['sortNo']), int(x['id']))):
            walk(r)
        return ordered

    # ---------------- 部门负责人（dptmgrset ↔ empinfos） ----------------
    @staticmethod
    def _load_manager_map():
        """部门ID → 负责人信息（deptId 唯一，一个部门最多一条）"""
        rows = query_all(
            'SELECT s.`deptId`, s.`empId`, s.`remark`, e.`code`, e.`nameCn`, e.`jobTitle`, e.`status` '
            'FROM `dptmgrset` s LEFT JOIN `empinfos` e ON e.`id` = s.`empId`')
        return dict((int(r['deptId']), r) for r in rows)

    def _manager_of(self, dept_id):
        """取某部门的负责人；未设置返回 {}。按请求维度缓存，避免逐行查库"""
        mmap = getattr(self, '_mgr_map', None)
        if mmap is None:
            mmap = self._load_manager_map()
            self._mgr_map = mmap
        return mmap.get(int(dept_id)) or {}

    def _decorate(self, row, name_map, child_counts):
        """补充层级展示字段：上级名称、下级数量、层级全路径，以及「部门负责人」信息"""
        data = self._serialize(row)
        if not data:
            return None
        pid = int(row['parentId'])
        data['level'] = int(row['level'])
        data['parentName'] = name_map.get(pid, '')
        data['childCount'] = child_counts.get(int(row['id']), 0)
        chain = []
        cur = pid
        guard = 0
        while cur and cur in name_map and guard < self.MAX_LEVEL + 2:
            chain.insert(0, name_map[cur])
            cur = self._parent_map.get(cur, 0)
            guard += 1
        data['pathNames'] = ' / '.join(chain)

        # 部门负责人（dptmgrset ↔ empinfos）：一个部门最多一条，未设置时为空
        mgr = self._manager_of(row['id'])
        data['managerId'] = int(mgr['empId']) if mgr else 0
        data['managerName'] = (mgr.get('nameCn') or '') if mgr else ''
        data['managerCode'] = (mgr.get('code') or '') if mgr else ''
        data['managerJob'] = (mgr.get('jobTitle') or '') if mgr else ''
        data['managerStatus'] = int(mgr['status']) if (mgr and mgr.get('status') is not None) else -1
        return data

    # ---------------- 检索 / 查询 ----------------
    def _build_where(self, params):
        """部门没有英文名字段：关键字按 编号 / 部门名称 / 职能说明 模糊匹配"""
        clauses = []
        args = []
        keyword = self._text(params.get('keyword'))
        if keyword:
            clauses.append('(`code` LIKE %s OR `nameCn` LIKE %s OR `duty` LIKE %s)')
            like = '%' + keyword + '%'
            args.extend([like, like, like])
        enabled = params.get('enabled')
        if enabled is not None and str(enabled).strip() != '':
            clauses.append('`enabled`=%s')
            args.append(self._to_int(enabled))
        where = (' WHERE ' + ' AND '.join(clauses)) if clauses else ''
        return where, args

    def _refresh_maps(self, rows):
        self._parent_map = dict((int(r['id']), int(r['parentId'])) for r in rows)
        return dict((int(r['id']), r['nameCn']) for r in rows)

    def page(self, params):
        rows = self._load_all()
        self._mgr_map = self._load_manager_map()
        name_map = self._refresh_maps(rows)
        child_counts = self._child_count_map(rows)

        keyword = self._text(params.get('keyword')).lower()
        enabled = params.get('enabled')

        filtered = []
        for r in rows:
            if keyword and keyword not in ('%s %s %s' % (r['code'], r['nameCn'], r['duty'] or '')).lower():
                continue
            if enabled is not None and str(enabled).strip() != '' and int(r['enabled']) != self._to_int(enabled):
                continue
            filtered.append(r)

        # 无检索条件 → 树形顺序（父紧跟子）；有检索条件 → 按层级排序，只看命中记录
        if keyword:
            ordered = sorted(filtered, key=lambda x: (int(x['level']), int(x['sortNo']), int(x['id'])))
        else:
            ordered = self._sorted_forest(filtered)

        try:
            page_num = int(params.get('pageNum') or 1)
            page_size = int(params.get('pageSize') or 10)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        if page_num < 1:
            page_num = 1
        if page_size < 1:
            page_size = 10
        if page_size > 200:
            page_size = 200

        total = len(ordered)
        pages = max(1, int(math.ceil(total * 1.0 / page_size)))
        if page_num > pages:
            page_num = pages
        start = (page_num - 1) * page_size
        slice_rows = ordered[start:start + page_size]
        return {
            'list': [self._decorate(r, name_map, child_counts) for r in slice_rows],
            'total': total,
            'pageNum': page_num,
            'pageSize': page_size,
            'pages': pages,
        }

    def detail(self, params):
        try:
            id_value = int(params.get('id'))
        except (TypeError, ValueError):
            raise BizError('参数 id 不合法')
        row = self._find_by_id(id_value)
        rows = self._load_all()
        self._mgr_map = self._load_manager_map()
        name_map = self._refresh_maps(rows)
        return self._decorate(row, name_map, self._child_count_map(rows))

    def tree(self, params):
        """层级下拉数据（上级部门选择）：excludeId 用于编辑时排除自身及后代"""
        rows = self._load_all()
        self._mgr_map = self._load_manager_map()
        enabled = params.get('enabled')
        if enabled is not None and str(enabled).strip() != '':
            rows = [r for r in rows if int(r['enabled']) == self._to_int(enabled)]
        try:
            exclude_id = int(params.get('excludeId') or 0)
        except (TypeError, ValueError):
            exclude_id = 0
        banned = set()
        if exclude_id:
            banned.add(exclude_id)
            banned.update(self._descendant_ids(exclude_id, rows))

        child_counts = self._child_count_map(rows)
        out = [{'id': 0, 'parentId': 0, 'level': 0, 'code': '', 'nameCn': '（顶级部门）',
                'childCount': child_counts.get(0, 0), 'leaf': True, 'label': '（顶级部门，无上级）'}]
        for r in self._sorted_forest(rows):
            rid = int(r['id'])
            if rid in banned:
                continue
            level = int(r['level'])
            indent = ('　' * (level - 1)) + ('└ ' if level > 1 else '')
            out.append({
                'id': rid,
                'parentId': int(r['parentId']),
                'level': level,
                'code': r['code'],
                'nameCn': r['nameCn'],
                'childCount': child_counts.get(rid, 0),
                'leaf': child_counts.get(rid, 0) == 0,
                'managerName': (self._manager_of(rid).get('nameCn') or ''),
                'label': indent + r['nameCn'] + '（' + r['code'] + '）',
            })
        return {'list': out}

    # ---------------- 保存 ----------------
    def before_save(self, data, id_value):
        try:
            parent_id = int(data.get('parentId') or 0)
        except (TypeError, ValueError):
            parent_id = 0
        if parent_id < 0:
            parent_id = 0
        level = 1
        if parent_id:
            if id_value and parent_id == id_value:
                raise BizError('上级部门不能是自身')
            parent = query_one('SELECT `id`,`level`,`nameCn` FROM `%s` WHERE `id`=%%s' % self.table, (parent_id,))
            if not parent:
                raise BizError('上级部门不存在或已被删除')
            level = int(parent['level']) + 1
            if level > self.MAX_LEVEL:
                raise BizError('最多支持 %d 级部门，当前已是第 %d 级' % (self.MAX_LEVEL, level))
            if id_value and parent_id in self._descendant_ids(id_value):
                raise BizError('不能把部门移动到自己的下级部门之下')
        # 停用保护：后代中还有启用状态的部门时不允许停用本部门
        if id_value and 'enabled' in data and self._to_int(data.get('enabled')) == 0:
            self._assert_no_enabled_children(id_value, '停用本部门')
        try:
            sort_no = int(data.get('sortNo') or 0)
        except (TypeError, ValueError):
            sort_no = 0
        data['parentId'] = parent_id
        data['level'] = level
        data['sortNo'] = sort_no
        data['duty'] = self._text(data.get('duty'))
        # 编号为空时按 DPT + 4 位流水号兜底生成（正常由前端预取后提交）
        if not self._text(data.get('code')):
            data['code'] = self.next_code()['code']

    def update(self, data):
        result = super(OrgService, self).update(data)
        self._sync_descendant_levels(int(result['id']))
        return result

    def _sync_descendant_levels(self, root_id):
        """上级变更后，逐层刷新子孙的 level"""
        rows = self._load_all()
        level_map = dict((int(r['id']), int(r['level'])) for r in rows)
        stack = [root_id]
        while stack:
            cur = stack.pop()
            cur_level = level_map.get(cur, 1)
            for r in rows:
                if int(r['parentId']) == cur:
                    cid = int(r['id'])
                    new_level = cur_level + 1
                    if int(r['level']) != new_level:
                        execute('UPDATE `%s` SET `level`=%%s WHERE `id`=%%s' % self.table, (new_level, cid))
                    level_map[cid] = new_level
                    stack.append(cid)

    def delete(self, data):
        try:
            id_value = int(data.get('id'))
        except (TypeError, ValueError):
            raise BizError('参数 id 不合法')
        row = self._find_by_id(id_value)
        rows = self._load_all()
        # 删除保护：后代中还有「启用状态」的部门时不允许删除（级联删除同样拒绝）
        self._assert_no_enabled_children(id_value, '删除本部门', rows)
        direct = [r for r in rows if int(r['parentId']) == id_value]
        descendants = self._descendant_ids(id_value, rows)
        if descendants and not self._to_bool(data.get('cascade')):
            raise BizError('该部门下还有 %d 个下级部门（共 %d 个后代），请先删除或调整下级部门'
                           % (len(direct), len(descendants)))
        if descendants:
            holders = ','.join(['%s'] * len(descendants))
            execute('DELETE FROM `%s` WHERE `id` IN (%s)' % (self.table, holders), descendants)
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.table, (id_value,))
        return self._serialize(row)


menu_service = MenuService(
    table='menuinfros',
    label='菜单项',
    fields=MENU_FIELDS,
    bool_fields=['enabled'],
    unique_fields=[('code', '编号'), ('nameEn', '英文名')],
    required=[('code', '编号'), ('nameCn', '中文名'), ('nameEn', '英文名')],
)

group_service = GroupService(
    table='menugroupinfos',
    label='菜单组',
    fields=GROUP_FIELDS,
    bool_fields=['enabled', 'hasChild'],
    unique_fields=[('code', '编号'), ('nameEn', '英文名')],
    required=[('code', '编号'), ('nameCn', '中文名'), ('nameEn', '英文名')],
)

org_service = OrgService(
    table='OrganizationStructure',
    label='部门',
    fields=ORG_FIELDS,
    bool_fields=['enabled'],
    unique_fields=[('code', '编号')],
    required=[('nameCn', '部门名称')],
)

group_item_service = GroupItemService(
    table='menugroupitemset',
    label='菜单组项目',
    fields=GROUP_ITEM_FIELDS,
    bool_fields=['enabled'],
)


EMP_FIELDS = ['code', 'nameCn', 'gender', 'phone', 'email', 'deptId',
              'jobTitle', 'status', 'hireDate', 'birthDate', 'idCard',
              'education', 'school', 'major', 'certificates', 'titleName', 'photo',
              'remark']

# 在职状态：1-在职，2-试用，0-离职
EMP_STATUS_TEXT = {1: '在职', 2: '试用', 0: '离职'}

# 照片：存 Base64 DataURL（前端已压缩到 ~300px / JPEG），限制字符数防止畸形数据入库
EMP_PHOTO_MAX = 400000

# 身份证：15 位老证（全数字）或 18 位新证（前 17 位数字，末位数字或 X）
RE_ID_CARD = re.compile(r'^(\d{15}|\d{17}[\dX])$')

# 邮箱：常规 user@host.tld（host 至少一段、tld 至少一段）
RE_EMAIL = re.compile(r'^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+$')
# 手机号：1 开头的 11 位数字
RE_PHONE = re.compile(r'^1[3-9]\d{9}$')
# 日期：YYYY-MM-DD
RE_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

class EmpService(CodeMixin, CrudService):
    """
    员工信息（empinfos）：通用 CRUD + 工号自动生成 + 字段格式校验 + 部门关联
      · 工号：E + 5 位流水号（如 E00001），新增时由 /api/emp/nextcode 预取，全局唯一，且**允许编辑**
        （编辑时照常走唯一性校验；统一转大写后入库，避免大小写造成重复）
      · 邮箱：必填 + 格式校验；手机号：选填，填写则必须为 11 位（1 开头）
      · 在职状态：1-在职 / 2-试用 / 0-离职，列表与详情附带 statusText
      · 所属部门：deptId 关联 OrganizationStructure（0 表示未分配），保存时校验部门存在，
        返回数据附带 deptName（列表一次查询映射，避免 N+1）
    """

    CODE_PREFIX = 'E'
    CODE_DIGITS = 5
    CODE_MAX = 99999
    ORDER_BY = '`code` ASC'

    # ---------------- 字段归一化（在唯一性校验之前执行） ----------------
    @staticmethod
    def _normalize_in(data):
        if not isinstance(data, dict):
            return data
        if 'code' in data:
            data['code'] = CrudService._text(data.get('code')).upper()
        if 'email' in data:
            data['email'] = CrudService._text(data.get('email')).lower()
        if 'phone' in data:
            data['phone'] = CrudService._text(data.get('phone')).replace(' ', '').replace('-', '')
        return data

    # ---------------- 检索条件：关键字 + 在职状态 + 部门 ----------------
    def _build_where(self, params):
        clauses, args = [], []
        keyword = self._text(params.get('keyword'))
        if keyword:
            clauses.append('(`code` LIKE %s OR `nameCn` LIKE %s OR `phone` LIKE %s '
                           'OR `email` LIKE %s OR `jobTitle` LIKE %s OR `idCard` LIKE %s)')
            like = '%' + keyword + '%'
            args.extend([like, like, like, like, like, like])
        status = params.get('status')
        if status is not None and str(status).strip() != '':
            try:
                clauses.append('`status`=%s')
                args.append(int(status))
            except (TypeError, ValueError):
                raise BizError('在职状态筛选值不合法')
        dept = params.get('deptId')
        if dept is not None and str(dept).strip() != '':
            try:
                dept_id = int(dept)
            except (TypeError, ValueError):
                raise BizError('部门筛选值不合法')
            # includeChildren=1：连同全部下级部门的员工一起返回（组织架构图双击查看人员用）
            if self._to_bool(params.get('includeChildren')):
                ids = self._dept_subtree_ids(dept_id)
                holders = ','.join(['%s'] * len(ids))
                clauses.append('`deptId` IN (%s)' % holders)
                args.extend(ids)
            else:
                clauses.append('`deptId`=%s')
                args.append(dept_id)
        where = (' WHERE ' + ' AND '.join(clauses)) if clauses else ''
        return where, args

    # ---------------- 附加展示字段 ----------------
    @staticmethod
    def _dept_map():
        rows = query_all('SELECT `id`, `nameCn` FROM `OrganizationStructure`')
        return dict((int(r['id']), r['nameCn']) for r in rows)

    @staticmethod
    def _dept_subtree_ids(root_id):
        """本部门 + 全部下级部门的 ID 列表（含孙辈，用于「含下级部门」的人员查询）"""
        rows = query_all('SELECT `id`, `parentId` FROM `OrganizationStructure`')
        by_parent = {}
        for r in rows:
            by_parent.setdefault(int(r['parentId']), []).append(int(r['id']))
        result, stack = [int(root_id)], [int(root_id)]
        while stack:
            cur = stack.pop()
            for cid in by_parent.get(cur, []):
                if cid not in result:
                    result.append(cid)
                    stack.append(cid)
        return result

    def _attach(self, items):
        if not items:
            return items
        dmap = self._dept_map()
        for item in items:
            if not item:
                continue
            status = int(item.get('status') or 0)
            item['statusText'] = EMP_STATUS_TEXT.get(status, '')
            item['deptName'] = dmap.get(int(item.get('deptId') or 0), '')
            item['genderText'] = '男' if int(item.get('gender') or 1) == 1 else '女'
            # DATE 列经驱动返回 datetime，统一裁成 YYYY-MM-DD，方便 <input type="date"> 回填
            for date_field in ('hireDate', 'birthDate'):
                value = item.get(date_field)
                item[date_field] = str(value)[:10] if value else ''
            # 档案摘要：最高学历 / 职称 合成一列展示（列表用）
            edu = (item.get('education') or '').strip()
            title = (item.get('titleName') or '').strip()
            item['archiveText'] = ' / '.join([x for x in (edu, title) if x]) or ''
            # 照片：无数据时统一给空串，避免前端出现 null / None
            item['photo'] = item.get('photo') or ''
            item['hasPhoto'] = bool(item['photo'])
            if item['hasPhoto']:
                item['avatarText'] = ''
            else:
                name = (item.get('nameCn') or '').strip()
                item['avatarText'] = name[:1]        # 无照片时用姓名首字做占位头像
        return items

    # ---------------- 保存前校验 ----------------
    def before_save(self, data, id_value):
        code = self._text(data.get('code'))
        if not code:
            data['code'] = self.next_code()['code']     # 工号为空时兜底生成
        elif len(code) > 16:
            raise BizError('工号长度不能超过 16 位')

        email = self._text(data.get('email'))
        if not email:
            raise BizError('邮箱不能为空')
        if not RE_EMAIL.match(email):
            raise BizError('邮箱格式不正确，请填写形如 name@example.com 的邮箱')
        data['email'] = email

        phone = self._text(data.get('phone'))
        if phone and not RE_PHONE.match(phone):
            raise BizError('手机号格式不正确，应为 1 开头的 11 位数字')
        data['phone'] = phone

        try:
            status = int(data.get('status') if data.get('status') is not None else 1)
        except (TypeError, ValueError):
            raise BizError('在职状态不合法')
        if status not in EMP_STATUS_TEXT:
            raise BizError('在职状态不合法（0-离职 / 1-在职 / 2-试用）')
        data['status'] = status

        try:
            gender = int(data.get('gender') if data.get('gender') is not None else 1)
        except (TypeError, ValueError):
            raise BizError('性别不合法')
        if gender not in (1, 2):
            raise BizError('性别不合法（1-男 / 2-女）')
        data['gender'] = gender

        try:
            dept_id = int(data.get('deptId') or 0)
        except (TypeError, ValueError):
            raise BizError('所属部门不合法')
        if dept_id:
            row = query_one('SELECT `id` FROM `OrganizationStructure` WHERE `id`=%s', (dept_id,))
            if not row:
                raise BizError('所属部门不存在或已被删除')
        data['deptId'] = dept_id

        hire_date = self._text(data.get('hireDate'))
        if hire_date:
            if not RE_DATE.match(hire_date):
                raise BizError('入职日期格式应为 YYYY-MM-DD')
            data['hireDate'] = hire_date
        else:
            data['hireDate'] = None

        # ---- 档案字段（均可空）：出生日期 / 身份证 / 学历 / 院校 / 专业 / 证书 / 职称 / 照片 ----
        birth_date = self._text(data.get('birthDate'))
        if birth_date:
            if not RE_DATE.match(birth_date):
                raise BizError('出生日期格式应为 YYYY-MM-DD')
            if birth_date > datetime.date.today().isoformat():
                raise BizError('出生日期不能晚于今天')
            data['birthDate'] = birth_date
        else:
            data['birthDate'] = None

        id_card = self._text(data.get('idCard')).replace(' ', '').upper()
        if id_card and not RE_ID_CARD.match(id_card):
            raise BizError('身份证号格式不正确，应为 15 位或 18 位（18 位末位可为 X）')
        data['idCard'] = id_card or None

        for field, name, limit in (('education', '最高学历', 20), ('school', '毕业院校', 100),
                                   ('major', '所学专业', 100), ('certificates', '执业资格证书', 200),
                                   ('titleName', '职称', 50)):
            value = self._text(data.get(field))
            if len(value) > limit:
                raise BizError('%s不能超过 %d 个字符' % (name, limit))
            data[field] = value or None

        # 照片：Base64 DataURL（前端已压缩）或图片地址；未提交该字段时保持原值不动
        if 'photo' in data:
            photo = data.get('photo')
            photo = '' if photo is None else str(photo).strip()
            if photo and not (photo.startswith('data:image/') or photo.startswith('http')):
                raise BizError('照片格式不正确，请重新上传图片')
            if len(photo) > EMP_PHOTO_MAX:
                raise BizError('照片体积过大（超过 %d 字节），请重新选择更小的图片' % EMP_PHOTO_MAX)
            data['photo'] = photo or None

    # ---------------- 对外方法（补齐展示字段） ----------------
    def page(self, params):
        result = super(EmpService, self).page(params)
        self._attach(result.get('list'))
        return result

    def detail(self, params):
        return self._attach([super(EmpService, self).detail(params)])[0]

    def add(self, data):
        self._normalize_in(data)
        return self._attach([super(EmpService, self).add(data)])[0]

    def update(self, data):
        self._normalize_in(data)
        return self._attach([super(EmpService, self).update(data)])[0]

    def delete(self, data):
        return self._attach([super(EmpService, self).delete(data)])[0]


emp_service = EmpService(
    table='empinfos',
    label='员工',
    fields=EMP_FIELDS,
    unique_fields=[('code', '工号')],
    required=[('nameCn', '姓名'), ('email', '邮箱')],
)


class AddressBookService(object):
    """
    员工通讯录（**只读**）：按组织架构树 + 部门浏览/检索员工联系方式
      · 只有两个 GET 动作：`list`（映射到 page）与 `tree`，没有任何写操作
      · **只返回通讯录字段**：工号 / 姓名 / 性别 / 手机 / 邮箱 / 部门 / 岗位 / 在职状态
        （身份证、照片、学历、院校、证书、入职日期等档案字段一律不查不返回，通讯录页也不该看到）
      · page：关键字（工号 / 姓名 / 手机 / 邮箱 / 岗位）+ 部门（可选含下级）+ 未分配部门 + 在职状态 + 分页
      · tree：部门树（父 → 子），每个节点带「直属人数 directCount」与「含下级总人数 totalCount」，
        另返回 totalStaff / unassignedCount 供左侧「全部员工」「未分配部门」节点使用
    """

    table = 'empinfos'
    dept_table = 'OrganizationStructure'
    label = '员工通讯录'

    # 通讯录可见列（其余列不参与查询，天然不会外泄）
    SELECT_FIELDS = '`id`,`code`,`nameCn`,`gender`,`phone`,`email`,`deptId`,`jobTitle`,`status`'
    ORDER_BY = '`code` ASC'

    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _bool(value):
        return str(value).strip().lower() in ('1', 'true', 'yes', 'on')

    # ---------------- 展示字段 ----------------
    def _dept_map(self):
        rows = query_all('SELECT `id`,`nameCn` FROM `%s`' % self.dept_table)
        return dict((int(r['id']), r['nameCn']) for r in rows)

    def _attach(self, items):
        dmap = self._dept_map()
        for it in items:
            if not it:
                continue
            status = int(it.get('status') or 0)
            it['status'] = status
            it['statusText'] = EMP_STATUS_TEXT.get(status, '')
            it['gender'] = int(it.get('gender') or 1)
            it['genderText'] = '男' if it['gender'] == 1 else '女'
            it['deptId'] = int(it.get('deptId') or 0)
            it['deptName'] = dmap.get(it['deptId'], '')
            it['phone'] = it.get('phone') or ''
            it['email'] = it.get('email') or ''
            it['jobTitle'] = it.get('jobTitle') or ''
            it['avatarText'] = (it.get('nameCn') or '').strip()[:1]
        return items

    # ---------------- 检索条件 ----------------
    def _build_where(self, params):
        clauses, args = [], []
        keyword = self._text(params.get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            clauses.append('(`code` LIKE %s OR `nameCn` LIKE %s OR `phone` LIKE %s '
                           'OR `email` LIKE %s OR `jobTitle` LIKE %s)')
            args.extend([like, like, like, like, like])
        status = params.get('status')
        if status is not None and self._text(status) != '':
            try:
                clauses.append('`status`=%s')
                args.append(int(status))
            except (TypeError, ValueError):
                raise BizError('在职状态筛选值不合法')
        if self._bool(params.get('unassigned')):
            clauses.append('(`deptId` IS NULL OR `deptId`=0)')
        else:
            dept = params.get('deptId')
            if dept is not None and self._text(dept) != '':
                try:
                    dept_id = int(dept)
                except (TypeError, ValueError):
                    raise BizError('部门筛选值不合法')
                if dept_id > 0:
                    if self._bool(params.get('includeChildren')):
                        ids = [dept_id] + org_service._descendant_ids(dept_id)
                        holders = ','.join(['%s'] * len(ids))
                        clauses.append('`deptId` IN (%s)' % holders)
                        args.extend(ids)
                    else:
                        clauses.append('`deptId`=%s')
                        args.append(dept_id)
        return (' WHERE ' + ' AND '.join(clauses)) if clauses else '', args

    def page(self, params):
        params = params or {}
        where, args = self._build_where(params)
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 12), 1), 200)
        except (TypeError, ValueError):
            page_num, page_size = 1, 12
        row = query_one('SELECT COUNT(*) AS n FROM `%s`%s' % (self.table, where), args)
        total = int(row['n']) if row and row.get('n') is not None else 0
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        rows = query_all('SELECT %s FROM `%s`%s ORDER BY %s LIMIT %%s OFFSET %%s'
                         % (self.SELECT_FIELDS, self.table, where, self.ORDER_BY),
                         args + [page_size, (page_num - 1) * page_size])
        return {
            'list': self._attach([dump_row(r) for r in rows]),
            'total': total, 'pageNum': page_num, 'pageSize': page_size, 'pages': pages,
            'deptId': int(params.get('deptId') or 0) if self._text(params.get('deptId')) != '' else 0,
            'unassigned': self._bool(params.get('unassigned')),
            'keyword': self._text(params.get('keyword'))
        }

    # ---------------- 组织架构树（带人数） ----------------
    def tree(self, params=None):
        depts = query_all('SELECT `id`,`parentId`,`level`,`sortNo`,`code`,`nameCn`,`enabled` '
                          'FROM `%s` ORDER BY `sortNo` ASC, `id` ASC' % self.dept_table)
        counted = query_all('SELECT `deptId`, COUNT(*) AS n FROM `%s` GROUP BY `deptId`' % self.table)
        direct = {}
        total_staff = 0
        unassigned = 0
        for r in counted:
            n = int(r.get('n') or 0)
            total_staff += n
            dept_id = int(r.get('deptId') or 0)
            if dept_id <= 0:
                unassigned += n
            else:
                direct[dept_id] = direct.get(dept_id, 0) + n

        nodes = {}
        children = {}
        for d in depts:
            did = int(d['id'])
            nodes[did] = {
                'id': did,
                'parentId': int(d['parentId'] or 0),
                'level': int(d['level'] or 1),
                'code': d.get('code') or '',
                'nameCn': d.get('nameCn') or '',
                'enabled': bool(int(d.get('enabled') or 0)),
                'directCount': direct.get(did, 0),
                'totalCount': direct.get(did, 0),      # 先放直属数，下面递归累加下级
                'children': []
            }
            children.setdefault(int(d['parentId'] or 0), []).append(did)

        def build(parent_id):
            out = []
            for cid in children.get(parent_id, []):
                node = nodes[cid]
                node['children'] = build(cid)
                for child in node['children']:
                    node['totalCount'] += child['totalCount']
                out.append(node)
            return out

        tree = build(0)
        return {'list': tree, 'totalStaff': total_staff, 'unassignedCount': unassigned,
                'deptCount': len(nodes)}


address_book_service = AddressBookService()


# 归档时从 empinfos 整行复制过去的业务字段（id 用 UUID，原员工 id 存 empId）
EMP_ARCHIVE_COLUMNS = ['code', 'nameCn', 'gender', 'phone', 'email', 'deptId', 'jobTitle', 'status',
                       'hireDate', 'birthDate', 'idCard', 'education', 'school', 'major',
                       'certificates', 'titleName', 'photo', 'remark']


class EmpArchiveService(object):
    """
    员工信息归档（empinfoarchive）：把 empinfos 在某一时刻的全部记录整表快照留存
      · 一次归档 = 一个批次：batchId（UUID，服务端生成）+ archiveTime（服务器当前时间），
        同批次内所有记录共用这两个值；只追加，不修改 / 删除历史批次
      · 归档记录 id 用 UUID()，原员工 id 存入 empId（员工被删除后仍可溯源）
      · 复制 empinfos 全部业务字段（工号 / 姓名 / 性别 / 手机号 / 邮箱 / 部门 / 岗位 /
        在职状态 / 入职日期 / 档案 8 字段 / 备注），并带上原记录的 createTime、updateTime
      · 查询：batches() 按归档时间倒序列出批次（含记录数）；page() 按 batchId 分页列出员工
      · 展示字段（部门名 / 在职状态文案 / 学历·职称摘要 / 头像占位）复用 EmpService._attach
    """

    table = 'empinfoarchive'
    label = '员工信息归档'
    MAX_PAGE_SIZE = 500

    # ---------------- 小工具 ----------------
    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _now_text():
        return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    def _uuid_of(self, value):
        text = self._text(value).lower()
        if not text:
            raise BizError('参数 batchId 不能为空（应为 UUID）')
        if not RE_UUID.match(text):
            raise BizError('参数 batchId 不合法（应为 UUID）')
        return text

    # ---------------- 归档（整表快照） ----------------
    def archive(self, params=None):
        row = query_one('SELECT COUNT(*) AS n FROM `empinfos`')
        total = int(row['n']) if row and row.get('n') is not None else 0
        if not total:
            raise BizError('员工信息表暂无数据，无需归档')

        batch_id = str(uuid.uuid4())
        archive_time = self._now_text()
        col_sql = ', '.join('`%s`' % c for c in EMP_ARCHIVE_COLUMNS)
        val_sql = ', '.join('e.`%s`' % c for c in EMP_ARCHIVE_COLUMNS)
        # 一条 INSERT ... SELECT 完成整表快照：id 由 MySQL UUID() 逐行生成，避免逐条往返
        sql = ('INSERT INTO `%s` (`id`, `batchId`, `archiveTime`, `empId`, %s, `createTime`, `updateTime`) '
               'SELECT UUID(), %%s, %%s, e.`id`, %s, e.`createTime`, e.`updateTime` '
               'FROM `empinfos` e') % (self.table, col_sql, val_sql)
        _, inserted = execute(sql, (batch_id, archive_time))
        return {'batchId': batch_id, 'archiveTime': archive_time,
                'total': int(inserted or total)}

    # ---------------- 归档批次列表（历次归档时间） ----------------
    def batches(self, params=None):
        rows = query_all(
            'SELECT `batchId`, `archiveTime`, COUNT(*) AS `total` FROM `%s` '
            'GROUP BY `batchId`, `archiveTime` '
            'ORDER BY `archiveTime` DESC, `batchId` DESC' % self.table)
        out = []
        for r in rows:
            item = dump_row(r)
            item['total'] = int(item.get('total') or 0)
            out.append(item)
        return {'list': out, 'total': len(out)}

    # ---------------- 某批次的员工列表 ----------------
    def page(self, params):
        params = params or {}
        batch_id = self._uuid_of(params.get('batchId'))
        where = ['`batchId`=%s']
        args = [batch_id]

        keyword = self._text(params.get('keyword'))
        if keyword:
            where.append('(`code` LIKE %s OR `nameCn` LIKE %s OR `phone` LIKE %s '
                         'OR `email` LIKE %s OR `jobTitle` LIKE %s OR `idCard` LIKE %s)')
            like = '%' + keyword + '%'
            args.extend([like] * 6)

        status = params.get('status')
        if status is not None and str(status).strip() != '':
            try:
                where.append('`status`=%s')
                args.append(int(status))
            except (TypeError, ValueError):
                raise BizError('在职状态筛选值不合法')

        where_sql = ' WHERE ' + ' AND '.join(where)
        total_row = query_one('SELECT COUNT(*) AS n FROM `%s`%s' % (self.table, where_sql), args)
        total = int(total_row['n']) if total_row and total_row.get('n') is not None else 0

        try:
            page_num = max(1, int(params.get('pageNum') or 1))
        except (TypeError, ValueError):
            page_num = 1
        try:
            page_size = int(params.get('pageSize') or 10)
        except (TypeError, ValueError):
            page_size = 10
        page_size = min(max(page_size, 1), self.MAX_PAGE_SIZE)
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        offset = (page_num - 1) * page_size

        rows = query_all('SELECT * FROM `%s`%s ORDER BY `code` ASC LIMIT %%s OFFSET %%s'
                         % (self.table, where_sql), args + [page_size, offset])
        items = [dump_row(r) for r in rows]
        emp_service._attach(items)          # 部门名 / 状态文案 / 学历·职称 / 头像占位
        return {'list': items, 'total': total, 'pageNum': page_num,
                'pageSize': page_size, 'pages': pages}


emp_archive_service = EmpArchiveService()


# ---------------------------------------------------------------- 用户信息（useinfo） ----------------------------------------------------------------
# 批量创建用户 / 重置密码时的统一初始密码
USER_DEFAULT_PASSWORD = '888888'
# 登录账号：字母 / 数字 / 下划线 / 点 / @ / 连字符，4-50 位（默认取员工手机号）
RE_USER_ACCOUNT = re.compile(r'^[A-Za-z0-9_.@-]{4,50}$')

# ---------------------------------------------------------------- 登录验证码（运算表达式） ----------------------------------------------------------------
# 内存存储：captchaId -> {answer, expire}；5 分钟有效、一次性使用（校验即作废）；重启服务后自动失效。
CAPTCHA_TTL = 300
CAPTCHA_OPERATORS = ('+', '-', '×')
_CAPTCHA_STORE = {}
_CAPTCHA_LOCK = threading.Lock()

# ---------------------------------------------------------------- 找回密码（邮箱验证码） ----------------------------------------------------------------
# 内存存储：邮箱（小写）-> {code, expire, sentAt, tries}；6 位数字、5 分钟有效、
# 同一邮箱 60 秒内只能发一次（防轰炸），连续错 5 次作废；校验通过即作废。重启服务后全部失效。
EMAIL_CODE_TTL = int(os.getenv('EMAIL_CODE_TTL', '300'))
EMAIL_CODE_INTERVAL = int(os.getenv('EMAIL_CODE_INTERVAL', '60'))
EMAIL_CODE_MAX_TRIES = 5
_EMAIL_CODE_STORE = {}
_EMAIL_CODE_LOCK = threading.Lock()


# ---------------------------------------------------------------- 登录令牌（token / 单点登录） ----------------------------------------------------------------
# 一次登录签发一个 token，全站（main.html 与所有 iframe 子页）共享同一份登录态；
# 服务端以 useinfo.tokenExpireTime 判定有效期，默认 8 小时（config.TOKEN_TTL_HOURS 可覆盖）。
from config import TOKEN_TTL_HOURS, TOKEN_TTL_SECONDS  # noqa: E402


def token_ttl_hours_text():
    """"有效期 8 小时" 里那个数字：8 → 8；0.5 → 0.5"""
    return ('%d' % TOKEN_TTL_HOURS) if float(TOKEN_TTL_HOURS).is_integer() else ('%g' % TOKEN_TTL_HOURS)


def md5_hex(text):
    """密码统一用 MD5 存储（32 位小写十六进制）"""
    return hashlib.md5(str(text).encode('utf-8')).hexdigest()


class UserInfoService(object):
    """
    用户信息（useinfo）：由员工派生登录账号，账号唯一、一员工一账号，密码 MD5
      · 账号：默认取员工手机号（empinfos.phone），可手工修改；全局唯一（uk_useinfo_account）
      · 密码：MD5(32 位小写)，接口**永不返回明文/密文**，列表显示 ******
        批量创建 / 重置密码统一使用 USER_DEFAULT_PASSWORD（888888）
      · 员工：empId 唯一（一个员工最多一个账号），一个员工只能创建一次
      · 登录痕迹：token / lastLoginTime / lastLoginIp 由登录流程写入，本模块只展示与重置
      · 角色：useinforoleset（用户 ↔ 角色 多对多，UUID 主键），支持批量设置（全量替换）
    对外接口：list(page) / detail / check / add / batch / update / delete / resetpwd / setroles / empoptions
    """

    table = 'useinfo'
    role_table = 'useinforoleset'
    label = '用户信息'
    MAX_BATCH = 500

    # ---------------- 小工具 ----------------
    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _int_of(value, name='参数'):
        try:
            return int(value)
        except (TypeError, ValueError):
            raise BizError('%s不合法' % name)

    def _uuid_of(self, value, name='id'):
        text = self._text(value).lower()
        if not text:
            raise BizError('参数 %s 不能为空（应为 UUID）' % name)
        if not RE_UUID.match(text):
            raise BizError('参数 %s 不合法（应为 UUID）' % name)
        return text

    def _ids_of(self, params):
        """批量操作的 id 集合：[{id}, {ids:[...]}, 'id1,id2'] 三种写法都支持"""
        raw = (params or {}).get('ids')
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            raw = (params or {}).get('id')
        if raw is None:
            raise BizError('请先选择用户')
        if isinstance(raw, str):
            raw = [x for x in re.split(r'[,\s]+', raw) if x]
        elif not isinstance(raw, (list, tuple)):
            raw = [raw]
        ids = []
        for one in raw:
            uid = self._uuid_of(one)
            if uid not in ids:
                ids.append(uid)
        if not ids:
            raise BizError('请先选择用户')
        return ids

    def _role_ids(self, raw, allow_empty=True):
        if raw is None:
            raw = []
        if isinstance(raw, str):
            raw = [x for x in re.split(r'[,\s]+', raw) if x]
        elif not isinstance(raw, (list, tuple)):
            raw = [raw]
        ids = []
        for one in raw:
            rid = self._uuid_of(one, 'roleId')
            if rid not in ids:
                ids.append(rid)
        if not ids and not allow_empty:
            raise BizError('请至少选择一个角色')
        if ids:
            holders = ','.join(['%s'] * len(ids))
            rows = query_all('SELECT `id` FROM `usergroup` WHERE `id` IN (%s)' % holders, ids)
            if len(rows) != len(ids):
                raise BizError('存在已被删除的角色，请刷新后重试')
        return ids

    @staticmethod
    def _assert_account(account, self_id=''):
        if not account:
            raise BizError('登录账号不能为空')
        if not RE_USER_ACCOUNT.match(account):
            raise BizError('账号需为 4-50 位字母、数字、下划线、点、@ 或连字符')
        row = query_one('SELECT `id` FROM `useinfo` WHERE `account`=%s AND `id`<>%s LIMIT 1',
                        (account, self_id or EMPTY_UUID))
        if row:
            raise BizError('账号【%s】已存在，请更换' % account)

    @staticmethod
    def _assert_password(password):
        if len(password) < 6:
            raise BizError('密码长度不能少于 6 位')
        if len(password) > 32:
            raise BizError('密码长度不能超过 32 位')

    # ---------------- 展示字段（部门 / 状态 / 角色 / 密码掩码） ----------------
    def _attach(self, items):
        if not items:
            return items
        dmap = emp_service._dept_map()
        ids = [it['id'] for it in items if it.get('id')]
        role_map = {}
        if ids:
            holders = ','.join(['%s'] * len(ids))
            rows = query_all(
                'SELECT r.`userId`, g.`id` AS `roleId`, g.`nameCn`, g.`nameEn` '
                'FROM `%s` r JOIN `usergroup` g ON g.`id`=r.`roleId` '
                'WHERE r.`userId` IN (%s) ORDER BY g.`sortNo` ASC, g.`nameCn` ASC'
                % (self.role_table, holders), ids)
            for r in rows:
                role_map.setdefault(r['userId'], []).append(
                    {'id': r['roleId'], 'nameCn': r['nameCn'], 'nameEn': r['nameEn']})
        for it in items:
            it['passwordMask'] = '******'
            it.pop('password', None)            # 无论查询怎么写的，接口层面绝不输出密码
            it['enabled'] = bool(int(it.get('enabled') or 0))
            it['empId'] = int(it.get('empId') or 0)
            it['deptName'] = dmap.get(int(it.get('deptId') or 0), '')
            try:
                it['statusText'] = EMP_STATUS_TEXT.get(int(it.get('status')), '')
            except (TypeError, ValueError):
                it['statusText'] = ''
            roles = role_map.get(it['id'], [])
            it['roles'] = roles
            it['roleIds'] = [x['id'] for x in roles]
            it['roleNames'] = '、'.join([x['nameCn'] for x in roles])
            token = it.get('token') or ''
            it['hasToken'] = bool(token)
            it['tokenShort'] = (token[:8] + '…') if len(token) > 8 else token
            it.pop('token', None)               # 授权 token 属敏感信息，只给「是否有 / 前 8 位」提示
            # 令牌有效期（单点登录：默认 8 小时）：过期后该 token 不再可用，需要重新登录
            expire = it.get('tokenExpireTime')
            now_text = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            if isinstance(expire, datetime.datetime):
                expire_text, expired = expire.strftime('%Y-%m-%d %H:%M:%S'), expire <= datetime.datetime.now()
            elif expire:
                expire_text = str(expire)[:19]
                expired = expire_text <= now_text        # 同格式字符串可直接比较大小
            else:
                expire_text, expired = '', False
            it['tokenExpireTime'] = expire_text
            it['tokenExpired'] = bool(expired)
            it['online'] = bool(it['hasToken'] and not expired)
            it['ttlHours'] = TOKEN_TTL_HOURS
            it['lastLoginTime'] = it.get('lastLoginTime') or ''
            it['lastLoginIp'] = it.get('lastLoginIp') or ''
        return items

    # ---------------- 查询 ----------------
    def _build_where(self, params):
        where, args = [], []
        keyword = self._text((params or {}).get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            where.append('(u.`account` LIKE %s OR e.`nameCn` LIKE %s OR e.`code` LIKE %s '
                         'OR e.`phone` LIKE %s OR u.`lastLoginIp` LIKE %s)')
            args.extend([like] * 5)
        enabled = (params or {}).get('enabled')
        if enabled is not None and str(enabled).strip() != '':
            where.append('u.`enabled`=%s')
            args.append(1 if str(enabled).strip().lower() in ('1', 'true', 'yes', 'on') else 0)
        emp_id = (params or {}).get('empId')
        if emp_id is not None and str(emp_id).strip() != '':
            where.append('u.`empId`=%s')
            args.append(self._int_of(emp_id, '员工 id'))
        return (' WHERE ' + ' AND '.join(where)) if where else '', args

    BASE_SELECT = ('SELECT u.`id`, u.`account`, u.`empId`, u.`token`, u.`tokenExpireTime`, '
                   '       u.`lastLoginTime`, u.`lastLoginIp`, '
                   '       u.`enabled`, u.`remark`, u.`createTime`, u.`updateTime`, '
                   '       e.`code` AS empCode, e.`nameCn` AS empName, e.`phone`, e.`deptId`, '
                   '       e.`jobTitle`, e.`status` '
                   'FROM `useinfo` u LEFT JOIN `empinfos` e ON e.`id` = u.`empId`')

    def page(self, params):
        params = params or {}
        where_sql, args = self._build_where(params)
        row = query_one('SELECT COUNT(*) AS n FROM `useinfo` u '
                        'LEFT JOIN `empinfos` e ON e.`id` = u.`empId`' + where_sql, args)
        total = int(row['n']) if row and row.get('n') is not None else 0
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
        except (TypeError, ValueError):
            page_num = 1
        try:
            page_size = int(params.get('pageSize') or 10)
        except (TypeError, ValueError):
            page_size = 10
        page_size = min(max(page_size, 1), 500)
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        offset = (page_num - 1) * page_size
        rows = query_all(self.BASE_SELECT + where_sql +
                         ' ORDER BY u.`account` ASC LIMIT %s OFFSET %s', args + [page_size, offset])
        items = [dump_row(r) for r in rows]
        self._attach(items)
        return {'list': items, 'total': total, 'pageNum': page_num, 'pageSize': page_size, 'pages': pages}

    def detail(self, params):
        uid = self._uuid_of((params or {}).get('id'))
        row = query_one(self.BASE_SELECT + ' WHERE u.`id`=%s', (uid,))
        if not row:
            raise BizError('用户不存在或已被删除', 404)
        return self._attach([dump_row(row)])[0]

    def check(self, params):
        params = params or {}
        field = self._text(params.get('field')) or 'account'
        if field not in ('account', 'empId'):
            raise BizError('不支持的唯一性校验字段：' + field)
        value = self._text(params.get('value'))
        if not value:
            return {'unique': True}
        self_id = self._text(params.get('id'))
        if field == 'account':
            row = query_one('SELECT `id` FROM `useinfo` WHERE `account`=%s AND `id`<>%s LIMIT 1',
                            (value, self_id or EMPTY_UUID))
        else:
            row = query_one('SELECT `id` FROM `useinfo` WHERE `empId`=%s AND `id`<>%s LIMIT 1',
                            (self._int_of(value, '员工 id'), self_id or EMPTY_UUID))
        return {'unique': row is None}

    # ---------------- 员工下拉（建账号用） ----------------
    def emp_options(self, params):
        params = params or {}
        where, args = [], []
        keyword = self._text(params.get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            where.append('(e.`code` LIKE %s OR e.`nameCn` LIKE %s OR e.`phone` LIKE %s '
                         'OR e.`jobTitle` LIKE %s)')
            args.extend([like] * 4)
        if str(params.get('noUser')).strip() in ('1', 'true'):
            where.append('u.`id` IS NULL')
        where_sql = (' WHERE ' + ' AND '.join(where)) if where else ''
        rows = query_all(
            'SELECT e.`id`, e.`code`, e.`nameCn`, e.`phone`, e.`deptId`, e.`jobTitle`, e.`status`, '
            '       u.`id` AS `userId`, u.`account` '
            'FROM `empinfos` e LEFT JOIN `useinfo` u ON u.`empId` = e.`id`' +
            where_sql + ' ORDER BY e.`code` ASC', args)
        dmap = emp_service._dept_map()
        out = []
        for r in rows:
            item = dump_row(r)
            item['id'] = int(item['id'])
            item['deptName'] = dmap.get(int(item.get('deptId') or 0), '')
            try:
                item['statusText'] = EMP_STATUS_TEXT.get(int(item.get('status')), '')
            except (TypeError, ValueError):
                item['statusText'] = ''
            item['hasUser'] = bool(item.get('userId'))
            item['userAccount'] = item.get('account') or ''
            out.append(item)
        return {'list': out, 'total': len(out)}

    # ---------------- 新增（单个） ----------------
    def add(self, data):
        data = data or {}
        emp_id = self._int_of(data.get('empId'), '员工 id')
        emp = query_one('SELECT * FROM `empinfos` WHERE `id`=%s', (emp_id,))
        if not emp:
            raise BizError('员工不存在或已被删除')
        exist = query_one('SELECT `account` FROM `useinfo` WHERE `empId`=%s', (emp_id,))
        if exist:
            raise BizError('该员工已创建过用户账号（%s），一个员工只能创建一个账号' % exist['account'])

        account = self._text(data.get('account')) or self._text(emp.get('phone'))
        if not account:
            raise BizError('该员工没有手机号，请手工填写登录账号')
        self._assert_account(account)
        password = self._text(data.get('password')) or USER_DEFAULT_PASSWORD
        self._assert_password(password)

        uid = str(uuid.uuid4())
        enabled = 1 if str(data.get('enabled', 1)).strip().lower() in ('1', 'true', 'yes', 'on') else 0
        remark = self._text(data.get('remark'))[:200] or None

        def _insert(cur):
            cur.execute(
                'INSERT INTO `%s` (`id`, `account`, `password`, `empId`, `enabled`, `remark`) '
                'VALUES (%%s, %%s, %%s, %%s, %%s, %%s)' % self.table,
                (uid, account, md5_hex(password), emp_id, enabled, remark))
            return uid

        try:
            transaction(_insert)
        except DuplicateError:
            raise BizError('账号【%s】已存在，请更换' % account)

        role_ids = self._role_ids(data.get('roleIds'))
        if role_ids:
            self._write_roles([uid], role_ids)
        return self.detail({'id': uid})

    # ---------------- 批量创建（初始密码 888888） ----------------
    def batch_create(self, params):
        params = params or {}
        raw = params.get('empIds')
        if isinstance(raw, str):
            raw = [x for x in re.split(r'[,\s]+', raw) if x]
        if not raw or not isinstance(raw, (list, tuple)):
            raise BizError('请选择要创建账号的员工')
        emp_ids = []
        for one in raw:
            eid = self._int_of(one, '员工 id')
            if eid not in emp_ids:
                emp_ids.append(eid)
        if len(emp_ids) > self.MAX_BATCH:
            raise BizError('单次最多批量创建 %d 个账号' % self.MAX_BATCH)

        role_ids = self._role_ids(params.get('roleIds'))
        password = USER_DEFAULT_PASSWORD           # 批量创建统一初始密码
        pwd_md5 = md5_hex(password)

        holders = ','.join(['%s'] * len(emp_ids))
        emps = query_all('SELECT `id`, `code`, `nameCn`, `phone`, `status` FROM `empinfos` '
                         'WHERE `id` IN (%s) ORDER BY `code` ASC' % holders, emp_ids)
        if not emps:
            raise BizError('所选员工不存在或已被删除')
        exist_rows = query_all('SELECT `empId`, `account` FROM `useinfo` WHERE `empId` IN (%s)' % holders,
                               emp_ids)
        exist_map = dict((int(r['empId']), r['account']) for r in exist_rows)
        account_rows = query_all('SELECT `account` FROM `useinfo`')
        used_accounts = set(str(r['account']) for r in account_rows)

        created, skipped, plans = [], [], []
        for emp in emps:
            eid = int(emp['id'])
            if eid in exist_map:
                skipped.append({'empId': eid, 'code': emp['code'], 'nameCn': emp['nameCn'],
                                'reason': '已存在账号（%s）' % exist_map[eid]})
                continue
            account = self._text(emp.get('phone'))
            if not account:
                skipped.append({'empId': eid, 'code': emp['code'], 'nameCn': emp['nameCn'],
                                'reason': '员工没有手机号，无法作为默认账号'})
                continue
            if not RE_USER_ACCOUNT.match(account):
                skipped.append({'empId': eid, 'code': emp['code'], 'nameCn': emp['nameCn'],
                                'reason': '手机号【%s】不符合账号规则' % account})
                continue
            if account in used_accounts:
                skipped.append({'empId': eid, 'code': emp['code'], 'nameCn': emp['nameCn'],
                                'reason': '账号【%s】已被占用' % account})
                continue
            used_accounts.add(account)
            uid = str(uuid.uuid4())
            plans.append((uid, account, pwd_md5, eid, emp['code'], emp['nameCn']))

        if not plans:
            return {'created': 0, 'skipped': skipped, 'total': len(emp_ids),
                    'password': password, 'accounts': []}

        def _insert_all(cur):
            for (uid, account, pwd, eid, _code, _name) in plans:
                cur.execute(
                    'INSERT INTO `%s` (`id`, `account`, `password`, `empId`, `enabled`, `remark`) '
                    'VALUES (%%s, %%s, %%s, %%s, 1, %%s)' % self.table,
                    (uid, account, pwd, eid, '批量创建'))
            return len(plans)

        try:
            transaction(_insert_all)
        except DuplicateError:
            raise BizError('批量创建失败：账号或员工已存在，请刷新后重试')

        new_ids = [p[0] for p in plans]
        if role_ids:
            self._write_roles(new_ids, role_ids)
        return {'created': len(plans), 'skipped': skipped, 'total': len(emp_ids),
                'password': password,
                'accounts': [{'id': p[0], 'account': p[1], 'empCode': p[4], 'empName': p[5]} for p in plans]}

    # ---------------- 编辑 / 删除 ----------------
    def update(self, data):
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        row = query_one('SELECT * FROM `useinfo` WHERE `id`=%s', (uid,))
        if not row:
            raise BizError('用户不存在或已被删除', 404)
        sets, args = [], []
        if 'account' in data:
            account = self._text(data.get('account')) or row['account']
            self._assert_account(account, uid)
            sets.append('`account`=%s')
            args.append(account)
        if 'remark' in data:
            sets.append('`remark`=%s')
            args.append(self._text(data.get('remark'))[:200] or None)
        if 'enabled' in data:
            enable_val = 1 if str(data.get('enabled')).strip().lower() in ('1', 'true', 'yes', 'on') else 0
            sets.append('`enabled`=%s')
            args.append(enable_val)
            if enable_val == 0:                 # 停用即强制下线：作废全局 token（单点登录）
                sets.append('`token`=NULL')
                sets.append('`tokenExpireTime`=NULL')
        if not sets:
            return self.detail({'id': uid})
        args.append(uid)
        try:
            execute('UPDATE `%s` SET %s WHERE `id`=%%s' % (self.table, ', '.join(sets)), args)
        except DuplicateError:
            raise BizError('账号已被占用，请更换')
        if data.get('roleIds') is not None:
            self._write_roles([uid], self._role_ids(data.get('roleIds')))
        return self.detail({'id': uid})

    def delete(self, params):
        ids = self._ids_of(params)
        holders = ','.join(['%s'] * len(ids))

        def _del(cur):
            cur.execute('DELETE FROM `%s` WHERE `userId` IN (%s)' % (self.role_table, holders), ids)
            cur.execute('DELETE FROM `%s` WHERE `id` IN (%s)' % (self.table, holders), ids)
            return cur.rowcount

        deleted = transaction(_del)
        return {'deleted': int(deleted or len(ids)), 'ids': ids}

    # ---------------- 重置密码（统一 888888） ----------------
    def reset_password(self, params):
        ids = self._ids_of(params)
        holders = ','.join(['%s'] * len(ids))
        # 先统计命中的用户数：MySQL 的 UPDATE rowcount 在「密码本就是 888888」时返回 0，不能当成功数用
        row = query_one('SELECT COUNT(*) AS n FROM `%s` WHERE `id` IN (%s)' % (self.table, holders), ids)
        matched = int(row['n']) if row and row.get('n') is not None else 0
        # 重置密码时同时作废登录令牌：旧会话（单点登录的全局 token）必须重新登录
        execute('UPDATE `%s` SET `password`=%%s, `token`=NULL, `tokenExpireTime`=NULL '
                'WHERE `id` IN (%s)' % (self.table, holders),
                [md5_hex(USER_DEFAULT_PASSWORD)] + ids)
        return {'reset': matched, 'password': USER_DEFAULT_PASSWORD, 'ids': ids, 'kicked': matched}

    # ---------------- 批量设置角色（全量替换） ----------------
    def _write_roles(self, user_ids, role_ids):
        if not user_ids:
            return 0
        holders = ','.join(['%s'] * len(user_ids))

        def _write(cur):
            cur.execute('DELETE FROM `%s` WHERE `userId` IN (%s)' % (self.role_table, holders), user_ids)
            n = 0
            for uid in user_ids:
                for rid in role_ids:
                    cur.execute('INSERT INTO `%s` (`id`, `userId`, `roleId`) VALUES (%%s, %%s, %%s)'
                                % self.role_table, (str(uuid.uuid4()), uid, rid))
                    n += 1
            return n

        return transaction(_write)

    def set_roles(self, params):
        params = params or {}
        ids = self._ids_of(params)
        role_ids = self._role_ids(params.get('roleIds'))
        n = self._write_roles(ids, role_ids)
        return {'users': len(ids), 'roles': len(role_ids), 'relations': n}


user_info_service = UserInfoService()


class AuthService(object):
    """
    登录认证（基于 useinfo 用户表）—— 单点登录（SSO）令牌的签发方
      · 账号 = useinfo.account（默认员工手机号），密码 = MD5(明文) 与库中 password 比对
      · 登录成功：生成 32 位 token（uuid4().hex）写入 useinfo.token，
        同时写入 tokenExpireTime（= 登录时间 + TOKEN_TTL_HOURS 小时，默认 8 小时），
        并记录 lastLoginTime（服务器时间）与 lastLoginIp（取请求 IP，支持 X-Forwarded-For）
      · **同一个 token 全站共享**：main.html 与 iframe 内所有功能子页都用这一份登录态，
        子页请求失效时不在子页里跳登录页，而是通知框架页统一跳转（见 js/api.js）
      · 停用账号（enabled=0）不允许登录；账号不存在 / 密码错误统一提示「账号或密码不正确」
      · logout：按 token 清空该用户 token / 过期时间；me：按 token 反查当前登录用户（含剩余有效期）
      · 对外接口：POST /api/auth/login、POST /api/auth/logout、GET /api/auth/me、GET /api/auth/captcha；
        GET /api/auth/brand 是唯一**免登录**的业务接口，只回系统品牌三键（登录页显示名称 / 英文名 / 图标）
    """

    table = 'useinfo'
    label = '登录认证'

    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _now_text():
        return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    @staticmethod
    def _client_ip(params):
        """取客户端 IP：优先代理头 X-Forwarded-For 的第一段，其次由 app.py 注入的 _clientIp"""
        raw = AuthService._text(params.get('_clientIp'))
        if raw:
            return raw.split(',')[0].strip()[:45]
        return ''

    # ---------------- 运算表达式验证码 ----------------
    @staticmethod
    def _purge_expired():
        now_ts = time.time()
        for key in [k for k, v in list(_CAPTCHA_STORE.items()) if v['expire'] < now_ts]:
            _CAPTCHA_STORE.pop(key, None)

    def captcha(self, params=None):
        """生成一道算术题：返回 {captchaId, question, expireIn}；答案只留在服务端"""
        op = random.choice(CAPTCHA_OPERATORS)
        if op == '-':
            left = random.randint(5, 9)
            right = random.randint(1, left)      # 保证结果非负
            answer = left - right
        else:
            left = random.randint(1, 9)
            right = random.randint(1, 9)
            answer = left + right if op == '+' else left * right
        captcha_id = uuid.uuid4().hex
        with _CAPTCHA_LOCK:
            self._purge_expired()
            _CAPTCHA_STORE[captcha_id] = {'answer': answer, 'expire': time.time() + CAPTCHA_TTL}
        return {'captchaId': captcha_id, 'question': '%d %s %d = ?' % (left, op, right),
                'expireIn': CAPTCHA_TTL}

    def _verify_captcha(self, params):
        """校验验证码：必须先通过再校验账号密码（防暴力破解）；无论对错都一次性作废"""
        captcha_id = self._text((params or {}).get('captchaId'))
        code = self._text((params or {}).get('captchaCode'))
        if not code:
            raise BizError('请输入验证码')
        if not captcha_id:
            raise BizError('验证码已失效，请点击图形换一题')
        with _CAPTCHA_LOCK:
            item = _CAPTCHA_STORE.pop(captcha_id, None)
        if not item:
            raise BizError('验证码已失效，请点击图形换一题')
        if item['expire'] < time.time():
            raise BizError('验证码已过期，请点击图形换一题')
        try:
            value = int(re.sub(r'\s+', '', code))
        except (TypeError, ValueError):
            raise BizError('验证码不正确，请重新输入')
        if value != int(item['answer']):
            raise BizError('验证码不正确，请重新输入')

    def login(self, params):
        params = params or {}
        self._verify_captcha(params)          # 先验验证码，再查账号密码
        account = self._text(params.get('account'))
        password = self._text(params.get('password'))
        if not account:
            raise BizError('请输入登录账号')
        if not password:
            raise BizError('请输入登录密码')

        row = query_one('SELECT * FROM `%s` WHERE `account`=%%s LIMIT 1' % self.table, (account,))
        if not row:
            raise BizError('账号或密码不正确')
        if int(row.get('enabled') or 0) != 1:
            raise BizError('账号已停用，请联系管理员')
        if md5_hex(password) != str(row.get('password') or '').strip().lower():
            raise BizError('账号或密码不正确')

        token = uuid.uuid4().hex                 # 32 位十六进制 token（全站共享）
        login_time = self._now_text()
        expire_at = datetime.datetime.now() + datetime.timedelta(seconds=TOKEN_TTL_SECONDS)
        expire_text = expire_at.strftime('%Y-%m-%d %H:%M:%S')
        ip = self._client_ip(params)
        execute('UPDATE `%s` SET `token`=%%s, `tokenExpireTime`=%%s, `lastLoginTime`=%%s, `lastLoginIp`=%%s '
                'WHERE `id`=%%s' % self.table, (token, expire_text, login_time, ip or None, row['id']))

        user = user_info_service.detail({'id': row['id']})
        user.pop('token', None)
        user.pop('tokenExpireTime', None)
        return {'token': token, 'loginTime': login_time, 'loginIp': ip,
                'expireTime': expire_text, 'expireIn': TOKEN_TTL_SECONDS,
                'ttlHours': TOKEN_TTL_HOURS, 'user': user}

    def logout(self, params):
        token = self._text((params or {}).get('token'))
        if token:
            execute('UPDATE `%s` SET `token`=NULL, `tokenExpireTime`=NULL WHERE `token`=%%s' % self.table, (token,))
        return {'logout': True}

    def me(self, params):
        """按 token 反查当前登录用户；顺带返回令牌有效期信息（前端据此续算倒计时）"""
        token = self._text((params or {}).get('token'))
        if not token:
            raise BizError('登录已失效，请重新登录', 401)
        row = query_one('SELECT `id`,`tokenExpireTime` FROM `%s` WHERE `token`=%%s LIMIT 1' % self.table, (token,))
        if not row:
            raise BizError('登录已失效，请重新登录', 401)
        expire = row.get('tokenExpireTime')
        remain = 0
        if expire:
            remain = max(0, int((expire - datetime.datetime.now()).total_seconds()))
        user = user_info_service.detail({'id': row['id']})
        user.pop('token', None)
        user.pop('tokenExpireTime', None)
        user['expireTime'] = expire.strftime('%Y-%m-%d %H:%M:%S') if expire else ''
        user['expireIn'] = remain
        user['ttlHours'] = TOKEN_TTL_HOURS
        return user

    # ---------------- 未登录可见的系统品牌（登录页用） ----------------
    BRAND_KEYS = ('app_name', 'app_ennme', 'app_ico')

    def brand(self, params=None):
        """取系统品牌：**登录前**可调，只回白名单三键（中文名 / 英文名 / 图标）

        为什么单独开一个动作：syspara 列表是整表可读的，里面还有维护公告这类内部信息，
        不能为了登录页把整个参数表免鉴权；这里只挑 `app_name` / `app_ennme` / `app_ico` 三个键。
        某个键没配或已停用时返回空串，由页面保留自己的兜底文案（不在这里写死第二份默认值）。
        """
        out = dict((key, '') for key in self.BRAND_KEYS)
        rows = query_all(
            'SELECT `paraNameEn`,`paraValue` FROM `syspara` '
            'WHERE `enabled`=1 AND `paraNameEn` IN (\'app_name\', \'app_ennme\', \'app_ico\')')
        for row in rows or []:
            key = self._text(row.get('paraNameEn'))
            value = self._text(row.get('paraValue'))
            if key in out and value:
                out[key] = value
        return out

    # ================================================================
    # 密码：登录后自助修改（changepwd）/ 忘记密码用邮箱验证码重置（sendcode + resetbyemail）
    # ----------------------------------------------------------------
    # · 账号与邮箱的对应关系：useinfo.empId → empinfos.email（员工信息里登记的邮箱）；
    #   兼容「账号本身就是邮箱」的历史数据。只认启用状态的账号。
    # · 验证码走系统「当前启用的服务信箱」发送（SMTP），库里不落验证码，只在内存里存 5 分钟；
    #   同一邮箱 60 秒内不可重复发送、连续错 5 次作废、校验通过即作废。
    # · 修改 / 重置成功后都会把 token 作废（token=NULL），强制用新密码重新登录。
    # ================================================================
    @staticmethod
    def _mask_email(email):
        """邮箱打码：biewj@szyc-data.com → b***@szyc-data.com（回显用，不泄漏完整地址）"""
        text = str(email or '')
        if '@' not in text:
            return text
        name, _, domain = text.partition('@')
        return (name[:1] or '') + '***@' + domain

    @staticmethod
    def _check_new_password(new_password):
        """新密码规则：6~32 位，且不能是同一个字符重复（如 111111）"""
        text = AuthService._text(new_password)
        if not text:
            raise BizError('请输入新密码')
        if len(text) < 6:
            raise BizError('新密码至少 6 位')
        if len(text) > 32:
            raise BizError('新密码最多 32 位')
        if len(set(text)) == 1:
            raise BizError('新密码不能是同一个字符重复（如 111111）')
        return text

    @staticmethod
    def _purge_codes():
        now_ts = time.time()
        for key in [k for k, v in list(_EMAIL_CODE_STORE.items()) if v['expire'] < now_ts]:
            _EMAIL_CODE_STORE.pop(key, None)

    def _account_by_email(self, email):
        """邮箱 → 可用的登录账号行（未登记 / 已停用统一提示，不区分，避免被用来探测账号）"""
        text = self._text(email).lower()
        if not text:
            raise BizError('请输入登记的邮箱')
        if not mail_client.RE_EMAIL.match(text):
            raise BizError('邮箱格式不正确，请填写形如 name@example.com 的邮箱')
        row = query_one(
            'SELECT u.`id`, u.`account`, u.`enabled`, u.`password`, e.`nameCn` AS `empName`, '
            '       e.`email` AS `email` '
            'FROM `empinfos` e JOIN `useinfo` u ON u.`empId` = e.`id` '
            'WHERE LOWER(e.`email`) = %s ORDER BY u.`enabled` DESC, e.`status` ASC LIMIT 1', (text,))
        if not row:      # 兼容「账号本身就是邮箱」的老数据
            row = query_one(
                'SELECT u.`id`, u.`account`, u.`enabled`, u.`password`, '
                '       u.`account` AS `empName`, u.`account` AS `email` '
                'FROM `useinfo` u WHERE LOWER(u.`account`) = %s LIMIT 1', (text,))
        if not row or int(row.get('enabled') or 0) != 1:
            raise BizError('该邮箱未在系统中登记（或对应账号已停用），请确认后重试或联系系统管理员')
        return row

    def _consume_code(self, email, code):
        """校验邮箱验证码：错误累加次数（≥5 作废），通过即作废"""
        text = self._text(code)
        if not text:
            raise BizError('请输入邮箱验证码')
        if not re.match(r'^\d{6}$', text):
            raise BizError('邮箱验证码是 6 位数字')
        with _EMAIL_CODE_LOCK:
            self._purge_codes()
            item = _EMAIL_CODE_STORE.get(email)
            if not item:
                raise BizError('请先点击「发送验证码」获取邮箱验证码')
            tries = int(item.get('tries') or 0)
            if tries >= EMAIL_CODE_MAX_TRIES:
                _EMAIL_CODE_STORE.pop(email, None)
                raise BizError('验证码错误次数过多，请重新获取')
            if str(item.get('code')) != text:
                item['tries'] = tries + 1
                left = EMAIL_CODE_MAX_TRIES - item['tries']
                if left <= 0:
                    _EMAIL_CODE_STORE.pop(email, None)
                    raise BizError('验证码错误次数过多，请重新获取')
                raise BizError('验证码不正确，还可以再试 %d 次' % left)
            _EMAIL_CODE_STORE.pop(email, None)          # 校验通过：一次性，立即作废

    def sendcode(self, params):
        """
        忘记密码第一步：往「用户登记的邮箱」发一个 6 位数字验证码
          · 邮箱未登记 / 账号已停用 → 明确提示（否则用户无从排错）；
          · 系统没有启用服务信箱 → 提示去「服务信箱设置」启用；
          · 验证码只存在内存（5 分钟），响应里不回显验证码（只有打码后的邮箱）。
        :return {sent, emailMask, expireIn, mailbox, name}
        """
        params = params or {}
        email = self._text(params.get('email')).lower()
        target = self._account_by_email(email)        # 顺带校验格式 + 是否已登记
        acc = mail_service._enabled_account()          # 服务信箱未启用会给出引导文案
        now_ts = time.time()
        with _EMAIL_CODE_LOCK:
            self._purge_codes()
            old = _EMAIL_CODE_STORE.get(email)
            if old and (now_ts - float(old.get('sentAt') or 0)) < EMAIL_CODE_INTERVAL:
                wait = int(EMAIL_CODE_INTERVAL - (now_ts - float(old.get('sentAt') or 0))) + 1
                raise BizError('验证码发送过于频繁，请 %d 秒后再试' % wait)
            code = '%06d' % random.randint(0, 999999)
            _EMAIL_CODE_STORE[email] = {'code': code, 'expire': now_ts + EMAIL_CODE_TTL,
                                        'sentAt': now_ts, 'tries': 0}
        body = ('您好，%s：\n\n'
                '您正在重置「九豆综合管理平台」的登录密码，本次验证码为：\n\n'
                '    %s\n\n'
                '验证码 %d 分钟内有效（同一邮箱 %d 秒内只能发送一次），请勿转发给他人。\n'
                '如非本人操作，请忽略本邮件，并用原密码正常登录。\n\n'
                '—— 九豆综合管理平台 · 系统邮件，请勿直接回复') % (
                    target.get('empName') or target.get('account') or '用户',
                    code, EMAIL_CODE_TTL // 60, EMAIL_CODE_INTERVAL)
        try:
            mail_client.send_mail(acc['email'], acc['password'], acc['hosts'], [email],
                                  '【九豆综合管理平台】找回密码验证码', body, None,
                                  acc['displayName'])
        except mail_client.MailError as exc:
            with _EMAIL_CODE_LOCK:
                _EMAIL_CODE_STORE.pop(email, None)      # 发不出去就别留着验不上的码
            raise BizError('验证码发送失败：%s' % exc.message)
        return {'sent': True, 'emailMask': self._mask_email(email), 'expireIn': EMAIL_CODE_TTL,
                'mailbox': acc['email'], 'name': target.get('empName') or '',
                'account': target.get('account') or ''}

    def resetbyemail(self, params):
        """
        忘记密码第二步：验证码 + 新密码 → 重置密码，并把新密码发回该邮箱
          · 先取服务信箱（没启用就直接拒绝，避免密码改了却发不出邮件）；
          · 重置成功会作废该账号的 token（旧会话立即失效）。
        :return {reset, mailed, emailMask, account, message}
        """
        params = params or {}
        email = self._text(params.get('email')).lower()
        target = self._account_by_email(email)
        acc = mail_service._enabled_account()
        new_password = self._check_new_password(params.get('newPassword'))
        # 先校验密码规则再消费验证码：否则「密码不合规」也会把验证码用掉，用户得重新等 60 秒
        self._consume_code(email, params.get('code'))
        execute('UPDATE `%s` SET `password`=%%s, `token`=NULL, `tokenExpireTime`=NULL WHERE `id`=%%s'
                % self.table, (md5_hex(new_password), target['id']))

        mailed, warn = True, ''
        body = ('您好，%s：\n\n'
                '您的「九豆综合管理平台」登录密码已重置，新密码为：\n\n'
                '    %s\n\n'
                '登录账号：%s\n'
                '请登录后尽快到右上角「改密」把密码改成你自己好记的密码。\n'
                '如非本人操作，请立即联系系统管理员。\n\n'
                '—— 九豆综合管理平台 · 系统邮件，请勿直接回复') % (
                    target.get('empName') or target.get('account') or '用户',
                    new_password, target.get('account') or '')
        try:
            mail_client.send_mail(acc['email'], acc['password'], acc['hosts'], [email],
                                  '【九豆综合管理平台】登录密码已重置', body, None,
                                  acc['displayName'])
        except mail_client.MailError as exc:
            mailed, warn = False, exc.message
        return {'reset': True, 'mailed': mailed, 'emailMask': self._mask_email(email),
                'account': target.get('account') or '', 'message': warn}

    def changepwd(self, params):
        """
        登录后自助修改密码（原密码 + 新密码）
          · 用户由 token 反查（app.py 的 require_login 已把 _loginUserId 放进参数）；
          · 改完立即作废 token，前端收到 logout=true 后清本地登录态回登录页。
        :return {changed, logout, account, message}
        """
        params = params or {}
        user_id = self._text(params.get('_loginUserId'))
        token = self._text(params.get('token'))
        row = None
        if user_id:
            row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.table, (user_id,))
        elif token:
            row = query_one('SELECT * FROM `%s` WHERE `token`=%%s LIMIT 1' % self.table, (token,))
        if not row:
            raise BizError('登录已失效，请重新登录', 401)
        old_password = self._text(params.get('oldPassword'))
        if not old_password:
            raise BizError('请输入原密码')
        current = str(row.get('password') or '').strip().lower()
        if md5_hex(old_password) != current:
            raise BizError('原密码不正确')
        new_password = self._check_new_password(params.get('newPassword'))
        if md5_hex(new_password) == current:
            raise BizError('新密码不能与原密码相同')
        execute('UPDATE `%s` SET `password`=%%s, `token`=NULL, `tokenExpireTime`=NULL WHERE `id`=%%s'
                % self.table, (md5_hex(new_password), row['id']))
        return {'changed': True, 'logout': True, 'account': row.get('account') or '',
                'message': '密码已修改，请用新密码重新登录'}


auth_service = AuthService()


class DptMgrService(object):
    """
    部门负责人设置（dptmgrset）：把 OrganizationStructure.id 与 empinfos.id 关联起来
      · 一个部门只能有一个负责人：deptId 唯一索引 + set 时按 deptId upsert（重复设置即替换为新人）
      · 校验：部门必须存在、员工必须存在；备注选填
      · 读取端不在这里：部门列表 / 详情（/api/org/*）已由 OrgService 关联出
        managerId / managerName / managerCode / managerJob / managerStatus
    """

    table = 'dptmgrset'
    label = '部门负责人'

    @staticmethod
    def _int_of(value, name):
        try:
            return int(value)
        except (TypeError, ValueError):
            raise BizError(name + '不合法')

    @staticmethod
    def _text_of(value):
        return '' if value is None else str(value).strip()

    # ---------------- 查询（按部门维度列出已设置的负责人） ----------------
    def page(self, params):
        keyword = self._text_of(params.get('keyword')).lower()
        rows = query_all(
            'SELECT s.`id`, s.`deptId`, s.`empId`, s.`remark`, s.`createTime`, s.`updateTime`, '
            '       d.`code` AS deptCode, d.`nameCn` AS deptName, '
            '       e.`code` AS empCode, e.`nameCn` AS empName, e.`jobTitle`, e.`status` '
            'FROM `dptmgrset` s '
            'LEFT JOIN `OrganizationStructure` d ON d.`id` = s.`deptId` '
            'LEFT JOIN `empinfos` e ON e.`id` = s.`empId` '
            'ORDER BY s.`deptId` ASC')
        out = []
        for r in rows:
            item = dict(r)
            item['id'] = int(item['id'])
            item['deptId'] = int(item['deptId'])
            item['empId'] = int(item['empId'])
            item['status'] = int(item['status']) if item.get('status') is not None else -1
            item['statusText'] = EMP_STATUS_TEXT.get(item['status'], '')
            if keyword:
                blob = ' '.join([str(item.get('deptCode') or ''), str(item.get('deptName') or ''),
                                 str(item.get('empCode') or ''), str(item.get('empName') or '')]).lower()
                if keyword not in blob:
                    continue
            out.append(item)
        return {'list': out, 'total': len(out)}

    def by_dept(self, dept_id):
        rows = self.page({}).get('list') or []
        for item in rows:
            if item['deptId'] == int(dept_id):
                return item
        return None

    # ---------------- 设置 / 替换负责人 ----------------
    def set_manager(self, params):
        dept_id = self._int_of(params.get('deptId'), '部门 id')
        emp_id = self._int_of(params.get('empId'), '员工 id')
        dept = query_one('SELECT `id`, `nameCn` FROM `OrganizationStructure` WHERE `id`=%s', (dept_id,))
        if not dept:
            raise BizError('部门不存在或已被删除')
        emp = query_one('SELECT `id`, `nameCn`, `status` FROM `empinfos` WHERE `id`=%s', (emp_id,))
        if not emp:
            raise BizError('员工不存在或已被删除')
        remark = self._text_of(params.get('remark')) or None
        # deptId 唯一：已存在则替换负责人（一个部门始终只有一条记录）
        execute(
            'INSERT INTO `dptmgrset` (`deptId`, `empId`, `remark`) VALUES (%s, %s, %s) '
            'ON DUPLICATE KEY UPDATE `empId`=VALUES(`empId`), `remark`=VALUES(`remark`)',
            (dept_id, emp_id, remark))
        return self.by_dept(dept_id)

    # ---------------- 清除负责人 ----------------
    def delete(self, params):
        dept_id = params.get('deptId')
        if dept_id is not None and str(dept_id).strip() != '':
            row = query_one('SELECT * FROM `dptmgrset` WHERE `deptId`=%s',
                            (self._int_of(dept_id, '部门 id'),))
        else:
            row = query_one('SELECT * FROM `dptmgrset` WHERE `id`=%s',
                            (self._int_of(params.get('id'), '参数 id'),))
        if not row:
            raise BizError('该部门还没有设置负责人', 404)
        execute('DELETE FROM `dptmgrset` WHERE `id`=%s', (row['id'],))
        return dump_row(row)


dpt_mgr_service = DptMgrService()


def _nav_sort_key(row):
    """
    左侧导航统一排序键：先按「排序号」升序，同序号再按 id 升序（保证顺序稳定、可复现）
      · 菜单组：menugroupinfos.sortNo（同级排序号）
      · 菜单项：menugroupitemset.sortNo（该菜单项在组内的显示序号）
    容错：sortNo 为 None / 空串 / 非数字时按 0 处理。
    """
    def _int(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0
    return (_int(row.get('sortNo')), _int(row.get('id')))


def _nav_roles(params):
    """
    解析导航的「权限主体」：返回 (role_ids, role_names, scope)
      · token：当前登录用户的 usergroup.id 集合（只取启用状态的角色）——框架页正常走的路径
      · roleId：直接指定一个角色（角色权限配置页调试 / 自动化测试用）
      · 两者都没有：拒绝（401），避免未登录就能拿到完整菜单
      · token 无效（不在 useinfo 里）：401，前端据此清登录态回登录页
      · 用户存在但没有任何启用角色：role_ids 为空 → 导航为空（提示未分配权限）
    scope 取值：'token' / 'role'
    """
    params = params or {}
    # 令牌来源：前端把 token 放在参数里；app.py 的 require_login 通过请求头校验后写 `_token`，
    # 这里一并认，避免「头传 token 的调用方拿导航必 401」这种与其它接口不一致的行为。
    token = str(params.get('token') or params.get('_token') or '').strip()
    role_id = '' if params.get('roleId') is None else str(params.get('roleId')).strip().lower()

    # 先验登录：导航同样属于「读数据库」，必须带有效 token
    if not token:
        raise BizError('缺少登录凭证（token），请先登录', 401)
    row = query_one('SELECT `id` FROM `useinfo` WHERE `token`=%s LIMIT 1', (token,))
    if not row:
        raise BizError('登录已失效，请重新登录', 401)

    # roleId：管理员「按角色预览该角色的菜单」（可选，需登录才可用）
    if role_id:
        if not RE_UUID.match(role_id):
            raise BizError('参数 roleId 不合法（应为 UUID）')
        role = query_one('SELECT `id`, `nameCn`, `enabled` FROM `usergroup` WHERE `id`=%s', (role_id,))
        if not role:
            raise BizError('角色不存在或已被删除', 404)
        if not int(role.get('enabled') or 0):
            return [], ['%s（已停用）' % role['nameCn']], 'role'
        return [str(role['id'])], [role['nameCn']], 'role'

    rows = query_all(
        'SELECT g.`id`, g.`nameCn` FROM `useinforoleset` r '
        'JOIN `usergroup` g ON g.`id` = r.`roleId` '
        'WHERE r.`userId`=%s AND g.`enabled`=1 ORDER BY g.`sortNo` ASC, g.`id` ASC',
        (row['id'],))
    return [str(x['id']) for x in rows], [x['nameCn'] for x in rows], 'token'


# 「账号自助」类菜单项：所有登录用户都必须能看到，**不参与角色菜单授权**
# （帮助中心 → 修改密码 edituserpwd.html：任何角色、甚至没分配角色的账号，都要能改自己的密码）
NAV_ALWAYS_PATHS = ('edituserpwd.html',)


def _nav_granted(role_ids, binds):
    """
    角色已授权的菜单项集合：{(menuGroupId, menuItemId)}
      · 只取启用状态的授权行（usergrouppowerset.enabled=1）
      · menuItemId=0 表示「整组授权」→ 展开成该组当前绑定的全部菜单项（防御历史数据）
    """
    granted = set()
    if not role_ids:
        return granted
    holders = ','.join(['%s'] * len(role_ids))
    rows = query_all('SELECT `menuGroupId`,`menuItemId` FROM `usergrouppowerset` '
                     'WHERE `enabled`=1 AND `roleId` IN (%s)' % holders, list(role_ids))
    for row in rows:
        gid = int(row['menuGroupId'])
        iid = int(row['menuItemId'] or 0)
        if iid == 0:
            for it in binds.get(gid, []):
                granted.add((gid, int(it['id'])))
        else:
            granted.add((gid, iid))
    return granted


def build_nav(params=None):
    """
    左侧导航数据：按「菜单组树 + 菜单组项目绑定关系」生成（只含启用状态），
    并**按当前登录用户所属角色的菜单权限过滤**（usergroup → useinforoleset → usergrouppowerset）
    规则：
      - 权限主体：token（当前登录用户，取其启用角色并集）/ roleId（指定角色）；两者都没有 → 401
      - 只保留「被授权」的菜单项；没有可见菜单项的菜单组、以及其下无可见子节点的菜单组会被裁掉
      - 菜单组按 parentId / sortNo 组成多级树，每个节点带 children（下级菜单组）与 items（绑定的菜单项）
      - 同级菜单组按 sortNo 升序（同序号按 id），组内菜单项按绑定关系的 sortNo（显示序号）升序
      - hasChild=1（可否绑定菜单项=是）的节点才挂载菜单项，其 items 由前端渲染为可点击叶子项
      - hasChild=0 的节点自身作为叶子项，path 非空即可点击（需该组被授权才保留）
      - crumb 为该节点在导航中的层级路径（如「系统管理/菜单配置/菜单项管理」），供框架页底栏直接显示
    """
    params = params or {}
    role_ids, role_names, scope = _nav_roles(params)
    group_rows = query_all(
        'SELECT `id`,`parentId`,`level`,`sortNo`,`code`,`nameCn`,`nameEn`,`hasChild`,`path`,`icon` '
        'FROM `menugroupinfos` WHERE `enabled`=1 ORDER BY `level`,`sortNo`,`id`')
    item_rows = query_all(
        'SELECT `id`,`code`,`nameCn`,`nameEn`,`path`,`icon` '
        'FROM `menuinfros` WHERE `enabled`=1 ORDER BY `id`')
    link_rows = query_all(
        'SELECT `groupId`,`itemId`,`sortNo` '
        'FROM `menugroupitemset` WHERE `enabled`=1 ORDER BY `groupId`,`sortNo`,`id`')

    item_map = dict((int(r['id']), r) for r in item_rows)

    # 菜单组 → 菜单项（按显示序号排序）
    binds = {}
    for link in link_rows:
        item = item_map.get(int(link['itemId']))
        if not item:
            continue                       # 绑定了已删除 / 已停用的菜单项，忽略
        binds.setdefault(int(link['groupId']), []).append({
            'id': int(item['id']),
            'code': item['code'],
            'nameCn': item['nameCn'],
            'nameEn': item['nameEn'],
            'path': item['path'] or '',
            'icon': item['icon'] or '',
            'sortNo': int(link['sortNo']),
            'groupId': int(link['groupId']),
            'crumb': ''
        })
    for group_id in binds:                       # 组内菜单项：按显示序号（sortNo）升序
        binds[group_id].sort(key=_nav_sort_key)

    nodes = {}
    for r in group_rows:
        nodes[int(r['id'])] = {
            'id': int(r['id']),
            'parentId': int(r['parentId']),
            'level': int(r['level']),
            'sortNo': int(r['sortNo']),
            'code': r['code'],
            'nameCn': r['nameCn'],
            'nameEn': r['nameEn'],
            'icon': r['icon'] or '',
            'hasChild': 1 if int(r['hasChild']) else 0,
            'path': r['path'] or '',
            'crumb': '',
            'children': [],
            'items': []
        }

    roots = []
    for node in nodes.values():
        parent = nodes.get(node['parentId'])
        if parent and parent['id'] != node['id']:
            parent['children'].append(node)
        else:
            roots.append(node)

    def sort_tree(list_):
        list_.sort(key=_nav_sort_key)            # 同级菜单组：按排序号（sortNo）升序，逐层递归
        for n in list_:
            sort_tree(n['children'])

    sort_tree(roots)

    def fill(node, prefix):
        node['crumb'] = (prefix + '/' + node['nameCn']) if prefix else node['nameCn']
        node['items'] = binds.get(node['id'], []) if node['hasChild'] else []
        for it in node['items']:
            it['crumb'] = node['crumb'] + '/' + it['nameCn']
        for child in node['children']:
            fill(child, node['crumb'])

    for root in roots:
        fill(root, '')

    # ---- 按角色菜单权限过滤：只留被授权的菜单项 ----
    granted = _nav_granted(role_ids, binds)
    # 常驻菜单项（账号自助能力）不受授权管控：真实登录时无条件放行；
    # 管理员「按角色预览」（scope=role）仍严格按授权显示，保证预览与该角色授权树一致。
    if scope == 'token':
        for gid, items in binds.items():
            for it in items:
                if str(it.get('path') or '').strip().lower() in NAV_ALWAYS_PATHS:
                    granted.add((int(gid), int(it['id'])))
    for gid in list(nodes.keys()):
        nodes[gid]['items'] = [it for it in (nodes[gid]['items'] or [])
                               if (gid, int(it['id'])) in granted]

    def prune(list_):
        """自底向上裁剪：没有可见菜单项 / 可见子节点的菜单组不再出现在导航里"""
        out = []
        for n in list_:
            n['children'] = prune(n['children'])
            gid = int(n['id'])
            if n['hasChild']:
                keep = bool(n['items']) or bool(n['children'])
            else:
                keep = bool(n['items']) or bool(n['children']) or ((gid, 0) in granted) or \
                       any(g == gid for g, _ in granted)
            if keep:
                out.append(n)
        return out

    roots = prune(roots)

    def count_visible(list_):
        total = 0
        for n in list_:
            total += len(n.get('items') or [])
            total += count_visible(n.get('children') or [])
        return total

    def count_groups(list_):
        total = 0
        for n in list_:
            total += 1 + count_groups(n.get('children') or [])
        return total

    visible_items = count_visible(roots)
    return {
        'groups': roots,
        'groupCount': count_groups(roots),
        'menuCount': visible_items,
        'bindCount': visible_items,
        'roleIds': [str(x) for x in role_ids],
        'roleNames': '、'.join(role_names),
        'scope': scope,
        'scoped': True,
        'empty': visible_items == 0
    }

# ===================== 用户角色（usergroup，UUID 主键） =====================
ROLE_FIELDS = ['id', 'nameCn', 'nameEn', 'remark', 'sortNo', 'enabled']

# UUID 校验：标准 36 位带连字符格式
RE_UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')

# 唯一索引冲突（角色名为空 UUID 占位值，避免 id<>0 的数值比较问题）
EMPTY_UUID = '00000000-0000-0000-0000-000000000000'


# 英文名规则：字母开头，字母 / 数字 / 下划线，1-100 位
RE_ROLE_NAME_EN = re.compile(r'^[A-Za-z][A-Za-z0-9_]{0,99}$')


class RoleService(CrudService):
    """
    用户角色（表 usergroup）
      · 主键 id 为 UUID（CHAR(36)，非自增），新增时由服务端 uuid4() 生成，前端不可指定
      · nameCn 中文名：必填，**仅在启用状态（enabled=1）内唯一**（停用状态可重名，也可复用启用角色的名字）
      · nameEn 英文名：必填，**全局唯一**
      · remark 说明；sortNo 排序号（列表按此升序）；enabled 启用否
      · 主键是字符串，因此重写检索条件与 id 相关方法（detail / check / add / update / delete）
      · 表里另有生成列 nameCnActive（enabled=1 时等于 nameCn，否则 NULL）+ 唯一索引，作为「启用状态内唯一」的库级兜底
    """

    ORDER_BY = '`sortNo` ASC, `id` ASC'
    MAX_SORT_NO = 9999

    # 生成列不参与接口输出
    SERIALIZE_SKIP = ('nameCnActive', 'nameCn_active')

    # ---------------- 序列化（剔除生成列） ----------------
    def _serialize(self, row):
        data = super(RoleService, self)._serialize(row)
        if data:
            for key in self.SERIALIZE_SKIP:
                data.pop(key, None)
        return data

    # ---------------- 中文名「启用状态内唯一」 ----------------
    def _enabled_name_conflict(self, name, enabled, self_id=''):
        """启用状态下同名的其它角色（停用不参与）；返回冲突行或 None"""
        enabled_flag = enabled if isinstance(enabled, bool) else bool(self._to_int(enabled))
        if not enabled_flag:
            return None
        return query_one(
            'SELECT `id`,`nameCn` FROM `%s` WHERE `nameCn`=%%s AND `enabled`=1 AND `id`<>%%s LIMIT 1'
            % self.table, (name, self_id or EMPTY_UUID))

    def _assert_name_cn_unique(self, data, self_id=''):
        """中文名：仅当本记录为启用状态时才需要与其它启用角色比较（停用可重名）"""
        name = self._text(data.get('nameCn'))
        if not name:
            return
        if 'enabled' in data:
            enabled = bool(self._to_int(data.get('enabled')))
        else:      # 局部更新未带 enabled：按库中当前状态判断
            row = query_one('SELECT `enabled` FROM `%s` WHERE `id`=%%s' % self.table,
                            (self_id,)) if self_id else None
            enabled = bool(int(row['enabled'])) if row else True
        if self._enabled_name_conflict(name, enabled, self_id):
            raise BizError('中文名【%s】已被其它启用状态的角色使用；如需同名，请先停用对方或本角色' % name)

    # ---------------- UUID 工具 ----------------
    def _uuid_of(self, value, allow_empty=False):
        text = self._text(value)
        if not text:
            if allow_empty:
                return ''
            raise BizError('参数 id 不合法（应为 UUID）')
        if not RE_UUID.match(text):
            raise BizError('参数 id 不合法（应为 UUID）')
        return text.lower()

    # ---------------- 检索 ----------------
    def _build_where(self, params):
        """检索条件：关键字（角色名 / 说明 / 角色ID）+ 启用状态"""
        clauses = []
        args = []
        keyword = self._text(params.get('keyword'))
        if keyword:
            clauses.append('(`nameCn` LIKE %s OR `nameEn` LIKE %s OR `remark` LIKE %s OR `id` LIKE %s)')
            like = '%' + keyword + '%'
            args.extend([like, like, like, like])
        enabled = params.get('enabled')
        if enabled is not None and str(enabled).strip() != '':
            clauses.append('`enabled`=%s')
            args.append(self._to_int(enabled))
        where = (' WHERE ' + ' AND '.join(clauses)) if clauses else ''
        return where, args

    # ---------------- 单条 / 查重 ----------------
    def detail(self, params):
        return self._serialize(self._find_by_id(self._uuid_of(params.get('id'))))

    def check(self, params):
        field = self._text(params.get('field'))
        allowed = [f for f, _ in self.unique_fields] + ['nameCn']
        if field not in allowed:
            raise BizError('不支持的唯一性校验字段：' + field)
        value = self._text(params.get('value'))
        if not value:
            return {'unique': True}
        self_id = self._uuid_of(params.get('id'), allow_empty=True) or EMPTY_UUID

        if field == 'nameCn':
            # 中文名：只在「本角色为启用状态」时才与其它启用角色比较（停用可重名）
            enabled = params.get('enabled')
            enabled = True if enabled is None or str(enabled).strip() == '' else bool(self._to_int(enabled))
            if not enabled:
                return {'unique': True}
            return {'unique': self._enabled_name_conflict(value, True, self_id) is None}

        row = query_one(
            'SELECT `id` FROM `%s` WHERE `%s`=%%s AND `id`<>%%s LIMIT 1' % (self.table, field),
            (value, self_id))
        return {'unique': row is None}

    # ---------------- 保存钩子 ----------------
    def before_save(self, data, id_value):
        name = self._text(data.get('nameCn'))
        if not name:
            raise BizError('中文名不能为空')
        if len(name) > 50:
            raise BizError('中文名不能超过 50 个字符')
        data['nameCn'] = name

        name_en = self._text(data.get('nameEn'))
        if not name_en:
            raise BizError('英文名不能为空')
        if not RE_ROLE_NAME_EN.match(name_en):
            raise BizError('英文名需以字母开头，只能包含字母、数字、下划线（最长 100 位）')
        data['nameEn'] = name_en

        remark = self._text(data.get('remark'))
        if len(remark) > 200:
            raise BizError('说明不能超过 200 个字符')
        data['remark'] = remark or None

        raw = data.get('sortNo')
        if raw is None or str(raw).strip() == '':
            sort_no = 0
        else:
            try:
                sort_no = int(raw)
            except (TypeError, ValueError):
                raise BizError('排序号必须是整数')
        if sort_no < 0 or sort_no > self.MAX_SORT_NO:
            raise BizError('排序号为 0-%d 之间的整数' % self.MAX_SORT_NO)
        data['sortNo'] = sort_no

        if 'enabled' in data:
            data['enabled'] = self._to_int(data.get('enabled'))

        if not id_value:
            data['id'] = str(uuid.uuid4())      # 新增：服务端生成 UUID 主键
        else:
            data.pop('id', None)                # 主键不允许修改

    # ---------------- 增删改（id 为字符串，不能复用父类的 int(id)） ----------------
    def add(self, data):
        data = dict(data or {})
        self.before_save(data, None)
        self._validate_required(data)
        self._assert_name_cn_unique(data, data.get('id') or EMPTY_UUID)
        self._validate_unique(data, data.get('id') or EMPTY_UUID)
        picked = self._pick(data)
        if not picked:
            raise BizError('没有可保存的字段')
        columns = ','.join('`%s`' % c for c in picked.keys())
        holders = ','.join(['%s'] * len(picked))
        try:
            execute('INSERT INTO `%s` (%s) VALUES (%s)' % (self.table, columns, holders),
                    list(picked.values()))
        except DuplicateError:
            raise BizError(DEFAULT_DUP_MESSAGE)
        return self._serialize(self._find_by_id(picked['id']))

    def update(self, data):
        data = dict(data or {})
        id_value = self._uuid_of(data.get('id'))
        self._find_by_id(id_value)
        self.before_save(data, id_value)
        self._validate_required(data)
        self._assert_name_cn_unique(data, id_value)
        self._validate_unique(data, id_value)
        picked = self._pick(data)
        if not picked:
            raise BizError('没有可更新的字段')
        assignments = ','.join('`%s`=%%s' % c for c in picked.keys())
        try:
            execute('UPDATE `%s` SET %s WHERE `id`=%%s' % (self.table, assignments),
                    list(picked.values()) + [id_value])
        except DuplicateError:
            raise BizError(DEFAULT_DUP_MESSAGE)
        return self._serialize(self._find_by_id(id_value))

    def delete(self, data):
        id_value = self._uuid_of(data.get('id'))
        row = self._find_by_id(id_value)
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.table, (id_value,))
        # 级联清理该角色的授权（菜单权限 + 按钮权限，避免留下孤儿记录）
        try:
            execute('DELETE FROM `usergrouppowerset` WHERE `roleId`=%s', (id_value,))
        except Exception:
            pass
        try:
            execute('DELETE FROM `usergrouppagebtnset` WHERE `roleId`=%s', (id_value,))
        except Exception:
            pass
        return self._serialize(row)


role_service = RoleService(
    table='usergroup',
    label='角色',
    fields=ROLE_FIELDS,
    bool_fields=['enabled'],
    unique_fields=[('nameEn', '英文名')],
    required=[('nameCn', '中文名'), ('nameEn', '英文名')],
)


# ===================== 角色权限（usergrouppowerset，UUID 主键） =====================
ROLE_POWER_FIELDS = ['id', 'roleId', 'menuGroupId', 'menuItemId', 'enabled', 'remark']


class RolePowerService(object):
    """
    角色权限（表 usergrouppowerset）
      · 一行 = 一个角色 对 某个菜单组下某个菜单项 的授权
      · id 为 UUID（CHAR(36)，非自增），新增时服务端 uuid4() 生成
      · roleId → usergroup.id；menuGroupId → menugroupinfos.id；menuItemId → menuinfros.id
        menuItemId = 0 表示「整组授权」，保存时展开为该组已绑定的全部菜单项
      · 保存采用「全量替换」：先删该角色的旧授权，再按提交结果批量写入（同一事务）
    """

    table = 'usergrouppowerset'
    label = '角色权限'

    # 页面按钮授权表（角色 ↔ pageopbtn）
    BTN_TABLE = 'usergrouppagebtnset'

    # ---------------- 内部工具 ----------------
    def _uuid_of(self, value):
        text = '' if value is None else str(value).strip()
        if not text:
            raise BizError('参数 roleId 不能为空（应为角色 UUID）')
        if not RE_UUID.match(text):
            raise BizError('参数 roleId 不合法（应为 UUID）')
        return text.lower()

    def _role_of(self, role_id):
        row = query_one('SELECT `id`, `nameCn`, `nameEn`, `enabled` FROM `usergroup` WHERE `id`=%s',
                        (role_id,))
        if not row:
            raise BizError('角色不存在或已被删除', 404)
        return row

    @staticmethod
    def _menu_maps():
        """菜单组 / 菜单项 / 绑定关系（只取启用状态），返回三份字典"""
        groups = {}
        for row in query_all('SELECT `id`,`parentId`,`level`,`sortNo`,`code`,`nameCn` '
                             'FROM `menugroupinfos` WHERE `enabled`=1 ORDER BY `level`,`sortNo`,`id`'):
            groups[int(row['id'])] = {
                'menuGroupId': int(row['id']),
                'parentId': int(row['parentId'] or 0),
                'level': int(row['level'] or 1),
                'sortNo': int(row['sortNo'] or 0),
                'code': row['code'],
                'nameCn': row['nameCn']
            }
        items = {}
        for row in query_all('SELECT `id`,`code`,`nameCn`,`path`,`sortNo` '
                             'FROM `menuinfros` WHERE `enabled`=1 ORDER BY `sortNo`,`id`'):
            items[int(row['id'])] = {
                'menuItemId': int(row['id']),
                'code': row['code'],
                'nameCn': row['nameCn'],
                'path': row['path'] or '',
                'sortNo': int(row['sortNo'] or 0)
            }
        binds = []          # [(groupId, itemId, sortNo)]，按组内显示序号升序
        for row in query_all('SELECT `groupId`,`itemId`,`sortNo` FROM `menugroupitemset` '
                             'WHERE `enabled`=1 ORDER BY `groupId`,`sortNo`,`id`'):
            gid, iid = int(row['groupId']), int(row['itemId'])
            if gid in groups and iid in items:
                binds.append((gid, iid, int(row['sortNo'] or 0)))
        return groups, items, binds

    @staticmethod
    def _sort_chain(groups, gid):
        """从根到自身的排序号链（如 [97, 1]），用于让权限树的顺序与左侧菜单一致"""
        chain = []
        seen = set()
        cur = gid
        while cur and cur in groups and cur not in seen:
            seen.add(cur)
            chain.insert(0, groups[cur]['sortNo'])
            cur = groups[cur]['parentId']
        return tuple(chain)

    @classmethod
    def _tree_order(cls, groups, ids):
        """按「祖先链排序号」字典序排列 → 天然得到父在前、子在后、同级按排序号的导航顺序"""
        return sorted(ids, key=lambda g: (cls._sort_chain(groups, g), g))

    @staticmethod
    def _group_path(groups, gid):
        """菜单组的层级路径（如「系统管理/菜单管理」）"""
        names = []
        seen = set()
        cur = gid
        while cur and cur in groups and cur not in seen:
            seen.add(cur)
            names.insert(0, groups[cur]['nameCn'])
            cur = groups[cur]['parentId']
        return '/'.join(names)

    @staticmethod
    def _button_map():
        """页面操作按钮：按 pagePath 分组（只取启用且页面里仍存在的按钮），供权限树挂到各管理页下"""
        rows = query_all(
            'SELECT `id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo`,`enabled`,`remark` '
            'FROM `pageopbtn` ORDER BY `pagePath`,`sortNo`,`id`')
        out = {}
        for row in rows:
            if not int(row['enabled'] or 0):
                continue
            if '页面中已不存在' in (row['remark'] or ''):
                continue
            out.setdefault(row['pagePath'], []).append({
                'pageOpBtnId': str(row['id']),
                'btnId': row['btnId'],
                'btnText': row['btnText'],
                'sortNo': int(row['sortNo'] or 0)
            })
        return out

    # ---------------- 列表（扁平：该角色的全部授权记录） ----------------
    def page(self, params):
        role_id = self._uuid_of(params.get('roleId'))
        role = self._role_of(role_id)
        rows = query_all(
            'SELECT p.`id`, p.`roleId`, p.`menuGroupId`, p.`menuItemId`, p.`enabled`, p.`remark`, '
            '       p.`createTime`, p.`updateTime` '
            'FROM `usergrouppowerset` p WHERE p.`roleId`=%s '
            'ORDER BY p.`menuGroupId`, p.`menuItemId`', (role_id,))
        groups, items, _binds = self._menu_maps()
        out = []
        for row in rows:
            item = dump_row(row)
            item['id'] = str(item['id'])
            item['roleId'] = str(item['roleId'])
            item['menuGroupId'] = int(item['menuGroupId'])
            item['menuItemId'] = int(item['menuItemId'])
            item['enabled'] = bool(int(item.get('enabled') or 0))
            gid = item['menuGroupId']
            item['menuGroupName'] = (groups.get(gid) or {}).get('nameCn', '')
            item['menuGroupPath'] = self._group_path(groups, gid)
            item['menuItemName'] = (items.get(item['menuItemId']) or {}).get('nameCn', '')
            item['menuItemPath'] = (items.get(item['menuItemId']) or {}).get('path', '')
            out.append(item)
        return {'list': out, 'total': len(out),
                'roleId': role_id, 'roleName': role['nameCn'], 'roleEnabled': bool(int(role['enabled'] or 0))}

    # ---------------- 权限树（菜单组 → 菜单项(页面) → 操作按钮，带勾选状态） ----------------
    def tree(self, params):
        role_id = self._uuid_of(params.get('roleId'))
        role = self._role_of(role_id)
        keyword = '' if params.get('keyword') is None else str(params.get('keyword')).strip().lower()

        groups, items, binds = self._menu_maps()
        checked = set()
        for row in query_all('SELECT `menuGroupId`,`menuItemId` FROM `usergrouppowerset` '
                             'WHERE `roleId`=%s AND `enabled`=1', (role_id,)):
            checked.add((int(row['menuGroupId']), int(row['menuItemId'])))

        # 页面按钮：pagePath → [{pageOpBtnId, btnId, btnText}]；以及该角色已授权的按钮
        btn_map = self._button_map()
        btn_checked = set()
        for row in query_all('SELECT `pageOpBtnId` FROM `%s` WHERE `roleId`=%%s AND `enabled`=1'
                             % self.BTN_TABLE, (role_id,)):
            btn_checked.add(str(row['pageOpBtnId']))

        # 组内菜单项（顺序沿用绑定关系的显示序号）
        by_group = {}
        for gid, iid, _sort in binds:
            by_group.setdefault(gid, []).append(iid)

        out_groups = []
        total = 0
        total_checked = 0
        seen_btn = set()          # 同一页面可能挂在多个菜单组下，按钮总数按 id 去重
        seen_btn_checked = set()
        btn_total = 0
        btn_checked_total = 0
        for gid in self._tree_order(groups, by_group.keys()):
            node = groups[gid]
            gpath = self._group_path(groups, gid)
            node_items = []
            for iid in by_group[gid]:
                meta = items[iid]
                is_checked = (gid, iid) in checked
                page_buttons = btn_map.get(meta['path'] or '', [])
                if keyword:
                    blob = (' '.join([gpath, node['nameCn'], meta['nameCn'], meta['code'],
                                      meta['path'],
                                      ' '.join([b['btnId'] + ' ' + b['btnText'] for b in page_buttons])])).lower()
                    if keyword not in blob:
                        continue
                total += 1
                if is_checked:
                    total_checked += 1

                buttons = []
                n_btn_checked = 0
                for b in page_buttons:
                    on = b['pageOpBtnId'] in btn_checked
                    if on:
                        n_btn_checked += 1
                    buttons.append({
                        'pageOpBtnId': b['pageOpBtnId'],
                        'btnId': b['btnId'],
                        'btnText': b['btnText'],
                        'checked': on,
                        # 菜单没有权限时按钮不可用（页面都进不去），前端据此置灰
                        'disabled': not is_checked
                    })
                for b in buttons:
                    if b['pageOpBtnId'] not in seen_btn:
                        seen_btn.add(b['pageOpBtnId'])
                        btn_total += 1
                    if b['checked'] and b['pageOpBtnId'] not in seen_btn_checked:
                        seen_btn_checked.add(b['pageOpBtnId'])
                        btn_checked_total += 1

                node_items.append({
                    'menuItemId': iid,
                    'code': meta['code'],
                    'nameCn': meta['nameCn'],
                    'path': meta['path'],
                    'crumb': gpath + '/' + meta['nameCn'],
                    'checked': is_checked,
                    'buttons': buttons,
                    'buttonCount': len(buttons),
                    'buttonChecked': n_btn_checked
                })
            if not node_items:
                continue            # 关键字过滤后本组无命中项则不展示
            n_checked = len([x for x in node_items if x['checked']])
            out_groups.append({
                'menuGroupId': gid,
                'code': node['code'],
                'nameCn': node['nameCn'],
                'level': node['level'],
                'sortNo': node['sortNo'],
                'crumb': gpath,
                'items': node_items,
                'itemCount': len(node_items),
                'checkedCount': n_checked,
                'checked': n_checked > 0 and n_checked == len(node_items),
                'indeterminate': 0 < n_checked < len(node_items)
            })

        return {
            'roleId': role_id,
            'roleName': role['nameCn'],
            'roleEnabled': bool(int(role['enabled'] or 0)),
            'keyword': keyword,
            'groups': out_groups,
            'total': total,
            'checked': total_checked,
            'groupCount': len(out_groups),
            'buttonTotal': btn_total,
            'buttonChecked': btn_checked_total
        }

    # ---------------- 当前登录角色可用的页面按钮（页面加载时禁掉未授权按钮） ----------------
    def my_buttons(self, params):
        """当前登录用户（可多角色）有权使用的页面操作按钮。

        :return {roleIds, unrestricted, pages: {pagePath: {pageName, buttons:[...]}},
                 buttonTotal, allowedTotal}
        · 用户没有分配任何角色 → unrestricted=True，前端不做限制（避免把管理员锁死）；
        · 某页面在 pageopbtn 里没有登记按钮 → 前端同样按「不限制」处理；
        · 授权取并集（多角色任一角色授权即可用）。
        """
        params = params or {}
        user_id = '' if params.get('_loginUserId') is None else str(params.get('_loginUserId')).strip()
        if not user_id:
            raise BizError('登录已失效，请重新登录', 401)

        role_rows = query_all('SELECT `roleId` FROM `useinforoleset` WHERE `userId`=%s', (user_id,)) or []
        role_ids = [str(r['roleId']) for r in role_rows]

        rows = query_all('SELECT `id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo` '
                         'FROM `pageopbtn` WHERE `enabled`=1 '
                         'ORDER BY `pagePath`,`sortNo`,`id`') or []

        granted = set()
        if role_ids:
            marks = ','.join(['%s'] * len(role_ids))
            sql = ('SELECT DISTINCT `pageOpBtnId` FROM `%s` '
                   'WHERE `enabled`=1 AND `roleId` IN (%s)' % (self.BTN_TABLE, marks))
            for r in (query_all(sql, tuple(role_ids)) or []):
                granted.add(str(r['pageOpBtnId']))

        pages = {}
        for r in rows:
            path = str(r['pagePath'] or '').strip().lower()
            if not path:
                continue
            item = pages.get(path)
            if not item:
                item = {'pageName': str(r['pageName'] or ''), 'buttons': []}
                pages[path] = item
            btn_id = str(r['id'])
            item['buttons'].append({
                'pageOpBtnId': btn_id,
                'btnId': str(r['btnId'] or ''),
                'btnText': str(r['btnText'] or ''),
                'allowed': btn_id in granted
            })

        return {
            'roleIds': role_ids,
            'unrestricted': not role_ids,
            'pages': pages,
            'buttonTotal': len(rows),
            'allowedTotal': len(granted & set(str(r['id']) for r in rows))
        }

    # ---------------- 按钮授权（扁平清单，便于核对 / 导出） ----------------
    def buttons(self, params):
        role_id = self._uuid_of(params.get('roleId'))
        role = self._role_of(role_id)
        rows = query_all(
            'SELECT s.`id`, s.`roleId`, s.`pageOpBtnId`, s.`enabled`, s.`remark`, s.`createTime`, '
            '       b.`pageName`, b.`pagePath`, b.`btnId`, b.`btnText` '
            'FROM `%s` s LEFT JOIN `pageopbtn` b ON b.`id` = s.`pageOpBtnId` '
            'WHERE s.`roleId`=%%s ORDER BY b.`pagePath`, b.`sortNo`' % self.BTN_TABLE, (role_id,))
        out = []
        for row in rows:
            item = dump_row(row)
            item['id'] = str(item['id'])
            item['roleId'] = str(item['roleId'])
            item['pageOpBtnId'] = str(item['pageOpBtnId'])
            item['enabled'] = bool(int(item.get('enabled') or 0))
            out.append(item)
        return {'list': out, 'total': len(out), 'roleId': role_id, 'roleName': role['nameCn']}

    # ---------------- 保存（菜单权限 + 按钮权限，同一事务内全量替换） ----------------
    def save(self, params):
        role_id = self._uuid_of(params.get('roleId'))
        self._role_of(role_id)

        has_items = 'items' in params
        has_buttons = 'buttons' in params
        if not has_items and not has_buttons:
            raise BizError('请至少提交 items（菜单权限）或 buttons（按钮权限）')

        groups, items, binds = self._menu_maps()
        bind_set = set((gid, iid) for gid, iid, _s in binds)
        items_of_group = {}
        for gid, iid, _s in binds:
            items_of_group.setdefault(gid, []).append(iid)

        # ---------- 菜单权限 ----------
        pairs = []
        if has_items:
            raw = params.get('items')
            if raw is None:
                raw = []
            if isinstance(raw, dict):
                raw = [raw]
            if not isinstance(raw, list):
                raise BizError('items 必须是数组：[{menuGroupId, menuItemId}, ...]')
            seen = set()
            for entry in raw:
                if not isinstance(entry, dict):
                    raise BizError('items 的每一项必须是对象：{menuGroupId, menuItemId}')
                try:
                    gid = int(entry.get('menuGroupId'))
                except (TypeError, ValueError):
                    raise BizError('menuGroupId 不合法')
                raw_item = entry.get('menuItemId')
                try:
                    iid = 0 if raw_item is None or str(raw_item).strip() == '' else int(raw_item)
                except (TypeError, ValueError):
                    raise BizError('menuItemId 不合法')
                if gid not in groups:
                    raise BizError('菜单组不存在或已停用（id=%d）' % gid)
                if iid == 0:                      # 整组授权 → 展开为该组全部菜单项
                    for one in items_of_group.get(gid, []):
                        if (gid, one) not in seen:
                            seen.add((gid, one))
                            pairs.append((gid, one))
                    continue
                if iid not in items:
                    raise BizError('菜单项不存在或已停用（id=%d）' % iid)
                if (gid, iid) not in bind_set:
                    raise BizError('菜单项「%s」不属于菜单组「%s」' % (items[iid]['nameCn'], groups[gid]['nameCn']))
                if (gid, iid) in seen:
                    continue
                seen.add((gid, iid))
                pairs.append((gid, iid))

        # ---------- 按钮权限 ----------
        btn_ids = []
        if has_buttons:
            raw_btns = params.get('buttons')
            if raw_btns is None:
                raw_btns = []
            if isinstance(raw_btns, str):
                raw_btns = [x for x in raw_btns.split(',') if x.strip()]
            if not isinstance(raw_btns, list):
                raise BizError('buttons 必须是数组：[pageOpBtnId, ...]')
            alive = set()
            for row in query_all('SELECT `id` FROM `pageopbtn`'):
                alive.add(str(row['id']))
            seen_btn = set()
            for one in raw_btns:
                # 兼容 [{pageOpBtnId: '...'}] 与 ['uuid', ...] 两种写法
                if isinstance(one, dict):
                    bid = str(one.get('pageOpBtnId') or one.get('id') or '').strip().lower()
                else:
                    bid = '' if one is None else str(one).strip().lower()
                if not bid:
                    continue
                if not RE_UUID.match(bid):
                    raise BizError('pageOpBtnId 不合法（应为 UUID）：%s' % bid)
                if bid not in alive:
                    raise BizError('页面操作按钮不存在或已被删除（id=%s）' % bid)
                if bid in seen_btn:
                    continue
                seen_btn.add(bid)
                btn_ids.append(bid)

        # ---------- 同一事务内全量替换 ----------
        def _write(cur):
            if has_items:
                cur.execute('DELETE FROM `usergrouppowerset` WHERE `roleId`=%s', (role_id,))
                if pairs:
                    cur.executemany(
                        'INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`) '
                        'VALUES (%s,%s,%s,%s,1)',
                        [(str(uuid.uuid4()), role_id, gid, iid) for gid, iid in pairs])
            if has_buttons:
                cur.execute('DELETE FROM `%s` WHERE `roleId`=%%s' % self.BTN_TABLE, (role_id,))
                if btn_ids:
                    cur.executemany(
                        'INSERT INTO `%s` (`id`,`roleId`,`pageOpBtnId`,`enabled`) VALUES (%%s,%%s,%%s,1)'
                        % self.BTN_TABLE,
                        [(str(uuid.uuid4()), role_id, bid) for bid in btn_ids])

        transaction(_write)
        return {'roleId': role_id, 'saved': len(pairs) if has_items else None,
                'savedButtons': len(btn_ids) if has_buttons else None}

    # ---------------- 清空（等于全部取消勾选） ----------------
    def clear(self, params):
        role_id = self._uuid_of(params.get('roleId'))
        self._role_of(role_id)

        def _write(cur):
            cur.execute('DELETE FROM `usergrouppowerset` WHERE `roleId`=%s', (role_id,))
            menus = cur.rowcount or 0
            cur.execute('DELETE FROM `%s` WHERE `roleId`=%%s' % self.BTN_TABLE, (role_id,))
            return menus, (cur.rowcount or 0)

        menus, buttons = transaction(_write)
        return {'roleId': role_id, 'deleted': int(menus), 'deletedButtons': int(buttons)}


role_power_service = RolePowerService()



# ===================== 页面操作按钮（pageopbtn，UUID 主键） =====================
PAGE_OP_BTN_FIELDS = ['pageName', 'pagePath', 'btnId', 'btnText', 'sortNo', 'enabled', 'remark']

# 站点根目录（静态页面所在目录），用于扫描 .html 里的操作引导区按钮
WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 扫描发现「页面里已经没有该按钮」时写入的备注前缀
MISSING_TIP = '页面中已不存在'


class PageOpBtnService(object):
    """
    页面操作按钮（表 pageopbtn）
      · 一行 = 某个页面的某个操作按钮（pagePath + btnId 唯一）
      · id 为 UUID（CHAR(36)，非自增），新增时服务端 uuid4() 生成
      · scan()：扫描站点 .html 的 .toolbar / .pick-toolbar / .form-actions，
        自动收录按钮并同步页面标题与按钮文本（已停用状态保持不动）
      · 其余 list / detail / update / delete 为常规维护（pagePath、btnId 不允许改，避免与页面脱节）
    """

    table = 'pageopbtn'
    label = '页面操作按钮'
    ORDER_BY = '`pagePath` ASC, `sortNo` ASC, `id` ASC'
    MAX_TEXT = 60

    # ---------------- 内部工具 ----------------
    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    def _find_by_id(self, id_value):
        row = query_one('SELECT * FROM `%s` WHERE `id`=%%s' % self.table, (id_value,))
        if not row:
            raise BizError(self.label + '不存在或已被删除', 404)
        return row

    @staticmethod
    def _uuid_of(value):
        text = '' if value is None else str(value).strip()
        if not text:
            raise BizError('参数 id 不合法（应为 UUID）')
        if not RE_UUID.match(text):
            raise BizError('参数 id 不合法（应为 UUID）')
        return text.lower()

    @staticmethod
    def _serialize(row):
        data = dump_row(row)
        if not data:
            return None
        data['id'] = str(data['id'])
        data['enabled'] = bool(int(data.get('enabled') or 0))
        data['sortNo'] = int(data.get('sortNo') or 0)
        data['missing'] = MISSING_TIP in (data.get('remark') or '')
        return data

    # ---------------- 查询 ----------------
    def page(self, params):
        params = params or {}
        clauses, args = [], []
        keyword = self._text(params.get('keyword'))
        if keyword:
            clauses.append('(`pageName` LIKE %s OR `pagePath` LIKE %s OR `btnId` LIKE %s OR `btnText` LIKE %s)')
            like = '%' + keyword + '%'
            args.extend([like, like, like, like])
        page_path = self._text(params.get('pagePath'))
        if page_path:
            clauses.append('`pagePath`=%s')
            args.append(page_path)
        raw_enabled = params.get('enabled')
        if raw_enabled is not None and str(raw_enabled).strip() != '':
            clauses.append('`enabled`=%s')
            args.append(1 if str(raw_enabled).strip() in ('1', 'true', 'True') else 0)
        where = (' WHERE ' + ' AND '.join(clauses)) if clauses else ''

        total = int(query_one('SELECT COUNT(*) AS cnt FROM `%s`%s' % (self.table, where), args)['cnt'])
        page_num = max(1, int(params.get('pageNum') or 1))
        page_size = int(params.get('pageSize') or 10)
        page_size = max(1, min(page_size, 200))
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        start = (page_num - 1) * page_size
        rows = query_all('SELECT * FROM `%s`%s ORDER BY %s LIMIT %%s, %%s'
                         % (self.table, where, self.ORDER_BY), args + [start, page_size])
        return {
            'list': [self._serialize(r) for r in rows],
            'total': total, 'pageNum': page_num, 'pageSize': page_size, 'pages': pages
        }

    def detail(self, params):
        return self._serialize(self._find_by_id(self._uuid_of(params.get('id'))))

    def pages(self, params=None):
        """页面下拉：已收录的页面（含启用 / 停用数量）"""
        rows = query_all(
            'SELECT `pagePath`, MAX(`pageName`) AS `pageName`, COUNT(*) AS `total`, '
            '       SUM(CASE WHEN `enabled`=1 THEN 1 ELSE 0 END) AS `enabledCount` '
            'FROM `%s` GROUP BY `pagePath` ORDER BY `pagePath`' % self.table)
        out = []
        for row in rows:
            out.append({
                'pagePath': row['pagePath'],
                'pageName': row['pageName'] or '',
                'total': int(row['total'] or 0),
                'enabledCount': int(row['enabledCount'] or 0)
            })
        return {'list': out, 'total': len(out)}

    # ---------------- 维护（编辑 / 删除） ----------------
    def update(self, params):
        data = dict(params or {})
        id_value = self._uuid_of(data.get('id'))
        row = self._find_by_id(id_value)

        btn_text = self._text(data.get('btnText'))
        if not btn_text:
            raise BizError('操作按钮文本不能为空')
        if len(btn_text) > self.MAX_TEXT:
            raise BizError('操作按钮文本不能超过 %d 个字符' % self.MAX_TEXT)

        page_name = self._text(data.get('pageName')) or row['pageName']
        if len(page_name) > self.MAX_TEXT:
            raise BizError('所属页面不能超过 %d 个字符' % self.MAX_TEXT)

        remark = self._text(data.get('remark'))
        if len(remark) > 200:
            raise BizError('备注不能超过 200 个字符')

        enabled = 1 if str(data.get('enabled', row['enabled'])).strip() in ('1', 'true', 'True') else 0

        execute('UPDATE `%s` SET `pageName`=%%s, `btnText`=%%s, `enabled`=%%s, `remark`=%%s '
                'WHERE `id`=%%s' % self.table,
                (page_name, btn_text, enabled, remark or None, id_value))
        return self._serialize(self._find_by_id(id_value))

    def delete(self, params):
        id_value = self._uuid_of(params.get('id'))
        row = self._find_by_id(id_value)
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.table, (id_value,))
        # 级联清理「角色 ↔ 该按钮」的授权，避免出现指向已删除按钮的孤儿记录
        try:
            execute('DELETE FROM `usergrouppagebtnset` WHERE `pageOpBtnId`=%s', (id_value,))
        except Exception:
            pass
        return self._serialize(row)

    # ---------------- 自动收录（扫描页面） ----------------
    def scan(self, params=None):
        """
        扫描 WEB_ROOT 下所有页面，把操作引导区的按钮收录进表：
          · 新按钮 → 新增（enabled=1）
          · 已有按钮 → 同步页面标题 / 按钮文本 / 顺序；停用状态保持不动
          · 页面里已不存在的按钮 → 仅写备注「页面中已不存在」，不自动停用
        """
        folder = self._text((params or {}).get('webRoot')) or WEB_ROOT
        scanned = page_scan.scan_pages(folder)
        existing = {}
        for row in query_all('SELECT * FROM `%s`' % self.table):
            existing[(row['pagePath'], row['btnId'])] = row

        added = updated = same = 0
        seen = set()
        for item in scanned:
            key = (item['pagePath'], item['btnId'])
            seen.add(key)
            old = existing.get(key)
            if old is None:
                execute('INSERT INTO `%s` (`id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo`,`enabled`,`remark`) '
                        'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,1,%%s)' % self.table,
                        (str(uuid.uuid4()), item['pageName'], item['pagePath'], item['btnId'],
                         item['btnText'], item['sortNo'], None))
                added += 1
                continue
            same_text = (old['pageName'] == item['pageName']
                         and old['btnText'] == item['btnText']
                         and int(old['sortNo'] or 0) == int(item['sortNo']))
            was_missing = MISSING_TIP in (old.get('remark') or '')
            if same_text and not was_missing:
                same += 1
                continue
            execute('UPDATE `%s` SET `pageName`=%%s, `btnText`=%%s, `sortNo`=%%s, `remark`=%s '
                    'WHERE `id`=%%s' % (self.table, 'NULL'),
                    (item['pageName'], item['btnText'], item['sortNo'], old['id']))
            updated += 1

        missing = 0
        # 只有确实扫描到了按钮，才判断「哪些按钮不见了」；
        # 目录不存在 / 页面全空时不做标记，避免误把整表标成失效。
        if scanned:
            for key, old in existing.items():
                if key in seen:
                    continue
                if MISSING_TIP in (old.get('remark') or ''):
                    continue
                execute('UPDATE `%s` SET `remark`=%%s WHERE `id`=%%s' % self.table,
                        (MISSING_TIP + '（重新扫描时更新）', old['id']))
                missing += 1

        total = int(query_one('SELECT COUNT(*) AS cnt FROM `%s`' % self.table)['cnt'])
        return {
            'added': added, 'updated': updated, 'unchanged': same,
            'missing': missing, 'scanned': len(scanned), 'total': total,
            'pages': len(set(item['pagePath'] for item in scanned))
        }


page_op_btn_service = PageOpBtnService()


class ServiceEmailService(object):
    """
    服务信箱（serviceemail）：系统对外收发邮件用的邮箱账号（UUID 主键）
      · 字段：id / email / password（加密存储，接口永不返回）/ displayName /
        smtpHost / smtpPort / imapHost / imapPort / useSsl / enabled / lastSyncTime / lastError / remark
      · **单例表：全表只允许一条记录**（服务信箱是「系统的一份配置」，不是列表）：
          - 页面：邮箱助手右上角「设置」按钮弹出的弹窗里，表里没有记录 → 新增，已有记录 → 编辑；
          - 业务层：add 时若已存在记录直接拒绝（提示去编辑那一条），不再允许新增第二条；
          - 数据库层：生成列 singleFlag（常量 1）+ 唯一索引 uk_serviceemail_single 兜底，第二条 INSERT 必然冲突。
      · 历史遗留的「全表只能有一条启用记录」继续保留：
          - 业务层：编辑 / 启用时先用一条 UPDATE 把其它记录置为停用，再写当前记录（事务内完成）；
          - 数据库层：生成列 enabledFlag（enabled=1 → 1，否则 NULL）+ 唯一索引 uk_serviceemail_enabled 兜底。
      · 服务器地址留空时按邮箱域名自动推断（server/mail_client.py: provider_of），页面展示实际生效值
      · 密码：编辑时留空表示「不修改」；保存前用 mail_client.encrypt_secret 加密
    对外接口：list(page) / detail / check / add / update / delete / enabled / test
    """

    table = 'serviceemail'
    msg_table = 'serviceemailmsg'
    label = '服务信箱'

    ORDER_BY = '`enabled` DESC, `createTime` ASC'

    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _int_or_none(value):
        text = ServiceEmailService._text(value)
        if not text:
            return None
        try:
            number = int(text)
        except (TypeError, ValueError):
            raise BizError('端口必须是数字')
        if number < 1 or number > 65535:
            raise BizError('端口范围应为 1-65535')
        return number

    @staticmethod
    def _uuid_of(value):
        text = ServiceEmailService._text(value).lower()
        if not text:
            raise BizError('参数 id 不能为空（应为 UUID）')
        if not RE_UUID.match(text):
            raise BizError('参数 id 不合法（应为 UUID）')
        return text

    def _find(self, uid):
        row = query_one('SELECT * FROM `%s` WHERE `id`=%%s' % self.table, (uid,))
        if not row:
            raise BizError(self.label + '不存在或已被删除', 404)
        return row

    # ---------------- 展示字段 ----------------
    def _attach(self, items):
        for it in items:
            pwd = mail_client.decrypt_secret(it.get('password'))
            it['hasPassword'] = bool(pwd)
            it['passwordMask'] = '******' if pwd else ''
            it.pop('password', None)                    # 密码 / 授权码永不外泄
            it['useSsl'] = bool(int(it.get('useSsl') or 0))
            it['enabled'] = bool(int(it.get('enabled') or 0))
            srv = mail_client.servers_of({
                'email': it.get('email'), 'imapHost': it.get('imapHost'), 'imapPort': it.get('imapPort'),
                'smtpHost': it.get('smtpHost'), 'smtpPort': it.get('smtpPort'),
                'useSsl': 1 if it['useSsl'] else 0
            })
            it['provider'] = srv['provider']
            it['imapHostText'] = srv['imapHost']
            it['imapPortText'] = srv['imapPort']
            it['smtpHostText'] = srv['smtpHost']
            it['smtpPortText'] = srv['smtpPort']
            it['lastSyncTime'] = it.get('lastSyncTime') or ''
            it['lastError'] = it.get('lastError') or ''
            it['displayName'] = it.get('displayName') or str(it.get('email') or '').split('@')[0]
        return items

    # ---------------- 查询 ----------------
    def _build_where(self, params):
        where, args = [], []
        keyword = self._text((params or {}).get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            where.append('(`email` LIKE %s OR `displayName` LIKE %s OR `remark` LIKE %s)')
            args.extend([like, like, like])
        enabled = (params or {}).get('enabled')
        if enabled is not None and str(enabled).strip() != '':
            where.append('`enabled`=%s')
            args.append(1 if str(enabled).strip().lower() in ('1', 'true', 'yes', 'on') else 0)
        return (' WHERE ' + ' AND '.join(where)) if where else '', args

    def page(self, params):
        params = params or {}
        where, args = self._build_where(params)
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 10), 1), 200)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        row = query_one('SELECT COUNT(*) AS n FROM `%s`%s' % (self.table, where), args)
        total = int(row['n']) if row and row.get('n') is not None else 0
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        rows = query_all('SELECT * FROM `%s`%s ORDER BY %s LIMIT %%s OFFSET %%s'
                         % (self.table, where, self.ORDER_BY),
                         args + [page_size, (page_num - 1) * page_size])
        return {'list': self._attach([dump_row(r) for r in rows]), 'total': total,
                'pageNum': page_num, 'pageSize': page_size, 'pages': pages,
                'enabledEmail': self._enabled_email_text(),
                'maxEnabled': 1}

    def detail(self, params):
        uid = self._uuid_of((params or {}).get('id'))
        return self._attach([dump_row(self._find(uid))])[0]

    def check(self, params):
        """唯一性校验：邮箱地址全表唯一"""
        field = self._text((params or {}).get('field')) or 'email'
        if field != 'email':
            raise BizError('不支持的唯一性校验字段：' + field)
        value = self._text((params or {}).get('value'))
        if not value:
            return {'unique': True}
        self_id = self._text((params or {}).get('id'))
        row = query_one('SELECT `id` FROM `%s` WHERE `email`=%%s AND `id`<>%%s LIMIT 1' % self.table,
                        (value, self_id))
        return {'unique': row is None}

    def _enabled_email_text(self):
        row = query_one('SELECT `email` FROM `%s` WHERE `enabled`=1 LIMIT 1' % self.table)
        return str(row['email']) if row else ''

    # ---------------- 写入 ----------------
    def _normalize(self, data, current=None):
        """校验并归一化提交字段；password 为空表示沿用原密码（编辑时）"""
        data = data or {}
        email = self._text(data.get('email')) or (current or {}).get('email') or ''
        email = email.lower()
        if not email:
            raise BizError('服务信箱地址不能为空')
        if not mail_client.RE_EMAIL.match(email):
            raise BizError('服务信箱地址格式不正确')
        picked = {
            'email': email,
            'displayName': self._text(data.get('displayName'))[:80] or email.split('@')[0],
            'smtpHost': self._text(data.get('smtpHost'))[:120] or None,
            'imapHost': self._text(data.get('imapHost'))[:120] or None,
            'smtpPort': self._int_or_none(data.get('smtpPort')),
            'imapPort': self._int_or_none(data.get('imapPort')),
            'useSsl': 1 if str(data.get('useSsl', 1)).strip().lower()
            in ('1', 'true', 'yes', 'on') else 0,
            'remark': self._text(data.get('remark'))[:200] or None,
        }
        if 'enabled' in data:
            picked['enabled'] = 1 if str(data.get('enabled')).strip().lower() \
                in ('1', 'true', 'yes', 'on') else 0
        return picked

    def _assert_email_unique(self, email, self_id=''):
        row = query_one('SELECT `id` FROM `%s` WHERE `email`=%%s AND `id`<>%%s LIMIT 1' % self.table,
                        (email, self_id))
        if row:
            raise BizError('该服务信箱已存在，请勿重复添加')

    def _count_rows(self):
        row = query_one('SELECT COUNT(*) AS n FROM `%s`' % self.table) or {}
        return int(row.get('n') or 0)

    def _assert_single(self):
        """单例表：已存在记录时不允许新增（前端「设置」弹窗会自动走编辑分支）"""
        if self._count_rows() > 0:
            raise BizError('服务信箱只允许一条记录，请直接编辑已有记录')

    def add(self, data):
        data = data or {}
        picked = self._normalize(data)
        password = self._text(data.get('password'))
        if not password:
            raise BizError('请填写邮箱密码或授权码')
        self._assert_email_unique(picked['email'])
        self._assert_single()                 # 校验都过了再判单例，报错顺序对用户更友好
        picked['id'] = str(uuid.uuid4())
        picked['password'] = mail_client.encrypt_secret(password)
        picked.setdefault('enabled', 0)

        def _write(cur):
            if picked['enabled'] == 1:          # 只能有一条启用：先把其它停用
                cur.execute('UPDATE `%s` SET `enabled`=0 WHERE `enabled`=1' % self.table)
            columns = ','.join('`%s`' % c for c in picked.keys())
            holders = ','.join(['%s'] * len(picked))
            cur.execute('INSERT INTO `%s` (%s) VALUES (%s)' % (self.table, columns, holders),
                        list(picked.values()))
            return picked['id']

        try:
            transaction(_write)
        except DuplicateError as exc:
            # 并发的第二个 add 会撞 uk_serviceemail_single / uk_serviceemail_email
            if 'single' in str(exc).lower() or self._count_rows() > 0:
                raise BizError('服务信箱只允许一条记录，请直接编辑已有记录')
            raise BizError('该服务信箱已存在，请勿重复添加')
        return self._attach([dump_row(self._find(picked['id']))])[0]

    def update(self, data):
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        current = self._find(uid)
        picked = self._normalize(data, current)
        self._assert_email_unique(picked['email'], uid)
        password = self._text(data.get('password'))
        if password:
            picked['password'] = mail_client.encrypt_secret(password)   # 留空 = 不修改

        def _write(cur):
            if picked.get('enabled') == 1:
                cur.execute('UPDATE `%s` SET `enabled`=0 WHERE `enabled`=1 AND `id`<>%%s' % self.table,
                            (uid,))
            assignments = ','.join('`%s`=%%s' % c for c in picked.keys())
            cur.execute('UPDATE `%s` SET %s WHERE `id`=%%s' % (self.table, assignments),
                        list(picked.values()) + [uid])
            return uid

        try:
            transaction(_write)
        except DuplicateError:
            raise BizError('该服务信箱已存在，请勿重复添加')
        return self._attach([dump_row(self._find(uid))])[0]

    def delete(self, params):
        uid = self._uuid_of((params or {}).get('id'))
        row = self._find(uid)

        def _del(cur):
            cur.execute('DELETE FROM `%s` WHERE `serviceEmailId`=%%s' % self.msg_table, (uid,))
            cur.execute('DELETE FROM `%s` WHERE `id`=%%s' % self.table, (uid,))
            return 1

        transaction(_del)
        return self._attach([dump_row(row)])[0]

    def enabled(self, params):
        """启用 / 停用（启用时自动停用其它记录；停用无副作用）"""
        params = params or {}
        uid = self._uuid_of(params.get('id'))
        row = self._find(uid)
        on = 1 if str(params.get('enabled', 1)).strip().lower() in ('1', 'true', 'yes', 'on') else 0

        def _write(cur):
            if on == 1:
                cur.execute('UPDATE `%s` SET `enabled`=0 WHERE `enabled`=1 AND `id`<>%%s' % self.table,
                            (uid,))
            cur.execute('UPDATE `%s` SET `enabled`=%%s WHERE `id`=%%s' % self.table, (on, uid))
            return on

        try:
            transaction(_write)
        except DuplicateError:
            raise BizError('已存在其他启用的服务信箱，请先停用后再启用')
        item = self._attach([dump_row(self._find(uid))])[0]
        item['enabledEmail'] = self._enabled_email_text()
        item['message'] = ('服务信箱「%s」已启用' % row['email']) if on else ('服务信箱「%s」已停用' % row['email'])
        return item

    def test(self, params):
        """
        测试连接：用库里保存的密码分别登录 IMAP / SMTP
          · 全部成功 → 清空 lastError
          · 有失败 → 失败原因写入 lastError 并抛业务错误（message 里带上两侧结果）
        """
        uid = self._uuid_of((params or {}).get('id'))
        row = self._find(uid)
        password = mail_client.decrypt_secret(row.get('password'))
        if not password:
            raise BizError('该服务信箱还没有设置密码 / 授权码，请先编辑填写')
        hosts = {
            'imapHost': row.get('imapHost'), 'imapPort': row.get('imapPort'),
            'smtpHost': row.get('smtpHost'), 'smtpPort': row.get('smtpPort'),
            'useSsl': row.get('useSsl')
        }
        result = mail_client.test_connection(row.get('email'), password, hosts)
        ok = bool(result['imap'] and result['smtp'])
        error = '' if ok else '；'.join(
            [x for x in (result['messages'].get('imap'), result['messages'].get('smtp')) if x])
        execute('UPDATE `%s` SET `lastError`=%%s WHERE `id`=%%s' % self.table,
                (error[:255] or None, uid))
        if not ok:
            raise BizError('连接测试未通过：' + (error or '请检查邮箱地址与授权码'))
        return {'imap': result['imap'], 'smtp': result['smtp'], 'ok': True,
                'servers': result['servers'], 'messages': result['messages'],
                'email': row.get('email'), 'lastError': ''}


service_email_service = ServiceEmailService()


# ---------------------------------------------------------------- 邮件附件：落盘 / 清单 / 下载 ----------------------------------------------------------------
# MySQL 5.7 的 max_allowed_packet 通常只有 1 MB，附件内容不能塞进 BLOB；
# 统一写到 WEB_ROOT/data/mailattach/<source>/<mailId>/<sortNo>.bin，
# mailattach 表只登记元信息（文件名 / 大小 / 类型 / 相对路径）。
# 磁盘文件名用纯序号，彻底避开中文名、路径穿越与编码问题；下载时再用表里的 name 回显。
MAIL_ATTACH_REL = 'data/mailattach'
MAIL_ATTACH_ROOT = os.path.join(
    os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')),
    'data', 'mailattach')
MAIL_ATTACH_SOURCES = ('mail', 'empmail')


def _attach_size_text(size):
    """字节数 → 人话（与前端 formatSize / MailService._size_text 同口径）"""
    size = int(size or 0)
    if size < 1024:
        return '%d B' % size
    if size < 1024 * 1024:
        return '%.1f KB' % (size / 1024.0)
    return '%.1f MB' % (size / (1024.0 * 1024))


def _attach_full_path(rel):
    """相对路径 → 绝对路径；只接受 data/mailattach/ 下的路径（防目录穿越）"""
    text = str(rel or '')
    if not text.startswith(MAIL_ATTACH_REL + '/') or '..' in text.split('/'):
        return None
    full = os.path.abspath(os.path.join(
        os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')),
        *text.split('/')))
    if not full.startswith(MAIL_ATTACH_ROOT + os.sep):
        return None
    return full


def mail_attach_purge(source, mail_ids):
    """删除某几封邮件的附件登记与磁盘文件（邮件删除 / 补拉前重登时用）；失败静默降级"""
    ids = [str(x) for x in (mail_ids if isinstance(mail_ids, (list, tuple)) else [mail_ids]) if x]
    if not ids:
        return 0
    holders = ','.join(['%s'] * len(ids))
    try:
        rows = query_all('SELECT `filePath` FROM `mailattach` WHERE `source`=%%s '
                         'AND `mailId` IN (%s)' % holders, [source] + ids)
        execute('DELETE FROM `mailattach` WHERE `source`=%%s AND `mailId` IN (%s)' % holders,
                [source] + ids)
    except Exception:
        return 0                       # 老库没建表：不影响邮件本身
    for row in rows or []:
        full = _attach_full_path(row.get('filePath'))
        if full and os.path.isfile(full):
            try:
                os.remove(full)
            except OSError:
                pass
    for mid in ids:
        try:
            os.rmdir(os.path.join(MAIL_ATTACH_ROOT, str(source), mid))   # 目录空了才删得掉
        except OSError:
            pass
    return len(rows or [])


def mail_attach_save(source, mail_id, emp_id, files):
    """把附件内容落盘并登记到 mailattach；files=[{name,size,contentType,data(bytes|None)}]
    返回可直接给前端的下载清单。data 为 None（超大 / 空）时只登记名字，标 downloadable=0。
    """
    out = []
    files = files or []
    mail_attach_purge(source, mail_id)          # 补拉历史邮件时先清旧登记，避免序号错位
    for idx, one in enumerate(files):
        name = str(one.get('name') or ('attachment-%d' % (idx + 1)))[:250]
        size = int(one.get('size') or 0)
        ctype = str(one.get('contentType') or 'application/octet-stream')[:150]
        data = one.get('data')
        file_id = str(uuid.uuid4())
        rel = None
        if data:
            try:
                directory = os.path.join(MAIL_ATTACH_ROOT, str(source), str(mail_id))
                if not os.path.isdir(directory):
                    os.makedirs(directory)
                with open(os.path.join(directory, '%d.bin' % idx), 'wb') as fp:
                    fp.write(data)
                rel = '%s/%s/%s/%d.bin' % (MAIL_ATTACH_REL, source, mail_id, idx)
            except (IOError, OSError):
                rel = None                     # 磁盘不可写：只记名字，不让收发失败
        try:
            execute('INSERT IGNORE INTO `mailattach` '
                    '(`id`,`source`,`mailId`,`empId`,`sortNo`,`name`,`size`,`contentType`,'
                    '`filePath`,`downloadable`) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                    (file_id, source, mail_id, int(emp_id or 0), idx, name, size, ctype,
                     rel, 1 if rel else 0))
        except Exception:
            rel = None                         # 老库没建表：降级成不可下载
        out.append({'id': file_id, 'name': name, 'size': size,
                    'sizeText': _attach_size_text(size), 'contentType': ctype,
                    'sortNo': idx, 'downloadable': bool(rel)})
    return out


def mail_attach_rows(source, mail_id):
    """读某封邮件已登记的附件清单；表不存在 / 查询失败时返回 None（区别于「查过但 0 条」）"""
    try:
        return query_all('SELECT `id`,`name`,`size`,`contentType`,`sortNo`,`filePath`,`downloadable` '
                         'FROM `mailattach` WHERE `source`=%s AND `mailId`=%s ORDER BY `sortNo`',
                         (source, mail_id))
    except Exception:
        return None


def mail_attach_list(source, mail_id, fallback=None):
    """读信区用的附件清单：优先用落盘登记；没有登记时退回 attachInfo（全部标不可下载）"""
    rows = mail_attach_rows(source, mail_id)
    if rows:
        return [{'id': r['id'], 'name': str(r.get('name') or ''),
                 'size': int(r.get('size') or 0),
                 'sizeText': _attach_size_text(r.get('size')),
                 'contentType': str(r.get('contentType') or ''),
                 'sortNo': int(r.get('sortNo') or 0),
                 'downloadable': bool(int(r.get('downloadable') or 0))}
                for r in rows]
    out = []
    for one in (fallback or []):
        size = int(one.get('size') or 0)
        out.append({'id': '', 'name': str(one.get('name') or ''), 'size': size,
                    'sizeText': _attach_size_text(size), 'contentType': '',
                    'sortNo': len(out), 'downloadable': False})
    return out


def mail_attach_need_fetch(source, mail_id, mail_row):
    """历史收件：带附件标记却没有任何落盘登记 → 前端显示「获取附件」按钮"""
    if not int((mail_row or {}).get('hasAttach') or 0):
        return False
    if str((mail_row or {}).get('direction') or '') != 'in':
        return False
    rows = mail_attach_rows(source, mail_id)
    return rows is not None and len(rows) == 0


def mail_attach_content(params):
    """下载附件：返回 {content(bytes), name, contentType}
      · 服务信箱（mail）：全员共用，登录有效即可；
      · 我的邮箱（empmail）：按 token 反查 empId 强校验，别人的附件一律 404。
    """
    params = params or {}
    source = str(params.get('source') or '').strip().lower()
    if source not in MAIL_ATTACH_SOURCES:
        raise BizError('附件来源参数不合法', 404)
    file_id = MailService._uuid_of(params.get('id'))
    try:
        row = query_one('SELECT * FROM `mailattach` WHERE `id`=%s AND `source`=%s',
                        (file_id, source))
    except Exception:
        row = None
    if not row:
        raise BizError('附件不存在或已被删除', 404)
    if source == 'empmail':
        login_user = params.get('_loginUserId')
        user = query_one('SELECT `empId` FROM `useinfo` WHERE `id`=%s', (login_user,)) or {}
        if int(row.get('empId') or 0) != int(user.get('empId') or 0):
            raise BizError('附件不存在或已被删除', 404)   # 不泄露他人附件是否存在
    if not int(row.get('downloadable') or 0):
        raise BizError('该附件内容未保存（超大附件或历史邮件），请到邮箱网页版查看', 404)
    full = _attach_full_path(row.get('filePath'))
    if not full or not os.path.isfile(full):
        raise BizError('附件文件不存在或已被清理', 404)
    with open(full, 'rb') as fp:
        content = fp.read()
    return {'content': content, 'name': str(row.get('name') or 'attachment'),
            'contentType': str(row.get('contentType') or 'application/octet-stream')}


class MailService(object):
    """
    邮箱助手（serviceemailmsg）：用「当前启用的服务信箱」收发邮件
      · sync   手动 / 定时收件：IMAP 只读拉取 INBOX 最近 N 封，按 UID 去重入库
      · list   邮件列表（folder=inbox/sent，支持关键字与分页）
      · detail 读信正文（默认标记已读）
      · send   写邮件并发送（成功后才入库，方向 out）
      · mark   标记已读 / 未读；delete 删除
      · status 当前启用的服务信箱 + 未读数（页面顶部与左侧徽标用）
    对外接口：GET /api/mail/status|list|detail，POST /api/mail/sync|send|mark|delete
    """

    table = 'serviceemailmsg'
    account_table = 'serviceemail'
    label = '邮件'
    attach_source = 'mail'        # 附件元数据表里的来源标记（子类改成 empmail）

    # 收件锁：手动「收件」与后台自动收件不能同时连同一个邮箱
    # （网易 163/126 对同一账号的并发连接与登录频率限制很严，撞上了会报 Unsafe Login / 登录过于频繁）
    SYNC_LOCK = threading.Lock()

    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _uuid_of(value, name='id'):
        text = MailService._text(value).lower()
        if not text:
            raise BizError('参数 %s 不能为空（应为 UUID）' % name)
        if not RE_UUID.match(text):
            raise BizError('参数 %s 不合法（应为 UUID）' % name)
        return text

    # ---------------- 当前启用的服务信箱 ----------------
    def _enabled_account(self, need_password=True):
        row = query_one('SELECT * FROM `%s` WHERE `enabled`=1 LIMIT 1' % self.account_table)
        if not row:
            raise BizError('尚未启用服务信箱，请点邮箱助手右上角的「设置」按钮完成配置并启用')
        password = mail_client.decrypt_secret(row.get('password'))
        if need_password and not password:
            raise BizError('服务信箱「%s」还没有设置密码 / 授权码，请点邮箱助手右上角的「设置」按钮补充'
                           % row.get('email'))
        hosts = {
            'imapHost': row.get('imapHost'), 'imapPort': row.get('imapPort'),
            'smtpHost': row.get('smtpHost'), 'smtpPort': row.get('smtpPort'),
            'useSsl': row.get('useSsl')
        }
        srv = mail_client.servers_of(dict(hosts, email=row.get('email')))
        return {'row': row, 'password': password, 'hosts': hosts, 'servers': srv,
                'email': row.get('email'), 'displayName': row.get('displayName') or ''}

    def _unread(self, account_id):
        row = query_one("SELECT COUNT(*) AS n FROM `%s` WHERE `serviceEmailId`=%%s "
                        "AND `direction`='in' AND `seen`=0" % self.table, (account_id,))
        return int(row['n']) if row and row.get('n') is not None else 0

    def _counts(self, account_id):
        row = query_one("SELECT "
                        "SUM(CASE WHEN `direction`='in' THEN 1 ELSE 0 END) AS inbox, "
                        "SUM(CASE WHEN `direction`='out' THEN 1 ELSE 0 END) AS sent "
                        "FROM `%s` WHERE `serviceEmailId`=%%s" % self.table, (account_id,)) or {}
        return {'inbox': int(row.get('inbox') or 0), 'sent': int(row.get('sent') or 0)}

    # ---------------- 附件下载清单（子类只换来源 / 归属 / 账号上下文） ----------------
    def _attach_emp_id(self, params):
        """附件归属员工：服务信箱全员共用 → 0；我的邮箱覆写成登录人 empId"""
        return 0

    def _attach_mail_row(self, uid, params):
        """按 id 取邮件行（子类覆写：我的邮箱强制带 empId）"""
        return query_one('SELECT * FROM `%s` WHERE `id`=%%s' % self.table, (uid,))

    def _attach_account(self, params):
        """补拉历史附件时用的 IMAP 上下文（子类覆写：本人信箱配置）"""
        return self._enabled_account()

    @staticmethod
    def _attach_info_text(files):
        """附件清单 → attachInfo（JSON 文本，截断到列宽 1000）"""
        if not files:
            return None
        return (json.dumps([{'name': f.get('name'), 'size': f.get('size')} for f in files],
                           ensure_ascii=False))[:1000] or None

    def attachments(self, params):
        """读信区的附件下载清单。
          · 普通调用：直接读已落盘的附件登记（历史邮件没有登记时回退 attachInfo 并标「未保存」）；
          · refresh=1 且是收件：按 IMAP UID 补拉这一封，把附件内容落盘登记后再返回清单，
            用于系统上线前入库、只有「含附件」标记的历史邮件。
        """
        params = params or {}
        uid = self._uuid_of(params.get('id'))
        row = self._attach_mail_row(uid, params)
        if not row:
            raise BizError('邮件不存在或已被删除', 404)
        refresh = str(params.get('refresh') or '').strip().lower() in ('1', 'true', 'yes', 'on')
        if refresh and str(row.get('direction') or '') == 'in':
            acc = self._attach_account(params)
            try:
                item = mail_client.fetch_one(acc['email'], acc['password'],
                                             row.get('uid'), acc['hosts'])
            except mail_client.MailError as exc:
                raise BizError(exc.message)
            except Exception as exc:
                raise BizError('获取附件失败：%s' % (str(exc) or exc.__class__.__name__))
            if not item:
                raise BizError('邮箱服务器上已找不到这封邮件（可能已被删除或移出收件箱），无法获取附件')
            files = item.get('attachments') or []
            try:
                execute('UPDATE `%s` SET `hasAttach`=%%s, `attachInfo`=%%s WHERE `id`=%%s'
                        % self.table, (1 if files else 0, self._attach_info_text(files), uid))
            except Exception:
                pass
            items = mail_attach_save(self.attach_source, uid, self._attach_emp_id(params), files)
            return {'list': items, 'refreshed': True, 'needFetch': False,
                    'message': '已获取 %d 个附件' % len(items)}
        items = mail_attach_list(self.attach_source, uid,
                                 fallback=self._attach_list(row.get('attachInfo')))
        return {'list': items, 'refreshed': False,
                'needFetch': mail_attach_need_fetch(self.attach_source, uid, row)}

    def status(self, params=None):
        """页面初始化：当前启用的服务信箱（不含密码）+ 未读数 + 收发统计"""
        row = query_one('SELECT * FROM `%s` WHERE `enabled`=1 LIMIT 1' % self.account_table)
        if not row:
            return {'configured': False, 'email': '', 'displayName': '', 'unread': 0,
                    'counts': {'inbox': 0, 'sent': 0}, 'lastSyncTime': '', 'lastError': '',
                    'servers': {}, 'accounts': 0,
                    'message': '尚未配置服务信箱，请点右上角「设置」按钮新增一条'}
        srv = mail_client.servers_of(dict(email=row.get('email'), imapHost=row.get('imapHost'),
                                          imapPort=row.get('imapPort'), smtpHost=row.get('smtpHost'),
                                          smtpPort=row.get('smtpPort'), useSsl=row.get('useSsl')))
        accounts = query_one('SELECT COUNT(*) AS n FROM `%s`' % self.account_table) or {}
        return {
            'configured': True, 'id': row.get('id'), 'email': row.get('email'),
            'displayName': row.get('displayName') or str(row.get('email') or '').split('@')[0],
            'unread': self._unread(row.get('id')),
            'counts': self._counts(row.get('id')),
            'lastSyncTime': time_text(row.get('lastSyncTime')),
            'lastError': row.get('lastError') or '',
            'servers': {'imapHost': srv['imapHost'], 'imapPort': srv['imapPort'],
                        'smtpHost': srv['smtpHost'], 'smtpPort': srv['smtpPort'],
                        'useSsl': bool(srv['useSsl']), 'provider': srv['provider']},
            'accounts': int(accounts.get('n') or 0), 'message': ''
        }

    # ---------------- 收件 ----------------
    def sync(self, params=None):
        """
        收件：拉取收件箱最近 limit 封（默认 config.MAIL_FETCH_LIMIT），按 UID 去重入库
          · 同一时刻只允许一个收件任务（手动 + 后台自动收件共用一把锁），避免邮箱侧并发限制
        :return {fetched, saved, unread, counts, lastSyncTime, email}
        """
        if not MailService.SYNC_LOCK.acquire(False):
            raise BizError('正在收件中，请稍后再试（后台每 %s 分钟也会自动收一次）'
                           % config.MAIL_SYNC_MINUTES)
        try:
            return self._sync_locked(params or {})
        finally:
            MailService.SYNC_LOCK.release()

    def _sync_locked(self, params):
        acc = self._enabled_account()
        try:
            limit = int(params.get('limit') or config.MAIL_FETCH_LIMIT)
        except (TypeError, ValueError):
            limit = config.MAIL_FETCH_LIMIT
        limit = min(max(limit, 1), 200)
        try:
            mails = mail_client.fetch_inbox(acc['email'], acc['password'], acc['hosts'], limit)
        except mail_client.MailError as exc:
            execute('UPDATE `%s` SET `lastError`=%%s WHERE `id`=%%s' % self.account_table,
                    (exc.message[:255], acc['row']['id']))
            raise BizError(exc.message)
        except Exception as exc:            # 解析异常等未预期问题：也要落 lastError，避免只留一条堆栈
            message = '收件失败：%s' % (str(exc) or exc.__class__.__name__)
            execute('UPDATE `%s` SET `lastError`=%%s WHERE `id`=%%s' % self.account_table,
                    (message[:255], acc['row']['id']))
            raise BizError(message)

        saved = 0
        for item in mails:
            mail_id = str(uuid.uuid4())
            files = item.get('attachments') or []
            try:
                _, rowcount = execute(
                    "INSERT IGNORE INTO `%s` (`id`,`serviceEmailId`,`direction`,`uid`,`messageId`,"
                    "`fromAddr`,`fromName`,`toAddr`,`ccAddr`,`subject`,`sentTime`,`bodyText`,`bodyHtml`,"
                    "`hasAttach`,`attachInfo`,`seen`) "
                    "VALUES (%%s,%%s,'in',%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,0)" % self.table,
                    (mail_id, acc['row']['id'], item['uid'], item['messageId'],
                     item['fromAddr'], item['fromName'], item['toAddr'], item['ccAddr'],
                     item['subject'], item['sentTime'], item['bodyText'], item['bodyHtml'],
                     1 if (item.get('hasAttach') or files) else 0,
                     self._attach_info_text(files)))
                saved += int(rowcount or 0)
                if rowcount and files:
                    mail_attach_save(self.attach_source, mail_id, 0, files)
            except DuplicateError:
                continue
        now_text = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        execute('UPDATE `%s` SET `lastSyncTime`=%%s, `lastError`=NULL WHERE `id`=%%s' % self.account_table,
                (now_text, acc['row']['id']))
        return {'fetched': len(mails), 'saved': saved, 'email': acc['email'],
                'lastSyncTime': now_text, 'unread': self._unread(acc['row']['id']),
                'counts': self._counts(acc['row']['id'])}

    # ---------------- 列表 / 详情 ----------------
    # 注意：接口动作名是 list，ACTIONS 把 'list' 映射到 page()（与其它模块一致）
    def page(self, params):
        params = params or {}
        acc = self._enabled_account(need_password=False)
        folder = self._text(params.get('folder')).lower() or 'inbox'
        direction = 'out' if folder in ('sent', 'out', 'outbox') else 'in'
        where = ['`serviceEmailId`=%s', '`direction`=%s']
        args = [acc['row']['id'], direction]
        keyword = self._text(params.get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            where.append('(`subject` LIKE %s OR `fromAddr` LIKE %s OR `fromName` LIKE %s '
                         'OR `toAddr` LIKE %s)')
            args.extend([like, like, like, like])
        clause = ' WHERE ' + ' AND '.join(where)
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 20), 1), 100)
        except (TypeError, ValueError):
            page_num, page_size = 1, 20
        row = query_one('SELECT COUNT(*) AS n FROM `%s`%s' % (self.table, clause), args)
        total = int(row['n']) if row and row.get('n') is not None else 0
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        rows = query_all(
            'SELECT `id`,`direction`,`fromAddr`,`fromName`,`toAddr`,`ccAddr`,`subject`,`sentTime`,'
            '       `hasAttach`,`attachInfo`,`seen`,`createTime` FROM `%s`%s '
            'ORDER BY `sentTime` DESC, `createTime` DESC LIMIT %%s OFFSET %%s'
            % (self.table, clause), args + [page_size, (page_num - 1) * page_size])
        items = []
        for r in rows:
            it = dump_row(r)
            it['seen'] = bool(int(it.get('seen') or 0))
            it['hasAttach'] = bool(int(it.get('hasAttach') or 0))
            it['attachments'] = self._attach_list(it.pop('attachInfo', None))
            it['sentTime'] = it.get('sentTime') or it.get('createTime') or ''
            it['summaryFrom'] = it.get('fromName') or it.get('fromAddr') or ''
            items.append(it)
        return {'list': items, 'total': total, 'pageNum': page_num, 'pageSize': page_size,
                'pages': pages, 'folder': 'sent' if direction == 'out' else 'inbox',
                'email': acc['email'], 'unread': self._unread(acc['row']['id']),
                'counts': self._counts(acc['row']['id'])}

    def detail(self, params):
        params = params or {}
        uid = self._uuid_of(params.get('id'))
        row = query_one('SELECT * FROM `%s` WHERE `id`=%%s' % self.table, (uid,))
        if not row:
            raise BizError('邮件不存在或已被删除', 404)
        mark_read = params.get('markRead') not in (0, '0', False, 'false')
        if mark_read and int(row.get('seen') or 0) == 0:
            execute('UPDATE `%s` SET `seen`=1 WHERE `id`=%%s' % self.table, (uid,))
            row['seen'] = 1
        it = dump_row(row)
        it['seen'] = bool(int(it.get('seen') or 0))
        it['hasAttach'] = bool(int(it.get('hasAttach') or 0))
        # 附件下载清单：优先取落盘登记；历史邮件回退 attachInfo（标「未保存」）
        fallback = self._attach_list(it.pop('attachInfo', None))
        it['attachments'] = mail_attach_list(self.attach_source, uid, fallback=fallback)
        it['attachNeedFetch'] = mail_attach_need_fetch(self.attach_source, uid, it)
        it['sentTime'] = it.get('sentTime') or ''
        it['directionText'] = '发件' if it.get('direction') == 'out' else '收件'
        it['bodyText'] = it.get('bodyText') or ''
        it['bodyHtml'] = it.get('bodyHtml') or ''
        it['unread'] = self._unread(it.get('serviceEmailId'))
        return it

    # ---------------- 发件 ----------------
    def _addresses(self, raw, name='收件人'):
        if raw is None:
            return []
        if isinstance(raw, (list, tuple)):
            parts = [self._text(x) for x in raw]
        else:
            parts = [x for x in re.split(r'[,;，；\s]+', self._text(raw)) if x]
        out = []
        for one in parts:
            one = one.strip()
            if not one:
                continue
            if not mail_client.RE_EMAIL.match(one):
                raise BizError('%s地址格式不正确：%s' % (name, one))
            if one not in out:
                out.append(one)
        return out

    # ---------------- 附件（写邮件） ----------------
    @staticmethod
    def _size_text(size):
        """字节数 → 人话（1024 进制；后端提示语与前端 formatSize 口径一致）"""
        size = int(size or 0)
        if size < 1024:
            return '%d B' % size
        if size < 1024 * 1024:
            return '%.1f KB' % (size / 1024.0)
        return '%.1f MB' % (size / (1024.0 * 1024))

    @staticmethod
    def _attach_list(text):
        """
        把库里的附件清单（attachInfo，JSON 文本 `[{name,size}]`）解析成数组
          · 附件内容不落库（只有名称与大小），解析失败一律当成「无清单」，不影响列表 / 读信
        """
        raw = '' if text is None else str(text).strip()
        if not raw:
            return []
        try:
            data = json.loads(raw)
        except ValueError:
            return []
        out = []
        for one in (data if isinstance(data, list) else []):
            if not isinstance(one, dict):
                continue
            try:
                size = int(one.get('size') or 0)
            except (TypeError, ValueError):
                size = 0
            out.append({'name': str(one.get('name') or ''), 'size': size,
                        'sizeText': MailService._size_text(size)})
        return out

    def _attachments(self, raw):
        """
        解析并校验前端传来的附件：[{name, size, type, data(base64)}]
          · data 允许带 data URL 前缀（`data:text/plain;base64,xxxx`），也允许纯 base64；
          · 数量 / 单个大小 / 合计大小**在连 SMTP 之前**就校验掉，避免用户干等 15 秒超时后才看到「附件太大」；
          · 只把内容放进内存里的 MIME 消息，不落库、不写磁盘（库里只留名称与大小）。
        :return list[{name, data(bytes), contentType, size}]
        """
        if raw is None or raw == '':
            return []
        if isinstance(raw, (str, bytes)):
            text = raw.decode('utf-8', 'ignore') if isinstance(raw, bytes) else raw
            try:
                raw = json.loads(text) if text.strip() else []
            except ValueError:
                raise BizError('附件参数格式不正确（应为 JSON 数组）')
        if not isinstance(raw, (list, tuple)):
            raise BizError('附件参数格式不正确（应为数组）')
        max_count = max(1, int(config.MAIL_MAX_ATTACHMENTS))
        max_one = max(1, int(config.MAIL_MAX_ATTACH_MB)) * 1024 * 1024
        max_total = max(1, int(config.MAIL_MAX_TOTAL_MB)) * 1024 * 1024
        if len(raw) > max_count:
            raise BizError('最多只能添加 %d 个附件（当前 %d 个）' % (max_count, len(raw)))
        out, total = [], 0
        for idx, one in enumerate(raw):
            if not isinstance(one, dict):
                raise BizError('第 %d 个附件参数格式不正确' % (idx + 1))
            name = self._text(one.get('name'))
            if not name:
                raise BizError('第 %d 个附件没有文件名' % (idx + 1))
            name = os.path.basename(name.replace('\\', '/'))[:120]      # 去掉浏览器带的路径 + 限长
            text = one.get('data')
            if text is None:
                raise BizError('附件「%s」内容为空，请重新选择文件' % name)
            text = str(text)
            if ';base64,' in text[:200]:                # data URL：data:xxx;base64,YYYY
                text = text.split(';base64,', 1)[1]
            text = re.sub(r'\s+', '', text)
            try:
                # validate=True：遇到非 base64 字符（前端传坏了）直接报错，而不是悄悄解出一堆垃圾字节
                data = base64.b64decode(text.encode('ascii'), validate=True) if text else b''
            except Exception:
                raise BizError('附件「%s」内容解析失败，请重新选择文件' % name)
            if not data:
                raise BizError('附件「%s」内容为空，请重新选择文件' % name)
            if len(data) > max_one:
                raise BizError('附件「%s」%s，超出单个附件上限 %d MB'
                               % (name, self._size_text(len(data)), int(config.MAIL_MAX_ATTACH_MB)))
            total += len(data)
            if total > max_total:
                raise BizError('附件合计 %s，超出上限 %d MB'
                               % (self._size_text(total), int(config.MAIL_MAX_TOTAL_MB)))
            out.append({'name': name, 'data': data, 'contentType': self._text(one.get('type')),
                        'size': len(data)})
        return out

    def send(self, params):
        """写邮件并发送：发送成功后才入库（direction=out，uid=本地消息ID；附件只记名称与大小）"""
        params = params or {}
        acc = self._enabled_account()
        to_list = self._addresses(params.get('to'), '收件人')
        cc_list = self._addresses(params.get('cc'), '抄送人')
        if not to_list:
            raise BizError('请填写收件人')
        subject = self._text(params.get('subject'))
        if not subject:
            raise BizError('请填写邮件主题')
        body = '' if params.get('body') is None else str(params.get('body'))
        # 富文本正文：前端编辑器给的是 HTML 片段；纯文本部分由它反抽（邮件客户端的纯文本模式仍可读）
        body_html_raw = '' if params.get('bodyHtml') is None else str(params.get('bodyHtml'))
        body_html = mail_client.clean_html(body_html_raw) if body_html_raw.strip() else ''
        if not body.strip() and body_html:
            body = mail_client.html_to_text(body_html)
        if not body.strip():
            raise BizError('请填写邮件正文')
        attachments = self._attachments(params.get('attachments'))
        try:
            mail_client.send_mail(acc['email'], acc['password'], acc['hosts'], to_list,
                                  subject, body, cc_list, acc['displayName'],
                                  attachments=[{'name': one['name'], 'data': one['data'],
                                                'contentType': one['contentType']}
                                               for one in attachments],
                                  body_html=body_html)
        except mail_client.MailError as exc:
            raise BizError(exc.message)

        uid = str(uuid.uuid4())
        now_text = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        attach_info = json.dumps([{'name': one['name'], 'size': one['size']} for one in attachments],
                                 ensure_ascii=False) if attachments else None
        execute("INSERT INTO `%s` (`id`,`serviceEmailId`,`direction`,`uid`,`messageId`,"
                "`fromAddr`,`fromName`,`toAddr`,`ccAddr`,`subject`,`sentTime`,`bodyText`,"
                "`bodyHtml`,`hasAttach`,`attachInfo`,`seen`) "
                "VALUES (%%s,%%s,'out',%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,1)" % self.table,
                (uid, acc['row']['id'], uid, '', acc['email'], acc['displayName'] or acc['email'],
                 ', '.join(to_list), ', '.join(cc_list), subject[:500], now_text, body,
                 body_html or None,
                 1 if attachments else 0, (attach_info or '')[:1000] or None))
        # 发件附件也落盘：这样「已发送」里的邮件同样能在读信区下载
        sent_attach = mail_attach_save(self.attach_source, uid, 0, attachments)
        return {'id': uid, 'to': to_list, 'cc': cc_list, 'subject': subject,
                'sentTime': now_text, 'email': acc['email'],
                'attachments': sent_attach,
                'counts': self._counts(acc['row']['id'])}

    # ---------------- 已读 / 删除 ----------------
    def _ids_of(self, params, name='邮件'):
        params = params or {}
        raw = params.get('ids')
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            raw = params.get('id')
        if raw is None:
            raise BizError('请先选择' + name)
        items = raw if isinstance(raw, (list, tuple)) else re.split(r'[,\s]+', self._text(raw))
        ids = [self._uuid_of(x) for x in items if self._text(x)]
        if not ids:
            raise BizError('请先选择' + name)
        return ids

    def mark(self, params):
        """标记已读 / 未读：{id} 或 {ids:[...]}，seen=1/0"""
        params = params or {}
        ids = self._ids_of(params)
        seen = 1 if str(params.get('seen', 1)).strip().lower() in ('1', 'true', 'yes', 'on') else 0
        holders = ','.join(['%s'] * len(ids))
        execute('UPDATE `%s` SET `seen`=%%s WHERE `id` IN (%s)' % (self.table, holders), [seen] + ids)
        acc = query_one('SELECT `serviceEmailId` FROM `%s` WHERE `id`=%%s' % self.table, (ids[0],)) or {}
        return {'updated': len(ids), 'seen': bool(seen),
                'unread': self._unread(acc.get('serviceEmailId'))}

    def delete(self, params):
        """删除邮件（支持单个 id 或 ids 数组）"""
        ids = self._ids_of(params)
        holders = ','.join(['%s'] * len(ids))
        _, rowcount = execute('DELETE FROM `%s` WHERE `id` IN (%s)' % (self.table, holders), ids)
        mail_attach_purge(self.attach_source, ids)      # 附件登记与磁盘文件一并清理
        return {'deleted': int(rowcount or len(ids)), 'ids': ids}


mail_service = MailService()


class EmpMailService(MailService):
    """
    员工个人邮箱助手（empemailbox + empmailmsg）：参照服务信箱邮箱助手，但**按登录员工强隔离**
      · 每个员工一条自己的信箱配置（empemailbox.empId 唯一），在「我的邮箱」页右上角「设置」里维护；
      · 每封邮件都带归属员工（empmailmsg.empId），**所有列表 / 详情 / 标记 / 删除 / 发件都强制带
        当前登录人的 empId**，后端由 token 反查（require_login 注入 _loginUserId → useinfo.empId），
        绝不读前端传的 empId；detail / mark / delete 也带 empId 条件，传别人的邮件 id 一律查不到。
      · 自动收件：autoSync=1 且 enabled=1 的配置会被后台 MailSyncWorker 每 5 分钟逐个 IMAP 拉取；
        每个员工一把独立锁（不同账号互不阻塞），同一账号手动「收件」与后台自动收件串行。
      · 复用 MailService 的地址解析 / 附件校验 / 大小格式化 / UUID 校验等工具方法，收发口径一致；
        涉及表字段（serviceEmailId → empId）与账户获取的方法全部覆写。
    对外接口：GET  /api/empmail/status|list|detail
              POST /api/empmail/save|test|sync|send|mark|delete
    """

    table = 'empmailmsg'
    account_table = 'empemailbox'
    label = '个人邮件'
    attach_source = 'empmail'     # 附件下载时按 empId 强隔离校验

    # 当前登录人 → 员工ID（useinfo.empId，即 empinfos.id）
    LOGIN_EMP_SQL = 'SELECT `empId` AS `empId` FROM `useinfo` WHERE `id`=%s LIMIT 1'

    def __init__(self):
        # 不使用父类的全局 SYNC_LOCK：不同员工的邮箱互不影响，按 empId 分锁
        self._lock_guard = threading.Lock()
        self._locks = {}

    # ---------------- 归属 / 配置 ----------------
    def _my_emp_id(self, params):
        """当前登录人的员工ID；**只认 token 反查结果，绝不接受前端传参**（数据隔离的根）"""
        user_id = self._text((params or {}).get('_loginUserId'))
        if not user_id:
            raise BizError('登录已失效，请重新登录', 401)
        try:
            row = query_one(self.LOGIN_EMP_SQL, (user_id,))
        except Exception:
            row = None
        emp_id = int(row['empId']) if row and row.get('empId') else 0
        if not emp_id:
            raise BizError('当前登录账号未绑定员工，无法使用「我的邮箱」')
        return emp_id

    def _lock_of(self, emp_id):
        with self._lock_guard:
            lock = self._locks.get(emp_id)
            if lock is None:
                lock = threading.Lock()
                self._locks[emp_id] = lock
            return lock

    def _box_row(self, emp_id):
        return query_one('SELECT * FROM `%s` WHERE `empId`=%%s LIMIT 1' % self.account_table,
                         (emp_id,))

    def _emp_email(self, emp_id):
        """员工信息表(empinfos)里的邮箱：首次配置「我的邮箱」时作为预填建议值；查不到返回空串"""
        try:
            row = query_one('SELECT `email` FROM `empinfos` WHERE `id`=%s LIMIT 1', (emp_id,))
        except Exception:
            return ''
        return self._text(row.get('email')) if row else ''

    def _servers_of(self, row):
        return mail_client.servers_of({
            'email': row.get('email'), 'imapHost': row.get('imapHost'),
            'imapPort': row.get('imapPort'), 'smtpHost': row.get('smtpHost'),
            'smtpPort': row.get('smtpPort'), 'useSsl': row.get('useSsl')
        })

    def _hosts_of(self, row):
        return {
            'imapHost': row.get('imapHost'), 'imapPort': row.get('imapPort'),
            'smtpHost': row.get('smtpHost'), 'smtpPort': row.get('smtpPort'),
            'useSsl': row.get('useSsl')
        }

    def _box_view(self, row):
        """配置行 → 接口输出（密码永不外泄，只给 hasPassword / 掩码；服务器地址回显实际生效值）"""
        item = dump_row(row)
        password = mail_client.decrypt_secret(item.get('password'))
        item['hasPassword'] = bool(password)
        item['passwordMask'] = '******' if password else ''
        item.pop('password', None)
        item['useSsl'] = bool(int(item.get('useSsl') or 0))
        item['enabled'] = bool(int(item.get('enabled') or 0))
        item['autoSync'] = bool(int(item.get('autoSync') or 0))
        item['empId'] = int(item.get('empId') or 0)
        srv = self._servers_of(row)
        item['provider'] = srv['provider']
        item['imapHostText'] = srv['imapHost']
        item['imapPortText'] = srv['imapPort']
        item['smtpHostText'] = srv['smtpHost']
        item['smtpPortText'] = srv['smtpPort']
        item['lastSyncTime'] = time_text(item.get('lastSyncTime'))
        item['lastError'] = item.get('lastError') or ''
        item['displayName'] = item.get('displayName') or str(item.get('email') or '').split('@')[0]
        return item

    def _account_of(self, row, need_password=True):
        """配置行 → 收发用上下文（含解密后的密码，只在内存里用）"""
        password = mail_client.decrypt_secret(row.get('password'))
        if need_password and not password:
            raise BizError('信箱「%s」还没有设置密码 / 授权码，请点右上角「设置」补充'
                           % row.get('email'))
        return {'row': row, 'password': password, 'hosts': self._hosts_of(row),
                'servers': self._servers_of(row), 'email': row.get('email'),
                'displayName': row.get('displayName') or '',
                'empId': int(row.get('empId') or 0)}

    # ---------------- 附件下载清单（覆写三个钩子，强制带 empId） ----------------
    def _attach_emp_id(self, params):
        return self._my_emp_id(params)

    def _attach_mail_row(self, uid, params):
        return query_one('SELECT * FROM `%s` WHERE `id`=%%s AND `empId`=%%s'
                         % self.table, (uid, self._my_emp_id(params)))

    def _attach_account(self, params):
        emp_id = self._my_emp_id(params)
        row = self._box_row(emp_id)
        if not row:
            raise BizError('请先在右上角「设置」里配置本人邮箱')
        return self._account_of(row)

    # ---------------- 统计（覆写：字段是 empId，不是 serviceEmailId） ----------------
    def _unread(self, emp_id):
        row = query_one("SELECT COUNT(*) AS n FROM `%s` WHERE `empId`=%%s "
                        "AND `direction`='in' AND `seen`=0" % self.table, (emp_id,))
        return int(row['n']) if row and row.get('n') is not None else 0

    def _counts(self, emp_id):
        row = query_one("SELECT "
                        "SUM(CASE WHEN `direction`='in' THEN 1 ELSE 0 END) AS inbox, "
                        "SUM(CASE WHEN `direction`='out' THEN 1 ELSE 0 END) AS sent "
                        "FROM `%s` WHERE `empId`=%%s" % self.table, (emp_id,)) or {}
        return {'inbox': int(row.get('inbox') or 0), 'sent': int(row.get('sent') or 0)}

    # ---------------- 状态 / 配置 ----------------
    def status(self, params=None):
        """页面初始化：本人信箱配置（脱敏）+ 未读数 + 收发统计 + 自动收件开关"""
        emp_id = self._my_emp_id(params)
        row = self._box_row(emp_id)
        if not row:
            # suggestEmail：员工信息表(empinfos)里的邮箱，首次配置时预填进表单（可改）；
            # 帐号 / 密码本身不带入任何默认值。
            return {'configured': False, 'empId': emp_id, 'email': '', 'displayName': '',
                    'unread': 0, 'counts': {'inbox': 0, 'sent': 0}, 'lastSyncTime': '',
                    'lastError': '', 'servers': {}, 'autoSync': True, 'enabled': True,
                    'hasPassword': False, 'suggestEmail': self._emp_email(emp_id),
                    'message': '还没有配置个人邮箱，请点右上角「设置」填写邮箱与授权码'}
        item = self._box_view(row)
        srv = self._servers_of(row)
        item.update({
            'configured': True,
            'unread': self._unread(emp_id),
            'counts': self._counts(emp_id),
            'servers': {'imapHost': srv['imapHost'], 'imapPort': srv['imapPort'],
                        'smtpHost': srv['smtpHost'], 'smtpPort': srv['smtpPort'],
                        'useSsl': bool(srv['useSsl']), 'provider': srv['provider']},
            'message': ''
        })
        return item

    # ---------------- 未读聚合（主框架「提醒中心」的新邮件） ----------------
    def unread_summary(self, params=None, limit=5):
        """本人收件箱里未读邮件的最新几封 + 未读总数（没配置信箱时 configured=False，不报错）。

        主框架每十几秒轮询一次，所以只取 `seen=0` 的收件、只回列表必需的字段（不含正文）。
        """
        params = params or {}
        emp_id = self._my_emp_id(params)
        try:
            limit = max(1, min(int(limit or 5), 20))
        except (TypeError, ValueError):
            limit = 5
        row = self._box_row(emp_id)
        if not row:
            return {'configured': False, 'empId': emp_id, 'email': '',
                    'unread': 0, 'items': []}
        items = []
        try:
            rows = query_all(
                "SELECT `id`,`fromAddr`,`fromName`,`subject`,`sentTime` FROM `%s` "
                "WHERE `empId`=%%s AND `direction`='in' AND `seen`=0 "
                "ORDER BY `sentTime` DESC, `createTime` DESC LIMIT %%s" % self.table,
                (emp_id, limit)) or []
            for r in rows:
                it = dump_row(r)
                from_addr = self._text(it.get('fromAddr'))
                items.append({
                    'id': it.get('id'),
                    'fromAddr': from_addr,
                    'fromName': self._text(it.get('fromName')) or from_addr,
                    'subject': self._text(it.get('subject')) or '(无主题)',
                    'sentTime': time_text(it.get('sentTime')),
                })
        except Exception:
            items = []
        return {'configured': True, 'empId': emp_id, 'email': self._text(row.get('email')),
                'unread': self._unread(emp_id), 'items': items}

    def _normalize_box(self, params, current):
        """校验并归一化配置字段；password 单独处理（留空 = 不修改）"""
        email = self._text(params.get('email')).lower()
        if not email:
            raise BizError('邮箱地址不能为空')
        if not mail_client.RE_EMAIL.match(email):
            raise BizError('邮箱地址格式不正确')
        picked = {
            'email': email,
            'displayName': self._text(params.get('displayName'))[:80] or email.split('@')[0],
            'smtpHost': self._text(params.get('smtpHost'))[:120] or None,
            'imapHost': self._text(params.get('imapHost'))[:120] or None,
            'smtpPort': self._int_port(params.get('smtpPort')),
            'imapPort': self._int_port(params.get('imapPort')),
            'useSsl': 1 if str(params.get('useSsl', 1)).strip().lower()
            in ('1', 'true', 'yes', 'on') else 0,
            'remark': self._text(params.get('remark'))[:200] or None,
        }
        # enabled / autoSync 缺省时沿用原值（首次配置默认都开启）
        for key in ('enabled', 'autoSync'):
            raw = params.get(key)
            if raw is None:
                picked[key] = int(current.get(key)) if current else 1
            else:
                picked[key] = 1 if str(raw).strip().lower() in ('1', 'true', 'yes', 'on') else 0
        return picked

    @staticmethod
    def _int_port(value):
        text = EmpMailService._text(value)
        if not text:
            return None
        try:
            number = int(text)
        except (TypeError, ValueError):
            raise BizError('端口必须是数字')
        if number < 1 or number > 65535:
            raise BizError('端口范围应为 1-65535')
        return number

    def save(self, params):
        """保存本人信箱配置（一人一条：有则更新、无则新增；密码留空表示不修改）"""
        params = params or {}
        emp_id = self._my_emp_id(params)
        current = self._box_row(emp_id)
        picked = self._normalize_box(params, current or {})
        password = self._text(params.get('password'))
        if not current and not password:
            raise BizError('请填写邮箱密码或授权码')
        if password:
            picked['password'] = mail_client.encrypt_secret(password)

        def _write(cur):
            if current:
                assignments = ','.join('`%s`=%%s' % c for c in picked.keys())
                cur.execute('UPDATE `%s` SET %s WHERE `empId`=%%s'
                            % (self.account_table, assignments),
                            list(picked.values()) + [emp_id])
                return str(current['id'])
            picked['id'] = str(uuid.uuid4())
            picked['empId'] = emp_id
            columns = ','.join('`%s`' % c for c in picked.keys())
            holders = ','.join(['%s'] * len(picked))
            cur.execute('INSERT INTO `%s` (%s) VALUES (%s)'
                        % (self.account_table, columns, holders), list(picked.values()))
            return picked['id']

        try:
            transaction(_write)
        except DuplicateError:
            raise BizError('该员工已存在邮箱配置，请刷新页面后重试')
        return self.status({'_loginUserId': params.get('_loginUserId')})

    def test(self, params=None):
        """测试本人信箱 IMAP / SMTP 连接（用库里已保存的密码），结果写 lastError"""
        params = params or {}
        emp_id = self._my_emp_id(params)
        row = self._box_row(emp_id)
        if not row:
            raise BizError('请先配置个人邮箱')
        password = mail_client.decrypt_secret(row.get('password'))
        if not password:
            raise BizError('还没有设置密码 / 授权码，请先在「设置」里填写')
        result = mail_client.test_connection(row.get('email'), password, self._hosts_of(row))
        ok = bool(result['imap'] and result['smtp'])
        error = '' if ok else '；'.join(
            [x for x in (result['messages'].get('imap'), result['messages'].get('smtp')) if x])
        execute('UPDATE `%s` SET `lastError`=%%s WHERE `empId`=%%s'
                % self.account_table, (error[:255] or None, emp_id))
        if not ok:
            raise BizError('连接测试未通过：' + (error or '请检查邮箱地址与授权码'))
        return {'ok': True, 'imap': result['imap'], 'smtp': result['smtp'],
                'servers': result['servers'], 'messages': result['messages'],
                'email': row.get('email'), 'lastError': ''}

    # ---------------- 收件（手动 + 后台自动收件共用） ----------------
    def sync(self, params=None):
        """手动「收件」：只拉当前登录人自己的信箱"""
        params = params or {}
        emp_id = self._my_emp_id(params)
        row = self._box_row(emp_id)
        if not row:
            raise BizError('请先在右上角「设置」里配置本人邮箱')
        if not int(row.get('enabled') or 0):
            raise BizError('个人邮箱已停用，请先在「设置」里启用')
        return self._sync_row(row, params)

    def _sync_row(self, row, params):
        """按一条配置收件（供手动 sync 与后台自动收件共用；按 empId 分锁）"""
        emp_id = int(row.get('empId') or 0)
        lock = self._lock_of(emp_id)
        if not lock.acquire(False):
            raise BizError('正在收件中，请稍后再试（后台也会定期自动收件）')
        try:
            acc = self._account_of(row)
            try:
                limit = int((params or {}).get('limit') or config.MAIL_FETCH_LIMIT)
            except (TypeError, ValueError):
                limit = config.MAIL_FETCH_LIMIT
            limit = min(max(limit, 1), 200)
            try:
                mails = mail_client.fetch_inbox(acc['email'], acc['password'], acc['hosts'], limit)
            except mail_client.MailError as exc:
                execute('UPDATE `%s` SET `lastError`=%%s WHERE `empId`=%%s'
                        % self.account_table, (exc.message[:255], emp_id))
                raise BizError(exc.message)
            except Exception as exc:
                message = '收件失败：%s' % (str(exc) or exc.__class__.__name__)
                execute('UPDATE `%s` SET `lastError`=%%s WHERE `empId`=%%s'
                        % self.account_table, (message[:255], emp_id))
                raise BizError(message)

            saved = 0
            for item in mails:
                mail_id = str(uuid.uuid4())
                files = item.get('attachments') or []
                try:
                    _, rowcount = execute(
                        "INSERT IGNORE INTO `%s` (`id`,`empId`,`direction`,`uid`,`messageId`,"
                        "`fromAddr`,`fromName`,`toAddr`,`ccAddr`,`subject`,`sentTime`,`bodyText`,"
                        "`bodyHtml`,`hasAttach`,`attachInfo`,`seen`) "
                        "VALUES (%%s,%%s,'in',%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,0)"
                        % self.table,
                        (mail_id, emp_id, item['uid'], item['messageId'],
                         item['fromAddr'], item['fromName'], item['toAddr'], item['ccAddr'],
                         item['subject'], item['sentTime'], item['bodyText'], item['bodyHtml'],
                         1 if (item.get('hasAttach') or files) else 0,
                         self._attach_info_text(files)))
                    saved += int(rowcount or 0)
                    if rowcount and files:
                        mail_attach_save(self.attach_source, mail_id, emp_id, files)
                except DuplicateError:
                    continue
            now_text = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            execute('UPDATE `%s` SET `lastSyncTime`=%%s, `lastError`=NULL WHERE `empId`=%%s'
                    % self.account_table, (now_text, emp_id))
            return {'fetched': len(mails), 'saved': saved, 'email': acc['email'],
                    'empId': emp_id, 'lastSyncTime': now_text,
                    'unread': self._unread(emp_id), 'counts': self._counts(emp_id)}
        finally:
            lock.release()

    def sync_all(self):
        """后台自动收件：逐个拉取所有「启用 + 开启自动收件」的员工信箱，单个失败不影响其它"""
        try:
            rows = query_all('SELECT * FROM `%s` WHERE `enabled`=1 AND `autoSync`=1'
                             % self.account_table)
        except Exception:
            return []                     # 老库没跑 db/emp-mail.sql 时静默跳过
        out = []
        for row in rows or []:
            try:
                out.append(self._sync_row(row, {}))
            except Exception as exc:
                try:
                    execute('UPDATE `%s` SET `lastError`=%%s WHERE `empId`=%%s'
                            % self.account_table, (str(exc)[:255], row.get('empId')))
                except Exception:
                    pass
                out.append({'empId': row.get('empId'), 'email': row.get('email'),
                            'error': str(exc)})
        return out

    # ---------------- 列表 / 详情（强制带 empId） ----------------
    def page(self, params):
        params = params or {}
        emp_id = self._my_emp_id(params)
        folder = self._text(params.get('folder')).lower() or 'inbox'
        direction = 'out' if folder in ('sent', 'out', 'outbox') else 'in'
        where = ['`empId`=%s', '`direction`=%s']
        args = [emp_id, direction]
        keyword = self._text(params.get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            where.append('(`subject` LIKE %s OR `fromAddr` LIKE %s OR `fromName` LIKE %s '
                         'OR `toAddr` LIKE %s)')
            args.extend([like, like, like, like])
        # unread=1：只看未读（主框架「提醒中心」的新邮件列表用）
        if str(params.get('unread') or '').strip().lower() in ('1', 'true', 'yes', 'on'):
            where.append('`seen`=0')
        clause = ' WHERE ' + ' AND '.join(where)
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 20), 1), 100)
        except (TypeError, ValueError):
            page_num, page_size = 1, 20
        row = query_one('SELECT COUNT(*) AS n FROM `%s`%s' % (self.table, clause), args)
        total = int(row['n']) if row and row.get('n') is not None else 0
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        rows = query_all(
            'SELECT `id`,`empId`,`direction`,`fromAddr`,`fromName`,`toAddr`,`ccAddr`,`subject`,'
            '       `sentTime`,`hasAttach`,`attachInfo`,`seen`,`createTime` FROM `%s`%s '
            'ORDER BY `sentTime` DESC, `createTime` DESC LIMIT %%s OFFSET %%s'
            % (self.table, clause), args + [page_size, (page_num - 1) * page_size])
        items = []
        for r in rows:
            it = dump_row(r)
            it['seen'] = bool(int(it.get('seen') or 0))
            it['hasAttach'] = bool(int(it.get('hasAttach') or 0))
            it['attachments'] = self._attach_list(it.pop('attachInfo', None))
            it['sentTime'] = it.get('sentTime') or it.get('createTime') or ''
            it['summaryFrom'] = it.get('fromName') or it.get('fromAddr') or ''
            items.append(it)
        return {'list': items, 'total': total, 'pageNum': page_num, 'pageSize': page_size,
                'pages': pages, 'folder': 'sent' if direction == 'out' else 'inbox',
                'empId': emp_id, 'unread': self._unread(emp_id),
                'counts': self._counts(emp_id)}

    def detail(self, params):
        params = params or {}
        emp_id = self._my_emp_id(params)
        uid = self._uuid_of(params.get('id'))
        # 别人的邮件 id 在这里一律查不到（不提示「无权访问」，避免泄露邮件是否存在）
        row = query_one('SELECT * FROM `%s` WHERE `id`=%%s AND `empId`=%%s'
                        % self.table, (uid, emp_id))
        if not row:
            raise BizError('邮件不存在或已被删除', 404)
        mark_read = params.get('markRead') not in (0, '0', False, 'false')
        if mark_read and int(row.get('seen') or 0) == 0:
            execute('UPDATE `%s` SET `seen`=1 WHERE `id`=%%s AND `empId`=%%s'
                    % self.table, (uid, emp_id))
            row['seen'] = 1
        it = dump_row(row)
        it['seen'] = bool(int(it.get('seen') or 0))
        it['hasAttach'] = bool(int(it.get('hasAttach') or 0))
        # 附件下载清单：优先取落盘登记；历史邮件回退 attachInfo（标「未保存」）
        fallback = self._attach_list(it.pop('attachInfo', None))
        it['attachments'] = mail_attach_list(self.attach_source, uid, fallback=fallback)
        it['attachNeedFetch'] = mail_attach_need_fetch(self.attach_source, uid, it)
        it['sentTime'] = it.get('sentTime') or ''
        it['directionText'] = '发件' if it.get('direction') == 'out' else '收件'
        it['bodyText'] = it.get('bodyText') or ''
        it['bodyHtml'] = it.get('bodyHtml') or ''
        it['unread'] = self._unread(emp_id)
        return it

    # ---------------- 发件（发件人固定取本人配置） ----------------
    def send(self, params):
        params = params or {}
        emp_id = self._my_emp_id(params)
        row = self._box_row(emp_id)
        if not row:
            raise BizError('请先在右上角「设置」里配置本人邮箱')
        if not int(row.get('enabled') or 0):
            raise BizError('个人邮箱已停用，请先在「设置」里启用')
        acc = self._account_of(row)
        to_list = self._addresses(params.get('to'), '收件人')
        cc_list = self._addresses(params.get('cc'), '抄送人')
        if not to_list:
            raise BizError('请填写收件人')
        subject = self._text(params.get('subject'))
        if not subject:
            raise BizError('请填写邮件主题')
        body = '' if params.get('body') is None else str(params.get('body'))
        # 富文本正文（同上：HTML 片段 + 反抽纯文本）
        body_html_raw = '' if params.get('bodyHtml') is None else str(params.get('bodyHtml'))
        body_html = mail_client.clean_html(body_html_raw) if body_html_raw.strip() else ''
        if not body.strip() and body_html:
            body = mail_client.html_to_text(body_html)
        if not body.strip():
            raise BizError('请填写邮件正文')
        attachments = self._attachments(params.get('attachments'))
        try:
            mail_client.send_mail(acc['email'], acc['password'], acc['hosts'], to_list,
                                  subject, body, cc_list, acc['displayName'],
                                  attachments=[{'name': one['name'], 'data': one['data'],
                                                'contentType': one['contentType']}
                                               for one in attachments],
                                  body_html=body_html)
        except mail_client.MailError as exc:
            raise BizError(exc.message)

        uid = str(uuid.uuid4())
        now_text = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        attach_info = json.dumps([{'name': one['name'], 'size': one['size']} for one in attachments],
                                 ensure_ascii=False) if attachments else None
        execute("INSERT INTO `%s` (`id`,`empId`,`direction`,`uid`,`messageId`,"
                "`fromAddr`,`fromName`,`toAddr`,`ccAddr`,`subject`,`sentTime`,`bodyText`,"
                "`bodyHtml`,`hasAttach`,`attachInfo`,`seen`) "
                "VALUES (%%s,%%s,'out',%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,1)" % self.table,
                (uid, emp_id, uid, '', acc['email'], acc['displayName'] or acc['email'],
                 ', '.join(to_list), ', '.join(cc_list), subject[:500], now_text, body,
                 body_html or None,
                 1 if attachments else 0, (attach_info or '')[:1000] or None))
        # 发件附件也落盘（按本人 empId 登记，下载时强隔离）
        sent_attach = mail_attach_save(self.attach_source, uid, emp_id, attachments)
        return {'id': uid, 'to': to_list, 'cc': cc_list, 'subject': subject,
                'sentTime': now_text, 'email': acc['email'],
                'attachments': sent_attach,
                'counts': self._counts(emp_id)}

    # ---------------- 已读 / 删除（强制带 empId，杜绝越权） ----------------
    def mark(self, params):
        params = params or {}
        emp_id = self._my_emp_id(params)
        ids = self._ids_of(params)
        seen = 1 if str(params.get('seen', 1)).strip().lower() in ('1', 'true', 'yes', 'on') else 0
        holders = ','.join(['%s'] * len(ids))
        _, rowcount = execute('UPDATE `%s` SET `seen`=%%s WHERE `empId`=%%s AND `id` IN (%s)'
                              % (self.table, holders), [seen, emp_id] + ids)
        return {'updated': int(rowcount or 0), 'seen': bool(seen),
                'unread': self._unread(emp_id)}

    def delete(self, params):
        emp_id = self._my_emp_id(params)
        ids = self._ids_of(params)
        holders = ','.join(['%s'] * len(ids))
        _, rowcount = execute('DELETE FROM `%s` WHERE `empId`=%%s AND `id` IN (%s)'
                              % (self.table, holders), [emp_id] + ids)
        mail_attach_purge(self.attach_source, ids)      # 附件登记与磁盘文件一并清理
        return {'deleted': int(rowcount or 0), 'ids': ids}


emp_mail_service = EmpMailService()


class MailSyncWorker(threading.Thread):
    """
    后台自动收件线程（daemon）
      · 启动后先等 config.MAIL_SYNC_DELAY 秒，之后每 config.MAIL_SYNC_MINUTES 分钟收一次件
      · 一轮 tick 收两类信箱：
          ① 系统服务信箱（单例，原有行为，兼容忘记密码发验证码等）；
          ② **所有「启用 + 开启自动收件」的员工个人信箱**（EmpMailService.sync_all），
             每个员工用自己的 IMAP 凭据、按自己的 empId 入库，彼此互不干扰。
      · 没有启用信箱、或某个邮箱暂时不可达时只打印日志，不影响主服务与其它信箱
    """

    def __init__(self, interval_seconds, first_delay):
        super(MailSyncWorker, self).__init__(name='mail-sync', daemon=True)
        self.interval = max(30, int(interval_seconds))
        self.first_delay = max(0, int(first_delay))
        self._stop_event = threading.Event()

    def stop(self):
        self._stop_event.set()

    def tick(self):
        """收一次件（异常只记日志，后台任务不允许把异常抛到主线程）"""
        result = None
        # ① 系统服务信箱（单例）
        try:
            acc = query_one('SELECT `id`,`email` FROM `serviceemail` WHERE `enabled`=1 LIMIT 1')
            if acc:
                result = mail_service.sync({})
                print('[mail-sync] %s 收件完成：拉取 %s 封，新增 %s 封'
                      % (acc.get('email'), result.get('fetched'), result.get('saved')))
        except Exception as exc:
            print('[mail-sync] 服务信箱自动收件跳过：%s' % exc)
        # ② 员工个人信箱（强隔离，逐个收；单个失败由 sync_all 内部兜底）
        try:
            emp_results = emp_mail_service.sync_all()
            for one in emp_results or []:
                if one.get('error'):
                    print('[mail-sync] 员工信箱 %s 自动收件跳过：%s'
                          % (one.get('email'), one.get('error')))
                elif one.get('saved'):
                    print('[mail-sync] 员工信箱 %s 收件完成：拉取 %s 封，新增 %s 封'
                          % (one.get('email'), one.get('fetched'), one.get('saved')))
        except Exception as exc:
            print('[mail-sync] 员工信箱自动收件跳过：%s' % exc)
        return result

    def run(self):
        if self._stop_event.wait(self.first_delay):
            return
        while not self._stop_event.is_set():
            self.tick()
            if self._stop_event.wait(self.interval):
                return


mail_worker = None


class EmpMessageService(object):
    """
    站内消息（emp_msgs）：员工间互发的平台内部消息（区别于「我的邮箱」的 IMAP/SMTP 真实邮件）
      · 数据隔离以「发件人 / 收件人」双向归属实现，后端由 token 反查 empId（useinfo.empId），
        绝不接受前端传来的 senderId / receiverId 作为归属依据：
          - 收件箱 = receiverId = 当前员工 且 receiverDeleted = 0；
          - 已发送 = senderId   = 当前员工 且 senderDeleted   = 0；
          - 别人的消息、或传别人的 id，一律查不到（不提示「无权访问」，避免泄露存在性）。
      · 软删除按角色：收件人删 → receiverDeleted=1（发件人「已发送」仍可见）；
        发件人删 → senderDeleted=1（收件人「收件箱」仍可见）；双方都删 → 物理删除。
      · 发件人 / 收件人姓名发送时快照；支持一对多发（每个收件人一条独立记录，各自独立已读 / 删除）。
    对外接口：GET  /api/msg/status|list|detail
              POST /api/msg/send|mark|delete
    """

    table = 'emp_msgs'
    emp_table = 'empinfos'
    label = '站内消息'

    LOGIN_EMP_SQL = 'SELECT `empId` AS `empId` FROM `useinfo` WHERE `id`=%s LIMIT 1'

    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _as_int(value, default=0):
        try:
            if value is None or value == '':
                return default
            return int(value)
        except (TypeError, ValueError):
            return default

    def _my_emp_id(self, params):
        """当前登录人的员工ID；只认 token 反查结果，绝不接受前端传参（数据隔离的根）"""
        user_id = self._text((params or {}).get('_loginUserId'))
        if not user_id:
            raise BizError('登录已失效，请重新登录', 401)
        try:
            row = query_one(self.LOGIN_EMP_SQL, (user_id,))
        except Exception:
            row = None
        emp_id = int(row['empId']) if row and row.get('empId') else 0
        if not emp_id:
            raise BizError('当前登录账号未绑定员工，无法使用「站内消息」')
        return emp_id

    # ---------------- 员工姓名快照 ----------------
    def _emp_name(self, emp_id):
        try:
            row = query_one('SELECT `nameCn` FROM `%s` WHERE `id`=%%s LIMIT 1'
                             % self.emp_table, (emp_id,))
        except Exception:
            return ''
        return self._text(row.get('nameCn')) if row else ''

    def _emp_names(self, emp_ids):
        """批量取员工姓名：返回 {empId: nameCn}"""
        out = {}
        ids = []
        for x in emp_ids:
            try:
                ids.append(int(x))
            except (TypeError, ValueError):
                continue
        if not ids:
            return out
        try:
            holders = ','.join(['%s'] * len(ids))
            rows = query_all('SELECT `id`,`nameCn` FROM `%s` WHERE `id` IN (%s)'
                             % (self.emp_table, holders), ids)
        except Exception:
            return out
        for r in rows or []:
            out[int(r['id'])] = self._text(r.get('nameCn'))
        return out

    # ---------------- 统计 ----------------
    def _unread(self, emp_id):
        row = query_one(
            "SELECT COUNT(*) AS n FROM `%s` WHERE `receiverId`=%%s "
            "AND `receiverDeleted`=0 AND `readStatus`=0" % self.table, (emp_id,))
        return int(row['n']) if row and row.get('n') is not None else 0

    def _counts(self, emp_id):
        row = query_one(
            "SELECT "
            "SUM(CASE WHEN `senderId`=%%s AND `senderDeleted`=0 THEN 1 ELSE 0 END) AS sent, "
            "SUM(CASE WHEN `receiverId`=%%s AND `receiverDeleted`=0 THEN 1 ELSE 0 END) AS inbox "
            "FROM `%s`" % (self.table,), (emp_id, emp_id)) or {}
        return {'sent': int(row.get('sent') or 0), 'inbox': int(row.get('inbox') or 0)}

    # ---------------- 状态（页面初始化） ----------------
    def status(self, params=None):
        emp_id = self._my_emp_id(params)
        gsnap = {'list': [], 'unread': 0}
        try:
            gsnap = self.groups(params)
        except Exception:
            pass
        return {
            'empId': emp_id,
            'unread': self._unread(emp_id),
            'groupUnread': int(gsnap.get('unread') or 0),
            'groupCount': len(gsnap.get('list') or []),
            'counts': self._counts(emp_id),
            'message': ''
        }

    # ---------------- 未读聚合（主框架「提醒中心」） ----------------
    def unread_summary(self, params=None, limit=8):
        """按发件人聚合的未读快照：主框架铃铛 / 左侧菜单上标 / 语音提醒的数据源。

        · 只查 `readStatus=0` 的收件（且 `receiverDeleted=0`），比 contacts() 轻得多，
          适合主框架每十几秒轮询一次；
        · 只对「有未读」的发件人取最近一条内容（最多 limit 人），不做全表 2000 条的会话归并；
        · 时间统一走 time_text()（dump_row 之后是字符串，再 .strftime() 会炸）。
        :return {empId, unread, peers:[{empId,name,deptName,avatarText,unread,lastContent,lastTime}]}
        """
        me = self._my_emp_id(params)
        try:
            limit = max(1, min(int(limit or 8), 50))
        except (TypeError, ValueError):
            limit = 8
        try:
            rows = query_all(
                "SELECT `senderId`, COUNT(*) AS `n`, MAX(`sendTime`) AS `t` FROM `%s` "
                "WHERE `receiverId`=%%s AND `receiverDeleted`=0 AND `readStatus`=0 "
                "  AND `senderId`<>0 AND `senderId`<>%%s "
                "GROUP BY `senderId` ORDER BY `t` DESC" % self.table, (me, me)) or []
        except Exception:
            rows = []
        total = 0
        for r in rows:
            total += int(r.get('n') or 0)
        picked = rows[:limit]
        peers = []
        if picked:
            ids = [int(r['senderId']) for r in picked]
            info, dmap = {}, {}
            try:
                ph = ','.join(['%s'] * len(ids))
                erows = query_all(
                    'SELECT `id`,`nameCn`,`deptId`,`jobTitle` FROM `%s` WHERE `id` IN (%s)'
                    % (self.emp_table, ph), ids) or []
                for e in erows:
                    info[int(e['id'])] = e
                drows = query_all('SELECT `id`,`nameCn` FROM `OrganizationStructure`') or []
                dmap = dict((int(d['id']), d['nameCn']) for d in drows)
            except Exception:
                info, dmap = {}, {}
            for r in picked:
                eid = int(r['senderId'])
                e = info.get(eid) or {}
                name = self._text(e.get('nameCn')) or ('员工' + str(eid))
                last = {}
                try:
                    last = query_one(
                        "SELECT `content`,`sendTime` FROM `%s` WHERE `receiverId`=%%s AND `senderId`=%%s "
                        "  AND `receiverDeleted`=0 AND `readStatus`=0 "
                        "ORDER BY `sendTime` DESC, `createTime` DESC LIMIT 1" % self.table,
                        (me, eid)) or {}
                except Exception:
                    last = {}
                peers.append({
                    'empId': eid,
                    'name': name,
                    'deptName': dmap.get(int(e.get('deptId') or 0), ''),
                    'jobTitle': self._text(e.get('jobTitle')),
                    'avatarText': name[:1],
                    'unread': int(r.get('n') or 0),
                    'lastContent': self._text(last.get('content'))[:80],
                    'lastTime': time_text(last.get('sendTime') or r.get('t')),
                })
        # ---- 群未读：与「按人聚合」同一套口径，群条目独立返回，前端排在人的后面 ----
        groups, g_total = [], 0
        try:
            gsnap = self.groups(params)
        except Exception:
            gsnap = {'list': []}
        for g in (gsnap.get('list') or []):
            n = int(g.get('unread') or 0)
            if n <= 0:
                continue
            g_total += n
            if len(groups) < limit:
                groups.append({
                    'groupId': g['groupId'], 'isGroup': True, 'name': g['name'],
                    'avatarText': g.get('avatarText') or '', 'unread': n,
                    'lastContent': g.get('lastContent') or '',
                    'lastTime': g.get('lastTime') or '',
                    'lastSenderName': g.get('lastSenderName') or '',
                })
        total += g_total
        return {'empId': me, 'unread': total, 'peers': peers,
                'groups': groups, 'groupUnread': g_total}

    # ---------------- 联系人快照（全员可互发 + 在线状态 + 未读 + 最近消息） ----------------
    def contacts(self, params=None):
        """返回所有其它员工作为联系人：在线状态（来自 presence 注册表）、与我的未读条数、最近一条消息预览。
        排序：有会话的（按最近消息时间倒序）在前，其余按工号。"""
        params = params or {}
        me = self._my_emp_id(params)
        try:
            rows = query_all(
                "SELECT `id`,`code`,`nameCn`,`deptId`,`jobTitle`,`status` FROM `%s` "
                "WHERE `id`<>%%s ORDER BY `code` ASC" % self.emp_table, (me,))
        except Exception:
            rows = []
        dmap = {}
        try:
            drows = query_all('SELECT `id`,`nameCn` FROM `OrganizationStructure`')
            dmap = dict((int(r['id']), r['nameCn']) for r in drows)
        except Exception:
            dmap = {}
        # 取与我相关的消息（双向），用于算「最近一条 / 未读」
        msgs = []
        try:
            mrows = query_all(
                "SELECT `id`,`senderId`,`receiverId`,`content`,`sendTime`,`readStatus` FROM `%s` "
                "WHERE (`senderId`=%%s AND `receiverDeleted`=0 AND `senderId`<>0) "
                "   OR (`receiverId`=%%s AND `receiverDeleted`=0 AND `receiverId`<>0) "
                "ORDER BY `sendTime` DESC, `createTime` DESC LIMIT 2000" % self.table,
                (me, me))
            msgs = mrows or []
        except Exception:
            msgs = []
        last = {}      # peerId -> {content, sendTime, fromMe, senderId}
        unread = {}    # peerId -> 未读计数
        for m in msgs:
            s = int(m['senderId'] or 0)
            r = int(m['receiverId'] or 0)
            if s == r:
                continue
            peer = r if s == me else s
            if peer not in last:
                st = m.get('sendTime')
                last[peer] = {
                    'content': self._text(m.get('content'))[:120],
                    'sendTime': st.strftime('%Y-%m-%d %H:%M:%S') if hasattr(st, 'strftime') else (st or ''),
                    'fromMe': s == me,
                    'senderId': s,
                }
            if r == me and not int(m.get('readStatus') or 0):
                unread[peer] = unread.get(peer, 0) + 1
        out = []
        for e in rows:
            eid = int(e['id'])
            status = int(e.get('status') or 0)
            item = {
                'empId': eid,
                'name': self._text(e.get('nameCn')),
                'code': self._text(e.get('code')),
                'deptId': int(e.get('deptId') or 0),
                'deptName': dmap.get(int(e.get('deptId') or 0), ''),
                'jobTitle': self._text(e.get('jobTitle')),
                'status': status,
                'statusText': EMP_STATUS_TEXT.get(status, ''),
                'avatarText': (self._text(e.get('nameCn')) or '?')[:1],
                'online': presence.is_online(eid),
                'unread': int(unread.get(eid, 0)),
            }
            lw = last.get(eid)
            if lw:
                item['lastContent'] = lw['content']
                item['lastTime'] = lw['sendTime']
                item['lastFromMe'] = bool(lw['fromMe'])
                item['lastSenderId'] = int(lw['senderId'])
            else:
                item['lastContent'] = ''
                item['lastTime'] = ''
                item['lastFromMe'] = False
                item['lastSenderId'] = 0
            out.append(item)
        # 有会话的（lastTime 非空）排前，组内按时间倒序；无会话的置后（稳定排序）
        out.sort(key=lambda it: it['lastTime'], reverse=True)
        out.sort(key=lambda it: (1 if not it['lastTime'] else 0))
        return {'me': me, 'list': out, 'onlineCount': presence.online_count()}

    # ---------------- 会话历史（与某员工的所有消息，按时间正序；自动标记已读） ----------------
    def history(self, params=None):
        params = params or {}
        me = self._my_emp_id(params)
        peer = self._as_int(params.get('peerId'))
        if not peer:
            raise BizError('请指定对话对象')
        prow = query_one('SELECT `id`,`nameCn`,`deptId`,`jobTitle`,`status` FROM `%s` WHERE `id`=%%s'
                         % self.emp_table, (peer,))
        if not prow:
            raise BizError('对话对象不存在')
        dmap = {}
        try:
            drows = query_all('SELECT `id`,`nameCn` FROM `OrganizationStructure`')
            dmap = dict((int(r['id']), r['nameCn']) for r in drows)
        except Exception:
            dmap = {}
        peer_info = {
            'empId': int(prow['id']),
            'name': self._text(prow.get('nameCn')),
            'deptId': int(prow.get('deptId') or 0),
            'deptName': dmap.get(int(prow.get('deptId') or 0), ''),
            'jobTitle': self._text(prow.get('jobTitle')),
            'status': int(prow.get('status') or 0),
            'statusText': EMP_STATUS_TEXT.get(int(prow.get('status') or 0), ''),
            'avatarText': (self._text(prow.get('nameCn')) or '?')[:1],
            'online': presence.is_online(int(prow['id'])),
        }
        try:
            rows = query_all(
                "SELECT * FROM `%s` WHERE ((`senderId`=%%s AND `receiverId`=%%s AND `senderDeleted`=0) "
                "OR (`senderId`=%%s AND `receiverId`=%%s AND `receiverDeleted`=0)) "
                "ORDER BY `sendTime` ASC, `createTime` ASC LIMIT 500"
                % self.table, (me, peer, peer, me))
        except Exception:
            rows = []
        list_out = []
        fmap = self._attach_of([r.get('attachId') for r in rows])
        for r in rows:
            it = dump_row(r)
            it['isInbox'] = int(it.get('receiverId') or 0) == me
            it['readStatus'] = int(it.get('readStatus') or 0)
            it['content'] = it.get('content') or ''
            it['sendTime'] = it.get('sendTime') or ''
            it['msgType'] = self._text(it.get('msgType')) or 'text'
            it['attachId'] = self._text(it.get('attachId'))
            it['contentHtml'] = self._text(it.get('contentHtml'))
            it['atEmpIds'] = self._text(it.get('atEmpIds'))
            it['attach'] = fmap.get(it['attachId']) or None
            list_out.append(it)
        self.mark_peer_raw(me, peer)   # 打开会话即标记已读（仅我是收件人的部分）
        return {'me': me, 'peer': peer_info, 'list': list_out}

    # ---------------- 标记与某员工的对话为已读（REST / WS 共用） ----------------
    def mark_peer(self, params=None):
        params = params or {}
        me = self._my_emp_id(params)
        peer = self._as_int(params.get('peerId'))
        if not peer:
            raise BizError('请指定对话对象')
        updated = self.mark_peer_raw(me, peer)
        return {'updated': updated, 'unread': self._unread(me)}

    def mark_peer_raw(self, me, peer):
        """把「对方发给我的、未读的」消息置为已读；返回更新条数（不依赖 token，供 WS handler 调用）。"""
        me = self._as_int(me)
        peer = self._as_int(peer)
        _, rowcount = execute(
            'UPDATE `%s` SET `readStatus`=1 WHERE `receiverId`=%%s AND `senderId`=%%s '
            'AND `readStatus`=0 AND `receiverDeleted`=0' % self.table, (me, peer))
        return int(rowcount or 0)

    # ---------------- 落库发送（WS 与 REST 共用，发件人固定取本人） ----------------
    def persist_send(self, sender_id, receiver_ids, content, title='',
                     msg_type='text', attach_id='', group_id='',
                     content_html='', at_emp_ids=None):
        """核心写入：私聊「每个收件人一条独立记录」，群聊「一条记录 + receiverId=0」。

        :param msg_type: text / image / file / sticker（有附件时由附件决定，缺省 text）
        :param attach_id: empmsgfiles.id（必须是本人上传的附件）
        :param group_id:  群ID；非空表示群消息（此时忽略 receiver_ids，收件人取群成员）
        :param content_html: 富文本正文（HTML 片段）；content 仍存纯文本，供列表 / 搜索 / 未读摘要用
        :param at_emp_ids: 群聊里 @ 到的 empId（列表或逗号串）；**只保留确实是该群成员的**
        返回创建的消息列表（含真实 id / sendTime / attach 等），供 WS 推送给收发双方。
        """
        sender_id = self._as_int(sender_id)
        if not sender_id:
            raise BizError('发送人身份无效')
        msg_type = (self._text(msg_type) or 'text').lower()
        if msg_type not in ('text', 'image', 'file', 'sticker', 'audio'):
            msg_type = 'text'
        attach_id = self._text(attach_id)
        group_id = self._text(group_id)
        content = '' if content is None else str(content)
        content_html = '' if content_html is None else str(content_html)
        # 富文本：编辑器可能只给 HTML（正文纯文本随之反抽），这里兜一层
        if not content.strip() and content_html.strip():
            content = mail_client.html_to_text(content_html)
        # 附件消息允许正文为空（自动补一个可读的占位，供列表预览 / 未读摘要使用）
        if not content.strip():
            if attach_id:
                if msg_type == 'image':
                    content = '[图片]'
                elif msg_type == 'sticker':
                    content = '[表情]'
                elif msg_type == 'audio':
                    content = '[语音]'
                else:
                    content = '[文件]'
                content_html = ''
            else:
                raise BizError('消息内容不能为空')
        title = self._text(title)
        if not title:
            title = content[:20]      # IM 以正文为主；标题留空则取正文前 20 字，仅供历史/归档列表兼容展示
        sender_name = self._emp_name(sender_id) or ('员工' + str(sender_id))
        now_text = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        created = []

        # ---------- 群消息：一条记录，groupId 归属，收件人字段不参与 ----------
        if group_id:
            group = self._group_row(group_id, me=sender_id)      # 校验群存在 + 本人是成员
            if attach_id:
                self._claim_attach(attach_id, sender_id)
            uid = str(uuid.uuid4())
            at_ids = self._at_ids_of(at_emp_ids, group_id)
            content_html = mail_client.clean_html(content_html) if content_html.strip() else ''
            execute(
                'INSERT INTO `%s` (`id`,`senderId`,`senderName`,`receiverId`,`receiverName`,'
                '`title`,`content`,`contentHtml`,`msgType`,`attachId`,`groupId`,`atEmpIds`,`sendTime`,'
                '`readStatus`,`senderDeleted`,`receiverDeleted`) '
                'VALUES (%%s,%%s,%%s,0,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,0,0,0)' % self.table,
                (uid, sender_id, sender_name, self._text(group.get('groupName'))[:50],
                 title[:200], content, content_html or None, msg_type, attach_id, group_id,
                 at_ids, now_text))
            if attach_id:
                execute('UPDATE `empmsgfiles` SET `msgId`=%s WHERE `id`=%s', (uid, attach_id))
            created.append({
                'id': uid, 'senderId': sender_id, 'senderName': sender_name,
                'receiverId': 0, 'receiverName': self._text(group.get('groupName')),
                'groupId': group_id, 'msgType': msg_type, 'attachId': attach_id,
                'title': title[:200], 'content': content, 'contentHtml': content_html,
                'atEmpIds': at_ids, 'sendTime': now_text, 'readStatus': 0,
                'attach': self._attach_of([attach_id]).get(attach_id) if attach_id else None,
            })
            # 发消息即视为自己已读该群：把本人 lastReadTime 推到现在
            self._touch_group_read(group_id, sender_id)
            return created

        # ---------- 私聊：每个收件人一条独立记录 ----------
        if isinstance(receiver_ids, int):
            receiver_ids = [receiver_ids]
        ids = []
        seen = set()
        for x in receiver_ids:
            n = self._as_int(x)
            if n and n not in seen:
                seen.add(n)
                ids.append(n)
        if not ids:
            raise BizError('请选择收件人')
        names = self._emp_names(ids)
        missing = [x for x in ids if x not in names]
        if missing:
            raise BizError('部分收件人不存在（empId=%s），请重新选择'
                           % ','.join(str(x) for x in missing))
        if attach_id:
            self._claim_attach(attach_id, sender_id)
        attach = self._attach_of([attach_id]).get(attach_id) if attach_id else None
        content_html = mail_client.clean_html(content_html) if content_html.strip() else ''
        for rid in ids:
            uid = str(uuid.uuid4())
            execute(
                'INSERT INTO `%s` (`id`,`senderId`,`senderName`,`receiverId`,`receiverName`,'
                '`title`,`content`,`contentHtml`,`msgType`,`attachId`,`groupId`,`sendTime`,'
                '`readStatus`,`senderDeleted`,`receiverDeleted`) '
                'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,\'\',%%s,0,0,0)' % self.table,
                (uid, sender_id, sender_name, rid, names[rid], title[:200],
                 content, content_html or None, msg_type, attach_id, now_text))
            created.append({
                'id': uid, 'senderId': sender_id, 'senderName': sender_name,
                'receiverId': rid, 'receiverName': names[rid],
                'groupId': '', 'msgType': msg_type, 'attachId': attach_id,
                'title': title[:200], 'content': content, 'contentHtml': content_html,
                'atEmpIds': '', 'sendTime': now_text,
                'readStatus': 0, 'attach': attach,
            })
        if attach_id:
            execute('UPDATE `empmsgfiles` SET `msgId`=%s WHERE `id`=%s',
                    (created[0]['id'], attach_id))
        return created

    # ---------------- 列表（收件箱 / 已发送，强制带 empId） ----------------
    def page(self, params):
        params = params or {}
        emp_id = self._my_emp_id(params)
        folder = self._text(params.get('folder')).lower() or 'inbox'
        is_sent = folder in ('sent', 'out', 'outbox')
        if is_sent:
            where = ['`senderId`=%s', '`senderDeleted`=0']
            args = [emp_id]
            peer_field, peer_name_field = 'receiverId', 'receiverName'
        else:
            where = ['`receiverId`=%s', '`receiverDeleted`=0']
            args = [emp_id]
            peer_field, peer_name_field = 'senderId', 'senderName'
        keyword = self._text(params.get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            where.append('(`title` LIKE %s OR `content` LIKE %s)')
            args.extend([like, like])
        clause = ' WHERE ' + ' AND '.join(where)
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 20), 1), 100)
        except (TypeError, ValueError):
            page_num, page_size = 1, 20
        row = query_one('SELECT COUNT(*) AS n FROM `%s`%s' % (self.table, clause), args)
        total = int(row['n']) if row and row.get('n') is not None else 0
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        rows = query_all(
            'SELECT `id`,`senderId`,`senderName`,`receiverId`,`receiverName`,'
            '`title`,`content`,`sendTime`,`readStatus`,`senderDeleted`,`receiverDeleted` '
            'FROM `%s`%s ORDER BY `sendTime` DESC, `createTime` DESC LIMIT %%s OFFSET %%s'
            % (self.table, clause), args + [page_size, (page_num - 1) * page_size])
        items = []
        for r in rows:
            it = dump_row(r)
            it['isInbox'] = not is_sent
            it['readStatus'] = int(it.get('readStatus') or 0)
            it['unread'] = bool(it['isInbox'] and it['readStatus'] == 0)
            it['peerId'] = int(it.get(peer_field) or 0)
            it['peerName'] = it.get(peer_name_field) or ''
            it.pop('content', None)            # 列表不返回正文，阅读时再取
            items.append(it)
        return {'list': items, 'total': total, 'pageNum': page_num,
                'pageSize': page_size, 'pages': pages,
                'folder': 'sent' if is_sent else 'inbox',
                'empId': emp_id, 'unread': self._unread(emp_id),
                'counts': self._counts(emp_id)}

    # ---------------- 详情（必须对本人生效，否则查不到） ----------------
    def detail(self, params):
        params = params or {}
        emp_id = self._my_emp_id(params)
        uid = self._uuid_of(params.get('id'))
        # 只有「我是收件人且未删」或「我是发件人且未删」才能看到这条消息
        row = query_one(
            'SELECT * FROM `%s` WHERE `id`=%%s AND '
            '((`receiverId`=%%s AND `receiverDeleted`=0) OR (`senderId`=%%s AND `senderDeleted`=0))'
            % self.table, (uid, emp_id, emp_id))
        if not row:
            raise BizError('消息不存在或已被删除', 404)
        # 标记已读：仅当我是收件人且当前未读
        mark_read = params.get('markRead') not in (0, '0', False, 'false')
        if mark_read and int(row.get('receiverId') or 0) == emp_id \
                and int(row.get('readStatus') or 0) == 0:
            execute('UPDATE `%s` SET `readStatus`=1 WHERE `id`=%%s' % self.table, (uid,))
            row['readStatus'] = 1
        it = dump_row(row)
        it['isInbox'] = int(row.get('receiverId') or 0) == emp_id
        it['readStatus'] = int(it.get('readStatus') or 0)
        it['unread'] = bool(it['isInbox'] and it['readStatus'] == 0)
        it['content'] = it.get('content') or ''
        it['contentHtml'] = self._text(it.get('contentHtml'))
        it['atEmpIds'] = self._text(it.get('atEmpIds'))
        it['sendTime'] = it.get('sendTime') or ''
        it['senderNameText'] = it.get('senderName') or ''
        it['receiverNameText'] = it.get('receiverName') or ''
        it['unread'] = self._unread(emp_id)
        return it

    # ---------------- 发送（REST 入口：发件人固定取本人，支持一对多） ----------------
    def send(self, params):
        params = params or {}
        emp_id = self._my_emp_id(params)
        msg_type = (self._text(params.get('msgType')) or 'text').lower()
        if msg_type not in ('text', 'image', 'file', 'sticker', 'audio'):
            msg_type = 'text'
        attach_id = self._text(params.get('attachId'))
        group_id = self._text(params.get('groupId'))
        title = self._text(params.get('title'))
        content = '' if params.get('content') is None else str(params.get('content'))
        # 富文本正文 + 群聊 @ 的组员（@ 只对群消息有意义，私聊忽略）
        content_html = '' if params.get('contentHtml') is None else str(params.get('contentHtml'))
        at_emp_ids = params.get('atEmpIds') if group_id else None
        # 群消息：收件人由群成员决定，前端不需要（也不应该）传 receiverIds
        if group_id:
            created = self.persist_send(emp_id, [0], content, title, msg_type, attach_id, group_id,
                                        content_html=content_html, at_emp_ids=at_emp_ids)
            return {'ids': [c['id'] for c in created], 'count': len(created),
                    'title': created[0]['title'] if created else '',
                    'sentTime': created[0]['sendTime'] if created else '',
                    'groupId': group_id, 'msgType': msg_type, 'attachId': attach_id,
                    'contentHtml': created[0].get('contentHtml') if created else '',
                    'atEmpIds': created[0].get('atEmpIds') if created else '',
                    'attach': created[0].get('attach') if created else None,
                    'counts': self._counts(emp_id),
                    'unread': self._unread(emp_id)}
        # 收件人：优先 receiverIds 数组，其次 receiverId / receiver 单值（允许逗号分隔）
        raw = params.get('receiverIds')
        if raw is None:
            raw = params.get('receiverId')
        if raw is None:
            raw = params.get('receiver')
        if raw is None or (isinstance(raw, str) and not self._text(raw)):
            raise BizError('请选择收件人')
        if isinstance(raw, (list, tuple)):
            id_items = [str(x) for x in raw]
        else:
            id_items = re.split(r'[,\s]+', self._text(raw))
        ids = []
        seen = set()
        for x in id_items:
            x = self._text(x)
            if not x:
                continue
            try:
                n = int(x)
            except (TypeError, ValueError):
                raise BizError('收件人 ID 不合法：' + x)
            if n not in seen:
                seen.add(n)
                ids.append(n)
        if not ids:
            raise BizError('请选择收件人')
        # 附件消息允许不填正文（persist_send 会自动补「[图片] / [表情] / [文件]」占位）；
        # 富文本消息可能只给了 contentHtml（纯文本在 persist_send 里从 HTML 反抽）
        if not content.strip() and not content_html.strip() and not attach_id:
            raise BizError('请填写消息内容')
        created = self.persist_send(emp_id, ids, content, title, msg_type, attach_id,
                                    content_html=content_html)
        return {'ids': [c['id'] for c in created], 'count': len(created),
                'title': created[0]['title'] if created else '', 'sentTime': created[0]['sendTime'] if created else '',
                'msgType': msg_type, 'attachId': attach_id,
                'contentHtml': created[0].get('contentHtml') if created else '',
                'attach': created[0].get('attach') if created else None,
                'counts': self._counts(emp_id),
                'unread': self._unread(emp_id)}

    # ---------------- 标记已读（仅收件人本人，杜绝越权） ----------------
    def mark(self, params):
        params = params or {}
        emp_id = self._my_emp_id(params)
        ids = self._ids_of(params, name='消息')
        read = 1 if str(params.get('read', 1)).strip().lower() in ('1', 'true', 'yes', 'on') else 0
        holders = ','.join(['%s'] * len(ids))
        # 只允许标记「我是收件人」的消息
        _, rowcount = execute(
            'UPDATE `%s` SET `readStatus`=%%s WHERE `receiverId`=%%s AND `id` IN (%s)'
            % (self.table, holders), [read, emp_id] + ids)
        return {'updated': int(rowcount or 0), 'read': bool(read),
                'unread': self._unread(emp_id)}

    # ---------------- 删除（按当前员工角色软删；双方都删才物理删） ----------------
    def delete(self, params):
        params = params or {}
        emp_id = self._my_emp_id(params)
        ids = self._ids_of(params, name='消息')
        holders = ','.join(['%s'] * len(ids))
        # 我是收件人 → 置 receiverDeleted；我是发件人 → 置 senderDeleted
        execute('UPDATE `%s` SET `receiverDeleted`=1 WHERE `receiverId`=%%s AND `id` IN (%s)'
                % (self.table, holders), [emp_id] + ids)
        execute('UPDATE `%s` SET `senderDeleted`=1 WHERE `senderId`=%%s AND `id` IN (%s)'
                % (self.table, holders), [emp_id] + ids)
        # 双方都已删除 → 物理删除，彻底释放空间
        execute('DELETE FROM `%s` WHERE `senderDeleted`=1 AND `receiverDeleted`=1' % self.table)
        return {'deleted': len(ids), 'ids': ids,
                'unread': self._unread(emp_id),
                'counts': self._counts(emp_id)}

    # =====================================================================
    # 媒体附件（图片 / 文件）：先上传拿 fileId，再随消息发送
    #   · 实体落盘 <WEB_ROOT>/data/imfiles/<YYYYMM>/<uuid>.<ext>，库里只存相对路径；
    #   · 只有上传者本人能把该附件发出去（防「拿别人的 fileId 转发 / 试探」）；
    #   · 发送成功时把 empmsgfiles.msgId 回填，便于日后清理孤儿文件。
    # =====================================================================
    MIME_OF_EXT = {
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif',
        'bmp': 'image/bmp', 'webp': 'image/webp', 'pdf': 'application/pdf',
        'txt': 'text/plain', 'log': 'text/plain', 'csv': 'text/csv', 'json': 'application/json',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'zip': 'application/zip', 'rar': 'application/vnd.rar', '7z': 'application/x-7z-compressed',
        'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'mp4': 'video/mp4', 'm4a': 'audio/mp4',
    }

    @staticmethod
    def _ext_of(name):
        return re.sub(r'[^0-9a-z]', '', os.path.splitext(str(name or ''))[1].lower().lstrip('.'))[:10]

    def _decode_im_file(self, payload):
        """解析前端 FileReader 读出的 base64（允许 data URL 前缀），返回 (文件名, 字节, 扩展名)"""
        payload = payload or {}
        name = os.path.basename((self._text(payload.get('fileName')) or '').replace('\\', '/'))[:255]
        if not name:
            raise BizError('文件名不能为空，请重新选择文件')
        text = payload.get('data')
        if text is None:
            raise BizError('请选择要上传的文件')
        text = str(text)
        if ';base64,' in text[:300]:
            text = text.split(';base64,', 1)[1]
        text = re.sub(r'\s+', '', text)
        try:
            raw = base64.b64decode(text.encode('ascii'), validate=True) if text else b''
        except Exception:
            raise BizError('文件内容解析失败，请重新选择文件')
        if not raw:
            raise BizError('文件内容为空，请重新选择文件')
        if len(raw) > IM_FILE_MAX_BYTES:
            raise BizError('附件不能超过 %d MB' % (IM_FILE_MAX_BYTES // (1024 * 1024)))
        return name, raw, self._ext_of(name)

    def _write_im_file(self, name, raw):
        """写到 <WEB_ROOT>/data/imfiles/<YYYYMM>/<UUID>.<ext>，返回相对静态根的路径"""
        ext = self._ext_of(name)
        folder = datetime.datetime.now().strftime('%Y%m')
        directory = os.path.join(IM_FILE_ROOT, folder)
        try:
            if not os.path.isdir(directory):
                os.makedirs(directory)
        except OSError:
            raise BizError('附件目录不可写，请联系管理员')
        filename = str(uuid.uuid4()) + ('.' + ext if ext else '')
        try:
            with open(os.path.join(directory, filename), 'wb') as fp:
                fp.write(raw)
        except OSError:
            raise BizError('附件写入失败，请联系管理员')
        return 'data/imfiles/%s/%s' % (folder, filename)

    def upload(self, params=None):
        """上传附件：base64 → 落盘 → empmsgfiles 一行，返回可直接发送的 fileId。

        :param kind: image / file（不给则按扩展名猜）
        :param width / height: 图片像素尺寸（浏览器侧量好后带上，用于气泡占位防抖）
        """
        params = params or {}
        me = self._my_emp_id(params)
        name, raw, ext = self._decode_im_file(params)
        kind = (self._text(params.get('kind')) or '').lower()
        if kind not in ('image', 'file'):
            kind = 'image' if ext in IM_IMAGE_EXTS else 'file'
        elif kind == 'image' and ext not in IM_IMAGE_EXTS:
            raise BizError('该文件不是图片，不能按图片发送')
        width = max(0, self._as_int(params.get('width')))
        height = max(0, self._as_int(params.get('height')))
        mime = self._text(params.get('mimeType')) or self.MIME_OF_EXT.get(ext, 'application/octet-stream')
        rel = self._write_im_file(name, raw)
        uid = str(uuid.uuid4())
        try:
            execute(
                'INSERT INTO `empmsgfiles` (`id`,`msgId`,`uploaderId`,`kind`,`fileName`,'
                '`filePath`,`fileSize`,`mimeType`,`ext`,`width`,`height`) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (uid, '', me, kind, name, rel, len(raw), mime[:120], ext, width, height))
        except Exception as exc:
            raise BizError('附件入库失败：%s' % exc)
        return {
            'fileId': uid, 'id': uid, 'kind': kind, 'name': name, 'fileName': name,
            'size': len(raw), 'fileSize': len(raw), 'ext': ext, 'mimeType': mime,
            'width': width, 'height': height, 'url': rel, 'filePath': rel,
            'uploaderId': me,
        }

    def _claim_attach(self, attach_id, emp_id):
        """校验「这个附件是我上传的」，并把附件行返回（防止盗用别人的 fileId）"""
        row = query_one('SELECT * FROM `empmsgfiles` WHERE `id`=%s LIMIT 1', (self._text(attach_id),))
        if not row:
            raise BizError('附件不存在，请重新上传')
        if int(row.get('uploaderId') or 0) != self._as_int(emp_id):
            raise BizError('该附件不是你上传的，不能发送', 403)
        return row

    def _attach_of(self, file_ids):
        """批量取附件元数据：{fileId: {fileId,name,size,mimeType,ext,kind,width,height,url}}"""
        out = {}
        ids = []
        for x in (file_ids or []):
            t = self._text(x)
            if t and t not in ids:
                ids.append(t)
        if not ids:
            return out
        try:
            holders = ','.join(['%s'] * len(ids))
            rows = query_all('SELECT * FROM `empmsgfiles` WHERE `id` IN (%s)' % holders, ids) or []
        except Exception:
            return out
        for r in rows:
            fid = self._text(r.get('id'))
            out[fid] = {
                'fileId': fid,
                'name': self._text(r.get('fileName')),
                'size': int(r.get('fileSize') or 0),
                'mimeType': self._text(r.get('mimeType')),
                'ext': self._text(r.get('ext')),
                'kind': self._text(r.get('kind')) or 'file',
                'width': int(r.get('width') or 0),
                'height': int(r.get('height') or 0),
                'url': self._text(r.get('filePath')),
                'sendTime': time_text(r.get('createTime')),
            }
        return out

    # ---------------- 表情包（图片表情，全站共享；登记的是已上传的附件） ----------------
    EMOJI_MAX = 120          # 表情包数量上限，防止无限上传把面板撑爆

    def emojis(self, params=None):
        """表情包列表：全站启用的一起返回（表情包是团队共享资产），mine 标记是否本人上传"""
        me = self._my_emp_id(params or {})
        try:
            rows = query_all('SELECT * FROM `empimemojis` WHERE `enabled`=1 '
                             'ORDER BY `sortNo` ASC, `createTime` ASC') or []
        except Exception:
            # 表还没建（老库）：返回空列表而不是报错，页面照常能用 emoji
            return {'me': me, 'list': [], 'total': 0}
        fmap = self._attach_of([r.get('fileId') for r in rows])
        out = []
        for r in rows:
            fid = self._text(r.get('fileId'))
            att = fmap.get(fid) or {}
            if not att.get('url'):
                continue          # 附件文件记录没了，跳过
            out.append({
                'id': self._text(r.get('id')),
                'fileId': fid,
                'name': self._text(r.get('name')) or att.get('name') or '表情',
                'url': att.get('url'),
                'width': att.get('width') or 0,
                'height': att.get('height') or 0,
                'uploaderId': int(r.get('empId') or 0),
                'uploaderName': self._text(r.get('empName')),
                'mine': int(r.get('empId') or 0) == me,
                'createTime': time_text(r.get('createTime')),
            })
        return {'me': me, 'list': out, 'total': len(out)}

    def emoji_add(self, params=None):
        """把一个已上传的图片（/api/msg/upload 返回的 fileId）登记成表情包"""
        params = params or {}
        me = self._my_emp_id(params)
        file_id = self._text(params.get('fileId'))
        if not file_id:
            raise BizError('请先上传表情图片')
        att = self._attach_of([file_id]).get(file_id)
        if not att:
            raise BizError('附件不存在，请重新上传')
        if not str(att.get('mimeType') or '').startswith('image/'):
            raise BizError('表情包只支持图片')
        try:
            cnt = int((query_one('SELECT COUNT(*) AS n FROM `empimemojis` WHERE `enabled`=1') or {}).get('n') or 0)
        except Exception:
            raise BizError('表情包表不存在，请先执行 db/emp-message-media.sql')
        if cnt >= self.EMOJI_MAX:
            raise BizError('表情包最多 %d 个' % self.EMOJI_MAX)
        if query_one('SELECT `id` FROM `empimemojis` WHERE `fileId`=%s', (file_id,)):
            raise BizError('这个表情包已经添加过了')
        eid = str(uuid.uuid4())
        name = self._text(params.get('name')) or att.get('name') or '表情'
        try:
            emp_name = (query_one('SELECT `nameCn` FROM `%s` WHERE `id`=%%s' % self.emp_table, (me,)) or {}).get('nameCn')
        except Exception:
            emp_name = ''
        execute('INSERT INTO `empimemojis` (`id`,`empId`,`empName`,`fileId`,`name`,`sortNo`) '
                'VALUES (%s,%s,%s,%s,%s,%s)',
                (eid, me, self._text(emp_name), file_id, name[:100], cnt))
        return {'id': eid, 'fileId': file_id, 'name': name[:100],
                'url': att.get('url'), 'mine': True, 'message': '表情包已添加'}

    def emoji_delete(self, params=None):
        """删除表情包：只能删自己上传的（表情包全站共享，不做管理员特权）"""
        params = params or {}
        me = self._my_emp_id(params)
        eid = self._uuid_of(params.get('id'))
        row = query_one('SELECT * FROM `empimemojis` WHERE `id`=%s', (eid,))
        if not row:
            raise BizError('表情包不存在', 404)
        if int(row.get('empId') or 0) != me:
            raise BizError('只能删除自己添加的表情包', 403)
        execute('DELETE FROM `empimemojis` WHERE `id`=%s', (eid,))
        return {'id': eid, 'deleted': True, 'message': '表情包已删除'}

    # =====================================================================
    # 群组：empimgroups（群）+ empimgroupmembers（成员，含最后阅读时间）
    #   · 群消息存 emp_msgs 一行（receiverId=0，groupId 归属），不做「每人一行」；
    #   · 群未读按成员 lastReadTime 与消息 sendTime 比较得到，天然支持多端一致；
    #   · 只有群主能改名 / 换成员 / 解散；成员可以自己退群。
    # =====================================================================
    GROUP_MAX_MEMBERS = 200

    def _group_row(self, group_id, me=None):
        gid = self._uuid_of(group_id)
        row = query_one('SELECT * FROM `empimgroups` WHERE `id`=%s LIMIT 1', (gid,))
        if not row or not int(row.get('enabled') or 0):
            raise BizError('群不存在或已解散', 404)
        if me is not None and not self._member_row(gid, me):
            raise BizError('你不是该群成员', 403)
        return row

    def _member_row(self, group_id, emp_id):
        try:
            return query_one(
                'SELECT * FROM `empimgroupmembers` WHERE `groupId`=%s AND `empId`=%s LIMIT 1',
                (self._text(group_id), self._as_int(emp_id)))
        except Exception:
            return None

    def _members_of(self, group_id):
        try:
            rows = query_all(
                'SELECT `empId`,`empName`,`role`,`joinTime`,`lastReadTime` '
                'FROM `empimgroupmembers` WHERE `groupId`=%s '
                "ORDER BY (`role`='owner') DESC, `joinTime` ASC", (self._text(group_id),)) or []
        except Exception:
            rows = []
        out = []
        for r in rows:
            eid = int(r['empId'])
            role = self._text(r.get('role')) or 'member'
            out.append({
                'empId': eid, 'name': self._text(r.get('empName')), 'role': role,
                'isOwner': role == 'owner', 'joinTime': time_text(r.get('joinTime')),
                'online': presence.is_online(eid),
            })
        return out

    def group_member_ids(self, group_id):
        """群成员 empId 列表（WS 推送用，不做权限判断）"""
        try:
            rows = query_all('SELECT `empId` FROM `empimgroupmembers` WHERE `groupId`=%s',
                             (self._text(group_id),)) or []
        except Exception:
            rows = []
        return [int(r['empId']) for r in rows]

    AT_MAX = 50

    def _at_ids_of(self, raw, group_id):
        """群聊 @ 组员：把前端传来的 atEmpIds 收敛成「确实还在这个群里」的 empId 逗号串

        前端传什么都不可信，而且被 @ 的人可能已经被移出群；这里以群成员表为准过滤，
        去重、保序、最多 50 个（避免一条消息挂一长串 @ 撑爆列宽）。
        """
        if raw is None:
            return ''
        if isinstance(raw, str) and not raw.strip():
            return ''
        items = raw if isinstance(raw, (list, tuple)) else re.split(r'[,\s]+', self._text(raw))
        members = set(self.group_member_ids(group_id))
        out, seen = [], set()
        for x in items:
            n = self._as_int(x)
            if not n or n in seen or n not in members:
                continue
            seen.add(n)
            out.append(n)
            if len(out) >= self.AT_MAX:
                break
        return ','.join(str(x) for x in out)

    def _touch_group_read(self, group_id, emp_id):
        """把某成员在该群的阅读游标推到当前最新一条（发消息 / 打开群聊 / 标记已读都调）

        用 emp_msgs.seq（全局自增）做游标而不是比较 sendTime：DATETIME 只有秒级精度，
        「刚读完」和「又来一条」落在同一秒时会把新消息误判成已读。seq 单调递增，判定精确。
        """
        gid = self._text(group_id)
        try:
            row = query_one('SELECT COALESCE(MAX(`seq`),0) AS s FROM `%s` WHERE `groupId`=%%s'
                            % self.table, (gid,)) or {}
        except Exception:
            row = {}
        try:
            execute('UPDATE `empimgroupmembers` SET `lastReadSeq`=%s, `lastReadTime`=%s '
                    'WHERE `groupId`=%s AND `empId`=%s',
                    (int(row.get('s') or 0),
                     datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                     gid, self._as_int(emp_id)))
        except Exception:
            pass

    def _group_unread(self, group_id, emp_id):
        """群未读 = 该群里「seq 大于我阅读游标」且「不是我发的」消息数"""
        me = self._as_int(emp_id)
        mrow = self._member_row(group_id, me) or {}
        cursor = int(mrow.get('lastReadSeq') or 0)
        sql = ('SELECT COUNT(*) AS n FROM `%s` WHERE `groupId`=%%s AND `senderId`<>%%s'
               % self.table)
        args = [self._text(group_id), me]
        if cursor:
            sql += ' AND `seq` > %s'
            args.append(cursor)
        try:
            row = query_one(sql, args)
        except Exception:
            return 0
        return int(row['n']) if row and row.get('n') is not None else 0

    def groups(self, params=None):
        """我加入的群：群名 / 群主 / 成员数 / 未读 / 最近一条消息（左侧「群组」列表与消息列表用）"""
        me = self._my_emp_id(params)
        try:
            mine = query_all(
                'SELECT `groupId`,`role`,`lastReadTime` FROM `empimgroupmembers` WHERE `empId`=%s',
                (me,)) or []
        except Exception:
            mine = []
        if not mine:
            return {'me': me, 'list': [], 'unread': 0}
        gids = [self._text(r.get('groupId')) for r in mine if self._text(r.get('groupId'))]
        if not gids:
            return {'me': me, 'list': [], 'unread': 0}
        holders = ','.join(['%s'] * len(gids))
        try:
            grows = query_all('SELECT * FROM `empimgroups` WHERE `id` IN (%s) AND `enabled`=1'
                              % holders, gids) or []
        except Exception:
            grows = []
        gmap = dict((self._text(r.get('id')), r) for r in grows)
        counts, lastmap = {}, {}
        try:
            crows = query_all('SELECT `groupId`, COUNT(*) AS n FROM `empimgroupmembers` '
                              'WHERE `groupId` IN (%s) GROUP BY `groupId`' % holders, gids) or []
            counts = dict((self._text(r.get('groupId')), int(r.get('n') or 0)) for r in crows)
        except Exception:
            counts = {}
        try:
            mrows = query_all(
                'SELECT `groupId`,`content`,`senderId`,`senderName`,`sendTime`,`msgType` '
                'FROM `%s` WHERE `groupId` IN (%s) '
                'ORDER BY `sendTime` DESC, `createTime` DESC LIMIT 2000' % (self.table, holders),
                gids) or []
        except Exception:
            mrows = []
        for r in mrows:
            gid = self._text(r.get('groupId'))
            if gid and gid not in lastmap:
                lastmap[gid] = r
        rolemap = dict((self._text(r.get('groupId')), self._text(r.get('role')) or 'member')
                       for r in mine)
        out, total = [], 0
        for gid in gids:
            g = gmap.get(gid)
            if not g:
                continue          # 群已解散：members 行留着，但列表里不再出现
            unread = self._group_unread(gid, me)
            total += unread
            lm = lastmap.get(gid) or {}
            out.append({
                'groupId': gid,
                'isGroup': True,
                'name': self._text(g.get('groupName')),
                'groupName': self._text(g.get('groupName')),
                'ownerId': int(g.get('ownerId') or 0),
                'ownerName': self._text(g.get('ownerName')),
                'avatarText': self._text(g.get('avatarText')) or self._text(g.get('groupName'))[:1],
                'role': rolemap.get(gid, 'member'),
                'isOwner': rolemap.get(gid) == 'owner',
                'memberCount': counts.get(gid, 0),
                'unread': unread,
                'lastContent': self._text(lm.get('content'))[:120],
                'lastTime': time_text(lm.get('sendTime')),
                'lastSenderId': int(lm.get('senderId') or 0),
                'lastSenderName': self._text(lm.get('senderName')),
                'lastFromMe': int(lm.get('senderId') or 0) == me,
            })
        out.sort(key=lambda it: it['lastTime'], reverse=True)
        out.sort(key=lambda it: (1 if not it['lastTime'] else 0))
        return {'me': me, 'list': out, 'unread': total}

    def group_add(self, params=None):
        """建群：群名（可空，自动按成员名拼）+ 成员 empId 列表；群主自动入群"""
        params = params or {}
        me = self._my_emp_id(params)
        raw = params.get('memberIds')
        if raw is None:
            raw = params.get('empIds')
        if raw is None:
            raw = params.get('members')
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            raise BizError('请至少选择一位群成员')
        items = raw if isinstance(raw, (list, tuple)) else re.split(r'[,\s]+', self._text(raw))
        ids, seen = [], set()
        for x in items:
            n = self._as_int(x)
            if n and n != me and n not in seen:
                seen.add(n)
                ids.append(n)
        if not ids:
            raise BizError('请至少选择一位群成员（不能只有自己）')
        if len(ids) + 1 > self.GROUP_MAX_MEMBERS:
            raise BizError('群成员不能超过 %d 人' % self.GROUP_MAX_MEMBERS)
        names = self._emp_names(ids)
        missing = [x for x in ids if x not in names]
        if missing:
            raise BizError('部分成员不存在（empId=%s），请重新选择'
                           % ','.join(str(x) for x in missing))
        me_name = self._emp_name(me) or ('员工' + str(me))
        name = self._text(params.get('groupName'))[:100]
        if not name:
            name = '、'.join([me_name] + [names[i] for i in ids[:2]])[:100]
        now_text = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        gid = str(uuid.uuid4())
        try:
            execute('INSERT INTO `empimgroups` (`id`,`groupName`,`ownerId`,`ownerName`,`avatarText`) '
                    'VALUES (%s,%s,%s,%s,%s)',
                    (gid, name, me, me_name, name[:1]))
            execute('INSERT INTO `empimgroupmembers` (`groupId`,`empId`,`empName`,`role`,`lastReadTime`) '
                    "VALUES (%s,%s,%s,'owner',%s)", (gid, me, me_name, now_text))
            for eid in ids:
                execute('INSERT INTO `empimgroupmembers` (`groupId`,`empId`,`empName`,`role`,`lastReadTime`) '
                        "VALUES (%s,%s,%s,'member',%s)", (gid, eid, names[eid], now_text))
        except Exception as exc:
            raise BizError('建群失败：%s' % exc)
        out = {'groupId': gid, 'name': name, 'memberCount': len(ids) + 1,
               'ownerId': me, 'message': '群「%s」创建成功' % name}
        out['group'] = self._group_view(gid, me)
        return out

    def _group_view(self, gid, me):
        g = self._group_row(gid, me)
        members = self._members_of(gid)
        return {
            'groupId': self._text(g.get('id')),
            'isGroup': True,
            'name': self._text(g.get('groupName')),
            'groupName': self._text(g.get('groupName')),
            'ownerId': int(g.get('ownerId') or 0),
            'ownerName': self._text(g.get('ownerName')),
            'avatarText': self._text(g.get('avatarText')) or self._text(g.get('groupName'))[:1],
            'memberCount': len(members),
            'isOwner': int(g.get('ownerId') or 0) == self._as_int(me),
            'members': members,
            'unread': self._group_unread(gid, me),
        }

    def group_detail(self, params=None):
        """群资料 + 成员列表（成员可见；非成员一律 403）"""
        params = params or {}
        me = self._my_emp_id(params)
        gid = self._uuid_of(params.get('groupId'))
        out = self._group_view(gid, me)
        out['me'] = me
        return out

    def group_update(self, params=None):
        """改群名 / 全量替换成员（仅群主）；群主自己永远保留"""
        params = params or {}
        me = self._my_emp_id(params)
        gid = self._uuid_of(params.get('groupId'))
        group = self._group_row(gid, me)
        if int(group.get('ownerId') or 0) != me:
            raise BizError('只有群主可以修改群资料', 403)
        name = self._text(params.get('groupName'))[:100]
        if name:
            execute('UPDATE `empimgroups` SET `groupName`=%s, `avatarText`=%s WHERE `id`=%s',
                    (name, name[:1], gid))
        if 'memberIds' in params:
            raw = params.get('memberIds') or []
            items = raw if isinstance(raw, (list, tuple)) else re.split(r'[,\s]+', self._text(raw))
            ids, seen = [], set()
            for x in items:
                n = self._as_int(x)
                if n and n != me and n not in seen:
                    seen.add(n)
                    ids.append(n)
            if not ids:
                raise BizError('群里至少要留一位成员（除群主外）')
            if len(ids) + 1 > self.GROUP_MAX_MEMBERS:
                raise BizError('群成员不能超过 %d 人' % self.GROUP_MAX_MEMBERS)
            names = self._emp_names(ids)
            missing = [x for x in ids if x not in names]
            if missing:
                raise BizError('部分成员不存在（empId=%s），请重新选择'
                               % ','.join(str(x) for x in missing))
            holders = ','.join(['%s'] * len(ids))
            execute('DELETE FROM `empimgroupmembers` WHERE `groupId`=%%s '
                    "AND `role`<>'owner' AND `empId` NOT IN (%s)" % holders, [gid] + ids)
            keep = set(self.group_member_ids(gid))
            now_text = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            # 新入群的成员不该看到入群前的历史算作未读 → 游标直接对齐当前最新一条
            try:
                cursor = int((query_one('SELECT COALESCE(MAX(`seq`),0) AS s FROM `%s` WHERE `groupId`=%%s'
                                        % self.table, (gid,)) or {}).get('s') or 0)
            except Exception:
                cursor = 0
            for eid in ids:
                if eid in keep:
                    continue
                execute('INSERT INTO `empimgroupmembers` (`groupId`,`empId`,`empName`,`role`,'
                        '`lastReadSeq`,`lastReadTime`) VALUES (%s,%s,%s,\'member\',%s,%s)',
                        (gid, eid, names[eid], cursor, now_text))
        out = {'groupId': gid, 'message': '群资料已更新'}
        out['group'] = self._group_view(gid, me)
        return out

    def group_delete(self, params=None):
        """群主 → 解散（enabled=0，历史消息保留）；成员 → 退出群聊（删自己的成员行）"""
        params = params or {}
        me = self._my_emp_id(params)
        gid = self._uuid_of(params.get('groupId'))
        group = self._group_row(gid, me)
        if int(group.get('ownerId') or 0) == me:
            execute('UPDATE `empimgroups` SET `enabled`=0 WHERE `id`=%s', (gid,))
            return {'groupId': gid, 'dissolved': True, 'left': False,
                    'message': '群「%s」已解散' % self._text(group.get('groupName'))}
        execute('DELETE FROM `empimgroupmembers` WHERE `groupId`=%s AND `empId`=%s', (gid, me))
        return {'groupId': gid, 'dissolved': False, 'left': True, 'message': '已退出群聊'}

    def group_history(self, params=None):
        """群消息历史（按时间正序，最多 200 条）；打开即把本人 lastReadTime 推到现在"""
        params = params or {}
        me = self._my_emp_id(params)
        gid = self._uuid_of(params.get('groupId'))
        group = self._group_row(gid, me)
        try:
            rows = query_all(
                'SELECT * FROM `%s` WHERE `groupId`=%%s ORDER BY `sendTime` ASC, `createTime` ASC '
                'LIMIT 200' % self.table, (gid,)) or []
        except Exception:
            rows = []
        fmap = self._attach_of([r.get('attachId') for r in rows])
        list_out = []
        for r in rows:
            it = dump_row(r)
            it['msgType'] = self._text(it.get('msgType')) or 'text'
            it['attachId'] = self._text(it.get('attachId'))
            it['contentHtml'] = self._text(it.get('contentHtml'))
            it['atEmpIds'] = self._text(it.get('atEmpIds'))
            it['attach'] = fmap.get(it['attachId']) or None
            it['isInbox'] = int(it.get('senderId') or 0) != me
            it['readStatus'] = 1
            it['content'] = it.get('content') or ''
            it['sendTime'] = it.get('sendTime') or ''
            it['isMe'] = int(it.get('senderId') or 0) == me
            list_out.append(it)
        self._touch_group_read(gid, me)
        view = self._group_view(gid, me)
        view['unread'] = 0
        return {'me': me, 'group': view, 'list': list_out,
                'groupName': self._text(group.get('groupName'))}

    def mark_group(self, params=None):
        """把某个群标记为已读（REST 兜底 / 多端同步）"""
        params = params or {}
        me = self._my_emp_id(params)
        gid = self._uuid_of(params.get('groupId'))
        self._group_row(gid, me)
        self._touch_group_read(gid, me)
        return {'groupId': gid, 'updated': 1, 'unread': self._group_unread(gid, me)}

    # ---------------- 工具：UUID 校验 ----------------
    def _uuid_of(self, value):
        text = self._text(value).lower()
        if not text:
            raise BizError('参数 id 不能为空（应为 UUID）')
        if not RE_UUID.match(text):
            raise BizError('参数 id 不合法（应为 UUID）')
        return text

    def _ids_of(self, params, name='消息'):
        params = params or {}
        raw = params.get('ids')
        if raw is None or (isinstance(raw, str) and not self._text(raw)):
            raw = params.get('id')
        if raw is None:
            raise BizError('请先选择' + name)
        items = raw if isinstance(raw, (list, tuple)) else re.split(r'[,\s]+', self._text(raw))
        ids = [self._uuid_of(x) for x in items if self._text(x)]
        if not ids:
            raise BizError('请先选择' + name)
        return ids


emp_message_service = EmpMessageService()


class DbInfoMgrService(object):
    """
    数据中心 · 数据库连接对象（dbinfomgr，UUID 主键）
      · 1.1 连接信息维护：连接名称 / 类型 / 主机 / 端口 / 默认库（SQLite 填文件路径）/ 账号 / 密码 /
        字符集 / 附加参数 / 启用否 / 备注；**允许同时启用多条**（enabled 只表示这条连接可用）；
      · 1.2 结构扫描（只读）：scan 扫实例（库）→ tables 扫表与视图 → columns 扫字段，
        全部只用目标库的系统元数据，不改任何数据（实现见 server/connector.py）；
      · 密码用 connector.encrypt_secret 加密存储，接口只回掩码（hasPassword / passwordMask），编辑时留空表示不改；
      · 扫描 / 测试失败会把原因写进 lastError（页面状态列可直接看到），成功则刷新 lastScanTime。
    对外接口：list(page) / detail / check / add / update / delete / enabled / test / types / scan / tables / columns
    """

    table = 'dbinfomgr'
    label = '数据库'

    ORDER_BY = '`enabled` DESC, `name` ASC'

    # 当前登录人 → 员工ID（useinfo.empId）
    LOGIN_EMP_SQL = 'SELECT `empId` AS `empId` FROM `useinfo` WHERE `id`=%s LIMIT 1'

    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _uuid_of(value):
        text = DbInfoMgrService._text(value).lower()
        if not text:
            raise BizError('参数 id 不能为空（应为 UUID）')
        if not RE_UUID.match(text):
            raise BizError('参数 id 不合法（应为 UUID）')
        return text

    @staticmethod
    def _bool_of(value, default=False):
        if value is None:
            return default
        return str(value).strip().lower() in ('1', 'true', 'yes', 'on')

    def _find(self, uid):
        row = query_one('SELECT * FROM `%s` WHERE `id`=%%s' % self.table, (uid,))
        if not row:
            raise BizError(self.label + '不存在或已被删除', 404)
        return row

    # ---------------- 展示字段 ----------------
    def _attach(self, items):
        for it in items:
            pwd = connector.decrypt_secret(it.get('password'))
            it['hasPassword'] = bool(pwd)
            it['passwordMask'] = '******' if pwd else ''
            it.pop('password', None)                     # 密码永不外泄
            it['enabled'] = bool(int(it.get('enabled') or 0))
            it['dbType'] = str(it.get('dbType') or 'mysql').lower()
            it['typeLabel'] = connector.type_label(it['dbType'])
            it['hasFile'] = connector.is_file_type(it['dbType'])
            port = it.get('port')
            if not port and not it['hasFile']:
                port = connector.default_port(it['dbType'])
            it['port'] = port or None
            it['portText'] = '' if it['hasFile'] else str(port or '')
            if it['hasFile']:
                it['serverText'] = str(it.get('dbName') or '')
            else:
                it['serverText'] = '%s:%s' % (it.get('host') or '', port or '')
            it['lastScanTime'] = it.get('lastScanTime') or ''
            it['lastError'] = it.get('lastError') or ''
            # 公用否：1-公用（默认）/ 0-私有；员工ID 没记录时给 0，前端不用区分 null
            it['ispub'] = bool(int(it.get('ispub') if it.get('ispub') is not None else 1))
            it['ispubText'] = '公用' if it['ispub'] else '私有'
            it['createempinfosid'] = int(it.get('createempinfosid') or 0)
        return items

    def _login_emp_id(self, params):
        """
        当前登录人的员工ID（写进 dbinfomgr.createempinfosid）
          · 按 token 反查（require_login 已把 _loginUserId 放进参数）→ useinfo.empId；
          · 没有登录上下文（内部调用 / 迁移脚本）时，才用调用方自己传的 createempinfosid；
          · 账号没绑员工 → None（字段可空，不影响保存）。
        """
        params = params or {}
        user_id = self._text(params.get('_loginUserId'))
        if user_id:
            try:
                row = query_one(self.LOGIN_EMP_SQL, (user_id,))
            except Exception:            # 查不到人也不能影响保存
                row = None
            if row and row.get('empId'):
                return int(row['empId'])
        try:
            emp_id = int(str(params.get('createempinfosid') or '').strip())
        except (TypeError, ValueError):
            return None
        return emp_id or None

    def _conf_of(self, row):
        """库里的行 → 扫描用配置（含解密后的密码，只在内存里用）"""
        return {
            'id': row.get('id'), 'name': row.get('name'), 'dbType': row.get('dbType'),
            'host': row.get('host'), 'port': row.get('port'), 'dbName': row.get('dbName'),
            'username': row.get('username'), 'password': connector.decrypt_secret(row.get('password')),
            'charset': row.get('charset'), 'extraParams': row.get('extraParams'),
        }

    # ---------------- 查询 ----------------
    def _visibility_where(self, params):
        """
        连接对象可见性（2026-11-06 用户需求）：列表只加载
        「本用户创建的」+「其他用户标为公用（ispub=1）的」连接对象。
          · 按当前登录人 token 反查 empId；能拿到 empId 才过滤；
          · 拿不到登录上下文（内部调用 / 迁移脚本）时不过滤，保持旧行为。
        """
        emp_id = self._login_emp_id(params)
        if not emp_id:
            return '', []
        return ' (`createempinfosid`=%s OR `ispub`=1)', [emp_id]

    def _build_where(self, params):
        where, args = [], []
        vis_sql, vis_args = self._visibility_where(params)
        if vis_sql:
            where.append(vis_sql)
            args.extend(vis_args)
        keyword = self._text((params or {}).get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            where.append('(`name` LIKE %s OR `host` LIKE %s OR `dbName` LIKE %s '
                         'OR `username` LIKE %s OR `remark` LIKE %s)')
            args.extend([like, like, like, like, like])
        db_type = self._text((params or {}).get('dbType'))
        if db_type:
            where.append('`dbType`=%s')
            args.append(db_type.lower())
        enabled = (params or {}).get('enabled')
        if enabled is not None and str(enabled).strip() != '':
            where.append('`enabled`=%s')
            args.append(1 if self._bool_of(enabled) else 0)
        return (' WHERE ' + ' AND '.join(where)) if where else '', args

    def page(self, params):
        params = params or {}
        where, args = self._build_where(params)
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 10), 1), 200)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        row = query_one('SELECT COUNT(*) AS n FROM `%s`%s' % (self.table, where), args)
        total = int(row['n']) if row and row.get('n') is not None else 0
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        rows = query_all('SELECT * FROM `%s`%s ORDER BY %s LIMIT %%s OFFSET %%s'
                         % (self.table, where, self.ORDER_BY),
                         args + [page_size, (page_num - 1) * page_size])
        # 类型筛选计数与列表同口径（可见性过滤后统计，避免下拉里出现「0 条」的类型）
        types = query_all('SELECT `dbType`, COUNT(*) AS n FROM `%s`%s GROUP BY `dbType`'
                          % (self.table, where), args)
        return {'list': self._attach([dump_row(r) for r in rows]), 'total': total,
                'pageNum': page_num, 'pageSize': page_size, 'pages': pages,
                'types': [{'value': connector.type_label(r['dbType']), 'count': int(r['n'] or 0),
                           'dbType': r['dbType']} for r in (types or [])]}

    def detail(self, params):
        uid = self._uuid_of((params or {}).get('id'))
        return self._attach([dump_row(self._find(uid))])[0]

    def check(self, params):
        """唯一性校验：连接名称唯一"""
        field = self._text((params or {}).get('field')) or 'name'
        if field != 'name':
            raise BizError('不支持的唯一性校验字段：' + field)
        value = self._text((params or {}).get('value'))
        if not value:
            return {'unique': True}
        self_id = self._text((params or {}).get('id'))
        row = query_one('SELECT `id` FROM `%s` WHERE `name`=%%s AND `id`<>%%s LIMIT 1' % self.table,
                        (value, self_id))
        return {'unique': row is None}

    def types(self, params=None):
        """数据库类型下拉（含默认端口 / 是否文件型），供前端表单联动"""
        return {'list': connector.type_options()}

    # ---------------- 写入 ----------------
    def _normalize(self, data, current=None):
        data = data or {}
        current = current or {}
        name = self._text(data.get('name')) or self._text(current.get('name'))
        if not name:
            raise BizError('连接名称不能为空')
        if len(name) > 100:
            raise BizError('连接名称最多 100 个字符')
        db_type = (self._text(data.get('dbType')) or self._text(current.get('dbType'))
                   or 'mysql').lower()
        if not connector.is_known_type(db_type):
            raise BizError('不支持的数据库类型：' + db_type)
        has_file = connector.is_file_type(db_type)
        db_name = self._text(data.get('dbName')) or self._text(current.get('dbName'))
        if has_file:
            if not db_name:
                raise BizError('SQLite 请填写库文件路径（默认库 / 文件路径）')
            host = self._text(data.get('host'))
            port = None
        else:
            host = self._text(data.get('host'))
            if not host:
                raise BizError('主机地址不能为空')
            raw_port = data.get('port')
            if raw_port is None or str(raw_port).strip() == '':
                port = connector.default_port(db_type)
            else:
                try:
                    port = int(str(raw_port).strip())
                except (TypeError, ValueError):
                    raise BizError('端口必须是数字')
                if port < 1 or port > 65535:
                    raise BizError('端口范围应为 1-65535')
            # Oracle 必须知道连哪个库：服务名（Service Name）或 SID，否则连不上
            if db_type == 'oracle' and not db_name:
                raise BizError('Oracle 请填写「数据库名」：服务名（Service Name，如 ORCLPDB1）'
                               '或 SID（如 ORCL）')
        picked = {
            'name': name,
            'dbType': db_type,
            'host': None if has_file else host[:120],
            'port': port,
            'dbName': db_name[:120] or None,
            'username': self._text(data.get('username'))[:100] or None,
            'charset': self._text(data.get('charset'))[:40] or None,
            'extraParams': self._text(data.get('extraParams'))[:500] or None,
            'remark': self._text(data.get('remark'))[:200] or None,
        }
        if 'enabled' in data:
            picked['enabled'] = 1 if self._bool_of(data.get('enabled')) else 0
        if 'ispub' in data:                    # 请求里带了才改（局部更新不会把「私有」冲回「公用」）
            picked['ispub'] = 1 if self._bool_of(data.get('ispub'), True) else 0
        return picked

    def _assert_name_unique(self, name, self_id=''):
        row = query_one('SELECT `id` FROM `%s` WHERE `name`=%%s AND `id`<>%%s LIMIT 1' % self.table,
                        (name, self_id))
        if row:
            raise BizError('连接名称【%s】已存在，请换一个' % name)

    def add(self, data):
        data = data or {}
        picked = self._normalize(data)
        password = self._text(data.get('password'))
        if not password and not connector.is_file_type(picked['dbType']):
            raise BizError('请填写数据库密码（无密码的账号可填任意占位，如 none）')
        self._assert_name_unique(picked['name'])
        picked['id'] = str(uuid.uuid4())
        picked['password'] = connector.encrypt_secret(password) if password else None
        picked.setdefault('enabled', 1)
        picked.setdefault('ispub', 1)                       # 不传就是公用
        picked['createempinfosid'] = self._login_emp_id(data)   # 创建人 = 当前登录员工（页面不展示）
        columns = ','.join('`%s`' % c for c in picked.keys())
        holders = ','.join(['%s'] * len(picked))
        try:
            execute('INSERT INTO `%s` (%s) VALUES (%s)' % (self.table, columns, holders),
                    list(picked.values()))
        except DuplicateError:
            raise BizError('连接名称【%s】已存在，请换一个' % picked['name'])
        return self._attach([dump_row(self._find(picked['id']))])[0]

    def update(self, data):
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        current = self._find(uid)
        picked = self._normalize(data, current)
        self._assert_name_unique(picked['name'], uid)
        password = self._text(data.get('password'))
        if password:
            picked['password'] = connector.encrypt_secret(password)     # 留空 = 不修改
        picked['lastError'] = None                                      # 改了连接信息，旧错误作废
        assignments = ','.join('`%s`=%%s' % c for c in picked.keys())
        try:
            execute('UPDATE `%s` SET %s WHERE `id`=%%s' % (self.table, assignments),
                    list(picked.values()) + [uid])
        except DuplicateError:
            raise BizError('连接名称【%s】已存在，请换一个' % picked['name'])
        return self._attach([dump_row(self._find(uid))])[0]

    def delete(self, params):
        uid = self._uuid_of((params or {}).get('id'))
        row = self._find(uid)
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.table, (uid,))
        return self._attach([dump_row(row)])[0]

    def enabled(self, params):
        """启用 / 停用（允许多条同时启用，只影响这条记录本身）"""
        params = params or {}
        uid = self._uuid_of(params.get('id'))
        row = self._find(uid)
        on = 1 if self._bool_of(params.get('enabled', 1), True) else 0
        execute('UPDATE `%s` SET `enabled`=%%s WHERE `id`=%%s' % self.table, (on, uid))
        item = self._attach([dump_row(self._find(uid))])[0]
        item['message'] = ('连接「%s」已启用' % row['name']) if on else ('连接「%s」已停用' % row['name'])
        return item

    # ---------------- 扫描（只读元数据） ----------------
    def _mark(self, uid, ok, message=''):
        """扫描结果落到 lastScanTime / lastError，页面状态列直接可见"""
        now_text = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        try:
            if ok:
                execute('UPDATE `%s` SET `lastScanTime`=%%s, `lastError`=NULL WHERE `id`=%%s'
                        % self.table, (now_text, uid))
            else:
                execute('UPDATE `%s` SET `lastError`=%%s WHERE `id`=%%s' % self.table,
                        ((message or '扫描失败')[:500], uid))
        except Exception:
            pass

    def _scan_of(self, uid, action, **kwargs):
        row = self._find(uid)
        conf = self._conf_of(row)
        try:
            result = action(conf, **kwargs)
        except connector.ConnError as exc:
            self._mark(uid, False, exc.message)
            raise BizError(exc.message)
        except Exception as exc:                    # 驱动内部异常也要落到 lastError
            message = '扫描失败：%s' % (str(exc) or exc.__class__.__name__)
            self._mark(uid, False, message)
            raise BizError(message)
        self._mark(uid, True)
        result['connection'] = {'id': row.get('id'), 'name': row.get('name'),
                                'dbType': row.get('dbType'),
                                'typeLabel': connector.type_label(row.get('dbType'))}
        return result

    def test(self, params):
        """测试连接：能列出实例即视为连通（同时刷新 lastScanTime / lastError）"""
        uid = self._uuid_of((params or {}).get('id'))
        result = self._scan_of(uid, lambda conf: connector.test(conf))
        item = self._attach([dump_row(self._find(uid))])[0]
        item['ok'] = True
        item['message'] = '连接成功：%s，可扫描到 %d 个实例（%d ms）' % (
            result.get('server') or '', int(result.get('databases') or 0),
            int(result.get('elapsed') or 0))
        return item

    def scan(self, params):
        """1.2 扫描实例（库）列表；同时刷新 lastScanTime"""
        uid = self._uuid_of((params or {}).get('id'))
        result = self._scan_of(uid, lambda conf: connector.databases(conf))
        result['scannedAt'] = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        return result

    def tables(self, params):
        """扫描某实例下的表与视图"""
        params = params or {}
        uid = self._uuid_of(params.get('id'))
        database = self._text(params.get('database'))
        result = self._scan_of(uid, lambda conf: connector.tables(conf, database))
        result['database'] = database
        return result

    def columns(self, params):
        """扫描某张表 / 视图的字段"""
        params = params or {}
        uid = self._uuid_of(params.get('id'))
        database = self._text(params.get('database'))
        table = self._text(params.get('table'))
        result = self._scan_of(uid, lambda conf: connector.columns(conf, database, table))
        result['database'] = database
        result['table'] = table
        return result

    # ---------------- SQL 工作台（只读执行） ----------------
    def sqlrun(self, params):
        """
        右区域「SQL 工作台」：在选中的连接上执行**一条查询语句**，返回字段与结果行
          · 只读：只放行 SELECT / SHOW / DESC / EXPLAIN / PRAGMA / WITH，且语句里不允许出现写关键字；
            执行完一律 rollback，绝不 commit（规则见 connector._check_sql 的注释）；
          · 结果行数受 config.DBINFO_SQL_MAX_ROWS（默认 200）限制，超出截断并回传 truncated；
          · SQL 写错 / 语法错只影响这一次执行，**不会**写 lastError（那是连接与结构扫描的状态）。
        :param params {id, database, sql, maxRows}
        :return {statement, columns, rows, rowCount, truncated, elapsed, database, connection, executedAt, message}
        """
        params = params or {}
        uid = self._uuid_of(params.get('id'))
        row = self._find(uid)
        raw = params.get('sql')
        if isinstance(raw, (list, tuple)):
            raw = '\n'.join([self._text(one) for one in raw])
        sql = '' if raw is None else str(raw)
        if not sql.strip():
            raise BizError('请输入要执行的 SQL')
        if len(sql) > 20000:
            raise BizError('SQL 太长（%d 字符），请精简到 20000 字符以内' % len(sql))
        database = self._text(params.get('database'))
        try:
            max_rows = int(params.get('maxRows') or config.DBINFO_SQL_MAX_ROWS)
        except (TypeError, ValueError):
            max_rows = config.DBINFO_SQL_MAX_ROWS
        max_rows = min(max(max_rows, 1), 2000)
        conf = self._conf_of(row)
        try:
            result = connector.query(conf, database, sql, max_rows)
        except connector.ConnError as exc:
            raise BizError(exc.message)
        result['connection'] = {'id': row.get('id'), 'name': row.get('name'),
                                'dbType': row.get('dbType'),
                                'typeLabel': connector.type_label(row.get('dbType'))}
        if not result.get('database'):
            result['database'] = database or (row.get('dbName') or '')
        return result

    # ---------------- 数据浏览（表 / 视图数据，只读分页） ----------------
    def rows(self, params):
        """
        右区域「数据」标签页：读某张表 / 视图的一页数据（懒加载）
          · 只读：拼的是 SELECT，标识符走白名单 + 方言引号，值全部占位符绑定，取完 rollback；
          · 支持 orderBy / orderDir 排序，filters=[{column, op, value}] 过滤（op 见 connector.ROW_OPS）；
          · 每次最多 500 行（默认 100），前端滚动到底再请求下一页，避免一次性拉整表。
        :param params {id, database, table, pageNum, pageSize, orderBy, orderDir, filters}
        :return {columns, rows, total, pageNum, pageSize, pages, hasMore, orderBy, orderDir, filters, elapsed, connection}
        """
        params = params or {}
        uid = self._uuid_of(params.get('id'))
        row = self._find(uid)
        database = self._text(params.get('database'))
        table = self._text(params.get('table'))
        if not table:
            raise BizError('请先在左侧点选（或双击）一张表 / 视图')
        try:
            page_num = int(params.get('pageNum') or 1)
        except (TypeError, ValueError):
            page_num = 1
        try:
            page_size = int(params.get('pageSize') or 100)
        except (TypeError, ValueError):
            page_size = 100
        page_num = max(1, page_num)
        page_size = min(max(page_size, 1), 500)
        order_by = self._text(params.get('orderBy'))
        order_dir = self._text(params.get('orderDir')).lower()
        if order_dir not in ('asc', 'desc'):
            order_dir = 'asc' if order_by else ''
        filters = params.get('filters')
        conf = self._conf_of(row)
        try:
            result = connector.rows(conf, database, table, page_num, page_size,
                                    order_by, order_dir, filters)
        except connector.ConnError as exc:
            raise BizError(exc.message)
        result['connection'] = {'id': row.get('id'), 'name': row.get('name'),
                                'dbType': row.get('dbType'),
                                'typeLabel': connector.type_label(row.get('dbType'))}
        return result


db_info_service = DbInfoMgrService()


# =====================================================================
# 数据中心 · 报表设计器（报表信息表 reportinfos）
# =====================================================================
class ReportDesignerService(object):
    """
    数据中心 · 报表设计（reportinfos，UUID 主键）
      · 设计：左侧数据源按「连接 → 实例 → 表 / 视图 → 字段」展开，字段可以拖进画布；
        画布内容（列定义）与报表参数、页面模板一起序列化成 JSON 随报表落库；
      · 预览：没保存也能预览（把画布内容直接提交过来），也可以传 id 用已保存的报表预览；
      · 调用：run 按 id 或 code 执行报表，累加 runCount / 刷新 lastRunTime，供其它页面后续调用；
      · 只读：预览与调用都走 connector.query（只放行查询语句，取完一律 rollback，绝不改目标库）；
      · SQL 里允许 :参数名 占位（参数定义在 paramsJson），也可不写 SQL —— 只要把表拖进来，
        后端会按「主表 + 列定义」自动拼 SELECT。
    对外接口：list(page) / detail / check / categories / connections / databases / tables / columns /
              add / update / delete / enabled / copy / preview / run
    """

    # 当前登录人：useinfo.empId（员工ID）+ empinfos.nameCn（姓名），取不到姓名再退回账号
    LOGIN_NAME_SQL = ('SELECT u.`account`, u.`empId` AS `empId`, e.`nameCn` AS `empName` '
                      'FROM `useinfo` u LEFT JOIN `empinfos` e ON e.`id` = u.`empId` '
                      'WHERE u.`id`=%s LIMIT 1')

    table = 'reportinfos'
    label = '报表'
    # 启用优先：报表清单里停用的一律排到下部（同组内仍按更新时间倒序、编码升序）。
    # 报表中心只查启用，这条排序对它没有影响。
    ORDER_BY = '`enabled` DESC, `updateTime` DESC, `code` ASC'

    # 画布 / 参数 / 模板的结构约束（前端 js/report-designer.js 里有同一套限制）
    PARAM_TYPES = ('string', 'int', 'number', 'date', 'datetime', 'bool')
    PARAM_CONTROLS = ('text', 'number', 'date', 'select', 'multiselect', 'checkbox')
    COLUMN_FORMATS = ('text', 'int', 'number', 'money', 'percent', 'date', 'datetime')
    COLUMN_ALIGNS = ('left', 'center', 'right')
    COLUMN_SUMMARY = ('none', 'sum', 'avg', 'count', 'max', 'min')
    PAPERS = ('A4', 'A5', 'A3', 'Letter', 'Custom')
    # 工具箱里的组件（设计区自由布局）：文本 / 线条 / 区域 / 图像 / 图表 / 表格
    ELEMENT_KINDS = ('label', 'line', 'box', 'image', 'chart', 'table')
    MAX_ELEMENTS = 60
    MAX_ELEMENT_DEPTH = 2                  # 区域最多再套一层区域
    TABLE_MAX_ROWS = 30                    # 表格组件的行 / 列上限（前端 js/report-designer.js 同一套）
    TABLE_MAX_COLS = 10

    DEFAULT_DESIGN = {
        'title': '', 'subtitle': '', 'headerText': '', 'footerText': '',
        'headerAlign': 'left', 'footerAlign': 'center',      # 页眉 / 页脚文字的水平对齐
        'showTitle': True, 'showParams': True, 'zebra': True, 'bordered': True,
        'showSummary': True, 'groupBy': '',
        'showRowNo': False,       # 数据表最左侧显示行号（序号列）：预览窗里右键表格可切换
        'elements': [],           # 设计区组件（工具箱：文本 / 线条 / 区域 / 图像 / 图表 / 表格）
    }
    DEFAULT_TEMPLATE = {
        'paper': 'A4', 'orientation': 'portrait',
        'marginTop': 12, 'marginRight': 10, 'marginBottom': 12, 'marginLeft': 10,
        'fontFamily': 'Microsoft YaHei', 'fontSize': 12,
        'titleSize': 18, 'titleAlign': 'center', 'titleBold': True,
        'compact': False, 'showPageNo': True, 'showTime': True, 'watermark': '',
        # 页眉 / 页脚 logo（地址可为 http(s) / 站内相对路径 / data:image；位置只有贴左或贴右）
        'headerLogo': '', 'headerLogoHeight': 32, 'headerLogoPos': 'left',
        'footerLogo': '', 'footerLogoHeight': 28, 'footerLogoPos': 'left',
    }

    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _bool_of(value, default=False):
        if value is None or value == '':
            return default
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ('1', 'true', 'yes', 'on')

    @staticmethod
    def _int_of(value, default, low=None, high=None):
        try:
            num = int(float(str(value).strip()))
        except (TypeError, ValueError):
            num = default
        if low is not None and num < low:
            num = low
        if high is not None and num > high:
            num = high
        return num

    @staticmethod
    def _uuid_of(value):
        text = ReportDesignerService._text(value).lower()
        if not text:
            raise BizError('参数 id 不能为空（应为 UUID）')
        if not RE_UUID.match(text):
            raise BizError('参数 id 不合法（应为 UUID）')
        return text

    # ---------------- JSON 字段读写 ----------------
    @staticmethod
    def _as_list(value, name):
        """JSON 字段既能收数组，也能收 JSON 字符串（GET / 表单提交）"""
        if value is None:
            return None
        if isinstance(value, (list, tuple)):
            return [one for one in value]
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return []
            try:
                parsed = json.loads(text)
            except ValueError:
                raise BizError('%s 不是合法的 JSON' % name)
            if not isinstance(parsed, list):
                raise BizError('%s 应为 JSON 数组' % name)
            return parsed
        raise BizError('%s 格式不正确' % name)

    @staticmethod
    def _as_dict(value, name):
        if value is None:
            return {}
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return {}
            try:
                parsed = json.loads(text)
            except ValueError:
                raise BizError('%s 不是合法的 JSON' % name)
            if not isinstance(parsed, dict):
                raise BizError('%s 应为 JSON 对象' % name)
            return parsed
        raise BizError('%s 格式不正确' % name)

    def _list_of(self, text):
        try:
            parsed = json.loads(text) if text else []
        except (TypeError, ValueError):
            parsed = []
        return parsed if isinstance(parsed, list) else []

    def _dict_of(self, text, defaults):
        try:
            parsed = json.loads(text) if text else {}
        except (TypeError, ValueError):
            parsed = {}
        out = dict(defaults)
        if isinstance(parsed, dict):
            for key in defaults.keys():
                if key in parsed and parsed[key] is not None:
                    out[key] = parsed[key]
        return out

    # ---------------- 参数 / 列 / 模板规范化 ----------------
    def _clean_params(self, items):
        items = items or []
        if len(items) > config.REPORT_MAX_PARAMS:
            raise BizError('报表参数最多 %d 个' % config.REPORT_MAX_PARAMS)
        out, seen = [], {}
        for one in items:
            if not isinstance(one, dict):
                continue
            name = self._text(one.get('name'))
            if not name:
                raise BizError('报表参数名不能为空')
            if not re.match(r'^[A-Za-z_][A-Za-z0-9_]{0,29}$', name):
                raise BizError('参数名「%s」不合法：只能用字母、数字、下划线，且以字母或下划线开头' % name)
            if name in seen:
                raise BizError('参数名「%s」重复，请换一个' % name)
            seen[name] = 1
            ptype = (self._text(one.get('type')) or 'string').lower()
            if ptype not in self.PARAM_TYPES:
                raise BizError('参数「%s」的取值类型不支持：%s' % (name, ptype))
            control = (self._text(one.get('control')) or
                       ('number' if ptype in ('int', 'number') else
                        ('date' if ptype in ('date', 'datetime') else 'text'))).lower()
            if control not in self.PARAM_CONTROLS:
                raise BizError('参数「%s」的控件类型不支持：%s' % (name, control))
            out.append({
                'name': name,
                'label': (self._text(one.get('label')) or name)[:60],
                'type': ptype,
                'control': control,
                'required': self._bool_of(one.get('required'), False),
                'defaultValue': self._text(one.get('defaultValue'))[:200],
                'options': self._text(one.get('options'))[:300],
                'remark': self._text(one.get('remark'))[:120],
            })
        return out

    def _clean_columns(self, items):
        items = items or []
        if len(items) > config.REPORT_MAX_COLUMNS:
            raise BizError('报表列最多 %d 个' % config.REPORT_MAX_COLUMNS)
        out, seen = [], {}
        for one in items:
            if not isinstance(one, dict):
                continue
            field = self._text(one.get('field'))
            if not field:
                raise BizError('报表列缺少字段名，请重新从左侧拖一个字段进来')
            if len(field) > 64 or not re.match(r'^[\w $#@]+$', field):
                raise BizError('字段名「%s」不合法（只允许字母、数字、下划线、中文与空格）' % field[:40])
            if field in seen:                     # 同一字段重复拖入：只保留第一次
                continue
            seen[field] = 1
            align = (self._text(one.get('align')) or 'left').lower()
            header_align = (self._text(one.get('headerAlign')) or 'center').lower()
            fmt = (self._text(one.get('format')) or 'text').lower()
            summary = (self._text(one.get('summary')) or 'none').lower()
            out.append({
                'field': field,
                'label': (self._text(one.get('label')) or field)[:60],
                'table': self._text(one.get('table'))[:120],
                'width': self._int_of(one.get('width'), 120, 40, 800),
                'align': align if align in self.COLUMN_ALIGNS else 'left',
                # 列标（表头）对齐与数据单元格对齐分开设置
                'headerAlign': header_align if header_align in self.COLUMN_ALIGNS else 'center',
                'format': fmt if fmt in self.COLUMN_FORMATS else 'text',
                'summary': summary if summary in self.COLUMN_SUMMARY else 'none',
                'visible': self._bool_of(one.get('visible'), True),
                # SQL 自定义列标记（2026-11-05）：非数据源字段的别名列，前端画布 / 属性面板用它打「自定义」标
                'custom': 1 if self._bool_of(one.get('custom'), False) else 0,
            })
        return out

    def _clean_design(self, value):
        src = self._as_dict(value, '画布设计')
        out = dict(self.DEFAULT_DESIGN)
        for key in out.keys():
            if key == 'elements' or key not in src:      # elements 单独走 _clean_elements
                continue
            if isinstance(self.DEFAULT_DESIGN[key], bool):
                out[key] = self._bool_of(src.get(key), self.DEFAULT_DESIGN[key])
            elif key in ('headerAlign', 'footerAlign'):
                val = (self._text(src.get(key)) or '').lower()
                out[key] = val if val in self.COLUMN_ALIGNS else self.DEFAULT_DESIGN[key]
            elif key == 'groupBy':
                out[key] = self._text(src.get(key))[:64]
            else:
                out[key] = self._as_text(src.get(key))[:120]
        out['elements'] = self._clean_elements(src.get('elements'), 0)
        return out

    # ---------------- 工具箱组件（设计区自由布局） ----------------
    @staticmethod
    def _hex_of(value, default=''):
        """颜色只收 #RGB / #RRGGBB / #RRGGBBAA（前端用颜色选择器，后端顺手做白名单）"""
        text = str(value or '').strip()
        if re.match(r'^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$', text):
            return text
        return default

    def _clean_element(self, one, depth):
        """
        一个组件的规范化：位置尺寸 + 按类型各自的属性
        · kind 必须在 ELEMENT_KINDS 里；坐标 / 尺寸都夹到合理范围（防拖飞）
        · 只有「区域（box）」可以带 children（再深一层就不收了）
        """
        if not isinstance(one, dict):
            return None
        kind = (self._text(one.get('kind')) or '').lower()
        if kind not in self.ELEMENT_KINDS:
            return None
        item = {
            'id': (self._text(one.get('id')) or str(uuid.uuid4()))[:40],
            'kind': kind,
            'x': self._int_of(one.get('x'), 0, 0, 4000),
            'y': self._int_of(one.get('y'), 0, 0, 4000),
            'w': self._int_of(one.get('w'), 200, 20, 4000),
            'h': self._int_of(one.get('h'), 40, 10, 4000),
        }
        if kind == 'label':
            align = (self._text(one.get('align')) or 'left').lower()
            item.update({
                'text': self._text(one.get('text'))[:200] or '文本',
                'fontSize': self._int_of(one.get('fontSize'), 14, 8, 48),
                'bold': self._bool_of(one.get('bold'), False),
                'align': align if align in self.COLUMN_ALIGNS else 'left',
                'color': self._hex_of(one.get('color'), '#303133'),
            })
        elif kind == 'line':
            item.update({
                'dir': 'v' if (self._text(one.get('dir')) or 'h').lower() == 'v' else 'h',
                'thickness': self._int_of(one.get('thickness'), 1, 1, 8),
                'color': self._hex_of(one.get('color'), '#DCDFE6'),
            })
        elif kind == 'box':
            item.update({
                'border': self._bool_of(one.get('border'), True),
                'borderColor': self._hex_of(one.get('borderColor'), '#DCDFE6'),
                'bg': self._hex_of(one.get('bg'), ''),
                'radius': self._int_of(one.get('radius'), 4, 0, 40),
                'padding': self._int_of(one.get('padding'), 8, 0, 40),
            })
            children = one.get('children') or []
            if children and depth + 1 >= self.MAX_ELEMENT_DEPTH:
                raise BizError('「区域」最多嵌套 %d 层，请把组件放到外层区域' % self.MAX_ELEMENT_DEPTH)
            item['children'] = self._clean_elements(children, depth + 1) if children else []
        elif kind == 'image':
            src = self._text(one.get('src'))
            if src and not re.match(r'^(https?://|/|assets/|data:image/)', src):
                src = ''                                # 只允许 http(s) / 站内相对路径 / data:image
            fit = (self._text(one.get('fit')) or 'contain').lower()
            item.update({
                'src': src[:500],
                'fit': fit if fit in ('contain', 'cover', 'fill') else 'contain',
                'radius': self._int_of(one.get('radius'), 0, 0, 40),
            })
        elif kind == 'chart':
            ctype = (self._text(one.get('chartType')) or 'bar').lower()
            item.update({
                'chartType': ctype if ctype in ('bar', 'line', 'pie') else 'bar',
                'title': self._text(one.get('title'))[:80],
                'categoryField': self._text(one.get('categoryField'))[:64],
                'valueField': self._text(one.get('valueField'))[:64],
                'legend': self._bool_of(one.get('legend'), True),
            })
        elif kind == 'table':
            # 表格：行列与单元格内容都由用户自己填（不是报表列的镜像）
            rows = self._int_of(one.get('rows'), 3, 1, self.TABLE_MAX_ROWS)
            cols = self._int_of(one.get('cols'), 3, 1, self.TABLE_MAX_COLS)
            cells = one.get('cells')
            if isinstance(cells, str):
                try:
                    cells = json.loads(cells or '[]')
                except ValueError:
                    raise BizError('表格内容不是合法的 JSON')
            if not isinstance(cells, (list, tuple)):
                cells = []
            grid = []
            for r in range(rows):
                line = cells[r] if r < len(cells) and isinstance(cells[r], (list, tuple)) else []
                grid.append([self._text(line[c] if c < len(line) else '')[:60] for c in range(cols)])
            align = (self._text(one.get('align')) or 'left').lower()
            item.update({
                'rows': rows, 'cols': cols, 'cells': grid,
                'showHeader': self._bool_of(one.get('showHeader'), True),   # 列头显示：否 = 不画列头行
                'headerRow': self._bool_of(one.get('headerRow'), True),     # 列头样式：首行是否当表头
                'align': align if align in self.COLUMN_ALIGNS else 'left',
            })
        return item

    def _clean_elements(self, items, depth=0):
        """整份组件列表：最多 MAX_ELEMENTS 个"""
        if items is None:
            return []
        if isinstance(items, str):
            try:
                items = json.loads(items) if items.strip() else []
            except ValueError:
                raise BizError('画布组件不是合法的 JSON')
        if not isinstance(items, (list, tuple)):
            raise BizError('画布组件应为数组')
        if len(items) > self.MAX_ELEMENTS:
            raise BizError('画布里的组件最多 %d 个，请合并或删掉一些' % self.MAX_ELEMENTS)
        out = []
        for one in items:
            cleaned = self._clean_element(one, depth)
            if cleaned:
                out.append(cleaned)
        return out

    def _clean_template(self, value):
        src = self._as_dict(value, '页面模板')
        out = dict(self.DEFAULT_TEMPLATE)
        for key, default in self.DEFAULT_TEMPLATE.items():
            if key not in src:
                continue
            if isinstance(default, bool):
                out[key] = self._bool_of(src.get(key), default)
            elif isinstance(default, (int, float)):
                out[key] = self._int_of(src.get(key), default, 0, 200)
            else:
                out[key] = self._as_text(src.get(key))[:120]
        out['paper'] = out['paper'] if out['paper'] in self.PAPERS else 'A4'
        out['orientation'] = 'landscape' if str(out['orientation']).lower() == 'landscape' else 'portrait'
        out['titleAlign'] = out['titleAlign'] if out['titleAlign'] in ('left', 'center', 'right') else 'center'
        out['fontSize'] = self._int_of(out['fontSize'], 12, 8, 20)
        out['titleSize'] = self._int_of(out['titleSize'], 18, 10, 36)
        for key in ('marginTop', 'marginRight', 'marginBottom', 'marginLeft'):
            out[key] = self._int_of(out[key], 10, 0, 80)
        for kind in ('header', 'footer'):
            src_text = self._text(out.get(kind + 'Logo'))
            if src_text and not re.match(r'^(https?://|/|assets/|data:image/)', src_text):
                src_text = ''
            out[kind + 'Logo'] = src_text[:500]
            out[kind + 'LogoPos'] = 'right' if self._text(out.get(kind + 'LogoPos')).lower() == 'right' else 'left'
            out[kind + 'LogoHeight'] = self._int_of(out.get(kind + 'LogoHeight'), 32, 12, 120)
        return out

    def _as_text(self, value):
        if value is None:
            return ''
        if isinstance(value, bool):
            return '1' if value else ''
        return self._text(value)

    # ---------------- 展示字段 ----------------
    def _attach(self, items, full=False):
        for it in items:
            params = self._list_of(it.get('paramsJson'))
            columns = self._list_of(it.get('columnsJson'))
            design = self._dict_of(it.get('designJson'), self.DEFAULT_DESIGN)
            template = self._dict_of(it.get('templateJson'), self.DEFAULT_TEMPLATE)
            it['enabled'] = bool(int(it.get('enabled') or 0))
            it['ispublic'] = bool(int(it.get('ispublic') or 0))
            it['version'] = int(it.get('version') or 1)
            it['runCount'] = int(it.get('runCount') or 0)
            it['lastRunTime'] = it.get('lastRunTime') or ''
            it['connName'] = it.get('connName') or ''
            # 数据源连接快照（2026-11-06）：密码只进不出 —— 只回 hasConnPassword 标记，
            # 其它快照字段用于「数据源信息」展示（连接对象后来被改 / 被删也能看出报表用的是哪套库）
            it['connSnapshot'] = self._snapshot_of(it)
            pwd = it.pop('connPassword', None)
            it['hasConnPassword'] = bool(pwd)
            it['category'] = it.get('category') or '未分类'
            it['description'] = it.get('description') or ''
            it['paramCount'] = len(params)
            it['columnCount'] = len(columns)
            it['title'] = design.get('title') or it.get('reportName') or ''
            for key in ('paramsJson', 'columnsJson', 'designJson', 'templateJson'):
                it.pop(key, None)
            if full:
                it['params'] = params
                it['columns'] = columns
                it['design'] = design
                it['template'] = template
                it['sqlText'] = it.get('sqlText') or ''
            else:
                sql = self._text(it.get('sqlText'))
                it['sqlPreview'] = (sql[:120] + '…') if len(sql) > 120 else sql
                it.pop('sqlText', None)
                it['paramSummary'] = ', '.join([self._text(one.get('label') or one.get('name'))
                                                for one in params[:3]])
                it['columnSummary'] = ', '.join([self._text(one.get('label') or one.get('field'))
                                                 for one in columns[:4]])
                it['paperText'] = '%s / %s' % (template.get('paper') or 'A4',
                                               '横向' if template.get('orientation') == 'landscape' else '纵向')
        return items

    def _find(self, uid):
        row = query_one('SELECT * FROM `%s` WHERE `id`=%%s' % self.table, (uid,))
        if not row:
            raise BizError(self.label + '不存在或已被删除', 404)
        return row

    # ---------------- 查询 ----------------
    def _visibility_where(self, params, mine_only=False):
        """
        可见性过滤：
          · 报表设计器清单（mine_only=True，2026-11-06 用户需求）：**只加载本用户创建的报表**
            （含停用 —— 自己停用的仍要能进设计器继续编辑）；
          · 报表中心（mine_only=False，2026-11-04 / 11-05 需求）：加载
            「本用户创建的」+「其他用户设为公共（ispublic=1）且处于启用状态的」报表；
            非本人创建的停用报表不显示（升级前他人公开报表全可见，故存量刷 ispublic=1）；
          · 按当前登录人 token 反查 empId；能拿到 empId 才过滤；
          · 拿不到登录上下文（内部调用 / 迁移脚本）时不过滤，保持旧行为。
        """
        user = self._login_user(params)
        emp_id = user.get('empId')
        if not emp_id:
            return '', []
        if mine_only:
            return ' (`createempinfosid`=%s)', [emp_id]
        return ' (`createempinfosid`=%s OR (`ispublic`=1 AND `enabled`=1))', [emp_id]

    def _build_where(self, params, mine_only=True):
        where, args = [], []
        vis_sql, vis_args = self._visibility_where(params, mine_only=mine_only)
        if vis_sql:
            where.append(vis_sql)
            args.extend(vis_args)
        keyword = self._text((params or {}).get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            where.append('(`code` LIKE %s OR `reportName` LIKE %s OR `reportNameEn` LIKE %s '
                         'OR `category` LIKE %s OR `connName` LIKE %s OR `mainTable` LIKE %s '
                         'OR `description` LIKE %s)')
            args.extend([like] * 7)
        category = self._text((params or {}).get('category'))
        if category:
            if category == '未分类':
                where.append('(`category` IS NULL OR `category`=\'\')')
            else:
                where.append('`category`=%s')
                args.append(category)
        conn_id = self._text((params or {}).get('connId'))
        if conn_id:
            where.append('`connId`=%s')
            args.append(conn_id)
        enabled = (params or {}).get('enabled')
        if enabled is not None and str(enabled).strip() != '':
            where.append('`enabled`=%s')
            args.append(1 if self._bool_of(enabled) else 0)
        return (' WHERE ' + ' AND '.join(where)) if where else '', args

    def page(self, params, mine_only=True):
        params = params or {}
        where, args = self._build_where(params, mine_only=mine_only)
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 10), 1), 200)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        row = query_one('SELECT COUNT(*) AS n FROM `%s`%s' % (self.table, where), args)
        total = int(row['n']) if row and row.get('n') is not None else 0
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        # 列表不取设计 JSON 全文：sqlText / designJson / templateJson 截断，params/columns 只留计数
        rows = query_all(
        'SELECT `id`,`code`,`reportName`,`reportNameEn`,`category`,`connId`,`connName`,'
        '`databaseName`,`mainTable`,`description`,`enabled`,`ispublic`,`version`,`runCount`,`lastRunTime`,'
        '`createEname`,`createempinfosid`,`updateEname`,`updateempinfosid`,'
        '`createTime`,`updateTime`,LEFT(`sqlText`,400) AS `sqlText`,'
            '`paramsJson`,`columnsJson`,LEFT(`designJson`,800) AS `designJson`,'
            'LEFT(`templateJson`,800) AS `templateJson` '
            'FROM `%s`%s ORDER BY %s LIMIT %%s OFFSET %%s'
            % (self.table, where, self.ORDER_BY),
            args + [page_size, (page_num - 1) * page_size])
        cats = query_all('SELECT `category`, COUNT(*) AS n FROM `%s`%s GROUP BY `category` '
                         'ORDER BY n DESC' % (self.table, where), args)
        return {'list': self._attach([dump_row(r) for r in rows]), 'total': total,
                'pageNum': page_num, 'pageSize': page_size, 'pages': pages,
                'categories': [{'value': (r.get('category') or '未分类'),
                                'count': int(r.get('n') or 0)} for r in (cats or [])]}

    def detail(self, params):
        uid = self._uuid_of((params or {}).get('id'))
        return self._attach([dump_row(self._find(uid))], full=True)[0]

    def check(self, params):
        """唯一性校验：报表编码唯一"""
        params = params or {}
        field = self._text(params.get('field')) or 'code'
        if field != 'code':
            raise BizError('不支持的唯一性校验字段：' + field)
        value = self._text(params.get('value')).upper()
        if not value:
            return {'unique': True}
        self_id = self._uuid_of(params.get('id')) if self._text(params.get('id')) else ''
        row = query_one('SELECT `id` FROM `%s` WHERE `code`=%%s AND `id`<>%%s LIMIT 1' % self.table,
                        (value, self_id))
        return {'unique': row is None}

    def categories(self, params=None):
        rows = query_all('SELECT `category`, COUNT(*) AS n FROM `%s` GROUP BY `category` '
                         'ORDER BY n DESC' % self.table)
        return {'list': [{'value': (r.get('category') or '未分类'),
                          'count': int(r.get('n') or 0)} for r in (rows or [])]}

    def center(self, params):
        """报表中心：只返回**启用状态**的报表（分类下拉同样只统计启用，避免选到空分类）；
        可见性 = 本用户创建的 + 他人设为公共（ispublic=1）的 —— 与设计器清单（只看本人）不同"""
        params = dict(params or {})
        params['enabled'] = 1                  # 覆盖入参，停用报表在报表中心里永远查不到
        data = self.page(params, mine_only=False)
        vis_sql, vis_args = self._visibility_where(params, mine_only=False)
        where_sql = '`enabled`=1'
        cat_args = []
        if vis_sql:
            where_sql += ' AND' + vis_sql       # vis_sql 自带前导空格与括号
            cat_args = vis_args
        rows = query_all('SELECT `category`, COUNT(*) AS n FROM `%s` WHERE %s '
                         'GROUP BY `category` ORDER BY n DESC'
                         % (self.table, where_sql), cat_args)
        data['categories'] = [{'value': (r.get('category') or '未分类'),
                               'count': int(r.get('n') or 0)} for r in (rows or [])]
        return data

    # ---------------- 数据源（连接 → 实例 → 表 / 视图 → 字段） ----------------
    def _snapshot_of(self, row):
        """
        报表行里的数据源快照 → 展示用 dict（**不含密码**，只给 hasPassword 标记）。
        没有快照（老报表 / 没选连接）时返回 {}。
        """
        row = row or {}
        if not row.get('connType') and not row.get('connHost') and not row.get('connDbName'):
            return {}
        db_type = (self._text(row.get('connType')) or 'mysql').lower()
        return {
            'id': row.get('connId') or '', 'name': row.get('connName') or '',
            'dbType': db_type, 'typeLabel': connector.type_label(db_type),
            'host': row.get('connHost') or '', 'port': row.get('connPort'),
            'dbName': row.get('connDbName') or '', 'username': row.get('connUsername') or '',
            'charset': row.get('connCharset') or '', 'extraParams': row.get('connExtraParams') or '',
            'hasPassword': bool(row.get('connPassword')),
        }

    def _conf_from_snapshot(self, row):
        """报表行里的数据源快照 → 扫描 / 查询用配置（密码解密，只在内存里用）"""
        return {
            'id': row.get('connId'), 'name': row.get('connName'),
            'dbType': self._text(row.get('connType')) or 'mysql',
            'host': row.get('connHost'), 'port': row.get('connPort'),
            'dbName': row.get('connDbName'), 'username': row.get('connUsername'),
            'password': connector.decrypt_secret(row.get('connPassword')),
            'charset': row.get('connCharset'), 'extraParams': row.get('connExtraParams'),
        }

    def _conf_of(self, conn_id):
        uid = self._uuid_of(conn_id)
        row = query_one('SELECT * FROM `dbinfomgr` WHERE `id`=%s', (uid,))
        if not row:
            raise BizError('数据库连接不存在或已被删除，请重新选择数据源')
        return {'id': row.get('id'), 'name': row.get('name'), 'dbType': row.get('dbType'),
                'host': row.get('host'), 'port': row.get('port'), 'dbName': row.get('dbName'),
                'username': row.get('username'),
                'password': connector.decrypt_secret(row.get('password')),
                'charset': row.get('charset'), 'extraParams': row.get('extraParams')}

    def connections(self, params=None):
        """
        数据源下拉：启用状态的数据库连接（没有密码等敏感字段）。
        可见性（2026-11-06 用户需求）：只列出「本用户创建的」+「其他用户标为公用（ispub=1）的」连接；
        拿不到登录上下文（内部调用）时不过滤，保持旧行为。
        """
        params = params or {}
        where = ['`enabled`=1']
        args = []
        user = self._login_user(params)
        emp_id = user.get('empId')
        if emp_id:
            where.append('(`createempinfosid`=%s OR `ispub`=1)')
            args.append(emp_id)
        rows = query_all('SELECT `id`,`name`,`dbType`,`dbName`,`host`,`port` FROM `dbinfomgr` '
                         'WHERE ' + ' AND '.join(where) + ' ORDER BY `name` ASC', args)
        out = []
        for r in (rows or []):
            db_type = str(r.get('dbType') or 'mysql').lower()
            has_file = connector.is_file_type(db_type)
            out.append({'id': r.get('id'), 'name': r.get('name'), 'dbType': db_type,
                        'typeLabel': connector.type_label(db_type), 'hasFile': has_file,
                        'dbName': r.get('dbName') or '',
                        'serverText': (r.get('dbName') or '') if has_file else
                                      ('%s:%s' % (r.get('host') or '',
                                                  r.get('port') or connector.default_port(db_type)))})
        return {'list': out, 'total': len(out)}

    def databases(self, params):
        """扫连接下可用的实例（库）"""
        params = params or {}
        conf = self._conf_of(params.get('connId') or params.get('id'))
        try:
            result = connector.databases(conf)
        except connector.ConnError as exc:
            raise BizError(exc.message)
        result['connection'] = {'id': conf.get('id'), 'name': conf.get('name'),
                                'dbType': conf.get('dbType'),
                                'typeLabel': connector.type_label(conf.get('dbType'))}
        return result

    def tables(self, params):
        params = params or {}
        conf = self._conf_of(params.get('connId') or params.get('id'))
        try:
            result = connector.tables(conf, self._text(params.get('database')))
        except connector.ConnError as exc:
            raise BizError(exc.message)
        result['database'] = self._text(params.get('database'))
        return result

    def columns(self, params):
        params = params or {}
        conf = self._conf_of(params.get('connId') or params.get('id'))
        database = self._text(params.get('database'))
        table = self._text(params.get('table'))
        try:
            result = connector.columns(conf, database, table)
        except connector.ConnError as exc:
            raise BizError(exc.message)
        result['database'] = database
        result['table'] = table
        return result

    # ---------------- 写入 ----------------
    def _next_code(self):
        # 注意：LIKE 的值走参数绑定，不能写进 %% 拼接（会被 Python 的 % 运算和 PyMySQL 各吃一层）
        rows = query_all("SELECT `code` FROM `%s` WHERE `code` LIKE %%s" % self.table, ('RPT%',))
        max_seq = 0
        for r in (rows or []):
            matched = re.match(r'^RPT(\d+)$', str(r.get('code') or ''), re.I)
            if matched:
                max_seq = max(max_seq, int(matched.group(1)))
        return 'RPT%04d' % (max_seq + 1)

    def _pick_text(self, data, current, key, limit):
        """请求里带了就用新的（清空算清空），没带就沿用原值 —— 局部更新不会误清字段"""
        if key in data:
            return (self._text(data.get(key)) or '')[:limit] or None
        return (current.get(key) if current else None)

    def _normalize(self, data, current=None):
        data = data or {}
        current = current or {}
        code = self._text(data.get('code')) or self._text(current.get('code'))
        if not code:
            code = self._next_code()
        code = code.upper()
        if not re.match(r'^[A-Z0-9_-]{2,60}$', code):
            raise BizError('报表编码只能用字母、数字、下划线或短横线（2~60 位）')
        report_name = self._text(data.get('reportName')) or self._text(current.get('reportName'))
        if not report_name:
            raise BizError('报表名称不能为空')
        if len(report_name) > 120:
            raise BizError('报表名称最多 120 个字符')
        conn_id = self._text(data.get('connId')) or self._text(current.get('connId'))
        if not conn_id:
            raise BizError('请先选择数据源连接，再保存报表')
        conn_row = query_one('SELECT * FROM `dbinfomgr` WHERE `id`=%s',
                             (self._uuid_of(conn_id),))
        if not conn_row:
            raise BizError('数据库连接不存在或已被删除，请重新选择数据源')
        sql_text = data.get('sqlText')
        if sql_text is None:
            sql_text = current.get('sqlText')
        sql_text = self._text(sql_text)
        if len(sql_text) > config.REPORT_SQL_MAX_CHARS:
            raise BizError('报表 SQL 太长（%d 字符），请精简到 %d 字符以内'
                           % (len(sql_text), config.REPORT_SQL_MAX_CHARS))

        params = self._as_list(data.get('params') if 'params' in data else data.get('paramsJson'),
                               '报表参数')
        if params is None:
            params = self._list_of(current.get('paramsJson'))
        columns = self._as_list(data.get('columns') if 'columns' in data
                                else data.get('columnsJson'), '报表列')
        if columns is None:
            columns = self._list_of(current.get('columnsJson'))
        design = data.get('design') if 'design' in data else data.get('designJson')
        if design is None:
            design = current.get('designJson')
        template = data.get('template') if 'template' in data else data.get('templateJson')
        if template is None:
            template = current.get('templateJson')

        picked = {
            'code': code,
            'reportName': report_name,
            # 下面这些「次要字段」：请求里没带就沿用原值（局部更新时不会被顺手清空）
            'reportNameEn': self._pick_text(data, current, 'reportNameEn', 120),
            'category': self._pick_text(data, current, 'category', 60),
            'connId': conn_row.get('id'),
            'connName': conn_row.get('name'),
            # 数据源连接快照（2026-11-06 用户需求）：保存时把连接对象的全部访问信息一起落库，
            # 之后连接在「数据库连接管理」里被改 / 被删，报表仍然按保存时的配置执行。
            # 密码沿用 dbinfomgr 的密文（enc:v1:），不解密、不落明文。
            'connType': (conn_row.get('dbType') or 'mysql'),
            'connHost': conn_row.get('host'),
            'connPort': conn_row.get('port'),
            'connDbName': conn_row.get('dbName'),
            'connUsername': conn_row.get('username'),
            'connPassword': conn_row.get('password'),
            'connCharset': conn_row.get('charset'),
            'connExtraParams': conn_row.get('extraParams'),
            'databaseName': self._pick_text(data, current, 'databaseName', 120),
            'mainTable': self._pick_text(data, current, 'mainTable', 120),
            'sqlText': sql_text or None,
            'paramsJson': json.dumps(self._clean_params(params), ensure_ascii=False),
            'columnsJson': json.dumps(self._clean_columns(columns), ensure_ascii=False),
            'designJson': json.dumps(self._clean_design(design), ensure_ascii=False),
            'templateJson': json.dumps(self._clean_template(template), ensure_ascii=False),
            'description': self._pick_text(data, current, 'description', 500),
        }
        if 'enabled' in data:
            picked['enabled'] = 1 if self._bool_of(data.get('enabled'), True) else 0
        if 'ispublic' in data:
            picked['ispublic'] = 1 if self._bool_of(data.get('ispublic'), False) else 0
        return picked

    def _assert_code_unique(self, code, self_id=''):
        row = query_one('SELECT `id` FROM `%s` WHERE `code`=%%s AND `id`<>%%s LIMIT 1' % self.table,
                        (code, self_id))
        if row:
            raise BizError('报表编码【%s】已存在，请换一个' % code)

    def _login_user(self, params):
        """
        当前登录人 → {'ename': 员工姓名, 'empId': 员工ID 或 None}
          · 优先按 token 反查（require_login 已把 _loginUserId 放进参数）：
            useinfo.empId → empinfos.nameCn；姓名取不到时退回登录账号；
          · 没有登录上下文（内部调用 / 迁移脚本）时，才用调用方自己传的值
            （createEname；兼容老字段名 createUser、createempinfosid）。
        """
        params = params or {}
        fallback = {
            'ename': self._text(params.get('createEname') or params.get('createUser'))[:100],
            'empId': self._emp_id_of(params.get('createempinfosid')),
        }
        user_id = self._text(params.get('_loginUserId'))
        if not user_id:
            return fallback
        try:
            row = query_one(self.LOGIN_NAME_SQL, (user_id,))
        except Exception:            # 查不到人也不能影响保存
            row = None
        if not row:
            return fallback
        return {
            'ename': (self._text(row.get('empName')) or self._text(row.get('account')))[:100],
            'empId': self._emp_id_of(row.get('empId')),
        }

    def _login_user_name(self, params):
        """只要当前登录人的**员工姓名**（写进 reportinfos.createEname）"""
        return self._login_user(params).get('ename') or ''

    @staticmethod
    def _emp_id_of(value):
        """员工ID 一律按正整数存（empinfos.id 是 BIGINT UNSIGNED），非法 / 空 → None"""
        emp_id = ReportDesignerService._int_of(value, 0, 0)
        return emp_id or None

    def _stamp(self, picked, user, kind):
        """把「创建人」或「修改人」的姓名 + 员工ID 写进待保存字段"""
        if kind == 'create':
            picked['createEname'] = user.get('ename') or None
            picked['createempinfosid'] = user.get('empId')
        else:
            picked['updateEname'] = user.get('ename') or None
            picked['updateempinfosid'] = user.get('empId')
        return picked

    def add(self, data):
        data = data or {}
        picked = self._normalize(data)
        self._assert_code_unique(picked['code'])
        picked['id'] = str(uuid.uuid4())
        picked.setdefault('enabled', 1)
        picked.setdefault('ispublic', 0)       # 新报表默认私有（只有创建人可见）
        picked['version'] = 1
        picked['runCount'] = 0
        # 创建人 / 修改人：都由后端按 token 反查当前登录人写入，前端传什么都不作数
        user = self._login_user(data)
        self._stamp(picked, user, 'create')
        self._stamp(picked, user, 'update')      # 新建即首次保存，先与创建人一致
        columns = ','.join('`%s`' % c for c in picked.keys())
        holders = ','.join(['%s'] * len(picked))
        try:
            execute('INSERT INTO `%s` (%s) VALUES (%s)' % (self.table, columns, holders),
                    list(picked.values()))
        except DuplicateError:
            raise BizError('报表编码【%s】已存在，请换一个' % picked['code'])
        return self._attach([dump_row(self._find(picked['id']))], full=True)[0]

    def update(self, data):
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        current = self._find(uid)
        picked = self._normalize(data, current)
        self._assert_code_unique(picked['code'], uid)
        picked['version'] = int(current.get('version') or 1) + 1
        user = self._login_user(data)
        # 修改人：每次保存都刷新成当前登录人
        self._stamp(picked, user, 'update')
        # 创建人只在新建时定：更新不覆盖；老数据（createUser 时代）没姓名时用当前登录人补一次
        if not self._text(current.get('createEname')):
            self._stamp(picked, user, 'create')
        assignments = ','.join('`%s`=%%s' % c for c in picked.keys())
        try:
            execute('UPDATE `%s` SET %s WHERE `id`=%%s' % (self.table, assignments),
                    list(picked.values()) + [uid])
        except DuplicateError:
            raise BizError('报表编码【%s】已存在，请换一个' % picked['code'])
        return self._attach([dump_row(self._find(uid))], full=True)[0]

    def delete(self, params):
        uid = self._uuid_of((params or {}).get('id'))
        row = self._find(uid)
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.table, (uid,))
        return self._attach([dump_row(row)], full=True)[0]

    def enabled(self, params):
        params = params or {}
        uid = self._uuid_of(params.get('id'))
        row = self._find(uid)
        on = 1 if self._bool_of(params.get('enabled', 1), True) else 0
        execute('UPDATE `%s` SET `enabled`=%%s WHERE `id`=%%s' % self.table, (on, uid))
        item = self._attach([dump_row(self._find(uid))], full=True)[0]
        item['message'] = ('报表「%s」已启用' % row['reportName']) if on else \
                          ('报表「%s」已停用' % row['reportName'])
        return item

    def copy(self, params):
        """复制一张报表（新编码自动生成，名称加「副本」）"""
        uid = self._uuid_of((params or {}).get('id'))
        row = self._find(uid)
        data = {
            'code': self._next_code(),
            'reportName': (self._text(params.get('reportName')) or
                           (self._text(row.get('reportName')) + '（副本）'))[:120],
            'reportNameEn': row.get('reportNameEn'),
            'category': row.get('category'),
            'connId': row.get('connId'),
            'databaseName': row.get('databaseName'),
            'mainTable': row.get('mainTable'),
            'sqlText': row.get('sqlText'),
            'paramsJson': row.get('paramsJson'),
            'columnsJson': row.get('columnsJson'),
            'designJson': row.get('designJson'),
            'templateJson': row.get('templateJson'),
            'description': row.get('description'),
            'enabled': 0,
            'ispublic': 0,                     # 副本默认私有（创建人 = 执行复制的人）
        }
        picked = self._normalize(data)
        self._assert_code_unique(picked['code'])
        picked['id'] = str(uuid.uuid4())
        picked['version'] = 1
        picked['runCount'] = 0
        user = self._login_user(params)          # 副本的创建人 = 执行复制的人
        self._stamp(picked, user, 'create')
        self._stamp(picked, user, 'update')
        columns = ','.join('`%s`' % c for c in picked.keys())
        holders = ','.join(['%s'] * len(picked))
        execute('INSERT INTO `%s` (%s) VALUES (%s)' % (self.table, columns, holders),
                list(picked.values()))
        item = self._attach([dump_row(self._find(picked['id']))], full=True)[0]
        item['message'] = '已复制为「%s」（默认停用）' % picked['code']
        return item

    # ---------------- 预览 / 调用（只读查询） ----------------
    def _payload_of(self, row):
        return {
            'id': row.get('id'), 'code': row.get('code'),
            'reportName': row.get('reportName'),
            'reportNameEn': row.get('reportNameEn') or '',
            'category': row.get('category') or '',
            'connId': row.get('connId'), 'connName': row.get('connName') or '',
            # 数据源快照原样带进 payload：_execute 优先用它（连接对象后来被改 / 被删也不影响执行）
            'connSnapshot': {
                'connId': row.get('connId'), 'connName': row.get('connName'),
                'connType': row.get('connType'), 'connHost': row.get('connHost'),
                'connPort': row.get('connPort'), 'connDbName': row.get('connDbName'),
                'connUsername': row.get('connUsername'), 'connPassword': row.get('connPassword'),
                'connCharset': row.get('connCharset'), 'connExtraParams': row.get('connExtraParams'),
            } if (row.get('connType') or row.get('connHost') or row.get('connDbName')) else None,
            'databaseName': row.get('databaseName') or '',
            'mainTable': row.get('mainTable') or '',
            'sqlText': row.get('sqlText') or '',
            'columns': self._list_of(row.get('columnsJson')),
            'params': self._list_of(row.get('paramsJson')),
            'design': self._dict_of(row.get('designJson'), self.DEFAULT_DESIGN),
            'template': self._dict_of(row.get('templateJson'), self.DEFAULT_TEMPLATE),
        }

    def _coerce_value(self, param, raw):
        name = param.get('name')
        label = param.get('label') or name
        text = self._text(raw)
        if text == '':
            return None
        ptype = param.get('type') or 'string'
        if ptype == 'int':
            try:
                return int(float(text))
            except (TypeError, ValueError):
                raise BizError('报表参数「%s」应为整数' % label)
        if ptype == 'number':
            try:
                return float(text)
            except (TypeError, ValueError):
                raise BizError('报表参数「%s」应为数字' % label)
        if ptype == 'bool':
            return 1 if text.lower() in ('1', 'true', 'yes', 'on', '是') else 0
        return text

    def _param_values(self, params, given):
        given = self._as_dict(given, '报表参数值')
        out = {}
        for one in (params or []):
            if not isinstance(one, dict):
                continue
            name = self._text(one.get('name'))
            if not name:
                continue
            raw = given.get(name)
            if raw is None or self._text(raw) == '':
                raw = one.get('defaultValue')
            if self._text(raw) == '' and self._bool_of(one.get('required')):
                raise BizError('请先填写报表参数「%s」' % (one.get('label') or name))
            out[name] = self._coerce_value(one, raw)
        return out

    def _conf_for_exec(self, payload):
        """
        执行 / 预览时用哪套连接配置（2026-11-06）：
          · 报表行里有数据源快照、且与本次要用的 connId 一致（或请求没指定 connId）→ **用快照**，
            连接对象后来被改主机 / 改密码 / 被删除都不影响已保存的报表；
          · 否则（老报表没快照、或前端临时换了数据源）→ 回退到 dbinfomgr 的当前值。
        """
        conn_id = self._text(payload.get('connId'))
        snap = payload.get('connSnapshot') or {}
        snap_id = self._text(snap.get('connId'))
        if snap and (not conn_id or not snap_id or snap_id == conn_id) and \
                (self._text(snap.get('connType')) or self._text(snap.get('connHost')) or
                 self._text(snap.get('connDbName'))):
            return self._conf_from_snapshot(snap)
        if not conn_id:
            raise BizError('报表还没有选择数据源连接')
        return self._conf_of(conn_id)

    def _execute(self, payload, param_values, max_rows=None):
        conf = self._conf_for_exec(payload)
        columns = payload.get('columns') or []
        params = payload.get('params') or []
        values = self._param_values(params, param_values)

        sql = self._text(payload.get('sqlText'))
        if not sql:
            table = self._text(payload.get('mainTable'))
            if not table:
                raise BizError('请把左侧的表拖进画布，或写一条报表 SQL')
            sql = connector.auto_report_sql(conf.get('dbType'), table,
                                            [self._text(one.get('field'))
                                             for one in columns if isinstance(one, dict)])

        if max_rows is None:
            max_rows = config.REPORT_PREVIEW_ROWS
        # 预览只取 config.REPORT_PREVIEW_ROWS 行图快；打印 / 导出会显式传更大的行数，
        # 上限是 config.REPORT_EXPORT_ROWS（默认 2 万），保证「打印 / 导出 = 全部查询结果」。
        max_rows = min(max(self._int_of(max_rows, config.REPORT_PREVIEW_ROWS), 1),
                       config.REPORT_EXPORT_ROWS)
        try:
            result = connector.query(conf, self._text(payload.get('databaseName')),
                                     sql, max_rows, values)
        except connector.ConnError as exc:
            raise BizError(exc.message)

        names = [one.get('name') for one in result.get('columns') or []]
        # 预览只显示「查询结果里真的有」的列：报表 SQL 可能只挑了部分列（或写了别名），
        # 这时按列定义里 index<0 的列不渲染，避免预览里出现一片空白列；结果里多出来的列追加在后面。
        mapped, used = [], {}
        for one in columns:
            if not isinstance(one, dict):
                continue
            field = self._text(one.get('field'))
            if not field or field not in names or field in used:
                continue
            used[field] = 1
            mapped.append({
                'field': field,
                'label': self._text(one.get('label')) or field,
                'index': names.index(field),
                'width': self._int_of(one.get('width'), 120, 40, 800),
                'align': one.get('align') or 'left',
                'headerAlign': one.get('headerAlign') or 'center',
                'format': one.get('format') or 'text',
                'summary': one.get('summary') or 'none',
                'visible': self._bool_of(one.get('visible'), True),
            })
        for idx, name in enumerate(names):          # 查询结果里没定义过的列自动补上
            if name in used:
                continue
            used[name] = 1
            mapped.append({'field': name, 'label': name, 'index': idx, 'width': 120,
                           'align': 'left', 'headerAlign': 'center', 'format': 'text',
                           'summary': 'none', 'visible': True})
        if not mapped:                            # 没有任何结果列（极少见）
            mapped = [{'field': name, 'label': name, 'index': idx, 'width': 120,
                       'align': 'left', 'format': 'text', 'summary': 'none', 'visible': True}
                      for idx, name in enumerate(names)]

        result['mapped'] = mapped
        result['params'] = params
        result['paramValues'] = dict([(k, '' if v is None else str(v))
                                      for k, v in (values or {}).items()])
        result['report'] = {'id': payload.get('id') or '', 'code': payload.get('code') or '',
                            'reportName': payload.get('reportName') or '',
                            'category': payload.get('category') or ''}
        result['design'] = payload.get('design') or dict(self.DEFAULT_DESIGN)
        result['template'] = payload.get('template') or dict(self.DEFAULT_TEMPLATE)
        result['connection'] = {'id': conf.get('id'), 'name': conf.get('name'),
                                'dbType': conf.get('dbType'),
                                'typeLabel': connector.type_label(conf.get('dbType'))}
        result['message'] = '预览成功，返回 %d 行%s' % (
            int(result.get('rowCount') or 0),
            '（已截断，仅显示前 %d 行）' % max_rows if result.get('truncated') else '')
        return result

    def _resolve_payload(self, params):
        """
        把请求参数整理成「一份可执行的报表」（预览 / 导出 / 打印取全部行共用）
        :param params {id?|code?, connId, databaseName, mainTable, sqlText, columns, paramsJson,
                       design, template}
           · 传 id（或 code）时先用库里保存的报表，再用请求里的字段覆盖（画布上未保存的改动也能用）；
           · columns / paramsJson 既可以是数组，也可以是 JSON 字符串。
        """
        params = params or {}
        payload = {'columns': [], 'params': [], 'design': None, 'template': None,
                   'mainTable': '', 'sqlText': '', 'databaseName': '', 'connId': '',
                   'code': '', 'reportName': '', 'category': '', 'id': ''}
        rid = self._text(params.get('id'))
        code = self._text(params.get('code')).upper()
        if rid:
            payload = self._payload_of(self._find(self._uuid_of(rid)))
        elif code:
            row = query_one('SELECT * FROM `%s` WHERE `code`=%%s' % self.table, (code,))
            if not row:
                raise BizError('报表不存在或已被删除（编码 %s）' % code, 404)
            payload = self._payload_of(row)
        for key in ('connId', 'databaseName', 'mainTable', 'sqlText', 'reportName',
                    'category', 'code'):
            if key in params and params.get(key) is not None:
                payload[key] = params.get(key)
        for key in ('columns', 'columnsJson'):
            if key in params and params.get(key) is not None:
                payload['columns'] = self._as_list(params.get(key), '报表列')
        # 行号是查看窗里右键切的，可能还没保存到设计里：请求显式带了就覆盖
        if params.get('showRowNo') is not None:
            design = dict(payload.get('design') or self.DEFAULT_DESIGN)
            design['showRowNo'] = self._bool_of(params.get('showRowNo'), False)
            payload['design'] = design
        # 注意：params 同时是「本接口的入参对象」，报表参数定义只能放在 paramsJson 里
        if params.get('paramsJson') is not None:
            payload['params'] = self._as_list(params.get('paramsJson'), '报表参数')
        for key in ('design', 'designJson'):
            if key in params and params.get(key) is not None:
                payload['design'] = self._clean_design(params.get(key))
        for key in ('template', 'templateJson'):
            if key in params and params.get(key) is not None:
                payload['template'] = self._clean_template(params.get(key))
        return payload

    def preview(self, params):
        """
        报表预览：未保存也能预览
        :param params {id?, connId, databaseName, mainTable, sqlText, columns, paramsJson, paramValues, maxRows}
        :return {sql, columns, rows, rowCount, truncated, elapsed, mapped, params, paramValues,
                 report, design, template, connection, database, executedAt, message}
        """
        params = params or {}
        payload = self._resolve_payload(params)
        return self._execute(payload, params.get('paramValues'), params.get('maxRows'))

    def export_file(self, params):
        """
        导出「全部查询结果」为 Excel / PDF（打印是浏览器本地完成，不走这里）
        :param params {id?|code?, connId, sqlText, columns, paramsJson, paramValues, format, maxRows?}
               format: excel（默认）/ pdf
        :return dict {content(bytes), filename, mimetype, rowCount, truncated, format, sql}
           · 行数上限 config.REPORT_EXPORT_ROWS（默认 2 万），truncated 为真说明还没取全；
           · 生成失败（缺依赖 / 数据太大）抛 BizError，message 直接给前端看。
        """
        params = params or {}
        payload = self._resolve_payload(params)
        fmt = self._text(params.get('format')) or 'excel'
        max_rows = params.get('maxRows') or config.REPORT_EXPORT_ROWS
        result = self._execute(payload, params.get('paramValues'), max_rows)
        try:
            content, ext, mimetype = report_export.build(result, fmt)
        except report_export.ExportError as exc:
            raise BizError(exc.message)
        filename = report_export.suggested_filename(result, ext)
        return {
            'content': content,
            'filename': filename,
            'mimetype': mimetype,
            'format': ext,
            'rowCount': int(result.get('rowCount') or 0),
            'truncated': bool(result.get('truncated')),
            'sql': result.get('sql') or '',
        }

    def run(self, params):
        """
        报表调用：按 id 或 code 执行已保存的报表（累加 runCount / 刷新 lastRunTime）
        :param params {id?|code?, paramValues, maxRows}
        """
        params = params or {}
        uid = self._text(params.get('id'))
        code = self._text(params.get('code')).upper()
        row = None
        if uid:
            row = self._find(self._uuid_of(uid))
        elif code:
            row = query_one('SELECT * FROM `%s` WHERE `code`=%%s' % self.table, (code,))
            if not row:
                raise BizError('报表不存在或已被删除（编码 %s）' % code, 404)
        else:
            raise BizError('请提供报表 id 或 code')
        if not int(row.get('enabled') or 0):
            raise BizError('报表「%s」已停用，不能调用' % row.get('reportName'))
        payload = self._payload_of(row)
        result = self._execute(payload, params.get('paramValues'), params.get('maxRows'))
        now_text = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        try:
            execute('UPDATE `%s` SET `runCount`=`runCount`+1, `lastRunTime`=%%s WHERE `id`=%%s'
                    % self.table, (now_text, row.get('id')))
        except Exception:
            pass
        result['runCount'] = int(row.get('runCount') or 0) + 1
        result['lastRunTime'] = now_text
        result['message'] = '报表「%s」执行完成，返回 %d 行' % (
            row.get('reportName'), int(result.get('rowCount') or 0))
        return result


report_service = ReportDesignerService()


# =====================================================================
# 项目管理：项目信息（projectinfos）+ 项目文件（projectfiles）
# ---------------------------------------------------------------------
# 两张表都是 UUID 主键，共用一套「归属人 + 公用否」的可见性规则：
#   可见 = 归属人ID = 当前登录员工ID OR ispub = 1
# 归属人在项目表是 createempinfosid（创建人），在文件表是 uploadempinfosid（上传人）。
# 归属人由后端按登录 token 反查 useinfo → empinfos 自动写入，前端不传、页面不展示。
# =====================================================================

PROJECT_TYPES = ('研发', '实施', '测试', '设计', '产品', '需求', '数据分析', '科研', '其它')
PROJECT_STATUSES = ('未开始', '进行中', '已暂停', '已完成', '已归档')
PROJECT_FILE_TYPES = ('文档', '表格', '图片', '压缩包', '代码', '设计稿', '其它')
PROJECT_CODE_PREFIX = 'PRO'
PROJECT_CODE_DIGITS = 6
PROJECT_CODE_MAX = 999999
PROJECT_FILE_MAX_BYTES = 10 * 1024 * 1024       # 单个文件上限 10 MB
PROJECT_DESC_MAX = 200000                        # 项目说明（富文本 HTML）长度上限，单位：字符
PROJECT_TYPE_DICT = 'project_type'               # 项目类型在系统字典里的英文名


def project_type_dict():
    """项目类型下拉的数据源：取系统字典 `project_type` 的启用键值（sortNo 升序）。

    每条键值取「键」做下拉文本与保存值（键留空时用「键值」），与需求确认的口径一致；
    返回 (values, source)：source='dict' 表示取自字典，'builtin' 表示字典不存在 /
    已停用 / 没有启用键值时回落到内置 PROJECT_TYPES。每次调用实时查库，字典页改完
    即时生效（不做缓存，避免建缓存后要额外处理失效）。
    """
    try:
        head = query_one('SELECT `id` FROM `sysdict` '
                         'WHERE `dictNameEn`=%s AND `enabled`=1 LIMIT 1', (PROJECT_TYPE_DICT,))
        if head:
            rows = query_all('SELECT `itemKey`,`itemValue`,`sortNo`,`id` FROM `sysdictitems` '
                             'WHERE `dictId`=%s AND `enabled`=1 '
                             'ORDER BY `sortNo` ASC, `id` ASC', (head['id'],))
            values, seen = [], set()
            for row in (rows or []):
                value = (str(row.get('itemKey') or '').strip()
                         or str(row.get('itemValue') or '').strip())
                if value and value not in seen:
                    seen.add(value)
                    values.append(value)
            if values:
                return values, 'dict'
    except Exception:
        pass
    return list(PROJECT_TYPES), 'builtin'

# ---------------------------------------------------------------------
# 项目说明富文本：白名单清洗 + Word（.docx / .docm）→ HTML
#   · 前端 js/word-import.js 有一套同口径的清洗与解析；后端这一份用于
#     ① 保存时兜底清洗（防止绕过页面直接调接口写入脚本）；
#     ② 浏览器不支持 deflate-raw 解压时，走 /api/project/importdoc 服务端解析。
#   · 只允许排版类标签与 CSS，禁 script / on* / javascript: / url() / 外链资源。
# ---------------------------------------------------------------------
RICH_TAGS = set(('p div span br b strong i em u s strike del sub sup ul ol li '
                 'table thead tbody tfoot tr td th h1 h2 h3 h4 h5 h6 '
                 'blockquote hr pre code img a font').split())
RICH_VOID = set(('br', 'hr', 'img'))
RICH_DROP_CONTENT = set(('script', 'style', 'iframe', 'object', 'embed',
                         'template', 'noscript', 'title'))
RICH_DROP_TAGS = set(('link', 'meta', 'base', 'form', 'input', 'button', 'select',
                      'textarea', 'svg', 'math', 'xml', 'o:p', 'w:sdt', 'v:shape',
                      'v:shapetype', 'v:imagedata'))
RICH_STYLE_PROPS = set(('text-align font-size font-weight font-style text-decoration color '
                        'background-color line-height margin margin-left margin-right padding '
                        'padding-left text-indent border-collapse width height vertical-align '
                        'font-family white-space border border-color border-width').split())
RICH_ATTRS = {
    '*': set(('style', 'align', 'title')),
    'a': set(('href', 'target', 'rel')),
    'img': set(('src', 'alt', 'width', 'height')),
    'td': set(('colspan', 'rowspan', 'width', 'valign')),
    'th': set(('colspan', 'rowspan', 'width', 'valign')),
    'table': set(('border', 'cellpadding', 'cellspacing', 'width')),
    'font': set(('color', 'size', 'face'))
}
RICH_URL_OK = re.compile(r'^(https?://|mailto:|#|/|\./|\.\./)', re.I)
RICH_DATA_IMG_OK = re.compile(r'^data:image/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$', re.I)


def _rich_safe_url(value, is_img):
    text = (value or '').strip()
    low = text.lower().replace('\x00', '')
    if low.startswith(('javascript:', 'vbscript:', 'file:', 'data:text', 'data:application')):
        return False
    if low.startswith('data:'):
        return bool(is_img and RICH_DATA_IMG_OK.match(text))
    if RICH_URL_OK.match(text):
        return True
    # 相对路径可以，别的自定义 scheme 一律拒绝
    return not re.match(r'^[a-z][a-z0-9+.\-]*:', low)


def _rich_safe_style(value):
    out = []
    for part in (value or '').split(';'):
        if ':' not in part:
            continue
        key, val = part.split(':', 1)
        key, val = key.strip().lower(), val.strip()
        if key not in RICH_STYLE_PROPS or not val:
            continue
        low = val.lower()
        if any(x in low for x in ('expression', 'javascript:', 'url(', '@import',
                                  'behavior:', 'position:', 'filter:', '<', '>')):
            continue
        out.append('%s:%s' % (key, val))
    return ';'.join(out)


class _RichHTMLCleaner(HTMLParser):
    """HTMLParser 白名单清洗：未知标签丢标签留内容，危险标签连内容一起丢"""

    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.out = []
        self.stack = []
        self.hidden = 0

    def _drop(self, name):
        return name in RICH_DROP_CONTENT or name in RICH_DROP_TAGS

    def handle_starttag(self, tag, attrs):
        name = (tag or '').lower()
        if name in RICH_DROP_CONTENT:
            self.hidden += 1
            return
        if self.hidden or self._drop(name) or name not in RICH_TAGS:
            return
        piece = ['<', name]
        allowed = RICH_ATTRS.get('*', set()) | RICH_ATTRS.get(name, set())
        for key, val in attrs:
            key = (key or '').lower()
            if key.startswith('on') or key not in allowed or val is None:
                continue
            text = str(val).strip()
            if key == 'style':
                text = _rich_safe_style(text)
            elif key in ('href', 'src'):
                if not _rich_safe_url(text, key == 'src'):
                    continue
            elif key in ('colspan', 'rowspan', 'width', 'height', 'border',
                         'cellpadding', 'cellspacing', 'size'):
                if not re.match(r'^\d{1,4}(%|px|pt)?$', text, re.I):
                    continue
            elif key in ('align', 'valign', 'target', 'color', 'face'):
                if len(text) > 40:
                    continue
            if not text:
                continue
            piece.extend([' ', key, '="', html_lib.escape(text, quote=True), '"'])
        piece.append('>')
        html = ''.join(piece)
        # 没有合法 src 的 <img> 直接丢弃，避免留下空图占位或外部追踪
        if name == 'img' and ' src=' not in html:
            return
        self.out.append(html)
        if name not in RICH_VOID:
            self.stack.append(name)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if (tag or '').lower() not in RICH_VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        name = (tag or '').lower()
        if name in RICH_DROP_CONTENT:
            if self.hidden:
                self.hidden -= 1
            return
        if self.hidden or self._drop(name) or name not in RICH_TAGS or name in RICH_VOID:
            return
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i] == name:
                while len(self.stack) > i:
                    self.out.append('</%s>' % self.stack.pop())
                return

    def handle_data(self, data):
        if not self.hidden:
            self.out.append(html_lib.escape(data, quote=False))

    def handle_comment(self, data):
        pass

    def result(self):
        while self.stack:
            self.out.append('</%s>' % self.stack.pop())
        return ''.join(self.out)


def sanitize_rich_html(value, limit=PROJECT_DESC_MAX):
    """保存前统一清洗：返回可安全回显到 contenteditable 的 HTML 片段"""
    text = '' if value is None else str(value)
    if len(text) > limit * 2:
        text = text[:limit * 2]
    cleaner = _RichHTMLCleaner()
    try:
        cleaner.feed(text)
        cleaner.close()
        out = cleaner.result()
    except Exception:
        return html_lib.escape(text[:limit])
    if len(out) > limit:
        cut = _RichHTMLCleaner()
        try:
            cut.feed(out[:limit])
            cut.close()
            out = cut.result()
        except Exception:
            out = out[:limit]
    return out.strip()


def rich_html_text(value, limit=200):
    """HTML → 纯文本摘要，供列表 title / 搜索结果预览使用（避免把标签塞进属性）"""
    text = re.sub(r'<(?:br|/p|/div|/li|/h[1-6]|/tr|/td)\b[^>]*>', '\n',
                  '' if value is None else str(value), flags=re.I)
    text = re.sub(r'<[^>]+>', '', text)
    text = html_lib.unescape(text)
    text = re.sub(r'[ \t\r\f\v]+', ' ', text)
    text = re.sub(r'\n\s*\n+', '\n', text).strip().replace('\n', ' ')
    return text[:limit]


# ---------------- Word（OOXML）解析 ----------------
def _xname(tag):
    return tag.rsplit('}', 1)[-1] if isinstance(tag, str) else ''


def _xattr(el, name):
    if el is None:
        return None
    for key, val in (el.attrib or {}).items():
        if _xname(key) == name:
            return val
    return None


def _xchild(el, name):
    if el is None:
        return None
    for child in list(el):
        if _xname(child.tag) == name:
            return child
    return None


def _xchildren(el, name):
    return [c for c in list(el or []) if _xname(c.tag) == name]


def _docx_run(run, state):
    """w:r → HTML：粗体 / 斜体 / 下划线 / 颜色 / 字号 / 上标下标 / 换行 / 制表符"""
    rpr = _xchild(run, 'rPr')
    styles = []
    if rpr is not None:
        if _xchild(rpr, 'b') is not None:
            styles.append('font-weight:bold')
        if _xchild(rpr, 'i') is not None:
            styles.append('font-style:italic')
        if _xchild(rpr, 'u') is not None:
            styles.append('text-decoration:underline')
        if _xchild(rpr, 'strike') is not None or _xchild(rpr, 'dstrike') is not None:
            styles.append('text-decoration:line-through')
        color = _xattr(_xchild(rpr, 'color'), 'val')
        if color and re.match(r'^[0-9A-Fa-f]{6}$', color):
            styles.append('color:#' + color)
        sz = _xattr(_xchild(rpr, 'sz'), 'val')
        if sz and sz.isdigit() and 4 <= int(sz) <= 160:
            styles.append('font-size:%gpt' % (int(sz) / 2.0))
        vert = (_xattr(_xchild(rpr, 'vertAlign'), 'val') or '').lower()
        if vert == 'superscript':
            styles.append('vertical-align:super')
        elif vert == 'subscript':
            styles.append('vertical-align:sub')
    inner = []
    for node in list(run):
        name = _xname(node.tag)
        if name == 't':
            inner.append(html_lib.escape(node.text or '', quote=False))
        elif name == 'br':
            inner.append('<br>')
        elif name == 'tab':
            inner.append('&nbsp;&nbsp;&nbsp;&nbsp;')
        elif name == 'noBreakHyphen':
            inner.append('-')
        elif name in ('drawing', 'pict', 'object'):
            state['images'] += 1
    text = ''.join(inner)
    if not text:
        return ''
    if styles:
        return '<span style="%s">%s</span>' % (';'.join(styles), text)
    return text


def _docx_paragraph(p, state):
    ppr = _xchild(p, 'pPr')
    align, heading, bullet = '', 0, False
    if ppr is not None:
        jc = _xattr(_xchild(ppr, 'jc'), 'val') or ''
        align = {'center': 'center', 'right': 'right', 'both': 'justify',
                 'left': 'left'}.get(jc.lower(), '')
        style = (_xattr(_xchild(ppr, 'pStyle'), 'val') or '').lower()
        m = re.match(r'^(?:heading|h)([1-6])$', style)
        if m:
            heading = int(m.group(1))
        elif style in ('title', 'subtitle'):
            heading = 1
        bullet = _xchild(ppr, 'numPr') is not None
    parts = []
    for run in _xchildren(p, 'r'):
        parts.append(_docx_run(run, state))
    for link in _xchildren(p, 'hyperlink'):
        for run in _xchildren(link, 'r'):
            parts.append(_docx_run(run, state))
    inner = ''.join(parts)
    state['paragraphs'] += 1
    styles = []
    if align:
        styles.append('text-align:' + align)
    if bullet:
        styles.append('margin-left:24px')
        inner = '• ' + inner
    tag = ('h%d' % heading) if heading else 'p'
    attr = (' style="%s"' % ';'.join(styles)) if styles else ''
    return '<%s%s>%s</%s>' % (tag, attr, inner or '<br>', tag)


def _docx_table(tbl, state):
    rows = []
    for tr in _xchildren(tbl, 'tr'):
        cells = []
        for tc in _xchildren(tr, 'tc'):
            body = ''.join(_docx_paragraph(p, state) for p in _xchildren(tc, 'p'))
            cells.append('<td>%s</td>' % (body or '<br>'))
        if cells:
            rows.append('<tr>%s</tr>' % ''.join(cells))
    if not rows:
        return ''
    return ('<table border="1" style="border-collapse:collapse;width:100%">'
            + ''.join(rows) + '</table>')


def docx_to_html(blob):
    """解析 docx（OOXML zip）→ 清洗后的 HTML；返回 (html, meta)"""
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            names = zf.namelist()
            if 'word/document.xml' not in names:
                raise BizError('不是有效的 Word 文档（缺少 word/document.xml），请先另存为 .docx')
            xml = zf.read('word/document.xml')
    except BizError:
        raise
    except Exception:
        raise BizError('Word 文件已损坏或不是 .docx 格式，请另存为 .docx 后重试')
    try:
        root = ET.fromstring(xml)
    except Exception:
        raise BizError('Word 正文 XML 解析失败，请确认文件由 Word / WPS 正常保存')
    body = _xchild(root, 'body')
    if body is None:
        raise BizError('Word 文档没有正文内容')
    state = {'paragraphs': 0, 'images': 0}
    parts = []
    for node in list(body):
        name = _xname(node.tag)
        if name == 'p':
            parts.append(_docx_paragraph(node, state))
        elif name == 'tbl':
            parts.append(_docx_table(node, state))
    html = sanitize_rich_html(''.join(parts))
    return html, {'paragraphs': state['paragraphs'], 'imagesSkipped': state['images']}

# 静态根（app.py 的 WEB_ROOT）：文件实体落在 <WEB_ROOT>/data/projectfiles/<YYYYMM>/
WEB_ROOT_LOCAL = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
PROJECT_FILE_ROOT = os.path.join(WEB_ROOT_LOCAL, 'data', 'projectfiles')
# 即时对话附件实体落盘目录：<WEB_ROOT>/data/imfiles/<YYYYMM>/<uuid>.<ext>
#   · 与项目文件分开存放，互不影响清理策略；Flask 静态根即 WEB_ROOT，
#     因此库里存的 'data/imfiles/...' 直接就是可访问的 URL（同源）。
IM_FILE_ROOT = os.path.join(WEB_ROOT_LOCAL, 'data', 'imfiles')
IM_FILE_MAX_BYTES = 20 * 1024 * 1024          # 单个附件上限 20 MB（图片 / 文件共用）
IM_IMAGE_EXTS = ('png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp')
# 在线预览支持的 Office 扩展名（与 preview_convert.CONVERT_EXTS 保持一致）
PREVIEW_CONVERT_EXTS = ('doc', 'docm', 'docx', 'ppt', 'pptm', 'pptx')


class ProjectBaseService(object):
    """
    项目信息 / 项目文件共用的 CRUD 骨架（UUID 主键）
      · 列表 / 详情 / 下拉 / 下载统一按「本人创建 OR 公用」过滤（_visibility_where）；
      · 子类只需给出表名、归属人字段、关键字字段、唯一字段、检索附加条件与保存字段归一化；
      · 拿不到登录上下文（内部调用 / 迁移脚本）时不过滤，保持与 dbinfo 一致的行为。
    """

    table = ''
    label = ''
    owner_field = 'createempinfosid'
    owner_name_field = 'createEname'
    keyword_fields = ()
    unique_fields = ()
    stats_field = ''
    ORDER_BY = '`createTime` DESC, `id` ASC'
    LOGIN_SQL = ('SELECT u.`account`, u.`empId` AS `empId`, e.`nameCn` AS `empName` '
                 'FROM `useinfo` u LEFT JOIN `empinfos` e ON e.`id`=u.`empId` '
                 'WHERE u.`id`=%s LIMIT 1')

    # ---------------- 小工具 ----------------
    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _bool_of(value, default=False):
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ('1', 'true', 'yes', 'on')

    @staticmethod
    def _int_of(value, default=0):
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _uuid_of(value):
        text = ProjectBaseService._text(value).lower()
        if not text:
            raise BizError('参数 id 不能为空（应为 UUID）')
        if not RE_UUID.match(text):
            raise BizError('参数 id 不合法（应为 UUID）')
        return text

    @staticmethod
    def _size_text(size):
        num = float(size or 0)
        for unit in ('B', 'KB', 'MB', 'GB'):
            if num < 1024 or unit == 'GB':
                return ('%d B' % int(num)) if unit == 'B' else ('%.1f %s' % (num, unit))
            num /= 1024.0
        return '%d B' % int(size or 0)

    # ---------------- 登录人 ----------------
    def _login_user(self, params):
        """token → useinfo → empinfos，取员工ID + 姓名（取不到姓名退回账号）"""
        user_id = self._text((params or {}).get('_loginUserId'))
        if not user_id:
            return {'empId': None, 'ename': ''}
        try:
            row = query_one(self.LOGIN_SQL, (user_id,))
        except Exception:
            row = None
        if not row:
            return {'empId': None, 'ename': ''}
        emp_id = self._int_of(row.get('empId'), 0)
        return {'empId': emp_id or None,
                'ename': (self._text(row.get('empName')) or self._text(row.get('account')))[:100]}

    def _login_emp_id(self, params):
        """归属人员工ID；没有登录上下文时才退回调用方显式传的归属人ID"""
        params = params or {}
        emp_id = self._login_user(params).get('empId')
        if emp_id:
            return emp_id
        return self._int_of(params.get(self.owner_field), 0) or None

    def _stamp_create(self, picked, params):
        """新增时写入归属人（创建人 / 上传人），编辑时不覆盖"""
        user = self._login_user(params)
        picked[self.owner_field] = user.get('empId')
        if self.owner_name_field:
            picked[self.owner_name_field] = user.get('ename') or None
        return picked

    # ---------------- 可见性 / 检索 ----------------
    def _visibility_where(self, params):
        """只加载「当前用户创建」+「其他用户标为公用」的记录"""
        emp_id = self._login_emp_id(params)
        if not emp_id:
            return '', []
        return ' (`%s`=%%s OR `ispub`=1)' % self.owner_field, [emp_id]

    def _extra_where(self, params):
        """子类追加自己的筛选条件，返回 (sql, args)；sql 可为空"""
        return '', []

    def _build_where(self, params):
        params = params or {}
        where, args = [], []
        vis_sql, vis_args = self._visibility_where(params)
        if vis_sql:
            where.append(vis_sql)
            args.extend(vis_args)
        keyword = self._text(params.get('keyword'))
        if keyword and self.keyword_fields:
            like = '%' + keyword + '%'
            where.append('(' + ' OR '.join('`%s` LIKE %%s' % f for f in self.keyword_fields) + ')')
            args.extend([like] * len(self.keyword_fields))
        extra_sql, extra_args = self._extra_where(params)
        if extra_sql:
            where.append(extra_sql)
            args.extend(extra_args)
        for field in ('enabled', 'ispub'):
            value = params.get(field)
            if value is not None and str(value).strip() != '':
                where.append('`%s`=%%s' % field)
                args.append(1 if self._bool_of(value) else 0)
        return (' WHERE ' + ' AND '.join(where)) if where else '', args

    def _find(self, uid, params=None, visible=True):
        """按 ID 取一条；默认带可见性过滤（详情 / 下载也要遵守「本人 + 公用」）"""
        where, args = ' WHERE `id`=%s', [uid]
        if visible:
            vis_sql, vis_args = self._visibility_where(params or {})
            if vis_sql:
                where += ' AND ' + vis_sql.strip()
                args.extend(vis_args)
        row = query_one('SELECT * FROM `%s`%s LIMIT 1' % (self.table, where), args)
        if not row:
            raise BizError(self.label + '不存在或已被删除', 404)
        return row

    # ---------------- 展示字段 ----------------
    def _attach(self, items):
        for it in items:
            it['enabled'] = bool(int(it.get('enabled') or 0))
            it['ispub'] = bool(int(it.get('ispub') if it.get('ispub') is not None else 1))
            it['ispubText'] = '公用' if it['ispub'] else '私有'
            it[self.owner_field] = int(it.get(self.owner_field) or 0)
            for field in ('createTime', 'updateTime', 'uploadTime'):
                if field in it:
                    it[field] = it.get(field) or ''
        return items

    def _stats(self, where, args):
        """分类计数与列表同口径（先过可见性再统计，避免下拉出现「0 条」类型）"""
        if not self.stats_field:
            return {}
        rows = query_all('SELECT `%s` AS k, COUNT(*) AS n FROM `%s`%s GROUP BY `%s`'
                         % (self.stats_field, self.table, where, self.stats_field), args)
        out = {}
        for row in (rows or []):
            out[str(row.get('k') or '')] = int(row.get('n') or 0)
        return out

    # ---------------- 读 ----------------
    def _order_by(self, params):
        """排序钩子：子类可按 params 覆写（如项目文件右栏列表按文件名排序）"""
        return self.ORDER_BY

    def page(self, params):
        params = params or {}
        where, args = self._build_where(params)
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 10), 1), 200)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        row = query_one('SELECT COUNT(*) AS n FROM `%s`%s' % (self.table, where), args)
        total = int(row['n']) if row and row.get('n') is not None else 0
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        rows = query_all('SELECT * FROM `%s`%s ORDER BY %s LIMIT %%s OFFSET %%s'
                         % (self.table, where, self._order_by(params)),
                         args + [page_size, (page_num - 1) * page_size])
        return {'list': self._attach([dump_row(r) for r in rows]),
                'total': total, 'pageNum': page_num, 'pageSize': page_size,
                'pages': pages, 'stats': self._stats(where, args)}

    def detail(self, params):
        uid = self._uuid_of((params or {}).get('id'))
        return self._attach([dump_row(self._find(uid, params))])[0]

    def check(self, params):
        """唯一性校验（项目名称 / 项目编号）"""
        field = self._text((params or {}).get('field')) or (
            self.unique_fields[0][0] if self.unique_fields else '')
        if field not in [f for f, _ in self.unique_fields]:
            raise BizError('不支持的唯一性校验字段：' + field)
        value = self._text((params or {}).get('value'))
        if not value:
            return {'unique': True}
        self_id = self._text((params or {}).get('id'))
        row = query_one('SELECT `id` FROM `%s` WHERE `%s`=%%s AND `id`<>%%s LIMIT 1'
                        % (self.table, field), (value, self_id))
        return {'unique': row is None}

    # ---------------- 写 ----------------
    def _assert_unique(self, picked, self_id=''):
        for field, name in self.unique_fields:
            value = self._text(picked.get(field))
            if not value:
                continue
            row = query_one('SELECT `id` FROM `%s` WHERE `%s`=%%s AND `id`<>%%s LIMIT 1'
                            % (self.table, field), (value, self_id))
            if row:
                raise BizError(name + '【' + value + '】已存在，请换一个')

    def _normalize(self, data, current, params):
        raise NotImplementedError

    def add(self, data):
        data = dict(data or {})
        picked = self._normalize(data, None, data)
        self._assert_unique(picked)
        picked['id'] = str(uuid.uuid4())
        self._stamp_create(picked, data)
        columns = ','.join('`%s`' % c for c in picked.keys())
        holders = ','.join(['%s'] * len(picked))
        try:
            execute('INSERT INTO `%s` (%s) VALUES (%s)' % (self.table, columns, holders),
                    list(picked.values()))
        except DuplicateError:
            raise BizError(self.label + '已存在，请重新填写')
        return self._attach([dump_row(self._find(picked['id'], data, visible=False))])[0]

    def update(self, data):
        data = dict(data or {})
        uid = self._uuid_of(data.get('id'))
        current = self._find(uid, data, visible=False)
        picked = self._normalize(data, current, data)
        self._assert_unique(picked, uid)
        assignments = ','.join('`%s`=%%s' % c for c in picked.keys())
        try:
            execute('UPDATE `%s` SET %s WHERE `id`=%%s' % (self.table, assignments),
                    list(picked.values()) + [uid])
        except DuplicateError:
            raise BizError(self.label + '已存在，请重新填写')
        return self._attach([dump_row(self._find(uid, data, visible=False))])[0]

    def delete(self, data):
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        row = self._find(uid, data, visible=False)
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.table, (uid,))
        return self._attach([dump_row(row)])[0]

    def enabled(self, data):
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        row = self._find(uid, data, visible=False)
        on = 1 if self._bool_of(data.get('enabled', 1), True) else 0
        execute('UPDATE `%s` SET `enabled`=%%s WHERE `id`=%%s' % self.table, (on, uid))
        item = self._attach([dump_row(self._find(uid, data, visible=False))])[0]
        item['message'] = '%s「%s」已%s' % (self.label, row.get(self.name_field), '启用' if on else '停用')
        return item

    name_field = 'projectName'


class ProjectInfoService(ProjectBaseService):
    """项目信息（projectinfos）：编号自动生成 PRO + 6 位流水号，删除时级联清理项目文件"""

    table = 'projectinfos'
    label = '项目'
    owner_field = 'createempinfosid'
    owner_name_field = 'createEname'
    name_field = 'projectName'
    keyword_fields = ('projectCode', 'projectName', 'projectDesc', 'createEname')
    unique_fields = (('projectName', '项目名称'), ('projectCode', '项目编号'))
    stats_field = 'projectType'
    ORDER_BY = '`enabled` DESC, `createTime` DESC, `projectCode` ASC'

    # ---------------- 检索 ----------------
    def _extra_where(self, params):
        where, args = [], []
        for field in ('projectType', 'projectStatus'):
            values = [x.strip() for x in self._text((params or {}).get(field)).split(',') if x.strip()]
            if values:
                where.append('`%s` IN (%s)' % (field, ','.join(['%s'] * len(values))))
                args.extend(values)
        return (' AND '.join(where), args)

    # ---------------- 展示 ----------------
    def _attach(self, items):
        out = ProjectBaseService._attach(self, items)
        for it in out:
            it['projectType'] = it.get('projectType') or '其它'
            it['projectStatus'] = it.get('projectStatus') or '未开始'
            it['projectDesc'] = it.get('projectDesc') or ''
            it['projectDescText'] = rich_html_text(it['projectDesc'], 200)
            it['createEname'] = it.get('createEname') or ''
            try:
                row = query_one('SELECT COUNT(*) AS n FROM `projectfiles` WHERE `projectId`=%s',
                                (it.get('id'),))
                it['fileCount'] = int(row['n']) if row else 0
            except Exception:
                it['fileCount'] = 0
        return out

    # ---------------- 编号 ----------------
    def _next_code_value(self):
        """扫描已有 PRO + 6 位数字编号，取最大流水 +1；被占用则顺延"""
        pattern = '^%s[0-9]{%d}$' % (PROJECT_CODE_PREFIX, PROJECT_CODE_DIGITS)
        rows = query_all('SELECT `projectCode` FROM `%s` WHERE `projectCode` REGEXP %%s'
                         % self.table, (pattern,))
        max_seq = 0
        for row in (rows or []):
            code = self._text(row.get('projectCode'))
            try:
                seq = int(code[len(PROJECT_CODE_PREFIX):])
            except (TypeError, ValueError):
                continue
            if seq > max_seq:
                max_seq = seq
        seq = max_seq + 1
        while seq <= PROJECT_CODE_MAX:
            code = '%s%0*d' % (PROJECT_CODE_PREFIX, PROJECT_CODE_DIGITS, seq)
            hit = query_one('SELECT `id` FROM `%s` WHERE `projectCode`=%%s LIMIT 1'
                            % self.table, (code,))
            if not hit:
                return code
            seq += 1
        raise BizError('项目编号已超出上限（PRO%06d），请联系管理员' % PROJECT_CODE_MAX)

    def next_code(self, params=None):
        return {'code': self._next_code_value()}

    def types(self, params=None):
        """项目类型 / 项目状态字典（前端下拉与检索条件共用一套枚举）

        项目类型取自系统字典 `project_type` 的启用键值（按 sortNo 升序），字典缺失时
        回落到内置枚举；typeSource 供前端 / 测试区分数据来源。
        """
        values, source = project_type_dict()
        return {'types': values, 'statuses': list(PROJECT_STATUSES),
                'typeSource': source, 'typeDictNameEn': PROJECT_TYPE_DICT}

    def import_doc(self, params=None):
        """Word 文档导入：浏览器不支持本地解压时，由服务端解析 .docx → 安全 HTML。

        入参 {data: base64 或 data URL, fileName}；返回 {html, text, paragraphs,
        imagesSkipped, fileName, message}。前端 js/word-import.js 优先本地解析，
        失败才回落到这个接口，因此离线 Mock 通道也能正常导入 Word 文档。
        """
        params = params or {}
        raw = self._text(params.get('data'))
        file_name = self._text(params.get('fileName')) or 'document.docx'
        low = file_name.lower()
        if low.endswith('.doc'):
            raise BizError('旧版 .doc 不支持直接导入，请在 Word / WPS 中另存为 .docx 后重试')
        if not low.endswith(('.docx', '.docm')):
            raise BizError('只支持 .docx / .docm 格式的 Word 文档')
        if raw[:5].lower() == 'data:':
            raw = raw.split(',', 1)[1] if ',' in raw else ''
        raw = re.sub(r'\s+', '', raw)
        if not raw:
            raise BizError('请先选择要导入的 Word 文档')
        try:
            blob = base64.b64decode(raw, validate=True)
        except Exception:
            raise BizError('Word 文档内容不是有效的 base64 数据，请重新选择 .docx 文件')
        if len(blob) > PROJECT_FILE_MAX_BYTES:
            raise BizError('Word 文档不能超过 %d MB' % (PROJECT_FILE_MAX_BYTES // (1024 * 1024)))
        html, meta = docx_to_html(blob)
        if not html:
            raise BizError('Word 文档里没有可导入的文字内容')
        return {
            'html': html,
            'text': rich_html_text(html, 1000),
            'paragraphs': meta['paragraphs'],
            'imagesSkipped': meta['imagesSkipped'],
            'fileName': file_name,
            'message': '已导入「%s」（%d 个段落%s）' % (
                file_name, meta['paragraphs'],
                '，跳过 %d 处图片' % meta['imagesSkipped'] if meta['imagesSkipped'] else '')
        }

    def options(self, params=None):
        """项目下拉（项目文件页用）：只给可见 + 启用的项目"""
        params = params or {}
        where, args = self._build_where(params)
        where = (where + ' AND `enabled`=1') if where else ' WHERE `enabled`=1'
        keyword = self._text(params.get('keyword'))
        if keyword:
            where += ' AND (`projectCode` LIKE %s OR `projectName` LIKE %s)'
            like = '%' + keyword + '%'
            args = list(args) + [like, like]
        rows = query_all('SELECT `id`,`projectCode`,`projectName`,`projectType`,`ispub` '
                         'FROM `%s`%s ORDER BY `projectCode` ASC LIMIT 200' % (self.table, where), args)
        out = []
        for row in (rows or []):
            item = dump_row(row)
            item['label'] = '%s %s' % (item.get('projectCode') or '', item.get('projectName') or '')
            out.append(item)
        return {'list': out}

    # ---------------- 保存 ----------------
    def _normalize(self, data, current, params):
        current = current or {}
        name = self._text(data.get('projectName')) or self._text(current.get('projectName'))
        if not name:
            raise BizError('项目名称不能为空')
        if len(name) > 150:
            raise BizError('项目名称最多 150 个字符')
        ptype = (self._text(data.get('projectType')) or self._text(current.get('projectType'))
                 or '其它')
        # 合法值 = 字典里启用的键值；再并入该记录原有的类型，保证字典调整（改名 / 停用 /
        # 删项）后，老项目不改类型仍能正常保存，不会因为“类型不在下拉里”被卡住。
        allowed = project_type_dict()[0]
        legacy = self._text(current.get('projectType'))
        if legacy and legacy not in allowed:
            allowed = allowed + [legacy]
        if ptype not in allowed:
            raise BizError('不支持的项目类型：' + ptype)
        status = (self._text(data.get('projectStatus')) or self._text(current.get('projectStatus'))
                  or '未开始')
        if status not in PROJECT_STATUSES:
            raise BizError('不支持的项目状态：' + status)
        picked = {
            'projectType': ptype,
            'projectName': name,
            # 富文本 HTML：保存前统一按标签 / 属性 / CSS 白名单清洗，长度上限由清洗函数兜住，
            # 避免绕过页面直接调接口写入脚本，也避免 Word 长文档撑爆字段。
            'projectDesc': (sanitize_rich_html(self._text(data.get('projectDesc')))
                            if 'projectDesc' in data
                            else self._text(current.get('projectDesc'))) or None,
            'projectStatus': status,
            'ispub': 1 if self._bool_of(data.get('ispub', current.get('ispub')), True) else 0,
            'enabled': 1 if self._bool_of(data.get('enabled', current.get('enabled')), True) else 0,
        }
        if current.get('id'):
            picked['projectCode'] = current.get('projectCode')     # 编号一经生成不可改
        else:
            picked['projectCode'] = self._next_code_value()        # 强制后端自动生成
        return picked

    def add(self, data):
        # 编号一律由后端生成（忽略前端传值，避免伪造 / 重号）
        payload = dict(data or {})
        payload.pop('projectCode', None)
        return ProjectBaseService.add(self, payload)

    def update(self, data):
        payload = dict(data or {})
        payload.pop('projectCode', None)
        return ProjectBaseService.update(self, payload)

    def delete(self, data):
        """删除项目时级联清理其项目目录与项目文件（数据库记录 + 磁盘实体）"""
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        row = self._find(uid, data, visible=False)
        files = query_all('SELECT `filePath` FROM `projectfiles` WHERE `projectId`=%s', (uid,))
        dirs = query_all('SELECT `id` FROM `projectdirs` WHERE `projectId`=%s', (uid,))
        execute('DELETE FROM `projectfiles` WHERE `projectId`=%s', (uid,))
        execute('DELETE FROM `projectdirs` WHERE `projectId`=%s', (uid,))
        execute('DELETE FROM `projectinfos` WHERE `id`=%s', (uid,))
        for one in (files or []):
            ProjectFileService.unlink_file(one.get('filePath'))
        out = self._attach([dump_row(row)])[0]
        out['deletedFiles'] = len(files or [])
        out['deletedDirs'] = len(dirs or [])
        out['message'] = '项目「%s」已删除（同时清理 %d 个目录、%d 个文件）' % (
            row.get('projectName'), len(dirs or []), len(files or []))
        return out


PROJECT_DIR_MAX_LEVEL = 8


class ProjectDirService(ProjectBaseService):
    """项目目录（projectdirs）：按项目归属的多级文件夹

    · parentId 自关联，空表示项目根目录下的第一级；
    · 树形输出（tree）供「上传选目录」「编辑上级目录」「目录树标签页」共用；
    · 删除目录不删业务数据：子目录升到被删目录的父级、文件 dirId 置空回到项目根；
    · 防自身 / 防环 / 防层级过深 / 同级同名，均在 _normalize 里统一校验。
    """

    table = 'projectdirs'
    label = '项目目录'
    owner_field = 'createempinfosid'
    owner_name_field = 'createEname'
    name_field = 'dirName'
    keyword_fields = ('dirName', 'dirDesc')
    unique_fields = ()          # 同名校验是「同项目 + 同上级」，不是全表唯一
    ORDER_BY = '`dirName` ASC, `id` ASC'

    # ---------------- 检索 ----------------
    def _extra_where(self, params):
        where, args = [], []
        project_id = self._text((params or {}).get('projectId'))
        if project_id:
            where.append('`projectId`=%s')
            args.append(project_id)
        parent_id = self._text((params or {}).get('parentId'))
        if parent_id == 'root':
            where.append("(`parentId` IS NULL OR `parentId`='')")
        elif parent_id:
            where.append('`parentId`=%s')
            args.append(parent_id)
        return (' AND '.join(where), args)

    def _project_of(self, project_id, params):
        """所属项目必须存在且对当前用户可见（与项目文件同一口径）"""
        uid = self._uuid_of(project_id)
        vis_sql, vis_args = ProjectInfoService()._visibility_where(params or {})
        row = query_one('SELECT `id`,`projectCode`,`projectName` FROM `projectinfos` '
                        'WHERE `id`=%%s%s LIMIT 1'
                        % ((' AND ' + vis_sql.strip()) if vis_sql else ''), [uid] + vis_args)
        if not row:
            raise BizError('所属项目不存在、或不是你创建 / 标为公用的项目', 404)
        return dump_row(row)

    # ---------------- 展示 ----------------
    def _attach(self, items):
        out = ProjectBaseService._attach(self, items)
        if not out:
            return out
        pids = sorted(set(str(it.get('projectId') or '') for it in out))
        pmap = {}
        if pids:
            holders = ','.join(['%s'] * len(pids))
            rows = query_all('SELECT `id`,`parentId`,`dirName` FROM `projectdirs` '
                             'WHERE `projectId` IN (%s)' % holders, pids) or []
            for row in rows:
                one = dump_row(row)
                pmap[str(one.get('id'))] = one
        child_count = {}
        for one in pmap.values():
            key = self._text(one.get('parentId'))
            child_count[key] = child_count.get(key, 0) + 1
        counts = query_all('SELECT `dirId`, COUNT(*) AS n FROM `projectfiles` '
                           'WHERE `dirId` IS NOT NULL GROUP BY `dirId`') or []
        cmap = {}
        for row in counts:
            cmap[str(row.get('dirId'))] = int(row.get('n') or 0)
        for it in out:
            pid = self._text(it.get('parentId'))
            it['parentId'] = pid
            it['dirDesc'] = it.get('dirDesc') or ''
            parent = pmap.get(pid)
            it['parentName'] = (parent.get('dirName') or '') if parent else ''
            level, cur, guard = 1, pid, 0
            while cur and cur in pmap and guard < PROJECT_DIR_MAX_LEVEL + 2:
                level += 1
                cur = self._text(pmap[cur].get('parentId'))
                guard += 1
            it['level'] = level
            it['childCount'] = child_count.get(str(it.get('id')), 0)
            it['fileCount'] = cmap.get(str(it.get('id')), 0)
        return out

    # ---------------- 树（上传选目录 / 上级下拉 / 目录树视图共用） ----------------
    def tree(self, params=None):
        """返回某项目下的目录树（深度优先扁平列表，label 带层级缩进）

        · projectId 必填；excludeId 排除自身与全部后代（编辑目录时选上级用）；
        · 只返回当前用户可见的目录；父目录不可见的目录按根级展示，不会丢节点。
        """
        params = params or {}
        project_id = self._text(params.get('projectId'))
        if not project_id:
            raise BizError('参数 projectId 不能为空')
        project_id = self._uuid_of(project_id)
        self._project_of(project_id, params)
        vis_sql, vis_args = self._visibility_where(params)
        rows = query_all('SELECT * FROM `projectdirs` WHERE `projectId`=%%s%s '
                         'ORDER BY `dirName` ASC, `id` ASC'
                         % ((' AND ' + vis_sql.strip()) if vis_sql else ''),
                         [project_id] + vis_args) or []
        all_rows = [dump_row(r) for r in rows]
        pmap = dict((str(one.get('id')), one) for one in all_rows)
        banned = set()
        exclude_id = self._text(params.get('excludeId'))
        if exclude_id:
            banned.add(exclude_id)
            stack = [exclude_id]
            while stack:
                cur = stack.pop()
                for one in all_rows:
                    uid = str(one.get('id'))
                    if self._text(one.get('parentId')) == cur and uid not in banned:
                        banned.add(uid)
                        stack.append(uid)
        children = {}
        for one in all_rows:
            children.setdefault(self._text(one.get('parentId')), []).append(one)
        for key in children:
            children[key].sort(key=lambda x: (str(x.get('dirName') or ''), str(x.get('id'))))
        counts = query_all('SELECT `dirId`, COUNT(*) AS n FROM `projectfiles` '
                           'WHERE `dirId` IS NOT NULL GROUP BY `dirId`') or []
        cmap = dict((str(r.get('dirId')), int(r.get('n') or 0)) for r in counts)
        out, seen = [], set()

        def walk(node, level):
            uid = str(node.get('id'))
            if uid in seen or uid in banned:
                return
            seen.add(uid)
            name = self._text(node.get('dirName'))
            out.append({
                'id': uid,
                'projectId': self._text(node.get('projectId')),
                'parentId': self._text(node.get('parentId')),
                'dirName': name,
                'dirDesc': self._text(node.get('dirDesc')),
                'ispub': bool(int(node.get('ispub') if node.get('ispub') is not None else 1)),
                'enabled': bool(int(node.get('enabled') or 0)),
                'level': level,
                'leaf': not children.get(uid),
                'childCount': len(children.get(uid, [])),
                'fileCount': cmap.get(uid, 0),
                'label': ('　' * (level - 1)) + ('└ ' if level > 1 else '') + name
            })
            for kid in children.get(uid, []):
                walk(kid, level + 1)

        roots = [one for one in all_rows
                 if (self._text(one.get('parentId')) or '') not in pmap]
        for one in roots:
            walk(one, 1)
        for one in all_rows:                 # 兜底：环 / 悬空父节点也要能被看到
            if str(one.get('id')) not in seen:
                walk(one, 1)
        return {'list': out, 'total': len(out), 'projectId': project_id}

    # ---------------- 保存 ----------------
    def _normalize(self, data, current, params):
        current = current or {}
        project = self._project_of(
            self._text(data.get('projectId')) or self._text(current.get('projectId')), params)
        name = self._text(data.get('dirName')) or self._text(current.get('dirName'))
        if not name:
            raise BizError('目录名不能为空')
        if len(name) > 150:
            raise BizError('目录名最多 150 个字符')
        parent = (self._text(data.get('parentId')) if 'parentId' in data
                  else self._text(current.get('parentId')))
        self_id = self._text(current.get('id'))
        all_rows = query_all('SELECT `id`,`parentId` FROM `projectdirs` WHERE `projectId`=%s',
                             (project['id'],)) or []
        by_id = dict((str(r.get('id')), dump_row(r)) for r in all_rows)
        if parent:
            parent = self._uuid_of(parent)
            if parent == self_id:
                raise BizError('上级目录不能是自己')
            if parent not in by_id:
                raise BizError('上级目录不存在或已被删除', 404)
            if self_id:                      # 防环：新上级不能是自己的后代
                stack, banned = [self_id], set()
                while stack:
                    cur = stack.pop()
                    for one in by_id.values():
                        uid = str(one.get('id'))
                        if self._text(one.get('parentId')) == cur and uid not in banned:
                            banned.add(uid)
                            stack.append(uid)
                if parent in banned:
                    raise BizError('上级目录不能是自己的子目录')
            depth, cur, guard = 1, parent, 0
            while cur and cur in by_id and guard < PROJECT_DIR_MAX_LEVEL + 2:
                depth += 1
                cur = self._text(by_id[cur].get('parentId'))
                guard += 1
            if depth >= PROJECT_DIR_MAX_LEVEL:
                raise BizError('目录层级不能超过 %d 层' % PROJECT_DIR_MAX_LEVEL)
        # 同项目、同上级下目录名唯一（parentId 为空单独处理，NULL 不参与等值比较）
        sql = ('SELECT `id` FROM `projectdirs` WHERE `projectId`=%s AND `dirName`=%s '
               'AND `id`<>%s')
        args = [project['id'], name, self_id]
        if parent:
            sql += ' AND `parentId`=%s'
            args.append(parent)
        else:
            sql += " AND (`parentId` IS NULL OR `parentId`='')"
        if query_one(sql, args):
            raise BizError('同级下已存在目录【' + name + '】')
        return {
            'projectId': project['id'],
            'parentId': parent or None,
            'dirName': name,
            'dirDesc': (self._text(data.get('dirDesc'))[:500]
                        if 'dirDesc' in data else self._text(current.get('dirDesc'))) or None,
            'ispub': 1 if self._bool_of(data.get('ispub', current.get('ispub')), True) else 0,
            'enabled': 1 if self._bool_of(data.get('enabled', current.get('enabled')), True) else 0,
        }

    def delete(self, data):
        """只删目录本身：子目录上移一级，文件解除目录归属（绝不删文件）"""
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        row = self._find(uid, data, visible=False)
        parent = self._text(row.get('parentId'))
        _, moved_dirs = execute('UPDATE `projectdirs` SET `parentId`=%s WHERE `parentId`=%s',
                                (parent or None, uid))
        _, moved_files = execute('UPDATE `projectfiles` SET `dirId`=NULL WHERE `dirId`=%s', (uid,))
        execute('DELETE FROM `projectdirs` WHERE `id`=%s', (uid,))
        out = self._attach([dump_row(row)])[0]
        out['movedDirs'] = int(moved_dirs or 0)
        out['movedFiles'] = int(moved_files or 0)
        out['message'] = '目录「%s」已删除（%d 个子目录上移、%d 个文件回到项目根）' % (
            row.get('dirName'), int(moved_dirs or 0), int(moved_files or 0))
        return out


class ProjectFileService(ProjectBaseService):
    """项目文件（projectfiles）：base64 上传落到静态目录，下载直接走同源静态路由"""

    table = 'projectfiles'
    label = '项目文件'
    owner_field = 'uploadempinfosid'
    owner_name_field = 'uploadEname'
    name_field = 'fileName'
    keyword_fields = ('fileName', 'fileDesc', 'projectName', 'projectCode', 'uploadEname')
    unique_fields = ()          # 同一项目下允许同名文件（靠 UUID 区分）
    stats_field = 'fileType'
    ORDER_BY = '`enabled` DESC, `uploadTime` DESC, `id` ASC'

    def _order_by(self, params):
        """项目信息页右栏文件列表：orderBy=fileName 时按文件名升序（同文件名按 id 兜底）"""
        if (self._text((params or {}).get('orderBy')) or '').lower() == 'filename':
            return '`fileName` ASC, `id` ASC'
        return self.ORDER_BY

    # ---------------- 检索 ----------------
    def _extra_where(self, params):
        where, args = [], []
        project_id = self._text((params or {}).get('projectId'))
        if project_id:
            where.append('`projectId`=%s')
            args.append(project_id)
        file_types = [x.strip() for x in self._text((params or {}).get('fileType')).split(',') if x.strip()]
        if file_types:
            where.append('`fileType` IN (%s)' % ','.join(['%s'] * len(file_types)))
            args.extend(file_types)
        dir_id = self._text((params or {}).get('dirId'))
        if dir_id == 'root':
            where.append("(`dirId` IS NULL OR `dirId`='')")
        elif dir_id:
            where.append('`dirId`=%s')
            args.append(dir_id)
        return (' AND '.join(where), args)

    # ---------------- 展示 ----------------
    def _attach(self, items):
        out = ProjectBaseService._attach(self, items)
        dir_ids = sorted(set(self._text(it.get('dirId')) for it in out if self._text(it.get('dirId'))))
        dmap = {}
        if dir_ids:
            holders = ','.join(['%s'] * len(dir_ids))
            rows = query_all('SELECT `id`,`dirName` FROM `projectdirs` WHERE `id` IN (%s)' % holders,
                             dir_ids) or []
            dmap = dict((str(r.get('id')), self._text(r.get('dirName'))) for r in rows)
        for it in out:
            it['fileType'] = it.get('fileType') or '其它'
            it['fileDesc'] = it.get('fileDesc') or ''
            it['projectName'] = it.get('projectName') or ''
            it['projectCode'] = it.get('projectCode') or ''
            it['uploadEname'] = it.get('uploadEname') or ''
            it['fileSize'] = int(it.get('fileSize') or 0)
            it['fileSizeText'] = self._size_text(it['fileSize'])
            did = self._text(it.get('dirId'))
            it['dirId'] = did                       # 空字符串 = 直接关联项目（未选择目录）
            it['dirName'] = dmap.get(did, '')
            path = str(it.get('filePath') or '')
            it['downloadUrl'] = ('/' + path.lstrip('/')) if path else ''
            it['uploadTime'] = it.get('uploadTime') or it.get('createTime') or ''
        return out

    def types(self, params=None):
        return {'types': list(PROJECT_FILE_TYPES)}

    # ---------------- 文件实体 ----------------
    @staticmethod
    def unlink_file(rel_path):
        """删除磁盘文件：只允许删 data/projectfiles/ 下的路径，防止路径穿越"""
        path = str(rel_path or '')
        if not path.startswith('data/projectfiles/'):
            return
        try:
            full = os.path.abspath(os.path.join(WEB_ROOT_LOCAL, *path.split('/')))
            if full.startswith(PROJECT_FILE_ROOT) and os.path.isfile(full):
                os.remove(full)
        except OSError:
            pass

    def _decode_file(self, payload):
        """解析前端 FileReader 读出的 base64（允许带 data URL 前缀），返回 (文件名, 字节)"""
        name = os.path.basename(
            (self._text(payload.get('fileName')) or '').replace('\\', '/'))[:255]
        if not name:
            raise BizError('文件名不能为空，请重新选择文件')
        text = payload.get('data')
        if text is None:
            raise BizError('请选择要上传的文件')
        text = str(text)
        if ';base64,' in text[:200]:
            text = text.split(';base64,', 1)[1]
        text = re.sub(r'\s+', '', text)
        try:
            raw = base64.b64decode(text.encode('ascii'), validate=True) if text else b''
        except Exception:
            raise BizError('文件内容解析失败，请重新选择文件')
        if not raw:
            raise BizError('文件内容为空，请重新选择文件')
        if len(raw) > PROJECT_FILE_MAX_BYTES:
            raise BizError('文件不能超过 %d MB' % (PROJECT_FILE_MAX_BYTES // (1024 * 1024)))
        return name, raw

    def _write_file(self, name, raw):
        """写到 <WEB_ROOT>/data/projectfiles/<YYYYMM>/<UUID>.<ext>，返回相对静态根的路径"""
        ext = os.path.splitext(name)[1].lower().lstrip('.')
        ext = re.sub(r'[^0-9a-z]', '', ext)[:10]
        folder = datetime.datetime.now().strftime('%Y%m')
        directory = os.path.join(PROJECT_FILE_ROOT, folder)
        try:
            if not os.path.isdir(directory):
                os.makedirs(directory)
        except OSError:
            raise BizError('文件目录不可写，请联系管理员')
        filename = str(uuid.uuid4()) + ('.' + ext if ext else '')
        full = os.path.join(directory, filename)
        try:
            with open(full, 'wb') as fp:
                fp.write(raw)
        except OSError:
            raise BizError('文件写入失败，请联系管理员')
        return 'data/projectfiles/%s/%s' % (folder, filename)

    # ---------------- 保存 ----------------
    def _project_of(self, project_id, params):
        """所属项目必须存在且对当前用户可见（沿用项目表的可见性规则）"""
        uid = self._uuid_of(project_id)
        vis_sql, vis_args = ProjectInfoService()._visibility_where(params or {})
        row = query_one('SELECT * FROM `projectinfos` WHERE `id`=%%s%s LIMIT 1'
                        % ((' AND ' + vis_sql.strip()) if vis_sql else ''), [uid] + vis_args)
        if not row:
            raise BizError('所属项目不存在、或不是你创建 / 标为公用的项目', 404)
        return row

    def _normalize(self, data, current, params):
        current = current or {}
        project_id = self._text(data.get('projectId')) or self._text(current.get('projectId'))
        project = self._project_of(project_id, params)
        name = self._text(data.get('fileName')) or self._text(current.get('fileName'))
        if not name:
            raise BizError('文件名不能为空')
        path = self._text(data.get('filePath')) or self._text(current.get('filePath'))
        if not path:
            raise BizError('文件路径不能为空，请重新上传文件')
        ftype = (self._text(data.get('fileType')) or self._text(current.get('fileType')) or '其它')
        if ftype not in PROJECT_FILE_TYPES:
            raise BizError('不支持的文件类型：' + ftype)
        # 目录归属：显式传 dirId 则用新值，没传则沿用原值；空表示「不选择目录 = 直接关联项目」
        dir_id = (self._text(data.get('dirId')) if 'dirId' in data
                  else self._text(current.get('dirId')))
        if dir_id:
            dir_id = self._uuid_of(dir_id)
            drow = ProjectDirService()._find(dir_id, params)
            if str(drow.get('projectId')) != str(project['id']):
                raise BizError('所属目录不属于该项目')
        return {
            'projectId': project['id'],
            'dirId': dir_id or None,
            'projectCode': project.get('projectCode'),
            'projectName': project.get('projectName'),
            'fileType': ftype,
            'fileName': name[:255],
            'filePath': path[:500],
            'fileSize': self._int_of(data.get('fileSize', current.get('fileSize')), 0),
            'fileDesc': (self._text(data.get('fileDesc'))[:500]
                         if 'fileDesc' in data else self._text(current.get('fileDesc'))) or None,
            'ispub': 1 if self._bool_of(data.get('ispub', current.get('ispub')), True) else 0,
            'enabled': 1 if self._bool_of(data.get('enabled', current.get('enabled')), True) else 0,
        }

    def upload(self, data):
        """上传：先解码 + 落盘，再写 projectfiles；写库失败会清掉刚落盘的文件"""
        payload = dict(data or {})
        name, raw = self._decode_file(payload)
        payload['fileName'] = name
        payload['fileSize'] = len(raw)
        rel_path = self._write_file(name, raw)
        payload['filePath'] = rel_path
        try:
            return ProjectBaseService.add(self, payload)
        except Exception:
            self.unlink_file(rel_path)
            raise

    def add(self, data):
        """兼容通用 CRUD 入口：/projectfile/add 等价于 /projectfile/upload"""
        return self.upload(data)

    def update(self, data):
        payload = dict(data or {})
        uid = self._uuid_of(payload.get('id'))
        current = self._find(uid, payload, visible=False)
        new_path = ''
        if payload.get('data'):
            if not self._text(payload.get('fileName')):
                payload['fileName'] = current.get('fileName')
            name, raw = self._decode_file(payload)
            payload['fileName'] = name
            payload['fileSize'] = len(raw)
            new_path = self._write_file(name, raw)
            payload['filePath'] = new_path
        else:
            for field in ('fileName', 'filePath', 'fileSize'):
                if not self._text(payload.get(field)):
                    payload[field] = current.get(field)
        try:
            out = ProjectBaseService.update(self, payload)
        except Exception:
            if new_path:
                self.unlink_file(new_path)
            raise
        if new_path:
            self.unlink_file(current.get('filePath'))     # 换文件成功后删掉旧实体
        return out

    def download(self, params):
        """返回可下载的 URL（同源静态路由直接提供文件），带可见性校验"""
        params = params or {}
        uid = self._uuid_of(params.get('id'))
        row = dump_row(self._find(uid, params))
        item = self._attach([row])[0]
        if not int(row.get('enabled') or 0):
            raise BizError('文件「%s」已停用，不能下载' % row.get('fileName'))
        item['message'] = '文件「%s」可以下载' % row.get('fileName')
        return item

    def preview_pdf(self, params):
        """Word / PowerPoint 文档在线预览：转换成 PDF 后返回二进制（带可见性与启停校验）

        · doc / docm / docx / ppt / pptm / pptx → 服务端 Office COM 转 PDF（磁盘缓存）；
        · pdf 直接原样返回；
        · 其它扩展名拒绝（前端不会对它们发起该请求，防御性兜底）。
        """
        params = params or {}
        uid = self._uuid_of(params.get('id'))
        row = self._find(uid, params)
        if not int(row.get('enabled') or 0):
            raise BizError('文件「%s」已停用，不能预览' % row.get('fileName'))
        rel = str(row.get('filePath') or '')
        if not rel.startswith('data/projectfiles/'):
            raise BizError('该文件不支持在线预览')
        ext = os.path.splitext(rel)[1].lower().lstrip('.')
        if ext not in ('pdf',) + PREVIEW_CONVERT_EXTS:
            raise BizError('该文件类型不支持转 PDF 预览')
        src = os.path.abspath(os.path.join(WEB_ROOT_LOCAL, *rel.split('/')))
        if not os.path.isfile(src):
            raise BizError('文件不存在或已被删除', 404)
        if ext == 'pdf':
            pdf_path = src
        else:
            from preview_convert import convert_to_pdf
            try:
                pdf_path = convert_to_pdf(src, ext)
            except RuntimeError as exc:
                raise BizError(str(exc))
            except Exception:
                traceback.print_exc()
                raise BizError('文档转换服务异常，请稍后重试或下载查看')
        try:
            with open(pdf_path, 'rb') as fp:
                content = fp.read()
        except OSError:
            raise BizError('转换结果读取失败，请重试')
        return {'content': content,
                'filename': os.path.splitext(str(row.get('fileName') or '文档'))[0] + '.pdf'}

    def delete(self, data):
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        row = self._find(uid, data, visible=False)
        execute('DELETE FROM `projectfiles` WHERE `id`=%s', (uid,))
        self.unlink_file(row.get('filePath'))
        out = self._attach([dump_row(row)])[0]
        out['message'] = '文件「%s」已删除' % row.get('fileName')
        return out


project_service = ProjectInfoService()
project_dir_service = ProjectDirService()
project_file_service = ProjectFileService()


# =====================================================================
# 系统配置：系统字典（sysdict）/ 字典明细（sysdictitems）/ 系统参数（syspara）
# ---------------------------------------------------------------------
# · 三张表都是「全局配置数据」，**不做**「本人创建 OR 公用」可见性过滤
#   （与 project / dbinfo / report 等业务数据的可见性规则不同），所有已登录用户均可维护；
# · 统一 UUID 主键、英文名唯一、显示序号、说明、启用否；列表统一按 sortNo 升序；
# · sysdict.parentId 支持字典分组（新增/改上级时防自身与防环，列表补 level / parentName）；
#   删除字典时级联清理 sysdictitems 键值明细，并把子字典的 parentId 置空（升为顶级）；
# · sysdictitems 按 dictId 归属，同一字典下 itemKey 唯一（NULL 允许存在多条，纯枚举字典）。
# =====================================================================

SYS_NAME_EN_RE = re.compile(r'^[A-Za-z][A-Za-z0-9_.\-]*$')
SYS_DICT_MAX_LEVEL = 5


PROJECT_NOTICE_TITLE = '项目通知'


class ProjectMemberService(object):
    """
    项目组成员（projectmembers）：成员从「员工信息」empinfos 中选取。
      · members：某项目的成员清单（含姓名 / 部门 / 岗位 / 邮箱快照与通知状态）；
      · save_members：全量替换成员（差异增删）；**只有新加入的成员**会收到通知：
          ① 站内即时消息（发送人 = 当前操作人，实时推给在线连接）；
          ② 员工信息里登记了邮箱的，再用服务信箱发一封通知邮件（服务信箱未启用则跳过）。
      · 通知失败不回滚成员关系：成员已落库，noticeMsg / noticeMail 如实记录结果，
        响应里把 mailError 带回去，页面提示「已加入，但邮件未发出」。
    """

    PROJECT_SQL = ('SELECT `id`,`projectCode`,`projectName`,`ispub`,`createempinfosid` '
                   'FROM `projectinfos` WHERE `id`=%s LIMIT 1')
    EMP_SQL = ('SELECT e.`id`,e.`nameCn`,e.`deptId`,e.`jobTitle`,e.`email`,'
               '       d.`nameCn` AS `deptName` '
               'FROM `empinfos` e LEFT JOIN `OrganizationStructure` d ON d.`id`=e.`deptId` '
               'WHERE e.`id` IN (%s)')
    LIST_SQL = ('SELECT `empId`,`empName`,`deptId`,`deptName`,`jobTitle`,`email`,'
                '       `noticeMsg`,`noticeMail`,`noticeTime`,`createTime` '
                'FROM `projectmembers` WHERE `projectId`=%s '
                'ORDER BY `createTime` ASC, `empName` ASC')
    LOGIN_EMP_SQL = ProjectBaseService.LOGIN_SQL

    # ---------------- 小工具 ----------------

    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _int_of(value, default=0):
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _uuid_of(value):
        text = ProjectMemberService._text(value).lower()
        if not text:
            raise BizError('参数 projectId 不能为空')
        if not RE_UUID.match(text):
            raise BizError('参数 projectId 不合法（应为 UUID）')
        return text

    def _me(self, params):
        """当前登录人（员工ID + 姓名）：只认 token 反查结果，不接受前端传参"""
        user_id = self._text((params or {}).get('_loginUserId'))
        if not user_id:
            raise BizError('登录已失效，请重新登录', 401)
        try:
            row = query_one(self.LOGIN_EMP_SQL, (user_id,))
        except Exception:
            row = None
        emp_id = self._int_of((row or {}).get('empId'))
        if not emp_id:
            raise BizError('当前登录账号未绑定员工，无法维护项目组')
        return emp_id, self._text((row or {}).get('empName'))

    def _project(self, pid):
        try:
            row = query_one(self.PROJECT_SQL, (pid,))
        except Exception:
            row = None
        if not row:
            raise BizError('项目不存在或已被删除', 404)
        return row

    @staticmethod
    def _mail_account():
        """服务信箱（未启用 / 未配置时返回 None，不抛错——成员关系优先）"""
        try:
            return mail_service._enabled_account()
        except Exception:
            return None

    # ---------------- 查询 ----------------

    def members(self, params):
        params = params or {}
        self._me(params)
        pid = self._uuid_of(params.get('projectId'))
        project = self._project(pid)
        try:
            rows = query_all(self.LIST_SQL, (pid,)) or []
        except Exception:
            rows = []
        items = []
        for r in rows:
            items.append({
                'empId': self._int_of(r.get('empId')),
                'empName': self._text(r.get('empName')),
                'deptId': self._int_of(r.get('deptId')),
                'deptName': self._text(r.get('deptName')),
                'jobTitle': self._text(r.get('jobTitle')),
                'email': self._text(r.get('email')),
                'noticeMsg': bool(self._int_of(r.get('noticeMsg'))),
                'noticeMail': bool(self._int_of(r.get('noticeMail'))),
                'noticeTime': time_text(r.get('noticeTime')),
                'createTime': time_text(r.get('createTime'))
            })
        return {
            'projectId': pid,
            'projectCode': self._text(project.get('projectCode')),
            'projectName': self._text(project.get('projectName')),
            'emailEnabled': bool(self._mail_account()),
            'list': items,
            'memberCount': len(items)
        }

    # ---------------- 保存（差异增删 + 通知） ----------------

    def save_members(self, params):
        params = params or {}
        me, me_name = self._me(params)
        pid = self._uuid_of(params.get('projectId'))
        project = self._project(pid)
        project_name = self._text(project.get('projectName')) or '未命名项目'
        project_code = self._text(project.get('projectCode'))

        raw = params.get('memberIds')
        items = raw if isinstance(raw, (list, tuple)) else re.split(r'[,\s]+', self._text(raw))
        ids, seen = [], set()
        for x in items:
            n = self._int_of(x)
            if n and n not in seen:
                seen.add(n)
                ids.append(n)

        before = set()
        try:
            for r in (query_all('SELECT `empId` FROM `projectmembers` WHERE `projectId`=%s', (pid,)) or []):
                before.add(self._int_of(r.get('empId')))
        except Exception:
            before = set()
        after = set(ids)
        add_ids = [i for i in ids if i not in before]
        del_ids = [i for i in before if i not in after]

        for emp_id in del_ids:
            execute('DELETE FROM `projectmembers` WHERE `projectId`=%s AND `empId`=%s', (pid, emp_id))

        added_rows = []
        if add_ids:
            marks = ','.join(['%s'] * len(add_ids))
            emp_rows = query_all(self.EMP_SQL % marks, tuple(add_ids)) or []
            emp_map = dict((self._int_of(r.get('id')), r) for r in emp_rows)
            for emp_id in add_ids:
                emp = emp_map.get(emp_id)
                if not emp:
                    continue                         # 员工被删了：跳过，不阻塞其他人
                row_id = str(uuid.uuid4())
                execute(
                    'INSERT INTO `projectmembers` '
                    '(`id`,`projectId`,`empId`,`empName`,`deptId`,`deptName`,`jobTitle`,`email`) '
                    'VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                    (row_id, pid, emp_id, self._text(emp.get('nameCn')),
                     self._int_of(emp.get('deptId')), self._text(emp.get('deptName')),
                     self._text(emp.get('jobTitle')), self._text(emp.get('email'))))
                added_rows.append({
                    'rowId': row_id, 'empId': emp_id,
                    'empName': self._text(emp.get('nameCn')) or ('员工%d' % emp_id),
                    'email': self._text(emp.get('email'))
                })

        acc = self._mail_account()
        project_link = 'project-detail.html?id=%s' % pid
        project_url = project_plan_service._rel_url(project_link)    # 站内消息：相对路径
        project_mail_url = project_plan_service._abs_url(project_link)  # 邮件：绝对地址
        notified = mailed = 0
        mail_errors = []
        for row in added_rows:
            ok_msg = self._push_message(me, row, project_name, project_url, me_name)
            ok_mail = False
            if acc and row['email']:
                err = self._send_mail(acc, row, project_name, project_mail_url, me_name)
                ok_mail = (err == '')
                if err:
                    mail_errors.append('%s：%s' % (row['empName'], err))
            if ok_msg:
                notified += 1
            if ok_mail:
                mailed += 1
            execute('UPDATE `projectmembers` SET `noticeMsg`=%s,`noticeMail`=%s,`noticeTime`=NOW() '
                    'WHERE `id`=%s', (1 if ok_msg else 0, 1 if ok_mail else 0, row['rowId']))

        no_mail_reason = ''
        if added_rows and not acc:
            no_mail_reason = '服务信箱未启用，本次只发了站内消息'
        elif added_rows and not any(r['email'] for r in added_rows):
            no_mail_reason = '新成员都没有登记邮箱，本次只发了站内消息'
        message = '已保存：新增 %d 人、移除 %d 人；站内消息 %d 条' % (len(add_ids), len(del_ids), notified)
        if mail_errors:
            message += '；邮件失败 %d 封（%s）' % (len(mail_errors), '；'.join(mail_errors[:3]))
        elif mailed:
            message += '、邮件 %d 封' % mailed
        elif no_mail_reason:
            message += '（%s）' % no_mail_reason

        return {
            'projectId': pid,
            'projectName': project_name,
            'projectCode': project_code,
            'added': len(add_ids),
            'removed': len(del_ids),
            'notified': notified,
            'mailed': mailed,
            'mailReady': bool(acc),
            'mailError': '；'.join(mail_errors[:3]),
            'memberCount': len(after),
            'message': message
        }

    # ---------------- 通知：站内消息 / 邮件 ----------------

    def _push_message(self, me, row, project_name, project_url, me_name):
        """给新成员发一条站内消息（姓名 + 可点击项目链接），并实时推给他的在线连接。"""
        anchor = notify_anchor(project_url, '打开项目')
        text = ('【项目通知】%s 将您加入项目「%s」。\n打开项目：%s'
                % (me_name or '系统管理员', project_name, project_url))
        text_html = ('<p>【项目通知】%s 将您加入项目「%s」。</p><p>打开项目：%s</p>'
                     % (html_lib.escape(me_name or '系统管理员'),
                        html_lib.escape(project_name), anchor))
        try:
            created = emp_message_service.persist_send(me, [row['empId']], text,
                                                       PROJECT_NOTICE_TITLE, 'text',
                                                       content_html=text_html)
        except Exception:
            return False
        for c in (created or []):
            try:
                presence.push_to(row['empId'], dumps({
                    'type': 'msg', 'id': c['id'], 'senderId': c['senderId'],
                    'receiverId': c['receiverId'], 'senderName': c.get('senderName', ''),
                    'content': c['content'], 'contentHtml': c.get('contentHtml') or '',
                    'sendTime': c['sendTime'], 'title': c['title'],
                    'msgType': c.get('msgType') or 'text', 'attachId': c.get('attachId') or '',
                    'attach': c.get('attach') or None, 'groupId': c.get('groupId') or ''
                }))
            except Exception:
                pass
        return bool(created)

    def _send_mail(self, acc, row, project_name, project_url, me_name):
        """发通知邮件（姓名 + 可点击项目链接）；成功返回 ''，失败返回原因。"""
        anchor = notify_anchor(project_url, '打开项目')
        body = ('您好，%s：\n\n'
                '您已被 %s 加入项目「%s」。\n\n'
                '打开项目：%s\n\n'
                '项目的成员、文件与进展，可在「九豆综合管理平台 → 项目管理」中查看。\n'
                '如需调整项目组成员，请联系项目负责人。\n\n'
                '—— 九豆综合管理平台 · 系统通知，请勿直接回复') % (
                    row['empName'] or '同事', me_name or '系统管理员',
                    project_name, project_url)
        body_html = ('<p>您好，%s：</p><p>您已被 %s 加入项目「%s」。</p>'
                     '<p>打开项目：%s</p>'
                     '<p>项目的成员、文件与进展，可在「九豆综合管理平台 → 项目管理」中查看。'
                     '如需调整项目组成员，请联系项目负责人。</p>'
                     '<p>—— 九豆综合管理平台 · 系统通知，请勿直接回复</p>') % (
                         html_lib.escape(row['empName'] or '同事'),
                         html_lib.escape(me_name or '系统管理员'),
                         html_lib.escape(project_name), anchor)
        subject = '【九豆综合管理平台】您已加入项目：%s' % project_name
        try:
            mail_client.send_mail(acc['email'], acc['password'], acc['hosts'], [row['email']],
                                  subject, body, None, acc.get('displayName') or '',
                                  body_html=body_html)
            return ''
        except Exception as exc:
            return str(getattr(exc, 'message', '') or exc)[:120]


project_member_service = ProjectMemberService()   # 项目组：成员 + 自动通知

PROJECT_PLAN_ITEM_TYPES = ('事项', '任务')
PROJECT_PLAN_ITEM_STATUSES = ('待执行', '执行中', '完成', '异常')
PROJECT_PLAN_STATUS_DICT = 'project_plan_item_status'
PLAN_FILE_ROOT = os.path.join(WEB_ROOT_LOCAL, 'data', 'planfiles')
PLAN_FILE_MAX_BYTES = 20 * 1024 * 1024


class ProjectPlanService(object):
    """
    项目计划（projectplans）→ 计划事项或任务（projectplanitems）→ 工单（projectworkorders）+ 附件
      · 一个项目可以有多个计划；一个计划可以有多个事项 / 任务；**一个事项一张工单**；
      · 计划：PL + 6 位编号，含所属项目、名称、起止时间段、说明；
      · 事项：IT + 6 位编号，含前置事项、输入条件、里程碑输出、计划起止时间、责任人、参与人员、状态；
      · 状态取系统字典 `project_plan_item_status`（待执行 / 执行中 / 完成 / 异常），可直接在字典维护；
      · 指定 / 变更事项责任人 → 站内即时消息（带事项链接）+ 通知邮件，并同步生成 / 更新该事项的工单；
      · 「启动计划」给还没有工单的事项补派工单并通知；事项附件支持上传 / 在线预览 / 删除。
    """

    PLAN_TABLE = 'projectplans'
    ITEM_TABLE = 'projectplanitems'
    ORDER_TABLE = 'projectworkorders'
    FILE_TABLE = 'projectplanitemfiles'
    PROJECT_SQL = ('SELECT `id`,`projectCode`,`projectName`,`ispub`,`createempinfosid` '
                   'FROM `projectinfos` WHERE `id`=%s LIMIT 1')
    EMP_SQL = ('SELECT e.`id`,e.`nameCn`,e.`email`,d.`nameCn` AS `deptName` '
               'FROM `empinfos` e LEFT JOIN `OrganizationStructure` d ON d.`id`=e.`deptId` '
               'WHERE e.`id`=%s LIMIT 1')
    LOGIN_EMP_SQL = ProjectBaseService.LOGIN_SQL
    PLAN_PREFIX = 'PL'
    ITEM_PREFIX = 'IT'
    ORDER_PREFIX = 'WO'
    CODE_DIGITS = 6

    # ---------------- 小工具 ----------------

    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _int_of(value, default=0):
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _uuid_of(value, label='id'):
        text = ProjectPlanService._text(value).lower()
        if not text:
            raise BizError('参数 %s 不能为空（应为 UUID）' % label)
        if not RE_UUID.match(text):
            raise BizError('参数 %s 不合法（应为 UUID）' % label)
        return text

    @staticmethod
    def _date_of(value, label='日期'):
        text = ProjectPlanService._text(value)
        if not text:
            return None
        text = text[:10]
        try:
            datetime.datetime.strptime(text, '%Y-%m-%d')
        except ValueError:
            raise BizError('%s 格式不正确（应为 YYYY-MM-DD）' % label)
        return text

    @staticmethod
    def _datetime_of(value, label='时间'):
        text = ProjectPlanService._text(value).replace('T', ' ')
        if not text:
            return None
        if len(text) == 16:
            text += ':00'
        text = text[:19]
        try:
            datetime.datetime.strptime(text, '%Y-%m-%d %H:%M:%S')
        except ValueError:
            raise BizError('%s 格式不正确（应为 YYYY-MM-DD HH:MM）' % label)
        return text

    def _me(self, params):
        user_id = self._text((params or {}).get('_loginUserId'))
        if not user_id:
            raise BizError('登录已失效，请重新登录', 401)
        try:
            row = query_one(self.LOGIN_EMP_SQL, (user_id,))
        except Exception:
            row = None
        emp_id = self._int_of((row or {}).get('empId'))
        if not emp_id:
            raise BizError('当前登录账号未绑定员工，无法维护项目计划')
        return emp_id, self._text((row or {}).get('empName'))

    def _project(self, pid):
        try:
            row = query_one(self.PROJECT_SQL, (pid,))
        except Exception:
            row = None
        if not row:
            raise BizError('项目不存在或已被删除', 404)
        return row

    def _plan(self, plan_id):
        try:
            row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.PLAN_TABLE, (plan_id,))
        except Exception:
            row = None
        if not row:
            raise BizError('计划不存在或已被删除', 404)
        return row

    def _item(self, item_id):
        try:
            row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.ITEM_TABLE, (item_id,))
        except Exception:
            row = None
        if not row:
            raise BizError('计划事项不存在或已被删除', 404)
        return row

    @staticmethod
    def _mail_account():
        try:
            return mail_service._enabled_account()
        except Exception:
            return None

    def _next_code(self, table, column, prefix):
        pattern = '^%s[0-9]{%d}$' % (prefix, self.CODE_DIGITS)
        rows = query_all('SELECT `%s` AS `code` FROM `%s` WHERE `%s` REGEXP %%s'
                         % (column, table, column), (pattern,)) or []
        max_seq = 0
        for row in rows:
            code = self._text(row.get('code'))
            try:
                seq = int(code[len(prefix):])
            except (TypeError, ValueError):
                continue
            max_seq = max(max_seq, seq)
        seq = max_seq + 1
        while seq <= 999999:
            code = '%s%0*d' % (prefix, self.CODE_DIGITS, seq)
            if not query_one('SELECT `id` FROM `%s` WHERE `%s`=%%s LIMIT 1' % (table, column), (code,)):
                return code
            seq += 1
        raise BizError('编号已超出上限（%s%06d）' % (prefix, 999999))

    def _employee(self, emp_id):
        if not emp_id:
            return {}
        try:
            return query_one(self.EMP_SQL, (emp_id,)) or {}
        except Exception:
            return {}

    # ---------------- 字典：事项状态 ----------------

    def statuses(self, params=None):
        """事项状态（系统字典 project_plan_item_status；取不到用内置枚举兜底）"""
        values = []
        try:
            rows = query_all('SELECT i.`itemKey` AS `k` FROM `sysdictitems` i '
                             'JOIN `sysdict` d ON d.`id`=i.`dictId` '
                             'WHERE d.`dictNameEn`=%s AND i.`enabled`=1 ORDER BY i.`sortNo`, i.`id`',
                             (PROJECT_PLAN_STATUS_DICT,)) or []
            values = [self._text(r.get('k')) for r in rows if self._text(r.get('k'))]
        except Exception:
            values = []
        if not values:
            values = list(PROJECT_PLAN_ITEM_STATUSES)
        return {'statuses': values, 'dictNameEn': PROJECT_PLAN_STATUS_DICT,
                'source': 'dict' if len(values) else 'builtin'}

    # ---------------- 计划：列表 / 详情 ----------------

    def page(self, params):
        params = params or {}
        me, _name = self._me(params)
        where, args = ['1=1'], []
        project_id = self._text(params.get('projectId'))
        if project_id:
            where.append('l.`projectId`=%s')
            args.append(self._uuid_of(project_id, 'projectId'))
        keyword = self._text(params.get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            where.append('(l.`planCode` LIKE %s OR l.`planName` LIKE %s OR p.`projectName` LIKE %s)')
            args.extend([like, like, like])
        base = ('FROM `%s` l JOIN `projectinfos` p ON p.`id`=l.`projectId` WHERE %s'
                % (self.PLAN_TABLE, ' AND '.join(where)))
        if not params.get('_noVisibility'):
            base += ' AND (p.`createempinfosid`=%s OR p.`ispub`=1)'
            args.append(me)
        total = self._int_of((query_one('SELECT COUNT(*) AS n ' + base, tuple(args)) or {}).get('n'))
        page_num = max(1, self._int_of(params.get('pageNum'), 1))
        page_size = min(200, max(1, self._int_of(params.get('pageSize'), 10)))
        rows = query_all('SELECT l.*, p.`projectName`, p.`projectCode` ' + base +
                         ' ORDER BY l.`createTime` DESC, l.`planCode` ASC LIMIT %s OFFSET %s',
                         tuple(args + [page_size, (page_num - 1) * page_size])) or []
        items = []
        for r in rows:
            it = dump_row(r)
            it['itemCount'] = self._int_of((query_one(
                'SELECT COUNT(*) AS n FROM `%s` WHERE `planId`=%%s' % self.ITEM_TABLE, (it['id'],)) or {}).get('n'))
            it['orderCount'] = self._int_of((query_one(
                'SELECT COUNT(*) AS n FROM `%s` WHERE `planId`=%%s' % self.ORDER_TABLE, (it['id'],)) or {}).get('n'))
            items.append(it)
        return {'list': items, 'total': total, 'pageNum': page_num, 'pageSize': page_size,
                'pages': int((total + page_size - 1) / page_size) if total else 0}

    def detail(self, params):
        params = params or {}
        me, _name = self._me(params)
        plan_id = self._uuid_of(params.get('id'), 'id')
        plan = self._plan(plan_id)
        project = self._project(self._text(plan.get('projectId')))
        if not (self._int_of(project.get('ispub')) == 1 or self._int_of(project.get('createempinfosid')) == me):
            raise BizError('计划不存在或已被删除', 404)
        out = dump_row(plan)
        out['projectName'] = self._text(project.get('projectName'))
        out['projectCode'] = self._text(project.get('projectCode'))
        out['items'] = self.items({'planId': plan_id, '_loginUserId': params.get('_loginUserId')}).get('list', [])
        out['itemCount'] = len(out['items'])
        out['orderCount'] = self._int_of((query_one(
            'SELECT COUNT(*) AS n FROM `%s` WHERE `planId`=%%s' % self.ORDER_TABLE, (plan_id,)) or {}).get('n'))
        return out

    # ---------------- 计划：新增 / 修改 / 删除 ----------------

    def _plan_payload(self, params):
        pid = self._uuid_of(params.get('projectId'), 'projectId')
        project = self._project(pid)
        start = self._date_of(params.get('startDate'), '计划开始日期')
        end = self._date_of(params.get('endDate'), '计划结束日期')
        if start and end and start > end:
            raise BizError('计划开始日期不能晚于结束日期')
        return {'projectId': pid, 'project': project,
                'planName': self._text(params.get('planName')),
                'planDesc': self._text(params.get('planDesc')),
                'startDate': start, 'endDate': end}

    def add(self, params):
        params = params or {}
        me, me_name = self._me(params)
        p = self._plan_payload(params)
        code = self._next_code(self.PLAN_TABLE, 'planCode', self.PLAN_PREFIX)
        plan_id = str(uuid.uuid4())
        execute('INSERT INTO `%s` (`id`,`projectId`,`planCode`,`planName`,`startDate`,`endDate`,'
                '`planDesc`,`createEname`,`createempinfosid`) '
                'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)' % self.PLAN_TABLE,
                (plan_id, p['projectId'], code, p['planName'], p['startDate'], p['endDate'],
                 p['planDesc'], me_name, me))
        return {'id': plan_id, 'planCode': code, 'message': '计划已创建（%s）' % code}

    def update(self, params):
        params = params or {}
        me, me_name = self._me(params)
        plan_id = self._uuid_of(params.get('id'), 'id')
        old = self._plan(plan_id)
        p = self._plan_payload(params)
        execute('UPDATE `%s` SET `projectId`=%%s,`planName`=%%s,`startDate`=%%s,`endDate`=%%s,'
                '`planDesc`=%%s WHERE `id`=%%s' % self.PLAN_TABLE,
                (p['projectId'], p['planName'], p['startDate'], p['endDate'], p['planDesc'], plan_id))
        return {'id': plan_id, 'planCode': self._text(old.get('planCode')), 'message': '计划已更新'}

    def delete(self, params):
        params = params or {}
        self._me(params)
        plan_id = self._uuid_of(params.get('id'), 'id')
        self._plan(plan_id)
        for row in (query_all('SELECT `id`,`filePath` FROM `%s` WHERE `itemId` IN '
                             '(SELECT `id` FROM `%s` WHERE `planId`=%%s)'
                             % (self.FILE_TABLE, self.ITEM_TABLE), (plan_id,)) or []):
            self._unlink_file(row.get('filePath'))
        execute('DELETE FROM `%s` WHERE `itemId` IN (SELECT `id` FROM `%s` WHERE `planId`=%%s)'
                % (self.FILE_TABLE, self.ITEM_TABLE), (plan_id,))
        execute('DELETE FROM `%s` WHERE `planId`=%%s' % self.ORDER_TABLE, (plan_id,))
        execute('DELETE FROM `%s` WHERE `planId`=%%s' % self.ITEM_TABLE, (plan_id,))
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.PLAN_TABLE, (plan_id,))
        return {'deleted': 1, 'id': plan_id, 'message': '计划及其事项、工单、附件已删除'}

    # ---------------- 事项：列表 / 详情 ----------------

    def items(self, params):
        params = params or {}
        self._me(params)
        plan_id = self._uuid_of(params.get('planId'), 'planId')
        self._plan(plan_id)
        rows = query_all('SELECT * FROM `%s` WHERE `planId`=%%s ORDER BY `sortNo`,`createTime`,`itemCode`'
                         % self.ITEM_TABLE, (plan_id,)) or []
        names = {}
        for r in rows:
            names[self._text(r.get('id'))] = self._text(r.get('itemName'))
        out = []
        for r in rows:
            it = dump_row(r)
            it['preItemId'] = self._text(it.get('preItemId'))
            it['preItemName'] = names.get(it['preItemId'], '')
            it['ownerId'] = self._int_of(it.get('ownerId'))
            it['participantNames'] = self._text(it.get('participantNames'))
            order = query_one('SELECT `id`,`orderCode`,`status`,`noticeMsg`,`noticeMail` '
                              'FROM `%s` WHERE `itemId`=%%s LIMIT 1' % self.ORDER_TABLE,
                              (it['id'],)) or {}
            it['orderCode'] = self._text(order.get('orderCode'))
            it['orderStatus'] = self._text(order.get('status'))
            it['noticeMsg'] = bool(self._int_of(order.get('noticeMsg')))
            it['noticeMail'] = bool(self._int_of(order.get('noticeMail')))
            it['fileCount'] = self._int_of((query_one(
                'SELECT COUNT(*) AS n FROM `%s` WHERE `itemId`=%%s' % self.FILE_TABLE, (it['id'],)) or {}).get('n'))
            out.append(it)
        return {'list': out, 'total': len(out), 'planId': plan_id}

    def item_detail(self, params):
        params = params or {}
        self._me(params)
        item_id = self._uuid_of(params.get('id'), 'id')
        item = self._item(item_id)
        plan = self._plan(self._text(item.get('planId')))
        project = self._project(self._text(item.get('projectId')))
        out = dump_row(item)
        out['planCode'] = self._text(plan.get('planCode'))
        out['projectName'] = self._text(project.get('projectName'))
        out['files'] = self.item_files({'itemId': item_id, '_loginUserId': params.get('_loginUserId')}).get('list', [])
        return out

    # ---------------- 事项：新增 / 修改 / 删除 ----------------

    def _item_payload(self, params):
        plan_id = self._uuid_of(params.get('planId'), 'planId')
        plan = self._plan(plan_id)
        project_id = self._text(params.get('projectId')) or self._text(plan.get('projectId'))
        project = self._project(project_id)
        name = self._text(params.get('itemName'))
        if not name:
            raise BizError('请填写事项或任务名称')
        item_type = self._text(params.get('itemType')) or '事项'
        if item_type not in PROJECT_PLAN_ITEM_TYPES:
            raise BizError('类型只能是：' + ' / '.join(PROJECT_PLAN_ITEM_TYPES))
        status = self._text(params.get('status')) or '待执行'
        if status not in self.statuses().get('statuses', []):
            raise BizError('状态不在字典内：' + status)
        pre_item_id = self._text(params.get('preItemId'))
        if pre_item_id:
            pre_item_id = self._uuid_of(pre_item_id, 'preItemId')
            pre = self._item(pre_item_id)
            if self._text(pre.get('planId')) != plan_id:
                raise BizError('前置事项必须属于同一个计划')
        owner_id = self._int_of(params.get('ownerId'))
        emp = self._employee(owner_id)
        start = self._datetime_of(params.get('startTime'), '计划开始时间')
        end = self._datetime_of(params.get('endTime'), '计划结束时间')
        if start and end and start > end:
            raise BizError('计划开始时间不能晚于结束时间')
        raw_parts = params.get('participantIds')
        parts = raw_parts if isinstance(raw_parts, (list, tuple)) else re.split(r'[,\s]+', self._text(raw_parts))
        part_ids, part_names, seen = [], [], set()
        for one in parts:
            n = self._int_of(one)
            if not n or n in seen:
                continue
            seen.add(n)
            emp_one = self._employee(n)
            part_ids.append(str(n))
            part_names.append(self._text(emp_one.get('nameCn')) or ('员工%d' % n))
        return {
            'planId': plan_id, 'plan': plan,
            'projectId': project_id, 'project': project,
            'itemName': name, 'itemType': item_type,
            'preItemId': pre_item_id or None,
            'itemDesc': self._text(params.get('itemDesc')),
            'inputCond': self._text(params.get('inputCond')),
            'milestoneOut': self._text(params.get('milestoneOut')),
            'startTime': start, 'endTime': end,
            'ownerId': owner_id, 'owner': emp,
            'ownerName': self._text(emp.get('nameCn')),
            'ownerEmail': self._text(emp.get('email')),
            'participantIds': ','.join(part_ids),
            'participantNames': ','.join(part_names),
            'status': status,
            'sortNo': self._int_of(params.get('sortNo'))
        }

    def _ensure_order(self, item_id, p):
        """一个事项一张工单：没有就建，有就同步责任人与标题"""
        order = query_one('SELECT * FROM `%s` WHERE `itemId`=%%s LIMIT 1' % self.ORDER_TABLE, (item_id,)) or {}
        if order:
            execute('UPDATE `%s` SET `ownerId`=%%s,`ownerName`=%%s,`ownerEmail`=%%s,`orderTitle`=%%s '
                    'WHERE `id`=%%s' % self.ORDER_TABLE,
                    (p['ownerId'], p['ownerName'], p['ownerEmail'], p['itemName'], order['id']))
            return self._text(order.get('orderCode'))
        code = self._next_code(self.ORDER_TABLE, 'orderCode', self.ORDER_PREFIX)
        execute('INSERT INTO `%s` (`id`,`itemId`,`planId`,`projectId`,`orderCode`,`orderTitle`,'
                '`ownerId`,`ownerName`,`ownerEmail`) VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)'
                % self.ORDER_TABLE,
                (str(uuid.uuid4()), item_id, p['planId'], p['projectId'], code, p['itemName'],
                 p['ownerId'], p['ownerName'], p['ownerEmail']))
        return code

    def _mark_order_notice(self, item_id, ok_msg, ok_mail):
        execute('UPDATE `%s` SET `noticeMsg`=%%s,`noticeMail`=%%s,`noticeTime`=NOW() WHERE `itemId`=%%s'
                % self.ORDER_TABLE, (1 if ok_msg else 0, 1 if ok_mail else 0, item_id))
        execute('UPDATE `%s` SET `noticeMsg`=%%s,`noticeMail`=%%s,`noticeTime`=NOW() WHERE `id`=%%s'
                % self.ITEM_TABLE, (1 if ok_msg else 0, 1 if ok_mail else 0, item_id))

    def item_add(self, params):
        params = params or {}
        me, me_name = self._me(params)
        p = self._item_payload(params)
        item_id = str(uuid.uuid4())
        code = self._next_code(self.ITEM_TABLE, 'itemCode', self.ITEM_PREFIX)
        execute('INSERT INTO `%s` (`id`,`planId`,`projectId`,`itemCode`,`itemName`,`itemType`,'
                '`preItemId`,`itemDesc`,`inputCond`,`milestoneOut`,`startTime`,`endTime`,`ownerId`,'
                '`ownerName`,`ownerEmail`,`participantIds`,`participantNames`,`status`,`sortNo`) '
                'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)'
                % self.ITEM_TABLE,
                (item_id, p['planId'], p['projectId'], code, p['itemName'], p['itemType'],
                 p['preItemId'], p['itemDesc'], p['inputCond'], p['milestoneOut'],
                 p['startTime'], p['endTime'], p['ownerId'], p['ownerName'], p['ownerEmail'],
                 p['participantIds'], p['participantNames'], p['status'], p['sortNo']))
        order_code = self._ensure_order(item_id, p)
        notified = mailed = 0
        err = ''
        if p['ownerId']:
            ok_msg, ok_mail, err = self._notify_item(item_id, p, me, me_name)
            notified = 1 if ok_msg else 0
            mailed = 1 if ok_mail else 0
            self._mark_order_notice(item_id, ok_msg, ok_mail)
        return {'id': item_id, 'itemCode': code, 'orderCode': order_code,
                'notified': notified, 'mailed': mailed,
                'message': ('事项已保存（%s），已生成工单 %s 并通知责任人' % (code, order_code))
                + (err and ('；' + err) or '')}

    def item_update(self, params):
        params = params or {}
        me, me_name = self._me(params)
        item_id = self._uuid_of(params.get('id'), 'id')
        old = self._item(item_id)
        p = self._item_payload(params)
        execute('UPDATE `%s` SET `planId`=%%s,`projectId`=%%s,`itemName`=%%s,`itemType`=%%s,'
                '`preItemId`=%%s,`itemDesc`=%%s,`inputCond`=%%s,`milestoneOut`=%%s,`startTime`=%%s,'
                '`endTime`=%%s,`ownerId`=%%s,`ownerName`=%%s,`ownerEmail`=%%s,`participantIds`=%%s,'
                '`participantNames`=%%s,`status`=%%s,`sortNo`=%%s WHERE `id`=%%s' % self.ITEM_TABLE,
                (p['planId'], p['projectId'], p['itemName'], p['itemType'], p['preItemId'],
                 p['itemDesc'], p['inputCond'], p['milestoneOut'], p['startTime'], p['endTime'],
                 p['ownerId'], p['ownerName'], p['ownerEmail'], p['participantIds'],
                 p['participantNames'], p['status'], p['sortNo'], item_id))
        order_code = self._ensure_order(item_id, p)
        notified = mailed = 0
        err = ''
        if p['ownerId'] and self._int_of(old.get('ownerId')) != p['ownerId']:
            ok_msg, ok_mail, err = self._notify_item(item_id, p, me, me_name)
            notified = 1 if ok_msg else 0
            mailed = 1 if ok_mail else 0
            self._mark_order_notice(item_id, ok_msg, ok_mail)
        return {'id': item_id, 'itemCode': self._text(old.get('itemCode')), 'orderCode': order_code,
                'notified': notified, 'mailed': mailed,
                'message': '事项已更新' + ('，已通知新的责任人' if notified else '') + (err and ('；' + err) or '')}

    def item_delete(self, params):
        params = params or {}
        self._me(params)
        item_id = self._uuid_of(params.get('id'), 'id')
        self._item(item_id)
        for row in (query_all('SELECT `filePath` FROM `%s` WHERE `itemId`=%%s' % self.FILE_TABLE,
                              (item_id,)) or []):
            self._unlink_file(row.get('filePath'))
        execute('DELETE FROM `%s` WHERE `itemId`=%%s' % self.FILE_TABLE, (item_id,))
        execute('DELETE FROM `%s` WHERE `itemId`=%%s' % self.ORDER_TABLE, (item_id,))
        execute('DELETE FROM `%s` WHERE `preItemId`=%%s' % self.ITEM_TABLE, (item_id,))
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.ITEM_TABLE, (item_id,))
        return {'deleted': 1, 'id': item_id, 'message': '事项及其工单 / 附件已删除'}

    # ---------------- 启动计划：补派工单 ----------------

    def start(self, params):
        params = params or {}
        me, me_name = self._me(params)
        plan_id = self._uuid_of(params.get('planId'), 'planId')
        plan = self._plan(plan_id)
        project = self._project(self._text(plan.get('projectId')))
        rows = query_all('SELECT i.* FROM `%s` i LEFT JOIN `%s` o ON o.`itemId`=i.`id` '
                         'WHERE i.`planId`=%%s AND o.`id` IS NULL ORDER BY i.`sortNo`'
                         % (self.ITEM_TABLE, self.ORDER_TABLE), (plan_id,)) or []
        created = notified = mailed = 0
        skipped = 0
        errors = []
        for r in rows:
            item_id = self._text(r.get('id'))
            p = {'planId': plan_id, 'plan': plan, 'projectId': self._text(plan.get('projectId')),
                 'project': project, 'itemName': self._text(r.get('itemName')),
                 'ownerId': self._int_of(r.get('ownerId')), 'ownerName': self._text(r.get('ownerName')),
                 'ownerEmail': self._text(r.get('ownerEmail'))}
            code = self._ensure_order(item_id, p)
            created += 1
            if not p['ownerId']:
                skipped += 1
                continue
            ok_msg, ok_mail, err = self._notify_item(item_id, p, me, me_name, order_code=code)
            notified += 1 if ok_msg else 0
            mailed += 1 if ok_mail else 0
            if err:
                errors.append('%s：%s' % (p['itemName'], err))
            self._mark_order_notice(item_id, ok_msg, ok_mail)
        message = '已为 %d 个事项派发工单；站内消息 %d 条' % (created, notified)
        if mailed:
            message += '、邮件 %d 封' % mailed
        if skipped:
            message += '；%d 个事项没有责任人，未通知' % skipped
        if errors:
            message += '；通知失败：' + '；'.join(errors[:3])
        return {'created': created, 'notified': notified, 'mailed': mailed,
                'skipped': skipped, 'message': message}

    def orders(self, params):
        params = params or {}
        self._me(params)
        where, args = ['1=1'], []
        if self._text(params.get('planId')):
            where.append('`planId`=%s')
            args.append(self._uuid_of(params.get('planId'), 'planId'))
        if self._text(params.get('itemId')):
            where.append('`itemId`=%s')
            args.append(self._uuid_of(params.get('itemId'), 'itemId'))
        rows = query_all('SELECT * FROM `%s` WHERE %s ORDER BY `dispatchTime` DESC'
                         % (self.ORDER_TABLE, ' AND '.join(where)), tuple(args)) or []
        out = []
        for r in rows:
            it = dump_row(r)
            it['noticeMsg'] = bool(self._int_of(it.get('noticeMsg')))
            it['noticeMail'] = bool(self._int_of(it.get('noticeMail')))
            out.append(it)
        return {'list': out, 'total': len(out)}

    # ---------------- 事项附件：上传 / 列表 / 删除 / 下载 ----------------

    @staticmethod
    def _unlink_file(rel_path):
        path = str(rel_path or '')
        if not path.startswith('data/planfiles/'):
            return
        try:
            full = os.path.abspath(os.path.join(WEB_ROOT_LOCAL, *path.split('/')))
            if full.startswith(PLAN_FILE_ROOT) and os.path.isfile(full):
                os.remove(full)
        except OSError:
            pass

    def _decode_file(self, payload):
        name = os.path.basename((self._text(payload.get('fileName')) or '').replace('\\', '/'))[:255]
        if not name:
            raise BizError('文件名不能为空，请重新选择文件')
        text = payload.get('data')
        if text is None:
            raise BizError('请选择要上传的文件')
        text = str(text)
        if ';base64,' in text[:200]:
            text = text.split(';base64,', 1)[1]
        text = re.sub(r'\s+', '', text)
        try:
            raw = base64.b64decode(text.encode('ascii'), validate=True) if text else b''
        except Exception:
            raise BizError('文件内容解析失败，请重新选择文件')
        if not raw:
            raise BizError('文件内容为空，请重新选择文件')
        if len(raw) > PLAN_FILE_MAX_BYTES:
            raise BizError('文件不能超过 %d MB' % (PLAN_FILE_MAX_BYTES // (1024 * 1024)))
        return name, raw

    def _write_file(self, name, raw):
        ext = re.sub(r'[^0-9a-z]', '', os.path.splitext(name)[1].lower().lstrip('.'))[:10]
        folder = datetime.datetime.now().strftime('%Y%m')
        directory = os.path.join(PLAN_FILE_ROOT, folder)
        try:
            if not os.path.isdir(directory):
                os.makedirs(directory)
        except OSError:
            raise BizError('文件目录不可写，请联系管理员')
        filename = str(uuid.uuid4()) + ('.' + ext if ext else '')
        try:
            with open(os.path.join(directory, filename), 'wb') as fp:
                fp.write(raw)
        except OSError:
            raise BizError('文件写入失败，请联系管理员')
        return 'data/planfiles/%s/%s' % (folder, filename)

    @staticmethod
    def _type_of(name):
        ext = os.path.splitext(str(name or ''))[1].lower().lstrip('.')
        if ext in ('png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'):
            return '图片'
        if ext in ('pdf', 'doc', 'docx', 'txt', 'md', 'ppt', 'pptx'):
            return '文档'
        if ext in ('xls', 'xlsx', 'csv'):
            return '表格'
        return '其它'

    def item_files(self, params):
        params = params or {}
        self._me(params)
        item_id = self._uuid_of(params.get('itemId'), 'itemId')
        rows = query_all('SELECT * FROM `%s` WHERE `itemId`=%%s ORDER BY `uploadTime` DESC'
                         % self.FILE_TABLE, (item_id,)) or []
        out = []
        for r in rows:
            it = dump_row(r)
            it['fileSize'] = self._int_of(it.get('fileSize'))
            it['fileSizeText'] = ProjectBaseService._size_text(it['fileSize'])
            path = self._text(it.get('filePath'))
            it['downloadUrl'] = ('/' + path.lstrip('/')) if path else ''
            out.append(it)
        return {'list': out, 'total': len(out)}

    def item_file_add(self, params):
        params = params or {}
        me, me_name = self._me(params)
        item_id = self._uuid_of(params.get('itemId'), 'itemId')
        item = self._item(item_id)
        name, raw = self._decode_file(params)
        rel_path = self._write_file(name, raw)
        file_id = str(uuid.uuid4())
        try:
            execute('INSERT INTO `%s` (`id`,`itemId`,`projectId`,`fileName`,`filePath`,`fileType`,'
                    '`fileSize`,`fileDesc`,`ispub`,`enabled`,`uploadEname`,`uploadempinfosid`) '
                    'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,1,%%s,%%s)' % self.FILE_TABLE,
                    (file_id, item_id, self._text(item.get('projectId')), name, rel_path,
                     self._type_of(name), len(raw), self._text(params.get('fileDesc')),
                     1 if params.get('ispub') in (1, '1', True) else 0, me_name, me))
        except Exception:
            self._unlink_file(rel_path)
            raise
        return {'id': file_id, 'fileName': name, 'fileSize': len(raw),
                'downloadUrl': '/' + rel_path, 'message': '附件已上传'}

    def item_file_delete(self, params):
        params = params or {}
        self._me(params)
        file_id = self._uuid_of(params.get('id'), 'id')
        row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.FILE_TABLE, (file_id,)) or {}
        if not row:
            raise BizError('附件不存在或已被删除', 404)
        self._unlink_file(row.get('filePath'))
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.FILE_TABLE, (file_id,))
        return {'deleted': 1, 'id': file_id, 'message': '附件已删除'}

    def item_file_download(self, params):
        params = params or {}
        self._me(params)
        file_id = self._uuid_of(params.get('id'), 'id')
        row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.FILE_TABLE, (file_id,)) or {}
        if not row:
            raise BizError('附件不存在或已被删除', 404)
        if not self._int_of(row.get('enabled')):
            raise BizError('附件已停用，不能下载', 403)
        path = self._text(row.get('filePath'))
        return {'id': file_id, 'fileName': self._text(row.get('fileName')),
                'fileType': self._text(row.get('fileType')),
                'url': ('/' + path.lstrip('/')) if path else '',
                'downloadUrl': ('/' + path.lstrip('/')) if path else ''}

    # ---------------- 通知（站内消息 + 邮件） ----------------

    @staticmethod
    def _abs_url(path):
        """邮件正文里的链接：绝对地址（邮件客户端没有站点上下文）。

        基址 = PUBLIC_BASE_URL 配置 → 当次请求的访问地址 → 空（退回相对路径）。
        绝不再用 SERVER_HOST：那是服务端监听地址（默认 127.0.0.1），部署到服务器后
        收件人点开会变成「自己的电脑」。详见 linkctx 模块说明。
        """
        return linkctx.abs_url(path)

    @staticmethod
    def _rel_url(path):
        """站内消息里的链接：相对路径，换 IP / 域名 / 端口都不会失效。"""
        return linkctx.rel_url(path)

    def _push_message(self, me, owner_id, title, content, content_html=''):
        try:
            created = emp_message_service.persist_send(me, [owner_id], content, title, 'text',
                                                       content_html=content_html)
        except Exception:
            return False
        for c in (created or []):
            try:
                presence.push_to(owner_id, dumps({
                    'type': 'msg', 'id': c['id'], 'senderId': c['senderId'],
                    'receiverId': c['receiverId'], 'senderName': c.get('senderName', ''),
                    'content': c['content'], 'contentHtml': c.get('contentHtml') or '',
                    'sendTime': c['sendTime'], 'title': c['title'],
                    'msgType': c.get('msgType') or 'text', 'attachId': c.get('attachId') or '',
                    'attach': c.get('attach') or None, 'groupId': c.get('groupId') or ''
                }))
            except Exception:
                pass
        return bool(created)

    def _send_mail(self, to_list, subject, body, body_html=''):
        acc = self._mail_account()
        if not acc:
            return False, '服务信箱未启用'
        try:
            mail_client.send_mail(acc['email'], acc['password'], acc['hosts'], to_list,
                                  subject, body, None, acc.get('displayName') or '',
                                  body_html=body_html or '')
            return True, ''
        except Exception as exc:
            return False, str(getattr(exc, 'message', '') or exc)[:120]

    def _notify_item(self, item_id, p, me, me_name, order_code=''):
        """给事项责任人发消息 + 邮件：责任人用姓名、事项 / 项目用名称，链接可点击。"""
        link = 'project-plan-item-form.html?itemId=%s&planId=%s' % (item_id, p.get('planId'))
        url = self._rel_url(link)                 # 站内消息：相对路径
        mail_url = self._abs_url(link)            # 邮件：绝对地址
        anchor = notify_anchor(url, '打开事项')
        mail_anchor = notify_anchor(mail_url, '打开事项')
        project_name = self._text((p.get('project') or {}).get('projectName')) or '未命名项目'
        item_name = self._text(p.get('itemName')) or '未命名事项'
        owner_name = self._text(p.get('ownerName')) or '同事'
        text = ('【计划事项】%s 把项目「%s」的事项「%s」指派给您。\n打开事项：%s'
                % (me_name or '系统管理员', project_name, item_name, url))
        text_html = ('<p>【计划事项】%s 把项目「%s」的事项「%s」指派给您。</p>'
                     '<p>打开事项：%s</p>'
                     % (html_lib.escape(me_name or '系统管理员'), html_lib.escape(project_name),
                        html_lib.escape(item_name), anchor))
        ok_msg = self._push_message(me, p['ownerId'], '计划事项通知', text, text_html)
        ok_mail = False
        err = ''
        if p.get('ownerEmail'):
            body = ('您好，%s：\n\n%s 把项目「%s」的计划事项「%s」指派给您。\n\n'
                    '打开事项：%s\n\n—— 九豆综合管理平台 · 系统通知，请勿直接回复'
                    % (owner_name, me_name or '系统管理员', project_name, item_name, mail_url))
            body_html = ('<p>您好，%s：</p><p>%s 把项目「%s」的计划事项「%s」指派给您。</p>'
                         '<p>打开事项：%s</p>'
                         '<p>—— 九豆综合管理平台 · 系统通知，请勿直接回复</p>'
                         % (html_lib.escape(owner_name),
                            html_lib.escape(me_name or '系统管理员'),
                            html_lib.escape(project_name), html_lib.escape(item_name), mail_anchor))
            ok_mail, err = self._send_mail([p['ownerEmail']],
                                           '【九豆综合管理平台】计划事项：%s' % item_name, body, body_html)
        return ok_msg, ok_mail, err


project_plan_service = ProjectPlanService()   # 项目计划 + 事项 + 工单 + 附件

class SysConfigBaseService(object):
    """系统配置三张表共用的 CRUD 骨架（UUID 主键 / 显示序号 / 启用否）"""

    table = ''
    label = ''
    name_field = ''
    keyword_fields = ()
    unique_fields = ()          # ((field, 中文名), ...)
    ORDER_BY = '`sortNo` ASC, `id` ASC'

    # ---------------- 小工具 ----------------
    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _bool_of(value, default=False):
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ('1', 'true', 'yes', 'on')

    @staticmethod
    def _int_of(value, default=0):
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _uuid_of(value):
        text = SysConfigBaseService._text(value).lower()
        if not text:
            raise BizError('参数 id 不能为空（应为 UUID）')
        if not RE_UUID.match(text):
            raise BizError('参数 id 不合法（应为 UUID）')
        return text

    @staticmethod
    def _name_en(value, label):
        text = SysConfigBaseService._text(value)
        if not text:
            raise BizError(label + '不能为空')
        if len(text) > 100:
            raise BizError(label + '最多 100 个字符')
        if not SYS_NAME_EN_RE.match(text):
            raise BizError(label + '只能以字母开头，且只能包含字母、数字、下划线、点、横线')
        return text

    @staticmethod
    def _picked_common(data, current):
        return {
            'sortNo': SysConfigBaseService._int_of(data.get('sortNo', current.get('sortNo')), 0),
            'remark': (SysConfigBaseService._text(data.get('remark'))[:500]
                       if 'remark' in data else SysConfigBaseService._text(current.get('remark'))) or None,
            'enabled': 1 if SysConfigBaseService._bool_of(
                data.get('enabled', current.get('enabled')), True) else 0,
        }

    # ---------------- 检索 ----------------
    def _extra_where(self, params):
        """子类追加筛选条件，返回 (sql, args)；sql 可为空（未做 % 格式化，占位符写 %s）"""
        return '', []

    def _build_where(self, params):
        params = params or {}
        where, args = [], []
        keyword = self._text(params.get('keyword'))
        if keyword and self.keyword_fields:
            like = '%' + keyword + '%'
            where.append('(' + ' OR '.join('`%s` LIKE %%s' % f for f in self.keyword_fields) + ')')
            args.extend([like] * len(self.keyword_fields))
        extra_sql, extra_args = self._extra_where(params)
        if extra_sql:
            where.append(extra_sql)
            args.extend(extra_args)
        value = params.get('enabled')
        if value is not None and str(value).strip() != '':
            where.append('`enabled`=%s')
            args.append(1 if self._bool_of(value) else 0)
        return (' WHERE ' + ' AND '.join(where)) if where else '', args

    def _find(self, uid):
        row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.table, (uid,))
        if not row:
            raise BizError(self.label + '不存在或已被删除', 404)
        return row

    # ---------------- 展示 ----------------
    def _attach(self, items):
        for it in items:
            it['enabled'] = bool(int(it.get('enabled') or 0))
            it['sortNo'] = int(it.get('sortNo') or 0)
            it['remark'] = it.get('remark') or ''
            for field in ('createTime', 'updateTime'):
                if field in it:
                    it[field] = it.get(field) or ''
        return items

    # ---------------- 读 ----------------
    def page(self, params):
        params = params or {}
        where, args = self._build_where(params)
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 10), 1), 200)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        row = query_one('SELECT COUNT(*) AS n FROM `%s`%s' % (self.table, where), args)
        total = int(row['n']) if row and row.get('n') is not None else 0
        pages = max(1, int(math.ceil(total / float(page_size))))
        page_num = min(page_num, pages)
        rows = query_all('SELECT * FROM `%s`%s ORDER BY %s LIMIT %%s OFFSET %%s'
                         % (self.table, where, self.ORDER_BY),
                         args + [page_size, (page_num - 1) * page_size])
        return {'list': self._attach([dump_row(r) for r in rows]),
                'total': total, 'pageNum': page_num, 'pageSize': page_size, 'pages': pages}

    def detail(self, params):
        uid = self._uuid_of((params or {}).get('id'))
        return self._attach([dump_row(self._find(uid))])[0]

    def check(self, params):
        """英文名唯一性校验（sysdict.dictNameEn / syspara.paraNameEn）"""
        params = params or {}
        field = self._text(params.get('field')) or (
            self.unique_fields[0][0] if self.unique_fields else '')
        if field not in [f for f, _ in self.unique_fields]:
            raise BizError('不支持的唯一性校验字段：' + field)
        value = self._text(params.get('value'))
        if not value:
            return {'unique': True}
        self_id = self._text(params.get('id'))
        row = query_one('SELECT `id` FROM `%s` WHERE `%s`=%%s AND `id`<>%%s LIMIT 1'
                        % (self.table, field), (value, self_id))
        return {'unique': row is None}

    # ---------------- 写 ----------------
    def _assert_unique(self, picked, self_id=''):
        for field, name in self.unique_fields:
            value = self._text(picked.get(field))
            if not value:
                continue
            row = query_one('SELECT `id` FROM `%s` WHERE `%s`=%%s AND `id`<>%%s LIMIT 1'
                            % (self.table, field), (value, self_id))
            if row:
                raise BizError(name + '【' + value + '】已存在，请换一个')

    def _normalize(self, data, current, params):
        raise NotImplementedError

    def add(self, data):
        data = dict(data or {})
        picked = self._normalize(data, None, data)
        self._assert_unique(picked)
        picked['id'] = str(uuid.uuid4())
        columns = ','.join('`%s`' % c for c in picked.keys())
        holders = ','.join(['%s'] * len(picked))
        try:
            execute('INSERT INTO `%s` (%s) VALUES (%s)' % (self.table, columns, holders),
                    list(picked.values()))
        except DuplicateError:
            raise BizError(self.label + '已存在，请重新填写')
        return self._attach([dump_row(self._find(picked['id']))])[0]

    def update(self, data):
        data = dict(data or {})
        uid = self._uuid_of(data.get('id'))
        current = self._find(uid)
        picked = self._normalize(data, current, data)
        self._assert_unique(picked, uid)
        assignments = ','.join('`%s`=%%s' % c for c in picked.keys())
        try:
            execute('UPDATE `%s` SET %s WHERE `id`=%%s' % (self.table, assignments),
                    list(picked.values()) + [uid])
        except DuplicateError:
            raise BizError(self.label + '已存在，请重新填写')
        return self._attach([dump_row(self._find(uid))])[0]

    def delete(self, data):
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        row = self._find(uid)
        execute('DELETE FROM `%s` WHERE `id`=%%s' % self.table, (uid,))
        return self._attach([dump_row(row)])[0]

    def enabled(self, data):
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        row = self._find(uid)
        on = 1 if self._bool_of(data.get('enabled', 1), True) else 0
        execute('UPDATE `%s` SET `enabled`=%%s WHERE `id`=%%s' % (self.table,), (on, uid))
        item = self._attach([dump_row(self._find(uid))])[0]
        item['message'] = '%s「%s」已%s' % (self.label, row.get(self.name_field),
                                        '启用' if on else '停用')
        return item


class SysDictService(SysConfigBaseService):
    """系统字典（sysdict）：键中文名 / 英文名唯一 / 上级（树形分组）/ 显示序号 / 说明 / 启用否"""

    table = 'sysdict'
    label = '系统字典'
    name_field = 'dictNameCn'
    keyword_fields = ('dictNameCn', 'dictNameEn', 'remark')
    unique_fields = (('dictNameEn', '键英文名'),)
    ORDER_BY = '`sortNo` ASC, `dictNameEn` ASC'

    # ---------------- 检索：按上级字典筛选（与前端 Mock 同口径） ----------------
    def _extra_where(self, params):
        parent_id = self._text((params or {}).get('parentId'))
        if parent_id:
            return '`parentId`=%s', [parent_id]
        return '', []

    # ---------------- 展示：层级 + 键值数 ----------------
    def _attach(self, items):
        out = SysConfigBaseService._attach(self, items)
        rows = query_all('SELECT `id`,`parentId`,`dictNameCn`,`sortNo` FROM `sysdict`') or []
        pmap = {}
        for row in rows:
            one = dump_row(row)
            pmap[str(one.get('id'))] = one
        counts = query_all('SELECT `dictId`, COUNT(*) AS n FROM `sysdictitems` GROUP BY `dictId`') or []
        cmap = {}
        for row in counts:
            cmap[str(row.get('dictId'))] = int(row.get('n') or 0)
        for it in out:
            pid = self._text(it.get('parentId'))
            it['parentId'] = pid
            parent = pmap.get(pid)
            it['parentName'] = (parent.get('dictNameCn') or '') if parent else ''
            level, cur, chain, guard = 1, pid, [], 0
            while cur and cur in pmap and guard < SYS_DICT_MAX_LEVEL + 2:
                one = pmap[cur]
                chain.append(one.get('dictNameCn') or '')
                level += 1
                cur = self._text(one.get('parentId'))
                guard += 1
            it['level'] = level
            it['pathNames'] = ' / '.join(reversed(chain))
            it['itemCount'] = cmap.get(str(it.get('id')), 0)
        return out

    # ---------------- 下拉：字典树 / 所属字典 ----------------
    def tree(self, params=None):
        """上级字典下拉（树形深度优先，label 带层级缩进）；excludeId 排除自身与全部后代"""
        params = params or {}
        exclude_id = self._text(params.get('excludeId'))
        rows = query_all('SELECT `id`,`parentId`,`dictNameCn`,`dictNameEn`,`sortNo`,`enabled` '
                         'FROM `sysdict`') or []
        all_rows = [dump_row(r) for r in rows]
        banned = set()
        if exclude_id:
            banned.add(exclude_id)
            stack = [exclude_id]
            while stack:
                cur = stack.pop()
                for one in all_rows:
                    uid = str(one.get('id'))
                    if self._text(one.get('parentId')) == cur and uid not in banned:
                        banned.add(uid)
                        stack.append(uid)
        ids = set(str(one.get('id')) for one in all_rows)
        children = {}
        for one in all_rows:
            children.setdefault(self._text(one.get('parentId')) or '', []).append(one)
        for key in children:
            children[key].sort(key=lambda x: (int(x.get('sortNo') or 0),
                                              str(x.get('dictNameEn') or '')))
        out = []

        def walk(node, level):
            uid = str(node.get('id'))
            if uid in banned:
                return
            indent = ('　' * (level - 1)) + ('└ ' if level > 1 else '')
            out.append({
                'id': uid,
                'parentId': self._text(node.get('parentId')),
                'level': level,
                'dictNameCn': node.get('dictNameCn') or '',
                'dictNameEn': node.get('dictNameEn') or '',
                'sortNo': int(node.get('sortNo') or 0),
                'enabled': bool(int(node.get('enabled') or 0)),
                'childCount': len(children.get(uid, [])),
                'leaf': not children.get(uid),
                'label': indent + (node.get('dictNameCn') or '') + '（' + (node.get('dictNameEn') or '') + '）'
            })
            for kid in children.get(uid, []):
                walk(kid, level + 1)

        roots = [one for one in all_rows
                 if (self._text(one.get('parentId')) or '') not in ids]
        roots.sort(key=lambda x: (int(x.get('sortNo') or 0), str(x.get('dictNameEn') or '')))
        for one in roots:
            walk(one, 1)
        return {'list': out}

    def options(self, params=None):
        """所属字典下拉（只给启用的字典），字典键值页与检索条件用"""
        rows = query_all('SELECT `id`,`dictNameCn`,`dictNameEn`,`sortNo` FROM `sysdict` '
                         'WHERE `enabled`=1 ORDER BY `sortNo` ASC,`dictNameEn` ASC LIMIT 200') or []
        out = []
        for row in rows:
            one = dump_row(row)
            one['label'] = '%s（%s）' % (one.get('dictNameCn') or '', one.get('dictNameEn') or '')
            out.append(one)
        return {'list': out}

    # ---------------- 保存 ----------------
    def _normalize(self, data, current, params):
        current = current or {}
        cn = self._text(data.get('dictNameCn')) or self._text(current.get('dictNameCn'))
        if not cn:
            raise BizError('键中文名不能为空')
        if len(cn) > 150:
            raise BizError('键中文名最多 150 个字符')
        en = self._name_en(data.get('dictNameEn') if 'dictNameEn' in data else current.get('dictNameEn'),
                           '键英文名')
        parent = (self._text(data.get('parentId')) if 'parentId' in data
                  else self._text(current.get('parentId')))
        self_id = self._text(current.get('id'))
        if parent:
            parent = self._uuid_of(parent)
            if parent == self_id:
                raise BizError('上级字典不能是自己')
            if not query_one('SELECT `id` FROM `sysdict` WHERE `id`=%s LIMIT 1', (parent,)):
                raise BizError('上级字典不存在或已被删除', 404)
            if self_id:    # 防环：新上级不能是自己的后代
                all_rows = query_all('SELECT `id`,`parentId` FROM `sysdict`') or []
                stack, seen = [self_id], set()
                while stack:
                    cur = stack.pop()
                    for one in all_rows:
                        uid = str(one.get('id'))
                        if self._text(one.get('parentId')) == cur and uid not in seen:
                            seen.add(uid)
                            stack.append(uid)
                if parent in seen:
                    raise BizError('不能把字典移动到自己的下级字典之下')
        picked = self._picked_common(data, current)
        picked['dictNameCn'] = cn
        picked['dictNameEn'] = en
        picked['parentId'] = parent or None
        return picked

    def delete(self, data):
        """删除字典：级联清理键值明细，并把子字典的 parentId 置空（升为顶级）"""
        data = data or {}
        uid = self._uuid_of(data.get('id'))
        row = self._find(uid)
        items = query_all('SELECT `id` FROM `sysdictitems` WHERE `dictId`=%s', (uid,)) or []
        execute('DELETE FROM `sysdictitems` WHERE `dictId`=%s', (uid,))
        kids = query_all('SELECT `id` FROM `sysdict` WHERE `parentId`=%s', (uid,)) or []
        execute('UPDATE `sysdict` SET `parentId`=NULL WHERE `parentId`=%s', (uid,))
        execute('DELETE FROM `sysdict` WHERE `id`=%s', (uid,))
        out = self._attach([dump_row(row)])[0]
        out['deletedItems'] = len(items)
        out['detachedChildren'] = len(kids)
        out['message'] = '字典「%s」已删除（清理 %d 条键值，%d 个子字典升为顶级）' % (
            row.get('dictNameCn'), len(items), len(kids))
        return out


class SysDictItemService(SysConfigBaseService):
    """字典明细（sysdictitems）：所属字典 / 键 itemKey / 键值 itemValue / 显示序号 / 说明 / 启用否"""

    table = 'sysdictitems'
    label = '字典键值'
    name_field = 'itemValue'
    keyword_fields = ('itemKey', 'itemValue', 'remark')
    unique_fields = ()          # 复合唯一 (dictId, itemKey) 在 _normalize 里单独校验
    ORDER_BY = '`sortNo` ASC, `id` ASC'

    def _extra_where(self, params):
        dict_id = self._text((params or {}).get('dictId'))
        if dict_id:
            return '`dictId`=%s', [dict_id]
        return '', []

    def _attach(self, items):
        out = SysConfigBaseService._attach(self, items)
        rows = query_all('SELECT `id`,`dictNameCn`,`dictNameEn` FROM `sysdict`') or []
        dmap = {}
        for row in rows:
            one = dump_row(row)
            dmap[str(one.get('id'))] = one
        for it in out:
            one = dmap.get(str(it.get('dictId'))) or {}
            it['dictNameCn'] = one.get('dictNameCn') or ''
            it['dictNameEn'] = one.get('dictNameEn') or ''
            it['itemKey'] = it.get('itemKey') or ''
            it['itemValue'] = it.get('itemValue') or ''
        return out

    def check(self, params):
        """同字典下 itemKey 唯一性校验（field=itemKey，需带 dictId）"""
        params = params or {}
        field = self._text(params.get('field')) or 'itemKey'
        if field != 'itemKey':
            raise BizError('不支持的唯一性校验字段：' + field)
        value, dict_id = self._text(params.get('value')), self._text(params.get('dictId'))
        if not value or not dict_id:
            return {'unique': True}
        row = query_one('SELECT `id` FROM `sysdictitems` '
                        'WHERE `dictId`=%s AND `itemKey`=%s AND `id`<>%s LIMIT 1',
                        (dict_id, value, self._text(params.get('id'))))
        return {'unique': row is None}

    def _normalize(self, data, current, params):
        current = current or {}
        dict_id = self._text(data.get('dictId')) or self._text(current.get('dictId'))
        if not dict_id:
            raise BizError('请选择所属字典')
        dict_id = self._uuid_of(dict_id)
        if not query_one('SELECT `id` FROM `sysdict` WHERE `id`=%s LIMIT 1', (dict_id,)):
            raise BizError('所属字典不存在或已被删除', 404)
        value = self._text(data.get('itemValue')) or self._text(current.get('itemValue'))
        if not value:
            raise BizError('键值不能为空')
        if len(value) > 300:
            raise BizError('键值最多 300 个字符')
        key = (self._text(data.get('itemKey')) if 'itemKey' in data
               else self._text(current.get('itemKey')))
        if len(key) > 150:
            raise BizError('键最多 150 个字符')
        if key:
            dup = query_one('SELECT `id` FROM `sysdictitems` '
                            'WHERE `dictId`=%s AND `itemKey`=%s AND `id`<>%s LIMIT 1',
                            (dict_id, key, self._text(current.get('id'))))
            if dup:
                raise BizError('该字典下键【' + key + '】已存在，请换一个')
        picked = self._picked_common(data, current)
        picked['dictId'] = dict_id
        picked['itemKey'] = key or None
        picked['itemValue'] = value
        return picked


class SysParaService(SysConfigBaseService):
    """系统参数（syspara）：参数中文名 / 英文名唯一 / 参数值 / 显示序号 / 说明 / 启用否"""

    table = 'syspara'
    label = '系统参数'
    name_field = 'paraNameCn'
    keyword_fields = ('paraNameCn', 'paraNameEn', 'paraValue', 'remark')
    unique_fields = (('paraNameEn', '参数英文名'),)
    ORDER_BY = '`sortNo` ASC, `paraNameEn` ASC'

    def _attach(self, items):
        out = SysConfigBaseService._attach(self, items)
        for it in out:
            it['paraValue'] = it.get('paraValue') or ''
        return out

    def _normalize(self, data, current, params):
        current = current or {}
        cn = self._text(data.get('paraNameCn')) or self._text(current.get('paraNameCn'))
        if not cn:
            raise BizError('参数中文名不能为空')
        if len(cn) > 150:
            raise BizError('参数中文名最多 150 个字符')
        en = self._name_en(data.get('paraNameEn') if 'paraNameEn' in data else current.get('paraNameEn'),
                           '参数英文名')
        value = (self._text(data.get('paraValue')) if 'paraValue' in data
                 else self._text(current.get('paraValue')))
        if len(value) > 1000:
            raise BizError('参数值最多 1000 个字符')
        picked = self._picked_common(data, current)
        picked['paraNameCn'] = cn
        picked['paraNameEn'] = en
        picked['paraValue'] = value or None
        return picked


sys_dict_service = SysDictService()
sys_dict_item_service = SysDictItemService()
sys_para_service = SysParaService()


class NotifyService(object):
    """主框架「消息提醒中心」聚合接口：GET /api/notify/summary

    一次请求同时给出两类未读，供 main.html 顶栏铃铛（红点 + 下拉分「新对话 / 新邮件」）
    与左侧菜单上标使用：
      · im   = 站内即时对话未读（按发件人聚合，含最近一条内容，最多 8 人）；
      · mail = 「我的邮箱」收件箱未读（含最近 5 封的主题），未配置信箱时 configured=False。
    任一子系统异常都降级成空数据，**不能让主框架的轮询把整个框架页带崩**；
    只有 401（登录态问题）照常抛出，交给统一的登录失效流程。
    """

    def summary(self, params=None):
        params = params or {}
        out = {
            'im': {'unread': 0, 'peers': []},
            'mail': {'configured': False, 'unread': 0, 'items': []},
            'total': 0,
            'serverTime': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        }
        try:
            out['im'] = emp_message_service.unread_summary(params)
        except BizError as exc:
            if exc.code == 401:
                raise
            out['im']['message'] = exc.message
        except Exception as exc:
            out['im']['message'] = str(exc)
        try:
            out['mail'] = emp_mail_service.unread_summary(params)
        except BizError as exc:
            if exc.code == 401:
                raise
            out['mail']['message'] = exc.message
        except Exception as exc:
            out['mail']['message'] = str(exc)
        out['total'] = int(out['im'].get('unread') or 0) + int(out['mail'].get('unread') or 0)
        return out


notify_service = NotifyService()


def start_mail_worker():
    """按配置启动自动收件线程；返回线程对象（未启动时返回 None）"""
    global mail_worker
    if mail_worker is not None:
        return mail_worker
    if not config.MAIL_AUTO_SYNC or config.MAIL_SYNC_MINUTES <= 0:
        return None
    mail_worker = MailSyncWorker(config.MAIL_SYNC_MINUTES * 60, config.MAIL_SYNC_DELAY)
    mail_worker.start()
    print('[mail-sync] 自动收件已启动：每 %s 分钟一次（首次 %s 秒后）'
          % (config.MAIL_SYNC_MINUTES, config.MAIL_SYNC_DELAY))
    return mail_worker



# =====================================================================
# 工作计划（甘特图 / 日历图 / 网格列表 三种风格）
# ---------------------------------------------------------------------
# 与「项目计划 v2」解耦：工作计划是通用的可视化排期图，自身带启动派单与通知。
# 一张工作计划 = workplans 一行 + workplantasks 多行（整图保存用 /api/workplan/save）。
# 任务模型对齐 Microsoft Visio 甘特图：
#   task 任务条 / milestone 里程碑（工期 0 的菱形）/ summary 摘要任务（缩进汇总条）；
#   parentId 缩进层级、preTaskIds 前置依赖（画布画箭头）、progress 完成百分比；
#   execStatus / actualStartDate / actualEndDate / execRemark = 任务执行记录。
# 工单关联：workplanorders.taskId → workplantasks.id（一任务一单，唯一键保证）；
#   detail() 回带工单编号 / 状态，orders() JOIN 任务读执行记录，双向都能对上。
# 可见性与项目模块同口径：本人创建 OR ispub=1（他人公用记录仍可编辑）。
# =====================================================================
class WorkPlanService(object):
    PLAN_TABLE = 'workplans'
    TASK_TABLE = 'workplantasks'
    ORDER_TABLE = 'workplanorders'
    ORDER_PREFIX = 'WO'
    EMP_SQL = ProjectPlanService.EMP_SQL
    LOGIN_SQL = ProjectBaseService.LOGIN_SQL
    TASK_TYPES = ('task', 'milestone', 'summary')
    ORDER_KINDS = ('plan', 'bug-dev', 'bug-test', 'bug-accept')
    SCALES = ('day', 'week', 'month')
    EXEC_STATUSES = ('未开始', '进行中', '已完成', '已延期', '已取消')
    ORDER_STATUSES = ('待处理', '处理中', '已完成')
    CODE_PREFIX = 'WP'
    CODE_DIGITS = 6
    MAX_TASKS = 200
    MAX_PARTICIPANTS = 50
    PEOPLE_STATUS = {1: '在职', 2: '试用', 0: '离职'}

    # 变更日志 / 多次执行记录（含多附件）
    LOG_TABLE = 'workplanchangelogs'
    EXEC_TABLE = 'workplanexecs'
    EXECFILE_TABLE = 'workplanexecfiles'
    UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads', 'workplan')
    MAILQ_TABLE = 'workplanmailqueue'

    # ---------------- 小工具 ----------------
    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _int(value, default=0):
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _bool(value, default=1):
        if value is None or value == '':
            return default
        if isinstance(value, bool):
            return 1 if value else 0
        return 1 if str(value).strip().lower() in ('1', 'true', 'yes', 'on') else 0

    @staticmethod
    def _uuid(value, label='id'):
        text = WorkPlanService._text(value).lower()
        if not text:
            return ''
        if not RE_UUID.match(text):
            raise BizError('参数 %s 不合法（应为 UUID）' % label)
        return text

    @staticmethod
    def _date(value, label='日期'):
        text = WorkPlanService._text(value)[:10]
        if not text:
            return ''
        try:
            datetime.datetime.strptime(text, '%Y-%m-%d')
        except ValueError:
            raise BizError('%s 格式不正确（应为 YYYY-MM-DD）' % label)
        return text

    @staticmethod
    def _day(text):
        """'YYYY-MM-DD' → 天序号，用于比较与自动扩展时间刻度"""
        if not text:
            return None
        try:
            return datetime.datetime.strptime(text[:10], '%Y-%m-%d').date().toordinal()
        except ValueError:
            return None

    def _me(self, params):
        user_id = self._text((params or {}).get('_loginUserId'))
        if not user_id:
            raise BizError('登录已失效，请重新登录', 401)
        try:
            row = query_one(self.LOGIN_SQL, (user_id,))
        except Exception:
            row = None
        emp_id = self._int((row or {}).get('empId'))
        if not emp_id:
            raise BizError('当前登录账号未绑定员工，无法维护工作计划')
        return emp_id, self._text((row or {}).get('empName'))

    def _plan(self, plan_id):
        try:
            row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.PLAN_TABLE,
                            (self._uuid(plan_id, '计划ID'),))
        except Exception:
            row = None
        if not row:
            raise BizError('工作计划不存在或已被删除', 404)
        return dump_row(row) or {}

    def _visible(self, row, me):
        if self._int(row.get('createempinfosid')) == me or self._int(row.get('ispub')) == 1:
            return
        raise BizError('没有权限查看这条工作计划', 403)

    def _next_code(self):
        pattern = '^%s[0-9]{%d}$' % (self.CODE_PREFIX, self.CODE_DIGITS)
        rows = query_all('SELECT `planCode` AS `code` FROM `%s` WHERE `planCode` REGEXP %%s'
                         % self.PLAN_TABLE, (pattern,)) or []
        seq = 0
        for row in rows:
            try:
                seq = max(seq, int(self._text(row.get('code'))[len(self.CODE_PREFIX):]))
            except (TypeError, ValueError):
                continue
        while seq < 999999:
            seq += 1
            code = '%s%0*d' % (self.CODE_PREFIX, self.CODE_DIGITS, seq)
            if not query_one('SELECT `id` FROM `%s` WHERE `planCode`=%%s LIMIT 1'
                             % self.PLAN_TABLE, (code,)):
                return code
        raise BizError('工作计划编号已超出上限')

    @staticmethod
    def _short_date(value):
        text = WorkPlanService._text(value)
        return text[:10] if text else ''

    def _plan_out(self, row):
        out = dict(row)
        out['startDate'] = self._short_date(row.get('startDate'))
        out['endDate'] = self._short_date(row.get('endDate'))
        out['skipWeekend'] = self._int(row.get('skipWeekend'))
        out['ispub'] = self._int(row.get('ispub'))
        out['enabled'] = self._int(row.get('enabled'))
        out['status'] = self._text(row.get('status')) or '未启动'
        out['startTime'] = time_text(row.get('startTime'))
        return out

    # ---------------- 入参归一化 ----------------
    def _normalize_plan(self, data, old=None, me=0, ename=''):
        data = data or {}
        old = old or {}
        name = self._text(data.get('planName'))
        if not name:
            raise BizError('计划名称不能为空')
        if len(name) > 150:
            raise BizError('计划名称不能超过 150 个字符')
        project_id = self._uuid(data.get('projectId'), '关联项目ID')
        project_name = self._text(data.get('projectName'))
        if project_id:
            try:
                prow = query_one('SELECT `projectName` FROM `projectinfos` WHERE `id`=%s LIMIT 1',
                                 (project_id,))
            except Exception:
                prow = None
            project_name = self._text((prow or {}).get('projectName')) or project_name
        start = self._date(data.get('startDate'), '计划开始日期')
        end = self._date(data.get('endDate'), '计划结束日期')
        if start and end and self._day(start) > self._day(end):
            raise BizError('计划开始日期不能晚于结束日期')
        scale = self._text(data.get('scale')) or 'day'
        if scale not in self.SCALES:
            raise BizError('时间刻度只能是 day / week / month')
        desc = self._text(data.get('planDesc'))[:2000]
        out = {
            'planName': name, 'projectId': project_id or None, 'projectName': project_name or None,
            'startDate': start or None, 'endDate': end or None, 'planDesc': desc or None,
            'scale': scale,
            'skipWeekend': self._bool(data.get('skipWeekend'), 0),
            'ispub': self._bool(data.get('ispub'), 1),
            'enabled': self._bool(data.get('enabled'), 1),
        }
        if not old:
            out['id'] = str(uuid.uuid4())
            out['planCode'] = self._next_code()
            out['createEname'] = ename or None
            out['createempinfosid'] = me or None
        return out

    def _people(self, t):
        """责任人 / 参与人员归一化（口径与项目计划 v2 的 ownerId / participantIds 一致）。

        · ownerId 是 empinfos.id；未关联员工时允许只留自由文本 ownerName（兼容老数据）；
        · 参与人员同时存 ID 与姓名快照，两者按下标对齐、去重、限量，避免员工改名后串行。
        """
        text = self._text
        try:
            owner_id = max(0, int(str(t.get('ownerId') or 0).strip()))
        except (TypeError, ValueError):
            owner_id = 0
        owner_name = text(t.get('ownerName'))[:50]

        def as_list(value):
            if isinstance(value, (list, tuple)):
                return [text(x) for x in value]
            return [x.strip() for x in text(value).split(',')]

        raw_ids = [x for x in as_list(t.get('participantIds')) if x]
        raw_names = as_list(t.get('participantNames'))
        ids, names, seen = [], [], {}
        for i, pid in enumerate(raw_ids):
            if pid in seen or len(ids) >= self.MAX_PARTICIPANTS:
                continue
            seen[pid] = 1
            ids.append(pid)
            names.append((raw_names[i] if i < len(raw_names) else '')[:50])
        return {
            'ownerId': owner_id,
            'ownerName': owner_name or None,
            'participantIds': ','.join(ids) or None,
            'participantNames': ','.join(names) or None,
        }

    def _normalize_tasks(self, tasks):
        if tasks is None:
            tasks = []
        if not isinstance(tasks, (list, tuple)):
            raise BizError('任务数据格式不正确（应为数组）')
        if len(tasks) > self.MAX_TASKS:
            raise BizError('一张工作计划最多 %d 条任务' % self.MAX_TASKS)
        rows, ids = [], {}
        for i, raw in enumerate(tasks):
            t = raw if isinstance(raw, dict) else {}
            name = self._text(t.get('taskName'))
            if not name:
                raise BizError('第 %d 行任务名称不能为空' % (i + 1))
            if len(name) > 200:
                raise BizError('第 %d 行任务名称不能超过 200 个字符' % (i + 1))
            tid = self._uuid(t.get('id'), '任务ID') or str(uuid.uuid4())
            if tid in ids:
                raise BizError('任务ID重复：%s' % tid)
            ids[tid] = 1
            kind = self._text(t.get('taskType')) or 'task'
            if kind not in self.TASK_TYPES:
                raise BizError('任务「%s」的类型不合法' % name)
            # 派单来源：缺陷管理建的修复任务会带 bug-dev / bug-test / bug-accept，
            # 普通计划任务一律 plan（工作量统计只排除 bug-accept）
            order_kind = self._text(t.get('orderKind')) or 'plan'
            if order_kind not in self.ORDER_KINDS:
                order_kind = 'plan'
            start = self._date(t.get('startDate'), '任务「%s」开始日期' % name)
            end = self._date(t.get('endDate'), '任务「%s」结束日期' % name)
            if not start and not end:
                today = datetime.date.today().strftime('%Y-%m-%d')
                start = end = today
            start = start or end
            end = end or start
            if kind == 'milestone':
                end = start                      # Visio：里程碑工期为 0
            if self._day(start) > self._day(end):
                raise BizError('任务「%s」的开始日期不能晚于结束日期' % name)
            progress = min(100, max(0, self._int(t.get('progress'))))
            # 执行记录：完成状态 / 实际起止 / 执行说明（工单页回填后整图保存不能丢）
            exec_status = self._text(t.get('execStatus')) or '未开始'
            if exec_status not in self.EXEC_STATUSES:
                raise BizError('任务「%s」的完成状态不合法' % name)
            actual_start = self._date(t.get('actualStartDate'), '任务「%s」实际开始时间' % name)
            actual_end = self._date(t.get('actualEndDate'), '任务「%s」实际结束时间' % name)
            if actual_start and actual_end and self._day(actual_start) > self._day(actual_end):
                raise BizError('任务「%s」的实际开始时间不能晚于实际结束时间' % name)
            exec_remark = self._text(t.get('execRemark'))[:1000]
            pre_raw = t.get('preTaskIds')
            if isinstance(pre_raw, (list, tuple)):
                pre_list = [self._text(x) for x in pre_raw]
            else:
                pre_list = [x.strip() for x in self._text(pre_raw).split(',')]
            pre, seen = [], {}
            for p in pre_list:
                if p and p != tid and not seen.get(p):
                    seen[p] = 1
                    pre.append(p)
            people = self._people(t)
            rows.append({
                'id': tid, 'taskName': name, 'taskType': kind, 'orderKind': order_kind,
                'parentId': self._uuid(t.get('parentId'), '上级摘要任务ID') or None,
                'startDate': start, 'endDate': end, 'progress': progress,
                'execStatus': exec_status, 'actualStartDate': actual_start or None,
                'actualEndDate': actual_end or None, 'execRemark': exec_remark or None,
                'preTaskIds': '',                      # 下面按 valid_ids 过滤后回填
                'ownerName': people['ownerName'], 'ownerId': people['ownerId'],
                'participantIds': people['participantIds'],
                'participantNames': people['participantNames'],
                'sortNo': self._int(t.get('sortNo'), i),
                'color': self._text(t.get('color'))[:20] or None,
                '_pre': pre,
            })
        valid_ids = set(ids.keys())
        for r in rows:
            r['preTaskIds'] = ','.join([p for p in r['_pre'] if p in valid_ids and p != r['id']]) or None
            if r['parentId'] and r['parentId'] not in valid_ids:
                r['parentId'] = None           # 悬空父任务按顶级处理，不丢数据
        self._check_dependency_cycle(rows)
        self._check_parent_cycle(rows)
        return rows

    @staticmethod
    def _check_dependency_cycle(rows):
        graph = {}
        for r in rows:
            graph[r['id']] = [p for p in (r['preTaskIds'] or '').split(',') if p]
        state = {}

        def visit(node):
            if state.get(node) == 1:
                raise BizError('前置依赖存在循环，请检查任务之间的链接')
            if state.get(node) == 2:
                return
            state[node] = 1
            for nxt in graph.get(node, []):
                visit(nxt)
            state[node] = 2

        for r in rows:
            visit(r['id'])

    @staticmethod
    def _check_parent_cycle(rows):
        parents = dict((r['id'], r['parentId']) for r in rows)
        for r in rows:
            cur, seen = r['parentId'], set()
            while cur:
                if cur == r['id'] or cur in seen:
                    raise BizError('摘要任务层级存在循环，请调整缩进')
                seen.add(cur)
                cur = parents.get(cur)

    # ---------------- 对外接口 ----------------
    def page(self, params):
        params = params or {}
        me, _name = self._me(params)
        where, args = ['1=1'], []
        keyword = self._text(params.get('keyword'))
        if keyword:
            like = '%' + keyword + '%'
            where.append('(l.`planCode` LIKE %s OR l.`planName` LIKE %s OR '
                         'l.`projectName` LIKE %s OR l.`planDesc` LIKE %s)')
            args.extend([like, like, like, like])
        project_id = self._text(params.get('projectId'))
        if project_id:
            where.append('l.`projectId`=%s')
            args.append(self._uuid(project_id, 'projectId'))
        if not params.get('_noVisibility'):
            where.append('(l.`createempinfosid`=%s OR l.`ispub`=1)')
            args.append(me)
        base = ('FROM `%s` l WHERE %s' % (self.PLAN_TABLE, ' AND '.join(where)))
        total = self._int((query_one('SELECT COUNT(*) AS n ' + base, tuple(args)) or {}).get('n'))
        page_num = max(1, self._int(params.get('pageNum'), 1))
        page_size = min(200, max(1, self._int(params.get('pageSize'), 10)))
        rows = query_all(
            'SELECT l.*, '
            '(SELECT COUNT(*) FROM `%s` t WHERE t.`planId`=l.`id`) AS `taskCount`, '
            '(SELECT IFNULL(ROUND(AVG(t.`progress`)),0) FROM `%s` t WHERE t.`planId`=l.`id`) AS `progress` '
            % (self.TASK_TABLE, self.TASK_TABLE) +
            base + ' ORDER BY l.`createTime` DESC, l.`planCode` ASC LIMIT %s OFFSET %s',
            tuple(args + [page_size, (page_num - 1) * page_size])) or []
        out = []
        for r in rows:
            item = self._plan_out(dump_row(r))
            item['isCreator'] = (self._creator_id(item) == me)
            out.append(item)
        return {'list': out,
                'total': total, 'pageNum': page_num, 'pageSize': page_size,
                'pages': int((total + page_size - 1) / page_size) if total else 0}

    def detail(self, params):
        params = params or {}
        me, _name = self._me(params)
        row = self._plan(params.get('id'))
        if not params.get('_noVisibility'):
            self._visible(row, me)
        # 工单 ↔ 任务：按 taskId LEFT JOIN 回带工单编号 / 状态，任务属性里就能看到关联工单
        join_sql = ('SELECT t.*, o.`id` AS `orderId`, o.`orderCode`, o.`status` AS `orderStatus`, '
                    'o.`dispatchTime` FROM `%s` t LEFT JOIN `%s` o ON o.`taskId`=t.`id` '
                    'WHERE t.`planId`=%%s ORDER BY t.`sortNo`,t.`createTime`,t.`id`'
                    % (self.TASK_TABLE, self.ORDER_TABLE))
        try:
            rows = query_all(join_sql, (row['id'],)) or []
        except Exception:
            # 老库尚未执行 workplan-start.sql 时退回单表查询，页面仍可用
            rows = query_all('SELECT * FROM `%s` WHERE `planId`=%%s ORDER BY `sortNo`,`createTime`,`id`'
                             % self.TASK_TABLE, (row['id'],)) or []
        tasks = []
        for r in rows:
            t = dump_row(r)
            t['startDate'] = self._short_date(t.get('startDate'))
            t['endDate'] = self._short_date(t.get('endDate'))
            t['actualStartDate'] = self._short_date(t.get('actualStartDate'))
            t['actualEndDate'] = self._short_date(t.get('actualEndDate'))
            t['progress'] = self._int(t.get('progress'))
            t['sortNo'] = self._int(t.get('sortNo'))
            t['ownerId'] = self._int(t.get('ownerId'))
            t['execStatus'] = self._text(t.get('execStatus')) or '未开始'
            # 老库没跑 workplan-people.sql / workplan-exec.sql 时也要给前端稳定结构
            for field in ('ownerName', 'participantIds', 'participantNames', 'execRemark'):
                t[field] = self._text(t.get(field)) if t.get(field) is not None else ''
            for field in ('orderId', 'orderCode', 'orderStatus'):
                t[field] = self._text(t.get(field))
            t['dispatchTime'] = time_text(t.get('dispatchTime'))
            t['orderLinked'] = bool(t['orderId'])
            tasks.append(t)
        counts = {}
        try:
            for er in (query_all('SELECT `taskId`,COUNT(*) AS n FROM `%s` '
                                 'WHERE `planId`=%%s GROUP BY `taskId`' % self.EXEC_TABLE,
                                 (row['id'],)) or []):
                counts[self._text(er.get('taskId'))] = self._int(er.get('n'))
        except Exception:
            counts = {}
        for t in tasks:
            t['execCount'] = counts.get(self._text(t.get('id')), 0)
        plan_out = self._plan_out(row)
        plan_out['isCreator'] = (self._creator_id(row) == me)
        return {'plan': plan_out, 'tasks': tasks, 'isCreator': plan_out['isCreator']}

    def next_code(self, params=None):
        self._me(params or {})
        return {'code': self._next_code()}

    def add(self, params):
        params = params or {}
        me, ename = self._me(params)
        values = self._normalize_plan(params, me=me, ename=ename)
        cols = list(values.keys())
        sql = 'INSERT INTO `%s` (%s) VALUES (%s)' % (
            self.PLAN_TABLE, ','.join(['`%s`' % c for c in cols]),
            ','.join(['%s'] * len(cols)))
        try:
            execute(sql, tuple([values[c] for c in cols]))
        except DuplicateError:
            raise BizError('工作计划编号已存在，请重试')
        return {'id': values['id'], 'planCode': values['planCode'],
                'message': '工作计划已创建（%s）' % values['planCode']}

    def update(self, params):
        params = params or {}
        me, _ename = self._me(params)
        old = self._plan(params.get('id'))
        self._visible(old, me)
        values = self._normalize_plan(params, old=old, me=me)
        cols = list(values.keys())
        execute('UPDATE `%s` SET %s WHERE `id`=%%s' % (
            self.PLAN_TABLE, ','.join(['`%s`=%%s' % c for c in cols])),
            tuple([values[c] for c in cols] + [old['id']]))
        return {'id': old['id'], 'planCode': old['planCode'], 'message': '工作计划已更新'}

    def plan_orders(self, params):
        """计划 / 项目维度的全部工单（不只与我相关）。

        - planId：指定计划（必须对该计划可见）；
        - projectId：按项目汇总；`__none__` 表示「未关联项目」的计划；
        - 不传 planId / projectId：所有我能看到的计划（我创建 or ispub=1）的全部工单；
        - 返回 projects 供前端项目下拉（含「未关联项目」）。
        """
        params = params or {}
        me, _name = self._me(params)
        plan_id = self._uuid(params.get('planId'), '计划ID') if params.get('planId') else ''
        project_id = self._text(params.get('projectId'))
        keyword = self._text(params.get('keyword')).lower()
        def multi_of(raw):
            if isinstance(raw, (list, tuple)):
                return [self._text(x) for x in raw if self._text(x)]
            return [x.strip() for x in self._text(raw).split(',') if x.strip()]
        statuses = multi_of(params.get('status'))
        exec_statuses = multi_of(params.get('execStatus'))
        owner_kw = self._text(params.get('owner')).lower()

        plans = []
        try:
            plans = [dump_row(r) for r in (query_all('SELECT * FROM `%s`' % self.PLAN_TABLE) or [])]
        except Exception:
            plans = []
        visible = {}
        for p in plans:
            pid = self._text(p.get('id'))
            if plan_id and pid != plan_id:
                continue
            if self._creator_id(p) == me or self._int(p.get('ispub')) == 1:
                visible[pid] = p
        if plan_id and plan_id not in visible:
            target = None
            for p in plans:
                if self._text(p.get('id')) == plan_id:
                    target = p
                    break
            if target and self._project_access(target.get('projectId'), me):
                visible[plan_id] = target       # 项目全员可见：项目创建人 / 成员 / 公用项目
            else:
                raise BizError('没有权限查看该工作计划', 403)

        def project_of(plan):
            return self._text(plan.get('projectId'))

        if project_id == '__none__':
            visible = dict((k, v) for k, v in visible.items() if not project_of(v))
        elif project_id:
            visible = dict((k, v) for k, v in visible.items() if project_of(v) == project_id)

        project_names = {}
        for v in visible.values():
            key = project_of(v) or '__none__'
            project_names[key] = self._text(v.get('projectName')) or (
                '未关联项目' if key == '__none__' else key)

        plan_ids = list(visible.keys())
        if not plan_ids:
            return {'list': [], 'total': 0, 'pageNum': 1, 'pageSize': 10, 'pages': 0,
                    'projects': self._project_options(plans, me), 'summary': []}
        marks = ','.join(['%s'] * len(plan_ids))
        orders = []
        try:
            orders = [dump_row(r) for r in (query_all(
                'SELECT o.*, t.`taskName`, t.`execStatus`, t.`progress`, '
                't.`actualStartDate`, t.`actualEndDate`, '
                'COALESCE(t.`startDate`, o.`startDate`) AS `curStartDate`, '
                'COALESCE(t.`endDate`, o.`endDate`) AS `curEndDate` '
                'FROM `%s` o LEFT JOIN `%s` t ON t.`id`=o.`taskId` '
                'WHERE o.`planId` IN (%s) ORDER BY o.`planId`,o.`taskId`'
                % (self.ORDER_TABLE, self.TASK_TABLE, marks), tuple(plan_ids)) or [])]
        except Exception:
            orders = []

        task_ids = [self._text(o.get('taskId')) for o in orders if self._text(o.get('taskId'))]
        exec_counts, change_counts = {}, {}
        if task_ids:
            tmarks = ','.join(['%s'] * len(task_ids))
            try:
                for r in (query_all('SELECT `taskId`,COUNT(*) AS n FROM `%s` '
                                    'WHERE `taskId` IN (%s) GROUP BY `taskId`'
                                    % (self.EXEC_TABLE, tmarks), tuple(task_ids)) or []):
                    exec_counts[self._text(r.get('taskId'))] = self._int(r.get('n'))
            except Exception:
                pass
            try:
                for r in (query_all('SELECT `taskId`,COUNT(*) AS n FROM `%s` '
                                    'WHERE `taskId` IN (%s) GROUP BY `taskId`'
                                    % (self.LOG_TABLE, tmarks), tuple(task_ids)) or []):
                    change_counts[self._text(r.get('taskId'))] = self._int(r.get('n'))
            except Exception:
                pass

        out = []
        for o in orders:
            oid_plan = self._text(o.get('planId'))
            plan = visible.get(oid_plan) or {}
            key = project_of(plan) or '__none__'
            item = {
                'orderId': self._text(o.get('id')), 'orderCode': self._text(o.get('orderCode')),
                'taskId': self._text(o.get('taskId')),
                'taskName': self._text(o.get('taskName')) or self._text(o.get('orderTitle')),
                'planId': oid_plan, 'planCode': self._text(plan.get('planCode')),
                'planName': self._text(plan.get('planName')),
                'projectId': '' if key == '__none__' else key,
                'projectKey': key,
                'projectName': project_names.get(key, '未关联项目'),
                'ownerId': self._int(o.get('ownerId')), 'ownerName': self._text(o.get('ownerName')),
                'participantIds': self._text(o.get('participantIds')),
                'participantNames': self._text(o.get('participantNames')),
                'status': self._text(o.get('status')) or '待处理',
                'execStatus': self._text(o.get('execStatus')) or '未开始',
                'startDate': self._short_date(o.get('curStartDate')),
                'endDate': self._short_date(o.get('curEndDate')),
                'actualStartDate': self._short_date(o.get('actualStartDate')),
                'actualEndDate': self._short_date(o.get('actualEndDate')),
                'progress': self._int(o.get('progress')),
                'dispatchTime': time_text(o.get('dispatchTime')),
                'actualStartTime': time_text(o.get('actualStartTime')),
                'actualEndTime': time_text(o.get('actualEndTime')),
                'acceptStatus': self._text(o.get('acceptStatus')) or '待验收',
                'acceptorName': self._text(o.get('acceptorName')),
                'acceptTime': time_text(o.get('acceptTime')),
                'acceptRemark': self._text(o.get('acceptRemark')),
                'noticeMsg': bool(self._int(o.get('noticeMsg'))),
                'noticeMail': bool(self._int(o.get('noticeMail'))),
                'execCount': exec_counts.get(self._text(o.get('taskId')), 0),
                'changeCount': change_counts.get(self._text(o.get('taskId')), 0),
            }
            if keyword and keyword not in ('%s %s %s %s %s' % (
                    item['orderCode'], item['taskName'], item['planName'],
                    item['planCode'], item['ownerName'])).lower():
                continue
            if statuses and item['status'] not in statuses:
                continue
            if exec_statuses and item['execStatus'] not in exec_statuses:
                continue
            if owner_kw and owner_kw not in item['ownerName'].lower():
                continue
            out.append(item)

        # 排序：项目（未关联项目排最后）→ 计划编号 → 工单号
        out.sort(key=lambda it: (1 if it.get('projectKey') == '__none__' else 0,
                                 it.get('projectName') or '', it.get('planCode') or '',
                                 it.get('orderCode') or ''))

        # 汇总：按项目 -> 计划
        summary_map = {}
        for it in out:
            key = it['projectKey']
            g = summary_map.setdefault(key, {'projectKey': key, 'projectName': it['projectName'],
                                             'orders': 0, 'plans': {}})
            g['orders'] += 1
            g['plans'][it['planId']] = it['planName']
        summary = []
        for key in sorted(summary_map.keys(), key=lambda k: (k == '__none__', k)):
            g = summary_map[key]
            summary.append({'projectKey': key, 'projectName': g['projectName'],
                            'orders': g['orders'], 'planCount': len(g['plans'])})

        page_num = max(1, self._int(params.get('pageNum'), 1))
        page_size = min(200, max(1, self._int(params.get('pageSize'), 10)))
        total = len(out)
        return {'list': out[(page_num - 1) * page_size: page_num * page_size],
                'total': total, 'pageNum': page_num, 'pageSize': page_size,
                'pages': int((total + page_size - 1) / page_size) if total else 0,
                'projects': self._project_options(plans, me), 'summary': summary}

    # ---------------- Excel 导入：模板生成 / 文件解析（只解析，不落库） ----------------
    # 列定义是**唯一口径**：模板表头、列宽、单元格批注、解析时的列定位全部读 IMPORT_COLUMNS，
    # 改口径只改这一处，不会出现「模板改了、解析没跟上」。
    # 导入链路：下载模板 → 选文件（base64）→ 解析归一化 + 逐行校验 → 前端预览 → 写入画布 → 用户点保存。
    # 这里绝不写库：整图保存会连带写变更日志、发变更通知、给已启动计划补派工单，
    # 必须由用户在画面上核对甘特图后再触发。
    IMPORT_COLUMNS = (
        # (key, 表头, 必填 0/1, 列宽, 单元格批注)
        ('seq', '序号', 0, 8, '自动编号，仅用于「前置任务」引用；留空按行顺序生成'),
        ('level', '层级', 1, 8, '1=顶层，2=子任务…最多 8 级；有子行的任务导入后自动变成「摘要任务」'),
        ('taskName', '任务名称', 1, 36, '必填，最长 200 字'),
        ('taskType', '任务类型', 0, 12, '任务 / 里程碑 / 摘要任务；留空按「任务」处理（里程碑工期为 0）'),
        ('startDate', '开始日期', 0, 13, 'YYYY-MM-DD，也可用 Excel 日期格式；留空取今天'),
        ('endDate', '结束日期', 0, 13, 'YYYY-MM-DD；与「工期(天)」二选一，都填以结束日期为准'),
        ('duration', '工期(天)', 0, 10, '含首尾的自然日天数：填写开始日期 + 工期即可推出结束日期'),
        ('owner', '责任人', 0, 24, '格式「工号 姓名」，如 E00001 张三；只写工号或只写姓名也认，重名必须写工号'),
        ('participants', '参与人员', 0, 44, '多人用逗号分隔，每人格「工号 姓名」：E00001 张三,E00002 李四'),
        ('preTask', '前置任务', 0, 16, '填「序号」，多个用逗号分隔；不能引用自己'),
    )
    # 表头别名：兼容用户把「开始日期」写成「开始」、「参与人员」写成「参与人」等情况
    IMPORT_ALIASES = {
        '序号': 'seq', '编号': 'seq', '行号': 'seq',
        '层级': 'level', '级别': 'level', '缩进': 'level', 'wbs': 'level',
        '任务名称': 'taskName', '任务名': 'taskName', '任务': 'taskName', '名称': 'taskName',
        '任务类型': 'taskType', '类型': 'taskType',
        '开始日期': 'startDate', '开始时间': 'startDate', '开始': 'startDate', '计划开始': 'startDate',
        '结束日期': 'endDate', '结束时间': 'endDate', '结束': 'endDate', '计划结束': 'endDate',
        '工期(天)': 'duration', '工期（天）': 'duration', '工期': 'duration', '天数': 'duration',
        '责任人': 'owner', '负责人': 'owner', '执行人': 'owner',
        '参与人员': 'participants', '参与人': 'participants', '协办人': 'participants',
        '前置任务': 'preTask', '前置依赖': 'preTask', '前置': 'preTask',
    }
    IMPORT_TYPE_ALIASES = {
        '任务': 'task', 'task': 'task',
        '里程碑': 'milestone', 'milestone': 'milestone',
        '摘要': 'summary', '摘要任务': 'summary', 'summary': 'summary',
    }
    IMPORT_MAX_BYTES = 5 * 1024 * 1024
    IMPORT_MAX_LEVEL = 8
    XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

    @staticmethod
    def _import_date(value, label):
        """单元格 → ('YYYY-MM-DD', 错误提示)；接受 Excel 日期 / datetime / 2026-11-01 / 2026.11.1 / 20261101"""
        if value is None or value == '':
            return '', ''
        if isinstance(value, (datetime.datetime, datetime.date)):
            return value.strftime('%Y-%m-%d'), ''
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            try:                      # 未套日期格式的序列号（1900 基准）
                base = datetime.date(1899, 12, 30)
                return (base + datetime.timedelta(days=float(value))).strftime('%Y-%m-%d'), ''
            except Exception:
                return '', '%s 格式不对' % label
        text = str(value).strip()
        m = (re.match(r'^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$', text)
             or re.match(r'^(\d{4})(\d{2})(\d{2})$', text))
        if not m:
            return '', '%s「%s」格式不对（应为 YYYY-MM-DD）' % (label, text[:20])
        try:
            return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).strftime('%Y-%m-%d'), ''
        except ValueError:
            return '', '%s「%s」不是有效日期' % (label, text[:20])

    @staticmethod
    def _split_person(text):
        """「E00001 张三」/「E00001/张三」/「E00001（张三）」/「E00001张三」/「张三」 → (工号, 姓名)"""
        raw = str(text or '').replace('（', '(').replace('）', ')')
        raw = re.sub(r'[()\[\]【】<>]', ' ', raw)
        parts = [p for p in re.split(r'[\s/|\\,，、;；:：]+', raw) if p]
        code, name = '', ''
        for p in parts:
            if not code and re.match(r'^[A-Za-z]{0,3}\d{2,}$', p):
                code = p.upper()
                continue
            name = (name + p) if name else p
        if not code and name:                 # 没有分隔符：E00001张三
            m = re.match(r'^([A-Za-z]{0,3}\d{2,})(.+)$', name)
            if m:
                code, name = m.group(1).upper(), m.group(2)
        return code, name

    def _import_person_index(self):
        """工号 / 姓名 → 员工（一次查全表；同名保留列表，交给调用方判定歧义）"""
        by_code, by_name = {}, {}
        try:
            rows = query_all('SELECT `id`,`code`,`nameCn` FROM `empinfos`') or []
        except Exception:
            rows = []
        for r in rows:
            d = dump_row(r) or {}
            emp_id = self._int(d.get('id'))
            code = self._text(d.get('code')).upper()
            name = self._text(d.get('nameCn'))
            item = {'id': emp_id, 'code': code, 'name': name}
            if not emp_id:
                continue
            if code:
                by_code[code] = item
            if name:
                by_name.setdefault(name, []).append(item)
        return by_code, by_name

    def _resolve_person(self, text, index):
        """单个人员 → (empId, 姓名)；解析不出来抛 ValueError（由调用方收进该行错误）"""
        raw = self._text(text)
        if not raw:
            return 0, ''
        by_code, by_name = index
        code, name = self._split_person(raw)
        if code:
            item = by_code.get(code)
            if not item:
                raise ValueError('工号 %s 在员工信息里不存在' % code)
            if name and name != item['name']:
                raise ValueError('工号 %s 对应「%s」，与填写的「%s」不一致' % (code, item['name'], name))
            return item['id'], item['name']
        if not name:
            raise ValueError('人员「%s」无法识别' % raw[:20])
        hits = by_name.get(name) or []
        if not hits:
            raise ValueError('姓名「%s」在员工信息里找不到' % name)
        if len(hits) > 1:
            raise ValueError('姓名「%s」有 %d 名员工，请写成「工号 姓名」' % (name, len(hits)))
        return hits[0]['id'], hits[0]['name']

    def _parse_import_bytes(self, raw, file_name=''):
        """解析 xlsx → {rows, errors, summary}；每行带 ok 标记，不做任何写库动作。"""
        try:
            from openpyxl import load_workbook
        except Exception:
            raise BizError('服务器未安装 openpyxl，无法解析 Excel（pip install openpyxl）')
        if not raw:
            raise BizError('文件内容为空')
        try:
            wb = load_workbook(io.BytesIO(raw), data_only=True, read_only=True)
        except Exception:
            raise BizError('文件无法解析：请确认是 .xlsx 格式（.xls / .csv 请先另存为 .xlsx）')
        def norm_head(value):
            # 模板表头带 * 必填标记，用户手写时可能写全角空格 / 全角括号，统一抹平后再匹配
            text = re.sub(r'\s+', '', str(value or '')).replace('（', '(').replace('）', ')')
            return text.replace('*', '').replace('＊', '').lower()

        alias = {}
        for title, key in self.IMPORT_ALIASES.items():
            alias[norm_head(title)] = key

        def locate_header(rows):
            """在前 10 行里找表头（任务名称 + 至少一个其它列），返回 (列位置, 表头行下标)"""
            for idx, r in enumerate(rows[:10]):
                found = {}
                for ci, cell in enumerate(r or []):
                    key = alias.get(norm_head(cell))
                    if key and key not in found:
                        found[key] = ci
                if 'taskName' in found and len(found) >= 2:
                    return found, idx
            return None, -1

        # 模板有两张页签（任务列表 / 填写说明），**按表头认页签**：谁认得出表头就用谁，
        # 不能简单取「第一个有数据的页签」，否则会去解析「填写说明」。
        sheets, chosen = [], None
        try:
            for sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                rows = list(ws.iter_rows(values_only=True))
                if not any(any(self._text(c) for c in (r or [])) for r in rows):
                    continue
                sheets.append(rows)
                cols_try, head_try = locate_header(rows)
                if cols_try and chosen is None:
                    chosen = (rows, cols_try, head_try)
        finally:
            try:
                wb.close()
            except Exception:
                pass
        if not sheets:
            raise BizError('Excel 里没有可导入的数据（至少要有一行表头 + 一行任务）')
        if chosen is None:
            raise BizError('没有找到表头：请用「下载模板」生成的表头（至少要有「任务名称」列）')
        cells_rows, cols, head_row = chosen

        data_rows = cells_rows[head_row + 1:]
        if len([r for r in data_rows if any(self._text(c) for c in (r or []))]) > self.MAX_TASKS:
            raise BizError('一次最多导入 %d 条任务，请拆分文件后分批导入' % self.MAX_TASKS)

        today = datetime.date.today().strftime('%Y-%m-%d')
        index = self._import_person_index()
        items, seq_seen, auto_seq, last_level = [], {}, 0, 1
        for offset, r in enumerate(data_rows):
            row_no = head_row + 2 + offset
            cells = list(r or [])

            def cell(key):
                ci = cols.get(key)
                return cells[ci] if ci is not None and ci < len(cells) else None

            if not any(self._text(c) for c in cells):
                continue                      # 整行空白直接跳过，不算错误
            row_errors = []
            name = self._text(cell('taskName'))
            if not name:
                row_errors.append('任务名称不能为空')
            elif len(name) > 200:
                row_errors.append('任务名称不能超过 200 个字符')
                name = name[:200]

            # 层级：留空沿用上一行，避免用户为了省事整列空着
            lv_raw = cell('level')
            if self._text(lv_raw) == '':
                level = last_level
            else:
                try:
                    level = int(float(str(lv_raw).strip()))
                except (TypeError, ValueError):
                    row_errors.append('层级「%s」不是数字' % self._text(lv_raw)[:10])
                    level = last_level
                if level < 1:
                    level = 1
                if level > self.IMPORT_MAX_LEVEL:
                    row_errors.append('层级最多 %d 级' % self.IMPORT_MAX_LEVEL)
                    level = self.IMPORT_MAX_LEVEL
            last_level = level

            kind_raw = self._text(cell('taskType'))
            kind = self.IMPORT_TYPE_ALIASES.get(
                kind_raw.lower() if kind_raw.isascii() else kind_raw, '')
            if kind_raw and not kind:
                row_errors.append('任务类型「%s」不认识（应为 任务 / 里程碑 / 摘要任务）' % kind_raw[:10])
            kind = kind or 'task'

            start, msg = self._import_date(cell('startDate'), '开始日期')
            if msg:
                row_errors.append(msg)
            end, msg = self._import_date(cell('endDate'), '结束日期')
            if msg:
                row_errors.append(msg)

            duration = 0
            dur_raw = self._text(cell('duration'))
            if dur_raw != '':
                try:
                    duration = int(float(dur_raw))
                except (TypeError, ValueError):
                    row_errors.append('工期(天)「%s」不是数字' % dur_raw[:10])
                    duration = 0
                if duration < 0:
                    row_errors.append('工期(天)不能是负数')
                    duration = 0

            if not start and end:
                start = end
            if not start and not end:
                start = end = today           # 与后端保存口径一致：都没填就按今天
            elif start and not end:
                end = start if (kind == 'milestone' or not duration) \
                    else (datetime.date.fromordinal(
                        self._day(start) + duration - 1).strftime('%Y-%m-%d'))
            if kind == 'milestone':
                end = start                   # Visio 口径：里程碑工期为 0
            elif self._day(start) and self._day(end) and self._day(start) > self._day(end):
                row_errors.append('开始日期不能晚于结束日期')
                end = start

            owner_id, owner_name = 0, ''
            owner_raw = self._text(cell('owner'))
            if owner_raw:
                try:
                    owner_id, owner_name = self._resolve_person(owner_raw, index)
                except ValueError as exc:
                    row_errors.append('责任人：%s' % exc)

            part_ids, part_names = [], []
            part_raw = self._text(cell('participants'))
            if part_raw:
                for token in re.split(r'[,，、;；\n]+', part_raw):
                    if not self._text(token):
                        continue
                    try:
                        pid, pname = self._resolve_person(token, index)
                    except ValueError as exc:
                        row_errors.append('参与人员：%s' % exc)
                        continue
                    if pid and pid not in part_ids:
                        if len(part_ids) >= self.MAX_PARTICIPANTS:
                            row_errors.append('参与人员超过 %d 人，超出部分已忽略' % self.MAX_PARTICIPANTS)
                            break
                        part_ids.append(pid)
                        part_names.append(pname)

            pre_seqs = []
            pre_raw = self._text(cell('preTask'))
            if pre_raw:
                for token in re.split(r'[,，、;；\s]+', pre_raw):
                    token = token.strip()
                    if not token:
                        continue
                    try:
                        pre_seqs.append(int(float(token)))
                    except (TypeError, ValueError):
                        row_errors.append('前置任务「%s」不是序号' % token[:10])

            seq_raw = self._text(cell('seq'))
            if seq_raw == '':
                auto_seq += 1
                seq = auto_seq
            else:
                try:
                    seq = int(float(seq_raw))
                except (TypeError, ValueError):
                    row_errors.append('序号「%s」不是数字' % seq_raw[:10])
                    auto_seq += 1
                    seq = auto_seq
                else:
                    auto_seq = max(auto_seq, seq)
            if seq in seq_seen:
                row_errors.append('序号 %d 与第 %d 行重复' % (seq, seq_seen[seq]))
            else:
                seq_seen[seq] = row_no

            items.append({
                'id': str(uuid.uuid4()), 'seq': seq, 'rowNo': row_no, 'level': level,
                'taskName': name, 'taskType': kind, 'startDate': start, 'endDate': end,
                'duration': (self._day(end) - self._day(start) + 1) if (start and end) else 0,
                'ownerId': owner_id, 'ownerName': owner_name,
                'participantIds': ','.join([str(x) for x in part_ids]),
                'participantNames': ','.join(part_names),
                # 原填写文本（如「E00001 张三」）：预览里做 title，方便用户核对
                # 「工号 → 姓名」的匹配结果，不用回 Excel 对照
                'ownerRaw': owner_raw, 'participantRaw': part_raw,
                'preSeqs': pre_seqs, 'preTaskSeqs': [], 'parentSeq': None,
                'errors': row_errors, 'autoType': False, 'ok': not row_errors,
            })

        if not items:
            raise BizError('没有读到任务行：数据请从表头下一行开始，且「任务名称」必须填写')

        # 第二遍：层级栈推导 parentId（父行若是「任务」自动升级成「摘要任务」）
        stack = []
        for it in items:
            while stack and stack[-1]['level'] >= it['level']:
                stack.pop()
            it['parentSeq'] = stack[-1]['seq'] if stack else None
            if stack:
                stack[-1]['hasChild'] = True
            stack.append(it)
            it.setdefault('hasChild', False)

        for it in items:
            if it.get('hasChild') and it['taskType'] == 'task':
                it['taskType'] = 'summary'
                it['autoType'] = True
            valid = []
            for n in it['preSeqs']:
                if n == it['seq']:
                    it['errors'].append('前置任务不能是自己')
                elif n not in seq_seen:
                    it['errors'].append('前置任务序号 %d 不存在' % n)
                elif n not in valid:
                    valid.append(n)
            it['preTaskSeqs'] = valid
            it['ok'] = not it['errors']
            it.pop('preSeqs', None)
            it.pop('hasChild', None)

        rows = [it for it in items]
        ok_rows = [it for it in rows if it['ok']]
        return {
            'rows': rows,
            'errors': [{'row': it['rowNo'], 'msg': m} for it in rows for m in it['errors']],
            'summary': {
                'total': len(rows), 'valid': len(ok_rows), 'invalid': len(rows) - len(ok_rows),
                'summaries': len([x for x in ok_rows if x['taskType'] == 'summary']),
                'milestones': len([x for x in ok_rows if x['taskType'] == 'milestone']),
                'withOwner': len([x for x in ok_rows if x['ownerId']]),
                'participants': len([x for x in ok_rows if x['participantIds']]),
                'maxTasks': self.MAX_TASKS,
            },
            'fileName': file_name,
            'mock': False,
        }

    def parse_import(self, params):
        """解析前端上传的 Excel（base64）→ 预览行 + 逐行错误；不写库。"""
        params = params or {}
        self._me(params)
        file_name = self._text(params.get('fileName'))[:120]
        text = self._text(params.get('data'))
        if not text:
            raise BizError('请先选择要导入的 Excel 文件')
        if ';base64,' in text[:300]:
            text = text.split(';base64,', 1)[1]
        try:
            raw = base64.b64decode(text.encode('ascii'), validate=True) if text else b''
        except Exception:
            raise BizError('文件内容不是合法的 base64，请重新选择文件')
        if not raw:
            raise BizError('文件内容为空')
        if len(raw) > self.IMPORT_MAX_BYTES:
            raise BizError('文件不能超过 5MB')
        if file_name and not file_name.lower().endswith(('.xlsx', '.xlsm')):
            raise BizError('只支持 .xlsx 格式：.xls / .csv 请先另存为 .xlsx')
        return self._parse_import_bytes(raw, file_name)

    def _import_template_bytes(self):
        """按 IMPORT_COLUMNS 生成模板：任务列表（表头 + 批注 + 下拉）+ 填写说明。"""
        try:
            from openpyxl import Workbook
            from openpyxl.comments import Comment
            from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
            from openpyxl.utils import get_column_letter
            from openpyxl.worksheet.datavalidation import DataValidation
        except Exception:
            raise BizError('服务器未安装 openpyxl，无法生成导入模板（pip install openpyxl）')

        wb = Workbook()
        ws = wb.active
        ws.title = '任务列表'
        head_fill = PatternFill('solid', fgColor='E8F0FE')
        thin = Side(style='thin', color='DCDFE6')
        border = Border(left=thin, right=thin, top=thin, bottom=thin)
        index = {}
        for ci, col in enumerate(self.IMPORT_COLUMNS, start=1):
            key, title, required, width, note = col
            index[key] = ci
            cell = ws.cell(row=1, column=ci, value=title + ('*' if required else ''))
            cell.font = Font(bold=True, color='303133')
            cell.fill = head_fill
            cell.alignment = Alignment(horizontal='center', vertical='center')
            cell.border = border
            cell.comment = Comment(note, '工作计划', width=280, height=120)
            ws.column_dimensions[get_column_letter(ci)].width = width
        ws.freeze_panes = 'A2'
        ws.row_dimensions[1].height = 26

        # 下拉 + 日期格式：直接铺到 200 行（= MAX_TASKS），用户不必手动设置
        last_row = self.MAX_TASKS + 1
        letter = lambda k: get_column_letter(index[k])
        dv_type = DataValidation(type='list', formula1='"任务,里程碑,摘要任务"', allow_blank=True,
                                 showErrorMessage=True, errorTitle='任务类型',
                                 error='只能填 任务 / 里程碑 / 摘要任务')
        ws.add_data_validation(dv_type)
        dv_type.add('%s2:%s%d' % (letter('taskType'), letter('taskType'), last_row))
        dv_level = DataValidation(type='list', formula1='"1,2,3,4,5,6,7,8"', allow_blank=True,
                                  showErrorMessage=True, errorTitle='层级',
                                  error='层级是 1~8 的整数（1 表示顶层）')
        ws.add_data_validation(dv_level)
        dv_level.add('%s2:%s%d' % (letter('level'), letter('level'), last_row))
        for key in ('startDate', 'endDate'):
            for row in range(2, last_row + 1):
                ws.cell(row=row, column=index[key]).number_format = 'yyyy-mm-dd'

        guide = wb.create_sheet('填写说明')
        guide.column_dimensions['A'].width = 14
        guide.column_dimensions['B'].width = 96
        lines = [
            ('填写说明', '工作计划 · 任务列表导入（单次最多 %d 条任务）' % self.MAX_TASKS),
            ('第 1 步', '在「任务列表」页签从第 2 行开始填，第 1 行表头不要删改（表头带 * 的是必填列）'),
            ('第 2 步', '「层级」用 1 / 2 / 3 表示缩进：1 是顶层，2 是上一条的子任务，最多 8 级；'
                        '有子行的任务导入后自动变成「摘要任务」，里程碑工期强制为 0 天'),
            ('第 3 步', '「责任人」「参与人员」都要写「工号 姓名」，例如 E00001 张三；'
                        '多个参与人员用逗号分隔：E00001 张三,E00002 李四。只写工号或只写姓名也能识别，'
                        '但同名员工必须写工号（系统不会替你猜）'),
            ('第 4 步', '「前置任务」填上面的「序号」，多个用逗号分隔，不能填自己'),
            ('第 5 步', '日期填 YYYY-MM-DD（如 2026-11-01）；只填「开始日期 + 工期(天)」也能算出结束日期'),
            ('第 6 步', '另存为 .xlsx → 回到「工作计划」页 → 点工具栏「导入任务」→ 选择该文件'),
            ('第 7 步', '导入只是把任务写进当前画布，**不会自动保存**：核对甘特图 / 网格列表无误后再点「保存」，'
                        '此时才会落库、写变更日志并通知责任人 / 参与人员'),
            ('注意', '计划已启动时，保存只给「已填责任人 / 参与人员」的新任务补派工单并发通知；'
                     '想先排期后派单，就把责任人列留空'),
        ]
        for r, (key, text) in enumerate(lines, start=1):
            guide.cell(row=r, column=1, value=key).font = Font(bold=(r == 1), color='303133')
            cell = guide.cell(row=r, column=2, value=text)
            cell.alignment = Alignment(wrap_text=True, vertical='top')
            if r == 1:
                guide.cell(row=r, column=2).font = Font(bold=True, color='303133')
        demo_head = ['序号', '层级', '任务名称', '任务类型', '开始日期', '结束日期',
                     '责任人', '参与人员', '前置任务']
        start_row = len(lines) + 3
        guide.cell(row=start_row - 1, column=1, value='示例（照着改，不要整块复制到任务列表）：')
        for ci, title in enumerate(demo_head, start=1):
            cell = guide.cell(row=start_row, column=ci, value=title)
            cell.font = Font(bold=True, color='303133')
            cell.fill = head_fill
            cell.border = border
            cell.alignment = Alignment(horizontal='center')
        demos = [
            [1, 1, '需求调研与方案设计', '摘要任务', '2026-11-02', '2026-11-06', 'E00001 张三', 'E00002 李四', ''],
            [2, 2, '现场调研', '任务', '2026-11-02', '2026-11-03', 'E00002 李四', '', ''],
            [3, 2, '方案评审', '里程碑', '2026-11-06', '2026-11-06', 'E00001 张三', 'E00003 王五', '2'],
            [4, 1, '开发实施', '任务', '2026-11-09', '2026-11-20', 'E00003 王五', 'E00001 张三', '3'],
        ]
        for ri, row in enumerate(demos):
            for ci, value in enumerate(row, start=1):
                cell = guide.cell(row=start_row + 1 + ri, column=ci, value=value)
                cell.border = border
        for ci in range(1, len(demo_head) + 1):
            guide.column_dimensions[get_column_letter(ci)].width = max(
                guide.column_dimensions[get_column_letter(ci)].width or 0,
                14 if ci != 3 else 22)

        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    def import_template(self, params=None):
        """下载导入模板（.xlsx 二进制流）。"""
        self._me(params or {})
        return {
            'content': self._import_template_bytes(),
            'filename': '工作计划任务导入模板.xlsx',
            'mimetype': self.XLSX_MIME,
        }

    def export_orders(self, params):
        """按当前筛选导出计划工单 Excel（全部行，非仅当前页）。"""
        params = params or {}
        self._me(params)
        rows, page = [], 1
        while True:
            page_data = self.plan_orders(dict(params, pageNum=page, pageSize=200))
            rows.extend(page_data.get('list') or [])
            if page * 200 >= self._int(page_data.get('total')):
                break
            page += 1
            if page > 200:
                break
        try:
            from openpyxl import Workbook
            from openpyxl.styles import Alignment, Font, PatternFill
            from openpyxl.utils import get_column_letter
        except Exception:
            raise BizError('服务器未安装 openpyxl，无法导出 Excel')
        headers = ['项目', '计划编号', '计划名称', '工单号', '任务名称', '责任人', '参与人员',
                   '工单状态', '执行状态', '计划开始', '计划结束', '派发时间',
                   '执行记录数', '变更历史数']
        wb = Workbook()
        ws = wb.active
        ws.title = '计划工单'
        ws.append(headers)
        head_fill = PatternFill('solid', fgColor='E8F0FE')
        for c in range(1, len(headers) + 1):
            cell = ws.cell(row=1, column=c)
            cell.font = Font(bold=True, color='303133')
            cell.fill = head_fill
            cell.alignment = Alignment(horizontal='center', vertical='center')
        for it in rows:
            ws.append([
                it.get('projectName') or '未关联项目', it.get('planCode') or '',
                it.get('planName') or '', it.get('orderCode') or '', it.get('taskName') or '',
                it.get('ownerName') or '', it.get('participantNames') or '',
                it.get('status') or '', it.get('execStatus') or '',
                it.get('startDate') or '', it.get('endDate') or '',
                it.get('dispatchTime') or '', self._int(it.get('execCount')),
                self._int(it.get('changeCount')),
            ])
        widths = [18, 12, 26, 14, 24, 12, 20, 12, 12, 12, 12, 20, 12, 12]
        for i, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w
        ws.freeze_panes = 'A2'
        ws.auto_filter.ref = 'A1:%s%d' % (get_column_letter(len(headers)), max(1, len(rows) + 1))
        buf = io.BytesIO()
        wb.save(buf)
        name = '计划工单_%s.xlsx' % datetime.datetime.now().strftime('%Y%m%d%H%M')
        return {'content': buf.getvalue(), 'filename': name,
                'mimetype': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'rowCount': len(rows)}

    def _project_options(self, plans, me):
        """项目下拉：能看到计划里的项目 + 未关联项目（放最后）。"""
        seen, opts, has_none = {}, [], False
        for p in plans:
            pid = self._text(p.get('id'))
            if self._creator_id(p) != me and self._int(p.get('ispub')) != 1:
                continue
            project_id = self._text(p.get('projectId'))
            if not project_id:
                has_none = True
                continue
            if project_id not in seen:
                seen[project_id] = self._text(p.get('projectName')) or project_id
                opts.append({'id': project_id, 'name': seen[project_id]})
        opts.sort(key=lambda x: x['name'])
        if has_none:
            opts.append({'id': '__none__', 'name': '未关联项目'})
        return opts

    def _project_access(self, project_id, me):
        """项目是否对当前员工可见：创建人 / projectmembers 成员 / 公用项目。"""
        project_id = self._text(project_id)
        if not project_id:
            return None
        try:
            row = query_one('SELECT * FROM `projectinfos` WHERE `id`=%s LIMIT 1', (project_id,))
        except Exception:
            row = None
        if not row:
            return None
        project = dump_row(row)
        if self._int(project.get('createempinfosid')) == me:
            return project
        try:
            member = query_one('SELECT 1 AS n FROM `projectmembers` '
                               'WHERE `projectId`=%%s AND `empId`=%%s LIMIT 1', (project_id, me))
        except Exception:
            member = None
        if member:
            return project
        if self._int(project.get('ispub')) == 1:
            return project
        return None

    def project_plans(self, params):
        """项目详情「工作计划」：项目创建人 / 项目组成员 / 公用项目可见，只读列表。"""
        params = params or {}
        me, _name = self._me(params)
        project_id = self._uuid(params.get('projectId'), '项目ID')
        if not project_id:
            raise BizError('缺少项目ID')
        project = self._project_access(project_id, me)
        if not project:
            raise BizError('没有权限查看该项目的计划', 403)

        keyword = self._text(params.get('keyword')).lower()
        status = self._text(params.get('status'))
        try:
            rows = query_all(
                'SELECT l.*, '
                '(SELECT COUNT(*) FROM `%s` t WHERE t.`planId`=l.`id`) AS `taskCount`, '
                '(SELECT IFNULL(ROUND(AVG(t.`progress`)),0) FROM `%s` t WHERE t.`planId`=l.`id`) AS `progress`, '
                '(SELECT COUNT(*) FROM `%s` o WHERE o.`planId`=l.`id`) AS `orderCount` '
                'FROM `%s` l WHERE l.`projectId`=%%s '
                'ORDER BY l.`createTime` DESC, l.`planCode` ASC'
                % (self.TASK_TABLE, self.TASK_TABLE, self.ORDER_TABLE, self.PLAN_TABLE),
                (project_id,)) or []
        except Exception:
            rows = []
        out = []
        for r in rows:
            item = self._plan_out(dump_row(r))
            item['status'] = self._text(item.get('status')) or '未启动'
            item['taskCount'] = self._int(item.get('taskCount'))
            item['progress'] = self._int(item.get('progress'))
            item['orderCount'] = self._int(item.get('orderCount'))
            item['isCreator'] = (self._creator_id(item) == me)
            req = {}
            try:
                req = dump_row(query_one(
                    'SELECT `acceptOwnerId`,`acceptOwnerName` FROM `requirements` '
                    'WHERE `planId`=%%s LIMIT 1', (item.get('id'),))) or {}
            except Exception:
                req = {}
            item['acceptOwnerId'] = self._int(req.get('acceptOwnerId'))
            item['acceptOwnerName'] = self._text(req.get('acceptOwnerName'))
            item['canAccept'] = (item['isCreator'] or
                                 item['acceptOwnerId'] == me or
                                 self._int(project.get('createempinfosid')) == me)
            if keyword and keyword not in ('%s %s' % (item.get('planCode'), item.get('planName'))).lower():
                continue
            if status and status != item['status']:
                continue
            out.append(item)
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 10), 1), 100)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        total = len(out)
        return {'list': out[(page_num - 1) * page_size: page_num * page_size],
                'total': total, 'pageNum': page_num, 'pageSize': page_size,
                'projectId': project_id,
                'projectName': self._text(project.get('projectName'))}

    def delete(self, params):
        params = params or {}
        me, _ename = self._me(params)
        old = self._plan(params.get('id'))
        self._visible(old, me)
        creator = self._creator_id(old)
        if creator and creator != me:
            raise BizError('非本人创建的工作计划不能删除', 403)
        if self._text(old.get('status')) == '已启动':
            raise BizError('执行中的工作计划不能删除，请先停止', 403)
        count = self._int((query_one('SELECT COUNT(*) AS n FROM `%s` WHERE `planId`=%%s'
                                     % self.TASK_TABLE, (old['id'],)) or {}).get('n'))

        def do(cur):
            cur.execute('DELETE FROM `%s` WHERE `planId`=%%s' % self.ORDER_TABLE, (old['id'],))
            cur.execute('DELETE FROM `%s` WHERE `planId`=%%s' % self.TASK_TABLE, (old['id'],))
            cur.execute('DELETE FROM `%s` WHERE `id`=%%s' % self.PLAN_TABLE, (old['id'],))

        transaction(do)
        return {'deleted': 1, 'taskCount': count, 'message': '工作计划已删除（含 %d 条任务）' % count}

    # ---------------- 变更日志 / 通知 / 执行记录（多次提交 + 多附件） ----------------
    def _creator_id(self, plan):
        return self._int((plan or {}).get('createempinfosid'))

    def _employee(self, emp_id, cache=None):
        emp_id = self._int(emp_id)
        if not emp_id:
            return {}
        if cache is not None and emp_id in cache:
            return cache[emp_id]
        try:
            row = query_one(self.EMP_SQL, (emp_id,)) or {}
        except Exception:
            row = {}
        if cache is not None:
            cache[emp_id] = row
        return row

    def _task_people(self, task):
        """任务的责任人 + 参与人员（empId 列表，去重）。"""
        task = task or {}
        ids = []
        owner = self._int(task.get('ownerId'))
        if owner:
            ids.append(owner)
        for x in (self._text(task.get('participantIds')) or '').split(','):
            n = self._int(x)
            if n and n not in ids:
                ids.append(n)
        return ids

    def _diff_tasks(self, old_rows, new_rows):
        """任务集合 diff：新增 / 修改（字段级） / 删除。返回 [{action,taskId,taskName,summary,detail}]。"""
        old_map = {self._text(t.get('id')): t for t in (old_rows or []) if self._text(t.get('id'))}
        new_map = {self._text(t.get('id')): t for t in (new_rows or []) if self._text(t.get('id'))}
        name_map = {}
        for t in (old_rows or []) + (new_rows or []):
            tid = self._text(t.get('id'))
            if tid:
                name_map[tid] = self._text(t.get('taskName')) or '未命名任务'

        def pre_names(raw):
            vals = [x.strip() for x in (self._text(raw) or '').split(',') if x.strip()]
            return '、'.join([name_map.get(x) or '未知任务' for x in vals]) or '空'

        def parent_name(raw):
            tid = self._text(raw)
            return (name_map.get(tid) or '未知任务') if tid else '空'
        fields = [('taskName', '任务名称'), ('taskType', '类型'), ('startDate', '开始日期'),
                  ('endDate', '结束日期'), ('progress', '完成%'), ('execStatus', '完成状态'),
                  ('ownerName', '责任人'), ('participantNames', '参与人员'),
                  ('actualStartDate', '实际开始'), ('actualEndDate', '实际结束'),
                  ('execRemark', '执行说明'),
                  ('preTaskIds', '前置任务'), ('parentId', '上级任务'), ('color', '颜色')]
        changes = []
        for tid in new_map:
            t = new_map[tid]
            name = self._text(t.get('taskName')) or '未命名任务'
            if tid not in old_map:
                changes.append({'action': 'add', 'taskId': tid, 'taskName': name,
                                'summary': '新增任务「%s」' % name, 'detail': ''})
                continue
            o = old_map[tid]
            diffs = []
            for key, label in fields:
                if key in ('startDate', 'endDate', 'actualStartDate', 'actualEndDate'):
                    # 库里的 DATE 经 dump_row 会带 ' 00:00:00'，比较前统一截到天
                    ov, nv = self._text(o.get(key))[:10], self._text(t.get(key))[:10]
                else:
                    ov, nv = self._text(o.get(key)), self._text(t.get(key))
                if ov != nv:
                    if key == 'execRemark':
                        diffs.append('%s：%s → %s' % (label, ov[:40] or '空', nv[:40] or '空'))
                    elif key == 'preTaskIds':
                        diffs.append('%s：%s → %s' % (label, pre_names(ov), pre_names(nv)))
                    elif key == 'parentId':
                        diffs.append('%s：%s → %s' % (label, parent_name(ov), parent_name(nv)))
                    else:
                        diffs.append('%s：%s → %s' % (label, ov or '空', nv or '空'))
            if diffs:
                heads = [d.split('：', 1)[0] for d in diffs]
                changes.append({'action': 'update', 'taskId': tid, 'taskName': name,
                                'summary': '修改任务「%s」（%s）' % (name, '、'.join(heads[:4])),
                                'detail': '\n'.join(diffs)})
        for tid in old_map:
            if tid in new_map:
                continue
            o = old_map[tid]
            name = self._text(o.get('taskName')) or '未命名任务'
            changes.append({'action': 'delete', 'taskId': tid, 'taskName': name,
                            'summary': '删除任务「%s」' % name, 'detail': ''})
        return changes

    def _log_change(self, plan_id, task_id, task_name, action, summary, detail, me, me_name):
        try:
            execute('INSERT INTO `%s` (`id`,`planId`,`taskId`,`taskName`,`action`,`summary`,'
                    '`detail`,`operatorId`,`operatorName`) VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)'
                    % self.LOG_TABLE,
                    (str(uuid.uuid4()), self._text(plan_id), self._text(task_id) or None,
                     (self._text(task_name) or None), action, (summary or '')[:500],
                     detail or None, me, me_name or None))
        except Exception:
            pass                        # 日志表缺失时不影响主流程

    def _log_changes(self, plan_id, changes, me, me_name):
        for ch in changes or []:
            self._log_change(plan_id, ch.get('taskId'), ch.get('taskName'), ch.get('action'),
                             ch.get('summary'), ch.get('detail'), me, me_name)

    def _change_receivers(self, plan, change, old_rows=None):
        """一条变更的接收人：计划创建人 + 该任务的责任人 / 参与人员（删除时取旧任务上的人）。"""
        ids = []
        creator = self._creator_id(plan)
        if creator:
            ids.append(creator)
        tid = self._text(change.get('taskId'))
        task = None
        if tid:
            for t in (old_rows or []):
                if self._text(t.get('id')) == tid:
                    task = t
                    break
            if task is None:
                # 新增 / 修改后的任务：旧快照里没有，按 id 回查当前任务
                try:
                    task = dump_row(query_one('SELECT * FROM %s WHERE id=%%s'
                                              % self.TASK_TABLE, (tid,))) or None
                except Exception:
                    task = None
        people = list(self._task_people(task))
        if tid:
            try:
                cur = dump_row(query_one('SELECT * FROM `%s` WHERE `id`=%%s' % self.TASK_TABLE,
                                         (tid,))) or {}
            except Exception:
                cur = {}
            for n in self._task_people(cur):
                if n not in people:
                    people.append(n)
        for n in people:
            if n not in ids:
                ids.append(n)
        # 来源需求的创建人 / 参与评估人也要收到变更通知
        req_id = self._text((plan or {}).get('requirementId'))
        if req_id:
            try:
                req_rows = query_all('SELECT `requesterId` FROM `requirements` WHERE `id`=%%s',
                                     (req_id,)) or []
                for r in req_rows:
                    n = self._int(r.get('requesterId'))
                    if n and n not in ids:
                        ids.append(n)
                eval_rows = query_all('SELECT `evaluatorIds` FROM `requirementevaluations` '
                                      'WHERE `requirementId`=%%s', (req_id,)) or []
                for r in eval_rows:
                    for x in (self._text(r.get('evaluatorIds')) or '').split(','):
                        n = self._int(x)
                        if n and n not in ids:
                            ids.append(n)
            except Exception:
                pass
        return ids

    def _enqueue_mail(self, plan_id, task_id, emp_id, email, subject, body, body_html):
        """把一封变更邮件写入队列（毫秒级，不阻塞保存请求）。"""
        try:
            execute('INSERT INTO `%s` (`id`,`planId`,`taskId`,`empId`,`email`,`subject`,'
                    '`body`,`bodyHtml`) VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)'
                    % self.MAILQ_TABLE,
                    (str(uuid.uuid4()), self._text(plan_id) or None,
                     self._text(task_id) or None, self._int(emp_id), email,
                     (subject or '')[:200], body, body_html))
            return True
        except Exception:
            return False

    def _notify_changes(self, plan, changes, me, me_name, old_rows=None):
        """每次变更推送即时消息（落库 + WS，同步、快）；邮件写队列由后台线程重试发送。

        这样保存接口不会因为 SMTP 慢而超时；邮件仍保证最终送达（失败重试 3 次）。
        """
        out = {'notified': 0, 'mailed': 0, 'queuedMail': 0, 'skippedMail': 0, 'errors': []}
        plan = plan or {}
        plan_id = self._text(plan.get('id'))
        plan_name = self._text(plan.get('planName')) or self._text(plan.get('planCode')) or '工作计划'
        plan_link = 'workplan-design.html?id=%s' % plan_id
        url = self._wp_rel_url(plan_link)          # 站内消息：相对路径
        mail_url = self._wp_abs_url(plan_link)     # 邮件：绝对地址
        anchor = notify_anchor(url, '打开计划')
        mail_anchor = notify_anchor(mail_url, '打开计划')
        cache = {}
        for ch in changes or []:
            summary = self._text(ch.get('summary'))
            detail = self._text(ch.get('detail'))
            for emp_id in self._change_receivers(plan, ch, old_rows):
                emp = self._employee(emp_id, cache)
                name = self._text(emp.get('nameCn')) or '同事'
                email = self._text(emp.get('email'))
                title = '工作计划变更通知'
                content = ('【工作计划变更】%s 在「%s」中%s。\n%s\n查看计划：%s'
                           % (me_name or '同事', plan_name, summary or '更新了计划内容',
                              ('变更明细：\n' + detail + '\n') if detail else '', url))
                content_html = ('<p>【工作计划变更】%s 在「%s」中%s。</p>%s<p>查看计划：%s</p>'
                                % (html_lib.escape(me_name or '同事'),
                                   html_lib.escape(plan_name),
                                   html_lib.escape(summary or '更新了计划内容'),
                                   ('<pre style="white-space:pre-wrap">%s</pre>'
                                    % html_lib.escape(detail)) if detail else '', anchor))
                ok_msg = self._wp_push(me, emp_id, title, content, content_html)
                if not ok_msg:
                    time.sleep(0.2)         # 瞬时失败重试一次，离线收件人也会留下未读消息
                    ok_msg = self._wp_push(me, emp_id, title, content, content_html)
                if ok_msg:
                    out['notified'] += 1
                else:
                    out['errors'].append('%s：站内消息发送失败' % name)
                if email:
                    body = ('您好，%s：\n\n%s 在计划「%s」中%s。\n%s\n查看计划：%s\n\n'
                            '—— 九豆综合管理平台 · 工作计划变更通知，请勿直接回复'
                            % (name, me_name or '同事', plan_name, summary or '更新了计划内容',
                               ('变更明细：\n' + detail + '\n') if detail else '', mail_url))
                    body_html = ('<p>您好，%s：</p><p>%s 在计划「%s」中%s。</p>%s'
                                 '<p>查看计划：%s</p>'
                                 '<p>—— 九豆综合管理平台 · 工作计划变更通知，请勿直接回复</p>'
                                 % (html_lib.escape(name), html_lib.escape(me_name or '同事'),
                                    html_lib.escape(plan_name),
                                    html_lib.escape(summary or '更新了计划内容'),
                                    ('<pre style="white-space:pre-wrap">%s</pre>'
                                     % html_lib.escape(detail)) if detail else '', mail_anchor))
                    if self._enqueue_mail(plan_id, ch.get('taskId'), emp_id, email,
                                          '【九豆综合管理平台】工作计划变更：%s' % (summary or plan_name),
                                          body, body_html):
                        out['queuedMail'] += 1
                    else:
                        out['errors'].append('%s：邮件入队失败' % name)
                else:
                    out['skippedMail'] += 1        # 未登记邮箱：单独计数，不当作发送失败
        return out

    def process_mail_queue(self, limit=20):
        """后台发送变更邮件：领取（防并发重复）→ 发送 → sent / retry / failed。

        失败最多重试 3 次；超过 5 分钟仍处于 sending 的记录（进程中断）会被重新领取。
        """
        out = {'sent': 0, 'retry': 0, 'failed': 0}
        try:
            rows = query_all('SELECT * FROM `%s` WHERE `status` IN (\'pending\',\'retry\') '
                             'OR (`status`=\'sending\' AND `updateTime` < (NOW() - INTERVAL 5 MINUTE)) '
                             'ORDER BY `createTime` LIMIT %%s' % self.MAILQ_TABLE,
                             (min(50, max(1, self._int(limit, 20))),)) or []
        except Exception:
            return out
        for row in rows:
            rid = self._text(row.get('id'))
            if not rid:
                continue
            _, claimed = execute('UPDATE `%s` SET `status`=\'sending\' WHERE `id`=%%s AND '
                                 '(`status` IN (\'pending\',\'retry\') OR (`status`=\'sending\' AND '
                                 '`updateTime` < (NOW() - INTERVAL 5 MINUTE)))' % self.MAILQ_TABLE,
                                 (rid,))
            if not claimed:
                continue
            ok, err = False, ''
            try:
                ok, err = project_plan_service._send_mail(
                    [self._text(row.get('email'))], self._text(row.get('subject')),
                    self._text(row.get('body')) or '', self._text(row.get('bodyHtml')) or '')
            except Exception:
                ok, err = False, '邮件服务异常'
            attempts = self._int(row.get('attempts')) + 1
            if ok:
                execute('UPDATE `%s` SET `status`=\'sent\',`attempts`=%%s,`lastError`=NULL '
                        'WHERE `id`=%%s' % self.MAILQ_TABLE, (attempts, rid))
                out['sent'] += 1
            else:
                status = 'failed' if attempts >= 3 else 'retry'
                execute('UPDATE `%s` SET `status`=%%s,`attempts`=%%s,`lastError`=%%s WHERE `id`=%%s'
                        % self.MAILQ_TABLE, (status, attempts, (err or '')[:500], rid))
                out[status] += 1
        return out

    def _save_exec_files(self, exec_id, files):
        """执行记录附件：data URL / base64 → 服务器磁盘；单文件 ≤10 MB、总数 ≤30 MB、最多 10 个。"""
        out = []
        files = files if isinstance(files, (list, tuple)) else []
        if len(files) > 10:
            raise BizError('一次最多上传 10 个附件')
        directory = os.path.join(self.UPLOAD_ROOT, exec_id)
        try:
            os.makedirs(directory, exist_ok=True)
        except Exception:
            raise BizError('附件目录不可写，请联系管理员')
        total = 0
        for i, item in enumerate(files):
            if not isinstance(item, dict):
                continue
            name = os.path.basename(self._text(item.get('name')) or ('附件%d' % (i + 1)))[:200]
            raw = self._text(item.get('data'))
            if not raw:
                continue
            if raw.startswith('data:') and ',' in raw[:300]:
                raw = raw.split(',', 1)[1]
            try:
                blob = base64.b64decode(raw)
            except Exception:
                raise BizError('附件「%s」内容不合法' % name)
            if not blob:
                continue
            if len(blob) > 10 * 1024 * 1024:
                raise BizError('附件「%s」超过 10 MB' % name)
            total += len(blob)
            if total > 30 * 1024 * 1024:
                raise BizError('附件总大小超过 30 MB')
            ext = os.path.splitext(name)[1].lower().lstrip('.')[:20]
            file_id = str(uuid.uuid4())
            rel = os.path.join(exec_id, '%s_%s' % (file_id, name))
            try:
                with open(os.path.join(self.UPLOAD_ROOT, rel), 'wb') as fh:
                    fh.write(blob)
            except Exception:
                raise BizError('附件「%s」保存失败' % name)
            out.append({'id': file_id, 'execId': exec_id, 'name': name, 'path': rel,
                        'size': len(blob), 'ext': ext})
        return out

    def _exec_files(self, exec_ids):
        out = {}
        exec_ids = [self._text(x) for x in (exec_ids or []) if self._text(x)]
        if not exec_ids:
            return out
        try:
            rows = query_all('SELECT * FROM `%s` WHERE `execId` IN (%s) ORDER BY `createTime`,`id`'
                             % (self.EXECFILE_TABLE, ','.join(['%s'] * len(exec_ids))),
                             tuple(exec_ids)) or []
        except Exception:
            rows = []
        for r in rows:
            f = dump_row(r)
            fid = self._text(f.get('id'))
            out.setdefault(self._text(f.get('execId')), []).append({
                'id': fid, 'name': self._text(f.get('name')), 'size': self._int(f.get('size')),
                'ext': self._text(f.get('ext')),
                'url': '/api/workplan/execfile?id=%s' % fid
            })
        return out

    def save(self, params):
        """整图保存：{id?, plan:{...}, tasks:[...]}，任务按提交结果全量替换（事务内先删后插）。"""
        params = params or {}
        me, ename = self._me(params)
        plan_data = dict(params.get('plan') or {})
        plan_id = self._text(plan_data.get('id') or params.get('id'))
        old = self._plan(plan_id) if plan_id else None
        if old:
            self._visible(old, me)
        if not plan_id:
            plan_data.pop('id', None)
        values = self._normalize_plan(plan_data, old=old, me=me, ename=ename)
        rows = self._normalize_tasks(params.get('tasks'))
        # 旧任务快照：用于 ①非创建人「禁止删除任务节点 / 停止任务」校验 ②变更日志 diff
        old_tasks = []
        if old:
            try:
                old_tasks = [dump_row(r) for r in (query_all(
                    'SELECT * FROM `%s` WHERE `planId`=%%s' % self.TASK_TABLE,
                    (old['id'],)) or [])]
            except Exception:
                old_tasks = []
            creator = self._creator_id(old)
            if creator and me != creator:
                new_ids = set([self._text(r.get('id')) for r in rows])
                removed = [t for t in old_tasks if self._text(t.get('id')) not in new_ids]
                if removed:
                    raise BizError('非本人创建的工作计划，不能删除任务节点（%s）'
                                   % (self._text(removed[0].get('taskName')) or '未命名任务'), 403)
                old_map = {self._text(t.get('id')): t for t in old_tasks}
                for r in rows:
                    o = old_map.get(self._text(r.get('id')))
                    if o and self._text(o.get('execStatus')) != '已取消' \
                            and self._text(r.get('execStatus')) == '已取消':
                        raise BizError('非本人创建的工作计划，不能停止任务「%s」'
                                       % (self._text(r.get('taskName')) or '未命名任务'), 403)
        # Visio：时间刻度范围自动延伸到任务边界（拖动任务条超出计划区间时不必手改计划）
        if rows:
            starts = [self._day(r['startDate']) for r in rows]
            ends = [self._day(r['endDate']) for r in rows]
            lo, hi = min(starts), max(ends)
            if not values.get('startDate') or self._day(values['startDate']) > lo:
                values['startDate'] = datetime.date.fromordinal(lo).strftime('%Y-%m-%d')
            if not values.get('endDate') or self._day(values['endDate']) < hi:
                values['endDate'] = datetime.date.fromordinal(hi).strftime('%Y-%m-%d')
        pid = old['id'] if old else values['id']
        code = old['planCode'] if old else values['planCode']
        # 计划里已有缺陷修复任务时，计划管理页提交的整图不带 orderKind：
        # 按任务ID沿用旧值，避免把 bug-dev / bug-test 重新写回 plan（会让统计口径漂移）
        if old_tasks:
            old_kind = {}
            for one in old_tasks:
                old_kind[self._text(one.get('id'))] = self._text(one.get('orderKind'))
            for r in rows:
                keep = old_kind.get(r['id'])
                if keep in self.ORDER_KINDS and keep != 'plan' and r.get('orderKind') == 'plan':
                    r['orderKind'] = keep
        cols = list(values.keys())
        task_cols = ['id', 'planId', 'taskName', 'taskType', 'orderKind', 'parentId', 'startDate',
                     'endDate', 'progress', 'execStatus', 'actualStartDate',
                     'actualEndDate', 'execRemark', 'preTaskIds', 'ownerName', 'ownerId',
                     'participantIds', 'participantNames', 'sortNo', 'color']

        def do(cur):
            if old:
                cur.execute('UPDATE `%s` SET %s WHERE `id`=%%s' % (
                    self.PLAN_TABLE, ','.join(['`%s`=%%s' % c for c in cols])),
                    tuple([values[c] for c in cols] + [pid]))
            else:
                cur.execute('INSERT INTO `%s` (%s) VALUES (%s)' % (
                    self.PLAN_TABLE, ','.join(['`%s`' % c for c in cols]),
                    ','.join(['%s'] * len(cols))), tuple([values[c] for c in cols]))
            cur.execute('DELETE FROM `%s` WHERE `planId`=%%s' % self.TASK_TABLE, (pid,))
            for r in rows:
                cur.execute('INSERT INTO `%s` (%s) VALUES (%s)' % (
                    self.TASK_TABLE, ','.join(['`%s`' % c for c in task_cols]),
                    ','.join(['%s'] * len(task_cols))),
                    tuple([pid if c == 'planId' else r.get(c) for c in task_cols]))

        try:
            transaction(do)
        except DuplicateError:
            raise BizError('保存失败：计划编号或任务ID冲突，请重试')
        # 每次保存都自检任务变化：新建计划的任务也算「新增」，同样写日志并推送
        changes = self._diff_tasks(old_tasks, rows)
        change_note = {'notified': 0, 'mailed': 0, 'errors': []}
        if changes:
            self._log_changes(pid, changes, me, ename)
            try:
                change_note = self._notify_changes(self._plan(pid), changes, me, ename, old_tasks)
            except Exception:
                change_note = {'notified': 0, 'mailed': 0, 'errors': ['变更通知发送失败']}
        message = '工作计划已保存（%s，%d 条任务）' % (code, len(rows))
        notify_errors = change_note.get('errors') or []
        if changes:
            message += '；变更 %d 项（站内消息 %d 条、邮件 %d 封已入队后台发送）' % (
                len(changes), change_note.get('notified', 0),
                change_note.get('queuedMail', 0) or change_note.get('mailed', 0))
            if notify_errors:
                message += '；未送达 %d 条：%s' % (
                    len(notify_errors), '；'.join(notify_errors[:3]))
            if change_note.get('skippedMail'):
                message += '；%d 人未登记邮箱（邮件未发送）' % change_note['skippedMail']
        else:
            message += '；未检测到任务变化，未推送通知'
        out = {'id': pid, 'planCode': code, 'taskCount': len(rows), 'message': message,
               'changes': len(changes), 'notified': change_note.get('notified', 0),
               'mailed': change_note.get('mailed', 0),
               'queuedMail': change_note.get('queuedMail', 0),
               'skippedMail': change_note.get('skippedMail', 0), 'notifyErrors': notify_errors}
        # 计划已启动：保存时自动给「新增 / 还没派过工单」的任务补派工单，并通知责任人 + 参与人员
        # （未启动的计划不在这里通知，避免「还没启动就先发一遍」，启动时统一发）
        try:
            plan_row = self._plan(pid)
            if self._text(plan_row.get('status')) == '已启动':
                fresh = query_all('SELECT * FROM `%s` WHERE `planId`=%%s ORDER BY `sortNo`,`id`'
                                  % self.TASK_TABLE, (pid,)) or []
                res = self._dispatch_tasks(plan_row, fresh, me, ename, only_with_people=True)
                if res['created'] or res['notified'] or res['mailed']:
                    message += ('；新增任务已派工单 %d 张，通知 %d 人（站内消息 %d 条、邮件 %d 封）'
                                % (res['created'], res['receivers'], res['notified'], res['mailed']))
                    out.update({'dispatched': res['created'], 'notified': res['notified'],
                                'mailed': res['mailed'], 'message': message})
                if res['errors']:
                    message += '；通知失败：' + '；'.join(res['errors'][:3])
                    out['message'] = message
        except Exception:
            pass                       # 老库未跑 workplan-start.sql（没有 status 列）时只保存任务
        return out

    # ---------------- 选人：组织架构树 + 员工信息 / 项目组成员 ----------------
    def people(self, params):
        """任务属性里选人用的一次性数据源。

        · orgs：OrganizationStructure 全量（带 parentId / level，前端按层级折叠展示）；
        · employees：empinfos 全量（含部门名、在职状态、邮箱）；
        · members：关联项目的 projectmembers（快照 + 员工表现字段），未关联项目时为空。
        两条来源共用同一棵组织树，前端切换数据源只换成不同的人员集合。
        """
        params = params or {}
        self._me(params)
        project_id = self._uuid(params.get('projectId'), '关联项目ID')
        text = self._text

        def emp_out(r):
            st = self._int(r.get('status'), 1)
            name = text(r.get('nameCn')) or text(r.get('empName'))
            return {
                'id': self._int(r.get('empId') or r.get('id')),
                'nameCn': name, 'name': name, 'code': text(r.get('code')),
                'deptId': self._int(r.get('deptId')),
                'deptName': text(r.get('deptName')) or '—（未分配）',
                'jobTitle': text(r.get('jobTitle')), 'email': text(r.get('email')),
                'status': st, 'statusText': self.PEOPLE_STATUS.get(st, '在职'),
                'fromGroup': False
            }

        try:
            orgs = [{
                'id': self._int(r.get('id')), 'parentId': self._int(r.get('parentId')),
                'level': self._int(r.get('level'), 1), 'code': text(r.get('code')),
                'nameCn': text(r.get('nameCn')), 'enabled': self._int(r.get('enabled'), 1)
            } for r in (query_all('SELECT `id`,`parentId`,`level`,`code`,`nameCn`,`enabled` '
                                  'FROM `OrganizationStructure` ORDER BY `sortNo`,`id`') or [])]
        except Exception:
            orgs = []
        try:
            employees = [emp_out(r) for r in (query_all(
                'SELECT e.`id`,e.`code`,e.`nameCn`,e.`deptId`,e.`email`,e.`status`,e.`jobTitle`,'
                'd.`nameCn` AS `deptName` FROM `empinfos` e '
                'LEFT JOIN `OrganizationStructure` d ON d.`id`=e.`deptId` ORDER BY e.`code`') or [])]
        except Exception:
            employees = []
        members, project_name = [], ''
        if project_id:
            try:
                prow = query_one('SELECT `projectName` FROM `projectinfos` WHERE `id`=%s LIMIT 1',
                                 (project_id,))
                project_name = text((prow or {}).get('projectName'))
                mrows = query_all(
                    'SELECT m.`empId`,m.`empName`,m.`deptId`,m.`deptName`,m.`jobTitle`,m.`email`,'
                    'e.`code`,e.`nameCn`,e.`status` FROM `projectmembers` m '
                    'LEFT JOIN `empinfos` e ON e.`id`=m.`empId` '
                    'WHERE m.`projectId`=%s ORDER BY m.`createTime`,m.`id`', (project_id,)) or []
                for r in mrows:
                    one = emp_out(r)
                    one['fromGroup'] = True
                    members.append(one)
            except Exception:
                members = []
        return {'orgs': orgs, 'employees': employees, 'members': members,
                'projectId': project_id, 'projectName': project_name,
                'memberCount': len(members)}

    def _wp_order_code(self):
        """WO + 6 位：与项目计划 v2 的 projectworkorders 共用序列，跨两张表取最大值。"""
        pattern = '^%s[0-9]{%d}$' % (self.ORDER_PREFIX, self.CODE_DIGITS)
        tables = ('projectworkorders', self.ORDER_TABLE)
        seq = 0
        for table in tables:
            try:
                rows = query_all('SELECT `orderCode` AS `code` FROM `%s` WHERE `orderCode` REGEXP %%s'
                                 % table, (pattern,)) or []
            except Exception:
                rows = []
            for r in rows:
                try:
                    seq = max(seq, int(self._text(r.get('code'))[len(self.ORDER_PREFIX):]))
                except (TypeError, ValueError):
                    continue
        while seq < 999999:
            seq += 1
            code = '%s%0*d' % (self.ORDER_PREFIX, self.CODE_DIGITS, seq)
            used = False
            for table in tables:
                try:
                    if query_one('SELECT `id` FROM `%s` WHERE `orderCode`=%%s LIMIT 1'
                                 % table, (code,)):
                        used = True
                        break
                except Exception:
                    continue
            if not used:
                return code
        raise BizError('工单编号已超出上限')

    @staticmethod
    def _wp_abs_url(path):
        return ProjectPlanService._abs_url(path)

    @staticmethod
    def _wp_rel_url(path):
        return ProjectPlanService._rel_url(path)

    @staticmethod
    def _wp_push(me, emp_id, title, content, content_html=''):
        """站内即时消息 + WS 实时推送（复用项目计划 v2 同一条链路）。

        注意：ProjectPlanService._push_message 是实例方法，必须用单例调用。
        早期写成 ProjectPlanService._push_message(...) 会少传一个 self 抛 TypeError，
        而异常在这里被兜住 → 表现为「邮件收到了、即时对话没有消息」。
        """
        try:
            return project_plan_service._push_message(me, emp_id, title, content, content_html)
        except Exception:
            return False

    # ---------------- 派单：一任务一工单 + 站内消息 + 邮件（责任人 & 参与人员） ----------------
    def _dispatch_tasks(self, plan, tasks, me, me_name, only_with_people=False):
        """给「还没有工单」的任务补派工单，并通知责任人 / 参与人员（站内消息 + 邮件）。

        幂等：已有工单的任务只同步人员快照，不重复派单、不重复通知。
        only_with_people=True 时跳过还没填人的任务（新增任务先存草稿，填完人再通知）。
        返回 {'created','skipped','notified','mailed','receivers','errors'}。
        """
        plan_id = self._text(plan.get('id'))
        plan_name = self._text(plan.get('planName')) or self._text(plan.get('planCode'))
        plan_code = self._text(plan.get('planCode'))
        project_id = self._text(plan.get('projectId')) or None
        out = {'created': 0, 'skipped': 0, 'notified': 0, 'mailed': 0,
               'receivers': 0, 'errors': []}
        emp_cache = {}

        def employee(emp_id):
            if not emp_id:
                return {}
            if emp_id not in emp_cache:
                try:
                    emp_cache[emp_id] = query_one(self.EMP_SQL, (emp_id,)) or {}
                except Exception:
                    emp_cache[emp_id] = {}
            return emp_cache[emp_id]

        for r in tasks:
            t = dump_row(r)
            task_id = self._text(t.get('id'))
            owner_id = self._int(t.get('ownerId'))
            owner_name = self._text(t.get('ownerName'))
            raw_ids = [x.strip() for x in (self._text(t.get('participantIds')) or '').split(',') if x.strip()]
            raw_names = [x.strip() for x in (self._text(t.get('participantNames')) or '').split(',')]
            name_of = {}
            for i, pid in enumerate(raw_ids):
                name_of[self._int(pid)] = raw_names[i] if i < len(raw_names) else ''
            # 收件人 = 责任人 ∪ 参与人员（去重，跳过 0 / 未关联员工的自由文本）
            ids, seen = [], {}
            for x in ([str(owner_id)] if owner_id else []) + raw_ids:
                n = self._int(x)
                if n and n not in seen:
                    seen[n] = 1
                    ids.append(n)
            part_ids = [str(n) for n in ids if n != owner_id]
            part_names = []
            for p in part_ids:
                n = self._int(p)
                part_names.append(self._text(employee(n).get('nameCn')) or name_of.get(n, ''))
            owner_email = self._text(employee(owner_id).get('email'))
            task_name = self._text(t.get('taskName'))
            start_date = self._short_date(t.get('startDate'))
            end_date = self._short_date(t.get('endDate'))

            try:
                order = query_one('SELECT * FROM `%s` WHERE `taskId`=%%s LIMIT 1'
                                  % self.ORDER_TABLE, (task_id,))
            except Exception:
                order = None
            if order:
                # 幂等：已派过的任务只同步人员快照，不重复发消息 / 邮件。
                # 任务上一个人都没填时保留工单原归属（否则「我的任务」会凭空消失）。
                if ids:
                    execute('UPDATE `%s` SET `ownerId`=%%s,`ownerName`=%%s,`ownerEmail`=%%s,'
                            '`participantIds`=%%s,`participantNames`=%%s,`orderTitle`=%%s WHERE `id`=%%s'
                            % self.ORDER_TABLE,
                            (owner_id, owner_name or None, owner_email or None,
                             ','.join(part_ids) or None, ','.join(part_names) or None,
                             task_name, order['id']))
                out['skipped'] += 1
                continue
            if only_with_people and not ids:
                continue               # 新增任务还没填人：等填完责任人 / 参与人员再派单通知

            code = self._wp_order_code()
            order_kind = self._text(t.get('orderKind')) or 'plan'
            if order_kind not in self.ORDER_KINDS:
                order_kind = 'plan'
            try:
                execute('INSERT INTO `%s` (`id`,`taskId`,`planId`,`projectId`,`planCode`,`planName`,'
                        '`orderCode`,`orderTitle`,`taskType`,`orderKind`,`startDate`,`endDate`,'
                        '`ownerId`,`ownerName`,`ownerEmail`,`participantIds`,`participantNames`) '
                        'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)'
                        % self.ORDER_TABLE,
                        (str(uuid.uuid4()), task_id, plan_id, project_id, plan_code, plan_name,
                         code, task_name, self._text(t.get('taskType')) or 'task', order_kind,
                         start_date or None, end_date or None, owner_id,
                         owner_name or None, owner_email or None,
                         ','.join(part_ids) or None, ','.join(part_names) or None))
            except DuplicateError:
                out['skipped'] += 1        # 并发保存时别的请求已经派过这张单（taskId 唯一）
                continue
            out['created'] += 1

            # 缺陷修复工单的责任人日常在「我的任务」处理，跳到任务列表比跳甘特画布更直接
            is_bug_order = order_kind.startswith('bug-')
            link = ('workplan-task.html' if is_bug_order
                    else 'workplan-design.html?id=%s&taskId=%s' % (plan_id, task_id))
            url = self._wp_rel_url(link)               # 站内消息：相对路径
            mail_url = self._wp_abs_url(link)          # 邮件：绝对地址
            link_label = '打开我的任务' if is_bug_order else '打开任务'
            anchor = notify_anchor(url, link_label)
            mail_anchor = notify_anchor(mail_url, link_label)
            ok_any_msg = ok_any_mail = False
            for emp_id in ids:
                out['receivers'] += 1
                emp = employee(emp_id)
                name = self._text(emp.get('nameCn')) or name_of.get(emp_id, '') or owner_name or '同事'
                email = self._text(emp.get('email'))
                role = '责任人' if emp_id == owner_id else '参与人员'
                title = '缺陷修复任务通知' if is_bug_order else '工作计划任务通知'
                head = '【缺陷修复】' if is_bug_order else '【工作计划】'
                brief = (head + '%s 启动了计划「%s」，任务「%s」（%s ~ %s）已指派给您（%s）。\n'
                         '打开任务：%s'
                         % (me_name or '系统管理员', plan_name, task_name,
                            start_date or '—', end_date or '—', role, url))
                brief_html = ('<p>' + head + '%s 启动了计划「%s」，任务「%s」（%s ~ %s）'
                              '已指派给您（%s）。</p><p>打开任务：%s</p>'
                              % (html_lib.escape(me_name or '系统管理员'),
                                 html_lib.escape(plan_name), html_lib.escape(task_name),
                                 html_lib.escape(start_date or '—'),
                                 html_lib.escape(end_date or '—'),
                                 html_lib.escape(role), anchor))
                ok_msg = self._wp_push(me, emp_id, title, brief, brief_html)
                out['notified'] += 1 if ok_msg else 0
                ok_any_msg = ok_any_msg or ok_msg
                ok_mail = False
                mail_err = ''
                if email:
                    kind_label = '缺陷修复计划' if is_bug_order else '工作计划'
                    subject = ('【九豆综合管理平台】缺陷修复任务：%s' if is_bug_order
                               else '【九豆综合管理平台】工作计划任务：%s') % task_name
                    body = ('您好，%s：\n\n%s 启动了%s「%s」，任务「%s」（%s ~ %s）'
                            '已指派给您（%s）。\n\n打开任务：%s\n\n'
                            '—— 九豆综合管理平台 · 系统通知，请勿直接回复'
                            % (name, me_name or '系统管理员', kind_label, plan_name, task_name,
                               start_date or '—', end_date or '—', role, mail_url))
                    body_html = ('<p>您好，%s：</p><p>%s 启动了%s「%s」，任务「%s」'
                                 '（%s ~ %s）已指派给您（%s）。</p><p>打开任务：%s</p>'
                                 '<p>—— 九豆综合管理平台 · 系统通知，请勿直接回复</p>'
                                 % (html_lib.escape(name), html_lib.escape(me_name or '系统管理员'),
                                    html_lib.escape(kind_label), html_lib.escape(plan_name),
                                    html_lib.escape(task_name),
                                    html_lib.escape(start_date or '—'),
                                    html_lib.escape(end_date or '—'),
                                    html_lib.escape(role), mail_anchor))
                    try:
                        ok_mail, mail_err = project_plan_service._send_mail(
                            [email], subject, body, body_html)
                    except Exception:
                        ok_mail, mail_err = False, '邮件服务异常'
                    out['mailed'] += 1 if ok_mail else 0
                    ok_any_mail = ok_any_mail or ok_mail
                    if mail_err:
                        out['errors'].append('%s / %s：%s' % (task_name, name, mail_err))
            execute('UPDATE `%s` SET `noticeMsg`=%%s,`noticeMail`=%%s,`noticeTime`=NOW() WHERE `taskId`=%%s'
                    % self.ORDER_TABLE, (1 if ok_any_msg else 0, 1 if ok_any_mail else 0, task_id))
        return out

    # ---------------- 启动：工单 + 站内消息 + 邮件（责任人 & 参与人员） ----------------
    def start(self, params):
        params = params or {}
        me, me_name = self._me(params)
        plan = self._plan(params.get('planId') or params.get('id'))
        self._visible(plan, me)
        plan_id = self._text(plan.get('id'))
        if self._text(plan.get('status')) == '已启动':
            raise BizError('该工作计划已启动，不能重复启动')
        tasks = query_all('SELECT * FROM `%s` WHERE `planId`=%%s ORDER BY `sortNo`,`id`'
                          % self.TASK_TABLE, (plan_id,)) or []
        res = self._dispatch_tasks(plan, tasks, me, me_name)
        created, skipped = res['created'], res['skipped']
        notified, mailed = res['notified'], res['mailed']
        receivers, errors = res['receivers'], res['errors']

        try:
            execute('UPDATE `%s` SET `status`=%%s,`startTime`=NOW(),`startEname`=%%s,'
                    '`startempinfosid`=%%s WHERE `id`=%%s' % self.PLAN_TABLE,
                    ('已启动', me_name or None, me, plan_id))
        except Exception:
            pass                       # 老库未跑 workplan-start.sql 时不影响派单结果
        message = ('已启动：派发工单 %d 张，通知 %d 人（站内消息 %d 条、邮件 %d 封）'
                   % (created, receivers, notified, mailed))
        if skipped:
            message += '；%d 张已有工单只同步人员，未重复通知' % skipped
        if not tasks:
            message += '；计划下还没有任务，请先在工作计划里添加任务'
        if errors:
            message += '；通知失败：' + '；'.join(errors[:3])
        return {'created': created, 'skipped': skipped, 'notified': notified,
                'mailed': mailed, 'receivers': receivers, 'status': '已启动',
                'message': message}

    # ---------------- 停止计划：仅创建人，已停止 / 未启动给出明确提示 ----------------
    def stop(self, params):
        params = params or {}
        me, me_name = self._me(params)
        plan = self._plan(params.get('planId') or params.get('id'))
        self._visible(plan, me)
        if self._creator_id(plan) != me:
            raise BizError('只有计划创建人可以停止该工作计划', 403)
        status = self._text(plan.get('status'))
        if status == '已停止':
            raise BizError('该工作计划已停止，无需重复操作')
        if status != '已启动':
            raise BizError('只有已启动的工作计划可以停止')
        execute('UPDATE `%s` SET `status`=%%s WHERE `id`=%%s' % self.PLAN_TABLE,
                ('已停止', self._text(plan.get('id'))))
        self._log_change(plan.get('id'), None, None, 'stop', '停止了工作计划', '', me, me_name)
        try:
            note = self._notify_changes(plan, [{'action': 'stop', 'taskId': '',
                                                'summary': '停止了工作计划', 'detail': ''}],
                                        me, me_name, [])
        except Exception:
            note = {'notified': 0, 'mailed': 0}
        return {'id': self._text(plan.get('id')), 'status': '已停止',
                'message': '工作计划已停止', 'notified': note.get('notified', 0),
                'mailed': note.get('mailed', 0)}

    # ---------------- 我的任务：工作计划工单（按 taskId 关联计划任务） ----------------
    def orders(self, params):
        """当前登录人相关的工单：责任人 OR 参与人员；执行记录从关联任务 JOIN 读取。

        「项目计划」功能已下线（db/workplan-retire-projectplan.sql 停用菜单 / 授权），
        因此这里不再合并项目计划的历史工单，避免「我的任务」跳到已下线页面。
        """
        params = params or {}
        me, _name = self._me(params)
        out = []
        # 工单里的 projectId 是派单时的快照；计划后来改了关联项目，按项目检索要取计划当前值
        plan_project = {}
        try:
            for pr in (query_all('SELECT `id`,`projectId` FROM `workplans`') or []):
                plan_project[self._text(pr.get('id'))] = self._text(pr.get('projectId'))
        except Exception:
            plan_project = {}
        exec_count = {}
        try:
            for er in (query_all('SELECT `orderId`,COUNT(*) AS n FROM `%s` '
                                 'WHERE `orderId` IS NOT NULL GROUP BY `orderId`'
                                 % self.EXEC_TABLE) or []):
                exec_count[self._text(er.get('orderId'))] = self._int(er.get('n'))
        except Exception:
            exec_count = {}
        change_count = {}
        try:
            for cr in (query_all('SELECT `taskId`,COUNT(*) AS n FROM `%s` '
                                 'WHERE `taskId` IS NOT NULL GROUP BY `taskId`'
                                 % self.LOG_TABLE) or []):
                change_count[self._text(cr.get('taskId'))] = self._int(cr.get('n'))
        except Exception:
            change_count = {}
        join_sql = ('SELECT o.*, t.`id` AS `linkedTaskId`, t.`taskName` AS `linkedTaskName`, '
                    't.`progress`, t.`execStatus`, t.`actualStartDate`, t.`actualEndDate`, '
                    't.`execRemark`, t.`startDate` AS `linkedStartDate`, '
                    't.`endDate` AS `linkedEndDate` FROM `%s` o LEFT JOIN `%s` t ON t.`id`=o.`taskId` '
                    'WHERE o.`ownerId`=%%s OR FIND_IN_SET(%%s,o.`participantIds`) '
                    'ORDER BY o.`dispatchTime` DESC' % (self.ORDER_TABLE, self.TASK_TABLE))
        try:
            rows = query_all(join_sql, (me, str(me))) or []
        except Exception:
            # 老库未跑 workplan-exec.sql 时退回单表，前端仍能显示工单（执行字段给默认值）
            try:
                rows = query_all('SELECT * FROM `%s` WHERE `ownerId`=%%s OR '
                                 'FIND_IN_SET(%%s,`participantIds`) ORDER BY `dispatchTime` DESC'
                                 % self.ORDER_TABLE, (me, str(me))) or []
            except Exception:
                rows = []
        for r in rows:
            o = dump_row(r)
            parts = [x for x in (self._text(o.get('participantIds')) or '').split(',') if x]
            o.update({
                'sourceType': '工作计划',
                'taskName': self._text(o.get('linkedTaskName')) or self._text(o.get('orderTitle')),
                'taskId': self._text(o.get('taskId')),
                'taskLinked': bool(self._text(o.get('linkedTaskId'))),
                'progress': self._int(o.get('progress')),
                'execStatus': self._text(o.get('execStatus')) or '未开始',
                'actualStartDate': self._short_date(o.get('actualStartDate')),
                'actualEndDate': self._short_date(o.get('actualEndDate')),
                'execRemark': self._text(o.get('execRemark')),
                'status': self._text(o.get('status')) or '待处理',
                'planName': self._text(o.get('planName')), 'planCode': self._text(o.get('planCode')),
                'projectId': plan_project.get(self._text(o.get('planId'))) or
                             self._text(o.get('projectId')),
                'role': '责任人' if self._int(o.get('ownerId')) == me else '参与人员',
                'participantCount': len(parts),
                # 起止优先取关联任务的当前值（任务改期后工单不会显示过期日期）
                'startDate': self._short_date(o.get('linkedStartDate')) or
                             self._short_date(o.get('startDate')),
                'endDate': self._short_date(o.get('linkedEndDate')) or
                           self._short_date(o.get('endDate')),
                'execCount': exec_count.get(self._text(o.get('id')), 0),
                'changeCount': change_count.get(self._text(o.get('taskId')), 0),
                'noticeMsg': bool(self._int(o.get('noticeMsg'))),
                'noticeMail': bool(self._int(o.get('noticeMail'))),
                'dispatchTime': time_text(o.get('dispatchTime')),
                'link': 'workplan-design.html?id=%s&taskId=%s'
                        % (self._text(o.get('planId')), self._text(o.get('taskId')))
            })
            out.append(o)

        def match(o):
            kw = self._text(params.get('keyword')).lower()
            if kw and kw not in ('%s %s %s %s' % (o.get('orderCode', ''), o.get('taskName', ''),
                                                  o.get('planName', ''), o.get('planCode', ''))).lower():
                return False
            if self._text(params.get('sourceType')) and \
                    self._text(params.get('sourceType')) != o.get('sourceType'):
                return False
            if self._text(params.get('projectId')) and \
                    self._text(params.get('projectId')) != self._text(o.get('projectId')):
                return False
            for field in ('role', 'status', 'execStatus'):
                vals = [x.strip() for x in self._text(params.get(field)).split(',') if x.strip()]
                if vals and self._text(o.get(field)) not in vals:
                    return False
            return True

        out = [o for o in out if match(o)]
        out.sort(key=lambda o: o.get('dispatchTime') or '', reverse=True)
        total = len(out)
        page_num = max(1, self._int(params.get('pageNum'), 1))
        page_size = min(200, max(1, self._int(params.get('pageSize'), 10)))
        return {'list': out[(page_num - 1) * page_size: page_num * page_size],
                'total': total, 'pageNum': page_num, 'pageSize': page_size,
                'pages': int((total + page_size - 1) / page_size) if total else 0}

    # ---------------- 执行记录回填：我的任务工单 → 计划中的任务 ----------------
    def exec_record(self, params):
        """提交执行记录单（可多次）：回填任务执行字段 + 工单状态，并留档每次记录与附件。

        规则：任务已标记「已完成」后不再接受新的执行记录；未完成前不限次数。
        """
        params = params or {}
        me, me_name = self._me(params)
        order_id = self._uuid(params.get('orderId'), '工单ID')
        try:
            raw = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.ORDER_TABLE,
                            (order_id,))
            order = (dump_row(raw) or {}) if raw else {}
        except Exception:
            order = {}
        if not order.get('id'):
            raise BizError('工单不存在或已被删除', 404)
        part_ids = [x.strip() for x in (self._text(order.get('participantIds')) or '').split(',')
                    if x.strip()]
        if self._int(order.get('ownerId')) != me and str(me) not in part_ids:
            raise BizError('只有该工单的责任人或参与人员可以填写执行记录', 403)

        exec_status = self._text(params.get('execStatus')) or '未开始'
        if exec_status not in self.EXEC_STATUSES:
            raise BizError('完成状态不合法（未开始 / 进行中 / 已完成 / 已延期 / 已取消）')
        order_status = self._text(params.get('status')) or self._text(order.get('status')) or '待处理'
        if order_status not in self.ORDER_STATUSES:
            raise BizError('工单状态不合法（待处理 / 处理中 / 已完成）')
        actual_start = self._date(params.get('actualStartDate'), '实际开始时间')
        actual_end = self._date(params.get('actualEndDate'), '实际结束时间')
        if actual_start and actual_end and self._day(actual_start) > self._day(actual_end):
            raise BizError('实际开始时间不能晚于实际结束时间')
        if exec_status == '已完成' and not actual_end:
            actual_end = datetime.date.today().strftime('%Y-%m-%d')
        remark = self._text(params.get('execRemark') if params.get('execRemark') is not None
                            else params.get('content'))[:2000]
        title = self._text(params.get('title'))[:200] or ('执行记录 ' + datetime.datetime.now()
                                                          .strftime('%Y-%m-%d %H:%M'))
        task_id = self._text(order.get('taskId'))
        try:
            task = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1'
                             % self.TASK_TABLE, (task_id,)) or {}
        except Exception:
            task = {}
        if task and self._text(task.get('execStatus')) == '已完成':
            raise BizError('任务已完成，不能再提交执行记录；如确需补充请先在计划中调整完成状态', 403)
        plan_id = self._text(order.get('planId')) or self._text(task.get('planId'))
        plan = self._plan(plan_id) if plan_id else {}
        raw_progress = params.get('progress')
        progress = (self._int(task.get('progress')) if raw_progress is None
                    else min(100, max(0, self._int(raw_progress))))
        if exec_status == '已完成':
            progress = 100
        # 老库未跑 workplan-exec.sql 时，只更新工单状态并如实告知「未关联到执行记录」
        has_exec = False
        try:
            has_exec = bool(query_one(
                'SELECT `COLUMN_NAME` FROM information_schema.COLUMNS '
                'WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s AND COLUMN_NAME=%s LIMIT 1',
                (self.TASK_TABLE, 'execStatus')))
        except Exception:
            has_exec = False

        exec_id = str(uuid.uuid4())
        files = self._save_exec_files(exec_id, params.get('files'))
        task_name = self._text(task.get('taskName')) or self._text(order.get('orderTitle')) or ''

        def do(cur):
            cur.execute('UPDATE `%s` SET `status`=%%s,'
                        '`actualStartTime`=IFNULL(%%s,`actualStartTime`),'
                        '`actualEndTime`=IFNULL(%%s,`actualEndTime`) WHERE `id`=%%s'
                        % self.ORDER_TABLE,
                        (order_status,
                         (actual_start + ' 00:00:00') if actual_start else None,
                         (actual_end + ' 00:00:00') if actual_end else None,
                         order_id))
            if task and has_exec:
                cur.execute('UPDATE `%s` SET `execStatus`=%%s,`actualStartDate`=%%s,'
                            '`actualEndDate`=%%s,`execRemark`=%%s,`progress`=%%s WHERE `id`=%%s'
                            % self.TASK_TABLE,
                            (exec_status, actual_start or None, actual_end or None,
                             remark or None, progress, task_id))
            cur.execute('INSERT INTO `%s` (`id`,`planId`,`taskId`,`orderId`,`planName`,`taskName`,'
                        '`title`,`content`,`progress`,`execStatus`,`actualStartDate`,'
                        '`actualEndDate`,`operatorId`,`operatorName`) '
                        'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)'
                        % self.EXEC_TABLE,
                        (exec_id, plan_id or None, task_id or None, order_id,
                         self._text(plan.get('planName')) or None, task_name or None,
                         title, remark or None, progress, exec_status,
                         actual_start or None, actual_end or None, me, me_name or None))
            for f in files:
                cur.execute('INSERT INTO `%s` (`id`,`execId`,`name`,`path`,`size`,`ext`) '
                            'VALUES (%%s,%%s,%%s,%%s,%%s,%%s)' % self.EXECFILE_TABLE,
                            (f['id'], exec_id, f['name'], f['path'], f['size'], f['ext']))

        transaction(do)
        linked = bool(task and has_exec)
        # 执行记录也是任务变更：写变更日志并推送给创建人 / 责任人 / 参与人
        try:
            summary = '提交执行记录「%s」（%s，完成 %d%%）' % (title, exec_status, progress)
            self._log_change(plan_id, task_id, task_name, 'exec', summary,
                             (remark or '') + (('；附件 %d 个' % len(files)) if files else ''),
                             me, me_name)
            note = self._notify_changes(plan, [{'action': 'exec', 'taskId': task_id,
                                                'taskName': task_name, 'summary': summary,
                                                'detail': remark}], me, me_name, [])
        except Exception:
            note = {'notified': 0, 'mailed': 0}
        return {
            'execId': exec_id, 'orderId': order_id, 'taskId': task_id, 'taskLinked': linked,
            'title': title, 'content': remark,
            'execStatus': exec_status, 'actualStartDate': actual_start,
            'actualEndDate': actual_end, 'execRemark': remark,
            'progress': progress, 'status': order_status,
            'files': [dict(f, url='/api/workplan/execfile?id=%s' % f['id']) for f in files],
            'notified': note.get('notified', 0), 'mailed': note.get('mailed', 0),
            'message': ('执行记录已提交' + ('' if linked else '；关联任务不存在或未升级执行记录列，仅更新了工单状态')
                        + ('，附件 %d 个' % len(files) if files else ''))
        }

    # ---------------- 执行记录 / 变更日志 / 附件预览 ----------------
    def execs(self, params):
        """某工单 / 任务 / 计划的执行记录单（含附件元数据），按时间倒序。"""
        params = params or {}
        me, _name = self._me(params)
        order_id = self._uuid(params.get('orderId'), '工单ID') if params.get('orderId') else ''
        task_id = self._uuid(params.get('taskId'), '任务ID') if params.get('taskId') else ''
        plan_id = self._uuid(params.get('planId'), '计划ID') if params.get('planId') else ''
        if order_id and not plan_id:
            order = query_one('SELECT `planId` FROM `%s` WHERE `id`=%%s LIMIT 1'
                              % self.ORDER_TABLE, (order_id,)) or {}
            plan_id = self._text(order.get('planId'))
        if plan_id:
            self._visible(self._plan(plan_id), me)
        elif not (task_id or order_id):
            raise BizError('缺少查询条件（orderId / taskId / planId）')
        where, args = [], []
        for key, val in (('orderId', order_id), ('taskId', task_id), ('planId', plan_id)):
            if val:
                where.append('`%s`=%%s' % key)
                args.append(val)
        try:
            rows = query_all('SELECT * FROM `%s` WHERE %s ORDER BY `createTime` DESC,`id` LIMIT 200'
                             % (self.EXEC_TABLE, ' AND '.join(where)), tuple(args)) or []
        except Exception:
            rows = []
        files = self._exec_files([self._text(r.get('id')) for r in rows])
        out = []
        for r in rows:
            e = dump_row(r)
            eid = self._text(e.get('id'))
            out.append({
                'id': eid, 'planId': self._text(e.get('planId')),
                'taskId': self._text(e.get('taskId')), 'orderId': self._text(e.get('orderId')),
                'title': self._text(e.get('title')), 'content': self._text(e.get('content')),
                'progress': self._int(e.get('progress')),
                'execStatus': self._text(e.get('execStatus')),
                'actualStartDate': self._short_date(e.get('actualStartDate')),
                'actualEndDate': self._short_date(e.get('actualEndDate')),
                'operatorId': self._int(e.get('operatorId')),
                'operatorName': self._text(e.get('operatorName')),
                'createTime': time_text(e.get('createTime')),
                'files': files.get(eid, [])
            })
        return {'list': out, 'total': len(out)}

    def changelogs(self, params):
        """计划变更时间线（可按 taskId 过滤），时间倒序。"""
        params = params or {}
        me, _name = self._me(params)
        plan_id = self._uuid(params.get('planId') or params.get('id'), '计划ID')
        plan = self._plan(plan_id)
        self._visible(plan, me)
        where, args = ['`planId`=%s'], [plan_id]
        if params.get('taskId'):
            tid = self._uuid(params.get('taskId'), '任务ID')
            if self._bool(params.get('withPlan'), 0):
                where.append('(`taskId`=%s OR `taskId` IS NULL)')
            else:
                where.append('`taskId`=%s')
            args.append(tid)
        try:
            rows = query_all('SELECT * FROM `%s` WHERE %s ORDER BY `createTime` DESC,`id` LIMIT 300'
                             % (self.LOG_TABLE, ' AND '.join(where)), tuple(args)) or []
        except Exception:
            rows = []
        # 历史日志里「前置任务 / 上级任务」可能存的是任务 ID；读取时统一换成任务名
        task_names = {}
        try:
            for t in (query_all('SELECT `id`,`taskName` FROM `%s` WHERE `planId`=%%s'
                                % self.TASK_TABLE, (plan_id,)) or []):
                task_names[self._text(t.get('id'))] = self._text(t.get('taskName')) or '未命名任务'
        except Exception:
            task_names = {}

        def localize_detail(detail):
            text = self._text(detail)
            if not text:
                return ''
            def conv(part):
                part = (part or '').strip()
                if not part or part == '空':
                    return '空'
                vals = [x.strip() for x in part.split(',') if x.strip()]
                out = []
                for x in vals:
                    if x in task_names:
                        out.append(task_names[x])
                    elif RE_UUID.match(x):
                        out.append('未知任务')
                    else:
                        out.append(x)          # 已经是任务名（新日志）
                return '、'.join(out) or '空'
            lines = []
            for line in text.split('\n'):
                head, sep, tail = line.partition('：')
                if sep and head in ('前置任务', '上级任务'):
                    old, arrow, new = tail.partition(' → ')
                    line = head + '：' + conv(old) + ((' → ' + conv(new)) if arrow else '')
                lines.append(line)
            return '\n'.join(lines)

        out = []
        for r in rows:
            row = dump_row(r)
            out.append({
                'id': self._text(row.get('id')), 'taskId': self._text(row.get('taskId')),
                'taskName': self._text(row.get('taskName')),
                'action': self._text(row.get('action')), 'summary': self._text(row.get('summary')),
                'detail': localize_detail(row.get('detail')),
                'operatorId': self._int(row.get('operatorId')),
                'operatorName': self._text(row.get('operatorName')),
                'createTime': time_text(row.get('createTime'))
            })
        return {'list': out, 'total': len(out), 'planName': self._text(plan.get('planName'))}

    def _exec_file_row(self, file_id, me):
        """执行记录附件：取元数据 + 校验计划可见性 + 返回磁盘绝对路径。"""
        file_id = self._uuid(file_id, '附件ID')
        try:
            row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.EXECFILE_TABLE,
                            (file_id,))
        except Exception:
            row = None
        if not row:
            raise BizError('附件不存在或已被删除', 404)
        f = dump_row(row)
        plan_id = ''
        try:
            exec_row = query_one('SELECT `planId` FROM `%s` WHERE `id`=%%s LIMIT 1'
                                 % self.EXEC_TABLE, (self._text(f.get('execId')),)) or {}
            plan_id = self._text(exec_row.get('planId'))
        except Exception:
            pass
        if plan_id:
            self._visible(self._plan(plan_id), me)
        full = os.path.join(self.UPLOAD_ROOT, self._text(f.get('path')))
        if not os.path.isfile(full):
            raise BizError('附件文件已丢失', 404)
        return f, full

    def exec_raw(self, params):
        """附件原始字节流（在线预览 / 下载共用）：mime 按扩展名推断。"""
        params = params or {}
        me, _name = self._me(params)
        f, full = self._exec_file_row(params.get('id'), me)
        try:
            with open(full, 'rb') as fh:
                content = fh.read()
        except OSError:
            raise BizError('附件读取失败，请重试')
        ext = self._text(f.get('ext')).lower()
        mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
                'pdf': 'application/pdf', 'txt': 'text/plain; charset=utf-8',
                'csv': 'text/csv; charset=utf-8', 'json': 'application/json',
                'doc': 'application/msword',
                'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'xls': 'application/vnd.ms-excel',
                'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'ppt': 'application/vnd.ms-powerpoint',
                'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                'zip': 'application/zip'}.get(ext, 'application/octet-stream')
        return {'content': content, 'filename': self._text(f.get('name')) or '附件',
                'contentType': mime}

    def exec_pdf(self, params):
        """Word / PowerPoint 旧格式转 PDF 预览（沿用项目文件的预览转换器，带磁盘缓存）。"""
        params = params or {}
        me, _name = self._me(params)
        f, full = self._exec_file_row(params.get('id'), me)
        ext = self._text(f.get('ext')).lower()
        if ext == 'pdf':
            with open(full, 'rb') as fh:
                content = fh.read()
        elif ext in ('doc', 'docm', 'docx', 'ppt', 'pptm', 'pptx'):
            from preview_convert import convert_to_pdf
            try:
                pdf_path = convert_to_pdf(full, ext)
            except RuntimeError as exc:
                raise BizError(str(exc))
            except Exception:
                traceback.print_exc()
                raise BizError('文档转换服务异常，请稍后重试或下载查看')
            with open(pdf_path, 'rb') as fh:
                content = fh.read()
        else:
            raise BizError('该文件类型不支持转 PDF 预览')
        stem = os.path.splitext(self._text(f.get('name')) or '附件')[0]
        return {'content': content, 'filename': stem + '.pdf'}

    def execfile(self, params):
        """执行记录附件预览 / 下载：返回 dataUrl（≤10 MB），前端可新窗口打开或图片内联预览。"""
        params = params or {}
        me, _name = self._me(params)
        file_id = self._uuid(params.get('id'), '附件ID')
        try:
            row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.EXECFILE_TABLE,
                            (file_id,))
        except Exception:
            row = None
        if not row:
            raise BizError('附件不存在或已被删除', 404)
        f = dump_row(row)
        try:
            exec_row = query_one('SELECT `planId` FROM `%s` WHERE `id`=%%s LIMIT 1'
                                 % self.EXEC_TABLE, (self._text(f.get('execId')),)) or {}
        except Exception:
            exec_row = {}
        plan_id = self._text(exec_row.get('planId'))
        if plan_id:
            self._visible(self._plan(plan_id), me)
        path = os.path.join(self.UPLOAD_ROOT, self._text(f.get('path')))
        if not os.path.isfile(path):
            raise BizError('附件文件已丢失', 404)
        size = os.path.getsize(path)
        if size > 10 * 1024 * 1024:
            raise BizError('附件超过 10 MB，无法在线预览')
        with open(path, 'rb') as fh:
            blob = fh.read()
        ext = self._text(f.get('ext')).lower()
        mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                'gif': 'image/gif', 'pdf': 'application/pdf'}.get(ext, 'application/octet-stream')
        return {'id': file_id, 'name': self._text(f.get('name')), 'ext': ext, 'size': size,
                'mime': mime,
                'dataUrl': 'data:%s;base64,%s' % (mime, base64.b64encode(blob).decode('ascii'))}


class RequirementService(object):
    """需求池：全局一个池、按项目分类；需求与研发计划一对一。"""

    TABLE = 'requirements'
    EVAL_TABLE = 'requirementevaluations'
    EVAL_FILE_TABLE = 'requirementevaluationfiles'
    FILE_TABLE = 'requirementfiles'
    PLAN_TABLE = 'workplans'
    ORDER_TABLE = 'workplanorders'
    TASK_TABLE = 'workplantasks'
    UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads', 'requirement')
    EVAL_UPLOAD_ROOT = os.path.join(UPLOAD_ROOT, 'evaluation')
    STATUS_WAIT = '待评估'
    STATUS_APPROVED = '已通过'
    STATUS_PASS = '响应'
    STATUS_REJECT = '已不通过'
    STATUS_REJECT_FINAL = '决定不响应'
    STATUS_PLAN = '已转计划'

    def _text(self, value):
        return '' if value is None else str(value).strip()

    def _int(self, value, default=0):
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def _uuid(self, value, label='需求ID'):
        text = self._text(value).lower()
        if not text:
            return ''
        if not re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', text):
            raise BizError(label + '格式不正确')
        return text

    def _me(self, params):
        return work_plan_service._me(params or {})

    def _emp(self, emp_id):
        try:
            return dump_row(query_one(
                'SELECT `id`,`nameCn`,`email` FROM `empinfos` WHERE `id`=%s LIMIT 1',
                (self._int(emp_id),))) or {}
        except Exception:
            return {}

    def _emp_by_empid(self, emp_id):
        try:
            return dump_row(query_one(
                'SELECT `id`,`nameCn`,`email` FROM `empinfos` WHERE `id`=%s LIMIT 1',
                (self._int(emp_id),))) or {}
        except Exception:
            return {}

    def _row(self, req_id):
        req_id = self._uuid(req_id)
        try:
            row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.TABLE, (req_id,))
        except Exception:
            row = None
        if not row:
            raise BizError('需求不存在或已被删除', 404)
        return dump_row(row)

    def _next_code(self):
        try:
            rows = query_all('SELECT `reqCode` FROM `%s` WHERE `reqCode` LIKE %%s' % self.TABLE,
                             ('REQ%',)) or []
        except Exception:
            rows = []
        max_no = 0
        for one in rows:
            code = self._text(one.get('reqCode'))
            try:
                max_no = max(max_no, int(code[3:]))
            except (TypeError, ValueError):
                continue
        return 'REQ%06d' % (max_no + 1)

    def page(self, params):
        params = params or {}
        self._me(params)
        where, args = ['1=1'], []
        project_id = self._uuid(params.get('projectId'), '项目ID') if params.get('projectId') else ''
        if project_id:
            where.append('r.`projectId`=%s')
            args.append(project_id)
        statuses = [x.strip() for x in self._text(params.get('status')).split(',') if x.strip()]
        if statuses:
            where.append('r.`status` IN (%s)' % ','.join(['%s'] * len(statuses)))
            args.extend(statuses)
        keyword = self._text(params.get('keyword')).lower()
        if keyword:
            where.append('(LOWER(r.`reqCode`) LIKE %s OR LOWER(r.`title`) LIKE %s '
                         'OR LOWER(r.`projectName`) LIKE %s)')
            args += ['%%%s%%' % keyword] * 3
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 10), 1), 100)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        try:
            total = self._int((query_one(
                'SELECT COUNT(*) AS n FROM `%s` r WHERE %s' % (self.TABLE, ' AND '.join(where)),
                tuple(args)) or {}).get('n'))
            rows = query_all(
                'SELECT r.*, p.`planCode`, p.`planName`, p.`status` AS `planStatus`, '
                '(SELECT COUNT(*) FROM `%s` e WHERE e.`requirementId`=r.`id`) AS `evalCount` '
                'FROM `%s` r LEFT JOIN `%s` p ON p.`id`=r.`planId` WHERE %s '
                'ORDER BY r.`createTime` DESC, r.`reqCode` ASC LIMIT %%s OFFSET %%s'
                % (self.EVAL_TABLE, self.TABLE, self.PLAN_TABLE, ' AND '.join(where)),
                tuple(args + [page_size, (page_num - 1) * page_size])) or []
        except Exception:
            rows, total = [], 0
        out = []
        for r in rows:
            one = dump_row(r)
            one['estimatedHours'] = float(one.get('estimatedHours') or 0)
            out.append(one)
        return {'list': out, 'total': total, 'pageNum': page_num,
                'pageSize': page_size, 'pages': int((total + page_size - 1) / page_size)}

    def detail(self, params):
        params = params or {}
        self._me(params)
        req = self._row(params.get('id'))
        try:
            evaluations = [dump_row(r) for r in (query_all(
                'SELECT * FROM `%s` WHERE `requirementId`=%%s ORDER BY `createTime` ASC, `id` ASC'
                % self.EVAL_TABLE, (req['id'],)) or [])]
        except Exception:
            evaluations = []
        for one in evaluations:
            try:
                one['files'] = [dump_row(r) for r in (query_all(
                    'SELECT `id`,`name`,`size`,`ext`,`uploaderName`,`uploadTime` FROM `%s` '
                    'WHERE `evaluationId`=%%s ORDER BY `uploadTime`,`id`' % self.EVAL_FILE_TABLE,
                    (one.get('id'),)) or [])]
            except Exception:
                one['files'] = []
        plan = {}
        if req.get('planId'):
            try:
                plan = dump_row(query_one(
                    'SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.PLAN_TABLE,
                    (req['planId'],))) or {}
            except Exception:
                plan = {}
        plan['estimatedHours'] = float(req.get('estimatedHours') or 0)
        try:
            files = [dump_row(r) for r in (query_all(
                'SELECT `id`,`name`,`size`,`ext`,`uploaderName`,`uploadTime` FROM `%s` '
                'WHERE `requirementId`=%%s ORDER BY `uploadTime`,`id`' % self.FILE_TABLE,
                (req['id'],)) or [])]
        except Exception:
            files = []
        return {'requirement': req, 'evaluations': evaluations, 'plan': plan, 'files': files}

    def add(self, data):
        data = data or {}
        me, name = self._me(data)
        title = self._text(data.get('title'))
        if not title:
            raise BizError('需求标题不能为空')
        if len(title) > 200:
            raise BizError('需求标题不能超过 200 个字符')
        project_id = self._uuid(data.get('projectId'), '项目ID') if data.get('projectId') else ''
        project_name = ''
        if project_id:
            try:
                project = dump_row(query_one(
                    'SELECT * FROM `projectinfos` WHERE `id`=%s LIMIT 1', (project_id,))) or {}
            except Exception:
                project = {}
            if not project:
                raise BizError('所属项目不存在或已被删除')
            project_name = self._text(project.get('projectName'))
        req_id = str(uuid.uuid4())
        try:
            execute(
                'INSERT INTO `%s` (`id`,`reqCode`,`title`,`description`,`descriptionHtml`,'
                '`projectId`,`projectName`,`sourceType`,`priority`,`expectedDate`,'
                '`requesterId`,`requesterName`,`status`) '
                'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)'
                % self.TABLE,
                (req_id, self._next_code(), title, self._text(data.get('description')),
                 self._text(data.get('descriptionHtml')) or None,
                 project_id or None, project_name or None,
                 self._text(data.get('sourceType')) or '内部改进',
                 self._text(data.get('priority')) or '中',
                 self._text(data.get('expectedDate')) or None,
                 me, name, self.STATUS_WAIT))
        except DuplicateError:
            raise BizError('需求编号冲突，请重试')
        self._notify(self._row(req_id), '需求已提交',
                      '需求「%s」已进入需求池，等待评估。' % title, sender_id=me)
        return {'id': req_id, 'message': '需求已提交，等待评估'}

    def update(self, data):
        data = data or {}
        me, name = self._me(data)
        req = self._row(data.get('id'))
        if self._int(req.get('requesterId')) != me:
            raise BizError('只有需求提出人可以修改该需求', 403)
        if self._text(req.get('status')) == self.STATUS_PLAN:
            raise BizError('需求已生成研发计划，不能再修改')
        project_id = self._uuid(data.get('projectId'), '项目ID') if data.get('projectId') else ''
        project_name = ''
        if project_id:
            try:
                project = dump_row(query_one(
                    'SELECT * FROM `projectinfos` WHERE `id`=%s LIMIT 1', (project_id,))) or {}
            except Exception:
                project = {}
            if not project:
                raise BizError('所属项目不存在或已被删除')
            project_name = self._text(project.get('projectName'))
        title = self._text(data.get('title')) or req.get('title')
        execute(
            'UPDATE `%s` SET `title`=%%s,`description`=%%s,`descriptionHtml`=%%s,'
            '`projectId`=%%s,`projectName`=%%s,'
            '`sourceType`=%%s,`priority`=%%s,`expectedDate`=%%s WHERE `id`=%%s' % self.TABLE,
            (title, self._text(data.get('description')),
             self._text(data.get('descriptionHtml')) or None, project_id or None,
             project_name or None, self._text(data.get('sourceType')) or '内部改进',
             self._text(data.get('priority')) or '中',
             self._text(data.get('expectedDate')) or None, req['id']))
        req = self._row(req['id'])
        self._notify(req, '需求信息变更', '需求「%s」的信息已更新。' % title, sender_id=me)
        return {'id': req['id'], 'message': '需求已更新'}

    def evaluate(self, params):
        params = params or {}
        me, name = self._me(params)
        req = self._row(params.get('id'))
        status = self._text(req.get('status'))
        if status in (self.STATUS_APPROVED, self.STATUS_PASS,
                      self.STATUS_PLAN, self.STATUS_REJECT_FINAL):
            raise BizError('该需求已通过或已响应，不能再次评估')
        result = self._text(params.get('result'))
        if result not in ('通过', '不通过'):
            raise BizError('评估结论只能是「通过」或「不通过」')
        reason = self._text(params.get('reason'))
        if result == '不通过' and not reason:
            raise BizError('不通过时必须填写原因')
        raw_ids = params.get('evaluatorIds')
        if isinstance(raw_ids, (list, tuple)):
            evaluator_ids = [self._int(x) for x in raw_ids if self._int(x)]
        else:
            evaluator_ids = [self._int(x) for x in self._text(raw_ids).split(',') if self._int(x)]
        evaluator_ids = [x for x in evaluator_ids if x]
        if not evaluator_ids:
            raise BizError('请选择参与评估的人员')
        evaluator_names = []
        for eid in evaluator_ids:
            emp = self._emp_by_empid(eid)
            evaluator_names.append(self._text(emp.get('nameCn')) or ('员工%d' % eid))
        hours = 0.0
        if result == '通过':
            try:
                hours = float(params.get('estimatedHours') or 0)
            except (TypeError, ValueError):
                hours = 0
            if hours <= 0:
                raise BizError('评估通过时必须填写评估工时（人时）')
            final_decision = '待响应'
            next_status = self.STATUS_APPROVED
        else:
            final_decision = self._text(params.get('finalDecision')) or '继续评估'
            if final_decision not in ('继续评估', '决定不响应'):
                raise BizError('不通过后的处理只能是「继续评估」或「决定不响应」')
            next_status = (self.STATUS_REJECT_FINAL if final_decision == '决定不响应'
                           else self.STATUS_REJECT)
        eval_id = str(uuid.uuid4())
        try:
            execute(
                'INSERT INTO `%s` (`id`,`requirementId`,`result`,`finalDecision`,`reason`,'
                '`reasonHtml`,`estimatedHours`,`evaluatorIds`,`evaluatorNames`,'
                '`operatorId`,`operatorName`) '
                'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)' % self.EVAL_TABLE,
                (eval_id, req['id'], result, final_decision, reason or None,
                 self._text(params.get('reasonHtml')) or None, hours or None,
                 ','.join([str(x) for x in evaluator_ids]), ','.join(evaluator_names), me, name))
            execute('UPDATE `%s` SET `status`=%%s,`estimatedHours`=%%s WHERE `id`=%%s' % self.TABLE,
                    (next_status, hours or None, req['id']))
        except Exception as exc:
            raise BizError('评估保存失败：%s' % exc)
        req = self._row(req['id'])
        try:
            eval_count = self._int((query_one(
                'SELECT COUNT(*) AS n FROM `%s` WHERE `requirementId`=%%s' % self.EVAL_TABLE,
                (req['id'],)) or {}).get('n'))
        except Exception:
            eval_count = 1
        if result == '通过':
            content = '需求「%s」第 %s 次评估通过，状态「已通过」，等待决定是否响应；评估工时 %s 人时。' % (
                req.get('title'), eval_count or 1, hours)
        elif final_decision == '决定不响应':
            content = '需求「%s」评估不通过，最终决定「决定不响应」，原因：%s' % (
                req.get('title'), reason)
        else:
            content = '需求「%s」评估不通过，后续继续评估，原因：%s' % (req.get('title'), reason)
        self._notify(req, '需求评估结果：' + (final_decision or result),
                     content, extra_ids=evaluator_ids, sender_id=me)
        return {'id': eval_id, 'status': req['status'],
                'finalDecision': final_decision, 'message': '评估结果已保存'}

    def respond(self, params):
        """响应否：最终决定「响应」或「决定不响应」，并生成一条评审记录。"""
        params = params or {}
        me, name = self._me(params)
        req = self._row(params.get('id'))
        status = self._text(req.get('status'))
        if status in (self.STATUS_PASS, self.STATUS_PLAN, self.STATUS_REJECT_FINAL):
            raise BizError('该需求已响应或已决定不响应，不能再次操作')
        if status != self.STATUS_APPROVED:
            raise BizError('只有评估通过（已通过）的需求才能点响应按钮', 403)
        decision = self._text(params.get('decision'))
        if decision not in ('响应', '决定不响应'):
            raise BizError('响应否只能选择「响应」或「决定不响应」')
        remark = self._text(params.get('remark'))
        if decision == '决定不响应' and not remark:
            raise BizError('决定不响应时必须填写说明 / 原因')
        try:
            hours = float(params.get('estimatedHours') or 0)
        except (TypeError, ValueError):
            hours = 0
        final_status = self.STATUS_PASS if decision == '响应' else self.STATUS_REJECT_FINAL
        eval_id = ''
        try:
            latest = query_one(
                'SELECT `id` FROM `%s` WHERE `requirementId`=%%s '
                'ORDER BY `createTime` DESC, `id` DESC LIMIT 1' % self.EVAL_TABLE,
                (req['id'],))
            if latest:
                eval_id = latest['id']
                execute('UPDATE `%s` SET `finalDecision`=%%s,`reason`=COALESCE(%%s,`reason`),'
                        '`estimatedHours`=COALESCE(%%s,`estimatedHours`) WHERE `id`=%%s'
                        % self.EVAL_TABLE,
                        (decision, remark or None, hours or None, eval_id))
            execute('UPDATE `%s` SET `status`=%%s,`estimatedHours`=%%s WHERE `id`=%%s' % self.TABLE,
                    (final_status, hours or None, req['id']))
        except Exception as exc:
            raise BizError('响应否保存失败：%s' % exc)
        req = self._row(req['id'])
        content = '需求「%s」最终决定：%s。%s' % (
            req.get('title'), decision, ('说明：' + remark) if remark else '')
        self._notify(req, '需求响应否：' + decision, content,
                     extra_ids=[me], sender_id=me)
        return {'id': eval_id, 'status': final_status,
                'finalDecision': decision, 'message': '响应否已保存'}

    def create_plan(self, params):
        params = params or {}
        me, name = self._me(params)
        req = self._row(params.get('id'))
        if self._text(req.get('status')) != self.STATUS_PASS:
            raise BizError('只有最终决定「响应」的需求才能分配研发计划')
        if req.get('planId'):
            raise BizError('该需求已分配研发计划')
        start = datetime.date.today()
        end_date = self._text(req.get('expectedDate'))
        try:
            end = datetime.datetime.strptime(end_date, '%Y-%m-%d').date() if end_date else start + datetime.timedelta(days=30)
        except ValueError:
            end = start + datetime.timedelta(days=30)
        if end < start:
            end = start
        plan_name = self._text(req.get('title'))
        accept_type = self._text(params.get('acceptOwnerType')) or 'default'
        accept_id, accept_name = me, name
        if accept_type == 'project':
            project_id = self._text(req.get('projectId'))
            project = {}
            if project_id:
                try:
                    project = dump_row(query_one(
                        'SELECT * FROM `projectinfos` WHERE `id`=%s LIMIT 1', (project_id,))) or {}
                except Exception:
                    project = {}
            pid = self._int(project.get('createempinfosid'))
            if pid:
                accept_id = pid
                accept_name = self._text(self._emp_by_empid(pid).get('nameCn')) or '项目负责人'
        elif accept_type == 'custom':
            accept_id = self._int(params.get('acceptOwnerId'))
            if not accept_id:
                raise BizError('请选择指定的验收人')
            emp = self._emp_by_empid(accept_id)
            if not emp:
                raise BizError('指定的验收人不存在')
            accept_name = self._text(emp.get('nameCn')) or '验收人'
        res = work_plan_service.save({
            '_loginUserId': params.get('_loginUserId'),
            'plan': {
                'planName': plan_name,
                'planDesc': '来源需求：%s %s\\n%s' % (req.get('reqCode'), plan_name,
                                                    self._text(req.get('description'))),
                'projectId': req.get('projectId') or '',
                'projectName': req.get('projectName') or '',
                'startDate': start.strftime('%Y-%m-%d'),
                'endDate': end.strftime('%Y-%m-%d'),
                'scale': 'day', 'skipWeekend': 0, 'ispub': 1,
            },
            'tasks': [],
        })
        plan_id = res.get('id')
        if not plan_id:
            raise BizError('研发计划创建失败')
        execute('UPDATE `%s` SET `requirementId`=%%s WHERE `id`=%%s' % self.PLAN_TABLE,
                (req['id'], plan_id))
        execute('UPDATE `%s` SET `planId`=%%s,`status`=%%s,`acceptOwnerId`=%%s,'
                '`acceptOwnerName`=%%s WHERE `id`=%%s' % self.TABLE,
                (plan_id, self.STATUS_PLAN, accept_id, accept_name, req['id']))
        req = self._row(req['id'])
        self._notify(req, '需求已分配研发计划',
                      '需求「%s」已生成研发计划 %s，请到计划管理中编排任务。'
                      % (req.get('title'), res.get('planCode') or plan_id), sender_id=me)
        return {'id': req['id'], 'planId': plan_id, 'planCode': res.get('planCode'),
                'message': '已生成研发计划，请继续编排任务'}

    def upload(self, params):
        """需求附件：base64 JSON 上传（最多 10 个 / 单个 10MB / 合计 30MB）。"""
        params = params or {}
        me, name = self._me(params)
        req = self._row(params.get('requirementId') or params.get('id'))
        raw = params.get('files')
        if not isinstance(raw, list) or not raw:
            raise BizError('请选择要上传的附件')
        folder = os.path.join(self.UPLOAD_ROOT, req['id'])
        if not os.path.isdir(folder):
            os.makedirs(folder)
        saved, total = [], 0
        for item in raw[:10]:
            item = item or {}
            fname = os.path.basename(self._text(item.get('name')).replace('\\', '/'))[:255]
            if not fname:
                continue
            text = self._text(item.get('data'))
            if ';base64,' in text[:300]:
                text = text.split(';base64,', 1)[1]
            try:
                blob = base64.b64decode(text.encode('ascii'), validate=True) if text else b''
            except Exception:
                raise BizError('附件「%s」数据不合法' % fname)
            if not blob:
                continue
            if len(blob) > 10 * 1024 * 1024:
                raise BizError('附件「%s」超过 10 MB' % fname)
            total += len(blob)
            if total > 30 * 1024 * 1024:
                raise BizError('附件合计超过 30 MB')
            ext = os.path.splitext(fname)[1].lstrip('.').lower()[:20]
            stored = str(uuid.uuid4()) + ('.' + ext if ext else '')
            with open(os.path.join(folder, stored), 'wb') as fp:
                fp.write(blob)
            fid = str(uuid.uuid4())
            execute('INSERT INTO `%s` (`id`,`requirementId`,`name`,`path`,`size`,`ext`,'
                    '`uploaderId`,`uploaderName`) VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)'
                    % self.FILE_TABLE,
                    (fid, req['id'], fname, os.path.join(req['id'], stored), len(blob),
                     ext or None, me, name))
            saved.append({'id': fid, 'name': fname, 'size': len(blob), 'ext': ext})
        if not saved:
            raise BizError('没有可上传的附件')
        self._notify(req, '需求附件更新',
                     '需求「%s」新增 %d 个附件。' % (req.get('title'), len(saved)), sender_id=me)
        return {'files': saved, 'message': '已上传 %d 个附件' % len(saved)}

    def file_data(self, params):
        params = params or {}
        me, _name = self._me(params)
        fid = self._uuid(params.get('id'), '附件ID')
        try:
            row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.FILE_TABLE, (fid,))
        except Exception:
            row = None
        if not row:
            raise BizError('附件不存在或已被删除', 404)
        f = dump_row(row)
        self._row(f.get('requirementId'))          # 需求存在即可见（全局需求池）
        path = os.path.join(self.UPLOAD_ROOT, self._text(f.get('path')))
        if not os.path.isfile(path):
            raise BizError('附件文件已丢失', 404)
        with open(path, 'rb') as fp:
            blob = fp.read()
        ext = self._text(f.get('ext')).lower()
        mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                'gif': 'image/gif', 'pdf': 'application/pdf'}.get(ext, 'application/octet-stream')
        return {'id': fid, 'name': self._text(f.get('name')), 'ext': ext,
                'size': len(blob), 'mime': mime,
                'dataUrl': 'data:%s;base64,%s' % (mime, base64.b64encode(blob).decode('ascii'))}

    def evaluation_upload(self, params):
        """评估记录附件：保存到本次评审记录，规则同需求附件。"""
        params = params or {}
        me, name = self._me(params)
        eval_id = self._uuid(params.get('evaluationId'), '评估记录ID')
        try:
            ev = dump_row(query_one(
                'SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.EVAL_TABLE, (eval_id,))) or {}
        except Exception:
            ev = {}
        if not ev:
            raise BizError('评估记录不存在或已被删除', 404)
        req = self._row(ev.get('requirementId'))
        raw = params.get('files')
        if not isinstance(raw, list) or not raw:
            raise BizError('请选择要上传的附件')
        folder = os.path.join(self.EVAL_UPLOAD_ROOT, eval_id)
        if not os.path.isdir(folder):
            os.makedirs(folder)
        saved, total = [], 0
        for item in raw[:10]:
            item = item or {}
            fname = os.path.basename(self._text(item.get('name')).replace('\\', '/'))[:255]
            if not fname:
                continue
            text = self._text(item.get('data'))
            if ';base64,' in text[:300]:
                text = text.split(';base64,', 1)[1]
            try:
                blob = base64.b64decode(text.encode('ascii'), validate=True) if text else b''
            except Exception:
                raise BizError('附件「%s」数据不合法' % fname)
            if not blob:
                continue
            if len(blob) > 10 * 1024 * 1024:
                raise BizError('附件「%s」超过 10 MB' % fname)
            total += len(blob)
            if total > 30 * 1024 * 1024:
                raise BizError('附件合计超过 30 MB')
            ext = os.path.splitext(fname)[1].lstrip('.').lower()[:20]
            stored = str(uuid.uuid4()) + ('.' + ext if ext else '')
            with open(os.path.join(folder, stored), 'wb') as fp:
                fp.write(blob)
            fid = str(uuid.uuid4())
            execute('INSERT INTO `%s` (`id`,`evaluationId`,`requirementId`,`name`,`path`,'
                    '`size`,`ext`,`uploaderId`,`uploaderName`) '
                    'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)' % self.EVAL_FILE_TABLE,
                    (fid, eval_id, req['id'], fname, os.path.join(eval_id, stored),
                     len(blob), ext or None, me, name))
            saved.append({'id': fid, 'name': fname, 'size': len(blob), 'ext': ext})
        if not saved:
            raise BizError('没有可上传的附件')
        self._notify(req, '需求评估附件更新',
                     '需求「%s」的评估记录新增 %d 个附件。' % (req.get('title'), len(saved)),
                     sender_id=me)
        return {'files': saved, 'message': '已上传 %d 个附件' % len(saved)}

    def evaluation_file(self, params):
        params = params or {}
        me, _name = self._me(params)
        fid = self._uuid(params.get('id'), '附件ID')
        try:
            row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.EVAL_FILE_TABLE,
                            (fid,))
        except Exception:
            row = None
        if not row:
            raise BizError('附件不存在或已被删除', 404)
        f = dump_row(row)
        self._row(f.get('requirementId'))
        path = os.path.join(self.EVAL_UPLOAD_ROOT, self._text(f.get('path')))
        if not os.path.isfile(path):
            raise BizError('附件文件已丢失', 404)
        with open(path, 'rb') as fp:
            blob = fp.read()
        ext = self._text(f.get('ext')).lower()
        mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                'gif': 'image/gif', 'pdf': 'application/pdf'}.get(ext, 'application/octet-stream')
        return {'id': fid, 'name': self._text(f.get('name')), 'ext': ext,
                'size': len(blob), 'mime': mime,
                'dataUrl': 'data:%s;base64,%s' % (mime, base64.b64encode(blob).decode('ascii'))}

    def _latest_evaluators(self, req_id):
        try:
            rows = query_all('SELECT `evaluatorIds` FROM `%s` WHERE `requirementId`=%%s '
                             'ORDER BY `createTime` DESC' % self.EVAL_TABLE, (req_id,)) or []
        except Exception:
            rows = []
        ids = []
        for r in rows:
            for x in (self._text(r.get('evaluatorIds')) or '').split(','):
                n = self._int(x)
                if n and n not in ids:
                    ids.append(n)
        return ids

    def _plan_people(self, plan_id):
        if not plan_id:
            return []
        try:
            tasks = [dump_row(r) for r in (query_all(
                'SELECT `ownerId`,`participantIds` FROM `%s` WHERE `planId`=%%s'
                % self.TASK_TABLE, (plan_id,)) or [])]
        except Exception:
            tasks = []
        ids = []
        for t in tasks:
            owner = self._int(t.get('ownerId'))
            if owner and owner not in ids:
                ids.append(owner)
            for x in (self._text(t.get('participantIds')) or '').split(','):
                n = self._int(x)
                if n and n not in ids:
                    ids.append(n)
        return ids

    def _notify(self, req, title, content, extra_ids=None, sender_id=None):
        if not req:
            return {'msg': 0, 'mail': 0}
        sender_id = self._int(sender_id) or self._int(req.get('requesterId')) or 1
        ids = []
        def add(emp_id):
            n = self._int(emp_id)
            if n and n not in ids:
                ids.append(n)
        add(req.get('requesterId'))
        add(req.get('acceptOwnerId'))
        for x in self._latest_evaluators(req.get('id')):
            add(x)
        for x in (extra_ids or []):
            add(x)
        plan_id = self._text(req.get('planId'))
        if plan_id:
            try:
                plan = dump_row(query_one(
                    'SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.PLAN_TABLE,
                    (plan_id,))) or {}
            except Exception:
                plan = {}
            add(plan.get('createempinfosid'))
            for x in self._plan_people(plan_id):
                add(x)
        if not ids:
            return {'msg': 0, 'mail': 0}
        link = 'requirement.html?id=' + self._text(req.get('id'))
        # 站内消息用相对路径、邮件用绝对地址（邮件客户端没有站点上下文）
        html = ('<p>%s</p><p>%s</p>'
                % (content, notify_anchor(project_plan_service._rel_url(link), '查看需求')))
        mail_html = ('<p>%s</p><p>%s</p>'
                     % (content, notify_anchor(project_plan_service._abs_url(link), '查看需求')))
        sent_msg, sent_mail, emails = 0, 0, []
        for emp_id in ids:
            emp = self._emp_by_empid(emp_id)
            email = self._text(emp.get('email'))
            try:
                ok = project_plan_service._push_message(
                    sender_id, emp_id, title, content, html)
                if ok:
                    sent_msg += 1
            except Exception:
                pass
            if email:
                emails.append(email)
        if emails:
            try:
                ok, _err = project_plan_service._send_mail(
                    sorted(set(emails)), title, content, mail_html)
                if ok:
                    sent_mail = len(set(emails))
            except Exception:
                pass
        return {'msg': sent_msg, 'mail': sent_mail}

    def accept_order(self, params):
        params = params or {}
        me, name = self._me(params)
        order_id = self._uuid(params.get('orderId'), '工单ID')
        try:
            order = dump_row(query_one(
                'SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.ORDER_TABLE,
                (order_id,))) or {}
        except Exception:
            order = {}
        if not order:
            raise BizError('工单不存在或已被删除', 404)
        plan = work_plan_service._plan(order.get('planId'))
        req = {}
        try:
            req = dump_row(query_one(
                'SELECT * FROM `requirements` WHERE `planId`=%s LIMIT 1',
                (order.get('planId'),))) or {}
        except Exception:
            req = {}
        allowed = work_plan_service._creator_id(plan) == me
        if not allowed and self._int(req.get('acceptOwnerId')) == me:
            allowed = True
        if not allowed:
            project_id = self._text(req.get('projectId')) or self._text(plan.get('projectId'))
            if project_id:
                try:
                    project = dump_row(query_one(
                        'SELECT * FROM `projectinfos` WHERE `id`=%%s LIMIT 1'
                        % (), (project_id,))) or {}
                except Exception:
                    project = {}
                if self._int(project.get('createempinfosid')) == me:
                    allowed = True
        if not allowed:
            raise BizError('只有计划创建人、需求验收人或项目负责人可以验收该工单', 403)
        if self._text(order.get('status')) != '已完成':
            raise BizError('工单完成后才能验收')
        result = self._text(params.get('result'))
        if result not in ('已验收', '验收不通过'):
            raise BizError('验收结论只能为「已验收」或「验收不通过」')
        remark = self._text(params.get('remark'))
        if result == '验收不通过' and not remark:
            raise BizError('验收不通过时必须填写原因')
        execute('UPDATE `%s` SET `acceptStatus`=%%s,`acceptorId`=%%s,`acceptorName`=%%s,'
                '`acceptTime`=NOW(),`acceptRemark`=%%s WHERE `id`=%%s' % self.ORDER_TABLE,
                (result, me, name, remark or None, order_id))
        content = '工单 %s 验收结果：%s%s' % (
            order.get('orderCode') or '', result, ('，原因：' + remark) if remark else '')
        if req:
            self._notify(req, '工单验收结果', content,
                         extra_ids=[order.get('ownerId')], sender_id=me)
        else:
            self._notify({'id': '', 'requesterId': 0, 'planId': order.get('planId')},
                         '工单验收结果', content,
                         extra_ids=[order.get('ownerId')], sender_id=me)
        return {'orderId': order_id, 'acceptStatus': result, 'message': '验收结果已保存'}


class BugService(object):
    """项目管理 · 缺陷 / 问题管理（/api/bug/*）

    客户现场实施过程中遇到的问题：登记 → 接收人评估（按时间线追加）→ 确认缺陷后
    自动生成「1 张修复计划 + 3 条任务（研发 / 测试 / 验收）+ 3 张工单」。
      · 工单复用 workplanorders：进「我的任务」，研发 / 测试计入工作量统计；
      · 验收工单 orderKind='bug-accept'：照常生成与通知，但 ViewLoad 统计口径排除
        （WorkloadService._where / _detail_where 的 WHERE 里已过滤）；
      · 登记 / 每次评估 / 确认转工单 / 关闭 都推送站内即时消息 + 邮件给创建人与接收人；
      · 评估记录只追加、不改历史，页面按时间线从旧到新展示。

    工单落地的顺序（关键，别调换）：
      save(plan, tasks=[]) → 自己 INSERT 三条任务 → start() 派单
      先建空计划是为了避免 save() 内部 _notify_changes 把「新增任务」当变更再通知一遍，
      导致责任人一次收到「计划变更」+「任务指派」两条；start() 只发一次派单通知。
    """

    TABLE = 'buginfos'
    EVAL_TABLE = 'bugevaluations'
    FILE_TABLE = 'bugfiles'
    PLAN_TABLE = 'workplans'
    TASK_TABLE = 'workplantasks'
    ORDER_TABLE = 'workplanorders'
    UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads', 'bug')
    EMP_SQL = ('SELECT `id`,`code`,`nameCn`,`email` FROM `empinfos` WHERE `id`=%s LIMIT 1')

    STATUS_WAIT = '待评估'
    STATUS_CONFIRMED = '已确认'
    STATUS_REJECT = '非缺陷'
    STATUS_PLAN = '已转工单'
    STATUS_FIXED = '已修复'
    STATUS_CLOSED = '已关闭'
    LEVELS = ('P0', 'P1', 'P2', 'P3')
    RESULTS = ('是缺陷', '非缺陷', '需补充信息')
    SOURCES = ('客户现场', '内部测试', '用户反馈', '运维巡检')
    EDITABLE = (STATUS_WAIT, STATUS_CONFIRMED, STATUS_REJECT, STATUS_FIXED)

    # ---------------- 小工具 ----------------
    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _int(value, default=0):
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return default

    def _uuid(self, value, label='缺陷ID'):
        text = self._text(value).lower()
        if not text:
            return ''
        if not re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', text):
            raise BizError(label + '格式不正确')
        return text

    def _me(self, params):
        return work_plan_service._me(params or {})

    def _day(self, value, label='日期'):
        """归一成 'YYYY-MM-DD'；空返回 None，非法直接报错（不猜）"""
        text = self._text(value)[:10]
        if not text:
            return None
        try:
            return datetime.datetime.strptime(text, '%Y-%m-%d').date()
        except ValueError:
            raise BizError('%s格式不正确（应为 YYYY-MM-DD）' % label)

    def _datetime(self, value, label='发生时间'):
        text = self._text(value)[:19].replace('T', ' ')
        if not text:
            return None
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
            try:
                return datetime.datetime.strptime(text, fmt)
            except ValueError:
                continue
        raise BizError('%s格式不正确（应为 YYYY-MM-DD HH:MM）' % label)

    def _emp(self, emp_id):
        n = self._int(emp_id)
        if not n:
            return {}
        try:
            return dump_row(query_one(self.EMP_SQL, (n,))) or {}
        except Exception:
            return {}

    def _row(self, bug_id):
        bug_id = self._uuid(bug_id)
        try:
            row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.TABLE, (bug_id,))
        except Exception:
            row = None
        if not row:
            raise BizError('缺陷记录不存在或已被删除', 404)
        return dump_row(row)

    def _next_code(self):
        try:
            rows = query_all('SELECT `bugCode` FROM `%s` WHERE `bugCode` LIKE %%s' % self.TABLE,
                             ('BUG%',)) or []
        except Exception:
            rows = []
        max_no = 0
        for one in rows:
            code = self._text(one.get('bugCode'))
            try:
                max_no = max(max_no, int(code[3:]))
            except (TypeError, ValueError):
                continue
        return 'BUG%06d' % (max_no + 1)

    # ---------------- 列表 / 详情 ----------------
    def page(self, params):
        """分页列表：status 支持逗号多选；keyword 命中编号 / 标题 / 项目 / 描述。"""
        params = params or {}
        self._me(params)
        where, args = ['1=1'], []
        statuses = [x.strip() for x in self._text(params.get('status')).split(',') if x.strip()]
        if statuses:
            where.append('b.`status` IN (%s)' % ','.join(['%s'] * len(statuses)))
            args.extend(statuses)
        project_id = self._text(params.get('projectId'))
        if project_id:
            where.append('b.`projectId`=%s')
            args.append(project_id)
        level = self._text(params.get('level'))
        if level:
            where.append('b.`level`=%s')
            args.append(level)
        receiver_id = self._int(params.get('receiverId'))
        if receiver_id:
            where.append('b.`receiverId`=%s')
            args.append(receiver_id)
        keyword = self._text(params.get('keyword')).lower()
        if keyword:
            where.append('(LOWER(b.`bugCode`) LIKE %s OR LOWER(b.`title`) LIKE %s '
                         'OR LOWER(IFNULL(b.`projectName`,\'\')) LIKE %s '
                         'OR LOWER(IFNULL(b.`description`,\'\')) LIKE %s)')
            args += ['%%%s%%' % keyword] * 4
        try:
            page_num = max(1, int(params.get('pageNum') or 1))
            page_size = min(max(int(params.get('pageSize') or 10), 1), 100)
        except (TypeError, ValueError):
            page_num, page_size = 1, 10
        try:
            total = self._int((query_one(
                'SELECT COUNT(*) AS n FROM `%s` b WHERE %s' % (self.TABLE, ' AND '.join(where)),
                tuple(args)) or {}).get('n'))
            rows = query_all(
                'SELECT b.*, p.`planCode`, p.`planName`, p.`status` AS `planStatus` '
                'FROM `%s` b LEFT JOIN `%s` p ON p.`id`=b.`planId` WHERE %s '
                'ORDER BY b.`createTime` DESC, b.`bugCode` DESC LIMIT %%s OFFSET %%s'
                % (self.TABLE, self.PLAN_TABLE, ' AND '.join(where)),
                tuple(args + [page_size, (page_num - 1) * page_size])) or []
        except Exception as exc:
            raise BizError('缺陷列表查询失败：%s' % exc)
        return {'list': [dump_row(r) for r in rows], 'total': total,
                'pageNum': page_num, 'pageSize': page_size,
                'pages': int(math.ceil(float(total) / page_size)) if page_size else 0}

    def detail(self, params):
        """详情：缺陷主体 + 评估时间线（旧→新）+ 关联工单（研发 / 测试 / 验收）。"""
        params = params or {}
        self._me(params)
        bug = self._row(params.get('id'))
        evals, orders, plan = [], [], {}
        try:
            evals = [dump_row(r) for r in (query_all(
                'SELECT * FROM `%s` WHERE `bugId`=%%s ORDER BY `seq`,`createTime`,`id`'
                % self.EVAL_TABLE, (bug['id'],)) or [])]
        except Exception:
            evals = []
        files = []
        try:
            files = [dump_row(r) for r in (query_all(
                'SELECT `id`,`name`,`size`,`ext`,`uploaderName`,`uploadTime` FROM `%s` '
                'WHERE `bugId`=%%s ORDER BY `uploadTime`,`id`' % self.FILE_TABLE,
                (bug['id'],)) or [])]
        except Exception:
            files = []
        plan_id = self._text(bug.get('planId'))
        if plan_id:
            try:
                plan = dump_row(query_one(
                    'SELECT `id`,`planCode`,`planName`,`status`,`startDate`,`endDate` '
                    'FROM `%s` WHERE `id`=%%s LIMIT 1' % self.PLAN_TABLE, (plan_id,))) or {}
            except Exception:
                plan = {}
            try:
                orders = [dump_row(r) for r in (query_all(
                    'SELECT `id`,`orderCode`,`orderTitle`,`orderKind`,`ownerId`,`ownerName`,'
                    '`startDate`,`endDate`,`status`,`dispatchTime`,`noticeMsg`,`noticeMail` '
                    'FROM `%s` WHERE `planId`=%%s ORDER BY `dispatchTime`,`orderCode`'
                    % self.ORDER_TABLE, (plan_id,)) or [])]
            except Exception:
                orders = []
        return {'bug': bug, 'evaluations': evals, 'orders': orders, 'plan': plan,
                'files': files}

    # ---------------- 附件（base64 → 落盘 → bugfiles） ----------------
    def upload(self, params):
        """登记 / 编辑缺陷时上传附件：最多 10 个、单个 10 MB、合计 30 MB。"""
        params = params or {}
        me, name = self._me(params)
        bug = self._row(params.get('bugId') or params.get('id'))
        raw = params.get('files')
        if not isinstance(raw, list) or not raw:
            raise BizError('请选择要上传的附件')
        folder = os.path.join(self.UPLOAD_ROOT, bug['id'])
        if not os.path.isdir(folder):
            os.makedirs(folder)
        saved, total = [], 0
        for item in raw[:10]:
            item = item or {}
            fname = os.path.basename(self._text(item.get('name')).replace('\\', '/'))[:255]
            if not fname:
                continue
            text = self._text(item.get('data'))
            if ';base64,' in text[:300]:
                text = text.split(';base64,', 1)[1]
            try:
                blob = base64.b64decode(text.encode('ascii'), validate=True) if text else b''
            except Exception:
                raise BizError('附件「%s」数据不合法' % fname)
            if not blob:
                continue
            if len(blob) > 10 * 1024 * 1024:
                raise BizError('附件「%s」超过 10 MB' % fname)
            total += len(blob)
            if total > 30 * 1024 * 1024:
                raise BizError('附件合计超过 30 MB')
            ext = os.path.splitext(fname)[1].lstrip('.').lower()[:20]
            stored = str(uuid.uuid4()) + ('.' + ext if ext else '')
            with open(os.path.join(folder, stored), 'wb') as fp:
                fp.write(blob)
            fid = str(uuid.uuid4())
            execute('INSERT INTO `%s` (`id`,`bugId`,`name`,`path`,`size`,`ext`,'
                    '`uploaderId`,`uploaderName`) VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)'
                    % self.FILE_TABLE,
                    (fid, bug['id'], fname, os.path.join(bug['id'], stored), len(blob),
                     ext or None, me, name))
            saved.append({'id': fid, 'name': fname, 'size': len(blob), 'ext': ext})
        if not saved:
            raise BizError('没有可上传的附件')
        return {'files': saved, 'message': '已上传 %d 个附件' % len(saved)}

    def file_data(self, params):
        """附件读取：返回 base64 dataUrl（前端预览 / 下载都走这里）。"""
        params = params or {}
        me, _name = self._me(params)
        fid = self._uuid(params.get('id'), '附件ID')
        try:
            row = query_one('SELECT * FROM `%s` WHERE `id`=%%s LIMIT 1' % self.FILE_TABLE, (fid,))
        except Exception:
            row = None
        if not row:
            raise BizError('附件不存在或已被删除', 404)
        f = dump_row(row)
        self._row(f.get('bugId'))                  # 缺陷存在即可见
        path = os.path.join(self.UPLOAD_ROOT, self._text(f.get('path')))
        if not os.path.isfile(path):
            raise BizError('附件文件已丢失', 404)
        with open(path, 'rb') as fp:
            blob = fp.read()
        ext = self._text(f.get('ext')).lower()
        mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                'gif': 'image/gif', 'pdf': 'application/pdf',
                'doc': 'application/msword',
                'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'xls': 'application/vnd.ms-excel',
                'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}.get(
                    ext, 'application/octet-stream')
        return {'id': fid, 'name': self._text(f.get('name')), 'ext': ext,
                'size': len(blob), 'mime': mime,
                'dataUrl': 'data:%s;base64,%s' % (mime, base64.b64encode(blob).decode('ascii'))}

    # ---------------- 登记 / 编辑 ----------------
    def add(self, data):
        data = data or {}
        me, name = self._me(data)
        title = self._text(data.get('title'))
        if not title:
            raise BizError('请填写问题标题（一句话说清现象）')
        if len(title) > 200:
            raise BizError('问题标题不能超过 200 个字符')
        description = self._text(data.get('description'))
        description_html = self._text(data.get('descriptionHtml'))
        if not description and not description_html:
            raise BizError('请填写问题描述（复现步骤 / 现象 / 期望结果）')
        receiver_id = self._int(data.get('receiverId'))
        if not receiver_id:
            raise BizError('请选择接收人员（从组织架构中选择）')
        receiver = self._emp(receiver_id)
        if not receiver:
            raise BizError('接收人员不存在或已离职')
        project_id = self._uuid(data.get('projectId'), '项目ID') if data.get('projectId') else ''
        project_name = self._text(data.get('projectName'))
        if project_id and not project_name:
            try:
                project_row = dump_row(query_one(
                    'SELECT `projectName` FROM `projectinfos` WHERE `id`=%s LIMIT 1',
                    (project_id,))) or {}
            except Exception:
                project_row = {}
            project_name = self._text(project_row.get('projectName'))
        if not project_id:
            raise BizError('请选择问题所在项目')
        happen = self._datetime(data.get('happenTime'), '发生时间')
        if not happen:
            raise BizError('请填写发生时间')
        source = self._text(data.get('sourceType')) or '客户现场'
        if source not in self.SOURCES:
            source = '客户现场'
        level = self._text(data.get('level'))
        if level and level not in self.LEVELS:
            raise BizError('严重级别只能是 P0 / P1 / P2 / P3')
        bug_id = str(uuid.uuid4())
        code = self._next_code()
        try:
            execute(
                'INSERT INTO `%s` (`id`,`bugCode`,`title`,`description`,`descriptionHtml`,'
                '`projectId`,`projectName`,`happenTime`,`level`,`sourceType`,`status`,'
                '`reporterId`,`reporterName`,`receiverId`,`receiverName`,`acceptOwnerId`,'
                '`acceptOwnerName`) '
                'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)'
                % self.TABLE,
                (bug_id, code, title, description or None, description_html or None,
                 project_id, project_name or None, happen, level or None, source, self.STATUS_WAIT,
                 me, name or None, receiver_id,
                 self._text(receiver.get('nameCn')) or None,
                 me, name or None))
        except DuplicateError:
            raise BizError('缺陷编号冲突，请重试')
        bug = self._row(bug_id)
        note = self._notify(bug, '缺陷登记通知',
                            '【缺陷】%s 登记了问题「%s」（项目：%s，发生时间：%s），'
                            '已指派给 %s 评估。' % (
                                name or bug.get('reporterName') or '同事', title,
                                project_name or '未关联项目',
                                happen.strftime('%Y-%m-%d %H:%M'),
                                self._text(receiver.get('nameCn')) or '接收人'),
                            sender_id=me)
        return {'id': bug_id, 'bugCode': code, 'message': '缺陷已登记',
                'notified': note.get('msg', 0), 'mailed': note.get('mail', 0)}

    def update(self, data):
        data = data or {}
        me, name = self._me(data)
        bug = self._row(data.get('id'))
        if self._text(bug.get('status')) not in self.EDITABLE:
            raise BizError('该缺陷已生成修复工单或已关闭，不能再修改')
        title = self._text(data.get('title')) or bug.get('title')
        if not title:
            raise BizError('请填写问题标题')
        project_id = self._uuid(data.get('projectId'), '项目ID') if data.get('projectId') else self._text(bug.get('projectId'))
        project_name = self._text(data.get('projectName')) or self._text(bug.get('projectName'))
        if project_id and self._text(data.get('projectId')) and not self._text(data.get('projectName')):
            try:
                project_row = dump_row(query_one(
                    'SELECT `projectName` FROM `projectinfos` WHERE `id`=%s LIMIT 1',
                    (project_id,))) or {}
            except Exception:
                project_row = {}
            project_name = self._text(project_row.get('projectName')) or project_name
        if not project_id:
            raise BizError('请选择问题所在项目')
        receiver_id = self._int(data.get('receiverId')) or self._int(bug.get('receiverId'))
        if not receiver_id:
            raise BizError('请选择接收人员')
        receiver = self._emp(receiver_id)
        if not receiver:
            raise BizError('接收人员不存在或已离职')
        happen = self._datetime(data.get('happenTime'), '发生时间') if data.get('happenTime') else None
        level = self._text(data.get('level'))
        if level and level not in self.LEVELS:
            raise BizError('严重级别只能是 P0 / P1 / P2 / P3')
        description = self._text(data.get('description'))
        description_html = self._text(data.get('descriptionHtml'))
        execute(
            'UPDATE `%s` SET `title`=%%s,`description`=%%s,`descriptionHtml`=%%s,'
            '`projectId`=%%s,`projectName`=%%s,`happenTime`=COALESCE(%%s,`happenTime`),'
            '`level`=%%s,`sourceType`=%%s,`receiverId`=%%s,`receiverName`=%%s WHERE `id`=%%s'
            % self.TABLE,
            (title, description or bug.get('description'),
             description_html or bug.get('descriptionHtml'),
             project_id, project_name or None, happen, level or None,
             self._text(data.get('sourceType')) or bug.get('sourceType') or '客户现场',
             receiver_id, self._text(receiver.get('nameCn')) or None, bug['id']))
        bug = self._row(bug['id'])
        self._notify(bug, '缺陷信息变更', '【缺陷】%s 更新了问题「%s」的信息。'
                     % (name or '同事', bug.get('title')), sender_id=me)
        return {'id': bug['id'], 'message': '缺陷已更新'}

    # ---------------- 评估（时间线追加） ----------------
    def evaluate(self, params):
        params = params or {}
        me, name = self._me(params)
        bug = self._row(params.get('id'))
        if self._text(bug.get('status')) not in (self.STATUS_WAIT, self.STATUS_CONFIRMED,
                                                 self.STATUS_REJECT, self.STATUS_FIXED):
            raise BizError('该缺陷已转修复工单或已关闭，不能再评估')
        result = self._text(params.get('result'))
        if result not in self.RESULTS:
            raise BizError('评估结论只能是「是缺陷」「非缺陷」「需补充信息」')
        reason = self._text(params.get('reason'))
        reason_html = self._text(params.get('reasonHtml'))
        if result in ('非缺陷', '需补充信息') and not reason and not reason_html:
            raise BizError('结论为「%s」时必须填写原因 / 需要补充的信息' % result)
        level = self._text(params.get('level')) or self._text(bug.get('level'))
        if result == '是缺陷':
            if not level:
                raise BizError('确认为缺陷时必须选择严重级别（P0~P3）')
            if level not in self.LEVELS:
                raise BizError('严重级别只能是 P0 / P1 / P2 / P3')
        raw_ids = params.get('evaluatorIds')
        if isinstance(raw_ids, (list, tuple)):
            eval_ids = [self._int(x) for x in raw_ids if self._int(x)]
        else:
            eval_ids = [self._int(x) for x in self._text(raw_ids).split(',') if self._int(x)]
        eval_ids = [x for x in eval_ids if x]
        if not eval_ids:
            eval_ids = [self._int(bug.get('receiverId')) or me]
        if me and me not in eval_ids:
            eval_ids.insert(0, me)
        eval_names = []
        for eid in eval_ids:
            emp = self._emp(eid)
            eval_names.append(self._text(emp.get('nameCn')) or ('员工%d' % eid))
        if result == '是缺陷':
            next_status = self.STATUS_CONFIRMED
        elif result == '非缺陷':
            next_status = self.STATUS_REJECT
        else:
            next_status = self.STATUS_WAIT
        eval_id = str(uuid.uuid4())
        try:
            seq = self._int((query_one(
                'SELECT COUNT(*) AS n FROM `%s` WHERE `bugId`=%%s' % self.EVAL_TABLE,
                (bug['id'],)) or {}).get('n')) + 1
        except Exception:
            seq = 1
        try:
            execute(
                'INSERT INTO `%s` (`id`,`bugId`,`seq`,`result`,`level`,`reason`,`reasonHtml`,'
                '`evaluatorId`,`evaluatorName`,`evaluatorIds`,`evaluatorNames`) '
                'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)' % self.EVAL_TABLE,
                (eval_id, bug['id'], seq, result, level or None, reason or None,
                 reason_html or None, me, name or None,
                 ','.join([str(x) for x in eval_ids]), ','.join(eval_names)))
            execute('UPDATE `%s` SET `status`=%%s,`level`=%%s,`evalCount`=`evalCount`+1,'
                    '`closeReason`=%%s WHERE `id`=%%s' % self.TABLE,
                    (next_status, level or None,
                     (reason or None) if result == '非缺陷' else bug.get('closeReason'),
                     bug['id']))
        except Exception as exc:
            raise BizError('评估保存失败：%s' % exc)
        bug = self._row(bug['id'])
        try:
            count = self._int((query_one(
                'SELECT COUNT(*) AS n FROM `%s` WHERE `bugId`=%%s' % self.EVAL_TABLE,
                (bug['id'],)) or {}).get('n'))
        except Exception:
            count = 1
        if result == '是缺陷':
            content = ('【缺陷】问题「%s」第 %s 次评估：确认是缺陷（%s），'
                       '等待指定研发 / 测试 / 验收责任人并生成修复工单。'
                       % (bug.get('title'), count or 1, level))
        elif result == '非缺陷':
            content = ('【缺陷】问题「%s」评估为「非缺陷」，已关闭。原因：%s'
                       % (bug.get('title'), reason))
        else:
            content = ('【缺陷】问题「%s」需要补充信息后继续评估。说明：%s'
                       % (bug.get('title'), reason))
        self._notify(bug, '缺陷评估结果：' + result, content,
                     extra_ids=eval_ids, sender_id=me)
        return {'id': eval_id, 'status': bug['status'], 'evals': count,
                'message': '评估结果已保存'}

    # ---------------- 确认缺陷 → 自动生成修复工单 ----------------
    def confirm(self, params):
        """指定三组责任人 + 起止时间 → 建 1 计划 + 3 任务 + 3 工单（并派单通知）。

        顺序：save(空任务) → INSERT 三条任务 → start()。见类注释。
        """
        params = params or {}
        me, name = self._me(params)
        bug = self._row(params.get('id'))
        if self._text(bug.get('status')) != self.STATUS_CONFIRMED:
            raise BizError('只有评估结论为「是缺陷」（已确认）的缺陷才能生成修复工单')
        if bug.get('planId'):
            raise BizError('该缺陷已生成修复工单，不能重复生成')

        def people(prefix, label, default_id=0):
            emp_id = self._int(params.get(prefix + 'OwnerId')) or default_id
            if not emp_id:
                raise BizError('请选择%s' % label)
            emp = self._emp(emp_id)
            if not emp:
                raise BizError('%s不存在或已离职' % label)
            start = self._day(params.get(prefix + 'StartDate'), label + '开始日期')
            end = self._day(params.get(prefix + 'EndDate'), label + '结束日期')
            if not start or not end:
                raise BizError('请填写%s的起止时间' % label)
            if start > end:
                raise BizError('%s的开始日期不能晚于结束日期' % label)
            return {'id': emp_id, 'name': self._text(emp.get('nameCn')) or label,
                    'start': start, 'end': end}

        dev = people('dev', '研发责任人')
        test = people('test', '测试责任人')
        accept = people('accept', '验收责任人', default_id=self._int(bug.get('reporterId')))
        level = self._text(bug.get('level'))
        title = self._text(bug.get('title'))
        code = self._text(bug.get('bugCode'))
        starts = [dev['start'], test['start'], accept['start']]
        ends = [dev['end'], test['end'], accept['end']]
        plan_name = ('缺陷修复 · %s %s' % (code, title))[:150]
        plan_desc = '\n'.join([
            '来源缺陷：%s %s' % (code, title),
            '所在项目：%s' % (self._text(bug.get('projectName')) or '未关联项目'),
            '严重级别：%s' % (level or '未定级'),
            '问题描述：%s' % (self._text(bug.get('description'))[:800] or '见缺陷详情'),
        ])
        try:
            saved = work_plan_service.save({
                '_loginUserId': params.get('_loginUserId'),
                'plan': {
                    'planName': plan_name,
                    'planDesc': plan_desc,
                    'projectId': '',
                    'projectName': '',
                    'startDate': min(starts).strftime('%Y-%m-%d'),
                    'endDate': max(ends).strftime('%Y-%m-%d'),
                    'scale': 'day', 'skipWeekend': 0, 'ispub': 1,
                },
                'tasks': [],
            })
        except Exception as exc:
            raise BizError('修复计划创建失败：%s' % exc)
        plan_id = self._text(saved.get('id'))
        if not plan_id:
            raise BizError('修复计划创建失败（未返回计划ID）')

        task_rows = [
            ('bug-dev', '研发修复', dev),
            ('bug-test', '测试验证', test),
            ('bug-accept', '验收确认', accept),
        ]
        inserted = []
        try:
            for idx, (kind, label, who) in enumerate(task_rows):
                tid = str(uuid.uuid4())
                inserted.append(tid)
                execute(
                    'INSERT INTO `%s` (`id`,`planId`,`taskName`,`taskType`,`orderKind`,'
                    '`startDate`,`endDate`,`progress`,`execStatus`,`ownerName`,`ownerId`,'
                    '`sortNo`) '
                    'VALUES (%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s,%%s)' % self.TASK_TABLE,
                    (tid, plan_id, ('%s：%s' % (label, title))[:200], 'task', kind,
                     who['start'].strftime('%Y-%m-%d'), who['end'].strftime('%Y-%m-%d'),
                     0, '未开始', who['name'], who['id'], idx))
        except Exception as exc:
            execute('DELETE FROM `%s` WHERE `planId`=%%s' % self.TASK_TABLE, (plan_id,))
            execute('DELETE FROM `%s` WHERE `id`=%%s' % self.PLAN_TABLE, (plan_id,))
            raise BizError('修复任务创建失败：%s' % exc)

        dispatch = {'created': 0, 'notified': 0, 'mailed': 0, 'message': ''}
        try:
            dispatch = work_plan_service.start({
                '_loginUserId': params.get('_loginUserId'), 'id': plan_id}) or dispatch
        except Exception as exc:
            dispatch['message'] = '工单已生成，但启动派单失败（可到计划管理手动启动）：%s' % exc

        execute(
            'UPDATE `%s` SET `planId`=%%s,`status`=%%s,`level`=%%s,'
            '`devOwnerId`=%%s,`devOwnerName`=%%s,`devStartDate`=%%s,`devEndDate`=%%s,'
            '`testOwnerId`=%%s,`testOwnerName`=%%s,`testStartDate`=%%s,`testEndDate`=%%s,'
            '`acceptOwnerId`=%%s,`acceptOwnerName`=%%s,`acceptStartDate`=%%s,`acceptEndDate`=%%s '
            'WHERE `id`=%%s' % self.TABLE,
            (plan_id, self.STATUS_PLAN, level or None,
             dev['id'], dev['name'], dev['start'], dev['end'],
             test['id'], test['name'], test['start'], test['end'],
             accept['id'], accept['name'], accept['start'], accept['end'], bug['id']))
        bug = self._row(bug['id'])
        self._notify(
            bug, '缺陷已生成修复工单',
            '【缺陷】%s 确认的缺陷「%s」已生成修复计划 %s：研发 %s（%s~%s）、测试 %s（%s~%s）、'
            '验收 %s（%s~%s）。工单已派发，可在「我的任务」查看。' % (
                name or '同事', title, saved.get('planCode') or plan_id,
                dev['name'], dev['start'], dev['end'],
                test['name'], test['start'], test['end'],
                accept['name'], accept['start'], accept['end']),
            sender_id=me)
        return {'id': bug['id'], 'planId': plan_id, 'planCode': saved.get('planCode'),
                'orders': dispatch.get('created', 0),
                'message': '已生成修复计划 %s，派发工单 %d 张%s' % (
                    saved.get('planCode') or plan_id, dispatch.get('created', 0),
                    ('；' + dispatch['message']) if dispatch.get('message') else '')}

    # ---------------- 关闭 ----------------
    def close(self, params):
        params = params or {}
        me, name = self._me(params)
        bug = self._row(params.get('id'))
        if self._text(bug.get('status')) == self.STATUS_CLOSED:
            raise BizError('该缺陷已关闭，无需重复操作')
        reason = self._text(params.get('closeReason'))
        if not reason:
            raise BizError('请填写关闭原因')
        execute('UPDATE `%s` SET `status`=%%s,`closeReason`=%%s WHERE `id`=%%s' % self.TABLE,
                (self.STATUS_CLOSED, reason[:500], bug['id']))
        bug = self._row(bug['id'])
        self._notify(bug, '缺陷已关闭', '【缺陷】%s 关闭了问题「%s」。原因：%s'
                     % (name or '同事', bug.get('title'), reason), sender_id=me)
        return {'id': bug['id'], 'status': self.STATUS_CLOSED, 'message': '缺陷已关闭'}

    # ---------------- 通知（站内消息 + 邮件） ----------------
    def _notify(self, bug, title, content, extra_ids=None, sender_id=None):
        """收件人 = 创建人 ∪ 接收人 ∪ 额外（评估参与人 / 责任人），去重。

        IM 用相对路径、邮件用绝对地址（邮件客户端没有站点上下文）；
        _push_message 必须走单例，sender_id 不能为 0（persist_send 会拒）。
        """
        if not bug:
            return {'msg': 0, 'mail': 0}
        sender_id = self._int(sender_id) or self._int(bug.get('reporterId')) or 1
        ids = []

        def add(emp_id):
            n = self._int(emp_id)
            if n and n not in ids:
                ids.append(n)

        add(bug.get('reporterId'))
        add(bug.get('receiverId'))
        for x in (extra_ids or []):
            add(x)
        if not ids:
            return {'msg': 0, 'mail': 0}
        link = 'bug.html?id=' + self._text(bug.get('id'))
        html = ('<p>%s</p><p>%s</p>'
                % (html_lib.escape(content),
                   notify_anchor(project_plan_service._rel_url(link), '查看缺陷')))
        mail_html = ('<p>%s</p><p>%s</p>'
                     % (html_lib.escape(content),
                        notify_anchor(project_plan_service._abs_url(link), '查看缺陷')))
        sent_msg, sent_mail, emails = 0, 0, []
        for emp_id in ids:
            emp = self._emp(emp_id)
            email = self._text(emp.get('email'))
            try:
                ok = project_plan_service._push_message(sender_id, emp_id, title, content, html)
                if ok:
                    sent_msg += 1
            except Exception:
                pass
            if email:
                emails.append(email)
        if emails:
            try:
                ok, _err = project_plan_service._send_mail(
                    sorted(set(emails)), '【九豆综合管理平台】' + title, content, mail_html)
                if ok:
                    sent_mail = len(set(emails))
            except Exception:
                pass
        return {'msg': sent_msg, 'mail': sent_mail}


class WorkloadService(object):
    """项目中心 · 员工工作量统计（/api/workload/*）

    统计口径（页面上的口径说明与这里一一对应：改口径先改这里，再同步页面文案）：
      · 时间区间按 **派单时间 `dispatchTime`**（工单落到责任人手里的那一刻），闭区间 [startDate, endDate]；
      · 接单数 = 区间内派给该员工的工单数；已完成 / 处理中 / 待处理按工单 `status`；
      · **缺陷验收工单（orderKind='bug-accept'）不计入**：验收人默认是缺陷创建人，
        计入会把提交人 / 项目经理算成接单人；研发、测试工单正常计入；
      · 逾期 = 未完成 且 计划完成日 `endDate` 早于今天；
      · 完成率 = 已完成 ÷ 接单数（没接单记 0）；按期率 = 按期完成 ÷ 已完成；
      · 平均耗时 = 已完成工单「派单日 → 实际完成日」的平均天数（同日完成算 0 天，不出现负数）；
      · 默认接单数降序，可切已完成 / 完成率 / 逾期 / 耗时 / 最近派单，`ownerId=0`（未指定责任人）永远排最后。

    为什么统计**全部**工单而不是只看「我能看到的计划」：这是给管理者看的产能报表，
    可见人群由「菜单授权 + 角色」控制（没授权的角色进不到这页），所以不再叠加计划可见性过滤；
    普通员工想看自己的数据用 `scope=mine`（页面上的「仅看我的」开关）。
    """

    ORDER_TABLE = 'workplanorders'
    PROJECT_TABLE = 'projectinfos'
    LOGIN_SQL = ProjectBaseService.LOGIN_SQL
    EMP_SQL = ('SELECT e.`id`,e.`code`,e.`nameCn`,e.`status`,d.`nameCn` AS `deptName` '
               'FROM `empinfos` e LEFT JOIN `OrganizationStructure` d ON d.`id`=e.`deptId`')
    ORDER_STATUSES = ('待处理', '处理中', '已完成')
    SORT_KEYS = ('orderCount', 'doneCount', 'doingCount', 'todoCount', 'overdueCount',
                 'doneRate', 'onTimeRate', 'avgDays', 'lastDispatch')
    MAX_SPAN_DAYS = 366      # 区间上限：再宽就是全表扫，报表也没意义
    MAX_PAGE_SIZE = 100

    # ---------------- 小工具 ----------------
    @staticmethod
    def _text(value):
        return '' if value is None else str(value).strip()

    @staticmethod
    def _int(value, default=0):
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _date_text(value, label='日期'):
        """把各种入参归一成 'YYYY-MM-DD'，非法就报错（不猜）"""
        text = WorkloadService._text(value)[:10]
        if not text:
            return None
        try:
            return datetime.datetime.strptime(text, '%Y-%m-%d').date()
        except ValueError:
            raise BizError('%s格式不正确（应为 YYYY-MM-DD）' % label)

    @staticmethod
    def _dt_text(value, with_time=True):
        """DB 里可能是 datetime / date / 字符串，统一转成前端能直接显示的文本"""
        if value is None or value == '':
            return ''
        if isinstance(value, datetime.datetime):
            return value.strftime('%Y-%m-%d %H:%M:%S' if with_time else '%Y-%m-%d')
        if isinstance(value, datetime.date):
            return value.strftime('%Y-%m-%d')
        text = str(value).strip()
        return text[:19] if with_time else text[:10]

    def _me(self, params):
        user_id = self._text((params or {}).get('_loginUserId'))
        if not user_id:
            raise BizError('登录已失效，请重新登录', 401)
        try:
            row = query_one(self.LOGIN_SQL, (user_id,))
        except Exception:
            row = None
        emp_id = self._int((row or {}).get('empId'))
        if not emp_id:
            raise BizError('当前登录账号未绑定员工，无法查看工作量统计')
        return emp_id, self._text((row or {}).get('empName'))

    def _range(self, params):
        """解析时间区间：都不传默认「本月 1 号 → 今天」；只传一头就补另一头。"""
        params = params or {}
        raw_start = self._text(params.get('startDate'))
        raw_end = self._text(params.get('endDate'))
        today = datetime.date.today()
        start = self._date_text(raw_start, '开始日期')
        end = self._date_text(raw_end, '结束日期')
        if not start and not end:
            start = today.replace(day=1)
            end = today
        elif not start:
            start = end.replace(day=1)
        elif not end:
            end = today
        if start > end:
            raise BizError('开始日期不能晚于结束日期')
        if (end - start).days + 1 > self.MAX_SPAN_DAYS:
            raise BizError('统计区间不能超过 %d 天，请先缩小范围' % self.MAX_SPAN_DAYS)
        return start, end

    def _where(self, params, start, end):
        """公共过滤：区间（按派单时间，含结束日整天）+ 仅我 + 项目

        缺陷管理的验收工单（orderKind='bug-accept'）不算产能：验收人默认是缺陷创建人，
        计入会把项目经理 / 提交人算成接单人，所以统计与明细统一排除。
        """
        where = ['o.`dispatchTime` IS NOT NULL',
                 "IFNULL(o.`orderKind`,'') <> 'bug-accept'",
                 'o.`dispatchTime` >= %s',
                 'o.`dispatchTime` < DATE_ADD(%s, INTERVAL 1 DAY)']
        args = [start.isoformat(), end.isoformat()]
        if self._text(params.get('scope')) == 'mine':
            args_me = self._int(params.get('_empId'))
            if args_me:
                where.append('o.`ownerId` = %s')
                args.append(args_me)
        project_id = self._text(params.get('projectId'))
        if project_id:
            where.append('o.`projectId` = %s')
            args.append(project_id)
        return ' AND '.join(where), args

    def _emp_map(self):
        try:
            rows = query_all(self.EMP_SQL)
        except Exception:
            rows = []
        out = {}
        for r in rows:
            out[self._int(r.get('id'))] = {
                'code': self._text(r.get('code')),
                'nameCn': self._text(r.get('nameCn')),
                'status': self._int(r.get('status')),
                'deptName': self._text(r.get('deptName')),
            }
        return out

    def _projects(self):
        try:
            rows = query_all('SELECT `id`,`projectCode`,`projectName` FROM `%s` '
                             'WHERE `enabled`=1 ORDER BY `projectName`' % self.PROJECT_TABLE)
        except Exception:
            rows = []
        return [{'id': self._text(r.get('id')),
                 'code': self._text(r.get('projectCode')),
                 'name': self._text(r.get('projectName'))} for r in rows]

    def _rate(self, part, whole):
        """百分比（保留 1 位，不四舍五入到 100.0 之外）"""
        if not whole:
            return 0.0
        return round(float(part) * 100.0 / float(whole), 1)

    # ---------------- 员工维度聚合 ----------------
    AGG_SQL = (
        'SELECT o.`ownerId` AS `ownerId`, MAX(o.`ownerName`) AS `ownerName`, '
        'COUNT(*) AS `orderCount`, '
        "SUM(CASE WHEN o.`status`='已完成' THEN 1 ELSE 0 END) AS `doneCount`, "
        "SUM(CASE WHEN o.`status`='处理中' THEN 1 ELSE 0 END) AS `doingCount`, "
        "SUM(CASE WHEN o.`status`='待处理' THEN 1 ELSE 0 END) AS `todoCount`, "
        "SUM(CASE WHEN o.`status`<>'已完成' AND o.`endDate` IS NOT NULL "
        '         AND o.`endDate` < CURDATE() THEN 1 ELSE 0 END) AS `overdueCount`, '
        "SUM(CASE WHEN o.`status`='已完成' AND o.`endDate` IS NOT NULL "
        '         AND o.`actualEndTime` IS NOT NULL '
        '         AND DATE(o.`actualEndTime`) <= o.`endDate` THEN 1 ELSE 0 END) AS `onTimeCount`, '
        "SUM(CASE WHEN o.`status`='已完成' AND o.`actualEndTime` IS NOT NULL "
        '         THEN GREATEST(DATEDIFF(DATE(o.`actualEndTime`), DATE(o.`dispatchTime`)), 0) '
        '         ELSE 0 END) AS `costDays`, '
        "SUM(CASE WHEN o.`status`='已完成' AND o.`actualEndTime` IS NOT NULL THEN 1 ELSE 0 END) AS `costCount`, "
        'MAX(o.`dispatchTime`) AS `lastDispatch`, '
        'COUNT(DISTINCT o.`planId`) AS `planCount` '
        'FROM `%s` o WHERE %s GROUP BY o.`ownerId`'
    )

    def _person_rows(self, params, start, end):
        """聚合出「每个责任人一行」的原始行（未排序），stats / export 共用"""
        where, args = self._where(params, start, end)
        sql = self.AGG_SQL % (self.ORDER_TABLE, where)
        try:
            raw = query_all(sql, tuple(args))
        except Exception as exc:
            raise BizError('统计查询失败：%s' % exc)
        emps = self._emp_map()
        items = []
        for r in raw:
            owner_id = self._int(r.get('ownerId'))
            emp = emps.get(owner_id) or {}
            order_count = self._int(r.get('orderCount'))
            done = self._int(r.get('doneCount'))
            cost_count = self._int(r.get('costCount'))
            emp_name = emp.get('nameCn') or self._text(r.get('ownerName')) or '未指定'
            items.append({
                'ownerId': owner_id,
                'ownerName': emp_name,
                'empCode': emp.get('code') or '',
                'deptName': emp.get('deptName') or '',
                'empStatus': emp.get('status'),
                'orderCount': order_count,
                'doneCount': done,
                'doingCount': self._int(r.get('doingCount')),
                'todoCount': self._int(r.get('todoCount')),
                'overdueCount': self._int(r.get('overdueCount')),
                'doneRate': self._rate(done, order_count),
                'onTimeRate': self._rate(self._int(r.get('onTimeCount')), done),
                'avgDays': round(float(self._int(r.get('costDays'))) / cost_count, 1) if cost_count else 0.0,
                'lastDispatch': self._dt_text(r.get('lastDispatch')),
                'planCount': self._int(r.get('planCount')),
                'unknown': owner_id <= 0,
            })
        return items

    @staticmethod
    def _sort_items(items, sort_by, desc):
        """先按姓名排（稳定排序的次键），再按选中列排 —— 同值时顺序才是可预期的"""
        items.sort(key=lambda x: (x.get('ownerName') or ''))
        if sort_by not in WorkloadService.SORT_KEYS:
            sort_by = 'orderCount'

        def key_of(it):
            value = it.get(sort_by)
            if sort_by == 'lastDispatch':
                return value or ''
            return value if isinstance(value, (int, float)) else 0

        items.sort(key=key_of, reverse=desc)
        # 「未指定责任人」不参与排名：始终垫底（否则 ownerId=0 的一堆工单会顶到最前面）
        known = [x for x in items if not x['unknown']]
        unknown = [x for x in items if x['unknown']]
        return known + unknown

    def stats(self, params):
        """员工维度排行 + 汇总卡片。一次返回全量行（员工量级小），排序与分页交给页面。"""
        params = params or {}
        me, me_name = self._me(params)
        params['_empId'] = me
        start, end = self._range(params)
        items = self._person_rows(params, start, end)
        sort_by = self._text(params.get('sortBy')) or 'orderCount'
        desc = self._text(params.get('sortOrder')).lower() != 'asc'
        items = self._sort_items(items, sort_by, desc)

        keyword = self._text(params.get('keyword')).lower()
        if keyword:
            items = [x for x in items
                     if keyword in (x['ownerName'] or '').lower()
                     or keyword in (x['empCode'] or '').lower()
                     or keyword in (x['deptName'] or '').lower()]

        summary = {'orderCount': 0, 'doneCount': 0, 'doingCount': 0, 'todoCount': 0,
                   'overdueCount': 0, 'people': len(items), 'planCount': 0}
        for it in items:
            summary['orderCount'] += it['orderCount']
            summary['doneCount'] += it['doneCount']
            summary['doingCount'] += it['doingCount']
            summary['todoCount'] += it['todoCount']
            summary['overdueCount'] += it['overdueCount']
        summary['doneRate'] = self._rate(summary['doneCount'], summary['orderCount'])
        # 覆盖计划数按区间整体去重，不能把各人的 planCount 相加（同一计划会被重复计）
        where, args = self._where(params, start, end)
        try:
            row = query_one('SELECT COUNT(DISTINCT o.`planId`) AS n FROM `%s` o WHERE %s'
                            % (self.ORDER_TABLE, where), tuple(args)) or {}
        except Exception:
            row = {}
        summary['planCount'] = self._int(row.get('n'))

        return {
            'range': {'startDate': start.isoformat(), 'endDate': end.isoformat(),
                      'days': (end - start).days + 1},
            'summary': summary,
            'list': items,
            'projects': self._projects(),
            'me': {'empId': me, 'name': me_name},
            'sortBy': sort_by, 'sortOrder': 'asc' if not desc else 'desc',
            'scope': 'mine' if self._text(params.get('scope')) == 'mine' else 'all',
            'generatedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        }

    # ---------------- 钻取：某员工的工单明细 ----------------
    DETAIL_SQL = (
        'SELECT o.`id` AS `orderId`, o.`orderCode`, o.`orderTitle`, o.`taskId`, o.`taskType`, '
        'o.`planId`, o.`planCode`, o.`planName`, o.`projectId`, '
        'o.`startDate`, o.`endDate`, o.`dispatchTime`, o.`actualEndTime`, '
        'o.`status`, o.`acceptStatus`, o.`ownerId`, o.`ownerName`, o.`participantNames`, '
        'p.`projectName` AS `projectName` '
        'FROM `%s` o LEFT JOIN `%s` p ON p.`id`=o.`projectId` WHERE %s'
    )

    def _detail_where(self, params, start, end, owner_id=None):
        where, args = self._where(params, start, end)
        if owner_id is not None:
            where += ' AND o.`ownerId` = %s'
            args.append(owner_id)
        statuses = [s for s in (self._text(params.get('status')).split(',')
                                if self._text(params.get('status')) else []) if s]
        bad = [s for s in statuses if s not in self.ORDER_STATUSES]
        if bad:
            raise BizError('工单状态只能为：%s' % ' / '.join(self.ORDER_STATUSES))
        if statuses:
            where += ' AND o.`status` IN (%s)' % ','.join(['%s'] * len(statuses))
            args.extend(statuses)
        return where, args

    def details(self, params):
        """钻取到工单：某员工在区间内的工单清单（分页），带 planId / taskId 供跳转。"""
        params = params or {}
        me, _ = self._me(params)
        params['_empId'] = me
        start, end = self._range(params)
        if self._text(params.get('ownerId')) == '':
            raise BizError('缺少员工参数 ownerId')
        owner_id = self._int(params.get('ownerId'), -1)
        if owner_id < 0:
            raise BizError('员工参数不合法')
        where, args = self._detail_where(params, start, end, owner_id)
        page_num = max(1, self._int(params.get('pageNum'), 1))
        page_size = self._int(params.get('pageSize'), 10)
        page_size = min(self.MAX_PAGE_SIZE, max(1, page_size))

        # 小计必须按「整段区间」算，不能只数当前页（否则翻页时数字会变）
        total_row = query_one(
            'SELECT COUNT(*) AS `n`, '
            "SUM(CASE WHEN o.`status`='已完成' THEN 1 ELSE 0 END) AS `done`, "
            "SUM(CASE WHEN o.`status`<>'已完成' AND o.`endDate` IS NOT NULL "
            '         AND o.`endDate` < CURDATE() THEN 1 ELSE 0 END) AS `overdue` '
            'FROM `%s` o WHERE %s' % (self.ORDER_TABLE, where), tuple(args)) or {}
        total = self._int(total_row.get('n'))
        rows = query_all(self.DETAIL_SQL % (self.ORDER_TABLE, self.PROJECT_TABLE, where)
                         + ' ORDER BY o.`dispatchTime` DESC, o.`orderCode` DESC LIMIT %s OFFSET %s',
                         tuple(args + [page_size, (page_num - 1) * page_size]))
        today = datetime.date.today()
        items = []
        for r in rows:
            end_date = self._dt_text(r.get('endDate'), with_time=False)
            status = self._text(r.get('status')) or '待处理'
            overdue = bool(status != '已完成' and end_date and end_date < today.isoformat())
            dispatch = self._dt_text(r.get('dispatchTime'))
            actual = self._dt_text(r.get('actualEndTime'), with_time=False)
            days = None
            if status == '已完成' and actual and dispatch:
                try:
                    d0 = datetime.date(*[int(x) for x in dispatch[:10].split('-')])
                    d1 = datetime.date(*[int(x) for x in actual[:10].split('-')])
                    days = max(0, (d1 - d0).days)
                except Exception:
                    days = None
            items.append({
                'orderId': self._text(r.get('orderId')),
                'orderCode': self._text(r.get('orderCode')),
                'taskName': self._text(r.get('orderTitle')),
                'taskId': self._text(r.get('taskId')),
                'taskType': self._text(r.get('taskType')),
                'planId': self._text(r.get('planId')),
                'planCode': self._text(r.get('planCode')),
                'planName': self._text(r.get('planName')),
                'projectId': self._text(r.get('projectId')),
                'projectName': self._text(r.get('projectName')) or '未关联项目',
                'startDate': self._dt_text(r.get('startDate'), with_time=False),
                'endDate': end_date,
                'dispatchTime': dispatch,
                'actualEndTime': actual,
                'status': status,
                'acceptStatus': self._text(r.get('acceptStatus')),
                'ownerName': self._text(r.get('ownerName')),
                'participantNames': self._text(r.get('participantNames')),
                'days': days,
                'overdue': overdue,
            })
        summary = {'total': total,
                   'done': self._int(total_row.get('done')),
                   'overdue': self._int(total_row.get('overdue')),
                   'doneRate': self._rate(self._int(total_row.get('done')), total)}
        return {'list': items, 'total': total, 'pageNum': page_num, 'pageSize': page_size,
                'pages': max(1, int((total + page_size - 1) / page_size)),
                'range': {'startDate': start.isoformat(), 'endDate': end.isoformat()},
                'summary': summary}

    # ---------------- 导出 Excel（汇总 + 明细 两个页签） ----------------
    def export(self, params):
        params = params or {}
        me, _ = self._me(params)
        params['_empId'] = me
        start, end = self._range(params)
        try:
            from openpyxl import Workbook
            from openpyxl.styles import Alignment, Font, PatternFill
            from openpyxl.utils import get_column_letter
        except Exception:
            raise BizError('服务器未安装 openpyxl，无法导出 Excel')

        items = self._sort_items(self._person_rows(params, start, end),
                                 self._text(params.get('sortBy')) or 'orderCount',
                                 self._text(params.get('sortOrder')).lower() != 'asc')
        detail_where, detail_args = self._detail_where(params, start, end)
        rows = query_all(self.DETAIL_SQL % (self.ORDER_TABLE, self.PROJECT_TABLE, detail_where)
                         + ' ORDER BY o.`ownerId`, o.`dispatchTime` DESC',
                         tuple(detail_args))

        head_fill = PatternFill('solid', fgColor='E8F0FE')
        wb = Workbook()
        ws = wb.active
        ws.title = '员工汇总'
        heads = ['序号', '员工', '工号', '部门', '接单数', '已完成', '处理中', '待处理',
                 '逾期', '完成率(%)', '按期率(%)', '平均耗时(天)', '涉及计划数', '最近派单']
        ws.append(heads)
        for idx, it in enumerate(items, start=1):
            ws.append([idx, it['ownerName'], it['empCode'], it['deptName'], it['orderCount'],
                       it['doneCount'], it['doingCount'], it['todoCount'], it['overdueCount'],
                       it['doneRate'], it['onTimeRate'], it['avgDays'], it['planCount'],
                       it['lastDispatch']])

        ws2 = wb.create_sheet('工单明细')
        heads2 = ['工单号', '任务名称', '责任人', '所属项目', '计划编号', '计划名称', '工单状态',
                  '验收状态', '派单时间', '计划开始', '计划结束', '实际完成']
        ws2.append(heads2)
        for r in rows:
            ws2.append([self._text(r.get('orderCode')), self._text(r.get('orderTitle')),
                        self._text(r.get('ownerName')),
                        self._text(r.get('projectName')) or '未关联项目',
                        self._text(r.get('planCode')), self._text(r.get('planName')),
                        self._text(r.get('status')), self._text(r.get('acceptStatus')),
                        self._dt_text(r.get('dispatchTime')),
                        self._dt_text(r.get('startDate'), with_time=False),
                        self._dt_text(r.get('endDate'), with_time=False),
                        self._dt_text(r.get('actualEndTime'), with_time=False)])

        for sheet, widths, count in ((ws, [6, 12, 12, 18, 9, 9, 9, 9, 7, 11, 11, 13, 11, 20], len(heads)),
                                     (ws2, [12, 26, 12, 20, 12, 24, 10, 10, 20, 12, 12, 12], len(heads2))):
            for c in range(1, count + 1):
                cell = sheet.cell(row=1, column=c)
                cell.font = Font(bold=True, color='303133')
                cell.fill = head_fill
                cell.alignment = Alignment(horizontal='center', vertical='center')
            for i, w in enumerate(widths, start=1):
                sheet.column_dimensions[get_column_letter(i)].width = w
            sheet.freeze_panes = 'A2'
            if sheet.max_row > 1:
                sheet.auto_filter.ref = 'A1:%s%d' % (get_column_letter(count), sheet.max_row)

        buf = io.BytesIO()
        wb.save(buf)
        name = '员工工作量统计_%s_%s.xlsx' % (start.strftime('%Y%m%d'), end.strftime('%Y%m%d'))
        return {'content': buf.getvalue(), 'filename': name,
                'mimetype': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'rowCount': len(items)}


work_plan_service = WorkPlanService()
requirement_service = RequirementService()
bug_service = BugService()
workload_service = WorkloadService()


_WORKPLAN_MAIL_WORKER = {'started': False}


def start_workplan_mail_worker():
    """后台线程：发送工作计划变更邮件队列（保存接口只入队，不等待 SMTP）。"""
    if _WORKPLAN_MAIL_WORKER['started']:
        return None

    def loop():
        while True:
            try:
                work_plan_service.process_mail_queue(20)
            except Exception:
                traceback.print_exc()
            time.sleep(5)

    th = threading.Thread(target=loop, name='workplan-mail-queue', daemon=True)
    th.start()
    _WORKPLAN_MAIL_WORKER['started'] = True
    return th



SERVICES = {
    'menu': menu_service,
    'group': group_service,
    'groupitem': group_item_service,
    'org': org_service,          # 部门组织架构 /api/org/*
    'emp': emp_service,          # 员工信息 /api/emp/*
    'emparchive': emp_archive_service,  # 员工信息归档 /api/emparchive/*（UUID 主键，整表快照）
    'useinfo': user_info_service,       # 用户信息 /api/useinfo/*（UUID 主键，账号=员工手机号，密码 MD5）
    'auth': auth_service,               # 登录认证 /api/auth/*（账号+MD5 密码 → token / 退出 / 当前用户）
    'dptmgr': dpt_mgr_service,   # 部门负责人设置 /api/dptmgr/*
    'role': role_service,        # 用户角色 /api/role/*（UUID 主键）
    'rolepower': role_power_service,   # 角色权限 /api/rolepower/*（UUID 主键）
    'pageopbtn': page_op_btn_service,  # 页面操作按钮 /api/pageopbtn/*（UUID 主键，自动收录）
    'serviceemail': service_email_service,  # 服务信箱 /api/serviceemail/*（UUID 主键，全表仅一条启用）
    'mail': mail_service,               # 邮箱助手 /api/mail/*（收件 / 列表 / 读信 / 发信）
    'empmail': emp_mail_service,        # 我的邮箱 /api/empmail/*（员工个人信箱，按 empId 强隔离 + 自动收件）
    'msg': emp_message_service,          # 站内消息 /api/msg/*（员工间互发，按 empId 强隔离：收件箱 / 已发送）
    'notify': notify_service,            # 主框架提醒中心 /api/notify/summary（即时对话 + 邮件未读聚合）
    'addressbook': address_book_service,  # 员工通讯录 /api/addressbook/*（只读：列表 + 部门树）
    'dbinfo': db_info_service,          # 数据中心 · 数据库连接 /api/dbinfo/*（连接信息 + 结构扫描）
    'appinfo': app_info_service,        # 数据中心 · 应用信息 /api/appinfo/*（应用 + 绑定连接 1:1）
    'appschema': app_schema_service,    # 数据中心 · 应用结构 /api/appschema/*（库/表/视图/过程/字段 + 版本脚本 + 对比）
    'report': report_service,           # 数据中心 · 报表设计 /api/report/*（报表信息 + 预览 + 调用）
    'project': project_service,         # 项目管理 · 项目信息 /api/project/*（PRO + 6 位流水号）
    'projectdir': project_dir_service,    # 项目管理 · 项目目录 /api/projectdir/*（多级文件夹 / 树）
    'projectfile': project_file_service,  # 项目管理 · 项目文件 /api/projectfile/*（上传 / 下载）
    'projectmember': project_member_service,  # 项目管理 · 项目组 /api/projectmember/*（成员 + 通知）
    'projectplan': project_plan_service,      # 项目管理 · 项目计划 /api/projectplan/*（计划 + 工单 + 通知）
    'workplan': work_plan_service,            # 项目管理 · 工作计划 /api/workplan/*（甘特 / 日历 / 网格三视图 + 执行记录 + 工单关联）
    'requirement': requirement_service,        # 项目管理 · 需求池 /api/requirement/*（收集 / 评估 / 转计划 / 验收）
    'bug': bug_service,                        # 项目管理 · 缺陷管理 /api/bug/*（登记 / 评估 / 转修复工单）
    'workload': workload_service,              # 项目管理 · 员工工作量统计 /api/workload/*（按派单时间聚合 + 明细钻取）
    'sysdict': sys_dict_service,          # 系统配置 · 系统字典（键 / 树形上级 / 显示序号）
    'sysdictitems': sys_dict_item_service,  # 系统配置 · 字典键值明细（按 dictId 归属）
    'syspara': sys_para_service,          # 系统配置 · 系统参数（英文名唯一 / 参数值）
}

ACTIONS = {
    'list': ('page', ['GET', 'POST']),
    'detail': ('detail', ['GET']),
    'check': ('check', ['GET']),              # 仅菜单项 / 菜单组（菜单组项目无唯一性字段）
    'add': ('add', ['POST']),                 # 菜单组项目：批量追加
    'update': ('update', ['POST']),           # 菜单组项目：按提交结果全量同步
    'delete': ('delete', ['POST']),
    'tree': ('tree', ['GET']),                # 仅菜单组：层级下拉数据
    'nextcode': ('next_code', ['GET']),       # 仅菜单项：自动生成编号（MNU + 5 位流水号）
    'set': ('set_manager', ['POST']),         # 仅部门负责人：设置 / 替换负责人（deptId 唯一）
    'save': ('save', ['POST']),               # 角色权限：全量替换授权 / 我的邮箱：保存本人信箱配置
    'importtasks': ('parse_import', ['POST']),  # 仅工作计划：解析导入的 Excel（base64 → 预览行 + 逐行错误，**不写库**）
    'clear': ('clear', ['POST']),             # 仅角色权限：清空某角色的授权
    'scan': ('scan', ['POST']),               # 仅页面操作按钮：扫描页面自动收录
    'pages': ('pages', ['GET']),              # 仅页面操作按钮：页面下拉（distinct pagePath）
    'buttons': ('buttons', ['GET']),           # 仅角色权限：该角色已授权的页面按钮清单
    'mybuttons': ('my_buttons', ['GET']),        # 角色权限：当前登录角色可用的页面按钮（全站按钮可用性）
    'archive': ('archive', ['POST']),          # 仅员工信息归档：整表快照到 empinfoarchive
    'batches': ('batches', ['GET']),           # 仅员工信息归档：历次归档批次（时间 + 记录数）
    'batch': ('batch_create', ['POST']),       # 仅用户信息：按员工批量创建账号（初始密码 888888）
    'resetpwd': ('reset_password', ['POST']),  # 仅用户信息：批量重置密码为 888888
    'setroles': ('set_roles', ['POST']),       # 仅用户信息：批量设置角色（全量替换）
    'empoptions': ('emp_options', ['GET']),    # 仅用户信息：员工下拉（是否已有账号）
    'login': ('login', ['POST']),              # 仅登录认证：账号 + MD5 密码换取 token
    'logout': ('logout', ['POST']),            # 仅登录认证：退出登录（清空 token）
    'me': ('me', ['GET']),                     # 仅登录认证：按 token 反查当前登录用户
    'brand': ('brand', ['GET']),               # 仅登录认证：**免登录**取系统品牌（仅 app_name / app_ennme / app_ico）
    'captcha': ('captcha', ['GET']),            # 仅登录认证：生成运算表达式验证码（一次性，5 分钟有效）
    'sendcode': ('sendcode', ['POST']),         # 仅登录认证：忘记密码 → 往登记邮箱发 6 位验证码（服务信箱 SMTP）
    'resetbyemail': ('resetbyemail', ['POST']), # 仅登录认证：忘记密码 → 验证码 + 新密码重置，并把新密码发回邮箱
    'changepwd': ('changepwd', ['POST']),       # 仅登录认证：登录后自助改密（原密码 + 新密码，改完作废 token）
    # ---- 服务信箱 / 邮箱助手 ----
    'enabled': ('enabled', ['POST']),            # 仅服务信箱：启用 / 停用（全表仅一条启用）
    'test': ('test', ['POST']),                  # 服务信箱 / 我的邮箱：测试 IMAP / SMTP 连接
    'status': ('status', ['GET']),               # 邮箱助手 / 我的邮箱：信箱状态 + 未读数
    'sync': ('sync', ['POST']),                  # 邮箱助手 / 我的邮箱：立即收件（IMAP，按 UID 去重）
    'send': ('send', ['POST']),                  # 邮箱助手 / 我的邮箱：写邮件并发送（成功后入发件箱）
    'mark': ('mark', ['POST']),                  # 邮箱助手 / 我的邮箱：标记已读 / 未读
    'attachments': ('attachments', ['GET', 'POST']),  # 读信区附件下载清单；POST+refresh=1 按 UID 补拉历史附件
    # ---- 站内消息（IM 实时模式）----
    'contacts': ('contacts', ['GET']),           # 联系人快照：全员 + 在线态 + 未读 + 最近消息（WebQQ 风格）
    'history': ('history', ['GET']),             # 与某员工的会话历史（双向，按时间正序，自动标记已读）
    'markpeer': ('mark_peer', ['POST']),         # 把与某员工的对话标记为已读（供 REST 回执 / 兜底）
    'summary': ('summary', ['GET']),             # 仅提醒中心：即时对话 + 我的邮箱 未读聚合（主框架铃铛 / 菜单上标）
    # ---- 即时对话（媒体附件 / 群组）：upload 动作复用下方项目管理同名动作 ----
    'groups': ('groups', ['GET']),               # 即时对话：我加入的群（含未读 / 最近一条）
    'groupadd': ('group_add', ['POST']),         # 即时对话：建群（群主自动入群，群名可空则自动拼）
    'groupupdate': ('group_update', ['POST']),   # 即时对话：改群名 / 换成员（仅群主）
    'groupdelete': ('group_delete', ['POST']),   # 即时对话：群主解散 / 成员退群
    'groupdetail': ('group_detail', ['GET']),    # 即时对话：群资料 + 成员列表（成员可见）
    'grouphistory': ('group_history', ['GET']),  # 即时对话：群消息历史（打开即已读）
    'markgroup': ('mark_group', ['POST']),       # 即时对话：把某个群标记为已读
    'emojis': ('emojis', ['GET']),               # 即时对话：表情包列表（全站共享）
    'emojiadd': ('emoji_add', ['POST']),         # 即时对话：把已上传的图片登记为表情包
    'emojidel': ('emoji_delete', ['POST']),      # 即时对话：删除表情包（仅本人上传）
    # ---- 数据中心（数据库连接 / 结构扫描） ----
    'tables': ('tables', ['GET']),               # 仅数据中心：扫描某实例下的表与视图
    'columns': ('columns', ['GET']),             # 仅数据中心：扫描某张表 / 视图的字段
    'types': ('types', ['GET']),                 # 仅数据中心：数据库类型下拉（含默认端口）
    'sqlrun': ('sqlrun', ['POST']),              # 仅数据中心：SQL 工作台执行一条只读查询
    'rows': ('rows', ['POST']),                  # 仅数据中心：表 / 视图数据分页（排序 + 过滤，只读）
    # ---- 数据中心（应用架构：应用信息 + 结构版本 + 脚本 + 对比） ----
    'meta': ('meta', ['GET']),                   # 应用信息：表单下拉（应用类型 / 环境 / 方言 / 逻辑类型）
    'versions': ('versions', ['GET']),           # 应用结构：版本列表（草稿 / 正式版 + 脚本状态）
    'version': ('version', ['GET']),             # 应用结构：单个版本详情（变更明细 + 正/回滚脚本）
    'publish': ('publish', ['POST']),            # 应用结构：发布草稿 → 正式版号 + 脚本（pending，不自动执行）
    'discard': ('discard', ['POST']),            # 应用结构：丢弃草稿
    'scriptstatus': ('scriptstatus', ['POST']),  # 应用结构：人工确认执行后回写脚本状态
    'scaninfo': ('scan_info', ['GET']),          # 应用结构：扫描前确定「扫哪个库」（连接默认库 + 可访问库名单）
    'compareconns': ('compare_conns', ['GET']),  # 应用结构：实库对比可选连接（同方言 + 可见，供选连接 → 选库）
    'compare': ('compare', ['POST']),            # 应用结构：与真实数据库对比（人工触发，结果留存）
    'compares': ('compares', ['GET']),           # 应用结构：历次对比记录
    'compareitems': ('compareitems', ['GET']),   # 应用结构：对比明细（分页 / 按差异类型过滤）
    'compareupgrade': ('compareupgrade', ['GET']),  # 应用结构：某次对比 → 升级实库的脚本（现算，可含 DROP）
    'compareexport': ('compareexport', ['GET', 'POST']),  # 应用结构：批量导出多条对比记录的升级脚本
    'exportdocs': ('export_docs', ['GET', 'POST']),  # 应用结构：勾选表 → 导出 Excel / Word 结构说明文档（文件流）
    'lineage': ('lineage', ['GET']),             # 应用结构：字段级血缘（字段清单 + 上游 / 下游明细）
    'lineagebuild': ('lineagebuild', ['POST']),  # 应用结构：重建字段血缘（解析视图 / 触发器 / 过程 / 函数里的 SQL）
    'lineageedgesave': ('lineageedgesave', ['POST']),  # 应用结构：手工新增 / 标注血缘边（origin=manual，重算不覆盖）
    'lineageedgedel': ('lineageedgedel', ['POST']),    # 应用结构：删除手工血缘边（自动边需先转手工）
    'cols': ('cols', ['GET']),                   # 应用结构：某对象的字段清单
    'colsave': ('colsave', ['POST']),            # 应用结构：保存字段（支持批量，一次一版）
    'coldel': ('coldel', ['POST']),              # 应用结构：删除字段
    'dbadd': ('dbadd', ['POST']),                # 应用结构：新增库
    'dbupdate': ('dbupdate', ['POST']),          # 应用结构：修改库
    'dbdel': ('dbdel', ['POST']),                # 应用结构：删除库（连带对象与字段）
    'objadd': ('objadd', ['POST']),              # 应用结构：新增表 / 视图 / 存储过程
    'objupdate': ('objupdate', ['POST']),        # 应用结构：修改对象
    'objdel': ('objdel', ['POST']),              # 应用结构：删除对象（连带字段）
    'importddl': ('importddl', ['POST']),        # 应用结构：导入 CREATE / ALTER 语句（只改设计态）
    'parsesql': ('parse', ['POST']),             # 应用结构：只解析不落库（预览导入结果）
    # ---- 数据中心（报表设计器 / 报表信息） ----
    'categories': ('categories', ['GET']),        # 仅报表设计：报表分类聚合（含计数）
    'connections': ('connections', ['GET']),      # 仅报表设计：数据源下拉（启用状态的数据库连接）
    'databases': ('databases', ['GET']),          # 仅报表设计：扫连接下可用的实例（库）
    'copy': ('copy', ['POST']),                   # 仅报表设计：复制一张报表（新编码 + 默认停用）
    'preview': ('preview', ['POST']),             # 仅报表设计：预览（未保存也能预览，只读查询）
    'run': ('run', ['POST']),                     # 仅报表设计：按 id / code 调用报表（累加 runCount）
    'center': ('center', ['GET']),                # 仅报表中心：启用状态的报表分页（分类聚合也只算启用）
    # ---- 项目管理（项目信息 / 项目文件） ----
    'options': ('options', ['GET']),              # 仅项目信息：项目下拉（可见 + 启用）
    'upload': ('upload', ['POST']),               # 仅项目文件：上传文件（base64 → 落盘 → 入库）
    'download': ('download', ['GET']),            # 仅项目文件：取下载地址（带可见性校验）
    'members': ('members', ['GET']),                 # 仅项目组：某项目的成员清单
    'membersave': ('save_members', ['POST']),        # 仅项目组：保存成员（差异增删 + 站内消息 / 邮件通知）
    'start': ('start', ['POST']),                   # 项目计划（已下线）：启动执行；工作计划：启动 + 通知责任人/参与人
    'people': ('people', ['GET']),                  # 工作计划：选人数据源（组织树 + 员工信息 + 项目组成员）
    'exec': ('exec_record', ['POST']),              # 工作计划：从我的任务工单回填执行记录到关联任务
    'execs': ('execs', ['GET']),                      # 工作计划：执行记录单列表（工单 / 任务 / 计划，含附件）
    'execfile': ('execfile', ['GET']),                # 工作计划：执行记录附件预览（dataUrl，<=10MB）
    'changelogs': ('changelogs', ['GET']),            # 工作计划：变更日志时间线（按计划 / 任务）
    'stop': ('stop', ['POST']),                       # 工作计划：停止计划（仅创建人）
    'planorders': ('plan_orders', ['GET']),            # 工作计划：计划 / 项目维度全部工单（可见计划）
    'projectplans': ('project_plans', ['GET']),        # 项目详情：项目下的工作计划（项目全员可见）
    'evaluate': ('evaluate', ['POST']),
    'respond': ('respond', ['POST']),              # 需求评估（通过 / 不通过 + 工时 + 评估人）
    'confirm': ('confirm', ['POST']),              # 缺陷管理：确认缺陷并生成研发 / 测试 / 验收工单
    'bugclose': ('close', ['POST']),                # 缺陷管理：关闭缺陷并记录原因
    'createplan': ('create_plan', ['POST']),          # 需求转研发计划（仅评估通过，一对一）
    'orderaccept': ('accept_order', ['POST']),        # 工单验收（计划创建人）
    'file': ('file_data', ['GET']),                  # 需求附件读取（base64 dataUrl）
    'evalupload': ('evaluation_upload', ['POST']),   # 评估记录附件上传
    'evalfile': ('evaluation_file', ['GET']),        # 评估记录附件读取
    'items': ('items', ['GET']),                    # 项目计划：某计划下的事项 / 任务清单
    'itemdetail': ('item_detail', ['GET']),         # 项目计划：事项详情（含附件）
    'itemadd': ('item_add', ['POST']),              # 项目计划：新增事项（生成工单 + 通知责任人）
    'itemupdate': ('item_update', ['POST']),        # 项目计划：修改事项（换责任人再通知）
    'itemdelete': ('item_delete', ['POST']),        # 项目计划：删除事项（连带工单 / 附件）
    'itemstatuses': ('statuses', ['GET']),          # 项目计划：事项状态下拉（字典 project_plan_item_status）
    'itemfiles': ('item_files', ['GET']),           # 项目计划：事项附件清单
    'itemfileadd': ('item_file_add', ['POST']),     # 项目计划：上传事项附件（base64）
    'itemfiledelete': ('item_file_delete', ['POST']),  # 项目计划：删除事项附件
    'itemfiledownload': ('item_file_download', ['GET']),  # 项目计划：取附件下载 / 预览地址

    'orders': ('orders', ['GET']),                  # 项目计划：某计划工单清单；工作计划：我的任务（责任人 / 参与人）
    # ---- 项目管理 · 员工工作量统计 ----
    'stats': ('stats', ['GET']),                    # 工作量统计：按员工聚合（接单 / 完成 / 逾期 / 完成率 / 平均耗时）
    'details': ('details', ['GET']),                # 工作量统计：钻取某员工区间内的工单明细（分页，带 planId / taskId）
    'importdoc': ('import_doc', ['POST']),        # 仅项目信息：Word（.docx）→ 富文本 HTML（服务端兜底解析）
    # 说明：'tree' / 'options' / 'enabled' / 'check' 等动作名全局唯一、方法名一致，
    #       系统配置（sysdict）复用 tree（上级字典树）与 options（所属字典下拉），无需新增动作。
}
