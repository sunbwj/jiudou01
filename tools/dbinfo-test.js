/* ==========================================================================
   dbinfo-test.js —— 数据中心 · 数据库连接页测试（jsdom，Mock 通道）
   覆盖三栏工作区：
        ① 首屏：标题（数据库）/ 面包屑 / 左（检索 + 8 个**纯图标**操作按钮 + 连接列表 + 分页）/
           中（只有结构树）/ 右（**标签页**：字段明细 + SQL 工作台）；
        ② 新增弹窗：字段齐全、类型联动（SQLite 隐藏主机端口 / 标签换「库文件路径」）、
           必填校验、保存后列表出现新连接；
        ③ 编辑（密码留空不修改）、测试连接、启用 / 停用、删除（确认框）；
        ④ 双击连接 → 扫描实例（含「当前」「系统」与表数量）→ 自动展开首个实例的表 / 视图，
           SQL 区域的实例下拉被同步填充；
        ⑤ 表 / 视图节点**单击不加载**（防误操作）：字段明细、数据页、SQL 编辑器都保持原样；
        ⑥ **双击表** → 三个标签一起刷新：字段明细列出字段（名 / 类型 / 键 / 可空 / 默认值 / 注解）、
           数据页懒加载第 1 页（首屏 100 行、可加载更多）、SQL 编辑器填充 SELECT * FROM 表；标签页不硬跳；
        ⑦ 数据页：点列名排序（升序→降序→取消）、按列筛选（条件以标签展示可移除）、表头 sticky 固定；
        ⑦ SQL 执行：空语句提示、写操作被拒、查询成功（信息条 + 结果表行列）、清空。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/dbinfo-test.js
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

function boot(page, scripts) {
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

var win = boot('dbinfo.html', ['js/dbinfo.js']);
var $ = win.jQuery;

function items() { return $('#dbList .db-item'); }
function dialog() { return $('.el-overlay .el-dialog').last(); }
function dialogBody() { return dialog().find('.el-dialog__body'); }
function toast() { return $('.el-message-list').text(); }
function msgBox() { return $('.el-message-box').last(); }
function dbNodes() { return $('#dbTree .el-tree-node[data-kind="db"]'); }
function tableNodes() { return $('#dbTree .el-tree-node[data-kind="table"], #dbTree .el-tree-node[data-kind="view"]'); }
function colRows() { return $('#dbColsBody .db-cols__table tbody tr'); }
function tabText(i) { return $('#dbTabs .el-tabs__item').eq(i).text().replace(/\s+/g, ''); }
function tabActive(name) {
    return $('#dbTabs .el-tabs__item[data-tab="' + name + '"]').hasClass('is-active');
}
function paneHidden(name) {
    return !$('#dbTabs .el-tab-pane[data-pane="' + name + '"]').hasClass('is-active');
}
function dataRows() { return $('#dbRowsGrid .db-rows__table tbody tr'); }
function dataHead() { return $('#dbRowsGrid .db-rows__table thead th'); }
function dataCellText(rowIdx) { return dataRows().eq(rowIdx).text(); }
function colHead() { return $('#dbColsBody .db-cols__table thead th'); }
function resultCols() { return $('#sqlResult .db-result__table thead th').not('.is-idx'); }
function resultRows() { return $('#sqlResult .db-result__table tbody tr'); }

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 600 }); }
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
    check('页面标题为「数据库」', $('.page-head__title').text() === '数据库',
        $('.page-head__title').text());
    check('面包屑为「数据中心/数据库」', $('#pageHead').attr('data-crumb') === '数据中心/数据库',
        $('#pageHead').attr('data-crumb'));
    check('左侧导航里的菜单名也是「数据库」', /数据库/.test($('.app-side__item.is-active').text()),
        $('.app-side__item.is-active').text().replace(/\s+/g, ''));
    // 历史上「去说明卡」需求把 .page-head__hint 整段注释掉了（dbinfo.html 第 73 行），
    // 分工改由三栏自身布局表达；断言同步成「不再有可见的说明卡」。
    check('标题旁不再挂说明卡（去说明卡后靠三栏布局表达分工）',
        $('.page-head__hint').length === 0, String($('.page-head__hint').length));
    var $panes = $('.db-layout').children();
    check('主区是三栏（左 / 中 / 右）', $panes.length === 3, String($panes.length));
    check('左区域在最前、中区域居中、右区域在最后',
        $panes.eq(0).hasClass('db-pane--left') && $panes.eq(1).hasClass('db-pane--mid') &&
        $panes.eq(2).hasClass('db-pane--right'));
});

step(function () {
    console.log('\n--- 1.1 左区域：连接对象管理与查询 ---');
    check('左栏标题为「连接对象」', /连接对象/.test($('.db-pane--left .db-pane__title').text()),
        $('.db-pane--left .db-pane__title').text());
    check('检索条件有 关键字 / 类型 / 启用状态',
        $('#dbKeyword').length === 1 && $('#dbType').length === 1 && $('#dbEnabled').length === 1);
    check('类型下拉已加载全部主流数据库（含 SQLite）',
        $('#dbType option').length >= 7 && /SQLite/.test($('#dbType').text()), $('#dbType').text());
    check('查询 / 重置按钮在同一行区域', $('#btnSearch').length === 1 && $('#btnReset').length === 1);
    check('操作按钮齐全（新增 / 编辑 / 启用 / 停用 / 测试 / 扫描 / 删除 / 刷新）',
        ['#btnAdd', '#btnEdit', '#btnEnable', '#btnDisable', '#btnTest', '#btnScan', '#btnDelete', '#btnRefresh']
            .every(function (id) { return $(id).length === 1; }));
    check('8 个操作按钮都在 .toolbar 里（可被 pageopbtn 收录）',
        $('.db-toolbar button').length === 8, String($('.db-toolbar button').length));
    var $tools = $('.db-toolbar button');
    check('操作按钮只显示图标：按钮文字为空、每个都有 svg 图标',
        $tools.filter(function () { return $.trim($(this).text()) !== ''; }).length === 0 &&
        $tools.filter(function () { return $(this).find('svg').length === 1; }).length === 8,
        $tools.map(function () { return $.trim($(this).text()); }).get().join('|'));
    check('图标按钮都把文案放在 title 与 aria-label 里',
        $tools.filter(function () { return !$(this).attr('title'); }).length === 0 &&
        $tools.filter(function () { return !$(this).attr('aria-label'); }).length === 0,
        $tools.map(function () { return $(this).attr('title'); }).get().join(' / '));
    check('图标按钮是方形的（.db-tool 收窄成 32px，不撑开左栏）',
        $tools.filter('.db-tool').length === 8, String($tools.filter('.db-tool').length));
    var css = read('css/app.css');
    check('CSS 里把 .db-tool 定成 32×28 的图标按钮且图标不占位',
        /\.db-toolbar \.el-button\.db-tool\s*\{[^}]*width:\s*32px/.test(css) &&
        /\.db-toolbar \.el-button\.db-tool \.svg-ico\s*\{[^}]*margin:\s*0/.test(css));
    check('未选择行时编辑 / 测试 / 扫描 / 删除按钮禁用',
        $('#btnEdit').prop('disabled') === true && $('#btnTest').prop('disabled') === true &&
        $('#btnScan').prop('disabled') === true && $('#btnDelete').prop('disabled') === true);
    check('列表渲染 Mock 的两条连接', items().length === 2, String(items().length));
    check('连接条显示名称 / 类型 / 服务器 / 默认库',
        /九豆主库/.test($('#dbList').text()) && /MySQL/.test($('#dbList').text()) &&
        /127\.0\.0\.1:3306/.test($('#dbList').text()) && /库：jiudou_main/.test($('#dbList').text()),
        $('#dbList').text().replace(/\s+/g, ' ').slice(0, 100));
    check('启用中的连接有绿色状态点', $('#dbList .db-item__dot.is-on').length === 1,
        String($('#dbList .db-item__dot.is-on').length));
    check('列表顶部显示条数', /2 条/.test($('#dbCount').text()), $('#dbCount').text());
    check('底部分页（上一页 / 页码 / 下一页）已渲染',
        $('#dbPager .db-pager__btn').length === 2 && /1 \/ 1/.test($('#dbPager').text()),
        $('#dbPager').text().replace(/\s+/g, ' '));
});

step(function () {
    console.log('\n--- 1.2 中区域：库表结构（只有实例 / 表树） ---');
    check('中栏标题为「库表结构」', /库表结构/.test($('.db-pane--mid .db-pane__title').text()),
        $('.db-pane--mid .db-pane__title').text());
    check('未选择连接时提示双击扫描', /双击/.test($('#dbTree').text()), $('#dbTree').text().slice(0, 40));
    check('中栏有「刷新」按钮用于重新扫描', $('#btnTreeRefresh').length === 1);
    check('字段明细已从中间挪走（中栏里没有字段表）',
        $('.db-pane--mid #dbColsBody').length === 0 &&
        $('.db-pane--mid .db-cols__table').length === 0);
});

step(function () {
    console.log('\n--- 1.3 右区域：字段明细 / SQL 工作台 两个标签页 ---');
    check('右栏是标签页容器（三个标签：字段明细 / 数据 / SQL 工作台）',
        $('#dbTabs .el-tabs__item').length === 3 &&
        /字段明细/.test(tabText(0)) && /数据/.test(tabText(1)) &&
        /SQL/.test(tabText(2)) && /工作台/.test(tabText(2)),
        tabText(0) + ' | ' + tabText(1) + ' | ' + tabText(2));
    check('「数据」标签页在「字段明细」右侧（索引 1）',
        $('#dbTabs .el-tabs__item').eq(1).attr('data-tab') === 'rows');
    check('默认激活「字段明细」标签页', tabActive('cols') && !tabActive('sql') && paneHidden('rows'));
    check('字段明细标签页里是 6 列的字段表容器',
        $('.el-tab-pane[data-pane="cols"] #dbColsBody').length === 1 &&
        /字段名/.test($('#dbColsBody').text()), $('#dbColsBody').text().slice(0, 40));
    check('SQL 标签页默认收起（pane 没有 is-active）', paneHidden('sql'));
    $('#dbTabs .el-tabs__item[data-tab="sql"]').trigger('click');
});

step(function () {
    check('点「SQL 工作台」标签后切过去（字段明细收起）',
        tabActive('sql') && paneHidden('cols'));
    check('SQL 标签页里的编辑器 / 按钮 / 实例下拉都在',
        $('.el-tab-pane[data-pane="sql"] #sqlText').length === 1 &&
        $('#btnSqlRun').length === 1 && $('#btnSqlClear').length === 1 &&
        $('#btnSqlCopy').length === 1 && $('#sqlDb').length === 1);
    check('SQL 编辑区是 textarea 且占位提示写明只支持查询',
        /SELECT/.test($('#sqlText').attr('placeholder')), $('#sqlText').attr('placeholder').slice(0, 40));
    check('提示只读执行（结束自动回滚）', /只读/.test($('.db-sql__tip').text()) &&
        /回滚/.test($('.db-sql__tip').text()), $('.db-sql__tip').text());
    check('有实例（库）下拉，未选择连接时只有「默认库」', $('#sqlDb option').length === 1,
        $('#sqlDb').text());
    check('执行结果在同一个标签页的下半区，初始为未执行',
        /执行结果/.test($('.db-result__head').text()) && /尚未执行/.test($('#sqlInfo').text()),
        $('#sqlInfo').text());
    check('结果区初始为空态提示', /点「执行」/.test($('#sqlResult').text()),
        $('#sqlResult').text().slice(0, 30));
    check('标签页右侧显示当前连接（未选择时提示）', /未选择连接/.test($('#sqlConnName').text()),
        $('#sqlConnName').text());
    $('#dbTabs .el-tabs__item[data-tab="cols"]').trigger('click');
    check('再点「字段明细」可以切回来', tabActive('cols') && paneHidden('sql'));

    // 数据标签页：未双击表之前是空态（懒加载：没点表就不发请求）
    $('#dbTabs .el-tabs__item[data-tab="rows"]').trigger('click');
});

step(function () {
    check('「数据」标签页可以打开', tabActive('rows') && paneHidden('cols'));
    check('未选择表时数据页给引导文案（懒加载：不请求数据）',
        /双击中间的表或视图/.test($('#dbRowsGrid').text()), $('#dbRowsGrid').text().slice(0, 40));
    check('数据页顶部工具栏（表名 / 行数 / 筛选 / 刷新）齐全',
        $('#dbRowsTable').length === 1 && $('#dbRowsMeta').length === 1 &&
        $('#btnRowsFilter').length === 1 && $('#btnRowsReload').length === 1);
    check('默认显示「未选择表」、筛选条件区与加载更多都隐藏',
        $('#dbRowsTable').text() === '未选择表' && $('#dbRowsFilterBar').prop('hidden') === true &&
        $('#dbRowsFoot').prop('hidden') === true,
        $('#dbRowsTable').text());
    var css = read('css/app.css');
    check('CSS 里数据表表头是 sticky（滚动数据时列标题不动）',
        /\.db-rows__table thead th\s*\{[^}]*position:\s*(-webkit-)?sticky/.test(css));
    $('#dbTabs .el-tabs__item[data-tab="cols"]').trigger('click');
});

step(function () {
    console.log('\n--- 2. 新增连接弹窗：字段与类型联动 ---');
    $('#btnAdd').trigger('click');
});

step(function () {
    var $f = dialogBody().find('.db-form');
    check('弹出「新增数据库」弹窗', /新增数据库/.test(dialog().text()),
        dialog().find('.el-dialog__title').text());
    check('表单字段齐全（名称 / 类型 / 主机端口 / 默认库 / 账号 / 密码 / 字符集 / 参数 / 启用 / 公用否 / 备注）',
        ['#dfName', '#dfType', '#dfHost', '#dfPort', '#dfDbName', '#dfUser', '#dfPassword',
         '#dfCharset', '#dfExtra', '#dfEnabled', '#dfIspub', '#dfRemark'].every(function (id) {
            return $f.find(id).length === 1;
        }));
    check('「公用否」默认选中公用（ispub=1，新增不用手改）',
        $f.find('#dfIspub').val() === '1' &&
        /公用/.test($f.find('#dfIspub option:selected').text()),
        $f.find('#dfIspub').val() + ' / ' + $f.find('#dfIspub option:selected').text());
    check('「公用否」有公用 / 私有两个选项',
        $f.find('#dfIspub option').length === 2 &&
        /私有/.test($f.find('#dfIspub').text()), $f.find('#dfIspub').text());
    check('密码是密码框（不明文显示）', $f.find('#dfPassword').attr('type') === 'password');
    check('类型下拉默认 MySQL 且端口自动填 3306',
        $f.find('#dfType').val() === 'mysql' && $.trim($f.find('#dfPort').val()) === '3306',
        $f.find('#dfType').val() + ' / ' + $f.find('#dfPort').val());
    $f.find('#dfType').val('sqlite').trigger('change');
});

step(function () {
    var $f = dialogBody().find('.db-form');
    check('切到 SQLite 后隐藏主机 / 端口行', $f.find('#dfHostItem').css('display') === 'none',
        $f.find('#dfHostItem').attr('style'));
    check('「默认库」标签换成「库文件路径」', /库文件路径/.test($f.find('#dfDbNameLabel').text()),
        $f.find('#dfDbNameLabel').text());
    check('SQLite 的提示说明填完整路径', /完整路径/.test($f.find('#dfDbNameTip').text()),
        $f.find('#dfDbNameTip').text());
    /* 字符集提示随类型变：SQL Server 要明确「留空即可，GBK 乱码会自动还原」 */
    check('SQLite 下字符集提示说明固定 UTF-8', /固定 UTF-8/.test($f.find('#dfCharsetTip').text()),
        $f.find('#dfCharsetTip').text());
    $f.find('#dfType').val('sqlserver').trigger('change');
    check('SQL Server 下字符集提示说明「留空 / GBK 自动还原」',
        /留空/.test($f.find('#dfCharsetTip').text()) &&
        /GBK/.test($f.find('#dfCharsetTip').text()), $f.find('#dfCharsetTip').text());
    $f.find('#dfType').val('mysql').trigger('change');
    check('MySQL 下字符集提示给 utf8mb4 / gbk 参考',
        /utf8mb4/.test($f.find('#dfCharsetTip').text()), $f.find('#dfCharsetTip').text());
    $f.find('#dfName').val('九豆测试库');
    // 主机留空 → 应先被前端拦下
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('主机为空时提示', /请填写主机地址/.test(toast()), toast());
    var $f = dialogBody().find('.db-form');
    $f.find('#dfHost').val('127.0.0.1');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('新密码为空时提示（新增必须填密码）', /请填写数据库密码/.test(toast()), toast());
    var $f = dialogBody().find('.db-form');
    $f.find('#dfPassword').val('pass1234');
    $f.find('#dfDbName').val('jiudou_test');
    $f.find('#dfUser').val('tester');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('新增成功后关闭弹窗', $('.el-overlay').length === 0, String($('.el-overlay').length));
    check('新增成功提示', /新增成功/.test(toast()), toast());
    check('列表多出一条（3 条）', items().length === 3, String(items().length));
    check('新连接出现在列表里', /九豆测试库/.test($('#dbList').text()), $('#dbList').text().slice(0, 60));
    var created = null;
    for (var ci = 0; ci < items().length; ci++) {
        if (/九豆测试库/.test($(items()[ci]).text())) { created = $(items()[ci]); }
    }
    var mockRows = JSON.parse(win.localStorage.getItem('menu_admin_dbinfomgr_v1') || '[]');
    var createdRow = null;
    for (var ri = 0; ri < mockRows.length; ri++) {
        if (mockRows[ri].name === '九豆测试库') { createdRow = mockRows[ri]; }
    }
    check('新增时 ispub 默认公用（落库 ispub=true，卡片上不显示「私有」）',
        !!createdRow && createdRow.ispub === true && !!created && !/私有/.test(created.text()),
        createdRow ? String(createdRow.ispub) : '没找到新增的记录');
    check('新增的记录带 createempinfosid（创建人由登录态带入，页面不传）',
        !!createdRow && createdRow.hasOwnProperty('createempinfosid'),
        createdRow ? JSON.stringify(Object.keys(createdRow).slice(0, 6)) : '');
});

