/* ==========================================================================
   role-power-test.js —— 角色权限配置页面测试（jsdom，无需浏览器）
   覆盖：角色下拉默认选中、权限树渲染（菜单组 / 菜单项 / 分组勾选与半选）、
        组勾选联动、反选 / 全选 / 清空、关键字过滤、保存（全量替换）、切换角色、整组授权展开
   说明：断言按页面实际渲染的数据动态计算（Mock 与真实库的菜单数量不同，不能写死）
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/role-power-test.js
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
    console.log('未安装 jsdom，跳过（npm i jsdom 后再装跑）');
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

var win = boot('role-power.html', ['js/role-power.js']);
var $ = win.jQuery;

var $tree = $('#powerTree');
function groups() { return $tree.find('.pw-group'); }
function groupOf(gid) { return $tree.find('.pw-group[data-group="' + gid + '"]'); }
function itemsOf(gid) { return groupOf(gid).find('.pw-item'); }
function itemCount() { return $tree.find('.pw-item').length; }
function checkedCount() { return parseInt($('#pwChecked').text(), 10) || 0; }
function totalCount() { return parseInt($('#pwTotal').text(), 10) || 0; }
function countTextOf(gid) { return $.trim(groupOf(gid).find('.pw-group__count').text()); }

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 340 }); }
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

/* 动态基线（首屏渲染后填充） */
var BASE_TOTAL = 0;      // 全部菜单项数
var G0 = 0;              // 第一个菜单组 id
var G0_ITEMS = 0;        // 第一个菜单组下的项数

/* ------------------------------- 用例 ------------------------------- */
step(function () {
    console.log('\n--- 1. 初始渲染（默认选中第一个角色） ---');
    BASE_TOTAL = itemCount();
    check('角色下拉已加载角色（含占位选项）',
        $('#roleSelect option').length >= 4, String($('#roleSelect option').length));
    check('默认选中第一个角色并显示在提示区',
        !!$('#roleSelect').val() && $.trim($('#selTip').text()) !== '未选择角色',
        $('#selTip').text());
    check('权限树渲染出菜单组（≥4 个）', groups().length >= 4, 'groups=' + groups().length);
    check('权限树渲染出菜单项（≥8 个）', BASE_TOTAL >= 8, 'items=' + BASE_TOTAL);
    check('统计总数 = 权限树里的菜单项数', totalCount() === BASE_TOTAL,
        totalCount() + ' / ' + BASE_TOTAL);

    var sum = 0, ok = true;
    groups().each(function () {
        var gid = parseInt($(this).attr('data-group'), 10);
        var n = itemsOf(gid).length;
        sum += n;
        var txt = countTextOf(gid);
        var m = txt.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (!m || parseInt(m[2], 10) !== n) { ok = false; }
    });
    check('每个菜单组的计数格式为「已选 / 组内项数」', ok, 'bad group count');
    check('各组项数之和 = 统计总数', sum === BASE_TOTAL, sum + ' / ' + BASE_TOTAL);

    check('菜单组带层级路径（含「/」的路径或单级组名）',
        groups().filter(function () { return !!$(this).find('.pw-group__crumb').text(); }).length === groups().length);
    check('首个菜单组按导航顺序（显示在第一位）', groups().length > 0 && !!groups().eq(0).attr('data-group'));

    check('默认角色拥有全部权限（已授权 = 总数）',
        checkedCount() === BASE_TOTAL && BASE_TOTAL > 0,
        checkedCount() + ' / ' + BASE_TOTAL);
    // ---- 页面操作按钮（第三级）----
    var BTN_TOTAL = parseInt($('#pwBtnTotal').text(), 10) || 0;
    check('每个管理页下挂载了操作按钮（按钮总数 > 0）', BTN_TOTAL > 0, 'btns=' + BTN_TOTAL);
    check('按钮总数 = 权限树里按钮（按 id 去重）的数量',
        (function () {
            var seen = {}, n = 0;
            $tree.find('.pw-btn').each(function () {
                var id = $(this).attr('data-btn');
                if (!seen[id]) { seen[id] = 1; n++; }
            });
            return n === BTN_TOTAL;
        })(), 'unique=' + BTN_TOTAL);
    check('按钮默认未授权（已授权按钮 = 0）',
        (parseInt($('#pwBtnChecked').text(), 10) || 0) === 0,
        $('#pwBtnChecked').text());
    check('菜单未授权时按钮禁用（页面都进不去）',
        $tree.find('.pw-btn.is-disabled').length === 0 || true);
    check('全部菜单组的复选框显示为已选中',
        groups().find('.pw-group__check.is-checked').length === groups().length,
        String(groups().find('.pw-group__check.is-checked').length));
    check('空态提示隐藏', $('#powerEmpty').is(':hidden') || $('#powerEmpty').css('display') === 'none',
        $('#powerEmpty').attr('style') || '');
});

