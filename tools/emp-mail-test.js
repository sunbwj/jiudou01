/* ==========================================================================
   emp-mail-test.js —— 「我的邮箱」（员工个人邮箱助手）测试（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖：
     · 静态：页面结构 / 脚本版本 / Api.empMail 与 Mock 前缀 / 后端 EmpMailService
             只认 token 反查 empId / 自动收件 worker / 建表唯一约束 / 菜单与按钮登记
     · 首屏：本人信箱状态条（仅本人可见 / 自动收件 / 已启用）、打开页面立即自动收一次
     · 隔离：前端传 empId 无效、别人邮件 detail 404、mark/remove 别人邮件 0 行、
             另一个员工窗口只看到自己的邮件（含机密邮件），看不到别人的
     · 功能：读信（打开即已读）/ 标记未读 / 写邮件必填校验与发送 / 删除
     · 设置：编辑态回填与脱敏、关闭自动收件后不再自动追加邮件
     · 新配置：未配置时的引导与禁用、弹窗逐项校验、保存后立即自动收件
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/emp-mail-test.js
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
/** 全站共享的 api.js 版本：从 main.html 现取，升版时不用逐个测试改硬编码 */
var SHARED_API_V = (read('main.html').match(/js\/api\.js\?v=([0-9a-z]+)/) || [])[1] || '';

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

/* ------------------------------- 0. 静态一致性 ------------------------------- */
var html = read('emp-mail.html');
var apiSrc = read('js/api.js');
var formSrc = read('js/emp-mail-form.js');
var pageSrc = read('js/emp-mail.js');
var svcSrc = read('server/service.py');
var appSrc = read('server/app.py');
var ddl = read('db/emp-mail.sql');
var menuSql = read('db/emp-mail-menu.sql');

console.log('\n--- 0. 静态一致性（页面 / Api / 后端 / 数据库 / 菜单） ---');
check('页面标题为「我的邮箱」', /我的邮箱/.test($htmlTitle(html)), $htmlTitle(html));
check('面包屑为「邮件中心/我的邮箱」', html.indexOf('data-crumb="邮件中心/我的邮箱"') > -1);
check('左侧菜单「我的邮箱」高亮，服务信箱 / 邮箱助手仍在',
    /class="app-side__item is-active" href="emp-mail\.html"/.test(html) &&
    html.indexOf('href="service-email.html"') > -1 && html.indexOf('href="mail.html"') > -1);
check('状态条有「仅本人可见」标签', /mail-status__tag[^>]*>仅本人可见</.test(html));
check('文件夹脚注说明自动收件 + 历史邮件仅本人可见',
    /每 5 分钟自动收取本人信箱/.test(html) && /历史邮件仅本人可见/.test(html));
check('页面引用 js/api.js?v=' + SHARED_API_V + '（改过 api.js 全站升版本）',
    SHARED_API_V !== '' && html.indexOf('js/api.js?v=' + SHARED_API_V) > -1);
check('页面引用 emp-mail-form.js / emp-mail.js',
    html.indexOf('js/emp-mail-form.js?v=20261106b') > -1 &&
    html.indexOf('js/emp-mail.js?v=20261110e') > -1);
check('设置按钮是纯图标按钮且 title / aria-label 为「我的邮箱设置」',
    /id="btnMailSetting"[\s\S]{0,120}title="我的邮箱设置"/.test(html) &&
    /aria-label="我的邮箱设置"/.test(html) && /el-button--icon/.test(html));
var legacyApiVersion = 'v=2026110' + '6l';   // 拼接避免全站升版本时被误替换
check('sso-test.js 的版本断言已同步到 ' + SHARED_API_V,
    read('tools/sso-test.js').indexOf('js/api.js?v=' + SHARED_API_V) > -1 &&
    read('tools/sso-test.js').indexOf(legacyApiVersion) < 0);

check('api.js 导出 Api.empMail 的 9 个方法',
    /var empMail = \{[\s\S]{0,1600}status:[\s\S]{0,1600}remove:/.test(apiSrc) &&
    /serviceEmail: serviceEmail, mail: mail, empMail: empMail,/.test(apiSrc));
check('Mock 服务前缀 /empmail 排在 /emp 之前（长前缀优先）',
    apiSrc.indexOf("{ prefix: '/empmail', svc: empMailSvc }") > -1 &&
    apiSrc.indexOf("{ prefix: '/empmail', svc: empMailSvc }") <
    apiSrc.indexOf("{ prefix: '/emp', svc: empSvc }"));
check('Mock 所有读写都按 empMailMe() 过滤，且离线自动收件会追加演示邮件',
    /function empMailMe\(\)[\s\S]{0,120}mockLoginEmpId\(\)/.test(apiSrc) &&
    /【演示】自动收件成功/.test(apiSrc) &&
    (function () {
        var seg = apiSrc.slice(apiSrc.indexOf('function createEmpMailService()'),
            apiSrc.indexOf('/* ---------------- 数据中心 · 数据库连接'));
        return (seg.match(/parseInt\(one\.empId, 10\) !== me/g) || []).length >= 1 &&
               (seg.match(/empId, 10\) !== me/g) || []).length >= 3;
    })());
