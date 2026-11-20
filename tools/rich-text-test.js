/* ==========================================================================
   rich-text-test.js —— 富文本与群聊 @ 组员（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖三块需求：
     1. 阅读邮件 / 写邮件支持富文本：
        · js/rich-text.js 组件（工具栏、contenteditable、.val() 兼容读写器、清洗）
        · 写邮件弹窗挂载编辑器 → 发送带上 bodyHtml → 已发送里按 HTML 渲染
     2. 即时对话查看 / 发送消息支持富文本；气泡内容区固定宽度、超出自动换行
     3. 群聊发消息时允许 @ 某组员（选人浮层 / 落库 atEmpIds / 气泡高亮 / 被 @ 提示）
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/rich-text-test.js
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

/* ============================ 0. 静态一致性 ============================ */
var mailHtml = read('mail.html');
var empMailHtml = read('emp-mail.html');
var msgHtml = read('message.html');
var appCss = read('css/app.css');
var rtSrc = read('js/rich-text.js');
var mailJs = read('js/mail.js');
var empMailJs = read('js/emp-mail.js');
var msgJs = read('js/message.js');
var apiJs = read('js/api.js');
var svcSrc = read('server/service.py');
var appSrc = read('server/app.py');
var mailCli = read('server/mail_client.py');
var ddl = read('db/emp-msg-rich.sql');

console.log('\n--- 0. 静态一致性（页面引用 / 样式 / 后端 / 建表） ---');
check('三个页面都引用 js/rich-text.js',
    mailHtml.indexOf('js/rich-text.js?v=') > -1 &&
    empMailHtml.indexOf('js/rich-text.js?v=') > -1 &&
    msgHtml.indexOf('js/rich-text.js?v=') > -1);
check('两个邮件页正文改为 contenteditable（不再是 textarea）',
    /id="mfBody"[\s\S]{0,200}?contenteditable="true"/.test(mailHtml) &&
    /id="mfBody"[\s\S]{0,200}?contenteditable="true"/.test(empMailHtml) &&
    !/textarea[^>]*id="mfBody"/.test(mailHtml));
check('即时对话输入框改为 contenteditable（不再是 textarea）',
    /id="imText"[\s\S]{0,260}?contenteditable="true"/.test(msgHtml) &&
    msgHtml.indexOf('<textarea id="imText"') < 0);
