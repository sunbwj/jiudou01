/* appinfo.js —— 数据中心 · 应用信息（应用 + 绑定数据库连接 1:1） */
jQuery(function ($) {
    var state = {
        keyword: '', appType: '', dbType: '', status: '',
        pageNum: 1, pageSize: 10, total: 0, rows: {}, selectedId: ''
    };
    var meta = null;              // 表单下拉（应用类型 / 环境 / 方言 / 逻辑类型）
    var emps = null;              // 员工清单（负责人下拉，懒加载）
    var $tbody = $('#appTbody');
    var $pager = $('#appPager');

    function esc(t) { return UI.escapeHtml(t == null ? '' : t); }
    function go(url) {
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    }
    function selected() { return state.rows[String(state.selectedId)] || null; }
    function statusTag(row) {
        if (!row.status) { return '<span class="el-tag el-tag--small el-tag--info">停用</span>'; }
        return '<span class="el-tag el-tag--small el-tag--success">启用</span>';
    }

    /* ---------- 多选下拉（应用类型 / 数据库类型） ----------
       结构与项目 / 需求页一致：隐藏 select 存「逗号串」作为唯一取值出口，
       可见按钮显示已选项（超出宽度省略），面板里逐项复选，底部「清空」。 */
    function closeAllMulti() {
        $('.ai-multi').removeClass('is-open')
            .find('.ai-multi__drop').prop('hidden', true)
            .end().find('.ai-multi__box').attr('aria-expanded', 'false');
    }
    function multiValues($m) {
        var vals = [];
        $m.find('.ai-multi__opt input:checked').each(function () { vals.push(String($(this).val())); });
        return vals;
    }
    function syncMulti($m) {
        var labels = [], vals = [];
        $m.find('.ai-multi__opt').each(function () {
            var $opt = $(this);
            if (!$opt.find('input').prop('checked')) { return; }
            vals.push(String($opt.find('input').val()));
            labels.push($.trim($opt.attr('data-label') || $opt.text()));
        });
        var text = labels.length ? labels.join('、') : ($m.attr('data-placeholder') || '全部');
        $m.toggleClass('has-value', labels.length > 0);
        $m.find('.ai-multi__text').text(text).attr('title', text);
        $m.find('.ai-multi__count').text(labels.length ? ('已选 ' + labels.length + ' 项') : '未筛选');
        $('#' + $m.attr('data-select')).val(vals.join(','));
        return vals.join(',');
    }
    function fillMulti($m, list, picked) {
        var html = '', i, one, val, text;
        picked = picked || [];
        for (i = 0; i < (list || []).length; i++) {
            one = list[i] || {};
            val = one.value === undefined ? one.id : one.value;
            text = one.label === undefined ? (one.name || '') : one.label;
            html += '<label class="ai-multi__opt" data-label="' + esc(text) + '">' +
                '<input type="checkbox" value="' + esc(val) + '"' +
                ($.inArray(String(val), picked) >= 0 ? ' checked' : '') + '> ' + esc(text) +
                '</label>';
        }
        $m.find('.ai-multi__list').html(html || '<div class="ai-multi__empty">暂无可选项</div>');
        syncMulti($m);
    }
    function initMulti($m) {
        $m.on('click', '.ai-multi__box', function (e) {
            e.stopPropagation();
            var open = !$m.hasClass('is-open');
            closeAllMulti();
            if (!open) { return; }
            $m.addClass('is-open');
            $m.find('.ai-multi__drop').prop('hidden', false);
            $m.find('.ai-multi__box').attr('aria-expanded', 'true');
        });
        $m.on('click', '.ai-multi__drop', function (e) { e.stopPropagation(); });
        $m.on('change', '.ai-multi__opt input', function () { syncMulti($m); });
        $m.on('click', '.ai-multi__clear', function (e) {
            e.preventDefault();
            e.stopPropagation();
            $m.find('.ai-multi__opt input').prop('checked', false);
            syncMulti($m);
        });
        syncMulti($m);
    }

    function syncToolbar() {
        var row = selected();
        $('#appBtnEdit').prop('disabled', !row);
        $('#appBtnSchema').prop('disabled', !row);
        $('#appBtnEnable').prop('disabled', !row || !!row.status);
        $('#appBtnDisable').prop('disabled', !row || !row.status);
        $('#appBtnDelete').prop('disabled', !row);
    }

    /* ---------- 结果区高度自适应（与需求管理 / 菜单列表同一套口径） ----------
       ① 按表格区可用高度算每页条数（算出来才请求数据，避免多渲染再滚）；
       ② 数据不够一页时把行高均分剩余高度（上限 MAX_ROW_H，别拉成一片大空白）；
       ③ 还不够就补空行，让网格填满卡片、页面不出现纵向滚动条。
       空行按 COLS 逐列渲染（而不是一条 colspan），这样列分隔线与斑马纹都跟着延续，
       看起来才是「空白的表格行」而不是表格下面的一块留白。 */
    var COLS = 12, DEF_ROW_H = 52, MAX_ROW_H = 64;
    var MIN_PAGE_SIZE = 3, MAX_PAGE_SIZE = 100, PAGER_H = 69;
    var autoSize = true, naturalRowH = DEF_ROW_H;

    function isCardMode() { return window.innerWidth <= 768; }
    function isAutoMode() { return autoSize && !isCardMode(); }
    function bodyAvailHeight() {
        var theadH = $('#appTableWrap').find('thead').outerHeight() || 0;
        return ($('#appTableWrap').height() || 0) - theadH;
    }
    function calcPageSize() {
        var avail = bodyAvailHeight() - ($pager.outerHeight() || PAGER_H);
        if (avail <= naturalRowH) { return state.pageSize; }
        var n = Math.floor(avail / naturalRowH);
        if (n < MIN_PAGE_SIZE) { n = MIN_PAGE_SIZE; }
        if (n > MAX_PAGE_SIZE) { n = MAX_PAGE_SIZE; }
        return n;
    }
    /** 一条空行：每列一个空 td（保留列宽与分隔线），高度按需给 */
    function blankRow(height) {
        var $tr = $('<tr class="blank-row"></tr>');
        for (var i = 0; i < COLS; i++) { $tr.append('<td></td>'); }
        if (height) { $tr.children('td').css('height', height + 'px'); }
        return $tr;
    }
    function layoutRows() {
        $tbody.find('tr.blank-row').remove();
        if (isCardMode()) { $tbody.find('tr > td').css('height', ''); return; }
        var avail = bodyAvailHeight();
        if (avail <= 0) { return; }
        var $rows = $tbody.children('tr[data-id]');
        if (!$rows.length) {
            var $empty = $tbody.find('tr.empty-row > td');
            if ($empty.length) { $empty.css('height', avail + 'px'); }
            return;
        }
        $tbody.find('tr > td').css('height', '');
        var naturalH = $rows.first().outerHeight() || DEF_ROW_H;
        naturalRowH = naturalH;
        if (isAutoMode() && naturalH * $rows.length > avail) {
            var size = Math.floor(avail / naturalH);
            if (size >= MIN_PAGE_SIZE && size < $rows.length && size !== state.pageSize) {
                state.pageSize = size;
                state.pageNum = 1;
                loadData();
                return;
            }
        }
        var n = $rows.length;
        /* 拉伸上限：正常行高不超过 MAX_ROW_H（一行一个应用，别拉成一片大空白）；
           内容本身就把行顶到 MAX_ROW_H 以上的（名称两行这类），就以自然行高为上限，
           剩下的高度交给空行补，而不是把这一行拉满整屏 */
        var cap = naturalH > MAX_ROW_H ? naturalH : MAX_ROW_H;
        var rowH = Math.floor(avail / n);
        if (rowH < naturalH) { rowH = naturalH; }
        if (rowH > cap) { rowH = cap; }
        var rest = avail - rowH * n;
        $rows.children('td').css('height', rowH + 'px');
        if (rest <= 0) { return; }
        /* 余量不足半行：均摊给已有行，避免底部留一条细缝 */
        if (rest < rowH * 0.6) {
            var add = Math.floor(rest / n), extra = rest - add * n;
            $rows.children('td').css('height', (rowH + add) + 'px');
            $rows.slice(0, extra).children('td').css('height', (rowH + add + 1) + 'px');
            return;
        }
        /* 余量够一行以上：补空行（数量四舍五入，高度均分，末行不出现突兀的加高） */
        var cnt = Math.round(rest / rowH);
        if (cnt < 1) { cnt = 1; }
        if (cnt > 200) { cnt = 200; }
        var base = Math.floor(rest / cnt), remain = rest - base * cnt;
        for (var i = 0; i < cnt; i++) {
            $tbody.append(blankRow(base + (i < remain ? 1 : 0)));
        }
    }

    /* ---------- 列表 ---------- */
    function loadData() {
        if (isAutoMode()) {
            var auto = calcPageSize();
            if (auto && auto !== state.pageSize) { state.pageSize = auto; }
        }
        UI.loading($('#appTableWrap'), true);
        Api.appInfo.page({
            keyword: state.keyword, appType: state.appType, dbType: state.dbType,
            status: state.status, pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (res) {
            var d = res || {}, list = d.list || [];
            state.total = parseInt(d.total, 10) || 0;
            state.rows = {};
            $('#appCount').text(state.total);
            if (!list.length) {
                $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                    '<span class="el-table__empty-text">还没有应用，点左上角「+」新建一个</span></div></td></tr>');
            } else {
                var html = '', startNo = (state.pageNum - 1) * state.pageSize;
                $.each(list, function (i, r) {
                    state.rows[String(r.id)] = r;
                    var scope = (parseInt(r.dbCount, 10) || 0) + ' 库 / ' + (parseInt(r.objCount, 10) || 0) + ' 对象';
                    html += '<tr data-id="' + esc(r.id) + '"' +
                        (state.selectedId === String(r.id) ? ' class="is-selected"' : '') + '>' +
                        '<td class="is-center">' + (startNo + i + 1) + '</td>' +
                        '<td class="is-center"><input type="radio" name="appPick" value="' + esc(r.id) + '"' +
                            (state.selectedId === String(r.id) ? ' checked' : '') + '></td>' +
                        '<td>' + esc(r.code) + '</td>' +
                        '<td><div class="cell app-name-cell">' + esc(r.name) +
                            (r.shortName ? '<span class="app-name-cell__sub">' + esc(r.shortName) + '</span>' : '') +
                        '</div></td>' +
                        '<td>' + esc(r.appTypeLabel || '—') + '</td>' +
                        '<td>' + esc(r.dbTypeLabel || '—') + '</td>' +
                        '<td class="is-center">' + esc(r.envLabel || '—') + '</td>' +
                        '<td>' + (r.hasConn ? esc(r.connName || '已绑定') : '<span class="app-muted">未绑定</span>') + '</td>' +
                        '<td class="is-center">' + esc(scope) + '</td>' +
                        '<td>' + (r.lastScanTime ? esc(String(r.lastScanTime).slice(0, 16)) : '<span class="app-muted">未扫描</span>') + '</td>' +
                        '<td class="is-center">' + statusTag(r) + '</td>' +
                        '<td class="is-center"><a href="javascript:;" class="app-schema-link" data-id="' +
                            esc(r.id) + '">查看</a></td>' +
                        '</tr>';
                });
                $tbody.html(html);
            }
            if (state.selectedId && !state.rows[state.selectedId]) { state.selectedId = ''; }
            syncToolbar();
            UI.pagination($pager, {
                total: state.total, pageNum: state.pageNum, pageSize: state.pageSize,
                sizes: [10, 20, 50],
                onChange: function (num, size) {
                    if (size !== state.pageSize) { autoSize = false; }
                    state.pageNum = num; state.pageSize = size; loadData();
                }
            });
            window.setTimeout(layoutRows, 30);
        }).fail(function (err) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">' + esc((err && err.message) || '加载失败') + '</span></div></td></tr>');
        }).always(function () { UI.loading($('#appTableWrap'), false); });
    }

    /* ---------- 下拉数据 ---------- */
    function loadMeta() {
        var dfd = $.Deferred();
        if (meta) { dfd.resolve(meta); return dfd.promise(); }
        Api.appInfo.meta().done(function (res) {
            meta = res || {};
            fillMulti($('#appTypeMulti'), meta.appTypes || []);
            fillMulti($('#appDbTypeMulti'), meta.dbTypes || []);
            dfd.resolve(meta);
        }).fail(function (err) {
            dfd.reject(err);
        });
        return dfd.promise();
    }
    function loadEmps() {
        var dfd = $.Deferred();
        if (emps) { dfd.resolve(emps); return dfd.promise(); }
        Api.emp.page({ pageNum: 1, pageSize: 1000 }).done(function (data) {
            emps = (data && data.list) || [];
            dfd.resolve(emps);
        }).fail(function () { emps = []; dfd.resolve(emps); });
        return dfd.promise();
    }
    function fillSelect($sel, list, selected, placeholder) {
        var html = placeholder === null ? '' : '<option value="">' + esc(placeholder || '请选择') + '</option>';
        $.each(list || [], function (i, one) {
            var val = one.value === undefined ? one.id : one.value;
            var text = one.label === undefined ? (one.name || one.nameCn || '') : one.label;
            html += '<option value="' + esc(val) + '">' + esc(text) + '</option>';
        });
        $sel.html(html).val(selected === undefined || selected === null ? '' : String(selected));
    }

    /* 表单模板：第一次取完就把模板节点从 DOM 里摘掉 —— 否则模板和弹窗里会有两份
       同 id 的输入框，document.getElementById / label 的 for 都会指到隐藏的模板上 */
    var formTpl = null;
    function takeTpl(selector) {
        if (formTpl === null) {
            formTpl = $(selector).html() || '';
            $(selector).remove();
        }
        return formTpl;
    }

    /* ---------- 表单 ---------- */
    function openForm(row) {
        var isEdit = !!row;
        var tpl = takeTpl('#appFormTpl');
        UI.dialog({
            title: isEdit ? ('编辑应用 · ' + (row.code || '')) : '新增应用',
            width: 780,
            content: tpl,
            onReady: function ($body, close) {
                var $form = $body.find('#appForm');
                fillSelect($body.find('#afType'), (meta && meta.appTypes) || [], isEdit ? row.appType : 'web', null);
                fillSelect($body.find('#afDbType'), (meta && meta.dbTypes) || [], isEdit ? row.dbType : 'mysql', null);
                fillSelect($body.find('#afEnv'), (meta && meta.envs) || [], isEdit ? row.env : 'dev', null);
                $body.find('#afCode').val(isEdit ? (row.code || '') : '').prop('readonly', true);
                $body.find('#afName').val(isEdit ? (row.name || '') : '');
                $body.find('#afShort').val(isEdit ? (row.shortName || '') : '');
                $body.find('#afDesc').val(isEdit ? (row.description || '') : '');
                $body.find('#afStatus').val(isEdit ? (row.status ? '1' : '0') : '1');
                $body.find('#afIspub').val(isEdit ? (row.ispub ? '1' : '0') : '1');
                if (!isEdit) { $body.find('#afCode').closest('.el-form-item').removeClass('is-required'); }

                /* 取号：编辑态只允许第一次进来自动带出，不允许改 */
                function nextCode() {
                    Api.appInfo.nextcode().done(function (res) {
                        $body.find('#afCode').val((res && res.code) || '');
                    }).fail(function (err) {
                        UI.message({ type: 'error', message: (err && err.message) || '取号失败' });
                    });
                }
                if (!isEdit) { nextCode(); }
                $body.find('#afCodeNew').prop('hidden', isEdit).prop('disabled', isEdit);
                $body.find('#afCodeNew').on('click', nextCode);

                /* 连接下拉：只列「启用 + 可见 + 没被别的应用占用」的连接 */
                Api.appInfo.connections(isEdit ? row.id : '').done(function (res) {
                    var list = (res && res.list) || [], html = '<option value="">不绑定（纯手工维护）</option>';
                    $.each(list, function (i, one) {
                        html += '<option value="' + esc(one.id) + '">' + esc(one.name) +
                            '（' + esc(one.dbTypeLabel || one.dbType) + '）</option>';
                    });
                    $body.find('#afConn').html(html).val(isEdit ? (row.dbConnId || '') : '');
                }).fail(function () {
                    $body.find('#afConn').html('<option value="">不绑定（纯手工维护）</option>');
                });

                loadEmps().done(function (list) {
                    var html = '<option value="">未指定</option>';
                    $.each(list, function (i, one) {
                        html += '<option value="' + esc(one.id) + '">' +
                            esc(one.name || one.nameCn || one.code || '') + '</option>';
                    });
                    $body.find('#afOwner').html(html).val(isEdit ? (row.ownerEmpId || '') : '');
                });

                /* 方言与连接类型不一致时给个黄色提示（后端也会拦） */
                function syncConnTip() {
                    var connId = $body.find('#afConn').val();
                    if (!connId) { $body.find('#afConn').closest('.el-form-item').find('.form-tip').last()
                        .text('一个连接只能挂一个应用；留空表示不扫描，只按手工录入维护结构'); return; }
                    var $opt = $body.find('#afConn option:selected').text();
                    $body.find('#afConn').closest('.el-form-item').find('.form-tip').last()
                        .text('已选：' + $opt + '；应用的数据库类型需与连接类型一致');
                }
                $body.find('#afConn').on('change', syncConnTip);

                $body.find('#afName').on('keydown', function (e) {
                    if (e.keyCode === 13) { e.preventDefault(); $form.closest('.el-dialog').find('.btn-ok').trigger('click'); }
                });
            },
            onOk: function ($body, close) {
                var name = $.trim($body.find('#afName').val());
                if (!name) { UI.message({ type: 'warning', message: '请填写应用名称' }); return; }
                var payload = {
                    code: $.trim($body.find('#afCode').val()),
                    name: name,
                    shortName: $.trim($body.find('#afShort').val()),
                    appType: $body.find('#afType').val(),
                    dbType: $body.find('#afDbType').val(),
                    env: $body.find('#afEnv').val(),
                    dbConnId: $body.find('#afConn').val() || '',
                    ownerEmpId: $body.find('#afOwner').val() || '',
                    description: $.trim($body.find('#afDesc').val()),
                    status: $body.find('#afStatus').val(),
                    ispub: $body.find('#afIspub').val()
                };
                if (isEdit) { payload.id = row.id; }
                var req = isEdit ? Api.appInfo.update(payload) : Api.appInfo.add(payload);
                UI.loading($body, true, '保存中…');
                req.done(function (res) {
                    UI.message({ type: 'success', message: (res && res.message) || '已保存' });
                    close();
                    if (!isEdit && res && res.id) { state.selectedId = String(res.id); }
                    loadData();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                }).always(function () { UI.loading($body, false); });
            }
        });
    }

    function setEnabled(row, on) {
        Api.appInfo.setEnabled(row.id, on).done(function (res) {
            UI.message({ type: 'success', message: (res && res.message) || '已更新' });
            loadData();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
        });
    }

    function removeApp(row) {
        UI.confirm({
            title: '删除应用',
            message: '确定删除应用「' + row.name + '」吗？它的库表结构、全部版本与脚本会一起删除，' +
                '历史版本无法找回（真实数据库不会被改动）。',
            confirmText: '删除'
        }).done(function (yes) {
            if (!yes) { return; }
            Api.appInfo.remove(row.id).done(function (res) {
                UI.message({ type: 'success', message: (res && res.message) || '已删除' });
                state.selectedId = '';
                loadData();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }

    /* ---------- 事件 ---------- */
    $('#appBtnSearch').on('click', function () {
        closeAllMulti();
        state.keyword = $.trim($('#appKeyword').val());
        state.appType = $('#appType').val() || '';        // 多选：逗号串（如 web,service）
        state.dbType = $('#appDbType').val() || '';
        state.status = $('#appStatus').val() || '';
        state.pageNum = 1;
        loadData();
    });
    $('#appBtnReset').on('click', function () {
        closeAllMulti();
        $('#appKeyword').val('');
        $('#appTypeMulti, #appDbTypeMulti').each(function () {
            var $m = $(this);
            $m.find('.ai-multi__opt input').prop('checked', false);
            syncMulti($m);
        });
        $('#appStatus').val('');
        state.keyword = ''; state.appType = ''; state.dbType = ''; state.status = '';
        state.selectedId = ''; state.pageNum = 1;
        loadData();
    });
    $('#appKeyword').on('keydown', function (e) {
        if (e.keyCode === 13) { $('#appBtnSearch').trigger('click'); }
    });
    $('#appBtnAdd').on('click', function () {
        loadMeta().done(function () { openForm(null); }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '下拉数据加载失败' });
        });
    });
    $('#appBtnEdit').on('click', function () {
        var row = selected();
        if (!row) { return; }
        loadMeta().done(function () { openForm(row); });
    });
    $('#appBtnSchema').on('click', function () {
        var row = selected();
        if (row) { go('appschema.html?appId=' + encodeURIComponent(row.id)); }
    });
    $('#appBtnEnable').on('click', function () {
        var row = selected();
        if (row) { setEnabled(row, true); }
    });
    $('#appBtnDisable').on('click', function () {
        var row = selected();
        if (row) { setEnabled(row, false); }
    });
    $('#appBtnDelete').on('click', function () {
        var row = selected();
        if (row) { removeApp(row); }
    });
    $('#appBtnRefresh').on('click', loadData);

    $tbody.on('click', 'tr[data-id]', function (e) {
        if ($(e.target).is('input[type=radio]')) { return; }
        state.selectedId = String($(this).attr('data-id'));
        $tbody.find('tr[data-id]').removeClass('is-selected');
        $(this).addClass('is-selected');
        $tbody.find('input[name=appPick]').prop('checked', false);
        $(this).find('input[name=appPick]').prop('checked', true);
        syncToolbar();
    });
    $tbody.on('change', 'input[name=appPick]', function () {
        state.selectedId = String($(this).val());
        $tbody.find('tr[data-id]').removeClass('is-selected');
        $(this).closest('tr').addClass('is-selected');
        syncToolbar();
    });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        var row = state.rows[String($(this).attr('data-id'))];
        if (!row) { return; }
        loadMeta().done(function () { openForm(row); });
    });
    $tbody.on('click', '.app-schema-link', function (e) {
        e.preventDefault();
        e.stopPropagation();
        go('appschema.html?appId=' + encodeURIComponent($(this).attr('data-id')));
    });

    var layoutTimer = null;
    $(window).on('resize', function () {
        if (layoutTimer) { window.clearTimeout(layoutTimer); }
        layoutTimer = window.setTimeout(function () {
            if (!isAutoMode()) { layoutRows(); return; }
            var size = calcPageSize();
            if (size !== state.pageSize) { state.pageNum = 1; state.pageSize = size; loadData(); }
            else { layoutRows(); }
        }, 150);
    });
    $(window).on('load', function () { window.setTimeout(layoutRows, 60); });

    /* 多选下拉：点空白处 / 按 Esc 收起面板 */
    initMulti($('#appTypeMulti'));
    initMulti($('#appDbTypeMulti'));
    $(document).on('click', closeAllMulti);
    $(document).on('keydown', function (e) {
        if (e.keyCode === 27) { closeAllMulti(); }
    });

    loadMeta();
    loadData();
});