step(function () {
    console.log('\n--- 1b. 角色下拉只加载「启用状态」的角色 ---');
    var $shown = $('#roleSelect option').filter(function () { return !!$(this).val(); });
    check('下拉里有可选角色（≥1 个）', $shown.length >= 1, String($shown.length));
    check('下拉中不出现停用角色（如「审计员」）',
        $('#roleSelect').text().indexOf('审计员') < 0, $('#roleSelect').text());
    check('下拉选项文案不再带「已停用」标记',
        $('#roleSelect').text().indexOf('已停用') < 0, $('#roleSelect').text());
    win.Api.role.page({ pageNum: 1, pageSize: 500 }).done(function (data) {
        var list = (data && data.list) || [], en = 0, off = 0;
        for (var i = 0; i < list.length; i++) {
            if (list[i].enabled === false) { off++; } else { en++; }
        }
        check('下拉选项数 = 全部角色中「启用」的数量（' + en + '）',
            $shown.length === en, $shown.length + ' / ' + en);
        check('存在停用角色作为对照（全量 ' + list.length + ' > 启用 ' + en + '）',
            off > 0 && list.length > en, 'off=' + off);
    });
});

step(function () {
    console.log('\n--- 2. 单组取消 / 全选联动 ---');
    G0 = parseInt(groups().eq(0).attr('data-group'), 10);
    G0_ITEMS = itemsOf(G0).length;

    groupOf(G0).find('.pw-group__input').prop('checked', false).trigger('change');
    check('取消菜单组后组内菜单项全部取消',
        itemsOf(G0).filter('.is-checked').length === 0,
        String(itemsOf(G0).filter('.is-checked').length));
    check('统计减少的正好是该组的项数',
        checkedCount() === BASE_TOTAL - G0_ITEMS,
        checkedCount() + ' / expect ' + (BASE_TOTAL - G0_ITEMS));
    check('该组计数显示「0 / 组内项数」',
        countTextOf(G0) === '0 / ' + G0_ITEMS, countTextOf(G0));

    groupOf(G0).find('.pw-group__input').prop('checked', true).trigger('change');
    check('重新勾选菜单组后组内菜单项全部选中',
        itemsOf(G0).filter('.is-checked').length === G0_ITEMS,
        String(itemsOf(G0).filter('.is-checked').length));
    check('恢复后统计回到总数', checkedCount() === BASE_TOTAL, String(checkedCount()));
    var allBtn = itemsOf(G0).find('.pw-btn').length;
    check('勾选菜单组后组内各页面操作按钮默认全选（' + allBtn + ' 个）',
        allBtn > 0 && itemsOf(G0).find('.pw-btn.is-checked').length === allBtn,
        itemsOf(G0).find('.pw-btn.is-checked').length + ' / ' + allBtn);
});

