/* 通用 CDP 截图工具：等探针页写出 <html data-done="1">，再用 CDP 抓真实截图。
   为什么不直接 --screenshot：--virtual-time-budget 下页面里的 fetch / FileReader 是真实
   I/O，虚拟时钟会在它们完成前耗尽 → 截出空白图。走 CDP 按真实时间轮询就稳。

   用法：
     node tools/_cdp_shot.js <url> <out.png> [宽] [高] [超时毫秒]
*/
'use strict';
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2];
const out = process.argv[3];
const W = parseInt(process.argv[4] || '1400', 10);
const H = parseInt(process.argv[5] || '1000', 10);
const TIMEOUT = parseInt(process.argv[6] || '90000', 10);
const PORT = 9333 + (process.pid % 200);
const PROFILE = 'C:/Users/chx/.workbuddy/tmp/_cdp_profile_' + process.pid;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpJson(path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path }, res => {
            let b = '';
            res.on('data', d => { b += d; });
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

async function main() {
    const child = execFile(EDGE, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars',
        '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
        '--window-size=' + W + ',' + H, '--no-first-run', '--no-default-browser-check',
        url
    ], () => { });
    child.on('error', e => { console.error('launch failed:', e.message); });

    let target = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
        try {
            const list = await httpJson('/json/list');
            target = (list || []).filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0];
            if (target) { break; }
        } catch (e) { /* 还没起来 */ }
        await sleep(300);
    }
    if (!target) { throw new Error('CDP 目标没起来'); }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let seq = 0;
    const waiting = new Map();
    ws.addEventListener('message', ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && waiting.has(msg.id)) {
            const { res, rej } = waiting.get(msg.id);
            waiting.delete(msg.id);
            msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        }
    });
    await new Promise((res, rej) => {
        ws.addEventListener('open', res);
        ws.addEventListener('error', () => rej(new Error('WS 连接失败')));
    });
    const send = (method, params) => new Promise((res, rej) => {
        const id = ++seq;
        waiting.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

    const evalJs = async expr => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
        return r && r.result ? r.result.value : undefined;
    };

    /* 等探针自己收工（data-done="1"），并把整段 data-* 抓回来 */
    const t1 = Date.now();
    let done = '';
    while (Date.now() - t1 < TIMEOUT) {
        try { done = await evalJs('document.documentElement.getAttribute("data-done") || ""'); } catch (e) { done = ''; }
        if (done === '1') { break; }
        await sleep(400);
    }
    const meta = await evalJs(
        'JSON.stringify(Object.assign({}, document.documentElement.dataset))');
    await sleep(500);           // 让弹窗动画 / 字体落位

    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('done=' + (done || '0'));
    console.log('meta=' + meta);
    console.log('shot=' + out + ' (' + fs.statSync(out).size + ' bytes)');

    ws.close();
    try { child.kill(); } catch (e) { }
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { }
}

main().then(() => process.exit(0)).catch(e => {
    console.error('ERR: ' + e.message);
    process.exit(1);
});
