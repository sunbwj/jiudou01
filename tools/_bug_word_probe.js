/* 临时探针：登记弹窗「导入 Word 到描述」是否生效 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const TK = process.env.BUG_TOKEN || '';
const vc = new VirtualConsole();
const errs = [];
vc.on('jsdomError', (e) => errs.push('jsdomError: ' + (e && e.message)));
vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ').slice(0, 200)));

const buf = fs.readFileSync(__dirname + '/_probe_word.docx');
const keep = setInterval(function () {}, 1000);   // 保活：等 jsdom 加载完

JSDOM.fromURL('http://127.0.0.1:8808/bug.html', {
    resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
        win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
            token: TK, user: { empId: 1, empName: '别文进', account: '13813970452' }
        }));
    }
}).then((dom) => {
    const win = dom.window, d = win.document;
    const t0 = Date.now();
    const tick = setInterval(() => {
        if (Date.now() - t0 > 20000) {
            clearInterval(tick);
            console.log(JSON.stringify({ timeout: true, errs: errs.slice(0, 4) }, null, 1));
            clearInterval(keep);
            process.exit(1);
        }
        if (!d.querySelector('#bugTbody tr')) { return; }
        if (!d.getElementById('bfWordFile')) {
            clearInterval(tick);
            d.getElementById('bugBtnAdd').click();
            return;
        }
        clearInterval(tick);
        const input = d.getElementById('bfWordFile');
        const file = new win.File([new win.Uint8Array(buf)], '_probe_word.docx',
            { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new win.Event('change', { bubbles: true }));
        let n = 0;
        const wait = setInterval(() => {
            n++;
            const msg = (d.querySelector('.el-message') || {}).textContent || '';
            const text = d.getElementById('bfDesc') ? d.getElementById('bfDesc').textContent : '';
            const ok = text.indexOf('Word导入测试段落') >= 0;
            if (ok || /失败|错误|不支持|没有可导入/.test(msg) || n > 40) {
                clearInterval(wait);
                console.log(JSON.stringify({
                    imported: ok,
                    descText: text.slice(0, 120),
                    message: msg.slice(0, 100),
                    hasWordImport: !!win.WordImport,
                    errs: errs.slice(0, 4)
                }, null, 1));
                clearInterval(keep);
                process.exit(0);
            }
        }, 200);
    }, 200);
}).catch((e) => {
    console.log(JSON.stringify({ fatal: String((e && e.message) || e) }, null, 1));
    process.exit(1);
});
