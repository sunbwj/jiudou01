/* ==========================================================================
   potato-test.js —— 主框架右下角「土豆小助手」悬浮按钮测试（jsdom）
   --------------------------------------------------------------------------
   覆盖：
     · 静态：main.html 的土豆 DOM / 右侧抽屉 DOM / css·js 引用与版本 / 只挂框架页、
             AppPotato 对外 API、ES5 语法、不请求后端、
             css 关键动效 / 拖动态 / 气泡翻转 / 抽屉样式 / message.html 内嵌模式
     · 交互：单击开合气泡 / 提示语轮换 / aria-expanded / 点空白关闭 / Esc / 点气泡不关闭
     · 双击：右侧滑出「即时对话」抽屉（iframe 懒加载 message.html?embed=1）、× 关闭、Esc 关闭
     · 拖动：按住拖到任意位置 / 遮罩 / 边界夹紧 / localStorage 记忆 / 拖尾不误触 /
             方向键微调 / resetPosition 复位
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/potato-test.js
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
function px(v) { return parseFloat(v) || 0; }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

var mainHtml = read('main.html');
var css = read('css/potato.css');
var js = read('js/potato.js');
var msgHtml = read('message.html');

/* ------------------------------- 0. 静态一致性 ------------------------------- */
console.log('--- 0. 静态一致性（DOM / 引用 / 样式 / 脚本） ---');

check('main.html 土豆 DOM 齐全（容器 / 按钮 / 气泡 / 文案 / 关闭）',
    ['id="potatoFab"', 'id="potatoFabBtn"', 'id="potatoBubble"',
        'id="potatoBubbleText"', 'id="potatoBubbleClose"']
        .every(function (k) { return mainHtml.indexOf(k) > -1; }));

check('main.html 右侧抽屉是通讯录面板（搜索 / 两个标签 / 名单 / 关闭）',
    ['id="potatoIm"', 'id="piList"', 'id="piSearch"', 'id="potatoImClose"',
        'data-tab="contact"', 'data-tab="group"']
        .every(function (k) { return mainHtml.indexOf(k) > -1; }) &&
    mainHtml.indexOf('potatoImFull') === -1);

check('抽屉里没有会话消息列表、也没有发消息区（piChat / piInput / piSend 一律不存在）',
    ['id="piChat"', 'id="piChatBody"', 'id="piChatTitle"', 'id="piInput"', 'id="piSend"']
        .every(function (k) { return mainHtml.indexOf(k) === -1; }));

