/* ==========================================================================
   project.js —— 项目管理 · 项目信息（projectinfos）
   --------------------------------------------------------------------------
   · 检索卡片（关键字 / 类型 / 状态 / 公用否 / 启用否）→ 操作引导区 → 左右分栏；
   · 左栏（70%）为原项目查询结果，右栏为当前项目的文件列表（按文件名排序，
     后端 / Mock 同口径支持 orderBy=fileName）；
   · 项目编号 PRO + 6 位流水号由后端在保存时生成，表单页只读预览；
   · 列表 / 详情 / 项目下拉统一由后端按「本人创建 OR 公用」过滤，前端不重复过滤；
   · 新增 / 编辑以「打页」方式打开 project-form.html（独立页签 + 富文本项目说明 + Word 导入）；
   * 「上传文件」按钮：选中项目后弹出上传弹窗，成功后刷新左列表文件数与右栏文件列表；
   · 双击左栏项目行 → 刷新右栏文件列表；双击右栏文件行 → 在线预览
     （图 / pdf / txt / docx / xlsx / pptx，其它格式直接下载，见 js/file-preview.js）；
   · 删除项目会由后端级联清理项目目录与项目文件，确认框里会提示文件数量；
   · 项目文件区新增「目录」标签页与目录维护（创建 / 编辑 / 删除文件夹），
     文件节点可拖拽到其它目录；上传弹窗用下拉框选所属目录，不选择时文件直接关联项目（dirId 为空）。
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#pjTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var $pfTbody = $('#pfPanelTbody');
    var $pfWrapper = $('#pfPanelWrapper');
    var $pfTreeView = $('#pfTreeView');
    var COLS = 11;
    var STATE_KEY = 'project_info_state';
    var MAX_BYTES = 10 * 1024 * 1024;

    var state = {
        keyword: '', projectType: '', projectStatus: '', ispub: '', enabled: '',
        pageNum: 1, pageSize: 10, total: 0,
        rows: {}, selectedId: '', selectedFileId: '', pfKeyword: '',
        types: [], statuses: [],
        fileTypes: [], pfRows: {}, pfProjectId: '',
        pfView: 'list',                 // 文件区展示方式：list=文件列表 / tree=目录视图
        dirTree: [], dirRows: {}, selectedDirId: '', treeCollapsed: {},
        upDirs: [], upDirId: '', dragFileId: ''
    };

    function esc(text) { return UI.escapeHtml(text == null ? '' : text); }
    function selected() { return state.rows[state.selectedId] || null; }

    /* ---------------- 检索条件存取 ---------------- */
    function saveState() {
        try {
            window.sessionStorage.setItem(STATE_KEY, JSON.stringify({
                keyword: state.keyword, projectType: state.projectType,
                projectStatus: state.projectStatus, ispub: state.ispub, enabled: state.enabled,
                pageNum: state.pageNum, pageSize: state.pageSize
            }));
        } catch (e) { }
    }
    function restoreState() {
        try {
            var raw = window.sessionStorage.getItem(STATE_KEY);
            if (!raw) { return; }
            var s = JSON.parse(raw) || {};
            state.keyword = s.keyword || '';
            state.projectType = s.projectType || '';
            state.projectStatus = s.projectStatus || '';
            state.ispub = (s.ispub === 0 || s.ispub) ? String(s.ispub) : '';
            state.enabled = (s.enabled === 0 || s.enabled) ? String(s.enabled) : '';
            state.pageNum = parseInt(s.pageNum, 10) || 1;
            state.pageSize = parseInt(s.pageSize, 10) || 10;
            $('#keyword').val(state.keyword);
        } catch (e) { }
    }
    function syncSearch() {
        $('#projectType').val(state.projectType);
        $('#projectStatus').val(state.projectStatus);
        $('#ispub').val(state.ispub);
        $('#enabled').val(state.enabled);
    }

    function syncToolbar() {
        var row = selected();
        $('#btnEdit, #btnView, #btnUpload, #btnMembers, #btnEnable, #btnDisable, #btnDelete, #btnPfUpload')
            .prop('disabled', !row);
        if (row) {
            $('#btnEnable').prop('disabled', !!row.enabled);
            $('#btnDisable').prop('disabled', !row.enabled);
        }
        syncPfToolbar();
    }
    function selectedFile() { return state.pfRows[state.selectedFileId] || null; }
    function syncPfToolbar() {
        var f = selectedFile();
        $('#btnPfEnable, #btnPfDisable, #btnPfDelete').prop('disabled', !f);
        // 下载：选中且启用才可（服务端对停用文件同样拒绝下载）
        $('#btnPfDownload').prop('disabled', !f || !f.enabled);
        if (f) {
            $('#btnPfEnable').prop('disabled', !!f.enabled);
            $('#btnPfDisable').prop('disabled', !f.enabled);
        }
        // 目录维护：创建只需选中项目；编辑 / 删除要先在「目录」页选中文件夹
        $('#btnDirAdd').prop('disabled', !state.pfProjectId && !selected());
        $('#btnDirEdit, #btnDirDelete').prop('disabled', !state.selectedDirId);
    }
    function selectedDir() { return state.dirRows[state.selectedDirId] || null; }
    function busyTarget() { return state.pfView === 'tree' ? $pfTreeView : $pfWrapper; }

    /* ---------------- 字典 ---------------- */
    function fillSelect($sel, list, placeholder) {
        var html = placeholder ? '<option value="">' + esc(placeholder) + '</option>' : '';
        for (var i = 0; i < list.length; i++) {
            html += '<option value="' + esc(list[i]) + '">' + esc(list[i]) + '</option>';
        }
        $sel.html(html);
    }
    function projectMultiValues($m) {
        var vals = $m.find('.pjf-multi__opt input:checked').map(function () {
            return $(this).val();
        }).get();
        if (!vals.length) {
            var raw = $('#' + $m.attr('data-select')).val();
            if (raw) { vals = String(raw).split(','); }
        }
        return vals;
    }
    function syncProjectMulti($m) {
        var names = $m.find('.pjf-multi__opt input:checked').map(function () {
            return $(this).parent().text().replace(/\s+/g, ' ').trim();
        }).get();
        $m.toggleClass('has-value', names.length > 0);
        $m.find('.pjf-multi__text').text(names.length ? names.join('、') : $m.data('placeholder'));
    }
    function fillProjectMulti($m, list, placeholder) {
        var selectId = $m.attr('data-select');
        fillSelect($('#' + selectId), list, placeholder);
        var checked = String(state[selectId] || '').split(','), html = '', i;
        for (i = 0; i < list.length; i++) {
            html += '<label class="pjf-multi__opt"><input type="checkbox" value="' + esc(list[i]) + '"' +
                ($.inArray(String(list[i]), checked) >= 0 ? ' checked' : '') + '> ' +
                esc(list[i]) + '</label>';
        }
        $m.find('.pjf-multi__list').html(html || '<div class="pjf-multi__empty">暂无选项</div>');
        syncProjectMulti($m);
    }
    function clearProjectMulti($m) {
        $m.find('.pjf-multi__opt input').prop('checked', false);
        $('#' + $m.attr('data-select')).val('');
        syncProjectMulti($m);
    }
    function initProjectMulti($m) {
        $m.on('click', '.pjf-multi__box', function (e) {
            e.stopPropagation();
            var $drop = $m.find('.pjf-multi__drop');
            var show = $drop.prop('hidden');
            $('.pjf-multi__drop').prop('hidden', true);
            $drop.prop('hidden', !show);
        });
        $m.on('click', '.pjf-multi__drop', function (e) { e.stopPropagation(); });
        $m.on('change', '.pjf-multi__opt input', function () { syncProjectMulti($m); });
        $m.on('click', '.pjf-multi__clear', function (e) {
            e.preventDefault(); e.stopPropagation();
            $m.find('.pjf-multi__opt input').prop('checked', false);
            $('#' + $m.attr('data-select')).val('');
            syncProjectMulti($m);
        });
        syncProjectMulti($m);
    }

    function loadTypes() {
        return Api.project.types().done(function (data) {
            state.types = (data && data.types) || [];
            state.statuses = (data && data.statuses) || [];
            fillProjectMulti($('#projectTypeMulti'), state.types, '全部类型');
            fillProjectMulti($('#projectStatusMulti'), state.statuses, '全部状态');
            syncSearch();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '项目字典加载失败' });
        });
    }

    /* ---------------- 列表 ---------------- */
    function badge(ok) {
        return ok ? '<span class="el-tag el-tag--success">启用</span>'
            : '<span class="el-tag el-tag--info">停用</span>';
    }
    function pubBadge(pub) {
        return pub === false || pub === 0
            ? '<span class="el-tag el-tag--warning">私有</span>'
            : '<span class="el-tag el-tag--info">公用</span>';
    }
    function renderRows(data) {
        var list = (data && data.list) || [];
        state.rows = {};
        $('#pjCount').text(state.total + '');
        if (!list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '">' +
                '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
                (state.keyword || state.projectType || state.projectStatus || state.ispub !== '' ||
                 state.enabled !== '' ? '没有符合条件的项目' : '还没有项目，点「新增项目」创建一个') +
                '</span></div></td></tr>');
            syncToolbar();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            state.rows[r.id] = r;
            var idx = (state.pageNum - 1) * state.pageSize + i + 1;
            // 项目说明是富文本 HTML，列表只展示后端 / Mock 附带的纯文本摘要
            var descText = r.projectDescText || '';
            var desc = descText ? ' title="' + esc(descText) + '"' : '';
            html += '<tr data-id="' + esc(r.id) + '"' + desc +
                (String(r.id) === String(state.selectedId) ? ' class="is-selected"' : '') + '>' +
                '<td class="is-center">' + idx + '</td>' +
                '<td class="is-center"><label class="el-radio">' +
                    '<input class="el-radio__original" type="radio" name="pjPick" value="' +
                    esc(r.id) + '"' + (String(r.id) === String(state.selectedId) ? ' checked' : '') + '>' +
                    '<span class="el-radio__inner"></span></label></td>' +
                '<td><span class="pj-code">' + esc(r.projectCode) + '</span></td>' +
                '<td><b>' + esc(r.projectName) + '</b></td>' +
                '<td>' + esc(r.projectType || '其它') + '</td>' +
                '<td>' + esc(r.projectStatus || '未开始') + '</td>' +
                '<td class="is-center">' + (parseInt(r.fileCount, 10) || 0) + '</td>' +
                '<td class="is-center">' + pubBadge(r.ispub) + '</td>' +
                '<td>' + esc(r.createEname || '-') + '</td>' +
                '<td>' + esc(r.createTime || '') + '</td>' +
                '<td class="is-center">' + badge(r.enabled) + '</td>' +
                '</tr>';
        }
        $tbody.html(html);
        syncToolbar();
    }

    function loadData() {
        UI.loading($wrapper, true, '加载中…');
        Api.project.page({
            keyword: state.keyword, projectType: state.projectType,
            projectStatus: state.projectStatus, ispub: state.ispub, enabled: state.enabled,
            pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (data) {
            state.total = (data && data.total) || 0;
            state.pageNum = (data && data.pageNum) || 1;
            state.pageSize = (data && data.pageSize) || 10;
            renderRows(data);
            UI.pagination($pagerWrap, {
                total: state.total, pageNum: state.pageNum, pageSize: state.pageSize, sizes: [10, 20, 50],
                onChange: function (num, size) {
                    state.pageNum = num; state.pageSize = size;
                    saveState();
                    loadData();
                }
            });
            saveState();
        }).fail(function (err) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '">' +
                '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
                esc((err && err.message) || '加载失败') + '</span></div></td></tr>');
        }).always(function () { UI.loading($wrapper, false); });
    }

    /* ---------------- 新增 / 编辑：打页（独立页签，不再弹窗） ---------------- */
    /**
     * 新增 / 编辑都打开独立页面 project-form.html：
     *   · 在框架内运行时由 AppNav.go → AppFrame.navigate 新开一个页签；
     *   · 独立访问列表页时退化为普通页面跳转；
     *   · 表单页保存 / 返回时再 AppNav.go('project.html')，框架会关闭表单页签并刷新本列表。
     */
    function openFormPage(row) {
        var url = row
            ? 'project-form.html?mode=edit&id=' + encodeURIComponent(row.id)
            : 'project-form.html?mode=add';
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    }

    /* ---------------- 启用 / 停用 / 删除 / 查看文件 ---------------- */
    function setEnabled(on) {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条项目' }); return; }
        if (!!row.enabled === !!on) {
            UI.message({ type: 'info', message: on ? '该项目已经是启用状态' : '该项目已经是停用状态' });
            return;
        }
        Api.project.setEnabled(row.id, on).done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || (on ? '已启用' : '已停用') });
            loadData();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
        });
    }
    function removeProject() {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条项目' }); return; }
        var count = parseInt(row.fileCount, 10) || 0;
        UI.confirm({
            title: '删除项目', type: 'warning',
            message: '确定删除项目「' + row.projectName + '」吗？' +
                (count ? '\n该项目下有 ' + count + ' 个文件，会一并删除。' : ''),
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.project.remove(row.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '已删除' });
                state.selectedId = '';
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }
    function gotoDetail() {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条项目' }); return; }
        var url = 'project-detail.html?id=' + encodeURIComponent(row.id);
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    }

    /* ---------------- 右栏：当前项目的文件列表（按文件名排序） ---------------- */
    function pfEmpty(text) {
        $pfTbody.html('<tr class="empty-row"><td colspan="5">' +
            '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
            esc(text) + '</span></div></td></tr>');
    }
    function renderPfRows(data) {
        var list = (data && data.list) || [];
        state.pfRows = {};
        if (!list.length) { pfEmpty('该项目还没有文件，点工具栏「上传文件」添加'); return; }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            var f = list[i];
            state.pfRows[f.id] = f;
            html += '<tr data-id="' + esc(f.id) + '" title="双击在线预览，其它格式将直接下载">' +
                '<td class="is-center">' + (i + 1) + '</td>' +
                '<td><b>' + esc(f.fileName) + '</b>' +
                    (f.fileDesc ? '<div class="pj-sub">' + esc(f.fileDesc) + '</div>' : '') + '</td>' +
                '<td>' + esc(f.fileType || '其它') + '</td>' +
                '<td class="is-center">' + esc(f.fileSizeText || '') + '</td>' +
                '<td>' + esc(String(f.uploadTime || '').slice(0, 10)) + '</td>' +
                '</tr>';
        }
        $pfTbody.html(html);
    }
    function loadProjectFiles(row, opts) {
        row = row || selected();
        state.selectedFileId = '';
        state.pfRows = {};
        if (!row) {
            state.pfProjectId = '';
            $('#pfPanelProject').text('未选择项目');
            pfEmpty('双击左侧项目行，这里将显示该项目的文件列表');
            loadDirTree();                 // 同步清空目录树并渲染空态
            syncPfToolbar();
            return;
        }
        state.pfProjectId = row.id;
        $('#pfPanelProject').text('—— ' + row.projectName + '（' + row.projectCode + '）');
        var $busy = busyTarget();
        UI.loading($busy, true, '加载中…');
        Api.projectFile.page({
            projectId: row.id, keyword: state.pfKeyword,
            orderBy: 'fileName', pageNum: 1, pageSize: 200
        }).done(function (data) {
            renderPfRows(data);
            renderTreeView();             // 先用当前目录缓存渲染文件
            syncPfToolbar();
            if (!(opts && opts.skipDirs)) { loadDirTree(); }
        }).fail(function (err) {
            state.pfRows = {};
            pfEmpty((err && err.message) || '文件列表加载失败');
            renderTreeView();
            syncPfToolbar();
        }).always(function () { UI.loading($busy, false); });
    }
    function downloadPanelFile(file) {
        if (!file) { return; }
        Api.projectFile.download(file.id).done(function (res) {
            var url = res.downloadUrl || ('/' + String(res.filePath || '').replace(/^\/+/, ''));
            UI.message({ type: 'success', message: (res && res.message) || '已生成下载地址' });
            try {
                var a = document.createElement('a');
                a.href = url;
                a.setAttribute('download', res.fileName || file.fileName || '');
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } catch (e) { /* 浏览器安全策略拦截时仍可在消息里看到地址 */ }
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '下载失败' });
        });
    }
    function previewPanelFile(file) {
        if (!file) { return; }
        if (!file.enabled) {
            UI.message({ type: 'warning', message: '文件「' + file.fileName + '」已停用，不能预览 / 下载' });
            return;
        }
        if (window.FilePreview && window.FilePreview.preview) {
            window.FilePreview.preview(file, { onDownload: downloadPanelFile });
        } else {
            downloadPanelFile(file);
        }
    }

    /* ---------------- 项目目录视图（「目录」标签页 / 目录维护 / 拖拽移动 / 上传选目录） ---------------- */
    var ICO_FOLDER = '<svg class="pj-tnode__ico" viewBox="0 0 24 24"><path fill="currentColor" d="M3 5h7l2 2h9v12H3V5z"/></svg>';
    var ICO_FILE = '<svg class="pj-tnode__ico" viewBox="0 0 24 24"><path fill="currentColor" d="M6 2h8l5 5v15H6V2zm7 1.5V8h4.5L13 3.5z"/></svg>';

    function treeNodeHtml(kind, item, level, hasChildren, collapsed, selected, dataKind) {
        var indent = 8 + (level - 1) * 16;
        var caret = hasChildren
            ? '<span class="pj-tnode__caret is-clickable" data-toggle="' + esc(item.id) + '">' +
                (collapsed ? '▸' : '▾') + '</span>'
            : '<span class="pj-tnode__caret"></span>';
        var name = kind === 'dir' ? item.dirName : item.fileName;
        var meta = kind === 'dir'
            ? ((parseInt(item.fileCount, 10) || 0) + ' 文件')
            : (item.fileSizeText || '');
        var tip = kind === 'dir'
            ? '单击选中文件夹，可在上方编辑 / 删除；把文件拖到本行或它下面的文件上都算移入本目录'
            : '单击选中、双击在线预览；按住可拖到其它目录（落点所在的文件夹就是目标目录）';
        return '<div class="pj-tnode pj-tnode--' + kind + (selected ? ' is-selected' : '') + '"' +
            ' data-kind="' + (dataKind || kind) + '" data-id="' + esc(item.id) + '"' +
            (kind === 'file' ? ' draggable="true"' : '') +
            ' style="padding-left:' + indent + 'px" title="' + esc(tip) + '">' +
            caret + (kind === 'dir' ? ICO_FOLDER : ICO_FILE) +
            '<span class="pj-tnode__name">' + esc(name) + '</span>' +
            '<span class="pj-tnode__meta">' + esc(meta) + '</span></div>';
    }

    /** 目录节点是否可见：所有祖先都处于展开状态 */
    function treeDirVisible(dir, collapsedMap, dirMap) {
        var p = dir.parentId, guard = 0;
        while (p && guard < 10) {
            if (collapsedMap[p]) { return false; }
            var parent = dirMap[p];
            if (!parent) { break; }
            p = parent.parentId;
            guard++;
        }
        return true;
    }

    /** 只就地刷新选中态，不重建 DOM。
        ------------------------------------------------------------------
        单击选中若调用 renderTreeView()，第一次点击的节点会被整体替换掉；双击的第二次点击
        落在新节点上，浏览器可能把 dblclick 派发给容器而不是节点本身 → 委托到 .pj-tnode 的
        双击预览就匹配不到，表现为「目录视图里双击文件打不开预览」。就地改 class 还能避免
        每次单击重排整棵树（大目录更明显）。 */
    function paintTreeSelection() {
        $pfTreeView.find('.pj-tnode').each(function () {
            var $n = $(this), kind = $n.attr('data-kind'), id = $n.attr('data-id') || '';
            var sel = kind === 'dir'
                ? String(state.selectedDirId) === id
                : (kind === 'file' && String(state.selectedFileId) === id);
            $n.toggleClass('is-selected', sel);
        });
    }

    /** 组装目录 + 文件的树视图（文件取当前检索后的 pfRows） */
    function renderTreeView() {
        if (!$pfTreeView.length) { return; }
        if (!state.pfProjectId) {
            $pfTreeView.html('<div class="pj-tnode__empty">双击左侧项目行，这里将按目录层级展示该项目的文件夹与文件</div>');
            return;
        }
        var dirs = state.dirTree || [], files = [], id, i;
        for (id in state.pfRows) {
            if (state.pfRows.hasOwnProperty(id)) { files.push(state.pfRows[id]); }
        }
        files.sort(function (a, b) {
            var an = String(a.fileName || ''), bn = String(b.fileName || '');
            return an < bn ? -1 : (an > bn ? 1 : 0);
        });
        var childDirs = {}, dirFiles = {}, rootFiles = [];
        for (i = 0; i < dirs.length; i++) {
            var d = dirs[i], key = d.parentId || '';
            if (!childDirs[key]) { childDirs[key] = []; }
            childDirs[key].push(d);
        }
        for (i = 0; i < files.length; i++) {
            var f = files[i], did = f.dirId || '';
            if (did && state.dirRows[did]) {
                if (!dirFiles[did]) { dirFiles[did] = []; }
                dirFiles[did].push(f);
            } else {
                rootFiles.push(f);       // 目录不可见 / 未关联目录 → 挂到项目根
            }
        }
        var html = '';

        var visited = {};                       // 已渲染的目录 id（防环 / 防重复）

        function drawDir(dir, level) {
            if (!dir || !dir.id || visited[dir.id]) { return; }     // 防环 / 防重复
            if (!treeDirVisible(dir, state.treeCollapsed, state.dirRows)) { return; }
            visited[dir.id] = 1;
            level = level || dir.level || 1;
            var kids = childDirs[dir.id] || [], fs = dirFiles[dir.id] || [];
            var collapsed = !!state.treeCollapsed[dir.id];
            html += treeNodeHtml('dir', dir, level,
                kids.length > 0 || fs.length > 0, collapsed,
                String(state.selectedDirId) === String(dir.id));
            if (collapsed) { return; }
            /* 循环变量必须各自独立声明：早期版本复用外层 k，递归返回时会把父层的
               k 重置成 0，父层循环永远停在同一下标反复递归，直到
               RangeError: Invalid string length（目录树整体渲染不出来）。 */
            for (var fi = 0; fi < fs.length; fi++) {
                html += treeNodeHtml('file', fs[fi], level + 1, false, false,
                    String(state.selectedFileId) === String(fs[fi].id));
            }
            for (var ci = 0; ci < kids.length; ci++) { drawDir(kids[ci], level + 1); }
        }
        var roots = childDirs[''] || [];
        for (i = 0; i < roots.length; i++) { drawDir(roots[i], roots[i].level || 1); }
        /* 未关联目录的文件直接挂在最外层，不再有「项目根目录」节点 */
        for (i = 0; i < rootFiles.length; i++) {
            html += treeNodeHtml('file', rootFiles[i], 1, false, false,
                String(state.selectedFileId) === String(rootFiles[i].id));
        }
        if (!dirs.length && !files.length) {
            html += '<div class="pj-tnode__empty">该项目还没有目录与文件，点「创建文件夹」或「上传文件」添加</div>';
        }
        /* 拖拽提示固定追加在列表末尾：放在顶部的话，一按下去这 30 多像素就会把整棵树往下顶，
           鼠标下的行瞬间移位，非常容易拖错（这也是「拖不进某个目录」的观感来源之一）。 */
        html += '<div class="pj-tree__rootdrop" data-drop-root="1" title="拖到此处把文件移出目录">' +
            '松手后文件移出目录，回到项目根</div>';
        $pfTreeView.html(html);
    }

    function loadDirTree() {
        var pid = state.pfProjectId;
        state.dirTree = []; state.dirRows = {}; state.selectedDirId = '';
        if (!pid) { renderTreeView(); syncPfToolbar(); return; }
        Api.projectDir.tree({ projectId: pid }).done(function (data) {
            if (String(state.pfProjectId) !== String(pid)) { return; }  // 防切换项目时的竞态
            state.dirTree = (data && data.list) || [];
            for (var i = 0; i < state.dirTree.length; i++) {
                state.dirRows[state.dirTree[i].id] = state.dirTree[i];
            }
            renderTreeView(); syncPfToolbar();
        }).fail(function () {
            state.dirTree = []; state.dirRows = {};
            renderTreeView(); syncPfToolbar();
        });
    }

    function switchPfView(view) {
        state.pfView = view === 'tree' ? 'tree' : 'list';
        $('#pfTabList').toggleClass('is-active', state.pfView === 'list')
            .attr('aria-selected', state.pfView === 'list' ? 'true' : 'false');
        $('#pfTabTree').toggleClass('is-active', state.pfView === 'tree')
            .attr('aria-selected', state.pfView === 'tree' ? 'true' : 'false');
        $pfWrapper.toggle(state.pfView === 'list');
        $pfTreeView.toggle(state.pfView === 'tree');
        if (state.pfView === 'tree') { renderTreeView(); }
    }

    /* ---------------- 目录维护：创建 / 编辑 / 删除文件夹 ---------------- */
    function openDirForm(mode) {
        var proj = selected();
        if (!state.pfProjectId && proj) {     // 单击选中项目也能直接建目录，顺带同步右栏上下文
            state.pfProjectId = proj.id;
            $('#pfPanelProject').text('—— ' + proj.projectName + '（' + proj.projectCode + '）');
        }
        if (!state.pfProjectId) {
            UI.message({ type: 'warning', message: '请先在左侧选中一个项目' });
            return;
        }
        var edit = mode === 'edit';
        var row = edit ? selectedDir() : null;
        if (edit && !row) {
            UI.message({ type: 'warning', message: '请先在「目录」页选中一个文件夹' });
            return;
        }
        var $form = $('#pjDirTpl').children().clone(true);
        UI.dialog({
            title: edit ? '编辑文件夹 —— ' + row.dirName : '创建文件夹',
            width: 520, content: $form,
            onReady: function ($body) {
                var $f = $body.find('.pj-form');
                $f.find('#dirId').val(edit ? row.id : '');
                $f.find('#dirName').val(edit ? row.dirName : '');
                $f.find('#dirDesc').val(edit ? (row.dirDesc || '') : '');
                $f.find('#dirIspub').val(edit && !row.ispub ? '0' : '1');
                $f.find('#dirEnabled').val(edit && !row.enabled ? '0' : '1');
                var $parent = $f.find('#dirParent');
                $parent.html('<option value="">项目根目录（第一级）</option>');
                Api.projectDir.tree({ projectId: state.pfProjectId, excludeId: edit ? row.id : '' })
                    .done(function (data) {
                        var list = (data && data.list) || [];
                        var html = '<option value="">项目根目录（第一级）</option>';
                        for (var i = 0; i < list.length; i++) {
                            html += '<option value="' + esc(list[i].id) + '">' +
                                esc(list[i].label || list[i].dirName) + '</option>';
                        }
                        $parent.html(html);
                        $parent.val(edit ? (row.parentId || '') : (state.selectedDirId || ''));
                    }).fail(function (err) {
                        UI.message({ type: 'error', message: (err && err.message) || '目录树加载失败' });
                    });
            },
            onOk: function ($body, close) {
                var $f = $body.find('.pj-form');
                var name = $.trim($f.find('#dirName').val());
                if (!name) { UI.message({ type: 'warning', message: '请填写目录名' }); return; }
                var payload = {
                    projectId: state.pfProjectId,
                    parentId: $f.find('#dirParent').val() || '',
                    dirName: name,
                    dirDesc: $.trim($f.find('#dirDesc').val()),
                    ispub: $f.find('#dirIspub').val() === '1' ? 1 : 0,
                    enabled: $f.find('#dirEnabled').val() === '1' ? 1 : 0
                };
                if (edit) { payload.id = row.id; }
                var req = edit ? Api.projectDir.update(payload) : Api.projectDir.add(payload);
                req.done(function () {
                    UI.message({ type: 'success', message: edit ? '文件夹已保存' : '文件夹已创建' });
                    close();
                    loadDirTree();
                    loadProjectFiles(null, { skipDirs: true });
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    function removeDir() {
        var row = selectedDir();
        if (!row) { UI.message({ type: 'warning', message: '请先在「目录」页选中一个文件夹' }); return; }
        UI.confirm({
            title: '删除文件夹', type: 'warning',
            message: '确定删除文件夹「' + row.dirName + '」吗？\n' +
                '子文件夹会移到上一级，文件夹里的文件会回到项目根（不会删除文件）。',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.projectDir.remove(row.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '文件夹已删除' });
                loadDirTree();
                loadProjectFiles(null, { skipDirs: true });
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }

    /* ---------------- 上传弹窗里的所属目录下拉选择（层级用缩进标签表达） ---------------- */
    function renderUploadDirOptions($f) {
        var dirs = state.upDirs || [], html = '<option value="">不选择（文件直接关联项目）</option>', i;
        for (i = 0; i < dirs.length; i++) {
            html += '<option value="' + esc(dirs[i].id) + '">' +
                esc(dirs[i].label || dirs[i].dirName) + '</option>';
        }
        var $sel = $f.find('#upDirId');
        $sel.html(html);
        $sel.val(state.upDirId || '');
        if (!$sel.val()) { state.upDirId = ''; }      // 目录不存在 / 未选 → 回到「不选择」
    }
    function initUploadDirSelect($f, row) {
        state.upDirs = []; state.upDirId = '';
        renderUploadDirOptions($f);
        Api.projectDir.tree({ projectId: row.id }).done(function (data) {
            state.upDirs = (data && data.list) || [];
            renderUploadDirOptions($f);
        }).fail(function () {
            state.upDirs = [];
            renderUploadDirOptions($f);
        });
        $f.find('#upDirId').on('change', function () {
            state.upDirId = $(this).val() || '';
        });
    }

    /* ---------------- 拖拽文件移动到其它目录（目录视图） ---------------- */
    /** 展开目标目录及其所有祖先：避免移动成功后文件被折叠的父目录「藏」起来 */
    function expandDirChain(dirId) {
        var id = dirId, guard = 0;
        while (id && state.dirRows[id] && guard < 12) {
            state.treeCollapsed[id] = false;
            id = state.dirRows[id].parentId || '';
            guard++;
        }
    }
    function moveFileToDir(fileId, dirId) {
        var file = state.pfRows[fileId];
        if (!file) { UI.message({ type: 'warning', message: '找不到被拖动的文件，请刷新后重试' }); return; }
        dirId = dirId || '';
        if (String(file.dirId || '') === String(dirId)) {
            UI.message({ type: 'info', message: '文件「' + file.fileName + '」已在该位置' });
            return;
        }
        var dirName = dirId && state.dirRows[dirId] ? state.dirRows[dirId].dirName : '';
        var $b = busyTarget();
        UI.loading($b, true);
        Api.projectFile.update({ id: file.id, dirId: dirId }).done(function () {
            UI.message({ type: 'success', message: dirId
                ? '文件「' + file.fileName + '」已移动到「' + dirName + '」'
                : '文件「' + file.fileName + '」已移出目录，回到项目根' });
            state.selectedFileId = file.id;
            state.selectedDirId = '';
            expandDirChain(dirId);
            loadProjectFiles();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '移动失败' });
        }).always(function () { UI.loading($b, false); });
    }

    /* ---------------- 右栏文件：启用 / 停用 / 删除（需求⑤） ---------------- */
    function setFileEnabled(on) {
        var f = selectedFile();
        if (!f) { UI.message({ type: 'warning', message: '请先在右侧选中一个文件' }); return; }
        if (!!f.enabled === !!on) {
            UI.message({ type: 'info', message: on ? '该文件已经是启用状态' : '该文件已经是停用状态' });
            return;
        }
        Api.projectFile.setEnabled(f.id, on).done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || (on ? '已启用' : '已停用') });
            loadProjectFiles();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
        });
    }
    function removeFile() {
        var f = selectedFile();
        if (!f) { UI.message({ type: 'warning', message: '请先在右侧选中一个文件' }); return; }
        UI.confirm({
            title: '删除文件', type: 'warning',
            message: '确定删除文件「' + f.fileName + '」吗？（服务器上的文件实体也会一并删除）',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.projectFile.remove(f.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '已删除' });
                state.selectedFileId = '';
                loadProjectFiles();
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }

    /* ---------------- 上传文件弹窗（btnUpload，选中项目后弹出） ---------------- */
    function sizeText(size) {
        var n = parseFloat(size) || 0;
        if (n < 1024) { return Math.round(n) + ' B'; }
        n /= 1024;
        if (n < 1024) { return n.toFixed(1) + ' KB'; }
        return (n / 1024).toFixed(1) + ' MB';
    }
    function fillFileType($sel) {
        var req = Api.projectFile.types().done(function (data) {
            state.fileTypes = (data && data.types) || [];
            var html = '', i;
            for (i = 0; i < state.fileTypes.length; i++) {
                html += '<option value="' + esc(state.fileTypes[i]) + '">' + esc(state.fileTypes[i]) + '</option>';
            }
            $sel.html(html);
            $sel.val('文档');
        }).fail(function () {
            $sel.html('<option value="其它">其它</option>');
        });
        return req;
    }
    function openUpload() {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条项目' }); return; }
        var $form = $('#pjUploadTpl').children().clone(true);
        UI.dialog({
            title: '上传项目文件 —— ' + row.projectName,
            width: 620, content: $form,
            onReady: function ($body) {
                var $f = $body.find('.pj-form');
                $f.find('#upProject').val(row.projectName + '（' + row.projectCode + '）');
                fillFileType($f.find('#upType'));
                initUploadDirSelect($f, row);    // 目录下拉选择（不选 = 直接关联项目）
                $f.find('#upFile').on('change', function () {
                    var file = this.files && this.files[0];
                    if (!file) { return; }
                    if (file.size > MAX_BYTES) {
                        UI.message({ type: 'warning', message: '单个文件不能超过 10 MB' });
                        $f.find('#upData').val('').removeAttr('data-size');
                        $(this).val('');
                        return;
                    }
                    $f.find('#upName').val(file.name);
                    $f.find('#upData').attr('data-size', file.size);
                    var reader = new window.FileReader();
                    reader.onload = function (ev) {
                        $f.find('#upData').val(String(ev.target.result || ''));
                        $f.find('#upFileTip').text('已选择：' + file.name + '（' + sizeText(file.size) + '）');
                    };
                    reader.onerror = function () {
                        UI.message({ type: 'error', message: '文件读取失败，请重新选择' });
                        $f.find('#upData').val('');
                    };
                    reader.readAsDataURL(file);
                });
            },
            onOk: function ($body, close) {
                var $f = $body.find('.pj-form');
                var name = $.trim($f.find('#upName').val());
                var content = $f.find('#upData').val() || '';
                var fileSize = parseInt($f.find('#upData').attr('data-size'), 10) || 0;
                if (!content) { UI.message({ type: 'warning', message: '请选择要上传的文件' }); return; }
                if (!name) { UI.message({ type: 'warning', message: '请填写文件名' }); return; }
                Api.projectFile.upload({
                    projectId: row.id, fileName: name,
                    dirId: $f.find('#upDirId').val() || '',
                    fileType: $f.find('#upType').val() || '其它',
                    fileDesc: $.trim($f.find('#upDesc').val()),
                    ispub: $f.find('#upIspub').val() === '1' ? 1 : 0,
                    enabled: $f.find('#upEnabled').val() === '1' ? 1 : 0,
                    data: content, fileSize: fileSize
                }).done(function (saved) {
                    UI.message({ type: 'success', message: (saved && saved.fileName)
                        ? '文件「' + saved.fileName + '」上传成功' : '上传成功' });
                    close();
                    loadData();            // 刷新左列表的文件数
                    loadProjectFiles();    // 刷新右栏文件列表
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '上传失败' });
                });
            }
        });
    }

    /* ---------------- 项目组（成员从员工信息选取，保存后自动通知） ---------------- */
    function openMembers() {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条项目' }); return; }
        // 模板只当「源码」用：缓存 HTML 后移除源节点，避免克隆出重复 id（#pmCount / #pmSearch ...）
        var tplHtml = window.__pjMembersTplHtml;
        if (!tplHtml) {
            var $src = $('#pjMembersTpl');
            tplHtml = $src.html();
            window.__pjMembersTplHtml = tplHtml;
            $src.remove();
        }
        var $tpl = $(tplHtml);
        var picked = {};          // empId -> 1（勾选中的成员）
        var emps = [];            // 员工信息表（Api.emp.page）
        var keyword = '';
        var loaded = { emps: false, members: false };

        function paint() {
            var $f = $tpl.filter('.pj-members');
            var kw = String(keyword || '').toLowerCase();
            var html = '';
            $.each(emps, function (i, e) {
                var name = e.name || e.nameCn || '';
                var dept = e.deptName || '';
                var job = e.jobTitle || '';
                if (kw && [name, dept, job].join(' ').toLowerCase().indexOf(kw) < 0) { return; }
                var id = String(e.id);
                html += '<label class="pj-members__item">' +
                    '<input type="checkbox" data-emp="' + esc(id) + '"' + (picked[id] ? ' checked' : '') + '>' +
                    '<span class="pj-members__name">' + esc(name) + '</span>' +
                    '<span class="pj-members__sub">' + esc([dept, job].filter(Boolean).join(' · ')) + '</span>' +
                    '<span class="pj-members__mail' + (e.email ? ' is-on' : '') + '">' +
                        (e.email ? esc(e.email) : '无邮箱') + '</span></label>';
            });
            if (!html) {
                html = '<div class="pj-members__item">' +
                    (loaded.emps ? '没有匹配的员工' : '正在加载员工信息…') + '</div>';
            }
            $f.find('#pmList').html(html);
            var n = 0;
            $.each(picked, function (k, v) { if (v) { n++; } });
            $f.find('#pmCount').text(n);
        }

        UI.dialog({
            title: '项目组管理 —— ' + row.projectName,
            width: 760,
            content: $tpl,
            onReady: function ($body) {
                var $f = $body.find('.pj-members');
                $f.find('#pmList').on('change', 'input[data-emp]', function () {
                    var id = $(this).attr('data-emp');
                    if (this.checked) { picked[id] = 1; } else { delete picked[id]; }
                    var n = 0;
                    $.each(picked, function (k, v) { if (v) { n++; } });
                    $f.find('#pmCount').text(n);
                });
                $f.find('#pmSearch').on('input', function () {
                    keyword = $.trim($(this).val());
                    paint();
                });
                paint();

                Api.emp.page({ pageNum: 1, pageSize: 1000 }).done(function (data) {
                    emps = (data && data.list) || [];
                    loaded.emps = true;
                    paint();
                }).fail(function () {
                    loaded.emps = true;
                    paint();
                });

                Api.projectMember.members(row.id).done(function (data) {
                    picked = {};
                    $.each((data && data.list) || [], function (i, m) {
                        picked[String(m.empId)] = 1;
                    });
                    loaded.members = true;
                    paint();
                    $f.find('#pmTip').html(
                        '当前成员 <b>' + ((data && data.list) || []).length + '</b> 人；' +
                        '保存后平台会自动给<b>新加入</b>的成员推送站内即时消息，' +
                        '登记了邮箱的同步发送通知邮件。' +
                        (data && data.emailEnabled === false ? '<br>（服务信箱未启用：本次只会发站内消息）' : ''));
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '成员列表加载失败' });
                });
            },
            onOk: function ($body, close) {
                var ids = [];
                $body.find('#pmList input[data-emp]:checked').each(function () {
                    var n = parseInt($(this).attr('data-emp'), 10);
                    if (n) { ids.push(n); }
                });
                Api.projectMember.save({ projectId: row.id, memberIds: ids }).done(function (res) {
                    UI.message({
                        type: (res && res.mailError) ? 'warning' : 'success',
                        message: (res && res.message) || '项目组已保存'
                    });
                    close();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    /* ---------------- 事件绑定 ---------------- */
    $('#btnSearch').on('click', function () {
        state.keyword = $.trim($('#keyword').val());
        state.projectType = projectMultiValues($('#projectTypeMulti')).join(',');
        state.projectStatus = projectMultiValues($('#projectStatusMulti')).join(',');
        state.ispub = $('#ispub').val();
        state.enabled = $('#enabled').val();
        state.pageNum = 1;
        loadData();
    });
    $('#btnReset').on('click', function () {
        $('#keyword').val('');
        clearProjectMulti($('#projectTypeMulti'));
        clearProjectMulti($('#projectStatusMulti'));
        $('#ispub').val(''); $('#enabled').val('');
        state.keyword = ''; state.projectType = ''; state.projectStatus = '';
        state.ispub = ''; state.enabled = ''; state.pageNum = 1;
        loadData();
    });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnSearch').trigger('click'); } });
    $('#btnAdd').on('click', function () { openFormPage(null); });
    $('#btnEdit').on('click', function () { var row = selected(); if (row) { openFormPage(row); } });
    $('#btnEnable').on('click', function () { setEnabled(true); });
    $('#btnDisable').on('click', function () { setEnabled(false); });
    $('#btnView').on('click', gotoDetail);
    $('#btnUpload').on('click', openUpload);
    $('#btnMembers').on('click', openMembers);
    $('#btnDelete').on('click', removeProject);
    $('#btnRefresh').on('click', loadData);
    $('#btnPfRefresh').on('click', function () { loadProjectFiles(); });
    $('#btnPfSearch').on('click', function () {
        state.pfKeyword = $.trim($('#pfKeyword').val());
        loadProjectFiles();
    });
    $('#pfKeyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnPfSearch').trigger('click'); } });
    $('#btnPfUpload').on('click', openUpload);
    $('#btnPfEnable').on('click', function () { setFileEnabled(true); });
    $('#btnPfDisable').on('click', function () { setFileEnabled(false); });
    $('#btnPfDelete').on('click', removeFile);
    $('#btnPfDownload').on('click', function () {
        var f = selectedFile();
        if (!f) { UI.message({ type: 'warning', message: '请先在右侧选中一个文件' }); return; }
        if (!f.enabled) { UI.message({ type: 'warning', message: '文件「' + f.fileName + '」已停用，不能下载' }); return; }
        downloadPanelFile(f);
    });
    $('#btnDirAdd').on('click', function () { openDirForm('add'); });
    $('#btnDirEdit').on('click', function () { openDirForm('edit'); });
    $('#btnDirDelete').on('click', removeDir);
    $('#pfTabList').on('click', function () { switchPfView('list'); });
    $('#pfTabTree').on('click', function () { switchPfView('tree'); });

    $tbody.on('click', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        $tbody.find('tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        $tbody.find('input[name=pjPick]').prop('checked', false);
        $(this).find('input[name=pjPick]').prop('checked', true);
        syncToolbar();
    });
    /* 双击项目行：刷新右栏文件列表（编辑项目走「编辑」按钮 → project-form.html 打页） */
    $tbody.on('dblclick', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        $tbody.find('tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        $tbody.find('input[name=pjPick]').prop('checked', false);
        $(this).find('input[name=pjPick]').prop('checked', true);
        syncToolbar();
        loadProjectFiles();
    });

    $pfTbody.on('click', 'tr[data-id]', function () {
        state.selectedFileId = $(this).attr('data-id');
        state.selectedDirId = '';          // 目录 / 文件选中互斥
        $pfTbody.find('tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        renderTreeView();
        syncPfToolbar();
    });
    $pfTbody.on('dblclick', 'tr[data-id]', function () {
        var file = state.pfRows[$(this).attr('data-id')];
        if (file) { previewPanelFile(file); }
    });

    /* 目录视图：展开 / 折叠、单击选中（目录或文件）、双击文件预览、拖拽文件移动目录 */
    $pfTreeView.on('click', '.pj-tnode__caret.is-clickable', function (e) {
        e.stopPropagation();
        var id = $(this).attr('data-toggle');
        state.treeCollapsed[id] = !state.treeCollapsed[id];
        renderTreeView();
    });
    $pfTreeView.on('click', '.pj-tnode', function () {
        var kind = $(this).attr('data-kind'), id = $(this).attr('data-id') || '';
        state.selectedDirId = kind === 'dir' ? id : '';
        state.selectedFileId = kind === 'file' ? id : '';
        $pfTbody.find('tr').removeClass('is-selected');
        if (kind === 'file') {
            $pfTbody.find('tr[data-id="' + id + '"]').addClass('is-selected');
        }
        paintTreeSelection();          // 就地改选中态，保留节点（否则双击预览会丢）
        syncPfToolbar();
    });
    /* 双击文件节点 → 在线预览。单击时已就地选中、没有重建 DOM，所以这里的 dblclick
       一定能落在同一个 .pj-tnode--file 上。 */
    $pfTreeView.on('dblclick', '.pj-tnode--file', function (e) {
        e.preventDefault();                        // 防止双击选中标签文字
        var id = $(this).attr('data-id') || '';
        var file = state.pfRows[id];
        if (file) { previewPanelFile(file); return; }
        /* 兜底：文件不在当前检索结果里（刚上传 / 列表被过滤过）时，取一次详情再预览 */
        Api.projectFile.detail(id).done(function (d) {
            if (d) { previewPanelFile(d); }
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '打开文件预览失败' });
        });
    });

    /* 目录视图：文件节点拖拽 → 落到目录节点 / 目录内的子文件 / 列表末尾「移出目录」提示条 / 树内空白区
       ------------------------------------------------------------------
       早期实现把 dragover / drop 委托到 `.pj-tnode--dir` 上，只有当鼠标恰好压在那 30px 的
       目录行上才认落点。非空目录下面紧跟着它的子节点，鼠标稍一下移就落在子文件行上 →
       不阻止默认行为 → 浏览器给出「禁止放置」光标，看起来就是「拖不进非空目录」。
       现改为：整棵树接管 dragover / drop，按**落点坐标**（document.elementFromPoint）
       解析出所属目录 —— 落在子文件上就算该文件所在目录，落在空白区 / 提示条算项目根。
       拿不到坐标时（jsdom 等无布局环境）退回事件目标，保证可单测。 */
    function dragId() {
        return state.dragFileId || '';
    }
    function clearDragState() {
        state.dragFileId = '';
        $pfTreeView.removeClass('is-dragging');
        $pfTreeView.find('.is-dragging, .is-drop-target').removeClass('is-dragging is-drop-target');
    }
    /** 落点元素：优先按坐标命中，取不到坐标时退回事件目标 */
    function dropElementOf(e) {
        var oe = e.originalEvent || {};
        var x = (e.clientX != null) ? e.clientX : oe.clientX;
        var y = (e.clientY != null) ? e.clientY : oe.clientY;
        if (typeof x === 'number' && typeof y === 'number' && document.elementFromPoint) {
            var hit = null;
            try { hit = document.elementFromPoint(x, y); } catch (err) { hit = null; }
            if (hit && $pfTreeView[0] && $pfTreeView[0].contains(hit)) { return hit; }
        }
        return oe.target || e.target || null;
    }
    /** 解析落点 → { dirId, $node }：dirId 为空表示移到项目根 */
    function dropTargetOf(e) {
        var el = dropElementOf(e);
        if (!el) { return null; }
        var $node = $(el).closest('.pj-tnode', $pfTreeView[0]);
        if (!$node.length) { return { dirId: '', $node: $() }; }        // 虚线框 / 空白区 → 项目根
        var kind = $node.attr('data-kind'), id = $node.attr('data-id') || '';
        if (kind === 'file') {
            /* 落在目录里的子文件上 → 目标就是该文件所在的目录（非空目录最常见的情况） */
            var f = state.pfRows[id];
            var did = (f && f.dirId && state.dirRows[f.dirId]) ? String(f.dirId) : '';
            return {
                dirId: did,
                $node: did ? $pfTreeView.find('.pj-tnode--dir[data-id="' + did + '"]').first() : $()
            };
        }
        return { dirId: id, $node: $node };
    }
    /** 拖拽中的落点高亮：目录行高亮（落在子文件上也高亮它所属的目录行） */
    function paintDropTarget(t) {
        $pfTreeView.find('.is-drop-target').removeClass('is-drop-target');
        if (!t) { return; }
        if (t.dirId) {
            if (t.$node && t.$node.length) { t.$node.addClass('is-drop-target'); }
        } else {
            $pfTreeView.find('.pj-tree__rootdrop').addClass('is-drop-target');
        }
    }
    $pfTreeView.on('dragstart', '.pj-tnode--file', function (e) {
        state.dragFileId = $(this).attr('data-id') || '';
        var oe = e.originalEvent || {};
        if (oe.dataTransfer) {
            try {
                oe.dataTransfer.effectAllowed = 'move';
                oe.dataTransfer.setData('text/plain', state.dragFileId);
            } catch (err) { /* 个别浏览器限制 dragstart 里的 dataTransfer，忽略 */ }
        }
        $(this).addClass('is-dragging');
        $pfTreeView.addClass('is-dragging');
    });
    $pfTreeView.on('dragend', '.pj-tnode--file', clearDragState);
    /* dragenter 与 dragover 都要阻止默认行为（Firefox 只看 dragenter），
       且整棵树都接管 —— 只要鼠标在树里就允许放下，落点由坐标解析。 */
    $pfTreeView.on('dragenter dragover', function (e) {
        if (!dragId()) { return; }                  // 只接管树内文件之间的拖拽，外部文件不拦截
        e.preventDefault();
        var oe = e.originalEvent || {};
        if (oe.dataTransfer) { try { oe.dataTransfer.dropEffect = 'move'; } catch (err) { } }
        paintDropTarget(dropTargetOf(e));
    });
    $pfTreeView.on('dragleave', function (e) {
        var oe = e.originalEvent || {}, to = oe.relatedTarget;
        if (to && $pfTreeView[0] && $pfTreeView[0].contains(to)) { return; }   // 树内节点间移动不清高亮
        $pfTreeView.find('.is-drop-target').removeClass('is-drop-target');
    });
    $pfTreeView.on('drop', function (e) {
        var fileId = dragId();
        if (!fileId) { return; }                     // 外部文件拖进树：交回浏览器默认行为（不处理）
        e.preventDefault();
        var t = dropTargetOf(e);
        clearDragState();
        if (t) { moveFileToDir(fileId, t.dirId); }
    });

    restoreState();
    initProjectMulti($('#projectTypeMulti'));
    initProjectMulti($('#projectStatusMulti'));
    syncToolbar();                 // 首屏未选中任何记录时先把编辑 / 上传 / 删除等按钮禁用
    loadTypes();                   // 字典与列表并行加载，互不阻塞（首屏更快）
    loadData();
    loadProjectFiles();            // 右栏初始空态提示
});
