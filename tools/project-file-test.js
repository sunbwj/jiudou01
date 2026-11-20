/* ==========================================================================
   project-file-test.js —— 项目管理 · 项目文件页测试（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖：
     ① 首屏骨架：检索 5 条件 / 7 个操作按钮 / 10 列表头 / 项目下拉与文件类型下拉；
     ② URL ?projectId= 自动预筛选、重置恢复全量；
     ③ 可见性：登录 empId=3 → 本人私有 / 他人公用可见，他人私有的项目也进不了下拉；
     ④ 检索：所属项目 / 关键字 / 文件类型 / 公用否 / 启用否；
     ⑤ 上传弹窗：所属项目与文件的必填校验、base64 上传后列表新增、项目快照；
     ⑥ 编辑弹窗：回填、不替换文件只改元数据、编号/路径保持；
     ⑦ 下载（记录 downloadUrl）/ 停用后下载被拒 / 启停 / 删除确认框；
     ⑧ Mock 层：types / detail 可见性 / upload 拒绝不可见项目。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/project-file-test.js
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

var PID1 = 'prj-0000-4000-8000-000000000001';   // 本人创建 + 公用
var PID4 = 'prj-0000-4000-8000-000000000004';   // 他人私有
var B64 = 'data:text/plain;base64,' + Buffer.from('hello project file').toString('base64');

function boot(url) {
    var dom = new JSDOM(read('project-file.html'), {
        url: url || 'http://127.0.0.1:8808/project-file.html',
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
    win.HTMLAnchorElement.prototype.click = function () {
        win.__lastAnchor = { href: this.href, download: this.getAttribute('download') };
    };
    win.eval(read('js/project-file.js'));
    return win;
}

var win = boot('http://127.0.0.1:8808/project-file.html?projectId=' + PID1);
var $ = win.jQuery;
var Api = win.Api;

function rows() { return $('#pfTbody tr[data-id]'); }
function dialog() { return $('.el-overlay .el-dialog').last(); }
function dialogBody() { return dialog().find('.el-dialog__body'); }
function form() { return dialogBody().find('.pj-form'); }
function toast() { return $('.el-message-list').text(); }
function msgBox() { return $('.el-message-box').last(); }
function rowText(i) { return rows().eq(i).text().replace(/\s+/g, ' '); }
function search(o) {
    o = o || {};
    $('#projectId').val(o.projectId || '');
    $('#keyword').val(o.keyword || '');
    $('#fileType').val(o.fileType || '');
    $('#ispub').val(o.ispub === undefined ? '' : o.ispub);
    $('#enabled').val(o.enabled === undefined ? '' : o.enabled);
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
    check('页面标题为「项目文件」', $('.page-head__title').text() === '项目文件',
        $('.page-head__title').text());
    check('面包屑为「项目管理/项目文件」',
        $('#pageHead').attr('data-crumb') === '项目管理/项目文件', $('#pageHead').attr('data-crumb'));
    check('检索卡片含 5 个条件 + 查询/重置',
        $('#searchForm .el-form-item').length === 6 &&
        ['#projectId', '#keyword', '#fileType', '#ispub', '#enabled']
            .every(function (id) { return $(id).length === 1; }) &&
        $('#btnSearch').length === 1 && $('#btnReset').length === 1,
        String($('#searchForm .el-form-item').length));
    check('操作引导区 7 个按钮',
        ['#btnAdd', '#btnEdit', '#btnDownload', '#btnEnable', '#btnDisable', '#btnDelete', '#btnRefresh']
            .every(function (id) { return $(id).length === 1; }) &&
        $('.toolbar .el-button').length === 7, String($('.toolbar .el-button').length));
    check('操作引导区全部为图标按钮（svg + title + aria-label，无可见文字）',
        $('.toolbar').hasClass('toolbar--icons') &&
        $('.toolbar').attr('role') === 'toolbar' &&
        $('.toolbar .el-button').length === 7 &&
        $('.toolbar .el-button').toArray().every(function (b) {
            var $b = $(b);
            return $b.hasClass('el-button--icon') &&
                $b.find('svg.svg-ico').length === 1 &&
                !!$b.attr('title') && !!$b.attr('aria-label') &&
                $b.text().trim() === '';
        }), $('.toolbar').attr('class'));
    check('表头 10 列且含所属项目 / 文件名 / 大小 / 上传人',
        $('#pfTable thead th').length === 10 &&
        /所属项目/.test($('#pfTable thead th').eq(2).text()) &&
        /文件名/.test($('#pfTable thead th').eq(3).text()) &&
        /大小/.test($('#pfTable thead th').eq(5).text()) &&
        /上传人/.test($('#pfTable thead th').eq(7).text()));
    check('分页容器存在', $('#pagerWrap').length === 1);
    check('未选择文件时编辑/下载/启停/删除禁用',
        $('#btnEdit').prop('disabled') === true && $('#btnDownload').prop('disabled') === true &&
        $('#btnDelete').prop('disabled') === true);
    /* 说明提示卡已按「去说明卡」需求从页面移除（project-file.html 中仅剩注释），
       旧的「提示卡 10 MB 上限」断言随之作废；10MB 校验由 js/project-file.js 的上传前拦截保证 */
});

