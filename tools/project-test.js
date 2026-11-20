/* ==========================================================================
   project-test.js —— 项目管理 · 项目信息页测试（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖：
     ① 首屏骨架：标题 / 面包屑 / 5 个检索条件 / 7 个操作按钮 / 11 列表头 / 分页；
     ② 字典下拉（项目类型 9 项 / 项目状态 5 项）与列表渲染；
     ③ 可见性：登录员工 empId=3 → 他人私有项目不可见，本人私有 / 他人公用仍可见；
     ④ 检索：关键字 / 类型 / 状态 / 公用否 / 启用否 五路筛选；
     ⑤ 新增 / 编辑均「打页」到 project-form.html 独立页签（不再弹窗）；
     ⑥ Mock 层新增 / 编辑保存后列表刷新：编号自动生成、编号不可改、富文本摘要；
     ⑦ 启用 / 停用按钮联动、查看项目跳转带 id、删除确认框与级联提示；
     ⑧ 双击行刷新右栏文件面板（不再打页）、他人私有项目 detail 可见性、Mock 层 nextcode / check / options。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/project-test.js
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
    // 登录态：empId=3（种子里 PRO000001 / PRO000003 是他创建的）
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'mock-token', user: { empId: 3, nameCn: '杨伟康' }
    }));
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    win.AppNav.go = function (url2) { win.__lastNav = url2; };
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

var win = boot('project.html', ['js/word-import.js', 'js/file-preview.js', 'js/project.js']);
var $ = win.jQuery;
var Api = win.Api;

function rows() { return $('#pjTbody tr[data-id]'); }
function toast() { return $('.el-message-list').text(); }
function msgBox() { return $('.el-message-box').last(); }
function rowText(i) { return rows().eq(i).text().replace(/\s+/g, ' '); }
function clickSearch(kw, type, status, ispub, enabled) {
    $('#keyword').val(kw || '');
    $('#projectType').val(type || '');
    $('#projectStatus').val(status || '');
    $('#ispub').val(ispub === undefined ? '' : ispub);
    $('#enabled').val(enabled === undefined ? '' : enabled);
    $('#btnSearch').trigger('click');
}

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
    check('页面标题为「项目管理」', $('.page-head__title').text() === '项目管理',
        $('.page-head__title').text());
    check('浏览器标签标题为「项目管理 - 九豆综合管理平台」',
        win.document.title === '项目管理 - 九豆综合管理平台', win.document.title);
    check('面包屑为「项目管理/项目信息」',
        $('#pageHead').attr('data-crumb') === '项目管理/项目信息', $('#pageHead').attr('data-crumb'));
    check('检索卡片含 5 个条件 + 查询/重置',
        $('#searchForm .el-form-item').length === 6 &&
        $('#keyword').length === 1 && $('#projectType').length === 1 &&
        $('#projectStatus').length === 1 && $('#ispub').length === 1 &&
        $('#enabled').length === 1 && $('#btnSearch').length === 1 && $('#btnReset').length === 1,
        String($('#searchForm .el-form-item').length));
    /* 项目计划 2026-11-09 18:00 下线：#btnPlan 已移除，工具栏 10 → 9 个按钮 */
    check('操作引导区 9 个按钮（含项目组 / 上传文件 / 查看项目；「创建计划」已随项目计划下线）',
        ['#btnAdd', '#btnEdit', '#btnEnable', '#btnDisable', '#btnView', '#btnUpload',
         '#btnMembers', '#btnDelete', '#btnRefresh']
            .every(function (id) { return $(id).length === 1; }) &&
        $('#btnPlan').length === 0 &&
        $('.toolbar .el-button').length === 9, String($('.toolbar .el-button').length));

    /* 操作引导区：项目管理按钮全部改为纯图标按钮（与右栏文件区一致，不升 app.css） */
    var opIds = ['#btnAdd', '#btnEdit', '#btnEnable', '#btnDisable', '#btnView', '#btnUpload',
                 '#btnDelete', '#btnRefresh'];
    var opTexts = ['新增项目', '编辑', '启用', '停用', '查看项目', '上传文件', '删除', '刷新'];
    check('项目管理操作引导区带 toolbar--icons 且有 toolbar 语义',
        $('.toolbar').hasClass('toolbar--icons') && $('.toolbar').attr('role') === 'toolbar' &&
        $('.toolbar').attr('aria-label') === '项目管理操作', String($('.toolbar').attr('class')));
    check('8 个按钮全部是 .el-button--icon 且无可见文字',
        opIds.every(function (id) {
            var $b = $(id);
            return $b.hasClass('el-button--icon') && $b.text().replace(/\s+/g, '') === '';
        }), opIds.map(function (id) { return id + ':' + $(id).text().replace(/\s+/g, ''); }).join('|'));
    check('每个按钮内恰好一个 svg 图标',
        opIds.every(function (id) { return $(id).find('svg.svg-ico').length === 1; }),
        opIds.map(function (id) { return $(id).find('svg.svg-ico').length; }).join(','));
    check('每个图标按钮的 title / aria-label 保留原按钮文案（权限扫描 btnText 不变）',
        opIds.every(function (id, i) {
            return $(id).attr('title') === opTexts[i] && $(id).attr('aria-label') === opTexts[i];
        }), opIds.map(function (id) { return $(id).attr('title'); }).join('|'));
    check('按钮仍保留原色彩语义与初始禁用态',
        $('#btnAdd').hasClass('el-button--success') && $('#btnDelete').hasClass('el-button--danger') &&
        $('#btnDisable').hasClass('el-button--warning') &&
        $('#btnAdd').prop('disabled') === false && $('#btnRefresh').prop('disabled') === false &&
        $('#btnEdit').prop('disabled') === true);
    check('检索区仍为文字按钮 / 文件区操作引导区仍为图标按钮（两区互不干扰）',
        $('#btnSearch').text().trim() === '查询' && !$('#btnSearch').hasClass('el-button--icon') &&
        $('#pfTabTree').length === 1 && $('.pj-filepanel__actions .el-button--icon').length === 8);
    check('条数提示仍在工具栏内且页面级样式把提示保持在最右',
        $('.toolbar .toolbar-hint #pjCount').length === 1 &&
        /\.toolbar--icons \.toolbar-hint \{ margin-left: auto; \}/.test($('style').text()));
    check('项目文件区操作引导区下方的操作说明已去掉，标签栏紧随其后',
        $('.pj-filepanel__hint').length === 0 &&
        $('.pj-filepanel__actions').next().hasClass('pj-filetabs') &&
        !/单击文件行选中|拖到列表末尾空白处|「目录」页可单击选中/.test($('.pj-filepanel').text()),
        String($('.pj-filepanel__hint').length) + ' / ' + String($('.pj-filepanel__actions').next().attr('class')));
    check('表头 11 列且顺序正确',
        $('#pjTable thead th').length === 11 &&
        /项目编号/.test($('#pjTable thead th').eq(2).text()) &&
        /项目名称/.test($('#pjTable thead th').eq(3).text()) &&
        /公用否/.test($('#pjTable thead th').eq(7).text()) &&
        /启用/.test($('#pjTable thead th').eq(10).text()));
    check('分页容器存在', $('#pagerWrap').length === 1);
    check('顶部功能说明卡已移除（页面只留标题 + 检索 + 分栏）',
        $('.pj-tipcard').length === 0 && $('#pageHead + .search-card').length === 1,
        String($('.pj-tipcard').length));
    check('未选择记录时编辑/启停/上传文件/查看项目/删除按钮禁用',
        $('#btnEdit').prop('disabled') === true && $('#btnDelete').prop('disabled') === true &&
        $('#btnView').prop('disabled') === true && $('#btnUpload').prop('disabled') === true);
    check('左右分栏：左栏项目表 / 右栏文件面板（5 列表头 + 项目占位）',
        $('.pj-split').length === 1 && $('.pj-split__left #pjTable').length === 1 &&
        $('#pfPanelTable thead th').length === 5 &&
        $('#pfPanelProject').text() === '未选择项目',
        String($('#pfPanelTable thead th').length));
});

