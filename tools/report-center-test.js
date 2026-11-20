/* ==========================================================================
   report-center-test.js —— 数据中心 · 报表中心页测试（jsdom，Mock 通道）
   覆盖：
        ① 首屏骨架：标题 / 面包屑 / 侧边栏高亮；主区**上（检索）下（卡片列表）**两块；
        ② 检索区：关键词 + 分类 + 查询 / 重置；**没有状态下拉**（只查启用）；
        ③ 卡片列表：只渲染启用报表（Mock 里 RPT0002 是停用的，不该出现）；
           卡片内容（名称 / 编码 / 启用 / 分类 / 纸张 / 说明 / 数据源 / 列数参数 / 调用 / 最近运行 / 查看）；
        ④ 检索：关键词（编码 / 名称 / 英文名 / 主表 / 说明，不区分大小写）、分类、重置、回车；
        ⑤ 空态：有关键词时「没有匹配的报表」、无启用报表时「还没有已启用的报表」；
        ⑥ 分页：默认 12 条/页、翻页、每页条数切换；
        ⑦ **双击**卡片 → 共享的查看窗（默认最大化；标题 / 参数控件 / 执行查询 / 结果表 / 打印导出按钮），单击不打开；
        ⑧ 停用的报表不出现、也不能从查看窗运行。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/report-center-test.js
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
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

/* 页面自己引的脚本（核心库手动 eval，其余照 html 顺序 —— 以后加模块不用再改测试） */
var CORE_SCRIPTS = {
    'vendor/jquery-3.7.1.min.js': 1, 'js/theme.js': 1, 'js/icons.js': 1,
    'js/api.js': 1, 'js/ui.js': 1, 'js/layout.js': 1
};
function pageScripts(page) {
    var html = read(page), out = [], re = /<script[^>]*src="([^"]+)"/g, m;
    while ((m = re.exec(html))) {
        if (/^(https?:)?\/\//.test(m[1])) { continue; }     // IE 条件注释里的 CDN 垫片
        var src = m[1].split('?')[0];
        if (!CORE_SCRIPTS[src]) { out.push(src); }
    }
    return out;
}