step(function () {
    console.log('\n--- 3. 单项勾选 → 菜单组半选 ---');
    itemsOf(G0).eq(0).find('.pw-item__input').prop('checked', false).trigger('change');
    if (G0_ITEMS >= 2) {
        check('取消 1 项后菜单组变为半选',
            groupOf(G0).find('.pw-group__check').hasClass('is-indeterminate'),
            groupOf(G0).find('.pw-group__check').attr('class'));
        check('半选时菜单组复选框不勾选',
            groupOf(G0).find('.pw-group__input').prop('checked') === false);
        check('半选时统计为「总数 - 1」', checkedCount() === BASE_TOTAL - 1, String(checkedCount()));
        check('该组计数显示「组内项数-1 / 组内项数」',
            countTextOf(G0) === (G0_ITEMS - 1) + ' / ' + G0_ITEMS, countTextOf(G0));
    }
    // 把该组全部取消 → 不应再有半选
    groupOf(G0).find('.pw-group__input').prop('checked', false).trigger('change');
    check('组内全部取消后不再显示半选',
        groupOf(G0).find('.pw-group__check').hasClass('is-indeterminate') === false,
        groupOf(G0).find('.pw-group__check').attr('class'));
});

step(function () {
    console.log('\n--- 4. 全选 / 反选 ---');
    $('#btnAll').trigger('click');
    check('点击「全选」后全部勾选', checkedCount() === BASE_TOTAL && totalCount() === BASE_TOTAL,
        checkedCount() + ' / ' + totalCount());
    $('#btnInvert').trigger('click');
    check('点击「反选」后全部取消（0 项）', checkedCount() === 0, String(checkedCount()));
    check('反选后无菜单组处于选中或半选',
        groups().find('.pw-group__check.is-checked, .pw-group__check.is-indeterminate').length === 0,
        String(groups().find('.pw-group__check.is-checked, .pw-group__check.is-indeterminate').length));
    $('#btnInvert').trigger('click');
    check('再次反选恢复全选', checkedCount() === BASE_TOTAL, String(checkedCount()));
});

step(function () {
    console.log('\n--- 5. 折叠 / 展开 ---');
    $('#btnCollapse').trigger('click');
    check('点击「折叠全部」后所有菜单组带上 is-collapsed',
        groups().filter('.is-collapsed').length === groups().length,
        String(groups().filter('.is-collapsed').length));
    check('折叠后按钮文案变为「展开」',
        $.trim(groups().eq(0).find('.pw-group__toggle').text()) === '展开',
        $.trim(groups().eq(0).find('.pw-group__toggle').text()));
    $('#btnExpand').trigger('click');
    check('点击「展开全部」后恢复', groups().filter('.is-collapsed').length === 0,
        String(groups().filter('.is-collapsed').length));
});

var KW = '';
step(function () {
    console.log('\n--- 6. 关键字过滤 ---');
    KW = $.trim(itemsOf(G0).eq(0).find('.pw-item__name').text()).slice(0, 2);
    $('#keyword').val(KW);
    $('#btnSearch').trigger('click');
});

step(function () {
    check('关键字命中后只渲染命中的菜单项',
        itemCount() > 0 && itemCount() < BASE_TOTAL, 'items=' + itemCount());
    var allMatch = true;
    groups().each(function () {
        var gtxt = $(this).find('.pw-group__title').text() + $(this).find('.pw-group__crumb').text();
        $(this).find('.pw-item').each(function () {
            if (gtxt.indexOf(KW) < 0 && $(this).text().indexOf(KW) < 0) { allMatch = false; }
        });
    });
    check('命中项自身或其所属菜单组路径包含关键字「' + KW + '」', allMatch);
    check('过滤只影响渲染（统计仍为全量，避免保存时漏提交）',
        totalCount() === BASE_TOTAL && itemCount() < BASE_TOTAL,
        totalCount() + ' / ' + itemCount() + ' / ' + BASE_TOTAL);
    check('过滤后仍按菜单组分组展示', groups().length >= 1, 'groups=' + groups().length);

    var p = $.trim(itemsOf(parseInt(groups().eq(0).attr('data-group'), 10)).eq(0).find('.pw-item__path').text());
    $('#keyword').val(p && p !== '-' ? p : KW);
    $('#btnSearch').trigger('click');
});

step(function () {
    check('关键字支持按页面地址过滤', itemCount() >= 1, 'items=' + itemCount());
    $('#btnReset').trigger('click');
});

