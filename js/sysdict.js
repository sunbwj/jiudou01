/* ==========================================================================
   sysdict.js —— 系统配置 · 系统字典（左：字典键 / 右：该字典的键值）
   --------------------------------------------------------------------------
   左区：字典键的检索 + 纯图标工具栏（新增 / 编辑 / 启用 / 停用 / 删除 / 刷新）
         + 紧凑两列列表（字典主副行 + 启用状态）+ 分页；
   右区：当前字典的键值检索 + 工具栏 + 列表 + 分页。
   **联动规则**：单击左侧只选中（不动右区）；**双击左侧**把右区切到该字典的键值，
   新增键值默认落到当前字典。左区字典被删除 / 改名时，右区标题与空态同步刷新。
   删除字典由后端级联清理该字典下的键值，并把子字典升为顶级。
   ========================================================================== */
jQuery(function ($) {
    /* ---------------- 左区：系统字典 ---------------- */
    var $sdTbody = $('#sdTbody');
    var $sdWrapper = $('#sdTableWrapper');
    var $sdPager = $('#sdPagerWrap');
    var SD_COLS = 2;
    var SD_STATE = 'sysdict_state';

    /* ---------------- 右区：字典键值 ---------------- */
    var $siTbody = $('#siTbody');
    var $siWrapper = $('#siTableWrapper');
    var $siPager = $('#siPagerWrap');
    var SI_COLS = 7;
    var SI_STATE = 'sysdict_item_state';

    var dict = {
        keyword: '', parentId: '', enabled: '',
        pageNum: 1, pageSize: 10, total: 0,
        rows: {}, selectedId: '', tree: []
    };
    var item = {
        dictId: '', keyword: '', enabled: '',
        pageNum: 1, pageSize: 10, total: 0,
        rows: {}, selectedId: ''
    };

    function esc(text) { return UI.escapeHtml(text == null ? '' : text); }
    function dictRow() { return dict.rows[dict.selectedId] || null; }
    function itemRow() { return item.rows[item.selectedId] || null; }

    /* ==================== 检索条件存取 ==================== */
    function saveDictState() {
        try {
            window.sessionStorage.setItem(SD_STATE, JSON.stringify({
                keyword: dict.keyword, parentId: dict.parentId, enabled: dict.enabled,
                pageNum: dict.pageNum, pageSize: dict.pageSize
            }));
        } catch (e) { }
    }
    function restoreDictState() {
        try {
            var raw = window.sessionStorage.getItem(SD_STATE);
            if (!raw) { return; }
            var s = JSON.parse(raw) || {};
            dict.keyword = s.keyword || '';
            dict.parentId = s.parentId || '';
            dict.enabled = (s.enabled === 0 || s.enabled) ? String(s.enabled) : '';
            dict.pageNum = parseInt(s.pageNum, 10) || 1;
            dict.pageSize = parseInt(s.pageSize, 10) || 10;
            $('#keyword').val(dict.keyword);
        } catch (e) { }
    }
    function syncDictSearch() {
        $('#parentId').val(dict.parentId);
        $('#enabled').val(dict.enabled);
    }

    function saveItemState() {
        try {
            window.sessionStorage.setItem(SI_STATE, JSON.stringify({
                dictId: item.dictId, keyword: item.keyword, enabled: item.enabled,
                pageNum: item.pageNum, pageSize: item.pageSize
            }));
        } catch (e) { }
    }

    /* ==================== 工具栏状态 ==================== */
    function syncDictToolbar() {
        var row = dictRow();
        $('#btnEdit, #btnEnable, #btnDisable, #btnDelete').prop('disabled', !row);
        if (row) {
            $('#btnEnable').prop('disabled', !!row.enabled);
            $('#btnDisable').prop('disabled', !row.enabled);
        }
    }
    function syncItemToolbar() {
        var hasDict = !!item.dictId;
        var row = itemRow();
        $('#btnItemAdd, #btnItemRefresh').prop('disabled', !hasDict);
        $('#btnItemEdit, #btnItemEnable, #btnItemDisable, #btnItemDelete').prop('disabled', !row);
        if (row) {
            $('#btnItemEnable').prop('disabled', !!row.enabled);
            $('#btnItemDisable').prop('disabled', !row.enabled);
        }
    }

    /* ==================== 右区「当前字典」条 ==================== */
    function syncItemBar() {
        var $bar = $('#siCurrentBar');
        if (!item.dictId) {
            $bar.removeClass('is-active');
            $('#siCurrentDict').text('未选择');
            $('#siCurrentMeta').text('请在左侧双击一条字典');
            return;
        }
        var d = dict.rows[item.dictId] || null;
        $bar.addClass('is-active');
        $('#siCurrentDict').text(d ? d.dictNameCn : '（字典不在当前列表）');
        if (!d) {
            $('#siCurrentMeta').text('');
            return;
        }
        $('#siCurrentMeta').html(
            '<span class="sys-name-en">' + esc(d.dictNameEn) + '</span>' +
            '<span class="sysdict-row__count">' + (parseInt(d.itemCount, 10) || 0) + '</span> 条键值' +
            (d.enabled ? '' : ' · 该字典已停用'));
    }

    /* ==================== 字典树下拉 ==================== */
    function fillTree($sel, list, placeholder) {
        var html = placeholder ? '<option value="">' + esc(placeholder) + '</option>' : '';
        for (var i = 0; i < list.length; i++) {
            html += '<option value="' + esc(list[i].id) + '">' + esc(list[i].label) + '</option>';
        }
        $sel.html(html);
    }
    function loadTree() {
        return Api.sysDict.tree().done(function (data) {
            dict.tree = (data && data.list) || [];
            fillTree($('#parentId'), dict.tree, '全部上级');
            syncDictSearch();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '字典树加载失败' });
        });
    }

    /* ==================== 左区：字典列表 ==================== */
    function badge(ok) {
        return ok ? '<span class="el-tag el-tag--success">启用</span>'
            : '<span class="el-tag el-tag--info">停用</span>';
    }
    function renderDicts(data) {
        var list = (data && data.list) || [];
        dict.rows = {};
        $('#sdCount').text(dict.total + '');
        if (!list.length) {
            $sdTbody.html('<tr class="empty-row"><td colspan="' + SD_COLS + '">' +
                '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
                (dict.keyword || dict.parentId || dict.enabled !== ''
                    ? '没有符合条件的系统字典' : '还没有系统字典，点「+」新增一个') +
                '</span></div></td></tr>');
            syncDictToolbar();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            dict.rows[r.id] = r;
            var level = parseInt(r.level, 10) > 1
                ? '<span class="sys-level">L' + esc(r.level) + '</span>' : '';
            var sub = '<span class="sys-name-en">' + esc(r.dictNameEn) + '</span>' +
                '<span class="sysdict-row__count">' + (parseInt(r.itemCount, 10) || 0) + '</span> 条键值' +
                (r.parentName ? ' · 上级：' + esc(r.parentName) : '');
            html += '<tr data-id="' + esc(r.id) + '"' +
                (r.remark ? ' title="' + esc(r.remark) + '"' : '') +
                (String(r.id) === String(dict.selectedId) ? ' class="is-selected"' : '') + '>' +
                '<td><div class="sysdict-row__main"><b>' + esc(r.dictNameCn) + '</b>' + level + '</div>' +
                '<div class="sysdict-row__sub">' + sub + '</div></td>' +
                '<td class="is-center">' + badge(r.enabled) + '</td>' +
                '</tr>';
        }
        $sdTbody.html(html);
        syncDictToolbar();
    }

    function loadDicts() {
        UI.loading($sdWrapper, true, '加载中…');
        return Api.sysDict.page({
            keyword: dict.keyword, parentId: dict.parentId, enabled: dict.enabled,
            pageNum: dict.pageNum, pageSize: dict.pageSize
        }).done(function (data) {
            dict.total = (data && data.total) || 0;
            dict.pageNum = (data && data.pageNum) || 1;
            dict.pageSize = (data && data.pageSize) || 10;
            renderDicts(data);
            UI.pagination($sdPager, {
                total: dict.total, pageNum: dict.pageNum, pageSize: dict.pageSize, sizes: [10, 20, 50],
                onChange: function (num, size) {
                    dict.pageNum = num; dict.pageSize = size;
                    saveDictState();
                    loadDicts();
                }
            });
            syncItemBar();          // 键值数 / 名称可能已变，右区标题同口径刷新
            saveDictState();
        }).fail(function (err) {
            $sdTbody.html('<tr class="empty-row"><td colspan="' + SD_COLS + '">' +
                '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
                esc((err && err.message) || '加载失败') + '</span></div></td></tr>');
        }).always(function () { UI.loading($sdWrapper, false); });
    }

    /* ==================== 字典新增 / 编辑 ==================== */
    function openDictForm(row) {
        var isEdit = !!row;
        var $form = $('#dictFormTpl').children().clone(true);
        UI.dialog({
            title: isEdit ? ('编辑系统字典 —— ' + row.dictNameCn) : '新增系统字典',
            width: 600, content: $form,
            onReady: function ($body) {
                var $f = $body.find('.pj-form');
                var $parent = $f.find('#sdParent');
                fillTree($parent, dict.tree, '（顶级，无上级）');
                if (isEdit) {
                    $f.find('#sdNameCn').val(row.dictNameCn || '');
                    $f.find('#sdNameEn').val(row.dictNameEn || '');
                    $f.find('#sdSort').val(parseInt(row.sortNo, 10) || 0);
                    $f.find('#sdRemark').val(row.remark || '');
                    $f.find('#sdEnabled').val(row.enabled ? '1' : '0');
                    // 编辑时重新取树，排除自身与自己的后代，再回填上级
                    Api.sysDict.tree(row.id).done(function (data) {
                        fillTree($parent, (data && data.list) || [], '（顶级，无上级）');
                        $parent.val(row.parentId || '');
                    });
                    $parent.val(row.parentId || '');
                } else {
                    $f.find('#sdSort').val(0);
                    $f.find('#sdEnabled').val('1');
                }
                $f.find('#sdNameCn').trigger('focus');
            },
            onOk: function ($body, close) {
                var $f = $body.find('.pj-form');
                var cn = $.trim($f.find('#sdNameCn').val());
                var en = $.trim($f.find('#sdNameEn').val());
                if (!cn) { UI.message({ type: 'warning', message: '请填写键中文名' }); return; }
                if (!en) { UI.message({ type: 'warning', message: '请填写键英文名' }); return; }
                var data = {
                    dictNameCn: cn, dictNameEn: en,
                    parentId: $f.find('#sdParent').val() || '',
                    sortNo: parseInt($f.find('#sdSort').val(), 10) || 0,
                    remark: $.trim($f.find('#sdRemark').val()),
                    enabled: $f.find('#sdEnabled').val() === '1' ? 1 : 0
                };
                if (isEdit) { data.id = row.id; }
                var req = isEdit ? Api.sysDict.update(data) : Api.sysDict.add(data);
                req.done(function (saved) {
                    UI.message({ type: 'success', message: isEdit ? '保存成功' : '新增成功' });
                    if (saved && saved.id) { dict.selectedId = saved.id; }
                    close();
                    loadTree();
                    loadDicts();        // 完成后内部会 syncItemBar，右区标题跟着改名
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    /* ==================== 字典启停 / 删除 ==================== */
    function setDictEnabled(on) {
        var row = dictRow();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条系统字典' }); return; }
        if (!!row.enabled === !!on) {
            UI.message({ type: 'info', message: on ? '该字典已经是启用状态' : '该字典已经是停用状态' });
            return;
        }
        Api.sysDict.setEnabled(row.id, on).done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || (on ? '已启用' : '已停用') });
            loadDicts();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
        });
    }
    function removeDict() {
        var row = dictRow();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条系统字典' }); return; }
        var count = parseInt(row.itemCount, 10) || 0;
        UI.confirm({
            title: '删除系统字典', type: 'warning',
            message: '确定删除字典「' + row.dictNameCn + '」吗？' +
                (count ? '\n该字典下有 ' + count + ' 条键值，会一并删除。' : '') +
                (row.parentId ? '' : '\n子字典会升为顶级。'),
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            var wasCurrent = String(item.dictId) === String(row.id);
            Api.sysDict.remove(row.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '已删除' });
                dict.selectedId = '';
                loadTree();
                loadDicts();
                if (wasCurrent) { resetItemArea('该字典已删除，请在左侧双击其它字典'); }
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }

    /* ==================== 右区：键值列表 ==================== */
    function resetItemArea(message) {
        item.dictId = ''; item.keyword = ''; item.enabled = '';
        item.pageNum = 1; item.total = 0; item.rows = {}; item.selectedId = '';
        $('#itemKeyword').val('');
        $('#itemEnabled').val('');
        $('#siCount').text('0');
        $siPager.empty();
        $siTbody.html('<tr class="empty-row"><td colspan="' + SI_COLS + '">' +
            '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
            esc(message || '请在左侧双击一条字典，右侧显示它的键值') + '</span></div></td></tr>');
        syncItemBar();
        syncItemToolbar();
        saveItemState();
    }

    function renderItems(data) {
        var list = (data && data.list) || [];
        item.rows = {};
        $('#siCount').text(item.total + '');
        if (!list.length) {
            $siTbody.html('<tr class="empty-row"><td colspan="' + SI_COLS + '">' +
                '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
                (item.keyword || item.enabled !== ''
                    ? '没有符合条件的字典键值' : '该字典还没有键值，点「+」新增一条') +
                '</span></div></td></tr>');
            syncItemToolbar();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            item.rows[r.id] = r;
            var idx = (item.pageNum - 1) * item.pageSize + i + 1;
            html += '<tr data-id="' + esc(r.id) + '"' +
                (String(r.id) === String(item.selectedId) ? ' class="is-selected"' : '') + '>' +
                '<td class="is-center">' + idx + '</td>' +
                '<td class="is-center"><label class="el-radio">' +
                    '<input class="el-radio__original" type="radio" name="siPick" value="' +
                    esc(r.id) + '"' + (String(r.id) === String(item.selectedId) ? ' checked' : '') + '>' +
                    '<span class="el-radio__inner"></span></label></td>' +
                '<td><span class="sys-name-en">' + esc(r.itemKey || '—') + '</span></td>' +
                '<td><b>' + esc(r.itemValue) + '</b></td>' +
                '<td class="is-center">' + (parseInt(r.sortNo, 10) || 0) + '</td>' +
                '<td><div class="pj-sub" title="' + esc(r.remark) + '">' + esc(r.remark || '—') + '</div></td>' +
                '<td class="is-center">' + badge(r.enabled) + '</td>' +
                '</tr>';
        }
        $siTbody.html(html);
        syncItemToolbar();
    }

    function loadItems() {
        if (!item.dictId) { resetItemArea(); return null; }
        UI.loading($siWrapper, true, '加载中…');
        return Api.sysDictItem.page({
            dictId: item.dictId, keyword: item.keyword, enabled: item.enabled,
            pageNum: item.pageNum, pageSize: item.pageSize
        }).done(function (data) {
            item.total = (data && data.total) || 0;
            item.pageNum = (data && data.pageNum) || 1;
            item.pageSize = (data && data.pageSize) || 10;
            renderItems(data);
            UI.pagination($siPager, {
                total: item.total, pageNum: item.pageNum, pageSize: item.pageSize, sizes: [10, 20, 50],
                onChange: function (num, size) {
                    item.pageNum = num; item.pageSize = size;
                    saveItemState();
                    loadItems();
                }
            });
            saveItemState();
        }).fail(function (err) {
            $siTbody.html('<tr class="empty-row"><td colspan="' + SI_COLS + '">' +
                '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
                esc((err && err.message) || '加载失败') + '</span></div></td></tr>');
        }).always(function () { UI.loading($siWrapper, false); });
    }

    /** 双击左侧字典：把右区切到该字典（换了字典就清空键值检索条件） */
    function activateDict(id) {
        if (!id) { return; }
        if (String(item.dictId) !== String(id)) {
            item.dictId = id;
            item.keyword = ''; item.enabled = '';
            item.pageNum = 1; item.selectedId = '';
            $('#itemKeyword').val('');
            $('#itemEnabled').val('');
        }
        syncItemBar();
        syncItemToolbar();
        loadItems();
    }

    /* ==================== 键值新增 / 编辑 ==================== */
    function openItemForm(row) {
        if (!item.dictId) {
            UI.message({ type: 'warning', message: '请先在左侧双击一条字典' });
            return;
        }
        var isEdit = !!row;
        var $form = $('#itemFormTpl').children().clone(true);
        UI.dialog({
            title: isEdit ? ('编辑字典键值 —— ' + row.itemValue) : '新增字典键值',
            width: 600, content: $form,
            onReady: function ($body) {
                var $f = $body.find('.pj-form');
                fillTree($f.find('#siDict'), dict.tree, '请选择所属字典');
                if (isEdit) {
                    $f.find('#siDict').val(row.dictId || '');
                    $f.find('#siKey').val(row.itemKey || '');
                    $f.find('#siValue').val(row.itemValue || '');
                    $f.find('#siSort').val(parseInt(row.sortNo, 10) || 0);
                    $f.find('#siRemark').val(row.remark || '');
                    $f.find('#siEnabled').val(row.enabled ? '1' : '0');
                } else {
                    $f.find('#siDict').val(item.dictId || '');
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
                var moved = String(dictId) !== String(item.dictId);
                var req = isEdit ? Api.sysDictItem.update(data) : Api.sysDictItem.add(data);
                req.done(function (saved) {
                    if (saved && saved.id) { item.selectedId = saved.id; }
                    if (moved) {
                        UI.message({ type: 'info', message: '已保存到其它字典，当前列表不再显示该条' });
                    } else {
                        UI.message({ type: 'success', message: isEdit ? '保存成功' : '新增成功' });
                    }
                    close();
                    if (!moved) { loadItems(); }
                    loadDicts();          // 键值数变化，左区同步
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    /* ==================== 键值启停 / 删除 ==================== */
    function setItemEnabled(on) {
        var row = itemRow();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条字典键值' }); return; }
        if (!!row.enabled === !!on) {
            UI.message({ type: 'info', message: on ? '该键值已经是启用状态' : '该键值已经是停用状态' });
            return;
        }
        Api.sysDictItem.setEnabled(row.id, on).done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || (on ? '已启用' : '已停用') });
            loadItems();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
        });
    }
    function removeItem() {
        var row = itemRow();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条字典键值' }); return; }
        UI.confirm({
            title: '删除字典键值', type: 'warning',
            message: '确定删除键值「' + row.itemValue + '」吗？',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.sysDictItem.remove(row.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '已删除' });
                item.selectedId = '';
                loadItems();
                loadDicts();              // 键值数变化
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }

    /* ==================== 左侧：选中 / 双击 ==================== */
    function selectDict(id) {
        dict.selectedId = id || '';
        $sdTbody.find('tr').removeClass('is-selected');
        var $tr = $sdTbody.find('tr[data-id="' + id + '"]');
        $tr.addClass('is-selected');
        syncDictToolbar();
    }

    /* ==================== 事件绑定 ==================== */
    // 左区检索
    $('#btnSearch').on('click', function () {
        dict.keyword = $.trim($('#keyword').val());
        dict.parentId = $('#parentId').val();
        dict.enabled = $('#enabled').val();
        dict.pageNum = 1;
        loadDicts();
    });
    $('#btnReset').on('click', function () {
        $('#keyword').val(''); $('#parentId').val(''); $('#enabled').val('');
        dict.keyword = ''; dict.parentId = ''; dict.enabled = ''; dict.pageNum = 1;
        loadDicts();
    });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnSearch').trigger('click'); } });

    // 左区图标工具栏
    $('#btnAdd').on('click', function () { openDictForm(null); });
    $('#btnEdit').on('click', function () { var row = dictRow(); if (row) { openDictForm(row); } });
    $('#btnEnable').on('click', function () { setDictEnabled(true); });
    $('#btnDisable').on('click', function () { setDictEnabled(false); });
    $('#btnDelete').on('click', removeDict);
    $('#btnRefresh').on('click', function () { loadTree(); loadDicts(); });

    $sdTbody.on('click', 'tr[data-id]', function () { selectDict($(this).attr('data-id')); });
    $sdTbody.on('dblclick', 'tr[data-id]', function () {
        var id = $(this).attr('data-id');
        selectDict(id);
        activateDict(id);            // 双击 = 把右区切到该字典的键值
    });

    // 右区检索
    $('#btnItemSearch').on('click', function () {
        item.keyword = $.trim($('#itemKeyword').val());
        item.enabled = $('#itemEnabled').val();
        item.pageNum = 1;
        loadItems();
    });
    $('#btnItemReset').on('click', function () {
        $('#itemKeyword').val(''); $('#itemEnabled').val('');
        item.keyword = ''; item.enabled = ''; item.pageNum = 1;
        loadItems();
    });
    $('#itemKeyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnItemSearch').trigger('click'); } });

    // 右区图标工具栏
    $('#btnItemAdd').on('click', function () { openItemForm(null); });
    $('#btnItemEdit').on('click', function () { var row = itemRow(); if (row) { openItemForm(row); } });
    $('#btnItemEnable').on('click', function () { setItemEnabled(true); });
    $('#btnItemDisable').on('click', function () { setItemEnabled(false); });
    $('#btnItemDelete').on('click', removeItem);
    $('#btnItemRefresh').on('click', function () { loadItems(); loadDicts(); });

    $siTbody.on('click', 'tr[data-id]', function () {
        item.selectedId = $(this).attr('data-id');
        $siTbody.find('tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        $siTbody.find('input[name=siPick]').prop('checked', false);
        $(this).find('input[name=siPick]').prop('checked', true);
        syncItemToolbar();
    });
    $siTbody.on('dblclick', 'tr[data-id]', function () {
        item.selectedId = $(this).attr('data-id');
        openItemForm(itemRow());
    });

    /* ==================== 首屏 ==================== */
    restoreDictState();
    syncDictSearch();
    syncDictToolbar();          // 未选中字典：编辑 / 启停 / 删除先禁用
    resetItemArea();            // 右区先给出「请在左侧双击字典」的空态
    loadTree();                 // 字典树与列表并行，互不阻塞
    loadDicts();
});
