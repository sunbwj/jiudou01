/* ==========================================================================
   emp-page-test.js —— 员工信息管理页面测试（jsdom，无需浏览器）
   覆盖：列表渲染 / 工号格式 / 部门与状态展示 / 关键字与状态筛选 /
        弹窗新增（工号自动预取、邮箱必填与格式校验、工号唯一校验）/
        弹窗编辑回填与保存 / 删除确认与执行
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/emp-page-test.js
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

var win = boot('emp.html', ['js/emp.js']);
var $ = win.jQuery;

function dialog() { return $('.el-overlay .el-dialog').last(); }
function dialogBody() { return dialog().find('.el-dialog__body'); }
function fieldOf(name) { return dialogBody().find('[name="' + name + '"]'); }
function closeDialog() {
    var $d = dialog();
    if ($d.length) { $d.find('.btn-cancel').trigger('click'); }
}

setTimeout(function () {
    console.log('\n--- 1. 列表渲染 ---');
    var $rows = $('#empTbody tr[data-id]');
    check('列表渲染 6 条员工数据', $rows.length === 6, 'rows=' + $rows.length);
    check('工号列符合 E + 5 位流水号',
        /^E\d{5}$/.test($rows.eq(0).find('td').eq(2).text().trim()), $rows.eq(0).find('td').eq(2).text());
    check('姓名列显示中文名', /张守正/.test($rows.eq(0).text()), $rows.eq(0).find('td').eq(3).text());
    check('性别列显示男/女', /^(男|女)$/.test($rows.eq(0).find('td').eq(4).text().trim()),
        $rows.eq(0).find('td').eq(4).text());
    check('所属部门列带出部门名称', /技术研发部/.test($rows.eq(0).find('td').eq(5).text()),
        $rows.eq(0).find('td').eq(5).text());
    check('邮箱列显示邮箱', /@jiudou\.com$/.test($rows.eq(0).find('td').eq(8).text().trim()),
        $rows.eq(0).find('td').eq(8).text());
    check('在职状态为标签样式（在职 / 试用 / 离职）',
        $rows.eq(0).find('.el-tag').length === 1 && /在职|试用|离职/.test($rows.eq(0).find('.el-tag').text()),
        $rows.eq(0).find('.el-tag').text());
    check('列表按工号升序（E00001 在最前）', /E00001/.test($rows.eq(0).text()));
    check('列表共 13 列（新增「学历 / 职称」「出生日期」）',
        $rows.eq(0).find('td').length === 13, String($rows.eq(0).find('td').length));
    check('姓名列带头像（无照片时显示姓名首字）',
        $rows.eq(0).find('.emp-avatar').length === 1 && /张/.test($rows.eq(0).find('.emp-avatar').text()),
        $rows.eq(0).find('.emp-avatar').text());
    check('「学历 / 职称」列显示「硕士 / 高级工程师」',
        /硕士\s*\/\s*高级工程师/.test($rows.eq(0).find('td').eq(11).text()),
        $rows.eq(0).find('td').eq(11).text());
    check('出生日期列为 YYYY-MM-DD',
        /^\d{4}-\d{2}-\d{2}$/.test($rows.eq(0).find('td').eq(12).text().trim()),
        $rows.eq(0).find('td').eq(12).text());

    check('操作引导区全部为图标按钮（svg + title + aria-label，无可见文字）',
        $('.toolbar').hasClass('toolbar--icons') &&
        $('.toolbar').attr('role') === 'toolbar' &&
        $('.toolbar .el-button').length === 6 &&
        $('.toolbar .el-button').toArray().every(function (b) {
            var $b = $(b);
            return $b.hasClass('el-button--icon') &&
                $b.find('svg.svg-ico').length === 1 &&
                !!$b.attr('title') && !!$b.attr('aria-label') &&
                $b.text().trim() === '';
        }), $('.toolbar').attr('class'));

    check('分页显示总条数 6',
        /共 6 条/.test($('#pagerWrap').text()), $('#pagerWrap').text());

    console.log('\n--- 2. 查询与筛选 ---');
    $('#keyword').val('王多云');
    $('#btnSearch').trigger('click');
    setTimeout(function () {
        check('关键字检索命中 1 条', $('#empTbody tr[data-id]').length === 1,
            String($('#empTbody tr[data-id]').length));
        $('#btnReset').trigger('click');
        setTimeout(function () {
            check('重置后恢复 6 条', $('#empTbody tr[data-id]').length === 6,
                String($('#empTbody tr[data-id]').length));

            $('#status').val('0');
            $('#status').trigger('change');
            setTimeout(function () {
                check('在职状态筛选「离职」命中 1 条', $('#empTbody tr[data-id]').length === 1,
                    String($('#empTbody tr[data-id]').length));
                check('筛选结果状态标签为离职',
                    /离职/.test($('#empTbody tr[data-id] .el-tag').text()),
                    $('#empTbody tr[data-id] .el-tag').text());
                $('#btnReset').trigger('click');
                setTimeout(runAddTests, 500);
            }, 600);
        }, 500);
    }, 600);
}, 1200);

/* ---------------- 3. 新增（弹窗） ---------------- */
function runAddTests() {
    console.log('\n--- 3. 新增员工（本页弹窗） ---');
    $('#btnAdd').trigger('click');

    setTimeout(function () {
        check('点击「新增员工」弹出表单弹窗', dialog().length === 1 && /新增员工/.test(dialog().find('.el-dialog__title').text()),
            dialog().find('.el-dialog__title').text());
        check('工号自动预取为 E00007', fieldOf('code').val() === 'E00007', fieldOf('code').val());
        check('工号输入框可编辑（未被锁定）', fieldOf('code').prop('readonly') !== true);
        check('所属部门下拉带出组织架构部门',
            fieldOf('deptId').find('option').length > 1,
            String(fieldOf('deptId').find('option').length));
        check('在职状态下拉含在职/试用/离职',
            fieldOf('status').find('option').length === 3, String(fieldOf('status').find('option').length));
        check('弹窗含档案字段（出生日期/身份证/学历/院校/专业/证书/职称/照片）',
            ['birthDate', 'idCard', 'education', 'school', 'major', 'certificates', 'titleName', 'photo']
                .every(function (n) { return fieldOf(n).length === 1; }),
            ['birthDate', 'idCard', 'education', 'school', 'major', 'certificates', 'titleName', 'photo']
                .filter(function (n) { return fieldOf(n).length !== 1; }).join(','));
        check('最高学历下拉含 大专/本科/硕士/博士',
            ['大专', '本科', '硕士', '博士'].every(function (v) {
                return fieldOf('education').find('option[value="' + v + '"]').length === 1;
            }), String(fieldOf('education').find('option').length));
        check('照片区默认显示「暂无照片」占位',
            dialogBody().find('.emp-photo__ph').length === 1 && fieldOf('photo').val() === '');

        // 邮箱必填校验
        fieldOf('nameCn').val('测试员工');
        fieldOf('email').val('');
        dialog().find('.btn-ok').trigger('click');
        check('邮箱为空时保存被拦截（弹窗不关闭）',
            dialog().length === 1 && /请输入邮箱/.test(dialogBody().text()),
            dialogBody().find('.el-form-item__error').text());

        // 邮箱格式校验
        fieldOf('email').val('abc@');
        dialog().find('.btn-ok').trigger('click');
        check('邮箱格式错误时保存被拦截',
            dialog().length === 1 && /邮箱格式不正确/.test(dialogBody().text()),
            dialogBody().find('.el-form-item__error').text());

        // 身份证号位数校验
        fieldOf('email').val('test.emp@jiudou.com');
        fieldOf('idCard').val('12345678901234567');
        dialog().find('.btn-ok').trigger('click');
        check('身份证号位数不合法时保存被拦截',
            dialog().length === 1 && /身份证号/.test(dialogBody().text()),
            dialogBody().find('.el-form-item__error').text());

        // 合法身份证号 → 自动带出出生日期
        fieldOf('idCard').val('110101199003072345').trigger('blur');
        check('身份证号合法时自动带出出生日期',
            fieldOf('birthDate').val() === '1990-03-07', fieldOf('birthDate').val());

        // 出生日期不能晚于今天
        fieldOf('birthDate').val('2099-01-01');
        dialog().find('.btn-ok').trigger('click');
        check('出生日期晚于今天时保存被拦截',
            dialog().length === 1 && /出生日期不能晚于今天/.test(dialogBody().text()),
            dialogBody().find('.el-form-item__error').text());
        fieldOf('birthDate').val('1990-03-07');

        // 档案字段（学历 / 院校 / 专业 / 证书 / 职称 / 照片）
        fieldOf('education').val('硕士');
        fieldOf('school').val('北京大学');
        fieldOf('major').val('临床医学');
        fieldOf('certificates').val('执业医师资格证');
        fieldOf('titleName').val('主治医师');
        fieldOf('photo').val('data:image/png;base64,AAAA');

        // 工号重复校验
        fieldOf('code').val('E00001');
        dialog().find('.btn-ok').trigger('click');
        setTimeout(function () {
            check('工号重复时保存被拦截', dialog().length === 1 && /工号已存在|已被占用/.test(dialogBody().text()),
                dialogBody().text().slice(0, 120));

            // 正常新增
            fieldOf('code').val('E00007');
            fieldOf('phone').val('13900139000');
            dialog().find('.btn-ok').trigger('click');
            setTimeout(function () {
                check('合法数据保存后弹窗关闭', dialog().length === 0, 'dialogs=' + dialog().length);
                var $r = $('#empTbody tr[data-id]');
                check('新增后列表变 7 条', $r.length === 7, 'rows=' + $r.length);
                check('新增记录出现在列表中且工号为 E00007',
                    /E00007/.test($('#empTbody').text()) && /测试员工/.test($('#empTbody').text()));
                check('新增后分页总数同步为 7', /共 7 条/.test($('#pagerWrap').text()), $('#pagerWrap').text());
                runEditTests();
            }, 900);
        }, 700);
    }, 700);
}

