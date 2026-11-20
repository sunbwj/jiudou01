/* ==========================================================================
   mail-page-test.js —— 邮箱助手页面测试（jsdom，Mock 通道）
   覆盖：状态条（当前启用的服务信箱 / 未读 / 收发统计）/ 文件夹切换 /
        邮件列表与未读样式 / 打开邮件即标记已读 / 搜索 / 立即收件（新增邮件）/
        写邮件（必填校验 + 发送成功进入已发送）/ 从员工信息中选取收件人（检索 + 多选 + 追加到收件人）/
        回复 / 删除 / 未启用服务信箱时的引导 / 邮件区撑满剩余高度的布局标记
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/mail-page-test.js
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

/** 组装窗口：可选 pre 回调，在 api.js 之前写入 localStorage（用于模拟未启用服务信箱） */
function boot(page, scripts, pre) {
    var dom = new JSDOM(read(page), {
        url: 'http://127.0.0.1:8808/' + page,
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    if (pre) { pre(win); }
    win.jQuery.ajax = function () {
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/rich-text.js'));
    win.eval(read('js/layout.js'));
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

var win = boot('mail.html', ['js/service-email-form.js', 'js/mail.js']);
var $ = win.jQuery;

function items() { return $('#mailList .mail-item'); }
function dialogs() { return $('.el-overlay .el-dialog'); }
function dialog() { return dialogs().last(); }
function dialogBody() { return dialog().find('.el-dialog__body'); }
function msgBox() { return $('.el-message-box').last(); }
function toast() { return $('.el-message-list').text(); }
function folder(name) { return $('.mail-folder[data-folder="' + name + '"]'); }

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 700 }); }

/** 模拟「选文件」：给 file 输入框塞进 File 对象并触发 change（jsdom 里 files 只能这样写） */
function pickFiles($f, list) {
    var input = $f.find('#mfFile')[0];
    var files = [];
    for (var i = 0; i < list.length; i++) {
        files.push(new win.File([list[i][1]], list[i][0], { type: list[i][2] || 'text/plain' }));
    }
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    $(input).trigger('change');
    return files;
}
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
    console.log('\n--- 1. 首屏：状态条 + 收件箱 ---');
    check('页面标题为「邮箱助手」', /邮箱助手/.test($('.page-head__title').text()), $('.page-head__title').text());
    check('面包屑为「邮件中心/邮箱助手」', $('#pageHead').attr('data-crumb') === '邮件中心/邮箱助手',
        $('#pageHead').attr('data-crumb'));
    check('状态条显示当前启用的服务信箱', /service@jiudou\.com/.test($('#mailEmail').text()),
        $('#mailEmail').text());
    check('状态条显示服务商与 IMAP 服务器',
        /IMAP/.test($('#mailMeta').text()) && /imap\.jiudou\.com/.test($('#mailMeta').text()),
        $('#mailMeta').text());
    check('左侧有「收件箱 / 已发送」两个文件夹',
        $('.mail-folder').length === 2 && folder('inbox').length === 1 && folder('sent').length === 1);
    check('收件箱默认选中', folder('inbox').hasClass('is-active'));
    check('收件箱徽标为 2 封', $.trim($('#badgeInbox').text()) === '2', $('#badgeInbox').text());
    check('已发送徽标为 1 封', $.trim($('#badgeSent').text()) === '1', $('#badgeSent').text());
    check('列表渲染 2 封收件', items().length === 2, String(items().length));
    check('未读邮件带未读样式与红点',
        items().filter('.is-unread').length === 1 && items().filter('.is-unread').find('.mail-dot').length === 1,
        String(items().filter('.is-unread').length));
    check('列表显示发件人名与主题',
        /张客户/.test($('#mailList').text()) && /关于产品报价的咨询/.test($('#mailList').text()),
        $('#mailList').text().replace(/\s+/g, ' ').slice(0, 80));
    check('默认提示「从左侧选择一封邮件查看详情」', /选择一封邮件/.test($('#mailRead').text()));
    check('页面主区带 mail-page 标记（邮件区撑满剩余高度）', $('.app-main').hasClass('mail-page'),
        $('.app-main').attr('class'));
    var css = read('css/app.css');
    check('CSS 让邮件卡片吃掉剩余高度（.mail-page .mail-card → flex:1）',
        /\.mail-page \.mail-card[\s\S]{0,300}flex: 1 1 auto/.test(css));
    check('CSS 取消邮件区固定的 calc(100vh - 320px) 高度',
        /\.mail-page \.mail-body[\s\S]{0,220}height: auto/.test(css));
});

