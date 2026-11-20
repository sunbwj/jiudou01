/* 临时探针：登记弹窗「点保存」是否真的发出请求（含附件） */
const { JSDOM, VirtualConsole } = require('jsdom');

const TK = process.env.BUG_TOKEN || '';
const vc = new VirtualConsole();
const errs = [];
vc.on('jsdomError', (e) => errs.push('jsdomError: ' + (e && e.message)));
vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ').slice(0, 200)));

JSDOM.fromURL('http://127.0.0.1:8808/bug.html', {
    resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
        win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
            token: TK, user: { empId: 1, empName: '别文进', account: '13813970452' }
        }));
    }
}).then((dom) => {
    const win = dom.window, d = win.document;
    let phase = 'wait-list';
    const t0 = Date.now();
    const tick = setInterval(() => {
        if (Date.now() - t0 > 15000) {
            clearInterval(tick);
            console.log(JSON.stringify({ timeout: true, phase, errs: errs.slice(0, 4) }, null, 1));
            process.exit(1);
        }
        if (phase === 'wait-list') {
            if (!d.querySelector('#bugTbody tr')) { return; }
            phase = 'open-form';
            d.getElementById('bugBtnAdd').click();
            setTimeout(() => {
                const title = d.querySelector('#bfTitle');
                if (!title) {
                    console.log(JSON.stringify({ formOpened: false, errs: errs.slice(0, 4) }, null, 1));
                    process.exit(1);
                }
                // 填写必填项（接收人直接写隐藏域，绕过人员选择弹窗）
                function setVal(el, v) {
                    el.value = v;
                    el.dispatchEvent(new win.Event('change', { bubbles: true }));
                }
                setVal(d.getElementById('bfTitle'), '[探针] 保存按钮验证');
                const sel = d.getElementById('bfProject');
                setVal(sel, (sel.options[1] || {}).value || '');
                setVal(d.getElementById('bfHappen'), '2026-11-18T15:45');
                setVal(d.getElementById('bfReceiver'), '1');
                const pb = d.querySelector('.bug-person');
                pb.setAttribute('data-id', '1');
                pb.setAttribute('data-name', '别文进');
                if (win.RichText) {
                    const rt = win.RichText.of('#bfDesc');
                    if (rt) { rt.setHtml('<p>探针：保存应发出请求并关闭弹窗。</p>'); }
                }
                // 附件：构造 File 塞进 input
                const file = new win.File([new win.Uint8Array([104, 105, 32, 98, 117, 103])],
                    'probe.txt', { type: 'text/plain' });
                const input = d.getElementById('bfFiles');
                Object.defineProperty(input, 'files', { value: [file], configurable: true });
                input.dispatchEvent(new win.Event('change', { bubbles: true }));
                const chips = d.querySelectorAll('.bug-file-chip').length;
                phase = 'submit';
                d.querySelector('.el-dialog .btn-ok').click();
                let n = 0;
                const wait = setInterval(() => {
                    n++;
                    const dlg = d.querySelector('.el-dialog');
                    const msg = (d.querySelector('.el-message') || {}).textContent || '';
                    const rows = Array.from(d.querySelectorAll('#bugTbody tr[data-id]')).map((tr) => tr.textContent);
                    const hit = rows.some((t) => t.indexOf('[探针] 保存按钮验证') >= 0);
                    if (!dlg || hit || /失败|错误|请/.test(msg) || n > 30) {
                        clearInterval(wait);
                        console.log(JSON.stringify({
                            chips: chips,
                            dialogClosed: !dlg,
                            message: msg.slice(0, 80),
                            rowAdded: hit,
                            rows: rows.length,
                            errs: errs.slice(0, 4)
                        }, null, 1));
                        process.exit(0);
                    }
                }, 200);
            }, 700);
        }
    }, 150);
});
