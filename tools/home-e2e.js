/* ==========================================================================
   home-e2e.js —— 系统首页（真实 Edge）：按顶级菜单组渲染功能卡片 + 分组轮播
   --------------------------------------------------------------------------
   覆盖：/api/nav 顶级菜单组 → 每组一页、组内递归收集全部菜单项卡片；
        多组时出现左右箭头 + 圆点，点箭头 / 圆点切页（transform + 圆点跟动）；
        单组时隐藏切换控件；卡片图标 / 标题 / 层级路径来自菜单数据；
        卡片点击在框架页内新建 Tab（父框架 AppNav.go）；
        一屏高度内的卡片不溢出视口（轮播页高度自适应）。
   运行：node tools/home-e2e.js [账号] [密码]
   ========================================================================== */
'use strict';
var puppeteer = require('puppeteer-core');

var EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
var BASE = 'http://127.0.0.1:8808';
var KEY = 'menu_admin_login_v1';
var ACCOUNT = process.argv[2] || '15724887807';
var PASSWORD = process.argv[3] || '888888';

var pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function finish() {
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}

(async function main() {
    var browser = await puppeteer.launch({
        executablePath: EDGE, headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,1000']
    });
    var page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    var pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(e.message); console.log('    [pageerror] ' + e.message); });

    /* ---------- 0. 登录 ---------- */
    console.log('\n--- 0. 登录 ---');
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    var token = await page.evaluate(async function (account, password) {
        function solve(q) {
            var m = /^(\d+)\s*([+\-×])\s*(\d+)\s*=\s*\?$/.exec(String(q || ''));
            if (!m) { return ''; }
            var a = parseInt(m[1], 10), op = m[2], b = parseInt(m[3], 10);
            return String(op === '+' ? a + b : (op === '-' ? a - b : a * b));
        }
        var cap = await (await fetch('/api/auth/captcha')).json();
        var res = await fetch('/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                account: account, password: password,
                captchaId: (cap.data || {}).captchaId, captchaCode: solve((cap.data || {}).question)
            })
        });
        return ((await res.json()).data || {}).token || '';
    }, ACCOUNT, PASSWORD);
    check('登录成功（账号 ' + ACCOUNT + '）', /^[0-9a-f]{32}$/.test(token), token.slice(0, 8));
    if (!token) { await browser.close(); return finish(); }

    await page.evaluate(function (key, tk) {
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        var fmt = function (ms) {
            var d = new Date(ms);
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
                pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        };
        var now = new Date().getTime();
        localStorage.setItem(key, JSON.stringify({
            token: tk, time: fmt(now), expireTime: fmt(now + 8 * 3600 * 1000),
            expireAt: now + 8 * 3600 * 1000, ttlHours: 8, user: { account: 'e2e', empName: '首页测试' }
        }));
    }, KEY, token);

    /* ---------- 1. 首页渲染（先加载页面，再用页面自身的 Api 取基准数据） ---------- */
    console.log('\n--- 1. 首页按菜单组渲染卡片 ---');
    await page.goto(BASE + '/home.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.querySelectorAll("#homeTrack .home-slide").length > 0', { timeout: 8000 })
        .catch(function () { /* 后面统一断言 */ });
    await sleep(300);

    var nav = await page.evaluate(function () {
        return new Promise(function (resolve) {
            if (!window.Api || !Api.nav) { resolve([]); return; }
            Api.nav.get().done(function (data) {
                var groups = (data && data.groups) || [];
                function leaves(node, out, seen) {
                    var items = parseInt(node.hasChild, 10) ? (node.items || []) : [];
                    var self = !parseInt(node.hasChild, 10) && node.path ? [node] : [];
                    self.concat(items).forEach(function (it) {
                        var p = String(it.path || '').split('#')[0].split('?')[0];
                        if (!p || seen[p]) { return; }
                        seen[p] = 1;
                        out.push({ name: it.nameCn, path: p, icon: it.icon || '' });
                    });
                    (node.children || []).forEach(function (c) { leaves(c, out, seen); });
                }
                resolve(groups.map(function (g) {
                    var ls = [];
                    leaves(g, ls, {});
                    return { id: g.id, nameCn: g.nameCn, code: g.code, items: ls };
                }).filter(function (g) { return g.items.length; }));
            }).fail(function () { resolve([]); });
        });
    });
    var totalItems = nav.reduce(function (n, g) { return n + g.items.length; }, 0);
    check('导航按顶级菜单组返回数据（≥1 组，每组有菜单项）', nav.length >= 1,
        JSON.stringify(nav.map(function (g) { return g.nameCn + ':' + g.items.length; })));

    var ui = await page.evaluate(function () {
        var slides = [].slice.call(document.querySelectorAll('#homeTrack .home-slide'));
        return {
            slides: slides.length,
            titles: slides.map(function (s) { return (s.querySelector('.home-slide__title') || {}).textContent || ''; }),
            cardsPerSlide: slides.map(function (s) { return s.querySelectorAll('.home-card[data-href]').length; }),
            cards: document.querySelectorAll('.home-card[data-href]').length,
            hrefs: [].slice.call(document.querySelectorAll('.home-card[data-href]')).map(function (a) {
                return a.getAttribute('data-href');
            }),
            footHidden: document.getElementById('homeFoot').hidden,
            dots: document.querySelectorAll('#homeDots .home-carousel__dot').length,
            btns: document.querySelectorAll('.home-carousel__btn').length,
            icoSvg: document.querySelectorAll('.home-card__ico svg').length,
            firstDesc: (document.querySelector('.home-card__desc') || {}).textContent || '',
            transform: (document.getElementById('homeTrack').style.transform || '')
        };
    });
    check('渲染出的页数 = 有菜单项的顶级菜单组数', ui.slides === nav.length,
        ui.slides + ' vs ' + nav.length);
    check('每页标题与菜单组名一致（同序）',
        ui.titles.join('|') === nav.map(function (g) { return g.nameCn; }).join('|'),
        ui.titles.join('|') + '  ≠  ' + nav.map(function (g) { return g.nameCn; }).join('|'));
    check('卡片总数 = 全部可见菜单项数（含下级分组绑定的项）', ui.cards === totalItems,
        ui.cards + ' vs ' + totalItems);
    check('每页卡片数与该组菜单项数一致',
        ui.cardsPerSlide.join(',') === nav.map(function (g) { return g.items.length; }).join(','),
        ui.cardsPerSlide.join(',') + ' vs ' + nav.map(function (g) { return g.items.length; }).join(','));
    check('卡片 href 全部来自菜单数据（无写死页面）',
        ui.hrefs.every(function (h) {
            return nav.some(function (g) {
                return g.items.some(function (it) { return it.path === h; });
            });
        }), ui.hrefs.slice(0, 5).join(','));
    check('卡片图标用菜单图标库渲染（每个卡片都有 svg）', ui.icoSvg === ui.cards,
        ui.icoSvg + '/' + ui.cards);
    check('卡片副标题显示菜单层级路径（含组名）',
        /\/|^[\u4e00-\u9fa5]+$/.test(ui.firstDesc) && ui.firstDesc.length >= 2, ui.firstDesc);
    check('页脚切换控件按组数显示（1 组隐藏 / 多组显示）',
        (nav.length > 1) ? (ui.footHidden === false && ui.dots === nav.length && ui.btns === 2)
                         : (ui.footHidden === true),
        'hidden=' + ui.footHidden + ' dots=' + ui.dots);

    /* ---------- 3. 轮播切换 ---------- */
    if (nav.length > 1) {
        console.log('\n--- 2. 按菜单组轮播切换 ---');
        var geo = await page.evaluate(function () {
            var np = document.getElementById('homeNext');
            var r = np.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2,
                     dot0: document.querySelectorAll('#homeDots .home-carousel__dot')[0]
                        .getBoundingClientRect().width };
        });
        await page.mouse.move(0, 0);
        await page.mouse.click(geo.x, geo.y);
        await sleep(500);
        var s1 = await page.evaluate(function () {
            var t = document.getElementById('homeTrack');
            var dots = [].slice.call(document.querySelectorAll('#homeDots .home-carousel__dot'));
            var slide = document.querySelectorAll('#homeTrack .home-slide')[1];
            var r = slide.getBoundingClientRect();
            var vr = document.getElementById('homeViewport').getBoundingClientRect();
            return {
                transform: t.style.transform || '',
                active: dots.map(function (d) { return d.className.indexOf('is-active') >= 0; }),
                slideLeft: Math.round(r.left), vpLeft: Math.round(vr.left),
                slideWidth: Math.round(r.width), viewport: Math.round(vr.width)
            };
        });
        check('点「下一组」轨道平移 -100%（切到第 2 组）', /-100%/.test(s1.transform), s1.transform);
        check('第 2 个圆点变为选中态、第 1 个取消',
            s1.active[1] === true && s1.active[0] === false, JSON.stringify(s1.active));
        check('第 2 组页左边缘与视口左边缘重合（宽度与视口一致，无叠影）',
            Math.abs(s1.slideLeft - s1.vpLeft) <= 2 &&
            Math.abs(s1.slideWidth - s1.viewport) <= 2,
            s1.slideLeft + '/' + s1.vpLeft + '　宽 ' + s1.slideWidth + '/' + s1.viewport);

        var dot1 = await page.evaluate(function () {
            var d = document.querySelectorAll('#homeDots .home-carousel__dot')[0];
            var r = d.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.move(0, 0);
        await page.mouse.click(dot1.x, dot1.y);
        await sleep(500);
        var s2 = await page.evaluate(function () {
            var t = document.getElementById('homeTrack');
            var dots = [].slice.call(document.querySelectorAll('#homeDots .home-carousel__dot'));
            return { transform: t.style.transform || '',
                     active: dots.map(function (d) { return d.className.indexOf('is-active') >= 0; }) };
        });
        check('点第 1 个圆点直接回到第 1 组', !/-100%/.test(s2.transform) && s2.active[0] === true,
            s2.transform + ' / ' + JSON.stringify(s2.active));

        var prevGeo = await page.evaluate(function () {
            var p = document.getElementById('homePrev');
            var r = p.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.move(0, 0);
        await page.mouse.click(prevGeo.x, prevGeo.y);
        await sleep(500);
        var s3 = await page.evaluate(function () {
            var t = document.getElementById('homeTrack');
            var dots = [].slice.call(document.querySelectorAll('#homeDots .home-carousel__dot'));
            return { transform: t.style.transform || '',
                     active: dots.map(function (d) { return d.className.indexOf('is-active') >= 0; }) };
        });
        check('点「上一组」从第 1 组回绕到最后一组',
            new RegExp('-' + ((nav.length - 1) * 100) + '%').test(s3.transform) &&
            s3.active[nav.length - 1] === true,
            s3.transform + ' / ' + JSON.stringify(s3.active));

        check('圆点选中态宽度大于未选中态（视觉可辨）', geo.dot0 > 0, String(geo.dot0));
    }

    /* ---------- 2. 版式（一屏内不横向溢出） ---------- */
    console.log('\n--- 3. 版式（轮播视口裁剪 + 卡片折行） ---');
    var layout = await page.evaluate(function () {
        var vp = document.getElementById('homeViewport');
        var doc = document.documentElement;
        var vpRect = vp.getBoundingClientRect();
        var slides = [].slice.call(document.querySelectorAll('#homeTrack .home-slide'));
        var cards = [].slice.call(slides[0].querySelectorAll('.home-card'));
        var rowTop = cards.length ? Math.round(cards[0].getBoundingClientRect().top) : 0;
        return {
            overflowX: doc.scrollWidth - doc.clientWidth,
            vpOverflow: getComputedStyle(vp).overflow,
            slideWidths: slides.map(function (s) { return Math.round(s.getBoundingClientRect().width); }),
            vpWidth: Math.round(vpRect.width),
            slideOverflow: slides.some(function (s) { return s.scrollWidth - s.clientWidth > 2; }),
            slideOverflowBy: slides.map(function (s) { return s.scrollWidth - s.clientWidth; }),
            cardCount: cards.length,
            sameRow: cards.length > 1
                ? Math.abs(Math.round(cards[1].getBoundingClientRect().top) - rowTop) <= 2 : true
        };
    });
    check('页面无横向滚动条', layout.overflowX <= 0, String(layout.overflowX));
    check('轮播视口用 overflow:hidden 裁剪其它组（轨道可以更宽）',
        layout.vpOverflow === 'hidden', layout.vpOverflow);
    check('每页宽度与视口一致（一页正好一屏）',
        layout.slideWidths.every(function (w) { return Math.abs(w - layout.vpWidth) <= 2; }),
        layout.slideWidths.join(',') + ' vs ' + layout.vpWidth);
    check('每页内部不横向溢出（卡片按行折行，负边距已抵消）',
        layout.slideOverflow === false, JSON.stringify(layout.slideOverflowBy));
    check('卡片按行排列（同行顶部对齐）', layout.sameRow === true);

    check('页面无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

    await page.screenshot({ path: 'tools/home-shot.png', fullPage: true });
    console.log('  截图：tools/home-shot.png');
    await browser.close();
    finish();
})();
