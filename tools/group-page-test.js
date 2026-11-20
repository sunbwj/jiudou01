/* ==========================================================================
   group-page-test.js —— 菜单组管理页面测试（jsdom，无需浏览器）
   覆盖：查询结果区按「菜单组层级」加载（父 → 子深度优先，Mock treeKwDfs 与后端
        _sorted_forest 同口径）/ 中文名按层级缩进 / 上级与全路径展示 /
        行选中与双击编辑 / 关键字检索保持父前子后 / 启用筛选 / 重置
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/group-page-test.js
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
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

/* ---------- 装载菜单组管理页（不发真实请求，api.js 走 Mock 通道） ---------- */
function boot() {
    var dom = new JSDOM(read('menu-group.html'), {
        url: 'http://127.0.0.1:8808/menu-group.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.jQuery.ajax = function () {              // 后端探测失败 → api.js 自动回退 Mock
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/layout.js'));
    // 预置分页状态：一页放下全部 15 条种子，便于断言整棵树的顺序
    win.sessionStorage.setItem('menu_admin_group_list_state',
        JSON.stringify({ keyword: '', enabled: '', pageNum: 1, pageSize: 50 }));
    win.AppNav = win.AppNav || {};
    win.AppNav.go = function (u) { win.__lastNav = u; };
    win.AppNav.reloadNav = function () { win.__navReloaded = true; };
    win.eval(read('js/menu-group.js'));
    return win;
}

/* 默认种子（SEED_GROUP）按层级加载后的期望顺序（父 → 子深度优先，同级按排序号） */
var EXPECT_DFS = ['GRP0100', 'GRP0200', 'GRP0300', 'GRP0400', 'GRP0500', 'GRP0600',
                  'GRP0700', 'GRP0800', 'GRP0900', 'GRP1100', 'GRP1000', 'GRP1200',
                  'GRP1300', 'GRP1400', 'GRP1500'];

var win = boot();
var $ = win.jQuery;

setTimeout(function () {
    console.log('\n--- 1. 查询结果区按层级加载 ---');
    var $rows = $('#groupTbody tr[data-id]');
    check('一页渲染全部 15 条种子', $rows.length === 15, 'rows=' + $rows.length);

    var codes = $rows.map(function () { return $(this).find('td').eq(4).text().trim(); }).get();
    check('列表顺序为父 → 子深度优先（同级按排序号）',
          JSON.stringify(codes) === JSON.stringify(EXPECT_DFS), codes.join(','));

    check('首行为顶级菜单组「系统管理」（上级列显示 —）',
          codes[0] === 'GRP0100' && $rows.first().find('td').eq(7).text().trim() === '—',
          $rows.first().find('td').eq(4).text() + ' / 上级=' + $rows.first().find('td').eq(7).text());

    check('层级序 ≠ 平铺序号序：「菜单配置」排在「订单管理」之前',
          codes.indexOf('GRP0400') < codes.indexOf('GRP0600'), codes.join(','));
    check('父组后紧跟其子组：「订单管理」下一条是「订单查询」',
          codes.indexOf('GRP0600') >= 0 && codes[codes.indexOf('GRP0600') + 1] === 'GRP0700',
          codes.join(','));

    console.log('\n--- 2. 中文名层级缩进与上级展示 ---');
    function rowByCode(code) { return $rows.filter(function () { return $(this).find('td').eq(4).text().trim() === code; }); }
    var $lv1 = rowByCode('GRP0100'), $lv2 = rowByCode('GRP0200'), $lv3 = rowByCode('GRP0300');
    check('一级组无缩进、无 └ 前缀',
          $lv1.find('.tree-name').length === 1 && $lv1.find('.tree-mark').length === 0 &&
          ($lv1.find('.tree-name').attr('style') || '').indexOf('padding-left') < 0,
          $lv1.find('.tree-name').attr('style') || '');
    check('二级组缩进 16px 并带 └ 前缀',
          ($lv2.find('.tree-name').attr('style') || '').indexOf('padding-left:16px') >= 0 &&
          $lv2.find('.tree-mark').text() === '└',
          $lv2.find('.tree-name').attr('style') || '');
    check('三级组缩进 32px',
          ($lv3.find('.tree-name').attr('style') || '').indexOf('padding-left:32px') >= 0,
          $lv3.find('.tree-name').attr('style') || '');
    check('三级组「上级菜单组」列显示直接上级（用户管理）且 title 带全路径',
          $lv3.find('td').eq(7).text().trim() === '用户管理' &&
          /系统管理 \/ 用户管理/.test($lv3.find('td').eq(7).find('.cell').attr('title') || ''),
          $lv3.find('td').eq(7).text() + ' title=' + $lv3.find('td').eq(7).find('.cell').attr('title'));
    check('可否绑定菜单项：三级叶子组显示「否」',
          $lv3.find('td').eq(8).text().trim() === '否', $lv3.find('td').eq(8).text());

    console.log('\n--- 3. 选中与双击编辑 ---');
    $lv3.trigger('click');
    check('单击选中：行高亮 + 单选钮勾选 + 选中提示更新',
          $lv3.hasClass('current-row') && $lv3.find('.el-radio').hasClass('is-checked') &&
          $('#selTip').text().indexOf('角色权限') >= 0,
          $('#selTip').text());
    $lv3.trigger('dblclick');
    check('双击进入编辑页（带记录 id）',
          win.__lastNav === 'menu-group-form.html?mode=edit&id=3', String(win.__lastNav));

    console.log('\n--- 4. 关键字检索：命中行仍保持父前子后 ---');
    $('#keyword').val('订单');
    $('#btnSearch').trigger('click');
    setTimeout(function () {
        var $kw = $('#groupTbody tr[data-id]');
        var kwCodes = $kw.map(function () { return $(this).find('td').eq(4).text().trim(); }).get();
        check('关键字「订单」命中 2 条', $kw.length === 2, 'rows=' + $kw.length + ' ' + kwCodes.join(','));
        check('命中结果保持层级顺序：订单管理（父）在订单查询（子）之前',
              JSON.stringify(kwCodes) === JSON.stringify(['GRP0600', 'GRP0700']), kwCodes.join(','));
        check('局部根也带缩进信息：二级组订单管理仍缩进 16px',
              ($kw.first().find('.tree-name').attr('style') || '').indexOf('padding-left:16px') >= 0,
              $kw.first().find('.tree-name').attr('style') || '');

        console.log('\n--- 5. 启用筛选与重置 ---');
        $('#keyword').val('');
        $('#enabled').val('0');
        $('#btnSearch').trigger('click');
        setTimeout(function () {
            var $off = $('#groupTbody tr[data-id]');
            check('启用=0 只剩 2 条停用组', $off.length === 2,
                  $off.map(function () { return $(this).find('td').eq(4).text().trim(); }).get().join(','));
            $('#btnReset').trigger('click');
            setTimeout(function () {
                var $all = $('#groupTbody tr[data-id]');
                check('重置后恢复 15 条且仍按层级顺序',
                      $all.length === 15 &&
                      JSON.stringify($all.map(function () { return $(this).find('td').eq(4).text().trim(); }).get()) === JSON.stringify(EXPECT_DFS),
                      'rows=' + $all.length);
                check('重置后清空选中提示',
                      $('#selTip').text().indexOf('未选择') >= 0, $('#selTip').text());

                console.log('\n========================================');
                console.log('group-page-test 通过 ' + pass + ' / 失败 ' + fail);
                console.log('========================================');
                process.exit(fail ? 1 : 0);
            }, 400);
        }, 400);
    }, 400);
}, 800);
