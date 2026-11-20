/* ==========================================================================
   btn-perm-test.js —— 功能页按角色授权「加载」操作按钮（js/btnperm.js）
   --------------------------------------------------------------------------
   覆盖：
     ① 未授权按钮不渲染（is-perm-hidden + hidden + aria-hidden + disabled），已授权按钮照常显示；
     ② 权限拉取期间页面挂 .btnperm-loading，落定后移除；
     ③ AppBtnPerm.ready(cb) 在权限落定后回调；
     ④ 用户没有分配角色（unrestricted）→ 不筛选；
     ⑤ 页面在 pageopbtn 里没登记 → 不筛选；其它页面的授权不会误伤本页；
     ⑥ 权限管理页（role-power.html）自身不筛选；
     ⑦ 全站业务页都引用 js/btnperm.js；实现为 ES5。
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/btn-perm-test.js
   ========================================================================== */
'use strict';
process.on('unhandledRejection', function () { /* 页面里的异步桩不影响结论 */ });
var fs = require('fs');
var path = require('path');
var JSDOM = (function () {
    try { return require('jsdom').JSDOM; } catch (e) { return null; }
})();

var ROOT = path.resolve(__dirname, '..');
var pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(cond, ms) {
    var end = Date.now() + (ms || 1500);
    while (Date.now() < end) { if (cond()) { return true; } await wait(15); }
    return false;
}

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

/** 启动某页面，只装 jQuery / api / ui / btnperm（不装页面自己的 js） */
function boot(page, pagesPayload) {
    var dom = new JSDOM(read(page), {
        url: 'http://127.0.0.1:8808/' + page,
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.jQuery.ajax = function () {
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'mock-token', user: { empId: 3, nameCn: '杨伟康' }
    }));
    win.eval(read('js/ui.js'));
    win.Api.rolePower = win.Api.rolePower || {};
    win.Api.rolePower.myButtons = function () {
        var d = win.jQuery.Deferred();
        d.resolve(pagesPayload);
        return d.promise();
    };
    win.eval(read('js/btnperm.js'));
    return win;
}

function empPayload() {
    return {
        unrestricted: false,
        pages: {
            'emp.html': {
                pageName: '员工信息管理',
                buttons: [
                    { btnId: 'btnAdd', btnText: '新增员工', allowed: true },
                    { btnId: 'btnEdit', btnText: '编辑', allowed: false },
                    { btnId: 'btnDelete', btnText: '删除', allowed: false },
                    { btnId: 'btnRefresh', btnText: '刷新', allowed: false }
                ]
            }
        }
    };
}

function isHidden(el) {
    if (!el) { return false; }
    return el.classList.contains('is-perm-hidden') &&
        el.hasAttribute('hidden') &&
        el.getAttribute('aria-hidden') === 'true' &&
        el.disabled === true;
}

