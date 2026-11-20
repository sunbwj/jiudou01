/* ==========================================================================
   user-page-test.js —— 用户信息管理页面测试（jsdom，无需浏览器）
   覆盖：列表渲染与列结构 / 全选与选中提示 / 批量设置角色 / 重置密码（888888）/
        批量创建（初始密码 888888，跳过已有账号）/ 新增用户（账号默认手机号）/
        编辑用户 / 删除用户 / 密码与 token 不外泄
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/user-page-test.js
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
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

var win = boot('user.html', ['js/user.js']);
var $ = win.jQuery;

function rows() { return $('#userTbody tr[data-id]'); }
function rowCount() { return rows().length; }
function dialogs() { return $('.el-overlay .el-dialog'); }
function dialog() { return dialogs().last(); }
function dialogBody() { return dialog().find('.el-dialog__body'); }
function msgBox() { return $('.el-message-box').last(); }

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
    console.log('\n--- 1. 首屏（空数据 + 用接口批量建 3 个账号）---');
    check('页面标题为「用户信息管理」', /用户信息管理/.test($('.page-head__title').text()),
        $('.page-head__title').text());
    check('操作引导区含 7 个按钮（新增/批量创建/批量设置角色/重置密码/编辑/删除/刷新）',
        ['#btnAdd', '#btnBatch', '#btnBatchRole', '#btnResetPwd', '#btnEdit', '#btnDelete', '#btnRefresh']
            .every(function (sel) { return $(sel).length === 1; }),
        String($('.toolbar .el-button').length));
    check('表头 11 列（含「最近登录时间 / 最近登录IP」）',
        $('#userTable thead th').length === 11, String($('#userTable thead th').length));

    // 通过 API 造 3 个账号（等价于「批量创建」后端效果），再点刷新渲染
    win.Api.useInfo.batch({ empIds: [1, 2, 3], roleIds: [] }).done(function (res) {
        win.__created = (res && res.created) || 0;
        $('#btnRefresh').trigger('click');
    }).fail(function (err) {
        check('接口批量建号失败：' + err.message, false);
    });
});

step(function () {
    console.log('\n--- 2. 列表渲染 ---');
    check('批量建号成功 3 个', win.__created === 3, String(win.__created));
    check('列表渲染 3 行', rowCount() === 3, 'rows=' + rowCount());
    check('每行 11 列', rows().eq(0).find('td').length === 11, String(rows().eq(0).find('td').length));
    check('账号列为 11 位手机号',
        /^1\d{10}$/.test($.trim(rows().eq(0).find('td').eq(2).text())),
        rows().eq(0).find('td').eq(2).text());
    check('带出员工工号与姓名',
        /^E\d{5}$/.test($.trim(rows().eq(0).find('td').eq(3).text())) && rows().eq(0).find('td').eq(4).text().length > 0,
        rows().eq(0).find('td').eq(3).text() + ' / ' + rows().eq(0).find('td').eq(4).text());
    check('未授权角色时显示「未授权」', /未授权/.test(rows().eq(0).text()), rows().eq(0).find('td').eq(6).text());
    check('启用状态为「启用」标签', /启用/.test(rows().eq(0).find('td').eq(7).text()),
        rows().eq(0).find('td').eq(7).text());
    check('页面不出现密码明文 / 密文（只显示掩码）',
        !/21218cca77804d2ba1922c33e0151105/.test($('body').text()) && !/888888/.test($('#userTbody').text()),
        'ok');
    check('选中提示初始为「未选择任何用户」', /未选择/.test($('#selTip').text()), $('#selTip').text());
});

step(function () {
    console.log('\n--- 3. 全选 / 选中提示 ---');
    $('#checkAll').prop('checked', true).trigger('change');
    check('表头全选后 3 行都被勾选',
        $('#userTbody .um-row-check:checked').length === 3,
        String($('#userTbody .um-row-check:checked').length));
    check('选中提示显示「已选择 3 个用户」', /已选择 3 个用户/.test($('#selTip').text()), $('#selTip').text());
    check('选中行样式为 current-row', rows().filter('.current-row').length === 3,
        String(rows().filter('.current-row').length));
    $('#checkAll').prop('checked', false).trigger('change');
    check('取消全选后无选中', $('#userTbody .um-row-check:checked').length === 0 &&
        /未选择/.test($('#selTip').text()), $('#selTip').text());

    // 只勾第一行 + 第二行
    rows().eq(0).find('.um-row-check').prop('checked', true).trigger('change');
    rows().eq(1).find('.um-row-check').prop('checked', true).trigger('change');
    check('逐行勾选后提示为 2 个用户', /已选择 2 个用户/.test($('#selTip').text()), $('#selTip').text());
});

step(function () {
    console.log('\n--- 4. 批量设置角色 ---');
    $('#btnBatchRole').trigger('click');
});

step(function () {
    check('弹出「批量设置角色」对话框', /批量设置角色/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    var $roles = dialogBody().find('.um-role-check');
    check('角色多选渲染出启用角色（≥3 个）', $roles.length >= 3, 'roles=' + $roles.length);
    check('提示会覆盖原有角色', /覆盖/.test(dialogBody().text()), dialogBody().find('.um-tip').text().slice(0, 40));
    $roles.eq(0).prop('checked', true).trigger('change');
    check('勾选角色后胶囊显示选中态',
        dialogBody().find('.um-role.is-checked').length === 1,
        String(dialogBody().find('.um-role.is-checked').length));
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('设置角色成功提示出现', /设置成功/.test($('.el-message-list').text()), $('.el-message-list').text().slice(0, 80));
    var roleText = $('#userTbody').text();
    check('列表回读角色名称（前两行有角色，第三行仍「未授权」）',
        (roleText.match(/未授权/g) || []).length === 1, '未授权出现次数=' + (roleText.match(/未授权/g) || []).length);

    // 重置密码：只选第一行
    $('#checkAll').prop('checked', false).trigger('change');
    rows().eq(0).find('.um-row-check').prop('checked', true).trigger('change');
    $('#btnResetPwd').trigger('click');
});

step(function () {
    check('重置密码先弹确认框', /重置密码/.test(msgBox().find('.el-message-box__title').text()),
        msgBox().find('.el-message-box__title').text());
    check('确认文案包含目标密码 888888', /888888/.test(msgBox().text()), msgBox().find('.el-message-box__message').text());
    msgBox().find('.btn-ok').trigger('click');
});

step(function () {
    check('重置成功提示（含 888888）',
        /重置成功/.test($('.el-message-list').text()) && /888888/.test($('.el-message-list').text()),
        $('.el-message-list').text().slice(0, 100));
});

step(function () {
    console.log('\n--- 5. 批量创建（初始密码 888888） ---');
    $('#btnBatch').trigger('click');
});

step(function () {
    var body = dialogBody();
    check('弹出「批量创建用户」对话框', /批量创建用户/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    check('对话框提示初始密码 888888', /888888/.test(body.find('.um-tip').text()), body.find('.um-tip').text().slice(0, 60));
    var empRows = body.find('.um-emp-table tbody tr[data-id]');
    check('员工列表只列还没有账号的员工（3 人）', empRows.length === 3, 'rows=' + empRows.length);
    check('对话框内也有角色多选', body.find('.um-batch-roles .um-role-check').length >= 3,
        String(body.find('.um-batch-roles .um-role-check').length));
    // 勾选第一个员工
    empRows.eq(0).find('.um-emp-check').prop('checked', true).trigger('change');
    check('已选计数变为 1', /1/.test(body.find('.um-chosen').text()), body.find('.um-chosen').text());
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('批量创建成功提示（含初始密码 888888）',
        /批量创建完成/.test($('.el-message-list').text()) && /888888/.test($('.el-message-list').text()),
        $('.el-message-list').text().slice(0, 110));
    check('列表变为 4 行', rowCount() === 4, 'rows=' + rowCount());
});

step(function () {
    console.log('\n--- 6. 新增用户（账号默认手机号） ---');
    $('#btnAdd').trigger('click');
});

step(function () {
    var body = dialogBody();
    check('弹出「新增用户」对话框', /新增用户/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    var $emp = body.find('#ufEmp');
    check('员工下拉只列还没有账号的员工（2 人 + 占位）', $emp.find('option').length === 3,
        String($emp.find('option').length));
    check('新增表单含账号 / 启用 / 备注 / 角色',
        body.find('#ufAccount').length === 1 && body.find('#ufEnabled').length === 1 &&
        body.find('#ufRemark').length === 1 && body.find('#ufRoles .um-role-check').length >= 3,
        'ok');
    // 选择第一个员工 → 账号自动带出手机号
    var $opt = $emp.find('option').eq(1);
    $emp.val($opt.val()).trigger('change');
    check('选择员工后账号自动填手机的号码',
        $.trim(body.find('#ufAccount').val()) === ($opt.attr('data-phone') || ''),
        body.find('#ufAccount').val() + ' / ' + $opt.attr('data-phone'));
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('新增成功提示（初始密码 888888）',
        /创建成功/.test($('.el-message-list').text()) && /888888/.test($('.el-message-list').text()),
        $('.el-message-list').text().slice(0, 100));
    check('列表变为 5 行', rowCount() === 5, 'rows=' + rowCount());
});

step(function () {
    console.log('\n--- 7. 编辑用户 ---');
    $('#checkAll').prop('checked', false).trigger('change');
    rows().eq(0).find('.um-row-check').prop('checked', true).trigger('change');
    $('#btnEdit').trigger('click');
});

step(function () {
    var body = dialogBody();
    check('弹出「编辑用户」对话框', /编辑用户/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    check('员工不可修改（下拉禁用且只有一个选项）',
        body.find('#ufEmp').prop('disabled') === true && body.find('#ufEmp option').length === 1,
        String(body.find('#ufEmp option').length));
    check('账号回填为该用户的账号', /^1\d{10}$/.test($.trim(body.find('#ufAccount').val())),
        body.find('#ufAccount').val());
    check('编辑弹窗回填已有角色（第一行已有角色）',
        body.find('#ufRoles .um-role-check:checked').length >= 1,
        String(body.find('#ufRoles .um-role-check:checked').length));
    body.find('#ufRemark').val('页面测试备注');
    body.find('#ufEnabled').val('0');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('编辑保存提示出现', /保存成功/.test($('.el-message-list').text()), $('.el-message-list').text().slice(0, 80));
    check('列表第一行显示「停用」', /停用/.test(rows().eq(0).find('td').eq(7).text()),
        rows().eq(0).find('td').eq(7).text());
});

step(function () {
    console.log('\n--- 8. 删除用户 ---');
    $('#btnDelete').trigger('click');
});

step(function () {
    check('删除前弹出确认框', /删除确认/.test(msgBox().find('.el-message-box__title').text()),
        msgBox().find('.el-message-box__title').text());
    check('确认文案包含数量（1 个）', /1 个用户/.test(msgBox().text()), msgBox().find('.el-message-box__message').text().slice(0, 60));
    msgBox().find('.btn-ok').trigger('click');
});

step(function () {
    check('删除成功提示出现', /删除成功/.test($('.el-message-list').text()), $('.el-message-list').text().slice(0, 60));
    check('列表回到 4 行', rowCount() === 4, 'rows=' + rowCount());
    check('删除后选中被清空', /未选择/.test($('#selTip').text()), $('#selTip').text());
});

setTimeout(next, 1500);
