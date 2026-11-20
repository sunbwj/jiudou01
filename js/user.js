/* ==========================================================================
   user.js —— 用户信息管理（useinfo）
   --------------------------------------------------------------------------
   · 列表：账号（默认员工手机号）/ 工号 / 姓名 / 所属部门 / 角色 / 启用 /
          最近登录时间 / 最近登录IP / 创建时间；密码与 token 只显示掩码
   · 多选：表格左侧复选框（表头可全选本页），批量操作针对「当前选中」的用户
   · 新增用户：从员工下拉选择（默认列出还没有账号的员工），账号自动填手机号，初始密码 888888
   · 批量创建：勾选多个员工 → 按员工手机号批量建账号，**初始密码统一 888888**，可同时授予角色
   · 批量设置角色：为所选用户统一设置角色（全量替换，会覆盖原有角色）
   · 重置密码：把所选用户的密码重置为 888888
   ========================================================================== */
jQuery(function ($) {
    var $tbody = $('#userTbody');
    var $wrapper = $('#tableWrapper');
    var $pagerWrap = $('#pagerWrap');
    var $selTip = $('#selTip');
    var COLS = 11;
    var STATE_KEY = 'user_admin_list_state';
    var DEFAULT_PWD = '888888';

    var state = {
        keyword: '', enabled: '',
        pageNum: 1, pageSize: 10, total: 0,
        selected: {},        // id -> true（跨页保留）
        rows: {}             // 当前页数据 id -> row
    };
    var roles = [];          // [{id, nameCn, nameEn}]（仅启用角色）

    /* ---------------- 检索条件存取 ---------------- */
    function saveState() {
        try {
            window.sessionStorage.setItem(STATE_KEY, JSON.stringify({
                keyword: state.keyword, enabled: state.enabled,
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
            state.enabled = (s.enabled === 0 || s.enabled) ? String(s.enabled) : '';
            state.pageNum = parseInt(s.pageNum, 10) || 1;
            state.pageSize = parseInt(s.pageSize, 10) || 10;
            $('#keyword').val(state.keyword);
            $('#enabled').val(state.enabled);
        } catch (e) { }
    }

    /* ---------------- 选中态 ---------------- */
    function selectedIds() {
        var ids = [];
        for (var k in state.selected) {
            if (Object.prototype.hasOwnProperty.call(state.selected, k) && state.selected[k]) { ids.push(k); }
        }
        return ids;
    }
    function updateSelTip() {
        var ids = selectedIds();
        if (!ids.length) {
            $selTip.text('未选择任何用户').css('color', '#909399');
        } else {
            var names = [];
            for (var i = 0; i < ids.length; i++) {
                var row = state.rows[ids[i]];
                names.push(row ? (row.empName || row.account) : ids[i]);
            }
            $selTip.text('已选择 ' + ids.length + ' 个用户：' + names.slice(0, 3).join('、') +
                (names.length > 3 ? ' 等' : '')).css('color', '#409eff');
        }
        syncCheckAll();
    }
    function syncCheckAll() {
        var $rows = $tbody.find('tr[data-id]');
        var all = $rows.length > 0, any = false;
        $rows.each(function () {
            var id = $(this).attr('data-id');
            if (state.selected[id]) { any = true; } else { all = false; }
        });
        $('#checkAll').prop('checked', all);
        $('#checkAll').closest('.el-checkbox').toggleClass('is-checked', all)
            .toggleClass('is-indeterminate', !all && any);
    }

    /* ---------------- 渲染 ---------------- */
    function rowNo(index) {
        return (parseInt(state.pageNum, 10) - 1) * (parseInt(state.pageSize, 10) || 10) + index + 1;
    }
    function roleTagsHtml(item) {
        var list = item.roles || [];
        if (!list.length) { return '<span class="um-none">未授权</span>'; }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            html += '<span class="el-tag el-tag--small el-tag--info um-role-tag">' + UI.escapeHtml(list[i].nameCn) + '</span>';
        }
        return html;
    }
    function rowHtml(item, index) {
        var on = !!state.selected[item.id];
        return '' +
            '<tr data-id="' + UI.escapeHtml(String(item.id)) + '"' + (on ? ' class="current-row"' : '') + '>' +
                '<td class="is-center" data-label="序号"><div class="cell cell-index">' + rowNo(index) + '</div></td>' +
                '<td class="is-center el-table__check-cell" data-label="选择"><div class="cell">' +
                    '<label class="el-checkbox' + (on ? ' is-checked' : '') + '">' +
                        '<input class="el-checkbox__original um-row-check" type="checkbox" value="' +
                            UI.escapeHtml(String(item.id)) + '"' + (on ? ' checked' : '') + '>' +
                        '<span class="el-checkbox__inner"></span>' +
                    '</label>' +
                '</div></td>' +
                '<td data-label="账号"><div class="cell cell-mono">' + UI.escapeHtml(item.account || '') + '</div></td>' +
                '<td data-label="工号"><div class="cell cell-mono">' + UI.escapeHtml(item.empCode || '-') + '</div></td>' +
                '<td data-label="姓名"><div class="cell cell-strong">' + UI.escapeHtml(item.empName || '-') + '</div></td>' +
                '<td data-label="所属部门"><div class="cell">' + UI.escapeHtml(item.deptName || '—（未分配）') + '</div></td>' +
                '<td data-label="角色"><div class="cell um-roles-cell">' + roleTagsHtml(item) + '</div></td>' +
                '<td class="is-center" data-label="启用"><div class="cell">' +
                    '<span class="el-tag el-tag--small ' + (item.enabled ? 'el-tag--success' : 'el-tag--info') + '">' +
                        (item.enabled ? '启用' : '停用') + '</span>' +
                '</div></td>' +
                '<td data-label="最近登录时间"><div class="cell">' + UI.escapeHtml(item.lastLoginTime || '-') + '</div></td>' +
                '<td data-label="最近登录IP"><div class="cell cell-mono">' + UI.escapeHtml(item.lastLoginIp || '-') + '</div></td>' +
                '<td data-label="创建时间"><div class="cell cell-desc">' + UI.escapeHtml(item.createTime || '-') + '</div></td>' +
            '</tr>';
    }

    function renderTable(list) {
        state.rows = {};
        if (!list || !list.length) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">暂无数据</span></div></td></tr>');
            updateSelTip();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            state.rows[String(list[i].id)] = list[i];
            html += rowHtml(list[i], i);
        }
        $tbody.html(html);
        updateSelTip();
    }

    function loadData() {
        UI.loading($wrapper, true, '加载中…');
        Api.useInfo.page({
            keyword: state.keyword, enabled: state.enabled,
            pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (data) {
            var list = (data && data.list) || [];
            state.total = (data && data.total) || 0;
            state.pageNum = (data && data.pageNum) || state.pageNum;
            state.pageSize = (data && data.pageSize) || state.pageSize;
            renderTable(list);
            UI.pagination($pagerWrap, {
                total: state.total, pageNum: state.pageNum, pageSize: state.pageSize, sizes: [10, 20, 50, 100],
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
                UI.escapeHtml((err && err.message) || '加载失败') + '</span></div></td></tr>');
        }).always(function () {
            UI.loading($wrapper, false);
        });
    }

    /* ---------------- 角色多选（弹窗内复用） ---------------- */
    function rolesHtml($host, checked) {
        var chosen = {};
        for (var i = 0; i < (checked || []).length; i++) { chosen[String(checked[i])] = true; }
        if (!roles.length) {
            $host.html('<span class="um-none">暂无可用角色（请先在「用户角色管理」中启用角色）</span>');
            return;
        }
        var html = '';
        for (var j = 0; j < roles.length; j++) {
            var r = roles[j], on = !!chosen[String(r.id)];
            html += '<label class="um-role' + (on ? ' is-checked' : '') + '">' +
                '<span class="el-checkbox' + (on ? ' is-checked' : '') + '">' +
                    '<input class="el-checkbox__original um-role-check" type="checkbox" value="' +
                        UI.escapeHtml(String(r.id)) + '"' + (on ? ' checked' : '') + '>' +
                    '<span class="el-checkbox__inner"></span>' +
                '</span>' + UI.escapeHtml(r.nameCn) + '</label>';
        }
        $host.html(html);
    }
    function pickedRoles($scope) {
        var ids = [];
        $scope.find('.um-role-check:checked').each(function () { ids.push($(this).val()); });
        return ids;
    }

    function loadRoles() {
        var dfd = $.Deferred();
        Api.role.page({ pageNum: 1, pageSize: 500, enabled: 1 }).done(function (data) {
            var list = (data && data.list) || [];
            roles = [];
            for (var i = 0; i < list.length; i++) {
                if (list[i].enabled === false) { continue; }
                roles.push({ id: String(list[i].id), nameCn: list[i].nameCn, nameEn: list[i].nameEn || '' });
            }
            dfd.resolve();
        }).fail(function () { dfd.resolve(); });
        return dfd.promise();
    }

    /* ---------------- 新增 / 编辑 ---------------- */
    function openForm(mode, row) {
        var isEdit = mode === 'edit';
        var $form = $('#userFormTpl .user-form').clone(true);
        var $emp = $form.find('#ufEmp');
        var $account = $form.find('#ufAccount');
        var $roles = $form.find('#ufRoles');

        UI.dialog({
            title: isEdit ? ('编辑用户 —— ' + (row.empName || row.account)) : '新增用户',
            width: 620, content: $form,
            onReady: function ($body, close) {
                var $f = $body.find('.user-form');
                rolesHtml($f.find('#ufRoles'), isEdit ? (row.roleIds || []) : []);

                if (isEdit) {
                    // 编辑：员工不可改（一员工一账号），账号可改
                    $f.find('#ufEmp').html('<option value="' + UI.escapeHtml(String(row.empId)) + '">' +
                        UI.escapeHtml((row.empCode || '') + ' ' + (row.empName || '') +
                            (row.deptName ? '（' + row.deptName + '）' : '')) + '</option>').prop('disabled', true);
                    $f.find('#ufEmpTip').text('账号所属员工不可修改');
                    $f.find('#ufAccount').val(row.account || '');
                    $f.find('#ufEnabled').val(row.enabled ? '1' : '0');
                    $f.find('#ufRemark').val(row.remark || '');
                } else {
                    $f.find('#ufEmp').html('<option value="">请选择员工</option>');
                    var opts = $('<span></span>');
                    UI.loading($body, true, '加载员工…');
                    Api.useInfo.empOptions({ noUser: '1' }).done(function (data) {
                        var list = (data && data.list) || [];
                        var html = '<option value="">请选择员工</option>';
                        for (var i = 0; i < list.length; i++) {
                            var e = list[i];
                            html += '<option value="' + e.id + '" data-phone="' + UI.escapeHtml(e.phone || '') + '">' +
                                UI.escapeHtml(e.code + ' ' + e.nameCn + (e.deptName ? '（' + e.deptName + '）' : '') +
                                    (e.phone ? ' · ' + e.phone : ' · 无手机号')) + '</option>';
                        }
                        $f.find('#ufEmp').html(html);
                        if (!list.length) {
                            $f.find('#ufEmpTip').text('所有员工都已创建账号；如需新增，请先新增员工或删除已有账号').css('color', '#e6a23c');
                        }
                    }).fail(function (err) {
                        $f.find('#ufEmpTip').text((err && err.message) || '员工加载失败').css('color', '#f56c6c');
                    }).always(function () { UI.loading($body, false); });

                    // 选员工 → 自动带出手机号作为账号
                    $f.on('change', '#ufEmp', function () {
                        var phone = $(this).find('option:selected').attr('data-phone') || '';
                        if (!$.trim($f.find('#ufAccount').val())) { $f.find('#ufAccount').val(phone); }
                    });
                }

                // 角色胶囊点击联动样式
                $f.on('change', '.um-role-check', function () {
                    var on = $(this).prop('checked');
                    $(this).closest('.um-role').toggleClass('is-checked', on);
                    $(this).closest('.el-checkbox').toggleClass('is-checked', on);
                });

                $f.find('#ufAccount').on('blur', function () {
                    var val = $.trim($(this).val());
                    if (!val) { return; }
                    Api.useInfo.check('account', val, isEdit ? row.id : '').done(function (res) {
                        if (res && res.unique === false) {
                            $f.find('#ufAccountTip').text('账号【' + val + '】已存在').css('color', '#f56c6c');
                        } else {
                            $f.find('#ufAccountTip').text('账号可用').css('color', '#67c23a');
                        }
                    });
                });
                $body.data('mode', mode);
            },
            onOk: function ($body, close) {
                var $f = $body.find('.user-form');
                var account = $.trim($f.find('#ufAccount').val());
                var remark = $.trim($f.find('#ufRemark').val());
                var enabled = $f.find('#ufEnabled').val() === '1';
                var roleIds = pickedRoles($f);

                if (isEdit) {
                    Api.useInfo.update({ id: row.id, account: account, remark: remark, enabled: enabled ? 1 : 0, roleIds: roleIds })
                        .done(function () {
                            UI.message({ type: 'success', message: '保存成功' });
                            close();
                            loadData();
                        }).fail(function (err) {
                            UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                        });
                    return;
                }

                var empId = parseInt($f.find('#ufEmp').val(), 10) || 0;
                if (!empId) {
                    UI.message({ type: 'warning', message: '请选择要创建账号的员工' });
                    return;
                }
                if (!account) {
                    UI.message({ type: 'warning', message: '登录账号不能为空' });
                    return;
                }
                Api.useInfo.add({
                    empId: empId, account: account, remark: remark, enabled: enabled ? 1 : 0,
                    roleIds: roleIds, password: DEFAULT_PWD
                }).done(function () {
                    UI.message({ type: 'success', message: '创建成功，初始密码 ' + DEFAULT_PWD });
                    close();
                    loadData();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '创建失败' });
                });
            }
        });
    }

    /* ---------------- 批量创建（初始密码 888888） ---------------- */
    function openBatchCreate() {
        var chosen = {};          // empId -> true
        var emps = [];            // 可建账号的员工
        var kw = '';
        var $content = $(
            '<div class="um-batch">' +
                '<div class="um-tip">按所选员工的<b>手机号</b>批量创建登录账号；初始密码统一为 <b>' + DEFAULT_PWD + '</b>；' +
                    '已有账号的员工会自动跳过。</div>' +
                '<div class="um-toolbar">' +
                    '<input class="el-input__inner um-kw" type="text" placeholder="工号 / 姓名 / 手机号 / 岗位">' +
                    '<button type="button" class="el-button el-button--small el-button--primary um-btn-search">查询</button>' +
                    '<label class="el-checkbox um-check-all" style="margin-left:8px">' +
                        '<input class="el-checkbox__original um-all-check" type="checkbox">' +
                        '<span class="el-checkbox__inner"></span><span class="um-check-text">全选</span></label>' +
                    '<span class="um-count">已选 <b class="um-chosen">0</b> 个</span>' +
                '</div>' +
                '<div class="arch-wrap um-emp-wrap">' +
                    '<table class="arch-table um-emp-table">' +
                        '<thead><tr>' +
                            '<th class="is-center" style="width:44px"></th>' +
                            '<th style="width:86px">工号</th>' +
                            '<th style="width:120px">姓名</th>' +
                            '<th style="width:130px">所属部门</th>' +
                            '<th style="width:110px">岗位</th>' +
                            '<th style="width:120px">手机号（账号）</th>' +
                        '</tr></thead>' +
                        '<tbody class="um-emp-body"><tr><td colspan="6" class="arch-empty">加载中…</td></tr></tbody>' +
                    '</table>' +
                '</div>' +
                '<div class="um-role-box">' +
                    '<div class="um-role-title">同时授予角色（可多选，也可稍后在「批量设置角色」中配置）</div>' +
                    '<div class="um-roles um-batch-roles"></div>' +
                '</div>' +
            '</div>');

        UI.dialog({
            title: '批量创建用户', width: 900, content: $content,
            onReady: function ($body, close) {
                var $ok = $body.closest('.el-dialog').find('.btn-ok');
                $ok.text('批量创建');
                var $empBody = $body.find('.um-emp-body');
                var $chosen = $body.find('.um-chosen');
                rolesHtml($body.find('.um-batch-roles'), []);

                function refreshCount() {
                    var n = 0;
                    for (var k in chosen) { if (chosen[k]) { n++; } }
                    $chosen.text(n);
                }
                function renderEmps() {
                    var rows = [];
                    for (var i = 0; i < emps.length; i++) {
                        if (kw && (emps[i].code + ' ' + emps[i].nameCn + ' ' + (emps[i].phone || '') + ' ' +
                            (emps[i].jobTitle || '')).toLowerCase().indexOf(kw) < 0) { continue; }
                        rows.push(emps[i]);
                    }
                    if (!rows.length) {
                        $empBody.html('<tr><td colspan="6" class="arch-empty">' +
                            (emps.length ? '没有匹配的员工' : '没有可创建账号的员工（都已有账号或没有手机号）') + '</td></tr>');
                        return;
                    }
                    var html = '';
                    for (var j = 0; j < rows.length; j++) {
                        var e = rows[j], on = !!chosen[String(e.id)];
                        var noPhone = !e.phone;
                        html += '<tr data-id="' + e.id + '" class="' + (noPhone ? 'is-disabled-row' : 'is-click') + '">' +
                            '<td class="is-center">' +
                                '<label class="el-checkbox' + (on ? ' is-checked' : '') + '">' +
                                    '<input class="el-checkbox__original um-emp-check" type="checkbox" value="' + e.id + '"' +
                                        (on ? ' checked' : '') + (noPhone ? ' disabled' : '') + '>' +
                                    '<span class="el-checkbox__inner"></span>' +
                                '</label>' +
                            '</td>' +
                            '<td class="cell-mono">' + UI.escapeHtml(e.code) + '</td>' +
                            '<td class="cell-strong">' + UI.escapeHtml(e.nameCn) + '</td>' +
                            '<td>' + UI.escapeHtml(e.deptName || '—') + '</td>' +
                            '<td>' + UI.escapeHtml(e.jobTitle || '-') + '</td>' +
                            '<td class="cell-mono">' + UI.escapeHtml(e.phone || '无手机号（不可创建）') + '</td>' +
                            '</tr>';
                    }
                    $empBody.html(html);
                }
                function loadEmps() {
                    UI.loading($body, true, '加载员工…');
                    Api.useInfo.empOptions({ noUser: '1' }).done(function (data) {
                        emps = [];
                        var list = (data && data.list) || [];
                        for (var i = 0; i < list.length; i++) {
                            if (list[i].hasUser) { continue; }
                            emps.push(list[i]);
                        }
                        renderEmps();
                        refreshCount();
                    }).fail(function (err) {
                        $empBody.html('<tr><td colspan="6" class="arch-empty">' +
                            UI.escapeHtml((err && err.message) || '员工加载失败') + '</td></tr>');
                    }).always(function () { UI.loading($body, false); });
                }

                // 勾选员工
                $empBody.on('change', '.um-emp-check', function () {
                    var id = String($(this).val());
                    if ($(this).prop('checked')) { chosen[id] = true; } else { delete chosen[id]; }
                    $(this).closest('.el-checkbox').toggleClass('is-checked', $(this).prop('checked'));
                    refreshCount();
                });
                // 点整行也能勾选
                $empBody.on('click', 'tr.is-click', function (e) {
                    if ($(e.target).closest('.el-checkbox').length) { return; }
                    $(this).find('.um-emp-check').trigger('click');
                });
                // 全选 / 全不选（仅当前筛选结果、仅可选行）
                $body.find('.um-all-check').on('change', function () {
                    var on = $(this).prop('checked');
                    $(this).closest('.el-checkbox').toggleClass('is-checked', on);
                    $empBody.find('.um-emp-check:not(:disabled)').each(function () {
                        $(this).prop('checked', on).closest('.el-checkbox').toggleClass('is-checked', on);
                        var id = String($(this).val());
                        if (on) { chosen[id] = true; } else { delete chosen[id]; }
                    });
                    refreshCount();
                });
                // 关键字过滤
                function doSearch() {
                    kw = $.trim($body.find('.um-kw').val()).toLowerCase();
                    renderEmps();
                }
                $body.on('click', '.um-btn-search', doSearch);
                $body.on('keydown', '.um-kw', function (e) { if (e.keyCode === 13) { doSearch(); } });

                $body.on('change', '.um-role-check', function () {
                    var on = $(this).prop('checked');
                    $(this).closest('.um-role').toggleClass('is-checked', on);
                    $(this).closest('.el-checkbox').toggleClass('is-checked', on);
                });

                $body.data('submit', function (done) {
                    var ids = [];
                    for (var k in chosen) { if (chosen[k]) { ids.push(k); } }
                    if (!ids.length) {
                        UI.message({ type: 'warning', message: '请勾选要创建账号的员工' });
                        return;
                    }
                    var roleIds = pickedRoles($body);
                    $ok.prop('disabled', true).addClass('is-loading');
                    Api.useInfo.batch({ empIds: ids, roleIds: roleIds }).done(function (res) {
                        var created = (res && res.created) || 0;
                        var skipped = (res && res.skipped) || [];
                        UI.message({
                            type: created ? 'success' : 'warning',
                            message: '批量创建完成：成功 ' + created + ' 个' +
                                (skipped.length ? '，跳过 ' + skipped.length + ' 个' : '') +
                                '；初始密码 ' + ((res && res.password) || DEFAULT_PWD)
                        });
                        if (skipped.length) {
                            var lines = [];
                            for (var i = 0; i < Math.min(skipped.length, 8); i++) {
                                lines.push('· ' + (skipped[i].code || '') + ' ' + (skipped[i].nameCn || '') +
                                    '：' + skipped[i].reason);
                            }
                            if (skipped.length > 8) { lines.push('… 其余 ' + (skipped.length - 8) + ' 个略'); }
                            UI.alert({
                                title: '跳过的员工（' + skipped.length + ' 个）', type: 'warning',
                                message: lines.join('\n')
                            });
                        }
                        done();
                        loadData();
                    }).fail(function (err) {
                        UI.message({ type: 'error', message: (err && err.message) || '批量创建失败' });
                    }).always(function () {
                        $ok.prop('disabled', false).removeClass('is-loading');
                    });
                });

                loadEmps();
            },
            onOk: function ($body, close) {
                var submit = $body.data('submit');
                if (!submit) { close(); return; }
                submit(close);
            }
        });
    }

    /* ---------------- 批量设置角色 ---------------- */
    function openBatchRoles() {
        var ids = selectedIds();
        if (!ids.length) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在列表中勾选要设置角色的用户。' });
            return;
        }
        var rows = state.rows;
        var $content = $(
            '<div class="um-batch">' +
                '<div class="um-tip">将为已选中的 <b>' + ids.length + '</b> 个用户统一设置角色；' +
                    '<b>会覆盖这些用户原有的角色</b>（不勾选任何角色表示清空角色）。</div>' +
                '<div class="um-role-box">' +
                    '<div class="um-role-title">选择角色（可多选）</div>' +
                    '<div class="um-roles um-batch-roles"></div>' +
                '</div>' +
            '</div>');

        UI.dialog({
            title: '批量设置角色', width: 620, content: $content,
            onReady: function ($body, close) {
                var $ok = $body.closest('.el-dialog').find('.btn-ok');
                $ok.text('确定设置');
                rolesHtml($body.find('.um-batch-roles'), []);
                $body.on('change', '.um-role-check', function () {
                    var on = $(this).prop('checked');
                    $(this).closest('.um-role').toggleClass('is-checked', on);
                    $(this).closest('.el-checkbox').toggleClass('is-checked', on);
                });
            },
            onOk: function ($body, close) {
                var roleIds = pickedRoles($body);
                var $ok = $body.closest('.el-dialog').find('.btn-ok');
                $ok.prop('disabled', true).addClass('is-loading');
                Api.useInfo.setRoles(ids, roleIds).done(function (res) {
                    UI.message({
                        type: 'success',
                        message: '设置成功：' + ((res && res.users) || ids.length) + ' 个用户，' +
                            ((res && res.roles) || roleIds.length) + ' 个角色'
                    });
                    close();
                    loadData();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '设置失败' });
                }).always(function () {
                    $ok.prop('disabled', false).removeClass('is-loading');
                });
            }
        });
    }

    /* ---------------- 重置密码 ---------------- */
    function doResetPwd() {
        var ids = selectedIds();
        if (!ids.length) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在列表中勾选要重置密码的用户。' });
            return;
        }
        UI.confirm({
            title: '重置密码', type: 'warning',
            message: '确定把所选 ' + ids.length + ' 个用户的登录密码重置为 ' + DEFAULT_PWD + ' 吗？' +
                '重置后请通知用户及时修改密码。',
            confirmText: '确定重置', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            UI.loading($wrapper, true, '重置中…');
            Api.useInfo.resetPwd(ids).done(function (res) {
                UI.message({
                    type: 'success',
                    message: '重置成功：' + ((res && res.reset) || ids.length) + ' 个用户的密码已重置为 ' + DEFAULT_PWD
                });
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '重置失败' });
            }).always(function () {
                UI.loading($wrapper, false);
            });
        });
    }

    /* ---------------- 删除 ---------------- */
    function doDelete() {
        var ids = selectedIds();
        if (!ids.length) {
            UI.alert({ title: '操作提示', type: 'warning', message: '请先在列表中勾选要删除的用户。' });
            return;
        }
        var names = [];
        for (var i = 0; i < ids.length; i++) {
            var row = state.rows[ids[i]];
            names.push(row ? (row.empName || row.account) : ids[i]);
        }
        UI.confirm({
            title: '删除确认', type: 'warning',
            message: '确定删除所选 ' + ids.length + ' 个用户账号（' + names.slice(0, 3).join('、') +
                (names.length > 3 ? ' 等' : '') + '）吗？删除后该员工可重新创建账号。',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            UI.loading($wrapper, true, '删除中…');
            Api.useInfo.remove(ids).done(function () {
                UI.message({ type: 'success', message: '删除成功' });
                for (var i = 0; i < ids.length; i++) { delete state.selected[ids[i]]; }
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            }).always(function () {
                UI.loading($wrapper, false);
            });
        });
    }

    /* ---------------- 事件 ---------------- */
    $tbody.on('change', '.um-row-check', function () {
        var id = String($(this).val());
        if ($(this).prop('checked')) { state.selected[id] = true; } else { delete state.selected[id]; }
        $(this).closest('.el-checkbox').toggleClass('is-checked', $(this).prop('checked'));
        $(this).closest('tr').toggleClass('current-row', $(this).prop('checked'));
        updateSelTip();
    });
    // 点行空白处也能勾选
    $tbody.on('click', 'tr[data-id]', function (e) {
        if ($(e.target).closest('.el-checkbox').length) { return; }
        $(this).find('.um-row-check').trigger('click');
    });
    $('#checkAll').on('change', function () {
        var on = $(this).prop('checked');
        $(this).closest('.el-checkbox').toggleClass('is-checked', on);
        $tbody.find('.um-row-check').each(function () {
            $(this).prop('checked', on);
            $(this).closest('.el-checkbox').toggleClass('is-checked', on);
            $(this).closest('tr').toggleClass('current-row', on);
            var id = String($(this).val());
            if (on) { state.selected[id] = true; } else { delete state.selected[id]; }
        });
        updateSelTip();
    });

    function doSearch(reset) {
        if (reset) {
            state.keyword = '';
            state.enabled = '';
            $('#keyword').val('');
            $('#enabled').val('');
        } else {
            state.keyword = $.trim($('#keyword').val());
            state.enabled = $('#enabled').val() || '';
        }
        state.pageNum = 1;
        saveState();
        loadData();
    }
    $('#btnSearch').on('click', function () { doSearch(false); });
    $('#btnReset').on('click', function () { doSearch(true); });
    $('#enabled').on('change', function () { doSearch(false); });
    $('#keyword').on('keydown', function (e) { if (e.keyCode === 13) { doSearch(false); } });

    $('#btnAdd').on('click', function () { openForm('add'); });
    $('#btnBatch').on('click', openBatchCreate);
    $('#btnBatchRole').on('click', openBatchRoles);
    $('#btnResetPwd').on('click', doResetPwd);
    $('#btnDelete').on('click', doDelete);
    $('#btnEdit').on('click', function () {
        var ids = selectedIds();
        if (ids.length !== 1) {
            UI.alert({ title: '操作提示', type: 'warning', message: '编辑请只勾选一个用户。' });
            return;
        }
        var row = state.rows[ids[0]];
        if (!row) { UI.message({ type: 'error', message: '数据已失效，请刷新后重试' }); return; }
        openForm('edit', row);
    });
    $('#btnRefresh').on('click', function () { loadData(); });

    /* ---------------- 初始化 ---------------- */
    restoreState();
    loadRoles().always(function () {
        restoreState();
        loadData();
    });
});
