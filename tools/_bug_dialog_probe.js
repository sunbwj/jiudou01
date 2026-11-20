/* 缺陷管理页弹窗探针（jsdom + 真实后端）：
   选中一行 → 打开详情（校验时间线 / 工单区）→ 关闭 → 打开「确认缺陷」（校验三组责任人）。 */
const { JSDOM, VirtualConsole } = require('jsdom');
const TK = process.env.BUG_TOKEN || '';
const vc = new VirtualConsole();
const errs = [];
vc.on('jsdomError', (e) => errs.push('jsdomError: ' + (e && e.message).slice(0, 160)));
vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ').slice(0, 160)));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
    const dom = await JSDOM.fromURL('http://127.0.0.1:8808/bug.html', {
        resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
        beforeParse(win) {
            win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
                token: TK, user: { empId: 1, empName: '别文进', account: '13813970452' }
            }));
        }
    });
    const win = dom.window;
    const $ = win.jQuery;
    const d = win.document;
    const out = {};
    for (let i = 0; i < 30; i++) {
        await sleep(300);
        if (d.querySelectorAll('#bugTbody tr[data-id]').length) { break; }
    }
    const rows = d.querySelectorAll('#bugTbody tr[data-id]');
    out.rows = rows.length;
    if (!rows.length) { console.log(JSON.stringify({ out, errs }, null, 1)); process.exit(0); }

    const radio = rows[0].querySelector('input[name=bugPick]');
    radio.click();
    await sleep(200);
    out.btnAfterPick = {
        detail: !d.getElementById('bugBtnDetail').disabled,
        evaluate: !d.getElementById('bugBtnEvaluate').disabled,
        confirm: !d.getElementById('bugBtnConfirm').disabled,
        edit: !d.getElementById('bugBtnEdit').disabled,
        close: !d.getElementById('bugBtnClose').disabled
    };

    d.getElementById('bugBtnDetail').click();
    for (let i = 0; i < 25; i++) {
        await sleep(250);
        if (d.querySelector('#bugDetailBox .bug-detail')) { break; }
    }
    const box = d.getElementById('bugDetailBox');
    out.detail = {
        opened: !!box && !!box.querySelector('.bug-detail'),
        timelineItems: box ? box.querySelectorAll('.bug-timeline .bug-tl-item').length : 0,
        hasReason: box ? /复现确认：金额重复累加/.test(box.textContent || '') : false,
        orderSection: box ? /修复工单/.test(box.textContent || '') : false,
        text: box ? (box.textContent || '').replace(/\s+/g, ' ').slice(0, 120) : ''
    };
    const dlg = d.querySelectorAll('.el-dialog');
    if (dlg.length) { dlg[dlg.length - 1].querySelector('.btn-cancel').click(); }
    await sleep(200);

    d.getElementById('bugBtnConfirm').click();
    await sleep(400);
    const cdlg = Array.from(d.querySelectorAll('.el-dialog')).pop();
    out.confirm = {
        opened: !!cdlg && /确认缺陷并生成修复工单/.test((cdlg.querySelector('.el-dialog__title') || {}).textContent || ''),
        teams: cdlg ? cdlg.querySelectorAll('.bug-team').length : 0,
        personFields: cdlg ? cdlg.querySelectorAll('.bug-person').length : 0,
        dateFields: cdlg ? cdlg.querySelectorAll('input[type=date]').length : 0,
        defaultAccept: cdlg ? ((cdlg.querySelectorAll('.bug-person')[2] || {}).textContent || '').trim() : ''
    };
    out.errs = errs.slice(0, 4);
    console.log(JSON.stringify(out, null, 1));
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e && e.message) })); process.exit(1); });
