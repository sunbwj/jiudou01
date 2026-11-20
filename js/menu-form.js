/* ==========================================================================
   menu-form.js —— 菜单项新增 / 编辑
   模式：?mode=add   ?mode=edit&id=xxx
   ========================================================================== */
jQuery(function ($) {
    var mode = (UI.param('mode') || 'add').toLowerCase();
    var editId = parseInt(UI.param('id'), 10) || 0;
    var isEdit = (mode === 'edit' && editId > 0);

    var currentIcon = '';
    var submitting = false;

    var RE_CODE = /^[A-Za-z0-9_-]{2,24}$/;
    var RE_EN = /^[A-Za-z][A-Za-z0-9_]{1,39}$/;

    /* 编号自动生成：MNU + 5 位流水号（新增时由服务端按库中已有编号推导） */
    var CODE_RULE_TIP = '由系统自动生成（MNU + 5 位流水号），无需填写';
    var CODE_MANUAL_TIP = '由字母、数字、下划线或短横线组成，<b style="color:#f56c6c">必须唯一</b>';

    /* ---------- 页面标题 ---------- */
    function initTitle() {
        if (isEdit) {
            AppCrumb.setAction('编辑菜单项');
            $('#pageTitle').text('编辑菜单项');
        }
    }

    /** 编号只读态：新增页由系统生成后锁定，避免手改破坏流水号规则 */
    function setCodeReadonly(on) {
        var $input = $('#code');
        $input.prop('readonly', !!on);
        $input.closest('.el-input').toggleClass('is-readonly', !!on);
        $('#codeTip').html(on ? CODE_RULE_TIP : CODE_MANUAL_TIP);
    }

    /** 新增页：显示序号默认取当前最大值 + 1（失败则留空，按 0 处理） */
    function loadNextSortNo() {
        Api.menu.page({ pageNum: 1, pageSize: 200 })
            .done(function (data) {
                var list = (data && data.list) || [], max = 0;
                for (var i = 0; i < list.length; i++) {
                    var n = parseInt(list[i].sortNo, 10);
                    if (!isNaN(n) && n > max) { max = n; }
                }
                if (!$.trim($('#sortNo').val())) { $('#sortNo').val(max + 1); }
            });
    }

    /** 新增页：拉取下一个可用编号；失败则放开手工填写 */
    function loadNextCode() {
        setCodeReadonly(true);
        $('#code').val('');
        Api.menu.nextCode()
            .done(function (data) {
                var code = (data && data.code) ? String(data.code) : '';
                if (!code) {
                    throw new Error('返回编号为空');
                }
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
        var $item = $('#menuForm').find('[data-field="' + field + '"]');
        $item.find('.el-form-item__error').remove();
        if (msg) {
            $item.addClass('is-error');
            $item.find('.el-form-item__content').append('<div class="el-form-item__error">' + msg + '</div>');
        } else {
            $item.removeClass('is-error');
        }
    }
    function clearErrors() {
        $('#menuForm').find('.el-form-item__error').remove();
        $('#menuForm').find('.el-form-item').removeClass('is-error');
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
            title: '选择菜单项图标', width: 520,
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

    /* ---------- 开关 ---------- */
    function syncSwitch() {
        var on = $('#enabled').prop('checked');
        $('#enabledSwitch').toggleClass('is-checked', on);
        $('#enabledText').text(on ? '已启用' : '已停用');
    }

    /* ---------- 表单数据 ---------- */
    function collect() {
        return {
            id: isEdit ? editId : undefined,
            icon: currentIcon,
            code: $.trim($('#code').val()),
            nameCn: $.trim($('#nameCn').val()),
            nameEn: $.trim($('#nameEn').val()),
            sortNo: $.trim($('#sortNo').val()),
            path: $.trim($('#path').val()),
            remark: $.trim($('#remark').val()),
            enabled: $('#enabled').prop('checked') ? 1 : 0
        };
    }

    function fill(data) {
        currentIcon = data.icon || '';
        renderIconPreview();
        $('#code').val(data.code || '');
        $('#nameCn').val(data.nameCn || '');
        $('#nameEn').val(data.nameEn || '');
        $('#sortNo').val(data.sortNo === undefined || data.sortNo === null ? '' : data.sortNo);
        $('#path').val(data.path || '');
        $('#remark').val(data.remark || '');
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
        if (!data.icon) { fail('icon', '请选择菜单项图标'); }
        if (!data.code) { fail('code', '请输入编号'); }
        else if (!RE_CODE.test(data.code)) { fail('code', '编号为2-24位字母、数字、下划线或短横线'); }
        if (!data.nameCn) { fail('nameCn', '请输入中文名'); }
        else if (data.nameCn.length > 20) { fail('nameCn', '中文名不超过20个字符'); }
        if (!data.nameEn) { fail('nameEn', '请输入英文名'); }
        else if (!RE_EN.test(data.nameEn)) { fail('nameEn', '英文名以字母开头，仅含字母、数字、下划线'); }
        if (data.sortNo !== '' && data.sortNo !== undefined) {
            if (!/^\d+$/.test(String(data.sortNo))) { fail('sortNo', '显示序号必须是 0-9999 的整数'); }
            else if (parseInt(data.sortNo, 10) > 9999) { fail('sortNo', '显示序号为 0-9999 之间的整数'); }
        }
        if (data.path && data.path.length > 120) { fail('path', '功能页面地址不超过120个字符'); }
        if (data.remark && data.remark.length > 200) { fail('remark', '功能说明不超过200个字符'); }

        if (first) {
            var $el = $('#menuForm').find('[data-field="' + first + '"]').find('input,textarea,.icon-picker').first();
            if ($el.length) { $el.focus(); }
        }
        return ok;
    }

    /** 远程唯一性校验（网络异常时放行，由服务端最终兜底） */
    function checkUnique(field, value) {
        var dfd = $.Deferred();
        Api.menu.check(field, value, isEdit ? editId : 0)
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
        UI.loading($('#menuForm').parent(), true, '提交中…');

        $.when(checkUnique('code', data.code), checkUnique('nameEn', data.nameEn))
            .done(function (codeOk, enOk) {
                if (!codeOk) { setError('code', '该编号已存在，请重新填写'); }
                if (!enOk) { setError('nameEn', '该英文名已存在，请重新填写'); }
                if (!codeOk || !enOk) {
                    UI.message({ type: 'error', message: '编号或英文名已被占用' });
                    resetBtn();
                    return;
                }
                var req = isEdit ? Api.menu.update(data) : Api.menu.add(data);
                req.done(function () {
                    UI.message({ type: 'success', message: isEdit ? '修改成功' : '新增成功' });
                    AppNav.reloadNav();          // 菜单项增改后重载左侧导航（名称 / 路径 / 启用状态会变）
                    AppNav.go('menu.html', 600);
                }).fail(function (err) {
                    UI.message({ type: 'error', message: err.message || '保存失败' });
                    resetBtn();
                });
            });
    }
    function resetBtn() {
        submitting = false;
        $('#btnSave').removeClass('is-disabled').prop('disabled', false).text('保存');
        UI.loading($('#menuForm').parent(), false);
    }

    /* ---------- 事件 ---------- */
    $('#btnPickIcon, #iconPicker').on('click', openIconDialog);
    $('#btnClearIcon').on('click', function () { currentIcon = ''; renderIconPreview(); });
    $('#enabledSwitch').on('click', function () {
        var $cb = $('#enabled');
        $cb.prop('checked', !$cb.prop('checked'));
        syncSwitch();
    });
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
    $('#btnSave').on('click', submit);
    $('#btnBack').on('click', function () {
        AppNav.go('menu.html');
    });

    /* ---------- 初始化 ---------- */
    initTitle();
    renderIconPreview();
    if (isEdit) {
        UI.loading($('#menuForm').parent(), true, '加载中…');
        Api.menu.detail(editId).done(function (data) {
            fill(data);
        }).fail(function (err) {
            UI.alert({
                title: '加载失败', type: 'error', message: err.message || '菜单项不存在',
                buttonText: '返回列表'
            }).done(function () { AppNav.go('menu.html'); });
        }).always(function () {
            UI.loading($('#menuForm').parent(), false);
        });
    } else {
        syncSwitch();
        loadNextCode();     // 新增：编号按 MNU + 5 位流水号自动生成
        loadNextSortNo();   // 新增：显示序号默认接着最大值往后排
    }
});