step(function () {
    console.log('\n--- 2. 字典 + 列表（可见性） ---');
    check('右栏文件面板初始空态提示（双击行加载）',
        $('#pfPanelTbody .el-table__empty-text').length === 1 &&
        /双击左侧项目行/.test($('#pfPanelTbody').text()),
        $('#pfPanelTbody').text().slice(0, 60));
    check('项目类型下拉 9 项 + 全部类型', $('#projectType option').length === 10,
        String($('#projectType option').length));
    check('项目状态下拉 5 项 + 全部状态', $('#projectStatus option').length === 6,
        String($('#projectStatus option').length));
    check('类型含「数据分析」「科研」「其它」',
        /数据分析/.test($('#projectType').text()) && /科研/.test($('#projectType').text()) &&
        /其它/.test($('#projectType').text()));
    check('登录后列表 3 条（他人私有 PRO000004 不可见）', rows().length === 3,
        String(rows().length));
    check('本人创建的 / 他人公用的项目都可见',
        /九豆综合管理平台研发/.test($('#pjTbody').text()) &&
        /客户现场实施项目/.test($('#pjTbody').text()));
    check('本人私有但停用的项目仍可见（沉底）',
        /内部测试专项/.test($('#pjTbody').text()), $('#pjTbody').text().replace(/\s+/g, ' ').slice(0, 150));
    check('他人私有项目不出现', !/他人私有/.test($('#pjTbody').text()));
    check('启用项目排在停用项目之前',
        !/停用/.test(rowText(0)) && /停用/.test(rowText(2)), rowText(0) + ' || ' + rowText(2));
    check('列表显示编号 / 类型 / 状态 / 公用否 / 创建人 / 创建时间',
        /PRO000001/.test($('#pjTbody').text()) && /研发/.test($('#pjTbody').text()) &&
        /进行中/.test($('#pjTbody').text()) && /公用/.test($('#pjTbody').text()) &&
        /杨伟康/.test($('#pjTbody').text()) && /2026-11-01/.test($('#pjTbody').text()) &&
        /李明/.test($('#pjTbody').text()),
        $('#pjTbody').text().replace(/\s+/g, ' ').slice(0, 160));
    check('列表显示文件数（PRO000001 挂了 2 个文件）',
        rows().filter(function () { return /PRO000001/.test($(this).text()); }).length === 1 &&
        /2/.test(rows().filter(function () { return /PRO000001/.test($(this).text()); }).eq(0).text()),
        rows().filter(function () { return /PRO000001/.test($(this).text()); }).eq(0).text().replace(/\s+/g, ' '));
    check('顶部条数与分页已渲染', $('#pjCount').text() === '3' &&
        $('#pagerWrap .el-pagination').length === 1, $('#pjCount').text());
});

