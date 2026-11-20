/* ==========================================================================
   sso-e2e.js —— 单点登录端到端验证（真实浏览器：本机 Edge + puppeteer-core）
   --------------------------------------------------------------------------
   验证目标（这些只能靠真实浏览器确认）：
     1) 登录后 token 写进 localStorage，main.html 与 iframe 子页读到的是同一份（全局共享）；
     2) **iframe 子页里 token 失效 → 整个 main.html 跳到 login.html**（不是 iframe 里跳）；
     3) 顶层地址最终是**不带任何参数的** login.html，登录页提示「登录已超时」（标记走 sessionStorage）；
     4) 本地令牌到期（expireAt 已过）→ 直接进不去 main.html，回登录页。
   前置：后端 8808 已启动（python server/app.py），数据库可写。
   运行：NODE_PATH=<node_modules> node tools/sso-e2e.js [账号] [密码]
   ========================================================================== */
'use strict';
var puppeteer = require('puppeteer-core');

var EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
var BASE = 'http://127.0.0.1:8808';
var KEY = 'menu_admin_login_v1';
// 账号可用命令行指定；不指定时按候选列表依次试（管理员可能已自助改过密码，默认账号不一定还能用 888888）
var ACCOUNTS = process.argv[2] ? [process.argv[2]] : ['13813970452', '15724887807', '18303731192', '17355437177'];
var PASSWORD = process.argv[3] || '888888';
var WORK_ACCOUNT = '';

var pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function skip(name, why) {
    console.log('  [SKIP] ' + name + (why ? '  → ' + why : ''));
}
var IS_ADMIN = false;


/** 依次试候选账号（都用初始密码），返回第一个能登录成功的账号名 */
async function resolveAccount(pg) {
    await pg.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    for (var i = 0; i < ACCOUNTS.length; i++) {
        var ok = await pg.evaluate(async function (account, password) {
            function solve(q) {
                var m = /^(\d+)\s*([+\-×])\s*(\d+)\s*=\s*\?$/.exec(String(q || ''));
                if (!m) { return ''; }
                var a = parseInt(m[1], 10), op = m[2], b = parseInt(m[3], 10);
                return String(op === '+' ? a + b : (op === '-' ? a - b : a * b));
            }
            var cap = await (await fetch('/api/auth/captcha')).json();
            var res = await (await fetch('/api/auth/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account: account, password: password,
                    captchaId: (cap.data || {}).captchaId, captchaCode: solve((cap.data || {}).question)
                })
            })).json();
            return !!(res.code === 0 && res.data && res.data.token);
        }, ACCOUNTS[i], PASSWORD);
        if (ok) {
            var info = await pg.evaluate(async function (account, password) {
                function solve(q) {
                    var m = /^(\d+)\s*([+\-×])\s*(\d+)\s*=\s*\?$/.exec(String(q || ''));
                    if (!m) { return ''; }
                    var a = parseInt(m[1], 10), op = m[2], b = parseInt(m[3], 10);
                    return String(op === '+' ? a + b : (op === '-' ? a - b : a * b));
                }
                var cap = await (await fetch('/api/auth/captcha')).json();
                var res = await (await fetch('/api/auth/login', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        account: account, password: password,
                        captchaId: (cap.data || {}).captchaId, captchaCode: solve((cap.data || {}).question)
                    })
                })).json();
                var d = res.data || {};
                return { token: d.token || '', roles: String((d.user || {}).roleNames || '') };
            }, ACCOUNTS[i], PASSWORD);
            IS_ADMIN = /系统管理员/.test(info.roles);
            console.log('    （登录账号：' + ACCOUNTS[i] + '，' + (IS_ADMIN ? '系统管理员' : info.roles || '无角色') + '）');
            return ACCOUNTS[i];
        }
    }
    return ACCOUNTS[0];
}


