/* ==========================================================================
   appschema-test.js —— 数据中心 · 应用信息 / 应用结构（appinfo.html + appschema.html）
   --------------------------------------------------------------------------
   两张新页面走同一套离线 Mock（js/api.js 的 appInfo / appSchema），所以这里
   在 jsdom 里直接把 api.js 的 Mock 跑起来验证整条链路：
     ① 静态：页面骨架 / 资源版本号 / 按钮 id / api.js 注册（缺一个按钮，
        btnperm.js 就会把工具栏变成空白，所以按钮 id 单独列出来数）；
     ② 应用信息页：种子 2 条渲染、计数、选中行、工具栏启停、新增表单自动取号；
     ③ 应用结构页：应用下拉、结构树（库 → 表）、点表加载字段、标签页切换、
        版本历史出草稿、保存字段后版本 +1、脚本页 / 对比页的空状态。
   jsdom 没有布局（高度恒 0），所以只验数据与 DOM，不验像素。
   运行：NODE_PATH=C:/Users/chx/.workbuddy/binaries/node/workspace/node_modules node tools/appschema-test.js
   ========================================================================== */
'use strict';
process.on('unhandledRejection', function () { /* 页面里的异步桩不影响结论 */ });
var fs = require('fs');
var path = require('path');
var JSDOM = (function () { try { return require('jsdom').JSDOM; } catch (e) { return null; } })();

var ROOT = path.resolve(__dirname, '..');
var pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(cond, ms) {
    var end = Date.now() + (ms || 3000);
    while (Date.now() < end) {
        if (cond()) { return true; }
        await wait(20);
    }
    return false;
}

if (!JSDOM) { console.log('未安装 jsdom，跳过'); process.exit(0); }

var API_V = '20261119d';      /* api.js：血缘加 INDIRECT / 子类型（离线 Mock 同步） */
var PAGE_V = '20261119f';     /* appschema.js：关系图 + 注解来源徽标 */
var CSS_V = '20261119f';      /* appschema.css：关系图配色 + 注解徽标 */
var INFO_V = '20261117e';     /* appinfo.js：检索区多选 / 结果区撑满页高 / 空行补位 / 列序调整 */
var INFO_CSS_V = '20261117c'; /* appinfo.css：本轮新增（检索区间距 + 多选 + flex 链 + 面板不被遮挡） */

/* ---------------------------------------------------------------- ① 静态 */
console.log('\n① 静态检查（骨架 / 版本号 / 按钮 id / api 注册）');
var apiSrc = read('js/api.js');
check('api.js 注册 /appinfo 前缀', apiSrc.indexOf("{ prefix: '/appinfo', svc: appInfoSvc }") > -1);
check('api.js 注册 /appschema 前缀', apiSrc.indexOf("{ prefix: '/appschema', svc: appSchemaSvc }") > -1);
check('api.js 导出 appInfo / appSchema',
    /appInfo: appInfo,/.test(apiSrc) && /appSchema: appSchema,/.test(apiSrc));
var infoApis = ['nextcode', 'meta', 'page', 'detail', 'check', 'options', 'connections',
    'add', 'update', 'remove', 'setEnabled'];
var missInfoApis = infoApis.filter(function (k) {
    return apiSrc.indexOf("'/appinfo/" ) < 0 || apiSrc.indexOf('/appinfo/') < 0 || !new RegExp(k + ': function').test(apiSrc);
});
check('api.js 有 appInfo 接口对象（' + infoApis.length + ' 个方法）',
    ['/appinfo/nextcode', '/appinfo/meta', '/appinfo/list', '/appinfo/detail', '/appinfo/check',
        '/appinfo/options', '/appinfo/connections', '/appinfo/add', '/appinfo/update',
        '/appinfo/delete', '/appinfo/enabled'].every(function (u) {
        return apiSrc.indexOf(u) > -1;
    }), missInfoApis.join(','));
check('api.js 有 appSchema 接口对象（库/对象/字段/版本/脚本/对比）',
    ['/appschema/tree', '/appschema/dbadd', '/appschema/dbupdate', '/appschema/dbdel',
        '/appschema/objadd', '/appschema/objupdate', '/appschema/objdel', '/appschema/cols',
        '/appschema/colsave', '/appschema/coldel', '/appschema/scan', '/appschema/scaninfo',
        '/appschema/parsesql',
        '/appschema/importddl', '/appschema/versions', '/appschema/version', '/appschema/publish',
        '/appschema/discard', '/appschema/scriptstatus', '/appschema/compare',
        '/appschema/compares', '/appschema/compareitems',
        '/appschema/compareupgrade', '/appschema/compareexport'].every(function (u) {
        return apiSrc.indexOf(u) > -1;
    }));
check('Mock 里一个连接只能挂一个应用（占位校验）',
    apiSrc.indexOf('一个连接只能挂一个应用') > -1);

var infoHtml = read('appinfo.html');
var schemaHtml = read('appschema.html');
check('appinfo.html 引用 api.js?v=' + API_V, infoHtml.indexOf('js/api.js?v=' + API_V) > -1);
check('appinfo.html 引用 js/appinfo.js?v=' + INFO_V, infoHtml.indexOf('js/appinfo.js?v=' + INFO_V) > -1);
check('两页引用同一版 css/appschema.css?v=' + CSS_V,
    infoHtml.indexOf('css/appschema.css?v=' + CSS_V) > -1 &&
    schemaHtml.indexOf('css/appschema.css?v=' + CSS_V) > -1);
check('appschema.html 引用 api.js?v=' + API_V, schemaHtml.indexOf('js/api.js?v=' + API_V) > -1);
check('appschema.html 引用 js/appschema.js?v=' + PAGE_V, schemaHtml.indexOf('js/appschema.js?v=' + PAGE_V) > -1);

var infoBtns = ['appBtnAdd', 'appBtnEdit', 'appBtnSchema', 'appBtnEnable', 'appBtnDisable',
    'appBtnDelete', 'appBtnRefresh', 'appBtnSearch', 'appBtnReset'];
var missInfo = infoBtns.filter(function (id) { return infoHtml.indexOf('id="' + id + '"') < 0; });
check('应用信息页 ' + infoBtns.length + ' 个按钮 id 齐全', missInfo.length === 0, missInfo.join(','));

var schemaBtns = ['asBtnScan', 'asBtnImport', 'asBtnCompare', 'asBtnRefresh', 'asBtnDbAdd',
    'asBtnObjAdd', 'asBtnNodeEdit', 'asBtnNodeDel', 'asBtnExpand', 'asBtnColAdd', 'asBtnColPaste',
    'asBtnColSave', 'asBtnVerReload', 'asBtnPublish', 'asBtnDiscard', 'asBtnScriptCopy',
    'asBtnScriptDown', 'asBtnScriptOk', 'asBtnScriptFail', 'asBtnScriptSkip', 'asBtnCmpRun',
    'asBtnCmpDiff', 'asBtnCmpSql', 'asBtnCmpExport', 'asBtnLgBuild'];
var missSchema = schemaBtns.filter(function (id) { return schemaHtml.indexOf('id="' + id + '"') < 0; });
check('应用结构页 ' + schemaBtns.length + ' 个按钮 id 齐全', missSchema.length === 0, missSchema.join(','));
check('应用结构页 5 个标签页（字段 / 版本 / 脚本 / 对比 / 血缘）',
    ['cols', 'versions', 'scripts', 'compare', 'lineage'].every(function (t) {
        return schemaHtml.indexOf('data-tab="' + t + '"') > -1 &&
            schemaHtml.indexOf('data-pane="' + t + '"') > -1;
    }));
