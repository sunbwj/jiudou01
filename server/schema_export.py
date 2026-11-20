# -*- coding: utf-8 -*-
"""
表结构文档导出：Excel（.xlsx）/ Word（.docx）
----------------------------------------------------------------------------
给「应用结构」页的「导出表结构」用：勾一张或多张表 → 生成一份能直接给开发 / 交付看的
结构说明文档，内容是**设计态**（appschemadbs / appschemaobjs / appschemacols），
不连真实库、不触发扫描。

文档固定包含三块（用户明确要求的「应用信息 / 表中文名 / 导出时间」都在里面）：
  1. 应用信息：编码、名称、类型、方言、环境、部门、负责人、连接、目标库、导出时间、导出人；
  2. 表清单：序号 / 库 / 表名 / **中文名（objComment）** / 类型 / 字段数；
  3. 字段明细：每张表一段，字段名 + 中文名（colComment）+ 类型 + 长度 + 可空 / 主键 / 自增 / 默认值。

两个实现都只吃「纯数据」（meta + tables），不碰数据库 —— 取数在 AppSchemaService.export_docs 里，
这样单测可以直接拿内存数据验证文档内容。

依赖：openpyxl（Excel）、python-docx（Word）。缺依赖抛 ExportError，由 service 转成业务提示。
"""
import io
import re

# OOXML 不接受控制字符（\x00-\x08 等），字段注释里万一有就先清掉，否则写文件直接抛异常
_ILLEGAL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')

# 主题色（与页面一致：#409eff 主色，深蓝做表头更耐看）
C_HEAD = '1F4E79'
C_HEAD_TEXT = 'FFFFFF'
C_BAND = 'DCE6F1'
C_GROUP = 'EAF2FB'
C_LINE = 'B7C6DA'


class ExportError(Exception):
    """导出失败（缺依赖 / 内容为空 / 文件写不出来），消息直接给前端看"""


def _clean(value, limit=None):
    text = '' if value is None else str(value)
    text = _ILLEGAL.sub('', text).replace('\r\n', '\n').replace('\r', '\n').strip()
    if limit and len(text) > limit:
        text = text[:limit] + '…'
    return text


def _type_text(col):
    """逻辑类型 + 长度：VARCHAR(100) / DECIMAL(12,2) / DATETIME"""
    data_type = _clean(col.get('dataType')) or 'VARCHAR'
    length = _clean(col.get('length'))
    return '%s(%s)' % (data_type, length) if length else data_type


def _yes(value):
    return '是' if value else ''


def _col_total(tables):
    return sum(len(one.get('cols') or []) for one in tables)


def doc_title(meta):
    name = _clean(meta.get('appName'))
    return '%s 数据库表结构说明' % name if name else '数据库表结构说明'


def doc_stamp(meta):
    bits = ['导出时间 ' + (_clean(meta.get('exportTime')) or '—')]
    if _clean(meta.get('exporter')):
        bits.append('导出人 ' + _clean(meta.get('exporter')))
    bits.append('共 %d 张表 / %d 个字段' % (_clean_count(meta.get('tableCount')),
                                           _clean_count(meta.get('colCount'))))
    return ' · '.join(bits)


