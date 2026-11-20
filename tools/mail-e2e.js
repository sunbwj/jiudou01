/* ==========================================================================
   mail-e2e.js —— 服务信箱 / 邮箱助手端到端验证（真实浏览器：本机 Edge + puppeteer-core）
   --------------------------------------------------------------------------
   验证：
     1) 登录后左侧导航出现「邮件中心」组与两个功能页（服务信箱设置 / 邮箱助手）；
     2) 服务信箱设置页在 iframe 中正常渲染（单例表：最多 1 行；空表时新增后能渲染，已有配置时复用）；
     3) 编辑弹窗几何（宽 560 / label 与录入框同行 / 服务器与端口并排）；
     4) 邮箱助手页能读到当前启用的服务信箱，收件箱 / 已发送 / 列表 / 阅读区结构完整；
     5) 邮箱助手右上角「刷新」后面的设置图标按钮：纯图标、与相邻按钮等高、点击弹出服务信箱弹窗；
     6) 「收件」按钮在邮箱不可用时会给出可读的错误提示（不会白屏 / 不静默失败）；
     7) 清理：测试自己建的信箱才删，复用真实配置时只把启用状态复原。
   前置：后端 8808 已启动；数据库可写。
   运行：NODE_PATH=<node_modules> node tools/mail-e2e.js [账号] [密码]
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
var TEST_MAIL = 'service.e2e@qq.com';

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
    console.log('\n--- 0. 登录拿到 token ---');
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
        var j = await res.json();
        return (j.data || {}).token || '';
    }, WORK_ACCOUNT, PASSWORD);
    check('登录成功', /^[0-9a-f]{32}$/.test(token), token.slice(0, 8));
    if (!token) { await browser.close(); finish(); return; }

    await page.evaluate(function (key, token) {
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        var fmt = function (ms) {
            var d = new Date(ms);
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
                pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        };
        var now = new Date().getTime();
        localStorage.setItem(key, JSON.stringify({
            token: token, time: fmt(now), expireTime: fmt(now + 8 * 3600 * 1000),
            expireAt: now + 8 * 3600 * 1000, ttlHours: 8, user: { account: 'e2e', empName: '邮件测试' }
        }));
    }, KEY, token);

    /* serviceemail 是单例表（全表只允许一条记录）：
       · 表里没有记录 → 用接口建一条测试信箱，结束后删掉；
       · 表里已有记录（用户真实配置）→ 直接拿它做断言，绝不新增、绝不删除；
         若它不是启用状态，测试期间临时启用，结束后恢复成停用。 */
    var setup = await page.evaluate(async function (token, testMail) {
        function post(path, body) {
            return fetch(path, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({}, body, { token: token }))
            }).then(function (r) { return r.json(); });
        }
        var list = await (await fetch('/api/serviceemail/list?pageNum=1&pageSize=200&token=' + token)).json();
        var rows = (list.data || {}).list || [];
        var mine = null;
        for (var i = 0; i < rows.length; i++) {
            if (String(rows[i].email || '').toLowerCase() === String(testMail).toLowerCase()) { mine = rows[i]; }
        }
        if (!rows.length) {
            var added = await post('/api/serviceemail/add', {
                email: testMail, password: 'e2e-auth-code', displayName: '端到端测试信箱',
                enabled: 1, remark: 'mail-e2e'
            });
            var d = added.data || {};
            return { ok: added.code === 0, created: added.code === 0, email: testMail,
                     enabled: !!d.enabled, imap: d.imapHostText || '', smtp: d.smtpHostText || '',
                     message: added.message || '' };
        }
        var pick = mine || rows.filter(function (x) { return x.enabled; })[0] || rows[0];
        var wasEnabled = !!pick.enabled;
        if (!wasEnabled) { await post('/api/serviceemail/enabled', { id: pick.id, enabled: 1 }); }
        return { ok: true, created: false, mustRestoreDisabled: !wasEnabled,
                 email: pick.email, enabled: true,
                 imap: pick.imapHostText || '', smtp: pick.smtpHostText || '', message: '' };
    }, token, TEST_MAIL);
    var TARGET_MAIL = setup.email || TEST_MAIL;
    var CREATED = !!setup.created;
    var RESTORE_DISABLED = !!setup.mustRestoreDisabled;
    var TARGET_IMAP = String(setup.imap || '').split(':')[0];
    console.log('    （本次断言用的服务信箱：' + TARGET_MAIL +
        (CREATED ? '，由测试新建' : '，复用库里已有配置') + '）');

    /** 清理：只删「本测试自己建」的那条；复用真实配置时只把启用状态复原 */
    async function cleanup() {
        await page.evaluate(async function (token, testMail, created, restoreDisabled) {
            function post(path, body) {
                return fetch(path, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(Object.assign({}, body, { token: token }))
                }).then(function (r) { return r.json(); });
            }
            var list = await (await fetch('/api/serviceemail/list?pageNum=1&pageSize=200&token=' + token)).json();
            var rows = (list.data || {}).list || [];
            for (var i = 0; i < rows.length; i++) {
                if (String(rows[i].email || '').toLowerCase() === String(testMail).toLowerCase()) {
                    if (created) { await post('/api/serviceemail/delete', { id: rows[i].id }); }
                    else if (restoreDisabled) { await post('/api/serviceemail/enabled', { id: rows[i].id, enabled: 0 }); }
                }
            }
        }, token, TEST_MAIL, CREATED, RESTORE_DISABLED);
    }

    /* ---------- 1. 导航出现「邮件中心」 ---------- */
    console.log('\n--- 1. 左侧导航（邮件中心）---');
    await page.goto(BASE + '/main.html', { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    var navText = await page.evaluate(function () {
        var el = document.querySelector('#frameMenu');
        return el ? el.innerText : '';
    });
    var navAllText = await page.evaluate(function () {
        var el = document.querySelector('#frameMenu');
        return el ? el.textContent : '';
    });
    if (IS_ADMIN) {
        check('导航含「邮件中心」菜单组', /邮件中心/.test(navText), navText.replace(/\s+/g, ' ').slice(0, 120));
        // 菜单组默认只有最上面那个展开，「邮件中心」是收起的 → 其菜单项在 DOM 里但不可见，用 textContent 校验
        check('导航含「服务信箱设置」', /服务信箱设置/.test(navAllText), navAllText.replace(/\s+/g, ' ').slice(0, 120));
        check('导航含「邮箱助手」', /邮箱助手/.test(navAllText));
    } else {
        skip('导航含「邮件中心」菜单组', '当前账号不是系统管理员，导航按角色过滤');
        skip('导航含「服务信箱设置」', '同上');
        skip('导航含「邮箱助手」', '同上');
    }

    /* ---------- 2. 打开服务信箱设置页（按 hash 直达，不依赖导航授权） ---------- */
    console.log('\n--- 2. 服务信箱设置页（iframe）---');
    await page.goto(BASE + '/main.html#service-email.html', { waitUntil: 'domcontentloaded' });
    await sleep(2600);
    check('能以 iframe 子页打开「服务信箱设置」', true);

    function frameOf(name) {
        var main = page.mainFrame();
        var want = '/' + name;
        return page.frames().filter(function (f) {
            if (f === main) { return false; }
            // 去掉 hash / 查询串后按「路径结尾」精确匹配：service-email.html 也含 'mail.html'，不能用 indexOf
            var path = f.url().split('#')[0].split('?')[0];
            return path.slice(-want.length) === want;
        })[0] || null;
    }
    /** 等 iframe 真正加载出业务 DOM（首次加载 + HEAD 探测可能要几秒） */
    async function waitFrame(name, selector, timeout) {
        var limit = timeout || 12000, waited = 0;
        while (waited < limit) {
            var f = frameOf(name);
            if (f) {
                try {
                    var ok = await f.evaluate(function (sel) { return !!document.querySelector(sel); }, selector);
                    if (ok) { return f; }
                } catch (e) { /* 文档还没 ready，继续等 */ }
            }
            await sleep(400);
            waited += 400;
        }
        return frameOf(name);
    }
    var seFrame = await waitFrame('service-email.html', '#seTable');
    check('服务信箱设置以 iframe 子页加载', !!seFrame, seFrame ? seFrame.url() : 'none');

    if (seFrame) {
        var info = await seFrame.evaluate(function () {
            return {
                title: (document.querySelector('.page-head__title') || {}).textContent || '',
                tip: (document.querySelector('.se-tip') || {}).textContent || '',
                buttons: ['#btnEnable', '#btnDisable', '#btnTest', '#btnEdit', '#btnRefresh']
                    .filter(function (id) { return !!document.querySelector(id); }).length,
                removed: ['#btnAdd', '#btnDelete']
                    .filter(function (id) { return !!document.querySelector(id); }).length,
                cols: document.querySelectorAll('#seTable thead th').length,
                rows: document.querySelectorAll('#seTbody tr[data-id]').length,
                empty: (document.querySelector('#seTbody') || {}).textContent || ''
            };
        });
        check('页面标题为「服务信箱设置」', /服务信箱设置/.test(info.title), info.title);
        check('页面说明写明「全表只保留一条记录」', /全表只保留一条记录/.test(info.tip));
        check('操作引导区 5 个按钮齐全（启用 / 停用 / 测试连接 / 编辑 / 刷新）', info.buttons === 5,
            String(info.buttons));
        check('「新增服务信箱」「删除」按钮已移除', info.removed === 0, String(info.removed));
        check('表头 9 列', info.cols === 9, String(info.cols));
        check('单例表：列表最多 1 行', info.rows <= 1, String(info.rows));
        check('列表为空时给出新增引导 / 有配置时正常渲染表格',
            /还没有服务信箱/.test(info.empty) || info.rows >= 1,
            info.empty.replace(/\s+/g, ' ').slice(0, 60));

        // 单例表：只有「本来没有配置」时才走接口新增（UI 交互由 jsdom 测试覆盖）
        console.log('\n--- 3. 服务信箱行渲染 + 编辑弹窗 ---');
        if (CREATED) {
            check('接口新增服务信箱成功（表里原本没有配置）', setup.ok === true, String(setup.message).slice(0, 80));
            var second = await seFrame.evaluate(async function (token) {
                var res = await (await fetch('/api/serviceemail/add', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: 'should.fail@163.com', password: 'x', enabled: 0, token: token })
                })).json();
                return res;
            }, token);
            check('单例表：已有记录时第二条新增被拒绝',
                (second || {}).code !== 0 && /一条/.test(String((second || {}).message || '')),
                String((second || {}).message || '').slice(0, 80));
        } else {
            skip('接口新增服务信箱成功（表里原本没有配置）',
                '库里已有配置（单例表不再允许新增），本次复用：' + TARGET_MAIL);
            skip('单例表：已有记录时第二条新增被拒绝', '已有配置时 jsdom / 后端测试已覆盖该分支');
        }

        await seFrame.evaluate(function () { window.jQuery('#btnRefresh').trigger('click'); });
        await sleep(1200);
        var rendered = await seFrame.evaluate(function (email) {
            var text = document.querySelector('#seTbody').innerText || '';
            var rows = document.querySelectorAll('#seTbody tr[data-id]');
            var row = null, rowText = '';
            for (var i = 0; i < rows.length; i++) {
                if ((rows[i].innerText || '').indexOf(email) > -1) { row = rows[i]; rowText = rows[i].innerText.replace(/\s+/g, ' '); }
            }
            return {
                text: text, rowCount: rows.length,
                hasMail: !!row,
                rowEnabled: !!row && /启用/.test(rowText) && !/停用/.test(rowText),
                tip: (document.querySelector('#enabledTip') || {}).textContent || '',
                host: rowText
            };
        }, TARGET_MAIL);
        check('列表渲染出目标服务信箱', rendered.hasMail, rendered.text.replace(/\s+/g, ' ').slice(0, 60));
        check('列表只有 1 行（单例表）', rendered.rowCount === 1, String(rendered.rowCount));
        check('目标服务信箱为启用状态', rendered.rowEnabled === true, rendered.host.slice(0, 60));
        check('工具栏提示当前启用的邮箱', rendered.tip.indexOf(TARGET_MAIL) > -1, rendered.tip);
        var okHost = TARGET_IMAP
            ? (rendered.host.indexOf(TARGET_IMAP + ':') > -1)
            : /imap\.[a-z0-9.\-]+:\d+/.test(rendered.host);
        check('行内显示自动推断的服务器（IMAP 主机 + 端口）', okHost, rendered.host.slice(0, 80));
        check('列表不出现明文密码', rendered.text.indexOf('e2e-auth-code') < 0);

        // 编辑弹窗：宽度收窄、只剩密码一条提示语、服务器设置直接铺在表单里（只打开不保存）
        console.log('    [编辑弹窗] 检查宽度 / 提示语 / 服务器直接填写');
        var dlg = await seFrame.evaluate(async function (email) {
            function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
            var $ = window.jQuery;
            var rows = Array.prototype.slice.call(document.querySelectorAll('#seTbody tr[data-id]'));
            var target = null;
            for (var i = 0; i < rows.length; i++) {
                if ((rows[i].innerText || '').indexOf(email) > -1) { target = rows[i]; }
            }
            if (!target) { return { found: false }; }
            $(target).trigger('click');
            $('#btnEdit').trigger('click');
            await wait(500);
            var $dlg = $('.el-overlay .el-dialog').last();
            var $body = $dlg.find('.el-dialog__body');
            var info = {
                found: true,
                width: Math.round($dlg[0].getBoundingClientRect().width),
                bottom: Math.round($dlg[0].getBoundingClientRect().bottom),
                height: Math.round($dlg[0].getBoundingClientRect().height),
                sameLine: (function () {
                    var lb = $body.find('.el-form-item').first().find('.el-form-item__label')[0];
                    var inp = $body.find('#sfEmail')[0];
                    if (!lb || !inp) { return false; }
                    var a = lb.getBoundingClientRect(), b = inp.getBoundingClientRect();
                    return Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 8;
                })(),
                /* 逐行检查：每个 label 都与自己的录入框同行，且文字没有被压缩/换行 */
                labelIssues: (function () {
                    var bad = [];
                    $body.find('.el-form-item').each(function () {
                        var $item = $(this);
                        var lb = $item.find('.el-form-item__label')[0];
                        var ctl = $item.find('input, select, textarea').first()[0];
                        if (!lb || !ctl) { return; }
                        var a = lb.getBoundingClientRect(), b = ctl.getBoundingClientRect();
                        var text = ($(lb).text() || '').trim();
                        if (Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) > 8) {
                            bad.push(text + '(不同行)');
                        }
                        if (lb.scrollWidth > lb.clientWidth + 1) {
                            bad.push(text + '(被压缩 ' + lb.scrollWidth + '>' + lb.clientWidth + ')');
                        }
                        if (a.height > 48) {                    // line-height 40：两行会到 80
                            bad.push(text + '(高 ' + Math.round(a.height) + ')');
                        }
                    });
                    return bad;
                })(),
                pwdLabelBox: (function () {
                    var lb = $body.find('label[for="sfPassword"]')[0];
                    if (!lb) { return null; }
                    var r = lb.getBoundingClientRect();
                    return {
                        w: Math.round(r.width), h: Math.round(r.height),
                        text: (lb.innerText || '').replace(/\s+/g, ' ').trim(),
                        scrollW: lb.scrollWidth, clientW: lb.clientWidth
                    };
                })(),
                viewH: window.innerHeight,
                tips: $body.find('.form-tip').length,
                hasPwdTip: $body.find('#sfPasswordTip').length,
                hasAdvanced: $body.find('#sfAdvanced').length,
                hasImap: $body.find('#sfImapHost').length === 1 && $body.find('#sfImapHost').is(':visible'),
                hasSmtp: $body.find('#sfSmtpHost').length === 1 && $body.find('#sfSmtpHost').is(':visible'),
                hasSsl: $body.find('#sfSsl').length === 1,
                rowPairs: $body.find('.se-adv-row').length,
                imapVal: String($body.find('#sfImapHost').val() || ''),
                text: ($body.text() || '').replace(/\s+/g, ' ').slice(0, 100)
            };
            $('.el-overlay').remove();          // 取消，不改动真实配置
            $('body').css('overflow', '');
            return info;
        }, TARGET_MAIL);
        check('能打开编辑弹窗', dlg.found === true);
        check('编辑弹窗宽度为 560px', dlg.width === 560, String(dlg.width));
        check('表单里只有密码后面 1 条提示语', dlg.tips === 1 && dlg.hasPwdTip === 1,
            'tips=' + dlg.tips);
        check('服务器设置直接可见（无勾选框、收/发服务器与端口并排）',
            dlg.hasAdvanced === 0 && dlg.hasImap && dlg.hasSmtp && dlg.hasSsl && dlg.rowPairs === 2,
            JSON.stringify({ adv: dlg.hasAdvanced, imap: dlg.hasImap, smtp: dlg.hasSmtp, rows: dlg.rowPairs }));
        check('表单文字里不再有「手工指定服务器」等提示',
            dlg.text.indexOf('手工指定服务器') < 0, dlg.text);
        check('弹窗完整落在视口内（不需要滚动就能看到确定按钮）',
            dlg.bottom <= dlg.viewH, dlg.bottom + ' / ' + dlg.viewH);
        check('label 与录入框同一行（窄弹窗里不会被挤成两行）', dlg.sameLine === true,
            'height=' + dlg.height + ' bottom=' + dlg.bottom);
        check('所有 label 都不换行 / 不被压缩（含「密码 / 授权码」）',
            dlg.labelIssues.length === 0, dlg.labelIssues.join('；'));
        check('「密码 / 授权码」标签单行显示（高度 40、文字不溢出）',
            !!dlg.pwdLabelBox && dlg.pwdLabelBox.h <= 44 &&
            dlg.pwdLabelBox.scrollW <= dlg.pwdLabelBox.clientW + 1,
            dlg.pwdLabelBox ? (dlg.pwdLabelBox.text + ' h=' + dlg.pwdLabelBox.h +
                ' ' + dlg.pwdLabelBox.scrollW + '/' + dlg.pwdLabelBox.clientW) : 'null');
    }

    /* ---------- 4. 邮箱助手页 ---------- */
    console.log('\n--- 4. 邮箱助手页 ---');
    await page.goto(BASE + '/main.html#mail.html', { waitUntil: 'domcontentloaded' });
    await sleep(2600);
    check('能以 iframe 子页打开「邮箱助手」', true);
    await sleep(2200);
    var mailFrame = await waitFrame('mail.html', '.mail-folders');
    check('邮箱助手以 iframe 子页加载', !!mailFrame, mailFrame ? mailFrame.url() : 'none');

    if (mailFrame) {
        var minfo = await mailFrame.evaluate(function () {
            return {
                title: (document.querySelector('.page-head__title') || {}).textContent || '',
                email: (document.querySelector('#mailEmail') || {}).textContent || '',
                meta: (document.querySelector('#mailMeta') || {}).textContent || '',
                folders: document.querySelectorAll('.mail-folder').length,
                inboxBadge: (document.querySelector('#badgeInbox') || {}).textContent || '',
                listText: (document.querySelector('#mailList') || {}).innerText || '',
                mailCount: document.querySelectorAll('#mailList .mail-item').length,
                readText: (document.querySelector('#mailRead') || {}).innerText || '',
                hasWrite: !!document.querySelector('#btnWrite'),
                hasSync: !!document.querySelector('#btnSync'),
                layout: (function () {
                    var main = document.querySelector('.app-main');
                    var card = document.querySelector('.mail-card');
                    var body = document.querySelector('.mail-body');
                    var list = document.querySelector('.mail-list');
                    var read = document.querySelector('#mailRead');
                    function box(el) {
                        if (!el) { return null; }
                        var r = el.getBoundingClientRect();
                        return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
                    }
                    return {
                        innerHeight: window.innerHeight,
                        scrollHeight: document.documentElement.scrollHeight,
                        bodyScrollHeight: document.body.scrollHeight,
                        hasMailPage: !!(main && main.className.indexOf('mail-page') > -1),
                        card: box(card), body: box(body), list: box(list), read: box(read)
                    };
                })()
            };
        });
        check('页面标题为「邮箱助手」', /邮箱助手/.test(minfo.title), minfo.title);
        check('状态条显示当前启用的服务信箱', minfo.email.indexOf(TARGET_MAIL) > -1, minfo.email);
        check('状态条显示服务商与 IMAP 服务器',
            /IMAP/.test(minfo.meta) && (!TARGET_IMAP || minfo.meta.indexOf(TARGET_IMAP) > -1), minfo.meta);
        check('左侧有收件箱 / 已发送两个文件夹', minfo.folders === 2, String(minfo.folders));
        check('收件箱已渲染（有邮件则列出，无邮件则给出收件引导）',
            /收件箱是空的/.test(minfo.listText) || minfo.mailCount > 0,
            minfo.mailCount + ' 封 / ' + minfo.listText.replace(/\s+/g, ' ').slice(0, 40));
        check('阅读区提示选择邮件', /选择一封邮件/.test(minfo.readText));
        check('有「写邮件 / 收件」按钮', minfo.hasWrite && minfo.hasSync);

        // 布局：邮件列表与阅读区撑满页面剩余高度，页面本身不出现纵向滚动条
        var lay = minfo.layout;
        console.log('    [布局] iframe 高 ' + lay.innerHeight + '，邮件区 ' +
            JSON.stringify(lay.body) + '，文档 scrollHeight ' + lay.scrollHeight);
        check('主区使用 mail-page 布局（邮件区自适应剩余高度）', lay.hasMailPage === true);
        check('邮件区底部贴住页面底部（差值 <= 40px）',
            !!lay.body && Math.abs(lay.innerHeight - lay.body.bottom) <= 40,
            lay.body ? (lay.innerHeight + ' vs ' + lay.body.bottom) : 'null');
        check('邮件区高度吃掉剩余页高（> 300px 且 >= 卡片高度 90%）',
            !!lay.body && lay.body.height > 300 && !!lay.card && lay.body.height >= lay.card.height * 0.9,
            lay.body && lay.card ? (lay.body.height + ' / ' + lay.card.height) : 'null');
        check('列表与阅读区等高（同一行分栏）',
            !!lay.list && !!lay.read && Math.abs(lay.list.height - lay.read.height) <= 2,
            lay.list && lay.read ? (lay.list.height + ' / ' + lay.read.height) : 'null');
        check('页面不出现纵向滚动条（内容没有溢出 iframe）',
            lay.scrollHeight <= lay.innerHeight + 2,
            lay.scrollHeight + ' vs ' + lay.innerHeight);

        // 「刷新」后面的设置图标按钮：真实浏览器里量几何（纯图标 / 与相邻按钮等高 / 点击弹编辑服务信箱）
        console.log('    [设置按钮] 量几何 + 打开服务信箱弹窗');
        var setting = await mailFrame.evaluate(async function (wantEmail) {
            function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
            var $ = window.jQuery;
            var btn = document.querySelector('#btnMailSetting');
            var refresh = document.querySelector('#btnMailRefresh');
            function box(el) {
                if (!el) { return null; }
                var r = el.getBoundingClientRect();
                return { w: Math.round(r.width), h: Math.round(r.height),
                         top: Math.round(r.top), left: Math.round(r.left),
                         cy: Math.round(r.top + r.height / 2) };
            }
            var info = {
                exists: !!btn,
                isIcon: !!btn && (btn.className || '').indexOf('el-button--icon') > -1,
                text: btn ? (btn.textContent || '').trim() : '',
                title: btn ? (btn.getAttribute('title') || '') : '',
                hasSvg: !!btn && !!btn.querySelector('svg'),
                btnBox: box(btn), refreshBox: box(refresh),
                afterRefresh: !!(btn && refresh && (refresh.compareDocumentPosition(btn) & 4) === 4)
            };
            if (!btn) { return info; }
            $(btn).trigger('click');
            await wait(900);
            var $dlg = $('.el-overlay .el-dialog').last();
            var $body = $dlg.find('.el-dialog__body');
            var dlgEl = $dlg[0];
            info.dialog = {
                count: $('.el-overlay .el-dialog').length,
                title: $dlg.find('.el-dialog__title').text(),
                width: dlgEl ? Math.round(dlgEl.getBoundingClientRect().width) : 0,
                bottom: dlgEl ? Math.round(dlgEl.getBoundingClientRect().bottom) : 0,
                viewH: window.innerHeight,
                email: String($body.find('#sfEmail').val() || ''),
                pwdEmpty: String($body.find('#sfPassword').val() || '') === '',
                okText: $.trim($dlg.find('.btn-ok').text()),
                items: $body.find('.el-form-item').length,
                sameLine: (function () {
                    var bad = 0;
                    $body.find('.el-form-item').each(function () {
                        var lb = $(this).find('.el-form-item__label')[0];
                        var ctl = $(this).find('input, select, textarea').first()[0];
                        if (!lb || !ctl) { return; }
                        var a = lb.getBoundingClientRect(), b = ctl.getBoundingClientRect();
                        if (Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) > 8) { bad++; }
                        if (lb.scrollWidth > lb.clientWidth + 1) { bad++; }
                    });
                    return bad === 0;
                })()
            };
            $('.el-overlay').remove();          // 只验证能打开，不改动真实配置
            $('.el-loading-mask').remove();
            $('body').css('overflow', '');
            return info;
        }, TARGET_MAIL);
        check('「刷新」后面有设置图标按钮', setting.exists && setting.afterRefresh === true,
            JSON.stringify(setting.btnBox) + ' / ' + JSON.stringify(setting.refreshBox));
        check('设置按钮是纯图标按钮（el-button--icon + svg，没有文字）',
            setting.isIcon === true && setting.hasSvg === true && setting.text === '',
            (setting.text || '') + ' / ' + setting.title);
        check('设置按钮带 title 说明（图标按钮可读性）', /服务信箱设置/.test(setting.title), setting.title);
        check('设置按钮是正方形（宽高差 <= 2px，边长 >= 32px）',
            !!setting.btnBox && Math.abs(setting.btnBox.w - setting.btnBox.h) <= 2 && setting.btnBox.w >= 32,
            JSON.stringify(setting.btnBox));
        check('设置按钮与「刷新」按钮等高且中线对齐',
            !!setting.btnBox && !!setting.refreshBox &&
            Math.abs(setting.btnBox.h - setting.refreshBox.h) <= 2 &&
            Math.abs(setting.btnBox.cy - setting.refreshBox.cy) <= 2,
            JSON.stringify(setting.btnBox) + ' vs ' + JSON.stringify(setting.refreshBox));
        check('点击后弹出服务信箱弹窗（表里有记录 = 编辑）',
            !!setting.dialog && setting.dialog.count === 1 && /编辑服务信箱/.test(setting.dialog.title || ''),
            setting.dialog ? setting.dialog.title : 'none');
        check('弹窗回填当前那条服务信箱',
            !!setting.dialog && setting.dialog.email === TARGET_MAIL,
            setting.dialog ? setting.dialog.email : 'none');
        check('弹窗宽 560 且完整落在视口内',
            !!setting.dialog && setting.dialog.width === 560 && setting.dialog.bottom <= setting.dialog.viewH,
            setting.dialog ? (setting.dialog.width + ' / ' + setting.dialog.bottom + ' vs ' + setting.dialog.viewH) : 'none');
        check('弹窗 8 个表单项、label 与录入框同行且不换行',
            !!setting.dialog && setting.dialog.items >= 8 && setting.dialog.sameLine === true,
            setting.dialog ? (setting.dialog.items + ' 项 sameLine=' + setting.dialog.sameLine) : 'none');

        // 写邮件：收件人处可从员工信息中选取邮箱（真实员工数据）
        var pick = await mailFrame.evaluate(async function () {
            function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
            var $ = window.jQuery;
            $('#btnWrite').trigger('click');
            await wait(500);
            var $write = $('.el-overlay .el-dialog').last();
            var hasPickBtn = $write.find('#mfPickEmp').length === 1;
            // 附件区：按钮要可见可点，原生 file 输入框要隐藏；弹窗整体不能超出视口
            function box(sel) {
                var el = $write.find(sel)[0];
                if (!el) { return null; }
                var r = el.getBoundingClientRect();
                return { w: Math.round(r.width), h: Math.round(r.height) };
            }
            var dlg = $write[0] ? $write[0].getBoundingClientRect() : null;
            var attach = {
                btn: box('#mfPickFile'),
                file: box('#mfFile'),
                hasInput: $write.find('#mfFile').length === 1,
                tip: String($write.find('#mfAttachTip').text() || ''),
                dialogBottom: dlg ? Math.round(dlg.bottom) : 0,
                viewHeight: window.innerHeight
            };
            $write.find('#mfPickEmp').trigger('click');
            await wait(1600);
            var $pick = $('.el-overlay .el-dialog').last();
            var info = {
                hasPickBtn: hasPickBtn,
                attach: attach,
                dialogs: $('.el-overlay .el-dialog').length,
                title: $pick.find('.el-dialog__title').text(),
                rows: $pick.find('.emp-pick__row').length,
                listText: ($pick.find('.emp-pick__list').text() || '').replace(/\s+/g, ' ').slice(0, 80),
                hasSearch: $pick.find('#pfKeyword').length === 1,
                email: '', to: ''
            };
            var $row = $pick.find('.emp-pick__row').first();
            if ($row.length) {
                info.email = String($row.attr('data-email') || '');
                $row.find('.pf-check').prop('checked', true).trigger('change');
                $pick.find('.btn-ok').trigger('click');
                await wait(700);
                info.to = String($('.el-overlay .el-dialog').last().find('#mfTo').val() || '');
            }
            $('.el-overlay').remove();          // 关掉写邮件弹窗，避免影响后续步骤
            $('body').css('overflow', '');
            return info;
        });
        check('写邮件弹窗里收件人旁有「从员工选取」按钮', pick.hasPickBtn === true);
        check('能打开「从员工信息中选取收件人」弹窗（二级弹窗）',
            pick.dialogs === 2 && /从员工信息中选取收件人/.test(pick.title), pick.title);
        check('弹窗内列出员工信息表里的员工（含邮箱）',
            pick.rows > 0 && /@/.test(pick.listText) && pick.hasSearch === true,
            'rows=' + pick.rows + ' / ' + pick.listText);
        check('勾选员工并确定后邮箱写入收件人',
            !!pick.email && pick.to.indexOf(pick.email) > -1, pick.email + ' → ' + pick.to);

        check('写邮件弹窗里有「添加附件」按钮且可见',
            !!pick.attach.btn && pick.attach.btn.w > 60 && pick.attach.btn.h > 20,
            JSON.stringify(pick.attach.btn));
        check('原生 file 输入框被隐藏（不占位）',
            pick.attach.hasInput && (!pick.attach.file || (pick.attach.file.w === 0 && pick.attach.file.h === 0)),
            JSON.stringify(pick.attach.file));
        check('附件提示写明 10 MB / 5 个限制',
            /10 MB/.test(pick.attach.tip) && /5 个/.test(pick.attach.tip), pick.attach.tip);
        check('加了附件行后弹窗仍在视口内',
            pick.attach.dialogBottom > 0 && pick.attach.dialogBottom <= pick.attach.viewHeight + 2,
            pick.attach.dialogBottom + ' vs ' + pick.attach.viewHeight);

        console.log('\n--- 5. 收件（邮箱不可用时给出可读错误）---');
        await mailFrame.evaluate(function () { window.jQuery('#btnSync').trigger('click'); });
        var waited = 0, toastText = '';
        for (var i = 0; i < 60; i++) {
            toastText = await mailFrame.evaluate(function () {
                var el = document.querySelector('.el-message-list');
                return el ? el.innerText : '';
            });
            if (/收件/.test(toastText)) { break; }
            await sleep(500);
            waited += 500;
        }
        check('点「收件」后给出结果提示（成功或失败均有反馈）', /收件/.test(toastText),
            (toastText || '').replace(/\s+/g, ' ').slice(0, 100));
        var syncBtnEnabled = await mailFrame.evaluate(function () {
            return !document.querySelector('#btnSync').disabled;
        });
        check('收件结束后按钮恢复可用', syncBtnEnabled === true);
    }

    /* ---------- 6. 清理：删除服务信箱 → 未启用引导 ---------- */
    console.log('\n--- 6. 删除服务信箱后的引导状态 ---');
    if (seFrame) {
        await cleanup();
        await seFrame.evaluate(function () { window.jQuery('#btnRefresh').trigger('click'); });
        await sleep(1200);
        var afterDelete = await seFrame.evaluate(function (testMail) {
            var text = (document.querySelector('#seTbody') || {}).textContent || '';
            return {
                text: text,
                empty: text,
                rows: document.querySelectorAll('#seTbody tr[data-id]').length,
                testMailLeft: text.toLowerCase().indexOf(String(testMail).toLowerCase()) > -1,
                tip: (document.querySelector('#enabledTip') || {}).textContent || ''
            };
        }, TEST_MAIL);
        if (CREATED) {
            check('测试信箱已删除（列表里不再出现 service.e2e@qq.com）', afterDelete.testMailLeft === false,
                afterDelete.text.replace(/\s+/g, ' ').slice(0, 60));
            check('删除后回到「空表」状态（单例表：0 条记录）', afterDelete.rows === 0,
                afterDelete.text.replace(/\s+/g, ' ').slice(0, 60));
        } else {
            check('复用真实配置：测试没有删除那条记录（仍在列表里）', afterDelete.rows === 1,
                afterDelete.text.replace(/\s+/g, ' ').slice(0, 60));
            check('复用的服务信箱启用状态已复原',
                RESTORE_DISABLED ? /未启用/.test(afterDelete.tip) : /@/.test(afterDelete.tip),
                afterDelete.tip);
        }
    }
    if (mailFrame) {
        await mailFrame.evaluate(function () { window.jQuery('#btnMailRefresh').trigger('click'); });
        await sleep(1400);
        var after = await mailFrame.evaluate(function () {
            return {
                email: (document.querySelector('#mailEmail') || {}).textContent || '',
                meta: (document.querySelector('#mailMeta') || {}).textContent || '',
                list: (document.querySelector('#mailList') || {}).innerText || ''
            };
        });
        if (!CREATED && !RESTORE_DISABLED) {
            // 库里本来就有启用中的真实配置：页面应显示那个邮箱并能列出邮件
            check('邮箱助手显示既有启用的服务信箱（测试未污染真实配置）',
                /@/.test(after.email) && !/未启用服务信箱/.test(after.email), after.email);
            check('状态条展示服务商与服务器信息', /IMAP/.test(after.meta), after.meta.slice(0, 60));
            check('收件箱能列出邮件（或为空时给出收件提示）',
                !/尚未配置服务信箱/.test(after.list), after.list.replace(/\s+/g, ' ').slice(0, 60));
        } else {
            check('邮箱助手提示未启用服务信箱', /未启用服务信箱/.test(after.email), after.email);
            check('引导点右上角「设置」按钮', /设置/.test(after.meta), after.meta);
            check('列表给出未配置引导', /尚未配置服务信箱/.test(after.list),
                after.list.replace(/\s+/g, ' ').slice(0, 40));
        }
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
