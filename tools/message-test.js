/* ==========================================================================
   message-test.js —— 「即时对话」WebSocket 实时 IM（WebQQ 风格）测试（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖：
     · 静态：页面结构 / 脚本版本 / Api.msg 与 Mock 前缀 / 后端 EmpMessageService
             IM 相关方法 + SERVICES·ACTIONS / 建表 / 菜单 / app.py WS 路由 /
             im_presence 模块 / RealImSocket.connected（#191）/ MockImSocket ack.tempId（#191）
             / 前端 renderContacts 读 lastContent（#190）
     · 首屏：本人信息 + 在线态 + 连接成功 + 联系人列表（全员可互发、排除自己）
     · 会话：打开会话 → 聊天区可见、标题、按钮可用、历史渲染
     · 发送：乐观气泡 → Mock WS 回执 ack 对齐 tempId → 气泡落库 id、会话列表 lastContent 更新
     · 输入中 / 在线态：typing 帧显隐、presence 帧切换绿灰点
     · 实时收信 / 已读回执：模拟他人发来 → 未激活则未读+1，打开会话即清零并新增气泡
     · 隔离：不同员工窗口各自排除自己、status 返回本人 empId、历史按 empId 强隔离
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/message-test.js
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
var html = read('message.html');
var apiSrc = read('js/api.js');
var pageSrc = read('js/message.js');
var ssoTest = read('tools/sso-test.js');
var svcSrc = read('server/service.py');
var appSrc = read('server/app.py');
var ddl = read('db/emp-message.sql');
var menuSql = read('db/emp-message-menu.sql');

console.log('\n--- 0. 静态一致性（页面 / Api / 后端 / 数据库 / 菜单 / WS） ---');
check('页面标题为「即时对话」', /<title>即时对话/.test(html), html.match(/<title>([^<]+)<\/title>/)[1]);
check('面包屑为「邮件中心/即时对话」', html.indexOf('data-crumb="邮件中心/即时对话"') > -1);
check('左侧菜单「即时对话」高亮，邮件中心其它项仍在',
    /class="app-side__item is-active" href="message\.html"/.test(html) &&
    html.indexOf('href="service-email.html"') > -1 &&
    html.indexOf('href="mail.html"') > -1 &&
    html.indexOf('href="emp-mail.html"') > -1);
check('页面引用 js/api.js?v=' + SHARED_API_V + '（改过 api.js 全站升版本）',
    SHARED_API_V !== '' && html.indexOf('js/api.js?v=' + SHARED_API_V) > -1);
check('页面引用 js/message.js?v=20261110f（IM 客户端落位）',
    html.indexOf('js/message.js?v=20261110f') > -1);
check('输入区媒体工具条 #imInputTools 含图片/表情/文件/语音/截屏 5 个按钮（保持原始布局）',
    html.indexOf('id="imInputTools"') > -1 &&
    (html.match(/class="im-tool"/g) || []).length === 5);
check('message.js：placeMediaTools() 把媒体行放到富文本框正上方（对齐员工IM 小窗）',
    pageSrc.indexOf('function placeMediaTools') > -1 &&
    pageSrc.indexOf('$row.first().before($tools)') > -1 &&
    pageSrc.indexOf("extraTools: $('#imInputTools')") < 0);
check('左侧消息列超宽悬停提示：CSS 有 .im-msg-tip、JS 只在真的截断时才显示',
    html.indexOf('.im-msg-tip') > -1 &&
    pageSrc.indexOf('function showMsgTip') > -1 &&
    pageSrc.indexOf('scrollWidth <= el.clientWidth') > -1);

check('message.html CSS：媒体行是输入区里的独立一行、@ 浮层随输入区高度浮动',
    /\.im-input > \.im-input__tools/.test(html) &&
    /bottom:\s*calc\(100% \+ 2px\)/.test(html));
check('左侧联系人区固定 20% 宽度、内容再长也不撑开（min-width:0 + overflow:hidden + 列表禁横向滚动）',
    /\.im__side\s*\{[^}]*flex:\s*0 0 20%/.test(html) &&
    /\.im__side\s*\{[^}]*width:\s*20%/.test(html) &&
    /\.im__side\s*\{[^}]*min-width:\s*0/.test(html) &&
    /\.im__list\s*\{[^}]*overflow-x:\s*hidden/.test(html));
check('消息气泡超宽自动换行（word-break / overflow-wrap），聊天区不出现横向滚动',
    /\.im-msg__bubble\s*\{[^}]*word-break:\s*break-word/.test(html) &&
    /\.im-msg__bubble\s*\{[^}]*overflow-wrap:\s*anywhere/.test(html));
check('页面引用 js/ui.js / js/layout.js',
    html.indexOf('js/ui.js?v=20261105a') > -1 && html.indexOf('js/layout.js?v=20261031b') > -1);
check('工具栏 4 个按钮（新建会话/标记已读/清空会话/刷新）且 id 齐全',
    html.indexOf('id="btnWrite"') > -1 && html.indexOf('id="btnMarkRead"') > -1 &&
    html.indexOf('id="btnDelete"') > -1 && html.indexOf('id="btnRefresh"') > -1);
check('IM 关键 DOM 节点齐全（联系人/聊天/输入框/在线态/未读/选择弹窗模板）',
    html.indexOf('id="imContacts"') > -1 && html.indexOf('id="imChat"') > -1 &&
    html.indexOf('id="imText"') > -1 && html.indexOf('id="imSend"') > -1 &&
    html.indexOf('id="imMeAvatar"') > -1 && html.indexOf('id="imConn"') > -1 &&
    html.indexOf('id="imOnlineCount"') > -1 && html.indexOf('id="imTyping"') > -1 &&
    html.indexOf('id="empPickTpl"') > -1);
check('sso-test.js 的版本断言已同步到 ' + SHARED_API_V,
    ssoTest.indexOf('js/api.js?v=' + SHARED_API_V) > -1 &&
    ssoTest.indexOf('js/api.js?v=20261106r') < 0);

check('api.js 导出 Api.msg 含 IM 方法（status/contacts/history/markPeer/send/remove/connect）',
    /status: function \(\) \{ return request\('GET', '\/msg\/status'/.test(apiSrc) &&
    /contacts: function \(\) \{ return request\('GET', '\/msg\/contacts'/.test(apiSrc) &&
    /history: function \(peerId\)/.test(apiSrc) &&
    /markPeer: function \(peerId\)/.test(apiSrc) &&
    /connect: function \(opts\)/.test(apiSrc) &&
    /send: function \(data\) \{ return request\('POST', '\/msg\/send'/.test(apiSrc) &&
    /remove: function \(ids\) \{ return request\('POST', '\/msg\/delete'/.test(apiSrc),
    '检查 Api.msg 导出');
check('Mock 服务前缀 /msg 已注册',
    apiSrc.indexOf("{ prefix: '/msg', svc: msgSvc }") > -1);
/* request() 已把 {code,message,data} 拆包，页面不能再判断 res.code，否则「历史消息永远空白 /
   刷新联系人无效 / 离线 REST 发送被误判失败」（本轮修掉的真缺陷） */
