/* ==========================================================================
   word-import-test.js —— js/word-import.js 纯函数回归（jsdom）
   --------------------------------------------------------------------------
   · 不依赖后端：用「仅存储(method=0)」的 ZIP 手工拼 .docx，jsdom 里可直接解析；
   · 覆盖 OOXML → HTML（标题 / 加粗 / 斜体 / 颜色 / 字号 / 对齐 / 表格 / 图片跳过）；
   · 覆盖三层白名单清洗、Word 粘贴清洗、纯文本摘要、老数据兼容；
   · 覆盖异常分支：旧版 .doc / 非 Word 扩展名 / 空内容 / 非 ZIP / 缺正文 XML。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/word-import-test.js
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

/* ---------------- 手工构造 stored ZIP（CRC 不校验，填 0 即可） ---------------- */
function makeZip(files) {
    var locals = [], centrals = [], offset = 0;
    Object.keys(files).forEach(function (name) {
        var nameBuf = Buffer.from(name, 'utf8');
        var data = Buffer.from(files[name], 'utf8');
        var local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);                  // method = 0（仅存储）
        local.writeUInt32LE(0, 14);                 // crc32
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
        cd.writeUInt16LE(0, 10);                    // method = 0
        cd.writeUInt32LE(0, 16);                    // crc32
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

var DOC_XML = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' +
    /* ① 一级标题：居中 + 加粗 */
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr>' +
    '<w:r><w:rPr><w:b/></w:rPr><w:t>项目总体说明</w:t></w:r></w:p>' +
    /* ② 正文：斜体 + 颜色 + 字号，含换行 / 制表符 / 图片 */
    '<w:p><w:r><w:rPr><w:i/><w:color w:val="1F4E79"/><w:sz w:val="28"/></w:rPr>' +
    '<w:t>正文第一段</w:t></w:r><w:r><w:t xml:space="preserve">，普通文字</w:t>' +
    '<w:br/><w:tab/><w:t>换行后</w:t><w:drawing/></w:r></w:p>' +
    /* ③ 表格 */
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>阶段</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>交付物</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '</w:body></w:document>';
var DOCX = makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': DOC_XML });
var DOCX_B64 = DOCX.toString('base64');
var DOCX_URL = 'data:application/vnd.openxmlformats-officedocument.' +
    'wordprocessingml.document;base64,' + DOCX_B64;
var NO_XML_ZIP = makeZip({ '[Content_Types].xml': '<Types/>' }).toString('base64');

/* ---------------- 启动 jsdom ---------------- */
var dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://127.0.0.1:8808/project-form.html',
    runScripts: 'outside-only', pretendToBeVisual: true
});
var win = dom.window;
win.eval(read('js/word-import.js'));
var WI = win.WordImport;

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 220 }); }
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
function expectReject(promise, label, keyword) {
    promise.then(function () { check(label, false, '不该成功'); },
        function (e) { check(label, keyword.test(String((e && e.message) || e)), String(e && e.message)); });
}

