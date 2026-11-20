/* ==========================================================================
   address-book-test.js —— 员工通讯录页面测试（jsdom，Mock 通道）
   覆盖：组织架构树（层级 / 人数徽标 / 全部员工 / 折叠展开 / 部门搜索）/
        通讯录卡片（只读字段：工号 姓名 性别 岗位 部门 手机 邮箱 在职状态）/
        部门筛选（含下级部门 / 仅直属）/ 关键字与在职状态检索 / 重置 / 分页 /
        「只读」约束（页面无新增编辑删除入口、接口不返回档案字段）
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/address-book-test.js
   ========================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var JSDOM = (function () {
    try { return require('jsdom').JSDOM; } catch (e) { return null; }
})();

var ROOT = path.resolve(__dirname, '..');
var pass = 0, fail = 0;

function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再装）');
    process.exit(0);
}

function boot(page, scripts) {
    var dom = new JSDOM(read(page), {
        url: 'http://127.0.0.1:8808/' + page,
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.jQuery.ajax = function () {
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');          // 后端不可用 → api.js 回退 Mock
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    for (var i = 0; i < scripts.length; i++) { win.eval(read(scripts[i])); }
    return win;
}

var win = boot('address-book.html', ['js/address-book.js']);
var $ = win.jQuery;

function cards() { return $('#abGrid .ab-card'); }
function cardText() { return $('#abGrid').text().replace(/\s+/g, ' '); }
function treeText() { return $('#abTree').text().replace(/\s+/g, ' '); }
function nodeOf(deptId) { return $('#abTree .el-tree-node[data-id="' + deptId + '"]'); }
function nodeContent(deptId) { return nodeOf(deptId).children('.el-tree-node__content'); }
function names() {
    return cards().map(function () { return $.trim($(this).find('.ab-name').text().replace(/在职|试用|离职/g, '')); })
        .get();
}

var steps = [];
function step(fn, delay) { steps.push({ fn: fn, delay: delay || 700 }); }
function next() {
    var s = steps.shift();
    if (!s) { return finish(); }
    try { s.fn(); } catch (e) { check('步骤执行异常：' + e.message, false, e.stack); }
    setTimeout(next, s.delay);
}
function finish() {
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}

/* ------------------------------- 用例 ------------------------------- */
step(function () {
    console.log('\n--- 1. 首屏结构（左树 + 右卡片） ---');
    check('页面标题为「员工通讯录」', /员工通讯录/.test($('.page-head__title').text()),
        $('.page-head__title').text());
    check('面包屑为「人力资源中心/员工通讯录」',
        $('#pageHead').attr('data-crumb') === '人力资源中心/员工通讯录', $('#pageHead').attr('data-crumb'));
    check('左侧是组织架构树卡片', $('#abTree').length === 1 && $('.tree-card').length === 1);
    check('右侧有检索区与结果卡片', $('#abSearchForm').length === 1 && $('#abGrid').length === 1);
    check('右上角提示「通讯录仅供查询」', /仅供查询/.test($('#abGrid').closest('.el-card__body').text()),
        $('.ab-summary').text().replace(/\s+/g, ' ').slice(0, 60));
    check('树里固定有「全部员工」虚拟根', /全部员工/.test(treeText()), treeText().slice(0, 40));
    check('全部员工人数 = 6（Mock 种子员工数）',
        /全部员工\s*6/.test(treeText()), treeText().slice(0, 40));
    check('组织架构按层级渲染（6 个部门节点）',
        $('#abTree .el-tree-node[data-id]').length >= 7,      // 6 个部门 + 全部员工
        String($('#abTree .el-tree-node[data-id]').length));
    check('多层级部门嵌套（技术研发部下挂前端 / 后端研发组）',
        nodeOf(2).find('.el-tree-node__children .el-tree-node[data-id="3"]').length === 1 &&
        nodeOf(2).find('.el-tree-node__children .el-tree-node[data-id="4"]').length === 1);
    check('部门节点带人数徽标（技术研发部含下级 = 4 人）',
        /4/.test(nodeContent(2).text()), nodeContent(2).text().replace(/\s+/g, ' '));
});

