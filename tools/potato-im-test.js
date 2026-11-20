/* ==========================================================================
   potato-im-test.js —— 右侧「员工IM」抽屉（通讯录）测试（jsdom，Api 打桩）
   --------------------------------------------------------------------------
   定位：这个窗口只有「联系人 / 群组」名单，**没有会话消息列表、没有发消息框**；
        点条目 → 关抽屉 → 在框架 Tab 打开 message.html?peer=/?group=。
   覆盖：
     · 加载：start() 拉联系人 + 群组；默认联系人视图；只有两个标签
     · 展示：在线点 / 未读角标 / 最近一条 / 群成员数
     · 检索：姓名·部门过滤，清空恢复
     · 跳转：点联系人 → message.html?peer=1；点群 → message.html?group=G1；并关抽屉
     · 实时：presence 更新在线点；msg 帧让对应条目未读 +1
     · 结构：面板里不存在 piChat / piInput / piSend（无会话区、无输入框）
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/potato-im-test.js
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
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
/** 等到条件成立（避免用固定 sleep 等异步接口，慢机器/管道下会偶发不够） */
function until(cond, ms) {
    var deadline = Date.now() + (ms || 2000);
    return new Promise(function (resolve) {
        (function tick() {
            var ok = false;
            try { ok = !!cond(); } catch (e) { ok = false; }
            if (ok || Date.now() > deadline) { resolve(ok); return; }
            setTimeout(tick, 10);
        })();
    });
}

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

var CONTACTS = [
    { empId: 1, name: '赵建民', deptId: 11, deptName: '医疗大数据库', online: true, unread: 2,
        lastContent: '888 对', lastTime: '2026-11-07 10:30' },
    { empId: 2, name: '李四', deptId: 10, deptName: '研发中心', online: false, unread: 0 },
    { empId: 3, name: '王五', deptId: 20, deptName: '财务部', online: true, unread: 0 }
];
var GROUPS = [
    { groupId: 'G1', name: '项目群', memberCount: 3, unread: 1, isOwner: true,
        lastContent: '早上好', lastTime: '2026-11-07 09:00', lastSenderName: '李四' },
    { groupId: 'G2', name: '别人的群', memberCount: 2, unread: 0, isOwner: false }
];

var HISTORY = {
    1: [
        { id: 11, senderId: 1, content: '888 对', sendTime: '10:30', isMe: false, msgType: 'text' },
        { id: 12, senderId: 29, content: '收到', sendTime: '10:31', isMe: true, msgType: 'text', read: 1 }
    ],
    gG1: [
        { id: 21, senderId: 2, senderName: '李四', content: '早上好', sendTime: '09:00', isMe: false, msgType: 'text' }
    ]
};

