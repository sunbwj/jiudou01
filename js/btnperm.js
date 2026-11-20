/* ==========================================================================
   btnperm.js —— 各功能页按「当前用户角色被授权的页面操作按钮」加载按钮
   --------------------------------------------------------------------------
   · 数据源：GET /api/rolepower/mybuttons
       { unrestricted, pages: { 'emp.html': { pageName, buttons:[{btnId, btnText, allowed}] } } }
   · 规则：
       ① 页面加载时先拉本页的按钮授权；**只保留被授权的按钮**，
          未授权的按钮不渲染（display:none + aria-hidden + 不可点），而不是灰着；
       ② 用户没有分配任何角色（unrestricted=true）→ 不筛选（避免把管理员锁死）；
       ③ 当前页面在 pageopbtn 里没有登记按钮 → 不筛选；
       ④ 权限管理页自身（role-power.html / page-op-btn.html）不筛选，避免误配置后无法自救；
       ⑤ 拉取期间先隐住操作区（.btnperm-loading），避免未授权按钮闪一下。
   · 对外：window.AppBtnPerm = { ready, apply, isAllowed, hiddenIds, page }
   · 只做「按钮出现/不出现」：真正的数据权限仍由后端按 token 校验。
   ========================================================================== */
(function (window) {
    'use strict';
    var $ = window.jQuery;
    var ALLOW = null;          // {unrestricted, pages}
    var HIDDEN = {};           // btnId -> 1（被判定为未授权、已从界面隐藏）
    var PAGE = '';
    // 权限管理页自身不设限（避免误取消授权后无法自救）；
    // 工作计划三页（计划管理 / 设计器 / 我的任务）按用户角色**豁免**按钮权限：
    // 设计器是「打页子页」、没有菜单项，按菜单树无法授权，也不做按钮级细分。
    // 「帮助中心 / 修改密码」（edituserpwd.html）是**账号自助能力**：所有用户都必须能改自己的密码，
    // 因此按按钮权限豁免；后端 /api/nav 也把它列为常驻菜单项，两侧同时不受角色管控。
    var EXEMPT = {
        'role-power.html': 1,
        'page-op-btn.html': 1,
        'edituserpwd.html': 1,
        'workplan.html': 1,
        'workplan-design.html': 1,
        'workplan-task.html': 1,
        'workplan-orders.html': 1,
        'requirement.html': 1
    };
    var LOADING = 'btnperm-loading';
    var READY_CBS = [];
    var DONE = false;

    function pageKey() {
        var p = String(window.location.pathname || '').split('/').pop() || '';
        try { p = decodeURIComponent(p); } catch (e) { /* 忽略 */ }
        return String(p || '').toLowerCase();
    }

    function injectStyle() {
        if (!window.document || window.document.getElementById('btnPermStyle')) { return; }
        var css = '.is-perm-hidden{display:none !important;}' +
            '.' + LOADING + ' .toolbar .el-button,' +
            '.' + LOADING + ' .pick-toolbar .el-button,' +
            '.' + LOADING + ' .form-actions .el-button,' +
            '.' + LOADING + ' .pj-filepanel__actions .el-button{visibility:hidden !important;}';
        var style = window.document.createElement('style');
        style.id = 'btnPermStyle';
        style.type = 'text/css';
        style.appendChild(window.document.createTextNode(css));
        (window.document.head || window.document.documentElement).appendChild(style);
    }

    function setLoading(on) {
        var root = window.document.documentElement;
        if (!root || !root.classList) { return; }
        if (on) { root.classList.add(LOADING); }
        else { root.classList.remove(LOADING); }
    }

    /** 未授权：不渲染（display:none + 不可点 + 无 Tab 焦点） */
    function hide(el, text) {
        if (!el || !el.id) { return; }
        HIDDEN[el.id] = 1;
        if ('disabled' in el) { el.disabled = true; }
        el.setAttribute('hidden', 'hidden');
        el.setAttribute('aria-hidden', 'true');
        el.setAttribute('data-perm', 'hidden');
        if (el.classList) { el.classList.add('is-perm-hidden'); }
        var title = text || el.getAttribute('title') || '';
        if (title) { el.setAttribute('data-perm-title', title); }
    }

    function finish() {
        DONE = true;
        setLoading(false);
        for (var i = 0; i < READY_CBS.length; i++) {
            try { READY_CBS[i](window.AppBtnPerm); } catch (e) { /* 单个回调失败不影响页面 */ }
        }
        READY_CBS = [];
    }

    function apply() {
        if (!ALLOW || ALLOW.unrestricted || EXEMPT[PAGE]) { return; }
        var page = ALLOW.pages ? ALLOW.pages[PAGE] : null;
        if (!page || !page.buttons) { return; }
        for (var i = 0; i < page.buttons.length; i++) {
            var b = page.buttons[i];
            if (!b || b.allowed) { continue; }
            var el = window.document.getElementById(String(b.btnId || ''));
            if (!el) { continue; }
            /* 即时对话输入区的媒体工具（图片 / 表情 / 文件 / 语音 / 截屏）属于「聊天能力」，
               不是页面操作按钮 —— 不按角色按钮权限隐藏，否则整个工具行会凭空消失。
               （#imInputTools 会被 page_scan 收录进 pageopbtn，这里做定向豁免。） */
            if (el.closest && el.closest('#imInputTools, .im-input__tools')) { continue; }
            hide(el, b.btnText);
        }
    }

    function load() {
        setLoading(true);
        if (!window.Api || !window.Api.rolePower || !window.Api.rolePower.myButtons) {
            ALLOW = null;
            finish();
            return;
        }
        window.Api.rolePower.myButtons().done(function (res) {
            var d = (res && res.data) || res || {};
            if (d && d.pages) {
                ALLOW = { unrestricted: !!d.unrestricted, pages: d.pages };
                apply();
            }
            finish();
        }).fail(function () {
            ALLOW = null;                 // 取不到权限就全部照常显示，别把页面弄空
            finish();
        });
    }

    var AppBtnPerm = {
        apply: apply,
        isAllowed: function (btnId) { return !HIDDEN[String(btnId || '')]; },
        hiddenIds: function () { return Object.keys(HIDDEN); },
        deniedIds: function () { return Object.keys(HIDDEN); },   // 兼容旧调用
        page: function () { return PAGE; },
        /** 页面可等权限落定后再初始化（避免把按钮事件绑到已被隐藏的节点上） */
        ready: function (cb) {
            if (typeof cb !== 'function') { return; }
            if (DONE) { cb(AppBtnPerm); } else { READY_CBS.push(cb); }
        }
    };

    $(function () {
        PAGE = pageKey();
        injectStyle();
        if (EXEMPT[PAGE]) { DONE = true; window.AppBtnPerm = AppBtnPerm; return; }
        load();
        // 首屏脚本可能后塞按钮：权限落定后再补一次
        window.setTimeout(function () { apply(); }, 800);
    });

    window.AppBtnPerm = AppBtnPerm;
})(window);
