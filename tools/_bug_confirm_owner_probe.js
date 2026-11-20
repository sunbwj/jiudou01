/* 缺陷确认弹窗：三组责任人是否各自独立（jsdom + 真实后端）
   选中一行 → 打开「确认缺陷」→ 依次给研发 / 测试 / 验收选三个不同的人
   → 校验三个按钮各自的 data-id 与 picker 标题 → 校验提交参数里三个 ID 互不相同。 */
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
    const out = {};
    for (let i = 0; i < 30; i++) {
        await sleep(300);
        if (d.querySelectorAll('#bugTbody tr[data-id]').length) { break; }
    }
    const rows = d.querySelectorAll('#bugTbody tr[data-id]');
    out.rows = rows.length;
    if (!rows.length) { console.log(JSON.stringify({ out, errs }, null, 1)); process.exit(0); }

    rows[0].querySelector('input[name=bugPick]').click();
    await sleep(200);
    d.getElementById('bugBtnConfirm').click();
    await sleep(500);
    const cdlg = Array.from(d.querySelectorAll('.el-dialog')).pop();
    if (!cdlg) { console.log(JSON.stringify({ out, errs, fatal: 'confirm dialog not opened' }, null, 1)); process.exit(0); }

    // 桩：记录每次打开选人弹窗的标题，并按调用顺序返回不同的人
    const titles = [];
    const picked = [{ id: 11, name: '研发甲' }, { id: 22, name: '测试乙' }, { id: 33, name: '验收丙' }];
    let seq = 0;
    win.WpEmpPicker = {
        open: function (opt) {
            titles.push(opt.title || '');
            const one = picked[seq++] || picked[0];
            if (opt.onOk) { opt.onOk([one]); }
        }
    };

    const btns = cdlg.querySelectorAll('.bug-team .bug-person');
    out.buttons = btns.length;
    for (let i = 0; i < btns.length; i++) {
        btns[i].click();
        await sleep(80);
    }
    await sleep(120);
    out.pickerTitles = titles;
    out.btnData = Array.from(cdlg.querySelectorAll('.bug-team')).map((team) => {
        const b = team.querySelector('.bug-person');
        return { id: b.getAttribute('data-id'), name: b.getAttribute('data-name'),
                 text: (b.textContent || '').trim() };
    });
    out.btnIdsDistinct = new Set(out.btnData.map((x) => x.id)).size === 3;

    // 桩：拦截 confirm 提交参数
    let payload = null;
    win.Api.bug.confirm = function (data) {
        payload = data;
        const dfd = win.jQuery.Deferred();
        dfd.resolve({ message: '桩：未真正提交' });
        return dfd.promise();
    };
    const ok = cdlg.querySelector('.btn-ok');
    ok.click();
    await sleep(300);
    out.payload = payload ? {
        devOwnerId: payload.devOwnerId, testOwnerId: payload.testOwnerId,
        acceptOwnerId: payload.acceptOwnerId,
        devStartDate: payload.devStartDate, testStartDate: payload.testStartDate,
        acceptStartDate: payload.acceptStartDate
    } : null;
    out.payloadOwnersDistinct = !!payload && payload.devOwnerId !== payload.testOwnerId
        && payload.testOwnerId !== payload.acceptOwnerId
        && payload.devOwnerId !== payload.acceptOwnerId;
    out.errs = errs.slice(0, 4);
    console.log(JSON.stringify(out, null, 1));
    process.exit(0);
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e && e.message) })); process.exit(1); });
