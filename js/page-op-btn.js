/* ==========================================================================
   page-op-btn.js —— 页面操作按钮管理（pageopbtn）
   --------------------------------------------------------------------------
   · 表：pageopbtn（记录ID 为 UUID 主键，非自增），pagePath + btnId 唯一
   · 打开页面时**自动收录**：调用 /pageopbtn/scan 扫描各 .html 的操作引导区
     （.toolbar / .pick-toolbar / .form-actions），把按钮登记进表并同步文本；
     也可点「重新收录」手动触发
   · 列表：所属页面 / 页面路径 / 按钮id / 按钮文本 / 启用否 / 更新时间（按页面 + 按钮顺序）
   · 维护：编辑（按钮文本 / 启用否 / 备注，页面与按钮id 只读）、启用 / 停用、删除
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#pobTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var $selTip = $('#selTip');
    var COLS = 8;
    var STATE_KEY = 'page_op_btn_list_state';

    var state = {
        keyword: '', pagePath: '', enabled: '',
        pageNum: 1, pageSize: 10, total: 0,
        selectedId: '', selectedLabel: ''
    };
    var pager = null;
    var rowCache = {};

    function fieldOf($form, name) { return $form.find('[name="' + name + '"]'); }

    /* ---------- 检索条件存取 ---------- */
    function saveState() {
        try {
            window.sessionStorage.setItem(STATE_KEY, JSON.stringify({
                keyword: state.keyword, pagePath: state.pagePath, enabled: state.enabled,
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
            state.pagePath = s.pagePath || '';
            state.enabled = (s.enabled === 0 || s.enabled) ? String(s.enabled) : '';
            state.pageNum = parseInt(s.pageNum, 10) || 1;
            state.pageSize = parseInt(s.pageSize, 10) || 10;
            $('#keyword').val(state.keyword);
            $('#enabledFilter').val(state.enabled);
        } catch (e) { }
    }

    /* ---------- 页面下拉（已收录的页面） ---------- */
    function loadPages() {
        var dfd = $.Deferred();
        Api.pageOpBtn.pages().done(function (data) {
            var list = (data && data.list) || [];
            var html = '<option value="">全部页面</option>';
            for (var i = 0; i < list.length; i++) {
                var p = list[i];
                html += '<option value="' + UI.escapeHtml(p.pagePath) + '">' +
                    UI.escapeHtml((p.pageName || p.pagePath) + '（' + p.pagePath + ' · ' + p.total + '）') +
                    '</option>';
            }
            $('#pageFilter').html(html).val(state.pagePath || '');
            dfd.resolve(list);
        }).fail(function () { dfd.resolve([]); });
        return dfd.promise();
    }

    /* ---------- 列表渲染 ---------- */
    function rowNo(index) {
        return (parseInt(state.pageNum, 10) - 1) * (parseInt(state.pageSize, 10) || 10) + index + 1;
    }

    function rowHtml(item, index) {
        var id = String(item.id || '');
        var selected = state.selectedId === id;
        var enabled = !!item.enabled;
        return '' +
            '<tr data-id="' + UI.escapeHtml(id) + '" data-label="' + UI.escapeHtml(item.pageName + '/' + item.btnText) + '"' +
                (selected ? ' class="current-row"' : '') + '>' +
                '<td class="is-center el-table__index-cell" data-label="序号"><div class="cell cell-index">' + rowNo(index) + '</div></td>' +
                '<td class="is-center el-table__radio-cell" data-label="选择"><div class="cell">' +
                    '<label class="el-radio' + (selected ? ' is-checked' : '') + '">' +
                        '<input class="el-radio__original" type="radio" name="pobRow" value="' + UI.escapeHtml(id) + '"' + (selected ? ' checked' : '') + '>' +
                        '<span class="el-radio__inner"></span>' +
                    '</label>' +
                '</div></td>' +
                '<td data-label="所属页面"><div class="cell cell-strong">' + UI.escapeHtml(item.pageName || '-') + '</div></td>' +
                '<td data-label="页面路径"><div class="cell cell-mono">' + UI.escapeHtml(item.pagePath || '-') + '</div></td>' +
                '<td data-label="按钮id"><div class="cell cell-mono">#' + UI.escapeHtml(item.btnId || '') + '</div></td>' +
                '<td data-label="按钮文本"><div class="cell">' + UI.escapeHtml(item.btnText || '-') +
                    (item.missing ? ' <span class="el-tag el-tag--small el-tag--info">页面已无</span>' : '') + '</div></td>' +
                '<td class="is-center" data-label="启用否"><div class="cell">' +
                    '<span class="el-tag el-tag--small ' + (enabled ? 'el-tag--success' : 'el-tag--info') + '">' +
                        (enabled ? '启用' : '停用') + '</span>' +
                '</div></td>' +
                '<td data-label="更新时间"><div class="cell">' + UI.escapeHtml(item.updateTime || '-') + '</div></td>' +
            '</tr>';
    }

    function renderTable(list) {
        rowCache = {};
        if (!list || !list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">暂无数据，点「重新收录」扫描各页面的操作按钮</span></div></td></tr>');
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            rowCache[String(list[i].id)] = list[i];
            html += rowHtml(list[i], i);
        }
        $tbody.html(html);
    }

    function selectRow($tr) {
        $tbody.find('tr').removeClass('current-row');
        $tbody.find('.el-radio').removeClass('is-checked').find('input').prop('checked', false);
        if (!$tr || !$tr.length) {
            state.selectedId = '';
            state.selectedLabel = '';
            $selTip.text('未选择任何按钮');
            return;
        }
        $tr.addClass('current-row');
        $tr.find('.el-radio').addClass('is-checked').find('input').prop('checked', true);
        state.selectedId = String($tr.attr('data-id') || '');
        state.selectedLabel = $tr.attr('data-label') || '';
        $selTip.text(state.selectedLabel ? ('【' + state.selectedLabel + '】') : state.selectedId);
    }
    function clearSelect() { selectRow(null); }

    /* ---------- 数据加载 ---------- */
    function loadData() {
        UI.loading($wrapper, true, '加载中…');
        Api.pageOpBtn.page({
            keyword: state.keyword, pagePath: state.pagePath, enabled: state.enabled,
            pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (data) {
            var list = (data && data.list) || [];
            state.total = (data && data.total) || 0;
            state.pageNum = (data && data.pageNum) || state.pageNum;
            if (state.selectedId && !inList(list, state.selectedId)) { clearSelect(); }
            renderTable(list);
            renderPager();
        }).fail(function (err) {
            UI.message({ type: 'error', message: err.message || '查询失败' });
        }).always(function () {
            UI.loading($wrapper, false);
        });
    }
    function inList(list, id) {
        for (var i = 0; i < list.length; i++) { if (String(list[i].id) === String(id)) { return true; } }
        return false;
    }

    function renderPager() {
        pager = UI.pagination($pagerWrap, {
            total: state.total, pageNum: state.pageNum, pageSize: state.pageSize,
            onChange: function (pageNum, pageSize) {
                state.pageNum = pageNum;
                state.pageSize = pageSize;
                saveState();
                loadData();
            }
        });
    }

    /* ---------- 自动收录 ---------- */
    var scanning = false;
    function doScan(silent) {
        if (scanning) { return $.Deferred().resolve().promise(); }
        scanning = true;
        var dfd = $.Deferred();
        var $btn = $('#btnScan');
        $btn.prop('disabled', true).addClass('is-loading');
        Api.pageOpBtn.scan().done(function (res) {
            var r = res || {};
            if (!silent || r.added || r.updated || r.missing) {
                UI.message({
                    type: 'success',
                    message: '自动收录完成：新增 ' + (r.added || 0) + ' 项，更新 ' + (r.updated || 0) +
                        ' 项，未变 ' + (r.unchanged || 0) + ' 项' +
                        (r.missing ? ('，页面中已不存在 ' + r.missing + ' 项') : '') +
                        '（共 ' + (r.total || 0) + ' 项 / ' + (r.pages || 0) + ' 个页面）'
                });
            }
            dfd.resolve(r);
        }).fail(function (err) {
            UI.message({ type: 'error', message: '自动收录失败：' + (err && err.message || '未知错误') });
            dfd.resolve({});
        }).always(function () {
            scanning = false;
            $btn.prop('disabled', false).removeClass('is-loading');
        });
        return dfd.promise();
    }

    /* ---------- 弹窗表单（编辑） ---------- */
    function clearErrors($form) {
        $form.find('.el-form-item__error').remove();
        $form.find('.el-form-item').removeClass('is-error');
    }
    function setError($form, field, msg) {
        var $item = $form.find('[data-field="' + field + '"]');
        $item.find('.el-form-item__error').remove();
        if (msg) {
            $item.addClass('is-error');
            $item.find('.el-form-item__content').append('<div class="el-form-item__error">' + msg + '</div>');
        } else {
            $item.removeClass('is-error');
        }
    }

    function openForm(row) {
        var $form = $('#pobFormTpl').find('.emp-form').clone();
        $form.data('editId', row.id);
        fieldOf($form, 'pageName').val(row.pageName || '');
        fieldOf($form, 'pagePath').val(row.pagePath || '');
        fieldOf($form, 'btnId').val(row.btnId || '');
        fieldOf($form, 'btnText').val(row.btnText || '');
        fieldOf($form, 'enabled').val(row.enabled ? '1' : '0');
        fieldOf($form, 'remark').val(row.remark || '');

        var submitting = false;
        UI.dialog({
            title: '编辑操作按钮 —— ' + (row.pagePath || '') + ' #' + (row.btnId || ''),
            width: 680,
            content: $form,
            onReady: function ($body) {
                var $f = $body.find('.emp-form');
                fieldOf($f, 'btnText').on('blur', function () {
                    var v = $.trim($(this).val());
                    setError($f, 'btnText', v ? '' : '操作按钮文本不能为空');
                });
            },
            onOk: function ($body, close) {
                var $f = $body.find('.emp-form');
                if (submitting) { return; }
                clearErrors($f);
                var data = {
                    id: $f.data('editId'),
                    pageName: $.trim(fieldOf($f, 'pageName').val()),
                    btnText: $.trim(fieldOf($f, 'btnText').val()),
                    enabled: fieldOf($f, 'enabled').val(),
                    remark: $.trim(fieldOf($f, 'remark').val())
                };
                var ok = true;
                if (!data.btnText) { setError($f, 'btnText', '操作按钮文本不能为空'); ok = false; }
                else if (data.btnText.length > 60) { setError($f, 'btnText', '按钮文本不超过 60 个字符'); ok = false; }
                if (!data.pageName) { setError($f, 'pageName', '所属页面不能为空'); ok = false; }
                else if (data.pageName.length > 60) { setError($f, 'pageName', '所属页面不超过 60 个字符'); ok = false; }
                if (data.remark && data.remark.length > 200) { setError($f, 'remark', '备注不超过 200 个字符'); ok = false; }
                if (!ok) { return; }

                submitting = true;
                Api.pageOpBtn.update(data).done(function () {
                    close();
                    UI.message({ type: 'success', message: '修改成功' });
                    loadPages();
                    loadData();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: err.message || '保存失败' });
                    submitting = false;
                });
            }
        });
    }

    /* ---------- 启用 / 停用 ---------- */
    function toggleEnabled(enabled) {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在列表中选择一个要' + (enabled ? '启用' : '停用') + '的按钮。' });
            return;
        }
        var row = rowCache[state.selectedId];
        if (!row) { UI.message({ type: 'error', message: '数据已失效，请刷新后重试' }); return; }
        if (!!row.enabled === enabled) {
            UI.message({ type: 'info', message: '该按钮已是' + (enabled ? '启用' : '停用') + '状态' });
            return;
        }
        UI.loading($wrapper, true, '处理中…');
        Api.pageOpBtn.update({
            id: row.id, pageName: row.pageName, btnText: row.btnText,
            enabled: enabled ? '1' : '0', remark: row.remark || ''
        }).done(function () {
            UI.message({ type: 'success', message: enabled ? '已启用' : '已停用' });
            loadPages();
            loadData();
        }).fail(function (err) {
            UI.message({ type: 'error', message: err.message || '操作失败' });
        }).always(function () {
            UI.loading($wrapper, false);
        });
    }

    /* ---------- 事件 ---------- */
    $tbody.on('click', 'tr[data-id]', function () { selectRow($(this)); });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        selectRow($(this));
        var row = rowCache[String($(this).attr('data-id'))];
        if (row) { openForm(row); }
    });

    function doSearch(reset) {
        if (reset) {
            $('#keyword').val('');
            $('#pageFilter').val('');
            $('#enabledFilter').val('');
            state.keyword = '';
            state.pagePath = '';
            state.enabled = '';
        } else {
            state.keyword = $.trim($('#keyword').val());
            state.pagePath = $('#pageFilter').val() || '';
            state.enabled = $('#enabledFilter').val() || '';
        }
        state.pageNum = 1;
        clearSelect();
        saveState();
        loadData();
    }

    $('#btnSearch').on('click', function () { doSearch(false); });
    $('#btnReset').on('click', function () { doSearch(true); });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { doSearch(false); } });
    $('#pageFilter').on('change', function () { doSearch(false); });
    $('#enabledFilter').on('change', function () { doSearch(false); });

    // 重新收录：扫描后刷新页面下拉与列表
    $('#btnScan').on('click', function () {
        doScan(false).done(function () {
            clearSelect();
            loadPages().done(function () { loadData(); });
        });
    });

    $('#btnEdit').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在列表中选择一个要编辑的按钮。' });
            return;
        }
        var row = rowCache[state.selectedId];
        if (!row) { UI.message({ type: 'error', message: '数据已失效，请刷新后重试' }); return; }
        openForm(row);
    });

    $('#btnEnable').on('click', function () { toggleEnabled(true); });
    $('#btnDisable').on('click', function () { toggleEnabled(false); });

    $('#btnDelete').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在列表中选择一个要删除的按钮。' });
            return;
        }
        var id = state.selectedId, label = state.selectedLabel;
        UI.confirm({
            title: '删除确认', type: 'warning',
            message: '确定删除【' + label + '】这条按钮记录吗？删除后再点「重新收录」可重新登记。',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            UI.loading($wrapper, true, '删除中…');
            Api.pageOpBtn.remove(id).done(function () {
                UI.message({ type: 'success', message: '删除成功' });
                clearSelect();
                var pages = Math.max(1, Math.ceil((state.total - 1) / state.pageSize));
                if (state.pageNum > pages) { state.pageNum = pages; }
                loadPages();
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: err.message || '删除失败' });
            }).always(function () {
                UI.loading($wrapper, false);
            });
        });
    });

    $('#btnRefresh').on('click', function () {
        loadPages().done(function () { loadData(); });
    });

    /* ---------- 初始化：先自动收录，再加载列表 ---------- */
    restoreState();
    doScan(true).done(function () {
        loadPages().done(function () { loadData(); });
    });
});
