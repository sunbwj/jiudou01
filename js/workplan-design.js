/* ==========================================================================
   workplan-design.js —— 工作计划（甘特图 / 日历图 / 网格列表 三种风格）
   --------------------------------------------------------------------------
   参照 Microsoft Visio 甘特图：
     · 任务条 / 里程碑（工期 0 菱形）/ 摘要任务（汇总条 + 两端三角）；
     · 主要 / 次要时间单位双层刻度（日 / 周 / 月），非工作日灰底、今日红线；
     · 完成百分比（任务条内深色填充）、前置依赖箭头（跨行 SVG）；
     · 画布拖动改期（整体平移 / 左右把手改起止）、缩进升级、任务属性对话框；
     · 一次「保存」把 plan + tasks[] 整图提交（后端事务内全量替换任务）。
   三种展示风格（共用同一份 state.tasks，切换不丢数据）：
     gantt 甘特图（可拖拽） / calendar 日历图（按月历铺任务） / grid 网格列表（全字段表格）。
   执行记录：完成状态 / 实际开始 / 实际结束 / 说明 + 关联工单，任务属性可编辑，
     「我的任务」工单回填后 detail() 会 JOIN 回来。
   URL 带 taskId 时（我的任务「打开任务」跳来）自动选中并定位到该任务。
   不引第三方图表库，纯 ES5 + jQuery + 内联 SVG。
   ========================================================================== */
