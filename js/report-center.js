/* ==========================================================================
   report-center.js —— 数据中心 · 报表中心
   --------------------------------------------------------------------------
   页面分上下两块：
     · 上部：检索（关键词 / 分类 + 查询 / 重置）——**只查启用状态的报表**，
       后端 /api/report/center 会强制 enabled=1，前端也不提供状态下拉；
     · 下部：卡片列表（名称 / 编码 / 分类 / 说明 / 数据源 / 列数参数数 / 调用次数）+ 分页。
   卡片上**双击**才用共享的 js/report-viewer.js 打开查看窗（单击无反应，防误操作；键盘 Enter / 空格可开）；
   查看窗默认最大化，纸张宽度随弹窗自适应（打印仍按原始纸张 mm 尺寸，不受影响）。
   与报表设计器里双击清单的运行窗是同一套 DOM 与渲染 / 排版 / 打印逻辑。
   ========================================================================== */
jQuery(function ($) {
    'use strict';

    var state = {
        keyword: '', category: '',
        pageNum: 1, pageSize: 12, total: 0, pages: 1,
        rows: []
    };
    var pager = null;
    var loading = false;

    var $grid = $('#rcGrid');
    var $empty = $('#rcEmpty');
    var $total = $('#rcTotal');
    var $pager = $('#rcPager');
    var $kw = $('#rcKeyword');
    var $category = $('#rcCategory');

    function esc(text) {
        return UI.escapeHtml(text === undefined || text === null ? '' : String(text));
    }
    function textOf(v) {
        return v === undefined || v === null ? '' : String(v).replace(/^\s+|\s+$/g, '');
    }
    function intOf(v, def) {
        var n = parseInt(v, 10);
        return isNaN(n) ? def : n;
    }

    /* ---------------- 分类下拉（只含启用报表的分类） ---------------- */
    function renderCategories(cats) {
        var list = cats || [], found = false, html = '<option value="">全部分类</option>', i;
        for (i = 0; i < list.length; i++) {
            if (String(list[i].value) === String(state.category)) { found = true; }
        }
        if (state.category && !found) {
            state.category = '';          // 选中的分类因报表停用而消失 → 退回「全部分类」
        }
        for (i = 0; i < list.length; i++) {
            html += '<option value="' + esc(list[i].value) + '">' +
                esc(list[i].value) + '（' + intOf(list[i].count, 0) + '）</option>';
        }
        $category.html(html).val(state.category);
    }

    /* ---------------- 卡片 ---------------- */
    function metaHtml(label, value, title) {
        return '<span class="rc-card__meta-item" title="' + esc(title || (label + '：' + value)) + '">' +
            '<i class="rc-card__meta-label">' + esc(label) + '</i>' +
            '<b class="rc-card__meta-value">' + esc(value) + '</b></span>';
    }

    function cardHtml(r) {
        var desc = textOf(r.description);
        var paper = textOf(r.paperText);
        var counts = intOf(r.columnCount, 0) + ' 列 · ' + intOf(r.paramCount, 0) + ' 参数';
        return '' +
            '<article class="rc-card" data-id="' + esc(r.id) + '" data-code="' + esc(r.code) + '"' +
            ' tabindex="0" role="button" title="双击打开报表 ' + esc(r.reportName) + '"' +
            ' aria-label="双击打开报表 ' + esc(r.reportName) + '">' +
                '<div class="rc-card__head">' +
                    '<h3 class="rc-card__name" title="' + esc(r.reportName) + '">' + esc(r.reportName) + '</h3>' +
                    '<span class="el-tag el-tag--info rc-card__code" title="报表编码">' + esc(r.code) + '</span>' +
                '</div>' +
                '<div class="rc-card__tags">' +
                    '<span class="el-tag el-tag--success">启用</span>' +
                    '<span class="el-tag">' + esc(r.category || '未分类') + '</span>' +
                    (paper ? '<span class="el-tag el-tag--warning">' + esc(paper) + '</span>' : '') +
                    (r.ispublic ? '<span class="el-tag el-tag--warning" title="创建人把这张报表设为了公开">公共</span>' : '') +
                '</div>' +
                '<p class="rc-card__desc">' +
                    (desc ? esc(desc) : '<span class="rc-card__nodesc">这张报表还没有功能介绍</span>') +
                '</p>' +
                '<div class="rc-card__meta">' +
                    metaHtml('数据源', r.connName || '—') +
                    metaHtml('字段', counts) +
                    metaHtml('调用', intOf(r.runCount, 0) + ' 次') +
                '</div>' +
                '<div class="rc-card__foot">' +
                    '<span class="rc-card__time">' +
                        (r.lastRunTime ? '最近运行 ' + esc(r.lastRunTime) : '尚未运行') +
                    '</span>' +
                    '<span class="rc-card__go">双击查看' +
                        '<svg class="svg-ico" viewBox="0 0 24 24" aria-hidden="true">' +
                        '<path fill="currentColor" d="M9 6l6 6-6 6"/></svg>' +
                    '</span>' +
                '</div>' +
            '</article>';
    }

    function renderRows() {
        var html = '', i;
        for (i = 0; i < state.rows.length; i++) { html += cardHtml(state.rows[i]); }
        $grid.html(html);
        var none = state.rows.length === 0;
        $grid.prop('hidden', none);
        $empty.prop('hidden', !none);
        if (none) {
            $empty.find('.rc-empty__title').text(
                (state.keyword || state.category) ? '没有匹配的报表' : '还没有已启用的报表');
            $empty.find('.rc-empty__hint').text(
                (state.keyword || state.category)
                    ? '换一个关键词或分类再试试；停用的报表不会出现在这里。'
                    : '到「报表设计」里新建报表并启用后，就会出现在报表中心。');
        }
    }

    function renderPager() {
        if (state.total <= 0) { $pager.empty().prop('hidden', true); return; }
        $pager.prop('hidden', false);
        pager = UI.pagination($pager, {
            total: state.total, pageNum: state.pageNum, pageSize: state.pageSize,
            sizes: [12, 24, 48],
            onChange: function (pageNum, pageSize) {
                state.pageNum = pageNum;
                state.pageSize = pageSize;
                load();
            }
        });
    }

    /* ---------------- 查询 ---------------- */
    function load() {
        if (loading) { return; }
        loading = true;
        $grid.addClass('is-loading');
        Api.report.center({
            keyword: state.keyword,
            category: state.category,
            pageNum: state.pageNum,
            pageSize: state.pageSize
        }).done(function (data) {
            state.rows = data.list || [];
            state.total = intOf(data.total, 0);
            state.pages = intOf(data.pages, 1);
            state.pageNum = intOf(data.pageNum, 1);
            state.pageSize = intOf(data.pageSize, state.pageSize);
            $total.text(state.total);
            renderCategories(data.categories || []);
            renderRows();
            renderPager();
        }).fail(function (err) {
            state.rows = [];
            state.total = 0;
            renderRows();
            renderPager();
            $total.text('0');
            UI.message({ type: 'error', message: (err && err.message) || '报表加载失败' });
        }).always(function () {
            loading = false;
            $grid.removeClass('is-loading');
        });
    }

    function search() {
        state.keyword = textOf($kw.val());
        state.category = textOf($category.val());
        state.pageNum = 1;
        load();
    }

    /* ---------------- 事件 ---------------- */
    $('#btnRcSearch').on('click', search);
    $('#btnRcReset').on('click', function () {
        $kw.val('');
        state.keyword = '';
        state.category = '';
        state.pageNum = 1;
        load();
        $kw.trigger('focus');
    });
    $kw.on('keydown', function (e) {
        if (e.keyCode === 13) { e.preventDefault(); search(); }
    });
    $category.on('change', search);

    function openCard($card) {
        var id = $card.attr('data-id');
        if (!id) { return; }
        if (!window.ReportViewer || !window.ReportViewer.openSaved) {
            UI.message({ type: 'error', message: '查看窗模块没有加载，请刷新页面重试' });
            return;
        }
        window.ReportViewer.openSaved(id);
    }

    /* **双击**才打开查看窗（单击什么都不做）：卡片是整块热区，顺手点一下就可能把报表窗口弹出来，
       属于误操作；键盘用户仍用 Enter / 空格（一次即开，按键本身是明确意图）。 */
    $grid.on('dblclick', '.rc-card', function () { openCard($(this)); });
    $grid.on('keydown', '.rc-card', function (e) {
        if (e.keyCode === 13 || e.keyCode === 32) {      // Enter / 空格
            e.preventDefault();
            openCard($(this));
        }
    });

    /* 调试 / 自动化测试入口 */
    window.ReportCenter = {
        state: state,
        load: load,
        search: search,
        openCard: openCard,
        cards: function () { return $grid.find('.rc-card'); }
    };

    load();
});
