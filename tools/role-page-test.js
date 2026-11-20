/* ==========================================================================
   role-page-test.js —— 用户角色管理页面测试（jsdom，无需浏览器）
   覆盖：列表渲染（中文名 / 英文名 / 排序号 / 启用标签、**不展示 UUID**）、关键字与启用否筛选、
        弹窗新增（中文名与英文名必填、英文名格式、中文名启用状态内唯一、英文名唯一、排序号默认最大值 +1）、
        弹窗编辑回填与保存、删除确认与执行
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/role-page-test.js
   ========================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var JSDOM = (function () {
    try { return require('jsdom').JSDOM; } catch (e) { return null; }
})();

var ROOT = path.resolve(__dirname, '..');
var pass = 0, fail = 0;
var RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

/* 装载页面（不发真实请求，api.js 自动走 Mock 通道） */
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

var win = boot('role.html', ['js/role.js']);
var $ = win.jQuery;

function dialog() { return $('.el-overlay .el-dialog').last(); }
function dialogBody() { return dialog().find('.el-dialog__body'); }
function fieldOf(name) { return dialogBody().find('[name="' + name + '"]'); }
function cellText($tr, i) { return $.trim($tr.find('td').eq(i).text()); }

setTimeout(function () {
    console.log('\n--- 1. 列表渲染 ---');
    var $rows = $('#roleTbody tr[data-id]');
    check('列表渲染 4 条角色数据', $rows.length === 4, 'rows=' + $rows.length);
    check('列表共 8 列（不含角色ID）', $rows.eq(0).find('td').length === 8,
        String($rows.eq(0).find('td').length));
    check('查询结果区不展示 UUID',
        !RE_UUID.test($('#roleTbody').text()) && !/角色ID/.test($('#roleTable thead').text()),
        $('#roleTable thead').text().replace(/\s+/g, ' '));
    check('中文名列显示「系统管理员」', cellText($rows.eq(0), 2) === '系统管理员', cellText($rows.eq(0), 2));
    check('英文名列显示「SystemAdmin」', cellText($rows.eq(0), 3) === 'SystemAdmin', cellText($rows.eq(0), 3));
    check('说明列有内容', cellText($rows.eq(0), 4).length > 4, cellText($rows.eq(0), 4));
    check('排序号列按 1/2/3/4 升序',
        $rows.map(function () { return cellText($(this), 5); }).get().join(',') === '1,2,3,4',
        $rows.map(function () { return cellText($(this), 5); }).get().join(','));
    check('启用否列显示启用 / 停用标签',
        $rows.eq(0).find('.el-tag').text() === '启用' && $rows.eq(3).find('.el-tag').text() === '停用',
        $rows.eq(0).find('.el-tag').text() + ' / ' + $rows.eq(3).find('.el-tag').text());
    check('分页显示总条数 4', /共 4 条/.test($('#pagerWrap').text()), $('#pagerWrap').text());

    console.log('\n--- 2. 查询与筛选 ---');
    $('#keyword').val('审计员');
    $('#btnSearch').trigger('click');
    setTimeout(function () {
        check('关键字按中文名检索命中 1 条', $('#roleTbody tr[data-id]').length === 1,
            String($('#roleTbody tr[data-id]').length));
        $('#keyword').val('NormalUser');
        $('#btnSearch').trigger('click');
        setTimeout(function () {
            check('关键字按英文名检索命中 1 条', $('#roleTbody tr[data-id]').length === 1,
                String($('#roleTbody tr[data-id]').length));
            $('#btnReset').trigger('click');
            setTimeout(function () {
                check('重置后恢复 4 条', $('#roleTbody tr[data-id]').length === 4,
                    String($('#roleTbody tr[data-id]').length));

                $('#enabledFilter').val('0');
                $('#enabledFilter').trigger('change');
                setTimeout(function () {
                    check('启用否筛选「停用」命中 1 条', $('#roleTbody tr[data-id]').length === 1,
                        String($('#roleTbody tr[data-id]').length));
                    check('筛选结果为审计员（停用）',
                        /审计员/.test($('#roleTbody').text()) && /停用/.test($('#roleTbody .el-tag').text()),
                        $('#roleTbody .el-tag').text());
                    $('#btnReset').trigger('click');
                    setTimeout(runAddTests, 500);
                }, 600);
            }, 500);
        }, 500);
    }, 600);
}, 1200);

