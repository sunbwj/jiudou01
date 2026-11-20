/* ==========================================================================
   sysdict-test.js —— 系统配置 · 系统字典页测试（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   页面形态：左区=字典键（检索 + 纯图标工具栏 + 紧凑列表），右区=该字典的键值。
   覆盖：
     ① 首屏骨架：左右分栏、左区 3 检索控件 + 6 图标按钮、左表 2 列、
        右区当前字典条未选中、右区 7 列、右区 6 按钮全禁用、空态文案；
     ② 字典树下拉、左列表排序（sortNo 升序）、副行英文名 / 键值数 / 上级名、L2 与启停徽标；
     ③ Mock 层：check / options（只启用）/ tree（excludeId 排除自身与后代）/ detail；
     ④ 左区检索：关键字 / 上级字典 / 启用状态 / 重置；
     ⑤ **单击只选中、不动右区**；**双击才把右区切到该字典的键值**；
     ⑥ 右区键值检索、新增（默认当前字典）、编辑、启停、删除，并与左区键值数联动；
     ⑦ 双击另一个字典切换右区（检索条件清空）；
     ⑧ 字典新增 / 编辑改名（右区标题同步）/ 启停 / 删除（右区回空态）/ 级联清理。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/sysdict-test.js
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

var win = boot('sysdict.html', ['js/sysdict.js']);
var $ = win.jQuery;
var Api = win.Api;

/* ---------------- 选择器工具 ---------------- */
function dictRows() { return $('#sdTbody tr[data-id]'); }
function itemRows() { return $('#siTbody tr[data-id]'); }
/** 只按「字典主名称」（.sysdict-row__main b）匹配，避免副行「上级：基础配置」误命中 */
function dictRowByName(re) {
    return dictRows().filter(function () {
        var cn = $.trim($(this).find('.sysdict-row__main b').first().text());
        return re.test(cn);
    });
}
function dictText(i) { return dictRows().eq(i).text().replace(/\s+/g, ' '); }
function itemText(i) { return itemRows().eq(i).text().replace(/\s+/g, ' '); }
/** 左区某字典副行里的键值数（.sysdict-row__count） */
function dictCount(re) {
    return $.trim(dictRowByName(re).find('.sysdict-row__count').first().text());
}
function dialog() { return $('.el-overlay .el-dialog').last(); }
function form() { return dialog().find('.pj-form'); }
function toast() { return $('.el-message-list').text(); }
function msgBox() { return $('.el-message-box').last(); }
function clickSearch(kw, parentId, enabled) {
    $('#keyword').val(kw || '');
    $('#parentId').val(parentId || '');
    $('#enabled').val(enabled === undefined ? '' : enabled);
    $('#btnSearch').trigger('click');
}
function clickItemSearch(kw, enabled) {
    $('#itemKeyword').val(kw || '');
    $('#itemEnabled').val(enabled === undefined ? '' : enabled);
    $('#btnItemSearch').trigger('click');
}
function int0(v) { return parseInt(v, 10) || 0; }

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

var BASIC_ID = 'sd-0000-4000-8000-000000000003';
var THEME_ID = 'sd-0000-4000-8000-000000000004';
var GENDER_ID = 'sd-0000-4000-8000-000000000001';
var STATUS_ID = 'sd-0000-4000-8000-000000000002';