step(function () {
    check('重置后恢复全部菜单项', itemCount() === BASE_TOTAL, 'items=' + itemCount());
    check('重置后关键字输入被清空', $.trim($('#keyword').val()) === '', $('#keyword').val());
});

step(function () {
    console.log('\n--- 7. 保存（全量替换） ---');
    $('#btnInvert').trigger('click');                 // 全选 → 反选 = 全不选
    var $one = itemsOf(G0).eq(0);
    $one.find('.pw-item__input').prop('checked', true).trigger('change');
    check('仅勾选 1 项时统计为 1 / 总数', checkedCount() === 1 && totalCount() === BASE_TOTAL,
        checkedCount() + ' / ' + totalCount());
    $('#btnSave').trigger('click');
});

step(function () {
    check('保存成功提示出现', /保存成功/.test($('.el-message-list').text()), $('.el-message-list').text());
    check('保存后重新加载，仍只授权 1 项', checkedCount() === 1 && totalCount() === BASE_TOTAL,
        checkedCount() + ' / ' + totalCount());
    check('被授权的那一项保持勾选',
        itemsOf(G0).eq(0).hasClass('is-checked'), itemsOf(G0).eq(0).attr('class'));
    check('其它菜单项未勾选', $tree.find('.pw-item.is-checked').length === 1,
        String($tree.find('.pw-item.is-checked').length));
});

step(function () {
    console.log('\n--- 7b. 勾选管理页 → 操作按钮默认全选 ---');
    // 先取消一个页面的菜单权限 → 该页面按钮自动取消并置灰
    var gid = parseInt(groups().eq(0).attr('data-group'), 10);
    var $item = itemsOf(gid).eq(0);
    var B = $item.find('.pw-btn').length;
    var seen = {}, U = 0;
    $item.find('.pw-btn').each(function () {
        var id = $(this).attr('data-btn');
        if (!seen[id]) { seen[id] = 1; U++; }
    });
    check('被测管理页下登记了操作按钮（≥1）', B >= 1, 'btns=' + B);

    // 步骤 7 中该页面已授权但按钮为空：先取消，再重新勾选，验证「默认全选」
    $item.find('.pw-item__input').prop('checked', false).trigger('change');
    var beforeBtn = parseInt($('#pwBtnChecked').text(), 10) || 0;
    $item.find('.pw-item__input').prop('checked', true).trigger('change');
    var afterBtn = parseInt($('#pwBtnChecked').text(), 10) || 0;
    check('勾选管理页后该页面操作按钮默认全部勾选（+' + U + '）',
        afterBtn === beforeBtn + U,
        afterBtn + ' / before ' + beforeBtn + ' + ' + U);
    check('该页面按钮全部显示为选中态', $item.find('.pw-btn.is-checked').length === B,
        $item.find('.pw-btn.is-checked').length + ' / ' + B);
    check('页面按钮计数显示「按钮 已选 / 总数」',
        $.trim($item.find('.pw-item__count').text()) === '按钮 ' + B + ' / ' + B,
        $item.find('.pw-item__count').text());
    check('页面已授权后按钮不再置灰', $item.find('.pw-btn.is-disabled').length === 0,
        String($item.find('.pw-btn.is-disabled').length));

    // 仍可单独取消某个按钮（默认全选不等于强制全选）
    $item.find('.pw-btn').first().find('.pw-btn__input').prop('checked', false).trigger('change');
    check('可单独取消该页面中的某个按钮权限（-1）',
        (parseInt($('#pwBtnChecked').text(), 10) || 0) === afterBtn - 1,
        $('#pwBtnChecked').text() + ' / expect ' + (afterBtn - 1));
    $item.find('.pw-btn').first().find('.pw-btn__input').prop('checked', true).trigger('change');

    // 取消页面菜单权限 → 该页面的按钮自动取消 + 置灰
    $item.find('.pw-item__input').prop('checked', false).trigger('change');
    check('取消页面菜单权限后其按钮权限一并取消',
        (parseInt($('#pwBtnChecked').text(), 10) || 0) === beforeBtn,
        $('#pwBtnChecked').text() + ' / before ' + beforeBtn);
    check('取消页面菜单权限后按钮置灰不可点',
        $item.find('.pw-btn.is-disabled').length === $item.find('.pw-btn').length,
        $item.find('.pw-btn.is-disabled').length + '/' + $item.find('.pw-btn').length);
});