/* ---------------- 3. 新增（弹窗） ---------------- */
function runAddTests() {
    console.log('\n--- 3. 新增角色（本页弹窗） ---');
    $('#btnAdd').trigger('click');

    setTimeout(function () {
        check('点击「新增角色」弹出表单弹窗',
            dialog().length === 1 && /新增角色/.test(dialog().find('.el-dialog__title').text()),
            dialog().find('.el-dialog__title').text());
        check('弹窗含中文名 / 英文名 / 排序号 / 启用否 / 说明',
            ['nameCn', 'nameEn', 'sortNo', 'enabled', 'remark'].every(function (n) {
                return fieldOf(n).length === 1;
            }));
        check('中文名与英文名均标记为必填',
            dialogBody().find('[data-field="nameCn"]').hasClass('is-required') &&
            dialogBody().find('[data-field="nameEn"]').hasClass('is-required'));
        check('新增时排序号自动取当前最大值 +1（4 → 5）', fieldOf('sortNo').val() === '5', fieldOf('sortNo').val());
        check('新增弹窗不显示角色ID（无字段、无「角色ID」文案、无 UUID 文本）',
            fieldOf('roleId').length === 0 && !/角色ID/.test(dialogBody().text()) &&
            !RE_UUID.test(dialogBody().text()),
            dialogBody().text().slice(0, 80));

        // 中文名必填
        fieldOf('nameCn').val('');
        fieldOf('nameEn').val('TempRole');
        dialog().find('.btn-ok').trigger('click');
        check('中文名为空时保存被拦截（弹窗不关闭）',
            dialog().length === 1 && /请输入中文名/.test(dialogBody().text()),
            dialogBody().find('.el-form-item__error').text());

        // 英文名必填
        fieldOf('nameCn').val('临时角色');
        fieldOf('nameEn').val('');
        dialog().find('.btn-ok').trigger('click');
        check('英文名为空时保存被拦截',
            dialog().length === 1 && /请输入英文名/.test(dialogBody().text()),
            dialogBody().find('.el-form-item__error').text());

        // 英文名格式
        fieldOf('nameEn').val('1abc');
        dialog().find('.btn-ok').trigger('click');
        check('英文名格式非法时保存被拦截',
            dialog().length === 1 && /英文名以字母开头/.test(dialogBody().text()),
            dialogBody().find('.el-form-item__error').text());

        // 中文名与启用角色重复
        fieldOf('nameCn').val('系统管理员');
        fieldOf('nameEn').val('TempRole');
        dialog().find('.btn-ok').trigger('click');
        setTimeout(function () {
            check('中文名与启用角色重名时保存被拦截',
                dialog().length === 1 && /已被其它启用状态的角色使用/.test(dialogBody().text()),
                dialogBody().text().slice(0, 90));

            // 英文名重复
            fieldOf('nameCn').val('临时角色');
            fieldOf('nameEn').val('SystemAdmin');
            dialog().find('.btn-ok').trigger('click');
            setTimeout(function () {
                check('英文名重复时保存被拦截',
                    dialog().length === 1 && /该英文名已存在/.test(dialogBody().text()),
                    dialogBody().find('.el-form-item__error').text());

                // 正常新增
                fieldOf('nameEn').val('PageTestRole');
                fieldOf('remark').val('由页面测试新增');
                fieldOf('sortNo').val('6');
                dialog().find('.btn-ok').trigger('click');
                setTimeout(function () {
                    check('合法数据保存后弹窗关闭', dialog().length === 0, 'dialogs=' + dialog().length);
                    var $r = $('#roleTbody tr[data-id]');
                    check('新增后列表变 5 条', $r.length === 5, 'rows=' + $r.length);
                    check('新增记录排在最后且中文名 / 英文名 / 排序号正确',
                        cellText($r.last(), 2) === '临时角色' && cellText($r.last(), 3) === 'PageTestRole'
                        && cellText($r.last(), 5) === '6',
                        [cellText($r.last(), 2), cellText($r.last(), 3), cellText($r.last(), 5)].join(' / '));
                    check('新增后列表仍不展示 UUID', !RE_UUID.test($('#roleTbody').text()));
                    runEditTests();
                }, 900);
            }, 700);
        }, 700);
    }, 800);
}

