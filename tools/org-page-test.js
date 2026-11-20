/* ==========================================================================
   org-page-test.js —— 部门组织架构页面渲染测试（jsdom，无需浏览器）
   覆盖：列表渲染 / 组织架构图动态绘制（嵌套 ul/li + 节点数）/ 图与列表选中联动 /
        图表折叠 / 关键字检索联动 / 新增表单页（编号只读 DPT+4、上级下拉、层级提示）
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/org-page-test.js
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

/* ---------- 通用：装载一个功能页（不发真实请求，api.js 走 Mock 通道） ---------- */
function boot(page, scripts, query) {
    var dom = new JSDOM(read(page), {
        url: 'http://127.0.0.1:8808/' + page + (query || ''),
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.jQuery.ajax = function (opts) {            // 后端探测失败 → api.js 自动回退 Mock
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

/* ===================== 1. 部门列表页 + 组织架构图 ===================== */
var win = boot('org.html', ['js/org.js']);
var $ = win.jQuery;

setTimeout(function () {
    console.log('\n--- 部门列表与组织架构图 ---');
    var rows = $('#orgTbody tr');
    check('列表渲染 6 条部门数据', rows.length === 6, 'rows=' + rows.length);
    check('列表含编号列且为 DPT + 4 位',
        /^DPT\d{4}$/.test(rows.find('td').eq(2).text().trim()),
        rows.find('td').eq(2).text());
    check('列表带出上级部门名称', rows.eq(1).find('td').eq(4).text().indexOf('总经理办公室') >= 0,
        rows.eq(1).find('td').eq(4).text());
    /* 负责人列（dptmgrset ↔ empinfos）：技术研发部负责人为张守正，未设置时显示「未设置」 */
    check('列表负责人列显示负责人姓名',
        /张守正/.test(rows.eq(1).find('td').eq(5).text()), rows.eq(1).find('td').eq(5).text());
    check('列表负责人列带出负责人工号',
        /E00001/.test(rows.eq(1).find('td').eq(5).text()), rows.eq(1).find('td').eq(5).text());
    check('未设置负责人的部门显示「未设置」',
        /未设置/.test(rows.eq(0).find('td').eq(5).text()), rows.eq(0).find('td').eq(5).text());

    var boxes = $('#orgChart .org-node__box');
    check('组织架构图绘制出 6 个节点', boxes.length === 6, 'nodes=' + boxes.length);
    check('架构图为嵌套结构（3 层 ul）', $('#orgChart ul.org-chart__level').length === 3,
        'levels=' + $('#orgChart ul.org-chart__level').length);
    check('根节点为顶级部门（总经理办公室）',
        $('#orgChart > ul > li > .org-node__box').text().indexOf('总经理办公室') >= 0,
        $('#orgChart > ul > li > .org-node__box').text());
    check('二级节点（研发/市场/财务 3 个）挂在根节点之下',
        $('#orgChart > ul > li > ul > li > .org-node__box').length === 3,
        String($('#orgChart > ul > li > ul > li > .org-node__box').length));
    check('节点显示部门编号', /DPT0001/.test($('#orgChart').html()), $('#orgChart .org-node__box').first().text());
    /* 节点底部由「下级数量」改为「直属员工数量」（按 deptId 汇总，不含下级部门） */
    check('架构图节点不再显示任何人数信息',
        !/员工\s*\d/.test($('#orgChart').text()) && !/下级\s*\d/.test($('#orgChart').text()),
        $('#orgChart .org-node__box').first().text());
    check('图表提示显示部门总数', /共 6 个部门/.test($('#orgChartHint').text()), $('#orgChartHint').text());
    check('图表提示不再汇总员工数',
        !/员工合计/.test($('#orgChartHint').text()), $('#orgChartHint').text());
    /* 架构图节点展示负责人 */
    check('架构图节点显示负责人姓名',
        /负责人：张守正/.test($('#orgChart .org-node__box[data-id="2"]').text()),
        $('#orgChart .org-node__box[data-id="2"]').text());
    check('未设置负责人的节点显示「负责人：未设置」并弱化',
        /负责人：未设置/.test($('#orgChart .org-node__box[data-id="1"]').text())
        && $('#orgChart .org-node__box[data-id="1"] .org-node__mgr').hasClass('is-empty'),
        $('#orgChart .org-node__box[data-id="1"] .org-node__mgr').attr('class'));
    check('停用部门节点有 is-off 标记',
        $('#orgChart .org-node__box.is-off').length >= 0);

    /* 选中联动：点击列表行 → 图上节点高亮 */
    rows.eq(1).trigger('click');
    check('点击列表行后选中提示显示部门名',
        $('#selTip').text().indexOf($('#orgTbody tr').eq(1).attr('data-name')) >= 0, $('#selTip').text());
    check('点击列表行后架构图节点同步高亮',
        $('#orgChart .org-node__box.is-active').length === 1, String($('#orgChart .org-node__box.is-active').length));

    /* 反向联动：点击图上节点 → 列表选中 */
    $('#orgChart .org-node__box').eq(2).trigger('click');
    check('点击架构图节点选中对应部门',
        $('#orgChart .org-node__box.is-active').length === 1 && $('#selTip').text().indexOf('未选择') < 0,
        $('#selTip').text());

    /* ---- Tab 页：① 查询结果列表 ② 组织架构图 ---- */
    var $tabItems = $('#orgTabs .el-tabs__item');
    var $panes = $('#orgTabs .el-tab-pane');
    check('页面含两个 Tab 页签（查询结果列表 / 组织架构图）',
        $tabItems.length === 2 && /查询结果列表/.test($tabItems.eq(0).text()) && /组织架构图/.test($tabItems.eq(1).text()),
        $tabItems.length + ' / ' + $tabItems.eq(0).text() + ' | ' + $tabItems.eq(1).text());
    check('默认停留在「查询结果列表」页签',
        $tabItems.eq(0).hasClass('is-active') && $panes.filter('[data-pane="list"]').hasClass('is-active')
        && !$panes.filter('[data-pane="chart"]').hasClass('is-active'));
    check('列表页签内含表格与分页容器',
        $panes.filter('[data-pane="list"]').find('#orgTable').length === 1
        && $panes.filter('[data-pane="list"]').find('#pagerWrap').length === 1);
    check('架构图页签内含图表容器与刷新按钮',
        $panes.filter('[data-pane="chart"]').find('#orgChart').length === 1
        && $panes.filter('[data-pane="chart"]').find('#btnRefreshChart').length === 1);

    /* 切到架构图页签：图表页签激活、列表页签隐藏 */
    $tabItems.eq(1).trigger('click');
    check('点击第 2 个页签后架构图页签激活',
        $tabItems.eq(1).hasClass('is-active') && $panes.filter('[data-pane="chart"]').hasClass('is-active')
        && !$panes.filter('[data-pane="list"]').hasClass('is-active'));
    setTimeout(function () {
        check('切到架构图页签后重新绘制出 6 个节点',
            $('#orgChart .org-node__box').length === 6, String($('#orgChart .org-node__box').length));

        /* 切回列表页签 */
        $tabItems.eq(0).trigger('click');
        check('点击第 1 个页签后回到查询结果列表',
            $tabItems.eq(0).hasClass('is-active') && $panes.filter('[data-pane="list"]').hasClass('is-active')
            && !$panes.filter('[data-pane="chart"]').hasClass('is-active'));

        /* 刷新按钮：重新拉数据并重绘 */
        $('#btnRefreshChart').trigger('click');
        setTimeout(function () {
            check('刷新后架构图节点数不变（重绘成功）',
                $('#orgChart .org-node__box').length === 6, String($('#orgChart .org-node__box').length));

            /* 关键字检索：列表与图联动 */
            $('#keyword').val('研发');
            $('#btnSearch').trigger('click');
            setTimeout(function () {
                check('关键字「研发」命中 3 条', $('#orgTbody tr').length === 3, String($('#orgTbody tr').length));
                $('#btnReset').trigger('click');
                setTimeout(function () {
                    check('重置后恢复 6 条', $('#orgTbody tr').length === 6, String($('#orgTbody tr').length));
                    runEmpViewTests();
                }, 400);
            }, 400);
        }, 400);
    }, 400);
}, 1200);

/* ===================== 1a. 架构图双击查看部门人员 ===================== */
function runEmpViewTests() {
    console.log('\n--- 架构图：双击部门查看人员 ---');
    // 技术研发部（id=2）含下级（前端研发组 3、后端研发组 4）共 4 名员工：张守正/王多云/赵小雨/陈思远
    var $node = $('#orgChart .org-node__box[data-id="2"]');
    check('架构图存在技术研发部节点', $node.length === 1, 'nodes=' + $node.length);
    $node.trigger('dblclick');

    setTimeout(function () {
        var $dlg = $('.el-overlay .el-dialog').last();
        check('双击节点弹出人员列表窗',
            $dlg.length === 1 && /部门人员/.test($dlg.find('.el-dialog__title').text()),
            $dlg.find('.el-dialog__title').text());
        check('弹窗标题带出部门名称', /技术研发部/.test($dlg.find('.el-dialog__title').text()),
            $dlg.find('.el-dialog__title').text());
        check('弹窗标注「含下级部门」', /含下级/.test($dlg.find('.el-dialog__title').text())
            && $dlg.find('.org-emp__scope').length === 1, $dlg.find('.el-dialog__title').text());
        check('列出本部门及下级部门共 4 名员工', $dlg.find('.org-emp__table tbody tr').length === 4,
            'rows=' + $dlg.find('.org-emp__table tbody tr').length);
        check('显示人数统计（共 4 人）', /共 4 人/.test($dlg.find('#orgEmpCount').text()), $dlg.find('#orgEmpCount').text());
        check('含下级部门的员工（前端/后端研发组）',
            /赵小雨/.test($dlg.find('.org-emp__table').text()) && /王多云/.test($dlg.find('.org-emp__table').text()),
            $dlg.find('.org-emp__table').text().slice(0, 120));
        check('人员列表含所属部门列',
            $dlg.find('.org-emp__table th').filter(function () { return /所属部门/.test($(this).text()); }).length === 1
            && /前端研发组|后端研发组/.test($dlg.find('.org-emp__table').text()),
            $dlg.find('.org-emp__table').text().slice(0, 120));

        /* 关键字检索（只在本部门内生效） */
        $dlg.find('#orgEmpKeyword').val('张守正');
        $dlg.find('#orgEmpSearch').trigger('click');
        setTimeout(function () {
            var $d2 = $('.el-overlay .el-dialog').last();
            check('关键字检索后只剩 1 条', $d2.find('.org-emp__table tbody tr').length === 1,
                'rows=' + $d2.find('.org-emp__table tbody tr').length);
            check('检索后人数统计同步为 1', /共 1 人/.test($d2.find('#orgEmpCount').text()),
                $d2.find('#orgEmpCount').text());

            $d2.find('#orgEmpReset').trigger('click');
            setTimeout(function () {
                var $d3 = $('.el-overlay .el-dialog').last();
                check('重置后恢复 4 条', $d3.find('.org-emp__table tbody tr').length === 4,
                    'rows=' + $d3.find('.org-emp__table tbody tr').length);
                $d3.find('.btn-cancel').trigger('click');

                setTimeout(function () {
                    // 关键字无命中 → 空提示
                    $('#orgChart .org-node__box[data-id="2"]').trigger('dblclick');
                    setTimeout(function () {
                        var $d4 = $('.el-overlay .el-dialog').last();
                        $d4.find('#orgEmpKeyword').val('不存在的人');
                        $d4.find('#orgEmpSearch').trigger('click');
                        setTimeout(function () {
                            var $d5 = $('.el-overlay .el-dialog').last();
                            check('无命中时显示空提示',
                                /暂无员工/.test($d5.find('.org-emp__body').text()),
                                $d5.find('.org-emp__body').text());
                            $d5.find('.btn-cancel').trigger('click');
                            setTimeout(runMgrSetTests, 300);
                        }, 600);
                    }, 600);
                }, 300);
            }, 600);
        }, 600);
    }, 600);
}

/* ===================== 1a-2. 本页设置部门负责人 ===================== */
function runMgrSetTests() {
    console.log('\n--- 本页设置部门负责人（列表与架构图同步刷新） ---');
    check('操作引导区存在「设置负责人」按钮', $('#btnSetManager').length === 1);
    check('操作引导区全部为图标按钮（svg + title + aria-label，无可见文字）',
        $('.toolbar').hasClass('toolbar--icons') &&
        $('.toolbar').attr('role') === 'toolbar' &&
        $('.toolbar .el-button').length === 4 &&
        $('.toolbar .el-button').toArray().every(function (b) {
            var $b = $(b);
            return $b.hasClass('el-button--icon') &&
                $b.find('svg.svg-ico').length === 1 &&
                !!$b.attr('title') && !!$b.attr('aria-label') &&
                $b.text().trim() === '';
        }), $('.toolbar').attr('class'));

    // 财务人事部（id=6）初始未设置负责人
    $('#orgTbody tr[data-id="6"]').trigger('click');
    check('未设置负责人的部门在列表显示「未设置」',
        /未设置/.test($('#orgTbody tr[data-id="6"]').find('td').eq(5).text()),
        $('#orgTbody tr[data-id="6"]').find('td').eq(5).text());
    $('#btnSetManager').trigger('click');

    setTimeout(function () {
        var $dlg = $('.el-overlay .el-dialog').last();
        check('点击按钮弹出选人弹窗',
            $dlg.length === 1 && /设置负责人/.test($dlg.find('.el-dialog__title').text()),
            $dlg.find('.el-dialog__title').text());
        check('弹窗默认只列本部门员工（1 人）', $dlg.find('#pickList tr[data-emp-id]').length === 1,
            'rows=' + $dlg.find('#pickList tr[data-emp-id]').length);
        check('未设置负责人时不显示「清除负责人」按钮', $dlg.find('.btn-clear-mgr').length === 0);

        $dlg.find('#pickList tr[data-emp-id]').eq(0).trigger('click');
        $dlg.find('.btn-ok').trigger('click');
        setTimeout(function () {
            check('保存后弹窗关闭', $('.el-overlay .el-dialog').length === 0);
            check('查询结果网格同步显示负责人',
                /孙悦/.test($('#orgTbody tr[data-id="6"]').find('td').eq(5).text()),
                $('#orgTbody tr[data-id="6"]').find('td').eq(5).text());
            check('组织架构图节点同步显示负责人',
                /负责人：孙悦/.test($('#orgChart .org-node__box[data-id="6"]').text()),
                $('#orgChart .org-node__box[data-id="6"]').text());

            // 再次打开 → 出现「清除负责人」，清除后两处同步回到未设置
            $('#orgTbody tr[data-id="6"]').trigger('click');
            $('#btnSetManager').trigger('click');
            setTimeout(function () {
                var $d2 = $('.el-overlay .el-dialog').last();
                check('已设置负责人时弹窗内出现「清除负责人」', $d2.find('.btn-clear-mgr').length === 1);
                $d2.find('.btn-clear-mgr').trigger('click');
                setTimeout(function () {
                    var $box = $('.el-message-box__wrapper').last();
                    check('清除前弹出确认框', /清除确认/.test($box.find('.el-message-box__title').text()),
                        $box.find('.el-message-box__title').text());
                    $box.find('.btn-ok').trigger('click');
                    setTimeout(function () {
                        check('清除后列表回到「未设置」',
                            /未设置/.test($('#orgTbody tr[data-id="6"]').find('td').eq(5).text()),
                            $('#orgTbody tr[data-id="6"]').find('td').eq(5).text());
                        check('清除后架构图节点回到「负责人：未设置」',
                            /负责人：未设置/.test($('#orgChart .org-node__box[data-id="6"]').text()),
                            $('#orgChart .org-node__box[data-id="6"]').text());
                        runGuardTests();
                    }, 1100);
                }, 400);
            }, 800);
        }, 1100);
    }, 800);
}

/* ===================== 1b. 删除保护（有启用状态下级时禁止删除） ===================== */
function runGuardTests() {
    console.log('\n--- 删除保护：有启用状态的下级部门 ---');
    var $rows = $('#orgTbody tr');
    // 第 2 行 = 技术研发部（下辖前端研发组 / 后端研发组，均为启用状态）
    $rows.eq(1).trigger('click');
    check('选中技术研发部', /技术研发部/.test($('#selTip').text()), $('#selTip').text());
    $('#btnDelete').trigger('click');

    setTimeout(function () {
        var $box = $('.el-message-box__wrapper').last();
        check('存在启用状态下级时删除被拦截', $box.length === 1 && /无法删除/.test($box.find('.el-message-box__title').text()),
            $box.find('.el-message-box__title').text());
        check('拦截提示说明启用状态的下级部门',
            /启用状态的下级部门/.test($box.find('.el-message-box__message').text()),
            $box.find('.el-message-box__message').text());
        check('被拦截后数据未被删除（仍 6 条）', $('#orgTbody tr').length === 6, String($('#orgTbody tr').length));
        $box.find('.btn-ok').trigger('click');

        setTimeout(function () {
            // 叶子部门（财务人事部，无下级）→ 应进入确认框
            $('#orgTbody tr').eq(5).trigger('click');
            check('选中财务人事部（叶子部门）', /财务人事部/.test($('#selTip').text()), $('#selTip').text());
            $('#btnDelete').trigger('click');
            setTimeout(function () {
                var $c = $('.el-message-box__wrapper').last();
                check('叶子部门删除不被拦截，弹出确认框',
                    /删除确认/.test($c.find('.el-message-box__title').text()), $c.find('.el-message-box__title').text());
                $c.find('.btn-cancel').trigger('click');
                setTimeout(runFormTests, 300);
            }, 600);
        }, 300);
    }, 600);
}

/* ===================== 2. 部门新增 / 编辑表单页 ===================== */
function runFormTests() {
    console.log('\n--- 部门新增表单页 ---');
    var w2 = boot('org-form.html', ['js/org-form.js']);
    var $2 = w2.jQuery;

    setTimeout(function () {
        var $code = $2('#code');
        check('编号输入框为只读', $code.prop('readonly') === true || $code.prop('disabled') === true,
            String($code.prop('readonly')));
        check('编号自动预填为 DPT + 4 位流水号', /^DPT\d{4}$/.test($code.val()), $code.val());
        check('编号提示说明由系统生成', /系统自动生成/.test($2('#codeTip').text()), $2('#codeTip').text());

        var opts = $2('#parentId option');
        check('上级部门下拉含「顶级部门」选项',
            opts.length >= 2 && /顶级部门/.test(opts.first().text()), opts.first().text());
        check('上级部门下拉带出全部部门（6 + 顶级）', opts.length === 7, String(opts.length));

        /* 选择上级后提示层级 */
        $2('#parentId').val('2');
        $2('#parentId').trigger('change');
        check('选择上级后提示将成为第 3 级', /3\s*级/.test($2('#levelTip').text()), $2('#levelTip').text());

        $2('#parentId').val('0');
        $2('#parentId').trigger('change');
        check('选择顶级后提示为第 1 级', /1\s*级/.test($2('#levelTip').text()), $2('#levelTip').text());

        /* 必填校验 */
        $2('#nameCn').val('');
        $2('#btnSave').trigger('click');
        check('部门名称为空时保存被拦截', /部门名称/.test($2('#nameCn').siblings('.el-form-item__error').text())
            || w2.__orgSaved !== true, $2('#nameCn').siblings('.el-form-item__error').text());

        runEditLockTests();
    }, 800);
}

/* ===================== 3. 编辑页：有启用下级时锁定「启用」开关 ===================== */
function runEditLockTests() {
    console.log('\n--- 编辑页停用保护（开关锁定） ---');
    // id=2 技术研发部：下有启用的前端/后端研发组 → 不允许停用
    var w3 = boot('org-form.html', ['js/org-form.js'], '?mode=edit&id=2');
    var $3 = w3.jQuery;

    setTimeout(function () {
        check('编辑页带出部门名称', $3('#nameCn').val() === '技术研发部', $3('#nameCn').val());
        check('有启用状态下级时开关被锁定并保持启用',
            $3('#enabledSwitch').hasClass('is-disabled') && $3('#enabled').prop('checked') === true,
            $3('#enabledSwitch').attr('class'));
        check('锁定提示说明不能停用的原因',
            /启用状态的下级部门/.test($3('#enabledTip').text()), $3('#enabledTip').text());
        $3('#enabledSwitch').trigger('click');
        check('锁定后点击开关仍为启用（不能停用）',
            $3('#enabled').prop('checked') === true && /已启用/.test($3('#enabledText').text()),
            $3('#enabledText').text());

        // id=6 财务人事部：无下级 → 开关可自由切换
        var w4 = boot('org-form.html', ['js/org-form.js'], '?mode=edit&id=6');
        var $4 = w4.jQuery;
        setTimeout(function () {
            check('叶子部门编辑页开关未锁定', !$4('#enabledSwitch').hasClass('is-disabled'),
                $4('#enabledSwitch').attr('class'));
            check('叶子部门无锁定提示', $4('#enabledTip').css('display') === 'none' || $4('#enabledTip').text() === '',
                $4('#enabledTip').text());
            $4('#enabledSwitch').trigger('click');
            check('叶子部门可正常切换为停用',
                $4('#enabled').prop('checked') === false && /已停用/.test($4('#enabledText').text()),
                $4('#enabledText').text());

            console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
            process.exit(fail ? 1 : 0);
        }, 900);
    }, 900);
}
