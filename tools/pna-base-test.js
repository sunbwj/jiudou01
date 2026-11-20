/* ==========================================================================
   pna-base-test.js —— js/api.js 接口地址选择回归测试
   --------------------------------------------------------------------------
   背景：页面从公网域名（如 http://boss.szyc-data.com:8808）打开时，若 api.js 把
   接口地址改成 http://127.0.0.1:8808/api，浏览器会按「私有网络访问（PNA）」规则拒绝：
     Access to XMLHttpRequest at 'http://127.0.0.1:8808/api/...' from origin
     'http://boss.szyc-data.com:8808' has been blocked by CORS policy:
     The request client is not a secure context and the resource is in
     more-private address space `loopback`.
   规则：只有页面本身在本机（localhost / 127.x / ::1 / file://）时才允许连 127.0.0.1。

   运行： NODE_PATH=C:/Users/chx/.workbuddy/binaries/node/workspace/node_modules \
          node tools/pna-base-test.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const JQ = fs.readFileSync(path.join(ROOT, 'vendor/jquery-3.7.1.min.js'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8');

/* 每条用例：在指定页面地址下加载 jQuery + api.js，ajax 一律失败（模拟"同源没有后端"） */
function boot(pageUrl) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: pageUrl,
        runScripts: 'dangerously',
        pretendToBeVisual: true
    });
    const w = dom.window;
    w.eval(JQ);
    w.__calls = [];
    // 所有 ajax 都失败：done/.fail 都有的 Deferred 形态，和 jQuery 的 jqXHR 一致
    w.eval(`jQuery.ajax = function (o) {
        window.__calls.push(o.url);
        var d = jQuery.Deferred();
        setTimeout(function () { d.reject({ status: 404, responseJSON: null }, 'error'); }, 0);
        return d.promise();
    };`);
    w.eval(API);
    return w;
}

const cases = [];
function check(name, fn) { cases.push({ name: name, fn: fn }); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

check('公网域名页面：不连 127.0.0.1，保持同源 api', async function () {
    const w = boot('http://boss.szyc-data.com:8808/main.html');
    await wait(300);
    const cfg = w.Api.config;
    const hitsLocal = w.__calls.filter(function (u) { return /127\.0\.0\.1|localhost/.test(u); });
    const problems = [];
    if (cfg.baseUrl !== 'api') { problems.push('baseUrl=' + cfg.baseUrl + '，应为 api'); }
    if (cfg.useMock) { problems.push('落到了本地模拟数据（useMock=true）'); }
    if (hitsLocal.length) { problems.push('请求打到本机：' + hitsLocal.join(', ')); }
    return problems;
});

check('公网域名页面：单次 GET 失败后仍用同源地址', async function () {
    const w = boot('http://www.example.com/main.html');
    await wait(300);
    w.__calls.length = 0;
    let err = null;
    await w.Api.notify.summary().then(function () { }, function (e) { err = e; });
    await wait(100);
    const problems = [];
    const hitsLocal = w.__calls.filter(function (u) { return /127\.0\.0\.1|localhost/.test(u); });
    if (hitsLocal.length) { problems.push('失败重试跳到了本机：' + hitsLocal.join(', ')); }
    if (!err) { problems.push('预期该请求失败（stub 全部失败），但没有 reject'); }
    if (w.Api.config.baseUrl !== 'api') { problems.push('baseUrl 被改成 ' + w.Api.config.baseUrl); }
    return problems;
});

check('本机 5500 静态服务：仍可探测并直连 127.0.0.1:8808', async function () {
    const w = boot('http://localhost:5500/main.html');
    await wait(300);
    const problems = [];
    const probedLocal = w.__calls.some(function (u) { return /^http:\/\/127\.0\.0\.1:8808\/api\/health/.test(u); });
    if (!probedLocal) { problems.push('没有探测 127.0.0.1:8808（本机页面应保留这条演示通路）：' + w.__calls.join(', ')); }
    return problems;
});

check('file:// 打开：baseUrl 用绝对地址', async function () {
    const w = boot('file:///E:/workbuddy-workspace/menu-admin/main.html');
    await wait(200);
    const problems = [];
    if (w.Api.config.baseUrl !== 'http://127.0.0.1:8808/api') {
        problems.push('baseUrl=' + w.Api.config.baseUrl);
    }
    return problems;
});

(async function () {
    let failed = 0;
    for (const c of cases) {
        let problems;
        try { problems = await c.fn(); } catch (err) { problems = ['抛异常：' + err.message]; }
        if (problems.length) { failed++; console.log('FAIL  ' + c.name + '\n      - ' + problems.join('\n      - ')); }
        else { console.log('ok    ' + c.name); }
    }
    console.log('\n' + (cases.length - failed) + '/' + cases.length + ' 通过');
    process.exit(failed ? 1 : 0);
})();
