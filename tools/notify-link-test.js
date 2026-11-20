/* ==========================================================================
   notify-link-test.js —— 通知链接「不再写死 127.0.0.1」（jsdom）
   --------------------------------------------------------------------------
   背景：部署到服务器后，即时对话与通知邮件里推送的链接还是
         http://127.0.0.1:8808/xxx.html（老实现用 SERVER_HOST 拼），
         收件人点开等于访问自己的电脑。

   本测试覆盖两层：
     1. 前端渲染兜底：RichText.sanitize 会把历史内容里的「本机地址」类 href/src
        改成相对路径（/xxx.html），浏览器按当前站点解析 → 换 IP/域名/端口都正确；
        file:// 直接打开页面时没有站点可挂靠，保持原样。
     2. 资源版本一致：js/rich-text.js 在 5 个引用页面只能同一个 ?v=。
   （后端链路见 server/test_notify_link.py：站内消息用相对路径、邮件用绝对地址）

   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/notify-link-test.js
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
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

var rtSrc = read('js/rich-text.js');

/** 在指定 URL 的 window 里装载 rich-text.js（它只在 mount 时才用 jQuery） */
function makeWindow(url) {
    var dom = new JSDOM('<!doctype html><html><body></body></html>',
        { url: url, runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.eval(rtSrc);
    return dom.window;
}

function main() {
    var w = makeWindow('http://192.168.1.20:8808/main.html');
    var RT = w.RichText;

    console.log('\n--- 1. localizeUrl：本机地址 → 相对路径 ---');
    check('组件导出 localizeUrl', !!RT && typeof RT.localizeUrl === 'function');
    check('127.0.0.1 带端口',
        RT.localizeUrl('http://127.0.0.1:8808/workplan-design.html?id=P1')
        === '/workplan-design.html?id=P1',
        RT.localizeUrl('http://127.0.0.1:8808/workplan-design.html?id=P1'));
    check('localhost 任意端口',
        RT.localizeUrl('http://localhost:9000/project-detail.html?id=2')
        === '/project-detail.html?id=2');
    check('0.0.0.0',
        RT.localizeUrl('http://0.0.0.0:8080/a.html') === '/a.html');
    check('IPv6 ::1',
        RT.localizeUrl('http://[::1]:8808/requirement.html?id=3') === '/requirement.html?id=3');
    check('https + 本机',
        RT.localizeUrl('https://127.0.0.1/a.html') === '/a.html');
    check('只有主机没有路径 → /',
        RT.localizeUrl('http://127.0.0.1:8808') === '/');

    console.log('\n--- 2. 不该动的一律不动 ---');
    check('正常域名不变',
        RT.localizeUrl('https://jiudou.example.com/a.html') === 'https://jiudou.example.com/a.html');
    check('相对路径不变', RT.localizeUrl('/a.html') === '/a.html');
    check('mailto 不变', RT.localizeUrl('mailto:a@b.com') === 'mailto:a@b.com');
    check('空值安全', RT.localizeUrl('') === '' && RT.localizeUrl(null) === '');
    // 主机名里含 127.0.0.1 但不是本机地址（如 127.0.0.1.example.com）也不能误伤
    check('相似主机名不误伤',
        RT.localizeUrl('http://127.0.0.1.example.com/a.html') === 'http://127.0.0.1.example.com/a.html');

    console.log('\n--- 3. sanitize 渲染历史消息：链接/图片就地改成相对路径 ---');
    var out = RT.sanitize('<p>查看计划：<a href="http://127.0.0.1:8808/workplan-design.html?id=P1">'
        + '打开计划</a></p>');
    check('a[href] 改成相对路径',
        out.indexOf('href="/workplan-design.html?id=P1"') > -1, out);
    check('a 保留 target / rel',
        out.indexOf('target="_blank"') > -1 && out.indexOf('rel="noopener noreferrer"') > -1, out);
    check('渲染结果里没有 127.0.0.1', out.indexOf('127.0.0.1') < 0, out);

    var img = RT.sanitize('<img src="http://localhost:8808/data/x.png">');
    check('img[src] 也改成本站相对路径', img.indexOf('src="/data/x.png"') > -1, img);

    console.log('\n--- 4. 安全清洗没被破坏（回归）---');
    var bad = RT.sanitize('<a href="javascript:alert(1)" onclick="x()">x</a>'
        + '<script>alert(1)</script><iframe src="http://127.0.0.1/x"></iframe>');
    check('javascript: 仍被清掉', bad.indexOf('javascript:') < 0, bad);
    check('on* 事件仍被清掉', bad.indexOf('onclick') < 0, bad);
    check('script / iframe 仍被删除', bad.indexOf('<script') < 0 && bad.indexOf('<iframe') < 0, bad);

    console.log('\n--- 5. file:// 直接打开页面：不改（没有站点可挂靠）---');
    var fw = makeWindow('file:///E:/workbuddy-workspace/menu-admin/main.html');
    check('file:// 下 localizeUrl 原样返回',
        fw.RichText.localizeUrl('http://127.0.0.1:8808/a.html') === 'http://127.0.0.1:8808/a.html',
        fw.RichText.localizeUrl('http://127.0.0.1:8808/a.html'));

    console.log('\n--- 6. 资源版本一致 + 渲染入口都过 sanitize ---');
    var pages = ['mail.html', 'emp-mail.html', 'message.html', 'main.html', 'requirement.html'];
    var vers = pages.map(function (p) {
        var m = read(p).match(/rich-text\.js\?v=([0-9a-z]+)/);
        return m ? m[1] : '';
    });
    check('5 个页面都引用 rich-text.js', vers.every(function (v) { return !!v; }), vers.join(','));
    check('版本号全站一致', vers.every(function (v) { return v === vers[0]; }), vers.join(','));
    check('version 是本次改动后的值', vers[0] === '20261116a', vers[0]);

    ['js/message.js', 'js/mail.js', 'js/emp-mail.js'].forEach(function (f) {
        check(f + ' 渲染前过 RichText.sanitize',
            read(f).indexOf('RichText.sanitize(') > -1);
    });

    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}

main();
