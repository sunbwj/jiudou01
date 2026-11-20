/* ==========================================================================
   workload-report-test.js —— 项目中心 · 员工工作量统计（workload-report.html）jsdom 回归
   --------------------------------------------------------------------------
   覆盖：
     ① 静态资源：页面级 css/js 引用 + 版本号；11 列 / 9 个可排序列 / 5 个 KPI /
        5 个快捷区间 / 3 个工具栏按钮 / 口径说明；后端口子与建表脚本齐全；
     ② Mock 口径（与 WorkloadService 同口径）：区间按派单时间、完成率 / 按期率 /
        逾期 / 平均耗时、排序 + 未指定责任人垫底、keyword、scope=mine；
     ③ 明细钻取（Mock）：分页、小计按整段区间、状态过滤、耗时不为负；
     ④ 页面渲染：行数 / 姓名 / 指标列 / KPI / 计划数 / 区间文案 / 空行补位；
     ⑤ 交互：点表头排序（降序→升序）、快捷区间（上月→空态，本月→恢复）、
        「仅看我的」、关键字回车、重置；
     ⑥ 钻取弹窗：标题 / 行数 / 小计 / 状态标签 / 逾期行 / 跳「看计划」「打开任务」；
     ⑦ 导出：window.open 带上区间与 token；空数据只提示不导出；
     ⑧ ES5：页面脚本不用 let / const / 箭头 / 模板串。
   运行：NODE_PATH=C:/Users/chx/.workbuddy/binaries/node/workspace/node_modules node tools/workload-report-test.js
   ========================================================================== */
'use strict';
process.on('unhandledRejection', function () { /* 页面里的异步桩不影响结论 */ });
var fs = require('fs');
var path = require('path');
var JSDOM = (function () { try { return require('jsdom').JSDOM; } catch (e) { return null; } })();

var ROOT = path.resolve(__dirname, '..');
var pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(cond, ms) {
    var end = Date.now() + (ms || 2500);
    while (Date.now() < end) {
        if (cond()) { return true; }
        await wait(20);
    }
    return false;
}
function apiDone(promise) {
    return new Promise(function (resolve) {
        promise.done(function (data) { resolve(data); }).fail(function () { resolve(null); });
    });
}

if (!JSDOM) { console.log('未安装 jsdom，跳过'); process.exit(0); }

/* ---------------- 日期小工具：全部按「今天」相对推算，任何一天跑都成立 ---------------- */
function p2(n) { return ('0' + n).slice(-2); }
function day(off) {
    var d = new Date();
    d.setDate(d.getDate() + (off || 0));
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}
function at(off, hm) { return day(off) + ' ' + (hm || '09:00:00'); }