step(function () {
    console.log('\n--- 3. 编辑（密码留空不修改）---');
    items().filter(function () { return /九豆测试库/.test($(this).text()); }).trigger('click');
});

step(function () {
    var $item = items().filter(function () { return /九豆测试库/.test($(this).text()); });
    check('选中连接后编辑 / 测试 / 扫描 / 删除按钮可用',
        !$('#btnEdit').prop('disabled') && !$('#btnTest').prop('disabled') &&
        !$('#btnScan').prop('disabled') && !$('#btnDelete').prop('disabled'));
    check('选中的连接加了 is-selected 样式', $item.hasClass('is-selected'));
    check('右栏切换到该连接（显示连接名）', /九豆测试库/.test($('#sqlConnName').text()),
        $('#sqlConnName').text());
    $('#btnEdit').trigger('click');
});

step(function () {
    var $f = dialogBody().find('.db-form');
    check('编辑弹窗带出连接名称', $f.find('#dfName').val() === '九豆测试库', $f.find('#dfName').val());
    check('编辑时密码框提示「留空不修改」', /留空/.test($f.find('#dfPassword').attr('placeholder')),
        $f.find('#dfPassword').attr('placeholder'));
    check('编辑时密码提示语显示出已保存密码', /已保存密码/.test($f.find('#dfPasswordTip').text()),
        $f.find('#dfPasswordTip').text());
    $f.find('#dfRemark').val('改过的备注');
    $f.find('#dfIspub').val('0');            // 公用 → 私有
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('编辑保存成功', /保存成功/.test(toast()), toast());
    var mockRows = JSON.parse(win.localStorage.getItem('menu_admin_dbinfomgr_v1') || '[]');
    var row = null;
    for (var i = 0; i < mockRows.length; i++) {
        if (mockRows[i].name === '九豆测试库') { row = mockRows[i]; }
    }
    check('编辑可以改成私有（ispub=false 落库）', !!row && row.ispub === false,
        row ? String(row.ispub) : '没找到记录');
    check('私有连接在卡片上有「私有」标记',
        /私有/.test(items().filter(function () { return /九豆测试库/.test($(this).text()); }).text()),
        items().filter(function () { return /九豆测试库/.test($(this).text()); }).text().slice(0, 60));
});

