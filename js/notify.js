/* ==========================================================================
   notify.js —— 主框架「消息提醒中心」
   ----------------------------------------------------------------------------
   职责（只被 main.html 引用，功能页不加载）：
     1) 顶栏铃铛：红色数字气泡显示未读总数；
     2) 下拉面板：分「即时对话 / 新邮件」两段，点条目直接跳对应页面（对话带 ?peer=）；
     3) 左侧菜单上标：即时对话菜单项右上角「小红点 + 数字」，我的邮箱用橙色区分；
     4) 语音提醒：新对话到达时播提示音（WebAudio 合成，无需音频文件）+ 可选语音播报；
     5) 实时性：自己开一条 WebSocket（/ws/msg）收 msg 帧即时刷新；
        同时每 20 秒轮询 /api/notify/summary 兜底（邮件由后台线程收件，没有 WS 推送）。

   数据源统一为 Api.notify.summary()：
     {im:{unread, peers:[{empId,name,deptName,unread,lastContent,lastTime}]},
      mail:{configured, unread, items:[{id,fromAddr,fromName,subject,sentTime}]}, total}

   与 IM 页的分工：message.js 负责会话本身（气泡、已读回执），本文件只负责「全局提醒」；
   两边都收到同一条 msg 帧是正常的（后端把消息推给该员工的全部连接），
   提醒只在「未读数变大」时触发一次，不会重复响。
   ========================================================================== */
