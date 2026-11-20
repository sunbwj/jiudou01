/* ==========================================================================
   project-dir-test.js —— 项目目录（projectdirs）功能测试（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖：
     ① Mock 层：目录树（可见性 / 深度优先 / 层级 / fileCount）、CRUD、防重名、
        排除自身及后代、删除内容上移、文件 dirId 归属与「不选目录=项目根」；
     ② UI 层：目录维护 3 个图标按钮、列表 / 目录树标签页、树节点选中联动、
        展开折叠、创建 / 编辑 / 删除弹窗流程、上传弹窗目录树选择并把 dirId 提交给上传接口。
   ⚠ Mock 回调是异步的：任何触发接口的动作都要与断言拆到不同 step（step 延迟只作用于下一步）。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/project-dir-test.js
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

var PID = 'prj-0000-4000-8000-000000000001';
var ROOT_DIR = 'pdr-0000-4000-8000-000000000001';

/** 只加载 api.js 的空白窗口（Mock 层用例） */
function bootApi() {
    var dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://127.0.0.1:8808/project.html', runScripts: 'outside-only', pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.jQuery.ajax = function () { var d = win.jQuery.Deferred(); d.reject({}, 'error', ''); return d.promise(); };
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({ token: 'mock-token', user: { empId: 3 } }));
    win.eval(read('js/api.js'));
    return win;
}
/** 完整项目信息页（UI 层用例） */
function bootPage() {
    var dom = new JSDOM(read('project.html'), {
        url: 'http://127.0.0.1:8808/project.html', runScripts: 'outside-only', pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.jQuery.ajax = function () { var d = win.jQuery.Deferred(); d.reject({}, 'error', ''); return d.promise(); };
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
    win.eval(read('js/project.js'));
    return win;
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

var mockWin = null, uiWin = null;
var created = [], rootFileId = '', capturedUpload = null;

/* ============================ 一、Mock 层 ============================ */
step(function () {
    console.log('\n--- 1. 目录树读取与可见性 ---');
    mockWin = bootApi();
    var Api = mockWin.Api;
    Api.projectDir.tree({ projectId: PID }).done(function (d) {
        check('tree 返回 3 个可见目录（他人私有目录不可见）', d.total === 3,
            JSON.stringify(d.list.map(function (x) { return x.dirName; })));
        var lv2 = d.list.filter(function (x) { return x.level === 2; });
        var root = d.list.filter(function (x) { return x.id === ROOT_DIR; })[0];
        check('tree 深度优先：父在前、子在后且二级带缩进',
            lv2.length === 1 && /└/.test(lv2[0].label) &&
            d.list.indexOf(root) < d.list.indexOf(lv2[0]),
            JSON.stringify(d.list.map(function (x) { return x.label; })));
        check('tree 节点带 fileCount', root && root.fileCount === 1 && lv2[0].fileCount === 1,
            JSON.stringify([root && root.fileCount, lv2[0] && lv2[0].fileCount]));
        check('tree 节点带 parentId / parentName',
            lv2[0] && lv2[0].parentId === ROOT_DIR && lv2[0].parentName === '需求文档',
            JSON.stringify(lv2[0] && [lv2[0].parentId, lv2[0].parentName]));
    }).fail(function (e) { check('tree 调用成功', false, String(e && e.message)); });
    Api.projectFile.page({ projectId: PID, pageNum: 1, pageSize: 50 }).done(function (d) {
        var f = d.list.filter(function (x) { return x.fileName === '需求规格说明书.docx'; })[0];
        check('文件返回 dirId / dirName', f && f.dirId === ROOT_DIR && f.dirName === '需求文档',
            JSON.stringify(f && [f.dirId, f.dirName]));
    });
});

step(function () {
    console.log('\n--- 2. 目录 CRUD / 防重名 / 防环 ---');
    var Api = mockWin.Api;
    Api.projectDir.add({ projectId: PID, parentId: '', dirName: '__测试目录__', dirDesc: '临时', ispub: 1, enabled: 1 })
        .done(function (d) { created.push(d.id); check('add 创建一级目录', d.level === 1 && d.parentId === '', JSON.stringify(d)); })
        .fail(function (e) { check('add 成功', false, String(e && e.message)); });
    Api.projectDir.add({ projectId: PID, parentId: '', dirName: '__测试目录__' })
        .done(function () { check('同级同名被拒', false, '不应创建成功'); })
        .fail(function (e) { check('同级同名被拒', /已存在/.test(String(e && e.message)), String(e && e.message)); });
});

step(function () {
    var Api = mockWin.Api;
    Api.projectDir.update({ id: created[0], parentId: ROOT_DIR, dirName: '__测试目录改名__', enabled: 0 })
        .done(function (d) {
            check('update 改上级 + 改名 + 停用（level 变 2）',
                d.parentId === ROOT_DIR && d.level === 2 && d.enabled === false && d.dirName === '__测试目录改名__',
                JSON.stringify([d.parentId, d.level, d.enabled, d.dirName]));
        }).fail(function (e) { check('update 成功', false, String(e && e.message)); });
    Api.projectDir.tree({ projectId: PID, excludeId: ROOT_DIR }).done(function (d) {
        check('excludeId 排除自身与全部后代',
            d.list.filter(function (x) { return x.id === ROOT_DIR || x.parentId === ROOT_DIR; }).length === 0,
            String(d.total));
    });
});

step(function () {
    console.log('\n--- 3. 目录与文件的关联 / 删除上移 ---');
    var Api = mockWin.Api;
    Api.projectFile.upload({ projectId: PID, dirId: created[0], fileName: '__测试文件__.txt',
        fileType: '文档', data: 'data:text/plain;base64,YWJj', fileSize: 3 })
        .done(function (d) {
            created.push(d.id);
            check('上传可指定 dirId 且回填 dirName',
                d.dirId === created[0] && d.dirName === '__测试目录改名__',
                JSON.stringify([d.dirId, d.dirName]));
        }).fail(function (e) { check('上传成功', false, String(e && e.message)); });
    Api.projectFile.upload({ projectId: PID, fileName: '__根文件__.txt',
        fileType: '文档', data: 'data:text/plain;base64,YWJj', fileSize: 3 })
        .done(function (d) {
            rootFileId = d.id;
            check('不选择目录时 dirId 为空（文件直接关联项目）', d.dirId === '', JSON.stringify(d.dirId));
            Api.projectFile.page({ projectId: PID, dirId: 'root', pageNum: 1, pageSize: 50 }).done(function (r) {
                check('dirId=root 只返回未关联目录的文件', r.total === 1 && r.list[0].id === rootFileId,
                    String(r.total));
            });
        });
});

step(function () {
    var Api = mockWin.Api;
    Api.projectDir.remove(created[0]).done(function (d) {
        check('删除返回 movedFiles=1', d.movedFiles === 1, String(d.movedFiles));
        Api.projectFile.detail(created[1]).done(function (f) {
            check('文件 dirId 被清空、回到项目根（文件未删）', f.dirId === '', JSON.stringify(f.dirId));
        });
    }).fail(function (e) { check('删除成功', false, String(e && e.message)); });
});

step(function () {
    var Api = mockWin.Api;
    Api.projectFile.remove(created[1]).always(function () { });
    Api.projectFile.remove(rootFileId).always(function () { });
    Api.projectDir.tree({ projectId: PID }).done(function (d) {
        check('测试目录残骸已清理', d.list.filter(function (x) { return /__测试|__根/.test(x.dirName); }).length === 0,
            String(d.total));
    });
});

/* ============================ 二、UI 层 ============================ */
step(function () {
    console.log('\n--- 4. 首屏静态骨架 ---');
    uiWin = bootPage();
    var $ = uiWin.jQuery;
    check('3 个目录图标按钮存在且编辑/删除初始禁用',
        $('#btnDirAdd').length === 1 && $('#btnDirEdit').length === 1 && $('#btnDirDelete').length === 1 &&
        $('#btnDirEdit').prop('disabled') === true && $('#btnDirDelete').prop('disabled') === true);
    check('默认展示「文件列表」标签页', $('#pfTabList').hasClass('is-active') && !$('#pfTabTree').hasClass('is-active'));
    check('两个标签页文案为「文件列表 / 目录」',
        $.trim($('#pfTabList').text()) === '文件列表' && $.trim($('#pfTabTree').text()) === '目录',
        $('#pfTabList').text() + ' / ' + $('#pfTabTree').text());
    check('目录树容器初始隐藏', $('#pfTreeView').css('display') === 'none', $('#pfTreeView').css('display'));
});

step(function () {
    console.log('\n--- 5. 列表加载 / 选中项目 ---');
    var $ = uiWin.jQuery;
    var $row = $('#pjTbody tr[data-id]').filter(function () { return /PRO000001/.test($(this).text()); });
    check('首屏渲染出 PRO000001 项目行', $row.length === 1, String($row.length));
    $row.trigger('click');
    check('单击选中项目后「创建文件夹」可用', $('#btnDirAdd').prop('disabled') === false);
    $row.trigger('dblclick');      // 异步加载文件列表 + 目录树
});

step(function () {
    console.log('\n--- 6. 目录树标签页渲染与选中联动 ---');
    var $ = uiWin.jQuery;
    $('#pfTabTree').trigger('click');
    check('切到目录树后树容器显示、列表隐藏',
        $('#pfTabTree').hasClass('is-active') && $('#pfTreeView').css('display') !== 'none' &&
        $('#pfPanelWrapper').css('display') === 'none',
        'tree=' + $('#pfTreeView').css('display') + ' list=' + $('#pfPanelWrapper').css('display'));
    check('不再有「项目根目录」节点（data-kind=root 数量为 0）',
        $('#pfTreeView .pj-tnode[data-kind=root]').length === 0 &&
        !/项目根目录/.test($('#pfTreeView').text()));
    check('目录视图顶部有「移出目录」拖拽落点，默认隐藏（靠 is-dragging 显示）',
        $('#pfTreeView .pj-tree__rootdrop').length === 1 &&
        $('#pfTreeView').hasClass('is-dragging') === false);
    check('文件节点可拖拽（draggable=true）',
        $('#pfTreeView .pj-tnode[data-kind=file][draggable=true]').length === 2,
        String($('#pfTreeView .pj-tnode[data-kind=file][draggable=true]').length));
    check('树里渲染出 3 个可见目录', $('#pfTreeView .pj-tnode[data-kind=dir]').length === 3,
        String($('#pfTreeView .pj-tnode[data-kind=dir]').length));
    check('树里渲染出带 dirId 的文件节点',
        $('#pfTreeView .pj-tnode[data-kind=file]').length === 2,
        String($('#pfTreeView .pj-tnode[data-kind=file]').length));
    $('#pfTreeView .pj-tnode[data-kind=dir]').first().trigger('click');
    check('单击目录后编辑/删除按钮可用、文件操作禁用',
        $('#btnDirEdit').prop('disabled') === false && $('#btnDirDelete').prop('disabled') === false &&
        $('#btnPfDelete').prop('disabled') === true);
    $('#pfTreeView .pj-tnode[data-kind=file]').first().trigger('click');
    check('单击文件后目录按钮禁用、文件按钮可用',
        $('#btnDirEdit').prop('disabled') === true && $('#btnDirDelete').prop('disabled') === true &&
        $('#btnPfDelete').prop('disabled') === false);
});

step(function () {
    console.log('\n--- 7. 展开 / 折叠 ---');
    var $ = uiWin.jQuery;
    var before = $('#pfTreeView .pj-tnode[data-kind=dir]').length;
    var $caret = $('#pfTreeView .pj-tnode[data-kind=dir]').find('.pj-tnode__caret.is-clickable').first();
    check('有子级的目录显示可点击三角（"需求文档"有子目录）', $caret.length === 1);
    $caret.trigger('click');
    var after = $('#pfTreeView .pj-tnode[data-kind=dir]').length;
    check('折叠后子目录节点被隐藏', after < before, 'before=' + before + ' after=' + after);
    $('#pfTreeView .pj-tnode[data-kind=dir]').find('.pj-tnode__caret.is-clickable').first().trigger('click');
    check('再次展开后节点数恢复',
        $('#pfTreeView .pj-tnode[data-kind=dir]').length === before,
        String($('#pfTreeView .pj-tnode[data-kind=dir]').length));
});

step(function () {
    console.log('\n--- 8. 打开创建文件夹弹窗 ---');
    var $ = uiWin.jQuery;
    $('#btnDirAdd').trigger('click');
    var $dlg = $('.el-dialog').last();
    uiWin.__dirDlg = $dlg;
    check('创建弹窗标题正确且字段齐全',
        $dlg.length === 1 && /创建文件夹/.test($dlg.find('.el-dialog__title').text()) &&
        $dlg.find('#dirName').length === 1 && $dlg.find('#dirParent').length === 1,
        $dlg.find('.el-dialog__title').text());
});

step(function () {
    console.log('\n--- 9. 上级目录下拉 / 提交创建 ---');
    var $dlg = uiWin.__dirDlg;
    check('上级下拉含「项目根目录」+ 3 个可选目录',
        /项目根目录/.test($dlg.find('#dirParent').text()) && $dlg.find('#dirParent option').length === 4,
        String($dlg.find('#dirParent option').length));
    $dlg.find('#dirName').val('__UI测试目录__');
    $dlg.find('#dirDesc').val('UI 测试说明');
    $dlg.find('.btn-ok').trigger('click');   // 异步保存
});

step(function () {
    console.log('\n--- 10. 新目录进入树 / 打开编辑弹窗 ---');
    var $ = uiWin.jQuery;
    check('创建成功提示', /文件夹已创建/.test($('.el-message-list').text()),
        $('.el-message-list').text().slice(0, 80));
    var $new = $('#pfTreeView .pj-tnode[data-kind=dir]').filter(function () {
        return /__UI测试目录__/.test($(this).text());
    });
    check('新目录出现在目录树里', $new.length === 1, String($new.length));
    uiWin.__newDirId = $new.attr('data-id') || '';
    $new.trigger('click');
    $('#btnDirEdit').trigger('click');
    var $dlg = $('.el-dialog').last();
    uiWin.__dirDlg = $dlg;
    check('编辑弹窗回填原目录名与说明',
        $dlg.find('#dirName').val() === '__UI测试目录__' && $dlg.find('#dirDesc').val() === 'UI 测试说明',
        JSON.stringify([$dlg.find('#dirName').val(), $dlg.find('#dirDesc').val()]));
});

step(function () {
    console.log('\n--- 11. 编辑弹窗排除自身 / 提交改名 ---');
    var $dlg = uiWin.__dirDlg;
    check('编辑弹窗上级下拉排除自身',
        uiWin.__newDirId !== '' &&
        $dlg.find('#dirParent option[value="' + uiWin.__newDirId + '"]').length === 0,
        uiWin.__newDirId);
    $dlg.find('#dirName').val('__UI测试目录改名__');
    $dlg.find('.btn-ok').trigger('click');   // 异步保存
});

step(function () {
    console.log('\n--- 12. 改名生效 / 删除确认 ---');
    var $ = uiWin.jQuery;
    check('目录改名已生效', /__UI测试目录改名__/.test($('#pfTreeView').text()),
        $('#pfTreeView').text().slice(0, 120));
    var $new = $('#pfTreeView .pj-tnode[data-kind=dir]').filter(function () {
        return /__UI测试目录改名__/.test($(this).text());
    });
    $new.trigger('click');
    $('#btnDirDelete').trigger('click');
    var $box = $('.el-message-box').last();
    check('删除确认框提示「不会删除文件」',
        $box.length === 1 && /不会删除文件/.test($box.text()), $box.text().slice(0, 100));
    $box.find('.btn-ok').trigger('click');   // 异步删除
});

step(function () {
    console.log('\n--- 13. 删除生效 / 打开上传弹窗 ---');
    var $ = uiWin.jQuery;
    check('删除后目录树不再含测试目录', !/__UI测试目录/.test($('#pfTreeView').text()));
    $('#btnPfUpload').trigger('click');
    var $dlg = $('.el-dialog').last();
    uiWin.__upDlg = $dlg;
    check('上传弹窗打开', /上传项目文件/.test($dlg.find('.el-dialog__title').text()),
        $dlg.find('.el-dialog__title').text());
});

step(function () {
    console.log('\n--- 14. 上传弹窗「所属目录」下拉 + dirId 提交 ---');
    var $ = uiWin.jQuery;
    var $dlg = uiWin.__upDlg;
    var $sel = $dlg.find('#upDirId');
    check('所属目录改成下拉框（不再有目录树 / 清空按钮）',
        $sel.length === 1 && $sel.is('select') &&
        $dlg.find('#upDirTree').length === 0 && $dlg.find('#upDirClear').length === 0 &&
        $dlg.find('#upDirName').length === 0);
    check('下拉 4 项 =「不选择」+ 3 个种子目录', $sel.find('option').length === 4,
        String($sel.find('option').length));
    check('默认选中「不选择」（文件直接关联项目）',
        $sel.val() === '' && /不选择/.test($sel.find('option:selected').text()),
        $sel.val() + ' / ' + $sel.find('option:selected').text());
    var optTexts = $sel.find('option').map(function () { return $(this).text(); }).get();
    check('子目录选项带层级缩进（全角空格 + └）',
        optTexts.length > 0 && (function () {
            for (var i = 0; i < optTexts.length; i++) {
                if (/\u3000/.test(optTexts[i]) && /└/.test(optTexts[i])) { return true; }
            }
            return false;
        })(), JSON.stringify(optTexts));
    var pickId = $sel.find('option').not('[value=""]').last().val();
    $sel.val(pickId).trigger('change');
    check('选中目录后 select 值同步为新目录', $sel.val() === pickId, String($sel.val()));
    var dfd = uiWin.jQuery.Deferred();
    uiWin.Api.projectFile.upload = function (payload) { capturedUpload = payload; return dfd.promise(); };
    $dlg.find('#upData').val('data:text/plain;base64,YWJj').attr('data-size', 3);
    $dlg.find('#upName').val('__UI上传__.txt');
    $dlg.find('.btn-ok').trigger('click');
    check('上传提交携带下拉选中的 dirId',
        !!capturedUpload && capturedUpload.dirId === pickId && pickId !== '',
        JSON.stringify(capturedUpload && capturedUpload.dirId));
    dfd.resolve({ fileName: '__UI上传__.txt' });
});

step(function () {
    console.log('\n--- 15. 清理测试残骸 ---');
    var Api = uiWin.Api;
    Api.projectDir.tree({ projectId: PID }).done(function (d) {
        var left = d.list.filter(function (x) { return /__UI测试/.test(x.dirName); });
        check('UI 测试目录残骸已清理', left.length === 0, String(left.length));
        check('目录树仍保留 3 个种子目录', d.total === 3, String(d.total));
    });
});

step(function () {
    console.log('\n--- 16. 多子目录渲染回归（历史 bug：递归共享循环变量 → 死循环） ---');
    var Api = uiWin.Api;
    // 「需求文档」原有 1 个子目录，再加 2 个同级叶子目录 → 父目录 3 个叶子子节点。
    // 旧实现 drawDir 复用外层 k，递归返回后把父层 k 重置为 0，父层会永远重复递归
    // 同一下标，直到 RangeError: Invalid string length，整棵目录树渲染不出来。
    Api.projectDir.add({ projectId: PID, parentId: ROOT_DIR, dirName: '__多子回归A__', ispub: 1, enabled: 1 });
    Api.projectDir.add({ projectId: PID, parentId: ROOT_DIR, dirName: '__多子回归B__', ispub: 1, enabled: 1 });
    uiWin.jQuery('#btnPfRefresh').trigger('click');
});
step(function () {
    var $ = uiWin.jQuery;
    var n = $('#pfTreeView .pj-tnode[data-kind=dir]').length;
    var mine = $('#pfTreeView .pj-tnode[data-kind=dir]').filter(function () {
        return /__多子回归/.test($(this).text());
    }).length;
    check('父目录下多个叶子子目录时树仍正常渲染（不再 RangeError 死循环）', n === 5, 'dirs=' + n);
    check('新增的两个同级子目录都出现在树里', mine === 2, String(mine));
    uiWin.__regDirs = [];
    $('#pfTreeView .pj-tnode[data-kind=dir]').filter(function () {
        return /__多子回归/.test($(this).text());
    }).each(function () { uiWin.__regDirs.push($(this).attr('data-id')); });
});
step(function () {
    var Api = uiWin.Api;
    var ids = uiWin.__regDirs || [];
    check('能取到回归测试目录 id', ids.length === 2, String(ids.length));
    for (var i = 0; i < ids.length; i++) { Api.projectDir.remove(ids[i]); }
    uiWin.jQuery('#btnPfRefresh').trigger('click');
});
step(function () {
    var $ = uiWin.jQuery;
    check('回归测试目录已清理，树回到 3 个种子目录',
        $('#pfTreeView .pj-tnode[data-kind=dir]').length === 3,
        String($('#pfTreeView .pj-tnode[data-kind=dir]').length));
});

step(function () {
    console.log('\n--- 17. 目录视图：拖拽文件移动到其它目录 ---');
    var $ = uiWin.jQuery;
    uiWin.__dragFile = $('#pfTreeView .pj-tnode[data-kind=file]').filter(function () {
        return /架构设计\.png/.test($(this).text());
    }).first();
    uiWin.__dragDir = $('#pfTreeView .pj-tnode[data-kind=dir]').filter(function () {
        return /评审资料/.test($(this).text());
    }).first();
    check('找到待拖动的文件节点与目标目录节点',
        uiWin.__dragFile.length === 1 && uiWin.__dragDir.length === 1);
    uiWin.__dirTargetId = uiWin.__dragDir.attr('data-id');
    uiWin.__dragFile.trigger('dragstart');
    check('dragstart 后树容器与文件节点进入拖拽态',
        $('#pfTreeView').hasClass('is-dragging') && uiWin.__dragFile.hasClass('is-dragging'));
    uiWin.__dragDir.trigger('dragover');
    check('拖到目录上出现可放置高亮', uiWin.__dragDir.hasClass('is-drop-target'));
    uiWin.__dragDir.trigger('drop');
});

step(function () {
    var $ = uiWin.jQuery;
    check('drop 后拖拽态全部清理（is-dragging / is-drop-target 均移除）',
        !$('#pfTreeView').hasClass('is-dragging') &&
        $('#pfTreeView .is-drop-target').length === 0 &&
        $('#pfTreeView .is-dragging').length === 0);
    uiWin.Api.projectFile.detail('pfl-0000-4000-8000-000000000002').done(function (d) {
        check('文件所属目录已改为拖入的目录',
            String(d.dirId) === String(uiWin.__dirTargetId),
            String(d.dirId) + ' vs ' + uiWin.__dirTargetId);
    });
});

step(function () {
    console.log('\n--- 18. 目录视图：拖到「移出目录」回到项目根 ---');
    var $ = uiWin.jQuery;
    var $f = $('#pfTreeView .pj-tnode[data-kind=file]').filter(function () {
        return /架构设计\.png/.test($(this).text());
    }).first();
    check('刷新后文件仍在树里', $f.length === 1, String($f.length));
    $f.trigger('dragstart');
    var $drop = $('#pfTreeView .pj-tree__rootdrop');
    $drop.trigger('dragover');
    check('拖到「移出目录」落点时高亮', $drop.hasClass('is-drop-target'));
    $drop.trigger('drop');
});

step(function () {
    uiWin.Api.projectFile.detail('pfl-0000-4000-8000-000000000002').done(function (d) {
        check('拖到「移出目录」后 dirId 置空（文件回到项目根）', !d.dirId, String(d.dirId));
        check('移出目录只是改归属，文件本身仍在项目下',
            String(d.projectId) === String(PID) && /架构设计/.test(d.fileName || ''),
            String(d.projectId) + ' / ' + d.fileName);
    });
    // 还原种子归属，保持 Mock 数据可重复
    uiWin.Api.projectFile.update({
        id: 'pfl-0000-4000-8000-000000000002',
        dirId: 'pdr-0000-4000-8000-000000000002'
    });
});

step(function () {
    // 上一节直接调接口还原了归属，树需要刷新后才能重新取到节点
    uiWin.jQuery('#btnPfRefresh').trigger('click');
});

step(function () {
    console.log('\n--- 19. 落到非空目录内的子文件上也移入该目录（按坐标解析落点） ---');
    var $ = uiWin.jQuery, doc = uiWin.document;
    var $src = $('#pfTreeView .pj-tnode--file').filter(function () {
        return /架构设计\.png/.test($(this).text());
    }).first();
    var $child = $('#pfTreeView .pj-tnode--file').filter(function () {
        return /需求规格说明书\.docx/.test($(this).text());
    }).first();
    check('找到源文件与非空目录「需求文档」里的子文件节点',
        $src.length === 1 && $child.length === 1,
        $src.length + '/' + $child.length);
    check('「需求文档」是非空目录（下面有子文件与子目录）',
        $('#pfTreeView .pj-tnode--dir[data-id="' + ROOT_DIR + '"]').length === 1 &&
        $child.length === 1);

    var realFromPoint = doc.elementFromPoint;
    // 模拟鼠标松手的位置正好压在「需求文档」里的子文件行上（旧实现到这里就不认落点）
    doc.elementFromPoint = function () { return $child[0]; };
    var Api = uiWin.Api, origUpdate = Api.projectFile.update;
    uiWin.__dragPayload = null;
    Api.projectFile.update = function (payload) {
        uiWin.__dragPayload = payload;
        return origUpdate.call(Api.projectFile, payload);
    };
    $src.trigger('dragstart');
    var view = $('#pfTreeView')[0];
    view.dispatchEvent(new uiWin.MouseEvent('dragover',
        { bubbles: true, cancelable: true, clientX: 140, clientY: 260 }));
    check('落在子文件上时高亮的是它所属的目录行（而不是子文件行）',
        $('#pfTreeView .pj-tnode--dir[data-id="' + ROOT_DIR + '"]').hasClass('is-drop-target') &&
        $child.hasClass('is-drop-target') === false);
    var overEvent = new uiWin.MouseEvent('dragover',
        { bubbles: true, cancelable: true, clientX: 140, clientY: 260 });
    view.dispatchEvent(overEvent);
    check('非空目录区域内 dragover 被阻止默认行为（否则浏览器显示禁止放置光标）',
        overEvent.defaultPrevented === true);
    view.dispatchEvent(new uiWin.MouseEvent('drop',
        { bubbles: true, cancelable: true, clientX: 140, clientY: 260 }));
    doc.elementFromPoint = realFromPoint;
    Api.projectFile.update = origUpdate;
    check('提交的 dirId 是子文件所属的「需求文档」',
        uiWin.__dragPayload && String(uiWin.__dragPayload.dirId) === ROOT_DIR,
        JSON.stringify(uiWin.__dragPayload));
});

step(function () {
    uiWin.Api.projectFile.detail('pfl-0000-4000-8000-000000000002').done(function (d) {
        check('文件已移入「需求文档」', String(d.dirId) === ROOT_DIR, String(d.dirId));
    });
    check('移动完成后拖拽态已清理',
        !uiWin.jQuery('#pfTreeView').hasClass('is-dragging') &&
        uiWin.jQuery('#pfTreeView .is-drop-target').length === 0);
});

step(function () {
    console.log('\n--- 20. 落到树内空白区 / 提示条上 → 移出目录回项目根 ---');
    var $ = uiWin.jQuery, doc = uiWin.document;
    var $src = $('#pfTreeView .pj-tnode--file').filter(function () {
        return /架构设计\.png/.test($(this).text());
    }).first();
    check('文件现在挂在「需求文档」下', $src.length === 1, String($src.length));
    var realFromPoint = doc.elementFromPoint;
    doc.elementFromPoint = function () { return $('#pfTreeView .pj-tree__rootdrop')[0]; };
    var Api = uiWin.Api, origUpdate = Api.projectFile.update;
    uiWin.__dragPayload2 = null;
    Api.projectFile.update = function (payload) {
        uiWin.__dragPayload2 = payload;
        return origUpdate.call(Api.projectFile, payload);
    };
    $src.trigger('dragstart');
    var view = $('#pfTreeView')[0];
    view.dispatchEvent(new uiWin.MouseEvent('dragover',
        { bubbles: true, cancelable: true, clientX: 140, clientY: 640 }));
    check('落在提示条 / 空白区时高亮的是「移出目录」提示条',
        $('#pfTreeView .pj-tree__rootdrop').hasClass('is-drop-target') &&
        $('#pfTreeView .pj-tnode.is-drop-target').length === 0);
    view.dispatchEvent(new uiWin.MouseEvent('drop',
        { bubbles: true, cancelable: true, clientX: 140, clientY: 640 }));
    doc.elementFromPoint = realFromPoint;
    Api.projectFile.update = origUpdate;
    check('空白区落点提交的 dirId 为空（回项目根）',
        uiWin.__dragPayload2 && !uiWin.__dragPayload2.dirId,
        JSON.stringify(uiWin.__dragPayload2));
});

step(function () {
    uiWin.Api.projectFile.detail('pfl-0000-4000-8000-000000000002').done(function (d) {
        check('文件已回到项目根（dirId 为空）', !d.dirId, String(d.dirId));
    });
    // 还原种子归属
    uiWin.Api.projectFile.update({
        id: 'pfl-0000-4000-8000-000000000002',
        dirId: 'pdr-0000-4000-8000-000000000002'
    });
    uiWin.jQuery('#btnPfRefresh').trigger('click');
});

step(function () {
    console.log('\n--- 21. 目录视图双击文件节点 → 在线预览（单击不得重建节点） ---');
    var $ = uiWin.jQuery;
    function fileNode() {
        return $('#pfTreeView .pj-tnode--file').filter(function () {
            return /架构设计\.png/.test($(this).text());
        }).first();
    }
    var $f = fileNode();
    check('找到「架构设计.png」文件节点', $f.length === 1, String($f.length));
    var raw = $f[0];
    $f.trigger('click');
    var $after = fileNode();
    check('单击文件只就地改选中态、不重建节点（保住双击的落点）',
        $after.length === 1 && $after[0] === raw && $after.hasClass('is-selected'),
        'same=' + ($after[0] === raw) + ' selected=' + $after.hasClass('is-selected'));
    check('单击文件后文件按钮可用、目录按钮禁用',
        $('#btnPfDelete').prop('disabled') === false &&
        $('#btnDirEdit').prop('disabled') === true);
    $after.trigger('dblclick');     // 打开预览弹窗
});

step(function () {
    var $ = uiWin.jQuery;
    var $dlg = $('.el-dialog').last();
    check('双击文件节点弹出预览弹窗，标题为文件名',
        $dlg.length === 1 && /架构设计\.png/.test($dlg.find('.el-dialog__title').text()),
        $dlg.find('.el-dialog__title').text());
    check('图片预览渲染出 .fp-img 且指向文件路径',
        $dlg.find('.fp-img').length === 1 &&
        /\/data\/projectfiles\/demo\/architecture\.png$/.test(String($dlg.find('.fp-img').attr('src') || '')),
        String($dlg.find('.fp-img').attr('src')));
    /* 关闭预览，避免弹窗叠在后续用例上 */
    $dlg.find('.el-dialog__headerbtn').not('.el-dialog__headerbtn--max').trigger('click');
});

next();
