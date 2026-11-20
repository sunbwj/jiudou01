/* ==========================================================================
   project-form-test.js —— 项目维护独立页（project-form.html）jsdom 回归
   --------------------------------------------------------------------------
   覆盖：
     ① 打页骨架：30% 基础信息 + 70% 项目说明编辑区（CSS 口径）、contenteditable、
        格式工具栏、导入 Word / 源码 / 保存 / 返回；
     ② 新增模式：字典下拉、编号只读预览、默认值、富文本录入与字数统计、源码清洗；
     ③ Word 导入：真实构造的 .docx 经 FileReader → Api.project.importDoc → 编辑器，
        替换 / 追加两种分支、旧版 .doc 拒绝；
     ④ 保存：必填校验、富文本入库、projectDescText 摘要、保存后打页回列表；
     ⑤ 编辑模式：?mode=edit&id= 回填全部字段与老数据纯文本说明、保存走 update。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/project-form-test.js
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

/* ---------------- 构造一个「仅存储」的 .docx（ZIP） ---------------- */
function makeZip(files) {
    var locals = [], centrals = [], offset = 0;
    Object.keys(files).forEach(function (name) {
        var nameBuf = Buffer.from(name, 'utf8');
        var data = Buffer.from(files[name], 'utf8');
        var local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        var one = Buffer.concat([local, nameBuf, data]);
        var cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0, 10);
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
var XML = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr>' +
    '<w:r><w:rPr><w:b/></w:rPr><w:t>项目总体说明</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:i/><w:color w:val="1F4E79"/><w:sz w:val="28"/></w:rPr>' +
    '<w:t>正文第一段</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>阶段</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>交付物</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '</w:body></w:document>';
var DOCX = makeZip({ 'word/document.xml': XML });

/* ---------------- 启动一个独立页窗口 ---------------- */
function boot(url, pre) {
    var dom = new JSDOM(read('project-form.html'), {
        url: 'http://127.0.0.1:8808/' + url,
        runScripts: 'outside-only', pretendToBeVisual: true
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
    win.AppNav.go = function (u) { win.__lastNav = u; };
    if (pre) { pre(win); }      // 在业务脚本启动前注入窗口级 Mock 数据（如字典）
    win.eval(read('js/project-form.js'));
    return win;
}
function makeFile(win, bytes, name) {
    var u8 = new win.Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) { u8[i] = bytes[i]; }
    return new win.File([u8], name, {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
}
function pickFile(win, file) {
    var input = win.jQuery('#pjWordFile')[0];
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    win.jQuery('#pjWordFile').trigger('change');
}

var win = boot('project-form.html?mode=add');
var $ = win.jQuery;
var Api = win.Api;
var CSS = read('css/app.css');
function toast() { return $('.el-message-list').text(); }
function msgBox() { return $('.el-message-box').last(); }
function editorHtml() { return $('#pjDescEditor').html() || ''; }

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 420 }); }
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
    console.log('\n--- 1. 打页骨架：30% 基础信息 + 70% 项目说明 ---');
    check('页面标题「新增项目」', $('#pageTitle').text() === '新增项目', $('#pageTitle').text());
    check('面包屑指向项目信息/新增项目',
        $('#pageHead').attr('data-crumb') === '项目管理/项目信息/新增项目',
        String($('#pageHead').attr('data-crumb')));
    check('两栏布局容器存在', $('.pjf-layout').length === 1 &&
        $('.pjf-base').length === 1 && $('.pjf-editor').length === 1);
    check('CSS 明确左侧 30% / 右侧 70%',
        /\.pjf-base\s*\{[^}]*width:\s*30%/.test(CSS) &&
        /\.pjf-editor\s*\{[^}]*width:\s*70%/.test(CSS));
    check('CSS 编辑区高度撑满剩余空间（60vh 下限）',
        /\.pjf-editable[\s\S]{0,120}min-height/.test(CSS) || /min-height:\s*60vh/.test(CSS));
    check('项目说明是 contenteditable 富文本区',
        $('#pjDescEditor').attr('contenteditable') === 'true' && $('#pjDescSource').length === 1);
    check('格式工具栏 17 个按钮 + 5 个下拉/取色器齐全',
        $('#pjfToolbar .pjf-tool').length === 17 && $('#pjFontName').length === 1 &&
        $('#pjFontSize').length === 1 && $('#pjForeColor').length === 1 &&
        $('#pjBackColor').length === 1 && $('#pjBlock').length === 1,
        String($('#pjfToolbar .pjf-tool').length));
    check('导入 Word / 源码 / 保存 / 返回 四个动作按钮都在',
        ['#btnImportWord', '#btnToggleSource', '#btnSave', '#btnBack']
            .every(function (id) { return $(id).length === 1; }));
    check('文件选择框只收 .docx/.docm',
        /\.docx/.test($('#pjWordFile').attr('accept') || '') &&
        /\.docm/.test($('#pjWordFile').attr('accept') || ''));
    check('顶部功能说明卡已移除（.pjf-tipcard / .pj-tip 数量为 0）',
        $('.pjf-tipcard').length === 0 && $('.pj-tip').length === 0,
        String($('.pjf-tipcard').length) + ' / ' + String($('.pj-tip').length));
    check('「占本页 70% 编辑区域」徽标已去掉',
        $('.pjf-ratio').length === 0 && !/占本页/.test($('.pjf-editor').text()) &&
        $.trim($('.pjf-editor .pjf-section-title').first().text()) === '项目说明',
        $('.pjf-editor .pjf-section-title').first().text());
    check('表单卡吃满剩余高度（卡片 flex:1 + 两栏 min-height:0 + 左栏内部滚动）',
        /\.pjf-card\s*\{[^}]*flex:\s*1 1 auto/.test(CSS) &&
        /\.pjf-layout\s*\{[^}]*min-height:\s*0/.test(CSS) &&
        /\.pjf-base\s*\{[^}]*overflow-y:\s*auto/.test(CSS));
    check('基础信息 6 个字段 + 编号只读',
        ['#pjCode', '#pjName', '#pjType', '#pjStatus', '#pjIspub', '#pjEnabled']
            .every(function (id) { return $(id).length === 1; }) &&
        $('#pjCode').prop('readonly') === true);
});

