/* ==========================================================================
   menu-list.js —— 菜单项管理（检索 / 操作引导 / 结果列表 + 分页）
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#menuTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var $selTip = $('#selTip');
    var STATE_KEY = 'menu_admin_list_state';

    var state = {
        keyword: '', enabled: '', pageNum: 1, pageSize: 10,
        total: 0, selectedId: null, selectedName: ''
    };
    var pager = null;

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

    /* ---------- 行渲染 ---------- */
    function iconHtml(name) {
        var icon = Icons.get(name);
        var tone = icon ? icon.tone : 'is-gray';
        return '<span class="icon-cell"><span class="menu-icon ' + tone + '">' +
            Icons.svg(name, 18) + '</span></span>';
    }

    /* 行号：跨页累加，(页码-1) * 每页条数 + 本页序号 */
    function rowNo(index) {
        var pageNum = parseInt(state.pageNum, 10) || 1;
        var pageSize = parseInt(state.pageSize, 10) || 10;
        return (pageNum - 1) * pageSize + index + 1;
    }

    function rowHtml(item, index) {
        var selected = state.selectedId === item.id;
        var enabled = !!item.enabled;
        return '' +
            '<tr data-id="' + item.id + '" data-name="' + UI.escapeHtml(item.nameCn) + '"' + (selected ? ' class="current-row"' : '') + '>' +
                '<td class="is-center el-table__index-cell" data-label="序号"><div class="cell cell-index">' + rowNo(index) + '</div></td>' +
                '<td class="is-center el-table__radio-cell" data-label="选择"><div class="cell">' +
                    '<label class="el-radio' + (selected ? ' is-checked' : '') + '">' +
                        '<input class="el-radio__original" type="radio" name="menuRow" value="' + item.id + '"' + (selected ? ' checked' : '') + '>' +
                        '<span class="el-radio__inner"></span>' +
                    '</label>' +
                '</div></td>' +
                '<td class="is-center" data-label="显示序号"><div class="cell cell-mono">' + (item.sortNo === undefined || item.sortNo === null || item.sortNo === '' ? 0 : item.sortNo) + '</div></td>' +
                '<td data-label="图标"><div class="cell">' + iconHtml(item.icon) + '</div></td>' +
                '<td data-label="编号"><div class="cell cell-mono">' + UI.escapeHtml(item.code) + '</div></td>' +
                '<td data-label="中文名"><div class="cell cell-strong">' + UI.escapeHtml(item.nameCn) + '</div></td>' +
                '<td data-label="英文名"><div class="cell cell-mono">' + UI.escapeHtml(item.nameEn) + '</div></td>' +
                '<td data-label="页面地址"><div class="cell cell-link">' + UI.escapeHtml(item.path || '-') + '</div></td>' +
                '<td data-label="功能说明"><div class="cell cell-desc">' + UI.escapeHtml(item.remark || '-') + '</div></td>' +
                '<td class="is-center" data-label="启用"><div class="cell">' +
                    '<span class="el-tag el-tag--small ' + (enabled ? 'el-tag--success' : 'el-tag--info') + '">' + (enabled ? '启用' : '停用') + '</span>' +
                '</div></td>' +
                '<td data-label="创建时间"><div class="cell">' + UI.escapeHtml(item.createTime || '-') + '</div></td>' +
            '</tr>';
    }

    function renderEmpty() {
        $tbody.html('<tr class="empty-row"><td colspan="11"><div class="el-table__empty-block"><span class="el-table__empty-text">暂无数据</span></div></td></tr>');
        syncStickyHead();
    }

    function renderTable(list) {
        if (!list || !list.length) { renderEmpty(); return; }
        var html = '';
        for (var i = 0; i < list.length; i++) { html += rowHtml(list[i], i); }
        $tbody.html(html);
        layoutRows();
        syncStickyHead();
    }

    /* ---------- 行高 / 每页条数自适应屏幕高度（PC / 平板；手机端卡片模式不启用） ---------- */
    var DEF_ROW_H = 54;     // 自然行高的初始估计（30px 图标 + 上下 padding），渲染后由实测值校准
    var MAX_ROW_H = 64;     // 行高上限：末页数据很少时不至于被拉成横幅
    var MIN_PAGE_SIZE = 5;
    var MAX_PAGE_SIZE = 100;
    var autoSize = true;    // 用户手动指定每页条数后自动关闭
    var naturalRowH = DEF_ROW_H;

    function isCardMode() { return window.innerWidth <= 768; }   // 手机端卡片模式不补空行
    function isAutoMode() { return autoSize && !isCardMode(); }

    /* 表体可用高度 = 表格可视区高度 - 表头高度 */
    function bodyAvailHeight() {
        var theadH = $wrapper.find('thead').outerHeight() || 0;
        return ($wrapper.height() || 0) - theadH;
    }

    /* 按可视高度推算每页条数：条数随窗口高度变化，行高只做几像素的微调。
       基准用上一次实测的自然行高，首屏用估计值，渲染后自动校准 */
    function calcPageSize() {
        var avail = bodyAvailHeight();
        if (avail <= naturalRowH) { return state.pageSize; }
        var n = Math.floor(avail / naturalRowH);
        if (n < MIN_PAGE_SIZE) { n = MIN_PAGE_SIZE; }
        if (n > MAX_PAGE_SIZE) { n = MAX_PAGE_SIZE; }
        return n;
    }

    /* 渲染后：把行高拉到「可用高度 / 行数」，正好铺满；仍有零头时补空行 */
    function layoutRows() {
        $tbody.find('tr.blank-row').remove();
        if (isCardMode()) { return; }
        var $rows = $tbody.children('tr[data-id]');
        var n = $rows.length;
        if (!n) { return; }                                  // 无数据时不处理
        var avail = bodyAvailHeight();
        if (avail <= 0) { return; }

        // 先还原行高，量出单元格的自然高度（行高不能低于它，否则内容会挤）
        $tbody.find('tr > td').css('height', '');
        var naturalH = $rows.first().outerHeight() || DEF_ROW_H;
        naturalRowH = naturalH;                              // 校准基准，供下次估算条数使用

        // 自然高度本身就装不下（图标 / 内容换行等导致行比估计的高）→ 按实测值重算一次条数
        // n 只会变小，重算后必然收敛，不会反复请求
        if (isAutoMode() && naturalH * n > avail) {
            var size = Math.floor(avail / naturalH);
            if (size >= MIN_PAGE_SIZE && size < n) {
                state.pageSize = size;
                loadData();
                return;
            }
        }

        var rowH = Math.floor(avail / n);
        if (rowH < naturalH) { rowH = naturalH; }            // 装不下就保持自然高，表格内部滚动
        if (rowH > MAX_ROW_H) { rowH = MAX_ROW_H; }          // 数据太少也不过度拉伸
        var rest = avail - rowH * n;                         // 铺满后剩下的零头

        if (rest > 0 && rest < n) {
            // 零头不足一行：均摊到前 rest 行各 +1px，肉眼看不出差别，但底部不再留缝
            $rows.children('td').css('height', rowH + 'px');
            $rows.slice(0, rest).children('td').css('height', (rowH + 1) + 'px');
            return;
        }
        $rows.children('td').css('height', rowH + 'px');

        var cnt = Math.floor(rest / rowH);                   // 末页数据少时用空行补齐
        if (cnt <= 0) { return; }
        if (cnt > 200) { cnt = 200; }                        // 兜底，防止异常循环
        var rem = rest - cnt * rowH;                         // 补完空行后的零头
        var html = '';
        for (var i = 0; i < cnt; i++) {
            var h = rowH + (i === cnt - 1 ? rem : 0);        // 最后一个空行吸收零头
            html += '<tr class="blank-row"><td colspan="11" style="height:' + h + 'px"></td></tr>';
        }
        $tbody.append(html);
    }

    /* ---------- 列头固定：不支持 position:sticky 的浏览器（IE）用浮层表头兜底 ---------- */
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

    /* 现代浏览器走 CSS sticky，这里只为旧浏览器克隆一份表头浮在表格上方 */
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

    /* 同步列宽与横向滚动位置；仅在真正发生纵向滚动时才显示 */
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
        $tbody.find('input[name="menuRow"]').prop('checked', false);
        $tr.addClass('current-row');
        $tr.find('input[name="menuRow"]').prop('checked', true);
        $tr.find('.el-radio').addClass('is-checked');
        $selTip.text('【' + state.selectedName + '】').css('color', '#409eff');
    }
    function clearSelect() {
        state.selectedId = null;
        state.selectedName = '';
        $tbody.find('tr').removeClass('current-row');
        $tbody.find('.el-radio').removeClass('is-checked');
        $tbody.find('input[name="menuRow"]').prop('checked', false);
        $selTip.text('未选择任何菜单项').css('color', '#909399');
    }

    /* ---------- 查询 ---------- */
    function loadData() {
        // 自适应模式：先用当前可视高度定每页条数，再取数，保证一次渲染就正好铺满
        if (isAutoMode()) {
            var size = calcPageSize();
            if (size && size !== state.pageSize) { state.pageSize = size; }
        }
        UI.loading($wrapper, true, '数据加载中…');
        Api.menu.page({
            keyword: state.keyword,
            enabled: state.enabled,
            pageNum: state.pageNum,
            pageSize: state.pageSize
        }).done(function (res) {
            state.total = res.total;
            state.pageNum = res.pageNum;
            renderTable(res.list);
            if (pager) { pager.update(res.total, res.pageNum, res.pageSize); }
            // 校验选中行是否仍存在
            if (state.selectedId) {
                var exist = false;
                for (var i = 0; i < res.list.length; i++) { if (res.list[i].id === state.selectedId) { exist = true; break; } }
                if (!exist) { state.selectedId = null; state.selectedName = ''; }
            }
            if (!state.selectedId) { $selTip.text('未选择任何菜单项').css('color', '#909399'); }
            saveState();
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
            // 用户手动改了每页条数 → 关闭自适应，尊重其选择
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

    // 行点击选中 / 双击编辑
    $tbody.on('click', 'tr[data-id]', function () { selectRow($(this)); });
    $tbody.on('dblclick', 'tr[data-id]', function () { goEdit($(this).data('id')); });

    // 窗口尺寸变化后重算行高 / 每页条数（防抖）
    var resizeTimer = null;
    $(window).on('resize', function () {
        if (resizeTimer) { window.clearTimeout(resizeTimer); }
        resizeTimer = window.setTimeout(function () {
            if (!isAutoMode()) { layoutRows(); return; }
            var size = calcPageSize();
            if (size !== state.pageSize) {
                state.pageSize = size;          // 高度变了，条数要跟着变，否则会滚动
                loadData();
            } else {
                layoutRows();
            }
            syncStickyHead();
        }, 150);
    });

    // 1.2.1 新增
    $('#btnAdd').on('click', function () {
        saveState();
        AppNav.go('menu-form.html?mode=add');
    });

    // 1.2.2 编辑
    $('#btnEdit').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在查询结果列表中选择一条要编辑的菜单项。' });
            return;
        }
        goEdit(state.selectedId);
    });
    function goEdit(id) {
        saveState();
        AppNav.go('menu-form.html?mode=edit&id=' + id);
    }

    // 1.2.3 删除
    $('#btnDelete').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在查询结果列表中选择一条要删除的菜单项。' });
            return;
        }
        var name = state.selectedName;
        var id = state.selectedId;
        UI.confirm({
            title: '删除确认', type: 'warning',
            message: '确定删除菜单项【' + name + '】吗？删除后不可恢复。',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            UI.loading($wrapper, true, '删除中…');
            Api.menu.remove(id).done(function () {
                UI.message({ type: 'success', message: '删除成功' });
                AppNav.reloadNav();          // 菜单项删除后重载左侧导航
                clearSelect();
                // 若当前页已无数据且不是第一页，则回退一页
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
    initStickyHead();
    loadData();
});
