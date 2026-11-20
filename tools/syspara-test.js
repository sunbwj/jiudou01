/* ==========================================================================
   syspara-test.js —— 系统配置 · 系统参数页测试（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖：
     ① 首屏骨架：标题 / 面包屑 / 2 个检索条件 / 6 个操作按钮 / 8 列表头 / 静态禁用；
     ② 列表：按 sortNo 升序、参数值 / 英文名 / 说明 / 启用徽标、空值占位；
     ③ Mock 层：check 英文名唯一 / detail / page 关键字与启用筛选 / 值长校验；
     ④ 检索：关键字（中文名 / 英文名 / 参数值）/ 启用状态 / 重置 / sessionStorage 恢复；
     ⑤ 新增弹窗：6 字段、必填校验、英文名格式、英文名重复、保存后列表更新；
     ⑥ 编辑弹窗：回填全字段、保存后更新；
     ⑦ 启停按钮联动 / 删除确认框 / 双击编辑 / 刷新。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/syspara-test.js
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

var win = boot('syspara.html', ['js/syspara.js']);
var $ = win.jQuery;
var Api = win.Api;

function rows() { return $('#spTbody tr[data-id]'); }
function dialog() { return $('.el-overlay .el-dialog').last(); }
function form() { return dialog().find('.pj-form'); }
function toast() { return $('.el-message-list').text(); }
function msgBox() { return $('.el-message-box').last(); }
function rowOf(re) { return rows().filter(function () { return re.test($(this).text()); }); }
function cell(i, col) { return $.trim(rows().eq(i).find('td').eq(col).text()); }
function clickSearch(kw, enabled) {
    $('#keyword').val(kw || '');
    $('#enabled').val(enabled === undefined ? '' : enabled);
    $('#btnSearch').trigger('click');
}

var SP_SITE = 'sp-0000-4000-8000-000000000001';
var SP_TOKEN = 'sp-0000-4000-8000-000000000002';
var SP_PAGE = 'sp-0000-4000-8000-000000000003';
var SP_NOTICE = 'sp-0000-4000-8000-000000000004';

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
    check('页面标题为「系统参数」', $('.page-head__title').text() === '系统参数',
        $('.page-head__title').text());
    check('面包屑为「系统配置/系统参数」',
        $('#pageHead').attr('data-crumb') === '系统配置/系统参数', $('#pageHead').attr('data-crumb'));
    check('检索卡片含 2 个条件 + 查询/重置',
        $('#searchForm .el-form-item').length === 3 &&
        $('#keyword').length === 1 && $('#enabled').length === 1 &&
        $('#btnSearch').length === 1 && $('#btnReset').length === 1,
        String($('#searchForm .el-form-item').length));
    check('操作引导区 6 个按钮',
        ['#btnAdd', '#btnEdit', '#btnEnable', '#btnDisable', '#btnDelete', '#btnRefresh']
            .every(function (id) { return $(id).length === 1; }) &&
        $('.toolbar .el-button').length === 6, String($('.toolbar .el-button').length));
    check('表头 8 列且顺序正确',
        $('#spTable thead th').length === 8 &&
        /参数中文名/.test($('#spTable thead th').eq(2).text()) &&
        /参数英文名/.test($('#spTable thead th').eq(3).text()) &&
        /参数值/.test($('#spTable thead th').eq(4).text()) &&
        /显示序号/.test($('#spTable thead th').eq(5).text()) &&
        /启用/.test($('#spTable thead th').eq(7).text()));
    check('分页容器存在', $('#pagerWrap').length === 1);
    check('提示卡说明英文名全局唯一 / 参数值可填文本数字 JSON / 全局配置',
        /全局唯一/.test($('.pj-tip').text()) && /JSON/.test($('.pj-tip').text()) &&
        /全局配置/.test($('.pj-tip').text()));
    check('未选择记录时编辑 / 启停 / 删除按钮禁用',
        $('#btnEdit').prop('disabled') === true && $('#btnDelete').prop('disabled') === true &&
        $('#btnEnable').prop('disabled') === true && $('#btnDisable').prop('disabled') === true);
});

step(function () {
    console.log('\n--- 2. 列表（排序 / 参数值 / 启用） ---');
    check('列表 4 条参数 / 顶部条数 4', rows().length === 4 && $('#spCount').text() === '4',
        String(rows().length) + '/' + $('#spCount').text());
    check('分页组件已渲染', $('#pagerWrap .el-pagination').length === 1);
    check('按显示序号升序 site_name / token_expire_hours / page_size / maintenance_notice',
        [rows().eq(0).attr('data-id'), rows().eq(1).attr('data-id'),
         rows().eq(2).attr('data-id'), rows().eq(3).attr('data-id')].join(',') ===
        [SP_SITE, SP_TOKEN, SP_PAGE, SP_NOTICE].join(','),
        rows().map(function () { return $(this).attr('data-id'); }).get().join(','));
    check('列表显示参数中文名 / 英文名 / 参数值 / 序号 / 说明',
        cell(0, 2) === '系统名称' && cell(0, 3) === 'site_name' &&
        cell(0, 4) === '九豆综合管理平台' && cell(0, 5) === '1' &&
        /顶部导航/.test(cell(0, 6)), cell(0, 4));
    check('英文名以 sys-name-en 等宽样式呈现',
        rows().eq(1).find('.sys-name-en').text() === 'token_expire_hours',
        rows().eq(1).find('.sys-name-en').text());
    check('停用的「维护公告」显示停用徽标且参数值占位「—」',
        /停用/.test(rows().eq(3).text()) && cell(3, 4) === '—',
        rows().eq(3).text().replace(/\s+/g, ' ').slice(0, 120));
    check('其余参数显示启用徽标',
        /启用/.test(rows().eq(0).text()) && /启用/.test(rows().eq(1).text()) &&
        /启用/.test(rows().eq(2).text()));
});

step(function () {
    console.log('\n--- 3. Mock 层接口 ---');
    Api.sysPara.check('paraNameEn', 'site_name').done(function (d) {
        check('check 已存在英文名返回 unique=false', d.unique === false);
    });
    Api.sysPara.check('paraNameEn', 'jsdom_para_new').done(function (d) {
        check('check 新英文名返回 unique=true', d.unique === true);
    });
    Api.sysPara.check('paraNameEn', 'site_name', SP_SITE).done(function (d) {
        check('check 编辑自身不算重复', d.unique === true);
    });
    Api.sysPara.check('remark', 'x').fail(function (e) {
        check('check 不支持的字段被拒', !!e && /不支持/.test(e.message), e && e.message);
    });
    Api.sysPara.detail(SP_TOKEN).done(function (d) {
        check('detail 返回参数值 / 英文名 / 启用否',
            d.paraNameEn === 'token_expire_hours' && d.paraValue === '8' && d.enabled === true,
            JSON.stringify(d).slice(0, 160));
    });
    Api.sysPara.add({ paraNameCn: '__格式错误__', paraNameEn: '1bad key' }).fail(function (e) {
        check('Mock 拒绝数字开头 / 含空格的英文名',
            !!e && /只能以字母开头/.test(e.message), e && e.message);
    });
    Api.sysPara.add({ paraNameCn: '__值超长__', paraNameEn: 'jsdom_long_value',
                      paraValue: new Array(1002).join('x') }).fail(function (e) {
        check('Mock 拒绝超过 1000 字的参数值',
            !!e && /最多 1000/.test(e.message), e && e.message);
    });
    Api.sysPara.add({ paraNameCn: '__重名__', paraNameEn: 'site_name' }).fail(function (e) {
        check('Mock 拒绝重复英文名', !!e && /已存在/.test(e.message), e && e.message);
    });
});
step(function () {
    console.log('\n--- 4. 检索筛选 / 状态保存 ---');
    clickSearch('site_name', '');
});
step(function () {
    check('按英文名关键字命中 1 条', rows().length === 1 && /系统名称/.test($('#spTbody').text()),
        String(rows().length));
    check('检索条件写入 sessionStorage',
        /site_name/.test(String(win.sessionStorage.getItem('syspara_state'))),
        String(win.sessionStorage.getItem('syspara_state')).slice(0, 120));
    clickSearch('九豆综合管理平台', '');
});
step(function () {
    check('按参数值关键字也能命中', rows().length === 1 && /系统名称/.test($('#spTbody').text()),
        String(rows().length));
    clickSearch('', '0');
});
step(function () {
    check('按「停用」筛出 1 条', rows().length === 1 && /维护公告/.test($('#spTbody').text()),
        String(rows().length));
    clickSearch('', '1');
});
step(function () {
    check('按「启用」筛出 3 条', rows().length === 3, String(rows().length));
    $('#btnReset').trigger('click');
});
step(function () {
    check('重置后恢复 4 条且清空检索条件',
        rows().length === 4 && $('#keyword').val() === '' && $('#enabled').val() === '',
        String(rows().length));
});

step(function () {
    console.log('\n--- 5. 新增弹窗 ---');
    $('#btnAdd').trigger('click');
});
step(function () {
    check('弹窗标题「新增系统参数」', /新增系统参数/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    check('表单 6 个字段齐全且带英文名格式提示',
        ['#spNameCn', '#spNameEn', '#spValue', '#spSort', '#spRemark', '#spEnabled']
            .every(function (id) { return form().find(id).length === 1; }) &&
        /以字母开头/.test(form().text()));
    check('默认序号 0 / 启用',
        form().find('#spSort').val() === '0' && form().find('#spEnabled').val() === '1');
    dialog().find('.btn-ok').trigger('click');
    check('参数中文名为空阻止保存并提示',
        dialog().length === 1 && /请填写参数中文名/.test(toast()), toast().slice(-90));
    form().find('#spNameCn').val('__jsdom测试参数__');
    dialog().find('.btn-ok').trigger('click');
    check('参数英文名为空阻止保存并提示',
        dialog().length === 1 && /请填写参数英文名/.test(toast()), toast().slice(-90));
    form().find('#spNameCn').val('__jsdom非法英文名__');
    form().find('#spNameEn').val('1bad key');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    check('非法英文名被 Mock 拒绝并提示格式',
        dialog().length === 1 && /只能以字母开头/.test(toast()), toast().slice(-120));
    form().find('#spNameCn').val('__jsdom测试参数__');
    form().find('#spNameEn').val('jsdom_test_para');
    form().find('#spValue').val('{"mode":"test"}');
    form().find('#spSort').val('9');
    form().find('#spRemark').val('jsdom 自动化新增');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    console.log('\n--- 6. 保存结果 ---');
    check('保存成功后弹窗关闭', $('.el-overlay .el-dialog').length === 0,
        String($('.el-overlay .el-dialog').length));
    var $new = rowOf(/__jsdom测试参数__/);
    check('列表出现新参数且总数变 5', $new.length === 1 && rows().length === 5 &&
        $('#spCount').text() === '5', String(rows().length) + '/' + $('#spCount').text());
    check('新参数显示英文名 / JSON 值 / 序号 / 说明',
        /jsdom_test_para/.test($new.text()) && /\{"mode":"test"\}/.test($new.text()) &&
        /9/.test($new.text()) && /jsdom 自动化新增/.test($new.text()),
        $new.text().replace(/\s+/g, ' ').slice(0, 180));
    win.__newId = $new.attr('data-id');
    check('新参数主键由 Mock 自动生成', /^[0-9a-f-]{30,40}$/.test(String(win.__newId)),
        String(win.__newId));
});

step(function () {
    console.log('\n--- 7. 编辑 / 启停 / 删除 ---');
    rowOf(/__jsdom测试参数__/).trigger('click');
    check('选中启用记录后「启用」禁用、「停用」可用',
        $('#btnEnable').prop('disabled') === true && $('#btnDisable').prop('disabled') === false);
    $('#btnEdit').trigger('click');
});
step(function () {
    check('编辑弹窗回填中文名 / 英文名 / 参数值 / 序号 / 说明 / 启用',
        /编辑系统参数/.test(dialog().find('.el-dialog__title').text()) &&
        form().find('#spNameCn').val() === '__jsdom测试参数__' &&
        form().find('#spNameEn').val() === 'jsdom_test_para' &&
        form().find('#spValue').val() === '{"mode":"test"}' &&
        form().find('#spSort').val() === '9' &&
        form().find('#spRemark').val() === 'jsdom 自动化新增' &&
        form().find('#spEnabled').val() === '1', form().find('#spValue').val());
    form().find('#spNameCn').val('__jsdom测试参数（改）');
    form().find('#spValue').val('改后的值');
    form().find('#spSort').val('7');
    form().find('#spEnabled').val('0');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    var $edited = rowOf(/__jsdom测试参数（改）/);
    check('编辑后列表更新名称 / 值 / 序号 / 停用',
        $edited.length === 1 && /改后的值/.test($edited.text()) &&
        /停用/.test($edited.text()) && /7/.test($edited.find('td').eq(5).text()),
        $edited.text().replace(/\s+/g, ' ').slice(0, 180));
    $edited.trigger('click');
    check('选中停用记录后「停用」禁用、「启用」可用',
        $('#btnEnable').prop('disabled') === false && $('#btnDisable').prop('disabled') === true);
    $('#btnEnable').trigger('click');
});
step(function () {
    var $edited = rowOf(/__jsdom测试参数（改）/);
    check('启用后状态变为「启用」', /启用/.test($edited.text()) && !/停用/.test($edited.text()),
        $edited.text().replace(/\s+/g, ' ').slice(0, 120));
    $edited.trigger('click');
    $('#btnDelete').trigger('click');
    check('删除弹确认框且带参数中文名',
        msgBox().length === 1 && /删除系统参数/.test(msgBox().text()) &&
        /__jsdom测试参数（改）/.test(msgBox().text()), msgBox().text().slice(0, 100));
    msgBox().find('.btn-ok').trigger('click');
});
step(function () {
    check('删除后列表恢复 4 条且操作按钮禁用',
        rows().length === 4 && !/__jsdom测试参数/.test($('#spTbody').text()) &&
        $('#btnEdit').prop('disabled') === true && $('#btnDelete').prop('disabled') === true,
        String(rows().length));
    Api.sysPara.page({ keyword: '__jsdom测试参数' }).done(function (d) {
        check('Mock 层新参数已被删除', int0(d.total) === 0, String(d.total));
    });
    Api.sysPara.page({}).done(function (d) {
        check('Mock 层参数总数恢复 4 条', int0(d.total) === 4, String(d.total));
    });
});

step(function () {
    console.log('\n--- 8. 双击编辑 / 刷新 ---');
    rows().filter(function () { return $(this).attr('data-id') === SP_TOKEN; }).trigger('dblclick');
    check('双击行打开编辑弹窗',
        /编辑系统参数/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
});
step(function () {
    check('双击打开的是「令牌有效期」这条参数',
        form().find('#spNameEn').val() === 'token_expire_hours' &&
        form().find('#spValue').val() === '8', form().find('#spNameEn').val());
    dialog().find('.btn-cancel').trigger('click');
    check('取消按钮关闭弹窗', $('.el-overlay .el-dialog').length === 0,
        String($('.el-overlay .el-dialog').length));
    $('#btnRefresh').trigger('click');
});
step(function () {
    check('刷新后列表仍为 4 条', rows().length === 4, String(rows().length));
});

function int0(v) { return parseInt(v, 10) || 0; }
next();