/* ------------------------------- 用例 ------------------------------- */
step(function () {
    console.log('\n--- 1. 首屏骨架（左右分栏） ---');
    check('页面标题为「系统字典」', $('.page-head__title').text() === '系统字典',
        $('.page-head__title').text());
    check('面包屑为「系统配置/系统字典」',
        $('#pageHead').attr('data-crumb') === '系统配置/系统字典', $('#pageHead').attr('data-crumb'));
    check('存在左右分栏容器（.split-layout.syssplit + 左右两列）',
        $('.split-layout.syssplit').length === 1 &&
        $('.syssplit > .split-col--left').length === 1 &&
        $('.syssplit > .split-col--right').length === 1);
    check('左区含 3 个检索条件 + 查询 / 重置',
        $('#keyword').length === 1 && $('#parentId').length === 1 &&
        $('#enabled').length === 1 && $('#btnSearch').length === 1 && $('#btnReset').length === 1);
    check('左区 6 个按钮全部是纯图标按钮（.el-button--icon）',
        ['#btnAdd', '#btnEdit', '#btnEnable', '#btnDisable', '#btnDelete', '#btnRefresh']
            .every(function (id) {
                return $(id).length === 1 && $(id).hasClass('el-button--icon');
            }) && $('#btnAdd').text().replace(/\s+/g, '') === '',
        String($('.syssplit > .split-col--left .toolbar .el-button--icon').length));
    check('左区每个图标按钮都有 title 与 aria-label（无文字也要可读）',
        ['#btnAdd', '#btnEdit', '#btnEnable', '#btnDisable', '#btnDelete', '#btnRefresh']
            .every(function (id) {
                return $.trim($(id).attr('title') || '') !== '' &&
                    $.trim($(id).attr('aria-label') || '') !== '';
            }));
    check('左区表头 2 列（字典 / 启用）',
        $('#sdTable thead th').length === 2 &&
        /字典/.test($('#sdTable thead th').eq(0).text()) &&
        /启用/.test($('#sdTable thead th').eq(1).text()),
        String($('#sdTable thead th').length));
    check('右区「当前字典」条初始为未选择状态',
        $('#siCurrentDict').text() === '未选择' &&
        $('#siCurrentBar').hasClass('is-active') === false,
        $('#siCurrentDict').text());
    check('右区表头 7 列（不含「所属字典」，因为右区固定当前字典）',
        $('#siTable thead th').length === 7 &&
        /键$/.test($('#siTable thead th').eq(2).text()) &&
        /键值/.test($('#siTable thead th').eq(3).text()) &&
        /启用/.test($('#siTable thead th').eq(6).text()),
        String($('#siTable thead th').length));
    check('未选字典时右区 6 个按钮全部禁用',
        ['#btnItemAdd', '#btnItemEdit', '#btnItemEnable', '#btnItemDisable',
            '#btnItemDelete', '#btnItemRefresh'].every(function (id) {
            return $(id).prop('disabled') === true;
        }));
    check('左区未选中时编辑 / 启停 / 删除禁用、新增可用',
        $('#btnAdd').prop('disabled') === false && $('#btnEdit').prop('disabled') === true &&
        $('#btnDelete').prop('disabled') === true && $('#btnEnable').prop('disabled') === true);
    check('旧的「维护键值」按钮已移除（改由双击进入右区）', $('#btnItems').length === 0);
    check('顶部说明提到双击字典切右区与全局配置',
        /双击/.test($('.sysdict-hint').text()) && /全局配置/.test($('.sysdict-hint').text()));
});

step(function () {
    console.log('\n--- 2. 字典树 + 左区列表 ---');
    check('上级字典下拉 4 个字典 + 全部上级', $('#parentId option').length === 5,
        String($('#parentId option').length));
    check('下拉 label 带中文名与英文名',
        /用户性别/.test($('#parentId').text()) && /gender/.test($('#parentId').text()));
    check('左区列表 4 条字典', dictRows().length === 4, String(dictRows().length));
    check('顶部条数显示 4', $('#sdCount').text() === '4', $('#sdCount').text());
    check('左区分页组件已渲染', $('#sdPagerWrap .el-pagination').length === 1);
    check('按显示序号升序：gender / ui_theme / project_status / basic_config',
        /用户性别/.test(dictText(0)) && /界面主题/.test(dictText(1)) &&
        /项目状态/.test(dictText(2)) && /基础配置/.test(dictText(3)),
        dictText(0) + ' | ' + dictText(1));
    check('副行显示英文名（sys-name-en）',
        $.trim(dictRows().eq(0).find('.sys-name-en').text()) === 'gender',
        dictRows().eq(0).find('.sys-name-en').text());
    check('键值数正确（gender 3 / ui_theme 1 / project_status 2 / basic_config 0）',
        dictCount(/用户性别/) === '3' && dictCount(/界面主题/) === '1' &&
        dictCount(/项目状态/) === '2' && dictCount(/基础配置/) === '0',
        [dictCount(/用户性别/), dictCount(/界面主题/), dictCount(/项目状态/), dictCount(/基础配置/)].join('/'));
    check('子字典显示 L2 徽标与上级名',
        /L2/.test(dictText(1)) && /基础配置/.test(dictText(1)), dictText(1));
    check('停用字典显示「停用」徽标，其余「启用」',
        /停用/.test(dictText(1)) && /启用/.test(dictText(0)) && /启用/.test(dictText(2)),
        dictText(1));
    check('行内不再有单选框（左区用整行选中 + 双击）',
        $('#sdTbody input[type=radio]').length === 0);
    check('右区空态提示「请在左侧双击一条字典」',
        /请在左侧双击一条字典/.test($('#siTbody').text()), $('#siTbody').text().slice(0, 80));
});

