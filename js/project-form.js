/* ==========================================================================
   project-form.js —— 项目管理 · 新增 / 编辑项目（独立页，非弹窗）
   --------------------------------------------------------------------------
   · 打页模式：project.html 的「新增 / 编辑 / 双击」都通过 AppNav.go 打开
     project-form.html?mode=add / ?mode=edit&id=<UUID>，保存或返回再 AppNav.go
     回 project.html（框架会关闭表单页签并刷新列表）；
   · 页面 30% 基础信息 + 70% 项目说明编辑区：contenteditable + execCommand 工具栏，
     支持字体 / 字号 / 颜色 / 对齐 / 列表 / 表格 / 标题 / 清除格式 / 源码视图；
   · Word 导入：选择 .docx / .docm → WordImport.fileToBase64 →
     Api.project.importDoc（浏览器本地解析优先，失败自动回落服务端）；
     从 Word 复制粘贴时自动清除 mso-* 私有样式；
   · 保存前统一 WordImport.sanitize 清洗，后端还有一份同口径白名单兜底。
   ========================================================================== */
jQuery(function ($) {
    var mode = String(UI.param('mode') || 'add').toLowerCase();
    var editId = UI.param('id') || '';
    var isEdit = (mode === 'edit' && !!editId);
    var WI = window.WordImport;

    var state = {
        typesLoaded: false, detail: null, submitting: false,
        sourceMode: false, selectInitialized: false, dirty: false
    };
    var savedRange = null;
    var DESC_MAX = 200000;
    var FILE_MAX = 10 * 1024 * 1024;
    var TABLE_HTML = '<table border="1" style="border-collapse:collapse;width:100%">' +
        '<tr><td><br></td><td><br></td><td><br></td></tr>' +
        '<tr><td><br></td><td><br></td><td><br></td></tr>' +
        '<tr><td><br></td><td><br></td><td><br></td></tr></table><p><br></p>';

    function esc(text) {
        return UI.escapeHtml(text == null ? '' : text);
    }
    function fillSelect($sel, list) {
        var html = '', i;
        for (i = 0; i < list.length; i++) {
            html += '<option value="' + esc(list[i]) + '">' + esc(list[i]) + '</option>';
        }
        $sel.html(html);
    }
    /** 历史值兜底：字典里改名 / 停用 / 删除后，老项目的类型可能已不在下拉里，
        这里补一个「（历史值）」选项，避免 select 静默回落到第一项而被误改。 */
    function ensureOption($sel, value) {
        if (!value) { return; }
        var hit = false;
        $sel.find('option').each(function () {
            if ($(this).val() === value) { hit = true; return false; }
        });
        if (!hit) {
            $sel.append('<option value="' + esc(value) + '">' + esc(value) + '（历史值）</option>');
        }
    }
    function markDirty() { state.dirty = true; }

    /* ---------------- 标题 / 面包屑 ---------------- */
    function initTitle() {
        if (isEdit) {
            document.title = '编辑项目 - 九豆综合管理平台';
            $('#pageTitle').text('编辑项目');
            if (window.AppCrumb) { window.AppCrumb.setAction('编辑项目'); }
        }
    }

    /* ---------------- 字典与详情（并行加载，互不阻塞） ---------------- */
    function loadTypes() {
        return Api.project.types().done(function (data) {
            fillSelect($('#pjType'), (data && data.types) || []);
            fillSelect($('#pjStatus'), (data && data.statuses) || []);
            state.typesLoaded = true;
            applySelects();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '项目字典加载失败' });
        });
    }
    function applySelects() {
        if (!state.typesLoaded) { return; }
        if (state.detail) {
            var type = state.detail.projectType || '';
            ensureOption($('#pjType'), type);
            $('#pjType').val(type || $('#pjType option:first').val() || '');
            $('#pjStatus').val(state.detail.projectStatus || '未开始');
            state.selectInitialized = true;
        } else if (!state.selectInitialized) {
            /* 默认取字典第一项（字典可调整排序，不再硬编码「研发」） */
            $('#pjType').val($('#pjType option:first').val() || '研发');
            $('#pjStatus').val('未开始');
        }
    }
    function loadDetail() {
        if (!isEdit) {
            Api.project.nextCode().done(function (res) {
                $('#pjCode').val((res && res.code) || '');
            });
            $('#pjfMeta').text('新增项目 · 编号在保存时由系统生成');
            return;
        }
        UI.loading($('#projectForm').parent(), true, '加载中…');
        return Api.project.detail(editId).done(function (data) {
            state.detail = data || {};
            $('#pjCode').val(state.detail.projectCode || '');
            $('#pjName').val(state.detail.projectName || '');
            $('#pjIspub').val((state.detail.ispub === false || state.detail.ispub === 0) ? '0' : '1');
            $('#pjEnabled').val(state.detail.enabled ? '1' : '0');
            setEditorHtml(WI.ensureHtml(state.detail.projectDesc || ''));
            $('#pjfMeta').text((state.detail.projectCode || '') + ' · 创建人 ' +
                (state.detail.createEname || '-') + ' · 文件 ' +
                (parseInt(state.detail.fileCount, 10) || 0) + ' 个');
            applySelects();
        }).fail(function (err) {
            UI.alert({
                title: '加载失败', type: 'error',
                message: (err && err.message) || '项目不存在或已被删除', buttonText: '返回列表'
            }).done(function () { AppNav.go('project.html'); });
        }).always(function () {
            UI.loading($('#projectForm').parent(), false);
        });
    }

    /* ---------------- 富文本编辑器 ---------------- */
    function currentHtml() {
        var raw = state.sourceMode ? $('#pjDescSource').val() : $('#pjDescEditor').html();
        return WI.sanitize(raw || '');
    }
    function setEditorHtml(html) {
        var safe = WI.sanitize(html || '');
        if (state.sourceMode) { $('#pjDescSource').val(safe); }
        else { $('#pjDescEditor').html(safe); }
        updateCount();
    }
    function updateCount() {
        var html = currentHtml();
        var text = WI.toText(html);
        var paras = (html.match(/<(?:p|h[1-6]|li|blockquote|div)\b/gi) || []).length;
        if (!paras && text) { paras = 1; }
        $('#pjfCount').text(text.length + ' 字 · ' + paras + ' 段');
    }
    function afterChange() {
        markDirty();
        updateCount();
    }
    /** 记住 / 恢复项目说明里的选区：点工具栏或原生下拉时会丢失选区。 */
    function saveSelection() {
        var el = $('#pjDescEditor')[0];
        var sel = window.getSelection ? window.getSelection() : null;
        if (!el || !sel || !sel.rangeCount) { return; }
        var range = sel.getRangeAt(0);
        if (el.contains(range.commonAncestorContainer)) { savedRange = range.cloneRange(); }
    }
    function restoreSelection() {
        var sel = window.getSelection ? window.getSelection() : null;
        if (!savedRange || !sel) { return; }
        try { sel.removeAllRanges(); sel.addRange(savedRange); } catch (e) { /* ignore */ }
    }

    function exec(cmd, value) {
        if (state.sourceMode) {
            UI.message({ type: 'warning', message: '请先切回编辑视图再使用格式工具' });
            return;
        }
        $('#pjDescEditor').trigger('focus');
        restoreSelection();
        try { document.execCommand('styleWithCSS', false, true); } catch (e) { }
        try { document.execCommand(cmd, false, value === undefined ? null : value); } catch (e) { }
        afterChange();
    }
    function insertHtml(html) {
        exec('insertHTML', WI.sanitize(html));
    }

    /* ---------------- Word 导入 ---------------- */
    function applyImported(res) {
        var html = WI.sanitize((res && res.html) || '');
        if (!html) {
            UI.message({ type: 'warning', message: 'Word 文档里没有可导入的文字内容' });
            return;
        }
        function put(replace) {
            setEditorHtml(replace ? html : (currentHtml() + html));
            markDirty();
            $('#pjfHint').text('已导入 ' + ((res && res.fileName) || 'Word 文档') +
                '（' + ((res && res.paragraphs) || 0) + ' 个段落）');
            UI.message({ type: 'success', message: (res && res.message) || 'Word 导入成功' });
        }
        if ($.trim(WI.toText(currentHtml()))) {
            UI.confirm({
                title: '导入 Word', type: 'info',
                message: '项目说明已有内容：点「替换」覆盖现有说明，点「追加」把文档接在末尾。',
                confirmText: '替换', cancelText: '追加'
            }).done(function (ok) { put(!!ok); });
        } else {
            put(true);
        }
    }
    function importWord(file) {
        if (!file) { return; }
        var name = file.name || 'document.docx';
        if (/\.doc$/i.test(name)) {
            UI.message({ type: 'warning', message: '旧版 .doc 请先在 Word / WPS 中另存为 .docx 再导入' });
            return;
        }
        if (!/\.(docx|docm)$/i.test(name)) {
            UI.message({ type: 'warning', message: '只支持 .docx / .docm 格式的 Word 文档' });
            return;
        }
        if (file.size && file.size > FILE_MAX) {
            UI.message({ type: 'warning', message: 'Word 文档不能超过 10 MB' });
            return;
        }
        UI.loading($('#projectForm').parent(), true, '正在解析 Word 文档…');
        function stop() { UI.loading($('#projectForm').parent(), false); }
        $.when(WI.fileToBase64(file)).done(function (dataUrl) {
            Api.project.importDoc({ data: dataUrl, fileName: name })
                .done(applyImported)
                .fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || 'Word 导入失败' });
                })
                .always(stop);
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '读取 Word 文件失败' });
            stop();
        });
    }

    /* ---------------- 保存 / 返回 ---------------- */
    function collect() {
        return {
            projectName: $.trim($('#pjName').val()),
            projectType: $('#pjType').val() || '其它',
            projectStatus: $('#pjStatus').val() || '未开始',
            projectDesc: currentHtml(),
            ispub: $('#pjIspub').val() === '1' ? 1 : 0,
            enabled: $('#pjEnabled').val() === '1' ? 1 : 0
        };
    }
    function validate(data) {
        if (!data.projectName) {
            UI.message({ type: 'warning', message: '请填写项目名称' });
            $('#pjName').trigger('focus');
            return false;
        }
        if (data.projectName.length > 150) {
            UI.message({ type: 'warning', message: '项目名称最多 150 个字符' });
            return false;
        }
        if (data.projectDesc.length > DESC_MAX) {
            UI.message({ type: 'warning', message: '项目说明内容过长，请精简后再保存' });
            return false;
        }
        return true;
    }
    function resetBtn() {
        state.submitting = false;
        $('#btnSave').removeClass('is-disabled').prop('disabled', false).text('保存项目');
    }
    function submit() {
        if (state.submitting) { return; }
        var data = collect();
        if (!validate(data)) { return; }
        if (isEdit) { data.id = editId; }
        state.submitting = true;
        $('#btnSave').addClass('is-disabled').prop('disabled', true).text('保存中…');
        var req = isEdit ? Api.project.update(data) : Api.project.add(data);
        req.done(function () {
            UI.message({ type: 'success', message: isEdit ? '保存成功' : '新增成功' });
            AppNav.go('project.html', 600);        // 框架会关闭表单页签并刷新列表
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
            resetBtn();
        });
    }
    function goBack() { AppNav.go('project.html'); }

    /* ---------------- 事件绑定 ---------------- */
    $('#btnSave').on('click', submit);
    $('#btnBack').on('click', goBack);
    $('#btnImportWord').on('click', function () { $('#pjWordFile').trigger('click'); });
    $('#pjWordFile').on('change', function () {
        var file = this.files && this.files[0];
        importWord(file);
        try { $(this).val(''); } catch (e) { }
    });
    $('#pjType, #pjStatus').on('change', function () { state.selectInitialized = true; });
    $('#pjName, #pjIspub, #pjEnabled').on('change', markDirty);

    $('#pjDescEditor').on('mouseup keyup input focus', saveSelection);
    /* 按钮按下不抢焦点；字号 / 字体下拉保留原生行为，命令执行前再恢复选区 */
    $('#pjfToolbar').on('mousedown', 'button', function (e) { e.preventDefault(); });
    $('#pjfToolbar').on('click', '.pjf-tool', function () {
        var cmd = $(this).attr('data-cmd');
        if (cmd === 'insertTable') { insertHtml(TABLE_HTML); return; }
        exec(cmd);
    });
    $('#pjFontName').on('change', function () {
        var v = $(this).val();
        if (v) { exec('fontName', v); }
        $(this).val('');
    });
    $('#pjFontSize').on('change', function () {
        var v = $(this).val();
        if (v) { exec('fontSize', v); }
        $(this).val('');
    });
    $('#pjBlock').on('change', function () {
        var v = $(this).val();
        if (v) { exec('formatBlock', '<' + v + '>'); }
        $(this).val('');
    });
    $('#pjForeColor').on('change input', function () { exec('foreColor', $(this).val()); });
    $('#pjBackColor').on('change input', function () { exec('hiliteColor', $(this).val()); });

    $('#btnToggleSource').on('click', function () {
        state.sourceMode = !state.sourceMode;
        if (state.sourceMode) {
            $('#pjDescSource').val(WI.sanitize($('#pjDescEditor').html() || ''));
            $('#pjDescEditor').hide();
            $('#pjDescSource').show();
            $('#pjfToolbar').addClass('is-disabled');
            $(this).text('返回编辑');
        } else {
            $('#pjDescEditor').html(WI.sanitize($('#pjDescSource').val() || '')).show();
            $('#pjDescSource').hide();
            $('#pjfToolbar').removeClass('is-disabled');
            $(this).text('查看源码');
        }
        updateCount();
    });

    /* 粘贴：Word 的 HTML 会带 mso-* 私有样式，先清洗再插入；纯文本走转义 */
    $('#pjDescEditor').on('paste', function (e) {
        var oe = e.originalEvent || e;
        var cd = oe.clipboardData || (window.clipboardData || null);
        if (!cd || !cd.getData) { return; }
        var html = cd.getData('text/html') || '';
        var text = cd.getData('text/plain') || '';
        e.preventDefault();
        if (html) {
            var isWord = /mso|word|Microsoft|class\s*=\s*["']?Mso/i.test(html);
            insertHtml(isWord ? WI.cleanWordPaste(html) : WI.sanitize(html));
        } else {
            insertHtml(esc(text).replace(/\n/g, '<br>'));
        }
    });
    $('#pjDescEditor').on('input keyup blur', afterChange);
    $('#pjDescSource').on('input keyup', function () { markDirty(); updateCount(); });

    /* ---------------- 首屏 ---------------- */
    initTitle();
    $('#pjDescSource').hide();
    updateCount();
    loadTypes();                 // 字典、编号 / 详情并行加载，互不阻塞
    loadDetail();
});
