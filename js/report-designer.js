/* ==========================================================================
   report-designer.js —— 数据中心 · 报表设计器（reportinfos）
   --------------------------------------------------------------------------
   页面是「左 / 中 / 右」三块工作区：
   · 左区域（两个页签）：
       ① 报表清单 —— 关键字 / 分类 / 状态检索 + 图标工具条（新建 / 复制 / 启用 / 停用 / 删除 / 刷新）
          + 报表卡片列表 + 上一页 / 下一页；**点一条卡片即打开继续编辑**；
       ② 数据源 —— 连接（数据中心 → 数据库里启用状态的连接）→ 实例（库）→ 表 / 视图 → 字段，
          **只有字段是可拖拽源**（`draggable`）：拖字段进中间画布，或双击字段，都只加入这一列；
          表 / 视图节点不参与拖拽，双击只展开它的字段（整表一次性铺开容易把已排好的列冲掉）；
   · 中区域：画布（纸张样式）—— 标题带 / 参数带 / 页眉 / 明细（拖拽落点 + 列头 + 示例行 + 汇总）/ 页脚；
          列可以在画布内左右拖动调整顺序，点列选中后到右栏改属性；
   · 右区域（三个页签）：
       ① 字段属性 —— 显示名 / 宽度 / 对齐 / 格式 / 汇总 / 是否显示 + 左移右移移除；
       ② 报表参数 —— 参数卡片（参数名 / 显示名 / 类型 / 控件 / 必填 / 默认值 / 下拉选项）+ 数据集 SQL；
       ③ 页面模板 —— 纸张 / 方向 / 四边距 / 字体字号 / 标题样式 / 斑马纹边框 / 页眉页脚 / 水印 / 页码时间；
   · 预览：弹窗里按参数定义渲染输入控件，执行只读查询并按列定义渲染表格（含汇总与页脚）；
   · 保存：写进报表信息表 reportinfos（columns / params / design / template 一起序列化成 JSON），
     保存后左侧清单会出现这张报表，其它页面用 `Api.report.run({code:'RPT0001'})` 即可调用。
   ========================================================================== */
