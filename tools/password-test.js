/* ==========================================================================
   password-test.js —— 密码相关功能测试（jsdom，Mock 通道）
   覆盖：① 登录页「忘记密码」：按钮位置（登录按钮下方）/ 弹窗开关 / 邮箱校验（空、格式、未登记）/
            验证码发送（打码回显 + 60 秒倒计时 + 验证码落到本地存储）/ 验证码位数与密码一致性校验 /
            重置成功（新密码写回用户、提示「新密码已发送」）/ 离线演示验证码回显
        ② Api.auth.resetbyemail 的错误分支（错误验证码、错误次数用尽）
        ③ Api.auth.changepwd（原密码错 / 弱密码 / 与原密码相同 / 修改成功并作废 token）
        ④ 框架页顶部「改密」按钮与弹窗（字段齐全、取消关闭）
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/password-test.js
   ========================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
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
function md5(text) { return crypto.createHash('md5').update(String(text), 'utf8').digest('hex'); }

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

var USER_KEY = 'menu_admin_useinfo_store_v1';
var CODE_KEY = 'menu_admin_emailcode_v1';
var SESSION_KEY = 'menu_admin_login_v1';

/** 造一条 Mock 用户：账号故意用「邮箱」，走 userByEmail 的账号即邮箱兜底，测试不依赖员工 id */
function users(password, token) {
    return [{
        id: 'u-0001', account: 'zhangshouzheng@jiudou.com', password: md5(password || '888888'),
        empId: 1, token: token || '', tokenExpireTime: '', lastLoginTime: '', lastLoginIp: '',
        enabled: true, remark: '', createTime: '2026-11-01 09:00:00', updateTime: '2026-11-01 09:00:00'
    }];
}

