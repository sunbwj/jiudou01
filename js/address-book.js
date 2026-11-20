/* ==========================================================================
   address-book.js —— 员工通讯录（只读查询）
   --------------------------------------------------------------------------
   · 左侧：组织架构树（部门层级 + 每个部门人数）→ 点击节点筛选右侧
           顶部「含下级部门」勾选后，选中某部门会连同其所有下级部门的员工一起显示
   · 右侧：关键字（姓名 / 工号 / 手机 / 邮箱 / 岗位）+ 在职状态检索，结果以「通讯录卡片」展示
   · **纯查询**：页面上没有任何新增 / 编辑 / 删除入口，接口也只有 tree / list 两个读取动作；
     卡片里只出现通讯录字段（工号 / 姓名 / 性别 / 手机 / 邮箱 / 部门 / 岗位 / 在职状态），
     身份证、照片、学历等档案信息不请求也不展示
   · 数据来自 /api/addressbook/tree 与 /api/addressbook/list（见 js/api.js 的 Api.addressBook）
   ========================================================================== */
jQuery(function ($) {
    var $tree = $('#abTree');
    var $grid = $('#abGrid');
    var $pager = $('#abPager');
    var $scope = $('#abScope');
    var $scopeCount = $('#abScopeCount');
    var $total = $('#abTotal');
    var $tip = $('#abScopeTip');

    var state = {
        tree: [],            // 部门树（原始）
        flat: {},            // id -> 节点（带祖先路径，便于面包屑与检索）
        deptId: 0,           // 0 = 全部员工
        unassigned: false,   // 只看「未分配部门」
        includeChildren: true,
        keyword: '',
        status: '',
        pageNum: 1,
        pageSize: 12,
        total: 0,
        expanded: {},        // 折叠状态：id -> true 表示展开（默认全部展开）
        collapsed: {},
        deptKeyword: ''
    };

    function esc(text) { return UI.escapeHtml(text === undefined || text === null ? '' : String(text)); }

    /** 内部页跳转：iframe 壳里走 AppFrame，独立打开时直接 location */
    function go(url) {
        if (window.AppFrame && typeof window.AppFrame.navigate === 'function') { window.AppFrame.navigate(url); }
        else { window.location.href = url; }
    }

    /** 复制到剪贴板：优先 navigator.clipboard，失败 / 非安全上下文回退 execCommand */
    function copyText(text, kind) {
        var label = kind === 'phone' ? '手机号' : '邮箱';
        function ok() { UI.message({ type: 'success', message: label + '已复制' }); }
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', 'readonly');
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            var done = false;
            try { done = document.execCommand('copy'); } catch (e) { done = false; }
            document.body.removeChild(ta);
            if (done) { ok(); } else { UI.message({ type: 'error', message: '复制失败，请手动选择复制' }); }
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok).catch(fallback);
        } else {
            fallback();
        }
    }

    function copyBtn(kind, value, label) {
        return '<button type="button" class="ab-copy" data-kind="' + kind + '" data-copy="' + esc(value) +
            '" title="' + label + '" aria-label="' + label + '">' +
            '<svg class="svg-ico" viewBox="0 0 24 24"><path fill="currentColor" d="M9 3h9a2 2 0 012 2v9h-2V5H9V3zM6 7h9a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2zm0 2v10h9V9H6z"/></svg>' +
            '</button>';
    }

    /* ---------------- 组织架构树 ---------------- */
    /** 展平树：补 pathNames（上级 / 本级），便于筛选后仍能显示父子链路 */
    function flatten(nodes, parentPath) {
        var out = {};
        for (var i = 0; i < (nodes || []).length; i++) {
            var n = nodes[i];
            var path = (parentPath ? parentPath + ' / ' : '') + n.nameCn;
            n.pathNames = path;
            out[String(n.id)] = n;
            var kids = flatten(n.children, path);
            for (var k in kids) { if (kids.hasOwnProperty(k)) { out[k] = kids[k]; } }
        }
        return out;
    }

    /** 部门关键字过滤：命中节点及其所有祖先保留（其余剪掉），保证树的结构完整 */
    function filterTree(nodes, kw) {
        if (!kw) { return nodes; }
        var out = [];
        for (var i = 0; i < (nodes || []).length; i++) {
            var n = nodes[i];
            var kids = filterTree(n.children, kw);
            var hit = String(n.nameCn || '').toLowerCase().indexOf(kw) > -1 ||
                String(n.code || '').toLowerCase().indexOf(kw) > -1;
            if (hit || kids.length) {
                var copy = $.extend({}, n);
                copy.children = kids;
                out.push(copy);
            }
        }
        return out;
    }

    function nodeHtml(n, depth) {
        var id = String(n.id);
        var hasKids = !!(n.children && n.children.length);
        var collapsed = !!state.collapsed[id];
        var current = (state.deptId === Number(n.id) && !state.unassigned) ? ' is-current' : '';
        var html = '<div class="el-tree-node' + (hasKids && !collapsed ? ' is-expanded' : '') +
            '" data-id="' + esc(id) + '" data-level="' + (Number(n.level) || 1) + '">' +
            '<div class="el-tree-node__content' + current + '" title="' + esc(n.pathNames || n.nameCn) + '">' +
                '<span class="el-tree-node__expand-icon' + (hasKids ? (collapsed ? '' : ' is-expanded') : ' is-leaf') + '"></span>' +
                '<span class="el-tree-node__label">' + esc(n.nameCn) +
                    '<i class="el-tree-node__code">' + esc(n.code || '') + '</i>' +
                    '<i class="ab-tree__count' + (Number(n.totalCount) ? '' : ' is-zero') + '">' +
                        (Number(n.totalCount) || 0) + '</i>' +
                '</span>' +
            '</div>';
        if (hasKids) {
            html += '<div class="el-tree-node__children"' + (collapsed ? ' style="display:none"' : '') + '>';
            for (var i = 0; i < n.children.length; i++) { html += nodeHtml(n.children[i], depth + 1); }
            html += '</div>';
        }
        return html + '</div>';
    }

    function renderTree() {
        var kw = String(state.deptKeyword || '').toLowerCase();
        var list = filterTree(state.tree, kw);
        var totalStaff = state.totalStaff || 0;
        var unassigned = state.unassignedCount || 0;

        var html = '';
        // 虚拟根：全部员工
        html += '<div class="el-tree-node is-expanded" data-id="0" data-level="0">' +
            '<div class="el-tree-node__content' + ((state.deptId === 0 && !state.unassigned) ? ' is-current' : '') +
                '" title="全部员工">' +
                '<span class="el-tree-node__expand-icon is-leaf"></span>' +
                '<span class="el-tree-node__label">全部员工' +
                    '<i class="ab-tree__count' + (totalStaff ? '' : ' is-zero') + '">' + totalStaff + '</i>' +
                '</span>' +
            '</div></div>';
        for (var i = 0; i < list.length; i++) { html += nodeHtml(list[i], 1); }
        if (!list.length && kw) {
            html += '<div class="ab-tree__empty">没有匹配的部门</div>';
        } else if (!state.tree.length) {
            html += '<div class="ab-tree__empty">组织架构里还没有部门，请先到「组织架构」中维护</div>';
        }
        // 未分配部门（有员工没挂部门时才显示）
        if (unassigned > 0) {
            html += '<div class="el-tree-node" data-id="-1" data-level="0">' +
                '<div class="el-tree-node__content' + (state.unassigned ? ' is-current' : '') +
                    '" title="未分配部门">' +
                    '<span class="el-tree-node__expand-icon is-leaf"></span>' +
                    '<span class="el-tree-node__label">未分配部门' +
                        '<i class="ab-tree__count">' + unassigned + '</i>' +
                    '</span>' +
                '</div></div>';
        }
        $tree.html(html);
    }

    function loadTree() {
        Api.addressBook.tree().done(function (data) {
            state.tree = (data && data.list) || [];
            state.flat = flatten(state.tree, '');
            state.totalStaff = (data && data.totalStaff) || 0;
            state.unassignedCount = (data && data.unassignedCount) || 0;
            renderTree();
            applyScope();
        }).fail(function (err) {
            $tree.html('<div class="ab-tree__empty">' + esc((err && err.message) || '组织架构加载失败') + '</div>');
        });
    }

    /* ---------------- 范围提示 ---------------- */
    function currentScopeName() {
        if (state.unassigned) { return '未分配部门'; }
        if (state.deptId > 0) {
            var node = state.flat[String(state.deptId)];
            var name = node ? (node.pathNames || node.nameCn) : ('部门 #' + state.deptId);
            return state.includeChildren ? (name + '（含下级部门）') : name;
        }
        return '全部员工';
    }
    function applyScope() {
        $scope.text(currentScopeName());
        $scopeCount.text('');
    }

    /* ---------------- 通讯录列表 ---------------- */
    function statusTag(it) {
        var status = Number(it.status);
        var cls = status === 1 ? 'el-tag--success' : (status === 2 ? 'el-tag--warning' : 'el-tag--info');
        return '<span class="el-tag el-tag--small ' + cls + '">' + esc(it.statusText || '') + '</span>';
    }

    function cardHtml(it) {
        var phone = String(it.phone || '');
        var email = String(it.email || '');
        return '<div class="ab-card" data-id="' + esc(it.id) + '">' +
            '<div class="ab-card__head">' +
                '<span class="ab-avatar">' + esc(it.avatarText || (it.nameCn || '').slice(0, 1)) + '</span>' +
                '<div class="ab-card__who">' +
                    '<div class="ab-name">' + esc(it.nameCn) + statusTag(it) + '</div>' +
                    '<div class="ab-job">' + esc([it.jobTitle, it.deptName].filter(function (x) { return !!x; }).join(' · ') || '—') + '</div>' +
                '</div>' +
            '</div>' +
            '<div class="ab-card__body">' +
                '<div class="ab-row"><span class="ab-row__label">工号</span>' +
                    '<span class="ab-row__value">' + esc(it.code || '—') + '</span></div>' +
                '<div class="ab-row"><span class="ab-row__label">手机</span>' +
                    (phone ? '<a class="ab-row__value is-link" href="tel:' + esc(phone) + '">' + esc(phone) + '</a>' +
                        copyBtn('phone', phone, '复制手机号')
                        : '<span class="ab-row__value is-empty">未填写</span>') + '</div>' +
                '<div class="ab-row"><span class="ab-row__label">邮箱</span>' +
                    (email ? '<a class="ab-row__value is-link ab-email" href="mailto:' + esc(email) +
                        '" data-email="' + esc(email) + '" title="' + esc(email) + '（双击写邮件）">' +
                        esc(email) + '</a>' + copyBtn('email', email, '复制邮箱')
                        : '<span class="ab-row__value is-empty">未填写</span>') + '</div>' +
            '</div>' +
            '</div>';
    }

    function renderList(data) {
        var list = (data && data.list) || [];
        state.total = (data && data.total) || 0;
        state.pageNum = (data && data.pageNum) || 1;
        state.pageSize = (data && data.pageSize) || 12;
        $total.text(state.total);
        if (!list.length) {
            $grid.html('<div class="ab-empty">' +
                (state.keyword || state.status !== '' ? '没有符合条件的员工'
                    : (state.unassigned ? '没有未分配部门的员工' : '该范围内还没有员工')) +
                '</div>');
            $pager.empty();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) { html += cardHtml(list[i]); }
        $grid.html(html);
        UI.pagination($pager, {
            total: state.total, pageNum: state.pageNum, pageSize: state.pageSize, sizes: [12, 24, 48],
            onChange: function (num, size) {
                state.pageNum = num; state.pageSize = size;
                loadList();
            }
        });
    }

    function loadList() {
        $grid.html('<div class="ab-empty">加载中…</div>');
        applyScope();
        Api.addressBook.page({
            keyword: state.keyword,
            status: state.status,
            deptId: state.unassigned ? '' : state.deptId,
            unassigned: state.unassigned ? 1 : '',
            includeChildren: state.includeChildren ? 1 : '',
            pageNum: state.pageNum,
            pageSize: state.pageSize
        }).done(renderList).fail(function (err) {
            $grid.html('<div class="ab-empty">' + esc((err && err.message) || '通讯录加载失败') + '</div>');
        });
    }

    /* ---------------- 事件 ---------------- */
    $tree.on('click', '.el-tree-node__expand-icon', function (e) {
        if ($(this).hasClass('is-leaf')) { return; }
        e.stopPropagation();
        var $node = $(this).closest('.el-tree-node');
        var id = String($node.attr('data-id'));
        var collapsed = !state.collapsed[id];
        state.collapsed[id] = collapsed;
        $node.toggleClass('is-expanded', !collapsed);
        $(this).toggleClass('is-expanded', !collapsed);
        $node.children('.el-tree-node__children').toggle(!collapsed);
    });

    $tree.on('click', '.el-tree-node__content', function () {
        var $node = $(this).closest('.el-tree-node');
        var id = parseInt($node.attr('data-id'), 10) || 0;
        if (id === -1) { state.unassigned = true; state.deptId = 0; }
        else { state.unassigned = false; state.deptId = id; }
        state.pageNum = 1;
        $tree.find('.el-tree-node__content').removeClass('is-current');
        $(this).addClass('is-current');
        loadList();
    });

    $('#abChildren').on('change', function () {
        $(this).closest('.el-checkbox').toggleClass('is-checked', $(this).prop('checked'));
        state.includeChildren = $(this).prop('checked');
        if (state.deptId > 0) { state.pageNum = 1; loadList(); } else { applyScope(); }
    });

    $('#abDeptKeyword').on('keydown', function (e) {
        if (e.keyCode === 13) {
            state.deptKeyword = $.trim($(this).val());
            renderTree();
        }
    }).on('input', function () {
        var val = $.trim($(this).val());
        if (!val) { state.deptKeyword = ''; renderTree(); }
    });

    $('#btnAbSearch').on('click', function () {
        state.keyword = $.trim($('#abKeyword').val());
        state.status = $('#abStatus').val();
        state.pageNum = 1;
        loadList();
    });
    $('#btnAbReset').on('click', function () {
        $('#abKeyword').val('');
        $('#abStatus').val('');
        $('#abDeptKeyword').val('');
        state.keyword = ''; state.status = ''; state.deptKeyword = '';
        // 重置 = 回到「全部员工」：部门范围、未分配标记、含下级偏好一并复位
        state.deptId = 0; state.unassigned = false;
        state.includeChildren = true;
        $('#abChildren').prop('checked', true).closest('.el-checkbox').addClass('is-checked');
        state.pageNum = 1;
        renderTree();
        loadList();
    });
    $('#abKeyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnAbSearch').trigger('click'); } });

    /* ---------------- 卡片：复制手机 / 邮箱，双击邮箱写邮件 ---------------- */
    $grid.on('click', '.ab-copy', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var text = $(this).attr('data-copy') || '';
        if (text) { copyText(text, $(this).attr('data-kind')); }
    });
    $grid.on('click', '.ab-email', function (e) { e.preventDefault(); });
    $grid.on('dblclick', '.ab-email', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var email = $(this).attr('data-email') || '';
        if (email) { go('emp-mail.html?compose=' + encodeURIComponent(email)); }
    });

    /* ---------------- 初始化 ---------------- */
    loadTree();
    loadList();
});
