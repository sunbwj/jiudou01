/* ==========================================================================
   project-panel-test.js —— 项目信息页左右分栏 / 上传弹窗 / 文件在线预览（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖：
     ① 工具栏「上传文件」按钮：未选中禁用 → 选中可用；上传弹窗骨架与项目只读带出；
     ② 上传闭环：FileReader 读入 base64 → 确定上传 → 右栏文件面板刷新出现新文件；
     ③ 右栏文件面板：双击文件行弹出预览（图片 .fp-img）；
     ④ 预览分流：kindOf 扩展名映射（image/pdf/text/word/excel/ppt/download）；
     ⑤ 其它格式（.zip）直接下载：预览弹窗不出现、走 /projectfile/download；
     ⑥ FilePreview.xlsxToSheets：stored ZIP 手工拼 xlsx（sharedStrings + workbook +
        rels + 两个 sheet，覆盖共享字符串 / 数字 / inlineStr / 布尔）+ sheetsToHtml；
     ⑦ FilePreview.pptxToSlides：两页 <a:t> 文本提取 + slidesToHtml。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/project-panel-test.js
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

/* ---------------- 手工构造 stored ZIP（method=0，CRC 不校验，与 word-import-test 同款） ---------------- */
function makeZip(files) {
    var locals = [], centrals = [], offset = 0;
    Object.keys(files).forEach(function (name) {
        var nameBuf = Buffer.from(name, 'utf8');
        var data = Buffer.from(files[name], 'utf8');
        var local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(0, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        var one = Buffer.concat([local, nameBuf, data]);
        var cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0, 8);
        cd.writeUInt16LE(0, 10);
        cd.writeUInt32LE(0, 16);
        cd.writeUInt32LE(data.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([cd, nameBuf]));
        locals.push(one);
        offset += one.length;
    });
    var cdBuf = Buffer.concat(centrals);
    var eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Object.keys(files).length, 8);
    eocd.writeUInt16LE(Object.keys(files).length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([Buffer.concat(locals), cdBuf, eocd]);
}

var XLSX = makeZip({
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst><si><t>名称</t></si><si><t>架构</t></si></sst>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="总览" sheetId="1" r:id="rId1"/><sheet name="明细" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2"><v>12.5</v></c><c r="B2" t="inlineStr"><is><t>直接文本</t></is></c>' +
        '<c r="C2" t="b"><v>1</v></c></row>' +
        '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>明细页</t></is></c></row>' +
        '</sheetData></worksheet>'
});
var PPTX = makeZip({
    'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第一页标题</a:t></a:r></a:p><a:p><a:r><a:t>副标题要点</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide2.xml': '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第二页内容</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
});

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
        token: 'mock-token', user: { empId: 3, nameCn: '杨伟康' }
    }));
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/word-import.js'));
    win.eval(read('js/file-preview.js'));
    win.AppNav.go = function (url2) { win.__lastNav = url2; };
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

var win = boot('project.html', ['js/project.js']);
var $ = win.jQuery;
var Api = win.Api;
var FP = win.FilePreview;

