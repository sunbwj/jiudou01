/* ==========================================================================
   requirement-test.js —— 项目管理 · 需求管理（requirement.html）jsdom 回归
   --------------------------------------------------------------------------
   本次重点：结果网格「吃满页面剩余高度 + 记录不够用空行补」。
   jsdom 没有真实布局（clientHeight / offsetHeight 恒为 0），所以这里在
   HTMLElement.prototype 上打桩把「表格区 515 / 表头 46 / 行高 44」喂进去，
   再触发 resize，就能验证 layoutRows() 算出来的行高与空行数。

   覆盖：
     ① 静态：页面 style 里的 flex 链（.table-card > .el-card__body）、
        .table-wrapper 的 height:0、脚本里的常量与 ES5 写法；
     ② 首屏：4 条数据渲染、无空行（jsdom 量不到高度时不乱补）、分页共 4 条；
     ③ 高度自适应：按可用高度算每页条数（7 条/页）、行高拉到 64、
        补 3 行空行、行高 + 空行 = 可用高度（不留缝也不溢出）；
     ④ 空态：tr.empty-row + colspan=12，且空态块被撑到表格区高度；
     ⑤ 窄屏（<=768 卡片模式）：清掉空行、恢复自然行高；
     ⑥ 数据超出一页：自动降每页条数并重新取数（不会先渲染再挤压）。
   运行：NODE_PATH=C:/Users/chx/.workbuddy/binaries/node/workspace/node_modules node tools/requirement-test.js
   ========================================================================== */
'use strict';
process.on('unhandledRejection', function () { /* 页面里的异步桩不影响结论 */ });
var fs = require('fs');
var path = require('path');
var JSDOM = (function () { try { return require('jsdom').JSDOM; } catch (e) { return null; } })();

var ROOT = path.resolve(__dirname, '..');
var pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(cond, ms) {
    var end = Date.now() + (ms || 2500);
    while (Date.now() < end) {
        if (cond()) { return true; }
        await wait(20);
    }
    return false;
}

if (!JSDOM) { console.log('未安装 jsdom，跳过'); process.exit(0); }

/* ---------------- 造需求数据 ---------------- */
function makeReq(n) {
    var list = [];
    for (var i = 0; i < n; i++) {
        list.push({
            id: 'REQ' + (1001 + i), reqCode: 'REQ00010' + i,
            title: '冒烟需求 ' + (i + 1), projectId: '', projectName: '',
            requesterName: '系统管理员', priority: '中', status: i % 2 ? '已通过' : '待评估',
            estimatedHours: i % 2 ? 8 : 0, planId: '', planCode: '', planName: '',
            evalCount: i, createTime: '2026-11-12 10:0' + i + ':00'
        });
    }
    return list;
}

/* ---------------- 打桩：给 jsdom 喂一套假的高度 ---------------- */
var metrics = { wrap: 515, head: 46, row: 44 };
function stubMetrics(win) {
    var P = win.HTMLElement.prototype;
    function heightOf(el) {
        var tag = (el.tagName || '').toUpperCase();
        if (el.id === 'reqTableWrap') { return metrics.wrap; }
        if (tag === 'THEAD') { return metrics.head; }
        if (tag === 'TR') { return metrics.row; }
        return 0;
    }
    function def(prop, fn) {
        try {
            Object.defineProperty(P, prop, { configurable: true, get: function () { return fn(this); } });
        } catch (e) { /* 老 jsdom 上不可重定义就跳过（断言会以「量不到高度」为准） */ }
    }
    def('clientHeight', heightOf);
    /* jQuery 的 height() 在 computed 为 auto 时回落到 offsetHeight，所以这里也要给表格区 */
    def('offsetHeight', heightOf);
    /* jQuery 3.7 的 curCSS 对 width/height 会走 getBoundingClientRect（jsdom 恒为 0），
       不打这个桩 height() 永远是 0，layoutRows 就会被 avail<=0 挡住 */
    try {
        win.Element.prototype.getBoundingClientRect = function () {
            var h = heightOf(this);
            return { top: 0, left: 0, right: 1200, bottom: h, width: 1200, height: h, x: 0, y: 0 };
        };
    } catch (e) { /* 忽略 */ }
}

/* jQuery 的 height() 读的是 computed style（jsdom 里是 0px），
   所以「页面真的有高度」这一步靠给表格区写一个 inline height 来模拟 ——
   等价于真机上 flex 分给 .table-wrapper 的那 515px */
function setWrapHeight(win, px) {
    var el = win.document.getElementById('reqTableWrap');
    if (el) { el.style.height = px > 0 ? px + 'px' : ''; }
}

