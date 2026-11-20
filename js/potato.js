/* ==========================================================================
   potato.js —— 主框架右下角「土豆小助手」悬浮按钮（只被 main.html 引用）
   ----------------------------------------------------------------------------
   职责：
     1) 点击土豆 → 弹出一句小提示（提示语按顺序轮换，不重复同一句）；
     2) 关闭入口：气泡右上角 ×、点页面空白处、按 Esc；
     3) 点击时给土豆加一下「蹦起来」的动效（is-happy，620ms 后自动移除）；
     4) **鼠标可拖动**：按住土豆拖到页面任意位置，松手即记住（localStorage），
        拖动后不会误触「点击弹气泡」；位置自动夹在视口内，窗口缩放后重新夹紧；
        焦点在土豆上时也可用方向键微调（Shift 加速），窗口 resize 后自动夹回视口内。
     5) **双击土豆**：靠屏幕右侧滑出「即时对话」抽屉——**原生实现**（js/potato-im.js 直接调 Api.msg，
        不内嵌任何页面），联系人 / 群组 / 会话 / 输入框都在抽屉里；× 或 Esc 关闭，
        抽屉只做名单与会话小窗；图片 / 表情 / 语音 / 截屏等能力在小窗工具条里。
     6) 对外暴露 window.AppPotato = { open, close, toggle, isOpen, openIm, closeIm, toggleIm, isImOpen, resetPosition }。
   说明：纯前端装饰 + 交互，不请求后端；按钮不存在（或没加载 jQuery）时静默退出，
        绝不影响主框架。
   ========================================================================== */
