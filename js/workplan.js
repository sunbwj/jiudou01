/* ==========================================================================
   workplan.js —— 计划管理（原「工作计划」）列表，Visio 风格甘特图入口
   --------------------------------------------------------------------------
   · 新建：弹「甘特图选项」对话框（名称 / 日期范围 / 时间刻度 / 非工作日 / 共享）
     → /workplan/add 建空计划 → 打页到 workplan-design.html?id=…；
   · 打开 / 双击：进「工作计划」画布；删除：计划 + 任务一起删；
   · 首屏 syncToolbar/loadProjects/loadData 并行（Mock 回调异步，别把列表压在下拉后面）。
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#wpTbody');
    var $wrapper = $('#wpTableWrapper');
    var $pager = $('#wpPager');
    var COLS = 11;
    var STATE_KEY = 'workplan_list_state';
    var state = {
        projectId: '', keyword: '', pageNum: 1, pageSize: 10, total: 0,
        rows: {}, selectedId: '', projects: [], enabledProjects: [], projectOptionsHtml: ''
    };

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
    /* 引导区是纯图标按钮：启动 / 补派靠 title + 图标区分（未启动=播放键，已启动=播放键+加号） */
    var ICO_START = '<svg class="svg-ico" viewBox="0 0 24 24">' +
        '<path fill="currentColor" d="M8 5v14l11-7L8 5z"/></svg>';
    var ICO_REFILL = '<svg class="svg-ico" viewBox="0 0 24 24">' +
        '<path fill="currentColor" d="M14 5v14L3 12l11-7z"/>' +
        '<path fill="currentColor" d="M18 4h2v3h3v2h-3v3h-2V9h-3V7h3V4z"/></svg>';
    function syncToolbar() {
        var row = selected();
        var started = !!(row && row.status === '已启动');
        var mine = !!(row && row.isCreator !== false);
        var title = started ? '补派新任务（只给还没有工单的任务派单并通知）'
                            : '启动计划（派发工单并通知责任人与参与人员）';
        $('#wpBtnOpen, #wpBtnStart, #wpBtnOrders').prop('disabled', !row);
        var $start = $('#wpBtnStart');
        if ($start.attr('title') !== title) {
            $start.attr('title', title)
                  .attr('aria-label', started ? '补派新任务' : '启动计划')
                  .html(started ? ICO_REFILL : ICO_START);
        }
        /* 删除：非本人创建 / 执行中 都禁用；执行中的只能停止 */
        $('#wpBtnDelete').prop('disabled', !row || !mine || started)
            .attr('title', !row ? '删除工作计划'
                : (!mine ? '非本人创建的工作计划不能删除'
                    : (started ? '执行中的工作计划不能删除，请先停止' : '删除工作计划')));
        $('#wpBtnStop').prop('disabled', !row || !mine || !started)
            .attr('title', !row ? '停止工作计划'
                : (!mine ? '只有计划创建人可以停止'
                    : (started ? '停止工作计划（已派发的工单与执行记录保留）'
                        : '只有已启动的工作计划可以停止')));
    }
    /* 筛选下拉要能看到历史计划关联过的全部项目；新建下拉只给「已建立且启用」的项目。
       后者走 /project/options（后端 WHERE enabled=1，Mock 同口径），不强制关联。 */
    function loadProjects() {
        if (!Api.project || !Api.project.page) { return; }
        Api.project.page({ pageNum: 1, pageSize: 200 }).done(function (data) {
            state.projects = (data && data.list) || [];
            var html = '<option value="">全部项目</option>', i;
            for (i = 0; i < state.projects.length; i++) {
                html += '<option value="' + esc(state.projects[i].id) + '">' +
                    esc(state.projects[i].projectName) + '</option>';
            }
            $('#wpProject').html(html).val(state.projectId || '');
        });
        loadEnabledProjects();
    }
    function projectOptionHtml(list) {
        var html = '<option value="">不关联（通用工作计划）</option>', i, p, label;
        for (i = 0; i < list.length; i++) {
            p = list[i];
            label = p.projectCode ? (p.projectCode + ' ' + p.projectName) : p.projectName;
            html += '<option value="' + esc(p.id) + '" data-name="' + esc(p.projectName) + '">' +
                esc(label) + '</option>';
        }
        return html;
    }
    function loadEnabledProjects(done) {
        if (!Api.project) { if (done) { done(); } return; }
        /* 优先用项目下拉专用接口（只返回可见 + 启用）；老版本 api.js 无 options 时退回带 enabled 过滤的分页 */
        var req = Api.project.options
            ? Api.project.options()
            : Api.project.page({ pageNum: 1, pageSize: 200, enabled: 1 });
        req.done(function (data) {
            state.enabledProjects = (data && data.list) || [];
            state.projectOptionsHtml = projectOptionHtml(state.enabledProjects);
            /* 弹窗已打开（异步晚到）时补填，避免下拉空白；保留用户已选中的项目 */
            var $sel = $('#wpNewProject');
            if ($sel.length) {
                var keep = $sel.val() || '';
                $sel.html(state.projectOptionsHtml).val(keep);
            }
            if (done) { done(); }
        }).fail(function () {
            state.enabledProjects = [];
            state.projectOptionsHtml = projectOptionHtml([]);
            if (done) { done(); }
        });
    }
    function loadData() {
        UI.loading($wrapper, true);
        Api.workPlan.page({
            projectId: state.projectId, keyword: state.keyword,
            pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (data) {
            state.total = (data && data.total) || 0;
            state.pageNum = (data && data.pageNum) || 1;
            state.pageSize = (data && data.pageSize) || 10;
            renderRows((data && data.list) || []);
            UI.pagination($pager, {
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
        $('#wpCount').text(state.total);
        if (!list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">暂无工作计划，点「新建工作计划」开始</span></div></td></tr>');
            syncToolbar();
            return;
        }
        var html = '';
        $.each(list, function (i, r) {
            state.rows[String(r.id)] = r;
            var sel = String(r.id) === String(state.selectedId);
            var pct = Math.min(100, Math.max(0, parseInt(r.progress, 10) || 0));
            html += '<tr data-id="' + esc(r.id) + '"' + (sel ? ' class="is-selected"' : '') + '>' +
                '<td class="is-center">' + ((state.pageNum - 1) * state.pageSize + i + 1) + '</td>' +
                '<td class="is-center"><input type="radio" name="wpPick"' + (sel ? ' checked' : '') + '></td>' +
                '<td>' + esc(r.planCode) + '</td>' +
                '<td>' + esc(r.planName || '—') + '</td>' +
                '<td>' + esc(r.projectName || '—') + '</td>' +
                '<td class="is-center">' + esc(r.startDate || '—') + '</td>' +
                '<td class="is-center">' + esc(r.endDate || '—') + '</td>' +
                '<td class="is-center">' + (parseInt(r.taskCount, 10) || 0) + '</td>' +
                '<td><span class="wp-progress' + (pct >= 100 ? ' is-done' : '') + '"><i style="width:' +
                    pct + '%"></i></span>' + pct + '%</td>' +
                '<td class="is-center"><span class="wp-status ' +
                    (r.status === '已启动' ? 'is-on' : (r.status === '已停止' ? 'is-stop' : 'is-off')) + '">' +
                    esc(r.status === '已启动' ? '已启动'
                        : (r.status === '已停止' ? '已停止' : '未启动')) + '</span></td>' +
                '<td>' + esc(r.createEname || '—') + '</td></tr>';
        });
        $tbody.html(html);
        syncToolbar();
    }

    /* ---------------- 新建：Visio「甘特图选项」 ---------------- */
    function dateAdd(days) {
        var d = new Date();
        d.setDate(d.getDate() + days);
        return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) +
            '-' + ('0' + d.getDate()).slice(-2);
    }
    function openNew() {
        var dlg = UI.dialog({
            title: '新建工作计划 · 甘特图选项',
            width: 640,
            content: $('#wpNewTpl').html(),
            onReady: function ($body) {
                $body.find('#wpNewStart').val(dateAdd(0));
                $body.find('#wpNewEnd').val(dateAdd(30));
                /* 弹窗此刻才插入 DOM，必须先填缓存，再实时回数据库刷一次（项目随时可能新建 / 停用） */
                var $proj = $body.find('#wpNewProject');
                $proj.html(state.projectOptionsHtml || projectOptionHtml([]));
                $proj.val(state.projectId || '');
                loadEnabledProjects();
                if (Api.workPlan.nextCode) {
                    Api.workPlan.nextCode().done(function (res) {
                        $body.find('#wpNewCode').val((res && res.code) || 'WP + 6 位');
                    });
                }
            },
            onOk: function ($body, close) {
                var name = $.trim($body.find('#wpNewName').val());
                var start = $body.find('#wpNewStart').val();
                var end = $body.find('#wpNewEnd').val();
                if (!name) { UI.message({ type: 'warning', message: '请填写计划名称' }); return; }
                if (start && end && start > end) {
                    UI.message({ type: 'warning', message: '开始日期不能晚于结束日期' }); return;
                }
                var $proj = $body.find('#wpNewProject');
                var $opt = $proj.find('option:selected');
                Api.workPlan.add({
                    planName: name,
                    projectId: $proj.val() || '',
                    /* 名称快照放在 data-name 上，避免把「PRO000001 」前缀写进 projectName */
                    projectName: $proj.val() ? ($opt.attr('data-name') || $opt.text()) : '',
                    startDate: start, endDate: end,
                    planDesc: $.trim($body.find('#wpNewDesc').val()),
                    scale: $body.find('#wpNewScale').val() || 'week',
                    skipWeekend: $body.find('#wpNewWeekend').prop('checked') ? 1 : 0,
                    ispub: $body.find('#wpNewPub').prop('checked') ? 1 : 0
                }).done(function (res) {
                    close();
                    UI.message({ type: 'success', message: (res && res.message) || '工作计划已创建' });
                    go('workplan-design.html?id=' + encodeURIComponent(res && res.id));
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '创建失败' });
                });
            }
        });
        return dlg;
    }

    function openSelected() {
        var row = selected();
        if (row) { go('workplan-design.html?id=' + encodeURIComponent(row.id)); }
    }

    /* ---------------- 事件 ---------------- */
    $('#wpBtnSearch').on('click', function () {
        state.projectId = $('#wpProject').val() || '';
        state.keyword = $.trim($('#wpKeyword').val());
        state.pageNum = 1; loadData();
    });
    $('#wpBtnReset').on('click', function () {
        $('#wpProject').val(''); $('#wpKeyword').val('');
        state.projectId = ''; state.keyword = ''; state.pageNum = 1; loadData();
    });
    $('#wpKeyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#wpBtnSearch').trigger('click'); } });
    $('#wpProject').on('change', function () {
        state.projectId = $(this).val() || ''; state.pageNum = 1; loadData();
    });
    /* 启动：一任务一工单，责任人 + 参与人员同时收到即时消息与邮件，工单进「我的任务」 */
    function startSelected() {
        var row = selected();
        if (!row) { return; }
        var again = row.status === '已启动';
        UI.confirm({
            title: '启动工作计划', type: 'warning',
            message: '将按计划「' + (row.planName || row.planCode) + '」下的 ' +
                (parseInt(row.taskCount, 10) || 0) + ' 条任务生成工单，并给每条任务的' +
                '【责任人 + 参与人员】同时发送站内即时消息与通知邮件，工单会进入他们的「我的任务」列表。' +
                (again ? '（已启动过：本次只补派新增任务，不会重复通知。）' : '') + ' 是否继续？',
            confirmText: '确定启动'
        }).done(function (yes) {
            if (!yes) { return; }
            Api.workPlan.start(row.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '工作计划已启动' });
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '启动失败' });
            });
        });
    }

    $('#wpBtnAdd').on('click', openNew);
    $('#wpBtnOpen').on('click', openSelected);
    $('#wpBtnStart').on('click', startSelected);
    $('#wpBtnMyTask').on('click', function () { go('workplan-task.html'); });
    $('#wpBtnOrders').on('click', function () {
        var row = selected();
        if (!row) { return; }
        go('workplan-orders.html?planId=' + encodeURIComponent(row.id));
    });
    $('#wpBtnRefresh').on('click', loadData);
    $('#wpBtnStop').on('click', function () {
        var row = selected();
        if (!row) { return; }
        if (row.isCreator === false) {
            UI.message({ type: 'warning', message: '只有计划创建人可以停止该工作计划' }); return;
        }
        if (row.status !== '已启动') {
            UI.message({ type: 'warning', message: '只有已启动的工作计划可以停止' }); return;
        }
        UI.confirm({
            title: '停止工作计划', type: 'warning',
            message: '停止后计划状态变为「已停止」，不能再重复启动；已派发的工单与执行记录会保留。是否继续？',
            confirmText: '确定停止'
        }).done(function (yes) {
            if (!yes) { return; }
            Api.workPlan.stop(row.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '工作计划已停止' });
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '停止失败' });
            });
        });
    });
    $('#wpBtnDelete').on('click', function () {
        var row = selected();
        if (!row) { return; }
        if (row.isCreator === false) {
            UI.message({ type: 'warning', message: '非本人创建的工作计划不能删除' }); return;
        }
        if (row.status === '已启动') {
            UI.message({ type: 'warning', message: '执行中的工作计划不能删除，请先停止' }); return;
        }
        UI.confirm({
            title: '删除工作计划', type: 'warning',
            message: '确定删除「' + (row.planName || row.planCode) + '」吗？计划下的 ' +
                (parseInt(row.taskCount, 10) || 0) + ' 条任务会一并删除。',
            confirmText: '确定删除'
        }).done(function (yes) {
            if (!yes) { return; }
            Api.workPlan.remove(row.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '工作计划已删除' });
                state.selectedId = ''; loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    });
    $tbody.on('click', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        $tbody.find('tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        $tbody.find('input[name=wpPick]').prop('checked', false);
        $(this).find('input[name=wpPick]').prop('checked', true);
        syncToolbar();
    });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        openSelected();
    });

    restoreState();
    $('#wpKeyword').val(state.keyword);
    syncToolbar();
    /* 从项目详情「在计划管理中查看」跳转：?projectId=xxx 预筛选 */
    var qp = new RegExp('[?&]projectId=([^&]*)').exec(window.location.search || '');
    if (qp) { state.projectId = decodeURIComponent(qp[1]); }
    loadProjects();
    loadData();
});
