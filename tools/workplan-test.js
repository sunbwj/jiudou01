/* ==========================================================================
   workplan-test.js —— 工作计划（Visio 风格甘特图）jsdom 回归
   --------------------------------------------------------------------------
   覆盖：
     ① Mock 服务：可见性 / 整图保存 / 自动扩展日期 / 依赖环 / 编号 / 删除；
     ② 列表页 workplan.html：10 列 / 工具栏禁用态 / 行内完成度 / 新建「甘特图选项」对话框；
     ③ 设计器 workplan-design.html：双层时间刻度 / 任务条 / 里程碑 / 摘要 / 完成百分比 /
        非工作日 / 今日线 / 依赖箭头 / 选中联动 / 新增 / 属性 / 前置依赖 / 拖拽改期 / 保存；
     ④ 静态资源与数据库脚本口径。
   运行：NODE_PATH=C:/Users/chx/.workbuddy/binaries/node/workspace/node_modules node tools/workplan-test.js
   ========================================================================== */
'use strict';
process.on('unhandledRejection', function () { /* 页面异步桩不影响结论 */ });
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
/** 全站共享的 api.js 版本：从 main.html 现取，升版时不用逐个测试改硬编码 */
var SHARED_API_V = (read('main.html').match(/js\/api\.js\?v=([0-9a-z]+)/) || [])[1] || '';
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(cond, ms) {
    var end = Date.now() + (ms || 2500);
    while (Date.now() < end) {
        if (cond()) { return true; }
        await wait(20);
    }
    return false;
}
function apiDone(promise, cb) {
    return new Promise(function (resolve) {
        promise.done(function (data) { if (cb) { cb(null, data); } resolve(data); })
            .fail(function (err) { if (cb) { cb(err); } resolve(null); });
    });
}

if (!JSDOM) { console.log('未安装 jsdom，跳过'); process.exit(0); }

var P1 = 'wpl-0000-4000-8000-000000000001';
var T2 = 'wpt-0000-4000-8000-000000000002';

function boot(page, scripts, url) {
    var dom = new JSDOM(read(page), {
        url: url || ('http://127.0.0.1:8808/' + page),
        runScripts: 'outside-only', pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.jQuery.ajax = function () {
        var d = win.jQuery.Deferred(); d.reject({}, 'error', ''); return d.promise();
    };
    win.localStorage.setItem('menu_admin_login_v1',
        JSON.stringify({ token: 'mock', user: { empId: 3, nameCn: '杨伟康' } }));
    win.eval(read('js/api.js'));
    win.Api.config.useMock = true;
    win.Api.config.delay = 1;
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/btnperm.js'));
    win.AppNav = win.AppNav || {};
    win.AppNav.go = function (u) { win.__nav = u; };
    scripts.forEach(function (s) { win.eval(read(s)); });
    return win;
}
/** 派发带 clientX 的真实鼠标事件（jQuery 委托 + document 监听都能收到） */
function mouse(win, target, type, x) {
    var ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10 });
    (target === win.document ? win.document : target).dispatchEvent(ev);
}

