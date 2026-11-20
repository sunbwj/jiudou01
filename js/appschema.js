/* appschema.js —— 数据中心 · 应用结构（库 / 表 / 视图 / 索引 / 触发器 / 过程 / 函数 / 字段 + 版本脚本 + 实库对比）
   设计口径（与后端 server/app_schema.py 一致）：
     · 结构树只读本地设计态表；扫描只是「同步器」，手工录入与扫描写同一套表，靠 source + locked 区分；
     · 每次保存出一个草稿（整库快照 + 变更明细），**发布**才生成正式版号与正向 / 回滚脚本；
     · 脚本永不自动执行，只能人工执行后回写状态；
     · 与真实库的对比只在人工点「开始对比」时发生，结果落库留存。 */
jQuery(function ($) {
    var state = {
        appId: '', apps: [], meta: null,
        tree: null,
        expanded: {},
        kind: '', id: '', name: '',           // 当前选中的节点（db / obj）
        dbId: '', dbName: '',
        obj: null,
        cols: [],
        versions: [], ver: null, verCache: {},
        scriptKind: 'forward',
        cmp: null, cmpItems: [], cmpDiffOnly: false,
        cmpConns: null, cmpConnId: '', cmpDb: '', cmpConnName: '', cmpConnHost: '',
        lineage: null, lineageCol: '',       // 字段血缘：分析结果 + 当前选中的字段
        lgObjCols: {},                       // 手工标注弹窗：objId → 字段清单（缓存，避免来回切重复请求）
        picked: {},                          // 勾选待导出的表 / 视图（objId → 1）
        tab: 'cols'
    };
    function esc(t) { return UI.escapeHtml(t == null ? '' : t); }
    function go(url) {
        if (window.AppNav && window.AppNav.go) { window.AppNav.go(url); }
        else { window.location.href = url; }
    }
    function trim(t) { return $.trim(t == null ? '' : String(t)); }
    function objLabel(t) {
        var map = { table: '表', view: '视图', procedure: '存储过程', function: '函数',
                    trigger: '触发器', index: '索引', db: '库', column: '字段' };
        return map[t] || '对象';
    }
    function objShort(t) {
        var map = { table: '表', view: '视图', procedure: '过程', function: '函数',
                    trigger: '触发器', index: '索引' };
        return map[t] || '对象';
    }
    function verTone(v) {
        if (!v) { return 'is-old'; }
        if (v.status === 'draft') { return 'is-draft'; }
        if (v.status === 'applied') { return 'is-applied'; }
        if (v.status === 'released') { return 'is-release'; }
        if (v.status === 'discarded' || v.status === 'superseded') { return 'is-old'; }
        return 'is-old';
    }
    function verTitle(v) {
        if (!v) { return '—'; }
        if (v.versionNo) { return v.versionNo; }
        return '草稿#' + v.seq;
    }

    /* ================= 应用选择 ================= */
    function loadApps() {
        var dfd = $.Deferred();
        Api.appInfo.options().done(function (res) {
            state.apps = (res && res.list) || [];
            var html = '', pick = UI.param('appId') || '';
            if (!state.apps.length) {
                html = '<option value="">（还没有可用的应用，先去「应用信息」新建）</option>';
            }
            $.each(state.apps, function (i, one) {
                html += '<option value="' + esc(one.id) + '">' + esc(one.code + ' ' + one.name) + '</option>';
            });
            $('#asApp').html(html);
            if (pick && !isAppExists(pick)) { pick = ''; }
            if (!pick && state.apps.length) { pick = state.apps[0].id; }
            state.appId = pick ? String(pick) : '';
            $('#asApp').val(state.appId);
            dfd.resolve();
        }).fail(function (err) {
            $('#asApp').html('<option value="">应用下拉加载失败</option>');
            dfd.reject(err);
        });
        return dfd.promise();
    }
    function isAppExists(id) {
        for (var i = 0; i < state.apps.length; i++) {
            if (String(state.apps[i].id) === String(id)) { return true; }
        }
        return false;
    }
    function loadMeta() {
        var dfd = $.Deferred();
        if (state.meta) { dfd.resolve(state.meta); return dfd.promise(); }
        Api.appInfo.meta().done(function (res) {
            state.meta = res || {};
            dfd.resolve(state.meta);
        }).fail(function () {
            state.meta = { logicalTypes: [], objTypes: [] };
            dfd.resolve(state.meta);
        });
        return dfd.promise();
    }

    /* ================= 结构树 ================= */
    function renderMeta() {
        var t = state.tree;
        if (!t || !t.app) { $('#asMeta').html(''); return; }
        var app = t.app, html = '';
        html += '<span class="as-meta__item">编码 <b>' + esc(app.code) + '</b></span>';
        html += '<span class="as-meta__item">类型 <b>' + esc(app.dbTypeLabel || app.dbType) + '</b></span>';
        if (app.hasConn) {
            if (app.connDbName) {
                html += '<span class="as-meta__item is-ok" title="扫描只针对连接「' +
                    esc(app.connName || '') + '」指定的这一个库；对比页可以另选连接与库（比如线上生产库）">扫描目标 <b>' +
                    esc(app.connDbName) + '</b></span>';
            } else {
                html += '<span class="as-meta__item is-warn" title="连接没有指定「默认库」，扫描前会先让你选一个">' +
                    '连接 未指定默认库</span>';
            }
            html += '<span class="as-meta__item">连接 <b>' + esc(app.connName || '已绑定') + '</b></span>';
        } else {
            html += '<span class="as-meta__item is-warn" title="没有绑定连接时可以手工录入结构，不能扫描；对比页仍可临时选一个连接">连接 未绑定（纯手工）</span>';
        }
        html += '<span class="as-meta__item">最近扫描 <b>' +
            (app.lastScanTime ? esc(String(app.lastScanTime).slice(0, 16)) : '未扫描') + '</b></span>';
        if (t.release) {
            html += '<span class="as-meta__item is-ok">正式版 <b>' + esc(verTitle(t.release)) + '</b></span>';
        } else {
            html += '<span class="as-meta__item">正式版 无</span>';
        }
        if (t.draft) {
            html += '<span class="as-meta__item is-warn">待发布草稿 <b>' + esc(t.draft.changeCount + ' 项变更') + '</b></span>';
        }
        if (app.lastError) {
            html += '<span class="as-meta__item is-danger" title="' + esc(app.lastError) + '">扫描失败</span>';
        }
        $('#asMeta').html(html);
    }
    function renderTree() {
        var t = state.tree;
        if (!t) {
            $('#asTree').html('<div class="db-tree__empty">先在上方选择一个应用</div>');
            $('#asTreeCount').text('0 库 / 0 对象');
            $('#asGuideHint').text('');
            return;
        }
        var dbs = t.databases || [];
        $('#asTreeCount').text(dbs.length + ' 库 / ' + (parseInt(t.objCount, 10) || 0) + ' 对象');
        /* 操作引导区右侧提示：当前应用 + 扫描目标（连接指定的那个库） */
        var app = t.app || {}, hint = [app.code || '', app.name || ''];
        hint = $.grep(hint, function (one) { return !!one; }).join(' ');
        if (app.connDbName) { hint += ' · 扫描目标库 ' + app.connDbName + '（对比可在对比页另选连接 / 库）'; }
        else if (app.hasConn) { hint += ' · 连接未指定默认库（扫描时现场选）'; }
        else { hint += ' · 未绑定连接（纯手工维护，对比仍可选一个连接）'; }
        $('#asGuideHint').text(hint);
        if (!dbs.length) {
            $('#asTree').html('<div class="db-tree__empty">这个应用还没有任何结构：<br>' +
                '点上方「扫描导入」把连接指定的那个库导进来，或点「新增库」手工录入</div>');
            return;
        }
        var html = '', i, j;
        for (i = 0; i < dbs.length; i++) {
            var db = dbs[i], objs = db.objects || [];
            var open = state.expanded[String(db.id)] !== false;
            /* 库的勾选框：勾上=选这个库里全部可导出的表 / 视图（部分勾选显示半选） */
            var pickable = 0, pickedHere = 0;
            for (j = 0; j < objs.length; j++) {
                if (isPickable(objs[j].objType)) {
                    pickable++;
                    if (state.picked[String(objs[j].id)]) { pickedHere++; }
                }
            }
            html += '<div class="as-node" data-kind="db" data-id="' + esc(db.id) + '" data-name="' +
                esc(db.dbName) + '">' +
                '<div class="as-node__row">' +
                    '<span class="as-node__caret' + (objs.length ? '' : ' is-empty') + '">' +
                        (objs.length ? (open ? '▾' : '▸') : '') + '</span>' +
                    '<input type="checkbox" class="as-node__pick" data-kind="db"' +
                        (pickable ? '' : ' disabled') + (pickable && pickedHere === pickable ? ' checked' : '') +
                        ' title="勾选本库全部表 / 视图">' +
                    '<span class="as-node__kind is-db">库</span>' +
                    '<span class="as-node__name" title="' + esc(db.dbName) +
                        (db.dbComment ? '（' + esc(db.dbComment) + '）' : '') + '">' + esc(db.dbName) + '</span>' +
                    (db.locked ? '<span class="as-node__lock" title="已锁定：扫描不会覆盖或删除">锁</span>' : '') +
                    '<span class="as-node__badge">' + objs.length + '</span>' +
                '</div>' +
                '<div class="as-node__children"' + (open ? '' : ' hidden') + '>';
            for (j = 0; j < objs.length; j++) {
                var ob = objs[j];
                var canPick = isPickable(ob.objType);
                html += '<div class="as-node" data-kind="obj" data-id="' + esc(ob.id) + '" data-name="' +
                    esc(ob.objName) + '" data-objtype="' + esc(ob.objType) + '" data-db="' + esc(db.id) + '">' +
                    '<div class="as-node__row">' +
                        '<span class="as-node__caret is-empty"></span>' +
                        (canPick
                            ? '<input type="checkbox" class="as-node__pick" data-kind="obj" value="' +
                                esc(ob.id) + '"' + (state.picked[String(ob.id)] ? ' checked' : '') +
                                ' title="勾选后可导出这张表的结构">'
                            : '<span class="as-node__pick-ph"></span>') +
                        '<span class="as-node__kind is-' + esc(ob.objType) + '">' +
                            esc(objShort(ob.objType)) + '</span>' +
                        '<span class="as-node__name" title="' + esc(ob.objName) +
                            (ob.objComment ? '（' + esc(ob.objComment) + '）' : '') + '">' + esc(ob.objName) + '</span>' +
                        (ob.locked ? '<span class="as-node__lock" title="已锁定">锁</span>' : '') +
                        (ob.objType === 'table' ? '<span class="as-node__sub">' +
                            (parseInt(ob.colCount, 10) || 0) + ' 字段</span>' : '') +
                    '</div>' +
                    '</div>';
            }
            html += '</div></div>';
        }
        $('#asTree').html(html);
        applyTreeSelection();
        syncPickState();
    }
    /* 只有表 / 视图有字段明细，才有「表结构」可导出；过程 / 函数 / 触发器 / 索引不进文档 */
    function isPickable(objType) { return objType === 'table' || objType === 'view'; }
    function pickableCount() {
        var t = state.tree, n = 0, i, j, dbs = (t && t.databases) || [];
        for (i = 0; i < dbs.length; i++) {
            for (j = 0; j < (dbs[i].objects || []).length; j++) {
                if (isPickable(dbs[i].objects[j].objType)) { n++; }
            }
        }
        return n;
    }
    function pickedIds() {
        var out = [];
        $.each(state.picked, function (id, on) { if (on) { out.push(id); } });
        return out;
    }
    /* 刷新 / 扫描 / 删表之后，勾选里可能还留着已经不在树上的对象 id —— 清掉，
       否则导出会带着无效 id 去后端（那边会判「不属于这个应用」） */
    function prunePicked() {
        var gone = [];
        $.each(state.picked, function (id) {
            if (!findNodeInTree('obj', id)) { gone.push(id); }
        });
        for (var i = 0; i < gone.length; i++) { delete state.picked[gone[i]]; }
    }
    /* 库勾选框的半选状态 + 工具栏的「已勾选 N 张」提示 */
    function syncPickState() {
        $('#asTree .as-node[data-kind=db]').each(function () {
            var $node = $(this);
            var $pick = $node.children('.as-node__row').find('.as-node__pick');
            var $kids = $node.children('.as-node__children').find('.as-node__pick');
            var total = $kids.length, on = $kids.filter(':checked').length;
            $pick.prop({ checked: total > 0 && on === total, indeterminate: on > 0 && on < total });
        });
        var n = pickedIds().length;
        $('#asPickHint').text(n ? '已勾选 ' + n + ' 张' : '');
        $('#asBtnExport').attr('title', n
            ? '导出表结构：导出已勾选的 ' + n + ' 张表（Excel / Word）'
            : '导出表结构：未勾选时导出全部表 / 视图（Excel / Word）');
    }
    function applyTreeSelection() {
        $('#asTree .as-node').each(function () {
            var $n = $(this);
            $n.toggleClass('is-selected', $n.attr('data-kind') === state.kind &&
                String($n.attr('data-id')) === String(state.id));
        });
    }
    function syncNodeToolbar() {
        $('#asBtnNodeEdit').prop('disabled', !state.kind);
        $('#asBtnNodeDel').prop('disabled', !state.kind);
        // 只有「表」才有字段：索引 / 触发器 / 视图 / 过程 / 函数不显示字段维护按钮
        var editable = !!state.obj && state.obj.objType === 'table';
        $('#asBtnColAdd').prop('disabled', !editable);
        $('#asBtnColPaste').prop('disabled', !editable);
        $('#asBtnColSave').prop('disabled', !editable);
    }

    function loadTree(keepNode) {
        if (!state.appId) {
            state.tree = null;
            renderMeta(); renderTree(); syncNodeToolbar();
            return $.Deferred().resolve().promise();
        }
        UI.loading($('#asTree'), true);
        return Api.appSchema.tree(state.appId).done(function (res) {
            state.tree = res || null;
            prunePicked();
            $('#asTreeTip').text(state.tree && state.tree.databases && state.tree.databases.length
                ? '点库名展开 / 收起；点表名在右侧维护字段；双击表名切到字段明细' : '');
            renderMeta();
            renderTree();
            if (!keepNode) {
                state.kind = ''; state.id = ''; state.name = '';
                state.dbId = ''; state.dbName = '';
                state.obj = null; state.cols = [];
                renderCols();
            } else {
                var found = findNodeInTree(state.kind, state.id);
                if (!found) {
                    state.kind = ''; state.id = ''; state.name = '';
                    state.obj = null; state.cols = [];
                    renderCols();
                }
            }
            syncNodeToolbar();
            fillCmpDesignDb();
        }).fail(function (err) {
            $('#asTree').html('<div class="db-tree__empty is-error">' +
                esc((err && err.message) || '结构加载失败') + '</div>');
        }).always(function () { UI.loading($('#asTree'), false); });
    }
    function findNodeInTree(kind, id) {
        var t = state.tree;
        if (!t) { return null; }
        var i, j, dbs = t.databases || [];
        for (i = 0; i < dbs.length; i++) {
            if (kind === 'db' && String(dbs[i].id) === String(id)) { return { db: dbs[i] }; }
            for (j = 0; j < (dbs[i].objects || []).length; j++) {
                if (kind === 'obj' && String(dbs[i].objects[j].id) === String(id)) {
                    return { db: dbs[i], obj: dbs[i].objects[j] };
                }
            }
        }
        return null;
    }

    /* ================= 选中节点 ================= */
    function selectNode(kind, id, name, dbId, objType) {
        state.kind = kind;
        state.id = id;
        state.name = name;
        if (kind === 'db') {
            state.dbId = id; state.dbName = name;
            state.obj = null; state.cols = [];
        } else {
            state.dbId = dbId || state.dbId;
            var hit = findNodeInTree('obj', id);
            if (hit) { state.dbName = hit.db.dbName; state.obj = hit.obj; }
        }
        applyTreeSelection();
        syncNodeToolbar();
        state.lineageCol = '';                 // 换对象：原来选中的字段不适用了
        if (kind === 'obj') {
            loadCols();
        } else {
            state.obj = null; state.cols = [];
            renderCols();
            $('#asTabTip').text(state.dbName || '未选择对象');
        }
        if (state.tab === 'lineage') { loadLineage(); }
    }

    /* ================= 字段明细 ================= */
    function typeOptions(selected) {
        var list = (state.meta && state.meta.logicalTypes) || [], html = '';
        for (var i = 0; i < list.length; i++) {
            html += '<option value="' + esc(list[i].value) + '"' +
                (list[i].value === selected ? ' selected' : '') + '>' +
                esc(list[i].value + (list[i].label ? '·' + list[i].label : '')) + '</option>';
        }
        return html;
    }
    function nullableOptions(selected) {
        return '<option value="1"' + (selected ? ' selected' : '') + '>可空</option>' +
               '<option value="0"' + (!selected ? ' selected' : '') + '>非空</option>';
    }
    function srcLabel(src) {
        return src === 'scan' ? '扫描' : (src === 'import' ? '导入' : '手工');
    }
    function colRow(c, idx) {
        var src = c.source || 'manual';
        return '<tr data-id="' + esc(c.id || '') + '">' +
            '<td class="is-center as-col__idx">' + (idx + 1) + '</td>' +
            '<td><input type="text" data-f="colName" value="' + esc(c.colName || '') + '" maxlength="120"></td>' +
            '<td><select data-f="dataType">' + typeOptions(c.dataType || 'VARCHAR') + '</select></td>' +
            '<td><input type="text" data-f="length" value="' + esc(c.length || '') + '" maxlength="20" placeholder="如 100"></td>' +
            '<td class="is-center"><select data-f="nullable">' + nullableOptions(c.nullable !== false) + '</select></td>' +
            '<td><input type="text" data-f="defaultValue" value="' + esc(c.defaultValue || '') + '" maxlength="120"></td>' +
            '<td class="is-center"><input type="checkbox" data-f="isPk"' + (c.isPk ? ' checked' : '') + '></td>' +
            '<td class="is-center"><input type="checkbox" data-f="isAutoInc"' + (c.isAutoInc ? ' checked' : '') + '></td>' +
            '<td><input type="text" data-f="colComment" value="' + esc(c.colComment || '') + '" maxlength="200"></td>' +
            '<td class="is-center"><span class="as-col__src is-' + esc(src) + '">' + esc(srcLabel(src)) + '</span></td>' +
            '<td class="is-center"><button type="button" class="as-col__del" title="删除该字段">✕</button></td>' +
            '</tr>';
    }
    function renderCols() {
        var obj = state.obj;
        if (!obj) {
            $('#asObjTitle').text('字段明细');
            $('#asObjHint').text('在左边点一张表，这里维护它的字段');
            $('#asColsBody').html('<tr><td colspan="11"><div class="as-cols__empty">' +
                '选中左边的<b>表</b>后，这里可以逐字段维护：名称 / 逻辑类型 / 长度 / 可空 / 默认值 / 主键 / 自增 / 注释<br>' +
                '逻辑类型只存「设计态类型」，发布时会按应用的数据库方言渲染成真实 DDL</div></td></tr>');
            $('#asObjDdlBox').prop('hidden', true);
            $('#asTabTip').text('未选择对象');
            return;
        }
        $('#asObjTitle').text((obj.dbName ? obj.dbName + '.' : '') + obj.objName);
        $('#asObjHint').text(objLabel(obj.objType) + (obj.objComment ? ' · ' + obj.objComment : ''));
        $('#asTabTip').text(state.dbName + '.' + obj.objName);
        var html = '', i;
        for (i = 0; i < state.cols.length; i++) { html += colRow(state.cols[i], i); }
        if (!state.cols.length) {
            html = '<tr><td colspan="11"><div class="as-cols__empty">' +
                (obj.objType === 'table'
                    ? '这张表还没有字段：点「新增字段」逐条加，或「批量粘贴」按行粘贴，再点「保存字段」出版本'
                    : (obj.objType === 'index'
                        ? '索引依附于表（名字存成「表名.索引名」）：定义看下方原文，字段请到所属的表里维护'
                        : (obj.objType === 'trigger'
                            ? '触发器依附于表：定义（CREATE TRIGGER 原文）看下方，字段请到所属的表里维护'
                            : '这类对象没有字段，定义（DDL 原文）看下方'))) +
                '</div></td></tr>';
        }
        $('#asColsBody').html(html);
        $('#asObjDdlBox').prop('hidden', obj.objType === 'table');
        $('#asObjDdlTitle').text((objLabel(obj.objType) || '对象') + '定义（原文，发布时按它输出）');
        // 定义取不到时别只留一个空框：Oracle 没有 SELECT_CATALOG_ROLE、SQL Server 对象加密、
        // 以及系统内置对象都拿不到正文，这里直接说明原因，用户知道该怎么办
        $('#asObjDdl').attr('placeholder', obj.ddl ? '' :
            '没取到定义原文：可能是数据库账号没有读取定义的权限（Oracle 需要 SELECT_CATALOG_ROLE），' +
            '或对象是加密 / 系统内置的。可以手工粘贴脚本，发布时按这里的原文输出。');
        $('#asObjDdl').val(obj.ddl || '');
    }
    function loadCols() {
        if (!state.obj) { return; }
        UI.loading($('#asColsWrap'), true);
        Api.appSchema.cols(state.obj.id, state.appId).done(function (res) {
            var d = res || {};
            state.obj = $.extend({}, d.object || {}, { dbName: (d.object && d.object.dbName) || state.dbName });
            state.dbName = (d.object && d.object.dbName) || state.dbName;
            state.cols = d.list || [];
            renderCols();
        }).fail(function (err) {
            $('#asColsBody').html('<tr><td colspan="11"><div class="as-cols__empty is-error">' +
                esc((err && err.message) || '字段加载失败') + '</div></td></tr>');
        }).always(function () { UI.loading($('#asColsWrap'), false); });
    }
    function collectCols() {
        var list = [];
        $('#asColsBody tr[data-id], #asColsBody tr').each(function () {
            var $tr = $(this);
            if (!$tr.find('input[data-f], select[data-f]').length) { return; }
            var one = {
                id: $tr.attr('data-id') || '',
                colName: trim($tr.find('[data-f=colName]').val()),
                dataType: $tr.find('[data-f=dataType]').val(),
                length: trim($tr.find('[data-f=length]').val()),
                nullable: $tr.find('[data-f=nullable]').val() === '1',
                defaultValue: trim($tr.find('[data-f=defaultValue]').val()),
                isPk: $tr.find('[data-f=isPk]').prop('checked'),
                isAutoInc: $tr.find('[data-f=isAutoInc]').prop('checked'),
                colComment: trim($tr.find('[data-f=colComment]').val())
            };
            if (!one.colName) { return; }        // 空行（新加但没填名字）直接忽略
            list.push(one);
        });
        return list;
    }
    function addColRow() {
        if (!state.obj) { return; }
        var empty = $('#asColsBody tr').filter(function () { return !$(this).find('[data-f]').length; }).length;
        if (empty) { $('#asColsBody').html(''); }
        var newOne = { id: '', colName: '', dataType: 'VARCHAR', length: '', nullable: true,
                       defaultValue: '', isPk: false, isAutoInc: false, colComment: '', source: 'manual' };
        var $tr = $(colRow(newOne, state.cols.length));
        $('#asColsBody').append($tr);
        state.cols.push(newOne);
        $tr.find('[data-f=colName]').trigger('focus');
        $('#asColsBody tr').each(function (i) {
            $(this).find('.as-col__idx').text(i + 1);
        });
    }
    function saveCols() {
        if (!state.obj) { return; }
        var list = collectCols();
        if (!list.length) { UI.message({ type: 'warning', message: '没有要保存的字段' }); return; }
        UI.loading($('#asColsWrap'), true);
        Api.appSchema.colsave(state.obj.id, list, state.appId).done(function (res) {
            var d = res || {};
            state.cols = d.list || [];
            renderCols();
            UI.message({ type: 'success', message: '字段已保存，并生成了一个新的草稿版本' });
            loadTree(true);
            loadVersions();
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
        }).always(function () { UI.loading($('#asColsWrap'), false); });
    }
    function deleteCol($tr) {
        var colId = $tr.attr('data-id'), colName = trim($tr.find('[data-f=colName]').val());
        if (!colId) {                       // 还没落库的新行：直接从界面删掉
            $tr.remove();
            state.cols = collectCols();
            return;
        }
        UI.confirm({
            title: '删除字段',
            message: '确定删除字段「' + (colName || '') + '」吗？保存后会生成一个新草稿版本，真实数据库不会被改动。',
            confirmText: '删除'
        }).done(function (yes) {
            if (!yes) { return; }
            Api.appSchema.coldel(state.obj.id, colId, state.appId).done(function (res) {
                var d = res || {};
                state.cols = d.list || [];
                renderCols();
                UI.message({ type: 'success', message: '字段已删除' });
                loadTree(true);
                loadVersions();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }

    /* 批量粘贴：# 字段名 类型(长度) 注释 */
    function openPaste() {
        if (!state.obj) { return; }
        var tpl = '<div class="as-form">' +
            '<div class="form-tip" style="margin-bottom:6px">每行一个字段，格式：<b>字段名 类型(长度) 注释</b>；' +
            '类型写逻辑类型（VARCHAR / INT / DECIMAL / DATETIME …），也可直接粘贴 MySQL 类型（会自动归一）。' +
            '示例：<code>phone VARCHAR(20) 手机号</code></div>' +
            '<textarea class="as-form__ddl" id="asPasteText" spellcheck="false" placeholder="id BIGINT 主键\n' +
            'code VARCHAR(16) 工号\nnameCn VARCHAR(50) 姓名\ncreatedAt DATETIME 创建时间"></textarea>' +
            '</div>';
        UI.dialog({
            title: '批量粘贴字段',
            width: 720,
            content: tpl,
            onOk: function ($body, close) {
                var text = String($body.find('#asPasteText').val() || '').replace(/\r\n/g, '\n');
                var lines = text.split('\n'), added = 0, i;
                var $tbody = $('#asColsBody');
                if (!state.cols.length) { $tbody.html(''); }
                for (i = 0; i < lines.length; i++) {
                    var line = trim(lines[i]);
                    if (!line || line.charAt(0) === '#') { continue; }
                    var parts = line.split(/[\s,，]+/), name = parts[0];
                    if (!name) { continue; }
                    var typeText = parts[1] || 'VARCHAR', comment = parts.slice(2).join(' ');
                    var dataType = 'VARCHAR', length = '';
                    var m = /^([A-Za-z_]+)\s*(?:\(\s*([0-9]+(?:\s*,\s*[0-9]+)?)\s*\))?$/.exec(typeText);
                    if (m) {
                        dataType = m[1].toUpperCase();
                        length = m[2] || '';
                    }
                    var known = false, k;
                    for (k = 0; k < ((state.meta && state.meta.logicalTypes) || []).length; k++) {
                        if (state.meta.logicalTypes[k].value === dataType) { known = true; }
                    }
                    if (!known) {                 // MySQL 类型兜底归一
                        var low = dataType.toLowerCase();
                        if (/^(tinyint|smallint)$/.test(low)) { dataType = 'SMALLINT'; }
                        else if (/^(mediumint|int|integer)$/.test(low)) { dataType = 'INT'; }
                        else if (/^(bigint)$/.test(low)) { dataType = 'BIGINT'; }
                        else if (/^(varchar|varchar2|nvarchar)$/.test(low)) { dataType = 'VARCHAR'; }
                        else if (/^(char|nchar)$/.test(low)) { dataType = 'CHAR'; }
                        else if (/^(text|longtext|mediumtext|clob)$/.test(low)) { dataType = 'TEXT'; }
                        else if (/^(decimal|numeric|number)$/.test(low)) { dataType = 'DECIMAL'; }
                        else if (/^(datetime|timestamp)$/.test(low)) { dataType = 'DATETIME'; }
                        else if (/^(date)$/.test(low)) { dataType = 'DATE'; }
                        else if (/^(time)$/.test(low)) { dataType = 'TIME'; }
                        else if (/^(bit|bool|boolean)$/.test(low)) { dataType = 'BOOLEAN'; }
                        else if (/^(blob|binary|longblob)$/.test(low)) { dataType = 'BLOB'; }
                        else if (/^(json)$/.test(low)) { dataType = 'JSON'; }
                        else if (/^(float)$/.test(low)) { dataType = 'FLOAT'; }
                        else if (/^(double)$/.test(low)) { dataType = 'DOUBLE'; }
                        else if (/^(uuid)$/.test(low)) { dataType = 'UUID'; }
                        else { dataType = 'VARCHAR'; }
                    }
                    var one = { id: '', colName: name, dataType: dataType, length: length, nullable: true,
                                defaultValue: '', isPk: false, isAutoInc: false, colComment: comment,
                                source: 'manual' };
                    state.cols.push(one);
                    $tbody.append(colRow(one, state.cols.length - 1));
                    added++;
                }
                $tbody.find('tr').each(function (i) { $(this).find('.as-col__idx').text(i + 1); });
                close();
                if (added) {
                    UI.message({ type: 'success', message: '已加入 ' + added + ' 个字段，记得点「保存字段」才落库' });
                } else {
                    UI.message({ type: 'warning', message: '没有识别到字段，请检查格式' });
                }
            }
        });
    }

    /* 表单模板：取一次就把模板节点摘掉，避免模板与弹窗出现两份同 id 的输入框
       （否则 document.getElementById 与 label 的 for 会指到隐藏的那一份） */
    var nodeTpl = null;
    function takeNodeTpl() {
        if (nodeTpl === null) {
            nodeTpl = $('#asNodeTpl').html() || '';
            $('#asNodeTpl').remove();
        }
        return nodeTpl;
    }

    /* ================= 库 / 对象维护 ================= */
    function openNodeForm(mode) {
        /* mode: 'dbAdd' | 'dbEdit' | 'objAdd' | 'objEdit' */
        var isDb = mode === 'dbAdd' || mode === 'dbEdit';
        var isEdit = mode === 'dbEdit' || mode === 'objEdit';
        var node = null;
        if (isEdit) {
            node = isDb ? findNodeInTree('db', state.id) : findNodeInTree('obj', state.id);
            if (!node) { UI.message({ type: 'warning', message: '先选中要编辑的节点' }); return; }
        }
        var dbRow = node && node.db;
        var objRow = node && node.obj;
        UI.dialog({
            title: isDb ? (isEdit ? '编辑库' : '新增库') : (isEdit ? '编辑对象' : '新增对象'),
            width: 640,
            content: takeNodeTpl(),
            onReady: function ($body) {
                $body.find('#anNameLabel').text(isDb ? '库名' : '对象名');
                $body.find('#anName').attr('placeholder', isDb ? '如 jiudou_main' : '如 empinfos');
                $body.find('#anTypeItem').prop('hidden', isDb);
                $body.find('#anDdlItem').prop('hidden', isDb);
                $body.find('#anComment').attr('placeholder', isDb ? '库注释，选填' : '对象注释，选填');
                if (isDb) {
                    $body.find('#anName').val(isEdit ? (dbRow.dbName || '') : '');
                    $body.find('#anComment').val(isEdit ? (dbRow.dbComment || '') : '');
                    $body.find('#anLocked').val(isEdit && dbRow.locked ? '1' : '0');
                } else {
                    var type = isEdit ? (objRow.objType || 'table') : 'table';
                    $body.find('#anType').val(type);
                    $body.find('#anName').val(isEdit ? (objRow.objName || '') : '');
                    $body.find('#anComment').val(isEdit ? (objRow.objComment || '') : '');
                    $body.find('#anDdl').val(isEdit ? (objRow.ddl || '') : '');
                    $body.find('#anLocked').val(isEdit && objRow.locked ? '1' : '0');
                    function syncDdl() {
                        var t = $body.find('#anType').val();
                        $body.find('#anDdlItem').prop('hidden', t === 'table');
                    }
                    $body.find('#anType').on('change', syncDdl);
                    syncDdl();
                }
            },
            onOk: function ($body, close) {
                var name = trim($body.find('#anName').val());
                if (!name) { UI.message({ type: 'warning', message: '名称不能为空' }); return; }
                var payload = {
                    nodeName: name,
                    dbName: name,
                    objName: name,
                    objComment: trim($body.find('#anComment').val()),
                    dbComment: trim($body.find('#anComment').val()),
                    objType: $body.find('#anType').val() || 'table',
                    ddl: $body.find('#anDdl').val() || '',
                    locked: $body.find('#anLocked').val() === '1' ? 1 : 0
                };
                var req;
                if (isDb) {
                    if (isEdit) {
                        payload.id = state.id;
                        req = Api.appSchema.dbupdate(state.appId, payload);
                    } else {
                        req = Api.appSchema.dbadd(state.appId, payload);
                    }
                } else {
                    if (isEdit) {
                        payload.id = state.id;
                        req = Api.appSchema.objupdate(state.appId, payload);
                    } else {
                        payload.dbId = state.dbId;
                        if (!payload.dbId) { UI.message({ type: 'warning', message: '先在左边选中一个库' }); return; }
                        req = Api.appSchema.objadd(state.appId, payload);
                    }
                }
                UI.loading($body, true, '保存中…');
                req.done(function (res) {
                    close();
                    UI.message({ type: 'success', message: '已保存，并生成了新的草稿版本' });
                    if (!isDb && !isEdit && res && res.id) {
                        state.kind = 'obj';
                        state.id = res.id;
                        state.name = name;
                    }
                    loadTree(true);
                    loadVersions();
                    if (state.kind === 'obj' && state.id) { selectNode('obj', state.id, state.name, state.dbId); }
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                }).always(function () { UI.loading($body, false); });
            }
        });
    }
    function deleteNode() {
        if (!state.kind) { return; }
        var isDb = state.kind === 'db';
        UI.confirm({
            title: isDb ? '删除库' : '删除对象',
            message: '确定删除' + (isDb ? '库「' + state.name + '」' : '对象「' + state.name + '」') +
                '吗？' + (isDb ? '它下面的全部表 / 视图 / 索引 / 触发器 / 过程 / 函数与字段会一起删除。' : '它的字段会一起删除。') +
                '保存后生成新草稿，真实数据库不会被改动。',
            confirmText: '删除'
        }).done(function (yes) {
            if (!yes) { return; }
            var req = isDb ? Api.appSchema.dbdel(state.appId, state.id)
                : Api.appSchema.objdel(state.appId, state.id);
            // 删除库要连带删掉下面所有对象与字段，量大时会等一会儿：给个遮罩，别让人以为没反应
            UI.loading($('#asTree'), true, '正在删除…（库里的对象多时要等一会儿）');
            req.done(function () {
                UI.message({ type: 'success', message: '已删除' });
                state.kind = ''; state.id = ''; state.name = '';
                state.obj = null; state.cols = [];
                renderCols();
                syncNodeToolbar();
                loadTree();
                loadVersions();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            }).always(function () { UI.loading($('#asTree'), false); });
        });
    }

    /* ================= 扫描导入 ================= */
    function runScan() {
        if (!state.appId) { UI.message({ type: 'warning', message: '先选择一个应用' }); return; }
        var t = state.tree;
        if (t && t.app && !t.app.hasConn) {
            UI.alert({ type: 'warning', title: '不能扫描', message: '这个应用没有绑定数据库连接（纯手工维护），' +
                '请先去「应用信息」里绑定连接，再回来扫描。' });
            return;
        }
        UI.loading($('body'), true, '正在读取连接信息…');
        Api.appSchema.scaninfo(state.appId).done(function (res) {
            var d = res || {};
            if (d.error) {
                UI.alert({ type: 'warning', title: '暂时不能扫描', message: d.error, width: 520 });
                return;
            }
            openScanDialog(d);
        }).fail(function (err) {
            UI.alert({ type: 'error', title: '读取连接信息失败',
                       message: (err && err.message) || '连接信息读取失败' });
        }).always(function () { UI.loading($('body'), false); });
    }

    /* 扫描弹窗：目标库**单选**，默认选中连接指定的那个库；连接没填默认库就让人现场选一个 —— 不做全库扫描 */
    function openScanDialog(info) {
        var dbs = info.databases || [], i, opts = '', target = info.target || '';
        if (!target) {                                    /* 连接没填默认库：预选第一个非系统库 */
            for (i = 0; i < dbs.length; i++) {
                if (!dbs[i].system) { target = dbs[i].name; break; }
            }
        }
        for (i = 0; i < dbs.length; i++) {
            var one = dbs[i];
            if (one.system && one.name !== target) { continue; }     /* 系统库不列，除非选中的就是它 */
            opts += '<option value="' + esc(one.name) + '"' + (one.name === target ? ' selected' : '') +
                '>' + esc(one.name) + (one.system ? '（系统库）' : '') + '</option>';
        }
        if (!opts) { opts = '<option value="">（连接里没有可访问的库）</option>'; }
        var tip = info.needPick
            ? '连接「' + esc(info.connName || '') + '」还没有指定默认库，请在上面选一个 —— 只扫选中的<b>这一个</b>库，' +
              '实例里的其它库不会被一起导进来。（建议到「数据库连接」里把默认库填上，以后就不用每次选）'
            : '只扫选中的<b>这一个</b>库（连接「' + esc(info.connName || '') +
              '」的默认库）；实例里的其它库不会被一起导进来。';
        var html = '<div class="as-form">' +
            '<div class="el-form-item"><label class="el-form-item__label" for="asScanDb">扫描目标</label>' +
            '<div class="el-form-item__content"><div class="el-input">' +
            '<select class="el-input__inner" id="asScanDb">' + opts + '</select></div>' +
            '<div class="form-tip">' + tip + '</div></div></div>' +
            '<div class="as-scan__note">' +
            '· 收录<b>表 / 视图 / 索引 / 触发器 / 存储过程 / 函数</b>，字段顺序按实库的位置落库；<br>' +
            '· 只更新设计态，真实数据库不会被改动；<br>' +
            '· 手工录入的库 / 对象 / 字段不会被冲掉（扫描只删「扫描来源且未锁定」的）；<br>' +
            '· 结束后会生成一个草稿版本，是否发布由你决定。</div>' +
            '</div>';
        UI.dialog({
            title: '扫描导入结构', width: 520, content: html,
            onOk: function ($body, close) {
                var picked = $body.find('#asScanDb').val() || '';
                if (!picked) {
                    UI.message({ type: 'warning', message: '连接里没有可扫描的库，请先检查连接' });
                    return;
                }
                close();
                doScan(picked);
            }
        });
    }

    function doScan(dbName) {
        // 大库（几百张表逐张读结构）要几分钟到十几分钟，提示里说清楚，别让人以为卡死了去点第二次
        UI.loading($('body'), true, '正在扫描 ' + dbName + '…（表多时要几分钟到十几分钟，请勿重复点击）');
        Api.appSchema.scan(state.appId, dbName).done(function (res) {
            var d = res || {};
            var msg = '已扫描 ' + (d.target || dbName) + '：库 ' + (d.databases || 0) +
                '、表 ' + (d.tables || 0) + '、视图 ' + (d.views || 0) +
                '、索引 ' + (d.indexes || 0) + '、触发器 ' + (d.triggers || 0) +
                '、存储过程 ' + (d.procedures || 0) + '、函数 ' + (d.functions || 0) +
                '、字段 ' + (d.columns || 0) +
                '；新增 ' + (d.added || 0) + '、更新 ' + (d.updated || 0) +
                '、删除 ' + (d.dropped || 0) + '、保留 ' + (d.kept || 0) + '。';
            if (d.version) {
                msg += '\n已生成草稿：' + (d.version.changeCount || 0) + ' 项变更，可到「变更历史」里发布。';
            } else {
                msg += '\n结构没有变化，未生成新版本。';
            }
            if (d.warnings && d.warnings.length) {
                msg += '\n\n注意：\n· ' + d.warnings.join('\n· ');
            }
            UI.alert({ type: (d.warnings && d.warnings.length) ? 'warning' : 'success',
                       title: '扫描结果', message: msg, width: 520 });
            loadTree(true);
            loadVersions();
        }).fail(function (err) {
            UI.alert({ type: 'error', title: '扫描失败', message: (err && err.message) || '扫描失败' });
        }).always(function () { UI.loading($('body'), false); });
    }

    /* ================= 导入 DDL ================= */
    function openImport() {
        if (!state.appId) { UI.message({ type: 'warning', message: '先选择一个应用' }); return; }
        var dbOpts = '<option value="">自动（用语句里的库名 / 第一个库）</option>';
        $.each((state.tree && state.tree.databases) || [], function (i, one) {
            dbOpts += '<option value="' + esc(one.dbName) + '">' + esc(one.dbName) + '</option>';
        });
        var tpl = '<div class="as-form">' +
            '<div class="el-form-item"><label class="el-form-item__label" for="asImpDb">目标库</label>' +
            '<div class="el-form-item__content"><div class="el-input"><select class="el-input__inner" id="asImpDb">' +
            dbOpts + '</select></div><div class="form-tip">语句里带库名（<code>库名.表名</code>）时以语句为准</div></div></div>' +
            '<textarea class="as-form__ddl" id="asImpSql" spellcheck="false" style="height:260px" ' +
            'placeholder="CREATE TABLE `demo` (\n  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT \'主键\',\n' +
            '  `name` VARCHAR(50) NOT NULL COMMENT \'名称\',\n  PRIMARY KEY (`id`)\n) COMMENT=\'示例表\';\n\n' +
            'ALTER TABLE demo ADD COLUMN phone VARCHAR(20) COMMENT \'手机号\';\n' +
            'COMMENT ON COLUMN demo.name IS \'名称\'"></textarea>' +
            '<div class="form-tip" id="asImpPreview" style="margin-top:6px">' +
            '支持 CREATE TABLE / ALTER TABLE（增删改字段、主键）/ DROP / COMMENT ON；' +
            '<b>只改设计态</b>，不会执行到真实数据库</div>' +
            '</div>';
        UI.dialog({
            title: '导入 DDL（落到设计态）',
            width: 880,
            content: tpl,
            onReady: function ($body) {
                $body.find('#asImpSql').trigger('focus');
            },
            onOk: function ($body, close) {
                var sql = String($body.find('#asImpSql').val() || '');
                if (!trim(sql)) { UI.message({ type: 'warning', message: '请粘贴要导入的 SQL' }); return; }
                var dbName = $body.find('#asImpDb').val() || '';
                UI.loading($body, true, '正在导入…');
                Api.appSchema.importddl(state.appId, sql, dbName).done(function (res) {
                    close();
                    var d = res || {}, logs = d.logs || [], html = '', okCount = 0, i;
                    for (i = 0; i < logs.length; i++) {
                        if (logs[i].ok) { okCount++; }
                        html += '<div class="as-implog' + (logs[i].ok ? '' : ' is-error') + '">' +
                            '<b>' + esc(logs[i].target || '') + '</b> · ' + esc(logs[i].message || '') + '</div>';
                    }
                    UI.dialog({
                        title: '导入结果（' + okCount + ' / ' + logs.length + ' 条成功）',
                        width: 720,
                        content: '<div class="as-implogs">' + (html || '<div class="as-cols__empty">没有执行结果</div>') + '</div>',
                        onOk: function ($b2, close2) { close2(); }
                    });
                    loadTree(true);
                    loadVersions();
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '导入失败' });
                }).always(function () { UI.loading($body, false); });
            }
        });
    }

    /* ================= 版本 / 变更历史 ================= */
    function loadVersions() {
        if (!state.appId) {
            state.versions = []; renderVersions(); return $.Deferred().resolve().promise();
        }
        UI.loading($('#asVerBody'), true);
        return Api.appSchema.versions(state.appId).done(function (res) {
            state.versions = (res && res.list) || [];
            renderVersions();
        }).fail(function (err) {
            $('#asVerBody').html('<tr><td colspan="5"><div class="as-vers__empty is-error">' +
                esc((err && err.message) || '版本加载失败') + '</div></td></tr>');
        }).always(function () { UI.loading($('#asVerBody'), false); });
    }
    function renderVersions() {
        var list = state.versions || [], html = '', i;
        if (!list.length) {
            $('#asVerBody').html('<tr><td colspan="5"><div class="as-vers__empty">' +
                '还没有版本：维护字段 / 库 / 对象，或扫描导入后会生成草稿</div></td></tr>');
            $('#asBtnPublish').prop('disabled', true);
            $('#asBtnDiscard').prop('disabled', true);
            renderVerDetail(null);
            fillScriptVersions();
            return;
        }
        for (i = 0; i < list.length; i++) {
            var v = list[i], sel = state.ver && String(state.ver.id) === String(v.id);
            html += '<tr data-id="' + esc(v.id) + '"' + (sel ? ' class="is-selected"' : '') + '>' +
                '<td><b>' + esc(verTitle(v)) + '</b>' +
                    '<span class="as-vers__sub">' + esc(v.statusLabel || '') + '</span></td>' +
                '<td class="is-center"><span class="as-tag ' + verTone(v) + '">' +
                    esc(v.kind === 'release' ? '正式版' : '草稿') + '</span></td>' +
                '<td>' + esc(v.summary || '') +
                    (v.source ? '<span class="as-vers__sub">来源：' + esc(srcLabel(v.source)) + '</span>' : '') + '</td>' +
                '<td class="is-center">' + (parseInt(v.changeCount, 10) || 0) + '</td>' +
                '<td>' + esc(String(v.releaseTime || v.createTime || '').slice(0, 16)) + '</td>' +
                '</tr>';
        }
        $('#asVerBody').html(html);
        var cur = state.ver;
        $('#asBtnPublish').prop('disabled', !(cur && cur.kind === 'draft' && cur.status === 'draft' && cur.canPublish));
        $('#asBtnDiscard').prop('disabled', !(cur && cur.kind === 'draft' && cur.status === 'draft'));
        fillScriptVersions();
    }
    function renderVerDetail(v) {
        if (!v) {
            $('#asVerDetailTitle').text('变更明细');
            $('#asChangeBody').html('<tr><td colspan="4"><div class="as-changes__empty">' +
                '点左边任意一个版本，这里显示它的逐条变更</div></td></tr>');
            return;
        }
        $('#asVerDetailTitle').text(verTitle(v) + ' · ' + (v.statusLabel || '') +
            ' · ' + ((v.changes || []).length) + ' 项变更');
        var list = v.changes || [], html = '', i;
        if (!list.length) {
            html = '<tr><td colspan="4"><div class="as-changes__empty">这个版本没有变更明细</div></td></tr>';
        }
        for (i = 0; i < list.length; i++) {
            var ch = list[i];
            html += '<tr>' +
                '<td>' + esc(objLabel(ch.objType)) + '</td>' +
                '<td><span class="as-op is-' + esc(ch.action) + '">' +
                    esc(ch.action === 'create' ? '新增' : (ch.action === 'drop' ? '删除' : '修改')) + '</span></td>' +
                '<td class="as-cmp__name">' + esc(ch.objName || '') + '</td>' +
                '<td>' + esc(ch.detail || '') + '</td>' +
                '</tr>';
        }
        $('#asChangeBody').html(html);
    }
    function loadVersionDetail(verId) {
        if (!verId) { state.ver = null; renderVersions(); renderVerDetail(null); return; }
        if (state.verCache[verId]) {
            applyVerDetail(state.verCache[verId]);
            return;
        }
        UI.loading($('#asChangeBody'), true);
        Api.appSchema.version(verId, state.appId).done(function (res) {
            state.verCache[verId] = res || {};
            applyVerDetail(res || {});
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '版本详情加载失败' });
        }).always(function () { UI.loading($('#asChangeBody'), false); });
    }
    function applyVerDetail(res) {
        var v = $.extend({}, res.version || {});
        v.changes = res.changes || [];
        v.scripts = res.scripts || [];
        state.ver = v;
        renderVersions();
        renderVerDetail(v);
        renderScripts();
    }
    function publishDraft() {
        var v = state.ver;
        if (!v || v.kind !== 'draft') { return; }
        UI.dialog({
            title: '发布草稿 · ' + verTitle(v),
            width: 560,
            content: '<div class="as-form">' +
                '<div class="form-tip" style="margin-bottom:8px">发布后：生成正式版号 + 正向 / 回滚脚本；' +
                '脚本状态为「待执行」，<b>平台不会自动执行</b>，需要你人工确认后手工执行并回写状态。</div>' +
                '<div class="el-form-item"><label class="el-form-item__label" for="asPubSummary">变更摘要</label>' +
                '<div class="el-form-item__content"><div class="el-input">' +
                '<input class="el-input__inner" type="text" id="asPubSummary" maxlength="200" value="' +
                esc(v.summary || '') + '"></div></div></div>' +
                '<div class="el-form-item"><label class="el-form-item__label" for="asPubRemark">发布说明</label>' +
                '<div class="el-form-item__content"><div class="el-input">' +
                '<input class="el-input__inner" type="text" id="asPubRemark" maxlength="200" placeholder="选填，如提测版本 / 变更单号">' +
                '</div></div></div></div>',
            onOk: function ($body, close) {
                var summary = trim($body.find('#asPubSummary').val());
                var remark = trim($body.find('#asPubRemark').val());
                UI.loading($body, true, '发布中…');
                Api.appSchema.publish(v.id, summary, remark, state.appId).done(function (res) {
                    close();
                    var d = res || {};
                    var gen = d.generated || {};
                    UI.message({ type: 'success', message: '已发布 ' + (d.version && d.version.versionNo ? d.version.versionNo : '') +
                        '：生成正向语句 ' + (gen.forward || 0) + ' 条、回滚语句 ' + (gen.rollback || 0) + ' 条（待人工执行）' });
                    state.verCache = {};
                    state.ver = null;
                    loadVersions();
                    loadTree(true);
                    switchTab('scripts');
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '发布失败' });
                }).always(function () { UI.loading($body, false); });
            }
        });
    }
    function discardDraft() {
        var v = state.ver;
        if (!v || v.kind !== 'draft') { return; }
        UI.confirm({
            title: '丢弃草稿',
            message: '确定丢弃草稿「' + verTitle(v) + '」吗？丢弃后这份草稿不再出现在历史里（结构本身不受影响）。',
            confirmText: '丢弃'
        }).done(function (yes) {
            if (!yes) { return; }
            Api.appSchema.discard(v.id, state.appId).done(function () {
                UI.message({ type: 'success', message: '草稿已丢弃' });
                state.verCache = {};
                state.ver = null;
                loadVersions();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '操作失败' });
            });
        });
    }

    /* ================= 版本脚本 ================= */
    function fillScriptVersions() {
        var list = state.versions || [], html = '', i, releases = 0;
        for (i = 0; i < list.length; i++) {
            var v = list[i];
            var hasScript = v.kind === 'release';
            if (hasScript) { releases++; }
            html += '<option value="' + esc(v.id) + '"' + (hasScript ? '' : ' disabled') + '>' +
                esc(verTitle(v) + ' · ' + (v.statusLabel || '')) + (hasScript ? '' : '（无脚本）') + '</option>';
        }
        if (!releases) {
            html = '<option value="">还没有正式版（发布草稿后才有脚本）</option>';
        }
        var $sel = $('#asScriptVer');
        var keep = $sel.val();
        $sel.html(html);
        var pick = '';
        if (keep && $sel.find('option[value="' + keep + '"]:not([disabled])').length) { pick = keep; }
        else { $sel.find('option:not([disabled])').each(function () { if (!pick) { pick = this.value; } }); }
        $sel.val(pick);
        renderScripts();
    }
    function currentScript() {
        var v = state.ver, key = state.scriptKind, i;
        if (!v || !v.scripts) { return null; }
        for (i = 0; i < v.scripts.length; i++) {
            if (v.scripts[i].kind === key) { return v.scripts[i]; }
        }
        return null;
    }
    function renderScripts() {
        var v = state.ver, script = currentScript();
        var pending = !!(script && script.status === 'pending');
        $('#asBtnScriptOk').prop('disabled', !pending);
        $('#asBtnScriptSkip').prop('disabled', !pending);
        $('#asBtnScriptFail').prop('disabled', !pending);
        $('#asBtnScriptCopy').prop('disabled', !script);
        $('#asBtnScriptDown').prop('disabled', !script);
        if (!v) {
            $('#asScript').val('');
            $('#asScriptState').html('');
            $('#asScriptFoot').html('在「变更历史」里选一个正式版，这里会显示它发布时生成的脚本');
            return;
        }
        if (!script) {
            $('#asScript').val('');
            $('#asScriptState').html('<span class="as-tag ' + verTone(v) + '">' +
                esc(v.kind === 'draft' ? '草稿没有脚本' : '该版本没有脚本') + '</span>');
            $('#asScriptFoot').html(v.kind === 'draft'
                ? '草稿只有变更明细；点「变更历史」里的<b>发布草稿</b>才会生成正式版与脚本'
                : '这个版本没有可用脚本');
            return;
        }
        $('#asScript').val(script.scriptText || '');
        var tone = script.status === 'applied' ? 'is-applied' :
            (script.status === 'failed' ? 'is-fail' : (script.status === 'skipped' ? 'is-old' : 'is-draft'));
        $('#asScriptState').html('<span class="as-tag ' + tone + '">' +
            esc((script.kindLabel || (script.kind === 'forward' ? '正向' : '回滚')) + ' · ' +
                (script.statusLabel || script.status)) + '</span>');
        var foot = '版本 <b>' + esc(verTitle(v)) + '</b> · 方言 <b>' +
            esc((v.dbTypeLabel || v.dbType || '')) + '</b> · 校验值 <b>' +
            esc(String(script.checksum || '').slice(0, 12)) + '</b>';
        if (script.confirmTime) { foot += ' · 确认时间 <b>' + esc(String(script.confirmTime).slice(0, 16)) + '</b>'; }
        if (script.execError) { foot += ' · 失败原因 <b>' + esc(script.execError) + '</b>'; }
        $('#asScriptFoot').html(foot);
    }
    function markScript(status) {
        var script = currentScript();
        if (!script) { return; }
        var tip = status === 'applied' ? '确认这段脚本已经在目标数据库执行成功？系统只记录状态，不会执行脚本。'
            : (status === 'failed' ? '记录为执行失败（可填写失败原因）。' : '记录为「外部执行」（在其他工具里手工跑过）。');
        var needReason = status === 'failed';
        UI.dialog({
            title: status === 'applied' ? '标记已执行' : (status === 'failed' ? '记录执行失败' : '记录外部执行'),
            width: 520,
            content: '<div class="as-form"><div class="form-tip" style="margin-bottom:8px">' + esc(tip) + '</div>' +
                (needReason ? '<textarea class="as-form__ddl" id="asExecErr" style="height:110px" ' +
                    'placeholder="失败原因，如：ORA-00942 表或视图不存在"></textarea>' : '') + '</div>',
            onOk: function ($body, close) {
                var reason = needReason ? String($body.find('#asExecErr').val() || '') : '';
                UI.loading($body, true, '提交中…');
                Api.appSchema.scriptstatus(script.id, status, reason, state.appId).done(function () {
                    close();
                    UI.message({ type: 'success', message: '脚本状态已更新' });
                    var vid = state.ver && state.ver.id;
                    state.verCache = {};
                    if (vid) { loadVersionDetail(vid); }
                    loadVersions();
                    loadTree(true);
                }).fail(function (err) {
                    UI.message({ type: 'error', message: (err && err.message) || '更新失败' });
                }).always(function () { UI.loading($body, false); });
            }
        });
    }
    function copyScript() {
        var text = $('#asScript').val();
        if (!text) { return; }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () {
                    UI.message({ type: 'success', message: '脚本已复制' });
                }, function () { fallbackCopy(text); });
            } else { fallbackCopy(text); }
        } catch (e) { fallbackCopy(text); }
    }
    function fallbackCopy(text) {
        var $ta = $('#asScript');
        $ta.trigger('select');
        try {
            document.execCommand('copy');
            UI.message({ type: 'success', message: '脚本已复制' });
        } catch (e) {
            UI.message({ type: 'warning', message: '复制失败，请手动全选复制' });
        }
        if (window.getSelection) {
            var sel = window.getSelection();
            if (sel && sel.removeAllRanges) { sel.removeAllRanges(); }
        }
    }
    function saveBlob(name, blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = String(name || 'export').replace(/[\\/:*?"<>|]/g, '_');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    }
    function saveText(name, text) {
        saveBlob(name, new Blob([text || ''], { type: 'text/plain;charset=utf-8' }));
    }
    function downloadScript() {
        var v = state.ver, script = currentScript();
        if (!script) { return; }
        saveText((state.tree && state.tree.app ? state.tree.app.code : 'app') + '_' +
            verTitle(v) + '_' + (script.kind === 'forward' ? 'forward' : 'rollback') + '.sql',
            script.scriptText || '');
    }

    /* ================= 导出表结构文档（Excel / Word） ================= */
    /* 勾选 → 导出：文档里带应用信息、每张表的中文名、字段中文名、导出时间与导出人。
       内容取设计态（不连真实库），由后端 /api/appschema/exportdocs 生成文件流。 */
    function openDocsExport() {
        if (!state.appId) { UI.message({ type: 'warning', message: '先选择一个应用' }); return; }
        var total = pickableCount();
        if (!total) {
            UI.message({ type: 'warning', message: '这个应用还没有表 / 视图可以导出：先扫描导入，或点「新增库 / 新增对象」手工录入' });
            return;
        }
        var picked = pickedIds().length;
        var body = '<div class="as-doc">' +
            '<div class="as-doc__range" id="asDocRange"></div>' +
            '<div class="as-doc__opts">' +
                '<label class="as-up__chk"><input type="checkbox" id="asDocAll"> 忽略勾选，导出全部表 / 视图</label>' +
                '<span class="as-up__spacer"></span>' +
                '<span class="as-doc__count" id="asDocCount"></span>' +
            '</div>' +
            '<div class="as-doc__cards">' +
                '<button type="button" class="as-doc__card" data-fmt="xlsx">' +
                    '<span class="as-doc__ico is-xlsx">X</span>' +
                    '<span class="as-doc__name">Excel 工作簿</span>' +
                    '<span class="as-doc__desc">.xlsx · 应用信息 / 表清单 / 字段明细三个页签，方便筛选与二次整理</span>' +
                '</button>' +
                '<button type="button" class="as-doc__card" data-fmt="docx">' +
                    '<span class="as-doc__ico is-docx">W</span>' +
                    '<span class="as-doc__name">Word 文档</span>' +
                    '<span class="as-doc__desc">.docx · 封面应用信息 + 表清单 + 每张表一节，可直接交付 / 评审</span>' +
                '</button>' +
            '</div>' +
            '<div class="as-doc__foot">文档内容：应用信息（编码 / 名称 / 类型 / 环境 / 部门 / 负责人 / 目标库）·' +
                ' 表清单与表中文字段中文名 · 字段明细 · 导出时间与导出人。取自平台设计态，不连真实数据库。</div>' +
            '</div>';
        var dlg = UI.dialog({
            title: '导出表结构文档', width: 660, content: body,
            onReady: function ($body, close) {
                function sync() {
                    var all = $('#asDocAll').is(':checked');
                    var n = all ? total : pickedIds().length;
                    $('#asDocRange').html(all
                        ? '导出范围：<b>全部表 / 视图（' + total + ' 张）</b>'
                        : (n ? '导出范围：<b>已勾选的 ' + n + ' 张表</b>（共 ' + total + ' 张）'
                             : '导出范围：<b>全部表 / 视图（' + total + ' 张）</b>' +
                               '　<em>未勾选任何表时默认导出全部</em>'));
                    $('#asDocCount').text(n ? n + ' 张表' : '');
                }
                sync();
                $('#asDocAll').on('change', sync);
                $body.on('click', '.as-doc__card', function () {
                    runDocsExport($(this).attr('data-fmt'), $body, close);
                });
            }
        });
        /* 导出由两张卡片直接触发，底部的「取消 / 确定」留着只会让人点错 */
        dlg.el.find('.el-dialog__footer').remove();
    }
    function runDocsExport(fmt, $body, close) {
        var label = fmt === 'docx' ? 'Word' : 'Excel';
        var ids = $('#asDocAll').is(':checked') ? '' : pickedIds().join(',');
        UI.loading($body, true, '正在生成 ' + label + ' 文档…');
        Api.appSchema.exportdocs(state.appId, { ids: ids, format: fmt }).done(function (res) {
            var data = res || {};
            if (!data.blob) {
                UI.loading($body, false);
                UI.alert({ type: 'error', title: '导出失败', message: '没有拿到文件内容，请重试' });
                return;
            }
            saveBlob(data.filename || (appCode() + '_表结构.' + fmt), data.blob);
            UI.loading($body, false);
            close();
            var bits = [];
            if (data.tableCount) { bits.push(data.tableCount + ' 张表'); }
            if (data.colCount) { bits.push(data.colCount + ' 个字段'); }
            UI.message({ type: 'success', message: '已导出 ' + label + (bits.length ? '（' + bits.join(' / ') + '）' : '') });
        }).fail(function (err) {
            UI.loading($body, false);
            UI.alert({ type: 'error', title: '导出失败', message: (err && err.message) || '导出失败' });
        });
    }

    /* ================= 实库对比 ================= */
    /* 对比目标 = 「连接对象 → 数据库」两步选：
       · 连接默认是应用绑定那个（开发库），可以换成线上生产库的连接 —— 上线前用它比一次，
         才知道生产库还差哪些结构、升级脚本要执行什么；
       · 库名单来自连接实况（不是设计态），所以线上库改名 / 多一个库都能选到；
       · 实库库名和设计态库名不同（db_prod ↔ db_dev）时，用「对应设计态库」指定映射。 */
    function loadCmpConns() {
        if (!state.appId) { return; }
        Api.appSchema.compareconns(state.appId).done(function (res) {
            var d = res || {}, list = d.list || [], html = '', i, pick = state.cmpConnId || d.boundConnId || '';
            if (!list.length) {
                $('#asCmpConn').html('<option value="">（没有同方言的可用连接）</option>');
                $('#asCmpDb').html('<option value="">（先到「数据库连接」里建一个）</option>');
                $('#asCmpDesignWrap').attr('hidden', 'hidden');
                return;
            }
            for (i = 0; i < list.length; i++) {
                html += '<option value="' + esc(list[i].id) + '">' +
                    esc(list[i].name || list[i].id) + (list[i].isBound ? '（应用绑定）' : '') +
                    (list[i].enabled ? '' : '（已停用）') + '</option>';
            }
            $('#asCmpConn').html(html);
            var has = false;
            for (i = 0; i < list.length; i++) { if (String(list[i].id) === String(pick)) { has = true; } }
            if (!has) { pick = list[0].id; }
            state.cmpConns = list;
            state.cmpConnId = String(pick);
            $('#asCmpConn').val(state.cmpConnId);
            loadCmpDbs();
        }).fail(function (err) {
            $('#asCmpConn').html('<option value="">（连接列表读取失败）</option>');
            $('#asCmpDb').html('<option value="">' + esc((err && err.message) || '读取失败') + '</option>');
        });
    }
    /* 选定连接 → 取它能访问的库（只有名称，不读表结构） */
    function loadCmpDbs() {
        var connId = $('#asCmpConn').val() || '';
        state.cmpConnId = connId;
        if (!connId) {
            $('#asCmpDb').html('<option value="">（没有可用连接）</option>');
            fillCmpDesignDb();
            return;
        }
        $('#asCmpDb').html('<option value="">（正在读取库…）</option>');
        Api.appSchema.scaninfo(state.appId, connId).done(function (res) {
            var d = res || {}, dbs = d.databases || [], html = '', i, target = d.target || '';
            if (d.error) {
                $('#asCmpDb').html('<option value="">（' + esc(d.error) + '）</option>');
                fillCmpDesignDb();
                return;
            }
            for (i = 0; i < dbs.length; i++) {
                if (dbs[i].system && dbs[i].name !== target) { continue; }
                html += '<option value="' + esc(dbs[i].name) + '">' + esc(dbs[i].name) +
                    (dbs[i].system ? '（系统库）' : '') + '</option>';
            }
            if (!html) { html = '<option value="">（连接里没有可访问的库）</option>'; }
            $('#asCmpDb').html(html);
            state.cmpConnName = d.connName || '';
            state.cmpConnHost = (d.connHost || '') + (d.connPort ? ':' + d.connPort : '');
            var want = state.cmpDb || target;
            if (want) {
                var exists = false;
                for (i = 0; i < dbs.length; i++) { if (dbs[i].name === want) { exists = true; } }
                if (exists) { $('#asCmpDb').val(want); }
            }
            if (!$('#asCmpDb').val() && dbs.length) {
                for (i = 0; i < dbs.length; i++) {
                    if (!dbs[i].system) { $('#asCmpDb').val(dbs[i].name); break; }
                }
            }
            state.cmpDb = $('#asCmpDb').val() || '';
            fillCmpDesignDb();
        }).fail(function (err) {
            $('#asCmpDb').html('<option value="">' + esc((err && err.message) || '库读取失败') + '</option>');
            fillCmpDesignDb();
        });
    }
    /* 设计态库下拉：实库库名与设计态同名就直接对上；只有一个库自动对上；多个库又不同名就必须选 */
    function fillCmpDesignDb() {
        var dbs = (state.tree && state.tree.databases) || [], liveDb = $('#asCmpDb').val() || '';
        var html = '', i, same = false, pick = '';
        for (i = 0; i < dbs.length; i++) {
            if (dbs[i].dbName === liveDb) { same = true; }
            html += '<option value="' + esc(dbs[i].dbName) + '">' + esc(dbs[i].dbName) + '</option>';
        }
        if (!html) { html = '<option value="">（设计态还没有库）</option>'; }
        $('#asCmpDesignDb').html(html);
        if (same) { pick = liveDb; }
        else if (dbs.length === 1) { pick = dbs[0].dbName; }
        if (pick) { $('#asCmpDesignDb').val(pick); }
        /* 只在「需要人确认映射」时露出来：库名不同，或设计态有多个库 */
        var show = !!liveDb && !same && dbs.length > 0;
        if (show) { $('#asCmpDesignWrap').removeAttr('hidden'); }
        else { $('#asCmpDesignWrap').attr('hidden', 'hidden'); }
    }
    function loadCompares() {
        if (!state.appId) { return; }
        Api.appSchema.compares(state.appId).done(function (res) {
            var list = (res && res.list) || [], html = '<option value="">历史对比记录</option>';
            $.each(list, function (i, one) {
                var where = one.connName ? (one.connName + ' / ') : '';
                html += '<option value="' + esc(one.id) + '">' +
                    esc(String(one.snapTime || one.createTime || '').slice(0, 16) + ' · ' + where +
                        (one.dbName || '') + ' · ' +
                        (one.diffCount ? ('差异 ' + one.diffCount) : '一致')) + '</option>';
            });
            $('#asCmpHistory').html(html);
        });
    }
    function renderCmpCards(counts, snapTime) {
        if (!counts) { $('#asCmpCards').html(''); return; }
        var html = '';
        html += '<div class="as-cmp__card is-design"><b>' + (counts.designOnly || 0) + '</b><span>仅设计态有（标红）</span></div>';
        html += '<div class="as-cmp__card is-db"><b>' + (counts.dbOnly || 0) + '</b><span>仅实库有</span></div>';
        html += '<div class="as-cmp__card is-attr"><b>' + ((counts.attrDiff || 0) + (counts.orderDiff || 0)) +
            '</b><span>属性 / 顺序不同</span></div>';
        html += '<div class="as-cmp__card is-same"><b>' + (counts.same || 0) + '</b><span>完全一致</span></div>';
        $('#asCmpCards').html(html);
        if (snapTime) {
            $('#asCmpTip').text('实库数据时间点 ' + String(snapTime).slice(0, 19) + '；结果已留存，可在右侧下拉回看');
        }
    }
    /* 差异说明：一条差异一行（实库缺哪个字段、哪个属性从什么变成什么） */
    function cmpDetailHtml(it) {
        var list = it.details || [], html = '', i;
        if (!list.length) {
            return '<div class="as-cmp__msg">' + esc(it.message || '') + '</div>';
        }
        html += '<div class="as-cmp__details">';
        for (i = 0; i < list.length; i++) {
            html += '<div class="as-cmp__detail is-' + esc(list[i].kind || 'other') + '">' +
                '<i class="as-cmp__dot"></i>' + esc(list[i].text || '') + '</div>';
        }
        html += '</div>';
        if (it.upgradeNote) {
            html += '<div class="as-cmp__note">' + esc(it.upgradeNote) + '</div>';
        }
        return html;
    }
    function cmpSqlHtml(it) {
        var n = parseInt(it.upgradeCount, 10) || 0;
        if (!n) { return '<span class="as-cmp__none" title="这一项没有可自动生成的语句">—</span>'; }
        return '<a href="javascript:;" class="as-cmp__sql" data-obj="' + esc(it.objName || '') + '"' +
            ' title="查看这一项对应的升级语句">' + n + ' 条</a>';
    }
    function renderCmpItems(items) {
        var list = items || [], html = '', i;
        if (state.cmpDiffOnly) {
            var filtered = [];
            for (i = 0; i < list.length; i++) { if (list[i].diffType !== 'same') { filtered.push(list[i]); } }
            list = filtered;
        }
        if (!list.length) {
            $('#asCmpBody').html('<tr><td colspan="5"><div class="as-cmp__empty">' +
                (state.cmp ? '没有符合条件的差异项' : '还没有对比结果：点右上角「开始对比」（只有人工触发才会扫描实库）') +
                '</div></td></tr>');
            return;
        }
        for (i = 0; i < list.length; i++) {
            var it = list[i];
            html += '<tr class="is-' + esc(it.diffType) + '">' +
                '<td><span class="as-diff is-' + esc(it.diffType) + '">' +
                    esc(it.diffLabel || it.diffType) + '</span></td>' +
                '<td>' + esc(objLabel(it.objType)) + '</td>' +
                '<td class="as-cmp__name">' + esc(it.objName || '') + '</td>' +
                '<td class="as-cmp__detail-cell">' + cmpDetailHtml(it) + '</td>' +
                '<td class="as-cmp__sql-cell">' + cmpSqlHtml(it) + '</td>' +
                '</tr>';
        }
        $('#asCmpBody').html(html);
    }
    function runCompare() {
        if (!state.appId) { UI.message({ type: 'warning', message: '先选择一个应用' }); return; }
        var connId = $('#asCmpConn').val() || '';
        if (!connId) {
            UI.alert({ type: 'warning', title: '不能对比',
                message: '没有可用的数据库连接：先到「数据库连接」里建一个（要对比线上生产库，就用线上那台的连接）。' });
            return;
        }
        var dbName = $('#asCmpDb').val() || '';
        if (!dbName) {
            UI.alert({ type: 'warning', title: '先选目标库',
                message: '这次对比的实库库还没选：在「目标库」里选一个（连接里读不到库时先检查连接）。' });
            return;
        }
        var designDb = $('#asCmpDesignDb').val() || '';
        if (!designDb && (state.tree && (state.tree.databases || []).length)) {
            UI.alert({ type: 'warning', title: '先选对应设计态库',
                message: '实库库【' + dbName + '】在设计态没有同名库：请先在「对应设计态库」里选它对应哪一个，' +
                    '否则会把整库都算成差异。' });
            return;
        }
        UI.loading($('#asCmpBody'), true, '正在扫描实库并比对…（表多时要几分钟到十几分钟，请勿重复点击）');
        Api.appSchema.compare(state.appId, {
            connId: connId,
            dbName: dbName,
            designDb: designDb,
            leftKind: $('#asCmpLeft').val() || 'design'
        }).done(function (res) {
            state.cmp = res || {};
            state.cmpItems = (res && res.items) || [];
            renderCmpCards((res && res.counts) || {}, res && res.snapTime);
            renderCmpItems(state.cmpItems);
            showCmpTarget(res);
            if (res && res.truncated) {
                UI.message({ type: 'warning', message: '差异项超过 500 条，只显示前 500 条（完整明细可在历史记录里分页查看）' });
            }
            loadCompares();
        }).fail(function (err) {
            UI.alert({ type: 'error', title: '对比失败', message: (err && err.message) || '对比失败' });
        }).always(function () { UI.loading($('#asCmpBody'), false); });
    }
    /* 提示当前这轮比的是哪台机器上的哪个库（线上 / 生产库时尤其要看清楚） */
    function showCmpTarget(res) {
        if (!res) { return; }
        var where = (res.connName || '') + (res.connHost ? '（' + res.connHost + '）' : '');
        var text = '实库 ' + (where || '连接未记录') + ' / 库 ' + (res.dbName || '') +
            (res.designDb && res.designDb !== res.dbName ? '（对应设计态库 ' + res.designDb + '）' : '') +
            ' · 数据时间点 ' + String(res.snapTime || '').slice(0, 19) + '；结果已留存，可在右侧下拉回看';
        $('#asCmpTip').text(text);
    }
    function loadCompareHistory(cmpId) {
        if (!cmpId) { return; }
        UI.loading($('#asCmpBody'), true);
        Api.appSchema.compareitems(cmpId, { pageNum: 1, pageSize: 500 }).done(function (res) {
            var d = res || {};
            state.cmp = { id: cmpId, snapTime: d.head && d.head.snapTime };
            state.cmpItems = d.list || [];
            renderCmpCards(d.counts || {}, d.head && d.head.snapTime);
            renderCmpItems(state.cmpItems);
            showCmpTarget(d.head);
        }).fail(function (err) {
            UI.message({ type: 'error', message: (err && err.message) || '对比明细加载失败' });
        }).always(function () { UI.loading($('#asCmpBody'), false); });
    }

    /* ================= 升级脚本（实库 → 设计态） ================= */
    function stampName() {
        var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
    }
    function appCode() { return (state.tree && state.tree.app && state.tree.app.code) || 'app'; }
    function openUpgradeDialog(focusObj) {
        var cmp = state.cmp;
        if (!cmp || !cmp.id) {
            UI.message({ type: 'warning', message: '先点「开始对比」，或在右上角选一条历史对比记录' });
            return;
        }
        var body = '<div class="as-up">' +
            '<div class="as-up__summary" id="asUpSummary">正在生成升级脚本…</div>' +
            '<div class="as-up__opts">' +
                '<label class="as-up__chk"><input type="checkbox" id="asUpDrop">' +
                ' 包含删除语句（DROP TABLE / DROP COLUMN，会丢数据）</label>' +
                '<span class="as-up__spacer"></span>' +
                '<button type="button" class="el-button el-button--small" id="asUpCopy">复制</button>' +
                '<button type="button" class="el-button el-button--small el-button--primary"' +
                ' id="asUpDown">下载 .sql</button>' +
            '</div>' +
            '<textarea class="as-up__text" id="asUpText" readonly spellcheck="false"></textarea>' +
            '<div class="as-up__foot" id="asUpFoot"></div>' +
            '</div>';
        UI.dialog({
            title: '升级脚本 · 实库 → 设计态', width: 920, content: body,
            onReady: function ($body) {
                var $dlg = $body.closest('.el-dialog');
                $dlg.find('.btn-ok').text('关闭');
                $dlg.find('.btn-cancel').hide();
                var last = null;
                function paint(res) {
                    last = res || {};
                    $('#asUpText').val(last.text || '');
                    var bits = [];
                    bits.push('<b>' + (last.count || 0) + '</b> 条语句');
                    bits.push('覆盖 <b>' + (last.objects || 0) + '</b> 个对象');
                    bits.push('差异 <b>' + (last.diffCount || 0) + '</b> 项');
                    if (last.skipped) { bits.push('跳过 <b>' + last.skipped + '</b> 项'); }
                    bits.push('目标库 <b>' + esc(last.dbName || '—') + '</b>');
                    bits.push('方言 <b>' + esc(last.dbTypeLabel || last.dbType || '') + '</b>');
                    $('#asUpSummary').html(bits.join(' · '));
                    var foot = '实库数据时间点 <b>' + esc(String(last.snapTime || '').slice(0, 19)) + '</b>' +
                        ' · 脚本不会自动执行，请先备份再人工确认执行';
                    if (last.errors && last.errors.length) {
                        foot += '<br><span class="as-up__err">有 ' + last.errors.length +
                            ' 个对象生成失败：' + esc(last.errors.slice(0, 3).join('；')) + '</span>';
                    }
                    $('#asUpFoot').html(foot);
                }
                function load() {
                    UI.loading($body, true, '生成升级脚本…');
                    Api.appSchema.compareupgrade(cmp.id, {
                        appId: state.appId,
                        includeDrop: $('#asUpDrop').is(':checked') ? 1 : 0
                    }).done(paint).fail(function (err) {
                        $('#asUpSummary').html('<span class="as-up__err">' +
                            esc((err && err.message) || '脚本生成失败') + '</span>');
                        $('#asUpText').val('');
                    }).always(function () { UI.loading($body, false); });
                }
                $('#asUpDrop').on('change', load);
                $('#asUpCopy').on('click', function () {
                    var text = $('#asUpText').val();
                    if (!text) { return; }
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text).then(function () {
                            UI.message({ type: 'success', message: '脚本已复制' });
                        }, function () { $('#asUpText').trigger('select'); document.execCommand('copy'); });
                    } else {
                        $('#asUpText').trigger('select');
                        try { document.execCommand('copy'); UI.message({ type: 'success', message: '脚本已复制' }); }
                        catch (e) { UI.message({ type: 'warning', message: '复制失败，请手动全选复制' }); }
                    }
                });
                $('#asUpDown').on('click', function () {
                    if (!last || !last.text) { UI.message({ type: 'warning', message: '还没有可下载的脚本' }); return; }
                    saveText(appCode() + '_upgrade_' + stampName() + '.sql', last.text);
                });
                load();
                if (focusObj) {
                    UI.message({ type: 'info', message: '脚本里已包含 ' + focusObj + ' 的语句' });
                }
            }
        });
    }

    /* ================= 批量导出（多条对比记录合成一份） ================= */
    function openExportDialog() {
        if (!state.appId) { UI.message({ type: 'warning', message: '先选择一个应用' }); return; }
        UI.loading($('body'), true, '读取对比记录…');
        Api.appSchema.compares(state.appId).done(function (res) {
            UI.loading($('body'), false);
            var list = (res && res.list) || [], rows = '', i, picked = 0;
            if (!list.length) {
                UI.message({ type: 'warning', message: '这个应用还没有对比记录，先在对比页点「开始对比」' });
                return;
            }
            for (i = 0; i < list.length; i++) {
                var one = list[i], diff = parseInt(one.diffCount, 10) || 0;
                var on = diff > 0 && picked < 20;
                if (on) { picked++; }
                rows += '<label class="as-ex__row' + (diff ? '' : ' is-same') + '">' +
                    '<input type="checkbox" class="as-ex__pick" value="' + esc(one.id) + '"' +
                        (on ? ' checked' : '') + '>' +
                    '<span class="as-ex__when">' + esc(String(one.snapTime || one.createTime || '').slice(0, 16)) + '</span>' +
                    '<span class="as-ex__db" title="实库连接 / 目标库">' +
                        esc((one.connName ? one.connName + ' / ' : '') + (one.dbName || '—')) + '</span>' +
                    '<span class="as-ex__diff">' + (diff ? '差异 ' + diff + ' 项' : '完全一致') + '</span>' +
                    '</label>';
            }
            var body = '<div class="as-ex">' +
                '<div class="as-ex__tip">勾选要合并导出的对比记录（最多 50 条）。每条记录在脚本里各占一段：' +
                '可以整份执行，也可以只挑其中一段。默认只选有差异的最近 20 条。</div>' +
                '<div class="as-ex__opts">' +
                    '<label class="as-up__chk"><input type="checkbox" id="asExDrop">' +
                    ' 包含删除语句（DROP，会丢数据）</label>' +
                    '<span class="as-up__spacer"></span>' +
                    '<label class="as-up__chk"><input type="checkbox" id="asExAll"> 全选</label>' +
                    '<span class="as-ex__count" id="asExCount"></span>' +
                '</div>' +
                '<div class="as-ex__list" id="asExList">' + rows + '</div>' +
                '</div>';
            UI.dialog({
                title: '批量导出升级脚本', width: 720, content: body,
                onReady: function ($body) {
                    function sync() {
                        var n = $body.find('.as-ex__pick:checked').length;
                        $('#asExCount').text('已选 ' + n + ' 条');
                    }
                    sync();
                    $body.on('change', '.as-ex__pick', sync);
                    $('#asExAll').on('change', function () {
                        $body.find('.as-ex__pick').prop('checked', $(this).is(':checked'));
                        sync();
                    });
                },
                onOk: function ($body, close) {
                    var ids = [];
                    $body.find('.as-ex__pick:checked').each(function () { ids.push($(this).val()); });
                    if (!ids.length) { UI.message({ type: 'warning', message: '至少勾选一条对比记录' }); return; }
                    UI.loading($body, true, '生成合并脚本…');
                    Api.appSchema.compareexport(state.appId, {
                        ids: ids.join(','), includeDrop: $('#asExDrop').is(':checked') ? 1 : 0
                    }).done(function (exp) {
                        var data = exp || {};
                        saveText(data.fileName || (appCode() + '_upgrade.sql'), data.text || '');
                        close();
                        UI.message({ type: 'success', message: '已导出 ' + (data.count || ids.length) +
                            ' 条对比记录 / ' + (data.statements || 0) + ' 条语句' });
                    }).fail(function (err) {
                        UI.alert({ type: 'error', title: '导出失败', message: (err && err.message) || '导出失败' });
                    }).always(function () { UI.loading($body, false); });
                }
            });
        }).fail(function (err) {
            UI.loading($('body'), false);
            UI.message({ type: 'error', message: (err && err.message) || '对比记录加载失败' });
        });
    }

    /* ================= 标签页 ================= */
    function switchTab(name) {
        state.tab = name;
        $('#asTabNav .el-tabs__item').each(function () {
            var on = $(this).attr('data-tab') === name;
            $(this).toggleClass('is-active', on).attr('aria-selected', on ? 'true' : 'false');
        });
        $('#asTabs > .el-tabs__content > .el-tab-pane').each(function () {
            $(this).toggleClass('is-active', $(this).attr('data-pane') === name);
        });
        if (name === 'versions') { loadVersions(); }
        if (name === 'scripts') {
            if (!state.ver) {
                /* 默认带出最新正式版，省得再点一次 */
                var list = state.versions || [], i;
                for (i = 0; i < list.length; i++) {
                    if (list[i].kind === 'release') { loadVersionDetail(list[i].id); break; }
                }
            } else { renderScripts(); }
        }
        if (name === 'compare') {
            loadCompares();
            /* 连接列表按应用缓存：切页签不重复连库（生产库走公网时连一次要几秒），换应用会清掉 */
            if (!state.cmpConns) { loadCmpConns(); }
        }
        if (name === 'lineage') { loadLineage(); }
    }

    /* ================= 事件 ================= */
    $('#asApp').on('change', function () {
        state.appId = $(this).val() || '';
        state.kind = ''; state.id = ''; state.name = '';
        state.obj = null; state.cols = [];
        state.ver = null; state.verCache = {};
        state.versions = [];
        state.cmp = null; state.cmpItems = [];
        state.cmpConns = null; state.cmpConnId = ''; state.cmpDb = '';
        state.lineage = null; state.lineageCol = '';
        state.lgObjCols = {};                  // 字段缓存按应用隔离（objId 不跨应用）
        state.picked = {};                     // 换应用就清空勾选（objId 不跨应用）
        renderCols(); renderVerDetail(null); renderCmpCards(null); renderLineage();
        $('#asCmpConn').html('<option value="">（应用绑定的连接）</option>');
        $('#asCmpDb').html('<option value="">（还没有库）</option>');
        $('#asCmpDesignWrap').attr('hidden', 'hidden');
        $('#asCmpTip').text('对比结果会留存，可在右侧下拉里回看历次记录');
        $('#asVerBody').html('<tr><td colspan="5"><div class="as-vers__empty">加载中…</div></td></tr>');
        $('#asPickHint').text('');
        loadTree();
        loadVersions();
    });
    $('#asTree').on('click', '.as-node__caret', function (e) {
        e.stopPropagation();
        var $node = $(this).closest('.as-node');
        if ($node.attr('data-kind') !== 'db') { return; }
        var id = String($node.attr('data-id'));
        var $children = $node.children('.as-node__children');
        var open = !($children.prop('hidden') === true || $children.attr('hidden') !== undefined);
        if (open) { $children.attr('hidden', 'hidden'); $(this).text('▸'); }
        else { $children.removeAttr('hidden'); $(this).text('▾'); }
        state.expanded[id] = !open;
    });
    $('#asTree').on('click', '.as-node__row', function () {
        var $node = $(this).closest('.as-node');
        var kind = $node.attr('data-kind'), id = $node.attr('data-id');
        selectNode(kind, id, $node.attr('data-name'), $node.attr('data-db') || '', $node.attr('data-objtype') || '');
    });
    $('#asTree').on('dblclick', '.as-node__row', function () {
        var $node = $(this).closest('.as-node');
        if ($node.attr('data-kind') !== 'obj') { return; }
        switchTab('cols');
    });
    $('#asTree').on('click', '.as-node__pick', function (e) {
        e.stopPropagation();                 // 勾选不切换右侧选中节点
    });
    $('#asTree').on('change', '.as-node__pick', function () {
        var $pick = $(this);
        var $node = $pick.closest('.as-node');
        if (String($node.attr('data-kind')) === 'db') {
            /* 库：勾上就选本库全部表 / 视图，取消就全部取消 */
            var on = $pick.is(':checked');
            $node.children('.as-node__children').find('.as-node__pick').each(function () {
                $(this).prop('checked', on);
                var id = String($(this).val());
                if (on) { state.picked[id] = 1; } else { delete state.picked[id]; }
            });
        } else {
            var id = String($pick.val());
            if ($pick.is(':checked')) { state.picked[id] = 1; } else { delete state.picked[id]; }
        }
        syncPickState();
    });
    $('#asBtnExport').on('click', openDocsExport);
    $('#asBtnExpand').on('click', function () {
        var $all = $('#asTree .as-node[data-kind=db] > .as-node__children');
        var anyClosed = $all.filter('[hidden]').length > 0;
        if (anyClosed) { $all.removeAttr('hidden'); $('#asTree .as-node[data-kind=db] > .as-node__row .as-node__caret').text('▾'); }
        else { $all.attr('hidden', 'hidden'); $('#asTree .as-node[data-kind=db] > .as-node__row .as-node__caret').text('▸'); }
        state.expanded = {};
    });
    $('#asBtnDbAdd').on('click', function () {
        if (!state.appId) { UI.message({ type: 'warning', message: '先选择一个应用' }); return; }
        openNodeForm('dbAdd');
    });
    $('#asBtnObjAdd').on('click', function () {
        if (!state.dbId) { UI.message({ type: 'warning', message: '先在左边选中一个库（没有库就点「新增库」）' }); return; }
        openNodeForm('objAdd');
    });
    $('#asBtnNodeEdit').on('click', function () {
        if (!state.kind) { return; }
        openNodeForm(state.kind === 'db' ? 'dbEdit' : 'objEdit');
    });
    $('#asBtnNodeDel').on('click', deleteNode);
    $('#asBtnScan').on('click', runScan);
    $('#asBtnImport').on('click', openImport);
    $('#asBtnCompare').on('click', function () { switchTab('compare'); });
    $('#asBtnRefresh').on('click', function () {
        state.verCache = {};
        loadTree(true);
        loadVersions();
        loadCompares();
    });

    $('#asBtnColAdd').on('click', addColRow);
    $('#asBtnColPaste').on('click', openPaste);
    $('#asBtnColSave').on('click', saveCols);
    $('#asColsBody').on('click', '.as-col__del', function (e) {
        e.preventDefault();
        e.stopPropagation();
        deleteCol($(this).closest('tr'));
    });
    $('#asColsBody').on('change', 'input[data-f], select[data-f]', function () {
        $(this).addClass('is-dirty');
    });

    $('#asTabNav .el-tabs__item').on('click', function () {
        switchTab($(this).attr('data-tab'));
    });
    $('#asTabNav .el-tabs__item').on('keydown', function (e) {
        if (e.keyCode === 13 || e.keyCode === 32) {
            e.preventDefault();
            switchTab($(this).attr('data-tab'));
        }
    });

    $('#asVerBody').on('click', 'tr[data-id]', function () {
        var vid = String($(this).attr('data-id'));
        $('#asVerBody tr').removeClass('is-selected');
        $(this).addClass('is-selected');
        loadVersionDetail(vid);
    });
    $('#asBtnVerReload').on('click', function () {
        state.verCache = {};
        loadVersions();
    });
    $('#asBtnPublish').on('click', publishDraft);
    $('#asBtnDiscard').on('click', discardDraft);

    $('#asScriptVer').on('change', function () {
        var vid = $(this).val();
        if (vid) { loadVersionDetail(vid); }
    });
    $('#asScriptKind').on('change', function () {
        state.scriptKind = $(this).val() || 'forward';
        renderScripts();
    });
    $('#asBtnScriptCopy').on('click', copyScript);
    $('#asBtnScriptDown').on('click', downloadScript);
    $('#asBtnScriptOk').on('click', function () { markScript('applied'); });
    $('#asBtnScriptSkip').on('click', function () { markScript('skipped'); });
    $('#asBtnScriptFail').on('click', function () { markScript('failed'); });

    $('#asBtnCmpRun').on('click', runCompare);
    $('#asCmpConn').on('change', function () {
        state.cmpConnId = $(this).val() || '';
        state.cmpDb = '';                     /* 换连接：上一个连接的库名对新连接没意义 */
        loadCmpDbs();
    });
    $('#asCmpDb').on('change', function () {
        state.cmpDb = $(this).val() || '';
        fillCmpDesignDb();
    });
    $('#asBtnCmpDiff').on('click', function () {
        state.cmpDiffOnly = !state.cmpDiffOnly;
        $(this).toggleClass('el-button--primary', state.cmpDiffOnly);
        renderCmpItems(state.cmpItems);
    });
    $('#asCmpDiffType').on('change', function () {
        var t = $(this).val(), list = state.cmpItems || [], out = [], i;
        for (i = 0; i < list.length; i++) { if (!t || list[i].diffType === t) { out.push(list[i]); } }
        renderCmpItems(out);
    });
    $('#asCmpHistory').on('change', function () { loadCompareHistory($(this).val()); });
    $('#asBtnCmpSql').on('click', function () { openUpgradeDialog(''); });
    $('#asBtnCmpExport').on('click', openExportDialog);
    $('#asCmpBody').on('click', '.as-cmp__sql', function () {
        openUpgradeDialog($(this).attr('data-obj') || '');
    });

    /* ================= 字段血缘 ================= */
    /* 只对表 / 视图有意义：过程 / 触发器本身没有输出列，它们的写入体现在「被写表」的血缘里 */
    function lgTarget() {
        if (!state.obj) { return null; }
        var t = state.obj.objType;
        return (t === 'table' || t === 'view') ? state.obj : null;
    }

    function loadLineage() {
        var obj = lgTarget();
        if (!state.appId || !obj) {
            state.lineage = null;
            renderLineage();
            return;
        }
        $('#asLgStat').text('分析中…');
        Api.appSchema.lineage(state.appId, obj.objName, '').done(function (res) {
            state.lineage = res || {};
            /* 默认落在第一个「有血缘」的字段上，省得每次都先点一下 */
            var list = (res && res.fields) || [], pick = '', i;
            for (i = 0; i < list.length; i++) {
                if ((list[i].upCount || 0) + (list[i].downCount || 0) > 0) { pick = list[i].colName; break; }
            }
            if (!pick && list.length) { pick = list[0].colName; }
            if (!state.lineageCol || !lgHasField(state.lineageCol)) { state.lineageCol = pick; }
            renderLineage();
        }).fail(function (err) {
            $('#asLgStat').text('');
            UI.message({ type: 'error', message: (err && err.message) || '血缘加载失败' });
        });
    }

    function lgHasField(name) {
        var list = (state.lineage && state.lineage.fields) || [], i;
        for (i = 0; i < list.length; i++) {
            if (String(list[i].colName).toLowerCase() === String(name).toLowerCase()) { return true; }
        }
        return false;
    }

    function lgRows() {
        var sel = String(state.lineageCol || '').toLowerCase();
        var up = [], down = [], i, list;
        list = (state.lineage && state.lineage.up) || [];
        for (i = 0; i < list.length; i++) {
            if (!sel || String(list[i].targetCol).toLowerCase() === sel) { up.push(list[i]); }
        }
        list = (state.lineage && state.lineage.down) || [];
        for (i = 0; i < list.length; i++) {
            if (!sel || String(list[i].sourceCol).toLowerCase() === sel) { down.push(list[i]); }
        }
        return { up: up, down: down };
    }

    function lgFieldRow(f) {
        var on = String(f.colName).toLowerCase() === String(state.lineageCol || '').toLowerCase();
        var up = f.upCount || 0, down = f.downCount || 0;
        return '<div class="as-lg__field' + (on ? ' is-active' : '') + '" data-col="' + esc(f.colName) + '"' +
            ' title="' + esc((f.colComment || '') + (up || down
                ? '（上游 ' + up + ' 条直接来源 / 下游 ' + down + ' 处用到，含被当过滤、连接条件）'
                : '（没有血缘记录）')) + '">' +
            '<span class="as-lg__fname">' + esc(f.colName) + (f.isPk ? '<i class="as-lg__pk">PK</i>' : '') + '</span>' +
            '<span class="as-lg__cnt is-up' + (up ? '' : ' is-zero') + '">↑' + up + '</span>' +
            '<span class="as-lg__cnt is-down' + (down ? '' : ' is-zero') + '">↓' + down + '</span>' +
            '</div>';
    }

    /* 血缘类型徽标：口径对齐 OpenLineage 的 transformations
       （直接派生：原样 / 计算 / 聚合；间接影响：过滤 / 连接 / 分组 / 排序 / 窗口） */
    var LG_SUB_CLASS = {
        IDENTITY: 'is-ident', TRANSFORMATION: 'is-calc', AGGREGATION: 'is-agg',
        JOIN: 'is-join', FILTER: 'is-filter', GROUP_BY: 'is-group',
        SORT: 'is-sort', WINDOW: 'is-window', CONDITIONAL: 'is-cond'
    };

    function lgSubBadge(one) {
        var sub = one.subType || '';
        if (!sub) { return ''; }
        return '<span class="as-lg__sub ' + (LG_SUB_CLASS[sub] || '') + '" title="' +
            esc(one.linkTypeLabel || '') + '">' + esc(one.subTypeLabel || sub) + '</span>';
    }

    function lgCells(one, up) {
        var obj = up ? one.sourceObj : one.targetObj;
        var col = up ? one.sourceCol : (one.targetCol || '整表');
        var type = up ? one.sourceType : one.targetType;
        var manual = one.origin === 'manual';
        var head = '<b>' + esc(obj) + '</b>.' + esc(col) +
            '<span class="as-lg__type">' + esc(objShort(type)) + '</span>' +
            /* 注解里抽出来的边单独标一下：它不是 SQL 算的，是作者写在注释里的出处 */
            (manual
                ? '<span class="as-lg__origin is-manual" title="' + esc(one.originLabel || '人工标注') +
                  (one.manualBy ? '：' + one.manualBy : '') + '">人工</span>'
                : (one.origin && one.origin !== 'sql'
                    ? '<span class="as-lg__origin" title="' + esc(one.originLabel || '') +
                      '：这条不是 SQL 解析出来的，来源写在字段注释里">注解</span>'
                    : ''));
        return '<tr data-obj="' + esc(obj) + '" data-col="' + esc(up ? one.sourceCol : one.targetCol) + '">' +
            '<td>' + head +
            /* 人工写的标注：直接跟在字段后面，不用点开也能看见「为什么这么连」 */
            (one.note ? '<div class="as-lg__note" title="' + esc(one.note) + '">' + esc(one.note) + '</div>' : '') +
            '</td>' +
            '<td class="as-lg__expr" title="' + esc(one.transform) + '">' + lgSubBadge(one) +
            (one.transform ? esc(one.transform) : '—') +
            (one.masked ? '<span class="as-lg__mask" title="值经过脱敏 / 哈希：依赖还在，原值不再往下游传">脱敏</span>' : '') +
            '</td>' +
            '<td class="as-lg__via">' + esc(one.depthLabel) +
            (one.via ? '<span class="as-lg__path" title="' + esc(one.via) + '">' + esc(one.via) + '</span>' : '') + '</td>' +
            lgOpCells(one) +
            '</tr>';
    }

    /* 手工标注是受按钮权限管的一项能力（pageopbtn: asBtnLgManual）。
       行尾按钮和图上点线都是动态渲染的，btnperm 扫不到 —— 所以这里主动问一次，
       否则「没授权也能改血缘」就等于按钮权限形同虚设。 */
    function lgCanEdit() {
        var perm = window.AppBtnPerm;
        return !(perm && perm.isAllowed) || perm.isAllowed('asBtnLgManual');
    }

    /* 行尾操作：人工边可以改标注 / 删除；自动边只能「转手工」——
       直接改自动边没有意义（下次重新分析就被覆盖），所以只给这一个入口。 */
    function lgOpCells(one) {
        if (!one.id || !lgCanEdit()) { return '<td class="as-lg__opcell"></td>'; }
        if (one.origin === 'manual') {
            return '<td class="as-lg__opcell">' +
                '<button type="button" class="as-lg__op" data-op="edit" data-id="' + esc(one.id) + '" ' +
                'title="修改标注 / 血缘类型">✎</button>' +
                '<button type="button" class="as-lg__op is-del" data-op="del" data-id="' + esc(one.id) + '" ' +
                'title="删除这条人工标注">×</button></td>';
        }
        return '<td class="as-lg__opcell">' +
            '<button type="button" class="as-lg__op is-lock" data-op="lock" data-id="' + esc(one.id) + '" ' +
            'title="转人工标注：这条边从此由人维护，重新分析不会被覆盖">转手工</button></td>';
    }

    /* 整表依赖：不提供值，但决定「取哪些行 / 怎么分组 / 什么顺序」 */
    function lgRowDepCells(one) {
        return '<tr data-obj="' + esc(one.sourceObj) + '" data-col="' + esc(one.sourceCol) + '">' +
            '<td><b>' + esc(one.sourceObj) + '</b>.' + esc(one.sourceCol) +
            '<span class="as-lg__type">' + esc(objShort(one.sourceType)) + '</span>' +
            (one.origin === 'manual' ? '<span class="as-lg__origin is-manual">人工</span>' : '') +
            (one.note ? '<div class="as-lg__note" title="' + esc(one.note) + '">' + esc(one.note) + '</div>' : '') +
            '</td>' +
            '<td>' + lgSubBadge(one) + '</td>' +
            '<td class="as-lg__expr" title="' + esc(one.transform) + '">' +
            (one.transform ? esc(one.transform) : '—') + '</td>' +
            lgOpCells(one) +
            '</tr>';
    }

    /* ---- 关系图：上游 → 当前字段 → 下游 ----------------------------------
       表格能回答「有哪些边」，但看不出「链路的形状」——一个字段被 3 处引用、
       还是 3 个字段汇成 1 个，扫一眼图比读两遍表格快。
       布局固定三列，不引第三方图库：项目是 ES5 + jQuery，为一张一屏画得完的图
       引 d3 不划算，手写 SVG 反而可控（节点高、列宽都是常量）。
       节点/边都按「对象.字段」画，点节点跳到那个对象的该字段，一眼能顺着链走。 */
    var LG_NODE_W = 186, LG_NODE_H = 38, LG_GAP = 10, LG_MAX_SHOW = 7;
    var LG_HEAD_H = 22;

    /* SVG 没有 text-overflow：按显示宽度粗估截断（中文算 2 个字符宽） */
    function lgCut(text, width) {
        var s = String(text || ''), out = '', w = 0, i, c;
        for (i = 0; i < s.length; i++) {
            c = s.charCodeAt(i);
            w += (c > 255 ? 2 : 1);
            if (w > width) { return out + '…'; }
            out += s.charAt(i);
        }
        return out;
    }

    function lgNode(x, y, w, objName, colName, kind, tip) {
        var cls = 'as-lg__gnode' + (kind === 'self' ? ' is-self' : (kind === 'up' ? ' is-up' : ' is-down'));
        /* 字号 12px 时大约能放 (w-18)/6 个中文宽 —— 减掉左右 padding 再按字符宽截 */
        var chars = Math.max(8, Math.floor((w - 18) / 6) * 2);
        return '<g class="' + cls + '" data-obj="' + esc(objName) + '" data-col="' + esc(colName) + '">' +
            '<title>' + esc(tip || (objName + '.' + colName)) + '</title>' +
            '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + LG_NODE_H +
            '" rx="4"></rect>' +
            '<text class="as-lg__gobj" x="' + (x + 9) + '" y="' + (y + 15) + '">' +
            esc(lgCut(objName, chars)) + '</text>' +
            '<text class="as-lg__gcol" x="' + (x + 9) + '" y="' + (y + 30) + '">' +
            esc(lgCut(colName, chars)) + '</text></g>';
    }

    /* 一条边画三层：可见的线、压在线上面的透明粗命中区（线太细点不中）、标注文字
       · 人工边是橙色虚线：一眼能分出「机器算的」和「人标的」；
       · 命中区带 data-id，点它就打开这条边的标注弹窗 —— 图形化操作的主入口。 */
    function lgEdge(x1, y1, x2, y2, edge) {
        var mx = (x1 + x2) / 2;
        var d = 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2;
        var manual = !!edge && edge.origin === 'manual';
        var cls = 'as-lg__gedge' + (manual ? ' is-manual'
            : (edge && edge.origin && edge.origin !== 'sql' ? ' is-ann' : ''));
        var html = '<path class="' + cls + '" d="' + d + '"></path>';
        if (edge && edge.id) {
            html += '<path class="as-lg__ghit" d="' + d + '" data-id="' + esc(edge.id) + '">' +
                '<title>' + esc(edge.note ? '标注：' + edge.note : '点这条线可以加标注 / 改血缘类型') +
                '</title></path>';
        }
        if (manual && edge.note) {
            /* 标注写在弧线中点上方；字数按图形宽度截断，别糊成一团 */
            html += '<text class="as-lg__gnote" x="' + mx + '" y="' + ((y1 + y2) / 2 - 6) +
                '" text-anchor="middle">' + esc(lgCut(edge.note, 14)) + '</text>';
        }
        return html;
    }

    /* 一列的纵向坐标：整列垂直居中 */
    function lgColY(count, top, bodyH) {
        var total = count * LG_NODE_H + (count - 1) * LG_GAP, y0 = top + (bodyH - total) / 2;
        var out = [], i;
        for (i = 0; i < count; i++) { out.push(y0 + i * (LG_NODE_H + LG_GAP)); }
        return out;
    }

    /* 人工标注的边排最前：人标完却因为「超出 7 条没画」被藏起来，等于白标 */
    function lgManualFirst(list) {
        var manual = [], auto = [], one = list || [], i;
        for (i = 0; i < one.length; i++) {
            (one[i].origin === 'manual' ? manual : auto).push(one[i]);
        }
        return manual.concat(auto);
    }

    function renderLgGraph(up, down, colName) {
        var box = $('#asLgGraph'), obj = lgTarget();
        if (!box.length) { return; }
        if (!obj) { box.html(''); return; }
        var ups = lgManualFirst(up).slice(0, LG_MAX_SHOW);
        var downs = lgManualFirst(down).slice(0, LG_MAX_SHOW);
        var objName = obj.objName;

        if (!ups.length && !downs.length) {
            box.html('<div class="as-lg__empty">这个字段还没有血缘记录：' +
                '要么注解里没写出处，要么视图 / 过程里的写入解析不出字段级关系<br>' +
                (lgCanEdit()
                    ? '<button type="button" class="el-button el-button--small as-lg__add">手工标注一条来源</button>'
                    : '可以请管理员授权「手工标注」后人工补一条') + '</div>');
            return;
        }

        /* 宽度跟着容器走：右侧面板只有 500 出头，固定 760 会把「去向」那一列裁掉
           （真实页面就踩过：节点画出来了，但要横向滚动才看得见，等于没画） */
        var boxW = Math.max(480, Math.floor(box.width() || 760));
        var nodeW = Math.max(120, Math.min(LG_NODE_W, Math.floor((boxW - 8 - 80) / 3)));
        var colGap = Math.max(40, Math.min(100, (boxW - 8 - nodeW * 3) / 2));
        var colX = [4, 4 + nodeW + colGap, 4 + 2 * (nodeW + colGap)];
        var svgW = Math.floor(8 + nodeW * 3 + colGap * 2);

        var maxN = Math.max(ups.length, downs.length, 1);
        var bodyH = maxN * LG_NODE_H + (maxN - 1) * LG_GAP;
        var top = LG_HEAD_H + 6;
        /* 超出上限时底部还要放一行「还有 N 个」，否则会被裁掉 */
        var moreH = (up.length > LG_MAX_SHOW || down.length > LG_MAX_SHOW) ? 16 : 0;
        var H = bodyH + top + 12 + moreH;
        var selfY = top + (bodyH - LG_NODE_H) / 2;
        var upY = lgColY(ups.length, top, bodyH);
        var downY = lgColY(downs.length, top, bodyH);
        var svg = [], i, one;

        svg.push('<svg class="as-lg__gsvg" width="' + svgW + '" height="' + H +
            '" viewBox="0 0 ' + svgW + ' ' + H + '">');

        /* 列标题：有哪一列才画哪一列，空列不占标题 */
        if (ups.length) {
            svg.push('<text class="as-lg__ghead" x="' + colX[0] + '" y="14">来源（' +
                ups.length + (up.length > LG_MAX_SHOW ? ' / 共 ' + up.length : '') + '）</text>');
        }
        svg.push('<text class="as-lg__ghead" x="' + colX[1] + '" y="14">当前字段</text>');
        if (downs.length) {
            svg.push('<text class="as-lg__ghead" x="' + colX[2] + '" y="14">去向（' +
                downs.length + (down.length > LG_MAX_SHOW ? ' / 共 ' + down.length : '') + '）</text>');
        }

        /* 边先画，压在节点下面 */
        for (i = 0; i < ups.length; i++) {
            one = ups[i];
            svg.push(lgEdge(colX[0] + nodeW, upY[i] + LG_NODE_H / 2,
                colX[1], selfY + LG_NODE_H / 2, one));
        }
        for (i = 0; i < downs.length; i++) {
            one = downs[i];
            svg.push(lgEdge(colX[1] + nodeW, selfY + LG_NODE_H / 2,
                colX[2], downY[i] + LG_NODE_H / 2, one));
        }

        for (i = 0; i < ups.length; i++) {
            one = ups[i];
            svg.push(lgNode(colX[0], upY[i], nodeW, one.sourceObj, one.sourceCol, 'up',
                one.sourceObj + '.' + one.sourceCol + ' → ' + objName + '.' + colName +
                '（' + (one.subTypeLabel || '') + (one.originLabel ? ' · ' + one.originLabel : '') + '）'));
        }
        for (i = 0; i < downs.length; i++) {
            one = downs[i];
            svg.push(lgNode(colX[2], downY[i], nodeW, one.targetObj, one.targetCol || '（整表）', 'down',
                objName + '.' + colName + ' → ' + one.targetObj + '.' + (one.targetCol || '整表') +
                '（' + (one.subTypeLabel || '') + (one.originLabel ? ' · ' + one.originLabel : '') + '）'));
        }
        /* 当前节点最后画，保证盖在边上面 */
        svg.push(lgNode(colX[1], selfY, nodeW, objName, colName, 'self',
            objName + '.' + colName + '（当前字段）'));

        /* 超出上限的部分给一句提示，别让人以为只有这几个 */
        if (up.length > LG_MAX_SHOW) {
            svg.push('<text class="as-lg__gmore" x="' + colX[0] + '" y="' +
                (top + bodyH + 12) + '">还有 ' + (up.length - LG_MAX_SHOW) + ' 个来源未画出</text>');
        }
        if (down.length > LG_MAX_SHOW) {
            svg.push('<text class="as-lg__gmore" x="' + colX[2] + '" y="' +
                (top + bodyH + 12) + '">还有 ' + (down.length - LG_MAX_SHOW) + ' 处去向未画出</text>');
        }
        svg.push('</svg>');
        /* 图例：三种线型对应三种出身，不解释一下没人知道虚线是自己标的 */
        var hasManual = false, hasAnn = false;
        for (i = 0; i < ups.length + downs.length; i++) {
            one = i < ups.length ? ups[i] : downs[i - ups.length];
            if (one.origin === 'manual') { hasManual = true; }
            else if (one.origin && one.origin !== 'sql') { hasAnn = true; }
        }
        svg.push('<div class="as-lg__legend"><i class="is-sql"></i>SQL 解析' +
            (hasAnn ? '<i class="is-ann"></i>字段注解' : '') +
            (hasManual ? '<i class="is-manual"></i>人工标注<em>点线可改</em>' : '') +
            '</div>');
        box.html(svg.join(''));
    }

    /* 点血缘里的任意对象 → 跳到它（同一对象就切字段，不同对象就切树节点） */
    function lgJumpTo(objName, colName) {
        var hit = null, dbs = (state.tree && state.tree.databases) || [], i, j;
        if (!objName) { return; }
        if (state.obj && String(state.obj.objName).toLowerCase() === String(objName).toLowerCase()) {
            if (colName) { state.lineageCol = colName; renderLineage(); }
            return;
        }
        for (i = 0; i < dbs.length; i++) {
            for (j = 0; j < (dbs[i].objects || []).length; j++) {
                if (String(dbs[i].objects[j].objName).toLowerCase() === String(objName).toLowerCase()) {
                    hit = { obj: dbs[i].objects[j], db: dbs[i] };
                }
            }
        }
        if (!hit) {
            UI.message({ type: 'info', message: '对象【' + objName + '】不在这个应用的设计态里（可能未纳管）' });
            return;
        }
        state.lineageCol = colName || '';
        selectNode('obj', hit.obj.id, hit.obj.objName, hit.db.id, hit.obj.objType);
    }

    function renderLineage() {
        var obj = lgTarget();
        var d = state.lineage || null;
        var hasObj = !!obj;
        $('#asLgTitle').text(hasObj ? (obj.dbName ? obj.dbName + '.' : '') + obj.objName : '字段血缘');
        $('#asLgHint').text(hasObj
            ? objLabel(obj.objType) + (obj.objComment ? ' · ' + obj.objComment : '') + ' · 点左边字段看它的上游 / 下游'
            : '在左边点一张表 / 视图，这里看字段从哪来、又被谁用（过程与触发器本身没有输出列）');
        $('#asBtnLgBuild').prop('disabled', !state.appId);
        $('#asBtnLgManual').prop('disabled', !state.appId);

        if (!hasObj) {
            $('#asLgStat').text('');
            $('#asLgFieldCount').text('');
            $('#asLgFields').html('<div class="as-lg__empty">选中左侧的表 / 视图后显示字段清单</div>');
            $('#asLgUpBody').html('<tr><td colspan="4"><div class="as-lg__empty">—</div></td></tr>');
            $('#asLgDownBody').html('<tr><td colspan="4"><div class="as-lg__empty">—</div></td></tr>');
            $('#asLgRowBody').html('<tr><td colspan="4"><div class="as-lg__empty">—</div></td></tr>');
            $('#asLgUpHint').text('');
            $('#asLgDownHint').text('');
            $('#asLgNotes').html('');
            $('#asLgGraph').html('');
            return;
        }
        if (!d || !d.builtAt) {
            $('#asLgStat').text('');
            $('#asLgFieldCount').text('');
            $('#asLgGraph').html('<div class="as-lg__empty">还没有分析过：点右上角「重新分析」生成血缘后再看关系图' +
                (lgCanEdit()
                    ? '<br>也可以点「手工标注」，人工补一条依赖 ' +
                      '<button type="button" class="el-button el-button--small as-lg__add">手工标注</button>'
                    : '') + '</div>');
            $('#asLgFields').html('<div class="as-lg__empty">还没有分析过：点右上角「重新分析」<br>' +
                '会把视图 / 触发器 / 存储过程里的 SQL 解析成字段级血缘（只读设计态，不连真实库）</div>');
            $('#asLgUpBody').html('<tr><td colspan="4"><div class="as-lg__empty">—</div></td></tr>');
            $('#asLgDownBody').html('<tr><td colspan="4"><div class="as-lg__empty">—</div></td></tr>');
            $('#asLgRowBody').html('<tr><td colspan="4"><div class="as-lg__empty">—</div></td></tr>');
            $('#asLgUpHint').text('');
            $('#asLgDownHint').text('');
            $('#asLgNotes').html(lgNotesHtml((d && d.notes) || []));
            return;
        }
        var org = d.originCounts || {};
        var fromComment = (org.ref || 0) + (org.calc || 0);
        var stat = '上次分析 ' + String(d.builtAt || '').slice(0, 16) + ' · 血缘 ' + (d.edgeCount || 0) +
            ' 条（直接 ' + (d.directCount || 0) + ' / 整表 ' + (d.indirectCount || 0) + '）' +
            (fromComment ? ' · 其中 ' + fromComment + ' 条来自字段注解' : '') +
            (org.manual ? ' · <b class="is-manual">' + org.manual + ' 条人工标注</b>' : '') +
            ' · 参与对象 ' + (d.objectCount || 0) + ' 个';
        if (d.noteCount) { stat += ' · <b class="is-warn">' + d.noteCount + ' 处没解析出来</b>'; }
        if (!d.edgeCount && !d.noteCount) {
            stat += ' · <span class="as-lg__none">没有可解析的字段级血缘：视图 / 过程里的写入多为常量赋值，' +
                '或定义（DDL）还没保存</span>';
        }
        $('#asLgStat').html(stat);

        var fields = d.fields || [], html = '', i;
        if (!fields.length) {
            html = '<div class="as-lg__empty">这个对象还没有字段：先在「字段明细」里加字段，或扫描导入</div>';
        }
        for (i = 0; i < fields.length; i++) { html += lgFieldRow(fields[i]); }
        $('#asLgFields').html(html);
        $('#asLgFieldCount').text('(' + fields.length + ')');

        var rows = lgRows();
        $('#asLgUpBody').html(rows.up.length
            ? $.map(rows.up, function (one) { return lgCells(one, true); }).join('')
            : '<tr><td colspan="4"><div class="as-lg__empty">这个字段没有上游记录' +
              (obj.objType === 'view' ? '（视图定义里没解析出这一列）' : '（表字段的上游来自过程 / 触发器里的写入）') +
              '，可以点「手工标注」补一条</div></td></tr>');
        $('#asLgDownBody').html(rows.down.length
            ? $.map(rows.down, function (one) { return lgCells(one, false); }).join('')
            : '<tr><td colspan="4"><div class="as-lg__empty">没有对象用到这个字段</div></td></tr>');
        /* 整表依赖：过滤 / 连接 / 分组 / 排序用到的列 —— 不提供值，但改了结果集就变 */
        var rowDeps = d.rowDeps || [];
        $('#asLgRowBody').html(rowDeps.length
            ? $.map(rowDeps, function (one) { return lgRowDepCells(one); }).join('')
            : '<tr><td colspan="4"><div class="as-lg__empty">这个对象没有过滤 / 连接 / 分组条件' +
              (obj.objType === 'view' ? '（视图定义里没有 WHERE / JOIN / GROUP BY）'
                                      : '（它的条件写在过程 / 触发器里）') + '</div></td></tr>');
        $('#asLgUpHint').text(state.lineageCol || '');
        $('#asLgDownHint').text(rowDeps.length ? rowDeps.length + ' 项整表依赖' : '');
        $('#asLgNotes').html(lgNotesHtml(d.notes || []));
        renderLgGraph(rows.up, rows.down, state.lineageCol);
    }

    /* ---- 手工标注：人工补 / 改一条边 --------------------------------------
       为什么需要这条路：真实库里大量依赖压根不在 SQL 里 —— 过程里拼动态 SQL、跨系统同步、
       口径只写在人脑子里。自动分析到顶只能「在解析不出来的地方留个痕」，
       剩下那一步必须由人补，而且要补在图旁边（点线即改），不能只是干巴巴一张表单。
       人工边的口径：origin=manual —— 重新分析不覆盖（后端 _rebuild_lineage 会跳过）。 */
    var LG_DIRECT_SUBS = [['IDENTITY', '原样'], ['TRANSFORMATION', '计算'],
                          ['AGGREGATION', '聚合'], ['CONDITIONAL', '条件']];
    var LG_INDIRECT_SUBS = [['JOIN', '连接条件'], ['FILTER', '过滤条件'], ['GROUP_BY', '分组'],
                            ['SORT', '排序'], ['WINDOW', '窗口']];

    function lgSubOptions(link, cur) {
        var list = link === 'INDIRECT' ? LG_INDIRECT_SUBS : LG_DIRECT_SUBS, html = '', i;
        for (i = 0; i < list.length; i++) {
            html += '<option value="' + list[i][0] + '"' + (list[i][0] === cur ? ' selected' : '') +
                '>' + list[i][1] + '</option>';
        }
        return html;
    }

    /* 树里的表 / 视图（带库名）—— 手工连线只能在这两类对象之间建 */
    function lgTreeObjs() {
        var out = [], dbs = (state.tree && state.tree.databases) || [], i, j;
        for (i = 0; i < dbs.length; i++) {
            for (j = 0; j < (dbs[i].objects || []).length; j++) {
                var o = dbs[i].objects[j];
                if (o.objType !== 'table' && o.objType !== 'view') { continue; }
                out.push({ id: o.id, objName: o.objName, objType: o.objType, dbName: dbs[i].dbName || '' });
            }
        }
        return out;
    }

    function lgObjOptions(selId) {
        var list = lgTreeObjs(), html = '<option value="">（选表 / 视图）</option>', i;
        for (i = 0; i < list.length; i++) {
            html += '<option value="' + esc(list[i].id) + '"' + (list[i].id === selId ? ' selected' : '') +
                ' data-name="' + esc(list[i].objName) + '">' +
                esc((list[i].dbName ? list[i].dbName + '.' : '') + list[i].objName) +
                '（' + esc(objShort(list[i].objType)) + '）</option>';
        }
        return html;
    }

    function lgColOptions(cols, want, allowAll) {
        var html = '<option value="">' + (allowAll ? '（整表 · 指不到具体字段）' : '（选字段）') + '</option>', i;
        for (i = 0; i < (cols || []).length; i++) {
            html += '<option value="' + esc(cols[i].colName) + '"' +
                (String(cols[i].colName).toLowerCase() === String(want || '').toLowerCase() ? ' selected' : '') +
                '>' + esc(cols[i].colName) +
                (cols[i].colComment ? '（' + esc(lgCut(cols[i].colComment, 16)) + '）' : '') + '</option>';
        }
        return html;
    }

    /* 对象 → 字段联动；字段按对象缓存，来回切换不重复请求 */
    function lgFillCols($obj, $col, want, allowAll) {
        var objId = $obj.val(), cache = state.lgObjCols;
        if (!objId) { $col.html(lgColOptions([], '', allowAll)); return; }
        if (cache[objId]) { $col.html(lgColOptions(cache[objId], want, allowAll)); return; }
        $col.html('<option value="">（加载中…）</option>');
        Api.appSchema.cols(objId, state.appId).done(function (res) {
            cache[objId] = (res && res.list) || [];
            $col.html(lgColOptions(cache[objId], want, allowAll));
        }).fail(function () {
            $col.html('<option value="">（字段加载失败）</option>');
        });
    }

    function lgFindEdge(id) {
        var d = state.lineage || {}, keys = ['up', 'down', 'rowDeps'], i, j, list;
        for (i = 0; i < keys.length; i++) {
            list = d[keys[i]] || [];
            for (j = 0; j < list.length; j++) {
                if (list[j].id === id) { return list[j]; }
            }
        }
        return null;
    }

    function lgEdgeDialog(edge, preset) {
        if (!state.appId) { UI.message({ type: 'warning', message: '先选择一个应用' }); return; }
        if (!lgCanEdit()) {
            UI.message({ type: 'warning', message: '当前角色没有「手工标注」按钮权限，请联系管理员授权' });
            return;
        }
        var editing = !!(edge && edge.id);
        var cur = edge || preset || {};
        var link = String(cur.linkType || 'DIRECT').toUpperCase();
        var sub = String(cur.subType || '').toUpperCase()
            || (link === 'INDIRECT' ? 'FILTER' : 'TRANSFORMATION');
        var obj = lgTarget(), i, list = lgTreeObjs(), tObjId = '', sObjId = '';
        /* 默认目标 = 当前对象（人多数是在「给这个字段补一条来源」） */
        if (!editing && obj) {
            for (i = 0; i < list.length; i++) {
                if (list[i].objName === obj.objName) { tObjId = list[i].id; }
            }
        }
        var meta = editing
            ? '<div class="as-lg__dlg-meta">当前出身：<b>' + esc(cur.originLabel || '自动解析') + '</b>' +
              (cur.manualBy ? ' · 标注人 ' + esc(cur.manualBy) : '') +
              (cur.updateTime ? ' · 最近修改 ' + esc(cur.updateTime) : '') +
              (cur.editable ? '' : ' · 保存后转为人工维护') + '</div>'
            : '';
        var html = '<div class="as-form as-lg__dlg">' +
            '<div class="form-tip">' + (editing
                ? '端点不可改（换端点等于换一条边，删了重建更清楚）。保存后这条边由人维护，<b>重新分析不会覆盖</b>。'
                : '人工补一条血缘：<b>来源</b>字段的值是<b>目标</b>字段的出处。保存后由人维护，<b>重新分析不会覆盖</b>。') +
            '</div>' + meta +
            '<div class="as-lg__dlg-grid">' +
                '<label>来源字段</label><div class="as-lg__dlg-cells">' +
                    (editing
                        ? '<span class="as-lg__dlg-fixed">' + esc(cur.sourceObj) + '.' + esc(cur.sourceCol) + '</span>'
                        : '<select id="asLgSrcObj">' + lgObjOptions(sObjId) + '</select>' +
                          '<select id="asLgSrcCol">' + lgColOptions([], '') + '</select>') +
                '</div>' +
                '<label>目标字段</label><div class="as-lg__dlg-cells">' +
                    (editing
                        ? '<span class="as-lg__dlg-fixed">' + esc(cur.targetObj) + '.' +
                          esc(cur.targetCol || '（整表）') + '</span>'
                        : '<select id="asLgTgtObj">' + lgObjOptions(tObjId) + '</select>' +
                          '<select id="asLgTgtCol">' + lgColOptions([], '') + '</select>') +
                '</div>' +
                '<label>血缘类型</label><div class="as-lg__dlg-cells">' +
                    '<select id="asLgLink">' +
                        '<option value="DIRECT"' + (link === 'DIRECT' ? ' selected' : '') + '>直接派生 · 值怎么算出来</option>' +
                        '<option value="INDIRECT"' + (link === 'INDIRECT' ? ' selected' : '') + '>间接影响 · 过滤 / 连接 / 分组 / 排序</option>' +
                    '</select>' +
                    '<select id="asLgSub">' + lgSubOptions(link, sub) + '</select>' +
                '</div>' +
                '<label>标注说明</label><div class="as-lg__dlg-cells">' +
                    '<textarea id="asLgNote" maxlength="500" placeholder="为什么这么连？比如：订单金额 = 主表金额 + 运费汇总，过程里是动态 SQL 拼的，解析不出来">' +
                    esc(cur.note || '') + '</textarea>' +
                    '<div class="as-lg__dlg-hint" id="asLgNoteHint">写清口径 / 出处，别人看血缘时不用再去问人</div>' +
                '</div>' +
            '</div></div>';

        UI.dialog({
            title: editing ? '标注这条血缘' : '手工标注血缘',
            width: 640,
            content: html,
            onReady: function ($body) {
                var $linkEl = $body.find('#asLgLink'), $subEl = $body.find('#asLgSub');
                var $so = $body.find('#asLgSrcObj'), $sc = $body.find('#asLgSrcCol');
                var $to = $body.find('#asLgTgtObj'), $tc = $body.find('#asLgTgtCol');
                $linkEl.on('change', function () {
                    var v = String($linkEl.val());
                    $subEl.html(lgSubOptions(v, ''));
                    $body.find('#asLgNoteHint').text(v === 'INDIRECT'
                        ? '间接影响：这一列决定「取哪些行 / 怎么分组」，改它会改变结果集，但它不提供值'
                        : '直接派生：目标字段的值确实来自这个字段');
                    /* INDIRECT 允许指到整表（不选字段），DIRECT 必须落到具体字段 */
                    if ($tc && $tc.length) {
                        lgFillCols($to, $tc, String($tc.val() || ''), v === 'INDIRECT');
                    }
                });
                if (editing) { return; }
                $so.on('change', function () { lgFillCols($so, $sc, ''); });
                $to.on('change', function () { lgFillCols($to, $tc, '', $linkEl.val() === 'INDIRECT'); });
                if ($to.val()) { lgFillCols($to, $tc, cur.targetCol || state.lineageCol, link === 'INDIRECT'); }
                if ($so.val()) { lgFillCols($so, $sc, cur.sourceCol || ''); }
            },
            onOk: function ($body, close) {
                var payload = { appId: state.appId, note: trim($body.find('#asLgNote').val()),
                                linkType: String($body.find('#asLgLink').val()),
                                subType: String($body.find('#asLgSub').val()) };
                if (editing) {
                    payload.id = cur.id;
                    payload.targetObj = cur.targetObj;
                    payload.targetCol = cur.targetCol;
                    payload.sourceObj = cur.sourceObj;
                    payload.sourceCol = cur.sourceCol;
                } else {
                    var $so2 = $body.find('#asLgSrcObj'), $to2 = $body.find('#asLgTgtObj');
                    payload.sourceObj = String($so2.find('option:selected').attr('data-name') || '');
                    payload.sourceCol = String($body.find('#asLgSrcCol').val() || '');
                    payload.targetObj = String($to2.find('option:selected').attr('data-name') || '');
                    payload.targetCol = String($body.find('#asLgTgtCol').val() || '');
                    if (!payload.sourceObj) { UI.message({ type: 'warning', message: '先选来源字段所在的表 / 视图' }); return; }
                    if (!payload.sourceCol) { UI.message({ type: 'warning', message: '来源字段不能为空' }); return; }
                    if (!payload.targetObj) { UI.message({ type: 'warning', message: '先选目标字段所在的表 / 视图' }); return; }
                    if (payload.linkType === 'DIRECT' && !payload.targetCol) {
                        UI.message({ type: 'warning', message: '直接派生必须指定目标字段（间接影响才能指到整表）' });
                        return;
                    }
                }
                var $btn = $body.closest('.el-dialog').find('.btn-ok');
                $btn.prop('disabled', true).text('保存中…');
                Api.appSchema.lineageedgesave(payload).done(function (res) {
                    close();
                    UI.message({ type: 'success',
                                 message: '已保存人工标注' + ((res && res.edge && res.edge.note) ? '：' + res.edge.note : '') });
                    loadLineage();
                }).fail(function (err) {
                    $btn.prop('disabled', false).text('确定');
                    UI.message({ type: 'error', message: (err && err.message) || '保存失败' });
                });
            }
        });
    }

    function lgDelEdge(id) {
        var one = lgFindEdge(id);
        if (!one) { return; }
        UI.confirm({
            title: '删除人工标注',
            message: '删除「' + one.sourceObj + '.' + one.sourceCol + ' → ' +
                one.targetObj + '.' + (one.targetCol || '整表') + '」这条人工标注？' +
                '只影响这一条，自动解析出来的边不受影响。',
            confirmText: '删除'
        }).done(function (yes) {
            if (!yes) { return; }
            Api.appSchema.lineageedgedel(state.appId, id).done(function () {
                UI.message({ type: 'success', message: '已删除' });
                loadLineage();
            }).fail(function (err) {
                UI.message({ type: 'error', message: (err && err.message) || '删除失败' });
            });
        });
    }

    function lgNotesHtml(notes) {
        if (!notes || !notes.length) { return ''; }
        var html = '<div class="as-lg__notebox"><div class="as-lg__notebox-t">这些地方没能解析出来（不会算进血缘，' +
            '需要人工确认）</div><ul>';
        for (var i = 0; i < notes.length && i < 30; i++) {
            html += '<li><b>' + esc(notes[i].objName || '—') + '</b> ' + esc(notes[i].reason || '') + '</li>';
        }
        if (notes.length > 30) { html += '<li>… 还有 ' + (notes.length - 30) + ' 条</li>'; }
        return html + '</ul></div>';
    }

    function buildLineage() {
        if (!state.appId) { UI.message({ type: 'warning', message: '先选择一个应用' }); return; }
        var $btn = $('#asBtnLgBuild');
        $btn.prop('disabled', true).text('分析中…');
        var timedOut = false;
        Api.appSchema.lineagebuild(state.appId).done(function (res) {
            var d = res || {};
            UI.message({ type: d.noteCount ? 'warning' : 'success',
                         message: '分析完成：血缘 ' + (d.edgeCount || 0) + ' 条（直接 ' +
                             (d.directCount || 0) + ' / 整表 ' + (d.indirectCount || 0) + '），参与对象 ' +
                             (d.objectCount || 0) + ' 个' +
                             (d.noteCount ? '，' + d.noteCount + ' 处没能解析（见下方提示）' : '') });
            loadLineage();
        }).fail(function (err) {
            var msg = (err && err.message) || '分析失败';
            /* 超时 = 后端还在算（这类请求前端先掐、后端仍在写库）：别让人立刻再点一次（等于重跑），
               按钮先按住，隔 20 秒自动把结果读回来，读到就说明跑完了 */
            timedOut = msg.indexOf('请求超时') === 0;
            if (timedOut) {
                $('#asLgStat').text('后端仍在分析，稍后自动刷新结果…');
                window.setTimeout(function () {
                    loadLineage();
                    $btn.prop('disabled', false).text('重新分析');
                }, 20000);
                UI.message({ type: 'warning',
                             message: '分析还没返回（后端仍在跑），已安排 20 秒后自动刷新结果，别重复点' });
                return;
            }
            UI.alert({ type: 'error', title: '分析失败', message: msg });
        }).always(function () {
            if (!timedOut) { $btn.prop('disabled', false).text('重新分析'); }
        });
    }

    $('#asBtnLgBuild').on('click', buildLineage);
    $('#asBtnLgManual').on('click', function () { lgEdgeDialog(null); });
    $('#asLgFields').on('click', '.as-lg__field', function () {
        state.lineageCol = $(this).attr('data-col') || '';
        renderLineage();
    });
    $('#asLgUpBody, #asLgDownBody, #asLgRowBody').on('click', 'tr[data-obj]', function (e) {
        /* 点行尾的「标注 / 转手工 / 删除」不跳转（否则刚想标注就跳去别的表了） */
        if ($(e.target).closest('.as-lg__op').length) { return; }
        /* 点来源 / 目标字段 → 跳到那个对象，便于顺藤摸瓜 */
        lgJumpTo($(this).attr('data-obj') || '', $(this).attr('data-col') || '');
    });
    /* 行尾操作：人工边改标注 / 删；自动边「转手工」（改自动边没有意义，下次重算就覆盖） */
    $('#asLgUpBody, #asLgDownBody, #asLgRowBody').on('click', '.as-lg__op', function (e) {
        e.preventDefault();
        var id = $(this).attr('data-id') || '';
        if ($(this).attr('data-op') === 'del') { lgDelEdge(id); return; }
        var one = lgFindEdge(id);
        if (!one) { UI.message({ type: 'warning', message: '这条记录已不在了，刷新一下再看' }); return; }
        lgEdgeDialog(one);
    });
    /* 关系图里的节点同口径：点一下顺着链走过去 */
    $('#asLgGraph').on('click', '.as-lg__gnode', function () {
        lgJumpTo($(this).attr('data-obj') || '', $(this).attr('data-col') || '');
    });
    /* 点连线 = 标注这条边（图形化操作的主入口：不用回到表格里找那一行） */
    $('#asLgGraph').on('click', '.as-lg__ghit', function (e) {
        e.stopPropagation();
        var one = lgFindEdge($(this).attr('data-id') || '');
        if (!one) { UI.message({ type: 'warning', message: '这条记录已不在了，刷新一下再看' }); return; }
        lgEdgeDialog(one);
    });
    /* 图上空状态里的快捷入口 */
    $('#asLgGraph').on('click', '.as-lg__add', function () { lgEdgeDialog(null); });

    /* ================= 首屏 ================= */
    loadMeta();
    loadApps().done(function () {
        loadTree();
        loadVersions();
        syncNodeToolbar();
        renderCols();
        renderVerDetail(null);
        renderCmpCards(null);
        renderCmpItems([]);
        renderLineage();
    });
});
