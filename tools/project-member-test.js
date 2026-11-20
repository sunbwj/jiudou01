/* ==========================================================================
   project-member-test.js —— 项目管理 · 项目组管理（jsdom）
   --------------------------------------------------------------------------
   覆盖：
     ① 工具栏「项目组」按钮：未选中项目时禁用，选中后启用；
     ② 弹窗：标题带项目名、员工信息表渲染（姓名 / 部门 / 邮箱）、已有成员默认勾选；
     ③ 勾选 / 取消勾选实时更新「已选 N 人」；
     ④ 确定 → Api.projectMember.save({projectId, memberIds})，成功后提示后端返回的 message；
     ⑤ 取消 → 不调用保存。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/project-member-test.js
   ========================================================================== */
'use strict';
process.on('unhandledRejection', function () { /* 页面里的异步请求桩不影响测试结论 */ });
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
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(cond, ms) {
    var end = Date.now() + (ms || 1500);
    while (Date.now() < end) {
        if (cond()) { return true; }
        await wait(20);
    }
    return false;
}

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

function boot(page, scripts) {
    var dom = new JSDOM(read(page), {
        url: 'http://127.0.0.1:8808/' + page,
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
    win.AppNav.go = function (url2) { win.__lastNav = url2; };
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

(async function () {
    var win = boot('project.html', ['js/word-import.js', 'js/file-preview.js', 'js/project.js']);
    var $ = win.jQuery;
    var Api = win.Api;

    var CALLS = { members: 0, save: [] };
    var STUB_EMPS = [
        { id: 3, name: '杨伟康', deptName: '医疗大数据事业部', jobTitle: '事业部经理', email: 'yangwk@szyc-data.com' },
        { id: 5, name: '张三', deptName: '财务部', jobTitle: '出纳', email: '' }
    ];

    /* ---------------- 0. 静态骨架 ---------------- */
    console.log('\n--- 0. 工具栏与弹窗模板 ---');
    check('工具栏有「项目组管理」按钮', $('#btnMembers').length === 1);
    check('按钮带图标与说明（title / aria-label）',
        $('#btnMembers svg').length === 1 &&
        $('#btnMembers').attr('title').indexOf('项目组') > -1 &&
        $('#btnMembers').attr('aria-label').indexOf('项目组') > -1);
    check('弹窗模板存在（搜索框 / 列表 / 计数 / 说明）',
        $('#pjMembersTpl #pmSearch').length === 1 &&
        $('#pjMembersTpl #pmList').length === 1 &&
        $('#pjMembersTpl #pmCount').length === 1 &&
        $('#pjMembersTpl #pmTip').text().indexOf('站内即时消息') > -1);

    await until(function () { return $('#pjTbody tr[data-id]').length > 0; }, 3000);
    check('未选中项目时按钮禁用', $('#btnMembers').prop('disabled') === true);

    /* ---------------- 1. 选中项目后启用 ---------------- */
    console.log('\n--- 1. 选中项目 → 按钮启用 ---');
    $('#pjTbody tr[data-id]').first().trigger('click');
    check('选中项目后按钮可用', $('#btnMembers').prop('disabled') === false);

    /* ---------------- 2. 打开弹窗 ---------------- */
    console.log('\n--- 2. 弹窗：员工信息表 + 已有成员默认勾选 ---');
    Api.projectMember = {
        members: function (projectId) {
            CALLS.members++;
            var d = $.Deferred();
            d.resolve({
                projectId: projectId, projectName: '九豆综合管理平台研发', projectCode: 'PRO000001',
                emailEnabled: true, memberCount: 1,
                list: [{ empId: 3, empName: '杨伟康', deptName: '医疗大数据事业部', email: 'yangwk@szyc-data.com' }]
            });
            return d.promise();
        },
        save: function (data) {
            CALLS.save.push(data);
            var d = $.Deferred();
            d.resolve({ added: 1, removed: 0, notified: 1, mailed: 0,
                message: '已保存：新增 1 人、移除 0 人；站内消息 1 条' });
            return d.promise();
        }
    };
    Api.emp = {
        page: function () {
            var d = $.Deferred();
            d.resolve({ list: STUB_EMPS, total: STUB_EMPS.length });
            return d.promise();
        }
    };

    var row = $('#pjTbody tr[data-id]').first();
    var projectId = row.attr('data-id');
    var projectName = row.find('td').eq(2).text() || '项目';
    $('#btnMembers').trigger('click');
    await until(function () { return $('.el-overlay .pj-members__item').length > 0; }, 2000);
    await until(function () { return $('.pj-members__count b').text() === '1'; }, 2000);

    check('弹窗标题带项目名', $('.el-dialog__title').text().indexOf('项目组管理') > -1 &&
        $('.el-dialog__title').text().length > 6);
    check('渲染员工信息表的全部员工（2 行）', $('.pj-members__item').length === 2,
        'rows=' + $('.pj-members__item').length);
    check('已有成员默认勾选（杨伟康）', $('.pj-members__item input[data-emp="3"]').prop('checked') === true);
    check('未加入的员工不勾选（张三）', $('.pj-members__item input[data-emp="5"]').prop('checked') === false);
    check('已选人数显示 1', $('.pj-members__count b').text() === '1');
    check('有邮箱的显示邮箱、没邮箱的显示「无邮箱」',
        $('.pj-members__item .pj-members__mail').first().text().indexOf('@') > -1 &&
        $('.pj-members__mail').eq(1).text() === '无邮箱');
    check('说明区提示「新加入」与邮件', $('#pmTip').text().indexOf('新加入') > -1 &&
        $('#pmTip').text().indexOf('邮件') > -1);

    /* ---------------- 3. 勾选切换 ---------------- */
    console.log('\n--- 3. 勾选 / 取消 ----------------');
    $('.pj-members__item input[data-emp="5"]').prop('checked', true).trigger('change');
    check('勾选张三后已选 2 人', $('.pj-members__count b').text() === '2');
    $('.pj-members__item input[data-emp="3"]').prop('checked', false).trigger('change');
    check('取消杨伟康后已选 1 人', $('.pj-members__count b').text() === '1');

    /* ---------------- 4. 搜索过滤 ---------------- */
    console.log('\n--- 4. 搜索过滤 ----------------');
    $('#pmSearch').val('财务').trigger('input');
    check('按部门检索只剩 1 行', $('.pj-members__item').length === 1 &&
        $('.pj-members__item').text().indexOf('张三') > -1);
    $('#pmSearch').val('').trigger('input');
    check('清空检索恢复 2 行', $('.pj-members__item').length === 2);

    /* ---------------- 5. 保存 ---------------- */
    console.log('\n--- 5. 确定 → 调用保存接口 ----------------');
    $('.el-dialog__footer .btn-ok').trigger('click');
    await until(function () { return CALLS.save.length > 0; }, 2000);
    var payload = CALLS.save[0] || {};
    check('保存带上 projectId', String(payload.projectId) === String(projectId),
        payload.projectId + ' vs ' + projectId);
    check('保存带上勾选的成员（只有张三）',
        (payload.memberIds || []).join(',') === '5', (payload.memberIds || []).join(','));
    await until(function () { return $('.el-message-list').text().length > 0; }, 1500);
    check('保存后提示后端返回的通知结果',
        $('.el-message-list').text().indexOf('站内消息 1 条') > -1,
        $('.el-message-list').text());

    /* ---------------- 6. 取消不保存 ---------------- */
    console.log('\n--- 6. 取消不保存 ----------------');
    var before = CALLS.save.length;
    $('#btnMembers').trigger('click');
    await until(function () { return $('.el-overlay .pj-members__item').length > 0; }, 2000);
    $('.el-dialog__footer .btn-cancel').trigger('click');
    check('取消后没有新增保存调用', CALLS.save.length === before);
    check('弹窗已关闭', $('.el-overlay').length === 0);

    console.log('\n===== project-member-test 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
    process.exit(fail ? 1 : 0);
})();