(async function () {
    /* ================= 1. Mock 服务 ================= */
    console.log('\n--- 1. 工作计划 Mock 服务 ---');
    var wm = boot('workplan.html', []);
    var A = wm.Api.workPlan;
    var list = await apiDone(A.page({ pageNum: 1, pageSize: 50 }));
    check('列表只返回本人 + 公用计划（2 条，他人私有不可见）',
        !!list && list.total === 2 && list.list.length === 2,
        list && JSON.stringify(list.list.map(function (x) { return x.planCode; })));
    var row1 = list && list.list.filter(function (x) { return x.id === P1; })[0];
    check('列表带任务数与平均完成度', !!row1 && row1.taskCount === 7 &&
        typeof row1.progress === 'number', row1 && JSON.stringify(row1));
    var detail = await apiDone(A.detail(P1));
    check('详情返回 plan + 7 条任务', !!detail && detail.tasks.length === 7 &&
        detail.plan.planCode === 'WP000001');
    check('种子含摘要 / 里程碑 / 前置依赖 / 完成百分比',
        !!detail && detail.tasks.some(function (t) { return t.taskType === 'summary'; }) &&
        detail.tasks.filter(function (t) { return t.taskType === 'milestone'; }).length === 2 &&
        detail.tasks.some(function (t) { return String(t.preTaskIds).length > 0; }) &&
        detail.tasks.some(function (t) { return t.progress === 100; }));
    var nc = await apiDone(A.nextCode());
    check('编号预览 WP000004', !!nc && nc.code === 'WP000004', nc && nc.code);

    var saved = await apiDone(A.save({
        plan: { id: P1, planName: '四季度产品迭代工作计划', scale: 'week', startDate: '', endDate: '' },
        tasks: [
            { id: 'wpt-0000-4000-8000-000000000101', taskName: '任务A', taskType: 'task',
              startDate: '2027-01-05', endDate: '2027-01-09', progress: 20 },
            { id: 'wpt-0000-4000-8000-000000000102', taskName: '里程碑B', taskType: 'milestone',
              startDate: '2027-01-12', endDate: '2027-01-20', progress: 0,
              preTaskIds: 'wpt-0000-4000-8000-000000000101' }
        ]
    }));
    check('整图保存返回新任务数', !!saved && saved.taskCount === 2, saved && saved.taskCount);
    var after = await apiDone(A.detail(P1));
    check('任务全量替换（旧的 7 条被清掉）', !!after && after.tasks.length === 2);
    check('里程碑工期强制为 0（结束 = 开始）',
        !!after && after.tasks[1].startDate === '2027-01-12' && after.tasks[1].endDate === '2027-01-12');
    check('计划日期范围自动延伸到任务边界',
        !!after && after.plan.startDate === '2027-01-05' && after.plan.endDate === '2027-01-12',
        after && (after.plan.startDate + '~' + after.plan.endDate));
    var cycle = await new Promise(function (resolve) {
        A.save({ plan: { id: P1, planName: '环检测' }, tasks: [
            { id: 'wpt-0000-4000-8000-000000000201', taskName: 'A', preTaskIds: 'wpt-0000-4000-8000-000000000202' },
            { id: 'wpt-0000-4000-8000-000000000202', taskName: 'B', preTaskIds: 'wpt-0000-4000-8000-000000000201' }
        ] }).done(function () { resolve(null); }).fail(function (e) { resolve(e); });
    });
    check('循环依赖被拒绝', !!cycle && /循环/.test(cycle.message), cycle && cycle.message);
    var bad = await new Promise(function (resolve) {
        A.add({ planName: '' }).done(function () { resolve(null); }).fail(function (e) { resolve(e); });
    });
    check('空计划名被拒绝', !!bad && /名称/.test(bad.message), bad && bad.message);
    var added = await apiDone(A.add({ planName: '临时计划', startDate: '2026-12-01', endDate: '2026-12-31' }));
    check('新建计划返回 WP 编号', !!added && /^WP\d{6}$/.test(added.planCode), added && added.planCode);
    var removed = await apiDone(A.remove(added.id));
    check('删除计划返回任务数', !!removed && removed.deleted === 1 && removed.taskCount === 0);

    /* 责任人 / 参与人员：整图保存后要能原样读回（ID 与姓名按下标对齐） */
    var peopleSaved = await apiDone(A.save({
        plan: { id: P1, planName: '四季度产品迭代工作计划', scale: 'week' },
        tasks: [{
            id: 'wpt-0000-4000-8000-000000000301', taskName: '责任人联调', taskType: 'task',
            startDate: '2027-02-01', endDate: '2027-02-05', progress: 10,
            ownerId: 3, ownerName: '杨伟康',
            participantIds: ['2', '3', '2'], participantNames: ['李明', '杨伟康', '李明']
        }]
    }));
    check('Mock 整图保存带责任人 / 参与人员不报错', !!peopleSaved && peopleSaved.taskCount === 1);
    var peopleBack = await apiDone(A.detail(P1));
    var pt = peopleBack && peopleBack.tasks[0];
    check('Mock 回读 ownerId / ownerName', !!pt && pt.ownerId === 3 && pt.ownerName === '杨伟康',
        pt && JSON.stringify(pt));
    check('Mock 参与人员按 ID 去重且姓名对齐（重名不误删）',
        !!pt && pt.participantIds === '2,3' && pt.participantNames === '李明,杨伟康',
        pt && (pt.participantIds + ' / ' + pt.participantNames));

    /* 选人数据源：组织树 + 员工信息表 + 项目组成员 */
    var people = await apiDone(A.people({ projectId: 'prj-0000-4000-8000-000000000001' }));
    check('people 一次返回组织树 / 员工信息表 / 项目组成员',
        !!people && people.orgs.length > 0 && people.employees.length > 0 &&
        people.members.length > 0 && people.memberCount === people.members.length,
        people && JSON.stringify({ o: people.orgs.length, e: people.employees.length,
                                   m: people.members.length }));
    check('people 组织节点带 parentId / level（前端可按层次展开）',
        !!people && people.orgs.every(function (o) {
            return o.parentId !== undefined && o.level >= 1 && o.nameCn;
        }));
    check('people 员工带部门 / 在职状态 / 邮箱（离职可置灰、有邮箱才发信）',
        !!people && people.employees.every(function (e) {
            return e.id && e.nameCn && e.deptId !== undefined && e.status !== undefined;
        }) && people.employees.some(function (e) { return !!e.email; }));
    check('项目组成员来自 projectmembers 且标记 fromGroup',
        !!people && people.members.every(function (m) { return m.fromGroup === true; }));
    var peopleNoProject = await apiDone(A.people({ projectId: '' }));
    check('未关联项目时项目组成员为空（不强制关联）',
        !!peopleNoProject && peopleNoProject.members.length === 0 &&
        peopleNoProject.employees.length > 0);

    /* 启动：一任务一工单 + 责任人与参与人员的消息 / 邮件 + 我的任务 */
    var started = await apiDone(A.start(P1));
    check('启动按每个任务生成一张工单',
        !!started && started.created === 1 && started.status === '已启动',
        started && JSON.stringify(started));
    check('启动给责任人 + 参与人员同时发即时消息与邮件',
        !!started && started.receivers === 2 && started.notified === 2 && started.mailed === 2,
        started && JSON.stringify({ r: started.receivers, n: started.notified, m: started.mailed }));
    var planBack = await apiDone(A.detail(P1));
    check('启动后计划状态回读为「已启动」',
        !!planBack && planBack.plan.status === '已启动', planBack && planBack.plan.status);
    var orders = await apiDone(A.orders({ pageNum: 1, pageSize: 50 }));
    check('我的任务包含责任人工单（WO 编号 / 角色 / 通知标记 / 打开链接）',
        !!orders && orders.total === 1 && /^WO\d{6}$/.test(orders.list[0].orderCode) &&
        orders.list[0].role === '责任人' && orders.list[0].sourceType === '工作计划' &&
        orders.list[0].noticeMsg === true && orders.list[0].noticeMail === true &&
        orders.list[0].link.indexOf('workplan-design.html?id=') === 0,
        orders && JSON.stringify(orders.list[0]));
    var roleOwner = await apiDone(A.orders({ role: '责任人' }));
    var rolePart = await apiDone(A.orders({ role: '参与人员' }));
    check('我的任务可按角色筛选',
        !!roleOwner && roleOwner.total === 1 && !!rolePart && rolePart.total === 0,
        roleOwner && (roleOwner.total + ' / ' + (rolePart && rolePart.total)));
    var againErr = null;
    await new Promise(function (resolve) {
        A.start(P1).done(function (data) { resolve(data); })
            .fail(function (err) { againErr = err; resolve(null); });
    });
    check('已启动的计划不能重复启动（返回明确错误）',
        !!againErr && /已启动/.test(againErr.message || ''),
        againErr && JSON.stringify(againErr));
    var delPlan = await apiDone(A.add({ planName: '启动后删除的计划' }));
    await apiDone(A.save({
        plan: { id: delPlan.id, planName: '启动后删除的计划' },
        tasks: [{ id: 'wpt-0000-4000-8000-000000000401', taskName: '待清理任务',
                  startDate: '2027-03-01', endDate: '2027-03-02', ownerId: 3 }]
    }));
    await apiDone(A.start(delPlan.id));
    var beforeDel = await apiDone(A.orders({}));
    await apiDone(A.stop(delPlan.id));          // 执行中不能删除，先停止
    await apiDone(A.remove(delPlan.id));
    var afterDel = await apiDone(A.orders({}));
    check('删除计划时清理其工单，任务列表不残留孤儿记录',
        !!beforeDel && !!afterDel && beforeDel.total === orders.total + 1 &&
        afterDel.total === orders.total,
        beforeDel && (beforeDel.total + ' → ' + (afterDel && afterDel.total)));

    /* ================= 2. 列表页 ================= */
    console.log('\n--- 2. 工作计划列表页 ---');
    var w1 = boot('workplan.html', ['js/workplan.js']);
    var $1 = w1.jQuery;
    await until(function () { return $1('#wpTbody tr[data-id]').length > 0; });
    check('页面标题 / 面包屑 / 页内左菜单改名为「计划管理」',
        $1('.page-head__title').text() === '计划管理' &&
        $1('#pageHead').attr('data-crumb') === '项目管理/计划管理' &&
        $1('title').text().indexOf('计划管理') > -1 &&
        $1('.app-side__item[href="workplan.html"]').text().replace(/\s+/g, '') === '计划管理',
        $1('.page-head__title').text() + ' / ' + $1('.app-side__item[href="workplan.html"]').text());
    check('顶部功能说明卡已移除（.pj-tipcard / .pj-tip 均为 0，搜索卡紧跟页头）',
        $1('.pj-tipcard').length === 0 && $1('.pj-tip').length === 0 &&
        $1('#pageHead + .search-card').length === 1,
        String($1('.pj-tipcard').length) + ' / ' + String($1('.pj-tip').length));
    check('11 列表头（含启动状态列）', $1('#wpTable thead th').length === 11,
        $1('#wpTable thead th').length);
    check('工具栏含新建 / 打开 / 启动 / 我的任务 / 删除 / 刷新 + 计数',
        ['#wpBtnAdd', '#wpBtnOpen', '#wpBtnStart', '#wpBtnMyTask', '#wpBtnDelete', '#wpBtnRefresh']
            .every(function (id) { return $1(id).length === 1; }) && $1('#wpCount').length === 1);
    var iconBad = [];
    $1('.wp-toolbar .el-button').each(function () {
        var t = String($1(this).text()).trim(), id = $1(this).attr('id');
        if (!$1(this).hasClass('el-button--icon')) { iconBad.push('class:' + id); }
        if ($1(this).find('svg.svg-ico').length !== 1) { iconBad.push('svg:' + id); }
        if (t !== '') { iconBad.push('text:' + t); }
        if (!$1(this).attr('title')) { iconBad.push('title:' + id); }
        if (!$1(this).attr('aria-label')) { iconBad.push('aria:' + id); }
    });
    check('列表页引导区为纯图标按钮（无可见文字，图标 + title 提示齐全）',
        $1('.wp-toolbar').hasClass('wp-toolbar--icons') &&
        $1('.wp-toolbar .el-button').length === 8 && iconBad.length === 0,
        iconBad.join(',') + ' / ' + $1('.wp-toolbar .el-button').length + ' 个按钮');
    check('未选中时打开 / 启动 / 停止 / 删除 / 工单禁用',
        $1('#wpBtnOpen').prop('disabled') === true &&
        $1('#wpBtnStart').prop('disabled') === true &&
        $1('#wpBtnStop').prop('disabled') === true &&
        $1('#wpBtnDelete').prop('disabled') === true &&
        $1('#wpBtnOrders').prop('disabled') === true);
    check('列表行显示编号 / 名称 / 任务数 / 完成度条',
        $1('#wpTbody').text().indexOf('WP000001') > -1 &&
        $1('#wpTbody').text().indexOf('四季度产品迭代') > -1 &&
        $1('#wpTbody .wp-progress').length > 0);
    check('列表行显示启动状态徽标', $1('#wpTbody .wp-status').length > 0 &&
        $1('#wpTbody .wp-status').eq(0).text().length > 0);
    $1('#wpTbody tr[data-id="' + P1 + '"]').trigger('click');
    check('选中行后按钮启用', $1('#wpBtnOpen').prop('disabled') === false &&
        $1('#wpBtnStart').prop('disabled') === false &&
        $1('#wpBtnDelete').prop('disabled') === false);
    $1('#wpTbody tr[data-id="' + P1 + '"]').trigger('dblclick');
    check('双击打页到设计器',
        String(w1.__nav || '').indexOf('workplan-design.html?id=' + P1) === 0, String(w1.__nav));

    $1('#wpBtnAdd').trigger('click');
    var $dlg = $1('.el-dialog');
    check('新建对话框：Visio 甘特图选项字段齐全',
        ['#wpNewName', '#wpNewCode', '#wpNewProject', '#wpNewStart', '#wpNewEnd',
         '#wpNewScale', '#wpNewPub', '#wpNewWeekend', '#wpNewDesc']
            .every(function (id) { return $dlg.find(id).length === 1; }));
    check('时间刻度含日 / 周 / 月', $dlg.find('#wpNewScale option').length === 3 &&
        $dlg.find('#wpNewScale').val() === 'week');
    check('日期范围有默认值（今天 ~ +30 天）', !!$dlg.find('#wpNewStart').val() &&
        !!$dlg.find('#wpNewEnd').val());
    await until(function () { return !!$dlg.find('#wpNewCode').val(); });
    check('编号预览回填 WP + 6 位', /^WP\d{6}$/.test($dlg.find('#wpNewCode').val()),
        $dlg.find('#wpNewCode').val());
    var addPayload = null;
    w1.Api.workPlan.add = function (data) {
        addPayload = data;
        var d = $1.Deferred(); d.resolve({ id: 'new-plan-id', planCode: 'WP000009', message: 'ok' });
        return d.promise();
    };
    /* 关联项目：必须等异步的 /project/options 回填（弹窗 DOM 在 onReady 时才插入） */
    await until(function () { return $dlg.find('#wpNewProject option').length > 1; }, 3000);
    var projOpts = $dlg.find('#wpNewProject option').map(function () {
        return String($1(this).val());
    }).get();
    check('关联项目下拉从数据库取到已启用的项目',
        projOpts.indexOf('prj-0000-4000-8000-000000000001') > -1 &&
        projOpts.indexOf('prj-0000-4000-8000-000000000002') > -1,
        JSON.stringify(projOpts));
    check('保留「不关联（通用工作计划）」空选项',
        $dlg.find('#wpNewProject option').eq(0).val() === '' &&
        $dlg.find('#wpNewProject option').eq(0).text().indexOf('不关联') > -1);
    check('停用项目与他人私有项目不出现在下拉',
        projOpts.indexOf('prj-0000-4000-8000-000000000003') < 0 &&
        projOpts.indexOf('prj-0000-4000-8000-000000000004') < 0, JSON.stringify(projOpts));
    var $pro = $dlg.find('#wpNewProject option[value="prj-0000-4000-8000-000000000001"]');
    check('项目选项带编号标签 + data-name 纯名称',
        $pro.length === 1 && $pro.text().indexOf('PRO000001') > -1 &&
        $pro.attr('data-name') === '九豆综合管理平台研发', $pro.text());
    check('计划说明区加高（rows=7）且下方提示文案已移除',
        $dlg.find('#wpNewDesc').attr('rows') === '7' &&
        $dlg.find('#wpNewDesc').hasClass('wp-new-desc') &&
        $dlg.find('.wp-hintline').length === 0 &&
        $dlg.text().indexOf('确定后进入 Visio 风格设计器') < 0);
    $dlg.find('#wpNewProject').val('prj-0000-4000-8000-000000000001');
    $dlg.find('#wpNewName').val('测试新建计划');
    $dlg.find('.btn-ok').trigger('click');
    check('新建提交带名称 / 刻度 / 非工作日 / 公用',
        !!addPayload && addPayload.planName === '测试新建计划' && addPayload.scale === 'week' &&
        addPayload.skipWeekend === 1 && addPayload.ispub === 1, JSON.stringify(addPayload));
    check('关联项目写 id + 纯项目名（不写编号前缀）',
        !!addPayload && addPayload.projectId === 'prj-0000-4000-8000-000000000001' &&
        addPayload.projectName === '九豆综合管理平台研发',
        addPayload && (addPayload.projectId + ' / ' + addPayload.projectName));
    check('新建成功后跳设计器',
        String(w1.__nav || '').indexOf('workplan-design.html?id=new-plan-id') === 0, String(w1.__nav));

    /* 已启动的计划：启动按钮自动切成「补派新任务」图标（播放键 + 加号）与对应提示 */
    await apiDone(w1.Api.workPlan.start(P1));
    $1('#wpTbody').empty();
    $1('#wpBtnRefresh').trigger('click');
    await until(function () {
        return $1('#wpTbody tr[data-id="' + P1 + '"] .wp-status').text().indexOf('已启动') > -1;
    }, 3000);
    $1('#wpTbody tr[data-id="' + P1 + '"]').trigger('click');
    check('已启动计划把启动按钮切为「补派新任务」图标（仍无文字）',
        ($1('#wpBtnStart').attr('title') || '').indexOf('补派') > -1 &&
        $1('#wpBtnStart').attr('aria-label') === '补派新任务' &&
        $1('#wpBtnStart').find('svg.svg-ico path').length === 2 &&
        String($1('#wpBtnStart').text()).trim() === '' && !$1('#wpBtnStart').prop('disabled'),
        $1('#wpBtnStart').attr('title'));

    /* ================= 3. 设计器 ================= */
    console.log('\n--- 3. Visio 风格设计器 ---');
    var w2 = boot('workplan-design.html', ['js/wp-emp-picker.js', 'js/workplan-design.js'],
        'http://127.0.0.1:8808/workplan-design.html?id=' + P1);
    var $2 = w2.jQuery;
    await until(function () { return $2('#wpDCanvas .wp-grid__row').length > 0; });
    check('默认以网格列表展示（视图按钮高亮网格）',
        $2('#wpDViewBar .is-active').attr('data-view') === 'grid' &&
        $2('#wpDCanvas .wp-grid').length === 1, $2('#wpDViewBar .is-active').attr('data-view'));
    $2('#wpDViewBar [data-view="gantt"]').trigger('click');
    await until(function () { return $2('#wpDCanvas .wp-row').length > 0; });
    check('计划信息回填（编号 / 名称 / 刻度 / 非工作日 / 公用）',
        $2('#wpDCode').text() === 'WP000001' && $2('#wpDName').val() === '四季度产品迭代工作计划' &&
        $2('#wpDScale').val() === 'week' && $2('#wpDWeekend').prop('checked') === true &&
        $2('#wpDPub').prop('checked') === true,
        $2('#wpDCode').text() + '/' + $2('#wpDName').val() + '/' + $2('#wpDScale').val());
    check('设计器有「启动计划 / 我的任务」入口与启动状态徽标',
        $2('#wpDBtnStart').length === 1 && $2('#wpDBtnMyTask').length === 1 &&
        $2('#wpDStatus').length === 1 && $2('#wpDStatus').text() === '未启动',
        $2('#wpDStatus').text());
    check('渲染 7 行任务 / 7 个任务条',
        $2('#wpDCanvas .wp-row').length === 7 && $2('#wpDCanvas .wp-bar').length === 7,
        $2('#wpDCanvas .wp-row').length + '/' + $2('#wpDCanvas .wp-bar').length);
    check('里程碑菱形 2 个 / 摘要汇总条 1 个',
        $2('#wpDCanvas .wp-bar--milestone').length === 2 &&
        $2('#wpDCanvas .wp-bar--summary').length === 1);
    check('完成百分比深色填充', $2('#wpDCanvas .wp-bar__fill').length === 4 &&
        $2('#wpDCanvas .wp-bar__fill').eq(0).attr('style').indexOf('100%') > -1,
        String($2('#wpDCanvas .wp-bar__fill').length));
    check('双层时间刻度（主要单位 + 次要单位）',
        $2('#wpDCanvas .wp-axis__major .wp-u--major').length > 0 &&
        $2('#wpDCanvas .wp-axis__minor .wp-u--minor').length > 0);
    check('非工作日灰底块 + 今日红线',
        $2('#wpDCanvas .wp-off').length > 0 && $2('#wpDCanvas .wp-today').length > 0);
    check('前置依赖箭头（5 条 path）',
        $2('#wpDCanvas .wp-links path[marker-end]').length === 5,
        String($2('#wpDCanvas .wp-links path[marker-end]').length));
    check('任务条带左右拖拽把手',
        $2('#wpDCanvas .wp-bar[data-id="' + T2 + '"] .wp-bar__handle--l').length === 1 &&
        $2('#wpDCanvas .wp-bar[data-id="' + T2 + '"] .wp-bar__handle--r').length === 1);
    check('选中前属性 / 依赖 / 删除按钮禁用',
        $2('#wpDBtnProp').prop('disabled') === true && $2('#wpDBtnLink').prop('disabled') === true);
    $2('#wpDCanvas .wp-row[data-id="' + T2 + '"]').trigger('click');
    check('单击行选中并启用属性 / 依赖 / 删除',
        $2('#wpDCanvas .wp-row[data-id="' + T2 + '"]').hasClass('is-selected') &&
        $2('#wpDBtnProp').prop('disabled') === false && $2('#wpDBtnDelete').prop('disabled') === false);

    /* 任务属性 */
    $2('#wpDBtnProp').trigger('click');
    var $p = $2('.el-dialog');
    check('任务属性对话框字段齐全（名称 / 类型 / 起止 / 工期 / 完成度 / 责任人 / 参与人员 / 上级 / 前置）',
        ['#wpTName', '#wpTType', '#wpTStart', '#wpTEnd', '#wpTDuration', '#wpTProgress',
         '#wpTOwner', '#wpTBtnOwner', '#wpTBtnOwnerClear', '#wpTParts', '#wpTBtnParts',
         '#wpTBtnPartsClear', '#wpTParent', '#wpTPre'].every(function (id) {
            return $p.find(id).length === 1;
        }));
    check('责任人 / 参与人员是只读姓名快照，由按钮触发选取',
        $p.find('#wpTOwner').prop('readonly') === true &&
        $p.find('#wpTParts').prop('readonly') === true &&
        $p.find('#wpTBtnOwner').text().indexOf('选取人员') > -1 &&
        $p.find('#wpTBtnParts').text().indexOf('选取人员') > -1);
    check('种子责任人 / 参与人员回填到任务属性',
        $p.find('#wpTOwner').val() === '杨伟康' &&
        $p.find('#wpTParts').val() === '李明、杨伟康',
        $p.find('#wpTOwner').val() + ' / ' + $p.find('#wpTParts').val());
    check('工期按起止算（需求调研 15 天）',
        $p.find('#wpTDuration').val() === '15 天', $p.find('#wpTDuration').val());

    /* 从任务属性里打开「参与人员」选人弹窗：组织架构树 / 双来源 / 多选 / 搜索 / 已选标签 */
    $p.find('#wpTBtnParts').trigger('click');
    var $ep = $2('.wp-emp-pick');
    check('选人组件弹窗已打开（双来源切换 / 组织树 / 搜索 / 已选区）',
        $ep.length === 1 && $ep.find('#wpEpTree').length === 1 &&
        $ep.find('.wp-ep-src[data-src="emp"]').length === 1 &&
        $ep.find('.wp-ep-src[data-src="group"]').length === 1 &&
        $ep.find('#wpEpKeyword').length === 1 && $ep.find('#wpEpChosen').length === 1 &&
        $ep.find('#wpEpSearch').length === 1);
    check('选人弹窗层级高于任务属性弹窗',
        $ep.closest('.el-overlay').css('z-index') === '2100',
        $ep.closest('.el-overlay').css('z-index'));
    await until(function () { return $ep.find('#wpEpTree .wp-ep-emp[data-id]').length > 0; });
    check('选人列表从 Api.workPlan.people 取到员工信息表',
        $ep.find('#wpEpTree .wp-ep-emp[data-id]').length > 0,
        String($ep.find('#wpEpTree .wp-ep-emp[data-id]').length));
    check('按组织架构树层次展示部门分组与部门下员工',
        $ep.find('#wpEpTree .wp-ep-dept').length > 1 &&
        $ep.find('#wpEpTree .wp-ep-emp[data-id]').length > 0,
        '部门 ' + $ep.find('#wpEpTree .wp-ep-dept').length);
    check('离职员工在树里置灰不可选',
        $ep.find('#wpEpTree .wp-ep-emp.is-disabled').length > 0);
    check('初始已选 2 人（来自任务属性回填）',
        $ep.find('#wpEpCount').text() === '2' &&
        $ep.find('#wpEpChosen .wp-emp-pick__tag').length === 2,
        $ep.find('#wpEpCount').text());
    /* 第二数据源：项目组成员，也按同一棵组织树展示 */
    $ep.find('.wp-ep-src[data-src="group"]').trigger('click');
    check('切到项目组成员来源后仍按组织树展示人员',
        $ep.find('.wp-ep-src[data-src="group"]').hasClass('is-active') &&
        $ep.find('#wpEpTree .wp-ep-dept').length > 0 &&
        $ep.find('#wpEpTree .wp-ep-emp[data-id]').length > 0);
    check('来源提示给出关联项目 / 成员数',
        $ep.find('#wpEpSrcTip').text().length > 0 && $ep.find('#wpEpTotal').text().indexOf('人') > -1,
        $ep.find('#wpEpSrcTip').text());
    $ep.find('.wp-ep-src[data-src="emp"]').trigger('click');
    check('切回员工信息表后来源高亮正确',
        $ep.find('.wp-ep-src[data-src="emp"]').hasClass('is-active'));
    /* 搜索：命中分支自动展开、无匹配部门隐藏 */
    $ep.find('#wpEpKeyword').val('张守正');
    $ep.find('#wpEpSearch').trigger('click');
    check('搜索只保留命中员工',
        $ep.find('#wpEpTree .wp-ep-emp[data-id]').length === 1,
        String($ep.find('#wpEpTree .wp-ep-emp[data-id]').length));
    $ep.find('#wpEpKeyword').val('');
    $ep.find('#wpEpSearch').trigger('click');
    /* 再选一位未选中的在职员工，验证多选累计 */
    var $candidate = $ep.find('#wpEpTree .wp-ep-emp[data-id]').filter(function () {
        return !$2(this).hasClass('is-selected') && !$2(this).hasClass('is-disabled');
    }).eq(0);
    var extraId = $candidate.attr('data-id');
    $candidate.trigger('click');
    check('多选：点选后已选人数 +1',
        extraId && $ep.find('#wpEpCount').text() === '3' &&
        $ep.find('#wpEpChosen .wp-emp-pick__tag[data-id="' + extraId + '"]').length === 1,
        extraId + ' / ' + $ep.find('#wpEpCount').text());
    /* 已选标签可单个移除 */
    $ep.find('#wpEpChosen [data-remove="' + extraId + '"]').trigger('click');
    check('已选标签可移除', $ep.find('#wpEpCount').text() === '2');
    /* 单选模式：责任人 */
    $ep.closest('.el-dialog').find('.btn-cancel').trigger('click');
    $p.find('#wpTBtnOwner').trigger('click');
    var $ep2 = $2('.wp-emp-pick');
    await until(function () { return $ep2.find('#wpEpTree .wp-ep-emp[data-id]').length > 0; });
    check('责任人选人是单选（radio）且带入当前责任人',
        $ep2.find('#wpEpTree input[type="radio"]').length > 0 &&
        $ep2.find('#wpEpCount').text() === '1',
        $ep2.find('#wpEpCount').text());
    var $radioRows = $ep2.find('#wpEpTree .wp-ep-emp[data-id]').filter(function () {
        return !$2(this).hasClass('is-disabled');
    });
    $radioRows.eq(0).trigger('click');
    $radioRows.eq(1).trigger('click');
    check('单选：重新点选会替换而不是累加', $ep2.find('#wpEpCount').text() === '1',
        $ep2.find('#wpEpCount').text());
    var ownerName = $ep2.find('#wpEpChosen .wp-emp-pick__tag').eq(0).text().replace('×', '');
    $ep2.closest('.el-dialog').find('.btn-ok').trigger('click');
    check('选人确定后回填责任人姓名', $p.find('#wpTOwner').val() === ownerName,
        $p.find('#wpTOwner').val() + ' / ' + ownerName);

    $p.find('#wpTName').val('需求调研（已改名）');
    $p.find('#wpTProgress').val(60);
    $p.find('.btn-ok').trigger('click');
    check('属性保存后就地更新任务名与完成度',
        $2('#wpDCanvas .wp-row__name[data-id="' + T2 + '"]').val() === '需求调研（已改名）' &&
        $2('#wpDCanvas .wp-bar[data-id="' + T2 + '"] .wp-bar__fill').attr('style').indexOf('60%') > -1);

    /* 前置依赖 */
    $2('#wpDBtnLink').trigger('click');
    var $lk = $2('.el-dialog');
    check('前置依赖弹窗列出其它任务（6 个可勾选）',
        $lk.find('.wp-link-pick').length === 6, String($lk.find('.wp-link-pick').length));
    $lk.find('.wp-link-pick').eq(0).prop('checked', true);
    $lk.find('.btn-ok').trigger('click');
    check('勾选后依赖箭头数量增加',
        $2('#wpDCanvas .wp-links path[marker-end]').length >= 6,
        String($2('#wpDCanvas .wp-links path[marker-end]').length));

    /* 新增 / 缩进 / 排序 / 删除 */
    var beforeAdd = $2('#wpDCanvas .wp-row').length;
    $2('#wpDBtnMilestone').trigger('click');
    check('新增里程碑：行数 +1 且类型为菱形',
        $2('#wpDCanvas .wp-row').length === beforeAdd + 1 &&
        $2('#wpDCanvas .wp-bar--milestone').length === 3);
    check('新增后自动选中', $2('#wpDBtnProp').prop('disabled') === false);
    $2('#wpDBtnIndent').trigger('click');
    check('缩进后有层级样式', $2('#wpDCanvas .wp-row__label[style*="padding-left: 20px"]').length > 0 ||
        $2('#wpDCanvas .wp-row__label').filter(function () {
            return /padding-left:\s*(2\d|3\d)px/.test($2(this).attr('style') || '');
        }).length > 0);
    var cntBeforeDel = $2('#wpDCanvas .wp-row').length;
    w2.UI.confirm = function () { var d = $2.Deferred(); d.resolve(true); return d.promise(); };
    $2('#wpDBtnDelete').trigger('click');
    check('删除任务后行数 -1', $2('#wpDCanvas .wp-row').length === cntBeforeDel - 1);

    /* 拖拽改期 */
    $2('#wpDCanvas .wp-row[data-id="' + T2 + '"]').trigger('click');
    var $bar = $2('#wpDCanvas .wp-bar[data-id="' + T2 + '"]');
    var startBefore = $2('#wpDCanvas .wp-row__name[data-id="' + T2 + '"]').val();
    mouse(w2, $bar[0], 'mousedown', 0);
    mouse(w2, w2.document, 'mousemove', 9);     // week 刻度：9px = 1 天
    mouse(w2, w2.document, 'mouseup', 9);
    check('拖拽后任务条位置变化（整体平移 1 天）',
        $2('#wpDCanvas .wp-bar[data-id="' + T2 + '"]').length === 1 &&
        $2('#wpDState').text().indexOf('已修改') > -1,
        $2('#wpDState').text() + ' / ' + startBefore);

    /* 保存整图 */
    var savePayload = null;
    w2.Api.workPlan.save = function (data) {
        savePayload = data;
        var d = $2.Deferred();
        d.resolve({ id: P1, planCode: 'WP000001', taskCount: data.tasks.length, message: '已保存' });
        return d.promise();
    };
    $2('#wpDBtnSave').trigger('click');
    check('保存提交 plan + tasks 整图',
        !!savePayload && !!savePayload.plan && Array.isArray(savePayload.tasks) &&
        savePayload.plan.planName === '四季度产品迭代工作计划' &&
        savePayload.tasks.length === 7,
        savePayload && (savePayload.plan.planName + '/' + savePayload.tasks.length));
    check('保存的任务含类型 / 日期 / 完成度 / 前置 / 排序 / 责任人 / 参与人员',
        !!savePayload && savePayload.tasks.every(function (t) {
            return t.id && t.taskName && t.startDate && t.endDate &&
                t.progress !== undefined && t.sortNo !== undefined && t.preTaskIds !== undefined &&
                t.ownerId !== undefined && t.ownerName !== undefined &&
                t.participantIds !== undefined && t.participantNames !== undefined;
        }));
    var savedT2 = savePayload && savePayload.tasks.filter(function (t) { return t.id === T2; })[0];
    check('选中的责任人（id + 姓名）进入保存数据',
        !!savedT2 && savedT2.ownerId > 0 && savedT2.ownerName === ownerName,
        savedT2 && (savedT2.ownerId + ' / ' + savedT2.ownerName));
    check('参与人员 ID / 姓名按下标对齐进入保存数据',
        !!savedT2 && String(savedT2.participantIds).split(',').length ===
            String(savedT2.participantNames).split(',').length,
        savedT2 && (savedT2.participantIds + ' / ' + savedT2.participantNames));
    check('拖拽后的新日期进入保存数据',
        !!savePayload && savePayload.tasks.filter(function (t) { return t.id === T2; })[0].startDate === '2026-10-02',
        savePayload && JSON.stringify(savePayload.tasks.filter(function (t) { return t.id === T2; })[0]));
    check('保存成功后状态回「已保存」', $2('#wpDState').text() === '已保存', $2('#wpDState').text());

    /* 启动：保存后点「启动计划」→ /workplan/start → 状态徽标变「已启动」 */
    var startPayload = null;
    w2.Api.workPlan.start = function (id) {
        startPayload = id;
        var d = $2.Deferred();
        d.resolve({ created: 7, notified: 9, mailed: 7, receivers: 9,
                    message: '已启动：派发工单 7 张' });
        return d.promise();
    };
    $2('#wpDBtnStart').trigger('click');
    check('保存后点「启动计划」调用 /workplan/start（带 planId）',
        startPayload === P1, String(startPayload));
    check('启动成功后状态徽标变「已启动」',
        $2('#wpDStatus').text() === '已启动' && $2('#wpDStatus').hasClass('is-on'),
        $2('#wpDStatus').text());
    $2('#wpDBtnMyTask').trigger('click');
    check('「我的任务」按钮跳到统一任务列表页',
        String(w2.__nav || '') === 'workplan-task.html', String(w2.__nav));

    /* 刻度切换 */
    $2('#wpDScale').val('day').trigger('change');
    check('切到「日」刻度后次要单位数量增加',
        $2('#wpDCanvas .wp-axis__minor .wp-u--minor').length > 20,
        String($2('#wpDCanvas .wp-axis__minor .wp-u--minor').length));

    /* ================= 3.5 我的任务页 ================= */
    console.log('\n--- 3.5 我的任务（统一工单列表）---');
    var w3 = boot('workplan-task.html', ['js/workplan-task.js']);
    var $3 = w3.jQuery;
    await apiDone(w3.Api.workPlan.start(P1));
    $3('#wtBtnRefresh').trigger('click');
    await until(function () { return $3('#wtTbody tr[data-id]').length > 0; }, 3000);
    check('我的任务页渲染工单行', $3('#wtTbody tr[data-id]').length > 0,
        String($3('#wtTbody tr[data-id]').length));
    check('任务行含工单编号 / 完成状态 / 关联标记 / 通知',
        $3('#wtTbody').text().indexOf('WO0') > -1 &&
        $3('#wtTbody .wp-exec-tag').length > 0 &&
        $3('#wtTbody').text().indexOf('已关联') > -1 &&
        $3('#wtTbody .wp-role').length > 0 &&
        $3('#wtTbody').text().indexOf('✓消息') > -1);
    check('我的任务表 15 列（序号 / 执行记录 / 变更历史），网格里不再有「操作」列',
        $3('#wtTable thead th').length === 15 &&
        $3('#wtTable thead th').eq(0).text() === '序号' &&
        $3('#wtTable thead').text().indexOf('操作') < 0 &&
        $3('#wtTbody [data-open]').length === 0 &&
        $3('#wtTbody [data-exec]').length === 0,
        String($3('#wtTable thead th').length) + ' 列');
    check('「打开任务」「执行记录」在引导区，未选中行时禁用',
        $3('#wtBtnOpenTask').length === 1 && $3('#wtBtnExec').length === 1 &&
        $3('#wtBtnOpenTask').prop('disabled') === true &&
        $3('#wtBtnExec').prop('disabled') === true &&
        $3('#wtPick').text() === '未选中行', $3('#wtPick').text());
    check('责任人 / 参与人员两种角色都能进入任务列表',
        $3('#wtTbody .wp-role.is-owner').length > 0 &&
        $3('#wtTbody .wp-role.is-part').length > 0,
        '责任人 ' + $3('#wtTbody .wp-role.is-owner').length +
        ' / 参与人 ' + $3('#wtTbody .wp-role.is-part').length);
    $3('#wtRole').val('参与人员');
    $3('#wtBtnSearch').trigger('click');
    await until(function () { return $3('#wtTbody tr[data-id]').length > 0 &&
        $3('#wtTbody .wp-role.is-owner').length === 0; }, 3000);
    check('按「我的角色=参与人员」筛选生效',
        $3('#wtTbody .wp-role.is-owner').length === 0 &&
        $3('#wtTbody .wp-role.is-part').length > 0,
        $3('#wtTbody').text().slice(0, 60));
    $3('#wtTbody tr[data-id]').eq(0).trigger('click');
    check('单击行选中，引导区按钮启用并显示当前选中工单',
        $3('#wtTbody tr.is-selected').length === 1 &&
        $3('#wtBtnOpenTask').prop('disabled') === false &&
        $3('#wtBtnExec').prop('disabled') === false &&
        $3('#wtPick').text().indexOf('WO0') > -1, $3('#wtPick').text());
    $3('#wtBtnOpenTask').trigger('click');
    check('「打开任务」跳到工作计划并带 taskId 定位',
        String(w3.__nav || '').indexOf('workplan-design.html?id=') === 0 &&
        String(w3.__nav || '').indexOf('&taskId=') > -1, String(w3.__nav));

    /* 执行记录回填：我的任务 → 关联任务 */
    var execPayload = null, ordersCalls = 0;
    var rawOrders = w3.Api.workPlan.orders;
    w3.Api.workPlan.orders = function (params) {
        ordersCalls++;
        return rawOrders(params);
    };
    w3.Api.workPlan.exec = function (data) {
        execPayload = data;
        var d = $3.Deferred(); d.resolve({ message: '执行记录已保存' }); return d.promise();
    };
    $3('#wtBtnExec').trigger('click');
    await until(function () { return $3('.el-dialog #wtExExec').length === 1; }, 3000);
    check('点「执行记录」先按工单号回读一次（弹窗取任务最新状态）',
        ordersCalls >= 1, String(ordersCalls));
    var $ex = $3('.el-dialog');
    check('执行记录弹窗字段齐全（完成状态 / 工单状态 / 实际起止 / 完成度 / 说明）',
        ['#wtExTitle', '#wtExExec', '#wtExStatus', '#wtExActualStart', '#wtExActualEnd',
         '#wtExProgress', '#wtExRemark'].every(function (k) { return $ex.find(k).length === 1; }));
    check('执行说明前面有换行占位（单独起一行）',
        $ex.find('#wtExRemark').prev().is('label') &&
        $ex.find('#wtExRemark').prev().prev().hasClass('wp-fill') &&
        $ex.find('#wtExRemark').hasClass('wp-span2'));
    $ex.find('#wtExExec').val('已完成');
    $ex.find('#wtExStatus').val('已完成');
    $ex.find('#wtExActualStart').val('2026-10-03');
    $ex.find('#wtExActualEnd').val('2026-10-14');
    $ex.find('#wtExRemark').val('需求调研已评审通过');
    $ex.find('.btn-ok').trigger('click');
    await until(function () { return !!execPayload; }, 2000);
    check('执行记录回填调用 Api.workPlan.exec（带 orderId 与执行字段）',
        !!execPayload && !!execPayload.orderId &&
        execPayload.execStatus === '已完成' &&
        execPayload.actualStartDate === '2026-10-03' &&
        execPayload.actualEndDate === '2026-10-14' &&
        execPayload.execRemark === '需求调研已评审通过',
        execPayload && JSON.stringify(execPayload));

    /* 检索区：说明卡已移除 + 新增「关联项目」筛选 */
    await until(function () { return $3('#wtProject option').length > 1; }, 3000);
    check('我的任务页去掉顶部说明卡，检索区新增「关联项目」下拉',
        $3('.pj-tipcard').length === 0 && $3('.pj-tip').length === 0 &&
        $3('#pageHead').next().hasClass('search-card') &&
        $3('#wtProject').length === 1 &&
        $3('#wtProject option').length > 1 &&
        $3('#wtProject option').eq(0).val() === '' &&
        $3('#wtProject option').eq(0).text() === '全部项目',
        'tip=' + $3('.pj-tipcard').length + ' / options=' + $3('#wtProject option').length);
    var lastOrdersParams = null;
    w3.Api.workPlan.orders = function (p) { lastOrdersParams = p; return rawOrders(p); };
    $3('#wtProject').val('prj-0000-4000-8000-000000000001').trigger('change');
    await until(function () { return $3('#wtTbody tr[data-id]').length > 0; }, 3000);
    check('切换「关联项目」触发重新查询并带上 projectId',
        !!lastOrdersParams && lastOrdersParams.projectId === 'prj-0000-4000-8000-000000000001',
        lastOrdersParams && JSON.stringify(lastOrdersParams));
    var rProj1 = await apiDone(rawOrders({ projectId: 'prj-0000-4000-8000-000000000001' }));
    var rProj2 = await apiDone(rawOrders({ projectId: 'prj-0000-4000-8000-000000000002' }));
    check('Mock /workplan/orders 按关联项目过滤（本项目有单 / 其它项目 0 条）',
        !!rProj1 && rProj1.total > 0 && !!rProj2 && rProj2.total === 0,
        (rProj1 && rProj1.total) + ' / ' + (rProj2 && rProj2.total));
    $3('#wtBtnReset').trigger('click');
    await until(function () { return $3('#wtProject').val() === ''; }, 2000);
    check('重置会清空项目筛选', $3('#wtProject').val() === '', String($3('#wtProject').val()));

    /* ================= 3.6 工作计划：三视图 / 执行记录 / 工单定位 ================= */
    console.log('\n--- 3.6 工作计划：三视图 + 执行记录 + 工单定位 ---');
    var w4 = boot('workplan-design.html',
        ['js/wp-emp-picker.js', 'js/workplan-design.js'],
        'http://127.0.0.1:8808/workplan-design.html?id=' + P1 + '&taskId=' + T2);
    var $4 = w4.jQuery;
    await until(function () { return $4('#wpDCanvas .wp-grid__row').length === 7; }, 3000);
    check('页面标题改为「工作计划」（面包屑保留 制定 层级）',
        $4('#pageHead').attr('data-crumb').indexOf('制定') > -1 &&
        $4('.page-head__title').text() === '工作计划' &&
        $4('title').text().indexOf('工作计划') > -1);
    check('顶部功能说明卡已移除（甘特图 / 日历图 / 网格列表 那段提示）',
        $4('.wp-tip').length === 0 && $4('.wp-board .wp-scroll').length === 1);
    check('保存按钮位于操作引导区最左侧（工具栏第一个元素）',
        $4('.wp-toolbar').children().first().attr('id') === 'wpDBtnSave' &&
        $4('.wp-toolbar').children().first().hasClass('el-button--icon'),
        String($4('.wp-toolbar').children().first().attr('id')));
    check('左侧菜单不再有「项目计划」入口',
        $4('.app-side__menu').text().indexOf('项目计划') < 0 &&
        $4('.app-side__item[href="project-plan.html"]').length === 0);
    check('三视图切换按钮齐全且默认网格列表',
        $4('#wpDViewBar [data-view]').length === 3 &&
        $4('#wpDBtnViewGrid').hasClass('is-active') &&
        $4('#wpDCanvas .wp-grid__row').length === 7);
    $4('#wpDBtnViewGantt').trigger('click');
    await until(function () { return $4('#wpDCanvas .wp-row').length === 7; }, 2000);
    check('从工单跳来时按 taskId 选中并高亮对应任务',
        $4('#wpDCanvas .wp-row[data-id="' + T2 + '"]').hasClass('is-selected') &&
        $4('#wpDCanvas [data-id="' + T2 + '"].is-focus').length > 0);
    $4('#wpDBtnViewCalendar').trigger('click');
    check('日历图按月历铺任务（每格任务块按完成状态着色）',
        $4('#wpDViewBar .is-active').attr('data-view') === 'calendar' &&
        $4('#wpDCanvas .wp-cal').length >= 1 &&
        $4('#wpDCanvas .wp-cal__task').length > 0 &&
        $4('#wpDCanvas .wp-cal__task[class*="wp-exec-"]').length > 0 &&
        $4('#wpDCanvas .wp-row').length === 0,
        String($4('#wpDCanvas .wp-cal__task').length));
    $4('#wpDBtnViewGrid').trigger('click');
    check('网格列表显示全部执行字段与关联工单列',
        $4('#wpDViewBar .is-active').attr('data-view') === 'grid' &&
        $4('#wpDCanvas .wp-grid__row').length === 7 &&
        ['完成状态', '实际起止', '前置任务', '关联工单', '执行说明'].every(function (k) {
            return $4('#wpDCanvas .wp-grid thead').text().indexOf(k) > -1;
        }));
    check('网格列表任务块可定位到工单跳来的那条任务',
        $4('#wpDCanvas .wp-grid__row[data-id="' + T2 + '"]').hasClass('is-selected'));
    $4('#wpDCanvas .wp-grid__row[data-id="' + T2 + '"]').trigger('dblclick');
    var $p4 = $4('.el-dialog');
    check('任务属性含执行记录字段与关联工单入口',
        ['#wpTExecStatus', '#wpTActualStart', '#wpTActualEnd', '#wpTExecRemark',
         '#wpTOrder', '#wpTBtnOrder'].every(function (k) { return $p4.find(k).length === 1; }));
    $p4.find('#wpTExecStatus').val('已完成');
    $p4.find('#wpTActualStart').val('2026-10-03');
    $p4.find('#wpTActualEnd').val('2026-10-14');
    $p4.find('#wpTExecRemark').val('需求调研完成');
    $p4.find('.btn-ok').trigger('click');
    check('属性保存后网格列表与日历图共用执行状态（就地更新）',
        $4('#wpDCanvas .wp-grid__row[data-id="' + T2 + '"]').text().indexOf('已完成') > -1 &&
        $4('#wpDCanvas .wp-grid__row[data-id="' + T2 + '"]').text().indexOf('2026-10-03') > -1);
    var execSavePayload = null;
    w4.Api.workPlan.save = function (data) {
        execSavePayload = data;
        var d = $4.Deferred();
        d.resolve({ id: P1, planCode: 'WP000001', message: '已保存' });
        return d.promise();
    };
    $4('#wpDBtnSave').trigger('click');
    var exT2 = execSavePayload && execSavePayload.tasks.filter(function (t) { return t.id === T2; })[0];
    check('整图保存把执行记录字段一并提交给后端',
        !!exT2 && exT2.execStatus === '已完成' &&
        exT2.actualStartDate === '2026-10-03' &&
        exT2.actualEndDate === '2026-10-14' &&
        exT2.execRemark === '需求调研完成',
        exT2 && JSON.stringify(exT2));

    /* ================= 3.8 计划工单页（按项目汇总） ================= */
    console.log('\n--- 3.8 计划工单页：计划 / 项目维度 ---');
    var w5 = boot('workplan-orders.html', ['js/workplan-orders.js']);
    var $5 = w5.jQuery, A5 = w5.Api.workPlan;
    await new Promise(function (resolve) { A5.start(P1).done(resolve).fail(resolve); });
    var noProj = await apiDone(A5.add({ planName: '未关联项目计划' }));
    await apiDone(A5.save({
        plan: { id: noProj.id, planName: '未关联项目计划' },
        tasks: [{ id: 'wpt-0000-4000-8000-000000000501', taskName: '无项目任务',
                  startDate: '2027-02-01', endDate: '2027-02-03', ownerId: 3 }]
    }));
    await apiDone(A5.start(noProj.id));
    await new Promise(function (resolve) { setTimeout(resolve, 250); });   // 等首屏那次加载先渲染完
    $5('#woSearch').trigger('click');
    await until(function () { return $5('#woTbody tr[data-id]').length >= 8; }, 3000);
    check('计划工单页：表格列出工单，按项目分组',
        $5('#woTbody tr[data-id]').length > 0 &&
        $5('#woTbody tr.wp-orders__group').length > 0 &&
        $5('#woTbody').text().indexOf('未关联项目') > -1,
        String($5('#woTbody tr[data-id]').length));
    check('计划工单页：项目下拉含未关联项目 + 汇总条',
        $5('#woProject option[value="__none__"]').length === 1 &&
        $5('#woSummary .wo-summary__item').length > 0 &&
        $5('#woCount').text() !== '0');
    $5('#woStatusMulti .wp-multi__opt input[value="待处理"]').prop('checked', true).trigger('change');
    $5('#woStatusMulti .wp-multi__opt input[value="已完成"]').prop('checked', true).trigger('change');
    $5('#woSearch').trigger('click');
    await new Promise(function (resolve) { setTimeout(resolve, 250); });
    var stOk = $5('#woTbody tr[data-id]').length > 0, stRows = 0;
    $5('#woTbody tr[data-id]').each(function () {
        stRows++;
        var txt = $5(this).children('td').eq(8).text();
        if (txt.indexOf('待处理') < 0 && txt.indexOf('已完成') < 0) { stOk = false; }
    });
    check('工单状态支持复选过滤（多选后只显示勾选状态）', stOk && stRows > 0 &&
        $5('#woStatusMulti .wp-multi__btn').text() === '待处理、已完成',
        stRows + ' 行 / ' + $5('#woStatusMulti .wp-multi__btn').text());
    $5('#woReset').trigger('click');
    await new Promise(function (resolve) { setTimeout(resolve, 200); });
    check('重置后复选清空并恢复全部状态',
        $5('#woStatusMulti .wp-multi__opt input:checked').length === 0 &&
        $5('#woStatusMulti .wp-multi__btn').text() === '全部状态');
    var orderOk = true, prevKey = null;
    $5('#woTbody tr[data-id]').each(function () {
        var td = $5(this).children('td');
        var proj = td.eq(1).text();
        var key = [(proj === '未关联项目' ? 1 : 0), proj, td.eq(2).text(), td.eq(4).text()];
        if (prevKey) {
            for (var k = 0; k < key.length; k++) {
                if (key[k] === prevKey[k]) { continue; }
                if (String(key[k]) < String(prevKey[k])) { orderOk = false; }
                break;
            }
        }
        prevKey = key;
    });
    check('计划工单按项目 / 计划编号 / 工单号排序', orderOk);
    check('计划工单：网格分页（页码 / 每页条数 / 跳转）',
        $5('#woPager .el-pagination .el-pager li.number').length > 0 &&
        $5('#woPager .el-pagination .page-size option').length >= 3 &&
        $5('#woPager .el-pagination__jump input').length === 1);
    check('计划工单页：有「序号」列、无选择列与「打开任务」按钮',
        $5('#woTable thead th').first().text() === '序号' &&
        $5('#woTable thead').text().indexOf('选择') < 0 &&
        $5('#woBtnOpenTask').length === 0 &&
        $5('#woTbody tr[data-id]').first().children('td').eq(0).text() === '1',
        $5('#woTable thead th').first().text());
    check('计划工单：行内保留执行记录 / 变更历史入口',
        read('js/workplan-orders.js').indexOf('openExec(') > -1 &&
        read('js/workplan-orders.js').indexOf('openChange(') > -1);
    check('计划工单：导出 Excel 走服务端二进制接口',
        read('js/workplan-orders.js').indexOf('/api/workplan/exportorders') > -1);
    check('计划工单：打印/导出取全部结果（分页仅影响展示）',
        read('js/workplan-orders.js').indexOf('page * size < total') > -1 &&
        read('js/workplan-orders.js').indexOf('woPrintArea') > -1 &&
        read('workplan-orders.html').indexOf('woPrintArea') > -1);
    check('计划工单：结果区铺满剩余高度并补空行',
        read('js/workplan-orders.js').indexOf('layoutRows') > -1 &&
        read('js/workplan-orders.js').indexOf('blank-row') > -1 &&
        read('css/workplan.css').indexOf('body.wo-page .table-wrapper') > -1);

    /* ================= 4. 静态口径 ================= */
    console.log('\n--- 4. 数据库 / 菜单 / 版本静态断言 ---');
    var sql = read('db/workplan.sql');
    check('建表脚本可重复执行且非破坏性',
        sql.indexOf('CREATE TABLE IF NOT EXISTS `workplans`') > -1 &&
        sql.indexOf('CREATE TABLE IF NOT EXISTS `workplantasks`') > -1 &&
        !/DROP\s+TABLE/i.test(sql) && !/DELETE\s+FROM/i.test(sql));
    check('任务表含 Visio 全部要素字段',
        ['taskType', 'parentId', 'progress', 'preTaskIds', 'skipWeekend', 'scale']
            .every(function (k) { return sql.indexOf('`' + k + '`') > -1 || sql.indexOf(k) > -1; }));
    check('全量 schema 同步两张表',
        read('db/rogerorm-schema.sql').indexOf('CREATE TABLE IF NOT EXISTS `workplantasks`') > -1);
    var peopleSql = read('db/workplan-people.sql');
    check('责任人 / 参与人员加列脚本存在且幂等非破坏',
        ['ownerId', 'participantIds', 'participantNames'].every(function (k) {
            return peopleSql.indexOf('`' + k + '`') > -1;
        }) && peopleSql.indexOf('information_schema.COLUMNS') > -1 &&
        !/DROP\s+TABLE/i.test(peopleSql) && !/DELETE\s+FROM/i.test(peopleSql) &&
        !/UPDATE\s+`workplantasks`/i.test(peopleSql));
    check('主建表脚本与全量 schema 同步新列',
        ['ownerId', 'participantIds', 'participantNames'].every(function (k) {
            return sql.indexOf('`' + k + '`') > -1 &&
                read('db/rogerorm-schema.sql').indexOf('`' + k + '`') > -1;
        }));
    check('后端整图保存写入新列',
        read('server/service.py').indexOf("'participantNames', 'sortNo'") > -1 ||
        read('server/service.py').indexOf("'participantNames'") > -1);
    check('设计器页引入选人组件脚本',
        read('workplan-design.html').indexOf('js/wp-emp-picker.js?v=20261110d') > -1 &&
        read('js/wp-emp-picker.js').indexOf('window.WpEmpPicker') > -1);
    check('新建计划说明区加高且去掉提示文案（静态）',
        read('workplan.html').indexOf('wp-new-desc') > -1 &&
        read('workplan.html').indexOf('rows="7"') > -1 &&
        read('workplan.html').indexOf('确定后进入 Visio 风格设计器') < 0 &&
        read('css/workplan.css').indexOf('min-height: 150px') > -1);
    check('菜单脚本登记 MNU00024 且可重复执行',
        read('db/workplan-menu.sql').indexOf("MNU00024") > -1 &&
        read('db/workplan-menu.sql').indexOf('NOT EXISTS') > -1);
    check('后端注册 workplan 服务',
        read('server/service.py').indexOf("'workplan': work_plan_service") > -1);

    /* 启动 / 通知 / 工单 / 我的任务 */
    var startSql = read('db/workplan-start.sql');
    check('启动增量脚本幂等非破坏（加列 + 工单表 + 菜单）',
        startSql.indexOf('information_schema.COLUMNS') > -1 &&
        startSql.indexOf('CREATE TABLE IF NOT EXISTS `workplanorders`') > -1 &&
        startSql.indexOf('MNU00025') > -1 && startSql.indexOf('NOT EXISTS') > -1 &&
        !/DROP\s+TABLE/i.test(startSql) && !/DELETE\s+FROM/i.test(startSql) &&
        !/UPDATE\s+`workplans`/i.test(startSql));
    check('主建表与全量 schema 同步 workplanorders 与启动状态列',
        sql.indexOf('CREATE TABLE IF NOT EXISTS `workplanorders`') > -1 &&
        read('db/rogerorm-schema.sql').indexOf('CREATE TABLE IF NOT EXISTS `workplanorders`') > -1 &&
        ['status', 'startTime', 'startEname', 'startempinfosid'].every(function (k) {
            return sql.indexOf('`' + k + '`') > -1 &&
                read('db/rogerorm-schema.sql').indexOf('`' + k + '`') > -1;
        }));
    var svcPy = read('server/service.py');
    check('后端实现 people / start / orders 并登记 people 动作',
        svcPy.indexOf('def people(self, params)') > -1 &&
        svcPy.indexOf('def start(self, params)') > -1 &&
        svcPy.indexOf('def orders(self, params)') > -1 &&
        svcPy.indexOf("'people': ('people'") > -1);
    check('后端启动给责任人 + 参与人员发即时消息与邮件，并按参与人归属任务列表',
        svcPy.indexOf('_wp_push(me, emp_id, title, brief, brief_html)') > -1 &&
        svcPy.indexOf('project_plan_service._send_mail(') > -1 &&
        svcPy.indexOf('FIND_IN_SET') > -1);
    check('前端 Api.workPlan 暴露 people / start / orders',
        read('js/api.js').indexOf('/workplan/people') > -1 &&
        read('js/api.js').indexOf('/workplan/start') > -1 &&
        read('js/api.js').indexOf('/workplan/orders') > -1);
    check('选人组件按组织树 + 双来源实现',
        read('js/wp-emp-picker.js').indexOf('Api.workPlan.people') > -1 &&
        read('js/wp-emp-picker.js').indexOf('data-src="group"') > -1 &&
        read('js/wp-emp-picker.js').indexOf('wp-ep-dept') > -1 &&
        read('css/workplan.css').indexOf('.wp-ep-tree') > -1);
    check('我的任务页带项目 / 角色 / 完成状态 / 工单状态筛选与执行记录弹窗，且无说明卡',
        read('workplan-task.html').indexOf('id="wtTbody"') > -1 &&
        read('js/workplan-task.js').indexOf('Api.workPlan.orders') > -1 &&
        ['wtProject', 'wtRole', 'wtExec', 'wtStatus'].every(function (k) {
            return read('workplan-task.html').indexOf('id="' + k + '"') > -1;
        }) &&
        read('workplan-task.html').indexOf('id="wtExecTpl"') > -1 &&
        read('workplan-task.html').indexOf('pj-tipcard') < 0 &&
        read('workplan-task.html').indexOf('项目计划') < 0);
    check('后端 / Mock 的 orders 支持按关联项目筛选（取计划当前项目，非工单快照）',
        read('server/service.py').indexOf("'projectId': plan_project.get(") > -1 &&
        read('server/service.py').indexOf("self._text(params.get('projectId')) != self._text(o.get('projectId'))") > -1 &&
        read('js/api.js').indexOf("if (params.projectId && mockStr(params.projectId) !== mockStr(x.projectId))") > -1 &&
        read('js/workplan-task.js').indexOf('projectId: state.projectId') > -1);
    check('三页操作引导区改为标准 .toolbar（纳入 pageopbtn 扫描 + btnperm 授权）',
        ['workplan.html', 'workplan-design.html', 'workplan-task.html'].every(function (p) {
            return read(p).indexOf('class="toolbar toolbar--icons wp-toolbar wp-toolbar--icons"') > -1;
        }) &&
        read('css/workplan.css').indexOf('会被 page_scan.py 收录') > -1 &&
        read('js/workplan-task.js').indexOf('纳入 pageopbtn 扫描') > -1);
    var btnPermSql = read('db/workplan-btn-perm.sql');
    check('按钮权限脚本收录三页 26 个按钮并给启用角色默认授权（幂等非破坏）',
        btnPermSql.indexOf('INSERT IGNORE INTO `pageopbtn`') > -1 &&
        btnPermSql.indexOf('INSERT INTO `usergrouppagebtnset`') > -1 &&
        btnPermSql.indexOf('NOT EXISTS') > -1 &&
        btnPermSql.indexOf('r.`enabled` = 1') > -1 &&
        (btnPermSql.match(/UNION ALL SELECT/g) || []).length === 25 &&
        !/DROP\s+TABLE/i.test(btnPermSql) && !/DELETE\s+FROM/i.test(btnPermSql) &&
        ['wpBtnAdd', 'wpDBtnSave', 'wpDBtnImport', 'wtBtnExec', 'wtBtnOpenTask'].every(function (b) {
            return btnPermSql.indexOf("'" + b + "'") > -1;
        }));
    check('菜单登记 MNU00025「我的任务」', startSql.indexOf("'MNU00025'") > -1);
    check('说明文案已更新（不再说「不触发工单或通知」）',
        read('workplan-design.html').indexOf('不触发工单或通知') < 0 &&
        read('workplan.html').indexOf('相互独立') < 0 &&
        read('workplan-design.html').indexOf('启动计划') > -1);
    check('三页统一引用 api.js?v=' + SHARED_API_V,
        SHARED_API_V !== '' &&
        ['workplan.html', 'workplan-design.html', 'workplan-task.html'].every(function (p) {
            return read(p).indexOf('js/api.js?v=' + SHARED_API_V) > -1;
        }));

    /* ---------- 本轮：下线项目计划 / 改名 / 三视图 / 执行记录 / 工单关联 ---------- */
    var execSql = read('db/workplan-exec.sql');
    var retireSql = read('db/workplan-retire-projectplan.sql');
    var svcSrc = read('server/service.py');
    var apiSrc2 = read('js/api.js');
    var designSrc = read('js/workplan-design.js');
    check('执行记录增量脚本幂等加 4 列 + 索引，且非破坏性',
        ['execStatus', 'actualStartDate', 'actualEndDate', 'execRemark',
         'idx_workplantasks_exec', 'idx_wporders_status'].every(function (k) {
            return execSql.indexOf(k) > -1;
        }) && execSql.indexOf('information_schema.COLUMNS') > -1 &&
        !/DROP\s+TABLE/i.test(execSql) && !/DELETE\s+FROM/i.test(execSql));
    check('主建表与全量 schema 同步执行记录列',
        sql.indexOf('`execStatus`') > -1 &&
        read('db/rogerorm-schema.sql').indexOf('`actualEndDate`') > -1);
    check('后端整图保存写入执行记录列并做校验',
        svcSrc.indexOf("EXEC_STATUSES = ('未开始', '进行中', '已完成', '已延期', '已取消')") > -1 &&
        svcSrc.indexOf("'execStatus', 'actualStartDate',") > -1 &&
        svcSrc.indexOf('实际开始时间不能晚于实际结束时间') > -1);
    check('后端 detail / orders 按 taskId 双向 JOIN 工单与任务',
        svcSrc.indexOf('o.`taskId`=t.`id`') > -1 &&
        svcSrc.indexOf('t.`id`=o.`taskId`') > -1 &&
        svcSrc.indexOf("'taskLinked': bool") > -1 &&
        svcSrc.indexOf("['orderLinked'] = bool") > -1);
    var wpBody = svcSrc.slice(svcSrc.indexOf('class WorkPlanService(object):'));
    var ordersBody = wpBody.slice(wpBody.indexOf('def orders(self, params):'),
                                  wpBody.indexOf('def exec_record(self, params):'));
    check('后端新增 exec_record 并登记 /workplan/exec 动作',
        svcSrc.indexOf('def exec_record(self, params)') > -1 &&
        svcSrc.indexOf("'exec': ('exec_record', ['POST'])") > -1 &&
        read('server/app.py').indexOf('/api/workplan/exec') > -1);
    check('后端「我的任务」不再合并已下线的项目计划工单',
        ordersBody.indexOf('projectworkorders') < 0 &&
        ordersBody.indexOf("'sourceType': '项目计划'") < 0);
    check('前端 Api.workPlan.exec 与 Mock /exec 回填路由',
        apiSrc2.indexOf("'/workplan/exec'") > -1 &&
        apiSrc2.indexOf("if (path === '/exec')") > -1 &&
        apiSrc2.indexOf('EXEC_STATUSES') > -1);
    check('Mock detail / orders 回带工单号与任务执行记录',
        apiSrc2.indexOf('dt.orderLinked = !!dt.orderId') > -1 &&
        apiSrc2.indexOf('taskLinked: !!linked') > -1);
    check('项目计划下线脚本只停用菜单与授权，不删业务数据',
        retireSql.indexOf("`code` = 'MNU00023'") > -1 &&
        retireSql.indexOf('UPDATE `menuinfros` SET `enabled` = 0') > -1 &&
        !/DROP\s+TABLE/i.test(retireSql) && !/DELETE\s+FROM/i.test(retireSql) &&
        retireSql.indexOf('rows_kept') > -1);
    check('项目详情页已移除「创建计划」入口',
        read('project.html').indexOf('id="btnPlan"') < 0 &&
        read('js/project.js').indexOf("$('#btnPlan').on") < 0);
    check('工作计划三页不再出现「项目计划」菜单或说明',
        ['workplan.html', 'workplan-design.html', 'workplan-task.html'].every(function (p) {
            return read(p).indexOf('project-plan.html') < 0 &&
                   read(p).indexOf('项目计划的事项工单') < 0;
        }));
    check('制定页标题与入口按钮统一叫「工作计划」',
        read('workplan-design.html').indexOf('<h2 class="page-head__title">工作计划</h2>') > -1 &&
        read('workplan-design.html').indexOf('<title>工作计划 - 九豆综合管理平台</title>') > -1 &&
        read('workplan.html').indexOf('title="工作计划（维护任务）"') > -1 &&
        read('workplan-design.html').indexOf('工作计划制定') < 0 &&
        read('workplan-design.html').indexOf('工作计划设计器') < 0);
    check('三页菜单与列表页标题改为「计划管理」（含改名 SQL 可重复执行）',
        ['workplan.html', 'workplan-design.html', 'workplan-task.html'].every(function (p) {
            return /href="workplan\.html"[^>]*>[\s\S]{0,200}?计划管理/.test(read(p));
        }) &&
        read('workplan.html').indexOf('<h2 class="page-head__title">计划管理</h2>') > -1 &&
        read('workplan.html').indexOf('data-crumb="项目管理/计划管理"') > -1 &&
        read('db/plan-manage-rename.sql').indexOf("SET `nameCn` = '计划管理'") > -1 &&
        read('db/plan-manage-rename.sql').indexOf("AND `nameCn` = '工作计划'") > -1);
    check('三个页面操作引导区全改纯图标按钮（svg + title + aria-label，无可见文字）',
        ['workplan.html', 'workplan-design.html', 'workplan-task.html'].every(function (p) {
            var html = read(p);
            if (html.indexOf('wp-toolbar wp-toolbar--icons') < 0) { return false; }
            var seg = html.slice(html.indexOf('wp-toolbar--icons'));
            seg = seg.slice(0, seg.indexOf('</div>'));
            var btns = seg.match(/<button[\s\S]*?<\/button>/g) || [];
            if (btns.length < 4) { return false; }
            return btns.every(function (b) {
                return b.indexOf('el-button--icon') > -1 &&
                       b.indexOf('<svg class="svg-ico"') > -1 &&
                       b.indexOf('title="') > -1 &&
                       b.indexOf('aria-label="') > -1 &&
                       b.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').trim() === '';
            });
        }));
    check('设计器实现甘特图 / 日历图 / 网格列表三视图 + taskId 定位',
        designSrc.indexOf("VIEWS = { gantt: '甘特图', calendar: '日历图', grid: '网格列表' }") > -1 &&
        designSrc.indexOf('function renderCalendar()') > -1 &&
        designSrc.indexOf('function renderGrid()') > -1 &&
        designSrc.indexOf('function applyFocus()') > -1 &&
        read('css/workplan.css').indexOf('.wp-cal__grid') > -1 &&
        read('css/workplan.css').indexOf('.wp-grid__row') > -1);

    check('设计器：非创建人禁删/禁停 + 启动幂等 + 变更日志入口（静态）',
        read('workplan-design.html').indexOf('id="wpDBtnLog"') > -1 &&
        read('workplan-design.html').indexOf('id="wpDBtnStop"') > -1 &&
        read('js/workplan-design.js').indexOf('function syncPerm()') > -1 &&
        read('js/workplan-design.js').indexOf('不能删除任务节点') > -1 &&
        read('js/workplan-design.js').indexOf('不能重复启动') > -1 &&
        read('js/workplan-design.js').indexOf('function openChangeLogs()') > -1 &&
        read('js/workplan-design.js').indexOf('function openExecRecords(') > -1 &&
        read('css/workplan.css').indexOf('.wp-log__item') > -1);

    check('我的任务：执行记录可多次提交 + 多附件 + 历史记录（静态）',
        read('workplan-task.html').indexOf('id="wtExFiles" multiple') > -1 &&
        read('workplan-task.html').indexOf('id="wtExHistory"') > -1 &&
        read('js/workplan-task.js').indexOf('function readFiles(') > -1 &&
        read('js/workplan-task.js').indexOf('function loadExecHistory(') > -1 &&
        read('js/workplan-task.js').indexOf('files: files') > -1 &&
        read('js/workplan-task.js').indexOf('function previewExecFile(') > -1);

    check('api.js：变更日志 / 执行记录 / 附件 / 停止 四个新接口（真实 + Mock）',
        read('js/api.js').indexOf("'/workplan/changelogs'") > -1 &&
        read('js/api.js').indexOf("'/workplan/execs'") > -1 &&
        read('js/api.js').indexOf("'/workplan/execfile'") > -1 &&
        read('js/api.js').indexOf("'/workplan/stop'") > -1 &&
        read('js/api.js').indexOf("path === '/execs'") > -1 &&
        read('js/api.js').indexOf("path === '/changelogs'") > -1);

    check('甘特图任务行显示执行记录徽标（📎N，可点开记录与附件预览）',
        read('js/workplan-design.js').indexOf('wp-row__exec') > -1 &&
        read('js/workplan-design.js').indexOf('data-exec-task') > -1 &&
        read('css/workplan.css').indexOf('.wp-row__exec') > -1);

    check('我的任务：工单行带「变更历史」徽标与时间线弹窗',
        read('workplan-task.html').indexOf('变更历史') > -1 &&
        read('js/workplan-task.js').indexOf('wt-change-link') > -1 &&
        read('js/workplan-task.js').indexOf('function openChangeHistory(') > -1 &&
        read('js/workplan-task.js').indexOf("withPlan: 1") > -1 &&
        read('js/api.js').indexOf('changeCount') > -1);

    check('网格列表「前置任务」列显示任务名（不是 id）',
        read('js/workplan-design.js').indexOf("'<th style=\"width:150px\">前置任务</th>'") > -1 &&
        read('js/workplan-design.js').indexOf('var preText = preNames.length') > -1);

    check('计划管理：执行中不可删除（只能停止）、非创建人不可删除',
        read('workplan.html').indexOf('id="wpBtnStop"') > -1 &&
        read('js/workplan.js').indexOf('执行中的工作计划不能删除，请先停止') > -1 &&
        read('js/workplan.js').indexOf('非本人创建的工作计划不能删除') > -1 &&
        read('js/workplan.js').indexOf('#wpBtnStop') > -1 &&
        read('js/workplan.js').indexOf('row.isCreator !== false') > -1);
    check('计划管理：列表回带 isCreator / 已停止状态样式',
        read('js/api.js').indexOf('one.isCreator = isCreator(r)') > -1 &&
        read('css/workplan.css').indexOf('.wp-status.is-stop') > -1);

    console.log('\n===== workplan-test 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
    process.exit(fail ? 1 : 0);
})();
