/* ==========================================================================
   workplan-orders.js —— 计划工单（计划 / 项目维度查看全部工单）
   --------------------------------------------------------------------------
   · 数据源 Api.workPlan.planOrders()：所有「我能看到的计划」（我创建 or 公用）下的全部工单；
   · 支持按项目汇总（项目下拉 + 汇总条 + 表格按项目分组），未关联项目的计划归入「未关联项目」；
   · 行操作：执行记录（多次记录 + 附件在线预览）、变更历史（任务 ∪ 计划级）、打开任务（设计器定位）。
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#woTbody');
    var $table = $('#woTable');
    var $pager = $('#woPager');
    var COLS = 14;
    var state = {
        projectId: '', planId: '', keyword: '', status: '', execStatus: '', owner: '',
        pageNum: 1, pageSize: 10, total: 0, rows: {}
    };

    function esc(t) { return UI.escapeHtml(t == null ? '' : t); }
    function go(url) {
        if (window.AppFrame && typeof window.AppFrame.navigate === 'function') { window.AppFrame.navigate(url); }
        else { window.location.href = url; }
    }
    function qs(name) {
        var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search || '');
        return m ? decodeURIComponent(m[1]) : '';
    }
    function tokenQ() {
        var t = (window.AppAuth && AppAuth.token) ? AppAuth.token() : '';
        return t ? '&token=' + encodeURIComponent(t) : '';
    }
    function execRawUrl(id) {
        return '/api/workplan/execraw?id=' + encodeURIComponent(id) + tokenQ();
    }
    function execPdfUrl(id) {
        return '/api/workplan/execpdf?id=' + encodeURIComponent(id) + tokenQ();
    }
    function sizeText(n) {
        n = parseInt(n, 10) || 0;
        if (!n) { return ''; }
        if (n < 1024) { return n + ' B'; }
        if (n < 1048576) { return (n / 1024).toFixed(1) + ' KB'; }
        return (n / 1048576).toFixed(1) + ' MB';
    }

    /* ---------------- 复选下拉（工单状态 / 执行状态） ---------------- */
    function refreshMulti($root) {
        var vals = [], names = [];
        $root.find('.wp-multi__opt input:checked').each(function () {
            vals.push($(this).val());
            names.push($(this).closest('.wp-multi__opt').text().trim());
        });
        $root.find('input[type=hidden]').val(vals.join(','));
        var placeholder = $root.attr('data-placeholder') || '全部状态';
        var text = !vals.length ? placeholder : names.join('、');
        $root.find('.wp-multi__btn').text(text).attr('title', text);
    }

    function initMulti(sel) {
        var $root = $(sel);
        if (!$root.length) { return; }
        $root.find('.wp-multi__btn').on('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            var $panel = $root.find('.wp-multi__panel');
            var willOpen = $panel.is('[hidden]');
            $('.wp-multi__panel').attr('hidden', 'hidden');
            if (willOpen) { $panel.removeAttr('hidden'); }
        });
        $root.find('.wp-multi__panel').on('click', function (e) { e.stopPropagation(); });
        $root.find('.wp-multi__opt input').on('change', function () { refreshMulti($root); });
        $root.find('.wp-multi__clear').on('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            resetMulti(sel);
            $root.find('.wp-multi__panel').attr('hidden', 'hidden');
        });
        refreshMulti($root);
    }

    function resetMulti(sel) {
        var $root = $(sel);
        $root.find('.wp-multi__opt input').prop('checked', false);
        refreshMulti($root);
    }

    /* ---------------- 筛选 ---------------- */
    function loadPlans() {
        state.planId = qs('planId') || '';
        state.projectId = qs('projectId') || '';
        Api.workPlan.page({ pageNum: 1, pageSize: 200 }).done(function (res) {
            var list = (res && res.list) || [], html = '<option value="">全部计划</option>';
            $.each(list, function (i, p) {
                html += '<option value="' + esc(p.id) + '">' +
                    esc((p.planCode || '') + ' ' + (p.planName || '')) + '</option>';
            });
            $('#woPlan').html(html).val(state.planId || '');
            loadData();                 // 计划下拉就绪后再按 query 里的 planId / projectId 加载
        }).fail(function () { loadData(); });
    }

    function collectFilters() {
        state.projectId = $('#woProject').val() || '';
        state.planId = $('#woPlan').val() || '';
        state.status = $('#woStatus').val() || '';
        state.execStatus = $('#woExec').val() || '';
        state.owner = $.trim($('#woOwner').val());
        state.keyword = $.trim($('#woKeyword').val());
    }

    function loadData() {
        UI.loading($table, true);
        Api.workPlan.planOrders({
            pageNum: state.pageNum, pageSize: state.pageSize,
            projectId: state.projectId, planId: state.planId,
            status: state.status, execStatus: state.execStatus,
            owner: state.owner, keyword: state.keyword
        }).done(function (res) {
            var d = res || {};
            state.total = parseInt(d.total, 10) || 0;
            state.rows = {};
            $('#woCount').text(state.total);
            renderProjects(d.projects);
            renderSummary(d.summary);
            renderRows(d.list || []);
            renderPager();
        }).fail(function (err) {
            $tbody.html('<tr><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">' + esc((err && err.message) || '加载失败') +
                '</span></div></td></tr>');
        }).always(function () { UI.loading($table, false); });
    }

    function renderProjects(projects) {
        var cur = $('#woProject').val() || '';
        var html = '<option value="">全部项目</option>';
        $.each(projects || [], function (i, p) {
            html += '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
        });
        $('#woProject').html(html).val(cur || state.projectId || '');
    }

    function renderSummary(summary) {
        var $box = $('#woSummary').empty();
        if (!summary || !summary.length) { return; }
        $.each(summary, function (i, s) {
            $box.append('<span class="wo-summary__item' +
                (s.projectKey === state.projectId ? ' is-active' : '') +
                '" data-project="' + esc(s.projectKey) + '">' +
                '<span class="wo-summary__name">' + esc(s.projectName) + '</span>' +
                s.orders + ' 单 · ' + s.planCount + ' 个计划</span>');
        });
    }

    function statusTag(s) {
        var cls = { '待处理': 'is-none', '处理中': 'is-doing', '已完成': 'is-done' }[s] || 'is-none';
        return '<span class="wp-exec-tag wp-exec-' + cls + '">' + esc(s || '待处理') + '</span>';
    }
    function execTag(s) {
        var cls = { '未开始': 'is-none', '进行中': 'is-doing', '已完成': 'is-done',
                    '已延期': 'is-late', '已取消': 'is-cancel' }[s] || 'is-none';
        return '<span class="wp-exec-tag wp-exec-' + cls + '">' + esc(s || '未开始') + '</span>';
    }

    function renderRows(list) {
        if (!list.length) {
            $tbody.html('<tr><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">没有符合条件的工单</span></div></td></tr>');
            return;
        }
        var html = '', lastProject = null;
        var startNo = (state.pageNum - 1) * state.pageSize;
        $.each(list, function (i, o) {
            state.rows[String(o.orderId)] = o;
            if (state.projectId === '' && o.projectKey !== lastProject) {
                lastProject = o.projectKey;
                html += '<tr class="wp-orders__group"><td colspan="' + COLS + '">项目：' +
                    esc(o.projectName) + '</td></tr>';
            }
            var dates = (o.startDate || o.endDate)
                ? (esc(o.startDate || '—') + ' ~ ' + esc(o.endDate || '—')) : '—';
            html += '<tr data-id="' + esc(o.orderId) + '">' +
                '<td class="is-center">' + (startNo + i + 1) + '</td>' +
                '<td>' + esc(o.projectName) + '</td>' +
                '<td>' + esc(o.planCode || '—') + '</td>' +
                '<td>' + esc(o.planName || '—') + '</td>' +
                '<td>' + esc(o.orderCode || '—') + '</td>' +
                '<td>' + esc(o.taskName || '—') + '</td>' +
                '<td class="is-center">' + esc(o.ownerName || '—') + '</td>' +
                '<td class="is-center">' + esc(o.participantNames || '—') + '</td>' +
                '<td class="is-center">' + statusTag(o.status) + '</td>' +
                '<td class="is-center">' + execTag(o.execStatus) + '</td>' +
                '<td class="is-center" style="font-size:11px">' + dates + '</td>' +
                '<td class="is-center" style="font-size:11px">' + esc(o.dispatchTime || '—') + '</td>' +
                '<td class="is-center">' + (parseInt(o.execCount, 10) > 0
                    ? '<a href="javascript:;" class="wp-exec-link" data-exec="' + esc(o.orderId) +
                        '">' + parseInt(o.execCount, 10) + ' 条</a>'
                    : '<span style="color:#c0c4cc;font-size:11px">—</span>') + '</td>' +
                '<td class="is-center">' + (parseInt(o.changeCount, 10) > 0
                    ? '<a href="javascript:;" class="wp-exec-link" data-change="' + esc(o.orderId) +
                        '">' + parseInt(o.changeCount, 10) + ' 条</a>'
                    : '<span style="color:#c0c4cc;font-size:11px">—</span>') + '</td>' +
                '</tr>';
        });
        $tbody.html(html);
        window.setTimeout(layoutRows, 30);   // 等 flex 布局稳定后再量高度
    }

    /** 行高拉伸 + 空行补全：让结果区铺满剩余页高（与菜单 / 组织架构列表同一风格） */
    function layoutRows() {
        $tbody.find('tr.blank-row').remove();
        if (window.innerWidth < 769) { return; }
        var $rows = $tbody.children('tr[data-id]');
        if (!$rows.length) { return; }
        var wrap = document.getElementById('woTableWrapper');
        var head = document.querySelector('#woTable thead');
        if (!wrap || !head) { return; }
        var avail = (wrap.clientHeight || 0) - (head.offsetHeight || 0);
        if (avail <= 0) { return; }
        var groupH = 0;
        $tbody.children('tr.wp-orders__group').each(function () { groupH += $(this).outerHeight() || 0; });
        avail -= groupH;
        if (avail <= 0) { return; }
        $rows.children('td').css('height', '');
        var naturalH = $rows.first().outerHeight() || 38;
        var n = $rows.length;
        var rowH = Math.floor(avail / n);
        if (rowH < naturalH) { rowH = naturalH; }
        if (rowH > 60) { rowH = 60; }
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
        var blanks = '';
        for (var i = 0; i < cnt; i++) {
            var bh = rowH + (i === cnt - 1 ? rem : 0);
            var tds = '';
            for (var c = 0; c < COLS; c++) {
                tds += '<td style="height:' + bh + 'px"></td>';
            }
            blanks += '<tr class="blank-row">' + tds + '</tr>';
        }
        $tbody.append(blanks);
    }

    function printAll() {
        collectFilters();
        var rows = [], page = 1, size = 200;
        function next() {
            Api.workPlan.planOrders({
                pageNum: page, pageSize: size,
                projectId: state.projectId, planId: state.planId,
                status: state.status, execStatus: state.execStatus,
                owner: state.owner, keyword: state.keyword
            }).done(function (res) {
                var list = (res && res.list) || [];
                rows = rows.concat(list);
                var total = parseInt(res && res.total, 10) || 0;
                if (page * size < total && page < 100) { page++; next(); return; }
                renderPrint(rows);
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '打印数据加载失败' });
            });
        }
        next();
    }

    function renderPrint(rows) {
        var heads = ['序号', '项目', '计划编号', '计划名称', '工单号', '任务名称', '责任人',
                     '参与人员', '工单状态', '执行状态', '计划开始', '计划结束', '派发时间',
                     '执行记录数', '变更历史数'];
        var html = '<h2 style="margin:0 0 4px;font-size:16px">计划工单</h2>' +
            '<div class="wo-print-meta">项目：' + esc($('#woProject option:selected').text() || '全部项目') +
            '　计划：' + esc($('#woPlan option:selected').text() || '全部计划') +
            '　共 ' + rows.length + ' 条</div>' +
            '<table class="wo-print-table"><thead><tr>';
        $.each(heads, function (i, t) { html += '<th>' + t + '</th>'; });
        html += '</tr></thead><tbody>';
        $.each(rows, function (i, o) {
            html += '<tr>' +
                '<td>' + (i + 1) + '</td>' +
                '<td>' + esc(o.projectName || '未关联项目') + '</td>' +
                '<td>' + esc(o.planCode || '') + '</td>' +
                '<td>' + esc(o.planName || '') + '</td>' +
                '<td>' + esc(o.orderCode || '') + '</td>' +
                '<td>' + esc(o.taskName || '') + '</td>' +
                '<td>' + esc(o.ownerName || '') + '</td>' +
                '<td>' + esc(o.participantNames || '') + '</td>' +
                '<td>' + esc(o.status || '') + '</td>' +
                '<td>' + esc(o.execStatus || '') + '</td>' +
                '<td>' + esc(o.startDate || '') + '</td>' +
                '<td>' + esc(o.endDate || '') + '</td>' +
                '<td>' + esc(o.dispatchTime || '') + '</td>' +
                '<td>' + (parseInt(o.execCount, 10) || 0) + '</td>' +
                '<td>' + (parseInt(o.changeCount, 10) || 0) + '</td>' +
                '</tr>';
        });
        html += '</tbody></table>';
        $('#woPrintArea').html(html);
        document.body.classList.add('wo-printing');
        window.print();
        window.setTimeout(function () { document.body.classList.remove('wo-printing'); }, 500);
    }

    function exportExcel() {
        var params = {
            projectId: state.projectId, planId: state.planId, status: state.status,
            execStatus: state.execStatus, owner: state.owner, keyword: state.keyword,
            token: (window.AppAuth && AppAuth.token) ? AppAuth.token() : ''
        };
        var url = '/api/workplan/exportorders?' + $.param(params);
        var iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = url;
        document.body.appendChild(iframe);
        window.setTimeout(function () {
            if (iframe.parentNode) { iframe.parentNode.removeChild(iframe); }
        }, 60000);
        UI.message({ type: 'success', message: '正在导出 Excel（按当前筛选全部行）…' });
    }

    function renderPager() {
        UI.pagination($pager, {
            total: state.total, pageNum: state.pageNum, pageSize: state.pageSize,
            sizes: [10, 20, 50],
            onChange: function (num, size) {
                state.pageNum = num;
                state.pageSize = size;
                loadData();
            }
        });
    }

    /* ---------------- 执行记录 / 变更历史 ---------------- */
    function openExec(o) {
        UI.dialog({
            title: '执行记录 —— ' + (o.orderCode || '') + ' / ' + (o.taskName || ''),
            width: 640,
            content: '<div class="wp-log" id="woExecList">加载中…</div>',
            onReady: function ($body) {
                $body.closest('.el-dialog').addClass('wp-exec-dialog');
                Api.workPlan.execs({ orderId: o.orderId }).done(function (res) {
                    var list = (res && res.list) || [];
                    var $box = $body.find('#woExecList').empty();
                    if (!list.length) {
                        $box.html('<div class="wp-log__empty">还没有提交过执行记录。</div>');
                        return;
                    }
                    $.each(list, function (i, e) {
                        var files = '';
                        $.each(e.files || [], function (j, f) {
                            files += '<a href="javascript:;" class="wp-exec-link" data-file="' +
                                esc(f.id) + '">📎 ' + esc(f.name || '附件') + '</a> ';
                        });
                        $box.append('<div class="wp-log__item is-exec"><span class="wp-log__dot"></span>' +
                            '<div class="wp-log__hd">' + esc(e.title || '执行记录') + ' · ' +
                                esc(e.execStatus || '') + ' · ' + (parseInt(e.progress, 10) || 0) + '%</div>' +
                            '<div class="wp-log__meta">' + esc(e.operatorName || '') + ' · ' +
                                esc(e.createTime || '') + '</div>' +
                            (e.content ? '<div class="wp-log__detail">' + esc(e.content) + '</div>' : '') +
                            (files ? '<div style="margin-top:6px">' + files + '</div>' : '') +
                            '</div>');
                    });
                }).fail(function (err) {
                    $body.find('#woExecList').html('<div class="wp-log__empty">' +
                        esc((err && err.message) || '加载失败') + '</div>');
                });
            }
        });
    }

    function openChange(o) {
        UI.dialog({
            title: '变更历史 —— ' + (o.taskName || o.orderCode || ''),
            width: 640,
            content: '<div class="wp-log" id="woChangeList">加载中…</div>',
            onReady: function ($body) {
                Api.workPlan.changeLogs({
                    planId: o.planId, taskId: o.taskId, withPlan: 1
                }).done(function (res) {
                    var list = (res && res.list) || [];
                    var $box = $body.find('#woChangeList').empty();
                    if (!list.length) {
                        $box.html('<div class="wp-log__empty">该任务还没有变更记录。</div>');
                        return;
                    }
                    $.each(list, function (i, l) {
                        var cls = { add: 'is-add', delete: 'is-delete', update: 'is-update',
                                    exec: 'is-exec', stop: 'is-stop' }[l.action] || '';
                        $box.append('<div class="wp-log__item ' + cls + '"><span class="wp-log__dot"></span>' +
                            '<div class="wp-log__hd">' + esc(l.summary || '') + '</div>' +
                            '<div class="wp-log__meta">' + esc(l.operatorName || '—') + ' · ' +
                                esc(l.createTime || '') + '</div>' +
                            (l.detail ? '<div class="wp-log__detail">' + esc(l.detail) + '</div>' : '') +
                            '</div>');
                    });
                }).fail(function (err) {
                    $body.find('#woChangeList').html('<div class="wp-log__empty">' +
                        esc((err && err.message) || '加载失败') + '</div>');
                });
            }
        });
    }

    function previewFile(file) {
        if (!file || !file.id) { return; }
        if (!window.FilePreview || !window.FilePreview.preview) {
            window.open(execRawUrl(file.id), '_blank');
            return;
        }
        window.FilePreview.preview({
            id: file.id, fileName: file.name || '附件',
            fileSizeText: sizeText(file.size),
            downloadUrl: execRawUrl(file.id), pdfUrl: execPdfUrl(file.id)
        }, { onDownload: function () { window.open(execRawUrl(file.id), '_blank'); } });
    }

    /* ---------------- 事件 ---------------- */
    $('#woSearch').on('click', function () { collectFilters(); state.pageNum = 1; loadData(); });
    $('#woReset').on('click', function () {
        $('#woProject').val(''); $('#woPlan').val('');
        resetMulti('#woStatusMulti'); resetMulti('#woExecMulti');
        $('#woOwner').val(''); $('#woKeyword').val('');
        state.projectId = ''; state.planId = ''; state.status = ''; state.execStatus = '';
        state.owner = ''; state.keyword = ''; state.pageNum = 1; loadData();
    });
    $('#woKeyword').on('keydown', function (e) {
        if (e.keyCode === 13) { $('#woSearch').trigger('click'); }
    });
    $('#woBtnExport').on('click', function () { collectFilters(); exportExcel(); });
    $('#woBtnPrint').on('click', printAll);
    $(window).on('resize', function () {
        window.clearTimeout(window.__woResizeTimer);
        window.__woResizeTimer = window.setTimeout(layoutRows, 150);
    });
    $('#woBtnBack').on('click', function () { go('workplan.html'); });
    $('#woSummary').on('click', '.wo-summary__item', function () {
        var key = $(this).attr('data-project') || '';
        $('#woProject').val(key === state.projectId ? '' : key);
        collectFilters(); state.pageNum = 1; loadData();
    });
    $tbody.on('click', '[data-exec]', function (e) {
        e.preventDefault(); e.stopPropagation();
        var o = state.rows[String($(this).attr('data-exec'))];
        if (o) { openExec(o); }
    });
    $tbody.on('click', '[data-change]', function (e) {
        e.preventDefault(); e.stopPropagation();
        var o = state.rows[String($(this).attr('data-change'))];
        if (o) { openChange(o); }
    });
    $pager.on('click', '[data-page]', function () {
        var dir = $(this).attr('data-page');
        if (dir === 'prev' && state.pageNum > 1) { state.pageNum--; loadData(); }
        if (dir === 'next') { state.pageNum++; loadData(); }
    });
    $(document).on('click', '[data-file]', function (e) {
        e.preventDefault(); e.stopPropagation();
        var id = $(this).attr('data-file');
        Api.workPlan.execFile(id).done(function (res) {
            var d = res || {};
            previewFile({ id: id, name: d.name, size: d.size });
        }).fail(function () { previewFile({ id: id, name: '附件' }); });
    });

    /* ---------------- 首屏 ---------------- */
    initMulti('#woStatusMulti');
    initMulti('#woExecMulti');
    $(document).on('click', function () { $('.wp-multi__panel').attr('hidden', 'hidden'); });
    loadPlans();
});
