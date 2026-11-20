/* ==========================================================================
   login.js —— 用户登录页
   --------------------------------------------------------------------------
   · 账号 = useinfo.account（默认员工手机号），密码由服务端用 MD5 校验
   · 运算表达式验证码：进入页面即取一题（点击算式可换题），提交时把 captchaId + 计算结果一并带上；
     服务端校验即作废（一次性），因此每次登录失败都会自动换一题并清空输入
   · **进入登录页即清空上一个账号的浏览器痕迹**（不判断登录态是否还有效）：
       - localStorage 的登录态 menu_admin_login_v1（token + 用户信息）删除 → 不会带着旧会话直接进系统；
       - sessionStorage 整片清空（各页面的检索条件、选中行、上次停留页都是上一个账号留下的）；
       - 登录成功后的回跳地址一律**丢掉 #hash**，只回系统首页，不会回到上一个账号的操作页。
   · 登录成功：把 {token, time, expireTime, expireAt, ttlHours, user} 写入 localStorage
             （键 menu_admin_login_v1，默认 8 小时有效），再跳回 redirect 参数指定的页面（默认 main.html）
             —— 这份登录态被 main.html 与所有 iframe 子页共享（单点登录）
   · **系统品牌取自系统参数表**：图标 / 中文名 / 英文名 = syspara 的 app_ico / app_name / app_ennme，
     走免登录接口 GET /api/auth/brand（只回这三个键）；取不到时保留页面默认文案（见 applyBrand）。
   · **地址栏一律干净**：框架页/子页把用户送回本页时固定跳 login.html，不带 redirect= / expired= 之类参数。
     需要「登录已超时」这句提示时，跳转方先在 sessionStorage 写标记 menu_admin_auth_expired，本页读一次即删。
   · 登录失败：红字提示服务端返回的 message，并聚焦到需要重新填写的字段
   · **忘记密码**（登录按钮下方的「忘记密码？」）：输入员工信息里登记的邮箱 → 系统用「当前启用的
     服务信箱」发一封带 6 位验证码的邮件（5 分钟有效、同一邮箱 60 秒只能发一次）→ 填验证码 + 新密码
     → 重置成功后系统再把**新密码**发到该邮箱，用户用新密码登录（旧的登录态已被服务端作废）。
   ========================================================================== */
