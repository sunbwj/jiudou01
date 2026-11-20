/* ==========================================================================
   menu-group-form.js —— 菜单组新增 / 编辑
   模式：?mode=add   ?mode=edit&id=xxx
   字段：图标、编号（唯一）、中文名、英文名（唯一）、可否绑定菜单项（无默认值，必选）、
        功能页面路径 URL（可否绑定菜单项 = 否时显示，非必填）、启用否
   ========================================================================== */
jQuery(function ($) {
    var mode = (UI.param('mode') || 'add').toLowerCase();
    var editId = parseInt(UI.param('id'), 10) || 0;
    var isEdit = (mode === 'edit' && editId > 0);

    var currentIcon = '';
    var submitting = false;

    var RE_CODE = /^[A-Za-z0-9_-]{2,24}$/;
    var RE_EN = /^[A-Za-z][A-Za-z0-9_]{1,39}$/;

    /* 编号自动生成：MNG + 4 位流水号（新增时由服务端按库中已有编号推导） */
    var CODE_RULE_TIP = '由系统自动生成（MNG + 4 位流水号），无需填写';
    var CODE_MANUAL_TIP = '由字母、数字、下划线或短横线组成，<b style="color:#f56c6c">必须唯一</b>';

    /* ---------- 页面标题 ---------- */
    function initTitle() {
        if (isEdit) {
            AppCrumb.setAction('编辑菜单组');
            $('#pageTitle').text('编辑菜单组');
        }
    }

    /** 编号只读态：新增页由系统生成后锁定，避免手改破坏流水号规则 */
    function setCodeReadonly(on) {
        var $input = $('#code');
        $input.prop('readonly', !!on);
        $input.closest('.el-input').toggleClass('is-readonly', !!on);
        $('#codeTip').html(on ? CODE_RULE_TIP : CODE_MANUAL_TIP);
    }

    /** 新增页：拉取下一个可用编号；失败则放开手工填写 */
    function loadNextCode() {
        setCodeReadonly(true);
        $('#code').val('');
        Api.group.nextCode()
            .done(function (data) {
                var code = (data && data.code) ? String(data.code) : '';
                if (!code) { throw new Error('返回编号为空'); }
                $('#code').val(code);
                setError('code', '');
            })
            .fail(function (err) {
                setCodeReadonly(false);
                $('#code').val('');
                UI.message({ type: 'warning', message: '编号自动生成失败，请手工填写（' + (err.message || '服务不可用') + '）' });
            });
    }

    /* ---------- 错误提示 ---------- */
    function setError(field, msg) {
        var $item = $('#groupForm').find('[data-field="' + field + '"]');
        $item.find('.el-form-item__error').remove();
        if (msg) {
            $item.addClass('is-error');
            $item.find('.el-form-item__content').append('<div class="el-form-item__error">' + msg + '</div>');
        } else {
            $item.removeClass('is-error');
        }
    }
    function clearErrors() {
        $('#groupForm').find('.el-form-item__error').remove();
        $('#groupForm').find('.el-form-item').removeClass('is-error');
    }

    /* ---------- 图标选择 ---------- */
    function renderIconPreview() {
        var icon = Icons.get(currentIcon);
        if (!currentIcon || !icon) {
            $('#iconPreview').html('<svg viewBox="0 0 24 24" width="20" height="20"><g stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></g></svg>');
            $('#iconName').text('未设置');
        } else {
            $('#iconPreview').html(Icons.svg(currentIcon, 20));
            $('#iconName').text(icon.label + '（' + currentIcon + '）');
        }
        setError('icon', '');
    }

    function openIconDialog() {
        var html = '<div class="icon-list">';
        for (var i = 0; i < Icons.list.length; i++) {
            var it = Icons.list[i];
            html += '<span class="icon-list__item' + (it.name === currentIcon ? ' is-active' : '') +
                '" data-icon="' + it.name + '" title="' + it.label + '">' + Icons.svg(it.name, 22) + '</span>';
        }
        html += '</div><p style="color:#909399;font-size:12px;margin-top:6px">共 ' + Icons.list.length + ' 个内置图标，点击图标即可选用。</p>';

        var dlg = UI.dialog({
            title: '选择菜单组图标', width: 520,
            content: html,
            onReady: function ($body, close) {
                $body.on('click', '.icon-list__item', function () {
                    currentIcon = $(this).data('icon');
                    renderIconPreview();
                    close();
                });
            }
        });
        // 图标选择场景隐藏底部“确定”按钮，点击图标即生效
        dlg.el.find('.el-dialog__footer').remove();
    }

    /* ---------- 上级菜单组下拉（多层级） ---------- */
    var parentOptions = [];

    function renderLevelTip() {
        var pid = parseInt($('#parentId').val(), 10) || 0;
        var lv = 1;
        if (pid) {
            for (var i = 0; i < parentOptions.length; i++) {
                if (parentOptions[i].id === pid) {
                    lv = (parseInt(parentOptions[i].level, 10) || 1) + 1;
                    break;
                }
            }
        }
        $('#levelTip').text('当前层级：第 ' + lv + ' 级' + (pid ? '' : '（顶级）'));
    }

    function fillParents(list) {
        parentOptions = list || [];
        var html = '<option value="0">— 顶级菜单组（无上级）—</option>';
        for (var i = 0; i < parentOptions.length; i++) {
            html += '<option value="' + parentOptions[i].id + '">' +
                UI.escapeHtml(parentOptions[i].label || parentOptions[i].nameCn) + '</option>';
        }
        var keep = $('#parentId').val();
        $('#parentId').html(html);
        if (keep) { $('#parentId').val(keep); }
        renderLevelTip();
    }

    /* 编辑时排除自身及其所有下级，避免把上级选成自己或自己的后代 */
    function loadParents() {
        return Api.group.tree({ excludeId: isEdit ? editId : 0 })
            .done(function (res) { fillParents(res.list); })
            .fail(function () { /* 下拉加载失败不阻塞主流程，保存时服务端仍会校验 */ });
    }

    /* ---------- 可否绑定菜单项（无默认值，必须显式选择）：切换时联动功能页面路径 ---------- */
    // 取值：1-是；0-否；null-尚未选择
    function hasChildVal() {
        if ($('#hasChild1').prop('checked')) { return 1; }
        if ($('#hasChild0').prop('checked')) { return 0; }
        return null;
    }
    function hasChild() { return hasChildVal() === 1; }

    function syncHasChild() {
        var v = hasChildVal();
        $('#hasChild1').closest('.el-radio').toggleClass('is-checked', v === 1);
        $('#hasChild0').closest('.el-radio').toggleClass('is-checked', v === 0);
        // 仅显式选择「否」时显示功能页面路径（非必填）；未选择或选择「是」时隐藏
        $('#pathItem').toggleClass('is-hidden', v !== 0);
        if (v !== 0) { setError('path', ''); }
        if (v !== null) { setError('hasChild', ''); }
    }

    /* ---------- 开关 ---------- */
    function syncSwitch() {
        var on = $('#enabled').prop('checked');
        $('#enabledSwitch').toggleClass('is-checked', on);
        $('#enabledText').text(on ? '已启用' : '已停用');
    }

    /* ---------- 表单数据 ---------- */
    function collect() {
        var v = hasChildVal();
        return {
            id: isEdit ? editId : undefined,
            parentId: parseInt($('#parentId').val(), 10) || 0,
            sortNo: parseInt($('#sortNo').val(), 10) || 0,
            icon: currentIcon,
            code: $.trim($('#code').val()),
            nameCn: $.trim($('#nameCn').val()),
            nameEn: $.trim($('#nameEn').val()),
            hasChild: v === null ? null : v,          // 未选择时提交 null，交由必选校验拦截
            path: v === 1 ? '' : $.trim($('#path').val()),
            enabled: $('#enabled').prop('checked') ? 1 : 0
        };
    }

    function fill(data) {
        currentIcon = data.icon || '';
        renderIconPreview();
        $('#code').val(data.code || '');
        $('#nameCn').val(data.nameCn || '');
        $('#nameEn').val(data.nameEn || '');
        $('#parentId').val(parseInt(data.parentId, 10) || 0);
        $('#sortNo').val(parseInt(data.sortNo, 10) || 0);
        renderLevelTip();
        // 可否绑定菜单项必须显式选择（不设默认值）
        var hv = data.hasChild === true || data.hasChild === 1 || data.hasChild === '1' ? 1
            : (data.hasChild === false || data.hasChild === 0 || data.hasChild === '0' ? 0 : null);
        $('#hasChild1').prop('checked', hv === 1);
        $('#hasChild0').prop('checked', hv === 0);
        $('#path').val(data.path || '');
        syncHasChild();
        $('#enabled').prop('checked', !!data.enabled);
        syncSwitch();
    }

    /* ---------- 校验 ---------- */
    function validate(data) {
        clearErrors();
        var ok = true, first = null;
        function fail(field, msg) {
            setError(field, msg);
            if (!first) { first = field; }
            ok = false;
        }
        if (!data.icon) { fail('icon', '请选择菜单组图标'); }
        if (!data.code) { fail('code', '请输入编号'); }
        else if (!RE_CODE.test(data.code)) { fail('code', '编号为2-24位字母、数字、下划线或短横线'); }
        if (!data.nameCn) { fail('nameCn', '请输入中文名'); }
        else if (data.nameCn.length > 20) { fail('nameCn', '中文名不超过20个字符'); }
        if (!data.nameEn) { fail('nameEn', '请输入英文名'); }
        else if (!RE_EN.test(data.nameEn)) { fail('nameEn', '英文名以字母开头，仅含字母、数字、下划线'); }
        if (data.hasChild !== 0 && data.hasChild !== 1) { fail('hasChild', '请选择可否绑定菜单项'); }
        // 功能页面路径非必填，仅校验长度
        if (data.path && data.path.length > 120) { fail('path', '功能页面路径不超过120个字符'); }
        if (isNaN(data.sortNo) || data.sortNo < 0 || data.sortNo > 9999) { fail('sortNo', '排序号为 0-9999 之间的整数'); }

        if (first) {
            var $el = $('#groupForm').find('[data-field="' + first + '"]').find('input,textarea,.icon-picker').first();
            if ($el.length) { $el.focus(); }
        }
        return ok;
    }

    /** 远程唯一性校验（网络异常时放行，由服务端最终兜底） */
    function checkUnique(field, value) {
        var dfd = $.Deferred();
        Api.group.check(field, value, isEdit ? editId : 0)
            .done(function (res) { dfd.resolve(!!res.unique); })
            .fail(function () { dfd.resolve(true); });
        return dfd.promise();
    }

    /* ---------- 提交 ---------- */
    function submit() {
        if (submitting) { return; }
        var data = collect();
        if (!validate(data)) {
            UI.message({ type: 'warning', message: '请检查表单填写项' });
            return;
        }
        submitting = true;
        $('#btnSave').addClass('is-disabled').prop('disabled', true).text('保存中…');
        UI.loading($('#groupForm').parent(), true, '提交中…');

        $.when(checkUnique('code', data.code), checkUnique('nameEn', data.nameEn))
            .done(function (codeOk, enOk) {
                if (!codeOk) { setError('code', '该编号已存在，请重新填写'); }
                if (!enOk) { setError('nameEn', '该英文名已存在，请重新填写'); }
                if (!codeOk || !enOk) {
                    UI.message({ type: 'error', message: '编号或英文名已被占用' });
                    resetBtn();
                    return;
                }
                var req = isEdit ? Api.group.update(data) : Api.group.add(data);
                req.done(function () {
                    UI.message({ type: 'success', message: isEdit ? '修改成功' : '新增成功' });
                    AppNav.reloadNav();          // 菜单组增改后重载左侧导航：同级按排序号升序
                    AppNav.go('menu-group.html', 600);
                }).fail(function (err) {
                    UI.message({ type: 'error', message: err.message || '保存失败' });
                    resetBtn();
                });
            });
    }
    function resetBtn() {
        submitting = false;
        $('#btnSave').removeClass('is-disabled').prop('disabled', false).text('保存');
        UI.loading($('#groupForm').parent(), false);
    }

    /* ---------- 事件 ---------- */
    $('#btnPickIcon, #iconPicker').on('click', openIconDialog);
    $('#btnClearIcon').on('click', function () { currentIcon = ''; renderIconPreview(); });
    $('#enabledSwitch').on('click', function () {
        var $cb = $('#enabled');
        $cb.prop('checked', !$cb.prop('checked'));
        syncSwitch();
    });
    $('input[name="hasChild"]').on('change', syncHasChild);
    $('#parentId').on('change', renderLevelTip);
    $('#code').on('blur', function () {
        var v = $.trim($(this).val());
        if (!v) { setError('code', '请输入编号'); return; }
        if (!RE_CODE.test(v)) { setError('code', '编号为2-24位字母、数字、下划线或短横线'); return; }
        setError('code', '');
        checkUnique('code', v).done(function (ok) {
            if (!ok) { setError('code', '该编号已存在，请重新填写'); }
        });
    });
    $('#nameEn').on('blur', function () {
        var v = $.trim($(this).val());
        if (!v) { setError('nameEn', '请输入英文名'); return; }
        if (!RE_EN.test(v)) { setError('nameEn', '英文名以字母开头，仅含字母、数字、下划线'); return; }
        setError('nameEn', '');
        checkUnique('nameEn', v).done(function (ok) {
            if (!ok) { setError('nameEn', '该英文名已存在，请重新填写'); }
        });
    });
    $('#nameCn').on('blur', function () {
        setError('nameCn', $.trim($(this).val()) ? '' : '请输入中文名');
    });
    $('#path').on('blur', function () {
        var v = $.trim($(this).val());
        setError('path', v.length > 120 ? '功能页面路径不超过120个字符' : '');
    });
    $('#btnSave').on('click', submit);
    $('#btnBack').on('click', function () {
        AppNav.go('menu-group.html');
    });

    /* ---------- 初始化 ---------- */
    initTitle();
    renderIconPreview();
    syncHasChild();

    // 先加载「上级菜单组」下拉，再加载详情，保证回填时能选中正确的上级
    var parentsReady = loadParents();
    if (isEdit) {
        UI.loading($('#groupForm').parent(), true, '加载中…');
        parentsReady.always(function () {
            Api.group.detail(editId).done(function (data) {
                fill(data);
            }).fail(function (err) {
                UI.alert({
                    title: '加载失败', type: 'error', message: err.message || '菜单组不存在',
                    buttonText: '返回列表'
                }).done(function () { AppNav.go('menu-group.html'); });
            }).always(function () {
                UI.loading($('#groupForm').parent(), false);
            });
        });
    } else {
        syncSwitch();
        loadNextCode();     // 新增：编号按 MNG + 4 位流水号自动生成
        // 列表页选中某行后点「新增」→ 默认作为该菜单组的下级
        var presetParent = parseInt(UI.param('parentId'), 10) || 0;
        if (presetParent) {
            parentsReady.always(function () {
                $('#parentId').val(presetParent);
                renderLevelTip();
            });
        }
    }
});
