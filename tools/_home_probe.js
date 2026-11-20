/* 临时探针：用真实 /api/nav 数据验证首页功能卡片是否包含新增的「项目管理」组 */
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
// 用真实导航数据替换 Mock 通道
win.Api.nav.get = function () {
    var d = win.jQuery.Deferred(); d.resolve(nav.data); return d.promise();
};
win.eval(read('js/home.js'));

var $ = win.jQuery;
function check(name, cond, extra) {
    console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (extra ? '  ' + extra : ''));
}
setTimeout(function () {
    var $slides = $('#homeTrack .home-slide');
    var names = $slides.map(function () { return $(this).find('.home-slide__title').text(); }).get();
    console.log('顶级菜单组：' + names.join(' | '));
    check('首页渲染出多个顶级菜单组（轮播可见）', $slides.length > 1, String($slides.length));
    check('包含新增的「项目管理」菜单组', names.indexOf('项目管理') >= 0);
    var $pj = $slides.filter(function () {
        return $(this).find('.home-slide__title').text() === '项目管理';
    });
    var hrefs = $pj.find('.home-card').map(function () { return $(this).attr('data-href'); }).get();
    check('项目管理组下有两个功能卡片', hrefs.length === 2, hrefs.join(','));
    check('卡片指向 project.html 与 project-file.html',
        hrefs.indexOf('project.html') >= 0 && hrefs.indexOf('project-file.html') >= 0,
        hrefs.join(','));
    check('轮播控件已显示（组数 > 1）', $('#homeFoot')[0].hidden === false);
    check('圆点数量 = 菜单组数量', $('#homeDots .home-carousel__dot').length === $slides.length,
        String($('#homeDots .home-carousel__dot').length));
    // 点到项目管理那一页
    var idx = names.indexOf('项目管理');
    $('#homeDots .home-carousel__dot').eq(idx).trigger('click');
    check('切到项目管理页后 transform 正确',
        $('#homeTrack').attr('style').indexOf('translateX(-' + (idx * 100) + '%)') >= 0,
        $('#homeTrack').attr('style'));
}, 500);
