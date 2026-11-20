/* ==========================================================================
   project-plan.js —— 项目计划列表（甘特图 / 日历图）
   --------------------------------------------------------------------------
   · 一个项目多个计划：列表按项目过滤，计划编号 PL + 6 位；
   · 选中计划后可看它的**甘特图**（按事项计划起止时间画条）与**日历图**（按开始日期落到月历格）；
   · 创建计划 → project-plan-form.html；打开计划 → project-plan-form.html?planId=…。
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#planTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var COLS = 9;
    var state = {
        projectId: '', keyword: '', pageNum: 1, pageSize: 10, total: 0,
        rows: {}, selectedId: '', items: [], view: '', projects: []
    };
    var STATE_KEY = 'project_plan_list_state';

    function esc(t) { return UI.escapeHtml(t == null ? '' : t); }
    function selected() { return state.rows[state.selectedId] || null; }
    function go(url) {
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    }
    function saveState() {
        try {
            window.sessionStorage.setItem(STATE_KEY, JSON.stringify({
                projectId: state.projectId, keyword: state.keyword,
                pageNum: state.pageNum, pageSize: state.pageSize
            }));
        } catch (e) { /* 忽略 */ }
    }
    function restoreState() {
        try {
            var s = JSON.parse(window.sessionStorage.getItem(STATE_KEY) || '{}') || {};
            state.projectId = s.projectId || '';
            state.keyword = s.keyword || '';
            state.pageNum = s.pageNum || 1;
            state.pageSize = s.pageSize || 10;
        } catch (e) { /* 忽略 */ }
    }

    function syncToolbar() {
        var row = selected();
        $('#btnOpen, #btnDelete').prop('disabled', !row);
        $('#btnGantt, #btnCalendar').prop('disabled', !row);
    }

    function loadProjects(done) {
        Api.project.page({ pageNum: 1, pageSize: 500 }).done(function (data) {
            state.projects = (data && data.list) || [];
            var html = '<option value="">全部项目</option>';
            $.each(state.projects, function (i, p) {
                html += '<option value="' + esc(p.id) + '">' + esc(p.projectName) + '</option>';
            });
            $('#projectId').html(html).val(state.projectId || '');
            if (done) { done(); }
        }).fail(function () { if (done) { done(); } });
    }

    function loadData() {
        UI.loading($wrapper, true);
        Api.projectPlan.page({
            projectId: state.projectId, keyword: state.keyword,
            pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (data) {
            state.total = (data && data.total) || 0;
            state.pageNum = (data && data.pageNum) || 1;
            state.pageSize = (data && data.pageSize) || 10;
            renderRows((data && data.list) || []);
            UI.pagination($pagerWrap, {
                total: state.total, pageNum: state.pageNum, pageSize: state.pageSize,
                sizes: [10, 20, 50],
                onChange: function (num, size) {
                    state.pageNum = num; state.pageSize = size; saveState(); loadData();
                }
            });
            saveState();
        }).fail(function (err) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">' + esc((err && err.message) || '加载失败') + '</span></div></td></tr>');
        }).always(function () { UI.loading($wrapper, false); });
    }

    function renderRows(list) {
        state.rows = {};
        $('#planCount').text(state.total);
        if (!list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">暂无计划，点「+」创建</span></div></td></tr>');
            syncToolbar();
            return;
        }
        var html = '';
        $.each(list, function (i, r) {
            state.rows[String(r.id)] = r;
            var sel = String(r.id) === String(state.selectedId);
            html += '<tr data-id="' + esc(r.id) + '"' + (sel ? ' class="is-selected"' : '') + '>' +
                '<td class="is-center">' + ((state.pageNum - 1) * state.pageSize + i + 1) + '</td>' +
                '<td class="is-center"><input type="radio" name="ppPick"' + (sel ? ' checked' : '') + '></td>' +
                '<td>' + esc(r.planCode) + '</td>' +
                '<td>' + esc(r.planName || '—') + '</td>' +
                '<td>' + esc(r.projectName || '') + '</td>' +
                '<td class="is-center">' + esc(r.startDate || '—') + '</td>' +
                '<td class="is-center">' + esc(r.endDate || '—') + '</td>' +
                '<td class="is-center">' + (r.itemCount || 0) + '</td>' +
                '<td class="is-center">' + (r.orderCount || 0) + '</td></tr>';
        });
        $tbody.html(html);
        syncToolbar();
    }

    /* ---------------- 甘特图 / 日历图 ---------------- */

    function dayNum(text) {
        var m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(text || ''));
        if (!m) { return null; }
        return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
    }

    function fmtDay(n) {
        var d = new Date(n * 86400000);
        return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
    }

    function renderGantt(items) {
        var rows = [];
        $.each(items, function (i, it) {
            var s = dayNum(it.startTime || it.startDate);
            var e = dayNum(it.endTime || it.endDate) || s;
            if (s === null) { return; }
            rows.push({ name: it.itemName, s: s, e: Math.max(s, e), status: it.status || '' });
        });
        var $box = $('#pvGantt');
        if (!rows.length) {
            $box.html('<div class="pp-item-tip">该计划的事项还没有计划开始时间，无法画甘特图。</div>').removeAttr('hidden');
            return;
        }
        var min = rows[0].s, max = rows[0].e;
        $.each(rows, function (i, r) { min = Math.min(min, r.s); max = Math.max(max, r.e); });
        var span = Math.max(1, max - min + 1);
        var html = '<div class="pp-gantt__axis"><span>' + fmtDay(min) + '</span><span>' + fmtDay(max) + '</span></div>';
        $.each(rows, function (i, r) {
            var left = ((r.s - min) / span * 100).toFixed(2);
            var width = Math.max(1.2, ((r.e - r.s + 1) / span * 100)).toFixed(2);
            html += '<div class="pp-gantt__row">' +
                '<div class="pp-gantt__label" title="' + esc(r.name) + '">' + esc(r.name) + '</div>' +
                '<div class="pp-gantt__track"><div class="pp-gantt__bar is-' + esc(r.status) + '" ' +
                'style="left:' + left + '%;width:' + width + '%" title="' + fmtDay(r.s) + ' ~ ' + fmtDay(r.e) + '">' +
                fmtDay(r.s) + '~' + fmtDay(r.e) + '</div></div></div>';
        });
        $box.html(html).removeAttr('hidden');
    }

    function renderCalendar(items, anchor) {
        var base = anchor ? new Date(anchor + 'T00:00:00') : new Date();
        var first = new Date(base.getFullYear(), base.getMonth(), 1);
        var startWeek = first.getDay();
        var days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
        var map = {};
        $.each(items, function (i, it) {
            var s = dayNum(it.startTime || it.startDate);
            if (s === null) { return; }
            (map[s] = map[s] || []).push(it);
        });
        var html = '';
        $.each(['日', '一', '二', '三', '四', '五', '六'], function (i, w) {
            html += '<div class="pp-cal__head">' + w + '</div>';
        });
        var cells = Math.ceil((startWeek + days) / 7) * 7;
        for (var i = 0; i < cells; i++) {
            var dayNumCur = Math.floor(Date.UTC(base.getFullYear(), base.getMonth(), 1) / 86400000) - startWeek + i;
            var d = new Date(dayNumCur * 86400000);
            var inMonth = d.getUTCMonth() === base.getMonth();
            html += '<div class="pp-cal__day' + (inMonth ? '' : ' is-out') + '">' +
                '<div class="pp-cal__date">' + d.getUTCDate() + '</div>';
            $.each(map[dayNumCur] || [], function (j, it) {
                html += '<div class="pp-cal__item" title="' + esc(it.itemName) + '">' + esc(it.itemName) + '</div>';
            });
            html += '</div>';
        }
        $('#pvCalendar').html(html).removeAttr('hidden');
    }

    function showView(kind) {
        var row = selected();
        if (!row) { return; }
        state.view = kind;
        $('#planViews').removeAttr('hidden');
        $('#pvTitle').text('计划 ' + row.planCode + (row.planName ? '（' + row.planName + '）' : '') +
            ' · ' + (kind === 'gantt' ? '甘特图' : '日历图'));
        $('#pvGantt').attr('hidden', 'hidden');
        $('#pvCalendar').attr('hidden', 'hidden');
        Api.projectPlan.items(row.id).done(function (data) {
            state.items = (data && data.list) || [];
            $('#pvTitle').text($('#pvTitle').text() + ' · 共 ' + state.items.length + ' 个事项');
            if (kind === 'gantt') { renderGantt(state.items); }
            else { renderCalendar(state.items, row.startDate || row.startDate); }
        }).fail(function (err) {
            $('#pvTitle').text((err && err.message) || '事项加载失败');
        });
    }

    /* ---------------- 事件 ---------------- */
    $('#btnSearch').on('click', function () {
        state.projectId = $('#projectId').val() || '';
        state.keyword = $.trim($('#keyword').val());
        state.pageNum = 1;
        loadData();
    });
    $('#btnReset').on('click', function () {
        $('#projectId').val(''); $('#keyword').val('');
        state.projectId = ''; state.keyword = ''; state.pageNum = 1;
        loadData();
    });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnSearch').trigger('click'); } });
    $('#projectId').on('change', function () {
        state.projectId = $(this).val() || ''; state.pageNum = 1; loadData();
    });
    $('#btnAdd').on('click', function () {
        var row = selected();
        var pid = row ? row.projectId : (state.projectId || '');
        go('project-plan-form.html' + (pid ? ('?projectId=' + encodeURIComponent(pid)) : ''));
    });
    function openSelected() {
        var row = selected();
        if (row) { go('project-plan-form.html?planId=' + encodeURIComponent(row.id)); }
    }
    $('#btnOpen').on('click', openSelected);
    $('#btnGantt').on('click', function () { showView('gantt'); });
    $('#btnCalendar').on('click', function () { showView('calendar'); });
    $('#btnRefresh').on('click', loadData);
    $('#btnDelete').on('click', function () {
        var row = selected();
        if (!row) { return; }
        UI.confirm({
            title: '删除计划', type: 'warning',
            message: '确定删除计划「' + (row.planCode) + '」吗？计划下的事项、工单与附件会一并删除。',
            confirmText: '确定删除'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.projectPlan.remove(row.id).done(function () {
                UI.message({ type: 'success', message: '计划已删除' });
                state.selectedId = '';
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    });

    $tbody.on('click', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        $tbody.find('tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        $tbody.find('input[name=ppPick]').prop('checked', false);
        $(this).find('input[name=ppPick]').prop('checked', true);
        syncToolbar();
        if (state.view) { showView(state.view); }
    });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        openSelected();
    });

    restoreState();
    loadProjects(function () {
        $('#keyword').val(state.keyword);
        loadData();
    });
});