step(function () {
    console.log('\n--- 2. 新增模式初始化 ---');
    check('项目类型 9 项 / 项目状态 5 项',
        $('#pjType option').length === 9 && $('#pjStatus option').length === 5,
        $('#pjType option').length + '/' + $('#pjStatus option').length);
    check('默认研发 / 未开始 / 公用 / 启用',
        $('#pjType').val() === '研发' && $('#pjStatus').val() === '未开始' &&
        $('#pjIspub').val() === '1' && $('#pjEnabled').val() === '1');
    check('编号只读预览 PRO000005', $('#pjCode').val() === 'PRO000005', String($('#pjCode').val()));
    check('新增页元信息提示编号保存时生成',
        /新增项目/.test($('#pjfMeta').text()) && /保存时/.test($('#pjfMeta').text()),
        $('#pjfMeta').text());
});

step(function () {
    console.log('\n--- 3. 富文本编辑与清洗 ---');
    $('#pjDescEditor').html('<p>第一段 <b>加粗</b></p><p>第二段</p>').trigger('input');
    check('字数 / 段数统计已更新', /\d+ 字 · 2 段/.test($('#pjfCount').text()),
        $('#pjfCount').text());
    $('#pjfToolbar').find('.pjf-tool[data-cmd="bold"]').trigger('click');
    check('格式工具点击不抛异常（jsdom 无 execCommand 也能降级）', true);
    $('#btnToggleSource').trigger('click');
    check('切到源码视图：编辑器隐藏、源码框显示',
        $('#pjDescEditor').css('display') === 'none' || !$('#pjDescEditor').is(':visible'));
    $('#pjDescSource').val('<p onclick="x()">安全<script>alert(1)</script><b>保留</b></p>');
    $('#btnToggleSource').trigger('click');
    check('切回编辑视图按白名单清洗（去事件 / 脚本）',
        !/onclick|<script|alert\(1\)/.test(editorHtml()) && /保留/.test(editorHtml()),
        editorHtml());
    /* 清空编辑区，为「首次导入直接替换」做准备 */
    $('#pjDescEditor').html('').trigger('input');
});