/* ---------------- 造工单：ownerA 3 条（2 完成 1 处理中）、ownerB 2 条全完成、1 条未指定 ---------------- */
function makeOrders(ownerA, ownerB) {
    function row(o) {
        return {
            id: o.id, orderCode: o.id, taskId: o.id + '-T', taskType: 'task',
            startDate: day(-1), endDate: o.end, ownerId: o.ownerId, ownerName: o.ownerName || '',
            status: o.status, dispatchTime: o.dispatch, actualEndTime: o.actual || '',
            planId: o.planId || '', planCode: o.planCode || '', planName: o.planName || '',
            projectId: o.projectId || '', projectName: o.projectName || '',
            orderTitle: o.title, acceptStatus: '',
            noticeMsg: 0, noticeMail: 0, createTime: at(0), updateTime: at(0)
        };
    }
    return [
        /* A：完成但超期 */
        row({ id: 'WL-A1', ownerId: ownerA, ownerName: '员工A', status: '已完成',
              dispatch: at(0, '09:00:00'), end: day(-1), actual: at(0, '18:00:00'),
              planId: 'PLAN-A', planCode: 'WP000900', planName: 'A 计划',
              title: 'A 任务一' }),
        /* A：按期完成 */
        row({ id: 'WL-A2', ownerId: ownerA, ownerName: '员工A', status: '已完成',
              dispatch: at(0, '08:00:00'), end: day(0), actual: at(0, '17:00:00'),
              planId: 'PLAN-A', planCode: 'WP000900', planName: 'A 计划',
              title: 'A 任务二' }),
        /* A：处理中 + 逾期 */
        row({ id: 'WL-A3', ownerId: ownerA, ownerName: '员工A', status: '处理中',
              dispatch: at(0, '10:00:00'), end: day(-2),
              planId: 'PLAN-A', planCode: 'WP000900', planName: 'A 计划',
              title: 'A 任务三' }),
        /* B：两条都按期完成 → 完成率 100%，排序切完成率时反超 A */
        row({ id: 'WL-B1', ownerId: ownerB, ownerName: '员工B', status: '已完成',
              dispatch: at(0, '11:00:00'), end: day(0), actual: at(0, '19:00:00'),
              planId: 'PLAN-B', planCode: 'WP000901', planName: 'B 计划',
              title: 'B 任务一' }),
        row({ id: 'WL-B2', ownerId: ownerB, ownerName: '员工B', status: '已完成',
              dispatch: at(0, '12:00:00'), end: day(0), actual: at(0, '19:30:00'),
              planId: 'PLAN-B', planCode: 'WP000901', planName: 'B 计划',
              title: 'B 任务二' }),
        /* 未指定责任人：不参与排名，永远垫底 */
        row({ id: 'WL-U1', ownerId: 0, ownerName: '', status: '待处理',
              dispatch: at(0, '13:00:00'), end: day(3), title: '没人认领的任务' })
    ];
}

function boot(orders, loginEmpId) {
    var dom = new JSDOM(read('workload-report.html'), {
        url: 'http://127.0.0.1:8808/workload-report.html',
        runScripts: 'outside-only', pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'mock-token', user: { empId: loginEmpId || 3, nameCn: '员工B' }
    }));
    win.eval(read('js/api.js'));
    win.Api.config.useMock = true;
    win.Api.config.delay = 1;
    if (orders) { win.localStorage.setItem('menu_admin_workplanorders_v1', JSON.stringify(orders)); }
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/btnperm.js'));
    /* 主框架里的 navigate 是多 Tab 打开（iframe 外）；jsdom 里用桩记录跳转地址 */
    win.AppFrame = { navigate: function (u) { win.__nav = u; } };
    win.openCalls = [];
    win.open = function (u) { win.openCalls.push(String(u)); return null; };
    win.eval(read('js/workload-report.js'));
    return win;
}

function rowsOf(win) { return win.document.querySelectorAll('#wlTbody tr[data-owner]'); }
function text(win, sel) {
    var el = win.document.querySelector(sel);
    return el ? (el.textContent || '').replace(/^\s+|\s+$/g, '') : null;
}
function cells(win, i) {
    var tr = rowsOf(win)[i];
    if (!tr) { return []; }
    var tds = tr.querySelectorAll('td'), out = [];
    for (var k = 0; k < tds.length; k++) {
        out.push((tds[k].textContent || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''));
    }
    return out;
}