check('页面用 as-page 走整页不滚动的高度链', schemaHtml.indexOf('class="app-main as-page"') > -1);
check('扫描 / 导入 DDL / 对比 / 刷新 四个按钮移到了操作引导区',
    schemaHtml.indexOf('class="toolbar db-toolbar as-guide" id="asGuide"') > -1 &&
    ['asBtnScan', 'asBtnImport', 'asBtnCompare', 'asBtnRefresh'].every(function (id) {
        var start = schemaHtml.indexOf('id="' + id + '"');
        var guide = schemaHtml.indexOf('id="asGuide"');
        return start > guide && start - guide < 2200;
    }));
check('四个按钮是纯图标（没有可见文字，文案在 title / aria-label）', (function () {
    var ids = ['asBtnScan', 'asBtnImport', 'asBtnCompare', 'asBtnRefresh'], allGood = true;
    ids.forEach(function (id) {
        var at = schemaHtml.indexOf('id="' + id + '"');
        var tag = schemaHtml.slice(schemaHtml.lastIndexOf('<button', at), schemaHtml.indexOf('</button>', at));
        if (tag.indexOf('aria-label=') < 0 || tag.indexOf('title=') < 0) { allGood = false; }
        var text = tag.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '');
        if (text) { allGood = false; }
    });
    return allGood;
})());
check('对比表头有「差异说明」与「升级语句」两列',
    schemaHtml.indexOf('差异说明') > -1 && schemaHtml.indexOf('升级语句') > -1);
check('对比栏有「实库连接」与「对应设计态库」两个下拉（选连接 → 选库）',
    schemaHtml.indexOf('id="asCmpConn"') > -1 && schemaHtml.indexOf('id="asCmpDesignDb"') > -1 &&
    schemaHtml.indexOf('id="asCmpDesignWrap"') > -1 &&
    schemaHtml.indexOf('id="asCmpDesignWrap" hidden') > -1);
check('api.js 有对比连接清单接口（/appschema/compareconns）',
    apiSrc.indexOf('/appschema/compareconns') > -1 && /compareconns: function/.test(apiSrc));
check('api.js 的 scaninfo 支持换连接、compare 支持 connId / designDb',
    /scaninfo: function \(appId, connId\)/.test(apiSrc) &&
    /connId: o\.connId \|\| ''/.test(apiSrc) && /designDb: o\.designDb \|\| ''/.test(apiSrc));
check('api.js 有字段血缘接口（/appschema/lineage + lineagebuild）',
    apiSrc.indexOf('/appschema/lineage') > -1 && /lineage: function \(appId, objName, colName\)/.test(apiSrc) &&
    /lineagebuild: function \(appId\)/.test(apiSrc));
check('血缘页有字段清单 / 上游 / 下游三块',
    ['asLgFields', 'asLgUpBody', 'asLgDownBody', 'asLgStat'].every(function (id) {
        return schemaHtml.indexOf('id="' + id + '"') > -1;
    }));
var slowBlock = (apiSrc.match(/var SLOW_API = \[([\s\S]*?)\];/) || [])[1] || '';
var scanBlock = (apiSrc.match(/var SCAN_API = \[([\s\S]*?)\];/) || [])[1] || '';
check('血缘查询进慢接口档（10 分钟）、重建进扫描档（30 分钟），不再走 15 秒普通超时',
    slowBlock.indexOf("'/appschema/lineage'") > -1 &&
    scanBlock.indexOf("'/appschema/lineagebuild'") > -1,
    'slow=' + slowBlock.indexOf("'/appschema/lineage'") + ' scan=' + scanBlock.indexOf("'/appschema/lineagebuild'"));
check('血缘重建超时不让人重复点：按住按钮 + 自动回读结果',
    read('js/appschema.js').indexOf('请求超时') > -1 &&
    read('js/appschema.js').indexOf('后端仍在分析') > -1);

var cssSrc = read('css/appschema.css');
check('appschema.css 定义 .as-page 高度链', cssSrc.indexOf('.as-page {') > -1);
check('appschema.css 有差异标红（仅设计态有）', cssSrc.indexOf('.as-diff.is-designOnly') > -1);
check('appschema.css 有操作引导区 / 明细行 / 脚本弹窗的样式',
    cssSrc.indexOf('.as-guide') > -1 && cssSrc.indexOf('.as-cmp__detail') > -1 &&
    cssSrc.indexOf('.as-up__text') > -1 && cssSrc.indexOf('.as-ex__row') > -1);
check('appschema.css 有字段血缘样式（字段清单 / 未解析提示）',
    cssSrc.indexOf('.as-lg__field') > -1 && cssSrc.indexOf('.as-lg__notebox') > -1);
check('血缘页有「整表依赖」区块（过滤 / 连接 / 分组影响整行，不摊到字段）',
    schemaHtml.indexOf('id="asLgRowBody"') > -1 && schemaHtml.indexOf('整表依赖') > -1);
check('血缘边区分直接派生 / 间接影响，并带子类型徽标',
    read('js/appschema.js').indexOf('LG_SUB_CLASS') > -1 &&
    read('js/appschema.js').indexOf('lgSubBadge') > -1 &&
    cssSrc.indexOf('.as-lg__sub.is-filter') > -1 && cssSrc.indexOf('.as-lg__sub.is-agg') > -1 &&
    apiSrc.indexOf("linkType: 'INDIRECT'") > -1);
check('离线 Mock 也按同一口径算整表依赖（WHERE / JOIN ON / GROUP BY）',
    apiSrc.indexOf("'JOIN', '连接条件'") > -1 && apiSrc.indexOf("'FILTER', '过滤条件'") > -1 &&
    apiSrc.indexOf("'GROUP_BY', '分组'") > -1);
check('页面级样式没有污染 app.css', read('css/app.css').indexOf('.as-page') < 0);
check('appschema.js 走 ES5（没有 let / const / 箭头函数）',
    !/^\s*(let|const)\s/m.test(read('js/appschema.js')) &&
    read('js/appschema.js').indexOf('=>') < 0);

/* ------------------------------------------------ 应用信息页 · 检索区与结果区 */
console.log('\n① b 应用信息页（检索区多选 / 结果区撑满页高）');
var infoCss = read('css/appinfo.css');
check('appinfo.html 引用 css/appinfo.css?v=' + INFO_CSS_V,
    infoHtml.indexOf('css/appinfo.css?v=' + INFO_CSS_V) > -1);
check('检索区 4 个筛选项 + 按钮组同行（search-item--app-* ×4 / search-btns）',
    ['search-item--app-kw', 'search-item--app-type', 'search-item--app-db', 'search-item--app-status']
        .every(function (c) { return infoHtml.indexOf(c) > -1; }) &&
    infoHtml.indexOf('class="el-form-item search-btns"') > -1);
check('应用类型 / 数据库类型是多选组件（ai-multi ×2）',
    (infoHtml.match(/class="ai-multi"/g) || []).length === 2 &&
    infoHtml.indexOf('id="appTypeMulti"') > -1 && infoHtml.indexOf('id="appDbTypeMulti"') > -1);
check('多选占位文案是「全部」（不再是「全部类型 / 全部方言」）',
    infoHtml.indexOf('全部方言') < 0 && infoHtml.indexOf('全部类型') < 0 &&
    infoHtml.indexOf('data-placeholder="全部"') > -1);
check('两个多选面板都有「清空」按钮',
    (infoHtml.match(/class="ai-multi__clear"/g) || []).length === 2,
    (infoHtml.match(/class="ai-multi__clear"/g) || []).length);
check('appinfo.css 标签留出呼吸位（width 72 / padding-right 16）',
    /#appSearchForm \.el-form-item__label\s*\{[^}]*width:\s*72px/.test(infoCss) &&
    /padding:\s*0 16px 0 0/.test(infoCss));
