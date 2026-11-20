/* ==========================================================================
   workplan-import-test.js —— 工作计划「从 Excel 导入任务」jsdom 回归
   --------------------------------------------------------------------------
   覆盖：
     ① 静态口径：按钮在标准 .toolbar 内（pageopbtn 可收录）/ 后端模板与解析同源
        （IMPORT_COLUMNS）/ 接口与路由齐全 / 按钮权限种子已登记；
     ② 弹窗：三步引导、模板链接、文件选择、追加或覆盖两个选项；
     ③ 解析结果预览：统计行、错误行标红 + 文案、确定按钮文案带条数；
     ④ 写入画布：追加（接在选中行之后）/ 覆盖（清空后导入）两种模式；
        序号 → uuid 的映射（parentId / preTaskIds 都指向导入行自己的 id）；
     ⑤ 边界：超过 200 条上限时拒绝并提示，画布不变。
   运行：NODE_PATH=C:/Users/chx/.workbuddy/binaries/node/workspace/node_modules node tools/workplan-import-test.js
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
    var end = Date.now() + (ms || 3000);
    while (Date.now() < end) {
        if (cond()) { return true; }
        await wait(20);
    }
    return false;
}

if (!JSDOM) { console.log('未安装 jsdom，跳过'); process.exit(0); }

var P1 = 'wpl-0000-4000-8000-000000000001';

function boot(page, scripts, url) {
    var dom = new JSDOM(read(page), {
        url: url || ('http://127.0.0.1:8808/' + page),
        runScripts: 'outside-only', pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.jQuery.ajax = function () {
        var d = win.jQuery.Deferred(); d.reject({}, 'error', ''); return d.promise();
    };
    win.localStorage.setItem('menu_admin_login_v1',
        JSON.stringify({ token: 'mock', user: { empId: 3, nameCn: '杨伟康' } }));
    win.eval(read('js/api.js'));
    win.Api.config.useMock = true;
    win.Api.config.delay = 1;
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/btnperm.js'));
    win.AppNav = win.AppNav || {};
    win.AppNav.go = function (u) { win.__nav = u; };
    scripts.forEach(function (s) { win.eval(read(s)); });
    return win;
}

/* 解析结果样本：2 条可用 + 1 条责任人错误 */
var ROWS = [
    { id: 'imp-0000-4000-8000-000000000001', seq: 1, rowNo: 2, level: 1,
      taskName: '导入的摘要任务', taskType: 'summary',
      startDate: '2026-12-01', endDate: '2026-12-10', duration: 10,
      ownerId: 3, ownerName: '杨伟康', participantIds: '', participantNames: '',
      ownerRaw: 'E00003 杨伟康', participantRaw: '',
      parentSeq: null, preTaskSeqs: [], errors: [], ok: true },
    { id: 'imp-0000-4000-8000-000000000002', seq: 2, rowNo: 3, level: 2,
      taskName: '导入的子任务', taskType: 'milestone',
      startDate: '2026-12-03', endDate: '2026-12-03', duration: 1,
      ownerId: 3, ownerName: '杨伟康', participantIds: '4', participantNames: '李四',
      ownerRaw: 'E00003 杨伟康', participantRaw: 'E00004 李四',
      parentSeq: 1, preTaskSeqs: [1], errors: [], ok: true },
    { id: 'imp-0000-4000-8000-000000000003', seq: 3, rowNo: 4, level: 1,
      taskName: '责任人写错的行', taskType: 'task',
      startDate: '2026-12-01', endDate: '2026-12-02', duration: 2,
      ownerId: 0, ownerName: '', participantIds: '', participantNames: '',
      ownerRaw: 'E99999 王五', participantRaw: '',
      parentSeq: null, preTaskSeqs: [],
      errors: ['责任人：工号 E99999 在员工信息里不存在'], ok: false }
];
var SUMMARY = { total: 3, valid: 2, invalid: 1, summaries: 1, milestones: 1,
                withOwner: 2, participants: 1, maxTasks: 200 };