(async function () {
    /* ================= 1. 静态资源与页面骨架 ================= */
    console.log('\n--- 1. 静态资源与页面骨架 ---');
    var html = read('workload-report.html');
    var css = read('css/workload.css');
    var pageJs = read('js/workload-report.js');
    var apiJs = read('js/api.js');
    var servicePy = read('server/service.py');
    var appPy = read('server/app.py');

    check('页面引用页面级 css/js', /css\/workload\.css\?v=\d{8}[a-z0-9]*/.test(html) &&
        /js\/workload-report\.js\?v=\d{8}[a-z0-9]*/.test(html), '版本号为数字日期 + 后缀');
    check('页面引用共享 api.js / btnperm.js', /js\/api\.js\?v=/.test(html) && /js\/btnperm\.js\?v=/.test(html));
    check('页面标题与面包屑是「工作量统计」',
        html.indexOf('<title>工作量统计') > -1 && html.indexOf('data-crumb="项目中心/工作量统计"') > -1);
    check('表头 11 列（含明细列）', (html.match(/<th[\s>]/g) || []).length === 11,
        (html.match(/<th[\s>]/g) || []).length);
    check('8 个可排序列（接单数 / 已完成 / 处理中 / 待处理 / 逾期 / 完成率 / 平均耗时 / 最近派单）',
        (html.match(/class="is-center wl-sort"/g) || []).length === 8,
        (html.match(/class="is-center wl-sort"/g) || []).length);
    check('5 个 KPI 指标卡', (html.match(/class="wl-kpi__item"/g) || []).length === 5);
    check('5 个快捷区间按钮', (html.match(/class="wl-quick__btn/g) || []).length === 5);
    check('3 个工具栏按钮（刷新 / 导出 / 仅看我的）',
        /id="wlBtnRefresh"/.test(html) && /id="wlBtnExport"/.test(html) && /id="wlBtnMine"/.test(html));
    check('口径说明的整段文字包在 .wl-note__text 里（否则窄屏每个词被挤成一列）',
        /<span class="wl-note__text">[\s\S]*统计口径/.test(html) &&
        /\.wl-note__text\s*\{[^}]*flex:\s*1 1 auto/.test(css));
    check('口径说明写在页面上（派单时间 / 完成率 / 逾期 / 平均耗时）',
        /统计口径/.test(html) && /按<b>派单时间<\/b>/.test(html) &&
        /完成率<\/b> = 已完成 ÷ 接单数/.test(html) && /平均耗时<\/b> = 派单日/.test(html));
    check('空态 / 分页容器齐备', /id="wlEmpty"/.test(html) && /id="wlPager"/.test(html));
    check('CSS 有进度条 fill 的 display:block（span 默认 inline 会整条不显示）',
        /\.wl-rate__fill\s*\{[^}]*display:\s*block/.test(css));
    check('CSS 有空表格隐藏 + 空态样式', /\.table-card\.is-empty\s+\.el-table/.test(css) &&
        /\.wl-empty__title/.test(css));
    check('后端已注册 workload 服务与 stats/details 动作',
        /'workload':\s*workload_service/.test(servicePy) &&
        /'stats':\s*\('stats',\s*\['GET'\]\)/.test(servicePy) &&
        /'details':\s*\('details',\s*\['GET'\]\)/.test(servicePy));
    check('导出走独立二进制路由 /api/workload/export',
        /\/api\/workload\/export/.test(appPy) && /X-Row-Count/.test(appPy));
    check('菜单脚本把 MNU00028 挂到 MNG1006',
        /MNU00028/.test(read('db/workload-menu.sql')) && /MNG1006/.test(read('db/workload-menu.sql')));
    check('按钮权限脚本登记了 3 个按钮',
        ['wlBtnRefresh', 'wlBtnExport', 'wlBtnMine'].every(function (b) {
            return read('db/workload-btn-perm.sql').indexOf(b) > -1;
        }));

    /* ================= 2. Mock 口径 ================= */
    console.log('\n--- 2. Mock 统计口径 ---');
    var seed = boot(null, 3);
    var empList = await apiDone(seed.Api.emp.page({ pageNum: 1, pageSize: 10 }));
    var emps = (empList && empList.list) || [];
    check('Mock 员工数据可用（>=2 人，用于断言姓名 / 工号 / 部门）', emps.length >= 2, emps.length);
    var ownerA = Number(emps[0].id), ownerB = Number(emps[1].id);
    var orders = makeOrders(ownerA, ownerB);

    var win = boot(orders, ownerB);
    var W = win.Api.workload;
    var range = { startDate: day(0).slice(0, 8) + '01', endDate: day(0) };
    var st = await apiDone(W.stats({ startDate: range.startDate, endDate: range.endDate }));

    function find(data, ownerId) {
        var list = (data && data.list) || [];
        for (var i = 0; i < list.length; i++) {
            if (Number(list[i].ownerId) === Number(ownerId)) { return list[i]; }
        }
        return null;
    }
    var a = find(st, ownerA), b = find(st, ownerB), u = find(st, 0);
    check('按派单时间落在区间内的工单全部聚合（A 3 / B 2 / 未指定 1）',
        !!a && a.orderCount === 3 && !!b && b.orderCount === 2, a && a.orderCount);
    check('已完成 / 处理中 / 待处理分开计数',
        a.doneCount === 2 && a.doingCount === 1 && a.todoCount === 0 && b.doneCount === 2,
        [a.doneCount, a.doingCount, a.todoCount].join('/'));
    check('完成率 = 已完成 ÷ 接单数（A 66.7% / B 100%）',
        a.doneRate === 66.7 && b.doneRate === 100, a.doneRate + ' / ' + b.doneRate);
    check('逾期只算「未完成且计划完成日已过」（A 1 / B 0）',
        a.overdueCount === 1 && b.overdueCount === 0, a.overdueCount + ' / ' + b.overdueCount);
    check('按期率 = 按期完成 ÷ 已完成（A 1/2 = 50%）', a.onTimeRate === 50, a.onTimeRate);
    check('平均耗时同日完成算 0 天（不出现负数）',
        a.avgDays === 0 && b.avgDays === 0, a.avgDays + ' / ' + b.avgDays);
    check('员工姓名 / 工号 / 部门取自员工表',
        a.ownerName === emps[0].nameCn && a.empCode === emps[0].code, a.ownerName + ' / ' + a.empCode);
    check('默认接单数降序：A → B → 未指定',
        st.list.map(function (x) { return x.ownerId; }).join(',') ===
        [ownerA, ownerB, 0].join(','),
        st.list.map(function (x) { return x.ownerName; }).join(','));
    check('未指定责任人标记 unknown 且垫底', u && u.unknown === true && u.ownerName === '未指定',
        u && u.ownerName);
    check('汇总按总单量重算完成率（4/6 = 66.7%）',
        st.summary.orderCount === 6 && st.summary.doneCount === 4 &&
        st.summary.doneRate === 66.7 && st.summary.overdueCount === 1,
        JSON.stringify(st.summary));
    check('覆盖计划数按整体去重（PLAN-A / PLAN-B = 2）', st.summary.planCount === 2, st.summary.planCount);
    check('区间天数按闭区间算', st.range.days === Number(range.endDate.slice(8)) , st.range.days);

    var byRate = await apiDone(W.stats({ startDate: range.startDate, endDate: range.endDate,
        sortBy: 'doneRate', sortOrder: 'desc' }));
    check('sortBy=doneRate 让 100% 的 B 反超 A', byRate.list[0].ownerId === ownerB, byRate.list[0].ownerName);
    var byRateAsc = await apiDone(W.stats({ startDate: range.startDate, endDate: range.endDate,
        sortBy: 'doneRate', sortOrder: 'asc' }));
    check('sortOrder=asc 升序且未指定仍垫底',
        byRateAsc.list[0].ownerId === ownerA &&
        byRateAsc.list[byRateAsc.list.length - 1].ownerId === 0,
        byRateAsc.list.map(function (x) { return x.ownerName; }).join(','));
    var kw = await apiDone(W.stats({ startDate: range.startDate, endDate: range.endDate,
        keyword: emps[1].code }));
    check('keyword 能按工号命中单个员工', kw.list.length === 1 && kw.list[0].ownerId === ownerB,
        kw.list.length);
    var mine = await apiDone(W.stats({ startDate: range.startDate, endDate: range.endDate, scope: 'mine' }));
    check('scope=mine 只统计登录人（登录人是 B → 1 行 2 单）',
        mine.list.length === 1 && mine.list[0].ownerId === ownerB && mine.summary.orderCount === 2,
        JSON.stringify(mine.summary));
    var empty = await apiDone(W.stats({ startDate: '2000-01-01', endDate: '2000-01-31' }));
    check('无数据区间返回空列表 + 0 值汇总',
        empty.list.length === 0 && empty.summary.orderCount === 0 && empty.summary.doneRate === 0,
        JSON.stringify(empty.summary));

    /* ================= 3. 明细钻取（Mock） ================= */
    console.log('\n--- 3. 明细钻取（Mock） ---');
    var d1 = await apiDone(W.details({ ownerId: ownerA, startDate: range.startDate,
        endDate: range.endDate, pageNum: 1, pageSize: 2 }));
    check('明细只含该员工工单（总数 3，pageSize=2 → 2 页）',
        d1.total === 3 && d1.pages === 2 && d1.list.length === 2,
        d1.total + '/' + d1.pages + '/' + d1.list.length);
    check('小计按整段区间算（不随当前页变化）',
        d1.summary.total === 3 && d1.summary.done === 2 && d1.summary.doneRate === 66.7,
        JSON.stringify(d1.summary));
    check('明细按派单时间倒序（10:00 → 09:00）',
        d1.list[0].orderCode === 'WL-A3' && d1.list[1].orderCode === 'WL-A1',
        d1.list.map(function (x) { return x.orderCode; }).join(','));
    var d2 = await apiDone(W.details({ ownerId: ownerA, startDate: range.startDate,
        endDate: range.endDate, pageNum: 2, pageSize: 2 }));
    check('翻页不重复', d2.list.length === 1 && d2.list[0].orderCode === 'WL-A2',
        d2.list.map(function (x) { return x.orderCode; }).join(','));
    check('明细带逾期标记与耗时（已完成算 0 天、未完成给 null）',
        d1.list[0].overdue === true && d1.list[0].days === null &&
        d1.list[1].overdue === false && d1.list[1].days === 0,
        JSON.stringify([d1.list[0].days, d1.list[1].days]));
    check('明细行带跳转所需的 planId / taskId / 计划名',
        d1.list[1].planId === 'PLAN-A' && !!d1.list[1].taskId && d1.list[1].planName === 'A 计划',
        JSON.stringify([d1.list[1].planId, d1.list[1].planName]));
    var dDone = await apiDone(W.details({ ownerId: ownerA, startDate: range.startDate,
        endDate: range.endDate, status: '已完成' }));
    check('按状态过滤（已完成 2 条）', dDone.total === 2 && dDone.list.length === 2, dDone.total);

    /* ================= 4. 页面首次渲染 ================= */
    console.log('\n--- 4. 页面首次渲染 ---');
    await until(function () { return rowsOf(win).length > 0; }, 4000);
    check('默认本月区间渲染出 3 行（含未指定责任人）', rowsOf(win).length === 3, rowsOf(win).length);
    check('首行是接单最多的 A（姓名 + 工号 + 部门）',
        cells(win, 0)[1].indexOf(emps[0].nameCn) > -1 &&
        cells(win, 0)[1].indexOf(emps[0].code) > -1, cells(win, 0)[1]);
    check('第 3 列接单数 / 第 8 列完成率',
        cells(win, 0)[2] === '3' && cells(win, 0)[7] === '66.7%',
        cells(win, 0).slice(2, 8).join('|'));
    check('平均耗时给「0 天」而不是「—」（有已完成单）', cells(win, 0)[8] === '0 天', cells(win, 0)[8]);
    check('最后一列是「明细」入口', cells(win, 0)[10] === '明细', cells(win, 0)[10]);
    check('未指定责任人排最后、带 is-unknown 样式、姓名显示「未指定」',
        rowsOf(win)[2].className.indexOf('is-unknown') > -1 && cells(win, 2)[1] === '未指定',
        cells(win, 2)[1]);
    check('KPI：6 / 4 / 66.7% / 1 / 3',
        text(win, '#wlKpiOrders') === '6' && text(win, '#wlKpiDone') === '4' &&
        text(win, '#wlKpiRate') === '66.7%' && text(win, '#wlKpiOverdue') === '1' &&
        text(win, '#wlKpiPeople') === '3',
        [text(win, '#wlKpiOrders'), text(win, '#wlKpiDone'), text(win, '#wlKpiRate'),
         text(win, '#wlKpiOverdue'), text(win, '#wlKpiPeople')].join('/'));
    check('KPI 副标题交代覆盖计划数与处理中/待处理',
        text(win, '#wlKpiOrdersSub') === '覆盖 2 个计划' &&
        text(win, '#wlKpiPeopleSub') === '处理中 1 · 待处理 1',
        text(win, '#wlKpiOrdersSub') + ' / ' + text(win, '#wlKpiPeopleSub'));
    check('工具栏提示的覆盖计划数 = 2', text(win, '#wlPlanCount') === '2', text(win, '#wlPlanCount'));
    check('区间文案「共 N 天（起 ~ 止）」',
        /^共 \d+ 天（\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}）$/.test(text(win, '#wlRangeText') || ''),
        text(win, '#wlRangeText'));
    check('排序按钮默认在「接单数」上且为降序',
        win.jQuery('#wlTable th[data-sort="orderCount"]').hasClass('is-desc') &&
        text(win, '#wlSortText') === '接单数',
        text(win, '#wlSortText'));
    check('不足一页补空行（10 行 = 3 数据行 + 7 空行）',
        win.document.querySelectorAll('#wlTbody tr').length === 10,
        win.document.querySelectorAll('#wlTbody tr').length);
    check('下拉里带「全部项目」选项',
        win.jQuery('#wlProject option').length >= 1 &&
        win.jQuery('#wlProject option').eq(0).val() === '', win.jQuery('#wlProject option').length);
    check('页面加载后三枚按钮都在（btnperm 未把它们藏掉）',
        ['wlBtnRefresh', 'wlBtnExport', 'wlBtnMine'].every(function (id) {
            return !!win.document.getElementById(id);
        }));

    /* ================= 5. 交互：排序 / 快捷区间 / 仅看我的 / 关键字 / 重置 ================= */
    console.log('\n--- 5. 交互 ---');
    win.jQuery('#wlTable th[data-sort="doneRate"]').trigger('click');
    await until(function () { return cells(win, 0)[1].indexOf(emps[1].nameCn) > -1; }, 3000);
    check('点「完成率」表头 → B（100%）升到第一',
        cells(win, 0)[1].indexOf(emps[1].nameCn) > -1, cells(win, 0)[1]);
    check('表头箭头切到完成率降序 + 工具栏文案跟随',
        win.jQuery('#wlTable th[data-sort="doneRate"]').hasClass('is-desc') &&
        !win.jQuery('#wlTable th[data-sort="orderCount"]').hasClass('is-desc') &&
        text(win, '#wlSortText') === '完成率', text(win, '#wlSortText'));

    win.jQuery('#wlTable th[data-sort="doneRate"]').trigger('click');
    await until(function () { return cells(win, 0)[1].indexOf(emps[0].nameCn) > -1; }, 3000);
    check('再点一次 → 升序，A（66.7%）在前',
        cells(win, 0)[1].indexOf(emps[0].nameCn) > -1 &&
        win.jQuery('#wlTable th[data-sort="doneRate"]').hasClass('is-asc'), cells(win, 0)[1]);

    win.jQuery('#wlQuick .wl-quick__btn[data-quick="lastMonth"]').trigger('click');
    await until(function () { return win.jQuery('.table-card').hasClass('is-empty'); }, 3000);
    check('点「上月」→ 日期自动回填上月首末日',
        /^\d{4}-\d{2}-01$/.test(win.jQuery('#wlStart').val()) &&
        win.jQuery('#wlEnd').val() < range.startDate,
        win.jQuery('#wlStart').val() + ' ~ ' + win.jQuery('#wlEnd').val());
    check('无数据时表格置 is-empty、空态露出（CSS 隐藏表格）',
        win.jQuery('.table-card').hasClass('is-empty') &&
        !win.document.querySelector('#wlEmpty').hasAttribute('hidden') &&
        rowsOf(win).length === 0);
    check('空态时 KPI 归零并显示「—」',
        text(win, '#wlKpiOrders') === '0' && text(win, '#wlKpiRate') === '—',
        text(win, '#wlKpiOrders') + '/' + text(win, '#wlKpiRate'));
    check('空态时点导出只提示、不打开新窗口', (function () {
        win.jQuery('#wlBtnExport').trigger('click');
        return win.openCalls.length === 0;
    })(), win.openCalls.join(','));

    win.jQuery('#wlQuick .wl-quick__btn[data-quick="month"]').trigger('click');
    await until(function () { return rowsOf(win).length === 3; }, 3000);
    check('点「本月」→ 数据回来且按钮高亮回本月',
        rowsOf(win).length === 3 &&
        win.jQuery('#wlQuick .wl-quick__btn[data-quick="month"]').hasClass('is-active'), rowsOf(win).length);

    win.jQuery('#wlBtnMine').trigger('click');
    await until(function () { return rowsOf(win).length === 1; }, 3000);
    check('「仅看我的」→ 只剩登录人 B 一行，按钮高亮',
        rowsOf(win).length === 1 && cells(win, 0)[1].indexOf(emps[1].nameCn) > -1 &&
        win.jQuery('#wlBtnMine').hasClass('is-active'),
        rowsOf(win).length + ' / ' + cells(win, 0)[1]);
    win.jQuery('#wlBtnMine').trigger('click');
    await until(function () { return rowsOf(win).length === 3; }, 3000);
    check('再点一次恢复全部员工', rowsOf(win).length === 3 && !win.jQuery('#wlBtnMine').hasClass('is-active'));

    win.jQuery('#wlKeyword').val(emps[0].code);
    win.jQuery('#wlKeyword').trigger(win.jQuery.Event('keydown', { keyCode: 13 }));
    await until(function () { return rowsOf(win).length === 1; }, 3000);
    check('关键字输入工号 + 回车 → 只留该员工',
        rowsOf(win).length === 1 && cells(win, 0)[1].indexOf(emps[0].code) > -1, rowsOf(win).length);

    win.jQuery('#wlBtnReset').trigger('click');
    await until(function () { return rowsOf(win).length === 3; }, 3000);
    check('重置 → 关键字清空、排序回接单数降序、3 行',
        win.jQuery('#wlKeyword').val() === '' && rowsOf(win).length === 3 &&
        win.jQuery('#wlTable th[data-sort="orderCount"]').hasClass('is-desc'),
        win.jQuery('#wlKeyword').val() + ' / ' + rowsOf(win).length);

    /* ================= 6. 钻取弹窗 ================= */
    console.log('\n--- 6. 钻取弹窗 ---');
    win.jQuery(rowsOf(win)[0]).trigger('click');
    await until(function () { return win.document.querySelectorAll('#wlDetailBody tr').length > 0; }, 4000);
    var dlg = win.document.querySelector('.el-dialog');
    var dlgTitle = dlg ? (dlg.querySelector('.el-dialog__title') || {}).textContent || '' : '';
    check('点行弹出「工单明细」弹窗，标题带姓名与区间',
        !!dlg && dlgTitle.indexOf('工单明细') > -1 && dlgTitle.indexOf(emps[0].nameCn) > -1,
        dlgTitle);
    check('弹窗头显示接单 / 已完成 / 按期率 / 逾期 / 平均耗时',
        /接单\s*3/.test(dlg.textContent) && /已完成\s*2（66\.7%）/.test(dlg.textContent) &&
        /按期率\s*50%/.test(dlg.textContent) && /平均耗时\s*0\s*天/.test(dlg.textContent),
        (dlg.querySelector('.wl-detail__head') || {}).textContent);
    check('明细表 9 列 + 3 行数据',
        dlg.querySelectorAll('.wl-detail__table thead th').length === 9 &&
        win.document.querySelectorAll('#wlDetailBody tr').length === 3,
        dlg.querySelectorAll('.wl-detail__table thead th').length + ' / ' +
        win.document.querySelectorAll('#wlDetailBody tr').length);
    check('逾期行带 is-overdue + 「已逾期」标签，已完成行「已完成」',
        dlg.querySelectorAll('#wlDetailBody tr.is-overdue').length === 1 &&
        /已逾期/.test(dlg.textContent) && /已完成/.test(dlg.textContent));
    check('耗时列：已完成给「0 天」，未完成给「—」',
        /0 天/.test(dlg.textContent) && /—/.test(dlg.textContent));
    check('只读弹窗：确定按钮隐藏、「取消」改成「关闭」',
        win.jQuery(dlg).find('.btn-ok').css('display') === 'none' &&
        win.jQuery(dlg).find('.btn-cancel').text() === '关闭',
        win.jQuery(dlg).find('.btn-cancel').text());
    check('每行都能「看计划」+「打开任务」',
        dlg.querySelectorAll('.wl-go-plan').length === 3 && dlg.querySelectorAll('.wl-go-task').length === 3,
        dlg.querySelectorAll('.wl-go-plan').length + '/' + dlg.querySelectorAll('.wl-go-task').length);

    win.jQuery(dlg.querySelector('.wl-go-plan')).trigger('click');
    check('点「看计划」跳到计划工单页并带上 planId',
        win.__nav === 'workplan-orders.html?planId=PLAN-A' ||
        (win.__nav && win.__nav.indexOf('workplan-orders.html?planId=PLAN-A') === 0), win.__nav);
    win.jQuery(dlg.querySelector('.wl-go-task')).trigger('click');
    check('点「打开任务」跳到设计器并带上 planId + taskId',
        win.__nav && win.__nav.indexOf('workplan-design.html?id=PLAN-A&taskId=') === 0, win.__nav);

    var dlgClose = win.jQuery(dlg).find('.btn-cancel');
    dlgClose.trigger('click');

    /* ================= 7. 导出 ================= */
    console.log('\n--- 7. 导出 ---');
    win.jQuery('#wlBtnExport').trigger('click');
    check('点导出打开 /api/workload/export 并带上区间 / token',
        win.openCalls.length === 1 &&
        win.openCalls[0].indexOf('/api/workload/export?') === 0 &&
        win.openCalls[0].indexOf('startDate=') > -1 && win.openCalls[0].indexOf('endDate=') > -1 &&
        win.openCalls[0].indexOf('token=') > -1, win.openCalls[0]);

    /* ================= 8. ES5 ================= */
    console.log('\n--- 8. 脚本风格（ES5） ---');
    check('workload-report.js 不用 let / const',
        !/(^|[\s;({])let\s+[A-Za-z_$]/.test(pageJs) && !/(^|[\s;({])const\s+[A-Za-z_$]/.test(pageJs));
    check('workload-report.js 不用箭头函数 / 模板串 / 反引号',
        pageJs.indexOf('=>') === -1 && pageJs.indexOf('`') === -1);
    check('api.js 的 Mock 服务同样保持 ES5',
        apiJs.indexOf('createWorkloadMockService') > -1);

    console.log('\n结果：%d 通过 / %d 失败', pass, fail);
    process.exit(fail ? 1 : 0);
})();