step(function () {
    console.log('\n--- 3. Mock 层接口（check / options / tree / detail） ---');
    Api.sysDict.check('dictNameEn', 'gender').done(function (d) {
        check('check 已存在英文名返回 unique=false', d.unique === false);
    });
    Api.sysDict.check('dictNameEn', 'jsdom_never_used').done(function (d) {
        check('check 新英文名返回 unique=true', d.unique === true);
    });
    Api.sysDict.check('remark', 'x').fail(function (e) {
        check('check 不支持的字段被拒', !!e && /不支持/.test(e.message), e && e.message);
    });
    Api.sysDict.options().done(function (d) {
        var ids = (d.list || []).map(function (x) { return x.id; });
        check('options 只含 3 个启用字典（停用的界面主题不进下拉）',
            d.list.length === 3 && ids.indexOf(GENDER_ID) >= 0 &&
            ids.indexOf(BASIC_ID) >= 0 && ids.indexOf(THEME_ID) < 0, String(ids));
    });
    Api.sysDict.tree(BASIC_ID).done(function (d) {
        var ids = (d.list || []).map(function (x) { return x.id; });
        check('tree(excludeId) 排除自身与全部后代',
            ids.indexOf(BASIC_ID) < 0 && ids.indexOf(THEME_ID) < 0 && d.list.length === 2,
            String(ids));
    });
    Api.sysDict.detail(THEME_ID).done(function (d) {
        check('子字典 detail 的 level=2 / parentName=基础配置 / 停用',
            d.level === 2 && d.parentName === '基础配置' && d.enabled === false,
            JSON.stringify(d).slice(0, 140));
    });
    Api.sysDictItem.page({ dictId: GENDER_ID }).done(function (d) {
        check('Mock 层 gender 下有 3 条键值', int0(d.total) === 3, String(d.total));
    });
});

step(function () {
    console.log('\n--- 4. 左区检索筛选 ---');
    clickSearch('gender', '', '');
});
step(function () {
    check('关键字「gender」按英文名命中 1 条',
        dictRows().length === 1 && /用户性别/.test($('#sdTbody').text()), String(dictRows().length));
    clickSearch('', BASIC_ID, '');
});
step(function () {
    check('按上级字典「基础配置」筛出 1 条子字典',
        dictRows().length === 1 && /界面主题/.test($('#sdTbody').text()), String(dictRows().length));
    clickSearch('', '', '0');
});
step(function () {
    check('按「停用」筛出 1 条', dictRows().length === 1 && /界面主题/.test($('#sdTbody').text()),
        String(dictRows().length));
    clickSearch('', '', '1');
});
step(function () {
    check('按「启用」筛出 3 条', dictRows().length === 3, String(dictRows().length));
    $('#btnReset').trigger('click');
});
step(function () {
    check('重置后恢复 4 条且清空全部检索条件',
        dictRows().length === 4 && $('#keyword').val() === '' &&
        $('#parentId').val() === '' && $('#enabled').val() === '', String(dictRows().length));
});