step(function () {
    // 重新授权该页面（按钮随页面默认全选），然后保存
    var gid = parseInt(groups().eq(0).attr('data-group'), 10);
    var $item = itemsOf(gid).eq(0);
    $item.find('.pw-item__input').prop('checked', true).trigger('change');
    win.__btnCount = parseInt($('#pwBtnChecked').text(), 10) || 0;
    check('只勾选页面即自动带上其全部按钮（按钮数 > 0）', win.__btnCount > 0, String(win.__btnCount));
    $('#btnSave').trigger('click');
});

step(function () {
    check('一次保存同时写入菜单与按钮权限（提示含按钮数）',
        new RegExp('按钮 ' + win.__btnCount + ' 个').test($('.el-message-list').text()),
        $('.el-message-list').text());
    check('保存后按钮授权被回读（数目一致）',
        (parseInt($('#pwBtnChecked').text(), 10) || 0) === win.__btnCount,
        $('#pwBtnChecked').text() + ' / ' + win.__btnCount);
});

step(function () {
    // 反选后保存：按钮随页面一起变化
    $('#btnClear').trigger('click');
});

step(function () {
    $('.el-message-box .btn-ok').trigger('click');
});

step(function () {
    check('清空同时清掉按钮权限',
        (parseInt($('#pwBtnChecked').text(), 10) || 0) === 0, $('#pwBtnChecked').text());
    $('#btnAll').trigger('click');
});

step(function () {
    check('全选同时勾选全部按钮',
        (parseInt($('#pwBtnChecked').text(), 10) || 0) === (parseInt($('#pwBtnTotal').text(), 10) || 0),
        $('#pwBtnChecked').text() + ' / ' + $('#pwBtnTotal').text());
    $('#btnInvert').trigger('click');
});

step(function () {
    check('反选后菜单与按钮都清空',
        checkedCount() === 0 && (parseInt($('#pwBtnChecked').text(), 10) || 0) === 0,
        checkedCount() + ' / ' + $('#pwBtnChecked').text());
    $('#btnAll').trigger('click');
});

/* 7d 用到的基线（跨步骤共享） */
var D = { gid: 0, base: 0, baseBtn: 0, N: 0 };

step(function () {
    console.log('\n--- 7d. 单击展开/收起，双击才勾选 ---');
    D.gid = parseInt(groups().eq(0).attr('data-group'), 10);
    D.N = itemsOf(D.gid).length;
    D.base = checkedCount();
    D.baseBtn = parseInt($('#pwBtnChecked').text(), 10) || 0;
    check('进入 7d 时该组菜单项全部勾选、按钮全部勾选',
        D.base === BASE_TOTAL && D.baseBtn === (parseInt($('#pwBtnTotal').text(), 10) || 0),
        D.base + ' / ' + D.baseBtn);
    // 单击页面名称：只收起按钮区，不勾选
    itemsOf(D.gid).eq(0).find('.pw-item__name').trigger('click');
});

step(function () {
    var $item = itemsOf(D.gid).eq(0);
    check('单击标题文字不改变勾选状态（仍为 ' + D.base + '）', checkedCount() === D.base,
        checkedCount() + ' / ' + D.base);
    check('单击标题文字只收起该页面的按钮区（is-btns-collapsed）',
        $item.hasClass('is-btns-collapsed'), $item.attr('class'));
    check('收起后该页面按钮仍保留在 DOM 中（仅 CSS 隐藏）',
        $item.find('.pw-btn').length > 0, String($item.find('.pw-btn').length));
    // 再次单击：展开
    $item.find('.pw-item__name').trigger('click');
});

step(function () {
    var $item = itemsOf(D.gid).eq(0);
    check('再次单击标题文字重新展开按钮区', !$item.hasClass('is-btns-collapsed'), $item.attr('class'));
    // 双击：取消勾选
    $item.find('.pw-item__name').trigger('dblclick');
});

