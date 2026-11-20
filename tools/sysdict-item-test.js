/* ==========================================================================
   sysdict-item-test.js —— 系统配置 · 字典键值页测试（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖：
     ① 首屏骨架：标题 / 面包屑 / 3 个检索条件 / 7 个操作按钮 / 8 列表头 / 静态禁用；
     ② 字典下拉与列表：按 sortNo 升序、所属字典名 / 键 / 键值 / 序号 / 启用徽标；
     ③ Mock 层：check 复合唯一 / detail / page 按 dictId 过滤 / tree；
     ④ URL 预筛：?dictId=<UUID> 自动选中所属字典、顶部文案、列表只出该字典键值；
     ⑤ 检索：所属字典 / 关键字 / 启用状态 / 重置；
     ⑥ 新增弹窗：6 字段、必填校验、重复键拒绝、空键成功；
     ⑦ 编辑 / 启停 / 删除确认框 / 返回字典 / 双击编辑 / 刷新。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/sysdict-item-test.js
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

function boot(page, scripts, url) {
    var dom = new JSDOM(read(page), {
        url: url || ('http://127.0.0.1:8808/' + page),
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
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'mock-token', user: { empId: 1, nameCn: '系统管理员' }
    }));
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    win.AppNav.go = function (url2) { win.__lastNav = url2; };
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

var win = boot('sysdict-item.html', ['js/sysdict-item.js']);
var $ = win.jQuery;
var Api = win.Api;
// 第二实例：模拟从「系统字典」点「维护键值」带 ?dictId= 跳进来
var win2 = boot('sysdict-item.html', ['js/sysdict-item.js'],
    'http://127.0.0.1:8808/sysdict-item.html?dictId=sd-0000-4000-8000-000000000001');
var $2 = win2.jQuery;

function rows() { return $('#siTbody tr[data-id]'); }
function dialog() { return $('.el-overlay .el-dialog').last(); }
function form() { return dialog().find('.pj-form'); }
function toast() { return $('.el-message-list').text(); }
function msgBox() { return $('.el-message-box').last(); }
function rowOf(re) { return rows().filter(function () { return re.test($(this).text()); }); }
function cell(i, col) { return $.trim(rows().eq(i).find('td').eq(col).text()); }
function clickSearch(dictId, kw, enabled) {
    $('#dictId').val(dictId || '');
    $('#keyword').val(kw || '');
    $('#enabled').val(enabled === undefined ? '' : enabled);
    $('#btnSearch').trigger('click');
}

var GENDER = 'sd-0000-4000-8000-000000000001';
var STATUS = 'sd-0000-4000-8000-000000000002';
var THEME = 'sd-0000-4000-8000-000000000004';
var IT_M = 'si-0000-4000-8000-000000000001';
var IT_F = 'si-0000-4000-8000-000000000002';
var IT_U = 'si-0000-4000-8000-000000000003';
var IT_DOING = 'si-0000-4000-8000-000000000004';
var IT_DONE = 'si-0000-4000-8000-000000000005';
var IT_LIGHT = 'si-0000-4000-8000-000000000006';

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 650 }); }
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
    console.log('\n--- 1. 首屏骨架 ---');
    check('页面标题为「字典键值」', $('.page-head__title').text() === '字典键值',
        $('.page-head__title').text());
    check('面包屑为「系统配置/字典键值」',
        $('#pageHead').attr('data-crumb') === '系统配置/字典键值', $('#pageHead').attr('data-crumb'));
    check('检索卡片含 3 个条件 + 查询/重置',
        $('#searchForm .el-form-item').length === 4 &&
        $('#dictId').length === 1 && $('#keyword').length === 1 &&
        $('#enabled').length === 1 && $('#btnSearch').length === 1 && $('#btnReset').length === 1,
        String($('#searchForm .el-form-item').length));
    check('操作引导区 7 个按钮',
        ['#btnAdd', '#btnEdit', '#btnEnable', '#btnDisable', '#btnDelete', '#btnBack', '#btnRefresh']
            .every(function (id) { return $(id).length === 1; }) &&
        $('.toolbar .el-button').length === 7, String($('.toolbar .el-button').length));
    check('表头 8 列且顺序正确',
        $('#siTable thead th').length === 8 &&
        /所属字典/.test($('#siTable thead th').eq(2).text()) &&
        /键/.test($('#siTable thead th').eq(3).text()) &&
        /键值/.test($('#siTable thead th').eq(4).text()) &&
        /启用/.test($('#siTable thead th').eq(7).text()));
    check('分页容器存在', $('#pagerWrap').length === 1);
    check('提示卡说明「已并入系统字典页 / 同字典键不可重复 / 键留空存纯枚举」',
        /键不可重复/.test($('.pj-tip').text()) && /已并入/.test($('.pj-tip').text()) &&
        /双击/.test($('.pj-tip').text()) && /纯枚举/.test($('.pj-tip').text()),
        $('.pj-tip').text().replace(/\s+/g, ' ').slice(0, 120));
    check('未选择记录时编辑 / 启停 / 删除按钮禁用',
        $('#btnEdit').prop('disabled') === true && $('#btnDelete').prop('disabled') === true &&
        $('#btnEnable').prop('disabled') === true && $('#btnDisable').prop('disabled') === true);
});

step(function () {
    console.log('\n--- 2. 字典下拉 + 列表（排序 / 归属） ---');
    check('所属字典下拉 4 个字典 + 全部字典', $('#dictId option').length === 5,
        String($('#dictId option').length));
    check('默认「全部字典」且顶部文案也是全部字典',
        $('#dictId').val() === '' && $('#siCurrentDict').text() === '全部字典',
        $('#siCurrentDict').text());
    check('列表 6 条键值 / 顶部条数 6', rows().length === 6 && $('#siCount').text() === '6',
        String(rows().length) + '/' + $('#siCount').text());
    check('分页组件已渲染', $('#pagerWrap .el-pagination').length === 1);
    check('按显示序号升序、同序号按 id 兜底',
        [rows().eq(0).attr('data-id'), rows().eq(1).attr('data-id'), rows().eq(2).attr('data-id'),
         rows().eq(3).attr('data-id'), rows().eq(4).attr('data-id'), rows().eq(5).attr('data-id')]
            .join(',') === [IT_M, IT_DOING, IT_LIGHT, IT_F, IT_DONE, IT_U].join(','),
        rows().map(function () { return $(this).attr('data-id'); }).get().join(','));
    check('列表显示所属字典中文名 / 英文名',
        /用户性别/.test(cell(0, 2)) && /gender/.test(cell(0, 2)), cell(0, 2));
    check('列表显示键 / 键值 / 序号 / 说明',
        cell(0, 3) === 'M' && cell(0, 4) === '男' && cell(0, 5) === '1' &&
        cell(2, 4) === '淡雅灰', cell(0, 3) + '/' + cell(0, 4) + '/' + cell(2, 4));
    check('停用键值「未知」显示停用徽标，其余启用',
        /停用/.test(rows().filter(function () { return $(this).attr('data-id') === IT_U; }).text()) &&
        /启用/.test(rows().eq(0).text()));
    check('界面主题下的键值仍显示所属字典名（字典停用不影响键值展示）',
        /界面主题/.test(cell(2, 2)) && /ui_theme/.test(cell(2, 2)), cell(2, 2));
});

step(function () {
    console.log('\n--- 3. Mock 层接口 + URL 预筛 ---');
    Api.sysDictItem.check('M', GENDER).done(function (d) {
        check('check 同字典同键返回 unique=false', d.unique === false);
    });
    Api.sysDictItem.check('M', STATUS).done(function (d) {
        check('check 不同字典同键返回 unique=true', d.unique === true);
    });
    Api.sysDictItem.check('M', GENDER, IT_M).done(function (d) {
        check('check 编辑自身不算重复', d.unique === true);
    });
    Api.sysDictItem.detail(IT_M).done(function (d) {
        check('detail 补所属字典中文名 / 英文名',
            d.dictNameCn === '用户性别' && d.dictNameEn === 'gender' && d.itemKey === 'M',
            JSON.stringify(d).slice(0, 160));
    });
    Api.sysDictItem.page({ dictId: GENDER }).done(function (d) {
        check('page 按 dictId 只出 3 条', int0(d.total) === 3, String(d.total));
    });
    Api.sysDict.tree().done(function (d) {
        check('字典下拉数据来自字典树（4 个节点）', (d.list || []).length === 4,
            String((d.list || []).length));
    });
    // —— 第二个窗口：URL 预筛 ——
    check('URL 预筛窗口已选中所属字典',
        $2('#dictId').val() === GENDER, String($2('#dictId').val()));
    check('URL 预筛窗口顶部文案显示字典中文名',
        $2('#siCurrentDict').text() === '用户性别', $2('#siCurrentDict').text());
    check('URL 预筛窗口列表只有该字典的 3 条键值',
        $2('#siTbody tr[data-id]').length === 3 && $2('#siCount').text() === '3',
        String($2('#siTbody tr[data-id]').length) + '/' + $2('#siCount').text());
    check('URL 预筛窗口不出现其它字典的键值',
        !/进行中/.test($2('#siTbody').text()) && !/淡雅灰/.test($2('#siTbody').text()));
    $2('#btnBack').trigger('click');
    check('「返回字典」跳回 sysdict.html',
        String(win2.__lastNav) === 'sysdict.html', String(win2.__lastNav));
});

step(function () {
    console.log('\n--- 4. 检索筛选 ---');
    clickSearch(GENDER, '', '');
});
step(function () {
    check('按所属字典「用户性别」筛出 3 条',
        rows().length === 3 && $('#siCurrentDict').text() === '用户性别',
        String(rows().length) + '/' + $('#siCurrentDict').text());
    clickSearch('', '进行中', '');
});
step(function () {
    check('按关键字「进行中」命中 1 条',
        rows().length === 1 && /进行中/.test($('#siTbody').text()), String(rows().length));
    clickSearch('', '', '0');
});
step(function () {
    check('按「停用」筛出 1 条', rows().length === 1 && /未知/.test($('#siTbody').text()),
        String(rows().length));
    $('#btnReset').trigger('click');
});
step(function () {
    check('重置后恢复 6 条且清空检索条件 / 顶部文案',
        rows().length === 6 && $('#dictId').val() === '' && $('#keyword').val() === '' &&
        $('#enabled').val() === '' && $('#siCurrentDict').text() === '全部字典',
        String(rows().length));
});

step(function () {
    console.log('\n--- 5. 新增弹窗 ---');
    $('#btnAdd').trigger('click');
});
step(function () {
    check('弹窗标题「新增字典键值」', /新增字典键值/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    check('表单 6 个字段齐全且带键说明',
        ['#siDict', '#siKey', '#siValue', '#siSort', '#siRemark', '#siEnabled']
            .every(function (id) { return form().find(id).length === 1; }) &&
        /留空表示纯枚举值/.test(form().text()));
    check('所属字典下拉已填充（4 个 + 请选择）',
        form().find('#siDict option').length === 5,
        String(form().find('#siDict option').length));
    check('默认序号 0 / 启用', form().find('#siSort').val() === '0' &&
        form().find('#siEnabled').val() === '1');
    dialog().find('.btn-ok').trigger('click');
    check('未选所属字典阻止保存并提示',
        dialog().length === 1 && /请选择所属字典/.test(toast()), toast().slice(-90));
    form().find('#siDict').val(GENDER);
    dialog().find('.btn-ok').trigger('click');
    check('键值为空阻止保存并提示',
        dialog().length === 1 && /请填写键值/.test(toast()), toast().slice(-90));
    form().find('#siDict').val(GENDER);
    form().find('#siKey').val('JS_KEY');
    form().find('#siValue').val('__jsdom测试键值__');
    form().find('#siSort').val('5');
    form().find('#siRemark').val('jsdom 自动化新增');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    console.log('\n--- 6. 保存结果 / 重复键 / 空键 ---');
    check('保存成功后弹窗关闭', $('.el-overlay .el-dialog').length === 0,
        String($('.el-overlay .el-dialog').length));
    var $new = rowOf(/__jsdom测试键值__/);
    check('列表出现新键值且总数变 7', $new.length === 1 && rows().length === 7 &&
        $('#siCount').text() === '7', String(rows().length) + '/' + $('#siCount').text());
    check('新键值显示所属字典 / 键 / 序号 / 说明',
        /用户性别/.test($new.text()) && /JS_KEY/.test($new.text()) &&
        /5/.test($new.text()) && /jsdom 自动化新增/.test($new.text()),
        $new.text().replace(/\s+/g, ' ').slice(0, 180));
    win.__newId = $new.attr('data-id');
    check('新键值主键由 Mock 自动生成', /^[0-9a-f-]{30,40}$/.test(String(win.__newId)),
        String(win.__newId));
    // 同字典重复键
    $('#btnAdd').trigger('click');
    form().find('#siDict').val(GENDER);
    form().find('#siKey').val('JS_KEY');
    form().find('#siValue').val('__jsdom重复键__');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    check('同字典重复键被 Mock 拒绝并提示「已存在」',
        /已存在/.test(toast()), toast().slice(-120));
    check('重复键保存失败后弹窗保持打开', $('.el-overlay .el-dialog').length === 1,
        String($('.el-overlay .el-dialog').length));
    form().find('#siKey').val('');
    form().find('#siValue').val('__jsdom枚举值__');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    check('键留空可存纯枚举值（列表变 8 条）',
        rows().length === 8 && /__jsdom枚举值__/.test($('#siTbody').text()) &&
        $('.el-overlay .el-dialog').length === 0, String(rows().length));
    var $enum = rowOf(/__jsdom枚举值__/);
    check('空键在列表里显示占位符「—」', /—/.test($enum.find('td').eq(3).text()),
        $enum.find('td').eq(3).text());
    win.__enumId = $enum.attr('data-id');
});

step(function () {
    console.log('\n--- 7. 编辑 / 启停 / 删除 ---');
    rowOf(/__jsdom测试键值__/).trigger('click');
    check('选中启用记录后「启用」禁用、「停用」可用',
        $('#btnEnable').prop('disabled') === true && $('#btnDisable').prop('disabled') === false);
    $('#btnEdit').trigger('click');
});
step(function () {
    check('编辑弹窗回填所属字典 / 键 / 键值 / 序号 / 说明',
        /编辑字典键值/.test(dialog().find('.el-dialog__title').text()) &&
        form().find('#siDict').val() === GENDER &&
        form().find('#siKey').val() === 'JS_KEY' &&
        form().find('#siValue').val() === '__jsdom测试键值__' &&
        form().find('#siSort').val() === '5' &&
        form().find('#siRemark').val() === 'jsdom 自动化新增',
        form().find('#siValue').val());
    form().find('#siValue').val('__jsdom测试键值（改）');
    form().find('#siSort').val('6');
    form().find('#siEnabled').val('0');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    var $edited = rowOf(/__jsdom测试键值（改）/);
    check('编辑后列表更新键值 / 序号 / 停用',
        $edited.length === 1 && /停用/.test($edited.text()) &&
        /6/.test($edited.find('td').eq(5).text()),
        $edited.text().replace(/\s+/g, ' ').slice(0, 160));
    $edited.trigger('click');
    $('#btnEnable').trigger('click');
});
step(function () {
    var $edited = rowOf(/__jsdom测试键值（改）/);
    check('启用后状态变回「启用」', /启用/.test($edited.text()) && !/停用/.test($edited.text()),
        $edited.text().replace(/\s+/g, ' ').slice(0, 120));
    $edited.trigger('click');
    $('#btnBack').trigger('click');
    check('「返回字典」跳回 sysdict.html', String(win.__lastNav) === 'sysdict.html',
        String(win.__lastNav));
    $('#btnDelete').trigger('click');
    check('删除弹确认框且带键值文本',
        msgBox().length === 1 && /删除字典键值/.test(msgBox().text()) &&
        /__jsdom测试键值（改）/.test(msgBox().text()), msgBox().text().slice(0, 100));
    msgBox().find('.btn-ok').trigger('click');
});
step(function () {
    check('删除后列表剩 7 条且操作按钮禁用',
        rows().length === 7 && !/__jsdom测试键值/.test($('#siTbody').text()) &&
        $('#btnEdit').prop('disabled') === true && $('#btnDelete').prop('disabled') === true,
        String(rows().length));
    Api.sysDictItem.page({ dictId: GENDER }).done(function (d) {
        check('Mock 层 gender 字典键值变回 4 条（3 种子 + 1 空键枚举）',
            int0(d.total) === 4, String(d.total));
    });
    Api.sysDictItem.page({}).done(function (d) {
        check('Mock 层键值总数 7 条', int0(d.total) === 7, String(d.total));
    });
});

step(function () {
    console.log('\n--- 8. 双击编辑 / 刷新 ---');
    // 用 data-id 精确定位，避免模糊文本命中多行
    rows().filter(function () { return $(this).attr('data-id') === IT_DOING; }).trigger('dblclick');
    check('双击行打开编辑弹窗',
        /编辑字典键值/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
});
step(function () {
    check('双击打开的是「进行中」这条键值',
        form().find('#siValue').val() === '进行中' && form().find('#siKey').val() === 'doing',
        form().find('#siValue').val());
    dialog().find('.btn-cancel').trigger('click');
    check('取消按钮关闭弹窗', $('.el-overlay .el-dialog').length === 0,
        String($('.el-overlay .el-dialog').length));
    $('#btnRefresh').trigger('click');
});
step(function () {
    check('刷新后列表仍为 7 条', rows().length === 7, String(rows().length));
    check('刷新后字典下拉仍可用', $('#dictId option').length === 5,
        String($('#dictId option').length));
});

function int0(v) { return parseInt(v, 10) || 0; }
next();
