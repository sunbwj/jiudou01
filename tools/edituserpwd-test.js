/* ==========================================================================
   edituserpwd-test.js —— 帮助中心「修改密码」页（edituserpwd.html）测试
   覆盖：① 页面骨架与「不受按钮权限管控」的约定（按钮容器不是 .toolbar 等）
        ② 有登录态时自动弹出与 main.html 顶栏「改密」相同的对话框
        ③ 前端校验（原密码空 / 太短 / 全同字符 / 两次不一致 / 新旧相同）
        ④ 提交成功：参数正确、清本地登录态、给登录页留 'pwd' 标记
        ⑤ 提交失败：不清登录态、按钮恢复、可重试
        ⑥ 未登录 / 登录态过期：不弹窗
        ⑦ 关闭后可再次打开，且不会叠出第二个弹窗
        ⑧ 实现复用：frame.js 调 AppChangePwd、不再自带一份弹窗；btnperm 豁免；后端常驻放行
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/edituserpwd-test.js
   ========================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var JSDOM = (function () {
    try { return require('jsdom').JSDOM; } catch (e) { return null; }
})();

var ROOT = path.resolve(__dirname, '..');
var pass = 0, fail = 0;

function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(cond, ms) {
    var end = Date.now() + (ms || 2000);
    while (Date.now() < end) { if (cond()) { return true; } await wait(15); }
    return false;
}

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

var SESSION_KEY = 'menu_admin_login_v1';
var MARK_KEY = 'menu_admin_auth_expired';

/** 启动页面：只装本页真正引用的脚本（不含 layout.js，避免无关的侧栏初始化） */
function boot(session) {
    var dom = new JSDOM(read('edituserpwd.html'), {
        url: 'http://127.0.0.1:8808/edituserpwd.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.__pwdCalls = [];
    win.__pwdFail = false;
    if (session) { win.localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.jQuery.ajax = function () {                     // 无后端：其余请求一律失败（本页不依赖）
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/btnperm.js'));
    win.Api.rolePower = win.Api.rolePower || {};
    win.Api.rolePower.myButtons = function () {
        var d = win.jQuery.Deferred();
        d.resolve({ unrestricted: true, pages: {} });
        return d.promise();
    };
    // 只打桩改密接口：Mock 内部逻辑已由 password-test 覆盖，这里只验页面行为
    win.Api.auth.changepwd = function (data) {
        win.__pwdCalls.push(data || {});
        var d = win.jQuery.Deferred();
        if (win.__pwdFail) { d.reject(new Error('原密码不正确')); } else { d.resolve({ changed: true, logout: true }); }
        return d.promise();
    };
    win.eval(read('js/changepwd.js'));
    win.eval(read('js/edituserpwd.js'));
    return win;
}

function $(win, sel) { return win.jQuery(sel); }
function fill(win, oldPwd, newPwd, newPwd2) {
    $(win, '#cpOld').val(oldPwd);
    $(win, '#cpNew').val(newPwd);
    $(win, '#cpNew2').val(newPwd2);
}
function clickOk(win) { $(win, '.el-dialog .btn-ok').trigger('click'); }

var LIVE = {
    token: 'tk-edituserpwd',
    time: '2026-11-12 10:00:00',
    expireAt: Date.now() + 3600 * 1000,
    user: { account: 'sunbwj', empName: '孙博文', deptName: '研发中心', roleNames: '系统管理员' }
};

(async function () {
    /* ---------------- 1. 页面骨架与权限约定（静态） ---------------- */
    console.log('\n--- 1. 页面骨架 / 不受按钮权限管控 ---');
    var html = read('edituserpwd.html');
    check('面包屑是「帮助中心/修改密码」', html.indexOf('data-crumb="帮助中心/修改密码"') > -1);
    check('页面标题为「修改密码」', /<h2 class="page-head__title">修改密码<\/h2>/.test(html));
    var sideNav = (/<nav class="app-side__menu">([\s\S]*?)<\/nav>/.exec(html) || [])[1] || '';
    check('侧栏同时给出「修改密码」与「使用说明书」，且当前项高亮',
        sideNav.indexOf('修改密码') > -1 && sideNav.indexOf('使用说明书') > -1
        && sideNav.indexOf('is-active') > -1, sideNav.slice(0, 60));
    // 只看 class 属性值（注释里提到 .toolbar 不算）
    var classAttrs = (html.match(/class="[^"]*"/g) || []).map(function (s) {
        return s.slice(7, -1);
    });
    var scanHosts = classAttrs.filter(function (c) {
        return /(^|\s)(toolbar|pick-toolbar|form-actions)(\s|$)/.test(c);
    });
    check('操作按钮容器不是 .toolbar / .pick-toolbar / .form-actions（page_scan 不收录）',
        scanHosts.length === 0 && html.indexOf('class="pwd-actions"') > -1,
        scanHosts.join('|'));
    check('引用了公共改密脚本 js/changepwd.js', /js\/changepwd\.js\?v=/.test(html));
    check('没有把框架脚本 frame.js 拉进本页', html.indexOf('js/frame.js') < 0);
    check('页面上写明「不受角色权限限制」', html.indexOf('不受角色权限限制') > -1);

    var btnPerm = read('js/btnperm.js');
    check('btnperm.js 的 EXEMPT 含 edituserpwd.html',
        btnPerm.indexOf("'edituserpwd.html': 1") > -1);
    var frameJs = read('js/frame.js');
    check('frame.js 的改密走公共实现 AppChangePwd',
        /function openChangePwd\(\)[\s\S]{0,200}AppChangePwd/.test(frameJs));
    check('frame.js 不再自带一份弹窗模板（没有 cpOld 录入框）',
        frameJs.indexOf("id=\"cpOld\"") < 0);
    var svc = read('server/service.py');
    check('后端把 edituserpwd.html 列为常驻菜单项（NAV_ALWAYS_PATHS）',
        /NAV_ALWAYS_PATHS\s*=\s*\(\s*'edituserpwd\.html'/.test(svc));
    check('后端常驻放行只作用于真实登录（scope == token）',
        /if scope == 'token':[\s\S]{0,400}NAV_ALWAYS_PATHS/.test(svc));

    /* ---------------- 2. 自动弹出同一对话框 ---------------- */
    console.log('\n--- 2. 打开页面自动弹出改密对话框 ---');
    var win = boot(LIVE);
    var opened = await until(function () { return win.document.querySelectorAll('.frame-pwd').length > 0; }, 3000);
    check('打开页面后自动弹出对话框', opened);
    check('弹窗标题「修改登录密码」',
        $(win, '.el-dialog__title').text() === '修改登录密码', $(win, '.el-dialog__title').text());
    check('三个密码录入框齐全（原密码 / 新密码 / 确认）',
        $(win, '#cpOld').length === 1 && $(win, '#cpNew').length === 1 && $(win, '#cpNew2').length === 1);
    check('三个录入框都是密码类型',
        ['#cpOld', '#cpNew', '#cpNew2'].every(function (s) {
            return String($(win, s).attr('type')) === 'password';
        }));
    check('提示「修改成功后需要重新登录」', /立即失效/.test($(win, '.frame-pwd .form-tip').text()));
    check('页面显示当前账号信息（账号 / 姓名 / 部门 / 角色）',
        $(win, '#pwdAccount').text() === 'sunbwj' && $(win, '#pwdName').text() === '孙博文'
        && $(win, '#pwdDept').text() === '研发中心' && $(win, '#pwdRoles').text() === '系统管理员',
        [$(win, '#pwdAccount').text(), $(win, '#pwdName').text(), $(win, '#pwdDept').text(), $(win, '#pwdRoles').text()].join('/'));

    /* ---------------- 3. 前端校验（不发请求） ---------------- */
    console.log('\n--- 3. 前端校验 ---');
    clickOk(win);
    check('原密码为空 → 不提交', win.__pwdCalls.length === 0, String(win.__pwdCalls.length));
    check('校验失败时弹窗不关闭', win.document.querySelectorAll('.frame-pwd').length === 1);

    fill(win, 'old123', '123', '123'); clickOk(win);
    check('新密码不足 6 位 → 不提交', win.__pwdCalls.length === 0);

    fill(win, 'old123', '123456', '654321'); clickOk(win);
    check('两次输入不一致 → 不提交', win.__pwdCalls.length === 0);

    fill(win, 'old123', '111111', '111111'); clickOk(win);
    check('新密码是同一字符重复 → 不提交', win.__pwdCalls.length === 0);

    fill(win, 'old123', 'old123', 'old123'); clickOk(win);
    check('新密码与原密码相同 → 不提交', win.__pwdCalls.length === 0);

    /* ---------------- 4. 提交成功：清登录态 + 留标记 ---------------- */
    console.log('\n--- 4. 提交成功后的收尾 ---');
    fill(win, 'old123', 'new456', 'new456');
    clickOk(win);
    await until(function () { return win.__pwdCalls.length > 0; }, 2000);
    check('提交参数正确（oldPassword / newPassword）',
        win.__pwdCalls.length === 1 && win.__pwdCalls[0].oldPassword === 'old123'
        && win.__pwdCalls[0].newPassword === 'new456', JSON.stringify(win.__pwdCalls[0]));
    await wait(60);
    check('成功后清掉本地登录态', !win.localStorage.getItem(SESSION_KEY));
    check('给登录页留下 pwd 标记', win.sessionStorage.getItem(MARK_KEY) === 'pwd',
        String(win.sessionStorage.getItem(MARK_KEY)));
    check('成功后弹窗关闭', win.document.querySelectorAll('.frame-pwd').length === 0);

    /* ---------------- 5. 后端拒绝：不清登录态、可重试 ---------------- */
    console.log('\n--- 5. 后端拒绝时 ---');
    var win2 = boot(LIVE);
    await until(function () { return win2.document.querySelectorAll('.frame-pwd').length > 0; }, 3000);
    win2.__pwdFail = true;
    fill(win2, 'wrongold', 'new456', 'new456');
    clickOk(win2);
    await until(function () { return win2.__pwdCalls.length > 0; }, 2000);
    await wait(60);
    check('原密码错误：保留登录态（用户还能重试）', !!win2.localStorage.getItem(SESSION_KEY));
    check('原密码错误：不写 pwd 标记', !win2.sessionStorage.getItem(MARK_KEY));
    check('失败后「确定」按钮恢复可用',
        $(win2, '.el-dialog .btn-ok').prop('disabled') === false
        && $(win2, '.el-dialog .btn-ok').text() === '确定', $(win2, '.el-dialog .btn-ok').text());
    win2.__pwdFail = false;
    fill(win2, 'rightold', 'new789', 'new789');
    clickOk(win2);
    await until(function () { return win2.__pwdCalls.length > 1; }, 2000);
    check('失败后可再次提交', win2.__pwdCalls.length === 2);

    /* ---------------- 6. 未登录 / 已过期：不弹窗 ---------------- */
    console.log('\n--- 6. 没有有效登录态时不弹窗 ---');
    var win3 = boot(null);
    await wait(520);
    check('无登录态：不弹窗', win3.document.querySelectorAll('.frame-pwd').length === 0);
    var win4 = boot({ token: 'tk-old', expireAt: Date.now() - 60000, user: { account: 'x' } });
    await wait(520);
    check('登录态已过期：不弹窗', win4.document.querySelectorAll('.frame-pwd').length === 0);

    /* ---------------- 7. 关闭后可再次打开，且不叠层 ---------------- */
    console.log('\n--- 7. 手动再次打开 ---');
    var win5 = boot(LIVE);
    await until(function () { return win5.document.querySelectorAll('.frame-pwd').length > 0; }, 3000);
    check('自动弹窗只有一个', win5.document.querySelectorAll('.el-overlay').length === 1,
        String(win5.document.querySelectorAll('.el-overlay').length));
    $(win5, '#btnChangePwd').trigger('click');
    check('已有弹窗时点按钮不会叠出第二个', win5.document.querySelectorAll('.el-overlay').length === 1);
    $(win5, '.el-dialog .btn-cancel').trigger('click');
    check('取消后弹窗关闭', win5.document.querySelectorAll('.el-overlay').length === 0);
    $(win5, '#btnChangePwd').trigger('click');
    check('关掉后可再次打开', win5.document.querySelectorAll('.frame-pwd').length === 1);

    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
})();
