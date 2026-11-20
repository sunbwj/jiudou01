/* ==========================================================================
   im-shot.js —— 即时对话「截屏 + 标注」编辑器
   --------------------------------------------------------------------------
   由 message.js 的 takeShot() 抓帧后调用：
       window.IMShot.open(dataUrl, { onSend(url, w, h), onCancel() })

   两个阶段：
     ① select   按住鼠标拖动，框出要截取的区域（可重选）
     ② annotate 在选区上标注：画框 / 画圈 / 画线 / 画箭头 / 文本，可撤销

   设计要点：
     · 标注坐标一律存「相对整图的归一化比例（0~1）」，好处有两个：
       ① 窗口缩放后重绘不会跑偏；② 导出原分辨率裁剪图时能复用同一套绘制函数。
     · 线宽、字号也存归一化比例（相对整图宽/高），所以「屏幕上看到的粗细」
       与「导出图里的粗细」是同一比例，不会出现预览细、导出粗。
     · 编辑器优先挂到 window.top（主框架内嵌时遮住整个浏览器窗口，体验最好），
       跨域取不到 top 时自动退回当前文档；DOM 一律用宿主文档的 createElement。
     · canvas 拿不到 2d 上下文时（如 jsdom）只画不了标注，不影响状态机，
       方便单测断言逻辑。
   ========================================================================== */
