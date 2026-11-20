/* ==========================================================================
   changepwd.js —— 「修改登录密码」弹窗（全站唯一实现）
   --------------------------------------------------------------------------
   两个入口共用这一份代码，避免校验规则 / 文案 / 跳转方式各写一遍：
     · main.html 顶栏「改密」按钮（js/frame.js → AppChangePwd.open()）
     · 帮助中心 → 修改密码 页（edituserpwd.html → js/edituserpwd.js）
   规则与后端 AuthService.changepwd 一致：
     · 原密码必填且必须正确（后端比对 MD5）
     · 新密码 6~32 位，不能是同一个字符重复（如 111111），不能与原密码相同
     · 成功后服务端作废 token → 本模块清本地登录态 → 回登录页（登录页按
       sessionStorage 标记 menu_admin_auth_expired='pwd' 提示「密码已修改」）
   --------------------------------------------------------------------------
   对外：window.AppChangePwd = { open, MIN_LEN, MAX_LEN }
   open(opt)：opt.appendTo 预留；重复打开时直接复用（已有弹窗就不再叠一层）
   ========================================================================== */
(function (window) {
    'use strict';
    var SESSION_KEY = 'menu_admin_login_v1';
    var EXPIRED_MARK = 'menu_admin_auth_expired';      // 与 frame.js / login.js 同一约定
    var LOGIN_PAGE = 'login.html';
    var MIN_LEN = 6;
    var MAX_LEN = 32;

    function isPwdDialogOpen() {
        var $ = window.jQuery;
        return !!(($ && $('.el-overlay .frame-pwd').length) || ($ && $('#cpOld').length));
    }

    function clearSession() {
        try { window.localStorage.removeItem(SESSION_KEY); } catch (e) { /* 隐私模式忽略 */ }
    }
    /** 告诉登录页「这次不是超时，是改密成功」——登录页读一次即删 */
    function markPwdChanged() {
        try { window.sessionStorage.setItem(EXPIRED_MARK, 'pwd'); } catch (e) { /* 忽略 */ }
    }
    /** 回登录页：页面可能在框架 Tab 的 iframe 里，必须整页替换，不能只换 iframe */
    function gotoLogin() {
        try { window.top.location.replace(LOGIN_PAGE); }
        catch (e) { try { window.location.replace(LOGIN_PAGE); } catch (e2) { /* file:// / jsdom 忽略 */ } }
    }

    /** 前端先过一遍规则，错误直接返回文案；通过返回 ''（后端仍会再校验一次） */
    function validate(oldPwd, newPwd, newPwd2) {
        if (!oldPwd) { return '请输入原密码'; }
        if (!newPwd) { return '请输入新密码'; }
        if (newPwd.length < MIN_LEN) { return '新密码至少 ' + MIN_LEN + ' 位'; }
        if (newPwd.length > MAX_LEN) { return '新密码最多 ' + MAX_LEN + ' 位'; }
        if (newPwd.length && newPwd.split('').every(function (c) { return c === newPwd.charAt(0); })) {
            return '新密码不能是同一个字符重复（如 111111）';
        }
        if (newPwd !== newPwd2) { return '两次输入的新密码不一致'; }
        if (newPwd === oldPwd) { return '新密码不能与原密码相同'; }
        return '';
    }

    function open() {
        var $ = window.jQuery;
        var UI = window.UI;
        if (!$ || !UI || !UI.dialog) { return null; }
        if (isPwdDialogOpen()) { return null; }        // 已经开着：不重复叠层

        var $content = $(
            '<form class="el-form frame-pwd" autocomplete="off" onsubmit="return false;">' +
                '<div class="el-form-item is-required">' +
                    '<label class="el-form-item__label">原密码</label>' +
                    '<div class="el-form-item__content"><div class="el-input">' +
                        '<input class="el-input__inner" type="password" id="cpOld" maxlength="' + MAX_LEN + '" ' +
                            'placeholder="请输入当前登录密码">' +
                    '</div></div>' +
                '</div>' +
                '<div class="el-form-item is-required">' +
                    '<label class="el-form-item__label">新密码</label>' +
                    '<div class="el-form-item__content"><div class="el-input">' +
                        '<input class="el-input__inner" type="password" id="cpNew" maxlength="' + MAX_LEN + '" ' +
                            'placeholder="6~32 位，不能是 111111 这种">' +
                    '</div></div>' +
                '</div>' +
                '<div class="el-form-item is-required">' +
                    '<label class="el-form-item__label">确认新密码</label>' +
                    '<div class="el-form-item__content"><div class="el-input">' +
                        '<input class="el-input__inner" type="password" id="cpNew2" maxlength="' + MAX_LEN + '" ' +
                            'placeholder="请再输入一次新密码">' +
                    '</div></div>' +
                '</div>' +
                '<div class="form-tip">修改成功后当前登录会立即失效，需用新密码重新登录。</div>' +
            '</form>'
        );

        return UI.dialog({
            title: '修改登录密码', width: 460, content: $content,
            onReady: function ($body) {
                $body.find('#cpOld').trigger('focus');
            },
            onOk: function ($body, close) {
                var $f = $body.find('.frame-pwd');
                var oldPwd = String($f.find('#cpOld').val() || '');
                var newPwd = String($f.find('#cpNew').val() || '');
                var newPwd2 = String($f.find('#cpNew2').val() || '');
                var err = validate(oldPwd, newPwd, newPwd2);
                if (err) { UI.message({ type: 'warning', message: err }); return; }

                var $ok = $body.closest('.el-dialog').find('.btn-ok')
                    .prop('disabled', true).text('提交中…');
                window.Api.auth.changepwd({ oldPassword: oldPwd, newPassword: newPwd })
                    .done(function () {
                        close();
                        clearSession();            // 服务端已作废 token，本地登录态一起清掉
                        markPwdChanged();          // 登录页据此提示「密码已修改」
                        try { UI.message({ type: 'success', message: '密码已修改，请用新密码重新登录' }); }
                        catch (e) { /* 提示失败不影响跳转 */ }
                        gotoLogin();
                    })
                    .fail(function (e) {
                        $ok.prop('disabled', false).text('确定');
                        UI.message({ type: 'error', message: (e && e.message) || '修改密码失败' });
                    });
            }
        });
    }

    window.AppChangePwd = { open: open, validate: validate, MIN_LEN: MIN_LEN, MAX_LEN: MAX_LEN };
})(window);
