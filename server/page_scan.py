# -*- coding: utf-8 -*-
"""
页面操作按钮扫描器（供 pageopbtn 表「自动收录」使用）

扫描 WEB_ROOT 下的 *.html，抽取「操作引导区」里的按钮：
  · 优先取 <div class="toolbar">（列表页的操作引导区）
  · 兼容 <div class="pick-toolbar">（弹窗里的小工具栏）
  · 兼容 <div class="form-actions">（表单页底部的「保存 / 返回」操作区）
按钮按页面出现顺序编号（sortNo 从 0 开始），文本取按钮内文字；纯图标按钮（如数据中心的工具栏）
没有文字，退化为 title / aria-label 的文案，两者都没有才用按钮 id —— 权限页里不会满屏都是 btnXxx。

只依赖标准库 html.parser，不引入第三方解析库。
"""
import io
import os
import re

# 无需闭合标签（自闭合）的元素
VOID_TAGS = set("""area base br col embed hr img input link meta param source track wbr
                   path circle rect line polygon polyline ellipse use stop animate""".split())

# 视为「操作区」的容器 class
# im-input__tools：即时对话页输入框上方的常驻工具条（发图片 / 传文件 / 语音输入 / 截屏）
SECTION_CLASSES = ('toolbar', 'pick-toolbar', 'form-actions', 'im-input__tools')

# 少数页面把操作区放在自有容器里（如应用结构页的顶栏 / 面板条），按页面显式登记，
# 不动全局 SECTION_CLASSES，避免把别的页面「本来不想收录」的按钮一起卷进来。
PAGE_SECTIONS = {
    # 应用结构：顶部应用级动作 + 左栏标题栏（新增库）+ 四个标签页各自的面板条
    'appschema.html': ('as-topbar__body', 'db-pane__head', 'as-pane-bar'),
}

# 允许收录的文件：页面根目录下的 .html（不含以下划线开头的调试页）
PAGE_RE = re.compile(r'^[A-Za-z0-9][\w.-]*\.html$')


class _Node(object):
    __slots__ = ('tag', 'attrs', 'children', 'parent')

    def __init__(self, tag, attrs=None, parent=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []
        self.parent = parent

    def get(self, name, default=''):
        return self.attrs.get(name, default)

    def classes(self):
        return (self.attrs.get('class') or '').split()

    def text(self):
        """节点内纯文本（去掉子标签）"""
        buf = []

        def walk(node):
            for child in node.children:
                if isinstance(child, str):
                    buf.append(child)
                else:
                    walk(child)

        walk(self)
        return re.sub(r'\s+', ' ', ''.join(buf)).strip()

    def find_all(self, tag):
        out = []

        def walk(node):
            for child in node.children:
                if isinstance(child, str):
                    continue
                if child.tag == tag:
                    out.append(child)
                walk(child)

        walk(self)
        return out

    def find_by_class(self, cls):
        out = []

        def walk(node):
            for child in node.children:
                if isinstance(child, str):
                    continue
                if cls in child.classes():
                    out.append(child)
                walk(child)

        walk(self)
        return out


def _parse_html(text):
    """把 HTML 解析成极简节点树（容错：多余的闭合标签直接忽略）"""
    from html.parser import HTMLParser

    class Parser(HTMLParser):
        def __init__(self):
            HTMLParser.__init__(self, convert_charrefs=True)
            self.root = _Node('#document')
            self.cur = self.root

        def handle_starttag(self, tag, attrs):
            node = _Node(tag, dict((k, v if v is not None else '') for k, v in attrs), self.cur)
            self.cur.children.append(node)
            if tag not in VOID_TAGS:
                self.cur = node

        def handle_startendtag(self, tag, attrs):
            node = _Node(tag, dict((k, v if v is not None else '') for k, v in attrs), self.cur)
            self.cur.children.append(node)

        def handle_endtag(self, tag):
            if tag in VOID_TAGS:
                return
            node = self.cur
            while node is not None and node.tag != tag:
                node = node.parent
            if node is not None and node.parent is not None:
                self.cur = node.parent

        def handle_data(self, data):
            self.cur.children.append(data)

    parser = Parser()
    parser.feed(text)
    return parser.root


def _page_name(root, fallback):
    """页面名称：.page-head__title → .page-head[data-crumb] 末段 → <title> 去后缀 → 文件名"""
    for node in root.find_by_class('page-head__title'):
        name = node.text()
        if name:
            return name
    for node in root.find_by_class('page-head'):
        crumb = node.get('data-crumb')
        if crumb:
            return crumb.split('/')[-1].strip()
    titles = root.find_all('title')
    if titles:
        name = titles[0].text()
        if ' - ' in name:
            name = name.split(' - ')[0]
        if name:
            return name.strip()
    return fallback


def scan_page(path, filename):
    """扫描单个页面，返回 [{pageName, pagePath, btnId, btnText, sortNo, section}]"""
    try:
        text = io.open(path, encoding='utf-8', errors='ignore').read()
    except (IOError, OSError):
        return []
    root = _parse_html(text)
    page_name = _page_name(root, filename)
    rows = []
    seen = set()
    sections = PAGE_SECTIONS.get(filename, ()) + SECTION_CLASSES
    for cls in sections:
        for section in root.find_by_class(cls):
            for btn in section.find_all('button'):
                btn_id = btn.get('id')
                if not btn_id or btn_id in seen:
                    continue
                seen.add(btn_id)
                label = (btn.text() or btn.get('title') or btn.get('aria-label') or btn_id)
                rows.append({
                    'pageName': page_name,
                    'pagePath': filename,
                    'btnId': btn_id,
                    'btnText': label[:60],
                    'sortNo': len(rows),
                    'section': cls,
                })
    return rows


def scan_pages(web_root):
    """扫描目录下全部页面，返回按页面 / 按钮顺序排好的列表"""
    out = []
    try:
        names = sorted(os.listdir(web_root))
    except (IOError, OSError):
        return out
    for name in names:
        if not PAGE_RE.match(name) or name.startswith('_'):
            continue
        full = os.path.join(web_root, name)
        if not os.path.isfile(full):
            continue
        out.extend(scan_page(full, name))
    return out
