/* ==========================================================================
   help-page-test.js —— 使用说明书页面测试（jsdom，Mock 通道）
   覆盖：目录渲染（11 章 / 小节数与数据一致）/ 正文渲染（章节与 meta 统计）/
        目录检索过滤 / 附录页面速查（全量、过滤、章节反查）/ 功能地图（读 nav，
        Mock 下应渲染出菜单表或明确的兜底提示，不能停在「正在读取」）/
        按钮容器约定（打印按钮不能放进 .toolbar，否则会被 btnperm 隐藏）/
        数据自检（PAGES.ch 必须指向存在的章节、章内小节 id 不重复）
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/help-page-test.js
   ========================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
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

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再装）');
    process.exit(0);
}

function boot() {
    var dom = new JSDOM(read('help.html'), {
        url: 'http://127.0.0.1:8808/help.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.jQuery.ajax = function () {
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/help.js'));
    return win;
}

function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* jsdom 没有布局：jQuery 的 :visible 恒为 false，这里按内联 display 判断 */
function shown($el) {
    return $el.filter(function () { return this.style.display !== 'none'; });
}

(async function main() {
    var win = boot();
    var $ = win.jQuery;
    var doc = win.document;

    /* jQuery ready 在 jsdom 里是异步的，等渲染完成 */
    await wait(400);

    console.log('\n[1] 目录与正文渲染');
    var chCount = $('#helpTocList .help-toc__ch').length;
    var subCount = $('#helpTocList .help-toc__sub').length;
    check('目录渲染 11 章', chCount === 11, '实际 ' + chCount);
    check('目录小节数 > 40', subCount > 40, '实际 ' + subCount);
    check('正文渲染 11 个章节块', doc.querySelectorAll('#helpDocBody .help-chapter').length === 11);
    check('每个章节都有标题', doc.querySelectorAll('#helpDocBody .help-chapter__title').length === 11);
    check('meta 显示覆盖页面数', /覆盖页面/.test($('.help-meta').text()));
    check('目录提示显示章节数', /共 11 章/.test($('#helpTocHint').text()), $('#helpTocHint').text());

    console.log('\n[2] 目录检索');
    $('#helpTocSearch').val('工单').trigger('input');
    var visibleCh = shown($('#helpTocList .help-toc__ch')).length;
    check('检索「工单」后只剩相关章节', visibleCh > 0 && visibleCh < 11, '可见 ' + visibleCh);
    check('检索后提示命中数', /命中 \d+ 个小节/.test($('#helpTocHint').text()), $('#helpTocHint').text());
    $('#helpTocSearch').val('绝对不存在的关键字xyz').trigger('input');
    check('无结果时显示空提示', doc.getElementById('helpTocEmpty').style.display !== 'none');
    $('#helpTocSearch').val('').trigger('input');
    check('清空后恢复全部章节', shown($('#helpTocList .help-toc__ch')).length === 11);

    console.log('\n[3] 附录 · 页面速查');
    var total = PAGES_TOTAL();
    function PAGES_TOTAL() { return $('#helpPageBody tr').length; }
    check('页面速查渲染全部页面', total > 30, '实际 ' + total);
    check('计数与表格行数一致', $('#helpPageCount').text().indexOf(String(total)) >= 0, $('#helpPageCount').text());
    $('#helpPageFilter').val('workplan').trigger('input');
    var filtered = $('#helpPageBody tr').length;
    check('过滤 workplan 命中若干行', filtered >= 3 && filtered < total, '命中 ' + filtered);
    check('过滤后仍带文档链接', $('#helpPageBody a[data-jump]').length > 0);
    $('#helpPageFilter').val('').trigger('input');
    check('清空过滤恢复全量', $('#helpPageBody tr').length === total);

    console.log('\n[4] 功能地图（读 /api/nav，Mock 通道）');
    await wait(300);
    var mapHtml = $('#helpNavMap').html() || '';
    var navRows = $('#helpNavMap tbody tr').length;
    check('不再是「正在读取」占位', mapHtml.indexOf('正在读取') < 0);
    check('渲染出菜单表或兜底提示', navRows > 0 || /未读到实时菜单/.test(mapHtml), mapHtml.slice(0, 60));
    if (navRows > 0) {
        check('功能地图行数 > 0', navRows > 0, '实际 ' + navRows);
        check('功能地图带文档列链接', $('#helpNavMap a[data-jump]').length > 0);
    } else {
        check('兜底提示说明原因', /未读到实时菜单/.test(mapHtml));
    }

    console.log('\n[5] 结构与约定自检');
    check('打印按钮不在 .toolbar 内（否则会被按钮权限隐藏）',
        doc.querySelectorAll('.toolbar #btnHelpPrint').length === 0 &&
        doc.querySelectorAll('.help-tools #btnHelpPrint').length === 1);
    check('页面没有任何 .toolbar 容器', doc.querySelectorAll('.toolbar').length === 0);
    check('引用 help.css 带版本号', /css\/help\.css\?v=/.test(read('help.html')));
    check('引用 help.js 带版本号', /js\/help\.js\?v=/.test(read('help.html')));

    /* 数据自检：用页面内渲染结果反查（不重复解析 JS 源码） */
    var anchorIds = {};
    var dup = 0;
    var secEls = doc.querySelectorAll('#helpDocBody .help-sec');
    for (var i = 0; i < secEls.length; i++) {
        var id = secEls[i].id;
        if (anchorIds[id]) { dup++; }
        anchorIds[id] = 1;
    }
    check('正文小节锚点 id 无重复', dup === 0, '重复 ' + dup);
    var links = doc.querySelectorAll('#helpPageBody a[data-jump]');
    var badJump = 0;
    for (var j = 0; j < links.length; j++) {
        var target = links[j].getAttribute('data-jump');
        if (!doc.getElementById(target)) { badJump++; }
    }
    check('页面速查的章节链接全部可跳转', badJump === 0, '失效 ' + badJump);

    console.log('\n结果：' + (fail === 0 ? '通过 ' + pass + ' 项' : '通过 ' + pass + ' 项 / 失败 ' + fail + ' 项'));
    process.exit(fail === 0 ? 0 : 1);
})().catch(function (err) {
    console.log('运行异常：' + (err && err.stack || err));
    process.exit(1);
});
