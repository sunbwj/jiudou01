/* ==========================================================================
   dbinfo.js —— 数据中心 · 数据库（dbinfomgr）
   --------------------------------------------------------------------------
   页面是「左 / 中 / 右」三块工作区：
   · 左区域：连接对象管理与查询（关键字 / 类型 / 状态检索 + 8 个**纯图标**操作按钮：
             新增 / 编辑 / 启用 / 停用 / 测试 / 扫描 / 删除 / 刷新，文案在 title 里 +
             紧凑列表 + 上一页下一页）；**双击**一条连接即扫描结构；
   · 中区域：库表结构（实例（库）→ 表 / 视图 树，懒加载）；
   · 右区域：**三个标签页**——「字段明细」（字段名 / 类型 / 键 / 是否可空 / 默认值 / 注解）、
             「数据」（双击表 / 视图后**懒加载**数据：表头固定、点列名排序、可按列筛选、滚到底加载更多）、
             「SQL 工作台」（上：实例 + 执行 / 清空 / 复制 + 编辑器；下：执行结果表格或错误信息）。
             双击表 / 视图 → 同时刷新字段明细、数据、SQL 编辑器里的 SELECT * FROM 表；
             **节点变了（换到另一张表 / 视图、或换了连接）时结果网格一律清空**，
             免得把上一张表的执行结果误当成当前表的数据；双击同一张表则保留结果便于对照。
   · 扫描只读目标库的系统元数据（information_schema / sqlite_master / PRAGMA / ALL_* 视图）；
     SQL 工作台只放行查询语句，执行完一律回滚，不会改动目标库任何数据。
   · 类型切换时表单会联动：SQLite 隐藏主机端口、把「默认库」换成「库文件路径」，端口按类型给默认值。
   ========================================================================== */