step(function () {
    console.log('\n--- 4. 导入 Word（FileReader → 本地解析 → 编辑器） ---');
    $('#btnImportWord').trigger('click');
    check('点「导入 Word」触发文件选择框（不弹页面窗）',
        $('.el-overlay .el-dialog').length === 0);
    pickFile(win, makeFile(win, DOCX, '需求说明书.docx'));
});
step(function () {
    check('Word 内容已写入富文本编辑器',
        /项目总体说明/.test(editorHtml()) && /正文第一段/.test(editorHtml()),
        editorHtml().slice(0, 180));
    check('导入保留标题 / 居中 / 加粗 / 颜色 / 表格',
        /<h1/.test(editorHtml()) && /text-align:center/.test(editorHtml()) &&
        /font-weight:bold/.test(editorHtml()) && /color:#1F4E79/.test(editorHtml()) &&
        /<table/.test(editorHtml()), editorHtml().slice(0, 260));
    check('提示区显示已导入文件名与段落数',
        /已导入/.test($('#pjfHint').text()) && /需求说明书\.docx/.test($('#pjfHint').text()) &&
        /段落/.test($('#pjfHint').text()), $('#pjfHint').text());
    check('导入后字数统计非零', !/^0 字/.test($('#pjfCount').text()), $('#pjfCount').text());
    /* 第二次导入：已有内容 → 弹「替换 / 追加」 */
    pickFile(win, makeFile(win, DOCX, '需求说明书.docx'));
}, 700);
step(function () {
    check('已有内容再导入时弹替换/追加确认框',
        msgBox().length === 1 && /替换/.test(msgBox().text()) && /追加/.test(msgBox().text()),
        msgBox().text().slice(0, 100));
    msgBox().find('.btn-cancel').trigger('click');       // cancelText = 追加
}, 700);
step(function () {
    check('选「追加」后内容出现两次',
        (editorHtml().match(/项目总体说明/g) || []).length === 2,
        String((editorHtml().match(/项目总体说明/g) || []).length));
    /* 旧版 .doc 拒绝 */
    pickFile(win, makeFile(win, DOCX, '老格式.doc'));
}, 700);
step(function () {
    check('旧版 .doc 被拒并提示另存为 .docx',
        /另存为/.test(toast()), toast().slice(-100));
    /* 清掉重复内容，避免保存两份 */
    $('#pjDescEditor').html(editorHtml().split('<h1')[0] + '<h1' +
        editorHtml().split('<h1')[1]).trigger('input');
    $('#pjName').val('__表单页测试__Word项目');
    $('#btnSave').trigger('click');
}, 700);
step(function () {
    check('项目名称为空之外不阻止保存（本次已填名称）', !/请填写项目名称/.test(toast()));
    check('保存成功后打页回项目列表',
        String(win.__lastNav) === 'project.html', String(win.__lastNav));
    check('保存成功提示', /新增成功/.test(toast()), toast().slice(-100));
    Api.project.page({ keyword: '__表单页测试__Word项目' }).done(function (d) {
        var one = (d.list || [])[0] || {};
        check('富文本 HTML 已入库（含 h1 / 表格 / 颜色）',
            /<h1/.test(one.projectDesc || '') && /<table/.test(one.projectDesc || '') &&
            /color:#1F4E79/.test(one.projectDesc || ''),
            String(one.projectDesc).slice(0, 180));
        check('列表带纯文本摘要 projectDescText',
            /项目总体说明/.test(one.projectDescText || '') &&
            !/<h1/.test(one.projectDescText || ''), String(one.projectDescText));
        check('自动生成编号 PRO000005', one.projectCode === 'PRO000005', String(one.projectCode));
    });
}, 700);

