/* ==========================================================================
   layout.js —— 外壳通用行为：框架内嵌适配、页面跳转、移动端侧边栏抽屉、菜单占位提示
   ========================================================================== */

/* ---------- 统一跳转：在框架页中运行时交给父框架换 iframe，否则本页跳转 ---------- */
window.AppNav = (function () {
    function framed() {
        try {
            return window.top !== window.self && !!(window.parent && window.parent.AppFrame);
        } catch (e) { return false; }
    }
    return {
        framed: framed,
        go: function (url, delay) {
            var run = function () {
                if (framed()) { window.parent.AppFrame.navigate(url, { fromChild: true }); }
                else { window.location.href = url; }
            };
            if (delay) { window.setTimeout(run, delay); } else { run(); }
        },
        /**
         * 通知框架页重新加载左侧导航：
         * 菜单组 / 菜单项 / 菜单组项目（绑定关系）新增、修改、删除成功后调用，
         * 使「同级菜单组按排序号升序、组内菜单项按显示序号升序」立即生效，无需手动刷新整页。
         */
        reloadNav: function () {
            try {
                if (framed() && window.parent.AppFrame && window.parent.AppFrame.reloadNav) {
                    window.parent.AppFrame.reloadNav();
                }
            } catch (e) { /* 忽略跨域 / 父框架未就绪 */ }
        }
    };
})();

/* ---------- 面包屑数据源 ----------
   功能页自身不再显示面包屑，改为在 .page-head 上以 data-crumb 声明（形如 首页/系统管理/菜单项管理），
   由框架页（main.html）读取后统一显示在底部状态栏。表单页「新增 / 编辑」切换时调用 AppCrumb.setAction。 */
window.AppCrumb = (function ($) {
    /** 上报给框架页：子页面主动上报比父框架读 iframe DOM 更可靠（也避免同源限制） */
    function push() {
        try {
            if (window.AppNav.framed() && window.parent.AppFrame) {
                var text = String($('#pageHead').attr('data-crumb') || '');
                if (window.parent.AppFrame.setCrumb) { window.parent.AppFrame.setCrumb(text); }
                else if (window.parent.AppFrame.refreshCrumb) { window.parent.AppFrame.refreshCrumb(); }
            }
        } catch (e) { /* 忽略跨域 / 父框架未就绪 */ }
    }
    return {
        /** 替换面包屑最后一段（新增菜单项 → 编辑菜单项） */
        setAction: function (text) {
            var $head = $('#pageHead');
            if (!$head.length || !text) { return; }
            var cur = String($head.attr('data-crumb') || '');
            $head.attr('data-crumb', cur ? cur.replace(/[^/]*$/, text) : text);
            push();
        },
        get: function () { return String($('#pageHead').attr('data-crumb') || ''); },
        push: push
    };
})(jQuery);

jQuery(function ($) {
    var $side = $('#appSide');
    var $mask = $('#sideMask');
    var $toggle = $('#sideToggle');

    /* ---------- 被框架页（main.html）内嵌时：隐藏自身顶栏与侧栏，避免双层外壳 ---------- */
    if (window.AppNav.framed()) {
        $('body').addClass('in-frame');
        $(document).on('click', 'a[href]', function (e) {
            var href = $(this).attr('href') || '';
            if (href.charAt(0) === '#' || !/\.html($|\?)/.test(href)) { return; }
            if ($(this).hasClass('is-disabled')) { return; }   // 未实现菜单仍走原有提示
            e.preventDefault();
            window.AppNav.go(href);
        });
        window.AppCrumb.push();     // 上报本页面包屑，显示在框架页底部
        try { window.parent.AppFrame.sync(window.location.pathname.replace(/^.*\//, '') + window.location.search + window.location.hash); } catch (err2) { /* 忽略 */ }
    }

    function openSide() { $side.addClass('is-open'); $mask.addClass('is-show'); }
    function closeSide() { $side.removeClass('is-open'); $mask.removeClass('is-show'); }

    $toggle.on('click', function () {
        if ($side.hasClass('is-open')) { closeSide(); } else { openSide(); }
    });
    $mask.on('click', closeSide);
    $side.on('click', '.app-side__item', function () {
        if (window.innerWidth <= 992) { closeSide(); }
    });

    // 未实现的演示菜单：给出友好提示
    $(document).on('click', '.app-side__item.is-disabled', function (e) {
        e.preventDefault();
        UI.alert({
            title: '演示说明', type: 'info',
            message: '本套页面为「菜单项管理 / 菜单组管理」功能演示，该模块暂未实现。'
        });
    });

    // 窗口尺寸变化时收起抽屉
    $(window).on('resize', function () {
        if (window.innerWidth > 992) { closeSide(); }
    });
});