jQuery(function ($) {
    var SESSION_KEY = 'menu_admin_login_v1';
    var EXPIRED_MARK = 'menu_admin_auth_expired';   // 跳转方留下的「因超时被踢回」标记（sessionStorage）
    var $account = $('#loginAccount');
    var $password = $('#loginPassword');
    var $captcha = $('#loginCaptcha');
    var $expr = $('#captchaExpr');
    var $error = $('#loginError');
    var $btn = $('#btnLogin');
    var submitting = false;
    var captchaId = '';
    var loadingCaptcha = false;

    /** 回跳地址：redirect 参数只允许站内相对页面，避免被利用跳去外站；
     *  并**丢弃 #hash** —— 上一个账号可能停在某个操作页（main.html#mail.html），
     *  登录后一律回到系统首页，绝不能直接落进别人的操作页。 */
    function redirectTarget() {
        var raw = '';
        try {
            var m = /[?&]redirect=([^&]*)/.exec(window.location.search || '');
            if (m) { raw = decodeURIComponent(m[1]); }
        } catch (e) { raw = ''; }
        raw = String(raw || '').replace(/^\/+/, '').split('#')[0];
        if (!raw || /^[a-z]+:/i.test(raw) || raw.indexOf('//') === 0 || raw.indexOf('..') > -1) {
            return 'main.html';
        }
        return raw;
    }
    function clearSession() {
        try { window.localStorage.removeItem(SESSION_KEY); } catch (e) { }
    }
    /**
     * 清空上一个账号在浏览器里留下的痕迹（每次进入登录页都执行，不做「是否有效」判断）
     *  · localStorage：menu_admin_login_v1（token + 用户信息），顺带清早期版本可能残留的同类键
     *  · sessionStorage：整片清空（检索条件 / 选中行 / 停留页等页面级状态）
     *  · 只清「账号相关」，不动主题、侧栏折叠等与账号无关的本地偏好
     */
    function wipePreviousAccount() {
        clearSession();
        try {
            window.localStorage.removeItem('menu_admin_login');
            window.localStorage.removeItem('menu_admin_token');
            window.localStorage.removeItem('menu_admin_last_page');
        } catch (e) { /* 隐私模式下忽略 */ }
        try { window.sessionStorage.clear(); } catch (e) { /* 忽略 */ }
    }
    function showError(text) {
        $error.text(text || '');
    }
    /** 跳转方留下的标记（sessionStorage）：'1' = 登录超时被踢回；'pwd' = 刚自助改完密码；
     *  旧链接的 ?expired=1 仍然兼容。
     *  ⚠ 必须在 wipePreviousAccount() 之前取 —— 它会把 sessionStorage 整片清空。 */
    function takeExpiredMark() {
        var mark = '';
        try { mark = String(window.sessionStorage.getItem(EXPIRED_MARK) || ''); } catch (e) { }
        if (/[?&]expired=1/.test(String(window.location.search || ''))) { mark = '1'; }
        try { window.sessionStorage.removeItem(EXPIRED_MARK); } catch (e) { }
        return mark;
    }

    /* ---------------- 验证码 ---------------- */
    function loadCaptcha() {
        if (loadingCaptcha) { return; }
        loadingCaptcha = true;
        $expr.text('加载中…');
        Api.auth.captcha().done(function (data) {
            captchaId = (data && data.captchaId) || '';
            $expr.text((data && data.question) || '获取失败');
        }).fail(function (err) {
            captchaId = '';
            $expr.text('获取失败，点击重试');
            showError((err && err.message) || '验证码获取失败');
        }).always(function () {
            loadingCaptcha = false;
        });
    }

    /* ---------------- 系统品牌：取自系统参数表 ----------------
       图标 / 中文名 / 英文名都来自 syspara（app_ico / app_name / app_ennme），
       走**免登录**接口 GET /api/auth/brand（后端只回这三个键，不暴露其它系统参数）。
       某个键没配就保留页面上的默认文案 / 默认图标，不会出现空白。 */
    function iconMimeOf(url) {
        var ext = String(url || '').split('?')[0].split('#')[0].split('.').pop().toLowerCase();
        if (ext === 'png') { return 'image/png'; }
        if (ext === 'jpg' || ext === 'jpeg') { return 'image/jpeg'; }
        if (ext === 'gif') { return 'image/gif'; }
        if (ext === 'ico') { return 'image/x-icon'; }
        if (ext === 'webp') { return 'image/webp'; }
        return 'image/svg+xml';
    }
    function applyBrand() {
        if (!window.Api || !Api.auth || !Api.auth.brand) { return; }
        Api.auth.brand().done(function (brand) {
            brand = brand || {};
            var name = $.trim(brand.app_name || '');
            var en = $.trim(brand.app_ennme || '');
            var ico = $.trim(brand.app_ico || '');
            if (name) {
                $('#loginSysName').text(name);
                $('#loginFootName').text(name);      // 底栏只换系统名，装饰文案保留
                document.title = '登录 - ' + name;
            }
            if (en) {
                /* 展示效果统一大写：由 css/app.css 的 .login-brand__en { text-transform: uppercase } 保证，
                   这里原样写参数值（参数表里怎么配就存什么） */
                $('#loginSysNameEn').text(en);
            }
            if (ico) {
                $('#loginSysLogo').attr('src', ico).attr('alt', name || 'logo');
                $('#loginFavicon').attr('href', ico).attr('type', iconMimeOf(ico));
            }
        });
    }

    // 进入登录页 = 从零开始：先清空上一个账号留下的登录态与页面状态，再显示表单。
    // （不再「有登录态就直接进系统」——否则换账号时会被上一个账号的会话直接带进他的操作页。）
    var authMark = takeExpiredMark();            // '1' 超时 / 'pwd' 自助改密 / '' 主动退出（要在清空 sessionStorage 之前读）
    var cameFromExpired = !!authMark;            // 兼容既有命名：是否因登录态失效被送回本页
    wipePreviousAccount();

    applyBrand();
    loadCaptcha();
    if (authMark === 'pwd') { showError('密码已修改，请用新的登录密码重新登录'); }
    else if (cameFromExpired) { showError('登录已超时（有效期 8 小时），请重新登录'); }
    $account.trigger('focus');

    $('#captchaBoard').on('click', function () {
        $captcha.val('');
        showError('');
        loadCaptcha();
        $captcha.trigger('focus');
    });

    function submit() {
        if (submitting) { return; }
        var account = $.trim($account.val());
        var password = $password.val();
        var code = $.trim($captcha.val());
        showError('');
        if (!account) {
            showError('请输入登录账号');
            $account.trigger('focus');
            return;
        }
        if (!password) {
            showError('请输入登录密码');
            $password.trigger('focus');
            return;
        }
        if (!code) {
            showError('请输入验证码计算结果');
            $captcha.trigger('focus');
            return;
        }
        if (!captchaId) {
            showError('验证码已失效，请点击图形换一题');
            loadCaptcha();
            return;
        }
        submitting = true;
        $btn.prop('disabled', true).text('登录中…');
        Api.auth.login({
            account: account, password: password,
            captchaId: captchaId, captchaCode: code
        }).done(function (data) {
            try {
                // 单点登录：一次登录签发一个 token，有效期默认 8 小时（服务端 expireIn 为准）
                var ttlHours = Number((data && data.ttlHours) || 8);
                var expireIn = Number((data && data.expireIn) || (ttlHours * 3600));
                window.localStorage.setItem(SESSION_KEY, JSON.stringify({
                    token: (data && data.token) || '',
                    time: (data && data.loginTime) || '',
                    expireTime: (data && data.expireTime) || '',
                    expireAt: new Date().getTime() + Math.round(expireIn * 1000),
                    ttlHours: ttlHours,
                    user: (data && data.user) || {}
                }));
            } catch (e) { /* 隐私模式下忽略：仍允许本次跳转 */ }
            $btn.text('登录成功，正在进入…');
            $error.css('color', '#67c23a').text('登录成功，正在进入系统…');
            window.location.replace(redirectTarget());
        }).fail(function (err) {
            submitting = false;
            $btn.prop('disabled', false).text('登 录');
            showError((err && err.message) || '登录失败，请稍后重试');
            // 验证码一次性：失败后换题并清空，防止重放
            $captcha.val('');
            loadCaptcha();
            $password.trigger('focus').trigger('select');
        });
    }

    $btn.on('click', submit);
    $('#loginForm').on('keydown', 'input', function (e) {
        if (e.keyCode === 13) { submit(); }
    });
    $account.add($password).add($captcha).on('input', function () {
        if ($error.text()) { showError(''); }
    });

    /* ========================================================================
       忘记密码：输入「员工信息里登记的邮箱」→ 服务信箱发 6 位验证码
                 → 填验证码 + 新密码 → 重置成功（新密码会回发到该邮箱）
       ======================================================================== */
    var $mask = $('#forgotMask');
    var $fEmail = $('#forgotEmail');
    var $fCode = $('#forgotCode');
    var $fPwd = $('#forgotPwd');
    var $fPwd2 = $('#forgotPwd2');
    var $fError = $('#forgotError');
    var $sendBtn = $('#btnSendCode');
    var $resetBtn = $('#btnResetPwd');
    var sending = false;
    var resetting = false;
    var countdown = 0;
    var countTimer = null;
    var codeSentTo = '';        // 验证码发往哪个邮箱（换了邮箱必须重新发）

    function showForgotError(text, ok) {
        $fError.text(text || '').css('color', ok ? '#67c23a' : '');
    }
    function stopCountdown() {
        if (countTimer) { window.clearInterval(countTimer); countTimer = null; }
    }
    function startCountdown(seconds) {
        stopCountdown();
        countdown = seconds;
        $sendBtn.prop('disabled', true).text(countdown + ' 秒后重发');
        countTimer = window.setInterval(function () {
            countdown -= 1;
            if (countdown <= 0) {
                stopCountdown();
                $sendBtn.prop('disabled', false).text('发送验证码');
            } else {
                $sendBtn.text(countdown + ' 秒后重发');
            }
        }, 1000);
    }
    function openForgot() {
        showForgotError('');
        $mask.prop('hidden', false).addClass('is-show');
        // 账号框里如果填的是邮箱，直接带过来，省得再敲一遍
        var account = $.trim($account.val());
        if (!$fEmail.val() && account.indexOf('@') > -1) { $fEmail.val(account); }
        window.setTimeout(function () { $fEmail.trigger('focus'); }, 30);
    }
    function closeForgot() {
        $mask.prop('hidden', true).removeClass('is-show');
        $account.trigger('focus');
    }
    $('#btnForgot').on('click', openForgot);
    $('#forgotClose').on('click', closeForgot);
    $mask.on('click', function (e) {
        if (e.target === this) { closeForgot(); }
    });
    $(document).on('keydown', function (e) {
        if (e.keyCode === 27 && !$mask.prop('hidden')) { closeForgot(); }
    });

    function sendCode() {
        if (sending || countdown > 0) { return; }
        var email = $.trim($fEmail.val());
        showForgotError('');
        if (!email) {
            showForgotError('请输入登记的邮箱');
            $fEmail.trigger('focus');
            return;
        }
        if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(email)) {
            showForgotError('邮箱格式不正确，请填写形如 name@example.com 的邮箱');
            $fEmail.trigger('focus');
            return;
        }
        sending = true;
        $sendBtn.prop('disabled', true).text('发送中…');
        Api.auth.sendcode(email).done(function (data) {
            sending = false;
            codeSentTo = email.toLowerCase();
            var tip = '验证码已发送到 ' + ((data && data.emailMask) || email) + '，请查收邮箱（5 分钟内有效）';
            if (data && data.debugCode) { tip += '（离线演示验证码：' + data.debugCode + '）'; }
            showForgotError(tip, true);
            startCountdown(60);
            $fCode.trigger('focus');
        }).fail(function (err) {
            sending = false;
            $sendBtn.prop('disabled', false).text('发送验证码');
            showForgotError((err && err.message) || '验证码发送失败，请稍后重试');
        });
    }

    function doReset() {
        if (resetting) { return; }
        var email = $.trim($fEmail.val());
        var code = $.trim($fCode.val());
        var pwd = $fPwd.val();
        var pwd2 = $fPwd2.val();
        showForgotError('');
        if (!email) { showForgotError('请输入登记的邮箱'); $fEmail.trigger('focus'); return; }
        if (!code) { showForgotError('请输入邮箱验证码'); $fCode.trigger('focus'); return; }
        if (!/^\d{6}$/.test(code)) { showForgotError('邮箱验证码是 6 位数字'); $fCode.trigger('focus'); return; }
        if (!pwd) { showForgotError('请输入新密码'); $fPwd.trigger('focus'); return; }
        if (pwd.length < 6) { showForgotError('新密码至少 6 位'); $fPwd.trigger('focus'); return; }
        if (pwd !== pwd2) { showForgotError('两次输入的新密码不一致'); $fPwd2.trigger('focus'); return; }
        resetting = true;
        $resetBtn.prop('disabled', true).text('重置中…');
        Api.auth.resetbyemail({ email: email, code: code, newPassword: pwd }).done(function (data) {
            resetting = false;
            $resetBtn.prop('disabled', false).text('重置密码');
            var masked = (data && data.emailMask) || email;
            if (data && data.mailed === false) {
                showForgotError('密码已重置，但新密码邮件发送失败（' + ((data && data.message) || '邮箱不可用') +
                    '），请联系系统管理员获取新密码');
            } else {
                showForgotError('密码已重置，新密码已发送到 ' + masked + '，请查收后用新密码登录', true);
            }
            $fCode.val('');
            $fPwd.val('');
            $fPwd2.val('');
            $account.val((data && data.account) || email);
            $password.val('').trigger('focus');
            window.setTimeout(closeForgot, 2200);
        }).fail(function (err) {
            resetting = false;
            $resetBtn.prop('disabled', false).text('重置密码');
            showForgotError((err && err.message) || '重置失败，请稍后重试');
        });
    }
    $sendBtn.on('click', sendCode);
    $resetBtn.on('click', doReset);
    $mask.on('keydown', 'input', function (e) {
        if (e.keyCode === 13) { doReset(); }
    });
    $fEmail.add($fCode).add($fPwd).add($fPwd2).on('input', function () {
        if ($fError.text() && !/已发送到|已重置/.test($fError.text())) { showForgotError(''); }
    });
});
