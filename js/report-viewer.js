/* ==========================================================================
   report-viewer.js —— 报表查看窗（预览 / 运行 / 打印 / 导出 Excel · PDF）
   --------------------------------------------------------------------------
   原来长在 js/report-designer.js 里；「报表中心」也要用同一套查看窗，所以抽成
   独立模块，两个页面共用，避免两处渲染 / 排版 / 打印逻辑各写一份走样。

   用法（报表中心这类「只看不设计」的页面）：
       ReportViewer.openSaved(reportId);      // 读详情 → 填参数 → 执行 → 打印 / 导出
   报表设计器另外会往 ReportViewer.pv 里塞三个回调：
       pv.elements  → 画布组件（结果里没有 design.elements 时兜底）
       pv.onStatus  → 状态提示（没有就静默）
       pv.onRan     → 运行完刷新清单（调用次数变了）

   打开方式：jQuery(function($){ ... }) 内部私有，只通过 window.ReportViewer 对外。
   ========================================================================== */
jQuery(function ($) {
    'use strict';

    /* 页面上一次只渲染这么多行；打印 / 导出会自动按 EXPORT_ROWS 重查全部结果 */
    var PREVIEW_ROWS = 500;

    /* 查看窗共享状态：mode=preview（画布预览）/ run（跑已保存报表） */
    var pv = { mode: 'preview', row: null, onStatus: null, onRan: null, elements: null, state: null };

    function pvStatus(text, type) {
        if (typeof pv.onStatus === 'function') { pv.onStatus(text, type); }
    }

    /* ---------- 与后端 ReportDesignerService / report-designer.js 对齐的常量 ---------- */
    var ELEMENT_KINDS = ['label', 'line', 'box', 'image', 'chart', 'table'];
    var TABLE_MAX_ROWS = 30;                 // 表格组件的行 / 列上限
    var TABLE_MAX_COLS = 10;
    var CHART_COLORS = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#909399',
                        '#9b59b6', '#00b4d8', '#ff9f43'];
    var DEFAULT_DESIGN = {
        title: '', subtitle: '', headerText: '', footerText: '',
        showTitle: true, showParams: true, zebra: true, bordered: true,
        showSummary: true, groupBy: '', elements: []
    };
    var DEFAULT_TEMPLATE = {
        paper: 'A4', orientation: 'portrait',
        marginTop: 12, marginRight: 10, marginBottom: 12, marginLeft: 10,
        fontFamily: 'Microsoft YaHei', fontSize: 12,
        titleSize: 18, titleAlign: 'center', titleBold: true,
        compact: false, showPageNo: true, showTime: true, watermark: ''
    };

    /** 设计器当前画布（报表中心没有画布 → 空壳，读到的字段都是空值，不会报错） */
    function dstate() { return pv.state || { design: {} }; }

    /** 结果里没带模板 / 设计时，退回设计器当前画布（报表中心没有画布，就用默认值） */
    function currentTemplate() {
        return (pv.state && pv.state.design && pv.state.design.template) || DEFAULT_TEMPLATE;
    }
    function currentDesign() {
        return (pv.state && pv.state.design && pv.state.design.design) || DEFAULT_DESIGN;
    }

    /* 查看窗模板（原先放在 report-designer.html 的 #pvTpl 里，随模块一起走） */
    var PV_TEMPLATE_HTML = '<div class="rpt-pv"><div class="rpt-pv__top"><div class="rpt-pv__params" id="pvParams"></div><button type="button" class="el-button el-button--primary el-button--small rpt-pv__run" id="pvRun">执行预览</button></div><div class="rpt-pv__scroll"><div class="rpt-pv__paper" id="pvPaper"><div class="rpt-pv__band" id="pvHeaderBand" hidden></div><div class="rpt-pv__title" id="pvTitle">报表预览</div><div class="rpt-pv__subtitle" id="pvSubtitle"></div><div class="rpt-pv__free" id="pvFreeLayer" hidden></div><div class="rpt-pv__tablewrap" id="pvTableWrap"><div class="rpt-pv__empty">点「执行预览」后在这里看到报表效果</div></div><div class="rpt-pv__band" id="pvFooterBand" hidden></div><div class="rpt-pv__foot" id="pvFooter"></div></div></div><div class="rpt-pv__footbar"><span class="rpt-pv__info" id="pvInfo">尚未执行</span><span class="rpt-pv__spacer"></span><button type="button" class="el-button el-button--small" id="pvPrint" title="打印全部查询结果（不分页）">打印</button><button type="button" class="el-button el-button--small" id="pvPdf" title="导出全部查询结果为 PDF">导出 PDF</button><button type="button" class="el-button el-button--small" id="pvXlsx" title="导出全部查询结果为 Excel">导出 Excel</button></div></div>';

    function esc(text) { return UI.escapeHtml(text === undefined || text === null ? '' : String(text)); }
    function textOf(v) { return v === undefined || v === null ? '' : String(v).replace(/^\s+|\s+$/g, ''); }
    function boolOf(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
    function intOf(v, def) { var n = parseInt(v, 10); return isNaN(n) ? def : n; }

    function nowText() {
        var d = new Date();
        function pad(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    function optionsHtml(items, current) {
        var html = '';
        for (var i = 0; i < items.length; i++) {
            html += '<option value="' + esc(items[i].value) + '"' +
                (String(items[i].value) === String(current) ? ' selected' : '') + '>' +
                esc(items[i].label) + '</option>';
        }
        return html;
    }

    function pageBandHtml(kind, design, tpl) {
        design = design || {};
        tpl = tpl || {};
        var logo = textOf(tpl[kind + 'Logo']);
        var logoH = Math.min(120, Math.max(12, intOf(tpl[kind + 'LogoHeight'], kind === 'footer' ? 28 : 32)));
        var right = textOf(tpl[kind + 'LogoPos']) === 'right';
        var text = textOf(design[kind + 'Text']);
        if (!logo && !text) { return ''; }
        var align = design[kind + 'Align'] || (kind === 'header' ? 'left' : 'center');
        var html = '<div class="rpt-pageband" style="position:relative;display:flex;' +
            '-webkit-box-align:center;-ms-flex-align:center;align-items:center;gap:8px' +
            (right ? ';-webkit-box-orient:horizontal;-webkit-box-direction:reverse;' +
                '-ms-flex-direction:row-reverse;flex-direction:row-reverse' : '') + '">';
        if (logo) {
            html += '<img class="rpt-pageband__logo" src="' + esc(logo) + '" alt="" ' +
                'style="display:block;height:' + logoH + 'px;width:auto;max-width:40%;' +
                'object-fit:contain;-ms-flex:0 0 auto;flex:0 0 auto">';
        }
        if (text) {
            html += '<div class="rpt-pageband__text" style="text-align:' + esc(align) + ';' +
                '-webkit-box-flex:1;-ms-flex:1 1 auto;flex:1 1 auto;min-width:0;' +
                'white-space:pre-wrap;word-break:break-word">' + esc(text) + '</div>';
        }
        html += '</div>';
        return html;
    }


    function elementsOf(data) {
        var design = data && data.design;
        if (design && $.isArray(design.elements)) { return design.elements; }
        return pv.elements ? pv.elements() : [];
    }

    /** 深度遍历组件（含区域里的子组件） */
    function walkElements(list, fn, parent, depth) {
        list = list || [];
        for (var i = 0; i < list.length; i++) {
            fn(list[i], list, i, parent || null, depth || 0);
            if (list[i].kind === 'box') {
                walkElements(list[i].children, fn, list[i], (depth || 0) + 1);
            }
        }
    }


    function elementStyle(el) {
        return 'left:' + intOf(el.x, 0) + 'px;top:' + intOf(el.y, 0) + 'px;' +
            'width:' + Math.max(20, intOf(el.w, 120)) + 'px;' +
            'height:' + Math.max(10, intOf(el.h, 32)) + 'px;';
    }

    function visibleMapped(ctx) {
        var mapped = (ctx && ctx.mapped) || [], out = [], i;
        for (i = 0; i < mapped.length; i++) {
            if (boolOf(mapped[i].visible)) { out.push(mapped[i]); }
        }
        return out;
    }

    /* ---------------- 表格组件：行 / 列 / 单元格内容都由用户自己填 ---------------- */
    function tableRows(el) { return Math.min(TABLE_MAX_ROWS, Math.max(1, intOf(el.rows, 3))); }
    function tableCols(el) { return Math.min(TABLE_MAX_COLS, Math.max(1, intOf(el.cols, 3))); }

    /** 规范化成 rows × cols 的字符串矩阵（缺的格子补空，多的截掉） */
    function tableCells(el) {
        var rows = tableRows(el), cols = tableCols(el);
        var src = $.isArray(el.cells) ? el.cells : [];
        var out = [], r, c;
        for (r = 0; r < rows; r++) {
            var line = [], srcLine = $.isArray(src[r]) ? src[r] : [];
            for (c = 0; c < cols; c++) {
                var one = srcLine[c];
                line.push(one === undefined || one === null ? '' : String(one));
            }
            out.push(line);
        }
        return out;
    }

    /** 改行 / 列数：已有内容原地保留，新增的格子留空 */

    function elTableMarkup(el) {
        el = el || {};
        var rows = tableRows(el), cols = tableCols(el), cells = tableCells(el);
        var showHeader = el.showHeader === undefined ? true : boolOf(el.showHeader);
        var head = boolOf(el.headerRow);
        /* 列头显示=否：第 1 行整行不画（那行通常是「列1/列2/列3」这类列头文字）；
           只剩 1 行时仍然画出来，否则表格会变成空白 */
        var startRow = (showHeader || rows <= 1) ? 0 : 1;
        if (!showHeader) { head = false; }
        var align = esc(el.align || 'left');
        var html = '<table class="rpt-el__table"><colgroup>', r, c;
        for (c = 0; c < cols; c++) {
            html += '<col style="width:' + (100 / cols).toFixed(3) + '%">';
        }
        html += '</colgroup><tbody>';
        for (r = startRow; r < rows; r++) {
            var isHead = head && r === 0;
            html += '<tr>';
            for (c = 0; c < cols; c++) {
                var tag = isHead ? 'th' : 'td';
                html += '<' + tag + ' style="text-align:' + (isHead ? 'center' : align) + '">' +
                    (esc(cells[r][c]) || '&nbsp;') + '</' + tag + '>';
            }
            html += '</tr>';
        }
        html += '</tbody></table>';
        return html;
    }

    /** 图表数据：按分类字段分组、对数值字段求和（画布没有真实数据时用示意值） */
    function chartPoints(el, ctx) {
        var cols = visibleMapped(ctx);
        var rows = (ctx && ctx.rows) || [];
        var catIdx = -1, valIdx = -1, i, map = {}, order = [];
        for (i = 0; i < cols.length; i++) {
            if (textOf(el.categoryField) && cols[i].field === el.categoryField) { catIdx = i; }
            if (textOf(el.valueField) && cols[i].field === el.valueField) { valIdx = i; }
        }
        if (catIdx < 0 && cols.length) { catIdx = 0; }
        if (valIdx < 0) { valIdx = cols.length > 1 ? 1 : 0; }
        if (!cols.length) { rows = []; }        // 没有列就没有数据，直接走下面的示意值 / 空图
        for (i = 0; i < rows.length && i < 5000; i++) {
            var cat = catIdx >= 0 ? textOf(rows[i][intOf(cols[catIdx].index, -1)]) : '合计';
            if (!cat) { cat = '（空）'; }
            var num = Number(valIdx >= 0 ? rows[i][intOf(cols[valIdx].index, -1)] : 1);
            if (isNaN(num)) { num = 1; }
            if (map[cat] === undefined) { map[cat] = 0; order.push(cat); }
            map[cat] += num;
        }
        if (!order.length && ctx && ctx.mode === 'canvas') {
            var demo = ['一组', '二组', '三组', '四组'];
            for (i = 0; i < demo.length; i++) { map[demo[i]] = (i + 1) * 18; order.push(demo[i]); }
        }
        var out = [];
        for (i = 0; i < order.length && i < 12; i++) {
            out.push({ label: order[i], value: map[order[i]] });
        }
        return out;
    }

    function chartSvg(el, w, h, pts) {
        w = Math.max(80, w);
        h = Math.max(50, h);
        var type = textOf(el.chartType) || 'bar';
        var svg = ['<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">'];
        var i, max = 0, total = 0;
        for (i = 0; i < pts.length; i++) { max = Math.max(max, pts[i].value); total += pts[i].value; }
        if (!max) { max = 1; }

        if (type === 'pie') {
            var cx = Math.min(w * 0.36, w / 2), cy = h / 2, rad = Math.min(cx, h / 2) - 6;
            if (rad < 4) { rad = 4; }
            var angle = -Math.PI / 2, sum = total || 1;
            for (i = 0; i < pts.length; i++) {
                var sweep = Math.PI * 2 * (pts[i].value / sum);
                var x1 = cx + rad * Math.cos(angle), y1 = cy + rad * Math.sin(angle);
                angle += sweep;
                var x2 = cx + rad * Math.cos(angle), y2 = cy + rad * Math.sin(angle);
                var large = sweep > Math.PI ? 1 : 0;
                svg.push('<path d="M' + cx.toFixed(1) + ' ' + cy.toFixed(1) +
                    ' L' + x1.toFixed(1) + ' ' + y1.toFixed(1) +
                    ' A' + rad.toFixed(1) + ' ' + rad.toFixed(1) + ' 0 ' + large + ' 1 ' +
                    x2.toFixed(1) + ' ' + y2.toFixed(1) + ' Z" fill="' +
                    CHART_COLORS[i % CHART_COLORS.length] + '"/>');
            }
            if (boolOf(el.legend)) {
                for (i = 0; i < pts.length && i < 8; i++) {
                    var ly = 14 + i * 14;
                    svg.push('<rect x="' + (w * 0.7).toFixed(0) + '" y="' + (ly - 7) +
                        '" width="8" height="8" fill="' + CHART_COLORS[i % CHART_COLORS.length] + '"/>');
                    svg.push('<text x="' + (w * 0.7 + 12).toFixed(0) + '" y="' + ly +
                        '" font-size="10" fill="#606266">' + esc(String(pts[i].label).slice(0, 6)) + '</text>');
                }
            }
        } else {
            var padL = 30, padR = 8, padT = 10, padB = 18;
            var iw = Math.max(20, w - padL - padR), ih = Math.max(20, h - padT - padB);
            svg.push('<line x1="' + padL + '" y1="' + (padT + ih) + '" x2="' + (padL + iw) +
                '" y2="' + (padT + ih) + '" stroke="#e4e7ed"/>');
            svg.push('<text x="2" y="' + (padT + 6) + '" font-size="9" fill="#909399">' + max.toFixed(0) + '</text>');
            if (type === 'line') {
                var stepX = pts.length > 1 ? iw / (pts.length - 1) : 0;
                var points = [];
                for (i = 0; i < pts.length; i++) {
                    var px = padL + i * stepX;
                    var py = padT + ih - ih * (pts[i].value / max);
                    points.push(px.toFixed(1) + ',' + py.toFixed(1));
                }
                svg.push('<polyline fill="none" stroke="#409eff" stroke-width="2" points="' +
                    points.join(' ') + '"/>');
                for (i = 0; i < pts.length; i++) {
                    var cx2 = padL + i * stepX, cy2 = padT + ih - ih * (pts[i].value / max);
                    svg.push('<circle cx="' + cx2.toFixed(1) + '" cy="' + cy2.toFixed(1) +
                        '" r="2.5" fill="#409eff"/>');
                }
            } else {
                var slot = iw / Math.max(1, pts.length);
                var bw = Math.max(6, Math.min(38, slot * 0.6));
                for (i = 0; i < pts.length; i++) {
                    var bh = ih * (pts[i].value / max);
                    var bx = padL + slot * i + (slot - bw) / 2;
                    svg.push('<rect x="' + bx.toFixed(1) + '" y="' + (padT + ih - bh).toFixed(1) +
                        '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, bh).toFixed(1) +
                        '" rx="2" fill="' + CHART_COLORS[i % CHART_COLORS.length] + '"/>');
                }
            }
            for (i = 0; i < pts.length; i++) {
                var lx = padL + (iw / Math.max(1, pts.length)) * i + (iw / Math.max(1, pts.length)) / 2;
                svg.push('<text x="' + lx.toFixed(1) + '" y="' + (padT + ih + 12) +
                    '" font-size="9" fill="#909399" text-anchor="middle">' +
                    esc(String(pts[i].label).slice(0, 4)) + '</text>');
            }
        }
        svg.push('</svg>');
        return svg.join('');
    }

    /** 一个组件渲染成 HTML（ctx.mode：canvas / preview / print） */
    function elementHtml(el, ctx) {
        ctx = ctx || { mode: 'canvas' };
        if (!el || ELEMENT_KINDS.indexOf(el.kind) < 0) { return ''; }
        var canvas = ctx.mode === 'canvas';
        var cls = 'rpt-el rpt-el--' + el.kind +
            (canvas && el.kind === 'box' ? ' is-dropzone' : '') +
            (canvas && pv.state && String(el.id) === String(pv.state.selectedElem) ? ' is-selected' : '');
        var attr = canvas ? (' data-eid="' + esc(el.id) + '"') : '';
        var inner = '';
        var i;

        if (el.kind === 'label') {
            inner = '<span style="font-size:' + intOf(el.fontSize, 14) + 'px;color:' +
                esc(el.color || '#303133') + ';text-align:' + esc(el.align || 'left') +
                ';font-weight:' + (boolOf(el.bold) ? '700' : '400') + '">' +
                esc(el.text || '') + '</span>';
        } else if (el.kind === 'line') {
            var th = Math.min(8, Math.max(1, intOf(el.thickness, 1)));
            inner = el.dir === 'v'
                ? '<i style="width:' + th + 'px;height:100%;background:' + esc(el.color || '#DCDFE6') + '"></i>'
                : '<i style="height:' + th + 'px;width:100%;background:' + esc(el.color || '#DCDFE6') + '"></i>';
        } else if (el.kind === 'box') {
            var bstyle = 'padding:' + intOf(el.padding, 8) + 'px;' +
                (boolOf(el.border)
                    ? 'border:1px solid ' + esc(el.borderColor || '#DCDFE6') + ';'
                    : 'border:1px dashed transparent;') +
                'border-radius:' + intOf(el.radius, 4) + 'px;' +
                (el.bg ? 'background:' + esc(el.bg) + ';' : '');
            var kids = el.children || [];
            inner = '<div class="rpt-el__boxinner" style="position:relative;width:100%;height:100%;' +
                bstyle + '">';
            for (i = 0; i < kids.length; i++) { inner += elementHtml(kids[i], ctx); }
            if (canvas) { inner += '<span class="rpt-el--box__tag">区域</span>'; }
            inner += '</div>';
        } else if (el.kind === 'image') {
            inner = el.src
                ? '<img src="' + esc(el.src) + '" alt="" style="object-fit:' +
                    esc(el.fit || 'contain') + ';border-radius:' + intOf(el.radius, 0) + 'px">'
                : '<span class="rpt-el--image__none">未设置图片</span>';
        } else if (el.kind === 'chart') {
            var pts = chartPoints(el, ctx);
            var head = el.title ? ('<div class="rpt-el__chart-title">' + esc(el.title) + '</div>') : '';
            var bodyH = intOf(el.h, 200) - (el.title ? 22 : 0);
            inner = head + '<div class="rpt-el__chart-body">' +
                chartSvg(el, intOf(el.w, 320) - 2, bodyH - 2, pts) + '</div>';
        } else if (el.kind === 'table') {
            inner = elTableMarkup(el);
        }
        return '<div class="' + cls + '" style="' + elementStyle(el) + '"' + attr + '>' + inner + '</div>';
    }

    function elementsHtml(list, ctx) {
        var html = '', i;
        for (i = 0; i < (list || []).length; i++) { html += elementHtml(list[i], ctx); }
        return html;
    }

    function elementsBottom(list) {
        var bottom = 0;
        for (var i = 0; i < (list || []).length; i++) {
            bottom = Math.max(bottom, intOf(list[i].y, 0) + intOf(list[i].h, 0));
        }
        return bottom;
    }

    /**
     * 组件占用的右下边界（像素，含区域内嵌的子组件）。
     * 预览 / 打印 / 导出都按这块「画布」等比缩放，保证三处版式和页面上看到的一致。
     * @param list 组件数组；@param ox,oy 父级（区域内容区）左上角偏移
     */
    function elementBounds(list, ox, oy) {
        var right = 0, bottom = 0, i;
        ox = intOf(ox, 0);
        oy = intOf(oy, 0);
        for (i = 0; i < (list || []).length; i++) {
            var el = list[i] || {};
            var x = ox + intOf(el.x, 0), y = oy + intOf(el.y, 0);
            var w = Math.max(20, intOf(el.w, 120)), h = Math.max(10, intOf(el.h, 32));
            right = Math.max(right, x + w);
            bottom = Math.max(bottom, y + h);
            if (el.kind === 'box' && el.children && el.children.length) {
                var pad = intOf(el.padding, 8);
                var inner = elementBounds(el.children, x + pad, y + pad);
                right = Math.max(right, inner.right + pad);   // 子组件溢出区域时也要算进来
                bottom = Math.max(bottom, inner.bottom + pad);
            }
        }
        return { right: right, bottom: bottom };
    }

    /** 画布用的上下文：列定义 + 3 行示意数据 */

    function renderPvBands($body, design, tpl) {
        var pairs = [['#pvHeaderBand', pageBandHtml('header', design, tpl)],
                     ['#pvFooterBand', pageBandHtml('footer', design, tpl)]];
        for (var i = 0; i < pairs.length; i++) {
            var $band = $body.find(pairs[i][0]);
            if (!$band.length) { continue; }
            if (pairs[i][1]) { $band.prop('hidden', false).html(pairs[i][1]); }
            else { $band.prop('hidden', true).empty(); }
        }
    }

    /** 设计区在纸上的等比缩放：宽度超了就整体缩小，不放大（打印 / 导出同一算法） */
    function stageScale(stageW, avail) {
        if (!(stageW > 0) || !(avail > 0)) { return 1; }
        return Math.min(1, avail / stageW);
    }

    /** 预览 / 打印里的设计区（真实数据）：按组件占用范围铺一张「画布」，超宽整体等比缩放 */
    function renderPvFreeLayer($body, data) {
        var $layer = $body.find('#pvFreeLayer');
        if (!$layer.length) { return; }
        var list = elementsOf(data);
        if (!list.length) { $layer.prop('hidden', true).empty().css('height', '0px'); return; }
        var bounds = elementBounds(list, 0, 0);
        var stageW = Math.max(80, Math.ceil(bounds.right) + 2);
        var stageH = Math.max(30, Math.ceil(bounds.bottom) + 2);
        var $paper = $body.find('#pvPaper');
        var avail = 0;
        if ($paper.length) {
            avail = intOf($paper.innerWidth ? $paper.innerWidth() : $paper.width(), 0) -
                intOf(parseFloat($paper.css('padding-left')), 0) -
                intOf(parseFloat($paper.css('padding-right')), 0);
        }
        if (!(avail > 60)) { avail = 780; }                    // jsdom / 还没排版时给个默认纸张宽度
        var scale = stageScale(stageW, avail);
        var ctx = { mode: 'preview', mapped: (data && data.mapped) || [], rows: (data && data.rows) || [] };
        $layer.prop('hidden', false)
            .css('height', Math.max(20, Math.ceil(stageH * scale)) + 'px')
            .html('<div class="rpt-pv__stage" style="position:relative;width:' + stageW + 'px;height:' +
                stageH + 'px;transform:scale(' + scale.toFixed(4) + ');transform-origin:left top;' +
                '-webkit-transform-origin:left top">' + elementsHtml(list, ctx) + '</div>');
    }

    /* ---------- 让层出现出来：与字段明细并列的「设计区」 ---------- */

    function paramInputHtml(p, index) {
        var value = p.defaultValue === undefined ? '' : p.defaultValue;
        var id = 'pvParam' + index;
        var label = '<label class="rpt-pv__plabel" for="' + id + '">' +
            esc(p.label || p.name) + (boolOf(p.required) ? '<b>*</b>' : '') + '</label>';
        var control = textOf(p.control) || 'text';
        var input;
        if (control === 'select' || control === 'multiselect') {
            var opts = textOf(p.options).split(/[,，;；]/);
            input = '<select class="el-input__inner" id="' + id + '" data-pname="' + esc(p.name) + '"' +
                (control === 'multiselect' ? ' multiple size="3"' : '') + '>';
            if (control !== 'multiselect') { input += '<option value="">（全部）</option>'; }
            for (var i = 0; i < opts.length; i++) {
                var one = textOf(opts[i]);
                if (!one) { continue; }
                input += '<option value="' + esc(one) + '"' + (one === value ? ' selected' : '') + '>' +
                    esc(one) + '</option>';
            }
            input += '</select>';
        } else if (control === 'checkbox') {
            input = '<select class="el-input__inner" id="' + id + '" data-pname="' + esc(p.name) + '">' +
                '<option value="">（全部）</option>' +
                '<option value="1"' + (value === '1' ? ' selected' : '') + '>是</option>' +
                '<option value="0"' + (value === '0' ? ' selected' : '') + '>否</option></select>';
        } else {
            var type = control === 'date' ? 'date' : (control === 'number' ? 'number' : 'text');
            input = '<input class="el-input__inner" type="' + type + '" id="' + id +
                '" data-pname="' + esc(p.name) + '" value="' + esc(value) + '"' +
                ' placeholder="' + esc(p.remark || '') + '">';
        }
        return '<div class="rpt-pv__pitem">' + label + input + '</div>';
    }

    var pvState = { result: null, page: 1, pageSize: 20,
        showRowNo: false, rowNoInit: false };   // 数据表行号（序号列）：右键表格切换
    var CTX_MENU = null;
    /* 查看弹窗两种用法：preview=按画布内容预览（可未保存）／run=双击清单里已保存的报表直接跑数据 */

    /* 模板只留一份 HTML 字符串，DOM 里的 #pvTpl 立刻摘掉 ——
       否则页面里会同时存在两套 id（模板一份、弹窗里一份），
       `$('#pvPrint')` / `document.getElementById('pvInfo')` 会命中隐藏的模板。 */

    /** 执行按钮的忙碌态（预览 / 运行时文案不同，原文案存 data-label） */
    function setRunButton($body, busy) {
        var $btn = $body.find('#pvRun');
        if (!$btn.length) { return; }
        if (!$btn.attr('data-label')) { $btn.attr('data-label', $btn.text()); }
        $btn.prop('disabled', !!busy).text(busy ? '执行中…' : $btn.attr('data-label'));
    }

    /** 页脚提示（busy=橙 / ok=绿 / 空=灰），title 里放完整内容，避免被省略号截断后看不到 */
    function footInfo($body, text, cls) {
        var $info = $body.find('#pvInfo');
        $info.removeClass('is-busy is-ok');
        if (cls === 'busy') { $info.addClass('is-busy'); }
        if (cls === 'ok') { $info.addClass('is-ok'); }
        $info.text(text || '').attr('title', text || '');
    }

    /** 查询执行效率信息（显示在弹窗页脚）：执行时间 / 返回行数 / 耗时 / 是否被截断 */
    function showEfficiency($body, data, extra) {
        var parts = [];
        parts.push('执行于 ' + (data.executedAt || nowText()));
        parts.push('返回 ' + intOf(data.rowCount, 0) + ' 行');
        parts.push('耗时 ' + intOf(data.elapsed, 0) + ' ms');
        if (data.database) { parts.push('库 ' + data.database); }
        if (data.truncated) {
            parts.push('页面上只显示前 ' + PREVIEW_ROWS + ' 行（打印 / 导出取全部结果）');
        }
        if (extra) { parts.push(extra); }
        footInfo($body, parts.join('　·　'), 'ok');
        if (data.sql) { $body.find('#pvInfo').attr('title', parts.join('　·　') + '\n' + data.sql); }
    }

    /** 执行 / 打印 / 导出期间统一置灰，避免重复点击 */
    function setFootBusy($body, busy) {
        $body.find('#pvPrint, #pvPdf, #pvXlsx').prop('disabled', !!busy);
        setRunButton($body, busy);
    }

    /** 打开报表查看弹窗（预览与双击运行共用一套 DOM / 纸张渲染） */
    function showViewer(opt) {
        var o = opt || {};
        var params = o.params || [];
        var $form = $(PV_TEMPLATE_HTML);
        if (params.length) {
            var paramsHtml = '';
            for (var i = 0; i < params.length; i++) {
                paramsHtml += paramInputHtml(params[i], i);
            }
            $form.find('#pvParams').html(paramsHtml);
            $form.find('#pvRun').attr('data-label', o.runText || '执行').text(o.runText || '执行');
        } else {
            /* 报表没定义参数 → 顶部整行（参数区 + 「执行」按钮）都不显示，
               打开就自动跑一次；要重跑就关掉重开（需求 2026-11-04） */
            $form.find('.rpt-pv__top').remove();
        }
        $form.find('#pvTitle').text(o.title || '未命名报表');
        $form.find('#pvSubtitle').text(o.subtitle || '');
        pvState.rowNoInit = false;               // 每次打开查看窗按报表的设计重新初始化
        pvState.showRowNo = false;
        closeTableMenu();

        return UI.dialog({
            title: o.dlgTitle || '报表查看',
            width: 1080,
            maximizable: true,
            maximized: true,            // 打开即最大化：报表列多时不用再手动点一次（可点 ❐ 还原）
            content: $form,
            onReady: function ($body, close) {
                $body.find('#pvRun').on('click', function () { o.onRun($body); });
                /* 页脚：打印 / 导出 Excel / 导出 PDF —— 都是「全部查询结果」，不是页面上这 20 行 */
                $body.find('#pvPrint').on('click', function () { printReport($body); });
                $body.find('#pvPdf').on('click', function () { exportReport($body, 'pdf'); });
                $body.find('#pvXlsx').on('click', function () { exportReport($body, 'excel'); });
                var $dlg = $body.closest('.el-dialog');      // footer 按钮不在 body 里，要往上找
                /* 右下角不再放「关闭」：用标题栏的 ✕ 关（第 98 次按需求去掉） */
                $dlg.find('.el-dialog__footer').prop('hidden', true);
                /* 右击数据表任意处 → 行号显示设置 */
                $body.on('contextmenu', '.rpt-pv__table, .rpt-pv__tablewrap', function (e) {
                    try { if (e.preventDefault) { e.preventDefault(); } } catch (err) { /* 自动化环境没有原生事件 */ }
                    var oe = e.originalEvent || e;
                    openTableMenu($body, intOf(oe.clientX, 0), intOf(oe.clientY, 0));
                    return false;
                });
                o.onRun($body);
            },
            /* 最大化 / 还原后纸张宽度变了：重画一次纸张（设计区按纸张宽度等比缩放） */
            onResize: function ($body) {
                if (pvState.result) {
                    renderPreviewPaper($body, pvState.result);
                }
            }
        });
    }


    function runSavedReport($body) {
        if (!pv.row) { return; }
        var row = pv.row;
        setFootBusy($body, true);
        footInfo($body, '正在按连接「' + (row.connName || '—') + '」执行查询…', 'busy');
        Api.report.run({
            id: row.id, paramValues: collectParamValues($body), maxRows: PREVIEW_ROWS
        }).done(function (data) {
            pvState.result = data;
            pvState.page = 1;
            renderPreviewPaper($body, data);
            showEfficiency($body, data, '调用 ' + intOf(data.runCount, 0) + ' 次');
            pvStatus('已运行报表「' + row.reportName + '」，返回 ' + intOf(data.rowCount, 0) + ' 行', 'ok');
            if (pv.onRan) { pv.onRan(); }                    // 调用次数变了，刷新左侧清单
        }).fail(function (err) {
            $body.find('#pvInfo').text('');
            $body.find('#pvTableWrap').html('<div class="rpt-pv__empty is-error">运行失败：' +
                esc(err.message) + '</div>');
            pvStatus('运行失败：' + (err.message || ''), 'error');
            UI.message({ type: 'error', message: err.message || '运行失败' });
        }).always(function () {
            setFootBusy($body, false);
        });
    }

    function collectParamValues($body) {
        var values = {};
        $body.find('#pvParams [data-pname]').each(function () {
            var name = $(this).attr('data-pname');
            if (this.multiple) {
                var picked = $(this).val() || [];
                values[name] = picked.join(',');
            } else {
                values[name] = textOf($(this).val());
            }
        });
        return values;
    }


    function formatValue(value, format) {
        if (value === null || value === undefined || value === '') { return ''; }
        var num = Number(value);
        if (format === 'int') { return isNaN(num) ? String(value) : String(Math.round(num)); }
        if (format === 'number') { return isNaN(num) ? String(value) : num.toFixed(2); }
        if (format === 'money') { return isNaN(num) ? String(value) : '￥' + num.toFixed(2); }
        if (format === 'percent') { return isNaN(num) ? String(value) : (num * 100).toFixed(2) + '%'; }
        if (format === 'date') { return String(value).slice(0, 10); }
        if (format === 'datetime') { return String(value).slice(0, 19); }
        return String(value);
    }

    function summaryValue(rows, index, type) {
        var nums = [], i, n;
        for (i = 0; i < rows.length; i++) {
            n = Number(rows[i][index]);
            if (!isNaN(n) && rows[i][index] !== '' && rows[i][index] !== null) { nums.push(n); }
        }
        if (type === 'count') { return rows.length; }
        if (!nums.length) { return ''; }
        if (type === 'sum') { var s = 0; for (i = 0; i < nums.length; i++) { s += nums[i]; } return s; }
        if (type === 'avg') { var a = 0; for (i = 0; i < nums.length; i++) { a += nums[i]; } return a / nums.length; }
        if (type === 'max') { var mx = nums[0]; for (i = 1; i < nums.length; i++) { if (nums[i] > mx) { mx = nums[i]; } } return mx; }
        if (type === 'min') { var mn = nums[0]; for (i = 1; i < nums.length; i++) { if (nums[i] < mn) { mn = nums[i]; } } return mn; }
        return '';
    }

    /** 按页面模板铺纸张：内外边距 / 字体 / 标题样式（设计区要按纸张宽度缩放，所以先铺纸张再渲染组件） */
    function applyPaperStyle($body, tpl) {
        var paper = $body.find('#pvPaper');
        var pageWidth = tpl.paper === 'A5' ? 148 : (tpl.paper === 'A3' ? 297 : 210);
        var pageHeight = tpl.paper === 'A5' ? 210 : (tpl.paper === 'A3' ? 420 : 297);
        if (tpl.orientation === 'landscape') {
            var tmp = pageWidth; pageWidth = pageHeight; pageHeight = tmp;
        }
        paper.css({
            'min-height': Math.round(pageHeight * 0.9) + 'px',
            'padding-top': intOf(tpl.marginTop, 12) + 'px',
            'padding-right': intOf(tpl.marginRight, 10) + 'px',
            'padding-bottom': intOf(tpl.marginBottom, 12) + 'px',
            'padding-left': intOf(tpl.marginLeft, 10) + 'px',
            'font-family': tpl.fontFamily || 'Microsoft YaHei',
            'font-size': intOf(tpl.fontSize, 12) + 'px'
        });
        var $title = $body.find('#pvTitle');
        $title.css({
            'text-align': tpl.titleAlign || 'center',
            'font-size': intOf(tpl.titleSize, 18) + 'px',
            'font-weight': boolOf(tpl.titleBold) ? '700' : '400'
        });
    }

    function renderPreviewPaper($body, data) {
        var tpl = data.template || currentTemplate();
        var design = data.design || currentDesign();
        var mapped = data.mapped || [];
        var rows = data.rows || [];
        var visible = [], i;
        for (i = 0; i < mapped.length; i++) {
            if (boolOf(mapped[i].visible)) { visible.push(mapped[i]); }
        }
        /* 行号是「这张报表」的设计属性：每次打开查看窗时按 design.showRowNo 初始化一次，
           之后翻页 / 最大化重排都不再重置（用户右键改过的要保持） */
        if (!pvState.rowNoInit) {
            pvState.showRowNo = boolOf(design.showRowNo);
            pvState.rowNoInit = true;
        }
        applyPaperStyle($body, tpl);
        renderPvBands($body, design, tpl);
        renderPvFreeLayer($body, data);
        if (!visible.length) {
            $body.find('#pvTableWrap').html('<div class="rpt-pv__empty">没有可见的列：在右栏「字段属性」里把列设为显示</div>');
            return;
        }
        var totalPages = Math.max(1, Math.ceil(rows.length / pvState.pageSize));
        if (pvState.page > totalPages) { pvState.page = totalPages; }
        var start = (pvState.page - 1) * pvState.pageSize;
        var pageRows = rows.slice(start, start + pvState.pageSize);

        var showNo = boolOf(pvState.showRowNo);
        var colgroup = '<colgroup>';
        var head = '<thead><tr>';
        if (showNo) {
            colgroup += '<col style="width:56px">';
            head += '<th style="text-align:center">序号</th>';
        }
        for (i = 0; i < visible.length; i++) {
            colgroup += '<col style="width:' + esc(intOf(visible[i].width, 120)) + 'px">';
            head += '<th style="text-align:' + esc(visible[i].headerAlign || 'center') + '">' +
                esc(visible[i].label || visible[i].field) + '</th>';
        }
        colgroup += '</colgroup>';
        head += '</tr></thead>';

        var body = '<tbody>';
        for (var r = 0; r < pageRows.length; r++) {
            body += '<tr>';
            if (showNo) {
                body += '<td class="rpt-pv__no" style="text-align:center">' + (start + r + 1) + '</td>';
            }
            for (i = 0; i < visible.length; i++) {
                var idx = intOf(visible[i].index, -1);
                var cell = idx >= 0 ? pageRows[r][idx] : '';
                body += '<td style="text-align:' + esc(visible[i].align || 'left') + '">' +
                    esc(formatValue(cell, visible[i].format)) + '</td>';
            }
            body += '</tr>';
        }
        if (!pageRows.length) {
            body += '<tr><td colspan="' + (visible.length + (showNo ? 1 : 0)) +
                '" class="rpt-pv__none">没有查询到数据</td></tr>';
        }
        body += '</tbody>';

        var foot = '', hasSummary = false;
        var summaryRow = '<tfoot><tr>';
        if (showNo) { summaryRow += '<td></td>'; }
        for (i = 0; i < visible.length; i++) {
            var sv = '';
            if (visible[i].summary && visible[i].summary !== 'none') {
                hasSummary = true;
                sv = formatValue(summaryValue(pageRows, intOf(visible[i].index, -1), visible[i].summary),
                    visible[i].format === 'text' ? 'text' : visible[i].format);
                if (visible[i].summary === 'count') { sv = String(pageRows.length); }
            }
            summaryRow += '<td style="text-align:' + esc(visible[i].align || 'left') + '">' +
                (sv === '' ? '' : esc(sv)) + '</td>';
        }
        summaryRow += '</tr></tfoot>';
        if (hasSummary) { foot = summaryRow; }

        $body.find('#pvTableWrap').html(
            '<table class="rpt-pv__table' + (boolOf(design.bordered) ? ' is-bordered' : '') +
            (boolOf(design.zebra) ? ' is-zebra' : '') + (boolOf(tpl.compact) ? ' is-compact' : '') + '">' +
            colgroup + head + body + foot + '</table>');

        var footer = [];
        if (design.footerText) { footer.push(design.footerText); }
        if (boolOf(tpl.showPageNo)) { footer.push('第 ' + pvState.page + ' 页 / 共 ' + totalPages + ' 页'); }
        if (boolOf(tpl.showTime)) { footer.push('打印时间：' + (data.executedAt || nowText())); }
        footer.push('共 ' + rows.length + ' 行');
        drawPreviewFooter($body, footer, totalPages);
    }

    /* ==================================================================
       数据表右键菜单：行号（序号列）显示 / 隐藏
       ------------------------------------------------------------------
       · 行号是「这张报表」的设计属性 design.showRowNo：预览窗里改了就标记画布已修改，
         保存后随 designJson 落库；运行窗（已保存报表）里改只在本次查看生效；
       · 打开序号列后，预览 / 打印 / 导出（PDF、Excel）都会在最左侧多一列自动递增的序号。
       ================================================================== */
    function closeTableMenu() {
        if (CTX_MENU) { CTX_MENU.remove(); CTX_MENU = null; }
    }

    /** 打开数据表右键菜单（位置夹在视口内） */
    function openTableMenu($body, x, y) {
        closeTableMenu();
        var showNo = boolOf(pvState.showRowNo);
        var $menu = $('<div class="rpt-ctxmenu" role="menu"></div>');
        $menu.append($('<div class="rpt-ctxmenu__item" data-act="rownum" role="menuitem"></div>')
            .append($('<span class="rpt-ctxmenu__check"></span>').text(showNo ? '✓' : ''))
            .append($('<span></span>').text('显示行号（序号列）')));
        $menu.append('<div class="rpt-ctxmenu__sep"></div>');
        $menu.append($('<div class="rpt-ctxmenu__hint"></div>')
            .text('设为「是」时表格最左侧插入自动递增的序号列，打印 / 导出同样生效'));
        $menu.appendTo(document.body);
        var w = $menu.outerWidth() || 200, h = $menu.outerHeight() || 80;
        var vw = $(window).width() || 1280, vh = $(window).height() || 800;
        $menu.css({
            left: Math.max(4, Math.min(x, vw - w - 8)),
            top: Math.max(4, Math.min(y, vh - h - 8))
        });
        $menu.on('click', '[data-act="rownum"]', function (e) {
            e.stopPropagation();
            setRowNo($body, !boolOf(pvState.showRowNo));
            closeTableMenu();
        });
        CTX_MENU = $menu;
        return $menu;
    }

    /** 行号显示开关：重画表格（打印 / 导出会读同一个开关） */
    function setRowNo($body, on) {
        pvState.showRowNo = !!on;
        pvState.rowNoInit = true;
        if (pv.mode === 'preview') {                 // 预览窗对应「正在编辑的画布」，改了就等保存
            dstate().design.design.showRowNo = !!on;
            if (typeof pv.onDirty === 'function') { pv.onDirty(); }
        }
        if (pvState.result) { renderPreviewPaper($body, pvState.result); }
        UI.message({
            type: 'success',
            message: on ? '已显示行号：表格最左侧多出「序号」列（打印 / 导出同样生效）' : '已隐藏行号'
        });
    }

    $(document).on('click', function () { closeTableMenu(); });
    $(window).on('scroll resize', function () { closeTableMenu(); });
    $(document).on('keydown', function (e) { if (e.keyCode === 27) { closeTableMenu(); } });

    function drawPreviewFooter($body, parts, totalPages) {
        var $foot = $body.find('#pvFooter');
        $foot.empty();
        for (var i = 0; i < parts.length; i++) {
            if (i) { $foot.append('<span class="rpt-pv__sep">·</span>'); }
            $foot.append($('<span></span>').text(parts[i]));
        }
        if (totalPages > 1) {
            if (parts.length) { $foot.append('<span class="rpt-pv__sep">·</span>'); }
            var $pager = $('<span class="rpt-pv__pager"></span>');
            $pager.append($('<button type="button" class="el-button el-button--small" data-pvpage="prev">上一页</button>')
                .prop('disabled', pvState.page <= 1));
            $pager.append($('<span class="rpt-pv__pageno"></span>').text(pvState.page + ' / ' + totalPages));
            $pager.append($('<button type="button" class="el-button el-button--small" data-pvpage="next">下一页</button>')
                .prop('disabled', pvState.page >= totalPages));
            $foot.append($pager);
        }
    }

    /* ==================================================================
       十.1 打印 / 导出（都是「全部查询结果」）
       ------------------------------------------------------------------
       · 页面上一次只渲染 20 行、预览接口也只取 PREVIEW_ROWS 行；点打印 / 导出时，
         若结果被截断，先按 EXPORT_ROWS 重新查一次，再一次性输出整份结果；
       · 打印：把报表渲成一份独立 HTML 写进隐藏 iframe，只打印这个 iframe
         （不分页、不打断主界面，页眉页脚 / 纸张方向按页面模板走）；
       · 导出：Excel / PDF 由后端生成（openpyxl / reportlab），拿 blob 直接下载。
       ================================================================== */
    var EXPORT_ROWS = 20000;              // 与后端 config.REPORT_EXPORT_ROWS 保持一致

    /** 结果里可见的列（列属性 visible=false 的不打印 / 不导出） */
    function visibleColumnsOf(data) {
        var mapped = (data && data.mapped) || [], out = [], i;
        for (i = 0; i < mapped.length; i++) {
            if (boolOf(mapped[i].visible)) { out.push(mapped[i]); }
        }
        return out;
    }

    /** 取「全部结果」：被截断时按更大的行数重查一次（走 preview，不增加调用次数） */
    function fetchAllResult($body) {
        var dfd = $.Deferred();
        var cur = pvState.result;
        if (!cur) {
            dfd.reject(new Error('先点「' + (pv.mode === 'run' ? '执行查询' : '执行预览') +
                '」拿到结果，再打印 / 导出'));
            return dfd.promise();
        }
        if (!cur.truncated) { dfd.resolve(cur); return dfd.promise(); }
        var paramValues = collectParamValues($body);
        var req;
        if (pv.mode === 'run' && pv.row) {
            req = Api.report.preview({ id: pv.row.id, paramValues: paramValues, maxRows: EXPORT_ROWS });
        } else {
            var payload = buildPayload(false);
            payload.id = dstate().design.id || '';
            payload.paramValues = paramValues;
            payload.maxRows = EXPORT_ROWS;
            req = Api.report.preview(payload);
        }
        req.done(function (data) { pvState.result = data; dfd.resolve(data); })
            .fail(function (err) { dfd.reject(err); });
        return dfd.promise();
    }

    /** 打印页里的参数说明：工号=E0001　科室=内科 */
    function printParamsLine(data) {
        var params = (data && data.params) || [];
        var values = (data && data.paramValues) || {};
        var parts = [], i, name, value;
        for (i = 0; i < params.length; i++) {
            name = textOf(params[i].name);
            if (!name) { continue; }
            value = values[name];
            if (value === undefined || value === null || textOf(value) === '') { continue; }
            parts.push(textOf(params[i].label || name) + '=' + textOf(value));
        }
        return parts.join('　');
    }

    /** 纸张尺寸（mm）：除 A5 / A3 / Letter 外都按 A4；横向时宽高互换 */
    function paperMm(tpl) {
        tpl = tpl || {};
        var w = tpl.paper === 'A5' ? 148 : (tpl.paper === 'A3' ? 297 : (tpl.paper === 'Letter' ? 216 : 210));
        var h = tpl.paper === 'A5' ? 210 : (tpl.paper === 'A3' ? 420 : (tpl.paper === 'Letter' ? 279 : 297));
        if (tpl.orientation === 'landscape') { var t = w; w = h; h = t; }
        return { w: w, h: h };
    }

    function printCss(tpl, design) {
        var mm = paperMm(tpl);
        var fs = intOf(tpl.fontSize, 12);
        var pad = boolOf(tpl.compact) ? '1mm 1.2mm' : '2mm 1.5mm';
        var css = [];
        css.push('@page { size: ' + mm.w + 'mm ' + mm.h + 'mm; margin: ' + intOf(tpl.marginTop, 12) + 'mm ' +
            intOf(tpl.marginRight, 10) + 'mm ' + intOf(tpl.marginBottom, 12) + 'mm ' +
            intOf(tpl.marginLeft, 10) + 'mm; }');
        css.push('* { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }');
        css.push('body { margin: 0; color: #303133; font-size: ' + Math.max(8, fs - 2) + 'pt;' +
            ' font-family: "' + (tpl.fontFamily || 'Microsoft YaHei') + '", "Microsoft YaHei", SimSun, sans-serif; }');
        css.push('h1 { margin: 0 0 2mm; font-size: ' + intOf(tpl.titleSize, 18) + 'pt;' +
            ' text-align: ' + (tpl.titleAlign || 'center') + '; font-weight: ' +
            (boolOf(tpl.titleBold) ? '700' : '400') + '; }');
        css.push('.sub { margin: 0 0 1.5mm; text-align: center; font-size: ' + Math.max(8, fs - 3) +
            'pt; color: #909399; }');
        css.push('.params { margin: 0 0 2mm; font-size: ' + Math.max(8, fs - 3) + 'pt; color: #606266; }');
        css.push('table { width: 100%; border-collapse: collapse; table-layout: fixed; }');
        css.push('thead { display: table-header-group; }');
        css.push('tr { page-break-inside: avoid; }');
        css.push('th, td { padding: ' + pad + '; word-break: break-all; font-size: ' + Math.max(8, fs - 2) + 'pt; }');
        css.push('th { background: #f2f6fc; font-weight: 600; text-align: center; }');
        css.push('.bordered th, .bordered td { border: .5pt solid #dcdfe6; }');
        css.push('.plain th, .plain td { border: 0; border-bottom: .4pt solid #ebeef5; }');
        css.push('.zebra tbody tr:nth-child(even) td { background: #fafafa; }');
        css.push('tfoot td { background: #f5f7fa; font-weight: 700; border-top: .8pt solid #dcdfe6; }');
        css.push('.none { text-align: center; color: #909399; padding: 8mm 0; }');
        css.push('.foot { margin-top: 3mm; display: flex; justify-content: space-between;' +
            ' font-size: 8pt; color: #909399; }');
        css.push('.wm { position: fixed; top: 40%; left: 0; right: 0; text-align: center;' +
            ' font-size: 40pt; color: rgba(0, 0, 0, .06); transform: rotate(20deg); pointer-events: none; }');
        /* 页眉 / 页脚：靠外层表格的 thead / tfoot 每页重复（Chromium 会为它们留出高度），
           所以这里只定义样式，不能再 position:fixed —— fixed 不占流内空间，会把正文压住 */
        css.push('.sheet { width: 100%; border-collapse: collapse; table-layout: fixed; }');
        css.push('.sheet > thead > tr > td, .sheet > tbody > tr > td, .sheet > tfoot > tr > td {' +
            ' padding: 0; border: 0; vertical-align: top; }');
        css.push('.sheet__band { padding: 0 0 1.5mm; }');
        css.push('.sheet__band--foot { padding: 1.5mm 0 0; }');
        /* 没配页眉 / 页脚时不要留一条空带（否则每页多出几 pt 空白） */
        css.push('.sheet__band--empty { padding: 0; height: 0; line-height: 0; font-size: 0; }');
        css.push('.pageband .rpt-pageband__text { font-size: ' + Math.max(8, fs - 3) + 'pt; color: #606266; }');
        css.push('.pageband .rpt-pageband { width: 100%; }');
        /* ---- 设计区组件：和预览页一样绝对定位，区域里的子组件跟着区域走 ---- */
        css.push('.free { position: relative; margin: 0 0 3mm; page-break-inside: avoid; break-inside: avoid; }');
        css.push('.free-stage { position: relative; }');
        css.push('.rpt-el { position: absolute; box-sizing: border-box; }');
        css.push('.rpt-el--label { display: flex; align-items: center; overflow: hidden; }');
        css.push('.rpt-el--label > span { display: block; width: 100%; line-height: 1.4;' +
            ' white-space: pre-wrap; word-break: break-word; }');
        css.push('.rpt-el--line { display: flex; align-items: center; }');
        css.push('.rpt-el--line i { display: block; margin: auto; }');
        css.push('.rpt-el--box, .rpt-el__boxinner { overflow: visible; }');
        css.push('.rpt-el--image { overflow: hidden; background: #f5f7fa; }');
        css.push('.rpt-el--image img { width: 100%; height: 100%; display: block; }');
        css.push('.rpt-el--image__none { position: absolute; left: 0; top: 0; right: 0; bottom: 0;' +
            ' display: flex; align-items: center; justify-content: center; font-size: 11px; color: #a8abb2; }');
        css.push('.rpt-el--chart, .rpt-el--table { background: #fff; border: 1px solid #ebeef5;' +
            ' border-radius: 4px; overflow: hidden; }');
        css.push('.rpt-el__chart-title { padding: 4px 8px 0; font-size: 12px; font-weight: 600;' +
            ' white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }');
        css.push('.rpt-el__chart-body { width: 100%; height: calc(100% - 20px); }');
        css.push('.rpt-el__chart-body svg { display: block; width: 100%; height: 100%; }');
        css.push('.rpt-el__table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }');
        css.push('.rpt-el__table thead { display: table-row-group; }');
        css.push('.rpt-el__table th, .rpt-el__table td { padding: 2px 4px; white-space: normal;' +
            ' border: 0; border-bottom: .5pt solid #ebeef5; }');
        css.push('.rpt-el__table th { background: #f2f6fc; font-weight: 600; }');
        css.push('.rpt-tool__empty { font-size: 11px; color: #909399; padding: 4px; }');
        return css.join('\n');
    }

    /** 把结果渲成一份可打印的独立 HTML（全部行；表头在每页重复） */
    function buildPrintHtml(data) {
        var tpl = data.template || currentTemplate();
        var design = data.design || currentDesign();
        var cols = visibleColumnsOf(data);
        var rows = data.rows || [];
        var report = data.report || {};
        var title = report.reportName || textOf(design.title) || textOf(dstate().design.reportName) || '报表';
        var i, r;

        var showNo = boolOf(pvState.showRowNo);
        var colgroup = '', head = '';
        if (showNo) {
            colgroup += '<col style="width:56px">';
            head += '<th style="text-align:center">序号</th>';
        }
        for (i = 0; i < cols.length; i++) {
            colgroup += '<col style="width:' + intOf(cols[i].width, 120) + 'px">';
            head += '<th style="text-align:' + esc(cols[i].headerAlign || 'center') + '">' +
                esc(cols[i].label || cols[i].field) + '</th>';
        }

        var body = '';
        for (r = 0; r < rows.length; r++) {
            body += '<tr>';
            if (showNo) { body += '<td style="text-align:center">' + (r + 1) + '</td>'; }
            for (i = 0; i < cols.length; i++) {
                var idx = intOf(cols[i].index, -1);
                body += '<td style="text-align:' + esc(cols[i].align || 'left') + '">' +
                    esc(formatValue(idx >= 0 ? rows[r][idx] : '', cols[i].format)) + '</td>';
            }
            body += '</tr>';
        }
        if (!rows.length) {
            body = '<tr><td class="none" colspan="' + (cols.length + (showNo ? 1 : 0) || 1) +
                '">没有查询到数据</td></tr>';
        }

        var sumCells = '', hasSum = false;
        if (showNo) { sumCells += '<td></td>'; }
        for (i = 0; i < cols.length; i++) {
            var sv = '';
            if (cols[i].summary && cols[i].summary !== 'none') {
                hasSum = true;
                sv = formatValue(summaryValue(rows, intOf(cols[i].index, -1), cols[i].summary),
                    cols[i].format === 'text' ? 'text' : cols[i].format);
                if (cols[i].summary === 'count') { sv = String(rows.length); }
            }
            sumCells += '<td style="text-align:' + esc(cols[i].align || 'left') + '">' + esc(sv) + '</td>';
        }

        var foot = [];
        if (design.footerText) { foot.push(esc(design.footerText)); }
        foot.push('共 ' + rows.length + ' 行');
        if (boolOf(tpl.showTime)) { foot.push('打印时间：' + esc(nowText())); }

        var html = [];
        html.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">');
        html.push('<title>' + esc(title) + '</title>');
        html.push('<style>' + printCss(tpl, design) + '</style></head><body>');
        if (tpl.watermark) { html.push('<div class="wm">' + esc(tpl.watermark) + '</div>'); }
        var printHead = pageBandHtml('header', design, tpl);
        var printFoot = pageBandHtml('footer', design, tpl);
        /* 页眉 / 页脚放进外层表格的 thead / tfoot：
           Chromium 打印时会把 thead、tfoot 每页重复一次，并且**按它们的高度给正文让位**。
           之前用 position:fixed 画页眉，fixed 元素不占流内空间 → 从第 2 页起正文（含重复的表头行）
           会直接从纸张顶端排，被页眉压住。换成 thead 后就不会重合了。 */
        html.push('<table class="sheet"><thead><tr>' +
            (printHead ? '<td class="sheet__band sheet__band--head">' + printHead + '</td>'
                : '<td class="sheet__band sheet__band--empty"></td>') +
            '</tr></thead><tbody><tr><td>');
        if (boolOf(design.showTitle)) { html.push('<h1>' + esc(title) + '</h1>'); }
        if (design.subtitle) { html.push('<div class="sub">' + esc(design.subtitle) + '</div>'); }
        var paramsLine = boolOf(design.showParams) ? printParamsLine(data) : '';
        if (paramsLine) { html.push('<div class="params">参数：' + esc(paramsLine) + '</div>'); }
        var freeList = elementsOf(data);
        if (freeList.length) {
            /* 设计区按「组件占用范围」铺一张画布，超出可打印宽度就整体等比缩小 ——
               这样区域（box）与区域里的子组件、图表、明细表的位置关系和预览页完全一致，不会各走各的 */
            var bounds = elementBounds(freeList, 0, 0);
            var stageW = Math.max(80, Math.ceil(bounds.right) + 2);
            var stageH = Math.max(30, Math.ceil(bounds.bottom) + 2);
            var pageSpec = paperMm(tpl);
            var printable = Math.max(160, (pageSpec.w - intOf(tpl.marginLeft, 10) -
                intOf(tpl.marginRight, 10)) * 96 / 25.4);
            var scale = stageScale(stageW, printable);
            html.push('<div class="free" style="height:' + Math.ceil(stageH * scale) + 'px">' +
                '<div class="free-stage" style="width:' + stageW + 'px;height:' + stageH +
                'px;transform:scale(' + scale.toFixed(4) + ');transform-origin:left top;' +
                '-webkit-transform-origin:left top">' +
                elementsHtml(freeList, {
                    mode: 'print',
                    mapped: data.mapped || [],
                    rows: data.rows || []
                }) + '</div></div>');
        }
        html.push('<table class="data ' + (boolOf(design.bordered) ? 'bordered' : 'plain') +
            (boolOf(design.zebra) ? ' zebra' : '') + '">');
        html.push('<colgroup>' + colgroup + '</colgroup>');
        html.push('<thead><tr>' + head + '</tr></thead>');
        html.push('<tbody>' + body + '</tbody>');
        if (hasSum) { html.push('<tfoot><tr>' + sumCells + '</tr></tfoot>'); }
        html.push('</table>');
        html.push('<div class="foot"><span>' + foot.join('　·　') + '</span></div>');
        html.push('</td></tr></tbody><tfoot><tr>' +
            (printFoot ? '<td class="sheet__band sheet__band--foot">' + printFoot + '</td>'
                : '<td class="sheet__band sheet__band--empty"></td>') +
            '</tr></tfoot></table></body></html>');
        return html.join('');
    }

    /** 隐藏 iframe 承载打印页：只打印它，不打断当前页面（Chrome / Edge 都支持） */
    function writePrintFrame(html) {
        var frame = document.getElementById('rptPrintFrame');
        if (!frame) {
            frame = document.createElement('iframe');
            frame.id = 'rptPrintFrame';
            frame.className = 'rpt-print-frame';
            frame.setAttribute('aria-hidden', 'true');
            document.body.appendChild(frame);
        }
        var doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        if (!doc) { return null; }
        doc.open();
        doc.write(html);
        doc.close();
        return frame.contentWindow || null;
    }

    /** 打印：全部查询结果（不受页面上 20 行分页影响） */
    function printReport($body) {
        if (!pvState.result) {
            UI.message({ type: 'warning', message: '先执行一次查询，再打印' });
            return;
        }
        setFootBusy($body, true);
        footInfo($body, '正在整理打印数据（全部查询结果）…', 'busy');
        fetchAllResult($body).done(function (data) {
            var win = writePrintFrame(buildPrintHtml(data));
            setFootBusy($body, false);
            if (!win) {
                footInfo($body, '', '');
                UI.message({ type: 'error', message: '打印页创建失败，请刷新页面后重试' });
                return;
            }
            footInfo($body, '打印页已就绪：共 ' + intOf(data.rowCount, 0) + ' 行' +
                (data.truncated ? '（超出单次上限 ' + EXPORT_ROWS + ' 行）' : '') +
                '，正在调起打印…', 'ok');
            window.setTimeout(function () {
                try {
                    win.focus();
                    if (typeof win.print === 'function') { win.print(); }
                } catch (e) { /* jsdom / 无头环境没有 print，忽略 */ }
            }, 150);
        }).fail(function (err) {
            setFootBusy($body, false);
            footInfo($body, '', '');
            UI.message({ type: 'error', message: err.message || '打印失败' });
        });
    }

    function saveBlob(blob, filename) {
        try {
            var canBlob = window.URL && typeof window.URL.createObjectURL === 'function';
            if (!canBlob) { throw new Error('当前浏览器不支持文件下载'); }
            var url = window.URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = filename || 'report';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            window.setTimeout(function () {
                if (a.parentNode) { a.parentNode.removeChild(a); }
                window.URL.revokeObjectURL(url);
            }, 1500);
        } catch (e) {
            UI.message({ type: 'error', message: '下载失败：' + (e.message || e) });
        }
    }

    /** 导出 Excel / PDF：后端按「全部查询结果」生成文件，前端拿 blob 直接下载 */
    function exportReport($body, fmt) {
        if (!pvState.result) {
            UI.message({ type: 'warning', message: '先执行一次查询，再导出' });
            return;
        }
        var label = fmt === 'pdf' ? 'PDF' : 'Excel';
        var paramValues = collectParamValues($body);
        var rowNo = boolOf(pvState.showRowNo) ? 1 : 0;      // 右键里设的「行号」跟着导出走
        var args;
        if (pv.mode === 'run' && pv.row) {
            args = { id: pv.row.id, format: fmt, paramValues: paramValues, maxRows: EXPORT_ROWS,
                     showRowNo: rowNo };
        } else {
            var payload = buildPayload(false);
            args = $.extend({}, payload, {
                id: dstate().design.id || '',
                paramsJson: payload.params,
                format: fmt,
                paramValues: paramValues,
                maxRows: EXPORT_ROWS,
                showRowNo: rowNo
            });
            delete args.params;
        }
        setFootBusy($body, true);
        footInfo($body, '正在生成 ' + label + '（全部查询结果）…', 'busy');
        Api.report.exportFile(args).done(function (file) {
            saveBlob(file.blob, file.filename);
            footInfo($body, '已导出 ' + label + '：' + intOf(file.rowCount, 0) + ' 行' +
                (file.truncated ? '（超出单次上限，仅含前 ' + EXPORT_ROWS + ' 行）' : '（全部结果）'), 'ok');
            UI.message({ type: 'success', message: label + ' 已开始下载：' + (file.filename || '') });
        }).fail(function (err) {
            footInfo($body, '', '');
            UI.message({ type: 'error', message: err.message || (label + ' 导出失败') });
        }).always(function () {
            setFootBusy($body, false);
        });
    }

    $(document).on('click', '[data-pvpage]', function () {
        if (!pvState.result) { return; }
        var dir = $(this).attr('data-pvpage');
        var $body = $(this).closest('.rpt-pv');
        pvState.page += (dir === 'next' ? 1 : -1);
        renderPreviewPaper($body, pvState.result);
    });
    /**
     * 报表中心（以及其它「只看不设计」的页面）：按 id 打开已保存报表的查看窗并执行。
     * 停用的报表直接提示，不引导去设计器。
     */
    function openSaved(id, opt) {
        var o = opt || {};
        if (!id) { return null; }
        pvStatus('正在读取报表信息…');
        return Api.report.detail(id).done(function (row) {
            if (!boolOf(row.enabled)) {
                pvStatus('报表「' + row.reportName + '」已停用，不能运行', 'warn');
                UI.message({ type: 'warning', message: '报表「' + row.reportName + '」已停用，不能运行' });
                return;
            }
            pv.mode = 'run';
            pv.row = row;
            if (typeof o.onBeforeRun === 'function') { o.onBeforeRun(row); }
            showViewer({
                params: row.params || [],
                title: row.reportName,
                subtitle: (row.design || {}).subtitle || '',
                runText: o.runText || '执行查询',
                dlgTitle: '查看报表 —— ' + row.reportName + '（' + row.code + '）',
                onRun: runSavedReport
            });
        }).fail(function (err) {
            pvStatus('读取报表失败：' + ((err && err.message) || ''), 'error');
            UI.message({ type: 'error', message: (err && err.message) || '读取报表失败' });
        });
    }

    /* 对外：查看窗 + 渲染 / 排版 / 打印导出的工具（设计器与报表中心共用一份） */
    window.ReportViewer = {
        pv: pv,
        pvState: pvState,
        esc: esc,
        textOf: textOf,
        boolOf: boolOf,
        intOf: intOf,
        nowText: nowText,
        optionsHtml: optionsHtml,
        pageBandHtml: pageBandHtml,
        elementsOf: elementsOf,
        walkElements: walkElements,
        elementStyle: elementStyle,
        visibleMapped: visibleMapped,
        tableRows: tableRows,
        tableCols: tableCols,
        tableCells: tableCells,
        elTableMarkup: elTableMarkup,
        chartPoints: chartPoints,
        chartSvg: chartSvg,
        elementHtml: elementHtml,
        elementsHtml: elementsHtml,
        elementsBottom: elementsBottom,
        elementBounds: elementBounds,
        renderPvBands: renderPvBands,
        stageScale: stageScale,
        renderPvFreeLayer: renderPvFreeLayer,
        paramInputHtml: paramInputHtml,
        setRunButton: setRunButton,
        footInfo: footInfo,
        showEfficiency: showEfficiency,
        setFootBusy: setFootBusy,
        showViewer: showViewer,
        runSavedReport: runSavedReport,
        collectParamValues: collectParamValues,
        formatValue: formatValue,
        summaryValue: summaryValue,
        applyPaperStyle: applyPaperStyle,
        renderPreviewPaper: renderPreviewPaper,
        closeTableMenu: closeTableMenu,
        openTableMenu: openTableMenu,
        setRowNo: setRowNo,
        drawPreviewFooter: drawPreviewFooter,
        visibleColumnsOf: visibleColumnsOf,
        fetchAllResult: fetchAllResult,
        printParamsLine: printParamsLine,
        paperMm: paperMm,
        printCss: printCss,
        buildPrintHtml: buildPrintHtml,
        writePrintFrame: writePrintFrame,
        printReport: printReport,
        saveBlob: saveBlob,
        exportReport: exportReport,
        PREVIEW_ROWS: PREVIEW_ROWS,
        openSaved: openSaved,
        currentTemplate: currentTemplate,
        currentDesign: currentDesign
    };
});