function rows() { return $('#pjTbody tr[data-id]'); }
function pfRows() { return $('#pfPanelTbody tr[data-id]'); }
function toast() { return $('.el-message-list').text(); }
function lastDialog() { return $('.el-overlay .el-dialog').last(); }
function closeDialogs() {
    $('.el-dialog__headerbtn').not('.el-dialog__headerbtn--max').trigger('click');
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
    console.log('\n--- 1. kindOf 扩展名分流 ---');
    check('WordImport.zipHelpers 已导出（xlsx/pptx 复用）',
        !!(win.WordImport && win.WordImport.zipHelpers && win.WordImport.zipHelpers.zipEntries));
    check('图片扩展名 → image',
        ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.bmp', 'f.webp', 'g.svg']
            .every(function (n) { return FP.kindOf(n) === 'image'; }));
    check('pdf → pdf', FP.kindOf('说明.pdf') === 'pdf');
    check('文本扩展名 → text',
        ['a.txt', 'b.log', 'c.md', 'd.csv', 'e.json', 'f.xml'].every(function (n) {
            return FP.kindOf(n) === 'text';
        }));
    check('docx/docm/doc → word', FP.kindOf('a.docx') === 'word' &&
        FP.kindOf('b.docm') === 'word' && FP.kindOf('c.doc') === 'word');
    check('xlsx/xlsm/xls → excel', FP.kindOf('a.xlsx') === 'excel' &&
        FP.kindOf('b.xlsm') === 'excel' && FP.kindOf('c.xls') === 'excel');
    check('pptx/ppt → ppt', FP.kindOf('a.pptx') === 'ppt' && FP.kindOf('b.ppt') === 'ppt');
    check('其它格式 → download（zip/rar/exe/无扩展名）',
        FP.kindOf('a.zip') === 'download' && FP.kindOf('b.rar') === 'download' &&
        FP.kindOf('c') === 'download' && FP.kindOf('') === 'download');
});

step(function () {
    console.log('\n--- 2. 上传按钮与弹窗骨架 ---');
    check('未选中项目时「上传文件」按钮禁用', $('#btnUpload').prop('disabled') === true);
    $('#btnUpload').trigger('click');
    check('未选中时点击只给警告、不弹窗',
        /请先选择/.test(toast()) && $('.el-overlay .el-dialog').length === 0, toast());
    rows().filter(function () { return /PRO000001/.test($(this).text()); }).trigger('click');
    check('选中项目后「上传文件」按钮可用', $('#btnUpload').prop('disabled') === false);
    $('#btnUpload').trigger('click');
    check('弹出「上传项目文件」弹窗并带项目名',
        lastDialog().length === 1 &&
        /上传项目文件 —— 九豆综合管理平台研发/.test(lastDialog().find('.el-dialog__title').text()),
        lastDialog().find('.el-dialog__title').text());
    var $dlg = lastDialog();
    check('所属项目只读带出（编号 + 名称）',
        $dlg.find('#upProject').prop('readonly') === true &&
        /九豆综合管理平台研发/.test($dlg.find('#upProject').val()) &&
        /PRO000001/.test($dlg.find('#upProject').val()), String($dlg.find('#upProject').val()));
    win.__upDlg = $dlg;
});
step(function () {
    console.log('\n--- 2b. 弹窗字段与拦截 ---');
    var $dlg = win.__upDlg;
    check('文件类型下拉来自文件类型字典（7 项）',
        $dlg.find('#upType option').length === 7, String($dlg.find('#upType option').length));
    check('确定时未选文件给警告', (function () {
        $dlg.find('.btn-ok').trigger('click');
        return /请选择要上传的文件/.test(toast());
    })());
    /* 注入 10 MB 超限文件 → 拦截 */
    var big = new win.File([new win.Uint8Array(10 * 1024 * 1024 + 1)], '大文件.txt');
    Object.defineProperty($dlg.find('#upFile')[0], 'files', { value: [big], configurable: true });
    $dlg.find('#upFile').trigger('change');
    check('超过 10 MB 的文件被拦截并提示',
        /10 MB/.test(toast()) && $dlg.find('#upData').val() === '', toast());
    closeDialogs();
    /* 重新打开并注入正常文件（异步 FileReader，下一步断言） */
    $('#btnUpload').trigger('click');
    $dlg = lastDialog();
    var small = new win.File([new win.Uint8Array([104, 101, 108, 108, 111])], '会议纪要.txt');
    Object.defineProperty($dlg.find('#upFile')[0], 'files', { value: [small], configurable: true });
    $dlg.find('#upFile').trigger('change');
    win.__upDlg = $dlg;
});
step(function () {
    console.log('\n--- 3. 上传闭环 ---');
    var $dlg = win.__upDlg;
    check('FileReader 读出 base64 并自动带入文件名',
        /^data:/.test($dlg.find('#upData').val()) &&
        $dlg.find('#upName').val() === '会议纪要.txt' &&
        /已选择：会议纪要\.txt/.test($dlg.find('#upFileTip').text()),
        String($dlg.find('#upData').val()).slice(0, 40));
    $dlg.find('#upType').val('文档');
    $dlg.find('#upDesc').val('jsdom 面板测试上传');
    $dlg.find('.btn-ok').trigger('click');
});
step(function () {
    check('上传成功提示带文件名', /会议纪要\.txt.*上传成功|上传成功/.test(toast()), toast());
    var $hit = pfRows().filter(function () { return /会议纪要\.txt/.test($(this).text()); });
    check('右栏文件面板出现刚上传的文件（3 行）', pfRows().length === 3 && $hit.length === 1,
        String(pfRows().length));
    check('左列表 PRO000001 的文件数同步为 3',
        rows().filter(function () { return /PRO000001/.test($(this).text()); })
            .find('td').eq(6).text() === '3',
        rows().filter(function () { return /PRO000001/.test($(this).text()); })
            .find('td').eq(6).text());
    check('右栏按文件名排序（会议纪要 排在 架构设计 之前、需求规格说明书 之前）',
        pfRows().eq(0).text().indexOf('会议纪要.txt') >= 0 &&
        pfRows().eq(1).text().indexOf('架构设计.png') >= 0 &&
        pfRows().eq(2).text().indexOf('需求规格说明书.docx') >= 0,
        pfRows().map(function () { return $(this).find('td').eq(1).find('b').text(); }).get().join('|'));
});