window.AppNotify = (function ($) {
    'use strict';

    var PREF_KEY = 'menu_admin_notify_pref';   // {sound:1, voice:1}
    var POLL_MS = 20000;                       // 轮询兜底间隔
    var STATE = {
        started: false,
        imUnread: 0,
        mailUnread: 0,
        total: 0,
        imPeers: [],
        imGroups: [],                          // 有未读的群（点条目走 ?group= 深链）
        mailItems: [],
        soundOn: true,
        voiceOn: true,
        lastAlertAt: 0,
        socket: null,
        socketClosed: false,
        pollTimer: null,
        reconnectTimer: null,
        reconnectDelay: 2000,
        refreshing: false,
        pending: false
    };
    var $bell, $dot, $panel, $body, $menu;
    var audioCtx = null;

    /* ---------------- 工具 ---------------- */
    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
    function cap(n) { return n > 99 ? '99+' : String(n); }
    function pageOf(url) {
        return String(url || '').split('#')[0].split('?')[0].replace(/^.*\//, '');
    }
    /** 时间显示：今天只给 HH:MM，其余给 MM-DD HH:MM */
    function shortTime(s) {
        s = String(s || '');
        var m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
        if (!m) { return s.slice(0, 5); }
        var d = new Date();
        var pad = function (x) { return (x < 10 ? '0' : '') + x; };
        var today = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
        var that = m[1] + m[2] + m[3];
        return (that === today ? '' : (m[2] + '-' + m[3] + ' ')) + m[4] + ':' + m[5];
    }
    function toast(msg) {
        if (window.UI && window.UI.message) {
            try { window.UI.message({ type: 'info', message: msg }); return; } catch (e) { /* 忽略 */ }
        }
    }
    function activePage() {
        try {
            return window.AppFrame && window.AppFrame.current ? pageOf(window.AppFrame.current()) : '';
        } catch (e) { return ''; }
    }
    /** 正在看的会话对象（当前 Tab 是即时对话，且已打开与某人的会话时返回其 empId，否则 0） */
    function activeChatPeer() {
        if (activePage() !== 'message.html') { return 0; }
        try {
            var win = null;
            $('#framePanes iframe[data-url]').each(function () {
                if (pageOf($(this).attr('data-url')) === 'message.html') { win = this.contentWindow; return false; }
            });
            if (win && win.IM && win.IM.state) { return num(win.IM.state.activePeer); }
        } catch (e) { /* 跨域 / 未加载完：当作没在看 */ }
        return 0;
    }
    /** 正在看的群（同 activeChatPeer，用于「正在看这个群就别再响」判断） */
    function activeChatGroup() {
        if (activePage() !== 'message.html') { return ''; }
        try {
            var win = null;
            $('#framePanes iframe[data-url]').each(function () {
                if (pageOf($(this).attr('data-url')) === 'message.html') { win = this.contentWindow; return false; }
            });
            if (win && win.IM && win.IM.state) { return String(win.IM.state.activeGroup || ''); }
        } catch (e) { /* 同上 */ }
        return '';
    }
    function openPage(url) {
        closePanel();
        try {
            if (window.AppFrame && window.AppFrame.navigate) { window.AppFrame.navigate(url); return; }
        } catch (e) { /* 忽略 */ }
        window.location.href = url;
    }
    /**
     * 打开与某人的会话：
     *   已开着「即时对话」标签 → 直接激活并让它切到那个人（不新开 Tab 造成重复）；
     *   没开着 → 用 ?peer= 深链打开，页面首屏握手后自动进入该会话。
     */
    function openConversation(empId) {
        var id = num(empId);
        closePanel();
        var win = null;
        try {
            $('#framePanes iframe[data-url]').each(function () {
                if (pageOf($(this).attr('data-url')) === 'message.html') {
                    win = this.contentWindow;
                    return false;
                }
            });
        } catch (e) { win = null; }
        if (win && win.IM && win.IM.openPeerLater) {
            try {
                if (window.AppFrame && window.AppFrame.navigate) { window.AppFrame.navigate('message.html'); }
                // 联系人可能还没握手完：openPeerLater 会记下 peer，等快照到了自动进入
                win.IM.openPeerLater(id);
                return;
            } catch (e2) { /* 落到下面的深链兜底 */ }
        }
        openPage('message.html?peer=' + id);
    }

    /** 打开某个群的会话：已开着即时对话 → 直接切过去；没开着 → 用 ?group= 深链打开 */
    function openGroupConversation(groupId) {
        var gid = String(groupId || '');
        if (!gid) { return; }
        closePanel();
        var win = null;
        try {
            $('#framePanes iframe[data-url]').each(function () {
                if (pageOf($(this).attr('data-url')) === 'message.html') {
                    win = this.contentWindow;
                    return false;
                }
            });
        } catch (e) { win = null; }
        if (win && win.IM && win.IM.openGroupLater) {
            try {
                if (window.AppFrame && window.AppFrame.navigate) { window.AppFrame.navigate('message.html'); }
                win.IM.openGroupLater(gid);
                return;
            } catch (e2) { /* 落到下面的深链兜底 */ }
        }
        openPage('message.html?group=' + encodeURIComponent(gid));
    }

    /* ---------------- 偏好（提示音 / 语音播报） ---------------- */
    function readPref() {
        try {
            var raw = window.localStorage.getItem(PREF_KEY);
            var o = raw ? JSON.parse(raw) : null;
            if (o && typeof o === 'object') {
                STATE.soundOn = !(o.sound === 0 || o.sound === false);
                STATE.voiceOn = !(o.voice === 0 || o.voice === false);
                return;
            }
        } catch (e) { /* 隐私模式忽略 */ }
        STATE.soundOn = true;
        STATE.voiceOn = true;          // 默认开启：用户明确要「有新消息时语音提醒」
    }
    function savePref() {
        try {
            window.localStorage.setItem(PREF_KEY, JSON.stringify({
                sound: STATE.soundOn ? 1 : 0, voice: STATE.voiceOn ? 1 : 0
            }));
        } catch (e) { /* 忽略 */ }
    }
    function syncSwitches() {
        $('#frameBellSound').prop('checked', !!STATE.soundOn);
        $('#frameBellVoice').prop('checked', !!STATE.voiceOn);
    }

    /* ---------------- 声音 / 语音 ---------------- */
    /** 两声「叮咚」：880Hz + 1174Hz，短促不刺耳；用 WebAudio 合成，不需要音频文件 */
    function chime() {
        if (!STATE.soundOn) { return false; }
        try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) { return false; }
            audioCtx = audioCtx || new AC();
            if (audioCtx.state === 'suspended' && audioCtx.resume) { audioCtx.resume(); }
            var t0 = audioCtx.currentTime;
            var notes = [[880, 0], [1174.66, 0.17]];
            for (var i = 0; i < notes.length; i++) {
                var osc = audioCtx.createOscillator();
                var gain = audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.value = notes[i][0];
                var at = t0 + notes[i][1];
                gain.gain.setValueAtTime(0.0001, at);
                gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start(at);
                osc.stop(at + 0.3);
            }
            return true;
        } catch (e) { return false; }
    }
    /** 语音播报（浏览器自带 TTS；不支持时静默跳过，不影响提示音） */
    function speak(text) {
        if (!STATE.voiceOn || !text) { return false; }
        var syn = window.speechSynthesis;
        var Utt = window.SpeechSynthesisUtterance;
        if (!syn || !Utt) { return false; }
        try {
            syn.cancel();
            var u = new Utt(text);
            u.lang = 'zh-CN';
            u.rate = 1.05;
            u.pitch = 1;
            u.volume = 1;
            syn.speak(u);
            return true;
        } catch (e) { return false; }
    }
    /**
     * 新对话到达：提示音 + 语音 + （不在对话页时）一条轻提示
     * @param {Number} n 本次新增的未读数
     * @param {Array}  peers  未读联系人（取第一个报姓名）
     * @param {Array}  groups 未读群（人全都没有时用它报群名）
     */
    function alertNew(n, peers, groups) {
        if (!n || n < 1) { return; }
        var first = (peers && peers.length) ? peers[0]
            : ((groups && groups.length) ? groups[0] : null);
        // 正在看这条会话 / 这个群：聊天区自己会刷新，不用再响（避免「当面说话还叮咚」）
        if (first) {
            if (first.isGroup || first.groupId) {
                if (activeChatGroup() && activeChatGroup() === String(first.groupId)) { return; }
            } else if (activeChatPeer() === num(first.empId)) {
                return;
            }
        }
        var now = new Date().getTime();
        if (now - STATE.lastAlertAt < 1200) { return; }     // 轮询 + WS 同时到，只响一次
        STATE.lastAlertAt = now;
        chime();
        var isGroup = !!(first && (first.isGroup || first.groupId));
        var who = (first && first.name) ? first.name : '';
        var spoken;
        if (n > 1) {
            spoken = '您有 ' + n + ' 条来自' + (who || '同事') + '等的新消息';
        } else if (isGroup) {
            spoken = '群' + who + '有新消息';
        } else {
            spoken = '收到' + (who || '同事') + '发来的新消息';
        }
        speak(spoken);
        if (activePage() !== 'message.html') { toast('收到 ' + (who || '同事') + ' 的新消息'); }
        if ($bell && $bell.length) {
            $bell.addClass('is-ring');
            window.setTimeout(function () { $bell.removeClass('is-ring'); }, 1000);
        }
    }

    /* ---------------- 渲染：顶栏铃铛 ---------------- */
    function renderBell() {
        if (!$dot || !$dot.length) { return; }
        if (STATE.total > 0) {
            $dot.text(cap(STATE.total)).removeAttr('hidden');
            $dot.attr('title', '即时对话 ' + STATE.imUnread + ' 条 / 新邮件 ' + STATE.mailUnread + ' 封');
        } else {
            $dot.attr('hidden', 'hidden').text('0').removeAttr('title');
        }
        if ($bell && $bell.length) {
            $bell.attr('title', STATE.total > 0
                ? ('消息提醒：对话 ' + STATE.imUnread + ' 条，邮件 ' + STATE.mailUnread + ' 封')
                : '消息提醒（暂无未读）');
        }
    }

    /* ---------------- 渲染：左侧菜单上标 ---------------- */
    /** 给左侧导航里指向某页面的菜单项挂上/更新「小红点 + 数字」 */
    function setBadge(page, count, isMail) {
        if (!$menu || !$menu.length) { return; }
        var n = num(count);
        $menu.find('.frame-side__item[data-url]').each(function () {
            if (pageOf($(this).attr('data-url')) !== page) { return; }
            var $b = $(this).children('.frame-nav-badge');
            if (n > 0) {
                if (!$b.length) { $b = $('<span class="frame-nav-badge"></span>').appendTo(this); }
                $b.toggleClass('is-mail', !!isMail).text(cap(n))
                    .attr('title', (isMail ? '未读邮件 ' : '未读对话 ') + n + ' 条');
            } else if ($b.length) {
                $b.remove();
            }
        });
    }
    /** 导航每次重绘后都要重新挂（框架页 renderNav 末尾会调这里） */
    function applyMenuBadges() {
        if (!$menu || !$menu.length) { $menu = $('#frameMenu'); }
        setBadge('message.html', STATE.imUnread, false);
        setBadge('emp-mail.html', STATE.mailUnread, true);
    }

    /* ---------------- 渲染：下拉面板 ---------------- */
    function sectionHead(title, count, isMail, page, moreText) {
        return '<div class="frame-bell__sec-head">' +
            '<span class="frame-bell__sec-title' + (isMail ? ' is-mail' : '') + '">' +
                '<b>' + esc(title) + '</b>' +
                (count > 0 ? '<span class="frame-bell__count">' + cap(count) + '</span>' : '') +
            '</span>' +
            '<button type="button" class="frame-bell__more" data-page="' + esc(page) + '">' +
                esc(moreText) + '</button>' +
        '</div>';
    }
    function renderPanel() {
        if (!$body || !$body.length) { return; }
        var html = '';
        // 1) 即时对话
        html += '<div class="frame-bell__sec">' +
            sectionHead('即时对话', STATE.imUnread, false, 'message.html', '全部对话') ;
        if (STATE.imPeers.length || STATE.imGroups.length) {
            for (var i = 0; i < STATE.imPeers.length; i++) {
                var p = STATE.imPeers[i];
                html += '<div class="frame-bell__item" data-peer="' + num(p.empId) + '">' +
                    '<span class="frame-bell__avatar">' + esc(p.avatarText || String(p.name || '?').slice(0, 1)) + '</span>' +
                    '<span class="frame-bell__main">' +
                        '<span class="frame-bell__row1">' +
                            '<span class="frame-bell__who">' + esc(p.name) +
                                (p.deptName ? ' <span style="color:#c0c4cc;font-weight:400;">· ' + esc(p.deptName) + '</span>' : '') +
                            '</span>' +
                            '<span class="frame-bell__time">' + esc(shortTime(p.lastTime)) + '</span>' +
                        '</span>' +
                        '<span class="frame-bell__text">' + esc(p.lastContent || '发来新消息') + '</span>' +
                    '</span>' +
                    '<span class="frame-bell__n">' + cap(num(p.unread)) + '</span>' +
                '</div>';
            }
            // 群未读：头像用橙色区分「群聊」，点条目走 ?group= 深链
            for (var gi = 0; gi < STATE.imGroups.length; gi++) {
                var g = STATE.imGroups[gi];
                html += '<div class="frame-bell__item" data-group="' + esc(g.groupId) + '">' +
                    '<span class="frame-bell__avatar is-group">' + esc(g.avatarText || String(g.name || '群').slice(0, 1)) + '</span>' +
                    '<span class="frame-bell__main">' +
                        '<span class="frame-bell__row1">' +
                            '<span class="frame-bell__who">' + esc(g.name || '群聊') +
                                ' <span style="color:#c0c4cc;font-weight:400;">· 群聊</span>' +
                            '</span>' +
                            '<span class="frame-bell__time">' + esc(shortTime(g.lastTime)) + '</span>' +
                        '</span>' +
                        '<span class="frame-bell__text">' +
                            esc((g.lastSenderName ? (g.lastSenderName + '：') : '') + (g.lastContent || '群里有新消息')) +
                        '</span>' +
                    '</span>' +
                    '<span class="frame-bell__n">' + cap(num(g.unread)) + '</span>' +
                '</div>';
            }
        } else {
            html += '<div class="frame-bell__empty">暂无未读对话</div>';
        }
        html += '</div>';
        // 2) 新邮件
        html += '<div class="frame-bell__sec">' +
            sectionHead('新邮件', STATE.mailUnread, true, 'emp-mail.html', '我的邮箱');
        if (!STATE.mailConfigured) {
            html += '<div class="frame-bell__empty">还没有配置「我的邮箱」</div>';
        } else if (STATE.mailItems.length) {
            for (var j = 0; j < STATE.mailItems.length; j++) {
                var m = STATE.mailItems[j];
                html += '<div class="frame-bell__item" data-mail="' + esc(m.id || '') + '">' +
                    '<span class="frame-bell__avatar is-mail">✉</span>' +
                    '<span class="frame-bell__main">' +
                        '<span class="frame-bell__row1">' +
                            '<span class="frame-bell__who">' + esc(m.fromName || m.fromAddr || '未知发件人') + '</span>' +
                            '<span class="frame-bell__time">' + esc(shortTime(m.sentTime)) + '</span>' +
                        '</span>' +
                        '<span class="frame-bell__text">' + esc(m.subject || '(无主题)') + '</span>' +
                    '</span>' +
                '</div>';
            }
        } else {
            html += '<div class="frame-bell__empty">暂无未读邮件</div>';
        }
        html += '</div>';
        $body.html(html);
    }

    function openPanel() {
        if (!$panel || !$panel.length) { return; }
        renderPanel();
        syncSwitches();
        $panel.removeAttr('hidden');
        if ($bell && $bell.length) { $bell.addClass('is-open'); }
    }
    function closePanel() {
        if ($panel && $panel.length) { $panel.attr('hidden', 'hidden'); }
        if ($bell && $bell.length) { $bell.removeClass('is-open'); }
    }
    function togglePanel() {
        if (!$panel || !$panel.length) { return; }
        if ($panel.is('[hidden]')) { openPanel(); } else { closePanel(); }
    }

    /* ---------------- 应用一份新的未读快照 ---------------- */
    /**
     * @param {Object} data Api.notify.summary() 的返回
     * @param {Object} opts {silent:true} 首次加载 / 手动刷新时不播声音
     */
    function apply(data, opts) {
        opts = opts || {};
        if (!data) { return; }
        var im = data.im || {}, mail = data.mail || {};
        var prevIm = STATE.imUnread;
        STATE.imUnread = num(im.unread);
        STATE.mailUnread = num(mail.unread);
        STATE.total = num(data.total) || (STATE.imUnread + STATE.mailUnread);
        STATE.imPeers = im.peers || [];
        STATE.imGroups = im.groups || [];
        STATE.mailItems = mail.items || [];
        STATE.mailConfigured = !!mail.configured;

        renderBell();
        applyMenuBadges();
        if ($panel && $panel.length && !$panel.is('[hidden]')) { renderPanel(); }

        // 只有「未读数变大」才是新消息；首次加载（prevIm=0 但本来就有一堆未读）不响
        var delta = STATE.imUnread - prevIm;
        if (!opts.silent && delta > 0 && prevIm >= 0 && STATE._loaded) {
            alertNew(delta, STATE.imPeers, STATE.imGroups);
        }
        STATE._loaded = true;
    }

    /* ---------------- 数据刷新 ---------------- */
    function refresh(opts) {
        opts = opts || {};
        if (!window.Api || !window.Api.notify) { return null; }
        if (STATE.refreshing) { STATE.pending = true; return null; }   // 合并并发刷新
        STATE.refreshing = true;
        var dfd = window.Api.notify.summary().done(function (data) {
            STATE.refreshing = false;
            apply(data, opts);
            if (STATE.pending) { STATE.pending = false; refresh({ silent: true }); }
        }).fail(function () {
            STATE.refreshing = false;
            STATE.pending = false;
        });
        return dfd;
    }
    /** 外部（IM 页 / 子页面）通知：有未读变化，尽快刷新一次 */
    var refreshTimer = null;
    function bump() {
        if (refreshTimer) { return; }
        refreshTimer = window.setTimeout(function () {
            refreshTimer = null;
            refresh({ silent: false });
        }, 260);
    }

    /* ---------------- WebSocket：即时感知新消息 ---------------- */
    function connectSocket() {
        if (STATE.socketClosed || !window.Api || !window.Api.msg || !window.Api.msg.connect) { return; }
        var sock;
        try { sock = window.Api.msg.connect({}); } catch (e) { scheduleReconnect(); return; }
        if (!sock) { return; }
        STATE.socket = sock;
        sock.on('open', function () { STATE.reconnectDelay = 2000; });
        sock.on('message', function (obj) {
            if (!obj || !obj.type) { return; }
            // 新消息 / 已读回执 / 发送回执 都会影响未读数：统一稍后刷新一次（合并）
            if (obj.type === 'msg' || obj.type === 'read' || obj.type === 'ack') { bump(); }
            if (obj.type === 'serverHello') { bump(); }        // 断线重连后补一次
        });
        sock.on('close', function () {
            STATE.socket = null;
            if (!STATE.socketClosed) { scheduleReconnect(); }
        });
        sock.on('error', function () { /* 随后会触发 close */ });
    }
    function scheduleReconnect() {
        if (STATE.socketClosed || STATE.reconnectTimer) { return; }
        var delay = STATE.reconnectDelay;
        STATE.reconnectTimer = window.setTimeout(function () {
            STATE.reconnectTimer = null;
            if (STATE.socketClosed) { return; }
            connectSocket();
            STATE.reconnectDelay = Math.min(STATE.reconnectDelay * 2, 20000);
        }, delay);
    }

    /* ---------------- 事件绑定 ---------------- */
    function bind() {
        $bell = $('#frameBell');
        $dot = $('#frameBellDot');
        $panel = $('#frameBellPanel');
        $body = $('#frameBellBody');
        $menu = $('#frameMenu');
        if (!$bell.length) { return false; }

        $('#frameBellBtn').on('click', function (e) {
            e.stopPropagation();
            togglePanel();
        });
        // 点面板内部不关闭（按钮 / 条目自己处理）
        $panel.on('click', function (e) { e.stopPropagation(); });
        $(document).on('click', function () { closePanel(); });
        $(document).on('keydown', function (e) { if (e.keyCode === 27) { closePanel(); } });

        // 点条目：对话带 peer 深链，直接落到那个人
        $panel.on('click', '.frame-bell__item[data-peer]', function () {
            openConversation(num($(this).attr('data-peer')));
        });
        // 群条目：走 ?group= 深链
        $panel.on('click', '.frame-bell__item[data-group]', function () {
            openGroupConversation(String($(this).attr('data-group') || ''));
        });
        $panel.on('click', '.frame-bell__item[data-mail]', function () { openPage('emp-mail.html'); });
        $panel.on('click', '.frame-bell__more', function () {
            var page = String($(this).attr('data-page') || '');
            if (page) { openPage(page); }
        });
        // 立即刷新
        $panel.on('click', '#frameBellRefresh', function (e) {
            e.stopPropagation();
            refresh({ silent: true });
        });
        // 提示音 / 语音播报开关
        $('#frameBellSound').on('change', function () {
            STATE.soundOn = !!this.checked; savePref();
            if (STATE.soundOn) { chime(); }
        });
        $('#frameBellVoice').on('change', function () {
            STATE.voiceOn = !!this.checked; savePref();
            if (STATE.voiceOn) { speak('语音提醒已开启'); }
        });
        return true;
    }

    /* ---------------- 启动 / 停止 ---------------- */
    function start() {
        if (STATE.started) { return true; }
        if (!bind()) { return false; }          // 非框架页（没有铃铛）
        STATE.started = true;
        readPref();
        syncSwitches();
        renderBell();
        refresh({ silent: true });              // 首屏：先把历史未读显示出来（不响）
        STATE.pollTimer = window.setInterval(function () { refresh({ silent: false }); }, POLL_MS);
        connectSocket();
        // 切回本窗口时补一次（后台标签页的定时器会被节流）
        $(window).on('focus', function () { refresh({ silent: true }); });
        return true;
    }
    function stop() {
        STATE.started = false;
        STATE.socketClosed = true;
        if (STATE.pollTimer) { window.clearInterval(STATE.pollTimer); STATE.pollTimer = null; }
        if (STATE.reconnectTimer) { window.clearTimeout(STATE.reconnectTimer); STATE.reconnectTimer = null; }
        if (STATE.socket && STATE.socket.close) { try { STATE.socket.close(); } catch (e) { /* 忽略 */ } }
        STATE.socket = null;
    }

    return {
        start: start,
        stop: stop,
        refresh: refresh,
        bump: bump,
        apply: apply,
        applyMenuBadges: applyMenuBadges,
        openPanel: openPanel,
        closePanel: closePanel,
        openConversation: openConversation,
        openGroupConversation: openGroupConversation,
        chime: chime,
        speak: speak,
        state: STATE
    };
})(jQuery);
