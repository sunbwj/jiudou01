/* ==========================================================================
   role.js —— 用户角色管理（单页完成：查询 / 新增 / 编辑 / 删除）
   --------------------------------------------------------------------------
   · 表：usergroup（角色ID 为 UUID 主键，CHAR(36)，非自增；由服务端 uuid4() 生成）
   · 列表：中文名 / 英文名 / 说明 / 排序号 / 启用否 / 创建时间（**角色ID（UUID）不展示**），按排序号升序
   · 新增与编辑都在本页用弹窗表单完成（不跳转页面），保存后原地刷新列表；
     **角色ID 由服务端自动生成，新增与编辑表单中均不显示**（仅内部作为 id 随请求提交）
   · 中文名：必填，**仅在启用状态内唯一**（停用状态可重名，也可复用启用角色的名字）
   · 英文名：必填 + **全局唯一**（失焦与提交前各校验一次，服务端唯一索引兜底）
   · 排序号：0-9999 整数，留空按 0；启用否：1-启用 / 0-停用
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#roleTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var $selTip = $('#selTip');
    var COLS = 8;
    var STATE_KEY = 'role_admin_list_state';

    var state = {
        keyword: '', enabled: '',
        pageNum: 1, pageSize: 10, total: 0,
        selectedId: '', selectedName: ''      // 主键是 UUID 字符串，不能用 parseInt
    };
    var pager = null;
    var rowCache = {};                        // 当前页数据（id → 行对象）
    var RE_NAME_EN = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;

    /* ---------- 检索条件存取（返回列表时保持） ---------- */
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
            $('#enabledFilter').val(state.enabled);
        } catch (e) { }
    }

    /* ---------- 行选中 ---------- */
    function rowNo(index) {
        return (parseInt(state.pageNum, 10) - 1) * (parseInt(state.pageSize, 10) || 10) + index + 1;
    }

    function rowHtml(item, index) {
        var id = String(item.id || '');
        var selected = state.selectedId === id;
        var enabled = !!item.enabled;
        return '' +
            '<tr data-id="' + UI.escapeHtml(id) + '" data-name="' + UI.escapeHtml(item.nameCn) + '"' +
                (selected ? ' class="current-row"' : '') + '>' +
                '<td class="is-center el-table__index-cell" data-label="序号"><div class="cell cell-index">' + rowNo(index) + '</div></td>' +
                '<td class="is-center el-table__radio-cell" data-label="选择"><div class="cell">' +
                    '<label class="el-radio' + (selected ? ' is-checked' : '') + '">' +
                        '<input class="el-radio__original" type="radio" name="roleRow" value="' + UI.escapeHtml(id) + '"' + (selected ? ' checked' : '') + '>' +
                        '<span class="el-radio__inner"></span>' +
                    '</label>' +
                '</div></td>' +
                '<td data-label="中文名"><div class="cell cell-strong">' + UI.escapeHtml(item.nameCn || '') + '</div></td>' +
                '<td data-label="英文名"><div class="cell cell-mono">' + UI.escapeHtml(item.nameEn || '-') + '</div></td>' +
                '<td data-label="说明"><div class="cell cell-desc">' + UI.escapeHtml(item.remark || '-') + '</div></td>' +
                '<td class="is-center" data-label="排序号"><div class="cell cell-mono">' +
                    (item.sortNo === undefined || item.sortNo === null || item.sortNo === '' ? 0 : item.sortNo) + '</div></td>' +
                '<td class="is-center" data-label="启用否"><div class="cell">' +
                    '<span class="el-tag el-tag--small ' + (enabled ? 'el-tag--success' : 'el-tag--info') + '">' +
                        (enabled ? '启用' : '停用') + '</span>' +
                '</div></td>' +
                '<td data-label="创建时间"><div class="cell">' + UI.escapeHtml(item.createTime || '-') + '</div></td>' +
            '</tr>';
    }

    function renderTable(list) {
        rowCache = {};
        if (!list || !list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">暂无数据</span></div></td></tr>');
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
            state.selectedName = '';
            $selTip.text('未选择任何角色');
            return;
        }
        $tr.addClass('current-row');
        $tr.find('.el-radio').addClass('is-checked').find('input').prop('checked', true);
        state.selectedId = String($tr.attr('data-id') || '');
        state.selectedName = $tr.attr('data-name') || '';
        $selTip.text(state.selectedName ? ('【' + state.selectedName + '】') : state.selectedId);
    }
    function clearSelect() { selectRow(null); }

    /* ---------- 数据加载 ---------- */
    function loadData() {
        UI.loading($wrapper, true, '加载中…');
        Api.role.page({
            keyword: state.keyword, enabled: state.enabled,
            pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (data) {
            var list = (data && data.list) || [];
            state.total = (data && data.total) || 0;
            state.pageNum = (data && data.pageNum) || state.pageNum;
            if (state.selectedId && !rowCacheIn(list, state.selectedId)) { clearSelect(); }
            renderTable(list);
            renderPager();
        }).fail(function (err) {
            UI.message({ type: 'error', message: err.message || '查询失败' });
        }).always(function () {
            UI.loading($wrapper, false);
        });
    }
    function rowCacheIn(list, id) {
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

    /* ---------- 弹窗表单（新增 / 编辑） ---------- */
    function fieldOf($form, name) { return $form.find('[name="' + name + '"]'); }

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

    function collectForm($form) {
        return {
            id: $form.data('editId') || undefined,
            nameCn: $.trim(fieldOf($form, 'nameCn').val()),
            nameEn: $.trim(fieldOf($form, 'nameEn').val()),
            sortNo: $.trim(fieldOf($form, 'sortNo').val()),
            enabled: parseInt(fieldOf($form, 'enabled').val(), 10) === 0 ? 0 : 1,
            remark: $.trim(fieldOf($form, 'remark').val())
        };
    }

    function validateForm($form, data) {
        clearErrors($form);
        var ok = true, first = null;
        function fail(field, msg) {
            setError($form, field, msg);
            if (!first) { first = field; }
            ok = false;
        }
        if (!data.nameCn) { fail('nameCn', '请输入中文名'); }
        else if (data.nameCn.length > 50) { fail('nameCn', '中文名不超过 50 个字符'); }
        if (!data.nameEn) { fail('nameEn', '请输入英文名'); }
        else if (!RE_NAME_EN.test(data.nameEn)) { fail('nameEn', '英文名以字母开头，仅含字母、数字、下划线（最长 100 位）'); }
        if (data.sortNo !== '') {
            if (!/^\d+$/.test(String(data.sortNo))) { fail('sortNo', '排序号必须是 0-9999 的整数'); }
            else if (parseInt(data.sortNo, 10) > 9999) { fail('sortNo', '排序号为 0-9999 之间的整数'); }
        }
        if (data.remark && data.remark.length > 200) { fail('remark', '说明不超过 200 个字符'); }
        if (first) {
            var $el = $form.find('[data-field="' + first + '"]').find('input,select,textarea').first();
            if ($el.length) { $el.focus(); }
        }
        return ok;
    }

    /**
     * 唯一性校验
     * @param {String} field  'nameCn' | 'nameEn'
     * @param {String} value  待校验的值
     * @param {String} selfId 编辑时的自身 id（UUID）
     * @param {Number} enabled 中文名需要带上启用状态（停用时永远不冲突）
     */
    function checkUnique(field, value, selfId, enabled) {
        var dfd = $.Deferred();
        Api.role.check(field, value, selfId || '', field === 'nameCn' ? enabled : '')
            .done(function (res) { dfd.resolve(!!res.unique); })
            .fail(function () { dfd.resolve(true); });        // 异常时不阻断，服务端唯一索引兜底
        return dfd.promise();
    }

    /**
     * 打开新增 / 编辑弹窗
     * @param {String} mode 'add' | 'edit'
     * @param {Object} row  编辑时的行数据
     */
    function openForm(mode, row) {
        var isEdit = (mode === 'edit');
        var $form = $('#roleFormTpl').find('.emp-form').clone();

        if (isEdit) {
            $form.data('editId', row.id);
            fieldOf($form, 'nameCn').val(row.nameCn || '');
            fieldOf($form, 'nameEn').val(row.nameEn || '');
            fieldOf($form, 'sortNo').val(row.sortNo === undefined || row.sortNo === null ? '' : row.sortNo);
            fieldOf($form, 'enabled').val(Number(row.enabled) ? '1' : '0');
            fieldOf($form, 'remark').val(row.remark || '');
        } else {
            fieldOf($form, 'nameCn').val('');
            fieldOf($form, 'nameEn').val('');
            fieldOf($form, 'sortNo').val('');
            fieldOf($form, 'enabled').val('1');
            fieldOf($form, 'remark').val('');
            // 新角色排序号默认接在现有最大值之后
            Api.role.page({ pageNum: 1, pageSize: 200 }).done(function (data) {
                var list = (data && data.list) || [], max = 0;
                for (var i = 0; i < list.length; i++) {
                    var n = parseInt(list[i].sortNo, 10);
                    if (!isNaN(n) && n > max) { max = n; }
                }
                if (!$.trim(fieldOf($form, 'sortNo').val())) { fieldOf($form, 'sortNo').val(max + 1); }
            });
        }

        var submitting = false;

        UI.dialog({
            title: isEdit ? ('编辑角色 —— ' + (row.nameCn || '')) : '新增角色',
            width: 680,
            content: $form,
            onReady: function ($body) {
                var $f = $body.find('.emp-form');
                fieldOf($f, 'nameCn').on('blur', function () {
                    var v = $.trim($(this).val());
                    if (!v) { setError($f, 'nameCn', '请输入中文名'); return; }
                    checkUnique('nameCn', v, isEdit ? row.id : '', parseInt(fieldOf($f, 'enabled').val(), 10) === 0 ? 0 : 1)
                        .done(function (unique) {
                            setError($f, 'nameCn', unique ? '' : '该中文名已被其它启用状态的角色使用');
                        });
                });
                fieldOf($f, 'nameEn').on('blur', function () {
                    var v = $.trim($(this).val());
                    if (!v) { setError($f, 'nameEn', '请输入英文名'); return; }
                    if (!RE_NAME_EN.test(v)) {
                        setError($f, 'nameEn', '英文名以字母开头，仅含字母、数字、下划线（最长 100 位）');
                        return;
                    }
                    checkUnique('nameEn', v, isEdit ? row.id : '').done(function (unique) {
                        setError($f, 'nameEn', unique ? '' : '该英文名已存在，请重新填写');
                    });
                });
                fieldOf($f, 'nameCn').focus();
            },
            onOk: function ($body, close) {
                if (submitting) { return; }
                var $f = $body.find('.emp-form');
                var data = collectForm($f);
                if (!validateForm($f, data)) {
                    UI.message({ type: 'warning', message: '请检查表单填写项' });
                    return;
                }
                submitting = true;
                var $ok = $body.closest('.el-dialog').find('.btn-ok');
                $ok.addClass('is-disabled').prop('disabled', true).text('保存中…');

                function reset() {
                    submitting = false;
                    $ok.removeClass('is-disabled').prop('disabled', false).text('确定');
                }

                $.when(
                    checkUnique('nameCn', data.nameCn, isEdit ? row.id : '', data.enabled),
                    checkUnique('nameEn', data.nameEn, isEdit ? row.id : '')
                ).done(function (cnOk, enOk) {
                    if (!cnOk) {
                        setError($f, 'nameCn', '该中文名已被其它启用状态的角色使用');
                        UI.message({ type: 'error', message: '中文名【' + data.nameCn + '】已被其它启用角色占用' });
                        reset();
                        return;
                    }
                    if (!enOk) {
                        setError($f, 'nameEn', '该英文名已存在，请重新填写');
                        UI.message({ type: 'error', message: '英文名【' + data.nameEn + '】已被占用' });
                        reset();
                        return;
                    }
                    var req = isEdit ? Api.role.update(data) : Api.role.add(data);
                    req.done(function () {
                        close();
                        UI.message({ type: 'success', message: isEdit ? '修改成功' : '新增成功' });
                        if (!isEdit) { state.pageNum = 1; }
                        loadData();
                    }).fail(function (err) {
                        UI.message({ type: 'error', message: err.message || '保存失败' });
                        reset();
                    });
                });
            }
        });
    }

    /* ---------- 事件 ---------- */
    $tbody.on('click', 'tr[data-id]', function () { selectRow($(this)); });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        selectRow($(this));
        var row = rowCache[String($(this).attr('data-id'))];
        if (row) { openForm('edit', row); }
    });

    function doSearch(reset) {
        if (reset) {
            $('#keyword').val('');
            $('#enabledFilter').val('');
            state.keyword = '';
            state.enabled = '';
        } else {
            state.keyword = $.trim($('#keyword').val());
            state.enabled = $('#enabledFilter').val() || '';
        }
        state.pageNum = 1;
        clearSelect();
        saveState();
        loadData();
    }

    $('#enabledFilter').on('change', function () { doSearch(false); });
    $('#btnSearch').on('click', function () { doSearch(false); });
    $('#btnReset').on('click', function () { doSearch(true); });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { doSearch(false); } });

    $('#btnAdd').on('click', function () { openForm('add'); });

    $('#btnEdit').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在列表中选择一个要编辑的角色。' });
            return;
        }
        var row = rowCache[state.selectedId];
        if (!row) { UI.message({ type: 'error', message: '数据已失效，请刷新后重试' }); return; }
        openForm('edit', row);
    });

    $('#btnDelete').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在列表中选择一个要删除的角色。' });
            return;
        }
        var id = state.selectedId, name = state.selectedName;
        UI.confirm({
            title: '删除确认', type: 'warning',
            message: '确定删除角色【' + name + '】吗？删除后不可恢复。',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            UI.loading($wrapper, true, '删除中…');
            Api.role.remove(id).done(function () {
                UI.message({ type: 'success', message: '删除成功' });
                clearSelect();
                var pages = Math.max(1, Math.ceil((state.total - 1) / state.pageSize));
                if (state.pageNum > pages) { state.pageNum = pages; }
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: err.message || '删除失败' });
            }).always(function () {
                UI.loading($wrapper, false);
            });
        });
    });

    $('#btnRefresh').on('click', function () { loadData(); });

    /* ---------- 初始化 ---------- */
    restoreState();
    loadData();
});
