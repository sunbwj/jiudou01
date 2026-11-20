/* ==========================================================================
   project-file.js —— 项目管理 · 项目文件（projectfiles）
   --------------------------------------------------------------------------
   · 检索卡片（所属项目 / 关键字 / 文件类型 / 公用否 / 启用否）→ toolbar → 表格 → 分页；
   · 上传：FileReader 把文件读成 base64（data URL）随表单提交，后端落盘并登记路径；
           编辑时文件输入框留空表示只改说明 / 类型 / 公用否，不替换文件实体；
   · 下载：先调 /projectfile/download 校验可见性与启用状态，再走同源静态路径；
   · 列表 / 详情 / 下载 / 所属项目下拉统一由后端按「本人上传 OR 公用」过滤；
   · 从项目信息页「查看文件」跳来时带 ?projectId=<UUID>，自动按该项目筛选。
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#pfTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var COLS = 10;
    var STATE_KEY = 'project_file_state';
    var MAX_BYTES = 10 * 1024 * 1024;

    var state = {
        keyword: '', projectId: '', fileType: '', ispub: '', enabled: '',
        pageNum: 1, pageSize: 10, total: 0,
        rows: {}, selectedId: '',
        types: [], projects: [],
        // 上传 / 编辑弹窗里的「所属目录」下拉
        formDirs: [], formDirId: '', formDirProject: '', formDirLoaded: false
    };

    function esc(text) { return UI.escapeHtml(text == null ? '' : text); }
    function selected() { return state.rows[state.selectedId] || null; }
    function sizeText(size) {
        var n = parseFloat(size) || 0;
        if (n < 1024) { return Math.round(n) + ' B'; }
        n /= 1024;
        if (n < 1024) { return n.toFixed(1) + ' KB'; }
        return (n / 1024).toFixed(1) + ' MB';
    }
    function queryParam(name) {
        var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search || '');
        return m ? decodeURIComponent(m[1]) : '';
    }

    /* ---------------- 检索条件存取 ---------------- */
    function saveState() {
        try {
            window.sessionStorage.setItem(STATE_KEY, JSON.stringify({
                keyword: state.keyword, projectId: state.projectId, fileType: state.fileType,
                ispub: state.ispub, enabled: state.enabled,
                pageNum: state.pageNum, pageSize: state.pageSize
            }));
        } catch (e) { }
    }
    function restoreState() {
        try {
            var raw = window.sessionStorage.getItem(STATE_KEY);
            if (raw) {
                var s = JSON.parse(raw) || {};
                state.keyword = s.keyword || '';
                state.projectId = s.projectId || '';
                state.fileType = s.fileType || '';
                state.ispub = (s.ispub === 0 || s.ispub) ? String(s.ispub) : '';
                state.enabled = (s.enabled === 0 || s.enabled) ? String(s.enabled) : '';
                state.pageNum = parseInt(s.pageNum, 10) || 1;
                state.pageSize = parseInt(s.pageSize, 10) || 10;
            }
        } catch (e) { }
        var fromUrl = queryParam('projectId');       // 从项目信息页跳来时 URL 优先
        if (fromUrl) { state.projectId = fromUrl; state.pageNum = 1; }
        $('#keyword').val(state.keyword);
    }
    function syncSearch() {
        $('#projectId').val(state.projectId);
        $('#fileType').val(state.fileType);
        $('#ispub').val(state.ispub);
        $('#enabled').val(state.enabled);
    }
    function syncToolbar() {
        var row = selected();
        $('#btnEdit, #btnDownload, #btnEnable, #btnDisable, #btnDelete').prop('disabled', !row);
        if (row) {
            $('#btnEnable').prop('disabled', !!row.enabled);
            $('#btnDisable').prop('disabled', !row.enabled);
        }
    }

    /* ---------------- 字典 / 项目下拉 ---------------- */
    function fillSelect($sel, list, placeholder) {
        var html = placeholder ? '<option value="">' + esc(placeholder) + '</option>' : '';
        for (var i = 0; i < list.length; i++) {
            html += '<option value="' + esc(list[i]) + '">' + esc(list[i]) + '</option>';
        }
        $sel.html(html);
    }
    function typeValues() {
        return $('#fileTypeList input[type=checkbox]:checked').map(function () {
            return $(this).val();
        }).get();
    }
    function syncTypeMulti() {
        var names = $('#fileTypeList input[type=checkbox]:checked').map(function () {
            return $(this).parent().text().replace(/\s+/g, ' ').trim();
        }).get();
        $('#fileTypeMulti').toggleClass('has-value', names.length > 0);
        $('#fileTypeMulti .pf-multi__text').text(names.length ? names.join('、') : '全部类型');
    }
    function fillTypeMulti(types) {
        fillSelect($('#fileType'), types, '全部类型');
        var html = '', checked = String(state.fileType || '').split(','), i;
        for (i = 0; i < types.length; i++) {
            html += '<label class="pf-multi__opt"><input type="checkbox" value="' + esc(types[i]) + '"' +
                ($.inArray(String(types[i]), checked) >= 0 ? ' checked' : '') + '> ' +
                esc(types[i]) + '</label>';
        }
        $('#fileTypeList').html(html || '<div class="pf-multi__empty">暂无类型</div>');
        syncTypeMulti();
    }
    function initTypeMulti() {
        $('#fileTypeMulti .pf-multi__box').on('click', function (e) {
            e.stopPropagation();
            var $drop = $('#fileTypeMulti .pf-multi__drop');
            $drop.prop('hidden', !$drop.prop('hidden'));
        });
        $('#fileTypeMulti .pf-multi__drop').on('click', function (e) { e.stopPropagation(); });
        $('#fileTypeList').on('change', 'input[type=checkbox]', syncTypeMulti);
        $('#fileTypeClear').on('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            $('#fileTypeList input[type=checkbox]').prop('checked', false);
            $('#fileType').val('');
            syncTypeMulti();
        });
        $(document).on('click.pfMulti', function () {
            $('#fileTypeMulti .pf-multi__drop').prop('hidden', true);
        });
    }

    function loadDicts() {
        var typesReq = Api.projectFile.types().done(function (data) {
            state.types = (data && data.types) || [];
            fillTypeMulti(state.types);
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '文件类型字典加载失败' });
        });
        var optionsReq = Api.project.options().done(function (data) {
            state.projects = (data && data.list) || [];
            var html = '<option value="">全部项目</option>', i, one;
            for (i = 0; i < state.projects.length; i++) {
                one = state.projects[i];
                html += '<option value="' + esc(one.id) + '">' + esc(one.label) + '</option>';
            }
            if (state.projectId) {
                var hit = false;
                for (i = 0; i < state.projects.length; i++) {
                    if (String(state.projects[i].id) === String(state.projectId)) { hit = true; break; }
                }
                if (!hit) {
                    html += '<option value="' + esc(state.projectId) + '">当前筛选项目</option>';
                }
            }
            $('#projectId').html(html);
            syncSearch();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '项目下拉加载失败' });
        });
        // 字典与列表并行加载，这里不阻塞列表首屏
        return { types: typesReq, options: optionsReq };
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
        $('#pfCount').text(state.total + '');
        if (!list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '">' +
                '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
                (state.keyword || state.projectId || state.fileType || state.ispub !== '' ||
                 state.enabled !== '' ? '没有符合条件的文件' : '还没有文件，点「上传文件」添加一个') +
                '</span></div></td></tr>');
            syncToolbar();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            state.rows[r.id] = r;
            var idx = (state.pageNum - 1) * state.pageSize + i + 1;
            var desc = r.fileDesc ? ' title="' + esc(r.fileDesc) + '"' : '';
            html += '<tr data-id="' + esc(r.id) + '"' + desc +
                (String(r.id) === String(state.selectedId) ? ' class="is-selected"' : '') + '>' +
                '<td class="is-center">' + idx + '</td>' +
                '<td class="is-center"><label class="el-radio">' +
                    '<input class="el-radio__original" type="radio" name="pfPick" value="' +
                    esc(r.id) + '"' + (String(r.id) === String(state.selectedId) ? ' checked' : '') + '>' +
                    '<span class="el-radio__inner"></span></label></td>' +
                '<td><span class="pj-code">' + esc(r.projectCode || '') + '</span>' +
                    '<div class="pj-sub">' + esc(r.projectName || '') + '</div></td>' +
                '<td><b>' + esc(r.fileName) + '</b></td>' +
                '<td>' + esc(r.fileType || '其它') + '</td>' +
                '<td class="is-center">' + esc(r.fileSizeText || sizeText(r.fileSize)) + '</td>' +
                '<td class="is-center">' + pubBadge(r.ispub) + '</td>' +
                '<td>' + esc(r.uploadEname || '-') + '</td>' +
                '<td>' + esc(r.uploadTime || '') + '</td>' +
                '<td class="is-center">' + badge(r.enabled) + '</td>' +
                '</tr>';
        }
        $tbody.html(html);
        syncToolbar();
    }
    function loadData() {
        UI.loading($wrapper, true, '加载中…');
        Api.projectFile.page({
            keyword: state.keyword, projectId: state.projectId, fileType: state.fileType,
            ispub: state.ispub, enabled: state.enabled,
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

    /* ---------------- 上传 / 编辑 ---------------- */
    function bindFileInput($f) {
        $f.find('#pfFile').on('change', function () {
            var file = this.files && this.files[0];
            if (!file) { return; }
            if (file.size > MAX_BYTES) {
                UI.message({ type: 'warning', message: '单个文件不能超过 10 MB' });
                $f.find('#pfData').val('').removeAttr('data-size');
                $(this).val('');
                return;
            }
            $f.find('#pfName').val(file.name);
            $f.find('#pfData').attr('data-size', file.size);
            var reader = new window.FileReader();
            reader.onload = function (ev) {
                $f.find('#pfData').val(String(ev.target.result || ''));
                $f.find('#pfFileTip').text('已选择：' + file.name + '（' + sizeText(file.size) + '）');
            };
            reader.onerror = function () {
                UI.message({ type: 'error', message: '文件读取失败，请重新选择' });
                $f.find('#pfData').val('');
            };
            reader.readAsDataURL(file);
        });
    }
    /* ---------------- 上传 / 编辑弹窗：所属目录下拉选择（层级用缩进标签表达） ---------------- */
    /** 渲染目录下拉：「不选择」= 文件直接关联项目；label 由后端按层级缩进生成 */
    function renderFormDirOptions($f) {
        var dirs = state.formDirs || [],
            html = '<option value="">不选择（文件直接关联项目）</option>', i;
        for (i = 0; i < dirs.length; i++) {
            html += '<option value="' + esc(dirs[i].id) + '">' +
                esc(dirs[i].label || dirs[i].dirName) + '</option>';
        }
        var $sel = $f.find('#pfDirId');
        $sel.html(html);
        var want = state.formDirId || '';
        $sel.val(want);
        if (want && $sel.val() !== want) {
            /* 目录列表还没回来 → 先留着待回填值；已加载完仍找不到（目录被删 / 不可见）→ 回退「不选择」 */
            if (state.formDirLoaded) { state.formDirId = ''; }
            $sel.val(state.formDirId || '');
        }
    }

    /** 载入某项目的目录下拉：presetId = 编辑时回填的原目录 */
    function loadFormDirs($f, projectId, presetId) {
        state.formDirs = [];
        state.formDirId = presetId || '';
        state.formDirProject = projectId || '';
        state.formDirLoaded = false;
        renderFormDirOptions($f);
        if (!projectId) { state.formDirLoaded = true; return; }
        Api.projectDir.tree({ projectId: projectId }).done(function (data) {
            if (String(state.formDirProject) !== String(projectId)) { return; }   // 切换项目的竞态
            state.formDirs = (data && data.list) || [];
            state.formDirLoaded = true;
            renderFormDirOptions($f);
        }).fail(function () {
            state.formDirs = [];
            state.formDirId = '';
            state.formDirLoaded = true;
            renderFormDirOptions($f);
        });
    }

    /** 绑定：切换所属项目重载下拉、选中同步 state */
    function initFormDirPicker($f, projectId, presetId) {
        loadFormDirs($f, projectId, presetId);
        $f.find('#pfProject').on('change', function () {
            loadFormDirs($f, $(this).val() || '', '');
        });
        $f.find('#pfDirId').on('change', function () {
            state.formDirId = $(this).val() || '';
        });
    }

    function openForm(row) {
        var isEdit = !!row;
        var $form = $('#projectFileFormTpl').children().clone(true);
        UI.dialog({
            title: isEdit ? ('编辑文件 —— ' + row.fileName) : '上传项目文件',
            width: 620, content: $form,
            onReady: function ($body) {
                var $f = $body.find('.pj-form');
                fillSelect($f.find('#pfType'), state.types, '');
                var html = '<option value="">请选择所属项目</option>', i;
                for (i = 0; i < state.projects.length; i++) {
                    html += '<option value="' + esc(state.projects[i].id) + '">' +
                        esc(state.projects[i].label) + '</option>';
                }
                $f.find('#pfProject').html(html);
                if (isEdit) {
                    $f.find('#pfProject').val(row.projectId || '');
                    $f.find('#pfName').val(row.fileName || '');
                    $f.find('#pfType').val(row.fileType || '其它');
                    $f.find('#pfDesc').val(row.fileDesc || '');
                    $f.find('#pfIspub').val((row.ispub === false || row.ispub === 0) ? '0' : '1');
                    $f.find('#pfEnabled').val(row.enabled ? '1' : '0');
                    $f.find('#pfFileTip').text('当前文件：' + (row.fileName || '') +
                        '（' + sizeText(row.fileSize) + '）；留空表示不替换文件');
                } else {
                    $f.find('#pfProject').val(state.projectId || '');
                    $f.find('#pfType').val('文档');
                }
                // 目录树：编辑回填原目录；新增按当前筛选项目预载
                initFormDirPicker($f, $f.find('#pfProject').val() || '',
                    isEdit ? (row.dirId || '') : '');
                bindFileInput($f);
                $f.find('#pfName').trigger('focus');
            },
            onOk: function ($body, close) {
                var $f = $body.find('.pj-form');
                var projectId = $f.find('#pfProject').val() || '';
                var name = $.trim($f.find('#pfName').val());
                var content = $f.find('#pfData').val() || '';
                var fileSize = parseInt($f.find('#pfData').attr('data-size'), 10) || 0;
                if (!projectId) { UI.message({ type: 'warning', message: '请选择所属项目' }); return; }
                if (!isEdit && !content) { UI.message({ type: 'warning', message: '请选择要上传的文件' }); return; }
                if (!name) { UI.message({ type: 'warning', message: '请填写文件名' }); return; }
                var data = {
                    projectId: projectId, fileName: name,
                    dirId: $f.find('#pfDirId').val() || '',
                    fileType: $f.find('#pfType').val() || '其它',
                    fileDesc: $.trim($f.find('#pfDesc').val()),
                    ispub: $f.find('#pfIspub').val() === '1' ? 1 : 0,
                    enabled: $f.find('#pfEnabled').val() === '1' ? 1 : 0
                };
                if (content) { data.data = content; data.fileSize = fileSize; }
                if (isEdit) { data.id = row.id; }
                var req = isEdit ? Api.projectFile.update(data) : Api.projectFile.upload(data);
                req.done(function (saved) {
                    UI.message({ type: 'success', message: isEdit ? '保存成功' : '上传成功' });
                    state.selectedId = (saved && saved.id) || state.selectedId;
                    close();
                    loadData();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    /* ---------------- 下载 / 启用 / 停用 / 删除 ---------------- */
    function downloadFile() {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一个文件' }); return; }
        Api.projectFile.download(row.id).done(function (res) {
            var url = res.downloadUrl || ('/' + String(res.filePath || '').replace(/^\/+/, ''));
            $('#pfLastDownload').attr('data-url', url).attr('data-name', res.fileName || '');
            UI.message({ type: 'success', message: (res && res.message) || '已生成下载地址' });
            try {
                var a = document.createElement('a');
                a.href = url;
                a.setAttribute('download', res.fileName || '');
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } catch (e) { /* 浏览器安全策略拦截时仍可在列表里复制路径 */ }
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '下载失败' });
        });
    }
    function setEnabled(on) {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一个文件' }); return; }
        if (!!row.enabled === !!on) {
            UI.message({ type: 'info', message: on ? '该文件已经是启用状态' : '该文件已经是停用状态' });
            return;
        }
        Api.projectFile.setEnabled(row.id, on).done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || (on ? '已启用' : '已停用') });
            loadData();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
        });
    }
    function removeFile() {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一个文件' }); return; }
        UI.confirm({
            title: '删除文件', type: 'warning',
            message: '确定删除文件「' + row.fileName + '」吗？（服务器上的文件实体也会一并删除）',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.projectFile.remove(row.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '已删除' });
                state.selectedId = '';
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }

    /* ---------------- 事件绑定 ---------------- */
    $('#btnSearch').on('click', function () {
        state.keyword = $.trim($('#keyword').val());
        state.projectId = $('#projectId').val();
        var types = typeValues();
        if (!types.length) {
            var rawType = $('#fileType').val();
            if (rawType) { types = [rawType]; }
        }
        state.fileType = types.join(',');
        state.ispub = $('#ispub').val();
        state.enabled = $('#enabled').val();
        state.pageNum = 1;
        loadData();
    });
    $('#btnReset').on('click', function () {
        $('#keyword').val(''); $('#projectId').val(''); $('#fileType').val('');
        $('#fileTypeList input[type=checkbox]').prop('checked', false);
        syncTypeMulti();
        $('#ispub').val(''); $('#enabled').val('');
        state.keyword = ''; state.projectId = ''; state.fileType = '';
        state.ispub = ''; state.enabled = ''; state.pageNum = 1;
        loadData();
    });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnSearch').trigger('click'); } });
    $('#btnAdd').on('click', function () { openForm(null); });
    $('#btnEdit').on('click', function () { var row = selected(); if (row) { openForm(row); } });
    $('#btnDownload').on('click', downloadFile);
    $('#btnEnable').on('click', function () { setEnabled(true); });
    $('#btnDisable').on('click', function () { setEnabled(false); });
    $('#btnDelete').on('click', removeFile);
    $('#btnRefresh').on('click', loadData);

    $tbody.on('click', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        $tbody.find('tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        $tbody.find('input[name=pfPick]').prop('checked', false);
        $(this).find('input[name=pfPick]').prop('checked', true);
        syncToolbar();
    });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        state.selectedId = $(this).attr('data-id');
        openForm(selected());
    });

    restoreState();
    syncToolbar();                 // 首屏未选中任何文件时先把编辑 / 下载 / 删除等按钮禁用
    initTypeMulti();
    loadDicts();                   // 字典与列表并行加载，互不阻塞
    loadData();
});
