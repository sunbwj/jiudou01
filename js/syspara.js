/* ==========================================================================
   syspara.js —— 系统配置 · 系统参数（syspara）
   --------------------------------------------------------------------------
   · 检索卡片（关键字 / 启用状态）→ 操作引导区 → 表格 → 分页；
   · 参数英文名全局唯一，参数值最多 1000 字；显示序号决定列表顺序；
   · 停用的参数仍可在列表里维护，启用 / 停用只切换 enabled。
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#spTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var COLS = 8;
    var STATE_KEY = 'syspara_state';

    var state = {
        keyword: '', enabled: '',
        pageNum: 1, pageSize: 10, total: 0,
        rows: {}, selectedId: ''
    };

    function esc(text) { return UI.escapeHtml(text == null ? '' : text); }
    function selected() { return state.rows[state.selectedId] || null; }

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
        } catch (e) { }
    }
    function syncSearch() { $('#enabled').val(state.enabled); }

    function syncToolbar() {
        var row = selected();
        $('#btnEdit, #btnEnable, #btnDisable, #btnDelete').prop('disabled', !row);
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
        $('#spCount').text(state.total + '');
        if (!list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '">' +
                '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
                (state.keyword || state.enabled !== '' ? '没有符合条件的系统参数'
                    : '还没有系统参数，点「新增参数」创建一条') +
                '</span></div></td></tr>');
            syncToolbar();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            state.rows[r.id] = r;
            var idx = (state.pageNum - 1) * state.pageSize + i + 1;
            html += '<tr data-id="' + esc(r.id) + '"' +
                (String(r.id) === String(state.selectedId) ? ' class="is-selected"' : '') + '>' +
                '<td class="is-center">' + idx + '</td>' +
                '<td class="is-center"><label class="el-radio">' +
                    '<input class="el-radio__original" type="radio" name="spPick" value="' +
                    esc(r.id) + '"' + (String(r.id) === String(state.selectedId) ? ' checked' : '') + '>' +
                    '<span class="el-radio__inner"></span></label></td>' +
                '<td><b>' + esc(r.paraNameCn) + '</b></td>' +
                '<td><span class="sys-name-en">' + esc(r.paraNameEn) + '</span></td>' +
                '<td><div class="pj-sub" title="' + esc(r.paraValue) + '">' +
                    esc(r.paraValue || '—') + '</div></td>' +
                '<td class="is-center">' + (parseInt(r.sortNo, 10) || 0) + '</td>' +
                '<td><div class="pj-sub" title="' + esc(r.remark) + '">' + esc(r.remark || '—') + '</div></td>' +
                '<td class="is-center">' + badge(r.enabled) + '</td>' +
                '</tr>';
        }
        $tbody.html(html);
        syncToolbar();
    }

    function loadData() {
        UI.loading($wrapper, true, '加载中…');
        Api.sysPara.page({
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
                esc((err && err.message) || '加载失败') + '</span></div></td></tr>');
        }).always(function () { UI.loading($wrapper, false); });
    }

    /* ---------------- 新增 / 编辑 ---------------- */
    function openForm(row) {
        var isEdit = !!row;
        var $form = $('#paraFormTpl').children().clone(true);
        UI.dialog({
            title: isEdit ? ('编辑系统参数 —— ' + row.paraNameCn) : '新增系统参数',
            width: 600, content: $form,
            onReady: function ($body) {
                var $f = $body.find('.pj-form');
                if (isEdit) {
                    $f.find('#spNameCn').val(row.paraNameCn || '');
                    $f.find('#spNameEn').val(row.paraNameEn || '');
                    $f.find('#spValue').val(row.paraValue || '');
                    $f.find('#spSort').val(parseInt(row.sortNo, 10) || 0);
                    $f.find('#spRemark').val(row.remark || '');
                    $f.find('#spEnabled').val(row.enabled ? '1' : '0');
                } else {
                    $f.find('#spSort').val(0);
                    $f.find('#spEnabled').val('1');
                }
                $f.find('#spNameCn').trigger('focus');
            },
            onOk: function ($body, close) {
                var $f = $body.find('.pj-form');
                var cn = $.trim($f.find('#spNameCn').val());
                var en = $.trim($f.find('#spNameEn').val());
                if (!cn) { UI.message({ type: 'warning', message: '请填写参数中文名' }); return; }
                if (!en) { UI.message({ type: 'warning', message: '请填写参数英文名' }); return; }
                var data = {
                    paraNameCn: cn, paraNameEn: en,
                    paraValue: $.trim($f.find('#spValue').val()),
                    sortNo: parseInt($f.find('#spSort').val(), 10) || 0,
                    remark: $.trim($f.find('#spRemark').val()),
                    enabled: $f.find('#spEnabled').val() === '1' ? 1 : 0
                };
                if (isEdit) { data.id = row.id; }
                var req = isEdit ? Api.sysPara.update(data) : Api.sysPara.add(data);
                req.done(function (saved) {
                    UI.message({ type: 'success', message: isEdit ? '保存成功' : '新增成功' });
                    state.selectedId = (saved && saved.id) || state.selectedId;
                    close();
                    loadData();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    /* ---------------- 启用 / 停用 / 删除 ---------------- */
    function setEnabled(on) {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条系统参数' }); return; }
        if (!!row.enabled === !!on) {
            UI.message({ type: 'info', message: on ? '该参数已经是启用状态' : '该参数已经是停用状态' });
            return;
        }
        Api.sysPara.setEnabled(row.id, on).done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || (on ? '已启用' : '已停用') });
            loadData();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
        });
    }
    function removePara() {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条系统参数' }); return; }
        UI.confirm({
            title: '删除系统参数', type: 'warning',
            message: '确定删除参数「' + row.paraNameCn + '」吗？',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.sysPara.remove(row.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '已删除' });
                state.selectedId = '';
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
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
        $('#keyword').val(''); $('#enabled').val('');
        state.keyword = ''; state.enabled = ''; state.pageNum = 1;
        loadData();
    });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnSearch').trigger('click'); } });
    $('#btnAdd').on('click', function () { openForm(null); });
    $('#btnEdit').on('click', function () { var row = selected(); if (row) { openForm(row); } });
    $('#btnEnable').on('click', function () { setEnabled(true); });
    $('#btnDisable').on('click', function () { setEnabled(false); });
    $('#btnDelete').on('click', removePara);
    $('#btnRefresh').on('click', loadData);

    $tbody.on('click', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        $tbody.find('tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        $tbody.find('input[name=spPick]').prop('checked', false);
        $(this).find('input[name=spPick]').prop('checked', true);
        syncToolbar();
    });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        openForm(selected());
    });

    restoreState();
    syncToolbar();                 // 首屏未选中任何记录时先禁用编辑 / 启停 / 删除
    syncSearch();
    loadData();
});
