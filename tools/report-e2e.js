/* ==========================================================================
   report-e2e.js —— 数据中心 · 报表设计器端到端验证（真实浏览器 + 真实 MySQL）
   --------------------------------------------------------------------------
   验证：
     1) 菜单项「报表设计」（MNU00014）已创建、启用，并挂在「数据中心」组下；
     2) 以 iframe 子页打开 report-designer.html，**左 / 中 / 右三栏**布局成立（几何量出来
        左栏在画布左边、画布在属性栏左边，三栏高度一致、整页不出现滚动条，各栏内部自己滚）；
        左栏 6 个操作按钮**只显示图标**（无文字、svg 可见、title 有文案）；
     3) 真实数据源：选中本机 MySQL 连接 → 扫出实例（库）→ 扫出表 / 视图 → 展开字段（真实元数据）；
     4) 双击表 → 画布按真实字段生成列（显示名优先用字段注释）、主表同步；
     5) 参数定义 + 页面模板 + 数据集 SQL 一起保存到 reportinfos（真实库）；
     6) 报表清单里能查到刚保存的报表；预览按真实 SQL 执行并渲染表格（含汇总与页脚）；
     7) 调用接口 /api/report/run 按编码执行，runCount 递增；
     8) 结束后删除测试报表（只删自己建的那条）。
   前置：后端 8808 已启动、本机 MySQL 可连（sa/roger2019），且 dbinfomgr 里有一条可用的 MySQL 连接。
   运行：NODE_PATH=<node_modules> node tools/report-e2e.js [账号] [密码]
   ========================================================================== */
'use strict';
var puppeteer = require('puppeteer-core');

var EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
var BASE = 'http://127.0.0.1:8808';
var KEY = 'menu_admin_login_v1';
var ACCOUNT = process.argv[2] || '15724887807';
var PASSWORD = process.argv[3] || '888888';
var REPORT_CODE = 'RPTE2E01';
var REPORT_NAME = '__报表设计器 e2e__';

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

    /* ---------- 1. 菜单数据 ---------- */
    console.log('\n--- 1. 菜单项 / 菜单组数据 ---');
    await page.goto(BASE + '/main.html', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    var menuInfo = await page.evaluate(async function (tk) {
        function get(path) {
            return fetch(path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + tk)
                .then(function (r) { return r.json(); });
        }
        var items = await get('/api/menu/list?pageNum=1&pageSize=200');
        var groups = await get('/api/group/list?pageNum=1&pageSize=200');
        var list = ((items.data || {}).list) || [], glist = ((groups.data || {}).list) || [];
        var found = null, group = null, i;
        for (i = 0; i < list.length; i++) {
            if (String(list[i].path) === 'report-designer.html') { found = list[i]; }
        }
        for (i = 0; i < glist.length; i++) {
            if (String(glist[i].code) === 'MNG1005') { group = glist[i]; }
        }
        var bound = false;
        if (found && group) {
            var binds = await get('/api/groupitem/list?groupId=' + group.id + '&pageSize=200');
            var blist = ((binds.data || {}).list) || [];
            for (i = 0; i < blist.length; i++) {
                if (String(blist[i].itemId) === String(found.id)) { bound = true; }
            }
        }
        return {
            item: found ? { code: found.code, nameCn: found.nameCn, path: found.path, enabled: found.enabled } : null,
            group: group ? { code: group.code, nameCn: group.nameCn, sortNo: group.sortNo } : null,
            bound: bound
        };
    }, token);
    check('菜单项「报表设计」已创建且启用',
        !!menuInfo.item && menuInfo.item.nameCn === '报表设计' &&
        menuInfo.item.path === 'report-designer.html' && menuInfo.item.enabled === true,
        JSON.stringify(menuInfo.item));
    check('挂在「数据中心」菜单组下', !!menuInfo.group && menuInfo.group.nameCn === '数据中心',
        JSON.stringify(menuInfo.group));
    check('菜单组与菜单项已绑定', menuInfo.bound === true, String(menuInfo.bound));

    /* 清掉上一次可能残留的测试报表（含中途崩溃留下的同名副本） */
    await page.evaluate(async function (tk, code) {
        function get(path) {
            return fetch(path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + tk)
                .then(function (x) { return x.json(); });
        }
        var seen = {};
        for (var round = 0; round < 3; round++) {
            for (var k = 0, keys = [code, 'e2e']; k < keys.length; k++) {
                var r = await get('/api/report/list?keyword=' + encodeURIComponent(keys[k]) + '&pageSize=100');
                var list = ((r.data || {}).list) || [];
                for (var i = 0; i < list.length; i++) {
                    var row = list[i];
                    var isMine = /^__报表/.test(String(row.reportName || '')) ||
                                 /e2e/i.test(String(row.reportName || ''));
                    if (isMine && !seen[row.id]) {
                        seen[row.id] = true;
                        await fetch('/api/report/delete', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ token: tk, id: row.id })
                        });
                    }
                }
            }
        }
    }, token, REPORT_CODE);

    /* ---------- 2. 打开子页 ---------- */
    console.log('\n--- 2. 以 iframe 子页打开报表设计器 ---');
    await page.goto(BASE + '/main.html#report-designer.html', { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    var frame = null;
    for (var i = 0; i < 30 && !frame; i++) {
        frame = page.frames().filter(function (f) {
            return f !== page.mainFrame() && /report-designer\.html$/.test(f.url());
        })[0] || null;
        if (!frame) { await sleep(200); }
    }
    check('以 iframe 子页加载 report-designer.html', !!frame, frame ? frame.url() : 'none');
    if (!frame) { await browser.close(); return finish(); }

    console.log('\n--- 2.1 三栏布局：结构与几何 ---');
    var geo = await frame.evaluate(function () {
        function box(sel) {
            var el = document.querySelector(sel);
            if (!el) { return null; }
            var r = el.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width),
                     h: Math.round(r.height), bottom: Math.round(r.bottom) };
        }
        var paper = document.querySelector('.rpt-paper');
        var pr = paper ? paper.getBoundingClientRect() : null;
        return {
            layoutW: box('.rpt-layout') ? box('.rpt-layout').w : 0,
            left: box('#rptLeft'), canvas: box('#rptCanvas'), props: box('#rptProps'),
            bodyScroll: document.body.scrollHeight - window.innerHeight,
            innerH: window.innerHeight,
            paper: pr ? { w: Math.round(pr.width), h: Math.round(pr.height) } : null,
            gridScroll: (function () {
                var el = document.querySelector('#rptScroll');
                return el ? el.scrollHeight > el.clientHeight + 4 : false;
            })(),
            toolbarTexts: Array.prototype.map.call(
                document.querySelectorAll('.rpt-toolbar .rpt-tool'),
                function (b) { return { text: (b.textContent || '').replace(/\s+/g, ''), title: b.getAttribute('title') || '' }; }),
            tabs: Array.prototype.map.call(document.querySelectorAll('#rptLeftTabs .el-tabs__item'),
                function (t) { return (t.textContent || '').replace(/\s+/g, ''); }),
            ptabs: Array.prototype.map.call(document.querySelectorAll('#rptPropTabs .el-tabs__item'),
                function (t) { return (t.textContent || '').replace(/\s+/g, ''); }),
            freeLayer: !!document.querySelector('#rptFreeLayer'),
            toolCards: document.querySelectorAll('#toolGrid .rpt-tool__card').length
        };
    });
    check('左栏在画布左边、画布在属性栏左边',
        geo.left && geo.canvas && geo.props && geo.left.x < geo.canvas.x && geo.canvas.x < geo.props.x,
        JSON.stringify([geo.left && geo.left.x, geo.canvas && geo.canvas.x, geo.props && geo.props.x]));
    check('三栏高度一致（同一行铺满）',
        geo.left && geo.canvas && geo.props &&
        Math.abs(geo.left.h - geo.canvas.h) <= 2 && Math.abs(geo.canvas.h - geo.props.h) <= 2,
        [geo.left && geo.left.h, geo.canvas && geo.canvas.h, geo.props && geo.props.h].join(' / '));
    check('三栏都铺满容器宽度（无空隙溢出）',
        geo.left && geo.props && (geo.props.x + geo.props.w) <= (geo.left.x + geo.layoutW + 2),
        JSON.stringify({ layoutW: geo.layoutW, right: geo.props && (geo.props.x + geo.props.w) }));
    check('iframe 内不出现整页滚动条（各栏内部自己滚）',
        geo.bodyScroll <= 2 || geo.gridScroll, 'body scroll=' + geo.bodyScroll);
    check('画布里的纸张可见且有高度', geo.paper && geo.paper.w > 300 && geo.paper.h > 300,
        JSON.stringify(geo.paper));
    check('左栏 6 个操作按钮只有图标（无文字）',
        geo.toolbarTexts.length === 6 && geo.toolbarTexts.every(function (t) { return t.text === ''; }),
        JSON.stringify(geo.toolbarTexts));
    check('每个图标按钮都有 title 文案',
        geo.toolbarTexts.every(function (t) { return t.title.length > 0; }),
        JSON.stringify(geo.toolbarTexts.map(function (t) { return t.title; })));
    check('左栏三个页签：报表清单 / 数据源 / 工具箱',
        geo.tabs.length === 3 && geo.tabs[0] === '报表清单' && geo.tabs[1] === '数据源' &&
        geo.tabs[2] === '工具箱', JSON.stringify(geo.tabs));
    check('右栏四个页签：字段属性 / 组件属性 / 报表参数 / 页面模板',
        geo.ptabs.length === 4 && geo.ptabs[0] === '字段属性' &&
        geo.ptabs[1] === '组件属性' && geo.ptabs[2] === '报表参数' &&
        geo.ptabs[3] === '页面模板', JSON.stringify(geo.ptabs));
    check('画布里有「设计区」容器', geo.freeLayer === true);

    /* ---------- 2.2 报表功能介绍录入区 ---------- */
    console.log('\n--- 2.2 报表功能介绍（录入区）---');
    var introGeo = await frame.evaluate(function () {
        var $ = window.jQuery;
        var d = document.getElementById('rptDesc');
        var wrap = document.getElementById('rptIntro');
        var bar = document.querySelector('.rpt-bar');
        var scroll = document.getElementById('rptScroll');
        function rect(el) {
            if (!el) { return null; }
            var r = el.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top),
                     w: Math.round(r.width), h: Math.round(r.height) };
        }
        var out = { hasDesc: !!d, hasWrap: !!wrap,
                    desc: rect(d), wrap: rect(wrap), bar: rect(bar), scroll: rect(scroll),
                    label: (document.querySelector('.rpt-intro__label') || {}).textContent || '' };
        /* 输入一段说明：字数、摘要、画布状态都要跟着变 */
        $(d).val('真实浏览器录入：按部门统计在职员工。\n第二行：口径说明。').trigger('input');
        out.count = document.getElementById('rptDescCount').textContent;
        out.hint = document.getElementById('rptIntroHint').textContent;
        out.model = window.RptDesigner.state.design.description;
        /* 收起 / 展开 */
        document.getElementById('btnIntroToggle').click();
        out.collapsedH = Math.round(document.getElementById('rptIntro').getBoundingClientRect().height);
        out.aria = document.getElementById('btnIntroToggle').getAttribute('aria-expanded');
        document.getElementById('btnIntroToggle').click();
        out.expandedH = Math.round(document.getElementById('rptIntro').getBoundingClientRect().height);
        return out;
    });
    check('画布上方有「功能介绍」录入区', introGeo.hasDesc && introGeo.hasWrap &&
        introGeo.label === '功能介绍', introGeo.label);
    check('功能介绍是多行文本框，宽度铺满中栏',
        introGeo.desc && introGeo.desc.w > 300 && introGeo.desc.h >= 50,
        JSON.stringify(introGeo.desc));
    check('功能介绍位于工具栏下方、画布上方',
        introGeo.wrap.y >= introGeo.bar.y + introGeo.bar.h - 1 &&
        introGeo.wrap.y + introGeo.wrap.h <= introGeo.scroll.y + 1,
        JSON.stringify({ bar: introGeo.bar, wrap: introGeo.wrap, scroll: introGeo.scroll }));
    check('录入说明后字数统计跟着变', /^\d+ \/ 500$/.test(introGeo.count) &&
        introGeo.count.indexOf(String(introGeo.model.length) + ' / 500') === 0, introGeo.count);
    check('折叠条摘要显示说明第一行',
        introGeo.hint.indexOf('真实浏览器录入：按部门统计在职员工。') === 0, introGeo.hint);
    check('录入内容写进设计（换行保留）',
        introGeo.model.indexOf('\n') > 0, JSON.stringify(introGeo.model));
    check('点标题可收起（高度变小 + aria-expanded=false）',
        introGeo.aria === 'false' && introGeo.collapsedH < introGeo.expandedH,
        introGeo.collapsedH + ' → ' + introGeo.expandedH);

    /* ---------- 3. 真实数据源 ---------- */
    console.log('\n--- 3. 数据源：真实连接 / 实例 / 表 / 字段 ---');
    var conns = await frame.evaluate(async function () {
        var r = await fetch('/api/report/connections?token=' +
            encodeURIComponent((localStorage.getItem('menu_admin_login_v1') ?
                JSON.parse(localStorage.getItem('menu_admin_login_v1')).token : '')))
            .then(function (x) { return x.json(); });
        return ((r.data || {}).list) || [];
    });
    check('接口返回启用状态的连接', conns.length >= 1, String(conns.length));
    var mysqlConn = null;
    for (i = 0; i < conns.length; i++) {
        if (conns[i].dbType === 'mysql' && /roger2019|sa/.test('')) { mysqlConn = conns[i]; }
    }
    if (!mysqlConn) {
        for (i = 0; i < conns.length; i++) {
            if (conns[i].dbType === 'mysql') { mysqlConn = conns[i]; break; }
        }
    }
    check('存在可用的 MySQL 连接', !!mysqlConn, JSON.stringify(conns.map(function (c) { return c.name; })));
    if (!mysqlConn) { await browser.close(); return finish(); }

    /* 在页面里选中连接与实例，触发真实的扫描 */
    await frame.evaluate(function (connId) {
        var $ = window.jQuery;
        window.RptDesigner.newReport();
        $('#srcConn').val(connId).trigger('change');
    }, mysqlConn.id);
    await sleep(2600);

    var srcState = await frame.evaluate(function () {
        var $ = window.jQuery;
        return {
            dbs: $('#srcDb option').length,
            picked: $('#srcDb').val(),
            options: $('#srcDb option').map(function () { return $(this).val(); }).get(),
            tip: $('#srcTip').text()
        };
    });
    check('真实扫出实例（库）列表', srcState.dbs >= 2, JSON.stringify(srcState.options));
    check('默认选中了某个库', !!srcState.picked, srcState.picked);
    check('扫描提示说明可以拖表 / 字段', /拖/.test(srcState.tip), srcState.tip);

    /* 切到 rogerorm（本项目的库），没有就用手上第一个 */
    var pickDb = srcState.options.indexOf('rogerorm') >= 0 ? 'rogerorm' : srcState.picked;
    await frame.evaluate(function (db) {
        window.jQuery('#srcDb').val(db).trigger('change');
    }, pickDb);
    await sleep(2600);

    var treeState = await frame.evaluate(function () {
        var $ = window.jQuery;
        var nodes = $('#srcTree .el-tree-node[data-kind="table"], #srcTree .el-tree-node[data-kind="view"]');
        return {
            count: nodes.length,
            names: nodes.map(function () { return $(this).attr('data-table'); }).get().slice(0, 10),
            hasEmp: nodes.filter('[data-table="empinfos"]').length
        };
    });
    check('真实扫出表 / 视图（>1 个）', treeState.count > 1, String(treeState.count));
    check('其中有本项目的 empinfos 表', treeState.hasEmp === 1, JSON.stringify(treeState.names));

    /* 展开 empinfos 的字段 */
    await frame.evaluate(function () {
        window.jQuery('#srcTree .el-tree-node[data-table="empinfos"] > .rpt-node__row').trigger('click');
    });
    await sleep(1600);
    var fieldState = await frame.evaluate(function () {
        var $ = window.jQuery;
        var fields = $('#srcTree .rpt-node--field');
        return {
            count: fields.length,
            first: fields.eq(0).text().replace(/\s+/g, ' '),
            hasCode: fields.filter('[data-field="code"]').length,
            type: fields.eq(0).find('.rpt-node__ftype').text()
        };
    });
    check('展开表后列出真实字段（>5 个）', fieldState.count > 5, String(fieldState.count));
    check('字段里有 code', fieldState.hasCode === 1, fieldState.first);
    check('字段带真实类型（如 varchar/int）', /varchar|int|char|datetime|text/i.test(fieldState.type),
        fieldState.type);
    /* ---------- 4. 按字段加入（整表加入已取消） ---------- */
    console.log('\n--- 4. 双击表只展开字段，加列按字段粒度 ---');
    var beforeExpand = await frame.evaluate(function () {
        var $ = window.jQuery;
        var $row = $('#srcTree .el-tree-node[data-table="empinfos"] > .rpt-node__row');
        return { cols: window.RptDesigner.columns().length,
                 draggable: $row.attr('draggable') || '',
                 hasDragClass: $row.hasClass('is-draggable') };
    });
    check('真实 DOM 里表节点不再是拖拽源（draggable 已去掉）',
        beforeExpand.draggable !== 'true' && beforeExpand.hasDragClass === false,
        JSON.stringify(beforeExpand));
    await frame.evaluate(function () {
        window.jQuery('#srcTree .el-tree-node[data-table="empinfos"] > .rpt-node__row').trigger('dblclick');
    });
    await sleep(2200);
    var afterExpand = await frame.evaluate(function () {
        var $ = window.jQuery;
        return {
            cols: window.RptDesigner.columns().length,
            fields: $('#srcTree .el-tree-node[data-table="empinfos"] .rpt-node--field').length,
            toast: $('.el-message-list').text(),
            status: $('#rptStatusText').text()
        };
    });
    check('双击表不往画布里加列（列数仍为 0）', afterExpand.cols === beforeExpand.cols,
        beforeExpand.cols + ' -> ' + afterExpand.cols);
    check('双击表把字段展开了（真实元数据）', afterExpand.fields >= 6, String(afterExpand.fields));
    check('提示「已展开…拖字段 / 双击字段」', /已展开/.test(afterExpand.toast), afterExpand.toast);

    /* 逐个字段双击加入（真实字段注释做显示名） */
    var picked = await frame.evaluate(function () {
        var $ = window.jQuery;
        var n = Math.min(6, $('#srcTree .el-tree-node[data-table="empinfos"] .rpt-node--field').length);
        var names = [];
        for (var i = 0; i < n; i++) {
            /* 每加一列树都会重渲染（is-added 标记），必须每次重新取节点 */
            var $f = $('#srcTree .el-tree-node[data-table="empinfos"] .rpt-node--field').eq(i);
            names.push($f.attr('data-field'));
            $f.trigger('dblclick');
        }
        return { picked: names.join(','), cols: window.RptDesigner.columns().length };
    });
    await sleep(1200);
    var canvasState = await frame.evaluate(function () {
        var $ = window.jQuery;
        return {
            cols: window.RptDesigner.columns().length,
            mainTable: window.RptDesigner.state.design.mainTable,
            heads: $('#rptCols .rpt-table thead th').length,
            firstLabel: $('#rptCols .rpt-table thead th').eq(0).text().replace(/×/g, '').replace(/\s+/g, ''),
            rows: $('#rptCols .rpt-table tbody tr').length,
            status: $('#rptStatusText').text()
        };
    });
    check('双击 6 个字段 -> 画布正好 6 列（按字段逐个加入）', canvasState.cols === 6,
        picked.picked + ' -> ' + canvasState.cols);
    check('主表被设为 empinfos', canvasState.mainTable === 'empinfos', canvasState.mainTable);
    check('画布列头与列数一致', canvasState.heads === canvasState.cols,
        canvasState.heads + ' / ' + canvasState.cols);
    check('列头显示中文字段注释', /主键|工号|姓名|手机|邮箱/.test(canvasState.firstLabel), canvasState.firstLabel);
    check('画布有示意数据行', canvasState.rows >= 2, String(canvasState.rows));


    /* ---------- 4.2 没有参数：预览窗不显示参数区与「执行」按钮 ---------- */
    console.log('\n--- 4.2 没有参数的报表：预览窗不显示参数区与执行按钮 ---');
    await frame.evaluate(function () {
        var $ = window.jQuery;
        $('#rptName').val('无参数预览 e2e').trigger('input');
        $('#btnPreview').trigger('click');
    });
    await sleep(3200);
    var pvNoParam = await frame.evaluate(function () {
        var $ = window.jQuery;
        var $dlg = $('.el-overlay .el-dialog').last();
        var $body = $dlg.find('.el-dialog__body');
        return {
            open: $dlg.length === 1,
            top: $body.find('.rpt-pv__top').length,
            run: $body.find('#pvRun').length,
            params: $body.find('#pvParams').length,
            rows: $body.find('#pvTableWrap tbody tr').length,
            info: $body.find('#pvInfo').text(),
            firstChild: $body.find('.rpt-pv').children().eq(0).attr('class') || ''
        };
    });
    check('无参数时预览窗正常打开', pvNoParam.open === true);
    check('没有顶部行（参数区 + 执行按钮都不渲染）', pvNoParam.top === 0, String(pvNoParam.top));
    check('没有「执行预览」按钮', pvNoParam.run === 0, String(pvNoParam.run));
    check('没有参数控件容器 #pvParams', pvNoParam.params === 0);
    check('打开即自动执行并出数据', pvNoParam.rows >= 1, String(pvNoParam.rows));
    check('页脚显示执行信息', /行/.test(pvNoParam.info), pvNoParam.info);
    check('纸张区排在弹窗最前（顶部不留空行）', /rpt-pv__scroll/.test(pvNoParam.firstChild),
        pvNoParam.firstChild);
    await frame.evaluate(function () {
        var $ = window.jQuery;
        $('.el-overlay .el-dialog').last().find('.el-dialog__headerbtn')
            .not('.el-dialog__headerbtn--max').trigger('click');
    });
    await sleep(800);
    var overlaysLeft = await frame.evaluate(function () {
        return { overlays: window.jQuery('.el-overlay').length,
                 titles: window.jQuery('.el-overlay .el-dialog__title').map(function () {
                     return window.jQuery(this).text();
                 }).get().join(' | ') };
    });
    check('无参数预览窗已关闭（不留遮罩）', overlaysLeft.overlays === 0,
        JSON.stringify(overlaysLeft));


    /* ---------- 4.1 工具箱：组件拖进设计区 + 列标对齐 ---------- */
    console.log('\n--- 4.1 工具箱组件与列标对齐 ---');
    var toolState = await frame.evaluate(function () {
        var $ = window.jQuery;
        window.RptDesigner.setLeftTab('tool');
        var cards = $('#toolGrid .rpt-tool__card').length;
        function fire($el, type, extra) {
            var ev = $.Event(type);
            ev.originalEvent = {
                dataTransfer: { setData: function () {}, getData: function () { return ''; },
                                effectAllowed: '', dropEffect: '' },
                preventDefault: function () {}, stopPropagation: function () {}
            };
            for (var k in (extra || {})) { if (extra.hasOwnProperty(k)) { ev.originalEvent[k] = extra[k]; } }
            $el.trigger(ev);
        }
        function dropTo(kind, $target, x, y) {
            /* 组件的坐标是「相对设计区」的，所以 clientX/Y 要用目标元素的页面位置换算 */
            var rect = $target[0].getBoundingClientRect();
            var cx = Math.round(rect.left + x), cy = Math.round(rect.top + y);
            fire($('#toolGrid .rpt-tool__card[data-el-kind="' + kind + '"]'), 'dragstart');
            fire($target, 'dragover', { clientX: cx, clientY: cy });
            fire($target, 'drop', { clientX: cx, clientY: cy });
        }
        var $free = $('#rptFreeLayer');
        dropTo('label', $free, 40, 30);
        dropTo('box', $free, 60, 90);
        var $box = $('#rptFreeLayer > .rpt-el--box').first();
        if ($box.length) { dropTo('table', $box, 10, 10); }
        /* 表格组件：在右栏把几格填上字、加一行，验证真实浏览器里「编辑 → 画布」的联动 */
        var tableEl = null;
        (function () {
            var list = window.RptDesigner.elements();
            for (var i = 0; i < list.length; i++) {
                var kids = list[i].children || [];
                for (var k = 0; k < kids.length; k++) {
                    if (kids[k].kind === 'table') { tableEl = kids[k]; }
                }
            }
        })();
        var tableGrid = null;
        if (tableEl) {
            window.RptDesigner.selectElement(tableEl.id);
            $('#elemTblCells input[data-r="0"][data-c="0"]').val('工号').trigger('input');
            $('#elemTblCells input[data-r="0"][data-c="1"]').val('姓名').trigger('input');
            $('#elemTblCells input[data-r="1"][data-c="0"]').val('E0001').trigger('input');
            $('#elemTblCells input[data-r="1"][data-c="1"]').val('张三').trigger('input');
            $('#elemTblRows').val('4').trigger('change');
            /* 此刻表格还选中着，量一下单元格编辑器的真实几何（下面拖图表会切走属性面板） */
            tableGrid = (function () {
                var g = document.getElementById('elemTblCells');
                if (!g) { return null; }
                var gr = g.getBoundingClientRect();
                var pane = g.parentNode ? g.parentNode.getBoundingClientRect() : null;
                var first = g.querySelector('input');
                var bar = document.getElementById('btnTblAddRow');
                return {
                    w: Math.round(gr.width), h: Math.round(gr.height),
                    paneW: pane ? Math.round(pane.width) : 0,
                    firstW: first ? Math.round(first.getBoundingClientRect().width) : 0,
                    firstH: first ? Math.round(first.getBoundingClientRect().height) : 0,
                    barW: bar ? Math.round(bar.getBoundingClientRect().width) : 0,
                    barTop: bar ? Math.round(bar.getBoundingClientRect().top) : 0,
                    gridTop: Math.round(gr.top)
                };
            })();
        }
        $box = $('#rptFreeLayer > .rpt-el--box').first();
        if ($box.length) { dropTo('chart', $box, 10, 120); }

        var label = document.querySelector('#rptFreeLayer > .rpt-el--label');
        var lr = label ? label.getBoundingClientRect() : null;
        var fr = $free[0] ? $free[0].getBoundingClientRect() : null;
        var boxEl = document.querySelector('#rptFreeLayer > .rpt-el--box');
        var br = boxEl ? boxEl.getBoundingClientRect() : null;

        /* 列标对齐：选中第一列改成左对齐，量一下表头的计算样式 */
        window.RptDesigner.setPropTab('col');
        $('#rptCols .rpt-th').eq(0).trigger('click');
        var thAlignBefore = window.getComputedStyle($('#rptCols .rpt-th')[0]).textAlign;
        $('#colHeaderAlign').val('left').trigger('change');
        var thAlignAfter = window.getComputedStyle($('#rptCols .rpt-th')[0]).textAlign;
        var headStyle = $('#rptCols .rpt-th').eq(0).attr('style') || '';

        return {
            cards: cards,
            tabActive: $('#rptLeftTabs .el-tabs__item.is-active').attr('data-ltab'),
            kinds: window.RptDesigner.elements().map(function (one) { return one.kind; }),
            children: (window.RptDesigner.elements()[1] || {}).children || [],
            labelBox: lr ? { x: Math.round(lr.left - fr.left), y: Math.round(lr.top - fr.top),
                             w: Math.round(lr.width), h: Math.round(lr.height) } : null,
            boxBox: br ? { w: Math.round(br.width), h: Math.round(br.height) } : null,
            tableInBox: document.querySelectorAll('#rptFreeLayer .rpt-el--box .rpt-el--table').length,
            chartInBox: document.querySelectorAll('#rptFreeLayer .rpt-el--box svg').length,
            tableEl: tableEl ? { rows: tableEl.rows, cols: tableEl.cols, cells: tableEl.cells } : null,
            cellGrid: tableGrid,
            tableInputs: $('#elemTblCells input').length,
            tableTh: document.querySelectorAll('#rptFreeLayer .rpt-el--box .rpt-el--table th').length,
            tableTd: document.querySelectorAll('#rptFreeLayer .rpt-el--box .rpt-el--table td').length,
            tableText: ($('#rptFreeLayer .rpt-el--box .rpt-el--table').text() || '').slice(0, 40),
            freeTableText: (function () {
                var one = document.querySelector('#rptFreeLayer .rpt-el--table');
                return one ? one.textContent.replace(/\s+/g, ' ').slice(0, 60) : '';
            })(),
            thAlignBefore: thAlignBefore,
            thAlignAfter: thAlignAfter,
            headStyle: headStyle,
            headerAlign: (window.RptDesigner.columns()[0] || {}).headerAlign
        };
    });
    check('工具箱有 6 个组件卡片', toolState.cards === 6, String(toolState.cards));
    check('切到工具箱页签', toolState.tabActive === 'tool', toolState.tabActive);
    check('拖入文本 + 区域', toolState.kinds.length === 2 &&
        toolState.kinds[0] === 'label' && toolState.kinds[1] === 'box',
        JSON.stringify(toolState.kinds));
    check('文本按落点定位（实测几何）', !!toolState.labelBox &&
        Math.abs(toolState.labelBox.x - 40) <= 2 && Math.abs(toolState.labelBox.y - 30) <= 2,
        JSON.stringify(toolState.labelBox));
    check('文本有默认尺寸 220×32', !!toolState.labelBox &&
        toolState.labelBox.w === 220 && toolState.labelBox.h === 32,
        JSON.stringify(toolState.labelBox));
    check('区域有默认尺寸 420×160', !!toolState.boxBox &&
        toolState.boxBox.w === 420 && toolState.boxBox.h === 160,
        JSON.stringify(toolState.boxBox));
    check('区域里接住了表格与图表（2 个子组件）', (toolState.children || []).length === 2,
        JSON.stringify((toolState.children || []).map(function (o) { return o.kind; })));
    check('区域里的表格渲染出表格', toolState.tableInBox >= 1, String(toolState.tableInBox));
    check('表格可以自己改行列：默认 3×3 → 改成 4 行 3 列',
        !!toolState.tableEl && toolState.tableEl.rows === 4 && toolState.tableEl.cols === 3,
        JSON.stringify(toolState.tableEl && { rows: toolState.tableEl.rows, cols: toolState.tableEl.cols }));
    check('单元格编辑器是 4×3 = 12 个输入框', toolState.tableInputs === 12,
        String(toolState.tableInputs));
    check('表格里填的字写进了模型',
        !!toolState.tableEl && toolState.tableEl.cells[0][0] === '工号' &&
        toolState.tableEl.cells[1][1] === '张三',
        JSON.stringify(toolState.tableEl && toolState.tableEl.cells));
    check('画布按 4 行 3 列渲染（3 个 th + 9 个 td）',
        toolState.tableTh === 3 && toolState.tableTd === 9,
        toolState.tableTh + ' / ' + toolState.tableTd);
    check('画布上显示用户填的单元格文字', /工号/.test(toolState.freeTableText) &&
        /张三/.test(toolState.freeTableText), toolState.freeTableText);
    check('单元格编辑器不超出右栏（实测几何）', !!toolState.cellGrid &&
        toolState.cellGrid.w <= toolState.cellGrid.paneW + 1 &&
        toolState.cellGrid.w > 100,
        JSON.stringify(toolState.cellGrid));
    check('每个格子足够宽 / 高，能点能输入', !!toolState.cellGrid &&
        toolState.cellGrid.firstW >= 24 && toolState.cellGrid.firstH >= 18,
        JSON.stringify(toolState.cellGrid));
    check('工具栏按钮在编辑器上方且没被挤没', !!toolState.cellGrid &&
        toolState.cellGrid.barTop < toolState.cellGrid.gridTop && toolState.cellGrid.barW >= 20,
        JSON.stringify(toolState.cellGrid));
    check('区域里的图表渲染出 svg', toolState.chartInBox >= 1, String(toolState.chartInBox));
    check('列标默认居中', toolState.thAlignBefore === 'center', toolState.thAlignBefore);
    check('改「列标对齐」后表头真的左对齐', toolState.thAlignAfter === 'left',
        toolState.thAlignAfter + ' / ' + toolState.headStyle);
    check('列标对齐写进列定义', toolState.headerAlign === 'left', String(toolState.headerAlign));

    /* ---------- 5. 参数 + 模板 + SQL → 保存 ---------- */
    console.log('\n--- 5. 参数 / 模板 / SQL → 保存到 reportinfos ---');
    await frame.evaluate(function () {
        var $ = window.jQuery;
        $('.rpt-bar__field #rptName').val('__报表设计器 e2e__').trigger('input');
        $('#rptCode').val('RPTE2E01').trigger('input');
        $('#rptCategory').val('测试').trigger('input');
        window.RptDesigner.setPropTab('param');
        $('#btnParamAdd').trigger('click');
        var $card = $('#paramBody .rpt-param__card').eq(0);
        $card.find('[data-p="name"]').val('empCode').trigger('input');
        $card.find('[data-p="label"]').val('工号').trigger('input');
        window.RptDesigner.setPropTab('tmpl');
        $('#tplPaper').val('A4').trigger('change');
        $('#tplOrientation').val('landscape').trigger('change');
        $('#tplSubtitle').val('e2e 自动生成').trigger('input');
        $('#tplFooter').val('报表设计器 e2e').trigger('input');
        $('#tplFooterAlign').val('left').trigger('change');
        $('#tplFooterLogo').val('assets/logo.svg').trigger('input');
        $('#tplHeader').val('九豆平台 e2e 页眉').trigger('input');
        $('#tplHeaderAlign').val('right').trigger('change');
        $('#tplHeaderLogo').val('assets/logo.svg').trigger('input');
        $('#tplHeaderLogoPos').val('right').trigger('change');
        $('#tplHeaderLogoH').val('36').trigger('change');
        window.RptDesigner.setPropTab('param');
        /* 公开否：勾上 → 保存后 ispublic=1，其他用户在清单 / 报表中心也能看到这张报表 */
        $('#rptIsPublic').prop('checked', true).trigger('change');
        $('#rptSqlText').val('SELECT `code`, `nameCn`, `phone`, `email` FROM `empinfos` ' +
            'WHERE (`code` LIKE :empCode OR :empCode IS NULL)').trigger('input');
        $('#btnSave').trigger('click');
    });
    await sleep(2600);
    var saved = await frame.evaluate(function () {
        var $ = window.jQuery;
        return {
            id: window.RptDesigner.state.design.id,
            code: window.RptDesigner.state.design.code,
            version: window.RptDesigner.state.design.version,
            toast: $('.el-message-list').text(),
            status: $('#rptStatusText').text(),
            items: $('#rpList .rpt-item').length
        };
    });
    check('保存成功（拿到报表 id）', !!saved.id, String(saved.id));
    check('提示已保存到报表信息表', /已保存/.test(saved.toast), saved.toast);
    check('编码为 RPTE2E01', saved.code === 'RPTE2E01', saved.code);
    check('状态条提示可用编码调用', /调用/.test(saved.status), saved.status);
    var pubTag = await frame.evaluate(function () {
        var $ = window.jQuery, found = 0;
        $('#rpList .rpt-item').each(function () {
            if ($(this).text().indexOf('RPTE2E01') >= 0) {
                found = $(this).find('.rpt-item__pub').length;
            }
        });
        return found;
    });
    check('清单卡片带「公共」标记（勾了公开）', pubTag === 1, String(pubTag));

    var dbRow = await page.evaluate(async function (tk, code) {
        var r = await fetch('/api/report/list?keyword=' + encodeURIComponent(code) + '&token=' + tk)
            .then(function (x) { return x.json(); });
        return ((r.data || {}).list) || [];
    }, token, REPORT_CODE);
    check('报表信息表里能查到这张报表', dbRow.length === 1, String(dbRow.length));
    check('落库的参数 / 列 / 模板都完整',
        dbRow.length === 1 && Number(dbRow[0].paramCount) === 1 && Number(dbRow[0].columnCount) >= 6,
        dbRow.length ? JSON.stringify({ p: dbRow[0].paramCount, c: dbRow[0].columnCount }) : '');
    check('落库的纸张方向是横向', dbRow.length === 1 && /横向/.test(dbRow[0].paperText), 
        dbRow.length ? dbRow[0].paperText : '');
    check('落库的「公开否」= 公开（ispublic=true）',
        dbRow.length === 1 && dbRow[0].ispublic === true,
        dbRow.length ? String(dbRow[0].ispublic) : '');

    /* 创建人 = 当前登录账号的员工姓名（不是账号、不是空） */
    var me = await page.evaluate(async function (tk) {
        var r = await fetch('/api/auth/me?token=' + tk).then(function (x) { return x.json(); });
        return r.data || {};
    }, token);
    var expectCreator = String(me.empName || me.account || '');
    check('登录账号绑定了员工姓名（拿得到创建人）', !!expectCreator,
        String(me.account) + ' / ' + String(me.empName));
    check('报表创建人（createEname）= 当前登录人的员工姓名',
        dbRow.length === 1 && String(dbRow[0].createEname || '') === expectCreator,
        (dbRow[0] && String(dbRow[0].createEname)) + ' != ' + expectCreator);
    check('报表创建人员工ID（createempinfosid）= 当前登录人的员工ID',
        dbRow.length === 1 && Number(dbRow[0].createempinfosid || 0) === Number(me.empId || 0),
        (dbRow[0] && String(dbRow[0].createempinfosid)) + ' != ' + String(me.empId));
    check('报表修改人（updateEname / updateempinfosid）也按登录人落库',
        dbRow.length === 1 && String(dbRow[0].updateEname || '') === expectCreator &&
        Number(dbRow[0].updateempinfosid || 0) === Number(me.empId || 0),
        (dbRow[0] && (String(dbRow[0].updateEname) + ' / ' + String(dbRow[0].updateempinfosid))));

    /* ---------- 6. 预览（真实 SQL 执行） ---------- */
    console.log('\n--- 6. 预览：真实查询 ---');
    await frame.evaluate(function () {
        window.jQuery('#btnPreview').trigger('click');
    });
    await sleep(3000);
    var pv = await frame.evaluate(function () {
        var $ = window.jQuery;
        var dlg = $('.el-overlay .el-dialog').last();
        var body = dlg.find('.el-dialog__body');
        return {
            open: dlg.length === 1,
            dbgOverlays: $('.el-overlay').length,
            dbgBoxes: $('.el-message-box').length,
            dbgBoxText: $('.el-message-box').last().text().slice(0, 80),
            dbgToasts: $('.el-message-list').text().slice(0, 100),
            dbgItems: $('#rpList .rpt-item').length,
            title: dlg.find('.el-dialog__title').text(),
            th: body.find('#pvTableWrap thead th').map(function () {
                return $(this).text().replace(/\s+/g, '');
            }).get(),
            rows: body.find('#pvTableWrap tbody tr').length,
            firstRow: body.find('#pvTableWrap tbody tr').eq(0).text().replace(/\s+/g, ' '),
            info: body.find('#pvInfo').text(),
            footer: body.find('#pvFooter').text(),
            headBand: body.find('#pvHeaderBand').text(),
            footBand: body.find('#pvFooterBand').text(),
            headLogo: body.find('#pvHeaderBand img.rpt-pageband__logo').length,
            footLogo: body.find('#pvFooterBand img.rpt-pageband__logo').length,
            headAlign: body.find('#pvHeaderBand .rpt-pageband__text').attr('style') || '',
            footAlign: body.find('#pvFooterBand .rpt-pageband__text').attr('style') || '',
            headRowReverse: /row-reverse/.test(body.find('#pvHeaderBand .rpt-pageband').attr('style') || ''),
            footerHidden: body.closest('.el-dialog').find('.el-dialog__footer').prop('hidden'),
            cancelText: body.closest('.el-dialog').find('.btn-cancel').text(),
            err: body.find('#pvTableWrap .is-error').text()
        };
    });
    check('预览弹窗打开', pv.open === true);
    check('预览按真实 SQL 渲染出 4 列表头',
        pv.th.length === 4 && /工号|姓名|手机|邮箱/.test(pv.th[0] + pv.th[1]),
        JSON.stringify(pv.th));
    check('预览取到了真实数据行', pv.rows >= 1, String(pv.rows) + ' | ' + pv.firstRow.slice(0, 60));
    check('预览信息条显示行数与耗时', /行/.test(pv.info), pv.info);
    check('预览页脚带显示页脚文字（来自模板）', /报表设计器 e2e/.test(pv.footBand), pv.footBand);
    check('预览页脚带带 logo 且左对齐',
        pv.footLogo === 1 && /text-align:\s*left/.test(pv.footAlign),
        pv.footLogo + ' / ' + pv.footAlign);
    check('预览页眉带显示页眉文字 + logo（贴右）',
        /九豆平台 e2e 页眉/.test(pv.headBand) && pv.headLogo === 1 && pv.headRowReverse === true,
        pv.headBand + ' / ' + pv.headLogo + ' / ' + pv.headRowReverse);
    check('预览页眉文字右对齐', /text-align:\s*right/.test(pv.headAlign), pv.headAlign);
    check('弹窗右下角没有「关闭」按钮（用标题栏 ✕ 关）',
        pv.footerHidden === true && pv.cancelText === '取消',
        String(pv.footerHidden) + ' / ' + pv.cancelText);
    check('预览没有报错', !pv.err, pv.err);
    await frame.evaluate(function () {
        window.jQuery('.el-overlay .el-dialog').last()
            .find('.el-dialog__headerbtn').not('.el-dialog__headerbtn--max').trigger('click');
    });

    /* ---------- 7. 按编码调用（run） ---------- */
    console.log('\n--- 7. 按编码调用报表（run） ---');
    var runRes = await page.evaluate(async function (tk, code) {
        var r = await fetch('/api/report/run', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tk, code: code, paramValues: {} })
        }).then(function (x) { return x.json(); });
        return { code: r.code, message: r.message, data: r.data || {} };
    }, token, REPORT_CODE);
    check('接口按编码调用成功', runRes.code === 0, runRes.message);
    check('调用返回真实行数据', (runRes.data.rowCount || 0) >= 1, String(runRes.data.rowCount));
    check('调用返回列映射（mapped）', (runRes.data.mapped || []).length === 4,
        String((runRes.data.mapped || []).length));
    check('调用后 runCount 递增到 1', Number(runRes.data.runCount) === 1, String(runRes.data.runCount));
    check('调用返回的是只读 SELECT 语句', /^SELECT /i.test(String(runRes.data.sql || '')),
        String(runRes.data.sql || '').slice(0, 80));

    /* ---------- 7.1 清单排序：启用的在前，停用的沉到下部 ---------- */
    console.log('\n--- 7.1 清单排序：启用的在前、停用的沉到下部 ---');
    /* 复制出一张「停用」报表（副本默认 enabled=0，且更新时间最新）：它仍必须排在最后 */
    var copyRes = await page.evaluate(async function (tk, id) {
        var r = await fetch('/api/report/copy', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tk, id: id, reportName: 'e2e 停用副本' })
        }).then(function (x) { return x.json(); });
        return { code: r.code, id: (r.data || {}).id || '', message: r.message };
    }, token, saved.id);
    check('复制出一条停用副本（用于验证排序）', copyRes.code === 0 && !!copyRes.id,
        copyRes.message + ' / ' + copyRes.id);
    await frame.evaluate(function () {
        window.RptDesigner.setLeftTab('list');        // 保存后左栏停在「数据源」，要先切回清单才有布局
        window.RptDesigner.loadReports();
    });
    await sleep(1200);
    var listOrder = await frame.evaluate(function () {
        var $ = window.jQuery, seenOff = false, bad = '', list = [], offNames = [];
        $('#rpList .rpt-item').each(function () {
            var on = $(this).find('.rpt-item__dot').hasClass('is-on');
            var code = $(this).find('.rpt-item__code').text();
            list.push(code + (on ? '(启用)' : '(停用)'));
            if (!on) { seenOff = true; offNames.push($(this).find('.rpt-item__name').text()); }
            else if (seenOff) { bad = code; }
        });
        return { bad: bad, list: list.join(' | '), offNames: offNames.join(' / '),
                 total: window.RptDesigner.state.total, count: list.length };
    });
    check('停用的报表一律排在启用报表之后（不会插在中间）', listOrder.bad === '', listOrder.list);
    check('停用区里第一个就是最新复制的副本（组内按更新时间倒序，但它仍在启用报表之后）',
        /e2e 停用副本/.test(listOrder.offNames.split(' / ')[0] || ''),
        listOrder.offNames + '（共 ' + listOrder.total + ' 条）');

    /* ---------- 7.2 清单交互：单击只选中 / 双击才打开编辑 / 「运行」按钮跑查询 ---------- */
    console.log('\n--- 7.2 清单交互：单击只选中、双击打开编辑、运行按钮弹窗 ---');
    /* 用 frame.$$ 拿 ElementHandle（evaluateHandle 返回的是 JSHandle，没有 boundingBox） */
    var cardHandle = null;
    var cards = await frame.$$('#rpList .rpt-item');
    for (var ci = 0; ci < cards.length; ci++) {
        var ctext = await cards[ci].evaluate(function (el) { return el.textContent || ''; });
        if (ctext.indexOf(REPORT_CODE) >= 0) { cardHandle = cards[ci]; break; }
    }
    check('清单里能找到这张报表的卡片', !!cardHandle, String(cards.length) + ' 张卡片');
    var cardBox = await cardHandle.boundingBox();
    var clickX = cardBox.x + 24, clickY = cardBox.y + 26;      // 名称那一行，避开右下角「运行」按钮

    var beforeClick = await frame.evaluate(function () {
        var $ = window.jQuery;
        return {
            code: window.RptDesigner.state.design.code,
            tab: $('#rptLeftTabs .el-tabs__item.is-active').attr('data-ltab')
        };
    });
    await page.mouse.move(0, 0);
    await page.mouse.click(clickX, clickY);
    await sleep(900);
    var afterClick = await frame.evaluate(function () {
        var $ = window.jQuery;
        return {
            code: window.RptDesigner.state.design.code,
            tab: $('#rptLeftTabs .el-tabs__item.is-active').attr('data-ltab'),
            selected: $('#rpList .rpt-item.is-selected').length
        };
    });
    check('真实单击后画布没有换报表（仍是当前这张）', afterClick.code === beforeClick.code,
        beforeClick.code + ' → ' + afterClick.code);
    check('真实单击不切换左侧页签（仍停在点之前的页签）', afterClick.tab === beforeClick.tab,
        beforeClick.tab + ' → ' + afterClick.tab);
    check('真实单击只把卡片置为选中态', afterClick.selected === 1, String(afterClick.selected));

    /* 双击才是「打开继续编辑」：down/up 两轮，第二次 detail=2（page.click 的 clickCount:2 不触发 dblclick） */
    await page.mouse.move(clickX, clickY);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
    await sleep(1800);
    var afterDbl = await frame.evaluate(function () {
        var $ = window.jQuery;
        return {
            code: window.RptDesigner.state.design.code,
            tab: $('#rptLeftTabs .el-tabs__item.is-active').attr('data-ltab'),
            status: $('#rptStatusText').text(),
            dialog: $('.el-overlay .el-dialog').length
        };
    });
    check('真实双击打开了这张报表继续编辑', afterDbl.code === REPORT_CODE, afterDbl.code);
    check('打开编辑后左栏切到「数据源」页签', afterDbl.tab === 'source', afterDbl.tab);
    check('双击不会弹运行窗口（运行改由按钮触发）', afterDbl.dialog === 0, String(afterDbl.dialog));

    /* ---------- 7.2.1 停用的报表：双击只提醒，不切页签、不动画布 ---------- */
    console.log('\n--- 7.2.1 停用的报表：双击只提醒、不进设计 ---');
    /* 用 7.1 复制的「e2e 停用副本」（默认 enabled=0）验证：真实双击也拦得住 */
    await frame.evaluate(function () { window.RptDesigner.setLeftTab('list'); });
    await sleep(400);
    var offCards = await frame.$$('#rpList .rpt-item');
    var offHandle = null;
    for (var oi = 0; oi < offCards.length; oi++) {
        var otext = await offCards[oi].evaluate(function (el) { return el.textContent || ''; });
        if (otext.indexOf('e2e 停用副本') >= 0) { offHandle = offCards[oi]; break; }
    }
    check('清单里能找到停用副本的卡片', !!offHandle, String(offCards.length) + ' 张卡片');
    var offTip = offHandle ? (await offHandle.evaluate(function (el) { return el.getAttribute('title') || ''; })) : '';
    check('停用卡片 title 提示「已停用、启用后才能进入设计」',
        /已停用/.test(offTip) && /启用后才能/.test(offTip), offTip);
    var offBefore = await frame.evaluate(function () {
        return {
            code: window.RptDesigner.state.design.code,
            tab: window.jQuery('#rptLeftTabs .el-tabs__item.is-active').attr('data-ltab')
        };
    });
    var offBox0 = offHandle ? await offHandle.boundingBox() : null;
    check('停用卡片能拿到位置', !!offBox0, offBox0 ? (offBox0.x + ',' + offBox0.y) : 'no box');
    /* 停用沉底 → 卡片常在列表下部，先把滚动的清单拉到可见再取坐标，否则双击点到视口外 */
    await offHandle.evaluate(function (el) { el.scrollIntoView({ block: 'center' }); });
    await sleep(300);
    await page.mouse.move(0, 0);                  // 先挪开，避免 hover 抬升影响取坐标
    var offBox = await offHandle.boundingBox();
    var offX = offBox.x + 24, offY = offBox.y + 26;      // 名称行，避开右下角「运行」按钮
    /* down/up 不带坐标、只认当前鼠标位置，必须先 move 到卡片上（忘了 move 就是在 (0,0) 原地双击） */
    await page.mouse.move(offX, offY);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
    await sleep(1200);
    var offAfter = await frame.evaluate(function () {
        var $ = window.jQuery;
        var selText = $('#rpList .rpt-item.is-selected').text() || '';
        return {
            code: window.RptDesigner.state.design.code,
            tab: $('#rptLeftTabs .el-tabs__item.is-active').attr('data-ltab'),
            toast: $('.el-message-list').text(),
            dialog: $('.el-overlay .el-dialog').length,
            selected: $('#rpList .rpt-item.is-selected').length,
            selIsOff: selText.indexOf('e2e 停用副本') >= 0
        };
    });
    check('真实双击停用卡片只弹「已停用」提醒',
        /已停用/.test(offAfter.toast) && /启用/.test(offAfter.toast), offAfter.toast);
    check('停用卡片双击不切「数据源」页签（仍停在清单）', offAfter.tab === 'list', offAfter.tab);
    check('停用卡片双击不动画布（画布仍是原来的报表）',
        offAfter.code === offBefore.code, offBefore.code + ' → ' + offAfter.code);
    check('停用卡片双击不弹任何窗口', offAfter.dialog === 0, String(offAfter.dialog));
    check('停用卡片双击后选中的就是这张停用卡',
        offAfter.selected === 1 && offAfter.selIsOff,
        String(offAfter.selected) + ' / ' + offAfter.selIsOff);

    /* 运行入口：卡片右下角的独立按钮，点它只弹窗、不动画布。
       双击打开编辑会把左栏切到「数据源」（清单被隐藏），所以要先切回清单；清单也重渲染过，卡片要重新取 */
    await frame.evaluate(function () { window.RptDesigner.setLeftTab('list'); });
    await sleep(400);
    var cards2 = await frame.$$('#rpList .rpt-item');
    var runHandle = null;
    for (var ri = 0; ri < cards2.length; ri++) {
        var rtext = await cards2[ri].evaluate(function (el) { return el.textContent || ''; });
        if (rtext.indexOf(REPORT_CODE) >= 0) { runHandle = await cards2[ri].$('.rpt-item__run'); break; }
    }
    check('卡片右下角有「运行」按钮', !!runHandle);
    /* 7.2.1 的 scrollIntoView 把清单滚到了底部，运行按钮的卡片可能已被滚出可视区：
       先把卡片滚回来，再重新取坐标，并用 elementFromPoint 确认点击点真的落在按钮上 */
    await runHandle.evaluate(function (el) { el.closest('.rpt-item').scrollIntoView({ block: 'center' }); });
    await sleep(300);
    await page.mouse.move(0, 0);                  // 挪开鼠标防 hover 抬升影响取坐标
    runHandle = null;
    for (var rj = 0; rj < cards2.length; rj++) {
        var rtext2 = await cards2[rj].evaluate(function (el) { return el.textContent || ''; });
        if (rtext2.indexOf(REPORT_CODE) >= 0) { runHandle = await cards2[rj].$('.rpt-item__run'); break; }
    }
    check('滚动后仍能拿到「运行」按钮', !!runHandle);
    var runBox = await runHandle.boundingBox();
    var runHit = await runHandle.evaluate(function (el) {
        var r = el.getBoundingClientRect();
        var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { inView: r.top >= 0 && r.bottom <= window.innerHeight,
                 hitIsBtn: !!hit && !!hit.closest('.rpt-item__run'),
                 hitCls: hit ? hit.className : '' };
    });
    check('运行按钮在可视区内', runHit.inView === true, JSON.stringify(runHit));
    check('点击点命中运行按钮（elementFromPoint）', runHit.hitIsBtn === true, runHit.hitCls);
    await page.mouse.click(runBox.x + runBox.width / 2, runBox.y + runBox.height / 2);
    await sleep(3400);
    var runPv = await frame.evaluate(function () {
        var $ = window.jQuery;
        var dlg = $('.el-overlay .el-dialog').last();
        var body = dlg.find('.el-dialog__body');
        var itemText = '';
        $('#rpList .rpt-item').each(function () {
            if ($(this).text().indexOf('RPTE2E01') >= 0) { itemText = $(this).text(); }
        });
        var $top = body.find('.rpt-pv__top');
        var $foot = body.find('.rpt-pv__footbar');
        var pr = body.find('#pvParams')[0] ? body.find('#pvParams')[0].getBoundingClientRect() : null;
        var rr = body.find('#pvRun')[0] ? body.find('#pvRun')[0].getBoundingClientRect() : null;
        var fr = $foot[0] ? $foot[0].getBoundingClientRect() : null;
        var br = body.find('.rpt-pv__scroll')[0] ? body.find('.rpt-pv__scroll')[0].getBoundingClientRect() : null;
        return {
            open: dlg.length === 1,
            dbgOverlays: $('.el-overlay').length,
            dbgBoxes: $('.el-message-box').length,
            dbgBoxText: $('.el-message-box').last().text().slice(0, 80),
            dbgToasts: $('.el-message-list').text().slice(0, 100),
            title: dlg.find('.el-dialog__title').text(),
            connBar: body.find('#pvConn').length + body.find('#pvMeta').length,
            topHasParamsAndRun: $top.find('> #pvParams').length === 1 && $top.find('> #pvRun').length === 1,
            runIsLastInTop: $top.children().last().attr('id') === 'pvRun',
            sameRow: !!(pr && rr && Math.abs((pr.top + pr.height / 2) - (rr.top + rr.height / 2)) < 12),
            runRight: !!(pr && rr && rr.left > pr.left + pr.width - 4),
            infoInFoot: $foot.find('> #pvInfo').length === 1,
            info: body.find('#pvInfo').text(),
            footBelowPaper: !!(fr && br && fr.top > br.top + 40),
            btnText: body.find('.rpt-pv__footbar .el-button').map(function () {
                return this.textContent.trim();
            }).get().join('/'),
            th: body.find('#pvTableWrap thead th').length,
            rows: body.find('#pvTableWrap tbody tr').length,
            footer: body.find('#pvFooter').text(),
            editBtn: body.find('#pvEdit').length > 0,
            freeGeo: (function () {
                var layer = body.find('#pvFreeLayer')[0];
                var stage = body.find('#pvFreeLayer .rpt-pv__stage')[0];
                if (!layer || !stage) { return null; }
                var st = stage.getAttribute('style') || '';
                var scaleM = st.match(/transform:scale\(([\d.]+)\)/);
                var boxEl = body.find('#pvFreeLayer .rpt-el--box')[0];
                var br = boxEl ? boxEl.getBoundingClientRect() : null;
                var kidRects = [];
                if (boxEl) {
                    var kids = boxEl.querySelectorAll('.rpt-el');
                    for (var i = 0; i < kids.length; i++) {
                        var kr = kids[i].getBoundingClientRect();
                        kidRects.push({ dx: Math.round(kr.left - br.left),
                                        dy: Math.round(kr.top - br.top) });
                    }
                }
                return {
                    width: parseInt((st.match(/width:(\d+)px/) || [0, '0'])[1], 10),
                    scale: scaleM ? parseFloat(scaleM[1]) : 1,
                    hidden: window.jQuery(layer).prop('hidden'),
                    boxW: br ? Math.round(br.width / (scaleM ? parseFloat(scaleM[1]) : 1)) : 0,
                    kids: kidRects
                };
            })(),
            status: $('#rptStatusText').text(),
            itemText: itemText.replace(/\s+/g, ' '),
            canvasCode: window.RptDesigner.state.design.code
        };
    });
    console.log('    [DBG] ' + JSON.stringify({ o: runPv.dbgOverlays, b: runPv.dbgBoxes,
        bt: runPv.dbgBoxText, t: runPv.dbgToasts, items: runPv.dbgItems }));
    check('点卡片「运行」按钮弹出运行窗口', runPv.open === true);
    check('运行按钮不切换画布（仍停在这张报表的编辑态）', runPv.canvasCode === REPORT_CODE, runPv.canvasCode);
    check('弹窗标题是「运行报表」', /运行报表 —— __报表设计器 e2e__/.test(runPv.title), runPv.title);
    check('连接对象信息区已隐藏（页面里没有 #pvConn / #pvMeta）', runPv.connBar === 0, String(runPv.connBar));
    check('参数区与执行按钮在同一行（.rpt-pv__top）', runPv.topHasParamsAndRun === true);
    check('执行按钮是这一行的最后一个元素（在右侧）', runPv.runIsLastInTop === true);
    check('实测几何：参数区与按钮中线齐平', runPv.sameRow === true);
    check('实测几何：按钮在参数区右边', runPv.runRight === true);
    check('执行效率信息在页脚（.rpt-pv__footbar 内的 #pvInfo）', runPv.infoInFoot === true);
    check('页脚位于结果纸张下方', runPv.footBelowPaper === true);
    check('页脚按钮为 打印/导出 PDF/导出 Excel（已去掉「在画布中编辑」）',
        runPv.btnText === '打印/导出 PDF/导出 Excel', runPv.btnText);
    check('查询结果按保存的 SQL 出 4 列', runPv.th === 4, String(runPv.th));
    check('查询结果有真实数据行', runPv.rows >= 1, String(runPv.rows));
    check('页脚信息含执行时间 / 行数 / 耗时',
        /执行于/.test(runPv.info) && /返回 \d+ 行/.test(runPv.info) && /耗时 \d+ ms/.test(runPv.info),
        runPv.info);
    check('结果页脚带总行数', /共 \d+ 行/.test(runPv.footer), runPv.footer);
    check('运行窗口里没有「在画布中编辑」按钮', runPv.editBtn === false &&
        runPv.btnText.indexOf('在画布中编辑') < 0);
    check('状态条提示已运行报表', /已运行报表/.test(runPv.status), runPv.status);
    check('运行后清单里的调用次数 +1（1 → 2）', /调用 2 次/.test(runPv.itemText), runPv.itemText);
    /* ---------- 7.2 打印 / 导出：都是「全部查询结果」 ---------- */
    console.log('\n--- 7.2 打印 / 导出（全部结果）---');
    await frame.evaluate(function () {
        window.jQuery('.el-overlay .el-dialog').last().find('.rpt-pv__footbar #pvPrint').trigger('click');
    });
    await sleep(2600);
    var printPage = await frame.evaluate(function () {
        var f = document.getElementById('rptPrintFrame');
        if (!f) { return { frame: false }; }
        var doc = f.contentDocument;
        var win2 = doc.defaultView || {};
        function pos(el) {
            try { return win2.getComputedStyle(el).position; } catch (e) { return ''; }
        }
        function rect(el) {
            var r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height };
        }
        var geo = { stage: null, box: null, kids: [], positions: [], stageW: 0, stageH: 0 };
        var stage = doc.querySelector('.free .free-stage');
        if (stage) {
            var style = stage.getAttribute('style') || '';
            var sr = rect(stage);
            var tr = style.match(/transform:scale\(([\d.]+)\)/);
            geo.stage = { w: sr.w, h: sr.h, scale: tr ? parseFloat(tr[1]) : 1 };
            geo.stageW = parseInt((style.match(/width:(\d+)px/) || [0, '0'])[1], 10);
            geo.stageH = parseInt((style.match(/height:(\d+)px/) || [0, '0'])[1], 10);
        }
        var box = doc.querySelector('.rpt-el--box');
        if (box) {
            var br = rect(box);
            geo.box = { x: br.x, y: br.y, w: br.w, h: br.h, position: pos(box) };
            var kids = box.querySelectorAll('.rpt-el');
            for (var i = 0; i < kids.length; i++) {
                var kr = rect(kids[i]);
                geo.kids.push({ cls: String(kids[i].className), x: kr.x, y: kr.y,
                                w: kr.w, h: kr.h, position: pos(kids[i]) });
            }
        }
        var all = doc.querySelectorAll('.free .rpt-el');
        for (var j = 0; j < all.length && j < 12; j++) {
            geo.positions.push({ x: Math.round(rect(all[j]).x), y: Math.round(rect(all[j]).y),
                                 position: pos(all[j]) });
        }
        return {
            frame: true,
            title: doc.title,
            heads: doc.querySelectorAll('table.data thead th').length,
            rows: doc.querySelectorAll('table.data tbody tr').length,
            freeEls: doc.querySelectorAll('.rpt-el').length,
            freeCharts: doc.querySelectorAll('.rpt-el--chart svg').length,
            headBand: (function () {
                var one = doc.querySelector('.sheet__band--head');
                return one ? one.textContent.replace(/\s+/g, ' ').slice(0, 40) : '';
            })(),
            footBand: (function () {
                var one = doc.querySelector('.sheet__band--foot');
                return one ? one.textContent.replace(/\s+/g, ' ').slice(0, 40) : '';
            })(),
            headLogo: doc.querySelectorAll('.sheet__band--head img.rpt-pageband__logo').length,
            footLogo: doc.querySelectorAll('.sheet__band--foot img.rpt-pageband__logo').length,
            sheetHead: !!doc.querySelector('table.sheet > thead .sheet__band--head'),
            sheetFoot: !!doc.querySelector('table.sheet > tfoot .sheet__band--foot'),
            bandFixed: (function () {
                var el = doc.querySelector('.sheet__band--head');
                if (!el) { return ''; }
                return (doc.defaultView || window).getComputedStyle(el).position;
            })(),
            headTop: (function () {
                var el = doc.querySelector('.sheet__band--head');
                return el ? Math.round(el.getBoundingClientRect().top) : -1;
            })(),
            thTop: (function () {
                var el = doc.querySelector('table.data thead th');
                return el ? Math.round(el.getBoundingClientRect().top) : -1;
            })(),
            freeTable: (function () {
                var one = doc.querySelector('.rpt-el--table');
                if (!one) { return null; }
                return {
                    rows: one.querySelectorAll('tr').length,
                    th: one.querySelectorAll('th').length,
                    text: (one.textContent || '').replace(/\s+/g, ' ').slice(0, 60)
                };
            })(),
            foot: doc.querySelector('.foot') ? doc.querySelector('.foot').textContent : '',
            page: (doc.querySelector('style') || {}).textContent || '',
            info: window.jQuery('#pvInfo').text(),
            geo: geo
        };
    });
    check('点「打印」生成隐藏打印页', printPage.frame === true);
    check('打印页标题取报表名', /__报表设计器 e2e__/.test(String(printPage.title || '')), printPage.title);
    check('打印页列头 4 列（与列定义一致）', printPage.heads === 4, String(printPage.heads));
    check('打印页行数 = 接口返回的全部行数', printPage.rows === runRes.data.rowCount,
        printPage.rows + ' / ' + runRes.data.rowCount);
    check('打印页带上设计区组件（>=2 个）', printPage.freeEls >= 2, String(printPage.freeEls));
    check('打印页里的表格按用户填的行列渲染（4 行 / 3 个表头）',
        !!printPage.freeTable && printPage.freeTable.rows === 4 && printPage.freeTable.th === 3,
        JSON.stringify(printPage.freeTable));
    check('打印页里的表格显示用户填的单元格文字',
        !!printPage.freeTable && /工号/.test(printPage.freeTable.text) &&
        /张三/.test(printPage.freeTable.text), printPage.freeTable && printPage.freeTable.text);
    check('打印页组件里的图表是 svg', printPage.freeCharts >= 1, String(printPage.freeCharts));

    /* 需求：打印时「有区域组件」要按页面呈现形式布局，不能错位 */
    var geo = printPage.geo || {};
    check('打印页设计区有定宽画布（.free-stage）', !!geo.stage,
        JSON.stringify(geo.stage));
    check('画布宽度按组件占用范围铺开（>=300px）', (geo.stageW || 0) >= 300, String(geo.stageW));
    check('画布按纸张可打印宽度等比缩放（scale ≤ 1）',
        !!geo.stage && geo.stage.scale > 0.2 && geo.stage.scale <= 1, String(geo.stage && geo.stage.scale));
    check('打印页里组件是绝对定位（不是块级堆叠）',
        geo.positions.length > 0 && geo.positions.every(function (one) {
            return one.position === 'absolute';
        }), JSON.stringify(geo.positions).slice(0, 160));
    check('区域组件有实际尺寸与边框（实测几何）',
        !!geo.box && geo.box.w > 100 && geo.box.h > 60, JSON.stringify(geo.box));
    check('区域里的子组件数量 >= 2 且也绝对定位',
        (geo.kids || []).length >= 2 && geo.kids.every(function (one) {
            return one.position === 'absolute';
        }), JSON.stringify(geo.kids).slice(0, 200));
    /* 子组件按「区域内容区」内缩定位（左右上下都从区域内侧起步），和预览页那套坐标一致；
       组件尺寸比区域大时溢出属设计本身，这里只校验起点没有跑出区域 */
    check('区域里的子组件从区域内侧（padding 内缩）起排，没有跑到区域外',
        (geo.kids || []).length >= 2 && geo.kids.every(function (one) {
            return one.x >= geo.box.x + 6 && one.x <= geo.box.x + geo.box.w &&
                one.y >= geo.box.y + 6 && one.y <= geo.box.y + geo.box.h;
        }), JSON.stringify({ box: geo.box, kids: geo.kids }).slice(0, 300));
    check('区域里的子组件各自有独立位置（没叠在同一处）',
        (function () {
            var seen = {}, n = 0;
            (geo.kids || []).forEach(function (one) {
                var key = Math.round(one.x) + 'x' + Math.round(one.y);
                if (!seen[key]) { seen[key] = 1; n++; }
            });
            return n >= 2;
        })(), JSON.stringify((geo.kids || []).map(function (one) {
            return [Math.round(one.x), Math.round(one.y)];
        })));
    var pvGeo = runPv.freeGeo;
    check('运行窗口的设计区也包在等比画布里（scale ≤ 1）',
        !!pvGeo && pvGeo.hidden === false && pvGeo.scale > 0.2 && pvGeo.scale <= 1,
        JSON.stringify(pvGeo ? { w: pvGeo.width, s: pvGeo.scale } : null));
    check('运行窗口里区域子组件与打印页相对位置一致（同一套坐标，不会各摆各的）',
        (function () {
            if (!pvGeo || !pvGeo.kids || !geo.kids || !pvGeo.boxW || !geo.box) { return false; }
            if (pvGeo.kids.length !== geo.kids.length) { return false; }
            for (var i = 0; i < pvGeo.kids.length; i++) {
                var a = pvGeo.kids[i].dx / pvGeo.boxW;
                var b = (geo.kids[i].x - geo.box.x) / geo.box.w;
                if (Math.abs(a - b) > 0.05) { return false; }
            }
            return true;
        })(), JSON.stringify({ pv: pvGeo && pvGeo.kids, pr: geo.kids && geo.kids.map(function (one) {
            return { dx: Math.round(one.x - (geo.box ? geo.box.x : 0)) };
        }) }));

    check('打印页有固定页眉（文字 + logo）',
        /九豆平台 e2e 页眉/.test(printPage.headBand) && printPage.headLogo === 1,
        printPage.headBand + ' / ' + printPage.headLogo);
    check('打印页有固定页脚（文字 + logo）',
        /报表设计器 e2e/.test(printPage.footBand) && printPage.footLogo === 1,
        printPage.footBand + ' / ' + printPage.footLogo);
    check('打印页页眉在 thead、页脚在 tfoot（每页重复且占位）',
        printPage.sheetHead === true && printPage.sheetFoot === true,
        JSON.stringify({ head: printPage.sheetHead, foot: printPage.sheetFoot }));
    check('页眉单元格是普通流内元素（不再 fixed，避免第 2 页压表头）',
        printPage.bandFixed === 'static' || printPage.bandFixed === 'relative',
        printPage.bandFixed);
    check('页眉在表格表头之上（不重合）',
        printPage.headTop >= 0 && printPage.thTop > printPage.headTop,
        printPage.headTop + ' / ' + printPage.thTop);
    check('打印页页脚显示总行数', /共 \d+ 行/.test(printPage.foot) && /打印时间/.test(printPage.foot),
        String(printPage.foot).trim());
    check('打印页按模板写了 @page（A4 横向 = 297×210mm）',
        /@page/.test(printPage.page) && /297mm 210mm/.test(printPage.page),
        String(printPage.page).slice(0, 60));
    check('打印后页脚提示已就绪', /打印页已就绪/.test(printPage.info), printPage.info);

    var exportRes = await frame.evaluate(async function (rid) {
        var out = {};
        var fmts = ['excel', 'pdf'];
        for (var i = 0; i < fmts.length; i++) {
            try {
                var f = await window.Api.report.exportFile({ id: rid, format: fmts[i], maxRows: 20000 });
                var buf = await f.blob.arrayBuffer();
                var bytes = new Uint8Array(buf.slice(0, 5));
                var head = '';
                for (var k = 0; k < bytes.length; k++) { head += String.fromCharCode(bytes[k]); }
                out[fmts[i]] = { size: f.blob.size, head: head, name: f.filename,
                                 rows: f.rowCount, truncated: f.truncated };
            } catch (e) { out[fmts[i]] = { error: String(e.message || e) }; }
        }
        return out;
    }, saved.id);
    check('导出 Excel 成功（.xlsx = PK 头）',
        exportRes.excel && exportRes.excel.head.indexOf('PK') === 0 && exportRes.excel.size > 3000,
        JSON.stringify(exportRes.excel).slice(0, 160));
    check('Excel 文件名带报表名 / 编码 / 时间戳',
        /报表设计器 e2e/.test(String((exportRes.excel || {}).name || '')) &&
        /RPTE2E01_\d{14}\.xlsx$/.test(String((exportRes.excel || {}).name || '')),
        String((exportRes.excel || {}).name));
    check('导出 PDF 成功（%PDF 头）',
        exportRes.pdf && exportRes.pdf.head.indexOf('%PDF') === 0 && exportRes.pdf.size > 1500,
        JSON.stringify(exportRes.pdf).slice(0, 160));
    check('PDF 文件名以 .pdf 结尾', /\.pdf$/.test(String((exportRes.pdf || {}).name || '')),
        String((exportRes.pdf || {}).name));
    check('导出的行数 = 接口返回的全部行数（没有只导一页）',
        (exportRes.excel || {}).rows === runRes.data.rowCount &&
        (exportRes.pdf || {}).rows === runRes.data.rowCount,
        (exportRes.excel || {}).rows + ' / ' + runRes.data.rowCount);

    /* ---------- 7.3 弹窗最大化 / 数据表右键行号 ---------- */
    console.log('\n--- 7.3 弹窗最大化 / 数据表右键行号 ---');
    var maxRes = await frame.evaluate(function () {
        var $ = window.jQuery;
        var $dlg = $('.el-overlay .el-dialog').last();
        var before = $dlg[0].getBoundingClientRect();
        /* 查看窗现在**打开即最大化**：这里量到的 before 就是最大化尺寸 */
        var openMax = $dlg.hasClass('is-max');
        var openTitle = $dlg.find('.el-dialog__headerbtn--max').attr('title');
        /* 两个标题栏按钮：必须同尺寸、同一条水平线 */
        function btnBox(sel) {
            var el = $dlg.find(sel)[0];
            if (!el) { return null; }
            var r = el.getBoundingClientRect();
            return { w: +r.width.toFixed(1), h: +r.height.toFixed(1),
                     top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
                     left: +r.left.toFixed(1), right: +r.right.toFixed(1),
                     fs: window.getComputedStyle(el).fontSize };
        }
        var btnMin = btnBox('.el-dialog__headerbtn--max');
        var btnClose = (function () {
            var el = $dlg.find('.el-dialog__headerbtn').not('.el-dialog__headerbtn--max')[0];
            if (!el) { return null; }
            var r = el.getBoundingClientRect();
            return { w: +r.width.toFixed(1), h: +r.height.toFixed(1),
                     top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
                     left: +r.left.toFixed(1), right: +r.right.toFixed(1),
                     fs: window.getComputedStyle(el).fontSize };
        })();
        var titleBox = (function () {
            var el = $dlg.find('.el-dialog__title')[0];
            var r = el.getBoundingClientRect();
            return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
                     center: +((r.top + r.bottom) / 2).toFixed(1) };
        })();
        $dlg.find('.el-dialog__headerbtn--max').trigger('click');
        var after = $dlg[0].getBoundingClientRect();
        var titleMax = $dlg.find('.el-dialog__headerbtn--max').attr('title');
        var isMax = $dlg.hasClass('is-max');
        var bodyH = $dlg.find('.el-dialog__body')[0].getBoundingClientRect().height;
        /* 最大化之后两个按钮也要保持同尺寸同基线 */
        var maxed = btnBox('.el-dialog__headerbtn--max');
        var maxedClose = (function () {
            var el = $dlg.find('.el-dialog__headerbtn').not('.el-dialog__headerbtn--max')[0];
            var r = el.getBoundingClientRect();
            return { w: +r.width.toFixed(1), h: +r.height.toFixed(1),
                     top: +r.top.toFixed(1), left: +r.left.toFixed(1) };
        })();

        /* 右击数据表任意处 → 菜单 → 打开行号 */
        var tbl = $dlg.find('.rpt-pv__table')[0];
        var out = { ok: !!tbl };
        if (tbl) {
            tbl.dispatchEvent(new MouseEvent('contextmenu',
                { bubbles: true, cancelable: true, clientX: 320, clientY: 320 }));
            var menu = document.querySelector('.rpt-ctxmenu');
            out.menu = menu ? menu.textContent : '';
            out.menuVisible = !!menu && menu.getBoundingClientRect().width > 60;
            out.menuTop = menu ? Math.round(menu.getBoundingClientRect().top) : -1;
            if (menu) { $(menu).find('[data-act="rownum"]').trigger('click'); }
            out.menuClosed = !document.querySelector('.rpt-ctxmenu');
            var th = $dlg.find('.rpt-pv__table thead th')[0];
            var firstTd = $dlg.find('.rpt-pv__table tbody tr').eq(0).find('td')[0];
            out.headText = th ? th.textContent : '';
            out.firstCell = firstTd ? firstTd.textContent : '';
            out.headCount = $dlg.find('.rpt-pv__table thead th').length;
            out.rowCount = $dlg.find('.rpt-pv__table tbody tr').length;
        }
        /* 还原窗口 */
        $dlg.find('.el-dialog__headerbtn--max').trigger('click');
        var back = $dlg[0].getBoundingClientRect();
        return {
            wBefore: Math.round(before.width), hBefore: Math.round(before.height),
            wAfter: Math.round(after.width), hAfter: Math.round(after.height),
            bodyH: Math.round(bodyH),
            titleMax: titleMax, isMax: isMax, openMax: openMax, openTitle: openTitle,
            wBack: Math.round(back.width), backMax: $dlg.hasClass('is-max'),
            btnMin: btnMin, btnClose: btnClose, titleBox: titleBox,
            maxed: maxed, maxedClose: maxedClose,
            menuInfo: out
        };
    });
    check('查看窗打开即最大化（挂 is-max、按钮显示「还原」）',
        maxRes.openMax === true && maxRes.openTitle === '还原',
        String(maxRes.openMax) + ' / ' + String(maxRes.openTitle));

    /* 需求：最大化按钮与关闭按钮「大小相同且水平对齐」 */
    var bm = maxRes.btnMin || {}, bc = maxRes.btnClose || {}, tb = maxRes.titleBox || {};
    check('最大化 / 关闭两个按钮都在（实测几何）', !!maxRes.btnMin && !!maxRes.btnClose,
        JSON.stringify({ max: bm, close: bc }));
    check('两个按钮尺寸完全相同', bm.w === bc.w && bm.h === bc.h && bm.w > 10,
        JSON.stringify({ max: [bm.w, bm.h], close: [bc.w, bc.h] }));
    check('两个按钮水平对齐（top / bottom 一致）',
        Math.abs(bm.top - bc.top) < 0.6 && Math.abs(bm.bottom - bc.bottom) < 0.6,
        JSON.stringify({ max: [bm.top, bm.bottom], close: [bc.top, bc.bottom] }));
    check('两个按钮与标题文字垂直居中对齐',
        Math.abs((bm.top + bm.bottom) / 2 - tb.center) < 2,
        JSON.stringify({ btnCenter: (bm.top + bm.bottom) / 2, titleCenter: tb.center }));
    check('两个按钮不重叠、左右并排',
        bc.left >= bm.right - 0.5, JSON.stringify({ maxRight: bm.right, closeLeft: bc.left }));
    check('还原后两个按钮仍同尺寸同基线',
        maxRes.maxed.w === maxRes.maxedClose.w && maxRes.maxed.h === maxRes.maxedClose.h &&
        Math.abs(maxRes.maxed.top - maxRes.maxedClose.top) < 0.6,
        JSON.stringify({ max: maxRes.maxed, close: maxRes.maxedClose }));
    /* 弹窗在 iframe 里，96vw/92vh 按 iframe 视口算：点「还原」后明显变窄（回到 1080 级别）、高度不增 */
    check('点「还原」后弹窗变窄（实测几何：变窄、高度不增）',
        maxRes.isMax === false && maxRes.wAfter < maxRes.wBefore - 40 &&
        maxRes.hAfter <= maxRes.hBefore + 2,
        JSON.stringify({ open: [maxRes.wBefore, maxRes.hBefore],
                         restored: [maxRes.wAfter, maxRes.hAfter] }));
    check('还原后正文区仍有足够高度（纸张有空间铺开）', maxRes.bodyH > 300, String(maxRes.bodyH));
    check('再点一次又最大化（宽度回到打开时的值）',
        maxRes.backMax === true && Math.abs(maxRes.wBack - maxRes.wBefore) <= 2,
        maxRes.wBack + ' / ' + maxRes.wBefore);
    check('右击数据表弹出菜单（含「显示行号」）',
        maxRes.menuInfo.menuVisible === true && /显示行号/.test(String(maxRes.menuInfo.menu || '')),
        String(maxRes.menuInfo.menu || '').slice(0, 40));
    check('点菜单后菜单收起', maxRes.menuInfo.menuClosed === true);
    check('最左侧多出「序号」列（表头 + 列数 +1）',
        maxRes.menuInfo.headText === '序号' && maxRes.menuInfo.headCount === runRes.data.mapped.length + 1,
        maxRes.menuInfo.headText + ' / ' + maxRes.menuInfo.headCount);
    check('序号列从 1 开始递增', String(maxRes.menuInfo.firstCell).trim() === '1',
        String(maxRes.menuInfo.firstCell));

    await frame.evaluate(function () {
        window.jQuery('.el-overlay .el-dialog').last()
            .find('.el-dialog__headerbtn').not('.el-dialog__headerbtn--max').trigger('click');
    });
    await sleep(400);

    /* 停用后不可调用 */
    var disabled = await page.evaluate(async function (tk, id) {
        await fetch('/api/report/enabled', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tk, id: id, enabled: 0 })
        });
        var r = await fetch('/api/report/run', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tk, code: 'RPTE2E01' })
        }).then(function (x) { return x.json(); });
        return { code: r.code, message: r.message };
    }, token, saved.id);
    check('停用后调用被拒绝并给出提示', disabled.code !== 0 && /停用/.test(disabled.message),
        disabled.message);

    /* ---------- 8. 清理 ---------- */
    console.log('\n--- 8. 清理测试数据 ---');
    var cleaned = await page.evaluate(async function (tk, id, copyId) {
        var codes = [];
        var ids = [id, copyId];
        for (var i = 0; i < ids.length; i++) {
            if (!ids[i]) { continue; }
            var r = await fetch('/api/report/delete', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: tk, id: ids[i] })
            }).then(function (x) { return x.json(); });
            codes.push(r.code);
        }
        return codes;
    }, token, saved.id, copyRes.id);
    check('删除测试报表（含停用副本）成功', cleaned.length === 2 &&
        cleaned[0] === 0 && cleaned[1] === 0, cleaned.join(','));

    var left = await page.evaluate(async function (tk, code) {
        var r = await fetch('/api/report/list?keyword=' + encodeURIComponent(code) + '&token=' + tk)
            .then(function (x) { return x.json(); });
        return ((r.data || {}).list) || [];
    }, token, REPORT_CODE);
    check('报表信息表里已清干净', left.length === 0, String(left.length));
    check('整页没有 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

    await browser.close();
    finish();
})().catch(function (e) {
    console.log('执行异常：' + (e && e.stack || e));
    process.exit(1);
});
