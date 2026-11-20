# -*- coding: utf-8 -*-
"""
数据中心 · 报表导出（Excel / PDF）

报表查看弹窗里的「导出 Excel」「导出 PDF」都是**导出全部查询结果**：
  · service 层按 config.REPORT_EXPORT_ROWS 重新查一次（不是页面上那 500 行预览），
    再把 result 交给这里生成文件；
  · 两套文件都按报表定义渲染：标题 / 副标题 / 参数说明 / 表头（列显示名）/ 数据行 /
    汇总行（列属性里的求和、平均、计数…）/ 页脚文字 + 页码（PDF）。

依赖：openpyxl（.xlsx）、reportlab（.pdf）。缺依赖时抛 ExportError，由 service 转成业务提示，
不影响其它功能（打印是浏览器本地完成，不依赖这两个库）。
"""
import base64
import datetime
import io
import json
import math
import os
import re
import threading
import urllib.parse
import urllib.request

MIN_FONT = 7
MAX_FONT = 10
PDF_MAX_ROWS = 10000          # PDF 用 Paragraph 排版，行数太多会很慢，超出的提示改用 Excel
PX2PT = 0.75                  # 设计区坐标是 CSS px（96dpi），PDF 用 pt（72dpi）
WEB_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CHART_COLORS = ('#409EFF', '#67C23A', '#E6A23C', '#F56C6C', '#909399',
                '#9B59B6', '#00B4D8', '#FF9F43')


class ExportError(Exception):
    """导出失败（缺依赖 / 数据太大 / 生成异常），message 直接给前端看"""

    def __init__(self, message):
        Exception.__init__(self, message)
        self.message = message


# ---------------------------------------------------------------- 公共部分 ----------------------------------------------------------------
def _design_of(result):
    design = (result or {}).get('design') or {}
    return {
        'title': str(design.get('title') or ''),
        'subtitle': str(design.get('subtitle') or ''),
        'footerText': str(design.get('footerText') or ''),
        'zebra': bool(design.get('zebra', True)),
        'bordered': bool(design.get('bordered', True)),
        'showTitle': bool(design.get('showTitle', True)),
        'showParams': bool(design.get('showParams', True)),
        'showSummary': bool(design.get('showSummary', True)),
        'showRowNo': bool(design.get('showRowNo', False)),      # 数据表最左侧序号列
        'headerText': str(design.get('headerText') or ''),
        'headerAlign': _align_of(design.get('headerAlign'), 'left'),
        'footerAlign': _align_of(design.get('footerAlign'), 'center'),
    }


def _template_of(result):
    tpl = (result or {}).get('template') or {}
    return {
        'paper': str(tpl.get('paper') or 'A4'),
        'orientation': str(tpl.get('orientation') or 'portrait'),
        'marginTop': int(tpl.get('marginTop') or 12),
        'marginRight': int(tpl.get('marginRight') or 10),
        'marginBottom': int(tpl.get('marginBottom') or 12),
        'marginLeft': int(tpl.get('marginLeft') or 10),
        'fontSize': int(tpl.get('fontSize') or 12),
        'fontFamily': str(tpl.get('fontFamily') or 'Microsoft YaHei'),
        'titleSize': int(tpl.get('titleSize') or 18),
        'titleAlign': str(tpl.get('titleAlign') or 'center'),
        'titleBold': bool(tpl.get('titleBold', True)),
        'compact': bool(tpl.get('compact', False)),
        'showPageNo': bool(tpl.get('showPageNo', True)),
        'showTime': bool(tpl.get('showTime', True)),
        'watermark': str(tpl.get('watermark') or ''),
        'headerLogo': str(tpl.get('headerLogo') or ''),
        'footerLogo': str(tpl.get('footerLogo') or ''),
        'headerLogoHeight': int(tpl.get('headerLogoHeight') or 32),
        'footerLogoHeight': int(tpl.get('footerLogoHeight') or 28),
        'headerLogoPos': 'right' if str(tpl.get('headerLogoPos')) == 'right' else 'left',
        'footerLogoPos': 'right' if str(tpl.get('footerLogoPos')) == 'right' else 'left',
    }


def _align_of(value, default='left'):
    text = str(value or '').lower()
    return text if text in ('left', 'center', 'right') else default


def visible_columns(result):
    """可见列（列定义里 visible=false 的不导出）"""
    out = []
    for one in (result or {}).get('mapped') or []:
        if not isinstance(one, dict):
            continue
        if one.get('visible') is False:
            continue
        out.append(one)
    return out


def format_value(value, fmt):
    """与前端 formatValue 保持一致的显示口径"""
    if value is None:
        return ''
    text = value if isinstance(value, str) else str(value)
    if text == '':
        return ''
    fmt = (fmt or 'text').lower()
    if fmt == 'text':
        return text
    try:
        num = float(text)
    except (TypeError, ValueError):
        return text
    if fmt == 'int':
        return str(int(round(num)))
    if fmt == 'number':
        return '%.2f' % num
    if fmt == 'money':
        return '￥%.2f' % num
    if fmt == 'percent':
        return '%.2f%%' % (num * 100)
    if fmt == 'date':
        return text[:10]
    if fmt == 'datetime':
        return text[:19]
    return text


def raw_number(value):
    """Excel 里能存成数字的值（存不了就给原始文本）"""
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    try:
        text = str(value).strip()
        if text == '':
            return None
        return float(text)
    except (TypeError, ValueError):
        return str(value)


def summary_value(rows, index, kind):
    if index is None or index < 0:
        return ''
    kind = (kind or 'none').lower()
    if kind == 'count':
        return len(rows)
    nums = []
    for row in rows:
        try:
            if index < len(row) and str(row[index]).strip() != '':
                nums.append(float(row[index]))
        except (TypeError, ValueError):
            continue
    if not nums:
        return ''
    if kind == 'sum':
        return sum(nums)
    if kind == 'avg':
        return sum(nums) / float(len(nums))
    if kind == 'max':
        return max(nums)
    if kind == 'min':
        return min(nums)
    return ''


def params_line(result):
    """参数说明：工号=E0001　科室=内科（没填值的不列）"""
    params = (result or {}).get('params') or []
    values = (result or {}).get('paramValues') or {}
    parts = []
    for one in params:
        if not isinstance(one, dict):
            continue
        name = str(one.get('name') or '')
        if not name:
            continue
        value = values.get(name)
        if value is None or str(value).strip() == '':
            continue
        parts.append('%s=%s' % (one.get('label') or name, value))
    return '　'.join(parts)


def safe_name(text, fallback='report'):
    """文件名：去掉 Windows 不允许的字符"""
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', '_', str(text or '')).strip()
    return (name or fallback)[:60]


def suggested_filename(result, ext):
    report = (result or {}).get('report') or {}
    name = report.get('reportName') or _design_of(result).get('title') or '报表'
    code = report.get('code') or ''
    stamp = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
    return '%s%s_%s.%s' % (safe_name(name, '报表'), ('_' + code) if code else '', stamp, ext)