function stubParse(win, rows, summary) {
    if (!rows) { rows = ROWS; }
    if (!summary) { summary = SUMMARY; }
    win.__impPayload = null;
    win.Api.workPlan.importTasks = function (payload) {
        win.__impPayload = payload;
        var d = win.jQuery.Deferred();
        d.resolve({ rows: rows, errors: [], summary: summary,
                    fileName: payload.fileName, mock: false });
        return d.promise();
    };
}

/** 给隐藏的 file input 塞一个真 File，触发 change（jsdom 支持 File / FileReader） */
function pickFile(win, $, name) {
    var input = win.document.getElementById('wpImpInput');
    var file = new win.File(['fake-xlsx-bytes'], name || '任务列表.xlsx',
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    $(input).trigger('change');
}

(async function () {
    /* ================= 1. 静态口径 ================= */
    console.log('\n--- 1. 静态口径 ---');
    var html = read('workplan-design.html');
    var jsSrc = read('js/workplan-design.js');
    var apiSrc = read('js/api.js');
    var svcSrc = read('server/service.py');
    var appSrc = read('server/app.py');
    var cssSrc = read('css/workplan.css');
    var sql = read('db/workplan-btn-perm.sql');

    check('工具栏有「导入任务」按钮（纯图标：无可见文字 + title + aria-label）',
        /id="wpDBtnImport"/.test(html) &&
        (html.match(/<button[^>]*id="wpDBtnImport"[\s\S]*?<\/button>/) || [''])[0].indexOf('title="从 Excel 导入任务') > -1 &&
        /id="wpDBtnImport"[\s\S]{0,400}?aria-label="导入任务"/.test(html));
    check('按钮在标准 .toolbar 容器里（否则 page_scan 收录不到、btnperm 会隐藏）',
        (function () {
            var start = html.indexOf('class="toolbar toolbar--icons wp-toolbar');
            var end = html.indexOf('</div>', html.indexOf('<span class="wp-hint"'));
            var at = html.indexOf('id="wpDBtnImport"');
            return start > -1 && at > start && at < end;
        })());
    check('按钮排在「新增摘要任务」之后（创建类动作归一组）',
        html.indexOf('id="wpDBtnSummary"') < html.indexOf('id="wpDBtnImport"'));
    check('后端列定义是模板与解析的唯一口径（IMPORT_COLUMNS 含 责任人 / 参与人员）',
        svcSrc.indexOf('IMPORT_COLUMNS = (') > -1 &&
        svcSrc.indexOf("('owner', '责任人'") > -1 &&
        svcSrc.indexOf("('participants', '参与人员'") > -1 &&
        svcSrc.indexOf('def _import_template_bytes') > -1 &&
        svcSrc.indexOf('def _parse_import_bytes') > -1);
    check('解析按表头名定位（别名表）而不是列序，且容忍模板的 * 必填标记',
        svcSrc.indexOf('IMPORT_ALIASES = {') > -1 &&
        svcSrc.indexOf("replace('*', '')") > -1 &&
        svcSrc.indexOf('def locate_header') > -1);
    check('人员按「工号 姓名」解析（工号优先，姓名做一致性校验）',
        svcSrc.indexOf('def _split_person') > -1 &&
        svcSrc.indexOf('def _resolve_person') > -1 &&
        svcSrc.indexOf('与填写的「%s」不一致') > -1 &&
        svcSrc.indexOf('请写成「工号 姓名」') > -1);
    check('导入只解析不落库（parse_import 里没有 INSERT/UPDATE）',
        (function () {
            var i = svcSrc.indexOf('def parse_import');
            var body = svcSrc.slice(i, i + 1400);
            return i > -1 && body.indexOf('INSERT') < 0 && body.indexOf('execute(') < 0;
        })());
    check('接口齐全：POST /workplan/importtasks + GET /api/workplan/importtemplate',
        /'importtasks': \('parse_import', \['POST'\]\)/.test(svcSrc) &&
        appSrc.indexOf("'/api/workplan/importtemplate'") > -1);
    check('前端 API + Mock 都实现了 importtasks',
        apiSrc.indexOf("importTasks: function (data)") > -1 &&
        apiSrc.indexOf("if (path === '/importtasks')") > -1);
    check('按钮权限种子登记了 wpDBtnImport（否则普通角色看不到）',
        sql.indexOf("'wpDBtnImport'") > -1);
    check('样式挂在页面级 workplan.css（不改 app.css）',
        cssSrc.indexOf('.wp-imp__table') > -1 && cssSrc.indexOf('.wp-imp__step') > -1);
    check('导入到「已启动」计划前会二次确认派单 / 通知影响面',
        jsSrc.indexOf('导入到已启动的计划') > -1 &&
        jsSrc.indexOf('补派工单') > -1 && jsSrc.indexOf('站长消息') < 0);
    check('模板下载带 token（走二进制路由，不走通用 JSON 分发）',
        jsSrc.indexOf('/api/workplan/importtemplate') > -1 &&
        jsSrc.indexOf("'?token=' + encodeURIComponent(t)") > -1);

    /* ================= 2. 弹窗与预览 ================= */
    console.log('\n--- 2. 弹窗与预览 ---');
    var w = boot('workplan-design.html', ['js/workplan-design.js'],
        'http://127.0.0.1:8808/workplan-design.html?id=' + P1);
    var $ = w.jQuery;
    await until(function () { return $('#wpDCanvas .wp-grid__row').length > 0; });
    var before = parseInt($('#wpDTaskCount').text(), 10) || 0;
    check('设计页载入计划与任务（种子 7 条）', before > 0, before);

    $('#wpDBtnImport').trigger('click');
    await until(function () { return $('.wp-imp').length > 0; });
    check('点「导入任务」弹出对话框', $('.el-dialog .wp-imp').length === 1);
    check('三步引导齐全（下载模板 / 选择文件 / 核对结果）',
        $('.wp-imp__step').length === 3 && $('.wp-imp__no').length === 3);
    check('模板下载链接指向 .xlsx', $('.wp-imp__link a').text().indexOf('导入模板.xlsx') > -1);
    check('有文件选择入口（accept 只放 xlsx）',
        $('#wpImpPick').length === 1 && /\.xlsx/.test($('#wpImpInput').attr('accept') || ''));
    check('两种导入方式（追加 / 覆盖）',
        $('input[name="wpImpMode"]').length === 2 &&
        $('input[name="wpImpMode"][value="append"]').prop('checked') === true);
    check('确认按钮初始不可点（还没解析）', $('.el-dialog .btn-ok').prop('disabled') === true);

    stubParse(w);
    pickFile(w, $, '任务列表.xlsx');
    await until(function () { return $('#wpImpPreview tbody tr').length > 0; });
    check('解析请求带文件名与 base64 内容',
        !!w.__impPayload && w.__impPayload.fileName === '任务列表.xlsx' &&
        String(w.__impPayload.data).indexOf('data:') < 0 && String(w.__impPayload.data).length > 0,
        w.__impPayload && String(w.__impPayload.data).slice(0, 30));
    check('文件名回显在步骤里', $('#wpImpFile').text() === '任务列表.xlsx', $('#wpImpFile').text());
    check('预览表 3 行', $('#wpImpPreview tbody tr').length === 3);
    check('统计行显示 可导入 2 / 异常 1',
        /共 <b>3<\/b> 行/.test($('#wpImpStats').html()) &&
        /可导入 <b class="is-pass">2<\/b>/.test($('#wpImpStats').html()) &&
        /异常 <b class="is-fail">1<\/b>/.test($('#wpImpStats').html()),
        $('#wpImpStats').html());
    var $bad = $('#wpImpPreview tbody tr.is-bad');
    check('错误行标红（is-bad）且只有 1 行', $bad.length === 1);
    check('错误行原文带出来（工号不存在）',
        $bad.find('td.is-fail').text().indexOf('E99999') > -1, $bad.find('td.is-fail').text());
    check('通过行显示「通过」', $('#wpImpPreview tbody tr.is-ok td.is-pass').length === 2);
    /* 责任人 / 参与人员列显示姓名，title 里放原填写的「工号 姓名」，方便核对匹配结果 */
    var $r0 = $('#wpImpPreview tbody tr').eq(0).find('td');
    check('责任人列显示解析后的姓名', $r0.eq(7).text().trim() === '杨伟康', $r0.eq(7).text());
    check('责任人列 title 是原填写的「工号 姓名」',
        $r0.eq(7).attr('title') === 'E00003 杨伟康', $r0.eq(7).attr('title'));
    var $r1 = $('#wpImpPreview tbody tr').eq(1).find('td');
    check('参与人员列 title 回带原文本（多个用逗号）',
        $r1.eq(8).attr('title') === 'E00004 李四', $r1.eq(8).attr('title'));
    check('层级用缩进表达（子任务有 padding-left）',
        /padding-left:\s*14px/.test($('#wpImpPreview').html()));
    check('确定按钮文案带条数', $('.el-dialog .btn-ok').text() === '导入 2 条任务',
        $('.el-dialog .btn-ok').text());

    /* ================= 3. 追加导入 + 序号映射 ================= */
    console.log('\n--- 3. 追加导入与序号映射 ---');
    var savedPayload = null;
    w.Api.workPlan.save = function (data) {
        savedPayload = data;
        var d = $.Deferred();
        d.resolve({ id: P1, message: '模拟保存成功' });
        return d.promise();
    };
    $('.el-dialog .btn-ok').trigger('click');
    await until(function () { return parseInt($('#wpDTaskCount').text(), 10) === before + 2; });
    check('追加后任务数 +2', parseInt($('#wpDTaskCount').text(), 10) === before + 2,
        $('#wpDTaskCount').text());
    check('对话框关闭', $('.el-dialog').length === 0);
    check('导入的任务出现在画布列表（名字可见）',
        $('#wpDCanvas').text().indexOf('导入的摘要任务') > -1 &&
        $('#wpDCanvas').text().indexOf('导入的子任务') > -1);
    check('被标记错误的行没有进画布', $('#wpDCanvas').text().indexOf('责任人写错的行') < 0);

    $('#wpDBtnSave').trigger('click');
    await until(function () { return !!savedPayload; });
    var all = (savedPayload && savedPayload.tasks) || [];
    var byId = {};
    all.forEach(function (t) { byId[t.id] = t; });
    var r1 = byId['imp-0000-4000-8000-000000000001'];
    var r2 = byId['imp-0000-4000-8000-000000000002'];
    check('保存载荷里带着导入的两条任务（id 原样保留）', !!r1 && !!r2);
    check('层级推导出的 parentId 指向第 1 行任务', !!r2 && r2.parentId === r1.id,
        r2 && r2.parentId);
    check('前置任务按序号映射成 uuid（不是序号数字）', !!r2 && r2.preTaskIds === r1.id,
        r2 && r2.preTaskIds);
    check('责任人 / 参与人员原样带上（工号解析结果）',
        !!r1 && r1.ownerId === 3 && r1.ownerName === '杨伟康' &&
        !!r2 && r2.participantIds === '4' && r2.participantNames === '李四',
        r1 && (r1.ownerId + '/' + r1.ownerName));
    check('导入的任务一律从未开始 0% 起（不伪造执行状态）',
        !!r1 && r1.execStatus === '未开始' && r1.progress === 0);
    check('摘要 / 里程碑类型保留', !!r1 && r1.taskType === 'summary' &&
        !!r2 && r2.taskType === 'milestone');

    /* ================= 4. 覆盖导入 ================= */
    console.log('\n--- 4. 覆盖导入 ---');
    $('#wpDBtnImport').trigger('click');
    await until(function () { return $('.wp-imp').length > 0; });
    stubParse(w);
    pickFile(w, $, '覆盖.xlsx');
    await until(function () { return $('#wpImpPreview tbody tr').length > 0; });
    var $replace = $('input[name="wpImpMode"][value="replace"]');
    check('覆盖选项可用（本人创建的计划）', $replace.prop('disabled') === false);
    $replace.prop('checked', true).trigger('change');
    check('切换后单选高亮跟着走',
        $replace.closest('.el-radio').hasClass('is-checked'));
    $('.el-dialog .btn-ok').trigger('click');
    await until(function () { return parseInt($('#wpDTaskCount').text(), 10) === 2; });
    check('覆盖后只剩导入的 2 条任务', parseInt($('#wpDTaskCount').text(), 10) === 2,
        $('#wpDTaskCount').text());
    check('覆盖后用导入的任务替换掉原有任务',
        $('#wpDCanvas').text().indexOf('导入的摘要任务') > -1 &&
        $('#wpDCanvas').text().indexOf('需求调研') < 0, $('#wpDCanvas').text().slice(0, 80));

    /* ================= 5. 上限与异常 ================= */
    console.log('\n--- 5. 上限与异常 ---');
    var many = [];
    for (var i = 0; i < 200; i++) {
        many.push({ id: 'imp-many-' + i, seq: i + 1, rowNo: i + 2, level: 1,
                    taskName: '批量任务 ' + (i + 1), taskType: 'task',
                    startDate: '2026-12-01', endDate: '2026-12-02', duration: 2,
                    ownerId: 0, ownerName: '', participantIds: '', participantNames: '',
                    parentSeq: null, preTaskSeqs: [], errors: [], ok: true });
    }
    $('#wpDBtnImport').trigger('click');
    await until(function () { return $('.wp-imp').length > 0; });
    stubParse(w, many, { total: 200, valid: 200, invalid: 0, summaries: 0, milestones: 0,
                         withOwner: 0, participants: 0, maxTasks: 200 });
    pickFile(w, $, '批量.xlsx');
    await until(function () { return $('#wpImpPreview tbody tr').length > 0; });
    $('.el-dialog .btn-ok').trigger('click');
    await wait(60);
    check('超过 200 条上限时拒绝导入（画布仍是 2 条）',
        parseInt($('#wpDTaskCount').text(), 10) === 2, $('#wpDTaskCount').text());
    check('超限后对话框不关闭，方便用户改选「覆盖」或拆分文件',
        $('.el-dialog .wp-imp').length === 1);

    /* 接口失败：把错误文案显示在预览区 */
    w.Api.workPlan.importTasks = function () {
        var d = $.Deferred();
        d.reject({ message: '文件无法解析：请确认是 .xlsx 格式' });
        return d.promise();
    };
    pickFile(w, $, '坏文件.xlsx');
    await until(function () { return $('#wpImpStats').hasClass('is-error'); });
    check('解析失败时把后端文案显示出来（含 .xlsx 提示）',
        $('#wpImpStats').text().indexOf('.xlsx') > -1, $('#wpImpStats').text());
    check('失败后确定按钮回到不可点', $('.el-dialog .btn-ok').prop('disabled') === true);

    /* 非 xlsx 直接拦掉，不发请求 */
    var called = 0;
    w.Api.workPlan.importTasks = function () {
        called++;
        var d = $.Deferred(); d.resolve({ rows: [], summary: {} }); return d.promise();
    };
    pickFile(w, $, '任务列表.csv');
    await wait(60);
    check('非 .xlsx 文件在前端就被拦下（不发解析请求）', called === 0);

    console.log('\n===== workplan-import-test 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
    process.exit(fail ? 1 : 0);
})();