(async function main() {
    var browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900']
    });
    var page = await browser.newPage();
    page.on('pageerror', function (e) { console.log('    [pageerror] ' + e.message); });

    /* ---------- 0. 用接口登录拿真实 token ---------- */
    console.log('\n--- 0. 登录拿 token（真实接口 + 运算验证码） ---');
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    WORK_ACCOUNT = await resolveAccount(page);

    /* ---------- 0.1 忘记密码入口（登录按钮下方 + 弹窗几何） ---------- */
    var forgot = await page.evaluate(function () {
        var btn = document.getElementById('btnForgot');
        var login = document.getElementById('btnLogin');
        var mask = document.getElementById('forgotMask');
        var rb = btn ? btn.getBoundingClientRect() : null;
        var rl = login ? login.getBoundingClientRect() : null;
        return {
            hasBtn: !!btn,
            text: btn ? btn.innerText.replace(/\s+/g, '') : '',
            below: !!(rb && rl && rb.top >= rl.bottom - 1),
            visible: !!(rb && rb.width > 40 && rb.height > 10),
            hiddenFirst: mask ? (mask.hasAttribute('hidden') &&
                getComputedStyle(mask).display === 'none') : false
        };
    });
    check('登录页登录按钮下方有「忘记密码」按钮',
        forgot.hasBtn && /忘记密码/.test(forgot.text) && forgot.below && forgot.visible,
        JSON.stringify(forgot));
    check('忘记密码弹窗默认不显示', forgot.hiddenFirst === true, String(forgot.hiddenFirst));

    await page.click('#btnForgot');
    await sleep(320);
    var forgotModal = await page.evaluate(function () {
        var m = document.getElementById('forgotModal');
        if (!m) { return null; }
        var r = m.getBoundingClientRect();
        return {
            show: getComputedStyle(document.getElementById('forgotMask')).display !== 'none',
            w: Math.round(r.width), h: Math.round(r.height),
            inView: r.top >= 0 && r.bottom <= window.innerHeight + 1,
            fields: ['forgotEmail', 'forgotCode', 'forgotPwd', 'forgotPwd2'].every(function (id) {
                return !!document.getElementById(id);
            }),
            hasSend: !!document.getElementById('btnSendCode'),
            title: (document.getElementById('forgotTitle') || {}).innerText || ''
        };
    });
    check('点「忘记密码」弹出找回密码弹窗（邮箱 / 验证码 / 新密码字段齐全）',
        !!forgotModal && forgotModal.show && forgotModal.fields && forgotModal.hasSend &&
        /找回密码/.test(forgotModal.title), JSON.stringify(forgotModal));
    check('弹窗完整落在视口内（宽度 ≤ 460，不需要滚动）',
        !!forgotModal && forgotModal.w <= 460 && forgotModal.inView,
        forgotModal ? (forgotModal.w + '×' + forgotModal.h) : 'null');
    await page.click('#forgotClose');
    await sleep(260);
    var forgotClosed = await page.evaluate(function () {
        var mask = document.getElementById('forgotMask');
        return mask ? getComputedStyle(mask).display === 'none' : false;
    });
    check('关闭弹窗后回到登录表单', forgotClosed === true);

    var loginRes = await page.evaluate(async function (account, password) {
        function solve(q) {
            var m = /^(\d+)\s*([+\-×])\s*(\d+)\s*=\s*\?$/.exec(String(q || ''));
            if (!m) { return ''; }
            var a = parseInt(m[1], 10), op = m[2], b = parseInt(m[3], 10);
            return String(op === '+' ? a + b : (op === '-' ? a - b : a * b));
        }
        var cap = await (await fetch('/api/auth/captcha')).json();
        var body = {
            account: account, password: password,
            captchaId: (cap.data || {}).captchaId, captchaCode: solve((cap.data || {}).question)
        };
        var res = await fetch('/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        return await res.json();
    }, WORK_ACCOUNT, PASSWORD);
    var token = (loginRes.data || {}).token || '';
    check('登录成功拿到 token（32 位）', /^[0-9a-f]{32}$/.test(token),
        String(loginRes.message || '') + ' / ' + token.slice(0, 8));
    if (!token) { await browser.close(); return finish(); }
    check('登录返回 8 小时有效期（expireIn = 28800）',
        Number((loginRes.data || {}).expireIn) === 28800, String((loginRes.data || {}).expireIn));

    /** 写入登录态（与 js/login.js 完全一致的字段）；tk 缺省用首发 token */
    async function saveSession(ttlMs, tk) {
        await page.evaluate(function (key, token, ttlMs) {
            var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
            var fmt = function (ms) {
                var d = new Date(ms);
                return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
                    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
            };
            var nowMs = new Date().getTime();
            localStorage.setItem(key, JSON.stringify({
                token: token, time: fmt(nowMs), expireTime: fmt(nowMs + ttlMs),
                expireAt: nowMs + ttlMs, ttlHours: ttlMs / 3600000,
                user: { account: 'e2e', empName: '端到端测试' }
            }));
        }, KEY, tk || token, ttlMs);
    }

    /* ---------- 1. 进入框架页：token 全局共享 ---------- */
    console.log('\n--- 1. 进入 main.html：token 与 iframe 子页共享 ---');
    await saveSession(8 * 3600 * 1000);
    await page.goto(BASE + '/main.html', { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    var url1 = page.url();
    check('有效令牌可以进入 main.html（未被踢回登录页）', /main\.html/.test(url1), url1);
    check('框架页渲染出左侧菜单与 Tab', (await page.$('#frameTabs')) !== null &&
        (await page.$('#frameMenu')) !== null);

    // 左侧导航默认展开规则：只有最上面那个菜单组展开，其它菜单组收缩（里面的菜单项不可见）
    var navOpen = await page.evaluate(function () {
        var tops = [].slice.call(document.querySelectorAll('#frameMenu > .frame-side__group'));
        function itemVisible(g) {
            var item = g.querySelector('.frame-side__sub .frame-side__item[data-url]');
            if (!item) { return null; }
            var r = item.getBoundingClientRect();
            return !!(item.offsetParent && r.height > 0);
        }
        return {
            total: tops.length,
            titles: tops.map(function (g) {
                var t = g.querySelector('.frame-side__group-title .txt');
                return t ? (t.innerText || '').replace(/\s+/g, '') : '';
            }),
            firstOpen: tops.length ? tops[0].classList.contains('is-open') : false,
            othersOpen: tops.slice(1).filter(function (g) { return g.classList.contains('is-open'); }).length,
            firstItemVisible: tops.length ? itemVisible(tops[0]) : null,
            othersItemVisible: tops.slice(1).map(itemVisible)
        };
    });
    if (navOpen.total >= 2) {
        check('左侧菜单组默认只有最上面那个展开（其它全部收缩）',
            navOpen.firstOpen === true && navOpen.othersOpen === 0,
            navOpen.titles.join(',') + ' / othersOpen=' + navOpen.othersOpen);
    } else {
        skip('左侧菜单组默认只有最上面那个展开（其它全部收缩）',
            '当前账号只有 ' + navOpen.total + ' 个菜单组（非系统管理员），无从比较');
    }
    if (navOpen.total >= 2) {
        check('最上面菜单组里的菜单项可见，其它菜单组的菜单项被收起隐藏',
            navOpen.firstItemVisible === true &&
            navOpen.othersItemVisible.every(function (v) { return v !== true; }),
            'first=' + navOpen.firstItemVisible + ' / others=' + JSON.stringify(navOpen.othersItemVisible));
    } else {
        skip('最上面菜单组里的菜单项可见，其它菜单组的菜单项被收起隐藏', '同上');
    }

    /* ---------- 1.1 顶部「改密」入口与弹窗 ---------- */
    var pwdBtn = await page.evaluate(function () {
        var b = document.getElementById('frameChangePwd');
        if (!b) { return null; }
        var r = b.getBoundingClientRect();
        b.click();
        return { text: b.innerText.replace(/\s+/g, ''), w: Math.round(r.width), h: Math.round(r.height) };
    });
    await sleep(420);
    var pwdDlg = await page.evaluate(function () {
        var list = document.querySelectorAll('.el-overlay .el-dialog');
        var last = list[list.length - 1];
        if (!last) { return null; }
        return {
            title: (last.querySelector('.el-dialog__title') || {}).innerText || '',
            fields: ['cpOld', 'cpNew', 'cpNew2'].every(function (id) { return !!last.querySelector('#' + id); }),
            type: (last.querySelector('#cpOld') || {}).type || ''
        };
    });
    check('框架页顶部有「改密」按钮',
        !!pwdBtn && /改密/.test(pwdBtn.text) && pwdBtn.w > 30, JSON.stringify(pwdBtn));
    check('点「改密」弹出「修改登录密码」弹窗（原密码 / 新密码 / 确认，密码不外显）',
        !!pwdDlg && /修改登录密码/.test(pwdDlg.title) && pwdDlg.fields && pwdDlg.type === 'password',
        JSON.stringify(pwdDlg));
    await page.evaluate(function () {
        var list = document.querySelectorAll('.el-overlay .el-dialog');
        var last = list[list.length - 1];
        var cancel = last ? last.querySelector('.btn-cancel') : null;
        if (cancel) { cancel.click(); }
    });
    await sleep(320);

    var childFrame = null;
    for (var i = 0; i < 30 && !childFrame; i++) {
        childFrame = page.frames().filter(function (f) {
            return /home\.html/.test(f.url());
        })[0] || null;
        if (!childFrame) { await sleep(200); }
    }
    check('系统首页以 iframe 方式加载（子页）', !!childFrame, childFrame ? childFrame.url() : 'none');

    if (childFrame) {
        var childToken = await childFrame.evaluate(function (key) {
            try {
                var s = JSON.parse(localStorage.getItem(key) || 'null');
                return s ? s.token : '';
            } catch (e) { return ''; }
        }, KEY);
        check('子页读到的 token 与顶层完全一致（SSO 全局共享）', childToken === token,
            childToken.slice(0, 8) + ' vs ' + token.slice(0, 8));

        var childApiOk = await childFrame.evaluate(async function () {
            try {
                var data = await new Promise(function (resolve, reject) {
                    window.Api.nav.get(window.AppAuth.token()).done(resolve).fail(reject);
                });
                return !!(data && data.groups);
            } catch (e) { return false; }
        });
        check('子页用共享 token 调用接口成功（导航数据正常返回）', childApiOk === true);
    }

    /* ---------- 2. 令牌在服务端失效 → 子页 401 → 整个 main.html 跳登录页 ---------- */
    console.log('\n--- 2. 子页 token 失效：整个 main.html 跳 login.html ---');
    // 让服务端令牌失效（等价于「8 小时到期」或「被新登录顶替」）
    var logoutRes = await page.evaluate(async function (token) {
        var res = await fetch('/api/auth/logout', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token })
        });
        return await res.json();
    }, token);
    check('服务端令牌已作废（logout 成功）', (logoutRes || {}).code === 0, JSON.stringify(logoutRes));
    check('本地登录态仍在（模拟「前端还留着旧 token」）',
        (await page.evaluate(function (key) { return !!localStorage.getItem(key); }, KEY)) === true);

    var hrefBefore = page.url();
    var childStillThere = page.frames().filter(function (f) { return /home\.html/.test(f.url()); })[0];
    check('触发前子页仍在 iframe 中（尚未跳转）', !!childStillThere);

    // 在**子页**里发一个业务请求：应 401 → 上报顶层 → 顶层整页跳转
    var childCall = await (childStillThere || page).evaluate(async function () {
        return await new Promise(function (resolve) {
            window.Api.menu.page({ pageNum: 1, pageSize: 10 })
                .done(function () { resolve('ok'); })
                .fail(function (e) { resolve('fail:' + (e && e.code)); });
        });
    });
    check('子页业务请求返回 401（登录已失效）', String(childCall).indexOf('401') > -1, String(childCall));

    var jumped = false;
    for (var j = 0; j < 40; j++) {
        if (/login\.html/.test(page.url())) { jumped = true; break; }
        await sleep(200);
    }
    check('整个 main.html 已跳转到登录页（顶层地址变化）', jumped, hrefBefore + ' → ' + page.url());
    check('跳转后地址栏是干净的 login.html（不带 ? 与任何参数）',
        /\/login\.html$/.test(page.url()) && page.url().indexOf('?') < 0, page.url());
    check('顶层文档已经是登录页（框架页 DOM 已被替换）',
        (await page.$('#loginAccount')) !== null && (await page.$('#frameTabs')) === null);
    var tipText = await page.evaluate(function () {
        var el = document.getElementById('loginError');
        return el ? el.textContent : '';
    });
    check('登录页提示「登录已超时（有效期 8 小时）」', /登录已超时/.test(tipText) && /8/.test(tipText), tipText);
    check('登录态已被清理（不会在登录页与 main.html 之间来回跳）',
        (await page.evaluate(function (key) { return localStorage.getItem(key); }, KEY)) === null);

    /* ---------- 3. 本地令牌到期：直接进不去 ---------- */
    console.log('\n--- 3. 本地令牌到期（expireAt 已过）：进不去框架页 ---');
    var token2 = await page.evaluate(async function (account, password) {
        function solve(q) {
            var m = /^(\d+)\s*([+\-×])\s*(\d+)\s*=\s*\?$/.exec(String(q || ''));
            if (!m) { return ''; }
            var a = parseInt(m[1], 10), op = m[2], b = parseInt(m[3], 10);
            return String(op === '+' ? a + b : (op === '-' ? a - b : a * b));
        }
        var cap = await (await fetch('/api/auth/captcha')).json();
        var res = await fetch('/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                account: account, password: password,
                captchaId: (cap.data || {}).captchaId, captchaCode: solve((cap.data || {}).question)
            })
        });
        var j = await res.json();
        return (j.data || {}).token || '';
    }, WORK_ACCOUNT, PASSWORD);
    check('第二次登录拿到新 token', /^[0-9a-f]{32}$/.test(token2), token2.slice(0, 8));

    if (token2) {
        await saveSession(-60000, token2);        // 到期时间设在 1 分钟前
        await page.goto(BASE + '/main.html', { waitUntil: 'domcontentloaded' });
        await sleep(1200);
        check('本地判定已过期 → 直接回登录页（整页，不加载框架）',
            /login\.html/.test(page.url()) && (await page.$('#frameTabs')) === null, page.url());
        check('过期的登录态被清除',
            (await page.evaluate(function (key) { return localStorage.getItem(key); }, KEY)) === null);
    }

    /* ---------- 4. 重新登录可以正常进入（令牌可复用流程） ---------- */
    console.log('\n--- 4. 超时后重新登录，仍可正常进入 ---');
    if (token2) {
        await saveSession(8 * 3600 * 1000, token2);
        await page.goto(BASE + '/main.html', { waitUntil: 'domcontentloaded' });
        await sleep(2000);
        var path4 = await page.evaluate(function () { return String(location.pathname); });
        var okPath4 = /\/main\.html$/.test(path4);
        check('重新登录后恢复正常使用', okPath4 && (await page.$('#frameTabs')) !== null, path4);
        if (!okPath4) {
            var meProbe = await page.evaluate(async function (t) {
                var res = await fetch('/api/auth/me?token=' + t);
                return await res.json();
            }, token2);
            console.log('    [诊断] token2=' + token2.slice(0, 8) + ' me=' + JSON.stringify(meProbe).slice(0, 160));
        }
    }

    /* ---------- 5. 进入登录页：清空上一个账号的痕迹，登录后回首页 ---------- */
    console.log('\n--- 5. 进入登录页清空上一个账号的痕迹 ---');
    if (token2) {
        // 先在系统里制造「上一个账号的痕迹」：留着有效登录态、写点页面状态、并停在邮箱助手
        await saveSession(8 * 3600 * 1000, token2);
        await page.goto(BASE + '/main.html#mail.html', { waitUntil: 'domcontentloaded' });
        await sleep(2000);
        await page.evaluate(function () {
            sessionStorage.setItem('service_email_state', '{"keyword":"163"}');
            sessionStorage.setItem('emp_list_state', '{"keyword":"张"}');
        });
        var before = await page.evaluate(function (key) {
            return {
                session: !!localStorage.getItem(key),
                ss: sessionStorage.length,
                hash: location.hash
            };
        }, KEY);
        check('（前置）系统里确实还留着上一个账号的登录态与页面状态',
            before.session === true && before.ss >= 2 && before.hash === '#mail.html', JSON.stringify(before));

        // 访问登录页（回跳参数里还带着上一个账号停留的 hash）
        await page.goto(BASE + '/login.html?redirect=' + encodeURIComponent('main.html#mail.html'),
            { waitUntil: 'domcontentloaded' });
        await sleep(1200);
        var wiped = await page.evaluate(function (key) {
            return {
                path: location.pathname,
                session: localStorage.getItem(key),
                ss: sessionStorage.length,
                hasForm: !!document.querySelector('#loginForm'),
                captcha: ((document.querySelector('#captchaExpr') || {}).textContent || '').trim()
            };
        }, KEY);
        check('进入登录页后停在登录页（没有被旧会话直接带进系统）',
            /login\.html$/.test(wiped.path) && wiped.hasForm === true, wiped.path);
        check('上一个账号的登录态已被清空', wiped.session === null, String(wiped.session).slice(0, 40));
        check('上一个账号的页面状态（sessionStorage）已被清空', wiped.ss === 0, String(wiped.ss));
        check('登录页照常拉起验证码', /\d\s*[+\-×]\s*\d/.test(wiped.captcha), wiped.captcha);

        // 真实走一遍登录：应落到 main.html 且 hash 为空、默认停在系统首页
        await page.evaluate(function (account, password) {
            function solve(q) {
                var m = /^(\d+)\s*([+\-×])\s*(\d+)\s*=\s*\?$/.exec(String(q || ''));
                if (!m) { return ''; }
                var a = parseInt(m[1], 10), op = m[2], b = parseInt(m[3], 10);
                return String(op === '+' ? a + b : (op === '-' ? a - b : a * b));
            }
            var $ = window.jQuery;
            $('#loginAccount').val(account);
            $('#loginPassword').val(password);
            $('#loginCaptcha').val(solve($('#captchaExpr').text()));
            $('#btnLogin').trigger('click');
        }, WORK_ACCOUNT, PASSWORD);
        await sleep(3200);
        var landed = await page.evaluate(function (key) {
            var act = document.querySelector('#frameTabs .frame-tab.is-active');
            return {
                path: location.pathname,
                hash: location.hash,
                session: !!localStorage.getItem(key),
                activeTab: act ? (act.innerText || '').replace(/\s+/g, ' ').trim() : '',
                tabs: document.querySelectorAll('#frameTabs .frame-tab').length
            };
        }, KEY);
        check('登录成功后进入 main.html', /\/main\.html$/.test(landed.path), landed.path);
        check('地址栏 hash 为空（没有落进上一个账号的操作页）', landed.hash === '', landed.hash);
        check('默认停在「系统首页」Tab', /系统首页/.test(landed.activeTab) && landed.tabs >= 1,
            landed.activeTab + ' / tabs=' + landed.tabs);
        check('登录后重新写入了本账号的登录态', landed.session === true);
    }

    await browser.close();
    finish();
})().catch(function (e) {
    console.log('\n[E2E 异常] ' + (e && e.message));
    console.log(e && e.stack);
    process.exit(1);
});

function finish() {
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}
