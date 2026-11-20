/* ==========================================================================
   frame-tab-test.js —— 框架页交互冒烟测试（jsdom，无需浏览器）
   覆盖：左侧导航（/api/nav 动态生成：多级菜单组 + 菜单项叶子 + 折叠 + 禁用项）、
        Tab 新建 / 切换 / 关闭（单个·其它·全部）、子页面返回关闭自身、
        底部面包屑跟随当前激活 Tab（子页上报 → 父框架读子页声明 → 导航 crumb）
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/frame-tab-test.js
   ========================================================================== */
var fs = require('fs');
var path = require('path');
var JSDOM = (function () {
    try { return require('jsdom').JSDOM; } catch (e) { return null; }
})();

var ROOT = path.resolve(__dirname, '..');
var pass = 0, fail = 0;

/* 导航数据（与 /api/nav 返回结构一致，模拟当前库：系统管理 / 菜单配置 / 帮助中心）
   注意：这里故意给出「乱序 + 字符串序号」的接口返回（关于系统 100 → 系统管理 1 → 帮助中心 '99'，
   组内菜单项也反序），用来验证 frame.js 渲染前会按 sortNo 升序重排（不依赖后端顺序）。 */
var NAV = {
    groups: [
        {
            id: 11, parentId: 0, level: 1, sortNo: 100, code: 'MNG1001', nameCn: '关于系统',
            icon: 'document', hasChild: 0, path: '', crumb: '关于系统', children: [], items: []
        },
        {
            id: 1, parentId: 0, level: 1, sortNo: 1, code: 'MNG0001', nameCn: '系统管理',
            icon: 'setting', hasChild: 1, path: '', crumb: '系统管理', items: [],
            children: [
                {
                    id: 68, parentId: 1, level: 2, sortNo: 1, code: 'MNG000101', nameCn: '菜单配置',
                    icon: 'dashboard', hasChild: 1, path: '', crumb: '系统管理/菜单配置', children: [],
                    items: [
                        { id: 24, code: 'MNU00003', nameCn: '菜单组项目管理', path: 'menu-group-item.html', icon: 'dashboard', sortNo: '3', groupId: 68, crumb: '系统管理/菜单配置/菜单组项目管理' },
                        { id: 50, code: 'MNU00001', nameCn: '菜单项管理', path: 'menu.html', icon: 'tool', sortNo: '1', groupId: 68, crumb: '系统管理/菜单配置/菜单项管理' },
                        { id: 23, code: 'MNU00002', nameCn: '菜单组管理', path: 'menu-group.html', icon: 'tool', sortNo: '2', groupId: 68, crumb: '系统管理/菜单配置/菜单组管理' }
                    ]
                }
            ]
        },
        {
            id: 10, parentId: 0, level: 1, sortNo: '99', code: 'MNG1000', nameCn: '帮助中心',
            icon: 'document', hasChild: 1, path: '', crumb: '帮助中心', children: [],
            items: [
                { id: 29, code: 'MNU000099', nameCn: '修改密码', path: 'edituserpwd.html', icon: 'warning', sortNo: 1, groupId: 10, crumb: '帮助中心/修改密码' }
            ]
        }
    ],
    groupCount: 3, menuCount: 4, bindCount: 4
};

function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

var dom = new JSDOM(read('main.html'), {
    url: 'http://127.0.0.1:8808/main.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true
});
var window = dom.window;

/* 框架页有登录守门：先写入登录态，模拟「已登录」进入系统 */
window.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
    token: 'test-token', time: '2026-11-01 09:00:00',
    user: { id: 'u-1', account: '13800138001', empName: '测试管理员', deptName: '研发中心', roleNames: '系统管理员' }
}));

window.eval(read('vendor/jquery-3.7.1.min.js'));
window.eval(read('js/theme.js'));
window.eval(read('js/icons.js'));
window.eval(read('js/ui.js'));

/* 用固定导航数据替代 /api/nav（jsdom 不发真实请求） */
var navCalls = 0;
var navToken = null;        // 导航请求携带的登录令牌（应按当前登录用户加载菜单）
var whenReadyCalls = 0;
window.Api = {
    /** 接口地址探测完成信号：真实 api.js 提供，这里同步回调并计数 */
    whenReady: function (fn) { whenReadyCalls++; fn(); },
    nav: {
        get: function (token) {
            navCalls++;
            navToken = token;
            var d = window.jQuery.Deferred();
            d.resolve(JSON.parse(JSON.stringify(NAV)));
            return d.promise();
        }
    }
};
/* 拦截 ajax：HEAD（功能页面存在性探测）视为成功，其余（后端探测）视为不可用 */
window.jQuery.ajax = function (opts) {
    var d = window.jQuery.Deferred();
    if (opts && String(opts.type).toUpperCase() === 'HEAD') { d.resolve({}, 'success', { status: 200 }); }
    else { d.reject({}, 'error', ''); }
    return d.promise();
};