function boot(page, scripts) {
    scripts = scripts || pageScripts(page);
    var dom = new JSDOM(read(page), {
        url: 'http://127.0.0.1:8808/' + page,
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.jQuery.ajax = function () {           // 没有后端 → api.js 自动回退 Mock
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

var win = boot('report-center.html');
var $ = win.jQuery;
var Api = win.Api;
var C = function () { return win.ReportCenter; };
var V = function () { return win.ReportViewer; };

function cards() { return $('#rcGrid .rc-card'); }
function dialog() { return $('.el-overlay .el-dialog').last(); }
function dialogBody() { return dialog().find('.el-dialog__body'); }
function toast() { return $('.el-message-list').text(); }
function codes() {
    var out = [];
    cards().each(function () { out.push($(this).attr('data-code')); });
    return out.join(',');
}
function cardOf(code) { return $('#rcGrid .rc-card[data-code="' + code + '"]'); }

/* 模拟在检索框输入并点查询 */
function doSearch(kw, category) {
    $('#rcKeyword').val(kw === undefined ? '' : kw);
    if (category !== undefined) { $('#rcCategory').val(category); }
    $('#btnRcSearch').trigger('click');
}

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 700 }); }
function next() {
    var s = steps.shift();
    if (!s) { return finish(); }
    try { s.fn(); } catch (e) { check('步骤执行异常：' + e.message, false, e.stack); }
    setTimeout(next, s.delay);
}
function finish() {
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}

/* ------------------------------- 用例 ------------------------------- */
step(function () {
    console.log('\n--- 1. 首屏骨架：上检索 / 下列表 ---');
    check('页面标题为「报表中心」', $('.page-head__title').text() === '报表中心',
        $('.page-head__title').text());
    check('面包屑为「数据中心/报表中心」', $('#pageHead').attr('data-crumb') === '数据中心/报表中心',
        $('#pageHead').attr('data-crumb'));
    check('左侧导航高亮「报表中心」', /报表中心/.test($('.app-side__item.is-active').text()),
        $('.app-side__item.is-active').text().replace(/\s+/g, ''));
    check('侧边栏「报表中心」指向 report-center.html',
        $('.app-side__item.is-active').attr('href') === 'report-center.html',
        $('.app-side__item.is-active').attr('href'));

    var $main = $('.app-main');
    check('主区挂着 .rc-page（报表中心专用样式）', $main.hasClass('rc-page'));
    var iSearch = $('#rcSearch').index(), iList = $('#rcList').index();
    check('主区同时有检索区与卡片列表区', iSearch >= 0 && iList >= 0, iSearch + '/' + iList);
    check('检索区在上、卡片列表在下（DOM 顺序）', iSearch < iList, iSearch + ' vs ' + iList);
    check('分页条在页面最下面', $('#rcPager').index() > iList, String($('#rcPager').index()));
    // 「去说明卡」后 .page-head__hint 整段被注释掉（report-center.html 第 74 行），
    // 「只显示启用报表」的说明改由检索区下方文字承担（下一节有断言）。
    check('页头不再挂说明卡（去说明卡后提示下沉到检索区）',
        $('#pageHead .page-head__hint').length === 0,
        String($('#pageHead .page-head__hint').length));
});

step(function () {
    console.log('\n--- 2. 检索区：关键词 + 分类，没有状态下拉 ---');
    check('有关键词输入框（带搜索图标）', $('#rcKeyword').length === 1 &&
        $('#rcSearch .el-input__prefix').length >= 1);
    check('关键词占位符说明搜哪些字段',
        /编码/.test($('#rcKeyword').attr('placeholder')) &&
        /名称/.test($('#rcKeyword').attr('placeholder')),
        $('#rcKeyword').attr('placeholder'));
    check('有分类下拉', $('#rcCategory').length === 1 && $('#rcCategory').is('select'));
    check('有「查询」按钮', $('#btnRcSearch').length === 1 &&
        $('#btnRcSearch').text().replace(/\s/g, '') === '查询');
    check('有「重置」按钮', $('#btnRcReset').length === 1 &&
        $('#btnRcReset').text().replace(/\s/g, '') === '重置');
    check('检索区只有 1 个下拉（分类），没有状态下拉',
        $('#rcSearch select').length === 1, String($('#rcSearch select').length));
    check('检索区没有 enabled 相关控件',
        $('#rcSearch [name="enabled"], #rcSearch #rcEnabled').length === 0);
    check('检索区下方说明「只显示启用状态的报表」',
        /只显示/.test($('#rcSearch .rc-search__tip').text()) &&
        /启用状态/.test($('#rcSearch .rc-search__tip').text()),
        $('#rcSearch .rc-search__tip').text().replace(/\s+/g, ' ').slice(0, 40));
});

step(function () {
    console.log('\n--- 3. 卡片列表：只渲染启用报表 ---');
    check('只出现 1 张卡片（Mock 另一张 RPT0002 是停用的）', cards().length === 1,
        String(cards().length) + ' → ' + codes());
    check('出现的是 RPT0001 员工花名册', codes() === 'RPT0001', codes());
    check('停用的 RPT0002 邮件收发统计没有出现', codes().indexOf('RPT0002') < 0, codes());
    check('右上角总数为 1', $('#rcTotal').text() === '1', $('#rcTotal').text());
    check('列表可见、空态隐藏', !$('#rcGrid').prop('hidden') && $('#rcEmpty').prop('hidden'));

    var $c = cardOf('RPT0001');
    check('卡片在 .rc-grid 里', $c.parent().is('#rcGrid'));
    check('卡片有 role=button 与 tabindex（可键盘操作）',
        $c.attr('role') === 'button' && $c.attr('tabindex') === '0',
        $c.attr('role') + '/' + $c.attr('tabindex'));
    check('卡片名称是报表名', $c.find('.rc-card__name').text() === '员工花名册',
        $c.find('.rc-card__name').text());
    check('卡片带报表编码标签', $c.find('.rc-card__code').text() === 'RPT0001',
        $c.find('.rc-card__code').text());
    check('卡片有「启用」标签', /启用/.test($c.find('.rc-card__tags').text()),
        $c.find('.rc-card__tags').text().replace(/\s+/g, ' '));
    check('卡片有分类标签「人力资源」', /人力资源/.test($c.find('.rc-card__tags').text()),
        $c.find('.rc-card__tags').text().replace(/\s+/g, ' '));
    check('卡片有纸张标签「A4 / 横向」', /A4/.test($c.find('.rc-card__tags').text()) &&
        /横向/.test($c.find('.rc-card__tags').text()),
        $c.find('.rc-card__tags').text().replace(/\s+/g, ' '));
    check('卡片有功能说明', /按部门列出员工基本信息/.test($c.find('.rc-card__desc').text()),
        $c.find('.rc-card__desc').text());
    var meta = $c.find('.rc-card__meta').text().replace(/\s+/g, ' ');
    check('卡片显示数据源', /九豆主库/.test(meta), meta);
    check('卡片显示「4 列 · 1 参数」', /4 列/.test(meta) && /1 参数/.test(meta), meta);
    check('卡片显示调用次数', /3 次/.test(meta), meta);
    check('卡片底部显示最近运行时间', /最近运行/.test($c.find('.rc-card__time').text()),
        $c.find('.rc-card__time').text());
    check('卡片底部有「双击查看」入口', /双击查看/.test($c.find('.rc-card__go').text()),
        $c.find('.rc-card__go').text().replace(/\s+/g, ' '));
    check('卡片有 aria-label 说明双击能打开报表',
        /双击打开报表/.test($c.attr('aria-label') || ''), $c.attr('aria-label'));
});

step(function () {
    console.log('\n--- 4. 分类下拉：只统计启用报表的分类 ---');
    var html = $('#rcCategory').html();
    check('有「全部分类」选项', /全部分类/.test(html), html.replace(/\s+/g, ' ').slice(0, 60));
    check('含启用报表的分类「人力资源（1）」', /人力资源（1）/.test(html),
        html.replace(/\s+/g, ' ').slice(0, 80));
    check('不含只有停用报表的分类「经营分析」', html.indexOf('经营分析') < 0,
        html.replace(/\s+/g, ' ').slice(0, 80));
    check('默认选中「全部分类」', $('#rcCategory').val() === '', String($('#rcCategory').val()));
});

step(function () {
    console.log('\n--- 5. 关键词检索 ---');
    doSearch('花名册');
}, 900);

step(function () {
    check('按名称搜「花名册」→ 1 张', cards().length === 1, codes());
    check('仍是 RPT0001', codes() === 'RPT0001', codes());
    check('总数同步为 1', $('#rcTotal').text() === '1', $('#rcTotal').text());
    doSearch('employeeroster');         // 英文名 EmployeeRoster，小写（Mock 不区分大小写）
}, 900);

step(function () {
    check('按英文名搜（不区分大小写）→ 命中', codes() === 'RPT0001', codes());
    doSearch('empinfos');              // 主表
}, 900);

step(function () {
    check('按主表搜「empinfos」→ 命中', codes() === 'RPT0001', codes());
    doSearch('离线演示');               // 说明（两张报表都有，但停用的不算）
}, 900);

step(function () {
    check('按说明搜「离线演示」→ 只命中启用的那张', cards().length === 1 && codes() === 'RPT0001',
        String(cards().length) + ' → ' + codes());
    doSearch('邮件');                  // 只有停用的 RPT0002 匹配
}, 900);

step(function () {
    console.log('\n--- 6. 停用报表搜不到 + 空态 ---');
    check('搜「邮件」→ 0 张（停用的查不到）', cards().length === 0, codes());
    check('总数变 0', $('#rcTotal').text() === '0', $('#rcTotal').text());
    check('列表隐藏、空态显示',
        $('#rcGrid').prop('hidden') === true && $('#rcEmpty').prop('hidden') === false);
    check('空态标题是「没有匹配的报表」',
        $('#rcEmpty .rc-empty__title').text() === '没有匹配的报表',
        $('#rcEmpty .rc-empty__title').text());
    check('空态提示说明停用报表不会出现',
        /停用/.test($('#rcEmpty .rc-empty__hint').text()),
        $('#rcEmpty .rc-empty__hint').text());
    check('空态下分页条隐藏', $('#rcPager').prop('hidden') === true);
});

step(function () {
    console.log('\n--- 7. 重置 ---');
    $('#btnRcReset').trigger('click');
}, 900);

step(function () {
    check('重置后关键词清空', $('#rcKeyword').val() === '', '[' + $('#rcKeyword').val() + ']');
    check('重置后分类回到「全部分类」', $('#rcCategory').val() === '', String($('#rcCategory').val()));
    check('重置后恢复 1 张卡片', cards().length === 1 && codes() === 'RPT0001', codes());
    check('重置后总数恢复 1', $('#rcTotal').text() === '1', $('#rcTotal').text());
    check('重置后空态重新隐藏', $('#rcEmpty').prop('hidden') === true);
});

step(function () {
    console.log('\n--- 8. 回车检索 / 分类筛选 ---');
    $('#rcKeyword').val('花名册');
    var e = $.Event('keydown');
    e.keyCode = 13;
    $('#rcKeyword').trigger(e);
}, 900);

step(function () {
    check('回车触发检索', cards().length === 1 && codes() === 'RPT0001', codes());
    $('#rcKeyword').val('');
    $('#rcCategory').val('人力资源').trigger('change');
}, 900);

step(function () {
    check('选分类「人力资源」→ 1 张', cards().length === 1 && codes() === 'RPT0001', codes());
    check('分类筛选写进了状态', C().state.category === '人力资源', C().state.category);
    check('切换分类时页码回到第 1 页', C().state.pageNum === 1, String(C().state.pageNum));
    $('#rcKeyword').val('不存在的报表名');
    $('#btnRcSearch').trigger('click');
}, 900);

step(function () {
    check('关键词 + 分类是「与」关系（搜不到）', cards().length === 0, codes());
    $('#rcKeyword').val('');
    $('#rcCategory').val('');
    $('#btnRcSearch').trigger('click');
}, 900);

step(function () {
    console.log('\n--- 9. 分页（补 13 张启用报表，共 14 张）---');
    check('恢复全量后仍只有 1 张', cards().length === 1, codes());
    var ok = 0, i;
    for (i = 0; i < 13; i++) {
        Api.report.add({
            reportName: '压测报表' + (i + 1), category: (i % 2 ? '测试分类' : '人力资源'),
            connId: 'db-0000-4000-8000-000000000001', databaseName: 'jiudou_main',
            mainTable: 'empinfos', description: '分页用临时报表', enabled: true
        }).done(function () { ok++; });
    }
}, 1600);

step(function () {
    console.log('\n--- 10. 分页翻页 ---');
    C().load();
}, 900);

step(function () {
    check('默认每页 12 条', C().state.pageSize === 12, String(C().state.pageSize));
    check('第一页渲染 12 张卡片', cards().length === 12, String(cards().length));
    check('总数 14', $('#rcTotal').text() === '14', $('#rcTotal').text());
    check('分页条可见', $('#rcPager').prop('hidden') === false);
    check('分页器按 12 条/页选项渲染', /12条\/页/.test($('#rcPager').html()),
        ($('#rcPager').html() || '').replace(/\s+/g, ' ').slice(0, 80));
    check('分页器有 2 个页码', $('#rcPager .el-pager li').length === 2,
        String($('#rcPager .el-pager li').length));
    check('第一页页码处于选中态', $('#rcPager .el-pager li.active').text() === '1',
        $('#rcPager .el-pager li.active').text());
    $('#rcPager .btn-next').trigger('click');
}, 900);

step(function () {
    check('翻到第 2 页', C().state.pageNum === 2, String(C().state.pageNum));
    check('第 2 页剩 2 张卡片', cards().length === 2, String(cards().length));
    check('第 2 页页码高亮', $('#rcPager .el-pager li.active').text() === '2',
        $('#rcPager .el-pager li.active').text());
    $('#rcPager .btn-prev').trigger('click');
}, 900);

step(function () {
    check('上一页回到 12 张', cards().length === 12 && C().state.pageNum === 1,
        String(cards().length) + '/' + C().state.pageNum);
});

step(function () {
    console.log('\n--- 11. 双击卡片打开查看窗（与报表设计器同一套）---');
    check('查看窗模块已加载', !!V() && typeof V().openSaved === 'function');
    $('#rcKeyword').val('员工花名册');
    $('#btnRcSearch').trigger('click');
}, 900);

step(function () {
    check('检索到唯一一张', cards().length === 1 && codes() === 'RPT0001', codes());
    cardOf('RPT0001').trigger('click');          // 单击：不该有任何反应
}, 1200);

step(function () {
    check('单击卡片不会打开查看窗（防误操作）', $('.el-overlay').length === 0,
        String($('.el-overlay').length));
    check('卡片底部提示改成「双击查看」',
        /双击查看/.test(cardOf('RPT0001').find('.rc-card__go').text()),
        cardOf('RPT0001').find('.rc-card__go').text());
    check('卡片带「双击打开报表」的 title 提示',
        /双击打开报表/.test(String(cardOf('RPT0001').attr('title'))),
        String(cardOf('RPT0001').attr('title')));
    cardOf('RPT0001').trigger('dblclick');       // 双击才开
}, 1200);

step(function () {
    check('弹出了查看窗', $('.el-overlay').length >= 1, String($('.el-overlay').length));
    check('查看窗打开即最大化（is-max + 96vw）',
        dialog().hasClass('is-max') && /96vw/.test(dialog()[0].style.width), dialog()[0].style.width);
    check('最大化按钮显示为「还原」',
        dialog().find('.el-dialog__headerbtn--max').attr('title') === '还原',
        dialog().find('.el-dialog__headerbtn--max').attr('title'));
    check('标题是「查看报表 —— 员工花名册（RPT0001）」',
        dialog().find('.el-dialog__title').text() === '查看报表 —— 员工花名册（RPT0001）',
        dialog().find('.el-dialog__title').text());
    check('查看窗标题行显示报表名', $('#pvTitle').text() === '员工花名册', $('#pvTitle').text());
    check('查看窗副标题取设计的 subtitle', /九豆综合管理平台/.test($('#pvSubtitle').text()),
        $('#pvSubtitle').text());
    check('参数区渲染出「部门」控件', /部门/.test($('#pvParams').text()),
        $('#pvParams').text().replace(/\s+/g, ' ').slice(0, 40));
    check('参数区有输入框', $('#pvParams input').length >= 1, String($('#pvParams input').length));
    check('有「执行查询」按钮', $('#pvRun').length === 1 &&
        $('#pvRun').text().replace(/\s/g, '') === '执行查询', $('#pvRun').text());
    check('打开即自动执行（结果表已渲染）', $('#pvBody .rpt-pv__table').length >= 1 ||
        /员工花名册/.test(dialogBody().text()), dialogBody().text().replace(/\s+/g, ' ').slice(0, 40));
    check('结果表有列头（工号 / 姓名 / 手机 / 邮箱）',
        /工号/.test(dialogBody().text()) && /姓名/.test(dialogBody().text()),
        dialogBody().text().replace(/\s+/g, ' ').slice(0, 60));
    check('结果表有数据行', dialogBody().find('#pvTableWrap table.rpt-pv__table tbody tr').length >= 1,
        String(dialogBody().find('#pvTableWrap table.rpt-pv__table tbody tr').length));
    check('有「打印」按钮', $('#pvPrint').length === 1);
    check('有「导出 PDF」与「导出 Excel」按钮',
        $('#pvPdf').length === 1 && $('#pvXlsx').length === 1);
    check('页脚汇总「共 N 行」', /共\s*23\s*行/.test($('#pvFooter').text()),
        $('#pvFooter').text().replace(/\s+/g, ' '));
    check('结果按 20 行一页（演示数据 23 行 → 2 页）',
        dialogBody().find('#pvTableWrap table.rpt-pv__table tbody tr').length === 20,
        String(dialogBody().find('#pvTableWrap table.rpt-pv__table tbody tr').length));
    check('页脚页码指示「1 / 2」', $('#pvFooter .rpt-pv__pageno').text() === '1 / 2',
        $('#pvFooter .rpt-pv__pageno').text());
    check('第 1 页「上一页」禁用',
        $('#pvFooter [data-pvpage="prev"]').prop('disabled') === true);
    $('#pvFooter [data-pvpage="next"]').trigger('click');
}, 700);

step(function () {
    check('查看窗内可翻到第 2 页', $('#pvFooter .rpt-pv__pageno').text() === '2 / 2',
        $('#pvFooter .rpt-pv__pageno').text());
    check('第 2 页剩 3 行',
        dialogBody().find('#pvTableWrap table.rpt-pv__table tbody tr').length === 3,
        String(dialogBody().find('#pvTableWrap table.rpt-pv__table tbody tr').length));
    check('第 2 页「下一页」禁用',
        $('#pvFooter [data-pvpage="next"]').prop('disabled') === true);
});

step(function () {
    console.log('\n--- 12. 停用的报表进不了查看窗 ---');
    $('.el-overlay .el-dialog__headerbtn').not('.el-dialog__headerbtn--max').trigger('click');
}, 600);

step(function () {
    check('关掉查看窗', $('.el-overlay').length === 0, String($('.el-overlay').length));
    V().openSaved('rp-0000-4000-8000-000000000002');   // RPT0002 是停用的
}, 1000);

step(function () {
    check('停用报表不会打开查看窗', $('.el-overlay').length === 0, String($('.el-overlay').length));
    check('给出「已停用，不能运行」的提示', /已停用/.test(toast()), toast().slice(0, 60));
});

step(function () {
    console.log('\n--- 13. 没有已启用报表时的空态 ---');
    /* 先清掉第 9 段造的压测报表与残留的检索条件，再把唯一一张真报表停用 */
    $('#rcKeyword').val('');
    $('#rcCategory').val('');
    C().state.keyword = '';
    C().state.category = '';
    C().state.pageNum = 1;
    Api.report.page({ keyword: '压测报表', pageSize: 50 }).done(function (data) {
        var rows = (data && data.list) || [], i;
        for (i = 0; i < rows.length; i++) { Api.report.remove(rows[i].id); }
        Api.report.setEnabled('rp-0000-4000-8000-000000000001', 0);
    });
}, 2200);

step(function () {
    C().load();
}, 900);

step(function () {
    check('全部停用后 0 张卡片', cards().length === 0, codes());
    check('总数 0', $('#rcTotal').text() === '0', $('#rcTotal').text());
    check('空态标题是「还没有已启用的报表」',
        $('#rcEmpty .rc-empty__title').text() === '还没有已启用的报表',
        $('#rcEmpty .rc-empty__title').text());
    check('空态引导去「报表设计」新建并启用',
        /报表设计/.test($('#rcEmpty .rc-empty__hint').text()) &&
        /启用/.test($('#rcEmpty .rc-empty__hint').text()),
        $('#rcEmpty .rc-empty__hint').text());
    check('空态下分页条隐藏', $('#rcPager').prop('hidden') === true);
    check('分类下拉回到只有「全部分类」',
        $('#rcCategory option').length === 1, $('#rcCategory').html().replace(/\s+/g, ' ').slice(0, 60));
    Api.report.setEnabled('rp-0000-4000-8000-000000000001', 1);
}, 900);

step(function () {
    C().load();
}, 900);

step(function () {
    check('重新启用后又能查到', codes() === 'RPT0001', codes());
    check('分类下拉恢复「人力资源」', /人力资源/.test($('#rcCategory').html()),
        $('#rcCategory').html().replace(/\s+/g, ' ').slice(0, 60));
    check('调试入口暴露了 state / load / cards',
        typeof C().load === 'function' && typeof C().cards === 'function' && !!C().state);
});

step(function () {
    console.log('\n--- 14.5 没有参数的报表：查看窗不显示参数区与「执行」按钮 ---');
    V().showViewer({
        params: [],
        title: '无参数报表',
        runText: '执行预览',
        dlgTitle: '查看报表 —— 无参数报表',
        onRun: function ($body) {
            V().footInfo($body, '已执行（没有参数，打开即执行）', 'ok');
        }
    });
});

step(function () {
    var body = dialogBody();
    check('无参数查看窗打开', dialog().length === 1);
    check('没有顶部行（参数区 + 执行按钮）', body.find('.rpt-pv__top').length === 0,
        String(body.find('.rpt-pv__top').length));
    check('没有执行按钮 #pvRun', body.find('#pvRun').length === 0);
    check('没有参数控件容器 #pvParams', body.find('#pvParams').length === 0);
    check('打开即自动执行（页脚已有执行信息）',
        /已执行/.test(body.find('#pvInfo').text()), body.find('#pvInfo').text());
    check('纸张区顶到最上面（顶部不留空行）',
        body.find('.rpt-pv__scroll').length === 1 && body.find('.rpt-pv').children().eq(0).hasClass('rpt-pv__scroll'),
        body.find('.rpt-pv').children().eq(0).attr('class'));
    check('打印 / 导出三个按钮仍可用', body.find('#pvPrint').length === 1 &&
        body.find('#pvPdf').length === 1 && body.find('#pvXlsx').length === 1);
    dialog().find('.el-dialog__headerbtn').not('.el-dialog__headerbtn--max').trigger('click');
});

step(function () {
    console.log('\n--- 15. 样式与版本号（双击 / 自适应纸张）---');
    var css = read('css/app.css');
    var paper = (css.match(/\.rpt-pv__paper\s*\{[^}]*\}/) || [''])[0];
    check('预览纸张不再锁 820px（宽度随弹窗自适应）',
        /max-width:\s*none/.test(paper) && /width:\s*auto/.test(paper), paper.replace(/\s+/g, ' '));
    check('纸张注释里写明「打印走 mm 尺寸、不受预览宽度影响」', /@page/.test(paper),
        paper.replace(/\s+/g, ' ').slice(0, 80));
    var card = (css.match(/\.rc-card\s*\{[^}]*\}/) || [''])[0];
    check('卡片禁掉文字选中（双击不会刷蓝标题）', /user-select:\s*none/.test(card),
        card.replace(/\s+/g, ' ').slice(0, 60));
    var html = read('report-center.html');
    check('页面引用新版 report-center.js（v=20261105c）',
        html.indexOf('js/report-center.js?v=20261105c') > -1);
    check('页面引用新版 report-viewer.js（v=20261105c）',
        html.indexOf('js/report-viewer.js?v=20261105c') > -1);
    check('页面引用新版 app.css（v=20261110f）', html.indexOf('css/app.css?v=20261110f') > -1);
    check('页头不再挂说明卡，「双击」提示由卡片自身承载（.rc-card__go + aria-label）',
        $('.page-head__hint').length === 0 &&
        /双击查看/.test(read('report-center.html') + $('.rc-card__go').first().text()),
        String($('.page-head__hint').length));
});

