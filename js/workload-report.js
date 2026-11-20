/* ==========================================================================
   workload-report.js —— 项目中心 · 员工工作量统计
   --------------------------------------------------------------------------
   · 数据源 Api.workload.stats()：按「派单时间」区间聚合每个责任人的接单数 /
     已完成 / 处理中 / 待处理 / 逾期 / 完成率 / 按期率 / 平均耗时，默认接单数降序；
   · 钻取：点行（或「明细」）→ Api.workload.details() 拉该员工区间内工单，弹窗里
     分页展示，可再跳到「计划工单」（workplan-orders.html?planId=）或
     「工作计划设计器」（workplan-design.html?id=&taskId=）定位具体任务；
   · 导出：/api/workload/export 直接返回 xlsx（汇总 + 明细两个页签），走 window.open；
   · 统计口径全部在后端（WorkloadService），页面只负责展示与筛选，避免两边口径不一致。
   ========================================================================== */
jQuery(function ($) {
    'use strict';

    var SIZE_KEY = 'menu_admin_workload_size_v1';
    var COLS = 11;
    var SORT_NAMES = {
        orderCount: '接单数', doneCount: '已完成', doingCount: '处理中', todoCount: '待处理',
        overdueCount: '逾期', doneRate: '完成率', avgDays: '平均耗时', lastDispatch: '最近派单'
    };

    var state = {
        startDate: '', endDate: '', projectId: '', keyword: '', scope: '',
        sortBy: 'orderCount', sortOrder: 'desc',
        pageNum: 1, pageSize: 10, total: 0,
        list: [], summary: {}, generatedAt: '', quick: 'month'
    };

    var $tbody = $('#wlTbody');
    var $pager = $('#wlPager');
    var $card = $('.table-card');

    /* ---------------- 小工具 ---------------- */
    function p2(n) { return ('0' + n).slice(-2); }
    function fmtDate(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
    function esc(t) { return UI.escapeHtml(t == null ? '' : t); }
    function qs(name) {
        var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search || '');
        return m ? decodeURIComponent(m[1]) : '';
    }
    function token() {
        return (window.AppAuth && typeof AppAuth.token === 'function') ? (AppAuth.token() || '') : '';
    }
    function go(url) {
        if (window.AppFrame && typeof window.AppFrame.navigate === 'function') { window.AppFrame.navigate(url); }
        else { window.location.href = url; }
    }
    function nowText() {
        var d = new Date();
        return fmtDate(d) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
    }

    /* ---------------- 时间快捷区间 ----------------
       周一为一周第一天（跟「工作计划」的周末跳过口径一致）；本季按自然季度。 */
    function quickRange(key) {
        var now = new Date(), y = now.getFullYear(), m = now.getMonth(), start, end;
        if (key === 'week') {
            var wd = now.getDay() || 7;
            start = new Date(y, m, now.getDate() - wd + 1);
            end = new Date(y, m, now.getDate() - wd + 7);
            if (end > now) { end = now; }
        } else if (key === 'lastMonth') {
            start = new Date(y, m - 1, 1);
            end = new Date(y, m, 0);
        } else if (key === 'quarter') {
            start = new Date(y, Math.floor(m / 3) * 3, 1);
            end = now;
        } else if (key === 'year') {
            start = new Date(y, 0, 1);
            end = now;
        } else {                                  // month（默认）
            start = new Date(y, m, 1);
            end = now;
        }
        return { startDate: fmtDate(start), endDate: fmtDate(end) };
    }

    function syncQuickButtons() {
        $('#wlQuick .wl-quick__btn').each(function () {
            $(this).toggleClass('is-active', $(this).data('quick') === state.quick);
        });
    }

    function setRange(start, end, quickKey) {
        state.startDate = start;
        state.endDate = end;
        state.quick = quickKey || '';
        $('#wlStart').val(start);
        $('#wlEnd').val(end);
        syncQuickButtons();
    }

    /* ---------------- 下拉 / 指标 ---------------- */
    function fillProjects(projects) {
        var $sel = $('#wlProject'), cur = state.projectId, html = '<option value="">全部项目</option>', i;
        for (i = 0; i < projects.length; i++) {
            html += '<option value="' + esc(projects[i].id) + '">' +
                esc(projects[i].name || projects[i].code || '未命名项目') + '</option>';
        }
        $sel.html(html);
        $sel.val(cur || '');
    }

    function renderKpi() {
        var s = state.summary || {};
        var orders = parseInt(s.orderCount, 10) || 0;
        var done = parseInt(s.doneCount, 10) || 0;
        var doing = parseInt(s.doingCount, 10) || 0;
        var todo = parseInt(s.todoCount, 10) || 0;
        var overdue = parseInt(s.overdueCount, 10) || 0;
        var people = parseInt(s.people, 10) || 0;
        var plans = parseInt(s.planCount, 10) || 0;
        var rate = s.doneRate == null ? 0 : s.doneRate;

        $('#wlKpiOrders').text(orders);
        $('#wlKpiOrdersSub').text(plans ? ('覆盖 ' + plans + ' 个计划') : '—');

        $('#wlKpiDone').text(done);
        $('#wlKpiDoneSub').text(orders ? ('占 ' + rate + '%') : '—');

        $('#wlKpiRate').text(orders ? (rate + '%') : '—');
        $('#wlKpiRateSub').text(orders ? ('已完成 ' + done + ' / 接单 ' + orders) : '—');

        $('#wlKpiOverdue').text(overdue);
        $('#wlKpiOverdueSub').text(overdue ? '需要跟进' : (orders ? '没有逾期' : '—'));

        $('#wlKpiPeople').text(people);
        $('#wlKpiPeopleSub').text(orders ? ('处理中 ' + doing + ' · 待处理 ' + todo) : '—');

        $('#wlPlanCount').text(plans);
        $('#wlSortText').text(SORT_NAMES[state.sortBy] || '接单数');
        $('#wlGenerated').text(state.generatedAt ? ('生成于 ' + state.generatedAt) : '');
    }

    /* ---------------- 列表 ---------------- */
    function rateClass(pct) {
        if (!pct) { return 'is-zero'; }
        if (pct >= 80) { return 'is-high'; }
        if (pct >= 50) { return 'is-mid'; }
        return 'is-low';
    }

    function empCell(it) {
        var meta = [];
        if (it.empCode) { meta.push(it.empCode); }
        if (it.deptName) { meta.push(it.deptName); }
        return '<div class="wl-emp' + (it.unknown ? ' is-unknown' : '') + '">' +
            '<span class="wl-emp__name">' + esc(it.ownerName || '未指定') + '</span>' +
            (meta.length ? '<span class="wl-emp__meta" title="' + esc(meta.join(' · ')) + '">' +
                esc(meta.join(' · ')) + '</span>' : '') +
            '</div>';
    }

    function renderTable() {
        $('#wlTable thead .wl-sort').each(function () {
            var key = $(this).data('sort');
            $(this).removeClass('is-asc is-desc')
                .toggleClass('is-asc', key === state.sortBy && state.sortOrder === 'asc')
                .toggleClass('is-desc', key === state.sortBy && state.sortOrder === 'desc');
        });

        var total = state.list.length;
        if (!total) {
            $card.addClass('is-empty');
            $('#wlEmpty').removeAttr('hidden');
            $tbody.html('');
            return;
        }
        $card.removeClass('is-empty');
        $('#wlEmpty').attr('hidden', 'hidden');

        var startIdx = (state.pageNum - 1) * state.pageSize;
        var rows = state.list.slice(startIdx, startIdx + state.pageSize);
        var html = '', i;
        for (i = 0; i < rows.length; i++) {
            var it = rows[i];
            var rate = it.doneRate || 0;
            var cls = rateClass(rate);
            var avg = it.doneCount ? ((it.avgDays || 0) + ' 天') : '—';
            var last = it.lastDispatch ? it.lastDispatch.slice(5, 16) : '—';
            html += '<tr data-owner="' + esc(it.ownerId) + '"' + (it.unknown ? ' class="is-unknown"' : '') + '>' +
                '<td class="is-center cell-index" data-label="序号">' + (startIdx + i + 1) + '</td>' +
                '<td data-label="员工">' + empCell(it) + '</td>' +
                '<td class="is-center" data-label="接单数"><span class="wl-num cell-strong">' +
                    (it.orderCount || 0) + '</span></td>' +
                '<td class="is-center" data-label="已完成"><span class="wl-num">' + (it.doneCount || 0) + '</span></td>' +
                '<td class="is-center" data-label="处理中"><span class="wl-num' +
                    (it.doingCount ? '' : ' is-muted') + '">' + (it.doingCount || 0) + '</span></td>' +
                '<td class="is-center" data-label="待处理"><span class="wl-num' +
                    (it.todoCount ? '' : ' is-muted') + '">' + (it.todoCount || 0) + '</span></td>' +
                '<td class="is-center" data-label="逾期"><span class="wl-num' +
                    (it.overdueCount ? ' is-warn' : ' is-muted') + '">' + (it.overdueCount || 0) + '</span></td>' +
                '<td data-label="完成率"><div class="wl-rate" title="完成率 ' + rate + '%（' +
                    (it.doneCount || 0) + '/' + (it.orderCount || 0) + '），按期率 ' +
                    (it.onTimeRate || 0) + '%">' +
                    '<span class="wl-rate__bar"><span class="wl-rate__fill ' + cls +
                        '" style="width:' + Math.max(0, Math.min(100, rate)) + '%"></span></span>' +
                    '<span class="wl-rate__text">' + rate + '%</span></div></td>' +
                '<td class="is-center" data-label="平均耗时"><span class="wl-num' +
                    (it.doneCount ? '' : ' is-muted') + '">' + avg + '</span></td>' +
                '<td class="is-center" data-label="最近派单"><span class="wl-time">' + esc(last) + '</span></td>' +
                '<td class="is-center" data-label="明细"><a href="javascript:;" class="wl-link wl-detail-btn">明细</a></td>' +
                '</tr>';
        }
        // 不足一页补空行：表格铺满、页面不出现多余滚动条
        var blank = state.pageSize - rows.length;
        if (blank > 0 && blank <= 50) {
            for (i = 0; i < blank; i++) {
                html += '<tr class="blank-row"><td colspan="' + COLS + '"></td></tr>';
            }
        }
        $tbody.html(html);
    }

    function renderPager() {
        UI.pagination($pager, {
            total: state.list.length,
            pageNum: state.pageNum,
            pageSize: state.pageSize,
            sizes: [10, 20, 50],
            onChange: function (num, size) {
                state.pageNum = num;
                state.pageSize = size;
                try { window.localStorage.setItem(SIZE_KEY, String(size)); } catch (e) { }
                renderTable();
            }
        });
    }

    /* ---------------- 拉数据 ---------------- */
    function load(resetPage) {
        if (resetPage !== false) { state.pageNum = 1; }
        var params = {
            startDate: state.startDate, endDate: state.endDate,
            projectId: state.projectId, keyword: state.keyword,
            scope: state.scope, sortBy: state.sortBy, sortOrder: state.sortOrder
        };
        UI.loading($card, true, '统计中…');
        Api.workload.stats(params).done(function (data) {
            data = data || {};
            state.list = data.list || [];
            state.summary = data.summary || {};
            state.generatedAt = data.generatedAt || '';
            if (data.projects) { fillProjects(data.projects); }
            if (data.range && data.range.startDate) {
                $('#wlRangeText').text('共 ' + data.range.days + ' 天（' +
                    data.range.startDate + ' ~ ' + data.range.endDate + '）');
            }
            renderKpi();
            renderTable();
            renderPager();
        }).fail(function (err) {
            state.list = [];
            state.summary = {};
            renderKpi();
            renderTable();
            renderPager();
            UI.message({ type: 'error', message: (err && err.message) || '统计失败，请稍后重试' });
        }).always(function () {
            UI.loading($card, false);
        });
    }

    /* ---------------- 钻取：某员工的工单明细 ---------------- */
    function openDetail(row) {
        var dstate = { ownerId: row.ownerId, pageNum: 1, pageSize: 10, total: 0 };
        var head = '<div class="wl-detail__head">' +
            '<span><b>' + esc(row.ownerName || '未指定') + '</b> ' +
                esc([row.empCode, row.deptName].filter(Boolean).join(' · ')) + '</span>' +
            '<span class="wl-detail__stat">区间 <b>' + esc(state.startDate) + ' ~ ' + esc(state.endDate) + '</b></span>' +
            '<span class="wl-detail__stat">接单 <strong>' + (row.orderCount || 0) + '</strong></span>' +
            '<span class="wl-detail__stat">已完成 <strong class="is-ok">' + (row.doneCount || 0) +
                '</strong>（' + (row.doneRate || 0) + '%）</span>' +
            '<span class="wl-detail__stat">按期率 <strong>' + (row.onTimeRate || 0) + '%</strong></span>' +
            '<span class="wl-detail__stat">逾期 <strong class="is-warn">' + (row.overdueCount || 0) + '</strong></span>' +
            '<span class="wl-detail__stat">平均耗时 <strong>' + (row.avgDays || 0) + '</strong> 天</span>' +
            '</div>';
        var body = '<div class="wl-detail">' + head +
            '<div class="wl-detail__scroll"><table class="wl-detail__table"><thead><tr>' +
            '<th>工单号</th><th>任务名称</th><th>所属计划 / 项目</th><th>派单时间</th>' +
            '<th>计划完成</th><th>实际完成</th><th class="is-center">状态</th>' +
            '<th class="is-center">耗时</th><th class="is-center">操作</th>' +
            '</tr></thead><tbody id="wlDetailBody"></tbody></table></div>' +
            '<div class="wl-detail__pager" id="wlDetailPager"></div></div>';

        UI.dialog({
            title: '工单明细 —— ' + (row.ownerName || '未指定') + '（' + state.startDate + ' ~ ' + state.endDate + '）',
            width: 1060,
            maximizable: true,
            content: body,
            onReady: function ($b) {
                var $dlg = $b.closest('.el-dialog');
                $dlg.addClass('wl-detail-dialog');
                $dlg.find('.btn-ok').hide();                       // 只读弹窗：只留「关闭」
                $dlg.find('.btn-cancel').text('关闭');
                loadDetail($b, dstate);
            }
        });
    }

    function detailTag(it) {
        if (it.overdue) { return '<span class="wl-tag is-late">已逾期</span>'; }
        if (it.status === '已完成') { return '<span class="wl-tag is-done">已完成</span>'; }
        if (it.status === '处理中') { return '<span class="wl-tag is-doing">处理中</span>'; }
        return '<span class="wl-tag is-todo">待处理</span>';
    }

    function loadDetail($b, dstate) {
        var params = {
            ownerId: dstate.ownerId, pageNum: dstate.pageNum, pageSize: dstate.pageSize,
            startDate: state.startDate, endDate: state.endDate, projectId: state.projectId,
            scope: state.scope
        };
        var $body = $b.find('#wlDetailBody');
        UI.loading($b.find('.wl-detail__scroll'), true, '加载中…');
        Api.workload.details(params).done(function (data) {
            data = data || {};
            var list = data.list || [], i, html = '';
            dstate.total = data.total || 0;
            if (!list.length) {
                html = '<tr><td colspan="9"><div class="wl-detail__empty">这个区间没有派给他的工单</div></td></tr>';
            }
            for (i = 0; i < list.length; i++) {
                var it = list[i];
                html += '<tr class="' + (it.overdue ? 'is-overdue' : '') + '">' +
                    '<td class="is-mono is-nowrap">' + esc(it.orderCode) + '</td>' +
                    '<td>' + esc(it.taskName || '—') + '</td>' +
                    '<td>' + esc(it.planName || '—') +
                        '<div class="wl-emp__meta">' + esc(it.projectName || '') +
                        (it.planCode ? ('<span class="wl-dot">·</span>' + esc(it.planCode)) : '') + '</div></td>' +
                    '<td class="is-nowrap">' + esc(it.dispatchTime || '—') + '</td>' +
                    '<td class="is-nowrap">' + esc(it.endDate || '—') + '</td>' +
                    '<td class="is-nowrap">' + esc(it.actualEndTime || '—') + '</td>' +
                    '<td class="is-center">' + detailTag(it) + '</td>' +
                    '<td class="is-center">' + (it.days == null ? '<span class="wl-num is-muted">—</span>'
                        : (it.days + ' 天')) + '</td>' +
                    '<td class="is-center is-nowrap">' +
                        (it.planId ? '<a href="javascript:;" class="wl-link wl-go-plan" data-plan="' +
                            esc(it.planId) + '">看计划</a>' : '<span class="wl-num is-muted">—</span>') +
                        (it.taskId && it.planId ? ' <a href="javascript:;" class="wl-link wl-go-task" data-plan="' +
                            esc(it.planId) + '" data-task="' + esc(it.taskId) + '">打开任务</a>' : '') +
                    '</td>' +
                    '</tr>';
            }
            $body.html(html);
            UI.pagination($b.find('#wlDetailPager'), {
                total: dstate.total, pageNum: dstate.pageNum, pageSize: dstate.pageSize,
                sizes: [10, 20, 50],
                onChange: function (num, size) {
                    dstate.pageNum = num; dstate.pageSize = size;
                    loadDetail($b, dstate);
                }
            });
        }).fail(function (err) {
            $body.html('<tr><td colspan="9"><div class="wl-detail__empty">' +
                esc((err && err.message) || '加载失败') + '</div></td></tr>');
        }).always(function () {
            UI.loading($b.find('.wl-detail__scroll'), false);
        });
    }

    /* ---------------- 导出 ---------------- */
    function exportExcel() {
        if (!state.list.length) {
            UI.message({ type: 'warning', message: '当前区间没有数据，不用导出了' });
            return;
        }
        var q = $.param({
            startDate: state.startDate, endDate: state.endDate,
            projectId: state.projectId, keyword: state.keyword, scope: state.scope,
            sortBy: state.sortBy, sortOrder: state.sortOrder, token: token()
        });
        window.open('/api/workload/export?' + q, '_blank');
    }

    /* ---------------- 事件 ---------------- */
    function bind() {
        $('#wlBtnSearch').on('click', function () {
            state.projectId = $('#wlProject').val() || '';
            state.keyword = ($('#wlKeyword').val() || '').replace(/^\s+|\s+$/g, '');
            var s = $('#wlStart').val() || '', e = $('#wlEnd').val() || '';
            if (s && state.startDate !== s) { state.quick = ''; }
            if (e && state.endDate !== e) { state.quick = ''; }
            state.startDate = s;
            state.endDate = e;
            if (s && e && s > e) {
                UI.message({ type: 'warning', message: '开始日期不能晚于结束日期' });
                return;
            }
            syncQuickButtons();
            load();
        });

        $('#wlBtnReset').on('click', function () {
            var r = quickRange('month');
            setRange(r.startDate, r.endDate, 'month');
            state.projectId = '';
            state.keyword = '';
            state.scope = '';
            state.sortBy = 'orderCount';
            state.sortOrder = 'desc';
            $('#wlProject').val('');
            $('#wlKeyword').val('');
            $('#wlBtnMine').removeClass('is-active');
            load();
        });

        $('#wlQuick').on('click', '.wl-quick__btn', function () {
            var key = $(this).data('quick');
            var r = quickRange(key);
            setRange(r.startDate, r.endDate, key);
            load();
        });

        $('#wlStart, #wlEnd').on('change', function () {
            // 手改日期就不再高亮快捷按钮（避免「本月」亮着但区间是别的）
            state.startDate = $('#wlStart').val() || '';
            state.endDate = $('#wlEnd').val() || '';
            state.quick = '';
            syncQuickButtons();
        });

        $('#wlProject').on('change', function () {
            state.projectId = $(this).val() || '';
        });

        $('#wlKeyword').on('keydown', function (e) {
            if (e.keyCode === 13) { $('#wlBtnSearch').trigger('click'); }
        });

        $('#wlBtnRefresh').on('click', function () { load(false); });
        $('#wlBtnExport').on('click', exportExcel);

        $('#wlBtnMine').on('click', function () {
            var mine = state.scope !== 'mine';
            state.scope = mine ? 'mine' : '';
            $(this).toggleClass('is-active', mine);
            UI.message({ type: 'info', message: mine ? '只统计派给我的工单' : '统计全部员工' });
            load();
        });

        // 点表头排序：同一列再点一次切升降序
        $('#wlTable thead').on('click', '.wl-sort', function () {
            var key = $(this).data('sort');
            if (state.sortBy === key) {
                state.sortOrder = state.sortOrder === 'desc' ? 'asc' : 'desc';
            } else {
                state.sortBy = key;
                state.sortOrder = 'desc';
            }
            load();
        });

        // 点行 / 「明细」→ 钻取
        $tbody.on('click', 'tr[data-owner]', function (e) {
            if ($(e.target).closest('a,button').length) { return; }
            openDetail(findRow($(this).data('owner')));
        });
        $tbody.on('click', '.wl-detail-btn', function (e) {
            e.stopPropagation();
            openDetail(findRow($(this).closest('tr').data('owner')));
        });

        // 明细弹窗里的跳转（事件委托到 body，弹窗是动态插入的）
        $(document.body).on('click', '.wl-go-plan', function () {
            var planId = $(this).data('plan');
            if (planId) { go('workplan-orders.html?planId=' + encodeURIComponent(planId)); }
        });
        $(document.body).on('click', '.wl-go-task', function () {
            var planId = $(this).data('plan'), taskId = $(this).data('task');
            if (!planId) { return; }
            go('workplan-design.html?id=' + encodeURIComponent(planId) +
               (taskId ? ('&taskId=' + encodeURIComponent(taskId)) : ''));
        });
    }

    function findRow(ownerId) {
        for (var i = 0; i < state.list.length; i++) {
            if (String(state.list[i].ownerId) === String(ownerId)) { return state.list[i]; }
        }
        return null;
    }

    /* ---------------- 初始化 ---------------- */
    function init() {
        var size = parseInt(window.localStorage.getItem(SIZE_KEY) || '10', 10);
        state.pageSize = [10, 20, 50].indexOf(size) > -1 ? size : 10;

        // URL 带参数优先（便于从其它页面/收藏夹带上区间），否则本月
        var uStart = qs('startDate'), uEnd = qs('endDate'), uProject = qs('projectId');
        if (uStart || uEnd) {
            setRange(uStart || quickRange('month').startDate, uEnd || fmtDate(new Date()), '');
        } else {
            var r = quickRange('month');
            setRange(r.startDate, r.endDate, 'month');
        }
        if (uProject) { state.projectId = uProject; }

        bind();
        load();
    }

    init();
});