def _clean_count(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def info_items(meta):
    """应用信息（标签, 值）顺序固定，Excel 与 Word 共用同一份口径"""
    return [
        ('应用编码', _clean(meta.get('appCode'))),
        ('应用名称', _clean(meta.get('appName'))),
        ('应用简称', _clean(meta.get('appShort'))),
        ('应用类型', _clean(meta.get('appTypeLabel'))),
        ('数据库类型', _clean(meta.get('dbTypeLabel'))),
        ('运行环境', _clean(meta.get('envLabel'))),
        ('归属部门', _clean(meta.get('deptName'))),
        ('负责人', _clean(meta.get('ownerName'))),
        ('数据库连接', _clean(meta.get('connName')) or '未绑定（纯手工维护）'),
        ('目标库', _clean(meta.get('targetDb')) or '未指定'),
        ('应用说明', _clean(meta.get('description'), 400)),
        ('导出时间', _clean(meta.get('exportTime'))),
        ('导出人', _clean(meta.get('exporter'))),
        ('导出范围', _clean(meta.get('scopeText'))),
        ('表 / 字段数', '%d 张表 / %d 个字段'
         % (_clean_count(meta.get('tableCount')), _clean_count(meta.get('colCount')))),
    ]


# =====================================================================
# Excel
# =====================================================================
def build_xlsx(meta, tables):
    """生成 .xlsx：应用信息 / 表清单 / 字段明细 三个页签，返回 bytes"""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        raise ExportError('服务器未安装 openpyxl，无法导出 Excel（pip install openpyxl）')

    thin = Side(style='thin', color=C_LINE)
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    head_font = Font(name='微软雅黑', size=10, bold=True, color=C_HEAD_TEXT)
    head_fill = PatternFill('solid', fgColor=C_HEAD)
    band_fill = PatternFill('solid', fgColor=C_BAND)
    group_fill = PatternFill('solid', fgColor=C_GROUP)
    body_font = Font(name='微软雅黑', size=10)
    wrap = Alignment(horizontal='left', vertical='center', wrap_text=True)
    center = Alignment(horizontal='center', vertical='center', wrap_text=True)

    def put_header(ws, row, titles, widths=None):
        for idx, title in enumerate(titles, start=1):
            cell = ws.cell(row=row, column=idx, value=title)
            cell.font = head_font
            cell.fill = head_fill
            cell.alignment = center
            cell.border = border
        if widths:
            for idx, width in enumerate(widths, start=1):
                ws.column_dimensions[get_column_letter(idx)].width = width
        ws.row_dimensions[row].height = 22

    def put_row(ws, row, values, aligns=None):
        for idx, value in enumerate(values, start=1):
            cell = ws.cell(row=row, column=idx, value=value)
            cell.font = body_font
            cell.border = border
            cell.alignment = (aligns[idx - 1] if aligns and idx - 1 < len(aligns) else wrap)

    wb = Workbook()

    # ---------------- ① 应用信息 ----------------
    ws = wb.active
    ws.title = '应用信息'
    last_col = 4
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=last_col)
    title = ws.cell(row=1, column=1, value=doc_title(meta))
    title.font = Font(name='微软雅黑', size=16, bold=True, color=C_HEAD)
    title.alignment = Alignment(horizontal='center', vertical='center')
    ws.row_dimensions[1].height = 34

    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=last_col)
    sub = ws.cell(row=2, column=1, value=doc_stamp(meta))
    sub.font = Font(name='微软雅黑', size=10, color='606266')
    sub.alignment = Alignment(horizontal='center', vertical='center')
    ws.row_dimensions[2].height = 22

    ws.column_dimensions['A'].width = 16
    ws.column_dimensions['B'].width = 34
    ws.column_dimensions['C'].width = 16
    ws.column_dimensions['D'].width = 34

    items = info_items(meta)
    row = 4
    for idx in range(0, len(items), 2):
        pair = items[idx:idx + 2]
        for pos, (label, value) in enumerate(pair):
            col = 1 + pos * 2
            c1 = ws.cell(row=row, column=col, value=label)
            c1.font = head_font
            c1.fill = band_fill
            c1.alignment = center
            c1.border = border
            c2 = ws.cell(row=row, column=col + 1, value=value)
            c2.font = body_font
            c2.alignment = wrap
            c2.border = border
        ws.row_dimensions[row].height = 24
        row += 1

    note = ws.cell(row=row + 1, column=1,
                   value='说明：本文档取自平台「应用结构」的设计态（手工录入 / 扫描导入后的设计口径），'
                         '不代表当前真实数据库；需要与实库核对请到「实库对比」页执行对比。')
    note.font = Font(name='微软雅黑', size=9, color='909399')
    note.alignment = Alignment(horizontal='left', vertical='center', wrap_text=True)
    ws.merge_cells(start_row=row + 1, start_column=1, end_row=row + 1, end_column=last_col)
    ws.row_dimensions[row + 1].height = 32

    # ---------------- ② 表清单 ----------------
    ws2 = wb.create_sheet('表清单')
    ws2.merge_cells(start_row=1, start_column=1, end_row=1, end_column=6)
    t2 = ws2.cell(row=1, column=1, value='%s · 表清单' % doc_title(meta))
    t2.font = Font(name='微软雅黑', size=13, bold=True, color=C_HEAD)
    t2.alignment = Alignment(horizontal='left', vertical='center')
    ws2.row_dimensions[1].height = 28
    put_header(ws2, 2, ['序号', '所属库', '表名', '中文名', '对象类型', '字段数'],
               [6, 22, 34, 34, 10, 8])
    row = 3
    for idx, one in enumerate(tables, start=1):
        put_row(ws2, row, [idx, _clean(one.get('dbName')), _clean(one.get('objName')),
                           _clean(one.get('objComment')), _clean(one.get('typeLabel')) or '表',
                           len(one.get('cols') or [])],
                [center, wrap, wrap, wrap, center, center])
        row += 1
    ws2.freeze_panes = 'A3'
    ws2.auto_filter.ref = 'A2:F%d' % max(row - 1, 2)

    # ---------------- ③ 字段明细 ----------------
    ws3 = wb.create_sheet('字段明细')
    ws3.merge_cells(start_row=1, start_column=1, end_row=1, end_column=12)
    t3 = ws3.cell(row=1, column=1, value='%s · 字段明细' % doc_title(meta))
    t3.font = Font(name='微软雅黑', size=13, bold=True, color=C_HEAD)
    t3.alignment = Alignment(horizontal='left', vertical='center')
    ws3.row_dimensions[1].height = 28
    titles = ['所属库', '表名', '表中文名', '序号', '字段名', '字段中文名',
              '类型', '长度', '可空', '默认值', '主键', '自增']
    put_header(ws3, 2, titles, [20, 30, 28, 6, 26, 26, 14, 10, 7, 22, 7, 7])
    row = 3
    if not tables:
        ws3.cell(row=row, column=1, value='（没有可导出的表）').font = body_font
    for t_idx, one in enumerate(tables, start=1):
        cols = one.get('cols') or []
        # 每张表前插一条分组标题行（合并整行），长文档里翻页也能看清是哪张表。
        # 中文名走「· 分隔」而不是再套一层括号：注释本身常常带括号，套起来会像这样
        # 「appinfos（应用信息（一个应用一个数据库连接对象））」，很难读。
        ws3.merge_cells(start_row=row, start_column=1, end_row=row, end_column=len(titles))
        comment = _clean(one.get('objComment'))
        g = ws3.cell(row=row, column=1,
                     value='%d. %s%s · %d 个字段'
                           % (t_idx, _clean(one.get('objName')),
                              (' · ' + comment) if comment else '', len(cols)))
        g.font = Font(name='微软雅黑', size=10, bold=True, color=C_HEAD)
        g.fill = group_fill
        g.alignment = Alignment(horizontal='left', vertical='center')
        for cidx in range(1, len(titles) + 1):
            ws3.cell(row=row, column=cidx).border = border
        ws3.row_dimensions[row].height = 20
        row += 1
        if not cols:
            ws3.cell(row=row, column=1, value='（暂无字段）').font = body_font
            row += 1
            continue
        for c_idx, col in enumerate(cols, start=1):
            put_row(ws3, row, [
                _clean(one.get('dbName')), _clean(one.get('objName')), _clean(one.get('objComment')),
                c_idx, _clean(col.get('colName')), _clean(col.get('colComment')),
                _clean(col.get('dataType')), _clean(col.get('length')),
                '是' if col.get('nullable') else '否', _clean(col.get('defaultValue')),
                _yes(col.get('isPk')), _yes(col.get('isAutoInc')),
            ], [wrap, wrap, wrap, center, wrap, wrap, wrap, center, center, wrap, center, center])
            row += 1
    ws3.freeze_panes = 'A3'
    ws3.auto_filter.ref = 'A2:L%d' % max(row - 1, 2)

    for sheet in (ws, ws2, ws3):
        sheet.sheet_view.showGridLines = False
        sheet.page_setup.orientation = 'landscape'
        sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
        sheet.page_setup.fitToWidth = 1
        sheet.sheet_properties.pageSetUpPr.fitToPage = True

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# =====================================================================
# Word
# =====================================================================
def _set_cell(cell, text, bold=False, size=9, align=1, color=None, fill=None):
    """写一个单元格：统一字体（含 eastAsia，否则中文会回落到宋体）、字号、对齐、底色"""
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    cell.text = ''
    para = cell.paragraphs[0]
    para.alignment = {0: WD_ALIGN_PARAGRAPH.LEFT, 1: WD_ALIGN_PARAGRAPH.CENTER,
                      2: WD_ALIGN_PARAGRAPH.RIGHT}.get(align, WD_ALIGN_PARAGRAPH.LEFT)
    para.paragraph_format.space_before = Pt(1)
    para.paragraph_format.space_after = Pt(1)
    run = para.add_run('' if text is None else str(text))
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.name = '微软雅黑'
    run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
    if color:
        run.font.color.rgb = RGBColor.from_string(color)
    if fill:
        from docx.oxml import OxmlElement
        shd = OxmlElement('w:shd')
        shd.set(qn('w:val'), 'clear')
        shd.set(qn('w:color'), 'auto')
        shd.set(qn('w:fill'), fill)
        cell._tc.get_or_add_tcPr().append(shd)