step(function () {
    console.log('\n--- 2. 字典 + URL 预筛选 ---');
    check('文件类型下拉 7 项 + 全部类型', $('#fileType option').length === 8,
        String($('#fileType option').length));
    check('文件类型含「设计稿」「压缩包」',
        /设计稿/.test($('#fileType').text()) && /压缩包/.test($('#fileType').text()));
    check('所属项目下拉只含可见且启用的 2 个项目',
        $('#projectId option').length === 3 &&
        /PRO000001/.test($('#projectId').text()) && /PRO000002/.test($('#projectId').text()) &&
        !/PRO000003/.test($('#projectId').text()) && !/PRO000004/.test($('#projectId').text()),
        $('#projectId').text().replace(/\s+/g, ' ').slice(0, 140));
    check('URL 带 projectId 时自动按该项目筛选（2 个文件）',
        $('#projectId').val() === PID1 && rows().length === 2,
        $('#projectId').val() + ' / rows=' + rows().length);
    check('列表显示项目编号 + 项目名 + 文件名 + 大小 + 上传人 + 时间',
        /PRO000001/.test(rowText(0)) && /九豆综合管理平台研发/.test(rowText(0)) &&
        /\.docx|\.png/.test(rowText(0)) && /KB|MB|B/.test(rowText(0)) &&
        /杨伟康/.test(rowText(0)) && /2026-11-01/.test(rowText(0)),
        rowText(0).slice(0, 170));
    check('顶部条数为 2', $('#pfCount').text() === '2', $('#pfCount').text());
});

step(function () {
    console.log('\n--- 3. 重置 + 检索 ---');
    $('#btnReset').trigger('click');
});
step(function () {
    check('重置后恢复全部可见文件 3 条', rows().length === 3 && $('#pfCount').text() === '3',
        String(rows().length));
    check('本人私有 / 他人公用文件都可见，他人私有项目下没有文件',
        /需求规格说明书/.test($('#pfTbody').text()) &&
        /架构设计/.test($('#pfTbody').text()) && /实施计划/.test($('#pfTbody').text()));
    check('私有文件显示「私有」标签', /私有/.test($('#pfTbody').text()));
    search({ keyword: '架构' });
});
step(function () {
    check('关键字「架构」命中 1 条', rows().length === 1 && /架构设计/.test($('#pfTbody').text()),
        String(rows().length));
    search({ fileType: '表格' });
});
step(function () {
    check('按文件类型「表格」命中 1 条', rows().length === 1 && /实施计划/.test($('#pfTbody').text()),
        String(rows().length));
    search({ projectId: PID1 });
});
step(function () {
    check('按所属项目 PRO000001 命中 2 条', rows().length === 2, String(rows().length));
    search({ ispub: '0' });
});
step(function () {
    check('按「私有」筛出本人私有文件 1 条', rows().length === 1 &&
        /架构设计/.test($('#pfTbody').text()), String(rows().length));
    $('#btnReset').trigger('click');
});
step(function () {
    check('再次重置恢复 3 条', rows().length === 3, String(rows().length));
});

