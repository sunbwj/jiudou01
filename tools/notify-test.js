/* ==========================================================================
   notify-test.js —— 主框架「消息提醒中心」测试（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖：
     · 静态：main.html 铃铛 DOM / notify.css / notify.js 版本与位置、
             AppNotify 对外 API、Api.notify.summary、Mock /notify 服务、
             后端 NotifyService（im + mail 未读聚合）、ACTIONS·SERVICES 注册、
             菜单更名 SQL（站内消息 → 即时对话）、message.html 标题、
             message.js 深链 ?peer= 与主框架联动
     · 首屏：start() 后从 Mock 取到未读 → 铃铛红点数字 / 菜单上标（首屏不响）
     · 渲染：apply() 双区（即时对话 / 新邮件）+ 时间格式化 + 点条目跳转（对话带 ?peer=）
     · 提醒：未读变大 → 提示音（WebAudio）+ 语音播报（speechSynthesis）；同值不再重复响；
             关了开关就不再响（偏好写 localStorage）
     · 清零：未读归零 → 红点隐藏、菜单上标移除
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/notify-test.js
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

/* ------------------------------- 0. 静态一致性 ------------------------------- */
var mainHtml = read('main.html');
var notifyJs = read('js/notify.js');
var notifyCss = read('css/notify.css');
var frameJs = read('js/frame.js');
var apiSrc = read('js/api.js');
var msgHtml = read('message.html');
var msgJs = read('js/message.js');
var svcSrc = read('server/service.py');
var renameSql = read('db/emp-message-rename-im.sql');

console.log('--- 0. 静态一致性（页面 / 脚本 / 接口 / 后端 / 数据库） ---');
check('main.html 铃铛 DOM 齐全（按钮 / 红点 / 面板 / 列表 / 两个开关 / 刷新）',
    ['id="frameBell"', 'id="frameBellBtn"', 'id="frameBellDot"', 'id="frameBellPanel"',
        'id="frameBellBody"', 'id="frameBellSound"', 'id="frameBellVoice"', 'id="frameBellRefresh"']
        .every(function (k) { return mainHtml.indexOf(k) > -1; }));
check('铃铛挂在「登录用户信息」之前（顶栏右侧同一区域）',
    mainHtml.indexOf('id="frameBell"') > -1 &&
    mainHtml.indexOf('id="frameBell"') < mainHtml.indexOf('id="frameUser"'));
check('main.html 引用 css/notify.css?v=20261107b（只用在本页，不动 app.css）',
    mainHtml.indexOf('css/notify.css?v=20261107b') > -1);
check('main.html 引用 js/notify.js?v=20261107b，且排在 frame.js 之后',
    mainHtml.indexOf('js/notify.js?v=20261107b') > -1 &&
    mainHtml.indexOf('js/frame.js?v=20261112a') < mainHtml.indexOf('js/notify.js?v=20261107b'));
check('AppNotify 对外 API 齐全（start/stop/refresh/bump/apply/applyMenuBadges/openConversation/chime/speak）',
    ['start: start', 'stop: stop', 'refresh: refresh', 'bump: bump', 'apply: apply',
        'applyMenuBadges: applyMenuBadges', 'openConversation: openConversation',
        'chime: chime', 'speak: speak']
        .every(function (k) { return notifyJs.indexOf(k) > -1; }));
check('数据源统一为 Api.notify.summary()',
    notifyJs.indexOf('window.Api.notify.summary()') > -1);
check('实时性：自己开 WS 收 msg 帧（Api.msg.connect）+ 20 秒轮询兜底',
    notifyJs.indexOf('window.Api.msg.connect({})') > -1 &&
    /var POLL_MS = 20000;/.test(notifyJs) &&
    notifyJs.indexOf('setInterval(function () { refresh({ silent: false }); }, POLL_MS)') > -1);
check('#3 语音提醒：WebAudio 提示音 + speechSynthesis 语音播报，都可关',
    notifyJs.indexOf('window.AudioContext || window.webkitAudioContext') > -1 &&
    notifyJs.indexOf('window.speechSynthesis') > -1 &&
    notifyJs.indexOf('SpeechSynthesisUtterance') > -1 &&
    notifyJs.indexOf('frameBellSound') > -1 && notifyJs.indexOf('frameBellVoice') > -1);
check('只在「未读变大」时提醒，且首屏 silent 不响（State.imUnread 差值判断）',
    notifyJs.indexOf('var delta = STATE.imUnread - prevIm;') > -1 &&
    notifyJs.indexOf('if (!opts.silent && delta > 0') > -1 &&
    notifyJs.indexOf('refresh({ silent: true });              // 首屏') > -1);