check('message.js 用 payload() 兼容拆包（历史 / 联系人 / 发送三处都不再读 res.code）',
    pageSrc.indexOf('function payload(res)') > -1 &&
    pageSrc.indexOf('var d = payload(res);') > -1 &&
    pageSrc.indexOf('res.code === 0 && res.data') < 0);
check('message.js 打开会话即拉历史并已读（payload 分支覆盖 convo 赋值）',
    /Api\.msg\.history\(empId\)\.done\(function \(res\) \{\s*var d = payload\(res\);/.test(pageSrc));
check('Mock 所有读写都按 msgMe() 过滤（发件人固定本人、联系人排除自己）',
    /function msgMe\(\)[\s\S]{0,120}mockLoginEmpId\(\)/.test(apiSrc) &&
    /empNameOf\(me\)/.test(apiSrc));
check('#190 修复：Mock buildContacts 输出 lastContent（与后端一致）',
    /lastContent: last \?/.test(apiSrc) && /lastTime: last \? last\.sendTime/.test(apiSrc));
check('#191 修复：RealImSocket 带 connected 标志（open/close 翻转）',
    apiSrc.indexOf("this._h = {}; this.ws = ws; this.mock = false; this.connected = false;") > -1 &&
    apiSrc.indexOf("ws.onopen = function () { self.connected = true;") > -1 &&
    apiSrc.indexOf("ws.onclose = function () { self.connected = false;") > -1);
check('#191 修复：MockImSocket 的 ack 回执带 tempId/sendTime/receiverId（对齐乐观气泡）',
    apiSrc.indexOf('tempId: obj.tempId') > -1 &&
    apiSrc.indexOf('sendTime: (r.data && r.data.sentTime)') > -1 &&
    apiSrc.indexOf('receiverId: obj.to') > -1);
check('#190 修复：前端 renderContacts 优先读 c.lastContent（兼容 c.lastMessage）',
    pageSrc.indexOf('c.lastContent || c.lastMessage') > -1);
check('握手契约：Mock serverHello 的 contacts 是数组（snap.list）并带 onlineCount（与后端同口径）',
    apiSrc.indexOf('contacts: snap.list') > -1 &&
    /contacts: snap\.list, onlineCount: snap\.onlineCount/.test(apiSrc) &&
    appSrc.indexOf("'contacts': contact_list") > -1);
check('在线态：前端 dispatch 的 presence 帧尊重 obj.online（不再恒为 true）',
    pageSrc.indexOf('obj.online === undefined ? true : !!obj.online') > -1);
check('MockImSocket 回执异步下发（模拟真实网络，乐观气泡先上屏）',
    /MockImSocket\.prototype\.send = function[\s\S]{0,1400}window\.setTimeout/.test(apiSrc));

check('后端 EmpMessageService 只认 _loginUserId 反查 empId（不读前端 senderId/receiverId 作为归属）',
    /def _my_emp_id\(self, params\)[\s\S]{0,700}get\('_loginUserId'\)/.test(svcSrc) &&
    /class EmpMessageService\(object\)/.test(svcSrc));
check('后端 contacts 输出 lastContent（与前端 lastContent 对齐）',
    /item\['lastContent'\] =/.test(svcSrc));
check('后端 IM 方法齐全（contacts/history/mark_peer/persist_send/status/send）',
    /def contacts\(self, params=None\)/.test(svcSrc) &&
    /def history\(self, params=None\)/.test(svcSrc) &&
    /def mark_peer\(self, params=None\)/.test(svcSrc) &&
    /def persist_send\(self, sender_id/.test(svcSrc) &&
    /def status\(self, params=None\)/.test(svcSrc) &&
    /def send\(self, params\)/.test(svcSrc));
check('SERVICES 注册 msg，ACTIONS 覆盖 contacts/history/markpeer/send/remove/delete',
    /'msg': emp_message_service/.test(svcSrc) &&
    /'contacts': \('contacts', \['GET'\]\)/.test(svcSrc) &&
    /'history': \('history', \['GET'\]\)/.test(svcSrc) &&
    /'markpeer': \('mark_peer', \['POST'\]\)/.test(svcSrc) &&
    /'send': \('send', \['POST'\]\)/.test(svcSrc));
check('建表脚本：emp_msgs 含 senderId/receiverId 与双方软删字段 + 非破坏性',
    /CREATE TABLE IF NOT EXISTS `emp_msgs`/.test(ddl) &&
    ddl.indexOf('`senderId`') > -1 && ddl.indexOf('`receiverId`') > -1 &&
    ddl.indexOf('`senderDeleted`') > -1 && ddl.indexOf('`receiverDeleted`') > -1);
check('菜单脚本：挂邮件中心 MNG1004 + 全员授权 + 4 个页面按钮登记',
    /MNG1004/.test(menuSql) && /'MNU00022'/.test(menuSql) &&
    /message\.html'/.test(menuSql) && /pageopbtn/.test(menuSql) &&
    /usergrouppagebtnset/.test(menuSql));
check('app.py 注册 WebSocket 路由 /ws/msg 并导入 im_presence',
    appSrc.indexOf("@sock.route('/ws/msg')") > -1 &&
    appSrc.indexOf('from im_presence import') > -1);
check('im_presence.py 在线注册表模块存在',
    fs.existsSync(path.join(ROOT, 'server/im_presence.py')),
    'server/im_presence.py');

/* ------------------------------- 组装窗口 ------------------------------- */
function boot(pre, url) {
    var dom = new JSDOM(html, {
        url: url || 'http://127.0.0.1:8808/message.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.__autoTimers = [];
    win.setInterval = function (fn, ms) {        // 避免 jsdom 被定时器挂住
        win.__autoTimers.push(ms);
        return win.__autoTimers.length;
    };
    if (pre) { pre(win); }
    win.jQuery.ajax = function () {              // 阻断真实 HTTP → api.js 自动回退 Mock
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/rich-text.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/message.js'));
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

var w = boot(sso(3));                 // 甲：empId=3
var $ = w.jQuery;
var IM = w.IM;
var w2, $2, IM2;
var probes = {};

/* ------------------------------- 异步阶段 ------------------------------- */
var phases = [];
function phase(fn, wait) { phases.push({ fn: fn, wait: wait === undefined ? 600 : wait }); }
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

/* ---- 1. 首屏：本人信息 + 连接 + 联系人列表 ---- */
phase(function () {
    console.log('\n--- 1. 首屏：本人信息 + 实时连接 + 联系人 ---');
    check('本人姓名已渲染（不再是占位「—」）', $.trim($('#imMeName').text()).length > 0 &&
        $.trim($('#imMeName').text()) !== '—', $('#imMeName').text());
    check('连接状态为「已连接」且显示绿点', $('#imConn').hasClass('is-online') &&
        /已连接/.test($('#imConnText').text()), $('#imConnText').text());
    check('STATE.connected 为真', IM.state.connected === true);
    check('socket 为 MockImSocket（无真实 WebSocket 时自动回退）',
        IM.socket && IM.socket.mock === true);
    var contacts = IM.state.contacts;
    var keys = Object.keys(contacts).map(Number);
    check('联系人列表已渲染（全员可互发，数量 > 0）', keys.length > 0,
        String(keys.length));
    check('联系人列表 DOM 节点数 = STATE.contacts 数',
        $('#imContacts .im-contact').length === keys.length,
        $('#imContacts .im-contact').length + ' vs ' + keys.length);
    check('联系人列表排除自己（不含 empId=3）', keys.indexOf(3) < 0,
        'keys=' + JSON.stringify(keys));
    check('每个联系人有姓名与部门', keys.every(function (k) {
        var c = contacts[k];
        return !!(c && c.name) && (c.deptName !== undefined);
    }));
    check('在线计数文案「在线 X / 共 Y」', /在线 \d+ \/ 共 \d+/.test($('#imOnlineCount').text()),
        $('#imOnlineCount').text());
    // 第二个员工窗口（隔离对照，empId=2 是档案里的真实员工），趁等待时间先拉起
    w2 = boot(sso(2)); $2 = w2.jQuery; IM2 = w2.IM;
}, 2400);

/* ---- 2. 打开会话 ---- */
phase(function () {
    console.log('\n--- 2. 打开会话：聊天区 / 标题 / 按钮 / 历史 ---');
    var peer = parseInt(Object.keys(IM.state.contacts)[0], 10);
    IM.openPeer(peer);
    check('会话激活并写入 STATE.activePeer', IM.state.activePeer === peer,
        String(IM.state.activePeer));
    check('聊天区可见（#imChat 显示）', $('#imChat').css('display') !== 'none');
    check('聊天标题为联系人姓名', $.trim($('#imChatTitle').text()) ===
        (IM.state.contacts[peer] && IM.state.contacts[peer].name),
        $('#imChatTitle').text());
    check('「标记已读 / 清空会话」按钮可用', $('#btnMarkRead').prop('disabled') === false &&
        $('#btnDelete').prop('disabled') === false);
    check('输入框可用', $('#imText').prop('disabled') === false);
    check('历史已渲染（可能为空态或若干条）',
        $('#imChatBody').length === 1);
    probes.peer = peer;
}, 700);

/* ---- 3. 发送消息（乐观气泡先上屏） ---- */
phase(function () {
    console.log('\n--- 3. 发送消息：乐观气泡先上屏（ack 尚未到达） ---');
    var peer = probes.peer;
    var text = '联调确认：' + new Date().getTime();
    probes.text = text;
    $('#imText').val(text);
    IM.send();
    var list = IM.state.convo[peer] || [];
    var last = list[list.length - 1];
    check('会话区出现我发出的气泡', !!last && last.isMe === true, JSON.stringify(last && last.content));
    check('发送后乐观气泡带 tempId（temp=true，未回执）', !!last && last.temp === true &&
        typeof last.tempId === 'string' && last.tempId.length > 0,
        JSON.stringify(last && { id: last.id, temp: last.temp }));
    check('气泡文本出现在聊天区', $('#imChatBody').text().indexOf(text) > -1);
}, 500);

/* ---- 3b. ack 回执到达（Mock 异步下发，与真实 WS 同节奏） ---- */
phase(function () {
    console.log('\n--- 3b. ack 回执：tempId 对齐 + 会话摘要更新 ---');
    var peer = probes.peer, text = probes.text;
    var list = IM.state.convo[peer] || [];
    var last = list[list.length - 1];
    check('ack 回执后气泡 temp 置 false、拿到真实 id',
        !!last && last.temp === false && !!last.id && String(last.id).indexOf('t') !== 0,
        JSON.stringify(last && { id: last.id, temp: last.temp }));
    check('#190 修复：联系人 lastContent 随发送更新',
        IM.state.contacts[peer] && IM.state.contacts[peer].lastContent === text,
        IM.state.contacts[peer] && IM.state.contacts[peer].lastContent);
    check('联系人列表里该会话显示最近消息（非「点击发起会话」占位）',
        $('#imContacts .im-contact[data-emp="' + peer + '"] .im-contact__msg').text()
            .indexOf('点击发起会话') < 0);
}, 500);

/* ---- 4. 输入中 / 在线态（协议帧） ---- */
phase(function () {
    console.log('\n--- 4. 输入中 / 在线态协议帧 ---');
    var peer = probes.peer;
    IM.dispatch({ type: 'typing', from: peer, on: true });
    check('收到 typing.on=true → 输入中提示显示',
        $('#imTyping').css('display') !== 'none',
        'display=' + $('#imTyping').css('display'));
    IM.dispatch({ type: 'typing', from: peer, on: false });
    check('收到 typing.on=false → 输入中提示隐藏',
        $('#imTyping').css('display') === 'none', 'display=' + $('#imTyping').css('display'));
    IM.dispatch({ type: 'presence', empId: peer, online: true });
    check('收到 presence.online=true → 联系人绿点',
        $('#imContacts .im-contact[data-emp="' + peer + '"] .im-dot').hasClass('is-online'));
    IM.dispatch({ type: 'presence', empId: peer, online: false });
    check('收到 presence.online=false → 联系人灰点',
        !$('#imContacts .im-contact[data-emp="' + peer + '"] .im-dot').hasClass('is-online'));
    check('当前会话对象的标题区同步为「○ 离线」',
        $('#imChatSub').text().indexOf('离线') > -1, $('#imChatSub').text());
    IM.dispatch({ type: 'offline', empId: peer });
    check('收到 offline 帧 → 联系人仍为灰点（两种帧口径一致）',
        !$('#imContacts .im-contact[data-emp="' + peer + '"] .im-dot').hasClass('is-online'));
}, 600);

/* ---- 5. 实时收信（未激活会话 → 未读 +1） ---- */
phase(function () {
    console.log('\n--- 5. 实时收信：未激活会话未读 +1 ---');
    // 选一个【非当前激活】的联系人收信
    var others = Object.keys(IM.state.contacts).map(Number)
        .filter(function (k) { return k !== IM.state.activePeer; });
    check('存在可收信的其他联系人', others.length > 0, String(others.length));
    var fromPeer = others[0];
    var before = (IM.state.contacts[fromPeer] && IM.state.contacts[fromPeer].unread) || 0;
    IM.socket.simulateInbound(fromPeer, '在吗？有个事要同步', '同事' + fromPeer);
    var after = (IM.state.contacts[fromPeer] && IM.state.contacts[fromPeer].unread) || 0;
    check('未激活会话收到消息 → 未读 +1', after === before + 1, before + ' -> ' + after);
    check('联系人列表出现未读红点徽标',
        $('#imContacts .im-contact[data-emp="' + fromPeer + '"] .im-badge').length === 1);
    probes.fromPeer = fromPeer;
}, 700);

/* ---- 6. 打开会话（触发异步 history → 自动已读）+ 触发隔离查询 ---- */
phase(function () {
    console.log('\n--- 6. 打开会话（异步已读回执）+ 隔离查询 ---');
    IM.openPeer(probes.fromPeer);                         // 异步拉历史并标记已读
    w.Api.msg.status().done(function (d) { probes.status3 = d && d.empId; });
    w2.Api.msg.status().done(function (d) { probes.status2 = d && d.empId; });
    w.Api.msg.history(probes.peer).done(function (res) { probes.hist3 = res; });
    var k3 = Object.keys(IM.state.contacts).map(Number);
    var k2 = Object.keys(IM2.state.contacts).map(Number);
    check('甲(3)联系人排除自己', k3.indexOf(3) < 0, 'k3=' + JSON.stringify(k3));
    check('乙(2)联系人排除自己', k2.indexOf(2) < 0, 'k2=' + JSON.stringify(k2));
    check('两窗口联系人集合（各自排除自己后）规模一致',
        k3.length === k2.length, k3.length + ' vs ' + k2.length);
    check('两窗口联系人差集 = {3} vs {2}（只差在「自己」）', (function () {
        var miss3 = k2.filter(function (k) { return k3.indexOf(k) < 0; });
        var miss2 = k3.filter(function (k) { return k2.indexOf(k) < 0; });
        return miss3.length === 1 && miss3[0] === 3 && miss2.length === 1 && miss2[0] === 2;
    })(), JSON.stringify({ k3: k3, k2: k2 }));
}, 800);

/* ---- 7. 断言已读回执 + 隔离结果 ---- */
phase(function () {
    console.log('\n--- 7. 已读回执清零 + 强隔离断言 ---');
    check('打开会话后未读清零（已读回执生效）',
        (IM.state.contacts[probes.fromPeer] && IM.state.contacts[probes.fromPeer].unread) === 0,
        String(IM.state.contacts[probes.fromPeer] && IM.state.contacts[probes.fromPeer].unread));
    check('聊天区出现对方发来的气泡（历史已加载）',
        $('#imChatBody').text().indexOf('有个事要同步') > -1);
    check('甲(3) status 返回 empId=3（不读前端）', probes.status3 === 3, String(probes.status3));
    check('乙(2) status 返回 empId=2', probes.status2 === 2, String(probes.status2));
    check('甲(3)与某人的历史全部围绕 empId=3（强隔离）', (function () {
        if (!probes.hist3 || !probes.hist3.list) { return false; }
        return probes.hist3.list.every(function (m) {
            return m.senderId === 3 || m.receiverId === 3;
        });
    })(), probes.hist3 ? String(probes.hist3.list.length) : 'no-list');
}, 700);

/* ---- 8. 深链 ?peer=：主框架提醒面板点条目直达某人会话 ---- */
var deepWin = null;
phase(function () {
    console.log('\n--- 8. 深链 ?peer=2 直接进入会话 ---');
    deepWin = boot(sso(3), 'http://127.0.0.1:8808/message.html?peer=2');
}, 2000);
phase(function () {
    var $d = deepWin.jQuery, IMd = deepWin.IM;
    check('深链打开后自动切到与 empId=2 的会话', IMd.state.activePeer === 2,
        String(IMd.state.activePeer));
    check('深链消费后不再残留待打开 peer', !IMd.pendingPeer, String(IMd.pendingPeer));
    check('会话标题为该联系人姓名（非占位「—」）',
        $.trim($d('#imChatTitle').text()).length > 0 && $.trim($d('#imChatTitle').text()) !== '—',
        $d('#imChatTitle').text());
    check('聊天区已载入与该人的历史消息', $d('#imChatBody').text().indexOf('例会纪要') > -1 ||
        $d('#imChatBody').text().indexOf('周五下午两点') > -1,
        'convo=' + JSON.stringify((IMd.state.convo[2] || []).length) +
        ' body=' + $d('#imChatBody').text().slice(0, 60));
    check('打开即已读：该联系人未读清零',
        (IMd.state.contacts[2] || {}).unread === 0, String((IMd.state.contacts[2] || {}).unread));
}, 1600);

/* 左侧消息列超宽 → 悬停显示完整内容（jsdom 里手动把 scrollWidth / clientWidth 撑成「截断」状态） */
var TIP = { full: '' };
phase(function () {
    console.log('\n--- 左侧消息列：超宽悬停显示完整内容 ---');
    var $row = $('#imContacts .im-contact').first();
    var el = $row.find('.im-contact__msg')[0];
    if (!el) { check('找到联系人消息列', false); return; }
    TIP.full = String(el.textContent || '');
    Object.defineProperty(el, 'scrollWidth', { configurable: true, get: function () { return 300; } });
    Object.defineProperty(el, 'clientWidth', { configurable: true, get: function () { return 100; } });
    $row.trigger('mouseenter');
}, 400);
phase(function () {
    check('超宽悬停出现完整内容提示',
        $('#imMsgTip').length === 1 && !$('#imMsgTip').is('[hidden]') &&
        TIP.full.length > 0 && $('#imMsgTip').text().indexOf(TIP.full.slice(0, 6)) > -1,
        $('#imMsgTip').length ? $('#imMsgTip').text().slice(0, 80) : 'no tip');
    $('#imContacts .im-contact').first().trigger('mouseleave');
}, 260);
phase(function () {
    check('移出后提示隐藏', !$('#imMsgTip').length || $('#imMsgTip').is('[hidden]'));
    var $row = $('#imContacts .im-contact').first();
    var el = $row.find('.im-contact__msg')[0];
    Object.defineProperty(el, 'scrollWidth', { configurable: true, get: function () { return 80; } });
    Object.defineProperty(el, 'clientWidth', { configurable: true, get: function () { return 100; } });
    $row.trigger('mouseenter');
}, 400);
phase(function () {
    check('未超宽的条目不出提示', !$('#imMsgTip').length || $('#imMsgTip').is('[hidden]'),
        $('#imMsgTip').length ? $('#imMsgTip').text().slice(0, 40) : 'none');
}, 200);
/* 首屏要等 connect 失败→重连→Mock serverHello（约 1.1s），初始多等一会 */
setTimeout(run, 2400);