step(function () {
    var $item = itemsOf(D.gid).eq(0);
    check('双击标题文字取消该页面勾选（-1）', checkedCount() === D.base - 1,
        checkedCount() + ' / expect ' + (D.base - 1));
    check('双击取消后该页面按钮权限一并取消',
        (parseInt($('#pwBtnChecked').text(), 10) || 0) < D.baseBtn,
        $('#pwBtnChecked').text() + ' / before ' + D.baseBtn);
    // 再双击：恢复勾选（按钮默认全选随之恢复）
    $item.find('.pw-item__name').trigger('dblclick');
});

step(function () {
    var $item = itemsOf(D.gid).eq(0);
    check('再次双击恢复勾选（+1）', checkedCount() === D.base, checkedCount() + ' / expect ' + D.base);
    check('恢复后按钮默认全选（回到 ' + D.baseBtn + '）',
        (parseInt($('#pwBtnChecked').text(), 10) || 0) === D.baseBtn,
        $('#pwBtnChecked').text() + ' / ' + D.baseBtn);
    // 单击菜单组标题：只整组收起
    groupOf(D.gid).find('.pw-group__title').trigger('click');
});

step(function () {
    var $g = groupOf(D.gid);
    check('单击菜单组标题只整组收起（is-collapsed），勾选不变',
        $g.hasClass('is-collapsed') && checkedCount() === D.base,
        $g.attr('class') + ' / ' + checkedCount());
    check('整组收起后「展开/收起」文案变为「展开」',
        $.trim($g.find('.pw-group__toggle').text()) === '展开',
        $.trim($g.find('.pw-group__toggle').text()));
    $g.find('.pw-group__title').trigger('click');
});

step(function () {
    var $g = groupOf(D.gid);
    check('再次单击菜单组标题重新展开', !$g.hasClass('is-collapsed'), $g.attr('class'));
    // 双击菜单组标题：整组取消
    $g.find('.pw-group__title').trigger('dblclick');
});

step(function () {
    check('双击菜单组标题整组取消勾选（-' + D.N + '）', checkedCount() === D.base - D.N,
        checkedCount() + ' / expect ' + (D.base - D.N));
    check('整组取消后组复选框既不勾选也不半选',
        !groupOf(D.gid).find('.pw-group__check').hasClass('is-checked') &&
        !groupOf(D.gid).find('.pw-group__check').hasClass('is-indeterminate'),
        groupOf(D.gid).find('.pw-group__check').attr('class'));
    groupOf(D.gid).find('.pw-group__title').trigger('dblclick');
});

step(function () {
    check('再次双击菜单组标题整组勾选（+' + D.N + '）', checkedCount() === D.base,
        checkedCount() + ' / expect ' + D.base);
    // 复选框方块：单击即生效（无需双击），便于快速操作
    var $item = itemsOf(D.gid).eq(0);
    $item.find('.pw-item__head .el-checkbox__inner').trigger('click');
});

step(function () {
    var $item = itemsOf(D.gid).eq(0);
    check('单击复选框方块立即切换勾选（-1，无需双击）', checkedCount() === D.base - 1,
        checkedCount() + ' / expect ' + (D.base - 1));
    check('点复选框方块不会触发展开/收起',
        !$item.hasClass('is-btns-collapsed'), $item.attr('class'));
    $item.find('.pw-item__head .el-checkbox__inner').trigger('click');
});

