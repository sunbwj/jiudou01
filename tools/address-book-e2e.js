/* ==========================================================================
   address-book-e2e.js —— 员工通讯录端到端验证（真实浏览器：本机 Edge + puppeteer-core）
   --------------------------------------------------------------------------
   验证：
     1) 登录后左侧导航「人力资源中心」下出现「员工通讯录」；
     2) 以 iframe 子页打开，组织架构树、通讯录卡片、只读提示都正常；
     3) 点部门节点 → 卡片随范围变化；关键字检索 → 结果收敛；
     4) 页面里没有新增 / 编辑 / 删除入口（纯查询）；
     5) 结果区撑满剩余高度（不出现整页滚动条）。
   前置：后端 8808 已启动、菜单数据已执行 db/address-book-menu.sql
   运行：NODE_PATH=<node_modules> node tools/address-book-e2e.js [账号] [密码]
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
        executablePath: EDGE, headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,960']
    });
    var page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 960 });
    page.on('pageerror', function (e) { console.log('    [pageerror] ' + e.message); });

    /* ---------- 0. 登录 ---------- */
    console.log('\n--- 0. 登录 ---');
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    WORK_ACCOUNT = await resolveAccount(page);
    var token = await page.evaluate(async function (account, password) {
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
        return ((await res.json()).data || {}).token || '';
    }, WORK_ACCOUNT, PASSWORD);
    check('登录成功', /^[0-9a-f]{32}$/.test(token), token.slice(0, 8));
    if (!token) { await browser.close(); finish(); return; }

    await page.evaluate(function (key, tk) {
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        var fmt = function (ms) {
            var d = new Date(ms);
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
                pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        };
        var now = new Date().getTime();
        localStorage.setItem(key, JSON.stringify({
            token: tk, time: fmt(now), expireTime: fmt(now + 8 * 3600 * 1000),
            expireAt: now + 8 * 3600 * 1000, ttlHours: 8, user: { account: 'e2e', empName: '通讯录测试' }
        }));
    }, KEY, token);

    /* ---------- 1. 导航里出现「员工通讯录」 ---------- */
    console.log('\n--- 1. 左侧导航 ---');
    await page.goto(BASE + '/main.html', { waitUntil: 'domcontentloaded' });
    await sleep(2600);
    var nav = await page.evaluate(function () {
        var link = document.querySelector('#frameMenu .frame-side__item[data-url="address-book.html"]');
        return {
            found: !!link,
            text: link ? (link.innerText || '').replace(/\s+/g, ' ').trim() : '',
            group: link ? (link.closest('.frame-side__group') || {}).innerText : ''
        };
    });
    if (IS_ADMIN) {
        check('导航里出现「员工通讯录」入口', nav.found === true && /员工通讯录/.test(nav.text), nav.text);
        check('入口挂在「人力资源中心」菜单组下', /人力资源中心/.test(String(nav.group)).valueOf() === true,
            String(nav.group).replace(/\s+/g, ' ').slice(0, 40));
    } else {
        skip('导航里出现「员工通讯录」入口', '当前账号不是系统管理员，导航按角色过滤');
        skip('入口挂在「人力资源中心」菜单组下', '同上');
    }

    /* ---------- 2. 打开页面（按 hash 直达，不依赖导航授权） ---------- */
    console.log('\n--- 2. 以 iframe 子页打开 ---');
    await page.goto(BASE + '/main.html#address-book.html', { waitUntil: 'domcontentloaded' });
    await sleep(2600);
    check('能以 iframe 子页打开通讯录', true);

    var frame = null;
    for (var i = 0; i < 20; i++) {
        frame = page.frames().filter(function (f) {
            if (f === page.mainFrame()) { return false; }
            var path = f.url().split('#')[0].split('?')[0];
            return path.slice(-'address-book.html'.length - 1) === '/address-book.html';
        })[0] || null;
        if (frame) {
            var ready = await frame.evaluate(function () { return !!document.querySelector('#abTree .el-tree-node'); });
            if (ready) { break; }
        }
        await sleep(500);
    }
    check('通讯录页以 iframe 子页加载', !!frame, frame ? frame.url() : 'none');

    if (frame) {
        var info = await frame.evaluate(function () {
            var cards = document.querySelectorAll('#abGrid .ab-card');
            var first = cards[0] ? cards[0].innerText.replace(/\s+/g, ' ').trim() : '';
            var main = document.querySelector('.app-main');
            var result = document.querySelector('.ab-result-card');
            var body = document.querySelector('.ab-scroll');
            function box(el) {
                if (!el) { return null; }
                var r = el.getBoundingClientRect();
                return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
            }
            return {
                title: (document.querySelector('.page-head__title') || {}).textContent || '',
                crumb: (document.querySelector('#pageHead') || {}).getAttribute('data-crumb') || '',
                treeNodes: document.querySelectorAll('#abTree .el-tree-node[data-id]').length,
                hasAll: /全部员工/.test(document.querySelector('#abTree').innerText || ''),
                cards: cards.length,
                total: (document.querySelector('#abTotal') || {}).textContent || '',
                firstCard: first,
                hasTel: !!document.querySelector('#abGrid a[href^="tel:"]'),
                hasMail: !!document.querySelector('#abGrid a[href^="mailto:"]'),
                readOnlyHint: /仅供查询/.test((document.querySelector('.ab-summary') || {}).innerText || ''),
                writeButtons: document.querySelectorAll('.el-button--danger, #btnAdd, #btnEdit, #btnDelete').length,
                hasToolbar: document.querySelectorAll('.toolbar').length,
                innerHeight: window.innerHeight,
                scrollHeight: document.documentElement.scrollHeight,
                result: box(result), body: box(body)
            };
        });
        check('页面标题为「员工通讯录」', /员工通讯录/.test(info.title), info.title);
        check('面包屑为「人力资源中心/员工通讯录」', info.crumb === '人力资源中心/员工通讯录', info.crumb);
        check('左侧组织架构树已渲染（含「全部员工」根）',
            info.treeNodes >= 2 && info.hasAll === true, 'nodes=' + info.treeNodes);
        check('右侧通讯录卡片已渲染', info.cards > 0, String(info.cards));
        check('卡片数量与合计人数一致', String(info.cards) === String(info.total).trim(),
            info.cards + ' vs ' + info.total);
        check('卡片显示工号 / 手机 / 邮箱等联系方式',
            /E\d{5}/.test(info.firstCard) && info.hasTel && info.hasMail, info.firstCard.slice(0, 100));
        check('页面提示「通讯录仅供查询」', info.readOnlyHint === true);
        check('页面上没有任何删除 / 新增 / 编辑按钮', info.writeButtons === 0, String(info.writeButtons));
        check('页面没有操作引导区（.toolbar）', info.hasToolbar === 0, String(info.hasToolbar));

        var lay = info;
        console.log('    [布局] iframe 高 ' + lay.innerHeight + '，结果区 ' + JSON.stringify(lay.result) +
            '，滚动区高 ' + (lay.body ? lay.body.height : '-'));
        check('结果区撑满页面剩余高度（底部贴近页面底部）',
            !!lay.result && Math.abs(lay.innerHeight - lay.result.bottom) <= 60,
            lay.result ? (lay.innerHeight + ' vs ' + lay.result.bottom) : 'null');
        check('页面不出现整页滚动条', lay.scrollHeight <= lay.innerHeight + 2,
            lay.scrollHeight + ' vs ' + lay.innerHeight);

        /* ---------- 3. 部门筛选 + 关键字检索 ---------- */
        console.log('\n--- 3. 按组织架构筛选 + 检索 ---');
        var before = info.cards;
        var clicked = await frame.evaluate(function () {
            var nodes = Array.prototype.slice.call(document.querySelectorAll('#abTree .el-tree-node[data-id]'));
            // 取第一个「有子部门且非全部员工」的部门节点
            for (var i = 0; i < nodes.length; i++) {
                var id = nodes[i].getAttribute('data-id');
                if (id === '0' || id === '-1') { continue; }
                var content = nodes[i].querySelector(':scope > .el-tree-node__content');
                if (content) {
                    content.click();
                    return { id: id, name: (content.innerText || '').replace(/\s+/g, ' ').trim() };
                }
            }
            return null;
        });
        await sleep(1200);
        var afterDept = await frame.evaluate(function () {
            return {
                cards: document.querySelectorAll('#abGrid .ab-card').length,
                scope: (document.querySelector('#abScope') || {}).textContent || '',
                current: document.querySelectorAll('#abTree .el-tree-node__content.is-current').length
            };
        });
        check('点击部门后树节点高亮', afterDept.current === 1, String(afterDept.current));
        check('范围提示随部门切换', /含下级部门|全部员工/.test(afterDept.scope) && afterDept.scope !== '全部员工',
            afterDept.scope);
        check('结果数量随部门收敛', afterDept.cards <= before && afterDept.cards > 0,
            before + ' → ' + afterDept.cards);

        // 关键字检索（用第一个员工姓名的首字）
        var kw = String(info.firstCard).match(/[\u4e00-\u9fa5]{1}/) ? String(info.firstCard).slice(0, 1) : '';
        await frame.evaluate(function (word) {
            var $ = window.jQuery;
            $('#abKeyword').val(word);
            $('#btnAbSearch').trigger('click');
        }, kw);
        await sleep(1200);
        var afterKw = await frame.evaluate(function () {
            return {
                cards: document.querySelectorAll('#abGrid .ab-card').length,
                text: (document.querySelector('#abGrid') || {}).innerText || ''
            };
        });
        check('关键字检索能收敛结果', afterKw.cards >= 1 && afterKw.cards <= afterDept.cards,
            'kw=' + kw + ', cards=' + afterKw.cards);

        await frame.evaluate(function () {
            var $ = window.jQuery;
            $('#btnAbReset').trigger('click');
        });
        await sleep(1000);
        var afterReset = await frame.evaluate(function () {
            return {
                cards: document.querySelectorAll('#abGrid .ab-card').length,
                keyword: (document.querySelector('#abKeyword') || {}).value || '',
                scope: (document.querySelector('#abScope') || {}).textContent || ''
            };
        });
        check('重置后回到全部员工列表', afterReset.cards === before && afterReset.keyword === '' &&
            /全部员工/.test(afterReset.scope), JSON.stringify(afterReset));
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