check('appinfo.css 补全表格卡片的 flex 链（body 纵向 + wrapper height:0）',
    infoCss.indexOf('.table-card > .el-card__body') > -1 &&
    /\.table-card \.table-wrapper \{\s*height:\s*0/.test(infoCss));
check('页面级样式没有污染 app.css',
    read('css/app.css').indexOf('#appSearchForm') < 0 && read('css/app.css').indexOf('.ai-multi') < 0);
check('空行按列渲染（blankRow × COLS），不是一条 colspan',
    read('js/appinfo.js').indexOf('function blankRow(height)') > -1 &&
    read('js/appinfo.js').indexOf('for (var i = 0; i < COLS; i++)') > -1 &&
    read('js/appinfo.js').indexOf("tr.blank-row\"><td colspan") < 0);
check('表头前两列是「序号 / 选择」（选择列在序号之后）',
    /<th class="is-center" style="width:56px">序号<\/th>\s*<th class="is-center" style="width:52px">选择<\/th>/
        .test(infoHtml));
check('下拉面板不被检索卡裁剪、也不被结果卡盖住（检索卡 overflow:visible + z-index）',
    /\.search-card\s*\{[^}]*position:\s*relative;\s*z-index:\s*5/.test(infoCss) &&
    /\.search-card\s*\{[^}]*overflow:\s*visible/.test(infoCss));
check('appinfo.js 走 ES5',
    !/^\s*(let|const)\s/m.test(read('js/appinfo.js')) && read('js/appinfo.js').indexOf('=>') < 0);

/* ---------------------------------------------------- 应用信息页（Mock） */
function bootInfo() {
    var dom = new JSDOM(infoHtml, {
        url: 'http://127.0.0.1:8808/appinfo.html',
        runScripts: 'outside-only', pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'mock-token', user: { empId: 1, nameCn: '系统管理员' }
    }));
    win.eval(read('js/api.js'));
    win.Api.config.useMock = true;
    win.Api.emp.page = function () {
        var d = win.$.Deferred();
        d.resolve({ list: [{ id: 1, name: '系统管理员' }, { id: 2, name: '张三' }], total: 2 });
        return d.promise();
    };
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/btnperm.js'));
    win.eval(read('js/appinfo.js'));
    return win;
}