step(function () {
    console.log('\n--- 4. 测试连接 ---');
    items().filter(function () { return /九豆测试库/.test($(this).text()); }).trigger('click');
    $('#btnTest').trigger('click');
});

step(function () {
    check('测试连接给出成功提示', /连接成功/.test(toast()), toast());
});

step(function () {
    console.log('\n--- 5. 启用 / 停用 ---');
    items().filter(function () { return /九豆测试库/.test($(this).text()); }).trigger('click');
    $('#btnDisable').trigger('click');
});

step(function () {
    check('停用成功提示', /已停用/.test(toast()), toast());
    check('停用后卡片 title 改成「启用后才能扫描」',
        /启用后才能扫描/.test(items().filter(function () { return /九豆测试库/.test($(this).text()); }).attr('title') || ''),
        items().filter(function () { return /九豆测试库/.test($(this).text()); }).attr('title'));
    console.log('\n--- 5.1 停用的连接双击 → 只提醒，不扫描 ---');
    items().filter(function () { return /九豆测试库/.test($(this).text()); }).trigger('dblclick');
});

step(function () {
    check('双击停用连接只给提醒（先启用才能扫描）',
        /已停用/.test(toast()) && /需先「启用」后才能扫描结构/.test(toast()), toast());
    check('没有进入扫描流程：中栏还是未扫描的空态',
        !/个实例/.test($('#dbTree').text()) && !/正在扫描/.test($('#dbTree').text()),
        $('#dbTree').text().replace(/\s+/g, ' ').slice(0, 40));
    check('没有进入扫描流程：中栏没被这条连接占用', !/九豆测试库/.test($('#dbTreeConn').text()),
        $('#dbTreeConn').text());
    check('停用的连接双击仍然只是「选中」，不取消选中',
        items().filter(function () { return /九豆测试库/.test($(this).text()); }).hasClass('is-selected'));
    items().filter(function () { return /九豆测试库/.test($(this).text()); }).trigger('click');
    $('#btnEnable').trigger('click');
});