# ---------------------------------------------------------------------
# 表格走「一次性拼 XML」：python-docx 的 cell.text / run.font 每格都要建一堆
# OxmlElement，一张 9000 字段的文档要 8 万个单元格，纯 API 写法实测 100 秒以上；
# 拼 XML 再 parse 一次挂到 body，同样内容只要几秒。
# ---------------------------------------------------------------------
_CM_TWIPS = 567          # 1cm = 567 twips


def _xml_escape(text):
    return (str(text if text is not None else '')
            .replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            .replace('"', '&quot;')
            # 单元格里不能留裸换行（w:t 不认），换成空格，视觉上仍是一行
            .replace('\n', ' ').replace('\t', ' '))


def _cell_xml(text, width, align='left', bold=False, size=9, color=None, fill=None):
    """一个 <w:tc>：宽度固定 + 可选底色 / 粗体 / 颜色，字体统一微软雅黑（含 eastAsia）"""
    shd = ('<w:shd w:val="clear" w:color="auto" w:fill="%s"/>' % fill) if fill else ''
    b = '<w:b/><w:bCs/>' if bold else ''
    clr = ('<w:color w:val="%s"/>' % color) if color else ''
    return ('<w:tc><w:tcPr><w:tcW w:w="%d" w:type="dxa"/>%s'
            '<w:vAlign w:val="center"/></w:tcPr>'
            '<w:p><w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/>'
            '<w:jc w:val="%s"/></w:pPr>'
            '<w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑" '
            'w:cs="微软雅黑"/>%s<w:sz w:val="%d"/><w:szCs w:val="%d"/>%s</w:rPr>'
            '<w:t xml:space="preserve">%s</w:t></w:r></w:p></w:tc>'
            % (int(round(width * _CM_TWIPS)), shd, align, b, size * 2, size * 2, clr,
               _xml_escape(text)))


