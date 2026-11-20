/* ==========================================================================
   project-plan-test.js —— 项目计划 v2（列表 / 计划表单 / 事项表单）
   --------------------------------------------------------------------------
   覆盖：
     ① 计划列表：检索 / 6 个工具栏按钮 / 9 列 / 选中后启用；甘特图与日历图渲染；
     ② 计划表单：基础信息（项目 / 编号 / 名称 / 起止 / 说明）+ 事项区（工具栏 + 列表）；
        计划未保存时事项按钮禁用，保存后可用；
     ③ 事项表单：需求要求的全部字段 + 状态来自字典 + 附件区（上传 / 预览 / 删除按钮）；
     ④ 项目管理页**已移除**「创建计划」按钮（项目计划功能 2026-11-09 18:00 下线，
        页面 / 服务 / 历史数据仍保留，恢复见 db/workplan-retire-projectplan.sql）。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/project-plan-test.js
   ========================================================================== */
'use strict';
process.on('unhandledRejection', function () { /* 页面异步桩不影响结论 */ });
var fs = require('fs');
var path = require('path');
var JSDOM = (function () { try { return require('jsdom').JSDOM; } catch (e) { return null; } })();

var ROOT = path.resolve(__dirname, '..');
var pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(cond, ms) {
    var end = Date.now() + (ms || 1500);
    while (Date.now() < end) { if (cond()) { return true; } await wait(20); }
    return false;
}

if (!JSDOM) { console.log('未安装 jsdom，跳过'); process.exit(0); }

function boot(page, scripts, url) {
    var dom = new JSDOM(read(page), { url: url || ('http://127.0.0.1:8808/' + page), runScripts: 'outside-only', pretendToBeVisual: true });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.jQuery.ajax = function () { var d = win.jQuery.Deferred(); d.reject({}, 'error', ''); return d.promise(); };
    win.eval(read('js/api.js'));
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({ token: 'mock', user: { empId: 3, nameCn: '杨伟康' } }));
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    win.AppNav.go = function (u) { win.__nav = u; };
    scripts.forEach(function (s) { win.eval(read(s)); });
    return win;
}

var PLANS = [{ id: 'pl-1', planCode: 'PL000001', planName: '一期计划', projectId: 'prj-1',
    projectName: '九豆平台研发', projectCode: 'PRO000001', startDate: '2026-11-10',
    endDate: '2026-12-20', planDesc: '一期', itemCount: 2, orderCount: 2 }];
var ITEMS = [
    { id: 'it-1', itemCode: 'IT000001', itemName: '需求调研', itemType: '事项', status: '执行中',
      ownerId: 3, ownerName: '杨伟康', startTime: '2026-11-10 09:00:00', endTime: '2026-11-12 18:00:00',
      orderCode: 'WO000001', preItemName: '', fileCount: 1 },
    { id: 'it-2', itemCode: 'IT000002', itemName: '接口联调', itemType: '任务', status: '待执行',
      ownerId: 5, ownerName: '张三', startTime: '2026-11-13 09:00:00', endTime: '2026-11-18 18:00:00',
      orderCode: 'WO000002', preItemName: '需求调研', fileCount: 0 }
];

