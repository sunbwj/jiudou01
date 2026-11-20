/* ============================================================
 * theme.js · 全站主题切换（顶栏最右侧「主题」按钮）
 * ------------------------------------------------------------
 * 1) 主题写入 localStorage，并以 <html data-theme="xxx"> 生效；
 * 2) 页面加载即应用（避免刷新时闪一下默认色）；
 * 3) 框架页（main.html）切换时会同步给所有 Tab 里的 iframe 功能页；
 *    反过来，功能页（单独打开时）切换也会同步回框架页；
 * 4) 具体颜色见 css/theme.css（--theme-primary 等变量）。
 * ============================================================ */
window.AppTheme = (function ($) {
    'use strict';

    var KEY = 'app.theme';
    var DEFAULT = 'blue';

    var THEMES = [
        { id: 'blue', name: '经典蓝', color: '#409eff' },
        { id: 'cyan', name: '科技青', color: '#13c2c2' },
        { id: 'green', name: '墨绿', color: '#2ba471' },
        { id: 'orange', name: '活力橙', color: '#ff7a18' },
        { id: 'purple', name: '暗夜紫', color: '#7c5cff' },
        { id: 'rose', name: '典雅红', color: '#d94f5c' },
        { id: 'gray', name: '淡雅灰', color: '#6f7b8c' }
    ];

    var ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path fill="#fff" d="M12 3a9 9 0 000 18c1.1 0 1.8-.9 1.6-1.9-.2-.8.4-1.5 1.2-1.5h1.5A4.7 4.7 0 0021 12.9C21 7.5 16.9 3 12 3z"/>' +
        '<circle cx="7.5" cy="12" r="1.3" fill="#fff"/>' +
        '<circle cx="10.5" cy="7.8" r="1.3" fill="#fff"/>' +
        '<circle cx="15.5" cy="8.4" r="1.3" fill="#fff"/>' +
        '<circle cx="17.5" cy="12.6" r="1.3" fill="#fff"/>' +
        '</svg>';

    function themeOf(id) {
        for (var i = 0; i < THEMES.length; i++) {
            if (THEMES[i].id === id) { return THEMES[i]; }
        }
        return null;
    }

    function read() {
        var id = '';
        try { id = window.localStorage.getItem(KEY) || ''; } catch (e) { /* 隐私模式 */ }
        if (!themeOf(id)) { id = DEFAULT; }
        return id;
    }

    function save(id) {
        try { window.localStorage.setItem(KEY, id); } catch (e) { /* 忽略 */ }
    }

    /** 把主题写到某个 window（含 iframe 内的文档）的 <html> 上 */
    function applyTo(win, id) {
        try {
            var doc = win && win.document;
            if (!doc || !doc.documentElement) { return false; }
            doc.documentElement.setAttribute('data-theme', id || read());
            return true;
        } catch (e) {
            return false;      // 跨域 iframe 不可写，忽略
        }
    }

    /** 同步给本页所有 iframe（Tab 内容页） */
    function syncFrames(id) {
        $('iframe').each(function () {
            try { applyTo(this.contentWindow, id); } catch (e) { /* 忽略 */ }
        });
    }

    function current() { return read(); }

    /**
     * 切换主题
     * @param {String} id      主题 id
     * @param {Boolean} silent true=来自子页面上报，不再反向通知父框架（避免死循环）
     */
    function set(id, silent) {
        if (!themeOf(id)) { id = DEFAULT; }
        save(id);
        applyTo(window, id);
        syncFrames(id);
        render();
        if (!silent) {                       // 子页面切换 → 同步回框架页
            try {
                if (window.parent && window.parent !== window && window.parent.AppTheme) {
                    window.parent.AppTheme.set(id, true);
                }
            } catch (e) { /* 忽略跨域 */ }
        }
        try { $(window.document).trigger('themechange', [id]); } catch (e2) { /* 忽略 */ }
        return id;
    }

    /* ---------- 切换按钮 + 面板 ---------- */
    /**
     * 按钮：小图标形式（调色板图标 + 右下角当前主题色点）
     * 主题名保留在 <span class="txt"> 中，但用 CSS 做无障碍隐藏（仅供读屏与自动化测试）
     */
    function btnHtml() {
        var t = themeOf(read()) || THEMES[0];
        return '<button type="button" class="theme-switch__btn" data-theme-btn="1" aria-label="切换页面主题"' +
            ' title="页面主题：' + t.name + '（点击换肤）">' +
            ICON +
            '<span class="theme-switch__dot" style="background-color:' + t.color + '"></span>' +
            '<span class="txt">' + t.name + '</span>' +
            '</button>';
    }
    function panelHtml() {
        var cur = read(), html = '<div class="theme-panel" data-theme-panel="1">' +
            '<div class="theme-panel__title">选择主题（全站生效）</div>';
        for (var i = 0; i < THEMES.length; i++) {
            var t = THEMES[i];
            html += '<div class="theme-panel__item' + (t.id === cur ? ' is-active' : '') +
                '" data-theme-id="' + t.id + '">' +
                '<span class="theme-panel__swatch" style="background-color:' + t.color + '"></span>' +
                '<span class="theme-panel__name">' + t.name + '</span>' +
                (t.id === cur ? '<span class="theme-panel__check">✓</span>' : '') +
                '</div>';
        }
        return html + '</div>';
    }
    /** 渲染 / 刷新页面上所有主题按钮与面板 */
    function render() {
        var $box = $('.theme-switch');
        if (!$box.length) { return; }
        $box.each(function () {
            var $one = $(this);
            if (!$one.children('[data-theme-btn]').length) {
                $one.html(btnHtml() + panelHtml());
            } else {
                var cur = read(), t = themeOf(cur) || THEMES[0];
                var $btn = $one.children('[data-theme-btn]');
                $btn.attr('title', '页面主题：' + t.name + '（点击换肤）')
                    .attr('aria-label', '切换页面主题（当前：' + t.name + '）')
                    .find('.txt').text(t.name);
                $btn.find('.theme-switch__dot').css('background-color', t.color);
                $one.find('[data-theme-panel]').html($(panelHtml()).html());
            }
        });
    }

    $(function () {
        render();
        // 按钮：开 / 关面板
        $(document).on('click', '[data-theme-btn]', function (e) {
            e.stopPropagation();
            var $panel = $(this).siblings('[data-theme-panel]');
            $('.theme-panel').not($panel).removeClass('is-open');
            $panel.toggleClass('is-open');
        });
        // 面板：选主题
        $(document).on('click', '.theme-panel__item', function (e) {
            e.stopPropagation();
            set($(this).attr('data-theme-id'));
            $('.theme-panel').removeClass('is-open');
        });
        // 点击别处 / Esc 关闭
        $(document).on('click', function (e) {
            if (!$(e.target).closest('.theme-switch').length) { $('.theme-panel').removeClass('is-open'); }
        });
        $(document).on('keyup', function (e) {
            if (e.keyCode === 27) { $('.theme-panel').removeClass('is-open'); }
        });
    });

    // 立即应用一次：避免页面刷新时先闪默认色
    applyTo(window, read());

    return {
        themes: THEMES,
        get: current,
        set: set,
        applyTo: applyTo,
        syncFrames: syncFrames,
        render: render
    };
})(jQuery);
