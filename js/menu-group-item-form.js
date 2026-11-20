/* ==========================================================================
   menu-group-item-form.js —— 菜单组项目新增 / 编辑
   模式：?mode=add&groupId=xx        ?mode=edit&id=xx&groupId=xx
   页面元素：当前所选菜单组 + 菜单项目选择列表（可多选，含显示序号列，仅整型）
   保存语义：
     · 新增 add    —— 批量追加（已存在的菜单项只更新显示序号）
     · 编辑 update —— 按本次勾选结果全量同步（取消勾选的会被移除）
   ========================================================================== */
jQuery(function ($) {
    var mode = (UI.param('mode') || 'add').toLowerCase();
    var editId = parseInt(UI.param('id'), 10) || 0;
    var groupId = parseInt(UI.param('groupId'), 10) || 0;
    var isEdit = (mode === 'edit' && (editId > 0 || groupId > 0));

    var itemList = [];      // 可选择的菜单项（仅启用状态）
    var picked = {};        // itemId -> {checked, sortNo}
    var submitting = false;

    /* ---------- 标题 ---------- */
    function initTitle() {
        if (isEdit) {
            AppCrumb.setAction('编辑菜单组项目');
            $('#pageTitle').text('编辑菜单组项目');
            $('#modeNote').text('已自动载入该菜单组下已配置的菜单项；保存时以勾选结果为准，取消勾选的菜单项将被移除。');
        }
    }

    /* ---------- 错误提示 ---------- */
    function setError(msg) {
        var $item = $('#groupItemForm').find('[data-field="items"]');
        $item.find('.el-form-item__error').remove();
        if (msg) {
            $item.addClass('is-error');
            $item.find('.el-form-item__content').append('<div class="el-form-item__error">' + UI.escapeHtml(msg) + '</div>');
        } else {
            $item.removeClass('is-error');
        }
    }

    /* ---------- 菜单项选择列表 ---------- */
    function nextSort() {
        var max = 0;
        for (var key in picked) {
            if (!picked.hasOwnProperty(key)) { continue; }
            var v = parseInt(picked[key].sortNo, 10);
            if (!isNaN(v) && v > max) { max = v; }
        }
        return max + 1;
    }

    function rowHtml(m) {
        var p = picked[m.id] || { checked: false, sortNo: '' };
        var sortVal = (p.sortNo === '' || p.sortNo === null || p.sortNo === undefined) ? '' : p.sortNo;
        return '' +
            '<tr data-id="' + m.id + '" data-code="' + UI.escapeHtml(m.code) + '" data-cn="' + UI.escapeHtml(m.nameCn) + '" data-en="' + UI.escapeHtml(m.nameEn) + '">' +
                '<td class="is-center" data-label="选择"><div class="cell">' +
                    '<label class="el-checkbox' + (p.checked ? ' is-checked' : '') + '">' +
                        '<input class="el-checkbox__original" type="checkbox"' + (p.checked ? ' checked' : '') + '>' +
                        '<span class="el-checkbox__inner"></span>' +
                    '</label>' +
                '</div></td>' +
                '<td class="is-center" data-label="显示序号"><div class="cell">' +
                    '<input class="el-input__inner pick-sort" type="text" inputmode="numeric" maxlength="4" value="' + UI.escapeHtml(String(sortVal)) + '" placeholder="0">' +
                '</div></td>' +
                '<td data-label="菜单项编号"><div class="cell"><span class="cell-mono">' + UI.escapeHtml(m.code) + '</span></div></td>' +
                '<td data-label="菜单项中文名"><div class="cell"><span class="cell-strong">' + UI.escapeHtml(m.nameCn) + '</span></div></td>' +
                '<td data-label="菜单项英文名"><div class="cell"><span class="cell-mono">' + UI.escapeHtml(m.nameEn) + '</span></div></td>' +
                '<td data-label="功能页面路径"><div class="cell"><span class="cell-link">' + UI.escapeHtml(m.path || '-') + '</span></div></td>' +
            '</tr>';
    }

    function renderRows() {
        var kw = $.trim($('#itemFilter').val()).toLowerCase();
        var html = '';
        var shown = 0;
        for (var i = 0; i < itemList.length; i++) {
            var m = itemList[i];
            if (kw && (String(m.code) + ' ' + String(m.nameCn) + ' ' + String(m.nameEn)).toLowerCase().indexOf(kw) < 0) { continue; }
            html += rowHtml(m);
            shown++;
        }
        if (!shown) {
            html = '<tr class="empty-row"><td colspan="6"><div class="el-table__empty-block"><span class="el-table__empty-text">暂无可选菜单项</span></div></td></tr>';
        }
        $('#pickTbody').html(html);
        renderCount();
    }

    function renderCount() {
        var n = 0;
        for (var key in picked) {
            if (picked.hasOwnProperty(key) && picked[key].checked) { n++; }
        }
        $('#pickCount').text(n);
    }

    /* ---------- 数据加载 ---------- */
    function loadGroup() {
        return Api.group.detail(groupId).done(function (g) {
            $('#groupName').text(g.nameCn || '—');
            $('#groupCode').text(g.code ? '（' + g.code + '）' : '');
        });
    }

    function loadItems() {
        return Api.menu.page({ enabled: 1, pageSize: 200 }).done(function (res) {
            itemList = res.list || [];
        });
    }

    /* 编辑：载入该菜单组已配置的菜单项（勾选 + 回填显示序号） */
    function loadConfig() {
        return Api.groupItem.page({ groupId: groupId, pageSize: 200 }).done(function (res) {
            var list = res.list || [];
            for (var i = 0; i < list.length; i++) {
                picked[list[i].itemId] = { checked: true, sortNo: parseInt(list[i].sortNo, 10) || 0 };
            }
        });
    }

    function boot() {
        UI.loading($('#groupItemForm').parent(), true, '加载中…');
        $.when(loadGroup(), loadItems())
            .done(function () {
                var ready = isEdit ? loadConfig() : null;
                if (ready) {
                    ready.done(function () { renderRows(); })
                        .fail(function (err) {
                            UI.message({ type: 'error', message: err.message || '已配置信息加载失败' });
                            renderRows();
                        });
                } else {
                    renderRows();
                }
            })
            .fail(function (err) {
                UI.alert({ title: '加载失败', type: 'error', message: err.message || '数据加载失败', buttonText: '返回列表' })
                    .done(function () { AppNav.go('menu-group-item.html'); });
            })
            .always(function () { UI.loading($('#groupItemForm').parent(), false); });
    }

    /* ---------- 校验与提交 ---------- */
    function collect() {
        var out = [];
        for (var key in picked) {
            if (!picked.hasOwnProperty(key) || !picked[key].checked) { continue; }
            out.push({ itemId: parseInt(key, 10), sortNo: picked[key].sortNo });
        }
        out.sort(function (a, b) { return a.itemId - b.itemId; });
        return out;
    }

    function validate(list) {
        setError('');
        if (!list.length) {
            setError('请至少勾选一个菜单项');
            return false;
        }
        for (var i = 0; i < list.length; i++) {
            var v = String(list[i].sortNo === '' ? '' : list[i].sortNo);
            if (!/^\d{1,4}$/.test(v)) {
                setError('显示序号必须是 0-9999 之间的整数');
                return false;
            }
            if (parseInt(v, 10) > 9999) {
                setError('显示序号必须是 0-9999 之间的整数');
                return false;
            }
        }
        return true;
    }

    function submit() {
        if (submitting) { return; }
        var list = collect();
        if (!validate(list)) {
            UI.message({ type: 'warning', message: '请检查菜单项目填写项' });
            return;
        }
        var payload = { groupId: groupId, items: [] };
        for (var i = 0; i < list.length; i++) {
            payload.items.push({ itemId: list[i].itemId, sortNo: parseInt(list[i].sortNo, 10) });
        }
        submitting = true;
        $('#btnSave').addClass('is-disabled').prop('disabled', true).text('保存中…');
        UI.loading($('#groupItemForm').parent(), true, '提交中…');

        var req = isEdit ? Api.groupItem.update(payload) : Api.groupItem.add(payload);
        req.done(function (res) {
            var tip = isEdit
                ? ('保存成功（新增 ' + res.added + ' 项，更新 ' + res.updated + ' 项，移除 ' + res.removed + ' 项）')
                : ('保存成功（新增 ' + res.added + ' 项，更新 ' + res.updated + ' 项）');
            UI.message({ type: 'success', message: tip });
            AppNav.reloadNav();              // 绑定关系变化后重载左侧导航：组内菜单项按显示序号升序
            AppNav.go('menu-group-item.html', 700);
        }).fail(function (err) {
            UI.message({ type: 'error', message: err.message || '保存失败' });
            resetBtn();
        });
    }
    function resetBtn() {
        submitting = false;
        $('#btnSave').removeClass('is-disabled').prop('disabled', false).text('保存');
        UI.loading($('#groupItemForm').parent(), false);
    }

    /* ---------- 事件 ---------- */
    // 勾选：勾选时若未填序号，自动顺延一个
    $('#pickTbody').on('change', '.el-checkbox__original', function () {
        var $tr = $(this).closest('tr');
        var id = parseInt($tr.data('id'), 10);
        var on = $(this).prop('checked');
        if (!picked[id]) { picked[id] = { checked: false, sortNo: '' }; }
        picked[id].checked = on;
        if (on && String(picked[id].sortNo) === '') {
            picked[id].sortNo = nextSort();
            $tr.find('.pick-sort').val(picked[id].sortNo);
        }
        $(this).closest('.el-checkbox').toggleClass('is-checked', on);
        renderCount();
        setError('');
    });

    // 显示序号：仅允许整型
    $('#pickTbody').on('input', '.pick-sort', function () {
        var $tr = $(this).closest('tr');
        var id = parseInt($tr.data('id'), 10);
        var v = $(this).val().replace(/\D/g, '').replace(/^0+(?=\d)/g, '');
        if (v.length > 4) { v = v.substring(0, 4); }
        $(this).val(v);
        if (!picked[id]) { picked[id] = { checked: false, sortNo: '' }; }
        picked[id].sortNo = v;
        if (v !== '' && !picked[id].checked) {          // 填了序号即视为勾选
            picked[id].checked = true;
            $tr.find('.el-checkbox__original').prop('checked', true);
            $tr.find('.el-checkbox').addClass('is-checked');
            renderCount();
        }
    });

    // 过滤 / 全选 / 清空
    $('#itemFilter').on('input', renderRows);
    $('#itemFilter').on('keydown', function (e) { if (e.keyCode === 13) { e.preventDefault(); } });
    $('#btnCheckAll').on('click', function () {
        var kw = $.trim($('#itemFilter').val()).toLowerCase();
        for (var i = 0; i < itemList.length; i++) {
            var m = itemList[i];
            if (kw && (String(m.code) + ' ' + String(m.nameCn) + ' ' + String(m.nameEn)).toLowerCase().indexOf(kw) < 0) { continue; }
            if (!picked[m.id]) { picked[m.id] = { checked: false, sortNo: '' }; }
            if (!picked[m.id].checked) {
                picked[m.id].checked = true;
                if (String(picked[m.id].sortNo) === '') { picked[m.id].sortNo = nextSort(); }
            }
        }
        renderRows();
        setError('');
    });
    $('#btnClearAll').on('click', function () {
        var kw = $.trim($('#itemFilter').val()).toLowerCase();
        for (var i = 0; i < itemList.length; i++) {
            var m = itemList[i];
            if (kw && (String(m.code) + ' ' + String(m.nameCn) + ' ' + String(m.nameEn)).toLowerCase().indexOf(kw) < 0) { continue; }
            if (picked[m.id]) { picked[m.id].checked = false; picked[m.id].sortNo = ''; }
        }
        renderRows();
    });

    $('#btnSave').on('click', submit);
    $('#btnBack').on('click', function () {
        AppNav.go('menu-group-item.html');
    });

    /* ---------- 初始化 ---------- */
    initTitle();
    if (!groupId) {
        UI.alert({ title: '操作提示', type: 'warning', message: '缺少菜单组参数，请从菜单组项目管理页面进入。', buttonText: '返回列表' })
            .done(function () { AppNav.go('menu-group-item.html'); });
        return;
    }
    // 编辑时若未带 groupId，先取记录详情拿到所属菜单组
    if (isEdit && editId && !groupId) {
        Api.groupItem.detail(editId).done(function (d) {
            groupId = parseInt(d.groupId, 10) || 0;
            boot();
        }).fail(function (err) {
            UI.alert({ title: '加载失败', type: 'error', message: err.message || '记录不存在', buttonText: '返回列表' })
                .done(function () { AppNav.go('menu-group-item.html'); });
        });
    } else {
        boot();
    }
});