check('抽屉标题是「员工IM」，且只有联系人 / 群组两个标签（没有「消息」区）',
    mainHtml.indexOf('<span class="potato-im__title">员工IM</span>') > -1 &&
    mainHtml.indexOf('aria-label="员工IM"') > -1 &&
    mainHtml.indexOf('data-tab="chat"') === -1 &&
    (mainHtml.match(/data-tab="/g) || []).length === 2);

check('抽屉里不再内嵌 message.html（没有 iframe / embed 地址）',
    mainHtml.indexOf('potatoImFrame') === -1 &&
    mainHtml.indexOf('<iframe') === -1 &&
    js.indexOf('message.html?embed=1') === -1);

check('按钮带无障碍属性（aria-label / aria-expanded / aria-controls）',
    /aria-label="(土豆|九豆)小助手"/.test(mainHtml) &&
    mainHtml.indexOf('aria-expanded="false"') > -1 &&
    mainHtml.indexOf('aria-controls="potatoBubble"') > -1);

check('卡通土豆是内联 SVG（不外链图片，带渐变与眼睛/嘴巴/嫩芽）',
    mainHtml.indexOf('class="potato"') > -1 &&
    mainHtml.indexOf('id="potatoSkin"') > -1 &&
    mainHtml.indexOf('potato__eyes') > -1 &&
    mainHtml.indexOf('potato__mouth') > -1 &&
    mainHtml.indexOf('potato__sprout') > -1 &&
    !/potato[^"]*\.(png|gif|jpg|webp)/.test(mainHtml));

check('main.html 引用 css/potato.css?v=20261110h，且在 notify.css 之后',
    mainHtml.indexOf('css/potato.css?v=20261110h') > -1 &&
    mainHtml.indexOf('css/notify.css') < mainHtml.indexOf('css/potato.css'));

check('main.html 引用 js/potato.js?v=20261107l，且排在 jquery / frame.js 之后',
    mainHtml.indexOf('js/potato.js?v=20261107l') > -1 &&
    mainHtml.indexOf('jquery-3.7.1.min.js') < mainHtml.indexOf('js/potato.js') &&
    mainHtml.indexOf('js/frame.js') < mainHtml.indexOf('js/potato.js'));

check('main.html 先载 potato-im.js 再载 potato.js（抽屉开关早于面板实现）',
    mainHtml.indexOf('js/potato-im.js?v=20261110g') > -1 &&
    mainHtml.indexOf('js/potato-im.js') < mainHtml.indexOf('js/potato.js'));

check('两处工具条图标统一：小窗五个 SVG + 即时对话页截屏改成剪刀图标',
    (mainHtml.match(/id="piTool(Emoji|Image|File|Voice|Shot)"[\s\S]{0,200}?<svg/g) || []).length === 5 &&
    mainHtml.indexOf('id="piToolShot"') > -1 &&
    read('message.html').indexOf('id="imShot"') > -1 &&
    read('message.html').indexOf('<circle cx="6" cy="6" r="2.6"/>') > -1 &&
    css.indexOf('.pi-tool svg') > -1);

check('小窗工具条顺序与即时对话页一致（图片 → 表情 → 文件 → 语音 → 截屏）',
    (function () {
        var order = ['piToolImage', 'piToolEmoji', 'piToolFile', 'piToolVoice', 'piToolShot'];
        var idx = order.map(function (id) { return mainHtml.indexOf('id="' + id + '"'); });
        if (idx.some(function (i) { return i < 0; })) { return false; }
        for (var i = 1; i < idx.length; i++) { if (idx[i] <= idx[i - 1]) { return false; } }
        var page = read('message.html');
        var pOrder = ['imPickImage', 'imEmoji', 'imPickFile', 'imVoice', 'imShot'];
        var pIdx = pOrder.map(function (id) { return page.indexOf('id="' + id + '"'); });
        for (var j = 1; j < pIdx.length; j++) { if (pIdx[j] <= pIdx[j - 1]) { return false; } }
        return true;
    })());

check('语音消息：小窗 <audio> 样式 + 录音发送（MediaRecorder，不再用云端识别）',
    css.indexOf('.pi-chatwin .pi-audio') > -1 &&
    (function () {
        var im = read('js/potato-im.js');
        return im.indexOf('new MediaRecorder(') > -1 &&
            im.indexOf('getUserMedia') > -1 &&
            im.indexOf('window.SpeechRecognition') === -1 &&
            im.indexOf("msgType: 'audio'") > -1;
    })());

check('小窗标题栏可拖动（cursor + is-dragging 样式）',
    css.indexOf('.pi-chatwin__head') > -1 &&
    css.indexOf('cursor: grab') > -1 &&
    css.indexOf('.pi-chatwin.is-dragging') > -1);

check('小窗有最大化 + 媒体工具条（表情/图片/文件/语音/截屏）+ 表情面板容器',
    ['id="piChatWinMax"', 'id="piToolEmoji"', 'id="piToolImage"', 'id="piToolFile"',
        'id="piToolVoice"', 'id="piToolShot"', 'id="piEmojiPanel"', 'id="piFileImage"', 'id="piFileAny"']
        .every(function (k) { return mainHtml.indexOf(k) > -1; }) &&
    mainHtml.indexOf('js/im-shot.js') > -1);

check('双击联系人/群组弹出独立小窗（DOM 齐全，不是跳转页面）',
    ['id="piChatWin"', 'id="piChatWinTitle"', 'id="piChatWinBody"',
        'id="piChatWinInput"', 'id="piChatWinSend"', 'id="piChatWinClose"']
        .every(function (k) { return mainHtml.indexOf(k) > -1; }) &&
    css.indexOf('.pi-chatwin') > -1 &&
    css.indexOf('.pi-chatwin .pi-bubble') > -1);

check('小窗初始更大（720×620）+ 最大化样式 + 媒体气泡样式',
    css.indexOf('width: 720px') > -1 && css.indexOf('height: 620px') > -1 &&
    css.indexOf('.pi-chatwin.is-max') > -1 &&
    ['.pi-tool', '.pi-emoji__grid', '.pi-chatwin .pi-img', '.pi-chatwin .pi-sticker',
        '.pi-chatwin .pi-file', '.pi-chatwin .pi-bubble.is-emoji']
        .every(function (k) { return css.indexOf(k) > -1; }));

check('双击识别 + 小窗 API；单击只选中不跳页',
    js.indexOf('openChat(') === -1 &&                       // 小窗逻辑在 potato-im.js
    (function () {
        var im = read('js/potato-im.js');
        return im.indexOf('function onItemClick') > -1 && im.indexOf('openChat(kind, id)') > -1 &&
            im.indexOf('isChatOpen: isChatOpen') > -1 &&
            im.indexOf('closeChat: closeChat') > -1 &&
            im.indexOf('Api.msg.history(') > -1 &&
            im.indexOf('Api.msg.groupHistory(') > -1 && im.indexOf('openConversation') === -1;
    })() &&
    js.indexOf('PotatoIM.closeChat') > -1);

check('抽屉里有建群/改名弹窗（＋入口 / 弹窗 / 确定取消 / 成员检索）',
    ['id="piNewGroup"', 'id="piModal"', 'id="piModalOk"', 'id="piModalCancel"',
        'id="piModalClose"', 'id="piModalErr"', 'id="piToast"']
        .every(function (k) { return mainHtml.indexOf(k) > -1; }));

check('两个标签各带未读红点容器（piUnreadContact / piUnreadGroup）',
    mainHtml.indexOf('id="piUnreadContact"') > -1 &&
    mainHtml.indexOf('id="piUnreadGroup"') > -1 &&
    css.indexOf('.pi-tab__dot') > -1 &&
    css.indexOf('.pi-tab__dot[hidden]') > -1);

check('Esc 先关弹窗再关抽屉（potato.js 检查 PotatoIM.isModalOpen）',
    js.indexOf('PotatoIM.isModalOpen') > -1 && js.indexOf('PotatoIM.closeModal') > -1);

check('只挂框架页（其它业务页不引用 potato）',
    read('project.html').indexOf('potato') === -1 &&
    read('emp.html').indexOf('potato') === -1 &&
    read('message.html').indexOf('potato') === -1);

check('AppPotato 对外 API 齐全（open/close/toggle/isOpen/openIm/closeIm/toggleIm/isImOpen/resetPosition）',
    ['open: open', 'close: close', 'toggle: toggle', 'isOpen: isOpen', 'openIm: openIm',
        'closeIm: closeIm', 'toggleIm: toggleIm', 'isImOpen: isImOpen', 'resetPosition: resetPosition']
        .every(function (k) { return js.indexOf(k) > -1; }));

check('potato.js 是 ES5 老语法（无箭头函数 / const / let / 模板字符串）',
    js.indexOf('=>') === -1 && !/\bconst\s/.test(js) && !/\blet\s/.test(js) && js.indexOf('`') === -1);

check('纯前端：不请求后端（无 Api. / ajax / fetch / XMLHttpRequest）',
    js.indexOf('window.Api') === -1 && js.indexOf('.ajax(') === -1 &&
    js.indexOf('fetch(') === -1 && js.indexOf('XMLHttpRequest') === -1);

check('双击识别（< 300ms 判双击；打开时交给 PotatoIM 原生面板）',
    js.indexOf('now - lastClickAt < 300') > -1 &&
    js.indexOf('window.PotatoIM') > -1);

check('potato-im.js：名单读 contacts/groups，双击小窗用 history/groupHistory/send（不碰 iframe）',
    (function () {
        var im = read('js/potato-im.js');
        return im.indexOf('Api.msg.contacts()') > -1 &&
            im.indexOf('Api.msg.groups()') > -1 &&
            im.indexOf('Api.msg.history(') > -1 &&
            im.indexOf('Api.msg.groupHistory(') > -1 &&
            im.indexOf('Api.msg.send(') > -1 &&
            im.indexOf('contentDocument') === -1 &&
            im.indexOf('<iframe') === -1 &&
            im.indexOf('=>') === -1;
    })());

check('css 关键动效（浮动 / 眨眼 / 嫩芽摇摆 / 挥手 / 点击蹦跳）',
    ['potato-float', 'potato-blink', 'potato-sway', 'potato-wave', 'potato-hop']
        .every(function (k) { return css.indexOf(k) > -1; }));

check('css 尊重「减少动态效果」（prefers-reduced-motion 关动画）',
    css.indexOf('prefers-reduced-motion') > -1 && css.indexOf('animation: none !important') > -1);

check('css 定位右下角且在底栏之上（fixed / right / bottom: 56px）', css.indexOf('position: fixed') > -1 && css.indexOf('bottom: 56px') > -1);

check('永远置顶：土豆 z-index 9999（压过抽屉 2400 / 小窗 2500 / 提醒面板 3000），拖拽遮罩 9998',
    css.indexOf('z-index: 9999') > -1 && css.indexOf('z-index: 9998') > -1 &&
    css.indexOf('z-index: 1600') === -1);

check('css 支持拖动态（抓手光标 / 拖动中停浮动 / touch-action: none）',
    css.indexOf('cursor: grab') > -1 && css.indexOf('cursor: grabbing') > -1 &&
    css.indexOf('.potato-fab.is-dragging') > -1 && css.indexOf('touch-action: none') > -1);

check('css 气泡贴边翻转（is-below 翻到下方 / is-align-left 左对齐）',
    css.indexOf('.potato-fab__bubble.is-below') > -1 &&
    css.indexOf('.potato-fab__bubble.is-align-left') > -1);

check('css 拖拽遮罩紧随土豆之下（z-index 9998）',
    css.indexOf('.potato-drag-shield') > -1 &&
    css.indexOf('.potato-drag-shield.is-on') > -1 &&
    css.indexOf('z-index: 9998') > -1);

check('css 抽屉：贴右侧 / 400px / 在土豆之上（z-index 2400）/ 滑入过渡',
    css.indexOf('.potato-im {') > -1 && css.indexOf('width: 400px') > -1 &&
    css.indexOf('z-index: 2400') > -1 && css.indexOf('.potato-im.is-open') > -1 &&
    css.indexOf('translateX(102%)') > -1);

check('css 面板：搜索 + 标签 + 名单 + 底部说明（抽屉内没有会话区/输入框，聊天在独立小窗）',
    ['.pi-body', '.pi-search', '.pi-tab', '.pi-list', '.pi-item', '.pi-badge', '.pi-foot']
        .every(function (k) { return css.indexOf(k) > -1; }) &&
    ['.pi-chat__body', '.pi-input', '.pi-send', '.pi-chat__title']
        .every(function (k) { return css.indexOf(k) === -1; }) &&
    css.indexOf('.pi-chatwin .pi-bubble') > -1);

check('css 建群/改名：＋入口、群条目铅笔、弹窗与成员勾选、提示条',
    ['.pi-newgroup', '.pi-item__rename', '.pi-modal', '.pi-modal__box', '.pi-field',
        '.pi-pick', '.pi-pick__item', '.pi-btn--primary', '.pi-toast']
        .every(function (k) { return css.indexOf(k) > -1; }));

check('message.html 回到原样（不再保留内嵌用的 im-embed 样式）',
    msgHtml.indexOf('im-embed') === -1);

/* ------------------------------- 1. 交互行为 ------------------------------- */
(async function () {
    console.log('\n--- 1. 交互行为（单击气泡 / 双击抽屉） ---');

    var dom = new JSDOM(mainHtml, {
        url: 'http://127.0.0.1:8808/main.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/potato.js'));

    var $ = win.jQuery;
    var $fab = $('#potatoFab');
    var $btn = $('#potatoFabBtn'), $bubble = $('#potatoBubble'), $text = $('#potatoBubbleText');
    var $im = $('#potatoIm');
    var fabEl = $fab[0];

    // 抽屉内容由 potato-im.js 负责，这里打桩只验证「开关是否交给它」
    var imCalls = 0;
    win.PotatoIM = { open: function () { imCalls++; }, close: function () { }, isOpen: function () { return false; } };

    check('按钮与气泡都已挂到页面', $btn.length === 1 && $bubble.length === 1);
    check('初始态：气泡隐藏、抽屉未展开、面板未被调用',
        $bubble.is('[hidden]') && !$im.hasClass('is-open') && imCalls === 0 &&
        $btn.attr('aria-expanded') === 'false');

    $btn.trigger('click');
    check('单击：气泡显示、写入提示语、aria-expanded=true',
        !$bubble.is('[hidden]') && $text.text().length > 0 && $btn.attr('aria-expanded') === 'true',
        '文本=' + $text.text());
    check('单击不会打开抽屉', !$im.hasClass('is-open'));
    check('点击后加一下 is-happy 蹦跳动效', $btn.hasClass('is-happy'));

    var firstTip = $text.text();
    await wait(320);
    $btn.trigger('click');
    check('再单击一次收起（气泡隐藏、aria-expanded=false）',
        $bubble.is('[hidden]') && $btn.attr('aria-expanded') === 'false');

    await wait(320);
    $btn.trigger('click');
    check('提示语轮换（两次打开不是同一句）', $text.text() !== firstTip,
        'first=' + firstTip + ' / second=' + $text.text());

    $bubble.trigger('click');
    check('点气泡自身不关闭（避免刚开就关）', !$bubble.is('[hidden]'));

    $(win.document.body).trigger('click');
    check('点页面空白处自动关闭', $bubble.is('[hidden]'));

    // 与下一次点击拉开 300ms 以上，避免这两下被当成双击
    await wait(320);
    $btn.trigger('click');
    $(win.document).trigger($.Event('keydown', { keyCode: 27 }));
    check('按 Esc 关闭气泡', $bubble.is('[hidden]'));

    check('对外 API：AppPotato.open() / close() 与 DOM 状态一致',
        (win.AppPotato.open(), !$bubble.is('[hidden]') && win.AppPotato.isOpen() === true) &&
        (win.AppPotato.close(), $bubble.is('[hidden]') && win.AppPotato.isOpen() === false));

    /* ---- 双击 → 右侧「即时对话」抽屉 ---- */
    console.log('\n--- 2. 双击弹出右侧「即时对话」抽屉 ---');
    await wait(320);
    win.AppPotato.closeIm();                  // 前面的断言里可能已触发过一次双击，先复位
    await wait(320);
    var beforePair = imCalls;
    $btn.trigger('click');                    // 第一下：先按单击处理（弹气泡）
    $btn.trigger('click');                    // 第二下：< 300ms 内 → 判双击
    check('双击打开抽屉（.is-open + aria-hidden=false）',
        $im.hasClass('is-open') && $im.attr('aria-hidden') === 'false');
    check('双击后气泡被收起（不会和抽屉抢注意力）', $bubble.is('[hidden]'));
    check('双击把抽屉内容交给原生面板 PotatoIM.open()（不是内嵌页面）',
        imCalls === beforePair + 1, 'calls=' + beforePair + '→' + imCalls);

    $('#potatoImClose').trigger('click');
    check('× 关闭抽屉（.is-open 移除、aria-hidden=true）',
        !$im.hasClass('is-open') && $im.attr('aria-hidden') === 'true');

    win.AppPotato.openIm();
    check('AppPotato.openIm() 可编程打开（供其它页面/脚本调用）',
        $im.hasClass('is-open') && win.AppPotato.isImOpen() === true);
    $(win.document).trigger($.Event('keydown', { keyCode: 27 }));
    check('Esc 关抽屉（抽屉开着时优先关抽屉）',
        !$im.hasClass('is-open') && win.AppPotato.isImOpen() === false);

    await wait(320);
    $btn.trigger('click');
    check('抽屉关掉后单击仍是小气泡（不会误开抽屉）',
        !$bubble.is('[hidden]') && !$im.hasClass('is-open'));

    /* ---- 置顶后不需要让位：开着抽屉再双击仍能收起 ---- */
    console.log('\n--- 2.1 置顶与双击开合 ---');
    Object.defineProperty(fabEl, 'offsetWidth', { configurable: true, get: function () { return 76; } });
    Object.defineProperty(fabEl, 'offsetHeight', { configurable: true, get: function () { return 76; } });
    fabEl.getBoundingClientRect = function () {
        var l = fabEl.style.left ? px(fabEl.style.left) : 900;
        var t = fabEl.style.top ? px(fabEl.style.top) : 600;
        return { left: l, top: t, right: l + 76, bottom: t + 76, width: 76, height: 76 };
    };

    win.AppPotato.openIm();
    check('抽屉打开时土豆位置不变（靠置顶显示，不靠让位）',
        fabEl.style.left === '' || Math.round(px(fabEl.style.left)) === 900,
        fabEl.style.left);

    $btn.trigger('click');
    $btn.trigger('click');
    check('开着抽屉时再双击土豆 → 收起抽屉',
        !$im.hasClass('is-open') && win.AppPotato.isImOpen() === false);
    win.AppPotato.resetPosition();

    /* ---- 最小化 / 还原胶囊 ---- */
    console.log('\n--- 2.2 最小化与还原 ---');
    win.AppPotato.openIm();
    check('抽屉头部有最小化按钮', $('#potatoImMin').length === 1);
    $('#potatoImMin').trigger('click');
    check('点最小化：抽屉收起、右侧出现「员工IM」胶囊',
        !$im.hasClass('is-open') && !$('#potatoImPill').is('[hidden]') &&
        win.AppPotato.isMinimized() === true);
    $('#potatoImPill').trigger('click');
    check('点胶囊还原：抽屉重新打开、胶囊隐藏',
        $im.hasClass('is-open') && $('#potatoImPill').is('[hidden]') &&
        win.AppPotato.isMinimized() === false);
    win.AppPotato.closeIm();
    check('关闭时胶囊一并收起', $('#potatoImPill').is('[hidden]'));

    /* ------------------------------- 3. 拖动 ------------------------------- */
    console.log('\n--- 3. 拖动（任意位置 / 夹紧 / 记忆 / 不误触） ---');

    // jsdom 没有布局引擎：给按钮一个可控的几何盒（环境里 offsetWidth 恒 0）
    Object.defineProperty(fabEl, 'offsetWidth', { configurable: true, get: function () { return 76; } });
    Object.defineProperty(fabEl, 'offsetHeight', { configurable: true, get: function () { return 76; } });
    var box = { left: 900, top: 500 };
    fabEl.getBoundingClientRect = function () {
        var l = fabEl.style.left ? px(fabEl.style.left) : box.left;
        var t = fabEl.style.top ? px(fabEl.style.top) : box.top;
        return { left: l, top: t, right: l + 76, bottom: t + 76, width: 76, height: 76 };
    };

    function drag(fromX, fromY, toX, toY) {
        $btn.trigger($.Event('mousedown', { clientX: fromX, clientY: fromY, button: 0 }));
        $(win.document).trigger($.Event('mousemove', { clientX: (fromX + toX) / 2, clientY: (fromY + toY) / 2 }));
        $(win.document).trigger($.Event('mousemove', { clientX: toX, clientY: toY }));
        $(win.document).trigger($.Event('mouseup', { clientX: toX, clientY: toY }));
    }

    // 先单独验遮罩：拖过阈值后应铺出全屏遮罩，松手即撤（否则会一直挡住 iframe）
    $btn.trigger($.Event('mousedown', { clientX: 940, clientY: 540, button: 0 }));
    $(win.document).trigger($.Event('mousemove', { clientX: 1000, clientY: 600 }));
    check('拖动开始铺全屏遮罩（挡住 iframe，事件不丢）',
        $('.potato-drag-shield.is-on').length === 1);
    $(win.document).trigger($.Event('mouseup', { clientX: 1000, clientY: 600 }));
    check('松手后遮罩撤掉（不在页面上留透明层）',
        $('.potato-drag-shield.is-on').length === 0);
    win.AppPotato.resetPosition();

    // 视口 1024×768：按在 (940,540)（即按钮内 40,40 处）→ 拖到 (700,400) → 左上角应为 (660,360)
    drag(940, 540, 700, 400);
    check('按住可拖动（left/top 按「按下点 - 抓取偏移」落位）',
        Math.round(px(fabEl.style.left)) === 660 && Math.round(px(fabEl.style.top)) === 360,
        'left=' + fabEl.style.left + ' top=' + fabEl.style.top);

    check('拖动时挂 is-dragging、松手后摘掉', $fab.hasClass('is-dragging') === false);

    check('拖完位置写进 localStorage（刷新后还在）',
        (function () {
            var raw = win.localStorage.getItem('menu_admin_potato_pos');
            if (!raw) { return false; }
            var o = JSON.parse(raw);
            return Math.round(o.left) === 660 && Math.round(o.top) === 360;
        })(), win.localStorage.getItem('menu_admin_potato_pos'));

    check('拖完松手补的那次 click 不会弹气泡',
        ($btn.trigger('click'), $bubble.is('[hidden]')));

    // 往右下角猛拖 → 必须夹在视口内（1024-76-4=944 / 768-76-4=688）
    drag(700, 400, 5000, 5000);
    check('拖出视口会被夹紧（右下 944,688）',
        Math.round(px(fabEl.style.left)) === 944 && Math.round(px(fabEl.style.top)) === 688,
        'left=' + fabEl.style.left + ' top=' + fabEl.style.top);

    // 往左上角猛拖 → 夹到 4,4
    drag(980, 720, -500, -500);
    check('拖出视口会被夹紧（左上 4,4）',
        Math.round(px(fabEl.style.left)) === 4 && Math.round(px(fabEl.style.top)) === 4,
        'left=' + fabEl.style.left + ' top=' + fabEl.style.top);

    // 方向键微调（焦点在按钮上）：右 8 → left 12；Shift+下 24 → top 28
    $btn.trigger($.Event('keydown', { keyCode: 39 }));
    $btn.trigger($.Event('keydown', { keyCode: 40, shiftKey: true }));
    check('方向键可微调（右 8 / Shift+下 24）',
        Math.round(px(fabEl.style.left)) === 12 && Math.round(px(fabEl.style.top)) === 28,
        'left=' + fabEl.style.left + ' top=' + fabEl.style.top);

    // 复位：回到 CSS 的 right/bottom，localStorage 清掉
    win.AppPotato.resetPosition();
    check('resetPosition 复位（清空内联 left/top、删掉记忆）',
        fabEl.style.left === '' && fabEl.style.top === '' &&
        win.localStorage.getItem('menu_admin_potato_pos') === null,
        'left="' + fabEl.style.left + '" top="' + fabEl.style.top + '"');

    // 300ms 后点击恢复正常（拖动抑制只在松手瞬间生效）
    await wait(350);
    $btn.trigger('click');
    check('拖动抑制有时限：300ms 后点击照常弹气泡', !$bubble.is('[hidden]'));

    console.log('\n===== potato-test 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
    process.exit(fail ? 1 : 0);
})().catch(function (e) {
    console.error('测试异常：' + (e && e.stack || e));
    process.exit(1);
});
