/* ==========================================================================
   report-test.js —— 数据中心 · 报表设计器页测试（jsdom，Mock 通道）
   覆盖：
        ① 首屏：标题（报表设计）/ 面包屑 / 三栏 / 左栏两个页签 / 右栏三个页签；
        ② 报表清单：卡片（编码 / 名称 / 分类 / 列数参数 / 纸张方向 / 调用次数）、分类下拉、
           点卡片打开已保存报表（画布标题 / 列头 / 参数示意 / 模板表单回填）；
        ③ 数据源：连接下拉（仅启用连接）→ 实例（库）→ 表 / 视图 → 字段；
           单击表展开字段（懒加载）、双击表整表加入、双击字段单列加入；
        ④ 拖拽入画布：模拟 dragstart + drop（字段 / 表两种 payload）；
        ⑤ 画布：列头文本 / 示例行 / 汇总行 / 点列选中后右栏回填 / 改显示名、对齐、格式、汇总 → 画布同步；
           列左移右移、删除列；
        ⑥ 报表参数：新增参数、改参数名与控件、必填开关、示例参数、参数带示意；
        ⑦ 数据集 SQL：按主表与可见列自动生成；
        ⑧ 页面模板：纸张 / 方向 / 斑马纹 / 紧凑 → 画布类名与网格变化；
        ⑨ 保存：缺名称校验、无列校验、新建保存成功（写入报表信息表）、编辑保存 version +1；
        ⑩ 预览：弹窗参数控件、执行后表格 / 汇总 / 页脚 / 分页；
        ⑪ 清单操作：复制 / 停用 / 启用 / 删除（确认框）。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/report-test.js
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
/* 打印页里的两处探针：页眉 / 页脚文本、样式表全文 */
function doc2head(doc) {
    if (!doc) { return {}; }
    var head = doc.querySelector('.sheet__band--head');
    var foot = doc.querySelector('.sheet__band--foot');
    return { head: head ? head.textContent : '', foot: foot ? foot.textContent : '' };
}
function printCssText(doc) {
    var style = doc ? doc.querySelector('style') : null;
    return style ? style.textContent : '';
}

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

/* 页面自己引的脚本（去掉上面手动 eval 的核心库），顺序照 html —— 以后加模块不用再改测试 */
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

var win = boot('report-designer.html');
var $ = win.jQuery;
var R = function () { return win.RptDesigner; };

function items() { return $('#rpList .rpt-item'); }
function $offLast() { return items().last(); }   /* 3.0 用：停用沉底，最后一张即停用卡 */
function dialog() { return $('.el-overlay .el-dialog').last(); }
function dialogBody() { return dialog().find('.el-dialog__body'); }
/* 查看窗右下角的「关闭」按钮已去掉，统一用标题栏的 ✕ 关 */
function closeDialog() {
    dialog().find('.el-dialog__headerbtn').not('.el-dialog__headerbtn--max').trigger('click');
}
function toast() { return $('.el-message-list').text(); }
function msgBox() { return $('.el-message-box').last(); }
function cols() { return R().columns(); }
function params() { return R().params(); }
function tpl() { return R().template(); }
function designObj() { return R().design(); }
function grid() { return $('#rptCols .rpt-table'); }
function heads() { return $('#rptCols .rpt-table thead th'); }
function bodyCells() { return $('#rptCols .rpt-table tbody tr').eq(0).find('td'); }
function paramCards() { return $('#paramBody .rpt-param__card'); }
function tableNodes() {
    return $('#srcTree .el-tree-node[data-kind="table"], #srcTree .el-tree-node[data-kind="view"]');
}
function fieldNodes() { return $('#srcTree .rpt-node--field'); }
function tabActive(sel, name) {
    return $(sel + ' .el-tabs__item.is-active').attr(sel === '#rptLeftTabs' ? 'data-ltab' : 'data-ptab') === name;
}

/* 模拟一次拖拽放下：直接派发 dragstart / dragover / drop，带一个最小 dataTransfer 桩 */
function fakeDrop($from, $target) {
    var store = {};
    var dt = {
        effectAllowed: 'copy', dropEffect: 'copy', types: ['text/plain'],
        setData: function (k, v) { store[k] = String(v); },
        getData: function (k) { return store[k] || ''; }
    };
    function fire($el, type, extra) {
        var ev = $.Event(type);
        ev.originalEvent = {
            dataTransfer: dt,
            preventDefault: function () { },
            stopPropagation: function () { },
            type: type
        };
        for (var k in (extra || {})) { if (extra.hasOwnProperty(k)) { ev[k] = extra[k]; } }
        $el.trigger(ev);
    }
    fire($from, 'dragstart');
    fire($target, 'dragover');
    fire($target, 'drop');
    fire($from, 'dragend');
}

var steps = [];
var tblEl = null;                // 23.5 里被编辑的那个表格组件
var beforeColCount = 0, beforeTableName = '', saveIdBefore = '', savedParamList = null;
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
    console.log('\n--- 1. 首屏：三栏骨架 ---');
    check('页面标题为「报表设计」', $('.page-head__title').text() === '报表设计',
        $('.page-head__title').text());
    check('面包屑为「数据中心/报表设计」', $('#pageHead').attr('data-crumb') === '数据中心/报表设计',
        $('#pageHead').attr('data-crumb'));
    check('左侧导航高亮「报表设计」', /报表设计/.test($('.app-side__item.is-active').text()),
        $('.app-side__item.is-active').text().replace(/\s+/g, ''));
    var $panes = $('.rpt-layout').children();
    check('主区是三栏（左 / 中 / 右）', $panes.length === 3, String($panes.length));
    check('左区域在最前、画布居中、属性在最后',
        $panes.eq(0).hasClass('rpt-pane--left') && $panes.eq(1).hasClass('rpt-pane--canvas') &&
        $panes.eq(2).hasClass('rpt-pane--props'));
    check('左栏三个页签：报表清单 / 数据源 / 工具箱',
        $('#rptLeftTabs .el-tabs__item').length === 3 &&
        /报表清单/.test($('#rptLeftTabs .el-tabs__item').eq(0).text()) &&
        /数据源/.test($('#rptLeftTabs .el-tabs__item').eq(1).text()) &&
        /工具箱/.test($('#rptLeftTabs .el-tabs__item').eq(2).text()));
    check('右栏四个页签：字段属性 / 组件属性 / 报表参数 / 页面模板',
        $('#rptPropTabs .el-tabs__item').length === 4 &&
        /字段属性/.test($('#rptPropTabs .el-tabs__item').eq(0).text()) &&
        /组件属性/.test($('#rptPropTabs .el-tabs__item').eq(1).text()) &&
        /报表参数/.test($('#rptPropTabs .el-tabs__item').eq(2).text()) &&
        /页面模板/.test($('#rptPropTabs .el-tabs__item').eq(3).text()));
    check('画布有「设计区」（工具箱组件的落点）', $('#rptFreeLayer').length === 1 &&
        $('#rptFreeHint').length === 1);
    check('字段属性里有「列标对齐」选择框', $('#colHeaderAlign').length === 1);
    check('左栏操作按钮是纯图标（有 title 没有文字）',
        $('#btnNew').text().replace(/\s/g, '') === '' && !!$('#btnNew').attr('title'),
        $('#btnNew').text());
    check('画布有区带标记：标题 / 参数 / 页眉 / 明细 / 页脚',
        $('.rpt-band[data-band="title"]').length === 1 &&
        $('.rpt-band[data-band="params"]').length === 1 &&
        $('.rpt-band[data-band="header"]').length === 1 &&
        $('.rpt-band[data-band="detail"]').length === 1 &&
        $('.rpt-band[data-band="footer"]').length === 1);
    check('明细区空态提示可以拖拽表或字段',
        /拖到这里/.test($('#rptCols').text()) && /表/.test($('#rptCols').text()),
        $('#rptCols').text().slice(0, 40));
    check('状态条给出初始引导', /未选择报表|新报表/.test($('#rptStatusText').text()),
        $('#rptStatusText').text());
});

step(function () {
    console.log('\n--- 2. 报表清单（Mock 通道）---');
    check('列表渲染出 2 张演示报表', items().length === 2, String(items().length));
    var first = items().eq(0);
    check('卡片显示报表编码 RPT0001', /RPT0001/.test(first.find('.rpt-item__code').text()),
        first.find('.rpt-item__code').text());
    check('卡片显示报表名称', /员工花名册/.test(first.find('.rpt-item__name').text()),
        first.find('.rpt-item__name').text());
    check('卡片显示分类标签', /人力资源/.test(first.find('.rpt-item__tag').text()),
        first.find('.rpt-item__tag').text());
    check('卡片显示列数与参数个数', /4 列/.test(first.find('.rpt-item__stat').text()) &&
        /1 参数/.test(first.find('.rpt-item__stat').text()), first.find('.rpt-item__stat').text());
    check('卡片显示纸张方向与调用次数', /A4/.test(first.find('.rpt-item__foot').text()) &&
        /调用 3 次/.test(first.find('.rpt-item__foot').text()), first.find('.rpt-item__foot').text());
    check('启用状态的卡片有绿点', first.find('.rpt-item__dot').hasClass('is-on'));
    check('停用的卡片没有绿点', !items().eq(1).find('.rpt-item__dot').hasClass('is-on'));
    check('启用优先：启用的排在前、停用的沉到下部',
        items().eq(0).find('.rpt-item__dot').hasClass('is-on') &&
        !items().last().find('.rpt-item__dot').hasClass('is-on'),
        items().map(function () {
            return $(this).find('.rpt-item__code').text() +
                ($(this).find('.rpt-item__dot').hasClass('is-on') ? '(启用)' : '(停用)');
        }).get().join(' | '));
    check('分类下拉含「人力资源」与「经营分析」',
        /人力资源/.test($('#rpCategoryFilter').html()) && /经营分析/.test($('#rpCategoryFilter').html()));
});

step(function () {
    console.log('\n--- 3. 单击只选中 / 双击才打开继续编辑 ---');
    /* 防误操作：整块卡片的热区单击不再动画布、也不切页签 */
    items().eq(0).trigger('click');
});

step(function () {
    check('单击卡片只选中，不打开画布（编码输入框仍为空）', $('#rptCode').val() === '', $('#rptCode').val());
    check('单击不切换左侧页签（仍停在「报表清单」）', tabActive('#rptLeftTabs', 'list'));
    check('单击后卡片带 is-selected', items().eq(0).hasClass('is-selected'));
    check('单击后工具栏按钮可用（复制 / 删除不再是禁用）',
        !$('#btnCopy').prop('disabled') && !$('#btnDelete').prop('disabled'));
    check('卡片右下角有「运行」按钮', items().eq(0).find('.rpt-item__run').length === 1 &&
        items().eq(0).find('.rpt-item__run').text() === '运行',
        items().eq(0).find('.rpt-item__run').text());
    check('卡片 title 提示「双击打开」', /双击打开这张报表继续编辑/.test(items().eq(0).attr('title') || ''),
        items().eq(0).attr('title'));
    items().eq(0).trigger('dblclick');
});

step(function () {
    check('画布标题取报表名称', $('#rptTitleText').text() === '员工花名册', $('#rptTitleText').text());
    check('副标题回填', $('#rptSubtitleText').text() === '九豆综合管理平台', $('#rptSubtitleText').text());
    check('编码 / 名称 / 分类输入框回填',
        $('#rptCode').val() === 'RPT0001' && $('#rptName').val() === '员工花名册' &&
        $('#rptCategory').val() === '人力资源',
        [$('#rptCode').val(), $('#rptName').val(), $('#rptCategory').val()].join(' / '));
    check('画布列出 4 列', heads().length === 4, String(heads().length));
    check('列头显示的是中文显示名', /工号/.test(heads().eq(0).text()) && /姓名/.test(heads().eq(1).text()),
        heads().eq(0).text() + ' / ' + heads().eq(1).text());
    check('示例行有数据（不是空的）', bodyCells().length === 4 && bodyCells().eq(0).text() !== '',
        bodyCells().text());
    check('参数带显示 1 个参数示意', $('#rptParamsPreview .rpt-params__item').length === 1,
        String($('#rptParamsPreview .rpt-params__item').length));
    check('参数示意带显示名与控件说明', /部门/.test($('#rptParamsPreview').text()) &&
        /输入框/.test($('#rptParamsPreview').text()), $('#rptParamsPreview').text());
    check('模板表单回填纸张 A4 / 横向',
        $('#tplPaper').val() === 'A4' && $('#tplOrientation').val() === 'landscape',
        $('#tplPaper').val() + ' / ' + $('#tplOrientation').val());
    check('打开报表后自动切到「数据源」页签', tabActive('#rptLeftTabs', 'source'));
    check('状态条提示已打开哪张报表', /已打开报表/.test($('#rptStatusText').text()),
        $('#rptStatusText').text());
});

step(function () {
    console.log('\n--- 3.0 停用的报表：双击只提醒，不进设计 ---');
    /* 双击打开编辑已把左栏切到「数据源」，先切回清单再验停用卡片（停用沉底，最后一张就是） */
    $('#rptLeftTabs [data-ltab="list"]').trigger('click');
    check('切回「报表清单」页签', tabActive('#rptLeftTabs', 'list'));
    var $off = items().last();
    check('停用卡片 title 提示「已停用、启用后才能进入设计」',
        /已停用/.test($off.attr('title') || '') && /启用后才能/.test($off.attr('title') || ''),
        $off.attr('title'));
    check('停用卡片 title 不再提示「双击打开」', !/双击打开/.test($off.attr('title') || ''),
        $off.attr('title'));
    $off.trigger('dblclick');
});

