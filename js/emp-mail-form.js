/* ==========================================================================
   emp-mail-form.js —— 「我的邮箱」个人信箱设置弹窗
   --------------------------------------------------------------------------
   与 service-email-form.js 的区别：
     · serviceemail 是全系统单例表，这里**每个员工一条自己的配置**，保存走 /empmail/save；
     · 多了「自动收件」开关（autoSync）：开启后后台线程每 5 分钟用 IMAP 自动拉取本人信箱，
       页面打开时也会先自动收一次；关闭则只能点「收件」手动拉取；
     · 归属员工由后端按登录 token 反查，表单里**没有也不需要 empId 字段**，前端改不了。
   用法：EmpMailForm.open({ status: Api.empMail.status() 的返回, onSaved: fn })
   ========================================================================== */
(function (window, $) {
    'use strict';

    var RE_EMAIL = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
    var TIP_ADD = '加密存储、接口不返回；编辑时留空表示不修改';

    function formHtml() {
        return '' +
            '<form class="el-form se-form em-form" id="emForm" autocomplete="off" onsubmit="return false;">' +
                '<div class="em-form__notice">这里配置的是<b>您本人的邮箱</b>，历史邮件只有您自己能看到；' +
                    '开启「自动收件」后系统会定期自动收取该信箱的新邮件。</div>' +
                '<div class="el-form-item is-required" data-field="email">' +
                    '<label class="el-form-item__label" for="efEmail">邮箱地址</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input"><input class="el-input__inner" type="text" id="efEmail"' +
                            ' maxlength="120" autocomplete="off" name="em-email-new"' +
                            ' placeholder="已带入员工信息表邮箱，可修改"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item is-required" data-field="password">' +
                    '<label class="el-form-item__label" for="efPassword">密码 / 授权码</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input"><input class="el-input__inner" type="password" id="efPassword"' +
                            ' maxlength="120" autocomplete="new-password" name="em-password-new"' +
                            ' placeholder="邮箱密码或客户端授权码"></div>' +
                        '<div class="form-tip" id="efPasswordTip">' + TIP_ADD + '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="displayName">' +
                    '<label class="el-form-item__label" for="efDisplay">发件人名称</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input"><input class="el-input__inner" type="text" id="efDisplay"' +
                            ' maxlength="80" placeholder="留空取邮箱前缀"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="enabled">' +
                    '<label class="el-form-item__label" for="efEnabled">启用状态</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input">' +
                            '<select class="el-input__inner" id="efEnabled">' +
                                '<option value="1">启用（可收发邮件）</option>' +
                                '<option value="0">停用</option>' +
                            '</select>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="autoSync">' +
                    '<label class="el-form-item__label" for="efAutoSync">自动收件</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input">' +
                            '<select class="el-input__inner" id="efAutoSync">' +
                                '<option value="1">开启（后台每 5 分钟自动收取）</option>' +
                                '<option value="0">关闭（仅手动收件）</option>' +
                            '</select>' +
                        '</div>' +
                        '<div class="form-tip">开启后打开本页也会立即自动收一次；关闭不影响已收到的历史邮件</div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="useSsl">' +
                    '<label class="el-form-item__label" for="efSsl">连接加密</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input">' +
                            '<select class="el-input__inner" id="efSsl">' +
                                '<option value="1">SSL（默认端口 465 / 993）</option>' +
                                '<option value="0">STARTTLS（默认端口 587）</option>' +
                            '</select>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="imapHost">' +
                    '<label class="el-form-item__label" for="efImapHost">收件服务器</label>' +
                    '<div class="el-form-item__content se-adv-row">' +
                        '<div class="el-input"><input class="el-input__inner" type="text" id="efImapHost"' +
                            ' placeholder="收件服务器，如 imap.example.com"></div>' +
                        '<div class="el-input se-adv-port"><input class="el-input__inner" type="text"' +
                            ' id="efImapPort" placeholder="993"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="smtpHost">' +
                    '<label class="el-form-item__label" for="efSmtpHost">发件服务器</label>' +
                    '<div class="el-form-item__content se-adv-row">' +
                        '<div class="el-input"><input class="el-input__inner" type="text" id="efSmtpHost"' +
                            ' placeholder="发件服务器，如 smtp.example.com"></div>' +
                        '<div class="el-input se-adv-port"><input class="el-input__inner" type="text"' +
                            ' id="efSmtpPort" placeholder="465"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="remark">' +
                    '<label class="el-form-item__label" for="efRemark">备注</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input"><input class="el-input__inner" type="text" id="efRemark"' +
                            ' maxlength="200" placeholder="选填"></div>' +
                    '</div>' +
                '</div>' +
            '</form>';
    }

    /** 把 status 回填进表单（未配置时：邮箱预填员工信息表邮箱，密码一律置空） */
    function fill($f, status) {
        var s = status || {};
        var configured = !!s.configured;
        // 首次配置：帐号 / 密码不带入任何默认值——邮箱预填员工信息表(empinfos)里的邮箱（可改），密码留空
        $f.find('#efEmail').val(configured ? (s.email || '') : (s.suggestEmail || ''));
        $f.find('#efPassword').val('');
        if (configured && s.hasPassword) {
            $f.find('#efPassword').attr('placeholder', '留空表示不修改（已保存密码）');
            $f.find('#efPasswordTip')
                .text('当前已保存密码 / 授权码（' + (s.passwordMask || '******') + '），留空不修改')
                .css('color', '#909399');
        }
        $f.find('#efDisplay').val(s.displayName || '');
        $f.find('#efEnabled').val(s.enabled === false ? '0' : '1');
        $f.find('#efAutoSync').val(s.autoSync === false ? '0' : '1');
        $f.find('#efSsl').val(s.useSsl === false ? '0' : '1');
        $f.find('#efRemark').val(s.remark || '');
        $f.find('#efImapHost').val(s.imapHost || '');
        $f.find('#efImapPort').val(s.imapPort || '');
        $f.find('#efSmtpHost').val(s.smtpHost || '');
        $f.find('#efSmtpPort').val(s.smtpPort || '');
    }

    function portOf($f, id, label) {
        var text = $.trim($f.find(id).val());
        if (!text) { return ''; }
        if (!/^\d+$/.test(text) || parseInt(text, 10) < 1 || parseInt(text, 10) > 65535) {
            UI.message({ type: 'warning', message: label + '端口应为 1-65535 的数字' });
            return null;
        }
        return text;
    }

    function open(opt) {
        var o = $.extend({ status: null, onSaved: null }, opt || {});
        var configured = !!(o.status && o.status.configured);
        var $form = $(formHtml());
        UI.dialog({
            title: configured ? '我的邮箱设置' : '配置我的邮箱',
            width: 560, content: $form,
            onReady: function ($body) {
                var $f = $body.find('.em-form');
                $body.closest('.el-dialog').find('.btn-ok').text('保存');
                fill($f, o.status);
                $f.find('#efEmail').trigger('focus');
            },
            onOk: function ($body, close) {
                var $f = $body.find('.em-form');
                var email = $.trim($f.find('#efEmail').val()).toLowerCase();
                var password = $f.find('#efPassword').val() || '';
                if (!email) { UI.message({ type: 'warning', message: '请填写邮箱地址' }); return; }
                if (!RE_EMAIL.test(email)) {
                    UI.message({ type: 'warning', message: '邮箱地址格式不正确' });
                    return;
                }
                if (!configured && !password) {
                    UI.message({ type: 'warning', message: '请填写邮箱密码或授权码' });
                    return;
                }
                var imapPort = portOf($f, '#efImapPort', '收件');
                if (imapPort === null) { return; }
                var smtpPort = portOf($f, '#efSmtpPort', '发件');
                if (smtpPort === null) { return; }
                var data = {
                    email: email,
                    password: password,
                    displayName: $.trim($f.find('#efDisplay').val()),
                    enabled: $f.find('#efEnabled').val() === '1' ? 1 : 0,
                    autoSync: $f.find('#efAutoSync').val() === '1' ? 1 : 0,
                    useSsl: $f.find('#efSsl').val() === '1' ? 1 : 0,
                    imapHost: $.trim($f.find('#efImapHost').val()),
                    imapPort: imapPort,
                    smtpHost: $.trim($f.find('#efSmtpHost').val()),
                    smtpPort: smtpPort,
                    remark: $.trim($f.find('#efRemark').val())
                };
                var $ok = $body.closest('.el-dialog').find('.btn-ok')
                    .prop('disabled', true).text('保存中…');
                Api.empMail.save(data).done(function (saved) {
                    $ok.prop('disabled', false).text('保存');
                    UI.message({ type: 'success', message: configured ? '保存成功' : '配置成功，已开始自动收件' });
                    close();
                    if (o.onSaved) { o.onSaved(saved, configured); }
                }).fail(function (err) {
                    $ok.prop('disabled', false).text('保存');
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    window.EmpMailForm = { build: formHtml, fill: fill, open: open };
})(window, jQuery);