/* ---------------- 4. 编辑（弹窗回填） ---------------- */
function runEditTests() {
    console.log('\n--- 4. 编辑角色 ---');
    var $tr = $('#roleTbody tr[data-id]').filter(function () { return /临时角色/.test($(this).text()); });
    $tr.trigger('click');
    check('点击行后选中提示显示中文名', /临时角色/.test($('#selTip').text()), $('#selTip').text());

    $('#btnEdit').trigger('click');
    setTimeout(function () {
        check('点击「编辑」弹出编辑弹窗',
            dialog().length === 1 && /编辑角色/.test(dialog().find('.el-dialog__title').text()),
            dialog().find('.el-dialog__title').text());
        check('编辑弹窗回填中文名', fieldOf('nameCn').val() === '临时角色', fieldOf('nameCn').val());
        check('编辑弹窗回填英文名', fieldOf('nameEn').val() === 'PageTestRole', fieldOf('nameEn').val());
        check('编辑弹窗回填排序号', fieldOf('sortNo').val() === '6', fieldOf('sortNo').val());
        check('编辑弹窗回填说明', fieldOf('remark').val() === '由页面测试新增', fieldOf('remark').val());
        check('编辑弹窗不显示角色ID（无字段、无「角色ID」文案、无 UUID 文本）',
            fieldOf('roleId').length === 0 && !/角色ID/.test(dialogBody().text()) &&
            !RE_UUID.test(dialogBody().text()),
            dialogBody().text().slice(0, 80));

        fieldOf('nameCn').val('临时角色(改)');
        fieldOf('nameEn').val('PageTestRoleEdit');
        fieldOf('sortNo').val('0');
        fieldOf('enabled').val('0');
        dialog().find('.btn-ok').trigger('click');
        setTimeout(function () {
            check('编辑保存后弹窗关闭', dialog().length === 0);
            var $r = $('#roleTbody tr[data-id]');
            check('保存后按新排序号 0 排到最前', cellText($r.first(), 2) === '临时角色(改)', cellText($r.first(), 2));
            check('列表显示修改后的英文名与停用状态',
                cellText($r.first(), 3) === 'PageTestRoleEdit' && /停用/.test($r.first().find('.el-tag').text()),
                cellText($r.first(), 3) + ' / ' + $r.first().find('.el-tag').text());
            runDeleteTests();
        }, 900);
    }, 800);
}

/* ---------------- 5. 删除 ---------------- */
function runDeleteTests() {
    console.log('\n--- 5. 删除角色 ---');
    var $tr = $('#roleTbody tr[data-id]').filter(function () { return /临时角色\(改\)/.test($(this).text()); });
    $tr.trigger('click');
    $('#btnDelete').trigger('click');

    setTimeout(function () {
        var $box = $('.el-message-box__wrapper').last();
        check('删除前弹出确认框', /删除确认/.test($box.find('.el-message-box__title').text()),
            $box.find('.el-message-box__title').text());
        check('确认文案包含中文名', /临时角色\(改\)/.test($box.find('.el-message-box__message').text()),
            $box.find('.el-message-box__message').text());
        $box.find('.btn-ok').trigger('click');
        setTimeout(function () {
            check('删除后列表回到 4 条', $('#roleTbody tr[data-id]').length === 4,
                String($('#roleTbody tr[data-id]').length));
            check('删除后列表中不再有临时角色', !/临时角色/.test($('#roleTbody').text()));
            check('删除后选中状态被清空', /未选择/.test($('#selTip').text()), $('#selTip').text());

            console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
            process.exit(fail ? 1 : 0);
        }, 900);
    }, 700);
}