step(function () {
    console.log('\n--- 3. Mock 层接口 ---');
    Api.project.nextCode().done(function (d) {
        check('nextcode 返回 PRO000005', d.code === 'PRO000005', d.code);
    });
    Api.project.check('projectName', '九豆综合管理平台研发').done(function (d) {
        check('check 同名项目不唯一', d.unique === false);
    });
    Api.project.check('projectName', '一个不存在的名字').done(function (d) {
        check('check 新名称唯一', d.unique === true);
    });
    Api.project.options().done(function (d) {
        var labels = (d.list || []).map(function (x) { return x.label; }).join('|');
        check('options 只含可见且启用的项目（停用的不进下拉）',
            d.list.length === 2 && /PRO000001/.test(labels) && /PRO000002/.test(labels) &&
            !/PRO000003/.test(labels) && !/PRO000004/.test(labels), labels);
    });
});

step(function () {
    console.log('\n--- 4. 检索筛选 ---');
    clickSearch('实施', '', '', '', '');
});
step(function () {
    check('关键字「实施」命中 1 条', rows().length === 1 && /客户现场实施项目/.test($('#pjTbody').text()),
        String(rows().length));
    clickSearch('', '研发', '', '', '');
});
step(function () {
    check('按类型「研发」命中 1 条', rows().length === 1 && /九豆综合管理平台研发/.test($('#pjTbody').text()),
        String(rows().length));
    clickSearch('', '', '已完成', '', '');
});
step(function () {
    check('按状态「已完成」命中本人私有项目 1 条', rows().length === 1 &&
        /内部测试专项/.test($('#pjTbody').text()),
        String(rows().length) + ' ' + $('#pjTbody').text().replace(/\s+/g, ' ').slice(0, 80));
    clickSearch('', '', '', '0', '');
});
step(function () {
    check('按「私有」筛出本人私有项目 1 条', rows().length === 1 &&
        /内部测试专项/.test($('#pjTbody').text()), String(rows().length));
    clickSearch('', '', '', '', '0');
});
step(function () {
    check('按「停用」筛出 1 条', rows().length === 1, String(rows().length));
    $('#btnReset').trigger('click');
});
step(function () {
    check('重置后恢复 3 条', rows().length === 3, String(rows().length));
    check('重置清空全部检索条件',
        $('#keyword').val() === '' && $('#projectType').val() === '' &&
        $('#projectStatus').val() === '' && $('#ispub').val() === '' && $('#enabled').val() === '');
});

