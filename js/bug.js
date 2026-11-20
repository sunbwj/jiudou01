/* bug.js —— 缺陷管理（客户现场问题登记 / 评估时间线 / 确认缺陷转修复工单）
   --------------------------------------------------------------------------
   流程：
     登记（标题 / 所在项目 / 发生时间 / 接收人 / 描述）→ 推送创建人 + 接收人；
     评估（是缺陷 / 非缺陷 / 需补充信息）→ 追加时间线 → 推送创建人 + 接收人；
     确认缺陷（研发 / 测试 / 验收三组责任人与起止时间）→ 自动生成 1 计划 + 3 任务 + 3 工单。
   约定：
     · 人员选择统一用 WpEmpPicker（组织架构树），不自己拼下拉；
     · 富文本用 RichText.mount，提交时同时带纯文本与 HTML；
     · 列表行高适配与 requirement.js 同一套口径（自动算每页条数 + 行高拉伸 + 空行补位）。
*/
jQuery(function ($) {
    var state = {
        projectId: '', status: '', level: '', keyword: '',
        pageNum: 1, pageSize: 10, total: 0, rows: {}, selectedId: '',
        projects: [], me: { id: 0, name: '' }
    };
    var $tbody = $('#bugTbody');
    var $pager = $('#bugPager');

    function esc(t) { return UI.escapeHtml(t == null ? '' : t); }
    function num(v) { return parseInt(v, 10) || 0; }
    function str(v) { return v == null ? '' : String(v); }

    function statusTag(s) {
        var cls = (s === '已修复' || s === '已转工单') ? 'el-tag--success' :
            (s === '非缺陷' ? 'el-tag--info' :
            (s === '已关闭' ? 'el-tag--info' :
            (s === '已确认' ? 'el-tag--primary' : 'el-tag--warning')));
        return '<span class="el-tag el-tag--small ' + cls + '">' + esc(s || '待评估') + '</span>';
    }

    function levelPill(level) {
        var lv = str(level).toUpperCase();
        if (!lv) { return '<span class="bug-pill bug-pill--none">未定级</span>'; }
        var cls = lv === 'P0' ? 'bug-pill--p0' : (lv === 'P1' ? 'bug-pill--p1' :
            (lv === 'P2' ? 'bug-pill--p2' : 'bug-pill--p3'));
        return '<span class="bug-pill ' + cls + '">' + esc(lv) + '</span>';
    }

    /* ---------------- 状态多选 ---------------- */
    function statusValues() {
        var vals = $('#bugStatusMulti .bug-multi__opt input:checked').map(function () {
            return $(this).val();
        }).get();
        return vals;
    }
    function syncStatusMulti() {
        var names = $('#bugStatusMulti .bug-multi__opt input:checked').map(function () {
            return $(this).parent().text().replace(/\s+/g, ' ').trim();
        }).get();
        $('#bugStatusMulti').toggleClass('has-value', names.length > 0);
        $('#bugStatusMulti .bug-multi__text').text(names.length ? names.join('、') : '全部状态');
    }
    function initStatusMulti() {
        $('#bugStatusMulti').on('click', '.bug-multi__box', function (e) {
            e.stopPropagation();
            var $drop = $('#bugStatusMulti .bug-multi__drop');
            $drop.prop('hidden', !$drop.prop('hidden'));
        });
        $('#bugStatusMulti').on('click', '.bug-multi__drop', function (e) { e.stopPropagation(); });
        $('#bugStatusMulti').on('change', '.bug-multi__opt input', syncStatusMulti);
        $('#bugStatusMulti').on('click', '.bug-multi__clear', function (e) {
            e.preventDefault(); e.stopPropagation();
            $('#bugStatusMulti .bug-multi__opt input').prop('checked', false);
            $('#bugStatus').val('');
            syncStatusMulti();
        });
        $(document).on('click.bugMulti', function () {
            $('#bugStatusMulti .bug-multi__drop').prop('hidden', true);
        });
        syncStatusMulti();
    }

    /* ---------------- 工具栏可用性 ---------------- */
    function selected() { return state.rows[str(state.selectedId)] || null; }
    function canEvaluate(row) {
        return !!row && ['待评估', '已确认', '非缺陷', '已修复'].indexOf(str(row.status)) >= 0;
    }
    function canEdit(row) {
        return !!row && ['待评估', '已确认', '非缺陷', '已修复'].indexOf(str(row.status)) >= 0;
    }
    function canConfirm(row) {
        return !!row && str(row.status) === '已确认' && !str(row.planId);
    }
    /* 已转工单 / 已关闭：按钮灰化但仍可点，点了说清「为什么不能操作」。
       未选中行时没有可解释的对象，才真禁用。 */
    function blockReason(row, action) {
        if (!row) { return ''; }
        var st = str(row.status);
        if (st === '已转工单') {
            if (action === 'evaluate') {
                return '该缺陷已转工单：研发 / 测试 / 验收已按工单推进，评估结论已归档，不能再追加评估。';
            }
            if (action === 'confirm') {
                return '该缺陷已生成修复工单，不能重复生成；如需增减任务请到「工作计划」里调整。';
            }
            if (action === 'edit') {
                return '该缺陷已转工单，三组责任人与起止时间已随工单派发，登记信息不能再改；' +
                    '需要调整请到「工作计划」改任务责任人或时间。';
            }
        }
        if (st === '已关闭') {
            return '该缺陷已关闭，不能再' + ({ evaluate: '评估', confirm: '生成工单', edit: '修改登记信息' }[action] || '操作') + '。';
        }
        if (action === 'confirm') {
            if (st === '待评估') {
                return '该缺陷还没评估：请先「评估确认」为「是缺陷」，再指定责任人生成修复工单。';
            }
            if (st === '非缺陷') {
                return '该缺陷的评估结论是「非缺陷」，不会生成修复工单；如判断有误，可重新评估改为「是缺陷」。';
            }
            if (st === '需补充信息') {
                return '该缺陷在等创建人补充信息，补充并重新评估为「是缺陷」后才能生成修复工单。';
            }
        }
        return '';
    }
    /* allowed=false 且能解释原因 → 伪禁用：保留可点击，点击弹提示 */
    function setToolBtn(sel, row, action, allowed) {
        var $b = $(sel);
        if ($b.attr('data-perm') === 'hidden' || $b.hasClass('is-perm-hidden')) {
            return;            // 没授权的按钮交给 btnperm 隐藏，别在这里改它的 disabled
        }
        if (!row) {
            $b.prop('disabled', true).removeClass('is-disabled')
              .removeAttr('data-blocked').removeAttr('title');
            return;
        }
        var reason = allowed ? '' : (blockReason(row, action) ||
            '当前状态（' + str(row.status) + '）不支持该操作');
        $b.prop('disabled', false)
          .toggleClass('is-disabled', !!reason)
          .attr('data-blocked', reason || null)
          .attr('title', reason || null);
    }
    function syncToolbar() {
        var row = selected();
        $('#bugBtnDetail').prop('disabled', !row);
        setToolBtn('#bugBtnEvaluate', row, 'evaluate', canEvaluate(row));
        setToolBtn('#bugBtnConfirm', row, 'confirm', canConfirm(row));
        setToolBtn('#bugBtnEdit', row, 'edit', canEdit(row));
        $('#bugBtnClose').prop('disabled', !row || str(row.status) === '已关闭');
    }

    /* ---------------- 项目下拉（取自「项目管理 · 项目信息」，可见 + 启用） ---------------- */
    function loadProjects() {
        Api.project.options().done(function (res) {
            var list = (res && res.list) || [];
            state.projects = list;
            var html = '<option value="">全部项目</option>';
            $.each(list, function (i, p) {
                html += '<option value="' + esc(p.id) + '">' + esc(p.projectName) +
                    (p.projectCode ? '（' + esc(p.projectCode) + '）' : '') + '</option>';
            });
            $('#bugProject').html(html).val(state.projectId || '');
        });
    }
    function projectOptions(selectedId, fallbackName) {
        var html = '<option value="">请选择所在项目</option>', hit = false;
        $.each(state.projects, function (i, p) {
            if (str(p.id) === str(selectedId)) { hit = true; }
            html += '<option value="' + esc(p.id) + '"' +
                (str(p.id) === str(selectedId) ? ' selected' : '') + '>' + esc(p.projectName) +
                (p.projectCode ? '（' + esc(p.projectCode) + '）' : '') + '</option>';
        });
        // 项目已删除 / 不在当前可见范围时，仍保留原值，避免编辑保存时被清空
        if (selectedId && !hit) {
            html += '<option value="' + esc(selectedId) + '" selected>' +
                esc(fallbackName || '原项目（已不可见）') + '</option>';
        }
        return html;
    }

    /* ---------------- 行高适配（与 requirement.js 同口径） ---------------- */
    var COLS = 13;
    var DEF_ROW_H = 54, MAX_ROW_H = 64;
    var MIN_PAGE_SIZE = 3, MAX_PAGE_SIZE = 100;
    var PAGER_H = 69;
    var autoSize = true, naturalRowH = DEF_ROW_H;

    function isCardMode() { return window.innerWidth <= 768; }
    function isAutoMode() { return autoSize && !isCardMode(); }
    function bodyAvailHeight() {
        var theadH = $('#bugTableWrap').find('thead').outerHeight() || 0;
        return ($('#bugTableWrap').height() || 0) - theadH;
    }
    function calcPageSize() {
        var avail = bodyAvailHeight() - ($pager.outerHeight() || PAGER_H);
        if (avail <= naturalRowH) { return state.pageSize; }
        var n = Math.floor(avail / naturalRowH);
        if (n < MIN_PAGE_SIZE) { n = MIN_PAGE_SIZE; }
        if (n > MAX_PAGE_SIZE) { n = MAX_PAGE_SIZE; }
        return n;
    }
    function layoutRows() {
        $tbody.find('tr.blank-row').remove();
        if (isCardMode()) {
            $tbody.find('tr > td').css('height', '');
            return;
        }
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
        var rowH = Math.floor(avail / n);
        if (rowH < naturalH) { rowH = naturalH; }
        if (rowH > MAX_ROW_H && naturalH <= MAX_ROW_H) { rowH = MAX_ROW_H; }
        var rest = avail - rowH * n;
        if (rest > 0 && rest < n) {
            $rows.children('td').css('height', rowH + 'px');
            $rows.slice(0, rest).children('td').css('height', (rowH + 1) + 'px');
            return;
        }
        $rows.children('td').css('height', rowH + 'px');
        var cnt = Math.floor(rest / rowH);
        if (cnt <= 0) {
            if (rest > 0) {
                var add = Math.floor(rest / n);
                if (rowH + add > MAX_ROW_H) {
                    $tbody.append('<tr class="blank-row"><td colspan="' + COLS +
                        '" style="height:' + rest + 'px"></td></tr>');
                    return;
                }
                var extra = rest - add * n;
                $rows.children('td').css('height', (rowH + add) + 'px');
                $rows.slice(0, extra).children('td').css('height', (rowH + add + 1) + 'px');
            }
            return;
        }
        if (cnt > 200) { cnt = 200; }
        var rem = rest - cnt * rowH, blanks = '';
        for (var i = 0; i < cnt; i++) {
            blanks += '<tr class="blank-row"><td colspan="' + COLS + '" style="height:' +
                (rowH + (i === cnt - 1 ? rem : 0)) + 'px"></td></tr>';
        }
        $tbody.append(blanks);
    }

    /* ---------------- 列表 ---------------- */
    function loadData() {
        if (isAutoMode()) {
            var auto = calcPageSize();
            if (auto && auto !== state.pageSize) { state.pageSize = auto; }
        }
        UI.loading($('#bugTableWrap'), true);
        Api.bug.page({
            projectId: state.projectId, status: statusValues().join(','), level: state.level,
            keyword: state.keyword, pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (res) {
            var d = res || {}, list = d.list || [];
            state.total = num(d.total);
            state.rows = {};
            $('#bugCount').text(state.total);
            if (!list.length) {
                $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                    '<span class="el-table__empty-text">没有符合条件的缺陷 / 问题</span></div></td></tr>');
            } else {
                var html = '', startNo = (state.pageNum - 1) * state.pageSize;
                $.each(list, function (i, r) {
                    state.rows[str(r.id)] = r;
                    html += '<tr data-id="' + esc(r.id) + '"' +
                        (str(state.selectedId) === str(r.id) ? ' class="is-selected"' : '') + '>' +
                        '<td class="is-center"><input type="radio" name="bugPick" value="' + esc(r.id) + '"' +
                            (str(state.selectedId) === str(r.id) ? ' checked' : '') + '></td>' +
                        '<td class="is-center">' + (startNo + i + 1) + '</td>' +
                        '<td>' + esc(r.bugCode) + '</td>' +
                        '<td title="' + esc(r.title) + '">' + esc(r.title) + '</td>' +
                        '<td>' + esc(r.projectName || '—') + '</td>' +
                        '<td class="is-center">' + levelPill(r.level) + '</td>' +
                        '<td class="is-center">' + statusTag(r.status) + '</td>' +
                        '<td>' + esc(r.receiverName || '—') + '</td>' +
                        '<td>' + esc(r.reporterName || '—') + '</td>' +
                        '<td>' + esc(str(r.happenTime).slice(0, 16)) + '</td>' +
                        '<td>' + (r.planCode ? esc(r.planCode) : '—') + '</td>' +
                        '<td class="is-center"><a href="javascript:;" class="bug-evals-link" data-id="' +
                            esc(r.id) + '">' + num(r.evalCount) + '</a></td>' +
                        '<td>' + esc(str(r.createTime).slice(0, 16)) + '</td>' +
                        '</tr>';
                });
                $tbody.html(html);
            }
            if (state.selectedId && !state.rows[str(state.selectedId)]) { state.selectedId = ''; }
            syncToolbar();
            UI.pagination($pager, {
                total: state.total, pageNum: state.pageNum, pageSize: state.pageSize,
                sizes: [10, 20, 50],
                onChange: function (n, size) {
                    if (size !== state.pageSize) { autoSize = false; }
                    state.pageNum = n; state.pageSize = size; loadData();
                }
            });
            window.setTimeout(layoutRows, 30);
        }).fail(function (err) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">' + esc((err && err.message) || '加载失败') +
                '</span></div></td></tr>');
        }).always(function () { UI.loading($('#bugTableWrap'), false); });
    }

    /* ---------------- 人员选择 ---------------- */
    function pickPerson(opt) {
        opt = opt || {};
        if (!window.WpEmpPicker) {
            UI.message({ type: 'warning', message: '选人组件未加载，请刷新页面重试' });
            return;
        }
        WpEmpPicker.open({
            title: opt.title || '选择人员',
            multiple: false,
            selected: opt.id ? [{ id: opt.id, name: opt.name || '' }] : [],
            onOk: function (list) {
                var one = (list && list[0]) || null;
                if (!one || !num(one.id)) {
                    UI.message({ type: 'warning', message: '请选择一位人员' });
                    return;
                }
                if (opt.onOk) { opt.onOk({ id: num(one.id), name: str(one.name) }); }
            }
        });
    }

    /* 人员字段：一个按钮，点击打开组织架构选人，选中后回填文本与 data 属性 */
    function bindPersonField($body, selector, hidden) {
        // 必须按「被点的那一个」取值：确认弹窗里有研发 / 测试 / 验收三个按钮，
        // 用集合 $btn 会把选中结果写到全部按钮上（三位责任人被覆盖成同一人）。
        $body.find(selector).on('click', function () {
            var $self = $(this);
            pickPerson({
                title: $self.attr('data-title') || '选择人员',
                id: num($self.attr('data-id')),
                name: $self.attr('data-name'),
                onOk: function (one) {
                    $self.attr('data-id', one.id).attr('data-name', one.name)
                        .addClass('has-value').removeClass('is-empty');
                    $self.find('.bug-person__text').text(one.name);
                    if (hidden) { $body.find(hidden).val(one.id); }
                }
            });
        });
    }

    function personButton(opt) {
        opt = opt || {};
        var has = num(opt.id) > 0;
        return '<button type="button" class="bug-person' + (has ? ' has-value' : ' is-empty') +
            '" data-id="' + (has ? num(opt.id) : '') + '" data-name="' + esc(opt.name || '') +
            '" data-title="' + esc(opt.title || '选择人员') + '" id="' + esc(opt.id_ || '') + '">' +
            '<span class="bug-person__text">' + esc(has ? (opt.name || ('员工' + opt.id)) : (opt.placeholder || '点击选择人员')) +
            '</span><span class="bug-person__caret">▾</span></button>';
    }

    /* ---------------- 附件（base64 → 后端落盘 bugfiles） ---------------- */
    function readFileBase64(file) {
        var dfd = $.Deferred();
        try {
            var reader = new FileReader();
            reader.onload = function () {
                var text = String(reader.result || '');
                dfd.resolve(text.indexOf(';base64,') >= 0 ? text.split(';base64,')[1] : text);
            };
            reader.onerror = function () { dfd.reject('读取失败'); };
            reader.readAsDataURL(file);
        } catch (e) { dfd.reject('读取失败'); }
        return dfd.promise();
    }

    function uploadFiles(bugId, files, done, fail) {
        if (!files || !files.length) { done(); return; }
        var payload = [], idx = 0;
        function next() {
            if (idx >= files.length) {
                Api.bug.upload({ bugId: bugId, files: payload }).done(done).fail(fail);
                return;
            }
            var file = files[idx++];
            readFileBase64(file).done(function (data) {
                payload.push({ name: file.name, size: file.size, data: data });
                next();
            }).fail(function () { fail('读取附件「' + file.name + '」失败'); });
        }
        next();
    }

    function openBugFile(id, name, download) {
        Api.bug.file(id).done(function (f) {
            var a = document.createElement('a');
            a.href = f.dataUrl;
            if (download) {
                a.download = name || f.name || '附件';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
            } else {
                window.open(f.dataUrl, '_blank');
            }
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '附件读取失败' });
        });
    }

    function bugFileHtml(files) {
        if (!files || !files.length) { return '<div class="bug-detail__empty">还没有附件</div>'; }
        var html = '';
        $.each(files, function (i, f) {
            html += '<div class="bug-file"><a href="javascript:;" class="bug-file__name" data-id="' +
                esc(f.id) + '" data-name="' + esc(f.name) + '">' + esc(f.name) + '</a>' +
                '<span class="bug-file__size">' +
                    Math.round((parseInt(f.size, 10) || 0) / 1024) + ' KB</span>' +
                '<button type="button" class="el-button el-button--text el-button--small bug-file__dl" data-id="' +
                esc(f.id) + '" data-name="' + esc(f.name) + '">下载</button></div>';
        });
        return html;
    }

    /* ---------------- 登记 / 编辑 ---------------- */
    function openForm(row) {
        var isEdit = !!row;
        var pickedFiles = [];
        var content =
            '<form class="el-form" id="bugForm" autocomplete="off" onsubmit="return false;">' +
                '<div class="bug-form-grid">' +
                    '<div class="el-form-item"><label class="el-form-item__label">问题标题 *</label>' +
                        '<div class="el-form-item__content"><input class="el-input__inner" id="bfTitle" maxlength="200" placeholder="一句话说清现象，如「结算页提交后金额翻倍」"></div></div>' +
                    '<div class="el-form-item"><label class="el-form-item__label">所在项目 *</label>' +
                        '<div class="el-form-item__content"><select class="el-input__inner" id="bfProject">' +
                        projectOptions(isEdit ? row.projectId : '', isEdit ? row.projectName : '') + '</select></div></div>' +
                    '<div class="el-form-item"><label class="el-form-item__label">发生时间 *</label>' +
                        '<div class="el-form-item__content"><input class="el-input__inner" type="datetime-local" id="bfHappen"></div></div>' +
                    '<div class="el-form-item"><label class="el-form-item__label">来源</label>' +
                        '<div class="el-form-item__content"><select class="el-input__inner" id="bfSource">' +
                        ['客户现场', '内部测试', '用户反馈', '运维巡检'].map(function (x) {
                            return '<option value="' + x + '">' + x + '</option>';
                        }).join('') + '</select></div></div>' +
                    '<div class="el-form-item"><label class="el-form-item__label">接收人员 *</label>' +
                        '<div class="el-form-item__content">' +
                        personButton({ id: isEdit ? row.receiverId : '', name: isEdit ? row.receiverName : '',
                                       title: '选择接收人员（负责评估）', placeholder: '点击选择接收人员' }) +
                        '<input type="hidden" id="bfReceiver"></div></div>' +
                    '<div class="el-form-item"><label class="el-form-item__label">严重级别</label>' +
                        '<div class="el-form-item__content"><select class="el-input__inner" id="bfLevel">' +
                        '<option value="">暂不定级（评估时确定）</option>' +
                        '<option value="P0">P0 致命</option><option value="P1">P1 严重</option>' +
                        '<option value="P2">P2 一般</option><option value="P3">P3 轻微</option>' +
                        '</select></div></div>' +
                '</div>' +
                '<div class="el-form-item bug-desc-item">' +
                    '<div class="bug-desc-head">' +
                        '<span class="bug-desc-label">问题描述 *（复现步骤 / 现象 / 期望结果）</span>' +
                        '<button type="button" class="el-button el-button--small bug-word-btn" id="bfImportWord">' +
                            '导入 Word 到描述</button>' +
                    '</div>' +
                    '<div class="el-form-item__content"><div class="el-input__inner bug-desc" id="bfDesc" contenteditable="true" role="textbox" aria-multiline="true"></div></div>' +
                '</div>' +
                '<div class="bug-file-field">' +
                    '<div class="bug-file-head">' +
                        '<span class="bug-file-label">附件</span>' +
                        '<button type="button" class="el-button el-button--small" id="bfPickFile">选择文件</button>' +
                        '<span class="bug-file-hint">支持 Word / PDF / 图片 / 日志等，单个 ≤ 10 MB，最多 10 个</span>' +
                        '<input type="file" id="bfFiles" multiple hidden>' +
                        '<input type="file" id="bfWordFile" accept=".docx,.docm" hidden>' +
                    '</div>' +
                    '<div class="bug-file-list" id="bfFileNames"></div>' +
                    '<div class="bug-file-existing" id="bfFileExisting"></div>' +
                '</div>' +
                '<div class="bug-hint">登记后立即向<b>创建人</b>与<b>接收人</b>推送站内即时消息与邮件；接收人评估后，结论会按时间线追加到详情里。</div>' +
            '</form>';
        UI.dialog({
            title: isEdit ? '编辑缺陷 / 问题（' + str(row.bugCode) + '）' : '登记缺陷 / 问题',
            width: 860, content: content,
            onReady: function ($body) {
                $body.closest('.el-dialog').addClass('bug-form-dialog');
                var rt = null;
                if (window.RichText) {
                    rt = window.RichText.mount($body.find('#bfDesc'), {
                        placeholder: '请描述：什么场景 → 做了什么 → 看到什么 → 期望什么；附上报错信息 / 数据示例',
                        label: '问题描述格式'
                    });
                }
                if (isEdit) {
                    $body.find('#bfTitle').val(row.title || '');
                    $body.find('#bfSource').val(row.sourceType || '客户现场');
                    $body.find('#bfLevel').val(str(row.level).toUpperCase() || '');
                    $body.find('#bfHappen').val(str(row.happenTime).slice(0, 16).replace(' ', 'T'));
                    $body.find('#bfReceiver').val(str(row.receiverId || ''));
                    if (rt) {
                        rt.setHtml(row.descriptionHtml || window.RichText.textToHtml(row.description || ''));
                    } else {
                        $body.find('#bfDesc').text(row.description || '');
                    }
                } else {
                    var now = new Date();
                    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
                    $body.find('#bfHappen').val(now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' +
                        pad(now.getDate()) + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes()));
                }
                /* 附件：选择 / 移除 / 编辑时展示已上传 */
                function renderPickedFiles() {
                    var $box = $body.find('#bfFileNames'), html = '';
                    if (!pickedFiles.length) { $box.html(''); return; }
                    $.each(pickedFiles, function (i, f) {
                        html += '<span class="bug-file-chip" title="' + esc(f.name) + '">' +
                            '<span class="bug-file-chip__name">' + esc(f.name) + '</span>' +
                            '<button type="button" class="bug-file-chip__del" data-idx="' + i +
                            '" title="移除" aria-label="移除">×</button></span>';
                    });
                    $box.html(html);
                }
                $body.on('click', '#bfPickFile', function () { $body.find('#bfFiles').trigger('click'); });
                $body.on('change', '#bfFiles', function () {
                    var input = this, i;
                    for (i = 0; i < (input.files || []).length; i++) {
                        var f = input.files[i], dup = false, j;
                        for (j = 0; j < pickedFiles.length; j++) {
                            if (pickedFiles[j].name === f.name && pickedFiles[j].size === f.size &&
                                pickedFiles[j].lastModified === f.lastModified) { dup = true; break; }
                        }
                        if (!dup) { pickedFiles.push(f); }
                    }
                    try { input.value = ''; } catch (e) { /* 允许再次选择同名文件 */ }
                    renderPickedFiles();
                });
                $body.on('click', '.bug-file-chip__del', function (e) {
                    e.preventDefault(); e.stopPropagation();
                    var idx = parseInt($(this).attr('data-idx'), 10);
                    if (!isNaN(idx)) { pickedFiles.splice(idx, 1); renderPickedFiles(); }
                });
                if (isEdit) {
                    Api.bug.detail(row.id).done(function (res) {
                        var files = (res && res.files) || [];
                        if (!files.length) { return; }
                        $body.find('#bfFileExisting').html(
                            '<div class="bug-file-existing__title">已上传附件（' + files.length + '）</div>' +
                            bugFileHtml(files));
                    });
                }
                /* Word 导入：.docx → HTML → 插入问题描述 */
                var WI = window.WordImport;
                $body.on('click', '#bfImportWord', function () {
                    if (!WI) { UI.message({ type: 'warning', message: '当前页面未加载 Word 导入组件' }); return; }
                    $body.find('#bfWordFile').trigger('click');
                });
                $body.on('change', '#bfWordFile', function () {
                    var input = this, file = (this.files || [])[0];
                    try { input.value = ''; } catch (e) { /* 忽略 */ }
                    if (!file || !WI) { return; }
                    var wname = file.name || 'document.docx';
                    if (/\.doc$/i.test(wname)) {
                        UI.message({ type: 'warning', message: '旧版 .doc 请先另存为 .docx 再导入' }); return;
                    }
                    if (!/\.(docx|docm)$/i.test(wname)) {
                        UI.message({ type: 'warning', message: '只支持 .docx / .docm 格式' }); return;
                    }
                    if (file.size && file.size > 10 * 1024 * 1024) {
                        UI.message({ type: 'warning', message: 'Word 文档不能超过 10 MB' }); return;
                    }
                    $.when(WI.fileToBase64(file)).done(function (dataUrl) {
                        Api.project.importDoc({ data: dataUrl, fileName: wname }).done(function (res) {
                            var html = WI.sanitize((res && res.html) || '');
                            if (!html) {
                                UI.message({ type: 'warning', message: 'Word 文档里没有可导入的文字内容' }); return;
                            }
                            function put(replace) {
                                var next = replace ? html : ((rt ? rt.html() : '') + html);
                                if (rt) { rt.setHtml(next); }
                                else { $body.find('#bfDesc').html(next); }
                                UI.message({ type: 'success', message: (res && res.message) || ('已导入「' + wname + '」') });
                            }
                            var hasText = rt ? !!$.trim(rt.text()) : !!$.trim($body.find('#bfDesc').text());
                            if (hasText) {
                                UI.confirm({
                                    title: '导入 Word', type: 'info',
                                    message: '问题描述已有内容，导入的内容要追加到末尾还是替换现有内容？',
                                    confirmText: '追加到末尾', cancelText: '替换现有内容'
                                }).done(function (yes) { put(!yes); });
                            } else { put(true); }
                        }).fail(function (err) {
                            UI.message({ type: 'error', message: (err && err.message) || 'Word 解析失败' });
                        });
                    }).fail(function () {
                        UI.message({ type: 'error', message: '读取 Word 文件失败' });
                    });
                });
                bindPersonField($body, '.bug-person', '#bfReceiver');
                $body.find('#bfTitle').trigger('focus');
            },
            onOk: function ($body, close) {
                /* 富文本实例必须在这里重新取：onReady 里的 rt 是它的局部变量，
                   直接闭包引用会抛 ReferenceError（表现为点「确定」毫无反应）。 */
                var rt = window.RichText ? window.RichText.of($body.find('#bfDesc')) : null;
                var title = $.trim($body.find('#bfTitle').val() || '');
                var projectId = $body.find('#bfProject').val();
                var projectName = $body.find('#bfProject option:selected').text().replace(/（.*?）$/, '');
                var happen = $body.find('#bfHappen').val();
                var receiverId = num($body.find('#bfReceiver').val());
                var receiverName = $body.find('.bug-person').attr('data-name') || '';
                var descHtml = rt ? $.trim(rt.html()) : $.trim($body.find('#bfDesc').html() || '');
                var descText = rt ? $.trim(rt.text()) : $.trim($body.find('#bfDesc').text() || '');
                if (!title) { UI.message({ type: 'warning', message: '请填写问题标题' }); return; }
                if (!projectId) { UI.message({ type: 'warning', message: '请选择问题所在项目' }); return; }
                if (!happen) { UI.message({ type: 'warning', message: '请选择发生时间' }); return; }
                if (!receiverId) { UI.message({ type: 'warning', message: '请选择接收人员' }); return; }
                if (!descText) { UI.message({ type: 'warning', message: '请填写问题描述' }); return; }
                var data = {
                    title: title, projectId: projectId, projectName: projectName,
                    happenTime: str(happen).replace('T', ' '),
                    sourceType: $body.find('#bfSource').val(),
                    level: $body.find('#bfLevel').val(),
                    receiverId: receiverId,
                    description: descText, descriptionHtml: descHtml
                };
                var req = isEdit ? Api.bug.update($.extend({ id: row.id }, data))
                                 : Api.bug.add(data);
                var $ok = $body.closest('.el-dialog').find('.btn-ok');
                $ok.prop('disabled', true);
                req.done(function (res) {
                    var bugId = isEdit ? row.id : (res && res.id);
                    function finish(msg, isErr) {
                        close();
                        UI.message({ type: isErr ? 'error' : 'success', message: msg });
                        if (res && res.bugCode && !isEdit) { state.selectedId = res.id; }
                        state.pageNum = 1;
                        loadData();
                    }
                    if (!bugId || !pickedFiles.length) {
                        finish((res && res.message) || '已保存');
                        return;
                    }
                    uploadFiles(bugId, pickedFiles, function () {
                        finish((res && res.message) || '已保存');
                    }, function (msg) {
                        finish((msg || '附件上传失败') + '；缺陷已保存', true);
                    });
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                }).always(function () { $ok.prop('disabled', false); });
            }
        });
    }

    /* ---------------- 评估 ---------------- */
    function openEvaluate(row) {
        var content =
            '<form class="el-form" id="bugEvalForm" autocomplete="off" onsubmit="return false;">' +
                '<div class="bug-eval-field">' +
                    '<span class="bug-eval-label">评估结论 *</span>' +
                    '<div class="el-form-item__content"><div class="bug-radio-line">' +
                        '<label><input type="radio" name="beResult" value="是缺陷" checked> 是缺陷（进入修复流程）</label>' +
                        '<label><input type="radio" name="beResult" value="非缺陷"> 非缺陷（关闭）</label>' +
                        '<label><input type="radio" name="beResult" value="需补充信息"> 需补充信息（退回待评估）</label>' +
                    '</div></div>' +
                '</div>' +
                '<div class="bug-eval-field">' +
                    '<span class="bug-eval-label">严重级别 *</span>' +
                    '<div class="el-form-item__content"><select class="el-input__inner" id="beLevel">' +
                        '<option value="">请选择（确认是缺陷时必填）</option>' +
                        '<option value="P0">P0 致命：核心流程不可用 / 数据错误 / 无绕行</option>' +
                        '<option value="P1">P1 严重：主流程受阻，有临时绕行</option>' +
                        '<option value="P2">P2 一般：局部功能异常</option>' +
                        '<option value="P3">P3 轻微：文案 / 样式 / 体验</option>' +
                    '</select></div>' +
                '</div>' +
                '<div class="bug-eval-field">' +
                    '<span class="bug-eval-label">评估意见 / 原因（非缺陷与需补充信息时必填）</span>' +
                    '<div class="el-form-item__content"><div class="el-input__inner bug-eval-reason" id="beReason" contenteditable="true" role="textbox" aria-multiline="true"></div></div>' +
                '</div>' +
                '<div class="bug-hint">本次评估结果会追加到评估时间线，并向<b>创建人</b>与<b>接收人</b>推送站内消息与邮件。</div>' +
            '</form>';
        UI.dialog({
            title: '缺陷评估（' + str(row.bugCode) + ' ' + str(row.title) + '）',
            width: 720, content: content,
            onReady: function ($body) {
                $body.closest('.el-dialog').addClass('bug-eval-dialog');
                var rt = null;
                if (window.RichText) {
                    rt = window.RichText.mount($body.find('#beReason'), {
                        placeholder: '说明判断依据：复现结果 / 影响范围 / 是否是缺陷 / 需要补充哪些信息',
                        label: '评估意见格式'
                    });
                }
                if (row.level) { $body.find('#beLevel').val(str(row.level).toUpperCase()); }
                $body.on('change', 'input[name=beResult]', function () {
                    var v = $body.find('input[name=beResult]:checked').val();
                    $body.find('#beLevel').prop('disabled', v !== '是缺陷');
                });
            },
            onOk: function ($body, close) {
                var rt = window.RichText ? window.RichText.of($body.find('#beReason')) : null;
                var result = $body.find('input[name=beResult]:checked').val();
                var level = $body.find('#beLevel').val();
                var reasonHtml = rt ? $.trim(rt.html()) : $.trim($body.find('#beReason').html() || '');
                var reasonText = rt ? $.trim(rt.text()) : $.trim($body.find('#beReason').text() || '');
                if (result === '是缺陷' && !level) {
                    UI.message({ type: 'warning', message: '确认为缺陷时必须选择严重级别' }); return;
                }
                if (result !== '是缺陷' && !reasonText) {
                    UI.message({ type: 'warning', message: '结论为「' + result + '」时必须填写原因' }); return;
                }
                var $ok = $body.closest('.el-dialog').find('.btn-ok');
                $ok.prop('disabled', true);
                Api.bug.evaluate({
                    id: row.id, result: result,
                    level: result === '是缺陷' ? level : '',
                    reason: reasonText, reasonHtml: reasonHtml
                }).done(function (res) {
                    close();
                    UI.message({ type: 'success', message: (res && res.message) || '评估结果已保存' });
                    loadData();
                    if (result === '是缺陷') {
                        UI.confirm({
                            title: '下一步', type: 'info', danger: false,
                            message: '已确认是缺陷。是否现在指定研发 / 测试 / 验收责任人并生成修复工单？',
                            confirmText: '现在指定', cancelText: '稍后处理'
                        }).done(function (yes) {
                            if (!yes) { return; }
                            var fresh = state.rows[str(row.id)] || $.extend({}, row, { status: '已确认' });
                            openConfirm(fresh);
                        });
                    }
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '评估保存失败' });
                }).always(function () { $ok.prop('disabled', false); });
            }
        });
    }

    /* ---------------- 确认缺陷 → 生成修复工单 ---------------- */
    function openConfirm(row) {
        var reporterId = num(row.reporterId);
        var reporterName = str(row.reporterName);
        var today = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var todayText = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
        function teamBlock(key, label, tag, hint, person, start, end) {
            return '<div class="bug-team">' +
                '<div class="bug-team__title">' + label + '<span class="bug-team__tag">' + tag + '</span>' +
                    '<span class="bug-hint">' + hint + '</span></div>' +
                '<div class="bug-team__grid">' +
                    '<div class="el-form-item"><label class="el-form-item__label">责任人 *</label>' +
                        '<div class="el-form-item__content">' + person + '</div></div>' +
                    '<div class="el-form-item"><label class="el-form-item__label">开始日期 *</label>' +
                        '<div class="el-form-item__content"><input class="el-input__inner" type="date" id="bc' + key + 'Start" value="' + start + '"></div></div>' +
                    '<div class="el-form-item"><label class="el-form-item__label">结束日期 *</label>' +
                        '<div class="el-form-item__content"><input class="el-input__inner" type="date" id="bc' + key + 'End" value="' + end + '"></div></div>' +
                '</div></div>';
        }
        var content =
            '<form class="el-form" id="bugConfirmForm" autocomplete="off" onsubmit="return false;">' +
                '<div class="bug-hint" style="margin-bottom:10px">确认后将自动生成 1 张修复计划 + 3 条任务 + 3 张工单，' +
                    '立即派给三位责任人（站内消息 + 邮件）；研发 / 测试工单计入工作量统计，验收工单不计入。</div>' +
                teamBlock('Dev', '研发修复', '研发', '改代码、提交修复说明', 
                    personButton({ id: row.devOwnerId, name: row.devOwnerName, title: '选择研发责任人', placeholder: '选择研发责任人' }),
                    str(row.devStartDate).slice(0, 10) || todayText, str(row.devEndDate).slice(0, 10) || todayText) +
                teamBlock('Test', '测试验证', '测试', '复测 + 影响范围回归',
                    personButton({ id: row.testOwnerId, name: row.testOwnerName, title: '选择测试责任人', placeholder: '选择测试责任人' }),
                    str(row.testStartDate).slice(0, 10) || todayText, str(row.testEndDate).slice(0, 10) || todayText) +
                teamBlock('Accept', '验收确认', '验收', '默认缺陷创建人，可改',
                    personButton({ id: row.acceptOwnerId || reporterId, name: row.acceptOwnerName || reporterName,
                                   title: '选择验收责任人', placeholder: '选择验收责任人' }),
                    str(row.acceptStartDate).slice(0, 10) || todayText, str(row.acceptEndDate).slice(0, 10) || todayText) +
            '</form>';
        UI.dialog({
            title: '确认缺陷并生成修复工单（' + str(row.bugCode) + '）',
            width: 880, content: content,
            onReady: function ($body) {
                $body.closest('.el-dialog').addClass('bug-form-dialog');
                bindPersonField($body, '#bugConfirmForm .bug-person', null);
            },
            onOk: function ($body, close) {
                var people = {};
                var keys = [['Dev', '研发责任人'], ['Test', '测试责任人'], ['Accept', '验收责任人']];
                for (var i = 0; i < keys.length; i++) {
                    var k = keys[i][0];
                    var $p = $body.find('#bc' + k + 'Start').closest('.bug-team').find('.bug-person');
                    var pid = num($p.attr('data-id'));
                    var start = $body.find('#bc' + k + 'Start').val();
                    var end = $body.find('#bc' + k + 'End').val();
                    if (!pid) { UI.message({ type: 'warning', message: '请选择' + keys[i][1] }); return; }
                    if (!start || !end) { UI.message({ type: 'warning', message: '请填写' + keys[i][1] + '的起止日期' }); return; }
                    if (start > end) { UI.message({ type: 'warning', message: keys[i][1] + '的开始日期不能晚于结束日期' }); return; }
                    people[k.toLowerCase()] = { id: pid, name: $p.attr('data-name') || '', start: start, end: end };
                }
                var $ok = $body.closest('.el-dialog').find('.btn-ok');
                $ok.prop('disabled', true).text('正在生成…');
                Api.bug.confirm({
                    id: row.id,
                    devOwnerId: people.dev.id, devStartDate: people.dev.start, devEndDate: people.dev.end,
                    testOwnerId: people.test.id, testStartDate: people.test.start, testEndDate: people.test.end,
                    acceptOwnerId: people.accept.id, acceptStartDate: people.accept.start, acceptEndDate: people.accept.end
                }).done(function (res) {
                    close();
                    UI.message({ type: 'success', message: (res && res.message) || '已生成修复工单' });
                    loadData();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '生成失败' });
                    $ok.prop('disabled', false).text('确定');
                });
            }
        });
    }

    /* ---------------- 详情 + 评估时间线 ---------------- */
    function evalTimelineHtml(evals) {
        if (!evals || !evals.length) {
            return '<div class="bug-tl-empty">还没有评估记录，等待接收人评估</div>';
        }
        var html = '<div class="bug-timeline">';
        $.each(evals, function (i, e) {
            var result = str(e.result);
            var cls = result === '非缺陷' ? ' is-fail' : (result === '需补充信息' ? ' is-wait' : '');
            html += '<div class="bug-tl-item' + cls + '">' +
                '<span class="bug-tl-dot"></span>' +
                '<div class="bug-tl-head"><b>' + esc(result || '评估') + '</b>' +
                    (e.level ? levelPill(e.level) : '') +
                    '<span class="bug-tl-time">' + esc(str(e.createTime).slice(0, 16)) + '</span>' +
                    '<span class="bug-tl-time">' + esc(e.evaluatorName || '') + '</span>' +
                '</div>' +
                (e.evaluatorNames ? '<div class="bug-tl-meta">参与评估：' + esc(e.evaluatorNames) + '</div>' : '') +
                ((e.reasonHtml || e.reason) ? '<div class="bug-tl-reason">' +
                    (e.reasonHtml || esc(e.reason)) + '</div>' : '') +
                '</div>';
        });
        html += '</div>';
        return html;
    }

    function orderListHtml(orders) {
        if (!orders || !orders.length) {
            return '<div class="bug-detail__empty">还没有修复工单（确认缺陷后自动生成）</div>';
        }
        var kindMap = { 'bug-dev': '研发修复', 'bug-test': '测试验证', 'bug-accept': '验收确认', 'plan': '计划任务' };
        var html = '';
        $.each(orders, function (i, o) {
            html += '<div class="bug-order">' +
                '<span class="bug-order__kind">' + esc(kindMap[str(o.orderKind)] || '工单') + '</span>' +
                '<span class="bug-order__code">' + esc(o.orderCode) + '</span>' +
                '<span class="bug-order__title" title="' + esc(o.orderTitle) + '">' +
                    esc(o.ownerName || '未指定') + ' · ' + esc(o.status || '待处理') + '</span>' +
                '<span class="bug-order__time">' + esc(str(o.startDate).slice(0, 10)) + ' ~ ' +
                    esc(str(o.endDate).slice(0, 10)) + '</span>' +
                '</div>';
        });
        return html;
    }

    function openDetail(id) {
        var dlg = UI.dialog({
            title: '缺陷详情', width: 900,
            content: '<div id="bugDetailBox"><div class="bug-detail__empty">加载中…</div></div>'
        });
        function render(res) {
            var b = (res && res.bug) || {}, evals = (res && res.evaluations) || [];
            var orders = (res && res.orders) || [], plan = (res && res.plan) || {};
            var files = (res && res.files) || [];
            state.detail = res || {};
            var html = '<div class="bug-detail">' +
                '<div class="bug-detail__grid">' +
                    '<div class="bug-detail__row"><span class="bug-detail__label">缺陷编号：</span>' + esc(b.bugCode) + '</div>' +
                    '<div class="bug-detail__row"><span class="bug-detail__label">状态：</span>' + statusTag(b.status) + '</div>' +
                    '<div class="bug-detail__row"><span class="bug-detail__label">严重级别：</span>' + levelPill(b.level) + '</div>' +
                    '<div class="bug-detail__row"><span class="bug-detail__label">所在项目：</span>' + esc(b.projectName || '—') + '</div>' +
                    '<div class="bug-detail__row"><span class="bug-detail__label">发生时间：</span>' + esc(str(b.happenTime).slice(0, 16)) + '</div>' +
                    '<div class="bug-detail__row"><span class="bug-detail__label">来源：</span>' + esc(b.sourceType || '—') + '</div>' +
                    '<div class="bug-detail__row"><span class="bug-detail__label">创建人：</span>' + esc(b.reporterName || '—') + '</div>' +
                    '<div class="bug-detail__row"><span class="bug-detail__label">接收人：</span>' + esc(b.receiverName || '—') + '</div>' +
                    '<div class="bug-detail__row"><span class="bug-detail__label">登记时间：</span>' + esc(str(b.createTime).slice(0, 16)) + '</div>' +
                '</div>' +
                '<div class="bug-detail__sub">问题描述</div>' +
                '<div class="bug-detail__body">' + (b.descriptionHtml || esc(b.description || '—')) + '</div>' +
                '<div class="bug-detail__sub">附件（' + files.length + '）</div>' +
                '<div class="bug-detail__files">' + bugFileHtml(files) + '</div>' +
                (b.closeReason ? '<div class="bug-detail__sub">关闭 / 非缺陷原因</div><div class="bug-detail__body">' +
                    esc(b.closeReason) + '</div>' : '') +
                '<div class="bug-detail__sub">评估时间线（' + evals.length + ' 次）</div>' +
                evalTimelineHtml(evals) +
                '<div class="bug-detail__sub">修复工单' +
                    (plan.planCode ? '（计划 ' + esc(plan.planCode) + '）' : '') + '</div>' +
                orderListHtml(orders) +
                '</div>';
            $('#bugDetailBox').html(html);
            $('#bugDetailBox').off('click.bugfile')
                .on('click.bugfile', '.bug-file__name', function () {
                    openBugFile($(this).attr('data-id'), $(this).attr('data-name'), false);
                })
                .on('click.bugfile', '.bug-file__dl', function () {
                    openBugFile($(this).attr('data-id'), $(this).attr('data-name'), true);
                });
        }
        Api.bug.detail(id).done(render).fail(function (err) {
            $('#bugDetailBox').html('<div class="bug-detail__empty">' +
                esc((err && err.message) || '加载失败') + '</div>');
        });
        return dlg;
    }

    /* ---------------- 关闭 ---------------- */
    function openClose(row) {
        UI.dialog({
            title: '关闭缺陷（' + str(row.bugCode) + '）', width: 560,
            content: '<form class="el-form" autocomplete="off" onsubmit="return false;">' +
                '<div class="el-form-item"><label class="el-form-item__label">关闭原因 *</label>' +
                '<div class="el-form-item__content"><textarea class="el-input__inner bug-close-reason" ' +
                'id="bcReason" rows="9" ' +
                'placeholder="例如：已在 2.3.1 修复并验收通过 / 客户确认是操作问题 / 重复缺陷合并到 BUG000003"></textarea>' +
                '</div></div></form>',
            onOk: function ($body, close) {
                var reason = $.trim($body.find('#bcReason').val() || '');
                if (!reason) { UI.message({ type: 'warning', message: '请填写关闭原因' }); return; }
                if (reason.length > 500) { UI.message({ type: 'warning', message: '关闭原因不能超过 500 字' }); return; }
                var $ok = $body.closest('.el-dialog').find('.btn-ok');
                $ok.prop('disabled', true);
                Api.bug.close({ id: row.id, closeReason: reason }).done(function (res) {
                    close();
                    UI.message({ type: 'success', message: (res && res.message) || '缺陷已关闭' });
                    loadData();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '关闭失败' });
                }).always(function () { $ok.prop('disabled', false); });
            }
        });
    }

    /* ---------------- 事件绑定 ---------------- */
    function init() {
        initStatusMulti();
        loadProjects();
        loadData();

        $('#bugBtnSearch').on('click', function () {
            state.projectId = $('#bugProject').val() || '';
            state.level = $('#bugLevel').val() || '';
            state.keyword = $.trim($('#bugKeyword').val() || '');
            state.pageNum = 1;
            loadData();
        });
        $('#bugBtnReset').on('click', function () {
            $('#bugProject').val('');
            $('#bugLevel').val('');
            $('#bugKeyword').val('');
            $('#bugStatusMulti .bug-multi__opt input').prop('checked', false);
            syncStatusMulti();
            state.projectId = ''; state.level = ''; state.keyword = ''; state.pageNum = 1;
            loadData();
        });
        $('#bugKeyword').on('keydown', function (e) {
            if (e.keyCode === 13) { $('#bugBtnSearch').trigger('click'); }
        });
        $('#bugBtnRefresh').on('click', function () { loadData(); });
        $('#bugBtnAdd').on('click', function () { openForm(null); });
        $('#bugBtnDetail').on('click', function () {
            var row = selected();
            if (row) { openDetail(row.id); }
        });
        $('#bugBtnEdit').on('click', function () {
            var row = selected();
            if (!row) { return; }
            if (!canEdit(row)) {
                UI.message({ type: 'warning', message: blockReason(row, 'edit') || '当前状态不能编辑' });
                return;
            }
            openForm(row);
        });
        $('#bugBtnEvaluate').on('click', function () {
            var row = selected();
            if (!row) { return; }
            if (!canEvaluate(row)) {
                UI.message({ type: 'warning', message: blockReason(row, 'evaluate') || '当前状态不能评估' });
                return;
            }
            openEvaluate(row);
        });
        $('#bugBtnConfirm').on('click', function () {
            var row = selected();
            if (!row) { return; }
            if (!canConfirm(row)) {
                UI.message({ type: 'warning', message: blockReason(row, 'confirm') ||
                    '只有评估为「是缺陷」（状态已确认）且未生成工单的缺陷才能生成修复工单' });
                return;
            }
            openConfirm(row);
        });
        $('#bugBtnClose').on('click', function () {
            var row = selected();
            if (row) { openClose(row); }
        });

        $tbody.on('change', 'input[name=bugPick]', function () {
            state.selectedId = str(this.value);
            $tbody.find('tr').removeClass('is-selected');
            $(this).closest('tr').addClass('is-selected');
            syncToolbar();
        });
        $tbody.on('click', 'tr[data-id]', function (e) {
            if ($(e.target).is('input, a')) { return; }
            state.selectedId = str($(this).attr('data-id'));
            $tbody.find('tr').removeClass('is-selected');
            $(this).addClass('is-selected');
            $tbody.find('input[name=bugPick][value="' + state.selectedId + '"]').prop('checked', true);
            syncToolbar();
        });
        $tbody.on('dblclick', 'tr[data-id]', function () {
            openDetail($(this).attr('data-id'));
        });
        $tbody.on('click', '.bug-evals-link', function (e) {
            e.stopPropagation();
            openDetail($(this).attr('data-id'));
        });
        $(window).on('resize', function () {
            window.clearTimeout(window.__bugResizeTimer);
            window.__bugResizeTimer = window.setTimeout(layoutRows, 120);
        });
    }

    init();
});