step(function () {
    check('双击停用卡片只弹「已停用」提醒', /已停用/.test(toast()) && /启用/.test(toast()), toast());
    check('双击停用卡片不切「数据源」页签（仍停在清单）', tabActive('#rptLeftTabs', 'list'));
    check('画布没被换成停用报表（仍是员工花名册）',
        $('#rptTitleText').text() === '员工花名册' && R().state.design.code === 'RPT0001',
        R().state.design.code);
    check('停用卡片双击后仍置为选中态（和数据库页连接卡一致）', $offLast().hasClass('is-selected'));
    /* Enter 键与双击同一条路径，也要拦 */
    var ev = $.Event('keydown'); ev.keyCode = 13;
    $offLast().trigger(ev);
    check('停用卡片按 Enter 也只提醒、不进设计',
        /已停用/.test(toast()) && tabActive('#rptLeftTabs', 'list') &&
        R().state.design.code === 'RPT0001', R().state.design.code);
    /* 还原现场：选中第一张（启用的）卡片，切回「数据源」继续后面的用例 */
    items().eq(0).trigger('click');
    $('#rptLeftTabs [data-ltab="source"]').trigger('click');
    check('现场已还原（选启用卡 + 停回「数据源」页签）',
        items().eq(0).hasClass('is-selected') && tabActive('#rptLeftTabs', 'source'));
});

step(function () {
    console.log('\n--- 3.1 报表功能介绍（录入区）---');
    check('画布上方有功能介绍录入区', $('#rptIntro').length === 1 && $('#rptDesc').length === 1);
    check('功能介绍是 textarea（支持换行）',
        $('#rptDesc').prop('tagName') === 'TEXTAREA', $('#rptDesc').prop('tagName'));
    check('打开报表时回填已保存的说明',
        $('#rptDesc').val() === '按部门列出员工基本信息（离线演示报表）', $('#rptDesc').val());
    check('字数统计跟着说明长度走',
        $('#rptDescCount').text() === '19 / 500', $('#rptDescCount').text());
    check('折叠条上显示说明的第一行',
        /按部门列出员工基本信息/.test($('#rptIntroHint').text()), $('#rptIntroHint').text());

    /* 默认展开；点标题收起 / 再展开 */
    check('默认展开（没有 is-collapsed）', !$('#rptIntro').hasClass('is-collapsed'));
    check('展开时 aria-expanded=true', $('#btnIntroToggle').attr('aria-expanded') === 'true',
        $('#btnIntroToggle').attr('aria-expanded'));
    $('#btnIntroToggle').trigger('click');
    check('点标题可收起（is-collapsed + aria-expanded=false）',
        $('#rptIntro').hasClass('is-collapsed') &&
        $('#btnIntroToggle').attr('aria-expanded') === 'false',
        $('#btnIntroToggle').attr('aria-expanded'));
    $('#btnIntroToggle').trigger('click');
    check('再点一次展开', !$('#rptIntro').hasClass('is-collapsed'));
});

step(function () {
    /* 改内容：写进设计、字数与摘要同步、并标记已修改 */
    $('#rptDesc').val('按部门统计在职员工的基本信息。\n口径：只统计状态为在职的记录；数据每 5 分钟同步一次。')
        .trigger('input');
    check('编辑内容写进设计 description',
        /按部门统计在职员工/.test(R().state.design.description),
        R().state.design.description.slice(0, 40));
    check('换行原样保留（不是被压成一行）',
        R().state.design.description.indexOf('\n') > 0, JSON.stringify(R().state.design.description));
    check('字数统计刷新', /^\d+ \/ 500$/.test($('#rptDescCount').text()) &&
        $('#rptDescCount').text().indexOf(String(R().state.design.description.length) + ' / 500') === 0,
        $('#rptDescCount').text());
    check('折叠条摘要取第一行（不带第二行）',
        /按部门统计在职员工的基本信息。$/.test($('#rptIntroHint').text()), $('#rptIntroHint').text());
    check('说明过长时自动截断到 500 字',
        (function () {
            var long = new Array(600).join('字');
            $('#rptDesc').val(long).trigger('input');
            var len = R().state.design.description.length;
            $('#rptDesc').val('按部门统计在职员工的基本信息。').trigger('input');
            return len === 500;
        })(), String(R().state.design.description.length));
});

step(function () {
    console.log('\n--- 4. 数据源：连接 / 实例 / 表 / 字段 ---');
    check('连接下拉只列出启用的连接（1 条 + 占位）',
        $('#srcConn option').length === 2, String($('#srcConn option').length));
    check('连接下拉文字带数据库类型', /MySQL/.test($('#srcConn').html()), $('#srcConn').html().slice(0, 80));
    check('实例下拉已扫描出库名', $('#srcDb option').length >= 3, String($('#srcDb option').length));
    check('实例下拉默认选中当前库 jiudou_main', $('#srcDb').val() === 'jiudou_main', $('#srcDb').val());
    check('结构树列出表与视图（5 个对象）', tableNodes().length === 5, String(tableNodes().length));
    check('视图节点有「视图」徽标', /视图/.test(tableNodes().eq(4).find('.rpt-node__kind').text()),
        tableNodes().eq(4).text());
    check('表节点不是拖拽源（draggable 已去掉，整表加入取消）',
        tableNodes().eq(0).find('.rpt-node__row').attr('draggable') !== 'true' &&
        !tableNodes().eq(0).find('.rpt-node__row').hasClass('is-draggable'),
        tableNodes().eq(0).find('.rpt-node__row').attr('class'));
});

step(function () {
    console.log('\n--- 5. 单击表展开字段（懒加载）---');
    tableNodes().eq(0).find('.rpt-node__row').trigger('click');
});

step(function () {
    check('展开后出现字段节点', fieldNodes().length >= 5, String(fieldNodes().length));
    check('字段节点显示字段名与注释', /id/.test(fieldNodes().eq(0).text()) &&
        fieldNodes().eq(0).find('.rpt-node__fcomment').length === 1, fieldNodes().eq(0).text());
    check('字段节点显示字段类型', fieldNodes().eq(0).find('.rpt-node__ftype').text() !== '',
        fieldNodes().eq(0).find('.rpt-node__ftype').text());
    check('已在画布里的字段标记为 is-added', fieldNodes().filter('.is-added').length >= 2,
        String(fieldNodes().filter('.is-added').length));
});

step(function () {
    console.log('\n--- 6. 双击表 = 只展开字段（不再整表加入）---');
    beforeColCount = cols().length;
    var mainBefore = R().state.design.mainTable;
    tableNodes().eq(1).find('.rpt-node__row').trigger('dblclick');
    check('双击表不往画布里加列（列数不变）', cols().length === beforeColCount,
        beforeColCount + ' -> ' + cols().length);
    check('双击表不改主表', R().state.design.mainTable === mainBefore,
        mainBefore + ' -> ' + R().state.design.mainTable);
    check('双击表把这张表展开了（state.expanded 置位）',
        Object.keys(R().state.expanded).some(function (k) {
            return /useinfo$/.test(k) && R().state.expanded[k];
        }), JSON.stringify(R().state.expanded));
    check('提示「已展开…拖字段 / 双击字段」', /已展开/.test(toast()) && /字段/.test(toast()), toast());
    check('表节点 title 说明加列只走字段',
        /字段/.test(tableNodes().eq(1).find('.rpt-node__row').attr('title') || ''),
        tableNodes().eq(1).find('.rpt-node__row').attr('title'));
});

step(function () {
    var names = [];
    for (var i = 0; i < fieldNodes().length; i++) { names.push(fieldNodes().eq(i).attr('data-field')); }
    check('展开后能看到这张表的字段节点', fieldNodes().length > 0, names.join(','));
    check('字段节点仍是可拖拽源（draggable=true）',
        fieldNodes().eq(0).attr('draggable') === 'true' && fieldNodes().eq(0).hasClass('is-draggable'),
        fieldNodes().eq(0).attr('draggable'));
});

step(function () {
    console.log('\n--- 7. 拖拽字段入画布（dragstart + drop）---');
    R().newReport();
});

step(function () {
    check('新建后画布是空的', cols().length === 0, String(cols().length));
    var $field = fieldNodes().filter('[data-field="deptId"]').first();
    if (!$field.length) { $field = fieldNodes().eq(3); }
    var before = cols().length;
    fakeDrop($field, $('#rptDetailBand'));
    check('拖拽后画布多出一列', cols().length === before + 1, String(cols().length));
    check('拖入的列字段名取 data-field', cols()[0] && cols()[0].field === $field.attr('data-field'),
        cols()[0] && cols()[0].field);
    check('拖入的列显示名优先用字段注释', cols()[0] && cols()[0].label !== '', cols()[0] && cols()[0].label);
    check('画布渲染出 1 列表头', heads().length === 1, String(heads().length));
    check('明细区空态被替换成表格', grid().length === 1);
});

step(function () {
    console.log('\n--- 8. 表节点不可拖拽（整表加入已取消）---');
    beforeColCount = cols().length;
    beforeTableName = tableNodes().eq(2).attr('data-table');
    check('表 / 视图节点不再是拖拽源（没有 draggable / is-draggable）',
        tableNodes().eq(2).find('.rpt-node__row').attr('draggable') !== 'true' &&
        !tableNodes().eq(2).find('.rpt-node__row').hasClass('is-draggable'),
        tableNodes().eq(2).find('.rpt-node__row').attr('class'));
    check('表节点 title 写明「拖字段 / 双击字段」',
        /拖/.test(tableNodes().eq(2).find('.rpt-node__row').attr('title') || ''),
        tableNodes().eq(2).find('.rpt-node__row').attr('title'));
    /* 即使硬拖（旧页面 / 缓存里拖来的表）也只展开、不加列：直接伪造 rpt-table 的 drop */
    var dt = {
        dropEffect: 'copy', types: ['text/plain'],
        getData: function () { return 'rpt-table:' + beforeTableName; },
        setData: function () { }
    };
    var ev = $.Event('drop');
    ev.originalEvent = { dataTransfer: dt, preventDefault: function () { },
        stopPropagation: function () { }, type: 'drop' };
    $('#rptDetailBand').trigger(ev);
    check('强行拖表也不整表加入（列数不变）', cols().length === beforeColCount,
        beforeColCount + ' -> ' + cols().length);
});

step(function () {
    check('提示「表不能整表加入」', /不能整表加入/.test(toast()), toast());
    /* 补够两列，后面的列属性 / 排序用例需要至少 2 列 */
    var added = [];
    for (var i = 0; i < cols().length; i++) { added.push(cols()[i].field); }
    var $more = fieldNodes().filter(function () {
        return added.indexOf($(this).attr('data-field')) < 0;
    }).first();
    if ($more.length) { $more.trigger('dblclick'); }
    check('再双击一个字段 -> 画布有 2 列', cols().length >= 2, String(cols().length));
    check('加入的列都带表名', (function () {
        var ok = cols().length > 0;
        for (var i = 0; i < cols().length; i++) {
            if (!cols()[i].table) { ok = false; }
        }
        return ok;
    })());
});

step(function () {
    console.log('\n--- 9. 列属性：选中 / 改显示名 / 宽度 / 汇总 ---');
    var count = cols().length;
    check('画布列数与 state 一致', heads().length === count, heads().length + ' / ' + count);
    heads().eq(0).trigger('click');
    check('点列头切到「字段属性」页签', tabActive('#rptPropTabs', 'col'));
    check('字段属性面板显示字段名', $('#colField').text() === cols()[0].field,
        $('#colField').text());
    $('#colLabel').val('测试列名').trigger('input');
    check('改显示名后画布列头同步', /测试列名/.test(heads().eq(0).text()), heads().eq(0).text());
    $('#colWidth').val('200').trigger('change');
    check('改宽度写进列定义', cols()[0].width === 200, String(cols()[0].width));
    $('#colAlign').val('right').trigger('change');
    check('改对齐写进列定义', cols()[0].align === 'right', cols()[0].align);
    $('#colFormat').val('money').trigger('change');
    check('改格式写进列定义', cols()[0].format === 'money', cols()[0].format);
    $('#colSummary').val('sum').trigger('change');
    check('改汇总后画布出现汇总行', $('#rptCols .rpt-table tfoot').length === 1);
    check('汇总带被显示', !$('#rptSummaryBand').prop('hidden'));
    check('汇总带文字说明哪一列在汇总', /测试列名/.test($('#rptSummaryText').text()),
        $('#rptSummaryText').text());
});

step(function () {
    console.log('\n--- 10. 列排序 / 删除 ---');
    var first = cols()[0].field, second = cols()[1].field;
    $('#btnColRight').trigger('click');
    check('右移后前两列互换', cols()[0].field === second && cols()[1].field === first,
        cols()[0].field + ' / ' + cols()[1].field);
    $('#btnColLeft').trigger('click');
    check('左移后恢复原顺序', cols()[0].field === first, cols()[0].field);
    var count = cols().length;
    heads().eq(0).find('.rpt-th__del').trigger('click');
    check('点列头 × 移除该列', cols().length === count - 1, String(cols().length));
    check('移除后画布列头同步减少', heads().length === count - 1, String(heads().length));
    /* 汇总列被删掉了，重新给新的首列配一个汇总，后面的预览用例才有汇总行可验证 */
    heads().eq(0).trigger('click');
    $('#colSummary').val('count').trigger('change');
    check('重新给首列配汇总', cols()[0].summary === 'count', cols()[0].summary);
});

step(function () {
    console.log('\n--- 11. 报表参数 ---');
    R().setPropTab('param');
    check('参数页签有新增与示例按钮', $('#btnParamAdd').length === 1 && $('#btnParamDemo').length === 1);
    $('#btnParamAdd').trigger('click');
    check('新增参数生成 1 张卡片', paramCards().length === 1, String(paramCards().length));
    check('默认参数名 param1', params()[0].name === 'param1', params()[0].name);
    paramCards().eq(0).find('[data-p="name"]').val('deptCode').trigger('input');
    check('改参数名写进 state', params()[0].name === 'deptCode', params()[0].name);
    paramCards().eq(0).find('[data-p="label"]').val('部门编码').trigger('input');
    check('改显示名写进 state', params()[0].label === '部门编码', params()[0].label);
    paramCards().eq(0).find('[data-p="control"]').val('select').trigger('change');
    check('切到下拉控件后出现「选项」输入行',
        !paramCards().eq(0).find('.rpt-param__options').prop('hidden'));
    paramCards().eq(0).find('[data-p="options"]').val('研发,市场,财务').trigger('input');
    check('选项写进 state', params()[0].options === '研发,市场,财务', params()[0].options);
    paramCards().eq(0).find('[data-p="required"]').val('1').trigger('change');
    check('必填开关写进 state', params()[0].required === true, String(params()[0].required));
    check('画布参数带出现必填星号', $('.rpt-params__label b').length === 1);
    check('画布参数带显示下拉选项说明', /下拉/.test($('#rptParamsPreview').text()),
        $('#rptParamsPreview').text());
    $('#btnParamDemo').trigger('click');
    check('插入示例参数后参数变多', params().length >= 3, String(params().length));
    check('示例参数里有 beginDate', (function () {
        for (var i = 0; i < params().length; i++) { if (params()[i].name === 'beginDate') { return true; } }
        return false;
    })());
});