step(function () {
    console.log('\n--- 4. 双击文件行预览（图片 / 文本） ---');
    var $png = pfRows().filter(function () { return /架构设计\.png/.test($(this).text()); });
    $png.trigger('dblclick');
    check('双击图片文件弹出预览弹窗，.fp-img 指向同源静态路径',
        lastDialog().length === 1 && lastDialog().find('.fp-img').length === 1 &&
        /\/data\/projectfiles\/demo\/architecture\.png$/
            .test(String(lastDialog().find('.fp-img').attr('src') || '')),
        String(lastDialog().find('.fp-img').attr('src')));
    check('预览弹窗底部按钮隐藏', lastDialog().find('.el-dialog__footer').css('display') === 'none');
    closeDialogs();
    var $txt = pfRows().filter(function () { return /会议纪要\.txt/.test($(this).text()); });
    $txt.trigger('dblclick');
    check('双击 txt 弹出文本预览弹窗', lastDialog().length === 1 &&
        /会议纪要\.txt/.test(lastDialog().find('.el-dialog__title').text()),
        lastDialog().find('.el-dialog__title').text());
});
step(function () {
    check('jsdom 无 fetch → 文本预览走失败兜底（fp-error + 下载按钮）',
        lastDialog().find('.fp-error').length === 1 &&
        lastDialog().find('.fp-error__dl').length === 1,
        lastDialog().find('.fp-stage').children().length + ' children');
    closeDialogs();
});

