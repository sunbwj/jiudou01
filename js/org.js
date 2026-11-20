/* ==========================================================================
   org.js —— 部门组织架构管理（检索 / 操作引导 / 结果列表 + 分页 + 组织架构图）
   --------------------------------------------------------------------------
   · 数据：/api/org/*（编号 DPT + 4 位流水号由服务端自动生成）
   · 组织架构图：按 parentId 组成多叉树，用嵌套 ul/li + CSS 连线绘制；
     每次新增 / 修改保存后返回本页，列表刷新时会一并重新绘制（动态更新）
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#orgTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var $selTip = $('#selTip');
    var $chart = $('#orgChart');
    var $chartHint = $('#orgChartHint');
    var $tabs = $('#orgTabs');
    var $tabItems = $tabs.find('.el-tabs__item');
    var $tabPanes = $tabs.find('.el-tab-pane');
    var $tabBar = $('#orgTabBar');
    var STATE_KEY = 'org_admin_list_state';
    var TAB_KEY = 'org_admin_active_tab';
    var COLS = 9;

    var state = {
        keyword: '', enabled: '', pageNum: 1, pageSize: 10,
        total: 0, selectedId: null, selectedName: ''
    };
    var pager = null;
    var activeTab = 'list';   // 当前页签：list = 查询结果列表 / chart = 组织架构图
    var rowCache = {};        // 当前页数据（部门ID → 部门对象），供设置负责人等操作取用

    /* ---------- 状态存取（返回列表时保持检索条件与页码） ---------- */
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
            var s = JSON.parse(raw);
            state.keyword = s.keyword || '';
            state.enabled = s.enabled || '';
            state.pageNum = s.pageNum || 1;
            state.pageSize = s.pageSize || 10;
            $('#keyword').val(state.keyword);
            $('#enabled').val(state.enabled);
        } catch (e) { }
    }

    /* ---------- 页签切换（① 查询结果列表 ② 组织架构图） ---------- */
    function saveTab() {
        try { window.sessionStorage.setItem(TAB_KEY, activeTab); } catch (e) { }
    }
    function restoreTab() {
        try {
            var t = window.sessionStorage.getItem(TAB_KEY);
            if (t === 'list' || t === 'chart') { activeTab = t; }
        } catch (e) { }
    }
    function moveTabBar() {
        var $cur = $tabItems.filter('.is-active');
        if (!$cur.length || !$tabBar.length) { return; }
        try {
            var left = $cur.position().left;
            var w = $cur.outerWidth();
            $tabBar.css({ 'width': w + 'px', '-webkit-transform': 'translateX(' + left + 'px)', 'transform': 'translateX(' + left + 'px)' });
        } catch (e) { }
    }
    /**
     * 切换页签。silent=true 时不做页签特有的后续动作（用于初始化还原）
     * 列表页签：显示后重新排布行高 / 重算每页条数（隐藏时容器高度为 0，无法计算）
     * 架构图页签：切过去时重新绘制，保证结构与最新数据一致
     */
    function setTab(name, silent) {
        if (name !== 'list' && name !== 'chart') { name = 'list'; }
        activeTab = name;
        $tabItems.removeClass('is-active').attr('aria-selected', 'false');
        $tabItems.filter('[data-tab="' + name + '"]').addClass('is-active').attr('aria-selected', 'true');
        $tabPanes.removeClass('is-active');
        $tabPanes.filter('[data-pane="' + name + '"]').addClass('is-active');
        moveTabBar();
        saveTab();
        if (silent) { return; }
        if (name === 'list') {
            if (isAutoMode()) {
                var size = calcPageSize();
                if (size && size !== state.pageSize) { state.pageSize = size; loadData(); return; }
            }
            layoutRows();
            syncStickyHead();
        } else {
            drawChart();
        }
    }

    /* ---------- 行渲染 ---------- */
    function rowNo(index) {
        var pageNum = parseInt(state.pageNum, 10) || 1;
        var pageSize = parseInt(state.pageSize, 10) || 10;
        return (pageNum - 1) * pageSize + index + 1;
    }

    /** 负责人单元格：姓名 + 工号；未设置时灰字提示 */
    function managerCellHtml(item) {
        if (!item.managerName) {
            return '<span class="cell-muted">未设置</span>';
        }
        return '<span class="cell-strong">' + UI.escapeHtml(item.managerName) + '</span>' +
            (item.managerCode ? '<span class="cell-sub">' + UI.escapeHtml(item.managerCode) + '</span>' : '');
    }

    function rowHtml(item, index) {
        var selected = state.selectedId === item.id;
        var enabled = !!item.enabled;
        var level = parseInt(item.level, 10) || 1;
        var indent = level > 1 ? '<span class="cell-indent">' + new Array(level).join('　') + '</span>' : '';
        return '' +
            '<tr data-id="' + item.id + '" data-name="' + UI.escapeHtml(item.nameCn) + '"' + (selected ? ' class="current-row"' : '') + '>' +
                '<td class="is-center el-table__index-cell" data-label="序号"><div class="cell cell-index">' + rowNo(index) + '</div></td>' +
                '<td class="is-center el-table__radio-cell" data-label="选择"><div class="cell">' +
                    '<label class="el-radio' + (selected ? ' is-checked' : '') + '">' +
                        '<input class="el-radio__original" type="radio" name="orgRow" value="' + item.id + '"' + (selected ? ' checked' : '') + '>' +
                        '<span class="el-radio__inner"></span>' +
                    '</label>' +
                '</div></td>' +
                '<td data-label="编号"><div class="cell cell-mono">' + UI.escapeHtml(item.code) + '</div></td>' +
                '<td data-label="部门名称"><div class="cell cell-strong">' + indent + UI.escapeHtml(item.nameCn) + '</div></td>' +
                '<td data-label="上级部门"><div class="cell">' + UI.escapeHtml(item.parentName || '—（顶级）') + '</div></td>' +
                '<td data-label="负责人"><div class="cell">' + managerCellHtml(item) + '</div></td>' +
                '<td data-label="职能说明"><div class="cell cell-desc">' + UI.escapeHtml(item.duty || '-') + '</div></td>' +
                '<td class="is-center" data-label="启用"><div class="cell">' +
                    '<span class="el-tag el-tag--small ' + (enabled ? 'el-tag--success' : 'el-tag--info') + '">' + (enabled ? '启用' : '停用') + '</span>' +
                '</div></td>' +
                '<td data-label="创建时间"><div class="cell">' + UI.escapeHtml(item.createTime || '-') + '</div></td>' +
            '</tr>';
    }

    function renderEmpty() {
        $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block"><span class="el-table__empty-text">暂无数据</span></div></td></tr>');
        syncStickyHead();
    }

    function renderTable(list) {
        rowCache = {};
        if (!list || !list.length) { renderEmpty(); return; }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            rowCache[list[i].id] = list[i];
            html += rowHtml(list[i], i);
        }
        $tbody.html(html);
        layoutRows();
        syncStickyHead();
    }

    /* ---------- 行高 / 每页条数自适应屏幕高度 ---------- */
    var DEF_ROW_H = 54, MAX_ROW_H = 64, MIN_PAGE_SIZE = 5, MAX_PAGE_SIZE = 100;
    var autoSize = true;
    var naturalRowH = DEF_ROW_H;

    function isCardMode() { return window.innerWidth <= 768; }
    /* 只有「查询结果列表」页签可见时才做屏高自适应：隐藏的容器高度为 0，算不出每页条数 */
    function isAutoMode() { return autoSize && !isCardMode() && activeTab === 'list'; }
    function bodyAvailHeight() {
        var theadH = $wrapper.find('thead').outerHeight() || 0;
        return ($wrapper.height() || 0) - theadH;
    }
    function calcPageSize() {
        var avail = bodyAvailHeight();
        if (avail <= naturalRowH) { return state.pageSize; }
        var n = Math.floor(avail / naturalRowH);
        if (n < MIN_PAGE_SIZE) { n = MIN_PAGE_SIZE; }
        if (n > MAX_PAGE_SIZE) { n = MAX_PAGE_SIZE; }
        return n;
    }
    function layoutRows() {
        $tbody.find('tr.blank-row').remove();
        if (isCardMode()) { return; }
        var $rows = $tbody.children('tr[data-id]');
        var n = $rows.length;
        if (!n) { return; }
        var avail = bodyAvailHeight();
        if (avail <= 0) { return; }

        $tbody.find('tr > td').css('height', '');
        var naturalH = $rows.first().outerHeight() || DEF_ROW_H;
        naturalRowH = naturalH;

        if (isAutoMode() && naturalH * n > avail) {
            var size = Math.floor(avail / naturalH);
            if (size >= MIN_PAGE_SIZE && size < n) {
                state.pageSize = size;
                loadData();
                return;
            }
        }

        var rowH = Math.floor(avail / n);
        if (rowH < naturalH) { rowH = naturalH; }
        if (rowH > MAX_ROW_H) { rowH = MAX_ROW_H; }
        var rest = avail - rowH * n;

        if (rest > 0 && rest < n) {
            $rows.children('td').css('height', rowH + 'px');
            $rows.slice(0, rest).children('td').css('height', (rowH + 1) + 'px');
            return;
        }
        $rows.children('td').css('height', rowH + 'px');

        var cnt = Math.floor(rest / rowH);
        if (cnt <= 0) { return; }
        if (cnt > 200) { cnt = 200; }
        var rem = rest - cnt * rowH;
        var html = '';
        for (var i = 0; i < cnt; i++) {
            var h = rowH + (i === cnt - 1 ? rem : 0);
            html += '<tr class="blank-row"><td colspan="' + COLS + '" style="height:' + h + 'px"></td></tr>';
        }
        $tbody.append(html);
    }

    /* ---------- 列头固定（不支持 sticky 的浏览器用浮层表头兜底） ---------- */
    var $stickyHead = null;
    function supportsSticky() {
        try {
            var el = document.createElement('div');
            el.style.position = 'sticky';
            if (el.style.position === 'sticky') { return true; }
            if (window.CSS && window.CSS.supports) { return !!window.CSS.supports('position', 'sticky'); }
        } catch (e) { }
        return false;
    }
    function initStickyHead() {
        if (supportsSticky()) { return; }
        try {
            var $table = $wrapper.find('table').first();
            var $clone = $table.clone(false).empty();
            $clone.append($table.find('colgroup').clone(true));
            $clone.append($table.find('thead').clone(true));
            $stickyHead = $('<div class="table-sticky-head"></div>').append($clone).appendTo($wrapper.parent());
            $wrapper.on('scroll', syncStickyHead);
        } catch (e) { $stickyHead = null; }
    }
    function syncStickyHead() {
        if (!$stickyHead) { return; }
        try {
            if (isCardMode()) { $stickyHead.hide(); return; }
            var $table = $wrapper.find('table').first();
            var $src = $table.find('thead th');
            var $dst = $stickyHead.find('thead th');
            if (!$src.length || !$dst.length) { $stickyHead.hide(); return; }
            $stickyHead.css('top', $wrapper.position().top + 'px');
            $stickyHead.find('table').css('width', $table.outerWidth() + 'px');
            for (var i = 0; i < $src.length; i++) {
                $dst.eq(i).css('width', $src.eq(i).outerWidth() + 'px');
            }
            if ($wrapper.scrollTop() > 0) { $stickyHead.show(); } else { $stickyHead.hide(); }
            $stickyHead.scrollLeft($wrapper.scrollLeft());
        } catch (e) { }
    }

    /* ---------- 选中行 ---------- */
    function selectRow($tr) {
        var id = parseInt($tr.data('id'), 10);
        state.selectedId = id;
        state.selectedName = $tr.data('name');
        $tbody.find('tr').removeClass('current-row');
        $tbody.find('.el-radio').removeClass('is-checked');
        $tbody.find('input[name="orgRow"]').prop('checked', false);
        $tr.addClass('current-row');
        $tr.find('input[name="orgRow"]').prop('checked', true);
        $tr.find('.el-radio').addClass('is-checked');
        $selTip.text('【' + state.selectedName + '】').css('color', '#409eff');
    }
    function clearSelect() {
        state.selectedId = null;
        state.selectedName = '';
        $tbody.find('tr').removeClass('current-row');
        $tbody.find('.el-radio').removeClass('is-checked');
        $tbody.find('input[name="orgRow"]').prop('checked', false);
        $selTip.text('未选择任何部门').css('color', '#909399');
    }

    /* ==========================================================================
       组织架构图：按 parentId 递归成树，用嵌套 ul/li + CSS 连线绘制
       节点只展示 部门编号 + 负责人 + 启用状态（不含员工数）
       ========================================================================== */
    function nodeBoxHtml(item) {
        var enabled = !!item.enabled;
        var tip = UI.escapeHtml((item.nameCn || '') + '（' + (item.code || '') + '）'
            + '　负责人 ' + (item.managerName || '未设置')
            + (item.duty ? '\n' + item.duty : ''));
        return '<div class="org-node__box' + (enabled ? '' : ' is-off') + '" data-id="' + item.id + '" title="' + tip + '">' +
            '<div class="org-node__name">' + UI.escapeHtml(item.nameCn || '-') + '</div>' +
            '<div class="org-node__code">' + UI.escapeHtml(item.code || '-') + '</div>' +
            '<div class="org-node__mgr' + (item.managerName ? '' : ' is-empty') + '">' +
                (item.managerName ? '负责人：' + UI.escapeHtml(item.managerName) : '负责人：未设置') +
            '</div>' +
            '<div class="org-node__meta">' +
                '<span class="org-node__tag ' + (enabled ? 'is-on' : 'is-off') + '">' + (enabled ? '启用' : '停用') + '</span>' +
            '</div>' +
        '</div>';
    }

    function buildTree(rows) {
        var byParent = {}, roots = [], i;
        for (i = 0; i < rows.length; i++) {
            var pid = parseInt(rows[i].parentId, 10) || 0;
            if (!byParent[pid]) { byParent[pid] = []; }
            byParent[pid].push(rows[i]);
        }
        for (var key in byParent) {
            if (byParent.hasOwnProperty(key)) {
                byParent[key].sort(function (a, b) {
                    return (parseInt(a.sortNo, 10) || 0) - (parseInt(b.sortNo, 10) || 0) || (a.id - b.id);
                });
            }
        }
        roots = byParent[0] || [];
        // 父记录缺失（数据异常）时，这些记录也作为根展示，避免节点丢失
        var ids = {};
        for (i = 0; i < rows.length; i++) { ids[rows[i].id] = true; }
        for (i = 0; i < rows.length; i++) {
            var p = parseInt(rows[i].parentId, 10) || 0;
            if (p && !ids[p] && roots.indexOf(rows[i]) < 0) { roots.push(rows[i]); }
        }
        return { roots: roots, byParent: byParent };
    }

    function levelHtml(list, byParent) {
        var html = '<ul class="org-chart__level">';
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var kids = byParent[item.id] || [];
            html += '<li class="org-node">' + nodeBoxHtml(item);
            if (kids.length) { html += levelHtml(kids, byParent); }
            html += '</li>';
        }
        return html + '</ul>';
    }

    /** 每次列表刷新都会调用它：新增 / 修改保存后回到本页，架构图即为最新结构 */
    var chartRows = {};      // 部门ID → 部门对象（供双击查看人员使用）

    function drawChart() {
        Api.org.page({ pageNum: 1, pageSize: 200 })
            .done(function (res) {
                var rows = (res && res.list) ? res.list : [];
                chartRows = {};
                for (var k = 0; k < rows.length; k++) { chartRows[rows[k].id] = rows[k]; }
                if (!rows.length) {
                    $chart.html('<div class="org-chart__empty">暂无部门数据，点击「新增」建立第一个部门。</div>');
                    $chartHint.text('共 0 个部门');
                    return;
                }
                var tree = buildTree(rows);
                var top = 0;
                for (var i = 0; i < rows.length; i++) {
                    if (!(parseInt(rows[i].parentId, 10) || 0)) { top++; }
                }
                $chart.html(levelHtml(tree.roots, tree.byParent));
                $chartHint.text('共 ' + rows.length + ' 个部门，' + top + ' 个顶级部门');
                syncChartActive();
            })
            .fail(function (err) {
                var msg = (err && err.message) ? err.message : '服务不可用';
                $chart.html('<div class="org-chart__empty">组织架构图加载失败：' + UI.escapeHtml(msg) + '</div>');
                $chartHint.text('加载失败');
            });
    }

    /** 高亮当前选中的部门节点 */
    function syncChartActive() {
        $chart.find('.org-node__box').removeClass('is-active');
        if (state.selectedId) {
            $chart.find('.org-node__box[data-id="' + state.selectedId + '"]').addClass('is-active');
        }
    }

    /* ---------- 查询 ---------- */
    function loadData() {
        if (isAutoMode()) {
            var size = calcPageSize();
            if (size && size !== state.pageSize) { state.pageSize = size; }
        }
        UI.loading($wrapper, true, '数据加载中…');
        Api.org.page({
            keyword: state.keyword,
            enabled: state.enabled,
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
            if (!state.selectedId) { $selTip.text('未选择任何部门').css('color', '#909399'); }
            saveState();
            drawChart();          // 数据变化后同步重绘组织架构图
        }).fail(function (err) {
            renderEmpty();
            UI.message({ type: 'error', message: err.message || '查询失败' });
        }).always(function () {
            UI.loading($wrapper, false);
        });
    }

    function doSearch(resetPage) {
        state.keyword = $.trim($('#keyword').val());
        state.enabled = $('#enabled').val() || '';
        if (resetPage !== false) { state.pageNum = 1; }
        loadData();
    }

    /* ---------- 分页 ---------- */
    pager = UI.pagination($pagerWrap, {
        total: 0, pageNum: 1, pageSize: state.pageSize,
        onChange: function (pageNum, pageSize) {
            state.pageNum = pageNum;
            if (pageSize && pageSize !== state.pageSize) { autoSize = false; }
            state.pageSize = pageSize;
            loadData();
        }
    });

    /* ---------- 事件绑定 ---------- */
    $('#btnSearch').on('click', function () { doSearch(true); });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { e.preventDefault(); doSearch(true); } });
    $('#enabled').on('change', function () { doSearch(true); });
    $('#btnReset').on('click', function () {
        $('#keyword').val('');
        $('#enabled').val('');
        state.keyword = '';
        state.enabled = '';
        state.pageNum = 1;
        clearSelect();
        loadData();
    });

    $tbody.on('click', 'tr[data-id]', function () { selectRow($(this)); syncChartActive(); });
    $tbody.on('dblclick', 'tr[data-id]', function () { goEdit($(this).data('id')); });

    // 架构图：点击节点选中对应部门（列表中有该行则同步高亮）
    $chart.on('click', '.org-node__box', function () {
        var id = parseInt($(this).attr('data-id'), 10);
        var $tr = $tbody.children('tr[data-id="' + id + '"]');
        if ($tr.length) { selectRow($tr); }
        else {
            state.selectedId = id;
            state.selectedName = $.trim($(this).find('.org-node__name').text());
            $selTip.text('【' + state.selectedName + '】').css('color', '#409eff');
        }
        syncChartActive();
    });
    // 架构图：双击节点查看该部门员工（弹窗 + 关键字检索）
    $chart.on('dblclick', '.org-node__box', function () {
        var id = parseInt($(this).attr('data-id'), 10);
        var dept = chartRows[id] || {
            id: id,
            nameCn: $.trim($(this).find('.org-node__name').text()),
            code: $.trim($(this).find('.org-node__code').text())
        };
        openEmpDialog(dept);
    });
    $tabItems.on('click', function () { setTab($(this).attr('data-tab')); });
    $tabItems.on('keydown', function (e) {
        if (e.keyCode === 13 || e.keyCode === 32) { e.preventDefault(); setTab($(this).attr('data-tab')); }
    });
    $('#btnRefreshChart').on('click', function () { drawChart(); });

    var resizeTimer = null;
    $(window).on('resize', function () {
        if (resizeTimer) { window.clearTimeout(resizeTimer); }
        resizeTimer = window.setTimeout(function () {
            moveTabBar();
            if (!isAutoMode()) { layoutRows(); return; }
            var size = calcPageSize();
            if (size !== state.pageSize) {
                state.pageSize = size;
                loadData();
            } else {
                layoutRows();
            }
            syncStickyHead();
        }, 150);
    });

    // 新增：默认把当前选中的部门作为上级
    $('#btnAdd').on('click', function () {
        saveState();
        AppNav.go('org-form.html?mode=add' + (state.selectedId ? '&parentId=' + state.selectedId : ''));
    });

    $('#btnEdit').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在查询结果列表中选择一个要编辑的部门。' });
            return;
        }
        goEdit(state.selectedId);
    });
    function goEdit(id) {
        saveState();
        AppNav.go('org-form.html?mode=edit&id=' + id);
    }

    $('#btnDelete').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在查询结果列表中选择一个要删除的部门。' });
            return;
        }
        var name = state.selectedName;
        var id = state.selectedId;
        // 前置校验：所选部门下还有「启用状态」的下级部门时，直接禁止删除
        Api.org.enabledChildTip(id, '删除本部门').done(function (tip) {
            if (tip) {
                UI.alert({ title: '无法删除', type: 'warning', message: tip });
                return;
            }
            doDelete(id, name);
        });
    });

    /* ---------- 设置负责人（本页弹窗完成，保存后列表与架构图同步刷新） ---------- */
    $('#btnSetManager').on('click', function () {
        var dept = selectedDept();
        if (!dept) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在查询结果列表或组织架构图中选择一个部门。' });
            return;
        }
        openMgrDialog(dept);
    });

    function doDelete(id, name) {
        UI.confirm({
            title: '删除确认', type: 'warning',
            message: '确定删除部门【' + name + '】吗？若其下还有已停用的下级部门将一并删除，删除后不可恢复。',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            UI.loading($wrapper, true, '删除中…');
            Api.org.remove(id, true).done(function () {
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
    }

    /* ==========================================================================
       人员查看：双击架构图节点 → 弹窗列出该部门员工，支持关键字检索
       ========================================================================== */
    var EMP_STATUS_TAG = { 1: 'el-tag--success', 2: 'el-tag--warning', 0: 'el-tag--info' };

    function empTableHtml(list) {
        if (!list || !list.length) {
            return '<div class="org-emp__empty">该部门及下级部门暂无员工</div>';
        }
        var html = '<table class="org-emp__table"><colgroup>' +
            '<col style="width:92px"><col style="width:92px"><col style="width:110px">' +
            '<col style="width:150px"><col style="width:120px"><col style="width:130px"><col><col style="width:78px"></colgroup>' +
            '<thead><tr><th>工号</th><th>姓名</th><th>岗位</th><th>所属部门</th><th>手机号</th><th>学历 / 职称</th><th>邮箱</th>' +
            '<th class="is-center">状态</th></tr></thead><tbody>';
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            var st = parseInt(it.status, 10);
            if (isNaN(st)) { st = 1; }
            html += '<tr>' +
                '<td class="cell-mono">' + UI.escapeHtml(it.code || '') + '</td>' +
                '<td class="cell-strong">' + UI.escapeHtml(it.nameCn || '') + '</td>' +
                '<td>' + UI.escapeHtml(it.jobTitle || '-') + '</td>' +
                '<td>' + UI.escapeHtml(it.deptName || '—（未分配）') + '</td>' +
                '<td class="cell-mono">' + UI.escapeHtml(it.phone || '-') + '</td>' +
                '<td class="cell-desc">' + UI.escapeHtml(it.archiveText || '-') + '</td>' +
                '<td class="cell-desc">' + UI.escapeHtml(it.email || '-') + '</td>' +
                '<td class="is-center"><span class="el-tag el-tag--small ' + (EMP_STATUS_TAG[st] || 'el-tag--info') + '">' +
                    UI.escapeHtml(it.statusText || '') + '</span></td>' +
            '</tr>';
        }
        return html + '</tbody></table>';
    }

    /** 弹窗：某部门的员工列表（关键字检索只在当前部门内生效） */
    function openEmpDialog(dept) {
        var content = '' +
            '<div class="org-emp">' +
                '<div class="org-emp__head">' +
                    '<span class="org-emp__dept">' + UI.escapeHtml(dept.nameCn || '') + '</span>' +
                    '<span class="org-emp__code">' + UI.escapeHtml(dept.code || '') + '</span>' +
                    '<span class="org-emp__scope">含下级部门</span>' +
                    '<span class="org-emp__count" id="orgEmpCount">加载中…</span>' +
                '</div>' +
                '<div class="org-emp__search">' +
                    '<div class="el-input"><input class="el-input__inner" type="text" id="orgEmpKeyword" ' +
                        'placeholder="按工号 / 姓名 / 手机号 / 邮箱 / 岗位检索（含下级部门）"></div>' +
                    '<button type="button" class="el-button el-button--primary el-button--small" id="orgEmpSearch">查询</button>' +
                    '<button type="button" class="el-button el-button--small" id="orgEmpReset">重置</button>' +
                '</div>' +
                '<div class="org-emp__body" id="orgEmpBody"></div>' +
            '</div>';

        UI.dialog({
            title: '部门人员（含下级） —— ' + (dept.nameCn || ''),
            width: 860,
            content: content,
            onReady: function ($body) {
                var $list = $body.find('#orgEmpBody');
                var $kw = $body.find('#orgEmpKeyword');
                var $count = $body.find('#orgEmpCount');

                function load(keyword) {
                    $list.html('<div class="org-emp__loading">加载中…</div>');
                    Api.emp.page({
                        deptId: dept.id, includeChildren: 1,   // 含下级部门员工
                        keyword: keyword || '',
                        pageNum: 1, pageSize: 200
                    }).done(function (data) {
                        var list = (data && data.list) || [];
                        $count.text('共 ' + ((data && data.total) || 0) + ' 人' +
                            (keyword ? '（关键字：' + keyword + '）' : ''));
                        $list.html(empTableHtml(list));
                    }).fail(function (err) {
                        $count.text('加载失败');
                        $list.html('<div class="org-emp__empty">' + UI.escapeHtml(err.message || '服务不可用') + '</div>');
                    });
                }

                $body.find('#orgEmpSearch').on('click', function () { load($.trim($kw.val())); });
                $body.find('#orgEmpReset').on('click', function () { $kw.val(''); load(''); });
                $kw.on('keydown', function (e) {
                    if (e.keyCode === 13) { e.preventDefault(); load($.trim($kw.val())); }
                });
                load('');
                try { $kw.focus(); } catch (e) { }
            }
        });
    }

    /* ==========================================================================
       部门负责人设置（dptmgrset：一个部门只能一个负责人）
       在 org.html 本页完成：选中部门 → 弹窗选人 → 保存后列表与组织架构图同步刷新
       ========================================================================== */
    var MGR_STATUS_TAG = { 1: 'el-tag--success', 2: 'el-tag--warning', 0: 'el-tag--info' };
    var MGR_STATUS_TEXT = { 1: '在职', 2: '试用', 0: '离职' };

    /** 当前选中的部门对象（优先取本页缓存，缺失时用架构图缓存兜底） */
    function selectedDept() {
        if (!state.selectedId) { return null; }
        return rowCache[state.selectedId] || chartRows[state.selectedId] || null;
    }

    /** 打开负责人选人弹窗 */
    function openMgrDialog(dept) {
        var content = '' +
            '<div class="emp-pick">' +
                '<div class="emp-pick__current">部门：<b>' + UI.escapeHtml(dept.nameCn || '') + '</b>' +
                    '（' + UI.escapeHtml(dept.code || '') + '）　当前负责人：<b>' +
                    (dept.managerName ? UI.escapeHtml(dept.managerName) : '未设置') + '</b></div>' +
                '<div class="emp-pick__search">' +
                    '<div class="el-input"><input class="el-input__inner" type="text" id="pickKeyword" ' +
                        'placeholder="按工号 / 姓名 / 岗位 / 手机号检索"></div>' +
                    '<label class="emp-pick__only"><input type="checkbox" id="pickOnlyDept" checked> 只显示本部门员工</label>' +
                    '<button type="button" class="el-button el-button--primary el-button--small" id="pickSearch" style="margin-left:8px">查询</button>' +
                '</div>' +
                '<div class="emp-pick__list" id="pickList"></div>' +
                '<div class="emp-pick__foot" id="pickFoot">选中一名员工作为该部门负责人（一个部门只能有一位）</div>' +
            '</div>';

        var pickedId = dept.managerId || 0;

        UI.dialog({
            title: '设置负责人 —— ' + (dept.nameCn || ''),
            width: 760,
            content: content,
            onReady: function ($body) {
                var $list = $body.find('#pickList');
                var $kw = $body.find('#pickKeyword');
                var $only = $body.find('#pickOnlyDept');
                var $foot = $body.find('#pickFoot');

                function rowsHtml(list, selfId) {
                    if (!list.length) { return '<div class="emp-pick__empty">没有符合条件的员工</div>'; }
                    var html = '<table class="emp-pick__table"><colgroup>' +
                        '<col style="width:80px"><col style="width:96px"><col style="width:110px">' +
                        '<col style="width:140px"><col><col style="width:78px"></colgroup>' +
                        '<thead><tr><th>工号</th><th>姓名</th><th>岗位</th><th>所属部门</th><th>邮箱</th>' +
                        '<th class="is-center">状态</th></tr></thead><tbody>';
                    for (var i = 0; i < list.length; i++) {
                        var it = list[i];
                        var st = parseInt(it.status, 10);
                        if (isNaN(st)) { st = 1; }
                        html += '<tr data-emp-id="' + it.id + '"' + (it.id === selfId ? ' class="is-selected"' : '') + '>' +
                            '<td class="cell-mono">' + UI.escapeHtml(it.code || '') + '</td>' +
                            '<td class="cell-strong">' + UI.escapeHtml(it.nameCn || '') + '</td>' +
                            '<td>' + UI.escapeHtml(it.jobTitle || '-') + '</td>' +
                            '<td>' + UI.escapeHtml(it.deptName || '—（未分配）') + '</td>' +
                            '<td class="cell-desc">' + UI.escapeHtml(it.email || '-') + '</td>' +
                            '<td class="is-center"><span class="el-tag el-tag--small ' +
                                (MGR_STATUS_TAG[st] || 'el-tag--info') + '">' +
                                (it.statusText || MGR_STATUS_TEXT[st] || '-') + '</span></td>' +
                        '</tr>';
                    }
                    return html + '</tbody></table>';
                }

                function load() {
                    $list.html('<div class="emp-pick__loading">加载中…</div>');
                    var params = { keyword: $.trim($kw.val()), pageNum: 1, pageSize: 200 };
                    if ($only.prop('checked')) { params.deptId = dept.id; }
                    Api.emp.page(params).done(function (data) {
                        var list = (data && data.list) || [];
                        $list.html(rowsHtml(list, pickedId));
                        $foot.text('共 ' + ((data && data.total) || 0) + ' 名候选员工，点击一行即选中');
                    }).fail(function (err) {
                        $list.html('<div class="emp-pick__empty">' + UI.escapeHtml(err.message || '加载失败') + '</div>');
                    });
                }

                $list.on('click', 'tr[data-emp-id]', function () {
                    $list.find('tr').removeClass('is-selected');
                    $(this).addClass('is-selected');
                    pickedId = parseInt($(this).attr('data-emp-id'), 10) || 0;
                    $foot.text('已选中：' + $.trim($(this).find('td').eq(1).text()) +
                        '（工号 ' + $.trim($(this).find('td').eq(0).text()) + '）');
                });
                $body.find('#pickSearch').on('click', load);
                $kw.on('keydown', function (e) { if (e.keyCode === 13) { e.preventDefault(); load(); } });
                $only.on('change', load);
                // 已设置负责人时，弹窗底部提供「清除负责人」入口（不必再占工具栏按钮）
                if (dept.managerName) {
                    var $footer = $body.closest('.el-dialog').find('.el-dialog__footer');
                    $footer.prepend('<button type="button" class="el-button el-button--danger el-button--small btn-clear-mgr" ' +
                        'style="float:left">清除负责人</button>');
                    $footer.find('.btn-clear-mgr').on('click', function () {
                        var dz = $body.closest('.el-overlay');
                        dz.remove();
                        clearMgr(dept);
                    });
                }
                load();
            },
            onOk: function ($body, close) {
                if (!pickedId) {
                    UI.message({ type: 'warning', message: '请先选择一名员工作为负责人' });
                    return;
                }
                var $ok = $body.closest('.el-dialog').find('.btn-ok');
                $ok.addClass('is-disabled').prop('disabled', true).text('保存中…');
                Api.dptMgr.set({ deptId: dept.id, empId: pickedId, remark: '' })
                    .done(function () {
                        close();
                        UI.message({ type: 'success', message: '负责人设置成功' });
                        loadData();          // 重新查询列表 → 成功后自动重绘组织架构图
                    })
                    .fail(function (err) {
                        UI.message({ type: 'error', message: err.message || '设置失败' });
                        $ok.removeClass('is-disabled').prop('disabled', false).text('确定');
                    });
            }
        });
    }

    /** 清除所选部门的负责人 */
    function clearMgr(dept) {
        UI.confirm({
            title: '清除确认', type: 'warning',
            message: '确定清除部门【' + dept.nameCn + '】的负责人【' + (dept.managerName || '') + '】吗？',
            confirmText: '确定清除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            UI.loading($wrapper, true, '处理中…');
            Api.dptMgr.remove(dept.id).done(function () {
                UI.message({ type: 'success', message: '已清除负责人' });
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: err.message || '清除失败' });
            }).always(function () {
                UI.loading($wrapper, false);
            });
        });
    }

    /* ---------- 初始化 ---------- */
    restoreState();
    restoreTab();
    setTab(activeTab, true);   // 还原上次停留的页签（默认「查询结果列表」）
    initStickyHead();
    loadData();
});