check('app.css 有富文本工具栏/内容区样式',
    /\.rt__bar\s*\{/.test(appCss) && /\.rt__area\s*\{/.test(appCss) &&
    /\.rt__area:empty:before\s*\{[^}]*data-rt-placeholder/.test(appCss));
check('app.css 有富文本正文渲染样式（.mail-read__body.is-html）',
    /\.mail-read__body\.is-html\s*\{[^}]*white-space:\s*normal/.test(appCss));
check('即时对话气泡内容区固定宽度 + 富文本气泡换行',
    /\.im-msg__content\s*\{[^}]*width:\s*460px/.test(msgHtml) &&
    /\.im-msg__bubble\.is-rich\s*\{[^}]*white-space:\s*normal/.test(msgHtml) &&
    /\.im-msg__bubble\s*\{[^}]*word-break:\s*break-word/.test(msgHtml));
check('即时对话有 @ 浮层与高亮样式',
    /\.im-mention\s*\{/.test(msgHtml) && /\.im-at\s*\{/.test(msgHtml) &&
    /is-artme/.test(msgHtml));
check('mail.js / emp-mail.js 都挂载编辑器并发送 bodyHtml',
    mailJs.indexOf('window.RichText.mount') > -1 && mailJs.indexOf('payload.bodyHtml = html') > -1 &&
    empMailJs.indexOf('window.RichText.mount') > -1 && empMailJs.indexOf('payload.bodyHtml = html') > -1);
check('两个邮件页读信区按 bodyHtml 渲染（is-html）',
    mailJs.indexOf('mail-read__body is-html') > -1 &&
    empMailJs.indexOf('mail-read__body is-html') > -1);
check('message.js 有富文本发送 / @ 选人 / @ 收集',
    msgJs.indexOf('contentHtml: htmlBody') > -1 &&
    msgJs.indexOf('openMentionPicker') > -1 && msgJs.indexOf('collectAtIds') > -1);
check('后端 persist_send 接收 content_html / at_emp_ids',
    svcSrc.indexOf('content_html=\'\', at_emp_ids=None') > -1 &&
    svcSrc.indexOf('def _at_ids_of') > -1);
check('WS 发送帧透传 contentHtml / atEmpIds',
    appSrc.indexOf("content_html = str(msg.get('contentHtml') or '')") > -1 &&
    appSrc.indexOf("'atEmpIds': c.get('atEmpIds') or ''") > -1);
check('邮件协议层接受 body_html 并反抽纯文本',
    mailCli.indexOf('def html_to_text') > -1 && mailCli.indexOf('def clean_html') > -1 &&
    mailCli.indexOf('body_html=None') > -1);
check('建表脚本幂等加 contentHtml / atEmpIds',
    /ADD COLUMN `contentHtml`/.test(ddl) && /ADD COLUMN `atEmpIds`/.test(ddl) &&
    ddl.indexOf('information_schema.COLUMNS') > -1);
check('Mock 通道透传 contentHtml / atEmpIds',
    apiJs.indexOf('contentHtml: contentHtml0') > -1 &&
    apiJs.indexOf('function mockAtIds') > -1);

/* ============================ 1. 组件单测 ============================ */
console.log('\n--- 1. js/rich-text.js 组件（独立窗口） ---');
function bootBare() {
    var dom = new JSDOM('<!doctype html><html><body><div class="host">' +
        '<div id="a" contenteditable="true"></div></div></body></html>',
        { url: 'http://127.0.0.1:8808/x.html', runScripts: 'outside-only', pretendToBeVisual: true });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/rich-text.js'));
    return win;
}
var bw = bootBare();
var b$ = bw.jQuery;
var RT = bw.RichText;

check('组件对外暴露 mount / sanitize / textOf / isEmptyHtml',
    typeof RT.mount === 'function' && typeof RT.sanitize === 'function' &&
    typeof RT.textOf === 'function' && typeof RT.isEmptyHtml === 'function');

var ed = RT.mount(b$('#a'), { placeholder: '说点什么', at: true });
check('挂载后生成 .rt 容器与工具栏', b$('#a').closest('.rt').length === 1 &&
    b$('#a').closest('.rt').find('.rt__bar').length === 1);
check('工具栏按钮 ≥ 12 个（B/I/U/S、字号、字色、底色、列表、引用、链接、清除、@）',
    b$('#a').closest('.rt').find('.rt__btn').length >= 12,
    String(b$('#a').closest('.rt').find('.rt__btn').length));
check('工具栏含加粗 / 列表 / 清除格式 / @ 命令',
    b$('.rt__btn[data-rt-cmd="bold"]').length === 1 &&
    b$('.rt__btn[data-rt-cmd="insertUnorderedList"]').length === 1 &&
    b$('.rt__btn[data-rt-cmd="removeFormat"]').length === 1 &&
    b$('.rt__btn[data-rt-cmd="mention"]').length === 1);
check('可编辑区带 placeholder（空态提示）',
    b$('#a').attr('data-rt-placeholder') === '说点什么');

/* --- extraTools：页面自带按钮（如 IM 的图片/文件/表情/语音/截屏）搬进工具栏最左侧 --- */
(function () {
    var dom2 = new JSDOM('<!doctype html><html><body><div class="host">' +
        '<div id="tools"><button class="im-tool" id="t1">图</button>' +
        '<button class="im-tool" id="t2">文</button></div>' +
        '<div id="b" contenteditable="true"></div></div></body></html>',
        { url: 'http://127.0.0.1:8808/x.html', runScripts: 'outside-only', pretendToBeVisual: true });
    var w2 = dom2.window;
    w2.eval(read('vendor/jquery-3.7.1.min.js'));
    w2.eval(read('js/rich-text.js'));
    var $2 = w2.jQuery;
    var ed2 = w2.RichText.mount($2('#b'), { extraTools: $2('#tools') });
    check('extraTools：页面自带工具条被搬进 .rt__bar 最左侧并改名 rt__extra',
        $2('#tools').length === 1 && $2('#tools').hasClass('rt__extra') &&
        $2('#tools').closest('.rt__bar').length === 1 &&
        $2('.rt__bar').children().first().attr('id') === 'tools');
    check('extraTools：搬入后按钮一个不少（不能看起来像「按钮丢了」）',
        $2('#tools').find('.im-tool').length === 2);
    check('extraTools：搬入后与格式按钮之间有分隔线',
        $2('.rt__bar').children('.rt__sep').length >= 1);
    check('重复挂载返回同一实例且工具条不被搬丢',
        w2.RichText.mount($2('#b')) === ed2 && $2('#tools').find('.im-tool').length === 2);
}());

b$('#a').val('纯文本一行\n第二行');
check('.val() 读回纯文本（老代码 / 老测试兼容）',
    b$('#a').val() === '纯文本一行\n第二行', b$('#a').val());
check('纯文本写入后 text() 一致', ed.text() === '纯文本一行\n第二行', ed.text());

ed.setHtml('<b>加粗</b>与<span style="color:#f56c6c">红字</span>');
check('setHtml 后 html() 带格式标记',
    /<b>加粗<\/b>/.test(ed.html()) && /color:\s*#f56c6c/.test(ed.html()), ed.html());
check('text() 丢掉标签只留文字', ed.text() === '加粗与红字', ed.text());

ed.setHtml('<span class="im-at" data-emp="12">@张三</span>&nbsp;看这里');
check('@ 标记（.im-at[data-emp]）在清洗后保留',
    /class="im-at"/.test(ed.html()) && /data-emp="12"/.test(ed.html()), ed.html());

/* --- 安全清洗 --- */
var dirty = '<div onclick="alert(1)">x</div><script>alert(2)</script>' +
    '<img src="a.png" onerror="alert(3)"><a href="javascript:alert(4)">链</a>' +
    '<iframe src="http://evil"></iframe><p style="width:expression(alert(5))">y</p>';
var clean = RT.sanitize(dirty);
check('sanitize 去掉 <script> / <iframe>', !/<script/i.test(clean) && !/<iframe/i.test(clean), clean);
check('sanitize 去掉 on* 事件属性', !/onclick/i.test(clean) && !/onerror/i.test(clean), clean);
check('sanitize 去掉 javascript: 协议', !/javascript:/i.test(clean), clean);
check('sanitize 去掉 CSS expression', !/expression/i.test(clean), clean);
check('sanitize 保留正常标签与文字', /<div>x<\/div>/.test(clean) && /链/.test(clean), clean);
check('sanitize 给外链补 target=_blank / rel=noopener',
    (/target="_blank"/.test(RT.sanitize('<a href="https://a.com">a</a>'))) &&
    /rel="noopener/.test(RT.sanitize('<a href="https://a.com">a</a>')));

check('textOf：块级标签转换行', RT.textOf('<p>a</p><p>b</p>') === 'a\nb', RT.textOf('<p>a</p><p>b</p>'));
check('textOf：<br> 转换行', RT.textOf('a<br>b') === 'a\nb', RT.textOf('a<br>b'));
check('textOf：列表项加圆点', /·\s*一/.test(RT.textOf('<ul><li>一</li><li>二</li></ul>')),
    RT.textOf('<ul><li>一</li><li>二</li></ul>'));
check('isEmptyHtml：空段落算空', RT.isEmptyHtml('<p><br></p>') === true);
check('isEmptyHtml：有图片不算空', RT.isEmptyHtml('<p><img src="a.png"></p>') === false);

/* ============================ 2. 邮件集成 ============================ */
function bootMail(page, scripts, pre) {
    var dom = new JSDOM(read(page), {
        url: 'http://127.0.0.1:8808/' + page,
        runScripts: 'outside-only', pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    if (pre) { pre(win); }
    win.jQuery.ajax = function () {
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/rich-text.js'));
    win.eval(read('js/layout.js'));
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

var mw = bootMail('mail.html', ['js/service-email-form.js', 'js/mail.js']);
var m$ = mw.jQuery;

function mDialog() { return m$('.el-overlay .el-dialog').last(); }
function mBody() { return mDialog().find('.el-dialog__body'); }
function mToast() { return m$('.el-message-list').text(); }

var mailPhases = [];
function mStep(fn, wait) { mailPhases.push({ fn: fn, wait: wait === undefined ? 700 : wait }); }

mStep(function () {
    console.log('\n--- 2. 写邮件：正文富文本 ---');
    m$('#btnWrite').trigger('click');
}, 2600);

mStep(function () {
    check('弹出写邮件弹窗', mDialog().length === 1 && /写邮件/.test(mDialog().text()),
        mDialog().find('.el-dialog__title').text());
    var $f = mBody().find('.mail-form');
    var $area = $f.find('#mfBody');
    check('正文是 contenteditable 且被 .rt 包住',
        $area.attr('contenteditable') === 'true' && $area.closest('.rt').length === 1,
        String($area.attr('contenteditable')));
    check('正文工具栏按钮齐全（11 个：加粗/斜体/下划线/删除线/双色/列表/引用/链接/清除）',
        $area.closest('.rt').find('.rt__btn').length === 11,
        String($area.closest('.rt').find('.rt__btn').length));
    check('工具栏有字号下拉与两个色板',
        $area.closest('.rt').find('select[data-rt-size]').length === 1 &&
        $area.closest('.rt').find('.rt__palette').length === 2);
    /* 富文本正文：加粗 + 有序列表 + 红字 */
    var rt = mw.RichText.of($area);
    rt.setHtml('<b>月度服务报告</b><ol><li>处理工单 12 个</li></ol>' +
        '<p><span style="color:#f56c6c">全部闭环</span></p>');
    check('正文 html() 带格式标记（<b> / <ol> / color）',
        /<b>/.test(rt.html()) && /<ol>/.test(rt.html()) && /#f56c6c/.test(rt.html()), rt.html());
    check('正文 text() 得到纯文本（供纯文本邮件部分）',
        /月度服务报告/.test(rt.text()) && /全部闭环/.test(rt.text()), rt.text());
    $f.find('#mfTo').val('client@example.com');
    $f.find('#mfSubject').val('富文本正文测试');
    mDialog().find('.btn-ok').trigger('click');
}, 900);

mStep(function () {
    check('富文本邮件已发送（提示「邮件已发送」）', /邮件已发送/.test(mToast()), mToast());
    var store = [];
    try { store = JSON.parse(mw.localStorage.getItem('menu_admin_mail_v1') || '[]'); } catch (e) { store = []; }
    var hit = null, i;
    for (i = 0; i < store.length; i++) {
        if (store[i] && store[i].subject === '富文本正文测试') { hit = store[i]; break; }
    }
    check('Mock 存储里的发件记录带 bodyHtml',
        !!hit && /<b>/.test(String(hit.bodyHtml || '')), hit ? String(hit.bodyHtml).slice(0, 80) : 'not found');
    check('同一封的 bodyText 是纯文本（不含标签）',
        !!hit && String(hit.bodyText || '').indexOf('<b>') < 0, hit ? String(hit.bodyText).slice(0, 60) : '');
});

mStep(function () {
    console.log('--- 2b. 阅读邮件：按 HTML 渲染 ---');
    var item = m$('#mailList .mail-item').filter(function () {
        return /富文本正文测试/.test(m$(this).text());
    }).first();
    check('已发送列表里能找到这封邮件', item.length === 1);
    item.trigger('click');
}, 900);

mStep(function () {
    var $read = m$('#mailRead');
    var $html = $read.find('.mail-read__body.is-html');
    check('阅读区用 .is-html 渲染（不是转义后的纯文本）', $html.length === 1);
    check('加粗 <b> 生效', $html.find('b').length === 1 && /月度服务报告/.test($html.find('b').text()),
        $html.find('b').text());
    check('有序列表 <ol> 生效', $html.find('ol li').length === 1 && /处理工单 12 个/.test($html.text()));
    check('红字样式生效', /#f56c6c|rgb\(245, 108, 108\)/.test(
        String($html.find('span').attr('style') || '')), $html.find('span').attr('style'));
    check('正文里不出现 HTML 源码（无 <b> 字样）',
        $read.find('.mail-read__body').text().indexOf('<b>') < 0,
        $read.find('.mail-read__body').text().slice(0, 60));
});

function runMailPhases(done) {
    (function next() {
        var p = mailPhases.shift();
        if (!p) { return done(); }
        /* 先等再跑：首屏要等 Mock 的 status → list → render 整条链跑完（与 mail-page-test 一致） */
        setTimeout(function () {
            try { p.fn(); } catch (e) { check('邮件阶段执行异常：' + e.message, false, e.stack); }
            next();
        }, p.wait);
    })();
}

/* ============================ 3. 即时对话集成 ============================ */
function bootIm() {
    var dom = new JSDOM(msgHtml, {
        url: 'http://127.0.0.1:8808/message.html',
        runScripts: 'outside-only', pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.setInterval = function () { return 1; };     // 别被定时器挂住
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'mock-token-3', user: { empId: 3, nameCn: '员工3' },
        expireAt: new Date().getTime() + 8 * 3600 * 1000
    }));
    win.jQuery.ajax = function () {
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/rich-text.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/message.js'));
    return win;
}
var iw = bootIm();
var i$ = iw.jQuery;
var IM = iw.IM;
var GID = '';
var AT_ID = 0;

var imPhases = [];
function iStep(fn, wait) { imPhases.push({ fn: fn, wait: wait === undefined ? 700 : wait }); }

iStep(function () {
    console.log('\n--- 3. 即时对话：输入区富文本 ---');
    var $area = i$('#imText');
    check('输入区是 contenteditable 且被 .rt 包住',
        $area.attr('contenteditable') === 'true' && $area.closest('.rt').length === 1,
        String($area.attr('contenteditable')));
    check('输入区工具栏按钮齐全（≥ 12 个）',
        $area.closest('.rt').find('.rt__btn').length >= 12,
        String($area.closest('.rt').find('.rt__btn').length));
    check('输入区工具栏有 @ 按钮',
        $area.closest('.rt').find('.rt__btn[data-rt-cmd="mention"]').length === 1);
    check('编辑器实例已暴露给 IM（IM.editor）', !!IM.editor);
}, 2400);

iStep(function () {
    console.log('--- 3b. 发送富文本消息 → 气泡按 HTML 渲染 ---');
    var peer = parseInt(Object.keys(IM.state.contacts)[0], 10);
    IM.openPeer(peer);
    IM.editor.setHtml('<b>加粗</b>与<span style="color:#f56c6c">红字</span>');
    IM.send();
    var $b = i$('#imChatBody .im-msg.is-me .im-msg__bubble').last();
    check('气泡带 is-rich 类（富文本渲染）', $b.hasClass('is-rich'), $b.attr('class'));
    check('气泡里 <b> 生效', $b.find('b').length === 1 && $b.find('b').text() === '加粗', $b.html());
    check('气泡里红字样式生效', /#f56c6c|rgb\(245, 108, 108\)/.test(
        String($b.find('span').attr('style') || '')), $b.find('span').attr('style'));
    check('发送后输入框清空', IM.editor.text() === '', IM.editor.text());
    check('消息对象带 contentHtml', /<b>/.test(String(
        (IM.state.convo[peer] || []).slice(-1)[0].contentHtml || '')));
});

iStep(function () {
    console.log('--- 3c. 群聊 @ 组员 ---');
    var gs = Object.keys(IM.state.groups);
    check('Mock 里有演示群', gs.length >= 1, gs.join(','));
    GID = gs[0] || '';
    IM.openGroup(GID);
}, 900);

iStep(function () {
    check('群成员已缓存（@ 选人不必再请求）',
        (IM.state.groupMembers[GID] || []).length >= 2,
        String((IM.state.groupMembers[GID] || []).length));
    IM.openMention();
    var $p = i$('#imMention');
    check('@ 浮层已展开', $p.length === 1 && $p.is('[hidden]') === false);
    var members = IM.state.groupMembers[GID] || [];
    var others = members.filter(function (m) { return parseInt(m.empId, 10) !== 3; });
    check('@ 浮层列出组员且排除自己',
        $p.find('.im-mention__item').length === others.length,
        $p.find('.im-mention__item').length + ' vs ' + others.length);
    check('@ 浮层不出现自己', $p.find('.im-mention__item[data-emp="3"]').length === 0);
    $p.find('.im-mention__kw').val('张').trigger('input');
    var filtered = $p.find('.im-mention__item').length;
    check('搜索框可按姓名过滤', filtered <= others.length);
    $p.find('.im-mention__kw').val('').trigger('input');
    var $first = $p.find('.im-mention__item').first();
    AT_ID = parseInt($first.attr('data-emp'), 10);
    $first.trigger('click');
}, 500);

iStep(function () {
    console.log('--- 3d. 点选后插入 @ 标记并随消息发送 ---');
    var $at = i$(IM.editor.el).find('.im-at[data-emp]');
    check('编辑器里插入 .im-at 标记', $at.length === 1, String($at.length));
    check('@ 标记带被 @ 人的 empId', parseInt($at.attr('data-emp'), 10) === AT_ID,
        $at.attr('data-emp'));
    check('@ 标记文案以 @ 开头', /^@/.test($at.text()), $at.text());
    check('collectAtIds() 收到该 empId',
        IM.collectAtIds().length === 1 && IM.collectAtIds()[0] === AT_ID,
        JSON.stringify(IM.collectAtIds()));
    check('浮层点选后收起', i$('#imMention').is('[hidden]') === true);
    IM.editor.insertText(' 看下这个方案');
    IM.send();
}, 900);

iStep(function () {
    var key = 'g' + GID;
    var last = (IM.state.convo[key] || []).slice(-1)[0] || {};
    check('消息落库时带 atEmpIds', String(last.atEmpIds) === String(AT_ID),
        String(last.atEmpIds));
    check('消息纯文本里含 @ 姓名（列表摘要可读）', /@/.test(String(last.content || '')),
        String(last.content).slice(0, 40));
    var $b = i$('#imChatBody .im-msg.is-me .im-msg__bubble').last();
    check('自己发的气泡里 @ 高亮（.im-at）', $b.find('.im-at').length === 1, $b.html().slice(0, 120));
}, 500);

iStep(function () {
    console.log('--- 3e. 被 @ 的人看到「提到了我」 ---');
    IM.socket.simulateInbound(2, '@我 帮忙确认下排期',
        '李明', GID,
        { contentHtml: '<b>@我</b> 帮忙确认下排期', atEmpIds: '3' });
}, 900);

iStep(function () {
    var $last = i$('#imChatBody .im-msg').last();
    check('收到 @ 自己的群消息', $last.length === 1 && /帮忙确认下排期/.test($last.text()),
        $last.text().slice(0, 50));
    check('@ 我的气泡加高亮描边（is-artme）',
        $last.find('.im-msg__bubble.is-artme').length === 1,
        $last.find('.im-msg__bubble').attr('class'));
    check('IM.atMentionsMe 判定正确',
        IM.atMentionsMe({ atEmpIds: '2,3' }) === true &&
        IM.atMentionsMe({ atEmpIds: '2,4' }) === false &&
        IM.atMentionsMe({ atEmpIds: '' }) === false);
});

function runImPhases(done) {
    (function next() {
        var p = imPhases.shift();
        if (!p) { return done(); }
        setTimeout(function () {
            try { p.fn(); } catch (e) { check('IM 阶段执行异常：' + e.message, false, e.stack); }
            next();
        }, p.wait);
    })();
}

/* ============================ 汇总 ============================ */
runMailPhases(function () {
    runImPhases(function () {
        console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
        process.exit(fail ? 1 : 0);
    });
});