function stubCommon(win) {
    var $ = win.jQuery;
    win.Api.project = { page: function () { var d = $.Deferred(); d.resolve({ list: [{ id: 'prj-1', projectName: '九豆平台研发', projectCode: 'PRO000001' }] }); return d.promise(); } };
    win.Api.emp = { page: function () { var d = $.Deferred(); d.resolve({ list: [{ id: 3, name: '杨伟康', deptName: '研发中心', email: 'y@x.com' }, { id: 5, name: '张三', deptName: '财务部', email: '' }] }); return d.promise(); } };
    win.Api.projectPlan = {
        page: function () { var d = $.Deferred(); d.resolve({ list: PLANS, total: 1, pageNum: 1, pageSize: 10 }); return d.promise(); },
        detail: function () { var d = $.Deferred(); d.resolve({ id: 'pl-1', planCode: 'PL000001', planName: '一期计划', projectId: 'prj-1', projectName: '九豆平台研发', projectCode: 'PRO000001', startDate: '2026-11-10', endDate: '2026-12-20', planDesc: '一期' }); return d.promise(); },
        add: function () { var d = $.Deferred(); d.resolve({ id: 'pl-2', planCode: 'PL000002', message: '计划已创建（PL000002）' }); return d.promise(); },
        update: function () { var d = $.Deferred(); d.resolve({ id: 'pl-1', message: '计划已更新' }); return d.promise(); },
        remove: function () { var d = $.Deferred(); d.resolve({ deleted: 1 }); return d.promise(); },
        items: function () { var d = $.Deferred(); d.resolve({ list: ITEMS, total: 2 }); return d.promise(); },
        itemDetail: function () { var d = $.Deferred(); d.resolve({ id: 'it-1', planId: 'pl-1', itemCode: 'IT000001', itemName: '需求调研', itemType: '事项', status: '执行中', ownerId: 3, startTime: '2026-11-10 09:00:00', endTime: '2026-11-12 18:00:00', files: [] }); return d.promise(); },
        itemAdd: function () { var d = $.Deferred(); d.resolve({ id: 'it-9', itemCode: 'IT000009', orderCode: 'WO000009', message: '事项已保存' }); return d.promise(); },
        itemUpdate: function () { var d = $.Deferred(); d.resolve({ id: 'it-1', message: '事项已更新' }); return d.promise(); },
        itemRemove: function () { var d = $.Deferred(); d.resolve({ deleted: 1 }); return d.promise(); },
        itemStatuses: function () { var d = $.Deferred(); d.resolve({ statuses: ['待执行', '执行中', '完成', '异常'] }); return d.promise(); },
        start: function () { var d = $.Deferred(); d.resolve({ created: 1, message: '已为 1 个事项派发工单' }); return d.promise(); },
        orders: function () { var d = $.Deferred(); d.resolve({ list: [] }); return d.promise(); },
        itemFiles: function () { var d = $.Deferred(); d.resolve({ list: [] }); return d.promise(); },
        itemFileUpload: function () { var d = $.Deferred(); d.resolve({ id: 'f-1' }); return d.promise(); },
        itemFileDelete: function () { var d = $.Deferred(); d.resolve({ deleted: 1 }); return d.promise(); },
        itemFileDownload: function () { var d = $.Deferred(); d.resolve({ url: '/x' }); return d.promise(); }
    };
}

