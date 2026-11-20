/* ==========================================================================
   emp-mail.js —— 我的邮箱（员工个人邮箱助手）
   --------------------------------------------------------------------------
   参照 mail.js（服务信箱邮箱助手），但数据是**按登录员工强隔离**的：
     · 每人一条自己的信箱配置（右上角「设置」→ js/emp-mail-form.js），后端按 token 反查 empId，
       前端不传也不能改归属；列表 / 详情 / 标记 / 删除 / 发件都只作用于本人邮件。
     · 自动收件：配置里 autoSync=1 时，后端 MailSyncWorker 每 5 分钟自动用 IMAP 拉取该信箱；
       本页在「首次打开」与「刚保存配置」后也各静默自动收一次；停留期间每 5 分钟再收一次。
       手动「收件」按钮仍可随时立即拉取。
     · 查看：左侧文件夹（收件箱 / 已发送）→ 邮件列表 → 右侧阅读区（打开即标记已读）
     · 写邮件：弹窗填写收件人 / 抄送 / 主题 / 正文，可从员工信息选取收件人、可带附件；
       发件人固定取本人配置的邮箱，不接受前端伪造。
     · 其它：搜索、标记已读 / 未读、删除、分页
   · 布局：列表与阅读区撑满页面剩余高度（.app-main.mail-page + CSS flex 高度链），只在内部分别滚动
   ========================================================================== */
