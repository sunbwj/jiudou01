/* ==========================================================================
   workplan-task.js —— 我的任务（工单 ↔ 计划任务 双向关联）
   --------------------------------------------------------------------------
   · 数据源 Api.workPlan.orders()：工单按 taskId LEFT JOIN workplantasks，
     返回任务执行记录（完成状态 / 实际起止 / 说明 / 完成%）与 taskLinked；
   · 列表只做展示：先在网格里点一行选中，再用上方引导区的「打开任务」「执行记录」；
     「打开任务」跳 workplan-design.html?id=…&taskId=…（制定页自动定位高亮任务）；
   · 「执行记录」打开时按工单号回读一次最新数据（与计划任务同步），保存后调
     Api.workPlan.exec() 写回计划中那条任务；
   · 关键字 / 项目 / 角色 / 完成状态 / 工单状态五个筛选 + 分页；
   · 操作区是标准 .toolbar（纳入 pageopbtn 扫描 + btnperm.js 按角色授权加载）。
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#wtTbody');
    var $wrapper = $('#wtTableWrapper');
    var $pager = $('#wtPager');
    var COLS = 15;
    var state = {
        projectId: '', keyword: '', role: '', execStatus: '', status: '',
        pageNum: 1, pageSize: 10, total: 0, rows: {}, selId: ''
    };

    function esc(t) { return UI.escapeHtml(t == null ? '' : t); }
    function go(url) {
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    }
    function qs(name) {
        var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search || '');
        return m ? decodeURIComponent(m[1]) : '';
    }

    /* ---------------- 复选下拉（角色 / 完成状态 / 工单状态） ---------------- */
    function multiValues(id) {
        return $('#' + id).find('input[type=checkbox]:checked').map(function () {
            return $(this).val();
        }).get();
    }
    function syncMulti($m) {
        var labels = $m.find('input[type=checkbox]:checked').map(function () {
            return $(this).parent().text().replace(/\s+/g, ' ').trim();
        }).get();
        $m.toggleClass('has-value', labels.length > 0);
        $m.find('input[type=hidden]').val($m.find('input[type=checkbox]:checked').map(function () {
            return $(this).val();
        }).get().join(','));
        $m.find('.wt-multi__text').text(labels.length ? labels.join('、') : $m.data('placeholder'));
    }
    function multiFilterValues(id, hiddenId) {
        var vals = multiValues(id);
        if (!vals.length) {
            var raw = $('#' + hiddenId).val();
            if (raw) { vals = String(raw).split(','); }
        }
        return vals;
    }
    function clearMulti($m) {
        $m.find('input[type=checkbox]').prop('checked', false);
        syncMulti($m);
    }
    function initMulti($m) {
        $m.on('click', '.wt-multi__box', function (e) {
            e.stopPropagation();
            var $drop = $m.find('.wt-multi__drop');
            var show = $drop.prop('hidden');
            $('.wt-multi__drop').prop('hidden', true);
            $drop.prop('hidden', !show);
        });
        $m.on('click', '.wt-multi__drop', function (e) { e.stopPropagation(); });
        $m.on('click', '.wt-multi__clear', function (e) {
            e.preventDefault(); e.stopPropagation(); clearMulti($m);
        });
        $m.on('change', 'input[type=checkbox]', function () { syncMulti($m); });
        syncMulti($m);
    }
    $(document).on('click.wtMulti', function () { $('.wt-multi__drop').prop('hidden', true); });
    /* 关联项目下拉：与计划管理页同口径，取全量项目（含停用 / 历史项目），
       否则老工单关联过的项目会筛不出来 */
    function loadProjects() {
        if (!Api.project || !Api.project.page) { return; }
        Api.project.page({ pageNum: 1, pageSize: 200 }).done(function (data) {
            var list = (data && data.list) || [], html = '<option value="">全部项目</option>', i, p;
            for (i = 0; i < list.length; i++) {
                p = list[i];
                html += '<option value="' + esc(p.id) + '">' + esc(p.projectName) + '</option>';
            }
            $('#wtProject').html(html).val(state.projectId || '');
        });
    }
    function loadData() {
        UI.loading($wrapper, true);
        Api.workPlan.orders({
            projectId: state.projectId, keyword: state.keyword, role: state.role,
            execStatus: state.execStatus, status: state.status,
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
                    state.pageNum = num; state.pageSize = size; loadData();
                }
            });
        }).fail(function (err) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">' + esc((err && err.message) || '加载失败') + '</span></div></td></tr>');
        }).always(function () { UI.loading($wrapper, false); });
    }
    function noticeText(o) {
        return (o.noticeMsg ? '<span style="color:#67c23a">✓消息</span>' : '<span style="color:#c0c4cc">—消息</span>') +
            ' ' + (o.noticeMail ? '<span style="color:#67c23a">✓邮件</span>' : '<span style="color:#c0c4cc">—邮件</span>');
    }
    function execTag(text) {
        var cls = { '未开始': 'is-none', '进行中': 'is-doing', '已完成': 'is-done',
                    '已延期': 'is-late', '已取消': 'is-cancel' }[text] || 'is-none';
        return '<span class="wp-exec-tag wp-exec-' + cls + '">' + esc(text || '未开始') + '</span>';
    }
    function renderRows(list) {
        state.rows = {};
        $('#wtCount').text(state.total);
        if (!list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">暂无与我相关的工单；工作计划「启动」或新增任务后，责任人与参与人员会收到工单</span></div></td></tr>');
            syncSelection();
            return;
        }
        var html = '';
        var startNo = (state.pageNum - 1) * state.pageSize;
        $.each(list, function (i, o) {
            state.rows[String(o.id)] = o;
            var isOwner = o.role === '责任人';
            var dateText = (o.startDate && o.endDate)
                ? (esc(o.startDate) + ' ~ ' + esc(o.endDate)) : '—';
            var actualText = (o.actualStartDate || o.actualEndDate)
                ? (esc(o.actualStartDate || '—') + ' ~ ' + esc(o.actualEndDate || '—')) : '—';
            html += '<tr data-id="' + esc(o.id) + '">' +
                '<td class="is-center">' + (startNo + i + 1) + '</td>' +
                '<td>' + esc(o.orderCode || '—') + '</td>' +
                '<td>' + esc(o.taskName || '—') +
                    (parseInt(o.participantCount, 10) ? ' <span style="color:#909399">(+' +
                        (parseInt(o.participantCount, 10)) + ')</span>' : '') + '</td>' +
                '<td>' + esc(o.planName || o.planCode || '—') + '</td>' +
                '<td class="is-center"><span class="wp-role ' + (isOwner ? 'is-owner' : 'is-part') + '">' +
                    esc(o.role || '—') + '</span></td>' +
                '<td class="is-center">' + esc(o.ownerName || '—') + '</td>' +
                '<td class="is-center" style="font-size:11px">' + dateText + '</td>' +
                '<td class="is-center">' + execTag(o.execStatus) + '</td>' +
                '<td class="is-center" style="font-size:11px">' + actualText + '</td>' +
                '<td class="is-center">' + esc(o.status || '待处理') + '</td>' +
                '<td class="is-center">' + (o.taskLinked === false
                    ? '<span style="color:#f56c6c">任务已删除</span>'
                    : '<span style="color:#67c23a">已关联</span>') + '</td>' +
                '<td class="is-center">' + (parseInt(o.execCount, 10) > 0
                    ? '<a href="javascript:;" class="wp-exec-link wt-exec-link" data-id="' +
                        esc(o.id) + '">' + parseInt(o.execCount, 10) + ' 条</a>'
                    : '<span style="color:#c0c4cc;font-size:11px">—</span>') + '</td>' +
                '<td class="is-center">' + (parseInt(o.changeCount, 10) > 0
                    ? '<a href="javascript:;" class="wp-exec-link wt-change-link" data-id="' +
                        esc(o.id) + '">' + parseInt(o.changeCount, 10) + ' 条</a>'
                    : '<span style="color:#c0c4cc;font-size:11px">—</span>') + '</td>' +
                '<td class="is-center" style="font-size:11px">' + noticeText(o) + '</td>' +
                '<td class="is-center" style="font-size:11px">' + esc(o.dispatchTime || '—') + '</td>' +
                '</tr>';
        });
        $tbody.html(html);
        syncSelection();
    }

    /* ---------------- 选中行 → 引导区按钮（打开任务 / 执行记录） ---------------- */
    function selected() { return state.rows[String(state.selId)] || null; }
    function syncSelection() {
        var o = selected();
        if (!o) { state.selId = ''; }
        $('#wtBtnOpenTask, #wtBtnExec').prop('disabled', !o);
        $('#wtPick').text(o ? ('已选中 ' + (o.orderCode || '') + ' · ' + (o.taskName || '')) : '未选中行');
        $tbody.find('tr.is-selected').removeClass('is-selected');
        if (o) {
            $tbody.find('tr[data-id="' + String(o.id) + '"]').addClass('is-selected');
        }
    }
    function openTask(o) {
        if (!o) { UI.message({ type: 'warning', message: '请先在列表里点一行选中工单' }); return; }
        if (o.taskLinked === false) {
            UI.message({ type: 'warning', message: '该工单关联的任务已被删除' }); return;
        }
        if (o.link) { go(o.link); }
    }

    /* 执行记录弹窗前回读一次：状态 / 实际起止 / 说明以计划任务的最新值为准 */
    function refreshOrder(o, done) {
        if (!o || !o.orderCode) { done(o); return; }
        Api.workPlan.orders({ keyword: o.orderCode, pageNum: 1, pageSize: 5 })
            .done(function (data) {
                var list = (data && data.list) || [], i;
                for (i = 0; i < list.length; i++) {
                    if (String(list[i].id) === String(o.id)) {
                        state.rows[String(o.id)] = list[i];
                        return done(list[i]);
                    }
                }
                done(o);
            })
            .fail(function () { done(o); });
    }

    /* ---------------- 执行记录：回填到工单关联的那条计划任务 ---------------- */
    function openExec(o) {
        if (!o) { return; }
        if (o.taskLinked === false) {
            UI.message({ type: 'warning', message: '该工单关联的任务已被删除，无法回填执行记录' }); return;
        }
        UI.dialog({
            title: '执行记录 —— ' + (o.orderCode || '') + ' / ' + (o.taskName || ''),
            width: 660,
            content: $('#wtExecTpl').html(),
            onReady: function ($body) {
                $body.closest('.el-dialog').addClass('wp-exec-dialog');
                $body.find('#wtExTitle').val((o.orderCode || '') + '  ·  ' + (o.taskName || ''));
                $body.find('#wtExExec').val(o.execStatus || '未开始');
                $body.find('#wtExStatus').val(o.status || '待处理');
                $body.find('#wtExActualStart').val(o.actualStartDate || '');
                $body.find('#wtExActualEnd').val(o.actualEndDate || '');
                $body.find('#wtExProgress').val(parseInt(o.progress, 10) || 0);
                $body.find('#wtExProgressText').text((parseInt(o.progress, 10) || 0) + '%');
                $body.find('#wtExRemark').val(o.execRemark || '');
                $body.find('#wtExProgress').on('input', function () {
                    $body.find('#wtExProgressText').text($(this).val() + '%');
                });
                loadExecHistory($body, o);
                $body.find('#wtExFiles').on('change', function () {
                    var names = [];
                    $.each(this.files || [], function (i, f) { names.push(f.name); });
                    $body.find('#wtExFilesList').text(names.length
                        ? ('已选择 ' + names.length + ' 个：' + names.join('、')) : '');
                });
                /* 完成状态跟计划任务同步：改了完成状态，工单状态自动跟着走（仍可手动微调） */
                $body.find('#wtExExec').on('change', function () {
                    var map = { '未开始': '待处理', '进行中': '处理中', '已完成': '已完成',
                                '已延期': '处理中', '已取消': '待处理' };
                    var to = map[$(this).val()];
                    if (to) { $body.find('#wtExStatus').val(to); }
                    if ($(this).val() === '已完成') {
                        $body.find('#wtExProgress').val(100);
                        $body.find('#wtExProgressText').text('100%');
                        if (!$body.find('#wtExActualEnd').val()) {
                            var d = new Date(), m = ('0' + (d.getMonth() + 1)).slice(-2),
                                day = ('0' + d.getDate()).slice(-2);
                            $body.find('#wtExActualEnd').val(d.getFullYear() + '-' + m + '-' + day);
                        }
                    }
                });
            },
            onOk: function ($body, close) {
                var aStart = $body.find('#wtExActualStart').val() || '';
                var aEnd = $body.find('#wtExActualEnd').val() || '';
                if (aStart && aEnd && aStart > aEnd) {
                    UI.message({ type: 'warning', message: '实际开始时间不能晚于实际结束时间' }); return;
                }
                var execStatus = $body.find('#wtExExec').val() || '未开始';
                if (execStatus === '已完成' && o.execStatus === '已完成') {
                    UI.message({ type: 'warning', message: '任务已完成，不能再提交执行记录' }); return;
                }
                var $ok = $body.closest('.el-dialog').find('.el-button--primary');
                $ok.prop('disabled', true);
                readFiles($body.find('#wtExFiles')[0], function (files, errText) {
                    if (errText) {
                        $ok.prop('disabled', false);
                        UI.message({ type: 'warning', message: errText }); return;
                    }
                    Api.workPlan.exec({
                        orderId: o.id,
                        execStatus: execStatus,
                        status: $body.find('#wtExStatus').val() || '待处理',
                        actualStartDate: aStart, actualEndDate: aEnd,
                        progress: parseInt($body.find('#wtExProgress').val(), 10) || 0,
                        execRemark: $.trim($body.find('#wtExRemark').val()).slice(0, 1000),
                        files: files
                    }).done(function (res) {
                        close();
                        UI.message({ type: 'success', message: (res && res.message) || '执行记录已保存' });
                        loadData();
                    }).fail(function (err) {
                        $ok.prop('disabled', false);
                        UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                    });
                });
            }
        });
    }

    /** 变更历史：该工单关联任务的全部变更（含计划级），时间线展示 */
    function openChangeHistory(o) {
        if (!o) { return; }
        if (!o.planId) {
            UI.message({ type: 'warning', message: '该工单缺少关联计划，无法查看变更历史' });
            return;
        }
        UI.dialog({
            title: '变更历史 —— ' + (o.taskName || o.orderCode || ''),
            width: 640,
            content: '<div class="wp-log" id="wtChangeList">加载中…</div>',
            onReady: function ($body) {
                Api.workPlan.changeLogs({
                    planId: o.planId, taskId: o.taskId, withPlan: 1
                }).done(function (res) {
                    var list = (res && res.list) || [];
                    var $box = $body.find('#wtChangeList').empty();
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
                    $body.find('#wtChangeList').html('<div class="wp-log__empty">' +
                        esc((err && err.message) || '加载失败') + '</div>');
                });
            }
        });
    }

    /** 读取多选附件（dataURL）；超过 10 个 / 单文件 10 MB 直接提示 */
    function readFiles(input, done) {
        var list = (input && input.files) ? input.files : [];
        if (!list.length) { done([], ''); return; }
        if (list.length > 10) { done([], '一次最多上传 10 个附件'); return; }
        var out = [], i = 0;
        function next() {
            if (i >= list.length) { done(out, ''); return; }
            var f = list[i++];
            if (f.size > 10 * 1024 * 1024) { done([], '附件「' + f.name + '」超过 10 MB'); return; }
            var reader = new FileReader();
            reader.onload = function () {
                out.push({ name: f.name, data: String(reader.result || '') });
                next();
            };
            reader.onerror = function () { done([], '读取附件「' + f.name + '」失败'); };
            reader.readAsDataURL(f);
        }
        next();
    }

    /** 历史执行记录（多次提交 + 附件预览） */
    function loadExecHistory($body, o) {
        var $box = $body.find('#wtExHistory');
        Api.workPlan.execs({ orderId: o.id }).done(function (res) {
            var list = (res && res.list) || [];
            $box.empty();
            if (!list.length) {
                $box.append('<div class="wp-hintline">还没有提交过执行记录。</div>');
                return;
            }
            $.each(list, function (i, e) {
                var $it = $('<div class="wp-exec-item"></div>');
                $it.append('<div class="wp-exec-item__hd"><b>' + esc(e.title || '执行记录') + '</b>' +
                    '<span class="wp-exec-item__meta">' + esc(e.execStatus || '') + ' · ' +
                    (parseInt(e.progress, 10) || 0) + '% · ' + esc(e.operatorName || '') + ' · ' +
                    esc(e.createTime || '') + '</span></div>');
                if (e.content) {
                    $it.append('<div class="wp-exec-item__body">' + esc(e.content) + '</div>');
                }
                $.each(e.files || [], function (j2, f) {
                    var $a = $('<a href="javascript:;" class="wp-exec-link">📎 ' +
                        esc(f.name || '附件') + '</a>');
                    $a.on('click', function () { previewExecFile(f); });
                    $it.append($a).append(' ');
                });
                $box.append($it);
            });
        }).fail(function (err) {
            $box.html('<div class="wp-hintline">历史记录加载失败：' +
                esc((err && err.message) || '') + '</div>');
        });
    }

    /* ---------------- 执行记录附件在线预览（与项目文件管理同一套实现） ---------------- */
    function execTokenQ() {
        var t = (window.AppAuth && AppAuth.token) ? AppAuth.token() : '';
        return t ? '&token=' + encodeURIComponent(t) : '';
    }
    function execRawUrl(id) {
        return '/api/workplan/execraw?id=' + encodeURIComponent(id) + execTokenQ();
    }
    function execPdfUrl(id) {
        return '/api/workplan/execpdf?id=' + encodeURIComponent(id) + execTokenQ();
    }
    function execSizeText(n) {
        n = parseInt(n, 10) || 0;
        if (!n) { return ''; }
        if (n < 1024) { return n + ' B'; }
        if (n < 1048576) { return (n / 1024).toFixed(1) + ' KB'; }
        return (n / 1048576).toFixed(1) + ' MB';
    }
    /** 附件预览：图片 / PDF / 文本 / Word / Excel / PPT 走 FilePreview，其它下载 */
    function previewExecFile(file) {
        if (!file || !file.id) { return; }
        var name = file.name || '附件';
        if (!window.FilePreview || !window.FilePreview.preview) {
            window.open(execRawUrl(file.id), '_blank');
            return;
        }
        window.FilePreview.preview({
            id: file.id,
            fileName: name,
            fileSizeText: execSizeText(file.size),
            downloadUrl: execRawUrl(file.id),
            pdfUrl: execPdfUrl(file.id)
        }, {
            onDownload: function () { window.open(execRawUrl(file.id), '_blank'); }
        });
    }

    $('#wtBtnSearch').on('click', function () {
        state.projectId = $('#wtProject').val() || '';
        state.keyword = $.trim($('#wtKeyword').val());
        state.role = multiFilterValues('wtRoleMulti', 'wtRole').join(',');
        state.execStatus = multiFilterValues('wtExecMulti', 'wtExec').join(',');
        state.status = multiFilterValues('wtStatusMulti', 'wtStatus').join(',');
        state.pageNum = 1; loadData();
    });
    $('#wtBtnReset').on('click', function () {
        $('#wtProject').val(''); $('#wtKeyword').val('');
        clearMulti($('#wtRoleMulti')); clearMulti($('#wtExecMulti')); clearMulti($('#wtStatusMulti'));
        state.projectId = ''; state.keyword = ''; state.role = '';
        state.execStatus = ''; state.status = '';
        state.pageNum = 1; loadData();
    });
    $('.wt-multi').each(function () { initMulti($(this)); });
    $('#wtProject').on('change', function () {
        state.projectId = $(this).val() || ''; state.pageNum = 1; loadData();
    });
    $('#wtKeyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#wtBtnSearch').trigger('click'); } });
    $('#wtBtnRefresh').on('click', loadData);
    $('#wtBtnGoPlan').on('click', function () { go('workplan.html'); });
    $('#wtBtnOpenTask').on('click', function () { openTask(selected()); });
    $('#wtBtnExec').on('click', function () {
        var o = selected();
        if (!o) { UI.message({ type: 'warning', message: '请先在列表里点一行选中工单' }); return; }
        refreshOrder(o, openExec);
    });
    /* 网格只做展示：单击选中，双击直接打开任务（与引导区按钮等价） */
    $tbody.on('click', 'tr[data-id]', function () {
        state.selId = $(this).attr('data-id');
        syncSelection();
    });
    $tbody.on('click', '.wt-change-link', function (e) {
        e.preventDefault(); e.stopPropagation();
        var o = state.rows[String($(this).attr('data-id'))];
        if (o) { state.selId = String(o.id); syncSelection(); openChangeHistory(o); }
    });
    $tbody.on('click', '.wt-exec-link', function (e) {
        e.preventDefault(); e.stopPropagation();
        var o = state.rows[String($(this).attr('data-id'))];
        if (o) { state.selId = String(o.id); syncSelection(); openExec(o); }
    });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        state.selId = $(this).attr('data-id');
        syncSelection();
        openTask(selected());
    });

    /* 从任务属性「查看工单」跳来时按工单号自动筛选；也支持按项目带入 */
    var kw = qs('keyword'), pid = qs('projectId');
    if (kw) { $('#wtKeyword').val(kw); state.keyword = kw; }
    if (pid) { state.projectId = pid; }
    loadProjects();
    loadData();
});
