/* ==========================================================================
   project-detail-test.js —— 项目详情页 + 项目信息页右栏文件操作（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖：
     ① 项目信息页右栏工具栏：检索框 + 上传/启用/停用/删除 按钮存在，且按选中态联动；
     ② 选中文件行后，启用/停用/删除 按钮由禁用变为可用；
     ③ 项目详情页 project-detail.html：左栏「项目基本信息 / 项目说明」双 Tab、右栏「文件列表 / 目录」双标签
        （目录树渲染 / 展开折叠 / 选中不重建 / 双击预览 / 拖拽移动目录 / 检索联动）；
     ④ pptx 标题提取：含 <p:ph type="title"> 的占位符被识别为标题（slidesToHtml 输出 fp-slide__title）。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/project-detail-test.js
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
        var d = win.jQuery.Deferred(); d.reject({}, 'error', ''); return d.promise();
    };
    win.eval(read('js/api.js'));
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'mock-token', user: { empId: 3, nameCn: '杨伟康' }
    }));
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/word-import.js'));
    win.eval(read('js/file-preview.js'));
    win.AppNav = win.AppNav || {};
    win.AppNav.go = function (u) { win.__lastNav = u; };
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

/* ---------------- 手工构造 stored ZIP（method=0，与 project-panel-test 同款） ---------------- */
function makeZip(files) {
    var locals = [], centrals = [], offset = 0;
    Object.keys(files).forEach(function (name) {
        var nameBuf = Buffer.from(name, 'utf8');
        var data = Buffer.from(files[name], 'utf8');
        var local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(0, 14);
        local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
        var one = Buffer.concat([local, nameBuf, data]);
        var cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt32LE(0, 16);
        cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([cd, nameBuf]));
        locals.push(one); offset += one.length;
    });
    var cdBuf = Buffer.concat(centrals);
    var eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8);
    eocd.writeUInt16LE(Object.keys(files).length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([Buffer.concat(locals), cdBuf, eocd]);
}
var PPTX = makeZip({
    'ppt/slides/slide1.xml':
        '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<p:cSld><p:spTree>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/>' +
        '<p:cNvSpPr><a:spPr/><p:ph type="title" idx="0"/></p:cNvSpPr></p:nvSpPr>' +
        '<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>标题文本</a:t></a:r></a:p></p:txBody></p:sp>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Text 2"/>' +
        '<p:cNvSpPr><a:spPr/></p:cNvSpPr></p:nvSpPr>' +
        '<p:spPr/><p:txBody><a:bodyPr/>' +
        '<a:p><a:r><a:t>正文要点一</a:t></a:r></a:p>' +
        '<a:p><a:r><a:t>正文要点二</a:t></a:r></a:p></p:txBody></p:sp>' +
        '</p:spTree></p:cSld></p:sld>'
});

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
var projWin = null, detailWin = null;