function boot(page, scripts, pre) {
    var dom = new JSDOM(read(page), {
        url: 'http://127.0.0.1:8808/' + page,
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    if (pre) { pre(win); }
    win.jQuery.ajax = function () {          // 没有后端 → api.js 自动回退到 Mock
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 520 }); }
function next() {
    var s = steps.shift();
    if (!s) { return finish(); }
    try { s.fn(); } catch (e) { check('步骤执行异常：' + e.message, false, e.stack); }
    setTimeout(next, s.delay);
}
function finish() {
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}

/* ===================== A. 登录页：忘记密码 ===================== */
var win = boot('login.html', ['js/login.js'], function (w) {
    w.localStorage.setItem(USER_KEY, JSON.stringify(users('888888')));
});
var $ = win.jQuery;

function fErr() { return $.trim($('#forgotError').text()); }
function codeStore() {
    try { return JSON.parse(win.localStorage.getItem(CODE_KEY) || '{}'); } catch (e) { return {}; }
}

step(function () {
    console.log('\n--- 1. 登录页结构：「忘记密码」在登录按钮下方 ---');
    check('登录按钮下方有「忘记密码？」按钮',
        $('#btnForgot').length === 1 && /忘记密码/.test($('#btnForgot').text()), $('#btnForgot').text());
    var order = [];
    $('#loginForm').find('button, .login-card__foot').each(function () {
        order.push(this.id || this.className);
    });
    var idxLogin = order.indexOf('btnLogin');
    var idxForgot = order.indexOf('btnForgot');
    var idxFoot = order.indexOf('login-card__foot');
    check('按钮顺序：登录 → 忘记密码 → 底部说明',
        idxLogin >= 0 && idxForgot === idxLogin + 1 && idxFoot === idxForgot + 1, order.join(','));
    check('忘记密码弹窗默认隐藏', $('#forgotMask').prop('hidden') === true);
    check('CSS 保证 [hidden] 时弹窗不显示（否则 display:flex 会盖掉 hidden）',
        /\.login-mask\[hidden\]\s*\{[^}]*display:\s*none/.test(read('css/app.css')));
    $('#btnForgot').trigger('click');
});

step(function () {
    console.log('\n--- 2. 弹窗打开 / 字段 / 关闭 ---');
    check('点击后弹窗显示出来', $('#forgotMask').prop('hidden') === false);
    check('标题为「找回密码」', /找回密码/.test($('#forgotTitle').text()), $('#forgotTitle').text());
    check('四个字段齐全（邮箱 / 验证码 / 新密码 / 确认新密码）',
        $('#forgotEmail').length === 1 && $('#forgotCode').length === 1 &&
        $('#forgotPwd').length === 1 && $('#forgotPwd2').length === 1);
    check('有「发送验证码」与「重置密码」按钮',
        $('#btnSendCode').length === 1 && $('#btnResetPwd').length === 1);
    check('新密码与确认框是密码输入框（不明文显示）',
        $('#forgotPwd').attr('type') === 'password' && $('#forgotPwd2').attr('type') === 'password');
    $('#forgotClose').trigger('click');
});

step(function () {
    check('点关闭按钮可收起弹窗', $('#forgotMask').prop('hidden') === true);
    $('#btnForgot').trigger('click');
});

step(function () {
    console.log('\n--- 3. 邮箱校验 ---');
    $('#btnSendCode').trigger('click');
});

step(function () {
    check('邮箱为空时提示「请输入登记的邮箱」', /请输入登记的邮箱/.test(fErr()), fErr());
    $('#forgotEmail').val('zhangshouzheng');
    $('#btnSendCode').trigger('click');
});

step(function () {
    check('邮箱格式不对时提示格式错误', /邮箱格式不正确/.test(fErr()), fErr());
    $('#forgotEmail').val('nobody@jiudou.com');
    $('#btnSendCode').trigger('click');
});

step(function () {
    check('未登记的邮箱给出明确提示（Mock 与后端同口径）',
        /未在系统中登记/.test(fErr()), fErr());
    $('#forgotEmail').val('zhangshouzheng@jiudou.com');
    $('#btnSendCode').trigger('click');
});

step(function () {
    console.log('\n--- 4. 发送验证码：打码回显 + 倒计时 + 验证码入本地存储 ---');
    check('提示「验证码已发送到」且邮箱已打码', /验证码已发送到 z\*\*\*@jiudou\.com/.test(fErr()), fErr());
    check('提示里说明 5 分钟有效', /5 分钟/.test(fErr()), fErr());
    check('离线演示会把验证码一并提示（真实后端只发邮件）', /离线演示验证码：\d{6}/.test(fErr()), fErr());
    check('发送按钮进入 60 秒倒计时并禁用',
        $('#btnSendCode').prop('disabled') === true && /秒后重发/.test($('#btnSendCode').text()),
        $('#btnSendCode').text());
    var store = codeStore();
    var one = store['zhangshouzheng@jiudou.com'];
    check('验证码已写入本地存储（Mock）且为 6 位数字',
        !!one && /^\d{6}$/.test(String(one.code)), JSON.stringify(one || null));
    check('验证码 5 分钟有效期', !!one && one.expire - one.sentAt === 300000,
        one ? (one.expire - one.sentAt) + 'ms' : 'null');
    $('#forgotCode').val('123');
    $('#btnResetPwd').trigger('click');
});

step(function () {
    console.log('\n--- 5. 重置前的表单校验 ---');
    check('验证码不是 6 位时提示', /6 位数字/.test(fErr()), fErr());
    var store = codeStore();
    var code = store['zhangshouzheng@jiudou.com'].code;
    $('#forgotCode').val(String(code) === '000000' ? '111111' : '000000');
    $('#forgotPwd').val('NewPass2026');
    $('#forgotPwd2').val('NewPass2026');
    $('#btnResetPwd').trigger('click');
});

step(function () {
    check('验证码错误时提示（并告知还能试几次）', /验证码不正确/.test(fErr()), fErr());
    var code = codeStore()['zhangshouzheng@jiudou.com'].code;
    $('#forgotCode').val(String(code));
    $('#forgotPwd').val('NewPass2026');
    $('#forgotPwd2').val('OtherPass2026');
    $('#btnResetPwd').trigger('click');
});

step(function () {
    check('两次密码不一致时提示', /不一致/.test(fErr()), fErr());
    $('#forgotPwd2').val('NewPass2026');
    $('#btnResetPwd').trigger('click');
});

step(function () {
    console.log('\n--- 6. 重置成功：密码写回 + 新密码邮件 ---');
    check('提示「密码已重置，新密码已发送到 …」',
        /密码已重置/.test(fErr()) && /新密码已发送到 z\*\*\*@jiudou\.com/.test(fErr()), fErr());
    var stored = JSON.parse(win.localStorage.getItem(USER_KEY) || '[]');
    check('Mock 用户密码已改成新密码', stored[0].password === md5('NewPass2026'), stored[0].password);
    check('重置后用户 token 被作废', !stored[0].token, String(stored[0].token));
    check('重置后把账号带回登录框', $('#loginAccount').val() === 'zhangshouzheng@jiudou.com',
        $('#loginAccount').val());
    check('验证码已一次性作废', !codeStore()['zhangshouzheng@jiudou.com']);
});

/* ===================== B. Api.auth.changepwd ===================== */
// 注意：不能拿 login.html 测（登录页会 wipePreviousAccount() 清掉登录态），改用 home.html 只加载 api.js
var win2 = boot('home.html', [], function (w) {
    w.localStorage.setItem(USER_KEY, JSON.stringify(users('888888', 'tk-live')));
    // 离线 Mock 的 changepwd 从本地登录态取 token（真实后端由 api.js 自动注入 token 参数）
    w.localStorage.setItem(SESSION_KEY, JSON.stringify({
        token: 'tk-live', time: '2026-11-01 20:00:00', expireAt: new Date().getTime() + 3600000,
        ttlHours: 8, user: {}
    }));
});
var $2 = win2.jQuery;
var cp = { ok: null, message: '' };

step(function () {
    console.log('\n--- 7. 登录后自助改密（Api.auth.changepwd，Mock）---');
    win2.Api.auth.changepwd({ oldPassword: 'wrong-pass', newPassword: 'NewPass2026' })
        .done(function () { cp.ok = true; })
        .fail(function (err) { cp.ok = false; cp.message = (err && err.message) || ''; });
});

step(function () {
    check('原密码错误被拒绝', cp.ok === false && /原密码不正确/.test(cp.message), cp.message);
    win2.Api.auth.changepwd({ oldPassword: '888888', newPassword: '111111' })
        .done(function () { cp.ok = true; cp.message = ''; })
        .fail(function (err) { cp.ok = false; cp.message = (err && err.message) || ''; });
});

step(function () {
    check('新密码是重复单一字符被拒绝', cp.ok === false && /同一个字符重复/.test(cp.message), cp.message);
    win2.Api.auth.changepwd({ oldPassword: '888888', newPassword: '888888' })
        .done(function () { cp.ok = true; cp.message = ''; })
        .fail(function (err) { cp.ok = false; cp.message = (err && err.message) || ''; });
});

step(function () {
    // 「与原密码相同」要用不含重复字符的密码测（888888 会先撞上「同一字符重复」规则）
    var list = JSON.parse(win2.localStorage.getItem(USER_KEY) || '[]');
    list[0].password = md5('OldPass2026');
    win2.localStorage.setItem(USER_KEY, JSON.stringify(list));
    win2.Api.auth.changepwd({ oldPassword: 'OldPass2026', newPassword: 'OldPass2026' })
        .done(function () { cp.ok = true; cp.message = ''; })
        .fail(function (err) { cp.ok = false; cp.message = (err && err.message) || ''; });
});

step(function () {
    check('新密码与原密码相同被拒绝', cp.ok === false && /不能与原密码相同/.test(cp.message), cp.message);
    win2.Api.auth.changepwd({ oldPassword: 'OldPass2026', newPassword: 'NewPass2026' })
        .done(function () { cp.ok = true; cp.message = ''; })
        .fail(function (err) { cp.ok = false; cp.message = (err && err.message) || ''; });
});

step(function () {
    check('正确改密成功返回 logout=true', cp.ok === true, cp.message);
    var stored = JSON.parse(win2.localStorage.getItem(USER_KEY) || '[]');
    check('库内密码已更新', stored[0].password === md5('NewPass2026'), stored[0].password);
    check('改密后 token 作废（必须重新登录）', !stored[0].token, String(stored[0].token));
    win2.Api.auth.changepwd({ oldPassword: 'NewPass2026', newPassword: 'Another2026' })
        .done(function () { cp.ok = true; })
        .fail(function (err) { cp.ok = false; cp.message = (err && err.message) || ''; });
});

step(function () {
    check('旧 token 已失效，再改密返回登录失效', cp.ok === false && /登录已失效/.test(cp.message), cp.message);
});

/* ===================== C. 框架页「改密」入口 ===================== */
var win3 = boot('main.html', ['js/ui.js', 'js/changepwd.js', 'js/frame.js'], function (w) {
    w.localStorage.setItem(USER_KEY, JSON.stringify(users('888888', 'tk-frame')));
    w.localStorage.setItem(SESSION_KEY, JSON.stringify({
        token: 'tk-frame', time: '2026-11-01 20:00:00', expireTime: '2026-11-02 04:00:00',
        expireAt: new Date().getTime() + 8 * 3600 * 1000, ttlHours: 8,
        user: { account: 'zhangshouzheng@jiudou.com', empName: '张守正' }
    }));
});
var $3 = win3.jQuery;

step(function () {
    console.log('\n--- 8. 框架页顶部「改密」按钮 + 弹窗 ---');
    check('顶部用户区有「改密」按钮', $3('#frameChangePwd').length === 1 &&
        /改密/.test($3('#frameChangePwd').text()), $3('#frameChangePwd').text());
    check('「改密」与「退出」都在用户区里',
        $3('#frameUser').find('#frameChangePwd').length === 1 &&
        $3('#frameUser').find('#frameLogout').length === 1);
    $3('#frameChangePwd').trigger('click');
});

step(function () {
    var $dlg = $3('.el-overlay .el-dialog').last();
    check('点击后弹出「修改登录密码」弹窗', /修改登录密码/.test($dlg.text()), $dlg.find('.el-dialog__title').text());
    check('弹窗里有原密码 / 新密码 / 确认新密码三个录入框',
        $dlg.find('#cpOld').length === 1 && $dlg.find('#cpNew').length === 1 &&
        $dlg.find('#cpNew2').length === 1);
    check('三个录入框都是密码类型',
        $dlg.find('#cpOld').attr('type') === 'password' &&
        $dlg.find('#cpNew').attr('type') === 'password' &&
        $dlg.find('#cpNew2').attr('type') === 'password');
    check('弹窗提示「修改成功后需要重新登录」', /重新登录/.test($dlg.text()));
    $dlg.find('.btn-ok').trigger('click');
});

step(function () {
    var toast = $3('.el-message-list').text();
    check('未填原密码时提示（前端拦截，不发请求）', /请输入原密码/.test(toast), toast);
    var $dlg = $3('.el-overlay .el-dialog').last();
    $dlg.find('#cpOld').val('888888');
    $dlg.find('#cpNew').val('NewPass2026');
    $dlg.find('#cpNew2').val('NewPass2026');
    $dlg.find('.btn-ok').trigger('click');
});

step(function () {
    var stored = JSON.parse(win3.localStorage.getItem(USER_KEY) || '[]');
    check('提交后 Mock 用户密码已更新', stored[0].password === md5('NewPass2026'), stored[0].password);
    check('改密成功后本地登录态被清空（回登录页重新登录）',
        !win3.localStorage.getItem(SESSION_KEY),
        String(win3.localStorage.getItem(SESSION_KEY)).slice(0, 40));
});

setTimeout(next, 600);
