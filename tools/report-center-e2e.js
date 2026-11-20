/* ==========================================================================
   report-center-e2e.js —— 数据中心 · 报表中心端到端验证（真实浏览器 + 真实 MySQL）
   --------------------------------------------------------------------------
   验证：
     1) 菜单项「报表中心」（MNU00015）已创建、启用，挂在「数据中心」组下，地址 report-center.html；
     2) 页面分**上 / 下两区域**：检索区在上、卡片列表在下（几何量出来 search.bottom <= list.top），
        两块同宽同左、整页不出现纵向滚动条（.app-main 100vh-60px，卡片区自己滚）；
     3) 上部检索：关键词 + 分类 + 查询 / 重置 在同一行、控件基线对齐；**没有状态下拉**；
     4) 下部卡片：1440 宽下第一行 3 列、卡片等宽等高；卡片内容（名称 / 编码 / 启用 / 分类 / 纸张 /
        说明 / 数据源 / 列数参数 / 调用 / 最近运行 / 查看）齐全；
     5) 检索：关键词、分类、重置都生效；**停用的报表查不到**（走空态）；
     6) 点卡片 → 打开共享查看窗（标题 / 参数 / 执行 / 结果表 / 打印导出），与设计器同一套 DOM；
     7) 窄屏 900px → 卡片变 2 列；
     8) 结束后删除自己建的测试报表（不动别人的数据）。
   前置：后端 8808 已启动、本机 MySQL 可连，且 dbinfomgr 里有一条启用中的 MySQL 连接。
   运行：NODE_PATH=<node_modules> node tools/report-center-e2e.js [账号] [密码]
   ========================================================================== */
'use strict';
var puppeteer = require('puppeteer-core');

var EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
var BASE = 'http://127.0.0.1:8808';
var KEY = 'menu_admin_login_v1';
var ACCOUNT = process.argv[2] || '15724887807';
var PASSWORD = process.argv[3] || '888888';
var TAG = '__报表中心e2e';
var CAT_A = '__中心甲';
var CAT_B = '__中心乙';
var MADE = [];                       // 自己建的报表 id，最后统一删掉

var pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function finish() {
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}