jQuery(function ($) {
    var ROW_H = 34, AXIS_H = 48, LABEL_W = 280;
    var DAY_W = { day: 32, week: 9, month: 2.4 };
    var KINDS = { task: '任务', milestone: '里程碑', summary: '摘要任务' };
    var VIEWS = { gantt: '甘特图', calendar: '日历图', grid: '网格列表' };
    var VIEW_HINT = {
        gantt: '拖动任务条改期，双击行编辑任务属性',
        calendar: '按日期查看任务分布，点任务块可选中',
        grid: '集中查看执行记录与关联工单，双击行编辑'
    };
    var VIEW_KEY = 'menu_admin_workplan_view_v1';
    var EXEC_CLS = {
        '未开始': 'is-none', '进行中': 'is-doing', '已完成': 'is-done',
        '已延期': 'is-late', '已取消': 'is-cancel'
    };
    var state = {
        id: '', plan: {}, tasks: [], selectedId: '', dirty: false,
        scale: 'week', dayW: DAY_W.week, units: [], range: null, drag: null,
        view: 'grid', focusTaskId: ''          // 默认网格列表（可在右上角切换三视图）
    };

    function esc(t) { return UI.escapeHtml(t == null ? '' : t); }
    function execOf(t) { return t.execStatus || '未开始'; }
    function execCls(t) { return EXEC_CLS[execOf(t)] || 'is-none'; }
    function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function go(url) {
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    }
    function uuid4() {
        function h(n) {
            var s = '', i;
            for (i = 0; i < n; i++) { s += Math.floor(Math.random() * 16).toString(16); }
            return s;
        }
        return h(8) + '-' + h(4) + '-4' + h(3) + '-' +
            (8 + Math.floor(Math.random() * 4)).toString(16) + h(3) + '-' + h(12);
    }
    /* ---------------- 日期工具（统一用 UTC 天序号，避开时区 / 夏令时） ---------------- */
    function dayNum(s) {
        var m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
        if (!m) { return null; }
        return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
    }
    function fmtDay(n) {
        var d = new Date(n * 86400000);
        return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) +
            '-' + ('0' + d.getUTCDate()).slice(-2);
    }
    function today() {
        var d = new Date();
        return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) +
            '-' + ('0' + d.getDate()).slice(-2);
    }
    function addDays(s, n) { var v = dayNum(s); return fmtDay((v === null ? dayNum(today()) : v) + n); }
    function duration(t) {
        var a = dayNum(t.startDate), b = dayNum(t.endDate);
        if (a === null || b === null) { return 0; }
        return (t.taskType === 'milestone') ? 0 : Math.max(0, b - a + 1);
    }
    function taskById(id) {
        for (var i = 0; i < state.tasks.length; i++) {
            if (String(state.tasks[i].id) === String(id)) { return state.tasks[i]; }
        }
        return null;
    }
    function selected() { return taskById(state.selectedId); }
    function markDirty(on) {
        state.dirty = on !== false;
        $('#wpDState').text(state.dirty ? '已修改（未保存）' : '已保存');
    }
    function setStatus(text) {
        var on = text === '已启动';
        $('#wpDStatus').text(on ? '已启动' : '未启动')
            .removeClass('is-off is-on').addClass(on ? 'is-on' : 'is-off');
    }
    function renumber() {
        for (var i = 0; i < state.tasks.length; i++) { state.tasks[i].sortNo = i; }
    }

    /* ---------------- 时间刻度 ---------------- */
    function buildScale() {
        var lo = dayNum(state.plan.startDate), hi = dayNum(state.plan.endDate), i;
        for (i = 0; i < state.tasks.length; i++) {
            var a = dayNum(state.tasks[i].startDate), b = dayNum(state.tasks[i].endDate);
            if (a !== null) { lo = (lo === null) ? a : Math.min(lo, a); }
            if (b !== null) { hi = (hi === null) ? b : Math.max(hi, b); }
        }
        if (lo === null) { lo = dayNum(today()); }
        if (hi === null || hi < lo) { hi = lo + 30; }
        /* 前后各留 2 天，且最少 14 天，避免任务条贴边 */
        lo -= 2; hi += 2;
        if (hi - lo < 14) { hi = lo + 14; }
        state.scale = state.plan.scale || 'week';
        if (!DAY_W[state.scale]) { state.scale = 'week'; }
        state.dayW = DAY_W[state.scale];
        state.range = { start: lo, end: hi, days: hi - lo + 1 };
        state.units = buildUnits(lo, hi, state.scale);
    }
    function buildUnits(lo, hi, mode) {
        var out = [], cur = lo;
        while (cur <= hi) {
            var d = new Date(cur * 86400000), span, label, major, weekend = false;
            if (mode === 'day') {
                span = 1; label = String(d.getUTCDate());
                major = d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月';
                weekend = (d.getUTCDay() === 0 || d.getUTCDay() === 6);
            } else if (mode === 'week') {
                var dow = d.getUTCDay(), toMon = (dow + 6) % 7;
                span = Math.min(7 - toMon, hi - cur + 1);
                label = (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
                major = d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月';
            } else {
                var y = d.getUTCFullYear(), m = d.getUTCMonth();
                var last = Date.UTC(y, m + 1, 0) / 86400000;
                span = Math.min(last - cur + 1, hi - cur + 1);
                label = (m + 1) + '月';
                major = y + '年';
            }
            out.push({ start: cur, span: span, label: label, major: major,
                       weekend: weekend, left: (cur - lo) * DAY_W[mode], width: span * DAY_W[mode] });
            cur += span;
        }
        return out;
    }
    function majorUnits() {
        var out = [], i, last = null;
        for (i = 0; i < state.units.length; i++) {
            var u = state.units[i];
            if (last && last.major === u.major) {
                last.width += u.width; last.span += u.span;
            } else {
                last = { major: u.major, left: u.left, width: u.width, span: u.span };
                out.push(last);
            }
        }
        return out;
    }
    function totalWidth() { return state.range.days * state.dayW; }
    function barGeom(t) {
        var a = dayNum(t.startDate), b = dayNum(t.endDate), lo = state.range.start;
        if (a === null) { a = lo; }
        if (b === null || b < a) { b = a; }
        var left = (a - lo) * state.dayW;
        if (t.taskType === 'milestone') {
            return { left: left + state.dayW / 2 - 8, width: 16 };
        }
        return { left: left, width: Math.max(state.dayW, (b - a + 1) * state.dayW) };
    }

    /* ---------------- 渲染画布 ---------------- */
    function axisHtml() {
        var tw = totalWidth(), majors = majorUnits(), i, html = '';
        html += '<div class="wp-axis"><div class="wp-axis__label">任务名称 / 责任人</div>' +
            '<div class="wp-axis__scale" style="width:' + tw + 'px">' +
            '<div class="wp-axis__major">';
        for (i = 0; i < majors.length; i++) {
            html += '<span class="wp-u wp-u--major" style="left:' + majors[i].left +
                'px;width:' + majors[i].width + 'px">' + esc(majors[i].major) + '</span>';
        }
        html += '</div><div class="wp-axis__minor">';
        for (i = 0; i < state.units.length; i++) {
            var u = state.units[i];
            html += '<span class="wp-u wp-u--minor' + (u.weekend ? ' is-weekend' : '') +
                '" style="left:' + u.left + 'px;width:' + u.width + 'px">' + esc(u.label) + '</span>';
        }
        html += '</div></div></div>';
        return html;
    }
    function offBlocksHtml() {
        if (!$('#wpDWeekend').prop('checked')) { return ''; }
        var html = '', n, lo = state.range.start, hi = state.range.end;
        for (n = lo; n <= hi; n++) {
            var d = new Date(n * 86400000), dow = d.getUTCDay();
            if (dow === 0 || dow === 6) {
                html += '<span class="wp-off" style="left:' + ((n - lo) * state.dayW) +
                    'px;width:' + state.dayW + 'px"></span>';
            }
        }
        return html;
    }
    function todayHtml() {
        var n = dayNum(today()), lo = state.range.start;
        if (n < lo || n > state.range.end) { return ''; }
        return '<span class="wp-today" style="left:' + ((n - lo) * state.dayW) + 'px"></span>';
    }
    function barHtml(t, geom) {
        var kind = t.taskType || 'task';
        var cls = 'wp-bar' + (kind === 'summary' ? ' wp-bar--summary' : '') +
            (kind === 'milestone' ? ' wp-bar--milestone' : '') +
            ' wp-exec-' + execCls(t) +
            ((parseInt(t.progress, 10) || 0) >= 100 ? ' is-done' : '') +
            (String(t.id) === String(state.selectedId) ? ' is-selected' : '');
        var pct = Math.min(100, Math.max(0, parseInt(t.progress, 10) || 0));
        var style = 'left:' + geom.left + 'px;width:' + geom.width + 'px';
        if (t.color) { style += ';background:' + esc(t.color); }
        var html = '<div class="' + cls + '" data-id="' + esc(t.id) + '" style="' + style +
            '" title="' + esc(t.taskName) + '：' + esc(t.startDate) + ' ~ ' + esc(t.endDate) +
            '（' + pct + '% / ' + esc(execOf(t)) + '）' +
            (t.orderCode ? ' / 工单 ' + esc(t.orderCode) : '') + '">';
        if (kind === 'task') {
            html += '<span class="wp-bar__fill" style="width:' + pct + '%"></span>';
            html += '<span class="wp-bar__text">' + esc(t.taskName) + ' ' + pct + '%</span>';
            html += '<span class="wp-bar__handle wp-bar__handle--l"></span>' +
                '<span class="wp-bar__handle wp-bar__handle--r"></span>';
        } else if (kind === 'summary') {
            html += '<span class="wp-bar__text">' + esc(t.taskName) + '</span>';
        }
        return html + '</div>';
    }
    function linksHtml() {
        var html = '<svg class="wp-links" width="' + (LABEL_W + totalWidth()) + '" height="' +
            (AXIS_H + state.tasks.length * ROW_H) + '" xmlns="http://www.w3.org/2000/svg">' +
            '<defs><marker id="wpArrow" markerWidth="7" markerHeight="7" refX="6" refY="3" ' +
            'orient="auto"><path d="M0,0 L6,3 L0,6 z" style="fill:#909399;stroke:none" /></marker></defs>';
        var i, j;
        for (i = 0; i < state.tasks.length; i++) {
            var cur = state.tasks[i];
            if (!cur.preTaskIds) { continue; }
            var pres = String(cur.preTaskIds).split(','), cg = barGeom(cur);
            for (j = 0; j < pres.length; j++) {
                var pre = taskById(pres[j]);
                if (!pre) { continue; }
                var pi = state.tasks.indexOf(pre), pg = barGeom(pre);
                var x1 = LABEL_W + pg.left + pg.width, y1 = AXIS_H + pi * ROW_H + ROW_H / 2;
                var x2 = LABEL_W + cg.left, y2 = AXIS_H + i * ROW_H + ROW_H / 2;
                var mid = x1 + 8;
                var path = 'M' + x1 + ',' + y1 + ' H' + mid + ' V' + y2 + ' H' + (x2 - 3);
                if (x2 <= x1 + 14) {
                    mid = x1 + 10;
                    path = 'M' + x1 + ',' + y1 + ' H' + mid + ' V' + (y2 - 10) +
                        ' H' + (x2 - 10) + ' V' + y2 + ' H' + (x2 - 3);
                }
                html += '<path d="' + path + '" marker-end="url(#wpArrow)"></path>';
            }
        }
        return html + '</svg>';
    }
    function renderGantt() {
        buildScale();
        var tw = totalWidth(), i, html = axisHtml() + '<div class="wp-rows">';
        if (!state.tasks.length) {
            html += '<div class="wp-empty">还没有任务，点上方「＋ 任务」「◇ 里程碑」或「▬ 摘要任务」开始画图。</div>';
        }
        var offs = offBlocksHtml(), todayLine = todayHtml();
        for (i = 0; i < state.tasks.length; i++) {
            var t = state.tasks[i], kind = t.taskType || 'task';
            var level = indentLevel(t);
            var partCount = splitPeople(t.participantIds).length;
            html += '<div class="wp-row' + (String(t.id) === String(state.selectedId) ? ' is-selected' : '') +
                '" data-id="' + esc(t.id) + '">' +
                '<div class="wp-row__label" style="padding-left:' + (6 + level * 14) + 'px">' +
                '<span class="wp-row__no">' + (i + 1) + '</span>' +
                '<span class="wp-row__kind' + (kind === 'milestone' ? ' is-milestone' : '') +
                (kind === 'summary' ? ' is-summary' : '') + '">' +
                (kind === 'task' ? 'T' : kind === 'milestone' ? '' : 'S') + '</span>' +
                '<input class="wp-row__name" data-id="' + esc(t.id) + '" value="' + esc(t.taskName) +
                '" title="双击本行编辑任务属性">' +
                '<span class="wp-row__owner" title="' +
                    esc('责任人：' + (t.ownerName || '未指定') +
                        '；参与人员：' + (t.participantNames || '无')) + '">' +
                    esc(t.ownerName || '') +
                    (partCount ? ' <i style="font-style:normal;color:#909399">+' + partCount + '</i>' : '') +
                '</span>' +
                (parseInt(t.execCount, 10) > 0
                    ? '<span class="wp-exec-link wp-row__exec" data-exec-task="' + esc(t.id) +
                        '" title="执行记录 ' + parseInt(t.execCount, 10) + ' 条，点击查看附件">📎' +
                        parseInt(t.execCount, 10) + '</span>'
                    : '') +
                '</div>' +
                '<div class="wp-row__track" data-id="' + esc(t.id) + '" style="width:' + tw +
                'px;--wp-unit-w:' + (state.scale === 'day' ? state.dayW :
                    (state.scale === 'week' ? state.dayW * 7 : state.dayW * 30)) + 'px">' +
                offs + todayLine + barHtml(t, barGeom(t)) + '</div></div>';
        }
        html += '</div>' + linksHtml();
        $('#wpDCanvas').html(html).css('width', LABEL_W + tw + 'px');
    }
    /* ---------------- 视图二 / 三：日历图、网格列表 ---------------- */
    function monthRange() {
        var lo = dayNum(state.plan.startDate), hi = dayNum(state.plan.endDate), i;
        for (i = 0; i < state.tasks.length; i++) {
            var a = dayNum(state.tasks[i].startDate), b = dayNum(state.tasks[i].endDate);
            if (a !== null) { lo = (lo === null) ? a : Math.min(lo, a); }
            if (b !== null) { hi = (hi === null) ? b : Math.max(hi, b); }
        }
        if (lo === null) { lo = dayNum(today()); }
        if (hi === null || hi < lo) { hi = lo + 30; }
        var first = new Date(lo * 86400000), last = new Date(hi * 86400000);
        var y = first.getUTCFullYear(), m = first.getUTCMonth();
        var ey = last.getUTCFullYear(), em = last.getUTCMonth();
        var months = [], guard = 0;
        while ((y < ey || (y === ey && m <= em)) && guard++ < 12) {
            months.push({ year: y, month: m });
            m++;
            if (m > 11) { m = 0; y++; }
        }
        return months.length ? months : [{ year: y, month: m }];
    }
    function renderCalendar() {
        var byDay = {}, i, j, k, q;
        for (i = 0; i < state.tasks.length; i++) {
            var t = state.tasks[i], a = dayNum(t.startDate), b = dayNum(t.endDate);
            if (a === null) { continue; }
            if (b === null || b < a) { b = a; }
            if (b - a > 366) { b = a + 366; }        // 异常跨度防御，避免渲染爆炸
            for (j = a; j <= b; j++) {
                if (!byDay[j]) { byDay[j] = []; }
                byDay[j].push(t);
            }
        }
        var months = monthRange(), todayNum = dayNum(today());
        var wd = ['一', '二', '三', '四', '五', '六', '日'], html = '';
        for (k = 0; k < months.length; k++) {
            var mo = months[k];
            var first = Date.UTC(mo.year, mo.month, 1) / 86400000;
            var last = Date.UTC(mo.year, mo.month + 1, 0) / 86400000;
            var lead = (new Date(first * 86400000).getUTCDay() + 6) % 7;   // 周一为首列
            html += '<section class="wp-cal" data-month="' + mo.year + '-' + (mo.month + 1) + '">' +
                '<h3 class="wp-cal__title">' + mo.year + ' 年 ' + (mo.month + 1) + ' 月</h3>' +
                '<div class="wp-cal__grid">';
            for (j = 0; j < 7; j++) { html += '<div class="wp-cal__wd">周' + wd[j] + '</div>'; }
            for (j = 0; j < lead; j++) { html += '<div class="wp-cal__cell is-blank"></div>'; }
            for (j = first; j <= last; j++) {
                var dow = new Date(j * 86400000).getUTCDay();
                html += '<div class="wp-cal__cell' +
                    (dow === 0 || dow === 6 ? ' is-weekend' : '') +
                    (j === todayNum ? ' is-today' : '') + '" data-day="' + j + '">' +
                    '<span class="wp-cal__day">' + new Date(j * 86400000).getUTCDate() + '</span>';
                var list = byDay[j] || [];
                for (q = 0; q < list.length && q < 4; q++) {
                    var ct = list[q];
                    html += '<div class="wp-cal__task wp-exec-' + execCls(ct) +
                        (String(ct.id) === String(state.selectedId) ? ' is-selected' : '') +
                        '" data-id="' + esc(ct.id) + '" title="' + esc(ct.taskName) + '（' +
                        esc(execOf(ct)) + '，' + (parseInt(ct.progress, 10) || 0) + '%' +
                        (parseInt(ct.execCount, 10) > 0 ? '，执行记录 ' + ct.execCount + ' 条' : '') + '）">' +
                        (ct.taskType === 'milestone' ? '◆ ' : '') + esc(ct.taskName) +
                        (parseInt(ct.execCount, 10) > 0
                            ? '<span class="wp-cal__exec" data-exec-task="' + esc(ct.id) + '">📎' +
                                parseInt(ct.execCount, 10) + '</span>'
                            : '') + '</div>';
                }
                if (list.length > 4) { html += '<div class="wp-cal__more">+' + (list.length - 4) + ' 条</div>'; }
                html += '</div>';
            }
            html += '</div></section>';
        }
        if (!state.tasks.length) {
            html = '<div class="wp-empty">还没有任务，点上方「＋ 任务」「◇ 里程碑」或「▬ 摘要任务」开始制定。</div>';
        }
        $('#wpDCanvas').html(html).css('width', '100%');
    }
    function renderGrid() {
        var html = '<table class="wp-grid"><thead><tr>' +
            '<th style="width:44px">序号</th><th>任务名称</th><th style="width:78px">类型</th>' +
            '<th style="width:150px">前置任务</th>' +
            '<th style="width:90px">责任人</th><th style="width:100px">参与人员</th>' +
            '<th style="width:168px">计划起止</th><th style="width:82px">完成状态</th>' +
            '<th style="width:168px">实际起止</th><th style="width:66px">完成%</th>' +
            '<th style="width:108px">关联工单</th><th style="width:88px">执行记录</th>' +
            '<th>执行说明</th></tr></thead><tbody>';
        if (!state.tasks.length) {
            html += '<tr><td colspan="13"><div class="wp-empty">还没有任务，点上方按钮开始制定工作计划。</div></td></tr>';
        }
        for (var i = 0; i < state.tasks.length; i++) {
            var t = state.tasks[i], level = indentLevel(t);
            var parts = String(t.participantNames || '').split(',');
            var partText = $.trim(parts.join('、')) || '—';
            var actual = (t.actualStartDate || t.actualEndDate)
                ? (esc(t.actualStartDate || '—') + ' ~ ' + esc(t.actualEndDate || '—')) : '—';
            /* 前置任务：按 preTaskIds 映射成任务名（任务被删则标注） */
            var preNames = [], preIds = String(t.preTaskIds || '').split(','), pi;
            for (pi = 0; pi < preIds.length; pi++) {
                if (!preIds[pi]) { continue; }
                var preTask = taskById(preIds[pi]);
                preNames.push(preTask ? preTask.taskName : '已删除任务');
            }
            var preText = preNames.length ? preNames.join('、') : '—';
            html += '<tr class="wp-grid__row' +
                (String(t.id) === String(state.selectedId) ? ' is-selected' : '') +
                '" data-id="' + esc(t.id) + '">' +
                '<td class="is-center">' + (i + 1) + '</td>' +
                '<td style="padding-left:' + (8 + level * 14) + 'px">' +
                    (t.taskType === 'milestone' ? '◆ ' : t.taskType === 'summary' ? '▬ ' : '') +
                    esc(t.taskName) + '</td>' +
                '<td>' + esc(KINDS[t.taskType] || '任务') + '</td>' +
                '<td title="' + esc(preText) + '">' + esc(preText) + '</td>' +
                '<td>' + esc(t.ownerName || '—') + '</td>' +
                '<td title="' + esc(partText) + '">' + esc(partText) + '</td>' +
                '<td class="is-center">' + esc(t.startDate || '—') + ' ~ ' + esc(t.endDate || '—') + '</td>' +
                '<td class="is-center"><span class="wp-exec-tag wp-exec-' + execCls(t) + '">' +
                    esc(execOf(t)) + '</span></td>' +
                '<td class="is-center">' + actual + '</td>' +
                '<td class="is-center">' + (parseInt(t.progress, 10) || 0) + '%</td>' +
                '<td class="is-center">' + (t.orderCode
                    ? (esc(t.orderCode) + '<span class="wp-grid__order">' + esc(t.orderStatus || '') + '</span>')
                    : '<span class="wp-grid__muted">未启动</span>') + '</td>' +
                '<td class="is-center">' + (parseInt(t.execCount, 10) > 0
                    ? '<a href="javascript:;" class="wp-exec-link" data-exec-task="' + esc(t.id) + '">' +
                        parseInt(t.execCount, 10) + ' 条</a>'
                    : '<span class="wp-exec-muted">—</span>') + '</td>' +
                '<td title="' + esc(t.execRemark || '') + '">' + esc(t.execRemark || '—') + '</td></tr>';
        }
        html += '</tbody></table>';
        $('#wpDCanvas').html(html).css('width', '100%');
    }
    /* 统一入口：三个视图共用同一份 state.tasks，切换不丢数据 */
    function renderCanvas() {
        if (state.view === 'calendar') { renderCalendar(); }
        else if (state.view === 'grid') { renderGrid(); }
        else { renderGantt(); }
        $('#wpDTaskCount').text(state.tasks.length);
        $('#wpDViewInfo').text(VIEWS[state.view] + ' · ' + state.tasks.length + ' 条任务');
        syncToolbar();
    }
    function setView(kind) {
        if (!VIEWS[kind]) { kind = 'gantt'; }
        state.view = kind;
        try { window.localStorage.setItem(VIEW_KEY, kind); } catch (e) { }
        $('#wpDViewBar .el-button').removeClass('is-active')
            .filter('[data-view="' + kind + '"]').addClass('is-active');
        $('#wpDViewHint').text(VIEW_HINT[kind]);
        $('#wpDLegend').toggle(kind === 'gantt');
        $('#wpDCanvas').attr('data-view', kind);
        renderCanvas();
        applyFocus();
    }
    /* 从「我的任务」工单跳来时定位并高亮对应任务 */
    function applyFocus() {
        if (!state.focusTaskId) { return; }
        var $row = $('#wpDCanvas [data-id="' + state.focusTaskId + '"]').first();
        if (!$row.length) { return; }
        state.selectedId = state.focusTaskId;
        paintSelection(); syncToolbar();
        $row.addClass('is-focus');
        try {
            var $scroll = $('#wpDScroll');
            var top = $row.offset().top - $scroll.offset().top + $scroll.scrollTop() - 60;
            $scroll.scrollTop(Math.max(0, top));
        } catch (e) { /* jsdom 里没有布局，忽略 */ }
    }
    function indentLevel(t) {
        var level = 0, cur = t, guard = 0;
        while (cur && cur.parentId && guard++ < 8) {
            var p = taskById(cur.parentId);
            if (!p || p === cur) { break; }
            level++; cur = p;
        }
        return level;
    }
    function paintSelection() {
        $('#wpDCanvas .wp-row, #wpDCanvas .wp-bar, #wpDCanvas .wp-cal__task, ' +
            '#wpDCanvas .wp-grid__row').removeClass('is-selected');
        if (state.selectedId) {
            var sel = '[data-id="' + state.selectedId + '"]';
            $('#wpDCanvas .wp-row' + sel + ', #wpDCanvas .wp-bar' + sel +
                ', #wpDCanvas .wp-cal__task' + sel + ', #wpDCanvas .wp-grid__row' + sel)
                .addClass('is-selected');
        }
    }
    function syncToolbar() {
        var has = !!selected(), i = taskIndex(state.selectedId);
        $('#wpDBtnProp, #wpDBtnLink, #wpDBtnIndent, #wpDBtnOutdent, #wpDBtnUp, #wpDBtnDown, #wpDBtnDelete')
            .prop('disabled', !has);
        if (has) {
            $('#wpDBtnUp').prop('disabled', i <= 0);
            $('#wpDBtnDown').prop('disabled', i < 0 || i >= state.tasks.length - 1);
            $('#wpDBtnIndent').prop('disabled', i <= 0);
        }
        syncPerm();
    }

    /** 计划级权限：非创建人不能删任务 / 不能停止；已启动不能重复启动 */
    function syncPerm() {
        var p = state.plan || {};
        var mine = p.isCreator !== false;
        var started = String(p.status || '') === '已启动';
        var stopped = String(p.status || '') === '已停止';
        state.mine = mine;
        $('#wpDBtnStart').prop('disabled', started || stopped)
            .attr('title', started ? '计划已启动，不能重复启动'
                : (stopped ? '计划已停止' : '启动计划（派发工单并通知责任人与参与人员）'));
        $('#wpDBtnStop').prop('disabled', !mine || !started)
            .attr('title', !mine ? '非本人创建的计划，不能停止'
                : (started ? '停止计划' : '只有已启动的计划可以停止'));
        $('#wpDBtnDelete').prop('disabled', !mine || !selected())
            .attr('title', mine ? '删除任务' : '非本人创建的计划，不能删除任务节点');
    }
    function taskIndex(id) {
        for (var i = 0; i < state.tasks.length; i++) {
            if (String(state.tasks[i].id) === String(id)) { return i; }
        }
        return -1;
    }

    /* ---------------- 顶部表单 ---------------- */
    function fillForm() {
        var p = state.plan || {};
        $('#wpDCode').text(p.planCode || 'WP------');
        $('#wpDName').val(p.planName || '');
        $('#wpDStart').val(p.startDate || '');
        $('#wpDEnd').val(p.endDate || '');
        $('#wpDScale').val(p.scale || 'week');
        $('#wpDWeekend').prop('checked', parseInt(p.skipWeekend, 10) === 1 || p.skipWeekend === true);
        $('#wpDPub').prop('checked', (p.ispub === undefined || p.ispub === null)
            ? true : (parseInt(p.ispub, 10) === 1 || p.ispub === true));
        setStatus(p.status);
        syncPerm();
    }
    function collectPlan() {
        return {
            id: state.id,
            planName: $.trim($('#wpDName').val()),
            startDate: $('#wpDStart').val(),
            endDate: $('#wpDEnd').val(),
            scale: $('#wpDScale').val() || 'week',
            skipWeekend: $('#wpDWeekend').prop('checked') ? 1 : 0,
            ispub: $('#wpDPub').prop('checked') ? 1 : 0,
            projectId: state.plan.projectId || '',
            projectName: state.plan.projectName || '',
            planDesc: state.plan.planDesc || ''
        };
    }

    /* ---------------- 任务增删改 ---------------- */
    function defaultDates(kind) {
        var s = state.plan.startDate || today();
        if (kind === 'milestone') { return { startDate: s, endDate: s }; }
        return { startDate: s, endDate: addDays(s, 4) };
    }
    function splitPeople(s) {
        var raw = String(s == null ? '' : s).split(','), out = [], i;
        for (i = 0; i < raw.length; i++) { if ($.trim(raw[i])) { out.push($.trim(raw[i])); } }
        return out;
    }
    function joinPeople(arr) {
        var out = [], i;
        for (i = 0; i < arr.length; i++) { out.push(String(arr[i])); }
        return out.join(',');
    }
    /* 老数据可能只有自由文本 ownerName（没有 ownerId）；参与人员按 ID / 姓名下标对齐 */
    function peopleOf(t) {
        var ids = splitPeople(t.participantIds), names = splitPeople(t.participantNames), out = [], i;
        for (i = 0; i < ids.length; i++) { out.push({ id: ids[i], name: names[i] || ids[i] }); }
        return out;
    }
    function ownerOf(t) {
        if (!t.ownerName && !parseInt(t.ownerId, 10)) { return []; }
        return [{ id: String(t.ownerId || t.ownerName || ''), name: t.ownerName || '' }];
    }
    function addTask(kind) {
        var d = defaultDates(kind), t = {
            id: uuid4(), taskName: kind === 'milestone' ? '新里程碑' :
                (kind === 'summary' ? '新摘要任务' : '新任务'),
            taskType: kind, parentId: '', startDate: d.startDate, endDate: d.endDate,
            progress: 0, preTaskIds: '', ownerName: '', ownerId: 0,
            participantIds: '', participantNames: '',
            execStatus: '未开始', actualStartDate: '', actualEndDate: '', execRemark: '',
            orderCode: '', orderId: '', orderStatus: '', orderLinked: false,
            sortNo: state.tasks.length, color: ''
        };
        var at = taskIndex(state.selectedId);
        if (at >= 0) { state.tasks.splice(at + 1, 0, t); }
        else { state.tasks.push(t); }
        renumber();
        state.selectedId = t.id;
        renderCanvas(); markDirty();
        return t;
    }
    function removeTask() {
        var t = selected();
        if (!t) { return; }
        if (state.mine === false) {
            UI.message({ type: 'warning', message: '非本人创建的工作计划，不能删除任务节点' });
            return;
        }
        UI.confirm({
            title: '删除任务', type: 'warning',
            message: '确定删除任务「' + t.taskName + '」吗？其它任务对它的前置依赖也会一并清除。',
            confirmText: '确定删除'
        }).done(function (yes) {
            if (!yes) { return; }
            var i, id = String(t.id);
            for (i = 0; i < state.tasks.length; i++) {
                var pres = String(state.tasks[i].preTaskIds || '').split(','), keep = [], j;
                for (j = 0; j < pres.length; j++) { if (pres[j] && pres[j] !== id) { keep.push(pres[j]); } }
                state.tasks[i].preTaskIds = keep.join(',');
                if (String(state.tasks[i].parentId || '') === id) { state.tasks[i].parentId = ''; }
            }
            state.tasks.splice(taskIndex(id), 1);
            renumber(); state.selectedId = '';
            renderCanvas(); markDirty();
        });
    }
    function moveTask(step) {
        var i = taskIndex(state.selectedId), j = i + step;
        if (i < 0 || j < 0 || j >= state.tasks.length) { return; }
        var tmp = state.tasks[i]; state.tasks[i] = state.tasks[j]; state.tasks[j] = tmp;
        renumber(); renderCanvas(); markDirty();
    }
    function indentTask(out) {
        var t = selected(), i = taskIndex(state.selectedId);
        if (!t || i < 0) { return; }
        if (out) {
            var p = taskById(t.parentId);
            t.parentId = p ? (p.parentId || '') : '';
        } else {
            if (i <= 0) { return; }
            var prev = state.tasks[i - 1];
            t.parentId = (prev.taskType === 'summary') ? prev.id : (prev.parentId || prev.id);
        }
        renderCanvas(); markDirty();
    }
    function openProp() {
        var t = selected();
        if (!t) { return; }
        /* 选人结果放在 openProp 闭包里：onReady / onOk 是 UI.dialog 的两个独立回调，
           定义在 onReady 内的局部变量在 onOk 里取不到 */
        var pickedOwner = ownerOf(t), pickedParts = peopleOf(t);
        var pickedPre = String(t.preTaskIds || '').split(',').filter(function (x) { return !!x; });
        UI.dialog({
            title: '任务属性 —— ' + t.taskName,
            width: 660,
            content: $('#wpTaskTpl').html(),
            onReady: function ($body) {
                $body.find('#wpTName').val(t.taskName);
                $body.find('#wpTType').val(t.taskType || 'task');
                $body.find('#wpTStart').val(t.startDate || '');
                $body.find('#wpTEnd').val(t.endDate || '');
                $body.find('#wpTDuration').val(duration(t) + ' 天');
                $body.find('#wpTProgress').val(parseInt(t.progress, 10) || 0);
                $body.find('#wpTProgressText').text((parseInt(t.progress, 10) || 0) + '%');
                /* 责任人 / 参与人员：只显示姓名快照，选中的 id/name 留在 openProp 闭包里 */
                $body.find('#wpTOwner').val(pickedOwner.length ? pickedOwner[0].name : '');
                $body.find('#wpTParts').val(pickedParts.map(function (p) { return p.name; }).join('、'));
                $body.find('#wpTBtnOwner').on('click', function () {
                    if (!window.WpEmpPicker) {
                        UI.message({ type: 'warning', message: '员工选取组件未加载' }); return;
                    }
                    window.WpEmpPicker.open({
                        title: '选取责任人（员工信息表 / 项目组成员）', multiple: false,
                        projectId: state.plan.projectId || '',
                        projectName: state.plan.projectName || '',
                        selected: pickedOwner,
                        onOk: function (list) {
                            pickedOwner = list.slice(0, 1);
                            $body.find('#wpTOwner').val(pickedOwner.length ? pickedOwner[0].name : '');
                        }
                    });
                });
                $body.find('#wpTBtnOwnerClear').on('click', function () {
                    pickedOwner = []; $body.find('#wpTOwner').val('');
                });
                $body.find('#wpTBtnParts').on('click', function () {
                    if (!window.WpEmpPicker) {
                        UI.message({ type: 'warning', message: '员工选取组件未加载' }); return;
                    }
                    window.WpEmpPicker.open({
                        title: '选取参与人员（员工信息表 / 项目组成员）', multiple: true,
                        projectId: state.plan.projectId || '',
                        projectName: state.plan.projectName || '',
                        selected: pickedParts,
                        onOk: function (list) {
                            pickedParts = list.slice(0);
                            $body.find('#wpTParts').val(
                                pickedParts.map(function (p) { return p.name; }).join('、'));
                        }
                    });
                });
                $body.find('#wpTBtnPartsClear').on('click', function () {
                    pickedParts = []; $body.find('#wpTParts').val('');
                });
                var opt = '<option value="">（顶级）</option>', i;
                for (i = 0; i < state.tasks.length; i++) {
                    var p = state.tasks[i];
                    if (String(p.id) === String(t.id)) { continue; }
                    opt += '<option value="' + esc(p.id) + '"' +
                        (String(t.parentId || '') === String(p.id) ? ' selected' : '') + '>' +
                        esc(p.taskName) + '</option>';
                }
                $body.find('#wpTParent').html(opt);
                function refreshPre() {
                    var names = [], j;
                    for (j = 0; j < pickedPre.length; j++) {
                        var q = taskById(pickedPre[j]);
                        if (q) { names.push(q.taskName); }
                    }
                    $body.find('#wpTPre').val(names.join('、'));
                    $body.find('.wp-pre-multi__text').text(names.join('、') || '请选择前置任务');
                    $body.find('#wpTPreMulti').toggleClass('has-value', names.length > 0);
                }
                function renderPreList() {
                    var html = '', j;
                    for (j = 0; j < state.tasks.length; j++) {
                        var q = state.tasks[j];
                        if (String(q.id) === String(t.id)) { continue; }
                        html += '<label class="wp-pre-multi__opt"><input type="checkbox" class="wp-pre-pick" value="' +
                            esc(q.id) + '"' + (pickedPre.indexOf(String(q.id)) >= 0 ? ' checked' : '') + '> ' +
                            esc(q.taskName) + '</label>';
                    }
                    $body.find('#wpTPreList').html(html ||
                        '<div class="wp-pre-multi__empty">暂无其它任务</div>');
                }
                renderPreList();
                refreshPre();
                $body.on('click', '.wp-pre-multi__box', function (e) {
                    e.stopPropagation();
                    var $drop = $body.find('.wp-pre-multi__drop');
                    $drop.prop('hidden', !$drop.prop('hidden'));
                });
                $body.on('click', '.wp-pre-multi__drop', function (e) { e.stopPropagation(); });
                $body.on('change', '.wp-pre-pick', function () {
                    var ids = [];
                    $body.find('.wp-pre-pick:checked').each(function () { ids.push(String($(this).val())); });
                    pickedPre = ids;
                    refreshPre();
                });
                $body.on('click', '#wpTBtnPreClear', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    pickedPre = [];
                    $body.find('.wp-pre-pick').prop('checked', false);
                    refreshPre();
                });
                $(document).off('click.wpPre').on('click.wpPre', function () {
                    $body.find('.wp-pre-multi__drop').prop('hidden', true);
                });
                $body.find('#wpTProgress').on('input', function () {
                    $body.find('#wpTProgressText').text($(this).val() + '%');
                });
                /* 执行记录 + 关联工单（detail() 已按 taskId JOIN 回带） */
                $body.find('#wpTExecStatus').val(execOf(t));
                $body.find('#wpTActualStart').val(t.actualStartDate || '');
                $body.find('#wpTActualEnd').val(t.actualEndDate || '');
                $body.find('#wpTExecRemark').val(t.execRemark || '');
                $body.find('#wpTOrder').val(t.orderCode
                    ? (t.orderCode + '（' + (t.orderStatus || '待处理') + '）') : '');
                $body.find('#wpTBtnOrder').prop('disabled', !t.orderCode).on('click', function () {
                    if (t.orderCode) {
                        go('workplan-task.html?keyword=' + encodeURIComponent(t.orderCode));
                    }
                });
            },
            onOk: function ($body, close) {
                var name = $.trim($body.find('#wpTName').val());
                if (!name) { UI.message({ type: 'warning', message: '任务名称不能为空' }); return; }
                var kind = $body.find('#wpTType').val() || 'task';
                var s = $body.find('#wpTStart').val(), e = $body.find('#wpTEnd').val();
                if (!s) { s = t.startDate || today(); }
                if (!e || kind === 'milestone') { e = s; }
                if (s > e) { UI.message({ type: 'warning', message: '开始日期不能晚于结束日期' }); return; }
                var aStart = $body.find('#wpTActualStart').val() || '';
                var aEnd = $body.find('#wpTActualEnd').val() || '';
                if (aStart && aEnd && aStart > aEnd) {
                    UI.message({ type: 'warning', message: '实际开始时间不能晚于实际结束时间' }); return;
                }
                t.taskName = name; t.taskType = kind;
                t.startDate = s; t.endDate = e;
                t.progress = parseInt($body.find('#wpTProgress').val(), 10) || 0;
                t.execStatus = $body.find('#wpTExecStatus').val() || '未开始';
                t.actualStartDate = aStart; t.actualEndDate = aEnd;
                t.execRemark = $.trim($body.find('#wpTExecRemark').val()).slice(0, 1000);
                if (t.execStatus === '已完成') { t.progress = 100; }
                t.ownerName = pickedOwner.length ? String(pickedOwner[0].name || '').slice(0, 50) : '';
                t.ownerId = pickedOwner.length ? (parseInt(pickedOwner[0].id, 10) || 0) : 0;
                t.participantIds = joinPeople(pickedParts.map(function (p) { return p.id; }));
                t.participantNames = joinPeople(pickedParts.map(function (p) { return p.name; }));
                t.parentId = $body.find('#wpTParent').val() || '';
                if (String(t.parentId) === String(t.id)) { t.parentId = ''; }
                t.preTaskIds = pickedPre.join(',');
                close(); renderCanvas(); markDirty();
            }
        });
    }
    function pickPreTasks(t, chosenIds, done) {
        var chosen = {}, ids = chosenIds || [], i;
        for (i = 0; i < ids.length; i++) { chosen[String(ids[i])] = 1; }
        var html = '';
        for (i = 0; i < state.tasks.length; i++) {
            var q = state.tasks[i];
            if (String(q.id) === String(t.id)) { continue; }
            html += '<label style="display:block;padding:4px 2px;text-align:left">' +
                '<input type="checkbox" class="wp-link-pick" value="' + esc(q.id) + '"' +
                (chosen[String(q.id)] ? ' checked' : '') + '> ' + esc(q.taskName) +
                '　<span style="color:#c0c4cc">' + esc(q.startDate) + '</span></label>';
        }
        UI.dialog({
            title: '选择前置任务 —— ' + t.taskName,
            width: 480,
            content: $('#wpLinkTpl').html(),
            onReady: function ($body) {
                $body.find('#wpLinkList').html(html ||
                    '<div style="padding:10px;color:#909399">暂无其它任务</div>');
            },
            onOk: function ($body, close) {
                var picked = [];
                $body.find('.wp-link-pick:checked').each(function () { picked.push(String($(this).val())); });
                done(picked);
                close();
            }
        });
    }

    function openLink() {
        var t = selected();
        if (!t) { return; }
        UI.dialog({
            title: '前置依赖 —— ' + t.taskName,
            width: 480,
            content: $('#wpLinkTpl').html(),
            onReady: function ($body) {
                var chosen = {}, pres = String(t.preTaskIds || '').split(','), i, html = '';
                for (i = 0; i < pres.length; i++) { chosen[pres[i]] = 1; }
                for (i = 0; i < state.tasks.length; i++) {
                    var q = state.tasks[i];
                    if (String(q.id) === String(t.id)) { continue; }
                    html += '<label style="display:block;padding:4px 2px;text-align:left">' +
                        '<input type="checkbox" class="wp-link-pick" value="' + esc(q.id) + '"' +
                        (chosen[q.id] ? ' checked' : '') + '> ' + esc(q.taskName) +
                        '　<span style="color:#c0c4cc">' + esc(q.startDate) + '</span></label>';
                }
                $body.find('#wpLinkList').html(html || '<div style="padding:10px;color:#909399">暂无其它任务</div>');
            },
            onOk: function ($body, close) {
                var ids = [];
                $body.find('.wp-link-pick:checked').each(function () { ids.push(String($(this).val())); });
                t.preTaskIds = ids.join(',');
                close(); renderCanvas(); markDirty();
            }
        });
    }

    /* ---------------- 画布拖拽（按天换算，不依赖 DOM 几何，jsdom 也能测） ---------------- */
    function beginDrag(e) {
        var $bar = $(e.currentTarget), t = taskById($bar.attr('data-id'));
        if (!t) { return; }
        var $target = $(e.target);
        var mode = $target.hasClass('wp-bar__handle--l') ? 'start' :
            ($target.hasClass('wp-bar__handle--r') ? 'end' : 'move');
        state.drag = {
            id: t.id, mode: mode, x: (e.clientX || 0),
            start: t.startDate, end: t.endDate, changed: false
        };
        state.selectedId = t.id;
        paintSelection(); syncToolbar();
        if (e.preventDefault) { e.preventDefault(); }
    }
    function onDragMove(e) {
        var d = state.drag;
        if (!d) { return; }
        var t = taskById(d.id);
        if (!t) { return; }
        var delta = Math.round(((e.clientX || 0) - d.x) / state.dayW);
        if (!delta && !d.changed) { return; }
        d.changed = true;
        if (d.mode === 'start') {
            var ns = addDays(d.start, delta);
            if (ns > d.end) { ns = d.end; }
            t.startDate = ns;
            if (t.taskType === 'milestone') { t.endDate = ns; }
        } else if (d.mode === 'end') {
            var ne = addDays(d.end, delta);
            if (ne < t.startDate) { ne = t.startDate; }
            t.endDate = ne;
            if (t.taskType === 'milestone') { t.startDate = ne; }
        } else {
            t.startDate = addDays(d.start, delta);
            t.endDate = addDays(d.end, delta);
        }
        renderCanvas();
    }
    function endDrag() {
        if (!state.drag) { return; }
        var changed = state.drag.changed;
        state.drag = null;
        if (changed) { markDirty(); }
    }

    /* ---------------- 保存 / 打印 ---------------- */
    function validate() {
        if (!$.trim($('#wpDName').val())) { return '请填写计划名称'; }
        var s = $('#wpDStart').val(), e = $('#wpDEnd').val();
        if (s && e && s > e) { return '计划开始日期不能晚于结束日期'; }
        for (var i = 0; i < state.tasks.length; i++) {
            var t = state.tasks[i];
            if (!$.trim(t.taskName)) { return '第 ' + (i + 1) + ' 行任务名称不能为空'; }
            if (t.startDate > t.endDate) { return '任务「' + t.taskName + '」开始日期不能晚于结束日期'; }
        }
        return '';
    }
    function save() {
        var msg = validate();
        if (msg) { UI.message({ type: 'warning', message: msg }); return; }
        state.plan = collectPlan();
        renumber();
        Api.workPlan.save({ plan: state.plan, tasks: state.tasks }).done(function (res) {
            state.id = (res && res.id) || state.id;
            state.plan.id = state.id;
            if (res && res.planCode) { state.plan.planCode = res.planCode; $('#wpDCode').text(res.planCode); }
            markDirty(false);
            UI.message({ type: 'success', message: (res && res.message) || '工作计划已保存' });
            try { window.history.replaceState(null, '', 'workplan-design.html?id=' + encodeURIComponent(state.id)); }
            catch (err) { /* 忽略 */ }
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
        });
    }

    /* ---------------- 启动：一任务一工单 + 责任人 / 参与人员通知 ---------------- */
    function startPlan() {
        if (!state.id) { UI.message({ type: 'warning', message: '请先保存工作计划' }); return; }
        /* 后端按库里的任务派单，未保存的画布改动不会进工单，必须先落库 */
        if (state.dirty) {
            UI.message({ type: 'warning', message: '有未保存的修改，请先点「保存」再启动计划' }); return;
        }
        if (String(state.plan.status || '') === '已启动') {
            UI.message({ type: 'warning', message: '该工作计划已启动，不能重复启动' });
            return;
        }
        UI.confirm({
            title: '启动工作计划', type: 'warning',
            message: '将按当前 ' + state.tasks.length + ' 条任务生成工单，并给每条任务的' +
                '【责任人 + 参与人员】同时发送站内即时消息与通知邮件；工单会推送到他们的「我的任务」列表。' +
                ' 是否继续？',
            confirmText: '确定启动'
        }).done(function (yes) {
            if (!yes) { return; }
            Api.workPlan.start(state.id).done(function (res) {
                state.plan.status = '已启动';
                setStatus('已启动');
                UI.message({ type: 'success', message: (res && res.message) || '工作计划已启动' });
                /* 启动后回读一次：detail() 会 JOIN 工单编号，网格列表 / 任务属性立刻显示关联 */
                Api.workPlan.detail(state.id).done(function (data) {
                    state.tasks = (data && data.tasks) || state.tasks;
                    state.plan = (data && data.plan) || state.plan;
                    renderCanvas(); markDirty(false);
                });
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '启动失败' });
            });
        });
    }

    /* ---------------- 停止计划（仅创建人） ---------------- */
    function stopPlan() {
        if (!state.id) { return; }
        if (state.mine === false) {
            UI.message({ type: 'warning', message: '非本人创建的工作计划，不能停止' }); return;
        }
        UI.confirm({
            title: '停止工作计划', type: 'warning',
            message: '停止后计划状态变为「已停止」，不能再重复启动；已派发的工单与执行记录会保留。是否继续？',
            confirmText: '确定停止'
        }).done(function (yes) {
            if (!yes) { return; }
            Api.workPlan.stop(state.id).done(function (res) {
                state.plan.status = '已停止';
                setStatus('已停止');
                syncPerm();
                UI.message({ type: 'success', message: (res && res.message) || '工作计划已停止' });
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '停止失败' });
            });
        });
    }

    /* ---------------- 变更日志（时间线） ---------------- */
    function openChangeLogs() {
        if (!state.id) {
            UI.message({ type: 'warning', message: '请先保存工作计划' }); return;
        }
        UI.dialog({
            title: '变更日志 —— ' + (state.plan.planName || ''),
            width: 640,
            content: '<div class="wp-log" id="wpLogList">加载中…</div>',
            onReady: function ($body) {
                Api.workPlan.changeLogs({ planId: state.id }).done(function (res) {
                    var list = (res && res.list) || [];
                    var $box = $body.find('#wpLogList').empty();
                    if (!list.length) {
                        $box.html('<div class="wp-log__empty">还没有变更记录。修改任务并保存后，这里会按时间线展示。</div>');
                        return;
                    }
                    $.each(list, function (i, l) {
                        var cls = { add: 'is-add', delete: 'is-delete', update: 'is-update',
                                    exec: 'is-exec', stop: 'is-stop' }[l.action] || '';
                        $box.append('<div class="wp-log__item ' + cls + '"><span class="wp-log__dot"></span>' +
                            '<div class="wp-log__hd">' + esc(l.summary || '') + '</div>' +
                            '<div class="wp-log__meta">' + esc(l.operatorName || '—') + ' · ' +
                                esc(l.createTime || '') + '</div>' +
                            (l.detail ? '<div class="wp-log__detail">' + esc(l.detail) + '</div>' : '') +
                            '</div>');
                    });
                }).fail(function (err) {
                    $body.find('#wpLogList').html('<div class="wp-log__empty">' +
                        esc((err && err.message) || '加载失败') + '</div>');
                });
            }
        });
    }

    /* ---------------- 执行记录（多次提交 / 多附件） ---------------- */
    function openExecRecords(taskId, taskName) {
        if (!taskId) { return; }
        UI.dialog({
            title: '执行记录 —— ' + (taskName || ''),
            width: 640,
            content: '<div class="wp-log" id="wpExecList">加载中…</div>',
            onReady: function ($body) {
                Api.workPlan.execs({ taskId: taskId }).done(function (res) {
                    var list = (res && res.list) || [];
                    var $box = $body.find('#wpExecList').empty();
                    if (!list.length) {
                        $box.html('<div class="wp-log__empty">还没有提交过执行记录。</div>');
                        return;
                    }
                    $.each(list, function (i, e) {
                        var files = '';
                        $.each(e.files || [], function (j, f) {
                            files += '<a href="javascript:;" class="wp-exec-link" data-exec-file="' +
                                esc(f.id) + '" data-exec-name="' + esc(f.name || '附件') +
                                '" data-exec-size="' + (parseInt(f.size, 10) || 0) +
                                '">📎 ' + esc(f.name || '附件') + '</a> ';
                        });
                        $box.append('<div class="wp-log__item is-exec"><span class="wp-log__dot"></span>' +
                            '<div class="wp-log__hd">' + esc(e.title || '执行记录') + ' · ' +
                                esc(e.execStatus || '') + ' · ' + (parseInt(e.progress, 10) || 0) + '%</div>' +
                            '<div class="wp-log__meta">' + esc(e.operatorName || '') + ' · ' +
                                esc(e.createTime || '') + '</div>' +
                            (e.content ? '<div class="wp-log__detail">' + esc(e.content) + '</div>' : '') +
                            (files ? '<div style="margin-top:6px">' + files + '</div>' : '') +
                            '</div>');
                    });
                }).fail(function (err) {
                    $body.find('#wpExecList').html('<div class="wp-log__empty">' +
                        esc((err && err.message) || '加载失败') + '</div>');
                });
            }
        });
    }

    /* ---------------- 执行记录附件在线预览（与项目文件管理同一套实现） ---------------- */
    function execTokenQ() {
        var t = (window.AppAuth && AppAuth.token) ? AppAuth.token() : '';
        return t ? '&token=' + encodeURIComponent(t) : '';
    }
    function execRawUrl(id) {
        return '/api/workplan/execraw?id=' + encodeURIComponent(id) + execTokenQ();
    }
    function execPdfUrl(id) {
        return '/api/workplan/execpdf?id=' + encodeURIComponent(id) + execTokenQ();
    }
    function execSizeText(n) {
        n = parseInt(n, 10) || 0;
        if (!n) { return ''; }
        if (n < 1024) { return n + ' B'; }
        if (n < 1048576) { return (n / 1024).toFixed(1) + ' KB'; }
        return (n / 1048576).toFixed(1) + ' MB';
    }
    /** 附件预览：图片 / PDF / 文本 / Word / Excel / PPT 走 FilePreview，其它下载 */
    function previewExecFile(file) {
        if (!file || !file.id) { return; }
        var name = file.name || '附件';
        if (!window.FilePreview || !window.FilePreview.preview) {
            window.open(execRawUrl(file.id), '_blank');
            return;
        }
        window.FilePreview.preview({
            id: file.id,
            fileName: name,
            fileSizeText: execSizeText(file.size),
            downloadUrl: execRawUrl(file.id),
            pdfUrl: execPdfUrl(file.id)
        }, {
            onDownload: function () { window.open(execRawUrl(file.id), '_blank'); }
        });
    }

    /* ---------------- Excel 导入任务（服务端解析 → 预览 → 写入画布，不直接落库） ----------------
       流程与后端口径（server/service.py WorkPlanService.parse_import）一致：
         ① 下载模板（表头 / 批注 / 下拉由后端 IMPORT_COLUMNS 生成，与解析同源）
         ② 选文件（FileReader → base64，沿用项目里附件上传的口径）
         ③ 服务端解析 + 逐行校验（责任人 / 参与人员「工号 姓名」→ 员工ID）
         ④ 预览：错误行标红到行号，可只导入通过的行
         ⑤ 写入 state.tasks（生成 uuid、按 size 推导 parentId），必须由用户点「保存」才落库
       ⚠ 为什么不直接调接口落库：save() 是整图保存（先删后插）+ 变更日志 + 变更通知 +
         已启动计划补派工单，这些副作用必须由用户在画面上确认后触发。 */
    var IMP_MAX_TASKS = 200, IMP_MAX_BYTES = 5 * 1024 * 1024;

    function importTemplateUrl() {
        var t = (window.AppAuth && AppAuth.token) ? AppAuth.token() : '';
        return '/api/workplan/importtemplate' + (t ? '?token=' + encodeURIComponent(t) : '');
    }
    function impTypeText(kind) { return KINDS[kind] || '任务'; }
    function impErrText(row) { return (row.errors || []).join('；'); }

    /** 把解析结果写进画布：序号 → uuid 的映射一次建好，parentId / preTaskIds 全部走映射 */
    function applyImport(rows, mode) {
        var seqMap = {}, list = [], i, j;
        for (i = 0; i < rows.length; i++) { seqMap[rows[i].seq] = rows[i].id; }
        for (i = 0; i < rows.length; i++) {
            var r = rows[i], pre = [];
            var pres = r.preTaskSeqs || [];
            for (j = 0; j < pres.length; j++) {
                if (seqMap[pres[j]] && seqMap[pres[j]] !== r.id) { pre.push(seqMap[pres[j]]); }
            }
            list.push({
                id: r.id,
                taskName: r.taskName,
                taskType: r.taskType || 'task',
                parentId: r.parentSeq ? (seqMap[r.parentSeq] || '') : '',
                startDate: r.startDate, endDate: r.endDate,
                progress: 0, preTaskIds: pre.join(','),
                ownerId: parseInt(r.ownerId, 10) || 0, ownerName: r.ownerName || '',
                participantIds: r.participantIds || '', participantNames: r.participantNames || '',
                execStatus: '未开始', actualStartDate: '', actualEndDate: '', execRemark: '',
                orderCode: '', orderId: '', orderStatus: '', orderLinked: false,
                sortNo: 0, color: ''
            });
        }
        if (mode === 'replace') {
            state.tasks = list;
        } else {
            /* 追加：接在当前选中行之后，没选中就接在末尾（与「新增任务」的插入位置一致） */
            var at = taskIndex(state.selectedId);
            if (at >= 0) {
                state.tasks = state.tasks.slice(0, at + 1).concat(list, state.tasks.slice(at + 1));
            } else {
                state.tasks = state.tasks.concat(list);
            }
        }
        renumber();
        state.selectedId = list.length ? list[0].id : '';
        renderCanvas(); syncToolbar(); markDirty();
    }

    function openImport() {
        var started = String(state.plan.status || '') === '已启动';
        var canReplace = state.mine !== false;      // 非本人创建的计划不能删任务节点，也就不能「覆盖」
        var parsed = null, $ok = null;

        var $content = $(
            '<div class="wp-imp">' +
                '<div class="wp-imp__step">' +
                    '<span class="wp-imp__no">1</span>' +
                    '<div class="wp-imp__body"><b>下载模板</b>：按表头填写；' +
                        '责任人 / 参与人员统一写「工号 姓名」（如 E00001 张三），多人用逗号分隔' +
                        '<div class="wp-imp__link"><a href="javascript:;" id="wpImpTpl">工作计划任务导入模板.xlsx</a></div>' +
                    '</div>' +
                '</div>' +
                '<div class="wp-imp__step">' +
                    '<span class="wp-imp__no">2</span>' +
                    '<div class="wp-imp__body"><b>选择文件</b>：只支持 .xlsx（.xls / .csv 请先另存为 .xlsx），单文件 ≤ 5MB' +
                        '<div class="wp-imp__pick">' +
                            '<button type="button" class="el-button el-button--small" id="wpImpPick">选择文件</button>' +
                            '<span class="wp-imp__file" id="wpImpFile">未选择文件</span>' +
                            '<input type="file" id="wpImpInput" accept=".xlsx,.xlsm" style="display:none">' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="wp-imp__step">' +
                    '<span class="wp-imp__no">3</span>' +
                    '<div class="wp-imp__body"><b>核对结果</b>：错误行标红；' +
                        '导入只是写进当前画布，<b>点「保存」才会落库并通知责任人</b>' +
                        '<div class="wp-imp__stats" id="wpImpStats">还没有解析结果</div>' +
                    '</div>' +
                '</div>' +
                '<div class="wp-imp__preview" id="wpImpPreview">' +
                    '<div class="wp-imp__empty">选择文件后在这里预览解析结果</div>' +
                '</div>' +
                '<div class="wp-imp__opts">' +
                    '<label class="el-radio"><input class="el-radio__original" type="radio" ' +
                        'name="wpImpMode" value="append" checked>' +
                        '<span class="el-radio__inner"></span>' +
                        '<span class="el-radio__label">追加到现有任务之后</span></label>' +
                    '<label class="el-radio">' +
                        '<input class="el-radio__original" type="radio" name="wpImpMode" value="replace"' +
                        (canReplace ? '' : ' disabled') + '>' +
                        '<span class="el-radio__inner"></span>' +
                        '<span class="el-radio__label">覆盖现有任务（清空后导入）</span></label>' +
                '</div>' +
                '<div class="wp-imp__tips">' +
                    (canReplace ? '' : '<div class="wp-imp__tip is-warn">非本人创建的工作计划不能删除任务节点，' +
                        '因此「覆盖」不可用，只能追加。</div>') +
                    (started ? '<div class="wp-imp__tip is-warn">该计划<b>已启动</b>：保存时会为「已填责任人 / 参与人员」' +
                        '的新任务补派工单，并发站内消息与通知邮件。想先排期后派单，把责任人列留空再导入。</div>' : '') +
                    '<div class="wp-imp__tip">导入不会自动派单；核对甘特图 / 网格列表无误后点工具栏「保存」。</div>' +
                '</div>' +
            '</div>'
        );

        function syncOk() {
            var good = parsed ? $.grep(parsed.rows || [], function (r) { return !!r.ok; }) : [];
            if ($ok && $ok.length) {
                $ok.text(good.length ? ('导入 ' + good.length + ' 条任务') : '导入')
                    .prop('disabled', !good.length);
            }
            return good.length;
        }

        function render(result) {
            var rows = (result && result.rows) || [];
            var stats = (result && result.summary) || {};
            var html = '<div class="wp-imp__scroll"><table class="wp-imp__table">' +
                '<colgroup>' +
                    '<col class="is-c-no"><col class="is-c-no"><col class="is-c-name">' +
                    '<col class="is-c-type"><col class="is-c-date"><col class="is-c-date">' +
                    '<col class="is-c-no"><col class="is-c-owner"><col class="is-c-parts">' +
                    '<col class="is-c-no"><col class="is-c-check">' +
                '</colgroup><thead><tr>' +
                '<th class="is-no">序号</th><th class="is-no">层级</th>' +
                '<th>任务名称</th><th class="is-mid">类型</th><th class="is-mid">开始</th>' +
                '<th class="is-mid">结束</th><th class="is-no">天数</th><th>责任人</th>' +
                '<th>参与人员</th><th class="is-no">前置</th><th>校验结果</th>' +
                '</tr></thead><tbody>';
            var valid = 0, i;
            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                if (r.ok) { valid++; }
                var pad = Math.max(0, (parseInt(r.level, 10) || 1) - 1) * 14;
                html += '<tr class="' + (r.ok ? 'is-ok' : 'is-bad') + '">' +
                    '<td class="is-no" title="Excel 第 ' + esc(r.rowNo) + ' 行">' +
                        esc(r.seq) + '</td>' +
                    '<td class="is-no">' + esc(r.level) + '</td>' +
                    '<td class="is-name"><span class="wp-imp__name" style="padding-left:' + pad + 'px"' +
                        ' title="' + esc(r.taskName || '（空）') + '">' +
                        esc(r.taskName || '（空）') + '</span></td>' +
                    '<td class="is-mid">' + esc(impTypeText(r.taskType)) + '</td>' +
                    '<td class="is-mid">' + esc(r.startDate || '') + '</td>' +
                    '<td class="is-mid">' + esc(r.endDate || '') + '</td>' +
                    '<td class="is-no">' + (parseInt(r.duration, 10) || 0) + '</td>' +
                    '<td class="is-clip" title="' + esc(r.ownerRaw || '') + '">' +
                        esc(r.ownerName || '—') + '</td>' +
                    '<td class="is-clip" title="' + esc(r.participantRaw || '') + '">' +
                        esc(r.participantNames || '—') + '</td>' +
                    '<td class="is-no">' + esc((r.preTaskSeqs || []).join(',')) + '</td>' +
                    '<td class="' + (r.ok ? 'is-pass' : 'is-fail') + '">' +
                        (r.ok ? '通过' : esc(impErrText(r))) + '</td>' +
                    '</tr>';
            }
            html += '</tbody></table></div>';
            $content.find('#wpImpPreview').html(html);
            $content.find('#wpImpStats').removeClass('is-error').html(
                '共 <b>' + (stats.total || rows.length) + '</b> 行：可导入 ' +
                '<b class="is-pass">' + valid + '</b> 条' +
                (stats.invalid ? '，异常 <b class="is-fail">' + stats.invalid + '</b> 条' : '') +
                '（摘要 ' + (stats.summaries || 0) + ' / 里程碑 ' + (stats.milestones || 0) +
                ' / 已填责任人 ' + (stats.withOwner || 0) + '）' +
                (result && result.mock ? '　<span class="wp-imp__mock">离线演示数据</span>' : '')
            );
            syncOk();
        }

        function fail(text) {
            parsed = null;
            $content.find('#wpImpStats').addClass('is-error').text(text);
            $content.find('#wpImpPreview').html('<div class="wp-imp__empty">' +
                esc(text) + '</div>');
            syncOk();
        }

        function parseFile(fileName, data) {
            $content.find('#wpImpStats').removeClass('is-error').text('正在解析…');
            $content.find('#wpImpPreview').html('<div class="wp-imp__empty">正在解析，请稍候…</div>');
            Api.workPlan.importTasks({ fileName: fileName, data: data }).done(function (res) {
                parsed = res || null;
                render(res);
            }).fail(function (err) {
                fail((err && err.message) || '解析失败，请确认文件是 .xlsx 且表头与模板一致');
            });
        }

        function readFile(file) {
            var name = String(file.name || '');
            if (!/\.(xlsx|xlsm)$/i.test(name)) {
                UI.message({ type: 'warning', message: '只支持 .xlsx 文件：.xls / .csv 请先另存为 .xlsx' });
                return;
            }
            if (file.size > IMP_MAX_BYTES) {
                UI.message({ type: 'warning', message: '文件不能超过 5MB' });
                return;
            }
            $content.find('#wpImpFile').text(name);
            var reader = new window.FileReader();
            reader.onload = function () {
                var text = String(reader.result || '');
                var base64 = text.indexOf(';base64,') >= 0 ? text.split(';base64,')[1] : text;
                parseFile(name, base64);
            };
            reader.onerror = function () { fail('文件读取失败，请重试或换一个文件'); };
            reader.readAsDataURL(file);
        }

        $content.find('#wpImpTpl').on('click', function () {
            if (window.Api && Api.config && Api.config.useMock) {
                UI.message({ type: 'warning',
                    message: '离线演示通道没有服务端模板，连接服务端后可从「导入任务」里下载模板' });
                return;
            }
            window.open(importTemplateUrl(), '_blank');
        });
        $content.find('#wpImpPick').on('click', function () {
            $content.find('#wpImpInput').trigger('click');
        });
        $content.find('#wpImpInput').on('change', function () {
            var file = this.files && this.files[0];
            if (file) { readFile(file); }
        });
        $content.find('input[name="wpImpMode"]').on('change', function () {
            $content.find('.el-radio').removeClass('is-checked');
            $(this).closest('.el-radio').addClass('is-checked');
        });

        UI.dialog({
            title: '从 Excel 导入任务',
            width: 980,
            content: $content,
            onReady: function ($body) {
                var $dlg = $body.closest('.el-dialog');
                $dlg.addClass('wp-imp-dialog');
                $ok = $dlg.find('.btn-ok');
                $content.find('input[name="wpImpMode"]:checked').closest('.el-radio').addClass('is-checked');
                syncOk();
            },
            onOk: function ($body, close) {
                var good = parsed ? $.grep(parsed.rows || [], function (r) { return !!r.ok; }) : [];
                if (!good.length) {
                    UI.message({ type: 'warning',
                        message: '没有可导入的行：请先选择文件，或按提示修正标红的问题后重新导入' });
                    return;
                }
                var mode = $content.find('input[name="wpImpMode"]:checked').val() || 'append';
                if (mode === 'replace' && !canReplace) { mode = 'append'; }
                var base = mode === 'replace' ? 0 : state.tasks.length;
                if (base + good.length > IMP_MAX_TASKS) {
                    UI.message({ type: 'warning',
                        message: '导入后任务数会达到 ' + (base + good.length) + ' 条，超过单张计划上限 ' +
                            IMP_MAX_TASKS + ' 条：请先删掉部分任务，或改成「覆盖现有任务」' });
                    return;
                }
                /* 已启动的计划：save() 会给「已填人」的新任务补派工单并发通知，先让用户知道影响面 */
                var people = {}, pc = 0, i;
                for (i = 0; i < good.length; i++) {
                    var ids = String(good[i].ownerId || '') + ',' + String(good[i].participantIds || '');
                    var arr = ids.split(',');
                    for (var j = 0; j < arr.length; j++) {
                        if (arr[j] && !people[arr[j]]) { people[arr[j]] = 1; pc++; }
                    }
                }
                if (started && pc) {
                    UI.confirm({
                        title: '导入到已启动的计划', type: 'warning',
                        message: '这 ' + good.length + ' 条任务里有 ' + pc + ' 位责任人 / 参与人员：保存后会为它们' +
                            '补派工单，并给这些人发站内消息与通知邮件。想先排期后派单，请把责任人列留空后重新导入。' +
                            '是否继续导入？',
                        confirmText: '继续导入'
                    }).done(function (yes) {
                        if (!yes) { return; }
                        applyImport(good, mode);
                        close();
                        UI.message({ type: 'success',
                            message: '已导入 ' + good.length + ' 条任务，核对无误后请点「保存」' });
                    });
                    return;
                }
                applyImport(good, mode);
                close();
                UI.message({ type: 'success',
                    message: '已导入 ' + good.length + ' 条任务，核对无误后请点「保存」' });
            }
        });
    }

    /* ---------------- 事件 ---------------- */
    $('#wpDViewBar').on('click', '[data-view]', function () {
        setView($(this).attr('data-view'));
    });
    $('#wpDBtnTask').on('click', function () { addTask('task'); });
    $('#wpDBtnMilestone').on('click', function () { addTask('milestone'); });
    $('#wpDBtnSummary').on('click', function () { addTask('summary'); });
    $('#wpDBtnImport').on('click', openImport);
    $('#wpDBtnProp').on('click', openProp);
    $('#wpDBtnLink').on('click', openLink);
    $('#wpDBtnIndent').on('click', function () { indentTask(false); });
    $('#wpDBtnOutdent').on('click', function () { indentTask(true); });
    $('#wpDBtnUp').on('click', function () { moveTask(-1); });
    $('#wpDBtnDown').on('click', function () { moveTask(1); });
    $('#wpDBtnDelete').on('click', removeTask);
    $('#wpDBtnSave').on('click', save);
    $('#wpDBtnStart').on('click', startPlan);
    $('#wpDBtnStop').on('click', stopPlan);
    $('#wpDBtnLog').on('click', openChangeLogs);
    $(document).on('click', '.wp-exec-link[data-exec-task], .wp-cal__exec[data-exec-task]', function (e) {
        e.preventDefault(); e.stopPropagation();
        var id = $(this).attr('data-exec-task');
        var t = taskById(id);
        openExecRecords(id, t ? t.taskName : '');
    });
    $(document).on('click', '[data-exec-file]', function (e) {
        e.preventDefault(); e.stopPropagation();
        previewExecFile({
            id: $(this).attr('data-exec-file'),
            name: $(this).attr('data-exec-name'),
            size: $(this).attr('data-exec-size')
        });
    });
    $('#wpDBtnMyTask').on('click', function () { go('workplan-task.html'); });
    $('#wpDBtnPrint').on('click', function () { try { window.print(); } catch (e) { /* 忽略 */ } });
    $('#wpDBtnBack').on('click', function () { go('workplan.html'); });
    $('#wpDName, #wpDStart, #wpDEnd').on('input change', function () { markDirty(); });
    /* 顶部日期范围改动要立刻反映到时间刻度（与保存后的自动扩展同口径） */
    $('#wpDStart, #wpDEnd').on('change', function () {
        state.plan.startDate = $('#wpDStart').val();
        state.plan.endDate = $('#wpDEnd').val();
        renderCanvas();
    });
    $('#wpDScale').on('change', function () { state.plan.scale = $(this).val(); renderCanvas(); markDirty(); });
    $('#wpDWeekend, #wpDPub').on('change', function () { renderCanvas(); markDirty(); });

    $('#wpDCanvas').on('click', '.wp-row', function (e) {
        if ($(e.target).hasClass('wp-row__name')) { return; }
        state.selectedId = $(this).attr('data-id');
        paintSelection(); syncToolbar();
    });
    $('#wpDCanvas').on('click', '.wp-bar', function (e) {
        state.selectedId = $(this).attr('data-id');
        paintSelection(); syncToolbar();
        e.stopPropagation();
    });
    $('#wpDCanvas').on('dblclick', '.wp-row', function () {
        state.selectedId = $(this).attr('data-id');
        paintSelection(); syncToolbar(); openProp();
    });
    /* 日历图 / 网格列表：单击选中，双击打开同一个任务属性弹窗 */
    $('#wpDCanvas').on('click', '.wp-cal__task, .wp-grid__row', function () {
        state.selectedId = $(this).attr('data-id');
        paintSelection(); syncToolbar();
    });
    $('#wpDCanvas').on('dblclick', '.wp-cal__task, .wp-grid__row', function () {
        state.selectedId = $(this).attr('data-id');
        paintSelection(); syncToolbar(); openProp();
    });
    $('#wpDCanvas').on('change', '.wp-row__name', function () {
        var t = taskById($(this).attr('data-id'));
        if (t) { t.taskName = $.trim($(this).val()) || t.taskName; renderCanvas(); markDirty(); }
    });
    $('#wpDCanvas').on('mousedown', '.wp-bar', beginDrag);
    $(document).on('mousemove', onDragMove).on('mouseup', endDrag);

    /* ---------------- 首屏 ---------------- */
    function qs(name) {
        var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search || '');
        return m ? decodeURIComponent(m[1]) : '';
    }
    state.id = qs('id');
    state.focusTaskId = qs('taskId');       // 从「我的任务」工单跳来时定位到关联任务
    try {
        var qView = qs('view');
        if (qView && VIEWS[qView]) { state.view = qView; }
        var savedView = window.localStorage.getItem(VIEW_KEY);
        if (!qView && savedView && VIEWS[savedView]) { state.view = savedView; }
    } catch (e) { }
    setView(state.view);
    markDirty(false);
    if (!state.id) {
        $('#wpDCanvas').html('<div class="wp-empty">缺少计划参数，请从「计划管理」列表点「工作计划」进入。</div>');
        syncToolbar();
        return;
    }
    Api.workPlan.detail(state.id).done(function (data) {
        state.plan = (data && data.plan) || {};
        state.tasks = (data && data.tasks) || [];
        var i;
        for (i = 0; i < state.tasks.length; i++) {
            state.tasks[i].preTaskIds = state.tasks[i].preTaskIds || '';
            state.tasks[i].parentId = state.tasks[i].parentId || '';
            state.tasks[i].progress = parseInt(state.tasks[i].progress, 10) || 0;
            /* 老库 / 老数据没有这几列时给默认值，属性弹窗与保存不会串成 undefined */
            state.tasks[i].ownerName = state.tasks[i].ownerName || '';
            state.tasks[i].ownerId = parseInt(state.tasks[i].ownerId, 10) || 0;
            state.tasks[i].participantIds = state.tasks[i].participantIds || '';
            state.tasks[i].participantNames = state.tasks[i].participantNames || '';
            state.tasks[i].execStatus = state.tasks[i].execStatus || '未开始';
            state.tasks[i].actualStartDate = state.tasks[i].actualStartDate || '';
            state.tasks[i].actualEndDate = state.tasks[i].actualEndDate || '';
            state.tasks[i].execRemark = state.tasks[i].execRemark || '';
            state.tasks[i].orderCode = state.tasks[i].orderCode || '';
            state.tasks[i].orderStatus = state.tasks[i].orderStatus || '';
        }
        fillForm(); syncPerm(); renderCanvas(); markDirty(false); applyFocus();
    }).fail(function (err) {
        $('#wpDCanvas').html('<div class="wp-empty">' + esc((err && err.message) || '工作计划加载失败') + '</div>');
    });
});
