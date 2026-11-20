/* ==========================================================================
   service-email-test.js —— 服务信箱设置页面测试（jsdom，Mock 通道）
   覆盖：单例表（全表只允许一条记录）/ 列表与列结构 / 密码不外泄 /
        服务器地址自动推断 / 工具栏只保留「启用 停用 测试连接 编辑 刷新」/
        接口层拒绝新增第二条（add 报「只允许一条记录」）/
        编辑弹窗（复用 js/service-email-form.js：密码留空不修改）/
        启用状态切换 / 测试连接 / 关键字检索
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/service-email-test.js
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
    win.eval(read('js/ui.js'));
    win.eval(read('js/service-email-form.js'));
    win.eval(read('js/layout.js'));
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

var win = boot('service-email.html', ['js/service-email.js']);
var $ = win.jQuery;

function rows() { return $('#seTbody tr[data-id]'); }
function rowCount() { return rows().length; }
function dialogs() { return $('.el-overlay .el-dialog'); }
function dialog() { return dialogs().last(); }
function dialogBody() { return dialog().find('.el-dialog__body'); }
function msgBox() { return $('.el-message-box').last(); }
function toast() { return $('.el-message-list').text(); }
function enabledRows() {
    return rows().filter(function () {
        return /启用/.test($(this).text()) && !/停用/.test($(this).text());
    });
}
function state() { return JSON.parse(win.localStorage.getItem('menu_admin_serviceemail_v1') || '[]'); }
function rowOf(email) {
    return rows().filter(function () { return $(this).text().indexOf(email) > -1; });
}

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 700 }); }
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
    console.log('\n--- 1. 首屏（种子：1 条唯一的服务信箱）---');
    check('页面标题为「服务信箱设置」', /服务信箱设置/.test($('.page-head__title').text()),
        $('.page-head__title').text());
    check('面包屑上报为「邮件中心/服务信箱设置」',
        $('#pageHead').attr('data-crumb') === '邮件中心/服务信箱设置', $('#pageHead').attr('data-crumb'));
    check('顶部说明写明「全表只保留一条记录」', /全表只保留一条记录/.test($('.se-tip').text()),
        $('.se-tip').text().slice(0, 60));
    check('说明里指向「邮箱助手」右上角设置按钮新增 / 编辑',
        /邮箱助手/.test($('.se-tip').text()) && /设置按钮/.test($('.se-tip').text()),
        $('.se-tip').text().slice(0, 80));
    check('操作引导区只保留 5 个按钮（启用 / 停用 / 测试连接 / 编辑 / 刷新）',
        ['#btnEnable', '#btnDisable', '#btnTest', '#btnEdit', '#btnRefresh']
            .every(function (id) { return $(id).length === 1; }) && $('.toolbar .el-button').length === 5,
        '按钮数 ' + $('.toolbar .el-button').length);
    check('「新增服务信箱」按钮已移除', $('#btnAdd').length === 0 && !/新增服务信箱/.test($('.toolbar').text()),
        $('.toolbar').text().replace(/\s+/g, ' ').slice(0, 80));
    check('「删除」按钮已移除', $('#btnDelete').length === 0 && !/删除/.test($('.toolbar').text()),
        $('.toolbar').text().replace(/\s+/g, ' ').slice(0, 80));
    check('表头 9 列（序号/选择/邮箱/发件人/IMAP/SMTP/启用/最近收件/创建时间）',
        $('#seTable thead th').length === 9, String($('#seTable thead th').length));
    check('列表渲染 1 条种子服务信箱（单例表）', rowCount() === 1, String(rowCount()));
    var row = rows().first();
    check('行内显示邮箱地址 service@jiudou.com', /service@jiudou\.com/.test(row.text()), row.text().slice(0, 60));
    check('行内显示启用状态', /启用/.test(row.text()));
    check('自定义域名按 imap.<域名> / smtp.<域名> 自动推断',
        /imap\.jiudou\.com:993/.test(row.text()) && /smtp\.jiudou\.com:465/.test(row.text()),
        row.find('.se-host').first().text() + ' / ' + row.find('.se-host').last().text());
    check('列表不出现明文密码（demo-123456）', $('body').text().indexOf('demo-123456') < 0);
    check('工具栏提示当前启用的邮箱', /service@jiudou\.com/.test($('#enabledTip').text()), $('#enabledTip').text());
    check('未选中行时编辑 / 启用 / 停用按钮禁用',
        $('#btnEdit').prop('disabled') === true &&
        $('#btnEnable').prop('disabled') === true && $('#btnDisable').prop('disabled') === true);
    check('列表不出现「******」以外的密码痕迹', $('body').text().indexOf('******') < 0);
});

step(function () {
    console.log('\n--- 2. 接口层：单例表拒绝新增第二条 ---');
    win.Api.serviceEmail.add({
        email: 'support@163.com', password: 'pwd-123456', displayName: '九豆客服', enabled: 1
    }).done(function () {
        check('已有记录时 add 被拒绝', false, '接口居然新增成功了（Mock 单例校验失效）');
    }).fail(function (err) {
        check('已有记录时 add 被拒绝，并提示去编辑已有记录',
            /只允许一条记录/.test((err && err.message) || '') && /编辑/.test((err && err.message) || ''),
            (err && err.message) || '');
    });
    check('本地存储里仍然是 1 条记录（没被写进第二条）', state().length === 1, String(state().length));
});

step(function () {
    console.log('\n--- 3. 编辑（弹窗来自共享模块 js/service-email-form.js）---');
    rows().first().trigger('click');
    $('#btnEdit').trigger('click');
});

step(function () {
    check('弹出编辑弹窗并回填邮箱', /编辑服务信箱/.test(dialog().text()) &&
        dialogBody().find('#sfEmail').val() === 'service@jiudou.com', dialog().find('.el-dialog__title').text());
    check('标题里带邮箱地址（单例表：编辑的就是那唯一一条）',
        /service@jiudou\.com/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    check('弹窗宽度收窄为 560px', String(dialog()[0].style.width).indexOf('560') === 0,
        String(dialog()[0].style.width));
    check('编辑时提示「留空表示不修改」', /留空/.test(dialogBody().find('#sfPasswordTip').text()),
        dialogBody().find('#sfPasswordTip').text());
    check('密码输入框为空（接口不返回原密码）', dialogBody().find('#sfPassword').val() === '');
    check('弹窗里没有「新增」相关入口（标题为编辑）', !/新增/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    // 提示语：只有密码那一行保留 .form-tip，其它录入框后面都不再有提示语
    check('表单里只剩密码后面 1 条提示语', dialogBody().find('.form-tip').length === 1 &&
        dialogBody().find('#sfPasswordTip').length === 1,
        String(dialogBody().find('.form-tip').length));
    check('邮箱 / 启用状态 / 发件人名称后面不再有提示语',
        dialogBody().find('#sfEmailTip').length === 0 &&
        !/邮箱可用|已存在|自动停用其它/.test(dialogBody().text()),
        dialogBody().text().replace(/\s+/g, ' ').slice(0, 80));
    // 服务器设置：直接铺在表单里，没有勾选框 / 折叠容器
    check('服务器设置直接可见（无「手工指定服务器」勾选、无折叠容器）',
        dialogBody().find('#sfAdvanced').length === 0 && dialogBody().find('#sfAdv').length === 0 &&
        dialogBody().find('#sfImapHost').length === 1 && dialogBody().find('#sfSmtpHost').length === 1 &&
        dialogBody().find('#sfSsl').length === 1);
    check('服务器两个输入框与端口并排显示（se-adv-row 容器）',
        dialogBody().find('#sfImapHost').closest('.se-adv-row').length === 1 &&
        dialogBody().find('#sfImapPort').closest('.se-adv-row').length === 1);
    // label 不换行：CSS 里给 .se-form 的 label 定宽 112px + nowrap（「密码 / 授权码」最长）
    var cssText = read('css/app.css');
    check('CSS 锁定 label 宽度 112px 且 nowrap（「密码 / 授权码」永不换行）',
        /\.se-form \.el-form-item__label[\s\S]{0,200}width: 112px/.test(cssText) &&
        /\.se-form \.el-form-item__label[\s\S]{0,240}white-space: nowrap/.test(cssText),
        'width/nowrap 规则缺失');
    check('编辑时服务器留空（等待按域名推断）',
        dialogBody().find('#sfImapHost').val() === '' && dialogBody().find('#sfSmtpHost').val() === '',
        dialogBody().find('#sfImapHost').val() + ' / ' + dialogBody().find('#sfSmtpHost').val());
    dialogBody().find('#sfDisplay').val('九豆服务信箱（改）');
    // 顺手验证「页面上直接填写服务器」会被保存
    dialogBody().find('#sfImapHost').val('imap.custom.cn');
    dialogBody().find('#sfImapPort').val('143');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('保存后发件人名称更新', /九豆服务信箱（改）/.test($('#seTbody').text()), $('#seTbody').text().slice(0, 80));
    check('页面上填写的服务器已保存并生效（imap.custom.cn:143）',
        /imap\.custom\.cn:143/.test(rowOf('service@jiudou.com').text()),
        rowOf('service@jiudou.com').text().replace(/\s+/g, ' ').slice(0, 120));
    check('编辑后仍然是 1 条记录（没有变成两条）', rowCount() === 1 && state().length === 1,
        rowCount() + ' / ' + state().length);
    var target = null;
    var list = state();
    for (var i = 0; i < list.length; i++) { if (list[i].email === 'service@jiudou.com') { target = list[i]; } }
    check('密码留空时原密码保持不变（仍可发信）', !!target && target.password === 'demo-123456',
        target ? String(target.password) : 'null');
});

step(function () {
    console.log('\n--- 4. 端口校验（弹窗内拦掉，不发请求）---');
    rows().first().trigger('click');
    $('#btnEdit').trigger('click');
});

step(function () {
    dialogBody().find('#sfImapPort').val('99999');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('端口越界在弹窗里就被拦下（提示 1-65535）', /1-65535/.test(toast()), toast().slice(0, 60));
    check('弹窗没有关闭（还在编辑里）', dialogs().length >= 1 && dialog().length === 1, String(dialogs().length));
    dialog().find('.btn-cancel').trigger('click');
});

step(function () {
    console.log('\n--- 5. 测试连接 ---');
    rows().first().trigger('click');
    $('#btnTest').trigger('click');
});

step(function () {
    check('测试连接弹出结果框', /连接测试通过/.test(msgBox().text()), msgBox().text().slice(0, 60));
    check('结果里分别给出 IMAP 与 SMTP 的结论',
        /IMAP/.test(msgBox().text()) && /SMTP/.test(msgBox().text()), msgBox().text().slice(0, 120));
    msgBox().find('.btn-ok').trigger('click');
});

step(function () {
    console.log('\n--- 6. 停用 / 启用（单条记录的启用状态位）---');
    rows().first().trigger('click');
    $('#btnDisable').trigger('click');
});

step(function () {
    check('停用后行内显示「停用」', /停用/.test(rows().first().text()) && enabledRows().length === 0,
        rows().first().text().replace(/\s+/g, ' ').slice(0, 60));
    check('停用后工具栏提示「未启用任何服务信箱」', /未启用任何服务信箱/.test($('#enabledTip').text()),
        $('#enabledTip').text());
    check('停用不会删掉记录（列表仍有 1 条）', rowCount() === 1, String(rowCount()));
    $('#btnEnable').trigger('click');
});

step(function () {
    check('启用前弹出确认框', /启用服务信箱/.test(msgBox().text()), msgBox().text().slice(0, 80));
    msgBox().find('.btn-ok').trigger('click');
});

step(function () {
    check('重新启用后恢复唯一启用状态', enabledRows().length === 1 && /service@jiudou\.com/.test(enabledRows().text()),
        enabledRows().text().slice(0, 50));
    check('工具栏提示同步为 service@jiudou.com', /service@jiudou\.com/.test($('#enabledTip').text()),
        $('#enabledTip').text());
});

step(function () {
    console.log('\n--- 7. 关键字检索 ---');
    $('#keyword').val('jiudou');
    $('#btnSearch').trigger('click');
});

step(function () {
    check('关键字检索命中唯一那条', rowCount() === 1 && /service@jiudou\.com/.test($('#seTbody').text()),
        String(rowCount()));
    $('#keyword').val('support@163.com');
    $('#btnSearch').trigger('click');
});

step(function () {
    check('没有命中时空态文案为「没有符合条件的服务信箱」', /没有符合条件的服务信箱/.test($('#seTbody').text()),
        $('#seTbody').text().replace(/\s+/g, ' ').slice(0, 60));
    $('#btnReset').trigger('click');
});

step(function () {
    check('重置检索后恢复 1 条', rowCount() === 1, String(rowCount()));
    check('列表 DOM 里不出现明文密码', $('#seTbody').text().indexOf('demo-123456') < 0);
});

step(function () {
    console.log('\n--- 8. 接口层：密码只进不出 ---');
    win.Api.serviceEmail.page({ pageNum: 1, pageSize: 10 }).done(function (d) {
        var list = (d && d.list) || [];
        var noPwd = true, mask = '', hasPwd = false;
        for (var i = 0; i < list.length; i++) {
            if (list[i].password !== undefined) { noPwd = false; }
            if (list[i].passwordMask) { mask = list[i].passwordMask; }
            if (list[i].hasPassword === true) { hasPwd = true; }
        }
        check('接口返回不含 password 字段（密码只进不出）', noPwd === true, String(noPwd));
        check('接口只给 passwordMask（******）与 hasPassword', mask === '******' && hasPwd === true,
            mask + ' / ' + hasPwd);
        check('列表接口只返回 1 条（单例表）', list.length === 1, String(list.length));
    });
});

step(function () {
    console.log('\n--- 9. 源码层：只有 1 份表单实现，新增/删除入口不在这页 ---');
    var html = read('service-email.html');
    var js = read('js/service-email.js');
    var formJs = read('js/service-email-form.js');
    check('页面 HTML 里没有 btnAdd / btnDelete 按钮',
        html.indexOf('id="btnAdd"') < 0 && html.indexOf('id="btnDelete"') < 0);
    check('页面脚本里没有绑定 btnAdd / btnDelete，也没有 removeRow',
        js.indexOf('#btnAdd') < 0 && js.indexOf('#btnDelete') < 0 && js.indexOf('function removeRow') < 0);
    check('空列表文案指向「邮箱助手 → 设置按钮」', /邮箱助手/.test(js) && /设置按钮/.test(js));
    check('表单模板已从 HTML 移到共享模块（HTML 里不再有 seFormTpl / sfEmail）',
        html.indexOf('seFormTpl') < 0 && html.indexOf('id="sfEmail"') < 0);
    check('页面按顺序引用共享表单模块与页面脚本',
        /js\/service-email-form\.js/.test(html) && /js\/service-email\.js/.test(html),
        '脚本引用缺失');
    check('共享模块同时提供 open 与 openSingleton（无记录=新增 / 有记录=编辑）',
        /function open\(/.test(formJs) && /function openSingleton\(/.test(formJs) &&
        /openSingleton: openSingleton/.test(formJs));
});

setTimeout(next, 900);   // 等首屏列表加载完（Mock 通道有 240ms 延迟）