step(function () {
    console.log('\n--- 5. 其它格式直接下载 ---');
    /* 注入一个 zip 文件（kindOf=download） */
    var raw = win.localStorage.getItem('menu_admin_projectfiles_v1');
    var files = JSON.parse(raw) || [];
    files.push({
        id: 'pfl-0000-4000-8000-000000000010', projectId: 'prj-0000-4000-8000-000000000001',
        projectCode: 'PRO000001', projectName: '九豆综合管理平台研发',
        fileName: '交付物打包.zip', filePath: 'data/projectfiles/demo/pkg.zip',
        fileType: '压缩包', fileSize: 20480, fileDesc: '', ispub: true,
        uploadEname: '杨伟康', uploadempinfosid: 3, enabled: true,
        uploadTime: '2026-11-04 10:00:00', createTime: '2026-11-04 10:00:00',
        updateTime: '2026-11-04 10:00:00'
    });
    win.localStorage.setItem('menu_admin_projectfiles_v1', JSON.stringify(files));
    win.__dlOk = false;
    var origDownload = Api.projectFile.download;
    Api.projectFile.download = function (id) {
        return origDownload(id).done(function () { win.__dlOk = true; });
    };
    Api.projectFile.page({ projectId: 'prj-0000-4000-8000-000000000001',
        orderBy: 'fileName', pageNum: 1, pageSize: 200 })
        .done(function (data) {
            var hit = (data.list || []).filter(function (f) { return f.fileName === '交付物打包.zip'; })[0];
            if (hit) {
                FP.preview(hit, { onDownload: function (f) { win.Api.projectFile.download(f.id); } });
            }
            win.__previewDone = true;
        });
});
step(function () {
    check('其它格式不弹预览窗、直接走下载接口',
        win.__previewDone === true && $('.el-overlay .el-dialog').length === 0,
        String($('.el-overlay .el-dialog').length));
    check('下载接口被调用成功（__dlOk）', win.__dlOk === true, String(win.__dlOk));
});

step(function () {
    console.log('\n--- 6. xlsx 解析（自研 OOXML） ---');
    var ab = XLSX.buffer.slice(XLSX.byteOffset, XLSX.byteOffset + XLSX.byteLength);
    FP.xlsxToSheets(ab).then(function (data) {
        check('解析出 2 个 sheet 且顺序正确（总览 → 明细）',
            data.sheets.length === 2 && data.sheets[0].name === '总览' &&
            data.sheets[1].name === '明细', JSON.stringify(data.sheets.map(function (s) { return s.name; })));
        var r1 = data.sheets[0].rows[0], r2 = data.sheets[0].rows[1];
        check('共享字符串引用解析（名称 / 架构）',
            r1 && r1[0] === '名称' && r1[1] === '架构', JSON.stringify(r1));
        check('数字 / inlineStr / 布尔解析（12.5 / 直接文本 / TRUE）',
            r2 && r2[0] === '12.5' && r2[1] === '直接文本' && r2[2] === 'TRUE', JSON.stringify(r2));
        check('第二个 sheet 内容正确（明细页）',
            data.sheets[1].rows.length === 1 && data.sheets[1].rows[0][0] === '明细页',
            JSON.stringify(data.sheets[1].rows));
        var html = FP.sheetsToHtml(data);
        check('sheetsToHtml 输出表格结构（fp-sheet / fp-grid / 首行表头）',
            /fp-sheet__name">总览</.test(html) && /fp-grid__head/.test(html) &&
            />明细页</.test(html), html.slice(0, 160));
    }, function (e) { check('xlsx 解析成功', false, String(e && e.message)); });
});

step(function () {
    console.log('\n--- 7. pptx 解析（按页提取文本） ---');
    var ab = PPTX.buffer.slice(PPTX.byteOffset, PPTX.byteOffset + PPTX.byteLength);
    FP.pptxToSlides(ab).then(function (slides) {
        check('解析出 2 页且页号正确',
            slides.length === 2 && slides[0].no === 1 && slides[1].no === 2,
            JSON.stringify(slides.map(function (s) { return s.no; })));
        check('第 1 页提取出两段文字', slides[0].paragraphs.join('|') === '第一页标题|副标题要点',
            JSON.stringify(slides[0].paragraphs));
        check('第 2 页提取出文字', slides[1].paragraphs.join('|') === '第二页内容',
            JSON.stringify(slides[1].paragraphs));
        var html = FP.slidesToHtml(slides);
        check('slidesToHtml 输出分页结构（fp-slide / 页号）',
            /fp-slide__no">第 1 页</.test(html) && /第一页标题/.test(html) &&
            /第 2 页/.test(html), html.slice(0, 160));
    }, function (e) { check('pptx 解析成功', false, String(e && e.message)); });
});

next();