step(function () {
    console.log('\n--- 2. 通讯录卡片（只读字段） ---');
    check('默认显示全部 6 名员工', cards().length === 6, String(cards().length));
    check('合计人数显示 6', $.trim($('#abTotal').text()) === '6', $('#abTotal').text());
    check('卡片显示姓名', /张守正/.test(cardText()) && /孙悦/.test(cardText()), cardText().slice(0, 80));
    check('卡片显示岗位 · 部门', /研发总监 · 技术研发部/.test(cardText()), cardText().slice(0, 120));
    check('卡片显示工号', /E00001/.test(cardText()));
    check('卡片显示手机（可拨号链接）',
        cards().first().find('a[href^="tel:"]').length === 1,
        cards().first().find('a[href^="tel:"]').attr('href'));
    check('卡片显示邮箱（可发信链接）',
        cards().first().find('a[href^="mailto:"]').length === 1,
        cards().first().find('a[href^="mailto:"]').attr('href'));
    check('手机 / 邮箱右侧有复制按钮（带复制值）',
        cards().first().find('.ab-copy[data-kind="phone"]').attr('data-copy') ===
            cards().first().find('a[href^="tel:"]').text().trim() &&
        cards().first().find('.ab-copy[data-kind="email"]').attr('data-copy') ===
            cards().first().find('.ab-email').attr('data-email'),
        cards().first().find('.ab-copy').length + ' 个');
    var navUrl = '';
    win.AppFrame = { navigate: function (u) { navUrl = u; } };
    var emailVal = cards().first().find('.ab-email').attr('data-email');
    cards().first().find('.ab-email').trigger('dblclick');
    check('双击邮箱打开我的信箱写信页并带入收件人',
        navUrl === 'emp-mail.html?compose=' + encodeURIComponent(emailVal), navUrl);
    check('卡片显示在职状态标签', /在职|试用|离职/.test(cardText()));
    check('卡片不出现身份证 / 学历 / 证书等档案字段',
        !/身份证|学历|院校|专业|证书|职称|出生|入职/.test(cardText()), cardText().slice(0, 100));
});

step(function () {
    console.log('\n--- 3. 部门筛选（含下级部门） ---');
    nodeContent(2).trigger('click');       // 技术研发部
});

step(function () {
    check('选中部门后树节点高亮', nodeContent(2).hasClass('is-current'));
    check('范围提示切换为「技术研发部（含下级部门）」',
        /技术研发部（含下级部门）/.test($('#abScope').text()), $('#abScope').text());
    check('含下级部门时显示本部门 + 2 个下级部门共 4 人', cards().length === 4, String(cards().length));
    check('结果里包含下级部门的人（赵小雨 / 王多云）',
        /赵小雨/.test(cardText()) && /王多云/.test(cardText()), cardText().slice(0, 120));
    check('不包含其它部门的员工（李耘创 / 孙悦）',
        !/李耘创/.test(cardText()) && !/孙悦/.test(cardText()));
});

step(function () {
    console.log('\n--- 4. 取消「含下级部门」只看直属 ---');
    $('#abChildren').prop('checked', false).trigger('change');
});

step(function () {
    check('取消勾选后范围提示去掉「含下级部门」',
        !/含下级部门/.test($('#abScope').text()), $('#abScope').text());
    check('只显示技术研发部直属员工 2 人', cards().length === 2, String(cards().length));
    check('直属员工是张守正 / 陈思远',
        /张守正/.test(cardText()) && /陈思远/.test(cardText()), cardText().slice(0, 80));
});

step(function () {
    console.log('\n--- 5. 关键字 + 在职状态检索 ---');
    $('#abChildren').prop('checked', true).trigger('change');   // 恢复
    nodeContent(0).trigger('click');                            // 回到全部员工
});