step(function () {
    console.log('\n--- 5. 单击只选中，不动右区 ---');
    dictRowByName(/用户性别/).trigger('click');
    check('单击后该行标记 is-selected',
        dictRowByName(/用户性别/).hasClass('is-selected'));
    check('选中后编辑 / 启停 / 删除可用，且启用禁用（该字典已启用）',
        $('#btnEdit').prop('disabled') === false && $('#btnDelete').prop('disabled') === false &&
        $('#btnEnable').prop('disabled') === true && $('#btnDisable').prop('disabled') === false);
    check('单击不改右区：当前字典仍为「未选择」',
        $('#siCurrentDict').text() === '未选择' && $('#siCurrentBar').hasClass('is-active') === false,
        $('#siCurrentDict').text());
    check('单击后右区仍未加载键值（仍为空态、按钮仍禁用）',
        /请在左侧双击一条字典/.test($('#siTbody').text()) &&
        $('#btnItemAdd').prop('disabled') === true && itemRows().length === 0,
        'itemRows=' + itemRows().length + ' disabled=' + $('#btnItemAdd').prop('disabled'));
});

step(function () {
    console.log('\n--- 6. 双击进入右区键值管理 ---');
    dictRowByName(/用户性别/).trigger('dblclick');
});
step(function () {
    check('双击后当前字典条变为「用户性别」且高亮',
        $('#siCurrentDict').text() === '用户性别' && $('#siCurrentBar').hasClass('is-active'),
        $('#siCurrentDict').text());
    check('当前字典条副信息含英文名与 3 条键值',
        /gender/.test($('#siCurrentMeta').text()) && /3/.test($('#siCurrentMeta').text()),
        $('#siCurrentMeta').text());
    check('右区加载该字典 3 条键值', itemRows().length === 3, String(itemRows().length));
    check('键值按显示序号升序（男 / 女 / 未知）',
        /男/.test(itemText(0)) && /女/.test(itemText(1)) && /未知/.test(itemText(2)),
        itemText(0) + ' | ' + itemText(1));
    check('键值行带键编码 M / F / U',
        /M/.test(itemText(0)) && /F/.test(itemText(1)) && /U/.test(itemText(2)));
    check('右区顶部条数显示 3', $('#siCount').text() === '3', $('#siCount').text());
    check('右区新增 / 刷新按钮解禁，编辑删除仍禁用（未选键值行）',
        $('#btnItemAdd').prop('disabled') === false && $('#btnItemRefresh').prop('disabled') === false &&
        $('#btnItemEdit').prop('disabled') === true);
});

step(function () {
    console.log('\n--- 7. 右区键值检索 ---');
    clickItemSearch('未知', '');
});
step(function () {
    check('右区关键字「未知」命中 1 条',
        itemRows().length === 1 && /未知/.test($('#siTbody').text()), String(itemRows().length));
    clickItemSearch('', '0');
});
step(function () {
    check('右区按「停用」筛出 1 条（未知）',
        itemRows().length === 1 && /未知/.test($('#siTbody').text()), String(itemRows().length));
    $('#btnItemReset').trigger('click');
});
step(function () {
    check('右区重置后恢复 3 条且清空条件',
        itemRows().length === 3 && $('#itemKeyword').val() === '' && $('#itemEnabled').val() === '',
        String(itemRows().length));
});

