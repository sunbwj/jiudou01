/* ==========================================================================
   frame.js —— 框架页（顶 / 左 / 右 / 下）交互
   1) 左侧菜单点击 → 右侧新建 / 激活 Tab，Tab 内以 iframe 加载功能页面
   2) Tab 支持切换、关闭、关闭其它、关闭全部，切换时保留各页的输入状态
   3) 移动端左侧菜单抽屉
   4) 底部状态栏：当前激活页面包屑 + 后端服务探测 + 时钟
   5) 暴露 window.AppFrame，供 iframe 内的子页面调用（AppNav.go 会走这里）
   6) 单点登录（SSO）：登录 token 全站共享（localStorage），本页是唯一的「跳登录页」执行者——
      iframe 子页请求 401 时只上报（postMessage / AppFrame.onAuthExpired），
      由这里把整个 main.html 换成 login.html；令牌默认 8 小时到期，定时体检主动跳转。
   ========================================================================== */
window.AppFrame = (function ($) {
    var DEFAULT_PAGE = 'home.html';          // 登录后右侧默认加载「系统首页」
    var HOME_TITLE = '系统首页';
    var SESSION_KEY = 'menu_admin_login_v1'; // 登录态（与 login.js / home.js 共用）
    /* 系统品牌：默认值仅作兜底，真实值来自系统参数表 syspara（app_name 系统名称 / app_ico 系统图标），
       登录后由 applySysBrand() 拉取并应用到顶部 / 底部 / 标签页标题后缀（2026-11-12） */
    var DEFAULT_SYS_NAME = '九豆综合管理平台';
    var DEFAULT_SYS_LOGO = 'assets/logo.svg';
    var sysName = DEFAULT_SYS_NAME;
    /** 转义正则元字符（系统名进正则前先转义） */
    function escRe(s) {
        return String(s === undefined || s === null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    /** 子页面 <title> 的系统名后缀：页面自带标题可能带旧默认名，也可能带当前参数名，两种都要能剥掉 */
    function titleSuffixRe() {
        return new RegExp('\\s*-\\s*(?:' + escRe(sysName) + '|' + escRe(DEFAULT_SYS_NAME) + ')\\s*$');
    }
    var MAX_TITLE = 12;

    var $tabs, $panes, $menu, $side, $mask, $toggle, $dot, $status, $crumb, $crumbSep;
    var $collapse, $fly;            // 左侧导航：底部收起按钮 / 收起态的悬浮子菜单
    var collapsed = false;          // 左侧导航是否处于收起态（记在 localStorage）
    var SIDE_KEY = 'app.side.collapsed';
    var seq = 0;
    var tabs = [];          // [{id, url, title, closable}]
    var activeId = '';

    /* ---------- 工具 ---------- */
    /** 去掉目录前缀，保留文件名与查询串：a/b/menu.html?mode=add → menu.html?mode=add */
    function relOf(url) {
        return String(url || '').split('#')[0].replace(/^.*\//, '');
    }
    /** 只取文件名（用于匹配左侧菜单项） */
    function pageOf(url) {
        return relOf(url).split('?')[0];
    }
    function findTab(id) {
        for (var i = 0; i < tabs.length; i++) { if (tabs[i].id === id) { return tabs[i]; } }
        return null;
    }
    function findTabByUrl(url) {
        var rel = relOf(url);
        for (var i = 0; i < tabs.length; i++) { if (relOf(tabs[i].url) === rel) { return tabs[i]; } }
        return null;
    }
    /** 导航中的所有可点击叶子（由 /api/nav 动态渲染） */
    function navLeaves() { return $menu ? $menu.find('.frame-side__item[data-url]') : $(); }
    /** 该页面是否为导航中登记的功能页（用于判断「表单页返回列表时关闭自身」） */
    function isMenuUrl(url) {
        var page = pageOf(url), hit = false;
        navLeaves().each(function () {
            if (pageOf($(this).attr('data-url')) === page) { hit = true; return false; }
        });
        return hit;
    }
    /** 导航里配置的标题 */
    function menuTitle(url) {
        var page = pageOf(url), title = '';
        navLeaves().each(function () {
            if (pageOf($(this).attr('data-url')) === page) {
                title = $(this).attr('data-title') || '';
                return false;
            }
        });
        return title;
    }
    /** 读取子页面标题：优先页面主标题 #pageTitle，其次 document.title */
    function docTitle(win) {
        try {
            var d = win.document;
            var t = '';
            if (d.getElementById('pageTitle')) { t = $.trim($(d.getElementById('pageTitle')).text()); }
            if (!t) { t = $.trim(String(d.title || '')); }
            return t.replace(titleSuffixRe(), '') || '';
        } catch (e) { return ''; }      // file:// 下跨域受限，忽略
    }
    function cut(text) {
        text = String(text || '未命名');
        return text.length > MAX_TITLE ? text.slice(0, MAX_TITLE) + '…' : text;
    }

    /* ---------- 底部面包屑：展示「当前激活 Tab」对应功能页的位置 ---------- */
    /** 子页面通过 .page-head 上的 data-crumb 声明自己的面包屑（如 首页/系统管理/菜单项管理） */
    function crumbFromDoc(win) {
        try {
            var el = win.document.getElementById('pageHead');
            if (el) { return String(el.getAttribute('data-crumb') || ''); }
        } catch (e) { /* file:// 下跨域受限，忽略 */ }
        return '';
    }
    /** 子页面未上报面包屑时，取导航中该页面声明的层级路径（如 系统管理/菜单配置/菜单项管理） */
    function crumbFromMenu(url) {
        var page = pageOf(url), text = '';
        navLeaves().each(function () {
            if (pageOf($(this).attr('data-url')) === page) {
                text = $(this).attr('data-crumb') || '';
                return false;
            }
        });
        return text;
    }
    /** 页面未在导航中登记时，按其文件名推断所属列表页（menu-form.html → menu.html） */
    function parentCrumbFromUrl(url) {
        var m = /^(.+)-form\.html$/.exec(pageOf(url));
        return m ? crumbFromMenu(m[1] + '.html') : '';
    }
    /** 按名称反查导航中某个功能页的层级路径（用于把「菜单项管理/新增菜单项」这类相对面包屑接回父路径） */
    function crumbFromMenuTitle(name) {
        name = $.trim(String(name || ''));
        if (!name) { return ''; }
        var text = '';
        navLeaves().each(function () {
            var c = String($(this).attr('data-crumb') || ''), seg = c.split('/');
            if (seg.length && $.trim(seg[seg.length - 1]) === name) { text = c; return false; }
        });
        return text;
    }
    /** 把子页面的（可能是相对的）面包屑挂到父页路径之下，并去掉重复片段 */
    function joinCrumb(parentText, subText) {
        parentText = String(parentText || '').replace(/^\/+|\/+$/g, '');
        subText = String(subText || '').replace(/^\/+|\/+$/g, '');
        if (!parentText) { return subText; }
        if (!subText) { return parentText; }
        if (subText === parentText || subText.indexOf(parentText + '/') === 0) { return subText; }
        var p = parentText.split('/'), s = subText.split('/');
        if (s.length && s[0] === p[p.length - 1]) { s.shift(); }   // 去掉与父页末段重复的一段
        return p.concat(s).join('/');
    }
    function renderCrumb(text) {
        var parts = String(text || '').split('/'), html = '';
        var list = [];
        for (var i = 0; i < parts.length; i++) {
            var t = $.trim(parts[i]);
            if (t) { list.push(t); }
        }
        if (!list.length) { $crumb.empty().hide(); hideCrumbSep(); return; }
        for (var j = 0; j < list.length; j++) {
            if (j) {
                html += '<span class="el-breadcrumb__item"><span class="el-breadcrumb__separator">/</span></span>';
            }
            var last = (j === list.length - 1);
            html += '<span class="el-breadcrumb__item"><span class="el-breadcrumb__inner' +
                (last ? ' is-link' : '') + '">' + list[j] + '</span></span>';
        }
        $crumb.html(html).show();
        showCrumbSep();
    }
    /** 面包屑与其后的分隔竖线同显隐（面包屑为空时不留下孤零零的竖线） */
    function crumbSep() {
        if ($crumbSep === undefined) { $crumbSep = $('#frameCrumbSep'); }
        return $crumbSep;
    }
    /* 用 css() 而不是 show()/hide()，避免内联 display 覆盖响应式样式（小屏本就隐藏该竖线） */
    function showCrumbSep() { crumbSep().css('display', ''); }
    function hideCrumbSep() { crumbSep().css('display', 'none'); }
    /** 刷新底部面包屑：优先用子页面声明的，其次按左侧菜单推断 */
    function updateCrumb(tab) {
        if (!$crumb || !$crumb.length || !tab) { return; }
        var text = tab.crumb || '';                     // 1) 子页面主动上报（最可靠）
        if (!text) {                                    // 2) 直接读子页面声明
            var $frame = $panes.children('[data-id="' + tab.id + '"]').find('iframe');
            if ($frame.length && $frame[0].contentWindow) { text = crumbFromDoc($frame[0].contentWindow); }
        }
        var menuCrumb = crumbFromMenu(tab.url);         // 3) 导航中登记的层级路径（列表页以它为准）
        if (menuCrumb) { renderCrumb(menuCrumb); return; }
        // 4) 未登记在导航中的页面（新增 / 编辑表单页等）：面包屑前面补上父页（所属列表页）的路径
        var base = crumbFromMenuTitle(String(text).split('/')[0]) ||   // 子页自称「菜单项管理/新增菜单项」→ 反查列表页
            tab.parentCrumb ||                                         // 打开它时所在的列表页
            parentCrumbFromUrl(tab.url);                               // 按文件名推断所属列表页
        var sub = text || (/\.html/i.test(tab.title) ? '' : tab.title); // 子页未上报时先用 Tab 标题兜底
        renderCrumb(joinCrumb(base, sub));
    }
    function isMobile() { return window.innerWidth <= 992; }
    function openSide() { $side.addClass('is-open'); $mask.addClass('is-show'); }
    function closeSide() { $side.removeClass('is-open'); $mask.removeClass('is-show'); }

    /* ==========================================================================
       左侧导航：收起 / 展开
       - 收起态宽度 56px，只显示图标；分组子菜单改为悬浮面板弹出
       - 状态写入 localStorage，刷新后保持
       - 移动端（≤992px）左侧是抽屉，收起无意义：自动按展开处理
       ========================================================================== */
    function isCollapsed() { return !!$side && $side.hasClass('is-collapsed'); }
    function readCollapsed() {
        try { return window.localStorage.getItem(SIDE_KEY) === '1'; } catch (e) { return false; }
    }
    function saveCollapsed(on) {
        try { window.localStorage.setItem(SIDE_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }
    /** 按钮为纯图标：用 title 提供气泡提示，用 aria-label 提供无障碍名称 */
    function renderCollapse() {
        if (!$collapse) { return; }
        var on = isCollapsed();
        var label = on ? '展开导航' : '收起导航';
        $collapse.attr('title', label).attr('aria-label', label)
            .attr('aria-expanded', on ? 'false' : 'true');
    }
    /** 应用收起态：移动端抽屉模式强制展开 */
    function applyCollapse() {
        if (!$side) { return; }
        $side.toggleClass('is-collapsed', !!collapsed && !isMobile());
        renderCollapse();
    }
    function setCollapsed(on) {
        collapsed = !!on;
        saveCollapsed(collapsed);
        hideFly();
        applyCollapse();
        return collapsed;
    }
    function toggleCollapsed() { return setCollapsed(!collapsed); }

    /* ---------- 收起态：分组子菜单以悬浮面板弹出 ---------- */
    var flyTimer = null;
    function flyEl() {
        if ($fly && $fly.length) { return $fly; }
        $fly = $('<div class="frame-side__flyout" id="frameFlyout"></div>').appendTo(document.body);
        $fly.on('mouseenter', function () { if (flyTimer) { window.clearTimeout(flyTimer); flyTimer = null; } });
        $fly.on('mouseleave', scheduleHideFly);
        $fly.on('click', '[data-toggle]', function () {          // 面板内的多级分组
            $(this).closest('.frame-side__group').toggleClass('is-open');
        });
        $fly.on('click', '.frame-side__item', function (e) {
            e.preventDefault();
            var $it = $(this);
            if ($it.hasClass('is-disabled')) {
                UI.alert({
                    title: '演示说明', type: 'info',
                    message: '该菜单尚未配置功能页面地址。请到「菜单项管理」填写「功能页面地址（URL）」，' +
                        '再到「菜单组项目管理」把它绑定到对应菜单组。'
                });
                return;
            }
            var url = $it.attr('data-url') || '';
            if (!/\.html($|\?)/.test(url)) { return; }
            openNavPage(url, $it.attr('data-crumb') || '', $it.attr('data-title') || '');
            hideFly();
            if (isMobile()) { closeSide(); }
        });
        return $fly;
    }
    function showFly($group) {
        if (!isCollapsed() || !$group || !$group.length) { return; }
        var $sub = $group.children('.frame-side__sub');
        if (!$sub.length) { return; }
        var $el = flyEl();
        if (flyTimer) { window.clearTimeout(flyTimer); flyTimer = null; }
        $el.html($sub.html()).addClass('is-show');
        // 定位：贴着被悬停的分组右侧，超出视口时上移
        var rect = { top: 0, right: 56 };
        var $title = $group.children('.frame-side__group-title');
        if ($title.length && $title[0].getBoundingClientRect) {
            var r = $title[0].getBoundingClientRect();
            rect.top = r.top || 0;
            rect.right = r.right || 56;
        }
        var top = rect.top, h = $el.outerHeight() || 0, vh = window.innerHeight || 600;
        if (top + h > vh - 8) { top = Math.max(8, vh - h - 8); }
        if (top < 8) { top = 8; }
        $el.css({ left: (rect.right + 4) + 'px', top: top + 'px' });
    }
    function hideFly() {
        if (flyTimer) { window.clearTimeout(flyTimer); flyTimer = null; }
        if ($fly && $fly.length) { $fly.removeClass('is-show').empty(); }
    }
    function scheduleHideFly() {
        if (flyTimer) { window.clearTimeout(flyTimer); }
        flyTimer = window.setTimeout(hideFly, 260);
    }

    /* ---------- 左侧导航：由 /api/nav 按菜单组 + 菜单项 + 绑定关系生成 ---------- */
    function navIcon(name) {
        if (window.Icons && window.Icons.svg) { return window.Icons.svg(name || '', 16); }
        return '';
    }
    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function padOf(depth) { return 14 + (depth - 1) * 14; }

    /** 叶子项（一个可打开的功能页面）
     *  title：收起态只显示图标，悬停时用原生提示补出名称（含层级路径） */
    function leafHtml(o, depth) {
        var pad = padOf(depth);
        var tip = esc(o.crumb || o.nameCn);
        if (o.disabled) {
            return '<div class="frame-side__item is-disabled" style="padding-left:' + pad + 'px" ' +
                'title="' + esc(o.nameCn) + '（未配置页面）">' +
                '<span class="ico">' + navIcon(o.icon) + '</span>' +
                '<span class="txt">' + esc(o.nameCn) + '（未配置页面）</span></div>';
        }
        return '<a class="frame-side__item" href="' + esc(o.url) + '" data-url="' + esc(o.url) +
            '" data-title="' + esc(o.nameCn) + '" data-crumb="' + esc(o.crumb) +
            '" title="' + tip + '" style="padding-left:' + pad + 'px">' +
            '<span class="ico">' + navIcon(o.icon) + '</span>' +
            '<span class="txt">' + esc(o.nameCn) + '</span></a>';
    }
    /** 菜单项数组 → 叶子项 HTML */
    function itemsHtml(items, depth) {
        var html = '';
        for (var i = 0; i < items.length; i++) {
            html += leafHtml({
                nameCn: items[i].nameCn, icon: items[i].icon,
                url: items[i].path, crumb: items[i].crumb, disabled: !items[i].path
            }, depth);
        }
        return html;
    }

    /* ---------- 导航排序：同级菜单组按「排序号」升序、组内菜单项按「显示序号」升序 ----------
       后端 /api/nav 已按 sortNo 排好，这里再兜一次底：
       无论数据来自后端、本地模拟服务还是缓存，渲染顺序都由 sortNo 决定（同序号时按 id 升序，保证稳定）。
       返回新数组/新节点，不修改传入数据。 */
    function navOrderNo(v) {
        var n = parseInt(v, 10);
        return isNaN(n) ? 0 : n;
    }
    function compareNav(a, b) {
        return (navOrderNo(a.sortNo) - navOrderNo(b.sortNo)) || (navOrderNo(a.id) - navOrderNo(b.id));
    }
    function sortNavTree(list) {
        var sorted = (list || []).slice().sort(compareNav), out = [];
        for (var i = 0; i < sorted.length; i++) {
            var node = $.extend({}, sorted[i]);
            node.items = (node.items || []).slice().sort(compareNav);
            node.children = sortNavTree(node.children);
            out.push(node);
        }
        return out;
    }
    /** 该节点会不会渲染成「可折叠的菜单组」（有下级分组，或绑了菜单项） */
    function isGroupNode(n) {
        return !!(n && ((n.children && n.children.length) ||
            (n.hasChild && n.items && n.items.length)));
    }
    /** 菜单组节点递归渲染：有下级 → 分组容器；可绑菜单项 → 挂其菜单项；其余 → 自身叶子 */
    function nodesHtml(list, depth) {
        var html = '';
        // 顶层「最上面那个菜单组」的下标（顶层可能有直接指向功能页的叶子排在前面，跳过它们）
        var firstGroupIdx = -1;
        if (depth === 1) {
            for (var k = 0; k < list.length; k++) {
                if (isGroupNode(list[k])) { firstGroupIdx = k; break; }
            }
        }
        for (var i = 0; i < list.length; i++) {
            var n = list[i];
            var hasChildGroup = !!(n.children && n.children.length);
            var hasItems = !!n.hasChild && !!(n.items && n.items.length);

            if (hasChildGroup || hasItems) {
                // 默认展开规则：**只有最上面那个菜单组默认展开**，其余菜单组默认收缩，
                // 免得一进系统就看到一长串菜单；子分组随父组展开后保持展开，点标题可随时收起。
                var expanded = (depth === 1) ? (i === firstGroupIdx) : true;
                html += '<div class="frame-side__group' + (expanded ? ' is-open' : '') +
                    '" data-group="' + n.id + '">' +
                    '<div class="frame-side__group-title" data-toggle="1" title="' + esc(n.nameCn) +
                        '" style="padding-left:' + padOf(depth) + 'px">' +
                        '<i class="frame-side__arrow"></i>' +
                        '<span class="ico">' + navIcon(n.icon) + '</span>' +
                        '<span class="txt">' + esc(n.nameCn) + '</span>' +
                    '</div>' +
                    '<div class="frame-side__sub">' +
                        (hasChildGroup ? nodesHtml(n.children, depth + 1) : itemsHtml(n.items, depth + 1)) +
                    '</div>' +
                '</div>';
                continue;
            }
            if (n.hasChild && !hasItems) {          // 可绑菜单项但未绑定任何菜单项
                html += '<div class="frame-side__item is-disabled" style="padding-left:' + padOf(depth) + 'px" ' +
                    'title="' + esc(n.nameCn) + '（未绑定菜单项）">' +
                    '<span class="ico">' + navIcon(n.icon) + '</span>' +
                    '<span class="txt">' + esc(n.nameCn) + '（未绑定菜单项）</span></div>';
                continue;
            }
            html += leafHtml({
                nameCn: n.nameCn, icon: n.icon, url: n.path, crumb: n.crumb, disabled: !n.path
            }, depth);
        }
        return html;
    }
    /** 左侧导航顶部的固定「系统首页」入口
     *  不放在菜单数据（menuinfros）里：首页是框架自带的页面，不受菜单授权 / 数据变动影响，
     *  也不会因为误删菜单项而「消失」；排序上永远排第一。 */
    function homeItemHtml() {
        return leafHtml({ nameCn: HOME_TITLE, icon: 'dashboard', url: DEFAULT_PAGE, crumb: HOME_TITLE }, 1);
    }
    /** 渲染导航：入参先按「同级菜单组 sortNo 升序 / 组内菜单项 sortNo 升序」排好再输出 */
    function renderNav(data) {
        var list = sortNavTree((data && data.groups) || []);
        // 重载时保留用户手动展开 / 收起的每一个分组（首次渲染没有记录 → 走默认规则：
        // 只有最上面那个菜单组展开，其它菜单组收缩）
        var opened = {};
        $menu.find('.frame-side__group').each(function () {
            var $g = $(this);
            opened[String($g.attr('data-group'))] = $g.hasClass('is-open');
        });
        $menu.html(homeItemHtml() + (list.length ? nodesHtml(list, 1)
            : '<div class="frame-side__empty">暂无可用菜单<br>请先在「菜单组管理 / 菜单组项目管理」中配置</div>'));
        for (var g in opened) {
            if (!opened.hasOwnProperty(g)) { continue; }
            var $group = $menu.find('.frame-side__group[data-group="' + g + '"]');
            if (!$group.length) { continue; }
            if (opened[g]) { $group.addClass('is-open'); } else { $group.removeClass('is-open'); }
        }

        // 导航就绪后补齐：已打开 Tab 的标题（打开时导航还没渲染，标题可能还是文件名）
        for (var i = 0; i < tabs.length; i++) {
            if (/\.html/i.test(tabs[i].title)) {
                var t = menuTitle(tabs[i].url);
                if (t) { setTabTitle(tabs[i], t); }
            }
        }
        var tab = findTab(activeId);            // 补一次高亮与底栏面包屑
        if (tab) { syncMenu(tab.url); updateCrumb(tab); }
        // 导航重绘后重新挂「未读上标」（小红点 + 数字由 js/notify.js 维护）
        if (window.AppNotify && window.AppNotify.applyMenuBadges) { window.AppNotify.applyMenuBadges(); }
    }
    var navRetried = false;
    var navLoading = false;
    var navSignature = '';      // 上一次渲染的数据指纹：重载时数据没变就不重绘，避免闪烁 / 丢失展开状态
    /**
     * 加载左侧导航
     * @param {Object} opts { silent: true } 静默重载：不显示「正在加载菜单…」占位（增删改后刷新用）
     */
    function loadNav(opts) {
        var silent = !!(opts && opts.silent);
        if (!window.Api || !window.Api.nav) {
            $menu.html('<div class="frame-side__empty">未加载数据服务（js/api.js）</div>');
            return;
        }
        if (navLoading) { return; }             // 同一时刻只发一次请求
        navLoading = true;
        if (!silent) { $menu.html('<div class="frame-side__loading">正在加载菜单…</div>'); }
        // 菜单按「当前登录用户所属角色的菜单权限」加载：必须带登录 token
        var token = (session() || {}).token || '';
        window.Api.nav.get(token).done(function (data) {
            navLoading = false;
            navRetried = false;
            var groups = sortNavTree((data && data.groups) || []);
            var signature = JSON.stringify(groups);
            if (signature === navSignature && $menu.find('.frame-side__group, .frame-side__item').length) {
                return;                         // 菜单结构未变化：保持现有 DOM（含折叠状态与滚动位置）
            }
            navSignature = signature;
            if (!groups.length) {               // 已登录但该角色的菜单权限为空
                var who = (data && data.roleNames) ? ('当前角色：' + esc(data.roleNames)) : '当前账号未分配角色';
                $menu.html('<div class="frame-side__empty">暂无可访问的菜单<br>' + who +
                    '<br>请联系管理员在「角色权限配置」中授权</div>');
                navSignature = '';
                return;
            }
            renderNav(data);
        }).fail(function (err) {
            navLoading = false;
            if (err && err.code === 401) {      // token 失效：清登录态回登录页
                gotoLogin(true);
                return;
            }
            // 首次失败可能是后端探测尚未完成（baseUrl 还在切换），稍等再试一次
            if (!navRetried) {
                navRetried = true;
                window.setTimeout(function () { loadNav({ silent: silent }); }, 600);
                return;
            }
            $menu.html('<div class="frame-side__empty">菜单加载失败：' + esc(err && err.message || '未知错误') +
                '<br><a href="javascript:void(0)" id="navRetry">点击重试</a></div>');
        });
    }
    /** 打开导航项：先确认功能页面存在，避免 Tab 里出现 404 */
    function openNavPage(url, crumb, title) {
        var opts = { crumb: crumb, title: title };
        if (window.location.protocol === 'file:' || !$.ajax) { openTab(url, opts); return; }
        $.ajax({ url: url, type: 'HEAD', timeout: 4000, cache: false })
            .done(function () { openTab(url, opts); })
            .fail(function (xhr) {
                var status = xhr && xhr.status;
                // 405：服务器不支持 HEAD；0：被浏览器拦（跨域 / 文件协议）→ 仍尝试打开
                if (status === 405 || status === 0) { openTab(url, opts); return; }
                UI.alert({
                    title: '页面暂未实现', type: 'warning',
                    message: '功能页面「' + url + '」不可用（HTTP ' + (status || '错误') +
                        '）。请到「菜单项管理」中核对「功能页面地址（URL）」。'
                });
            });
    }

    /* ---------- 左侧菜单高亮 ---------- */
    function syncMenu(url) {
        var page = pageOf(url);
        navLeaves().removeClass('is-active').each(function () {
            if (pageOf($(this).attr('data-url')) === page) {
                $(this).addClass('is-active').parents('.frame-side__group').addClass('is-open');
                return false;
            }
        });
    }

    /* ---------- 地址栏 hash（刷新 / 分享链接可直接进入某模块） ---------- */
    function hashUrl() {
        return String(window.location.hash || '').replace(/^#/, '') || DEFAULT_PAGE;
    }
    function writeHash(url) {
        var hash = '#' + url;
        if ('#' + hashUrl() === hash) { return; }
        if (window.history && window.history.replaceState) {
            window.history.replaceState(null, '', hash);     // 不产生历史垃圾，也不触发 hashchange
        } else {
            window.location.hash = url;
        }
    }

    /* ---------- Tab 渲染 ---------- */
    /** 系统首页固定在第一个标签：发现它不在首位就把它的按钮挪到最前（Tab 顺序以 tabs 数组为准） */
    function ensureHomeFirst() {
        var idx = -1;
        for (var i = 0; i < tabs.length; i++) {
            if (pageOf(tabs[i].url) === pageOf(DEFAULT_PAGE)) { idx = i; break; }
        }
        if (idx <= 0) { return; }
        var home = tabs.splice(idx, 1)[0];
        tabs.unshift(home);
        var $tab = $tabs.children('.frame-tab[data-id="' + home.id + '"]');
        if ($tab.length) { $tabs.prepend($tab.detach()); }
    }
    function renderTab(tab) {
        var html = '<div class="frame-tab" data-id="' + tab.id + '" title="' + tab.title + '">' +
            '<span class="frame-tab__text">' + cut(tab.title) + '</span>' +
            (tab.closable ? '<i class="frame-tab__close" data-close="1" title="关闭">×</i>' : '') +
            '</div>';
        $tabs.append(html);
        ensureHomeFirst();          // 系统首页永远停在第一个标签

        var $pane = $('<div class="frame-pane" data-id="' + tab.id + '"></div>');
        $pane.append('<iframe class="frame-pane__frame" src="' + tab.url + '" frameborder="0" ' +
            'scrolling="auto" data-url="' + tab.url + '" title="' + tab.title + '"></iframe>');
        $panes.append($pane);
        bindPane($pane.find('iframe'));
    }
    function activate(id) {
        var tab = findTab(id);
        if (!tab) { return; }
        activeId = id;
        $tabs.children('.frame-tab').removeClass('is-active')
            .filter('[data-id="' + id + '"]').addClass('is-active');
        $panes.children('.frame-pane').removeClass('is-active')
            .filter('[data-id="' + id + '"]').addClass('is-active');
        var $cur = $tabs.children('.is-active');
        if ($cur.length) { scrollIntoView($cur); }
        syncMenu(tab.url);
        writeHash(relOf(tab.url));
        document.title = tab.title + ' - ' + sysName;
        updateCrumb(tab);
    }
    /** Tab 过多时把当前激活的标签滚进可视区 */
    function scrollIntoView($tab) {
        var box = $tabs[0];
        if (!box || !$tab[0]) { return; }
        var l = $tab[0].offsetLeft, r = l + $tab[0].offsetWidth;
        if (l < box.scrollLeft) { box.scrollLeft = l - 8; }
        else if (r > box.scrollLeft + box.clientWidth) { box.scrollLeft = r - box.clientWidth + 8; }
    }
    function setTabTitle(tab, title) {
        if (!title || !tab || tab.title === title) { return; }
        tab.title = title;
        $tabs.children('[data-id="' + tab.id + '"]')
            .attr('title', title).find('.frame-tab__text').text(cut(title));
        if (tab.id === activeId) { document.title = title + ' - ' + sysName; }
    }
    /** 重新加载某个 Tab 的内容（返回列表页时用于刷新数据） */
    function reload(tab) {
        if (!tab) { return; }
        var $frame = $panes.children('[data-id="' + tab.id + '"]').find('iframe');
        var url = tab.url || $frame.attr('data-url');
        $frame.attr('src', url);
    }
    function close(id, opts) {
        opts = opts || {};
        var tab = findTab(id);
        if (!tab || !tab.closable) { return; }
        var idx = -1;
        for (var i = 0; i < tabs.length; i++) { if (tabs[i].id === id) { idx = i; break; } }
        tabs.splice(idx, 1);
        $tabs.children('[data-id="' + id + '"]').remove();
        $panes.children('[data-id="' + id + '"]').remove();
        if (activeId === id) {
            var next = tabs[idx] || tabs[idx - 1];
            if (next && !opts.silent) { activate(next.id); }
            else { activeId = ''; }
        }
    }

    /* ---------- 打开 / 切换 Tab ---------- */
    function openTab(url, opts) {
        opts = opts || {};
        url = relOf(url) || DEFAULT_PAGE;
        var exist = findTabByUrl(url);

        // 子页面内部跳转（如表单保存后返回列表）：目标已开 → 关闭当前表单页并刷新目标
        if (opts.fromChild && exist && exist.id !== activeId) {
            var cur = findTab(activeId);
            var leave = !cur || !isMenuUrl(cur.url);
            if (leave) {
                var targetId = exist.id;
                close(activeId, { silent: true });
                activate(targetId);
                reload(exist);
                return;
            }
        }
        if (exist) {
            activate(exist.id);
            if (opts.reload) { reload(exist); }
            return exist;
        }

        seq++;
        // 父页路径：打开本页时所在的那个已登记页面（通常是列表页），供表单页面包屑拼接使用。
        // 系统首页不是任何页面的「父列表页」（它只是框架自带的入口），所以不参与拼接，
        // 否则从首页打开 menu-form.html 会得到「系统首页」这种错误面包屑。
        var from = findTab(activeId);
        var fromIsHome = !!from && pageOf(from.url) === pageOf(DEFAULT_PAGE);
        var fromCrumb = (from && !fromIsHome) ? crumbFromMenu(from.url) : '';
        var tab = {
            id: 'tab-' + seq,
            url: url,
            title: opts.title || menuTitle(url) ||
                (pageOf(url) === pageOf(DEFAULT_PAGE) ? HOME_TITLE : pageOf(url)),
            crumb: opts.crumb || '',     // 导航声明的层级路径（子页面加载后会再次上报）
            parentCrumb: opts.parentCrumb || fromCrumb || (from ? from.parentCrumb : ''),
            closable: pageOf(url) !== pageOf(DEFAULT_PAGE)      // 系统首页永远不可关闭
        };
        tabs.push(tab);
        renderTab(tab);
        activate(tab.id);
        return tab;
    }

    /* ---------- iframe 加载完成：同步标题 / 地址 / 菜单高亮 ---------- */
    function bindPane($frame) {
        $frame.on('load', function () {
            var frameWin = this.contentWindow;
            // 新建 / 重新加载的功能页：同步当前主题（子页面自身也会读 localStorage，这里双保险）
            try { if (window.AppTheme && frameWin) { window.AppTheme.applyTo(frameWin); } } catch (e) { /* 跨域忽略 */ }
            var id = $(this).closest('.frame-pane').attr('data-id');
            var tab = findTab(id);
            if (!tab) { return; }
            var rel = '';
            try {
                var href = frameWin.location.href;
                rel = String(href).split('#')[0].replace(/^.*\//, '');
                if (/^api\//.test(rel) || /^about:/.test(rel)) { rel = ''; }
            } catch (err) { rel = ''; }
            if (rel && rel !== relOf(tab.url)) { tab.url = rel; }
            var t = docTitle(this.contentWindow);
            if (t) { setTabTitle(tab, t); }
            if (tab.id === activeId) {
                syncMenu(tab.url);
                writeHash(relOf(tab.url));
                document.title = tab.title + ' - ' + sysName;
                updateCrumb(tab);       // 子页面加载完成后再取一次，覆盖打开时的推断值
            }
        });
    }

    /* ---------- 底部：服务状态 ---------- */
    function renderStatus(ok, text) {
        $dot.removeClass('is-on is-off').addClass(ok ? 'is-on' : 'is-off');
        $status.text(text);
    }
    function probeBackend() {
        renderStatus(false, '正在检测服务…');
        $.ajax({
            url: 'api/health', type: 'GET', dataType: 'json', timeout: 3000, cache: false
        }).done(function (res) {
            if (res && res.code === 0) {
                renderStatus(true, '后端已连接');          // 明细条数不再显示，保持底栏简洁
            } else {
                renderStatus(false, '后端返回异常');
            }
        }).fail(function () {
            renderStatus(false, '离线演示模式（内置 Mock 数据）');
        });
    }
    function tickClock() {
        var now = new Date();
        function p(n) { return n < 10 ? '0' + n : '' + n; }
        var w = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
        $('#clock').text(now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) +
            ' 周' + w + ' ' + p(now.getHours()) + ':' + p(now.getMinutes()));
    }

    /* ---------- 登录态（未登录 / 令牌过期 → 整页跳登录页） ----------
       单点登录（SSO）：登录 token 存在 localStorage，main.html 与所有 iframe 子页共享。
         · 本框架页（顶层）是**唯一的跳转执行者**：本页请求 401、子页 401 上报、
           本地令牌到期，都汇聚到 gotoLogin()，把整个 main.html 换成 login.html；
         · 子页自己绝不跳转（iframe 里出现登录页是错的），见 js/api.js 的 onAuthExpired。
         · 多个窗口/标签页之间通过 storage 事件同步：任一处退出登录，其余窗口一起回登录页。 */
    function session() {
        try {
            var raw = window.localStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    /** 会话是否仍然有效（有 token 且未到过期时间；无过期信息时交给服务端判定） */
    function sessionValid() {
        var s = session();
        if (!s || !s.token) { return false; }
        if (window.AppAuth && window.AppAuth.expired) { return !window.AppAuth.expired(); }
        return true;
    }
    function clearSession() {
        try { window.localStorage.removeItem(SESSION_KEY); } catch (e) { }
    }
    var loginRedirecting = false;       // 已在跳转中：避免多个 401 / 定时器重复触发
    var LOGIN_PAGE = 'login.html';      // 登录页地址：**一律不带任何查询参数**
    var EXPIRED_MARK = 'menu_admin_auth_expired';
    /**
     * 把「这次是被超时踢回来的」记在 sessionStorage 里（不走地址栏参数）。
     * 登录页读一次即删，所以不会残留到下一次正常打开登录页。
     */
    function markExpiredHint(expired) {
        try {
            if (expired) { window.sessionStorage.setItem(EXPIRED_MARK, '1'); }
            else { window.sessionStorage.removeItem(EXPIRED_MARK); }
        } catch (e) { /* 隐私模式下忽略 */ }
    }
    /**
     * 整页跳登录页（顶层执行，整个框架页被替换）
     * 地址栏固定为 login.html，不带 redirect= / expired= 之类参数：
     *   · 回跳地址没有意义 —— 登录页会清空上一个账号的会话，重新登录后一律回系统首页，
     *     不会因为还带着 hash 或回跳地址就落进上一个账号的操作页；
     *   · 超时提示改为 sessionStorage 标记传递给登录页。
     * @param {Boolean} expired 是否因登录失效而跳（true 时登录页提示「登录已超时」）
     */
    function gotoLogin(expired) {
        if (loginRedirecting) { return; }
        loginRedirecting = true;
        if (expired) { clearSession(); }        // 会话已失效：清掉本地登录态，避免登录页又跳回 main.html
        markExpiredHint(expired);
        try { window.top.location.replace(LOGIN_PAGE); }
        catch (e) { try { window.location.replace(LOGIN_PAGE); } catch (e2) { /* jsdom / file:// 忽略 */ } }
    }
    /** 登录失效统一入口（供 js/api.js 直接调用 / 子页 postMessage 上报） */
    function handleAuthExpired(reason) {
        if (/login\.html$/i.test(String(window.location.pathname || ''))) { return; }
        gotoLogin(true);
    }
    /**
     * 定时体检：令牌到期（默认 8 小时）后不依赖下一个请求，直接把框架页送回登录页
     * 同时兜住「其它标签页已退出登录（本地登录态被清）」的情况。
     */
    function watchSession() {
        if (loginRedirecting) { return; }
        if (!session()) { gotoLogin(true); return; }
        if (!sessionValid()) { gotoLogin(true); }
    }
    /** 未登录直接跳到登录页（地址栏不带任何参数）；返回 false 表示已中断初始化 */
    function guardLogin() {
        var s = session();
        if (s && s.token && sessionValid()) { return true; }
        gotoLogin(!!(s && s.token));      // 有 token 但已过期 → 提示「登录已超时」
        return false;
    }
    /**
     * 顶部「改密」：走公共实现 js/changepwd.js
     * （与「帮助中心 → 修改密码」页 edituserpwd.html 同一份代码，校验规则 / 文案 / 跳转只有一处）
     */
    function openChangePwd() {
        if (window.AppChangePwd && window.AppChangePwd.open) {
            window.AppChangePwd.open();
            return;
        }
        // 兜底：只可能是浏览器缓存了旧版脚本，别让按钮点了没反应
        UI.message({ type: 'error', message: '改密组件未加载，请按 Ctrl+F5 强制刷新后重试' });
    }
    /* ---------- 系统品牌（2026-11-12）：顶部图标 / 名称、底部名称、标签页标题后缀 ----------
       全部来自系统参数表（syspara）：app_name 系统名称、app_ico 系统图标；
       兼容旧 Mock 种子键 site_name。请求失败时保留页面里写好的默认值，不影响框架可用性。 */
    function paraMapOf(list) {
        var map = {};
        for (var i = 0; i < list.length; i++) {
            var r = list[i] || {};
            map[String(r.paraNameEn || '')] = String(r.paraValue === undefined || r.paraValue === null
                ? '' : r.paraValue).trim();
        }
        return map;
    }
    function paraVal(map, keys) {
        for (var i = 0; i < keys.length; i++) {
            var v = String(map[keys[i]] || '').trim();
            if (v) { return v; }
        }
        return '';
    }
    function applySysBrand() {
        if (!(window.Api && Api.sysPara && Api.sysPara.page)) { return; }
        Api.sysPara.page({ enabled: 1, pageNum: 1, pageSize: 200 })
            .done(function (res) {
                var map = paraMapOf((res && res.list) || []);
                var name = paraVal(map, ['app_name', 'site_name']) || DEFAULT_SYS_NAME;
                var logo = paraVal(map, ['app_ico']) || DEFAULT_SYS_LOGO;
                var renamed = name !== sysName;
                sysName = name;
                $('#frameSysName').text(name);
                $('#frameFooterName').text(name);
                $('#frameSysLogo').attr('src', logo).attr('alt', name);
                document.title = name;
                if (renamed) {
                    // 系统名变了：激活 Tab 的浏览器标题后缀立即按新名重组
                    var tab = findTab(activeId);
                    if (tab) { document.title = tab.title + ' - ' + sysName; }
                }
            })
            .fail(function () { /* 取不到系统参数就保留页面默认值 */ });
    }
    /** 顶部显示当前登录人 + 绑退出登录 */
    function applyUser() {
        var s = session() || {};
        var u = s.user || {};
        var name = u.empName || u.account || '系统管理员';
        $('#frameName').text(name);
        $('#frameAvatar').text(String(name).slice(0, 1));
        var tip = [u.account ? ('账号：' + u.account) : '', u.deptName || '', u.roleNames || '']
            .filter(function (x) { return !!x; }).join(' / ');
        $('#frameUser').attr('title', tip || name);
        $('#frameChangePwd').on('click', openChangePwd);
        $('#frameLogout').on('click', function () {
            var token = s.token || '';
            function done() {
                clearSession();
                gotoLogin(false);         // 主动退出：整页回登录页，不提示「超时」
            }
            if (window.Api && window.Api.auth && token) { window.Api.auth.logout(token).always(done); }
            else { done(); }
        });
    }

    /* ---------- 初始化 ---------- */
    $(function () {
        if (!guardLogin()) { return; }        // 未登录 / 令牌过期：已跳登录页，框架不再初始化
        applyUser();
        $tabs = $('#frameTabs');
        $panes = $('#framePanes');
        $menu = $('#frameMenu');
        $side = $('#frameSide');
        $mask = $('#frameMask');
        $toggle = $('#frameToggle');
        $dot = $('#apiDot');
        $status = $('#apiStatus');
        $crumb = $('#frameCrumb');
        $collapse = $('#frameSideCollapse');

        // 左侧导航（动态生成）：分组折叠 / 页面打开 / 加载失败重试
        $menu.on('click', '[data-toggle]', function () {
            // 收起态：不切换分组展开，改为弹出该分组的子菜单
            if (isCollapsed()) {
                var $g = $(this).closest('.frame-side__group');
                if ($g.data('fly') === 'on') { $g.data('fly', 'off'); hideFly(); }
                else { $('.frame-side__group').data('fly', 'off'); $g.data('fly', 'on'); showFly($g); }
                return;
            }
            $(this).closest('.frame-side__group').toggleClass('is-open');
        });
        $menu.on('click', '#navRetry', function () { loadNav(); });
        // 收起态：悬停分组 → 弹出子菜单（鼠标移开后再收起）
        $menu.on('mouseenter', '.frame-side__group', function () { showFly($(this)); });
        $menu.on('mouseleave', '.frame-side__group', scheduleHideFly);
        $menu.on('click', '.frame-side__item', function () { hideFly(); });
        $menu.on('click', '.frame-side__item', function (e) {
            var $it = $(this);
            if ($it.hasClass('is-disabled')) {              // 未配置页面 / 未绑定菜单项
                e.preventDefault();
                UI.alert({
                    title: '演示说明', type: 'info',
                    message: '该菜单尚未配置功能页面地址。请到「菜单项管理」填写「功能页面地址（URL）」，' +
                        '再到「菜单组项目管理」把它绑定到对应菜单组。'
                });
                return;
            }
            var url = $it.attr('data-url') || '';
            if (!/\.html($|\?)/.test(url)) { return; }
            e.preventDefault();
            openNavPage(url, $it.attr('data-crumb') || '', $it.attr('data-title') || '');
            if (isMobile()) { closeSide(); }
        });

        // Tab 切换 / 关闭
        $tabs.on('click', '.frame-tab', function () {
            activate($(this).attr('data-id'));
        });
        $tabs.on('click', '[data-close]', function (e) {
            e.stopPropagation();
            close($(this).closest('.frame-tab').attr('data-id'));
        });
        $('#tabCloseOthers').on('click', function () {
            var keep = activeId;
            var ids = [];
            for (var i = 0; i < tabs.length; i++) {
                if (tabs[i].id !== keep && tabs[i].closable) { ids.push(tabs[i].id); }
            }
            for (var j = 0; j < ids.length; j++) { close(ids[j], { silent: true }); }
            activate(keep || (tabs.length ? tabs[0].id : ''));
        });
        $('#tabCloseAll').on('click', function () {
            var ids = [];
            for (var i = 0; i < tabs.length; i++) { if (tabs[i].closable) { ids.push(tabs[i].id); } }
            for (var j = 0; j < ids.length; j++) { close(ids[j], { silent: true }); }
            openTab(DEFAULT_PAGE);
        });

        // 移动端抽屉
        $toggle.on('click', function () {
            if ($side.hasClass('is-open')) { closeSide(); } else { openSide(); }
        });
        $mask.on('click', closeSide);
        $(document).on('click', function (e) {                  // 点到别处时收起悬浮子菜单
            if (!$(e.target).closest('.frame-side, .frame-side__flyout').length) { hideFly(); }
        });
        // 左侧导航收起 / 展开（状态记忆在 localStorage）
        collapsed = readCollapsed();
        applyCollapse();
        $collapse.on('click', toggleCollapsed);
        $(window).on('resize', function () {
            if (!isMobile()) { closeSide(); }
            applyCollapse();        // 移动端抽屉模式强制展开，回到桌面端再恢复
            hideFly();
        });

        // 地址栏 hash → 打开对应 Tab
        $(window).on('hashchange', function () {
            var url = hashUrl();
            var tab = findTabByUrl(url);
            if (tab) { activate(tab.id); return; }
            openTab(url, { hash: false });
        });

        // 系统首页永远是第一个 Tab：即使地址栏 hash 指向别的页面（如上次停在邮箱助手）也要先建首页，
        // 否则刷新 / 重新登录后首页 Tab 会「消失」（关闭全部 Tab 也找不回来）。
        // 注意：openTab 会同步改写 hash，所以必须先把初始 hash 取下来。
        var initialUrl = hashUrl();
        openTab(DEFAULT_PAGE);
        if (pageOf(initialUrl) !== pageOf(DEFAULT_PAGE)) { openTab(initialUrl); }
        // 等接口地址探测完成再拉导航：避免同源没有后端时先拿到本地模拟菜单（菜单顺序/内容与库不一致）
        if (window.Api && window.Api.whenReady) {
            window.Api.whenReady(function () { loadNav(); });
        } else {
            loadNav();              // 菜单就绪后会自动补高亮与底栏面包屑
        }
        probeBackend();
        // 系统品牌（顶部图标 / 名称、底部名称、标题后缀）从系统参数表拉取（Api 就绪后再请求）
        if (window.Api && window.Api.whenReady) { window.Api.whenReady(applySysBrand); } else { applySysBrand(); }
        tickClock();
        window.setInterval(tickClock, 30000);
        window.setInterval(probeBackend, 60000);

        /* ---------- 消息提醒中心：顶栏铃铛 + 左侧菜单上标 + 新消息语音提醒 ----------
           自己开一条 WebSocket 收 msg 帧（后端把消息推给该员工的全部连接），
           同时定时轮询 /api/notify/summary 兜底（邮件由后台线程收件，没有 WS 推送）。 */
        if (window.AppNotify && window.AppNotify.start) { window.AppNotify.start(); }

        /* ---------- 单点登录：令牌失效 → 整个框架页（而不是 iframe）回登录页 ---------- */
        // 1) iframe 子页里请求返回 401：子页只上报，这里统一把整个 main.html 换成 login.html
        window.addEventListener('message', function (e) {
            var d = e && e.data;
            if (!d || d.type !== 'app:auth-expired') { return; }
            handleAuthExpired(d.reason);
        });
        // 2) 其它窗口 / 标签页退出登录或令牌过期（localStorage 被清）→ 本窗口同步回登录页
        try {
            window.addEventListener('storage', function (e) {
                if (e && e.key && e.key !== SESSION_KEY) { return; }
                if (!session()) { gotoLogin(true); return; }
                loadNav({ silent: true });      // 换了账号 / 重新登录：刷新左侧导航
                // 换了账号：未读数全部重算（清掉上一个账号的徽标）
                if (window.AppNotify && window.AppNotify.refresh) { window.AppNotify.refresh({ silent: true }); }
            });
        } catch (e) { /* 老浏览器不支持 storage 事件，忽略 */ }
        // 3) 令牌到期（默认 8 小时）：到点主动跳转，不等下一次请求
        window.setInterval(watchSession, 30000);
    });

    return {
        navigate: function (url, opts) { return openTab(url, opts); },
        sync: function (url) {
            var tab = findTab(activeId);
            if (!tab) { openTab(url); return; }
            tab.url = relOf(url);
            syncMenu(tab.url);
            writeHash(relOf(tab.url));
        },
        current: function () {
            var tab = findTab(activeId);
            return tab ? tab.url : '';
        },
        /** 供 iframe 内子页面调用：上报自身面包屑（新增→编辑等变化会再次上报） */
        setCrumb: function (text) {
            var tab = findTab(activeId);
            if (!tab) { return; }
            tab.crumb = String(text || '');
            updateCrumb(tab);
        },
        /** 供 iframe 内子页面调用：其面包屑内容变化时同步底部显示 */
        refreshCrumb: function () { updateCrumb(findTab(activeId)); },
        /** 菜单组 / 菜单项 / 绑定关系变更后重新拉取左侧导航（静默重载：不闪「加载中」、保留折叠状态） */
        reloadNav: function () { loadNav({ silent: true }); },
        /** 单点登录：iframe 子页上报登录失效时调用（js/api.js 的 401 汇聚入口）→ 整个框架页跳登录页 */
        onAuthExpired: handleAuthExpired,
        /** 当前登录态是否仍有效（有 token 且未过期） */
        sessionValid: sessionValid,
        /** 令牌剩余有效毫秒（未登录 / 无过期信息为 0） */
        sessionRemain: function () {
            return (window.AppAuth && window.AppAuth.remain) ? window.AppAuth.remain() : 0;
        },
        /** 收起 / 展开左侧导航：不传参=切换，传 true/false=直接设置 */
        toggleCollapse: function (on) {
            return (on === undefined) ? toggleCollapsed() : setCollapsed(!!on);
        },
        isCollapsed: isCollapsed,
        count: function () { return tabs.length; }
    };
})(jQuery);