step(function () {
    console.log('\n--- 2. 查看邮件（打开即标记已读）---');
    items().filter('.is-unread').trigger('click');
});

step(function () {
    check('右侧阅读区显示主题', /关于产品报价的咨询/.test($('#mailRead').text()),
        $('#mailRead').text().replace(/\s+/g, ' ').slice(0, 80));
    check('阅读区显示发件人 / 收件人 / 时间', /张客户/.test($('#mailRead').text()) &&
        /service@jiudou\.com/.test($('#mailRead').text()) && /2026-11-01 09:20/.test($('#mailRead').text()),
        $('#mailRead').text().slice(0, 120));
    check('阅读区显示正文内容', /50 人规模团队的报价/.test($('#mailRead').text()));
    check('打开后该邮件变为已读（红点消失）', items().filter('.is-unread').length === 0,
        String(items().filter('.is-unread').length));
    check('阅读区有「回复 / 标记未读 / 删除」按钮',
        $('#btnReply').length === 1 && $('#btnToggleSeen').length === 1 && $('#btnMailDelete').length === 1);
});

step(function () {
    console.log('\n--- 3. 切换「已发送」---');
    folder('sent').trigger('click');
});

step(function () {
    check('已发送文件夹高亮', folder('sent').hasClass('is-active'));
    check('已发送列表 1 封', items().length === 1, String(items().length));
    check('已发送显示「发给：…」而不是发件人', /发给：customer@example\.com/.test($('#mailList').text()),
        $('#mailList').text().replace(/\s+/g, ' ').slice(0, 80));
    folder('inbox').trigger('click');
});

step(function () {
    console.log('\n--- 4. 立即收件（新增 1 封演示邮件）---');
    check('切回收件箱', folder('inbox').hasClass('is-active'));
    $('#btnSync').trigger('click');
});

step(function () {
    check('收件成功提示（取回 / 新增）', /收件完成/.test(toast()) && /新增 1 封/.test(toast()), toast());
    check('收件后列表变为 3 封', items().length === 3, String(items().length));
    check('新邮件带未读标记（演示邮件）', items().filter('.is-unread').length === 1,
        String(items().filter('.is-unread').length));
    check('收件箱徽标更新为 3', $.trim($('#badgeInbox').text()) === '3', $('#badgeInbox').text());
});

step(function () {
    console.log('\n--- 5. 搜索邮件 ---');
    $('#mailKeyword').val('联调');
    $('#mailKeyword').trigger($.Event('keydown', { keyCode: 13 }));
});

step(function () {
    check('按关键字过滤后只剩 1 封', items().length === 1, String(items().length));
    check('命中「接口对接联调时间确认」', /联调/.test($('#mailList').text()), $('#mailList').text().slice(0, 60));
    $('#mailKeyword').val('');
    $('#mailKeyword').trigger($.Event('keydown', { keyCode: 13 }));
});

step(function () {
    check('清空关键字后恢复 3 封', items().length === 3, String(items().length));
    console.log('\n--- 6. 写邮件：从员工信息中选取收件人 ---');
    $('#btnWrite').trigger('click');
});