step(function () {
    console.log('\n--- 11.1 报表参数顺序可调 ---');
    R().setPropTab('param');
    var names = params().map(function (p) { return p.name; });
    check('参数卡片数量与参数一致', paramCards().length === names.length,
        paramCards().length + '/' + names.length);
    check('卡片按顺序编号 #1 #2 …', paramCards().eq(0).find('.rpt-param__no').text() === '#1',
        paramCards().eq(0).find('.rpt-param__no').text());
    check('每张卡片都有上移 / 下移按钮',
        paramCards().eq(0).find('.rpt-param__move').length === 2,
        String(paramCards().eq(0).find('.rpt-param__move').length));

    var first = params()[0], second = params()[1];
    var firstLabel = first.label || first.name;
    check('画布参数带按参数顺序渲染',
        $('#rptParamsPreview .rpt-params__label').eq(0).text().indexOf(firstLabel) >= 0,
        $('#rptParamsPreview .rpt-params__label').eq(0).text());

    paramCards().eq(0).find('.rpt-param__move[data-move="down"]').trigger('click');
    check('点「下移」后前两个参数互换',
        params()[0].name === second.name && params()[1].name === first.name,
        params().map(function (p) { return p.name; }).join(','));
    check('卡片重排后 #1 是新第一个参数',
        paramCards().eq(0).find('[data-p="name"]').val() === second.name,
        paramCards().eq(0).find('[data-p="name"]').val());
    check('画布参数带顺序同步',
        $('#rptParamsPreview .rpt-params__label').eq(0).text()
            .indexOf(second.label || second.name) >= 0,
        $('#rptParamsPreview .rpt-params__label').eq(0).text());

    paramCards().eq(1).find('.rpt-param__move[data-move="up"]').trigger('click');
    check('点「上移」能换回来', params()[0].name === first.name,
        params().map(function (p) { return p.name; }).join(','));

    var stillFirst = params()[0].name;
    paramCards().eq(0).find('.rpt-param__move[data-move="up"]').trigger('click');
    check('第一个参数再上移不动（不会越界）', params()[0].name === stillFirst, params()[0].name);
    var last = params().length - 1;
    var lastOne = params()[last].name;
    paramCards().eq(last).find('.rpt-param__move[data-move="down"]').trigger('click');
    check('最后一个参数再下移不动', params()[last].name === lastOne, params()[last].name);
});

step(function () {
    console.log('\n--- 12. 数据集 SQL ---');
    check('SQL 区为空时提示自动生成', /自动生成/.test($('#rptSqlInfo').text()), $('#rptSqlInfo').text());
    $('#btnSqlAuto').trigger('click');
    var sql = $('#rptSqlText').val();
    check('按主表生成 SELECT 语句', /^SELECT /.test(sql) && /FROM /.test(sql), sql);
    check('生成的 SQL 含已拖入的字段', sql.indexOf(cols()[0].field) >= 0, sql);
    check('SQL 写进 state', R().state.design.sqlText === sql);
    $('#rptSqlText').val('SELECT * FROM x WHERE a = :deptCode').trigger('input');
    check('手写 SQL 会覆盖自动生成', R().state.design.sqlText.indexOf(':deptCode') > 0,
        R().state.design.sqlText);
    check('SQL 提示改成自定义文案', /自定义 SQL/.test($('#rptSqlInfo').text()), $('#rptSqlInfo').text());
});

step(function () {
    console.log('\n--- 13. 页面模板 ---');
    R().setPropTab('tmpl');
    $('#tplPaper').val('A5').trigger('change');
    check('改纸张写进模板', tpl().paper === 'A5', tpl().paper);
    $('#tplOrientation').val('portrait').trigger('change');
    check('改方向写进模板', tpl().orientation === 'portrait', tpl().orientation);
    $('#tplZebra').val('0').trigger('change');
    check('关掉斑马纹后表格去掉 is-zebra', !grid().hasClass('is-zebra'));
    $('#tplBordered').val('0').trigger('change');
    check('关掉边框后表格去掉 is-bordered', !grid().hasClass('is-bordered'));
    $('#tplCompact').val('1').trigger('change');
    check('紧凑模式加上 is-compact', grid().hasClass('is-compact'));
    $('#tplFooter').val('制表：测试').trigger('input');
    check('页脚文字回填到画布页脚', /制表：测试/.test($('#rptFooterText').text()),
        $('#rptFooterText').text());
    $('#tplWatermark').val('内部资料').trigger('input');
    check('水印写进模板', tpl().watermark === '内部资料', tpl().watermark);
    $('#tplPageNo').val('0').trigger('change');
    check('关掉页码后页脚不再有「第 1 页」', !/第 1 页/.test($('#rptFooterText').text()),
        $('#rptFooterText').text());
});

step(function () {
    console.log('\n--- 13.1 页眉 / 页脚：对齐与 Logo ---');
    R().setPropTab('tmpl');
    check('模板面板有页眉对齐 / 页脚对齐下拉',
        $('#tplHeaderAlign').length === 1 && $('#tplFooterAlign').length === 1);
    check('模板面板有页眉 / 页脚 Logo 输入与位置、高度',
        $('#tplHeaderLogo').length === 1 && $('#tplFooterLogo').length === 1 &&
        $('#tplHeaderLogoPos').length === 1 && $('#tplFooterLogoPos').length === 1 &&
        $('#tplHeaderLogoH').length === 1 && $('#tplFooterLogoH').length === 1);

    $('#tplHeader').val('九豆综合管理平台').trigger('input');
    $('#tplHeaderAlign').val('right').trigger('change');
    check('页眉文字写进设计', R().design().headerText === '九豆综合管理平台',
        R().design().headerText);
    check('页眉对齐写进设计', R().design().headerAlign === 'right', R().design().headerAlign);
    check('画布页眉带显示文字', /九豆综合管理平台/.test($('#rptHeaderText').text()),
        $('#rptHeaderText').text());
    check('画布页眉带按右对齐',
        /text-align:\s*right/.test($('#rptHeaderText .rpt-pageband__text').attr('style') || ''),
        $('#rptHeaderText .rpt-pageband__text').attr('style'));

    $('#tplHeaderLogo').val('assets/logo.svg').trigger('input');
    check('页眉 Logo 地址写进模板', tpl().headerLogo === 'assets/logo.svg', tpl().headerLogo);
    check('画布页眉带出现 logo 图',
        $('#rptHeaderText img.rpt-pageband__logo').length === 1);
    check('logo 默认贴左（不反转）',
        !/row-reverse/.test($('#rptHeaderText .rpt-pageband').attr('style') || ''));
    $('#tplHeaderLogoPos').val('right').trigger('change');
    check('Logo 位置可调（改贴右后 flex 反转）',
        /row-reverse/.test($('#rptHeaderText .rpt-pageband').attr('style') || ''),
        $('#rptHeaderText .rpt-pageband').attr('style'));
    $('#tplHeaderLogoH').val('48').trigger('change');
    check('Logo 高度写进模板并作用到画布',
        tpl().headerLogoHeight === 48 &&
        /height:\s*48px/.test($('#rptHeaderText img.rpt-pageband__logo').attr('style') || ''),
        tpl().headerLogoHeight + ' / ' +
        $('#rptHeaderText img.rpt-pageband__logo').attr('style'));

    $('#tplFooter').val('制表：测试').trigger('input');
    $('#tplFooterAlign').val('right').trigger('change');
    $('#tplFooterLogo').val('assets/logo.svg').trigger('input');
    check('页脚对齐写进设计', R().design().footerAlign === 'right', R().design().footerAlign);
    check('画布页脚带出现 logo 与文字',
        $('#rptFooterText img.rpt-pageband__logo').length === 1 &&
        /制表：测试/.test($('#rptFooterText').text()), $('#rptFooterText').text());
    check('页脚文字按右对齐',
        /text-align:\s*right/.test($('#rptFooterText .rpt-pageband__text').attr('style') || ''),
        $('#rptFooterText .rpt-pageband__text').attr('style'));
});

step(function () {
    console.log('\n--- 14. 保存校验 ---');
    $('#rptName').val('').trigger('input');
    $('#btnSave').trigger('click');
    check('缺报表名称时提示', /请填写报表名称/.test(toast()), toast());
    $('#rptName').val('新报表测试').trigger('input');
    R().state.design.connId = '';
    $('#srcConn').val('');
    $('#btnSave').trigger('click');
    check('缺数据源连接时提示', /数据源连接/.test(toast()), toast());
});

step(function () {
    console.log('\n--- 14.5 创建人 = 当前登录人的员工姓名 ---');
    /* 造一个登录态（离线演示也按真实登录人填创建人）。
       empId 用 1：Mock 种子报表（系统管理员建的）的 createempinfosid=1，
       这样「清单只加载本人创建的报表」的口径下种子报表仍在清单里，
       后面的运行 / 复制 / 删除用例不必换账号。 */
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'jsdom-token', time: '2026-11-02 10:00:00',
        expireAt: new Date().getTime() + 3600 * 1000, ttlHours: 8,
        user: { account: 'zhangsan', empName: '张三', empId: 1 }
    }));
    check('登录态里能读到员工姓名（empName）',
        /张三/.test(String(win.localStorage.getItem('menu_admin_login_v1'))), '');
});

step(function () {
    console.log('\n--- 14.7 公开否（ispublic）：默认私有 + 勾选进设计态 ---');
    /* 画布上是第 7 步新建的报表：默认私有 */
    check('工具栏有「公开」勾选框 #rptIsPublic', $('#rptIsPublic').length === 1,
        String($('#rptIsPublic').length));
    check('新报表默认不勾选（ispublic=0）',
        !$('#rptIsPublic').prop('checked') && R().state.design.ispublic === 0,
        String(R().state.design.ispublic));
    $('#rptIsPublic').prop('checked', true).trigger('change');
    check('勾选后设计态 ispublic=1 且标记未保存',
        R().state.design.ispublic === 1 && /is-dirty/.test($('#rptStatusDot').attr('class') || ''),
        String(R().state.design.ispublic));
    $('#rptIsPublic').prop('checked', false).trigger('change');
    check('取消勾选后设计态回到 ispublic=0', R().state.design.ispublic === 0,
        String(R().state.design.ispublic));
});

step(function () {
    console.log('\n--- 14.8 英文报表名（reportNameEn）：录入组件 + 设计态同步 ---');
    check('工具栏有英文名输入框 #rptNameEn', $('#rptNameEn').length === 1,
        String($('#rptNameEn').length));
    check('输入框上限 120 字（与 reportNameEn 字段一致）',
        String($('#rptNameEn').attr('maxlength')) === '120',
        String($('#rptNameEn').attr('maxlength')));
    check('新报表英文名为空', !$('#rptNameEn').val() && !R().state.design.reportNameEn,
        String($('#rptNameEn').val()));
    $('#rptNameEn').val('Headcount Monthly').trigger('input');
    check('录入后设计态 reportNameEn 同步且标记未保存',
        R().state.design.reportNameEn === 'Headcount Monthly' &&
        /is-dirty/.test($('#rptStatusDot').attr('class') || ''),
        String(R().state.design.reportNameEn));
});

step(function () {
    console.log('\n--- 15. 保存（新增）---');
    $('#srcConn').val('db-0000-4000-8000-000000000001').trigger('change');
});

step(function () {
    $('#rptCode').val('RPT9001').trigger('input');
    R().state.design.mainTable = 'empinfos';
    /* 保存前填一段功能介绍（第 7 步新建过报表，这里重新填） */
    $('#rptDesc').val('新建报表的功能介绍：用于自测。\n口径：只统计在职员工。').trigger('input');
    $('#btnSave').trigger('click');
});

step(function () {
    check('保存成功提示已写入报表信息表', /已保存/.test(toast()), toast());
    check('保存后拿到报表 id', !!R().state.design.id, R().state.design.id);
    check('保存后编码为 RPT9001', R().state.design.code === 'RPT9001', R().state.design.code);
    check('保存后版本号为 1', R().state.design.version === 1, String(R().state.design.version));
    check('清单里出现新报表', items().filter(function () {
        return /RPT9001/.test($(this).text());
    }).length === 1);
    check('状态条提示可用编码调用', /调用/.test($('#rptStatusText').text()), $('#rptStatusText').text());
    var fresh = R().state.rows[R().state.design.id] || {};
    check('功能介绍随报表一起保存（清单里能读到）',
        String(fresh.description || '').indexOf('新建报表的功能介绍') === 0,
        String(fresh.description || '').slice(0, 40));
    check('保存后说明里的换行没丢',
        String(fresh.description || '').indexOf('\n') > 0, JSON.stringify(fresh.description || ''));
    check('清单项的提示里带上功能介绍（悬停可见）',
        /新建报表的功能介绍/.test(items().filter(function () {
            return /RPT9001/.test($(this).text());
        }).attr('title') || ''), items().filter(function () {
            return /RPT9001/.test($(this).text());
        }).attr('title'));
    /* 创建人：当前登录账号的员工姓名（不是账号、不是空的） */
    check('保存后的创建人（createEname）= 当前登录人的员工姓名「张三」',
        String(fresh.createEname || '') === '张三', String(fresh.createEname));
    check('保存后创建人员工ID（createempinfosid）按登录态带入',
        Number(fresh.createempinfosid || 0) > 0, String(fresh.createempinfosid));
    check('英文报表名随报表一起保存（reportNameEn 落库）',
        String(fresh.reportNameEn || '') === 'Headcount Monthly', String(fresh.reportNameEn));
    check('重开表单时英文名回填到输入框', (function () {
        var keep = R().state.design.reportNameEn;
        R().state.design.reportNameEn = 'Reload Check';
        R().syncHeadForm();
        var v = $('#rptNameEn').val();
        R().state.design.reportNameEn = keep;
        R().syncHeadForm();
        return v === 'Reload Check';
    })(), String($('#rptNameEn').val()));
    check('保存后修改人（updateEname / updateempinfosid）与创建人一致',
        String(fresh.updateEname || '') === '张三' &&
        Number(fresh.updateempinfosid || 0) === Number(fresh.createempinfosid || 0),
        String(fresh.updateEname) + ' / ' + String(fresh.updateempinfosid));
    check('清单项的提示里也带创建人',
        /创建人：张三/.test(items().filter(function () {
            return /RPT9001/.test($(this).text());
        }).attr('title') || ''), items().filter(function () {
            return /RPT9001/.test($(this).text());
        }).attr('title'));
});