window.AppPotato = (function () {
    'use strict';

    // 轮换的小提示（短、口语化，不带业务承诺）
    var TIPS = [
        '我是九豆小助手，有活儿随时叫我～',
        '左边菜单点一下，就能开始干活啦。',
        '累了就伸个懒腰，我在这儿晒会儿太阳。',
        '找不到功能？先看看「即时对话」和「我的邮箱」。',
        '被点到了！我是一颗很认真的九豆。',
        '别担心，我只是个会眨眼的按钮。'
    ];

    var POS_KEY = 'menu_admin_potato_pos';   // {left, top}（视口坐标，px）
    var DRAG_MIN = 4;                         // 位移超过 4px 才算拖动，否则仍算点击
    var MARGIN = 4;                           // 贴边留白，保证任何时候都点得到
    var FAB_W = 76, FAB_H = 76;               // 兜底尺寸（布局未就绪时用）
    var BUBBLE_W = 198, BUBBLE_H = 66;

    var $ = null;
    var $fab = null, $btn = null, $bubble = null, $text = null, $close = null, $shield = null;
    var $im = null, $imClose = null, $imMin = null, $imPill = null;
    var tipIndex = -1;
    var opened = false;
    var imOpen = false;                       // 右侧「即时对话」抽屉是否展开
    var lastClickAt = 0;                      // 上一次点击时刻，用来识别双击
    var happyTimer = null;

    // 拖动状态
    var pos = { left: null, top: null };      // 当前固定位置；null = 仍由 CSS 的 right/bottom 决定
    var dragging = false;                     // 已真正拖动（越过阈值）
    var pressing = false;                     // 已按下但未必移动
    var grabDX = 0, grabDY = 0;               // 按下点相对按钮左上角的偏移
    var startX = 0, startY = 0;
    var lastDragEnd = 0;                      // 拖动结束时刻，用来吃掉紧随其后的 click

    function isOpen() { return opened; }

    function nextTip() {
        tipIndex = (tipIndex + 1) % TIPS.length;
        return TIPS[tipIndex];
    }

    function viewport() {
        var w = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 1024;
        var h = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 768;
        return { w: w, h: h };
    }

    function fabSize() {
        var r = $fab[0].getBoundingClientRect();
        return {
            w: $fab[0].offsetWidth || r.width || FAB_W,
            h: $fab[0].offsetHeight || r.height || FAB_H
        };
    }

    /** 把坐标夹进视口（按钮整体可见） */
    function clampPos(left, top) {
        var vp = viewport(), sz = fabSize();
        var maxL = Math.max(MARGIN, vp.w - sz.w - MARGIN);
        var maxT = Math.max(MARGIN, vp.h - sz.h - MARGIN);
        return {
            left: Math.min(Math.max(MARGIN, left), maxL),
            top: Math.min(Math.max(MARGIN, top), maxT)
        };
    }

    /** 落到页面（换成 left/top 定位；CSS 的 right/bottom 让位） */
    function applyPos(left, top) {
        var p = clampPos(left, top);
        pos.left = p.left;
        pos.top = p.top;
        $fab.css({ left: p.left + 'px', top: p.top + 'px', right: 'auto', bottom: 'auto' });
    }

    /** 第一次需要精确定位时，把当前 right/bottom 布局换算成 left/top */
    function ensurePos() {
        if (pos.left !== null && pos.top !== null) { return; }
        var r = $fab[0].getBoundingClientRect();
        applyPos(r.left, r.top);
    }

    function readSavedPos() {
        try {
            var raw = window.localStorage.getItem(POS_KEY);
            if (!raw) { return null; }
            var o = JSON.parse(raw);
            if (o && typeof o.left === 'number' && typeof o.top === 'number') { return o; }
        } catch (e) { /* 隐私模式 / 脏数据：忽略 */ }
        return null;
    }

    function savePos() {
        try {
            window.localStorage.setItem(POS_KEY, JSON.stringify({ left: pos.left, top: pos.top }));
        } catch (e) { /* 存不了也不影响使用 */ }
    }

    function resetPosition() {
        pos.left = null;
        pos.top = null;
        $fab.css({ left: '', top: '', right: '', bottom: '', 'z-index': '' });
        try { window.localStorage.removeItem(POS_KEY); } catch (e) { /* 忽略 */ }
        close();
    }

    function open() {
        if (!$bubble || opened) { return; }
        opened = true;
        $text.text(nextTip());
        $bubble.removeAttr('hidden');
        placeBubble();
        $btn.attr({ 'aria-expanded': 'true' });
    }

    function close() {
        if (!$bubble || !opened) { return; }
        opened = false;
        $bubble.attr('hidden', 'hidden');
        $btn.attr({ 'aria-expanded': 'false' });
    }

    function toggle() { if (opened) { close(); } else { open(); } }

    /* ---------------------- 右侧「即时对话」抽屉 ---------------------- */

    function isImOpen() { return imOpen; }

    function openIm() {
        if (!$im || !$im.length) { return; }
        if (!imOpen) {
            imOpen = true;
            if ($imPill && $imPill.length) { $imPill.attr('hidden', 'hidden'); }
            $im.addClass('is-open').attr('aria-hidden', 'false');
            // 抽屉内容由 js/potato-im.js 原生渲染（首次 open 时才拉联系人 / 连 WS）
            try {
                if (window.PotatoIM) { window.PotatoIM.open(); }
            } catch (err) { /* 面板挂了也不影响抽屉开关 */ }
        }
        close();                                // 抽屉打开时收掉小气泡，别两处抢注意力
    }

    function closeIm() {
        if (!$im || !$im.length || !imOpen) { return; }
        imOpen = false;
        $im.removeClass('is-open').attr('aria-hidden', 'true');
        if ($imPill && $imPill.length) { $imPill.attr('hidden', 'hidden'); }
    }

    /** 最小化：收起抽屉，右侧留一个「员工IM」胶囊，点它恢复 */
    function minimizeIm() {
        if (!$im || !$im.length || !imOpen) { return; }
        imOpen = false;
        $im.removeClass('is-open').attr('aria-hidden', 'true');
        if ($imPill && $imPill.length) { $imPill.removeAttr('hidden'); }
    }

    function restoreIm() { openIm(); }

    function isMinimized() {
        return !!($imPill && $imPill.length && !$imPill.is('[hidden]'));
    }

    function toggleIm() { if (imOpen) { closeIm(); } else { openIm(); } }

    /** 气泡默认在土豆上方；贴近顶部时翻到下方，贴近左侧时改成左对齐，避免跑出屏幕 */
    function placeBubble() {
        var r = $fab[0].getBoundingClientRect();
        var vp = viewport();
        var bh = $bubble[0].offsetHeight || BUBBLE_H;
        var bw = $bubble[0].offsetWidth || BUBBLE_W;
        $bubble.removeClass('is-below is-align-left');
        if (r.top - bh - 12 < MARGIN) { $bubble.addClass('is-below'); }
        if (r.right - bw < MARGIN) { $bubble.addClass('is-align-left'); }
    }

    function hop() {
        if (!$btn) { return; }
        $btn.addClass('is-happy');
        if (happyTimer) { clearTimeout(happyTimer); }
        happyTimer = setTimeout(function () {
            $btn.removeClass('is-happy');
            happyTimer = null;
        }, 620);
    }

    /* ------------------------------ 拖动 ------------------------------ */

    // 透明遮罩：主框架右侧是 iframe，指针一旦移到 iframe 上，父页面就收不到 mousemove，
    // 拖动会「拖到一半卡住、松手也不收尾」。拖动期间铺一层全屏遮罩接住事件即可。
    function ensureShield() {
        if ($shield && $shield.length) { return $shield; }
        $shield = $('<div class="potato-drag-shield" aria-hidden="true"></div>').appendTo(document.body);
        return $shield;
    }

    function showShield(on) {
        if (on) { ensureShield().addClass('is-on'); }
        else if ($shield) { $shield.removeClass('is-on'); }
    }

    function pointOf(e) {
        var oe = e.originalEvent || e;
        var t = (oe.touches && oe.touches[0]) || (oe.changedTouches && oe.changedTouches[0]);
        if (t) { return { x: t.clientX, y: t.clientY }; }
        if (typeof oe.clientX === 'number') { return { x: oe.clientX, y: oe.clientY }; }
        return null;
    }

    function onPress(e) {
        var pt = pointOf(e);
        if (!pt) { return; }
        pressing = true;
        dragging = false;
        startX = pt.x;
        startY = pt.y;
        var r = $fab[0].getBoundingClientRect();
        grabDX = pt.x - r.left;
        grabDY = pt.y - r.top;
    }

    function onDragMove(e) {
        if (!pressing) { return; }
        var pt = pointOf(e);
        if (!pt) { return; }
        if (!dragging) {
            if (Math.abs(pt.x - startX) < DRAG_MIN && Math.abs(pt.y - startY) < DRAG_MIN) { return; }
            dragging = true;
            close();                                  // 开始拖动就收起气泡
            $fab.addClass('is-dragging');
            showShield(true);                         // 盖住 iframe，别把事件丢给它
        }
        applyPos(pt.x - grabDX, pt.y - grabDY);
        if (e.preventDefault) { e.preventDefault(); }  // 拖的时候别选中文字 / 别滚动
    }

    function onRelease() {
        if (!pressing) { return; }
        pressing = false;
        if (dragging) {
            dragging = false;
            $fab.removeClass('is-dragging');
            showShield(false);
            savePos();
            lastDragEnd = (new Date()).getTime();
        }
    }

    function onKeyDown(e) {
        var step = e.shiftKey ? 24 : 8, dx = 0, dy = 0;
        if (e.keyCode === 37) { dx = -step; }
        else if (e.keyCode === 39) { dx = step; }
        else if (e.keyCode === 38) { dy = -step; }
        else if (e.keyCode === 40) { dy = step; }
        else { return; }
        e.preventDefault();
        ensurePos();
        applyPos(pos.left + dx, pos.top + dy);
        savePos();
    }

    /* ------------------------------ 绑定 ------------------------------ */

    // 脚本在 body 末尾，按钮已在 DOM 里，直接绑即可（不依赖 jQuery ready 的异步时机）
    function bind() {
        $ = window.jQuery;
        $fab = $('#potatoFab');
        if (!$fab.length) { return false; }
        $btn = $('#potatoFabBtn');
        $bubble = $('#potatoBubble');
        $text = $('#potatoBubbleText');
        $close = $('#potatoBubbleClose');

        $im = $('#potatoIm');
        $imClose = $('#potatoImClose');
        $imMin = $('#potatoImMin');
        $imPill = $('#potatoImPill');

        // 恢复上次拖到的位置（先夹一次，防止上次在小窗口里拖的坐标到大窗口外）
        var saved = readSavedPos();
        if (saved) { applyPos(saved.left, saved.top); }

        $btn.on('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var now = (new Date()).getTime();
            // 刚拖动完的那次 click 不算点击（鼠标松开时浏览器也会补一个 click）
            if (now - lastDragEnd < 300) { return; }
            // 双击（两次 click 间隔 < 300ms）→ 开关右侧「即时对话」抽屉；单击 → 小气泡
            if (now - lastClickAt < 300) {
                lastClickAt = 0;
                toggleIm();
                return;
            }
            lastClickAt = now;
            toggle();
            hop();
        });

        if ($imMin.length) {
            $imMin.on('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                minimizeIm();
            });
        }
        if ($imPill.length) {
            $imPill.on('click', function (e) {
                e.preventDefault();
                restoreIm();
            });
        }
        if ($imClose.length) {
            $imClose.on('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                closeIm();
            });
        }

        $close.on('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            close();
        });

        // 点气泡本身不算「点空白」，避免刚打开就被关掉
        $bubble.on('click', function (e) { e.stopPropagation(); });

        // 鼠标拖动：按下在按钮上，移动/松手挂在 document（拖出按钮也不断）
        $btn.on('mousedown', onPress);
        $btn.on('touchstart', onPress);
        $(document).on('mousemove.apppotato', onDragMove);
        $(document).on('mouseup.apppotato', onRelease);
        $(document).on('touchmove.apppotato', onDragMove);
        $(document).on('touchend.apppotato', onRelease);
        $(document).on('touchcancel.apppotato', onRelease);
        // 鼠标在浏览器外松开（切窗口）也要收尾，否则遮罩和抓手光标会一直挂着
        $(window).on('blur.apppotato', onRelease);
        $btn.on('keydown', onKeyDown);

        // 触屏：拖动时阻止页面跟着滚（document 级 touchmove 默认是被动的，必须显式关掉）
        if (document.addEventListener) {
            try {
                document.addEventListener('touchmove', function (e) {
                    if (dragging) { e.preventDefault(); }
                }, { passive: false });
            } catch (err) { /* 老浏览器不支持对象参数：忽略，最多拖动时轻微滚动 */ }
        }

        // 窗口尺寸变化后把土豆重新夹回视口内
        $(window).on('resize.apppotato', function () {
            if (pos.left !== null) { applyPos(pos.left, pos.top); }
        });

        $(document).on('click.apppotato', function () { close(); });
        $(document).on('keydown.apppotato', function (e) {
            if (e.keyCode !== 27) { return; }
            // 逐层退出：弹窗 → 即时对话小窗 → 抽屉 → 小气泡
            try {
                if (window.PotatoIM && window.PotatoIM.isModalOpen && window.PotatoIM.isModalOpen()) {
                    window.PotatoIM.closeModal();
                    return;
                }
                if (window.PotatoIM && window.PotatoIM.isChatOpen && window.PotatoIM.isChatOpen()) {
                    window.PotatoIM.closeChat();
                    return;
                }
            } catch (err) { /* 忽略 */ }
            if (imOpen) { closeIm(); } else { close(); }
        });
        return true;
    }

    function init() {
        if (!window.jQuery) { return; }
        if (bind()) { return; }
        // 万一按钮晚于脚本渲染，再等一次 DOM 就绪
        if (document.addEventListener) {
            document.addEventListener('DOMContentLoaded', function () {
                if (window.jQuery) { bind(); }
            }, false);
        }
    }

    init();

    return {
        open: open,
        close: close,
        toggle: toggle,
        isOpen: isOpen,
        openIm: openIm,
        closeIm: closeIm,
        toggleIm: toggleIm,
        minimizeIm: minimizeIm,
        restoreIm: restoreIm,
        isMinimized: isMinimized,
        isImOpen: isImOpen,
        resetPosition: resetPosition
    };
})();