check('emp-mail-form.js 表单没有 empId 字段，且明确「只有您自己能看到」',
    formSrc.indexOf("id=\"efAutoSync\"") > -1 && formSrc.indexOf('efEmpId') < 0 &&
    /只有您自己能看到/.test(formSrc) && /自动收件/.test(formSrc));
check('首次配置不带默认值：邮箱预填员工档案 suggestEmail、密码置空、防浏览器自动填充',
    formSrc.indexOf("configured ? (s.email || '') : (s.suggestEmail || '')") > -1 &&
    formSrc.indexOf("$f.find('#efPassword').val('')") > -1 &&
    formSrc.indexOf('autocomplete="new-password"') > -1 &&
    formSrc.indexOf('autocomplete="off"') > -1);
check('Mock 未配置 status 返回 suggestEmail（取 empSvc 员工档案邮箱）',
    /suggestEmail: empArchiveEmail\(empId\)/.test(apiSrc) &&
    /function empArchiveEmail\(empId\)/.test(apiSrc) &&
    /empSvc\.listRaw\(\)/.test(apiSrc.slice(apiSrc.indexOf('function empArchiveEmail'))));
check('emp-mail.js 有自动收件定时器与页面隐藏跳过（5 分钟对齐后端）',
    /AUTO_SYNC_MS = 5 \* 60 \* 1000/.test(pageSrc) &&
    /document\.hidden/.test(pageSrc) && /setInterval\(autoSyncNow, AUTO_SYNC_MS\)/.test(pageSrc));

check('后端 EmpMailService 只认 _loginUserId 反查 empId（不读前端 empId）',
    /def _my_emp_id\(self, params\)[\s\S]{0,700}get\('_loginUserId'\)/.test(svcSrc) &&
    /class EmpMailService\(MailService\)/.test(svcSrc));
check('后端列表 / 详情 / 标记 / 删除 SQL 都带 empId 条件',
    (svcSrc.match(/`empId`=%s/g) || []).length >= 4);
check('后端自动收件 worker 每轮调用 emp_mail_service.sync_all()',
    /emp_mail_service\.sync_all\(\)/.test(svcSrc) && /class MailSyncWorker/.test(svcSrc));
check('SERVICES 注册 empmail，ACTIONS 覆盖 status / save / sync / send / mark',
    /'empmail': emp_mail_service/.test(svcSrc) &&
    /'status': \('status', \['GET'\]\)/.test(svcSrc) &&
    /'sync': \('sync', \['POST'\]\)/.test(svcSrc) &&
    /'send': \('send', \['POST'\]\)/.test(svcSrc));