step(function () {
    check('收件人右侧有「从员工选取」按钮',
        dialogBody().find('#mfPickEmp').length === 1 && /从员工选取/.test(dialogBody().find('#mfPickEmp').text()),
        dialogBody().find('#mfPickEmp').text());
    dialogBody().find('#mfPickEmp').trigger('click');
});

step(function () {
    check('弹出「从员工信息中选取收件人」弹窗',
        dialogs().length === 2 && /从员工信息中选取收件人/.test(dialog().text()),
        dialog().find('.el-dialog__title').text());
    check('员工列表来自员工信息表（Mock 种子 6 人）',
        dialogBody().find('.emp-pick__row').length === 6,
        String(dialogBody().find('.emp-pick__row').length));
    check('列表展示姓名 / 工号 / 部门 / 邮箱',
        /张守正/.test(dialogBody().text()) && /E00001/.test(dialogBody().text()) &&
        /zhangshouzheng@jiudou\.com/.test(dialogBody().text()) &&
        /技术研发部/.test(dialogBody().text()),
        dialogBody().text().replace(/\s+/g, ' ').slice(0, 100));
    check('列表带在职状态标签', /在职|试用|离职/.test(dialogBody().text()));
});

step(function () {
    dialogBody().find('#pfKeyword').val('张');
    dialogBody().find('#pfSearch').trigger('click');
});

step(function () {
    check('弹窗内支持按关键字检索员工', dialogBody().find('.emp-pick__row').length === 1,
        String(dialogBody().find('.emp-pick__row').length));
    dialogBody().find('#pfKeyword').val('');
    dialogBody().find('#pfSearch').trigger('click');
});

step(function () {
    var $rows = dialogBody().find('.emp-pick__row');
    check('清空关键字后恢复 6 人', $rows.length === 6, String($rows.length));
    $rows.eq(0).find('.pf-check').prop('checked', true).trigger('change');
    $rows.eq(1).find('.pf-check').prop('checked', true).trigger('change');
    check('勾选后计数显示已选 2 人', $.trim(dialogBody().find('#pfPicked').text()) === '2',
        dialogBody().find('#pfPicked').text());
    check('勾选的行高亮', $rows.eq(0).hasClass('is-checked') && $rows.eq(1).hasClass('is-checked'));
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('确定后关闭选取弹窗，回到写邮件弹窗', dialogs().length === 1, String(dialogs().length));
    var to = String(dialogBody().find('#mfTo').val() || '');
    check('所选员工邮箱已追加到收件人',
        to.indexOf('zhangshouzheng@jiudou.com') > -1 && to.indexOf('liyunchuang@jiudou.com') > -1, to);
    check('多个邮箱用逗号分隔', /, /.test(to), to);
    dialog().find('.btn-cancel').trigger('click');
});

step(function () {
    console.log('\n--- 6b. 写邮件：抄送也能从员工信息中选取 ---');
    $('#btnWrite').trigger('click');
});

step(function () {
    check('抄送右侧也有「从员工选取」按钮',
        dialogBody().find('#mfPickEmpCc').length === 1 &&
        /从员工选取/.test(dialogBody().find('#mfPickEmpCc').text()),
        dialogBody().find('#mfPickEmpCc').text());
    check('抄送输入框与按钮在同一行（复用 .mail-to 布局）',
        dialogBody().find('#mfCc').closest('.mail-to').length === 1);
    dialogBody().find('#mfPickEmpCc').trigger('click');
});