step(function () {
    check('启用成功提示', /已启用/.test(toast()), toast());
    check('启用后卡片 title 回到「双击扫描该连接的结构」',
        /双击扫描该连接的结构/.test(items().filter(function () { return /九豆测试库/.test($(this).text()); }).attr('title') || ''),
        items().filter(function () { return /九豆测试库/.test($(this).text()); }).attr('title'));
});

step(function () {
    console.log('\n--- 6. 双击连接 → 扫描实例 / 表 ---');
    items().filter(function () { return /九豆主库/.test($(this).text()); }).trigger('dblclick');
});

step(function () {
    check('中栏显示当前连接名', /九豆主库/.test($('#dbTreeConn').text()), $('#dbTreeConn').text());
    check('扫描出实例（库）节点 3 个', dbNodes().length === 3, String(dbNodes().length));
    check('实例节点带「库」徽标与表数量',
        /库/.test(dbNodes().first().text()) && /5/.test(dbNodes().first().text()),
        dbNodes().first().text().replace(/\s+/g, ' '));
    check('当前库打上「当前」标记', /当前/.test(dbNodes().filter(function () {
        return /jiudou_main/.test($(this).text());
    }).text()));
    check('系统库打上「系统」标记', /系统/.test($('#dbTree').text()), $('#dbTree').text().slice(0, 60));
    check('显示扫描时间与实例总数', /3 个实例/.test($('#dbTreeTip').text()), $('#dbTreeTip').text());
    check('自动展开首个实例的表 / 视图', tableNodes().length >= 5, String(tableNodes().length));
    check('表节点带「表」徽标与注释', /表/.test(tableNodes().first().text()) &&
        /员工信息表/.test($('#dbTree').text()), tableNodes().first().text().replace(/\s+/g, ' '));
    check('视图节点单独标成「视图」',
        $('#dbTree .el-tree-node[data-kind="view"]').length >= 1 &&
        /视图/.test($('#dbTree .el-tree-node[data-kind="view"]').first().text()),
        String($('#dbTree .el-tree-node[data-kind="view"]').length));
    check('表 / 视图数量统计提示', /表 4 个/.test($('#dbTree').text()) || /视图 1 个/.test($('#dbTree').text()),
        $('#dbTree').text().replace(/\s+/g, ' ').slice(0, 60));
    check('SQL 区域的实例下拉被同步填充（含当前库）',
        $('#sqlDb option').length >= 4 && /jiudou_main/.test($('#sqlDb').text()),
        $('#sqlDb').text().replace(/\s+/g, ' '));
});