step(function () {
    console.log('\n--- 16. 保存（编辑：version +1）---');
    saveIdBefore = R().state.design.id;
    $('#rptName').val('新报表测试（改名）').trigger('input');
    $('#btnSave').trigger('click');
});

step(function () {
    check('改完再保存版本号 +1', R().state.design.version === 2, String(R().state.design.version));
    check('id 不变（是同一张报表）', R().state.design.id === saveIdBefore);
    check('名称跟着改', R().state.design.reportName === '新报表测试（改名）',
        R().state.design.reportName);
    check('再保存一次功能介绍仍在（不会被清空）',
        String((R().state.rows[saveIdBefore] || {}).description || '')
            .indexOf('新建报表的功能介绍') === 0,
        String((R().state.rows[saveIdBefore] || {}).description || '').slice(0, 40));
});

/* ---------- 16.5 可见性过滤 + 「公共」标记 ----------
   2026-11-06 口径调整：**报表设计器清单只加载本用户创建的报表**（含停用），
   他人的报表无论公开与否都不进清单；「公开」只影响报表中心（见 report-center-test）。
   注意：要等第 15 节保存后 Mock 才会把清单落盘（write()），在此之前 localStorage 还是空的，
   直接改 localStorage 会把内存里的种子清单覆盖掉 —— 所以这几步必须放在第 16 节之后 */
step(function () {
    console.log('\n--- 16.5 可见性过滤：清单只加载本用户创建的报表 ---');
    var KEY = 'menu_admin_reportinfos_v1';
    var stored = [];
    try { stored = JSON.parse(win.localStorage.getItem(KEY) || '[]'); } catch (e) { stored = []; }
    stored = stored || [];
    check('Mock 清单已落盘（localStorage 里有种子 + 自建报表）', stored.length >= 3,
        String(stored.length));
    stored.push({
        id: 'rp-foreign-4000-8000-000000000009',
        code: 'RPTFOREIGN', reportName: '别人的私有报表', reportNameEn: '',
        category: '测试', connId: 'db-0000-4000-8000-000000000001', connName: '九豆主库（MySQL）',
        databaseName: 'jiudou_main', mainTable: 'empinfos', sqlText: '',
        params: [], columns: [{ field: 'code', label: '工号', width: 110, align: 'left',
                                format: 'text', summary: 'none', visible: true }],
        design: {}, template: {}, description: '', enabled: true, ispublic: false,
        version: 1, runCount: 0, lastRunTime: '',
        createEname: '别人', createempinfosid: 999, updateEname: '别人', updateempinfosid: 999,
        createTime: '2026-11-04 09:00:00', updateTime: '2026-11-04 09:00:00'
    });
    win.localStorage.setItem(KEY, JSON.stringify(stored));
    R().loadReports();
});

step(function () {
    check('别人的私有报表不出现在我的清单里',
        items().filter(function () { return /RPTFOREIGN/.test($(this).text()); }).length === 0,
        String(items().filter(function () { return /RPTFOREIGN/.test($(this).text()); }).length));
    var KEY = 'menu_admin_reportinfos_v1';
    var stored = [];
    try { stored = JSON.parse(win.localStorage.getItem(KEY) || '[]'); } catch (e) { stored = []; }
    stored = stored || [];
    for (var i = 0; i < stored.length; i++) {
        if (stored[i].code === 'RPTFOREIGN') { stored[i].ispublic = true; }
    }
    win.localStorage.setItem(KEY, JSON.stringify(stored));
    R().loadReports();
});

step(function () {
    /* 2026-11-06 用户需求：设计器清单只加载本用户创建的报表 —— 别人公开的也不进清单 */
    check('别人设为公开后，设计器清单里仍然看不到（清单只看本人创建的）',
        items().filter(function () { return /RPTFOREIGN/.test($(this).text()); }).length === 0,
        String(items().filter(function () { return /RPTFOREIGN/.test($(this).text()); }).length));
    /* 把自己的报表设为公开：清单里自己的报表照旧可见，并且卡片带「公共」标记 */
    var KEY = 'menu_admin_reportinfos_v1';
    var stored = [];
    try { stored = JSON.parse(win.localStorage.getItem(KEY) || '[]'); } catch (e) { stored = []; }
    stored = stored || [];
    var mineId = String(R().state.design.id || '');
    for (var i = 0; i < stored.length; i++) {
        if (String(stored[i].id) === mineId) { stored[i].ispublic = true; }
    }
    win.localStorage.setItem(KEY, JSON.stringify(stored));
    R().loadReports();
});

step(function () {
    var $mine = items().filter(function () { return /新报表测试/.test($(this).text()); });
    check('自己的报表始终在清单里（公开与否都行）', $mine.length >= 1, String($mine.length));
    check('自己的公开报表卡片带「公共」标记（.rpt-item__pub）',
        $mine.find('.rpt-item__pub').length >= 1,
        String($mine.find('.rpt-item__pub').length));
    /* 2026-11-05：非本人创建的停用报表不可显示（即使设了公开） */
    var KEY = 'menu_admin_reportinfos_v1';
    var stored = [];
    try { stored = JSON.parse(win.localStorage.getItem(KEY) || '[]'); } catch (e) { stored = []; }
    stored = stored || [];
    stored.push({
        id: 'rp-foreign-off-4000-8000-000000000010',
        code: 'RPTFOFF', reportName: '别人的公开停用报表', reportNameEn: '',
        category: '测试', connId: 'db-0000-4000-8000-000000000001', connName: '九豆主库（MySQL）',
        databaseName: 'jiudou_main', mainTable: 'empinfos', sqlText: '',
        params: [], columns: [{ field: 'code', label: '工号', width: 110, align: 'left',
                                format: 'text', summary: 'none', visible: true }],
        design: {}, template: {}, description: '', enabled: false, ispublic: true,
        version: 1, runCount: 0, lastRunTime: '',
        createEname: '别人', createempinfosid: 999, updateEname: '别人', updateempinfosid: 999,
        createTime: '2026-11-04 09:10:00', updateTime: '2026-11-04 09:10:00'
    });
    win.localStorage.setItem(KEY, JSON.stringify(stored));
    R().loadReports();
});

step(function () {
    check('别人的公开但停用的报表同样不显示（他人报表整类都不进设计器清单）',
        items().filter(function () { return /RPTFOFF/.test($(this).text()); }).length === 0,
        String(items().filter(function () { return /RPTFOFF/.test($(this).text()); }).length));
    check('自己创建的报表（含停用）仍然可见',
        items().length >= 1, String(items().length));
    /* 清理掉注入的报表，免得影响后面的「清单条数 / 分页」类用例 */
    var KEY = 'menu_admin_reportinfos_v1';
    var stored = [];
    try { stored = JSON.parse(win.localStorage.getItem(KEY) || '[]'); } catch (e) { stored = []; }
    stored = (stored || []).filter(function (one) {
        return one.code !== 'RPTFOREIGN' && one.code !== 'RPTFOFF';
    });
    win.localStorage.setItem(KEY, JSON.stringify(stored));
    R().loadReports();
});

step(function () {
    console.log('\n--- 17. 预览 ---');
    $('#btnPreview').trigger('click');
});