step(function () {
    console.log('\n--- 1. 项目信息页右栏工具栏 ---');
    projWin = boot('project.html', ['js/project.js']);
    var $ = projWin.jQuery;
    check('右栏检索框与按钮存在',
        $('#pfKeyword').length === 1 && $('#btnPfSearch').length === 1 &&
        $('#btnPfUpload').length === 1 && $('#btnPfEnable').length === 1 &&
        $('#btnPfDisable').length === 1 && $('#btnPfDelete').length === 1);
    check('检索区独占一行：只放检索框 + 搜索按钮',
        $('#pfKeyword').parent().hasClass('pj-filepanel__toolbar') &&
        $('.pj-filepanel__toolbar .el-button').length === 1 &&
        $('.pj-filepanel__toolbar #btnPfSearch').length === 1);
    check('操作引导区独立成行，含 5 个文件 + 3 个目录共 8 个图标按钮',
        $('.pj-filepanel__actions').length === 1 &&
        $('.pj-filepanel__actions .el-button').length === 8 &&
        $('.pj-filepanel__actions .el-button--icon').length === 8 &&
        ['#btnPfUpload', '#btnPfEnable', '#btnPfDisable', '#btnPfDelete', '#btnPfDownload',
         '#btnDirAdd', '#btnDirEdit', '#btnDirDelete']
            .every(function (id) { return $(id).closest('.pj-filepanel__actions').length === 1; }));
    check('目录按钮与文件按钮之间有视觉分隔',
        $('.pj-filepanel__actions .pj-filepanel__actions-sep').length === 1);
    check('文件区含「文件列表 / 目录」两个标签页与树容器',
        $('#pfTabList').length === 1 && $('#pfTabTree').length === 1 && $('#pfTreeView').length === 1 &&
        $.trim($('#pfTabTree').text()) === '目录',
        $('#pfTabList').text() + ' / ' + $('#pfTabTree').text());
    check('上传弹窗模板的所属目录是下拉框（不再是树）',
        $('#pjUploadTpl #upDirId').length === 1 && $('#pjUploadTpl #upDirId').is('select') &&
        $('#upDirTree').length === 0 && $('#upDirClear').length === 0);
    check('存在目录维护弹窗模板（上级 / 名称 / 说明 / 公开 / 启用）',
        $('#pjDirTpl #dirParent').length === 1 && $('#pjDirTpl #dirName').length === 1 &&
        $('#pjDirTpl #dirDesc').length === 1 && $('#pjDirTpl #dirIspub').length === 1 &&
        $('#pjDirTpl #dirEnabled').length === 1);
    check('操作引导区按钮均为纯图标（无文字），且都有 title/aria-label',
        $('.pj-filepanel__actions .el-button').filter(function () {
            return $.trim($(this).text()) !== '' ||
                !$(this).attr('title') || !$(this).attr('aria-label');
        }).length === 0);
    check('未选中项目时「上传文件」按钮禁用', $('#btnPfUpload').prop('disabled') === true);
    check('未选中文件时「下载」按钮禁用', $('#btnPfDownload').prop('disabled') === true);
});
step(function () {
    var $ = projWin.jQuery;
    var $row = $('#pjTbody tr[data-id]').filter(function () {
        return /PRO000001/.test($(this).text());
    });
    check('存在 PRO000001 项目行', $row.length === 1);
    $row.trigger('click');
    $row.trigger('dblclick');   // 触发右栏文件列表加载（异步 Mock）
});
step(function () {
    var $ = projWin.jQuery;
    check('选中项目后「上传文件」按钮可用', $('#btnPfUpload').prop('disabled') === false);
    check('右栏文件面板已加载（>=1 行）', $('#pfPanelTbody tr[data-id]').length >= 1,
        String($('#pfPanelTbody tr[data-id]').length));
    check('未选中文件时启停/删除按钮禁用',
        $('#btnPfEnable').prop('disabled') === true &&
        $('#btnPfDisable').prop('disabled') === true &&
        $('#btnPfDelete').prop('disabled') === true);
    $('#pfPanelTbody tr[data-id]').first().trigger('click');   // 选中第一个文件行
});
step(function () {
    var $ = projWin.jQuery;
    check('选中文件行后文件操作变为可用（删除可用，启用/停用按文件状态二选一）',
        $('#btnPfDelete').prop('disabled') === false &&
        ($('#btnPfEnable').prop('disabled') !== $('#btnPfDisable').prop('disabled')),
        'delete=' + $('#btnPfDelete').prop('disabled') +
        ' enable=' + $('#btnPfEnable').prop('disabled') +
        ' disable=' + $('#btnPfDisable').prop('disabled'));
    // 下载只对「已启用」文件开放：逐个选中，找到启用态的一行
    var found = false;
    $('#pfPanelTbody tr[data-id]').each(function () {
        $(this).trigger('click');
        if ($('#btnPfEnable').prop('disabled') === true) { found = true; return false; }  // 已启用
    });
    check('选中已启用文件后「下载」按钮可用', found && $('#btnPfDownload').prop('disabled') === false,
        'found=' + found + ' dl=' + $('#btnPfDownload').prop('disabled'));
});

step(function () {
    console.log('\n--- 2. 项目详情页渲染 ---');
    detailWin = boot('project-detail.html', ['js/project-detail.js'],
        'http://127.0.0.1:8808/project-detail.html?id=prj-0000-4000-8000-000000000001');
});
step(function () {
    var $ = detailWin.jQuery;
    check('左栏渲染出项目基本信息（含项目编号字段）',
        /PRO000001/.test($('#pjDetailBody').text()) && /项目编号/.test($('#pjDetailBody').text()),
        $('#pjDetailBody').text().slice(0, 80));
    check('右栏渲染出关联文件列表（>=1 行）', $('#pfPanelTbody tr[data-id]').length >= 1,
        String($('#pfPanelTbody tr[data-id]').length));
    check('右栏检索框与搜索按钮存在', $('#pfKeyword').length === 1 && $('#btnPfSearch').length === 1);
});