step(function () {
    console.log('\n--- 7. 表 / 视图节点：单击不加载（防误操作） ---');
    $('#dbTree .el-tree-node[data-kind="table"]').filter(function () {
        return /empinfos/.test($(this).text());
    }).children('.el-tree-node__content').trigger('click');
});

step(function () {
    check('单击表名不再加载字段（字段明细仍是空态）',
        /双击/.test($('#dbColsBody').text()) && colRows().length === 0,
        $('#dbColsBody').text().slice(0, 50));
    check('单击表名不会触发数据页加载（仍显示未选择表）',
        $('#dbRowsTable').text() === '未选择表' &&
        $('#dbRowsGrid').find('.db-rows__table').length === 0, $('#dbRowsTable').text());
    check('单击表名不会改 SQL 编辑器', $.trim($('#sqlText').val()) === '',
        $.trim($('#sqlText').val()).slice(0, 40));
    check('单击后结构树里也没有高亮选中的表', $('#dbTree .el-tree-node.is-active').length === 0,
        String($('#dbTree .el-tree-node.is-active').length));
    check('标签页保持不动（还是「字段明细」）', tabActive('cols'));
});

step(function () {
    console.log('\n--- 8. 双击表名 → 生成 SELECT 语句 ---');
    $('#dbTree .el-tree-node[data-kind="table"]').filter(function () {
        return /empinfos/.test($(this).text());
    }).children('.el-tree-node__content').trigger('dblclick');
});

step(function () {
    console.log('\n--- 8. 双击表名 → 字段明细 / 数据 / SQL 一起刷新 ---');
    check('双击后停留在当前标签，不硬跳', tabActive('cols'), 'active=' + tabActive('cols'));
    check('① 字段明细：6 列（字段名 / 类型 / 键 / 可空 / 默认值 / 注解）',
        colHead().length === 6 && /字段名/.test(colHead().eq(0).text()) &&
        /字段类型/.test(colHead().eq(1).text()) && /字段注解/.test(colHead().eq(5).text()),
        colHead().text());
    check('① 字段明细：列出了字段行（≥7 个字段）', colRows().length >= 7, String(colRows().length));
    var colsText = $('#dbColsBody').text().replace(/\s+/g, ' ');
    check('① 字段明细：字段名 / 类型 / 主键 / 注解都显示',
        /id/.test(colsText) && /bigint\(20\) unsigned/.test(colsText) &&
        /PRI/.test(colsText) && /主键ID/.test(colsText) && /工号/.test(colsText),
        colsText.slice(0, 120));
    check('① 字段明细：标题带表名与字段数', /empinfos/.test($('#dbColsTitle').text()) &&
        /7 个字段/.test($('#dbColsHint').text()),
        $('#dbColsTitle').text() + ' | ' + $('#dbColsHint').text());
    check('① 字段明细：当前表在结构树里高亮', $('#dbTree .el-tree-node.is-active').length === 1,
        String($('#dbTree .el-tree-node.is-active').length));
    check('② 数据：已加载这一页记录（100 行）', dataRows().length === 100,
        String(dataRows().length));
    check('② 数据：标题是「库.表」', $('#dbRowsTable').text() === 'jiudou_main.empinfos',
        $('#dbRowsTable').text());
    var sql = $('#sqlText').val() || '';
    check('③ SQL：自动填充 SELECT * FROM 库.表（不带 LIMIT）',
        sql === 'SELECT * FROM `jiudou_main`.`empinfos`', sql.slice(0, 90));
    check('双击后给出「三个标签都已刷新」的提示',
        /字段明细 \/ 数据 \/ SQL/.test(toast()), toast());
});

step(function () {
    console.log('\n--- 8.1 数据页：懒加载第一页 ---');
    $('#dbTabs .el-tabs__item[data-tab="rows"]').trigger('click');
});