step(function () {
    check('弹出「从员工信息中选取抄送」弹窗（标题随字段变化）',
        dialogs().length === 2 && /从员工信息中选取抄送/.test(dialog().text()),
        dialog().find('.el-dialog__title').text());
    check('底部提示写明追加到抄送',
        /追加到抄送/.test(dialogBody().find('.emp-pick__picked').text()),
        dialogBody().find('.emp-pick__picked').text());
    var $rows = dialogBody().find('.emp-pick__row');
    $rows.eq(0).find('.pf-check').prop('checked', true).trigger('change');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    var cc = String(dialogBody().find('#mfCc').val() || '');
    var to = String(dialogBody().find('#mfTo').val() || '');
    check('所选员工邮箱写入抄送（不是收件人）',
        cc.indexOf('zhangshouzheng@jiudou.com') > -1, 'cc=' + cc + ' / to=' + to);
    check('收件人未被抄送选人影响', to === '', 'to=' + to);
});

step(function () {
    // 再选同一个人：应提示「已在抄送中」且不重复
    dialogBody().find('#mfPickEmpCc').trigger('click');
});

step(function () {
    var $row = dialogBody().find('.emp-pick__row').eq(0);
    $row.find('.pf-check').prop('checked', true).trigger('change');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    var cc = String(dialogBody().find('#mfCc').val() || '');
    check('重复选取不会在抄送里出现两次',
        cc.split('zhangshouzheng@jiudou.com').length - 1 === 1, cc);
});

step(function () {
    // 已经在收件人里的人：选进抄送时应被跳过
    dialogBody().find('#mfTo').val('zhangshouzheng@jiudou.com');
    dialogBody().find('#mfPickEmpCc').trigger('click');
});

step(function () {
    var $rows = dialogBody().find('.emp-pick__row');
    $rows.eq(0).find('.pf-check').prop('checked', true).trigger('change');
    $rows.eq(1).find('.pf-check').prop('checked', true).trigger('change');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    var cc = String(dialogBody().find('#mfCc').val() || '');
    check('与收件人重复的地址被跳过（不再加进抄送）',
        cc.split('zhangshouzheng@jiudou.com').length - 1 === 1, cc);
    check('新的地址仍然加进抄送', cc.indexOf('liyunchuang@jiudou.com') > -1, cc);
    dialog().find('.btn-cancel').trigger('click');
});

step(function () {
    console.log('\n--- 7. 写邮件（必填校验 + 发送）---');
    $('#btnWrite').trigger('click');
});

step(function () {
    check('弹出写邮件弹窗', dialog().length === 1 && /写邮件/.test(dialog().text()),
        dialog().find('.el-dialog__title').text());
    var $f = dialogBody().find('.mail-form');
    check('表单含收件人 / 抄送 / 主题 / 正文',
        $f.find('#mfTo').length === 1 && $f.find('#mfCc').length === 1 &&
        $f.find('#mfSubject').length === 1 && $f.find('#mfBody').length === 1);
    check('弹窗确认按钮文案为「发送」', dialog().find('.btn-ok').text() === '发送',
        dialog().find('.btn-ok').text());
    check('表单提示发件人为当前启用的服务信箱', /service@jiudou\.com/.test($f.find('#mfFromTip').text()),
        $f.find('#mfFromTip').text());
    check('表单里有「添加附件」按钮与 file 输入框',
        $f.find('#mfPickFile').length === 1 && $f.find('#mfFile').length === 1,
        $f.find('#mfFile').length + ' 个 file 输入框');
    check('file 输入框由 CSS 隐藏（点按钮触发）',
        /\bmail-attach__file\b/.test(String($f.find('#mfFile').attr('class'))),
        $f.find('#mfFile').attr('class'));
    check('附件提示写明单个 10 MB / 最多 5 个',
        /10 MB/.test($f.find('#mfAttachTip').text()) && /5 个/.test($f.find('#mfAttachTip').text()),
        $f.find('#mfAttachTip').text());
    check('默认没有已选附件', $f.find('#mfAttachList .mail-attach__item').length === 0,
        String($f.find('#mfAttachList .mail-attach__item').length));
    var css = read('css/app.css');
    check('CSS 隐藏原生 file 输入框', /\.mail-attach__file\s*\{[^}]*display:\s*none/.test(css));
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('未填收件人时提示「请填写收件人」', /请填写收件人/.test(toast()), toast());
    var $f = dialogBody().find('.mail-form');
    $f.find('#mfTo').val('client@example.com');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('未填主题时提示「请填写邮件主题」', /请填写邮件主题/.test(toast()), toast());
    var $f = dialogBody().find('.mail-form');
    $f.find('#mfSubject').val('月度服务报告');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('未填正文时提示「请填写邮件正文」', /请填写邮件正文/.test(toast()), toast());
    var $f = dialogBody().find('.mail-form');
    $f.find('#mfBody').val('本月共处理 12 个工单，全部闭环。');
    // 正文填好后先测附件：选一个文件 → FileReader 读成 base64
    pickFiles($f, [['服务清单.txt', 'hello', 'text/plain']]);
});