/* 系统参数（syspara）：框架页顶部图标 / 名称、底部名称、标题后缀都从这里取（applySysBrand） */
var sysparaCalls = 0;
window.Api.sysPara = {
    page: function (params) {
        sysparaCalls++;
        var d = window.jQuery.Deferred();
        d.resolve({
            list: [
                { id: 'p1', paraNameCn: '系统名称', paraNameEn: 'app_name', paraValue: '星云综合管理平台' },
                { id: 'p2', paraNameCn: '系统图标', paraNameEn: 'app_ico', paraValue: '/assets/logo2.svg' },
                { id: 'p3', paraNameCn: '系统英文名', paraNameEn: 'app_ennme', paraValue: 'Nebula Management Platform' }
            ],
            total: 3, pageNum: 1, pageSize: 200, pages: 1
        });
        return d.promise();
    }
};

window.eval(read('js/frame.js'));

setTimeout(run, 100);       // 等待 jQuery ready 回调执行完

function run() {
    var $ = window.jQuery;
    var AppFrame = window.AppFrame;
    var $tabs = $('#frameTabs');
    var $panes = $('#framePanes');
    var $menu = $('#frameMenu');

    function tabNames() {
        return $tabs.children('.frame-tab').map(function () { return $(this).find('.frame-tab__text').text(); }).get();
    }
    function activeName() {
        return $.trim($tabs.children('.frame-tab.is-active').find('.frame-tab__text').text());
    }
    function activePaneId() {
        return $panes.children('.frame-pane.is-active').attr('data-id');
    }
    /** 点击左侧导航中的某个功能页面（按 data-url 定位） */
    function clickNav(url) {
        $menu.find('.frame-side__item[data-url="' + url + '"]').trigger('click');
    }
    /** 按页面地址激活对应 Tab（首页固定在最前，不能再用 .first() 代表列表页） */
    function activateByUrl(url) {
        var paneId = $panes.children('.frame-pane').filter(function () {
            var src = String($(this).find('iframe').attr('src') || '');
            return src === url || src.indexOf(url + '?') === 0;
        }).attr('data-id');
        if (paneId) { $tabs.children('.frame-tab[data-id="' + paneId + '"]').trigger('click'); }
    }
    /** 底部面包屑文本：各段以 / 连接 */
    function crumbText() {
        return $('#frameCrumb').find('.el-breadcrumb__inner').map(function () {
            return $.trim($(this).text());
        }).get().join('/');
    }
    /** 模拟子页面就绪：往当前 iframe 文档里塞入声明面包屑的 .page-head */
    function fakeChild(crumb) {
        var frame = $panes.children('.frame-pane.is-active').find('iframe')[0];
        if (!frame || !JSDOM) { return false; }
        try {
            // jsdom 里 iframe 的 about:blank 文档没有 documentElement，无法写入；
            // 这里直接用一段子页面文档替换 contentWindow，验证「父框架读取子页声明」的兜底路径
            var child = new JSDOM('<!DOCTYPE html><html><body><div class="page-head" id="pageHead" ' +
                'data-crumb="' + crumb + '"></div></body></html>', { url: 'http://127.0.0.1:8808/child.html' }).window;
            Object.defineProperty(frame, 'contentWindow', { value: child, configurable: true });
            return !!frame.contentWindow.document.getElementById('pageHead');
        } catch (e) { return false; }
    }

    /* ---------- 左侧导航（由 /api/nav 动态生成） ---------- */
    console.log('\n--- 左侧动态导航 ---');

    check('导航在接口地址探测完成后才加载（Api.whenReady 已被调用：导航 + 系统品牌）',
        whenReadyCalls === 2 && navCalls === 1, 'whenReady=' + whenReadyCalls + ', nav=' + navCalls);
    check('系统品牌请求已发出（顶部/底部名称来自 syspara）', sysparaCalls === 1,
        String(sysparaCalls));
    check('导航请求携带当前登录用户的 token（按角色权限加载）', navToken === 'test-token', String(navToken));
    check('导航不再有硬编码菜单（已由接口生成）', $menu.find('.frame-side__loading').length === 0);
    check('渲染出 3 个可折叠菜单组', $menu.find('.frame-side__group').length === 3,
        String($menu.find('.frame-side__group').length));
    var $topGroups = $menu.children('.frame-side__group');
    check('最上面（第一个）菜单组默认展开',
        $topGroups.length === 2 && $topGroups.first().hasClass('is-open') &&
        $topGroups.first().find('.frame-side__group-title .txt').first().text() === '系统管理',
        $topGroups.map(function () {
            return $(this).find('.frame-side__group-title .txt').first().text() +
                ($(this).hasClass('is-open') ? '(展开)' : '(收缩)');
        }).get().join(','));
    check('其它菜单组默认收缩', $topGroups.slice(1).filter('.is-open').length === 0,
        String($topGroups.slice(1).filter('.is-open').length));
    check('首个菜单组里的子分组随父组一起展开',
        $menu.find('.frame-side__group[data-group="68"]').hasClass('is-open') === true);
    check('渲染出 4 个菜单功能页 + 固定的「系统首页」入口 = 5 个可点击项',
        $menu.find('.frame-side__item[data-url]').length === 5 &&
        $menu.find('.frame-side__item[data-url]').first().attr('data-url') === 'home.html',
        String($menu.find('.frame-side__item[data-url]').length) + ' / first=' +
        $menu.find('.frame-side__item[data-url]').first().attr('data-url'));
    check('「系统首页」入口固定排在导航第一位且带 crumb',
        $menu.children().first().find('.txt').first().text() === '系统首页' &&
        $menu.find('.frame-side__item[data-url="home.html"]').attr('data-crumb') === '系统首页',
        $menu.children().first().text().slice(0, 20));
    check('未配置功能页面的菜单显示为禁用', $menu.find('.frame-side__item.is-disabled').length === 1,
        String($menu.find('.frame-side__item.is-disabled').length));
    check('菜单项叶子带导航层级 crumb',
        $menu.find('.frame-side__item[data-url="menu.html"]').attr('data-crumb') === '系统管理/菜单配置/菜单项管理',
        $menu.find('.frame-side__item[data-url="menu.html"]').attr('data-crumb'));

    /* 角色没有任何菜单权限时：导航区给出明确提示，而不是空白或报错 */
    var realNavGet = window.Api.nav.get;
    window.Api.nav.get = function () {
        var d = window.jQuery.Deferred();
        d.resolve({ groups: [], roleNames: '普通用户', empty: true, scoped: true });
        return d.promise();
    };
    window.AppFrame.reloadNav();
    check('角色没有任何菜单权限时提示「暂无可访问的菜单」',
        $menu.text().indexOf('暂无可访问的菜单') > -1, $menu.text().slice(0, 60));
    check('提示里带出当前角色名，便于定位问题',
        $menu.text().indexOf('普通用户') > -1, $menu.text().slice(0, 60));

    window.Api.nav.get = realNavGet;
    window.AppFrame.reloadNav();
    check('恢复授权后导航重新渲染出功能页面',
        $menu.find('.frame-side__item[data-url]').length === 5,
        String($menu.find('.frame-side__item[data-url]').length));
    check('二级菜单组渲染为分组（菜单配置）',
        $menu.find('.frame-side__group[data-group="68"]').length === 1);

    $menu.find('.frame-side__group-title').first().trigger('click');
    check('点击分组标题可折叠',
        $menu.find('.frame-side__group').first().hasClass('is-open') === false);
    $menu.find('.frame-side__group-title').first().trigger('click');
    check('再次点击可展开',
        $menu.find('.frame-side__group').first().hasClass('is-open') === true);

    // ---- 排序：接口即使返回乱序 / 字符串序号，渲染也必须按 sortNo 升序 ----
    var topTitles = $menu.children('.frame-side__group').map(function () {
        return $(this).find('.frame-side__group-title .txt').first().text();
    }).get();
    check('同级菜单组按排序号升序渲染（系统管理 1 → 帮助中心 99）',
        topTitles.join(',') === '系统管理,帮助中心', topTitles.join(','));
    var itemTitles = $menu.find('.frame-side__group[data-group="68"] .frame-side__item .txt').map(function () {
        return $(this).text();
    }).get();
    check('组内菜单项按显示序号升序渲染（1 菜单项管理 → 2 菜单组管理 → 3 菜单组项目管理）',
        itemTitles.join(',') === '菜单项管理,菜单组管理,菜单组项目管理', itemTitles.join(','));
    check('禁用叶子（关于系统）排在最后（sortNo 100）',
        $menu.children().last().find('.txt').first().text().indexOf('关于系统') === 0,
        $menu.children().last().find('.txt').first().text());

    // ---- 重载：增删改菜单后无需刷新整页 ----
    var htmlBefore = $menu.html();
    var callsBefore = navCalls;
    AppFrame.reloadNav();
    check('reloadNav 会重新拉取导航数据', navCalls === callsBefore + 1, navCalls + ' / ' + callsBefore);
    check('重载时不显示「正在加载菜单…」占位（静默）',
        $menu.find('.frame-side__loading').length === 0);
    check('数据未变化时不重建 DOM（避免闪烁 / 丢失折叠状态）', $menu.html() === htmlBefore);

    // 手动展开一个默认收缩的分组后重载：展开状态要保留
    // （用「帮助中心」验证：当前激活页在「系统管理」下，重载后 syncMenu 会把它重新展开以显示高亮项）
    check('默认收缩的「帮助中心」点击前是收起的',
        !$menu.find('.frame-side__group[data-group="10"]').hasClass('is-open'));
    $menu.find('.frame-side__group[data-group="10"] .frame-side__group-title').first().trigger('click');
    check('点击标题后「帮助中心」展开',
        $menu.find('.frame-side__group[data-group="10"]').hasClass('is-open'));

    // 新增一个排序号更小的同级菜单组 → 重载后应排到最前
    NAV.groups.push({
        id: 12, parentId: 0, level: 1, sortNo: 0, code: 'MNG9000', nameCn: '置顶分组',
        icon: 'setting', hasChild: 0, path: 'top.html', crumb: '置顶分组', children: [], items: []
    });
    AppFrame.reloadNav();
    check('菜单数据变化后会重建导航（新增的「置顶分组」已渲染）', /置顶分组/.test($menu.text()));
    check('新增的分组按 sortNo=0 排到菜单组最前（系统首页固定入口仍占第一位）',
        $menu.children().first().find('.txt').first().text() === '系统首页' &&
        $menu.children().eq(1).find('.txt').first().text() === '置顶分组',
        $menu.children().first().find('.txt').first().text() + ' / ' +
        $menu.children().eq(1).find('.txt').first().text());
    check('重载后保留用户展开状态（帮助中心仍为展开）',
        $menu.find('.frame-side__group[data-group="10"]').hasClass('is-open'));

    NAV.groups.pop();                       // 还原桩数据
    AppFrame.reloadNav();
    check('还原数据后「置顶分组」消失且「系统管理」回到首位',
        !/置顶分组/.test($menu.text()) &&
        $menu.children('.frame-side__group').first().find('.frame-side__group-title .txt').first().text() === '系统管理');

    var before = tabNames().length;
    $menu.find('.frame-side__item.is-disabled').trigger('click');
    check('点击禁用菜单不会新建 Tab', tabNames().length === before, JSON.stringify(tabNames()));

    /* ---------- Tab 交互 ---------- */
    console.log('\n--- 框架页 Tab 交互 ---');

    check('初始只有 1 个 Tab（系统首页）', tabNames().length === 1 && tabNames()[0] === '系统首页',
        JSON.stringify(tabNames()));
    check('首页 Tab 不可关闭（无关闭按钮）',
        $tabs.children('.frame-tab').first().find('[data-close]').length === 0);
    check('初始内容为系统首页',
        $panes.children('.frame-pane.is-active').find('iframe').attr('src') === 'home.html');
    check('顶部显示当前登录人', $.trim($('#frameName').text()) === '测试管理员'
        && $.trim($('#frameAvatar').text()) === '测', $('#frameName').text());
    check('顶部有退出登录按钮', $('#frameLogout').length === 1);

    // 导航点击 → 开新 Tab
    clickNav('menu-group.html');
    check('点击导航项新建 Tab', tabNames().length === 2 && tabNames()[1] === '菜单组管理', JSON.stringify(tabNames()));
    check('新 Tab 为激活态', activeName() === '菜单组管理', activeName());
    check('Tab 与内容面板一一对应', $tabs.children().length === $panes.children().length);
    check('新 Tab 内 iframe 指向 menu-group.html',
        $panes.children('.frame-pane.is-active').find('iframe').attr('src') === 'menu-group.html');

    clickNav('menu-group.html');
    check('重复点击同一菜单不叠加 Tab', tabNames().length === 2, JSON.stringify(tabNames()));

    clickNav('menu-group-item.html');
    check('第三个菜单再开一个 Tab', tabNames().length === 3, JSON.stringify(tabNames()));

    // 切换 Tab
    $tabs.children('.frame-tab').first().trigger('click');
    check('点击 Tab 可切回首页', activeName() === '系统首页', activeName());
    check('切换后面板同步（pane 与 tab 同 id）',
        activePaneId() === $tabs.children('.frame-tab.is-active').attr('data-id'));
    check('切回首页时左侧「系统首页」入口高亮（首页不再「无处可寻」）',
        $menu.find('.frame-side__item.is-active').length === 1 &&
        $menu.find('.frame-side__item.is-active').attr('data-url') === 'home.html',
        String($menu.find('.frame-side__item.is-active').attr('data-url')));

    // 关闭单个
    $tabs.children('.frame-tab').eq(2).find('[data-close]').trigger('click');
    check('关闭某个 Tab 后剩 2 个', tabNames().length === 2, JSON.stringify(tabNames()));
    check('关闭后无残留面板', $panes.children().length === 2);

    // 关闭其它 / 全部
    clickNav('menu-group.html');
    $('#tabCloseOthers').trigger('click');
    // 首页 Tab 固定不可关闭，因此「关闭其它」后 = 当前 Tab + 首页 Tab
    check('关闭其它后保留当前 Tab 与首页 Tab',
        tabNames().length === 2 && activeName() === '菜单组管理' &&
        tabNames()[0] === '系统首页', JSON.stringify(tabNames()));

    clickNav('menu-group-item.html');
    $('#tabCloseAll').trigger('click');
    check('关闭全部后回到系统首页 Tab', tabNames().length === 1 && activeName() === '系统首页', JSON.stringify(tabNames()));
    check('关闭全部后系统首页仍是第一个标签',
        $tabs.children('.frame-tab').first().find('.frame-tab__text').text() === '系统首页',
        $tabs.children('.frame-tab:first .frame-tab__text').text());
    clickNav('menu.html');        // 打开列表页，作为后续「表单页返回列表」的落点

    // 非菜单页（表单页）
    AppFrame.navigate('menu-form.html?mode=add');
    check('打开表单页会新建 Tab（系统首页 + 列表页 + 表单页）', tabNames().length === 3, JSON.stringify(tabNames()));
    check('表单页 Tab 可关闭',
        $tabs.children('.frame-tab.is-active').find('[data-close]').length === 1);
    check('表单页 Tab 的 iframe 带查询串',
        $panes.children('.frame-pane.is-active').find('iframe').attr('src') === 'menu-form.html?mode=add');

    // 子页返回列表：关闭自身并回到已存在的列表 Tab
    AppFrame.navigate('menu.html', { fromChild: true });
    check('子页返回列表时关闭表单 Tab（剩系统首页 + 菜单项管理）', tabNames().length === 2, JSON.stringify(tabNames()));
    check('子页返回后激活列表 Tab', activeName() === '菜单项管理', activeName());

    // 菜单页之间互跳不会误关当前页
    AppFrame.navigate('menu-group.html', { fromChild: true });
    AppFrame.navigate('menu.html', { fromChild: true });
    check('菜单页之间跳转不会误关 Tab', tabNames().length === 3, JSON.stringify(tabNames()));
    check('系统首页永远停在第一个标签（开了 3 个页签后仍在首位）',
        tabNames()[0] === '系统首页', JSON.stringify(tabNames()));

    /* ---------- 项目维护页：打页模式（替代新增/编辑弹窗） ---------- */
    AppFrame.navigate('project.html');
    var pjTabs = tabNames().length;
    AppFrame.navigate('project-form.html?mode=edit&id=prj-0000-4000-8000-000000000001');
    check('项目编辑页以框架新 Tab 打开（不再弹窗）',
        tabNames().length === pjTabs + 1, JSON.stringify(tabNames()));
    check('项目编辑页 Tab 的 iframe 带 mode=edit&id 查询串',
        $panes.children('.frame-pane.is-active').find('iframe').attr('src') ===
        'project-form.html?mode=edit&id=prj-0000-4000-8000-000000000001',
        String($panes.children('.frame-pane.is-active').find('iframe').attr('src')));
    check('项目表单页 Tab 可关闭',
        $tabs.children('.frame-tab.is-active').find('[data-close]').length === 1);
    AppFrame.navigate('project.html', { fromChild: true });
    check('表单页保存/返回后关闭自身 Tab 并激活项目列表 Tab',
        tabNames().length === pjTabs &&
        $panes.children('.frame-pane.is-active').find('iframe').attr('src') === 'project.html',
        JSON.stringify(tabNames()));

    /* ---------- 底部面包屑 ---------- */
    console.log('\n--- 底部面包屑 ---');

    check('底部存在面包屑容器', $('#frameCrumb').length === 1);
    $('#tabCloseAll').trigger('click');
    check('关闭全部后只剩系统首页，面包屑显示「系统首页」',
        tabNames().length === 1 && crumbText() === '系统首页', crumbText());

    clickNav('menu.html');
    check('菜单项管理 Tab 的面包屑 = 导航声明的层级路径',
        crumbText() === '系统管理/菜单配置/菜单项管理', crumbText());

    clickNav('menu-group.html');
    check('切到菜单组管理后面包屑同步', crumbText() === '系统管理/菜单配置/菜单组管理', crumbText());

    $tabs.children('.frame-tab').first().trigger('click');
    check('切回系统首页后面包屑显示「系统首页」', crumbText() === '系统首页', crumbText());

    // 表单页：子页面加载后主动上报自己的面包屑（模拟子页 layout.js 的 AppCrumb.push）
    AppFrame.navigate('menu-form.html?mode=add');
    check('表单页未就绪时挂在所属列表页面包屑之下',
        crumbText() === '系统管理/菜单配置/菜单项管理', crumbText());

    AppFrame.setCrumb('菜单项管理/新增菜单项');
    check('新增菜单项：面包屑带上父页（列表页）完整路径',
        crumbText() === '系统管理/菜单配置/菜单项管理/新增菜单项', crumbText());
    AppFrame.setCrumb('菜单项管理/编辑菜单项');
    check('编辑菜单项：面包屑同样带父页路径',
        crumbText() === '系统管理/菜单配置/菜单项管理/编辑菜单项', crumbText());

    // 切走再切回：仍显示该页自己的面包屑，而不是列表页的
    activateByUrl('menu.html');
    check('切回列表页显示列表页面包屑', crumbText() === '系统管理/菜单配置/菜单项管理', crumbText());
    $tabs.children('.frame-tab').last().trigger('click');
    check('切回表单页恢复其面包屑',
        crumbText() === '系统管理/菜单配置/菜单项管理/编辑菜单项', crumbText());

    // 菜单组表单页：从菜单组管理列表进入
    AppFrame.navigate('menu-group.html');
    AppFrame.navigate('menu-group-form.html?mode=add');
    AppFrame.setCrumb('菜单组管理/新增菜单组');
    check('新增菜单组：面包屑带父页路径',
        crumbText() === '系统管理/菜单配置/菜单组管理/新增菜单组', crumbText());
    AppFrame.setCrumb('菜单组管理/编辑菜单组');
    check('编辑菜单组：面包屑带父页路径',
        crumbText() === '系统管理/菜单配置/菜单组管理/编辑菜单组', crumbText());

    // 兜底：子页面未上报时，父框架直接读其 .page-head 上的 data-crumb
    AppFrame.navigate('menu-group-item-form.html?mode=add');
    if (fakeChild('菜单组项目管理/新增菜单组项目')) {
        AppFrame.refreshCrumb();
        check('兜底：父框架可直接读子页面声明值（并补上父页路径）',
            crumbText() === '系统管理/菜单配置/菜单组项目管理/新增菜单组项目', crumbText());
    } else {
        check('父框架读取子页声明（jsdom 无法写入 iframe，跳过）', true);
    }

    /* ---------- 顶部 / 底部文案与布局 ---------- */
    console.log('\n--- 顶栏与底栏 ---');

    check('顶部系统名来自系统参数表（applySysBrand 已把默认名替换为参数值）',
        $.trim($('#frameSysName').text()) === '星云综合管理平台' &&
        $.trim($('.frame-header__logo').text()).indexOf('星云综合管理平台') >= 0,
        $.trim($('.frame-header__logo').text()));
    check('页面标题后缀为参数表系统名',
        window.document.title.indexOf('星云综合管理平台') >= 0, window.document.title);
    check('底栏中间有版权与邮箱（含 © 与 sunbwj@163.com）',
        $('.frame-footer__copy').length === 1 &&
        $('.frame-footer__copy').text().indexOf('©') > -1 &&
        $('.frame-footer__copy').text().indexOf('sunbwj@163.com') > -1,
        $.trim($('.frame-footer__copy').text()));
    check('底栏顺序：面包屑 → 版权（居中） → 服务状态 / 日期',
        $('.frame-footer').children().length === 3 &&
        ($('#frameCrumb')[0].compareDocumentPosition($('.frame-footer__copy')[0]) & 4) !== 0 &&
        ($('.frame-footer__copy')[0].compareDocumentPosition($('#clock')[0]) & 4) !== 0,
        String($('.frame-footer').children().length));
    var footCss = read('css/app.css');
    var copyRule = footCss.slice(footCss.indexOf('.frame-footer__copy {'));
    copyRule = copyRule.slice(0, copyRule.indexOf('}'));
    check('版权区绝对居中于底栏中线（left: 50% + translateX(-50%) + text-align: center）',
        copyRule.indexOf('position: absolute') > -1 && copyRule.indexOf('left: 50%') > -1 &&
        copyRule.indexOf('translateX(-50%)') > -1 && copyRule.indexOf('text-align: center') > -1,
        copyRule.replace(/\s+/g, ' ').slice(0, 80));
    check('窄屏（≤768px）隐藏版权区，优先保证面包屑与日期',
        /\.frame-footer__copy\s*\{\s*display: none/.test(read('css/app.css')));
    check('底部面包屑位于最左（排在日期之前）',
        ($('#frameCrumb')[0].compareDocumentPosition($('#clock')[0]) & 4) !== 0);
    var pos = $('#frameCrumb')[0].compareDocumentPosition($('#clock')[0]);
    check('面包屑排在日期的左侧', (pos & 4) !== 0, String(pos));
    check('服务状态不再显示「菜单项 X 条」等统计',
        $('#apiStatus').text().indexOf('菜单项') < 0 && $('#apiStatus').text().indexOf('条') < 0,
        $('#apiStatus').text());

    /* ---------- 左侧导航：收起 / 展开 ---------- */
    console.log('\n--- 左侧导航收起 / 展开 ---');

    var $side = $('#frameSide');
    var $collapse = $('#frameSideCollapse');
    check('侧栏存在收起 / 展开按钮', $collapse.length === 1);
    check('收起按钮贴在侧栏右边缘（位于菜单区之前，CSS 绝对定位到右侧居中）',
        $collapse.parent().is('#frameSide') &&
        $collapse[0].compareDocumentPosition($('#frameMenu')[0]) === 4,
        'parent=' + $collapse.parent().attr('id'));
    check('默认展开（无 is-collapsed）', $side.hasClass('is-collapsed') === false);
    check('收起按钮为纯图标（不含文字节点）',
        $collapse.find('.ico').length === 1 && $collapse.find('.txt').length === 0,
        'ico=' + $collapse.find('.ico').length + ' txt=' + $collapse.find('.txt').length);
    check('按钮默认提示为「收起导航」', $collapse.attr('title') === '收起导航',
        String($collapse.attr('title')));

    $collapse.trigger('click');
    check('点击后侧栏收起（is-collapsed）', $side.hasClass('is-collapsed') === true);
    check('收起后按钮提示变「展开导航」', $collapse.attr('title') === '展开导航',
        String($collapse.attr('title')));
    check('收起状态写入 localStorage（刷新保持）',
        window.localStorage.getItem('app.side.collapsed') === '1',
        String(window.localStorage.getItem('app.side.collapsed')));
    check('收起态不再展开分组子菜单（aria-expanded=false）',
        $collapse.attr('aria-expanded') === 'false', String($collapse.attr('aria-expanded')));
    check('收起态菜单项带名称提示（只留图标时悬停可见）',
        $menu.find('.frame-side__item[data-url="menu.html"]').attr('title') === '系统管理/菜单配置/菜单项管理',
        String($menu.find('.frame-side__item[data-url="menu.html"]').attr('title')));
    check('分组标题也带名称提示',
        $menu.find('.frame-side__group[data-group="68"]').children('.frame-side__group-title').attr('title') === '菜单配置',
        String($menu.find('.frame-side__group[data-group="68"]').children('.frame-side__group-title').attr('title')));

    // 收起态：点击分组 → 子菜单以悬浮面板弹出
    var $grp = $menu.find('.frame-side__group[data-group="68"]');
    $grp.children('.frame-side__group-title').trigger('click');
    var $fly = $('#frameFlyout');
    check('收起态点击分组弹出悬浮子菜单', $fly.length === 1 && $fly.hasClass('is-show'));
    check('悬浮面板内列出该分组的菜单项',
        $fly.find('.frame-side__item[data-url="menu.html"]').length === 1,
        String($fly.find('.frame-side__item').length));
    $fly.find('.frame-side__item[data-url="menu-group-item.html"]').trigger('click');
    check('点击悬浮面板中的菜单项可打开 Tab',
        tabNames().indexOf('菜单组项目管理') >= 0, JSON.stringify(tabNames()));
    check('打开页面后悬浮面板收起', $fly.hasClass('is-show') === false);

    $collapse.trigger('click');
    check('再次点击恢复展开', $side.hasClass('is-collapsed') === false);
    check('展开状态写回 localStorage',
        window.localStorage.getItem('app.side.collapsed') === '0',
        String(window.localStorage.getItem('app.side.collapsed')));
    check('展开后分组子菜单不弹出', $('#frameFlyout').hasClass('is-show') === false);

    AppFrame.toggleCollapse(true);
    check('AppFrame.toggleCollapse(true) 可收起', $side.hasClass('is-collapsed') === true);
    AppFrame.toggleCollapse(false);
    check('AppFrame.toggleCollapse(false) 可展开', $side.hasClass('is-collapsed') === false);

    /* ---------- 主题切换 ---------- */
    console.log('\n--- 主题切换 ---');

    var AppTheme = window.AppTheme;
    check('顶部存在主题切换按钮', $('#frameTheme').find('[data-theme-btn]').length === 1);
    check('换肤按钮为小图标（含图标且无可见文字占位）',
        $('#frameTheme').find('[data-theme-btn] .ico').length === 1 &&
        $('#frameTheme').find('[data-theme-btn] .txt').length === 1,
        'ico=' + $('#frameTheme').find('[data-theme-btn] .ico').length);
    check('换肤按钮带当前主题色点',
        $('#frameTheme').find('[data-theme-btn] .theme-switch__dot').length === 1);
    check('主题面板默认收起', $('#frameTheme').find('[data-theme-panel]').hasClass('is-open') === false);
    $('#frameTheme').find('[data-theme-btn]').trigger('click');
    check('点击按钮展开主题面板', $('#frameTheme').find('[data-theme-panel]').hasClass('is-open') === true);
    check('面板列出 7 套主题', $('#frameTheme').find('.theme-panel__item').length === 7,
        String($('#frameTheme').find('.theme-panel__item').length));
    check('主题面板含「淡雅灰」（灰色系）',
        $('#frameTheme').find('.theme-panel__item[data-theme-id="gray"]').length === 1 &&
        /淡雅灰/.test($('#frameTheme').find('.theme-panel__item[data-theme-id="gray"]').text()),
        $('#frameTheme').find('.theme-panel__item[data-theme-id="gray"]').text());

    check('默认主题为经典蓝', AppTheme.get() === 'blue' &&
        window.document.documentElement.getAttribute('data-theme') === 'blue',
        window.document.documentElement.getAttribute('data-theme'));

    // 选中「墨绿」
    $('#frameTheme').find('.theme-panel__item[data-theme-id="green"]').trigger('click');
    check('切换到墨绿后 <html data-theme=green>',
        window.document.documentElement.getAttribute('data-theme') === 'green',
        window.document.documentElement.getAttribute('data-theme'));
    check('主题写入 localStorage（刷新后保持）',
        window.localStorage.getItem('app.theme') === 'green',
        String(window.localStorage.getItem('app.theme')));
    check('选择后面板收起', $('#frameTheme').find('[data-theme-panel]').hasClass('is-open') === false);
    check('按钮显示当前主题名',
        $.trim($('#frameTheme').find('[data-theme-btn] .txt').text()) === '墨绿',
        $.trim($('#frameTheme').find('[data-theme-btn] .txt').text()));
    check('面板中「墨绿」为选中态',
        $('#frameTheme').find('.theme-panel__item[data-theme-id="green"]').hasClass('is-active'));

    // 灰色系淡雅主题：可切换并写入 localStorage，色点与面板选中态同步
    $('#frameTheme').find('.theme-panel__item[data-theme-id="gray"]').trigger('click');
    check('可切换到「淡雅灰」主题',
        window.document.documentElement.getAttribute('data-theme') === 'gray' &&
        AppTheme.get() === 'gray',
        window.document.documentElement.getAttribute('data-theme'));
    check('切换到淡雅灰后按钮文案与面板选中态同步',
        $.trim($('#frameTheme').find('[data-theme-btn] .txt').text()) === '淡雅灰' &&
        $('#frameTheme').find('.theme-panel__item[data-theme-id="gray"]').hasClass('is-active'),
        $.trim($('#frameTheme').find('[data-theme-btn] .txt').text()));
    AppTheme.set('blue');

    // 主题同步到 iframe 内的功能页
    AppFrame.navigate('menu.html');
    if (fakeChild('系统管理/菜单配置/菜单项管理')) {
        AppTheme.set('orange');
        var childDoc = $panes.children('.frame-pane.is-active').find('iframe')[0].contentWindow.document;
        check('切换主题会同步到 Tab 内的功能页',
            childDoc.documentElement.getAttribute('data-theme') === 'orange',
            String(childDoc.documentElement.getAttribute('data-theme')));
        AppTheme.set('blue');
    } else {
        check('主题同步到 iframe（jsdom 无法写入，跳过）', true);
    }
    check('可切回经典蓝', window.document.documentElement.getAttribute('data-theme') === 'blue' &&
        AppTheme.get() === 'blue');

    /* ---------- 系统品牌（syspara → 顶部 / 底部 / 标题后缀） ---------- */
    console.log('\n--- 系统品牌（syspara） ---');
    check('顶部系统名称已替换为参数表值',
        $('#frameSysName').text() === '星云综合管理平台', $('#frameSysName').text());
    check('顶部系统图标已替换为参数表值',
        $('#frameSysLogo').attr('src') === '/assets/logo2.svg', String($('#frameSysLogo').attr('src')));
    check('底部系统名称已替换为参数表值',
        $('#frameFooterName').text() === '星云综合管理平台', $('#frameFooterName').text());
    check('浏览器标题 = 当前页名 + 参数表系统名后缀',
        window.document.title.indexOf(' - 星云综合管理平台') > 0, window.document.title);
    check('main.html 顶部/底部名称与图标均带 id（供 applySysBrand 定位）',
        read('main.html').indexOf('id="frameSysName"') > -1 &&
        read('main.html').indexOf('id="frameFooterName"') > -1 &&
        read('main.html').indexOf('id="frameSysLogo"') > -1);
    check('home.html 主标题 / 英文名带 id（home.js 从 syspara 取名）',
        read('home.html').indexOf('id="homeSysName"') > -1 &&
        read('home.html').indexOf('id="homeSysNameEn"') > -1);
    check('frame.js 标题后缀剥离支持动态系统名（titleSuffixRe）',
        read('js/frame.js').indexOf('titleSuffixRe()') > -1 &&
        read('js/frame.js').indexOf("'app_name', 'site_name'") > -1);
    check('home.js 品牌取数（app_name / app_ennme，兼容旧键）',
        read('js/home.js').indexOf("pick(['app_name', 'site_name'])") > -1 &&
        read('js/home.js').indexOf("pick(['app_ennme', 'app_enname'])") > -1);

    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}
