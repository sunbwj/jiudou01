/* 临时探针：验证 api.js 的 project / projectfile Mock 通道 */
'use strict';
var fs = require('fs');
var path = require('path');
var JSDOM = require('jsdom').JSDOM;
var ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

var dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1:8808/project.html', runScripts: 'outside-only', pretendToBeVisual: true
});
var win = dom.window;
win.eval(read('vendor/jquery-3.7.1.min.js'));
win.jQuery.ajax = function () { var d = win.jQuery.Deferred(); d.reject({}, 'error', ''); return d.promise(); };
win.eval(read('js/api.js'));
var Api = win.Api;

function show(name, ok, extra) {
    console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (extra ? '  ' + extra : ''));
}
var steps = [];
function step(fn) { steps.push(fn); }
function next() {
    var fn = steps.shift();
    if (!fn) { return; }
    fn();
    setTimeout(next, 320);
}

step(function () {
    Api.project.types().done(function (d) {
        show('types 项目类型 9 项', d.types.length === 9, JSON.stringify(d.types));
        show('types 项目状态 5 项', d.statuses.length === 5);
    });
});
step(function () {
    Api.project.nextCode().done(function (d) {
        show('nextcode = PRO000005', d.code === 'PRO000005', d.code);
    });
});
step(function () {
    Api.project.page({ pageNum: 1, pageSize: 10 }).done(function (d) {
        show('无登录态时列表 4 条（不过滤）', d.total === 4, 'total=' + d.total);
        show('首条启用的排最前', d.list[0].enabled === true);
        show('fileCount 统计', d.list[0].fileCount >= 0, JSON.stringify(d.list[0].fileCount));
        show('ispubText', d.list[0].ispubText === '公用' || d.list[0].ispubText === '私有');
    });
});
step(function () {
    // 注入登录态（empId=3），必须在首次 write 之后
    win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({ token: 'mock', user: { empId: 3, nameCn: '我' } }));
    Api.project.page({ pageNum: 1, pageSize: 20 }).done(function (d) {
        var names = d.list.map(function (x) { return x.projectName; }).join('|');
        show('登录后他人私有不可见', d.total === 3 && names.indexOf('他人私有') < 0,
             'total=' + d.total + ' names=' + names);
        show('本人私有 / 他人公用仍可见', names.indexOf('内部测试专项') >= 0 && names.indexOf('客户现场实施') >= 0);
    });
});
step(function () {
    Api.projectFile.page({ pageNum: 1, pageSize: 20 }).done(function (d) {
        var names = d.list.map(function (x) { return x.fileName; }).join('|');
        show('文件列表 3 条（本人 2 + 他人公用 1）', d.total === 3, 'total=' + d.total);
        show('fileSizeText / downloadUrl', !!d.list[0].fileSizeText && !!d.list[0].downloadUrl,
             d.list[0].fileSizeText + ' ' + d.list[0].downloadUrl);
        show('stats', !!d.stats && d.stats['文档'] === 1, JSON.stringify(d.stats));
    });
});
step(function () {
    Api.project.add({ projectName: '__mock_probe__', projectType: '研发', projectStatus: '进行中',
                      ispub: 0, projectDesc: '探针' }).done(function (d) {
        show('add 自动生成编号', d.projectCode === 'PRO000005', d.projectCode);
        show('add 创建人 = 当前登录员工', d.createempinfosid === 3, String(d.createempinfosid));
        win.__probeProjectId = d.id;
    }).fail(function (e) { show('add 失败', false, e.message); });
});
step(function () {
    Api.projectFile.upload({ projectId: win.__probeProjectId, fileName: '摘要.txt',
                             fileType: '文档', fileDesc: '探针', ispub: 0,
                             data: 'data:text/plain;base64,' + Buffer.from('hello').toString('base64') })
        .done(function (d) {
            show('upload 返回 filePath', /^data\/projectfiles\//.test(d.filePath), d.filePath);
            show('upload 项目快照', d.projectCode === 'PRO000005' && d.projectName === '__mock_probe__');
            show('upload 上传人 = 3', d.uploadempinfosid === 3);
            win.__probeFileId = d.id;
        }).fail(function (e) { show('upload 失败', false, e.message); });
});
step(function () {
    Api.projectFile.download(win.__probeFileId).done(function (d) {
        show('download 返回 url', !!d.downloadUrl && !!d.message);
    }).fail(function (e) { show('download 失败', false, e.message); });
});
step(function () {
    Api.projectFile.setEnabled(win.__probeFileId, false).done(function () {
        Api.projectFile.download(win.__probeFileId).fail(function (e) {
            show('停用后 download 被拒', e.message.indexOf('停用') >= 0, e.message);
        });
    });
});
step(function () {
    Api.project.remove(win.__probeProjectId).done(function (d) {
        show('删除项目级联清理 1 个文件', d.deletedFiles === 1, JSON.stringify(d.deletedFiles));
        Api.projectFile.page({ pageNum: 1, pageSize: 20 }).done(function (r) {
            show('级联后文件列表回到 3 条', r.total === 3, 'total=' + r.total);
        });
    });
});
next();