step(function () {
    var body = dialogBody();
    check('预览弹窗打开', dialog().length === 1);
    check('弹窗标题带报表名', /新报表测试（改名）/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    check('弹窗渲染参数控件（含下拉）', body.find('#pvParams select[data-pname]').length >= 1 &&
        body.find('#pvParams [data-pname]').length >= 3,
        String(body.find('#pvParams [data-pname]').length));
    check('弹窗里有执行按钮', body.find('#pvRun').length === 1);
    /* deptCode 是必填参数：没填时后端会拒绝，弹窗应给出提示而不是空白表格 */
    check('必填参数未填时给出明确提示',
        /请先填写报表参数/.test(body.find('#pvTableWrap').text()) ||
        /请先填写报表参数/.test(toast()),
        body.find('#pvTableWrap').text().slice(0, 60) + ' | ' + toast());
    body.find('#pvParams [data-pname="deptCode"]').val('研发').trigger('change');
    body.find('#pvRun').trigger('click');
});

step(function () {
    var body = dialogBody();
    check('填好必填参数后渲染出列头', body.find('#pvTableWrap thead th').length === heads().length,
        body.find('#pvTableWrap thead th').length + ' / ' + heads().length);
    check('预览表格渲染出数据行', body.find('#pvTableWrap tbody tr').length >= 2,
        String(body.find('#pvTableWrap tbody tr').length));
    check('预览有汇总行', body.find('#pvTableWrap tfoot').length === 1);
    check('预览页脚显示总行数', /共 \d+ 行/.test(body.find('#pvFooter').text()),
        body.find('#pvFooter').text());
    check('预览信息条显示行数与耗时', /行/.test(body.find('#pvInfo').text()), body.find('#pvInfo').text());
    check('必填参数已带着值提交', /研发/.test(body.find('[data-pname="deptCode"]').val() || ''),
        body.find('[data-pname="deptCode"]').val());
    check('预览标题取报表名称', /新报表测试（改名）/.test(body.find('#pvTitle').text()),
        body.find('#pvTitle').text());
    closeDialog();
    check('点「关闭」能关掉预览弹窗', $('.el-overlay').length === 0);
});

step(function () {
    console.log('\n--- 17.1 没有参数：预览不显示参数区与「执行」按钮 ---');
    savedParamList = R().state.design.params;
    R().state.design.params = [];          // 临时清空参数定义
    $('#btnPreview').trigger('click');
});

step(function () {
    var body = dialogBody();
    check('无参数时预览弹窗打开', dialog().length === 1);
    check('没有顶部行（参数区 + 执行按钮一起不显示）', body.find('.rpt-pv__top').length === 0,
        String(body.find('.rpt-pv__top').length));
    check('没有「执行预览」按钮', body.find('#pvRun').length === 0,
        String(body.find('#pvRun').length));
    check('没有参数控件容器 #pvParams', body.find('#pvParams').length === 0);
    check('打开即自动执行（表格已经出数据）',
        body.find('#pvTableWrap tbody tr').length >= 1,
        String(body.find('#pvTableWrap tbody tr').length));
    check('页脚仍显示执行信息', /行/.test(body.find('#pvInfo').text()), body.find('#pvInfo').text());
    check('打印 / 导出按钮仍在页脚', body.find('#pvPrint').length === 1 &&
        body.find('#pvPdf').length === 1 && body.find('#pvXlsx').length === 1);
    closeDialog();
    R().state.design.params = savedParamList;   // 还原，后面的运行 / 保存用例还要用
    check('参数定义已还原', R().state.design.params.length === savedParamList.length,
        String(R().state.design.params.length));
});

step(function () {
    console.log('\n--- 18. 卡片「运行」按钮：按关联连接运行报表 ---');
    var t = items().filter(function () { return /RPT0001/.test($(this).text()); }).first();
    /* 双击现在是「打开继续编辑」，运行改由卡片右下角的独立按钮负责（点按钮不该动画布） */
    t.find('.rpt-item__run').trigger('click');
});

step(function () {
    var body = dialogBody();
    check('点「运行」按钮后打开运行弹窗', dialog().length === 1);
    check('弹窗标题是「运行报表」', /运行报表 —— 员工花名册/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    /* 需求一：连接对象信息区必须隐藏 */
    check('不再显示连接对象信息区（无 #pvConn / #pvMeta）',
        body.find('#pvConn').length === 0 && body.find('#pvMeta').length === 0 &&
        body.find('.rpt-pv__meta').length === 0);
    check('弹窗顶部第一个区块是参数区', body.find('.rpt-pv').children().eq(0).hasClass('rpt-pv__top'));
    /* 需求二：查询按钮与参数区同一行、按钮在右 */
    check('参数区与执行按钮同处一行（.rpt-pv__top）',
        body.find('.rpt-pv__top > #pvParams').length === 1 &&
        body.find('.rpt-pv__top > #pvRun').length === 1);
    check('执行按钮排在参数区右侧（top 内最后一个子元素）',
        body.find('.rpt-pv__top').children().last().attr('id') === 'pvRun',
        body.find('.rpt-pv__top').children().last().attr('id'));
    /* 需求三：执行效率信息在页脚 */
    check('执行效率信息位于页脚（#pvInfo 在 .rpt-pv__footbar 里）',
        body.find('.rpt-pv__footbar > #pvInfo').length === 1);
    check('页脚信息含时间 / 行数 / 耗时',
        /执行于/.test(body.find('#pvInfo').text()) && /返回 \d+ 行/.test(body.find('#pvInfo').text()) &&
        /耗时 \d+ ms/.test(body.find('#pvInfo').text()), body.find('#pvInfo').text());
    /* 需求四：打印 / 导出按钮 */
    check('页脚有打印 / 导出 PDF / 导出 Excel 三个按钮',
        body.find('.rpt-pv__footbar #pvPrint').length === 1 &&
        body.find('.rpt-pv__footbar #pvPdf').length === 1 &&
        body.find('.rpt-pv__footbar #pvXlsx').length === 1,
        body.find('.rpt-pv__footbar .el-button').map(function () { return $(this).text(); }).get().join('/'));
    check('按钮文案正确', body.find('#pvPrint').text() === '打印' &&
        body.find('#pvPdf').text() === '导出 PDF' && body.find('#pvXlsx').text() === '导出 Excel');
    check('参数按定义渲染出输入控件', body.find('#pvParams [data-pname]').length === 1,
        String(body.find('#pvParams [data-pname]').length));
    check('查询结果按列定义渲染出 4 列表头',
        body.find('#pvTableWrap thead th').length === 4,
        String(body.find('#pvTableWrap thead th').length));
    check('查询结果表格有数据行', body.find('#pvTableWrap tbody tr').length >= 2,
        String(body.find('#pvTableWrap tbody tr').length));
    check('结果加载到页脚（总行数）', /共 \d+ 行/.test(body.find('#pvFooter').text()),
        body.find('#pvFooter').text());
    check('运行信息条显示行数与耗时', /行/.test(body.find('#pvInfo').text()), body.find('#pvInfo').text());
    check('运行窗口里没有「在画布中编辑」按钮（已按需求去掉）',
        body.find('#pvEdit').length === 0 &&
        !/在画布中编辑/.test(body.find('.rpt-pv__footbar').text()),
        body.find('.rpt-pv__footbar').text().replace(/\s+/g, ' '));
    check('点「运行」按钮不切换画布（仍停在上一次编辑的 RPT9001）', R().state.design.code === 'RPT9001',
        R().state.design.code);
    closeDialog();
});

step(function () {
    check('运行弹窗可以关掉', $('.el-overlay').length === 0);
    check('状态条提示已运行报表', /已运行报表/.test($('#rptStatusText').text()), $('#rptStatusText').text());
    check('运行后清单里的调用次数 +1（3 → 4）', (function () {
        var txt = '';
        items().each(function () { if (/RPT0001/.test($(this).text())) { txt = $(this).text(); } });
        return /调用 4 次/.test(txt);
    })(), (function () {
        var txt = '';
        items().each(function () { if (/RPT0001/.test($(this).text())) { txt = $(this).text(); } });
        return txt.replace(/\s+/g, ' ');
    })());
});

step(function () {
    console.log('\n--- 18.1 打印：输出「全部查询结果」 ---');
    R().runReport('rp-0000-4000-8000-000000000001');
}, 1900);

step(function () {
    var body = dialogBody();
    check('运行窗口里只渲染当前页（20 行）', body.find('#pvTableWrap tbody tr').length === 20,
        String(body.find('#pvTableWrap tbody tr').length));
    body.find('#pvPrint').trigger('click');
}, 900);

step(function () {
    var f = win.document.getElementById('rptPrintFrame');
    check('点打印后生成了隐藏打印页（iframe）', !!f);
    if (!f) { return; }
    var doc = f.contentDocument;
    check('打印页有内容', !!doc && doc.body.children.length > 0);
    if (!doc) { return; }
    check('打印页标题取报表名称', /员工花名册/.test(doc.title), doc.title);
    check('打印页列头与列定义一致', doc.querySelectorAll('table.data thead th').length === 4,
        String(doc.querySelectorAll('table.data thead th').length));
    /* 数据源演示 23 行：页面只渲染 20 行，打印页必须是全部 23 行 */
    check('打印页输出全部行（23 行，不是页面上的 20 行）',
        doc.querySelectorAll('table.data tbody tr').length === 23,
        String(doc.querySelectorAll('table.data tbody tr').length));
    check('打印页页脚带总行数与打印时间', /共 23 行/.test(doc.querySelector('.foot').textContent),
        doc.querySelector('.foot').textContent.trim());
    check('打印页按页面模板生成 @page（A4 纵向 210/297mm）',
        /@page/.test(doc.querySelector('style').textContent) &&
        /210mm/.test(doc.querySelector('style').textContent) &&
        /297mm/.test(doc.querySelector('style').textContent),
        doc.querySelector('style').textContent.slice(0, 60));
    check('打印页状态提示已就绪', /打印页已就绪/.test(dialogBody().find('#pvInfo').text()),
        dialogBody().find('#pvInfo').text());
}, 900);

step(function () {
    console.log('\n--- 18.2 导出：离线演示模式给出明确提示 ---');
    dialogBody().find('#pvXlsx').trigger('click');
});

step(function () {
    check('离线模式下导出 Excel 提示「不支持导出文件」',
        /离线演示模式不支持导出文件/.test(toast()), toast());
    dialogBody().find('#pvPdf').trigger('click');
});

step(function () {
    check('离线模式下导出 PDF 同样给出提示', /离线演示模式不支持导出文件/.test(toast()), toast());
    check('导出失败后按钮恢复可用', !dialogBody().find('#pvXlsx').prop('disabled'));
    closeDialog();
});

step(function () {
    check('打印 / 导出后弹窗仍可关闭', $('.el-overlay').length === 0);
    console.log('\n--- 19. 清单操作：复制 / 停用 / 启用 / 删除 ---');
    var target = items().filter(function () { return /RPT9001/.test($(this).text()); });
    target.trigger('click');
});

step(function () {
    check('单击卡片只选中，画布仍停在已保存的 RPT9001（不重新加载）', R().state.design.code === 'RPT9001',
        R().state.design.code);
    check('选中后该卡片高亮', items().filter(function () {
        return /RPT9001/.test($(this).text());
    }).first().hasClass('is-selected'));
    $('#btnCopy').trigger('click');
    check('复制前弹出确认框', /复制/.test(msgBox().text()), msgBox().text().slice(0, 40));
    msgBox().find('.btn-ok').trigger('click');
});

step(function () {
    check('复制后清单多一条', items().length >= 3, String(items().length));
    check('复制出来的报表默认停用', (function () {
        var found = false;
        items().each(function () {
            if (/（副本）/.test($(this).text()) && !$(this).find('.rpt-item__dot').hasClass('is-on')) {
                found = true;
            }
        });
        return found;
    })());
    check('停用的副本自动沉到下部（即使它的更新时间最新，也不占第一位）',
        items().eq(0).find('.rpt-item__dot').hasClass('is-on') &&
        !items().last().find('.rpt-item__dot').hasClass('is-on'),
        items().map(function () {
            return $(this).find('.rpt-item__code').text() +
                ($(this).find('.rpt-item__dot').hasClass('is-on') ? '(启用)' : '(停用)');
        }).get().join(' | '));
});

step(function () {
    var copy = items().filter(function () { return /（副本）/.test($(this).text()); }).first();
    copy.trigger('click');
});

step(function () {
    $('#btnEnable').trigger('click');
});

step(function () {
    check('启用后提示已启用', /已启用/.test(toast()), toast());
    check('启用后这张报表回到上部（启用组内按更新时间倒序，它最晚在前）',
        /（副本）/.test(items().eq(0).text()) && items().eq(0).find('.rpt-item__dot').hasClass('is-on'),
        items().map(function () {
            return $(this).find('.rpt-item__code').text() +
                ($(this).find('.rpt-item__dot').hasClass('is-on') ? '(启用)' : '(停用)');
        }).get().join(' | '));
    $('#btnDisable').trigger('click');
});

step(function () {
    check('停用后提示已停用', /已停用/.test(toast()), toast());
    check('停用后回到停用区（它之后不再出现启用报表）', (function () {
        var idxCopy = -1, firstEnabledAfter = -1;
        items().each(function (i) {
            if (/（副本）/.test($(this).text())) { idxCopy = i; }
        });
        items().each(function (i) {
            if (i > idxCopy && $(this).find('.rpt-item__dot').hasClass('is-on')) {
                firstEnabledAfter = i;
            }
        });
        return idxCopy > 0 && firstEnabledAfter < 0;
    })(), items().map(function () {
        return $(this).find('.rpt-item__code').text() +
            ($(this).find('.rpt-item__dot').hasClass('is-on') ? '(启用)' : '(停用)');
    }).get().join(' | '));
    $('#btnDelete').trigger('click');
    check('删除前弹出确认框', /确定删除报表/.test(msgBox().text()), msgBox().text().slice(0, 40));
    msgBox().find('.btn-ok').trigger('click');
});

step(function () {
    check('删除后清单少一条', items().length >= 2, String(items().length));
    check('删除的是副本（清单里没有「（副本）」）', items().filter(function () {
        return /（副本）/.test($(this).text());
    }).length === 0);
});

step(function () {
    console.log('\n--- 20. 左栏页签与筛选 ---');
    R().setLeftTab('list');
    check('切回报表清单页签', tabActive('#rptLeftTabs', 'list'));
    $('#rpKeyword').val('花名册');
    $('#btnSearch').trigger('click');
});

step(function () {
    check('关键字筛选后只剩 1 条', items().length === 1, String(items().length));
    $('#btnReset').trigger('click');
});

step(function () {
    check('重置后恢复全部', items().length >= 2, String(items().length));
    check('快捷键提示：保存按钮有 title', /保存/.test($('#btnSave').attr('title')),
        $('#btnSave').attr('title'));
    check('调试入口已挂到 window.RptDesigner', typeof win.RptDesigner === 'object' &&
        typeof win.RptDesigner.save === 'function');
});

step(function () {
    console.log('\n--- 21. 工具箱：组件加入设计区 ---');
    if (!R().columns().length) {
        R().columns().push(
            { field: 'code', label: '工号', table: 'empinfos', width: 120, align: 'left',
              headerAlign: 'center', format: 'text', summary: 'none', visible: true },
            { field: 'nameCn', label: '姓名', table: 'empinfos', width: 120, align: 'left',
              headerAlign: 'center', format: 'text', summary: 'none', visible: true });
        R().state.design.reportName = R().state.design.reportName || '组件测试报表';
        R().state.design.mainTable = R().state.design.mainTable || 'empinfos';
        R().renderCanvas();
    }
    check('画布上有可用的列（组件表格 / 图表依赖列定义）', R().columns().length >= 1,
        String(R().columns().length));
    R().setLeftTab('tool');
    check('左栏切到「工具箱」页签', tabActive('#rptLeftTabs', 'tool'));
    check('工具箱有 6 个组件卡片', $('#toolGrid .rpt-tool__card').length === 6,
        String($('#toolGrid .rpt-tool__card').length));
    var names = $('#toolGrid .rpt-tool__name').map(function () { return $(this).text(); }).get().join('/');
    check('组件为 文本/线条/区域/图像/图表/表格', names === '文本/线条/区域/图像/图表/表格', names);
    check('卡片可拖拽且有说明 title',
        $('#toolGrid .rpt-tool__card').eq(0).attr('draggable') === 'true' &&
        !!$('#toolGrid .rpt-tool__card').eq(2).attr('title'),
        $('#toolGrid .rpt-tool__card').eq(2).attr('title'));
    check('设计区为空时显示引导文字', !$('#rptFreeHint').prop('hidden'));
});

step(function () {
    /* 文本：双击卡片加入 */
    $('#toolGrid .rpt-tool__card[data-el-kind="label"]').trigger('dblclick');
    check('双击「文本」加入一个组件', R().elements().length === 1, String(R().elements().length));
    check('画布里出现文本组件', $('#rptFreeLayer > .rpt-el--label').length === 1);
    check('自动切到「组件属性」页签', tabActive('#rptPropTabs', 'elem'));
    check('组件属性回填类型', /文本/.test($('#elemKind').text()), $('#elemKind').text());
    check('空态引导文字隐藏', $('#rptFreeHint').prop('hidden') === true);
    check('工具箱列表记了 1 个组件', $('#toolCount').text() === '1 个', $('#toolCount').text());
});

step(function () {
    $('#elemText').val('九豆报表').trigger('input');
    $('#elemFontSize').val('20').trigger('input');
    $('#elemBold').val('1').trigger('change');
    $('#elemAlign').val('center').trigger('change');
    var el = R().elements()[0];
    check('改文字同步到模型', el.text === '九豆报表', el.text);
    check('改字号 / 加粗 / 对齐同步到模型',
        el.fontSize === 20 && el.bold === true && el.align === 'center',
        [el.fontSize, el.bold, el.align].join('/'));
    var $node = $('#rptFreeLayer > .rpt-el--label');
    check('画布文字已更新', /九豆报表/.test($node.text()), $node.text());
    var inner = $node.find('span').attr('style') || '';
    check('画布文字带字号与居中', /font-size:\s*20px/.test(inner) && /text-align:\s*center/.test(inner),
        inner);
});

step(function () {
    $('#elemX').val('40').trigger('input');
    $('#elemY').val('24').trigger('input');
    $('#elemW').val('300').trigger('input');
    $('#elemH').val('60').trigger('input');
    var el = R().elements()[0];
    check('改位置与尺寸同步到模型',
        el.x === 40 && el.y === 24 && el.w === 300 && el.h === 60,
        [el.x, el.y, el.w, el.h].join('/'));
    var style = $('#rptFreeLayer > .rpt-el--label').attr('style') || '';
    check('画布按新坐标摆放', /left:\s*40px/.test(style) && /top:\s*24px/.test(style) &&
        /width:\s*300px/.test(style) && /height:\s*60px/.test(style), style);
});

step(function () {
    console.log('    · 拖拽加入线条 / 区域 / 图像 / 图表');
    fakeDrop($('#toolGrid .rpt-tool__card[data-el-kind="line"]'), $('#rptFreeLayer'));
    check('拖入「线条」', R().elements().length === 2 &&
        R().elements()[1].kind === 'line', String(R().elements().length));
    check('画布线条有默认粗细与颜色',
        !!$('#rptFreeLayer > .rpt-el--line i').length &&
        /height:\s*1px/.test($('#rptFreeLayer > .rpt-el--line i').attr('style') || ''),
        $('#rptFreeLayer > .rpt-el--line i').attr('style'));
});

step(function () {
    fakeDrop($('#toolGrid .rpt-tool__card[data-el-kind="box"]'), $('#rptFreeLayer'));
    check('拖入「区域」', R().elements().length === 3 &&
        R().elements()[2].kind === 'box', String(R().elements().length));
    var box = R().elements()[2];
    check('区域默认带边框 / 圆角 / 内边距',
        box.border === true && box.radius >= 0 && box.padding >= 0,
        [box.border, box.radius, box.padding].join('/'));
    /* 把「表格」拖进区域里（drop 目标就是区域元素） */
    var $box = $('#rptFreeLayer > .rpt-el--box').first();
    fakeDrop($('#toolGrid .rpt-tool__card[data-el-kind="table"]'), $box);
});

step(function () {
    var box = R().elements()[2];
    check('区域接住了「表格」（成为子组件）',
        (box.children || []).length === 1 && box.children[0].kind === 'table',
        JSON.stringify(box.children || []).slice(0, 80));
    check('画布里区域内部渲染出表格', $('#rptFreeLayer .rpt-el--box .rpt-el--table table').length === 1,
        ($('#rptFreeLayer .rpt-el--box').html() || '').slice(0, 200));
    var cell = box.children[0];
    check('表格默认 3 行 3 列，首行表头',
        cell.rows === 3 && cell.cols === 3 && cell.headerRow === true,
        [cell.rows, cell.cols, cell.headerRow].join('/'));
    check('表格默认表头是 列1/列2/列3',
        (cell.cells[0] || []).join('/') === '列1/列2/列3', JSON.stringify(cell.cells));
    check('画布里表格渲染出 3 行（含表头）',
        $('#rptFreeLayer .rpt-el--box .rpt-el--table tr').length === 3,
        String($('#rptFreeLayer .rpt-el--box .rpt-el--table tr').length));
    check('区域里的表格表头是用户填的内容（不再镜像报表列）',
        $('#rptFreeLayer .rpt-el--box .rpt-el--table th').first().text() === '列1',
        $('#rptFreeLayer .rpt-el--box .rpt-el--table th').first().text());
});

step(function () {
    fakeDrop($('#toolGrid .rpt-tool__card[data-el-kind="image"]'), $('#rptFreeLayer'));
    var img = R().elements()[R().elements().length - 1];
    check('拖入「图像」并有默认地址', img.kind === 'image' && /logo\.svg/.test(img.src), img.src);
    check('画布渲染出 img', $('#rptFreeLayer > .rpt-el--image img').length === 1);
});

step(function () {
    fakeDrop($('#toolGrid .rpt-tool__card[data-el-kind="chart"]'), $('#rptFreeLayer'));
    var chart = R().elements()[R().elements().length - 1];
    check('拖入「图表」默认柱状', chart.kind === 'chart' && chart.chartType === 'bar', chart.chartType);
    check('画布图表渲染出 svg', $('#rptFreeLayer > .rpt-el--chart svg').length === 1);
    var pts = R().chartPoints(chart, { mode: 'canvas', mapped: [], rows: [] });
    check('画布没有真实数据时给示意值', pts.length >= 2, JSON.stringify(pts));
    R().selectElement(chart.id);
    check('选中图表后属性面板显示图表字段', !$('.rpt-elgrp[data-egroup="chart"]').prop('hidden'));
    $('#elemChartType').val('pie').trigger('change');
    $('#elemChartTitle').val('按科室统计').trigger('input');
    var el2 = R().elements()[R().elements().length - 1];
    check('切换成饼图并加标题', el2.chartType === 'pie' && el2.title === '按科室统计',
        el2.chartType + ' / ' + el2.title);
    check('图表标题渲染到画布', /按科室统计/.test($('#rptFreeLayer > .rpt-el--chart').text()),
        $('#rptFreeLayer > .rpt-el--chart').text());
    check('饼图渲染成 path 扇形', $('#rptFreeLayer > .rpt-el--chart svg path').length >= 2,
        String($('#rptFreeLayer > .rpt-el--chart svg path').length));
});

step(function () {
    console.log('\n--- 22. 组件层级 / 删除 / 工具箱列表 ---');
    var first = R().elements()[0];
    R().selectElement(first.id);
    var before = R().elements().map(function (one) { return one.id; }).join(',');
    $('#btnElemUp').trigger('click');
    var after = R().elements().map(function (one) { return one.id; }).join(',');
    check('上移一层后顺序变化', before !== after, before + ' → ' + after);
    check('上移一层后该组件排到第 2 位', R().elements()[1].id === first.id,
        R().elements().map(function (one) { return one.kind; }).join(','));
    $('#btnElemDown').trigger('click');
    check('下移一层可以回来', R().elements()[0].id === first.id);
    check('工具箱列表按层级缩进（区域里的表格有子级样式）',
        $('#toolItems .rpt-tool__item--child').length >= 1,
        String($('#toolItems .rpt-tool__item--child').length));
    var listed = $('#toolItems .rpt-tool__item').length;
    check('工具箱条目数（含区域里的子组件）与计数一致',
        $('#toolCount').text() === listed + ' 个' && listed === R().elements().length + 1,
        $('#toolCount').text() + ' / 列表 ' + listed);
});

step(function () {
    var total = R().elements().length;
    R().selectElement(R().elements()[0].id);          // 删掉第一个（文本）
    $('#btnElemRemove').trigger('click');
    check('删除组件后数量 -1', R().elements().length === total - 1,
        total + ' → ' + R().elements().length);
    check('删除后回到空态提示（无选中）', $('#elemForm').prop('hidden') === true);
});

step(function () {
    console.log('\n--- 23. 列标对齐 ---');
    $('#rptCols .rpt-th').eq(0).trigger('click');
    check('选中列后回填列标对齐', $('#colHeaderAlign').val() === 'center',
        String($('#colHeaderAlign').val()));
    $('#colHeaderAlign').val('left').trigger('change');
    var th = $('#rptCols .rpt-th').eq(0).attr('style') || '';
    check('画布表头按列标对齐', /text-align:\s*left/.test(th), th);
    check('列模型记录了 headerAlign',
        R().columns()[0].headerAlign === 'left', R().columns()[0].headerAlign);
    $('#colHeaderAlign').val('right').trigger('change');
    check('切换成右对齐生效',
        /text-align:\s*right/.test($('#rptCols .rpt-th').eq(0).attr('style') || ''),
        $('#rptCols .rpt-th').eq(0).attr('style'));
});

step(function () {
    console.log('\n--- 23.5 表格组件：自己设行 / 列 / 单元格 ---');
    /* 前面的用例删过组件，这里按 kind 重新找（找不到就往区域里补一个） */
    var list = R().elements(), box = null, i;
    for (i = 0; i < list.length; i++) {
        if (list[i].kind === 'box') { box = list[i]; break; }
    }
    if (box) {
        for (i = 0; i < (box.children || []).length; i++) {
            if (box.children[i].kind === 'table') { tblEl = box.children[i]; }
        }
    }
    if (!tblEl && box) { tblEl = R().addElement('table', { parent: box.id }); }
    if (!tblEl) { tblEl = R().addElement('table'); }
    R().selectElement(tblEl.id);
    check('选中表格后组件类型显示「表格」', $('#elemKind').text() === '表格', $('#elemKind').text());
    check('右栏显示表格属性组', !$('.rpt-elgrp[data-egroup="table"]').prop('hidden'));
    check('行 / 列回填为 3 / 3',
        $('#elemTblRows').val() === '3' && $('#elemTblCols').val() === '3',
        $('#elemTblRows').val() + '/' + $('#elemTblCols').val());
    check('单元格编辑器渲染 3×3 = 9 个输入框',
        $('#elemTblCells input').length === 9, String($('#elemTblCells input').length));
    check('单元格回填默认表头内容',
        $('#elemTblCells input[data-r="0"][data-c="0"]').val() === '列1',
        $('#elemTblCells input[data-r="0"][data-c="0"]').val());
    check('尺寸摘要显示「3 行 × 3 列」', /3 行 × 3 列/.test($('#elemTblSize').text()), $('#elemTblSize').text());
});

step(function () {
    var tableEl = tblEl;
    $('#elemTblCells input[data-r="0"][data-c="1"]').val('姓名').trigger('input');
    $('#elemTblCells input[data-r="1"][data-c="0"]').val('E0001').trigger('input');
    $('#elemTblCells input[data-r="1"][data-c="1"]').val('张三').trigger('input');
    check('改单元格内容写入模型',
        tableEl.cells[0][1] === '姓名' && tableEl.cells[1][0] === 'E0001' && tableEl.cells[1][1] === '张三',
        JSON.stringify(tableEl.cells));
    var txt = $('#rptFreeLayer .rpt-el--table').text();
    check('画布同步显示单元格内容', /姓名/.test(txt) && /张三/.test(txt), txt.slice(0, 60));
});

step(function () {
    var tableEl = tblEl;
    $('#elemTblRows').val('4').trigger('change');
    check('行数改成 4 生效', tableEl.rows === 4, String(tableEl.rows));
    check('新增行留空、原有内容保留',
        tableEl.cells.length === 4 && tableEl.cells[1][1] === '张三' &&
        (tableEl.cells[3] || []).join('') === '', JSON.stringify(tableEl.cells));
    check('编辑器跟着变成 4×3 = 12 个格子',
        $('#elemTblCells input').length === 12, String($('#elemTblCells input').length));
    check('画布变成 4 行', $('#rptFreeLayer .rpt-el--table tr').length === 4,
        String($('#rptFreeLayer .rpt-el--table tr').length));

    $('#btnTblAddCol').trigger('click');
    check('点「+ 列」列数 +1 且原内容不丢',
        tableEl.cols === 4 && tableEl.cells[0][1] === '姓名', [tableEl.cols, tableEl.cells[0][1]].join('/'));
    $('#btnTblDelCol').trigger('click');
    check('点「- 列」列数 -1', tableEl.cols === 3, String(tableEl.cols));
    $('#btnTblAddRow').trigger('click');
    check('点「+ 行」行数 +1', tableEl.rows === 5, String(tableEl.rows));
    $('#btnTblDelRow').trigger('click');
    check('点「- 行」行数 -1', tableEl.rows === 4, String(tableEl.rows));
});

step(function () {
    var tableEl = tblEl;
    $('#elemTblHeader').val('0').trigger('change');
    check('关掉「首行表头」后画布没有 th',
        $('#rptFreeLayer .rpt-el--table th').length === 0 &&
        $('#rptFreeLayer .rpt-el--table td').length === 12,
        String($('#rptFreeLayer .rpt-el--table th').length));
    $('#elemTblHeader').val('1').trigger('change');
    check('打开「首行表头」后画布有 3 个 th',
        $('#rptFreeLayer .rpt-el--table th').length === 3,
        String($('#rptFreeLayer .rpt-el--table th').length));

    $('#elemTblAlign').val('center').trigger('change');
    check('单元格对齐改成居中',
        /text-align:\s*center/.test($('#rptFreeLayer .rpt-el--table tbody tr').eq(1)
            .find('td').eq(0).attr('style') || ''),
        $('#rptFreeLayer .rpt-el--table tbody tr').eq(1).find('td').eq(0).attr('style'));

    $('#btnTblClear').trigger('click');
    check('清空内容后所有格子为空、行列不变',
        tableEl.rows === 4 && tableEl.cols === 3 &&
        tableEl.cells.every(function (line) {
            return line.every(function (one) { return one === ''; });
        }), JSON.stringify(tableEl.cells));
    /* 再填回来，后面预览 / 打印要用 */
    tableEl.cells[0] = ['工号', '姓名', '科室'];
    tableEl.cells[1] = ['E0001', '张三', '内科'];
    R().renderCanvas();
    R().selectElement(tblEl.id);            // 重新选中，让右栏与画布同步
});

step(function () {
    console.log('\n--- 23.6 表格「列头显示」 ---');
    R().selectElement(tblEl.id);
    check('右栏有「列头显示」下拉', $('#elemTblShowHeader').length === 1);
    check('默认列头显示 = 是', $('#elemTblShowHeader').val() === '1',
        $('#elemTblShowHeader').val());
    check('列头显示 = 是时「列头样式」可改', !$('#elemTblHeader').prop('disabled'));

    var beforeTr = $('#rptFreeLayer .rpt-el--table tr').length;
    var beforeTh = $('#rptFreeLayer .rpt-el--table th').length;
    check('此时画布表格 4 行、3 个表头', beforeTr === 4 && beforeTh === 3,
        beforeTr + '/' + beforeTh);

    $('#elemTblShowHeader').val('0').trigger('change');
    check('设成「否」写进模型 showHeader=false', tblEl.showHeader === false,
        String(tblEl.showHeader));
    check('设成「否」后画布少一行（列头行不画）',
        $('#rptFreeLayer .rpt-el--table tr').length === beforeTr - 1,
        String($('#rptFreeLayer .rpt-el--table tr').length));
    check('设成「否」后没有 th（全是普通单元格）',
        $('#rptFreeLayer .rpt-el--table th').length === 0,
        String($('#rptFreeLayer .rpt-el--table th').length));
    check('设成「否」后「列头样式」变灰', $('#elemTblHeader').prop('disabled') === true);
    check('单元格内容还在（第 2 行升为第 1 行）',
        /张三/.test($('#rptFreeLayer .rpt-el--table tr').eq(0).text()),
        $('#rptFreeLayer .rpt-el--table tr').eq(0).text());

    $('#elemTblShowHeader').val('1').trigger('change');
    check('改回「是」后列头行回来、th 恢复',
        $('#rptFreeLayer .rpt-el--table tr').length === beforeTr &&
        $('#rptFreeLayer .rpt-el--table th').length === 3,
        $('#rptFreeLayer .rpt-el--table tr').length + '/' +
        $('#rptFreeLayer .rpt-el--table th').length);
    check('改回「是」后「列头样式」恢复可改', !$('#elemTblHeader').prop('disabled'));
});

step(function () {
    console.log('\n--- 24. 保存带组件 / 预览与打印渲染组件 ---');
    $('#btnSave').trigger('click');
});

step(function () {
    var d = R().design();
    check('保存后画布设计里仍有 components', $.isArray(d.elements) && d.elements.length >= 4,
        String((d.elements || []).length));
    var hasBox = false, hasChart = false;
    for (var i = 0; i < d.elements.length; i++) {
        if (d.elements[i].kind === 'box') { hasBox = true; }
        if (d.elements[i].kind === 'chart') { hasChart = true; }
    }
    check('保存的设计里包含区域与图表', hasBox && hasChart, JSON.stringify(d.elements.map(function (o) {
        return o.kind;
    })));
});

step(function () {
    /* 页眉 / 页脚带：预览与打印都要带出来（文字对齐 + logo 位置） */
    R().design().headerText = '九豆综合管理平台';
    R().design().headerAlign = 'right';
    R().template().headerLogo = 'assets/logo.svg';
    R().template().headerLogoHeight = 40;
    R().template().headerLogoPos = 'right';
    R().design().footerText = '制表：测试';
    R().design().footerAlign = 'right';
    R().template().footerLogo = 'assets/logo.svg';
    R().template().footerLogoPos = 'left';
    R().renderCanvas();
    /* 预览弹窗打开就会自动执行一次：必填参数先给个值，否则后端拒绝执行（那是参数校验，不是渲染问题） */
    var ps = R().params();
    for (var pi = 0; pi < ps.length; pi++) {
        if (ps[pi].required && !ps[pi].defaultValue) { ps[pi].defaultValue = '研发'; }
    }
    R().preview();
}, 1200);

step(function () {
    var body = dialogBody();
    check('预览弹窗打开', dialog().length === 1);
    check('预览纸张里渲染出设计区组件', body.find('#pvFreeLayer').prop('hidden') === false &&
        body.find('#pvFreeLayer .rpt-el').length >= 4,
        '组件数=' + body.find('#pvFreeLayer .rpt-el').length +
        ' 提示=' + (body.find('#pvTableWrap').text() || '').slice(0, 60));
    check('预览里没有「在画布中编辑」按钮', body.find('#pvEdit').length === 0);
    check('预览纸上有页眉带（文字 + logo）',
        body.find('#pvHeaderBand').prop('hidden') === false &&
        /九豆综合管理平台/.test(body.find('#pvHeaderBand').text()) &&
        body.find('#pvHeaderBand img.rpt-pageband__logo').length === 1,
        body.find('#pvHeaderBand').text());
    check('预览纸上有页脚带（文字 + logo，右对齐）',
        body.find('#pvFooterBand').prop('hidden') === false &&
        /制表：测试/.test(body.find('#pvFooterBand').text()) &&
        /text-align:\s*right/.test(body.find('#pvFooterBand .rpt-pageband__text').attr('style') || ''),
        body.find('#pvFooterBand').text());
    check('弹窗右下角不再有「关闭」按钮',
        dialog().find('.el-dialog__footer').prop('hidden') === true &&
        dialog().find('.btn-cancel').text() === '取消',
        dialog().find('.btn-cancel').text());
    check('标题栏的 ✕ 仍在（用它关窗）',
        dialog().find('.el-dialog__headerbtn').not('.el-dialog__headerbtn--max').length === 1);
    body.find('#pvPrint').trigger('click');
}, 900);

step(function () {
    var f = win.document.getElementById('rptPrintFrame');
    check('打印页已生成', !!f);
    if (!f) { return; }
    var doc = f.contentDocument;
    check('打印页包含设计区组件', !!doc && doc.querySelectorAll('.rpt-el').length >= 4,
        doc ? String(doc.querySelectorAll('.rpt-el').length) : '');
    check('打印页里区域带边框', !!doc && doc.querySelectorAll('.rpt-el--box').length >= 1);
    check('打印页里图表是 svg', !!doc && doc.querySelectorAll('.rpt-el--chart svg').length >= 1);

    /* 25. 设计区在打印页里必须「按页面位置」摆放，不能挨个堆下来 */
    var css = doc.querySelector('style') ? doc.querySelector('style').textContent : '';
    check('打印页样式里组件是绝对定位', /\.rpt-el\s*\{[^}]*position:\s*absolute/.test(css),
        css.slice(0, 80));
    check('打印页样式里区域子层参与定位（boxinner）', /\.rpt-el__boxinner/.test(css));
    check('打印页样式里标签组件仍是 flex 居中', /\.rpt-el--label\s*\{[^}]*display:\s*flex/.test(css));
    check('打印页样式里图表 svg 铺满组件框', /\.rpt-el__chart-body svg\s*\{[^}]*height:\s*100%/.test(css));

    var stage = doc.querySelector('.free .free-stage');
    check('打印页有页眉（每页重复）',
        /九豆综合管理平台/.test(doc2head(doc).head || '') &&
        !!doc.querySelector('.sheet__band--head img.rpt-pageband__logo'),
        String(doc2head(doc).head || ''));
    check('打印页有页脚（含 logo，每页重复）',
        /制表：测试/.test(doc2head(doc).foot || '') &&
        !!doc.querySelector('.sheet__band--foot img.rpt-pageband__logo'),
        String(doc2head(doc).foot || ''));
    /* 页眉压表头的老 bug：fixed 不占流内空间，第 2 页起正文（含重复表头）会顶到纸张顶端。
       现在页眉放进外层表格的 thead、页脚放进 tfoot，Chromium 每页重复且自动给正文让位 */
    check('页眉在外层表格 thead 里（每页重复且占位）',
        !!doc.querySelector('table.sheet > thead .sheet__band--head'), '');
    check('页脚在外层表格 tfoot 里', !!doc.querySelector('table.sheet > tfoot .sheet__band--foot'), '');
    /* 这里只验证「正文都在 tbody 的单元格里」这一层结构：数据表带 data 类，
       外框是 bordered 还是 plain 取决于模板里的「边框」开关（第 13 步已被关掉），不在这条断言里判 */
    check('正文（标题 / 数据表 / 汇总）都在 tbody 单元格里',
        !!doc.querySelector('table.sheet > tbody > tr > td') &&
        !!doc.querySelector('table.sheet > tbody > tr > td table.data'),
        (function () {
            var td = doc.querySelector('table.sheet > tbody > tr > td');
            var t = td ? td.querySelector('table.data') : null;
            return t ? t.className : 'no data table';
        })());
    check('页眉页脚不再是 position:fixed（否则不占位、会压住第 2 页表头）',
        !/\.pageband\s*\{[^}]*position:\s*fixed/.test(printCssText(doc)) &&
        !/\.pagebody/.test(printCssText(doc)),
        printCssText(doc).slice(-120));
    check('打印页设计区包在定宽画布里（.free-stage）', !!stage);
    if (stage) {
        check('画布按组件占用范围定宽定高', /width:\s*\d+px/.test(stage.getAttribute('style') || '') &&
            /height:\s*\d+px/.test(stage.getAttribute('style') || ''), stage.getAttribute('style'));
        check('画布整体等比缩放贴在左上角（transform-origin:left top）',
            /transform:scale\([\d.]+\)/.test(stage.getAttribute('style') || '') &&
            /transform-origin:left top/.test(stage.getAttribute('style') || ''),
            stage.getAttribute('style'));
        var wrap = stage.parentNode;
        check('外层按缩放后的高度占位（不会被裁切 / 不会顶到表格）',
            /height:\s*\d+px/.test(wrap.getAttribute('style') || ''), wrap.getAttribute('style'));
    }
    var els = doc.querySelectorAll('.free .rpt-el');
    var positioned = 0;
    for (var i = 0; i < els.length; i++) {
        var st = els[i].getAttribute('style') || '';
        if (/left:\s*-?\d+px/.test(st) && /top:\s*-?\d+px/.test(st)) { positioned++; }
    }
    check('每个组件都带 left/top 坐标（不被重置成堆叠）', positioned === els.length,
        positioned + '/' + els.length);

    /* 区域里的子组件：坐标相对区域内容区（padding 内缩），不能和区域左上角重合 */
    var box = doc.querySelector('.rpt-el--box');
    var inner = box ? box.querySelector('.rpt-el') : null;
    check('区域里有子组件', !!inner);
    if (inner) {
        var pad = (box.querySelector('.rpt-el__boxinner').getAttribute('style') || '')
            .match(/padding:\s*(\d+)px/);
        check('区域内容区按 padding 内缩', !!pad, box.querySelector('.rpt-el__boxinner')
            .getAttribute('style'));
    }

    /* 25. 弹窗最大化 / 数据表右键行号 */
    var $dlg = dialog();
    check('预览 / 运行弹窗标题栏有「最大化 / 还原」按钮',
        $dlg.find('.el-dialog__headerbtn--max').length === 1);
    check('查看窗**打开即最大化**（is-max + 96vw）',
        $dlg.hasClass('is-max') && /96vw/.test($dlg[0].style.width), $dlg[0].style.width);
    check('打开即最大化时按钮显示「还原」',
        $dlg.find('.el-dialog__headerbtn--max').attr('title') === '还原',
        $dlg.find('.el-dialog__headerbtn--max').attr('title'));
    $dlg.find('.el-dialog__headerbtn--max').trigger('click');
    check('点「还原」后 is-max 去掉、宽度回到 1080',
        !$dlg.hasClass('is-max') && /1080/.test($dlg[0].style.width), $dlg[0].style.width);
    check('还原后按钮变回「最大化」',
        $dlg.find('.el-dialog__headerbtn--max').attr('title') === '最大化');
    $dlg.find('.el-dialog__headerbtn--max').trigger('click');
    check('再点一次又最大化（96vw + is-max）',
        $dlg.hasClass('is-max') && /96vw/.test($dlg[0].style.width), $dlg[0].style.width);

    /* 右击数据表 → 行号显示 */
    var $table = dialogBody().find('#pvTableWrap .rpt-pv__table');
    check('数据表渲染出来了', $table.length === 1);
    check('默认没有序号列', dialogBody().find('#pvTableWrap thead th').first().text() !== '序号',
        dialogBody().find('#pvTableWrap thead th').first().text());
    /* 用真实的 MouseEvent 派发（jQuery 的 preventDefault 需要原生事件） */
    $table[0].dispatchEvent(new win.MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, clientX: 200, clientY: 260 }));
    var $menu = $('.rpt-ctxmenu');
    check('右击数据表弹出菜单', $menu.length === 1);
    check('菜单里有「显示行号」项', /显示行号/.test($menu.text()), $menu.text());
    check('未开启时菜单项没有勾',
        $menu.find('[data-act="rownum"] .rpt-ctxmenu__check').text() === '');
    $menu.find('[data-act="rownum"]').trigger('click');
    check('点菜单后弹出菜单收起', $('.rpt-ctxmenu').length === 0);
    check('表格最左侧插入「序号」列',
        dialogBody().find('#pvTableWrap thead th').first().text() === '序号',
        dialogBody().find('#pvTableWrap thead th').first().text());
    check('序号列从 1 开始递增',
        dialogBody().find('#pvTableWrap tbody tr').eq(0).find('td').first().text() === '1' &&
        dialogBody().find('#pvTableWrap tbody tr').eq(2).find('td').first().text() === '3',
        dialogBody().find('#pvTableWrap tbody tr').eq(0).find('td').first().text() + '/' +
        dialogBody().find('#pvTableWrap tbody tr').eq(2).find('td').first().text());
    check('行号写进设计（保存后仍在）', R().design().showRowNo === true,
        String(R().design().showRowNo));

    /* 开启行号后，打印页也要带序号列 */
    dialogBody().find('#pvPrint').trigger('click');
}, 900);