step(function () {
    check('切到「数据」标签页能看到已加载的记录', tabActive('rows') && dataRows().length === 100,
        String(dataRows().length));
    check('数据页标题显示「库.表」', $('#dbRowsTable').text() === 'jiudou_main.empinfos',
        $('#dbRowsTable').text());
    check('表头按字段生成（# + 7 个字段）', dataHead().length === 8,
        String(dataHead().length));
    check('表头带排序箭头（可点排序）', dataHead().filter('.is-sortable').length === 7 &&
        dataHead().eq(1).find('.db-rows__sort').length === 1);
    check('首屏只加载 100 行（懒加载，不是一次性拉完）', dataRows().length === 100,
        String(dataRows().length));
    check('行数信息显示「已加载 100 / 共 137 行」',
        /已加载 100 \/ 共 137 行/.test($('#dbRowsMeta').text()), $('#dbRowsMeta').text());
    check('还有更多数据时「加载更多」按钮可见', $('#dbRowsFoot').prop('hidden') === false &&
        /还有更多数据/.test($('#dbRowsMoreTip').text()), $('#dbRowsMoreTip').text());
    check('第一行第一列是序号 1', /^\s*1/.test(dataCellText(0)), dataCellText(0).slice(0, 20));
    $('#btnRowsMore').trigger('click');
});

step(function () {
    console.log('\n--- 8.2 数据页：加载更多 / 排序 ---');
    check('点「加载更多」追加到 137 行', dataRows().length === 137, String(dataRows().length));
    check('全部加载完后隐藏「加载更多」', $('#dbRowsFoot').prop('hidden') === true);
    check('行数信息变成「已加载 137 / 共 137 行」',
        /已加载 137 \/ 共 137 行/.test($('#dbRowsMeta').text()), $('#dbRowsMeta').text());
    // 点列头排序：升序 → 降序 → 取消
    dataHead().filter('[data-col="code"]').trigger('click');
});

step(function () {
    check('点列名第一次按升序排序',
        /按 code 升序/.test($('#dbRowsMeta').text()) &&
        dataHead().filter('[data-col="code"]').hasClass('is-sorted'), $('#dbRowsMeta').text());
    check('排序后箭头变成 ↑',
        /↑/.test(dataHead().filter('[data-col="code"]').text()), dataHead().filter('[data-col="code"]').text());
    dataHead().filter('[data-col="code"]').trigger('click');
});

step(function () {
    check('再点一次变成降序', /按 code 降序/.test($('#dbRowsMeta').text()), $('#dbRowsMeta').text());
    check('降序箭头是 ↓', /↓/.test(dataHead().filter('[data-col="code"]').text()),
        dataHead().filter('[data-col="code"]').text());
    dataHead().filter('[data-col="code"]').trigger('click');
});

step(function () {
    check('第三次点击取消排序（回到默认顺序）',
        !/按 code/.test($('#dbRowsMeta').text()) &&
        !dataHead().filter('[data-col="code"]').hasClass('is-sorted'), $('#dbRowsMeta').text());
    $('#btnRowsFilter').trigger('click');
});

step(function () {
    console.log('\n--- 8.3 数据页：筛选 / 过滤 ---');
    check('点「筛选」展开条件区（字段 / 方式 / 值 / 添加 / 清空）',
        $('#dbRowsFilterBar').prop('hidden') === false &&
        $('#rowFilterCol').length === 1 && $('#rowFilterOp').length === 1 &&
        $('#rowFilterValue').length === 1 && $('#btnRowFilterAdd').length === 1 &&
        $('#btnRowFilterClear').length === 1);
    check('字段下拉是当前表的字段（7 个）', $('#rowFilterCol option').length === 7,
        String($('#rowFilterCol option').length));
    check('筛选方式含 等于 / 包含 / 为空 / 不为空',
        /等于/.test($('#rowFilterOp').text()) && /包含/.test($('#rowFilterOp').text()) &&
        /为空/.test($('#rowFilterOp').text()) && /不为空/.test($('#rowFilterOp').text()),
        $('#rowFilterOp').text().replace(/\s+/g, ' '));
    // 值为空时点添加 → 应被拦下
    $('#rowFilterCol').val('nameCn');
    $('#rowFilterOp').val('eq');
    $('#btnRowFilterAdd').trigger('click');
});

step(function () {
    check('筛选值为空时提示先填值', /请填写筛选值/.test(toast()), toast());
    $('#rowFilterOp').val('contains');
    $('#rowFilterValue').val('演示名称-1');
    $('#btnRowFilterAdd').trigger('click');
});

step(function () {
    var meta = $('#dbRowsMeta').text();
    // 137 行里「演示名称-」包含「演示名称-1」的有 1、10~19、100~137 共 49 行
    check('筛选后行数变少（包含「演示名称-1」的 49 行）',
        dataRows().length === 49, String(dataRows().length));
    check('行数信息里标出「筛选 1 条」', /筛选 1 条/.test(meta), meta);
    check('筛选条件以标签形式列出（可点 × 移除）',
        $('#dbRowsChips .db-chip').length === 1 &&
        /nameCn 包含 演示名称-1/.test($('#dbRowsChips').text()), $('#dbRowsChips').text().slice(0, 60));
    $('#dbRowsChips .db-chip__del').trigger('click');
});

step(function () {
    check('点 × 移除筛选后恢复全量 100 行', dataRows().length === 100 &&
        !/筛选 1 条/.test($('#dbRowsMeta').text()), String(dataRows().length));
    // 再筛一次（用「包含」精确命中一条），然后用「清空」
    $('#rowFilterCol').val('nameCn');
    $('#rowFilterOp').val('contains');
    $('#rowFilterValue').val('演示名称-137');
    $('#btnRowFilterAdd').trigger('click');
});

step(function () {
    check('「包含」精确命中时只剩 1 行', dataRows().length === 1, String(dataRows().length));
    check('两条筛选条件都列在标签区', $('#dbRowsChips .db-chip').length === 1,
        String($('#dbRowsChips .db-chip').length));
    $('#btnRowFilterClear').trigger('click');
});

