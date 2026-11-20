/* 缺陷管理页探针（jsdom + 真实后端）：
   注入登录态 → 打开 bug.html → 等列表渲染 → 输出工具栏 / 应用下拉 / 列表状态 / JS 错误。 */
const { JSDOM, VirtualConsole } = require('jsdom');

const TK = process.env.BUG_TOKEN || '';
const vc = new VirtualConsole();
const errs = [];
vc.on('jsdomError', (e) => errs.push('jsdomError: ' + (e && e.message)));
vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ').slice(0, 200)));

const url = 'http://127.0.0.1:8808/bug.html';
JSDOM.fromURL(url, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
        try {
            win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
                token: TK, user: { empId: 1, empName: '别文进', account: '13813970452' }
            }));
        } catch (e) { errs.push('localStorage: ' + e.message); }
    }
}).then((dom) => {
    const win = dom.window;
    const t0 = Date.now();
    const timer = setInterval(() => {
        const d = win.document;
        const tb = d.getElementById('bugTbody');
        const rows = tb ? tb.querySelectorAll('tr[data-id]').length : 0;
        const text = tb ? (tb.textContent || '').trim() : '';
        const settled = rows > 0 || /没有符合条件|加载失败|登录|超时/.test(text);
        if (!settled && Date.now() - t0 < 9000) { return; }
        clearInterval(timer);
        const btns = Array.from(d.querySelectorAll('.toolbar button'));
        const hidden = btns.filter((b) => {
            let el = b, vis = true;
            while (el && el.nodeType === 1) {
                const st = win.getComputedStyle(el);
                if (st && (st.display === 'none' || st.visibility === 'hidden')) { vis = false; break; }
                el = el.parentElement;
            }
            return !vis;
        }).map((b) => b.id);
        const out = {
            title: d.title,
            toolbarButtons: btns.length,
            hiddenButtons: hidden,
            rows: rows,
            emptyOrError: text.slice(0, 80),
            projectOptions: d.querySelectorAll('#bugProject option').length,
            statusOptions: d.querySelectorAll('#bugStatusMulti .bug-multi__opt').length,
            pager: !!d.querySelector('#bugPager .el-pagination'),
            errors: errs.slice(0, 5)
        };
        console.log(JSON.stringify(out, null, 1));
        process.exit(0);
    }, 300);
}).catch((e) => {
    console.log(JSON.stringify({ fatal: String(e && e.message) }, null, 1));
    process.exit(1);
});