step(function () {
    console.log('\n--- 7.1 写邮件附件：选择 / 去重 / 移除 ---');
    var $f = dialogBody().find('.mail-form');
    var $items = $f.find('#mfAttachList .mail-attach__item');
    check('选择文件后出现在附件清单（1 个）', $items.length === 1, String($items.length));
    check('附件清单显示文件名', /服务清单\.txt/.test($items.text()), $items.text().replace(/\s+/g, ' '));
    check('附件清单显示文件大小（5 B）', /5 B/.test($items.find('.mail-attach__size').text()),
        $items.find('.mail-attach__size').text());
    check('提示条改为「已选 1 个（合计 5 B）」',
        /已选 1 个/.test($f.find('#mfAttachTip').text()) && /5 B/.test($f.find('#mfAttachTip').text()),
        $f.find('#mfAttachTip').text());
    pickFiles($f, [['服务清单.txt', 'again', 'text/plain']]);       // 同名文件不应重复添加
});

step(function () {
    var $f = dialogBody().find('.mail-form');
    check('同名附件不会重复添加', $f.find('#mfAttachList .mail-attach__item').length === 1,
        String($f.find('#mfAttachList .mail-attach__item').length));
    check('同名附件给出提示', /已经添加过同名附件/.test(toast()), toast());
    $f.find('#mfAttachList .mail-attach__del').trigger('click');
});

step(function () {
    var $f = dialogBody().find('.mail-form');
    check('点 × 可移除附件（清单清空）', $f.find('#mfAttachList .mail-attach__item').length === 0,
        String($f.find('#mfAttachList .mail-attach__item').length));
    check('移除后提示条恢复默认文案', /10 MB/.test($f.find('#mfAttachTip').text()),
        $f.find('#mfAttachTip').text());
    pickFiles($f, [['服务清单.txt', 'hello', 'text/plain']]);       // 再选一次，随本次发送一起提交
});

step(function () {
    var $f = dialogBody().find('.mail-form');
    check('准备发送时附件仍在清单里', $f.find('#mfAttachList .mail-attach__item').length === 1,
        String($f.find('#mfAttachList .mail-attach__item').length));
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('发送成功提示且说明带了几封附件', /邮件已发送（含 1 个附件）/.test(toast()), toast());
    check('弹窗已关闭', dialogs().length === 0, String(dialogs().length));
    check('发送后自动切到「已发送」', folder('sent').hasClass('is-active'));
    check('已发送列表新增 1 封（共 2 封）', items().length === 2, String(items().length));
    check('新发出的邮件在列表中（主题月度服务报告）', /月度服务报告/.test($('#mailList').text()),
        $('#mailList').text().replace(/\s+/g, ' ').slice(0, 80));
    check('已发送徽标更新为 2', $.trim($('#badgeSent').text()) === '2', $('#badgeSent').text());
    check('列表里带附件的邮件有 📎 标记',
        items().first().find('.mail-clip').length === 1, String(items().first().find('.mail-clip').length));
});

step(function () {
    console.log('\n--- 7.2 已发送邮件里能看到附件清单 ---');
    items().first().trigger('click');
});

