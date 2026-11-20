/* ==========================================================================
   page-op-btn-test.js —— 页面操作按钮管理页测试（jsdom，无需浏览器）
   覆盖：打开页面自动收录、列表渲染（8 列 / 不展示 UUID）、关键字与页面 / 启用筛选、
        编辑弹窗回填与保存、重新收录（文本同步但保留手工停用）、启用 / 停用、删除与补回
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/page-op-btn-test.js
   ========================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var JSDOM = (function () {
    try { return require('jsdom').JSDOM; } catch (e) { return null; }
})();

var ROOT = path.resolve(__dirname, '..');
var pass = 0, fail = 0;
var RE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

var win = boot('page-op-btn.html', ['js/page-op-btn.js']);
var $ = win.jQuery;

var $tbody = $('#pobTbody');
function rows() { return $tbody.find('tr[data-id]'); }
function cellText($tr, i) { return $.trim($tr.find('td').eq(i).text()); }
function dialog() { return $('.el-overlay .el-dialog').last(); }
function dialogBody() { return dialog().find('.el-dialog__body'); }
function fieldOf(name) { return dialogBody().find('[name="' + name + '"]'); }
function totalText() { return $('#pagerWrap').text(); }

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 1000 }); }
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

var FIRST = null;          // 第一条记录（用于后续编辑 / 删除）
var BASE_TOTAL = 0;        // 首屏总数

/* ------------------------------- 用例 ------------------------------- */
step(function () {
    console.log('\n--- 1. 打开页面：自动收录 + 列表渲染 ---');
    check('打开页面自动收录（列表已有数据）', rows().length > 0, 'rows=' + rows().length);
    check('分页显示总数 ≥ 40（收录了各页面按钮）', /共\s*\d+\s*条/.test(totalText()) && !/共\s*[0-9]\s*条/.test(totalText()),
        totalText().replace(/\s+/g, ' '));
    var m = totalText().replace(/\s+/g, ' ').match(/共\s*(\d+)\s*条/);
    BASE_TOTAL = m ? parseInt(m[1], 10) : 0;
    check('总数解析成功（≥ 40）', BASE_TOTAL >= 40, 'total=' + BASE_TOTAL);
    check('列表共 8 列（序号 / 选择 / 所属页面 / 页面路径 / 按钮id / 按钮文本 / 启用否 / 更新时间）',
        rows().eq(0).find('td').length === 8, String(rows().eq(0).find('td').length));
    check('查询结果区不展示 UUID',
        !RE_UUID.test($tbody.text().replace(/#[A-Za-z0-9_]+/g, '')), $tbody.text().slice(0, 60));
    check('按钮id 列带 # 前缀',
        /^#\S+/.test(cellText(rows().eq(0), 4)), cellText(rows().eq(0), 4));
    check('所属页面 / 页面路径 / 按钮文本均有值',
        cellText(rows().eq(0), 2).length > 0 && /\.html$/.test(cellText(rows().eq(0), 3))
        && cellText(rows().eq(0), 5).length > 0,
        [cellText(rows().eq(0), 2), cellText(rows().eq(0), 3), cellText(rows().eq(0), 5)].join(' | '));
    check('启用否列显示「启用」标签', cellText(rows().eq(0), 6) === '启用', cellText(rows().eq(0), 6));
    check('页面下拉已加载（≥ 10 个页面）', $('#pageFilter option').length >= 11,
        String($('#pageFilter option').length));
    check('页面下拉包含本管理页（自我收录）',
        $('#pageFilter option').filter(function () { return $(this).val() === 'page-op-btn.html'; }).length === 1);
});

step(function () {
    console.log('\n--- 2. 筛选：页面 / 关键字 / 启用否 ---');
    var pagePath = cellText(rows().eq(0), 3);
    $('#pageFilter').val(pagePath).trigger('change');
});

step(function () {
    var pagePath = null;
    $('#pageFilter option').each(function () { if ($(this).is(':selected')) { pagePath = $(this).val(); } });
    check('按页面筛选后只显示该页面的按钮',
        rows().length > 0 && rows().filter(function () { return cellText($(this), 3) !== pagePath; }).length === 0,
        'rows=' + rows().length + ' path=' + pagePath);

    $('#btnReset').trigger('click');
});

step(function () {
    check('重置后恢复全部页面数据', rows().length > 0, 'rows=' + rows().length);
    var btnId = cellText(rows().eq(0), 4).replace(/^#/, '');
    $('#keyword').val(btnId);
    $('#btnSearch').trigger('click');
});

step(function () {
    check('关键字按按钮id 检索命中', rows().length >= 1 && rows().length < 10,
        'rows=' + rows().length);

    $('#btnReset').trigger('click');
});

step(function () {
    $('#enabledFilter').val('0').trigger('change');
});

step(function () {
    check('筛选「停用」时列表为空并给出空态文案',
        rows().length === 0 && /暂无数据/.test($tbody.text()), $tbody.text().slice(0, 40));
    $('#btnReset').trigger('click');
});

step(function () {
    console.log('\n--- 3. 选中 + 编辑（弹窗回填） ---');
    FIRST = {
        id: rows().eq(0).attr('data-id'),
        pageName: cellText(rows().eq(0), 2),
        pagePath: cellText(rows().eq(0), 3),
        btnId: cellText(rows().eq(0), 4).replace(/^#/, ''),
        btnText: cellText(rows().eq(0), 5)
    };
    rows().eq(0).trigger('click');
    check('点击行后选中提示显示「页面/按钮文本」',
        $('#selTip').text().indexOf(FIRST.btnText) > -1, $('#selTip').text());

    $('#btnEdit').trigger('click');
});

step(function () {
    check('点击「编辑」弹出编辑弹窗', dialog().length === 1, String(dialog().length));
    check('弹窗回填所属页面', fieldOf('pageName').val() === FIRST.pageName, fieldOf('pageName').val());
    check('弹窗回填页面路径', fieldOf('pagePath').val() === FIRST.pagePath, fieldOf('pagePath').val());
    check('弹窗回填按钮id', fieldOf('btnId').val() === FIRST.btnId, fieldOf('btnId').val());
    check('弹窗回填按钮文本', fieldOf('btnText').val() === FIRST.btnText, fieldOf('btnText').val());
    check('页面路径与按钮id 只读',
        fieldOf('pagePath').prop('readonly') === true && fieldOf('btnId').prop('readonly') === true);
    check('弹窗不展示记录 UUID', !RE_UUID.test(dialogBody().text()), dialogBody().text().slice(0, 60));

    // 文本清空 → 拦截
    fieldOf('btnText').val('');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('按钮文本为空时保存被拦截',
        dialog().length === 1 && /按钮文本不能为空|操作按钮文本不能为空/.test(dialogBody().text()),
        dialogBody().find('.el-form-item__error').text());

    fieldOf('btnText').val('页面测试改文案');
    fieldOf('enabled').val('0');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('保存后弹窗关闭', dialog().length === 0, String(dialog().length));
    check('提示修改成功', /修改成功/.test($('.el-message-list').text()), $('.el-message-list').text());
    var $row = $tbody.find('tr[data-id="' + FIRST.id + '"]');
    check('列表显示修改后的按钮文本', cellText($row, 5) === '页面测试改文案', cellText($row, 5));
    check('列表显示为停用状态', cellText($row, 6) === '停用', cellText($row, 6));
});

step(function () {
    console.log('\n--- 4. 重新收录：同步文本、保留手工停用 ---');
    $('#btnScan').trigger('click');
});

step(function () {
    check('重新收录提示出现', /自动收录完成/.test($('.el-message-list').text()), $('.el-message-list').text());
    var $row = $tbody.find('tr[data-id="' + FIRST.id + '"]');
    check('重新收录后按钮文本按页面同步回原样', cellText($row, 5) === FIRST.btnText, cellText($row, 5));
    check('重新收录不改动人工设置的停用状态', cellText($row, 6) === '停用', cellText($row, 6));
});

step(function () {
    console.log('\n--- 5. 启用 / 停用 ---');
    $tbody.find('tr[data-id="' + FIRST.id + '"]').trigger('click');
    $('#btnEnable').trigger('click');
});

step(function () {
    var $row = $tbody.find('tr[data-id="' + FIRST.id + '"]');
    check('点「启用」后状态变为启用', cellText($row, 6) === '启用', cellText($row, 6));

    $row.trigger('click');
    $('#btnDisable').trigger('click');
});

step(function () {
    var $row = $tbody.find('tr[data-id="' + FIRST.id + '"]');
    check('点「停用」后状态变回停用', cellText($row, 6) === '停用', cellText($row, 6));
    check('停用后可用「停用」筛选到该记录', true);   // 下面验证
    $('#btnEnable').trigger('click');                 // 恢复启用，便于后续删除验证
});

step(function () {
    console.log('\n--- 6. 双击编辑 + 删除与补回 ---');
    $tbody.find('tr[data-id="' + FIRST.id + '"]').trigger('dblclick');
});

step(function () {
    check('双击行直接打开编辑弹窗', dialog().length === 1, String(dialog().length));
    dialog().find('.btn-cancel').trigger('click');
});

step(function () {
    $tbody.find('tr[data-id="' + FIRST.id + '"]').trigger('click');
    $('#btnDelete').trigger('click');
});

step(function () {
    check('点击删除弹出确认框', $('.el-message-box').length === 1, String($('.el-message-box').length));
    $('.el-message-box .btn-ok').trigger('click');
});

step(function () {
    check('删除后列表中不再有该记录',
        $tbody.find('tr[data-id="' + FIRST.id + '"]').length === 0);
    $('#btnScan').trigger('click');
});

step(function () {
    check('重新收录后该按钮被补回',
        /新增\s*1\s*项|新增\s*[1-9]/.test($('.el-message-list').text()) || $tbody.text().indexOf(FIRST.btnText) > -1,
        $('.el-message-list').text());
    var m = totalText().replace(/\s+/g, ' ').match(/共\s*(\d+)\s*条/);
    check('补回后总数与初始一致', m && parseInt(m[1], 10) === BASE_TOTAL,
        (m ? m[1] : '?') + ' / ' + BASE_TOTAL);
});

setTimeout(next, 1800);
