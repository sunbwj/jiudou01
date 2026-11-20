/* ==========================================================================
   project-plan-form.js —— 计划基础信息 + 计划事项区（一个计划多个事项）
   --------------------------------------------------------------------------
   · 上区：所属项目 / 计划编号（PL + 6 位，只读）/ 计划名称 / 计划起止 / 说明 → 保存计划；
   · 下区：事项操作引导区（新增 / 编辑 / 删除 / 详情 / 启动计划 / 刷新）+ 事项列表；
     「新增 / 编辑 / 详情」打页到 project-plan-item-form.html（带 planId、itemId）；
   · 未保存的计划不能加事项：先保存拿到 planId（地址栏会带上 planId，刷新不丢）。
   ========================================================================== */
jQuery(function ($) {
    var Q = (function () {
        var out = {};
        String(window.location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
            if (!kv) { return; }
            var p = kv.split('=');
            out[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
        });
        return out;
    })();

    var state = {
        planId: Q.planId || '', projectId: Q.projectId || '',
        plan: null, items: [], rows: {}, selectedItemId: '', projects: []
    };

    function esc(t) { return UI.escapeHtml(t == null ? '' : t); }
    function go(url) {
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    }
    function setUrl(planId) {
        try {
            var url = 'project-plan-form.html?planId=' + encodeURIComponent(planId);
            window.history.replaceState({}, '', url);
        } catch (e) { /* 忽略 */ }
    }
    function selectedItem() { return state.rows[state.selectedItemId] || null; }

    function syncItemToolbar() {
        var row = selectedItem();
        var hasPlan = !!state.planId;
        $('#btnItemAdd, #btnStartPlan, #btnItemRefresh').prop('disabled', !hasPlan);
        $('#btnItemEdit, #btnItemDelete, #btnItemDetail').prop('disabled', !row);
    }

    function loadProjects(done) {
        Api.project.page({ pageNum: 1, pageSize: 500 }).done(function (data) {
            state.projects = (data && data.list) || [];
            var html = '';
            $.each(state.projects, function (i, p) {
                html += '<option value="' + esc(p.id) + '">' + esc(p.projectName) +
                    (p.projectCode ? '（' + esc(p.projectCode) + '）' : '') + '</option>';
            });
            if (!html) { html = '<option value="">（暂无可选项目）</option>'; }
            $('#pfProject').html(html).val(state.projectId || '');
            if (done) { done(); }
        }).fail(function () { if (done) { done(); } });
    }

    function fillPlan(plan) {
        state.plan = plan;
        state.planId = String(plan.id);
        state.projectId = String(plan.projectId);
        $('#pageTitle').text('计划 ' + (plan.planCode || ''));
        $('#pfProject').val(state.projectId);
        $('#pfCode').val(plan.planCode || '');
        $('#pfName').val(plan.planName || '');
        $('#pfStart').val(String(plan.startDate || '').slice(0, 10));
        $('#pfEnd').val(String(plan.endDate || '').slice(0, 10));
        $('#pfDesc').val(plan.planDesc || '');
        $('#pageHead').attr('data-crumb', '项目管理/项目计划/' + (plan.planCode || '计划'));
        syncItemToolbar();
    }

    function loadPlan(done) {
        if (!state.planId) { syncItemToolbar(); if (done) { done(); } return; }
        $('body').addClass('is-loading');
        Api.projectPlan.detail(state.planId).done(function (plan) {
            fillPlan(plan || {});
            if (done) { done(); }
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '计划加载失败' });
        }).always(function () { $('body').removeClass('is-loading'); });
    }

    function renderItems(list) {
        state.items = list || [];
        state.rows = {};
        $('#itemCount').text(state.items.length);
        var $tb = $('#itemTbody');
        if (!state.items.length) {
            $tb.html('<tr class="empty-row"><td colspan="11"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">' +
                (state.planId ? '还没有事项，点「+」新增' : '请先在上方保存计划，再新增事项') +
                '</span></div></td></tr>');
            syncItemToolbar();
            return;
        }
        var html = '';
        $.each(state.items, function (i, it) {
            state.rows[String(it.id)] = it;
            var sel = String(it.id) === String(state.selectedItemId);
            html += '<tr data-id="' + esc(it.id) + '"' + (sel ? ' class="is-selected"' : '') + '>' +
                '<td class="is-center">' + (i + 1) + '</td>' +
                '<td class="is-center"><input type="radio" name="piPick"' + (sel ? ' checked' : '') + '></td>' +
                '<td>' + esc(it.itemCode) + '</td>' +
                '<td>' + esc(it.itemName) + '</td>' +
                '<td class="is-center">' + esc(it.itemType || '事项') + '</td>' +
                '<td>' + esc(it.preItemName || '—') + '</td>' +
                '<td>' + esc(it.ownerName || '—') + '</td>' +
                '<td class="is-center">' + esc(String(it.startTime || '').slice(0, 16)) + '</td>' +
                '<td class="is-center">' + esc(it.status || '') + '</td>' +
                '<td class="is-center">' + esc(it.orderCode || '—') + '</td>' +
                '<td class="is-center">' + (it.fileCount || 0) + '</td></tr>';
        });
        $tb.html(html);
        syncItemToolbar();
    }

    function loadItems(done) {
        if (!state.planId) { renderItems([]); if (done) { done(); } return; }
        UI.loading($('#itemWrapper'), true);
        Api.projectPlan.items(state.planId).done(function (data) {
            renderItems((data && data.list) || []);
            if (done) { done(); }
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '事项加载失败' });
        }).always(function () { UI.loading($('#itemWrapper'), false); });
    }

    /* ---------------- 保存计划 ---------------- */
    $('#btnSavePlan').on('click', function () {
        var pid = $('#pfProject').val();
        if (!pid) { UI.message({ type: 'warning', message: '请选择所属项目' }); return; }
        var payload = {
            projectId: pid,
            planName: $.trim($('#pfName').val()),
            startDate: $('#pfStart').val() || '',
            endDate: $('#pfEnd').val() || '',
            planDesc: $.trim($('#pfDesc').val())
        };
        if (state.planId) { payload.id = state.planId; }
        var req = state.planId ? Api.projectPlan.update(payload) : Api.projectPlan.add(payload);
        req.done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || '计划已保存' });
            if (!state.planId && res && res.id) {
                state.planId = String(res.id);
                setUrl(state.planId);
                loadPlan(function () { loadItems(); });
            }
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
        });
    });

    $('#btnBack').on('click', function () { go('project-plan.html'); });

    /* ---------------- 事项操作 ---------------- */
    $('#btnItemAdd').on('click', function () {
        if (!state.planId) { UI.message({ type: 'warning', message: '请先保存计划' }); return; }
        go('project-plan-item-form.html?planId=' + encodeURIComponent(state.planId));
    });
    $('#btnItemEdit').on('click', function () {
        var row = selectedItem();
        if (row) {
            go('project-plan-item-form.html?planId=' + encodeURIComponent(state.planId) +
                '&itemId=' + encodeURIComponent(row.id));
        }
    });
    $('#btnItemDetail').on('click', function () {
        var row = selectedItem();
        if (row) {
            go('project-plan-item-form.html?planId=' + encodeURIComponent(state.planId) +
                '&itemId=' + encodeURIComponent(row.id) + '&readonly=1');
        }
    });
    $('#btnItemDelete').on('click', function () {
        var row = selectedItem();
        if (!row) { return; }
        UI.confirm({
            title: '删除事项', type: 'warning',
            message: '确定删除事项「' + row.itemName + '」吗？其工单与附件会一并删除。',
            confirmText: '确定删除'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.projectPlan.itemRemove(row.id).done(function () {
                UI.message({ type: 'success', message: '事项已删除' });
                state.selectedItemId = '';
                loadItems();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    });
    $('#btnStartPlan').on('click', function () {
        if (!state.planId) { return; }
        UI.confirm({
            title: '启动计划', type: 'warning',
            message: '将给该计划下还没有工单的事项补派工单，并给责任人发站内消息与邮件。是否继续？',
            confirmText: '启动计划'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.projectPlan.start(state.planId).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '已启动' });
                loadItems();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '启动失败' });
            });
        });
    });
    $('#btnItemRefresh').on('click', function () { loadItems(); });

    $('#itemTbody').on('click', 'tr[data-id]', function () {
        state.selectedItemId = $(this).attr('data-id');
        $('#itemTbody tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        $('#itemTbody input[name=piPick]').prop('checked', false);
        $(this).find('input[name=piPick]').prop('checked', true);
        syncItemToolbar();
    });
    $('#itemTbody').on('dblclick', 'tr[data-id]', function () {
        state.selectedItemId = $(this).attr('data-id');
        $('#btnItemEdit').trigger('click');
    });

    /* ---------------- 启动 ---------------- */
    loadProjects(function () {
        loadPlan(function () { loadItems(); });
    });
});
