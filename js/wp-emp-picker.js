/* ==========================================================================
   wp-emp-picker.js —— 工作计划「选人」弹窗组件（组织架构树层次）
   --------------------------------------------------------------------------
   · 两种人员来源，共用同一棵组织架构树（部门可折叠、按 level 缩进）：
       ① 员工信息表  Api.workPlan.people().employees  —— 全量员工；
       ② 项目组成员  Api.workPlan.people().members   —— 当前计划关联项目的成员；
     未关联项目时第二个来源给出明确提示并可一键切回，不会出现「空面板」。
   · 一个组件两种模式：multiple=false 责任人（单选）/ true 参与人员（多选）；
   · 搜索按姓名 / 工号 / 部门 / 岗位 / 邮箱过滤，命中分支自动展开；
   · 离职员工（status=0）不可选；跨来源切换保留已选；已选标签可单个移除；
   · 只负责「选人」并回调，不直接改业务表单，便于复用与测试。
   用法：
     WpEmpPicker.open({
       title: '选取责任人', multiple: false,
       projectId: 'xxx', projectName: 'xxx项目',
       selected: [{ id: 3, name: '杨伟康' }],
       onOk: function (list) { list 为 [{id,name,code,deptName}] }
     });
   ========================================================================== */
(function (window, $) {
    'use strict';
    if (!$) { return; }

    function esc(t) {
        return window.UI && window.UI.escapeHtml
            ? window.UI.escapeHtml(t == null ? '' : t) : String(t == null ? '' : t);
    }
    function str(v) { return v == null ? '' : String(v); }
    function num(v) { return parseInt(v, 10) || 0; }

    function open(opt) {
        opt = opt || {};
        var multiple = !!opt.multiple;
        var projectId = str(opt.projectId);
        var projectName = str(opt.projectName);
        var picked = [], map = {};                 // [{id,name,code,deptName}] / id -> index
        var initial = opt.selected || [], i, one;
        for (i = 0; i < initial.length; i++) {
            one = initial[i] || {};
            if (str(one.id) === '' || map[str(one.id)] !== undefined) { continue; }
            map[str(one.id)] = picked.length;
            picked.push({ id: str(one.id), name: str(one.name) || str(one.nameCn),
                          code: str(one.code), deptName: str(one.deptName) });
            if (!multiple) { break; }
        }

        var st = {
            source: opt.source === 'group' ? 'group' : 'emp',
            keyword: '', collapsed: {}, data: null, loaded: false, loading: false, err: ''
        };

        var $box = $(
            '<div class="wp-emp-pick">' +
                '<div class="wp-ep-srcbar">' +
                    '<span class="wp-ep-srcbar__label">人员来源</span>' +
                    '<button type="button" class="wp-ep-src is-active" data-src="emp">员工信息表</button>' +
                    '<button type="button" class="wp-ep-src" data-src="group">项目组成员</button>' +
                    '<span class="wp-ep-srcbar__tip" id="wpEpSrcTip"></span>' +
                '</div>' +
                '<div class="emp-pick__search">' +
                    '<div class="el-input">' +
                        '<input class="el-input__inner" type="text" id="wpEpKeyword" ' +
                            'placeholder="搜索姓名 / 工号 / 部门 / 岗位 / 邮箱">' +
                    '</div>' +
                    '<button type="button" class="el-button el-button--primary" id="wpEpSearch">查询</button>' +
                    '<button type="button" class="el-button" id="wpEpExpand">全部收起</button>' +
                '</div>' +
                '<div class="wp-emp-pick__chosen" id="wpEpChosen"></div>' +
                '<div class="wp-ep-tree" id="wpEpTree"></div>' +
                '<div class="wp-emp-pick__foot">' +
                    '<span>已选 <b id="wpEpCount">0</b> 人' +
                        (multiple ? '（可多选，可跨部门 / 跨来源）' : '（单选，重新点选会替换）') + '</span>' +
                    '<span id="wpEpTotal"></span>' +
                '</div>' +
            '</div>'
        );
        var $tree = $box.find('#wpEpTree');
        var $chosen = $box.find('#wpEpChosen');
        var $count = $box.find('#wpEpCount');
        var $total = $box.find('#wpEpTotal');
        var $tip = $box.find('#wpEpSrcTip');

        /* ---------------- 选人状态 ---------------- */
        function isPicked(id) { return map[str(id)] !== undefined; }
        function syncChosen() {
            var html = '', k;
            for (k = 0; k < picked.length; k++) {
                html += '<span class="wp-emp-pick__tag" data-id="' + esc(picked[k].id) + '">' +
                    esc(picked[k].name) + '<b data-remove="' + esc(picked[k].id) + '" ' +
                    'title="移除">×</b></span>';
            }
            $chosen.html(html);
            $count.text(picked.length);
            paintRows();
        }
        function toggle(item) {
            var id = str(item.id), idx = map[id];
            if (idx !== undefined) {
                picked.splice(idx, 1);
                map = {};
                for (var k = 0; k < picked.length; k++) { map[picked[k].id] = k; }
            } else if (!multiple) {
                picked = [item]; map = {}; map[id] = 0;
            } else {
                map[id] = picked.length; picked.push(item);
            }
            syncChosen();
        }
        function paintRows() {
            $tree.find('.wp-ep-emp[data-id]').each(function () {
                var $tr = $(this), on = isPicked($tr.attr('data-id'));
                $tr.toggleClass('is-selected', on);
                $tr.find('input[type="checkbox"],input[type="radio"]').prop('checked', on);
            });
        }

        /* ---------------- 数据源 ---------------- */
        function empList() {
            if (!st.data) { return []; }
            return st.source === 'group' ? (st.data.members || []) : (st.data.employees || []);
        }
        function loadPeople() {
            st.loading = true; st.err = '';
            $tree.html('<div class="wp-ep-msg">正在加载组织架构与人员…</div>');
            if (window.Api && window.Api.workPlan && window.Api.workPlan.people) {
                window.Api.workPlan.people({ projectId: projectId }).done(function (data) {
                    st.loaded = true; st.loading = false;
                    st.data = normalize(data || {});
                    render();
                }).fail(function (err) {
                    st.loading = false;
                    st.err = (err && err.message) || '人员数据加载失败';
                    fallbackPeople();
                });
            } else {
                fallbackPeople();
            }
        }
        /* 老版本 api.js 没有 workplan/people 时退回组织树 + 员工分页，保证组件仍可用 */
        function fallbackPeople() {
            var orgs = [], employees = [];
            var orgReq = (window.Api && window.Api.org && window.Api.org.tree)
                ? window.Api.org.tree({}) : null;
            var empReq = (window.Api && window.Api.emp && window.Api.emp.page)
                ? window.Api.emp.page({ pageNum: 1, pageSize: 1000 }) : null;
            var pending = (orgReq ? 1 : 0) + (empReq ? 1 : 0);
            if (!pending) {
                st.loaded = true; st.loading = false; st.data = normalize({});
                render(); return;
            }
            function done() {
                pending--;
                if (pending > 0) { return; }
                st.loaded = true; st.loading = false;
                st.data = normalize({ orgs: orgs, employees: employees, members: [],
                                      projectId: projectId, projectName: projectName });
                render();
            }
            if (orgReq) {
                orgReq.done(function (d) { orgs = (d && d.list) || []; done(); })
                      .fail(function () { done(); });
            }
            if (empReq) {
                empReq.done(function (d) { employees = (d && d.list) || []; done(); })
                      .fail(function () { done(); });
            }
        }
        function normalize(data) {
            var orgs = [], employees = [], members = [], i, r;
            for (i = 0; i < (data.orgs || []).length; i++) {
                r = data.orgs[i] || {};
                if (num(r.id) === 0) { continue; }         // 跳过 id=0「顶级部门」虚拟根
                orgs.push({ id: num(r.id), parentId: num(r.parentId), level: num(r.level) || 1,
                            code: str(r.code), nameCn: str(r.nameCn) || str(r.name) });
            }
            function person(r) {
                return { id: num(r.empId || r.id), name: str(r.nameCn || r.name || r.empName),
                         code: str(r.code), deptId: num(r.deptId), deptName: str(r.deptName),
                         jobTitle: str(r.jobTitle), email: str(r.email),
                         status: r.status === undefined ? 1 : num(r.status),
                         statusText: str(r.statusText), fromGroup: !!r.fromGroup };
            }
            for (i = 0; i < (data.employees || []).length; i++) { employees.push(person(data.employees[i] || {})); }
            for (i = 0; i < (data.members || []).length; i++) { members.push(person(data.members[i] || {})); }
            return { orgs: orgs, employees: employees, members: members,
                     projectId: str(data.projectId || projectId),
                     projectName: str(data.projectName || projectName) };
        }

        /* ---------------- 组织架构树渲染 ---------------- */
        function matchEmp(e) {
            if (!st.keyword) { return true; }
            var kw = st.keyword.toLowerCase();
            return (e.name + ' ' + e.code + ' ' + e.deptName + ' ' + e.jobTitle + ' ' + e.email)
                .toLowerCase().indexOf(kw) > -1;
        }
        function deptHtml(d, bodyHtml, level, collapsed, count) {
            return '<div class="wp-ep-dept" data-dept="' + esc(d.id) + '" ' +
                    'style="padding-left:' + (8 + (level - 1) * 18) + 'px">' +
                    '<span class="wp-ep-toggle">' + (collapsed ? '▸' : '▾') + '</span>' +
                    '<span class="wp-ep-dept__name">' + esc(d.nameCn) + '</span>' +
                    '<span class="wp-ep-dept__code">' + esc(d.code) + '</span>' +
                    '<span class="wp-ep-dept__count">' + count + ' 人</span>' +
                '</div>' +
                (collapsed ? '' : bodyHtml);
        }
        function buildTree() {
            var orgs = (st.data && st.data.orgs) || [];
            var byParent = {}, byDept = {}, i, d, e;
            for (i = 0; i < orgs.length; i++) {
                d = orgs[i];
                if (!byParent[d.parentId]) { byParent[d.parentId] = []; }
                byParent[d.parentId].push(d);
            }
            var list = empList();
            for (i = 0; i < list.length; i++) {
                e = list[i];
                if (!matchEmp(e)) { continue; }
                if (!byDept[e.deptId]) { byDept[e.deptId] = []; }
                byDept[e.deptId].push(e);
            }
            var html = '', visited = {}, rendered = {}, searching = !!st.keyword;

            function empRow(e, level) {
                var disabled = e.status === 0;
                var tag = multiple ? 'checkbox' : 'radio';
                return '<div class="wp-ep-emp' + (disabled ? ' is-disabled' : '') +
                        (isPicked(e.id) ? ' is-selected' : '') + '" data-id="' + esc(e.id) +
                        '" data-name="' + esc(e.name) + '" data-code="' + esc(e.code) +
                        '" data-dept="' + esc(e.deptName) + '" style="padding-left:' +
                        (8 + level * 18) + 'px">' +
                    '<input type="' + tag + '" class="wp-ep-check" name="wpEpPick" value="' +
                        esc(e.id) + '"' + (isPicked(e.id) ? ' checked' : '') + (disabled ? ' disabled' : '') + '>' +
                    '<span class="wp-ep-emp__name">' + esc(e.name || '—') + '</span>' +
                    '<span class="wp-ep-emp__code">' + esc(e.code || '—') + '</span>' +
                    '<span class="wp-ep-emp__dept">' + esc(e.deptName || '—') + '</span>' +
                    '<span class="wp-ep-emp__job">' + esc(e.jobTitle || '') + '</span>' +
                    '<span class="el-tag el-tag--small ' + (disabled ? 'el-tag--info' : 'el-tag--success') + '">' +
                        esc(e.statusText || (disabled ? '离职' : '在职')) + '</span>' +
                '</div>';
            }
            /* 每个部门返回 {html, count}：count = 本部门命中人数 + 全部后代命中人数，
               徽标用它；搜索时整支无命中就返回空串（不留空部门）。 */
            function renderDept(d, level) {
                if (rendered[d.id]) { return { html: '', count: 0 }; }
                rendered[d.id] = 1;
                var kids = byParent[d.id] || [], sub = '', own = '', j, subCount = 0, res;
                for (j = 0; j < kids.length; j++) {
                    res = renderDept(kids[j], level + 1);
                    sub += res.html; subCount += res.count;
                }
                var emps = byDept[d.id] || [];
                for (j = 0; j < emps.length; j++) { own += empRow(emps[j], level); }
                var count = emps.length + subCount;
                if (searching && count === 0) { return { html: '', count: 0 }; }
                var collapsed = !searching && !!st.collapsed[d.id];
                return { html: deptHtml(d, sub + own, level, collapsed, count), count: count };
            }
            function walk(parentId, level) {
                var kids = byParent[parentId] || [], j, res;
                for (j = 0; j < kids.length; j++) {
                    if (visited[kids[j].id]) { continue; }
                    visited[kids[j].id] = 1;
                    res = renderDept(kids[j], level);
                    html += res.html;
                }
            }
            walk(0, 1);
            /* 父部门不在组织数据里的孤立部门：作为顶级补上，防止人员「消失」 */
            for (i = 0; i < orgs.length; i++) {
                if (!visited[orgs[i].id]) {
                    visited[orgs[i].id] = 1;
                    html += renderDept(orgs[i], 1).html;
                }
            }
            /* 未分配部门（deptId=0）或部门已被删除的人员统一放到虚拟分组 */
            var loose = byDept[0] || [], looseHtml = '', j2, known = {}, k;
            for (j2 = 0; j2 < loose.length; j2++) { looseHtml += empRow(loose[j2], 1); }
            for (k = 0; k < orgs.length; k++) { known[orgs[k].id] = 1; }
            for (k = 0; k < list.length; k++) {
                e = list[k];
                if (e.deptId && !known[e.deptId] && matchEmp(e)) {
                    looseHtml += empRow(e, 1);
                }
            }
            if (looseHtml) {
                html += deptHtml({ id: 'loose', code: '', nameCn: '未分配部门' }, looseHtml, 1,
                                 !searching && !!st.collapsed.loose,
                                 (looseHtml.match(/wp-ep-emp/g) || []).length);
            }
            return { html: html };
        }

        function render() {
            if (!st.loaded || !st.data) { return; }
            var list = empList();
            $box.find('.wp-ep-src').removeClass('is-active')
                .filter('[data-src="' + st.source + '"]').addClass('is-active');
            if (st.source === 'group') {
                if (!st.data.projectId) {
                    $tip.text('本计划未关联项目');
                } else {
                    $tip.text('关联项目：' + (st.data.projectName || st.data.projectId));
                }
            } else {
                $tip.text('按组织架构展开全部在职员工');
            }
            $total.text('当前来源 ' + list.length + ' 人');
            if (st.source === 'group' && !list.length) {
                $tree.html('<div class="wp-ep-msg">' +
                    (st.data.projectId
                        ? '该项目还没有项目组成员。请先在「项目信息 → 项目组管理」添加成员，'
                        : '这条工作计划没有关联项目，因此没有项目组成员。可在列表页新建时选择关联项目，') +
                    '或点上方「员工信息表」选取。<br><br>' +
                    '<button type="button" class="el-button el-button--small" id="wpEpBackEmp">切换到员工信息表</button>' +
                    '</div>');
                syncChosen();
                return;
            }
            if (st.err && !list.length) {
                $tree.html('<div class="wp-ep-msg">' + esc(st.err) + '</div>');
                syncChosen();
                return;
            }
            var built = buildTree();
            $tree.html(built.html || '<div class="wp-ep-msg">' +
                (st.keyword ? '没有匹配的员工，换个关键字试试' : '暂无可选人员') + '</div>');
            syncChosen();
        }

        /* ---------------- 交互 ---------------- */
        $box.on('click', '.wp-ep-src', function () {
            st.source = $(this).attr('data-src') === 'group' ? 'group' : 'emp';
            st.keyword = ''; $box.find('#wpEpKeyword').val('');
            render();
        });
        $box.on('click', '#wpEpBackEmp', function () {
            st.source = 'emp'; render();
        });
        $box.on('click', '#wpEpSearch', function () {
            st.keyword = $.trim($box.find('#wpEpKeyword').val());
            render();
        });
        $box.find('#wpEpKeyword').on('keydown', function (e) {
            if (e.keyCode === 13) { $box.find('#wpEpSearch').trigger('click'); }
        });
        $box.on('click', '#wpEpExpand', function () {
            var any = false, k;
            for (k in st.collapsed) { if (st.collapsed[k]) { any = true; break; } }
            st.collapsed = {};
            if (!any && st.data) {
                for (k = 0; k < (st.data.orgs || []).length; k++) { st.collapsed[st.data.orgs[k].id] = 1; }
                st.collapsed.loose = 1;
                $(this).text('全部展开');
            } else {
                $(this).text('全部收起');
            }
            render();
        });
        $tree.on('click', '.wp-ep-dept', function () {
            var id = String($(this).attr('data-dept'));
            st.collapsed[id] = !st.collapsed[id];
            render();
        });
        function pickFromRow($row) {
            return { id: $row.attr('data-id'), name: $row.attr('data-name'),
                     code: $row.attr('data-code'), deptName: $row.attr('data-dept') };
        }
        /* 点整行或勾选框都走同一个 toggle：阻止默认翻转，最终 checked 由 paintRows 统一回填 */
        $tree.on('click', '.wp-ep-check', function (e) {
            e.stopPropagation(); e.preventDefault();
            var $row = $(this).closest('.wp-ep-emp');
            if ($row.hasClass('is-disabled')) { return; }
            toggle(pickFromRow($row));
        });
        $tree.on('click', '.wp-ep-emp', function () {
            var $row = $(this);
            if ($row.hasClass('is-disabled')) { return; }
            toggle(pickFromRow($row));
        });
        $box.on('click', '[data-remove]', function (e) {
            e.stopPropagation();
            var id = String($(this).attr('data-remove')), idx = map[id];
            if (idx === undefined) { return; }
            picked.splice(idx, 1);
            map = {};
            for (var k = 0; k < picked.length; k++) { map[picked[k].id] = k; }
            syncChosen();
        });

        var dlg = window.UI.dialog({
            title: opt.title || (multiple ? '选取参与人员' : '选取责任人'),
            width: 760,
            content: $box,
            onReady: function ($body) {
                /* 选人弹窗常从「任务属性」弹窗里再打开，抬高一层保证不被盖住 */
                $body.closest('.el-overlay').css('z-index', 2100);
                syncChosen();
                loadPeople();
            },
            onOk: function ($body, close) {
                if (opt.onOk) { opt.onOk(picked.slice(0)); }
                close();
            }
        });
        return dlg;
    }

    window.WpEmpPicker = { open: open };
})(window, window.jQuery);
