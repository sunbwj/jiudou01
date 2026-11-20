/* ==========================================================================
   sso-test.js —— 单点登录（SSO）与令牌有效期测试（jsdom，无需浏览器）
   --------------------------------------------------------------------------
   覆盖：
     1) 登录成功写入「8 小时有效期」（expireAt / expireTime / ttlHours）
     2) 登录页：已过期会话不再自动进系统；带 expired=1 时提示「登录已超时」
     3) api.js：有效 token 随每个请求携带（main 与 iframe 共享同一份登录态）
     4) api.js：本地已过期 → 不再发请求、清会话
     5) api.js：顶层 401 → 清会话（整页跳登录页）
     6) api.js：iframe 子页 401 → **不在子页跳转**，上报顶层（AppFrame.onAuthExpired / postMessage）
     7) frame.js：过期会话不放行；onAuthExpired 可被调用；message 通知后清会话
     8) 页面版本号与关键字一致性（防止旧脚本缓存）
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/sso-test.js
   ========================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var JSDOM = (function () {
    try { return require('jsdom').JSDOM; } catch (e) { return null; }
})();

var ROOT = path.resolve(__dirname, '..');
var SESSION_KEY = 'menu_admin_login_v1';
var TTL_MS = 8 * 3600 * 1000;          // 默认 8 小时
var BASE = 'http://127.0.0.1:8808/';
var pass = 0, fail = 0;

function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

var JQ = read('vendor/jquery-3.7.1.min.js');
var API = read('js/api.js');

/* ---------------- 工具 ---------------- */
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmt(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
/** 写入登录态；ttlMs 为负数表示「已经过期」 */
function setSession(win, opts) {
    opts = opts || {};
    var nowMs = new Date().getTime();
    var ttl = (opts.ttlMs === undefined) ? TTL_MS : opts.ttlMs;
    win.localStorage.setItem(SESSION_KEY, JSON.stringify({
        token: opts.token || 'tk-1111222233334444',
        time: fmt(nowMs),
        expireTime: fmt(nowMs + ttl),
        expireAt: nowMs + ttl,
        ttlHours: ttl / 3600000,
        user: { account: '13813970452', empName: '测试管理员', roleNames: '系统管理员' }
    }));
}
function sessionOf(win) {
    try {
        var raw = win.localStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}
/** 组装窗口：先写好登录态、装好 ajax 桩，再执行 api.js / 页面脚本 */
function boot(page, scripts, url, opts) {
    opts = opts || {};
    var dom = new JSDOM(read(page), { url: url, runScripts: 'outside-only', pretendToBeVisual: true });
    var win = dom.window;
    win.eval(JQ);
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    if (opts.withUi) { win.eval(read('js/ui.js')); }
    // 登录态要在页面脚本执行前就绪（login.js 一进来就会判断）
    try { win.localStorage.removeItem(SESSION_KEY); } catch (e) { }
    if (opts.session) { setSession(win, opts.session); }
    // 上一个账号留下的页面级状态（检索条件等），用于验证「进登录页就被清空」
    if (opts.sessionStorage) {
        for (var sk in opts.sessionStorage) {
            if (opts.sessionStorage.hasOwnProperty(sk)) { win.sessionStorage.setItem(sk, opts.sessionStorage[sk]); }
        }
    }
    stubAjax(win, opts.ajax);
    win.eval(API);
    var list = scripts || [];
    for (var i = 0; i < list.length; i++) { win.eval(read(list[i])); }
    return win;
}
/** 拦截 ajax：mock=true 时全部失败（api.js 回退本地模拟服务），否则交给 handler */
function stubAjax(win, handler) {
    win.jQuery.ajax = function (o) {
        var d = win.jQuery.Deferred();
        var url = String((o && o.url) || '');
        if (!handler) { d.reject({ status: 0, responseJSON: null }, 'error', 'error'); return d.promise(); }
        var res = handler(url, o);
        if (res === 'fail') { d.reject({ status: 0, responseJSON: null }, 'error', 'error'); return d.promise(); }
        d.resolve(res);
        return d.promise();
    };
}
/** 在 iframe 里装配一套独立的 api.js（其 window.top 指向父窗口，用于模拟「子页」） */
function bootFrameWin(parentWin, handler) {
    var frame = parentWin.document.createElement('iframe');
    parentWin.document.body.appendChild(frame);
    var fw = frame.contentWindow;
    fw.eval(JQ);
    stubAjax(fw, handler);
    fw.eval(API);
    return fw;
}
/** 计算运算表达式验证码的答案 */
function solve(expr) {
    var m = /^(\d+)\s+([+\-×])\s+(\d+)\s*=\s*\?$/.exec(String(expr || ''));
    if (!m) { return ''; }
    var a = parseInt(m[1], 10), op = m[2], b = parseInt(m[3], 10);
    return String(op === '+' ? (a + b) : (op === '-' ? (a - b) : (a * b)));
}

(async function main() {
    /* ================= 1. 登录成功：写入 8 小时有效期 ================= */
    console.log('\n--- 1. 登录成功写入令牌有效期（默认 8 小时） ---');
    var wLogin = boot('login.html', ['js/login.js'], BASE + 'login.html');
    await sleep(320);
    var $l = wLogin.jQuery;
    $l('#loginAccount').val('13800138001');
    $l('#loginPassword').val('888888');
    $l('#loginCaptcha').val(solve($l('#captchaExpr').text()));
    $l('#btnLogin').trigger('click');
    await sleep(420);

    var s1 = sessionOf(wLogin);
    var nowMs = new Date().getTime();
    check('登录成功写入 token', !!s1 && !!s1.token, s1 ? String(s1.token).slice(0, 8) : 'null');
    check('登录态写入 expireAt，且约为「当前时间 + 8 小时」',
        !!s1 && Math.abs(Number(s1.expireAt) - (nowMs + TTL_MS)) < 30000,
        s1 ? String(s1.expireAt) + ' vs ' + (nowMs + TTL_MS) : 'null');
    check('登录态写入 expireTime（YYYY-MM-DD HH:MM:SS）',
        !!s1 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(s1.expireTime || '')),
        s1 ? String(s1.expireTime) : 'null');
    check('登录态写入 ttlHours = 8', !!s1 && Number(s1.ttlHours) === 8,
        s1 ? String(s1.ttlHours) : 'null');
    check('登录态仍保留登录时间与用户信息（与旧格式兼容）',
        !!s1 && !!s1.time && !!s1.user && (s1.user.empName || s1.user.account));

    /* ================= 2. 登录页：过期会话 / 超时提示 ================= */
    console.log('\n--- 2. 登录页对过期会话的处理 ---');
    var wExpired = boot('login.html', ['js/login.js'], BASE + 'login.html', { session: { ttlMs: -60000 } });
    await sleep(320);
    check('已过期的登录态不会自动进系统（被清理，停在登录页）',
        sessionOf(wExpired) === null, JSON.stringify(sessionOf(wExpired)));
    check('登录页仍正常拉起验证码', /^\d+\s+[+\-×]\s+\d+\s*=\s*\?$/.test(
        String(wExpired.jQuery('#captchaExpr').text())), String(wExpired.jQuery('#captchaExpr').text()));

    var wExpiredTip = boot('login.html', ['js/login.js'],
        BASE + 'login.html?redirect=main.html&expired=1');
    await sleep(320);
    check('框架页因超时跳回登录页时（expired=1）提示「登录已超时」',
        /登录已超时/.test(String(wExpiredTip.jQuery('#loginError').text())),
        String(wExpiredTip.jQuery('#loginError').text()));
    check('超时提示里写明有效期 8 小时',
        /8\s*小时/.test(String(wExpiredTip.jQuery('#loginError').text())),
        String(wExpiredTip.jQuery('#loginError').text()));

    // 新版：地址栏不带任何参数，超时提示靠 sessionStorage 标记（跳转方写、登录页读一次即删）
    var wExpiredMark = boot('login.html', ['js/login.js'], BASE + 'login.html',
        { sessionStorage: { menu_admin_auth_expired: '1' } });
    await sleep(320);
    check('地址栏不带参数时，靠 sessionStorage 标记也能提示「登录已超时」',
        /登录已超时/.test(String(wExpiredMark.jQuery('#loginError').text())),
        String(wExpiredMark.jQuery('#loginError').text()));
    check('标记在进入登录页后被消费掉（不会残留到下一次正常打开登录页）',
        wExpiredMark.sessionStorage.getItem('menu_admin_auth_expired') === null,
        String(wExpiredMark.sessionStorage.getItem('menu_admin_auth_expired')));
    var wPlain = boot('login.html', ['js/login.js'], BASE + 'login.html');
    await sleep(320);
    check('正常打开登录页（无标记、无参数）不显示任何超时提示',
        String(wPlain.jQuery('#loginError').text()) === '',
        String(wPlain.jQuery('#loginError').text()));

    /* ================= 2b. 进入登录页：清空上一个账号的浏览器信息 ================= */
    console.log('\n--- 2b. 进入登录页即清空上一个账号的浏览器信息 ---');
    var wWipe = boot('login.html', ['js/login.js'],
        BASE + 'login.html?redirect=' + encodeURIComponent('main.html#mail.html'),
        {
            session: {},                       // 仍然是「有效」的登录态
            sessionStorage: {                  // 上一个账号的检索条件 / 停留页
                service_email_state: '{"keyword":"163"}',
                emp_list_state: '{"keyword":"张守正"}'
            }
        });
    await sleep(320);
    check('即使登录态仍然有效，进登录页也会被清空（不会带着旧会话进系统）',
        sessionOf(wWipe) === null, JSON.stringify(sessionOf(wWipe)));
    check('上一个账号的页面状态（sessionStorage）被整片清空',
        wWipe.sessionStorage.length === 0, String(wWipe.sessionStorage.length));
    check('登录页照常初始化（表单与验证码都在，说明没有被直接跳走）',
        wWipe.document.querySelector('#loginForm') !== null &&
        /^\d+\s+[+\-×]\s+\d+\s*=\s*\?$/.test(String(wWipe.jQuery('#captchaExpr').text())),
        String(wWipe.jQuery('#captchaExpr').text()));
    check('登录页源码里不再有「已有登录态就直接进系统」的分支',
        read('js/login.js').indexOf('sessionValid(session())') < 0 &&
        read('js/login.js').indexOf('wipePreviousAccount') > -1);
    check('回跳地址会丢掉上一个账号停留页面的 #hash',
        /split\('#'\)/.test(read('js/login.js')));

    var wHash = boot('main.html', ['js/api.js'], BASE + 'main.html#mail.html', { session: {} });
    await sleep(60);
    var hashUrl = String(wHash.AppAuth.loginUrl());
    check('跳登录页的地址不带 #hash（登录后一律回系统首页）',
        hashUrl.indexOf('#') < 0 && hashUrl.indexOf('%23') < 0, hashUrl);

    /* ================= 3. api.js：token 全局共享（随请求携带） ================= */
    console.log('\n--- 3. token 全局共享：每个请求都带上同一份 token ---');
    var seen = [];
    function okHandler(url, o) {
        if (url.indexOf('/health') > -1) { return { code: 0, data: { service: 'ok' } }; }
        var params = o && o.data;
        if (typeof params === 'string') {
            try { params = JSON.parse(params); } catch (e) { params = {}; }
        }
        params = params || {};
        seen.push({ url: url, token: String(params.token || '') });
        return { code: 0, data: { list: [], total: 0 } };
    }
    var wShare = boot('home.html', ['js/api.js'], BASE + 'home.html', { session: {}, ajax: okHandler });
    await sleep(50);
    check('真实后端通道（未回退 Mock）', wShare.Api.config.useMock === false);
    wShare.Api.menu.page({ pageNum: 1, pageSize: 10 });
    wShare.Api.emp.page({ pageNum: 1, pageSize: 10 });
    await sleep(30);
    var listCalls = seen.filter(function (x) { return x.url.indexOf('/menu/list') > -1 || x.url.indexOf('/emp/list') > -1; });
    check('框架页与功能页的请求都自动带上登录 token',
        listCalls.length >= 2 && listCalls.every(function (x) { return x.token === 'tk-1111222233334444'; }),
        JSON.stringify(listCalls));

    /* ================= 4. api.js：本地过期 → 不发请求 + 清会话 ================= */
    console.log('\n--- 4. 本地已过期：不再发请求，登录态被清理 ---');
    var bizCalls = 0;
    var wLoc = boot('menu.html', ['js/api.js'], BASE + 'menu.html', {
        session: { ttlMs: -1000 }, ajax: function (url) {
            if (url.indexOf('/health') > -1) { return { code: 0, data: { service: 'ok' } }; }
            bizCalls++;
            return { code: 0, data: { list: [], total: 0 } };
        }
    });
    await sleep(50);
    var locResult = null;
    wLoc.Api.menu.page({ pageNum: 1, pageSize: 10 }).fail(function (e) { locResult = e; });
    await sleep(50);
    check('本地已过期时不再发出业务请求（避免带着废 token 打后端）', bizCalls === 0, 'bizCalls=' + bizCalls);
    check('本地已过期时登录态被清理', sessionOf(wLoc) === null, JSON.stringify(sessionOf(wLoc)));
    check('AppAuth 暴露会话状态（session 为空 / logged() = false）',
        wLoc.AppAuth.session() === null && wLoc.AppAuth.logged() === false);
    check('AppAuth.remain() 为 0（无有效剩余时间）', wLoc.AppAuth.remain() === 0,
        String(wLoc.AppAuth.remain()));

    /* ================= 5. 顶层 401 → 清会话，准备整页跳转 ================= */
    console.log('\n--- 5. 顶层（main.html）收到 401：清会话并准备整页跳登录页 ---');
    var wTop = boot('main.html', ['js/api.js'], BASE + 'main.html', {
        session: {}, ajax: function (url) {
            if (url.indexOf('/health') > -1) { return { code: 0, data: { service: 'ok' } }; }
            return { code: 401, message: '登录已超时（有效期 8 小时），请重新登录' };
        }
    });
    await sleep(50);
    var topErr = null;
    var topCalled = false;
    wTop.Api.menu.page({ pageNum: 1 }).fail(function (e) { topCalled = true; topErr = e; });
    await sleep(30);
    check('顶层收到 401 时业务回调仍能拿到 401（供页面自行提示）',
        topCalled && topErr && topErr.code === 401, topErr ? String(topErr.code) : 'no-error');
    check('顶层收到 401 后清除本地登录态', sessionOf(wTop) === null, JSON.stringify(sessionOf(wTop)));
    check('跳转地址就是 login.html（不带任何查询参数）',
        String(wTop.AppAuth.loginUrl()) === 'login.html',
        String(wTop.AppAuth.loginUrl()));
    check('「超时」提示改由 sessionStorage 标记传递（menu_admin_auth_expired = 1）',
        String(wTop.sessionStorage.getItem('menu_admin_auth_expired')) === '1',
        String(wTop.sessionStorage.getItem('menu_admin_auth_expired')));
    check('顶层页面判定为「不在 iframe 中」（inFrame = false）', wTop.AppAuth.inFrame() === false);

    /* ================= 6. iframe 子页 401 → 只上报，不在子页跳转 ================= */
    console.log('\n--- 6. iframe 子页 401：子页不跳转，上报顶层框架页 ---');
    var wParent = boot('main.html', [], BASE + 'main.html', { session: {} });
    await sleep(30);
    var reported = [];
    wParent.AppFrame = {                    // 模拟框架页已暴露处理函数
        onAuthExpired: function (reason) { reported.push(String(reason || '')); }
    };
    var wChild = bootFrameWin(wParent, function (url) {
        if (url.indexOf('/health') > -1) { return { code: 0, data: { service: 'ok' } }; }
        return { code: 401, message: '登录已超时（有效期 8 小时），请重新登录' };
    });
    check('子页能识别自己处于 iframe 中（inFrame = true）', wChild.AppAuth.inFrame() === true);
    var childHrefBefore = String(wChild.location.href);
    var childFailed = null;
    wChild.Api.menu.page({ pageNum: 1 }).fail(function (e) { childFailed = e; });
    await sleep(60);
    check('子页请求返回 401（业务回调拿到 401）', childFailed && childFailed.code === 401,
        childFailed ? String(childFailed.code) : 'no-error');
    check('子页把「登录失效」上报给顶层（AppFrame.onAuthExpired 被调用一次）',
        reported.length === 1, JSON.stringify(reported));
    check('子页自身地址没有变化（iframe 里不会出现登录页）',
        String(wChild.location.href) === childHrefBefore,
        childHrefBefore + ' → ' + String(wChild.location.href));
    check('子页上报后共享登录态被清理（父页读到的是同一份 localStorage）',
        sessionOf(wParent) === null, JSON.stringify(sessionOf(wParent)));

    // 退一步：顶层没暴露 AppFrame（旧版 / 跨域）时改为 postMessage
    var wParent2 = boot('main.html', [], BASE + 'main.html', { session: {} });
    await sleep(30);
    var messages = [];
    wParent2.addEventListener('message', function (e) {
        if (e && e.data && e.data.type) { messages.push(e.data); }
    });
    var wChild2 = bootFrameWin(wParent2, function (url) {
        if (url.indexOf('/health') > -1) { return { code: 0, data: { service: 'ok' } }; }
        return { code: 401, message: '登录已失效，请重新登录' };
    });
    check('未暴露 AppFrame 时子页仍识别为 iframe', wChild2.AppAuth.inFrame() === true);
    wChild2.Api.menu.page({ pageNum: 1 });
    await sleep(120);
    check('子页通过 postMessage 上报 app:auth-expired',
        messages.length >= 1 && messages[0].type === 'app:auth-expired',
        JSON.stringify(messages));

    /* ================= 7. frame.js：唯一跳转执行者 ================= */
    console.log('\n--- 7. 框架页（main.html）统一处理登录失效 ---');
    var wFrameExpired = boot('main.html', ['js/api.js', 'js/frame.js'], BASE + 'main.html',
        { withUi: true, session: { ttlMs: -60000 }, ajax: okHandler });
    await sleep(200);
    check('过期会话进入 main.html 时被拦下（清掉登录态）', sessionOf(wFrameExpired) === null,
        JSON.stringify(sessionOf(wFrameExpired)));
    check('被拦下时不初始化任何 Tab（AppFrame.count() = 0）',
        wFrameExpired.AppFrame.count() === 0, String(wFrameExpired.AppFrame.count()));

    var wFrame = boot('main.html', ['js/api.js', 'js/frame.js'], BASE + 'main.html',
        { withUi: true, session: {}, ajax: okHandler });
    await sleep(200);
    check('有效会话正常进入框架页（首页 Tab 已打开）', wFrame.AppFrame.count() >= 1,
        String(wFrame.AppFrame.count()));
    check('框架页暴露 onAuthExpired（供子页 401 汇聚）',
        typeof wFrame.AppFrame.onAuthExpired === 'function');
    check('框架页暴露会话有效性判断（sessionValid = true）', wFrame.AppFrame.sessionValid() === true);
    check('框架页可读取令牌剩余有效期（≈ 8 小时）',
        Math.abs(wFrame.AppFrame.sessionRemain() - TTL_MS) < 60000,
        String(wFrame.AppFrame.sessionRemain()));

    wFrame.postMessage({ type: 'app:auth-expired', reason: 'expired' }, '*');
    await sleep(80);
    check('收到子页 postMessage 后清会话并跳登录页（跳转前的清理由框架页完成）',
        sessionOf(wFrame) === null, JSON.stringify(sessionOf(wFrame)));

    var wFrame2 = boot('main.html', ['js/api.js', 'js/frame.js'], BASE + 'main.html',
        { withUi: true, session: {}, ajax: okHandler });
    await sleep(200);
    wFrame2.AppFrame.onAuthExpired('expired');
    await sleep(30);
    check('直接调用 AppFrame.onAuthExpired 同样清会话（api.js 与 frame.js 两条路径一致）',
        sessionOf(wFrame2) === null, JSON.stringify(sessionOf(wFrame2)));

    /* ================= 8. 一致性检查（防旧缓存 / 防回退） ================= */
    console.log('\n--- 8. 代码一致性 ---');
    var apiSrc = read('js/api.js');
    var frameSrc = read('js/frame.js');
    check('api.js 不再让子页自己 replace 到 login.html（改为上报顶层）',
        apiSrc.indexOf('notifyTopAuthExpired') > -1 && apiSrc.indexOf('app:auth-expired') > -1);
    check('api.js 暴露统一会话中心 window.AppAuth', apiSrc.indexOf('window.AppAuth = {') > -1);
    check('frame.js 监听子页上报（message: app:auth-expired）',
        frameSrc.indexOf("d.type !== 'app:auth-expired'") > -1);
    check('frame.js 有令牌到期定时体检（watchSession）', frameSrc.indexOf('watchSession') > -1);
    check('frame.js 退出登录与超时都走同一个 gotoLogin（整页跳转）',
        (frameSrc.match(/gotoLogin\(/g) || []).length >= 3);
    check('frame.js 跳登录页的地址不带任何查询参数（无 login.html? 字面量）',
        frameSrc.indexOf('login.html?') < 0, frameSrc.split('\n').filter(function (l) {
            return l.indexOf('login.html?') > -1;
        }).join(' | '));
    check('api.js 跳登录页的地址不带任何查询参数（loginUrl() 直接返回 LOGIN_PAGE）',
        apiSrc.indexOf('login.html?') < 0 && /function loginUrl\(\)\s*\{\s*return LOGIN_PAGE;\s*\}/.test(apiSrc));
    check('「超时」提示通过 sessionStorage 标记传递（两端同名 key）',
        frameSrc.indexOf("'menu_admin_auth_expired'") > -1 &&
        apiSrc.indexOf("'menu_admin_auth_expired'") > -1 &&
        read('js/login.js').indexOf("'menu_admin_auth_expired'") > -1);
    // 两种写法都认：老版直接读环境变量，新版走 _float（支持 conf/settings.json 覆盖）
    check('后端默认令牌有效期 8 小时（config.TOKEN_TTL_HOURS）',
        /TOKEN_TTL_HOURS = (?:float\(os\.getenv\('TOKEN_TTL_HOURS', '8'\)\)|_float\('TOKEN_TTL_HOURS', '8'\))/.test(read('server/config.py')));
    check('useinfo 表结构含 tokenExpireTime 字段',
        read('db/useinfo.sql').indexOf('tokenExpireTime') > -1);

    var htmls = ['main.html', 'home.html', 'login.html', 'menu.html', 'emp.html', 'user.html',
        'role.html', 'role-power.html', 'org.html', 'page-op-btn.html',
        'dbinfo.html', 'report-designer.html', 'report-center.html',
        'project.html', 'project-form.html', 'project-file.html',
        'sysdict.html', 'sysdict-item.html', 'syspara.html'];
    var staleApi = htmls.filter(function (p) { return read(p).indexOf('js/api.js?v=20261118e') < 0; });
    check('各页面统一引用新版 api.js（v=20261118e）', staleApi.length === 0, staleApi.join(','));
    var allHtml = fs.readdirSync(ROOT).filter(function (f) { return /\.html$/i.test(f); });
    var staleAll = allHtml.filter(function (p) {
        var src = read(p);
        return src.indexOf('js/api.js?v=20261118e') < 0 ||
               src.indexOf('css/app.css?v=20261110f') < 0;
    });
    check('全站 ' + allHtml.length + ' 个页面统一 api.js?v=20261118e / app.css?v=20261110f',
        staleAll.length === 0, staleAll.join(','));
    check('main.html 引用新版 frame.js（v=20261112b）',
        read('main.html').indexOf('js/frame.js?v=20261112b') > -1);
    check('login.html 引用新版 login.js（v=20261112c）',
        read('login.html').indexOf('js/login.js?v=20261112c') > -1);

    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
})();
