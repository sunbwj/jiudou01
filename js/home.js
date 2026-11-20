/* ==========================================================================
   home.js —— 系统首页（登录后框架页右侧默认加载、固定第一个标签且不可关闭）
   --------------------------------------------------------------------------
   · **按当前登录用户所属角色的菜单权限动态渲染功能卡片**（2026-11-04 用户需求）：
     取 /api/nav 的完整菜单树，每个**顶级菜单组**一页，组内递归收集该组子树下
     全部可点击菜单项（含下级分组绑定的菜单项）→ 每项一张卡片；
     没有授权的功能一律不出现，一个都没有时给出提示
   · 排列：按顶级菜单组分组排列；一屏放不下多组时，用左右箭头 / 圆点
     **按菜单组轮播切换**（每个顶级菜单组一页；只有一组时不显示切换控件）
   · 卡片点击：在框架页 iframe 内走父框架 AppNav.go 新建 Tab；单独打开时直接跳转
   ========================================================================== */
jQuery(function ($) {
    /** 跳转：框架页内用父窗口的 Tab 打开，独立访问时直接跳页面 */
    function go(url) {
        try {
            if (window.parent && window.parent !== window && window.parent.AppNav && window.parent.AppNav.go) {
                window.parent.AppNav.go(url);
                return;
            }
        } catch (e) { /* 跨域受限时退回直接跳转 */ }
        window.location.href = url;
    }

    function pageOf(path) {
        return String(path || '').split('#')[0].split('?')[0];
    }

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** 图标：与左侧导航同源（js/icons.js），未登记的图标名退回「文档」图标 */
    function iconHtml(name) {
        if (window.Icons && window.Icons.svg) { return window.Icons.svg(name || '', 20); }
        return '';
    }

    /* ---------------- 菜单树 → 顶级菜单组卡片页 ---------------- */

    /** 递归收集一个菜单组子树下全部「可点击叶子项」：
     *  · hasChild=1 的组 → 收集其 items（绑定的菜单项）；hasChild=0 且配了 path → 组自身就是叶子；
     *  · children 逐层递归（同一菜单项可能绑在多层，按 path 去重）；path 为空的菜单项不可打开，跳过 */
    function collectLeaves(node, out, seen) {
        if (!node) { return; }
        var items = parseInt(node.hasChild, 10) ? (node.items || []) : [];
        var self = !parseInt(node.hasChild, 10) && node.path ? [node] : [];
        var all = self.concat(items);
        for (var i = 0; i < all.length; i++) {
            var it = all[i] || {};
            var p = pageOf(it.path);
            if (!p || seen[p]) { continue; }
            seen[p] = true;
            out.push({
                name: it.nameCn || it.name || p,
                path: p,
                icon: it.icon || '',
                crumb: it.crumb || (it.nameCn || p)
            });
        }
        var children = node.children || [];
        for (var k = 0; k < children.length; k++) { collectLeaves(children[k], out, seen); }
    }

    /** 一张功能卡片（沿用 .home-card 样式；desc 显示菜单层级路径） */
    function cardHtml(it) {
        return '<a class="home-card" href="javascript:void(0)" data-href="' + esc(it.path) + '"' +
            ' title="' + esc(it.crumb) + '">' +
            '<span class="home-card__ico">' + iconHtml(it.icon) + '</span>' +
            '<div class="home-card__title">' + esc(it.name) + '</div>' +
            '<div class="home-card__desc">' + esc(it.crumb) + '</div>' +
            '</a>';
    }

    /** 一个顶级菜单组 → 一页轮播（组头 + 该组全部菜单项卡片） */
    function slideHtml(group) {
        var leaves = [];
        collectLeaves(group, leaves, {});
        if (!leaves.length) { return ''; }
        var cards = '';
        for (var i = 0; i < leaves.length; i++) { cards += cardHtml(leaves[i]); }
        return '<section class="home-slide" data-group="' + esc(group.id === undefined ? '' : group.id) + '">' +
            '<div class="home-slide__head">' +
                '<span class="home-slide__ico">' + iconHtml(group.icon) + '</span>' +
                '<h2 class="home-slide__title">' + esc(group.nameCn || group.name || '') + '</h2>' +
                (group.nameEn ? '<span class="home-slide__en">' + esc(group.nameEn) + '</span>' : '') +
                '<span class="home-slide__count">' + leaves.length + ' 项</span>' +
            '</div>' +
            '<div class="home-cards">' + cards + '</div>' +
            '</section>';
    }

    /* ---------------- 轮播：按顶级菜单组左右切换 ---------------- */

    function initCarousel() {
        var $track = $('#homeTrack');
        var $slides = $track.children('.home-slide');
        var n = $slides.length;
        var $foot = $('#homeFoot'), $dots = $('#homeDots');
        var idx = 0;

        function renderDots() {
            var html = '';
            for (var i = 0; i < n; i++) {
                html += '<button type="button" class="home-carousel__dot' +
                    (i === idx ? ' is-active' : '') + '" data-idx="' + i + '"' +
                    ' title="第 ' + (i + 1) + ' 组" aria-label="第 ' + (i + 1) + ' 组"></button>';
            }
            $dots.html(html);
        }

        function show(i) {
            idx = ((i % n) + n) % n;
            $track.css('transform', 'translateX(-' + (idx * 100) + '%)');
            $dots.children('.home-carousel__dot').each(function (k) {
                $(this).toggleClass('is-active', k === idx);
            });
        }

        if (n <= 1) {
            $foot[0].hidden = true;                 // 只有一个菜单组：一屏放得下放不下都无需切换控件
            return;
        }
        $foot[0].hidden = false;
        renderDots();
        show(0);

        $('#homePrev').on('click', function () { show(idx - 1); });
        $('#homeNext').on('click', function () { show(idx + 1); });
        $dots.on('click', '.home-carousel__dot', function () { show(parseInt($(this).attr('data-idx'), 10) || 0); });
        $(document).on('keydown.homeCarousel', function (e) {
            if (e.key === 'ArrowLeft') { show(idx - 1); }
            if (e.key === 'ArrowRight') { show(idx + 1); }
        });
    }

    /* ---------------- 渲染入口：按当前角色的菜单权限出卡片 ---------------- */

    function renderHomeCards() {
        if (!window.Api || !Api.nav) { return; }
        Api.nav.get().done(function (data) {
            var groups = (data && data.groups) || [];
            var html = '';
            for (var i = 0; i < groups.length; i++) { html += slideHtml(groups[i]); }
            if (!html) {
                $('#homeCarousel').html('<div class="home-empty">当前角色暂无可访问的功能页面，' +
                    '请联系管理员在「角色权限配置」中为本角色授权菜单。</div>');
                return;
            }
            $('#homeTrack').html(html);
            initCarousel();
        }).fail(function (err) {
            // 取不到权限时不展示任何入口，避免把无权页面暴露给用户
            $('#homeCarousel').html('<div class="home-empty">功能入口加载失败：' +
                ((err && err.message) || '未知错误') + '</div>');
        });
    }

    /* ---------------- 卡片点击（事件委托，轮播切换后依然有效） ---------------- */
    $('#homeCarousel').on('click', '.home-card[data-href]', function () {
        go($(this).attr('data-href'));
    });

    /* ---------------- 系统名称与英文名：来自系统参数表（2026-11-12） ----------------
       syspara：app_name 系统名称 / app_ennme 系统英文名（兼容旧键 site_name / app_enname）；
       取不到时保留页面里写好的默认值。 */
    function applyBrand() {
        if (!window.Api || !Api.sysPara || !Api.sysPara.page) { return; }
        Api.sysPara.page({ enabled: 1, pageNum: 1, pageSize: 200 }).done(function (res) {
            var map = {};
            var list = (res && res.list) || [];
            for (var i = 0; i < list.length; i++) {
                var r = list[i] || {};
                map[String(r.paraNameEn || '')] = String(
                    r.paraValue === undefined || r.paraValue === null ? '' : r.paraValue).trim();
            }
            function pick(keys) {
                for (var k = 0; k < keys.length; k++) {
                    var v = String(map[keys[k]] || '').trim();
                    if (v) { return v; }
                }
                return '';
            }
            var name = pick(['app_name', 'site_name']) || $('#homeSysName').text();
            var en = pick(['app_ennme', 'app_enname']) || $('#homeSysNameEn').text();
            $('#homeSysName').text(name);
            $('#homeSysNameEn').text(en);
            document.title = '系统首页 - ' + name;
        }).fail(function () { /* 保留页面默认值 */ });
    }

    if (window.Api) {
        Api.whenReady(function () { renderHomeCards(); applyBrand(); });
    } else {
        renderHomeCards();
    }
});
