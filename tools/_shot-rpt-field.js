/* 临时截图脚本：报表设计器「按字段加入」（表只展开、字段双击/拖入才加列），截完即删 */
'use strict';
var puppeteer = require('puppeteer-core');

var EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
var BASE = 'http://127.0.0.1:8808';
var KEY = 'menu_admin_login_v1';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function main() {
    var browser = await puppeteer.launch({
        executablePath: EDGE, headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,1000']
    });
    var page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });

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
            body: JSON.stringify({ account: account, password: password,
                captchaId: (cap.data || {}).captchaId, captchaCode: solve((cap.data || {}).question) })
        });
        return ((await res.json()).data || {}).token || '';
    }, '15724887807', '888888');

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
            expireAt: now + 8 * 3600 * 1000, ttlHours: 8, user: { account: 'shot', empName: '截图' }
        }));
    }, KEY, token);

    await page.goto(BASE + '/main.html#report-designer.html', { waitUntil: 'domcontentloaded' });
    await sleep(3200);
    var frame = null;
    for (var i = 0; i < 30 && !frame; i++) {
        frame = page.frames().filter(function (f) {
            return f !== page.mainFrame() && /report-designer\.html$/.test(f.url());
        })[0] || null;
        if (!frame) { await sleep(200); }
    }
    if (!frame) { console.log('没拿到设计器 frame'); await browser.close(); process.exit(1); }

    /* 新建一张报表（空画布），选连接 → 库 → 展开一张表 */
    var info = await frame.evaluate(function () {
        var $ = window.jQuery;
        window.RptDesigner.newReport();
        window.RptDesigner.setLeftTab('source');
        var conn = '';
        $('#srcConn option').each(function () {
            if (!conn && $(this).val()) { conn = $(this).val(); }
        });
        $('#srcConn').val(conn).trigger('change');
        return { conn: conn };
    });
    await sleep(2500);
    var dbOpt = await frame.evaluate(function () {
        var $ = window.jQuery;
        var val = '';
        $('#srcDb option').each(function () {
            if (!val && $(this).val()) { val = $(this).val(); }
        });
        if (val) { $('#srcDb').val(val).trigger('change'); }
        return val;
    });
    await sleep(2500);

    /* 直接双击第一张表（真实鼠标），验证只展开不加列 */
    var dbg = await frame.evaluate(function () {
        var $ = window.jQuery;
        return { conn: $('#srcConn').val(), db: $('#srcDb').val(),
                 connOpts: $('#srcConn option').length, dbOpts: $('#srcDb option').length,
                 tree: ($('#srcTree').text() || '').replace(/\s+/g, ' ').slice(0, 120) };
    });
    console.log('[DBG]', JSON.stringify(dbg));
    var rowHandle = null;
    var rows = await frame.$$('#srcTree .el-tree-node[data-kind="table"] > .rpt-node__row');
    if (!rows.length) { rows = await frame.$$('#srcTree .rpt-node__row'); }
    if (rows.length) { rowHandle = rows[0]; }
    var before = await frame.evaluate(function () { return window.RptDesigner.columns().length; });
    if (rowHandle) {
        await rowHandle.evaluate(function (el) { el.scrollIntoView({ block: 'center' }); });
        await sleep(300);
        await page.mouse.move(0, 0);
        var box = await rowHandle.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
        await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
    }
    await sleep(3000);
    var afterExpand = await frame.evaluate(function () {
        var $ = window.jQuery;
        return { cols: window.RptDesigner.columns().length,
                 fields: $('#srcTree .rpt-node--field').length,
                 toast: $('.el-message-list').text(),
                 table: ($('#srcTree .el-tree-node.is-open .rpt-node__name').first().text() || '') };
    });
    console.log('双击表：列数 ' + before + ' -> ' + afterExpand.cols +
        '，展开字段 ' + afterExpand.fields + ' 个，提示「' + afterExpand.toast + '」');

    /* 双击 3 个字段 → 加 3 列 */
    var added = await frame.evaluate(function () {
        var $ = window.jQuery;
        var n = Math.min(3, $('#srcTree .rpt-node--field').length);
        var names = [];
        for (var i = 0; i < n; i++) {
            var $f = $('#srcTree .rpt-node--field').eq(i);
            names.push($f.attr('data-field'));
            $f.trigger('dblclick');
        }
        return { n: n, names: names.join(','), cols: window.RptDesigner.columns().length };
    });
    await sleep(1500);
    console.log('双击字段：' + added.names + ' → 画布 ' + added.cols + ' 列');

    await page.screenshot({ path: 'tools/rpt-field-drag-shot.png' });
    console.log('截图完成 tools/rpt-field-drag-shot.png');
    await browser.close();
    process.exit(0);
})().catch(function (e) { console.error(e); process.exit(1); });