step(function () {
    console.log('\n--- 16. 公开否（ispublic）：卡片「公共」标记 + 可见性过滤 ---');
    /* 登录为 zhangsan（empId=7）：Mock 与后端同口径 —— 只加载本用户创建的 + 他人设为公开的报表 */
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'jsdom-token', time: '2026-11-04 10:00:00',
        expireAt: new Date().getTime() + 3600 * 1000, ttlHours: 8,
        user: { account: 'zhangsan', empName: '张三', empId: 7 }
    }));
    var KEY = 'menu_admin_reportinfos_v1';
    var stored = [];
    try { stored = JSON.parse(win.localStorage.getItem(KEY) || '[]') || []; } catch (e) { stored = []; }
    if (!stored.length) {
        /* Mock 清单可能还在内存缓存里没落盘：按 api.js SEED 的关键字段手工补一条等价种子 */
        stored = [{
            id: 'rp-0000-4000-8000-000000000001', code: 'RPT0001', reportName: '员工花名册',
            reportNameEn: 'EmployeeRoster', category: '人力资源',
            connId: 'db-0000-4000-8000-000000000001', connName: '九豆主库（MySQL）',
            databaseName: 'jiudou_main', mainTable: 'empinfos', sqlText: '',
            params: [], columns: [
                { field: 'code', label: '工号', width: 110, align: 'left', format: 'text', summary: 'none', visible: true },
                { field: 'nameCn', label: '姓名', width: 100, align: 'center', format: 'text', summary: 'none', visible: true }],
            design: {}, template: {}, description: '按部门列出员工基本信息（离线演示报表）',
            enabled: true, ispublic: true, version: 1, runCount: 3, lastRunTime: '2026-11-01 18:20:00',
            createEname: '系统管理员', createempinfosid: 1, updateEname: '系统管理员', updateempinfosid: 1,
            createTime: '2026-11-01 17:00:00', updateTime: '2026-11-01 18:20:00'
        }];
    }
    var base = stored[0] || {};
    function foreignRow(code, name, pub) {
        return {
            id: 'rp-' + code.toLowerCase() + '-4000-8000-000000000009',
            code: code, reportName: name, reportNameEn: '', category: '测试',
            connId: base.connId || 'db-0000-4000-8000-000000000001', connName: base.connName || '',
            databaseName: base.databaseName || 'jiudou_main', mainTable: 'empinfos', sqlText: '',
            params: [], columns: [
                { field: 'code', label: '工号', width: 110, align: 'left', format: 'text', summary: 'none', visible: true }],
            design: {}, template: {}, description: '', enabled: true, ispublic: pub,
            version: 1, runCount: 0, lastRunTime: '',
            createEname: '别人', createempinfosid: 999, updateEname: '别人', updateempinfosid: 999,
            createTime: '2026-11-04 09:00:00', updateTime: '2026-11-04 09:00:00'
        };
    }
    stored.push(foreignRow('RPTFPRIVATE', '别人的私有报表（中心不可见）', false));
    stored.push(foreignRow('RPTFPUBLIC', '别人的公开报表（中心可见）', true));
    win.localStorage.setItem(KEY, JSON.stringify(stored));
    doSearch('');
});

step(function () {
    check('别人的私有报表在报表中心搜不到',
        cardOf('RPTFPRIVATE').length === 0, String(cardOf('RPTFPRIVATE').length));
    check('别人设为公开的报表在报表中心能看到',
        cardOf('RPTFPUBLIC').length === 1, String(cardOf('RPTFPUBLIC').length));
    check('公开报表的卡片带「公共」标记',
        cardOf('RPTFPUBLIC').find('.el-tag--warning').filter(function () {
            return $(this).text() === '公共';
        }).length === 1, cardOf('RPTFPUBLIC').find('.el-tag').map(function () {
            return $(this).text();
        }).get().join('/'));
});

step(function () {
    /* 清理：去掉注入的两条 + 还原登录态 */
    var KEY = 'menu_admin_reportinfos_v1';
    var stored = [];
    try { stored = JSON.parse(win.localStorage.getItem(KEY) || '[]') || []; } catch (e) { stored = []; }
    stored = stored.filter(function (one) {
        return one.code !== 'RPTFPRIVATE' && one.code !== 'RPTFPUBLIC';
    });
    win.localStorage.setItem(KEY, JSON.stringify(stored));
    win.localStorage.removeItem('menu_admin_login_v1');
    doSearch('');
});

next();