step(function () {
    var text = $('#mailRead').text().replace(/\s+/g, ' ');
    check('阅读区显示附件下载列表', /附件（1 个/.test(text), text.slice(0, 120));
    check('阅读区列出附件名与大小', /服务清单\.txt/.test(text) && /5 B/.test(text), text.slice(0, 160));
    var $btn = $('#mailRead .mail-attach__dl');
    check('每条附件都有「下载」按钮', $btn.length === 1, String($btn.length));
    check('下载按钮带附件 id', !!$btn.attr('data-file-id'), String($btn.attr('data-file-id')));
    check('阅读区不再提示「附件内容没有下载」', text.indexOf('附件内容没有下载') < 0);
});

/* ---- 7.3 附件下载：Mock 二进制路由 + 点击按钮触发 ---- */
var origDownload = null, dlResult = null, dlCalled = null;
step(function () {
    origDownload = win.Api.mail.downloadAttachment;
    var id = $('#mailRead .mail-attach__dl').attr('data-file-id');
    origDownload(id).done(function (res) { dlResult = res; });
});
step(function () {
    check('Mock 下载接口返回可保存的 dataUrl 与原文件名',
        !!dlResult && /^data:/.test(dlResult.dataUrl || '') && dlResult.name === '服务清单.txt',
        JSON.stringify(dlResult));
    win.Api.mail.downloadAttachment = function (id) {
        dlCalled = id;
        var d = $.Deferred();
        d.resolve({ dataUrl: 'data:text/plain;base64,SGVsbG8=', filename: '服务清单.txt' });
        return d.promise();
    };
    var $btn = $('#mailRead .mail-attach__dl');
    $btn.first().trigger('click');
    check('点「下载」按附件 id 调用下载接口',
        dlCalled === $btn.attr('data-file-id'), String(dlCalled));
});
var attachRes = null;
step(function () {
    win.Api.mail.downloadAttachment = origDownload;
    check('下载完成后按钮恢复可点',
        !$('#mailRead .mail-attach__dl').prop('disabled'));
    var m = $('#mailRead').data('mail');
    win.Api.mail.attachments(m.id).done(function (res) { attachRes = res; });
});

step(function () {
    check('附件清单接口返回同一份清单',
        !!attachRes && !!attachRes.list && attachRes.list.length === 1 &&
        attachRes.list[0].downloadable === true, JSON.stringify(attachRes && attachRes.list));
    check('发件邮件不需要补拉附件', !!attachRes && attachRes.needFetch === false);
    console.log('\n--- 7. 回复 + 删除 ---');
    items().first().trigger('click');
});

step(function () {
    check('已发送邮件在阅读区可查看', /月度服务报告/.test($('#mailRead').text()),
        $('#mailRead').text().slice(0, 60));
    $('#btnMailDelete').trigger('click');
});

step(function () {
    check('删除前弹出确认框', /删除邮件/.test(msgBox().text()), msgBox().text().slice(0, 50));
    check('确认文案说明不影响邮箱服务器', /不会删除邮箱服务器上的邮件/.test(msgBox().text()),
        msgBox().text().slice(0, 100));
    msgBox().find('.btn-ok').trigger('click');
});

step(function () {
    check('删除后已发送剩 1 封', items().length === 1, String(items().length));
    check('已发送徽标回到 1', $.trim($('#badgeSent').text()) === '1', $('#badgeSent').text());
});