step(function () {
    console.log('\n--- 2.1 左栏：项目基本信息 / 项目说明双 Tab ---');
    var $ = detailWin.jQuery;
    check('左栏存在三个标签页按钮，文案为「项目基本信息 / 项目说明 / 工作计划」',
        $('#dtTabs .pj-filetabs__tab').length === 3 &&
        $.trim($('#dtTabInfo').text()) === '项目基本信息' &&
        $.trim($('#dtTabDesc').text()) === '项目说明' &&
        $.trim($('#dtTabPlans').text()) === '工作计划',
        $('#dtTabInfo').text() + ' / ' + $('#dtTabDesc').text() + ' / ' + $('#dtTabPlans').text());
    check('默认展示「项目基本信息」Tab，说明面板隐藏',
        $('#dtTabInfo').hasClass('is-active') && !$('#dtTabDesc').hasClass('is-active') &&
        $('#pjDetailBody').css('display') !== 'none' && $('#pjDescBody').css('display') === 'none' &&
        $('#dtTabInfo').attr('aria-selected') === 'true');
    check('基本信息 Tab 不再混入项目说明正文（说明已拆到另一个 Tab）',
        !/一体化综合管理平台/.test($('#pjDetailBody').text()) &&
        !/项目说明/.test($('#pjDetailBody').text()),
        $('#pjDetailBody').text().slice(0, 80));
    $('#dtTabDesc').trigger('click');
    check('切到「项目说明」Tab 后说明面板显示、基本信息面板隐藏',
        $('#dtTabDesc').hasClass('is-active') && !$('#dtTabInfo').hasClass('is-active') &&
        $('#pjDescBody').css('display') !== 'none' && $('#pjDetailBody').css('display') === 'none' &&
        $('#dtTabDesc').attr('aria-selected') === 'true');
    check('说明 Tab 渲染说明标题与正文（富文本容器）',
        /项目说明/.test($('#pjDescBody').text()) && /一体化综合管理平台/.test($('#pjDescBody').text()) &&
        $('#pjDescBody .pj-detail__desc-box').length === 1,
        $('#pjDescBody').text().slice(0, 80));
    $('#dtTabInfo').trigger('click');
    check('切回「项目基本信息」Tab 恢复字段表',
        $('#pjDetailBody').css('display') !== 'none' && $('#pjDescBody').css('display') === 'none' &&
        /项目编号/.test($('#pjDetailBody').text()));
    $('#dtTabPlans').trigger('click');
    check('切到「工作计划」Tab 显示计划面板（只读）',
        $('#pjPlansBody').css('display') !== 'none' && $('#pjDetailBody').css('display') === 'none' &&
        $('#dtTabPlans').hasClass('is-active') && $('#dtPlansGoto').length === 1);
});