step(function () {
    console.log('\n--- 5. 必填校验 / 返回列表 ---');
    win.__w2 = boot('project-form.html?mode=add');
}, 500);
step(function () {
    var w2 = win.__w2, $2 = w2.jQuery;
    $2('#btnSave').trigger('click');
    check('名称为空时阻止保存且不打页',
        /请填写项目名称/.test($2('.el-message-list').text()) &&
        !w2.__lastNav, String(w2.__lastNav));
    $2('#pjDescEditor').html('<p>' + new Array(200100).join('a') + '</p>');
    $2('#pjName').val('超长说明');
    $2('#btnSave').trigger('click');
    check('说明超过 20 万字时阻止保存',
        /内容过长/.test($2('.el-message-list').text()),
        $2('.el-message-list').text().slice(-100));
    w2.__lastNav = '';
    $2('#btnBack').trigger('click');
    check('「返回列表」同样打页回 project.html',
        String(w2.__lastNav) === 'project.html', String(w2.__lastNav));
}, 500);

step(function () {
    console.log('\n--- 6. 编辑模式：回填与保存 ---');
    var w3 = boot('project-form.html?mode=edit&id=prj-0000-4000-8000-000000000001');
    win.__editWin = w3;
}, 600);
step(function () {
    var w3 = win.__editWin, $3 = w3.jQuery;
    check('编辑页标题 / 文档标题',
        $3('#pageTitle').text() === '编辑项目' && /编辑项目/.test(w3.document.title),
        $3('#pageTitle').text() + ' / ' + w3.document.title);
    check('回填编号 / 名称 / 类型 / 状态 / 公用',
        $3('#pjCode').val() === 'PRO000001' &&
        $3('#pjName').val() === '九豆综合管理平台研发' &&
        $3('#pjType').val() === '研发' && $3('#pjStatus').val() === '进行中' &&
        $3('#pjIspub').val() === '1',
        String($3('#pjName').val()) + '/' + $3('#pjType').val());
    check('编号在编辑态仍只读', $3('#pjCode').prop('readonly') === true);
    check('老数据纯文本说明被包成段落回显',
        /<p>前端 H5 \+ Flask 后端的一体化综合管理平台<\/p>/.test($3('#pjDescEditor').html() || ''),
        String($3('#pjDescEditor').html()).slice(0, 160));
    check('编辑页元信息显示编号 / 创建人 / 文件数',
        /PRO000001/.test($3('#pjfMeta').text()) && /杨伟康/.test($3('#pjfMeta').text()) &&
        /2 个/.test($3('#pjfMeta').text()), $3('#pjfMeta').text());
    /* 改成富文本并保存 */
    $3('#pjDescEditor').html('<h2>改后的项目说明</h2><p><b>重点</b>内容</p>').trigger('input');
    $3('#pjName').val('九豆综合管理平台研发（改）');
    $3('#btnSave').trigger('click');
}, 600);
step(function () {
    var w3 = win.__editWin;
    check('编辑保存成功后打页回列表', String(w3.__lastNav) === 'project.html',
        String(w3.__lastNav));
    w3.Api.project.detail('prj-0000-4000-8000-000000000001').done(function (d) {
        check('update 写入富文本说明',
            /<h2>改后的项目说明<\/h2>/.test(d.projectDesc || '') &&
            /<b>重点<\/b>/.test(d.projectDesc || ''), String(d.projectDesc).slice(0, 160));
        check('编辑不改编号、只改名称',
            d.projectCode === 'PRO000001' && /（改）/.test(d.projectName || ''),
            d.projectCode + '/' + d.projectName);
        check('摘要同步更新', /改后的项目说明/.test(d.projectDescText || ''),
            String(d.projectDescText));
    }).fail(function (e) {
        check('编辑后详情仍可见', false, e && e.message);
    });
}, 600);