step(function () {
    console.log('\n--- 8. 设置图标按钮：已有记录 → 编辑服务信箱 ---');
    check('「刷新」后面紧跟设置图标按钮（DOM 顺序）',
        $('#btnMailRefresh').nextAll('#btnMailSetting').length === 1 &&
        $('#btnMailSetting').prevAll('#btnMailRefresh').length === 1,
        $('#btnMailSetting').prev().attr('id'));
    check('设置按钮是纯图标按钮（el-button--icon，无文字）',
        $('#btnMailSetting').hasClass('el-button') && $('#btnMailSetting').hasClass('el-button--icon') &&
        $.trim($('#btnMailSetting').text()) === '' && $('#btnMailSetting').find('svg').length === 1,
        $('#btnMailSetting').text());
    check('设置按钮带 title / aria-label（图标按钮的可读性）',
        /服务信箱设置/.test($('#btnMailSetting').attr('title') || '') &&
        /服务信箱设置/.test($('#btnMailSetting').attr('aria-label') || ''),
        $('#btnMailSetting').attr('title'));
    var css2 = read('css/app.css');
    check('CSS 给纯图标按钮定宽高 40px 并居中（与同排文字按钮等高）',
        /\.el-button--icon\s*\{[\s\S]{0,140}width: 40px; height: 40px/.test(css2) &&
        /\.el-button--icon\s*\{[\s\S]{0,300}justify-content: center/.test(css2),
        '图标按钮样式缺失');
    $('#btnMailSetting').trigger('click');
});

step(function () {
    check('点击后弹出「编辑服务信箱」弹窗（表里已有记录 = 编辑）',
        dialogs().length === 1 && /编辑服务信箱/.test(dialog().find('.el-dialog__title').text()),
        dialog().find('.el-dialog__title').text());
    check('弹窗回填了当前那条服务信箱（service@jiudou.com）',
        dialogBody().find('#sfEmail').val() === 'service@jiudou.com',
        dialogBody().find('#sfEmail').val());
    check('编辑分支密码框为空 + 提示留空不修改',
        dialogBody().find('#sfPassword').val() === '' &&
        /留空/.test(dialogBody().find('#sfPasswordTip').text()),
        dialogBody().find('#sfPasswordTip').text());
    check('确定按钮文案为「保存」', /保存/.test(dialog().find('.btn-ok').text()),
        dialog().find('.btn-ok').text());
    check('弹窗宽度 560（与服务信箱设置页一致）', String(dialog()[0].style.width).indexOf('560') === 0,
        String(dialog()[0].style.width));
    dialogBody().find('#sfDisplay').val('九豆服务信箱（改）');
    dialog().find('.btn-ok').trigger('click');
});

step(function () {
    check('保存成功提示', /保存成功/.test(toast()), toast().slice(0, 40));
    check('弹窗已关闭', dialogs().length === 0, String(dialogs().length));
    check('状态条刷新出发件人名称', /九豆服务信箱（改）/.test($('#mailMeta').text()), $('#mailMeta').text());
    var store = JSON.parse(win.localStorage.getItem('menu_admin_serviceemail_v1') || '[]');
    check('mock 里依旧只有 1 条记录（编辑不会变成第二条）', store.length === 1, String(store.length));
    check('编辑保存的就是那唯一一条（displayName 已更新）',
        store.length === 1 && store[0].displayName === '九豆服务信箱（改）',
        store.length ? String(store[0].displayName) : 'null');
});

step(function () {
    console.log('\n--- 9. 未启用服务信箱时的引导 ---');
    var w2 = boot('mail.html', ['js/mail.js'], function (w) {
        w.localStorage.setItem('menu_admin_serviceemail_v1', JSON.stringify([{
            id: 'se-0000-4000-8000-000000000001', email: 'service@jiudou.com', password: 'demo-123456',
            displayName: '九豆服务信箱', smtpHost: '', smtpPort: '', imapHost: '', imapPort: '',
            useSsl: true, enabled: false, lastSyncTime: '', lastError: '', remark: '',
            createTime: '2026-11-01 09:00:00', updateTime: '2026-11-01 09:00:00'
        }]));
    });
    setTimeout(function () {
        try {
            var $2 = w2.jQuery;
            check('未启用时状态条提示未启用', /未启用服务信箱/.test($2('#mailEmail').text()),
                $2('#mailEmail').text());
            check('未启用时提示点右上角「设置」按钮启用', /设置/.test($2('#mailMeta').text()),
                $2('#mailMeta').text());
            check('未启用时列表给出引导文案', /尚未配置服务信箱/.test($2('#mailList').text()),
                $2('#mailList').text().slice(0, 50));
            check('未启用时「收件 / 写邮件」按钮禁用',
                $2('#btnSync').prop('disabled') === true && $2('#btnWrite').prop('disabled') === true);
        } catch (e) {
            check('未启用场景断言异常：' + e.message, false, e.stack);
        }
    }, 900);
});

step(function () {
    console.log('\n--- 10. 表里没有记录时点设置 = 新增（单例表首条）---');
    var w3 = boot('mail.html', ['js/service-email-form.js', 'js/mail.js'], function (w) {
        w.localStorage.setItem('menu_admin_serviceemail_v1', JSON.stringify([]));
    });
    setTimeout(function () {
        var $3 = w3.jQuery;
        try {
            check('未配置时状态条提示点「设置」按钮', /设置/.test($3('#mailMeta').text()),
                $3('#mailMeta').text());
            $3('#btnMailSetting').trigger('click');
        } catch (e) {
            check('新增场景触发异常：' + e.message, false, e.stack);
        }
        setTimeout(function () {
            var $dlg = $3('.el-overlay .el-dialog').last();
            try {
                check('弹窗标题为「新增服务信箱」（表里没有记录 = 新增）',
                    /新增服务信箱/.test($dlg.find('.el-dialog__title').text()),
                    $dlg.find('.el-dialog__title').text());
                check('新增分支：邮箱与密码都为空、启用状态默认「启用」',
                    $dlg.find('#sfEmail').val() === '' && $dlg.find('#sfPassword').val() === '' &&
                    $dlg.find('#sfEnabled').val() === '1',
                    $dlg.find('#sfEnabled').val());
                $dlg.find('.btn-ok').trigger('click');           // 什么都不填直接保存
            } catch (e) {
                check('新增场景断言异常：' + e.message, false, e.stack);
            }
            setTimeout(function () {
                try {
                    check('新增时邮箱为空被拦下（提示请填写邮箱地址）',
                        /请填写邮箱地址/.test($3('.el-message-list').text()), $3('.el-message-list').text());
                    $dlg.find('#sfEmail').val('newbox@jiudou.com');
                    $dlg.find('#sfPassword').val('pwd-new');
                    $dlg.find('.btn-ok').trigger('click');
                } catch (e) {
                    check('新增场景保存异常：' + e.message, false, e.stack);
                }
                setTimeout(function () {
                    try {
                        check('新增成功提示', /新增成功/.test($3('.el-message-list').text()),
                            $3('.el-message-list').text());
                        check('弹窗关闭', $3('.el-overlay .el-dialog').length === 0,
                            String($3('.el-overlay .el-dialog').length));
                        check('状态条切到新配置的服务信箱',
                            /newbox@jiudou\.com/.test($3('#mailEmail').text()), $3('#mailEmail').text());
                        check('「收件 / 写邮件」按钮恢复可用',
                            $3('#btnSync').prop('disabled') === false && $3('#btnWrite').prop('disabled') === false);
                        var store = JSON.parse(w3.localStorage.getItem('menu_admin_serviceemail_v1') || '[]');
                        check('新增后 mock 里也只有 1 条记录', store.length === 1, String(store.length));
                        check('收件箱已自动加载列表（不再停在未配置引导）',
                            !/尚未配置服务信箱/.test($3('#mailList').text()), $3('#mailList').text().slice(0, 40));
                    } catch (e) {
                        check('新增场景断言异常：' + e.message, false, e.stack);
                    }
                }, 800);
            }, 500);
        }, 700);
    }, 900);
}, 3400);

setTimeout(next, 900);