step(function () {
    console.log('\n--- 2.2 右栏：「文件列表 / 目录」双标签 ---');
    var $ = detailWin.jQuery;
    check('「工作计划」Tab 表格显示项目内计划（编号 / 任务数 / 状态）',
        $('#pjPlansTbody tr[data-id]').length > 0 &&
        /WP000001/.test($('#pjPlansTbody').text()) &&
        $('#pjPlansCount').text() !== '0' &&
        $('#pjPlansTable thead').text().indexOf('计划编号') > -1,
        $('#pjPlansTbody').text().replace(/\s+/g, ' ').slice(0, 80));
    $('#pjPlansTbody tr[data-id]').first().trigger('dblclick');
    var $dlg = $('.el-dialog').last();
    check('双击计划弹出计划工单对话框（最大化 / 只读表格）',
        $dlg.length === 1 &&
        /计划/.test($dlg.find('.el-dialog__title').text()) &&
        $dlg.hasClass('is-max') &&
        $dlg.find('.pj-plan-orders__table').length === 1 &&
        $dlg.find('.pj-plan-dialog__tab').length === 2 &&
        $dlg.find('.btn-ok').is('[hidden]'),
        $dlg.find('.el-dialog__title').text());
    $dlg.find('.pj-plan-dialog__tab[data-ptab="plan"]').trigger('click');
    var frameSrc = $dlg.find('#pjPlanFrame').attr('src') || '';
    check('「工作计划」标签内嵌原工作计划页（甘特图 / 日历图 / 网格统一）',
        frameSrc.indexOf('workplan-design.html?id=') >= 0 &&
        frameSrc.indexOf('embed=1') >= 0,
        frameSrc);
    $dlg.find('.btn-cancel').trigger('click');
    $('#dtTabInfo').trigger('click');
    check('文件区存在两个标签页，文案为「文件列表 / 目录」',
        $('#pfTabs .pj-filetabs__tab').length === 2 &&
        $.trim($('#pfTabList').text()) === '文件列表' && $.trim($('#pfTabTree').text()) === '目录');
    check('默认展示文件列表、目录树隐藏',
        $('#pfTabList').hasClass('is-active') && $('#pfPanelWrapper').css('display') !== 'none' &&
        $('#pfTreeView').css('display') === 'none');
    $('#pfTabTree').trigger('click');
    check('切到「目录」后树显示、列表隐藏',
        $('#pfTabTree').hasClass('is-active') && $('#pfTreeView').css('display') !== 'none' &&
        $('#pfPanelWrapper').css('display') === 'none');
    check('目录树渲染出 3 个可见目录（他人私有目录不可见）',
        $('#pfTreeView .pj-tnode--dir').length === 3,
        String($('#pfTreeView .pj-tnode--dir').length));
    check('目录树渲染出 2 个文件节点，且可拖拽',
        $('#pfTreeView .pj-tnode--file').length === 2 &&
        $('#pfTreeView .pj-tnode--file[draggable=true]').length === 2,
        String($('#pfTreeView .pj-tnode--file').length));
    check('与项目管理页一致：无「项目根目录」节点、末尾有「移出目录」提示条',
        $('#pfTreeView .pj-tnode[data-kind=root]').length === 0 &&
        !/项目根目录/.test($('#pfTreeView').text()) &&
        $('#pfTreeView .pj-tree__rootdrop').length === 1);
    check('文件区标题回填了项目名称 / 编号',
        /九豆综合管理平台研发/.test($('#pfPanelProject').text()) &&
        /PRO000001/.test($('#pfPanelProject').text()), $('#pfPanelProject').text());
});

step(function () {
    console.log('\n--- 2.3 目录树：展开折叠 / 选中不重建 / 双击预览 ---');
    var $ = detailWin.jQuery;
    var before = $('#pfTreeView .pj-tnode--dir').length;
    $('#pfTreeView .pj-tnode--dir').find('.pj-tnode__caret.is-clickable').first().trigger('click');
    check('折叠目录后子目录节点隐藏', $('#pfTreeView .pj-tnode--dir').length < before,
        before + ' → ' + $('#pfTreeView .pj-tnode--dir').length);
    $('#pfTreeView .pj-tnode--dir').find('.pj-tnode__caret.is-clickable').first().trigger('click');
    check('再次展开后节点数恢复', $('#pfTreeView .pj-tnode--dir').length === before,
        String($('#pfTreeView .pj-tnode--dir').length));

    var $f = $('#pfTreeView .pj-tnode--file').filter(function () {
        return /架构设计\.png/.test($(this).text());
    }).first();
    check('找到「架构设计.png」文件节点', $f.length === 1);
    var raw = $f[0];
    $f.trigger('click');
    var $after = $('#pfTreeView .pj-tnode--file').filter(function () {
        return /架构设计\.png/.test($(this).text());
    }).first();
    check('单击文件节点只就地改选中态、不重建节点（保住双击预览）',
        $after.length === 1 && $after[0] === raw && $after.hasClass('is-selected'));
    check('选中树中文件会同步高亮列表行',
        $('#pfPanelTbody tr[data-id="' + $after.attr('data-id') + '"]').hasClass('is-selected'));
    $after.trigger('dblclick');
});

step(function () {
    var $ = detailWin.jQuery;
    var $dlg = $('.el-dialog').last();
    check('双击目录树文件节点弹出预览弹窗（标题为文件名）',
        $dlg.length === 1 && /架构设计\.png/.test($dlg.find('.el-dialog__title').text()) &&
        $dlg.find('.fp-img').length === 1,
        $dlg.find('.el-dialog__title').text());
    $dlg.find('.el-dialog__headerbtn').not('.el-dialog__headerbtn--max').trigger('click');
});