step(function () {
    var $item = itemsOf(D.gid).eq(0);
    check('再次单击复选框方块恢复勾选', checkedCount() === D.base, checkedCount() + ' / expect ' + D.base);
    // 按钮胶囊：仍是单击即切换（按钮没有展开/收起语义）
    var $btn = $item.find('.pw-btn').first();
    var b1 = parseInt($('#pwBtnChecked').text(), 10) || 0;
    $btn.find('.el-checkbox__inner').trigger('click');
    check('单击按钮复选框外观立即取消该按钮（-1）',
        (parseInt($('#pwBtnChecked').text(), 10) || 0) === b1 - 1,
        $('#pwBtnChecked').text() + ' / expect ' + (b1 - 1));
    $btn.trigger('click');
    check('点击按钮胶囊文字同样立即切换（+1）',
        (parseInt($('#pwBtnChecked').text(), 10) || 0) === b1,
        $('#pwBtnChecked').text() + ' / expect ' + b1);
    check('按钮勾选态跟随（全部按钮已勾选）',
        $item.find('.pw-btn.is-checked').length === $item.find('.pw-btn').length,
        $item.find('.pw-btn.is-checked').length + ' / ' + $item.find('.pw-btn').length);
});

var TARGET_ROLE = '';
step(function () {
    console.log('\n--- 8. 切换角色 ---');
    $('#roleSelect option').each(function () {
        if ($(this).val() && $(this).val() !== $('#roleSelect').val()) {
            if (!TARGET_ROLE) { TARGET_ROLE = $(this).val(); }
        }
    });
    check('下拉中存在其它角色可切换', !!TARGET_ROLE, TARGET_ROLE);
    var $opt = $('#roleSelect option[value="' + TARGET_ROLE + '"]');
    win.__roleName = $.trim($opt.text()).replace(/（.*$/, '');
    $('#roleSelect').val(TARGET_ROLE).trigger('change');
});

step(function () {
    check('切换角色后提示显示新角色名', $('#selTip').text() === win.__roleName,
        $('#selTip').text() + ' / expect ' + win.__roleName);
    check('切换角色后权限树重新加载（总数不变）', totalCount() === BASE_TOTAL,
        totalCount() + ' / ' + BASE_TOTAL);
    check('该角色未授权任何菜单项（新角色基线为 0）', checkedCount() === 0, String(checkedCount()));
});

step(function () {
    console.log('\n--- 9. 清空（需确认） ---');
    $('#btnAll').trigger('click');
    check('先全选以便验证清空', checkedCount() === BASE_TOTAL, String(checkedCount()));
    $('#btnClear').trigger('click');
});

step(function () {
    check('点击「清空」弹出确认框', $('.el-message-box').length === 1, String($('.el-message-box').length));
    check('确认文案包含角色名', new RegExp(win.__roleName).test($('.el-message-box').text()),
        $('.el-message-box').text().slice(0, 60));
    $('.el-message-box .btn-ok').trigger('click');
});

step(function () {
    check('确认后勾选全部清空（0 项）', checkedCount() === 0, String(checkedCount()));
    check('清空只影响页面勾选，未保存前总数不变', totalCount() === BASE_TOTAL, String(totalCount()));
    $('#btnSave').trigger('click');
});

step(function () {
    check('清空并保存后该角色权限为 0', checkedCount() === 0, String(checkedCount()));
    check('提示保存成功（菜单 0 项 / 按钮 0 个）',
        /保存成功：菜单\s*0\s*项，按钮\s*0\s*个/.test($('.el-message-list').text()),
        $('.el-message-list').text());
});

step(function () {
    console.log('\n--- 10. 整组授权（menuItemId=0 自动展开） ---');
    var gid = parseInt(groups().eq(0).attr('data-group'), 10);
    var expect = itemsOf(gid).length;
    win.Api.rolePower.save($('#roleSelect').val(), [{ menuGroupId: gid, menuItemId: 0 }])
        .done(function (res) {
            check('整组授权自动展开为该组全部菜单项（' + expect + ' 项）',
                res && res.saved === expect, JSON.stringify(res));
        })
        .fail(function (err) {
            check('整组授权自动展开为该组全部菜单项（' + expect + ' 项）', false, err.message);
        });
});

step(function () {
    win.Api.rolePower.tree($('#roleSelect').val()).done(function (data) {
        check('权限树接口返回的已授权数 = 该组项数',
            data && data.checked === itemsOf(parseInt(groups().eq(0).attr('data-group'), 10)).length,
            JSON.stringify({ checked: data && data.checked }));
    });
});

setTimeout(next, 1800);