# ------------------------------------------------------ 设计区组件（工具箱：文本/线条/区域/图像/图表/明细表） ------------------------------------------------------
# 前端 elementHtml() 用绝对定位按坐标摆放，预览 / 打印 / 导出必须走同一套坐标，
# 否则「区域」里的子组件会散开、和页面上看到的版面对不上。这里把同一份 elements 在
# PDF（画布绘制）与 Excel（单元格版式页）里重画一遍：
#   · 缩放：画布宽度 = 组件占用范围（design_bounds），超过可打印宽度就整体等比缩小（与前端 stageScale 一致）；
#   · 坐标：区域（box）的子组件相对「区域内容区」（左上角 + padding）定位，可以再嵌一层。
def _int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _flag(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


def _hex(color, default='#DCDFE6'):
    """颜色只认 #RGB / #RRGGBB / #RRGGBBAA（与后端 _clean_element 的白名单一致）"""
    text = str(color or '').strip()
    if not re.match(r'^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$', text):
        return default
    if len(text) == 9:
        text = text[:7]
    if len(text) == 4:
        text = '#' + ''.join([ch * 2 for ch in text[1:]])
    return text.upper()


def elements_of(result):
    """设计区组件列表（design.elements）"""
    design = (result or {}).get('design') or {}
    items = design.get('elements')
    if isinstance(items, str):
        try:
            items = json.loads(items or '[]')
        except ValueError:
            items = []
    return items if isinstance(items, list) else []


def design_bounds(elements, ox=0, oy=0):
    """组件占用范围（像素）：返回 (right, bottom)，区域里嵌的子组件也一起算"""
    right = bottom = 0
    for el in elements or []:
        if not isinstance(el, dict):
            continue
        x = ox + _int(el.get('x'))
        y = oy + _int(el.get('y'))
        w = max(20, _int(el.get('w'), 120))
        h = max(10, _int(el.get('h'), 32))
        right = max(right, x + w)
        bottom = max(bottom, y + h)
        if el.get('kind') == 'box' and el.get('children'):
            pad = max(0, _int(el.get('padding'), 8))
            inner_r, inner_b = design_bounds(el.get('children'), x + pad, y + pad)
            right = max(right, inner_r + pad)
            bottom = max(bottom, inner_b + pad)
    return right, bottom


def chart_points(el, cols, rows):
    """图表数据：按分类字段分组、对数值字段求和（与前端 chartPoints 同一口径）"""
    cat_field = str(el.get('categoryField') or '')
    val_field = str(el.get('valueField') or '')
    cat_idx = val_idx = -1
    for i, col in enumerate(cols or []):
        if cat_field and col.get('field') == cat_field:
            cat_idx = i
        if val_field and col.get('field') == val_field:
            val_idx = i
    if cat_idx < 0 and cols:
        cat_idx = 0
    if val_idx < 0:
        val_idx = 1 if len(cols or []) > 1 else 0
    order, agg = [], {}
    for row in (rows or [])[:5000]:
        label = ''
        if cat_idx >= 0:
            pos = _int((cols[cat_idx] or {}).get('index'), -1)
            if 0 <= pos < len(row) and row[pos] is not None:
                label = str(row[pos])
        if not label:
            label = '（空）'
        try:
            pos2 = _int((cols[val_idx] or {}).get('index'), -1) if cols else -1
            num = float(row[pos2]) if 0 <= pos2 < len(row) and str(row[pos2]).strip() != '' else 1.0
        except (TypeError, ValueError):
            num = 1.0
        if label not in agg:
            agg[label] = 0.0
            order.append(label)
        agg[label] += num
    return [{'label': key, 'value': agg[key]} for key in order[:12]]


def _image_reader(src):
    """组件里的图片 → reportlab Image（读不到就返回 None，画个占位框）"""
    from reportlab.platypus import Image as RLImage
    text = str(src or '').strip()
    if not text:
        return None
    try:
        if text.startswith('data:image/'):
            head, _, body = text.partition(',')
            raw = base64.b64decode(body) if 'base64' in head else urllib.parse.unquote_to_bytes(body)
            return RLImage(io.BytesIO(raw))
        if text.startswith('http://') or text.startswith('https://'):
            req = urllib.request.Request(text, headers={'User-Agent': 'menu-admin-report'})
            resp = urllib.request.urlopen(req, timeout=4)
            try:
                return RLImage(io.BytesIO(resp.read(4 * 1024 * 1024)))
            finally:
                resp.close()
        rel = text.split('?')[0].split('#')[0].lstrip('/')
        path = os.path.normpath(os.path.join(WEB_ROOT, rel))
        if not path.startswith(WEB_ROOT) or not os.path.isfile(path):
            return None
        if path.lower().endswith('.svg'):        # reportlab 画不了 svg（要 svglib），按占位处理
            return None
        return RLImage(path)
    except Exception:
        return None


def _wrap_text(text, font, size, max_width):
    """按字符折行（中文没有空格，只能逐字量宽度）"""
    from reportlab.pdfbase import pdfmetrics
    lines = []
    for para in str(text if text is not None else '').split('\n'):
        cur = ''
        for ch in para:
            if pdfmetrics.stringWidth(cur + ch, font, size) <= max_width or not cur:
                cur += ch
            else:
                lines.append(cur)
                cur = ch
        lines.append(cur)
    return lines or ['']


def _clip_text(text, font, size, max_width):
    """单行截断（表格单元格用）"""
    from reportlab.pdfbase import pdfmetrics
    text = str(text if text is not None else '')
    if not text:
        return ''
    if pdfmetrics.stringWidth(text, font, size) <= max_width:
        return text
    out = ''
    for ch in text:
        if pdfmetrics.stringWidth(out + ch + '…', font, size) > max_width:
            break
        out += ch
    return out + '…'


def _draw_elements(canvas, elements, ctx, k, block_h, ox=0, oy=0):
    for el in elements or []:
        _draw_element(canvas, el, ctx, k, block_h, ox, oy)


def _draw_element(canvas, el, ctx, k, block_h, ox=0, oy=0):
    """一个组件：坐标 → PDF 坐标（原点左下，y 轴朝上）后逐个绘制"""
    from reportlab.lib.colors import HexColor
    if not isinstance(el, dict):
        return
    kind = el.get('kind')
    if kind not in ('label', 'line', 'box', 'image', 'chart', 'table'):
        return
    font = ctx['font']
    x = ox + _int(el.get('x'))
    y = oy + _int(el.get('y'))
    w = max(20, _int(el.get('w'), 120))
    h = max(10, _int(el.get('h'), 32))
    left = x * k
    width = w * k
    height = h * k
    bottom = block_h - (y + h) * k

    def clip_box():
        path = canvas.beginPath()
        path.rect(left, bottom, width, height)
        canvas.clipPath(path, stroke=0, fill=0)

    canvas.saveState()
    try:
        if kind == 'box':
            bg = _hex(el.get('bg'), '')
            has_border = _flag(el.get('border'), True)
            radius = max(0, _int(el.get('radius'), 4)) * k
            if bg:
                canvas.setFillColor(HexColor(bg))
            if has_border:
                canvas.setStrokeColor(HexColor(_hex(el.get('borderColor'), '#DCDFE6')))
                canvas.setLineWidth(max(0.3, k))
            if bg or has_border:
                if radius > 0.5:
                    canvas.roundRect(left, bottom, width, height, radius,
                                     stroke=1 if has_border else 0, fill=1 if bg else 0)
                else:
                    canvas.rect(left, bottom, width, height,
                                stroke=1 if has_border else 0, fill=1 if bg else 0)
            pad = max(0, _int(el.get('padding'), 8))
            _draw_elements(canvas, el.get('children') or [], ctx, k, block_h, x + pad, y + pad)
        elif kind == 'label':
            clip_box()
            size = max(3.2, _int(el.get('fontSize'), 14) * k)
            lines = _wrap_text(el.get('text') or '', font, size, max(4.0, width - 1))
            leading = size * 1.45
            total = leading * len(lines)
            top = bottom + height - max(0.0, (height - total) / 2.0)
            align = str(el.get('align') or 'left')
            canvas.setFillColor(HexColor(_hex(el.get('color'), '#303133')))
            canvas.setFont(font, size)
            bold = _flag(el.get('bold'), False)
            for idx, line in enumerate(lines):
                if not line:
                    continue
                baseline = top - size * 0.95 - idx * leading
                for shift in ((0, max(0.2, 0.32 * k)) if bold else (0,)):
                    if align == 'center':
                        canvas.drawCentredString(left + width / 2.0 + shift, baseline, line)
                    elif align == 'right':
                        canvas.drawRightString(left + width - 0.6 + shift, baseline, line)
                    else:
                        canvas.drawString(left + 0.6 + shift, baseline, line)
        elif kind == 'line':
            thickness = max(0.4, _int(el.get('thickness'), 1) * k)
            canvas.setStrokeColor(HexColor(_hex(el.get('color'), '#DCDFE6')))
            canvas.setLineWidth(thickness)
            if str(el.get('dir') or 'h') == 'v':
                canvas.line(left + width / 2.0, bottom, left + width / 2.0, bottom + height)
            else:
                canvas.line(left, bottom + height / 2.0, left + width, bottom + height / 2.0)
        elif kind == 'image':
            clip_box()
            img = _image_reader(el.get('src'))
            if img is None:
                canvas.setFillColor(HexColor('#F5F7FA'))
                canvas.rect(left, bottom, width, height, stroke=0, fill=1)
                canvas.setFillColor(HexColor('#A8ABB2'))
                canvas.setFont(font, max(3.6, 8 * k))
                canvas.drawCentredString(left + width / 2.0, bottom + height / 2.0 - 3 * k, '图片')
            else:
                img_w = float(getattr(img, 'imageWidth', 0) or 1) or 1.0
                img_h = float(getattr(img, 'imageHeight', 0) or 1) or 1.0
                fit = str(el.get('fit') or 'contain')
                if fit == 'fill':
                    draw_w, draw_h = width, height
                else:
                    ratio = (max if fit == 'cover' else min)(width / img_w, height / img_h)
                    draw_w, draw_h = img_w * ratio, img_h * ratio
                img.drawWidth = max(1.0, draw_w)
                img.drawHeight = max(1.0, draw_h)
                img.drawOn(canvas, left + (width - draw_w) / 2.0, bottom + (height - draw_h) / 2.0)
        elif kind == 'chart':
            clip_box()
            title = str(el.get('title') or '')
            top_pad = 0.0
            if title:
                canvas.setFillColor(HexColor('#303133'))
                canvas.setFont(font, max(3.6, 11 * k))
                canvas.drawString(left + 4 * k, bottom + height - 13 * k, title[:40])
                top_pad = min(height * 0.4, 20 * k)
            _draw_chart(canvas, el, ctx, left, bottom, width, height - top_pad)
        elif kind == 'table':
            clip_box()
            _draw_table_el(canvas, el, ctx, left, bottom, width, height)
    finally:
        canvas.restoreState()


def _draw_chart(canvas, el, ctx, left, bottom, width, height, title_h=0):
    from reportlab.lib.colors import HexColor
    font = ctx['font']
    pts = chart_points(el, ctx['cols'], ctx['rows'])
    if not pts or width < 8 or height < 8:
        canvas.setFillColor(HexColor('#909399'))
        canvas.setFont(font, max(3.2, 5.4))
        canvas.drawCentredString(left + width / 2.0, bottom + height / 2.0, '没有数据')
        return
    total = sum(p['value'] for p in pts) or 1.0
    peak = max(p['value'] for p in pts) or 1.0
    kind = str(el.get('chartType') or 'bar')
    label_size = max(3.0, min(6.0, height * 0.055 + 2.4))

    if kind == 'pie':
        radius = max(4.0, min(width * 0.36, height * 0.42))
        cx = left + min(width * 0.36, width / 2.0)
        cy = bottom + height / 2.0
        start = 90.0
        for i, one in enumerate(pts):
            extent = -360.0 * (one['value'] / total)
            canvas.setFillColor(HexColor(CHART_COLORS[i % len(CHART_COLORS)]))
            canvas.setStrokeColor(HexColor('#FFFFFF'))
            canvas.setLineWidth(0.4)
            canvas.wedge(cx - radius, cy - radius, cx + radius, cy + radius,
                         start, extent, stroke=1, fill=1)
            start += extent
        if _flag(el.get('legend'), True):
            canvas.setFont(font, label_size)
            for i, one in enumerate(pts[:8]):
                ly = bottom + height - 8 - i * (label_size + 4.0)
                if ly < bottom:
                    break
                canvas.setFillColor(HexColor(CHART_COLORS[i % len(CHART_COLORS)]))
                canvas.rect(left + width * 0.68, ly - 1, label_size, label_size, stroke=0, fill=1)
                canvas.setFillColor(HexColor('#606266'))
                canvas.drawString(left + width * 0.68 + label_size + 3, ly - 1,
                                  str(one['label'])[:6])
        return

    pad_left = min(max(10.0, 30 * (height / 200.0) + 6), width * 0.3)
    pad_right, pad_top, pad_bottom = 4.0, 4.0, label_size + 4.0
    inner_w = max(6.0, width - pad_left - pad_right)
    inner_h = max(6.0, height - pad_top - pad_bottom)
    base_y = bottom + pad_bottom
    canvas.setStrokeColor(HexColor('#E4E7ED'))
    canvas.setLineWidth(0.4)
    canvas.line(left + pad_left, base_y, left + pad_left + inner_w, base_y)

    slot = inner_w / max(1, len(pts))
    if kind == 'line':
        canvas.setStrokeColor(HexColor('#409EFF'))
        canvas.setLineWidth(max(0.5, 1.6))
        path = canvas.beginPath()
        for i, one in enumerate(pts):
            px = left + pad_left + (i * slot + slot / 2.0 if len(pts) > 1 else inner_w / 2.0)
            py = base_y + inner_h * (one['value'] / peak)
            if i == 0:
                path.moveTo(px, py)
            else:
                path.lineTo(px, py)
        canvas.drawPath(path, stroke=1, fill=0)
        canvas.setFillColor(HexColor('#409EFF'))
        for i, one in enumerate(pts):
            px = left + pad_left + (i * slot + slot / 2.0 if len(pts) > 1 else inner_w / 2.0)
            py = base_y + inner_h * (one['value'] / peak)
            canvas.circle(px, py, 1.6, stroke=0, fill=1)
    else:
        bar_w = max(2.0, min(38.0, slot * 0.6))
        for i, one in enumerate(pts):
            bar_h = max(0.5, inner_h * (one['value'] / peak))
            canvas.setFillColor(HexColor(CHART_COLORS[i % len(CHART_COLORS)]))
            canvas.rect(left + pad_left + slot * i + (slot - bar_w) / 2.0, base_y,
                        bar_w, bar_h, stroke=0, fill=1)

    canvas.setFont(font, label_size)
    canvas.setFillColor(HexColor('#909399'))
    for i, one in enumerate(pts):
        canvas.drawCentredString(left + pad_left + slot * i + slot / 2.0, bottom + 1.0,
                                 str(one['label'])[:4])


TABLE_MAX_ROWS = 30          # 表格组件的行 / 列上限（与 service.TABLE_MAX_* / 前端同一套）
TABLE_MAX_COLS = 10


def table_grid(el):
    """
    表格组件 → (rows, cols, cells, headerRow, align)
      · 把稀疏 / 越界的 cells 补齐成 rows × cols；
      · showHeader=False（列头显示否）时，第 1 行整行丢掉，同时 headerRow 归 False。
    """
    rows = max(1, min(TABLE_MAX_ROWS, _int(el.get('rows'), 3)))
    cols = max(1, min(TABLE_MAX_COLS, _int(el.get('cols'), 3)))
    src = el.get('cells')
    if not isinstance(src, (list, tuple)):
        src = []
    grid = []
    for r in range(rows):
        line = src[r] if r < len(src) and isinstance(src[r], (list, tuple)) else []
        grid.append([str(line[c]) if c < len(line) and line[c] is not None else ''
                     for c in range(cols)])
    head = _flag(el.get('headerRow'), True)
    if not _flag(el.get('showHeader'), True) and rows > 1:
        grid = grid[1:]
        head = False
    return len(grid), cols, grid, head, str(el.get('align') or 'left')


def _draw_table_el(canvas, el, ctx, left, bottom, width, height):
    """表格组件：行 / 列 / 单元格内容都由用户在组件属性里填，这里按格网均分画出来"""
    from reportlab.lib.colors import HexColor
    font = ctx['font']
    rows, cols, grid, head, align = table_grid(el)
    if width < 6 or height < 4:
        return
    size = max(2.6, min(9.0, 12 * (width / 500.0) + 1.6))
    col_w = width / float(cols)
    row_h = height / float(rows)

    if head:
        canvas.setFillColor(HexColor('#F2F6FC'))
        canvas.rect(left, bottom + height - row_h, width, row_h, stroke=0, fill=1)
    canvas.setStrokeColor(HexColor('#DCDFE6'))
    canvas.setLineWidth(0.4)
    canvas.rect(left, bottom, width, height, stroke=1, fill=0)
    canvas.setStrokeColor(HexColor('#EBEEF5'))
    canvas.setLineWidth(0.3)
    for r in range(1, rows):
        y = bottom + height - row_h * r
        canvas.line(left, y, left + width, y)
    for c in range(1, cols):
        x = left + col_w * c
        canvas.line(x, bottom, x, bottom + height)

    if row_h < 4.0:                              # 行太密就不画字了，避免糊成一片
        return
    canvas.setFont(font, size)
    for r in range(rows):
        y0 = bottom + height - row_h * (r + 1)
        is_head = head and r == 0
        canvas.setFillColor(HexColor('#303133' if is_head else '#606266'))
        for c in range(cols):
            text = _clip_text(grid[r][c], font, size, max(4.0, col_w - 4))
            _cell_text(canvas, text, font, size, left + col_w * c, y0, col_w, row_h,
                       'center' if is_head else align)


def _cell_text(canvas, text, font, size, x, y0, width, height, align):
    if not text:
        return
    baseline = y0 + (height - size) / 2.0 + size * 0.18
    if align == 'center':
        canvas.drawCentredString(x + width / 2.0, baseline, text)
    elif align == 'right':
        canvas.drawRightString(x + width - 2, baseline, text)
    else:
        canvas.drawString(x + 2, baseline, text)


# ---------------------------------------------------------------- Excel ----------------------------------------------------------------
def build_xlsx(result):
    """生成 .xlsx（全部行）：返回 bytes；缺 openpyxl 时抛 ExportError"""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
        from openpyxl.utils import get_column_letter
    except Exception:
        raise ExportError('服务器未安装 openpyxl，无法导出 Excel（pip install openpyxl）')

    design = _design_of(result)
    tpl = _template_of(result)
    cols = visible_columns(result)
    if not cols:
        raise ExportError('这张报表没有可见的列，先在设计器里把列设为显示再导出')
    if design.get('showRowNo'):                  # 行号：最左侧插一列自动递增的序号
        cols = [{'_serial': True, 'field': '__no', 'label': '序号', 'width': 56,
                 'align': 'center', 'headerAlign': 'center', 'format': 'int',
                 'summary': 'none', 'visible': True, 'index': -1}] + cols
    rows = (result or {}).get('rows') or []
    report = (result or {}).get('report') or {}
    title = report.get('reportName') or design.get('title') or '报表'

    wb = Workbook()
    ws = wb.active
    ws.title = re.sub(r'[\[\]:*?/\\]', '_', title)[:28] or '报表'

    last_col = len(cols)
    thin = Side(style='thin', color='DCDFE6')
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    # 标题 / 副标题 / 参数说明
    head_row = 1
    if design.get('showTitle'):
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=last_col)
        cell = ws.cell(row=1, column=1, value=title)
        cell.font = Font(name='微软雅黑', size=14, bold=True)
        cell.alignment = Alignment(horizontal=tpl.get('titleAlign') if tpl.get('titleAlign') in
                                   ('left', 'center', 'right') else 'center', vertical='center')
        ws.row_dimensions[1].height = 26
        head_row = 2
    if design.get('subtitle'):
        ws.merge_cells(start_row=head_row, start_column=1, end_row=head_row, end_column=last_col)
        cell = ws.cell(row=head_row, column=1, value=design.get('subtitle'))
        cell.font = Font(name='微软雅黑', size=9, color='909399')
        cell.alignment = Alignment(horizontal='center', vertical='center')
        head_row += 1
    if design.get('showParams'):
        line = params_line(result)
        if line:
            ws.merge_cells(start_row=head_row, start_column=1, end_row=head_row, end_column=last_col)
            cell = ws.cell(row=head_row, column=1, value='参数：' + line)
            cell.font = Font(name='微软雅黑', size=9, color='606266')
            head_row += 1

    # 表头
    header_row = head_row
    for idx, col in enumerate(cols, start=1):
        cell = ws.cell(row=header_row, column=idx, value=str(col.get('label') or col.get('field') or ''))
        cell.font = Font(name='微软雅黑', size=10, bold=True)
        cell.fill = PatternFill('solid', fgColor='F2F6FC')
        cell.alignment = Alignment(horizontal=_align_of(col.get('headerAlign'), 'center'),
                                   vertical='center', wrap_text=True)
        cell.border = border
    ws.row_dimensions[header_row].height = 22

    # 数据行
    for r_idx, row in enumerate(rows, start=header_row + 1):
        for c_idx, col in enumerate(cols, start=1):
            if col.get('_serial'):                # 序号列：1、2、3…
                cell = ws.cell(row=r_idx, column=c_idx, value=r_idx - header_row)
                cell.number_format = '0'
                cell.font = Font(name='微软雅黑', size=10)
                cell.alignment = Alignment(horizontal='center', vertical='center')
                cell.border = border
                continue
            pos = col.get('index')
            try:
                pos = int(pos)
            except (TypeError, ValueError):
                pos = -1
            value = row[pos] if 0 <= pos < len(row) else ''
            fmt = str(col.get('format') or 'text').lower()
            cell = ws.cell(row=r_idx, column=c_idx)
            if fmt in ('int', 'number', 'money', 'percent'):
                num = raw_number(value)
                cell.value = num
                if isinstance(num, float):
                    cell.number_format = {'int': '0', 'number': '0.00',
                                          'money': '¥#,##0.00', 'percent': '0.00%'}[fmt]
                elif isinstance(num, int):
                    cell.number_format = '0'
            else:
                cell.value = '' if value is None else str(value)
                cell.number_format = '@'
            cell.font = Font(name='微软雅黑', size=10)
            cell.alignment = Alignment(horizontal=str(col.get('align') or 'left') if
                                       str(col.get('align')) in ('left', 'center', 'right') else 'left',
                                       vertical='center', wrap_text=False)
            cell.border = border

    # 汇总行
    if design.get('showSummary'):
        picked = [(i, c) for i, c in enumerate(cols) if str(c.get('summary') or 'none') != 'none']
        if picked:
            srow = header_row + len(rows) + 1
            for c_idx in range(1, last_col + 1):
                ws.cell(row=srow, column=c_idx).border = border
                ws.cell(row=srow, column=c_idx).fill = PatternFill('solid', fgColor='F5F7FA')
            for i, col in picked:
                pos = col.get('index')
                try:
                    pos = int(pos)
                except (TypeError, ValueError):
                    pos = -1
                value = summary_value(rows, pos, col.get('summary'))
                cell = ws.cell(row=srow, column=i + 1, value=value if value != '' else None)
                cell.font = Font(name='微软雅黑', size=10, bold=True)
                cell.alignment = Alignment(horizontal='center', vertical='center')

    # 列宽（按设计里的像素宽换算成字符宽）
    for idx, col in enumerate(cols, start=1):
        try:
            px = int(col.get('width') or 120)
        except (TypeError, ValueError):
            px = 120
        ws.column_dimensions[get_column_letter(idx)].width = max(8, min(60, round(px / 7.0, 1)))

    ws.freeze_panes = ws.cell(row=header_row + 1, column=1)

    # 设计区组件：Excel 里没有自由画布，单独放一页「报表版式」，按像素格网还原区域与组件的位置
    elements = elements_of(result)
    if elements:
        try:
            _write_layout_sheet(wb, result, elements, title)
        except Exception:                      # 版式页尽量不影响数据页导出
            pass

    buf = io.BytesIO()
    wb.save(buf)
    data = buf.getvalue()
    buf.close()
    if not data:
        raise ExportError('Excel 生成失败：没有内容')
    return data