function boot(list) {
    var dom = new JSDOM(read('requirement.html'), {
        url: 'http://127.0.0.1:8808/requirement.html',
        runScripts: 'outside-only', pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'mock-token', user: { empId: 1, nameCn: '系统管理员' }
    }));
    win.eval(read('js/api.js'));
    win.Api.config.useMock = true;

    /* 需求池没有 Mock 数据（真实后端才有的表），这里直接替换两个接口 */
    var store = { list: list, calls: [], pageSize: 0 };
    win.Api.project.page = function () {
        var d = win.$.Deferred();
        d.resolve({ list: [], total: 0 });
        return d.promise();
    };
    win.Api.requirement.page = function (params) {
        store.calls.push({ pageNum: params.pageNum, pageSize: params.pageSize });
        store.pageSize = params.pageSize;
        var d = win.$.Deferred();
        var size = parseInt(params.pageSize, 10) || 10;
        var start = ((parseInt(params.pageNum, 10) || 1) - 1) * size;
        d.resolve({ list: store.list.slice(start, start + size), total: store.list.length, pageNum: params.pageNum });
        return d.promise();
    };

    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/btnperm.js'));
    stubMetrics(win);
    win.eval(read('js/requirement.js'));
    return { win: win, store: store };
}

function dataRows(doc) { return doc.querySelectorAll('#reqTbody tr[data-id]'); }
function blanks(doc) { return doc.querySelectorAll('#reqTbody tr.blank-row'); }
function firstTdHeight(doc) {
    var tr = dataRows(doc)[0];
    var td = tr && tr.querySelector('td');
    return td ? (td.style.height || '') : '';
}
function fillSum(doc) {
    /* 行高 + 空行高（含最后一条的余数）合计，用来验证「恰好等于可用高度」 */
    var sum = 0, i;
    var rows = doc.querySelectorAll('#reqTbody tr');
    for (i = 0; i < rows.length; i++) {
        var td = rows[i].querySelector('td');
        sum += parseInt((td && td.style.height) || '0', 10) || 0;
    }
    return sum;
}