step(function () {
    check('点「清空」清掉全部筛选条件', $('#dbRowsChips .db-chip').length === 0 &&
        dataRows().length === 100, String(dataRows().length));
    $('#btnRowsReload').trigger('click');
});

step(function () {
    check('点「刷新」重新从第一页读', dataRows().length === 100, String(dataRows().length));
});

step(function () {
    console.log('\n--- 9. SQL 执行 ---');
    $('#dbTabs .el-tabs__item[data-tab="sql"]').trigger('click');
    $('#btnSqlClear').trigger('click');
});

step(function () {
    check('清空后编辑器为空且结果区回到空态',
        $.trim($('#sqlText').val()) === '' && /点「执行」/.test($('#sqlResult').text()),
        $('#sqlResult').text().slice(0, 30));
    check('清空后状态条回到「尚未执行」', /尚未执行/.test($('#sqlInfo').text()), $('#sqlInfo').text());
    $('#btnSqlRun').trigger('click');
});

step(function () {
    check('SQL 为空时提示先输入', /请输入要执行的 SQL/.test(toast()), toast());
    $('#sqlText').val('delete from empinfos');
    $('#btnSqlRun').trigger('click');
});

step(function () {
    var info = $('#sqlInfo').text();
    check('写操作语句被执行层拒绝', /执行失败/.test(info) && /只允许执行查询语句/.test(info), info.slice(0, 80));
    check('错误信息同时显示在结果区', /只允许执行查询语句/.test($('#sqlResult').text()),
        $('#sqlResult').text().slice(0, 60));
    $('#sqlText').val('SELECT * FROM empinfos');
    $('#btnSqlRun').trigger('click');
});

step(function () {
    var info = $('#sqlInfo').text();
    check('查询成功：状态条显示返回行数与耗时',
        /执行成功/.test(info) && /返回 3 行/.test(info) && /耗时/.test(info), info.slice(0, 80));
    check('结果表按查询列生成表头（含 # 序号列 + 7 个字段）',
        resultCols().length === 7 && $('#sqlResult th.is-idx').length === 1,
        String(resultCols().length));
    check('结果表有 3 行数据', resultRows().length === 3, String(resultRows().length));
    check('结果表单元格带值', /id-1/.test($('#sqlResult').text()), $('#sqlResult').text().slice(0, 80));
});

step(function () {
    console.log('\n--- 9.1 双击换表（节点变了）→ SQL 执行结果网格必须清空 ---');
    check('切换前结果表还在（上一张表 empinfos 的 3 行）', resultRows().length === 3,
        String(resultRows().length));
    tableNodes().filter(function () { return /useinfo/.test($(this).text()); })
        .children('.el-tree-node__content').trigger('dblclick');
});

step(function () {
    var text = $('#sqlResult').text().replace(/\s+/g, ' ');
    check('换表后结果表格整块消失（不残留上一张表的行列）',
        $('#sqlResult .db-result__table').length === 0 && resultRows().length === 0,
        text.slice(0, 60));
    check('结果区换成「已切换到 库.表」的空态提示',
        /已切换到/.test(text) && /jiudou_main\.useinfo/.test(text), text.slice(0, 90));
    check('状态条回到「尚未执行」，不再显示上一张表的行数 / 耗时',
        /尚未执行/.test($('#sqlInfo').text()) && !/返回 3 行/.test($('#sqlInfo').text()),
        $('#sqlInfo').text());
    check('SQL 编辑器同步换成新表的 SELECT',
        $.trim($('#sqlText').val()) === 'SELECT * FROM `jiudou_main`.`useinfo`',
        $.trim($('#sqlText').val()));
    $('#btnSqlRun').trigger('click');
});

step(function () {
    check('在新表上执行后结果正常渲染（3 行）', resultRows().length === 3, String(resultRows().length));
    tableNodes().filter(function () { return /useinfo/.test($(this).text()); })
        .children('.el-tree-node__content').trigger('dblclick');
});

step(function () {
    check('双击同一张表（节点没变）时结果保留，不清空', resultRows().length === 3,
        String(resultRows().length));
    tableNodes().filter(function () { return /empinfos/.test($(this).text()); })
        .children('.el-tree-node__content').trigger('dblclick');
});

step(function () {
    var text = $('#sqlResult').text().replace(/\s+/g, ' ');
    check('再切到另一张表 → 结果再次被清空',
        $('#sqlResult .db-result__table').length === 0 && /已切换到/.test(text), text.slice(0, 60));
    check('提示里带的是新表全名（jiudou_main.empinfos）', /jiudou_main\.empinfos/.test(text),
        text.slice(0, 90));
});

step(function () {
    console.log('\n--- 10. 点另一个实例 / 收起 ---');
    dbNodes().filter(function () { return /jiudou_report/.test($(this).text()); })
        .children('.el-tree-node__content').trigger('click');
});

step(function () {
    check('点另一个实例可展开它的表', /rpt_sales/.test($('#dbTree').text()), $('#dbTree').text().slice(0, 80));
    dbNodes().filter(function () { return /jiudou_report/.test($(this).text()); })
        .children('.el-tree-node__content').trigger('click');
});

step(function () {
    check('再点同一实例可收起（其表节点消失）', !/rpt_sales/.test($('#dbTree').text()),
        $('#dbTree').text().replace(/\s+/g, ' ').slice(0, 60));
});

step(function () {
    console.log('\n--- 11. 删除连接 ---');
    items().filter(function () { return /九豆测试库/.test($(this).text()); }).trigger('click');
    $('#btnDelete').trigger('click');
});

step(function () {
    check('删除前弹出确认框', /确定删除连接/.test(msgBox().text()), msgBox().text().slice(0, 40));
    check('确认文案说明不影响目标数据库', /不会影响目标数据库/.test(msgBox().text()),
        msgBox().text().slice(0, 80));
    msgBox().find('.btn-ok').trigger('click');
});

