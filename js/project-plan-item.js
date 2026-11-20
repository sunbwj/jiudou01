/* ==========================================================================
   project-plan-item.js —— 计划事项或任务表单（含附件上传 / 在线预览）
   --------------------------------------------------------------------------
   · 字段：所属项目、所属计划（只读带入）、事项/任务、类型、前置事项、说明、
     输入条件、里程碑输出、计划开始/结束时间、责任人、参与人员、状态（字典）、排序号；
   · 保存：新增 / 修改 → 后端自动生成事项编号 IT+6、同步生成工单、通知责任人（消息含事项链接 + 邮件）；
   · 附件：上传（base64）、列表、在线预览（js/file-preview.js）、删除。
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
        itemId: Q.itemId || '', planId: Q.planId || '', readonly: Q.readonly === '1',
        plan: null, item: null, files: [], rows: {}, selectedFileId: '',
        emps: [], statuses: []
    };
    var MAX = 20 * 1024 * 1024;

    function esc(t) { return UI.escapeHtml(t == null ? '' : t); }
    function go(url) {
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    }
    function backPlan() { go('project-plan-form.html?planId=' + encodeURIComponent(state.planId)); }

    function fillSelects() {
        var ownerHtml = '<option value="">（暂不指定）</option>';
        var partHtml = '';
        $.each(state.emps, function (i, e) {
            var name = e.name || e.nameCn || '';
            ownerHtml += '<option value="' + esc(e.id) + '">' + esc(name) +
                (e.email ? '（' + esc(e.email) + '）' : '') + '</option>';
            partHtml += '<option value="' + esc(e.id) + '">' + esc(name) +
                (e.deptName ? '（' + esc(e.deptName) + '）' : '') + '</option>';
        });
        $('#itOwner').html(ownerHtml);
        $('#itParts').html(partHtml);
        var stHtml = '';
        $.each(state.statuses, function (i, s) { stHtml += '<option value="' + esc(s) + '">' + esc(s) + '</option>'; });
        $('#itStatus').html(stHtml || '<option value="待执行">待执行</option>');
    }

    function loadStatuses(done) {
        Api.projectPlan.itemStatuses().done(function (d) {
            state.statuses = (d && d.statuses) || [];
            if (done) { done(); }
        }).fail(function () { state.statuses = ['待执行', '执行中', '完成', '异常']; if (done) { done(); } });
    }
    function loadEmps(done) {
        Api.emp.page({ pageNum: 1, pageSize: 1000 }).done(function (d) {
            state.emps = (d && d.list) || [];
            if (done) { done(); }
        }).fail(function () { if (done) { done(); } });
    }

    function fillPreOptions(planId, selfId, selectedId) {
        Api.projectPlan.items(planId).done(function (d) {
            var html = '<option value="">（无）</option>';
            $.each((d && d.list) || [], function (i, it) {
                if (selfId && String(it.id) === String(selfId)) { return; }
                html += '<option value="' + esc(it.id) + '">' + esc(it.itemCode) + ' ' + esc(it.itemName) + '</option>';
            });
            $('#itPre').html(html).val(selectedId || '');
        });
    }

    function fillPlanInfo(plan) {
        state.plan = plan;
        state.planId = String(plan.id);
        $('#itProject').val(plan.projectName + (plan.projectCode ? '（' + plan.projectCode + '）' : ''));
        $('#itPlan').val(plan.planCode + (plan.planName ? '（' + plan.planName + '）' : ''));
        $('#pageHead').attr('data-crumb', '项目管理/项目计划/' + plan.planCode);
    }

    function fillItem(it) {
        state.item = it;
        state.itemId = String(it.id);
        $('#itemTitle').text((state.readonly ? '事项详情 —— ' : '编辑事项 —— ') + (it.itemCode || ''));
        $('#itName').val(it.itemName || '');
        $('#itType').val(it.itemType || '事项');
        $('#itDesc').val(it.itemDesc || '');
        $('#itInput').val(it.inputCond || '');
        $('#itOut').val(it.milestoneOut || '');
        $('#itStart').val(String(it.startTime || '').replace(' ', 'T').slice(0, 16));
        $('#itEnd').val(String(it.endTime || '').replace(' ', 'T').slice(0, 16));
        $('#itOwner').val(it.ownerId ? String(it.ownerId) : '');
        $('#itStatus').val(it.status || '待执行');
        $('#itSort').val(it.sortNo || 0);
        fillPreOptions(state.planId, it.id, it.preItemId || '');
        var parts = String(it.participantIds || '').split(',').filter(Boolean);
        $('#itParts').val(parts);
        renderFiles(it.files || []);
        applyReadonly();
    }

    function applyReadonly() {
        if (!state.readonly) { return; }
        $('#itemForm').find('input,select,textarea').prop('disabled', true);
        $('#btnSaveItem').prop('disabled', true).attr('title', '只读模式');
        $('#btnPickFile').hide();
        $('#btnDeleteFile').hide();
    }

    function renderFiles(list) {
        state.files = list || [];
        state.rows = {};
        $('#fileCount').text(state.files.length);
        var html = '';
        $.each(state.files, function (i, f) {
            state.rows[String(f.id)] = f;
            html += '<tr data-id="' + esc(f.id) + '">' +
                '<td>' + esc(f.fileName) + '</td>' +
                '<td class="is-center">' + esc(f.fileType || '其它') + '</td>' +
                '<td class="is-center">' + esc(f.fileSizeText || '') + '</td>' +
                '<td class="is-center">' + esc(String(f.uploadTime || '').slice(0, 19)) + '</td>' +
                '<td>' + esc(f.uploadEname || '') + '</td></tr>';
        });
        $('#fileTbody').html(html || '<tr class="empty-row"><td colspan="5" class="is-center">' +
            (state.itemId ? '还没有附件，点上方「上传附件」' : '保存事项后可上传附件') + '</td></tr>');
        $('#btnPreviewFile, #btnDeleteFile').prop('disabled', true);
        state.selectedFileId = '';
    }

    /* ---------------- 保存 ---------------- */
    $('#btnSaveItem').on('click', function () {
        if (!state.planId) { UI.message({ type: 'warning', message: '缺少所属计划，请从计划页进入' }); return; }
        var name = $.trim($('#itName').val());
        if (!name) { UI.message({ type: 'warning', message: '请填写事项或任务名称' }); return; }
        var payload = {
            planId: state.planId,
            itemName: name,
            itemType: $('#itType').val(),
            preItemId: $('#itPre').val() || '',
            itemDesc: $.trim($('#itDesc').val()),
            inputCond: $.trim($('#itInput').val()),
            milestoneOut: $.trim($('#itOut').val()),
            startTime: ($('#itStart').val() || '').replace('T', ' '),
            endTime: ($('#itEnd').val() || '').replace('T', ' '),
            ownerId: $('#itOwner').val() || '',
            participantIds: $('#itParts').val() || [],
            status: $('#itStatus').val(),
            sortNo: $('#itSort').val() || 0
        };
        if (state.itemId) { payload.id = state.itemId; }
        var req = state.itemId ? Api.projectPlan.itemUpdate(payload) : Api.projectPlan.itemAdd(payload);
        req.done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || '已保存' });
            var id = (res && res.id) || state.itemId;
            if (!state.itemId) {
                state.itemId = String(id);
                try {
                    window.history.replaceState({}, '',
                        'project-plan-item-form.html?planId=' + encodeURIComponent(state.planId) +
                        '&itemId=' + encodeURIComponent(id));
                } catch (e) { /* 忽略 */ }
                loadItem();
            }
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
        });
    });
    $('#btnBackPlan').on('click', backPlan);

    /* ---------------- 附件 ---------------- */
    $('#itFile').on('change', function () {
        var file = this.files && this.files[0];
        if (!file) { return; }
        if (!state.itemId) { UI.message({ type: 'warning', message: '请先保存事项，再上传附件' }); $(this).val(''); return; }
        if (file.size > MAX) { UI.message({ type: 'warning', message: '附件不能超过 20 MB' }); $(this).val(''); return; }
        var reader = new window.FileReader();
        reader.onload = function (ev) {
            var data = String(ev.target.result || '');
            Api.projectPlan.itemFileUpload({
                itemId: state.itemId, fileName: file.name, data: data
            }).done(function () {
                UI.message({ type: 'success', message: '附件已上传' });
                loadFiles();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '上传失败' });
            });
        };
        reader.onerror = function () { UI.message({ type: 'error', message: '文件读取失败' }); };
        reader.readAsDataURL(file);
        $(this).val('');
    });
    $('#fileTbody').on('click', 'tr[data-id]', function () {
        state.selectedFileId = $(this).attr('data-id');
        $('#fileTbody tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        $('#btnPreviewFile, #btnDeleteFile').prop('disabled', false);
    });
    $('#btnPreviewFile').on('click', function () {
        var f = state.rows[state.selectedFileId];
        if (!f) { return; }
        if (window.FilePreview && window.FilePreview.preview) {
            window.FilePreview.preview(f, {
                onDownload: function () { window.open(f.downloadUrl || '#', '_blank'); }
            });
        } else {
            window.open(f.downloadUrl || '#', '_blank');
        }
    });
    $('#btnDeleteFile').on('click', function () {
        var f = state.rows[state.selectedFileId];
        if (!f) { return; }
        UI.confirm({
            title: '删除附件', type: 'warning',
            message: '确定删除附件「' + f.fileName + '」吗？', confirmText: '确定删除'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.projectPlan.itemFileDelete(f.id).done(function () {
                UI.message({ type: 'success', message: '附件已删除' });
                loadFiles();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    });

    function loadFiles() {
        if (!state.itemId) { renderFiles([]); return; }
        Api.projectPlan.itemFiles(state.itemId).done(function (d) {
            renderFiles((d && d.list) || []);
        });
    }

    function loadItem() {
        if (!state.itemId) { applyReadonly(); return; }
        Api.projectPlan.itemDetail(state.itemId).done(function (it) {
            fillItem(it || {});
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '事项加载失败' });
        });
    }

    /* ---------------- 启动 ---------------- */
    loadStatuses(function () {
        loadEmps(function () {
            fillSelects();
            if (!state.planId && state.itemId) {
                Api.projectPlan.itemDetail(state.itemId).done(function (it) {
                    state.planId = String(it.planId || '');
                    Api.projectPlan.detail(state.planId).done(function (plan) {
                        fillPlanInfo(plan || {});
                        loadItem();
                    });
                });
                return;
            }
            if (!state.planId) { UI.message({ type: 'error', message: '缺少 planId 参数' }); return; }
            Api.projectPlan.detail(state.planId).done(function (plan) {
                fillPlanInfo(plan || {});
                loadItem();
                if (!state.itemId) { renderFiles([]); fillPreOptions(state.planId, '', ''); }
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '计划加载失败' });
            });
        });
    });
});