/* ---------------- 4. 编辑（弹窗回填） ---------------- */
function runEditTests() {
    console.log('\n--- 4. 编辑员工 ---');
    var $tr = $('#empTbody tr[data-id]').filter(function () { return /E00007/.test($(this).text()); });
    $tr.trigger('click');
    check('点击行后选中提示显示员工姓名', /测试员工/.test($('#selTip').text()), $('#selTip').text());

    $('#btnEdit').trigger('click');
    setTimeout(function () {
        check('点击「编辑」弹出编辑弹窗',
            dialog().length === 1 && /编辑员工/.test(dialog().find('.el-dialog__title').text()),
            dialog().find('.el-dialog__title').text());
        check('编辑弹窗回填工号', fieldOf('code').val() === 'E00007', fieldOf('code').val());
        check('编辑弹窗回填姓名', fieldOf('nameCn').val() === '测试员工', fieldOf('nameCn').val());
        check('编辑弹窗回填邮箱', fieldOf('email').val() === 'test.emp@jiudou.com', fieldOf('email').val());
        check('编辑弹窗回填身份证号', fieldOf('idCard').val() === '110101199003072345', fieldOf('idCard').val());
        check('编辑弹窗回填出生日期', fieldOf('birthDate').val() === '1990-03-07', fieldOf('birthDate').val());
        check('编辑弹窗回填最高学历', fieldOf('education').val() === '硕士', fieldOf('education').val());
        check('编辑弹窗回填毕业院校与专业',
            fieldOf('school').val() === '北京大学' && fieldOf('major').val() === '临床医学',
            fieldOf('school').val() + ' / ' + fieldOf('major').val());
        check('编辑弹窗回填执业资格证书与职称',
            fieldOf('certificates').val() === '执业医师资格证' && fieldOf('titleName').val() === '主治医师',
            fieldOf('certificates').val() + ' / ' + fieldOf('titleName').val());
        check('编辑弹窗回填照片并渲染预览图',
            dialogBody().find('.emp-photo__preview img').length === 1,
            String(dialogBody().find('.emp-photo__preview img').length));

        dialogBody().find('#btnClearPhoto').trigger('click');
        check('点击「清除照片」后照片置空并回到占位',
            fieldOf('photo').val() === '' && dialogBody().find('.emp-photo__ph').length === 1,
            fieldOf('photo').val());

        fieldOf('jobTitle').val('自动化测试岗');
        fieldOf('status').val('2');
        dialog().find('.btn-ok').trigger('click');
        setTimeout(function () {
            check('编辑保存后弹窗关闭', dialog().length === 0);
            check('列表显示修改后的岗位', /自动化测试岗/.test($('#empTbody').text()));
            check('列表状态更新为试用', /试用/.test($('#empTbody').text()));
            var $editedTr = $('#empTbody tr[data-id]').filter(function () { return /E00007/.test($(this).text()); });
            check('列表「学历 / 职称」列显示「硕士 / 主治医师」',
                /硕士\s*\/\s*主治医师/.test($editedTr.find('td').eq(11).text()),
                $editedTr.find('td').eq(11).text());
            check('列表「出生日期」列显示 1990-03-07',
                $editedTr.find('td').eq(12).text().trim() === '1990-03-07',
                $editedTr.find('td').eq(12).text());
            runDeleteTests();
        }, 900);
    }, 800);
}

