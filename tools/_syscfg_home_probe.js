/* 临时探针：用真实 /api/nav 数据验证首页功能卡片包含新增的「系统配置」组 */
'use strict';
var fs = require('fs');
var path = require('path');
var JSDOM = require('jsdom').JSDOM;
var ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
var nav = JSON.parse(read('tools/_nav_probe.json'));

var dom = new JSDOM(read('home.html'), {
    url: 'http://127.0.0.1:8808/home.html',
    runScripts: 'outside-only', pretendToBeVisual: true
});
var win = dom.window;
win.eval(read('vendor/jquery-3.7.1.min.js'));
win.eval(read('js/theme.js'));
win.eval(read('js/icons.js'));
win.jQuery.ajax = function () {
    var d = win.jQuery.Deferred(); d.reject({}, 'error', ''); return d.promise();
};
win.eval(read('js/api.js'));
win.Api.nav.get = function () {
    var d = win.jQuery.Deferred(); d.resolve(nav.data); return d.promise();
};
win.eval(read('js/home.js'));

var $ = win.jQuery;
var pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
setTimeout(function () {
    var $slides = $('#homeTrack .home-slide');
    var names = $slides.map(function () { return $(this).find('.home-slide__title').text(); }).get();
    console.log('顶级菜单组：' + names.join(' | '));
    check('首页按顶级菜单组渲染出多页（轮播）', $slides.length >= 7, String($slides.length));
    check('包含「系统配置」菜单组', names.indexOf('系统配置') >= 0, names.join('|'));
    check('原有「项目管理」组未被破坏', names.indexOf('项目管理') >= 0);
    var $cfg = $slides.filter(function () {
        return $(this).find('.home-slide__title').text() === '系统配置';
    });
    var hrefs = $cfg.find('.home-card').map(function () { return $(this).attr('data-href'); }).get();
    check('系统配置组下有 3 张功能卡片', hrefs.length === 3, hrefs.join(','));
    check('卡片分别指向 sysdict.html / sysdict-item.html / syspara.html',
        hrefs.indexOf('sysdict.html') >= 0 && hrefs.indexOf('sysdict-item.html') >= 0 &&
        hrefs.indexOf('syspara.html') >= 0, hrefs.join(','));
    check('卡片标题分别为系统字典 / 字典键值 / 系统参数',
        /系统字典/.test($cfg.find('.home-card').text()) &&
        /字典键值/.test($cfg.find('.home-card').text()) &&
        /系统参数/.test($cfg.find('.home-card').text()),
        $cfg.find('.home-card').text().replace(/\s+/g, ' ').slice(0, 160));
    check('卡片副标题带 crumb「系统配置」', /系统配置/.test($cfg.find('.home-card').text()));
    check('轮播控件已显示（组数 > 1）', $('#homeFoot')[0].hidden === false);
    check('圆点数量 = 菜单组数量',
        $('#homeDots .home-carousel__dot').length === $slides.length,
        String($('#homeDots .home-carousel__dot').length));
    var idx = names.indexOf('系统配置');
    $('#homeDots .home-carousel__dot').eq(idx).trigger('click');
    check('切到「系统配置」页后 transform 正确',
        String($('#homeTrack').attr('style')).indexOf('translateX(-' + (idx * 100) + '%)') >= 0,
        String($('#homeTrack').attr('style')));
    var total = $('#homeTrack .home-card').length;
    check('全部功能卡片数与菜单项数一致（20）', total === 20, String(total));
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}, 600);