def _table_xml(rows, widths_cm, aligns=None, head=True, size=9,
               head_fill=C_HEAD, band_fill=None):
    """整张表的 <w:tbl>：rows[0] 当表头（深底白字 + 跨页重复），其余为数据行"""
    from docx.oxml.ns import nsdecls

    total = int(round(sum(widths_cm) * _CM_TWIPS))
    borders = ''.join('<w:%s w:val="single" w:sz="4" w:space="0" w:color="%s"/>'
                      % (edge, C_LINE) for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'))
    parts = ['<w:tbl %s>' % nsdecls('w'),
             '<w:tblPr><w:tblW w:w="%d" w:type="dxa"/><w:jc w:val="center"/>'
             '<w:tblBorders>%s</w:tblBorders><w:tblLayout w:type="fixed"/>'
             '<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>'
             '</w:tblPr>' % (total, borders),
             '<w:tblGrid>%s</w:tblGrid>'
             % ''.join('<w:gridCol w:w="%d"/>' % int(round(one * _CM_TWIPS)) for one in widths_cm)]
    for r_idx, row in enumerate(rows):
        is_head = head and r_idx == 0
        cells = []
        for c_idx, value in enumerate(row):
            width = widths_cm[c_idx] if c_idx < len(widths_cm) else widths_cm[-1]
            align = (aligns[c_idx] if aligns and c_idx < len(aligns) else 'left')
            if is_head:
                cells.append(_cell_xml(value, width, 'center', True, size, C_HEAD_TEXT, head_fill))
            else:
                fill = band_fill if (band_fill and r_idx % 2 == 0) else None
                cells.append(_cell_xml(value, width, align, False, size, None, fill))
        tr_pr = '<w:trPr><w:tblHeader/></w:trPr>' if is_head else ''
        parts.append('<w:tr>%s%s</w:tr>' % (tr_pr, ''.join(cells)))
    parts.append('</w:tbl>')
    return ''.join(parts)


def _add_table(doc, rows, widths_cm, aligns=None, head=True, size=9, band_fill=None):
    """把拼好的表格挂到文档末尾（sectPr 之前，否则 Word 会认为文件损坏）"""
    from docx.oxml import parse_xml
    from docx.oxml.ns import qn

    tbl = parse_xml(_table_xml(rows, widths_cm, aligns, head, size, band_fill=band_fill))
    body = doc.element.body
    sect = body.find(qn('w:sectPr'))
    if sect is not None:
        sect.addprevious(tbl)
    else:
        body.append(tbl)
    return tbl


def _add_page_number(footer):
    """页脚「第 X 页 / 共 Y 页」：PAGE / NUMPAGES 域，Word 打开时自动算"""
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt

    para = footer.paragraphs[0]
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER

    def field(code):
        run = para.add_run()
        run.font.size = Pt(9)
        run.font.name = '微软雅黑'
        run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
        fld = OxmlElement('w:fldSimple')
        fld.set(qn('w:instr'), code)
        run._element.addnext(fld)

    def text(value):
        run = para.add_run(value)
        run.font.size = Pt(9)
        run.font.name = '微软雅黑'
        run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')

    text('第 ')
    field('PAGE')
    text(' 页 / 共 ')
    field('NUMPAGES')
    text(' 页')


def build_docx(meta, tables):
    """生成 .docx：封面信息 + 表清单 + 每表一节（字段表格），返回 bytes"""
    try:
        from docx import Document
        from docx.enum.section import WD_ORIENT
        from docx.enum.table import WD_TABLE_ALIGNMENT
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.oxml.ns import qn
        from docx.shared import Cm, Pt, RGBColor
    except ImportError:
        raise ExportError('服务器未安装 python-docx，无法导出 Word（pip install python-docx）')

    doc = Document()

    # 正文默认字体：不设 eastAsia 的话中文会变成「宋体」且中英混排难看
    normal = doc.styles['Normal']
    normal.font.name = '微软雅黑'
    normal.font.size = Pt(10)
    normal.element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
    normal.paragraph_format.space_after = Pt(4)
    normal.paragraph_format.line_spacing = 1.25

    # A4 横向：字段明细 10 列，纵向排不下（会挤成两三行一字）
    section = doc.sections[0]
    section.orientation = WD_ORIENT.LANDSCAPE
    section.page_width, section.page_height = Cm(29.7), Cm(21.0)
    section.left_margin = section.right_margin = Cm(1.6)
    section.top_margin = section.bottom_margin = Cm(1.6)
    _add_page_number(section.footer)

    def heading(text, size=13, color=C_HEAD, space_before=10, space_after=6):
        para = doc.add_paragraph()
        para.paragraph_format.space_before = Pt(space_before)
        para.paragraph_format.space_after = Pt(space_after)
        para.paragraph_format.keep_with_next = True
        run = para.add_run(text)
        run.font.size = Pt(size)
        run.font.bold = True
        run.font.name = '微软雅黑'
        run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
        run.font.color.rgb = RGBColor.from_string(color)
        return para

    # ---------------- 标题 ----------------
    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title.paragraph_format.space_before = Pt(24)
    title.paragraph_format.space_after = Pt(6)
    run = title.add_run(doc_title(meta))
    run.font.size = Pt(24)
    run.font.bold = True
    run.font.name = '微软雅黑'
    run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
    run.font.color.rgb = RGBColor.from_string(C_HEAD)

    sub = doc.add_paragraph()
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    sub.paragraph_format.space_after = Pt(16)
    run = sub.add_run(doc_stamp(meta))
    run.font.size = Pt(10)
    run.font.name = '微软雅黑'
    run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
    run.font.color.rgb = RGBColor.from_string('606266')

    # ---------------- 一、应用信息 ----------------
    heading('一、应用信息')
    items = info_items(meta)
    table = doc.add_table(rows=0, cols=4)
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    widths = (Cm(3.4), Cm(9.8), Cm(3.4), Cm(9.8))
    for idx in range(0, len(items), 2):
        pair = items[idx:idx + 2]
        row = table.add_row()
        for pos in range(2):
            if pos < len(pair):
                label, value = pair[pos]
                _set_cell(row.cells[pos * 2], label, bold=True, fill=C_BAND)
                _set_cell(row.cells[pos * 2 + 1], value)
            else:
                _set_cell(row.cells[pos * 2], '')
                _set_cell(row.cells[pos * 2 + 1], '')
        for c_idx, width in enumerate(widths):
            row.cells[c_idx].width = width

    note = doc.add_paragraph()
    note.paragraph_format.space_before = Pt(4)
    run = note.add_run('说明：本文档按平台「应用结构」的设计态生成（手工录入 / 扫描导入后的设计口径），'
                       '不代表当前真实数据库；需要与实库核对请在「实库对比」页发起对比。')
    run.font.size = Pt(9)
    run.font.name = '微软雅黑'
    run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
    run.font.color.rgb = RGBColor.from_string('909399')

    # ---------------- 二、表清单 ----------------
    heading('二、表清单（%d 张）' % len(tables))
    list_rows = [['序号', '所属库', '表名', '中文名', '类型', '字段数']]
    for idx, one in enumerate(tables, start=1):
        list_rows.append([idx, _clean(one.get('dbName')), _clean(one.get('objName')),
                          _clean(one.get('objComment')), _clean(one.get('typeLabel')) or '表',
                          len(one.get('cols') or [])])
    if not tables:
        list_rows.append(['（没有可导出的表）', '', '', '', '', ''])
    _add_table(doc, list_rows, (1.4, 5.0, 7.4, 7.4, 2.2, 2.0),
               aligns=('center', 'left', 'left', 'left', 'center', 'center'))

    # ---------------- 三、字段明细 ----------------
    heading('三、字段明细')
    if not tables:
        doc.add_paragraph('（没有可导出的表）')

    col_widths = (1.4, 5.2, 5.2, 3.2, 2.0, 1.4, 4.0, 1.4, 1.4)
    col_aligns = ('center', 'left', 'left', 'left', 'center', 'center', 'left', 'center', 'center')
    for t_idx, one in enumerate(tables, start=1):
        cols = one.get('cols') or []
        comment = _clean(one.get('objComment'))
        heading('%d. %s%s　%d 个字段'
                % (t_idx, _clean(one.get('objName')),
                   ('　' + comment) if comment else '', len(cols)),
                size=11, space_before=12, space_after=4)
        meta_para = doc.add_paragraph()
        meta_para.paragraph_format.space_after = Pt(4)
        run = meta_para.add_run('所属库：%s　对象类型：%s'
                                % (_clean(one.get('dbName')) or '—',
                                   _clean(one.get('typeLabel')) or '表'))
        run.font.size = Pt(9)
        run.font.name = '微软雅黑'
        run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
        run.font.color.rgb = RGBColor.from_string('909399')

        rows = [['序号', '字段名', '中文名', '类型', '长度', '可空', '默认值', '主键', '自增']]
        for c_idx, col in enumerate(cols, start=1):
            rows.append([c_idx, _clean(col.get('colName')), _clean(col.get('colComment')),
                         _clean(col.get('dataType')), _clean(col.get('length')),
                         '是' if col.get('nullable') else '否', _clean(col.get('defaultValue')),
                         _yes(col.get('isPk')), _yes(col.get('isAutoInc'))])
        if not cols:
            rows.append(['（暂无字段）', '', '', '', '', '', '', '', ''])
        _add_table(doc, rows, col_widths, aligns=col_aligns)
        doc.add_paragraph()          # 表与表之间留一点空白，翻页时不会两张表粘在一起

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