(async function () {
    /* ================= 1. 静态：样式链与脚本约定 ================= */
    console.log('\n--- 1. 静态资源与页面骨架 ---');
    var html = read('requirement.html');
    var pageJs = read('js/requirement.js');

    var mediaBlock = (html.match(/@media screen and \(min-width: 769px\) \{[\s\S]*?\n\}/g) || []).join('\n');
    check('页面 style 里有 >=769px 的布局块', /\.table-card > \.el-card__body/.test(mediaBlock),
        mediaBlock.slice(0, 80));
    check('.table-card > .el-card__body 设为纵向 flex 并吃满（flex:1 1 auto / column / min-height:0）',
        /\.table-card > \.el-card__body \{[\s\S]*?flex: 1 1 auto[\s\S]*?flex-direction: column[\s\S]*?min-height: 0/.test(html));
    check('带 -ms- / -webkit- 旧浏览器前缀（与全站一致）',
        /-ms-flex-direction: column/.test(mediaBlock) && /-webkit-box-orient: vertical/.test(mediaBlock));
    check('工具栏不参与伸缩（flex: 0 0 auto）',
        /\.table-card > \.el-card__body > \.toolbar \{[^}]*flex: 0 0 auto/.test(html));
    check('.table-wrapper 用 height:0 把 flex-basis 归零（内容再多也不撑高卡片）',
        /\.table-card \.table-wrapper \{[^}]*height: 0/.test(html));
    check('表头 sticky 与「表格区唯一滚动容器」沿用 app.css，不在本页重复定义',
        !/\.table-wrapper \{[^}]*position: sticky/.test(html));

    check('脚本里 COLS = 12（空行 / 空态 colspan 与表头一致）', /var COLS = 12;/.test(pageJs));
    check('有 layoutRows()：行高拉伸 + 空行补位',
        /function layoutRows\(\)/.test(pageJs) && /blank-row/.test(pageJs));
    check('有 calcPageSize()：按可用高度算每页条数', /function calcPageSize\(\)/.test(pageJs));
    check('首次渲染前预留分页条高度（PAGER_H）',
        /var PAGER_H = \d+;/.test(pageJs) && /\$pager\.outerHeight\(\) \|\| PAGER_H/.test(pageJs));
    check('MAX_ROW_H 只限制拉伸、不压缩自然行高',
        /rowH > MAX_ROW_H && naturalH <= MAX_ROW_H/.test(pageJs));
    check('用户手动选过条数后不再自动算（autoSize = false）',
        /if \(size !== state\.pageSize\) \{ autoSize = false; \}/.test(pageJs));
    check('绑定 resize（150ms 节流）与 window load 兜底',
        /\.on\('resize'/.test(pageJs) && /\.on\('load'/.test(pageJs));
    check('脚本是 ES5（无 let / const / 箭头 / 模板串）',
        !/\b(let|const)\s/.test(pageJs) && !/=>/.test(pageJs) && pageJs.indexOf('`') < 0);
    check('页面级脚本版本已升到 20261112a 之后',
        /js\/requirement\.js\?v=20261112a/.test(html), (html.match(/requirement\.js\?v=[0-9a-z]+/) || [])[0]);

    /* ================= 2. 首屏渲染 ================= */
    console.log('\n--- 2. 首屏渲染（4 条数据） ---');
    var b = boot(makeReq(4));
    var win = b.win, doc = win.document;
    await until(function () { return dataRows(doc).length === 4; });
    check('渲染 4 行数据', dataRows(doc).length === 4, dataRows(doc).length);
    check('jsdom 量不到高度时不乱补空行（avail <= 0 直接返回）', blanks(doc).length === 0, blanks(doc).length);
    check('分页显示共 4 条', (doc.querySelector('#reqPager .el-pagination__total') || {}).textContent === '共 4 条',
        (doc.querySelector('#reqPager .el-pagination__total') || {}).textContent);
    check('首次请求带回 pageSize（默认 10）', b.store.calls.length > 0 && b.store.pageSize === 10, b.store.pageSize);

    /* ================= 3. 高度自适应（假装表格区 515px / 表头 46 / 行高 44） ================= */
    console.log('\n--- 3. 高度自适应：条数 / 行高 / 空行 ---');
    setWrapHeight(win, metrics.wrap);          // 真机上这 515px 是 flex 分给 .table-wrapper 的
    win.dispatchEvent(new win.Event('resize'));
    await wait(120);
    await wait(320);                        // resize handler 节流 150ms + 渲染后 30ms 再量
    await until(function () { return blanks(doc).length > 0; }, 2000);

    // 可用高度 = 515 - 46 = 469；条数 = floor((469-69)/44) = 9（44 是桩出来的自然行高）
    check('按可用高度算出每页 9 条（(469-69)/44）', b.store.pageSize === 9, b.store.pageSize);
    check('数据只有 4 条时仍只渲染 4 行（不补假数据）', dataRows(doc).length === 4, dataRows(doc).length);
    check('行高拉高到上限 64px', firstTdHeight(doc) === '64px', firstTdHeight(doc));
    check('补了 3 行空行（469 - 4×64 = 213 → 64+64+85）', blanks(doc).length === 3, blanks(doc).length);
    check('空行不带 data-id（不会被行点击 / 选中逻辑命中）',
        Array.prototype.every.call(blanks(doc), function (tr) { return !tr.hasAttribute('data-id'); }));
    check('行高 + 空行高 = 可用高度 469（无留白、无溢出）', fillSum(doc) === 469, fillSum(doc));
    check('最后一条空行吃掉余数（85px）',
        (blanks(doc)[blanks(doc).length - 1].querySelector('td').style.height) === '85px',
        blanks(doc)[blanks(doc).length - 1].querySelector('td').style.height);
    check('空行 colspan = 12（与表头列数一致）',
        (blanks(doc)[0].querySelector('td').getAttribute('colspan')) === '12',
        blanks(doc)[0].querySelector('td').getAttribute('colspan'));
    check('分页条插入了自动算出的「9条/页」选项',
        !!doc.querySelector('#reqPager .page-size option[value="9"]'));

    /* ================= 4. 空态 ================= */
    console.log('\n--- 4. 空态（无数据） ---');
    b.store.list = [];
    doc.getElementById('reqBtnRefresh').click();
    await until(function () { return !!doc.querySelector('#reqTbody tr.empty-row'); });
    win.dispatchEvent(new win.Event('resize'));
    await wait(300);
    var emptyTd = doc.querySelector('#reqTbody tr.empty-row > td');
    check('空态行带 .empty-row（旧实现没有这个类，补空行时会被误当数据行）', !!emptyTd);
    check('空态 colspan = 12', emptyTd && emptyTd.getAttribute('colspan') === '12',
        emptyTd && emptyTd.getAttribute('colspan'));
    check('空态块撑到表格区高度（469px）', emptyTd && emptyTd.style.height === '469px',
        emptyTd && emptyTd.style.height);
    check('空态下不补空行（没有数据行可拉伸）', blanks(doc).length === 0, blanks(doc).length);

    /* ================= 5. 窄屏：卡片模式不参与自适应 ================= */
    console.log('\n--- 5. 窄屏（<=768 卡片模式） ---');
    b.store.list = makeReq(4);
    doc.getElementById('reqBtnRefresh').click();
    await until(function () { return dataRows(doc).length === 4; });
    win.dispatchEvent(new win.Event('resize'));
    await until(function () { return blanks(doc).length === 3; }, 2000);
    Object.defineProperty(win, 'innerWidth', { configurable: true, value: 700 });
    win.dispatchEvent(new win.Event('resize'));
    await wait(260);
    check('窄屏下清掉空行（表格转卡片，靠页面滚动）', blanks(doc).length === 0, blanks(doc).length);
    check('窄屏下不残留行高（td 无 style.height）', firstTdHeight(doc) === '', firstTdHeight(doc));

    /* ================= 6. 数据超出一页：降条数重取 ================= */
    console.log('\n--- 6. 数据超出一页：自动降每页条数 ---');
    Object.defineProperty(win, 'innerWidth', { configurable: true, value: 1400 });
    b.store.list = makeReq(20);
    doc.getElementById('reqBtnRefresh').click();
    await until(function () { return dataRows(doc).length === 9; }, 3000);
    check('一次只取一页 9 条（先算条数再取数，不先渲染再挤压）', dataRows(doc).length === 9, dataRows(doc).length);
    check('分页总数为 20', (doc.querySelector('#reqPager .el-pagination__total') || {}).textContent === '共 20 条',
        (doc.querySelector('#reqPager .el-pagination__total') || {}).textContent);

    console.log('\n结果：通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
})();
