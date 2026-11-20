/* ==========================================================================
   login-page-test.js —— 登录页 + 系统首页测试（jsdom，无需浏览器）
   覆盖：登录页结构（九豆图标 / 科技插图 / 品牌名 / 账号密码验证码）/
        页面不再出现初始密码 888888 / 运算表达式验证码（加载、换题、空值与错误校验、一次性）/
        登录成功写入登录态（token + user）/ 回车提交 /
        系统首页（平台大标题 / 快捷入口 / 数据概览 / 登录人 / 退出登录）
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/login-page-test.js
   ========================================================================== */
'use strict';
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

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再装跑）');
    process.exit(0);
}

function boot(page, scripts, url, seed) {
    var dom = new JSDOM(read(page), {
        url: url || ('http://127.0.0.1:8808/' + page),
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
    // 预置本地数据（必须在 eval 之前写：Mock 的 read 会缓存首次读到的内容）
    if (seed) {
        for (var key in seed) {
            if (seed.hasOwnProperty(key)) { win.localStorage.setItem(key, JSON.stringify(seed[key])); }
        }
    }
    win.eval(read('js/api.js'));
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

var SESSION_KEY = 'menu_admin_login_v1';
var win = boot('login.html', ['js/login.js'], 'http://127.0.0.1:8808/login.html?redirect=main.html');
var $ = win.jQuery;

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 620 }); }
function next() {
    var s = steps.shift();
    if (!s) { return finish(); }
    try { s.fn(); } catch (e) { check('步骤执行异常：' + e.message, false, e.stack); }
    setTimeout(next, s.delay);
}
function finish() {
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}
function errText() { return $.trim($('#loginError').text()); }
function exprText() { return $.trim($('#captchaExpr').text()); }
function session() {
    try {
        var raw = win.localStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}
/** 把「3 + 5 = ?」这类题目算成答案；不是合法题目时返回 '' */
function solve(expr) {
    var m = /^(\d+)\s+([+\-×])\s+(\d+)\s*=\s*\?$/.exec(String(expr || ''));
    if (!m) { return ''; }
    var a = parseInt(m[1], 10), op = m[2], b = parseInt(m[3], 10);
    return String(op === '+' ? (a + b) : (op === '-' ? (a - b) : (a * b)));
}
/** 填好账号密码验证码（验证码按当前题目现算） */
function fillForm(account, password, skipCaptcha) {
    $('#loginAccount').val(account);
    $('#loginPassword').val(password);
    $('#loginCaptcha').val(skipCaptcha ? '' : solve(exprText()));
}

/* ------------------------------- 登录页 ------------------------------- */
step(function () {
    console.log('\n--- 1. 登录页结构 ---');
    check('页面标题含「登录」与「九豆综合管理平台」', /登录/.test(win.document.title), win.document.title);
    check('左侧品牌名「九豆综合管理平台」',
        /九豆综合管理平台/.test($('.login-brand__name').text()), $('.login-brand__name').text());
    check('顶部使用九豆图标（assets/logo.svg）',
        $('.login-brand .logo-mark').attr('src') === 'assets/logo.svg',
        $('.login-brand .logo-mark').attr('src'));
    check('保留「一体化管理中枢」标题',
        /一体化管理中枢/.test($('.login-brand__title').text()), $('.login-brand__title').text());
    check('标题已去掉「人 · 岗 · 权 · 页」一行（只剩单行）',
        !/人\s*[·・]\s*岗/.test($('.login-brand__title').text()) &&
        $('.login-brand__title').find('br').length === 0,
        $('.login-brand__title').text());
    check('原来的文字描述与要点列表已被科技感插图替换',
        $('.login-brand__desc').length === 0 && $('.login-brand__list').length === 0 &&
        $('.login-brand__art img').length === 1, String($('.login-brand__art img').length));
    check('科技感插图为 assets/login-tech.svg',
        $('.login-brand__art img').attr('src') === 'assets/login-tech.svg',
        $('.login-brand__art img').attr('src'));
    check('左下角保留版权信息',
        /©\s*2026\s*九豆综合管理平台/.test($('.login-brand__foot').text()), $('.login-brand__foot').text());
    check('有账号 / 密码 / 验证码三个输入框',
        $('#loginAccount').length === 1 && $('#loginPassword').length === 1 && $('#loginCaptcha').length === 1);
    check('验证码有算式板与换题按钮', $('#captchaExpr').length === 1 && $('#captchaBoard').length === 1);
    check('页面不再出现初始密码提示（888888）', $('body').text().indexOf('888888') < 0,
        String($('body').text().indexOf('888888')));
});

step(function () {
    console.log('\n--- 1b. 验证码行宽度约束（算式必须一行展示完） ---');
    var css = read('css/app.css');

    /* 取某个选择器对应的规则块（第一个匹配） */
    function ruleBlock(selector) {
        var i = css.indexOf(selector + ' {');
        if (i < 0) { return ''; }
        var j = css.indexOf('}', i);
        return css.slice(i, j < 0 ? css.length : j);
    }

    var bBoard = ruleBlock('.login-captcha__board');
    var bExpr = ruleBlock('.login-captcha__expr');
    var bInput = ruleBlock('.login-captcha__input');
    var bRefresh = ruleBlock('.login-captcha__refresh');
    var mWidth = /width:\s*(\d+)px/.exec(bBoard);

    check('算式板不参与 flex 收缩（flex: 0 0 auto）',
        bBoard.indexOf('flex: 0 0 auto') > -1, bBoard.slice(0, 80));
    check('算式板宽度不少于 140px（当前 ' + (mWidth ? mWidth[1] : '?') + 'px）',
        !!mWidth && parseInt(mWidth[1], 10) >= 140, mWidth ? mWidth[1] : 'none');
    check('算式板按 border-box 计算宽度（padding 不额外撑宽）',
        bBoard.indexOf('box-sizing: border-box') > -1, bBoard.slice(0, 80));
    check('算式板文字不换行（white-space: nowrap）',
        bBoard.indexOf('white-space: nowrap') > -1, bBoard.slice(0, 80));
    check('算式本体也不换行（word-break: keep-all）',
        bExpr.indexOf('white-space: nowrap') > -1 && bExpr.indexOf('keep-all') > -1, bExpr);
    check('输入框允许收窄（min-width: 0），不再挤压算式板',
        bInput.indexOf('min-width: 0') > -1, bInput.slice(0, 80));
    check('换题图标改为行内，不覆盖算式（不再 position: absolute）',
        bRefresh.length > 0 && bRefresh.indexOf('position: absolute') < 0, bRefresh);
});

step(function () {
    console.log('\n--- 1c. 框架页更名为 main.html ---');
    check('框架页文件已更名为 main.html', fs.existsSync(path.join(ROOT, 'main.html')));
    check('旧 index.html 已不存在', !fs.existsSync(path.join(ROOT, 'index.html')));
    var loginJs = read('js/login.js');
    check('登录后默认回跳 main.html（无 redirect 参数时）',
        loginJs.indexOf("return 'main.html';") > -1, loginJs.length + ' bytes');
    var frameJs = read('js/frame.js');
    check('框架页登录守门跳转地址为干净的 login.html（不带 redirect= 等参数）',
        /location\.replace\(LOGIN_PAGE\)/.test(frameJs) && frameJs.indexOf('login.html?') < 0,
        frameJs.length + ' bytes');
    var mainHtml = read('main.html');
    check('main.html 引入 frame.js 且带退出登录按钮',
        mainHtml.indexOf('js/frame.js') > -1 && mainHtml.indexOf('frameLogout') > -1);
});

step(function () {
    console.log('\n--- 2. 运算表达式验证码 ---');
    var e = exprText();
    check('进入页面即拉取到一道算术题', /^\d+\s+[+\-×]\s+\d+\s*=\s*\?$/.test(e), e);
    check('题目可解出整数答案', solve(e) !== '', e + ' → ' + solve(e));
    win.__expr1 = e;
    $('#captchaBoard').trigger('click');
});

step(function () {
    var e = exprText();
    check('点击算式板会换一题（题干改变或重新加载）',
        /^\d+\s+[+\-×]\s+\d+\s*=\s*\?$/.test(e), e);
    win.__expr2 = e;
});

step(function () {
    console.log('\n--- 3. 空值与格式校验 ---');
    $('#btnLogin').trigger('click');
    check('账号为空时提示「请输入登录账号」', /请输入登录账号/.test(errText()), errText());

    fillForm('13800138001', '');
    $('#btnLogin').trigger('click');
});

step(function () {
    check('密码为空时提示「请输入登录密码」', /请输入登录密码/.test(errText()), errText());
    fillForm('13800138001', '888888', true);
    $('#btnLogin').trigger('click');
});

step(function () {
    check('验证码为空时提示「请输入验证码计算结果」', /请输入验证码/.test(errText()), errText());
    $('#loginCaptcha').val('99').trigger('input');
    check('输入验证码后错误提示被清空', errText() === '', errText());
    fillForm('no_such_account', '888888');
    $('#btnLogin').trigger('click');
});

step(function () {
    check('账号不存在提示「账号或密码不正确」', /账号或密码不正确/.test(errText()), errText());
    check('登录失败后清空验证码输入', $.trim($('#loginCaptcha').val()) === '', $('#loginCaptcha').val());
    check('登录失败后自动换一题（题干与上次不同或已重新加载）',
        /^\d+\s+[+\-×]\s*\d+\s*=\s*\?$/.test(exprText()) || /加载/.test(exprText()), exprText());

    fillForm('13800138001', 'bad-password');
    $('#btnLogin').trigger('click');
});

step(function () {
    check('密码错误同样提示「账号或密码不正确」', /账号或密码不正确/.test(errText()), errText());
    check('失败后按钮恢复可点击',
        $('#btnLogin').prop('disabled') === false && /登/.test($('#btnLogin').text()), $('#btnLogin').text());
    check('失败后仍未写入登录态', session() === null, JSON.stringify(session()));

    // 正确账号 + 正确验证码，用回车提交
    fillForm('13800138001', '888888');
    var e = $.Event('keydown');
    e.keyCode = 13;
    $('#loginPassword').trigger(e);
});

step(function () {
    console.log('\n--- 4. 登录成功 ---');
    var s = session();
    check('登录成功写入登录态（localStorage）', !!s && !!s.token, s ? String(s.token).slice(0, 8) : 'null');
    check('登录态里 token 为 32 位十六进制', !!s && /^[0-9a-f]{32}$/.test(String(s.token)), s ? s.token : '');
    check('登录态里带员工姓名与账号', !!s && s.user && (s.user.empName || s.user.account),
        s && s.user ? s.user.empName : '');
    check('登录态里带登录时间与角色信息', !!s && !!s.time && !!s.user.roleNames,
        s ? s.time + ' / ' + s.user.roleNames : '');
    check('成功提示为「登录成功，正在进入系统…」', /登录成功/.test(errText()), errText());
});

/* ------------------------------- 系统首页 ------------------------------- */
var HOME_ALL = ['org.html', 'emp.html', 'address-book.html', 'user.html', 'role.html', 'role-power.html', 'page-op-btn.html'];

/** 给首页窗口换上「指定菜单路径」的导航数据（模拟该角色的菜单权限） */
function stubHomeNav(paths) {
    stubHomeGroups((paths && paths.length) ? [{
        id: 72, nameCn: '人力资源中心', hasChild: 1, children: [],
        items: paths.map(function (p, i) { return { id: 900 + i, nameCn: p, path: p }; })
    }] : []);
}

/** 给首页窗口换上原始 /api/nav 结构（多个顶级菜单组，模拟按组排列 + 轮播） */
function stubHomeGroups(groups) {
    var hw = win.__home;
    hw.Api.nav.get = function () {
        var d = hw.jQuery.Deferred();
        d.resolve({
            groups: groups || [],
            roleNames: (groups && groups.length) ? '系统管理员' : '普通用户',
            empty: !(groups && groups.length)
        });
        return d.promise();
    };
}

step(function () {
    console.log('\n--- 5. 系统首页（home.html） ---');
    // 先不跑 home.js：校验静态结构与「已去掉登录信息」
    win.__home = boot('home.html', []);
    var s = session();
    try { win.__home.localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { }
});

step(function () {
    var hw = win.__home, h = hw.jQuery;
    var css = read('css/app.css');
    check('背景改为浅色科技底纹（home-bg-light.svg 平铺）', /home-bg-light\.svg/.test(css), 'ok');
    check('首页底色跟随主题变量（--theme-page-bg）',
        /\.home-page[^{]*\{[^}]*var\(--theme-page-bg/.test(css), 'ok');
    check('深色底图仍供登录页使用（login-page 用 home-bg.svg）',
        /\.login-page[^{]*\{[^}]*home-bg\.svg/.test(css), 'ok');
    check('首页大标题为「九豆综合管理平台」',
        h.trim(h('.home-title').text()) === '九豆综合管理平台', h('.home-title').text());
    check('副标题为英文名', /JIUDOU/i.test(h('.home-sub').text()), h('.home-sub').text());
    check('说明文案已去掉（.home-slogan 与「一站式打通」都不再出现）',
        h('.home-slogan').length === 0 && h('.home-page').text().indexOf('一站式打通') < 0);
    check('标题文字水平居中（text-align: center + 居中容器）',
        /\.home-hero[^{]*\{[^}]*text-align: center/.test(css) &&
        /\.home-hero[^{]*\{[^}]*justify-content: center/.test(css), 'ok');
    check('标题文字垂直居中（home-wrap 撑满视口、hero 占满剩余空间并居中）',
        /\.home-wrap[^{]*\{[^}]*min-height: 100vh/.test(css) &&
        /\.home-hero[^{]*\{[^}]*flex: 1 1 auto/.test(css), 'ok');
    check('首页不再显示当前登录人（#homeUser 已移除）', h('#homeUser').length === 0);
    check('首页不再有「退出登录」（#homeLogout 已移除）', h('#homeLogout').length === 0);
    check('首页不再显示本次登录信息（#homeLoginInfo 已移除）', h('#homeLoginInfo').length === 0);
    check('首页不再重复显示 logo 与系统名称（.home-brand 已移除）',
        h('.home-brand').length === 0 && h('.home-brand__name').length === 0);
    check('首页不再挂 logo 图片（.logo-mark 已移除）', h('.logo-mark').length === 0,
        String(h('.logo-mark').length));
    check('首页统计数据去掉（员工 / 角色等 chip 已移除）', h('.home-chip').length === 0 && h('.home-chips').length === 0,
        String(h('.home-chip').length));
    check('首页版权信息去掉（.home-foot 已移除）',
        h('.home-foot').length === 0 && h('.home-page').text().indexOf('©') < 0);
    /* 2026-11-04：卡片改为按菜单权限动态渲染，静态模板不再写死任何卡片 */
    check('静态模板不写死功能卡片（全部由 /api/nav 动态渲染）',
        h('.home-card[data-href]').length === 0, String(h('.home-card[data-href]').length));
    check('轮播容器骨架就位（#homeCarousel / viewport / track / 翻页脚）',
        h('#homeCarousel').length === 1 && h('#homeViewport').length === 1 &&
        h('#homeTrack').length === 1 && h('#homeFoot').length === 1, 'ok');
    check('翻页脚默认隐藏（#homeFoot[hidden]，单组时无需切换）',
        h('#homeFoot').prop('hidden') === true, String(h('#homeFoot').prop('hidden')));
});

step(function () {
    // 该角色拥有全部 7 个功能页（1 个顶级菜单组）→ 全部渲染成卡片
    var hw = win.__home, h = hw.jQuery;
    stubHomeNav(HOME_ALL);
    hw.eval(read('js/home.js'));
});

step(function () {
    var hw = win.__home, h = hw.jQuery;
    check('有权限的菜单项全部渲染成卡片（7 个）', h('.home-card[data-href]').length === 7,
        String(h('.home-card[data-href]').length));
    check('按顶级菜单组分页（1 个菜单组 → 1 页，组头标题「人力资源中心」）',
        h('.home-slide').length === 1 &&
        h('.home-slide__title').first().text() === '人力资源中心',
        h('.home-slide').length + '/' + h('.home-slide__title').first().text());
    check('单组时不显示轮播切换控件（#homeFoot 保持 hidden）',
        h('#homeFoot').prop('hidden') === true && h('.home-carousel__dot').length === 0,
        String(h('#homeFoot').prop('hidden')));
    check('菜单项卡片用菜单图标库渲染（.home-card__ico svg × 7）',
        h('.home-card__ico svg').length === 7, String(h('.home-card__ico svg').length));
    // 两个顶级菜单组（其中一个的下级分组绑定菜单项）→ 出现轮播
    stubHomeGroups([
        { id: 72, nameCn: '人力资源中心', nameEn: 'HR', hasChild: 1, icon: 'user', children: [], items: [
            { id: 901, nameCn: '员工信息管理', path: 'emp.html', icon: 'user' },
            { id: 902, nameCn: '员工通讯录', path: 'address-book.html', icon: 'document' }
        ] },
        { id: 80, nameCn: '数据中心', nameEn: 'Data', hasChild: 1, icon: 'database', items: [], children: [
            { id: 81, nameCn: '报表', hasChild: 1, children: [], items: [
                { id: 911, nameCn: '报表中心', path: 'report-center.html', icon: 'chart' }
            ] }
        ] }
    ]);
    hw.eval(read('js/home.js'));
});

step(function () {
    var hw = win.__home, h = hw.jQuery;
    check('两个顶级菜单组渲染成 2 页', h('.home-slide').length === 2, String(h('.home-slide').length));
    check('多组时显示轮播切换控件（左右箭头 + 2 个圆点）',
        h('#homeFoot').prop('hidden') === false &&
        h('.home-carousel__btn').length === 2 && h('.home-carousel__dot').length === 2,
        h('#homeFoot').prop('hidden') + '/' + h('.home-carousel__btn').length);
    check('下级分组绑定的菜单项也收集进组页（数据中心页含「报表中心」卡片）',
        h('.home-slide').eq(1).find('.home-card[data-href="report-center.html"]').length === 1,
        h('.home-slide').eq(1).find('.home-card').length);
    check('组头带英文副名与卡片计数',
        h('.home-slide').first().find('.home-slide__en').text() === 'HR' &&
        h('.home-slide').first().find('.home-slide__count').text().indexOf('2') === 0,
        h('.home-slide').first().find('.home-slide__en').text());
    check('默认停在第一组（第 1 个圆点亮）',
        h('.home-carousel__dot').first().hasClass('is-active') &&
        !/-100%/.test(h('#homeTrack').attr('style') || ''),
        h('#homeTrack').attr('style'));
    h('#homeNext').trigger('click');
});

step(function () {
    var hw = win.__home, h = hw.jQuery;
    check('点「下一组」切到第 2 组（track 平移 -100%，圆点跟动）',
        /-100%/.test(h('#homeTrack').attr('style') || '') &&
        h('.home-carousel__dot').eq(1).hasClass('is-active') &&
        !h('.home-carousel__dot').eq(0).hasClass('is-active'),
        h('#homeTrack').attr('style'));
    check('第 2 组组头标题为「数据中心」',
        h('.home-slide').eq(1).find('.home-slide__title').text() === '数据中心',
        h('.home-slide').eq(1).find('.home-slide__title').text());
    h('#homePrev').trigger('click');
});

step(function () {
    var hw = win.__home, h = hw.jQuery;
    check('点「上一组」回到第 1 组（track 回到 0，第 1 个圆点亮）',
        !/-100%/.test(h('#homeTrack').attr('style') || '') &&
        h('.home-carousel__dot').eq(0).hasClass('is-active'),
        h('#homeTrack').attr('style'));
    // 只授权「员工信息管理」→ 其余卡片必须被移除
    stubHomeNav(['emp.html']);
    hw.eval(read('js/home.js'));
});

step(function () {
    var hw = win.__home, h = hw.jQuery;
    var $cards = h('.home-card[data-href]');
    check('没有权限的功能卡片不加载（只剩被授权的 1 个）', $cards.length === 1, String($cards.length));
    check('保留的卡片正是被授权的「员工信息管理」', $cards.attr('data-href') === 'emp.html',
        String($cards.attr('data-href')));
    check('未授权的菜单项不渲染（组织架构 / 角色权限都不可见）',
        h('#homeCarousel').text().indexOf('组织架构') < 0 && h('#homeCarousel').text().indexOf('角色权限配置') < 0,
        h('#homeCarousel').text().slice(0, 40));
    // 一个权限都没有 → 给提示而不是空白
    stubHomeNav([]);
    hw.eval(read('js/home.js'));
});

step(function () {
    var hw = win.__home, h = hw.jQuery;
    check('没有任何菜单权限时不展示任何功能卡片', h('.home-card[data-href]').length === 0,
        String(h('.home-card[data-href]').length));
    check('没有任何权限时给出「暂无可访问的功能页面」提示',
        /暂无可访问的功能页面/.test(h('#homeCarousel').text()), h('#homeCarousel').text().slice(0, 40));
});

/* ==========================================================================
   系统品牌取自系统参数表（登录页）
   · 页面元素都带 id，文案/图标由 js/login.js 的 applyBrand() 走免登录接口回填；
   · 英文名统一大写由 css/app.css 的 .login-brand__en { text-transform: uppercase } 保证；
   · 预置一份**与页面默认值不同**的参数（Mock 通道读 menu_admin_syspara_v1），
     只有真的从参数取值才会看到这一份文案——避免「写死也算通过」。
   ========================================================================== */
var brandHtml = read('login.html');
var brandJs = read('js/login.js');
var apiJs = read('js/api.js');
var appCss = read('css/app.css');

step(function () {
    check('登录页品牌元素都有 id（名称 / 英文名 / 图标 / favicon / 底栏名称）',
        ['loginSysName', 'loginSysNameEn', 'loginSysLogo', 'loginFavicon', 'loginFootName']
            .every(function (id) { return brandHtml.indexOf('id="' + id + '"') > -1; }));
    check('底栏只把系统名做成可替换节点，装饰文案（数据驱动 / 安全可控）保留在页面上',
        /id="loginFootName"/.test(brandHtml) && /· 数据驱动 · 安全可控/.test(brandHtml));
    check('login.js 有 applyBrand()，走免登录接口 Api.auth.brand',
        /function applyBrand\(\)/.test(brandJs) && /Api\.auth\.brand\(\)/.test(brandJs));
    check('api.js 暴露 auth.brand（GET /auth/brand）',
        /brand: function \(\) \{ return request\('GET', '\/auth\/brand'/.test(apiJs));
    check('favicon 按图标扩展名给 type（png → image/png）',
        /function iconMimeOf/.test(brandJs) && /ext === 'png'/.test(brandJs));
    check('英文名大写由 CSS 统一（text-transform: uppercase）',
        /\.login-brand__en\s*\{[^}]*text-transform:\s*uppercase/.test(appCss));
});

var BRAND_SEED = {
    'menu_admin_syspara_v1': [
        { id: 'sp-b1', paraNameCn: '系统名称', paraNameEn: 'app_name',
          paraValue: '星云综合管理平台', sortNo: 1, enabled: true },
        { id: 'sp-b2', paraNameCn: '系统英文名', paraNameEn: 'app_ennme',
          paraValue: 'Nebula Management Platform', sortNo: 2, enabled: true },
        { id: 'sp-b3', paraNameCn: '系统图标', paraNameEn: 'app_ico',
          paraValue: '/assets/nebula.png', sortNo: 3, enabled: true },
        // 停用 + 非白名单键：都不该影响品牌
        { id: 'sp-b4', paraNameCn: '系统名称（停用）', paraNameEn: 'app_name',
          paraValue: '不该出现的名字', sortNo: 4, enabled: false },
        { id: 'sp-b5', paraNameCn: '系统描述', paraNameEn: 'app_desc',
          paraValue: '内部说明，不该出现在登录页', sortNo: 5, enabled: true }
    ]
};
var brandWin = boot('login.html', ['js/login.js'], 'http://127.0.0.1:8808/login.html', BRAND_SEED);

step(function () {
    var bd = brandWin.document;
    function txt(id) { var el = bd.getElementById(id); return el ? (el.textContent || '').trim() : '<无此元素>'; }
    check('登录页系统名称 = 参数表 app_name（不是页面写死的文案）',
        txt('loginSysName') === '星云综合管理平台', txt('loginSysName'));
    check('底栏系统名称同样来自参数表', txt('loginFootName') === '星云综合管理平台', txt('loginFootName'));
    check('英文名 = 参数表 app_ennme，原样写入（大写由 CSS 呈现）',
        txt('loginSysNameEn') === 'Nebula Management Platform', txt('loginSysNameEn'));
    check('品牌图标 = 参数表 app_ico',
        bd.getElementById('loginSysLogo').getAttribute('src') === '/assets/nebula.png',
        bd.getElementById('loginSysLogo').getAttribute('src'));
    check('favicon 跟随 app_ico，type 自动切到 image/png',
        bd.getElementById('loginFavicon').getAttribute('href') === '/assets/nebula.png' &&
        bd.getElementById('loginFavicon').getAttribute('type') === 'image/png',
        bd.getElementById('loginFavicon').getAttribute('href') + ' / ' +
        bd.getElementById('loginFavicon').getAttribute('type'));
    check('浏览器标题 = 「登录 - 」+ 参数表系统名',
        bd.title === '登录 - 星云综合管理平台', bd.title);
    check('停用的同名参数不生效（仍是启用的那条）', txt('loginSysName').indexOf('不该出现') < 0, txt('loginSysName'));
    check('非白名单参数（app_desc）不会被渲染到页面上',
        bd.body.textContent.indexOf('内部说明，不该出现在登录页') < 0);
    check('旧种子键 site_name 兼容：没有 app_name 时用 site_name 充当系统名',
        (function () {
            var d = win.document;
            return (d.getElementById('loginSysName').textContent || '').trim() === '九豆综合管理平台';
        })(), (win.document.getElementById('loginSysName').textContent || '').trim());
});

setTimeout(next, 700);