/* 注入「项目类型」字典 Mock 数据（写入窗口 localStorage，须在业务脚本启动前） */
function seedDict(items) {
    return function (w) {
        var dicts = [
            { id: 'd-gender', dictNameCn: '用户性别', dictNameEn: 'gender', parentId: '',
              sortNo: 1, remark: '', enabled: true,
              createTime: '2026-11-05 09:00:00', updateTime: '2026-11-05 09:00:00' },
            { id: 'd-ptype', dictNameCn: '项目类型', dictNameEn: 'project_type', parentId: '',
              sortNo: 10, remark: '', enabled: true,
              createTime: '2026-11-05 09:00:00', updateTime: '2026-11-05 09:00:00' }
        ];
        w.localStorage.setItem('menu_admin_sysdict_v1', JSON.stringify(dicts));
        w.localStorage.setItem('menu_admin_sysdictitems_v1', JSON.stringify(items));
    };
}

step(function () {
    console.log('\n--- 7. 项目类型下拉接系统字典 ---');
    win.__dictWin = boot('project-form.html?mode=add', seedDict([
        { id: 'i-g1', dictId: 'd-gender', itemKey: 'M', itemValue: '男', sortNo: 1, enabled: true,
          createTime: '2026-11-05 09:00:00', updateTime: '2026-11-05 09:00:00' },
        { id: 'i-p3', dictId: 'd-ptype', itemKey: '', itemValue: '外包', sortNo: 0, enabled: true,
          createTime: '2026-11-05 09:00:00', updateTime: '2026-11-05 09:00:00' },
        { id: 'i-p1', dictId: 'd-ptype', itemKey: '研发', itemValue: '01', sortNo: 1, enabled: true,
          createTime: '2026-11-05 09:00:00', updateTime: '2026-11-05 09:00:00' },
        { id: 'i-p2', dictId: 'd-ptype', itemKey: '实施', itemValue: '02', sortNo: 2, enabled: true,
          createTime: '2026-11-05 09:00:00', updateTime: '2026-11-05 09:00:00' },
        { id: 'i-p4', dictId: 'd-ptype', itemKey: '已停用', itemValue: '09', sortNo: 3, enabled: false,
          createTime: '2026-11-05 09:00:00', updateTime: '2026-11-05 09:00:00' }
    ]));
}, 600);
step(function () {
    var w4 = win.__dictWin, $4 = w4.jQuery;
    var vals = $4('#pjType option').map(function () { return $4(this).val(); }).get();
    check('类型下拉 = 字典启用项的「键」（键留空用键值、停用被过滤、按序号排序）',
        vals.join('|') === '外包|研发|实施', vals.join('|'));
    check('默认选中字典第一项「外包」', $4('#pjType').val() === '外包', String($4('#pjType').val()));
    w4.Api.project.types().done(function (d) {
        check('types 接口返回 typeSource=dict 与字典项',
            d.typeSource === 'dict' && d.typeDictNameEn === 'project_type' &&
            (d.types || []).join('|') === '外包|研发|实施', JSON.stringify(d));
    });
    /* 历史值兜底：老项目类型「研发」已不在字典里 → 补「研发（历史值）」选项 */
    win.__legacyWin = boot('project-form.html?mode=edit&id=prj-0000-4000-8000-000000000001',
        seedDict([
            { id: 'i-p3b', dictId: 'd-ptype', itemKey: '', itemValue: '外包', sortNo: 0, enabled: true,
              createTime: '2026-11-05 09:00:00', updateTime: '2026-11-05 09:00:00' },
            { id: 'i-p2b', dictId: 'd-ptype', itemKey: '实施', itemValue: '02', sortNo: 2, enabled: true,
              createTime: '2026-11-05 09:00:00', updateTime: '2026-11-05 09:00:00' }
        ]));
}, 700);
step(function () {
    var w5 = win.__legacyWin, $5 = w5.jQuery;
    var vals = $5('#pjType option').map(function () { return $5(this).val(); }).get();
    check('老项目类型不在字典时补「（历史值）」选项且保持选中',
        vals.join('|') === '外包|实施|研发' && $5('#pjType').val() === '研发', vals.join('|'));
    check('历史值选项带「（历史值）」提示文案',
        $5('#pjType option').filter(function () { return $5(this).val() === '研发'; }).text() === '研发（历史值）',
        $5('#pjType option:last').text());
});

next();