step(function () {
    console.log('\n--- 5. 新增 / 编辑「打页」（框架新页签，不再弹窗） ---');
    check('列表页已移除弹窗表单模板 projectFormTpl', $('#projectFormTpl').length === 0,
        String($('#projectFormTpl').length));
    check('列表页没有遗留弹窗 DOM', $('.el-overlay .el-dialog').length === 0);
    check('页面不再有顶部说明文案（.pj-tip 已移除）', $('.pj-tip').length === 0,
        String($('.pj-tip').length));
    win.__lastNav = '';
    $('#btnAdd').trigger('click');
    check('点「新增」→ project-form.html?mode=add',
        String(win.__lastNav) === 'project-form.html?mode=add', String(win.__lastNav));
    check('新增不再弹窗', $('.el-overlay .el-dialog').length === 0);
    rows().eq(0).trigger('click');
    win.__lastNav = '';
    $('#btnEdit').trigger('click');
    check('点「编辑」→ project-form.html?mode=edit&id=<UUID>',
        /^project-form\.html\?mode=edit&id=/.test(String(win.__lastNav)) &&
        String(win.__lastNav).indexOf(rows().eq(0).attr('data-id')) >= 0,
        String(win.__lastNav));
    win.__lastNav = '';
    rows().eq(1).trigger('dblclick');
    check('双击行不再打页（改为刷新右栏文件面板）',
        String(win.__lastNav || '') === '' && $('.el-overlay .el-dialog').length === 0,
        String(win.__lastNav));
    check('双击后右栏标题切到当前项目', /九豆综合管理平台研发/.test($('#pfPanelProject').text()) &&
        /PRO000001/.test($('#pfPanelProject').text()), $('#pfPanelProject').text());
    /* 表单页保存走 Api.project.add；列表页刷新后应拿到同样的结果 */
    Api.project.add({
        projectName: '__项目测试__新增', projectType: '数据分析', projectStatus: '进行中',
        projectDesc: '<p>jsdom <b>自动化</b>新增</p>', ispub: 0, enabled: 1
    });
});
step(function () {
    $('#btnRefresh').trigger('click');
});
step(function () {
    console.log('\n--- 6. 表单页保存结果回写列表 ---');
    var $new = rows().filter(function () { return /__项目测试__新增/.test($(this).text()); });
    check('列表出现新项目', $new.length === 1, String($new.length));
    check('双击行的右栏文件面板已加载（PRO000001 的 2 个文件，按文件名排序）',
        $('#pfPanelTbody tr[data-id]').length === 2 &&
        /架构设计\.png/.test($('#pfPanelTbody tr[data-id]').eq(0).text()) &&
        /需求规格说明书\.docx/.test($('#pfPanelTbody tr[data-id]').eq(1).text()),
        $('#pfPanelTbody').text().replace(/\s+/g, ' ').slice(0, 120));
    check('新项目编号由后端生成 PRO000005（忽略前端传值）',
        /PRO000005/.test($new.text()), $new.text().replace(/\s+/g, ' ').slice(0, 120));
    check('新项目按「私有」显示且类型为数据分析',
        /私有/.test($new.text()) && /数据分析/.test($new.text()),
        $new.text().replace(/\s+/g, ' ').slice(0, 140));
    check('列表 title 用富文本纯文本摘要（不含 HTML 标签）',
        /jsdom 自动化新增/.test($new.attr('title') || '') && !/<b>/.test($new.attr('title') || ''),
        String($new.attr('title')));
    check('总数变为 4 条', $('#pjCount').text() === '4', $('#pjCount').text());
    win.__newId = $new.attr('data-id');
    Api.project.update({
        id: win.__newId, projectName: '__项目测试__改名', projectType: '科研',
        projectStatus: '已完成', projectDesc: '<p>改名后的说明</p>',
        ispub: 1, enabled: 0, projectCode: 'HACK001'
    });
});
step(function () {
    $('#btnRefresh').trigger('click');
});
step(function () {
    var $edited = rows().filter(function () { return /__项目测试__改名/.test($(this).text()); });
    check('编辑后列表更新名称 / 类型 / 状态 / 公用 / 停用',
        $edited.length === 1 && /科研/.test($edited.text()) && /已完成/.test($edited.text()) &&
        /公用/.test($edited.text()) && /停用/.test($edited.text()),
        $edited.text().replace(/\s+/g, ' ').slice(0, 150));
    check('编号没有被改动（仍是 PRO000005，前端传 projectCode 被忽略）',
        /PRO000005/.test($edited.text()) && !/HACK001/.test($edited.text()),
        $edited.text().replace(/\s+/g, ' ').slice(0, 100));
});

