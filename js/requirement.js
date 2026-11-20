/* requirement.js —— 需求管理（收集 / 评估 / 转研发计划 / 附件） */
jQuery(function ($) {
    var state = { projectId: '', status: '', keyword: '', pageNum: 1, pageSize: 10, total: 0, rows: {}, selectedId: '', employees: null, evalData: null };
    var $tbody = $('#reqTbody');
    var $pager = $('#reqPager');

    function esc(t) { return UI.escapeHtml(t == null ? '' : t); }
    function go(url) {
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    }
    function statusTag(s) {
        var cls = (s === '响应' || s === '已通过') ? 'el-tag--success' :
            (s === '决定不响应' ? 'el-tag--danger' : (s === '已不通过' ? 'el-tag--warning' :
            (s === '已转计划' ? 'el-tag--primary' : 'el-tag--warning')));
        return '<span class="el-tag el-tag--small ' + cls + '">' + esc(s || '待评估') + '</span>';
    }
    function reqStatusValues() {
        var vals = $('#reqStatusMulti .req-multi__opt input:checked').map(function () {
            return $(this).val();
        }).get();
        if (!vals.length) {
            var raw = $('#reqStatus').val();
            if (raw) { vals = String(raw).split(','); }
        }
        return vals;
    }
    function syncReqStatusMulti() {
        var names = $('#reqStatusMulti .req-multi__opt input:checked').map(function () {
            return $(this).parent().text().replace(/\s+/g, ' ').trim();
        }).get();
        $('#reqStatusMulti').toggleClass('has-value', names.length > 0);
        $('#reqStatusMulti .req-multi__text').text(names.length ? names.join('、') : '全部状态');
    }
    function initReqStatusMulti() {
        $('#reqStatusMulti').on('click', '.req-multi__box', function (e) {
            e.stopPropagation();
            var $drop = $('#reqStatusMulti .req-multi__drop');
            $drop.prop('hidden', !$drop.prop('hidden'));
        });
        $('#reqStatusMulti').on('click', '.req-multi__drop', function (e) { e.stopPropagation(); });
        $('#reqStatusMulti').on('change', '.req-multi__opt input', syncReqStatusMulti);
        $('#reqStatusMulti').on('click', '.req-multi__clear', function (e) {
            e.preventDefault(); e.stopPropagation();
            $('#reqStatusMulti .req-multi__opt input').prop('checked', false);
            $('#reqStatus').val('');
            syncReqStatusMulti();
        });
        $(document).on('click.reqMulti', function () {
            $('#reqStatusMulti .req-multi__drop').prop('hidden', true);
        });
        syncReqStatusMulti();
    }

    function selected() { return state.rows[String(state.selectedId)] || null; }

    function syncToolbar() {
        var row = selected();
        var canEval = !!row && (row.status === '待评估' || row.status === '已不通过');
        var canEdit = !!row && row.status !== '已转计划' && row.status !== '响应' &&
            row.status !== '决定不响应' && row.status !== '已通过';
        var canRespond = !!row && row.status === '已通过' && !row.planId;
        $('#reqBtnDetail').prop('disabled', !row);
        $('#reqBtnEvaluate').prop('disabled', !canEval);
        $('#reqBtnRespond').prop('disabled', !canRespond);
        $('#reqBtnEdit').prop('disabled', !canEdit);
        $('#reqBtnEvals').prop('disabled', !row || !(parseInt(row.evalCount, 10) > 0));
        $('#reqBtnPlan').prop('disabled', !row || row.status !== '响应' || !!row.planId);
    }

    function loadProjects() {
        Api.project.page({ pageNum: 1, pageSize: 200 }).done(function (res) {
            var list = (res && res.list) || [], html = '<option value="">全部项目</option>';
            $.each(list, function (i, p) {
                html += '<option value="' + esc(p.id) + '">' + esc(p.projectName) + '</option>';
            });
            $('#reqProject').html(html).val(state.projectId || '');
        });
    }

    /* ---------- 结果区高度自适应：行高拉伸 + 空行补位 ----------
       与 menu-list / org / workplan-orders 同一套口径：
       ① 按表格区可用高度算每页条数（算出来才请求数据，避免多渲染再滚）；
       ② 数据不够一页时把行高均分剩余高度（上限 MAX_ROW_H，别拉成一片大空白）；
       ③ 还不够就补 tr.blank-row，让表格填满卡片、页面不出现纵向滚动条。
       用户手动切换过「条/页」后不再自动算条数（autoSize=false），只做行高拉伸。 */
    var COLS = 12;                       // 表格列数（空行 / 空态 colspan）
    var DEF_ROW_H = 54, MAX_ROW_H = 64;
    var MIN_PAGE_SIZE = 3, MAX_PAGE_SIZE = 100;
    /* 首次渲染时 #reqPager 还是空的（UI.pagination 之后才填），表格区会虚高一个分页条，
       按这个高度先预留，否则算出来的条数偏多 2 条，最后一行会被裁一半 */
    var PAGER_H = 69;
    var autoSize = true, naturalRowH = DEF_ROW_H;

    function isCardMode() { return window.innerWidth <= 768; }
    function isAutoMode() { return autoSize && !isCardMode(); }
    function bodyAvailHeight() {
        var theadH = $('#reqTableWrap').find('thead').outerHeight() || 0;
        return ($('#reqTableWrap').height() || 0) - theadH;
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
            // 缩到手机宽度：表格转卡片，行高必须还原，否则每张卡片被拉成一条高块
            $tbody.find('tr > td').css('height', '');
            return;
        }
        var avail = bodyAvailHeight();
        if (avail <= 0) { return; }
        var $rows = $tbody.children('tr[data-id]');
        if (!$rows.length) {
            // 空态：把空态块撑到表格区高度，卡片下方不留一块白
            var $empty = $tbody.find('tr.empty-row > td');
            if ($empty.length) { $empty.css('height', avail + 'px'); }
            return;
        }
        $tbody.find('tr > td').css('height', '');
        var naturalH = $rows.first().outerHeight() || DEF_ROW_H;
        naturalRowH = naturalH;

        // 行数超过可用高度（首屏 / 窗口变小）：降每页条数重取。只降不升，不会来回请求
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
        // MAX_ROW_H 只限制「拉伸」，不压缩：窄窗口下标题列会换行、自然行高就能到 80+，
        // 硬压到 64 反而算错余数（表格溢出、最后一行被裁）
        if (rowH > MAX_ROW_H && naturalH <= MAX_ROW_H) { rowH = MAX_ROW_H; }
        var rest = avail - rowH * n;

        // 余数比行数还小：摊到前几行，每行 1px，比留一条细缝好看
        if (rest > 0 && rest < n) {
            $rows.children('td').css('height', rowH + 'px');
            $rows.slice(0, rest).children('td').css('height', (rowH + 1) + 'px');
            return;
        }
        $rows.children('td').css('height', rowH + 'px');

        var cnt = Math.floor(rest / rowH);
        if (cnt <= 0) {
            // 余数不够补一整行（矮窗口常见）：把这点高度均摊给已有行，
            // 否则表格底下会留一条 20~40px 的白缝，看起来像没撑满；
            // 均摊后行高会超过上限时，退回「补一条矮空行」，不把单行拉成一片高
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

    function loadData() {
        // 先按可用高度定每页条数（手机端走卡片模式，不介入）
        if (isAutoMode()) {
            var auto = calcPageSize();
            if (auto && auto !== state.pageSize) { state.pageSize = auto; }
        }
        UI.loading($('#reqTableWrap'), true);
        Api.requirement.page({
            projectId: state.projectId, status: state.status,
            keyword: state.keyword, pageNum: state.pageNum, pageSize: state.pageSize
        }).done(function (res) {
            var d = res || {}, list = d.list || [];
            state.total = parseInt(d.total, 10) || 0;
            state.rows = {};
            $('#reqCount').text(state.total);
            if (!list.length) {
                $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                    '<span class="el-table__empty-text">没有符合条件的需求</span></div></td></tr>');
            } else {
                var html = '', startNo = (state.pageNum - 1) * state.pageSize;
                $.each(list, function (i, r) {
                    state.rows[String(r.id)] = r;
                    var hours = parseFloat(r.estimatedHours || 0);
                    html += '<tr data-id="' + esc(r.id) + '"' +
                        (state.selectedId === String(r.id) ? ' class="is-selected"' : '') + '>' +
                        '<td class="is-center"><input type="radio" name="reqPick" value="' + esc(r.id) + '"' +
                            (state.selectedId === String(r.id) ? ' checked' : '') + '></td>' +
                        '<td class="is-center">' + (startNo + i + 1) + '</td>' +
                        '<td>' + esc(r.reqCode) + '</td>' +
                        '<td>' + esc(r.title) + '</td>' +
                        '<td>' + esc(r.projectName || '未关联项目') + '</td>' +
                        '<td>' + esc(r.requesterName || '—') + '</td>' +
                        '<td class="is-center">' + esc(r.priority || '中') + '</td>' +
                        '<td class="is-center">' + statusTag(r.status) + '</td>' +
                        '<td class="is-center">' + (hours ? hours + ' 人时' : '—') + '</td>' +
                        '<td>' + (r.planCode ? esc(r.planCode + ' ' + (r.planName || '')) : '—') + '</td>' +
                        '<td class="is-center"><a href="javascript:;" class="req-evals-link" data-id="' +
                            esc(r.id) + '">' + (parseInt(r.evalCount, 10) || 0) + '</a></td>' +
                        '<td>' + esc((r.createTime || '').slice(0, 16)) + '</td>' +
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
                    // 用户手动选过「条/页」后不再按屏高自动算（否则刚选完又被改回去）
                    if (size !== state.pageSize) { autoSize = false; }
                    state.pageNum = num; state.pageSize = size; loadData();
                }
            });
            // 等 flex 布局稳定后再量高度（刚插入的行还拿不到最终行高）
            window.setTimeout(layoutRows, 30);
        }).fail(function (err) {
            $tbody.html('<tr class="empty-row"><td colspan="' + COLS + '"><div class="el-table__empty-block">' +
                '<span class="el-table__empty-text">' + esc((err && err.message) || '加载失败') + '</span></div></td></tr>');
        }).always(function () { UI.loading($('#reqTableWrap'), false); });
    }

    function projectOptions(selectedId) {
        var html = '<option value="">未关联项目</option>';
        $('#reqProject option').each(function () {
            if (!this.value) { return; }
            html += '<option value="' + esc(this.value) + '"' +
                (this.value === selectedId ? ' selected' : '') + '>' + esc($(this).text()) + '</option>';
        });
        return html;
    }

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

    function uploadFiles(reqId, files, done, fail) {
        if (!files || !files.length) { done(); return; }
        var payload = [], idx = 0;
        function next() {
            if (idx >= files.length) {
                Api.requirement.upload({ requirementId: reqId, files: payload })
                    .done(done).fail(fail);
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

    function uploadEvalFiles(evalId, files, done, fail) {
        if (!files || !files.length) { done(); return; }
        var payload = [], idx = 0;
        function next() {
            if (idx >= files.length) {
                Api.requirement.uploadEval({ evaluationId: evalId, files: payload })
                    .done(done).fail(fail);
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

    function openEvalFile(id, name, download) {
        Api.requirement.fileEval(id).done(function (f) {
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

    function openFile(id, name, download) {
        Api.requirement.file(id).done(function (f) {
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

    function attachmentHtml(files) {
        if (!files || !files.length) { return '<div class="req-detail__empty">还没有附件</div>'; }
        var html = '';
        $.each(files, function (i, f) {
            html += '<div class="req-file"><a href="javascript:;" class="req-file__name" data-id="' + esc(f.id) +
                '" data-name="' + esc(f.name) + '">' + esc(f.name) + '</a>' +
                '<span class="req-file__size">' + Math.round((parseInt(f.size, 10) || 0) / 1024) + ' KB</span>' +
                '<button type="button" class="el-button el-button--text el-button--small req-file__dl" data-id="' +
                esc(f.id) + '" data-name="' + esc(f.name) + '">下载</button></div>';
        });
        return html;
    }

    function openForm(row) {
        var isEdit = !!row;
        var content = '<form class="el-form" id="reqForm" autocomplete="off" onsubmit="return false;">' +
            '<div class="req-form-grid">' +
                '<div class="el-form-item"><label class="el-form-item__label">需求标题 *</label>' +
                    '<div class="el-form-item__content"><input class="el-input__inner" id="rfTitle" maxlength="200"></div></div>' +
                '<div class="el-form-item"><label class="el-form-item__label">所属项目</label>' +
                    '<div class="el-form-item__content"><select class="el-input__inner" id="rfProject">' +
                    projectOptions(isEdit ? row.projectId : '') + '</select></div></div>' +
                '<div class="el-form-item"><label class="el-form-item__label">来源</label>' +
                    '<div class="el-form-item__content"><select class="el-input__inner" id="rfSource">' +
                    ['内部改进', '客户需求', '售前需求', '缺陷修复', '合规安全', '技术债'].map(function (x) {
                        return '<option value="' + x + '">' + x + '</option>';
                    }).join('') + '</select></div></div>' +
                '<div class="el-form-item"><label class="el-form-item__label">优先级</label>' +
                    '<div class="el-form-item__content"><select class="el-input__inner" id="rfPriority">' +
                    ['高', '中', '低'].map(function (x) { return '<option value="' + x + '">' + x + '</option>'; }).join('') +
                    '</select></div></div>' +
                '<div class="el-form-item"><label class="el-form-item__label">期望完成</label>' +
                    '<div class="el-form-item__content"><input class="el-input__inner" type="date" id="rfExpected"></div></div>' +
            '</div>' +
            '<div class="el-form-item req-desc-item">' +
                '<div class="req-desc-head"><span class="req-desc-label">需求描述 / 验收标准</span>' +
                    '<button type="button" class="el-button el-button--small" id="rfImportWord">导入 Word</button>' +
                    '<input type="file" id="rfWordFile" accept=".docx,.docm" style="display:none">' +
                '</div>' +
                '<div class="el-form-item__content"><div class="el-input__inner req-desc" id="rfDesc" contenteditable="true" role="textbox" aria-multiline="true" data-rt-placeholder="请输入需求描述（支持加粗、颜色、列表、链接等富文本），也可导入 Word"></div></div></div>' +
            '<div class="el-form-item"><label class="el-form-item__label">附件</label>' +
                '<div class="el-form-item__content"><input type="file" id="rfFiles" multiple>' +
                '<div class="req-form-files" id="rfFileNames">支持多文件，单个不超过 10 MB</div></div></div>' +
            '</form>';
        var pickedFiles = [];
        UI.dialog({
            title: isEdit ? '编辑需求' : '新增需求', width: 820, content: content,
            onReady: function ($body) {
                $body.closest('.el-dialog').addClass('req-form-dialog');
                var rt = null;
                if (window.RichText) {
                    rt = window.RichText.mount($body.find('#rfDesc'), {
                        placeholder: '请输入需求描述（支持加粗、颜色、列表、链接等富文本）',
                        label: '需求描述格式'
                    });
                }
                if (isEdit) {
                    $body.find('#rfTitle').val(row.title || '');
                    $body.find('#rfSource').val(row.sourceType || '内部改进');
                    $body.find('#rfPriority').val(row.priority || '中');
                    $body.find('#rfExpected').val((row.expectedDate || '').slice(0, 10));
                    if (rt) {
                        rt.setHtml(row.descriptionHtml || window.RichText.textToHtml(row.description || ''));
                    } else {
                        $body.find('#rfDesc').val(row.description || '');
                    }
                }
                $body.find('#rfTitle').trigger('focus');
                function renderPickedFiles() {
                    var $box = $body.find('#rfFileNames'), html = '';
                    if (!pickedFiles.length) {
                        $box.html('<span class="req-file-hint">支持多文件，单个不超过 10 MB</span>');
                        return;
                    }
                    $.each(pickedFiles, function (i, f) {
                        html += '<span class="req-file-chip" title="' + esc(f.name) + '">' +
                            '<span class="req-file-chip__name">' + esc(f.name) + '</span>' +
                            '<button type="button" class="req-file-chip__del" data-idx="' + i +
                            '" title="删除该附件" aria-label="删除该附件">×</button></span>';
                    });
                    $box.html(html);
                }
                renderPickedFiles();
                $body.on('change', '#rfFiles', function () {
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
                $body.on('click', '.req-file-chip__del', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var idx = parseInt($(this).attr('data-idx'), 10);
                    if (!isNaN(idx)) { pickedFiles.splice(idx, 1); renderPickedFiles(); }
                });
                var WI = window.WordImport;
                $body.on('click', '#rfImportWord', function () {
                    if (!WI) { UI.message({ type: 'warning', message: '当前页面未加载 Word 导入组件' }); return; }
                    $body.find('#rfWordFile').trigger('click');
                });
                $body.on('change', '#rfWordFile', function () {
                    var input = this, file = (this.files || [])[0];
                    try { input.value = ''; } catch (e) { /* 忽略 */ }
                    if (!file || !WI) { return; }
                    var name = file.name || 'document.docx';
                    if (/\.doc$/i.test(name)) {
                        UI.message({ type: 'warning', message: '旧版 .doc 请先另存为 .docx 再导入' }); return;
                    }
                    if (!/\.(docx|docm)$/i.test(name)) {
                        UI.message({ type: 'warning', message: '只支持 .docx / .docm 格式' }); return;
                    }
                    if (file.size && file.size > 10 * 1024 * 1024) {
                        UI.message({ type: 'warning', message: 'Word 文档不能超过 10 MB' }); return;
                    }
                    $.when(WI.fileToBase64(file)).done(function (dataUrl) {
                        Api.project.importDoc({ data: dataUrl, fileName: name }).done(function (res) {
                            var html = WI.sanitize((res && res.html) || '');
                            if (!html) {
                                UI.message({ type: 'warning', message: 'Word 文档里没有可导入的文字内容' }); return;
                            }
                            function put(replace) {
                                var next = replace ? html : ((rt ? rt.html() : ($body.find('#rfDesc').val() || '')) + html);
                                if (rt) { rt.setHtml(next); } else { $body.find('#rfDesc').val(WI.toText(next)); }
                                UI.message({ type: 'success', message: (res && res.message) || ('已导入「' + name + '」') });
                            }
                            var hasText = rt ? !!$.trim(rt.text()) : !!$.trim($body.find('#rfDesc').val());
                            if (hasText) {
                                UI.confirm({
                                    title: '导入 Word', type: 'info',
                                    message: '需求描述已有内容：点「替换」覆盖，点「追加」接到末尾。',
                                    confirmText: '替换', cancelText: '追加'
                                }).done(function (replace) { put(!!replace); });
                            } else {
                                put(true);
                            }
                        }).fail(function (err) {
                            UI.message({ type: 'error', message: (err && err.message) || 'Word 导入失败' });
                        });
                    }).fail(function (err) {
                        UI.message({ type: 'error', message: (err && err.message) || '读取 Word 文件失败' });
                    });
                });
            },
            onOk: function ($body, close) {
                var title = $.trim($body.find('#rfTitle').val());
                if (!title) { UI.message({ type: 'warning', message: '请填写需求标题' }); return; }
                var rt = window.RichText ? window.RichText.of($body.find('#rfDesc')) : null;
                var payload = {
                    title: title, projectId: $body.find('#rfProject').val(),
                    sourceType: $body.find('#rfSource').val(), priority: $body.find('#rfPriority').val(),
                    expectedDate: $body.find('#rfExpected').val(),
                    description: rt ? rt.text() : $body.find('#rfDesc').val(),
                    descriptionHtml: rt ? rt.html() : ''
                };
                var req = isEdit ? Api.requirement.update($.extend({ id: row.id }, payload))
                    : Api.requirement.add(payload);
                req.done(function (res) {
                    var reqId = isEdit ? row.id : (res && res.id);
                    if (!reqId) { close(); loadData(); return; }
                    uploadFiles(reqId, pickedFiles, function (up) {
                        close(); loadData();
                        UI.message({ type: 'success', message: (res && res.message) || '已保存' });
                    }, function (msg) {
                        close(); loadData();
                        UI.message({ type: 'error', message: (msg || '附件上传失败') + '；需求已保存' });
                    });
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    function ensureEmployees(cb) {
        if (state.employees) { cb(state.employees); return; }
        Api.emp.page({ pageNum: 1, pageSize: 300 }).done(function (res) {
            state.employees = (res && res.list) || [];
            cb(state.employees);
        }).fail(function () { cb([]); });
    }

    function ensureEvalData(cb) {
        if (state.evalData) { cb(state.evalData); return; }
        Api.org.page({ pageNum: 1, pageSize: 1000 }).done(function (orgRes) {
            Api.emp.page({ pageNum: 1, pageSize: 500 }).done(function (empRes) {
                state.evalData = {
                    orgs: (orgRes && orgRes.list) || [],
                    emps: (empRes && empRes.list) || []
                };
                cb(state.evalData);
            }).fail(function () { cb({ orgs: [], emps: [] }); });
        }).fail(function () {
            Api.emp.page({ pageNum: 1, pageSize: 500 }).done(function (empRes) {
                cb({ orgs: [], emps: (empRes && empRes.list) || [] });
            }).fail(function () { cb({ orgs: [], emps: [] }); });
        });
    }

    function evalTreeHtml(data) {
        var orgs = data.orgs || [], emps = data.emps || [];
        var byParent = {}, byId = {}, empByDept = {};
        $.each(orgs, function (i, d) {
            byId[String(d.id)] = d;
            var p = String(d.parentId || 0);
            (byParent[p] = byParent[p] || []).push(d);
        });
        $.each(emps, function (i, e) {
            var did = String(e.deptId || 0);
            (empByDept[did] = empByDept[did] || []).push(e);
        });
        function ancestors(did) {
            var out = [], cur = String(did || 0), guard = 0;
            while (cur && byId[cur] && guard++ < 30) {
                out.push(cur);
                cur = String(byId[cur].parentId || 0);
            }
            return out.join(',');
        }
        function empHtml(e, did, level) {
            var id = e.empId || e.id;
            var name = e.nameCn || e.name || '';
            return '<label class="req-tree-emp" style="padding-left:' + (10 + level * 16) + 'px">' +
                '<input type="checkbox" class="req-tree-emp-check" value="' + esc(id) + '" data-dept="' + esc(did) +
                '" data-name="' + esc(name) + '" data-ancestors="' + esc(ancestors(did)) + '">' +
                esc(name) + (e.code ? '（' + esc(e.code) + '）' : '') + '</label>';
        }
        function empsHtml(did, level) {
            return $.map(empByDept[String(did)] || [], function (e) { return empHtml(e, did, level); }).join('');
        }
        function deptHtml(d, level) {
            var kids = byParent[String(d.id)] || [];
            var emps2 = empByDept[String(d.id)] || [];
            var has = kids.length || emps2.length;
            var html = '<div class="req-tree-dept">' +
                '<div class="req-tree-row" style="padding-left:' + (level * 16) + 'px">' +
                    '<span class="req-tree-caret' + (has ? '' : ' is-empty') + '" data-tree-toggle="1">' +
                        (has ? '▾' : '') + '</span>' +
                    '<label class="req-tree-dept-label"><input type="checkbox" class="req-tree-dept-check" data-dept="' +
                        esc(d.id) + '"> ' + esc(d.nameCn || d.name || '') + '</label>' +
                '</div><div class="req-tree-children">';
            $.each(kids, function (i, k) { html += deptHtml(k, level + 1); });
            html += empsHtml(d.id, level + 1) + '</div></div>';
            return html;
        }
        var html = '';
        $.each(byParent['0'] || [], function (i, d) { html += deptHtml(d, 0); });
        var orphan = [];
        $.each(emps, function (i, e) {
            var did = String(e.deptId || 0);
            if (!did || !byId[did]) { orphan.push(e); }
        });
        if (orphan.length) {
            html += '<div class="req-tree-dept"><div class="req-tree-row">' +
                '<span class="req-tree-caret is-empty"></span>' +
                '<label class="req-tree-dept-label"><input type="checkbox" class="req-tree-dept-check" data-dept="0"> 未分部门</label>' +
                '</div><div class="req-tree-children">' +
                $.map(orphan, function (e) { return empHtml(e, 0, 1); }).join('') + '</div></div>';
        }
        return html || '<div class="req-tree-empty">暂无人员数据</div>';
    }

    function openEvaluate(row) {
        ensureEvalData(function (data) {
            var tree = evalTreeHtml(data);
            var content = '<div class="req-eval">' +
                '<div class="el-form-item"><label class="el-form-item__label">评估结论</label><div class="el-form-item__content">' +
                '<label><input type="radio" name="reResult" value="通过" checked> 通过</label> ' +
                '<label style="margin-left:14px"><input type="radio" name="reResult" value="不通过"> 不通过</label></div></div>' +
                '<div class="el-form-item"><label class="el-form-item__label">评估工时（人时）</label><div class="el-form-item__content">' +
                '<input class="el-input__inner" type="number" min="0" step="0.5" id="reHours"></div></div>' +
                '<div class="el-form-item" id="reFinalItem" style="display:none"><label class="el-form-item__label">后续处理</label>' +
                '<div class="el-form-item__content"><label><input type="radio" name="reFinal" value="继续评估" checked> 继续评估</label> ' +
                '<label style="margin-left:14px"><input type="radio" name="reFinal" value="决定不响应"> 决定不响应（终止评估）</label>' +
                '</div></div>' +
                '<div class="el-form-item req-eval-field">' +
                    '<div class="req-eval-head"><span class="req-eval-label">原因 / 意见</span>' +
                        '<button type="button" class="el-button el-button--small" id="reImportWord">导入 Word</button>' +
                        '<input type="file" id="reWordFile" accept=".docx,.docm" style="display:none"></div>' +
                    '<div class="el-form-item__content"><div class="req-eval-reason" id="reReason" ' +
                    'contenteditable="true" role="textbox" aria-multiline="true" ' +
                    'data-rt-placeholder="请输入评估原因 / 意见（支持富文本）"></div></div></div>' +
                '<div class="el-form-item req-eval-field"><label class="req-eval-label">评估附件</label>' +
                    '<div class="el-form-item__content"><input type="file" id="reFiles" multiple>' +
                    '<div class="req-form-files" id="reFileNames"><span class="req-file-hint">支持多文件，单个不超过 10 MB</span></div></div></div>' +
                '<div class="el-form-item req-eval-field"><label class="req-eval-label">参与评估人 *</label>' +
                    '<div class="el-form-item__content"><div class="req-emp-picker">' +
                        '<div class="req-emp-picker__box" id="reEmpBox">' +
                            '<span class="req-emp-picker__text" id="reEmpText">请选择参与评估人</span>' +
                            '<span class="req-emp-picker__caret">▾</span></div>' +
                        '<div class="req-emp-picker__drop" id="reEmpDrop" hidden>' + tree + '</div>' +
                    '</div></div></div></div>';
            var evalFiles = [];
            UI.dialog({
                title: '需求评估 —— ' + (row.reqCode || ''), width: 680, content: content,
                onReady: function ($body) {
                    var evalRt = window.RichText ? window.RichText.mount($body.find('#reReason'), {
                        placeholder: '请输入评估原因 / 意见（支持富文本）',
                        label: '原因格式'
                    }) : null;
                    $body.closest('.el-dialog').addClass('req-eval-dialog');
                    function renderEvalFiles() {
                        var $box = $body.find('#reFileNames'), html = '';
                        if (!evalFiles.length) {
                            $box.html('<span class="req-file-hint">支持多文件，单个不超过 10 MB</span>');
                            return;
                        }
                        $.each(evalFiles, function (i, f) {
                            html += '<span class="req-file-chip" title="' + esc(f.name) + '">' +
                                '<span class="req-file-chip__name">' + esc(f.name) + '</span>' +
                                '<button type="button" class="req-file-chip__del" data-idx="' + i +
                                '" title="删除该附件">×</button></span>';
                        });
                        $box.html(html);
                    }
                    $body.on('change', '#reFiles', function () {
                        var input = this, i;
                        for (i = 0; i < (input.files || []).length; i++) {
                            var f = input.files[i], dup = false, j;
                            for (j = 0; j < evalFiles.length; j++) {
                                if (evalFiles[j].name === f.name && evalFiles[j].size === f.size &&
                                    evalFiles[j].lastModified === f.lastModified) { dup = true; break; }
                            }
                            if (!dup) { evalFiles.push(f); }
                        }
                        try { input.value = ''; } catch (e) { }
                        renderEvalFiles();
                    });
                    $body.on('click', '.req-file-chip__del', function (e) {
                        e.preventDefault();
                        e.stopPropagation();
                        var idx = parseInt($(this).attr('data-idx'), 10);
                        if (!isNaN(idx)) { evalFiles.splice(idx, 1); renderEvalFiles(); }
                    });
                    var WI = window.WordImport;
                    $body.on('click', '#reImportWord', function () {
                        if (!WI) { UI.message({ type: 'warning', message: '当前页面未加载 Word 导入组件' }); return; }
                        $body.find('#reWordFile').trigger('click');
                    });
                    $body.on('change', '#reWordFile', function () {
                        var input = this, file = (this.files || [])[0];
                        try { input.value = ''; } catch (e) { }
                        if (!file || !WI) { return; }
                        var fname = file.name || 'document.docx';
                        if (/\.doc$/i.test(fname)) {
                            UI.message({ type: 'warning', message: '旧版 .doc 请先另存为 .docx 再导入' }); return;
                        }
                        if (!/\.(docx|docm)$/i.test(fname)) {
                            UI.message({ type: 'warning', message: '只支持 .docx / .docm 格式' }); return;
                        }
                        if (file.size && file.size > 10 * 1024 * 1024) {
                            UI.message({ type: 'warning', message: 'Word 文档不能超过 10 MB' }); return;
                        }
                        $.when(WI.fileToBase64(file)).done(function (dataUrl) {
                            Api.project.importDoc({ data: dataUrl, fileName: fname }).done(function (res) {
                                var html = WI.sanitize((res && res.html) || '');
                                if (!html) {
                                    UI.message({ type: 'warning', message: 'Word 文档里没有可导入的文字内容' }); return;
                                }
                                function put(replace) {
                                    var next = replace ? html : ((evalRt ? evalRt.html() : '') + html);
                                    if (evalRt) { evalRt.setHtml(next); } else { $body.find('#reReason').html(next); }
                                    UI.message({ type: 'success', message: (res && res.message) || ('已导入「' + fname + '」') });
                                }
                                var hasText = evalRt ? !!$.trim(evalRt.text()) : !!$.trim($body.find('#reReason').text());
                                if (hasText) {
                                    UI.confirm({
                                        title: '导入 Word', type: 'info',
                                        message: '原因已有内容：点「替换」覆盖，点「追加」接到末尾。',
                                        confirmText: '替换', cancelText: '追加'
                                    }).done(function (replace) { put(!!replace); });
                                } else {
                                    put(true);
                                }
                            }).fail(function (err) {
                                UI.message({ type: 'error', message: (err && err.message) || 'Word 导入失败' });
                            });
                        }).fail(function (err) {
                            UI.message({ type: 'error', message: (err && err.message) || '读取 Word 文件失败' });
                        });
                    });
                    function selectedEmps() {
                        return $body.find('.req-tree-emp-check:checked').map(function () {
                            return { id: this.value, name: $(this).attr('data-name') || '' };
                        }).get();
                    }
                    function updateSummary() {
                        var list = selectedEmps(), names = [];
                        $.each(list, function (i, e) { names.push(e.name); });
                        $body.find('#reEmpText').text(list.length
                            ? ('已选 ' + list.length + ' 人：' + names.join('、'))
                            : '请选择参与评估人');
                    }
                    function syncDeptChecks() {
                        $body.find('.req-tree-dept-check').each(function () {
                            var did = String($(this).attr('data-dept')), total = 0, checked = 0;
                            $body.find('.req-tree-emp-check').each(function () {
                                var anc = String($(this).attr('data-ancestors') || '').split(',');
                                if (String($(this).attr('data-dept')) === did || $.inArray(did, anc) >= 0) {
                                    total++;
                                    if (this.checked) { checked++; }
                                }
                            });
                            this.checked = total > 0 && checked === total;
                            this.indeterminate = checked > 0 && checked < total;
                        });
                    }
                    $body.on('change', 'input[name=reResult]', function () {
                        var fail = $(this).val() !== '通过';
                        $body.find('#reHours').closest('.el-form-item').toggle(!fail);
                        $body.find('#reFinalItem').toggle(fail);
                    });
                    $body.on('click', '#reEmpBox', function (e) {
                        e.stopPropagation();
                        var $drop = $body.find('#reEmpDrop');
                        var show = $drop.prop('hidden');
                        if (show) {
                            var rect = this.getBoundingClientRect();
                            $drop.toggleClass('is-up', (window.innerHeight - rect.bottom) < 300);
                        }
                        $drop.prop('hidden', !show);
                    });
                    $body.on('click', '#reEmpDrop', function (e) { e.stopPropagation(); });
                    $body.on('click', '.req-tree-caret[data-tree-toggle]', function (e) {
                        e.stopPropagation();
                        var $kids = $(this).closest('.req-tree-dept').children('.req-tree-children');
                        $kids.toggle();
                        $(this).text($kids.is(':visible') ? '▾' : '▸');
                    });
                    $body.on('change', '.req-tree-dept-check', function () {
                        var did = String($(this).attr('data-dept')), on = this.checked;
                        $body.find('.req-tree-emp-check').each(function () {
                            var anc = String($(this).attr('data-ancestors') || '').split(',');
                            if (String($(this).attr('data-dept')) === did || $.inArray(did, anc) >= 0) {
                                this.checked = on;
                            }
                        });
                        syncDeptChecks(); updateSummary();
                    });
                    $body.on('change', '.req-tree-emp-check', function () {
                        syncDeptChecks(); updateSummary();
                    });
                },
                onOk: function ($body, close) {
                    var result = $body.find('input[name=reResult]:checked').val();
                    var evalRt = window.RichText ? window.RichText.of($body.find('#reReason')) : null;
                    var reason = evalRt ? evalRt.text() : $.trim($body.find('#reReason').text());
                    var ids = $body.find('.req-tree-emp-check:checked').map(function () { return this.value; }).get();
                    var finalDecision = result === '通过' ? '响应'
                        : ($body.find('input[name=reFinal]:checked').val() || '继续评估');
                    if (result === '不通过' && !$.trim(reason)) {
                        UI.message({ type: 'warning', message: '评估不通过时必须填写原因' }); return;
                    }
                    Api.requirement.evaluate({
                        id: row.id, result: result, finalDecision: finalDecision,
                        estimatedHours: $body.find('#reHours').val(),
                        reason: reason,
                        reasonHtml: evalRt ? evalRt.html() : '',
                        evaluatorIds: ids
                    }).done(function (res) {
                        function finish() {
                            UI.message({ type: 'success', message: (res && res.message) || '评估已保存' });
                            close(); loadData();
                        }
                        if (evalFiles.length && res && res.id) {
                            uploadEvalFiles(res.id, evalFiles, function (up) {
                                UI.message({ type: 'success', message: (up && up.message) || '评估及附件已保存' });
                                close(); loadData();
                            }, function (msg) {
                                UI.message({ type: 'error', message: (msg || '附件上传失败') + '；评估已保存' });
                                close(); loadData();
                            });
                        } else {
                            finish();
                        }
                    }).fail(function (err) {
                        UI.message({ type: 'error', message: (err && err.message) || '评估失败' });
                    });
                }
            });
        });
    }

    function openDetail(row) {
        Api.requirement.detail(row.id).done(function (res) {
            var d = res || {}, r = d.requirement || row;
            var plans = d.plan || {}, evals = d.evaluations || [], files = d.files || [];
            var html = '<div class="req-detail">' +
                '<div class="req-detail__row"><b>编号：</b>' + esc(r.reqCode) + '　<b>状态：</b>' + statusTag(r.status) + '</div>' +
                '<div class="req-detail__row"><b>标题：</b>' + esc(r.title) + '</div>' +
                '<div class="req-detail__row"><b>项目：</b>' + esc(r.projectName || '未关联项目') +
                    '　<b>提出人：</b>' + esc(r.requesterName || '—') +
                    '　<b>优先级：</b>' + esc(r.priority || '中') + '</div>' +
                '<div class="req-detail__row"><b>评估工时：</b>' + (r.estimatedHours || '—') +
                    ' 人时　<b>期望完成：</b>' + esc((r.expectedDate || '—').slice(0, 10)) +
                    '　<b>需求验收人：</b>' + esc(r.acceptOwnerName || '计划创建人（默认）') + '</div>' +
                ((r.description || r.descriptionHtml) ? '<div class="req-detail__row"><b>描述：</b>' +
                    '<div class="req-detail__pre">' + (r.descriptionHtml || esc(r.description)) + '</div></div>' : '') +
                (plans.id ? '<div class="req-detail__row"><b>研发计划：</b>' + esc(plans.planCode + ' ' + (plans.planName || '')) +
                    ' <a href="javascript:;" class="req-open-plan" data-id="' + esc(plans.id) + '">打开计划</a></div>' : '') +
                '<div class="req-detail__sub">附件（' + files.length + '）' +
                    '<button type="button" class="el-button el-button--text el-button--small" id="reqUploadBtn">上传附件</button>' +
                    '<input type="file" id="reqFileInput" multiple style="display:none"></div>' +
                '<div id="reqFileList">' + attachmentHtml(files) + '</div>' +
                '<div class="req-detail__sub">评估记录（' + evals.length + '）</div>';
            if (!evals.length) { html += '<div class="req-detail__empty">还没有评估记录</div>'; }
            $.each(evals, function (i, e) {
                html += '<div class="req-detail__eval"><b>' + esc(e.result) + '</b> · ' + esc(e.operatorName || '') +
                    ' · ' + esc((e.createTime || '').slice(0, 16)) +
                    '<div>评估人：' + esc(e.evaluatorNames || '—') + '　工时：' + (e.estimatedHours || '—') + ' 人时</div>' +
                    ((e.reason || e.reasonHtml) ? '<div>原因 / 意见：' +
                        (e.reasonHtml || esc(e.reason)) + '</div>' : '') + '</div>';
            });
            html += '</div>';
            UI.dialog({
                title: '需求详情 —— ' + (r.reqCode || ''), width: 760, content: html,
                onReady: function ($body, close) {
                    var $dlg = $body.closest('.el-dialog');
                    $dlg.find('.btn-ok').attr('hidden', 'hidden');
                    $dlg.find('.btn-cancel').text('关闭');
                    $body.on('click', '.req-open-plan', function () {
                        go('workplan-design.html?id=' + encodeURIComponent($(this).attr('data-id')));
                    });
                    $body.on('click', '.req-file__name', function () {
                        openFile($(this).attr('data-id'), $(this).attr('data-name'), false);
                    });
                    $body.on('click', '.req-file__dl', function () {
                        openFile($(this).attr('data-id'), $(this).attr('data-name'), true);
                    });
                    $body.on('click', '#reqUploadBtn', function () { $body.find('#reqFileInput').trigger('click'); });
                    $body.on('change', '#reqFileInput', function () {
                        var picked = [], i;
                        for (i = 0; i < (this.files || []).length; i++) { picked.push(this.files[i]); }
                        if (!picked.length) { return; }
                        uploadFiles(r.id, picked, function (res) {
                            UI.message({ type: 'success', message: (res && res.message) || '附件已上传' });
                            close(); openDetail(r);
                        }, function (msg) {
                            UI.message({ type: 'error', message: msg || '上传失败' });
                        });
                    });
                }
            });
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '加载失败' });
        });
    }

    function openRespond(row) {
        var content = '<div class="el-form">' +
            '<div class="el-form-item"><label class="el-form-item__label">需求</label>' +
                '<div class="el-form-item__content">' + esc(row.reqCode + ' / ' + (row.title || '')) + '</div></div>' +
            '<div class="el-form-item"><label class="el-form-item__label">响应否</label>' +
                '<div class="el-form-item__content"><label><input type="radio" name="respDecision" value="响应" checked> 响应</label> ' +
                '<label style="margin-left:16px"><input type="radio" name="respDecision" value="决定不响应"> 决定不响应</label></div></div>' +
            '<div class="el-form-item"><label class="el-form-item__label">说明 / 原因</label>' +
                '<div class="el-form-item__content"><textarea class="el-input__inner" id="respRemark" rows="4" ' +
                'placeholder="决定不响应时必须填写原因"></textarea></div></div>' +
            '<div class="el-form-item"><label class="el-form-item__label">评估工时（可选）</label>' +
                '<div class="el-form-item__content"><input class="el-input__inner" type="number" min="0" step="0.5" id="respHours"></div></div>' +
            '</div>';
        UI.dialog({
            title: '响应否 —— ' + (row.reqCode || ''), width: 600, content: content,
            onReady: function ($body) {
                $body.find('#respRemark').trigger('focus');
            },
            onOk: function ($body, close) {
                var decision = $body.find('input[name=respDecision]:checked').val();
                var remark = $.trim($body.find('#respRemark').val());
                if (decision === '决定不响应' && !remark) {
                    UI.message({ type: 'warning', message: '决定不响应时必须填写说明 / 原因' }); return;
                }
                Api.requirement.respond({
                    id: row.id, decision: decision, remark: remark,
                    estimatedHours: $body.find('#respHours').val() || 0
                }).done(function (res) {
                    UI.message({ type: 'success', message: (res && res.message) || '响应否已保存' });
                    close(); loadData();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    function openTimeline(row) {
        Api.requirement.detail(row.id).done(function (res) {
            var r = (res && res.requirement) || row;
            var evals = (res && res.evaluations) || [];
            var html = '<div class="req-timeline">';
            if (!evals.length) {
                html += '<div class="req-tl-empty">还没有评估记录</div>';
            }
            $.each(evals, function (i, e) {
                var final = e.finalDecision || (e.result === '通过' ? '响应' : '继续评估');
                var cls = e.result === '通过' ? '' : (final === '决定不响应' ? 'is-final' : 'is-fail');
                var resultCls = e.result === '通过' ? 'el-tag--success' :
                    (final === '决定不响应' ? 'el-tag--danger' : 'el-tag--warning');
                var finalCls = final === '响应' ? 'el-tag--success' :
                    (final === '决定不响应' ? 'el-tag--danger' : 'el-tag--info');
                var reason = e.reasonHtml || (e.reason ? esc(e.reason) : '');
                html += '<div class="req-tl-item ' + cls + '">' +
                    '<span class="req-tl-dot"></span>' +
                    '<div class="req-tl-head"><b>第 ' + (i + 1) + ' 次评审</b>' +
                        '<span class="el-tag el-tag--small ' + resultCls + '">' + esc(e.result) + '</span>' +
                        '<span class="el-tag el-tag--small ' + finalCls + '">最终：' + esc(final) + '</span>' +
                        '<span class="req-tl-time">' + esc((e.createTime || '').slice(0, 16)) + '</span>' +
                    '</div>' +
                    '<div class="req-tl-meta">评审人：' + esc(e.operatorName || '—') +
                        '　参与评估：' + esc(e.evaluatorNames || '—') +
                        (parseFloat(e.estimatedHours || 0) ? '　工时：' + e.estimatedHours + ' 人时' : '') +
                    '</div>' +
                    (reason ? '<div class="req-tl-reason">' + reason + '</div>' : '') +
                    ((e.files && e.files.length) ? '<div class="req-tl-files">附件：' +
                        $.map(e.files, function (f) {
                            return '<a href="javascript:;" class="req-eval-file" data-id="' + esc(f.id) +
                                '" data-name="' + esc(f.name) + '">' + esc(f.name) + '</a>';
                        }).join(' ') + '</div>' : '') +
                '</div>';
            });
            html += '</div>';
            UI.dialog({
                title: '评估记录 / 时间线 —— ' + (r.reqCode || ''), width: 780, content: html,
                onReady: function ($body) {
                    var $dlg = $body.closest('.el-dialog');
                    $dlg.find('.btn-ok').attr('hidden', 'hidden');
                    $dlg.find('.btn-cancel').text('关闭');
                    $body.on('click', '.req-eval-file', function (e) {
                        e.preventDefault();
                        openEvalFile($(this).attr('data-id'), $(this).attr('data-name'), false);
                    });
                }
            });
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '评估记录加载失败' });
        });
    }

    function createPlan(row) {
        ensureEmployees(function (list) {
            var options = '<option value="">请选择验收人</option>';
            $.each(list, function (i, e) {
                var id = e.empId || e.id;
                options += '<option value="' + esc(id) + '">' + esc(e.nameCn || e.name || '') + '</option>';
            });
            var content = '<form class="el-form" onsubmit="return false;">' +
                '<div class="el-form-item"><label class="el-form-item__label">需求</label><div class="el-form-item__content">' +
                    esc(row.reqCode + ' / ' + row.title) + '</div></div>' +
                '<div class="el-form-item"><label class="el-form-item__label">需求验收人</label><div class="el-form-item__content">' +
                    '<label><input type="radio" name="paOwnerType" value="default" checked> 计划创建人（默认）</label><br>' +
                    (row.projectId ? '<label><input type="radio" name="paOwnerType" value="project"> 项目负责人</label><br>' : '') +
                    '<label><input type="radio" name="paOwnerType" value="custom"> 指定验收人</label>' +
                    '<select class="el-input__inner" id="paOwnerSelect" style="margin-top:6px;display:none">' + options + '</select>' +
                '</div></div>' +
                '<div class="el-form-item"><label class="el-form-item__label">说明</label><div class="el-form-item__content">' +
                    '生成一条与需求一对一的研发计划，后续在计划中编排任务。</div></div></form>';
            UI.dialog({
                title: '生成研发计划', width: 560, content: content,
                onReady: function ($body) {
                    $body.on('change', 'input[name=paOwnerType]', function () {
                        $body.find('#paOwnerSelect').toggle($(this).val() === 'custom');
                    });
                },
                onOk: function ($body, close) {
                    var type = $body.find('input[name=paOwnerType]:checked').val();
                    var ownerId = $body.find('#paOwnerSelect').val();
                    if (type === 'custom' && !ownerId) {
                        UI.message({ type: 'warning', message: '请选择指定的验收人' }); return;
                    }
                    Api.requirement.createPlan({
                        id: row.id, acceptOwnerType: type, acceptOwnerId: ownerId
                    }).done(function (res) {
                        UI.message({ type: 'success', message: (res && res.message) || '已生成研发计划' });
                        close(); loadData();
                        if (res && res.planId) { go('workplan-design.html?id=' + encodeURIComponent(res.planId)); }
                    }).fail(function (err) {
                        UI.message({ type: 'error', message: (err && err.message) || '生成计划失败' });
                    });
                }
            });
        });
    }

    $('#reqBtnSearch').on('click', function () {
        state.projectId = $('#reqProject').val() || '';
        state.status = reqStatusValues().join(',');
        state.keyword = $.trim($('#reqKeyword').val());
        state.pageNum = 1; loadData();
    });
    $('#reqBtnReset').on('click', function () {
        $('#reqProject').val(''); $('#reqKeyword').val('');
        $('#reqStatusMulti .req-multi__opt input').prop('checked', false);
        $('#reqStatus').val('');
        syncReqStatusMulti();
        state.projectId = ''; state.status = ''; state.keyword = ''; state.selectedId = '';
        state.pageNum = 1; loadData();
    });
    $('#reqKeyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#reqBtnSearch').trigger('click'); } });
    $('#reqBtnAdd').on('click', function () { openForm(null); });
    $('#reqBtnRefresh').on('click', loadData);
    $('#reqBtnDetail').on('click', function () { var r = selected(); if (r) { openDetail(r); } });
    $('#reqBtnEvaluate').on('click', function () { var r = selected(); if (r) { openEvaluate(r); } });
    $('#reqBtnRespond').on('click', function () { var r = selected(); if (r) { openRespond(r); } });
    $('#reqBtnEdit').on('click', function () { var r = selected(); if (r) { openForm(r); } });
    $('#reqBtnEvals').on('click', function () { var r = selected(); if (r) { openTimeline(r); } });
    $('#reqBtnPlan').on('click', function () { var r = selected(); if (r) { createPlan(r); } });
    $tbody.on('click', '.req-evals-link', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var row = state.rows[String($(this).attr('data-id'))];
        if (row) { state.selectedId = String(row.id); openTimeline(row); }
    });

    $tbody.on('click', 'tr[data-id]', function (e) {
        if ($(e.target).is('input[type=radio]')) { return; }
        state.selectedId = String($(this).attr('data-id'));
        $tbody.find('tr[data-id]').removeClass('is-selected');
        $(this).addClass('is-selected');
        $tbody.find('input[name=reqPick]').prop('checked', false);
        $(this).find('input[name=reqPick]').prop('checked', true);
        syncToolbar();
    });
    $tbody.on('change', 'input[name=reqPick]', function () {
        state.selectedId = String($(this).val());
        $tbody.find('tr[data-id]').removeClass('is-selected');
        $(this).closest('tr').addClass('is-selected');
        syncToolbar();
    });
    $tbody.on('dblclick', 'tr[data-id]', function () {
        state.selectedId = String($(this).attr('data-id'));
        openDetail(selected());
    });

    /* ---------- 窗口尺寸变化：条数 / 行高重算（节流 150ms，拖窗口时别狂发请求） ---------- */
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
    // 首屏字体 / 图片就位后高度会变，load 完再量一次兜底
    $(window).on('load', function () { window.setTimeout(layoutRows, 60); });

    initReqStatusMulti();
    loadProjects();
    loadData();
});
