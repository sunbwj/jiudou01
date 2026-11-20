/* ==========================================================================
   dbinfo-e2e.js —— 数据中心 · 数据库连接端到端验证（真实浏览器 + 真实 MySQL）
   --------------------------------------------------------------------------
   验证：
     1) 登录后接口里存在菜单项「数据库」并挂在「数据中心」组下；
     2) 以 iframe 子页打开 dbinfo.html，**左 / 中 / 右三栏**布局成立（几何量出来左栏在中栏左边、
        中栏在右栏左边，三栏高度一致、整页不出现滚动条，各栏内部自己滚）；
        左栏 8 个操作按钮**只显示图标**（按钮无文字、svg 可见、title 有文案）；
     3) 右栏是**标签页**：字段明细 / 数据 / SQL 工作台，默认字段明细；切到 SQL 后编辑器与结果区都完整可见；
     4) 接口新增一条指向本机 MySQL 的连接后，左侧列表能看到它；
     5) **双击连接** → 真实连库扫描出实例（库）→ 自动展开首个实例的表 / 视图
        → SQL 标签页的实例下拉同步填充；
     6) 表 / 视图节点**单击不加载**（防误操作）：字段明细、数据页、SQL 编辑器都不变；
     6.1) **双击表** → 字段明细 / 数据 / SQL 三个标签一起刷新（标签不硬跳），真实读出一页数据、列头点击排序、
         按列筛选（条件以标签展示、可移除）、表头 sticky 固定（滚动数据时列标题不动）、
         同时 SQL 编辑器被赋值 SELECT * FROM 库.表；
     7) SQL 工作台：执行真实查询能看到结果表；写语句被拒绝并给出提示；
     7) 结束后删除测试连接（只删自己建的那条）。
   前置：后端 8808 已启动、本机 MySQL 可连（sa/roger2019）。
   运行：NODE_PATH=<node_modules> node tools/dbinfo-e2e.js [账号] [密码]
   ========================================================================== */
'use strict';
var puppeteer = require('puppeteer-core');

var EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
var BASE = 'http://127.0.0.1:8808';
var KEY = 'menu_admin_login_v1';
var ACCOUNT = process.argv[2] || '15724887807';
var PASSWORD = process.argv[3] || '888888';
var CONN_NAME = '__dbinfo_e2e__';

var pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function main() {
    var browser = await puppeteer.launch({
        executablePath: EDGE, headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,1000']
    });
    var page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    page.on('pageerror', function (e) { console.log('    [pageerror] ' + e.message); });

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
            expireAt: now + 8 * 3600 * 1000, ttlHours: 8, user: { account: 'e2e', empName: '数据中心测试' }
        }));
    }, KEY, token);

    /* ---------- 1. 菜单数据（不依赖当前账号的授权） ---------- */
    console.log('\n--- 1. 菜单项 / 菜单组数据 ---');
    await page.goto(BASE + '/main.html', { waitUntil: 'domcontentloaded' });
    await sleep(1800);
    var menuInfo = await page.evaluate(async function (tk) {
        function call(path, body) {
            return fetch(path, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({ token: tk }, body || {}))
            }).then(function (r) { return r.json(); });
        }
        var items = await call('/api/menu/list', { pageNum: 1, pageSize: 200 });
        var groups = await fetch('/api/group/list?pageNum=1&pageSize=200&token=' + tk)
            .then(function (r) { return r.json(); });
        var found = null, i;
        var list = ((items.data || {}).list) || [];
        for (i = 0; i < list.length; i++) {
            if (String(list[i].path) === 'dbinfo.html') { found = list[i]; }
        }
        var group = null;
        var glist = ((groups.data || {}).list) || [];
        for (i = 0; i < glist.length; i++) {
            if (String(glist[i].code) === 'MNG1005') { group = glist[i]; }
        }
        var binds = found && group ? await fetch('/api/groupitem/list?groupId=' + group.id +
            '&pageSize=200&token=' + tk).then(function (r) { return r.json(); }) : null;
        var bound = false;
        var blist = ((binds || {}).data || {}).list || [];
        for (i = 0; i < blist.length; i++) {
            if (String(blist[i].itemId) === String(found.id)) { bound = true; }
        }
        return {
            item: found ? { code: found.code, nameCn: found.nameCn, path: found.path, enabled: found.enabled } : null,
            group: group ? { code: group.code, nameCn: group.nameCn, sortNo: group.sortNo } : null,
            bound: bound
        };
    }, token);
    check('菜单项「数据库」已创建且启用',
        !!menuInfo.item && menuInfo.item.nameCn === '数据库' &&
        menuInfo.item.path === 'dbinfo.html' && menuInfo.item.enabled === true,
        JSON.stringify(menuInfo.item));
    check('挂在「数据中心」菜单组下（MNG1005，sortNo=50）',
        !!menuInfo.group && menuInfo.group.nameCn === '数据中心' && Number(menuInfo.group.sortNo) === 50,
        JSON.stringify(menuInfo.group));
    check('菜单组与菜单项已绑定', menuInfo.bound === true, String(menuInfo.bound));

    // 当前测试账号不一定有数据中心的授权，直接按 hash 打开该页
    await page.goto(BASE + '/main.html#dbinfo.html', { waitUntil: 'domcontentloaded' });
    await sleep(2800);

    var frame = null;
    for (var i = 0; i < 30 && !frame; i++) {
        frame = page.frames().filter(function (f) {
            return f !== page.mainFrame() && /dbinfo\.html$/.test(f.url());
        })[0] || null;
        if (!frame) { await sleep(200); }
    }
    check('以 iframe 子页加载 dbinfo.html', !!frame, frame ? frame.url() : 'none');
    if (!frame) { await browser.close(); return finish(); }

    /* ---------- 1.1 三栏布局：结构与几何 ---------- */
    console.log('\n--- 1.1 左 / 中 / 右三栏布局 ---');
    var struct = await frame.evaluate(function () {
        function box(sel) {
            var el = document.querySelector(sel);
            if (!el) { return null; }
            var r = el.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width),
                     h: Math.round(r.height), bottom: Math.round(r.bottom) };
        }
        function scrollable(sel) {
            var el = document.querySelector(sel);
            if (!el) { return false; }
            var oy = getComputedStyle(el).overflowY;
            return oy === 'auto' || oy === 'scroll';
        }
        return {
            title: (document.querySelector('.page-head__title') || {}).innerText || '',
            crumb: (document.querySelector('#pageHead') || {}).getAttribute('data-crumb') || '',
            buttons: ['btnAdd', 'btnEdit', 'btnEnable', 'btnDisable', 'btnTest', 'btnScan', 'btnDelete', 'btnRefresh']
                .filter(function (id) { return !!document.getElementById(id); }).length,
            // 8 个操作按钮：只显示图标 → 文字为空、每个都有 svg、都有 title
            iconButtons: (function () {
                var list = [].slice.call(document.querySelectorAll('.db-toolbar button'));
                return {
                    total: list.length,
                    withText: list.filter(function (b) { return (b.innerText || '').trim() !== ''; }).length,
                    withSvg: list.filter(function (b) { return !!b.querySelector('svg'); }).length,
                    withTitle: list.filter(function (b) { return !!b.getAttribute('title'); }).length,
                    maxW: Math.max.apply(null, list.map(function (b) {
                        return Math.round(b.getBoundingClientRect().width);
                    }))
                };
            })(),
            // 右栏标签页
            tabCount: document.querySelectorAll('#dbTabs .el-tabs__item').length,
            tabTexts: [].map.call(document.querySelectorAll('#dbTabs .el-tabs__item'), function (t) {
                return (t.innerText || '').replace(/\s+/g, '');
            }),
            colsActive: (function () {
                var p = document.querySelector('.el-tab-pane[data-pane="cols"]');
                return !!p && getComputedStyle(p).display !== 'none';
            })(),
            sqlActive: (function () {
                var p = document.querySelector('.el-tab-pane[data-pane="sql"]');
                return !!p && getComputedStyle(p).display !== 'none';
            })(),
            left: box('.db-pane--left'),
            mid: box('.db-pane--mid'),
            right: box('.db-pane--right'),
            stacked: !!document.querySelector('.db-page.is-stacked'),
            treeEmpty: /双击/.test((document.getElementById('dbTree') || {}).innerText || ''),
            colsEmpty: /字段名/.test((document.getElementById('dbColsBody') || {}).innerText || ''),
            listScrollable: scrollable('#dbList'),
            pageOverflow: document.documentElement.scrollHeight - window.innerHeight,
            viewW: window.innerWidth, viewH: window.innerHeight
        };
    });
    check('页面标题与面包屑正确（数据库 / 数据中心/数据库）',
        struct.title === '数据库' && struct.crumb === '数据中心/数据库',
        struct.title + ' / ' + struct.crumb);
    check('8 个操作按钮都在（新增/编辑/启用/停用/测试/扫描/删除/刷新）', struct.buttons === 8,
        String(struct.buttons));
    check('操作按钮只显示图标：无文字 / 都有 svg / 都有 title / 宽度不超过 36px',
        struct.iconButtons.total === 8 && struct.iconButtons.withText === 0 &&
        struct.iconButtons.withSvg === 8 && struct.iconButtons.withTitle === 8 &&
        struct.iconButtons.maxW <= 36, JSON.stringify(struct.iconButtons));
    check('当前宽度下是「左中右」三栏（未被压缩成上下堆叠）', struct.stacked === false,
        'stacked=' + struct.stacked + ' view=' + struct.viewW + 'x' + struct.viewH);
    check('三栏从左到右排列：左栏 → 中栏 → 右栏',
        !!struct.left && !!struct.mid && !!struct.right &&
        struct.left.x + struct.left.w <= struct.mid.x + 1 &&
        struct.mid.x + struct.mid.w <= struct.right.x + 1,
        JSON.stringify([struct.left && struct.left.x, struct.mid && struct.mid.x, struct.right && struct.right.x]));
    check('左栏固定窄栏、中栏中等宽、右栏吃掉剩余宽度',
        struct.left.w <= 300 && struct.mid.w >= 340 && struct.right.w > struct.mid.w,
        struct.left.w + ' / ' + struct.mid.w + ' / ' + struct.right.w);
    check('三栏等高且同一顶端', struct.left.y === struct.mid.y && struct.mid.y === struct.right.y &&
        Math.abs(struct.left.h - struct.mid.h) <= 1 && Math.abs(struct.mid.h - struct.right.h) <= 1,
        struct.left.y + ',' + struct.left.h + ' / ' + struct.mid.h + ' / ' + struct.right.h);
    check('右栏是标签页：三个标签「字段明细」「数据」「SQL 工作台」',
        struct.tabCount === 3 && /字段明细/.test(struct.tabTexts[0]) &&
        /数据/.test(struct.tabTexts[1]) && /SQL/.test(struct.tabTexts[2]),
        JSON.stringify(struct.tabTexts));
    check('默认显示「字段明细」、SQL 标签页收起',
        struct.colsActive === true && struct.sqlActive === false,
        'cols=' + struct.colsActive + ' / sql=' + struct.sqlActive);
    check('整页不出现纵向滚动条（滚动都留在各栏内部）', struct.pageOverflow <= 2,
        String(struct.pageOverflow));
    check('左栏列表内部可滚动', struct.listScrollable === true, String(struct.listScrollable));
    check('中栏初始为空态、右栏字段明细有提示',
        struct.treeEmpty === true && struct.colsEmpty === true);

    // 切到「SQL 工作台」标签页，量编辑器 / 结果区的几何
    await frame.evaluate(function () {
        window.jQuery('#dbTabs .el-tabs__item[data-tab="sql"]').trigger('click');
    });
    await sleep(700);
    var sqlPane = await frame.evaluate(function () {
        function box(sel) {
            var el = document.querySelector(sel);
            if (!el) { return null; }
            var r = el.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width),
                     h: Math.round(r.height), bottom: Math.round(r.bottom) };
        }
        function visible(sel) {
            var el = document.querySelector(sel);
            if (!el) { return false; }
            return getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
        }
        function scrollable(sel) {
            var el = document.querySelector(sel);
            if (!el) { return false; }
            var oy = getComputedStyle(el).overflowY;
            return oy === 'auto' || oy === 'scroll';
        }
        return {
            sqlActive: visible('.el-tab-pane[data-pane="sql"]'),
            colsActive: visible('.el-tab-pane[data-pane="cols"]'),
            bar: box('.db-sql__bar'),
            textarea: box('#sqlText'),
            runBtn: box('#btnSqlRun'),
            resultBox: box('.db-result'),
            resultBody: box('#sqlResult'),
            right: box('.db-pane--right'),
            resultScrollable: scrollable('#sqlResult'),
            pageOverflow: document.documentElement.scrollHeight - window.innerHeight
        };
    });
    check('点「SQL 工作台」后该标签页显示、字段明细收起',
        sqlPane.sqlActive === true && sqlPane.colsActive === false,
        'sql=' + sqlPane.sqlActive + ' / cols=' + sqlPane.colsActive);
    check('SQL 标签页里：工具条在上、编辑器居中、执行结果在下',
        !!sqlPane.bar && sqlPane.bar.y >= sqlPane.right.y &&
        sqlPane.textarea.y >= sqlPane.bar.bottom - 1 &&
        sqlPane.resultBox.y >= sqlPane.textarea.bottom - 1 &&
        sqlPane.resultBox.bottom <= sqlPane.right.bottom + 1,
        JSON.stringify([sqlPane.bar && sqlPane.bar.y, sqlPane.textarea.y,
                        sqlPane.resultBox.y, sqlPane.right.bottom]));
    check('SQL 编辑区高度够用（≥100px）、执行按钮可见可点',
        sqlPane.textarea.h >= 100 && sqlPane.runBtn.w > 30 && sqlPane.runBtn.h >= 24,
        JSON.stringify([sqlPane.textarea.h, sqlPane.runBtn.w]));
    check('执行结果区有高度且自己内部滚动', sqlPane.resultBody.h >= 80 &&
        sqlPane.resultScrollable === true, JSON.stringify(sqlPane.resultBody));
    check('切到 SQL 标签后整页仍不出滚动条', sqlPane.pageOverflow <= 2, String(sqlPane.pageOverflow));
    await frame.evaluate(function () {
        window.jQuery('#dbTabs .el-tabs__item[data-tab="cols"]').trigger('click');
    });
    await sleep(500);

    /* ---------- 2. 新增一条本机 MySQL 连接（走接口） ---------- */
    console.log('\n--- 2. 新增本机 MySQL 连接 ---');
    var created = await frame.evaluate(async function (tk, name) {
        function call(path, body) {
            return fetch(path, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({ token: tk }, body || {}))
            }).then(function (r) { return r.json(); });
        }
        var old = await fetch('/api/dbinfo/list?keyword=' + encodeURIComponent(name) + '&token=' + tk)
            .then(function (r) { return r.json(); });
        var rows = ((old.data || {}).list) || [];
        for (var i = 0; i < rows.length; i++) { await call('/api/dbinfo/delete', { id: rows[i].id }); }
        var res = await call('/api/dbinfo/add', {
            name: name, dbType: 'mysql', host: '127.0.0.1', port: 3306, dbName: 'rogerorm',
            username: 'sa', password: 'roger2019', charset: 'utf8mb4', enabled: 1, remark: 'e2e 测试，可删'
        });
        return { code: res.code, id: ((res.data || {}).id) || '', message: res.message,
                 ispub: (res.data || {}).ispub, ispubText: (res.data || {}).ispubText,
                 createempinfosid: (res.data || {}).createempinfosid };
    }, token, CONN_NAME);
    check('接口新增连接成功', created.code === 0 && !!created.id, created.message);
    check('新增时不传 ispub → 默认公用（ispub=1 / 「公用」）',
        created.ispub === true && created.ispubText === '公用',
        String(created.ispub) + ' / ' + String(created.ispubText));
    check('新增时按登录员工自动带入 createempinfosid（页面不传）',
        Number(created.createempinfosid || 0) > 0, String(created.createempinfosid));
    if (!created.id) { await browser.close(); return finish(); }

    /* ---------- 2.5 停用的连接：双击只提醒，不扫描 ---------- */
    console.log('\n--- 2.5 停用的连接双击 → 只提醒，不扫描 ---');
    async function setEnabled(on) {
        return await frame.evaluate(async function (tk, id, val) {
            var r = await fetch('/api/dbinfo/enabled', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: tk, id: id, enabled: val })
            });
            return (await r.json()).code;
        }, token, created.id, on);
    }
    check('接口把测试连接改成停用', (await setEnabled(0)) === 0);

    await frame.evaluate(function () { window.jQuery('#btnRefresh').trigger('click'); });
    await sleep(1200);
    var offClick = await frame.evaluate(function (name) {
        var $ = window.jQuery;
        var $item = $('#dbList .db-item').filter(function () { return $(this).text().indexOf(name) > -1; });
        if (!$item.length) { return { found: false, title: '' }; }
        var title = $item.attr('title') || '';
        $item.trigger('dblclick');
        return { found: true, title: title };
    }, CONN_NAME);
    check('停用的卡片 title 改成「启用后才能扫描」', /启用后才能扫描/.test(offClick.title), offClick.title);
    await sleep(900);
    var offAfter = await frame.evaluate(function () {
        function text(sel) {
            var el = document.querySelector(sel);
            return el ? (el.innerText || '').replace(/\s+/g, ' ') : '';
        }
        return {
            toast: text('.el-message-list'),
            conn: text('#dbTreeConn'),
            tree: text('#dbTree'),
            dbs: document.querySelectorAll('#dbTree .el-tree-node[data-kind="db"]').length
        };
    });
    check('双击停用连接只弹「已停用」提醒',
        /已停用/.test(offAfter.toast) && /启用/.test(offAfter.toast), offAfter.toast);
    check('没有进扫描流程：结构树仍是空态、无实例节点',
        offAfter.dbs === 0 && !/个实例/.test(offAfter.tree) && !/正在扫描/.test(offAfter.tree),
        'dbs=' + offAfter.dbs + ' / ' + offAfter.tree.slice(0, 40));
    check('没有进扫描流程：中栏没挂上这条连接', !/dbinfo_e2e/.test(offAfter.conn), offAfter.conn);

    check('接口把测试连接恢复启用', (await setEnabled(1)) === 0);

    await frame.evaluate(function () { window.jQuery('#btnRefresh').trigger('click'); });
    await sleep(1200);
    var dblClicked = await frame.evaluate(function (name) {
        var $ = window.jQuery;
        var $item = $('#dbList .db-item').filter(function () { return $(this).text().indexOf(name) > -1; });
        if (!$item.length) { return false; }
        $item.trigger('dblclick');
        return true;
    }, CONN_NAME);
    check('左侧列表找到测试连接并双击', dblClicked === true);
    await sleep(3500);

    /* ---------- 3. 结构树：实例 → 表 / 视图 ---------- */
    console.log('\n--- 3. 双击扫描：实例 / 表 / 视图 ---');
    var tree = await frame.evaluate(function () {
        function text(sel) {
            var el = document.querySelector(sel);
            return el ? (el.innerText || '').replace(/\s+/g, ' ') : '';
        }
        var sqlDb = document.getElementById('sqlDb');
        return {
            conn: text('#dbTreeConn'),
            tip: text('#dbTreeTip'),
            dbs: document.querySelectorAll('#dbTree .el-tree-node[data-kind="db"]').length,
            tables: document.querySelectorAll('#dbTree .el-tree-node[data-kind="table"]').length,
            views: document.querySelectorAll('#dbTree .el-tree-node[data-kind="view"]').length,
            hasCurrent: /当前/.test(text('#dbTree')),
            hasDbType: /库/.test(text('#dbTree')),
            sqlDbOptions: sqlDb ? sqlDb.options.length : 0,
            sqlDbText: sqlDb ? sqlDb.innerText : '',
            sqlConn: text('#sqlConnName'),
            treeOverflow: (function () {
                var el = document.getElementById('dbTree');
                return el ? el.scrollHeight - el.clientHeight : -1;
            })(),
            pageOverflow: document.documentElement.scrollHeight - window.innerHeight
        };
    });
    check('中栏显示当前连接', /dbinfo_e2e/.test(tree.conn), tree.conn);
    check('扫描出实例（库）节点（>=3 个）', tree.dbs >= 3, String(tree.dbs));
    check('实例节点带「库」徽标与「当前」标记', tree.hasDbType && tree.hasCurrent);
    check('显示扫描时间与实例总数', /\d+ 个实例/.test(tree.tip), tree.tip);
    check('自动展开实例后能看到表 / 视图', tree.tables >= 5, 'tables=' + tree.tables + ' / views=' + tree.views);
    check('SQL 标签页的实例下拉被同步填充（≥4 个选项）', tree.sqlDbOptions >= 4,
        tree.sqlDbOptions + ' / ' + tree.sqlDbText.replace(/\s+/g, ' '));
    check('右栏标签条右侧显示当前连接名', /dbinfo_e2e/.test(tree.sqlConn), tree.sqlConn);
    check('扫描后整页仍不出现滚动条', tree.pageOverflow <= 2,
        'pageOverflow=' + tree.pageOverflow + ' / treeOverflow=' + tree.treeOverflow);

    /* ---------- 4. 表 / 视图节点：单击不加载（防误操作） ---------- */
    console.log('\n--- 4. 单击表名不加载（防误操作） ---');
    await frame.evaluate(function () {
        window.jQuery('#dbTabs .el-tabs__item[data-tab="cols"]').trigger('click');
    });
    await sleep(500);
    var firstTable = await frame.evaluate(function () {
        var $ = window.jQuery;
        var $node = $('#dbTree .el-tree-node[data-kind="table"]').first();
        if (!$node.length) { return ''; }
        var name = $node.attr('data-table') || '';
        $node.children('.el-tree-node__content').trigger('click');
        return name;
    });
    await sleep(1600);
    var afterClick = await frame.evaluate(function () {
        return {
            colsRows: document.querySelectorAll('#dbColsBody .db-cols__table tbody tr').length,
            colsText: (document.getElementById('dbColsBody') || {}).innerText || '',
            rowsTitle: (document.getElementById('dbRowsTable') || {}).innerText || '',
            dataRows: document.querySelectorAll('#dbRowsGrid .db-rows__table tbody tr').length,
            sql: (document.getElementById('sqlText') || {}).value || '',
            active: document.querySelectorAll('#dbTree .el-tree-node.is-active').length,
            tab: (function () {
                var t = document.querySelector('#dbTabs .el-tabs__item.is-active');
                return t ? t.getAttribute('data-tab') : '';
            })()
        };
    });
    check('单击表「' + (firstTable || '-') + '」后：字段明细、数据、SQL 都不加载',
        afterClick.colsRows === 0 && afterClick.dataRows === 0 &&
        afterClick.rowsTitle === '未选择表' && afterClick.sql === '' &&
        afterClick.active === 0 && afterClick.tab === 'cols',
        JSON.stringify(afterClick).slice(0, 200));
    check('单击后字段明细仍是「双击…」引导文案', /双击/.test(afterClick.colsText),
        afterClick.colsText.replace(/\s+/g, ' ').slice(0, 40));

    /* ---------- 4.1 双击表 → 三个标签一起刷新 ---------- */

    /* ---------- 4.1 双击表 → 数据标签页（真实取数 / 排序 / 筛选 / 表头固定） ---------- */
    console.log('\n--- 4.1 双击表 → 字段明细 / 数据 / SQL 一起刷新 ---');
    var dblTable = await frame.evaluate(function () {
        var $ = window.jQuery;
        var $node = $('#dbTree .el-tree-node[data-kind="table"]').filter(function () {
            return /useinfo/.test($(this).text());
        }).first();
        if (!$node.length) { $node = $('#dbTree .el-tree-node[data-kind="table"]').first(); }
        if (!$node.length) { return ''; }
        var name = $node.attr('data-table') || '';
        $node.children('.el-tree-node__content').trigger('dblclick');
        return name;
    });
    await sleep(2600);
    var dataPane = await frame.evaluate(function () {
        function box(sel) {
            var el = document.querySelector(sel);
            if (!el) { return null; }
            var r = el.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width),
                     h: Math.round(r.height), bottom: Math.round(r.bottom) };
        }
        var pane = document.querySelector('.el-tab-pane[data-pane="rows"]');
        var heads = [].map.call(document.querySelectorAll('#dbRowsGrid thead th'), function (th) {
            return (th.innerText || '').replace(/\s+/g, '');
        });
        var rows = document.querySelectorAll('#dbRowsGrid tbody tr');
        return {
            active: !!pane && getComputedStyle(pane).display !== 'none',
            tabActive: (function () {
                var t = document.querySelector('#dbTabs .el-tabs__item[data-tab="rows"]');
                return !!t && t.classList.contains('is-active');
            })(),
            title: (document.getElementById('dbRowsTable') || {}).innerText || '',
            meta: (document.getElementById('dbRowsMeta') || {}).innerText || '',
            heads: heads,
            rows: rows.length,
            firstRow: rows.length ? (rows[0].innerText || '').replace(/\s+/g, ' ') : '',
            sql: (document.getElementById('sqlText') || {}).value || '',
            // 双击时字段明细也会一起刷新（虽然当前标签不是它）
            colsRows: document.querySelectorAll('#dbColsBody .db-cols__table tbody tr').length,
            colsHeads: [].map.call(document.querySelectorAll('#dbColsBody thead th'), function (th) {
                return (th.innerText || '').replace(/\s+/g, '');
            }),
            colsTitle: (document.getElementById('dbColsTitle') || {}).innerText || '',
            colsActive: (function () {
                var t = document.querySelector('#dbTabs .el-tabs__item.is-active');
                return t ? t.getAttribute('data-tab') : '';
            })(),
            grid: box('#dbRowsGrid'),
            footHidden: (document.getElementById('dbRowsFoot') || {}).hasAttribute
                ? document.getElementById('dbRowsFoot').hasAttribute('hidden') : false,
            pageOverflow: document.documentElement.scrollHeight - window.innerHeight
        };
    });
    check('双击表后不硬切标签（当前还停在「字段明细」）',
        dataPane.colsActive === 'cols' && dataPane.active === false,
        'activeTab=' + dataPane.colsActive + ' / rowsPaneShown=' + dataPane.active);
    check('① 字段明细：双击时同步刷新出该表的字段（6 列 / ≥2 行）',
        dataPane.colsRows >= 2 && dataPane.colsHeads.length === 6 &&
        dataPane.colsHeads[0] === '字段名' && dataPane.colsHeads[1] === '字段类型',
        'rows=' + dataPane.colsRows + ' / heads=' + dataPane.colsHeads.join(','));
    check('① 字段明细：标题带表名', dataPane.colsTitle.indexOf(dblTable || 'useinfo') > -1,
        dataPane.colsTitle);
    check('② 数据：标题是「库.表」', dataPane.title === 'rogerorm.' + (dblTable || 'useinfo'),
        dataPane.title);
    check('② 数据：真实读出记录（行数 > 0，表头带 # 序号列）',
        dataPane.rows >= 1 && dataPane.heads.length >= 2 && dataPane.heads[0] === '#',
        'rows=' + dataPane.rows + ' / heads=' + dataPane.heads.length);
    check('行数信息显示「已加载 N / 共 M 行」', /已加载 \d+ \/ 共 \d+ 行/.test(dataPane.meta),
        dataPane.meta);
    check('③ SQL：自动填充 SELECT * FROM 库.表（不带 LIMIT）',
        dataPane.sql === 'SELECT * FROM `rogerorm`.`' + (dblTable || 'useinfo') + '`',
        dataPane.sql.slice(0, 90));
    check('数据页不把整页撑出滚动条', dataPane.pageOverflow <= 2, String(dataPane.pageOverflow));

    // 切到「数据」标签（用户视角）：之后的表头固定 / 排序 / 筛选都在可见状态下验证
    await frame.evaluate(function () {
        window.jQuery('#dbTabs .el-tabs__item[data-tab="rows"]').trigger('click');
    });
    await sleep(700);
    var rowsTabShown = await frame.evaluate(function () {
        var pane = document.querySelector('.el-tab-pane[data-pane="rows"]');
        var grid = document.getElementById('dbRowsGrid');
        return {
            shown: !!pane && getComputedStyle(pane).display !== 'none',
            gridH: grid ? grid.clientHeight : 0,
            rows: document.querySelectorAll('#dbRowsGrid tbody tr').length
        };
    });
    check('手动切到「数据」标签后能看到已加载的记录（网格有高度）',
        rowsTabShown.shown === true && rowsTabShown.gridH > 60 && rowsTabShown.rows >= 1,
        JSON.stringify(rowsTabShown));
    check('切到「数据」标签后整页仍不出滚动条',
        (await frame.evaluate(function () {
            return document.documentElement.scrollHeight - window.innerHeight;
        })) <= 2);

    // 表头固定：把网格压矮后滚动数据，列头位置不应跟着动
    var sticky = await frame.evaluate(function () {
        var grid = document.getElementById('dbRowsGrid');
        var th = document.querySelector('#dbRowsGrid thead th');
        if (!grid || !th) { return null; }
        var oldHeight = grid.style.height, oldFlex = grid.style.flex;
        // 网格是 flex 子项（flex:1），只改 height 会被拉伸回原高，必须同时锁 flex-basis
        grid.style.flex = '0 0 80px';
        grid.style.height = '80px';
        var h = grid.clientHeight;
        var before = Math.round(th.getBoundingClientRect().top);
        grid.scrollTop = 40;
        var after = Math.round(th.getBoundingClientRect().top);
        var scrolled = grid.scrollTop;
        grid.scrollTop = 0;
        grid.style.height = oldHeight;
        grid.style.flex = oldFlex;
        return { before: before, after: after, scrolled: scrolled, gridH: h,
                 contentH: grid.scrollHeight, sticky: getComputedStyle(th).position };
    });
    check('表头是 sticky 定位（滚动数据时列标题行固定不动）',
        !!sticky && sticky.sticky === 'sticky' && Math.abs(sticky.after - sticky.before) <= 1,
        JSON.stringify(sticky));
    check('网格确实发生了滚动（验证表头没跟着走）', !!sticky && sticky.scrolled > 0,
        sticky ? String(sticky.scrolled) : 'null');

    // 点列头排序：真实再查一次，行序会变
    var sortRes = await frame.evaluate(async function () {
        var $ = window.jQuery;
        var th = $('#dbRowsGrid thead th.is-sortable').first();
        var col = th.attr('data-col');
        var cellsBefore = [].map.call(document.querySelectorAll('#dbRowsGrid tbody tr'), function (tr) {
            return (tr.querySelectorAll('td')[1] || {}).innerText || '';
        });
        th.trigger('click');
        var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        await wait(2200);
        var cellsAfter = [].map.call(document.querySelectorAll('#dbRowsGrid tbody tr'), function (tr) {
            return (tr.querySelectorAll('td')[1] || {}).innerText || '';
        });
        return { col: col, before: cellsBefore, after: cellsAfter,
                 meta: (document.getElementById('dbRowsMeta') || {}).innerText || '',
                 thText: th.text() };
    });
    check('点列头后按该列升序（行数信息里带「按 xxx 升序」）',
        new RegExp('按 ' + sortRes.col + ' 升序').test(sortRes.meta), sortRes.meta);
    check('排序确实重新取了数据（顺序与排序前一致即为升序）',
        sortRes.after.length === 0 ||
        JSON.stringify(sortRes.after) === JSON.stringify(sortRes.after.slice().sort()),
        JSON.stringify(sortRes.after.slice(0, 4)));

    // 筛选：按 status / account 里取到的第一个值过滤
    var filterRes = await frame.evaluate(async function () {
        var $ = window.jQuery;
        var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        $('#btnRowsFilter').trigger('click');
        var col = String($('#rowFilterCol').val() || '');
        var $cell = $('#dbRowsGrid tbody tr').first().find('td').eq(1);
        var value = String($cell.text() || '');
        $('#rowFilterOp').val('eq');
        $('#rowFilterValue').val(value);
        $('#btnRowFilterAdd').trigger('click');
        await wait(2200);
        return {
            barShown: !$('#dbRowsFilterBar').prop('hidden'),
            col: col, value: value,
            rows: document.querySelectorAll('#dbRowsGrid tbody tr').length,
            chips: $('#dbRowsChips .db-chip').length,
            chipText: $('#dbRowsChips').text(),
            meta: (document.getElementById('dbRowsMeta') || {}).innerText || ''
        };
    });
    check('「筛选」展开条件区并能按列过滤',
        filterRes.barShown === true && !!filterRes.col && filterRes.rows >= 1,
        JSON.stringify({ col: filterRes.col, value: filterRes.value, rows: filterRes.rows }));
    check('筛选条件以标签展示、行数信息标出「筛选 N 条」',
        filterRes.chips === 1 && /筛选 1 条/.test(filterRes.meta),
        filterRes.chipText.slice(0, 60) + ' / ' + filterRes.meta);
    await frame.evaluate(async function () {
        var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        window.jQuery('#btnRowFilterClear').trigger('click');
        await wait(1600);
    });
    var cleared = await frame.evaluate(function () {
        return { chips: window.jQuery('#dbRowsChips .db-chip').length,
                 rows: document.querySelectorAll('#dbRowsGrid tbody tr').length };
    });
    check('点「清空」移除全部筛选条件', cleared.chips === 0 && cleared.rows >= 1,
        JSON.stringify(cleared));

    /* ---------- 5. SQL 工作台：真实查询 + 写操作被拒 ---------- */
    console.log('\n--- 5. SQL 工作台（真实 MySQL 查询） ---');
    await frame.evaluate(function () {
        window.jQuery('#dbTabs .el-tabs__item[data-tab="sql"]').trigger('click');
    });
    await sleep(600);
    var sqlTabOn = await frame.evaluate(function () {
        var pane = document.querySelector('.el-tab-pane[data-pane="sql"]');
        return !!pane && getComputedStyle(pane).display !== 'none';
    });
    check('手动点标签可切到「SQL 工作台」', sqlTabOn === true);
    var ran = await frame.evaluate(function () {
        var $ = window.jQuery;
        $('#sqlDb').val('rogerorm');
        $('#sqlText').val('SELECT `id`, `name`, `dbType` FROM dbinfomgr ORDER BY `name` LIMIT 5');
        $('#btnSqlRun').trigger('click');
        return true;
    });
    await sleep(2500);
    var result = await frame.evaluate(function () {
        var heads = [].map.call(document.querySelectorAll('#sqlResult .db-result__table thead th'),
            function (th) { return (th.innerText || '').replace(/\s+/g, ''); });
        var rows = document.querySelectorAll('#sqlResult .db-result__table tbody tr');
        return {
            info: (document.getElementById('sqlInfo') || {}).innerText || '',
            heads: heads,
            rows: rows.length,
            firstCell: rows.length ? (rows[0].querySelectorAll('td')[1] || {}).innerText || '' : '',
            bodyOverflow: (function () {
                var el = document.getElementById('sqlResult');
                return el ? el.scrollHeight - el.clientHeight : 0;
            })()
        };
    });
    check('执行真实查询成功（状态条显示行数与耗时）',
        /执行成功/.test(result.info) && /耗时/.test(result.info), result.info);
    check('结果表按 SQL 的列生成表头（# + id / name / dbType）',
        result.heads.length === 4 && result.heads[1] === 'id' && result.heads[2] === 'name' &&
        result.heads[3] === 'dbType', result.heads.join(','));
    check('结果表有数据行且单元格有值', result.rows >= 1 && !!result.firstCell,
        'rows=' + result.rows + ' / first=' + result.firstCell);

    var denied = await frame.evaluate(function () {
        var $ = window.jQuery;
        $('#sqlText').val('DELETE FROM dbinfomgr');
        $('#btnSqlRun').trigger('click');
        return true;
    });
    await sleep(1800);
    var deniedInfo = await frame.evaluate(function () {
        return {
            info: (document.getElementById('sqlInfo') || {}).innerText || '',
            body: (document.getElementById('sqlResult') || {}).innerText || ''
        };
    });
    check('写操作在真实后端被拒绝',
        /执行失败/.test(deniedInfo.info) && /只允许执行查询语句/.test(deniedInfo.info),
        deniedInfo.info.slice(0, 90));
    check('拒绝原因同时显示在结果区', /只允许执行查询语句/.test(deniedInfo.body),
        deniedInfo.body.replace(/\s+/g, ' ').slice(0, 60));

    // Ctrl + Enter 快捷执行
    await frame.evaluate(function () {
        var $ = window.jQuery;
        $('#sqlText').val('SELECT COUNT(*) AS n FROM dbinfomgr');
        $('#sqlText').trigger(window.jQuery.Event('keydown', { keyCode: 13, ctrlKey: true, which: 13 }));
    });
    await sleep(2200);
    var hotkey = await frame.evaluate(function () {
        return {
            info: (document.getElementById('sqlInfo') || {}).innerText || '',
            rows: document.querySelectorAll('#sqlResult .db-result__table tbody tr').length
        };
    });
    check('Ctrl + Enter 可执行 SQL', /执行成功/.test(hotkey.info) && hotkey.rows >= 1,
        hotkey.info.slice(0, 70) + ' / rows=' + hotkey.rows);

    /* ---------- 5.1 双击换表 → 结果网格清空 ---------- */
    console.log('\n--- 5.1 换表后 SQL 执行结果必须清空（真实浏览器） ---');
    var switched = await frame.evaluate(async function (prev) {
        var $ = window.jQuery;
        var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var $node = $('#dbTree .el-tree-node[data-kind="table"]').filter(function () {
            return String($(this).attr('data-table') || '') !== String(prev || '');
        }).first();
        var name = $node.attr('data-table') || '';
        $node.children('.el-tree-node__content').trigger('dblclick');
        await wait(2800);
        return {
            name: name,
            hasTable: !!document.querySelector('#sqlResult .db-result__table'),
            rows: document.querySelectorAll('#sqlResult .db-result__table tbody tr').length,
            body: (document.getElementById('sqlResult') || {}).innerText || '',
            info: (document.getElementById('sqlInfo') || {}).innerText || '',
            sql: (document.getElementById('sqlText') || {}).value || ''
        };
    }, dblTable);
    check('双击另一张表后结果网格整块消失（不残留上一张表的结果）',
        !!switched.name && switched.hasTable === false && switched.rows === 0,
        JSON.stringify({ name: switched.name, hasTable: switched.hasTable, rows: switched.rows }));
    check('结果区换成「已切换到 库.表」的空态提示',
        /已切换到/.test(switched.body) && switched.body.indexOf(switched.name) > -1,
        switched.body.replace(/\s+/g, ' ').slice(0, 70));
    check('状态条回到「尚未执行」', /尚未执行/.test(switched.info),
        switched.info.replace(/\s+/g, ' ').slice(0, 50));
    check('SQL 编辑器已换成新表的 SELECT', switched.sql.indexOf(switched.name) > -1,
        switched.sql.slice(0, 80));

    /* ---------- 5.2 公用否：弹窗默认公用、可改私有 ---------- */
    console.log('\n--- 5.2 连接「公用否」：默认公用 / 可改私有 ---');
    var ispubForm = await frame.evaluate(async function (name) {
        var $ = window.jQuery;
        var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        $('#dbList .db-item').filter(function () { return $(this).text().indexOf(name) > -1; })
            .trigger('click');
        await wait(500);
        $('#btnEdit').trigger('click');
        await wait(900);
        var $f = $('.el-overlay .el-dialog').last().find('.db-form');
        return {
            has: $f.find('#dfIspub').length === 1,
            value: $f.find('#dfIspub').val(),
            options: $f.find('#dfIspub option').length
        };
    }, CONN_NAME);
    check('编辑弹窗里有「公用否」下拉（公用 / 私有两个选项）',
        ispubForm.has && ispubForm.options === 2, JSON.stringify(ispubForm));
    check('这条连接默认是公用', ispubForm.value === '1', String(ispubForm.value));

    var ispubSaved = await frame.evaluate(async function (name) {
        var $ = window.jQuery;
        var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var $dlg = $('.el-overlay .el-dialog').last();
        $dlg.find('#dfIspub').val('0');
        $dlg.find('.btn-ok').trigger('click');
        await wait(2000);
        var card = $('#dbList .db-item').filter(function () {
            return $(this).text().indexOf(name) > -1;
        }).text();
        return { toast: $('.el-message-list').text(), card: card };
    }, CONN_NAME);
    check('改成私有后保存成功', /保存成功/.test(ispubSaved.toast), ispubSaved.toast.slice(0, 60));
    check('卡片上出现「私有」标记', /私有/.test(ispubSaved.card), ispubSaved.card.slice(0, 80));
    var ispubDb = await page.evaluate(async function (tk, id) {
        var r = await fetch('/api/dbinfo/detail?id=' + id + '&token=' + tk)
            .then(function (x) { return x.json(); });
        var d = r.data || {};
        return { ispub: d.ispub, ispubText: d.ispubText, createempinfosid: d.createempinfosid };
    }, token, created.id);
    check('库里 ispub 落成 0（私有），创建人员工ID 未被编辑覆盖',
        ispubDb.ispub === false && Number(ispubDb.createempinfosid || 0) === Number(created.createempinfosid || 0),
        JSON.stringify(ispubDb));

    /* ---------- 6. 清理 ---------- */
    console.log('\n--- 6. 清理测试连接 ---');
    var removed = await frame.evaluate(async function (tk, id) {
        var res = await fetch('/api/dbinfo/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tk, id: id })
        }).then(function (r) { return r.json(); });
        return res.code;
    }, token, created.id);
    check('测试连接已删除（不留垃圾数据）', removed === 0, String(removed));

    await browser.close();
    finish();

    function finish() {
        console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
        process.exit(fail ? 1 : 0);
    }
})();
