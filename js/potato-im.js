/* ==========================================================================
   potato-im.js —— 主框架右侧「员工IM」抽屉（**通讯录**，双击土豆打开）
   ----------------------------------------------------------------------------
   定位：只做「找人 / 找群」的快速入口，**不含会话消息列表、不含发消息输入框**。
     · 两个标签：联系人 / 群组；上线 / 未读 / 最近一条 都在条目上体现；
     · 点条目（或群）→ 在框架 Tab 里打开 message.html 并直接进入该会话（?peer= / ?group=）；
     · 数据全部走 Api.msg.*（与即时对话页同一套接口、同一份 Mock），不另起协议；
     · 自建一条 /ws/msg 只用来刷「在线态 / 未读数」，不承载聊天。
   对外：window.PotatoIM = { start, open, close, isOpen, refresh, state }
   ========================================================================== */
window.PotatoIM = (function ($) {
    'use strict';

    var STATE = {
        started: false,
        me: 0,
        meName: '',
        contacts: {},          // empId -> {empId,name,deptName,jobTitle,online,unread,lastContent,lastTime}
        groups: {},            // groupId -> {groupId,name,memberCount,unread,lastContent,lastTime,lastSenderName}
        orgs: [],              // 组织架构 DFS 顺序：[{id,name,depth}]
        orgById: {},           // id -> {id,name,depth,parentId}
        orgChildren: {},       // parentId -> [id]
        collapsed: {},         // 收起的部门 id -> 1
        tab: 'contact',        // 'contact' | 'group'
        kw: '',
        loading: false,
        socket: null,
        reconnectTimer: null,
        reconnectDelay: 1000,
        manualClose: false
    };

    var $panel, $list, $me, $search, $tabs;
    var $dotContact, $dotGroup;
    var $chatWin, $chatWinTitle, $chatWinSub, $chatWinBody, $chatWinInput, $chatWinSend, $chatWinClose;
    var $piMention, $piMentionKw, $piMentionList, $piMentionClose;
    var $chatWinMax, $toolEmoji, $toolImage, $toolFile, $toolVoice, $toolShot;
    var $status, $emojiPanel, $fileImage, $fileAny;
    var CHAT = { open: false, kind: '', id: '', list: [], tempSeq: 0, max: false, pos: null,
                 members: [], membersOf: '' };   // 双击弹出的小窗（members 供群聊 @ 用）
    var CHAT_EDITOR = null;                       // 小窗输入区的富文本编辑器（RichText.mount）
    var DRAG = { on: false, dx: 0, dy: 0 };
    var MEDIA = {
        maxBytes: 20 * 1024 * 1024, voiceOn: false, rec: null,
        chunks: [], startAt: 0, timer: null,
        ctx: null, analyser: null, meterTimer: null, peak: 0, meterOn: false,
        tab: 'smile', stickers: [], emojiOpen: false
    };

    /** 录音期间量电平：全程≈0 判定麦克风没收到声音 */
    function startLevelMeter(stream) {
        MEDIA.meterOn = false;
        MEDIA.peak = 0;
        try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) { return; }
            MEDIA.ctx = new AC();
            var src = MEDIA.ctx.createMediaStreamSource(stream);
            MEDIA.analyser = MEDIA.ctx.createAnalyser();
            MEDIA.analyser.fftSize = 1024;
            src.connect(MEDIA.analyser);
            MEDIA.meterOn = true;
            MEDIA.meterTimer = setInterval(function () {
                if (!MEDIA.analyser) { return; }
                var buf = new Uint8Array(MEDIA.analyser.fftSize);
                MEDIA.analyser.getByteTimeDomainData(buf);
                var peak = 0;
                for (var i = 0; i < buf.length; i++) {
                    var v = Math.abs((buf[i] - 128) / 128);
                    if (v > peak) { peak = v; }
                }
                if (peak > MEDIA.peak) { MEDIA.peak = peak; }
            }, 120);
        } catch (e) { MEDIA.meterOn = false; }
    }

    function voiceLevelText() {
        if (!MEDIA.meterOn) { return ''; }
        var p = MEDIA.peak;
        var bars = p < 0.01 ? '▁' : (p < 0.05 ? '▃' : (p < 0.15 ? '▅' : (p < 0.4 ? '▇' : '█')));
        return ' · 音量 ' + bars;
    }

    function stopLevelMeter() {
        if (MEDIA.meterTimer) { clearInterval(MEDIA.meterTimer); MEDIA.meterTimer = null; }
        try { if (MEDIA.ctx && MEDIA.ctx.close) { MEDIA.ctx.close(); } } catch (e) { /* 忽略 */ }
        MEDIA.ctx = null;
        MEDIA.analyser = null;
    }
    var lastItemClickAt = 0;                                             // 条目单击/双击区分
    var $modal, $modalTitle, $modalBody, $modalErr, $modalOk, $modalCancel, $modalClose, $modalMask, $toast, $newGroup;
    var MODAL = { mode: '', groupId: '', picked: {}, members: [] };   // mode: '' | 'create' | 'rename'
    var toastTimer = null;

    /* ------------------------------ 小工具 ------------------------------ */

    function payload(res) {
        if (!res) { return null; }
        if (res.data !== undefined && (res.code === 0 || res.code === 200)) { return res.data; }
        return res;
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /** 复制到剪贴板：优先 clipboard，失败 / 非安全上下文回退 execCommand */
    function copyText(text, kind) {
        var label = kind === 'phone' ? '手机号' : '邮箱';
        function ok() { UI.message({ type: 'success', message: label + '已复制' }); }
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', 'readonly');
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            var done = false;
            try { done = document.execCommand('copy'); } catch (e) { done = false; }
            document.body.removeChild(ta);
            if (done) { ok(); } else { UI.message({ type: 'error', message: '复制失败，请手动选择复制' }); }
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok).catch(fallback);
        } else {
            fallback();
        }
    }
    function avText(name) {
        var s = String(name || '');
        return s ? s.slice(-2) : '?';
    }
    function num(v) { return parseInt(v, 10) || 0; }
    /** 列表时间：今天只显示 HH:MM，其它显示 MM-DD */
    function dispTime(t) {
        if (!t) { return ''; }
        var s = String(t).replace('T', ' ');
        var d = s.slice(0, 10), hm = s.slice(11, 16);
        var now = new Date();
        var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
        var td = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
        if (d === td && hm) { return hm; }
        return d ? d.slice(5) : (hm || s);
    }
    function previewOf(c) {
        var t = c.lastContent || c.lastMessage || '';
        return t || (c.isGroup ? '点击进入群聊' : '点击发起会话');
    }
    function notifyFrame() {
        try {
            if (window.AppNotify && window.AppNotify.refresh) { window.AppNotify.refresh({ silent: true }); }
        } catch (e) { /* 忽略 */ }
    }

    /** 是否是群主：优先 isOwner，缺失时用 ownerId 与本人比对 */
    function amOwner(g) {
        if (!g) { return false; }
        if (g.isOwner === true) { return true; }
        return !!g.ownerId && num(g.ownerId) === num(STATE.me) && num(STATE.me) > 0;
    }

    /** 抽屉内的小提示（2 秒自动消失） */
    function toast(text) {
        if (!$toast) { return; }
        $toast.text(text).removeAttr('hidden');
        if (toastTimer) { clearTimeout(toastTimer); }
        toastTimer = setTimeout(function () { $toast.attr('hidden', 'hidden'); toastTimer = null; }, 2000);
    }
    function showErr(text) {
        if ($modalErr) { $modalErr.text(text || ''); }
    }

    /* ------------------------------ 标签红点 ------------------------------ */

    /** 未读合计：联系人一份、群组一份（标签红点用） */
    function unreadSums() {
        var c = 0, g = 0;
        $.each(STATE.contacts, function (k, x) { c += num(x.unread); });
        $.each(STATE.groups, function (k, x) { g += num(x.unread); });
        return { contact: c, group: g };
    }

    function paintDot($el, n) {
        if (!$el || !$el.length) { return; }
        if (n > 0) { $el.text(n > 99 ? '99+' : n).removeAttr('hidden'); }
        else { $el.text('').attr('hidden', 'hidden'); }
    }

    /** 有未读才显示红点；数字随消息实时变，清零自动收起 */
    function paintTabDots() {
        var s = unreadSums();
        paintDot($dotContact, s.contact);
        paintDot($dotGroup, s.group);
    }

    /* ------------------------------ 建群 / 改名 ------------------------------ */

    function isModalOpen() { return !!(MODAL.mode && $modal && !$modal.is('[hidden]')); }

    function openModal(mode, gid) {
        MODAL.mode = mode;
        MODAL.groupId = gid || '';
        MODAL.picked = {};
        showErr('');
        $modalTitle.text(mode === 'rename' ? '重命名群组' : '创建群组');
        $modalOk.removeAttr('hidden').prop('disabled', false);
        $modalCancel.text('取消');
        $modalOk.text(mode === 'rename' ? '保存' : '创建');
        $modalBody.empty();

        if (mode === 'rename') {
            var g = STATE.groups[gid] || {};
            $modalBody.append(
                '<div class="pi-field"><label>群名称</label>' +
                '<input type="text" id="piRenameInput" maxlength="30" value="' + esc(g.name || '') + '"></div>' +
                '<div class="pi-modal__tip">只有群主可以修改群名称</div>');
            $modal.removeAttr('hidden');
            setTimeout(function () {
                var el = $('#piRenameInput')[0];
                if (el) { el.focus(); el.select(); }
            }, 0);
            return;
        }

        MODAL.members = contactArr().sort(function (a, b) {
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
        $modalBody.append(
            '<div class="pi-field"><label>群名称（可留空，按成员名自动生成）</label>' +
            '<input type="text" id="piGroupName" maxlength="30" placeholder="例如：项目协作群"></div>' +
            '<div class="pi-field"><label>选择成员</label>' +
            '<input type="text" id="piMemberSearch" placeholder="搜索姓名 / 部门">' +
            '<div class="pi-pick" id="piPickList"></div></div>' +
            '<div class="pi-modal__tip">已选 <b id="piPickCount">0</b> 人；你自己会自动入群</div>');
        drawMembers('');
        $modal.removeAttr('hidden');
        setTimeout(function () { $('#piGroupName').focus(); }, 0);
    }

    function drawMembers(kw) {
        var $box = $('#piPickList');
        if (!$box.length) { return; }
        $box.empty();
        var arr = MODAL.members || [];
        if (kw) {
            var k = kw.toLowerCase();
            arr = arr.filter(function (c) {
                return [c.name, c.deptName, c.jobTitle].join(' ').toLowerCase().indexOf(k) >= 0;
            });
        }
        if (!arr.length) {
            $box.append('<div class="pi-pick__empty">没有匹配的同事</div>');
            return;
        }
        $.each(arr, function (i, c) {
            var on = !!MODAL.picked[c.empId];
            var $row = $('<div class="pi-pick__item" data-emp="' + c.empId + '">' +
                '<input type="checkbox"' + (on ? ' checked' : '') + '>' +
                '<span class="pi-pick__name">' + esc(c.name) + '</span>' +
                '<span class="pi-pick__sub">' + esc(c.deptName || '') + '</span></div>');
            $row.on('click', function (e) {
                if (e.target && e.target.tagName === 'INPUT') {
                    MODAL.picked[c.empId] = e.target.checked;
                } else {
                    MODAL.picked[c.empId] = !MODAL.picked[c.empId];
                    $row.find('input').prop('checked', !!MODAL.picked[c.empId]);
                }
                $('#piPickCount').text(pickedIds().length);
                showErr('');                       // 勾选后把「请至少选择」的报错清掉
            });
            $box.append($row);
        });
    }

    function pickedIds() {
        var ids = [];
        $.each(MODAL.picked, function (k, v) { if (v) { ids.push(num(k)); } });
        return ids;
    }

    function closeModal() {
        MODAL.mode = '';
        MODAL.groupId = '';
        showErr('');
        if ($modal) { $modal.attr('hidden', 'hidden'); }
    }

    function confirmModal() {
        if (MODAL.mode === 'detail') { closeModal(); return; }
        if (MODAL.mode === 'members') { if (MODAL.owner) { saveMembers(); } else { closeModal(); } return; }
        showErr('');
        if (MODAL.mode === 'create') {
            var ids = pickedIds();
            if (!ids.length) { showErr('请至少选择一位群成员'); return; }
            var name = $.trim($('#piGroupName').val() || '');
            $modalOk.prop('disabled', true);
            Api.msg.groupAdd({ groupName: name, memberIds: ids }).done(function (res) {
                var d = payload(res);
                $modalOk.prop('disabled', false);
                if (!d || !d.groupId) { showErr((d && d.message) || '创建失败'); return; }
                closeModal();
                STATE.tab = 'group';
                $tabs.removeClass('is-active');
                $panel.find('.pi-tab[data-tab="group"]').addClass('is-active');
                loadGroups();
                toast('群创建成功');
            }).fail(function (x) {
                $modalOk.prop('disabled', false);
                showErr((x && x.message) || '创建失败，请重试');
            });
            return;
        }
        if (MODAL.mode === 'rename') {
            var gid = MODAL.groupId;
            var val = $.trim($('#piRenameInput').val() || '');
            if (!val) { showErr('群名称不能为空'); return; }
            var g = STATE.groups[gid] || {};
            if (String(g.name || '') === val) { closeModal(); return; }
            $modalOk.prop('disabled', true);
            Api.msg.groupUpdate({ groupId: gid, groupName: val }).done(function (res) {
                var d = payload(res);
                $modalOk.prop('disabled', false);
                if (d && d.code && d.code !== 0) { showErr(d.message || '保存失败'); return; }
                closeModal();
                loadGroups();
                toast('群名称已更新');
            }).fail(function (x) {
                $modalOk.prop('disabled', false);
                showErr((x && x.message) || '保存失败，请重试');
            });
        }
    }

    /* ------------------------------ 列表 ------------------------------ */

    function contactArr() {
        var arr = [];
        $.each(STATE.contacts, function (k, c) { arr.push(c); });
        return arr;
    }
    function groupArr() {
        var arr = [];
        $.each(STATE.groups, function (k, g) { arr.push(g); });
        return arr;
    }

    /** 群组视图的数据（按关键字过滤） */
    function visibleGroups() {
        var kw = STATE.kw.toLowerCase();
        var gs = groupArr();
        if (kw) { gs = gs.filter(function (g) { return String(g.name || '').toLowerCase().indexOf(kw) >= 0; }); }
        return gs;
    }

    /** 一条人员 / 群记录（人员右侧带「查看详情」图标按钮） */
    function makeItem(c, isGroup, depth) {
        var unread = num(c.unread);
        var last = previewOf(c);
        if (isGroup && c.lastSenderName && c.lastContent) {
            last = (c.lastFromMe ? '我：' : (c.lastSenderName + '：')) + c.lastContent;
        }
        var sub = isGroup ? ('群聊 · ' + num(c.memberCount) + ' 人') : (c.jobTitle || c.deptName || '');
        var pad = 8 + (depth || 0) * 14;
        var $it = $(
            '<div class="pi-item" data-kind="' + (isGroup ? 'group' : 'peer') +
                '" data-id="' + esc(isGroup ? c.groupId : c.empId) + '"' +
                ' style="padding-left:' + pad + 'px"' +
                ' title="' + esc(isGroup ? '双击进入群聊' : '双击与他聊天') + '">' +
                '<span class="pi-avatar' + (isGroup ? ' is-group' : '') + '">' + esc(avText(c.name)) +
                    (isGroup ? '' : '<i class="pi-dot' + (c.online ? ' is-online' : '') + '"></i>') + '</span>' +
                '<span class="pi-item__body">' +
                    '<span class="pi-item__top">' +
                        '<span class="pi-item__name">' + esc(c.name || '未命名') + '</span>' +
                        (c.lastTime ? '<span class="pi-item__time">' + esc(dispTime(c.lastTime)) + '</span>' : '') +
                    '</span>' +
                    '<span class="pi-item__row2">' +
                        '<span class="pi-item__msg">' + esc(last) + (sub ? ' · ' + esc(sub) : '') + '</span>' +
                        (unread ? '<span class="pi-badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '') +
                        (isGroup
                            ? '<button type="button" class="pi-item__members" title="查看群成员" aria-label="查看群成员">' +
                              '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm0 2c-3.9 0-7 1.9-7 4.2V19h14v-1.8C16 14.9 12.9 13 9 13zm8.5-2a3 3 0 100-6 3 3 0 000 6zm0 2c-.9 0-1.7.1-2.5.4 1.3 1 2 2.3 2 3.8V19H22v-1.8c0-2-2-3.2-4.5-3.2z"/></svg></button>'
                            : '') +
                        (isGroup && amOwner(c)
                            ? '<button type="button" class="pi-item__rename" title="重命名群组" aria-label="重命名群组">✎</button>'
                            : '') +
                        (!isGroup
                            ? '<button type="button" class="pi-item__info" title="查看员工详情" aria-label="查看员工详情">i</button>'
                            : '') +
                    '</span>' +
                '</span>' +
            '</div>');
        $it.on('click', function () {
            onItemClick($it, isGroup ? 'group' : 'peer', isGroup ? c.groupId : num(c.empId));
        });
        if (isGroup && amOwner(c)) {
            $it.find('.pi-item__rename').on('click', function (e) {
                e.preventDefault();
                e.stopPropagation();          // 别顺手把「进入群聊」也点开
                openModal('rename', c.groupId);
            });
        }
        if (isGroup) {
            $it.find('.pi-item__members').on('click', function (e) {
                e.preventDefault();
                e.stopPropagation();          // 只看成员，不触发选中/会话
                openGroupMembers(c.groupId);
            });
        }
        if (!isGroup) {
            $it.find('.pi-item__info').on('click', function (e) {
                e.preventDefault();
                e.stopPropagation();          // 只看详情，不触发选中/会话
                openEmpDetail(c);
            });
        }
        return $it;
    }

    function emptyTip(what) {
        return '<div class="pi-list__tip">' +
            (STATE.loading ? '正在加载…' : (STATE.kw ? '没有匹配的结果' : what)) + '</div>';
    }

    /** 单击只选中（不再跳页面），双击才弹会话 */
    function onItemClick($it, kind, id) {
        $list.find('.pi-item.is-active').removeClass('is-active');
        $it.addClass('is-active');
        var now = (new Date()).getTime();
        if (now - lastItemClickAt < 300) {
            lastItemClickAt = 0;
            openChat(kind, id);
            return;
        }
        lastItemClickAt = now;
    }

    /* 抽屉列表「消息列 / 姓名」被截断时的悬停提示：只有真的超出宽度才显示完整内容 */
    var itemTipTimer = null;
    function hideItemTip() {
        if (itemTipTimer) { window.clearTimeout(itemTipTimer); itemTipTimer = null; }
        var $t = $('#piMsgTip');
        if ($t.length) { $t.attr('hidden', 'hidden').text(''); }
    }
    function showItemTip(el) {
        var text = String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
        if (!text) { return; }
        var $t = $('#piMsgTip');
        if (!$t.length) {
            $t = $('<div class="pi-msg-tip" id="piMsgTip" hidden></div>').appendTo(document.body);
        }
        $t.text(text).removeAttr('hidden');
        var r = el.getBoundingClientRect();
        var tw = $t.outerWidth(), th = $t.outerHeight();
        var left = Math.max(8, Math.min(r.left, window.innerWidth - tw - 8));
        var top = r.bottom + 6;
        if (top + th > window.innerHeight - 8) { top = Math.max(8, r.top - th - 6); }
        $t.css({ left: Math.round(left) + 'px', top: Math.round(top) + 'px' });
    }
    /** 悬停条目：消息列被截断显示消息全文，否则姓名被截断显示姓名全文 */
    function bindItemTip() {
        if (!$list || !$list.length) { return; }
        $list.on('mouseenter', '.pi-item', function () {
            hideItemTip();
            var el = this.querySelector('.pi-item__msg');
            if (!el || el.scrollWidth <= el.clientWidth + 1) {
                el = this.querySelector('.pi-item__name');
                if (!el || el.scrollWidth <= el.clientWidth + 1) { return; }
            }
            itemTipTimer = window.setTimeout(function () { showItemTip(el); }, 120);
        }).on('mouseleave', '.pi-item', hideItemTip);
        $list.on('scroll', hideItemTip);
        $(window).on('scroll resize', hideItemTip);
        $(document).on('click', hideItemTip);
    }

    function renderList() {
        hideItemTip();
        if (!$list) { return; }
        paintTabDots();                    // 列表每次重绘都顺带刷新两个标签的红点
        $list.empty();
        if (STATE.tab === 'group') {
            var gs = visibleGroups();
            if (!gs.length) { $list.append(emptyTip('还没有加入任何群组')); return; }
            $.each(gs, function (i, g) { $list.append(makeItem(g, true, 0)); });
            return;
        }
        renderOrgTree();
    }

    /** 联系人：按组织架构树形渲染，部门可逐级收起；检索时自动展开 */
    function renderOrgTree() {
        var kw = STATE.kw.toLowerCase();
        var byDept = {};
        $.each(STATE.contacts, function (k, c) {
            if (kw && [c.name, c.deptName, c.jobTitle].join(' ').toLowerCase().indexOf(kw) < 0) { return; }
            var did = num(c.deptId);
            if (!byDept[did]) { byDept[did] = []; }
            byDept[did].push(c);
        });
        var kids = STATE.orgChildren || {};
        var rendered = 0;

        function subtreeCount(pid) {
            var n = (byDept[pid] || []).length;
            $.each(kids[pid] || [], function (i, cid) { n += subtreeCount(cid); });
            return n;
        }

        function drawDept(pid, depth) {
            $.each(kids[pid] || [], function (i, id) {
                var d = STATE.orgById[id];
                if (!d) { return; }
                var total = subtreeCount(id);
                if (!total) { return; }                       // 空部门不占位
                var hasChild = (kids[id] || []).length > 0 || (byDept[id] || []).length > 0;
                var collapsed = !kw && !!STATE.collapsed[id]; // 检索时强制展开
                var pad = 8 + depth * 14;
                $list.append('<div class="pi-dept" data-dept="' + id + '" style="padding-left:' + pad + 'px">' +
                    '<span class="pi-dept__caret' + (hasChild ? '' : ' is-leaf') + '">' + (collapsed ? '▸' : '▾') + '</span>' +
                    '<span class="pi-dept__name">' + esc(d.name) + '</span>' +
                    '<span class="pi-dept__count">' + total + '</span></div>');
                rendered++;
                if (collapsed) { return; }
                $.each(byDept[id] || [], function (j, c) {
                    $list.append(makeItem(c, false, depth + 1));
                });
                drawDept(id, depth + 1);
            });
        }
        drawDept(0, 0);

        // 部门 ID 对不上的人（或 deptId=0）：收在「未分部门」
        var rest = [];
        $.each(byDept, function (did, arr) {
            var n = num(did);
            if (n && STATE.orgById[n]) { return; }
            $.each(arr, function (i, c) { rest.push(c); });
        });
        if (rest.length) {
            rest.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
            var collapsedRest = !kw && !!STATE.collapsed[0];
            $list.append('<div class="pi-dept" data-dept="0" style="padding-left:8px">' +
                '<span class="pi-dept__caret">' + (collapsedRest ? '▸' : '▾') + '</span>' +
                '<span class="pi-dept__name">未分部门</span>' +
                '<span class="pi-dept__count">' + rest.length + '</span></div>');
            if (!collapsedRest) {
                $.each(rest, function (i, c) { $list.append(makeItem(c, false, 1)); });
            }
            rendered++;
        }
        if (!rendered) { $list.append(emptyTip('暂无联系人')); }
    }

    /* ------------------------------ 员工详情 ------------------------------ */

    function openEmpDetail(c) {
        MODAL.mode = 'detail';
        MODAL.groupId = '';
        showErr('');
        $modalTitle.text('员工详情');
        $modalOk.attr('hidden', 'hidden');                 // 详情只看，不需要「确定」
        $modalCancel.text('关闭');
        $modalBody.html('<div class="pi-detail__loading">正在加载…</div>');
        $modal.removeAttr('hidden');
        setTimeout(function () { $modalCancel.focus(); }, 0);

        function paint(d) {
            d = d || {};
            function pick(a, b) { return d[a] || d[b] || ''; }
            var rows = [
                ['姓名', pick('nameCn', 'name') || c.name || ''],
                ['工号', pick('code', 'empCode') || c.code || ''],
                ['部门', pick('deptName', 'dept') || c.deptName || ''],
                ['职位', pick('jobTitle', 'duty') || c.jobTitle || ''],
                ['手机', pick('phone', 'mobile')],
                ['邮箱', pick('email', 'mail')],
                ['状态', pick('statusText', 'statusName') || c.statusText || ''],
                ['在线', c.online ? '在线' : '离线']
            ];
            var html = '<div class="pi-detail">';
            $.each(rows, function (i, r) {
                if (!r[1]) { return; }
                var kind = r[0] === '手机' ? 'phone' : (r[0] === '邮箱' ? 'email' : '');
                var copy = '';
                if (kind) {
                    var tip = kind === 'phone' ? '复制手机号' : '复制邮箱';
                    copy = '<button type="button" class="pi-copy" data-kind="' + kind +
                        '" data-copy="' + esc(r[1]) + '" title="' + tip + '" aria-label="' + tip + '">' +
                        '<svg class="svg-ico" viewBox="0 0 24 24"><path fill="currentColor" d="M9 3h9a2 2 0 012 2v9h-2V5H9V3zM6 7h9a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2zm0 2v10h9V9H6z"/></svg>' +
                        '</button>';
                }
                html += '<div class="pi-detail__row"><span class="pi-detail__k">' + esc(r[0]) + '</span>' +
                    '<span class="pi-detail__v">' + esc(r[1]) + '</span>' + copy + '</div>';
            });
            $modalBody.html(html + '</div>');
        }

        paint(null);                                       // 先用列表里的字段撑住
        if (window.Api && Api.emp && Api.emp.detail) {
            Api.emp.detail(num(c.empId)).done(function (res) {
                var d = payload(res) || {};
                paint(d.data || d);
            }).fail(function () { /* 拉不到详情就保持列表字段 */ });
        }
    }

    /* ------------------------------ 群成员（群主可增删） ------------------------------ */

    var MEMBERS = { data: null, isOwner: false, picked: {} };

    function openGroupMembers(gid) {
        var g = STATE.groups[String(gid)] || {};
        MODAL.mode = 'members';
        MODAL.groupId = String(gid);
        MODAL.owner = amOwner(g);
        MEMBERS.data = null;
        MEMBERS.isOwner = MODAL.owner;
        MEMBERS.picked = {};
        showErr('');
        $modalTitle.text('群成员');
        $modalCancel.text('关闭');
        if (MODAL.owner) { $modalOk.removeAttr('hidden').prop('disabled', false).text('保存'); }
        else { $modalOk.attr('hidden', 'hidden'); }
        $modalBody.html('<div class="pi-groupinfo"><div class="pi-groupinfo__name">' +
            esc(g.name || '群聊') + '</div></div><div class="pi-detail__loading">正在加载成员…</div>');
        $modal.removeAttr('hidden');

        if (!(window.Api && Api.msg && Api.msg.groupDetail)) { return; }
        Api.msg.groupDetail(String(gid)).done(function (res) {
            var d = payload(res) || {};
            d = d.data || d;
            MEMBERS.data = d;
            if (!MODAL.owner && num(d.ownerId) === num(STATE.me)) {
                MODAL.owner = true;
                MEMBERS.isOwner = true;
                $modalOk.removeAttr('hidden').text('保存');
            }
            $.each(d.members || [], function (i, m) { MEMBERS.picked[num(m.empId)] = 1; });
            renderMembers();
        }).fail(function (x) {
            $modalBody.html('<div class="pi-groupinfo"><div class="pi-groupinfo__name">' +
                esc(g.name || '群聊') + '</div></div>' +
                '<div class="pi-detail__loading">' + esc((x && x.message) || '成员列表加载失败') + '</div>');
        });
    }

    function renderMembers() {
        var d = MEMBERS.data || {};
        var members = d.members || [];
        var ownerId = num(d.ownerId);
        var inGroup = {};
        $.each(members, function (i, m) { inGroup[num(m.empId)] = 1; });

        var sel = 0;
        $.each(MEMBERS.picked, function (k, v) { if (v) { sel++; } });

        var html = '<div class="pi-groupinfo">' +
            '<div class="pi-groupinfo__name">' + esc(d.name || '') + '</div>' +
            '<div class="pi-groupinfo__meta">' + (sel || num(d.memberCount) || members.length) + ' 位成员' +
            (MEMBERS.isOwner ? ' · 勾选或取消后点「保存」' : ' · 只有群主可以管理成员') + '</div></div>';

        html += '<div class="pi-gmembers">';
        html += '<div class="pi-gmembers__title">群内成员</div>';
        $.each(members, function (i, m) {
            var id = num(m.empId);
            var isOwner = m.isOwner === true || (ownerId && id === ownerId);
            html += '<div class="pi-gmember' + (MEMBERS.isOwner && !isOwner ? ' is-pickable' : '') +
                '" data-emp="' + id + '" data-in="1">' +
                (MEMBERS.isOwner
                    ? '<input type="checkbox"' + (MEMBERS.picked[id] ? ' checked' : '') + (isOwner ? ' disabled' : '') + '>'
                    : '') +
                '<span class="pi-avatar pi-avatar--sm">' + esc(avText(m.name || m.nameCn || '')) + '</span>' +
                '<span class="pi-gmember__body">' +
                    '<span class="pi-gmember__name">' + esc(m.name || m.nameCn || ('员工' + id)) +
                        (isOwner ? '<span class="pi-gmember__tag">群主</span>' : '') + '</span>' +
                    '<span class="pi-gmember__sub">' + esc(m.deptName || m.jobTitle || '') + '</span>' +
                '</span></div>';
        });

        if (MEMBERS.isOwner) {
            var cands = [];
            $.each(STATE.contacts, function (k, c) {
                if (!inGroup[num(c.empId)]) { cands.push(c); }
            });
            cands.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
            if (cands.length) {
                html += '<div class="pi-gmembers__title">添加成员（点一下勾选）</div>';
                $.each(cands, function (i, c) {
                    var id = num(c.empId);
                    html += '<div class="pi-gmember is-pickable" data-emp="' + id + '">' +
                        '<input type="checkbox"' + (MEMBERS.picked[id] ? ' checked' : '') + '>' +
                        '<span class="pi-avatar pi-avatar--sm">' + esc(avText(c.name)) + '</span>' +
                        '<span class="pi-gmember__body">' +
                            '<span class="pi-gmember__name">' + esc(c.name || '') + '</span>' +
                            '<span class="pi-gmember__sub">' + esc(c.deptName || c.jobTitle || '') + '</span>' +
                        '</span></div>';
                });
            }
        }
        html += '</div>';
        $modalBody.html(html);
    }

    function saveMembers() {
        var ids = [];
        $.each(MEMBERS.picked, function (k, v) {
            if (v && num(k) !== num(STATE.me)) { ids.push(num(k)); }
        });
        if (!ids.length) { showErr('请至少保留一位成员'); return; }
        showErr('');
        $modalOk.prop('disabled', true);
        Api.msg.groupUpdate({ groupId: MODAL.groupId, memberIds: ids }).done(function (res) {
            var d = payload(res);
            $modalOk.prop('disabled', false);
            if (d && d.code && d.code !== 0) { showErr(d.message || '保存失败'); return; }
            closeModal();
            loadGroups();
            toast('群成员已更新');
        }).fail(function (x) {
            $modalOk.prop('disabled', false);
            showErr((x && x.message) || '保存失败，请重试');
        });
    }


    /* ------------------------------ 双击弹出的即时对话小窗 ------------------------------ */

    function chatNow() {
        var d = new Date();
        var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
        return p2(d.getHours()) + ':' + p2(d.getMinutes());
    }
    /** 气泡时间：短格式，避免把完整日期顶在每条上 */
    function chatWinTime(t) {
        if (!t) { return ''; }
        var s = String(t).replace('T', ' ');
        if (s.length <= 5) { return s; }
        var hm = s.slice(11, 16) || s.slice(0, 5);
        var d = s.slice(0, 10);
        var now = new Date();
        var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
        var td = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
        return d === td ? hm : (s.slice(5, 10) + ' ' + hm);
    }
    function chatMatches(gid, senderId) {
        if (!CHAT.open) { return false; }
        if (CHAT.kind === 'group') { return !!gid && String(gid) === String(CHAT.id); }
        return !gid && num(senderId) === num(CHAT.id);
    }
    function isChatOpen() { return !!(CHAT.open && $chatWin && !$chatWin.is('[hidden]')); }

    /* -------- 小窗拖动：按住标题栏移动，夹在视口内（最大化时不可拖） -------- */
    function chatPoint(e) {
        var oe = e.originalEvent || e;
        var t = (oe.touches && oe.touches[0]) || (oe.changedTouches && oe.changedTouches[0]);
        if (t) { return { x: t.clientX, y: t.clientY }; }
        if (typeof oe.clientX === 'number') { return { x: oe.clientX, y: oe.clientY }; }
        return null;
    }
    function clearChatPos() {
        CHAT.pos = null;
        if ($chatWin) {
            $chatWin.removeClass('is-moved').css({ left: '', top: '', transform: '', '-webkit-transform': '' });
        }
    }
    function applyChatPos() {
        if (!CHAT.pos || !$chatWin) { return; }
        var w = $chatWin[0].offsetWidth || 720, h = $chatWin[0].offsetHeight || 620;
        var vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
        CHAT.pos.left = Math.min(Math.max(0, CHAT.pos.left), Math.max(0, vw - w));
        CHAT.pos.top = Math.min(Math.max(0, CHAT.pos.top), Math.max(0, vh - h));
        $chatWin.addClass('is-moved').css({
            left: CHAT.pos.left + 'px', top: CHAT.pos.top + 'px',
            transform: 'none', '-webkit-transform': 'none'
        });
    }
    function onChatDragStart(e) {
        if (!CHAT.open || CHAT.max) { return; }
        var pt = chatPoint(e);
        if (!pt) { return; }
        var r = $chatWin[0].getBoundingClientRect();
        CHAT.pos = { left: r.left, top: r.top };
        applyChatPos();
        DRAG.on = true;
        DRAG.dx = pt.x - r.left;
        DRAG.dy = pt.y - r.top;
        $chatWin.addClass('is-dragging');
        if (e.preventDefault) { e.preventDefault(); }
    }
    function onChatDragMove(e) {
        if (!DRAG.on || !CHAT.pos) { return; }
        var pt = chatPoint(e);
        if (!pt) { return; }
        CHAT.pos.left = pt.x - DRAG.dx;
        CHAT.pos.top = pt.y - DRAG.dy;
        applyChatPos();
        if (e.preventDefault) { e.preventDefault(); }
    }
    function onChatDragEnd() {
        if (!DRAG.on) { return; }
        DRAG.on = false;
        if ($chatWin) { $chatWin.removeClass('is-dragging'); }
    }

    function openChat(kind, id) {
        var isGroup = kind === 'group';
        var c = isGroup ? STATE.groups[String(id)] : STATE.contacts[num(id)];
        if (!c) { return; }
        CHAT.open = true;
        CHAT.kind = isGroup ? 'group' : 'peer';
        CHAT.id = String(id);
        CHAT.list = [];
        $chatWinTitle.text(c.name || '会话');
        $chatWinSub.html(isGroup
            ? ('<span class="pi-off">' + num(c.memberCount) + ' 位成员</span>')
            : (c.online ? '<span class="pi-on">● 在线</span>' : '<span class="pi-off">○ 离线</span>'));
        $chatWin.removeAttr('hidden');
        mountChatEditor();
        clearChatInput();
        closePiMention();
        clearChatPos();                              // 每次开窗回到居中
        closeEmojiPanel();
        stopVoice(false);                            // 切会话时丢弃未发完的录音
        setStatus('');
        if (CHAT.max) { toggleMax(); }               // 每次开窗回到默认尺寸
        renderChatWin();
        setTimeout(function () { (CHAT_EDITOR ? CHAT_EDITOR.focus() : $chatWinInput.focus()); }, 0);

        var openId = CHAT.id, openKind = CHAT.kind;
        /** 历史回来时只替换「服务端部分」，保留本地刚发出、还没回执的气泡（否则刚发就被覆盖） */
        function mergeHistory(list) {
            if (CHAT.id !== openId || CHAT.kind !== openKind) { return; }   // 已经切到别的会话了
            var pending = [];
            $.each(CHAT.list, function (i, m) {
                if (m.temp || !m.id) { pending.push(m); }
            });
            CHAT.list = (list || []).concat(pending);
            renderChatWin();
        }

        if (isGroup) {
            loadChatMembers();
            Api.msg.groupHistory(CHAT.id).done(function (res) {
                var d = payload(res) || {};
                if (d.group) {
                    c.memberCount = num(d.group.memberCount);
                    $chatWinSub.html('<span class="pi-off">' + num(c.memberCount) + ' 位成员</span>');
                }
                mergeHistory(d.list || []);
            });
            if (Api.msg.markGroup) { Api.msg.markGroup(CHAT.id).fail(function () { }); }
            if (STATE.socket && STATE.socket.connected) { STATE.socket.send({ type: 'read', groupId: CHAT.id }); }
        } else {
            Api.msg.history(num(CHAT.id)).done(function (res) {
                var d = payload(res) || {};
                if (d.peer) { c.online = !!d.peer.online; }
                $chatWinSub.html(c.online ? '<span class="pi-on">● 在线</span>' : '<span class="pi-off">○ 离线</span>');
                mergeHistory(d.list || []);
            });
            Api.msg.markPeer(num(CHAT.id)).fail(function () { });
            if (STATE.socket && STATE.socket.connected) { STATE.socket.send({ type: 'read', peerId: num(CHAT.id) }); }
        }
        if (num(c.unread)) { c.unread = 0; renderList(); }   // 打开即清未读（红点/角标一起回落）
    }

    function closeChat() {
        if (!CHAT.open) { return; }
        CHAT.open = false;
        CHAT.kind = '';
        CHAT.id = '';
        CHAT.list = [];
        closePiMention();
        closeEmojiPanel();
        stopVoice(false);                            // 关窗丢弃未发完的录音
        if ($chatWin) { $chatWin.attr('hidden', 'hidden'); }
    }

    function chatPreviewOf(m) {
        var t = m.msgType || 'text';
        if (t === 'image') { return '[图片]'; }
        if (t === 'file') { return '[文件]' + (m.attach && m.attach.name ? ' ' + m.attach.name : ''); }
        if (t === 'sticker') { return '[表情]'; }
        return m.content || '';
    }

    /** 气泡内容：文字 / 图片 / 表情包 / 文件 / 纯 emoji（与即时对话页同口径） */
    function bubbleHtml(m) {
        var t = m.msgType || 'text';
        var att = m.attach || null;
        if (t === 'image' && att && att.url) {
            return '<span class="pi-bubble is-media"><img class="pi-img" src="' + esc(att.url) +
                '" alt="' + esc(att.name || '图片') + '"><\/span>';
        }
        if (t === 'sticker' && att && att.url) {
            return '<span class="pi-bubble is-media"><img class="pi-sticker" src="' + esc(att.url) +
                '" alt="' + esc(att.name || '表情') + '"><\/span>';
        }
        if (t === 'audio' && att && att.url) {
            return '<span class="pi-bubble is-media"><audio class="pi-audio" controls preload="metadata" src="' +
                esc(att.url) + '"><\/audio><\/span>';
        }
        if (t === 'file' && att) {
            var ex = att.ext || extOf(att.name);
            return '<span class="pi-bubble is-media">' +
                '<a class="pi-file" href="' + esc(att.url || '#') + '" target="_blank" rel="noopener"' +
                ' download="' + esc(att.name || '') + '">' +
                '<span class="pi-file__ico">' + esc(String(ex || 'FILE').toUpperCase().slice(0, 4)) + '</span>' +
                '<span class="pi-file__body">' +
                '<span class="pi-file__name">' + esc(att.name || '文件') + '</span>' +
                '<span class="pi-file__meta">' + esc(fmtSize(att.size)) + '</span>' +
                '</span><span class="pi-file__dl">下载</span></a></span>';
        }
        // 富文本：contentHtml 渲染前必须 sanitize；@ 到自己的群消息加浅色描边
        var rich = m.contentHtml ? String(m.contentHtml) : '';
        if (rich && window.RichText && !window.RichText.isEmptyHtml(rich)) {
            return '<span class="pi-bubble is-rich' + (chatAtMe(m) ? ' is-artme' : '') + '">' +
                window.RichText.sanitize(rich) + '<\/span>';
        }
        if (isEmojiOnly(m.content)) {
            return '<span class="pi-bubble is-emoji">' + esc(m.content) + '<\/span>';
        }
        return '<span class="pi-bubble">' + esc(m.content) + '<\/span>';
    }

    function renderChatWin() {
        if (!$chatWinBody) { return; }
        $chatWinBody.empty();
        if (!CHAT.list.length) {
            $chatWinBody.append('<div class="pi-chat__tip">还没有消息，打个招呼吧</div>');
        }
        $.each(CHAT.list, function (i, m) {
            var mine = !!m.isMe;
            var from = (!mine && CHAT.kind === 'group') ? (m.senderName || '') : '';
            var $m = $('<div class="pi-msg' + (mine ? ' is-me' : '') + '">' +
                '<span class="pi-msg__avatar">' + esc(avText(mine ? '我' : (m.senderName || CHAT.name))) + '</span>' +
                '<span class="pi-msg__wrap">' +
                    (from ? '<span class="pi-msg__from">' + esc(from) + '</span>' : '') +
                    bubbleHtml(m) +
                    '<span class="pi-meta">' + esc(chatWinTime(m.sendTime)) +
                        (mine ? (m.error ? ' · 发送失败' : (m.temp ? ' · 发送中…' : (m.read ? ' · 已读' : ' · 已发送'))) : '') +
                    '</span>' +
                '</span></div>');
            $chatWinBody.append($m);
        });
        $chatWinBody.scrollTop($chatWinBody[0].scrollHeight);
        bindAudioFallback($chatWinBody);
    }

    /** 语音加载失败时的兜底链接 */
    function bindAudioFallback($root) {
        $root.find('audio.pi-audio').each(function () {
            var el = this;
            if (el.__audioFallback) { return; }
            el.__audioFallback = true;
            el.addEventListener('error', function () {
                var $a = $(el);
                if ($a.next('.pi-audio-fail').length) { return; }
                $a.after('<a class="pi-audio-fail" href="' + el.getAttribute('src') +
                    '" target="_blank" rel="noopener" download>语音无法播放，点此下载</a>');
            });
        });
    }

    /* ---------- 富文本输入 + 群聊 @ 组员（复用 js/rich-text.js，与即时对话页同口径） ---------- */

    /** 小窗输入区挂富文本编辑器（幂等；没有 rich-text.js 时退回纯文本 div） */
    function mountChatEditor() {
        if (CHAT_EDITOR || !$chatWinInput || !$chatWinInput.length) { return; }
        if (!window.RichText || !window.RichText.mount) { return; }
        CHAT_EDITOR = window.RichText.mount($chatWinInput, {
            placeholder: '输入消息，Enter 发送 / Shift+Enter 换行',
            label: '消息格式',
            at: true,
            onMention: openPiMention
        });
    }

    function chatInputText() {
        if (CHAT_EDITOR) { return $.trim(CHAT_EDITOR.text() || ''); }
        return $.trim($chatWinInput.text() || '');
    }
    function chatInputHtml() {
        return CHAT_EDITOR ? (CHAT_EDITOR.html() || '') : '';
    }
    function clearChatInput() {
        if (CHAT_EDITOR) { CHAT_EDITOR.clear(); return; }
        $chatWinInput.empty();
    }
    /** 收集本条消息 @ 到的组员（以编辑器里真实存在的 .im-at 为准） */
    function collectChatAtIds() {
        var out = [], seen = {};
        var el = CHAT_EDITOR && CHAT_EDITOR.el;
        if (!el) { return out; }
        $(el).find('.im-at[data-emp]').each(function () {
            var n = num($(this).attr('data-emp'));
            if (n && !seen[n]) { seen[n] = 1; out.push(n); }
        });
        return out;
    }
    /** 这条消息是否 @ 到了我 */
    function chatAtMe(m) {
        var ids = String((m && m.atEmpIds) || '').split(',');
        for (var i = 0; i < ids.length; i++) {
            if (num(ids[i]) && num(ids[i]) === num(STATE.me)) { return true; }
        }
        return false;
    }

    /** 群成员（@ 用）：优先缓存，没有再拉 groupDetail */
    function loadChatMembers(done) {
        var gid = CHAT.id;
        if (CHAT.membersOf === gid && CHAT.members.length) { if (done) { done(); } return; }
        if (!Api.msg.groupDetail) { if (done) { done(); } return; }
        Api.msg.groupDetail(gid).done(function (res) {
            var d = payload(res) || {};
            CHAT.members = d.members || [];
            CHAT.membersOf = gid;
            if (done) { done(); }
        }).fail(function () { if (done) { done(); } });
    }

    function renderPiMentionList(keyword) {
        var kw = $.trim(keyword || '').toLowerCase();
        var html = '', shown = 0;
        $.each(CHAT.members, function (i, m) {
            if (num(m.empId) === num(STATE.me)) { return; }        // 不 @ 自己
            if (kw && String(m.name || '').toLowerCase().indexOf(kw) < 0) { return; }
            html += '<div class="pi-mention__item" data-emp="' + esc(m.empId) + '" data-name="' + esc(m.name) + '">' +
                '<span class="pi-mention__av">' + esc(avText(m.name)) + '</span>' +
                '<span class="pi-mention__name">' + esc(m.name) + '</span></div>';
            shown++;
        });
        if (!shown) {
            html = '<div class="pi-mention__empty">' + (kw ? '没有匹配的组员' : '群里还没有其他成员') + '</div>';
        }
        $piMentionList.html(html);
    }

    function openPiMention() {
        if (CHAT.kind !== 'group') {
            setStatus('只有群聊里可以 @ 组员', true);
            return;
        }
        if (!$piMention || !$piMention.length) { return; }
        $piMention.removeAttr('hidden');
        $piMentionKw.val('');
        if (CHAT.membersOf === CHAT.id && CHAT.members.length) {
            renderPiMentionList('');
        } else {
            $piMentionList.html('<div class="pi-mention__empty">加载中…</div>');
            loadChatMembers(function () { renderPiMentionList(''); });
        }
    }

    function closePiMention() {
        if ($piMention && $piMention.length) { $piMention.attr('hidden', 'hidden'); }
    }

    /** 删掉键入的 @（点选后不留孤零零的 @） */
    function dropTrailingAt() {
        var el = CHAT_EDITOR && CHAT_EDITOR.el;
        if (!el) { return; }
        var texts = [], node;
        try {
            var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
            while ((node = walker.nextNode())) { texts.push(node); }
        } catch (e) { texts = []; }
        var last = null;
        for (var i = 0; i < texts.length; i++) {
            if (String(texts[i].nodeValue || '').replace(/\s/g, '')) { last = texts[i]; }
        }
        if (!last) { return; }
        var v = String(last.nodeValue || '');
        if (v.charAt(v.length - 1) === '@') { last.nodeValue = v.slice(0, -1); }
    }

    function insertPiMention(member) {
        if (!member || !member.empId || !CHAT_EDITOR) { return; }
        closePiMention();
        dropTrailingAt();
        CHAT_EDITOR.restoreRange();
        CHAT_EDITOR.insertHtml('<span class="im-at" data-emp="' + num(member.empId) + '">@' +
            esc(member.name) + '</span>&nbsp;');
        CHAT_EDITOR.focus();
    }

    function sendChat() {
        if (!CHAT.open) { return; }
        var text = chatInputText();
        if (!text) { return; }
        var html = chatInputHtml();
        var atIds = collectChatAtIds();
        var tempId = 'pic-' + (++CHAT.tempSeq);
        CHAT.list.push({
            id: null, content: text, contentHtml: html, atEmpIds: atIds.join(','),
            msgType: 'text', sendTime: chatNow(),
            isMe: true, temp: true, tempId: tempId, read: 0
        });
        clearChatInput();
        closePiMention();
        renderChatWin();

        if (STATE.socket && STATE.socket.connected) {
            STATE.socket.send({
                type: 'send',
                to: CHAT.kind === 'group' ? 0 : num(CHAT.id),
                groupId: CHAT.kind === 'group' ? CHAT.id : '',
                content: text, contentHtml: html, atEmpIds: atIds.join(','),
                msgType: 'text', tempId: tempId
            });
            return;
        }
        // 断线兜底：REST 直发
        var data = { content: text, contentHtml: html, atEmpIds: atIds.join(','), msgType: 'text' };
        if (CHAT.kind === 'group') { data.groupId = CHAT.id; } else { data.receiverIds = [num(CHAT.id)]; }
        Api.msg.send(data).done(function (res) {
            var d = payload(res);
            $.each(CHAT.list, function (i, m) {
                if (m.tempId !== tempId) { return; }
                m.temp = false;
                m.id = (d && d.ids && d.ids[0]) || null;
                if (d && d.sentTime) { m.sendTime = d.sentTime; }
            });
            renderChatWin();
        }).fail(function () {
            $.each(CHAT.list, function (i, m) {
                if (m.tempId === tempId) { m.temp = false; m.error = true; }
            });
            renderChatWin();
        });
    }

    /* ------------------------------ 媒体：图片 / 文件 / 表情 / 语音 / 截屏 ------------------------------ */

    function setStatus(text, isErr) {
        if (!$status) { return; }
        $status.text(text || '').css('color', isErr ? '#f56c6c' : '#909399');
    }
    function extOf(name) {
        var s = String(name || '');
        var i = s.lastIndexOf('.');
        return i >= 0 ? s.slice(i + 1) : '';
    }
    function fmtSize(n) {
        n = num(n);
        if (!n) { return '未知大小'; }
        if (n < 1024) { return n + ' B'; }
        if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
        return (n / 1024 / 1024).toFixed(1) + ' MB';
    }
    function isEmojiOnly(s) {
        var t = String(s || '').replace(/\s/g, '');
        if (!t || t.length > 12) { return false; }
        return !/[0-9A-Za-z\u4e00-\u9fa5]/.test(t);
    }

    /** 统一的「发出去」：WS 优先，断线走 REST；乐观气泡由调用方先塞进 CHAT.list */
    function deliverChat(msg) {
        var tempId = msg.tempId || ('pic-' + (++CHAT.tempSeq));
        msg.tempId = tempId;
        CHAT.list.push(msg);
        renderChatWin();
        if (STATE.socket && STATE.socket.connected) {
            STATE.socket.send({
                type: 'send',
                to: CHAT.kind === 'group' ? 0 : num(CHAT.id),
                groupId: CHAT.kind === 'group' ? CHAT.id : '',
                content: msg.content || '',
                contentHtml: msg.contentHtml || '',
                atEmpIds: msg.atEmpIds || '',
                msgType: msg.msgType || 'text',
                attachId: msg.attachId || '',
                tempId: tempId
            });
            return tempId;
        }
        var data = { content: msg.content || '', contentHtml: msg.contentHtml || '',
                     atEmpIds: msg.atEmpIds || '', msgType: msg.msgType || 'text', attachId: msg.attachId || '' };
        if (CHAT.kind === 'group') { data.groupId = CHAT.id; } else { data.receiverIds = [num(CHAT.id)]; }
        Api.msg.send(data).done(function (res) {
            var d = payload(res);
            $.each(CHAT.list, function (i, m) {
                if (m.tempId !== tempId) { return; }
                m.temp = false;
                m.id = (d && d.ids && d.ids[0]) || null;
                if (d && d.sentTime) { m.sendTime = d.sentTime; }
            });
            renderChatWin();
        }).fail(function () {
            $.each(CHAT.list, function (i, m) {
                if (m.tempId === tempId) { m.temp = false; m.error = true; }
            });
            renderChatWin();
        });
        return tempId;
    }

    function sendAttachment(att) {
        if (!att || !att.fileId || !CHAT.open) { return; }
        var isImage = att.kind === 'image';
        var isAudio = att.msgType === 'audio';
        deliverChat({
            id: null,
            content: isAudio ? '[语音]' : (isImage ? '[图片]' : '[文件]'),
            msgType: att.msgType || (isImage ? 'image' : 'file'),
            attachId: att.fileId,
            attach: att,
            sendTime: chatNow(),
            isMe: true, temp: true, read: 0
        });
    }

    function sendSticker(it) {
        if (!it || !it.fileId || !CHAT.open) { return; }
        deliverChat({
            id: null, content: '[表情]', msgType: 'sticker',
            attachId: it.fileId,
            attach: {
                fileId: it.fileId, name: it.name || '表情', url: it.url,
                size: 0, kind: 'image', ext: 'png', width: it.width, height: it.height
            },
            sendTime: chatNow(), isMe: true, temp: true, read: 0
        });
        closeEmojiPanel();
    }

    function pickFile(kind) {
        var $inp = kind === 'image' ? $fileImage : $fileAny;
        if (!$inp || !$inp.length) { return; }
        $inp.val('');
        $inp[0].click();
    }

    function uploadFile(file, kind) {
        if (!CHAT.open || !file) { return; }
        if (file.size > MEDIA.maxBytes) { setStatus('附件不能超过 20 MB', true); return; }
        var name = file.name || (kind === 'image' ? ('图片_' + Date.now() + '.png') : '文件');
        setStatus('正在读取 ' + name + '…');
        var reader = new FileReader();
        reader.onload = function () {
            var durl = String(reader.result || '');
            if (kind === 'image') {
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
        setStatus('正在上传 ' + name + '…');
        Api.msg.upload({ fileName: name, data: durl, kind: kind, width: w, height: h })
            .done(function (res) {
                var d = payload(res);
                if (!d || !d.fileId) { setStatus('上传失败，请重试', true); return; }
                var att = {
                    fileId: d.fileId, name: d.name || d.fileName || name,
                    url: d.url || durl, size: d.size || d.fileSize || 0,
                    kind: d.kind || kind, width: w, height: h,
                    ext: d.ext || extOf(name), mimeType: d.mimeType || ''
                };
                setStatus('');
                sendAttachment(att);
            })
            .fail(function () { setStatus('上传失败，请重试', true); });
    }

    /** 截屏：getDisplayMedia 抓一帧 → IMShot 框选标注 → 上传发送（与即时对话页同流程） */
    function takeShot() {
        var md = navigator.mediaDevices;
        if (!md || !md.getDisplayMedia) {
            setStatus('当前浏览器不支持截屏，可直接 Ctrl+V 粘贴截图', true);
            return;
        }
        if (!CHAT.open) { return; }
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
                setStatus('已捕获画面，请拖选要截取的区域');
                if (window.IMShot && window.IMShot.open) {
                    window.IMShot.open(durl, {
                        onSend: function (outUrl, ow, oh) {
                            setStatus('截屏已标注，正在发送…');
                            doUploadAndSend(outUrl, '截屏_' + Date.now() + '.png', 'image', ow, oh);
                        },
                        onCancel: function () { setStatus('已取消截屏'); }
                    });
                    return;
                }
                doUploadAndSend(durl, '截屏_' + Date.now() + '.png', 'image', w, h);
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
            video.onloadedmetadata = function () { setTimeout(grab, 220); };
            try { video.play(); } catch (e) { /* 忽略 */ }
            setTimeout(function () { if (!done) { grab(); } }, 1500);
        }).catch(function (err) {
            var name = (err && err.name) || '';
            setStatus(name === 'NotAllowedError' || name === 'AbortError'
                ? '已取消截屏' : ('截屏失败：' + (err && err.message ? err.message : name)), true);
        });
    }

    /* ---------------- 语音消息：MediaRecorder 录音 → 上传 → 发送 audio ----------------
       原来用 SpeechRecognition 听写依赖浏览器云端识别服务（内网/离线会报 network 错），
       改为本地录音后作为语音消息发送，不依赖云服务。 */
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
        if (MEDIA.voiceOn) { stopVoice(true); return; }
        if (!voiceSupported()) {
            setStatus('当前浏览器不支持录音，建议用 Chrome / Edge', true);
            return;
        }
        var mime = voiceMime();
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
            var rec;
            try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {}); }
            catch (e) { rec = new MediaRecorder(stream); }
            MEDIA.rec = rec;
            MEDIA.chunks = [];
            MEDIA.voiceOn = true;
            MEDIA.startAt = Date.now();
            startLevelMeter(stream);
            if ($toolVoice) { $toolVoice.addClass('is-active'); }
            setStatus('录音中… 0s，点一下麦克风结束并发送');
            if (MEDIA.timer) { clearInterval(MEDIA.timer); }
            MEDIA.timer = setInterval(function () {
                setStatus('录音中… ' + Math.floor((Date.now() - MEDIA.startAt) / 1000) + 's' + voiceLevelText());
            }, 400);
            rec.ondataavailable = function (ev) {
                if (ev.data && ev.data.size) { MEDIA.chunks.push(ev.data); }
            };
            rec.onstop = function () {
                var type = String(rec.mimeType || mime || 'audio/webm').split(';')[0];
                var sec = Math.max(1, Math.round((Date.now() - MEDIA.startAt) / 1000));
                var peak = MEDIA.peak;
                var meterOn = MEDIA.meterOn;
                stopLevelMeter();
                try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 忽略 */ }
                var blob = null;
                try { blob = new Blob(MEDIA.chunks, { type: type }); } catch (e) { blob = null; }
                MEDIA.chunks = [];
                // 全程没有电平 → 麦克风没收到声音：不发，直接提示
                if (meterOn && peak < 0.01) {
                    setStatus('没有检测到声音：请检查麦克风是否被静音、或系统默认输入设备是否选对', true);
                    return;
                }
                finishVoice(blob, type, sec);
            };
            try { rec.start(); }
            catch (e) { setStatus('录音启动失败，请重试', true); stopVoice(false); }
        }).catch(function (err) {
            var name = (err && err.name) || '';
            var m = (name === 'NotAllowedError' || name === 'SecurityError')
                ? '麦克风被拒绝，请在地址栏允许麦克风权限'
                : (name === 'NotFoundError' ? '找不到麦克风设备' : ('录音启动失败：' + (name || '未知错误')));
            setStatus(m, true);
            stopVoice(false);
        });
    }

    /** send=false 表示放弃这次录音 */
    function stopVoice(send) {
        var rec = MEDIA.rec;
        MEDIA.voiceOn = false;
        if ($toolVoice) { $toolVoice.removeClass('is-active'); }
        if (MEDIA.timer) { clearInterval(MEDIA.timer); MEDIA.timer = null; }
        stopLevelMeter();
        MEDIA.rec = null;
        if (rec && rec.state !== 'inactive') {
            if (send === false) { try { rec.onstop = null; } catch (e) { /* 忽略 */ } }
            try { rec.stop(); } catch (e) { /* 已停止 */ }
        } else if (send) {
            setStatus('没有录到声音', true);
        }
    }

    function finishVoice(blob, type, sec) {
        if (!blob || !blob.size) { setStatus('没有录到声音', true); return; }
        if (blob.size > MEDIA.maxBytes) { setStatus('语音太长，请分段发送', true); return; }
        if (!CHAT.open) { return; }
        var ext = type.indexOf('ogg') >= 0 ? 'ogg' : (type.indexOf('mp4') >= 0 ? 'm4a' : 'webm');
        var name = '语音_' + sec + 's_' + Date.now() + '.' + ext;
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

    /* -------- 表情面板：Unicode emoji + 图片表情包 -------- */
    var EMOJI_GROUPS = [
        { key: 'smile', name: '笑脸', items: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😋', '😛', '😜', '🤪', '🤗', '🤔', '😐', '😑', '😶', '🙄', '😏', '😴', '😌', '😔', '😷', '🤒', '🥳', '🥺', '😢', '😭', '😤', '😠', '😡', '😱', '😳', '🥵', '🥶', '😵', '🤯', '😈', '💩'] },
        { key: 'hand', name: '手势', items: ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '👏', '🙌', '🙏', '🤝', '💪', '👊', '✊', '🤛', '🤜'] },
        { key: 'heart', name: '心情', items: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '✨', '⭐', '🌟', '💫', '🔥', '💥'] },
        { key: 'object', name: '物品', items: ['🎁', '🎂', '🍺', '☕', '🍎', '🍉', '🍔', '🍜', '🚀', '✈️', '🚗', '⏰', '📎', '📌', '💡', '🔔', '📢', '📣', '✅', '❌', '⚠️', '❓', '❗', '💯'] },
        { key: 'animal', name: '动物', items: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦄', '🐝', '🦋', '🐢', '🐳'] }
    ];
    var EMOJI_TAB_KEY = 'menu_admin_im_emoji_tab';

    function closeEmojiPanel() {
        MEDIA.emojiOpen = false;
        if ($emojiPanel) { $emojiPanel.attr('hidden', 'hidden'); }
        if ($toolEmoji) { $toolEmoji.removeClass('is-active'); }
    }
    function toggleEmojiPanel() {
        if (MEDIA.emojiOpen) { closeEmojiPanel(); return; }
        MEDIA.emojiOpen = true;
        if ($emojiPanel) { $emojiPanel.removeAttr('hidden'); }
        if ($toolEmoji) { $toolEmoji.addClass('is-active'); }
        renderEmojiPanel();
    }
    function loadStickers(done) {
        if (!Api.msg.emojis) { if (done) { done(); } return; }
        Api.msg.emojis().done(function (res) {
            var d = payload(res);
            MEDIA.stickers = (d && d.list) || [];
            if (done) { done(); }
        }).fail(function () { if (done) { done(); } });
    }
    function renderEmojiPanel() {
        if (!$emojiPanel) { return; }
        $emojiPanel.empty();
        var $tabs = $('<div class="pi-emoji__tabs"></div>');
        var keys = [];
        $.each(EMOJI_GROUPS, function (i, g) {
            keys.push(g.key);
            $tabs.append('<button type="button" class="pi-emoji__tab' + (MEDIA.tab === g.key ? ' is-active' : '') +
                '" data-tab="' + g.key + '">' + esc(g.name) + '</button>');
        });
        if (MEDIA.stickers.length) {
            keys.push('sticker');
            $tabs.append('<button type="button" class="pi-emoji__tab' + (MEDIA.tab === 'sticker' ? ' is-active' : '') +
                '" data-tab="sticker">表情包</button>');
        }
        if (keys.indexOf(MEDIA.tab) < 0) { MEDIA.tab = keys[0]; }
        $tabs.on('click', '.pi-emoji__tab', function () {
            MEDIA.tab = $(this).attr('data-tab');
            try { window.localStorage.setItem(EMOJI_TAB_KEY, MEDIA.tab); } catch (e) { /* 忽略 */ }
            renderEmojiPanel();
        });
        $emojiPanel.append($tabs);

        var $grid = $('<div class="pi-emoji__grid"></div>');
        if (MEDIA.tab === 'sticker') {
            if (!MEDIA.stickers.length) {
                $grid.append('<div class="pi-emoji__tip">还没有表情包（可在「完整功能」里添加）</div>');
            } else {
                $.each(MEDIA.stickers, function (i, it) {
                    var $b = $('<button type="button" class="pi-emoji__item" title="' + esc(it.name || '表情') + '">' +
                        '<img src="' + esc(it.url || '') + '" alt="' + esc(it.name || '') + '"></button>');
                    $b.on('click', function () { sendSticker(it); });
                    $grid.append($b);
                });
            }
        } else {
            var grp = null;
            $.each(EMOJI_GROUPS, function (i, g) { if (g.key === MEDIA.tab) { grp = g; } });
            $.each((grp && grp.items) || [], function (i, ch) {
                var $b = $('<button type="button" class="pi-emoji__item">' + ch + '</button>');
                $b.on('click', function () { insertEmoji(ch); });
                $grid.append($b);
            });
        }
        $emojiPanel.append($grid);
    }
    function insertEmoji(ch) {
        var el = $chatWinInput[0];
        if (!el) { return; }
        var v = String(el.value || '');
        var s = typeof el.selectionStart === 'number' ? el.selectionStart : v.length;
        var e = typeof el.selectionEnd === 'number' ? el.selectionEnd : v.length;
        el.value = v.slice(0, s) + ch + v.slice(e);
        try { el.selectionStart = el.selectionEnd = s + ch.length; } catch (err) { /* 忽略 */ }
        el.focus();
    }

    function toggleMax() {
        CHAT.max = !CHAT.max;
        clearChatPos();                              // 最大化/还原都回到居中，避免和拖动坐标打架
        if ($chatWin) { $chatWin.toggleClass('is-max', CHAT.max); }
        if ($chatWinMax) {
            $chatWinMax.attr({ title: CHAT.max ? '还原' : '最大化', 'aria-label': CHAT.max ? '还原' : '最大化' })
                .text(CHAT.max ? '❐' : '⛶');
        }
    }

    /* ------------------------------ 实时（刷提示 + 小窗上屏） ------------------------------ */

    function onFrame(obj) {
        if (!obj || !obj.type) { return; }
        if (obj.type === 'presence') {
            var c = STATE.contacts[num(obj.empId)];
            if (c) {
                c.online = !!obj.online;
                renderList();
                if (CHAT.open && CHAT.kind === 'peer' && num(CHAT.id) === num(obj.empId)) {
                    $chatWinSub.html(c.online ? '<span class="pi-on">● 在线</span>' : '<span class="pi-off">○ 离线</span>');
                }
            }
            return;
        }
        if (obj.type === 'ack') {
            // 小窗里的乐观气泡收尾（发送中 → 已发送 / 失败）
            if (obj.tempId) {
                $.each(CHAT.list, function (i, m) {
                    if (m.tempId !== obj.tempId) { return; }
                    m.temp = false;
                    if (obj.error) { m.error = true; }
                    else {
                        m.id = obj.id;
                        if (obj.sendTime) { m.sendTime = obj.sendTime; }
                    }
                });
                if (CHAT.open) { renderChatWin(); }
            }
            return;
        }
        if (obj.type === 'msg') {
            var gid = String(obj.groupId || '');
            var current = chatMatches(gid, obj.senderId);

            // 小窗正开着这段会话：直接上屏 + 置已读，不计未读
            if (current) {
                CHAT.list.push({
                    id: obj.id,
                    senderId: num(obj.senderId),
                    senderName: obj.senderName || '',
                    content: obj.content,
                    contentHtml: obj.contentHtml || '',
                    atEmpIds: obj.atEmpIds || '',
                    msgType: obj.msgType || 'text',
                    attach: obj.attach || null,
                    sendTime: obj.sendTime || chatNow(),
                    isMe: false, read: 0
                });
                renderChatWin();
                if (gid) {
                    if (Api.msg.markGroup) { Api.msg.markGroup(gid).fail(function () { }); }
                    if (STATE.socket && STATE.socket.connected) { STATE.socket.send({ type: 'read', groupId: gid }); }
                } else {
                    Api.msg.markPeer(num(obj.senderId)).fail(function () { });
                    if (STATE.socket && STATE.socket.connected) { STATE.socket.send({ type: 'read', peerId: num(obj.senderId) }); }
                }
            }

            if (gid) {
                var g = STATE.groups[gid];
                if (g) {
                    if (!current) { g.unread = num(g.unread) + 1; }
                    g.lastContent = obj.msgType === 'image' ? '[图片]' : (obj.content || '');
                    g.lastTime = obj.sendTime || '';
                    g.lastSenderName = obj.senderName || '';
                    g.lastFromMe = false;
                }
            } else {
                var peer = STATE.contacts[num(obj.senderId)];
                if (peer) {
                    if (!current) { peer.unread = num(peer.unread) + 1; }
                    peer.lastContent = obj.msgType === 'image' ? '[图片]' : (obj.content || '');
                    peer.lastTime = obj.sendTime || '';
                    peer.lastFromMe = false;
                }
            }
            renderList();
            notifyFrame();
        }
    }

    /* ------------------------------ 连接 / 加载 ------------------------------ */

    function connect() {
        if (!window.Api || !Api.msg || !Api.msg.connect) { return; }
        STATE.manualClose = false;
        try {
            STATE.socket = Api.msg.connect({});
        } catch (e) {
            scheduleReconnect();
            return;
        }
        STATE.socket.on('open', function () {
            STATE.reconnectDelay = 1000;
            loadAll();                       // 重连后同步在线态与未读
        });
        STATE.socket.on('message', function (obj) { onFrame(obj); });
        STATE.socket.on('close', function () { if (!STATE.manualClose) { scheduleReconnect(); } });
        STATE.socket.on('error', function () { });
    }

    function scheduleReconnect() {
        if (STATE.manualClose || STATE.reconnectTimer) { return; }
        var delay = STATE.reconnectDelay;
        STATE.reconnectTimer = setTimeout(function () {
            STATE.reconnectTimer = null;
            if (STATE.manualClose) { return; }
            connect();
            STATE.reconnectDelay = Math.min(STATE.reconnectDelay * 2, 20000);
        }, delay);
    }

    function loadContacts(done) {
        Api.msg.contacts().done(function (res) {
            var d = payload(res) || {};
            STATE.contacts = {};
            $.each(d.list || [], function (i, c) {
                if (num(c.empId) === STATE.me) { return; }
                STATE.contacts[num(c.empId)] = c;
            });
            if (d.me) {
                STATE.me = num(d.me.empId) || STATE.me;
                STATE.meName = d.me.name || STATE.meName;
            }
            if ($me) { $me.text(STATE.meName || '—'); }
            STATE.loading = false;
            renderList();
            if (done) { done(); }
        }).fail(function () {
            STATE.loading = false;
            renderList();
        });
    }

    function loadGroups(done) {
        Api.msg.groups().done(function (res) {
            var d = payload(res) || {};
            STATE.groups = {};
            $.each(d.list || [], function (i, g) {
                STATE.groups[String(g.groupId)] = g;
            });
            renderList();
            if (done) { done(); }
        }).fail(function () { if (done) { done(); } });
    }

    /** 组织架构：拉部门树，按 DFS 顺序摊平成 [{id,name,depth}]，联系人按它分组 */
    function loadOrgs(done) {
        if (!window.Api || !Api.org || !Api.org.tree) { if (done) { done(); } return; }
        Api.org.tree().done(function (res) {
            try {
                var d = payload(res) || {};
                var rows = d.list || d.tree || [];
                var byParent = {};
                $.each(rows, function (i, r) {
                    var id = num(r.id);
                    if (!id) { return; }                  // 后端会带一行 id=0 的「顶级部门」虚拟根，跳过
                    var pid = num(r.parentId);
                    if (!byParent[pid]) { byParent[pid] = []; }
                    byParent[pid].push({ id: id, name: r.nameCn || r.name || '', parentId: pid });
                });
                var out = [], seen = {};
                (function walk(pid, depth) {
                    if (depth > 20) { return; }
                    $.each(byParent[pid] || [], function (i, n) {
                        if (seen[n.id]) { return; }       // 防环：父子互相指向时不再递归
                        seen[n.id] = 1;
                        out.push({ id: n.id, name: n.name, depth: depth, parentId: pid });
                        walk(n.id, depth + 1);
                    });
                })(0, 0);
                STATE.orgs = out;
                STATE.orgById = {};
                STATE.orgChildren = {};
                $.each(out, function (i, n) {
                    STATE.orgById[n.id] = n;
                    if (!STATE.orgChildren[n.parentId]) { STATE.orgChildren[n.parentId] = []; }
                    STATE.orgChildren[n.parentId].push(n.id);
                });
            } catch (e) {
                STATE.orgs = [];                          // 组织架构取不到就退回「未分部门」分组
            }
            if (done) { done(); }
        }).fail(function () {
            STATE.orgs = [];
            if (done) { done(); }
        });
    }

    function loadAll(done) {
        STATE.loading = true;
        renderList();
        loadOrgs(function () {
            loadContacts(function () { loadGroups(done); });
        });
    }

    /* ------------------------------ 生命周期 ------------------------------ */

    function bind() {
        $panel = $('#potatoIm');
        if (!$panel.length) { return false; }
        $list = $('#piList');
        bindItemTip();
        $me = $('#piMe');
        $search = $('#piSearch');
        $tabs = $panel.find('.pi-tab');
        $modal = $('#piModal');
        $modalTitle = $('#piModalTitle');
        $modalBody = $('#piModalBody');
        $modalErr = $('#piModalErr');
        $modalOk = $('#piModalOk');
        $modalCancel = $('#piModalCancel');
        $modalClose = $('#piModalClose');
        $modalMask = $('#piModalMask');
        $toast = $('#piToast');
        $newGroup = $('#piNewGroup');
        $dotContact = $('#piUnreadContact');
        $dotGroup = $('#piUnreadGroup');
        $chatWin = $('#piChatWin');
        $chatWinTitle = $('#piChatWinTitle');
        $chatWinSub = $('#piChatWinSub');
        $chatWinBody = $('#piChatWinBody');
        $chatWinInput = $('#piChatWinInput');
        $piMention = $('#piMention');
        $piMentionKw = $('#piMentionKw');
        $piMentionList = $('#piMentionList');
        $piMentionClose = $('#piMentionClose');
        $chatWinSend = $('#piChatWinSend');
        $chatWinClose = $('#piChatWinClose');
        $chatWinMax = $('#piChatWinMax');
        $toolEmoji = $('#piToolEmoji');
        $toolImage = $('#piToolImage');
        $toolFile = $('#piToolFile');
        $toolVoice = $('#piToolVoice');
        $toolShot = $('#piToolShot');
        $status = $('#piChatWinStatus');
        $emojiPanel = $('#piEmojiPanel');
        $fileImage = $('#piFileImage');
        $fileAny = $('#piFileAny');
        try {
            var savedTab = window.localStorage.getItem(EMOJI_TAB_KEY);
            if (savedTab) { MEDIA.tab = savedTab; }
        } catch (e) { /* 忽略 */ }
        loadStickers();

        $tabs.on('click', function () {
            $tabs.removeClass('is-active');
            $(this).addClass('is-active');
            STATE.tab = $(this).attr('data-tab') || 'contact';
            renderList();
        });
        $search.on('input', function () {
            STATE.kw = $.trim($(this).val() || '');
            renderList();
        });

        // 部门行：点一下逐级收起 / 展开
        $list.on('click', '.pi-dept', function () {
            var id = String($(this).attr('data-dept') || '0');
            if (STATE.collapsed[id]) { delete STATE.collapsed[id]; }
            else { STATE.collapsed[id] = 1; }
            renderList();
        });

        // 建群 / 改名 弹窗
        $newGroup.on('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            openModal('create');
        });
        $modalOk.on('click', confirmModal);
        $modalCancel.on('click', closeModal);
        $modalClose.on('click', closeModal);
        $modalMask.on('click', closeModal);
        // 群成员勾选：整行可点（群主自己那行 disabled，不响应）
        $modalBody.on('click', '.pi-copy', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var text = $(this).attr('data-copy') || '';
        if (text) { copyText(text, $(this).attr('data-kind')); }
    });

    $modalBody.on('click', '.pi-gmember.is-pickable', function (e) {
            var $row = $(this);
            var id = num($row.attr('data-emp'));
            if (!id) { return; }
            if (e.target && e.target.tagName === 'INPUT') {
                MEMBERS.picked[id] = e.target.checked ? 1 : 0;
            } else {
                MEMBERS.picked[id] = MEMBERS.picked[id] ? 0 : 1;
                $row.find('input').prop('checked', !!MEMBERS.picked[id]);
            }
            renderMembers();
        });
        $modalBody.on('input', '#piMemberSearch', function () {
            drawMembers($.trim($(this).val() || ''));
        });
        $modalBody.on('keydown', 'input', function (e) {
            if (e.keyCode === 13) { e.preventDefault(); confirmModal(); }
        });

        // 即时对话小窗
        $chatWinClose.on('click', closeChat);
        $chatWinSend.on('click', sendChat);
        $piMentionClose.on('click', function () { closePiMention(); });
        $piMentionKw.on('input', function () { renderPiMentionList($(this).val()); });
        $piMentionList.on('click', '.pi-mention__item', function () {
            insertPiMention({
                empId: num($(this).attr('data-emp')),
                name: String($(this).attr('data-name') || '')
            });
        });
        $chatWinMax.on('click', toggleMax);
        $chatWinInput.on('keydown', function (e) {
            if (e.keyCode === 13 && !e.shiftKey) { e.preventDefault(); sendChat(); return; }
            if ((e.key === '@' || (e.keyCode === 50 && e.shiftKey)) && CHAT.kind === 'group') {
                window.setTimeout(openPiMention, 0);
            }
        });
        // 工具条：表情 / 图片 / 文件 / 语音 / 截屏
        $toolEmoji.on('click', toggleEmojiPanel);
        $toolImage.on('click', function () { pickFile('image'); });
        $toolFile.on('click', function () { pickFile('file'); });
        $toolVoice.on('click', toggleVoice);
        $toolShot.on('click', takeShot);
        $fileImage.on('change', function () {
            var f = this.files && this.files[0];
            try { this.value = ''; } catch (e) { /* 忽略 */ }
            if (f) { uploadFile(f, 'image'); }
        });
        $fileAny.on('change', function () {
            var f = this.files && this.files[0];
            try { this.value = ''; } catch (e) { /* 忽略 */ }
            if (f) { uploadFile(f, 'file'); }
        });
        // 拖动：按住标题栏（不影响标题栏上的按钮）
        $chatWin.on('mousedown', '.pi-chatwin__head', function (e) {
            if ($(e.target).closest('button').length) { return; }
            onChatDragStart(e);
        });
        $chatWin.on('touchstart', '.pi-chatwin__head', function (e) {
            if ($(e.target).closest('button').length) { return; }
            onChatDragStart(e);
        });
        $(document).on('mousemove.pichat', onChatDragMove);
        $(document).on('mouseup.pichat', onChatDragEnd);
        $(document).on('touchmove.pichat', onChatDragMove);
        $(document).on('touchend.pichat', onChatDragEnd);
        $(window).on('resize.pichat', function () { if (CHAT.pos) { applyChatPos(); } });

        // 重看：点图片放大（新窗口看原图）
        $chatWinBody.on('click', '.pi-img', function () {
            var u = this.getAttribute('src');
            if (u) { window.open(u, '_blank'); }
        });
        // Ctrl+V 直接贴图发送
        $chatWinInput.on('paste', function (e) {
            var oe = e.originalEvent || e;
            var items = (oe.clipboardData && oe.clipboardData.items) || [];
            for (var i = 0; i < items.length; i++) {
                if (items[i].type && items[i].type.indexOf('image') === 0) {
                    var f = items[i].getAsFile();
                    if (f) { e.preventDefault(); uploadFile(f, 'image'); return; }
                }
            }
        });
        return true;
    }

    function start() {
        if (STATE.started) { return; }
        if (!bind()) { return; }
        STATE.started = true;
        try {
            var s = window.AppAuth && window.AppAuth.session ? window.AppAuth.session() : null;
            if (s && s.user) { STATE.me = num(s.user.empId); STATE.meName = s.user.nameCn || s.user.name || ''; }
        } catch (e) { /* 忽略 */ }
        $me.text(STATE.meName || '—');
        STATE.loading = true;
        renderList();
        connect();
        loadAll();
    }

    function open() {
        var wasStarted = STATE.started;
        start();
        // 每次打开都同步一次未读数（在别处读过消息后，红点不该停在旧数字）
        if (wasStarted) { loadAll(); }
        renderList();
    }

    function close() { /* 抽屉本身由 potato.js 收起，这里保留接口 */ }

    function isOpen() {
        return !!(window.AppPotato && window.AppPotato.isImOpen && window.AppPotato.isImOpen());
    }

    function refresh() {
        if (!STATE.started) { return; }
        loadAll();
    }

    return {
        start: start,
        open: open,
        close: close,
        isOpen: isOpen,
        refresh: refresh,
        openChat: openChat,
        closeChat: closeChat,
        isChatOpen: isChatOpen,
        isModalOpen: isModalOpen,
        closeModal: closeModal,
        state: STATE
    };
})(window.jQuery);