# ---------------------------------------------------------------- Excel：版式页 ----------------------------------------------------------------
LAYOUT_COL_PX = 32.0          # 版式页每列约 32px（列宽 4.2 字符）
LAYOUT_ROW_PX = 10.0          # 版式页每行 7.5pt ≈ 10px
# 格网越细，组件之间的重叠越少（粗格网时「说明文字」这种 26px 高的组件会吃掉下一行的表头）


def _layout_span(ctx, x, y, w, h):
    """像素坐标 → 版式页的单元格范围 (r1, c1, r2, c2)"""
    c1 = int(x // LAYOUT_COL_PX) + 1
    c2 = max(c1, int(math.ceil((x + w) / LAYOUT_COL_PX)))
    r1 = int(y // LAYOUT_ROW_PX) + 1
    r2 = max(r1, int(math.ceil((y + h) / LAYOUT_ROW_PX)))
    r1 = max(1, min(ctx['n_rows'], r1))
    r2 = max(r1, min(ctx['n_rows'], r2))
    c1 = max(1, min(ctx['n_cols'], c1))
    c2 = max(c1, min(ctx['n_cols'], c2))
    return r1, c1, r2, c2


def _layout_merge(ws, r1, c1, r2, c2):
    if r2 > r1 or c2 > c1:
        try:
            ws.merge_cells(start_row=r1, start_column=c1, end_row=r2, end_column=c2)
        except Exception:
            pass


def _layout_cell(ws, row, col, value=None):
    """取单元格；落在合并区里的「从属单元格」是只读的，直接跳过"""
    cell = ws.cell(row=row, column=col)
    if cell.__class__.__name__ == 'MergedCell':
        return None
    if value is not None:
        cell.value = value
    return cell


def _layout_border(ws, r1, c1, r2, c2, color='DCDFE6', style='thin'):
    from openpyxl.styles import Border, Side
    side = Side(style=style, color=color)
    for r in range(r1, r2 + 1):
        for c in range(c1, c2 + 1):
            cell = ws.cell(row=r, column=c)
            cell.border = Border(left=side if c == c1 else None,
                                 right=side if c == c2 else None,
                                 top=side if r == r1 else None,
                                 bottom=side if r == r2 else None)


def _write_layout_sheet(wb, result, elements, title):
    """Excel 里没有自由画布：单独开一页「报表版式」，按像素格网把区域 / 组件摆回去"""
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    ws = wb.create_sheet('报表版式')
    ws.sheet_properties.tabColor = '409EFF'
    try:
        ws.sheet_view.showGridLines = False
    except Exception:
        pass
    right, bottom = design_bounds(elements)
    n_cols = max(1, min(160, int(math.ceil((right + 2) / LAYOUT_COL_PX))))
    n_rows = max(1, min(600, int(math.ceil((bottom + 2) / LAYOUT_ROW_PX))))
    for i in range(1, n_cols + 1):
        ws.column_dimensions[get_column_letter(i)].width = 4.2
    for r in range(1, n_rows + 1):
        ws.row_dimensions[r].height = 7.5
    ctx = {'cols': visible_columns(result), 'rows': (result or {}).get('rows') or [],
           'n_cols': n_cols, 'n_rows': n_rows,
           'Alignment': Alignment, 'Font': Font, 'PatternFill': PatternFill,
           'get_column_letter': get_column_letter}
    _layout_elements(ws, elements, ctx, 0, 0)
    ws.page_setup.orientation = 'landscape'
    ws.page_setup.fitToWidth = 1
    return ws


def _layout_elements(ws, elements, ctx, ox, oy):
    for el in elements or []:
        if isinstance(el, dict):
            _layout_element(ws, el, ctx, ox, oy)


def _layout_element(ws, el, ctx, ox, oy):
    Alignment, Font, PatternFill = ctx['Alignment'], ctx['Font'], ctx['PatternFill']
    kind = el.get('kind')
    if kind not in ('label', 'line', 'box', 'image', 'chart', 'table'):
        return
    x = ox + _int(el.get('x'))
    y = oy + _int(el.get('y'))
    w = max(20, _int(el.get('w'), 120))
    h = max(10, _int(el.get('h'), 32))
    r1, c1, r2, c2 = _layout_span(ctx, x, y, w, h)
    anchor = ctx['get_column_letter'](c1) + str(r1)

    if kind == 'box':
        # 区域只上边框/底色，不合并单元格（合并区会把里面的子组件锁死）
        bg = _hex(el.get('bg'), '')
        if bg:
            fill = PatternFill('solid', fgColor=bg[1:])
            for r in range(r1, r2 + 1):
                for c in range(c1, c2 + 1):
                    ws.cell(row=r, column=c).fill = fill      # 合并区的从属单元格也能刷底色
        if _flag(el.get('border'), True):
            _layout_border(ws, r1, c1, r2, c2, _hex(el.get('borderColor'), '#DCDFE6')[1:])
        pad = max(0, _int(el.get('padding'), 8))
        _layout_elements(ws, el.get('children') or [], ctx, x + pad, y + pad)
    elif kind == 'label':
        _layout_merge(ws, r1, c1, r2, c2)
        cell = _layout_cell(ws, r1, c1, str(el.get('text') or ''))
        if cell is None:
            return
        cell.font = Font(name='微软雅黑',
                         size=max(6, min(28, int(round(_int(el.get('fontSize'), 14) * PX2PT + 1)))),
                         bold=_flag(el.get('bold'), False),
                         color='FF' + _hex(el.get('color'), '#303133')[1:])
        cell.alignment = Alignment(horizontal=str(el.get('align') or 'left') if
                                   str(el.get('align')) in ('left', 'center', 'right') else 'left',
                                   vertical='center', wrap_text=True)
    elif kind == 'line':
        mid_r = (r1 + r2) // 2
        if str(el.get('dir') or 'h') == 'v':
            _layout_border(ws, r1, c1, r2, c1, _hex(el.get('color'), '#DCDFE6')[1:])
        else:
            _layout_border(ws, mid_r, c1, mid_r, c2, _hex(el.get('color'), '#DCDFE6')[1:])
    elif kind == 'image':
        _layout_border(ws, r1, c1, r2, c2, 'EBEEF5')
        try:
            from openpyxl.drawing.image import Image as XLImage
            img = _image_reader(el.get('src'))
            if img is not None:
                img.drawWidth = w
                img.drawHeight = h
                buf = io.BytesIO()
                img.drawOn.__self__           # 只是确认对象可用
                img.image.save(buf, format='PNG')
                buf.seek(0)
                xl_img = XLImage(buf)
                xl_img.width = max(10, int(w))
                xl_img.height = max(10, int(h))
                ws.add_image(xl_img, anchor)
            else:
                cell = _layout_cell(ws, r1, c1, '图片：未取到素材')
                if cell is not None:
                    cell.font = Font(name='微软雅黑', size=8, color='FFA8ABB2')
        except Exception:
            pass
    elif kind == 'chart':
        try:
            _layout_chart(ws, el, ctx, r1, c1, w, h, anchor)
        except Exception:
            cell = _layout_cell(ws, r1, c1, '图表')
            if cell is not None:
                cell.font = Font(name='微软雅黑', size=8, color='FF909399')
    elif kind == 'table':
        _layout_table(ws, el, ctx, r1, c1, r2, c2)


def _layout_chart(ws, el, ctx, r1, c1, w, h, anchor):
    """图表组件 → Excel 原生图表（数据写在版式页右侧的隐藏列里）"""
    from openpyxl.chart import BarChart, LineChart, PieChart, Reference
    from openpyxl.styles import Font

    pts = chart_points(el, ctx['cols'], ctx['rows'])
    if not pts:
        cell = _layout_cell(ws, r1, c1, '图表：没有数据')
        if cell is not None:
            cell.font = Font(name='微软雅黑', size=8, color='FF909399')
        return
    base = ctx['n_cols'] + 3
    ws.cell(row=1, column=base, value='类目')
    ws.cell(row=1, column=base + 1, value=str(el.get('title') or '数量')[:40])
    for i, one in enumerate(pts):
        ws.cell(row=2 + i, column=base, value=str(one['label']))
        ws.cell(row=2 + i, column=base + 1, value=one['value'])
    for col in (base, base + 1):
        ws.column_dimensions[ctx['get_column_letter'](col)].hidden = True

    kind = str(el.get('chartType') or 'bar')
    chart = {'pie': PieChart, 'line': LineChart}.get(kind, BarChart)()
    chart.add_data(Reference(ws, min_col=base + 1, min_row=1, max_row=1 + len(pts)),
                   titles_from_data=True)
    chart.set_categories(Reference(ws, min_col=base, min_row=2, max_row=1 + len(pts)))
    if el.get('title'):
        chart.title = str(el.get('title'))[:40]
    if not _flag(el.get('legend'), True):
        chart.legend = None
    chart.width = max(3.0, w * 0.0265)          # px → cm
    chart.height = max(2.0, h * 0.0265)
    ws.add_chart(chart, anchor)


def _even_edges(first, span, count):
    """把 first..first+span-1 平均分成 count 段，返回 [(a1, a2), …]（含两端）"""
    out, prev = [], first
    for i in range(count):
        end = first + max(1, int(round(span * (i + 1) / float(count)))) - 1
        end = min(first + span - 1, max(prev, end))
        out.append((prev, end))
        prev = end + 1
    out[-1] = (out[-1][0], first + span - 1)
    return out


def _layout_table(ws, el, ctx, r1, c1, r2, c2):
    """表格组件 → 单元格小表格（行 / 列 / 内容都按用户填的来，格网均分）"""
    Alignment, Font, PatternFill = ctx['Alignment'], ctx['Font'], ctx['PatternFill']
    rows, cols, grid, head, align = table_grid(el)
    row_edges = _even_edges(r1, r2 - r1 + 1, rows)
    col_edges = _even_edges(c1, c2 - c1 + 1, cols)
    for r in range(rows):
        for c in range(cols):
            rr1, rr2 = row_edges[r]
            cc1, cc2 = col_edges[c]
            _layout_merge(ws, rr1, cc1, rr2, cc2)
            is_head = head and r == 0
            cell = _layout_cell(ws, rr1, cc1, grid[r][c])
            if cell is None:
                continue
            cell.font = Font(name='微软雅黑', size=8, bold=is_head)
            if is_head:
                cell.fill = PatternFill('solid', fgColor='F2F6FC')
            cell.alignment = Alignment(horizontal='center' if is_head else align,
                                       vertical='center', wrap_text=False)
            _layout_border(ws, rr1, cc1, rr2, cc2, 'DCDFE6')


# ---------------------------------------------------------------- PDF ----------------------------------------------------------------
_FONT_LOCK = threading.Lock()
_FONT_NAME = None
_FONT_CANDIDATES = (
    ('C:/Windows/Fonts/msyh.ttc', 'Microsoft YaHei'),
    ('C:/Windows/Fonts/simhei.ttf', 'SimHei'),
    ('C:/Windows/Fonts/simsun.ttc', 'SimSun'),
    ('/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', 'WenQuanYi'),
)


def _font():
    """注册一个能显示中文的字体（只注册一次）"""
    global _FONT_NAME
    if _FONT_NAME:
        return _FONT_NAME
    with _FONT_LOCK:
        if _FONT_NAME:
            return _FONT_NAME
        try:
            from reportlab.pdfbase import pdfmetrics
            from reportlab.pdfbase.ttfonts import TTFont
        except Exception:
            raise ExportError('服务器未安装 reportlab，无法导出 PDF（pip install reportlab）')
        for path, alias in _FONT_CANDIDATES:
            if not os.path.isfile(path):
                continue
            try:
                pdfmetrics.registerFont(TTFont(alias, path))
                _FONT_NAME = alias
                return _FONT_NAME
            except Exception:
                continue
        raise ExportError('没找到可用中文字体，PDF 里的中文会乱码；请把 simhei.ttf 放到 C:\\Windows\\Fonts')


def band_height(tpl, kind, design=None):
    """页眉 / 页脚条要占的高度（pt）：有 logo 按 logo 高、只有文字按一行；都没有就不占位"""
    tpl = tpl or {}
    design = design or {}
    logo = str(tpl.get(kind + 'Logo') or '')
    text = str(design.get('headerText' if kind == 'header' else 'footerText') or '')
    if not logo and not text:
        return 0.0
    if logo:
        return max(10.0, min(120, int(tpl.get(kind + 'LogoHeight') or 32)) * PX2PT) + 6
    return 12.0


def _band_lines(text, font, size, width, limit=3):
    """页眉 / 页脚文字：超宽按字宽折断，最多 limit 行"""
    from reportlab.pdfbase import pdfmetrics
    text = str(text or '')
    if not text:
        return []
    lines, cur = [], ''
    for ch in text:
        if pdfmetrics.stringWidth(cur + ch, font, size) <= width or not cur:
            cur += ch
        elif len(lines) < limit - 1:
            lines.append(cur)
            cur = ch
        else:
            lines.append(cur + '…')
            cur = ''
            break
    if cur and len(lines) < limit:
        lines.append(cur)
    return lines


def draw_band(canvas, kind, design, tpl, font, left, right, top_y, height):
    """
    画一条页眉 / 页脚：logo 贴左或贴右（垂直居中），文字占剩余宽度并按 *Align 对齐
    :param top_y  这条带的上边界（pt，原点在左下）
    :param height 这条带的高度（pt）
    """
    from reportlab.lib.colors import HexColor
    logo = str(tpl.get(kind + 'Logo') or '')
    text = str(design.get('headerText' if kind == 'header' else 'footerText') or '')
    if not logo and not text:
        return
    size = 7.0 if kind == 'footer' else 7.5
    align = design.get(kind + 'Align') or ('left' if kind == 'header' else 'center')
    pos_right = str(tpl.get(kind + 'LogoPos')) == 'right'
    gap = 6.0
    logo_w = 0.0
    if logo:
        img = _image_reader(logo)
        if img is not None:
            try:
                iw = float(getattr(img, 'imageWidth', 0) or 0)
                ih = float(getattr(img, 'imageHeight', 0) or 0)
                if iw > 0 and ih > 0:
                    draw_h = max(6.0, height - 6)
                    draw_w = iw * draw_h / ih
                    max_w = (right - left) * 0.4
                    if draw_w > max_w:
                        draw_w = max_w
                        draw_h = ih * draw_w / iw
                    logo_x = (right - draw_w) if pos_right else left
                    img.drawWidth = draw_w
                    img.drawHeight = draw_h
                    img.drawOn(canvas, logo_x, top_y - height / 2.0 - draw_h / 2.0)
                    logo_w = draw_w + gap
            except Exception:
                logo_w = 0.0
    if not text:
        return
    text_left = left if pos_right else left + logo_w
    text_right = right - (logo_w if pos_right else 0.0)
    width = max(20.0, text_right - text_left)
    lines = _band_lines(text, font, size, width)
    canvas.setFont(font, size)
    canvas.setFillColor(HexColor('#606266'))
    baseline = top_y - height / 2.0 - size * 0.35
    for one in lines:
        if align == 'center':
            canvas.drawCentredString(text_left + width / 2.0, baseline, one)
        elif align == 'right':
            canvas.drawRightString(text_right, baseline, one)
        else:
            canvas.drawString(text_left, baseline, one)
        baseline -= size * 1.35


def build_pdf(result):
    """生成 .pdf（全部行，最多 PDF_MAX_ROWS 行）：返回 bytes"""
    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
        from reportlab.lib.pagesizes import A3, A4, A5, letter
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (Flowable, Paragraph, SimpleDocTemplate, Spacer,
                                        Table, TableStyle)
        from xml.sax.saxutils import escape as xml_escape
    except Exception:
        raise ExportError('服务器未安装 reportlab，无法导出 PDF（pip install reportlab）')

    font = _font()
    design = _design_of(result)
    tpl = _template_of(result)
    cols = visible_columns(result)
    if not cols:
        raise ExportError('这张报表没有可见的列，先在设计器里把列设为显示再导出')
    rows = [(result or {}).get('rows') or []]
    rows = (result or {}).get('rows') or []
    if len(rows) > PDF_MAX_ROWS:
        raise ExportError('结果有 %d 行，超出 PDF 单次导出上限（%d 行）；这么大的数据请导出 Excel，'
                          '或先加参数缩小范围' % (len(rows), PDF_MAX_ROWS))

    report = (result or {}).get('report') or {}
    title = report.get('reportName') or design.get('title') or '报表'

    size_map = {'A3': A3, 'A4': A4, 'A5': A5, 'Letter': letter}
    pagesize = size_map.get(str(tpl.get('paper') or 'A4'), A4)
    if tpl.get('orientation') == 'landscape':
        pagesize = (pagesize[1], pagesize[0])

    margin_l = tpl['marginLeft'] * mm * 0.6
    margin_r = tpl['marginRight'] * mm * 0.6
    base_t = tpl['marginTop'] * mm * 0.6
    base_b = (tpl['marginBottom'] * mm * 0.6) + 6 * mm       # 页码那一行
    head_h = band_height(tpl, 'header', design)              # 页眉 / 页脚条高度（每页重复画）
    foot_h = band_height(tpl, 'footer', design)
    margin_t = base_t + head_h
    margin_b = base_b + foot_h

    body_size = max(MIN_FONT, min(MAX_FONT, tpl['fontSize']))
    cell_style = ParagraphStyle('cell', fontName=font, fontSize=body_size,
                                leading=body_size + 2, alignment=TA_LEFT)
    cell_center = ParagraphStyle('cellC', parent=cell_style, alignment=TA_CENTER)
    cell_right = ParagraphStyle('cellR', parent=cell_style, alignment=TA_RIGHT)
    head_style = ParagraphStyle('head', parent=cell_style, alignment=TA_CENTER, leading=body_size + 2)
    head_left = ParagraphStyle('headL', parent=head_style, alignment=TA_LEFT)
    head_right = ParagraphStyle('headR', parent=head_style, alignment=TA_RIGHT)

    buf = io.BytesIO()
    stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    def on_page(canvas, doc):
        canvas.saveState()
        if head_h:
            draw_band(canvas, 'header', design, tpl, font, margin_l, pagesize[0] - margin_r,
                      pagesize[1] - base_t - 2, head_h)
        if foot_h:
            draw_band(canvas, 'footer', design, tpl, font, margin_l, pagesize[0] - margin_r,
                      base_b * 0.45 + 12 + foot_h, foot_h)
        canvas.setFont(font, 7.5)
        canvas.setFillColor(colors.HexColor('#909399'))
        parts = []
        if tpl.get('showPageNo'):
            parts.append('第 %d 页' % doc.page)
        if tpl.get('showTime'):
            parts.append('打印时间：%s' % stamp)
        text = '　·　'.join(parts)
        if text:
            canvas.drawString(margin_l, base_b * 0.45, text[:200])
        if tpl.get('watermark'):
            canvas.saveState()
            canvas.setFont(font, 40)
            canvas.setFillColor(colors.Color(0.6, 0.6, 0.6, alpha=0.12))
            canvas.translate(pagesize[0] / 2.0, pagesize[1] / 2.0)
            canvas.rotate(30)
            canvas.drawCentredString(0, 0, tpl['watermark'][:24])
            canvas.restoreState()
        canvas.restoreState()

    doc = SimpleDocTemplate(buf, pagesize=pagesize,
                            leftMargin=margin_l, rightMargin=margin_r,
                            topMargin=margin_t, bottomMargin=margin_b,
                            title=title, author='九豆综合管理平台')

    story = []
    if design.get('showTitle'):
        align = {'left': TA_LEFT, 'center': TA_CENTER, 'right': TA_RIGHT}.get(tpl.get('titleAlign'), TA_CENTER)
        story.append(Paragraph('<b>%s</b>' % xml_escape(title),
                               ParagraphStyle('t', fontName=font, fontSize=max(11, tpl['titleSize'] - 4),
                                              leading=tpl['titleSize'], alignment=align)))
    if design.get('subtitle'):
        story.append(Paragraph(xml_escape(design.get('subtitle')),
                               ParagraphStyle('s', fontName=font, fontSize=body_size,
                                              leading=body_size + 3, alignment=TA_CENTER,
                                              textColor=colors.HexColor('#909399'))))
    line = params_line(result) if design.get('showParams') else ''
    if line:
        story.append(Paragraph(xml_escape('参数：' + line),
                               ParagraphStyle('p', fontName=font, fontSize=body_size,
                                              leading=body_size + 3, alignment=TA_LEFT,
                                              textColor=colors.HexColor('#606266'))))
    story.append(Spacer(1, 4))

    # 列宽：按设计里的像素宽等比分配可用宽度
    avail = pagesize[0] - margin_l - margin_r

    # 设计区组件（工具箱）：按与预览页同一套坐标画一块画布，放在表格上面
    block_elements = elements_of(result)
    if block_elements:
        stage_right, stage_bottom = design_bounds(block_elements)
        stage_w = max(80.0, stage_right + 2.0)
        stage_h = max(30.0, stage_bottom + 2.0)
        avail_h = pagesize[1] - margin_t - margin_b
        k = PX2PT * min(1.0, avail / (stage_w * PX2PT))
        if stage_h * k > avail_h * 0.9:          # 太高就再缩一点，避免整块超过一页
            k = avail_h * 0.9 / stage_h
        block_w, block_h = min(avail, stage_w * k), stage_h * k
        block_ctx = {'font': font, 'cols': cols, 'rows': rows}

        class _DesignBlock(Flowable):
            """把设计区当成一张定高的画布（Flowable 只负责占位，内容全在 draw 里画）"""

            def wrap(self, aw, ah):
                return block_w, block_h

            def draw(self):
                _draw_elements(self.canv, block_elements, block_ctx, k, block_h)

        story.append(_DesignBlock())
        story.append(Spacer(1, 6))

    show_no = design.get('showRowNo')
    weights = []
    for col in cols:
        try:
            weights.append(max(40, int(col.get('width') or 120)))
        except (TypeError, ValueError):
            weights.append(120)
    if show_no:                                  # 最左侧序号列：固定窄一点
        weights = [56] + weights
    total_w = float(sum(weights))
    widths = [avail * w / total_w for w in weights]

    def head_para(col):
        align = _align_of(col.get('headerAlign'), 'center')
        style = head_left if align == 'left' else (head_right if align == 'right' else head_style)
        return Paragraph(xml_escape(str(col.get('label') or col.get('field') or '')), style)

    head_cells = [head_para(col) for col in cols]
    if show_no:
        head_cells = [Paragraph('序号', head_style)] + head_cells
    data = [head_cells]
    for row_no, row in enumerate(rows, start=1):
        line_cells = []
        if show_no:
            line_cells.append(Paragraph(str(row_no), cell_center))
        for col in cols:
            try:
                pos = int(col.get('index'))
            except (TypeError, ValueError):
                pos = -1
            value = row[pos] if 0 <= pos < len(row) else ''
            text = format_value(value, col.get('format'))
            align = str(col.get('align') or 'left')
            style = cell_right if align == 'right' else (cell_center if align == 'center' else cell_style)
            line_cells.append(Paragraph(xml_escape(text[:500]), style))
        data.append(line_cells)
    if not rows:
        data.append([Paragraph('没有查询到数据', cell_center)] +
                    [Paragraph('', cell_style)
                     for _ in range(len(cols) - 1 + (1 if show_no else 0))])

    # 汇总行
    sum_row = None
    if design.get('showSummary'):
        picked = [(i, c) for i, c in enumerate(cols) if str(c.get('summary') or 'none') != 'none']
        if picked:
            sum_row = [Paragraph('', cell_center)
                       for _ in range(len(cols) + (1 if show_no else 0))]
            for i, col in picked:
                try:
                    pos = int(col.get('index'))
                except (TypeError, ValueError):
                    pos = -1
                value = summary_value(rows, pos, col.get('summary'))
                text = '' if value == '' else format_value(value, col.get('format'))
                sum_row[i] = Paragraph('<b>%s</b>' % xml_escape(text[:120]),
                                       ParagraphStyle('sum', parent=cell_center, fontSize=body_size))
            data.append(sum_row)

    table = Table(data, colWidths=widths, repeatRows=1)
    style_cmds = [
        ('FONTNAME', (0, 0), (-1, -1), font),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#F2F6FC')),
        ('TOPPADDING', (0, 0), (-1, -1), 2 if tpl.get('compact') else 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2 if tpl.get('compact') else 4),
    ]
    if design.get('bordered', True):
        style_cmds += [('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#DCDFE6'))]
        style_cmds += [('LINEBELOW', (0, 0), (-1, 0), 0.6, colors.HexColor('#C0C4CC'))]
    else:
        style_cmds += [('LINEBELOW', (0, 0), (-1, -1), 0.3, colors.HexColor('#EBEEF5'))]
    if design.get('zebra', True):
        for idx in range(1, len(data)):
            if idx % 2 == 0:
                style_cmds.append(('BACKGROUND', (0, idx), (-1, idx), colors.HexColor('#FAFAFA')))
    if sum_row is not None:
        style_cmds.append(('BACKGROUND', (0, len(data) - 1), (-1, len(data) - 1), colors.HexColor('#F5F7FA')))
    table.setStyle(TableStyle(style_cmds))
    story.append(table)

    try:
        doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    except Exception as exc:
        raise ExportError('PDF 生成失败：%s' % exc)
    data_bytes = buf.getvalue()
    buf.close()
    if not data_bytes:
        raise ExportError('PDF 生成失败：没有内容')
    return data_bytes


# ---------------------------------------------------------------- 对外 ------------------------------------------------
def build(result, fmt):
    """按格式生成文件：返回 (bytes, 扩展名, MIME)"""
    fmt = str(fmt or '').lower()
    if fmt in ('xlsx', 'excel', 'xls'):
        return build_xlsx(result), 'xlsx', \
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    if fmt in ('pdf',):
        return build_pdf(result), 'pdf', 'application/pdf'
    raise ExportError('不支持的导出格式：%s（只支持 excel / pdf）' % fmt)
