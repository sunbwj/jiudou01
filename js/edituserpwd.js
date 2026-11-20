/* ==========================================================================
   edituserpwd.js —— 帮助中心「修改密码」页（edituserpwd.html）
   --------------------------------------------------------------------------
   · 页面本身只是一张说明卡：显示当前登录账号 / 员工 / 部门 / 角色 + 密码规则；
   · 打开页面后**自动弹出**「修改登录密码」对话框（与 main.html 顶栏「改密」同一个
     实现 js/changepwd.js，不是复制品），关掉后点按钮可再次打开；
   · 该页放在「帮助中心」下，属于账号自助能力：**不受角色按钮权限管控**
     （js/btnperm.js 的 EXEMPT 名单 + 后端 /api/nav 的常驻菜单项豁免）；
   · 没有登录态（或本地已知过期）时不弹窗，直接整页回登录页。
   ========================================================================== */
(function (window) {
    'use strict';
    var $ = window.jQuery;
    var SESSION_KEY = 'menu_admin_login_v1';
    var LOGIN_PAGE = 'login.html';
    var AUTO_OPEN_DELAY = 320;        // 首屏先画出来，再弹窗，避免白屏闪一下

    function session() {
        try {
            var raw = window.localStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function expired(s) {
        if (!s || !s.token) { return true; }
        if (!s.expireAt) { return false; }
        return Number(s.expireAt) <= new Date().getTime();
    }
    function gotoLogin() {
        try { window.top.location.replace(LOGIN_PAGE); }
        catch (e) { try { window.location.replace(LOGIN_PAGE); } catch (e2) { /* 忽略 */ } }
    }

    function fillProfile(user) {
        var u = user || {};
        var name = u.empName || u.account || '';
        $('#pwdAccount').text(u.account || '—');
        $('#pwdName').text(u.empName || '—');
        $('#pwdDept').text(u.deptName || '—');
        $('#pwdRoles').text(u.roleNames || '—');
        if (name) {
            $('#pwdAvatar').text(String(name).slice(0, 1));
            $('#pwdHello').text('你好，' + name);
        }
        var tip = [u.account ? ('账号：' + u.account) : '', u.deptName || '', u.roleNames || '']
            .filter(function (x) { return !!x; }).join(' / ');
        if (tip) { $('#pwdHello').attr('title', tip); }
    }

    function openDialog() {
        if (window.AppChangePwd && window.AppChangePwd.open) {
            window.AppChangePwd.open();
            return;
        }
        // 组件没加载（缓存了旧版 changepwd.js 等）：明确提示，不留空白
        if (window.UI && window.UI.message) {
            window.UI.message({ type: 'error', message: '改密组件未加载，请按 Ctrl+F5 强制刷新后重试' });
        }
    }

    $(function () {
        var s = session();
        if (expired(s)) { gotoLogin(); return; }     // 没登录 / 已过期：不弹窗，先回登录页
        fillProfile(s.user);

        $('#btnChangePwd').on('click', function () { openDialog(); });
        // 页内说明里的「直接打开」链接（同一入口）
        $('#lnkChangePwd').on('click', function (e) {
            e.preventDefault();
            openDialog();
        });

        window.setTimeout(function () {
            if (expired(session())) { gotoLogin(); return; }   // 等这 300ms 期间登录态可能被其它页清掉
            openDialog();
        }, AUTO_OPEN_DELAY);
    });
})(window);