(async function () {
    /* ---------------- 1. 未授权不渲染 ---------------- */
    console.log('\n--- 1. 未授权按钮不渲染，已授权正常显示 ---');
    var win = boot('emp.html', empPayload());
    await until(function () { return win.AppBtnPerm.hiddenIds().length > 0; }, 2000);

    var add = win.document.getElementById('btnAdd');
    var del = win.document.getElementById('btnDelete');
    var edit = win.document.getElementById('btnEdit');
    check('已授权按钮照常显示（无隐藏标记）',
        !add.classList.contains('is-perm-hidden') && !add.hasAttribute('hidden'));
    check('未授权按钮加 is-perm-hidden（display:none）', del.classList.contains('is-perm-hidden'));
    check('未授权按钮带 hidden / aria-hidden / disabled',
        del.hasAttribute('hidden') && del.getAttribute('aria-hidden') === 'true' && del.disabled === true);
    check('未授权按钮 data-perm=hidden 且保留原标题',
        del.getAttribute('data-perm') === 'hidden' && !!del.getAttribute('data-perm-title'));
    check('多个未授权按钮都被隐藏（编辑 / 删除 / 刷新）',
        isHidden(edit) && isHidden(del) && isHidden(win.document.getElementById('btnRefresh')));
    check('隐藏清单里正好是 3 个未授权按钮',
        win.AppBtnPerm.hiddenIds().sort().join(',') === 'btnDelete,btnEdit,btnRefresh',
        win.AppBtnPerm.hiddenIds().join(','));
    check('isAllowed 对未授权为 false、已授权为 true',
        win.AppBtnPerm.isAllowed('btnDelete') === false && win.AppBtnPerm.isAllowed('btnAdd') === true);

    /* ---------------- 2. 加载态 ---------------- */
    console.log('\n--- 2. 加载态类名在权限落定后移除 ---');
    check('权限落定后 <html> 不再有 btnperm-loading',
        !win.document.documentElement.classList.contains('btnperm-loading'));

    /* ---------------- 3. ready 回调 ---------------- */
    console.log('\n--- 3. AppBtnPerm.ready 回调 ---');
    var fired = false;
    win.AppBtnPerm.ready(function () { fired = true; });
    await wait(30);
    check('权限已落定时 ready 立即回调', fired === true);

    /* ---------------- 4. 无角色：不筛选 ---------------- */
    console.log('\n--- 4. 用户没有角色（unrestricted）→ 全部显示 ---');
    var win2 = boot('emp.html', { unrestricted: true, pages: {} });
    await wait(250);
    var d2 = win2.document.getElementById('btnDelete');
    check('不筛选时按钮不被隐藏', !d2.classList.contains('is-perm-hidden') && !d2.hasAttribute('hidden'));
    check('hiddenIds 为空', win2.AppBtnPerm.hiddenIds().length === 0);

    /* ---------------- 5. 页面未登记 / 其它页授权 ---------------- */
    console.log('\n--- 5. 页面没登记 / 其它页授权不误伤 ---');
    var win3 = boot('emp.html', {
        unrestricted: false,
        pages: { 'org.html': { buttons: [{ btnId: 'btnDelete', allowed: false }] } }
    });
    await wait(250);
    check('其它页面的授权不会隐藏本页按钮',
        win3.AppBtnPerm.hiddenIds().length === 0 &&
        !win3.document.getElementById('btnDelete').classList.contains('is-perm-hidden'));

    /* ---------------- 6. 权限管理页豁免 ---------------- */    console.log('\n--- 6. 权限管理页自身不筛选 ---');
    var win4 = boot('role-power.html', {
        unrestricted: false,
        pages: { 'role-power.html': { buttons: [{ btnId: 'btnSave', allowed: false }] } }
    });
    await wait(200);
    var saveBtn = win4.document.getElementById('btnSave');
    check('role-power.html 的按钮不被隐藏（可自救）',
        !saveBtn || !saveBtn.classList.contains('is-perm-hidden'));

    /* ---------------- 6.1 即时对话输入区媒体按钮豁免 ---------------- */
    console.log('\n--- 6.1 IM 输入区媒体按钮不受按钮权限隐藏 ---');
    var winIm = boot('message.html', {
        unrestricted: false,
        pages: {
            'message.html': {
                buttons: [
                    { btnId: 'imPickImage', btnText: '发送图片', allowed: false },
                    { btnId: 'imEmoji', btnText: '表情', allowed: false },
                    { btnId: 'btnRefresh', btnText: '刷新', allowed: false }
                ]
            }
        }
    });
    await wait(300);
    var pick = winIm.document.getElementById('imPickImage');
    var emoji = winIm.document.getElementById('imEmoji');
    var refreshBtn = winIm.document.getElementById('btnRefresh');
    check('媒体按钮（图片 / 表情）保持可见，不被 is-perm-hidden',
        pick && emoji && !pick.classList.contains('is-perm-hidden') &&
        !pick.hasAttribute('hidden') && !emoji.classList.contains('is-perm-hidden'),
        pick ? pick.className : 'no-pick');
    check('同页普通按钮仍按授权隐藏（btnRefresh）',
        refreshBtn && refreshBtn.classList.contains('is-perm-hidden'));

    /* ---------------- 6.2 工作计划三页：按角色豁免按钮权限 ---------------- */
    console.log('\n--- 6.2 工作计划页（计划管理 / 设计器 / 我的任务）按钮豁免 ---');
    var wpPages = ['workplan.html', 'workplan-design.html', 'workplan-task.html'];
    check('btnperm.js 的 EXEMPT 包含工作计划三页',
        wpPages.every(function (p) { return read('js/btnperm.js').indexOf("'" + p + "': 1") > -1; }),
        wpPages.join(','));

    var winWp = boot('workplan.html', {
        unrestricted: false,
        pages: {
            'workplan.html': {
                buttons: [
                    { btnId: 'wpBtnAdd', btnText: '新建工作计划', allowed: false },
                    { btnId: 'wpBtnStart', btnText: '启动', allowed: false },
                    { btnId: 'wpBtnRefresh', btnText: '刷新', allowed: false }
                ]
            }
        }
    });
    await wait(300);
    var wpAdd = winWp.document.getElementById('wpBtnAdd');
    var wpStart = winWp.document.getElementById('wpBtnStart');
    check('工作计划页按钮不被角色授权隐藏（wpBtnAdd / wpBtnStart）',
        wpAdd && wpStart &&
        !wpAdd.classList.contains('is-perm-hidden') && !wpAdd.hasAttribute('hidden') &&
        !wpStart.classList.contains('is-perm-hidden') && !wpStart.hasAttribute('hidden'),
        wpAdd ? wpAdd.className : 'no-add');
    check('豁免页不挂 btnperm-loading（不闪隐）',
        !winWp.document.documentElement.classList.contains('btnperm-loading'));

    /* ---------------- 7. 静态检查 ---------------- */
    console.log('\n--- 7. 全站引用与实现检查 ---');
    var pages = fs.readdirSync(ROOT).filter(function (n) { return /\.html$/.test(n); });
    var need = pages.filter(function (n) { return read(n).indexOf('js/layout.js') > -1; });
    var missing = need.filter(function (n) { return read(n).indexOf('js/btnperm.js') < 0; });
    check('业务页全部引用 js/btnperm.js（' + need.length + ' 个）', missing.length === 0, missing.join(','));
    var src = read('js/btnperm.js');
    check('btnperm.js 是 ES5（无箭头函数 / const / let / 模板串）',
        src.indexOf('=>') === -1 && src.indexOf('const ') === -1 && src.indexOf('let ') === -1 &&
        src.indexOf('`') === -1);
    check('未授权走「隐藏」而不是「灰掉」（无 is-perm-denied 样式）',
        src.indexOf('.is-perm-denied') === -1 && src.indexOf('is-perm-hidden') > -1);

    /* ---------------- 8. 工作计划三页：按角色豁免按钮权限（不按授权隐藏） ---------------- */
    console.log('\n--- 8. 计划管理 / 工作计划 / 我的任务三页按角色豁免按钮权限 ---');
    var wpPayload = {
        unrestricted: false,
        pages: {
            'workplan.html': { buttons: [{ btnId: 'wpBtnAdd', allowed: false },
                                         { btnId: 'wpBtnDelete', allowed: false }] },
            'workplan-design.html': { buttons: [{ btnId: 'wpDBtnSave', allowed: false }] },
            'workplan-task.html': { buttons: [{ btnId: 'wtBtnRefresh', allowed: false },
                                              { btnId: 'wtBtnExec', allowed: false }] }
        }
    };
    var wt = boot('workplan-task.html', wpPayload);
    await wait(300);
    check('我的任务：「执行记录」「刷新」即使未授权也保持可见（豁免）',
        !isHidden(wt.document.getElementById('wtBtnExec')) &&
        !isHidden(wt.document.getElementById('wtBtnRefresh')) &&
        wt.AppBtnPerm.hiddenIds().length === 0);
    var wl = boot('workplan.html', wpPayload);
    await wait(300);
    check('计划管理：「新建」「删除」即使未授权也保持可见（豁免）',
        !isHidden(wl.document.getElementById('wpBtnDelete')) &&
        !isHidden(wl.document.getElementById('wpBtnAdd')) &&
        wl.AppBtnPerm.hiddenIds().length === 0);
    var wd = boot('workplan-design.html', wpPayload);
    await wait(300);
    check('工作计划（设计器）：「保存」即使未授权也保持可见（豁免）',
        !isHidden(wd.document.getElementById('wpDBtnSave')) &&
        wd.AppBtnPerm.hiddenIds().length === 0);

    console.log('\n===== btn-perm-test 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
    process.exit(fail ? 1 : 0);
})();