step(function () {
    console.log('\n--- 7. 启停 / 查看项目 / 删除 ---');
    rows().filter(function () { return /__项目测试__改名/.test($(this).text()); }).trigger('click');
    check('选中停用记录后「停用」按钮禁用、「启用」可用',
        $('#btnEnable').prop('disabled') === false && $('#btnDisable').prop('disabled') === true);
    $('#btnView').trigger('click');
    check('「查看项目」跳转到 project-detail.html 且带 id',
        /project-detail\.html\?id=/.test(String(win.__lastNav || '')) &&
        String(win.__lastNav).indexOf(win.__newId) >= 0, String(win.__lastNav));
    $('#btnEnable').trigger('click');
});
step(function () {
    var $edited = rows().filter(function () { return /__项目测试__改名/.test($(this).text()); });
    check('启用后状态变为「启用」', /启用/.test($edited.text()),
        $edited.text().replace(/\s+/g, ' ').slice(0, 120));
    rows().filter(function () { return /__项目测试__改名/.test($(this).text()); }).trigger('click');
    $('#btnDelete').trigger('click');
    check('删除弹确认框且提示会级联清理文件',
        msgBox().length === 1 && /删除项目/.test(msgBox().text()), msgBox().text().slice(0, 80));
    msgBox().find('.btn-ok').trigger('click');
});
step(function () {
    check('删除后列表恢复 3 条', rows().length === 3 && !/__项目测试__/.test($('#pjTbody').text()),
        String(rows().length));
    check('删除后选中态清空、操作按钮禁用',
        $('#btnEdit').prop('disabled') === true && $('#btnDelete').prop('disabled') === true);
});

step(function () {
    console.log('\n--- 8. 双击刷新右栏（按文件名排序） / 详情页可见性 ---');
    // 给 PRO000001 注入一个「B方案说明.txt」（上传时间最新，但按文件名应排在最前）
    var raw = win.localStorage.getItem('menu_admin_projectfiles_v1');
    var files = JSON.parse(raw) || [];
    files.push({
        id: 'pfl-0000-4000-8000-000000000009', projectId: 'prj-0000-4000-8000-000000000001',
        projectCode: 'PRO000001', projectName: '九豆综合管理平台研发',
        fileName: 'B方案说明.txt', filePath: 'data/projectfiles/demo/b.txt',
        fileType: '文档', fileSize: 1200, fileDesc: '', ispub: true,
        uploadEname: '杨伟康', uploadempinfosid: 3, enabled: true,
        uploadTime: '2026-11-04 09:00:00', createTime: '2026-11-04 09:00:00',
        updateTime: '2026-11-04 09:00:00'
    });
    win.localStorage.setItem('menu_admin_projectfiles_v1', JSON.stringify(files));
    win.__lastNav = '';
    rows().filter(function () { return /PRO000001/.test($(this).text()); }).trigger('dblclick');
    check('双击行打开的不是编辑页签（不再打页）',
        String(win.__lastNav || '') === '', String(win.__lastNav));
    check('双击后右栏标题切到 PRO000001',
        /九豆综合管理平台研发/.test($('#pfPanelProject').text()) &&
        /PRO000001/.test($('#pfPanelProject').text()), $('#pfPanelProject').text());
    // 他人私有项目详情也应被可见性挡住
    Api.project.detail('prj-0000-4000-8000-000000000004').fail(function (err) {
        check('他人私有项目 detail 返回 404（可见性同样生效）',
            !!err && /不存在/.test(err.message), err && err.message);
    });
});
step(function () {
    var names = $('#pfPanelTbody tr[data-id]').map(function () {
        return $(this).find('td').eq(1).find('b').text();
    }).get();
    check('右栏 3 个文件按文件名升序（B方案说明 / 架构设计 / 需求规格说明书）',
        names.join('|') === 'B方案说明.txt|架构设计.png|需求规格说明书.docx', names.join('|'));
});

next();
