/*
 * 打印页「分页版式」探针：用真实设计器生成打印页 → Edge 打印成 PDF
 * ------------------------------------------------------------------------
 * 为什么要它：页眉是否压住第 2 页的表头，只有真正分页渲染才看得出来，
 * jsdom 里没有分页概念。此脚本输出 `_tmp_print_check.pdf`，
 * 由 tools/report-print-test.py 用 pdfminer 量每页文字坐标做断言。
 *
 * 用法：node tools/report-print-probe.js [账号] [密码]
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8808';
const ROOT = path.resolve(__dirname, '..');
const ACCOUNT = process.argv[2] || '15724887807';
const PASSWORD = process.argv[3] || '888888';
const ROWS = 90;

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,1000']
    });
    const page = await browser.newPage();
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });

    const token = await page.evaluate(async function (account, password) {
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
                captchaId: (cap.data || {}).captchaId,
                captchaCode: solve((cap.data || {}).question)
            })
        });
        return ((await res.json()).data || {}).token || '';
    }, ACCOUNT, PASSWORD);
    if (!token) {
        console.error('登录失败（账号 ' + ACCOUNT + '）');
        await browser.close();
        process.exit(1);
    }

    await page.evaluate(function (tk) {
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        var fmt = function (ms) {
            var d = new Date(ms);
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
                pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        };
        var now = new Date().getTime();
        localStorage.setItem('menu_admin_login_v1', JSON.stringify({
            token: tk, time: fmt(now), expireTime: fmt(now + 8 * 3600 * 1000),
            expireAt: now + 8 * 3600 * 1000, ttlHours: 8,
            user: { account: 'print-probe', empName: '打印探针' }
        }));
    }, token);

    await page.goto(BASE + '/report-designer.html', { waitUntil: 'networkidle2' });
    await new Promise(function (r) { setTimeout(r, 1200); });

    const html = await page.evaluate(function (rowCount) {
        if (!window.RptDesigner) { return ''; }
        var rows = [], i;
        for (i = 1; i <= rowCount; i++) {
            rows.push(['E' + ('000' + i).slice(-4), '姓名' + i, '科室' + (i % 7)]);
        }
        var mapped = [
            { field: 'code', label: '工号', index: 0, width: 120, align: 'left', headerAlign: 'center', visible: true },
            { field: 'name', label: '姓名', index: 1, width: 120, align: 'center', headerAlign: 'center', visible: true },
            { field: 'dept', label: '科室', index: 2, width: 160, align: 'left', headerAlign: 'center', visible: true }
        ];
        return window.RptDesigner.buildPrintHtml({
            rows: rows, mapped: mapped,
            report: { reportName: '打印分页自测' },
            design: { title: '打印分页自测', subtitle: '第 2 页起页眉不能与表头重合', zebra: true,
                      bordered: true, showTitle: true, showParams: true,
                      headerText: '页眉文字 PAGEHEAD', headerAlign: 'left',
                      footerText: '页脚 FOOTER', footerAlign: 'center', elements: [] },
            template: { paper: 'A4', orientation: 'portrait', marginTop: 12, marginBottom: 12,
                        marginLeft: 10, marginRight: 10, fontSize: 12, showPageNo: true,
                        showTime: true, headerLogo: '', footerLogo: '', headerLogoHeight: 32 }
        });
    }, ROWS);
    if (!html) {
        console.error('没拿到打印页 HTML（RptDesigner 未就绪？）');
        await browser.close();
        process.exit(1);
    }
    fs.writeFileSync(path.join(ROOT, '_tmp_print_check.html'), html, 'utf-8');

    const sheet = await browser.newPage();
    await sheet.goto('file:///' + path.join(ROOT, '_tmp_print_check.html'), { waitUntil: 'load' });
    await new Promise(function (r) { setTimeout(r, 300); });
    const pdf = await sheet.pdf({ printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(path.join(ROOT, '_tmp_print_check.pdf'), pdf);
    console.log('pdf bytes ' + pdf.length + '  rows ' + ROWS);
    await browser.close();
})();