step(function () {
    console.log('\n--- 8. 右区新增键值（默认当前字典） ---');
    $('#btnItemAdd').trigger('click');
});
step(function () {
    check('弹窗标题「新增字典键值」', /新增字典键值/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    check('表单 6 个字段齐全',
        ['#siDict', '#siKey', '#siValue', '#siSort', '#siRemark', '#siEnabled']
            .every(function (id) { return form().find(id).length === 1; }));
    check('所属字典默认当前字典（用户性别）',
        form().find('#siDict').val() === GENDER_ID, String(form().find('#siDict').val()));
    check('所属字典下拉含全部 4 个字典', form().find('#siDict option').length === 5,
        String(form().find('#siDict option').length));
    dialog().find('.btn-ok').trigger('click');
    check('键值为空阻止保存并提示',
        dialog().length === 1 && /请填写键值/.test(toast()), toast().slice(-90));
    form().find('#siKey').val('S');
    form().find('#siValue').val('保密');
    form().find('#siSort').val('4');
    form().find('#siRemark').val('jsdom 新增键值');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    check('保存成功后弹窗关闭', $('.el-overlay .el-dialog').length === 0,
        String($('.el-overlay .el-dialog').length));
    check('右区键值变 4 条且含新键值「保密」',
        itemRows().length === 4 && /保密/.test($('#siTbody').text()), String(itemRows().length));
    check('新键值落在当前字典（第 4 条，序号 4）',
        /保密/.test(itemText(3)) && /4/.test(itemText(3)), itemText(3));
    check('左区该字典键值数联动更新为 4', dictCount(/用户性别/) === '4', dictCount(/用户性别/));
    win.__newItemId = itemRows().filter(function () { return /保密/.test($(this).text()); }).attr('data-id');
    check('新键值主键为 Mock 生成的 UUID', /^[0-9a-f-]{30,40}$/.test(String(win.__newItemId)),
        String(win.__newItemId));
});

step(function () {
    console.log('\n--- 9. 右区编辑 / 启停 / 删除 ---');
    itemRows().filter(function () { return /保密/.test($(this).text()); }).trigger('click');
    check('选中键值后编辑 / 启停 / 删除解禁，启用禁用（该条已启用）',
        $('#btnItemEdit').prop('disabled') === false && $('#btnItemDelete').prop('disabled') === false &&
        $('#btnItemEnable').prop('disabled') === true && $('#btnItemDisable').prop('disabled') === false);
    $('#btnItemEdit').trigger('click');
});
step(function () {
    check('编辑弹窗标题带键值文本',
        /编辑字典键值/.test(dialog().find('.el-dialog__title').text()) &&
        /保密/.test(dialog().find('.el-dialog__title').text()));
    check('回填键 / 键值 / 序号 / 说明 / 所属字典',
        form().find('#siKey').val() === 'S' && form().find('#siValue').val() === '保密' &&
        form().find('#siSort').val() === '4' && form().find('#siRemark').val() === 'jsdom 新增键值' &&
        form().find('#siDict').val() === GENDER_ID,
        form().find('#siKey').val() + '/' + form().find('#siValue').val());
    form().find('#siValue').val('机密');
    form().find('#siEnabled').val('0');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    var $row = itemRows().filter(function () { return /机密/.test($(this).text()); });
    check('编辑后列表更新为「机密」并显示停用',
        $row.length === 1 && /停用/.test($row.text()), $row.text().replace(/\s+/g, ' ').slice(0, 100));
    $row.trigger('click');
    $('#btnItemEnable').trigger('click');
});
step(function () {
    var $row = itemRows().filter(function () { return /机密/.test($(this).text()); });
    check('启用后状态变为「启用」', /启用/.test($row.text()) && !/停用/.test($row.text()),
        $row.text().replace(/\s+/g, ' ').slice(0, 90));
    $row.trigger('click');
    $('#btnItemDelete').trigger('click');
    check('删除键值弹确认框且带键值文本',
        msgBox().length === 1 && /删除字典键值/.test(msgBox().text()) &&
        /机密/.test(msgBox().text()), msgBox().text().slice(0, 90));
    msgBox().find('.btn-ok').trigger('click');
});
step(function () {
    check('删除后右区恢复 3 条且不含「机密」',
        itemRows().length === 3 && !/机密/.test($('#siTbody').text()), String(itemRows().length));
    check('左区键值数回落为 3', dictCount(/用户性别/) === '3', dictCount(/用户性别/));
});

step(function () {
    console.log('\n--- 10. 双击另一个字典切换右区 ---');
    clickItemSearch('女', '');                 // 先给右区留一个检索条件，验证切换后清空
});
step(function () {
    check('切换前右区按「女」筛出 1 条', itemRows().length === 1, String(itemRows().length));
    dictRowByName(/项目状态/).trigger('dblclick');
});
step(function () {
    check('双击「项目状态」后右区切换为该字典',
        $('#siCurrentDict').text() === '项目状态' && /project_status/.test($('#siCurrentMeta').text()),
        $('#siCurrentDict').text());
    check('右区键值变为项目状态的 2 条（进行中 / 已完成）',
        itemRows().length === 2 && /进行中/.test(itemText(0)) && /已完成/.test(itemText(1)),
        itemText(0) + ' | ' + itemText(1));
    check('切换字典后键值检索条件被清空',
        $('#itemKeyword').val() === '' && $('#itemEnabled').val() === '');
});

step(function () {
    console.log('\n--- 11. 字典新增 / 改名 / 启停 ---');
    $('#btnAdd').trigger('click');
});
step(function () {
    check('新增字典弹窗 6 个字段齐全且带英文名格式提示',
        ['#sdNameCn', '#sdNameEn', '#sdParent', '#sdSort', '#sdRemark', '#sdEnabled']
            .every(function (id) { return form().find(id).length === 1; }) &&
        /以字母开头/.test(form().text()));
    dialog().find('.btn-ok').trigger('click');
    check('键中文名为空阻止保存并提示',
        dialog().length === 1 && /请填写键中文名/.test(toast()), toast().slice(-80));
    form().find('#sdNameCn').val('__jsdom测试字典__');
    form().find('#sdNameEn').val('1bad key');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    check('非法英文名（数字开头 + 空格）被 Mock 拒绝并提示格式',
        dialog().length === 1 && /只能以字母开头/.test(toast()), toast().slice(-110));
    form().find('#sdNameCn').val('__jsdom测试字典__');
    form().find('#sdNameEn').val('jsdom_test_dict');
    form().find('#sdParent').val(BASIC_ID);
    form().find('#sdSort').val('9');
    form().find('#sdRemark').val('jsdom 自动化新增');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    check('保存成功后弹窗关闭', $('.el-overlay .el-dialog').length === 0);
    var $new = dictRowByName(/__jsdom测试字典__/);
    check('左区出现新字典且总数变 5', $new.length === 1 && dictRows().length === 5 &&
        $('#sdCount').text() === '5', String(dictRows().length) + '/' + $('#sdCount').text());
    check('新字典显示英文名 / 上级 / L2 / 键值数 0',
        /jsdom_test_dict/.test($new.text()) && /基础配置/.test($new.text()) &&
        /L2/.test($new.text()) && dictCount(/__jsdom测试字典__/) === '0',
        $new.text().replace(/\s+/g, ' ').slice(0, 160));
    win.__newId = $new.attr('data-id');
    check('新字典主键由 Mock 自动生成 UUID', /^[0-9a-f-]{30,40}$/.test(String(win.__newId)),
        String(win.__newId));
});

step(function () {
    dictRowByName(/__jsdom测试字典__/).trigger('click');
    $('#btnEdit').trigger('click');
});
step(function () {
    check('编辑弹窗标题带字典中文名',
        /编辑系统字典/.test(dialog().find('.el-dialog__title').text()) &&
        /__jsdom测试字典__/.test(dialog().find('.el-dialog__title').text()));
    var opts = form().find('#sdParent option').map(function () { return $(this).val(); }).get();
    check('编辑时上级下拉排除自身', opts.indexOf(win.__newId) < 0, String(opts));
    form().find('#sdNameCn').val('__jsdom测试字典（改）');
    form().find('#sdSort').val('7');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    check('编辑后左区显示新名称',
        dictRowByName(/__jsdom测试字典（改）/).length === 1,
        $('#sdTbody').text().replace(/\s+/g, ' ').slice(0, 120));
    var $row = dictRowByName(/__jsdom测试字典（改）/);
    $row.trigger('click');
    $('#btnDisable').trigger('click');
});
step(function () {
    check('停用后该字典显示「停用」徽标',
        /停用/.test(dictRowByName(/__jsdom测试字典（改）/).text()),
        dictRowByName(/__jsdom测试字典（改）/).text().replace(/\s+/g, ' ').slice(0, 110));
    dictRowByName(/__jsdom测试字典（改）/).trigger('dblclick');   // 双击进入它（空字典）
});
step(function () {
    check('双击空字典后右区显示「该字典还没有键值」空态',
        $('#siCurrentDict').text() === '__jsdom测试字典（改）' &&
        /还没有键值/.test($('#siTbody').text()),
        $('#siCurrentDict').text() + ' / ' + $('#siTbody').text().slice(0, 60));
    check('空字典下右区仍可新增键值（新增按钮可用）',
        $('#btnItemAdd').prop('disabled') === false);
    $('#btnItemAdd').trigger('click');
});
step(function () {
    check('空字典新增键值时所属字典预填该字典',
        form().find('#siDict').val() === win.__newId, String(form().find('#siDict').val()));
    form().find('#siValue').val('第一条');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    check('新增后右区 1 条、左区键值数变 1',
        itemRows().length === 1 && dictCount(/__jsdom测试字典（改）/) === '1',
        String(itemRows().length) + '/' + dictCount(/__jsdom测试字典（改）/));
});

step(function () {
    console.log('\n--- 12. 删除字典（右区回空态 / 级联清理） ---');
    dictRowByName(/__jsdom测试字典（改）/).trigger('click');
    $('#btnDelete').trigger('click');
    check('删除当前字典时确认框提示会清理 1 条键值',
        msgBox().length === 1 && /1 条键值/.test(msgBox().text()),
        msgBox().text().replace(/\s+/g, ' ').slice(0, 110));
    msgBox().find('.btn-ok').trigger('click');
});
step(function () {
    check('删除后左区恢复 4 条', dictRows().length === 4, String(dictRows().length));
    check('删除的是当前字典 → 右区回到未选择空态',
        $('#siCurrentDict').text() === '未选择' &&
        /该字典已删除/.test($('#siTbody').text()) &&
        $('#btnItemAdd').prop('disabled') === true,
        $('#siCurrentDict').text() + ' / ' + $('#siTbody').text().slice(0, 60));
    Api.sysDictItem.page({ dictId: win.__newId }).done(function (d) {
        check('该字典的键值已被级联清理', int0(d.total) === 0, String(d.total));
    });
});

step(function () {
    dictRowByName(/用户性别/).trigger('dblclick');
});
step(function () {
    check('重新双击「用户性别」右区恢复 3 条', itemRows().length === 3, String(itemRows().length));
    dictRowByName(/用户性别/).trigger('click');
    $('#btnDelete').trigger('click');
    check('删除有 3 条键值的字典时确认框提示「3 条键值」',
        /3 条键值/.test(msgBox().text()), msgBox().text().replace(/\s+/g, ' ').slice(0, 120));
    msgBox().find('.btn-ok').trigger('click');
});
step(function () {
    check('级联删除后左区剩 3 条且不含用户性别',
        dictRows().length === 3 && !/用户性别/.test($('#sdTbody').text()), String(dictRows().length));
    Api.sysDictItem.page({ dictId: GENDER_ID }).done(function (d) {
        check('用户性别下 3 条键值已级联清理', int0(d.total) === 0, String(d.total));
    });
    Api.sysDictItem.page({}).done(function (d) {
        check('其它字典的键值不受影响（仍剩 3 条）', int0(d.total) === 3, String(d.total));
    });
    $('#btnRefresh').trigger('click');
});
step(function () {
    check('刷新后左区仍为 3 条', dictRows().length === 3, String(dictRows().length));
    check('父字典「基础配置」仍在（删子字典不误删父级）',
        dictRowByName(/基础配置/).length === 1);
});

next();