check('正在看这个人的会话时不再响（避免「当面说话还叮咚」）',
    notifyJs.indexOf('function activeChatPeer()') > -1 &&
    notifyJs.indexOf('activeChatPeer() === num(first.empId)') > -1);
check('正在看这个群时也不响（群未读同样免打扰）',
    notifyJs.indexOf('function activeChatGroup()') > -1 &&
    notifyJs.indexOf('activeChatGroup() === String(first.groupId)') > -1);
check('提醒中心面板渲染群条目并走 ?group= 深链',
    notifyJs.indexOf('data-group=') > -1 &&
    notifyJs.indexOf("openPage('message.html?group='") > -1 &&
    notifyJs.indexOf('openGroupConversation: openGroupConversation') > -1);
check('frame.js 启动提醒中心，并在导航重绘后重挂菜单上标',
    frameJs.indexOf('window.AppNotify.start()') > -1 &&
    frameJs.indexOf('window.AppNotify.applyMenuBadges()') > -1);
check('notify.css 关键样式（红点 / 面板 / 菜单上标 / 邮件橙色区分）',
    ['.frame-bell__dot', '.frame-bell__panel', '.frame-nav-badge', '.frame-nav-badge.is-mail',
        '.frame-bell__avatar.is-mail']
        .every(function (k) { return notifyCss.indexOf(k) > -1; }));