/* ------------------------------- 用例 ------------------------------- */
step(function () {
    console.log('\n--- 1. 组件与白名单清洗 ---');
    check('WordImport 已挂载且 supported() 为真',
        !!WI && WI.supported() === true, String(WI && WI.supported()));
    var dirty = '<p class="MsoNormal" onclick="x()">说明<script>alert(1)</script>' +
        '<style>body{display:none}</style><iframe src="http://x"></iframe>' +
        '<span style="color:#ff0000;position:absolute;background:url(http://evil)">红色</span>' +
        '<a href="javascript:alert(1)">链接</a><img src="javascript:alert(1)" onerror="x()">' +
        '<unknown>保留文字</unknown></p>';
    var clean = WI.sanitize(dirty);
    check('清洗保留合法标签与文字', /说明/.test(clean) && /红色/.test(clean) && /保留文字/.test(clean));
    check('script / style / iframe 连同内容被丢弃',
        !/alert\(1\)/.test(clean) && !/display:none/.test(clean) && !/<script|<style|<iframe/i.test(clean));
    check('on* 事件属性被清除', !/onclick|onerror/i.test(clean));
    check('javascript: 链接与图片被清除，无 src 的 img 被删',
        !/javascript:/i.test(clean) && !/<img/i.test(clean));
    check('CSS 只保留白名单属性',
        /color:#ff0000/.test(clean) && !/position|background:url|url\(/i.test(clean), clean);
    check('未知标签只丢标签、保留文字', !/<unknown/i.test(clean) && /保留文字/.test(clean));

    var pasted = '<!--[if gte mso 9]><xml>x</xml><![endif]-->' +
        '<p class="MsoNormal">段落<o:p></o:p><span class="MsoHyperlink">链接</span></p>';
    var wp = WI.cleanWordPaste(pasted);
    check('Word 粘贴去掉条件注释 / o:p / Mso 类名',
        !/mso|if gte|<o:p|MsoHyperlink/i.test(wp) && /段落/.test(wp) && /链接/.test(wp), wp);

    check('toText 去标签并把段落折成空格',
        WI.toText('<p>第一段</p><p>第二段 <b>粗体</b></p>') === '第一段 第二段 粗体',
        WI.toText('<p>第一段</p><p>第二段 <b>粗体</b></p>'));
    check('ensureHtml 把老数据纯文本包成段落',
        WI.ensureHtml('纯文本说明') === '<p>纯文本说明</p>', WI.ensureHtml('纯文本说明'));
    check('ensureHtml 换行拆段',
        WI.ensureHtml('第一行\n第二行') === '<p>第一行</p><p>第二行</p>',
        WI.ensureHtml('第一行\n第二行'));
    check('ensureHtml 含 HTML 时走清洗',
        WI.ensureHtml('<p onclick="x()">已有</p>') === '<p>已有</p>',
        WI.ensureHtml('<p onclick="x()">已有</p>'));
});

step(function () {
    console.log('\n--- 2. OOXML → HTML（data URL / 纯 base64 / ArrayBuffer） ---');
    WI.parseBase64(DOCX_URL, '需求说明书.docx').then(function (res) {
        var h = res.html || '';
        check('data URL 解析成功且含中文正文', !!h && /项目总体说明/.test(h) && /交付物/.test(h));
        check('标题 Heading1 → h1，居中 → text-align:center',
            /<h1[^>]*text-align:center/.test(h), h.slice(0, 160));
        check('加粗 / 斜体 / 颜色 / 字号转成内联 CSS',
            /font-weight:bold/.test(h) && /font-style:italic/.test(h) &&
            /color:#1F4E79/.test(h) && /font-size:14pt/.test(h), h.slice(0, 260));
        check('表格转成 table/tr/td',
            /<table/.test(h) && /<tr>/.test(h) && /<td>/.test(h));
        check('换行 / 制表符保留', /<br>/.test(h) && /&nbsp;/.test(h));
        check('OOXML 标签与脚本不残留', !/w:document|<w:|onclick|<script/i.test(h));
        check('段落数与图片跳过数正确（4 段 / 1 处图片）',
            res.paragraphs === 4 && res.imagesSkipped === 1,
            res.paragraphs + ' / ' + res.imagesSkipped);
        check('返回纯文本摘要 / 文件名 / 提示文案',
            /项目总体说明/.test(res.text || '') && res.fileName === '需求说明书.docx' &&
            /已导入/.test(res.message || '') && /段落/.test(res.message || ''),
            String(res.message));
    }, function (e) { check('data URL 解析成功', false, String(e && e.message)); });

    WI.parseBase64(DOCX_B64, '纯base64.docx').then(function (res2) {
        check('纯 base64（无 data URL 前缀）同样可解析', /项目总体说明/.test(res2.html || ''));
    }, function (e) { check('纯 base64 同样可解析', false, String(e && e.message)); });

    var ab = DOCX.buffer.slice(DOCX.byteOffset, DOCX.byteOffset + DOCX.byteLength);
    WI.parseDocx(ab).then(function (res3) {
        check('parseDocx 直接吃 ArrayBuffer', /项目总体说明/.test(res3.html || ''));
    }, function (e) { check('parseDocx 直接吃 ArrayBuffer', false, String(e && e.message)); });
});

step(function () {
    console.log('\n--- 3. 异常分支 ---');
    expectReject(WI.parseBase64(DOCX_B64, '老格式.doc'), '旧版 .doc 提示另存为', /另存为/);
    expectReject(WI.parseBase64(DOCX_B64, '说明.txt'), '非 Word 扩展名被拒', /只支持/);
    expectReject(WI.parseBase64('', '空.docx'), '空内容被拒', /请先选择/);
    expectReject(WI.parseBase64('@@@not-base64@@@', '坏.docx'),
        '非法 base64 被拒且给出中文提示', /有效的 base64 数据/);
    expectReject(WI.parseBase64(Buffer.from('not a zip').toString('base64'), '坏.docx'),
        '非 ZIP 内容被拒', /ZIP|Word 文档/i);
    expectReject(WI.parseBase64(NO_XML_ZIP, '空包.docx'),
        '缺 word/document.xml 被拒', /document\.xml|有效的 Word/);
    expectReject(WI.parseDocx(new ArrayBuffer(8)), '空 ArrayBuffer 被拒', /ZIP|Word 文档/i);
});

next();
