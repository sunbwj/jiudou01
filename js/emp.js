/* ==========================================================================
   emp.js —— 员工信息管理（单页完成：查询 / 新增 / 编辑 / 删除）
   --------------------------------------------------------------------------
   · 列表：工号 / 姓名（含头像）/ 性别 / 所属部门 / 岗位 / 手机号 / 邮箱 /
          在职状态 / 入职日期 / 学历·职称 / 出生日期
   · 新增与编辑都在本页用弹窗表单完成（不跳转页面），保存后原地刷新列表
   · 工号：自动预取 E + 5 位流水号（可手工编辑，唯一性实时校验）
   · 邮箱：必填 + 格式校验；手机号：选填，填写则校验 11 位
   · 档案字段（均可空）：出生日期、身份证号、最高学历、毕业院校、所学专业、
     执业资格证书、职称、照片（本地压缩为 Base64 后随表单保存）
   · 所属部门下拉来自组织架构（/api/org/tree）
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#empTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var $selTip = $('#selTip');
    var COLS = 13;
    var STATE_KEY = 'emp_admin_list_state';

    var state = {
        keyword: '', status: '', deptId: '',
        pageNum: 1, pageSize: 10, total: 0,
        selectedId: null, selectedName: ''
    };
    var pager = null;
    var deptList = [];          // [{id, label}]
    var rowCache = {};          // 当前页数据（id → 行对象），供编辑 / 双击编辑使用

    var RE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
    var RE_PHONE = /^1[3-9]\d{9}$/;
    var RE_CODE = /^[A-Za-z0-9_-]{2,16}$/;
    var RE_ID_CARD = /^(\d{15}|\d{17}[\dX])$/;
    var RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
    var PHOTO_MAX = 400000;     // 照片（Base64）字符数上限，与后端 EMP_PHOTO_MAX 一致

    var STATUS_TAG = { 1: 'el-tag--success', 2: 'el-tag--warning', 0: 'el-tag--info' };
    var STATUS_TEXT = { 1: '在职', 2: '试用', 0: '离职' };

    /* ---------- 检索条件存取（返回列表时保持） ---------- */
    function saveState() {
        try {
            window.sessionStorage.setItem(STATE_KEY, JSON.stringify({
                keyword: state.keyword, status: state.status, deptId: state.deptId,
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
            state.status = (s.status === 0 || s.status) ? String(s.status) : '';
            state.deptId = s.deptId || '';
            state.pageNum = parseInt(s.pageNum, 10) || 1;
            state.pageSize = parseInt(s.pageSize, 10) || 10;
            $('#keyword').val(state.keyword);
            $('#status').val(state.status);
            $('#deptFilter').val(state.deptId);
        } catch (e) { }
    }

    /* ---------- 行选中 ---------- */
    function rowNo(index) {
        return (parseInt(state.pageNum, 10) - 1) * (parseInt(state.pageSize, 10) || 10) + index + 1;
    }

    /* 姓名列头像：有照片显示照片，无照片用姓名首字占位 */
    function avatarHtml(item) {
        var name = UI.escapeHtml(item.nameCn || '');
        if (item.photo) {
            return '<span class="emp-avatar emp-avatar--img"><img src="' + UI.escapeHtml(item.photo) + '" alt="' + name + '"></span>';
        }
        var txt = item.avatarText || String(item.nameCn || '').slice(0, 1);
        return '<span class="emp-avatar">' + UI.escapeHtml(txt) + '</span>';
    }

    function rowHtml(item, index) {
        var selected = state.selectedId === item.id;
        var st = parseInt(item.status, 10);
        if (isNaN(st)) { st = 1; }
        return '' +
            '<tr data-id="' + item.id + '" data-name="' + UI.escapeHtml(item.nameCn) + '"' + (selected ? ' class="current-row"' : '') + '>' +
                '<td class="is-center el-table__index-cell" data-label="序号"><div class="cell cell-index">' + rowNo(index) + '</div></td>' +
                '<td class="is-center el-table__radio-cell" data-label="选择"><div class="cell">' +
                    '<label class="el-radio' + (selected ? ' is-checked' : '') + '">' +
                        '<input class="el-radio__original" type="radio" name="empRow" value="' + item.id + '"' + (selected ? ' checked' : '') + '>' +
                        '<span class="el-radio__inner"></span>' +
                    '</label>' +
                '</div></td>' +
                '<td data-label="工号"><div class="cell cell-mono">' + UI.escapeHtml(item.code || '') + '</div></td>' +
                '<td data-label="姓名"><div class="cell cell-strong emp-name">' + avatarHtml(item) +
                    '<span class="emp-name__text">' + UI.escapeHtml(item.nameCn || '') + '</span></div></td>' +
                '<td class="is-center" data-label="性别"><div class="cell">' + UI.escapeHtml(item.genderText || (Number(item.gender) === 2 ? '女' : '男')) + '</div></td>' +
                '<td data-label="所属部门"><div class="cell">' + UI.escapeHtml(item.deptName || '—（未分配）') + '</div></td>' +
                '<td data-label="岗位"><div class="cell">' + UI.escapeHtml(item.jobTitle || '-') + '</div></td>' +
                '<td data-label="手机号"><div class="cell cell-mono">' + UI.escapeHtml(item.phone || '-') + '</div></td>' +
                '<td data-label="邮箱"><div class="cell cell-desc">' + UI.escapeHtml(item.email || '-') + '</div></td>' +
                '<td class="is-center" data-label="在职状态"><div class="cell">' +
                    '<span class="el-tag el-tag--small ' + (STATUS_TAG[st] || 'el-tag--info') + '">' + (item.statusText || STATUS_TEXT[st] || '-') + '</span>' +
                '</div></td>' +
                '<td data-label="入职日期"><div class="cell">' + UI.escapeHtml(item.hireDate || '-') + '</div></td>' +
                '<td data-label="学历 / 职称"><div class="cell cell-desc">' + UI.escapeHtml(item.archiveText || '-') + '</div></td>' +
                '<td data-label="出生日期"><div class="cell">' + UI.escapeHtml(item.birthDate || '-') + '</div></td>' +
            '</tr>';
    }

    function renderTable(list) {
        rowCache = {};
        if (!list || !list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">暂无数据</span></div></td></tr>');
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            rowCache[list[i].id] = list[i];
            html += rowHtml(list[i], i);
        }
        $tbody.html(html);
    }

    function selectRow($tr) {
        $tbody.find('tr').removeClass('current-row');
        $tbody.find('.el-radio').removeClass('is-checked').find('input').prop('checked', false);
        if (!$tr || !$tr.length) {
            state.selectedId = null;
            state.selectedName = '';
            $selTip.text('未选择任何员工');
            return;
        }
        $tr.addClass('current-row');
        $tr.find('.el-radio').addClass('is-checked').find('input').prop('checked', true);
        state.selectedId = parseInt($tr.attr('data-id'), 10);
        state.selectedName = $tr.attr('data-name') || '';
        $selTip.text(state.selectedName ? ('【' + state.selectedName + '】') : ('ID ' + state.selectedId));
    }
    function clearSelect() { selectRow(null); }

    /* ---------- 数据加载 ---------- */
    function loadData() {
        UI.loading($wrapper, true, '加载中…');
        Api.emp.page({
            keyword: state.keyword, status: state.status, deptId: state.deptId,
            pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (data) {
            var list = (data && data.list) || [];
            state.total = (data && data.total) || 0;
            state.pageNum = (data && data.pageNum) || state.pageNum;
            if (state.selectedId) {
                var keep = null;
                for (var i = 0; i < list.length; i++) { if (list[i].id === state.selectedId) { keep = list[i]; } }
                if (!keep) { clearSelect(); }
            }
            renderTable(list);
            renderPager();
        }).fail(function (err) {
            UI.message({ type: 'error', message: err.message || '查询失败' });
        }).always(function () {
            UI.loading($wrapper, false);
        });
    }

    function renderPager() {
        pager = UI.pagination($pagerWrap, {
            total: state.total, pageNum: state.pageNum, pageSize: state.pageSize,
            onChange: function (pageNum, pageSize) {
                state.pageNum = pageNum;
                state.pageSize = pageSize;
                saveState();
                loadData();
            }
        });
    }

    /* ---------- 所属部门下拉 ---------- */
    function loadDepts() {
        var dfd = $.Deferred();
        Api.org.tree({}).done(function (res) {
            deptList = [];
            var list = (res && res.list) || [];
            for (var i = 0; i < list.length; i++) {
                if (!list[i].id) { continue; }        // 跳过「（顶级部门）」占位项
                deptList.push({ id: list[i].id, label: list[i].label || list[i].nameCn });
            }
            var html = '<option value="">全部</option>';
            for (var j = 0; j < deptList.length; j++) {
                html += '<option value="' + deptList[j].id + '">' + UI.escapeHtml(deptList[j].label) + '</option>';
            }
            $('#deptFilter').html(html).val(state.deptId || '');
            dfd.resolve();
        }).fail(function () {
            dfd.resolve();      // 部门列表拉不到不影响主流程
        });
        return dfd.promise();
    }

    /* ---------- 弹窗表单（新增 / 编辑） ---------- */
    function fieldOf($form, name) { return $form.find('[name="' + name + '"]'); }

    function clearErrors($form) {
        $form.find('.el-form-item__error').remove();
        $form.find('.el-form-item').removeClass('is-error');
    }
    function setError($form, field, msg) {
        var $item = $form.find('[data-field="' + field + '"]');
        $item.find('.el-form-item__error').remove();
        if (msg) {
            $item.addClass('is-error');
            $item.find('.el-form-item__content').append('<div class="el-form-item__error">' + msg + '</div>');
        } else {
            $item.removeClass('is-error');
        }
    }

    function fillDeptSelect($form, value) {
        var html = '<option value="0">（未分配部门）</option>';
        for (var i = 0; i < deptList.length; i++) {
            html += '<option value="' + deptList[i].id + '">' + UI.escapeHtml(deptList[i].label) + '</option>';
        }
        fieldOf($form, 'deptId').html(html).val(String(value || 0));
    }

    function collectForm($form) {
        return {
            id: $form.data('editId') || undefined,
            code: $.trim(fieldOf($form, 'code').val()),
            nameCn: $.trim(fieldOf($form, 'nameCn').val()),
            gender: parseInt(fieldOf($form, 'gender').val(), 10) || 1,
            deptId: parseInt(fieldOf($form, 'deptId').val(), 10) || 0,
            jobTitle: $.trim(fieldOf($form, 'jobTitle').val()),
            phone: $.trim(fieldOf($form, 'phone').val()).replace(/[\s-]/g, ''),
            email: $.trim(fieldOf($form, 'email').val()).toLowerCase(),
            status: parseInt(fieldOf($form, 'status').val(), 10),
            hireDate: $.trim(fieldOf($form, 'hireDate').val()),
            // ---- 档案字段 ----
            birthDate: $.trim(fieldOf($form, 'birthDate').val()),
            idCard: $.trim(fieldOf($form, 'idCard').val()).replace(/\s/g, '').toUpperCase(),
            education: $.trim(fieldOf($form, 'education').val()),
            school: $.trim(fieldOf($form, 'school').val()),
            major: $.trim(fieldOf($form, 'major').val()),
            certificates: $.trim(fieldOf($form, 'certificates').val()),
            titleName: $.trim(fieldOf($form, 'titleName').val()),
            photo: fieldOf($form, 'photo').val() || '',
            remark: $.trim(fieldOf($form, 'remark').val())
        };
    }

    function validateForm($form, data) {
        clearErrors($form);
        var ok = true, first = null;
        function fail(field, msg) {
            setError($form, field, msg);
            if (!first) { first = field; }
            ok = false;
        }
        if (!data.code) { fail('code', '请输入工号'); }
        else if (!RE_CODE.test(data.code)) { fail('code', '工号为 2-16 位字母、数字、下划线或短横线'); }
        if (!data.nameCn) { fail('nameCn', '请输入姓名'); }
        else if (data.nameCn.length > 50) { fail('nameCn', '姓名不超过 50 个字符'); }
        if (!data.email) { fail('email', '请输入邮箱'); }
        else if (!RE_EMAIL.test(data.email)) { fail('email', '邮箱格式不正确（如 name@example.com）'); }
        if (data.phone && !RE_PHONE.test(data.phone)) { fail('phone', '手机号应为 1 开头的 11 位数字'); }
        if ([0, 1, 2].indexOf(data.status) < 0) { fail('status', '请选择在职状态'); }
        // 档案字段（均可空，填了才校验）
        if (data.birthDate) {
            if (!RE_DATE.test(data.birthDate)) { fail('birthDate', '出生日期格式应为 YYYY-MM-DD'); }
            else if (data.birthDate > today()) { fail('birthDate', '出生日期不能晚于今天'); }
        }
        if (data.idCard && !RE_ID_CARD.test(data.idCard)) {
            fail('idCard', '身份证号应为 15 位或 18 位（18 位末位可为 X）');
        }
        if (data.school && data.school.length > 100) { fail('school', '毕业院校不超过 100 个字符'); }
        if (data.major && data.major.length > 100) { fail('major', '所学专业不超过 100 个字符'); }
        if (data.certificates && data.certificates.length > 200) { fail('certificates', '执业资格证书不超过 200 个字符'); }
        if (data.titleName && data.titleName.length > 50) { fail('titleName', '职称不超过 50 个字符'); }
        if (data.photo && data.photo.length > PHOTO_MAX) { fail('photo', '照片体积过大，请重新选择更小的图片'); }
        if (data.remark && data.remark.length > 200) { fail('remark', '备注不超过 200 个字符'); }
        if (first) {
            var $el = $form.find('[data-field="' + first + '"]').find('input,select,textarea').first();
            if ($el.length) { $el.focus(); }
        }
        return ok;
    }

    /* 今天（YYYY-MM-DD），用于日期上限校验 */
    function today() {
        var d = new Date();
        var mm = d.getMonth() + 1, dd = d.getDate();
        return d.getFullYear() + '-' + (mm < 10 ? '0' + mm : mm) + '-' + (dd < 10 ? '0' + dd : dd);
    }

    /* 从身份证号解析出生日期（18 位取 7-14 位；15 位补 19 前缀） */
    function birthFromIdCard(idCard) {
        var v = String(idCard || '');
        var y, m, d;
        if (v.length === 18) {
            y = v.substr(6, 4); m = v.substr(10, 2); d = v.substr(12, 2);
        } else if (v.length === 15) {
            y = '19' + v.substr(6, 2); m = v.substr(8, 2); d = v.substr(10, 2);
        } else {
            return '';
        }
        var dt = y + '-' + m + '-' + d;
        return RE_DATE.test(dt) ? dt : '';
    }

    /* ---------- 照片：本地压缩为 Base64（300px 以内，JPEG），无需服务端上传接口 ---------- */
    function setPhoto($form, dataUrl) {
        fieldOf($form, 'photo').val(dataUrl || '');
        var $pv = $form.find('.emp-photo__preview');
        if (dataUrl) {
            $pv.addClass('has-img').html('<img src="' + dataUrl + '" alt="照片">');
        } else {
            $pv.removeClass('has-img').html('<span class="emp-photo__ph">暂无照片</span>');
        }
        setError($form, 'photo', '');
    }

    function compressImage(file, maxSize, done, fail) {
        if (!file) { return; }
        if (file.type && file.type.indexOf('image/') !== 0) {
            fail('请选择 JPG / PNG / WebP 格式的图片');
            return;
        }
        var reader = new FileReader();
        reader.onload = function (e) {
            var raw = e.target.result;
            try {
                var img = new Image();
                img.onload = function () {
                    var w = img.width || maxSize, h = img.height || maxSize;
                    var scale = Math.min(1, maxSize / Math.max(w, h));
                    if (scale >= 1 && raw.length <= 80000) {      // 小图直接用，避免二次编码损失
                        done(raw);
                        return;
                    }
                    try {
                        var cw = Math.max(1, Math.round(w * scale));
                        var ch = Math.max(1, Math.round(h * scale));
                        var canvas = document.createElement('canvas');
                        canvas.width = cw;
                        canvas.height = ch;
                        var ctx = canvas.getContext('2d');
                        if (!ctx) { done(raw); return; }        // 环境无 canvas → 退回原图
                        ctx.drawImage(img, 0, 0, cw, ch);
                        done(canvas.toDataURL('image/jpeg', 0.82));
                    } catch (err) {
                        done(raw);
                    }
                };
                img.onerror = function () { done(raw); };
                img.src = raw;
            } catch (err) {
                done(raw);          // 环境不支持 canvas / Image 时退回原图（仍受体积上限保护）
            }
        };
        reader.onerror = function () { fail('读取图片失败，请重试'); };
        reader.readAsDataURL(file);
    }

    function checkCodeUnique(code, selfId) {
        var dfd = $.Deferred();
        Api.emp.check('code', code, selfId || 0)
            .done(function (res) { dfd.resolve(!!res.unique); })
            .fail(function () { dfd.resolve(true); });      // 校验接口异常时不阻断，由后端兜底
        return dfd.promise();
    }

    /**
     * 打开新增 / 编辑弹窗
     * @param {String} mode 'add' | 'edit'
     * @param {Object} row  编辑时的行数据（列表已含全部字段）
     */
    function openForm(mode, row) {
        var isEdit = (mode === 'edit');
        var $form = $('#empFormTpl').find('.emp-form').clone();
        fillDeptSelect($form, isEdit ? row.deptId : 0);

        if (isEdit) {
            $form.data('editId', row.id);
            fieldOf($form, 'code').val(row.code || '');
            fieldOf($form, 'nameCn').val(row.nameCn || '');
            fieldOf($form, 'gender').val(String(Number(row.gender) === 2 ? 2 : 1));
            fieldOf($form, 'jobTitle').val(row.jobTitle || '');
            fieldOf($form, 'phone').val(row.phone || '');
            fieldOf($form, 'email').val(row.email || '');
            fieldOf($form, 'status').val(String(parseInt(row.status, 10) || 0));
            fieldOf($form, 'hireDate').val(String(row.hireDate || '').slice(0, 10));
            // ---- 档案字段回填 ----
            fieldOf($form, 'birthDate').val(String(row.birthDate || '').slice(0, 10));
            fieldOf($form, 'idCard').val(row.idCard || '');
            var eduVal = row.education || '';
            var $edu = fieldOf($form, 'education');
            if (eduVal && !$edu.find('option[value="' + eduVal + '"]').length) {
                $edu.append('<option value="' + UI.escapeHtml(eduVal) + '">' + UI.escapeHtml(eduVal) + '</option>');
            }
            $edu.val(eduVal);
            fieldOf($form, 'school').val(row.school || '');
            fieldOf($form, 'major').val(row.major || '');
            fieldOf($form, 'certificates').val(row.certificates || '');
            fieldOf($form, 'titleName').val(row.titleName || '');
            setPhoto($form, row.photo || '');
            fieldOf($form, 'remark').val(row.remark || '');
            $form.find('#empCodeTip').text('工号可修改，需保持唯一（规则 E + 5 位流水号）');
        } else {
            fieldOf($form, 'code').val('');
            fieldOf($form, 'status').val('1');
            fieldOf($form, 'gender').val('1');
            fieldOf($form, 'birthDate').attr('max', today());
            // 新增：工号自动预取（E + 5 位流水号），可手工改写
            Api.emp.nextCode().done(function (res) {
                if (res && res.code && !$.trim(fieldOf($form, 'code').val())) {
                    fieldOf($form, 'code').val(res.code);
                }
            }).fail(function () {
                $form.find('#empCodeTip').text('工号自动生成失败，请手工填写（E + 5 位流水号）');
            });
        }

        var submitting = false;

        UI.dialog({
            title: isEdit ? ('编辑员工 —— ' + (row.nameCn || '')) : '新增员工',
            width: 880,
            content: $form,
            onReady: function ($body) {
                var $f = $body.find('.emp-form');
                fieldOf($f, 'birthDate').attr('max', today());       // 出生日期不能选到今天之后
                // 工号失焦即校验唯一性
                fieldOf($f, 'code').on('blur', function () {
                    var v = $.trim($(this).val()).toUpperCase();
                    $(this).val(v);
                    if (!v) { setError($f, 'code', '请输入工号'); return; }
                    if (!RE_CODE.test(v)) { setError($f, 'code', '工号为 2-16 位字母、数字、下划线或短横线'); return; }
                    checkCodeUnique(v, isEdit ? row.id : 0).done(function (unique) {
                        setError($f, 'code', unique ? '' : '该工号已存在，请重新填写');
                    });
                });
                fieldOf($f, 'email').on('blur', function () {
                    var v = $.trim($(this).val());
                    if (!v) { setError($f, 'email', '请输入邮箱'); return; }
                    setError($f, 'email', RE_EMAIL.test(v) ? '' : '邮箱格式不正确（如 name@example.com）');
                });
                fieldOf($f, 'phone').on('blur', function () {
                    var v = $.trim($(this).val()).replace(/[\s-]/g, '');
                    setError($f, 'phone', (!v || RE_PHONE.test(v)) ? '' : '手机号应为 1 开头的 11 位数字');
                });
                // 身份证号：失焦校验，并自动带出出生日期（出生日期为空时）
                fieldOf($f, 'idCard').on('blur', function () {
                    var v = $.trim($(this).val()).replace(/\s/g, '').toUpperCase();
                    $(this).val(v);
                    if (!v) { setError($f, 'idCard', ''); return; }
                    if (!RE_ID_CARD.test(v)) {
                        setError($f, 'idCard', '身份证号应为 15 位或 18 位（18 位末位可为 X）');
                        return;
                    }
                    setError($f, 'idCard', '');
                    var birth = birthFromIdCard(v);
                    if (birth && !$.trim(fieldOf($f, 'birthDate').val())) {
                        fieldOf($f, 'birthDate').val(birth);
                    }
                });
                // 照片：选择图片 → 本地压缩 → 预览；清除 → 置空
                $f.find('#btnPickPhoto').on('click', function () {
                    $f.find('#empPhotoFile').trigger('click');
                });
                $f.find('#empPhotoFile').on('change', function () {
                    var file = this.files && this.files[0];
                    this.value = '';            // 允许重复选择同一文件
                    compressImage(file, 300, function (dataUrl) {
                        if (dataUrl.length > PHOTO_MAX) {
                            setError($f, 'photo', '照片体积过大，请选择更小的图片');
                            return;
                        }
                        setPhoto($f, dataUrl);
                    }, function (msg) {
                        setError($f, 'photo', msg);
                    });
                });
                $f.find('#btnClearPhoto').on('click', function () { setPhoto($f, ''); });
                fieldOf($f, 'code').focus();
            },
            onOk: function ($body, close) {
                if (submitting) { return; }
                var $f = $body.find('.emp-form');
                var data = collectForm($f);
                if (!validateForm($f, data)) {
                    UI.message({ type: 'warning', message: '请检查表单填写项' });
                    return;
                }
                submitting = true;
                var $ok = $body.closest('.el-dialog').find('.btn-ok');
                $ok.addClass('is-disabled').prop('disabled', true).text('保存中…');

                function reset() {
                    submitting = false;
                    $ok.removeClass('is-disabled').prop('disabled', false).text('确定');
                }

                checkCodeUnique(data.code, isEdit ? row.id : 0).done(function (unique) {
                    if (!unique) {
                        setError($f, 'code', '该工号已存在，请重新填写');
                        UI.message({ type: 'error', message: '工号【' + data.code + '】已被占用' });
                        reset();
                        return;
                    }
                    var req = isEdit ? Api.emp.update(data) : Api.emp.add(data);
                    req.done(function () {
                        close();
                        UI.message({ type: 'success', message: isEdit ? '修改成功' : '新增成功' });
                        if (!isEdit) { state.pageNum = 1; }
                        loadData();
                    }).fail(function (err) {
                        UI.message({ type: 'error', message: err.message || '保存失败' });
                        reset();
                    });
                });
            }
        });
    }

    /* ---------- 事件 ---------- */
    // 行点击 → 选中；双击 → 编辑
    $tbody.on('click', 'tr[data-id]', function () { selectRow($(this)); });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        selectRow($(this));
        var row = rowCache[parseInt($(this).attr('data-id'), 10)];
        if (row) { openForm('edit', row); }
    });

    function doSearch(reset) {
        if (reset) {
            $('#keyword').val('');
            $('#status').val('');
            $('#deptFilter').val('');
            state.keyword = '';
            state.status = '';
            state.deptId = '';
        } else {
            state.keyword = $.trim($('#keyword').val());
            state.status = $('#status').val() || '';
            state.deptId = $('#deptFilter').val() || '';
        }
        state.pageNum = 1;
        clearSelect();
        saveState();
        loadData();
    }

    $('#status').on('change', function () { doSearch(false); });
    $('#deptFilter').on('change', function () { doSearch(false); });
    $('#btnSearch').on('click', function () { doSearch(false); });
    $('#btnReset').on('click', function () { doSearch(true); });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { doSearch(false); } });

    $('#btnAdd').on('click', function () { openForm('add'); });

    $('#btnEdit').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在列表中选择一个要编辑的员工。' });
            return;
        }
        var row = rowCache[state.selectedId];
        if (!row) { UI.message({ type: 'error', message: '数据已失效，请刷新后重试' }); return; }
        openForm('edit', row);
    });

    $('#btnDelete').on('click', function () {
        if (!state.selectedId) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在列表中选择一个要删除的员工。' });
            return;
        }
        var id = state.selectedId, name = state.selectedName;
        UI.confirm({
            title: '删除确认', type: 'warning',
            message: '确定删除员工【' + name + '】吗？删除后不可恢复。',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            UI.loading($wrapper, true, '删除中…');
            Api.emp.remove(id).done(function () {
                UI.message({ type: 'success', message: '删除成功' });
                clearSelect();
                var pages = Math.max(1, Math.ceil((state.total - 1) / state.pageSize));
                if (state.pageNum > pages) { state.pageNum = pages; }
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: err.message || '删除失败' });
            }).always(function () {
                UI.loading($wrapper, false);
            });
        });
    });

    $('#btnRefresh').on('click', function () { loadData(); });

    /* ===================== 员工信息归档（empinfoarchive） ===================== */

    /* ---- 归档：把员工表全部记录按当前时间快照到归档表 ---- */
    $('#btnArchive').on('click', function () {
        var $btn = $(this);
        if ($btn.prop('disabled')) { return; }
        // 先取总数，确认框里给出「将归档 N 条」的明确提示
        Api.emp.page({ pageNum: 1, pageSize: 1 }).done(function (data) {
            var total = (data && data.total) || 0;
            if (!total) {
                UI.alert({ title: '操作提示', type: 'warning', message: '员工信息表暂无数据，无需归档。' });
                return;
            }
            UI.confirm({
                title: '归档确认', type: 'warning',
                message: '确定把员工信息表中的全部记录（共 ' + total + ' 条）按当前时间归档吗？' +
                    '归档只新增一个历史批次，不会修改或删除现有员工数据。',
                confirmText: '确定归档', cancelText: '取消'
            }).done(function (ok) {
                if (!ok) { return; }
                $btn.prop('disabled', true);
                UI.loading($wrapper, true, '归档中…');
                Api.empArchive.archive().done(function (res) {
                    UI.message({
                        type: 'success',
                        message: '归档成功：共 ' + ((res && res.total) || total) + ' 条记录，归档时间 ' +
                            ((res && res.archiveTime) || '') + '，点「历史归档」可查看'
                    });
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '归档失败' });
                }).always(function () {
                    $btn.prop('disabled', false);
                    UI.loading($wrapper, false);
                });
            });
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '无法获取员工总数' });
        });
    });

    /* ---- 历史归档：历次归档时间（批次）弹窗 ---- */
    $('#btnHistory').on('click', function () {
        var $content = $(
            '<div class="arch-batches">' +
                '<div class="arch-tip">下面是历次归档记录（按归档时间倒序）。<b>点击任意一行</b>可查看该归档时间点的员工名单。</div>' +
                '<div class="arch-wrap">' +
                    '<table class="arch-table">' +
                        '<thead><tr>' +
                            '<th class="is-center" style="width:52px">#</th>' +
                            '<th>归档时间</th>' +
                            '<th class="is-center" style="width:96px">记录数</th>' +
                            '<th class="is-center" style="width:88px">操作</th>' +
                        '</tr></thead>' +
                        '<tbody class="arch-batch-body"><tr><td colspan="4" class="arch-empty">加载中…</td></tr></tbody>' +
                    '</table>' +
                '</div>' +
            '</div>');

        UI.dialog({
            title: '历史归档 —— 历次归档时间', width: 660, content: $content,
            onReady: function ($body) {
                var $dlg = $body.closest('.el-dialog');
                $dlg.find('.btn-ok').hide();                       // 只读弹窗：只留「关闭」
                $dlg.find('.btn-cancel').text('关闭');
                var $batchBody = $body.find('.arch-batch-body');

                Api.empArchive.batches().done(function (data) {
                    var list = (data && data.list) || [];
                    if (!list.length) {
                        $batchBody.html('<tr><td colspan="4" class="arch-empty">还没有任何归档记录，' +
                            '点操作区的「归档」按钮可创建第一个归档批次。</td></tr>');
                        return;
                    }
                    var html = '';
                    for (var i = 0; i < list.length; i++) {
                        var one = list[i];
                        html += '<tr class="is-click" data-batch="' + UI.escapeHtml(String(one.batchId)) + '"' +
                            ' data-time="' + UI.escapeHtml(one.archiveTime) + '"' +
                            ' data-total="' + (parseInt(one.total, 10) || 0) + '">' +
                            '<td class="is-center">' + (i + 1) + '</td>' +
                            '<td class="cell-mono">' + UI.escapeHtml(one.archiveTime) + '</td>' +
                            '<td class="is-center">' + (parseInt(one.total, 10) || 0) + ' 条</td>' +
                            '<td class="is-center"><a class="arch-link" href="javascript:void(0)">查看名单</a></td>' +
                            '</tr>';
                    }
                    $batchBody.html(html);
                }).fail(function (err) {
                    $batchBody.html('<tr><td colspan="4" class="arch-empty">' +
                        UI.escapeHtml((err && err.message) || '归档记录加载失败') + '</td></tr>');
                });

                // 点整行（或「查看名单」链接）= 打开该批次的员工名单
                $batchBody.on('click', 'tr[data-batch]', function () {
                    openArchiveDetail($(this).attr('data-batch'), $(this).attr('data-time'),
                        parseInt($(this).attr('data-total'), 10) || 0);
                });
            }
        });
    });

    /* ---- 归档名单：某批次的员工列表（只读，可关键字过滤 / 分页） ---- */
    function openArchiveDetail(batchId, archiveTime, total) {
        var page = { num: 1, size: 10, total: total || 0, keyword: '' };
        var $content = $(
            '<div class="arch-detail">' +
                '<div class="arch-toolbar">' +
                    '<div class="el-input el-input--prefix arch-toolbar__kw">' +
                        '<span class="el-input__prefix">' +
                            '<svg class="svg-ico" viewBox="0 0 24 24" style="width:16px;height:16px"><g stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></g></svg>' +
                        '</span>' +
                        '<input class="el-input__inner arch-kw" type="text" placeholder="工号 / 姓名 / 手机号 / 邮箱 / 岗位 / 身份证号">' +
                    '</div>' +
                    '<button type="button" class="el-button el-button--primary el-button--small arch-search-btn">查询</button>' +
                    '<span class="arch-hint">归档时间：<b>' + UI.escapeHtml(archiveTime || '') + '</b>　共 <b class="arch-total">' +
                        (parseInt(total, 10) || 0) + '</b> 条</span>' +
                '</div>' +
                '<div class="arch-wrap arch-wrap--tall">' +
                    '<table class="arch-table arch-table--emp">' +
                        '<thead><tr>' +
                            '<th class="is-center" style="width:56px">序号</th>' +
                            '<th style="width:86px">工号</th>' +
                            '<th style="width:150px">姓名</th>' +
                            '<th class="is-center" style="width:56px">性别</th>' +
                            '<th style="width:130px">所属部门</th>' +
                            '<th style="width:110px">岗位</th>' +
                            '<th style="width:120px">手机号</th>' +
                            '<th>邮箱</th>' +
                            '<th class="is-center" style="width:80px">在职状态</th>' +
                            '<th style="width:104px">入职日期</th>' +
                            '<th style="width:140px">学历 / 职称</th>' +
                        '</tr></thead>' +
                        '<tbody class="arch-emp-body"><tr><td colspan="11" class="arch-empty">加载中…</td></tr></tbody>' +
                    '</table>' +
                '</div>' +
                '<div class="arch-pager"></div>' +
            '</div>');

        UI.dialog({
            title: '归档员工名单', width: 1080, content: $content,
            onReady: function ($body) {
                var $dlg = $body.closest('.el-dialog');
                $dlg.find('.btn-ok').hide();
                $dlg.find('.btn-cancel').text('关闭');
                var $empBody = $body.find('.arch-emp-body');
                var $total = $body.find('.arch-total');
                var $pager = $body.find('.arch-pager');

                function rowOf(item, index) {
                    var st = parseInt(item.status, 10);
                    if (isNaN(st)) { st = 1; }
                    return '<tr>' +
                        '<td class="is-center">' + ((page.num - 1) * page.size + index + 1) + '</td>' +
                        '<td class="cell-mono">' + UI.escapeHtml(item.code || '') + '</td>' +
                        '<td class="cell-strong">' + avatarHtml(item) +
                            '<span class="emp-name__text">' + UI.escapeHtml(item.nameCn || '') + '</span></td>' +
                        '<td class="is-center">' + UI.escapeHtml(item.genderText || (st === 2 ? '女' : '男')) + '</td>' +
                        '<td>' + UI.escapeHtml(item.deptName || '—（未分配）') + '</td>' +
                        '<td>' + UI.escapeHtml(item.jobTitle || '-') + '</td>' +
                        '<td class="cell-mono">' + UI.escapeHtml(item.phone || '-') + '</td>' +
                        '<td class="cell-desc">' + UI.escapeHtml(item.email || '-') + '</td>' +
                        '<td class="is-center"><span class="el-tag el-tag--small ' +
                            (STATUS_TAG[st] || 'el-tag--info') + '">' +
                            UI.escapeHtml(item.statusText || STATUS_TEXT[st] || '-') + '</span></td>' +
                        '<td>' + UI.escapeHtml(item.hireDate || '-') + '</td>' +
                        '<td class="cell-desc">' + UI.escapeHtml(item.archiveText || '-') + '</td>' +
                        '</tr>';
                }

                function load() {
                    UI.loading($body, true, '加载中…');
                    Api.empArchive.page({
                        batchId: batchId, pageNum: page.num, pageSize: page.size, keyword: page.keyword
                    }).done(function (data) {
                        var list = (data && data.list) || [];
                        page.total = (data && data.total) || 0;
                        page.num = (data && data.pageNum) || page.num;
                        page.size = (data && data.pageSize) || page.size;
                        $total.text(page.total);
                        if (!list.length) {
                            $empBody.html('<tr><td colspan="11" class="arch-empty">' +
                                (page.keyword ? '没有匹配「' + UI.escapeHtml(page.keyword) + '」的员工' : '该批次没有员工记录') +
                                '</td></tr>');
                        } else {
                            var html = '';
                            for (var i = 0; i < list.length; i++) { html += rowOf(list[i], i); }
                            $empBody.html(html);
                        }
                        UI.pagination($pager, {
                            total: page.total, pageNum: page.num, pageSize: page.size, sizes: [10, 20, 50, 100],
                            onChange: function (num, size) {
                                page.num = num; page.size = size; load();
                            }
                        });
                    }).fail(function (err) {
                        $empBody.html('<tr><td colspan="11" class="arch-empty">' +
                            UI.escapeHtml((err && err.message) || '归档名单加载失败') + '</td></tr>');
                    }).always(function () {
                        UI.loading($body, false);
                    });
                }

                function doArchiveSearch() {
                    page.keyword = $.trim($body.find('.arch-kw').val());
                    page.num = 1;
                    load();
                }
                $body.on('click', '.arch-search-btn', doArchiveSearch);
                $body.on('keydown', '.arch-kw', function (e) {
                    if (e.keyCode === 13) { doArchiveSearch(); }
                });
                load();
            }
        });
    }

    /* ---------- 初始化 ---------- */
    restoreState();
    loadDepts().always(function () {
        restoreState();     // 部门下拉填充后重新回填筛选值
        loadData();
    });
});
