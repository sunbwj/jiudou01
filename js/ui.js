/* ==========================================================================
   ui.js —— Element UI 风格的通用交互组件（jQuery 实现）
   提供：message / confirm / alert / loading / dialog / pagination / url 参数
   ========================================================================== */
window.UI = (function ($) {
    var ICON_TPL = {
        success: '<svg viewBox="0 0 24 24" fill="#67c23a"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1.1 14.4l-4-4 1.5-1.5 2.5 2.5 5.6-5.6 1.5 1.5-7.1 7.1z"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="#f56c6c"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
        warning: '<svg viewBox="0 0 24 24" fill="#e6a23c"><path d="M12 2L1 21h22L12 2zm-1 7h2v6h-2V9zm0 8h2v2h-2v-2z"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="#909399"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1 4h2v2h-2V6zm0 4h2v8h-2v-8z"/></svg>'
    };

    /* ---------------- 顶部消息提示 ---------------- */
    function message(options) {
        var opt = $.extend({ type: 'info', message: '', duration: 2600 }, typeof options === 'string' ? { message: options } : options);
        var $wrap = $('.el-message-list');
        if (!$wrap.length) {
            $wrap = $('<div class="el-message-list"></div>').appendTo(document.body);
        }
        var $box = $(
            '<div class="el-message el-message--' + opt.type + ' fade-in" role="alert">' +
                '<div class="el-message__icon">' + (ICON_TPL[opt.type] || ICON_TPL.info) + '</div>' +
                '<div class="el-message__content"></div>' +
            '</div>'
        );
        $box.find('.el-message__content').text(opt.message);
        $wrap.append($box);
        window.setTimeout(function () {
            $box.css({ 'opacity': 0, 'transition': 'opacity .3s' });
            window.setTimeout(function () { $box.remove(); if (!$wrap.children().length) { $wrap.remove(); } }, 320);
        }, opt.duration);
        return $box;
    }

    /* ---------------- 对话框基础容器 ---------------- */
    function showBox(html, options) {
        var opt = $.extend({
            width: 420, closable: true, onClose: null, dangerFocus: false
        }, options || {});
        var $wrapper = $('<div class="el-message-box__wrapper"></div>').appendTo(document.body);
        var $box = $(html);
        $box.css('width', opt.width);
        $wrapper.append($box);
        $wrapper.hide().fadeIn(140);
        // 锁定背景滚动
        var scrollTop = $(window).scrollTop();
        $('body').css({ 'overflow': 'hidden' });

        function close(result) {
            $(document).off('keyup.msgbox');
            $wrapper.fadeOut(140, function () {
                $wrapper.remove();
                if (!$('.el-message-box__wrapper').length) { $('body').css('overflow', ''); }
                if (opt.onClose) { opt.onClose(result); }
            });
        }
        $wrapper.on('click', function (e) {
            if (e.target === $wrapper[0] && opt.closable) { close(null); }
        });
        $(document).on('keyup.msgbox', function (e) {
            if (e.keyCode === 27 && opt.closable) { $(document).off('keyup.msgbox'); close(null); }
        });
        return { wrapper: $wrapper, box: $box, close: close };
    }

    /* ---------------- confirm 确认框 ---------------- */
    /**
     * @returns {Promise} 确定 resolve(true)，取消 resolve(false)
     */
    function confirm(options) {
        var opt = $.extend({
            title: '提示', message: '', type: 'warning',
            confirmText: '确定', cancelText: '取消', danger: true
        }, options || {});
        var html =
            '<div class="el-message-box zoom-in el-message-box--with-icon">' +
                '<div class="el-message-box__header">' +
                    '<div class="el-message-box__title"></div>' +
                '</div>' +
                '<div class="el-message-box__content">' +
                    '<div class="el-message-box__status">' + (ICON_TPL[opt.type] || ICON_TPL.warning) + '</div>' +
                    '<div class="el-message-box__message"></div>' +
                '</div>' +
                '<div class="el-message-box__btns">' +
                    '<button type="button" class="el-button el-button--small btn-cancel"></button>' +
                    '<button type="button" class="el-button el-button--small btn-ok"></button>' +
                '</div>' +
            '</div>';
        var dfd = $.Deferred();
        var h = showBox(html, { width: opt.width || 420 });
        var $box = h.box;
        $box.find('.el-message-box__title').text(opt.title);
        $box.find('.el-message-box__message').text(opt.message);
        var $ok = $box.find('.btn-ok').text(opt.confirmText).addClass(opt.danger ? 'el-button--danger' : 'el-button--primary');
        var $cancel = $box.find('.btn-cancel').text(opt.cancelText);
        $ok.on('click', function () { h.close(true); dfd.resolve(true); });
        $cancel.on('click', function () { h.close(false); dfd.resolve(false); });
        $ok.focus();
        return dfd.promise();
    }

    /* ---------------- alert 提示框 ---------------- */
    function alert(options) {
        var opt = $.extend({ title: '提示', message: '', type: 'info', buttonText: '确定' }, options || {});
        var html =
            '<div class="el-message-box zoom-in el-message-box--with-icon">' +
                '<div class="el-message-box__header"><div class="el-message-box__title"></div></div>' +
                '<div class="el-message-box__content">' +
                    '<div class="el-message-box__status">' + (ICON_TPL[opt.type] || ICON_TPL.info) + '</div>' +
                    '<div class="el-message-box__message"></div>' +
                '</div>' +
                '<div class="el-message-box__btns">' +
                    '<button type="button" class="el-button el-button--small el-button--primary btn-ok"></button>' +
                '</div>' +
            '</div>';
        var dfd = $.Deferred();
        var h = showBox(html, { width: opt.width || 420 });
        h.box.find('.el-message-box__title').text(opt.title);
        h.box.find('.el-message-box__message').text(opt.message);
        h.box.find('.btn-ok').text(opt.buttonText).on('click', function () {
            h.close(true); dfd.resolve(true);
        }).focus();
        return dfd.promise();
    }

    /* ---------------- 自定义 Dialog（可放入任意内容） ---------------- */
    /**
     * @param {Object} opt {title, width, content(HTML字符串或jQuery), maximizable, maximized,
     *                      onReady($body, closeFn), onOk($body), onResize($body, isMax)}
     *        maximizable=true 时标题栏右侧多一个「最大化 / 还原」按钮
     *        maximized=true 时打开即处于最大化状态（需同时 maximizable=true）
     */
    function dialog(opt) {
        var o = $.extend({ title: '', width: 520, content: '', maximizable: false, maximized: false, onReady: null }, opt || {});
        var html =
            '<div class="el-dialog zoom-in" role="dialog">' +
                '<div class="el-dialog__header">' +
                    '<span class="el-dialog__title"></span>' +
                    (o.maximizable
                        ? '<button type="button" class="el-dialog__headerbtn el-dialog__headerbtn--max"' +
                          ' aria-label="最大化" title="最大化">⛶</button>'
                        : '') +
                    '<button type="button" class="el-dialog__headerbtn" aria-label="关闭">✕</button>' +
                '</div>' +
                '<div class="el-dialog__body"></div>' +
                '<div class="el-dialog__footer">' +
                    '<button type="button" class="el-button el-button--small btn-cancel">取消</button>' +
                    '<button type="button" class="el-button el-button--small el-button--primary btn-ok">确定</button>' +
                '</div>' +
            '</div>';
        var $overlay = $('<div class="el-overlay"></div>').appendTo(document.body);
        var $dlg = $(html);
        $dlg.css('width', o.width).css('max-width', '92%');
        $overlay.append($dlg);
        $dlg.find('.el-dialog__title').text(o.title);
        var $body = $dlg.find('.el-dialog__body').append(o.content);

        function close() {
            $overlay.remove();
            if (!$('.el-overlay').length) { $('body').css('overflow', ''); }
        }
        $('body').css('overflow', 'hidden');
        /* 关闭按钮要排除「最大化」那个（它也带 el-dialog__headerbtn 类） */
        $dlg.find('.el-dialog__headerbtn').not('.el-dialog__headerbtn--max').on('click', close);

        /* 最大化 / 还原：宽度本来就是行内样式设的，这里直接调整行内宽度 + 挂 is-max 类 */
        var maximized = false;
        var $maxBtn = $dlg.find('.el-dialog__headerbtn--max');
        $maxBtn.on('click', function () {
            maximized = !maximized;
            if (maximized) {
                $dlg.addClass('is-max').css({ width: '96vw', 'max-width': '96vw' });
                $maxBtn.attr({ title: '还原', 'aria-label': '还原' }).text('❐');
            } else {
                $dlg.removeClass('is-max').css({ width: o.width, 'max-width': '92%' });
                $maxBtn.attr({ title: '最大化', 'aria-label': '最大化' }).text('⛶');
            }
            if (o.onResize) { o.onResize($body, maximized); }
        });

        $dlg.find('.btn-cancel').on('click', close);
        $overlay.on('click', function (e) { if (e.target === $overlay[0]) { close(); } });
        $dlg.find('.btn-ok').on('click', function () {
            if (o.onOk) { o.onOk($body, close); } else { close(); }
        });
        if (o.onReady) { o.onReady($body, close); }
        /* 打开即最大化：复用同一个最大化按钮，保证宽度 / 图标 / onResize 只有一条路径 */
        if (o.maximized && $maxBtn.length) { $maxBtn.trigger('click'); }
        return {
            el: $dlg, close: close,
            toggleMax: function () { $maxBtn.trigger('click'); },
            isMaximized: function () { return maximized; }
        };
    }

    /* ---------------- 加载遮罩 ---------------- */
    var SPINNER =
        '<div class="el-loading-spinner">' +
            '<svg class="circular" viewBox="0 0 50 50"><circle class="path" cx="25" cy="25" r="20" fill="none"></circle></svg>' +
            '<p class="el-loading-text">加载中…</p>' +
        '</div>';
    function loading($container, show, text) {
        var $c = $container && $container.length ? $container : $('body');
        if (show) {
            $c.css('position', $c.is('body') ? '' : 'relative');
            var $mask = $c.children('.el-loading-mask');
            if (!$mask.length) {
                $mask = $('<div class="el-loading-mask"><div class="el-loading-spinner">' +
                    '<svg class="circular" viewBox="0 0 50 50"><circle class="path" cx="25" cy="25" r="20" fill="none"></circle></svg>' +
                    '<p class="el-loading-text"></p></div></div>');
                $c.append($mask);
            }
            $mask.find('.el-loading-text').text(text || '加载中…');
            $mask.show();
        } else {
            $c.children('.el-loading-mask').remove();
        }
    }

    /* ---------------- 分页组件 ---------------- */
    /**
     * @param {jQuery} $wrap 挂载容器
     * @param {Object} opt {total, pageNum, pageSize, sizes, onChange(pageNum,pageSize)}
     */
    function pagination($wrap, opt) {
        var state = $.extend({ total: 0, pageNum: 1, pageSize: 10, sizes: [10, 20, 50, 100] }, opt);
        var tpl =
            '<div class="el-pagination">' +
                '<span class="el-pagination__total"></span>' +
                '<span class="el-pagination__sizes"><select class="el-input__inner page-size"></select></span>' +
                '<button type="button" class="btn-prev">‹</button>' +
                '<ul class="el-pager"></ul>' +
                '<button type="button" class="btn-next">›</button>' +
                '<span class="el-pagination__jump">前往<input class="el-input__inner" type="number" min="1" value="1"/>页</span>' +
            '</div>';
        $wrap.empty().append(tpl);
        var $root = $wrap.find('.el-pagination');
        var $total = $root.find('.el-pagination__total');
        var $sizeSel = $root.find('.page-size');
        var $pager = $root.find('.el-pager');
        var $prev = $root.find('.btn-prev');
        var $next = $root.find('.btn-next');
        var $jump = $root.find('.el-pagination__jump input');

        var sizeHtml = '';
        for (var i = 0; i < state.sizes.length; i++) {
            sizeHtml += '<option value="' + state.sizes[i] + '">' + state.sizes[i] + '条/页</option>';
        }
        $sizeSel.html(sizeHtml);

        function pages() { return Math.max(1, Math.ceil(state.total / state.pageSize)); }

        function pageItems() {
            var max = pages(), cur = state.pageNum, arr = [];
            if (max <= 7) {
                for (var i = 1; i <= max; i++) { arr.push(i); }
                return arr;
            }
            arr.push(1);
            var s, e;
            if (cur <= 4) { s = 2; e = 5; }
            else if (cur >= max - 3) { s = max - 4; e = max - 1; }
            else { s = cur - 1; e = cur + 1; }
            if (s > 2) { arr.push('...'); }
            for (var j = s; j <= e; j++) { arr.push(j); }
            if (e < max - 1) { arr.push('...'); }
            arr.push(max);
            return arr;
        }

        /* 每页条数可能被外部按屏幕高度动态算出（如 15 条/页），不在固定选项里。
           这里按数值顺序临时插入一个选项，并清理上一次插入的，避免选项越积越多 */
        function syncSizeOption(size) {
            if (!size) { return; }
            $sizeSel.children('option[data-auto]').each(function () {
                if (parseInt(this.value, 10) !== size) { $(this).remove(); }
            });
            var exists = false;
            $sizeSel.children('option').each(function () {
                if (parseInt(this.value, 10) === size) { exists = true; return false; }
            });
            if (exists) { return; }
            var $opt = $('<option value="' + size + '" data-auto="1">' + size + '条/页</option>');
            var inserted = false;
            $sizeSel.children('option').each(function () {
                if (parseInt(this.value, 10) > size) { $opt.insertBefore(this); inserted = true; return false; }
            });
            if (!inserted) { $opt.appendTo($sizeSel); }
        }

        function render() {
            var max = pages();
            if (state.pageNum > max) { state.pageNum = max; }
            $total.text('共 ' + state.total + ' 条');
            syncSizeOption(state.pageSize);
            $sizeSel.val(state.pageSize);
            var items = pageItems(), html = '';
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (it === '...') { html += '<li class="btn-quicknext">···</li>'; }
                else {
                    html += '<li class="number' + (it === state.pageNum ? ' active' : '') + '" data-page="' + it + '">' + it + '</li>';
                }
            }
            $pager.html(html);
            $prev.prop('disabled', state.pageNum <= 1);
            $next.prop('disabled', state.pageNum >= max);
            $jump.val(state.pageNum);
        }

        function go(p, keepSize) {
            if (!keepSize) { /* 页码变化 */ }
            var max = pages();
            p = parseInt(p, 10);
            if (isNaN(p) || p < 1) { p = 1; }
            if (p > max) { p = max; }
            if (p === state.pageNum) { render(); return; }
            state.pageNum = p;
            render();
            if (state.onChange) { state.onChange(state.pageNum, state.pageSize); }
        }

        $pager.on('click', 'li.number', function () { go($(this).data('page')); });
        $prev.on('click', function () { if (state.pageNum > 1) { go(state.pageNum - 1); } });
        $next.on('click', function () { if (state.pageNum < pages()) { go(state.pageNum + 1); } });
        $sizeSel.on('change', function () {
            state.pageSize = parseInt($(this).val(), 10);
            state.pageNum = 1;
            render();
            if (state.onChange) { state.onChange(state.pageNum, state.pageSize); }
        });
        $jump.on('change', function () { go($(this).val()); });
        $jump.on('keydown', function (e) { if (e.keyCode === 13) { go($(this).val()); } });

        render();
        return {
            update: function (total, pageNum, pageSize) {
                if (typeof total === 'number') { state.total = total; }
                if (pageNum) { state.pageNum = pageNum; }
                if (pageSize) { state.pageSize = pageSize; }
                render();
            },
            getState: function () { return { pageNum: state.pageNum, pageSize: state.pageSize, total: state.total }; }
        };
    }

    /* ---------------- URL 参数 ---------------- */
    function param(name, url) {
        var str = url || window.location.search;
        var reg = new RegExp('(^|&|\\?)' + name + '=([^&#]*)(&|#|$)', 'i');
        var m = str.match(reg);
        return m ? decodeURIComponent(m[2].replace(/\+/g, ' ')) : null;
    }
    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    return {
        message: message, confirm: confirm, alert: alert, dialog: dialog,
        loading: loading, pagination: pagination, param: param, escapeHtml: escapeHtml
    };
})(jQuery);
