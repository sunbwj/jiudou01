/* ==========================================================================
   project-detail.js —— 项目管理 · 项目详情（project-detail.html，打页模式）
   --------------------------------------------------------------------------
   · 左 70%：两个 Tab —— 「项目基本信息」字段表 / 「项目说明」富文本（project.detail）；
   · 右 30%：项目文件区，与项目管理页同款「文件列表 / 目录」双标签：
       - 文件列表：检索 + 刷新 + 双击在线预览（复用 js/file-preview.js）；
       - 目录：projectDir.tree + 当前检索后的文件组装树，展开 / 折叠、单击选中、
         双击文件预览、文件节点拖拽移动所属目录（按落点坐标解析目标目录）；
   · 通过 ?id=<UUID> 进入；由项目信息页「查看项目」按钮打页打开。
   ========================================================================== */
jQuery(function ($) {
    var $body = $('#pjDetailBody');
    var $desc = $('#pjDescBody');
    var $plans = $('#pjPlansBody');
    var $plansTbody = $('#pjPlansTbody');
    var $plansPager = $('#pjPlansPager');
    var plansState = { loaded: false, pageNum: 1, pageSize: 10, total: 0, rows: {} };
    var $pfTbody = $('#pfPanelTbody');
    var $pfWrapper = $('#pfPanelWrapper');
    var $pfTreeView = $('#pfTreeView');
    var projectId = '';
    var keyword = '';
    var pfRows = {};
    var selectedFileId = '';
    var state = {
        pfView: 'list',                 // 文件区展示方式：list=文件列表 / tree=目录视图
        dirTree: [], dirRows: {}, selectedDirId: '', treeCollapsed: {}, dragFileId: ''
    };

    function esc(text) { return UI.escapeHtml(text == null ? '' : text); }
    function queryParam(name) {
        var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search || '');
        return m ? decodeURIComponent(m[1]) : '';
    }
    function badge(ok) {
        return ok ? '<span class="el-tag el-tag--success">启用</span>'
            : '<span class="el-tag el-tag--info">停用</span>';
    }
    function pubBadge(pub) {
        return pub === false || pub === 0
            ? '<span class="el-tag el-tag--warning">私有</span>'
            : '<span class="el-tag el-tag--info">公用</span>';
    }
    function row(label, value) {
        return '<div class="pj-detail__row"><div class="pj-detail__label">' + esc(label) +
            '</div><div class="pj-detail__value">' + value + '</div></div>';
    }

    /* ---------------- 左栏：项目基本信息 / 项目说明 双 Tab ---------------- */
    function renderDetail(d) {
        if (!d) {
            $body.html('<div class="pj-detail__empty">未找到该项目（可能已被删除或无查看权限）</div>');
            $desc.html('<div class="pj-detail__empty">未找到该项目（可能已被删除或无查看权限）</div>');
            return;
        }
        var html = '';
        html += row('项目编号', esc(d.projectCode || ''));
        html += row('项目名称', '<b>' + esc(d.projectName || '') + '</b>');
        html += row('项目类型', esc(d.projectType || '其它'));
        html += row('项目状态', esc(d.projectStatus || '未开始'));
        html += row('公用否', pubBadge(d.ispub));
        html += row('启用状态', badge(d.enabled));
        html += row('创建人', esc(d.createEname || '-'));
        html += row('创建时间', esc(d.createTime || ''));
        html += row('文件数', esc(parseInt(d.fileCount, 10) || 0));
        $body.html(html);

        var desc = d.projectDesc || d.projectDescHtml || '';
        $desc.html('<div class="pj-detail__desc">' +
            '<div class="pj-detail__desc-label">项目说明</div>' +
            '<div class="pj-detail__desc-box">' + (desc
                ? desc
                : '<span class="pj-detail__empty" style="padding:8px 0">（暂无项目说明）</span>') +
            '</div></div>');
        $('#pfPanelProject').text('—— ' + (d.projectName || '') + '（' + (d.projectCode || '') + '）');
    }
    function loadDetail() {
        UI.loading($body, true, '加载中…');
        Api.project.detail(projectId).done(function (d) {
            renderDetail(d);
        }).fail(function (err) {
            var msg = esc((err && err.message) || '项目详情加载失败');
            $body.html('<div class="pj-detail__empty">' + msg + '</div>');
            $desc.html('<div class="pj-detail__empty">' + msg + '</div>');
        }).always(function () { UI.loading($body, false); });
    }
    /** 切换左栏 Tab：信息 / 说明 / 工作计划（计划首次打开时加载） */
    function switchDetailTab(which) {
        var info = which === 'info', desc = which === 'desc', plans = which === 'plans';
        $('#dtTabInfo').toggleClass('is-active', info).attr('aria-selected', info ? 'true' : 'false');
        $('#dtTabDesc').toggleClass('is-active', desc).attr('aria-selected', desc ? 'true' : 'false');
        $('#dtTabPlans').toggleClass('is-active', plans).attr('aria-selected', plans ? 'true' : 'false');
        $body.toggle(info);
        $desc.toggle(desc);
        $plans.toggle(plans);
        if (plans) {
            $plans.css('display', 'flex');
            window.setTimeout(layoutPlanRows, 30);
            loadPlans(plansState.pageNum);
        }
    }

    function planStatusTag(status) {
        var cls = status === '已启动' ? 'is-on' : (status === '已停止' ? 'is-stop' : 'is-off');
        return '<span class="pj-plan-status ' + cls + '">' + esc(status || '未启动') + '</span>';
    }

    function renderPlans(data) {
        var list = (data && data.list) || [];
        plansState.total = parseInt(data && data.total, 10) || 0;
        $('#pjPlansCount').text(plansState.total);
        if (!list.length) {
            $plansTbody.html('<tr><td colspan="9"><div class="pj-detail__empty">该项目还没有工作计划</div></td></tr>');
            $plansPager.empty();
            return;
        }
        plansState.rows = {};
        var html = '', startNo = (plansState.pageNum - 1) * plansState.pageSize;
        $.each(list, function (i, p) {
            plansState.rows[String(p.id)] = p;
            var dates = (p.startDate || p.endDate)
                ? (esc(p.startDate || '—') + ' ~ ' + esc(p.endDate || '—')) : '—';
            var pct = parseInt(p.progress, 10) || 0;
            html += '<tr data-id="' + esc(p.id) + '">' +
                '<td class="is-center">' + (startNo + i + 1) + '</td>' +
                '<td>' + esc(p.planCode || '—') + '</td>' +
                '<td>' + esc(p.planName || '—') + '</td>' +
                '<td class="is-center">' + planStatusTag(p.status) + '</td>' +
                '<td>' + dates + '</td>' +
                '<td class="is-center">' + (parseInt(p.taskCount, 10) || 0) + '</td>' +
                '<td class="is-center">' + pct + '%</td>' +
                '<td class="is-center">' + (parseInt(p.orderCount, 10) || 0) + '</td>' +
                '<td>' + esc(p.createEname || '—') + '</td></tr>';
        });
        $plansTbody.html(html);
        window.setTimeout(layoutPlanRows, 30);
        UI.pagination($plansPager, {
            total: plansState.total, pageNum: plansState.pageNum, pageSize: plansState.pageSize,
            sizes: [10, 20, 50],
            onChange: function (num, size) {
                plansState.pageNum = num;
                plansState.pageSize = size;
                loadPlans(num);
            }
        });
    }

    function blankPlanRow(height) {
        var tds = '';
        for (var c = 0; c < 9; c++) { tds += '<td style="height:' + height + 'px"></td>'; }
        return '<tr class="blank-row">' + tds + '</tr>';
    }

    /** 行高拉伸 + 空行补全：让计划表格铺满 Tab 剩余高度（与计划工单 / 列表页同一风格） */
    function layoutPlanRows() {
        $('#pjPlansTbody tr.blank-row').remove();
        var $rows = $('#pjPlansTbody tr[data-id]');
        if (!$rows.length) { return; }
        var wrap = document.getElementById('pjPlansWrap');
        var head = document.querySelector('#pjPlansTable thead');
        if (!wrap || !head) { return; }
        var avail = (wrap.clientHeight || 0) - (head.offsetHeight || 0);
        if (avail <= 0) { return; }
        $rows.children('td').css('height', '');
        var natural = $rows.first().outerHeight() || 34;
        var n = $rows.length;
        var rowH = Math.max(natural, Math.min(60, Math.floor(avail / n)));
        var rest = avail - rowH * n;
        $rows.children('td').css('height', rowH + 'px');
        if (rest <= 0) { return; }
        var cnt = Math.floor(rest / rowH);
        if (cnt <= 0 && rest > 8) {
            $('#pjPlansTbody').append(blankPlanRow(rest));
            return;
        }
        if (cnt <= 0) { return; }
        var rem = rest - cnt * rowH;
        var html = '';
        for (var i = 0; i < cnt; i++) {
            html += blankPlanRow(rowH + (i === cnt - 1 ? rem : 0));
        }
        $('#pjPlansTbody').append(html);
    }

    /** 双击计划：弹窗查看计划工单 + 原工作计划视图（甘特图 / 日历图 / 网格，最大化） */
    function openPlanOrders(plan) {
        if (!plan) { return; }
        var content = '<div class="pj-plan-dialog">' +
            '<div class="pj-plan-dialog__tabs">' +
                '<button type="button" class="pj-plan-dialog__tab is-active" data-ptab="orders">计划工单</button>' +
                '<button type="button" class="pj-plan-dialog__tab" data-ptab="plan">工作计划</button>' +
            '</div>' +
            '<div class="pj-plan-pane" id="pjPlanOrdersPane">' +
                '<div class="pj-plan-orders__meta" id="pjPlanOrdersMeta">正在加载工单…</div>' +
                '<div class="pj-plan-orders__wrap"><table class="pj-plan-orders__table">' +
                    '<thead><tr><th class="is-center" style="width:52px">序号</th><th style="width:110px">工单号</th>' +
                    '<th>任务名称</th><th style="width:90px">责任人</th><th style="width:130px">参与人员</th>' +
                    '<th class="is-center" style="width:86px">工单状态</th><th class="is-center" style="width:86px">执行状态</th>' +
                    '<th style="width:150px">计划起止</th><th style="width:150px">实际起止</th><th style="width:132px">派发时间</th>' +
                    '<th class="is-center" style="width:76px">执行记录</th><th class="is-center" style="width:76px">变更历史</th>' +
                    '<th class="is-center" style="width:80px">验收状态</th><th class="is-center" style="width:64px">操作</th>' +
                    '</tr></thead><tbody id="pjPlanOrdersTbody"></tbody></table></div>' +
            '</div>' +
            '<div class="pj-plan-pane" id="pjPlanTasksPane" hidden>' +
                '<div class="pj-plan-frame"><iframe id="pjPlanFrame" title="计划视图" src="about:blank"></iframe></div>' +
            '</div>' +
            '</div>';
        var dlg = UI.dialog({
            title: '计划 —— ' + (plan.planName || plan.planCode || ''),
            width: 960, maximizable: true, maximized: true,
            content: content,
            onReady: function ($body) {
                var $dlg = $body.closest('.el-dialog');
                $dlg.find('.btn-ok').attr('hidden', 'hidden');
                $dlg.find('.btn-cancel').text('关闭');
                $dlg.addClass('pj-plan-orders-dialog');
                var frameLoaded = false;

                /* ---------- 计划工单（含实际起止 / 验收） ---------- */
                var orderMap = {};
                function loadOrders() {
                    $body.find('#pjPlanOrdersMeta').text('正在加载工单…');
                    Api.workPlan.planOrders({
                        planId: plan.id, pageNum: 1, pageSize: 500
                    }).done(function (res) {
                        var rows = (res && res.list) || [];
                        var total = parseInt(res && res.total, 10) || 0;
                        orderMap = {};
                        $body.find('#pjPlanOrdersMeta').text('计划：' + (plan.planCode || '') + '　共 ' + total + ' 张工单');
                        var $tb = $body.find('#pjPlanOrdersTbody');
                        if (!rows.length) {
                            $tb.html('<tr><td colspan="14"><div class="pj-detail__empty">该计划还没有派发工单</div></td></tr>');
                            return;
                        }
                        var out = '';
                        $.each(rows, function (i, o) {
                            orderMap[String(o.orderId)] = o;
                            var dates = (o.startDate || o.endDate)
                                ? (esc(o.startDate || '—') + ' ~ ' + esc(o.endDate || '—')) : '—';
                            var actual = (o.actualStartTime || o.actualEndTime)
                                ? (esc((o.actualStartTime || '—').slice(0, 16)) + ' ~ ' +
                                   esc((o.actualEndTime || '—').slice(0, 16))) : '—';
                            var accept = o.acceptStatus || '待验收';
                            var acceptCls = accept === '已验收' ? 'el-tag--success'
                                : (accept === '验收不通过' ? 'el-tag--danger' : 'el-tag--info');
                            var canAccept = plan.canAccept && o.status === '已完成' && accept !== '已验收';
                            out += '<tr>' +
                                '<td class="is-center">' + (i + 1) + '</td>' +
                                '<td>' + esc(o.orderCode || '—') + '</td>' +
                                '<td>' + esc(o.taskName || '—') + '</td>' +
                                '<td>' + esc(o.ownerName || '—') + '</td>' +
                                '<td>' + esc(o.participantNames || '—') + '</td>' +
                                '<td class="is-center">' + esc(o.status || '待处理') + '</td>' +
                                '<td class="is-center">' + esc(o.execStatus || '未开始') + '</td>' +
                                '<td>' + dates + '</td>' +
                                '<td style="font-size:11px">' + actual + '</td>' +
                                '<td>' + esc(o.dispatchTime || '—') + '</td>' +
                                '<td class="is-center">' + (parseInt(o.execCount, 10) || 0) + '</td>' +
                                '<td class="is-center">' + (parseInt(o.changeCount, 10) || 0) + '</td>' +
                                '<td class="is-center"><span class="el-tag el-tag--small ' + acceptCls + '">' +
                                    esc(accept) + '</span></td>' +
                                '<td class="is-center">' + (canAccept
                                    ? '<button type="button" class="el-button el-button--text el-button--small pj-order-accept" data-id="' +
                                        esc(o.orderId) + '">验收</button>' : '—') + '</td>' +
                                '</tr>';
                        });
                        $tb.html(out);
                    }).fail(function (err) {
                        $body.find('#pjPlanOrdersMeta').text((err && err.message) || '工单加载失败');
                    });
                }
                loadOrders();

                $body.on('click', '.pj-order-accept', function () {
                    var order = orderMap[String($(this).attr('data-id'))];
                    if (!order) { return; }
                    var content = '<form class="el-form" onsubmit="return false;">' +
                        '<div class="el-form-item"><label class="el-form-item__label">工单</label>' +
                        '<div class="el-form-item__content">' + esc(order.orderCode + ' / ' + (order.taskName || '')) +
                        '</div></div>' +
                        '<div class="el-form-item"><label class="el-form-item__label">验收结论</label>' +
                        '<div class="el-form-item__content"><label><input type="radio" name="paResult" value="已验收" checked> 已验收</label> ' +
                        '<label style="margin-left:14px"><input type="radio" name="paResult" value="验收不通过"> 验收不通过</label></div></div>' +
                        '<div class="el-form-item"><label class="el-form-item__label">意见 / 原因</label>' +
                        '<div class="el-form-item__content"><textarea class="el-input__inner" id="paRemark" rows="3"></textarea></div></div>' +
                        '</form>';
                    UI.dialog({
                        title: '工单验收 —— ' + (order.orderCode || ''), width: 520, content: content,
                        onOk: function ($d, close) {
                            var result = $d.find('input[name=paResult]:checked').val();
                            var remark = $.trim($d.find('#paRemark').val());
                            if (result === '验收不通过' && !remark) {
                                UI.message({ type: 'warning', message: '验收不通过时必须填写原因' }); return;
                            }
                            Api.requirement.acceptOrder({
                                orderId: order.orderId, result: result, remark: remark
                            }).done(function (res) {
                                UI.message({ type: 'success', message: (res && res.message) || '验收结果已保存' });
                                close();
                                loadOrders();
                            }).fail(function (err) {
                                UI.message({ type: 'error', message: (err && err.message) || '验收失败' });
                            });
                        }
                    });
                });

                /* ---------- 工作计划：直接嵌入原设计页（embed=1 只保留视图区） ---------- */
                $body.on('click', '.pj-plan-dialog__tab', function () {
                    var tab = $(this).attr('data-ptab');
                    $body.find('.pj-plan-dialog__tab').removeClass('is-active');
                    $(this).addClass('is-active');
                    $body.find('#pjPlanOrdersPane').prop('hidden', tab !== 'orders');
                    $body.find('#pjPlanTasksPane').prop('hidden', tab !== 'plan');
                    if (tab === 'plan' && !frameLoaded) {
                        frameLoaded = true;
                        $body.find('#pjPlanFrame').attr('src',
                            'workplan-design.html?id=' + encodeURIComponent(plan.id) +
                            '&embed=1&view=gantt');
                    }
                });
            }
        });
        return dlg;
    }

    function loadPlans(pageNum) {
        if (!projectId) { return; }
        plansState.pageNum = pageNum || plansState.pageNum || 1;
        plansState.loaded = true;
        $plansTbody.html('<tr><td colspan="9"><div class="pj-detail__empty">加载中…</div></td></tr>');
        Api.workPlan.projectPlans({
            projectId: projectId, pageNum: plansState.pageNum, pageSize: plansState.pageSize
        }).done(renderPlans).fail(function (err) {
            $plansTbody.html('<tr><td colspan="9"><div class="pj-detail__empty">' +
                esc((err && err.message) || '计划加载失败') + '</div></td></tr>');
            $plansPager.empty();
        });
    }

    /* ---------------- 右栏：文件列表 ---------------- */
    function busyTarget() { return state.pfView === 'tree' ? $pfTreeView : $pfWrapper; }
    function pfEmpty(text) {
        $pfTbody.html('<tr class="empty-row"><td colspan="5">' +
            '<div class="el-table__empty-block"><span class="el-table__empty-text">' +
            esc(text) + '</span></div></td></tr>');
    }
    function renderPfRows(data) {
        var list = (data && data.list) || [];
        pfRows = {};
        if (!list.length) { pfEmpty('该项目还没有文件'); return; }
        var html = '';
        for (var i = 0; i < list.length; i++) {
            var f = list[i];
            pfRows[f.id] = f;
            html += '<tr data-id="' + esc(f.id) + '" title="双击在线预览">' +
                '<td class="is-center">' + (i + 1) + '</td>' +
                '<td><b>' + esc(f.fileName) + '</b>' +
                    (f.fileDesc ? '<div class="pj-sub">' + esc(f.fileDesc) + '</div>' : '') + '</td>' +
                '<td>' + esc(f.fileType || '其它') + '</td>' +
                '<td class="is-center">' + esc(f.fileSizeText || '') + '</td>' +
                '<td>' + esc(String(f.uploadTime || '').slice(0, 10)) + '</td>' +
                '</tr>';
        }
        $pfTbody.html(html);
    }
    function loadFiles() {
        if (!projectId) { pfEmpty('缺少项目标识'); return; }
        var $busy = busyTarget();
        UI.loading($busy, true, '加载中…');
        Api.projectFile.page({
            projectId: projectId, keyword: keyword,
            orderBy: 'fileName', pageNum: 1, pageSize: 200
        }).done(function (data) {
            renderPfRows(data);
            renderTreeView();             // 目录视图与列表共用同一份文件数据
        }).fail(function (err) {
            pfRows = {};
            pfEmpty((err && err.message) || '文件列表加载失败');
            renderTreeView();
        }).always(function () { UI.loading($busy, false); });
    }
    function selectedFile() { return pfRows[selectedFileId] || null; }
    function downloadFile(file) {
        if (!file) { return; }
        Api.projectFile.download(file.id).done(function (res) {
            var url = res.downloadUrl || ('/' + String(res.filePath || '').replace(/^\/+/, ''));
            UI.message({ type: 'success', message: (res && res.message) || '已生成下载地址' });
            try {
                var a = document.createElement('a');
                a.href = url;
                a.setAttribute('download', res.fileName || file.fileName || '');
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } catch (e) { /* 浏览器拦截时仍可见地址 */ }
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '下载失败' });
        });
    }
    function previewFile(file) {
        if (!file) { return; }
        if (!file.enabled) {
            UI.message({ type: 'warning', message: '文件「' + file.fileName + '」已停用，不能预览 / 下载' });
            return;
        }
        if (window.FilePreview && window.FilePreview.preview) {
            window.FilePreview.preview(file, { onDownload: downloadFile });
        } else {
            downloadFile(file);
        }
    }

    /* ---------------- 右栏：目录视图（与 project.js 同款） ---------------- */
    var ICO_FOLDER = '<svg class="pj-tnode__ico" viewBox="0 0 24 24"><path fill="currentColor" d="M3 5h7l2 2h9v12H3V5z"/></svg>';
    var ICO_FILE = '<svg class="pj-tnode__ico" viewBox="0 0 24 24"><path fill="currentColor" d="M6 2h8l5 5v15H6V2zm7 1.5V8h4.5L13 3.5z"/></svg>';

    function treeNodeHtml(kind, item, level, hasChildren, collapsed, selected) {
        var indent = 8 + (level - 1) * 16;
        var caret = hasChildren
            ? '<span class="pj-tnode__caret is-clickable" data-toggle="' + esc(item.id) + '">' +
                (collapsed ? '▸' : '▾') + '</span>'
            : '<span class="pj-tnode__caret"></span>';
        var name = kind === 'dir' ? item.dirName : item.fileName;
        var meta = kind === 'dir'
            ? ((parseInt(item.fileCount, 10) || 0) + ' 文件')
            : (item.fileSizeText || '');
        var tip = kind === 'dir'
            ? '单击选中文件夹；把文件拖到本行或它下面的文件上都算移入本目录'
            : '单击选中、双击在线预览；按住可拖到其它目录（落点所在的文件夹就是目标目录）';
        return '<div class="pj-tnode pj-tnode--' + kind + (selected ? ' is-selected' : '') + '"' +
            ' data-kind="' + kind + '" data-id="' + esc(item.id) + '"' +
            (kind === 'file' ? ' draggable="true"' : '') +
            ' style="padding-left:' + indent + 'px" title="' + esc(tip) + '">' +
            caret + (kind === 'dir' ? ICO_FOLDER : ICO_FILE) +
            '<span class="pj-tnode__name">' + esc(name) + '</span>' +
            '<span class="pj-tnode__meta">' + esc(meta) + '</span></div>';
    }
    /** 目录节点是否可见：所有祖先都处于展开状态 */
    function treeDirVisible(dir, collapsedMap, dirMap) {
        var p = dir.parentId, guard = 0;
        while (p && guard < 10) {
            if (collapsedMap[p]) { return false; }
            var parent = dirMap[p];
            if (!parent) { break; }
            p = parent.parentId;
            guard++;
        }
        return true;
    }
    /** 选中态只就地改 class，不重建 DOM —— 重建会让双击的第二次点击落到新节点上 */
    function paintTreeSelection() {
        $pfTreeView.find('.pj-tnode').each(function () {
            var $n = $(this), kind = $n.attr('data-kind'), id = $n.attr('data-id') || '';
            var sel = kind === 'dir'
                ? String(state.selectedDirId) === id
                : (kind === 'file' && String(selectedFileId) === id);
            $n.toggleClass('is-selected', sel);
        });
    }
    /** 组装目录 + 文件树（文件取当前检索后的 pfRows），无「项目根目录」节点 */
    function renderTreeView() {
        if (!$pfTreeView.length) { return; }
        if (!projectId) {
            $pfTreeView.html('<div class="pj-tnode__empty">缺少项目标识，无法展示目录</div>');
            return;
        }
        var dirs = state.dirTree || [], files = [], id, i;
        for (id in pfRows) {
            if (pfRows.hasOwnProperty(id)) { files.push(pfRows[id]); }
        }
        files.sort(function (a, b) {
            var an = String(a.fileName || ''), bn = String(b.fileName || '');
            return an < bn ? -1 : (an > bn ? 1 : 0);
        });
        var childDirs = {}, dirFiles = {}, rootFiles = [];
        for (i = 0; i < dirs.length; i++) {
            var d = dirs[i], key = d.parentId || '';
            if (!childDirs[key]) { childDirs[key] = []; }
            childDirs[key].push(d);
        }
        for (i = 0; i < files.length; i++) {
            var f = files[i], did = f.dirId || '';
            if (did && state.dirRows[did]) {
                if (!dirFiles[did]) { dirFiles[did] = []; }
                dirFiles[did].push(f);
            } else {
                rootFiles.push(f);       // 未关联目录 / 目录不可见 → 挂到项目根
            }
        }
        var html = '';
        var visited = {};                // 防环 / 防重复
        function drawDir(dir, level) {
            if (!dir || !dir.id || visited[dir.id]) { return; }
            if (!treeDirVisible(dir, state.treeCollapsed, state.dirRows)) { return; }
            visited[dir.id] = 1;
            level = level || dir.level || 1;
            var kids = childDirs[dir.id] || [], fs = dirFiles[dir.id] || [];
            var collapsed = !!state.treeCollapsed[dir.id];
            html += treeNodeHtml('dir', dir, level,
                kids.length > 0 || fs.length > 0, collapsed,
                String(state.selectedDirId) === String(dir.id));
            if (collapsed) { return; }
            /* 循环变量各自独立声明，递归返回不会重置父层下标（父目录 ≥2 个子目录时必现） */
            for (var fi = 0; fi < fs.length; fi++) {
                html += treeNodeHtml('file', fs[fi], level + 1, false, false,
                    String(selectedFileId) === String(fs[fi].id));
            }
            for (var ci = 0; ci < kids.length; ci++) { drawDir(kids[ci], level + 1); }
        }
        var roots = childDirs[''] || [];
        for (i = 0; i < roots.length; i++) { drawDir(roots[i], roots[i].level || 1); }
        for (i = 0; i < rootFiles.length; i++) {
            html += treeNodeHtml('file', rootFiles[i], 1, false, false,
                String(selectedFileId) === String(rootFiles[i].id));
        }
        if (!dirs.length && !files.length) {
            html += '<div class="pj-tnode__empty">该项目还没有目录与文件</div>';
        }
        /* 提示条固定在列表末尾，避免拖拽开始时把整棵树往下顶 */
        html += '<div class="pj-tree__rootdrop" data-drop-root="1" title="拖到此处把文件移出目录">' +
            '松手后文件移出目录，回到项目根</div>';
        $pfTreeView.html(html);
    }
    function loadDirTree() {
        var pid = projectId;
        state.dirTree = []; state.dirRows = {}; state.selectedDirId = '';
        if (!pid) { renderTreeView(); return; }
        Api.projectDir.tree({ projectId: pid }).done(function (data) {
            if (String(projectId) !== String(pid)) { return; }
            state.dirTree = (data && data.list) || [];
            for (var i = 0; i < state.dirTree.length; i++) {
                state.dirRows[state.dirTree[i].id] = state.dirTree[i];
            }
            renderTreeView();
        }).fail(function () {
            state.dirTree = []; state.dirRows = {};
            renderTreeView();
        });
    }
    function switchPfView(view) {
        state.pfView = view === 'tree' ? 'tree' : 'list';
        $('#pfTabList').toggleClass('is-active', state.pfView === 'list')
            .attr('aria-selected', state.pfView === 'list' ? 'true' : 'false');
        $('#pfTabTree').toggleClass('is-active', state.pfView === 'tree')
            .attr('aria-selected', state.pfView === 'tree' ? 'true' : 'false');
        $pfWrapper.toggle(state.pfView === 'list');
        $pfTreeView.toggle(state.pfView === 'tree');
        if (state.pfView === 'tree') { renderTreeView(); }
    }
    /** 刷新：文件与目录并行加载，谁后到谁触发最后一次渲染 */
    function refreshFileArea() { loadFiles(); loadDirTree(); }

    /* ---------------- 目录视图：展开目标目录链 / 拖拽移动 ---------------- */
    function expandDirChain(dirId) {
        var id = dirId, guard = 0;
        while (id && state.dirRows[id] && guard < 12) {
            state.treeCollapsed[id] = false;
            id = state.dirRows[id].parentId || '';
            guard++;
        }
    }
    function moveFileToDir(fileId, dirId) {
        var file = pfRows[fileId];
        if (!file) { UI.message({ type: 'warning', message: '找不到被拖动的文件，请刷新后重试' }); return; }
        dirId = dirId || '';
        if (String(file.dirId || '') === String(dirId)) {
            UI.message({ type: 'info', message: '文件「' + file.fileName + '」已在该位置' });
            return;
        }
        var dirName = dirId && state.dirRows[dirId] ? state.dirRows[dirId].dirName : '';
        var $b = busyTarget();
        UI.loading($b, true);
        Api.projectFile.update({ id: file.id, dirId: dirId }).done(function () {
            UI.message({ type: 'success', message: dirId
                ? '文件「' + file.fileName + '」已移动到「' + dirName + '」'
                : '文件「' + file.fileName + '」已移出目录，回到项目根' });
            selectedFileId = file.id;
            state.selectedDirId = '';
            expandDirChain(dirId);
            refreshFileArea();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '移动失败' });
        }).always(function () { UI.loading($b, false); });
    }
    function dragId() { return state.dragFileId || ''; }
    function clearDragState() {
        state.dragFileId = '';
        $pfTreeView.removeClass('is-dragging');
        $pfTreeView.find('.is-dragging, .is-drop-target').removeClass('is-dragging is-drop-target');
    }
    /** 落点元素：优先按坐标命中，取不到坐标（jsdom）时退回事件目标 */
    function dropElementOf(e) {
        var oe = e.originalEvent || {};
        var x = (e.clientX != null) ? e.clientX : oe.clientX;
        var y = (e.clientY != null) ? e.clientY : oe.clientY;
        if (typeof x === 'number' && typeof y === 'number' && document.elementFromPoint) {
            var hit = null;
            try { hit = document.elementFromPoint(x, y); } catch (err) { hit = null; }
            if (hit && $pfTreeView[0] && $pfTreeView[0].contains(hit)) { return hit; }
        }
        return oe.target || e.target || null;
    }
    /** 解析落点 → {dirId, $node}：dirId 为空表示移到项目根 */
    function dropTargetOf(e) {
        var el = dropElementOf(e);
        if (!el) { return null; }
        var $node = $(el).closest('.pj-tnode', $pfTreeView[0]);
        if (!$node.length) { return { dirId: '', $node: $() }; }
        var kind = $node.attr('data-kind'), id = $node.attr('data-id') || '';
        if (kind === 'file') {
            var f = pfRows[id];
            var did = (f && f.dirId && state.dirRows[f.dirId]) ? String(f.dirId) : '';
            return {
                dirId: did,
                $node: did ? $pfTreeView.find('.pj-tnode--dir[data-id="' + did + '"]').first() : $()
            };
        }
        return { dirId: id, $node: $node };
    }
    function paintDropTarget(t) {
        $pfTreeView.find('.is-drop-target').removeClass('is-drop-target');
        if (!t) { return; }
        if (t.dirId) {
            if (t.$node && t.$node.length) { t.$node.addClass('is-drop-target'); }
        } else {
            $pfTreeView.find('.pj-tree__rootdrop').addClass('is-drop-target');
        }
    }

    /* ---------------- 事件 ---------------- */
    $('#dtTabInfo').on('click', function () { switchDetailTab('info'); });
    $('#dtTabDesc').on('click', function () { switchDetailTab('desc'); });
    $('#dtTabPlans').on('click', function () { switchDetailTab('plans'); });
    $plansTbody.on('dblclick', 'tr[data-id]', function () {
        var id = $(this).attr('data-id');
        openPlanOrders(plansState.rows[String(id)]);
    });
    $(window).on('resize', function () {
        window.clearTimeout(window.__pjPlansResize);
        window.__pjPlansResize = window.setTimeout(layoutPlanRows, 150);
    });
    $('#dtPlansGoto').on('click', function () {
        var url = 'workplan.html?projectId=' + encodeURIComponent(projectId);
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    });
    $('#btnBack').on('click', function () {
        if (window.AppNav && window.AppNav.go) { window.AppNav.go('project.html'); }
        else if (window.history.length > 1) { window.history.back(); }
        else { window.location.href = 'project.html'; }
    });
    $('#btnPfRefresh').on('click', function () { refreshFileArea(); });
    $('#btnPfSearch').on('click', function () {
        keyword = $.trim($('#pfKeyword').val());
        refreshFileArea();
    });
    $('#pfKeyword').on('keydown', function (e) { if (e.keyCode === 13) { $('#btnPfSearch').trigger('click'); } });
    $('#pfTabList').on('click', function () { switchPfView('list'); });
    $('#pfTabTree').on('click', function () { switchPfView('tree'); });

    $pfTbody.on('click', 'tr[data-id]', function () {
        selectedFileId = $(this).attr('data-id');
        state.selectedDirId = '';
        $pfTbody.find('tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        paintTreeSelection();
    });
    $pfTbody.on('dblclick', 'tr[data-id]', function () {
        selectedFileId = $(this).attr('data-id');
        previewFile(selectedFile());
    });

    /* 目录视图：展开 / 折叠、单击选中、双击文件预览 */
    $pfTreeView.on('click', '.pj-tnode__caret.is-clickable', function (e) {
        e.stopPropagation();
        var id = $(this).attr('data-toggle');
        state.treeCollapsed[id] = !state.treeCollapsed[id];
        renderTreeView();
    });
    $pfTreeView.on('click', '.pj-tnode', function () {
        var kind = $(this).attr('data-kind'), id = $(this).attr('data-id') || '';
        state.selectedDirId = kind === 'dir' ? id : '';
        selectedFileId = kind === 'file' ? id : '';
        $pfTbody.find('tr').removeClass('is-selected');
        if (kind === 'file') { $pfTbody.find('tr[data-id="' + id + '"]').addClass('is-selected'); }
        paintTreeSelection();          // 就地改选中态，保住双击预览
    });
    $pfTreeView.on('dblclick', '.pj-tnode--file', function (e) {
        e.preventDefault();
        var id = $(this).attr('data-id') || '';
        var file = pfRows[id];
        if (file) { previewFile(file); return; }
        Api.projectFile.detail(id).done(function (d) {
            if (d) { previewFile(d); }
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '打开文件预览失败' });
        });
    });

    /* 拖拽：整棵树接管 dragenter / dragover / drop，按坐标解析目标目录 */
    $pfTreeView.on('dragstart', '.pj-tnode--file', function (e) {
        state.dragFileId = $(this).attr('data-id') || '';
        var oe = e.originalEvent || {};
        if (oe.dataTransfer) {
            try {
                oe.dataTransfer.effectAllowed = 'move';
                oe.dataTransfer.setData('text/plain', state.dragFileId);
            } catch (err) { /* 个别浏览器限制 dragstart 里的 dataTransfer，忽略 */ }
        }
        $(this).addClass('is-dragging');
        $pfTreeView.addClass('is-dragging');
    });
    $pfTreeView.on('dragend', '.pj-tnode--file', clearDragState);
    $pfTreeView.on('dragenter dragover', function (e) {
        if (!dragId()) { return; }
        e.preventDefault();
        var oe = e.originalEvent || {};
        if (oe.dataTransfer) { try { oe.dataTransfer.dropEffect = 'move'; } catch (err) { } }
        paintDropTarget(dropTargetOf(e));
    });
    $pfTreeView.on('dragleave', function (e) {
        var oe = e.originalEvent || {}, to = oe.relatedTarget;
        if (to && $pfTreeView[0] && $pfTreeView[0].contains(to)) { return; }
        $pfTreeView.find('.is-drop-target').removeClass('is-drop-target');
    });
    $pfTreeView.on('drop', function (e) {
        var fileId = dragId();
        if (!fileId) { return; }
        e.preventDefault();
        var t = dropTargetOf(e);
        clearDragState();
        if (t) { moveFileToDir(fileId, t.dirId); }
    });

    /* ---------------- 启动 ---------------- */
    projectId = queryParam('id');
    if (!projectId) {
        $body.html('<div class="pj-detail__empty">缺少项目标识（请通过项目信息页「查看项目」进入）</div>');
        $desc.html('<div class="pj-detail__empty">缺少项目标识（请通过项目信息页「查看项目」进入）</div>');
        pfEmpty('缺少项目标识');
        renderTreeView();
        return;
    }
    switchDetailTab('info');
    loadDetail();
    refreshFileArea();
});