check('api.js 导出 Api.notify.summary → GET /notify/summary',
    /var notify = \{\s*summary: function \(\) \{ return request\('GET', '\/notify\/summary'/.test(apiSrc));
check('api.js Mock 注册 /notify 服务（前缀在 /msg 之后）',
    apiSrc.indexOf("{ prefix: '/notify', svc: notifySvc }") > -1 &&
    apiSrc.indexOf("{ prefix: '/notify'") > apiSrc.indexOf("{ prefix: '/msg'"));
check('Mock notify 复用 /msg 与 /empmail 的既有存储（口径不漂移）',
    apiSrc.indexOf("msgSvc.route('GET', '/contacts', {})") > -1 &&
    apiSrc.indexOf("empMailSvc.route('GET', '/status', {})") > -1 &&
    apiSrc.indexOf("empMailSvc.route('GET', '/list',") > -1);

check('后端 EmpMessageService.unread_summary（按发件人聚合未读）',
    /def unread_summary\(self, params=None, limit=8\)/.test(svcSrc) &&
    svcSrc.indexOf("GROUP BY `senderId`") > -1);
check('后端 EmpMailService.unread_summary（未读邮件列表 + 未配置不报错）',
    /def unread_summary\(self, params=None, limit=5\)/.test(svcSrc) &&
    svcSrc.indexOf("AND `direction`='in' AND `seen`=0") > -1);
check('后端 NotifyService.summary 聚合 im + mail，任一异常都降级',
    /class NotifyService\(object\)/.test(svcSrc) &&
    svcSrc.indexOf("out['total'] = int(out['im'].get('unread') or 0)") > -1);
check('SERVICES 注册 notify / ACTIONS 注册 summary',
    /'notify': notify_service/.test(svcSrc) &&
    /'summary': \('summary', \['GET'\]\)/.test(svcSrc));
check('我的邮箱列表支持 unread=1 过滤（后端 + Mock 同口径）',
    svcSrc.indexOf("if str(params.get('unread') or '').strip().lower() in ('1', 'true', 'yes', 'on')") > -1 &&
    apiSrc.indexOf("var wantUnread = ['1', 'true', 'yes', 'on']") > -1);

check('#1 菜单更名 SQL：站内消息 → 即时对话（可重复执行）',
    renameSql.indexOf("SET `nameCn` = '即时对话'") > -1 &&
    renameSql.indexOf("WHERE `code` = 'MNU00022'") > -1 &&
    renameSql.indexOf("SET `pageName` = '即时对话'") > -1);
check('#1 即时对话页标题 / 面包屑已改（与菜单名一致）',
    /<title>即时对话/.test(msgHtml) && msgHtml.indexOf('data-crumb="邮件中心/即时对话"') > -1);
check('message.js 支持深链 ?peer= / ?group= 与主框架联动（openPeerLater / AppNotify.bump）',
    msgJs.indexOf("queryOf('peer')") > -1 &&
    msgJs.indexOf("queryOf('group')") > -1 &&
    msgJs.indexOf('openPeerLater: function (empId)') > -1 &&
    msgJs.indexOf('openGroupLater: function (groupId)') > -1 &&
    msgJs.indexOf('p.AppNotify.bump') > -1);

/* ------------------------------- 1. 启动窗口 ------------------------------- */
var beeps = 0, spoken = [], navTo = [];
function boot(pre) {
    var dom = new JSDOM(mainHtml, {
        url: 'http://127.0.0.1:8808/main.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.__timers = [];
    win.setInterval = function (fn, ms) { win.__timers.push(ms); return win.__timers.length; };
    // 语音合成桩：记录播报文本（jsdom 无 speechSynthesis）
    win.speechSynthesis = { cancel: function () {}, speak: function (u) { spoken.push(u.text); } };
    win.SpeechSynthesisUtterance = function (text) { this.text = text; };
    // WebAudio 桩：记录振荡器数量（= 提示音是否播放）
    win.AudioContext = function () {
        var self = this;
        self.state = 'running';
        self.currentTime = 0;
        self.destination = {};
        self.resume = function () {};
        self.createOscillator = function () {
            beeps++;
            return { type: '', frequency: { value: 0 }, connect: function () {},
                start: function () {}, stop: function () {} };
        };
        self.createGain = function () {
            return { gain: { setValueAtTime: function () {}, exponentialRampToValueAtTime: function () {} },
                connect: function () {} };
        };
    };
    if (pre) { pre(win); }
    win.jQuery.ajax = function () {              // 阻断真实 HTTP → api.js 回退 Mock
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/notify.js'));
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
/** 顶部注入了假的左侧导航（真实导航由 /api/nav 异步渲染，这里只验上标挂载逻辑） */
function injectMenu(win) {
    var $ = win.jQuery;
    $('#frameMenu').html(
        '<a class="frame-side__item" data-url="message.html" data-title="即时对话">' +
            '<span class="txt">即时对话</span></a>' +
        '<a class="frame-side__item" data-url="emp-mail.html" data-title="我的邮箱">' +
            '<span class="txt">我的邮箱</span></a>' +
        '<a class="frame-side__item" data-url="home.html" data-title="系统首页">' +
            '<span class="txt">系统首页</span></a>');
}

var phases = [];
function phase(fn, wait) { phases.push({ fn: fn, wait: wait === undefined ? 400 : wait }); }
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

var w = boot(sso(3));
var $ = w.jQuery;
var NA = w.AppNotify;
var probes = {};

/* ---- 1. 首屏：start() 从 Mock 取到未读，首屏不响 ---- */
phase(function () {
    console.log('\n--- 1. 首屏启动（Mock 通道）---');
    check('AppNotify.start() 在框架页成功启动', NA.start() === true);
    check('重复 start() 幂等', NA.start() === true && NA.state.started === true);
    check('注册了 20 秒轮询定时器', w.__timers.indexOf(20000) > -1, JSON.stringify(w.__timers));
}, 700);

phase(function () {
    check('首屏已从 /notify/summary 拿到数据', NA.state.total > 0,
        'total=' + NA.state.total);
    check('Mock 里 empId=3 有 1 条来自 emp1 的未读对话', NA.state.imUnread === 1,
        String(NA.state.imUnread));
    check('铃铛红点显示「对话 + 邮件」总数且不再隐藏',
        !$('#frameBellDot').is('[hidden]') &&
        $.trim($('#frameBellDot').text()) === String(NA.state.total),
        $('#frameBellDot').text() + ' vs total ' + NA.state.total);
    check('首屏不播提示音 / 不播语音（不打扰登录动作）',
        beeps === 0 && spoken.length === 0, 'beeps=' + beeps + ' spoken=' + spoken.length);
}, 200);

/* ---- 2. 渲染：apply() 双区 + 菜单上标 ---- */
phase(function () {
    console.log('\n--- 2. 铃铛气泡 + 菜单上标（#2 红点加数字）---');
    injectMenu(w);
    NA.apply({
        im: {
            unread: 3, peers: [
                { empId: 2, name: '李明', deptName: '研发部', avatarText: '李', unread: 2,
                    lastContent: '本周例会纪要', lastTime: '2026-11-07 09:20:00' },
                { empId: 1, name: '系统管理员', deptName: '信息中心', avatarText: '系', unread: 1,
                    lastContent: '欢迎使用九豆综合管理平台', lastTime: '2026-11-06 09:10:00' }
            ]
        },
        mail: {
            configured: true, unread: 2, items: [
                { id: 'm1', fromName: '冯志剑', fromAddr: 'fengzhj@szyc-data.com',
                    subject: '脑卒中管理端', sentTime: '2026-11-02 14:07:48' }
            ]
        },
        total: 5
    }, { silent: true });

    check('铃铛红点为「即时对话 + 新邮件」总数 5', $.trim($('#frameBellDot').text()) === '5',
        $('#frameBellDot').text());
    var $imBadge = $('#frameMenu .frame-side__item[data-url="message.html"] .frame-nav-badge');
    var $mailBadge = $('#frameMenu .frame-side__item[data-url="emp-mail.html"] .frame-nav-badge');
    check('即时对话菜单项挂上红色数字上标 3', $imBadge.length === 1 &&
        $.trim($imBadge.text()) === '3' && !$imBadge.hasClass('is-mail'), $imBadge.text());
    check('我的邮箱菜单项挂上橙色数字上标 2（与对话区分）', $mailBadge.length === 1 &&
        $.trim($mailBadge.text()) === '2' && $mailBadge.hasClass('is-mail'), $mailBadge.text());
    check('系统首页等无关菜单项不挂上标',
        $('#frameMenu .frame-side__item[data-url="home.html"] .frame-nav-badge').length === 0);
    check('菜单上标带 title 提示（未读对话 3 条）',
        String($imBadge.attr('title') || '').indexOf('3') > -1, $imBadge.attr('title'));
    check('apply 静默时不响', beeps === 0 && spoken.length === 0);

    // 面板渲染
    NA.openPanel();
    var txt = $('#frameBellBody').text();
    check('下拉面板分「即时对话 / 新邮件」两区', txt.indexOf('即时对话') > -1 && txt.indexOf('新邮件') > -1);
    check('对话区列出 2 个未读联系人（含部门与摘要）',
        $('#frameBellBody .frame-bell__item[data-peer]').length === 2 &&
        txt.indexOf('李明') > -1 && txt.indexOf('研发部') > -1 && txt.indexOf('本周例会纪要') > -1);
    check('邮件区列出 1 封未读（发件人 + 主题）',
        $('#frameBellBody .frame-bell__item[data-mail]').length === 1 &&
        txt.indexOf('冯志剑') > -1 && txt.indexOf('脑卒中管理端') > -1);
    check('两区标题各带自己的计数（3 / 2）',
        $('.frame-bell__sec-title .frame-bell__count').eq(0).text() === '3' &&
        $('.frame-bell__sec-title.is-mail .frame-bell__count').text() === '2');
    check('时间已格式化（今天只显示 HH:MM）', txt.indexOf('09:20') > -1, txt.slice(0, 80));
    check('两个提醒开关按偏好回填（默认都开）',
        $('#frameBellSound').prop('checked') === true && $('#frameBellVoice').prop('checked') === true);
}, 200);

/* ---- 3. 点条目跳转（#5 下拉直达） ---- */
phase(function () {
    console.log('\n--- 3. 点条目直达（对话带 ?peer=，已开页不重复开 Tab）---');
    w.AppFrame = {
        navigate: function (u) { navTo.push(u); },
        current: function () { return 'home.html'; }
    };
    $('#frameBellBody .frame-bell__item[data-peer]').eq(0).trigger('click');
    check('点对话条目 → 打开 message.html?peer=2', navTo[0] === 'message.html?peer=2',
        JSON.stringify(navTo));
    check('点完自动收起面板', $('#frameBellPanel').is('[hidden]'));

    navTo.length = 0;
    NA.openPanel();
    $('#frameBellBody .frame-bell__item[data-mail]').eq(0).trigger('click');
    check('点邮件条目 → 打开 emp-mail.html', navTo[0] === 'emp-mail.html', JSON.stringify(navTo));

    // 已开着即时对话标签：只激活 + 让它切会话，不再新开 ?peer= 深链
    navTo.length = 0;
    var frame = w.document.createElement('iframe');
    frame.setAttribute('data-url', 'message.html');
    $(frame).appendTo('#framePanes');
    var called = [];
    frame.contentWindow.IM = { openPeerLater: function (id) { called.push(id); return true; } };
    NA.openConversation(2);
    check('已开着即时对话标签时走 openPeerLater（不新开 Tab）',
        called.length === 1 && called[0] === 2 && navTo[0] === 'message.html',
        'called=' + JSON.stringify(called) + ' nav=' + JSON.stringify(navTo));
    $(frame).remove();
}, 200);

/* ---- 4. 新消息提醒（#3 提示音 + 语音） ---- */
phase(function () {
    console.log('\n--- 4. 新对话到达：提示音 + 语音播报 ---');
    // 先回到 3 条（silent），再涨到 4 条 → 应响一次
    NA.apply({ im: { unread: 3, peers: [{ empId: 2, name: '李明', deptName: '研发部', unread: 3,
        lastContent: '例会改了时间', lastTime: '2026-11-07 09:40:00' }] },
        mail: { configured: true, unread: 0, items: [] }, total: 3 }, { silent: true });
    var b0 = beeps, s0 = spoken.length;
    NA.apply({ im: { unread: 4, peers: [{ empId: 2, name: '李明', deptName: '研发部', unread: 4,
        lastContent: '例会改了时间', lastTime: '2026-11-07 09:40:00' }] },
        mail: { configured: true, unread: 0, items: [] }, total: 4 }, { silent: false });
    check('未读变大 → 播放提示音（WebAudio，两声）', beeps === b0 + 2, 'beeps=' + (beeps - b0));
    check('未读变大 → 语音播报（含发件人姓名）',
        spoken.length === s0 + 1 && spoken[spoken.length - 1].indexOf('李明') > -1,
        spoken[spoken.length - 1]);
    check('铃铛跟着变成 4', $.trim($('#frameBellDot').text()) === '4', $('#frameBellDot').text());

    var b1 = beeps, s1 = spoken.length;
    NA.apply({ im: { unread: 4, peers: [{ empId: 2, name: '李明', deptName: '研发部', unread: 4,
        lastContent: '例会改了时间', lastTime: '2026-11-07 09:40:00' }] },
        mail: { configured: true, unread: 0, items: [] }, total: 4 }, { silent: false });
    check('轮询 / WS 重复拿到同一份快照 → 不再重复响',
        beeps === b1 && spoken.length === s1);
}, 200);

/* ---- 5. 开关记忆（关掉提示音 / 语音后不再响） ---- */
phase(function () {
    console.log('\n--- 5. 提示音 / 语音开关（写 localStorage 记忆）---');
    NA.state.lastAlertAt = 0;      // 清掉 1.2s 去重窗口（真实场景同一批只响一次）
    $('#frameBellVoice').prop('checked', false).trigger('change');
    check('关语音 → state.voiceOn=false 且写入偏好',
        NA.state.voiceOn === false &&
        JSON.parse(w.localStorage.getItem('menu_admin_notify_pref')).voice === 0);
    var s0 = spoken.length, b0 = beeps;
    NA.apply({ im: { unread: 6, peers: [{ empId: 2, name: '李明', unread: 6,
        lastContent: 'x', lastTime: '2026-11-07 09:41:00' }] },
        mail: { configured: true, unread: 0, items: [] }, total: 6 }, { silent: false });
    check('关语音后仍会提示音、但不再播报', beeps > b0 && spoken.length === s0,
        'beeps+' + (beeps - b0) + ' spoken+' + (spoken.length - s0));

    NA.state.lastAlertAt = 0;
    $('#frameBellSound').prop('checked', false).trigger('change');
    var b1 = beeps;
    NA.apply({ im: { unread: 8, peers: [{ empId: 2, name: '李明', unread: 8,
        lastContent: 'y', lastTime: '2026-11-07 09:42:00' }] },
        mail: { configured: true, unread: 0, items: [] }, total: 8 }, { silent: false });
    check('两个开关都关 → 完全静音（不播提示音）',
        beeps === b1 && NA.state.soundOn === false);
    check('偏好持久化（sound=0 / voice=0）',
        JSON.parse(w.localStorage.getItem('menu_admin_notify_pref')).sound === 0);
}, 200);

/* ---- 6. 清零：红点隐藏、菜单上标移除 ---- */
phase(function () {
    console.log('\n--- 6. 全部已读：红点隐藏 + 菜单上标移除 ---');
    NA.apply({ im: { unread: 0, peers: [] }, mail: { configured: true, unread: 0, items: [] },
        total: 0 }, { silent: true });
    check('铃铛红点隐藏', $('#frameBellDot').is('[hidden]'));
    check('即时对话菜单上标已移除',
        $('#frameMenu .frame-side__item[data-url="message.html"] .frame-nav-badge').length === 0);
    check('我的邮箱菜单上标已移除',
        $('#frameMenu .frame-side__item[data-url="emp-mail.html"] .frame-nav-badge').length === 0);
    NA.openPanel();
    check('面板空态提示（暂无未读对话 / 暂无未读邮件）',
        $('#frameBellBody').text().indexOf('暂无未读对话') > -1 &&
        $('#frameBellBody').text().indexOf('暂无未读邮件') > -1, $('#frameBellBody').text());
    NA.closePanel();
    check('stop() 清掉轮询与 socket（不残留定时器）',
        (NA.stop(), NA.state.pollTimer === null && NA.state.socket === null));
}, 150);

setTimeout(run, 400);
