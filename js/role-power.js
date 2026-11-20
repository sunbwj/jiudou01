/* ==========================================================================
   role-power.js —— 角色权限配置（菜单权限 + 页面操作按钮权限）
   --------------------------------------------------------------------------
   · 表：usergrouppowerset（角色 ↔ 菜单组 / 菜单项，UUID 主键）
         usergrouppagebtnset（角色 ↔ 页面操作按钮 pageopbtn，UUID 主键）
   · 交互：先选角色（下拉**只列出启用状态的角色**，停用角色不出现）→ 权限树按
           「菜单组 → 菜单项(页面) → 操作按钮」三级展示 → 勾选后点「保存权限」，
           **一次请求同时保存菜单权限与按钮权限**（后端同一事务全量替换）
   · 鼠标操作（防误勾）：
       - **单击**菜单组标题行 = 整组展开 / 收起；**双击** = 整组勾选 / 取消（一次双击只切换一次）
       - **单击**菜单项标题行 = 展开 / 收起该页面的按钮区；**双击** = 勾选 / 取消该页面
       - 直接点复选框方块 = 立即切换（明确动作，无需双击）；按钮胶囊单击即切换
       - 单双击用 260ms 定时器区分：第二次单击会撤销待执行的「展开/收起」，交给 dblclick 处理
   · 勾选规则：
       - 勾菜单组 = 勾选该组下全部菜单项（半选用 is-indeterminate 表示），
                    并默认勾选这些管理页下的全部操作按钮
       - 勾菜单项(管理页) = 默认勾选该页面下的全部操作按钮（可再逐个取消）
       - 取消菜单项 = 同时取消该页面的按钮权限（页面都进不去，按钮自然不可用）
       - 菜单项未勾选时，其下按钮显示为禁用（不可授权）
       - 顶部统计：菜单「已授权 N / M 项」+ 按钮「已授权 P / Q 个」
   · 关键字检索在本地过滤（不重新请求），避免只提交过滤结果导致未显示的权限被清空
   ========================================================================== */
