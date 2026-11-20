/* ==========================================================================
   menu-group-item.js —— 菜单组项目管理
   页面结构：左（菜单组检索 + 菜单组列表） / 右（菜单项检索 + 操作引导 + 结果列表）
   联动：选中（单击）或双击树形节点 → 刷新右侧「当前菜单组下的菜单项」
   ========================================================================== */
jQuery(function ($) {
    var $tree = $('#groupTree');
    var $tbody = $('#groupItemTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var $selTip = $('#selTip');
    var STATE_KEY = 'menu_admin_groupitem_state';
    var COL_COUNT = 9;

    var state = {
        groupKeyword: '', itemKeyword: '',
        groupId: 0, groupName: '', groupCode: '',
        pageNum: 1, pageSize: 10, total: 0,
        selectedId: null, selectedName: ''
    };
    var treeData = [];      // 扁平数据（后端已按树形顺序返回，含 parentId / level）
    var expanded = {};      // 节点展开状态
    var pager = null;

    /* ---------- 状态存取（表单返回后仍停留在原菜单组） ---------- */
    function saveState() {
        try {
            window.sessionStorage.setItem(STATE_KEY, JSON.stringify({
                groupKeyword: state.groupKeyword, itemKeyword: state.itemKeyword,
                groupId: state.groupId, groupName: state.groupName, groupCode: state.groupCode,
                pageNum: state.pageNum, pageSize: state.pageSize
            }));
        } catch (e) { }
    }
    function restoreState() {
        try {
            var raw = window.sessionStorage.getItem(STATE_KEY);
            if (!raw) { return; }
            var s = JSON.parse(raw);
            state.groupKeyword = s.groupKeyword || '';
            state.itemKeyword = s.itemKeyword || '';
            state.groupId = parseInt(s.groupId, 10) || 0;
            state.groupName = s.groupName || '';
            state.groupCode = s.groupCode || '';
            state.pageNum = parseInt(s.pageNum, 10) || 1;
            state.pageSize = parseInt(s.pageSize, 10) || 10;
            $('#groupKeyword').val(state.groupKeyword);
            $('#itemKeyword').val(state.itemKeyword);
        } catch (e) { }
    }

    /* =================== 1. 左侧：菜单组列表 =================== */
    function childrenMap() {
        var map = {};
        for (var i = 0; i < treeData.length; i++) {
            var p = parseInt(treeData[i].parentId, 10) || 0;
            if (!map[p]) { map[p] = []; }
            map[p].push(treeData[i]);
        }
        return map;
    }

    function nodeHtml(node, kids) {
        var id = parseInt(node.id, 10);
        var sub = kids[id] || [];
        var isLeaf = !sub.length;
        var isOpen = !isLeaf && !!expanded[id];
        var isCur = state.groupId === id;
        var title = node.nameCn + '（' + node.code + '）';
        var flag = isBindable(node) ? '<i class="el-tree-node__flag is-has">可绑菜单</i>' : '';
        var html =
            '<div class="el-tree-node' + (isOpen ? ' is-expanded' : '') + '" data-id="' + id + '" data-level="' + (parseInt(node.level, 10) || 1) + '">' +
                '<div class="el-tree-node__content' + (isCur ? ' is-current' : '') + '" title="' + UI.escapeHtml(title) + '">' +
                    '<span class="el-tree-node__expand-icon' + (isLeaf ? ' is-leaf' : (isOpen ? ' is-expanded' : '')) + '"></span>' +
                    '<span class="el-tree-node__label">' + UI.escapeHtml(node.nameCn) +
                        '<i class="el-tree-node__code">' + UI.escapeHtml(node.code) + '</i>' +
                    '</span>' +
                    flag +
                '</div>';
        if (isOpen) {
            html += '<div class="el-tree-node__children">';
            for (var i = 0; i < sub.length; i++) { html += nodeHtml(sub[i], kids); }
            html += '</div>';
        }
        html += '</div>';
        return html;
    }

    function renderTree() {
        if (!treeData.length) {
            $tree.html('<div class="el-tree__empty">暂无菜单组数据</div>');
            return;
        }
        var kids = childrenMap();
        var ids = {};
        for (var i = 0; i < treeData.length; i++) { ids[parseInt(treeData[i].id, 10)] = true; }
        var html = '';
        for (i = 0; i < treeData.length; i++) {
            var pid = parseInt(treeData[i].parentId, 10) || 0;
            if (!pid || !ids[pid]) { html += nodeHtml(treeData[i], kids); }   // 父节点被过滤掉时，该节点作为局部根
        }
        $tree.html(html || '<div class="el-tree__empty">暂无菜单组数据</div>');
    }

    function loadTree() {
        UI.loading($tree.parent(), true, '加载中…');
        Api.group.tree({ enabled: 1, keyword: state.groupKeyword })
            .done(function (res) {
                treeData = res.list || [];
                for (var i = 0; i < treeData.length; i++) {
                    expanded[parseInt(treeData[i].id, 10)] = true;   // 默认全部展开
                }
                renderTree();
                // 恢复上次选中的菜单组（若仍在结果中）
                if (state.groupId) {
                    var exist = false;
                    for (i = 0; i < treeData.length; i++) {
                        if (parseInt(treeData[i].id, 10) === state.groupId) { exist = true; break; }
                    }
                    if (!exist) { state.groupId = 0; state.groupName = ''; state.groupCode = ''; }
                    // 恢复的选中项若已不是「可绑菜单」类型（被改为非可绑、或新增了下级），静默取消选中
                    if (state.groupId && !isBindable(findNode(state.groupId))) {
                        state.groupId = 0; state.groupName = ''; state.groupCode = '';
                    }
                }
                renderGroupTip();
                loadData();
            })
            .fail(function (err) {
                UI.message({ type: 'error', message: err.message || '菜单组加载失败' });
                renderGroupTip();
                renderEmpty();
            })
            .always(function () { UI.loading($tree.parent(), false); });
    }

    function toggleNode(id) {
        expanded[id] = !expanded[id];
        renderTree();
    }

    /* 是否「可绑菜单」：库中「可否绑定菜单项」为「是」且该节点是树中叶子节点（无下级菜单组） */
    function isBindable(node) {
        if (!node) { return false; }
        var hasChild = !(node.hasChild === false || node.hasChild === 0 || node.hasChild === '0' || node.hasChild === 'false');
        if (!hasChild) { return false; }
        if (node.leaf === true || node.leaf === 1 || node.leaf === '1') { return true; }
        if (node.leaf === false || node.leaf === 0 || node.leaf === '0') { return false; }
        // 接口未返回 leaf 时兜底：在树数据里查找是否存在下级
        var id = parseInt(node.id, 10);
        for (var i = 0; i < treeData.length; i++) {
            if ((parseInt(treeData[i].parentId, 10) || 0) === id) { return false; }
        }
        return true;
    }

    function findNode(id) {
        for (var i = 0; i < treeData.length; i++) {
            if (parseInt(treeData[i].id, 10) === id) { return treeData[i]; }
        }
        return null;
    }

    function renderGroupTip() {
        if (state.groupId) {
            $('#groupTipName').text(state.groupName);
            $('#groupTipCode').text(state.groupCode ? '（' + state.groupCode + '）' : '');
            $('#groupTip').addClass('is-active');
        } else {
            $('#groupTipName').text('未选择');
            $('#groupTipCode').text('');
            $('#groupTip').removeClass('is-active');
        }
    }

    /* 选中菜单组 → 右侧联动刷新；非可绑菜单项类型 → 提示并清空右侧 */
    function selectGroup(id, silent) {
        var node = findNode(id);
        if (!node) { return false; }
        if (!isBindable(node)) {
            clearGroup(silent ? '' : '本菜单组为非可绑菜单项类型，不可进行菜单项配置操作');
            return false;
        }
        state.groupId = parseInt(node.id, 10);
        state.groupName = node.nameCn;
        state.groupCode = node.code;
        state.pageNum = 1;
        state.selectedId = null;
        state.selectedName = '';
        $tree.find('.el-tree-node__content').removeClass('is-current');
        $tree.find('.el-tree-node[data-id="' + id + '"] > .el-tree-node__content').addClass('is-current');
        renderGroupTip();
        saveState();
        loadData();
        return true;
    }

    /* 清空所选菜单组与右侧列表（msg 非空时同时弹窗提示） */
    function clearGroup(msg) {
        state.groupId = 0;
        state.groupName = '';
        state.groupCode = '';
        state.pageNum = 1;
        state.total = 0;
        state.selectedId = null;
        state.selectedName = '';
        $tree.find('.el-tree-node__content').removeClass('is-current');
        renderGroupTip();
        renderEmpty(msg || '请先在左侧菜单组列表中选择一个菜单组');
        if (pager) { pager.update(0, 1, state.pageSize); }
        if ($selTip) { $selTip.text('未选择任何菜单项').css('color', '#909399'); }
        saveState();
        if (msg) {
            UI.alert({ title: '操作提示', type: 'warning', message: msg });
        }
    }

    /* =================== 2. 右侧：菜单项列表 =================== */
    function rowNo(index) {
        var pageNum = parseInt(state.pageNum, 10) || 1;
        var pageSize = parseInt(state.pageSize, 10) || 10;
        return (pageNum - 1) * pageSize + index + 1;
    }

    function rowHtml(item, index) {
        var selected = state.selectedId === item.id;
        var enabled = !!item.enabled;
        return '' +
            '<tr data-id="' + item.id + '" data-name="' + UI.escapeHtml(item.itemNameCn) + '"' + (selected ? ' class="current-row"' : '') + '>' +
                '<td class="is-center el-table__index-cell" data-label="序号"><div class="cell cell-index">' + rowNo(index) + '</div></td>' +
                '<td class="is-center el-table__radio-cell" data-label="选择"><div class="cell">' +
                    '<label class="el-radio' + (selected ? ' is-checked' : '') + '">' +
                        '<input class="el-radio__original" type="radio" name="groupItemRow" value="' + item.id + '"' + (selected ? ' checked' : '') + '>' +
                        '<span class="el-radio__inner"></span>' +
                    '</label>' +
                '</div></td>' +
                '<td data-label="菜单项编号"><div class="cell cell-mono">' + UI.escapeHtml(item.itemCode) + '</div></td>' +
                '<td data-label="菜单项中文名"><div class="cell cell-strong">' + UI.escapeHtml(item.itemNameCn) + '</div></td>' +
                '<td data-label="菜单项英文名"><div class="cell cell-mono">' + UI.escapeHtml(item.itemNameEn) + '</div></td>' +
                '<td class="is-center" data-label="显示序号"><div class="cell cell-strong">' + (parseInt(item.sortNo, 10) || 0) + '</div></td>' +
                '<td data-label="功能页面路径"><div class="cell cell-link">' + UI.escapeHtml(item.itemPath || '-') + '</div></td>' +
                '<td class="is-center" data-label="启用"><div class="cell">' +
                    '<span class="el-tag el-tag--small ' + (enabled ? 'el-tag--success' : 'el-tag--info') + '">' + (enabled ? '启用' : '停用') + '</span>' +
                '</div></td>' +
                '<td data-label="创建时间"><div class="cell">' + UI.escapeHtml(item.createTime || '-') + '</div></td>' +
            '</tr>';
    }

    function renderEmpty(text) {
        $tbody.html('<tr class="empty-row"><td colspan="' + COL_COUNT + '"><div class="el-table__empty-block"><span class="el-table__empty-text">' +
            (text || '暂无数据') + '</span></div></td></tr>');
    }

    function renderTable(list) {
        if (!list || !list.length) { renderEmpty(); return; }
        var html = '';
        for (var i = 0; i < list.length; i++) { html += rowHtml(list[i], i); }
        $tbody.html(html);
    }

    function loadData() {
        if (!state.groupId) {
            state.total = 0;
            renderEmpty('请先在左侧菜单组列表中选择一个菜单组');
            if (pager) { pager.update(0, 1, state.pageSize); }
            saveState();
            return;
        }
        UI.loading($wrapper, true, '数据加载中…');
        Api.groupItem.page({
            groupId: state.groupId,
            keyword: state.itemKeyword,
            pageNum: state.pageNum,
            pageSize: state.pageSize
        }).done(function (res) {
            state.total = res.total;
            state.pageNum = res.pageNum;
            renderTable(res.list);
            if (pager) { pager.update(res.total, res.pageNum, res.pageSize); }
            if (state.selectedId) {
                var exist = false;
                for (var i = 0; i < res.list.length; i++) { if (res.list[i].id === state.selectedId) { exist = true; break; } }
                if (!exist) { state.selectedId = null; state.selectedName = ''; }
            }
            if (!state.selectedId) { $selTip.text('未选择任何菜单项').css('color', '#909399'); }
            saveState();
        }).fail(function (err) {
            renderEmpty(err.message || '查询失败');
            UI.message({ type: 'error', message: err.message || '查询失败' });
        }).always(function () {
            UI.loading($wrapper, false);
        });
    }

    /* ---------- 选中行 ---------- */
    function selectRow($tr) {
        var id = parseInt($tr.data('id'), 10);
        state.selectedId = id;
        state.selectedName = $tr.data('name');
        $tbody.find('tr').removeClass('current-row');
        $tbody.find('.el-radio').removeClass('is-checked');
        $tbody.find('input[name="groupItemRow"]').prop('checked', false);
        $tr.addClass('current-row');
        $tr.find('input[name="groupItemRow"]').prop('checked', true);
        $tr.find('.el-radio').addClass('is-checked');
        $selTip.text('【' + state.selectedName + '】').css('color', '#409eff');
    }
    function clearSelect() {
        state.selectedId = null;
        state.selectedName = '';
        $tbody.find('tr').removeClass('current-row');
        $tbody.find('.el-radio').removeClass('is-checked');
        $tbody.find('input[name="groupItemRow"]').prop('checked', false);
        $selTip.text('未选择任何菜单项').css('color', '#909399');
    }

    /* =================== 3. 事件 =================== */
    // 左侧：菜单组检索
    $('#btnGroupSearch').on('click', function () {
        state.groupKeyword = $.trim($('#groupKeyword').val());
        loadTree();
    });
    $('#groupKeyword').on('keydown', function (e) { if (e.keyCode === 13) { e.preventDefault(); $('#btnGroupSearch').trigger('click'); } });
    $('#btnGroupReset').on('click', function () {
        $('#groupKeyword').val('');
        state.groupKeyword = '';
        loadTree();
    });

    // 左侧：树形节点 —— 单击选中并联动，双击展开/收起并联动
    $tree.on('click', '.el-tree-node__expand-icon', function (e) {
        e.stopPropagation();
        var id = parseInt($(this).closest('.el-tree-node').data('id'), 10);
        toggleNode(id);
    });
    $tree.on('click', '.el-tree-node__content', function () {
        selectGroup(parseInt($(this).closest('.el-tree-node').data('id'), 10));
    });
    $tree.on('dblclick', '.el-tree-node__content', function () {
        var id = parseInt($(this).closest('.el-tree-node').data('id'), 10);
        if (expanded[id] !== undefined) { toggleNode(id); }
        selectGroup(id, true);      // 前面的单击已提示过，此处不再重复弹窗
    });

    // 右侧：菜单项检索
    function doItemSearch() {
        state.itemKeyword = $.trim($('#itemKeyword').val());
        state.pageNum = 1;
        clearSelect();
        loadData();
    }
    $('#btnItemSearch').on('click', doItemSearch);
    $('#itemKeyword').on('keydown', function (e) { if (e.keyCode === 13) { e.preventDefault(); doItemSearch(); } });
    $('#btnItemReset').on('click', function () {
        $('#itemKeyword').val('');
        state.itemKeyword = '';
        state.pageNum = 1;
        clearSelect();
        loadData();
    });

    // 右侧：行选中 / 双击编辑
    $tbody.on('click', 'tr[data-id]', function () { selectRow($(this)); });
    $tbody.on('dblclick', 'tr[data-id]', function () { goEdit($(this).data('id')); });

    /* ---------- 分页 ---------- */
    pager = UI.pagination($pagerWrap, {
        total: 0, pageNum: 1, pageSize: state.pageSize,
        onChange: function (pageNum, pageSize) {
            state.pageNum = pageNum;
            state.pageSize = pageSize;
            loadData();
        }
    });

    /* ---------- 2.2.1 新增 ---------- */
    $('#btnAdd').on('click', function () {
        if (!state.groupId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在左侧菜单组列表中选择一个菜单组。' });
            return;
        }
        saveState();
        AppNav.go('menu-group-item-form.html?mode=add&groupId=' + state.groupId);
    });

    /* ---------- 2.2.2 编辑 ---------- */
    $('#btnEdit').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在查询结果列表中选择一条要编辑的记录。' });
            return;
        }
        goEdit(state.selectedId);
    });
    function goEdit(id) {
        saveState();
        AppNav.go('menu-group-item-form.html?mode=edit&id=' + id + '&groupId=' + state.groupId);
    }

    /* ---------- 2.2.3 删除 ---------- */
    $('#btnDelete').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在查询结果列表中选择一条要删除的记录。' });
            return;
        }
        var id = state.selectedId;
        var name = state.selectedName;
        UI.confirm({
            title: '删除确认', type: 'warning',
            message: '确定把菜单项【' + name + '】从当前菜单组中移除吗？删除后不可恢复。',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            UI.loading($wrapper, true, '删除中…');
            Api.groupItem.remove(id).done(function () {
                UI.message({ type: 'success', message: '删除成功' });
                AppNav.reloadNav();          // 绑定关系移除后重载左侧导航
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

    /* ---------- 初始化 ---------- */
    restoreState();
    renderGroupTip();
    loadTree();
});