step(function () {
    check('删除后列表剩 2 条', items().length === 2, String(items().length));
    check('已删除的连接不在列表里', !/九豆测试库/.test($('#dbList').text()), $('#dbList').text().slice(0, 60));
});

/* ---------- 12. 连接对象可见性（2026-11-06 用户需求）----------
   列表只加载「本用户创建的」+「其他用户标为公用的」连接对象；
   报表设计器的数据源下拉必须与列表同口径。
   注意：此时 Mock 已落盘多次（前面的新增 / 编辑 / 删除），可以安全直改 localStorage。 */
step(function () {
    console.log('\n--- 12. 连接对象可见性：本人创建的 + 他人公用的 ---');
    var KEY = 'menu_admin_dbinfomgr_v1';
    var stored = [];
    try { stored = JSON.parse(win.localStorage.getItem(KEY) || '[]'); } catch (e) { stored = []; }
    stored = stored || [];
    check('Mock 连接清单已落盘', stored.length >= 1, String(stored.length));
    /* 断言基准：empId=4242 为「我」，999999 为「别人」 */
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'jsdom-token', time: '2026-11-06 10:00:00',
        expireAt: new Date().getTime() + 3600 * 1000, ttlHours: 8,
        user: { account: 'zhangsan', empName: '张三', empId: 4242 }
    }));
    var base = {
        dbType: 'mysql', host: '127.0.0.1', port: 3306, dbName: 'rogerorm',
        username: 'sa', password: 'x', charset: 'utf8mb4', enabled: true,
        lastScanTime: '', lastError: '', remark: '', ispub: true
    };
    var mk = function (id, name, ispub, empId) {
        var one = JSON.parse(JSON.stringify(base));
        one.id = id; one.name = name; one.ispub = ispub; one.createempinfosid = empId;
        return one;
    };
    stored.push(mk('db-vis-mine-priv', '__vis_mine_priv', false, 4242));
    stored.push(mk('db-vis-mine-pub', '__vis_mine_pub', true, 4242));
    stored.push(mk('db-vis-other-priv', '__vis_other_priv', false, 999999));
    stored.push(mk('db-vis-other-pub', '__vis_other_pub', true, 999999));
    win.localStorage.setItem(KEY, JSON.stringify(stored));
});

/* ⚠ Mock 回调是异步的：取数放一步、断言放下一步（同步读会是空数组） */
function visNamesOf(list) {
    var names = [];
    for (var i = 0; i < (list || []).length; i++) {
        if (String(list[i].name || '').indexOf('__vis_') === 0) { names.push(list[i].name); }
    }
    return names.sort().join(',');
}

step(function () {
    win.__visDb = '(pending)';
    win.Api.dbInfo.page({ pageNum: 1, pageSize: 200 }).done(function (data) {
        win.__visDb = visNamesOf((data && data.list) || []);
    });
});

step(function () {
    check('连接列表只加载本人创建的 + 他人标为公用的',
        win.__visDb === '__vis_mine_priv,__vis_mine_pub,__vis_other_pub', String(win.__visDb));
    check('别人标为私有的连接不加载',
        String(win.__visDb).indexOf('__vis_other_priv') < 0, String(win.__visDb));
    win.__visConn = '(pending)';
    win.Api.report.connections().done(function (data) {
        win.__visConn = visNamesOf((data && data.list) || []);
    });
});

step(function () {
    check('报表设计器数据源下拉与连接列表同口径（本人 + 他人公用）',
        win.__visConn === '__vis_mine_priv,__vis_mine_pub,__vis_other_pub', String(win.__visConn));
    check('别人私有的连接也不出现在数据源下拉里',
        String(win.__visConn).indexOf('__vis_other_priv') < 0, String(win.__visConn));
    /* 别人把私有改成公用 → 立刻可见（不用重新登录） */
    var KEY = 'menu_admin_dbinfomgr_v1';
    var stored = JSON.parse(win.localStorage.getItem(KEY) || '[]') || [];
    for (var i = 0; i < stored.length; i++) {
        if (stored[i].id === 'db-vis-other-priv') { stored[i].ispub = true; }
    }
    win.localStorage.setItem(KEY, JSON.stringify(stored));
    win.__visDb2 = '(pending)';
    win.Api.dbInfo.page({ pageNum: 1, pageSize: 200 }).done(function (data) {
        win.__visDb2 = visNamesOf((data && data.list) || []);
    });
});

step(function () {
    check('别人改成公用的连接随后出现在列表里',
        String(win.__visDb2).indexOf('__vis_other_priv') >= 0, String(win.__visDb2));
    /* 自己建的连接设为私有也始终可见 */
    var KEY = 'menu_admin_dbinfomgr_v1';
    var stored = JSON.parse(win.localStorage.getItem(KEY) || '[]') || [];
    for (var i = 0; i < stored.length; i++) {
        if (stored[i].id === 'db-vis-mine-pub') { stored[i].ispub = false; }
    }
    win.localStorage.setItem(KEY, JSON.stringify(stored));
    win.__visDb3 = '(pending)';
    win.Api.dbInfo.page({ pageNum: 1, pageSize: 200 }).done(function (data) {
        win.__visDb3 = visNamesOf((data && data.list) || []);
    });
});

step(function () {
    check('自己建的连接即使设为私有也始终在列表里',
        String(win.__visDb3).indexOf('__vis_mine_pub') >= 0,
        String(win.__visDb3));
    /* 清理注入的连接，避免影响后续人工核对 */
    var KEY = 'menu_admin_dbinfomgr_v1';
    var stored = JSON.parse(win.localStorage.getItem(KEY) || '[]') || [];
    stored = stored.filter(function (one) {
        return String(one.name || '').indexOf('__vis_') !== 0;
    });
    win.localStorage.setItem(KEY, JSON.stringify(stored));
});

setTimeout(next, 700);