(async function () {
    console.log('\n② 应用信息页（离线 Mock）');
    var win = bootInfo();
    var doc = win.document;

    /* 超时分档：扫描 / 对比最久（scanTimeout），其它慢接口 slowTimeout，普通接口 15 秒 */
    check('扫描 / 比对（scan / compare / importddl / publish）用 config.scanTimeout',
        win.Api.timeoutFor('/appschema/scan') === win.Api.config.scanTimeout &&
        win.Api.timeoutFor('/appschema/compare') === win.Api.config.scanTimeout &&
        win.Api.timeoutFor('/appschema/compareupgrade') === win.Api.config.scanTimeout &&
        win.Api.timeoutFor('/appschema/importddl') === win.Api.config.scanTimeout &&
        win.Api.timeoutFor('/appschema/publish') === win.Api.config.scanTimeout,
        String(win.Api.config.scanTimeout));
    check('其它慢接口（删除库 / 删除表 / 扫表 / 导出）用 config.slowTimeout',
        win.Api.timeoutFor('/appschema/dbdel') === win.Api.config.slowTimeout &&
        win.Api.timeoutFor('/appschema/objdel') === win.Api.config.slowTimeout &&
        win.Api.timeoutFor('/dbinfo/tables') === win.Api.config.slowTimeout &&
        win.Api.timeoutFor('/appschema/exportdocs') === win.Api.config.slowTimeout,
        String(win.Api.config.slowTimeout));
    check('扫描比对超时不短于 20 分钟、慢接口不短于 10 分钟、普通接口仍是 15 秒',
        win.Api.config.scanTimeout >= 1200000 &&
        win.Api.config.slowTimeout >= 600000 &&
        win.Api.config.scanTimeout > win.Api.config.slowTimeout &&
        win.Api.timeoutFor('/menu/list') === 15000,
        [win.Api.config.scanTimeout, win.Api.config.slowTimeout,
            win.Api.timeoutFor('/menu/list')].join(' / '));
    check('轻接口没被误判成扫描 / 慢接口（tree / cols / 新增库 仍走短超时）',
        win.Api.timeoutFor('/appschema/tree') === 15000 &&
        win.Api.timeoutFor('/appschema/cols') === 15000 &&
        win.Api.timeoutFor('/appschema/dbadd') === 15000 &&
        win.Api.isScanApi('/appschema/tree') === false,
        [win.Api.timeoutFor('/appschema/tree'), win.Api.timeoutFor('/appschema/cols'),
            win.Api.timeoutFor('/appschema/dbadd')].join('|'));
    check('超时文案用「分钟」而不是「秒」（30 秒 / 10 分钟）',
        win.Api.waitText(30000) === '30 秒' && win.Api.waitText(600000) === '10 分钟',
        win.Api.waitText(30000) + ' / ' + win.Api.waitText(600000));
    var okList = await until(function () {
        return doc.querySelectorAll('#appTbody tr[data-id]').length > 0;
    });
    check('首屏渲染出种子应用', okList, doc.getElementById('appTbody').textContent.slice(0, 120));
    var rows = doc.querySelectorAll('#appTbody tr[data-id]');
    check('种子 2 条应用', rows.length === 2, rows.length);
    check('计数文案', doc.getElementById('appCount').textContent === '2',
        doc.getElementById('appCount').textContent);
    check('列数 12（与表头一致）', rows[0].querySelectorAll('td').length === 12,
        rows[0].querySelectorAll('td').length);
    check('未绑定连接显示「未绑定」', doc.getElementById('appTbody').textContent.indexOf('未绑定') > -1);
    check('应用类型 / 方言已翻译（Web 应用 / MySQL）',
        doc.getElementById('appTbody').textContent.indexOf('Web 应用') > -1 &&
        doc.getElementById('appTbody').textContent.indexOf('MySQL') > -1);

    check('未选中时编辑 / 删除按钮禁用',
        doc.getElementById('appBtnEdit').disabled === true &&
        doc.getElementById('appBtnDelete').disabled === true);
    var $ = win.jQuery;
    $(rows[0]).find('.app-name-cell').trigger('click');
    check('点行可选中', rows[0].className.indexOf('is-selected') > -1, rows[0].className);
    check('选中后编辑按钮可用', doc.getElementById('appBtnEdit').disabled === false);

    $('#appBtnAdd').trigger('click');
    var dlgOk = await until(function () { return !!doc.querySelector('.el-dialog'); });
    check('点「新增」弹出表单', dlgOk);
    await until(function () {
        var el = doc.getElementById('afCode');
        return el && el.value;
    }, 2000);
    var codeVal = doc.getElementById('afCode') ? doc.getElementById('afCode').value : '';
    check('新增自动取号 APP0003（种子占 0001/0002）', codeVal === 'APP0003', codeVal);
    var optCount = doc.querySelectorAll('#afType option').length;
    check('应用类型下拉有 5 项', optCount === 5, optCount);
    var dbTypeCount = doc.querySelectorAll('#afDbType option').length;
    check('数据库类型下拉有 6 项', dbTypeCount === 6, dbTypeCount);
    check('连接下拉默认「不绑定（纯手工维护）」',
        doc.getElementById('afConn').options[0].text.indexOf('不绑定') > -1,
        doc.getElementById('afConn').options[0].text);

    /* 保存一条新应用，校验列表刷新 */
    doc.getElementById('afName').value = '冒烟应用X';
    $(doc).find('.el-dialog .btn-ok').trigger('click');
    var added = await until(function () {
        return doc.getElementById('appTbody').textContent.indexOf('冒烟应用X') > -1;
    }, 4000);
    check('新增后列表出现新应用', added);
    check('新增后计数变 3', doc.getElementById('appCount').textContent === '3',
        doc.getElementById('appCount').textContent);

    /* ---------------- 检索区：多选 / 清空 / 重置 ---------------- */
    console.log('\n② b 检索区多选与清空（离线 Mock）');
    var $tm = $('#appTypeMulti'), $dm = $('#appDbTypeMulti');
    check('应用类型多选默认文案「全部」', $tm.find('.ai-multi__text').text() === '全部',
        $tm.find('.ai-multi__text').text());
    $tm.find('.ai-multi__box').trigger('click');
    check('点开面板：is-open + 5 个应用类型',
        $tm.hasClass('is-open') && $tm.find('.ai-multi__opt').length === 5,
        $tm.find('.ai-multi__opt').length);
    check('展开时 aria-expanded=true',
        $tm.find('.ai-multi__box').attr('aria-expanded') === 'true');
    $dm.find('.ai-multi__box').trigger('click');
    check('打开第二个面板时第一个自动收起',
        !$tm.hasClass('is-open') && $dm.hasClass('is-open'));
    check('数据库类型 6 项', $dm.find('.ai-multi__opt').length === 6,
        $dm.find('.ai-multi__opt').length);

    $dm.find('.ai-multi__opt input').eq(0).prop('checked', true).trigger('change');
    check('勾选写回隐藏域（mysql）', $('#appDbType').val() === 'mysql', $('#appDbType').val());
    $dm.find('.ai-multi__clear').trigger('click');
    check('「清空」同时清勾选 / 隐藏域 / 按钮文案',
        $('#appDbType').val() === '' && $dm.find('.ai-multi__opt input:checked').length === 0 &&
        $dm.find('.ai-multi__text').text() === '全部');

    /* 多选 → 查询：只留「后台服务」那一条 */
    $tm.find('.ai-multi__opt input').eq(1).prop('checked', true).trigger('change');
    check('多选值以逗号串传给后端（service）', $('#appType').val() === 'service', $('#appType').val());
    $('#appBtnSearch').trigger('click');
    var filtered = await until(function () {
        var list = doc.querySelectorAll('#appTbody tr[data-id]');
        return list.length === 1 && doc.getElementById('appTbody').textContent.indexOf('报表服务') > -1;
    });
    check('按应用类型多选过滤后只剩 1 条', filtered,
        doc.querySelectorAll('#appTbody tr[data-id]').length + ' 条');
    check('过滤后计数同步为 1', doc.getElementById('appCount').textContent === '1',
        doc.getElementById('appCount').textContent);

    /* 再叠一个数据库类型：sqlite → 仍是那一条 */
    $dm.find('.ai-multi__opt input[value=sqlite]').prop('checked', true).trigger('change');
    check('库类型多选值以逗号串传递（sqlite）', $('#appDbType').val() === 'sqlite', $('#appDbType').val());
    $('#appBtnSearch').trigger('click');
    var filtered2 = await until(function () {
        return doc.getElementById('appTbody').textContent.indexOf('报表服务') > -1 &&
            doc.querySelectorAll('#appTbody tr[data-id]').length === 1;
    });
    check('应用类型 + 数据库类型同时多选（service + sqlite）仍命中 1 条', filtered2);

    /* 重置：多选、关键字、状态一起归零并重新查全部 */
    $('#appKeyword').val('报表');
    $('#appStatus').val('1');
    $('#appBtnReset').trigger('click');
    var resetOk = await until(function () {
        return doc.querySelectorAll('#appTbody tr[data-id]').length === 3;
    });
    check('重置后清空全部条件并重新查回 3 条', resetOk,
        doc.querySelectorAll('#appTbody tr[data-id]').length + ' 条');
    check('重置后多选隐藏域 / 文案 / 关键字都归零',
        $('#appType').val() === '' && $('#appDbType').val() === '' &&
        $('#appKeyword').val() === '' && $tm.find('.ai-multi__text').text() === '全部');
    check('重置后分页回到第 1 页', doc.getElementById('appPager').textContent.indexOf('共 3 条') > -1,
        doc.getElementById('appPager').textContent.slice(0, 40));

    /* ------------------------------------------------ 应用结构页（Mock） */
    console.log('\n③ 应用结构页（离线 Mock，先造一份结构）');
    var dom2 = new JSDOM(schemaHtml, {
        url: 'http://127.0.0.1:8808/appschema.html',
        runScripts: 'outside-only', pretendToBeVisual: true
    });
    var win2 = dom2.window;
    win2.eval(read('vendor/jquery-3.7.1.min.js'));
    win2.eval(read('js/theme.js'));
    win2.eval(read('js/icons.js'));
    win2.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
        token: 'mock-token', user: { empId: 1, nameCn: '系统管理员' }
    }));
    win2.eval(read('js/api.js'));
    win2.Api.config.useMock = true;
    var apps = await win2.Api.appInfo.options();
    check('应用下拉有应用', (apps.list || []).length >= 2, (apps.list || []).length);
    var appId = apps.list[0].id;
    var tree0 = await win2.Api.appSchema.dbadd(appId, { dbName: 'smoke_db', dbComment: '冒烟库' });
    var dbId = tree0.databases[0].id;
    var objRes = await win2.Api.appSchema.objadd(appId, { dbId: dbId, objName: 'smoke_t', objType: 'table' });
    var objId = objRes.id;
    await win2.Api.appSchema.colsave(objId, [
        { colName: 'id', dataType: 'BIGINT', nullable: false, isPk: true, isAutoInc: true, colComment: '主键' },
        { colName: 'name', dataType: 'VARCHAR', length: '50', nullable: false, colComment: '名称' },
        { colName: 'flag', dataType: 'BOOLEAN', defaultValue: '1', colComment: '启用' }
    ], appId);
    var vers0 = await win2.Api.appSchema.versions(appId);
    check('Mock 造出 3 个草稿（建库 / 建表 / 存字段各一条）',
        (vers0.list || []).length === 3 && vers0.list[0].kind === 'draft',
        (vers0.list || []).length);

    win2.eval(read('js/ui.js'));
    win2.eval(read('js/layout.js'));
    win2.eval(read('js/btnperm.js'));
    win2.eval(read('js/appschema.js'));
    var doc2 = win2.document;
    var $2 = win2.jQuery;

    var treeReady = await until(function () {
        return doc2.querySelectorAll('#asTree .as-node[data-kind=db]').length > 0;
    });
    check('结构树渲染出库节点', treeReady);
    check('库节点下挂表节点', doc2.querySelectorAll('#asTree .as-node[data-kind=obj]').length === 1,
        doc2.querySelectorAll('#asTree .as-node[data-kind=obj]').length);
    check('树计数文案含「1 库 / 1 对象」',
        doc2.getElementById('asTreeCount').textContent.indexOf('1 库 / 1 对象') > -1,
        doc2.getElementById('asTreeCount').textContent);
    check('应用元信息显示编码', doc2.getElementById('asMeta').textContent.indexOf('APP0001') > -1,
        doc2.getElementById('asMeta').textContent.slice(0, 80));
    check('有连接的应用在元信息里显示「扫描目标 + 连接名」',
        doc2.getElementById('asMeta').textContent.indexOf('扫描目标') > -1 &&
        doc2.getElementById('asMeta').textContent.indexOf('九豆主库') > -1,
        doc2.getElementById('asMeta').textContent.slice(0, 120));
    check('未绑连接的应用仍会提示「纯手工」（源码里保留该分支）',
        read('js/appschema.js').indexOf('未绑定（纯手工）') > -1);

    /* 点表 → 字段明细 */
    var objRow = doc2.querySelector('#asTree .as-node[data-kind=obj] .as-node__row');
    $2(objRow).trigger('click');
    var colsReady = await until(function () {
        return doc2.querySelectorAll('#asColsBody tr[data-id]').length === 3;
    });
    check('点表后字段明细渲染 3 行', colsReady,
        doc2.querySelectorAll('#asColsBody tr[data-id]').length);
    check('表名带库前缀显示', doc2.getElementById('asObjTitle').textContent === 'smoke_db.smoke_t',
        doc2.getElementById('asObjTitle').textContent);
    check('字段行有类型下拉（逻辑类型 16 项）',
        doc2.querySelectorAll('#asColsBody tr[data-id] select[data-f=dataType] option').length >= 16,
        doc2.querySelectorAll('#asColsBody tr[data-id] select[data-f=dataType] option').length);
    check('主键格勾上', doc2.querySelector('#asColsBody tr[data-id] input[data-f=isPk]').checked);
    check('来源列显示「手工」', doc2.getElementById('asColsBody').textContent.indexOf('手工') > -1);
    check('新增字段 / 批量粘贴 / 保存按钮可用',
        doc2.getElementById('asBtnColAdd').disabled === false &&
        doc2.getElementById('asBtnColPaste').disabled === false &&
        doc2.getElementById('asBtnColSave').disabled === false);

    /* 改字段长度后保存 → 版本 +1 */
    var lengthInput = doc2.querySelectorAll('#asColsBody tr[data-id] input[data-f=length]')[1];
    lengthInput.value = '120';
    $2(lengthInput).trigger('change');
    check('改过的输入框打上 is-dirty', lengthInput.className.indexOf('is-dirty') > -1, lengthInput.className);
    $2('#asBtnColSave').trigger('click');
    var saved = await until(function () {
        return doc2.getElementById('asObjHint').textContent.indexOf('冒烟') > -1 ||
            doc2.querySelectorAll('#asColsBody tr[data-id]').length === 3;
    });
    await wait(400);
    var vers1 = await win2.Api.appSchema.versions(appId);
    check('保存字段后版本 +1（3 → 4）', (vers1.list || []).length === 4, (vers1.list || []).length);
    check('新版本摘要是「维护字段」类且变更数 > 0',
        (vers1.list[0].summary || '').indexOf('字段') > -1 && (vers1.list[0].changeCount || 0) > 0,
        vers1.list[0].summary + ' / ' + vers1.list[0].changeCount);

    /* 标签页切换 */
    $2('#asTabNav .el-tabs__item[data-tab=versions]').trigger('click');
    var verReady = await until(function () {
        return doc2.querySelectorAll('#asVerBody tr[data-id]').length >= 2;
    });
    check('版本历史列出 4 个草稿', verReady && doc2.querySelectorAll('#asVerBody tr[data-id]').length === 4,
        doc2.querySelectorAll('#asVerBody tr[data-id]').length);
    check('版本行标出「草稿」', doc2.getElementById('asVerBody').textContent.indexOf('草稿') > -1);
    check('草稿行有变更数', doc2.querySelector('#asVerBody tr[data-id] td:nth-child(4)').textContent !== '0');

    /* 点版本 → 变更明细 */
    $2(doc2.querySelectorAll('#asVerBody tr[data-id]')[0]).trigger('click');
    var changeReady = await until(function () {
        return doc2.querySelectorAll('#asChangeBody .as-op').length > 0;
    });
    check('点版本后显示变更明细', changeReady,
        doc2.getElementById('asChangeBody').textContent.slice(0, 80));
    check('明细里有「修改字段」', doc2.getElementById('asChangeBody').textContent.indexOf('修改字段') > -1,
        doc2.getElementById('asChangeBody').textContent.slice(0, 120));

    /* 发布草稿（弹窗 + 确认） */
    check('最新草稿可以发布（发布按钮可用）', doc2.getElementById('asBtnPublish').disabled === false);
    $2('#asBtnPublish').trigger('click');
    var pubDlg = await until(function () {
        return doc2.querySelectorAll('.el-dialog').length > 0;
    });
    check('点「发布草稿」弹出发布弹窗', pubDlg);
    check('发布弹窗写明「不会自动执行」',
        doc2.querySelector('.el-dialog').textContent.indexOf('不会自动执行') > -1);
    $2(doc2.querySelector('.el-dialog .btn-cancel')).trigger('click');
    await wait(150);

    /* 脚本页空状态（还没发布） */
    $2('#asTabNav .el-tabs__item[data-tab=scripts]').trigger('click');
    await wait(300);
    check('未发布时脚本页给出引导', doc2.getElementById('asScriptFoot').textContent.length > 4,
        doc2.getElementById('asScriptFoot').textContent);
    check('未发布时「标记已执行」禁用', doc2.getElementById('asBtnScriptOk').disabled === true);

    /* 扫描：只扫连接指定的那一个库（不做全库扫描） */
    $2('#asBtnScan').trigger('click');
    var scanDlg = await until(function () { return !!doc2.getElementById('asScanDb'); }, 5000);
    check('点「扫描导入」先读连接信息再弹「扫描目标」', scanDlg);
    var scanSel = doc2.getElementById('asScanDb');
    check('扫描目标默认选中连接的「默认库」jiudou_main', scanSel.value === 'jiudou_main', scanSel.value);
    check('扫描目标是单选（没有 multiple）', !scanSel.multiple);
    check('系统库不出现在扫描目标里',
        !Array.prototype.some.call(scanSel.options, function (o) { return o.value === 'information_schema'; }));
    check('弹窗写明「只扫选中的这一个库」',
        doc2.querySelector('.el-dialog').textContent.indexOf('只扫选中的') > -1);
    $2(doc2).find('.el-dialog .btn-ok').trigger('click');
    var scanDone = await until(function () {
        return Array.prototype.some.call(
            doc2.querySelectorAll('#asTree .as-node[data-kind=db]'),
            function (n) { return n.getAttribute('data-name') === 'jiudou_main'; });
    }, 8000);
    check('确认后完成扫描（树里出现 jiudou_main）', scanDone);
    var scannedDbs = Array.prototype.map.call(
        doc2.querySelectorAll('#asTree .as-node[data-kind=db]'),
        function (n) { return n.getAttribute('data-name'); });
    check('只导入了 jiudou_main（兄弟库 jiudou_report 没被顺手扫进来）',
        scannedDbs.indexOf('jiudou_main') > -1 && scannedDbs.indexOf('jiudou_report') < 0,
        scannedDbs.join(','));
    /* 对比页：先选「实库连接」再选「目标库」（上线前可换成生产库连接） */
    $2('#asTabNav .el-tabs__item[data-tab=compare]').trigger('click');
    var cmpConnReady = await until(function () {
        var sel = doc2.getElementById('asCmpConn');
        return !!sel && sel.options.length > 0 && !!sel.value;
    }, 5000);
    check('对比页有「实库连接」下拉，默认选中应用绑定的连接', cmpConnReady,
        String((doc2.getElementById('asCmpConn') || {}).value));
    var cmpDbReady = await until(function () {
        var sel = doc2.getElementById('asCmpDb');
        return !!sel && sel.value === 'jiudou_main';
    }, 5000);
    check('对比页目标库跟着所选连接的默认库（不是「全部库」）', cmpDbReady,
        doc2.getElementById('asCmpDb') ? doc2.getElementById('asCmpDb').value : '');
    check('「对应设计态库」默认不展开（同名库不用人确认映射）',
        doc2.getElementById('asCmpDesignWrap').hasAttribute('hidden'));

    $2('#asTabNav .el-tabs__item[data-tab=cols]').trigger('click');

    /* 扫描收录：索引 / 触发器 / 函数（不只是表和视图） */
    function nodesOf(type) {
        return Array.prototype.slice.call(
            doc2.querySelectorAll('#asTree .as-node[data-kind=obj][data-objtype=' + type + ']'));
    }
    var idxNodes = nodesOf('index'), trgNodes = nodesOf('trigger'), fnNodes = nodesOf('function');
    check('扫描把索引收进来了（empinfos.idx_emp_code）',
        idxNodes.some(function (n) { return n.getAttribute('data-name') === 'empinfos.idx_emp_code'; }),
        idxNodes.map(function (n) { return n.getAttribute('data-name'); }).join(','));
    check('扫描把触发器收进来了（empinfos.trg_emp_audit）',
        trgNodes.some(function (n) { return n.getAttribute('data-name') === 'empinfos.trg_emp_audit'; }),
        trgNodes.map(function (n) { return n.getAttribute('data-name'); }).join(','));
    check('扫描把函数收进来了（f_emp_level，和存储过程分开）',
        fnNodes.some(function (n) { return n.getAttribute('data-name') === 'f_emp_level'; }),
        fnNodes.map(function (n) { return n.getAttribute('data-name'); }).join(','));
    check('索引节点的类型徽标是「索引」',
        idxNodes.length > 0 && idxNodes[0].querySelector('.as-node__kind').textContent === '索引',
        idxNodes.length ? idxNodes[0].querySelector('.as-node__kind').textContent : '(无)');
    check('函数节点的类型徽标是「函数」',
        fnNodes.length > 0 && fnNodes[0].querySelector('.as-node__kind').textContent === '函数',
        fnNodes.length ? fnNodes[0].querySelector('.as-node__kind').textContent : '(无)');

    /* 顺序：表 / 视图在前，索引 / 触发器 / 函数在后 */
    var allObjs = Array.prototype.slice.call(
        doc2.querySelectorAll('#asTree .as-node[data-kind=obj]'));
    var firstAux = -1, lastTable = -1;
    allObjs.forEach(function (n, i) {
        var t = n.getAttribute('data-objtype');
        if (t === 'table' || t === 'view') { lastTable = i; }
        if ((t === 'index' || t === 'trigger' || t === 'function') && firstAux < 0) { firstAux = i; }
    });
    check('树里表 / 视图排在索引 / 触发器 / 函数之前（不是 objType 字母序）',
        firstAux > lastTable && lastTable >= 0, 'lastTable=' + lastTable + ' firstAux=' + firstAux);

    /* 点索引节点：字段按钮不可用，定义框显示 CREATE INDEX 原文 */
    if (idxNodes.length) {
        $2(idxNodes[0].querySelector('.as-node__row')).trigger('click');
        var idxReady = await until(function () {
            return (doc2.getElementById('asObjDdl').value || '').indexOf('CREATE') > -1;
        }, 5000);
        check('点索引节点能读到定义原文（CREATE INDEX … ON …）', idxReady,
            (doc2.getElementById('asObjDdl').value || '').slice(0, 60));
        check('索引的定义框标题写「索引定义」',
            doc2.getElementById('asObjDdlTitle').textContent.indexOf('索引') > -1,
            doc2.getElementById('asObjDdlTitle').textContent);
        check('索引不是表：新增字段 / 批量粘贴 / 保存字段都禁用',
            doc2.getElementById('asBtnColAdd').disabled === true &&
            doc2.getElementById('asBtnColPaste').disabled === true &&
            doc2.getElementById('asBtnColSave').disabled === true);
        check('索引页提示「依附于表」而不是「没有字段」',
            doc2.getElementById('asColsBody').textContent.indexOf('依附于表') > -1,
            doc2.getElementById('asColsBody').textContent.slice(0, 50));
    }
    if (fnNodes.length) {
        $2(fnNodes[0].querySelector('.as-node__row')).trigger('click');
        var fnReady = await until(function () {
            return (doc2.getElementById('asObjDdl').value || '').indexOf('CREATE FUNCTION') > -1;
        }, 5000);
        check('点函数节点能读到 CREATE FUNCTION 原文', fnReady,
            (doc2.getElementById('asObjDdl').value || '').slice(0, 60));
    }
    /* 复原选中：后面的字段 / 对比流程按「实库里也存在的表」走
       （对比目标库只能选连接里真实存在的库，手工建的 smoke_db 没有实库对应，不参与对比） */
    var mainDbNode0 = doc2.querySelector('#asTree .as-node[data-kind=db][data-name=jiudou_main]');
    var backTableRow = mainDbNode0
        ? mainDbNode0.querySelector('.as-node[data-kind=obj][data-objtype=table] .as-node__row') : null;
    if (backTableRow) {
        $2(backTableRow).trigger('click');
        await until(function () {
            return doc2.querySelectorAll('#asColsBody tr[data-id]').length > 0;
        }, 5000);
    }

    /* 对比页空状态 */
    $2('#asTabNav .el-tabs__item[data-tab=compare]').trigger('click');
    await wait(300);
    check('对比页默认空态提示人工触发',
        doc2.getElementById('asCmpBody').textContent.indexOf('开始对比') > -1,
        doc2.getElementById('asCmpBody').textContent.slice(0, 60));

    /* ---------- 差异详情 + 实库升级脚本 ----------
       Mock 里「实库」= 最新正式版快照：先发一版，再改字段，才有差异可看 */
    var versBefore = await win2.Api.appSchema.versions(appId);
    var latestDraft = (versBefore.list || []).filter(function (v) { return v.kind === 'draft'; })[0];
    check('对比前有一版草稿可发布', !!latestDraft);
    await win2.Api.appSchema.publish(latestDraft.id, '对比基线', '', appId);
    await wait(300);
    var vers2 = await win2.Api.appSchema.versions(appId);
    check('正式版已生成（对比右值有依据）',
        (vers2.list || []).some(function (v) { return v.kind === 'release'; }),
        (vers2.list || []).map(function (v) { return v.kind; }).join(','));

    $2('#asTabNav .el-tabs__item[data-tab=cols]').trigger('click');
    var backCols = await until(function () {
        return doc2.querySelectorAll('#asColsBody tr[data-id] input[data-f=length]').length > 1;
    }, 4000);
    check('切回字段页时选中对象还在', backCols);
    if (backCols) {
        var lenInput2 = doc2.querySelectorAll('#asColsBody tr[data-id] input[data-f=length]')[1];
        lenInput2.value = '66';
        $2(lenInput2).trigger('change');
        $2('#asBtnColSave').trigger('click');
        await wait(600);
    }

    $2('#asTabNav .el-tabs__item[data-tab=compare]').trigger('click');
    await wait(250);
    $2('#asCmpDb').val('jiudou_main').trigger('change');
    $2('#asBtnCmpRun').trigger('click');
    var diffReady = await until(function () {
        return doc2.querySelectorAll('#asCmpBody tr.is-attrDiff, #asCmpBody tr.is-designOnly').length > 0;
    }, 8000);
    check('对比后差异按表聚合（表级一条，不是每列一条）', diffReady,
        doc2.getElementById('asCmpBody').textContent.slice(0, 120));
    check('说明列逐条列出「到底哪里不一样」',
        doc2.querySelectorAll('#asCmpBody .as-cmp__detail').length > 0 &&
        doc2.getElementById('asCmpBody').textContent.indexOf('字段「') > -1,
        doc2.getElementById('asCmpBody').textContent.slice(0, 160));
    check('升级语句列按项显示条数',
        doc2.querySelectorAll('#asCmpBody .as-cmp__sql').length > 0,
        doc2.getElementById('asCmpBody').textContent.slice(0, 100));

    /* 点「N 条」→ 该次对比的升级脚本 */
    $2(doc2.querySelector('#asCmpBody .as-cmp__sql')).trigger('click');
    var upDlg = await until(function () {
        var ta = doc2.getElementById('asUpText');
        return !!ta && String(ta.value || '').length > 50;
    }, 8000);
    check('点「N 条」打开升级脚本弹窗', upDlg);
    var upText = upDlg ? doc2.getElementById('asUpText').value : '';
    check('脚本里有改表语句（ALTER TABLE / MODIFY COLUMN）',
        upText.indexOf('ALTER TABLE') > -1 && upText.indexOf('MODIFY COLUMN') > -1,
        upText.slice(0, 160));
    check('脚本头部写明「实库 → 设计态」且不会自动执行',
        upText.indexOf('实库 → 设计态') > -1 && upText.indexOf('不会自动执行') > -1);
    check('脚本按对象分组，组头带差异注释', upText.indexOf('-- [表]') > -1);
    check('弹窗概要给出语句数 / 覆盖对象数 / 目标库',
        doc2.getElementById('asUpSummary').textContent.indexOf('条语句') > -1 &&
        doc2.getElementById('asUpSummary').textContent.indexOf('jiudou_main') > -1,
        doc2.getElementById('asUpSummary').textContent);
    $2(doc2.querySelector('.el-dialog .btn-ok')).trigger('click');
    await wait(150);

    /* 对比页的「升级脚本」按钮 + 「批量导出」按钮 */
    $2('#asBtnCmpSql').trigger('click');
    var upDlg2 = await until(function () {
        var sum = doc2.getElementById('asUpSummary');
        return !!sum && sum.textContent.indexOf('条语句') > -1;
    }, 8000);
    check('对比页「升级脚本」按钮也能直接打开', upDlg2 &&
        doc2.getElementById('asUpSummary').textContent.indexOf('条语句') > -1);
    $2(doc2.querySelector('.el-dialog .btn-ok')).trigger('click');
    await wait(150);

    $2('#asBtnCmpExport').trigger('click');
    var exDlg = await until(function () { return doc2.querySelectorAll('.as-ex__row').length > 0; }, 5000);
    check('「批量导出」列出可勾选的对比记录', exDlg, doc2.querySelectorAll('.as-ex__row').length);
    check('默认勾选有差异的记录', doc2.querySelectorAll('.as-ex__pick:checked').length >= 1,
        doc2.querySelectorAll('.as-ex__pick:checked').length);
    $2(doc2.querySelector('.el-dialog .btn-cancel')).trigger('click');
    await wait(150);

    var exp = await win2.Api.appSchema.compareexport(appId, { ids: '' });
    check('批量导出接口合成一份脚本（带分段头 + 文件名）',
        exp.count >= 1 && exp.text.indexOf('第 1/') > -1 && exp.fileName.indexOf('.sql') > -1,
        exp.fileName + ' / ' + exp.count + ' 段');
    var cmps = await win2.Api.appSchema.compares(appId);
    var upg = await win2.Api.appSchema.compareupgrade(cmps.list[0].id, { appId: appId });
    check('历史对比记录同样能生成升级脚本', (upg.text || '').length > 50, (upg.text || '').slice(0, 80));
    var upgDrop = await win2.Api.appSchema.compareupgrade(cmps.list[0].id, { appId: appId, includeDrop: 1 });
    check('勾选「包含删除语句」时脚本可重新生成',
        (upgDrop.text || '').length > 50 && upgDrop.includeDrop === true);

    /* 索引 / 触发器 / 函数参与对比与脚本：基线（正式版）里没有的，判「仅设计有」并直接出 CREATE */
    var treeNow = await win2.Api.appSchema.tree(appId);
    var mainDbId = (treeNow.databases || []).filter(function (d) { return d.dbName === 'jiudou_main'; })[0].id;
    await win2.Api.appSchema.objadd(appId, {
        dbId: mainDbId, objName: 'smoke_t.idx_new', objType: 'index', objComment: '新索引',
        ddl: 'CREATE INDEX `idx_new` ON `smoke_t` (`name`)'
    });
    var idxCmp = await win2.Api.appSchema.compare(appId, { dbName: 'jiudou_main' });
    var idxItem = (idxCmp.items || []).filter(function (it) {
        return it.objName === 'jiudou_main.smoke_t.idx_new';
    })[0];
    check('对比把索引也算进来（objType=index）', !!idxItem && idxItem.objType === 'index',
        (idxCmp.items || []).map(function (it) { return it.objType + ':' + it.objName; }).join(','));
    check('实库缺的索引判为「仅设计有（待建）」',
        !!idxItem && idxItem.diffType === 'designOnly', idxItem ? idxItem.diffType : '(无)');
    var idxUp = await win2.Api.appSchema.compareupgrade(idxCmp.id, { appId: appId });
    var idxLines = (idxUp.text || '').split('\n').filter(function (l) { return l.indexOf('INDEX') > -1; });
    check('升级脚本给新索引生成 CREATE INDEX', idxLines.length > 0, idxLines.join(' | '));
    check('索引名是裸索引名（不会写成 CREATE INDEX `smoke_t.idx_new`）',
        idxLines.join(' ').indexOf('`smoke_t.idx_new`') < 0 && idxLines.join(' ').indexOf('idx_new') > -1,
        idxLines.join(' | '));

    /* ---------- 导出表结构文档：勾选表 → Excel / Word ---------- */
    console.log('\n⑧ 导出表结构：勾选 → 导出弹窗（离线 Mock）');
    var pickSel = '#asTree .as-node[data-kind=obj] .as-node__pick';
    var picks = doc2.querySelectorAll(pickSel);
    var idxPick = doc2.querySelectorAll('#asTree .as-node[data-objtype=index] .as-node__pick');
    var idxPh = doc2.querySelectorAll('#asTree .as-node[data-objtype=index] .as-node__pick-ph');
    check('表 / 视图节点渲染了勾选框', picks.length > 0, picks.length);
    check('索引 / 触发器 / 函数没有勾选框（只有占位，保持缩进）',
        idxPick.length === 0 && idxPh.length > 0, idxPick.length + ' / ' + idxPh.length);

    function fire(el, type) {
        el.dispatchEvent(new win2.Event(type, { bubbles: true }));
    }
    /* 库里有两个库（smoke_db 1 张表 / jiudou_main 扫描出来的多张表），
       按「jiudou_main」这一库验证勾选联动，避免拿错库节点 */
    var dbNodes = Array.prototype.slice.call(doc2.querySelectorAll('#asTree .as-node[data-kind=db]'));
    var dbNode = dbNodes.filter(function (n) { return n.getAttribute('data-name') === 'jiudou_main'; })[0] ||
        dbNodes[0];
    var dbPick = dbNode.querySelector('.as-node__row .as-node__pick');
    var dbPicks = dbNode.querySelectorAll('.as-node__children .as-node__pick');
    check('库节点也有勾选框（一键选全库）', !!dbPick);
    check('jiudou_main 库下有多张可导出的表 / 视图', dbPicks.length >= 2, dbPicks.length);
    if (dbPicks.length >= 2) {
        dbPicks[0].checked = true; fire(dbPicks[0], 'change');
        dbPicks[1].checked = true; fire(dbPicks[1], 'change');
        check('勾 2 张 → 工具栏显示「已勾选 2 张」',
            doc2.getElementById('asPickHint').textContent === '已勾选 2 张',
            doc2.getElementById('asPickHint').textContent);
        check('库勾选框变半选（有勾有未勾）', dbPick.indeterminate === true,
            'indeterminate=' + dbPick.indeterminate + ' checked=' + dbPick.checked +
            ' dbPicks=' + dbPicks.length);
        check('导出按钮的提示跟着勾选数变',
            (doc2.getElementById('asBtnExport').getAttribute('title') || '').indexOf('已勾选的 2 张') > -1,
            doc2.getElementById('asBtnExport').getAttribute('title'));

        dbPick.checked = true; fire(dbPick, 'change');
        check('勾库 = 选全库的表 / 视图',
            dbNode.querySelectorAll('.as-node__children .as-node__pick:checked').length === dbPicks.length,
            dbNode.querySelectorAll('.as-node__children .as-node__pick:checked').length +
            ' / ' + dbPicks.length);
        check('勾库后库勾选框是「全选」而不是半选', dbPick.indeterminate === false && dbPick.checked === true);

        dbPick.checked = false; fire(dbPick, 'change');
        check('取消库 = 清空本库勾选',
            dbNode.querySelectorAll('.as-node__children .as-node__pick:checked').length === 0,
            dbNode.querySelectorAll('.as-node__children .as-node__pick:checked').length);

        /* 只勾 2 张，打开导出弹窗 */
        dbPicks[0].checked = true; fire(dbPicks[0], 'change');
        dbPicks[1].checked = true; fire(dbPicks[1], 'change');
    }
    $2('#asBtnExport').trigger('click');
    var docDlg = await until(function () { return !!doc2.querySelector('.as-doc__card'); }, 3000);
    check('点「导出表结构」弹出弹窗', docDlg);
    check('弹窗标题是「导出表结构文档」',
        (doc2.querySelector('.el-dialog__title') || {}).textContent === '导出表结构文档',
        (doc2.querySelector('.el-dialog__title') || {}).textContent);
    check('两种格式各一张卡片（Excel / Word）',
        doc2.querySelectorAll('.as-doc__card').length === 2 &&
        doc2.querySelector('.as-doc__card[data-fmt=xlsx]').textContent.indexOf('Excel') > -1 &&
        doc2.querySelector('.as-doc__card[data-fmt=docx]').textContent.indexOf('Word') > -1);
    check('弹窗写明导出范围（已勾选的 N 张）',
        doc2.getElementById('asDocRange').textContent.indexOf('已勾选的 2 张') > -1,
        doc2.getElementById('asDocRange').textContent);
    check('弹窗脚注写明文档包含应用信息 / 表中文字段中文名 / 导出时间',
        doc2.querySelector('.as-doc__foot').textContent.indexOf('应用信息') > -1 &&
        doc2.querySelector('.as-doc__foot').textContent.indexOf('导出时间') > -1);
    check('导出弹窗没有多余的「确定 / 取消」（导出由卡片直接触发）',
        doc2.querySelector('.el-dialog .btn-ok') === null &&
        doc2.querySelector('.el-dialog .btn-cancel') === null);
    var docAll = doc2.getElementById('asDocAll');
    docAll.checked = true; fire(docAll, 'change');
    check('勾「忽略勾选」后范围变成全部表 / 视图',
        doc2.getElementById('asDocRange').textContent.indexOf('全部表 / 视图') > -1,
        doc2.getElementById('asDocRange').textContent);

    console.log('\n⑤ 字段血缘（视图字段 ← 基表字段）');
    /* 字段血缘：视图字段 ← 基表字段（离线 Mock 用正则解析单层 SELECT ... FROM，口径与后端一致） */
    var viewNodes = doc2.querySelectorAll('#asTree .as-node[data-kind=obj][data-objtype=view]');
    var lgView = null;
    for (var vi = 0; vi < viewNodes.length; vi++) {
        if (viewNodes[vi].getAttribute('data-name') === 'v_emp_dept') { lgView = viewNodes[vi]; }
    }
    check('扫描把视图收进来了（v_emp_dept，血缘要用它的定义）', !!lgView);
    if (lgView) {
        $2(lgView.querySelector('.as-node__row')).trigger('click');
        await wait(200);
        $2('#asTabNav .el-tabs__item[data-tab=lineage]').trigger('click');
        var lgReady = await until(function () {
            return doc2.querySelectorAll('#asLgFields .as-lg__field').length >= 3;
        }, 5000);
        var lgNames = Array.prototype.map.call(
            doc2.querySelectorAll('#asLgFields .as-lg__field'),
            function (n) { return n.getAttribute('data-col'); });
        check('血缘页列出视图的输出字段（code / nameCn / deptName）',
            lgReady && lgNames.join(',') === 'code,nameCn,deptName', lgNames.join(','));
        check('血缘页顶部显示分析统计（条数 / 参与对象）',
            doc2.getElementById('asLgStat').textContent.indexOf('血缘') > -1,
            doc2.getElementById('asLgStat').textContent);
        var lgUp1 = doc2.getElementById('asLgUpBody').textContent;
        check('默认选中第一个有血缘的字段，上游指到基表字段（empinfos.code）',
            lgUp1.indexOf('empinfos') > -1 && lgUp1.indexOf('code') > -1, lgUp1.slice(0, 120));
        var lgFields = doc2.querySelectorAll('#asLgFields .as-lg__field');
        for (var lfi = 0; lfi < lgFields.length; lfi++) {
            if (lgFields[lfi].getAttribute('data-col') === 'deptName') { $2(lgFields[lfi]).trigger('click'); }
        }
        await wait(150);
        var lgUp2 = doc2.getElementById('asLgUpBody').textContent;
        check('切换字段后上游跟着变（deptName ← OrganizationStructure.nameCn）',
            lgUp2.indexOf('OrganizationStructure') > -1 && lgUp2.indexOf('nameCn') > -1,
            lgUp2.slice(0, 140));
        check('没有下游时给出明确说明（而不是一片空白）',
            doc2.getElementById('asLgDownBody').textContent.indexOf('没有对象用到') > -1,
            doc2.getElementById('asLgDownBody').textContent.slice(0, 80));
        var lgRowTxt = doc2.getElementById('asLgRowBody').textContent;
        check('整表依赖列出连接条件（视图 JOIN ON 的列，改了结果集就变）',
            lgRowTxt.indexOf('empinfos') > -1 && lgRowTxt.indexOf('连接条件') > -1,
            lgRowTxt.slice(0, 160));
        check('整表依赖里的来源字段可以点（顺藤摸到那张表）',
            doc2.querySelectorAll('#asLgRowBody tr[data-obj]').length >= 2,
            String(doc2.querySelectorAll('#asLgRowBody tr[data-obj]').length));
        check('血缘边带类型徽标（原样 / 计算 / 聚合 …）',
            doc2.querySelectorAll('#asLgUpBody .as-lg__sub').length >= 1 &&
            (doc2.getElementById('asLgStat').textContent.indexOf('直接') > -1),
            doc2.getElementById('asLgStat').textContent);
        $2('#asBtnLgBuild').trigger('click');
        var lgRebuilt = await until(function () {
            return doc2.getElementById('asLgStat').textContent.indexOf('血缘') > -1 &&
                doc2.querySelectorAll('#asLgFields .as-lg__field').length >= 3;
        }, 5000);
        check('点「重新分析」后结果照常展示（不丢字段、不清空）', lgRebuilt,
            doc2.getElementById('asLgStat').textContent);
    }

    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
})();