jQuery(function ($) {
    var $tree = $('#powerTree');
    var $empty = $('#powerEmpty');
    var $roleSelect = $('#roleSelect');
    var $selTip = $('#selTip');
    var $menuChecked = $('#pwChecked');
    var $menuTotal = $('#pwTotal');
    var $btnChecked = $('#pwBtnChecked');
    var $btnTotal = $('#pwBtnTotal');
    var STATE_KEY = 'role_power_state';

    var state = {
        roleId: '',
        roleName: '',
        keyword: '',
        groups: [],          // 服务端返回的完整权限树
        checked: {},         // 菜单权限：'groupId:itemId' -> true
        checkedBtns: {}      // 按钮权限：pageOpBtnId -> true
    };
    var loading = false;

    /* ---------------- 工具 ---------------- */
    function keyOf(gid, iid) { return gid + ':' + iid; }
    function btnKey(id) { return String(id); }

    function readState() {
        try {
            var raw = window.localStorage.getItem(STATE_KEY);
            if (raw) {
                var saved = JSON.parse(raw);
                if (saved && saved.roleId) { state.roleId = String(saved.roleId); }
            }
        } catch (e) { /* 忽略 */ }
    }
    function saveState() {
        try {
            window.localStorage.setItem(STATE_KEY, JSON.stringify({ roleId: state.roleId }));
        } catch (e) { /* 忽略 */ }
    }

    /* ---------------- 角色下拉（只加载「启用状态」的角色） ---------------- */
    function loadRoles() {
        var dfd = $.Deferred();
        Api.role.page({ pageNum: 1, pageSize: 500, enabled: 1 }).done(function (data) {
            var rows = (data && data.list) || [];
            var list = [], html = '<option value="">请选择角色</option>';
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                // 双保险：即便后端没按 enabled 过滤，这里也不展示停用角色
                if (r.enabled === false || r.enabled === 0 || r.enabled === '0') { continue; }
                list.push(r);
                html += '<option value="' + UI.escapeHtml(String(r.id)) + '">' +
                    UI.escapeHtml(r.nameCn + '（' + (r.nameEn || '-') + '）') +
                    '</option>';
            }
            $roleSelect.html(html);
            if (state.roleId) { $roleSelect.val(state.roleId); }   // 之前选的角色若已被停用，val 会落空 → 回退到第一个
            if (!$roleSelect.val() && list.length) {          // 默认选中第一个启用角色
                $roleSelect.val(String(list[0].id));
                state.roleId = String(list[0].id);
            }
            if (!state.roleId) { state.roleId = String($roleSelect.val() || ''); }
            if (!list.length) {
                UI.message({ type: 'warning', message: '暂无「启用状态」的用户角色，请先在「用户角色管理」中启用角色' });
            }
            dfd.resolve();
        }).fail(function (err) {
            UI.message({ type: 'error', message: '角色加载失败：' + (err && err.message || '未知错误') });
            dfd.resolve();
        });
        return dfd.promise();
    }

    /* ---------------- 统计 ---------------- */
    function menuStatOf(group) {
        var n = 0;
        for (var i = 0; i < group.items.length; i++) {
            if (state.checked[keyOf(group.menuGroupId, group.items[i].menuItemId)]) { n++; }
        }
        return { checked: n, total: group.items.length, all: n > 0 && n === group.items.length, some: n > 0 && n < group.items.length };
    }
    function itemBtnStat(item) {
        var list = item.buttons || [], n = 0;
        for (var i = 0; i < list.length; i++) {
            if (state.checkedBtns[btnKey(list[i].pageOpBtnId)]) { n++; }
        }
        return { checked: n, total: list.length };
    }
    function updateStats() {
        var mChecked = 0, mTotal = 0, bChecked = 0, bTotal = 0;
        var seenBtn = {};        // 同一页面可能挂在多个菜单组下，按钮按 id 去重计数
        for (var i = 0; i < state.groups.length; i++) {
            var g = state.groups[i];
            for (var j = 0; j < g.items.length; j++) {
                var it = g.items[j];
                mTotal++;
                if (state.checked[keyOf(g.menuGroupId, it.menuItemId)]) { mChecked++; }
                var list = it.buttons || [];
                for (var k = 0; k < list.length; k++) {
                    var bid = btnKey(list[k].pageOpBtnId);
                    if (seenBtn[bid]) { continue; }
                    seenBtn[bid] = true;
                    bTotal++;
                    if (state.checkedBtns[bid]) { bChecked++; }
                }
            }
        }
        $menuChecked.text(mChecked);
        $menuTotal.text(mTotal);
        $btnChecked.text(bChecked);
        $btnTotal.text(bTotal);
        $selTip.text(state.roleName || '未选择角色');
    }

    /* ---------------- 渲染（关键字在本地过滤） ---------------- */
    function matchKeyword(group, item) {
        var kw = state.keyword;
        if (!kw) { return true; }
        var blob = [group.nameCn, group.crumb, item.nameCn, item.code, item.path];
        var list = item.buttons || [];
        for (var i = 0; i < list.length; i++) { blob.push(list[i].btnId, list[i].btnText); }
        return blob.join(' ').toLowerCase().indexOf(kw) > -1;
    }

    function buttonsHtml(group, item) {
        var list = item.buttons || [];
        var pageOn = !!state.checked[keyOf(group.menuGroupId, item.menuItemId)];
        if (!list.length) { return '<div class="pw-btns"><span class="pw-btns__empty">该页面未登记操作按钮</span></div>'; }
        var html = '<div class="pw-btns">';
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            var on = !!state.checkedBtns[btnKey(b.pageOpBtnId)];
            var disabled = !pageOn;
            html += '<label class="pw-btn' + (on ? ' is-checked' : '') + (disabled ? ' is-disabled' : '') + '"' +
                ' data-group="' + group.menuGroupId + '" data-item="' + item.menuItemId + '"' +
                ' data-btn="' + UI.escapeHtml(b.pageOpBtnId) + '"' +
                ' title="' + UI.escapeHtml('#' + b.btnId + ' ' + b.btnText + (disabled ? '（需先授予该页面菜单权限）' : '')) + '">' +
                '<span class="el-checkbox' + (on ? ' is-checked' : '') + '">' +
                    '<input class="el-checkbox__original pw-btn__input" type="checkbox"' + (on ? ' checked' : '') +
                        (disabled ? ' disabled' : '') + '>' +
                    '<span class="el-checkbox__inner"></span>' +
                '</span>' + UI.escapeHtml(b.btnText) +
                '</label>';
        }
        return html + '</div>';
    }

    function itemHtml(group, item) {
        var key = keyOf(group.menuGroupId, item.menuItemId);
        var on = !!state.checked[key];
        var bs = itemBtnStat(item);
        var countText = bs.total ? (bs.checked + ' / ' + bs.total) : '';
        var hasBtn = !!(item.buttons && item.buttons.length);
        return '' +
            '<div class="pw-item' + (on ? ' is-checked' : '') + (hasBtn ? '' : ' is-no-btn') + '"' +
                ' data-group="' + group.menuGroupId + '" data-item="' + item.menuItemId + '"' +
                ' title="' + UI.escapeHtml(item.crumb || item.nameCn) + '">' +
                '<div class="pw-item__head" title="单击展开/收起按钮，双击勾选/取消">' +
                    '<span class="pw-item__caret"' + (hasBtn ? '' : ' style="visibility:hidden"') + '></span>' +
                    '<span class="el-checkbox' + (on ? ' is-checked' : '') + '">' +
                        '<input class="el-checkbox__original pw-item__input" type="checkbox"' + (on ? ' checked' : '') + '>' +
                        '<span class="el-checkbox__inner"></span>' +
                    '</span>' +
                    '<span class="pw-item__name">' + UI.escapeHtml(item.nameCn) + '</span>' +
                    '<span class="pw-item__path">' + UI.escapeHtml(item.path || '-') + '</span>' +
                    (countText ? '<span class="pw-item__count">按钮 ' + countText + '</span>' : '') +
                '</div>' +
                buttonsHtml(group, item) +
            '</div>';
    }

    function groupHtml(group) {
        var st = menuStatOf(group);
        var items = '', shown = 0;
        for (var i = 0; i < group.items.length; i++) {
            if (!matchKeyword(group, group.items[i])) { continue; }
            items += itemHtml(group, group.items[i]);
            shown++;
        }
        if (!shown) { return ''; }
        return '' +
            '<div class="pw-group" data-group="' + group.menuGroupId + '">' +
                '<div class="pw-group__head">' +
                    '<label class="el-checkbox pw-group__check' + (st.all ? ' is-checked' : '') +
                        (st.some ? ' is-indeterminate' : '') + '">' +
                        '<input class="el-checkbox__original pw-group__input" type="checkbox"' +
                            (st.all ? ' checked' : '') + ' data-group="' + group.menuGroupId + '">' +
                        '<span class="el-checkbox__inner"></span>' +
                    '</label>' +
                    '<span class="pw-group__title">' + UI.escapeHtml(group.nameCn) + '</span>' +
                    '<span class="pw-group__code">' + UI.escapeHtml(group.code || '') + '</span>' +
                    '<span class="pw-group__crumb">' + UI.escapeHtml(group.crumb || '') + '</span>' +
                    '<span class="pw-group__count">' + st.checked + ' / ' + st.total + '</span>' +
                    '<a class="pw-group__toggle" href="javascript:void(0)" data-group="' + group.menuGroupId + '">收起</a>' +
                '</div>' +
                '<div class="pw-group__items">' + items + '</div>' +
            '</div>';
    }

    function render() {
        var html = '', shownGroups = 0;
        for (var i = 0; i < state.groups.length; i++) {
            var one = groupHtml(state.groups[i]);
            if (one) { html += one; shownGroups++; }
        }
        if (!state.groups.length) {
            $tree.html('').hide();
            $empty.show().text(state.roleId ? '该角色暂无可配置的菜单（请先在「菜单组项目管理」里绑定菜单项）' : '请先在上方选择角色');
            updateStats();
            return;
        }
        if (!shownGroups) {
            $empty.hide();
            $tree.show().html('<div class="role-power__empty">没有符合关键字「' + UI.escapeHtml(state.keyword) + '」的菜单或按钮</div>');
            updateStats();
            return;
        }
        $empty.hide();
        $tree.show().html(html);
        updateStats();
    }

    /* ---------------- 单组 / 单项局部刷新 ---------------- */
    function findGroup(gid) {
        for (var i = 0; i < state.groups.length; i++) {
            if (state.groups[i].menuGroupId === gid) { return state.groups[i]; }
        }
        return null;
    }
    function refreshGroupHead(gid) {
        var group = findGroup(gid);
        if (!group) { return; }
        var st = menuStatOf(group);
        var $g = $tree.find('.pw-group[data-group="' + gid + '"]');
        $g.find('.pw-group__check').toggleClass('is-checked', st.all).toggleClass('is-indeterminate', st.some);
        $g.find('.pw-group__input').prop('checked', st.all);
        $g.find('.pw-group__count').text(st.checked + ' / ' + st.total);
    }
    function refreshItem(gid, iid) {
        var group = findGroup(gid);
        if (!group) { return; }
        var item = null;
        for (var i = 0; i < group.items.length; i++) {
            if (group.items[i].menuItemId === iid) { item = group.items[i]; break; }
        }
        if (!item) { return; }
        var key = keyOf(gid, iid);
        var on = !!state.checked[key];
        var $item = $tree.find('.pw-item[data-group="' + gid + '"][data-item="' + iid + '"]');
        $item.toggleClass('is-checked', on);
        $item.find('.pw-item__input').prop('checked', on);
        $item.find('.pw-item__head .el-checkbox').toggleClass('is-checked', on);
        // 按钮：勾选态 + 是否可用
        $item.find('.pw-btn').each(function () {
            var $btn = $(this);
            var bid = btnKey($btn.attr('data-btn'));
            var bOn = !!state.checkedBtns[bid];
            $btn.toggleClass('is-checked', bOn).toggleClass('is-disabled', !on);
            $btn.find('.pw-btn__input').prop('checked', bOn).prop('disabled', !on);
            $btn.find('.el-checkbox').toggleClass('is-checked', bOn);
        });
        var bs = itemBtnStat(item);
        $item.find('.pw-item__count').text(bs.total ? ('按钮 ' + bs.checked + ' / ' + bs.total) : '');
        refreshGroupHead(gid);
        updateStats();
    }

    /* ---------------- 数据加载 ---------------- */
    function loadTree() {
        if (!state.roleId) {
            state.groups = [];
            state.roleName = '';
            state.checked = {};
            state.checkedBtns = {};
            render();
            return;
        }
        if (loading) { return; }
        loading = true;
        var roleId = state.roleId;
        Api.rolePower.tree(roleId).done(function (data) {
            loading = false;
            if (String(roleId) !== String(state.roleId)) { return; }   // 期间又切了角色
            state.groups = (data && data.groups) || [];
            state.roleName = (data && data.roleName) || '';
            state.checked = {};
            state.checkedBtns = {};
            for (var i = 0; i < state.groups.length; i++) {
                var g = state.groups[i];
                for (var j = 0; j < g.items.length; j++) {
                    var it = g.items[j];
                    if (it.checked) { state.checked[keyOf(g.menuGroupId, it.menuItemId)] = true; }
                    var list = it.buttons || [];
                    for (var k = 0; k < list.length; k++) {
                        if (list[k].checked) { state.checkedBtns[btnKey(list[k].pageOpBtnId)] = true; }
                    }
                }
            }
            render();
            saveState();
        }).fail(function (err) {
            loading = false;
            UI.message({ type: 'error', message: '权限加载失败：' + (err && err.message || '未知错误') });
        });
    }

    /* ---------------- 保存（菜单 + 按钮一次提交） ---------------- */
    function currentItems() {
        var items = [];
        for (var i = 0; i < state.groups.length; i++) {
            var g = state.groups[i];
            for (var j = 0; j < g.items.length; j++) {
                if (state.checked[keyOf(g.menuGroupId, g.items[j].menuItemId)]) {
                    items.push({ menuGroupId: g.menuGroupId, menuItemId: g.items[j].menuItemId });
                }
            }
        }
        return items;
    }
    /* 只提交「所属页面已授权」的按钮，避免出现没有菜单权限的孤立按钮授权 */
    function currentButtons() {
        var ids = [], seen = {};
        for (var i = 0; i < state.groups.length; i++) {
            var g = state.groups[i];
            for (var j = 0; j < g.items.length; j++) {
                var it = g.items[j];
                if (!state.checked[keyOf(g.menuGroupId, it.menuItemId)]) { continue; }
                var list = it.buttons || [];
                for (var k = 0; k < list.length; k++) {
                    var bid = btnKey(list[k].pageOpBtnId);
                    if (!state.checkedBtns[bid] || seen[bid]) { continue; }
                    seen[bid] = true;
                    ids.push(list[k].pageOpBtnId);
                }
            }
        }
        return ids;
    }

    function savePowers() {
        if (!state.roleId) {
            UI.message({ type: 'warning', message: '请先选择角色' });
            return;
        }
        var items = currentItems(), buttons = currentButtons();
        var $btn = $('#btnSave');
        if ($btn.prop('disabled')) { return; }
        $btn.prop('disabled', true).addClass('is-loading');
        Api.rolePower.save(state.roleId, items, buttons).done(function (res) {
            $btn.prop('disabled', false).removeClass('is-loading');
            UI.message({
                type: 'success',
                message: '保存成功：菜单 ' + ((res && res.saved) || items.length) +
                    ' 项，按钮 ' + ((res && res.savedButtons !== undefined && res.savedButtons !== null)
                        ? res.savedButtons : buttons.length) + ' 个'
            });
            loadTree();
        }).fail(function (err) {
            $btn.prop('disabled', false).removeClass('is-loading');
            UI.message({ type: 'error', message: '保存失败：' + (err && err.message || '未知错误') });
        });
    }

    /* ---------------- 事件 ---------------- */
    $roleSelect.on('change', function () {
        state.roleId = String($(this).val() || '');
        state.roleName = '';
        state.checked = {};
        state.checkedBtns = {};
        loadTree();
    });

    /* ---- 统一的勾选入口（复选框 change / 标题行、复选框外观点击都走这里，避免同一动作触发两次） ---- */
    function setItemChecked(gid, iid, on) {
        var k = keyOf(gid, iid);
        var item = findItem(gid, iid);
        if (on) {
            state.checked[k] = true;
            if (item) { checkItemButtons(item); }      // 勾选管理页 → 该页操作按钮默认全选
        } else {
            delete state.checked[k];
            if (item) { uncheckItemButtons(item); }
        }
        refreshItem(gid, iid);
    }
    function setGroupChecked(gid, on) {
        var group = findGroup(gid);
        if (!group) { return; }
        for (var i = 0; i < group.items.length; i++) {
            var iid = group.items[i].menuItemId;
            var k = keyOf(gid, iid);
            if (on) { state.checked[k] = true; checkItemButtons(group.items[i]); }
            else { uncheckItemButtons(group.items[i]); delete state.checked[k]; }
            refreshItem(gid, iid);
        }
        refreshGroupHead(gid);
        updateStats();
    }

    // 菜单组：整组全选 / 全不选（勾选时组内页面的操作按钮一并默认全选）
    $tree.on('change', '.pw-group__input', function () {
        setGroupChecked(parseInt($(this).attr('data-group'), 10), $(this).prop('checked'));
    });

    // 菜单项：勾选 / 取消（勾选时该页面操作按钮默认全选；取消时一并取消按钮权限）
    $tree.on('change', '.pw-item__input', function () {
        var $item = $(this).closest('.pw-item');
        setItemChecked(parseInt($item.attr('data-group'), 10),
            parseInt($item.attr('data-item'), 10), $(this).prop('checked'));
    });

    // 操作按钮：勾选 / 取消（页面未授权时不可点）
    $tree.on('change', '.pw-btn__input', function () {
        var $btn = $(this).closest('.pw-btn');
        var gid = parseInt($btn.attr('data-group'), 10);
        var iid = parseInt($btn.attr('data-item'), 10);
        if (!state.checked[keyOf(gid, iid)]) {      // 没菜单权限，忽略
            $(this).prop('checked', false);
            UI.message({ type: 'warning', message: '请先勾选该页面（菜单权限），再配置页面按钮' });
            return;
        }
        var bid = btnKey($btn.attr('data-btn'));
        if ($(this).prop('checked')) { state.checkedBtns[bid] = true; } else { delete state.checkedBtns[bid]; }
        refreshItem(gid, iid);
    });

    function findItem(gid, iid) {
        var group = findGroup(gid);
        if (!group) { return null; }
        for (var i = 0; i < group.items.length; i++) {
            if (group.items[i].menuItemId === iid) { return group.items[i]; }
        }
        return null;
    }
    function uncheckItemButtons(item) {
        var list = item.buttons || [];
        for (var i = 0; i < list.length; i++) { delete state.checkedBtns[btnKey(list[i].pageOpBtnId)]; }
    }
    /* 勾选管理页时，其所属页面的操作按钮默认全部勾选 */
    function checkItemButtons(item) {
        var list = item.buttons || [];
        for (var i = 0; i < list.length; i++) { state.checkedBtns[btnKey(list[i].pageOpBtnId)] = true; }
    }

    /* ---- 展开 / 收起（单击标题行） ---- */
    function toggleGroupBody(gid) {
        var $g = $tree.find('.pw-group[data-group="' + gid + '"]');
        if (!$g.length) { return; }
        $g.toggleClass('is-collapsed');
        $g.find('.pw-group__toggle').text($g.hasClass('is-collapsed') ? '展开' : '收起');
    }
    function toggleItemBody(gid, iid) {
        var $item = $tree.find('.pw-item[data-group="' + gid + '"][data-item="' + iid + '"]');
        if (!$item.length || !$item.find('.pw-btn').length) { return; }   // 没有按钮时单击不产生无意义收缩
        $item.toggleClass('is-btns-collapsed');
    }

    /* ---- 单击 / 双击分离：单击展开收起，双击才勾选（定时器区分单双击，避免一次双击触发两次动作） ---- */
    var DBL_MS = 260;
    function markClick($el, fn) {
        if ($el.data('pwClickTimer')) { clearTimeout($el.data('pwClickTimer')); }
        $el.data('pwClickTimer', setTimeout(function () {
            $el.removeData('pwClickTimer');
            fn();
        }, DBL_MS));
    }
    function cancelClick($el) {
        if ($el.data('pwClickTimer')) { clearTimeout($el.data('pwClickTimer')); $el.removeData('pwClickTimer'); }
    }
    function isSecondClick($el) {
        if (!$el.data('pwClickTimer')) { return false; }
        cancelClick($el);
        return true;
    }

    // 菜单项标题行：单击 = 展开 / 收起该页面的操作按钮；点复选框方块 = 立即切换；双击 = 勾选 / 取消
    $tree.on('click', '.pw-item__head', function (e) {
        if ($(e.target).is('input')) { return; }        // 真实复选框自身已触发 change
        var $head = $(this);
        var $item = $head.closest('.pw-item');
        var gid = parseInt($item.attr('data-group'), 10);
        var iid = parseInt($item.attr('data-item'), 10);
        if ($(e.target).closest('.el-checkbox').length) {   // 直接点复选框方块 → 立即生效，不必双击
            cancelClick($head);
            e.preventDefault();
            setItemChecked(gid, iid, !state.checked[keyOf(gid, iid)]);
            return;
        }
        if (isSecondClick($head)) { return; }               // 双击的第二次单击：交给 dblclick
        markClick($head, function () { toggleItemBody(gid, iid); });
    });

    // 菜单组标题行：单击 = 整组展开 / 收起；点组复选框 = 原生单击切换；双击 = 整组勾选 / 取消
    $tree.on('click', '.pw-group__head', function (e) {
        if ($(e.target).closest('.el-checkbox').length) { return; }        // 组复选框（label）原生已处理
        if ($(e.target).closest('.pw-group__toggle').length) { return; }   // 「展开/收起」自身有处理
        var $head = $(this);
        var gid = parseInt($(this).closest('.pw-group').attr('data-group'), 10);
        if (isSecondClick($head)) { return; }
        markClick($head, function () { toggleGroupBody(gid); });
    });

    // 双击菜单项标题行 → 勾选 / 取消勾选（同时按规则联动按钮权限）
    $tree.on('dblclick', '.pw-item__head', function (e) {
        if ($(e.target).is('input') || $(e.target).closest('.el-checkbox').length) { return; }
        cancelClick($(this));
        e.preventDefault();
        var $item = $(this).closest('.pw-item');
        var gid = parseInt($item.attr('data-group'), 10);
        var iid = parseInt($item.attr('data-item'), 10);
        setItemChecked(gid, iid, !state.checked[keyOf(gid, iid)]);
        try {   // 清掉双击选中的文字（不影响功能，只是观感）
            if (window.getSelection) { window.getSelection().removeAllRanges(); }
        } catch (err) { /* 忽略 */ }
    });

    // 双击菜单组标题行 → 整组勾选 / 取消勾选
    $tree.on('dblclick', '.pw-group__head', function (e) {
        if ($(e.target).closest('.el-checkbox').length) { return; }
        if ($(e.target).closest('.pw-group__toggle').length) { return; }
        cancelClick($(this));
        e.preventDefault();
        var gid = parseInt($(this).closest('.pw-group').attr('data-group'), 10);
        var group = findGroup(gid);
        if (!group) { return; }
        setGroupChecked(gid, !menuStatOf(group).all);
    });

    // 点击按钮胶囊文本也能切换（label 内的 input 已处理，这里兜住 disabled 情况）
    $tree.on('click', '.pw-btn.is-disabled', function (e) {
        e.preventDefault();
        UI.message({ type: 'warning', message: '请先勾选该页面（菜单权限），再配置页面按钮' });
    });

    // 「展开 / 收起」链接（菜单组）
    $tree.on('click', '.pw-group__toggle', function (e) {
        e.stopPropagation();
        toggleGroupBody(parseInt($(this).closest('.pw-group').attr('data-group'), 10));
    });

    // 查询（本地过滤） / 重置
    $('#btnSearch').on('click', function () {
        if (!state.roleId) {
            UI.message({ type: 'warning', message: '请先选择角色' });
            return;
        }
        state.keyword = $.trim($('#keyword').val()).toLowerCase();
        render();
    });
    $('#keyword').on('keydown', function (e) {
        if (e.keyCode === 13) { $('#btnSearch').trigger('click'); }
    });
    $('#btnReset').on('click', function () {
        $('#keyword').val('');
        state.keyword = '';
        if (!$roleSelect.val()) { $('#roleSelect').val($roleSelect.find('option').eq(1).val()); }
        state.roleId = String($roleSelect.val() || '');
        loadTree();
    });

    // 全选 / 反选 / 清空（菜单 + 按钮）
    $('#btnAll').on('click', function () {
        if (!state.roleId) { UI.message({ type: 'warning', message: '请先选择角色' }); return; }
        for (var i = 0; i < state.groups.length; i++) {
            var g = state.groups[i];
            for (var j = 0; j < g.items.length; j++) {
                state.checked[keyOf(g.menuGroupId, g.items[j].menuItemId)] = true;
                var list = g.items[j].buttons || [];
                for (var k = 0; k < list.length; k++) { state.checkedBtns[btnKey(list[k].pageOpBtnId)] = true; }
            }
        }
        render();
    });
    $('#btnInvert').on('click', function () {
        if (!state.roleId) { UI.message({ type: 'warning', message: '请先选择角色' }); return; }
        var nextChecked = {}, nextBtns = {};
        for (var i = 0; i < state.groups.length; i++) {
            var g = state.groups[i];
            for (var j = 0; j < g.items.length; j++) {
                var it = g.items[j];
                var k = keyOf(g.menuGroupId, it.menuItemId);
                var on = !state.checked[k];
                if (on) { nextChecked[k] = true; }
                // 反选后新获得菜单权限的页面，其操作按钮默认全部授权
                if (on) {
                    var list = it.buttons || [];
                    for (var x = 0; x < list.length; x++) { nextBtns[btnKey(list[x].pageOpBtnId)] = true; }
                }
            }
        }
        state.checked = nextChecked;
        state.checkedBtns = nextBtns;
        render();
    });
    $('#btnClear').on('click', function () {
        if (!state.roleId) { UI.message({ type: 'warning', message: '请先选择角色' }); return; }
        UI.confirm({
            title: '清空权限', type: 'warning',
            message: '确定清空角色【' + (state.roleName || '') + '】的全部菜单权限与页面按钮权限吗？清空后需要点「保存权限」才会生效。',
            confirmText: '确定清空', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            state.checked = {};
            state.checkedBtns = {};
            render();
            UI.message({ type: 'info', message: '已清空勾选（含按钮权限），点「保存权限」后生效' });
        });
    });

    // 展开 / 折叠 / 刷新 / 保存
    $('#btnExpand').on('click', function () {
        $tree.find('.pw-group').removeClass('is-collapsed');
        $tree.find('.pw-group__toggle').text('收起');
        $tree.find('.pw-item').removeClass('is-btns-collapsed');
    });
    $('#btnCollapse').on('click', function () {
        $tree.find('.pw-group').addClass('is-collapsed');
        $tree.find('.pw-group__toggle').text('展开');
        $tree.find('.pw-item').addClass('is-btns-collapsed');
    });
    $('#btnRefresh').on('click', function () {
        $('#keyword').val('');
        state.keyword = '';
        loadRoles().done(loadTree);
    });
    $('#btnSave').on('click', savePowers);

    /* ---------------- 初始化 ---------------- */
    readState();
    loadRoles().done(function () {
        if ($roleSelect.val()) {
            state.roleId = String($roleSelect.val());
            loadTree();
        } else {
            render();
        }
    });
});