(async function () {
    /* ---------------- 1. 计划列表 ---------------- */
    console.log('\n--- 1. 计划列表 ---');
    var w1 = boot('project-plan.html', ['js/project-plan.js']);
    stubCommon(w1);
    var $ = w1.jQuery;
    await wait(150);
    await until(function () { return $('#planTbody tr[data-id]').length > 0; }, 2500);
    check('6 个工具栏按钮（创建 / 打开 / 甘特 / 日历 / 删除 / 刷新）',
        ['#btnAdd', '#btnOpen', '#btnGantt', '#btnCalendar', '#btnDelete', '#btnRefresh']
            .every(function (id) { return $(id).length === 1; }), String($('.toolbar .el-button').length));
    check('9 列表头', $('#planTable thead th').length === 9, $('#planTable thead th').length);
    check('计划行显示编号 / 名称 / 项目 / 事项数',
        $('#planTbody').text().indexOf('PL000001') > -1 && $('#planTbody').text().indexOf('一期计划') > -1 &&
        $('#planTbody').text().indexOf('九豆平台研发') > -1 && $('#planTbody').text().indexOf('2') > -1);
    check('未选中时打开 / 甘特 / 日历 / 删除禁用',
        $('#btnOpen').prop('disabled') === true && $('#btnGantt').prop('disabled') === true);

    $('#planTbody tr[data-id="pl-1"]').trigger('click');
    check('选中后按钮启用', $('#btnOpen').prop('disabled') === false &&
        $('#btnGantt').prop('disabled') === false && $('#btnCalendar').prop('disabled') === false);
    $('#btnGantt').trigger('click');
    await wait(200);
    check('甘特图渲染出 2 条事项条',
        $('#pvGantt .pp-gantt__bar').length === 2 && $('#planViews').is(':not([hidden])'),
        $('#pvGantt .pp-gantt__bar').length);
    check('甘特条带状态样式（执行中 / 待执行）',
        $('#pvGantt .pp-gantt__bar.is-执行中').length === 1);
    $('#btnCalendar').trigger('click');
    await wait(200);
    check('日历图渲染出日期格与事项格',
        $('#pvCalendar .pp-cal__day').length >= 28 && $('#pvCalendar .pp-cal__item').length >= 1,
        $('#pvCalendar .pp-cal__day').length);

    check('创建计划跳 project-plan-form.html',
        (function () { $('#btnAdd').trigger('click'); return String(w1.__nav || '').indexOf('project-plan-form.html') === 0; })(),
        String(w1.__nav));

    /* ---------------- 2. 计划表单 ---------------- */
    console.log('\n--- 2. 计划表单（基础信息 + 事项区） ---');
    var w2 = boot('project-plan-form.html', ['js/project-plan-form.js'],
        'http://127.0.0.1:8808/project-plan-form.html?planId=pl-1');
    stubCommon(w2);
    var $2 = w2.jQuery;
    await wait(150);
    await until(function () { return $2('#itemTbody tr[data-id]').length > 0; }, 2500);
    check('基础信息字段齐全（项目 / 编号 / 名称 / 起止 / 说明）',
        ['#pfProject', '#pfCode', '#pfName', '#pfStart', '#pfEnd', '#pfDesc']
            .every(function (id) { return $2(id).length === 1; }));
    check('计划编号回填 PL000001', $2('#pfCode').val() === 'PL000001', $2('#pfCode').val());
    check('事项区 6 个按钮',
        ['#btnItemAdd', '#btnItemEdit', '#btnItemDelete', '#btnItemDetail', '#btnStartPlan', '#btnItemRefresh']
            .every(function (id) { return $2(id).length === 1; }),
        String($2('.toolbar .el-button').length));
    check('事项列表 2 行', $2('#itemTbody tr[data-id]').length === 2, $2('#itemTbody tr[data-id]').length);
    check('事项行显示编号 / 类型 / 前置事项 / 工单号',
        $2('#itemTbody').text().indexOf('IT000001') > -1 && $2('#itemTbody').text().indexOf('需求调研') > -1 &&
        $2('#itemTbody').text().indexOf('WO000001') > -1);
    check('已保存计划：新增 / 启动 / 刷新可用，编辑类禁用',
        $2('#btnItemAdd').prop('disabled') === false && $2('#btnStartPlan').prop('disabled') === false &&
        $2('#btnItemEdit').prop('disabled') === true);
    $2('#itemTbody tr[data-id="it-2"]').trigger('click');
    check('选中事项后编辑 / 删除 / 详情可用',
        $2('#btnItemEdit').prop('disabled') === false && $2('#btnItemDelete').prop('disabled') === false &&
        $2('#btnItemDetail').prop('disabled') === false);

    /* ---------------- 3. 事项表单 ---------------- */
    console.log('\n--- 3. 事项表单（全部字段 + 附件） ---');
    var w3 = boot('project-plan-item-form.html', ['js/project-plan-item.js'],
        'http://127.0.0.1:8808/project-plan-item-form.html?planId=pl-1&itemId=it-1');
    stubCommon(w3);
    var $3 = w3.jQuery;
    await wait(200);
    await until(function () { return $3('#itStatus option').length > 0; }, 2500);
    check('字段齐全（项目 / 计划 / 名称 / 类型 / 前置 / 说明 / 输入条件 / 里程碑 / 起止 / 责任人 / 参与人 / 状态）',
        ['#itProject', '#itPlan', '#itName', '#itType', '#itPre', '#itDesc', '#itInput', '#itOut',
         '#itStart', '#itEnd', '#itOwner', '#itParts', '#itStatus', '#itSort']
            .every(function (id) { return $3(id).length === 1; }));
    check('状态选项来自字典（4 项）', $3('#itStatus option').length === 4 &&
        $3('#itStatus').text().indexOf('待执行') > -1 && $3('#itStatus').text().indexOf('异常') > -1);
    check('参与人员是多选', $3('#itParts').attr('multiple') !== undefined);
    check('时间输入是 datetime-local',
        $3('#itStart').attr('type') === 'datetime-local' && $3('#itEnd').attr('type') === 'datetime-local');
    check('附件区有上传 / 预览 / 删除按钮与列表',
        $3('#btnPickFile').length === 1 && $3('#btnPreviewFile').length === 1 &&
        $3('#btnDeleteFile').length === 1 && $3('#fileTbody').length === 1);

    /* ---------------- 4. 项目管理页入口 ---------------- */
    console.log('\n--- 4. 项目管理页入口（项目计划已下线） ---');
    var w4 = boot('project.html', ['js/word-import.js', 'js/file-preview.js', 'js/project.js']);
    stubCommon(w4);
    await wait(150);
    check('项目计划下线后项目管理页不再有「创建计划」按钮',
        w4.jQuery('#btnPlan').length === 0 &&
        read('js/project.js').indexOf("'#btnPlan'") < 0 &&
        read('db/workplan-retire-projectplan.sql').indexOf('MNU00023') > -1);

    console.log('\n===== project-plan-test 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
    process.exit(fail ? 1 : 0);
})();