(function (window, document) {
    'use strict';

    var MIN_SEL = 0.008;          // 选区最小比例，低于此视为误点
    var MIN_MARK = 0.004;         // 标注最小尺寸，低于此视为误点
    var TEXT_FS = 0.024;          // 文本字号（相对整图高度）

    var COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff'];

    /* 工具图标（16x16 viewBox，currentColor 填充/描边） */
    var ICONS = {
        rect: '<path fill="none" stroke="currentColor" stroke-width="1.6" d="M2.5 3.5h11v9h-11z"/>',
        ellipse: '<ellipse cx="8" cy="8" rx="5.5" ry="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
        line: '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M3 13L13 3"/>',
        arrow: '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M3 13L12.5 3.5"/>' +
               '<path fill="currentColor" d="M13.5 2.5l-1 4.2-3.2-3.2z"/>',
        text: '<path fill="currentColor" d="M3 3h10v2h-4v8H7V5H3z"/>'
    };
    var TOOLS = [
        { id: 'rect', label: '画框' },
        { id: 'ellipse', label: '画圈' },
        { id: 'line', label: '画线' },
        { id: 'arrow', label: '画箭头' },
        { id: 'text', label: '文本' }
    ];

    /* 全局状态（也暴露出去，便于探针 / 单测断言） */
    var ST = {
        open: false,
        img: null, natW: 0, natH: 0,
        dispW: 0, dispH: 0,
        phase: 'select',          // select | annotate
        sel: null,                // {x0,y0,x1,y1} 归一化
        tool: 'rect',
        color: COLORS[0],
        lw: 0.0035,
        marks: [],                // 已确认的标注
        drawing: null,            // 正在拖拽的标注
        dragFrom: null,
        lastText: '',
        onSend: null,
        onCancel: null,
        doc: null, win: null, root: null, cv: null, imgEl: null,
        bound: false
    };

    var CSS = [
        '.im-shot{position:fixed;left:0;top:0;right:0;bottom:0;z-index:4000;display:flex;',
        'flex-direction:column;background:rgba(16,18,22,.94);',
        'font-family:-apple-system,"Microsoft YaHei","PingFang SC",sans-serif;-webkit-user-select:none;user-select:none}',
        '.im-shot[hidden]{display:none !important}',
        '.im-shot__bar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 14px;',
        'background:#23262d;color:#e5e9f0;box-shadow:0 1px 0 rgba(255,255,255,.06)}',
        '.im-shot__title{font-size:13px;font-weight:600;margin-right:6px;white-space:nowrap}',
        '.im-shot__spacer{flex:1 1 auto}',
        '.im-shot__tools{display:flex;align-items:center;gap:4px}',
        '.im-shot__tools[hidden]{display:none !important}',
        '.im-shot__tool{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;',
        'border:1px solid transparent;border-radius:6px;background:transparent;color:#c8cedb;cursor:pointer;padding:0}',
        '.im-shot__tool svg{width:17px;height:17px}',
        '.im-shot__tool:hover{background:rgba(255,255,255,.1);color:#fff}',
        '.im-shot__tool.is-active{background:#0a84ff;border-color:#0a84ff;color:#fff}',
        '.im-shot__sep{width:1px;height:18px;margin:0 6px;background:rgba(255,255,255,.18)}',
        '.im-shot__colors{display:inline-flex;align-items:center;gap:6px}',
        '.im-shot__colors i{display:block;width:16px;height:16px;border-radius:50%;cursor:pointer;',
        'border:2px solid transparent;box-sizing:border-box}',
        '.im-shot__colors i.is-active{border-color:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.5)}',
        '.im-shot__btn{height:28px;padding:0 12px;border-radius:6px;border:1px solid rgba(255,255,255,.22);',
        'background:transparent;color:#e5e9f0;font-size:12px;cursor:pointer;white-space:nowrap}',
        '.im-shot__btn:hover{background:rgba(255,255,255,.1)}',
        '.im-shot__btn.is-primary{background:#0a84ff;border-color:#0a84ff;color:#fff}',
        '.im-shot__btn.is-primary:hover{background:#3d9bff}',
        '.im-shot__btn:disabled{opacity:.45;cursor:not-allowed}',
        '.im-shot__hintbar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:6px 16px 0;',
        'color:#9aa4b6;font-size:12px;min-height:24px}',
        '.im-shot__text{flex:0 0 auto;width:280px;height:26px;padding:0 9px;border-radius:5px;',
        'border:1px solid rgba(255,255,255,.28);background:#2c3038;color:#fff;font-size:12px;outline:none}',
        '.im-shot__text:focus{border-color:#0a84ff}',
        '.im-shot__text[hidden]{display:none !important}',
        '.im-shot__stage{flex:1 1 auto;position:relative;display:flex;align-items:center;',
        'justify-content:center;overflow:hidden;padding:10px 16px 16px}',
        '.im-shot__wrap{position:relative;line-height:0;box-shadow:0 6px 40px rgba(0,0,0,.55);',
        'background:#0b0c0f;border-radius:3px;overflow:hidden}',
        '.im-shot__wrap img{display:block;width:100%;height:100%}',
        '.im-shot__wrap canvas{position:absolute;left:0;top:0;cursor:crosshair}',
        '.im-shot__wrap.is-annotate canvas{cursor:crosshair}'
    ].join('');

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /* ---------------- 宿主文档（优先 top，跨域退回自身） ---------------- */
    function hostDoc() {
        try {
            var top = window.top;
            if (top && top !== window && top.document && top.document.body) { return top.document; }
        } catch (e) { /* 跨域，忽略 */ }
        return document;
    }

    function injectCSS(doc) {
        if (doc.getElementById('imShotEdStyle')) { return; }
        var st = doc.createElement('style');
        st.id = 'imShotEdStyle';
        st.textContent = CSS;
        (doc.head || doc.documentElement).appendChild(st);
    }

    /* ---------------- 模板 ---------------- */
    function tpl() {
        var tools = TOOLS.map(function (t) {
            return '<button type="button" class="im-shot__tool" data-tool="' + t.id + '" title="' + t.label + '"' +
                ' aria-label="' + t.label + '"><svg viewBox="0 0 16 16">' + ICONS[t.id] + '</svg></button>';
        }).join('');
        var colors = COLORS.map(function (c) {
            return '<i data-color="' + c + '" style="background:' + c + '" title="' + c + '"></i>';
        }).join('');
        return '' +
            '<div class="im-shot__bar">' +
                '<span class="im-shot__title">截屏标注</span>' +
                '<div class="im-shot__tools" id="imShotEdTools" hidden>' + tools +
                    '<span class="im-shot__sep"></span>' +
                    '<span class="im-shot__colors" id="imShotEdColors">' + colors + '</span>' +
                    '<span class="im-shot__sep"></span>' +
                    '<button type="button" class="im-shot__btn" data-act="undo" title="撤销上一步">撤销</button>' +
                    '<button type="button" class="im-shot__btn" data-act="reset" title="重新选择区域">重选</button>' +
                '</div>' +
                '<span class="im-shot__spacer"></span>' +
                '<button type="button" class="im-shot__btn" data-act="cancel">取消</button>' +
                '<button type="button" class="im-shot__btn is-primary" data-act="send" disabled>发送</button>' +
            '</div>' +
            '<div class="im-shot__hintbar">' +
                '<span id="imShotEdHint">按住鼠标拖动，选择要截取的区域</span>' +
                '<input type="text" id="imShotEdText" class="im-shot__text" maxlength="80"' +
                    ' placeholder="输入要标注的文字，再点图上位置" hidden>' +
            '</div>' +
            '<div class="im-shot__stage">' +
                '<div class="im-shot__wrap" id="imShotEdWrap">' +
                    '<img id="imShotEdImg" alt="截屏">' +
                    '<canvas id="imShotEdCanvas"></canvas>' +
                '</div>' +
            '</div>';
    }

    /* ---------------- 布局：把整图等比缩放进舞台 ---------------- */
    function layout() {
        if (!ST.root || !ST.natW || !ST.natH) { return; }
        var stage = ST.root.querySelector('.im-shot__stage');
        var wrap = ST.root.querySelector('.im-shot__wrap');
        if (!stage || !wrap) { return; }
        var sw = stage.clientWidth - 32;
        var sh = stage.clientHeight - 20;
        if (sw < 40 || sh < 40) { return; }
        var k = Math.min(sw / ST.natW, sh / ST.natH);
        ST.dispW = Math.max(24, Math.round(ST.natW * k));
        ST.dispH = Math.max(24, Math.round(ST.natH * k));
        wrap.style.width = ST.dispW + 'px';
        wrap.style.height = ST.dispH + 'px';
        if (ST.imgEl) {
            ST.imgEl.style.width = ST.dispW + 'px';
            ST.imgEl.style.height = ST.dispH + 'px';
        }
        redraw();
    }

    /* ---------------- 归一化选区 ---------------- */
    function normSel(s) {
        if (!s) { return null; }
        var x = Math.min(s.x0, s.x1), y = Math.min(s.y0, s.y1);
        return { x: x, y: y, w: Math.abs(s.x1 - s.x0), h: Math.abs(s.y1 - s.y0) };
    }

    /* ---------------- 绘制一个标注 ---------------- */
    function paintMark(ctx, m, boxW, boxH) {
        var lw = Math.max(1.2, (m.lw || ST.lw) * boxW);
        var x0 = m.x0 * boxW, y0 = m.y0 * boxH;
        var x1 = m.x1 * boxW, y1 = m.y1 * boxH;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = m.color || '#ff3b30';
        ctx.fillStyle = m.color || '#ff3b30';
        ctx.lineWidth = lw;
        if (m.type === 'rect') {
            ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        } else if (m.type === 'ellipse') {
            var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
            var rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
            if (rx > 0.5 && ry > 0.5 && ctx.ellipse) {
                ctx.beginPath();
                ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
        } else if (m.type === 'line') {
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
        } else if (m.type === 'arrow') {
            var ang = Math.atan2(y1 - y0, x1 - x0);
            var head = Math.max(9, lw * 4);
            var a1 = ang - Math.PI / 7, a2 = ang + Math.PI / 7;
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x1 - head * Math.cos(a1), y1 - head * Math.sin(a1));
            ctx.lineTo(x1 - head * Math.cos(a2), y1 - head * Math.sin(a2));
            ctx.closePath();
            ctx.fill();
        } else if (m.type === 'text') {
            var fs = Math.max(13, (m.fs || TEXT_FS) * boxH);
            var px = Math.round(fs);
            ctx.font = '600 ' + px + 'px -apple-system,"Microsoft YaHei","PingFang SC",sans-serif';
            ctx.textBaseline = 'top';
            ctx.textAlign = 'left';
            var lines = String(m.text || '').split(/\r?\n/);
            var pad = Math.max(2, px / 6);
            for (var i = 0; i < lines.length; i++) {
                var ly = y0 + i * px * 1.25;
                /* 深色描边打底，保证在浅色/深色截图上都看得清 */
                ctx.lineWidth = pad * 2;
                ctx.strokeStyle = 'rgba(0,0,0,.6)';
                ctx.strokeText(lines[i], x0, ly);
                ctx.fillStyle = m.color || '#ff3b30';
                ctx.fillText(lines[i], x0, ly);
            }
        }
        ctx.restore();
    }

    /* ---------------- 重绘编辑画布 ---------------- */
    function redraw() {
        var cv = ST.cv;
        if (!cv || !ST.dispW || !ST.dispH) { return; }
        var dpr = (ST.win && ST.win.devicePixelRatio) || 1;
        cv.width = Math.max(1, Math.round(ST.dispW * dpr));
        cv.height = Math.max(1, Math.round(ST.dispH * dpr));
        cv.style.width = ST.dispW + 'px';
        cv.style.height = ST.dispH + 'px';
        var ctx = null;
        try { ctx = cv.getContext('2d'); } catch (e) { ctx = null; }
        if (!ctx) { return; }                       // jsdom 等无 canvas 环境：只保留状态机
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, ST.dispW, ST.dispH);

        var s = normSel(ST.sel);
        if (s) {
            /* 选区外压暗，突出要截的部分 */
            var rx = s.x * ST.dispW, ry = s.y * ST.dispH;
            var rw = s.w * ST.dispW, rh = s.h * ST.dispH;
            ctx.save();
            ctx.fillStyle = 'rgba(0,0,0,.5)';
            ctx.beginPath();
            ctx.rect(0, 0, ST.dispW, ST.dispH);
            ctx.rect(rx, ry, rw, rh);
            ctx.fill('evenodd');
            ctx.restore();
            /* 选区虚线边框 + 四角 */
            ctx.save();
            ctx.strokeStyle = '#0a84ff';
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 4]);
            ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
            ctx.restore();
        } else {
            ctx.fillStyle = 'rgba(0,0,0,.28)';
            ctx.fillRect(0, 0, ST.dispW, ST.dispH);
        }

        for (var i = 0; i < ST.marks.length; i++) {
            paintMark(ctx, ST.marks[i], ST.dispW, ST.dispH);
        }
        if (ST.drawing) { paintMark(ctx, ST.drawing, ST.dispW, ST.dispH); }
    }

    /* ---------------- 工具栏状态 ---------------- */
    function syncBar() {
        if (!ST.root) { return; }
        var tools = ST.root.querySelector('#imShotEdTools');
        var hint = ST.root.querySelector('#imShotEdHint');
        var textIn = ST.root.querySelector('#imShotEdText');
        var send = ST.root.querySelector('[data-act="send"]');
        var annotate = (ST.phase === 'annotate');
        var isText = annotate && ST.tool === 'text';

        if (tools) {
            if (annotate) { tools.removeAttribute('hidden'); } else { tools.setAttribute('hidden', 'hidden'); }
            Array.prototype.forEach.call(tools.querySelectorAll('.im-shot__tool'), function (b) {
                b.classList.toggle('is-active', b.getAttribute('data-tool') === ST.tool);
            });
            Array.prototype.forEach.call(tools.querySelectorAll('.im-shot__colors i'), function (c) {
                c.classList.toggle('is-active', c.getAttribute('data-color') === ST.color);
            });
            var undo = tools.querySelector('[data-act="undo"]');
            if (undo) { undo.disabled = !ST.marks.length; }
        }
        if (textIn) {
            if (isText) { textIn.removeAttribute('hidden'); } else { textIn.setAttribute('hidden', 'hidden'); }
        }
        if (send) {
            send.disabled = !annotate;
            send.style.opacity = annotate ? '' : '.5';
        }
        if (hint) {
            hint.textContent = annotate
                ? (isText ? '在图上点击放置文字（可连续放置，换文字先改输入框）'
                          : '已框选区域：选工具后在图上拖动绘制，可撤销 / 重选')
                : '按住鼠标拖动，选择要截取的区域';
        }
    }

    /* ---------------- 坐标换算 ---------------- */
    function normOf(ev) {
        var cv = ST.cv;
        if (!cv || !cv.getBoundingClientRect) { return null; }
        var r = cv.getBoundingClientRect();
        if (!r.width || !r.height) { return null; }
        return {
            x: clamp((ev.clientX - r.left) / r.width, 0, 1),
            y: clamp((ev.clientY - r.top) / r.height, 0, 1)
        };
    }

    /* ---------------- 鼠标交互 ---------------- */
    function onDown(ev) {
        if (!ST.open || (ev.button !== undefined && ev.button !== 0)) { return; }
        var p = normOf(ev);
        if (!p) { return; }
        if (ev.preventDefault) { ev.preventDefault(); }
        if (ST.phase === 'select') {
            ST.dragFrom = p;
            ST.sel = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
            redraw();
            return;
        }
        /* annotate 阶段 */
        if (ST.tool === 'text') {
            addTextMark(p);
            return;
        }
        ST.dragFrom = p;
        ST.drawing = {
            type: ST.tool, color: ST.color, lw: ST.lw,
            x0: p.x, y0: p.y, x1: p.x, y1: p.y
        };
        redraw();
    }

    function onMove(ev) {
        if (!ST.open || !ST.dragFrom) { return; }
        var p = normOf(ev);
        if (!p) { return; }
        if (ST.phase === 'select' && ST.sel) {
            ST.sel.x1 = p.x;
            ST.sel.y1 = p.y;
            redraw();
            return;
        }
        if (ST.drawing) {
            ST.drawing.x1 = p.x;
            ST.drawing.y1 = p.y;
            redraw();
        }
    }

    function onUp() {
        if (!ST.open || !ST.dragFrom) { return; }
        ST.dragFrom = null;
        if (ST.phase === 'select') {
            var s = normSel(ST.sel);
            if (!s || s.w < MIN_SEL || s.h < MIN_SEL) {
                ST.sel = null;
                redraw();
                return;
            }
            ST.sel = { x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h };
            ST.phase = 'annotate';
            ST.root.querySelector('.im-shot__wrap').classList.add('is-annotate');
            syncBar();
            redraw();
            return;
        }
        if (ST.drawing) {
            var m = ST.drawing;
            ST.drawing = null;
            if (Math.abs(m.x1 - m.x0) < MIN_MARK && Math.abs(m.y1 - m.y0) < MIN_MARK) {
                redraw();
                return;
            }
            ST.marks.push(m);
            syncBar();
            redraw();
        }
    }

    function addTextMark(p) {
        var txt = String(ST.lastText || '').trim();
        if (!txt) {
            var input = ST.root.querySelector('#imShotEdText');
            toast('warning', '请先在上方输入要标注的文字');
            if (input) { try { input.focus(); } catch (e) { /* 忽略 */ } }
            return;
        }
        ST.marks.push({
            type: 'text', text: txt, color: ST.color, lw: ST.lw, fs: TEXT_FS,
            x0: p.x, y0: p.y, x1: p.x, y1: p.y
        });
        syncBar();
        redraw();
    }

    /* ---------------- 导出（裁剪选区 + 叠加标注） ---------------- */
    function exportShot() {
        var s = normSel(ST.sel);
        if (!s || !ST.img || !ST.natW || !ST.natH) { return null; }
        var nw = Math.max(1, Math.round(s.w * ST.natW));
        var nh = Math.max(1, Math.round(s.h * ST.natH));
        var cv = ST.doc.createElement('canvas');
        cv.width = nw;
        cv.height = nh;
        var ctx = null;
        try { ctx = cv.getContext('2d'); } catch (e) { ctx = null; }
        if (!ctx) { return null; }
        try {
            ctx.drawImage(ST.img, s.x * ST.natW, s.y * ST.natH, nw, nh, 0, 0, nw, nh);
        } catch (e) { return null; }
        ctx.save();
        ctx.translate(-s.x * ST.natW, -s.y * ST.natH);
        for (var i = 0; i < ST.marks.length; i++) {
            paintMark(ctx, ST.marks[i], ST.natW, ST.natH);
        }
        ctx.restore();
        var url = '';
        try { url = cv.toDataURL('image/png'); } catch (e) { return null; }
        if (!url || url.indexOf('data:image') !== 0) { return null; }
        return { url: url, width: nw, height: nh };
    }

    /* ---------------- toast（借用宿主的 UI） ---------------- */
    function toast(type, msg) {
        var w = ST.win || window;
        try {
            if (w.UI && w.UI.toast) { w.UI.toast(type, msg); return; }
        } catch (e) { /* 忽略 */ }
        try {
            if (window.UI && window.UI.toast) { window.UI.toast(type, msg); }
        } catch (e2) { /* 忽略 */ }
    }

    /* ---------------- 打开 / 关闭 ---------------- */
    function open(dataUrl, opts) {
        opts = opts || {};
        close();
        ST.onSend = opts.onSend || null;
        ST.onCancel = opts.onCancel || null;
        ST.doc = hostDoc();
        ST.win = ST.doc.defaultView || window;
        injectCSS(ST.doc);

        ST.phase = 'select';
        ST.sel = null;
        ST.marks = [];
        ST.drawing = null;
        ST.dragFrom = null;
        ST.tool = 'rect';
        ST.color = COLORS[0];
        ST.lastText = '';
        ST.natW = 0;
        ST.natH = 0;
        ST.dispW = 0;
        ST.dispH = 0;
        ST.img = null;

        var root = ST.doc.createElement('div');
        root.className = 'im-shot';
        root.id = 'imShotEd';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-label', '截屏标注');
        root.innerHTML = tpl();
        ST.doc.body.appendChild(root);
        ST.root = root;
        ST.open = true;

        ST.cv = root.querySelector('#imShotEdCanvas');
        ST.imgEl = root.querySelector('#imShotEdImg');

        ST.imgEl.onload = function () {
            ST.img = ST.imgEl;
            ST.natW = ST.imgEl.naturalWidth || ST.imgEl.width || 0;
            ST.natH = ST.imgEl.naturalHeight || ST.imgEl.height || 0;
            layout();
            syncBar();
        };
        ST.imgEl.onerror = function () {
            toast('error', '截屏图像加载失败');
            close();
            if (typeof ST.onCancel === 'function') { ST.onCancel(); }
        };
        ST.imgEl.src = dataUrl;

        bind();
        syncBar();
        /* 图片可能已被缓存，layout 兜底再跑一次 */
        ST.win.setTimeout(function () { if (ST.open && !ST.dispW) { layout(); } }, 120);
    }

    function close(silent) {
        if (ST.root && ST.root.parentNode) { ST.root.parentNode.removeChild(ST.root); }
        ST.root = null;
        ST.cv = null;
        ST.imgEl = null;
        ST.img = null;
        var wasOpen = ST.open;
        ST.open = false;
        ST.drawing = null;
        ST.dragFrom = null;
        if (!silent && wasOpen && typeof ST.onCancel === 'function') {
            var cb = ST.onCancel;
            ST.onCancel = null;
            ST.onSend = null;
            cb();
        }
        if (silent) { ST.onCancel = null; ST.onSend = null; }
    }

    /* ---------------- 事件绑定 ---------------- */
    function bind() {
        var doc = ST.doc, root = ST.root;

        /* 工具栏按钮（委托） */
        root.addEventListener('click', function (ev) {
            var el = ev.target;
            while (el && el !== root && !el.getAttribute) { el = el.parentNode; }
            if (!el || el === root) { return; }
            var toolBtn = el.closest ? el.closest('[data-tool]') : null;
            if (toolBtn) {
                ST.tool = toolBtn.getAttribute('data-tool');
                syncBar();
                return;
            }
            var colorBtn = el.closest ? el.closest('[data-color]') : null;
            if (colorBtn) {
                ST.color = colorBtn.getAttribute('data-color');
                syncBar();
                return;
            }
            var actBtn = el.closest ? el.closest('[data-act]') : null;
            if (!actBtn) { return; }
            var act = actBtn.getAttribute('data-act');
            if (act === 'undo') { undo(); }
            else if (act === 'reset') { resetSel(); }
            else if (act === 'cancel') { close(); }
            else if (act === 'send') { doSend(); }
        });

        root.querySelector('#imShotEdText').addEventListener('input', function () {
            ST.lastText = this.value;
        });

        ST.cv.addEventListener('mousedown', onDown);
        doc.addEventListener('mousemove', onMove, true);
        doc.addEventListener('mouseup', onUp, true);

        if (!ST.bound) {
            ST.bound = true;
            doc.addEventListener('keydown', onKey, true);
            ST.win.addEventListener('resize', layout);
        }
    }

    function onKey(ev) {
        if (!ST.open) { return; }
        if (ev.keyCode === 27) {                     // ESC 取消
            ev.preventDefault();
            close();
            return;
        }
        if ((ev.ctrlKey || ev.metaKey) && ev.keyCode === 90) {   // Ctrl+Z 撤销
            ev.preventDefault();
            undo();
        }
    }

    function undo() {
        if (!ST.marks.length) { return; }
        ST.marks.pop();
        syncBar();
        redraw();
    }

    function resetSel() {
        ST.phase = 'select';
        ST.sel = null;
        ST.marks = [];
        ST.drawing = null;
        ST.dragFrom = null;
        if (ST.root) {
            var wrap = ST.root.querySelector('.im-shot__wrap');
            if (wrap) { wrap.classList.remove('is-annotate'); }
        }
        syncBar();
        redraw();
    }

    function doSend() {
        if (ST.phase !== 'annotate') { toast('warning', '请先拖动鼠标框选要截取的区域'); return; }
        var out = exportShot();
        if (!out) { toast('error', '截图生成失败，请重试或改用 Ctrl+V 粘贴'); return; }
        var cb = ST.onSend;
        ST.onSend = null;
        ST.onCancel = null;
        close(true);
        if (typeof cb === 'function') { cb(out.url, out.width, out.height); }
    }

    window.IMShot = {
        open: open,
        close: function () { close(); },
        isOpen: function () { return !!ST.open; },
        /* 供探针 / 单测使用 */
        state: ST,
        _test: {
            layout: layout,
            redraw: redraw,
            syncBar: syncBar,
            exportShot: exportShot,
            paintMark: paintMark,
            resetSel: resetSel,
            undo: undo,
            doSend: doSend,
            normSel: normSel
        }
    };
})(window, document);