/* ---------------- 5. 删除 ---------------- */
function runDeleteTests() {
    console.log('\n--- 5. 删除员工 ---');
    var $tr = $('#empTbody tr[data-id]').filter(function () { return /E00007/.test($(this).text()); });
    $tr.trigger('click');
    $('#btnDelete').trigger('click');

    setTimeout(function () {
        var $box = $('.el-message-box__wrapper').last();
        check('删除前弹出确认框', /删除确认/.test($box.find('.el-message-box__title').text()),
            $box.find('.el-message-box__title').text());
        check('确认文案包含员工姓名', /测试员工/.test($box.find('.el-message-box__message').text()),
            $box.find('.el-message-box__message').text());
        $box.find('.btn-ok').trigger('click');
        setTimeout(function () {
            check('删除后列表回到 6 条', $('#empTbody tr[data-id]').length === 6,
                String($('#empTbody tr[data-id]').length));
            check('删除后列表中不再有 E00007', !/E00007/.test($('#empTbody').text()));
            check('删除后选中状态被清空', /未选择/.test($('#selTip').text()), $('#selTip').text());
            runArchiveTests();
        }, 900);
    }, 700);
}

/* ---------------- 6. 员工信息归档 / 历史归档 ---------------- */
function runArchiveTests() {
    console.log('\n--- 6. 归档（empinfoarchive） ---');
    $('#btnArchive').trigger('click');

    setTimeout(function () {
        var $box = $('.el-message-box__wrapper').last();
        check('点「归档」先弹出确认框', /归档确认/.test($box.find('.el-message-box__title').text()),
            $box.find('.el-message-box__title').text());
        check('确认文案包含将归档的记录数（共 6 条）', /共\s*6\s*条/.test($box.text()),
            $box.find('.el-message-box__message').text());
        $box.find('.btn-ok').trigger('click');

        setTimeout(function () {
            var msg = $('.el-message-list').text();
            check('归档成功提示含条数与归档时间',
                /归档成功：共\s*6\s*条记录，归档时间\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(msg), msg);
            check('确认框已关闭', $('.el-message-box__wrapper').length === 0,
                String($('.el-message-box__wrapper').length));
            $('#btnHistory').trigger('click');

            setTimeout(function () {
                var $d = dialog();
                check('点「历史归档」弹出历次归档时间列表',
                    /历史归档/.test($d.find('.el-dialog__title').text()), $d.find('.el-dialog__title').text());
                var $rows = $d.find('.arch-batch-body tr[data-batch]');
                check('批次列表显示 1 条归档记录', $rows.length === 1, 'rows=' + $rows.length);
                check('批次行显示归档时间（YYYY-MM-DD HH:mm:ss）',
                    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test($rows.text()), $rows.text());
                check('批次行显示记录数「6 条」', /6\s*条/.test($rows.text()), $rows.text());
                $rows.first().trigger('click');

                setTimeout(function () {
                    var $d2 = dialog();
                    check('点批次行弹出「归档员工名单」对话框',
                        /归档员工名单/.test($d2.find('.el-dialog__title').text()),
                        $d2.find('.el-dialog__title').text());
                    var $trs = $d2.find('.arch-emp-body tr');
                    check('名单渲染 6 条员工记录', $trs.length === 6, 'rows=' + $trs.length);
                    check('名单表头 11 列', $d2.find('.arch-table--emp thead th').length === 11,
                        String($d2.find('.arch-table--emp thead th').length));
                    check('名单顶部显示归档时间与总条数',
                        /归档时间/.test($d2.find('.arch-hint').text()) && /6/.test($d2.find('.arch-total').text()),
                        $d2.find('.arch-hint').text());
                    check('名单内容含工号 / 姓名 / 部门',
                        /E00001/.test($d2.text()) && /张守正/.test($d2.text()) && /技术研发部/.test($d2.text()),
                        $d2.find('.arch-emp-body').text().slice(0, 60));
                    check('名单按工号升序（E00001 在最前）', /E00001/.test($trs.eq(0).text()),
                        $trs.eq(0).text().slice(0, 40));

                    // 关键字过滤
                    $d2.find('.arch-kw').val('张守正');
                    $d2.find('.arch-search-btn').trigger('click');
                    setTimeout(function () {
                        var $f = dialog().find('.arch-emp-body tr');
                        check('归档名单支持关键字过滤（只剩 1 条）', $f.length === 1, 'rows=' + $f.length);
                        check('过滤结果就是张守正', /张守正/.test($f.text()), $f.text().slice(0, 40));

                        // 关闭两个弹窗
                        $('.el-overlay .el-dialog').last().find('.btn-cancel').trigger('click');
                        $('.el-overlay .el-dialog').last().find('.btn-cancel').trigger('click');
                        check('关闭后弹窗全部消失', $('.el-overlay').length === 0,
                            String($('.el-overlay').length));

                        console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
                        process.exit(fail ? 1 : 0);
                    }, 700);
                }, 800);
            }, 700);
        }, 900);
    }, 600);
}