jQuery(function ($) {
    var $list = $('#dbList');
    var $pager = $('#dbPager');
    var $tree = $('#dbTree');
    var $colsBody = $('#dbColsBody');
    var STATE_KEY = 'dbinfo_state';

    /* 右区域标签页：字段明细 / SQL 工作台 */
    var $tabs = $('#dbTabs');
    var $tabItems = $tabs.find('.el-tabs__item');
    var $tabPanes = $tabs.find('.el-tab-pane');
    var $tabBar = $('#dbTabBar');
    var TAB_KEY = 'dbinfo_tab';
    var activeTab = 'cols';

    var state = {
        keyword: '', dbType: '', enabled: '',
        pageNum: 1, pageSize: 20, total: 0, pages: 1,
        rows: {},              // 当前页 id -> row
        selectedId: '',
        types: []
    };

    /* 结构树状态：只缓存节点数据，渲染时整体重绘（沿用 el-tree-node 结构） */
    var tree = {
        connId: '', connName: '',
        databases: [],
        tableMap: {},          // 库名 -> {tables, counts, error}
        columnMap: {},         // '库|表' -> {columns, error}
        expanded: {},          // 'db:库名'
        loading: {},           // 同上，正在加载的 key
        activeTable: '',       // '库|表'
        scannedAt: ''
    };

    /* SQL 工作台状态
       result —— 上一次执行返回的数据（结果网格就是它渲染出来的）
       source —— 结果对应的表 / 视图（'库|表'）；空串表示没有对应表（自己写的 SQL 或还没选表） */
    var sqlState = { running: false, result: null, source: '' };
    /* 结果区空态文案：清空按钮、双击换表、初次加载共用一套，别各写一份 */
    var SQL_RESULT_EMPTY = '在上面写好 SQL 后点「执行」，结果会显示在这里';

    /* ---------------- 右区域标签页 ---------------- */
    function moveTabBar() {
        var $cur = $tabItems.filter('.is-active');
        if (!$cur.length || !$tabBar.length) { return; }
        try {
            var left = $cur.position().left;
            var width = $cur.outerWidth();
            $tabBar.css({
                'width': width + 'px',
                '-webkit-transform': 'translateX(' + left + 'px)',
                'transform': 'translateX(' + left + 'px)'
            });
        } catch (e) { }
    }
    /**
     * 切换标签页
     *   cols —— 字段明细（点中间的表名时自动切过来）
     *   rows —— 数据（双击表 / 视图时自动切过来并懒加载）
     *   sql  —— SQL 工作台（手动点击时切过来）
     */
    function setDbTab(name) {
        if (name !== 'cols' && name !== 'rows' && name !== 'sql') { name = 'cols'; }
        activeTab = name;
        $tabItems.removeClass('is-active').attr('aria-selected', 'false');
        $tabItems.filter('[data-tab="' + name + '"]').addClass('is-active').attr('aria-selected', 'true');
        $tabPanes.removeClass('is-active');
        $tabPanes.filter('[data-pane="' + name + '"]').addClass('is-active');
        moveTabBar();
        try { window.sessionStorage.setItem(TAB_KEY, name); } catch (e) { }
    }
    function restoreTab() {
        var name = 'cols';
        try {
            var saved = window.sessionStorage.getItem(TAB_KEY);
            if (saved === 'sql' || saved === 'cols' || saved === 'rows') { name = saved; }
        } catch (e) { }
        setDbTab(name);
    }

    function esc(text) { return UI.escapeHtml(text === undefined || text === null ? '' : String(text)); }

    /**
     * 图标按钮的「进行中」态：只显示图标，所以不能像以前那样把文字改成「测试中…」，
     * 改为禁用 + 变淡 + 把 title 换成进行中文案，结束后还原（原文案存在 data-title 里）
     */
    function setToolBusy(id, busy, busyTitle) {
        var $btn = $(id);
        if (!$btn.length) { return; }
        if (!$btn.attr('data-title')) { $btn.attr('data-title', $btn.attr('title') || ''); }
        $btn.prop('disabled', !!busy).toggleClass('is-busy', !!busy)
            .attr('title', busy ? (busyTitle || $btn.attr('data-title')) : $btn.attr('data-title'));
    }
    function selected() { return state.rows[state.selectedId] || null; }
    function nowText() {
        var d = new Date();
        function pad(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    /* ---------------- 检索条件（切页 / 刷新后保持） ---------------- */
    function saveState() {
        try {
            window.sessionStorage.setItem(STATE_KEY, JSON.stringify({
                keyword: state.keyword, dbType: state.dbType, enabled: state.enabled,
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
            state.dbType = s.dbType || '';
            state.enabled = (s.enabled === 0 || s.enabled) ? String(s.enabled) : '';
            state.pageNum = parseInt(s.pageNum, 10) || 1;
            state.pageSize = parseInt(s.pageSize, 10) || 20;
            $('#dbKeyword').val(state.keyword);
            $('#dbType').val(state.dbType);
            $('#dbEnabled').val(state.enabled);
        } catch (e) { }
    }

    function syncToolbar() {
        var row = selected();
        $('#btnEdit, #btnTest, #btnScan, #btnEnable, #btnDisable, #btnDelete').prop('disabled', !row);
        if (row) {
            $('#btnEnable').prop('disabled', !!row.enabled);
            $('#btnDisable').prop('disabled', !row.enabled);
        }
    }

    /* ---------------- 数据库类型下拉 ---------------- */
    function typeMeta(value) {
        for (var i = 0; i < state.types.length; i++) {
            if (state.types[i].value === value) { return state.types[i]; }
        }
        return { value: value, label: value, port: 3306, hasFile: false };
    }
    function loadTypes() {
        return Api.dbInfo.types().done(function (data) {
            state.types = (data && data.list) || [];
            var html = '<option value="">全部类型</option>';
            for (var i = 0; i < state.types.length; i++) {
                html += '<option value="' + esc(state.types[i].value) + '">' +
                    esc(state.types[i].label) + '</option>';
            }
            $('#dbType').html(html).val(state.dbType);
        });
    }

    /* ================= 左区域：连接列表 ================= */
    function itemHtml(r) {
        var meta = r.typeLabel || r.dbType || '';
        return '<div class="db-item' + (String(r.id) === String(state.selectedId) ? ' is-selected' : '') +
            '" data-id="' + esc(r.id) + '" title="' +
                (r.enabled ? '双击扫描该连接的结构' : '该连接已停用，启用后才能扫描') + '">' +
                '<div class="db-item__top">' +
                    '<span class="db-item__name">' + esc(r.name) + '</span>' +
                    '<span class="db-item__dot' + (r.enabled ? ' is-on' : '') + '"></span>' +
                '</div>' +
                '<div class="db-item__meta">' +
                    '<span class="el-tag el-tag--info db-item__tag">' + esc(meta) + '</span>' +
                    // 私有连接给个橙色标记，公用（默认）不加噪
                    ((r.ispub === false || r.ispub === 0)
                        ? '<span class="el-tag el-tag--warning db-item__tag">私有</span>' : '') +
                    '<span class="db-item__server">' + esc(r.serverText || '-') + '</span>' +
                '</div>' +
                '<div class="db-item__db">库：' + esc(r.dbName || '-') + '</div>' +
                (r.lastError ? '<div class="db-item__err" title="' + esc(r.lastError) + '">' +
                    esc(r.lastError) + '</div>' : '') +
            '</div>';
    }

    function renderList(data) {
        var list = (data && data.list) || [];
        state.rows = {};
        $('#dbCount').text(state.total + ' 条');
        if (!list.length) {
            $list.html('<div class="db-list__empty">' +
                (state.keyword || state.dbType || state.enabled !== ''
                    ? '没有符合条件的数据库' : '还没有数据库，点「新增」添加一个') +
                '</div>');
            syncToolbar();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            state.rows[list[i].id] = list[i];
            html += itemHtml(list[i]);
        }
        $list.html(html);
        syncToolbar();
    }

    function renderPager() {
        if (!state.total) {
            $pager.html('');
            return;
        }
        $pager.html(
            '<button type="button" class="el-button el-button--small db-pager__btn" data-page="prev"' +
                (state.pageNum <= 1 ? ' disabled' : '') + '>上一页</button>' +
            '<span class="db-pager__info">' + state.pageNum + ' / ' + state.pages +
                '　共 ' + state.total + ' 条</span>' +
            '<button type="button" class="el-button el-button--small db-pager__btn" data-page="next"' +
                (state.pageNum >= state.pages ? ' disabled' : '') + '>下一页</button>');
    }

    function loadData() {
        UI.loading($list, true, '加载中…');
        Api.dbInfo.page({
            keyword: state.keyword, dbType: state.dbType, enabled: state.enabled,
            pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (data) {
            state.total = (data && data.total) || 0;
            state.pageNum = (data && data.pageNum) || 1;
            state.pageSize = (data && data.pageSize) || 20;
            state.pages = (data && data.pages) || 1;
            renderList(data);
            renderPager();
            saveState();
        }).fail(function (err) {
            $list.html('<div class="db-list__empty is-error">' +
                esc((err && err.message) || '加载失败') + '</div>');
        }).always(function () {
            UI.loading($list, false);
        });
    }

    /* ---------------- 新增 / 编辑（弹窗） ---------------- */
    function fillTypeOptions($select, current) {
        var html = '';
        for (var i = 0; i < state.types.length; i++) {
            html += '<option value="' + esc(state.types[i].value) + '">' + esc(state.types[i].label) + '</option>';
        }
        $select.html(html).val(current || 'mysql');
    }
    /** 类型联动：SQLite 只要路径；其它类型要主机 + 端口，端口留空按类型默认 */
    function syncTypeFields($f, isTypeChange) {
        var type = $f.find('#dfType').val() || 'mysql';
        var meta = typeMeta(type);
        var hasFile = !!meta.hasFile;
        $f.find('#dfHostItem').toggle(!hasFile);
        $f.find('#dfDbNameLabel').text(hasFile ? '库文件路径' : '默认库');
        $f.find('#dfDbName').attr('placeholder', hasFile
            ? '如 E:/data/demo.db（必填）'
            : '默认库 / 服务名 / SID（可留空）');
        $f.find('#dfDbNameTip').text(hasFile
            ? 'SQLite 用文件型数据库，这里填库文件的完整路径'
            : '扫描时会列出该实例下的全部库；留空则用连接账号的默认库');
        $f.find('#dfPort').attr('placeholder', String(meta.port || ''));
        /* 字符集提示按类型说话：SQL Server 留空就行（varchar 的 GBK 中文由后端自动还原），
           只有库排序规则不是中文（如西文 CP1252）才需要手工指定 */
        var charsetTip = {
            mysql: '可留空（默认 utf8mb4）；老库如 gbk 可填 gbk',
            mariadb: '可留空（默认 utf8mb4）；老库如 gbk 可填 gbk',
            sqlserver: '可留空：varchar 里的 GBK 中文会自动还原（CP936 / GBK / CP1252 仅特殊排序规则的库才需填）',
            postgresql: '可留空（默认 UTF8）；如 GBK 库可填 GBK',
            oracle: '可留空（按 NLS_LANG 走）；如 AL32UTF8 / ZHS16GBK',
            sqlite: 'SQLite 固定 UTF-8，这个可以留空'
        }[type] || '可留空（按数据库类型自动适配）';
        $f.find('#dfCharsetTip').text(charsetTip);
        var currentPort = $.trim($f.find('#dfPort').val());
        if (isTypeChange || !currentPort) {
            $f.find('#dfPort').val(hasFile ? '' : String(meta.port || ''));
        }
    }
    function openForm(row) {
        var isEdit = !!row;
        var $form = $('#dbFormTpl').children().clone(true);
        UI.dialog({
            title: isEdit ? ('编辑连接 —— ' + row.name) : '新增数据库',
            width: 620, content: $form,
            onReady: function ($body, close) {
                var $f = $body.find('.db-form');
                fillTypeOptions($f.find('#dfType'), isEdit ? row.dbType : 'mysql');
                if (isEdit) {
                    $f.find('#dfName').val(row.name || '');
                    $f.find('#dfHost').val(row.host || '');
                    $f.find('#dfPort').val(row.portText || '');
                    $f.find('#dfDbName').val(row.dbName || '');
                    $f.find('#dfUser').val(row.username || '');
                    $f.find('#dfPassword').attr('placeholder', '留空表示不修改（已保存密码）');
                    $f.find('#dfPasswordTip').text('当前已保存密码（' + (row.passwordMask || '******') +
                        '），留空不修改');
                    $f.find('#dfCharset').val(row.charset || '');
                    $f.find('#dfExtra').val(row.extraParams || '');
                    $f.find('#dfEnabled').val(row.enabled ? '1' : '0');
                    $f.find('#dfIspub').val(row.ispub === false || row.ispub === 0 ? '0' : '1');
                    $f.find('#dfRemark').val(row.remark || '');
                }
                syncTypeFields($f, false);
                $f.find('#dfType').on('change', function () { syncTypeFields($f, true); });
                $f.find('#dfName').trigger('focus');
            },
            onOk: function ($body, close) {
                var $f = $body.find('.db-form');
                var name = $.trim($f.find('#dfName').val());
                var type = $f.find('#dfType').val() || 'mysql';
                var meta = typeMeta(type);
                var host = $.trim($f.find('#dfHost').val());
                var dbName = $.trim($f.find('#dfDbName').val());
                var password = $f.find('#dfPassword').val() || '';
                if (!name) { UI.message({ type: 'warning', message: '请填写连接名称' }); return; }
                if (!meta.hasFile && !host) {
                    UI.message({ type: 'warning', message: '请填写主机地址' });
                    return;
                }
                if (meta.hasFile && !dbName) {
                    UI.message({ type: 'warning', message: 'SQLite 请填写库文件路径' });
                    return;
                }
                if (!isEdit && !password && !meta.hasFile) {
                    UI.message({ type: 'warning', message: '请填写数据库密码（无密码可填 none）' });
                    return;
                }
                var data = {
                    name: name, dbType: type, host: host,
                    port: $.trim($f.find('#dfPort').val()),
                    dbName: dbName,
                    username: $.trim($f.find('#dfUser').val()),
                    password: password,
                    charset: $.trim($f.find('#dfCharset').val()),
                    extraParams: $.trim($f.find('#dfExtra').val()),
                    enabled: $f.find('#dfEnabled').val() === '1' ? 1 : 0,
                    ispub: $f.find('#dfIspub').val() === '1' ? 1 : 0,   // 公用否（默认公用）
                    remark: $.trim($f.find('#dfRemark').val())
                };
                if (isEdit) { data.id = row.id; }
                var req = isEdit ? Api.dbInfo.update(data) : Api.dbInfo.add(data);
                req.done(function (saved) {
                    UI.message({ type: 'success', message: isEdit ? '保存成功' : '新增成功' });
                    state.selectedId = (saved && saved.id) || state.selectedId;
                    close();
                    loadData();
                    syncSqlConn();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    /* ---------------- 启用 / 停用 / 测试 / 删除 ---------------- */
    function setEnabled(on) {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条数据库' }); return; }
        if (!!row.enabled === !!on) {
            UI.message({ type: 'info', message: on ? '该连接已经是启用状态' : '该连接已经是停用状态' });
            return;
        }
        Api.dbInfo.setEnabled(row.id, on).done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || (on ? '已启用' : '已停用') });
            loadData();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
        });
    }

    function testConn(row) {
        row = row || selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条数据库' }); return; }
        setToolBusy('#btnTest', true, '正在测试连接…');
        Api.dbInfo.test(row.id).done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || '连接成功' });
            loadData();
        }).fail(function (err) {
            UI.alert({
                title: '连接测试未通过', type: 'warning',
                message: (err && err.message) || '请检查主机 / 端口 / 账号 / 密码，以及数据库是否允许远程连接'
            });
            loadData();
        }).always(function () {
            setToolBusy('#btnTest', false);
        });
    }

    function removeConn() {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条数据库' }); return; }
        UI.confirm({
            title: '删除数据库', type: 'warning',
            message: '确定删除连接「' + row.name + '」吗？（只删除系统里的连接信息，不会影响目标数据库）',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.dbInfo.remove(row.id).done(function () {
                UI.message({ type: 'success', message: '已删除' });
                if (String(tree.connId) === String(row.id)) { resetTree('已删除该连接，请重新选择'); }
                state.selectedId = '';
                loadData();
                syncSqlConn();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }

    /* ================= 中区域：库表结构 ================= */
    function resetTree(tip) {
        rowsState.connId = '';
        rowsState.table = '';
        rowsState.columns = [];
        rowsState.rows = [];
        rowsState.filters = [];
        rowsState.orderBy = '';
        rowsState.orderDir = '';
        rowsState.total = null;
        rowsState.hasMore = false;
        $('#dbRowsTable').text('未选择表');
        $('#dbRowsMeta').text('');
        $('#dbRowsChips').empty();
        $('#dbRowsFoot').prop('hidden', true);
        rowsEmpty('双击中间的表或视图，这里会懒加载它的数据：表头固定不滚动、点列名排序、可按列筛选');
        tree.connId = '';
        tree.connName = '';
        tree.databases = [];
        tree.tableMap = {};
        tree.columnMap = {};
        tree.expanded = {};
        tree.loading = {};
        tree.activeTable = '';
        tree.scannedAt = '';
        // 结构树整体重建 → 之前的执行结果不再对应任何表，一起清掉
        if (sqlState.result) { clearSqlResult('已切换连接，结果已清空；双击表 / 视图后可重新执行'); }
        sqlState.source = '';
        $('#dbTreeConn').text('未选择连接');
        $('#dbTreeTip').text('');
        $tree.html('<div class="db-tree__empty">' +
            esc(tip || '双击左侧任意一条连接，即可扫描出可用的数据库实例、表、视图；再双击表 / 视图加载它的字段、数据与 SQL') + '</div>');
        renderCols('', '', null);
    }

    function treeHead() {
        $('#dbTreeConn').text(tree.connName || '');
        $('#dbTreeTip').text(tree.scannedAt
            ? ('扫描于 ' + tree.scannedAt + ' · ' + tree.databases.length + ' 个实例')
            : '');
    }

    function dbNodeHtml(one) {
        var key = 'db:' + one.name;
        var open = !!tree.expanded[key];
        var loaded = tree.tableMap[one.name];
        var html = '<div class="el-tree-node' + (open ? ' is-expanded' : '') + '" data-kind="db" data-key="' +
            esc(key) + '" data-db="' + esc(one.name) + '">' +
            '<div class="el-tree-node__content" title="' + esc(one.name) + '">' +
                '<span class="el-tree-node__expand-icon' + (open ? ' is-expanded' : '') + '"></span>' +
                '<span class="el-tree-node__label">' +
                    '<span class="db-tree__kind is-db">库</span>' +
                    '<span class="db-tree__name">' + esc(one.name) + '</span>' +
                    (one.current ? '<i class="db-tree__tag is-current">当前</i>' : '') +
                    (one.system ? '<i class="db-tree__tag">系统</i>' : '') +
                    '<i class="db-tree__badge' + (Number(one.tableCount) ? '' : ' is-zero') + '">' +
                        (Number(one.tableCount) || 0) + '</i>' +
                '</span>' +
            '</div>';
        if (open) {
            html += '<div class="el-tree-node__children">';
            if (tree.loading[key]) {
                html += '<div class="db-tree__hint">正在加载表 / 视图…</div>';
            } else if (loaded && loaded.error) {
                html += '<div class="db-tree__hint is-error">' + esc(loaded.error) + '</div>';
            } else if (loaded && !(loaded.tables || []).length) {
                html += '<div class="db-tree__hint">这个库里没有表或视图</div>';
            } else if (loaded) {
                html += '<div class="db-tree__hint">表 ' + (loaded.counts.table || 0) +
                    ' 个 · 视图 ' + (loaded.counts.view || 0) + ' 个</div>';
                for (var i = 0; i < loaded.tables.length; i++) {
                    html += tableNodeHtml(one.name, loaded.tables[i]);
                }
            }
            html += '</div>';
        }
        return html + '</div>';
    }

    function tableNodeHtml(database, one) {
        var isView = one.kind === 'view';
        var mapKey = database + '|' + one.name;
        var active = tree.activeTable === mapKey;
        return '<div class="el-tree-node is-leaf-node' + (active ? ' is-active' : '') +
            '" data-kind="' + (isView ? 'view' : 'table') + '" data-key="tb:' + esc(mapKey) +
            '" data-db="' + esc(database) + '" data-table="' + esc(one.name) + '">' +
            '<div class="el-tree-node__content" title="' + esc(one.comment || one.name) +
                '（双击加载：字段明细 + 数据 + SQL）">' +
                '<span class="el-tree-node__expand-icon is-leaf"></span>' +
                '<span class="el-tree-node__label">' +
                    '<span class="db-tree__kind ' + (isView ? 'is-view' : 'is-table') + '">' +
                        (isView ? '视图' : '表') + '</span>' +
                    '<span class="db-tree__name">' + esc(one.name) + '</span>' +
                    (one.comment ? '<i class="db-tree__comment">' + esc(one.comment) + '</i>' : '') +
                    (!isView && Number(one.rows) ? '<i class="db-tree__badge">' + Number(one.rows) + ' 行</i>' : '') +
                '</span>' +
            '</div></div>';
    }

    function renderTree() {
        if (!tree.connId) { return; }
        treeHead();
        if (!tree.databases.length) {
            $tree.html('<div class="db-tree__empty">没有扫描到任何实例（库）</div>');
            return;
        }
        var html = '';
        for (var i = 0; i < tree.databases.length; i++) { html += dbNodeHtml(tree.databases[i]); }
        $tree.html(html);
    }

    function loadTables(database, thenRender) {
        var key = 'db:' + database;
        if (tree.tableMap[database] || tree.loading[key]) { return; }
        tree.loading[key] = true;
        tree.expanded[key] = true;
        renderTree();
        Api.dbInfo.tables(tree.connId, database).done(function (data) {
            tree.tableMap[database] = {
                tables: (data && data.tables) || [],
                counts: (data && data.counts) || { 'table': 0, 'view': 0 }
            };
        }).fail(function (err) {
            tree.tableMap[database] = { tables: [], error: (err && err.message) || '读取表 / 视图失败' };
        }).always(function () {
            delete tree.loading[key];
            renderTree();
        });
    }

    /** 中区域下半：字段明细（字段名 / 类型 / 键 / 非空 / 默认值 / 注解） */
    function renderCols(database, table, loaded) {
        $('#dbColsTitle').text(table ? ('字段明细 —— ' + table) : '字段明细');
        if (!table) {
            $('#dbColsHint').text('双击中间的表或视图查看字段');
            $colsBody.html('<div class="db-cols__empty">选中左边的连接并展开库、<b>双击</b>中间的表或视图，' +
                '这里会列出字段名、字段类型、是否可空、键与字段注解</div>');
            return;
        }
        $('#dbColsHint').text((database || '') + ' · ' + (loaded && loaded.columns
            ? loaded.columns.length + ' 个字段' : ''));
        if (!loaded) {
            $colsBody.html('<div class="db-cols__empty">正在读取字段…</div>');
            return;
        }
        if (loaded.error) {
            $colsBody.html('<div class="db-cols__empty is-error">' + esc(loaded.error) + '</div>');
            return;
        }
        var cols = loaded.columns || [];
        if (!cols.length) {
            $colsBody.html('<div class="db-cols__empty">这张表没有字段信息</div>');
            return;
        }
        var html = '<table class="db-cols__table"><thead><tr>' +
            '<th class="is-col-name">字段名</th><th>字段类型</th><th class="is-center">键</th>' +
            '<th class="is-center">可空</th><th>默认值</th><th>字段注解</th>' +
            '</tr></thead><tbody>';
        for (var i = 0; i < cols.length; i++) {
            var one = cols[i];
            html += '<tr>' +
                '<td class="is-col-name"><span class="db-col__name">' + esc(one.name) + '</span></td>' +
                '<td><span class="db-col__type">' + esc(one.dataType || '') + '</span></td>' +
                '<td class="is-center">' + (one.key
                    ? '<i class="db-tree__key ' + (one.key === 'PRI' ? 'is-pri' : '') + '">' +
                        esc(one.key) + '</i>' : '') + '</td>' +
                '<td class="is-center">' + (one.nullable ? '是' : '否') + '</td>' +
                '<td class="is-mono">' + esc(one.defaultValue === '' || one.defaultValue === null ||
                    one.defaultValue === undefined ? '-' : one.defaultValue) + '</td>' +
                '<td title="' + esc(one.comment || '') + '">' + esc(one.comment || '-') + '</td>' +
                '</tr>';
        }
        $colsBody.html(html + '</tbody></table>');
    }

    /**
     * 读字段并渲染到「字段明细」网格（**不切标签**：双击表时三个标签一起刷新，切不切由调用方决定）
     * @param force bool 强制重新读（双击同一个表时用于刷新）
     */
    function loadColumns(database, table, force) {
        var mapKey = database + '|' + table;
        tree.activeTable = mapKey;
        renderTree();
        if (force) { delete tree.columnMap[mapKey]; }
        if (tree.columnMap[mapKey]) {
            renderCols(database, table, tree.columnMap[mapKey]);
            return;
        }
        renderCols(database, table, null);
        Api.dbInfo.columns(tree.connId, database, table).done(function (data) {
            tree.columnMap[mapKey] = { columns: (data && data.columns) || [] };
        }).fail(function (err) {
            tree.columnMap[mapKey] = { columns: [], error: (err && err.message) || '读取字段失败' };
        }).always(function () {
            renderCols(database, table, tree.columnMap[mapKey]);
        });
    }

    /** 扫描连接：实例（库）列表；成功后刷新 SQL 工作台的实例下拉 */
    function scanConn(row) {
        row = row || selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条数据库' }); return; }
        tree.connId = row.id;
        tree.connName = row.name + '（' + (row.typeLabel || row.dbType) + ' · ' + (row.serverText || '-') + '）';
        tree.databases = [];
        tree.tableMap = {};
        tree.columnMap = {};
        tree.expanded = {};
        tree.loading = {};
        tree.activeTable = '';
        tree.scannedAt = '';
        treeHead();
        // 换连接 / 重新扫描 → 库表结构换了，旧的执行结果不再属于当前树，清空免得误读
        if (sqlState.result) { clearSqlResult('已切换连接，结果已清空；双击表 / 视图后重新执行'); }
        sqlState.source = '';
        renderCols('', '', null);
        $tree.html('<div class="db-tree__empty">正在扫描「' + esc(row.name) + '」…</div>');
        setToolBusy('#btnScan', true, '正在扫描结构…');
        Api.dbInfo.scan(row.id).done(function (data) {
            tree.databases = (data && data.databases) || [];
            tree.scannedAt = (data && data.scannedAt) || '';
            renderTree();
            fillSqlDb(tree.databases);
            syncSqlConn();
            UI.message({ type: 'success', message: '扫描完成：共 ' + tree.databases.length + ' 个实例' });
            // 自动展开「当前库」或第一个非系统库，省一次点击
            var pick = null;
            for (var i = 0; i < tree.databases.length; i++) {
                if (tree.databases[i].current) { pick = tree.databases[i]; break; }
            }
            if (!pick) {
                for (var j = 0; j < tree.databases.length; j++) {
                    if (!tree.databases[j].system) { pick = tree.databases[j]; break; }
                }
            }
            if (!pick && tree.databases.length) { pick = tree.databases[0]; }
            if (pick) {
                loadTables(pick.name, true);
                if (!$('#sqlDb').val()) { $('#sqlDb').val(pick.name); }
            }
            loadData();
        }).fail(function (err) {
            tree.databases = [];
            $tree.html('<div class="db-tree__empty is-error">扫描失败：' +
                esc((err && err.message) || '请检查连接信息') + '</div>');
            UI.message({ type: 'error', message: (err && err.message) || '扫描失败' });
            loadData();
        }).always(function () {
            setToolBusy('#btnScan', false);
        });
    }

    /* ================= 右区域 · 数据标签页（懒加载 + 固定表头 + 排序 + 筛选） ================= */
    var ROW_OPS = [
        { value: 'eq', label: '等于' }, { value: 'ne', label: '不等于' },
        { value: 'gt', label: '大于' }, { value: 'ge', label: '大于等于' },
        { value: 'lt', label: '小于' }, { value: 'le', label: '小于等于' },
        { value: 'contains', label: '包含' }, { value: 'starts', label: '开头是' },
        { value: 'ends', label: '结尾是' }, { value: 'null', label: '为空' },
        { value: 'notnull', label: '不为空' }
    ];
    var ROWS_PAGE_SIZE = 100;              // 每次懒加载 100 行，滚到底再取下一页
    var rowsState = {
        connId: '', database: '', table: '',
        columns: [], rows: [], filters: [],
        orderBy: '', orderDir: '',
        pageNum: 0, pageSize: ROWS_PAGE_SIZE, total: null, hasMore: false,
        loading: false, error: '', elapsed: 0
    };

    function opLabel(op) {
        for (var i = 0; i < ROW_OPS.length; i++) {
            if (ROW_OPS[i].value === op) { return ROW_OPS[i].label; }
        }
        return op || '等于';
    }
    function rowsEmpty(text, isError) {
        $('#dbRowsGrid').html('<div class="db-rows__empty' + (isError ? ' is-error' : '') + '">' +
            esc(text) + '</div>');
    }
    function rowsMeta() {
        var parts = [];
        parts.push(rowsState.total === null || rowsState.total === undefined
            ? ('已加载 ' + rowsState.rows.length + ' 行')
            : ('已加载 ' + rowsState.rows.length + ' / 共 ' + rowsState.total + ' 行'));
        if (rowsState.orderBy) {
            parts.push('按 ' + rowsState.orderBy + (rowsState.orderDir === 'desc' ? ' 降序' : ' 升序'));
        }
        if (rowsState.filters.length) { parts.push('筛选 ' + rowsState.filters.length + ' 条'); }
        if (rowsState.elapsed) { parts.push(rowsState.elapsed + ' ms'); }
        $('#dbRowsMeta').text(parts.join(' · '));
    }
    function renderChips() {
        var html = '';
        for (var i = 0; i < rowsState.filters.length; i++) {
            var one = rowsState.filters[i];
            var label = one.column + ' ' + opLabel(one.op) +
                (one.op === 'null' || one.op === 'notnull' ? '' : ' ' + one.value);
            html += '<span class="db-chip"><span class="db-chip__txt">' + esc(label) + '</span>' +
                '<button type="button" class="db-chip__del" data-index="' + i +
                '" title="移除这条筛选">×</button></span>';
        }
        $('#dbRowsChips').html(html);
    }
    function renderRowFilterOptions() {
        var html = '', i;
        for (i = 0; i < rowsState.columns.length; i++) {
            html += '<option value="' + esc(rowsState.columns[i]) + '">' + esc(rowsState.columns[i]) + '</option>';
        }
        if (!html) { html = '<option value="">（先双击表或视图）</option>'; }
        var keep = $('#rowFilterCol').val();
        $('#rowFilterCol').html(html);
        if (keep) { $('#rowFilterCol').val(keep); }
    }
    /** 整表重绘：表头（可点排序）+ 已加载的行；表头用 CSS sticky 固定，不随数据滚动 */
    function renderRows() {
        rowsMeta();
        var cols = rowsState.columns;
        if (!cols.length) {
            if (!rowsState.error) { rowsEmpty('正在加载数据…'); }
            return;
        }
        var html = '<table class="db-rows__table"><thead><tr><th class="is-idx">#</th>';
        for (var c = 0; c < cols.length; c++) {
            var name = cols[c];
            var sorted = rowsState.orderBy === name;
            var arrow = sorted ? (rowsState.orderDir === 'desc' ? '↓' : '↑') : '↕';
            html += '<th class="is-sortable' + (sorted ? ' is-sorted' : '') + '" data-col="' + esc(name) +
                '" title="点一下排序：' + esc(name) + '">' +
                '<span class="db-rows__colname">' + esc(name) + '</span>' +
                '<span class="db-rows__sort' + (sorted ? (rowsState.orderDir === 'desc' ? ' is-desc' : ' is-asc') : '') +
                '">' + arrow + '</span></th>';
        }
        html += '</tr></thead><tbody>';
        for (var r = 0; r < rowsState.rows.length; r++) {
            html += '<tr><td class="is-idx">' + (r + 1) + '</td>';
            for (var i = 0; i < cols.length; i++) {
                var val = rowsState.rows[r][i];
                var text = (val === null || val === undefined) ? '' : String(val);
                html += '<td title="' + esc(text) + '">' +
                    (text === '' ? '<i class="db-rows__null">NULL</i>' : esc(text)) + '</td>';
            }
            html += '</tr>';
        }
        if (!rowsState.rows.length) {
            html += '<tr><td class="is-idx">-</td><td class="db-rows__none" colspan="' + cols.length +
                '">没有符合条件的数据</td></tr>';
        }
        html += '</tbody></table>';
        $('#dbRowsGrid').html(html);
        $('#dbRowsFoot').prop('hidden', !rowsState.hasMore);
        $('#dbRowsMoreTip').text(rowsState.hasMore ? '还有更多数据，滚动到底会自动加载' : '');
    }

    /** 读一页：append=true 追加下一页（懒加载）；false 从第 1 页重读（排序 / 筛选 / 刷新） */
    function fetchRows(append) {
        if (!rowsState.connId || !rowsState.table) {
            rowsEmpty('双击中间的表或视图，这里会懒加载它的数据：表头固定不滚动、点列名排序、可按列筛选');
            return;
        }
        if (rowsState.loading) { return; }
        rowsState.loading = true;
        var nextPage = append ? (rowsState.pageNum + 1) : 1;
        if (append) {
            $('#btnRowsMore').prop('disabled', true).text('加载中…');
        } else {
            rowsState.rows = [];
            rowsState.error = '';
            rowsEmpty('正在加载数据…');
            $('#dbRowsFoot').prop('hidden', true);
        }
        Api.dbInfo.rows(rowsState.connId, {
            database: rowsState.database, table: rowsState.table,
            pageNum: nextPage, pageSize: rowsState.pageSize,
            orderBy: rowsState.orderBy, orderDir: rowsState.orderDir,
            filters: rowsState.filters
        }).done(function (data) {
            data = data || {};
            if (!append) {
                rowsState.columns = data.columns || [];
                rowsState.rows = [];
            }
            var incoming = data.rows || [];
            for (var i = 0; i < incoming.length; i++) { rowsState.rows.push(incoming[i]); }
            rowsState.pageNum = data.pageNum || nextPage;
            rowsState.total = (data.total === undefined) ? null : data.total;
            rowsState.hasMore = !!data.hasMore;
            rowsState.elapsed = data.elapsed || 0;
            rowsState.error = '';
            renderRows();
            renderRowFilterOptions();
        }).fail(function (err) {
            rowsState.error = (err && err.message) || '读取数据失败';
            if (!rowsState.rows.length) { rowsEmpty(rowsState.error, true); }
            rowsMeta();
        }).always(function () {
            rowsState.loading = false;
            $('#btnRowsMore').prop('disabled', false).text('加载更多');
        });
    }

    /** 双击树里的表 / 视图：切到「数据」标签页并懒加载第 1 页（排序与筛选复位） */
    function openTableRows(database, table) {
        rowsState.connId = tree.connId || state.selectedId;
        rowsState.database = database || '';
        rowsState.table = table || '';
        rowsState.columns = [];
        rowsState.rows = [];
        rowsState.filters = [];
        rowsState.orderBy = '';
        rowsState.orderDir = '';
        rowsState.pageNum = 0;
        rowsState.total = null;
        rowsState.hasMore = false;
        rowsState.error = '';
        rowsState.elapsed = 0;
        $('#dbRowsTable').text((database ? database + '.' : '') + table);
        $('#dbRowsMeta').text('');
        $('#dbRowsChips').empty();
        $('#dbRowsFilterBar').prop('hidden', true);
        $('#dbRowsFoot').prop('hidden', true);
        rowsEmpty('正在加载「' + table + '」的数据…');
        fetchRows(false);
    }

    /* ================= 右区域：SQL 工作台 ================= */
    function fillSqlDb(databases) {
        var list = databases || [];
        var html = '<option value="">默认库</option>';
        for (var i = 0; i < list.length; i++) {
            html += '<option value="' + esc(list[i].name) + '">' + esc(list[i].name) +
                (list[i].current ? '（当前）' : '') + '</option>';
        }
        var keep = $('#sqlDb').val();
        $('#sqlDb').html(html);
        if (keep) { $('#sqlDb').val(keep); }
    }

    /** 同步 SQL 区域显示：当前连接名 + 该连接已扫描到的实例 */
    function syncSqlConn() {
        var row = selected();
        if (!row) {
            $('#sqlConnName').text('未选择连接');
            fillSqlDb([]);
            return;
        }
        $('#sqlConnName').text(row.name + ' · ' + (row.serverText || '-'));
        if (String(tree.connId) === String(row.id) && tree.databases.length) {
            fillSqlDb(tree.databases);
        } else {
            fillSqlDb([]);
            if (row.dbName) {
                $('#sqlDb').append('<option value="' + esc(row.dbName) + '">' + esc(row.dbName) +
                    '（默认）</option>');
                $('#sqlDb').val(row.dbName);
            }
        }
    }

    function quoteTable(name) {
        var row = selected() || {};
        var type = String(row.dbType || 'mysql').toLowerCase();
        if (type === 'sqlserver') { return '[' + name + ']'; }
        if (type === 'mysql' || type === 'mariadb') { return '`' + name + '`'; }
        return '"' + name + '"';
    }

    function resultInfo(text, isError) {
        $('#sqlInfo').text(text).toggleClass('is-error', !!isError);
    }

    function renderResult(data) {
        sqlState.result = data;
        var msg = (data && data.message) || '';
        var extra = [];
        if (data && data.database) { extra.push('库 ' + data.database); }
        if (data && data.elapsed !== undefined && data.elapsed !== null) { extra.push('耗时 ' + data.elapsed + ' ms'); }
        resultInfo(msg + (extra.length ? ' · ' + extra.join(' · ') : ''), false);
        var cols = (data && data.columns) || [];
        if (!cols.length) {
            $('#sqlResult').html('<div class="db-result__msg">' +
                esc(msg || '执行成功（该语句没有返回结果集）') + '</div>');
            return;
        }
        var rows = (data && data.rows) || [];
        var html = '<table class="db-result__table"><thead><tr>' +
            '<th class="is-idx">#</th>';
        for (var c = 0; c < cols.length; c++) {
            html += '<th title="' + esc(cols[c].name) + '">' + esc(cols[c].name) + '</th>';
        }
        html += '</tr></thead><tbody>';
        if (!rows.length) {
            html += '<tr><td class="is-idx">-</td><td colspan="' + cols.length +
                '" class="db-result__none">查询成功，没有匹配的数据</td></tr>';
        }
        for (var r = 0; r < rows.length; r++) {
            html += '<tr><td class="is-idx">' + (r + 1) + '</td>';
            for (var i = 0; i < cols.length; i++) {
                var val = rows[r][i];
                var text = (val === null || val === undefined) ? '' : String(val);
                html += '<td title="' + esc(text) + '">' +
                    (text === '' ? '<i class="db-result__null">NULL</i>' : esc(text)) + '</td>';
            }
            html += '</tr>';
        }
        $('#sqlResult').html(html + '</tbody></table>');
    }

    function showSqlError(err) {
        var message = (err && err.message) || '执行失败';
        resultInfo('执行失败：' + message, true);
        $('#sqlResult').html('<div class="db-result__msg is-error">' + esc(message) + '</div>');
    }

    /**
     * 清空 SQL 工作台的结果网格（状态条 + 结果区一起回到空态）
     *   hint 省略时用默认的「点执行」提示；换表时传一句说明，告诉用户为什么被清掉
     */
    function clearSqlResult(hint) {
        sqlState.result = null;
        resultInfo('尚未执行', false);
        $('#sqlResult').html('<div class="db-result__empty">' +
            esc(hint || SQL_RESULT_EMPTY) + '</div>');
    }

    function runSql() {
        if (sqlState.running) { return; }
        var sql = $.trim($('#sqlText').val());
        if (!state.selectedId) {
            UI.message({ type: 'warning', message: '请先在左侧选择一条数据库' });
            return;
        }
        if (!sql) {
            UI.message({ type: 'warning', message: '请输入要执行的 SQL' });
            $('#sqlText').trigger('focus');
            return;
        }
        sqlState.running = true;
        var $btn = $('#btnSqlRun').prop('disabled', true).text('执行中…');
        resultInfo('正在执行…', false);
        Api.dbInfo.sqlrun(state.selectedId, sql, $('#sqlDb').val(), 200).done(function (data) {
            renderResult(data || {});
        }).fail(showSqlError).always(function () {
            sqlState.running = false;
            $btn.prop('disabled', false).text('执行');
        });
    }

    function copySql() {
        var text = $('#sqlText').val();
        if (!text) { UI.message({ type: 'info', message: 'SQL 编辑区是空的' }); return; }
        var done = function () { UI.message({ type: 'success', message: 'SQL 已复制到剪贴板' }); };
        try {
            if (window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText) {
                window.navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
                return;
            }
        } catch (e) { }
        legacyCopy(text, done);
    }
    function legacyCopy(text, done) {
        try {
            var area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.left = '-9999px';
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            document.body.removeChild(area);
            done();
        } catch (e) {
            UI.message({ type: 'error', message: '复制失败，请手动选中复制' });
        }
    }

    /* ---------------- 事件 ---------------- */
    function selectRow(id) {
        state.selectedId = id;
        $list.find('.db-item').removeClass('is-selected');
        $list.find('.db-item[data-id="' + id + '"]').addClass('is-selected');
        syncToolbar();
        syncSqlConn();
    }
    $list.on('click', '.db-item', function () { selectRow($(this).attr('data-id')); });
    $list.on('dblclick', '.db-item', function () {
        selectRow($(this).attr('data-id'));
        var row = selected();
        /* 停用的连接不扫描：双击只提醒，不进扫描流程（结构扫描对停用连接没有意义） */
        if (row && !row.enabled) {
            UI.message({ type: 'warning', message: '「' + esc(row.name) + '」已停用，需先「启用」后才能扫描结构' });
            return;
        }
        scanConn(row);
    });

    /* 列头点击排序：升序 → 降序 → 取消（每次重新从第 1 页读） */
    $('#dbRowsGrid').on('click', 'th.is-sortable', function () {
        var col = String($(this).attr('data-col') || '');
        if (!col) { return; }
        if (rowsState.orderBy !== col) {
            rowsState.orderBy = col;
            rowsState.orderDir = 'asc';
        } else if (rowsState.orderDir === 'asc') {
            rowsState.orderDir = 'desc';
        } else {
            rowsState.orderBy = '';
            rowsState.orderDir = '';
        }
        fetchRows(false);
    });
    /* 滚动到底部自动加载下一页（懒加载） */
    $('#dbRowsGrid').on('scroll', function () {
        var el = this;
        if (!rowsState.hasMore || rowsState.loading) { return; }
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) { fetchRows(true); }
    });
    $('#btnRowsMore').on('click', function () { fetchRows(true); });
    $('#btnRowsReload').on('click', function () {
        if (!rowsState.table) { UI.message({ type: 'warning', message: '请先双击一张表或视图' }); return; }
        fetchRows(false);
    });
    $('#btnRowsFilter').on('click', function () {
        var $bar = $('#dbRowsFilterBar');
        var show = $bar.prop('hidden');
        $bar.prop('hidden', !show);
        if (show) {
            renderRowFilterOptions();
            $('#rowFilterValue').trigger('focus');
        }
    });
    $('#rowFilterOp').on('change', function () {
        var op = $(this).val();
        var noValue = (op === 'null' || op === 'notnull');
        $('#rowFilterValue').prop('disabled', noValue).attr('placeholder',
            noValue ? '（为空 / 不为空不需要填值）' : '筛选值（为空/不为空可不填）');
    });
    $('#btnRowFilterAdd').on('click', function () {
        if (!rowsState.table) { UI.message({ type: 'warning', message: '请先双击一张表或视图' }); return; }
        var col = $('#rowFilterCol').val() || '';
        var op = $('#rowFilterOp').val() || 'eq';
        var value = $.trim($('#rowFilterValue').val());
        if (!col) { UI.message({ type: 'warning', message: '请选择筛选字段' }); return; }
        if (op !== 'null' && op !== 'notnull' && value === '') {
            UI.message({ type: 'warning', message: '请填写筛选值' });
            $('#rowFilterValue').trigger('focus');
            return;
        }
        rowsState.filters.push({ column: col, op: op, value: value });
        $('#rowFilterValue').val('');
        renderChips();
        fetchRows(false);
    });
    $('#btnRowFilterClear').on('click', function () {
        rowsState.filters = [];
        renderChips();
        fetchRows(false);
    });
    $('#dbRowsChips').on('click', '.db-chip__del', function () {
        var idx = parseInt($(this).attr('data-index'), 10);
        if (isNaN(idx) || !rowsState.filters[idx]) { return; }
        rowsState.filters.splice(idx, 1);
        renderChips();
        fetchRows(false);
    });

    $tabItems.on('click', function () { setDbTab($(this).attr('data-tab')); });
    $tabItems.on('keydown', function (e) {
        if (e.keyCode === 13 || e.keyCode === 32) {
            e.preventDefault();
            setDbTab($(this).attr('data-tab'));
        }
    });

    $pager.on('click', '.db-pager__btn', function () {
        var page = $(this).attr('data-page');
        if (page === 'prev' && state.pageNum > 1) { state.pageNum -= 1; }
        if (page === 'next' && state.pageNum < state.pages) { state.pageNum += 1; }
        loadData();
    });

    $tree.on('click', '.el-tree-node__content', function () {
        var $node = $(this).closest('.el-tree-node');
        var kind = $node.attr('data-kind');
        var database = String($node.attr('data-db') || '');
        if (kind === 'db') {
            var key = String($node.attr('data-key') || '');
            if (tree.expanded[key]) {
                delete tree.expanded[key];
                renderTree();
            } else {
                $('#sqlDb').val(database);        // 点开哪个库，SQL 区域就切到哪个库
                loadTables(database);
            }
            return;
        }
        // 表 / 视图节点：**单击不做事**（库表结构区容易误点，统一改成双击才加载，
        // 免得手一滑就把字段、数据、SQL 全刷成别的表）
    });

    /* 双击表名 → 把查询语句写进 SQL 编辑器（不自动执行，用户可再改条件） */
    $tree.on('dblclick', '.el-tree-node[data-kind="table"] .el-tree-node__content, ' +
        '.el-tree-node[data-kind="view"] .el-tree-node__content', function () {
        var $node = $(this).closest('.el-tree-node');
        var database = String($node.attr('data-db') || '');
        var table = String($node.attr('data-table') || '');
        if (!table) { return; }
        var prefix = database ? (quoteTable(database) + '.') : '';
        // 双击才加载（单击不做任何事，避免误操作把三个标签都刷成别的表）：
        //   ① 字段明细：重新读字段并渲染网格
        //   ② 数据：懒加载第 1 页（记录多时滚到底自动分页）
        //   ③ SQL 工作台：自动填充 select * from 当前表 / 视图
        // 当前停在哪个标签就留在哪个标签，不硬切（三个内容已经都在后台刷新好了）
        loadColumns(database, table, true);
        openTableRows(database, table);
        $('#sqlText').val('SELECT * FROM ' + prefix + quoteTable(table));
        // 换了一张表 / 视图（节点变了）→ 结果网格里的数据已经不属于当前表，必须清掉，
        // 否则会把上一张表的执行结果误当成这张表的数据；双击同一张表则保留结果，方便对照。
        var mapKey = database + '|' + table;
        var changed = sqlState.source !== mapKey;
        sqlState.source = mapKey;
        if (changed) {
            clearSqlResult('已切换到「' + (database ? database + '.' : '') + table +
                '」，上面的结果已清空；点「执行」查看这张表的数据');
        }
        UI.message({
            type: 'info',
            message: '已加载「' + table + '」：字段明细 / 数据 / SQL 语句都已刷新'
        });
    });

    $('#btnSearch').on('click', function () {
        state.keyword = $.trim($('#dbKeyword').val());
        state.dbType = $('#dbType').val() || '';
        state.enabled = $('#dbEnabled').val() === null ? '' : $('#dbEnabled').val();
        state.pageNum = 1;
        loadData();
    });
    $('#dbKeyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnSearch').trigger('click'); } });
    $('#btnReset').on('click', function () {
        $('#dbKeyword').val('');
        $('#dbType').val('');
        $('#dbEnabled').val('');
        state.keyword = ''; state.dbType = ''; state.enabled = '';
        state.pageNum = 1;
        loadData();
    });
    $('#btnAdd').on('click', function () { openForm(null); });
    $('#btnEdit').on('click', function () {
        var row = selected();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条数据库' }); return; }
        openForm(row);
    });
    $('#btnEnable').on('click', function () { setEnabled(true); });
    $('#btnDisable').on('click', function () { setEnabled(false); });
    $('#btnTest').on('click', function () { testConn(); });
    $('#btnScan').on('click', function () { scanConn(); });
    $('#btnDelete').on('click', removeConn);
    $('#btnRefresh').on('click', function () { loadData(); });
    $('#btnTreeRefresh').on('click', function () {
        var row = selected();
        if (tree.connId && String(tree.connId) !== String(state.selectedId)) {
            for (var id in state.rows) {
                if (state.rows.hasOwnProperty(id) && String(state.rows[id].id) === String(tree.connId)) {
                    row = state.rows[id];
                }
            }
        }
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条数据库' }); return; }
        scanConn(row);
    });

    $('#btnSqlRun').on('click', runSql);
    $('#btnSqlClear').on('click', function () {
        $('#sqlText').val('').trigger('focus');
        clearSqlResult();
    });
    $('#btnSqlCopy').on('click', copySql);
    $('#sqlText').on('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.keyCode === 13) {
            e.preventDefault();
            runSql();
        }
    });

    /* ================= 布局：容器太窄时三栏改上下堆叠 ================= */
    var STACK_WIDTH = 1040;         // .db-layout 实际宽度小于它就堆叠（268 + 380 + 结果区约 370 + 间距）
    function syncLayout() {
        var width = $('.db-layout').width() || 0;
        $('.db-page').toggleClass('is-stacked', width > 0 && width < STACK_WIDTH);
    }

    /* ---------------- 初始化 ---------------- */
    restoreState();
    resetTree();
    fillSqlDb([]);
    (function () {
        var html = '';
        for (var i = 0; i < ROW_OPS.length; i++) {
            html += '<option value="' + ROW_OPS[i].value + '">' + ROW_OPS[i].label + '</option>';
        }
        $('#rowFilterOp').html(html);
        renderRowFilterOptions();
        renderChips();
    })();
    syncToolbar();
    syncLayout();
    restoreTab();
    $(window).on('resize', function () {
        syncLayout();
        moveTabBar();
    });
    loadTypes().always(function () { loadData(); syncLayout(); moveTabBar(); });
});