step(function () {
    console.log('\n--- 2.4 目录树：拖拽到非空目录（按坐标解析落点） ---');
    var $ = detailWin.jQuery, doc = detailWin.document;
    var $child = $('#pfTreeView .pj-tnode--file').filter(function () {
        return /需求规格说明书\.docx/.test($(this).text());
    }).first();
    var $src = $('#pfTreeView .pj-tnode--file').filter(function () {
        return /架构设计\.png/.test($(this).text());
    }).first();
    check('非空目录「需求文档」下有子文件节点，源文件可拖',
        $child.length === 1 && $src.length === 1);
    var ROOT_DIR = 'pdr-0000-4000-8000-000000000001';
    var real = doc.elementFromPoint;
    doc.elementFromPoint = function () { return $child[0]; };
    var Api = detailWin.Api, orig = Api.projectFile.update;
    detailWin.__payload = null;
    Api.projectFile.update = function (p) {
        detailWin.__payload = p;
        return orig.call(Api.projectFile, p);
    };
    $src.trigger('dragstart');
    var view = $('#pfTreeView')[0];
    var over = new detailWin.MouseEvent('dragover',
        { bubbles: true, cancelable: true, clientX: 140, clientY: 260 });
    view.dispatchEvent(over);
    check('落在子文件行上 dragover 被阻止默认行为，且高亮其所属目录行',
        over.defaultPrevented === true &&
        $('#pfTreeView .pj-tnode--dir[data-id="' + ROOT_DIR + '"]').hasClass('is-drop-target'));
    view.dispatchEvent(new detailWin.MouseEvent('drop',
        { bubbles: true, cancelable: true, clientX: 140, clientY: 260 }));
    $src.trigger('dragend');
    doc.elementFromPoint = real;
    Api.projectFile.update = orig;
    check('提交的 dirId 是子文件所属的「需求文档」',
        detailWin.__payload && String(detailWin.__payload.dirId) === ROOT_DIR,
        JSON.stringify(detailWin.__payload));
});

step(function () {
    var $ = detailWin.jQuery;
    check('移动成功后拖拽态已清理',
        !$('#pfTreeView').hasClass('is-dragging') && $('#pfTreeView .is-drop-target').length === 0);
    detailWin.Api.projectFile.detail('pfl-0000-4000-8000-000000000002').done(function (d) {
        check('文件 dirId 已更新为「需求文档」', String(d.dirId) === 'pdr-0000-4000-8000-000000000001',
            String(d.dirId));
    });
    /* 检索联动：目录树只显示命中文件 */
    $('#pfKeyword').val('架构');
    $('#btnPfSearch').trigger('click');
});

step(function () {
    var $ = detailWin.jQuery;
    check('检索后目录树只保留命中的文件节点',
        $('#pfTreeView .pj-tnode--file').length === 1 &&
        /架构设计\.png/.test($('#pfTreeView .pj-tnode--file').text()),
        String($('#pfTreeView .pj-tnode--file').length));
    check('目录节点仍在（检索只过滤文件，不删目录）',
        $('#pfTreeView .pj-tnode--dir').length === 3,
        String($('#pfTreeView .pj-tnode--dir').length));
    $('#pfKeyword').val('');
    $('#btnPfSearch').trigger('click');
});

step(function () {
    console.log('\n--- 3. pptx 标题提取 ---');
    var FP = boot('project.html', ['js/project.js']).FilePreview;
    var ab = PPTX.buffer.slice(PPTX.byteOffset, PPTX.byteOffset + PPTX.byteLength);
    FP.pptxToSlides(ab).then(function (slides) {
        check('解析出 1 页', slides.length === 1 && slides[0].no === 1,
            JSON.stringify(slides.map(function (s) { return s.no; })));
        check('标题占位符被识别为标题', slides[0].title === '标题文本', JSON.stringify(slides[0].title));
        check('正文段落被提取（标题文本 / 正文要点一 / 二）',
            slides[0].paragraphs.join('|') === '标题文本|正文要点一|正文要点二',
            JSON.stringify(slides[0].paragraphs));
        var html = FP.slidesToHtml(slides);
        check('slidesToHtml 输出标题块（fp-slide__title）', /fp-slide__title">标题文本</.test(html), html.slice(0, 160));
        check('slidesToHtml 保留页号结构', /fp-slide__no">第 1 页</.test(html));
    }, function (e) { check('pptx 解析成功', false, String(e && e.message)); });
});

next();