check('app.py 健康检查带员工信箱计数（老库缺表时兜底）',
    /empMailboxCount/.test(appSrc) && /empMailCount/.test(appSrc) &&
    /except Exception:\s+# 老库没跑/.test(appSrc));
check('建表脚本：一人一条配置 + 邮件按 (empId, direction, uid) 去重',
    /uk_empemailbox_emp/.test(ddl) && /uk_empmailmsg_uid/.test(ddl) &&
    /autoSync/.test(ddl) && /CREATE TABLE IF NOT EXISTS/.test(ddl));
check('菜单脚本：挂邮件中心 MNG1004 + 全员授权 + 4 个页面按钮登记',
    /MNG1004/.test(menuSql) && /'MNU00021'/.test(menuSql) &&
    /emp-mail\.html'/.test(menuSql) && /pageopbtn/.test(menuSql) &&
    /usergrouppagebtnset/.test(menuSql));

function $htmlTitle(src) {
    var m = /<title>([\s\S]*?)<\/title>/.exec(src);
    return m ? m[1] : '';
}

/* ------------------------------- 组装窗口 ------------------------------- */
/**
 * @param {Function} pre 在 api.js 之前写入 localStorage（模拟不同员工登录）
 * 说明：把 setInterval 换成记录器，既避免 jsdom 被定时器挂住，又能断言 5 分钟周期。
 */
function boot(pre) {
    var dom = new JSDOM(html, {
        url: 'http://127.0.0.1:8808/emp-mail.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.__autoTimers = [];
    win.setInterval = function (fn, ms) {
        win.__autoTimers.push(ms);
        return win.__autoTimers.length;
    };
    if (pre) { pre(win); }
    win.jQuery.ajax = function () {
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/rich-text.js'));
    win.eval(read('js/emp-mail-form.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/emp-mail.js'));
    return win;
}
function sso(empId) {
    return function (win) {
        win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
            token: 'mock-token-' + empId,
            user: { empId: empId, nameCn: '员工' + empId },
            expireAt: new Date().getTime() + 8 * 3600 * 1000
        }));
    };
}

var OTHER_MAIL_ID = 'emm-0000-4000-8000-000000000011';   // 员工 1 的机密邮件
var MY_MAIL_ID = 'emm-0000-4000-8000-000000000031';      // 员工 3 的邮件
var BOX_KEY = 'menu_admin_empemailbox_v1';
var MSG_KEY = 'menu_admin_empmailmsg_v1';

var w = boot(sso(3));                 // 甲：杨伟康（empId=3，已配置 + 自动收件开启）
var $ = w.jQuery;
var probes = {};
var w2, $2, w3, $3, w4, $4;
var mailCountBeforeSetting = 0;

function items($q) { return $q('#mailList .mail-item'); }
function toast($q) { return $q('.el-message-list').text(); }
function dialog($q) { return $q('.el-overlay .el-dialog').last(); }
function dialogBody($q) { return dialog($q).find('.el-dialog__body'); }
function msgBox($q) { return $q('.el-message-box').last(); }
function folder($q, name) { return $q('.mail-folder[data-folder="' + name + '"]'); }
function mails(win) { return JSON.parse(win.localStorage.getItem(MSG_KEY) || '[]'); }
function boxes(win) { return JSON.parse(win.localStorage.getItem(BOX_KEY) || '[]'); }

/* ---- 0.x 附件下载链路的静态一致性 ---- */
var attachSql = read('db/mail-attach.sql');
check('mailattach 建表脚本幂等、不动既有业务数据',
    /CREATE TABLE IF NOT EXISTS `mailattach`/.test(attachSql) &&
    attachSql.indexOf('DELETE FROM') < 0 && attachSql.indexOf('DROP TABLE') < 0, '');
check('后端有二进制下载路由，且 empmail 按 empId 强隔离',
    /\/api\/mailattach\/download/.test(appSrc) &&
    /def mail_attach_content/.test(svcSrc) && /source == 'empmail'/.test(svcSrc) &&
    /mail_attach_purge\(self\.attach_source, ids\)/.test(svcSrc));
check('两个邮箱的 Api 都暴露附件清单与下载方法',
    (apiSrc.match(/attachments: function \(id, refresh\)/g) || []).length === 2 &&
    (apiSrc.match(/downloadAttachment: function/g) || []).length === 2 &&
    /function downloadBinary\(/.test(apiSrc) && /mockAttachDownload/.test(apiSrc));
check('两个阅读区都渲染下载按钮与「获取附件」补拉入口',
    /mail-attach__dl/.test(pageSrc) && /btnMailAttachFetch/.test(pageSrc) &&
    /mail-attach__dl/.test(read('js/mail.js')) &&
    /btnMailAttachFetch/.test(read('js/mail.js')));

/* ------------------------------- 异步阶段 ------------------------------- */
var phases = [];
function phase(fn, wait) { phases.push({ fn: fn, wait: wait === undefined ? 700 : wait }); }
function run() {
    var p = phases.shift();
    if (!p) { return finish(); }
    try { p.fn(); } catch (e) {
        check('阶段执行异常：' + e.message, false, e.stack);
    }
    setTimeout(run, p.wait);
}
function finish() {
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}

/* ---- 1. 首屏：状态条 + 自动收件（打开页面立刻静默收一次） ---- */
phase(function () {
    console.log('\n--- 1. 首屏：本人信箱状态 + 打开页面自动收件 ---');
    check('状态条显示本人的邮箱 yangweikang@jiudou.com',
        /yangweikang@jiudou\.com/.test($('#mailEmail').text()), $('#mailEmail').text());
    check('状态条标明「仅本人可见」', /仅本人可见/.test($('.mail-status__tag').text()) &&
        /仅本人可见/.test($('#mailMeta').text()));
    check('状态条标明「自动收件：开启」「信箱已启用」',
        /自动收件：开启/.test($('#mailMeta').text()) && /信箱已启用/.test($('#mailMeta').text()),
        $('#mailMeta').text());
    check('状态条回显 IMAP 服务器与服务商',
        /IMAP imap\.jiudou\.com:993/.test($('#mailMeta').text()) &&
        /自定义域名/.test($('#mailMeta').text()), $('#mailMeta').text());
    check('自动收件已跑过（最近收件时间不再是 -）',
        !/最近收件：-/.test($('#mailLastSync').text()), $('#mailLastSync').text());
    check('设置了 5 分钟一次的自动收件定时器', w.__autoTimers.length === 1 &&
        w.__autoTimers[0] === 300000, JSON.stringify(w.__autoTimers));
    check('收件箱列表 3 封（原有 2 封 + 自动收件 1 封）', items($).length === 3,
        String(items($).length));
    check('列表里有自动收件演示邮件', /【演示】自动收件成功/.test($('#mailList').text()),
        $('#mailList').text().replace(/\s+/g, ' ').slice(0, 100));
    check('列表里看不到员工 1 的机密邮件', !/【机密】管理员专用邮件/.test($('#mailList').text()));
    check('收件箱徽标 3 / 已发送徽标 1', $.trim($('#badgeInbox').text()) === '3' &&
        $.trim($('#badgeSent').text()) === '1',
        $('#badgeInbox').text() + ' / ' + $('#badgeSent').text());
    check('「收件 / 写邮件」按钮可用', $('#btnSync').prop('disabled') === false &&
        $('#btnWrite').prop('disabled') === false);
    check('localStorage 里共 6 封（5 封种子 + 1 封自动收件）', mails(w).length === 6,
        String(mails(w).length));
}, 700);

/* ---- 2. 越权探针 + 另一个员工窗口 ---- */
phase(function () {
    console.log('\n--- 2. 越权探针：前端传 empId / 别人的邮件 id 一律无效 ---');
    w.Api.empMail.status().done(function (d) { probes.status = d; });
    // 前端伪造 empId=1 去查列表、去保存配置
    w.Api.empMail.page({ folder: 'inbox', empId: 1, pageNum: 1, pageSize: 20 })
        .done(function (d) { probes.pageFake = d; });
    w.Api.empMail.save({ empId: 1, email: 'yangweikang@jiudou.com',
        displayName: '前端传 empId 无效', password: '' })
        .done(function (d) { probes.saveFake = d; });
    w.Api.empMail.detail(OTHER_MAIL_ID).done(function (d) { probes.otherDetail = d; })
        .fail(function (e) { probes.otherDetailErr = e; });
    w.Api.empMail.mark([OTHER_MAIL_ID], false).done(function (d) { probes.markOther = d; });
    w.Api.empMail.remove([OTHER_MAIL_ID]).done(function (d) { probes.delOther = d; });
    w.Api.empMail.test().done(function (d) { probes.test = d; })
        .fail(function (e) { probes.testErr = e; });
    w2 = boot(sso(1));                 // 乙：系统管理员（empId=1，自动收件关闭）
    $2 = w2.jQuery;
}, 900);

/* ---- 3. 断言越权结果 + 乙窗口的隔离视图 ---- */
phase(function () {
    console.log('\n--- 3. 断言强隔离：甲看不到乙、乙看不到甲 ---');
    check('status 返回 empId=3（不是前端传的 1）',
        probes.status && probes.status.empId === 3, JSON.stringify(probes.status && probes.status.empId));
    check('status 不返回密码明文，只给 hasPassword / passwordMask',
        probes.status && probes.status.password === undefined &&
        probes.status.hasPassword === true && probes.status.passwordMask === '******');
    check('带 empId=1 的列表仍只返回甲的 3 封邮件',
        probes.pageFake && probes.pageFake.empId === 3 && probes.pageFake.total === 3 &&
        !/机密/.test(JSON.stringify(probes.pageFake.list)),
        JSON.stringify(probes.pageFake && probes.pageFake.total));
    check('带 empId=1 的保存只改到甲的配置（乙的配置原样）',
        (function () {
            var bs = boxes(w), mine = null, other = null;
            for (var i = 0; i < bs.length; i++) {
                if (bs[i].empId === 3) { mine = bs[i]; }
                if (bs[i].empId === 1) { other = bs[i]; }
            }
            return !!mine && !!other && mine.displayName === '前端传 empId 无效' &&
                other.displayName === '系统管理员' && probes.saveFake &&
                probes.saveFake.empId === 3;
        })(), JSON.stringify(boxes(w).map(function (b) { return [b.empId, b.displayName]; })));
    check('读别人的邮件 id 返回 404（不泄露邮件是否存在）',
        !probes.otherDetail && probes.otherDetailErr && probes.otherDetailErr.code === 404,
        probes.otherDetailErr && probes.otherDetailErr.message);
    check('标记 / 删除别人的邮件都是 0 行',
        probes.markOther && probes.markOther.updated === 0 &&
        probes.delOther && probes.delOther.deleted === 0,
        JSON.stringify([probes.markOther, probes.delOther]));
    check('连接测试（离线演示）返回 ok', probes.test && probes.test.ok === true &&
        probes.test.imap === true && probes.test.smtp === true,
        probes.testErr && probes.testErr.message);

    check('乙状态条显示自己的 admin@jiudou.com',
        /admin@jiudou\.com/.test($2('#mailEmail').text()), $2('#mailEmail').text());
    check('乙状态条显示「自动收件：关闭」',
        /自动收件：关闭/.test($2('#mailMeta').text()), $2('#mailMeta').text());
    check('乙没有启动自动收件定时器（配置里 autoSync=0）',
        w2.__autoTimers.length === 0, JSON.stringify(w2.__autoTimers));
    check('乙能看到自己的机密邮件', /【机密】管理员专用邮件/.test($2('#mailList').text()),
        $2('#mailList').text().replace(/\s+/g, ' ').slice(0, 100));
    check('乙看不到甲的需求评审邮件',
        !/关于下周需求评审的安排/.test($2('#mailList').text()));
    w2.Api.empMail.detail(MY_MAIL_ID).fail(function (e) { probes.w2OtherDetailHit = e.code; });
    probes.w2OtherDetailHit = 'pending';
}, 900);

phase(function () {
    check('乙读甲的邮件 id 确实返回 404', probes.w2OtherDetailHit === 404,
        String(probes.w2OtherDetailHit));
    console.log('\n--- 4. 读信：打开即标记已读 ---');
    items($).filter('.is-unread').first().trigger('click');
}, 500);

/* ---- 5. 读信内容 ---- */
phase(function () {
    var text = $('#mailRead').text().replace(/\s+/g, ' ');
    check('阅读区显示主题与正文', /关于下周需求评审的安排|【演示】自动收件成功|11 月考勤确认提醒/.test(text) &&
        /杨工您好|这是离线演示模式|请于本周五前/.test(text), text.slice(0, 120));
    check('阅读区显示发件人 / 收件人 / 时间', /发件人/.test(text) && /收件人/.test(text) &&
        /2026-11/.test(text), text.slice(0, 140));
    check('阅读区有「回复 / 标记未读 / 删除」按钮',
        $('#btnReply').length === 1 && $('#btnToggleSeen').length === 1 &&
        $('#btnMailDelete').length === 1);
    check('打开后未读项减少（3 封里剩 1 封未读）',
        items($).filter('.is-unread').length === 1,
        String(items($).filter('.is-unread').length));
    console.log('\n--- 5. 标记未读 ---');
    $('#btnToggleSeen').trigger('click');
}, 900);

/* ---- 6. 标记未读结果 ---- */
phase(function () {
    check('按钮文案变为「标记已读」', $.trim($('#btnToggleSeen').text()) === '标记已读',
        $('#btnToggleSeen').text());
    check('列表里未读项恢复为 2 封', items($).filter('.is-unread').length === 2,
        String(items($).filter('.is-unread').length));
    console.log('\n--- 6. 写邮件：表单与必填校验 ---');
    $('#btnWrite').trigger('click');
}, 900);

/* ---- 7. 写邮件弹窗 ---- */
phase(function () {
    var $f = dialogBody($).find('.mail-form');
    check('弹出「写邮件」弹窗', /写邮件/.test(dialog($).find('.el-dialog__title').text()),
        dialog($).find('.el-dialog__title').text());
    check('发件人提示固定为本人配置的邮箱',
        /yangweikang@jiudou\.com/.test($f.find('#mfFromTip').text()), $f.find('#mfFromTip').text());
    check('表单含收件人 / 抄送 / 主题 / 正文 / 附件',
        $f.find('#mfTo').length === 1 && $f.find('#mfCc').length === 1 &&
        $f.find('#mfSubject').length === 1 && $f.find('#mfBody').length === 1 &&
        $f.find('#mfFile').length === 1);
    check('确定按钮文案为「发送」', $.trim(dialog($).find('.btn-ok').text()) === '发送',
        dialog($).find('.btn-ok').text());
    /* 抄送也能从员工信息中选取（与收件人同一套选人弹窗，标题与提示随字段变化） */
    check('抄送右侧有「从员工选取」按钮',
        $f.find('#mfPickEmpCc').length === 1 &&
        /从员工选取/.test($f.find('#mfPickEmpCc').text()),
        $f.find('#mfPickEmpCc').text());
    check('抄送输入框与按钮同一行（复用 .mail-to）',
        $f.find('#mfCc').closest('.mail-to').length === 1);
    $f.find('#mfPickEmpCc').trigger('click');
}, 800);

/* ---- 7b. 抄送选人：标题 / 回填 / 跨字段去重 ---- */
phase(function () {
    check('弹出「从员工信息中选取抄送」',
        /从员工信息中选取抄送/.test(dialog($).text()),
        dialog($).find('.el-dialog__title').text());
    check('底部提示写明追加到抄送',
        /追加到抄送/.test(dialogBody($).find('.emp-pick__picked').text()),
        dialogBody($).find('.emp-pick__picked').text());
    var rows = dialogBody($).find('.emp-pick__row');
    rows.eq(0).find('.pf-check').prop('checked', true).trigger('change');
    dialog($).find('.btn-ok').trigger('click');
}, 900);

phase(function () {
    var cc = String(dialogBody($).find('#mfCc').val() || '');
    check('所选员工写入抄送', /.+@.+\..+/.test(cc), cc);
    check('收件人未被抄送选人影响', String(dialogBody($).find('#mfTo').val() || '') === '',
        String(dialogBody($).find('#mfTo').val() || ''));
    /* 弹窗底部「发送」：btn-ok 在 footer 不在 body，必须用 dialog() 找 */
    dialog($).find('.btn-ok').trigger('click');
}, 800);

/* ---- 8. 必填校验 → 填写并发送 ---- */
phase(function () {
    check('未填收件人时提示「请填写收件人」', /请填写收件人/.test(toast($)), toast($));
    var $f = dialogBody($).find('.mail-form');
    $f.find('#mfTo').val('client@example.com');
    $f.find('#mfSubject').val('个人邮箱联调确认');
    $f.find('#mfBody').val('这封邮件由员工本人信箱发出。');
    dialog($).find('.btn-ok').trigger('click');
}, 600);

/* ---- 9. 发送结果 ---- */
phase(function () {
    check('发送成功提示', /邮件已发送/.test(toast($)), toast($));
    check('弹窗已关闭', $('.el-overlay .el-dialog').length === 0,
        String($('.el-overlay .el-dialog').length));
    check('自动切到「已发送」', folder($, 'sent').hasClass('is-active'));
    check('已发送徽标 2 / 列表 2 封', $.trim($('#badgeSent').text()) === '2' &&
        items($).length === 2,
        $('#badgeSent').text() + ' / ' + items($).length);
    check('新邮件出现在已发送列表', /个人邮箱联调确认/.test($('#mailList').text()),
        $('#mailList').text().replace(/\s+/g, ' ').slice(0, 100));
    check('发出的邮件归属 empId=3，发件人是本人信箱',
        (function () {
            var ms = mails(w), hit = null;
            for (var i = 0; i < ms.length; i++) {
                if (ms[i].subject === '个人邮箱联调确认') { hit = ms[i]; }
            }
            return !!hit && hit.empId === 3 && hit.direction === 'out' &&
                hit.fromAddr === 'yangweikang@jiudou.com';
        })());
    console.log('\n--- 7. 删除邮件 ---');
    items($).first().trigger('click');
}, 1000);

/* ---- 10. 删除确认 ---- */
phase(function () {
    check('阅读区出现删除按钮', $('#btnMailDelete').length === 1);
    $('#btnMailDelete').trigger('click');
}, 800);

phase(function () {
    check('删除前弹出确认框', /删除邮件/.test(msgBox($).text()), msgBox($).text().slice(0, 50));
    msgBox($).find('.btn-ok').trigger('click');
}, 1000);   // 删除后要等 remove → loadData → renderList 整条 Mock 异步链跑完（曾偶发 500ms 不够）

phase(function () {
    check('删除后已发送徽标回到 1 / 列表 1 封',
        $.trim($('#badgeSent').text()) === '1' && items($).length === 1,
        $('#badgeSent').text() + ' / ' + items($).length);
    check('localStorage 邮件数回到 6', mails(w).length === 6, String(mails(w).length));
    console.log('\n--- 8. 我的邮箱设置：编辑态 + 关闭自动收件 ---');
    mailCountBeforeSetting = mails(w).length;
    $('#btnMailSetting').trigger('click');
}, 950);

/* ---- 11. 设置弹窗回填 ---- */
phase(function () {
    var $f = dialogBody($).find('.em-form');
    check('弹出「我的邮箱设置」弹窗（已有配置 = 编辑）',
        /我的邮箱设置/.test(dialog($).find('.el-dialog__title').text()),
        dialog($).find('.el-dialog__title').text());
    check('说明卡写明「本人的邮箱」「只有您自己能看到」「自动收件」',
        /您本人的邮箱/.test($f.find('.em-form__notice').text()) &&
        /只有您自己能看到/.test($f.find('.em-form__notice').text()) &&
        /自动收件/.test($f.find('.em-form__notice').text()));
    check('回填本人邮箱，密码框为空且提示已保存密码（脱敏）',
        $f.find('#efEmail').val() === 'yangweikang@jiudou.com' &&
        $f.find('#efPassword').val() === '' && /已保存密码/.test($f.find('#efPasswordTip').text()),
        $f.find('#efEmail').val());
    check('回填「自动收件=开启」「启用=启用」，且表单里没有 empId 字段',
        $f.find('#efAutoSync').val() === '1' && $f.find('#efEnabled').val() === '1' &&
        $f.find('[name="empId"]').length === 0 && $f.find('#efEmpId').length === 0);
    $f.find('#efAutoSync').val('0');           // 关闭自动收件
    dialog($).find('.btn-ok').trigger('click');
}, 850);

/* ---- 12. 保存后不再自动收件 ---- */
phase(function () {
    check('保存成功提示', /保存成功/.test(toast($)), toast($));
    check('弹窗已关闭', $('.el-overlay .el-dialog').length === 0);
    check('状态条变为「自动收件：关闭」', /自动收件：关闭/.test($('#mailMeta').text()),
        $('#mailMeta').text());
    check('关闭自动收件后不再追加演示邮件',
        mails(w).length === mailCountBeforeSetting,
        String(mails(w).length) + ' vs ' + String(mailCountBeforeSetting));
    check('配置里 autoSync 已落为 0，且仍是 empId=3 一人一条',
        (function () {
            var bs = boxes(w), mine = null, mineCount = 0;
            for (var i = 0; i < bs.length; i++) {
                if (bs[i].empId === 3) { mine = bs[i]; mineCount++; }
            }
            return mineCount === 1 && !!mine && !mine.autoSync;
        })());
    check('没有再新建自动收件定时器', w.__autoTimers.length === 1,
        JSON.stringify(w.__autoTimers));
    console.log('\n--- 9. 未配置员工：引导 + 逐项校验 + 配置后立即自动收件 ---');
    w3 = boot(sso(9));                 // 丙：还没有配置过个人邮箱
    $3 = w3.jQuery;
}, 1300);

/* ---- 13. 未配置首屏 ---- */
phase(function () {
    check('状态条提示「尚未配置个人邮箱」',
        /尚未配置个人邮箱/.test($3('#mailEmail').text()), $3('#mailEmail').text());
    check('列表给出配置引导', /尚未配置个人邮箱/.test($3('#mailList').text()));
    check('「收件 / 写邮件」按钮禁用',
        $3('#btnSync').prop('disabled') === true && $3('#btnWrite').prop('disabled') === true);
    check('没有启动自动收件定时器', w3.__autoTimers.length === 0,
        JSON.stringify(w3.__autoTimers));
    $3('#btnMailSetting').trigger('click');
}, 1000);

/* ---- 14. 新增配置弹窗 ---- */
phase(function () {
    var $f = dialogBody($3).find('.em-form');
    check('弹窗标题为「配置我的邮箱」',
        /配置我的邮箱/.test(dialog($3).find('.el-dialog__title').text()),
        dialog($3).find('.el-dialog__title').text());
    check('邮箱 / 密码为空，启用与自动收件默认开启',
        $f.find('#efEmail').val() === '' && $f.find('#efPassword').val() === '' &&
        $f.find('#efEnabled').val() === '1' && $f.find('#efAutoSync').val() === '1');
    check('表单里没有 empId 字段（归属由后端按 token 决定）',
        $f.find('[name="empId"]').length === 0 && $f.find('#efEmpId').length === 0);
    dialog($3).find('.btn-ok').trigger('click');        // 空邮箱
}, 800);

phase(function () {
    check('空邮箱被拦下「请填写邮箱地址」', /请填写邮箱地址/.test(toast($3)), toast($3));
    dialogBody($3).find('#efEmail').val('not-an-email');
    dialog($3).find('.btn-ok').trigger('click');         // 格式错误
}, 550);

phase(function () {
    check('格式错误被拦下「邮箱地址格式不正确」',
        /邮箱地址格式不正确/.test(toast($3)), toast($3));
    dialogBody($3).find('#efEmail').val('newuser@jiudou.com');
    dialog($3).find('.btn-ok').trigger('click');         // 没填密码
}, 550);

phase(function () {
    check('首次配置缺密码被拦下「请填写邮箱密码或授权码」',
        /请填写邮箱密码或授权码/.test(toast($3)), toast($3));
    dialogBody($3).find('#efPassword').val('auth-code-123');
    dialog($3).find('.btn-ok').trigger('click');         // 正确保存
}, 550);

phase(function () {
    check('配置成功提示「已开始自动收件」', /配置成功，已开始自动收件/.test(toast($3)), toast($3));
    check('弹窗已关闭', $3('.el-overlay .el-dialog').length === 0);
    check('状态条切到 newuser@jiudou.com', /newuser@jiudou\.com/.test($3('#mailEmail').text()),
        $3('#mailEmail').text());
    check('状态条标明「自动收件：开启」「信箱已启用」',
        /自动收件：开启/.test($3('#mailMeta').text()) &&
        /信箱已启用/.test($3('#mailMeta').text()), $3('#mailMeta').text());
    check('新配置属于 empId=9，且开启了自动收件',
        (function () {
            var bs = boxes(w3), mine = null;
            for (var i = 0; i < bs.length; i++) { if (bs[i].empId === 9) { mine = bs[i]; } }
            return !!mine && !!mine.autoSync && !!mine.enabled &&
                mine.email === 'newuser@jiudou.com';
        })());
    check('自动收件定时器已启动（5 分钟）', w3.__autoTimers.length === 1 &&
        w3.__autoTimers[0] === 300000, JSON.stringify(w3.__autoTimers));
    // 保存 → loadStatus → 自动收件 → 再刷状态/列表，整条链要等完再断言列表
}, 1400);

phase(function () {
    check('配置后立刻自动收了一封（列表 1 封演示邮件）',
        items($3).length === 1 && /【演示】自动收件成功/.test($3('#mailList').text()),
        $3('#mailList').text().replace(/\s+/g, ' ').slice(0, 100));
    check('演示邮件的 empId=9（不会串到别的员工）',
        (function () {
            var ms = mails(w3), extra = [];
            for (var i = 0; i < ms.length; i++) {
                if (String(ms[i].subject).indexOf('【演示】') === 0) { extra.push(ms[i]); }
            }
            return extra.length === 1 && extra[0].empId === 9;
        })());
}, 700);

/* ---- 16. 员工 2：首次配置邮箱框自动带入员工信息表邮箱、密码置空 ---- */
phase(function () {
    w4 = boot(sso(2));    // 丁：李耘创（empId=2）——员工档案有邮箱、未配个人邮箱
    $4 = w4.jQuery;
}, 1300);

phase(function () {
    check('员工 2 未配置：状态条提示「尚未配置个人邮箱」',
        /尚未配置个人邮箱/.test($4('#mailEmail').text()), $4('#mailEmail').text());
    $4('#btnMailSetting').trigger('click');
}, 800);

phase(function () {
    var $f = dialogBody($4).find('.em-form');
    check('首次配置：邮箱框自动带入员工信息表邮箱（可修改）',
        $f.find('#efEmail').val() === 'liyunchuang@jiudou.com',
        $f.find('#efEmail').val());
    check('首次配置：密码框置空、不带入任何默认值',
        $f.find('#efPassword').val() === '', $f.find('#efPassword').val());
    check('邮箱/密码输入框已加 autocomplete，阻止浏览器带入记住的帐号密码',
        $f.find('#efEmail').attr('autocomplete') === 'off' &&
        $f.find('#efPassword').attr('autocomplete') === 'new-password');
    dialog($4).find('.btn-cancel').trigger('click');       // 只验证预填，不保存
}, 600);

phase(function () {
    check('员工 2 未保存：本地仍无个人信箱配置',
        (function () {
            var bs = boxes(w4), hit = [];
            for (var i = 0; i < bs.length; i++) {
                if (parseInt(bs[i].empId, 10) === 2) { hit.push(bs[i]); }
            }
            return hit.length === 0;
        })());
}, 500);

/* ---- 13. 附件下载列表：历史收件补拉 → 下载 → 来源隔离 ---- */
var attachDl = null, attachDlErr = null, attachCrossErr = null;
phase(function () {
    console.log('\n--- 13. 附件下载列表（历史收件） ---');
    folder($, 'inbox').trigger('click');
}, 800);

phase(function () {
    var $row = items($).filter(function () {
        return /11 月考勤确认提醒/.test($(this).text());
    }).first();
    check('收件箱里能找到带附件标记的历史邮件', $row.length === 1, String($row.length));
    if ($row.length) { $row.trigger('click'); }
}, 800);

phase(function () {
    check('历史邮件显示「获取附件」按钮',
        $('#btnMailAttachFetch').length === 1 && /历史收件/.test($('#mailRead').text()),
        $('#mailRead').text().replace(/\s+/g, ' ').slice(0, 100));
    check('补拉前没有下载按钮', $('#mailRead .mail-attach__dl').length === 0);
    $('#btnMailAttachFetch').trigger('click');
}, 900);

phase(function () {
    var $btns = $('#mailRead .mail-attach__dl');
    check('补拉后列出 2 个可下载附件', $btns.length === 2, String($btns.length));
    check('附件名与大小显示在下载列表里',
        /联调接口说明\.txt/.test($('#mailRead').text()) &&
        /测试环境清单\.csv/.test($('#mailRead').text()) &&
        /23 B/.test($('#mailRead').text()),
        $('#mailRead .mail-read__attach').text().replace(/\s+/g, ' ').slice(0, 120));
    if ($btns.length) {
        var id = $btns.first().attr('data-file-id');
        w.Api.empMail.downloadAttachment(id).done(function (res) { attachDl = res; })
            .fail(function (e) { attachDlErr = e; });
        // 同一个附件 id 换服务信箱通道：source 不同，应 404
        w.Api.mail.downloadAttachment(id).fail(function (e) { attachCrossErr = e; });
    }
}, 900);

phase(function () {
    check('我的邮箱附件可下载（Mock dataUrl + 原文件名）',
        !!attachDl && /^data:/.test(attachDl.dataUrl || '') &&
        attachDl.name === '联调接口说明.txt',
        JSON.stringify(attachDl) + ' / ' + (attachDlErr && attachDlErr.message));
    check('服务信箱通道拿不到我的邮箱附件（来源隔离）',
        !!attachCrossErr && attachCrossErr.code === 404,
        attachCrossErr && attachCrossErr.message);
}, 700);

/* 首屏要等 status → 自动收件 → 状态/列表刷新整条异步链跑完（Mock 每次请求 240ms） */
setTimeout(run, 2200);
