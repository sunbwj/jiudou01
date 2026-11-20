/* 缺陷管理：已转工单的按钮拦截提示 + 关闭原因录入区高度（jsdom + 真实后端）
   选中一条「已转工单」的缺陷 → 依次点评估 / 生成工单 / 编辑 → 应弹出说明原因的提示；
   再打开「关闭」弹窗 → 校验原因输入框为加高样式。 */
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
    const d = win.document;
    const out = { msgs: [] };
    for (let i = 0; i < 30; i++) {
        await sleep(300);
        if (d.querySelectorAll('#bugTbody tr[data-id]').length) { break; }
    }
    const rows = Array.from(d.querySelectorAll('#bugTbody tr[data-id]'));
    out.rows = rows.length;
    if (!rows.length) { console.log(JSON.stringify({ out, errs }, null, 1)); process.exit(0); }

    // 优先挑「已转工单」那行（探针前置数据里有一条）
    const WANT = process.env.ROW_STATUS || '已转工单';
    const target = rows.find((tr) => (tr.textContent || '').indexOf(WANT) >= 0) || rows[0];
    out.rowText = (target.textContent || '').replace(/\s+/g, ' ').slice(0, 80);
    target.querySelector('input[name=bugPick]').click();
    await sleep(200);

    const btnState = (id) => {
        const b = d.getElementById(id);
        return {
            disabled: !!b.disabled,
            fakeDisabled: b.classList.contains('is-disabled'),
            blocked: b.getAttribute('data-blocked') || '',
            title: b.getAttribute('title') || ''
        };
    };
    out.buttons = {
        evaluate: btnState('bugBtnEvaluate'),
        confirm: btnState('bugBtnConfirm'),
        edit: btnState('bugBtnEdit')
    };

    function lastMsg() {
        const boxes = d.querySelectorAll('.el-message__content');
        return boxes.length ? (boxes[boxes.length - 1].textContent || '') : '';
    }
    for (const id of ['bugBtnEvaluate', 'bugBtnConfirm', 'bugBtnEdit']) {
        const before = d.querySelectorAll('.el-message').length;
        d.getElementById(id).click();
        await sleep(250);
        const after = d.querySelectorAll('.el-message').length;
        out.msgs.push({ btn: id, popped: after > before, text: lastMsg().slice(0, 120) });
    }
    out.dialogOpened = !!d.querySelector('.el-dialog');

    // 关闭弹窗：原因录入区
    d.getElementById('bugBtnClose').click();
    await sleep(400);
    const cdlg = Array.from(d.querySelectorAll('.el-dialog')).pop();
    const ta = cdlg ? cdlg.querySelector('#bcReason') : null;
    out.closeDialog = {
        opened: !!ta,
        rows: ta ? ta.getAttribute('rows') : '',
        className: ta ? ta.className : '',
        hasClass: ta ? ta.classList.contains('bug-close-reason') : false
    };
    const cs = ta ? win.getComputedStyle(ta) : null;
    out.closeDialog.minHeight = cs ? cs.minHeight : '';
    out.errs = errs.slice(0, 4);
    console.log(JSON.stringify(out, null, 1));
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e && e.message) })); process.exit(1); });
