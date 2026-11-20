# -*- coding: utf-8 -*-
"""
report-export-test.py —— 报表导出（PDF / Excel）里「设计区组件」的版式单元测试

  为什么要单独测：区域（box）里的子组件在页面上是绝对定位，导出时如果只按文档流排，
  就会一排排堆下来（错位）。这里用「假 canvas」记录 reportlab 的绘制指令，断言：
    · 区域外框画在组件坐标换算后的位置（px × 0.75 = pt，y 轴翻到左下原点）；
    · 区域内子组件从「区域内容区」（左上角 + padding）开始排；
    · 图表柱子 / 明细表表头都落在各自的组件框里，互不重叠；
    · Excel 版式页按像素格网还原：区域边框、标签合并单元格、原生图表。

运行：<venv python> tools/report-export-test.py
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'server'))
import report_export as rx  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] ' + name)
    else:
        FAIL += 1
        print('  [FAIL] ' + name + ('  → %s' % extra if extra else ''))


def make_result(chart_type='bar'):
    rows = []
    depts = ['内科', '外科', '儿科']
    for i in range(30):
        rows.append(['D%03d' % (i + 1), depts[i % 3], 10 + i, '2026-10-%02d' % (i % 28 + 1)])
    mapped = [
        {'field': 'code', 'label': '工号', 'index': 0, 'width': 100, 'align': 'left',
         'headerAlign': 'center', 'format': 'text', 'summary': 'none', 'visible': True},
        {'field': 'dept', 'label': '科室', 'index': 1, 'width': 120, 'align': 'center',
         'headerAlign': 'center', 'format': 'text', 'summary': 'none', 'visible': True},
        {'field': 'num', 'label': '数量', 'index': 2, 'width': 90, 'align': 'right',
         'headerAlign': 'right', 'format': 'int', 'summary': 'sum', 'visible': True},
        {'field': 'day', 'label': '日期', 'index': 3, 'width': 120, 'align': 'left',
         'headerAlign': 'left', 'format': 'date', 'summary': 'none', 'visible': True},
    ]
    elements = [
        {'id': 'e1', 'kind': 'label', 'x': 10, 'y': 6, 'w': 300, 'h': 28,
         'text': '科室统计（区块标题）', 'fontSize': 18, 'bold': True, 'align': 'left',
         'color': '#C0392B'},
        {'id': 'e2', 'kind': 'line', 'x': 10, 'y': 36, 'w': 520, 'h': 12, 'dir': 'h',
         'thickness': 2, 'color': '#409EFF'},
        {'id': 'e3', 'kind': 'box', 'x': 10, 'y': 54, 'w': 520, 'h': 210, 'border': True,
         'borderColor': '#909399', 'bg': '#FAFAFA', 'radius': 6, 'padding': 10,
         'children': [
             {'id': 'e31', 'kind': 'label', 'x': 0, 'y': 0, 'w': 200, 'h': 24,
              'text': '区域内的说明文字', 'fontSize': 13, 'bold': False, 'align': 'left',
              'color': '#303133'},
             {'id': 'e32', 'kind': 'chart', 'x': 210, 'y': 0, 'w': 290, 'h': 180,
              'chartType': chart_type, 'title': '各科室数量', 'categoryField': 'dept',
              'valueField': 'num', 'legend': True},
             {'id': 'e33', 'kind': 'table', 'x': 0, 'y': 30, 'w': 200, 'h': 160,
              'rows': 3, 'cols': 3, 'headerRow': True, 'align': 'left',
              'cells': [['工号', '姓名', '科室'], ['E01', '张三', '内科'],
                        ['E02', '李四', '外科']]},
         ]},
        {'id': 'e4', 'kind': 'image', 'x': 560, 'y': 54, 'w': 120, 'h': 80,
         'src': 'assets/logo.svg', 'fit': 'contain', 'radius': 0},
    ]
    return {
        'rows': rows, 'columns': ['code', 'dept', 'num', 'day'], 'mapped': mapped,
        'rowCount': len(rows), 'truncated': False,
        'params': [{'name': 'dept', 'label': '科室'}], 'paramValues': {'dept': '内科'},
        'report': {'reportName': '科室统计报表', 'code': 'RPT900'},
        'design': {'title': '科室统计报表', 'subtitle': '版式单元测试', 'footerText': '九豆平台',
                   'zebra': True, 'bordered': True, 'showTitle': True, 'showParams': True,
                   'showSummary': True, 'elements': elements},
        'template': {'paper': 'A4', 'orientation': 'portrait', 'fontSize': 12, 'compact': False,
                     'watermark': '内部资料', 'showPageNo': True, 'showTime': True},
    }


# ---------------------------------------------------------------- 假 canvas ----------------------------------------------------------------
class FakeCanvas(object):
    """只记录绘制指令，用来校验坐标（没有 reportlab canvas 的副作用，跑得也快）"""

    def __init__(self):
        self.ops = []

    def saveState(self):
        pass

    def restoreState(self):
        pass

    def beginPath(self):
        class _Path(object):
            """裁剪路径不记指令（否则每处 clip 都会被当成一个矩形，干扰几何断言）"""

            def rect(self, *a, **kw):
                pass

            def moveTo(self, *a, **kw):
                pass

            def lineTo(self, *a, **kw):
                pass
        return _Path()

    def rect(self, *a, **kw):
        self.ops.append(('rect',) + a)

    roundRect = rect

    def clipPath(self, *a, **kw):
        pass

    def moveTo(self, *a, **kw):
        pass

    def lineTo(self, *a, **kw):
        pass

    def setFillColor(self, *a, **kw):
        pass

    def setStrokeColor(self, *a, **kw):
        pass

    def setLineWidth(self, *a, **kw):
        pass

    def setFont(self, *a, **kw):
        pass

    def drawString(self, *a, **kw):
        self.ops.append(('drawString',) + a)

    drawCentredString = drawString
    drawRightString = drawString

    def line(self, *a, **kw):
        self.ops.append(('line',) + a)

    def circle(self, *a, **kw):
        self.ops.append(('circle',) + a)

    def wedge(self, *a, **kw):
        self.ops.append(('wedge',) + a)

    def drawPath(self, *a, **kw):
        self.ops.append(('drawPath',) + a)


def draw_all(chart_type='bar'):
    res = make_result(chart_type)
    elements = res['design']['elements']
    ctx = {'font': rx._font(), 'cols': rx.visible_columns(res), 'rows': res['rows']}
    k = rx.PX2PT
    right, bottom = rx.design_bounds(elements)
    block_h = (bottom + 2) * k
    canvas = FakeCanvas()
    rx._draw_elements(canvas, elements, ctx, k, block_h)
    return res, canvas, k, block_h


def test_geometry():
    print('\n--- 1. PDF 里的组件坐标（区域 / 子组件 / 图表 / 明细表） ---')
    res, canvas, k, block_h = draw_all()
    rects = [o for o in canvas.ops if o[0] in ('rect', 'roundRect')]
    texts = [o for o in canvas.ops if o[0] in ('drawString', 'drawCentredString', 'drawRightString')]

    check('design_bounds 汇总到组件右下边界', rx.design_bounds(res['design']['elements']) == (680, 264),
          str(rx.design_bounds(res['design']['elements'])))

    boxes = [o for o in rects if abs(o[3] - 520 * k) < 0.01 and abs(o[4] - 210 * k) < 0.01]
    check('区域外框按坐标画出来（含圆角）', len(boxes) == 1, str(boxes[:1]))
    if not boxes:
        return
    bx, by, bw, bh = boxes[0][1], boxes[0][2], boxes[0][3], boxes[0][4]
    check('区域外框位置正确（x=7.5pt / y=block_h-198pt）',
          abs(bx - 7.5) < 0.01 and abs(by - (block_h - 198)) < 0.01, '%.2f %.2f' % (bx, by))

    inner = [t for t in texts if '区域内的说明文字' in str(t[3])]
    check('区域里的文本画出来了', bool(inner))
    if inner:
        check('区域里的子组件从内容区（padding 内缩）起排',
              inner[0][1] >= bx + 10 * k - 0.2 and by <= inner[0][2] <= by + bh,
              '%.2f / 区域 %.2f' % (inner[0][1], bx))
        bold_ops = [t for t in texts if '科室统计（区块标题）' in str(t[3])]
        check('加粗文本用「重描」实现（同位置画了两遍）',
              len(bold_ops) == 2 and abs(bold_ops[0][1] - bold_ops[1][1]) < 0.5,
              str([round(t[1], 1) for t in bold_ops]))

    chart_left = (10 + 10 + 210) * k
    chart_right = chart_left + 290 * k
    bars = [o for o in rects if o[2] > 0 and chart_left - 0.5 <= o[1] <= chart_right]
    check('图表柱子按分类分组（3 个科室 = 3 根）', len(bars) == 3, str(len(bars)))
    check('柱子都在图表框内',
          all(o[1] >= chart_left - 0.5 and o[1] + o[3] <= chart_right + 0.5 for o in bars),
          str(bars[:1]))

    heads = [t for t in texts if str(t[3]) in ('工号', '姓名', '科室')]
    check('表格组件画出了用户填的表头', len(heads) == 3, str([t[3] for t in heads]))
    check('表格在图表左边（不重叠）', all(t[1] < chart_left - 0.5 for t in heads),
          str([round(t[1], 1) for t in heads]))
    body_texts = [t for t in texts if str(t[3]) in ('E01', '张三', '内科', 'E02', '李四', '外科')
                  and t[1] < chart_left]        # 左侧才是表格，右边是图表的分类标签
    check('表格里的单元格内容也画出来了（用户填的值）', len(body_texts) == 6,
          str([t[3] for t in body_texts]))
    check('表格按行列均分（3 行 3 列 → 9 个格子都有内容或空位）',
          len(heads) + len(body_texts) == 9, '%d' % (len(heads) + len(body_texts)))

    placeholder = [t for t in texts if str(t[3]) == '图片']
    check('取不到素材的图片画占位框（居中）', bool(placeholder) and
          abs(placeholder[0][1] - (560 + 60) * k) < 0.6, str(placeholder[:1]))

    for kind in ('line', 'pie'):
        _res, cv, _k, _h = draw_all(kind)
        check('图表类型 %s 也能画出来' % kind,
              len([o for o in cv.ops if o[0] in ('wedge', 'drawPath', 'line')]) > 0)


def test_rowno_and_header():
    print('\n--- 3. 行号（序号列）/ 表格「列头显示否」 ---')
    # 列头显示=否：第 1 行整行丢掉，表头样式也归 False
    el = {'kind': 'table', 'rows': 3, 'cols': 2, 'headerRow': True, 'showHeader': False,
          'cells': [['列1', '列2'], ['A', 'B'], ['C', 'D']]}
    rows, cols, grid, head, align = rx.table_grid(el)
    check('列头显示=否：不返回列头那一行', rows == 2 and grid[0] == ['A', 'B'], str(grid))
    check('列头显示=否：表头样式同步关掉', head is False, str(head))
    el2 = dict(el, showHeader=True)
    rows2, _c2, grid2, head2, _a2 = rx.table_grid(el2)
    check('列头显示=是：3 行都在、首行当表头', rows2 == 3 and head2 is True, str(rows2))
    check('只剩 1 行时列头显示=否也不清空', rx.table_grid(dict(el, rows=1))[0] == 1,
          str(rx.table_grid(dict(el, rows=1))[0]))

    # 导出：showRowNo 时 PDF / Excel 最左多一列序号
    res = make_result()
    res['design']['showRowNo'] = True
    res['design']['elements'] = []
    pdf, _ext, _mime = rx.build(res, 'pdf')
    check('开启行号后导出 PDF 正常', pdf[:5] == b'%PDF-' and len(pdf) > 1000, str(len(pdf)))

    data = rx.build_xlsx(res)
    import io as _io
    from openpyxl import load_workbook
    ws = load_workbook(_io.BytesIO(data)).active
    head_row = 0
    for r in range(1, 8):
        if str(ws.cell(row=r, column=1).value or '') in ('序号', '工号'):
            head_row = r
            break
    check('Excel 表头第一列是「序号」', str(ws.cell(row=head_row, column=1).value) == '序号',
          str(ws.cell(row=head_row, column=1).value))
    check('Excel 第二列仍是原来的「工号」',
          str(ws.cell(row=head_row, column=2).value) == '工号',
          str(ws.cell(row=head_row, column=2).value))
    check('Excel 序号列从 1 开始递增',
          ws.cell(row=head_row + 1, column=1).value == 1 and
          ws.cell(row=head_row + 3, column=1).value == 3,
          '%s / %s' % (ws.cell(row=head_row + 1, column=1).value,
                       ws.cell(row=head_row + 3, column=1).value))
    res['design']['showRowNo'] = False
    ws2 = load_workbook(_io.BytesIO(rx.build_xlsx(res))).active
    check('关掉行号后表头第一列回到「工号」',
          str(ws2.cell(row=head_row, column=1).value) == '工号',
          str(ws2.cell(row=head_row, column=1).value))


def test_excel_layout():
    print('\n--- 2. Excel 版式页（区域 / 标签 / 原生图表 / 合并单元格） ---')
    res = make_result()
    data = rx.build_xlsx(res)
    check('导出 Excel 是真正的 zip（PK 头）', data[:2] == b'PK', str(data[:4]))
    import io as _io
    zf = zipfile.ZipFile(_io.BytesIO(data))
    names = zf.namelist()
    wb = zf.read('xl/workbook.xml').decode('utf-8')
    check('工作簿里多了「报表版式」页', '报表版式' in wb, wb[:110])
    check('版式页里有原生图表', any(one.startswith('xl/charts/') for one in names),
          str(names)[:160])
    sheet2 = zf.read('xl/worksheets/sheet2.xml').decode('utf-8')
    check('版式页按组件合并了单元格', '<mergeCell ' in sheet2, str(len(sheet2)))
    zf.close()

    from openpyxl import load_workbook
    ws = load_workbook(_io.BytesIO(data))['报表版式']
    res2 = make_result()
    span_ctx = {'cols': rx.visible_columns(res2), 'rows': res2['rows'],
                'n_cols': ws.max_column, 'n_rows': ws.max_row}
    r1, c1, _r2, _c2 = rx._layout_span(span_ctx, 10, 54, 520, 210)   # 区域 x=10 y=54 w=520 h=210
    cell = ws.cell(row=r1, column=c1)
    check('区域左上角有边框（左 / 上）',
          cell.border.left is not None and cell.border.top is not None,
          'R%dC%d' % (r1, c1))
    check('区域底色写在单元格填充上', str(cell.fill.fgColor.rgb).endswith('FAFAFA'),
          str(cell.fill.fgColor.rgb))
    texts = [str(one.value) for row in ws.iter_rows() for one in row if one.value not in (None, '')]
    check('区域里有子组件的内容（区域内文字 / 表格）',
          any('区域内的说明文字' in one for one in texts) and
          any(one in ('工号', '姓名', '科室') for one in texts), str(texts)[:140])
    check('表格的表头 / 数据没被上面的标签整行吞掉（格网够细）',
          sum(1 for one in texts if one in ('工号', '姓名', '科室')) >= 2 and
          any(one in ('张三', '李四') for one in texts),
          str([one for one in texts if one in ('工号', '姓名', '科室', '张三', '李四')]))
    check('版式页挂上了图表对象', len(ws._charts) >= 1, str(len(ws._charts)))


def main():
    print('== 报表导出 · 设计区组件版式 ==')
    test_geometry()
    test_excel_layout()
    test_rowno_and_header()
    print('\n结果：通过 %d 项，失败 %d 项' % (PASS, FAIL))
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