step(function () {
    check('回到全部员工', cards().length === 6 && /全部员工/.test($('#abScope').text()),
        String(cards().length) + ' / ' + $('#abScope').text());
    $('#abKeyword').val('张');
    $('#btnAbSearch').trigger('click');
});

step(function () {
    check('关键字「张」只命中 1 人', cards().length === 1 && /张守正/.test(cardText()), cardText().slice(0, 60));
    $('#abKeyword').val('');
    $('#abStatus').val('0');                 // 离职
    $('#btnAbSearch').trigger('click');
});

step(function () {
    check('按在职状态筛选（离职只剩孙悦）',
        cards().length === 1 && /孙悦/.test(cardText()) && /离职/.test(cardText()), cardText().slice(0, 60));
    $('#btnAbReset').trigger('click');
});

step(function () {
    check('重置后恢复全部 6 人', cards().length === 6, String(cards().length));
    check('重置后检索条件被清空',
        $('#abKeyword').val() === '' && $('#abStatus').val() === '');
});

step(function () {
    console.log('\n--- 6. 部门树折叠 / 搜索 ---');
    // 折叠「技术研发部」
    nodeOf(2).children('.el-tree-node__content').find('.el-tree-node__expand-icon').trigger('click');
});

step(function () {
    check('点击箭头可折叠部门（子节点隐藏）',
        nodeOf(2).children('.el-tree-node__children').css('display') === 'none',
        nodeOf(2).children('.el-tree-node__children').attr('style'));
    nodeOf(2).children('.el-tree-node__content').find('.el-tree-node__expand-icon').trigger('click');
});

step(function () {
    check('再次点击可展开', nodeOf(2).children('.el-tree-node__children').css('display') !== 'none');
    $('#abDeptKeyword').val('财务');
    $('#abDeptKeyword').trigger($.Event('keydown', { keyCode: 13 }));
});

step(function () {
    check('部门搜索只留下命中部门（财务人事部）',
        /财务人事部/.test(treeText()) && !/技术研发部/.test(treeText()) &&
        !/市场运营部/.test(treeText()), treeText().slice(0, 80));
    check('搜索结果里仍保留「全部员工」入口', /全部员工/.test(treeText()));
});

step(function () {
    console.log('\n--- 7. 只读约束 ---');
    var html = read('address-book.html');
    var js = read('js/address-book.js');
    check('页面没有新增 / 编辑 / 删除 / 导入 按钮',
        !/btnAdd|btnEdit|btnDelete|btnImport/.test(html) && !/新增员工|编辑员工|删除员工/.test(html));
    check('页面只有一个查询与一个重置按钮', /btnAbSearch/.test(html) && /btnAbReset/.test(html) &&
        $('.search-btns .el-button').length === 2, String($('.search-btns .el-button').length));
    check('脚本里没有任何写接口调用（add / update / delete）',
        js.indexOf('.add(') < 0 && js.indexOf('.update(') < 0 && js.indexOf('.remove(') < 0);

    win.Api.addressBook.page({ pageNum: 1, pageSize: 5 }).done(function (d) {
        var list = (d && d.list) || [];
        var keys = {};
        for (var i = 0; i < list.length; i++) {
            for (var k in list[i]) { if (list[i].hasOwnProperty(k)) { keys[k] = true; } }
        }
        var banned = ['idCard', 'photo', 'education', 'school', 'major', 'certificates',
            'titleName', 'birthDate', 'hireDate', 'remark', 'hasPhoto'];
        var leaked = banned.filter(function (x) { return keys[x]; });
        check('接口只返回通讯录字段（不含身份证 / 照片 / 学历等）', leaked.length === 0, leaked.join(','));
        check('接口返回字段与页面展示一致（工号 / 姓名 / 手机 / 邮箱 / 部门 / 岗位 / 状态）',
            ['code', 'nameCn', 'phone', 'email', 'deptName', 'jobTitle', 'statusText']
                .every(function (x) { return keys[x]; }), Object.keys(keys).sort().join(','));
    });
});

setTimeout(next, 900);   // 等首屏树 + 列表加载完（Mock 通道有 240ms 延迟）