(async function () {
    var dom = new JSDOM(read('main.html'), {
        url: 'http://127.0.0.1:8808/main.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    var $ = win.jQuery;

    /* -------------------------- 打桩 -------------------------- */
    var CALLS = { contacts: 0, groups: 0, groupAdd: [], groupUpdate: [], history: [], markPeer: [], markGroup: 0, upload: [], empDetail: [], groupDetail: [] };
    var SENT = [];
    var HANDLERS = {};
    var SOCKET = {
        connected: true,
        on: function (ev, fn) { (HANDLERS[ev] = HANDLERS[ev] || []).push(fn); },
        send: function (obj) { SENT.push(obj); },
        close: function () { }
    };
    function deferredResolve(value) {
        var d = $.Deferred();
        setTimeout(function () { d.resolve(value); }, 0);
        return d.promise();
    }
    // 模拟真实接口：每次返回全新对象（面板会就地改未读数，共用同一份会互相污染）
    function clone(v) { return JSON.parse(JSON.stringify(v)); }
    win.Api = {
        msg: {
            contacts: function () {
                CALLS.contacts++;
                return deferredResolve({ list: clone(CONTACTS), me: { empId: 29, name: '我' } });
            },
            groups: function () {
                CALLS.groups++;
                return deferredResolve({ list: clone(GROUPS) });
            },
            groupAdd: function (data) {
                CALLS.groupAdd.push(data);
                return deferredResolve({
                    groupId: 'G9',
                    name: data.groupName || '自动生成的群名',
                    memberCount: (data.memberIds || []).length + 1
                });
            },
            groupUpdate: function (data) {
                CALLS.groupUpdate.push(data);
                return deferredResolve({ ok: 1 });
            },
            history: function (peerId) {
                CALLS.history.push(peerId);
                return deferredResolve({ list: clone(HISTORY[peerId] || []), peer: { online: true } });
            },
            groupHistory: function (groupId) {
                return deferredResolve({ list: clone(HISTORY['g' + groupId] || []), group: { memberCount: 3, name: '项目群' } });
            },
            markPeer: function (peerId) {
                CALLS.markPeer.push(peerId);
                return deferredResolve({ ok: 1 });
            },
            markGroup: function () {
                CALLS.markGroup++;
                return deferredResolve({ ok: 1 });
            },
            send: function (data) {
                return deferredResolve({ ids: [77], sentTime: '18:00' });
            },
            upload: function (data) {
                CALLS.upload.push(data);
                return deferredResolve({
                    fileId: 'F1', name: data.fileName, url: '/data/imfiles/x/' + data.fileName,
                    size: 12, kind: data.kind, ext: 'txt', mimeType: 'text/plain'
                });
            },
            emojis: function () {
                return deferredResolve({ list: [{ id: 1, fileId: 'E1', name: '笑', url: '/x.png', width: 64, height: 64 }] });
            },
            groupDetail: function (gid) {
                CALLS.groupDetail.push(gid);
                return deferredResolve({
                    name: '项目群', memberCount: 3, ownerId: 1,
                    members: [
                        { empId: 1, name: '赵建民', deptName: '前端组' },
                        { empId: 2, name: '李四', deptName: '研发中心' },
                        { empId: 29, name: '我', deptName: '' }
                    ]
                });
            },
            connect: function () { return SOCKET; }
        },
        emp: {
            detail: function (id) {
                CALLS.empDetail.push(id);
                return deferredResolve({
                    nameCn: '赵建民', code: 'E00001', deptName: '前端组', jobTitle: '工程师',
                    phone: '13800000000', email: 'z@example.com', statusText: '在职'
                });
            }
        },
        org: {
            tree: function () {
                CALLS.org = (CALLS.org || 0) + 1;
                return deferredResolve({
                    list: [
                        { id: 10, nameCn: '研发中心', parentId: 0 },
                        { id: 11, nameCn: '前端组', parentId: 10 },
                        { id: 20, nameCn: '财务部', parentId: 0 }
                    ]
                });
            }
        }
    };
    var NAV = [], CLOSED = 0;
    win.AppFrame = { navigate: function (u) { NAV.push(u); } };
    win.AppPotato = { closeIm: function () { CLOSED++; } };

    win.eval(read('js/rich-text.js'));
    win.eval(read('js/potato-im.js'));
    var IM = win.PotatoIM;
    var $list = $('#piList');

    /* -------------------------- 1. 加载 / 两个标签 -------------------------- */
    console.log('--- 1. 加载 / 两个标签 / 默认视图 ---');
    IM.start();
    await until(function () {
        return $list.find('.pi-item').length === 3 &&
            Object.keys(IM.state.groups).length === 2;      // 等群组数据真正回来，不只是等接口被调
    });
    check('start() 拉取联系人 + 群组并建立连接', CALLS.contacts === 1 && CALLS.groups === 1 &&
        (HANDLERS.message || []).length === 1);
    check('面板里没有会话消息列表、没有输入框',
        $('#piChat').length === 0 && $('#piChatBody').length === 0 &&
        $('#piInput').length === 0 && $('#piSend').length === 0);
    check('只有「联系人 / 群组」两个标签', $('.pi-tab').length === 2 &&
        $('.pi-tab[data-tab="chat"]').length === 0);
    check('默认进入「联系人」视图，列出全部同事（3 条）', $list.find('.pi-item').length === 3,
        'items=' + $list.find('.pi-item').length);
    check('联系人按组织架构分组（3 个部门头）', $list.find('.pi-dept').length === 3,
        'depts=' + $list.find('.pi-dept').length);
    var order = [];
    $list.children().each(function () {
        if ($(this).hasClass('pi-dept')) {
            order.push('D:' + $(this).find('.pi-dept__name').text());
        } else {
            order.push('P:' + $(this).find('.pi-item__name').text());
        }
    });
    check('部门按树形顺序、人员在所属部门之下',
        order.join('|') === 'D:研发中心|P:李四|D:前端组|P:赵建民|D:财务部|P:王五', order.join('|'));
    check('未读角标显示（赵建民 2 条）', $list.find('.pi-item[data-id="1"] .pi-badge').text() === '2');
    check('在线态渲染（赵建民有在线点）',
        $list.find('.pi-item[data-id="1"] .pi-dot.is-online').length === 1);
    check('条目第二行显示最近一条 + 部门',
        $list.find('.pi-item[data-id="1"] .pi-item__msg').text().indexOf('888 对') > -1 &&
        $list.find('.pi-item[data-id="1"] .pi-item__msg').text().indexOf('医疗大数据库') > -1);

    /* -------------------------- 1.1 标签红点 -------------------------- */
    check('标签红点：联系人合计 2 条未读',
        $('#piUnreadContact').text() === '2' && !$('#piUnreadContact').is('[hidden]'),
        $('#piUnreadContact').text());
    check('标签红点：群组合计 1 条未读',
        $('#piUnreadGroup').text() === '1' && !$('#piUnreadGroup').is('[hidden]'),
        $('#piUnreadGroup').text());

    /* -------------------------- 2. 检索 -------------------------- */
    console.log('\n--- 2. 检索 ---');
    $('#piSearch').val('研发').trigger('input');
    check('按部门过滤（研发 → 李四）', $list.find('.pi-item').length === 1 &&
        $list.text().indexOf('李四') > -1);
    $('#piSearch').val('不存在的人').trigger('input');
    check('无匹配时给空态提示', $list.find('.pi-item').length === 0 &&
        $list.text().indexOf('没有匹配的结果') > -1);
    $('#piSearch').val('').trigger('input');
    check('清空检索恢复全部', $list.find('.pi-item').length === 3);

    /* -------------------------- 3. 群组标签 -------------------------- */
    console.log('\n--- 3. 群组标签 ---');
    $('.pi-tab[data-tab="group"]').trigger('click');
    check('「群组」视图列出我加入的群（2 条）', $list.find('.pi-item').length === 2);
    check('群条目带「群聊 · N 人」且显示发送人与内容',
        $list.text().indexOf('群聊 · 3 人') > -1 && $list.text().indexOf('李四：早上好') > -1);
    check('群主才显示改名铅笔（G1 有、G2 无）',
        $list.find('.pi-item[data-id="G1"] .pi-item__rename').length === 1 &&
        $list.find('.pi-item[data-id="G2"] .pi-item__rename').length === 0);

    /* -------------------------- 4. 单击只选中（不跳页面） -------------------------- */
    console.log('\n--- 4. 单击只选中（不再跳即时对话页） ---');
    $list.find('.pi-item[data-id="G1"]').trigger('click');
    await wait(320);
    check('单击群条目：只高亮选中，不跳页面、不开小窗',
        $list.find('.pi-item[data-id="G1"]').hasClass('is-active') &&
        NAV.length === 0 && CLOSED === 0 && IM.isChatOpen() === false,
        'nav=' + NAV.length + ' closed=' + CLOSED);

    $('.pi-tab[data-tab="contact"]').trigger('click');
    $list.find('.pi-item[data-id="1"]').trigger('click');
    await wait(320);
    check('单击联系人：只高亮选中，不跳页面',
        $list.find('.pi-item[data-id="1"]').hasClass('is-active') &&
        NAV.length === 0 && CLOSED === 0, 'nav=' + NAV.length);

    /* -------------------------- 5. 实时提示 -------------------------- */
    console.log('\n--- 5. 实时（只刷在线态与未读） ---');
    (HANDLERS.message || []).forEach(function (fn) {
        fn({ type: 'presence', empId: 2, online: true });
    });
    await wait(10);
    check('presence 帧更新在线点', $list.find('.pi-item[data-id="2"] .pi-dot.is-online').length === 1);

    (HANDLERS.message || []).forEach(function (fn) {
        fn({ type: 'msg', id: 101, senderId: 3, content: '在吗', sendTime: '11:12', msgType: 'text' });
    });
    await wait(10);
    check('收到消息 → 对应联系人未读 +1', $list.find('.pi-item[data-id="3"] .pi-badge').text() === '1');
    check('收到消息 → 条目第二行显示最新内容',
        $list.find('.pi-item[data-id="3"] .pi-item__msg').text().indexOf('在吗') > -1);

    (HANDLERS.message || []).forEach(function (fn) {
        fn({ type: 'msg', id: 102, senderId: 1, groupId: 'G1', senderName: '赵建民', content: '开会了', sendTime: '11:13', msgType: 'text' });
    });
    await wait(10);
    $('.pi-tab[data-tab="group"]').trigger('click');
    check('群消息 → 群条目未读 +1 且显示「发送人：内容」',
        $list.find('.pi-item[data-id="G1"] .pi-badge').text() === '2' &&
        $list.text().indexOf('赵建民：开会了') > -1);

    check('标签红点跟着变：群组 2 / 联系人 3',
        $('#piUnreadGroup').text() === '2' && $('#piUnreadContact').text() === '3',
        'g=' + $('#piUnreadGroup').text() + ' c=' + $('#piUnreadContact').text());

    IM.open();                                   // 重新打开抽屉 → 重新同步未读
    await until(function () { return $('#piUnreadGroup').text() === '1'; });
    check('重新打开抽屉会同步未读（红点回到 群 1 / 联 2）',
        $('#piUnreadGroup').text() === '1' && $('#piUnreadContact').text() === '2',
        'g=' + $('#piUnreadGroup').text() + ' c=' + $('#piUnreadContact').text());

    console.log('\n--- 6. 创建群组 / 群组重命名 ---');
    $('#piNewGroup').trigger('click');
    check('点 ＋ 打开「创建群组」弹窗',
        !$('#piModal').is('[hidden]') && $('#piModalTitle').text() === '创建群组');
    check('成员列表列出全部同事（3 人）', $('#piPickList .pi-pick__item').length === 3);

    $('#piModalOk').trigger('click');
    check('一个都没选 → 报错且不发请求',
        $('#piModalErr').text().indexOf('至少选择') > -1 && CALLS.groupAdd.length === 0);

    $('#piMemberSearch').val('研发').trigger('input');
    check('弹窗内检索成员（研发 → 1 人）', $('#piPickList .pi-pick__item').length === 1);
    $('#piMemberSearch').val('').trigger('input');

    $('#piPickList .pi-pick__item[data-emp="1"]').trigger('click');
    $('#piPickList .pi-pick__item[data-emp="3"]').trigger('click');
    check('勾选人数联动（已选 2）', $('#piPickCount').text() === '2');

    $('#piGroupName').val('测试群');
    var groupsBefore = CALLS.groups;
    $('#piModalOk').trigger('click');
    await until(function () { return CALLS.groupAdd.length === 1 && $('#piModal').is('[hidden]'); });
    check('创建请求带群名与成员 ID',
        CALLS.groupAdd.length === 1 && CALLS.groupAdd[0].groupName === '测试群' &&
        CALLS.groupAdd[0].memberIds.join(',') === '1,3',
        JSON.stringify(CALLS.groupAdd[0] || {}));
    check('创建成功 → 关弹窗 + 切到群组标签 + 刷新群列表',
        $('#piModal').is('[hidden]') && $('.pi-tab[data-tab="group"]').hasClass('is-active') &&
        CALLS.groups === groupsBefore + 1);
    check('创建成功 → 抽屉内给提示', $('#piToast').text().indexOf('群创建成功') > -1);

    // 改名（仅群主）
    $('.pi-tab[data-tab="group"]').trigger('click');
    $list.find('.pi-item[data-id="G1"] .pi-item__rename').trigger('click');
    check('点铅笔打开「重命名群组」并回填当前群名',
        !$('#piModal').is('[hidden]') && $('#piModalTitle').text() === '重命名群组' &&
        $('#piRenameInput').val() === '项目群');

    $('#piRenameInput').val('   ');
    $('#piModalOk').trigger('click');
    check('群名为空 → 报错且不发请求',
        $('#piModalErr').text().indexOf('不能为空') > -1 && CALLS.groupUpdate.length === 0);

    $('#piRenameInput').val('新项目群');
    $('#piModalOk').trigger('click');
    await until(function () { return CALLS.groupUpdate.length === 1 && $('#piModal').is('[hidden]'); });
    check('改名请求带 groupId 与新群名',
        CALLS.groupUpdate.length === 1 && CALLS.groupUpdate[0].groupId === 'G1' &&
        CALLS.groupUpdate[0].groupName === '新项目群',
        JSON.stringify(CALLS.groupUpdate[0] || {}));
    check('改名成功 → 关弹窗 + 提示', $('#piModal').is('[hidden]') &&
        $('#piToast').text().indexOf('群名称已更新') > -1);

    console.log('\n--- 7. 弹窗状态（Esc 用） ---');
    $('#piNewGroup').trigger('click');
    check('isModalOpen() 反映弹窗状态', IM.isModalOpen() === true);
    IM.closeModal();
    check('closeModal() 收起弹窗', $('#piModal').is('[hidden]') && IM.isModalOpen() === false);

    console.log('\n--- 8. 双击 → 就地弹出即时对话小窗 ---');
    $('.pi-tab[data-tab="contact"]').trigger('click');
    await wait(320);                                   // 与上一次单击拉开，避免误判双击
    var navBefore = NAV.length;
    $list.find('.pi-item[data-id="1"]').trigger('click');
    $list.find('.pi-item[data-id="1"]').trigger('click');
    check('双击联系人 → 打开小窗，且没有跳转页面',
        IM.isChatOpen() === true && NAV.length === navBefore);
    check('小窗标题 / 在线状态正确',
        $('#piChatWinTitle').text() === '赵建民' && $('#piChatWinSub').text().indexOf('在线') > -1);

    await until(function () { return $('#piChatWinBody .pi-msg').length === 2; });
    check('小窗拉历史并上屏（2 条，其中 1 条是自己）',
        $('#piChatWinBody .pi-msg').length === 2 &&
        $('#piChatWinBody .pi-msg.is-me').length === 1);
    check('拉历史走 Api.msg.history(peerId)', CALLS.history.join(',') === '1');
    check('打开小窗即标记已读（markPeer + WS read）',
        CALLS.markPeer.join(',') === '1' &&
        SENT.some(function (s) { return s.type === 'read' && s.peerId === 1; }));
    check('打开小窗清未读（联系人标签红点消失）', $('#piUnreadContact').is('[hidden]'));

    $('#piChatWinInput').val('小窗里发的');
    $('#piChatWinSend').trigger('click');
    var sendFrame = SENT.filter(function (s) { return s.type === 'send'; })[0];
    check('小窗发送走 WS（to/content/tempId 齐全）',
        !!sendFrame && sendFrame.to === 1 && sendFrame.content === '小窗里发的' && !!sendFrame.tempId,
        JSON.stringify(sendFrame || {}));
    check('乐观气泡立刻显示「发送中…」',
        $('#piChatWinBody').text().indexOf('发送中') > -1 && $('#piChatWinInput').val() === '');

    (HANDLERS.message || []).forEach(function (fn) {
        fn({ type: 'ack', tempId: sendFrame.tempId, id: 200, sendTime: '18:00', receiverId: 1 });
    });
    await wait(10);
    check('收到 ack → 变「已发送」',
        $('#piChatWinBody').text().indexOf('已发送') > -1 &&
        $('#piChatWinBody').text().indexOf('发送中') === -1);

    var beforeCount = $('#piChatWinBody .pi-msg').length;
    (HANDLERS.message || []).forEach(function (fn) {
        fn({ type: 'msg', id: 201, senderId: 1, content: '收到', sendTime: '18:01', msgType: 'text' });
    });
    await wait(10);
    check('小窗开着时对方消息直接上屏', $('#piChatWinBody .pi-msg').length === beforeCount + 1);
    check('小窗开着时对方消息不计未读', $('#piUnreadContact').is('[hidden]'));

    IM.closeChat();
    check('关闭小窗（Esc/× 走同一个 closeChat）',
        IM.isChatOpen() === false && $('#piChatWin').is('[hidden]'));

    // 群：双击同样弹窗（不等未读）
    await wait(320);
    $('.pi-tab[data-tab="group"]').trigger('click');
    $list.find('.pi-item[data-id="G1"]').trigger('click');
    $list.find('.pi-item[data-id="G1"]').trigger('click');
    await until(function () { return $('#piChatWinBody .pi-msg').length === 1; });
    check('双击群 → 小窗显示群名与成员数，历史带发送人',
        IM.isChatOpen() === true && $('#piChatWinTitle').text() === '项目群' &&
        $('#piChatWinSub').text().indexOf('3 位成员') > -1 &&
        $('#piChatWinBody .pi-msg__from').text() === '李四');
    IM.closeChat();

    console.log('\n--- 9. 小窗尺寸 / 最大化 / 表情 / 文件 ---');
    $('.pi-tab[data-tab="contact"]').trigger('click');
    await wait(320);
    $list.find('.pi-item[data-id="2"]').trigger('click');
    $list.find('.pi-item[data-id="2"]').trigger('click');
    await until(function () { return IM.isChatOpen() === true; });

    check('最大化按钮：切 is-max + 标题在「最大化/还原」间切换', (function () {
        $('#piChatWinMax').trigger('click');
        var on = $('#piChatWin').hasClass('is-max') && $('#piChatWinMax').attr('title') === '还原';
        $('#piChatWinMax').trigger('click');
        var off = !$('#piChatWin').hasClass('is-max') && $('#piChatWinMax').attr('title') === '最大化';
        return on && off;
    })());

    check('工具条五个入口齐全（表情/图片/文件/语音/截屏）',
        ['#piToolEmoji', '#piToolImage', '#piToolFile', '#piToolVoice', '#piToolShot']
            .every(function (sel) { return $(sel).length === 1; }));

    var toolOrder = $('#piChatWin .pi-tool').map(function () { return this.id; }).get();
    check('按钮顺序与即时对话页一致（图片 → 表情 → 文件 → 语音 → 截屏）',
        toolOrder.join(',') === 'piToolImage,piToolEmoji,piToolFile,piToolVoice,piToolShot',
        toolOrder.join(','));

    $('#piToolEmoji').trigger('click');
    check('表情面板打开（分组 + 表情）',
        !$('#piEmojiPanel').is('[hidden]') &&
        $('#piEmojiPanel .pi-emoji__tab').length >= 5 &&
        $('#piEmojiPanel .pi-emoji__item').length > 10);

    $('#piEmojiPanel .pi-emoji__item').first().trigger('click');
    check('点表情插入输入框', String($('#piChatWinInput').val() || '').length > 0);

    await until(function () { return $('#piEmojiPanel .pi-emoji__tab[data-tab="sticker"]').length === 1; });
    $('#piEmojiPanel .pi-emoji__tab[data-tab="sticker"]').trigger('click');
    $('#piEmojiPanel .pi-emoji__item').first().trigger('click');
    await wait(20);
    var stickerFrame = SENT.filter(function (s) { return s.type === 'send' && s.msgType === 'sticker'; })[0];
    check('发图片表情包（msgType=sticker + attachId）',
        !!stickerFrame && stickerFrame.attachId === 'E1', JSON.stringify(stickerFrame || {}));
    check('表情包以图片气泡上屏', $('#piChatWinBody .pi-sticker').length === 1);

    // 文件上传发送（FileReader 在 jsdom 可用；图片走 Image 解码，这里只验 file 路径）
    var f = new win.File(['hello'], 'a.txt', { type: 'text/plain' });
    var fileInput = $('#piFileAny')[0];
    Object.defineProperty(fileInput, 'files', { value: [f], configurable: true });
    $(fileInput).trigger('change');
    await until(function () {
        return SENT.some(function (s) { return s.type === 'send' && s.msgType === 'file'; });
    });
    var fileFrame = SENT.filter(function (s) { return s.type === 'send' && s.msgType === 'file'; })[0];
    check('文件上传后按 msgType=file 发送（带 attachId）',
        !!fileFrame && !!fileFrame.attachId, JSON.stringify(fileFrame || {}));
    check('上传走后端 Api.msg.upload（kind=file）',
        CALLS.upload.length >= 1 && CALLS.upload[0].kind === 'file');
    await wait(30);
    check('文件气泡渲染成下载链接', $('#piChatWinBody .pi-file').length === 1);

    check('关闭小窗会收起表情面板',
        (function () { IM.closeChat(); return $('#piEmojiPanel').is('[hidden]') === true; })());

    console.log('\n--- 10. 小窗拖动（标题栏） ---');
    $('.pi-tab[data-tab="contact"]').trigger('click');
    await wait(320);
    $list.find('.pi-item[data-id="3"]').trigger('click');
    $list.find('.pi-item[data-id="3"]').trigger('click');
    await until(function () { return IM.isChatOpen() === true; });
    await wait(60);

    var head = win.document.querySelector('.pi-chatwin__head');
    var winEl = $('#piChatWin')[0];
    $(head).trigger($.Event('mousedown', { clientX: 500, clientY: 300 }));
    check('按下标题栏进入拖动（is-dragging）', $('#piChatWin').hasClass('is-dragging'));
    $(win.document).trigger($.Event('mousemove', { clientX: 600, clientY: 400 }));
    check('跟手移动（按抓取偏移落位 100,100）',
        Math.round(parseFloat(winEl.style.left)) === 100 && Math.round(parseFloat(winEl.style.top)) === 100,
        winEl.style.left + ',' + winEl.style.top);
    $(win.document).trigger($.Event('mouseup', {}));
    check('松手结束拖动（is-dragging 摘掉、位置保留）',
        !$('#piChatWin').hasClass('is-dragging') && Math.round(parseFloat(winEl.style.left)) === 100);

    $(head).trigger($.Event('mousedown', { clientX: 600, clientY: 400 }));
    $(win.document).trigger($.Event('mousemove', { clientX: -500, clientY: -500 }));
    $(win.document).trigger($.Event('mouseup', {}));
    check('拖出左上会被夹到 0,0',
        Math.round(parseFloat(winEl.style.left)) === 0 && Math.round(parseFloat(winEl.style.top)) === 0,
        winEl.style.left + ',' + winEl.style.top);

    $('#piChatWinMax').trigger('click');
    check('最大化会清掉拖动坐标（回到居中）', winEl.style.left === '' && !$('#piChatWin').hasClass('is-moved'));
    $(head).trigger($.Event('mousedown', { clientX: 300, clientY: 300 }));
    $(win.document).trigger($.Event('mousemove', { clientX: 400, clientY: 400 }));
    $(win.document).trigger($.Event('mouseup', {}));
    check('最大化状态下拖动无效', winEl.style.left === '' && !$('#piChatWin').hasClass('is-moved'));
    $('#piChatWinMax').trigger('click');

    $(head).trigger($.Event('mousedown', { clientX: 500, clientY: 300 }));
    $(win.document).trigger($.Event('mousemove', { clientX: 700, clientY: 500 }));
    $(win.document).trigger($.Event('mouseup', {}));
    IM.closeChat();
    await wait(320);
    $list.find('.pi-item[data-id="3"]').trigger('click');
    $list.find('.pi-item[data-id="3"]').trigger('click');
    await until(function () { return IM.isChatOpen() === true; });
    check('再次开窗回到居中（内联 left/top 已清空）',
        $('#piChatWin')[0].style.left === '' && $('#piChatWin')[0].style.top === '');
    IM.closeChat();

    console.log('\n--- 11. 语音消息（MediaRecorder 录音） ---');
    $('.pi-tab[data-tab="contact"]').trigger('click');
    await wait(320);
    $list.find('.pi-item[data-id="2"]').trigger('click');
    $list.find('.pi-item[data-id="2"]').trigger('click');
    await until(function () { return IM.isChatOpen() === true; });

    var rec = null;
    win.MediaRecorder = function (stream, opts) {
        rec = this;
        this.state = 'inactive';
        this.mimeType = (opts && opts.mimeType) || 'audio/webm';
        this.start = function () { this.state = 'recording'; };
        this.stop = function () {
            this.state = 'inactive';
            if (this.ondataavailable) {
                this.ondataavailable({ data: new win.Blob(['v'], { type: 'audio/webm' }) });
            }
            if (this.onstop) { this.onstop(); }
        };
    };
    win.MediaRecorder.isTypeSupported = function () { return true; };
    Object.defineProperty(win.navigator, 'mediaDevices', {
        configurable: true,
        value: {
            getUserMedia: function () {
                return Promise.resolve({ getTracks: function () { return [{ stop: function () { } }]; } });
            }
        }
    });

    $('#piToolVoice').trigger('click');
    await wait(80);
    check('点麦克风进入录音（按钮高亮）', $('#piToolVoice').hasClass('is-active'));
    check('MediaRecorder 已 start', !!rec && rec.state === 'recording');

    $('#piToolVoice').trigger('click');            // 结束并发送
    await until(function () {
        return SENT.some(function (s) { return s.msgType === 'audio'; });
    });
    var voiceFrame = SENT.filter(function (s) { return s.msgType === 'audio'; })[0];
    check('录音结束自动上传并发送 audio 消息', !!voiceFrame && !!voiceFrame.attachId,
        JSON.stringify(voiceFrame || {}));
    check('语音走了 Api.msg.upload（kind=file）',
        CALLS.upload.some(function (u) { return u.kind === 'file'; }));
    await wait(30);
    check('语音以 <audio> 气泡上屏', $('#piChatWinBody .pi-audio').length === 1);
    check('录音结束后按钮取消高亮', !$('#piToolVoice').hasClass('is-active'));
    IM.closeChat();

    console.log('\n--- 12. 组织架构树：逐级收起 / 员工详情 ---');
    $('.pi-tab[data-tab="contact"]').trigger('click');
    IM.state.collapsed = {};
    $('#piSearch').val('').trigger('input');
    check('默认展开：3 个部门头 + 3 名员工',
        $list.find('.pi-dept').length === 3 && $list.find('.pi-item').length === 3);

    $list.find('.pi-dept[data-dept="10"]').trigger('click');
    check('点部门行收起：成员隐藏、箭头变 ▸',
        $list.find('.pi-item[data-id="2"]').length === 0 &&
        $list.find('.pi-dept[data-dept="10"] .pi-dept__caret').text() === '▸');
    $list.find('.pi-dept[data-dept="10"]').trigger('click');
    check('再点展开：成员回来、箭头变 ▾',
        $list.find('.pi-item[data-id="2"]').length === 1 &&
        $list.find('.pi-dept[data-dept="10"] .pi-dept__caret').text() === '▾');

    $('#piSearch').val('赵').trigger('input');
    check('检索时强制展开（收起状态下也能看到命中的人）',
        $list.find('.pi-item[data-id="1"]').length === 1 &&
        $list.find('.pi-item').length === 1);
    $('#piSearch').val('').trigger('input');

    check('员工行有「查看员工详情」图标按钮',
        $list.find('.pi-item[data-id="1"] .pi-item__info').length === 1);
    $list.find('.pi-item[data-id="1"] .pi-item__info').trigger('click');
    await wait(80);
    check('点详情按钮弹出「员工详情」',
        !$('#piModal').is('[hidden]') && $('#piModalTitle').text() === '员工详情');
    var detailText = $('#piModalBody').text();
    check('详情展示姓名 / 工号 / 部门 / 职位 / 手机 / 邮箱',
        detailText.indexOf('赵建民') > -1 && detailText.indexOf('E00001') > -1 &&
        detailText.indexOf('前端组') > -1 && detailText.indexOf('工程师') > -1 &&
        detailText.indexOf('13800000000') > -1 && detailText.indexOf('z@example.com') > -1,
        detailText.replace(/\s+/g, ' ').slice(0, 160));
    check('详情走 Api.emp.detail(empId)', CALLS.empDetail.join(',') === '1');
    check('详情手机 / 邮箱右侧带复制按钮（复制值正确）',
        $('#piModalBody .pi-copy[data-kind="phone"]').attr('data-copy') === '13800000000' &&
        $('#piModalBody .pi-copy[data-kind="email"]').attr('data-copy') === 'z@example.com',
        $('#piModalBody .pi-copy').length + ' 个');
    check('详情弹窗只有「关闭」（隐藏确定按钮）',
        $('#piModalOk').is('[hidden]') && $('#piModalCancel').text() === '关闭');
    IM.closeModal();
    check('关闭详情后弹窗收起', $('#piModal').is('[hidden]'));

    console.log('\n--- 13. 群组节点：查看成员 / 增删管理 ---');
    $('.pi-tab[data-tab="group"]').trigger('click');
    var $g1 = $list.find('.pi-item[data-id="G1"]');
    check('群组节点有「查看群成员」图标按钮', $g1.find('.pi-item__members').length === 1);
    $g1.find('.pi-item__members').trigger('click');
    await wait(120);
    check('点成员按钮弹出「群成员」',
        !$('#piModal').is('[hidden]') && $('#piModalTitle').text() === '群成员');
    check('群主看到勾选框与「保存」按钮',
        $('#piModalBody input[type="checkbox"]').length >= 3 &&
        !$('#piModalOk').is('[hidden]') && $('#piModalOk').text() === '保存');

    // 取消一个成员（李四 / empId 2）
    $('#piModalBody .pi-gmember[data-emp="2"]').trigger('click');
    // 勾选一个候选人（王五 / empId 3）
    $('#piModalBody .pi-gmember[data-emp="3"]').trigger('click');
    var pickedNow = $('#piModalBody input[type="checkbox"]:checked').length;
    check('勾选状态可切换（点了两个人）', pickedNow >= 3, 'checked=' + pickedNow);

    $('#piModalOk').trigger('click');
    await until(function () { return CALLS.groupUpdate.length > 0; });
    var upd = CALLS.groupUpdate[CALLS.groupUpdate.length - 1] || {};
    check('保存走 groupUpdate(memberIds)，且不含群主自己',
        upd.groupId === 'G1' && (upd.memberIds || []).indexOf(2) === -1 &&
        (upd.memberIds || []).indexOf(3) > -1 && (upd.memberIds || []).indexOf(29) === -1,
        JSON.stringify(upd));
    await wait(60);
    check('保存后关闭弹窗并提示', $('#piModal').is('[hidden]') && $('#piToast').text().indexOf('群成员已更新') > -1);

    // 非群主：只读
    $list.find('.pi-item[data-id="G2"] .pi-item__members').trigger('click');
    await wait(120);
    check('非群主的群：没有勾选框、没有保存按钮、给出说明',
        $('#piModalBody input[type="checkbox"]').length === 0 &&
        $('#piModalOk').is('[hidden]') &&
        $('#piModalBody').text().indexOf('只有群主可以管理成员') > -1);
    IM.closeModal();

    /* -------------------------- 14. 小窗富文本 + 群聊 @ -------------------------- */
console.log('\n--- 14. 小窗富文本输入 / 群聊 @ 组员 ---');
IM.openChat('group', 'G1');
await until(function () {
    return $('#piChatWin .rt').length > 0 && $('#piChatWinInput').hasClass('rt__area');
}, 2500);
check('小窗输入区已挂载富文本编辑器（.rt + .rt__area）',
    $('#piChatWin .rt').length === 1 && $('#piChatWinInput').hasClass('rt__area'));
check('格式工具栏存在且带 @ 按钮',
    $('#piChatWin .rt__bar .rt__btn').length > 5 &&
    (function () {
        var found = false;
        $('#piChatWin .rt__bar .rt__btn').each(function () {
            if (String(this.title || '').indexOf('@') >= 0) { found = true; }
        });
        return found;
    })());

// 键入 @ → 打开组员选择（排除自己，剩 2 个）
$('#piChatWinInput').trigger($.Event('keydown', { key: '@', keyCode: 50, shiftKey: true }));
await until(function () {
    return $('#piMention').length > 0 && !$('#piMention').is('[hidden]') &&
        $('#piMention .pi-mention__item').length > 0;
}, 2000);
check('群聊里键入 @ 打开组员选择浮层', !$('#piMention').is('[hidden]'));
check('@ 列表排除自己（2 个组员）',
    $('#piMention .pi-mention__item').length === 2, $('#piMention .pi-mention__item').length);
$('#piMention .pi-mention__item').first().trigger('click');
await wait(30);
check('点选组员后编辑器里出现 .im-at[data-emp]',
    $('#piChatWinInput .im-at[data-emp]').length === 1);

// 富文本 + @ 发送：WS 帧要带 contentHtml / atEmpIds
$('#piChatWinInput').html('<p><b>粗体</b> 你好 <span class="im-at" data-emp="1">@赵建民</span></p>');
SENT.length = 0;
$('#piChatWinSend').trigger('click');
await wait(120);
var lastFrame = SENT[SENT.length - 1] || {};
check('发送帧带 contentHtml（保留 <b>）',
    String(lastFrame.contentHtml || '').indexOf('<b>') > -1 &&
    String(lastFrame.contentHtml || '').indexOf('im-at') > -1,
    String(lastFrame.contentHtml || '').slice(0, 120));
check('发送帧带 atEmpIds=1', String(lastFrame.atEmpIds) === '1', lastFrame.atEmpIds);
check('气泡按富文本渲染（is-rich + b + @高亮）',
    $('#piChatWinBody .pi-bubble.is-rich b').length === 1 &&
    $('#piChatWinBody .pi-bubble.is-rich .im-at').length === 1);

// 收到「@ 到我」的群消息 → 气泡加 is-artme 描边
(HANDLERS.message || []).forEach(function (fn) {
    fn({
        type: 'msg', id: 'm-at-1', groupId: 'G1', senderId: 1, senderName: '赵建民',
        content: '@我 看下', contentHtml: '<p><span class="im-at" data-emp="29">@我</span> 看下</p>',
        atEmpIds: '29', sendTime: '12:00', msgType: 'text'
    });
});
await wait(40);
check('被 @ 到的消息气泡加 is-artme 描边',
    $('#piChatWinBody .pi-bubble.is-rich.is-artme').length >= 1,
    $('#piChatWinBody .pi-bubble.is-rich.is-artme').length);

/* -------------------------- 15. 联系人悬停显示完整内容 -------------------------- */
console.log('\n--- 15. 抽屉列表：消息列 / 姓名超宽时悬停显示完整内容 ---');
var cssText = read('css/potato.css');
check('样式含 .pi-msg-tip（深色浮层 + 折行 + 隐藏兜底）',
    cssText.indexOf('.pi-msg-tip') > -1 && cssText.indexOf('.pi-msg-tip[hidden]') > -1 &&
    cssText.indexOf('word-break: break-word') > -1);
check('实现：只在被截断时才显示（scrollWidth 比较）',
    read('js/potato-im.js').indexOf('function showItemTip') > -1 &&
    read('js/potato-im.js').indexOf('scrollWidth <= el.clientWidth') > -1);

// 切回联系人视图，取第一行的消息列
$('.pi-tab[data-tab="contact"]').trigger('click');
await wait(80);
var $row = $list.find('.pi-item').first();
var msgEl = $row.find('.pi-item__msg')[0];
if (!msgEl) {
    check('找到联系人消息列', false);
} else {
    var full = String(msgEl.textContent || '');
    Object.defineProperty(msgEl, 'scrollWidth', { configurable: true, get: function () { return 320; } });
    Object.defineProperty(msgEl, 'clientWidth', { configurable: true, get: function () { return 90; } });
    $row.trigger('mouseenter');
    await wait(220);
    check('超宽悬停出现完整内容提示',
        $('#piMsgTip').length === 1 && !$('#piMsgTip').is('[hidden]') &&
        full.length > 0 && $('#piMsgTip').text().indexOf(full.slice(0, 6)) > -1,
        $('#piMsgTip').length ? $('#piMsgTip').text().slice(0, 60) : 'no tip');
    $row.trigger('mouseleave');
    await wait(40);
    check('移出后提示隐藏', !$('#piMsgTip').length || $('#piMsgTip').is('[hidden]'));

    Object.defineProperty(msgEl, 'scrollWidth', { configurable: true, get: function () { return 60; } });
    Object.defineProperty(msgEl, 'clientWidth', { configurable: true, get: function () { return 90; } });
    $row.trigger('mouseenter');
    await wait(220);
    check('未超宽的条目不弹提示', !$('#piMsgTip').length || $('#piMsgTip').is('[hidden]'),
        $('#piMsgTip').length ? $('#piMsgTip').text().slice(0, 40) : 'none');
}

console.log('\n===== potato-im-test 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
    process.exit(fail ? 1 : 0);
})().catch(function (e) {
    console.error('测试异常：' + (e && e.stack || e));
    process.exit(1);
});
