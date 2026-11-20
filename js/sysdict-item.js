/* ==========================================================================
   sysdict-item.js —— 系统配置 · 字典键值（sysdictitems）
   --------------------------------------------------------------------------
   · 检索卡片（所属字典 / 关键字 / 启用状态）→ 操作引导区 → 表格 → 分页；
   · 支持从「系统字典」页带 ?dictId=<UUID> 进来自动按该字典预筛（URL 优先于 sessionStorage）；
   · 同一字典下「键」不可重复，键留空表示纯枚举值；所属字典从字典树下拉里选；
   · 「返回字典」回到 sysdict.html。
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#siTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var COLS = 8;
    var STATE_KEY = 'sysdictitem_state';

    var state = {
        dictId: '', keyword: '', enabled: '',
        pageNum: 1, pageSize: 10, total: 0,
        rows: {}, selectedId: '',
        tree: []
    };

    function esc(text) { return UI.escapeHtml(text == null ? '' : text); }
    function selected() { return state.rows[state.selectedId] || null; }
    function queryParam(name) {
        var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search || '');
        return m ? decodeURIComponent(m[1]) : '';
    }

    /* ---------------- 检索条件存取 ---------------- */
    function saveState() {
        try {
            window.sessionStorage.setItem(STATE_KEY, JSON.stringify({
                dictId: state.dictId, keyword: state.keyword, enabled: state.enabled,
                pageNum: state.pageNum, pageSize: state.pageSize
            }));
        } catch (e) { }
    }
    function restoreState() {
        try {
            var raw = window.sessionStorage.getItem(STATE_KEY);
            if (raw) {
                var s = JSON.parse(raw) || {};
                state.dictId = s.dictId || '';
                state.keyword = s.keyword || '';
                state.enabled = (s.enabled === 0 || s.enabled) ? String(s.enabled) : '';
                state.pageNum = parseInt(s.pageNum, 10) || 1;
                state.pageSize = parseInt(s.pageSize, 10) || 10;
            }
        } catch (e) { }
        // URL 参数优先（从系统字典页「维护键值」跳过来时按该项目预筛）
        var fromUrl = queryParam('dictId');
        if (fromUrl) { state.dictId = fromUrl; state.pageNum = 1; }
        $('#keyword').val(state.keyword);
    }
    function syncSearch() {
        $('#dictId').val(state.dictId);
        $('#enabled').val(state.enabled);
        var name = '全部字典';
        for (var i = 0; i < state.tree.length; i++) {
            if (String(state.tree[i].id) === String(state.dictId)) {
                name = state.tree[i].dictNameCn || state.tree[i].label || name;
                break;
            }
        }
        $('#siCurrentDict').text(name);
    }

    function syncToolbar() {
        var row = selected();
        $('#btnEdit, #btnEnable, #btnDisable, #btnDelete').prop('disabled', !row);
        if (row) {
            $('#btnEnable').prop('disabled', !!row.enabled);
            $('#btnDisable').prop('disabled', !row.enabled);
        }
    }

    /* ---------------- 字典下拉 ---------------- */
    function fillTree($sel, list, placeholder) {
        var html = placeholder ? '<option value="">' + esc(placeholder) + '</option>' : '';
        for (var i = 0; i < list.length; i++) {
            html += '<option value="' + esc(list[i].id) + '">' + esc(list[i].label) + '</option>';
        }
        $sel.html(html);
    }
    function loadDicts() {
        return Api.sysDict.tree().done(function (data) {
            state.tree = (data && data.list) || [];
            fillTree($('#dictId'), state.tree, '全部字典');
            syncSearch();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '字典下拉加载失败' });
        });
    }

    /* ---------------- 列表 ---------------- */
    function badge(ok) {
        return ok ? '<span class="el-tag el-tag--success">启用</span>'
            : '<span class="el-tag el-tag--info">停用</span>';
    }
    function renderRows(data) {
        var list = (data && data.list) || [];
        state.rows = {};
        $('#siCount').text(state.total + '');
        if (!list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '">' +
                '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
                (state.dictId || state.keyword || state.enabled !== '' ? '没有符合条件的字典键值'
                    : '还没有字典键值，点「新增键值」创建一条') +
                '</span></div></td></tr>');
            syncToolbar();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            state.rows[r.id] = r;
            var idx = (state.pageNum - 1) * state.pageSize + i + 1;
            var label = (r.dictNameCn || '（字典已删除）') +
                (r.dictNameEn ? ' / ' + r.dictNameEn : '');
            html += '<tr data-id="' + esc(r.id) + '"' +
                (String(r.id) === String(state.selectedId) ? ' class="is-selected"' : '') + '>' +
                '<td class="is-center">' + idx + '</td>' +
                '<td class="is-center"><label class="el-radio">' +
                    '<input class="el-radio__original" type="radio" name="siPick" value="' +
                    esc(r.id) + '"' + (String(r.id) === String(state.selectedId) ? ' checked' : '') + '>' +
                    '<span class="el-radio__inner"></span></label></td>' +
                '<td>' + esc(label) + '</td>' +
                '<td><span class="sys-name-en">' + esc(r.itemKey || '—') + '</span></td>' +
                '<td><b>' + esc(r.itemValue) + '</b></td>' +
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
        Api.sysDictItem.page({
            dictId: state.dictId, keyword: state.keyword, enabled: state.enabled,
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
        var $form = $('#itemFormTpl').children().clone(true);
        UI.dialog({
            title: isEdit ? ('编辑字典键值 —— ' + row.itemValue) : '新增字典键值',
            width: 600, content: $form,
            onReady: function ($body) {
                var $f = $body.find('.pj-form');
                fillTree($f.find('#siDict'), state.tree, '请选择所属字典');
                if (isEdit) {
                    $f.find('#siDict').val(row.dictId || '');
                    $f.find('#siKey').val(row.itemKey || '');
                    $f.find('#siValue').val(row.itemValue || '');
                    $f.find('#siSort').val(parseInt(row.sortNo, 10) || 0);
                    $f.find('#siRemark').val(row.remark || '');
                    $f.find('#siEnabled').val(row.enabled ? '1' : '0');
                } else {
                    $f.find('#siDict').val(state.dictId || '');
                    $f.find('#siSort').val(0);
                    $f.find('#siEnabled').val('1');
                }
                $f.find('#siValue').trigger('focus');
            },
            onOk: function ($body, close) {
                var $f = $body.find('.pj-form');
                var dictId = $f.find('#siDict').val() || '';
                var value = $.trim($f.find('#siValue').val());
                if (!dictId) { UI.message({ type: 'warning', message: '请选择所属字典' }); return; }
                if (!value) { UI.message({ type: 'warning', message: '请填写键值' }); return; }
                var data = {
                    dictId: dictId,
                    itemKey: $.trim($f.find('#siKey').val()),
                    itemValue: value,
                    sortNo: parseInt($f.find('#siSort').val(), 10) || 0,
                    remark: $.trim($f.find('#siRemark').val()),
                    enabled: $f.find('#siEnabled').val() === '1' ? 1 : 0
                };
                if (isEdit) { data.id = row.id; }
                var req = isEdit ? Api.sysDictItem.update(data) : Api.sysDictItem.add(data);
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

    /* ---------------- 启用 / 停用 / 删除 / 返回 ---------------- */
    function setEnabled(on) {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条字典键值' }); return; }
        if (!!row.enabled === !!on) {
            UI.message({ type: 'info', message: on ? '该键值已经是启用状态' : '该键值已经是停用状态' });
            return;
        }
        Api.sysDictItem.setEnabled(row.id, on).done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || (on ? '已启用' : '已停用') });
            loadData();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
        });
    }
    function removeItem() {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条字典键值' }); return; }
        UI.confirm({
            title: '删除字典键值', type: 'warning',
            message: '确定删除键值「' + row.itemValue + '」吗？',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.sysDictItem.remove(row.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '已删除' });
                state.selectedId = '';
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }
    function backToDict() {
        var url = 'sysdict.html';
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    }

    /* ---------------- 事件绑定 ---------------- */
    $('#btnSearch').on('click', function () {
        state.dictId = $('#dictId').val();
        state.keyword = $.trim($('#keyword').val());
        state.enabled = $('#enabled').val();
        state.pageNum = 1;
        syncSearch();
        loadData();
    });
    $('#btnReset').on('click', function () {
        $('#dictId').val(''); $('#keyword').val(''); $('#enabled').val('');
        state.dictId = ''; state.keyword = ''; state.enabled = ''; state.pageNum = 1;
        syncSearch();
        loadData();
    });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnSearch').trigger('click'); } });
    $('#btnAdd').on('click', function () { openForm(null); });
    $('#btnEdit').on('click', function () { var row = selected(); if (row) { openForm(row); } });
    $('#btnEnable').on('click', function () { setEnabled(true); });
    $('#btnDisable').on('click', function () { setEnabled(false); });
    $('#btnDelete').on('click', removeItem);
    $('#btnBack').on('click', backToDict);
    $('#btnRefresh').on('click', function () { loadDicts(); loadData(); });

    $tbody.on('click', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        $tbody.find('tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        $tbody.find('input[name=siPick]').prop('checked', false);
        $(this).find('input[name=siPick]').prop('checked', true);
        syncToolbar();
    });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        openForm(selected());
    });

    restoreState();
    syncToolbar();                 // 首屏未选中任何记录时先禁用编辑 / 启停 / 删除
    loadDicts();                   // 字典下拉与列表并行加载，互不阻塞
    loadData();
});
