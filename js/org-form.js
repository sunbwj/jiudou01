/* ==========================================================================
   org-form.js —— 部门新增 / 编辑
   模式：?mode=add[&parentId=xxx]   ?mode=edit&id=xxx
   字段：编号（DPT + 4 位流水号自动生成）、部门名称、上级部门、职能说明、排序号、启用否
   保存后返回 org.html，列表页会重新拉取数据并重绘组织架构图
   ========================================================================== */
jQuery(function ($) {
    var mode = (UI.param('mode') || 'add').toLowerCase();
    var editId = parseInt(UI.param('id'), 10) || 0;
    var isEdit = (mode === 'edit' && editId > 0);
    var submitting = false;

    var RE_CODE = /^[A-Za-z0-9_-]{2,24}$/;
    var MAX_LEVEL = 5;

    var CODE_RULE_TIP = '由系统自动生成（DPT + 4 位流水号），无需填写';
    var CODE_MANUAL_TIP = '由字母、数字、下划线或短横线组成，<b style="color:#f56c6c">必须唯一</b>';

    /* ---------- 页面标题 ---------- */
    function initTitle() {
        if (isEdit) {
            AppCrumb.setAction('编辑部门');
            $('#pageTitle').text('编辑部门');
        }
    }

    /* ---------- 错误提示 ---------- */
    function setError(field, msg) {
        var $item = $('#orgForm').find('[data-field="' + field + '"]');
        $item.find('.el-form-item__error').remove();
        if (msg) {
            $item.addClass('is-error');
            $item.find('.el-form-item__content').append('<div class="el-form-item__error">' + msg + '</div>');
        } else {
            $item.removeClass('is-error');
        }
    }
    function clearErrors() {
        $('#orgForm').find('.el-form-item__error').remove();
        $('#orgForm').find('.el-form-item').removeClass('is-error');
    }

    /* ---------- 编号 ---------- */
    function setCodeReadonly(on) {
        var $input = $('#code');
        $input.prop('readonly', !!on);
        $input.closest('.el-input').toggleClass('is-readonly', !!on);
        $('#codeTip').html(on ? CODE_RULE_TIP : CODE_MANUAL_TIP);
    }
    function loadNextCode() {
        setCodeReadonly(true);
        $('#code').val('');
        Api.org.nextCode()
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

    /* ---------- 上级部门下拉 ---------- */
    var levelMap = {};      // 部门ID → 层级（用于提示新增后所处层级）

    function loadParents() {
        var dfd = $.Deferred();
        Api.org.tree({ excludeId: isEdit ? editId : 0 })
            .done(function (res) {
                var list = (res && res.list) ? res.list : [];
                var html = '<option value="0">（顶级部门，无上级）</option>';
                for (var i = 0; i < list.length; i++) {
                    var it = list[i];
                    if (isEdit && it.id === editId) { continue; }
                    levelMap[it.id] = parseInt(it.level, 10) || 1;
                    if (it.id === 0) { continue; }          // 树接口自带的「顶级部门」项已由上面兜底
                    html += '<option value="' + it.id + '">' + UI.escapeHtml(it.label || it.nameCn) + '</option>';
                }
                $('#parentId').html(html);
                dfd.resolve();
            })
            .fail(function (err) {
                UI.message({ type: 'warning', message: '上级部门列表加载失败（' + (err.message || '服务不可用') + '）' });
                dfd.reject(err);
            });
        return dfd.promise();
    }

    function renderLevelTip() {
        var pid = parseInt($('#parentId').val(), 10) || 0;
        var level = pid ? ((levelMap[pid] || 1) + 1) : 1;
        if (level > MAX_LEVEL) {
            $('#levelTip').html('<b style="color:#f56c6c">已超过最大层级（' + MAX_LEVEL + ' 级），请改选上级部门</b>');
        } else {
            $('#levelTip').text('该部门将作为第 ' + level + ' 级部门（最多 ' + MAX_LEVEL + ' 级）');
        }
    }

    /* ---------- 开关 ---------- */
    var enabledLocked = false;      // 下级存在启用状态的部门 → 不允许把本部门停用
    var enabledLockTip = '';

    function syncSwitch() {
        var on = $('#enabled').prop('checked');
        $('#enabledSwitch').toggleClass('is-checked', on);
        $('#enabledText').text(on ? '已启用' : '已停用');
    }
    /* 锁定开关：强制保持「启用」，并给出不能停用的原因 */
    function lockEnabled(tip) {
        enabledLocked = true;
        enabledLockTip = tip || '';
        $('#enabled').prop('checked', true);
        syncSwitch();
        $('#enabledSwitch').addClass('is-disabled').attr('aria-disabled', 'true').attr('title', enabledLockTip);
        $('#enabledTip').html(enabledLockTip).show();
    }
    function unlockEnabled() {
        enabledLocked = false;
        enabledLockTip = '';
        $('#enabledSwitch').removeClass('is-disabled').removeAttr('aria-disabled').removeAttr('title');
        $('#enabledTip').hide().text('');
    }

    /* ---------- 表单数据 ---------- */
    function collect() {
        return {
            id: isEdit ? editId : undefined,
            code: $.trim($('#code').val()),
            nameCn: $.trim($('#nameCn').val()),
            parentId: parseInt($('#parentId').val(), 10) || 0,
            duty: $.trim($('#duty').val()),
            sortNo: parseInt($('#sortNo').val(), 10) || 0,
            enabled: $('#enabled').prop('checked') ? 1 : 0
        };
    }

    function fill(data) {
        $('#code').val(data.code || '');
        $('#nameCn').val(data.nameCn || '');
        $('#duty').val(data.duty || '');
        $('#sortNo').val(parseInt(data.sortNo, 10) || 0);
        $('#enabled').prop('checked', !!data.enabled);
        syncSwitch();
        if (data.parentId) { $('#parentId').val(data.parentId); }
        renderLevelTip();
    }

    /* 编辑页：下级还有启用状态的部门时，锁定「启用」开关（不允许停用本部门） */
    function checkEnabledLock(id, wasEnabled) {
        if (!id || !wasEnabled) { unlockEnabled(); return; }
        Api.org.enabledChildTip(id, '停用本部门').done(function (tip) {
            if (tip) { lockEnabled(tip); } else { unlockEnabled(); }
        });
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
        if (!data.code) { fail('code', '请输入部门编号'); }
        else if (!RE_CODE.test(data.code)) { fail('code', '编号为2-24位字母、数字、下划线或短横线'); }
        if (!data.nameCn) { fail('nameCn', '请输入部门名称'); }
        else if (data.nameCn.length > 50) { fail('nameCn', '部门名称不超过50个字符'); }
        if (data.duty && data.duty.length > 500) { fail('duty', '职能说明不超过500个字符'); }
        var level = data.parentId ? ((levelMap[data.parentId] || 1) + 1) : 1;
        if (level > MAX_LEVEL) { fail('parentId', '最多支持 ' + MAX_LEVEL + ' 级部门'); }
        if (isEdit && data.parentId === editId) { fail('parentId', '上级部门不能是自身'); }
        // 停用保护：下级存在启用状态的部门时，本部门不能被停用
        if (enabledLocked && !data.enabled) { fail('enabled', enabledLockTip || '该部门下有启用状态的下级部门，不能停用'); }

        if (first) {
            var $el = $('#orgForm').find('[data-field="' + first + '"]').find('input,textarea,select').first();
            if ($el.length) { $el.focus(); }
        }
        return ok;
    }

    function checkUnique(field, value) {
        var dfd = $.Deferred();
        Api.org.check(field, value, isEdit ? editId : 0)
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
        UI.loading($('#orgForm').parent(), true, '提交中…');

        checkUnique('code', data.code).done(function (codeOk) {
            if (!codeOk) {
                setError('code', '该编号已存在，请重新填写');
                UI.message({ type: 'error', message: '部门编号已被占用' });
                resetBtn();
                return;
            }
            var req = isEdit ? Api.org.update(data) : Api.org.add(data);
            req.done(function () {
                UI.message({ type: 'success', message: isEdit ? '修改成功' : '新增成功' });
                AppNav.go('org.html', 600);       // 返回列表页 → 列表刷新 + 组织架构图重绘
            }).fail(function (err) {
                UI.message({ type: 'error', message: err.message || '保存失败' });
                resetBtn();
            });
        });
    }
    function resetBtn() {
        submitting = false;
        $('#btnSave').removeClass('is-disabled').prop('disabled', false).text('保存');
        UI.loading($('#orgForm').parent(), false);
    }

    /* ---------- 事件 ---------- */
    $('#enabledSwitch').on('click', function () {
        if (enabledLocked) {
            UI.message({ type: 'warning', message: enabledLockTip || '该部门下有启用状态的下级部门，不能停用' });
            return;
        }
        var $cb = $('#enabled');
        $cb.prop('checked', !$cb.prop('checked'));
        syncSwitch();
    });
    $('#parentId').on('change', renderLevelTip);
    $('#code').on('blur', function () {
        var v = $.trim($(this).val());
        if (!v) { setError('code', '请输入部门编号'); return; }
        if (!RE_CODE.test(v)) { setError('code', '编号为2-24位字母、数字、下划线或短横线'); return; }
        setError('code', '');
        checkUnique('code', v).done(function (ok) {
            if (!ok) { setError('code', '该编号已存在，请重新填写'); }
        });
    });
    $('#nameCn').on('blur', function () {
        setError('nameCn', $.trim($(this).val()) ? '' : '请输入部门名称');
    });
    $('#btnSave').on('click', submit);
    $('#btnBack').on('click', function () { AppNav.go('org.html'); });

    /* ---------- 初始化 ---------- */
    initTitle();
    var parentsReady = loadParents();
    if (isEdit) {
        UI.loading($('#orgForm').parent(), true, '加载中…');
        parentsReady.always(function () {
            Api.org.detail(editId).done(function (data) {
                fill(data);
                checkEnabledLock(editId, !!data.enabled);
            }).fail(function (err) {
                UI.alert({
                    title: '加载失败', type: 'error', message: err.message || '部门不存在',
                    buttonText: '返回列表'
                }).done(function () { AppNav.go('org.html'); });
            }).always(function () {
                UI.loading($('#orgForm').parent(), false);
            });
        });
    } else {
        syncSwitch();
        loadNextCode();     // 新增：编号按 DPT + 4 位流水号自动生成
        var presetParent = parseInt(UI.param('parentId'), 10) || 0;
        if (presetParent) {
            parentsReady.always(function () {
                $('#parentId').val(presetParent);
                renderLevelTip();
            });
        }
    }
});
