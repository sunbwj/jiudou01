/* ==========================================================================
   service-email.js —— 服务信箱设置（serviceemail）
   --------------------------------------------------------------------------
   · 列表：邮箱地址 / 发件人名称 / 收件服务器(IMAP) / 发件服务器(SMTP) /
          启用 / 最近收件时间 / 创建时间；密码只显示掩码，接口不返回
   · serviceemail 是**单例表**（全表只允许一条记录）：本页只做查看 / 启用停用 / 测试连接 / 编辑；
     新增与编辑都在「邮箱助手」右上角设置按钮弹出的弹窗里完成（无记录=新增、有记录=编辑）
   · 全表只能有一条启用记录：启用时会自动停用其它（后端 + 数据库唯一索引双保险）
   · 操作引导区只保留：启用 / 停用 / 测试连接 / 编辑 / 刷新
     （按需求去掉了「新增服务信箱」与「删除」按钮）
   · 编辑弹窗复用 js/service-email-form.js（两页共用一套表单与校验），宽 560：
     邮箱地址、密码/授权码（留空不修改）、发件人名称、启用状态、连接加密、收件服务器、发件服务器、备注
   · 测试连接：用库里保存的密码分别登录 IMAP / SMTP，把两侧结果都提示出来
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#seTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var $enabledTip = $('#enabledTip');
    var COLS = 9;
    var STATE_KEY = 'service_email_state';

    var state = {
        keyword: '', enabled: '',
        pageNum: 1, pageSize: 10, total: 0,
        rows: {},          // 当前页 id -> row
        selectedId: '',    // 单选：当前选中的服务信箱
        enabledEmail: ''
    };

    /* ---------------- 检索条件存取 ---------------- */
    function saveState() {
        try {
            window.sessionStorage.setItem(STATE_KEY, JSON.stringify({
                keyword: state.keyword, enabled: state.enabled,
                pageNum: state.pageNum, pageSize: state.pageSize
            }));
        } catch (e) { }
    }
    function restoreState() {
        try {
            var raw = window.sessionStorage.getItem(STATE_KEY);
            if (!raw) { return; }
            var s = JSON.parse(raw) || {};
            state.keyword = s.keyword || '';
            state.enabled = (s.enabled === 0 || s.enabled) ? String(s.enabled) : '';
            state.pageNum = parseInt(s.pageNum, 10) || 1;
            state.pageSize = parseInt(s.pageSize, 10) || 10;
            $('#keyword').val(state.keyword);
            $('#enabled').val(state.enabled);
        } catch (e) { }
    }

    function selected() { return state.rows[state.selectedId] || null; }
    function syncToolbar() {
        var row = selected();
        $enabledTip.text(state.enabledEmail ? state.enabledEmail : '未启用任何服务信箱')
            .css('color', state.enabledEmail ? '#67c23a' : '#909399');
        $('#btnEdit, #btnTest, #btnEnable, #btnDisable').prop('disabled', !row);
        if (row) {
            $('#btnEnable').prop('disabled', !!row.enabled);
            $('#btnDisable').prop('disabled', !row.enabled);
        }
    }

    /* ---------------- 列表 ---------------- */
    function badge(ok) {
        return ok ? '<span class="el-tag el-tag--success">启用</span>'
            : '<span class="el-tag el-tag--info">停用</span>';
    }
    function renderRows(data) {
        var list = (data && data.list) || [];
        state.rows = {};
        state.enabledEmail = (data && data.enabledEmail) || '';
        if (!list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '">' +
                '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
                (state.keyword || state.enabled ? '没有符合条件的服务信箱'
                    : '还没有服务信箱（请到「邮箱助手」点右上角设置按钮新增）') +
                '</span></div></td></tr>');
            syncToolbar();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            state.rows[r.id] = r;
            var idx = (state.pageNum - 1) * state.pageSize + i + 1;
            html += '<tr data-id="' + UI.escapeHtml(r.id) + '"' +
                (String(r.id) === String(state.selectedId) ? ' class="is-selected"' : '') + '>' +
                '<td class="is-center">' + idx + '</td>' +
                '<td class="is-center"><label class="el-radio">' +
                    '<input class="el-radio__original" type="radio" name="sePick" value="' +
                    UI.escapeHtml(r.id) + '"' + (String(r.id) === String(state.selectedId) ? ' checked' : '') + '>' +
                    '<span class="el-radio__inner"></span></label></td>' +
                '<td><b>' + UI.escapeHtml(r.email) + '</b>' +
                    (r.lastError ? '<div class="se-error" title="' + UI.escapeHtml(r.lastError) + '">' +
                        UI.escapeHtml(r.lastError) + '</div>' : '') + '</td>' +
                '<td>' + UI.escapeHtml(r.displayName || '') + '</td>' +
                '<td class="se-host">' + UI.escapeHtml(r.imapHostText || '-') +
                    ':' + UI.escapeHtml(String(r.imapPortText || '')) + '</td>' +
                '<td class="se-host">' + UI.escapeHtml(r.smtpHostText || '-') +
                    ':' + UI.escapeHtml(String(r.smtpPortText || '')) + '</td>' +
                '<td class="is-center">' + badge(r.enabled) + '</td>' +
                '<td>' + UI.escapeHtml(r.lastSyncTime || '-') + '</td>' +
                '<td>' + UI.escapeHtml(r.createTime || '') + '</td>' +
                '</tr>';
        }
        $tbody.html(html);
        syncToolbar();
    }

    function loadData() {
        UI.loading($wrapper, true, '加载中…');
        Api.serviceEmail.page({
            keyword: state.keyword, enabled: state.enabled,
            pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (data) {
            state.total = (data && data.total) || 0;
            state.pageNum = (data && data.pageNum) || 1;
            state.pageSize = (data && data.pageSize) || 10;
            renderRows(data);
            UI.pagination($pagerWrap, {
                total: state.total, pageNum: state.pageNum, pageSize: state.pageSize, sizes: [10, 20, 50],
                onChange: function (num, size) {
                    state.pageNum = num; state.pageSize = size;
                    saveState();
                    loadData();
                }
            });
            saveState();
        }).fail(function (err) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '">' +
                '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
                UI.escapeHtml((err && err.message) || '加载失败') + '</span></div></td></tr>');
        }).always(function () { UI.loading($wrapper, false); });
    }

    /* ---------------- 编辑（弹窗，复用 js/service-email-form.js） ----------------
       serviceemail 是单例表：本页「编辑」按钮编辑的就是那唯一一条；
       新增入口在「邮箱助手」右上角设置按钮（表里没有记录时那个弹窗自动变成新增）。 */
    function openForm(row) {
        ServiceEmailForm.open({
            row: row || null,
            onSaved: function (saved) {
                state.selectedId = (saved && saved.id) || state.selectedId;
                loadData();
            }
        });
    }

    /* ---------------- 启用 / 停用 ---------------- */
    function setEnabled(on) {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条服务信箱' }); return; }
        if (!!row.enabled === !!on) {
            UI.message({ type: 'info', message: on ? '该服务信箱已经是启用状态' : '该服务信箱已经是停用状态' });
            return;
        }
        var run = function () {
            Api.serviceEmail.setEnabled(row.id, on).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || (on ? '已启用' : '已停用') });
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
            });
        };
        if (!on) { run(); return; }
        UI.confirm({
            title: '启用服务信箱', type: 'warning',
            message: state.enabledEmail && state.enabledEmail !== row.email
                ? ('启用后「' + state.enabledEmail + '」会自动停用（全表只能有一条启用记录），确定启用「' + row.email + '」吗？')
                : ('确定启用服务信箱「' + row.email + '」吗？'),
            confirmText: '确定启用', cancelText: '取消'
        }).done(function (ok) { if (ok) { run(); } });
    }

    /* ---------------- 测试连接 ---------------- */
    function testConn() {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条服务信箱' }); return; }
        var $btn = $('#btnTest').prop('disabled', true).text('测试中…');
        Api.serviceEmail.test(row.id).done(function (res) {
            var m = (res && res.messages) || {};
            UI.alert({
                title: '连接测试通过', type: 'success',
                message: '收件（IMAP）：' + (m.imap || '成功') + '\n发件（SMTP）：' + (m.smtp || '成功')
            });
            loadData();
        }).fail(function (err) {
            UI.alert({
                title: '连接测试未通过', type: 'warning',
                message: (err && err.message) || '请检查邮箱地址与密码 / 授权码'
            });
            loadData();
        }).always(function () {
            $btn.prop('disabled', false).html('测试连接');
        });
    }

    /* ---------------- 事件绑定 ---------------- */
    $('#btnSearch').on('click', function () {
        state.keyword = $.trim($('#keyword').val());
        state.enabled = $('#enabled').val();
        state.pageNum = 1;
        loadData();
    });
    $('#btnReset').on('click', function () {
        $('#keyword').val('');
        $('#enabled').val('');
        state.keyword = ''; state.enabled = ''; state.pageNum = 1;
        loadData();
    });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnSearch').trigger('click'); } });
    $('#btnEdit').on('click', function () {
        var row = selected();
        if (row) { openForm(row); }
    });
    $('#btnEnable').on('click', function () { setEnabled(true); });
    $('#btnDisable').on('click', function () { setEnabled(false); });
    $('#btnTest').on('click', testConn);
    $('#btnRefresh').on('click', loadData);

    $tbody.on('click', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        $tbody.find('tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        $tbody.find('input[name=sePick]').prop('checked', false);
        $(this).find('input[name=sePick]').prop('checked', true);
        syncToolbar();
    });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        openForm(selected());
    });

    restoreState();
    loadData();
});