(async function main() {
    var browser = await puppeteer.launch({
        executablePath: EDGE, headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,1000']
    });
    var page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    var pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(e.message); console.log('    [pageerror] ' + e.message); });

    /* ---------- 0. 登录 ---------- */
    console.log('\n--- 0. 登录 ---');
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
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
    }, ACCOUNT, PASSWORD);
    check('登录成功（账号 ' + ACCOUNT + '）', /^[0-9a-f]{32}$/.test(token), token.slice(0, 8));
    if (!token) { await browser.close(); return finish(); }

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
            expireAt: now + 8 * 3600 * 1000, ttlHours: 8, user: { account: 'e2e', empName: '报表测试' }
        }));
    }, KEY, token);

    /* ---------- 1. 菜单项 ---------- */
    console.log('\n--- 1. 菜单项「报表中心」---');
    var menu = await page.evaluate(async function (tk) {
        var res = await fetch('/api/menu/list?keyword=' + encodeURIComponent('报表中心'),
            { headers: { 'X-Token': tk } });
        var body = await res.json();
        var rows = ((body.data || {}).list) || [];
        return rows.map(function (r) {
            return { id: r.id, code: r.code, nameCn: r.nameCn, path: r.path, enabled: r.enabled,
                     groupId: r.menuGroupId, groupName: r.groupName || '' };
        });
    }, token);
    var mi = menu.filter(function (r) { return r.nameCn === '报表中心'; })[0] || {};
    check('菜单里有「报表中心」', !!mi.id, JSON.stringify(menu).slice(0, 120));
    check('菜单编码是 MNU00015', mi.code === 'MNU00015', String(mi.code));
    check('指向 report-center.html', mi.path === 'report-center.html', String(mi.path));
    check('菜单处于启用状态', mi.enabled === true || Number(mi.enabled) === 1, String(mi.enabled));

    /* ---------- 2. 造几张报表（含 1 张停用） ---------- */
    console.log('\n--- 2. 准备测试报表 ---');
    var conn = await page.evaluate(async function (tk) {
        var res = await fetch('/api/dbinfo/list?pageNum=1&pageSize=200', { headers: { 'X-Token': tk } });
        var body = await res.json();
        var rows = ((body.data || {}).list) || [];
        for (var i = 0; i < rows.length; i++) {
            var on = rows[i].enabled === true || Number(rows[i].enabled) === 1;
            if (on && /mysql/i.test(String(rows[i].dbType || rows[i].type || ''))) {
                return { id: rows[i].id, name: rows[i].name,
                         database: rows[i].dbName || rows[i].databaseName || '' };
            }
        }
        return null;
    }, token);
    check('找到一条启用中的 MySQL 连接', !!conn && !!conn.id, JSON.stringify(conn).slice(0, 120));
    /* 演示库固定是 rogerorm：连接本身没填默认库时显式指定，否则 SQL 会报「没选库」 */
    var DEMO_DB = (conn && conn.database) || 'rogerorm';

    var created = await page.evaluate(async function (tk, opt) {
        var out = [];
        async function add(payload) {
            var res = await fetch('/api/report/add', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': tk },
                body: JSON.stringify(payload)
            });
            var body = await res.json();
            return (body.data || {}).id || '';
        }
        for (var i = 1; i <= 5; i++) {
            var id = await add({
                reportName: opt.tag + ' ' + i, category: (i <= 3 ? opt.catA : opt.catB),
                connId: opt.connId, databaseName: opt.database, mainTable: 'empinfos',
                sqlText: 'SELECT `code`, `nameCn` FROM `empinfos`',
                description: '报表中心端到端用例临时报表 ' + i,
                columns: [
                    { field: 'code', label: '工号', width: 120, align: 'left' },
                    { field: 'nameCn', label: '姓名', width: 120, align: 'center' }
                ],
                params: [{ name: 'kw', label: '关键字', type: 'string', control: 'text',
                           required: false, defaultValue: '' }],
                enabled: true
            });
            if (id) { out.push(id); }
        }
        /* 一张停用的：用来验证报表中心查不到 */
        var offId = await add({
            reportName: opt.tag + ' 停用版', category: opt.catA,
            connId: opt.connId, databaseName: opt.database, mainTable: 'empinfos',
            sqlText: 'SELECT `code`, `nameCn` FROM `empinfos`',
            description: '这条是停用的，不该出现在报表中心',
            columns: [{ field: 'code', label: '工号', width: 120 }],
            enabled: false
        });
        if (offId) { out.push(offId); }
        return out;
    }, token, { tag: TAG, catA: CAT_A, catB: CAT_B, connId: (conn || {}).id, database: DEMO_DB });
    MADE = created.slice();
    check('新建 6 张测试报表（5 张启用 + 1 张停用）', created.length === 6, JSON.stringify(created).slice(0, 120));

    /* ---------- 3. 打开页面 + 首屏几何 ---------- */
    console.log('\n--- 3. 打开页面：上检索 / 下列表 ---');
    await page.goto(BASE + '/report-center.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rcGrid .rc-card', { timeout: 8000 });
    await sleep(600);

    /* 后端中心接口给出的「启用报表」张数 —— 页面上第一页卡片数应与它一致 */
    var expect = await page.evaluate(async function (tk) {
        var res = await fetch('/api/report/center?pageNum=1&pageSize=12', { headers: { 'X-Token': tk } });
        var body = await res.json();
        var d = body.data || {}, rows = d.list || [];
        return {
            total: d.total, n: rows.length,
            allEnabled: rows.every(function (r) { return r.enabled === true || Number(r.enabled) === 1; })
        };
    }, token);
    check('中心接口只返回启用报表', expect.allEnabled === true, JSON.stringify(expect).slice(0, 120));

    var geo = await page.evaluate(function () {
        function rect(sel) {
            var el = document.querySelector(sel);
            if (!el) { return null; }
            var r = el.getBoundingClientRect();
            return { top: r.top, left: r.left, bottom: r.bottom, right: r.right,
                     width: r.width, height: r.height };
        }
        var cards = [].slice.call(document.querySelectorAll('#rcGrid .rc-card')).map(function (c) {
            var r = c.getBoundingClientRect();
            return { top: Math.round(r.top), left: Math.round(r.left),
                     width: Math.round(r.width), height: Math.round(r.height),
                     code: c.getAttribute('data-code'), name: (c.querySelector('.rc-card__name') || {}).textContent };
        });
        var listEl = document.querySelector('#rcList');
        return {
            head: rect('#pageHead'), search: rect('#rcSearch'), list: rect('#rcList'),
            pager: rect('#rcPager'), kw: rect('#rcKeyword'), btn: rect('#btnRcSearch'),
            cards: cards,
            docScroll: document.documentElement.scrollHeight, winH: window.innerHeight,
            listClientH: listEl ? listEl.clientHeight : 0,
            listScrollH: listEl ? listEl.scrollHeight : 0,
            scrollTag: (document.scrollingElement || document.documentElement).scrollTop
        };
    });
    check('检索区存在且在上、卡片列表在下',
        !!geo.search && !!geo.list && geo.search.bottom <= geo.list.top + 1,
        (geo.search || {}).bottom + ' / ' + (geo.list || {}).top);
    check('标题在检索区上面', geo.head.bottom <= geo.search.top + 1,
        geo.head.bottom + ' / ' + geo.search.top);
    check('检索区与卡片列表同宽同左（一列上下叠）',
        Math.abs(geo.search.left - geo.list.left) <= 1 && Math.abs(geo.search.width - geo.list.width) <= 1,
        geo.search.left + '/' + geo.list.left + ' · ' + geo.search.width + '/' + geo.list.width);
    check('整页不出现纵向滚动条（卡片区自己滚）',
        geo.docScroll <= geo.winH + 2, geo.docScroll + ' > ' + geo.winH);
    check('卡片列表占满剩余页高（> 200px）', geo.list.height > 200, String(Math.round(geo.list.height)));
    check('分页条在列表下面', !geo.pager || geo.pager.top >= geo.list.bottom - 2,
        geo.pager ? geo.pager.top + ' / ' + geo.list.bottom : '无分页条（未溢出）');

    /* ---------- 4. 卡片网格 ---------- */
    console.log('\n--- 4. 卡片网格 ---');
    check('卡片张数与后端「启用报表」第一页一致', geo.cards.length === expect.n,
        geo.cards.length + ' vs ' + expect.n + '（total ' + expect.total + '）');
    check('至少渲染出自己建的 5 张启用报表', geo.cards.length >= 5, String(geo.cards.length));
    check('停用的那张没有出现',
        !geo.cards.some(function (c) { return /停用版/.test(String(c.name)); }),
        JSON.stringify(geo.cards.map(function (c) { return c.name; })).slice(0, 160));
    var firstTop = geo.cards.length ? geo.cards[0].top : 0;
    var row1 = geo.cards.filter(function (c) { return Math.abs(c.top - firstTop) <= 1; });
    check('1440 宽下第一行 3 列', row1.length === 3, String(row1.length));
    check('第一行三张卡片左边界依次递增',
        row1.length === 3 && row1[0].left < row1[1].left && row1[1].left < row1[2].left,
        row1.map(function (c) { return c.left; }).join(','));
    var w = geo.cards.map(function (c) { return c.width; });
    check('卡片等宽（±1px）', Math.max.apply(null, w) - Math.min.apply(null, w) <= 1,
        Math.min.apply(null, w) + ' ~ ' + Math.max.apply(null, w));
    var h1 = row1.map(function (c) { return c.height; });
    check('同一行卡片等高（±1px）',
        h1.length > 1 && Math.max.apply(null, h1) - Math.min.apply(null, h1) <= 1,
        h1.join(','));
    check('卡片宽度约占内容区 1/3（280~480px）',
        geo.cards.length > 0 && geo.cards[0].width > 280 && geo.cards[0].width < 480,
        String(geo.cards.length ? geo.cards[0].width : 0));

    /* ---------- 5. 检索区控件对齐 ---------- */
    console.log('\n--- 5. 检索区 ---');
    var kwMid = (geo.kw.top + geo.kw.bottom) / 2, btnMid = (geo.btn.top + geo.btn.bottom) / 2;
    check('关键词输入框与「查询」按钮垂直居中对齐（±2px）', Math.abs(kwMid - btnMid) <= 2,
        kwMid.toFixed(1) + ' / ' + btnMid.toFixed(1));
    check('「查询」按钮在关键词输入框右侧', geo.btn.left > geo.kw.right - 1,
        geo.btn.left + ' / ' + geo.kw.right);
    var sel = await page.evaluate(function () {
        return {
            selects: document.querySelectorAll('#rcSearch select').length,
            catOptions: [].map.call(document.querySelectorAll('#rcCategory option'), function (o) { return o.value; }),
            tip: (document.querySelector('#rcSearch .rc-search__tip') || {}).textContent || ''
        };
    });
    check('检索区只有 1 个下拉（分类，没有状态下拉）', sel.selects === 1, String(sel.selects));
    check('分类下拉含两个测试分类',
        sel.catOptions.indexOf(CAT_A) >= 0 && sel.catOptions.indexOf(CAT_B) >= 0,
        sel.catOptions.join(',').slice(0, 120));
    check('说明文案写明只显示启用状态的报表', /启用/.test(sel.tip), sel.tip.replace(/\s+/g, ' ').slice(0, 40));

    /* ---------- 6. 检索 ---------- */
    console.log('\n--- 6. 关键词 / 分类 / 重置 ---');
    async function search(kw, cat) {
        await page.evaluate(function (k, c) {
            var $kw = document.getElementById('rcKeyword');
            $kw.value = k;
            document.getElementById('rcCategory').value = c || '';
            document.getElementById('btnRcSearch').click();
        }, kw, cat || '');
        await sleep(700);
        return page.evaluate(function () {
            var cards = [].slice.call(document.querySelectorAll('#rcGrid .rc-card'));
            return {
                n: cards.length,
                names: cards.map(function (c) { return (c.querySelector('.rc-card__name') || {}).textContent; }),
                total: (document.getElementById('rcTotal') || {}).textContent,
                emptyHidden: (document.getElementById('rcEmpty') || {}).hidden,
                emptyTitle: ((document.querySelector('#rcEmpty .rc-empty__title') || {}).textContent || '')
            };
        });
    }
    var r1 = await search(TAG);
    check('按关键词搜到 5 张启用报表', r1.n === 5, r1.n + ' → ' + r1.names.join(','));
    check('右上角总数同步为 5', String(r1.total) === '5', String(r1.total));

    var r2 = await search(TAG, CAT_B);
    check('按分类筛选（乙组 2 张）', r2.n === 2, r2.n + ' → ' + r2.names.join(','));

    var r3 = await search(TAG + ' 停用版');
    check('停用的报表搜不到（0 张）', r3.n === 0, String(r3.n));
    check('走空态提示「没有匹配的报表」', r3.emptyHidden === false && /没有匹配/.test(r3.emptyTitle),
        r3.emptyHidden + ' / ' + r3.emptyTitle);

    await page.evaluate(function () { document.getElementById('btnRcReset').click(); });
    await sleep(700);
    var r4 = await page.evaluate(function () {
        return {
            n: document.querySelectorAll('#rcGrid .rc-card').length,
            kw: document.getElementById('rcKeyword').value,
            cat: document.getElementById('rcCategory').value
        };
    });
    check('重置清空关键词与分类', r4.kw === '' && r4.cat === '', r4.kw + ' / ' + r4.cat);
    check('重置后恢复全部启用报表', r4.n >= 5, String(r4.n));

    /* ---------- 7. 双击卡片 → 查看窗 ---------- */
    console.log('\n--- 7. 双击卡片打开查看窗 ---');
    var r5 = await search(TAG);
    check('再次按关键词定位到测试报表', r5.n === 5, String(r5.n));
    await page.click('#rcGrid .rc-card');                          // 单击：不该有任何反应
    await sleep(600);
    check('单击卡片不会打开查看窗（防误操作）',
        (await page.$('.el-overlay .el-dialog')) === null);
    /* 真双击：同一坐标连发两次 down/up（第二次 clickCount=2），浏览器才会派发 dblclick */
    var cardBox = await (await page.$('#rcGrid .rc-card')).boundingBox();
    var cx = cardBox.x + cardBox.width / 2, cy = cardBox.y + cardBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
    await page.waitForSelector('.el-overlay .el-dialog', { timeout: 6000 });
    await sleep(1200);
    var dlg = await page.evaluate(function () {
        var d = [].slice.call(document.querySelectorAll('.el-overlay .el-dialog')).pop();
        if (!d) { return null; }
        function vis(sel) {
            var el = d.querySelector(sel);
            if (!el) { return false; }
            var r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }
        var body = d.querySelector('.el-dialog__body');
        return {
            title: (d.querySelector('.el-dialog__title') || {}).textContent || '',
            pvTitle: (d.querySelector('#pvTitle') || {}).textContent || '',
            hasParamInput: (d.querySelectorAll('#pvParams input').length) > 0,
            runVisible: vis('#pvRun'),
            printVisible: vis('#pvPrint'),
            pdfVisible: vis('#pvPdf'),
            xlsxVisible: vis('#pvXlsx'),
            rows: d.querySelectorAll('#pvTableWrap table.rpt-pv__table tbody tr').length,
            head: (d.querySelector('#pvTableWrap table thead') || {}).textContent || '',
            foot: (d.querySelector('#pvFooter') || {}).textContent || '',
            width: Math.round(d.getBoundingClientRect().width),
            isMax: d.classList.contains('is-max'),
            maxBtnTitle: ((d.querySelector('.el-dialog__headerbtn--max') || {}).title) || '',
            /* 纸张自适应：纸张宽度应当铺满正文区（以前锁 820px 居中，右侧留白） */
            paperW: Math.round((d.querySelector('#pvPaper') || { getBoundingClientRect: function () { return { width: 0 }; } })
                .getBoundingClientRect().width),
            bodyW: Math.round((body || { getBoundingClientRect: function () { return { width: 0 }; } })
                .getBoundingClientRect().width),
            /* 纸张可用的实际宽度：正文 → 滚动容器（去掉 body padding 与滚动条） */
            scrollW: (function () {
                var sc = d.querySelector('.rpt-pv__scroll');
                if (!sc) { return 0; }
                var cs = window.getComputedStyle(sc);
                return Math.round(sc.getBoundingClientRect().width -
                    parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0));
            })(),
            inViewport: (function () {
                var r = d.getBoundingClientRect();
                return r.left >= -2 && r.top >= -2 &&
                    r.right <= window.innerWidth + 2 && r.bottom <= window.innerHeight + 2;
            })()
        };
    });
    check('弹出了查看窗', !!dlg, '没有弹窗');
    check('查看窗打开即最大化（is-max + 按钮显示还原）',
        !!dlg && dlg.isMax === true && dlg.maxBtnTitle === '还原',
        ((dlg || {}).isMax) + ' / ' + ((dlg || {}).maxBtnTitle));
    check('预览纸张宽度铺满可视区（不再锁 820px 居中）',
        !!dlg && dlg.scrollW > 0 && dlg.paperW >= dlg.scrollW - 6 && dlg.paperW > 900,
        JSON.stringify({ paperW: (dlg || {}).paperW, scrollW: (dlg || {}).scrollW,
                         bodyW: (dlg || {}).bodyW }));
    check('标题为「查看报表 —— …」', /^查看报表 —— /.test((dlg || {}).title || ''), (dlg || {}).title);
    check('查看窗里显示报表名', !!dlg && /报表中心e2e/.test(dlg.pvTitle), (dlg || {}).pvTitle);
    check('参数区有输入控件', !!dlg && dlg.hasParamInput);
    check('有「执行查询」按钮且可见', !!dlg && dlg.runVisible);
    check('结果表有列头（工号 / 姓名）',
        !!dlg && /工号/.test(dlg.head) && /姓名/.test(dlg.head), (dlg || {}).head);
    check('结果表按真实 SQL 查出数据行', !!dlg && dlg.rows >= 1, String((dlg || {}).rows));
    check('页脚给出总行数', !!dlg && /共\s*\d+\s*行/.test(dlg.foot),
        ((dlg || {}).foot || '').replace(/\s+/g, ' '));
    check('打印 / 导出 PDF / 导出 Excel 三个按钮都可见',
        !!dlg && dlg.printVisible && dlg.pdfVisible && dlg.xlsxVisible,
        [dlg && dlg.printVisible, dlg && dlg.pdfVisible, dlg && dlg.xlsxVisible].join(','));
    check('查看窗在视口内（宽度不超出）', !!dlg && dlg.inViewport && dlg.width <= 1440,
        (dlg || {}).width);

    await page.evaluate(function () {
        var btns = [].slice.call(document.querySelectorAll('.el-overlay .el-dialog__headerbtn'));
        var close = btns.filter(function (b) { return b.className.indexOf('--max') < 0; }).pop();
        if (close) { close.click(); }
    });
    await sleep(500);
    var overlays = await page.evaluate(function () {
        return document.querySelectorAll('.el-overlay').length;
    });
    check('关掉查看窗', overlays === 0, String(overlays));

    /* ---------- 8. 窄屏：2 列 ---------- */
    console.log('\n--- 8. 窄屏 900px → 2 列 ---');
    await page.evaluate(function () { document.getElementById('btnRcReset').click(); });
    await sleep(700);
    await page.setViewport({ width: 900, height: 1000 });
    await page.mouse.move(0, 0);                 // 鼠标别停在卡片上（hover 会把卡片抬起 2px）
    await sleep(1200);
    var narrow = await page.evaluate(function () {
        var cards = [].slice.call(document.querySelectorAll('#rcGrid .rc-card')).map(function (c) {
            var r = c.getBoundingClientRect();
            return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) };
        });
        var firstTop = cards.length ? cards[0].top : 0;
        /* 同一行 = top 相差 4px 以内（hover / 亚像素会让 1~2px 出入） */
        var row1 = cards.filter(function (c) { return Math.abs(c.top - firstTop) <= 4; });
        return { n: cards.length, row1: row1.length, lefts: row1.map(function (c) { return c.left; }),
                 widths: cards.map(function (c) { return c.width; }) };
    });
    check('900 宽下第一行 2 列', narrow.row1 === 2,
        narrow.row1 + '（共 ' + narrow.n + ' 张，第一行 left=' + narrow.lefts.join(',') +
        ' 宽=' + narrow.widths.slice(0, 3).join(',') + '）');
    check('窄屏卡片变宽（接近一半）', narrow.widths.length > 0 &&
        narrow.widths[0] > 300 && narrow.widths[0] < 460, String(narrow.widths[0]));

    await page.setViewport({ width: 1440, height: 1000 });
    await sleep(400);

    /* ---------- 9. 没有 JS 报错 ---------- */
    console.log('\n--- 9. 控制台 ---');
    check('页面没有 JS 异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 160));

    /* ---------- 10. 清理 ---------- */
    console.log('\n--- 10. 清理测试数据 ---');
    var left = await page.evaluate(async function (tk, ids) {
        var bad = [];
        for (var i = 0; i < ids.length; i++) {
            var res = await fetch('/api/report/delete', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': tk },
                body: JSON.stringify({ id: ids[i] })
            });
            var body = await res.json();
            if (body.code !== 0) { bad.push(ids[i] + ':' + (body.message || '')); }
        }
        return bad;
    }, token, MADE);
    check('删掉全部测试报表', left.length === 0, left.join(' | ').slice(0, 160));

    await browser.close();
    finish();
})().catch(function (e) {
    console.log('\n[异常] ' + (e && e.stack || e));
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(1);
});
