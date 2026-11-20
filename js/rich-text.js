/* ==========================================================================
   富文本编辑器（轻量、零依赖）
   --------------------------------------------------------------------------
   使用场景：写邮件正文（mail.html / emp-mail.html）、即时对话输入框（message.html）。
   设计取舍：
     · 不用第三方编辑器（项目是原生 ES5 + jQuery，不引构建链），工具栏用
       document.execCommand 做「有状态」命令（加粗 / 斜体 / 列表…），
       字号与颜色用 Range 包裹 <span style> 实现（execCommand 的 fontSize 会产出
       已废弃的 <font>，且背景色 hiliteColor 在部分浏览器实现不一致）。
     · 可编辑区外面包一层 .rt（工具栏 + 内容区），HTML 里只留一个
       <div class="rt__area" contenteditable="true">，工具栏由本文件生成，避免三处重复。
     · 给可编辑元素补一个 value 读写器（getter 取纯文本 / setter 写入纯文本），
       让老代码与老测试里的 $('#imText').val() / $('#mfBody').val() 继续可用。
     · jsdom 没有 execCommand / Range 的部分能力，所有调用都做能力判断并降级为
       「改 DOM 结构」，不抛异常（38 套 jsdom 回归要能跑）。
   ========================================================================== */
(function (window, document, $) {
    'use strict';

    if (!window || !document) { return; }
    $ = $ || window.jQuery;

    /* ---------------- 图标（内联 SVG，尺寸由 CSS 控制） ---------------- */
    var ICO = {
        bold: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 4h6.2a4.3 4.3 0 012.5 7.7A4.1 4.1 0 0113.6 20H7V4zm3 2.4v4.3h3.1a2.1 2.1 0 000-4.3H10zm0 6.4v4.8h3.6a2.4 2.4 0 000-4.8H10z"/></svg>',
        italic: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M10 4h9v2h-3.4l-3.2 12H16v2H7v-2h3.4l3.2-12H10V4z"/></svg>',
        underline: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3a1 1 0 011 1v7a3 3 0 01-6 0V4a1 1 0 112 0v7a1 1 0 002 0V4a1 1 0 011-1zM5 17h14v2H5v-2z" transform="translate(1 1)"/></svg>',
        strike: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 11h16v2H4v-2zm3.2-4.1C7.2 5.6 8.7 4.5 11 4.5c2.6 0 4.1 1.3 4.4 2.6l-1.9.6c-.2-.6-.9-1.3-2.4-1.3-1.3 0-2.1.6-2.1 1.5 0 .7.5 1 1.6 1.3l-1.6 1C8 9.8 7.4 9 7.4 7.9c0-.4.1-.7.3-1zM12.4 14c1.7.5 2.5 1.1 2.5 2.2 0 1.3-1.1 2.4-3.1 2.4-1.9 0-3.1-.9-3.4-2.3l1.9-.6c.2.7 1 1.1 1.6 1.1.7 0 1.1-.2 1.1-.6 0-.3-.2-.5-1-.8l.4-.4v-1z"/></svg>',
        ul: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 6.5a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6zm4 .6h12v1.6H8V7.1zM4 11a1.3 1.3 0 110 2.6A1.3 1.3 0 014 11zm4 .6h12v1.6H8v-1.6zM4 15.5a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6zm4 .6h12v1.6H8v-1.6z"/></svg>',
        ol: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M5.2 5.2h1.3v4.2H5.2v-3l-.9.5-.4-1 1.3-.7zm-.3 7.4c1 0 1.7.5 1.7 1.3 0 .5-.3 1-.8 1.4l-.9.7h1.8v1.2H4v-1l1.6-1.3c.3-.2.4-.4.4-.6 0-.3-.2-.5-.6-.5-.4 0-.6.2-.7.6l-1.1-.4c.2-.9 1-1.4 1.9-1.4zM9 7.1h11.5v1.6H9V7.1zm0 5.6h11.5V14H9v-1.3zm0 5.6h11.5v1.6H9v-1.6z"/></svg>',
        quote: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7.2 6H4v6h4.2V9.1c0-1 .1-1.5.6-2H7.2V6zm9 0H13v6h4.2V9.1c0-1 .1-1.5.6-2h-1.6V6z" transform="translate(1.5 3)"/><path fill="currentColor" d="M4 18h16v2H4z"/></svg>',
        link: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M10.6 13.4a1 1 0 010-1.4l1.4-1.4a1 1 0 011.4 1.4l-1.4 1.4a1 1 0 01-1.4 0zM7.8 8.2l2.4-2.4a3.7 3.7 0 015.2 5.2l-1.4 1.4-1.4-1.4 1.4-1.4a1.7 1.7 0 10-2.4-2.4L9.2 9.6 7.8 8.2zm8.4 7.6l-2.4 2.4a3.7 3.7 0 01-5.2-5.2l1.4-1.4 1.4 1.4-1.4 1.4a1.7 1.7 0 102.4 2.4l2.4-2.4 1.4 1.4z"/></svg>',
        clear: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 3h12l1 4H5l1-4zm1.6 6h8.8l-.8 10a2 2 0 01-2 1.9h-3.2a2 2 0 01-2-1.9L7.6 9zm2 2l.6 8h3.6l.6-8H9.6z"/></svg>',
        color: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3l6 8.4a6 6 0 11-12 0L12 3z"/></svg>',
        mark: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 15.5L13.6 6a2 2 0 012.8 0l1.6 1.6a2 2 0 010 2.8L8.4 20H4v-4.5z"/></svg>'
    };

    var FONT_SIZES = [
        { v: '', t: '字号' }, { v: '13px', t: '小' }, { v: '14px', t: '正常' },
        { v: '16px', t: '大' }, { v: '18px', t: '特大' }, { v: '20px', t: '超大' }
    ];
    var COLORS = ['#303133', '#f56c6c', '#e6a23c', '#67c23a', '#409eff', '#909399'];
    var HILITES = ['transparent', '#fdf6ec', '#fef0f0', '#f0f9eb', '#ecf5ff', '#f4f4f5'];

    var BAD_TAGS = {
        SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1,
        BASE: 1, FORM: 1, INPUT: 1, BUTTON: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1
    };
    var BLOCK_END = /<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article)\s*>/gi;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 纯文本 → HTML（保留换行与空格） */
    function textToHtml(text) {
        return esc(text).replace(/\r\n|\r|\n/g, '<br>');
    }

    /* ---------------- 安全清洗：渲染邮件 / 消息里的 HTML 前必须过这里 ---------------- */
    // 历史通知（IM / 邮件）里推送过 http://127.0.0.1:8808/xxx.html 这类「本机地址」，
    // 部署到服务器后点开等于访问收件人自己的电脑。渲染时把主机部分去掉、只留路径，
    // 浏览器按当前站点解析 —— 换 IP / 域名 / 端口都自然跟着走（库里的旧内容不用改）。
    // file:// 直接打开页面时没有站点可挂靠，保持原样不动。
    var LOCAL_HOST_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?(?=\/|$)/i;

    function localizeUrl(url) {
        var val = String(url == null ? '' : url);
        if (!val || !LOCAL_HOST_RE.test(val)) { return val; }
        if (!/^https?:$/i.test(String(location.protocol || ''))) { return val; }
        return val.replace(LOCAL_HOST_RE, '') || '/';
    }

    /**
     * 去掉危险标签、on* 事件属性、javascript: 协议、CSS expression。
     * 用 DOM 遍历而不是正则拼字符串：正则很难覆盖嵌套与属性引号的各种写法。
     */
    function sanitize(html) {
        var raw = String(html == null ? '' : html);
        if (!raw) { return ''; }
        var box = document.createElement('div');
        try { box.innerHTML = raw; } catch (e) { return esc(raw); }
        var nodes = box.querySelectorAll('*'), i, j;
        for (i = nodes.length - 1; i >= 0; i--) {
            var el = nodes[i];
            if (BAD_TAGS[el.tagName]) {
                if (el.parentNode) { el.parentNode.removeChild(el); }
                continue;
            }
            var attrs = el.attributes;
            for (j = attrs.length - 1; j >= 0; j--) {
                var name = String(attrs[j].name || '').toLowerCase();
                var val = String(attrs[j].value || '');
                if (name.indexOf('on') === 0) { el.removeAttribute(attrs[j].name); continue; }
                if (name === 'style') {
                    if (/expression\s*\(|javascript:|vbscript:|behavior\s*:/i.test(val)) {
                        el.removeAttribute('style');
                    }
                    continue;
                }
                if (name === 'href' || name === 'src' || name === 'action' || name === 'xlink:href') {
                    if (/^\s*(javascript|vbscript|data:text\/html)/i.test(val)) {
                        el.removeAttribute(attrs[j].name);
                        continue;
                    }
                    var fixed = localizeUrl(val);
                    if (fixed !== val) { el.setAttribute(attrs[j].name, fixed); }
                }
            }
            if (el.tagName === 'A' && el.getAttribute('href')) {
                el.setAttribute('target', '_blank');
                el.setAttribute('rel', 'noopener noreferrer');
            }
        }
        return box.innerHTML;
    }

    /** HTML → 纯文本（邮件纯文本备选部分 / IM 列表摘要 / 判空都用它） */
    function textOf(html) {
        var raw = String(html == null ? '' : html);
        if (!raw) { return ''; }
        var s = raw.replace(/<br\s*\/?>/gi, '\n')
            .replace(/<li[^>]*>/gi, '\n· ')
            .replace(BLOCK_END, '\n');
        var box = document.createElement('div');
        box.innerHTML = s;
        var txt = box.textContent || box.innerText || '';
        return String(txt).replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/^\s+|\s+$/g, '');
    }

    function isEmptyHtml(html) {
        var raw = String(html == null ? '' : html);
        if (!raw) { return true; }
        if (/<(img|table|hr|video|audio)\b/i.test(raw)) { return false; }
        return !textOf(raw);
    }

    /* ---------------- 选区工具 ---------------- */
    function currentRange(el) {
        var sel = window.getSelection ? window.getSelection() : null;
        if (!sel || !sel.rangeCount) { return null; }
        var range = sel.getRangeAt(0);
        if (el && !el.contains(range.commonAncestorContainer)) { return null; }
        return range;
    }

    function placeCaretEnd(el) {
        try {
            var range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (e) { /* jsdom 无 Selection 时忽略 */ }
    }

    function selectNode(node) {
        try {
            var range = document.createRange();
            range.selectNodeContents(node);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (e) { /* ignore */ }
    }

    /** 用 span 包住当前选区并加样式（字号 / 字色 / 背景色） */
    function wrapSelection(el, styles) {
        var range = currentRange(el);
        if (!range) { return false; }
        if (range.collapsed) { return false; }
        var span = document.createElement('span');
        for (var k in styles) {
            if (Object.prototype.hasOwnProperty.call(styles, k)) { span.style[k] = styles[k]; }
        }
        try {
            span.appendChild(range.extractContents());
            range.insertNode(span);
        } catch (e) {
            return false;
        }
        selectNode(span);
        return true;
    }

    function exec(cmd, arg) {
        if (typeof document.execCommand !== 'function') { return false; }
        try {
            return document.execCommand(cmd, false, arg === undefined ? null : arg);
        } catch (e) {
            return false;
        }
    }

    /* ---------------- 工具栏定义 ---------------- */
    function toolbarHtml(opts) {
        var o = opts || {};
        var h = '';
        h += btn('bold', ICO.bold, '加粗（Ctrl+B）');
        h += btn('italic', ICO.italic, '斜体（Ctrl+I）');
        h += btn('underline', ICO.underline, '下划线（Ctrl+U）');
        h += btn('strikeThrough', ICO.strike, '删除线');
        h += '<span class="rt__sep"></span>';
        /* 字号 */
        h += '<select class="rt__select" data-rt-size title="字号" aria-label="字号">';
        for (var i = 0; i < FONT_SIZES.length; i++) {
            h += '<option value="' + FONT_SIZES[i].v + '">' + FONT_SIZES[i].t + '</option>';
        }
        h += '</select>';
        /* 文字色 / 背景色：色块按钮 + 隐藏的色板 */
        h += '<span class="rt__color" data-rt-color="fore">' +
            '<button type="button" class="rt__btn" data-rt-pick="fore" title="文字颜色">' +
            ICO.color + '<i class="rt__swatch"></i></button>' +
            '<span class="rt__palette" data-rt-palette="fore">';
        for (i = 0; i < COLORS.length; i++) {
            h += '<i data-rt-val="' + COLORS[i] + '" data-rt-kind="color" ' +
                'style="background:' + COLORS[i] + '" title="' + COLORS[i] + '"></i>';
        }
        h += '</span></span>';
        h += '<span class="rt__color" data-rt-color="hilite">' +
            '<button type="button" class="rt__btn" data-rt-pick="hilite" title="背景颜色">' +
            ICO.mark + '<i class="rt__swatch rt__swatch--bg"></i></button>' +
            '<span class="rt__palette" data-rt-palette="hilite">';
        for (i = 0; i < HILITES.length; i++) {
            h += '<i data-rt-val="' + HILITES[i] + '" data-rt-kind="hilite" ' +
                'style="background:' + HILITES[i] + '" title="' + HILITES[i] + '"></i>';
        }
        h += '</span></span>';
        h += '<span class="rt__sep"></span>';
        h += btn('insertUnorderedList', ICO.ul, '无序列表');
        h += btn('insertOrderedList', ICO.ol, '有序列表');
        h += btn('quote', ICO.quote, '引用');
        h += btn('createLink', ICO.link, '插入链接');
        h += '<span class="rt__sep"></span>';
        h += btn('removeFormat', ICO.clear, '清除格式');
        if (o.at) {
            h += btn('mention', o.atIcon || '@', '插入 @ 提醒（也可直接输入 @）');
        }
        return h;

        function btn(cmd, svg, title) {
            return '<button type="button" class="rt__btn" data-rt-cmd="' + cmd + '" ' +
                'title="' + title + '" aria-label="' + title + '">' + svg + '</button>';
        }
    }

    /* ---------------- 挂载 ---------------- */
    /**
     * mount($area, {placeholder, at, atTitle})
     * @param $area jQuery 对象或 DOM 元素（contenteditable 容器）
     * @return 编辑器实例（$area.data('rt') 可取回，重复挂载返回同一个）
     */
    function mount($area, opts) {
        var el = $area && $area.jquery ? $area[0] : ($area && $area.nodeType ? $area : null);
        if (!el) { return null; }
        $area = $(el);
        var existed = $area.data('rt');
        if (existed) { return existed; }
        opts = opts || {};

        if (el.getAttribute('contenteditable') === null) { el.setAttribute('contenteditable', 'true'); }
        if (opts.placeholder) { el.setAttribute('data-rt-placeholder', opts.placeholder); }
        el.classList.add('rt__area');

        var $bar = $('<div class="rt__bar" role="toolbar" aria-label="' +
            esc(opts.label || '格式工具栏') + '"></div>');
        /* 页面自带的「附加工具」（如 IM 的图片/文件/表情/语音/截屏按钮）先塞进工具栏最左侧，
           中间用分隔线隔开，再接富文本命令 —— 这样只有一条工具栏，不会多出一行把原有按钮挤到边上 */
        var $extra = opts.extraTools ? $(opts.extraTools).first() : null;
        if ($extra && $extra.length) {
            $extra.addClass('rt__extra').removeClass('im-input__tools');
            $bar.append($extra).append('<span class="rt__sep"></span>');
        }
        $bar.append(toolbarHtml(opts));
        /* 工具栏 + 内容区包进 .rt（页面 HTML 里只写可编辑容器，工具栏不重复三处） */
        if (!$(el).parent().hasClass('rt')) {
            var $rt = $('<div class="rt"></div>');
            $(el).before($rt);
            $rt.append($bar).append($(el));
        }

        /* value 读写器：老代码 / 老测试用 .val() 取纯文本、写纯文本 */
        try {
            Object.defineProperty(el, 'value', {
                configurable: true,
                get: function () { return textOf(el.innerHTML); },
                set: function (v) {
                    var s = v == null ? '' : String(v);
                    el.innerHTML = s ? textToHtml(s) : '';
                }
            });
        } catch (e) { /* 极老浏览器忽略 */ }

        var saved = null;
        function saveRange() { saved = currentRange(el) || saved; }
        function restoreRange() {
            /* 当前选区还在编辑器里且确实选中了内容 → 直接用，不要拿旧的 saved 覆盖。
               （点工具栏时选区本来就不会丢：mousedown 已 preventDefault；
                 这条主要是防「saved 是光标刚聚焦时的空选区」把选中文字弄丢） */
            var cur = currentRange(el);
            if (cur && !cur.collapsed) { return; }
            if (!saved) { return; }
            try {
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(saved);
            } catch (e) { /* ignore */ }
        }

        $area.on('mouseup.rt keyup.rt input.rt focus.rt', saveRange);
        /* 点工具栏不能抢走可编辑区的选区，否则命令作用不到选中文字上；
           但字号 <select> 依赖浏览器原生下拉，mousedown 不能被阻止（否则点不开） */
        $bar.on('mousedown.rt', function (e) {
            if ($(e.target).closest('select, [data-rt-size], option').length) { return; }
            e.preventDefault();
        });
        $bar.on('click.rt', '.rt__btn', function () {
            var cmd = $(this).attr('data-rt-cmd');
            if (!cmd) { return; }
            restoreRange();
            runCommand(cmd);
        });
        $bar.on('change.rt', '[data-rt-size]', function () {
            var size = $(this).val();
            restoreRange();
            if (size) { wrapSelection(el, { fontSize: size }); }
            $(this).val('');
            $area.trigger('focus');
        });
        $bar.on('click.rt', '[data-rt-pick]', function (e) {
            e.stopPropagation();
            var kind = $(this).attr('data-rt-pick');
            var $p = $bar.find('[data-rt-palette="' + kind + '"]');
            $bar.find('.rt__palette').not($p).removeClass('is-open');
            $p.toggleClass('is-open');
        });
        $bar.on('click.rt', '[data-rt-val]', function () {
            var val = $(this).attr('data-rt-val');
            var kind = $(this).attr('data-rt-kind');
            $bar.find('.rt__palette').removeClass('is-open');
            restoreRange();
            if (kind === 'hilite') {
                wrapSelection(el, { backgroundColor: val });
            } else {
                wrapSelection(el, { color: val });
            }
            $area.trigger('focus');
        });
        $(document).on('click.rt-' + (el.id || Math.random().toString(36).slice(2)), function () {
            $bar.find('.rt__palette').removeClass('is-open');
        });

        /* 粘贴：只收清洗后的 HTML / 纯文本，避免把 Word 的一堆样式带进来 */
        $area.on('paste.rt', function (e) {
            var ev = e.originalEvent || e;
            var cd = ev.clipboardData || window.clipboardData;
            if (!cd || typeof cd.getData !== 'function') { return; }
            var html = '', text = '';
            try { html = cd.getData('text/html') || ''; } catch (e1) { html = ''; }
            try { text = cd.getData('text/plain') || ''; } catch (e2) { text = ''; }
            if (!html && !text) { return; }         // 图片粘贴交给页面自己的处理
            e.preventDefault();
            insertHtml(html ? sanitize(html) : textToHtml(text));
        });

        function runCommand(cmd) {
            if (cmd === 'quote') {
                if (!exec('formatBlock', '<blockquote>')) { exec('formatBlock', 'blockquote'); }
                return;
            }
            if (cmd === 'createLink') { createLink(); return; }
            if (cmd === 'mention') {
                if (typeof opts.onMention === 'function') { opts.onMention(api); }
                return;
            }
            exec(cmd);
        }

        function createLink() {
            var range = currentRange(el);
            if (!range) { return; }
            var url = '';
            try {
                url = window.prompt ? window.prompt('请输入链接地址（http/https）', 'https://') : '';
            } catch (e) { url = ''; }
            url = String(url || '').replace(/^\s+|\s+$/g, '');
            if (!url || /^javascript:/i.test(url)) { return; }
            if (range.collapsed) {
                insertHtml('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
                    esc(url) + '</a>');
                return;
            }
            if (!exec('createLink', url)) {
                var span = document.createElement('a');
                span.setAttribute('href', url);
                span.setAttribute('target', '_blank');
                try {
                    span.appendChild(range.extractContents());
                    range.insertNode(span);
                } catch (e) { /* ignore */ }
            }
        }

        function insertHtml(html) {
            if (!html) { return; }
            if (exec('insertHTML', html)) { return; }
            var range = currentRange(el);
            if (!range) {
                el.innerHTML = String(el.innerHTML || '') + html;
                placeCaretEnd(el);
                return;
            }
            var box = document.createElement('div');
            box.innerHTML = html;
            var frag = document.createDocumentFragment(), node;
            while ((node = box.firstChild)) { frag.appendChild(node); }
            try {
                range.deleteContents();
                range.insertNode(frag);
                range.collapse(false);
            } catch (e) {
                el.innerHTML = String(el.innerHTML || '') + html;
            }
        }

        function insertText(text) {
            var s = text == null ? '' : String(text);
            if (!s) { return; }
            var range = currentRange(el);
            if (range) {
                try {
                    range.deleteContents();
                    var node = document.createTextNode(s);
                    range.insertNode(node);
                    range.setStartAfter(node);
                    range.collapse(true);
                    return;
                } catch (e) { /* 退化为追加 */ }
            }
            el.appendChild(document.createTextNode(s));
            placeCaretEnd(el);
        }

        var api = {
            el: el,
            bar: $bar[0],
            html: function () {
                var h = String(el.innerHTML || '');
                return isEmptyHtml(h) && !/<(img|table|hr)\b/i.test(h) ? '' : h;
            },
            text: function () { return textOf(el.innerHTML); },
            setHtml: function (h) { el.innerHTML = h ? sanitize(h) : ''; },
            setText: function (t) { el.innerHTML = t ? textToHtml(t) : ''; },
            clear: function () { el.innerHTML = ''; },
            isEmpty: function () { return isEmptyHtml(el.innerHTML); },
            focus: function () { try { el.focus(); } catch (e) { /* ignore */ } },
            insertHtml: insertHtml,
            insertText: insertText,
            exec: runCommand,
            saveRange: saveRange,
            restoreRange: restoreRange
        };
        $area.data('rt', api);
        return api;
    }

    /**
     * 便捷取实例：RichText.of('#imText') / RichText.of($body.find('#mfBody'))
     * 写邮件弹窗是从模板克隆出来的，模板里也有一个 id="mfBody"，
     * 用 document.getElementById 会拿到模板里那个（没挂载过）→ 必须支持传 jQuery 对象。
     */
    function of(target) {
        var el = target;
        if (typeof target === 'string') {
            el = document.getElementById(target.replace(/^#/, ''));
        }
        if (el && el.jquery) { el = el[0]; }
        if (!el || el.nodeType !== 1) { return null; }
        return $(el).data('rt') || null;
    }

    window.RichText = {
        mount: mount,
        of: of,
        sanitize: sanitize,
        localizeUrl: localizeUrl,
        textOf: textOf,
        textToHtml: textToHtml,
        isEmptyHtml: isEmptyHtml,
        esc: esc
    };
}(window, document, window.jQuery));