jQuery(function ($) {
    var $list = $('#mailList');
    var $read = $('#mailRead');
    var ATTACH_API = Api.empMail;
    var $pager = $('#mailPager');
    var $email = $('#mailEmail');
    var $meta = $('#mailMeta');
    var $lastSync = $('#mailLastSync');
    var $badgeInbox = $('#badgeInbox');
    var $badgeSent = $('#badgeSent');

    var state = {
        configured: false,
        folder: 'inbox',
        keyword: '',
        pageNum: 1, pageSize: 10, total: 0,
        rows: {},              // id -> row（当前页）
        activeId: '',          // 当前阅读的邮件
        autoSync: false,       // 本人配置是否开启自动收件
        enabled: false,        // 本人信箱是否启用
        autoSynced: false,     // 本次会话是否已自动收过一次
        autoTimer: null,       // 停留期间定时自动收件
        composeOpened: false   // URL ?compose= 只自动打开一次写信弹窗
    };
    var AUTO_SYNC_MS = 5 * 60 * 1000;      // 与后端 config.MAIL_SYNC_MINUTES 对齐

    function esc(text) { return UI.escapeHtml(text === undefined || text === null ? '' : String(text)); }

    function qs(name) {
        var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search || '');
        return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
    }

    /* ---------------- 附件小工具（与后端 config.MAIL_MAX_* 保持一致） ---------------- */
    var ATTACH_MAX_COUNT = 5;
    var ATTACH_MAX_ONE = 10 * 1024 * 1024;         // 单个附件上限 10 MB
    var ATTACH_MAX_TOTAL = 20 * 1024 * 1024;       // 合计上限 20 MB
    var ATTACH_TIP = '单个不超过 10 MB，最多 5 个，合计不超过 20 MB';

    /** 字节数 → 人话（1024 进制） */
    function formatSize(size) {
        var n = parseInt(size, 10);
        if (!(n > 0)) { return '0 B'; }
        if (n < 1024) { return n + ' B'; }
        if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }
    /** data URL（data:xxx;base64,YYYY）→ 纯 base64；后端两种都认，这里只传纯 base64 减小体积 */
    function base64Of(dataUrl) {
        var text = String(dataUrl || '');
        var idx = text.indexOf(';base64,');
        return idx < 0 ? text : text.slice(idx + 8);
    }

    /** 触发浏览器保存文件：真实后端给 blob，离线演示给 dataURL；无 DOM 能力时静默跳过（jsdom） */
    function saveAttachmentFile(res, fallbackName) {
        var name = (res && res.filename) || fallbackName || 'attachment';
        var href = (res && res.dataUrl) || '';
        var revoke = false;
        if (!href && res && res.blob && window.URL && window.URL.createObjectURL) {
            try { href = window.URL.createObjectURL(res.blob); revoke = true; } catch (e) { href = ''; }
        }
        if (!href) { return false; }
        try {
            var a = document.createElement('a');
            a.href = href;
            a.download = name;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (revoke && window.URL.revokeObjectURL) {
                window.setTimeout(function () { window.URL.revokeObjectURL(href); }, 30000);
            }
            return true;
        } catch (e) { return false; }
    }

    /** 读信区附件下载列表：文件名 + 大小 + 下载按钮；历史收件可点「获取附件」按 UID 补拉 */
    function attachHtml(m) {
        var list = (m && m.attachments) || [];
        if (list.length) {
            var html = '<div class="mail-read__attach"><div class="mail-read__attach-title">附件（' +
                list.length + ' 个，点「下载」保存到本地）</div>';
            for (var i = 0; i < list.length; i++) {
                var a = list[i] || {};
                html += '<div class="mail-read__attach-item">' +
                    '<span class="mail-read__attach-ico">📎</span>' +
                    '<span class="mail-read__attach-name" title="' + esc(a.name) + '">' + esc(a.name) + '</span>' +
                    '<span class="mail-read__attach-size">' + esc(a.sizeText || formatSize(a.size)) + '</span>' +
                    (a.downloadable && a.id
                        ? '<button type="button" class="el-button el-button--small el-button--primary mail-attach__dl"' +
                          ' data-file-id="' + esc(a.id) + '" data-file-name="' + esc(a.name) + '">下载</button>'
                        : '<span class="mail-read__attach-na">未保存</span>') +
                    '</div>';
            }
            return html + '</div>';
        }
        if (m && m.attachNeedFetch) {
            return '<div class="mail-read__attach"><div class="mail-read__attach-title">附件</div>' +
                '<div class="mail-read__attach-item">' +
                '<span class="mail-read__attach-tip">这是历史收件，当时只记录了「含附件」标记。</span>' +
                '<button type="button" class="el-button el-button--small el-button--primary" ' +
                'id="btnMailAttachFetch">获取附件</button></div></div>';
        }
        if (m && m.hasAttach) {
            return '<div class="mail-read__attach"><div class="mail-read__attach-tip">' +
                '这封邮件含附件，但内容未保存（超大附件或历史邮件），请到邮箱网页版查看</div></div>';
        }
        return '';
    }

    /** 绑定附件区的「下载 / 获取附件」按钮（重绘附件区后可重复调用） */
    function bindAttachActions(m) {
        $read.find('.mail-attach__dl').off('click.wpa').on('click.wpa', function () {
            var $btn = $(this).prop('disabled', true);
            var fileId = $btn.attr('data-file-id');
            var name = $btn.attr('data-file-name') || 'attachment';
            ATTACH_API.downloadAttachment(fileId).done(function (res) {
                saveAttachmentFile(res, name);
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '附件下载失败' });
            }).always(function () { $btn.prop('disabled', false); });
        });
        $read.find('#btnMailAttachFetch').off('click.wpa').on('click.wpa', function () {
            var $btn = $(this).prop('disabled', true).text('获取中…');
            ATTACH_API.attachments(m.id, true).done(function (res) {
                m.attachments = (res && res.list) || [];
                m.attachNeedFetch = false;
                m.hasAttach = m.attachments.length > 0;
                $read.data('mail', m);
                $read.find('.mail-read__attach').replaceWith(attachHtml(m));
                bindAttachActions(m);
                UI.message({ type: 'success', message: (res && res.message) || '附件已获取' });
            }).fail(function (err) {
                $btn.prop('disabled', false).text('获取附件');
                UI.message({ type: 'error', message: (err && err.message) || '获取附件失败' });
            });
        });
    }

    /* ---------------- 状态条 ---------------- */
    var READ_EMPTY = '<div class="mail-read__empty">' +
        '<svg class="svg-ico" viewBox="0 0 24 24"><path fill="currentColor" d="M3 5h18a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1zm1.8 2L12 12.4 19.2 7H4.8zM4 9.2V17h16V9.2l-7.4 5.5a1 1 0 01-1.2 0L4 9.2z"/></svg>' +
        '<p>从左侧选择一封邮件查看详情</p></div>';

    function applyStatus(data) {
        state.configured = !!(data && data.configured);
        state.autoSync = !!(data && data.autoSync);
        state.enabled = !!(data && data.enabled);
        if (!state.configured) {
            $email.text('尚未配置个人邮箱');
            $meta.text((data && data.message) || '请点右上角「设置」填写本人邮箱与授权码');
            $meta.addClass('is-warn');
            $list.html('<div class="mail-empty">尚未配置个人邮箱，请点右上角「设置」完成配置</div>');
            $read.html('<div class="mail-read__empty"><p>配置后即可收、发与阅读本人邮件</p></div>');
            $('#btnSync, #btnWrite').prop('disabled', true);
            return;
        }
        $meta.removeClass('is-warn');
        $email.text((data && data.email) || '');
        var parts = ['仅本人可见'];
        if (data && data.displayName && data.displayName !== data.email) { parts.push('发件人：' + data.displayName); }
        if (data && data.servers && data.servers.provider) { parts.push(data.servers.provider); }
        if (data && data.servers && data.servers.imapHost) {
            parts.push('IMAP ' + data.servers.imapHost + ':' + data.servers.imapPort);
        }
        parts.push(state.autoSync ? '自动收件：开启' : '自动收件：关闭');
        parts.push(state.enabled ? '信箱已启用' : '信箱已停用');
        if (data && data.lastError) { parts.push('最近错误：' + data.lastError); }
        $meta.text(parts.join(' · '));
        if (data && data.lastError) { $meta.addClass('is-warn'); }
        $lastSync.text('最近收件：' + ((data && data.lastSyncTime) || '-'));
        var counts = (data && data.counts) || {};
        $badgeInbox.text(counts.inbox || 0);
        $badgeSent.text(counts.sent || 0);
        $('#btnSync, #btnWrite').prop('disabled', !state.enabled);
        if (!state.listLoaded) {                 // 首次拿到状态后再拉列表（未配置时不用请求）
            state.listLoaded = true;
            loadList();
        }
        scheduleAutoSync();                      // 配置好且开启自动收件 → 立即 / 定时自动收
    }

    /** 通讯录双击邮箱跳转：?compose=xxx@yyy 时自动打开写信并带入收件人 */
    function maybeCompose() {
        if (state.composeOpened) { return; }
        var to = qs('compose');
        if (!to || !state.configured) { return; }
        state.composeOpened = true;
        openWrite(null, to);
        try {
            if (window.history && history.replaceState) { history.replaceState(null, '', 'emp-mail.html'); }
        } catch (e) { /* 忽略 */ }
    }

    function loadStatus() {
        Api.empMail.status().done(function (data) {
            state.lastStatus = data || null;      // 供「设置」弹窗回填（含 hasPassword / autoSync 等）
            applyStatus(data);
            maybeCompose();
        }).fail(function (err) {
            $meta.text((err && err.message) || '状态加载失败').addClass('is-warn');
        });
    }

    /* ---------------- 自动收件 ----------------
       三层保障：① 后端 MailSyncWorker 每 5 分钟遍历所有 autoSync=1 的员工信箱（真实 IMAP）；
                 ② 本页打开 / 刚保存配置后立即静默收一次；
                 ③ 停留在本页时每 5 分钟再收一次（页面隐藏时跳过，避免后台标签空转）。
       静默收件不弹 toast，只刷新状态条与列表；失败也只更新状态条的「最近错误」。 */
    function autoSyncNow() {
        if (!state.configured || !state.enabled || !state.autoSync) { return; }
        if (document.hidden) { return; }
        Api.empMail.sync().done(function () {
            loadStatus();
            loadList();
        }).fail(function () {
            loadStatus();                       // 让状态条显示后端写下的 lastError
        });
    }
    function scheduleAutoSync() {
        if (!state.configured || !state.enabled || !state.autoSync) { return; }
        if (!state.autoSynced) {                // 首次拿到状态（或刚保存配置）→ 立即自动收一次
            state.autoSynced = true;
            autoSyncNow();
        }
        if (!state.autoTimer) {
            state.autoTimer = window.setInterval(autoSyncNow, AUTO_SYNC_MS);
        }
    }

    /* ---------------- 我的邮箱设置（一人一条：无配置=新增，有配置=编辑） ---------------- */
    function openEmpMailSettings() {
        if (!window.EmpMailForm) {
            UI.message({ type: 'error', message: '邮箱设置组件未加载，请刷新页面后重试' });
            return;
        }
        EmpMailForm.open({
            status: state.lastStatus || null,
            onSaved: function (saved) {
                state.lastStatus = saved || null;
                if (!state.activeId) { $read.html(READ_EMPTY); }
                state.autoSynced = false;        // 刚配置好（含改邮箱 / 重开自动收件）→ 立刻自动收一次
                state.listLoaded = false;
                loadStatus();
            }
        });
    }

    /* ---------------- 列表 ---------------- */
    function rowHtml(r) {
        var unread = r.direction === 'in' && !r.seen;
        var who = r.direction === 'out'
            ? ('发给：' + (r.toAddr || ''))
            : (r.fromName || r.fromAddr || '');
        return '<div class="mail-item' + (unread ? ' is-unread' : '') +
            (String(r.id) === String(state.activeId) ? ' is-active' : '') +
            '" data-id="' + esc(r.id) + '">' +
            '<div class="mail-item__top">' +
                '<span class="mail-item__from" title="' + esc(who) + '">' + esc(who) + '</span>' +
                '<span class="mail-item__time">' + esc(String(r.sentTime || '').slice(5, 16)) + '</span>' +
            '</div>' +
            '<div class="mail-item__subject" title="' + esc(r.subject) + '">' +
                (unread ? '<i class="mail-dot"></i>' : '') + esc(r.subject || '(无主题)') +
                (r.hasAttach ? '<span class="mail-clip" title="含附件">📎</span>' : '') +
            '</div>' +
            '</div>';
    }

    function renderList(data) {
        var list = (data && data.list) || [];
        state.rows = {};
        state.total = (data && data.total) || 0;
        state.pageNum = (data && data.pageNum) || 1;
        state.pageSize = (data && data.pageSize) || 10;
        if (!list.length) {
            $list.html('<div class="mail-empty">' +
                (state.keyword ? '没有匹配的邮件' : (state.folder === 'sent' ? '还没有发出的邮件' : '收件箱是空的，点「收件」拉取最新邮件')) +
                '</div>');
            $pager.empty();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            state.rows[list[i].id] = list[i];
            html += rowHtml(list[i]);
        }
        $list.html(html);
        UI.pagination($pager, {
            total: state.total, pageNum: state.pageNum, pageSize: state.pageSize, sizes: [10, 20, 50],
            onChange: function (num, size) {
                state.pageNum = num; state.pageSize = size;
                loadList();
            }
        });
        if (data && data.counts) {
            $badgeInbox.text(data.counts.inbox || 0);
            $badgeSent.text(data.counts.sent || 0);
        }
    }

    function loadList() {
        if (!state.configured) { return; }
        $list.html('<div class="mail-empty">加载中…</div>');
        Api.empMail.page({
            folder: state.folder, keyword: state.keyword,
            pageNum: state.pageNum, pageSize: state.pageSize
        }).done(renderList).fail(function (err) {
            $list.html('<div class="mail-empty">' + esc((err && err.message) || '加载失败') + '</div>');
        });
    }

    /* ---------------- 阅读 ---------------- */
    function renderRead(m) {
        var rows = [
            ['发件人', (m.fromName ? m.fromName + ' ' : '') + '<' + esc(m.fromAddr) + '>'],
            ['收件人', esc(m.toAddr || '')],
            ['抄送', esc(m.ccAddr || '')],
            ['时间', esc(m.sentTime || '')]
        ];
        var head = '';
        for (var i = 0; i < rows.length; i++) {
            if (!$.trim(rows[i][1])) { continue; }
            head += '<div class="mail-read__row"><span>' + rows[i][0] + '</span><b>' + rows[i][1] + '</b></div>';
        }
        /* 正文：有 bodyHtml 就按富文本渲染（先过 RichText.sanitize 再插入 DOM） */
        var rawHtml = m.bodyHtml ? String(m.bodyHtml) : '';
        var body = m.bodyText || '';
        var isHtml = !!rawHtml && !!window.RichText && !window.RichText.isEmptyHtml(rawHtml);
        var bodyBlock;
        if (isHtml) {
            bodyBlock = '<div class="mail-read__body is-html">' +
                window.RichText.sanitize(rawHtml) + '</div>';
        } else {
            if (!body && rawHtml) { body = rawHtml.replace(/<[^>]+>/g, ''); }
            bodyBlock = '<div class="mail-read__body">' + esc(body).replace(/\n/g, '<br>') + '</div>';
        }
        $read.html(
            '<div class="mail-read__head">' +
                '<div class="mail-read__subject">' + esc(m.subject || '(无主题)') +
                    '<span class="el-tag el-tag--info mail-read__tag">' + esc(m.directionText || '收件') + '</span>' +
                    (m.hasAttach ? '<span class="el-tag el-tag--warning mail-read__tag">含附件</span>' : '') +
                '</div>' +
                head +
            '</div>' +
            attachHtml(m) +
            bodyBlock +
            '<div class="mail-read__foot">' +
                '<button type="button" class="el-button el-button--small" id="btnReply">回复</button>' +
                '<button type="button" class="el-button el-button--small" id="btnToggleSeen">标记' +
                    (m.seen ? '未读' : '已读') + '</button>' +
                '<button type="button" class="el-button el-button--small el-button--danger" id="btnMailDelete">删除</button>' +
            '</div>'
        );
        $read.data('mail', m);
        bindAttachActions(m);

        $('#btnReply').on('click', function () { openWrite(m); });
        $('#btnToggleSeen').on('click', function () {
            var next = !m.seen;
            Api.empMail.mark([m.id], next).done(function () {
                m.seen = next;
                updateRowSeen(m.id, next);
                $('#btnToggleSeen').text('标记' + (next ? '未读' : '已读'));
                loadStatus();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
            });
        });
        $('#btnMailDelete').on('click', function () { removeMails([m.id], 1); });
    }

    function updateRowSeen(id, seen) {
        var $item = $list.find('.mail-item[data-id="' + id + '"]');
        $item.toggleClass('is-unread', !seen);
        if (seen) { $item.find('.mail-dot').remove(); }
        if (state.rows[id]) { state.rows[id].seen = seen; }
    }

    function openMail(id) {
        state.activeId = id;
        $list.find('.mail-item').removeClass('is-active');
        $list.find('.mail-item[data-id="' + id + '"]').addClass('is-active');
        $read.html('<div class="mail-read__empty"><p>正在加载邮件…</p></div>');
        Api.empMail.detail(id).done(function (m) {
            renderRead(m);
            if (m && m.seen) { updateRowSeen(id, true); }
            loadStatus();
        }).fail(function (err) {
            $read.html('<div class="mail-read__empty"><p>' + esc((err && err.message) || '加载失败') + '</p></div>');
        });
    }

    /* ---------------- 收件 ---------------- */
    function syncNow() {
        if (!state.configured) {
            UI.message({ type: 'warning', message: '请先配置并启用个人邮箱' });
            return;
        }
        var $btn = $('#btnSync').prop('disabled', true).text('收件中…');
        Api.empMail.sync().done(function (res) {
            var saved = (res && res.saved) || 0;
            var fetched = (res && res.fetched) || 0;
            UI.message({
                type: saved ? 'success' : 'info',
                message: saved ? ('收件完成：取回 ' + fetched + ' 封，新增 ' + saved + ' 封')
                    : ('收件完成：取回 ' + fetched + ' 封，没有新邮件')
            });
            loadStatus();
            loadList();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '收件失败' });
            loadStatus();
        }).always(function () {
            $btn.prop('disabled', false).html('收件');
        });
    }

    /* ---------------- 写邮件：从员工信息中选取收件人 / 抄送 ---------------- */
    /* 邮箱格式：与后端 mail_client.RE_EMAIL 保持一致的宽松口径 */
    var RE_EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

    /** 把一个输入框里的地址拆成数组（兼容中英文逗号、分号、空白） */
    function splitAddr(val) {
        var raw = String(val || '').replace(/[，；]/g, ',').split(/[,;\s]+/);
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            if (raw[i]) { out.push(raw[i]); }
        }
        return out;
    }

    /**
     * 弹出「从员工信息中选取…」二级弹窗（数据来自 empinfos 员工信息表）
     *  · 支持关键字检索（工号 / 姓名 / 手机号 / 邮箱 / 岗位 / 身份证）
     *  · 支持多选、跨页保持选中，确定后把邮箱追加进目标输入框（自动去重）
     * @param {jQuery} $target 目标输入框（收件人 / 抄送）
     * @param {Object} [opts]  {label:'抄送', other:$(另一个输入框)} —— label 用于文案，
     *                         other 用来跳过「已经在另一个字段里」的地址，避免同一封信里重复出现
     */
    function pickEmployees($target, opts) {
        opts = opts || {};
        var label = opts.label || '收件人';
        var $other = opts.other || null;
        var picked = [], pickedMap = {};                 // picked 保持选取顺序，pickedMap 去重
        var pick = { keyword: '', pageNum: 1, pageSize: 8, total: 0 };
        var $content = $(
            '<div class="emp-pick">' +
                '<div class="emp-pick__search">' +
                    '<div class="el-input el-input--prefix">' +
                        '<span class="el-input__prefix">' +
                            '<svg class="svg-ico" viewBox="0 0 24 24" style="width:16px;height:16px">' +
                            '<g stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round">' +
                            '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></g></svg>' +
                        '</span>' +
                        '<input class="el-input__inner" type="text" id="pfKeyword" placeholder="搜索工号 / 姓名 / 手机号 / 邮箱">' +
                    '</div>' +
                    '<button type="button" class="el-button el-button--primary" id="pfSearch">查询</button>' +
                '</div>' +
                '<div class="emp-pick__head">' +
                    '<span class="emp-pick__c-check"></span>' +
                    '<span class="emp-pick__c-name">姓名</span>' +
                    '<span class="emp-pick__c-code">工号</span>' +
                    '<span class="emp-pick__c-dept">所属部门</span>' +
                    '<span class="emp-pick__c-mail">邮箱</span>' +
                    '<span class="emp-pick__c-status">状态</span>' +
                '</div>' +
                '<div class="emp-pick__list" id="pfList"><div class="emp-pick__empty">加载中…</div></div>' +
                '<div class="emp-pick__foot">' +
                    '<span class="emp-pick__picked">已选 <b id="pfPicked">0</b> 人（确定后追加到' + label + '）</span>' +
                    '<div class="emp-pick__pager" id="pfPager"></div>' +
                '</div>' +
            '</div>'
        );
        var $list = $content.find('#pfList');
        var $picked = $content.find('#pfPicked');
        var $pager = $content.find('#pfPager');

        function tipCount() { $picked.text(picked.length); }

        function rowHtml(one) {
            var email = String(one.email || '').trim();
            // 员工档案里没填邮箱 / 不是合法邮箱 → 不可勾选，否则选进去后端会判「地址格式不正确」
            var usable = RE_EMAIL.test(email);
            var on = usable && !!pickedMap[email];
            var status = String(one.statusText || '');
            var cls = Number(one.status) === 0 ? 'el-tag--info' : (Number(one.status) === 2 ? 'el-tag--warning' : 'el-tag--success');
            return '<label class="emp-pick__row' + (on ? ' is-checked' : '') +
                    (usable ? '' : ' is-disabled') + '" data-email="' +
                    esc(email) + '" data-name="' + esc(one.nameCn || '') + '">' +
                '<span class="emp-pick__c-check el-checkbox' + (on ? ' is-checked' : '') + '">' +
                    '<input class="el-checkbox__original pf-check" type="checkbox" value="' + esc(email) + '"' +
                        (on ? ' checked' : '') + (usable ? '' : ' disabled') + '>' +
                    '<span class="el-checkbox__inner"></span>' +
                '</span>' +
                '<span class="emp-pick__c-name">' + esc(one.nameCn || '-') + '</span>' +
                '<span class="emp-pick__c-code">' + esc(one.code || '-') + '</span>' +
                '<span class="emp-pick__c-dept">' + esc(one.deptName || '—（未分配）') + '</span>' +
                '<span class="emp-pick__c-mail" title="' + esc(email) + '">' +
                    (usable ? esc(email) : '<span style="color:#f56c6c;">' + (email ? '邮箱格式不对' : '未填邮箱') + '</span>') +
                '</span>' +
                '<span class="emp-pick__c-status"><span class="el-tag el-tag--small ' + cls + '">' +
                    esc(status || '-') + '</span></span>' +
                '</label>';
        }

        function renderList(data) {
            var list = (data && data.list) || [];
            pick.total = (data && data.total) || 0;
            pick.pageNum = (data && data.pageNum) || 1;
            if (!list.length) {
                $list.html('<div class="emp-pick__empty">' +
                    (pick.keyword ? '没有匹配的员工' : '员工信息表里还没有可选的员工') + '</div>');
                $pager.empty();
                return;
            }
            var html = '';
            for (var i = 0; i < list.length; i++) { html += rowHtml(list[i]); }
            $list.html(html);
            UI.pagination($pager, {
                total: pick.total, pageNum: pick.pageNum, pageSize: pick.pageSize,
                onChange: function (num) { pick.pageNum = num; loadList(); }
            });
        }

        function loadList() {
            $list.html('<div class="emp-pick__empty">加载中…</div>');
            Api.emp.page({ keyword: pick.keyword, pageNum: pick.pageNum, pageSize: pick.pageSize })
                .done(renderList)
                .fail(function (err) {
                    $list.html('<div class="emp-pick__empty">' +
                        esc((err && err.message) || '员工信息加载失败') + '</div>');
                });
        }

        $content.on('click', '#pfSearch', function () {
            pick.keyword = $.trim($content.find('#pfKeyword').val());
            pick.pageNum = 1;
            loadList();
        });
        $content.find('#pfKeyword').on('keydown', function (e) {
            if (e.keyCode === 13) { $content.find('#pfSearch').trigger('click'); }
        });
        $content.on('change', '.pf-check', function () {
            var $row = $(this).closest('.emp-pick__row');
            var email = String($row.attr('data-email') || '');
            var name = String($row.attr('data-name') || '');
            var on = $(this).prop('checked');
            $(this).closest('.el-checkbox').toggleClass('is-checked', on);
            $row.toggleClass('is-checked', on);
            var idx = pickedMap[email] === undefined ? -1 : pickedMap[email];
            if (on && !RE_EMAIL.test(email)) { return; }       // 兜底：不可用的行不该被选中
            if (on && idx < 0) {
                pickedMap[email] = picked.length;
                picked.push({ email: email, name: name });
            } else if (!on && idx >= 0) {
                picked.splice(idx, 1);
                pickedMap = {};
                for (var i = 0; i < picked.length; i++) { pickedMap[picked[i].email] = i; }
            }
            tipCount();
        });

        UI.dialog({
            title: '从员工信息中选取' + label,
            width: 780, content: $content,
            onReady: function ($body) {
                tipCount();
                loadList();
                $body.find('#pfKeyword').trigger('focus');
            },
            onOk: function ($body, close) {
                if (!picked.length) {
                    UI.message({ type: 'warning', message: '请至少选择一位员工' });
                    return;
                }
                var out = splitAddr($target.val());
                var otherList = $other ? splitAddr($other.val()) : [];
                var added = 0, noMail = 0, dupOther = 0;
                for (var j = 0; j < picked.length; j++) {
                    var em = String(picked[j].email || '');
                    if (!em) { noMail++; continue; }                  // 员工档案没填邮箱
                    if (otherList.indexOf(em) >= 0) { dupOther++; continue; }  // 已在另一个字段里
                    if (out.indexOf(em) < 0) { out.push(em); added++; }
                }
                if (added) {
                    $target.val(out.join(', '));
                }
                var msg;
                if (added) {
                    msg = '已添加 ' + added + ' 位员工邮箱到' + label;
                } else if (dupOther) {
                    msg = '所选的 ' + dupOther + ' 位员工已在' + (label === '抄送' ? '收件人' : '抄送') + '中，未重复添加';
                } else {
                    msg = '所选员工邮箱已在' + label + '中';
                }
                if (noMail) { msg += '（' + noMail + ' 位员工未填邮箱，已跳过）'; }
                UI.message({ type: added ? 'success' : 'warning', message: msg });
                close();
            }
        });
    }

    /* ---------------- 写邮件 ---------------- */
    function openWrite(replyTo, prefillTo) {
        if (!state.configured) {
            UI.message({ type: 'warning', message: '请先配置并启用个人邮箱' });
            return;
        }
        var $form = $('#mailFormTpl').children().clone(true);
        var files = [];        // 本次写邮件的附件：{name,size,type,data(base64),loading}
        UI.dialog({
            title: replyTo ? ('回复：' + (replyTo.subject || '')) : '写邮件',
            width: 720, content: $form,
            onReady: function ($body, close) {
                var $f = $body.find('.mail-form');
                $body.closest('.el-dialog').find('.btn-ok').text('发送');
                $f.find('#mfFromTip').text('发件人：' + $email.text() + '（可在「我的邮箱设置」中修改发件人名称）');
                /* 正文：富文本编辑器（弹窗每次打开都是新 DOM，需重新挂载） */
                if (window.RichText) {
                    window.RichText.mount($f.find('#mfBody'), {
                        placeholder: '请输入邮件正文（支持加粗、颜色、列表、链接等富文本格式）',
                        label: '邮件正文格式'
                    });
                }
                // 收件人 / 抄送：都可从员工信息表中勾选邮箱（多选，确定后追加到输入框并去重）
                $f.find('#mfPickEmp').on('click', function () {
                    pickEmployees($f.find('#mfTo'), { label: '收件人', other: $f.find('#mfCc') });
                });
                $f.find('#mfPickEmpCc').on('click', function () {
                    pickEmployees($f.find('#mfCc'), { label: '抄送', other: $f.find('#mfTo') });
                });
                bindAttach($f);
                if (replyTo) {
                    $f.find('#mfTo').val(replyTo.fromAddr || '');
                    $f.find('#mfSubject').val(/^re:/i.test(replyTo.subject || '')
                        ? replyTo.subject : ('Re: ' + (replyTo.subject || '')));
                    $f.find('#mfBody').val('\n\n------------------ 原邮件 ------------------\n' +
                        (replyTo.sentTime || '') + ' ' + (replyTo.fromName || replyTo.fromAddr || '') + ' 写道：\n' +
                        (replyTo.bodyText || ''));
                    $f.find('#mfBody').trigger('focus');
                } else if (prefillTo) {
                    $f.find('#mfTo').val(prefillTo);
                    $f.find('#mfSubject').trigger('focus');
                } else {
                    $f.find('#mfTo').trigger('focus');
                }

                /* ---------- 附件：选文件 → FileReader 读成 base64 → 列表展示 / 可移除 ---------- */
                function totalSize() {
                    var total = 0;
                    for (var i = 0; i < files.length; i++) { total += files[i].size || 0; }
                    return total;
                }
                function existsName(name) {
                    for (var i = 0; i < files.length; i++) {
                        if (String(files[i].name) === String(name)) { return true; }
                    }
                    return false;
                }
                function removeFile(item) {
                    var idx = files.indexOf(item);
                    if (idx >= 0) { files.splice(idx, 1); }
                }
                function renderAttach() {
                    var $list = $f.find('#mfAttachList');
                    var $tip = $f.find('#mfAttachTip');
                    if (!files.length) {
                        $list.empty();
                        $tip.text(ATTACH_TIP).removeClass('is-warn');
                        return;
                    }
                    var html = '';
                    for (var i = 0; i < files.length; i++) {
                        var one = files[i];
                        html += '<div class="mail-attach__item' + (one.loading ? ' is-loading' : '') +
                            '" data-index="' + i + '">' +
                            '<span class="mail-attach__name" title="' + esc(one.name) + '">' + esc(one.name) + '</span>' +
                            '<span class="mail-attach__size">' +
                                (one.loading ? '读取中…' : formatSize(one.size)) + '</span>' +
                            '<button type="button" class="mail-attach__del" data-index="' + i +
                                '" title="移除附件">×</button>' +
                            '</div>';
                    }
                    $list.html(html);
                    $tip.addClass('is-warn')
                        .text('已选 ' + files.length + ' 个（合计 ' + formatSize(totalSize()) + '）');
                }
                function readOne(file, item) {
                    try {
                        var reader = new FileReader();
                        reader.onload = function () {
                            item.data = base64Of(reader.result);
                            item.loading = false;
                            renderAttach();
                        };
                        reader.onerror = function () {
                            item.loading = false;
                            removeFile(item);
                            renderAttach();
                            UI.message({ type: 'error', message: '读取附件「' + item.name + '」失败，请重新选择' });
                        };
                        reader.readAsDataURL(file);
                    } catch (e) {
                        removeFile(item);
                        renderAttach();
                        UI.message({ type: 'error', message: '当前浏览器不支持读取本地文件' });
                    }
                }
                function addFiles(fileList) {
                    var picked = [], i;
                    for (i = 0; i < ((fileList && fileList.length) || 0); i++) { picked.push(fileList[i]); }
                    if (!picked.length) { return; }
                    for (i = 0; i < picked.length; i++) {
                        var file = picked[i];
                        if (!file || !file.name) { continue; }
                        if (files.length >= ATTACH_MAX_COUNT) {
                            UI.message({ type: 'warning',
                                message: '最多只能添加 ' + ATTACH_MAX_COUNT + ' 个附件' });
                            break;
                        }
                        if ((file.size || 0) > ATTACH_MAX_ONE) {
                            UI.message({ type: 'warning', message: '附件「' + file.name + '」' +
                                formatSize(file.size) + '，超出单个附件上限 10 MB' });
                            continue;
                        }
                        if (totalSize() + (file.size || 0) > ATTACH_MAX_TOTAL) {
                            UI.message({ type: 'warning', message: '附件合计将超过 20 MB 上限，未添加「' +
                                file.name + '」' });
                            continue;
                        }
                        if (existsName(file.name)) {
                            UI.message({ type: 'warning', message: '已经添加过同名附件「' + file.name + '」' });
                            continue;
                        }
                        var item = { name: file.name, size: file.size || 0, type: file.type || '',
                                     data: '', loading: true };
                        files.push(item);
                        readOne(file, item);
                    }
                    renderAttach();
                }
                function bindAttach($form) {
                    $form.find('#mfPickFile').on('click', function () {
                        $form.find('#mfFile').trigger('click');
                    });
                    $form.find('#mfFile').on('change', function () {
                        var input = this;
                        addFiles(input.files);
                        try { input.value = ''; } catch (e) { }   // 清空才能再次选择同一个文件
                    });
                    $form.find('#mfAttachList').on('click', '.mail-attach__del', function () {
                        var idx = parseInt($(this).attr('data-index'), 10);
                        if (!isNaN(idx) && files[idx]) { files.splice(idx, 1); renderAttach(); }
                    });
                    renderAttach();
                }
            },
            onOk: function ($body, close) {
                var $f = $body.find('.mail-form');
                var to = $.trim($f.find('#mfTo').val());
                var cc = $.trim($f.find('#mfCc').val());
                var subject = $.trim($f.find('#mfSubject').val());
                var rt = window.RichText ? window.RichText.of($f.find('#mfBody')) : null;
                var text = rt ? rt.text() : $f.find('#mfBody').val();
                var html = rt ? rt.html() : '';
                if (!to) { UI.message({ type: 'warning', message: '请填写收件人' }); return; }
                if (!subject) { UI.message({ type: 'warning', message: '请填写邮件主题' }); return; }
                if (!$.trim(text)) { UI.message({ type: 'warning', message: '请填写邮件正文' }); return; }
                var i, reading = '';
                for (i = 0; i < files.length; i++) {
                    if (files[i].loading) { reading = files[i].name; break; }
                }
                if (reading) {
                    UI.message({ type: 'warning', message: '附件「' + reading + '」还在读取中，请稍后再发送' });
                    return;
                }
                var payload = { to: to, cc: cc, subject: subject, body: text };
                if (html) { payload.bodyHtml = html; }
                if (files.length) {
                    payload.attachments = [];
                    for (i = 0; i < files.length; i++) {
                        payload.attachments.push({
                            name: files[i].name, size: files[i].size,
                            type: files[i].type, data: files[i].data
                        });
                    }
                }
                var $ok = $body.closest('.el-dialog').find('.btn-ok').prop('disabled', true).text('发送中…');
                Api.empMail.send(payload)
                    .done(function () {
                        $ok.prop('disabled', false);
                        UI.message({
                            type: 'success',
                            message: files.length ? ('邮件已发送（含 ' + files.length + ' 个附件）') : '邮件已发送'
                        });
                        close();
                        state.folder = 'sent';
                        $('.mail-folder').removeClass('is-active')
                            .filter('[data-folder="sent"]').addClass('is-active');
                        state.pageNum = 1;
                        loadStatus();
                        loadList();
                        $read.html('<div class="mail-read__empty"><p>邮件已发送，可在「已发送」中查看</p></div>');
                        state.activeId = '';
                    }).fail(function (err) {
                        $ok.prop('disabled', false).text('发送');
                        UI.message({ type: 'error', message: (err && err.message) || '发送失败' });
                    });
            }
        });
    }

    /* ---------------- 删除 ---------------- */
    function removeMails(ids, count) {
        UI.confirm({
            title: '删除邮件', type: 'warning',
            message: '确定删除' + (count > 1 ? ('所选 ' + count + ' 封') : '这封') +
                '邮件吗？（只删除系统里的记录，不会删除邮箱服务器上的邮件）',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.empMail.remove(ids).done(function () {
                UI.message({ type: 'success', message: '已删除' });
                state.activeId = '';
                $read.html('<div class="mail-read__empty"><p>从左侧选择一封邮件查看详情</p></div>');
                loadStatus();
                loadList();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }

    /* ---------------- 事件 ---------------- */
    $('.mail-folder').on('click', function () {
        var folder = $(this).attr('data-folder');
        if (folder === state.folder) { return; }
        state.folder = folder;
        state.pageNum = 1;
        state.activeId = '';
        $('.mail-folder').removeClass('is-active');
        $(this).addClass('is-active');
        $read.html('<div class="mail-read__empty"><p>从左侧选择一封邮件查看详情</p></div>');
        loadList();
    });
    $list.on('click', '.mail-item', function () { openMail($(this).attr('data-id')); });
    $('#mailKeyword').on('keydown', function (e) {
        if (e.keyCode === 13) {
            state.keyword = $.trim($(this).val());
            state.pageNum = 1;
            loadList();
        }
    });
    $('#btnSync').on('click', syncNow);
    $('#btnWrite').on('click', function () { openWrite(null); });
    $('#btnMailRefresh').on('click', function () { loadStatus(); loadList(); });
    $('#btnMailSetting').on('click', openEmpMailSettings);   // 刷新后面的设置图标按钮：我的邮箱设置

    loadStatus();
});
