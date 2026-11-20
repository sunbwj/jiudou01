/* ==========================================================================
   message.js —— 即时对话 · WebSocket 实时 IM（WebQQ 风格）
   依赖：jQuery、js/api.js（Api.msg.*）、js/ui.js（UI）
   协议：握手 serverHello → 实时 msg / ack / presence / offline / read / typing / ping-pong
   能力：文字 / 图片 / 文件 / 语音输入（听写）/ 截屏 / 群组 / 离线兜底发送
   说明：发件人固定取服务端 token 反查的 empId（前端伪造无效），消息按 empId 强隔离。
   深链：?peer=<empId> 打开某人会话；?group=<群ID> 打开群聊（主框架「提醒中心」点条目走这里）。
   联动：未读数变化时通知主框架（window.parent.AppNotify.bump）刷新铃铛 / 菜单上标。
   ========================================================================== */
(function ($) {
    'use strict';

    var HAS_UI = !!window.UI;
    var IM_MAX_BYTES = 20 * 1024 * 1024;      // 与后端 IM_FILE_MAX_BYTES 对齐（20 MB）

    /** 深链参数：?peer= 某人 / ?group= 某群（来自主框架提醒面板或外部直接打开） */
    function queryOf(name) {
        try {
            var m = new RegExp('[?&]' + name + '=([^&#]+)').exec(String(window.location.search || ''));
            return m ? decodeURIComponent(m[1]) : '';
        } catch (e) { return ''; }
    }
    var PENDING_PEER = (function () {
        var v = queryOf('peer');
        return /^\d+$/.test(v) ? parseInt(v, 10) : 0;
    })();
    var PENDING_GROUP = queryOf('group');

    function toast(type, msg) {
        if (HAS_UI && window.UI.message) { window.UI.message({ type: type || 'info', message: msg }); }
        else { console.log('[IM]', type, msg); }
    }
    /** 通知主框架（main.html）刷新未读徽标 / 铃铛；单独打开本页时静默跳过 */
    function notifyFrame() {
        try {
            var p = window.parent;
            if (p && p !== window && p.AppNotify && p.AppNotify.bump) { p.AppNotify.bump(); }
        } catch (e) { /* 跨域 / 单独打开：忽略 */ }
    }
    /**
     * 统一取数据：Api 的 request() 已经 resolve 了 {code,message,data} 里的 data，
     * 所以这里不能再判断 res.code —— 兼容两种形态（拆包 / 未拆包），避免「历史消息永远空白」。
     */
    function payload(res) {
        if (!res) { return null; }
        if (res.data !== undefined && (res.code === 0 || res.code === 200)) { return res.data; }
        return res;
    }
    function confirmDialog(title, msg, onYes) {
        if (HAS_UI && window.UI.confirm) {
            window.UI.confirm({ title: title, message: msg, confirmText: '确定', cancelText: '取消' })
                .then(function (ok) { if (ok) { onYes(); } });
        } else if (window.confirm(msg)) { onYes(); }
    }

    // 当前会话的全部状态（也便于单测断言）
    var STATE = {
        me: 0,
        meInfo: null,
        contacts: {},          // empId -> contact
        groups: {},            // groupId -> group
        convo: {},             // empId -> [message]；群聊用 'g<groupId>' -> [message]
        activePeer: 0,         // 与 activeGroup 互斥
        activeGroup: '',
        tab: 'msg',            // 'msg' | 'group' | 'contacts'
        keyword: '',
        connected: false,
        manualClose: false,
        reconnectTimer: null,
        reconnectDelay: 1000,
        voiceOn: false,        // 语音输入（听写）是否在录
        uploading: false,
        emojiOpen: false,      // 表情面板是否展开
        emojiTab: 'recent',    // 当前表情分组
        emojis: [],            // 自定义表情包（图片表情，全站共享）
        recentEmoji: [],       // 最近使用的 emoji（localStorage）
        groupMembers: {},      // groupId -> [member]（@ 组员用，打开群时预热）
        atOpen: false          // @ 选人浮层是否展开
    };
    var SOCKET = null;
    var EDITOR = null;         // 富文本编辑器实例（js/rich-text.js 挂载在 #imText 上）
    var REC = null;            // 已废弃（语音改为 MediaRecorder 录音发送）

    // ---------------- 工具 ----------------
    function esc(s) { return $('<div>').text(s == null ? '' : String(s)).html(); }
    function avText(name) {
        name = (name || '?').toString().trim();
        return name ? name.slice(0, 1) : '?';
    }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function nowHM() { var d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
    function stamp() {
        var d = new Date();
        return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
            '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    }
    function dispTime(s) {
        if (!s) { return ''; }
        s = String(s);
        if (s.indexOf(':') > 0 && s.indexOf('-') < 0) { return s; }       // 已是 HH:MM
        var t = s.indexOf(' ') > 0 ? s.split(' ')[1] : s;
        return t.length >= 5 ? t.slice(0, 5) : s;
    }
    function fmtSize(n) {
        n = parseInt(n, 10) || 0;
        if (n <= 0) { return '未知大小'; }
        if (n < 1024) { return n + ' B'; }
        if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }
    function extOf(name) {
        var m = /\.([0-9a-z]+)$/i.exec(String(name || ''));
        return m ? m[1].toLowerCase() : '';
    }
    function setStatus(text, isError) {
        var $s = $('#imInputStatus');
        if (!$s.length) { return; }
        $s.text(text || '').toggleClass('is-error', !!isError);
    }
    function chatKey() { return STATE.activeGroup ? ('g' + STATE.activeGroup) : String(STATE.activePeer); }

    // ---------------- DOM 渲染 ----------------
    function renderMe() {
        var info = STATE.meInfo || { name: '员工' + STATE.me, deptName: '', jobTitle: '', avatarText: avText('员') };
        $('#imMeAvatar').text(info.avatarText || avText(info.name));
        $('#imMeName').text(info.name || ('员工' + STATE.me));
        var sub = [info.deptName || '', info.jobTitle || ''].filter(Boolean).join(' · ');
        $('#imMeSub').text(sub || '—');
    }

    function updateConnection(connected, text) {
        STATE.connected = connected;
        var $conn = $('#imConn');
        $conn.removeClass('is-online is-offline')
             .addClass(connected ? 'is-online' : 'is-offline');
        $('#imConnText').text(text || (connected ? '已连接' : '连接中…'));
    }

    function totalUnread() {
        var n = 0;
        $.each(STATE.contacts, function (k, c) { n += (c.unread || 0); });
        $.each(STATE.groups, function (k, g) { n += (g.unread || 0); });
        return n;
    }
    function updateOnlineAndUnread() {
        var online = 0, total = 0;
        $.each(STATE.contacts, function (k, c) { total++; if (c.online) { online++; } });
        $('#imOnlineCount').text('在线 ' + online + ' / 共 ' + total);
        var u = totalUnread();
        document.title = (u > 0 ? '(' + u + ') ' : '') + '即时对话 - 九豆综合管理平台';
    }

    /** 左侧列表条目：人 + 群（消息 / 群组 / 联系人 三个标签页共用一套渲染） */
    function listItems() {
        var kw = STATE.keyword.trim().toLowerCase();
        var peers = [], groups = [];
        $.each(STATE.contacts, function (k, c) { peers.push(c); });
        $.each(STATE.groups, function (k, g) { groups.push(g); });
        if (kw) {
            peers = peers.filter(function (c) {
                return [c.name, c.deptName, c.jobTitle].join(' ').toLowerCase().indexOf(kw) >= 0;
            });
            groups = groups.filter(function (g) {
                return String(g.name || '').toLowerCase().indexOf(kw) >= 0;
            });
        }
        if (STATE.tab === 'contacts') {
            peers.sort(function (a, b) {
                if (a.online !== b.online) { return a.online ? -1 : 1; }
                return (a.name || '').localeCompare(b.name || '');
            });
            return peers;
        }
        var all = [];
        if (STATE.tab === 'group') {
            all = groups;
        } else {
            // 消息：人和群一起按最近时间排（无消息的群不占位，避免空群把列表刷满）
            all = peers.concat(groups.filter(function (g) { return !!g.lastTime; }));
        }
        all.sort(function (a, b) {
            var ta = a.lastTime || '', tb = b.lastTime || '';
            if (ta !== tb) { return tb.localeCompare(ta); }
            if (!a.isGroup && !b.isGroup && a.online !== b.online) { return a.online ? -1 : 1; }
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
        return all;
    }

    /* 左侧列表「消息列」被截断时的悬停提示：只有真的超出宽度才显示完整内容 */
    var msgTipTimer = null;
    function hideMsgTip() {
        if (msgTipTimer) { window.clearTimeout(msgTipTimer); msgTipTimer = null; }
        var $t = $('#imMsgTip');
        if ($t.length) { $t.attr('hidden', 'hidden').text(''); }
    }
    function showMsgTip(el) {
        var text = String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
        if (!text) { return; }
        var $t = $('#imMsgTip');
        if (!$t.length) {
            $t = $('<div class="im-msg-tip" id="imMsgTip" hidden></div>').appendTo(document.body);
        }
        $t.text(text).removeAttr('hidden');
        var r = el.getBoundingClientRect();
        var tw = $t.outerWidth(), th = $t.outerHeight();
        var left = Math.max(8, Math.min(r.left, window.innerWidth - tw - 8));
        var top = r.bottom + 6;
        if (top + th > window.innerHeight - 8) { top = Math.max(8, r.top - th - 6); }
        $t.css({ left: Math.round(left) + 'px', top: Math.round(top) + 'px' });
    }

    function renderContacts() {
        hideMsgTip();
        var $list = $('#imContacts').empty();
        var arr = listItems();
        if (!arr.length) {
            $list.append('<div class="emp-pick__empty">' +
                (STATE.tab === 'group' ? '还没有群聊，点上方「创建群组」' : '没有匹配的联系人') + '</div>');
            updateOnlineAndUnread();
            return;
        }
        $.each(arr, function (i, c) {
            var isGroup = !!c.isGroup || !!c.groupId;
            var active = isGroup ? (c.groupId === STATE.activeGroup) : (c.empId === STATE.activePeer);
            var dot = isGroup ? '' :
                '<span class="im-dot' + (c.online ? ' is-online' : '') + '"></span>';
            var sub = isGroup ? ('群聊 · ' + (c.memberCount || 0) + ' 人') : (c.deptName || '');
            var last = c.lastContent || c.lastMessage || (isGroup ? '点击进入群聊' : '点击发起会话');
            if (isGroup && c.lastSenderName && c.lastContent) {
                last = (c.lastFromMe ? '我：' : (c.lastSenderName + '：')) + c.lastContent;
            }
            var $row = $(
                '<div class="im-contact' + (isGroup ? ' is-group' : '') + '" ' +
                    (isGroup ? ('data-group="' + esc(c.groupId) + '"') : ('data-emp="' + c.empId + '"')) + '>' +
                    '<div class="im-avatar"' + (isGroup ? ' style="background:#e6a23c;"' : '') + '>' +
                        esc(c.avatarText || avText(c.name)) + dot +
                    '</div>' +
                    '<div class="im-contact__body">' +
                        '<div class="im-contact__row1">' +
                            '<span class="im-contact__name">' + esc(c.name) + '</span>' +
                            (c.lastTime ? '<span class="im-contact__time">' + esc(dispTime(c.lastTime)) + '</span>' : '') +
                        '</div>' +
                        '<div class="im-contact__row2">' +
                            '<span class="im-contact__msg">' + esc(last) + '</span>' +
                            (sub ? '<span class="im-contact__dept">' + esc(sub) + '</span>' : '') +
                        '</div>' +
                    '</div>' +
                    (c.unread ? '<span class="im-badge">' + esc(c.unread > 99 ? '99+' : c.unread) + '</span>' : '') +
                    (isGroup ? ('<button type="button" class="im-contact__rename" data-rename="' + esc(c.groupId) + '"' +
                        ' title="重命名群聊" aria-label="重命名群聊">' +
                        '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M11.7 1.6a1.4 1.4 0 012 2l-8.1 8.1-2.6.7.7-2.6 8-8.2zM2.5 13.2h11v1.3h-11z"/></svg>' +
                        '</button>') : '') +
                '</div>');
            if (active) { $row.addClass('is-active'); }
            $row.on('click', function (e) {
                // 行内的「改名」铅笔：不要触发打开会话
                if (isGroup && $(e.target).closest('.im-contact__rename').length) {
                    e.stopPropagation();
                    if (amGroupOwner(c.groupId)) { openGroupRename(c.groupId); }
                    else { toast('warning', '只有群主可以修改群名称'); }
                    return;
                }
                if (isGroup) { openGroup(c.groupId); } else { openPeer(c.empId); }
            });
            $list.append($row);
        });
        updateOnlineAndUnread();
        syncRenameEntries();
    }

    /** 单条气泡：文字 / 图片（点击放大）/ 文件（可下载） */
    function bubbleOf(m) {
        var type = m.msgType || 'text';
        var att = m.attach || null;
        if (type === 'image' && att && att.url) {
            return '<div class="im-msg__bubble is-media">' +
                '<img class="im-img" src="' + esc(att.url) + '" alt="' + esc(att.name || '图片') + '"' +
                (att.width ? (' width="' + parseInt(att.width, 10) + '"') : '') +
                ' data-full="' + esc(att.url) + '" data-name="' + esc(att.name || '') + '"></div>';
        }
        if (type === 'sticker' && att && att.url) {
            return '<div class="im-msg__bubble is-media">' +
                '<img class="im-sticker" src="' + esc(att.url) + '" alt="' + esc(att.name || '表情') + '"' +
                ' data-full="' + esc(att.url) + '" data-name="' + esc(att.name || '') + '"></div>';
        }
        if (type === 'audio' && att && att.url) {
            return '<div class="im-msg__bubble is-media">' +
                '<audio class="im-audio" controls preload="metadata" src="' + esc(att.url) + '"></audio></div>';
        }
        if (type === 'file' && att) {
            var ex = att.ext || extOf(att.name);
            return '<div class="im-msg__bubble is-media">' +
                '<a class="im-file" href="' + esc(att.url || '#') + '" target="_blank" rel="noopener"' +
                    ' download="' + esc(att.name || '') + '">' +
                    '<span class="im-file__ico">' + esc((ex || 'FILE').toUpperCase().slice(0, 4)) + '</span>' +
                    '<span class="im-file__body">' +
                        '<span class="im-file__name">' + esc(att.name || '文件') + '</span>' +
                        '<span class="im-file__meta">' + esc(fmtSize(att.size)) + '</span>' +
                    '</span>' +
                    '<span class="im-file__dl">下载</span>' +
                '</a></div>';
        }
        // 纯 emoji：去掉气泡底色、放大显示（微信那种大表情）
        if (isEmojiOnly(m.content)) {
            return '<div class="im-msg__bubble is-emoji">' + esc(m.content) + '</div>';
        }
        // 富文本：contentHtml 是编辑器产出的 HTML 片段，渲染前必须 sanitize；
        // 自己被 @ 到的群消息额外加一圈浅色描边（.is-artme）
        var rich = m.contentHtml ? String(m.contentHtml) : '';
        if (rich && window.RichText && !window.RichText.isEmptyHtml(rich)) {
            var atMe = atMentionsMe(m);
            return '<div class="im-msg__bubble is-rich' + (atMe ? ' is-artme' : '') + '">' +
                window.RichText.sanitize(rich) + '</div>';
        }
        return '<div class="im-msg__bubble">' + esc(m.content) + '</div>';
    }

    /** 这条消息是否 @ 到了我（atEmpIds 形如 "12,30"） */
    function atMentionsMe(m) {
        var ids = String((m && m.atEmpIds) || '').split(',');
        for (var i = 0; i < ids.length; i++) {
            if (parseInt(ids[i], 10) === parseInt(STATE.me, 10) && STATE.me) { return true; }
        }
        return false;
    }

    function renderChat() {
        var $body = $('#imChatBody').empty();
        var list = STATE.convo[chatKey()] || [];
        if (!list.length) {
            $body.append('<div style="text-align:center;color:#c0c4cc;font-size:13px;padding:30px 0;">' +
                (STATE.activeGroup ? '群里还没有消息，说两句吧' : '还没有消息，开始聊天吧') + '</div>');
            return;
        }
        $.each(list, function (i, m) {
            var mine = !!m.isMe;
            var meta = dispTime(m.sendTime);
            if (mine && m.read) { meta += ' · 已读'; }
            else if (mine) { meta += ' · 已发送'; }
            if (mine && m.temp) { meta += ' · 发送中'; }
            var name = mine ? ((STATE.meInfo && STATE.meInfo.name) || '我') : (m.senderName || '');
            var $msg = $(
                '<div class="im-msg' + (mine ? ' is-me' : '') + '" data-mid="' + esc(m.id || '') + '"' +
                    (m.msgType && m.msgType !== 'text' ? (' data-type="' + esc(m.msgType) + '"') : '') + '>' +
                    '<div class="im-msg__avatar">' + esc(avText(name)) + '</div>' +
                    '<div class="im-msg__content">' +
                        (STATE.activeGroup && !mine
                            ? '<div style="font-size:12px;color:#909399;margin-bottom:3px;">' + esc(name) + '</div>'
                            : '') +
                        bubbleOf(m) +
                        '<div class="im-msg__meta">' + esc(meta) + '</div>' +
                    '</div>' +
                '</div>');
            if (m.temp && m.error) { $msg.find('.im-msg__bubble').css({ background: '#fef0f0', color: '#f56c6c', borderColor: '#fde2e2' }); }
            if (m.temp && !m.error) { $msg.css('opacity', .78); }
            $body.append($msg);
        });
        var el = $body[0];
        el.scrollTop = el.scrollHeight;
        bindAudioFallback($body);
    }

    /** 语音加载失败时给一条「点此下载」兜底（浏览器不支持该编码时也能拿到文件） */
    function bindAudioFallback($root) {
        $root.find('audio.im-audio').each(function () {
            var el = this;
            if (el.__audioFallback) { return; }
            el.__audioFallback = true;
            el.addEventListener('error', function () {
                var $a = $(el);
                if ($a.next('.im-audio-fail').length) { return; }
                $a.after('<a class="im-audio-fail" href="' + el.getAttribute('src') +
                    '" target="_blank" rel="noopener" download>语音无法播放，点此下载</a>');
            });
        });
    }

    function showTyping(on) {
        var $t = $('#imTyping');
        if (on) { $t.show(); var b = $('#imChatBody')[0]; if (b) { b.scrollTop = b.scrollHeight; } }
        else { $t.hide(); }
    }

    /** 深链：联系人 / 群快照到位后自动打开目标会话（只消费一次） */
    function tryPendingTarget() {
        if (PENDING_PEER && STATE.contacts[PENDING_PEER]) {
            var peer = PENDING_PEER;
            PENDING_PEER = 0;
            openPeer(peer);
            return true;
        }
        if (PENDING_GROUP && STATE.groups[PENDING_GROUP]) {
            var gid = PENDING_GROUP;
            PENDING_GROUP = '';
            openGroup(gid);
            return true;
        }
        return false;
    }
    function tryPendingPeer() { return tryPendingTarget(); }

    // ---------------- 会话操作 ----------------
    function openPeer(empId) {
        empId = parseInt(empId, 10);
        if (!empId) { return; }
        if (STATE.voiceOn) { stopVoice(false); }   // 切会话丢弃未发完的录音
        var c = STATE.contacts[empId];
        if (!c) { toast('warning', '联系人不存在'); return; }
        STATE.activePeer = empId;
        STATE.activeGroup = '';
        $('#imEmpty').hide();
        $('#imChat').show();
        $('#imChatTitle').text(c.name);
        $('#imChatSub').html(c.online
            ? '<span class="im-chat__online">● 在线</span>'
            : '<span class="im-chat__offline">○ 离线</span>');
        $('#imGroupMembers').prop('hidden', true);
        $('#imChatTitleEdit').attr('hidden', 'hidden');
        $('#btnMarkRead').prop('disabled', false);
        $('#btnDelete').prop('disabled', false);
        $('#imText').prop('disabled', false).focus();
        if (!STATE.convo[empId]) { STATE.convo[empId] = []; }
        renderChat();
        renderContacts();
        Api.msg.history(empId).done(function (res) {
            var d = payload(res);
            if (d) {
                STATE.convo[empId] = d.list || [];
                renderChat();
                if (d.peer) {
                    c.online = d.peer.online;
                    $('#imChatSub').html(c.online
                        ? '<span class="im-chat__online">● 在线</span>'
                        : '<span class="im-chat__offline">○ 离线</span>');
                }
                if (c.unread) { c.unread = 0; renderContacts(); }
                notifyFrame();
            }
        }).fail(function () { /* 离线也能看本地缓存 */ });
        sendReadReceipt(empId);
    }

    function openGroup(groupId) {
        groupId = String(groupId || '');
        if (!groupId) { return; }
        if (STATE.voiceOn) { stopVoice(false); }   // 切会话丢弃未发完的录音
        var g = STATE.groups[groupId];
        if (!g) { toast('warning', '群不存在或已解散'); return; }
        STATE.activeGroup = groupId;
        STATE.activePeer = 0;
        $('#imEmpty').hide();
        $('#imChat').show();
        $('#imChatTitle').text(g.name || '群聊');
        $('#imChatSub').html('<span class="im-chat__offline">' + (g.memberCount || 0) + ' 位成员</span>');
        $('#imGroupMembers').prop('hidden', false);
        syncRenameEntries();
        $('#btnMarkRead').prop('disabled', false);
        $('#btnDelete').prop('disabled', true);       // 群聊不支持「清空会话」（会影响别人）
        $('#imText').prop('disabled', false).focus();
        var key = 'g' + groupId;
        if (!STATE.convo[key]) { STATE.convo[key] = []; }
        renderChat();
        renderContacts();
        Api.msg.groupHistory(groupId).done(function (res) {
            var d = payload(res);
            if (d) {
                STATE.convo[key] = d.list || [];
                if (d.group) {
                    mergeGroup(d.group); g.memberCount = d.group.memberCount;
                    cacheMembers(groupId, d.group.members);       // @ 组员直接用，不再单独请求
                }
                STATE.groups[groupId].unread = 0;
                $('#imChatSub').html('<span class="im-chat__offline">' + (g.memberCount || 0) + ' 位成员</span>');
                renderChat();
                renderContacts();
                notifyFrame();
            }
        }).fail(function () { /* 离线看缓存 */ });
    }

    function sendReadReceipt(empId) {
        var c = STATE.contacts[empId];
        if (c && c.unread) { c.unread = 0; renderContacts(); }
        Api.msg.markPeer(empId).fail(function () {});
        if (SOCKET && SOCKET.connected) { SOCKET.send({ type: 'read', peerId: empId }); }
        notifyFrame();
    }

    function markGroupRead(groupId) {
        var g = STATE.groups[groupId];
        if (g && g.unread) { g.unread = 0; renderContacts(); }
        Api.msg.markGroup(groupId).fail(function () {});
        notifyFrame();
    }

    // ---------------- 发送 ----------------
    function pushMsg(key, msg) {
        if (!STATE.convo[key]) { STATE.convo[key] = []; }
        STATE.convo[key].push(msg);
    }
    function locateTemp(tempId, id, sendTime) {
        $.each(STATE.convo, function (k, list) {
            for (var i = 0; i < (list || []).length; i++) {
                if (list[i].tempId && list[i].tempId === tempId) {
                    list[i].id = id;
                    if (sendTime) { list[i].sendTime = sendTime; }
                    list[i].temp = false;
                    list[i].error = false;
                }
            }
        });
    }

    function deliver(target, msg, tempId) {
        var t = target || {};
        if (SOCKET && SOCKET.connected) {
            SOCKET.send({
                type: 'send', to: t.peer || 0, groupId: t.group || '',
                content: msg.content, contentHtml: msg.contentHtml || '',
                atEmpIds: msg.atEmpIds || '', msgType: msg.msgType || 'text',
                attachId: msg.attachId || '', tempId: tempId
            });
            return;
        }
        // 离线兜底：走 REST 发送（不实时，但保证送达 / 落库，对方登录后即可见）
        var data = {
            content: msg.content, contentHtml: msg.contentHtml || '',
            atEmpIds: msg.atEmpIds || '', msgType: msg.msgType || 'text',
            attachId: msg.attachId || ''
        };
        if (t.group) { data.groupId = t.group; } else { data.receiverIds = [t.peer]; }
        Api.msg.send(data).done(function (res) {
            var d = payload(res);
            if (d) {
                var id = (d.ids && d.ids[0]) || null;
                var st = d.sentTime || nowHM();
                locateTemp(tempId, id, st);
                renderChat();
                updateLastAfterSend(t, msg, st);
                renderContacts();
            } else {
                failTemp(tempId, '发送失败');
            }
        }).fail(function () { failTemp(tempId, '网络错误'); });
    }

    function failTemp(tempId, reason) {
        $.each(STATE.convo, function (peer, list) {
            for (var i = 0; i < (list || []).length; i++) {
                if (list[i].tempId === tempId) { list[i].error = true; list[i].temp = false; }
            }
        });
        renderChat();
        toast('error', reason);
    }

    function sendMessage() {
        var text = EDITOR ? EDITOR.text() : $.trim($('#imText').val());
        if (!text) { return; }
        if (!STATE.activePeer && !STATE.activeGroup) { toast('warning', '请先选择会话'); return; }
        var peer = STATE.activePeer, gid = STATE.activeGroup;
        var htmlBody = EDITOR ? EDITOR.html() : '';
        var atIds = EDITOR ? collectAtIds() : [];
        var tempId = 't' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
        var msg = {
            id: tempId, tempId: tempId, senderId: STATE.me, receiverId: peer || 0,
            groupId: gid || '', content: text, contentHtml: htmlBody,
            atEmpIds: atIds.join(','), msgType: 'text', attachId: '', attach: null,
            senderName: (STATE.meInfo && STATE.meInfo.name) || '我',
            sendTime: nowHM(), isMe: true, read: 0, temp: true
        };
        pushMsg(chatKey(), msg);
        renderChat();
        clearInput();
        deliver({ peer: peer, group: gid }, msg, tempId);
        if (peer) { sendTyping(peer, false); }
    }

    /** 清空输入区（富文本与纯文本两种实现都覆盖） */
    function clearInput() {
        if (EDITOR) { EDITOR.clear(); return; }
        $('#imText').val('');
    }

    /** 把媒体按钮行（图片/表情/文件/语音/截屏）放回编辑区正上方——
        位于富文本格式栏（.rt__bar）下方、可编辑区（.rt__area）上方的独立一行，
        与改造前的原始布局一致；编辑区是普通文档流，永远不会压住这行按钮 */
    function placeMediaTools() {
        var $tools = $('#imInputTools');
        var $row = $('.im-input > .im-input__row');
        if (!$tools.length || !$row.length) { return; }
        /* 布局对齐员工IM 小窗：媒体按钮独立一行，在「富文本框（格式栏 + 编辑区）」正上方；
           已就位（紧跟富文本框那一行之前）就什么都不做，重复初始化幂等 */
        if ($tools.next()[0] === $row[0]) { return; }
        $tools.addClass('im-input__tools').removeClass('rt__extra');
        $row.first().before($tools);
    }

    /** 收集本条消息里 @ 到的组员 empId（以编辑器里真实存在的 .im-at 标记为准） */
    function collectAtIds() {
        var out = [], seen = {};
        if (!EDITOR || !EDITOR.el) { return out; }
        $(EDITOR.el).find('.im-at[data-emp]').each(function () {
            var n = parseInt($(this).attr('data-emp'), 10);
            if (n && !seen[n]) { seen[n] = 1; out.push(n); }
        });
        return out;
    }

    function sendAttachment(att) {
        if (!att || !att.fileId) { return; }
        var peer = STATE.activePeer, gid = STATE.activeGroup;
        if (!peer && !gid) { toast('warning', '请先选择会话'); return; }
        var visible = chatKey();
        var tempId = 't' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
        var msg = {
            id: tempId, tempId: tempId, senderId: STATE.me, receiverId: peer || 0,
            groupId: gid || '',
            content: att.msgType === 'audio' ? '[语音]' : (att.kind === 'image' ? '[图片]' : '[文件]'),
            msgType: att.msgType || (att.kind === 'image' ? 'image' : 'file'),
            attachId: att.fileId, attach: att,
            senderName: (STATE.meInfo && STATE.meInfo.name) || '我',
            sendTime: nowHM(), isMe: true, read: 0, temp: true
        };
        pushMsg(visible, msg);
        renderChat();
        deliver({ peer: peer, group: gid }, msg, tempId);
    }

    function updateContactLast(empId, content, time, isMe) {
        var c = STATE.contacts[empId];
        if (!c) { return; }
        var snap = String(content || '').replace(/\s+/g, ' ').slice(0, 40);
        c.lastContent = snap;
        c.lastMessage = snap;
        c.lastTime = (time && String(time).indexOf(':') > 0 && String(time).indexOf('-') < 0) ? ('1970-01-01 ' + time) : time;
        c.lastIsMe = !!isMe;
    }
    function updateGroupLast(groupId, content, time, isMe, senderName) {
        var g = STATE.groups[groupId];
        if (!g) { return; }
        g.lastContent = String(content || '').replace(/\s+/g, ' ').slice(0, 120);
        g.lastTime = (time && String(time).indexOf(':') > 0 && String(time).indexOf('-') < 0) ? ('1970-01-01 ' + time) : time;
        g.lastFromMe = !!isMe;
        g.lastSenderName = senderName || '';
    }
    function updateLastAfterSend(t, msg, st) {
        var preview = msg.msgType === 'image' ? '[图片]'
            : (msg.msgType === 'file' ? '[文件]'
                : (msg.msgType === 'audio' ? '[语音]' : msg.content));
        if (t.group) { updateGroupLast(t.group, preview, st, true); }
        else if (t.peer) { updateContactLast(t.peer, preview, st, true); }
    }

    // ---------------- 表情：emoji 面板 + 自定义图片表情包 ----------------
    /* 分组数据：key 用于 localStorage 记住上次分组，name 是标签文案 */
    var EMOJI_GROUPS = [
        { key: 'recent', name: '常用', items: [] },
        { key: 'smile', name: '笑脸', items: [
            '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩',
            '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪', '😝', '🤗', '🤔', '🤨', '😐', '😑', '😶', '🙄',
            '😏', '😣', '😥', '😮', '🤐', '😯', '😪', '😫', '🥱', '😴', '😌', '😔', '🤤', '😷', '🤒', '🤕',
            '🥳', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '😱', '😨', '😰', '😓', '🤯', '😳', '🥵', '🥶',
            '😵', '🤢', '🤮', '😈', '👻', '💀', '🤡', '💩'
        ] },
        { key: 'hand', name: '手势', items: [
            '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️',
            '🖖', '👋', '🤝', '🙏', '💪', '👏', '🙌', '🫶', '🤌', '🤏', '✊', '👊', '🤜', '🤛', '👀', '🧠'
        ] },
        { key: 'heart', name: '心情', items: [
            '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖',
            '💘', '💝', '💟', '💯', '🔥', '⭐', '🌟', '✨', '⚡', '💥', '💫', '💦', '💨', '🎉', '🎊', '🆗'
        ] },
        { key: 'thing', name: '物品', items: [
            '🎁', '🎈', '🎂', '🍰', '☕', '🍺', '🍻', '🍎', '🍉', '🍓', '🌸', '🌹', '🌻', '🌈', '☀️', '🌙',
            '⛅', '🌊', '✅', '❌', '⚠️', '❓', '❗', '💡', '📌', '📍', '🔔', '🎵', '🎶', '📎', '📝', '📊',
            '💰', '🏆', '🎯', '🚀', '⏰', '📅'
        ] },
        { key: 'animal', name: '动物', items: [
            '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔',
            '🐧', '🐦', '🦄', '🐝', '🦋', '🐢', '🐬', '🐳', '🦉', '🐺', '🐴', '🦌', '🐑', '🐘', '🐍', '🐙'
        ] }
    ];
    var RECENT_MAX = 16;

    /** 是否「纯 emoji」文本：是的话气泡放大显示（微信那种大表情） */
    function isEmojiOnly(text) {
        var t = String(text || '').trim();
        if (!t || t.length > 60) { return false; }
        // 覆盖 BMP 里的符号区 + 所有星平面（emoji 主体）以及变体选择符 / ZWJ / 肤色修饰
        if (!/^[\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u25A0-\u27BF\u2900-\u297F\u2B00-\u2BFF\uFE0F\u200D\u20E3\uD800-\uDFFF\s]+$/.test(t)) {
            return false;
        }
        var count = Array.from ? Array.from(t.replace(/\s/g, '')).length : t.replace(/\s/g, '').length;
        return count >= 1 && count <= 6;
    }

    function loadRecentEmoji() {
        try {
            var raw = window.localStorage.getItem('menu_admin_im_emoji_recent');
            var list = raw ? JSON.parse(raw) : [];
            STATE.recentEmoji = Object.prototype.toString.call(list) === '[object Array]' ? list : [];
        } catch (e) { STATE.recentEmoji = []; }
    }
    function pushRecentEmoji(ch) {
        var list = STATE.recentEmoji.filter(function (x) { return x !== ch; });
        list.unshift(ch);
        if (list.length > RECENT_MAX) { list = list.slice(0, RECENT_MAX); }
        STATE.recentEmoji = list;
        try { window.localStorage.setItem('menu_admin_im_emoji_recent', JSON.stringify(list)); } catch (e) { }
    }

    function renderEmojiPanel() {
        var $tabs = $('#imEmojiTabs').empty();
        $.each(EMOJI_GROUPS, function (i, g) {
            var label = g.name;
            if (g.key === 'recent') { label = '常用' + (g.key === STATE.emojiTab && STATE.emojis.length ? '' : ''); }
            $tabs.append('<button type="button" class="im-emoji__tab' +
                (g.key === STATE.emojiTab ? ' is-active' : '') + '" data-egroup="' + g.key + '">' +
                esc(label) + '</button>');
        });
        // 自定义表情包单独一个标签（有内容时才显示）
        if (STATE.emojis.length) {
            $tabs.append('<button type="button" class="im-emoji__tab' +
                (STATE.emojiTab === 'sticker' ? ' is-active' : '') + '" data-egroup="sticker">表情包 ' +
                STATE.emojis.length + '</button>');
        }
        var $body = $('#imEmojiBody').empty();

        if (STATE.emojiTab === 'sticker') {
            if (!STATE.emojis.length) {
                $body.append('<div class="im-emoji__empty">还没有表情包，点下方「添加表情包」上传图片</div>');
                return;
            }
            $.each(STATE.emojis, function (i, it) {
                var $b = $('<button type="button" class="im-emoji__sticker" data-emoji-id="' + esc(it.id) + '"' +
                    ' title="' + esc(it.name || '表情') + '">' +
                    '<img src="' + esc(it.url) + '" alt="' + esc(it.name || '表情') + '">' +
                    (it.mine ? '<span class="im-emoji__del" data-del-id="' + esc(it.id) + '" title="删除">✕</span>' : '') +
                    '</button>');
                $body.append($b);
            });
            $('#imEmojiTip').text('点击即发送 · 全员共享');
            return;
        }

        var group = null;
        $.each(EMOJI_GROUPS, function (i, g) { if (g.key === STATE.emojiTab) { group = g; } });
        var items = (group && group.items) || [];
        if (STATE.emojiTab === 'recent') { items = STATE.recentEmoji || []; }
        if (!items.length) {
            $body.append('<div class="im-emoji__empty">' +
                (STATE.emojiTab === 'recent' ? '还没有用过的表情，点其它分组挑一个吧' : '这个分组暂无表情') +
                '</div>');
            $('#imEmojiTip').text('');
            return;
        }
        $.each(items, function (i, ch) {
            $body.append('<button type="button" class="im-emoji__item" data-emoji="' + esc(ch) + '">' + esc(ch) + '</button>');
        });
        $('#imEmojiTip').text('点击插入输入框');
    }

    function openEmojiPanel() {
        STATE.emojiOpen = true;
        $('#imEmojiPanel').removeAttr('hidden');
        $('#imEmoji').addClass('is-active');
        if (!STATE.emojis.length) { loadEmojis(); }
        renderEmojiPanel();
    }
    function closeEmojiPanel() {
        STATE.emojiOpen = false;
        $('#imEmojiPanel').attr('hidden', 'hidden');
        $('#imEmoji').removeClass('is-active');
    }
    function toggleEmojiPanel() {
        if (STATE.emojiOpen) { closeEmojiPanel(); } else { openEmojiPanel(); }
    }

    /** 把表情插入到输入框光标处（没有光标就追加到末尾） */
    function insertEmoji(ch) {
        if (EDITOR) {
            EDITOR.restoreRange();
            EDITOR.insertText(ch);
            pushRecentEmoji(ch);
            if (STATE.emojiTab === 'recent') { renderEmojiPanel(); }
            EDITOR.focus();
            return;
        }
        var ta = $('#imText')[0];
        if (!ta) { return; }
        var val = String(ta.value || '');
        var start = typeof ta.selectionStart === 'number' ? ta.selectionStart : val.length;
        var end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : val.length;
        ta.value = val.slice(0, start) + ch + val.slice(end);
        var pos = start + ch.length;
        try { ta.setSelectionRange(pos, pos); } catch (e) { }
        pushRecentEmoji(ch);
        if (STATE.emojiTab === 'recent') { renderEmojiPanel(); }
        $(ta).trigger('focus');
    }

    function loadEmojis(done) {
        if (!Api.msg.emojis) { if (done) { done(); } return; }
        Api.msg.emojis().done(function (res) {
            var d = payload(res);
            STATE.emojis = (d && d.list) || [];
            if (STATE.emojiOpen) { renderEmojiPanel(); }
            if (done) { done(); }
        }).fail(function () { if (done) { done(); } });
    }

    /** 添加表情包：选一张本地图片 → 复用 /msg/upload 上传 → 登记到表情表 */
    function addEmojiSticker() {
        var $inp = $('#imEmojiFile');
        if (!$inp.length) {
            $inp = $('<input type="file" id="imEmojiFile" accept="image/*" style="display:none;">').appendTo(document.body);
            $inp.on('change', function () {
                var f = this.files && this.files[0];
                try { this.value = ''; } catch (e) { }
                if (f) { uploadEmojiSticker(f); }
            });
        }
        $inp.val('').trigger('click');
    }

    function uploadEmojiSticker(file) {
        if (file.size > 2 * 1024 * 1024) {
            toast('warning', '表情图片不要超过 2 MB');
            return;
        }
        $('#imEmojiTip').text('正在上传表情…');
        var reader = new FileReader();
        reader.onload = function () {
            var durl = String(reader.result || '');
            var img = new Image();
            img.onload = function () { doAddEmoji(durl, file.name || '表情', img.width, img.height); };
            img.onerror = function () { doAddEmoji(durl, file.name || '表情', 0, 0); };
            img.src = durl;
        };
        reader.onerror = function () { $('#imEmojiTip').text('读取图片失败，请重试'); };
        reader.readAsDataURL(file);
    }

    function doAddEmoji(durl, name, w, h) {
        Api.msg.upload({ fileName: name, data: durl, kind: 'image', width: w, height: h })
            .done(function (res) {
                var up = payload(res);
                if (!up || !up.fileId) { $('#imEmojiTip').text('上传失败，请重试'); return; }
                Api.msg.emojiAdd({ fileId: up.fileId, name: name })
                    .done(function (r2) {
                        var d2 = payload(r2);
                        if (!d2 || !d2.id) { $('#imEmojiTip').text('添加失败'); return; }
                        loadEmojis(function () {
                            STATE.emojiTab = 'sticker';
                            renderEmojiPanel();
                            toast('success', '表情包已添加');
                        });
                    })
                    .fail(function (e) {
                        $('#imEmojiTip').text((e && e.message) || '添加失败');
                        toast('error', (e && e.message) || '添加失败');
                    });
            })
            .fail(function () { $('#imEmojiTip').text('上传失败，请重试'); });
    }

    function removeEmojiSticker(id) {
        Api.msg.emojiRemove(id).done(function () {
            STATE.emojis = STATE.emojis.filter(function (x) { return String(x.id) !== String(id); });
            renderEmojiPanel();
            toast('success', '表情包已删除');
        }).fail(function (e) { toast('error', (e && e.message) || '删除失败'); });
    }

    /** 发送一个图片表情包（复用附件发送，msgType=sticker） */
    function sendSticker(it) {
        if (!it || !it.fileId) { return; }
        var peer = STATE.activePeer, gid = STATE.activeGroup;
        if (!peer && !gid) { toast('warning', '请先选择会话'); return; }
        var tempId = 't' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
        var msg = {
            id: tempId, tempId: tempId, senderId: STATE.me, receiverId: peer || 0,
            groupId: gid || '', content: '[表情]', msgType: 'sticker',
            attachId: it.fileId,
            attach: {
                fileId: it.fileId, name: it.name || '表情', url: it.url,
                size: 0, kind: 'image', ext: 'png', width: it.width, height: it.height
            },
            senderName: (STATE.meInfo && STATE.meInfo.name) || '我',
            sendTime: nowHM(), isMe: true, read: 0, temp: true
        };
        pushMsg(chatKey(), msg);
        renderChat();
        closeEmojiPanel();
        deliver({ peer: peer, group: gid }, msg, tempId);
    }

    // ---------------- 媒体：图片 / 文件 / 截屏 / 粘贴 ----------------
    function uploadFile(file, kind) {
        if (!STATE.activePeer && !STATE.activeGroup) { toast('warning', '请先选择会话'); return; }
        if (!file) { return; }
        if (file.size > IM_MAX_BYTES) {
            setStatus('附件不能超过 20 MB', true);
            toast('error', '附件不能超过 20 MB');
            return;
        }
        var name = file.name || ('粘贴图片_' + stamp() + '.png');
        setStatus('正在读取 ' + name + '…');
        var reader = new FileReader();
        reader.onload = function () {
            var durl = String(reader.result || '');
            if (kind === 'image') {
                // 先量一下图片尺寸，气泡占位不抖（量不到就按 0 走，不影响发送）
                var img = new Image();
                img.onload = function () { doUploadAndSend(durl, name, 'image', img.width, img.height); };
                img.onerror = function () { doUploadAndSend(durl, name, 'image', 0, 0); };
                img.src = durl;
            } else {
                doUploadAndSend(durl, name, 'file', 0, 0);
            }
        };
        reader.onerror = function () { setStatus('读取文件失败，请重试', true); };
        reader.readAsDataURL(file);
    }

    function doUploadAndSend(durl, name, kind, w, h) {
        STATE.uploading = true;
        setStatus('正在上传 ' + name + '…');
        Api.msg.upload({ fileName: name, data: durl, kind: kind, width: w, height: h })
            .done(function (res) {
                STATE.uploading = false;
                var d = payload(res);
                if (!d || !d.fileId) {
                    setStatus('上传失败，请重试', true);
                    toast('error', '上传失败，请重试');
                    return;
                }
                var att = {
                    fileId: d.fileId, name: d.name || d.fileName || name,
                    url: d.url || durl, size: d.size || d.fileSize || 0,
                    kind: d.kind || kind, width: w, height: h,
                    ext: d.ext || extOf(name), mimeType: d.mimeType || ''
                };
                setStatus('');
                sendAttachment(att);
            })
            .fail(function () {
                STATE.uploading = false;
                setStatus('上传失败，请重试', true);
                toast('error', '上传失败，请重试');
            });
    }

    /** 截屏：getDisplayMedia 抓一帧 → 打开编辑器（拖选区域 + 标注）→ 发送 */
    function takeShot() {
        var md = navigator.mediaDevices;
        if (!md || !md.getDisplayMedia) {
            setStatus('当前浏览器不支持截屏，可直接 Ctrl+V 粘贴截图', true);
            toast('warning', '当前浏览器不支持截屏，可用 Ctrl+V 粘贴截图');
            return;
        }
        setStatus('请在弹窗里选择要截取的窗口或屏幕…');
        md.getDisplayMedia({ video: true, audio: false }).then(function (stream) {
            var video = document.createElement('video');
            video.muted = true;
            video.setAttribute('playsinline', 'playsinline');
            video.srcObject = stream;
            var done = false;
            function finish(durl, w, h, err) {
                if (done) { return; }
                done = true;
                try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 忽略 */ }
                if (err) { setStatus(err, true); return; }
                setStatus('已捕获画面，请拖动选择要截取的区域');
                // 有编辑器就交给它框选 + 标注；没加载成功则退回「整屏直接发」
                if (window.IMShot && window.IMShot.open) {
                    window.IMShot.open(durl, {
                        onSend: function (outUrl, ow, oh) {
                            setStatus('截屏已标注，正在发送…');
                            doUploadAndSend(outUrl, '截屏_' + stamp() + '.png', 'image', ow, oh);
                        },
                        onCancel: function () { setStatus('已取消截屏'); }
                    });
                    return;
                }
                setStatus('截屏已捕获，正在发送…');
                doUploadAndSend(durl, '截屏_' + stamp() + '.png', 'image', w, h);
            }
            function grab() {
                try {
                    var w = video.videoWidth, h = video.videoHeight;
                    if (!w || !h) { finish(null, 0, 0, '截屏失败：拿不到画面尺寸'); return; }
                    var c = document.createElement('canvas');
                    c.width = w;
                    c.height = h;
                    c.getContext('2d').drawImage(video, 0, 0, w, h);
                    finish(c.toDataURL('image/png'), w, h);
                } catch (e) {
                    finish(null, 0, 0, '截屏失败：' + (e && e.message ? e.message : e));
                }
            }
            video.onloadedmetadata = function () {
                // 等一帧真正绘制出来，否则可能抓到黑屏
                window.setTimeout(grab, 220);
            };
            try { video.play(); } catch (e) { /* 某些浏览器返回 Promise */ }
            window.setTimeout(function () { if (!done) { grab(); } }, 1500);
        }).catch(function (err) {
            var name = (err && err.name) || '';
            if (name === 'NotAllowedError' || name === 'AbortError') {
                setStatus('已取消截屏');
            } else {
                setStatus('截屏失败：' + (err && err.message ? err.message : name), true);
            }
        });
    }

    /* ---------------- 语音消息：MediaRecorder 录音 → 上传 → 发送 audio ----------------
       说明：原来用的是 SpeechRecognition 听写（依赖浏览器云端识别服务，内网/离线必报 network 错），
       现改为本地录音后作为语音消息发送，不依赖任何云服务。 */
    var VOICE = {
        on: false, rec: null, chunks: [], startAt: 0, timer: null,
        ctx: null, analyser: null, meterTimer: null, peak: 0, meterOn: false
    };

    /** 录音期间用 AnalyserNode 量电平：录完全程≈0 就判定「麦克风没收到声音」 */
    function startLevelMeter(stream) {
        VOICE.meterOn = false;
        VOICE.peak = 0;
        try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) { return; }
            VOICE.ctx = new AC();
            var src = VOICE.ctx.createMediaStreamSource(stream);
            VOICE.analyser = VOICE.ctx.createAnalyser();
            VOICE.analyser.fftSize = 1024;
            src.connect(VOICE.analyser);
            VOICE.meterOn = true;
            VOICE.meterTimer = window.setInterval(function () {
                if (!VOICE.analyser) { return; }
                var buf = new Uint8Array(VOICE.analyser.fftSize);
                VOICE.analyser.getByteTimeDomainData(buf);
                var peak = 0;
                for (var i = 0; i < buf.length; i++) {
                    var v = Math.abs((buf[i] - 128) / 128);
                    if (v > peak) { peak = v; }
                }
                if (peak > VOICE.peak) { VOICE.peak = peak; }
            }, 120);
        } catch (e) { VOICE.meterOn = false; }
    }

    function voiceLevelText() {
        if (!VOICE.meterOn) { return ''; }
        var p = VOICE.peak;
        var bars = p < 0.01 ? '▁' : (p < 0.05 ? '▃' : (p < 0.15 ? '▅' : (p < 0.4 ? '▇' : '█')));
        return ' · 音量 ' + bars;
    }

    function stopLevelMeter() {
        if (VOICE.meterTimer) { window.clearInterval(VOICE.meterTimer); VOICE.meterTimer = null; }
        try { if (VOICE.ctx && VOICE.ctx.close) { VOICE.ctx.close(); } } catch (e) { /* 忽略 */ }
        VOICE.ctx = null;
        VOICE.analyser = null;
    }

    function voiceSupported() {
        return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }
    function voiceMime() {
        var cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
        for (var i = 0; i < cands.length; i++) {
            try {
                if (!window.MediaRecorder.isTypeSupported || window.MediaRecorder.isTypeSupported(cands[i])) { return cands[i]; }
            } catch (e) { /* 忽略 */ }
        }
        return '';
    }

    function toggleVoice() {
        if (VOICE.on) { stopVoice(true); return; }
        if (!voiceSupported()) {
            setStatus('当前浏览器不支持录音，建议用 Chrome / Edge', true);
            toast('warning', '当前浏览器不支持录音');
            return;
        }
        var mime = voiceMime();
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
            var rec;
            try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {}); }
            catch (e) { rec = new MediaRecorder(stream); }
            VOICE.rec = rec;
            VOICE.chunks = [];
            VOICE.on = true;
            STATE.voiceOn = true;
            $('#imVoice').addClass('is-active');
            VOICE.startAt = Date.now();
            startLevelMeter(stream);
            setStatus('录音中… 0s，点一下麦克风结束并发送');
            if (VOICE.timer) { window.clearInterval(VOICE.timer); }
            VOICE.timer = window.setInterval(function () {
                var secs = Math.floor((Date.now() - VOICE.startAt) / 1000);
                setStatus('录音中… ' + secs + 's' + voiceLevelText());
            }, 400);
            rec.ondataavailable = function (ev) {
                if (ev.data && ev.data.size) { VOICE.chunks.push(ev.data); }
            };
            rec.onstop = function () {
                var type = String(rec.mimeType || mime || 'audio/webm').split(';')[0];
                var sec = Math.max(1, Math.round((Date.now() - VOICE.startAt) / 1000));
                var peak = VOICE.peak;
                var meterOn = VOICE.meterOn;
                stopLevelMeter();
                try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 忽略 */ }
                var blob = null;
                try { blob = new Blob(VOICE.chunks, { type: type }); } catch (e) { blob = null; }
                VOICE.chunks = [];
                // 全程没有电平 → 麦克风没收到声音：不发出去，直接提示（否则用户会收到一段静音）
                if (meterOn && peak < 0.01) {
                    setStatus('没有检测到声音：请检查麦克风是否被静音、或系统默认输入设备是否选对', true);
                    return;
                }
                finishVoice(blob, type, sec);
            };
            try { rec.start(); }
            catch (e) {
                setStatus('录音启动失败，请重试', true);
                stopVoice(false);
            }
        }).catch(function (err) {
            var name = (err && err.name) || '';
            var m = (name === 'NotAllowedError' || name === 'SecurityError')
                ? '麦克风被拒绝，请在地址栏允许麦克风权限'
                : (name === 'NotFoundError' ? '找不到麦克风设备' : ('录音启动失败：' + (name || '未知错误')));
            setStatus(m, true);
            toast('error', m);
            stopVoice(false);
        });
    }

    /** send=false 表示放弃这次录音（不发） */
    function stopVoice(send) {
        var rec = VOICE.rec;
        VOICE.on = false;
        STATE.voiceOn = false;
        $('#imVoice').removeClass('is-active');
        if (VOICE.timer) { window.clearInterval(VOICE.timer); VOICE.timer = null; }
        stopLevelMeter();
        VOICE.rec = null;
        if (rec && rec.state !== 'inactive') {
            if (send === false) { try { rec.onstop = null; } catch (e) { /* 忽略 */ } }
            try { rec.stop(); } catch (e) { /* 已停止 */ }
        } else if (send) {
            setStatus('没有录到声音', true);
        }
    }

    /** 录音结束：自己读成 dataURL → 上传 → 作为 audio 消息发出 */
    function finishVoice(blob, type, sec) {
        if (!blob || !blob.size) { setStatus('没有录到声音', true); return; }
        if (blob.size > IM_MAX_BYTES) { setStatus('语音太长，请分段发送', true); return; }
        var ext = type.indexOf('ogg') >= 0 ? 'ogg' : (type.indexOf('mp4') >= 0 ? 'm4a' : 'webm');
        var name = '语音_' + sec + 's_' + stamp() + '.' + ext;
        setStatus('正在发送语音…');
        var reader = new FileReader();
        reader.onload = function () {
            Api.msg.upload({ fileName: name, data: String(reader.result || ''), kind: 'file' })
                .done(function (res) {
                    var d = payload(res);
                    if (!d || !d.fileId) { setStatus('语音发送失败，请重试', true); return; }
                    setStatus('');
                    sendAttachment({
                        fileId: d.fileId, name: d.name || name, url: d.url || '',
                        size: d.size || blob.size, kind: 'file', ext: ext,
                        mimeType: type, msgType: 'audio'
                    });
                })
                .fail(function () { setStatus('语音上传失败，请重试', true); });
        };
        reader.onerror = function () { setStatus('读取录音失败，请重试', true); };
        reader.readAsDataURL(blob);
    }

    function bindPaste() {
        $(document).on('paste', function (e) {
            var ev = e.originalEvent || e;
            var cd = ev.clipboardData;
            if (!cd || !cd.items) { return; }
            for (var i = 0; i < cd.items.length; i++) {
                var it = cd.items[i];
                if (it.kind === 'file' && /^image\//i.test(it.type || '')) {
                    var f = it.getAsFile ? it.getAsFile() : null;
                    if (f) {
                        e.preventDefault();
                        uploadFile(f, 'image');
                        return;
                    }
                }
            }
        });
    }

    // ---------------- 群组 ----------------
    function mergeGroup(g) {
        if (!g || !g.groupId) { return; }
        var old = STATE.groups[g.groupId] || {};
        STATE.groups[g.groupId] = $.extend({}, old, g);
    }
    function loadGroups(done) {
        Api.msg.groups().done(function (res) {
            var d = payload(res);
            if (d) {
                var map = {};
                $.each(d.list || [], function (i, g) { map[g.groupId] = g; });
                STATE.groups = map;
                renderContacts();
                tryPendingTarget();
                notifyFrame();
            }
            if (done) { done(); }
        }).fail(function () { if (done) { done(); } });
    }

    function openGroupDialog() {
        var tpl = $('#groupTpl').html() || '';
        if (!HAS_UI || !window.UI.dialog) { toast('info', '当前环境不支持弹窗'); return; }
        var picked = {};
        // 注意：UI.dialog 在构造过程中就会回调 onReady，那时 dialog() 还没返回，
        // 所以「确定」的处理函数先挂在 submitRef 上，再由 onOk 调用（不能写 dlg.submit = ...）。
        var submitRef = null;
        window.UI.dialog({
            title: '创建群聊', width: 480, content: tpl,
            onReady: function ($body, close) {
                var $list = $body.find('#imGroupPickList');
                var $cnt = $body.find('#imGroupPicked');
                function refreshCount() {
                    var n = 0;
                    $.each(picked, function (k, v) { if (v) { n++; } });
                    $cnt.text('已选 ' + n + ' 人');
                }
                function paint() {
                    $list.find('.im-group-pick__item').each(function () {
                        var id = parseInt($(this).attr('data-emp'), 10);
                        $(this).toggleClass('is-checked', !!picked[id]);
                    });
                    refreshCount();
                }
                function draw() {
                    $list.empty();
                    var arr = [];
                    $.each(STATE.contacts, function (k, c) { arr.push(c); });
                    arr.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
                    if (!arr.length) { $list.append('<div class="emp-pick__empty">暂无可选同事</div>'); return; }
                    $.each(arr, function (i, c) {
                        var $it = $('<div class="im-group-pick__item" data-emp="' + c.empId + '">' +
                            '<div class="im-avatar" style="width:32px;height:32px;font-size:13px;">' +
                                esc(c.avatarText || avText(c.name)) + '</div>' +
                            '<div style="margin-left:10px;">' +
                                '<span class="im-group-pick__name">' + esc(c.name) + '</span>' +
                                '<span class="im-group-pick__sub">' + esc(c.deptName || '') + '</span>' +
                            '</div></div>');
                        $it.on('click', function () {
                            picked[c.empId] = !picked[c.empId];
                            paint();
                        });
                        $list.append($it);
                    });
                    paint();
                }
                draw();
                submitRef = function () {
                    var ids = [];
                    $.each(picked, function (k, v) { if (v) { ids.push(parseInt(k, 10)); } });
                    if (!ids.length) { toast('warning', '请至少选择一位群成员'); return false; }
                    var name = $.trim($body.find('#imGroupName').val() || '');
                    Api.msg.groupAdd({ groupName: name, memberIds: ids }).done(function (res) {
                        var d = payload(res);
                        if (!d || !d.groupId) { toast('error', '创建失败'); return; }
                        mergeGroup(d.group || { groupId: d.groupId, name: d.name, memberCount: d.memberCount });
                        close();
                        openGroup(d.groupId);
                        toast('success', d.message || '群创建成功');
                    }).fail(function () { toast('error', '创建失败，请重试'); });
                    return true;
                };
            },
            onOk: function () {
                if (submitRef && submitRef() === false) { return; }
            }
        });
    }

    /** 是否是群主：优先用后端返回的 isOwner，缺失时用 ownerId 与本人比对兜底 */
    function amGroupOwner(gid) {
        var g = STATE.groups[gid];
        if (!g) { return false; }
        if (g.isOwner === true) { return true; }
        return !!g.ownerId && parseInt(g.ownerId, 10) === parseInt(STATE.me, 10);
    }

    /** 刷新「改名」入口的可见性（聊天头小图标 / 群列表铅笔）：只有群主可见 */
    function syncRenameEntries() {
        var gid = STATE.activeGroup;
        var $edit = $('#imChatTitleEdit');
        if (gid && amGroupOwner(gid)) { $edit.removeAttr('hidden'); }
        else { $edit.attr('hidden', 'hidden'); }
        $('#imContacts .im-contact.is-group').each(function () {
            var g = this.getAttribute('data-group');
            var $pen = $(this).find('.im-contact__rename');
            if (amGroupOwner(g)) { $pen.removeAttr('hidden'); } else { $pen.attr('hidden', 'hidden'); }
        });
    }

    /** 群重命名（仅群主）：成功后同步群列表、聊天头标题与提醒中心 */
    function openGroupRename(gid, onDone) {
        var g = STATE.groups[gid] || {};
        if (!gid || !amGroupOwner(gid)) { toast('warning', '只有群主可以修改群名称'); return; }
        var tpl = $('#groupRenameTpl').html() || '';
        var submitRef = null;
        window.UI.dialog({
            title: '重命名群聊', width: 420, content: tpl,
            onReady: function ($body, close) {
                var $input = $body.find('#imGroupRenameInput');
                var $err = $body.find('#imGroupRenameErr');
                $input.val(g.name || '').on('input', function () { $err.text(''); });
                window.setTimeout(function () { $input.trigger('focus').trigger('select'); }, 60);
                submitRef = function () {
                    var name = $.trim($input.val() || '');
                    if (!name) { $err.text('群名称不能为空'); $input.trigger('focus'); return false; }
                    if (name.length > 100) { $err.text('群名称不能超过 100 个字'); return false; }
                    if (name === (g.name || '')) { close(); return false; }
                    $err.text('');
                    Api.msg.groupUpdate({ groupId: gid, groupName: name }).done(function (res) {
                        var d = payload(res);
                        var ng = (d && d.group) || {};
                        // 同步本地群对象：名称 + 头像首字（后端也会同步 avatarText）
                        g.name = ng.name || name;
                        g.avatarText = ng.avatarText || g.name.slice(0, 1);
                        g.memberCount = ng.memberCount || g.memberCount;
                        if (STATE.activeGroup === gid) {
                            $('#imChatTitle').text(g.name);
                        }
                        renderContacts();
                        notifyFrame();
                        close();
                        toast('success', '群名称已修改');
                        if (typeof onDone === 'function') { onDone(g.name); }
                    }).fail(function (e) {
                        $err.text((e && e.message) || '修改失败，请重试');
                    });
                    return false;   // 由接口回调决定何时关闭
                };
            },
            onOk: function () { if (submitRef) { submitRef(); } }
        });
    }

    // ---------------- 群聊 @ 组员 ----------------
    /** 群成员缓存（打开群 / 看群成员时预热，@ 选人直接用） */
    function cacheMembers(gid, members) {
        if (!gid || !members || !members.length) { return; }
        STATE.groupMembers[gid] = members;
    }

    function loadMembers(gid, done) {
        if (STATE.groupMembers[gid] && STATE.groupMembers[gid].length) {
            if (done) { done(STATE.groupMembers[gid]); }
            return;
        }
        Api.msg.groupDetail(gid).done(function (res) {
            var d = payload(res);
            var list = (d && d.members) || [];
            cacheMembers(gid, list);
            if (done) { done(list); }
        }).fail(function () { if (done) { done([]); } });
    }

    function mentionPanel() {
        var $p = $('#imMention');
        if ($p.length) { return $p; }
        $p = $('<div class="im-mention" id="imMention" hidden>' +
            '<div class="im-mention__hd">选择要 @ 的组员<span class="im-mention__close" id="imMentionClose">×</span></div>' +
            '<input class="im-mention__kw" id="imMentionKw" type="text" placeholder="搜索姓名">' +
            '<div class="im-mention__list" id="imMentionList"></div>' +
            '</div>');
        $p.appendTo('.im-input');
        $p.on('click', '.im-mention__close', function () { closeMentionPanel(); });
        $p.on('input', '#imMentionKw', function () { renderMentionList($(this).val()); });
        $p.on('click', '.im-mention__item', function () {
            insertMention({
                empId: parseInt($(this).attr('data-emp'), 10),
                name: String($(this).attr('data-name') || '')
            });
        });
        return $p;
    }

    function renderMentionList(keyword) {
        var gid = STATE.activeGroup;
        var list = STATE.groupMembers[gid] || [];
        var kw = $.trim(keyword || '').toLowerCase();
        var html = '', shown = 0;
        for (var i = 0; i < list.length; i++) {
            var m = list[i] || {};
            if (parseInt(m.empId, 10) === parseInt(STATE.me, 10)) { continue; }   // 不 @ 自己
            if (kw && String(m.name || '').toLowerCase().indexOf(kw) < 0) { continue; }
            html += '<div class="im-mention__item" data-emp="' + m.empId + '" data-name="' + esc(m.name) + '">' +
                '<span class="im-mention__av">' + esc(avText(m.name)) + '</span>' +
                '<span class="im-mention__name">' + esc(m.name) + '</span>' +
                (m.isOwner ? '<span class="im-member__tag">群主</span>' : '') +
                '</div>';
            shown++;
        }
        if (!shown) {
            html = '<div class="im-mention__empty">' +
                (kw ? '没有匹配的组员' : '群里还没有其他成员') + '</div>';
        }
        $('#imMentionList').html(html);
    }

    /** 打开 @ 选人浮层（只在群聊里可用） */
    function openMentionPicker() {
        var gid = STATE.activeGroup;
        if (!gid) {
            toast('warning', '只有群聊里可以 @ 组员');
            return;
        }
        var $p = mentionPanel();
        $p.removeAttr('hidden');
        STATE.atOpen = true;
        $('#imMentionKw').val('');
        if (STATE.groupMembers[gid] && STATE.groupMembers[gid].length) {
            renderMentionList('');
        } else {
            $('#imMentionList').html('<div class="im-mention__empty">加载中…</div>');
            loadMembers(gid, function () { renderMentionList(''); });
        }
    }

    function closeMentionPanel() {
        STATE.atOpen = false;
        $('#imMention').attr('hidden', 'hidden');
    }

    /** 删掉刚才键入的 @（点选后不希望留下一个孤零零的 @） */
    function dropTrailingAt() {
        var el = EDITOR && EDITOR.el;
        if (!el) { return; }
        var texts = [], node;
        try {
            var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
            while ((node = walker.nextNode())) { texts.push(node); }
        } catch (e) {
            texts = $(el).find('*').addBack().contents().filter(function () {
                return this.nodeType === 3;
            }).toArray();
        }
        var last = null;
        for (var i = 0; i < texts.length; i++) {
            if (String(texts[i].nodeValue || '').replace(/\s/g, '')) { last = texts[i]; }
        }
        if (!last) { return; }
        var v = String(last.nodeValue || '');
        if (v.charAt(v.length - 1) === '@') { last.nodeValue = v.slice(0, -1); }
    }

    /** 插入 @某人（可点选，也可键入 @ 后选择） */
    function insertMention(member) {
        if (!member || !member.empId) { return; }
        if (!EDITOR) { return; }
        closeMentionPanel();
        dropTrailingAt();
        EDITOR.restoreRange();
        EDITOR.insertHtml('<span class="im-at" data-emp="' + member.empId + '">@' +
            esc(member.name) + '</span>&nbsp;');
        EDITOR.focus();
    }

    function openGroupMembers() {
        var gid = STATE.activeGroup;
        if (!gid) { return; }
        var g = STATE.groups[gid] || {};
        var tpl = $('#groupMembersTpl').html() || '';
        window.UI.dialog({
            title: '群成员 —— ' + (g.name || ''), width: 420, content: tpl,
            onReady: function ($body, close) {
                var $tip = $body.find('#imGroupMemberTip');
                var $list = $body.find('#imGroupMemberList');
                var $leave = $body.find('#imGroupLeave');
                var $nameVal = $body.find('#imGroupNameVal');
                var $rename = $body.find('#imGroupRename');
                $nameVal.text(g.name || '—');
                // 只有群主能看到「重命名」；非群主明确告诉原因，避免以为按钮坏了
                if (amGroupOwner(gid)) {
                    $rename.removeAttr('hidden');
                } else {
                    $rename.attr('hidden', 'hidden');
                    $tip.before('<div class="im-tip im-group-owner-tip">只有群主可以修改群名称</div>');
                }
                $rename.on('click', function () {
                    openGroupRename(gid, function (newName) {
                        $nameVal.text(newName);
                        var dlgTitle = $body.closest('.el-dialog').find('.el-dialog__title');
                        if (dlgTitle.length) { dlgTitle.text('群成员 —— ' + newName); }
                    });
                });
                Api.msg.groupDetail(gid).done(function (res) {
                    var d = payload(res);
                    if (!d) { $list.append('<div class="emp-pick__empty">加载失败</div>'); return; }
                    mergeGroup(d);
                    cacheMembers(gid, d.members);
                    $tip.text('共 ' + (d.memberCount || 0) + ' 人 · 群主：' + (d.ownerName || '—'));
                    $list.empty();
                    $.each(d.members || [], function (i, m) {
                        $list.append('<div class="im-member" data-emp="' + m.empId + '">' +
                            '<div class="im-avatar" style="width:30px;height:30px;font-size:13px;">' +
                                esc(avText(m.name)) + '</div>' +
                            '<div style="margin-left:10px;font-size:13px;color:#303133;">' + esc(m.name) +
                                (m.isOwner ? '<span class="im-member__tag">群主</span>' : '') +
                                (m.empId === STATE.me ? '<span class="im-member__tag">我</span>' : '') +
                            '</div></div>');
                    });
                    $leave.text(d.isOwner ? '解散群聊' : '退出群聊');
                }).fail(function () { $list.append('<div class="emp-pick__empty">加载失败</div>'); });
                $leave.on('click', function () {
                    var isOwner = !!(STATE.groups[gid] && STATE.groups[gid].isOwner);
                    var tip = isOwner
                        ? '确定解散该群吗？（群聊将从所有成员的列表里消失，历史消息不再展示）'
                        : '确定退出该群吗？退出后将不再接收群消息。';
                    confirmDialog(isOwner ? '解散群聊' : '退出群聊', tip, function () {
                        Api.msg.groupRemove(gid).done(function (res) {
                            var d = payload(res);
                            close();
                            delete STATE.groups[gid];
                            delete STATE.convo['g' + gid];
                            if (STATE.activeGroup === gid) {
                                STATE.activeGroup = '';
                                $('#imChat').hide();
                                $('#imEmpty').show();
                                $('#imGroupMembers').prop('hidden', true);
                            }
                            renderContacts();
                            notifyFrame();
                            toast('success', (d && d.message) || '操作成功');
                        }).fail(function () { toast('error', '操作失败，请重试'); });
                    });
                });
            }
        });
    }

    // ---------------- WebSocket 事件 ----------------
    function dispatch(obj) {
        if (!obj || !obj.type) { return; }
        switch (obj.type) {
            case 'serverHello': return onServerHello(obj);
            case 'msg': return onIncoming(obj);
            case 'ack': return onAck(obj);
            case 'presence': return onPresence(obj, obj.online === undefined ? true : !!obj.online);
            case 'offline': return onPresence(obj, false);
            case 'read': return onRead(obj);
            case 'typing': return onTyping(obj);
            case 'authFail':
                STATE.manualClose = true;
                toast('error', obj.message || '登录已失效，请重新登录');
                return;
            case 'pong': return; // 心跳回包，忽略
            default: return;
        }
    }

    function onServerHello(obj) {
        STATE.me = parseInt(obj.me, 10) || STATE.me;
        if (obj.meInfo) { STATE.meInfo = obj.meInfo; }
        renderMe();
        STATE.contacts = {};
        $.each(obj.contacts || [], function (i, c) {
            STATE.contacts[parseInt(c.empId, 10)] = c;
        });
        if (obj.groups) {
            STATE.groups = {};
            $.each(obj.groups, function (i, g) { if (g && g.groupId) { STATE.groups[g.groupId] = g; } });
        }
        if (STATE.activePeer && STATE.contacts[STATE.activePeer]) {
            var c = STATE.contacts[STATE.activePeer];
            $('#imChatSub').html(c.online
                ? '<span class="im-chat__online">● 在线</span>'
                : '<span class="im-chat__offline">○ 离线</span>');
        }
        renderContacts();
        tryPendingTarget();
        notifyFrame();
    }

    function onIncoming(obj) {
        var gid = String(obj.groupId || '');
        if (gid) { return onGroupIncoming(obj, gid); }
        var peer = parseInt(obj.senderId, 10);
        if (!peer) { return; }
        var key = String(peer);
        var msg = {
            id: obj.id, senderId: peer, receiverId: STATE.me, content: obj.content,
            contentHtml: obj.contentHtml || '', atEmpIds: obj.atEmpIds || '',
            msgType: obj.msgType || 'text', attachId: obj.attachId || '', attach: obj.attach || null,
            senderName: obj.senderName || (STATE.contacts[peer] && STATE.contacts[peer].name) || ('员工' + peer),
            sendTime: obj.sendTime || nowHM(), isMe: false, read: 0
        };
        pushMsg(key, msg);
        var c = STATE.contacts[peer];
        if (c) {
            if (peer === STATE.activePeer && !STATE.activeGroup) {
                renderChat();
                sendReadReceipt(peer);
            } else {
                c.unread = (c.unread || 0) + 1;
            }
            updateContactLast(peer, previewOf(msg), obj.sendTime || nowHM(), false);
            renderContacts();
            notifyFrame();
        } else {
            renderContacts();
        }
    }

    function onGroupIncoming(obj, gid) {
        var key = 'g' + gid;
        var msg = {
            id: obj.id, senderId: parseInt(obj.senderId, 10) || 0,
            senderName: obj.senderName || ('员工' + obj.senderId),
            receiverId: 0, groupId: gid, content: obj.content,
            contentHtml: obj.contentHtml || '', atEmpIds: obj.atEmpIds || '',
            msgType: obj.msgType || 'text', attachId: obj.attachId || '', attach: obj.attach || null,
            sendTime: obj.sendTime || nowHM(), isMe: false, read: 0
        };
        pushMsg(key, msg);
        var g = STATE.groups[gid];
        if (!g) {
            // 别人把我拉进了新群：拉一次群列表
            loadGroups(function () { if (STATE.activeGroup === gid) { openGroup(gid); } });
            return;
        }
        if (STATE.activeGroup === gid) {
            renderChat();
            markGroupRead(gid);
        } else {
            g.unread = (g.unread || 0) + 1;
        }
        updateGroupLast(gid, previewOf(msg), obj.sendTime || nowHM(), false, msg.senderName);
        renderContacts();
        notifyFrame();
    }

    function previewOf(m) {
        var t = m.msgType || 'text';
        if (t === 'image') { return '[图片]'; }
        if (t === 'file') { return '[文件]' + (m.attach && m.attach.name ? (' ' + m.attach.name) : ''); }
        if (t === 'audio') { return '[语音]'; }
        return m.content;
    }

    function onAck(obj) {
        if (obj.error) {
            toast('error', obj.error);
            if (obj.tempId) { failTemp(obj.tempId, obj.error); }
            return;
        }
        locateTemp(obj.tempId, obj.id, obj.sendTime || nowHM());
        // 群回执：更新群列表最后一条
        var gid = String(obj.groupId || '');
        if (gid) {
            var preview = obj.msgType === 'image' ? '[图片]'
                : (obj.msgType === 'file' ? '[文件]' : (obj.content || ''));
            updateGroupLast(gid, preview, obj.sendTime || nowHM(), true);
        } else if (obj.receiverId && STATE.contacts[obj.receiverId]) {
            var preview2 = obj.msgType === 'image' ? '[图片]'
                : (obj.msgType === 'file' ? '[文件]' : (obj.content || ''));
            updateContactLast(obj.receiverId, preview2, obj.sendTime || nowHM(), true);
        }
        renderChat();
        renderContacts();
    }

    function onPresence(obj, online) {
        var empId = parseInt(obj.empId, 10);
        var c = STATE.contacts[empId];
        if (c) {
            c.online = !!online;
            if (empId === STATE.activePeer && !STATE.activeGroup) {
                $('#imChatSub').html(c.online
                    ? '<span class="im-chat__online">● 在线</span>'
                    : '<span class="im-chat__offline">○ 离线</span>');
            }
        }
        renderContacts();
    }

    function onRead(obj) {
        var peer = parseInt(obj.peerId, 10);
        var list = STATE.convo[peer];
        var changed = false;
        if (list) {
            for (var i = 0; i < list.length; i++) {
                if (list[i].isMe && !list[i].read) { list[i].read = 1; changed = true; }
            }
        }
        if (changed && peer === STATE.activePeer && !STATE.activeGroup) { renderChat(); }
    }

    function onTyping(obj) {
        if (parseInt(obj.from, 10) !== STATE.activePeer || STATE.activeGroup) { return; }
        showTyping(!!obj.on);
    }

    // ---------------- 连接管理 ----------------
    function connect() {
        STATE.manualClose = false;
        disconnectSocket();
        try {
            SOCKET = Api.msg.connect({});
        } catch (e) {
            updateConnection(false, '初始化失败');
            scheduleReconnect();
            return;
        }
        SOCKET.on('open', function () { updateConnection(true); STATE.reconnectDelay = 1000; });
        SOCKET.on('message', function (obj) { dispatch(obj); });
        SOCKET.on('close', function () {
            updateConnection(false, '已断开');
            if (!STATE.manualClose) { scheduleReconnect(); }
        });
        SOCKET.on('error', function () { /* 通常随后触发 close */ });
    }

    function disconnectSocket() {
        if (SOCKET && SOCKET.close) { try { SOCKET.close(); } catch (e) { /* 忽略 */ } }
        SOCKET = null;
    }

    function scheduleReconnect() {
        if (STATE.manualClose || STATE.reconnectTimer) { return; }
        var delay = STATE.reconnectDelay;
        STATE.reconnectTimer = window.setTimeout(function () {
            STATE.reconnectTimer = null;
            if (STATE.manualClose) { return; }
            connect();
            STATE.reconnectDelay = Math.min(STATE.reconnectDelay * 2, 10000);
        }, delay);
    }

    // ---------------- 输入中状态 ----------------
    var typingTimer = null;
    function sendTyping(to, on) {
        if (SOCKET && SOCKET.connected) { SOCKET.send({ type: 'typing', to: to, on: !!on }); }
        if (typingTimer) { window.clearTimeout(typingTimer); typingTimer = null; }
        if (on) {
            typingTimer = window.setTimeout(function () { sendTyping(to, false); }, 2500);
        }
    }

    // ---------------- 联系人选择弹窗 ----------------
    function openPicker() {
        var tpl = $('#empPickTpl').html() || '';
        if (!HAS_UI || !window.UI.dialog) {
            toast('info', '请点击左侧联系人发起会话');
            return;
        }
        window.UI.dialog({
            title: '选择同事发起会话', width: 460,
            content: tpl,
            onReady: function ($body, close) {
                var $list = $body.find('#empPickList').empty();
                function load() {
                    Api.msg.contacts().done(function (res) {
                        var d = payload(res);
                        var arr = (d && d.list) || [];
                        renderPicker($list, arr, close);
                    }).fail(function () {
                        var arr = []; $.each(STATE.contacts, function (k, c) { arr.push(c); });
                        renderPicker($list, arr, close);
                    });
                }
                $body.find('#empPickSearch').on('input', function () {
                    var kw = $.trim($(this).val()).toLowerCase();
                    var arr = []; $.each(STATE.contacts, function (k, c) { arr.push(c); });
                    if (kw) {
                        arr = arr.filter(function (c) {
                            return [c.name, c.deptName, c.jobTitle].join(' ').toLowerCase().indexOf(kw) >= 0;
                        });
                    }
                    renderPicker($list, arr, close);
                });
                load();
            }
        });
    }
    function renderPicker($list, arr, close) {
        $list.empty();
        if (!arr.length) { $list.append('<div class="emp-pick__empty">暂无可聊天的同事</div>'); return; }
        arr.sort(function (a, b) { return (a.online !== b.online) ? (a.online ? -1 : 1) : (a.name || '').localeCompare(b.name || ''); });
        $.each(arr, function (i, c) {
            var $item = $(
                '<div class="emp-pick__item" data-emp="' + c.empId + '">' +
                    '<div class="im-avatar" style="width:34px;height:34px;font-size:14px;">' + esc(avText(c.name)) +
                        '<span class="im-dot' + (c.online ? ' is-online' : '') + '"></span></div>' +
                    '<div style="margin-left:10px;">' +
                        '<div style="font-size:14px;color:#303133;">' + esc(c.name) +
                            (c.online ? ' <span style="color:#67c23a;font-size:12px;">在线</span>' : '') + '</div>' +
                        (c.deptName ? '<div style="font-size:12px;color:#909399;">' + esc(c.deptName) + '</div>' : '') +
                    '</div>' +
                '</div>');
            $item.on('click', function () { close(); openPeer(c.empId); });
            $list.append($item);
        });
    }

    // ---------------- 工具栏 ----------------
    function clearCurrent() {
        var peer = STATE.activePeer;
        if (!peer) { toast('warning', '群聊不支持清空会话'); return; }
        confirmDialog('清空会话', '确定清空与该同事的会话记录吗？（仅对你本人隐藏）', function () {
            var list = STATE.convo[peer] || [];
            var ids = [];
            for (var i = 0; i < list.length; i++) {
                if (list[i].id && String(list[i].id).indexOf('t') !== 0) { ids.push(list[i].id); }
            }
            STATE.convo[peer] = [];
            renderChat();
            var c = STATE.contacts[peer];
            if (c) { c.lastContent = ''; c.lastMessage = ''; c.lastTime = ''; renderContacts(); }
            if (ids.length) { Api.msg.remove(ids).fail(function () {}); }
            notifyFrame();
            toast('success', '会话已清空');
        });
    }

    function refreshAll() {
        Api.msg.contacts().done(function (res) {
            var d = payload(res);
            if (d) {
                STATE.contacts = {};
                $.each(d.list || [], function (i, c) { STATE.contacts[parseInt(c.empId, 10)] = c; });
                renderContacts();
                tryPendingTarget();
                notifyFrame();
            }
        }).fail(function () { toast('warning', '刷新失败，仍使用本地数据'); });
        loadGroups();
        if (STATE.activePeer) { openPeer(STATE.activePeer); }
        if (STATE.activeGroup) { openGroup(STATE.activeGroup); }
    }

    // ---------------- 启动 ----------------
    function bindUI() {
        $('.im__tab').on('click', function () {
            var t = $(this).attr('data-tab');
            if (!t) { return; }
            STATE.tab = t;
            $('.im__tab').removeClass('is-active');
            $(this).addClass('is-active');
            renderContacts();
        });
        $('#imSearch').on('input', function () { STATE.keyword = $.trim($(this).val()); renderContacts(); });
        /* 左侧「消息列」超宽被截断时，悬停显示完整内容（未超宽不出提示） */
        $('#imContacts').on('mouseenter', '.im-contact', function () {
            var el = this.querySelector('.im-contact__msg');
            hideMsgTip();
            if (!el) { return; }
            if (el.scrollWidth <= el.clientWidth + 1) { return; }
            msgTipTimer = window.setTimeout(function () { showMsgTip(el); }, 120);
        }).on('mouseleave', '.im-contact', hideMsgTip);
        $('#imContacts').on('scroll', hideMsgTip);
        $(window).on('scroll resize', hideMsgTip);
        $('#imSend').on('click', sendMessage);
        /* 输入区：富文本编辑器（格式工具栏 + contenteditable，见 js/rich-text.js）。
           媒体按钮行（图片 / 表情 / 文件 / 语音 / 截屏）保持原始布局：
           独立一行、紧贴编辑区正上方（格式栏之下），编辑区不会遮挡它们；
           @ 按钮只在群聊里有效。 */
        if (window.RichText) {
            EDITOR = window.RichText.mount($('#imText'), {
                placeholder: '输入消息，Enter 发送 / Shift+Enter 换行',
                label: '消息格式',
                at: true,
                onMention: function () { openMentionPicker(); }
            });
            /* 编辑器挂好后把媒体行放到「格式栏与编辑区之间」；
               重复初始化 / 局部刷新时 placeMediaTools 幂等，不会丢按钮 */
            placeMediaTools();
        }
        $('#imText').on('keydown', function (e) {
            if (e.keyCode === 13 && !e.shiftKey) { e.preventDefault(); sendMessage(); return; }
            /* 键入 @ 自动弹出组员选择（群聊里才有意义） */
            if ((e.key === '@' || e.keyCode === 50 && e.shiftKey) && STATE.activeGroup) {
                window.setTimeout(openMentionPicker, 0);
            }
        }).on('input', function () {
            if (STATE.activePeer && !STATE.activeGroup) { sendTyping(STATE.activePeer, true); }
        }).on('blur', function () {
            if (STATE.activePeer && !STATE.activeGroup && !STATE.voiceOn) { sendTyping(STATE.activePeer, false); }
        });
        // 媒体按钮：图片 / 文件 / 语音输入 / 截屏
        $('#imPickImage').on('click', function () {
            if (!STATE.activePeer && !STATE.activeGroup) { toast('warning', '请先选择会话'); return; }
            $('#imImageInput').val('').trigger('click');
        });
        $('#imPickFile').on('click', function () {
            if (!STATE.activePeer && !STATE.activeGroup) { toast('warning', '请先选择会话'); return; }
            $('#imFileInput').val('').trigger('click');
        });
        $('#imImageInput').on('change', function () {
            var f = this.files && this.files[0];
            if (f) { uploadFile(f, 'image'); }
            this.value = '';
        });
        $('#imFileInput').on('change', function () {
            var f = this.files && this.files[0];
            if (f) { uploadFile(f, 'file'); }
            this.value = '';
        });
        $('#imVoice').on('click', toggleVoice);
        $('#imShot').on('click', function () {
            if (!STATE.activePeer && !STATE.activeGroup) { toast('warning', '请先选择会话'); return; }
            takeShot();
        });
        bindPaste();
        // 图片点击放大
        // 显隐一律走 .is-open 类（不靠 hidden 属性：内联 CSS 的 display 会盖掉 [hidden]）
        function closeViewer() {
            $('#imViewer').removeClass('is-open').attr('hidden', 'hidden');
            $('#imViewerImg').attr('src', '');
        }
        function openViewer(src) {
            $('#imViewerImg').attr('src', src);
            $('#imViewer').addClass('is-open').removeAttr('hidden');
        }
        $('#imChatBody').on('click', '.im-img', function () {
            var src = $(this).attr('data-full') || $(this).attr('src');
            if (!src) { return; }
            openViewer(src);
        });
        $('#imViewerClose').on('click', closeViewer);
        $('#imViewer').on('click', function (e) {
            if (e.target === this) { closeViewer(); }
        });
        $(document).on('keydown', function (e) {
            if (e.keyCode === 27) {
                closeViewer();
                if (STATE.emojiOpen) { closeEmojiPanel(); }
                if (STATE.atOpen) { closeMentionPanel(); }
            }
        });
        /* 点 @ 浮层以外的地方收起（点条目本身由条目自己处理，所以判断 closest） */
        $(document).on('click', function (e) {
            if (!STATE.atOpen) { return; }
            if ($(e.target).closest('#imMention, [data-rt-cmd="mention"]').length) { return; }
            closeMentionPanel();
        });
        // 兜底：首屏若因任何原因残留了查看器（比如浏览器恢复了上次的 DOM 状态），强制关掉
        if (!$('#imViewer').hasClass('is-open')) { closeViewer(); }
        // 表情：按钮开合 + 面板交互（事件委托，面板重绘后不用重新绑）
        $('#imEmoji').on('click', function (e) {
            e.stopPropagation();
            toggleEmojiPanel();
        });
        $('#imEmojiPanel').on('click', function (e) { e.stopPropagation(); });
        $('#imEmojiTabs').on('click', '.im-emoji__tab', function () {
            STATE.emojiTab = $(this).attr('data-egroup') || 'recent';
            renderEmojiPanel();
        });
        $('#imEmojiBody').on('click', '.im-emoji__item', function () {
            insertEmoji($(this).attr('data-emoji') || '');
        });
        $('#imEmojiBody').on('click', '.im-emoji__del', function (e) {
            e.stopPropagation();
            var id = $(this).attr('data-del-id');
            if (id) { removeEmojiSticker(id); }
        });
        $('#imEmojiBody').on('click', '.im-emoji__sticker', function () {
            var id = $(this).attr('data-emoji-id');
            var hit = null;
            $.each(STATE.emojis, function (i, x) { if (String(x.id) === String(id)) { hit = x; } });
            if (hit) { sendSticker(hit); }
        });
        $('#imEmojiAdd').on('click', addEmojiSticker);
        // 点页面其它地方 / ESC 收起表情面板
        $(document).on('click', function () { if (STATE.emojiOpen) { closeEmojiPanel(); } });
        // 群组
        $('#btnGroup').on('click', openGroupDialog);
        $('#imGroupMembers').on('click', openGroupMembers);
        // 聊天头群名旁的铅笔：直接改名（仅群主可见）
        $('#imChatTitleEdit').on('click', function () {
            var gid = STATE.activeGroup;
            if (!gid) { return; }
            if (!amGroupOwner(gid)) { toast('warning', '只有群主可以修改群名称'); return; }
            openGroupRename(gid);
        });
        // 工具栏
        $('#btnWrite').on('click', openPicker);
        $('#btnMarkRead').on('click', function () {
            if (STATE.activeGroup) { markGroupRead(STATE.activeGroup); toast('success', '已标记为已读'); return; }
            if (STATE.activePeer) { sendReadReceipt(STATE.activePeer); toast('success', '已标记为已读'); }
        });
        $('#btnDelete').on('click', clearCurrent);
        $('#btnRefresh').on('click', refreshAll);
    }

    function boot() {
        loadRecentEmoji();
        bindUI();
        updateConnection(false, '连接中…');
        Api.msg.status().done(function (res) {
            var d = payload(res);
            if (d) {
                STATE.me = parseInt(d.empId, 10) || STATE.me;
                if (d.unread > 0) { notifyFrame(); }
            }
        }).fail(function () {});
        connect();
        // 主框架内嵌时 WS 一定拿得到群列表；单独打开也先拉一次兜底
        loadGroups();
    }

    $(function () { boot(); });

    // 暴露给探针 / 单测 / 主框架（提醒中心点条目时直接切会话）
    window.IM = {
        state: STATE,
        connect: connect,
        openPeer: openPeer,
        openGroup: openGroup,
        /** 联系人 / 群未就绪时先记下，等 serverHello / 刷新到位后自动进入 */
        openPeerLater: function (empId) {
            var id = parseInt(empId, 10) || 0;
            if (!id) { return false; }
            PENDING_PEER = id;
            PENDING_GROUP = '';
            return tryPendingTarget();
        },
        openGroupLater: function (groupId) {
            var gid = String(groupId || '');
            if (!gid) { return false; }
            PENDING_GROUP = gid;
            PENDING_PEER = 0;
            return tryPendingTarget();
        },
        send: sendMessage,
        uploadFile: uploadFile,
        sendAttachment: sendAttachment,
        takeShot: takeShot,
        toggleVoice: toggleVoice,
        stopVoice: stopVoice,
        openGroupDialog: openGroupDialog,
        toggleEmoji: toggleEmojiPanel,
        insertEmoji: insertEmoji,
        sendSticker: sendSticker,
        addEmojiSticker: addEmojiSticker,
        refreshEmojis: loadEmojis,
        isEmojiOnly: isEmojiOnly,
        refreshGroups: loadGroups,
        dispatch: dispatch,
        renderContacts: renderContacts,
        /* 富文本 / @ 组员（供页面内与自动化测试调用） */
        openMention: openMentionPicker,
        closeMention: closeMentionPanel,
        insertMention: insertMention,
        collectAtIds: collectAtIds,
        atMentionsMe: atMentionsMe,
        get editor() { return EDITOR; },
        get pendingPeer() { return PENDING_PEER; },
        get pendingGroup() { return PENDING_GROUP; },
        get socket() { return SOCKET; }
    };
})(window.jQuery);