jQuery(function ($) {
    'use strict';

    /* ---------- 与后端 ReportDesignerService / config 对齐的限制 ---------- */
    var MAX_PARAMS = 20;
    var MAX_COLUMNS = 60;
    var PREVIEW_ROWS = 500;

    /* ---------- 查看窗 / 元素渲染 / 打印导出：与「报表中心」共用 js/report-viewer.js ---------- */
    var RV = window.ReportViewer || {};
    var pv = RV.pv || { mode: 'preview', row: null };
    var pvState = RV.pvState || { result: null, page: 1, pageSize: 20, showRowNo: false, rowNoInit: false };   // 查看窗共享状态（mode / row）
    var esc = RV.esc;
    var textOf = RV.textOf;
    var boolOf = RV.boolOf;
    var intOf = RV.intOf;
    var nowText = RV.nowText;
    var optionsHtml = RV.optionsHtml;
    var pageBandHtml = RV.pageBandHtml;
    var elementsOf = RV.elementsOf;
    var walkElements = RV.walkElements;
    var elementStyle = RV.elementStyle;
    var visibleMapped = RV.visibleMapped;
    var tableRows = RV.tableRows;
    var tableCols = RV.tableCols;
    var tableCells = RV.tableCells;
    var elTableMarkup = RV.elTableMarkup;
    var chartPoints = RV.chartPoints;
    var chartSvg = RV.chartSvg;
    var elementHtml = RV.elementHtml;
    var elementsHtml = RV.elementsHtml;
    var elementsBottom = RV.elementsBottom;
    var elementBounds = RV.elementBounds;
    var renderPvBands = RV.renderPvBands;
    var stageScale = RV.stageScale;
    var renderPvFreeLayer = RV.renderPvFreeLayer;
    var paramInputHtml = RV.paramInputHtml;
    var setRunButton = RV.setRunButton;
    var footInfo = RV.footInfo;
    var showEfficiency = RV.showEfficiency;
    var setFootBusy = RV.setFootBusy;
    var showViewer = RV.showViewer;
    var runSavedReport = RV.runSavedReport;
    var collectParamValues = RV.collectParamValues;
    var formatValue = RV.formatValue;
    var summaryValue = RV.summaryValue;
    var applyPaperStyle = RV.applyPaperStyle;
    var renderPreviewPaper = RV.renderPreviewPaper;
    var closeTableMenu = RV.closeTableMenu;
    var openTableMenu = RV.openTableMenu;
    var setRowNo = RV.setRowNo;
    var drawPreviewFooter = RV.drawPreviewFooter;
    var visibleColumnsOf = RV.visibleColumnsOf;
    var fetchAllResult = RV.fetchAllResult;
    var printParamsLine = RV.printParamsLine;
    var paperMm = RV.paperMm;
    var printCss = RV.printCss;
    var buildPrintHtml = RV.buildPrintHtml;
    var writePrintFrame = RV.writePrintFrame;
    var printReport = RV.printReport;
    var saveBlob = RV.saveBlob;
    var exportReport = RV.exportReport;

    var PARAM_TYPES = [
        { value: 'string', label: '文本' },
        { value: 'int', label: '整数' },
        { value: 'number', label: '数字' },
        { value: 'date', label: '日期' },
        { value: 'datetime', label: '日期时间' },
        { value: 'bool', label: '是 / 否' }
    ];
    var PARAM_CONTROLS = [
        { value: 'text', label: '输入框' },
        { value: 'number', label: '数字框' },
        { value: 'date', label: '日期选择' },
        { value: 'select', label: '下拉单选' },
        { value: 'multiselect', label: '下拉多选' },
        { value: 'checkbox', label: '勾选' }
    ];
    var COLUMN_FORMATS = [
        { value: 'text', label: '文本' },
        { value: 'int', label: '整数' },
        { value: 'number', label: '小数（两位）' },
        { value: 'money', label: '金额（￥）' },
        { value: 'percent', label: '百分比' },
        { value: 'date', label: '日期' },
        { value: 'datetime', label: '日期时间' }
    ];
    var COLUMN_SUMMARY = [
        { value: 'none', label: '不汇总' },
        { value: 'sum', label: '求和' },
        { value: 'avg', label: '平均值' },
        { value: 'count', label: '计数' },
        { value: 'max', label: '最大值' },
        { value: 'min', label: '最小值' }
    ];

    var DEFAULT_DESIGN = {
        title: '', subtitle: '', headerText: '', footerText: '',
        showTitle: true, showParams: true, zebra: true, bordered: true,
        showSummary: true, groupBy: '',
        elements: []                  // 设计区组件（工具箱里的文本 / 线条 / 区域 / 图像 / 图表 / 明细表）
    };
    /** 新画布：elements 必须每次新建数组，不能共用默认对象里的那一个 */
    function defaultDesign() {
        var out = $.extend({}, DEFAULT_DESIGN);
        out.elements = [];
        return out;
    }
    var DEFAULT_TEMPLATE = {
        paper: 'A4', orientation: 'portrait',
        marginTop: 12, marginRight: 10, marginBottom: 12, marginLeft: 10,
        fontFamily: 'Microsoft YaHei', fontSize: 12,
        titleSize: 18, titleAlign: 'center', titleBold: true,
        compact: false, showPageNo: true, showTime: true, watermark: ''
    };

    /* ---------- 页面元素 ---------- */
    var $list = $('#rpList');
    var $pager = $('#rpPager');
    var $tree = $('#srcTree');
    var $cols = $('#rptCols');
    var $paramBody = $('#paramBody');

    /* ---------- 状态 ---------- */
    var state = {
        /* 报表清单 */
        keyword: '', category: '', enabled: '',
        pageNum: 1, pageSize: 8, total: 0, pages: 1,
        rows: {}, selectedId: '',
        /* 数据源 */
        conns: [], databases: [], tables: [],
        tableMap: {}, columnMap: {}, expanded: {}, loading: {},
        /* 当前设计 */
        design: null,
        selectedCol: -1,
        selectedElem: '',                 // 当前选中的设计区组件 id
        dirty: false,
        saving: false,
        /* 页签 */
        leftTab: 'list', propTab: 'col',
        introCollapsed: false            // 「功能介绍」是否收起（只是界面状态，不落库）
    };

    function emptyDesign() {
        return {
            id: '', code: '', reportName: '', reportNameEn: '', category: '',
            connId: '', connName: '', databaseName: '', mainTable: '', sqlText: '',
            description: '', enabled: 1, ispublic: 0, version: 0, runCount: 0, lastRunTime: '',
            params: [], columns: [],
            design: defaultDesign(),
            template: $.extend({}, DEFAULT_TEMPLATE)
        };
    }
    state.design = emptyDesign();

    /* ---------- 小工具 ---------- */
    /** 当前登录人的员工姓名（保存时作创建人；后端仍以 token 反查到的姓名为准） */
    function currentUserName() {
        try {
            var raw = window.localStorage ? window.localStorage.getItem('menu_admin_login_v1') : '';
            var sess = raw ? JSON.parse(raw) : null;
            var u = (sess && sess.user) || {};
            return textOf(u.empName || u.name || u.account || '');
        } catch (e) { return ''; }
    }

    function setStatus(text, type) {
        $('#rptStatusText').text(text);
        $('#rptStatusDot').removeClass('is-ok is-error is-warn is-dirty');
        if (type) { $('#rptStatusDot').addClass('is-' + type); }
    }
    function markDirty() {
        state.dirty = true;
        $('#rptStatusDot').addClass('is-dirty');
        $('#rptStatusMeta').text('未保存' + (state.design.id ? '（已修改）' : ''));
    }
    function markClean() {
        state.dirty = false;
        $('#rptStatusDot').removeClass('is-dirty');
        $('#rptStatusMeta').text(state.design.id
            ? ('v' + (state.design.version || 1) + ' · 调用 ' + (state.design.runCount || 0) + ' 次')
            : '');
    }

    /* ==================================================================
       一、右侧页签 / 左侧页签
       ================================================================== */
    function moveBar($nav, $bar) {
        var $cur = $nav.find('.el-tabs__item.is-active');
        if (!$cur.length || !$bar.length) { return; }
        try {
            var left = $cur.position().left;
            var width = $cur.outerWidth();
            $bar.css({ width: width + 'px', transform: 'translateX(' + left + 'px)',
                       '-webkit-transform': 'translateX(' + left + 'px)' });
        } catch (e) { }
    }

    var $leftTabs = $('#rptLeftTabs');
    function setLeftTab(name) {
        if (name !== 'list' && name !== 'source' && name !== 'tool') { name = 'list'; }
        state.leftTab = name;
        $leftTabs.find('.el-tabs__item').removeClass('is-active')
            .attr('aria-selected', 'false');
        $leftTabs.find('.el-tabs__item[data-ltab="' + name + '"]').addClass('is-active')
            .attr('aria-selected', 'true');
        $leftTabs.find('.el-tab-pane').removeClass('is-active');
        $leftTabs.find('.el-tab-pane[data-lpane="' + name + '"]').addClass('is-active');
        moveBar($('#rptLeftNav'), $('#rptLeftBar'));
    }

    var $propTabs = $('#rptPropTabs');
    function setPropTab(name) {
        if (name !== 'col' && name !== 'elem' && name !== 'param' && name !== 'tmpl') { name = 'col'; }
        state.propTab = name;
        $propTabs.find('.el-tabs__item').removeClass('is-active')
            .attr('aria-selected', 'false');
        $propTabs.find('.el-tabs__item[data-ptab="' + name + '"]').addClass('is-active')
            .attr('aria-selected', 'true');
        $propTabs.find('.el-tab-pane').removeClass('is-active');
        $propTabs.find('.el-tab-pane[data-ppane="' + name + '"]').addClass('is-active');
        moveBar($('#rptPropNav'), $('#rptPropBar'));
    }

    $leftTabs.on('click', '.el-tabs__item', function () {
        setLeftTab($(this).attr('data-ltab'));
    });
    $propTabs.on('click', '.el-tabs__item', function () {
        setPropTab($(this).attr('data-ptab'));
    });

    /* ==================================================================
       二、左侧：报表清单
       ================================================================== */
    function itemHtml(r) {
        var on = boolOf(r.enabled);
        var intro = textOf(r.description).replace(/\s+/g, ' ');
        if (intro.length > 90) { intro = intro.slice(0, 90) + '…'; }
        var creator = textOf(r.createEname);
        var tip = (on ? '双击打开这张报表继续编辑' : '该报表已停用，启用后才能进入设计') +
            (creator ? '\n创建人：' + creator +
                (r.createTime ? '（' + String(r.createTime).slice(0, 16) + '）' : '') : '') +
            (intro ? '\n功能介绍：' + intro : '');
        return '<div class="rpt-item' + (String(r.id) === String(state.selectedId) ? ' is-selected' : '') +
            '" data-id="' + esc(r.id) + '" role="button" tabindex="0" title="' + esc(tip) + '">' +
                '<div class="rpt-item__top">' +
                    '<span class="rpt-item__code">' + esc(r.code) + '</span>' +
                    '<span class="rpt-item__dot' + (on ? ' is-on' : '') + '" title="' +
                        (on ? '启用' : '停用') + '"></span>' +
                '</div>' +
                '<div class="rpt-item__name">' + esc(r.reportName) + '</div>' +
                '<div class="rpt-item__meta">' +
                    '<span class="el-tag el-tag--info rpt-item__tag">' + esc(r.category || '未分类') + '</span>' +
                    (boolOf(r.ispublic)
                        ? '<span class="el-tag el-tag--warning rpt-item__tag rpt-item__pub" title="已公开：其他用户也能看到这张报表">公共</span>'
                        : '') +
                    '<span class="rpt-item__stat">' + intOf(r.columnCount, 0) + ' 列 · ' +
                        intOf(r.paramCount, 0) + ' 参数</span>' +
                '</div>' +
                '<div class="rpt-item__foot">' +
                    '<span class="rpt-item__footmeta">' +
                        '<span>' + esc(r.paperText || '') + '</span>' +
                        '<span class="rpt-item__sep">·</span>' +
                        '<span>调用 ' + intOf(r.runCount, 0) + ' 次</span>' +
                    '</span>' +
                    /* 运行入口独立成按钮：单击卡片只选中、双击才是打开编辑，运行不能挤在整块热区里 */
                    '<button type="button" class="rpt-item__run" data-id="' + esc(r.id) + '"' +
                        ' title="运行这张报表（查看 / 打印 / 导出）" aria-label="运行报表 ' +
                        esc(r.reportName) + '">运行</button>' +
                '</div>' +
            '</div>';
    }

    /** 启用优先：停用的排到下部（组内保持原顺序 —— 服务端已按更新时间排好，这里只做稳定分组） */
    function sortEnabledFirst(list) {
        var on = [], off = [];
        for (var i = 0; i < list.length; i++) {
            (boolOf(list[i].enabled) ? on : off).push(list[i]);
        }
        return on.concat(off);
    }

    function renderReports(data) {
        var list = sortEnabledFirst((data && data.list) || []);
        state.rows = {};
        $('#rptCount').text(state.total + ' 条');
        if (!list.length) {
            $list.html('<div class="rpt-list__empty">' +
                (state.keyword || state.category || state.enabled !== ''
                    ? '没有符合条件的报表' : '还没有报表，点「新建」开始设计') + '</div>');
            syncToolbar();
            return;
        }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            state.rows[String(list[i].id)] = list[i];
            html += itemHtml(list[i]);
        }
        $list.html(html);
        syncToolbar();
    }

    function renderPager() {
        if (!state.total) { $pager.html(''); return; }
        $pager.html(
            '<button type="button" class="el-button el-button--small rpt-pager__btn" data-page="prev"' +
                (state.pageNum <= 1 ? ' disabled' : '') + '>上一页</button>' +
            '<span class="rpt-pager__info">' + state.pageNum + ' / ' + state.pages +
                '　共 ' + state.total + ' 条</span>' +
            '<button type="button" class="el-button el-button--small rpt-pager__btn" data-page="next"' +
                (state.pageNum >= state.pages ? ' disabled' : '') + '>下一页</button>');
    }

    function renderCategoryOptions(cats) {
        var html = '<option value="">全部分类</option>';
        for (var i = 0; i < (cats || []).length; i++) {
            html += '<option value="' + esc(cats[i].value) + '">' +
                esc(cats[i].value) + '（' + cats[i].count + '）</option>';
        }
        $('#rpCategoryFilter').html(html).val(state.category);
        var dl = '';
        for (var j = 0; j < (cats || []).length; j++) {
            if (cats[j].value !== '未分类') {
                dl += '<option value="' + esc(cats[j].value) + '"></option>';
            }
        }
        $('#rptCategoryList').html(dl);
    }

    function loadReports() {
        var params = {
            keyword: state.keyword, category: state.category, enabled: state.enabled,
            pageNum: state.pageNum, pageSize: state.pageSize
        };
        Api.report.page(params).done(function (data) {
            state.total = intOf(data.total, 0);
            state.pages = intOf(data.pages, 1);
            state.pageNum = intOf(data.pageNum, 1);
            renderReports(data);
            renderPager();
            renderCategoryOptions(data.categories || []);
        }).fail(function (err) {
            $list.html('<div class="rpt-list__empty is-error">加载报表失败：' + esc(err.message) +
                '<br><span>确认后端已启动，或稍后点「刷新」重试</span></div>');
            setStatus('加载报表清单失败：' + (err.message || ''), 'error');
        });
    }

    function selectedRow() { return state.rows[String(state.selectedId)] || null; }

    function syncToolbar() {
        var row = selectedRow();
        $('#btnCopy, #btnEnable, #btnDisable, #btnDelete').prop('disabled', !row);
        if (row) {
            $('#btnEnable').prop('disabled', boolOf(row.enabled));
            $('#btnDisable').prop('disabled', !boolOf(row.enabled));
        }
    }

    /* ==================================================================
       三、左侧：数据源（连接 → 实例 → 表 / 视图 → 字段）
       ================================================================== */
    function loadConns(preferId) {
        return Api.report.connections().done(function (data) {
            state.conns = (data && data.list) || [];
            var html = '<option value="">选择连接…</option>';
            for (var i = 0; i < state.conns.length; i++) {
                html += '<option value="' + esc(state.conns[i].id) + '">' +
                    esc(state.conns[i].name) + '（' + esc(state.conns[i].typeLabel) + '）</option>';
            }
            $('#srcConn').html(html);
            var pick = preferId || state.design.connId || '';
            if (pick) {
                var hit = false;
                for (var k = 0; k < state.conns.length; k++) {
                    if (String(state.conns[k].id) === String(pick)) { hit = true; break; }
                }
                if (!hit) { pick = ''; }
            }
            $('#srcConn').val(pick);
            if (!state.conns.length) {
                setSourceTip('还没有可用的数据库连接：先到「数据中心 → 数据库」新增并启用一条连接', true);
                $tree.html('<div class="rpt-tree__empty">没有可用的连接</div>');
            } else if (pick) {
                loadDatabases(pick, state.design.databaseName, true);
            }
        }).fail(function (err) {
            setSourceTip('读取数据源连接失败：' + (err.message || ''), true);
        });
    }

    function setSourceTip(text, isError) {
        $('#srcTip').text(text).toggleClass('is-error', !!isError);
    }

    function loadDatabases(connId, preferDb, withTables) {
        if (!connId) {
            state.databases = [];
            $('#srcDb').html('<option value="">先选连接</option>');
            state.tables = [];
            renderTree();
            return;
        }
        $('#srcDb').html('<option value="">扫描实例中…</option>');
        Api.report.databases(connId).done(function (data) {
            state.databases = (data && data.databases) || [];
            var html = '';
            for (var i = 0; i < state.databases.length; i++) {
                html += '<option value="' + esc(state.databases[i].name) + '">' +
                    esc(state.databases[i].name) +
                    (state.databases[i].tableCount ? '（' + state.databases[i].tableCount + '）' : '') +
                    '</option>';
            }
            if (!html) { html = '<option value="">没有可用实例</option>'; }
            $('#srcDb').html(html);
            var pick = preferDb || state.design.databaseName || '';
            var ok = false;
            for (var k = 0; k < state.databases.length; k++) {
                if (String(state.databases[k].name) === String(pick)) { ok = true; break; }
            }
            if (!ok && state.databases.length) {
                pick = state.databases[0].name;
                for (var m = 0; m < state.databases.length; m++) {
                    if (state.databases[m].current) { pick = state.databases[m].name; break; }
                }
            }
            $('#srcDb').val(pick || '');
            setSourceTip('已扫描到 ' + state.databases.length + ' 个实例；双击表或视图展开字段，把表 / 字段拖到中间画布');
            if (withTables !== false) { loadTables(pick); }
        }).fail(function (err) {
            state.databases = [];
            $('#srcDb').html('<option value="">扫描失败</option>');
            setSourceTip('扫描实例失败：' + (err.message || ''), true);
            state.tables = [];
            renderTree();
        });
    }

    function loadTables(database) {
        var connId = $('#srcConn').val();
        if (!connId || !database) {
            state.tables = [];
            renderTree();
            return;
        }
        $tree.html('<div class="rpt-tree__empty">正在扫描「' + esc(database) + '」下的表与视图…</div>');
        Api.report.tables(connId, database).done(function (data) {
            state.tables = (data && data.tables) || [];
            state.tableMap[database] = state.tables;
            setSourceTip('「' + database + '」下共 ' + state.tables.length +
                ' 个表 / 视图；双击表展开字段，把表 / 字段拖到画布');
            renderTree();
        }).fail(function (err) {
            state.tables = [];
            $tree.html('<div class="rpt-tree__empty is-error">扫描表失败：' + esc(err.message) + '</div>');
        });
    }

    function loadColumns(database, table, force) {
        var key = database + '|' + table;
        var connId = $('#srcConn').val();
        if (!connId) { return; }
        if (!force && state.columnMap[key]) { return; }
        state.loading[key] = true;
        renderTree();
        Api.report.columns(connId, database, table).done(function (data) {
            state.columnMap[key] = { columns: (data && data.columns) || [] };
            state.loading[key] = false;
            renderTree();
        }).fail(function (err) {
            state.columnMap[key] = { columns: [], error: err.message || '读取字段失败' };
            state.loading[key] = false;
            renderTree();
        });
    }

    function fieldTypeText(t) {
        var text = textOf(t);
        if (!text) { return ''; }
        return text.length > 18 ? text.slice(0, 18) + '…' : text;
    }

    function renderTree() {
        var connId = $('#srcConn').val();
        if (!connId) {
            $tree.html('<div class="rpt-tree__empty">先选一条连接；没有连接可去「数据中心 → 数据库」新增</div>');
            return;
        }
        var database = $('#srcDb').val();
        if (!database) {
            $tree.html('<div class="rpt-tree__empty">先选一个实例（库）</div>');
            return;
        }
        var kw = textOf($('#srcTableKw').val()).toLowerCase();
        var tables = state.tableMap[database] || state.tables || [];
        if (!tables.length) {
            $tree.html('<div class="rpt-tree__empty">这个实例下没有扫描到表或视图</div>');
            return;
        }
        var html = '<div class="rpt-tree__group">' +
            '<span class="rpt-tree__dbname">' + esc(database) + '</span>' +
            '<span class="rpt-tree__dbcount">' + tables.length + ' 个对象</span></div>';
        var shown = 0;
        for (var i = 0; i < tables.length; i++) {
            var t = tables[i];
            var key = database + '|' + t.name;
            var cached = state.columnMap[key];
            var fields = (cached && cached.columns) || [];
            var open = !!state.expanded[key];
            /* 关键字过滤：表名 / 表注释命中，或者它的字段命中 */
            var hit = !kw;
            if (!hit) {
                hit = String(t.name).toLowerCase().indexOf(kw) >= 0 ||
                    String(t.comment || '').toLowerCase().indexOf(kw) >= 0;
                if (!hit) {
                    for (var h = 0; h < fields.length; h++) {
                        if (String(fields[h].name).toLowerCase().indexOf(kw) >= 0) { hit = true; break; }
                    }
                }
            }
            if (!hit) { continue; }
            shown++;
            var kind = t.kind === 'view' ? 'view' : 'table';
            var kindText = kind === 'view' ? '视图' : '表';
            html += '<div class="el-tree-node rpt-node' + (open ? ' is-open' : '') + '" data-kind="' + kind +
                '" data-db="' + esc(database) + '" data-table="' + esc(t.name) + '">' +
                '<div class="el-tree-node__content rpt-node__row" ' +
                    'title="单击展开字段；双击也展开（加列只走字段：拖字段到画布或双击字段）">' +
                    '<span class="rpt-node__arrow">' + (open ? '▾' : '▸') + '</span>' +
                    '<span class="rpt-node__kind is-' + kind + '">' + kindText + '</span>' +
                    '<span class="rpt-node__name">' + esc(t.name) + '</span>' +
                    (t.comment ? '<span class="rpt-node__comment" title="' + esc(t.comment) + '">' +
                        esc(t.comment) + '</span>' : '') +
                    '<span class="rpt-node__badge' + (fields.length ? '' : ' is-zero') + '">' +
                        (state.loading[key] ? '…' : (fields.length || intOf(t.rows, 0) || '')) + '</span>' +
                '</div>';
            if (open || kw) {
                html += '<div class="el-tree-node__children">';
                if (state.loading[key] && !fields.length) {
                    html += '<div class="rpt-tree__hint">正在读取字段…</div>';
                } else if (cached && cached.error) {
                    html += '<div class="rpt-tree__hint is-error">' + esc(cached.error) + '</div>';
                } else if (!fields.length) {
                    html += '<div class="rpt-tree__hint">这张表没有字段信息</div>';
                } else {
                    for (var f = 0; f < fields.length; f++) {
                        var col = fields[f];
                        var already = hasColumn(col.name);
                        html += '<div class="el-tree-node__content rpt-node rpt-node--field is-draggable' +
                            (already ? ' is-added' : '') + '" draggable="true" ' +
                            'data-kind="field" data-db="' + esc(database) + '" data-table="' + esc(t.name) +
                            '" data-field="' + esc(col.name) + '" data-label="' + esc(col.comment || col.name) +
                            '" data-type="' + esc(col.dataType || '') + '" ' +
                            'title="拖到画布加入这一列；双击也可加入">' +
                            '<span class="rpt-node__ftype" title="' + esc(col.dataType || '') + '">' +
                                esc(fieldTypeText(col.dataType)) + '</span>' +
                            '<span class="rpt-node__fname">' + esc(col.name) + '</span>' +
                            (col.comment ? '<span class="rpt-node__fcomment" title="' + esc(col.comment) + '">' +
                                esc(col.comment) + '</span>' : '') +
                            (col.key === 'PRI' ? '<span class="rpt-node__key">PK</span>' : '') +
                        '</div>';
                    }
                }
                html += '</div>';
            }
            html += '</div>';
        }
        if (!shown) {
            html += '<div class="rpt-tree__empty">没有匹配「' + esc(kw) + '」的表 / 视图 / 字段</div>';
        }
        $tree.html(html);
    }

    function hasColumn(field) {
        for (var i = 0; i < state.design.columns.length; i++) {
            if (String(state.design.columns[i].field) === String(field)) { return true; }
        }
        return false;
    }

    /* ---------- 数据源事件 ---------- */
    $('#srcConn').on('change', function () {
        var connId = $(this).val();
        state.design.connId = connId;
        state.columnMap = {};
        state.expanded = {};
        var conn = null;
        for (var i = 0; i < state.conns.length; i++) {
            if (String(state.conns[i].id) === String(connId)) { conn = state.conns[i]; }
        }
        state.design.connName = conn ? conn.name : '';
        if (connId) { loadDatabases(connId, '', true); }
        else { state.databases = []; $('#srcDb').html('<option value="">先选连接</option>'); state.tables = []; renderTree(); }
        markDirty();
    });

    $('#srcDb').on('change', function () {
        state.design.databaseName = $(this).val();
        state.expanded = {};
        loadTables($(this).val());
        markDirty();
    });

    $('#srcTableKw').on('input', function () { renderTree(); });

    $('#btnSrcRefresh').on('click', function () {
        var connId = $('#srcConn').val();
        if (!connId) { UI.message({ type: 'warning', message: '请先选择一条连接' }); return; }
        state.columnMap = {};
        state.expanded = {};
        loadDatabases(connId, $('#srcDb').val(), true);
    });

    /* 单击表 = 展开 / 收起（顺带懒加载字段）；双击表 = 展开（不整表加入，加列只走字段粒度）；双击字段 = 单列加入 */
    $tree.on('click', '.rpt-node__row', function (e) {
        if ($(e.target).hasClass('rpt-node__badge')) { return; }
        var $node = $(this).closest('.rpt-node');
        var kind = $node.attr('data-kind');
        if (kind !== 'table' && kind !== 'view') { return; }
        var key = $node.attr('data-db') + '|' + $node.attr('data-table');
        state.expanded[key] = !state.expanded[key];
        if (state.expanded[key]) {
            loadColumns($node.attr('data-db'), $node.attr('data-table'));
        }
        renderTree();
    });

    $tree.on('dblclick', '.rpt-node__row', function (e) {
        var $node = $(this).closest('.rpt-node');
        var kind = $node.attr('data-kind');
        if (kind !== 'table' && kind !== 'view') { return; }
        e.preventDefault();
        expandTable($node.attr('data-db'), $node.attr('data-table'), true);
    });

    $tree.on('dblclick', '.rpt-node--field', function (e) {
        e.preventDefault();
        addField($(this).attr('data-db'), $(this).attr('data-table'), $(this).attr('data-field'),
            $(this).attr('data-label'));
    });

    /* ---------- 拖拽源 ---------- */
    var dragPayload = null;

    /* 表 / 视图节点不再作为拖拽源：整表一次性铺满画布容易把已排好的列冲掉，
       加列统一走字段粒度（拖字段 / 双击字段） */
    $tree.on('dragstart', '.rpt-node--field.is-draggable', function (e) {
        dragPayload = {
            kind: 'field', db: $(this).attr('data-db'), table: $(this).attr('data-table'),
            field: $(this).attr('data-field'), label: $(this).attr('data-label'),
            dataType: $(this).attr('data-type')
        };
        dragColIndex = -1;
        try {
            var dt = e.originalEvent.dataTransfer;
            dt.effectAllowed = 'copy';
            dt.setData('text/plain', 'rpt-field:' + $(this).attr('data-field'));
        } catch (err) { }
        $(this).addClass('is-dragging');
    });

    $tree.on('dragend', '.is-draggable', function () {
        $(this).removeClass('is-dragging');
        dragPayload = null;
        $('#rptDetailBand').removeClass('is-over');
    });

    /* ==================================================================
       四、画布：加入表 / 字段，列排序，示例渲染
       ================================================================== */
    var dragColIndex = -1;

    function defaultWidth(field, maxWidth) {
        var name = String(field || '');
        var width = 120;
        if (/time|date/i.test(name)) { width = 150; }
        else if (/remark|content|body|description|address/i.test(name)) { width = 200; }
        else if (/name|title/i.test(name)) { width = 120; }
        else if (/id$|code$/i.test(name)) { width = 110; }
        /* 整表字段很多时（>8 列）压窄一点，画布 / 预览里不至于一眼全是横向滚动 */
        if (maxWidth && width > maxWidth) { width = maxWidth; }
        return width;
    }
    function defaultAlign(field) {
        return /amount|money|price|salary|total|qty|count|num|age/i.test(String(field || ''))
            ? 'right' : 'left';
    }
    function defaultFormat(field) {
        var name = String(field || '');
        if (/amount|money|price|salary|total/i.test(name)) { return 'money'; }
        if (/time$/i.test(name)) { return 'datetime'; }
        if (/date$/i.test(name)) { return 'date'; }
        return 'text';
    }

    function addColumn(col) {
        if (state.design.columns.length >= MAX_COLUMNS) {
            UI.message({ type: 'warning', message: '一最多只能放 ' + MAX_COLUMNS + ' 列' });
            return false;
        }
        if (hasColumn(col.field)) {
            UI.message({ type: 'info', message: '字段「' + col.field + '」已经在画布里了' });
            return false;
        }
        state.design.columns.push(col);
        state.selectedCol = state.design.columns.length - 1;
        afterColumnsChanged();
        return true;
    }

    function addField(db, table, field, label) {
        if (!field) { return; }
        var name = textOf(field);
        if (!name) { return; }
        var ok = addColumn({
            field: name,
            label: textOf(label) || name,
            table: textOf(table) || state.design.mainTable || '',
            width: defaultWidth(name),
            align: defaultAlign(name),
            headerAlign: 'center',
            format: defaultFormat(name),
            summary: 'none',
            visible: true
        });
        if (ok) {
            if (!state.design.mainTable && table) {
                state.design.mainTable = table;
                $('#rptStatusText').text('已加入字段「' + name + '」，主表设为 ' + table);
            }
            setStatus('已加入字段「' + name + '」（共 ' + state.design.columns.length + ' 列）');
        }
    }

    /** 展开一张表 / 视图并懒加载字段（双击表 = 展开看字段；加列只走字段粒度，不再整表铺开） */
    function expandTable(db, table, notify) {
        var name = textOf(table);
        if (!name) { return; }
        var key = textOf(db) + '|' + name;
        state.expanded[key] = true;
        loadColumns(db, name);
        renderTree();
        if (!notify) { return; }
        var cached = state.columnMap[key];
        if (cached && cached.error) {
            UI.message({ type: 'error', message: cached.error });
            return;
        }
        UI.message({ type: 'info',
            message: '已展开「' + name + '」：把字段拖进画布，或双击字段加入这一列' });
        setStatus('已展开表「' + name + '」的字段 —— 拖字段到画布 / 双击字段加入');
    }

    function addColumnSilent(col) {
        if (!col.field || hasColumn(col.field) || state.design.columns.length >= MAX_COLUMNS) {
            return false;
        }
        state.design.columns.push(col);
        return true;
    }

    function afterColumnsChanged() {
        markDirty();
        renderCanvas();
        renderColForm();
        renderTree();
        syncSqlInfo();
    }

    /* ---------- 画布渲染 ---------- */
    function sampleValue(col, rowIndex) {
        var name = col.field;
        if (/id$|code$/i.test(name)) { return String(rowIndex); }
        if (/name/i.test(name)) { return '示例' + rowIndex; }
        if (/time|date/i.test(name)) { return '2026-11-0' + rowIndex; }
        if (/amount|money|price|salary|total/i.test(name)) { return '128.50'; }
        if (/qty|count|num|age/i.test(name)) { return String(rowIndex * 3); }
        return '示例值' + rowIndex;
    }

    /* ---------------- 页眉 / 页脚（文字对齐 + 可放 Logo） ---------------- */
    /**
     * 一块页眉或页脚：logo 贴左或贴右，文字占其余宽度并按 headerAlign/footerAlign 对齐
     * @param kind 'header' | 'footer'
     */
    function renderCanvas() {
        var d = state.design;
        var tpl = d.template;
        var design = d.design;
        var title = textOf(d.reportName) || textOf(design.title) || '未命名报表';
        $('#rptTitleText').text(title);
        $('#rptSubtitleText').text(design.subtitle || '');
        var headerHtml = pageBandHtml('header', design, tpl);
        $('#rptHeaderText').html(headerHtml || '（无）');
        /* 画布上的页脚带上页码 / 时间示意（预览 / 打印里这两项在页脚行） */
        var footDesign = $.extend({}, design);
        var footExtra = [];
        if (boolOf(tpl.showPageNo)) { footExtra.push('第 1 页 / 共 1 页'); }
        if (boolOf(tpl.showTime)) { footExtra.push('打印时间：' + nowText()); }
        if (footExtra.length) {
            footDesign.footerText = (footDesign.footerText || '') +
                (footDesign.footerText ? '　' : '') + footExtra.join('　');
        }
        $('#rptFooterText').html(pageBandHtml('footer', footDesign, tpl) || '（无）');
        $('#rptParamBand').toggle(boolOf(design.showParams));

        /* 参数示意 */
        if (d.params.length) {
            var ph = '';
            for (var i = 0; i < d.params.length; i++) {
                var p = d.params[i];
                ph += '<span class="rpt-params__item"><span class="rpt-params__label">' +
                    esc(p.label || p.name) + (boolOf(p.required) ? '<b>*</b>' : '') + '</span>' +
                    '<span class="rpt-params__box">' + esc(paramControlText(p)) + '</span></span>';
            }
            $('#rptParamsPreview').html(ph);
        } else {
            $('#rptParamsPreview').html('<span class="rpt-params__none">还没有报表参数（右栏「报表参数」里可新增）</span>');
        }

        /* 明细表 */
        var cols = d.columns;
        if (!cols.length) {
            $cols.html('<div class="rpt-grid__empty">把左侧「数据源」里表下面的<b>字段</b>拖到这里' +
                '（或双击字段）<br>' +
                '<span>先点表展开字段　按字段逐个加入　画布内可左右拖动调整顺序</span></div>');
            $('#rptSample').prop('hidden', true).empty();
            $('#rptSummaryBand').prop('hidden', true);
            $('#rptDropTip').show();
            renderFreeLayer();
            return;
        }
        $('#rptDropTip').hide();
        var colgroup = '<colgroup>';
        var head = '<thead><tr>';
        var visibleCols = [];
        for (var c = 0; c < cols.length; c++) {
            var one = cols[c];
            if (!boolOf(one.visible)) { continue; }
            visibleCols.push(c);
            colgroup += '<col style="width:' + intOf(one.width, 120) + 'px">';
            head += '<th class="rpt-th' + (c === state.selectedCol ? ' is-selected' : '') +
                '" data-index="' + c + '" draggable="true" style="text-align:' +
                esc(one.headerAlign || 'center') +
                '" title="点选修改属性；拖动可调整列顺序">' +
                '<span class="rpt-th__text">' + esc(one.label || one.field) + '</span>' +
                (boolOf(one.custom) ? '<i class="rpt-th__tag" title="SQL 自定义列（数据源表字段之外），可在「字段属性」里设置显示风格">自定义</i>' : '') +
                '<button type="button" class="rpt-th__del" data-index="' + c + '" title="移除这一列">×</button>' +
                '</th>';
        }
        colgroup += '</colgroup>';
        head += '</tr></thead>';

        var body = '<tbody>';
        for (var r = 1; r <= 2; r++) {
            body += '<tr>';
            for (var vi = 0; vi < visibleCols.length; vi++) {
                var col = cols[visibleCols[vi]];
                body += '<td style="text-align:' + esc(col.align || 'left') + '">' +
                    esc(sampleValue(col, r)) + '</td>';
            }
            body += '</tr>';
        }
        body += '</tbody>';

        var hasSummary = false;
        var summaryCells = '';
        for (var si = 0; si < visibleCols.length; si++) {
            var sc = cols[visibleCols[si]];
            if (textOf(sc.summary) && sc.summary !== 'none') { hasSummary = true; }
            summaryCells += '<td style="text-align:' + esc(sc.align || 'left') + '">' +
                (sc.summary && sc.summary !== 'none' ? esc(summaryLabel(sc.summary)) : '') + '</td>';
        }
        var tfoot = hasSummary ? ('<tfoot><tr>' + summaryCells + '</tr></tfoot>') : '';

        $cols.html('<table class="rpt-table' +
            (boolOf(design.bordered) ? ' is-bordered' : '') +
            (boolOf(design.zebra) ? ' is-zebra' : '') +
            (boolOf(tpl.compact) ? ' is-compact' : '') + '">' +
            colgroup + head + body + tfoot + '</table>');
        $('#rptSample').prop('hidden', false)
            .html('<span class="rpt-sample__label">示例</span>上面两行是示意数据，真实数据点「预览」按参数查询');
        $('#rptSummaryBand').prop('hidden', !hasSummary);
        if (hasSummary) {
            $('#rptSummaryText').text('已配置汇总：' +
                summaryTextOf(cols));
        }
        renderFreeLayer();
    }

    function summaryLabel(value) {
        for (var i = 0; i < COLUMN_SUMMARY.length; i++) {
            if (COLUMN_SUMMARY[i].value === value) { return COLUMN_SUMMARY[i].label; }
        }
        return value;
    }
    function summaryTextOf(cols) {
        var out = [];
        for (var i = 0; i < cols.length; i++) {
            if (cols[i].summary && cols[i].summary !== 'none') {
                out.push((cols[i].label || cols[i].field) + '（' + summaryLabel(cols[i].summary) + '）');
            }
        }
        return out.join('、');
    }

    /* ---------- 画布：拖入 / 排序 / 选中 / 删除 ---------- */
    function payloadFromEvent(e) {
        if (dragPayload) { return dragPayload; }
        try {
            var raw = e.originalEvent.dataTransfer.getData('text/plain');
            if (!raw) { return null; }
            if (raw.indexOf('rpt-table:') === 0) {
                return { kind: 'table', db: $('#srcDb').val(), table: raw.slice(10) };
            }
            if (raw.indexOf('rpt-el:') === 0) {
                return { kind: 'element', elKind: raw.slice(7) };
            }
            if (raw.indexOf('rpt-field:') === 0) {
                return { kind: 'field', db: $('#srcDb').val(), table: state.design.mainTable,
                         field: raw.slice(10), label: '' };
            }
        } catch (err) { }
        return null;
    }

    $('#rptDetailBand').on('dragover', function (e) {
        e.preventDefault();
        try { e.originalEvent.dataTransfer.dropEffect = dragColIndex >= 0 ? 'move' : 'copy'; } catch (err) { }
        $(this).addClass('is-over');
    });
    $('#rptDetailBand').on('dragleave', function (e) {
        if (e.target === this) { $(this).removeClass('is-over'); }
    });
    $('#rptDetailBand').on('drop', function (e) {
        e.preventDefault();
        $(this).removeClass('is-over');
        var $th = $(e.target).closest('.rpt-th');
        var targetIndex = $th.length ? intOf($th.attr('data-index'), -1) : -1;
        if (dragColIndex >= 0) {
            moveColumn(dragColIndex, targetIndex);
            dragColIndex = -1;
            return;
        }
        var payload = payloadFromEvent(e);
        dragPayload = null;
        if (!payload) { return; }
        if (payload.kind === 'table') {
            /* 表不再整表加入：真被拖进来（比如从浏览器缓存 / 旧页面拖来）也只展开字段，
               免得把已排好的列冲掉 */
            expandTable(payload.db, payload.table, false);
            UI.message({ type: 'info',
                message: '表不能整表加入：请展开后拖入字段，或双击字段加入这一列' });
        } else if (payload.kind === 'field') {
            addField(payload.db, payload.table, payload.field, payload.label);
        }
    });

    function moveColumn(from, to) {
        var cols = state.design.columns;
        if (from < 0 || from >= cols.length) { return; }
        if (to < 0 || to > cols.length - 1) { to = cols.length - 1; }
        if (from === to) { return; }
        var moved = cols.splice(from, 1)[0];
        cols.splice(to, 0, moved);
        state.selectedCol = to;
        afterColumnsChanged();
    }

    $('#rptCols').on('click', '.rpt-th', function (e) {
        if ($(e.target).hasClass('rpt-th__del')) { return; }
        state.selectedCol = intOf($(this).attr('data-index'), -1);
        renderCanvas();
        renderColForm();
        setPropTab('col');
    });

    $('#rptCols').on('click', '.rpt-th__del', function (e) {
        e.stopPropagation();
        removeColumn(intOf($(this).attr('data-index'), -1));
    });

    $('#rptCols').on('dragstart', '.rpt-th', function (e) {
        dragColIndex = intOf($(this).attr('data-index'), -1);
        dragPayload = null;
        try {
            e.originalEvent.dataTransfer.effectAllowed = 'move';
            e.originalEvent.dataTransfer.setData('text/plain', 'rpt-col:' + dragColIndex);
        } catch (err) { }
        $(this).addClass('is-dragging');
    });
    $('#rptCols').on('dragend', '.rpt-th', function () {
        $(this).removeClass('is-dragging');
        $('#rptDetailBand').removeClass('is-over');
    });

    function removeColumn(index) {
        if (index < 0 || index >= state.design.columns.length) { return; }
        var col = state.design.columns[index];
        state.design.columns.splice(index, 1);
        state.selectedCol = Math.min(index, state.design.columns.length - 1);
        afterColumnsChanged();
        UI.message({ type: 'success', message: '已移除列「' + (col.label || col.field) + '」' });
    }

    /* ==================================================================
       五、右栏：字段属性
       ================================================================== */
    function currentColumn() {
        var i = state.selectedCol;
        if (i < 0 || i >= state.design.columns.length) { return null; }
        return state.design.columns[i];
    }

    function renderColForm() {
        var col = currentColumn();
        if (!col) {
            $('#colForm').prop('hidden', true);
            $('#colEmpty').show();
            return;
        }
        $('#colEmpty').hide();
        $('#colForm').prop('hidden', false);
        $('#colField').text(col.field);
        $('#colFieldTip').text(col.custom
            ? ('SQL 自定义列　·　第 ' + (state.selectedCol + 1) + ' 列')
            : (col.table ? ('来自 ' + col.table + '　·　第 ' + (state.selectedCol + 1) + ' 列')
                         : ('第 ' + (state.selectedCol + 1) + ' 列')));
        $('#colLabel').val(col.label || '');
        $('#colHeaderAlign').val(col.headerAlign || 'center');
        $('#colWidth').val(intOf(col.width, 120));
        $('#colAlign').val(col.align || 'left');
        $('#colFormat').val(col.format || 'text');
        $('#colSummary').val(col.summary || 'none');
        $('#colVisible').val(boolOf(col.visible) ? '1' : '0');
    }

    $('#colForm').on('input change', 'input,select', function () {
        var col = currentColumn();
        if (!col) { return; }
        var id = $(this).attr('id');
        if (id === 'colLabel') { col.label = textOf($(this).val()) || col.field; }
        else if (id === 'colHeaderAlign') { col.headerAlign = $(this).val(); }
        else if (id === 'colWidth') { col.width = Math.min(800, Math.max(40, intOf($(this).val(), 120))); }
        else if (id === 'colAlign') { col.align = $(this).val(); }
        else if (id === 'colFormat') { col.format = $(this).val(); }
        else if (id === 'colSummary') { col.summary = $(this).val(); }
        else if (id === 'colVisible') { col.visible = $(this).val() === '1'; }
        markDirty();
        renderCanvas();
    });

    $('#btnColLeft').on('click', function () {
        if (state.selectedCol > 0) { moveColumn(state.selectedCol, state.selectedCol - 1); }
    });
    $('#btnColRight').on('click', function () {
        if (state.selectedCol >= 0 && state.selectedCol < state.design.columns.length - 1) {
            moveColumn(state.selectedCol, state.selectedCol + 1);
        }
    });
    $('#btnColRemove').on('click', function () {
        if (state.selectedCol >= 0) { removeColumn(state.selectedCol); }
    });

    /* ==================================================================
       五.1 工具箱：设计区组件（文本 / 线条 / 区域 / 图像 / 图表 / 明细表）
       ------------------------------------------------------------------
       · 组件存在 design.elements（跟着 designJson 一起落库），坐标是相对「设计区」的像素；
         区域（box）可以带 children，子组件坐标相对区域内容区；
       · 画布 / 预览 / 打印三处共用 elementHtml()，只是 ctx 里的数据不同（画布用示意行，
         预览与打印用真实查询结果）；data-eid 只在画布上打，避免预览里误选；
       · 位置拖动用 mousedown + mousemove（像素级），尺寸 / 颜色 / 文字在右栏「组件属性」里改。
       ================================================================== */
    var ELEMENT_KINDS = ['label', 'line', 'box', 'image', 'chart', 'table'];
    var ELEMENT_NAME = {
        label: '文本', line: '线条', box: '区域',
        image: '图像', chart: '图表', table: '表格'
    };
    var TABLE_MAX_ROWS = 30;                 // 表格组件的行 / 列上限（后端 service.TABLE_MAX_* 同一套）
    var TABLE_MAX_COLS = 10;
    var TABLE_CELL_MAX = 60;                 // 单个单元格文字上限
    var ELEMENT_SIZE = {
        label: [220, 32], line: [240, 12], box: [420, 160],
        image: [180, 120], chart: [320, 200], table: [460, 220]
    };
    var CHART_COLORS = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#909399',
                        '#9b59b6', '#00b4d8', '#ff9f43'];
    var MAX_ELEMENTS = 60;

    var $free = $('#rptFreeLayer');
    var $elemForm = $('#elemForm');
    var $toolItems = $('#toolItems');
    /* 设计区的空态提示会被重绘覆盖，先存一份，重绘后追加回去 */
    var FREE_HINT_HTML = $('#rptFreeHint').length ? $('#rptFreeHint')[0].outerHTML : '';

    function elements() {
        var design = state.design.design;
        if (!$.isArray(design.elements)) { design.elements = []; }
        return design.elements;
    }

    /**
     * 这次要渲染的组件：优先用「结果自带的那份 design」
     * —— 双击清单运行的是已保存报表，不能拿画布上正在编辑的另一张报表的组件来渲染。
     */
    function elementById(id) {
        var found = null;
        if (!id) { return null; }
        walkElements(elements(), function (el, list, index, parent) {
            if (String(el.id) === String(id)) {
                found = { el: el, list: list, index: index, parent: parent };
            }
        });
        return found;
    }

    function selectedElement() {
        var hit = elementById(state.selectedElem);
        return hit ? hit.el : null;
    }

    function countElements() {
        var n = 0;
        walkElements(elements(), function () { n++; });
        return n;
    }

    function newElementId() {
        return 'el' + new Date().getTime().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    function elementDefaultWidth(kind) {
        return (ELEMENT_SIZE[kind] || [220, 40])[0];
    }

    function firstColumnField(skip) {
        var cols = state.design.columns;
        for (var i = 0; i < cols.length; i++) {
            if (i === skip) { continue; }
            return cols[i].field;
        }
        return cols.length ? cols[0].field : '';
    }

    /** 新组件（属性默认值，和后端 service._clean_element 的字段一一对应） */
    function createElement(kind, x, y) {
        var size = ELEMENT_SIZE[kind] || [220, 40];
        var el = {
            id: newElementId(), kind: kind,
            x: Math.max(0, intOf(x, 20)), y: Math.max(0, intOf(y, 12)),
            w: size[0], h: size[1]
        };
        if (kind === 'label') {
            el.text = '标题文字'; el.fontSize = 14; el.bold = false;
            el.align = 'left'; el.color = '#303133';
        } else if (kind === 'line') {
            el.dir = 'h'; el.thickness = 1; el.color = '#DCDFE6';
        } else if (kind === 'box') {
            el.border = true; el.borderColor = '#DCDFE6'; el.bg = '';
            el.radius = 4; el.padding = 8; el.children = [];
        } else if (kind === 'image') {
            el.src = 'assets/logo.svg'; el.fit = 'contain'; el.radius = 0;
        } else if (kind === 'chart') {
            el.chartType = 'bar'; el.title = ''; el.legend = true;
            el.categoryField = firstColumnField(0); el.valueField = firstColumnField(1);
        } else if (kind === 'table') {
            /* 表格：行列与每个格子的文字都由用户在「组件属性」里自己填 */
            el.rows = 3; el.cols = 3; el.headerRow = true; el.showHeader = true;
            el.align = 'left';
            el.cells = [['列1', '列2', '列3'], ['', '', ''], ['', '', '']];
        }
        return el;
    }

    /** 自动摆放时的下一个纵向位置（避免组件完全叠在一起） */
    function nextFreeY() {
        var bottom = -10;
        walkElements(elements(), function (el) {
            bottom = Math.max(bottom, intOf(el.y, 0) + intOf(el.h, 0));
        });
        return bottom < 0 ? 12 : (bottom + 10);
    }

    /**
     * 加入一个组件
     * @param kind    label / line / box / image / chart / table
     * @param opts    {x, y, parent(区域的 eid)}
     */
    function addElement(kind, opts) {
        opts = opts || {};
        if (ELEMENT_KINDS.indexOf(kind) < 0) { return null; }
        if (countElements() >= MAX_ELEMENTS) {
            UI.message({ type: 'warning', message: '设计区最多 ' + MAX_ELEMENTS + ' 个组件，请先删掉一些' });
            return null;
        }
        var list = elements(), parentHit = null;
        if (opts.parent) {
            parentHit = elementById(opts.parent);
            if (!parentHit || parentHit.el.kind !== 'box') { parentHit = null; }
        }
        if (parentHit) {
            list = parentHit.el.children || (parentHit.el.children = []);
            if (list.length >= 20) {
                UI.message({ type: 'warning', message: '一个区域里最多放 20 个组件' });
                return null;
            }
        }
        var x = opts.x === undefined ? 20 : opts.x;
        var y = opts.y === undefined ? nextFreeY() : opts.y;
        var el = createElement(kind, x, y);
        list.push(el);
        state.selectedElem = el.id;
        markDirty();
        renderCanvas();
        renderElemForm();
        renderToolList();
        setPropTab('elem');
        UI.message({
            type: 'success',
            message: '已加入「' + ELEMENT_NAME[kind] + '」' +
                (parentHit ? '（放进区域里）' : '') + '，右栏「组件属性」可继续调整'
        });
        return el;
    }

    function removeSelectedElement() {
        var hit = elementById(state.selectedElem);
        if (!hit) { return; }
        hit.list.splice(hit.index, 1);
        state.selectedElem = '';
        markDirty();
        renderCanvas();
        renderElemForm();
        renderToolList();
        UI.message({ type: 'success', message: '已删除组件' });
    }

    /** 层级调整：step=1 上移一层（更靠前），-1 下移一层 */
    function moveElementLayer(step) {
        var hit = elementById(state.selectedElem);
        if (!hit) { return; }
        var to = hit.index + step;
        if (to < 0 || to >= hit.list.length) { return; }
        var moved = hit.list.splice(hit.index, 1)[0];
        hit.list.splice(to, 0, moved);
        markDirty();
        renderCanvas();
        renderToolList();
    }

    /* ---------- 渲染 ---------- */
    function resizeTable(el, rows, cols) {
        var keep = tableCells(el), out = [], r, c;
        rows = Math.min(TABLE_MAX_ROWS, Math.max(1, intOf(rows, 3)));
        cols = Math.min(TABLE_MAX_COLS, Math.max(1, intOf(cols, 3)));
        for (r = 0; r < rows; r++) {
            var line = [];
            for (c = 0; c < cols; c++) {
                line.push(keep[r] && keep[r][c] !== undefined ? keep[r][c] : '');
            }
            out.push(line);
        }
        el.rows = rows;
        el.cols = cols;
        el.cells = out;
        return el;
    }

    function setTableCell(el, row, col, value) {
        var cells = tableCells(el);                 // 先补齐再写，避免稀疏数组
        if (!cells[row]) { return; }
        cells[row][col] = String(value === undefined || value === null ? '' : value).slice(0, TABLE_CELL_MAX);
        el.rows = tableRows(el);
        el.cols = tableCols(el);
        el.cells = cells;
    }

    /** 表格组件：纯静态表格（列头可整体隐藏；列头行可选表头样式），画布 / 预览 / 打印共用这一份 HTML */
    function canvasCtx() {
        var d = state.design, mapped = [], rows = [], i, r;
        for (i = 0; i < d.columns.length; i++) {
            var one = d.columns[i];
            if (!boolOf(one.visible)) { continue; }
            mapped.push({
                field: one.field, label: one.label || one.field, index: mapped.length,
                width: intOf(one.width, 120), align: one.align || 'left',
                headerAlign: one.headerAlign || 'center',
                format: one.format || 'text', summary: one.summary || 'none', visible: true
            });
        }
        for (r = 1; r <= 3; r++) {
            var line = [];
            for (i = 0; i < mapped.length; i++) {
                line.push(sampleValue({ field: mapped[i].field }, r));
            }
            rows.push(line);
        }
        return { mode: 'canvas', mapped: mapped, rows: rows };
    }

    function renderFreeLayer() {
        var list = elements();
        var ctx = canvasCtx();
        $free.html(elementsHtml(list, ctx) + FREE_HINT_HTML);
        $free.css('height', Math.max(96, elementsBottom(list) + 16) + 'px');
        $('#rptFreeHint').prop('hidden', list.length > 0);
    }

    /** 预览纸上的页眉 / 页脚（没有内容就隐藏整条带） */
    function renderToolList() {
        var items = [];
        walkElements(elements(), function (el, list, index, parent, depth) {
            items.push({ el: el, depth: depth });
        });
        $('#toolCount').text(items.length + ' 个');
        if (!items.length) {
            $toolItems.html('<div class="rpt-tool__empty">还没有组件，拖一个进来试试</div>');
            return;
        }
        var html = '';
        for (var i = 0; i < items.length; i++) {
            var el = items[i].el;
            var text = el.kind === 'label' ? textOf(el.text)
                : (el.kind === 'chart' ? textOf(el.title)
                    : (el.kind === 'table' ? tableRows(el) + '×' + tableCols(el) : ''));
            html += '<div class="rpt-tool__item' + (items[i].depth ? ' rpt-tool__item--child' : '') +
                (String(el.id) === String(state.selectedElem) ? ' is-selected' : '') +
                '" data-eid="' + esc(el.id) + '" title="点一下选中这个组件">' +
                '<span class="rpt-tool__item-kind">' + esc(ELEMENT_NAME[el.kind] || el.kind) + '</span>' +
                '<span class="rpt-tool__item-text">' + esc(text || ELEMENT_NAME[el.kind] || '') + '</span>' +
                '</div>';
        }
        $toolItems.html(html);
    }

    /* ---------- 右栏：组件属性 ---------- */
    function fillChartFieldSelects(el) {
        var opts = '<option value="">（用前两列）</option>';
        var cols = state.design.columns;
        for (var i = 0; i < cols.length; i++) {
            opts += '<option value="' + esc(cols[i].field) + '">' +
                esc(cols[i].label || cols[i].field) + '</option>';
        }
        $('#elemChartCat, #elemChartVal').html(opts);
        $('#elemChartCat').val(textOf(el.categoryField));
        $('#elemChartVal').val(textOf(el.valueField));
    }

    function renderElemForm() {
        var hit = elementById(state.selectedElem);
        if (!hit) {
            $elemForm.prop('hidden', true);
            $('#elemEmpty').show();
            return;
        }
        var el = hit.el;
        $('#elemEmpty').hide();
        $elemForm.prop('hidden', false);
        $('#elemKind').text(ELEMENT_NAME[el.kind] || el.kind);
        $('#elemPath').text(hit.parent
            ? ('位于「' + (ELEMENT_NAME[hit.parent.kind] || hit.parent.kind) + '」内')
            : '设计区');
        $('#elemX').val(intOf(el.x, 0));
        $('#elemY').val(intOf(el.y, 0));
        $('#elemW').val(intOf(el.w, 120));
        $('#elemH').val(intOf(el.h, 32));
        $elemForm.find('.rpt-elgrp').each(function () {
            $(this).prop('hidden', $(this).attr('data-egroup') !== el.kind);
        });
        if (el.kind === 'label') {
            $('#elemText').val(el.text || '');
            $('#elemFontSize').val(intOf(el.fontSize, 14));
            $('#elemBold').val(boolOf(el.bold) ? '1' : '0');
            $('#elemAlign').val(el.align || 'left');
            $('#elemColor').val(el.color || '#303133');
        } else if (el.kind === 'line') {
            $('#elemLineDir').val(el.dir === 'v' ? 'v' : 'h');
            $('#elemLineWidth').val(intOf(el.thickness, 1));
            $('#elemLineColor').val(el.color || '#DCDFE6');
        } else if (el.kind === 'box') {
            $('#elemBorder').val(boolOf(el.border) ? '1' : '0');
            $('#elemBorderColor').val(el.borderColor || '#DCDFE6');
            $('#elemBg').val(el.bg || '');
            $('#elemRadius').val(intOf(el.radius, 0));
            $('#elemPadding').val(intOf(el.padding, 8));
        } else if (el.kind === 'image') {
            $('#elemSrc').val(el.src || '');
            $('#elemFit').val(el.fit || 'contain');
            $('#elemImgRadius').val(intOf(el.radius, 0));
        } else if (el.kind === 'chart') {
            $('#elemChartType').val(el.chartType || 'bar');
            $('#elemChartTitle').val(el.title || '');
            $('#elemLegend').val(boolOf(el.legend) ? '1' : '0');
            fillChartFieldSelects(el);
        } else if (el.kind === 'table') {
            var showHeader = el.showHeader === undefined ? true : boolOf(el.showHeader);
            $('#elemTblRows').val(tableRows(el));
            $('#elemTblCols').val(tableCols(el));
            $('#elemTblShowHeader').val(showHeader ? '1' : '0');
            $('#elemTblHeader').val(boolOf(el.headerRow) ? '1' : '0').prop('disabled', !showHeader);
            $('#elemTblAlign').val(el.align || 'left');
            renderCellGrid(el);
        }
    }

    /** 表格的单元格编辑器：行号 + 每格一个输入框（首行当表头时给个浅底色） */
    function renderCellGrid(el) {
        var $grid = $('#elemTblCells');
        if (!$grid.length || !el) { return; }
        var rows = tableRows(el), cols = tableCols(el), cells = tableCells(el);
        var head = boolOf(el.headerRow);
        var html = '<table class="rpt-cellgrid__table"><tbody>', r, c;
        for (r = 0; r < rows; r++) {
            html += '<tr><th class="rpt-cellgrid__no">' + (r + 1) + '</th>';
            for (c = 0; c < cols; c++) {
                html += '<td><input class="el-input__inner' + (head && r === 0 ? ' is-head' : '') +
                    '" type="text" maxlength="' + TABLE_CELL_MAX + '" data-r="' + r + '" data-c="' + c +
                    '" value="' + esc(cells[r][c]) + '" aria-label="第 ' + (r + 1) + ' 行第 ' + (c + 1) + ' 列">' +
                    '</td>';
            }
            html += '</tr>';
        }
        html += '</tbody></table>';
        $grid.html(html);
        $('#elemTblSize').text(rows + ' 行 × ' + cols + ' 列');
    }

    $elemForm.on('input change', 'input,select,textarea', function () {
        var el = selectedElement();
        if (!el) { return; }
        var id = this.id, val = $(this).val();
        /* 表格的单元格：用 data-r / data-c 定位，只改内容、不重建编辑器（不然光标会跳） */
        if (this.hasAttribute('data-r') && this.hasAttribute('data-c')) {
            setTableCell(el, intOf($(this).attr('data-r'), 0), intOf($(this).attr('data-c'), 0), val);
            markDirty();
            renderCanvas();
            return;
        }
        if (id === 'elemTblRows' || id === 'elemTblCols') {
            var rows = id === 'elemTblRows' ? intOf(val, tableRows(el)) : tableRows(el);
            var cols = id === 'elemTblCols' ? intOf(val, tableCols(el)) : tableCols(el);
            resizeTable(el, rows, cols);
            markDirty();
            renderCanvas();
            renderCellGrid(el);                       // 只重建格子，不动输入框本身（焦点保留）
            renderToolList();
            return;
        }
        if (id === 'elemX') { el.x = Math.max(0, intOf(val, 0)); }
        else if (id === 'elemY') { el.y = Math.max(0, intOf(val, 0)); }
        else if (id === 'elemW') { el.w = Math.max(20, intOf(val, 200)); }
        else if (id === 'elemH') { el.h = Math.max(10, intOf(val, 40)); }
        else if (id === 'elemText') { el.text = textOf(val); }
        else if (id === 'elemFontSize') { el.fontSize = Math.min(48, Math.max(8, intOf(val, 14))); }
        else if (id === 'elemBold') { el.bold = val === '1'; }
        else if (id === 'elemAlign') { el.align = val; }
        else if (id === 'elemColor') { el.color = val; }
        else if (id === 'elemLineDir') { el.dir = val === 'v' ? 'v' : 'h'; }
        else if (id === 'elemLineWidth') { el.thickness = Math.min(8, Math.max(1, intOf(val, 1))); }
        else if (id === 'elemLineColor') { el.color = val; }
        else if (id === 'elemBorder') { el.border = val === '1'; }
        else if (id === 'elemBorderColor') { el.borderColor = val; }
        else if (id === 'elemBg') { el.bg = textOf(val); }
        else if (id === 'elemRadius') { el.radius = Math.min(40, Math.max(0, intOf(val, 0))); }
        else if (id === 'elemPadding') { el.padding = Math.min(40, Math.max(0, intOf(val, 0))); }
        else if (id === 'elemSrc') { el.src = textOf(val); }
        else if (id === 'elemFit') { el.fit = val; }
        else if (id === 'elemImgRadius') { el.radius = Math.min(40, Math.max(0, intOf(val, 0))); }
        else if (id === 'elemChartType') { el.chartType = val; }
        else if (id === 'elemChartTitle') { el.title = textOf(val); }
        else if (id === 'elemChartCat') { el.categoryField = textOf(val); }
        else if (id === 'elemChartVal') { el.valueField = textOf(val); }
        else if (id === 'elemLegend') { el.legend = val === '1'; }
        else if (id === 'elemTblHeader') { el.headerRow = val === '1'; renderCellGrid(el); }
        else if (id === 'elemTblShowHeader') {
            el.showHeader = val === '1';
            $('#elemTblHeader').prop('disabled', !el.showHeader);
            renderCellGrid(el);
        }
        else if (id === 'elemTblAlign') { el.align = val; }
        markDirty();
        renderCanvas();
        renderToolList();
    });

    /** 表格：加减行 / 列、清空内容 */
    function tableAdjust(deltaRows, deltaCols) {
        var el = selectedElement();
        if (!el || el.kind !== 'table') { return; }
        var rows = tableRows(el), cols = tableCols(el);
        var nextRows = Math.min(TABLE_MAX_ROWS, Math.max(1, rows + deltaRows));
        var nextCols = Math.min(TABLE_MAX_COLS, Math.max(1, cols + deltaCols));
        if (nextRows === rows && nextCols === cols) {
            UI.message({ type: 'warning', message: '表格最多 ' + TABLE_MAX_ROWS + ' 行 / ' +
                TABLE_MAX_COLS + ' 列，最少 1 行 1 列' });
            return;
        }
        resizeTable(el, nextRows, nextCols);
        markDirty();
        renderCanvas();
        renderElemForm();
        renderToolList();
    }

    $('#btnTblAddRow').on('click', function () { tableAdjust(1, 0); });
    $('#btnTblDelRow').on('click', function () { tableAdjust(-1, 0); });
    $('#btnTblAddCol').on('click', function () { tableAdjust(0, 1); });
    $('#btnTblDelCol').on('click', function () { tableAdjust(0, -1); });
    $('#btnTblClear').on('click', function () {
        var el = selectedElement();
        if (!el || el.kind !== 'table') { return; }
        var rows = tableRows(el), cols = tableCols(el), grid = [], r, c;
        for (r = 0; r < rows; r++) {
            var line = [];
            for (c = 0; c < cols; c++) { line.push(''); }
            grid.push(line);
        }
        el.rows = rows;
        el.cols = cols;
        el.cells = grid;
        markDirty();
        renderCanvas();
        renderCellGrid(el);
        renderToolList();
        UI.message({ type: 'success', message: '表格内容已清空（行列保留）' });
    });

    $('#btnElemUp').on('click', function () { moveElementLayer(1); });
    $('#btnElemDown').on('click', function () { moveElementLayer(-1); });
    $('#btnElemRemove').on('click', function () { removeSelectedElement(); });

    /* ---------- 工具箱：拖拽 / 双击加入 ---------- */
    $('#toolGrid').on('dragstart', '.rpt-tool__card', function (e) {
        var kind = $(this).attr('data-el-kind');
        dragPayload = { kind: 'element', elKind: kind };
        dragColIndex = -1;
        try {
            e.originalEvent.dataTransfer.effectAllowed = 'copy';
            e.originalEvent.dataTransfer.setData('text/plain', 'rpt-el:' + kind);
        } catch (err) { }
        $(this).addClass('is-dragging');
    });
    $('#toolGrid').on('dragend', '.rpt-tool__card', function () {
        $(this).removeClass('is-dragging');
        $free.removeClass('is-over');
    });
    $('#toolGrid').on('dblclick', '.rpt-tool__card', function () {
        addElement($(this).attr('data-el-kind'));
    });

    $toolItems.on('click', '.rpt-tool__item', function () {
        state.selectedElem = $(this).attr('data-eid');
        renderCanvas();
        renderElemForm();
        renderToolList();
        setPropTab('elem');
    });

    /* ---------- 设计区：选中 / 拖动 / 接收拖拽 ---------- */
    function boxFromEvent(e) {
        var $box = $(e.target).closest('.rpt-el--box');
        return $box.length ? $box.first() : $();
    }

    $free.on('mousedown', '.rpt-el', function (e) {
        if (e.button !== 0) { return; }
        var id = $(this).attr('data-eid');
        var hit = elementById(id);
        if (!hit) { return; }
        e.preventDefault();
        e.stopPropagation();
        state.selectedElem = id;
        renderCanvas();
        renderElemForm();
        renderToolList();
        setPropTab('elem');
        var $node = $free.find('.rpt-el[data-eid="' + id + '"]').first();
        var startX = e.pageX, startY = e.pageY;
        var originX = intOf(hit.el.x, 0), originY = intOf(hit.el.y, 0);
        var moved = false;
        $(document).on('mousemove.rtpel', function (ev) {
            var dx = ev.pageX - startX, dy = ev.pageY - startY;
            if (Math.abs(dx) + Math.abs(dy) > 2) { moved = true; }
            hit.el.x = Math.max(0, originX + dx);
            hit.el.y = Math.max(0, originY + dy);
            $node.css({ left: hit.el.x + 'px', top: hit.el.y + 'px' });
            $('#elemX').val(hit.el.x);
            $('#elemY').val(hit.el.y);
        }).on('mouseup.rtpel', function () {
            $(document).off('.rtpel');
            if (moved) {
                markDirty();
                renderCanvas();
                renderElemForm();
                renderToolList();
            }
        });
    });

    $free.on('click', function (e) {
        if ($(e.target).closest('.rpt-el').length) { return; }
        if (!state.selectedElem) { return; }
        state.selectedElem = '';
        renderCanvas();
        renderElemForm();
        renderToolList();
    });

    $free.on('dragover', function (e) {
        e.preventDefault();
        try { e.originalEvent.dataTransfer.dropEffect = 'copy'; } catch (err) { }
        $free.addClass('is-over');
        $free.find('.rpt-el--box').removeClass('is-over');
        var $box = boxFromEvent(e);
        if ($box.length) { $box.addClass('is-over'); }
    });
    $free.on('dragleave', function (e) {
        if (e.target === this) {
            $free.removeClass('is-over');
            $free.find('.rpt-el--box').removeClass('is-over');
        }
    });
    $free.on('drop', function (e) {
        e.preventDefault();
        $free.removeClass('is-over');
        $free.find('.rpt-el--box').removeClass('is-over');
        var payload = payloadFromEvent(e);
        dragPayload = null;
        if (!payload || payload.kind !== 'element') { return; }
        var ev = e.originalEvent || {};
        var $box = boxFromEvent(e);
        var rect = ($box.length ? $box[0] : this).getBoundingClientRect();
        var x = Math.max(0, Math.round((ev.clientX || 0) - rect.left));
        var y = Math.max(0, Math.round((ev.clientY || 0) - rect.top));
        if ($box.length) {
            addElement(payload.elKind, { parent: $box.attr('data-eid'), x: x, y: y });
        } else {
            addElement(payload.elKind, { x: x, y: y });
        }
    });

    /* 选中组件时按 Delete 删除（输入框里按 Delete 不算） */
    $(document).on('keydown', function (e) {
        if (!state.selectedElem) { return; }
        var tag = (e.target && e.target.tagName) || '';
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) { return; }
        if (e.key === 'Delete' || e.keyCode === 46) { removeSelectedElement(); }
    });

    /* ==================================================================
       六、右栏：报表参数 + 数据集 SQL
       ================================================================== */
    function paramControlText(p) {
        var control = textOf(p.control) || 'text';
        if (control === 'select' || control === 'multiselect') {
            return '下拉：' + (textOf(p.options) || '（未填选项）');
        }
        if (control === 'checkbox') { return '勾选'; }
        if (control === 'date') { return '日期'; }
        if (control === 'number') { return '数字'; }
        return '输入框';
    }

    function paramCardHtml(p, index) {
        var typeOpts = '';
        for (var i = 0; i < PARAM_TYPES.length; i++) {
            typeOpts += '<option value="' + PARAM_TYPES[i].value + '"' +
                (p.type === PARAM_TYPES[i].value ? ' selected' : '') + '>' + PARAM_TYPES[i].label + '</option>';
        }
        var ctrlOpts = '';
        for (var c = 0; c < PARAM_CONTROLS.length; c++) {
            ctrlOpts += '<option value="' + PARAM_CONTROLS[c].value + '"' +
                (p.control === PARAM_CONTROLS[c].value ? ' selected' : '') + '>' +
                PARAM_CONTROLS[c].label + '</option>';
        }
        var isSelect = p.control === 'select' || p.control === 'multiselect';
        return '<div class="rpt-param__card" data-index="' + index + '">' +
            '<div class="rpt-param__head">' +
                '<span class="rpt-param__no">#' + (index + 1) + '</span>' +
                '<div class="el-input rpt-param__name"><input class="el-input__inner" type="text" ' +
                    'data-p="name" value="' + esc(p.name) + '" maxlength="30" placeholder="参数名 :name"></div>' +
                '<div class="el-input rpt-param__label"><input class="el-input__inner" type="text" ' +
                    'data-p="label" value="' + esc(p.label) + '" maxlength="60" placeholder="显示名"></div>' +
                '<button type="button" class="rpt-param__move" data-move="up" title="上移一位" ' +
                    'aria-label="上移">↑</button>' +
                '<button type="button" class="rpt-param__move" data-move="down" title="下移一位" ' +
                    'aria-label="下移">↓</button>' +
                '<button type="button" class="rpt-param__del" title="删除这个参数">×</button>' +
            '</div>' +
            '<div class="rpt-param__row">' +
                '<label>类型</label><select class="el-input__inner" data-p="type">' + typeOpts + '</select>' +
                '<label>控件</label><select class="el-input__inner" data-p="control">' + ctrlOpts + '</select>' +
                '<label>必填</label><select class="el-input__inner" data-p="required">' +
                    '<option value="0"' + (boolOf(p.required) ? '' : ' selected') + '>否</option>' +
                    '<option value="1"' + (boolOf(p.required) ? ' selected' : '') + '>是</option>' +
                '</select>' +
            '</div>' +
            '<div class="rpt-param__row rpt-param__row--wide">' +
                '<label>默认值</label>' +
                '<input class="el-input__inner" type="text" data-p="defaultValue" value="' +
                    esc(p.defaultValue) + '" maxlength="200" placeholder="可留空">' +
            '</div>' +
            '<div class="rpt-param__row rpt-param__row--wide rpt-param__options"' +
                (isSelect ? '' : ' hidden') + '>' +
                '<label>选项</label>' +
                '<input class="el-input__inner" type="text" data-p="options" value="' +
                    esc(p.options) + '" maxlength="300" placeholder="下拉选项，逗号分隔，如：在职,试用,离职">' +
            '</div>' +
        '</div>';
    }

    function renderParams() {
        var params = state.design.params;
        $('#paramCount').text(params.length + ' 个');
        if (!params.length) {
            $paramBody.html('<div class="rpt-param__empty">还没有参数。报表需要按条件筛选时点「新增参数」</div>');
        } else {
            var html = '';
            for (var i = 0; i < params.length; i++) { html += paramCardHtml(params[i], i); }
            $paramBody.html(html);
        }
        $('#rptSqlText').val(state.design.sqlText || '');
        syncSqlInfo();
    }

    function syncSqlInfo() {
        var d = state.design;
        var sql = textOf(d.sqlText);
        var fields = [];
        for (var i = 0; i < d.columns.length; i++) {
            if (boolOf(d.columns[i].visible)) { fields.push(d.columns[i].field); }
        }
        if (sql) {
            $('#rptSqlInfo').html('使用自定义 SQL · 参数用 <code>:参数名</code> 引用');
        } else if (d.mainTable) {
            $('#rptSqlInfo').html('自动生成：<code>SELECT ' +
                esc(fields.length ? fields.join(', ') : '*') + ' FROM ' + esc(d.mainTable) + '</code>');
        } else {
            $('#rptSqlInfo').text('还没选主表：把左侧的字段拖进画布（或双击字段），或手写一条 SQL');
        }
    }

    $paramBody.on('input change', 'input,select', function () {
        var $card = $(this).closest('.rpt-param__card');
        var index = intOf($card.attr('data-index'), -1);
        if (index < 0 || index >= state.design.params.length) { return; }
        var p = state.design.params[index];
        var key = $(this).attr('data-p');
        if (key === 'required') { p.required = $(this).val() === '1'; }
        else { p[key] = textOf($(this).val()); }
        if (key === 'control') {
            $card.find('.rpt-param__options').prop('hidden',
                p.control !== 'select' && p.control !== 'multiselect');
        }
        markDirty();
        renderCanvas();
        syncSqlInfo();
    });

    /** 参数顺序 = 画布参数带 / 运行窗参数区 / 打印与导出的先后，这里上移下移即可 */
    $paramBody.on('click', '.rpt-param__move', function () {
        var $card = $(this).closest('.rpt-param__card');
        var index = intOf($card.attr('data-index'), -1);
        var dir = $(this).attr('data-move') === 'up' ? -1 : 1;
        var list = state.design.params;
        var to = index + dir;
        if (index < 0 || to < 0 || to >= list.length) { return; }
        var one = list[index];
        list[index] = list[to];
        list[to] = one;
        markDirty();
        renderParams();
        renderCanvas();
        UI.message({
            type: 'success',
            message: '参数顺序已调整：' + $.map(list, function (it) {
                return textOf(it.label) || textOf(it.name);
            }).join(' → ')
        });
    });

    $paramBody.on('click', '.rpt-param__del', function () {
        var $card = $(this).closest('.rpt-param__card');
        var index = intOf($card.attr('data-index'), -1);
        if (index < 0) { return; }
        state.design.params.splice(index, 1);
        markDirty();
        renderParams();
        renderCanvas();
    });

    $('#btnParamAdd').on('click', function () {
        if (state.design.params.length >= MAX_PARAMS) {
            UI.message({ type: 'warning', message: '一张报表最多 ' + MAX_PARAMS + ' 个参数' });
            return;
        }
        var n = state.design.params.length + 1;
        var used = {};
        for (var i = 0; i < state.design.params.length; i++) { used[state.design.params[i].name] = 1; }
        while (used['param' + n]) { n++; }
        state.design.params.push({
            name: 'param' + n, label: '参数' + n, type: 'string', control: 'text',
            required: false, defaultValue: '', options: '', remark: ''
        });
        markDirty();
        renderParams();
        renderCanvas();
        UI.message({ type: 'success', message: '已新增参数 param' + n + '，改好参数名与显示名后即可在 SQL 里用 :param' + n + ' 引用' });
    });

    $('#btnParamDemo').on('click', function () {
        if (state.design.params.length >= MAX_PARAMS) { return; }
        var demos = [
            { name: 'beginDate', label: '开始日期', type: 'date', control: 'date', required: false, defaultValue: '' },
            { name: 'endDate', label: '结束日期', type: 'date', control: 'date', required: false, defaultValue: '' },
            { name: 'keyword', label: '关键字', type: 'string', control: 'text', required: false, defaultValue: '' },
            { name: 'status', label: '状态', type: 'string', control: 'select', required: false,
              defaultValue: '', options: '在职,试用,离职' }
        ];
        for (var i = 0; i < demos.length && state.design.params.length < MAX_PARAMS; i++) {
            var exists = false;
            for (var k = 0; k < state.design.params.length; k++) {
                if (state.design.params[k].name === demos[i].name) { exists = true; break; }
            }
            if (!exists) {
                var one = $.extend({ options: '', remark: '' }, demos[i]);
                state.design.params.push(one);
            }
        }
        markDirty();
        renderParams();
        renderCanvas();
        UI.message({ type: 'success', message: '已插入示例参数，可在 SQL 里用 :beginDate / :endDate 等引用' });
    });

    $('#rptSqlText').on('input', function () {
        state.design.sqlText = $(this).val();
        markDirty();
        applySqlCustomColumns();    // 检测新增的 SQL 自定义列 → 回显进设计器数据表格
        syncSqlInfo();
    });

    /* ==================================================================
       六.1 SQL 自定义列（2026-11-05 用户需求）
       ------------------------------------------------------------------
       手写 SQL 里的「别名」列（如 salary * 12 AS 年薪、COUNT(*) AS total）
       不在数据源表的字段清单里 —— 检测到新增的就自动回显进设计器数据表格
       （design.columns，画布明细区），之后在右栏「字段属性」里照常设置
       显示名 / 宽度 / 对齐 / 列标对齐 / 格式 / 汇总等显示风格。
       只增不删：SQL 里删掉别名不会动已加入的列（避免误删用户调好的样式）。
       ================================================================== */
    /**
     * 扫一遍 SQL，产出与原文等长的掩码：
     *   'q' = 在引号里（' " `）；'c' = 在注释里；'0'~'9' = 引号外的括号深度。
     * 后面找 FROM / 切逗号只认 '0' 的位置，字符串和子查询里的关键字不会误伤。
     */
    function sqlMaskOf(text) {
        var out = '', depth = 0, i, ch, nx;
        var inS = false, inD = false, inB = false;
        for (i = 0; i < text.length; i++) {
            ch = text.charAt(i);
            nx = text.charAt(i + 1);
            if (inS) { out += 'q'; if (ch === "'") { inS = false; } continue; }
            if (inD) { out += 'q'; if (ch === '"') { inD = false; } continue; }
            if (inB) { out += 'q'; if (ch === '`') { inB = false; } continue; }
            if (ch === "'") { inS = true; out += 'q'; continue; }
            if (ch === '"') { inD = true; out += 'q'; continue; }
            if (ch === '`') { inB = true; out += 'q'; continue; }
            if ((ch === '-' && nx === '-') || ch === '#') {
                var nl = text.indexOf('\n', i);
                if (nl < 0) { nl = text.length; }
                for (; i < nl; i++) { out += 'c'; }
                i--; continue;              /* 换行符不标 c，下一轮正常处理 */
            }
            if (ch === '/' && nx === '*') {
                var end = text.indexOf('*/', i + 2);
                if (end < 0) { end = text.length; } else { end += 2; }
                for (; i < end; i++) { out += 'c'; }
                i--; continue;
            }
            if (ch === '(') { depth = Math.min(9, depth + 1); out += String(depth); continue; }
            if (ch === ')') { depth = Math.max(0, depth - 1); out += String(depth); continue; }
            out += String(depth);
        }
        return out;
    }

    function sqlUnquote(token) {
        var s = String(token || '');
        if (s.length >= 2) {
            var a = s.charAt(0), b = s.charAt(s.length - 1);
            if ((a === '"' && b === '"') || (a === '`' && b === '`') || (a === "'" && b === "'")) {
                return s.slice(1, -1);
            }
        }
        return s;
    }

    var SQL_ALIAS_KEYWORDS = 'from|where|and|or|not|end|case|when|then|else|null|as|on|join|left|right|' +
        'inner|outer|union|group|order|by|limit|having|distinct|all|desc|asc|between|in|is|like|exists|' +
        'select|using|over|partition|rows|range|groups|into|values|set';
    /* 别名只能是「引号包起来的串」或「标识符」（字母/下划线/中文开头，后面可跟数字、_ $ # 中文） */
    var SQL_ALIAS_NAME = /^("[^"]*"|`[^`]*`|'[^']*'|[A-Za-z_\u4e00-\u9fa5][\w$\u4e00-\u9fa5#]*)$/;
    /* 纯运算符词：出现在别名前说明这是表达式中间（a + b 的 b 不是别名） */
    var SQL_ALIAS_OPERATOR = /^[+\-*/%<>=!|&^~,.:]+$/;

    /**
     * 把 SELECT 列表项按**空白**切成「词」——别名判定只认空格分隔，不逐字符猜：
     *   · 引号（' " `）里的内容整体不切（`"总 计"` 算一个词）；
     *   · 括号里的内容整体不切（`COUNT(*)`、`CONCAT(a, b)` 各算一个词）。
     * 例：`salary * 12 AS 年薪` → ['salary','*','12','AS','年薪']
     *     `COUNT(*) cnt`       → ['COUNT(*)','cnt']
     */
    function sqlTokensOf(text) {
        var s = String(text || ''), out = [], cur = '', i, ch;
        var quote = '', depth = 0;
        for (i = 0; i < s.length; i++) {
            ch = s.charAt(i);
            if (quote) {
                cur += ch;
                if (ch === quote) { quote = ''; }
                continue;
            }
            if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
            if (ch === '(') { depth++; cur += ch; continue; }
            if (ch === ')') { depth = Math.max(0, depth - 1); cur += ch; continue; }
            if (!depth && /\s/.test(ch)) {
                if (cur) { out.push(cur); cur = ''; }
                continue;
            }
            cur += ch;
        }
        if (cur) { out.push(cur); }
        return out;
    }

    /**
     * 从一个 SELECT 列表项里取「别名」（**按空白分词判定**，2026-11-06 用户需求）：
     *   · 必须至少两个词 —— 只有一个词的（`code`、`COUNT(*)`、`t1.code`）没有别名；
     *   · 最后一个词必须是合法别名：标识符或引号串，且不是 SQL 关键字；
     *   · 前一个词不能是运算符（`a + b` 里的 b 不是别名，那是表达式的右操作数）；
     *   · 前一个词是 AS → AS 别名（AS 前还必须有表达式）；
     *   · 其余多词情形（`salary * 12 年薪`、`ename 姓名`）→ 最后一个词就是裸别名。
     * 取不到返回 ''（无别名的表达式列由数据库自己命名，不回显）。
     */
    function sqlAliasOf(item) {
        var tokens = sqlTokensOf(item);
        var n = tokens.length;
        if (n < 2) { return ''; }
        var last = tokens[n - 1], prev = tokens[n - 2];
        if (!SQL_ALIAS_NAME.test(last)) { return ''; }                 // 数字 / 运算符结尾 → 不是别名
        if (new RegExp('^(' + SQL_ALIAS_KEYWORDS + ')$', 'i').test(sqlUnquote(last))) { return ''; }
        if (SQL_ALIAS_OPERATOR.test(prev)) { return ''; }              // a + b：b 是操作数
        if (/^as$/i.test(prev)) {
            return n >= 3 ? sqlUnquote(last) : '';                     // AS 形式：AS 前面得有表达式
        }
        if (n === 2 && SQL_ALIAS_OPERATOR.test(tokens[0])) { return ''; }
        return sqlUnquote(last);
    }

    /** 顶层 SELECT 列表里的别名清单（按出现顺序去重；没有 FROM 时取到串尾，边写边识别） */
    function sqlSelectAliases(sql) {
        var text = String(sql || '');
        if (!text) { return []; }
        var mask = sqlMaskOf(text);
        var masked = '';
        for (var i = 0; i < text.length; i++) {
            masked += mask.charAt(i) === 'c' ? ' ' : text.charAt(i);
        }
        var sel = /\bselect\b/i.exec(masked);
        if (!sel) { return []; }
        var fromRe = /\bfrom\b/gi, m, fromIdx = -1;
        while ((m = fromRe.exec(masked))) {
            if (mask.charAt(m.index) === '0') { fromIdx = m.index; break; }
        }
        var base = sel.index + sel[0].length;
        var listText = masked.slice(base, fromIdx >= 0 ? fromIdx : masked.length);
        listText = listText.replace(/^\s*(distinct|all)\s+/i, ' ');     /* DISTINCT 不是别名前缀 */
        var items = [], cur = '';
        for (i = 0; i < listText.length; i++) {
            if (mask.charAt(base + i) === '0' && listText.charAt(i) === ',') {
                items.push(cur); cur = '';
            } else {
                cur += listText.charAt(i);
            }
        }
        items.push(cur);
        var out = [], seen = {};
        for (i = 0; i < items.length; i++) {
            var alias = sqlAliasOf(items[i]);
            if (!alias || seen[alias]) { continue; }
            seen[alias] = 1;
            out.push(alias);
        }
        return out;
    }

    /** 数据源已知字段名（主表字段缓存）：别名撞了数据源字段名的算「改名的表字段」之外的情形，不重复回显 */
    function knownSourceFields() {
        var d = state.design;
        var db = textOf(d.databaseName) || textOf($('#srcDb').val());
        var cached = state.columnMap[db + '|' + textOf(d.mainTable)];
        var fields = (cached && cached.columns) || [];
        var out = {};
        for (var i = 0; i < fields.length; i++) { out[String(fields[i].name)] = 1; }
        return out;
    }

    /**
     * SQL 变化后**全量重算**自定义列（2026-11-06 用户需求：不只增不减）：
     *   · SQL 里已经消失的别名 → 从明细表移除对应自定义列（数据源表字段列不受影响）；
     *   · 新出现的别名 → 追加一列（custom:1，位置按 SQL 顺序排在已有列之后）；
     *   · 仍存在的别名 → 原样保留，用户调好的显示名 / 宽度 / 对齐 / 格式不会丢；
     *   · 与数据源字段同名的别名不回显（那是表里已有的列，重复加会取不到数据）。
     */
    function applySqlCustomColumns() {
        var d = state.design;
        var aliases = sqlSelectAliases(d.sqlText);
        var wanted = {}, i;
        for (i = 0; i < aliases.length; i++) { wanted[aliases[i]] = 1; }
        var known = knownSourceFields();

        /* 1) 先剔掉 SQL 里已经不存在的自定义列（只动 custom=1 的，数据源字段列一律保留） */
        var removed = [], kept = [];
        for (i = 0; i < d.columns.length; i++) {
            var col = d.columns[i];
            if (boolOf(col.custom) && !wanted[String(col.field)]) {
                removed.push(String(col.field));
                continue;
            }
            kept.push(col);
        }

        /* 2) 再按 SQL 顺序补上新出现的别名 */
        var added = [], fields = {};
        for (i = 0; i < kept.length; i++) { fields[String(kept[i].field)] = 1; }
        for (i = 0; i < aliases.length; i++) {
            var alias = aliases[i];
            if (fields[alias] || known[alias]) { continue; }
            if (kept.length >= MAX_COLUMNS) {
                UI.message({ type: 'warning',
                    message: '最多 ' + MAX_COLUMNS + ' 列，自定义列「' + alias + '」没有加入' });
                break;
            }
            kept.push({
                field: alias, label: alias, table: '',
                width: defaultWidth(alias), align: defaultAlign(alias),
                headerAlign: 'center', format: defaultFormat(alias),
                summary: 'none', visible: true, custom: 1
            });
            fields[alias] = 1;
            added.push(alias);
        }

        if (!removed.length && !added.length) { return; }   // 没有增减 → 不打扰用户

        d.columns = kept;
        if (state.selectedCol >= kept.length) { state.selectedCol = kept.length - 1; }
        if (removed.length && state.selectedCol >= 0 &&
            !kept.length) { state.selectedCol = -1; }
        afterColumnsChanged();

        var tips = [];
        if (added.length) { tips.push('新增 ' + added.length + ' 列：' + added.join('、')); }
        if (removed.length) { tips.push('移除 ' + removed.length + ' 列：' + removed.join('、')); }
        UI.message({ type: tips.length ? 'success' : 'info',
            message: 'SQL 自定义列已同步（' + tips.join('；') + '）' });
        setStatus('SQL 自定义列已同步：' + tips.join('；'));
    }

    $('#btnSqlAuto').on('click', function () {
        var d = state.design;
        if (!d.mainTable) {
            UI.message({ type: 'warning', message: '还没选主表：先把左侧的字段拖进画布（或双击字段）' });
            return;
        }
        var fields = [];
        for (var i = 0; i < d.columns.length; i++) {
            if (boolOf(d.columns[i].visible)) { fields.push(d.columns[i].field); }
        }
        d.sqlText = 'SELECT ' + (fields.length ? fields.join(', ') : '*') +
            ' FROM ' + d.mainTable;
        $('#rptSqlText').val(d.sqlText);
        markDirty();
        syncSqlInfo();
        UI.message({ type: 'success', message: '已按主表与已拖入的字段生成 SQL，可继续加 WHERE 条件' });
    });

    /* ==================================================================
       七、右栏：页面模板
       ================================================================== */
    function fillTemplateForm() {
        var d = state.design;
        var t = d.template;
        var g = d.design;
        $('#tplPaper').val(t.paper || 'A4');
        $('#tplOrientation').val(t.orientation || 'portrait');
        $('#tplMt').val(intOf(t.marginTop, 12));
        $('#tplMr').val(intOf(t.marginRight, 10));
        $('#tplMb').val(intOf(t.marginBottom, 12));
        $('#tplMl').val(intOf(t.marginLeft, 10));
        $('#tplFont').val(t.fontFamily || 'Microsoft YaHei');
        $('#tplFontSize').val(intOf(t.fontSize, 12));
        $('#tplTitleSize').val(intOf(t.titleSize, 18));
        $('#tplTitleAlign').val(t.titleAlign || 'center');
        $('#tplTitleBold').val(boolOf(t.titleBold) ? '1' : '0');
        $('#tplCompact').val(boolOf(t.compact) ? '1' : '0');
        $('#tplZebra').val(boolOf(g.zebra) ? '1' : '0');
        $('#tplBordered').val(boolOf(g.bordered) ? '1' : '0');
        $('#tplSubtitle').val(g.subtitle || '');
        $('#tplHeader').val(g.headerText || '');
        $('#tplFooter').val(g.footerText || '');
        $('#tplHeaderAlign').val(g.headerAlign || 'left');
        $('#tplFooterAlign').val(g.footerAlign || 'center');
        $('#tplHeaderLogo').val(t.headerLogo || '');
        $('#tplFooterLogo').val(t.footerLogo || '');
        $('#tplHeaderLogoPos').val(t.headerLogoPos === 'right' ? 'right' : 'left');
        $('#tplFooterLogoPos').val(t.footerLogoPos === 'right' ? 'right' : 'left');
        $('#tplHeaderLogoH').val(intOf(t.headerLogoHeight, 32));
        $('#tplFooterLogoH').val(intOf(t.footerLogoHeight, 28));
        $('#tplWatermark').val(t.watermark || '');
        $('#tplPageNo').val(boolOf(t.showPageNo) ? '1' : '0');
        $('#tplTime').val(boolOf(t.showTime) ? '1' : '0');
    }

    $('#tmplForm').on('input change', 'input,select', function () {
        var id = $(this).attr('id');
        var val = $(this).val();
        var t = state.design.template;
        var g = state.design.design;
        if (id === 'tplPaper') { t.paper = val; }
        else if (id === 'tplOrientation') { t.orientation = val; }
        else if (id === 'tplMt') { t.marginTop = intOf(val, 12); }
        else if (id === 'tplMr') { t.marginRight = intOf(val, 10); }
        else if (id === 'tplMb') { t.marginBottom = intOf(val, 12); }
        else if (id === 'tplMl') { t.marginLeft = intOf(val, 10); }
        else if (id === 'tplFont') { t.fontFamily = textOf(val); }
        else if (id === 'tplFontSize') { t.fontSize = intOf(val, 12); }
        else if (id === 'tplTitleSize') { t.titleSize = intOf(val, 18); }
        else if (id === 'tplTitleAlign') { t.titleAlign = val; }
        else if (id === 'tplTitleBold') { t.titleBold = val === '1'; }
        else if (id === 'tplCompact') { t.compact = val === '1'; }
        else if (id === 'tplZebra') { g.zebra = val === '1'; }
        else if (id === 'tplBordered') { g.bordered = val === '1'; }
        else if (id === 'tplSubtitle') { g.subtitle = textOf(val); }
        else if (id === 'tplHeader') { g.headerText = textOf(val); }
        else if (id === 'tplFooter') { g.footerText = textOf(val); }
        else if (id === 'tplHeaderAlign') { g.headerAlign = val; }
        else if (id === 'tplFooterAlign') { g.footerAlign = val; }
        else if (id === 'tplHeaderLogo') { t.headerLogo = textOf(val); }
        else if (id === 'tplFooterLogo') { t.footerLogo = textOf(val); }
        else if (id === 'tplHeaderLogoPos') { t.headerLogoPos = val === 'right' ? 'right' : 'left'; }
        else if (id === 'tplFooterLogoPos') { t.footerLogoPos = val === 'right' ? 'right' : 'left'; }
        else if (id === 'tplHeaderLogoH') { t.headerLogoHeight = Math.min(120, Math.max(12, intOf(val, 32))); }
        else if (id === 'tplFooterLogoH') { t.footerLogoHeight = Math.min(120, Math.max(12, intOf(val, 28))); }
        else if (id === 'tplWatermark') { t.watermark = textOf(val); }
        else if (id === 'tplPageNo') { t.showPageNo = val === '1'; }
        else if (id === 'tplTime') { t.showTime = val === '1'; }
        markDirty();
        renderCanvas();
    });

    /* ==================================================================
       八、打开 / 新建 / 清空
       ================================================================== */
    function syncHeadForm() {
        var d = state.design;
        $('#rptCode').val(d.code || '');
        $('#rptName').val(d.reportName || '');
        $('#rptCategory').val(d.category || '');
        $('#rptNameEn').val(d.reportNameEn || '');
        $('#rptIsPublic').prop('checked', boolOf(d.ispublic));
        $('#rptDesc').val(d.description || '');
        syncIntroHint();
    }

    /** 功能介绍的笔画计数 + 折叠时的摘要（有内容就把第一行显示在标题行上） */
    function syncIntroHint() {
        var text = String(state.design.description || '');
        var max = 500;
        $('#rptDescCount').text(text.length + ' / ' + max)
            .toggleClass('is-full', text.length >= max - 40);
        var firstLine = text.replace(/\r/g, '').split('\n')[0].replace(/^\s+|\s+$/g, '');
        var $hint = $('#rptIntroHint');
        if (firstLine) {
            $hint.text(firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine)
                .prop('title', text);
        } else {
            $hint.text('写清这张报表的用途、口径与适用场景（保存后随报表存储）').prop('title', '');
        }
    }

    function openReport(id) {
        if (state.dirty) {
            UI.confirm({
                title: '切换报表', type: 'warning',
                message: '当前画布还有未保存的修改，确定切换到另一张报表吗？',
                confirmText: '切换', cancelText: '留下继续编辑'
            }).done(function (ok) { if (ok) { doOpen(id); } });
            return;
        }
        doOpen(id);
    }

    function doOpen(id) {
        setStatus('正在读取报表…');
        Api.report.detail(id).done(function (row) {
            state.design = {
                id: row.id, code: row.code, reportName: row.reportName,
                reportNameEn: row.reportNameEn || '',
                category: row.category === '未分类' ? '' : (row.category || ''),
                connId: row.connId || '', connName: row.connName || '',
                databaseName: row.databaseName || '', mainTable: row.mainTable || '',
                sqlText: row.sqlText || '', description: row.description || '',
                enabled: boolOf(row.enabled) ? 1 : 0,
                ispublic: boolOf(row.ispublic) ? 1 : 0,
                version: intOf(row.version, 1), runCount: intOf(row.runCount, 0),
                lastRunTime: row.lastRunTime || '',
                params: row.params || [], columns: row.columns || [],
                design: $.extend(defaultDesign(), row.design || {}),
                template: $.extend({}, DEFAULT_TEMPLATE, row.template || {})
            };
            state.selectedId = row.id;
            state.selectedCol = state.design.columns.length ? 0 : -1;
            state.selectedElem = '';
            state.dirty = false;
            syncHeadForm();
            renderCanvas();
            renderColForm();
            renderParams();
            renderElemForm();
            renderToolList();
            fillTemplateForm();
            renderReports({ list: listFromRows() });
            syncToolbar();
            markClean();
            setStatus('已打开报表「' + state.design.reportName + '」（' + state.design.code + '），可继续设计');
            setLeftTab('source');
            /* 打开报表时同步数据源下拉，并把主表所在库 / 表准备好 */
            loadConns(state.design.connId);
        }).fail(function (err) {
            UI.message({ type: 'error', message: err.message || '读取报表失败' });
            setStatus('读取报表失败：' + (err.message || ''), 'error');
        });
    }

    function listFromRows() {
        var out = [];
        for (var key in state.rows) {
            if (state.rows.hasOwnProperty(key)) { out.push(state.rows[key]); }
        }
        return out;
    }

    function newReport() {
        if (state.dirty) {
            UI.confirm({
                title: '新建报表', type: 'warning',
                message: '当前画布还有未保存的修改，确定清空并新建吗？',
                confirmText: '清空新建', cancelText: '取消'
            }).done(function (ok) { if (ok) { doNew(); } });
            return;
        }
        doNew();
    }

    function doNew() {
        state.design = emptyDesign();
        state.selectedId = '';
        state.selectedCol = -1;
        state.selectedElem = '';
        state.dirty = false;
        syncHeadForm();
        renderCanvas();
        renderColForm();
        renderParams();
        renderElemForm();
        renderToolList();
        fillTemplateForm();
        renderReports({ list: listFromRows() });
        syncToolbar();
        markClean();
        setStatus('新报表：先把左侧的字段拖进画布（或双击字段），再填编码与名称');
        setLeftTab('source');
        if ($('#srcConn').val()) { setSourceTip('已就绪：把表 / 字段拖到中间画布'); }
    }

    $('#btnNew').on('click', newReport);
    $('#btnClear').on('click', function () {
        state.design.columns = [];
        state.design.params = [];
        state.design.sqlText = '';
        state.design.mainTable = '';
        state.design.design.elements = [];
        state.selectedCol = -1;
        state.selectedElem = '';
        afterColumnsChanged();
        renderParams();
        markDirty();
        setStatus('画布已清空（已保存的报表记录不受影响）', 'warn');
    });

    $('#rptName').on('input', function () {
        state.design.reportName = textOf($(this).val());
        markDirty();
        renderCanvas();
    });
    $('#rptCode').on('input', function () {
        state.design.code = textOf($(this).val()).toUpperCase();
        $(this).val(state.design.code);
        markDirty();
    });
    $('#rptCategory').on('input', function () {
        state.design.category = textOf($(this).val());
        markDirty();
    });
    /* 英文报表名（reportinfos.reportNameEn）：选填，随保存一起落库 */
    $('#rptNameEn').on('input', function () {
        state.design.reportNameEn = textOf($(this).val());
        markDirty();
    });
    /* 公开否：勾上后其他用户也能在报表清单 / 报表中心看到这张报表 */
    $('#rptIsPublic').on('change', function () {
        state.design.ispublic = $(this).prop('checked') ? 1 : 0;
        markDirty();
    });

    /* ---- 报表功能介绍（存 reportinfos.description，运行 / 预览时也随报表带走） ---- */
    $('#rptDesc').on('input', function () {
        state.design.description = String($(this).val() || '').slice(0, 500);
        syncIntroHint();
        markDirty();
    });
    $('#btnIntroToggle').on('click', function () {
        var $intro = $('#rptIntro');
        var collapsed = $intro.toggleClass('is-collapsed').hasClass('is-collapsed');
        $(this).attr('aria-expanded', collapsed ? 'false' : 'true');
        state.introCollapsed = collapsed;
        /* 收起时若没写过说明，提示一句免得找不到入口 */
        if (collapsed && !textOf(state.design.description)) {
            setStatus('功能介绍已收起，点「功能介绍」可再次展开填写', 'warn');
        }
    });

    /* ==================================================================
       九、保存（写 reportinfos）
       ================================================================== */
    function buildPayload(isCopy) {
        var d = state.design;
        var payload = {
            reportName: textOf(d.reportName),
            reportNameEn: textOf(d.reportNameEn),
            category: textOf(d.category),
            connId: d.connId || $('#srcConn').val() || '',
            databaseName: d.databaseName || $('#srcDb').val() || '',
            mainTable: d.mainTable,
            sqlText: textOf(d.sqlText),
            description: textOf(d.description),
            columns: [],
            params: [],
            design: $.extend({}, d.design, { title: textOf(d.reportName) }),
            template: $.extend({}, d.template),
            createEname: currentUserName(),     // 创建人姓名：后端按 token 反查登录员工后落库（页面上不填）
            enabled: d.enabled ? 1 : 0,
            ispublic: d.ispublic ? 1 : 0        // 公开否：1=其他用户在清单 / 报表中心也可见
        };
        if (textOf(d.code)) { payload.code = textOf(d.code).toUpperCase(); }
        var i;
        for (i = 0; i < d.columns.length; i++) {
            var one = d.columns[i];
            payload.columns.push({
                field: one.field, label: one.label || one.field, table: one.table || '',
                width: intOf(one.width, 120), align: one.align || 'left',
                headerAlign: one.headerAlign || 'center',
                format: one.format || 'text', summary: one.summary || 'none',
                visible: boolOf(one.visible),
                custom: one.custom ? 1 : 0          // SQL 自定义列标记（保存后重新打开仍显示「自定义」）
            });
        }
        for (i = 0; i < d.params.length; i++) {
            var p = d.params[i];
            payload.params.push({
                name: p.name, label: p.label || p.name, type: p.type || 'string',
                control: p.control || 'text', required: boolOf(p.required),
                defaultValue: textOf(p.defaultValue), options: textOf(p.options),
                remark: textOf(p.remark)
            });
        }
        if (!isCopy && d.id) { payload.id = d.id; }
        return payload;
    }

    function validateBeforeSave(payload) {
        if (!payload.reportName) { return '请填写报表名称'; }
        if (!payload.connId) { return '请先选择数据源连接（左栏「数据源」页签）'; }
        if (!payload.mainTable && !payload.sqlText) {
            return '请先把表拖进画布，或写一条报表 SQL';
        }
        if (!payload.columns.length) { return '请至少把 1 个字段拖进明细区'; }
        var seen = {};
        for (var i = 0; i < payload.params.length; i++) {
            var p = payload.params[i];
            if (!p.name) { return '第 ' + (i + 1) + ' 个参数缺少参数名'; }
            if (!/^[A-Za-z_][A-Za-z0-9_]{0,29}$/.test(p.name)) {
                return '参数名「' + p.name + '」不合法：只能用字母、数字、下划线，且以字母或下划线开头';
            }
            if (seen[p.name]) { return '参数名「' + p.name + '」重复'; }
            seen[p.name] = 1;
        }
        return '';
    }

    function doSave(isCopy) {
        if (state.saving) { return; }
        var payload = buildPayload(isCopy);
        var err = validateBeforeSave(payload);
        if (err) {
            UI.message({ type: 'warning', message: err });
            setStatus('保存失败：' + err, 'error');
            return;
        }
        state.saving = true;
        $('#btnSave').prop('disabled', true).text('保存中…');
        var isUpdate = !isCopy && !!state.design.id;
        var req = isUpdate ? Api.report.update(payload) : Api.report.add(payload);
        req.done(function (row) {
            state.design.id = row.id;
            state.design.code = row.code;
            state.design.version = intOf(row.version, 1);
            state.design.runCount = intOf(row.runCount, 0);
            state.design.enabled = boolOf(row.enabled) ? 1 : 0;
            state.design.columns = row.columns || state.design.columns;
            state.design.params = row.params || state.design.params;
            state.design.design = $.extend(defaultDesign(), row.design || {});
            state.design.template = $.extend({}, DEFAULT_TEMPLATE, row.template || {});
            state.selectedId = row.id;
            state.dirty = false;
            syncHeadForm();
            renderCanvas();
            renderColForm();
            renderParams();
            fillTemplateForm();
            markClean();
            loadReports();
            UI.message({ type: 'success',
                message: (isUpdate ? '已保存修改' : '已保存到报表信息表') + '：' + row.code });
            setStatus('已保存「' + row.reportName + '」到报表信息表（' + row.code +
                '，v' + state.design.version + '），其它页面可用该编码调用');
        }).fail(function (e) {
            UI.message({ type: 'error', message: e.message || '保存失败' });
            setStatus('保存失败：' + (e.message || ''), 'error');
        }).always(function () {
            state.saving = false;
            $('#btnSave').prop('disabled', false).text('保存');
        });
        return req;
    }

    $('#btnSave').on('click', function () { doSave(false); });
    $('#btnSaveAs').on('click', function () {
        if (!state.design.id) { doSave(false); return; }
        UI.confirm({
            title: '另存为新报表', type: 'info',
            message: '将以当前画布内容新建一张报表（编码自动生成，默认停用），原报表不受影响。确定继续吗？',
            confirmText: '另存为', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            var oldId = state.design.id, oldCode = state.design.code;
            state.design.id = '';
            state.design.code = '';
            syncHeadForm();
            var dfd = doSave(true);
            if (dfd && dfd.fail) {
                dfd.fail(function () {                    // 保存失败：恢复成原来那张报表
                    state.design.id = oldId;
                    state.design.code = oldCode;
                    syncHeadForm();
                });
            }
        });
    });

    /* ==================================================================
       十、预览
       ================================================================== */

    function openPreview() {
        var d = state.design;
        if (!textOf(d.reportName) && !d.id) {
            UI.message({ type: 'warning', message: '先填报表名称' });
            return;
        }
        if (!d.connId && !$('#srcConn').val()) {
            UI.message({ type: 'warning', message: '请先选择数据源连接' });
            return;
        }
        if (!d.columns.length) {
            UI.message({ type: 'warning', message: '请先把字段拖进明细区' });
            return;
        }
        pv.mode = 'preview';
        pv.row = null;
        return showViewer({
            params: d.params,
            title: textOf(d.reportName) || textOf(d.design.title) || '未命名报表',
            subtitle: d.design.subtitle || '',
            runText: '执行预览',
            dlgTitle: '报表预览 —— ' + (d.reportName || '未命名报表') + '（' + (d.code || '未保存') + '）',
            onRun: runPreview
        });
    }

    /** 双击清单里的报表：按它关联的连接对象执行已保存的查询，把结果放回纸张的相应位置 */
    function openRunViewer(id) {
        if (!id) { return; }
        setStatus('正在读取报表与连接信息…');
        Api.report.detail(id).done(function (row) {
            if (!boolOf(row.enabled)) {
                setStatus('报表「' + row.reportName + '」已停用，不能运行', 'warn');
                UI.confirm({
                    title: '报表已停用', type: 'warning',
                    message: '报表「' + row.reportName + '」已停用，不能运行。要打开画布继续编辑吗？',
                    confirmText: '打开编辑', cancelText: '关闭'
                }).done(function (ok) { if (ok) { doOpen(row.id); } });
                return;
            }
            pv.mode = 'run';
            pv.row = row;
            setStatus('正在按连接「' + (row.connName || '—') + '」运行报表「' + row.reportName + '」');
            showViewer({
                params: row.params || [],
                title: row.reportName,
                subtitle: (row.design || {}).subtitle || '',
                runText: '执行查询',
                dlgTitle: '运行报表 —— ' + row.reportName + '（' + row.code + '）',
                onRun: runSavedReport
            });
        }).fail(function (err) {
            setStatus('读取报表失败：' + (err.message || ''), 'error');
            UI.message({ type: 'error', message: err.message || '读取报表失败' });
        });
    }

    /** 运行已保存的报表（readonly 执行，后端会累加调用次数） */

    function runPreview($body) {
        var d = state.design;
        setFootBusy($body, true);
        footInfo($body, '正在执行查询…', 'busy');
        var payload = buildPayload(false);
        payload.id = d.id || '';
        payload.paramValues = collectParamValues($body);
        payload.maxRows = PREVIEW_ROWS;
        Api.report.preview(payload).done(function (data) {
            pvState.result = data;
            pvState.page = 1;
            renderPreviewPaper($body, data);
            showEfficiency($body, data);
        }).fail(function (err) {
            $body.find('#pvInfo').text('');
            $body.find('#pvTableWrap').html('<div class="rpt-pv__empty is-error">预览失败：' +
                esc(err.message) + '</div>');
            UI.message({ type: 'error', message: err.message || '预览失败' });
        }).always(function () {
            setFootBusy($body, false);
        });
    }



    $('#btnPreview').on('click', openPreview);

    /* ==================================================================
       十一、报表清单事件
       ------------------------------------------------------------------
       单击 = 只选中（同步工具栏按钮可用），**不打开、也不切换左侧页签**；
       双击 = 打开这张报表继续编辑（会把左侧切到「数据源」页签）；
       卡片右下角「运行」按钮 = 按关联连接跑查询，结果放进弹窗（不进画布）。
       以前是「单击就切到数据源 + 换掉画布」，手一抖就把没保存的画布顶掉，所以整体降级成双击。
       ================================================================== */

    function selectListItem($item) {
        var id = $item.attr('data-id');
        state.selectedId = id;
        $list.find('.rpt-item').removeClass('is-selected');
        $item.addClass('is-selected');
        syncToolbar();
        return id;
    }

    /** 打开继续编辑（双击 / 键盘 Enter）：同一张且没有未保存修改时只提示，不重复加载 */
    function editListItem($item) {
        var id = selectListItem($item);
        var row = state.rows[String(id)];
        /* 停用的报表不进设计：双击 / Enter 只提醒，不切「数据源」页签、不动画布 */
        if (row && !boolOf(row.enabled)) {
            UI.message({
                type: 'warning',
                message: '「' + esc(row.reportName || row.code) + '」已停用，需先「启用」后才能设计'
            });
            return;
        }
        setLeftTab('source');                      // 进编辑视图 = 切到「数据源」，方便继续拖字段
        if (String(id) === String(state.design.id) && !state.dirty) {
            setStatus('正在编辑「' + state.design.reportName + '」，改完点「保存」');
            return;
        }
        openReport(id);
    }

    function isRunBtn(e) {
        return $(e.target).closest('.rpt-item__run').length > 0;
    }

    $list.on('click', '.rpt-item', function (e) {
        if (isRunBtn(e)) { return; }               // 运行按钮有自己的处理，选中也在那里做
        selectListItem($(this));                   // 单击只选中，不切页签、不动画布
    });

    $list.on('dblclick', '.rpt-item', function (e) {
        if (isRunBtn(e)) { return; }
        e.preventDefault();
        editListItem($(this));
    });

    $list.on('keydown', '.rpt-item', function (e) {
        if (e.target !== this) { return; }         // 焦点在里面的按钮上时交给按钮自己
        if (e.keyCode === 13) {                    // Enter = 双击（打开继续编辑）
            e.preventDefault();
            editListItem($(this));
        }
    });

    $list.on('click', '.rpt-item__run', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openRunViewer(selectListItem($(this).closest('.rpt-item')));
    });

    $pager.on('click', '.rpt-pager__btn', function () {
        var dir = $(this).attr('data-page');
        if (dir === 'prev' && state.pageNum > 1) { state.pageNum--; }
        else if (dir === 'next' && state.pageNum < state.pages) { state.pageNum++; }
        else { return; }
        loadReports();
    });

    $('#btnSearch').on('click', function () {
        state.keyword = textOf($('#rpKeyword').val());
        state.category = $('#rpCategoryFilter').val() || '';
        state.enabled = $('#rpEnabled').val() || '';
        state.pageNum = 1;
        loadReports();
    });
    $('#btnReset').on('click', function () {
        state.keyword = ''; state.category = ''; state.enabled = ''; state.pageNum = 1;
        $('#rpKeyword').val('');
        $('#rpEnabled').val('');
        $('#rpCategoryFilter').val('');
        loadReports();
    });
    $('#rpKeyword').on('keydown', function (e) {
        if (e.keyCode === 13) { $('#btnSearch').trigger('click'); }
    });
    $('#rpEnabled').on('change', function () { $('#btnSearch').trigger('click'); });
    $('#rpCategoryFilter').on('change', function () { $('#btnSearch').trigger('click'); });
    $('#btnRefresh').on('click', function () { loadReports(); });

    $('#btnCopy').on('click', function () {
        var row = selectedRow();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条报表' }); return; }
        UI.confirm({
            title: '复制报表', type: 'info',
            message: '以「' + row.reportName + '」为模板复制一张新报表（新编码自动生成，默认停用）。',
            confirmText: '复制', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.report.copy(row.id).done(function (data) {
                UI.message({ type: 'success', message: data.message || '复制成功' });
                loadReports();
            }).fail(function (err) {
                UI.message({ type: 'error', message: err.message || '复制失败' });
            });
        });
    });

    function toggleEnabled(on) {
        var row = selectedRow();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条报表' }); return; }
        if (boolOf(row.enabled) === on) {
            UI.message({ type: 'info', message: on ? '该报表已经是启用状态' : '该报表已经是停用状态' });
            return;
        }
        Api.report.setEnabled(row.id, on).done(function (data) {
            UI.message({ type: 'success', message: data.message || '已更新' });
            if (state.design.id === row.id) { state.design.enabled = on ? 1 : 0; markClean(); }
            loadReports();
        }).fail(function (err) {
            UI.message({ type: 'error', message: err.message || '操作失败' });
        });
    }
    $('#btnEnable').on('click', function () { toggleEnabled(true); });
    $('#btnDisable').on('click', function () { toggleEnabled(false); });

    $('#btnDelete').on('click', function () {
        var row = selectedRow();
        if (!row) { UI.message({ type: 'warning', message: '请先选择一条报表' }); return; }
        UI.confirm({
            title: '删除报表', type: 'warning',
            message: '确定删除报表「' + row.reportName + '」（' + row.code + '）吗？删除后不可恢复。',
            confirmText: '确定删除', cancelText: '取消'
        }).done(function (ok) {
            if (!ok) { return; }
            Api.report.remove(row.id).done(function () {
                UI.message({ type: 'success', message: '已删除报表「' + row.reportName + '」' });
                if (state.design.id === row.id) { doNew(); }
                state.selectedId = '';
                loadReports();
            }).fail(function (err) {
                UI.message({ type: 'error', message: err.message || '删除失败' });
            });
        });
    });

    /* ==================================================================
       十二、快捷键 / 布局 / 初始化
       ================================================================== */
    $(document).on('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.keyCode === 83) {        // Ctrl + S 保存
            e.preventDefault();
            doSave(false);
        } else if ((e.ctrlKey || e.metaKey) && e.keyCode === 13) { // Ctrl + Enter 预览
            e.preventDefault();
            openPreview();
        }
    });

    /* 内嵌 iframe 里 media query 看的是自身视口宽度，三栏挤不下时按容器宽度改成上下堆叠 */
    function autoLayout() {
        var $layout = $('#rptLayout');
        if (!$layout.length) { return; }
        var width = $layout.width() || 0;
        $('.rpt-page').toggleClass('is-stacked', width > 0 && width < 1080);
    }
    $(window).on('resize', autoLayout);

    function boot() {
        /* 把设计器自己的「画布组件 / 状态栏 / 清单刷新」交给共享查看窗模块 */
        RV.pv = pv;
        pv.elements = elements;
        pv.state = state;
        pv.onStatus = setStatus;
        pv.onRan = loadReports;
        pv.onDirty = markDirty;
        renderCanvas();
        renderColForm();
        renderParams();
        renderElemForm();
        renderToolList();
        fillTemplateForm();
        syncHeadForm();
        markClean();
        autoLayout();
        moveBar($('#rptLeftNav'), $('#rptLeftBar'));
        moveBar($('#rptPropNav'), $('#rptPropBar'));
        loadReports();
        loadConns('');
    }

    /* 调试 / 自动化测试入口（不参与页面交互） */
    window.RptDesigner = {
        state: state,
        setLeftTab: setLeftTab,
        setPropTab: setPropTab,
        addField: addField,
        expandTable: expandTable,
        removeColumn: removeColumn,
        moveColumn: moveColumn,
        columns: function () { return state.design.columns; },
        params: function () { return state.design.params; },
        template: function () { return state.design.template; },
        design: function () { return state.design.design; },
        save: doSave,
        preview: openPreview,
        runReport: openRunViewer,
        openReport: openReport,
        newReport: doNew,
        loadReports: loadReports,
        loadConns: loadConns,
        renderCanvas: renderCanvas,
        syncHeadForm: syncHeadForm,
        sqlSelectAliases: sqlSelectAliases,
        sqlAliasOf: sqlAliasOf,
        sqlTokensOf: sqlTokensOf,
        /* 工具箱组件 */
        elements: function () { return elements(); },
        addElement: addElement,
        removeSelectedElement: removeSelectedElement,
        moveElementLayer: moveElementLayer,
        elementHtml: elementHtml,
        chartPoints: chartPoints,
        selectElement: function (id) {
            state.selectedElem = id;
            renderCanvas();
            renderElemForm();
            renderToolList();
        },
        /* 打印 / 导出（供自动化测试与「外部页面调用」复用） */
        buildPrintHtml: buildPrintHtml,
        printCss: printCss,
        paperMm: paperMm,
        elementBounds: elementBounds,
        stageScale: stageScale,
        printReport: printReport,
        exportReport: exportReport,
        fetchAllResult: fetchAllResult
    };

    boot();
});
