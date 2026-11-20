/* ==========================================================================
   service-email-form.js —— 服务信箱编辑弹窗（邮箱助手 / 服务信箱设置 两页共用）
   --------------------------------------------------------------------------
   serviceemail 是**单例表**：全表只允许一条记录。
     · 表里没有记录 → 弹窗是「新增服务信箱」，保存走 /serviceemail/add
     · 表里已有记录 → 弹窗是「编辑服务信箱」，保存走 /serviceemail/update（带 id）
   用法（页面里只需引用本文件）：
     ServiceEmailForm.openSingleton({ onSaved: function (saved, isEdit) {} })
        —— 自己查一次接口（pageSize=1）判断该新增还是编辑；邮箱助手右上角「设置」按钮就是这么用的
     ServiceEmailForm.open({ row: rowOrNull, onSaved: fn })
        —— 调用方已经知道是哪一条（服务信箱设置页双击 / 点「编辑」）
   表单约定（与旧版 service-email.html 内的模板完全一致）：
     · 每行只有 label + 录入框，**只有「密码 / 授权码」后面保留一句提示**（加密存储 / 留空不修改）；
     · 收件 / 发件服务器与连接加密直接铺在表单里填写，留空由后端按邮箱域名自动推断。
   ========================================================================== */
(function (window, $) {
    'use strict';

    var RE_EMAIL = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
    var TIP_ADD = '加密存储、接口不返回；编辑时留空表示不修改';

    /** 弹窗表单的 HTML（id 与旧模板保持一致，便于测试与样式复用） */
    function formHtml() {
        return '' +
            '<form class="el-form se-form" id="seForm" autocomplete="off" onsubmit="return false;">' +
                '<div class="el-form-item is-required" data-field="email">' +
                    '<label class="el-form-item__label" for="sfEmail">邮箱地址</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input"><input class="el-input__inner" type="text" id="sfEmail"' +
                            ' maxlength="120" placeholder="如 service@jiudou.com"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item is-required" data-field="password">' +
                    '<label class="el-form-item__label" for="sfPassword">密码 / 授权码</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input"><input class="el-input__inner" type="password" id="sfPassword"' +
                            ' maxlength="120" placeholder="邮箱密码或客户端授权码"></div>' +
                        '<div class="form-tip" id="sfPasswordTip">' + TIP_ADD + '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="displayName">' +
                    '<label class="el-form-item__label" for="sfDisplay">发件人名称</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input"><input class="el-input__inner" type="text" id="sfDisplay"' +
                            ' maxlength="80" placeholder="留空取邮箱前缀"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="enabled">' +
                    '<label class="el-form-item__label" for="sfEnabled">启用状态</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input">' +
                            '<select class="el-input__inner" id="sfEnabled">' +
                                '<option value="1">启用</option>' +
                                '<option value="0">停用</option>' +
                            '</select>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="useSsl">' +
                    '<label class="el-form-item__label" for="sfSsl">连接加密</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input">' +
                            '<select class="el-input__inner" id="sfSsl">' +
                                '<option value="1">SSL（默认端口 465 / 993）</option>' +
                                '<option value="0">STARTTLS（默认端口 587）</option>' +
                            '</select>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="imapHost">' +
                    '<label class="el-form-item__label" for="sfImapHost">收件服务器</label>' +
                    '<div class="el-form-item__content se-adv-row">' +
                        '<div class="el-input"><input class="el-input__inner" type="text" id="sfImapHost"' +
                            ' placeholder="收件服务器，如 imap.example.com"></div>' +
                        '<div class="el-input se-adv-port"><input class="el-input__inner" type="text"' +
                            ' id="sfImapPort" placeholder="993"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="smtpHost">' +
                    '<label class="el-form-item__label" for="sfSmtpHost">发件服务器</label>' +
                    '<div class="el-form-item__content se-adv-row">' +
                        '<div class="el-input"><input class="el-input__inner" type="text" id="sfSmtpHost"' +
                            ' placeholder="发件服务器，如 smtp.example.com"></div>' +
                        '<div class="el-input se-adv-port"><input class="el-input__inner" type="text"' +
                            ' id="sfSmtpPort" placeholder="465"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="el-form-item" data-field="remark">' +
                    '<label class="el-form-item__label" for="sfRemark">备注</label>' +
                    '<div class="el-form-item__content">' +
                        '<div class="el-input"><input class="el-input__inner" type="text" id="sfRemark"' +
                            ' maxlength="200" placeholder="选填"></div>' +
                    '</div>' +
                '</div>' +
            '</form>';
    }

    /** 把一行数据回填进表单（row 为空 = 新增） */
    function fill($f, row) {
        if (!row) {
            // 首次配置默认「启用」：单例表只可能有一条，停用等于系统不能收发邮件
            $f.find('#sfEnabled').val('1');
            $f.find('#sfSsl').val('1');
            return;
        }
        $f.find('#sfEmail').val(row.email || '');
        $f.find('#sfPassword').attr('placeholder', '留空表示不修改（已保存密码）');
        $f.find('#sfPasswordTip')
            .text('当前已保存密码 / 授权码（' + (row.passwordMask || '******') + '），留空不修改')
            .css('color', '#909399');
        $f.find('#sfDisplay').val(row.displayName || '');
        $f.find('#sfEnabled').val(row.enabled ? '1' : '0');
        $f.find('#sfSsl').val(row.useSsl ? '1' : '0');
        $f.find('#sfRemark').val(row.remark || '');
        $f.find('#sfImapHost').val(row.imapHost || '');
        $f.find('#sfImapPort').val(row.imapPort || '');
        $f.find('#sfSmtpHost').val(row.smtpHost || '');
        $f.find('#sfSmtpPort').val(row.smtpPort || '');
    }

    /** 端口：留空允许（后端按服务商默认推断），填了必须 1-65535 */
    function portOf($f, id, label) {
        var text = $.trim($f.find(id).val());
        if (!text) { return ''; }
        if (!/^\d+$/.test(text) || parseInt(text, 10) < 1 || parseInt(text, 10) > 65535) {
            UI.message({ type: 'warning', message: label + '端口应为 1-65535 的数字' });
            return null;
        }
        return text;
    }

    /**
     * 打开弹窗
     * @param {Object} opt { row: 已有记录或 null, onSaved: function (saved, isEdit) {} }
     */
    function open(opt) {
        var o = $.extend({ row: null, onSaved: null }, opt || {});
        var row = o.row || null;
        var isEdit = !!row;
        var $form = $(formHtml());
        UI.dialog({
            title: isEdit ? ('编辑服务信箱 —— ' + (row.email || '')) : '新增服务信箱',
            width: 560, content: $form,
            onReady: function ($body) {
                var $f = $body.find('.se-form');
                $body.closest('.el-dialog').find('.btn-ok').text('保存');
                fill($f, row);
                $f.find('#sfEmail').trigger('focus');
            },
            onOk: function ($body, close) {
                var $f = $body.find('.se-form');
                var email = $.trim($f.find('#sfEmail').val()).toLowerCase();
                var password = $f.find('#sfPassword').val() || '';
                if (!email) { UI.message({ type: 'warning', message: '请填写邮箱地址' }); return; }
                if (!RE_EMAIL.test(email)) {
                    UI.message({ type: 'warning', message: '邮箱地址格式不正确' });
                    return;
                }
                if (!isEdit && !password) {
                    UI.message({ type: 'warning', message: '请填写邮箱密码或授权码' });
                    return;
                }
                var imapPort = portOf($f, '#sfImapPort', '收件');
                if (imapPort === null) { return; }
                var smtpPort = portOf($f, '#sfSmtpPort', '发件');
                if (smtpPort === null) { return; }

                var data = {
                    email: email,
                    password: password,
                    displayName: $.trim($f.find('#sfDisplay').val()),
                    enabled: $f.find('#sfEnabled').val() === '1' ? 1 : 0,
                    useSsl: $f.find('#sfSsl').val() === '1' ? 1 : 0,
                    // 服务器设置直接取自表单；留空则由后端按邮箱域名自动推断
                    imapHost: $.trim($f.find('#sfImapHost').val()),
                    imapPort: imapPort,
                    smtpHost: $.trim($f.find('#sfSmtpHost').val()),
                    smtpPort: smtpPort,
                    remark: $.trim($f.find('#sfRemark').val())
                };
                if (isEdit) { data.id = row.id; }
                var $ok = $body.closest('.el-dialog').find('.btn-ok')
                    .prop('disabled', true).text('保存中…');
                var req = isEdit ? Api.serviceEmail.update(data) : Api.serviceEmail.add(data);
                req.done(function (saved) {
                    $ok.prop('disabled', false).text('保存');
                    UI.message({
                        type: 'success',
                        message: isEdit ? '保存成功'
                            : ('新增成功' + ((saved && saved.enabled) ? '，已启用该服务信箱' : ''))
                    });
                    close();
                    if (o.onSaved) { o.onSaved(saved, isEdit); }
                }).fail(function (err) {
                    $ok.prop('disabled', false).text('保存');
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    /**
     * 先查一次接口拿到「那一条」（有就编辑、没有就新增）再打开弹窗
     * @param {Object} opt { onSaved: function (saved, isEdit) {} }
     */
    function openSingleton(opt) {
        var o = $.extend({ onSaved: null }, opt || {});
        UI.loading($('body'), true, '读取服务信箱配置…');
        Api.serviceEmail.page({ pageNum: 1, pageSize: 1 }).done(function (data) {
            var list = (data && data.list) || [];
            open({ row: list.length ? list[0] : null, onSaved: o.onSaved });
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '服务信箱配置读取失败' });
        }).always(function () { UI.loading($('body'), false); });
    }

    window.ServiceEmailForm = {
        build: formHtml,
        fill: fill,
        open: open,
        openSingleton: openSingleton
    };
})(window, jQuery);