step(function () {
    console.log('\n--- 4. 上传弹窗 ---');
    $('#btnAdd').trigger('click');
});
step(function () {
    check('弹窗标题「上传项目文件」', /上传项目文件/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    check('表单 7 个字段 + 隐藏的 base64 容器齐全',
        ['#pfProject', '#pfFile', '#pfName', '#pfType', '#pfDesc', '#pfIspub', '#pfEnabled', '#pfData']
            .every(function (id) { return form().find(id).length === 1; }));
    check('文件类型下拉 7 项且默认「文档」',
        form().find('#pfType option').length === 7 && form().find('#pfType').val() === '文档');
    check('所属项目下拉与检索一致（含请选择）',
        form().find('#pfProject option').length === 3,
        String(form().find('#pfProject option').length));
    check('公用否默认「公用」', form().find('#pfIspub').val() === '1');
    // 未选项目 → 阻止保存
    dialog().find('.btn-ok').trigger('click');
    check('未选所属项目时阻止保存', dialog().length === 1 && /请选择所属项目/.test(toast()),
        toast().slice(-80));
    form().find('#pfProject').val(PID1);
    dialog().find('.btn-ok').trigger('click');
    check('未选择文件时阻止保存', dialog().length === 1 && /请选择要上传的文件/.test(toast()),
        toast().slice(-120));
});
step(function () {
    console.log('\n--- 4b. 上传弹窗：所属目录下拉选择 ---');
    var $dirSel = form().find('#pfDirId');
    check('所属目录改成下拉框（无目录树 / label / 清空按钮）',
        $dirSel.length === 1 && $dirSel.is('select') &&
        form().find('#pfDirTree').length === 0 && form().find('#pfDirName').length === 0 &&
        form().find('#pfDirClear').length === 0);
    check('未选项目时下拉只有「不选择」一项',
        $dirSel.find('option').length === 1 && $dirSel.val() === '',
        String($dirSel.find('option').length));
    form().find('#pfProject').val(PID1).trigger('change');     // 真实用户是下拉选择 → 触发 change
});
step(function () {
    var $dirSel = form().find('#pfDirId');
    check('切换项目后下拉自动加载（不选择 + 3 个可见目录 = 4 项）',
        $dirSel.find('option').length === 4, String($dirSel.find('option').length));
    var texts = $dirSel.find('option').map(function () { return $(this).text(); }).get();
    check('目录选项带层级缩进（全角空格 + └）',
        (function () {
            for (var i = 0; i < texts.length; i++) {
                if (/\u3000/.test(texts[i]) && /└/.test(texts[i])) { return true; }
            }
            return false;
        })(), JSON.stringify(texts));
    check('默认选中「不选择」', $dirSel.val() === '');
    $dirSel.val('pdr-0000-4000-8000-000000000002').trigger('change');
    win.__pickDir = form().find('#pfDirId').val();
    check('选择子目录后 dirId 写入',
        win.__pickDir === 'pdr-0000-4000-8000-000000000002', String(win.__pickDir));
    form().find('#pfData').val(B64).attr('data-size', 18);
    form().find('#pfName').val('单元测试.txt');
    form().find('#pfType').val('代码');
    form().find('#pfDesc').val('jsdom 上传');
    form().find('#pfIspub').val('0');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    check('上传成功后弹窗关闭', $('.el-overlay .el-dialog').length === 0);
    var $new = rows().filter(function () { return /单元测试\.txt/.test($(this).text()); });
    check('列表出现新文件', $new.length === 1,
        $('#pfTbody').text().replace(/\s+/g, ' ').slice(0, 180));
    check('新文件带项目编号 / 项目名快照、类型、私有标签、大小',
        /PRO000001/.test($new.text()) && /九豆综合管理平台研发/.test($new.text()) &&
        /代码/.test($new.text()) && /私有/.test($new.text()) && /B/.test($new.text()),
        $new.text().replace(/\s+/g, ' ').slice(0, 170));
    check('总数变为 4', $('#pfCount').text() === '4', $('#pfCount').text());
    win.__newFileId = $new.attr('data-id');
    Api.projectFile.detail(win.__newFileId).done(function (d) {
        check('detail 返回 filePath / downloadUrl / 上传人ID',
            /^data\/projectfiles\//.test(d.filePath) && /^\/data\/projectfiles\//.test(d.downloadUrl) &&
            d.uploadempinfosid === 3, d.filePath + ' / ' + d.downloadUrl);
        check('上传时选中的目录已落库（dirId / dirName）',
            d.dirId === win.__pickDir && /架构设计/.test(d.dirName || ''),
            JSON.stringify([d.dirId, d.dirName]));
    });
});

step(function () {
    console.log('\n--- 5. 编辑弹窗（不替换文件） ---');
    rows().filter(function () { return /单元测试\.txt/.test($(this).text()); }).trigger('click');
    $('#btnEdit').trigger('click');
});
step(function () {
    check('弹窗标题带文件名', /编辑文件/.test(dialog().find('.el-dialog__title').text()) &&
        /单元测试\.txt/.test(dialog().find('.el-dialog__title').text()));
    check('回填所属项目 / 文件名 / 类型 / 说明 / 公用否',
        form().find('#pfProject').val() === PID1 &&
        form().find('#pfName').val() === '单元测试.txt' &&
        form().find('#pfType').val() === '代码' &&
        form().find('#pfDesc').val() === 'jsdom 上传' &&
        form().find('#pfIspub').val() === '0',
        form().find('#pfType').val() + '/' + form().find('#pfDesc').val());
    check('编辑态提示「留空表示不替换文件」且 base64 容器为空',
        /留空表示不替换文件/.test(form().find('#pfFileTip').text()) &&
        form().find('#pfData').val() === '');
    check('编辑态回填原目录（下拉选中原 dirId，选项文案含目录名）',
        form().find('#pfDirId').val() === win.__pickDir &&
        /架构设计/.test(form().find('#pfDirId option:selected').text()),
        JSON.stringify([form().find('#pfDirId').val(),
            form().find('#pfDirId option:selected').text()]));
    form().find('#pfDirId').val('').trigger('change');   // 清空选择 → 回到项目根
    check('清空选择后 dirId 置空、选中项回到「不选择」',
        form().find('#pfDirId').val() === '' &&
        /不选择/.test(form().find('#pfDirId option:selected').text()));
    form().find('#pfDesc').val('改后说明');
    form().find('#pfType').val('文档');
    form().find('#pfIspub').val('1');
    dialog().find('.btn-ok').trigger('click');
});
step(function () {
    var $edited = rows().filter(function () { return /单元测试\.txt/.test($(this).text()); });
    check('编辑后类型 / 公用否更新', /文档/.test($edited.text()) && !/私有/.test($edited.text()),
        $edited.text().replace(/\s+/g, ' ').slice(0, 150));
    Api.projectFile.detail(win.__newFileId).done(function (d) {
        check('不换文件时文件名与路径不变、说明已更新',
            d.fileName === '单元测试.txt' && /^data\/projectfiles\//.test(d.filePath) &&
            d.fileDesc === '改后说明', d.fileName + ' / ' + d.fileDesc);
        check('清空目录后 dirId 回到空（文件挂在项目根）', !d.dirId, String(d.dirId));
    });
});

step(function () {
    console.log('\n--- 6. 下载 / 启停 / 删除 ---');
    rows().filter(function () { return /单元测试\.txt/.test($(this).text()); }).trigger('click');
    $('#btnDownload').trigger('click');
});
step(function () {
    check('下载接口返回地址并写入 data-url',
        /\/data\/projectfiles\//.test($('#pfLastDownload').attr('data-url') || ''),
        $('#pfLastDownload').attr('data-url'));
    check('创建了带 download 属性的 <a> 且文件名正确',
        !!win.__lastAnchor && win.__lastAnchor.download === '单元测试.txt',
        JSON.stringify(win.__lastAnchor));
    check('下载成功提示', /可以下载|已生成下载地址/.test(toast()));
    $('#btnDisable').trigger('click');
});
step(function () {
    var $edited = rows().filter(function () { return /单元测试\.txt/.test($(this).text()); });
    check('停用后列表显示「停用」', /停用/.test($edited.text()),
        $edited.text().replace(/\s+/g, ' ').slice(0, 120));
    $('#btnDownload').trigger('click');
});
step(function () {
    check('停用文件下载被拒绝', /已停用/.test(toast()), toast().slice(-100));
    $('#btnEnable').trigger('click');
});
step(function () {
    rows().filter(function () { return /单元测试\.txt/.test($(this).text()); }).trigger('click');
    check('重新启用后「启用」按钮禁用、「停用」可用',
        $('#btnEnable').prop('disabled') === true && $('#btnDisable').prop('disabled') === false);
    $('#btnDelete').trigger('click');
    check('删除弹出确认框且提示会删除服务器文件',
        msgBox().length === 1 && /服务器/.test(msgBox().text()), msgBox().text().slice(0, 90));
    msgBox().find('.btn-ok').trigger('click');
});
step(function () {
    check('删除后列表恢复 3 条', rows().length === 3 && !/单元测试\.txt/.test($('#pfTbody').text()),
        String(rows().length));
    check('删除后按钮禁用', $('#btnEdit').prop('disabled') === true);
});

step(function () {
    console.log('\n--- 7. Mock 层边界 ---');
    Api.projectFile.types().done(function (d) {
        check('types 返回 7 种文件类型', d.types.length === 7, JSON.stringify(d.types));
    });
    Api.projectFile.upload({ projectId: PID4, fileName: 'x.txt', data: B64 })
        .fail(function (err) {
            check('上传到他人私有项目被拒绝', /不是你创建|所属项目不存在/.test(err.message),
                err.message);
        });
    Api.projectFile.detail('pfl-0000-4000-8000-000000000009').fail(function (err) {
        check('不存在的文件 detail 返回 404', /不存在/.test(err.message), err.message);
    });
    rows().eq(0).trigger('dblclick');
    check('双击行打开编辑弹窗', /编辑文件/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    dialog().find('.btn-cancel').trigger('click');
    check('取消按钮关闭弹窗', $('.el-overlay .el-dialog').length === 0);
});

next();