step(function () {
    var f = win.document.getElementById('rptPrintFrame');
    var doc2 = f ? f.contentDocument : null;
    var headTxt = doc2 && doc2.querySelector('table.data thead th') ?
        doc2.querySelector('table.data thead th').textContent : '';
    check('开启行号后打印页带「序号」表头', /序号/.test(headTxt), headTxt);
    var first = doc2 ? doc2.querySelector('table.data tbody tr td') : null;
    check('打印页第一行序号是 1', !!first && String(first.textContent).trim() === '1',
        first ? first.textContent : '');
    closeDialog();
});

step(function () {
    check('关闭预览弹窗', $('.el-overlay').length === 0);

    /* 26. 组件位置原样带到打印页；超宽时整体等比缩小（打印 / 预览 / 导出同一算法） */
    var els = R().elements();
    var bounds = R().elementBounds(els, 0, 0);
    check('elementBounds 汇总到组件右下边界', bounds.right > 0 && bounds.bottom > 0,
        JSON.stringify(bounds));
    check('纸张换算（A4 纵向 210×297）', R().paperMm({ paper: 'A4', orientation: 'portrait' }).w === 210 &&
        R().paperMm({ paper: 'A4', orientation: 'landscape' }).w === 297);
    check('宽度够时不放大（scale=1）', R().stageScale(600, 720) === 1);
    check('宽度不够时按比例缩', Math.abs(R().stageScale(1440, 720) - 0.5) < 1e-9);

    /* jsdom 里 drop 的坐标都是 0，这里手工摆位，验证 left/top 原样输出 */
    var backup = [];
    var tops = [24, 90, 130, 210, 300];
    var i;
    for (i = 0; i < els.length; i++) {
        backup.push([els[i].x, els[i].y]);
        els[i].x = 40;
        els[i].y = tops[i % tops.length];
    }
    function printHtmlOf() {
        return R().buildPrintHtml({ mapped: [], rows: [], template: R().template(),
            design: R().design(), report: { reportName: '版式探针' } });
    }
    var html = printHtmlOf();
    check('组件纵向坐标原样写到打印页', html.indexOf('top:24px') >= 0 &&
        html.indexOf('top:' + tops[els.length - 1] + 'px') >= 0,
        (html.match(/top:\d+px/g) || []).slice(0, 6).join(','));
    var stageH = html.match(/free-stage" style="width:\d+px;height:(\d+)px/);
    check('画布高度 = 最下面组件的底边 + 余量',
        !!stageH && parseInt(stageH[1], 10) >= tops[els.length - 1] + 20, stageH ? stageH[1] : '没有高度');

    els[0].x = 1400;                                  // 故意撑到纸外
    var wide = printHtmlOf();
    var m = wide.match(/transform:scale\(([\d.]+)\)/);
    var stageW = wide.match(/free-stage" style="width:(\d+)px/);
    check('超宽时打印页把设计区缩小到纸内', !!m && parseFloat(m[1]) < 1 && parseFloat(m[1]) > 0.1,
        m ? m[1] : '没有 scale');
    check('超宽时画布宽度仍按组件占用范围（不裁掉右边）', !!stageW && parseInt(stageW[1], 10) >= 1400,
        stageW ? stageW[1] : '没有宽度');
    var wrapH = wide.match(/class="free" style="height:(\d+)px/);
    check('缩小后外层高度同步变小（页面不被撑开）',
        !!wrapH && !!stageH && parseInt(wrapH[1], 10) < parseInt(stageH[1], 10),
        (wrapH || [''])[0]);

    for (i = 0; i < els.length; i++) {
        els[i].x = backup[i][0];
        els[i].y = backup[i][1];
    }

    /* 27. 打印 / 预览用「结果自带的设计」：双击清单运行别的报表时不能串用画布上的组件 */
    var other = R().buildPrintHtml({ mapped: [], rows: [], design: { elements: [] },
        template: R().template(), report: { reportName: '另一张报表' } });
    check('结果里没有组件时打印页也不画组件（不串用画布上的）',
        other.indexOf('class="free"') < 0 && other.indexOf('class="free-stage"') < 0,
        (other.match(/class="free[^"]*"/) || ['无'])[0]);

    var mixed = R().buildPrintHtml({
        mapped: [], rows: [], template: R().template(), report: { reportName: '另一张报表' },
        design: { elements: [{ id: 'x1', kind: 'label', x: 5, y: 5, w: 120, h: 24,
            text: '外部组件', fontSize: 12, bold: false, align: 'left', color: '#303133' }] }
    });
    check('打印页按传入的组件渲染（不是画布上的那张报表）',
        mixed.indexOf('外部组件') >= 0 && mixed.indexOf('九豆报表') < 0,
        mixed.indexOf('外部组件') + '/' + mixed.indexOf('九豆报表'));
});

/* ---------- 28. SQL 自定义列（2026-11-05）：编辑 SQL 检测新增别名 → 回显数据表格 → 字段属性设风格 ---------- */
step(function () {
    console.log('\n--- 28. SQL 自定义列：别名解析（引号 / 注释 / 子查询安全）---');
    var parse = R().sqlSelectAliases;
    check('测试入口暴露 sqlSelectAliases', typeof parse === 'function', typeof parse);
    if (typeof parse !== 'function') { return; }
    check('AS 形式别名（含中文）',
        parse('SELECT code, nameCn, salary * 12 AS 年薪 FROM empinfos').join(',') === '年薪',
        JSON.stringify(parse('SELECT code, nameCn, salary * 12 AS 年薪 FROM empinfos')));
    check('裸别名（ename 姓名 / 表达式 别名 / count(*) cnt）',
        parse('SELECT ename 姓名, salary * 12 年薪, count(*) cnt FROM empinfos').join(',') === '姓名,年薪,cnt',
        JSON.stringify(parse('SELECT ename 姓名, salary * 12 年薪, count(*) cnt FROM empinfos')));
    check('反引号别名',
        parse('SELECT salary * 12 AS `年薪合计` FROM empinfos').join(',') === '年薪合计',
        JSON.stringify(parse('SELECT salary * 12 AS `年薪合计` FROM empinfos')));
    check('子查询里的 FROM / 字符串里的逗号不干扰',
        parse("SELECT (SELECT MAX(a) FROM t2) AS mx, CONCAT(',', name) AS 标签 FROM empinfos").join(',') === 'mx,标签',
        JSON.stringify(parse("SELECT (SELECT MAX(a) FROM t2) AS mx, CONCAT(',', name) AS 标签 FROM empinfos")));
    check('注释里的伪列不识别',
        parse('SELECT code /*, fake AS x*/, salary AS s FROM emp -- note AS y').join(',') === 's',
        JSON.stringify(parse('SELECT code /*, fake AS x*/, salary AS s FROM emp -- note AS y')));
    check('无别名的表达式列不回显（a + b 由数据库自己命名）',
        parse('SELECT a + b FROM t').length === 0,
        JSON.stringify(parse('SELECT a + b FROM t')));
    check('DISTINCT / 关键字不会被当成别名',
        parse('SELECT DISTINCT code FROM empinfos').length === 0 &&
        parse('SELECT CASE WHEN a > 1 THEN b END FROM empinfos').length === 0,
        JSON.stringify(parse('SELECT DISTINCT code FROM empinfos')) + '/' +
        JSON.stringify(parse('SELECT CASE WHEN a > 1 THEN b END FROM empinfos')));

    /* 2026-11-06：别名判定改为**按空白分词**，不再逐字符猜 */
    var toks = R().sqlTokensOf;
    check('测试入口暴露 sqlTokensOf（空白分词）', typeof toks === 'function', typeof toks);
    check('分词按空格切、引号与括号内不切',
        JSON.stringify(toks('salary * 12 AS 年薪')) === '["salary","*","12","AS","年薪"]' &&
        JSON.stringify(toks('COUNT(*) cnt')) === '["COUNT(*)","cnt"]' &&
        JSON.stringify(toks('CONCAT(a, b) AS "总 计"')) ===
            '["CONCAT(a, b)","AS","\\"总 计\\""]',
        JSON.stringify(toks('CONCAT(a, b) AS "总 计"')));
    check('紧贴的表达式不算别名（salary*12 没有空格）',
        parse('SELECT salary*12 FROM empinfos').length === 0,
        JSON.stringify(parse('SELECT salary*12 FROM empinfos')));
    check('表达式 + 空格 + 别名才算（salary*12 年薪）',
        parse('SELECT salary*12 年薪 FROM empinfos').join(',') === '年薪',
        JSON.stringify(parse('SELECT salary*12 年薪 FROM empinfos')));
    check('运算符后的词不当别名（a + b / a * b AS 积 的干扰）',
        parse('SELECT a + b, c - d FROM t').length === 0 &&
        parse('SELECT a * b AS 积 FROM t').join(',') === '积',
        JSON.stringify(parse('SELECT a + b, c - d FROM t')) + '/' +
        JSON.stringify(parse('SELECT a * b AS 积 FROM t')));
    check('带空格的引号别名整体算一个别名',
        parse('SELECT salary AS "Monthly Salary" FROM empinfos').join(',') === 'Monthly Salary',
        JSON.stringify(parse('SELECT salary AS "Monthly Salary" FROM empinfos')));
    check('SELECT * 与纯函数调用不产生别名',
        parse('SELECT * FROM empinfos').length === 0 &&
        parse('SELECT COUNT(*), SUM(a) FROM t').length === 0,
        JSON.stringify(parse('SELECT * FROM empinfos')) + '/' +
        JSON.stringify(parse('SELECT COUNT(*), SUM(a) FROM t')));
});

step(function () {
    console.log('\n--- 28.2 SQL 自定义列：输入 SQL → 回显进数据表格 → 字段属性设风格 ---');
    check('设计器有 SQL 输入框 #rptSqlText', $('#rptSqlText').length === 1,
        String($('#rptSqlText').length));
    $('#rptSqlText').val('SELECT code, nameCn, salary * 12 AS 年薪, COUNT(*) AS total ' +
        'FROM empinfos GROUP BY code').trigger('input');
});

step(function () {
    var all = cols(), custom = [];
    for (var i = 0; i < all.length; i++) { if (all[i].custom) { custom.push(all[i]); } }
    var fields = $.map(custom, function (c) { return c.field; });
    check('SQL 里的别名列自动回显进设计器数据表格（custom:1，共 2 个）',
        custom.length === 2 && fields.join(',') === '年薪,total',
        JSON.stringify(fields));
    check('自定义列默认可见、进画布明细区（表头出现年薪 / total）',
        grid().find('thead th').length >= 2 &&
        /年薪/.test(grid().find('thead').text()) && /total/.test(grid().find('thead').text()),
        grid().find('thead').text().slice(0, 60));
    check('画布表头带「自定义」标记（.rpt-th__tag × 2）',
        grid().find('thead .rpt-th__tag').length === 2,
        String(grid().find('thead .rpt-th__tag').length));
    /* 选中自定义列后，属性面板要说明这是 SQL 自定义列（不是数据源字段） */
    var idx = -1;
    for (var k = 0; k < all.length; k++) { if (all[k].field === '年薪') { idx = k; break; } }
    grid().find('thead th[data-index="' + idx + '"]').trigger('click');
    check('字段属性面板提示「SQL 自定义列」',
        /SQL 自定义列/.test($('#colFieldTip').text() || ''), $('#colFieldTip').text());
    /* 在字段属性里改显示风格：右对齐 + 改显示名 → 画布同步 */
    $('#colAlign').val('right').trigger('change');
    $('#colLabel').val('年薪酬').trigger('change');
});

step(function () {
    var all = cols(), col = null;
    for (var i = 0; i < all.length; i++) { if (all[i].field === '年薪') { col = all[i]; break; } }
    check('字段属性改的对齐 / 显示名写回列定义（custom 列可正常设置显示风格）',
        !!col && col.align === 'right' && col.label === '年薪酬',
        col ? (col.align + '/' + col.label) : '没找到年薪列');
    var $th = grid().find('thead th').filter(function () { return /年薪酬/.test($(this).text()); });
    check('画布表头同步显示名与自定义标记（列标对齐仍是 center，数据对齐看单元格）',
        $th.length === 1 && $th.find('.rpt-th__tag').length === 1 &&
        /center/.test($th.attr('style') || ''),
        $th.attr('style') || '没有表头');
    var $td = grid().find('tbody tr').last().find('td').eq(
        grid().find('thead th').index($th));
    check('画布数据单元格同步右对齐', /right/.test($td.attr('style') || ''), $td.attr('style'));
});

step(function () {
    console.log('\n--- 28.3 SQL 内容变化 → 自定义列全量重算（不只增不减）---');
    /* 改 SQL：去掉 total、新增「平均月薪」，保留「年薪」 */
    $('#rptSqlText').val('SELECT code, nameCn, salary * 12 AS 年薪, salary / 12 AS 平均月薪 ' +
        'FROM empinfos').trigger('input');
});

step(function () {
    var all = cols(), custom = [], byField = {};
    for (var i = 0; i < all.length; i++) {
        byField[String(all[i].field)] = all[i];
        if (all[i].custom) { custom.push(all[i]); }
    }
    var fields = $.map(custom, function (c) { return c.field; });
    check('SQL 里删掉的别名对应的列被移除（total 不再在明细表里）',
        !byField.total, Object.keys(byField).join(','));
    check('SQL 里新增的别名自动补列（平均月薪，custom:1）',
        !!byField['平均月薪'] && !!byField['平均月薪'].custom, String(byField['平均月薪']));
    check('留下的自定义列不被重复添加（年薪只有一列）',
        custom.filter(function (c) { return c.field === '年薪'; }).length === 1, JSON.stringify(fields));
    check('留下的自定义列保留用户调好的显示风格（显示名 / 对齐不变）',
        byField['年薪'] && byField['年薪'].label === '年薪酬' && byField['年薪'].align === 'right',
        byField['年薪'] ? (byField['年薪'].label + '/' + byField['年薪'].align) : '没找到年薪列');
    check('画布表头同步：不再有 total、新增平均月薪',
        !/total/.test(grid().find('thead').text()) &&
        /平均月薪/.test(grid().find('thead').text()),
        grid().find('thead').text().slice(0, 80));
    check('提示里同时说明新增与移除', /新增/.test(toast()) && /移除/.test(toast()), toast());
});

step(function () {
    console.log('\n--- 28.3 SQL 自定义列：custom 标记随保存落库（Mock 列白名单保留）---');
    var KEY = 'menu_admin_reportinfos_v1';
    function readStored() {
        try { return JSON.parse(win.localStorage.getItem(KEY) || '[]') || []; } catch (e) { return []; }
    }
    function rowOf(list, id) {
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(id)) { return list[i]; }
        }
        return null;
    }
    win.__rptBefore = (rowOf(readStored(), R().state.design.id) || {}).version || 0;
    R().save();
});

step(function () {
    var KEY = 'menu_admin_reportinfos_v1';
    var stored = [];
    try { stored = JSON.parse(win.localStorage.getItem(KEY) || '[]') || []; } catch (e) { stored = []; }
    var row = null;
    for (var i = 0; i < stored.length; i++) {
        if (String(stored[i].id) === String(R().state.design.id)) { row = stored[i]; break; }
    }
    check('保存成功且版本号 +1', !!row && (row.version || 0) === win.__rptBefore + 1,
        row ? (row.version + '（保存前 ' + win.__rptBefore + '） toast: ' + toast()) : '没找到报表');
    var savedCustom = [];
    if (row && row.columns) {
        for (var k = 0; k < row.columns.length; k++) {
            if (row.columns[k].custom) { savedCustom.push(row.columns[k].field); }
        }
    }
    check('custom 标记随列定义一起保存（重新打开仍显示「自定义」）',
        savedCustom.join(',') === '年薪,平均月薪', JSON.stringify(savedCustom));
    check('已保存的列里不再有被移除的 total',
        !/total/.test(JSON.stringify(row && row.columns)), JSON.stringify(row && row.columns).slice(0, 120));
});

step(function () {
    console.log('\n--- 28.5 SQL 清空 → 自定义列全部移除（数据源字段列保留）---');
    R().state.design.sqlText = '';
    $('#rptSqlText').val('').trigger('input');
});

step(function () {
    var all = cols(), custom = [];
    for (var i = 0; i < all.length; i++) { if (all[i].custom) { custom.push(all[i]); } }
    check('SQL 清空后自定义列全部移除', custom.length === 0, JSON.stringify($.map(custom, function (c) {
        return c.field;
    })));
    check('数据源字段列保留（清空 SQL 不会清掉画布上的表字段）', all.length >= 1,
        String(all.length));
    check('画布表头不再有「自定义」标记', grid().find('thead .rpt-th__tag').length === 0,
        String(grid().find('thead .rpt-th__tag').length));
});

next();
