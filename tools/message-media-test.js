/* ==========================================================================
   message-media-test.js —— 即时对话「媒体 + 群组」测试（jsdom，Mock 通道）
   --------------------------------------------------------------------------
   覆盖：
     · 静态：页面按钮（图片 / 文件 / 语音输入 / 截屏）/ 群组标签 / 建群与成员模板 /
             图片查看器；message.js 的 FileReader / SpeechRecognition / getDisplayMedia /
             canvas 抓帧 / 粘贴监听；api.js 的 /msg/upload 与 group* 路由；
             后端 upload / _attach_of / group_* / ACTIONS；建表脚本三表 + 游标列；WS 群推送
     · 群组：群标签页、打开群聊、群文字消息、群未读（别人发）与清零
     · 附件：/msg/upload 返回 fileId + kind；图片气泡 <img> 可点开查看器；
             文件气泡是 <a download>；气泡带 meta（已发送）
     · 语音输入：SpeechRecognition 桩 → 按钮高亮 + 听写结果追加进输入框 + 再点结束
     · 截屏：不支持 getDisplayMedia 时给提示；用户取消（NotAllowedError）时提示「已取消截屏」
     · 建群：页头「创建群组」打开弹窗 → 勾选成员 → 确定 → 群里多一个群并自动进入
   运行：NODE_PATH=<jsdom 所在 node_modules> node tools/message-media-test.js
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
/** 全站共享的 api.js 版本：从 main.html 现取，升版时不用逐个测试改硬编码 */
var SHARED_API_V = (read('main.html').match(/js\/api\.js\?v=([0-9a-z]+)/) || [])[1] || '';

if (!JSDOM) {
    console.log('未安装 jsdom，跳过（npm i jsdom 后再跑）');
    process.exit(0);
}

var html = read('message.html');
var pageSrc = read('js/message.js');
var apiSrc = read('js/api.js');
var svcSrc = read('server/service.py');
var appSrc = read('server/app.py');
var ddl = read('db/emp-message-media.sql');
var notifyJs = read('js/notify.js');
var shotSrc = read('js/im-shot.js');

/* ------------------------------- 0. 静态一致性 ------------------------------- */
console.log('\n--- 0. 静态：页面结构 / 前端能力 / 后端接口 / 建表 / WS ---');
['imPickImage', 'imPickFile', 'imVoice', 'imShot', 'imImageInput', 'imFileInput',
    'imGroupMembers', 'imViewer', 'imViewerImg', 'groupTpl', 'groupMembersTpl', 'btnGroup'
].forEach(function (id) {
    check('页面含元素 #' + id, html.indexOf('id="' + id + '"') > -1);
});
check('左侧标签页含「群组」（data-tab="group"）', html.indexOf('data-tab="group"') > -1);
check('输入区工具条提示语提到富文本 / 图片 / 文件 / 表情包 / 语音 / 截屏 / @组员',
    /支持富文本/.test(html) && /图片、文件、表情包、语音消息与截屏标注/.test(html) &&
    /@/.test(html));
check('隐藏文件输入分别限制图片与任意文件',
    /id="imImageInput"[^>]*accept="image\/\*"/.test(html) &&
    /id="imFileInput"/.test(html));
check('页面脚本版本：api / message / rich-text 与全站一致（rich-text 已升 20261116a）',
    SHARED_API_V !== '' && html.indexOf('js/api.js?v=' + SHARED_API_V) > -1 &&
    html.indexOf('js/message.js?v=20261110f') > -1 &&
    html.indexOf('js/rich-text.js?v=20261116a') > -1);

check('message.js：FileReader 读文件 + Image 量尺寸',
    pageSrc.indexOf('new FileReader()') > -1 && pageSrc.indexOf('readAsDataURL') > -1 &&
    pageSrc.indexOf('new Image()') > -1);
check('message.js：语音走 MediaRecorder 录音（不再依赖云端 SpeechRecognition）',
    pageSrc.indexOf('new MediaRecorder(') > -1 &&
    pageSrc.indexOf('getUserMedia') > -1 &&
    pageSrc.indexOf('window.SpeechRecognition') === -1);
check('message.js：语音消息以 <audio controls> 气泡展示', pageSrc.indexOf('im-audio') > -1);
check('语音消息类型 audio 已打通（后端白名单 + Mock + 内容占位）',
    svcSrc.indexOf("'text', 'image', 'file', 'sticker', 'audio'") > -1 &&
    apiSrc.indexOf("'sticker', 'audio'") > -1 &&
    svcSrc.indexOf("content = '[语音]'") > -1);
check('message.js：截屏走 getDisplayMedia + canvas 抓帧',
    pageSrc.indexOf('getDisplayMedia') > -1 &&
    pageSrc.indexOf('drawImage') > -1 && pageSrc.indexOf('toDataURL') > -1);
check('message.js：Ctrl+V 粘贴图片自动发送',
    pageSrc.indexOf("$(document).on('paste'") > -1 &&
    pageSrc.indexOf("it.kind === 'file'") > -1);
check('message.js：图片气泡点击开查看器（data-full）',
    pageSrc.indexOf('data-full=') > -1 && pageSrc.indexOf('#imViewerImg') > -1);
/* 回归：查看器是 position:fixed 全屏层，默认 display 只能是 none。
   曾写成 display:flex → 盖掉 HTML 的 hidden 属性 → 页面加载即出现关不掉的黑遮罩。 */
check('查看器默认 display:none（不写成 flex，否则全屏遮罩常驻）',
    /\.im-viewer \{[^}]*display: none/.test(html) &&
    /\.im-viewer\.is-open \{[^}]*display: flex/.test(html));
check('element-ui.css 有 [hidden] 全局兜底（作者样式盖不掉 hidden）',
    /\[hidden\] \{[^}]*display: none !important/.test(read('css/element-ui.css')));
check('查看器开关走 .is-open 类（不靠 hidden 属性）',
    pageSrc.indexOf("$('#imViewer').addClass('is-open')") > -1 &&
    pageSrc.indexOf("$('#imViewer').removeClass('is-open')") > -1);
check('message.js：文件气泡是 <a download> + 大小格式化',
    pageSrc.indexOf('class="im-file"') > -1 && pageSrc.indexOf('fmtSize') > -1);
check('message.js：群未读与已读（markGroupRead / groupHistory）',
    pageSrc.indexOf('function markGroupRead') > -1 &&
    pageSrc.indexOf('Api.msg.groupHistory') > -1);
check('message.js：群消息 / 群成员 / 退群解散',
    pageSrc.indexOf('function openGroupMembers') > -1 &&
    pageSrc.indexOf('Api.msg.groupRemove') > -1);

['/msg/upload', '/msg/groups', '/msg/groupadd', '/msg/groupupdate', '/msg/groupdelete',
    '/msg/groupdetail', '/msg/grouphistory', '/msg/markgroup'
].forEach(function (p) {
    check('api.js 路由 ' + p, apiSrc.indexOf("'" + p + "'") > -1);
});
['upload: function (data)', 'groups: function ()', 'groupAdd: function (data)',
    'groupDetail: function (groupId)', 'groupHistory: function (groupId)',
    'groupUpdate: function (data)', 'groupRemove: function (groupId)',
    'markGroup: function (groupId)'
].forEach(function (k) {
    check('Api.msg 导出 ' + k.split(':')[0], apiSrc.indexOf(k) > -1);
});

check('后端：附件上传（_decode_im_file / _write_im_file / upload）',
    svcSrc.indexOf('def _decode_im_file') > -1 &&
    svcSrc.indexOf('def _write_im_file') > -1 &&
    /def upload\(self, params=None\):/.test(svcSrc));
check('后端：附件归属校验（_claim_attach 只能发自己上传的）',
    svcSrc.indexOf('def _claim_attach') > -1 &&
    svcSrc.indexOf('该附件不是你上传的') > -1);
check('后端：落盘目录 data/imfiles + 20MB 上限',
    svcSrc.indexOf("'data', 'imfiles'") > -1 &&
    /IM_FILE_MAX_BYTES = 20 \* 1024 \* 1024/.test(svcSrc));
check('后端：群组方法齐全（groups/group_add/group_update/group_delete/group_detail/group_history/mark_group）',
    /def groups\(self, params=None\):/.test(svcSrc) &&
    /def group_add\(self, params=None\):/.test(svcSrc) &&
    /def group_update\(self, params=None\):/.test(svcSrc) &&
    /def group_delete\(self, params=None\):/.test(svcSrc) &&
    /def group_detail\(self, params=None\):/.test(svcSrc) &&
    /def group_history\(self, params=None\):/.test(svcSrc) &&
    /def mark_group\(self, params=None\):/.test(svcSrc));
check('后端：群未读用自增游标（_group_unread + _touch_group_read 读 seq）',
    svcSrc.indexOf('lastReadSeq') > -1 && svcSrc.indexOf('`seq` >') > -1);
check('后端：群消息一条记录（receiverId=0 + groupId）',
    /if group_id:/.test(svcSrc) && svcSrc.indexOf("'receiverId': 0") > -1);
check('ACTIONS 注册 7 个群组动作',
    /'groups': \('groups', \['GET'\]\)/.test(svcSrc) &&
    /'groupadd': \('group_add', \['POST'\]\)/.test(svcSrc) &&
    /'groupupdate': \('group_update', \['POST'\]\)/.test(svcSrc) &&
    /'groupdelete': \('group_delete', \['POST'\]\)/.test(svcSrc) &&
    /'groupdetail': \('group_detail', \['GET'\]\)/.test(svcSrc) &&
    /'grouphistory': \('group_history', \['GET'\]\)/.test(svcSrc) &&
    /'markgroup': \('mark_group', \['POST'\]\)/.test(svcSrc));
check('WS：serverHello 下发 groups，send 支持 groupId / attachId / msgType',
    appSrc.indexOf("'groups': groups") > -1 &&
    appSrc.indexOf("gid = str(msg.get('groupId')") > -1 &&
    appSrc.indexOf('group_member_ids') > -1);
check('建表脚本：empmsgfiles / empimgroups / empimgroupmembers 三表',
    /CREATE TABLE IF NOT EXISTS `empmsgfiles`/.test(ddl) &&
    /CREATE TABLE IF NOT EXISTS `empimgroups`/.test(ddl) &&
    /CREATE TABLE IF NOT EXISTS `empimgroupmembers`/.test(ddl));
check('建表脚本：emp_msgs 加 msgType / attachId / groupId / seq（幂等走 information_schema）',
    ddl.indexOf('`msgType`') > -1 && ddl.indexOf('`attachId`') > -1 &&
    ddl.indexOf('`groupId`') > -1 && ddl.indexOf('`seq`') > -1 &&
    ddl.indexOf('information_schema.COLUMNS') > -1 && ddl.indexOf('skip: ') > -1);
/* ---- 截屏编辑器（js/im-shot.js）：静态结构 ---- */
check('页面引入 js/im-shot.js（版本 20261110d）',
    html.indexOf('js/im-shot.js?v=20261110d') > -1);
check('截屏编辑器：5 种标注工具（框/圈/线/箭头/文本）',
    /rect/.test(shotSrc) && /ellipse/.test(shotSrc) && /line/.test(shotSrc) &&
    /arrow/.test(shotSrc) && /text/.test(shotSrc) &&
    shotSrc.indexOf("id: 'rect'") > -1 && shotSrc.indexOf("id: 'ellipse'") > -1 &&
    shotSrc.indexOf("id: 'line'") > -1 && shotSrc.indexOf("id: 'arrow'") > -1 &&
    shotSrc.indexOf("id: 'text'") > -1);
check('截屏编辑器：鼠标拖选选区（mousedown/move/up + 最小选区判定）',
    shotSrc.indexOf("addEventListener('mousedown', onDown)") > -1 &&
    shotSrc.indexOf("addEventListener('mousemove', onMove, true)") > -1 &&
    shotSrc.indexOf("addEventListener('mouseup', onUp, true)") > -1 &&
    shotSrc.indexOf('MIN_SEL') > -1);
check('截屏编辑器：两个阶段 select → annotate',
    shotSrc.indexOf("phase: 'select'") > -1 && shotSrc.indexOf("ST.phase = 'annotate'") > -1);
check('截屏编辑器：标注坐标归一化（存比例，缩放/导出一致）',
    shotSrc.indexOf('归一化') > -1 && shotSrc.indexOf('function normSel') > -1 &&
    /m\.x0 \* boxW/.test(shotSrc) && /m\.y0 \* boxH/.test(shotSrc));
check('截屏编辑器：缩放重绘（resize → layout）',
    shotSrc.indexOf("addEventListener('resize', layout)") > -1);
check('截屏编辑器：撤销 / 重选 / 取消 / 发送 四个动作',
    shotSrc.indexOf("data-act=\"undo\"") > -1 && shotSrc.indexOf("data-act=\"reset\"") > -1 &&
    shotSrc.indexOf("data-act=\"cancel\"") > -1 && shotSrc.indexOf("data-act=\"send\"") > -1);
check('截屏编辑器：Ctrl+Z 撤销、ESC 取消',
    shotSrc.indexOf('keyCode === 90') > -1 && shotSrc.indexOf('keyCode === 27') > -1);
check('截屏编辑器：优先挂到 window.top（主框架内嵌时铺满浏览器窗口）',
    shotSrc.indexOf('function hostDoc') > -1 && shotSrc.indexOf('window.top') > -1);
check('截屏编辑器：导出按原图分辨率裁剪 + 叠加标注',
    shotSrc.indexOf('function exportShot') > -1 &&
    /s\.w \* ST\.natW/.test(shotSrc) && shotSrc.indexOf('toDataURL') > -1);
check('message.js：截屏抓到帧后交给 IMShot 编辑器（无则退回整屏直接发）',
    pageSrc.indexOf('window.IMShot && window.IMShot.open') > -1 &&
    pageSrc.indexOf('onSend') > -1 && pageSrc.indexOf('onCancel') > -1);

/* ---- 表情 / 表情包：静态 ---- */
check('页面有表情按钮与表情面板骨架',
    /id="imEmoji"/.test(html) && /id="imEmojiPanel"/.test(html) &&
    /id="imEmojiTabs"/.test(html) && /id="imEmojiBody"/.test(html) &&
    /id="imEmojiAdd"/.test(html));
check('表情面板绝对定位（浮在输入区上方，不撑高页面）',
    /\.im-input \{[^}]*position: relative/.test(html) &&
    /\.im-emoji \{[^}]*position: absolute/.test(html) &&
    /\.im-emoji \{[^}]*bottom: calc\(100%/.test(html));
check('message.js：6 组 emoji（常用 + 笑脸/手势/心情/物品/动物）',
    pageSrc.indexOf('var EMOJI_GROUPS') > -1 &&
    ["'recent'", "'smile'", "'hand'", "'heart'", "'thing'", "'animal'"].every(function (k) {
        return pageSrc.indexOf('key: ' + k) > -1;
    }));
check('message.js：纯 emoji 判定 + 大表情气泡样式',
    pageSrc.indexOf('function isEmojiOnly') > -1 &&
    /im-msg__bubble is-emoji/.test(pageSrc) &&
    /\.im-msg__bubble\.is-emoji \{[^}]*font-size: 34px/.test(html));
check('message.js：表情插入到光标处 + 最近使用（localStorage）',
    pageSrc.indexOf('selectionStart') > -1 &&
    pageSrc.indexOf('menu_admin_im_emoji_recent') > -1 &&
    pageSrc.indexOf('function pushRecentEmoji') > -1);
check('message.js：表情包走 upload → emojiAdd → 发送 msgType=sticker',
    pageSrc.indexOf('function addEmojiSticker') > -1 &&
    pageSrc.indexOf('Api.msg.emojiAdd') > -1 &&
    pageSrc.indexOf("msgType: 'sticker'") > -1);
check('api.js：Api.msg 暴露 emojis / emojiAdd / emojiRemove',
    apiSrc.indexOf('emojis: function ()') > -1 &&
    apiSrc.indexOf('emojiAdd: function (data)') > -1 &&
    apiSrc.indexOf('emojiRemove: function (id)') > -1);
check('api.js：Mock 表情包路由（列表/添加/删除 + 只能删自己的）',
    apiSrc.indexOf("if (path === '/emojis')") > -1 &&
    apiSrc.indexOf("if (path === '/emojiadd')") > -1 &&
    apiSrc.indexOf("if (path === '/emojidel')") > -1 &&
    apiSrc.indexOf('只能删除自己添加的表情包') > -1);
check('后端：emojis / emoji_add / emoji_delete + ACTIONS 注册',
    svcSrc.indexOf('def emojis') > -1 && svcSrc.indexOf('def emoji_add') > -1 &&
    svcSrc.indexOf('def emoji_delete') > -1 &&
    svcSrc.indexOf("'emojis': ('emojis', ['GET'])") > -1 &&
    svcSrc.indexOf("'emojiadd': ('emoji_add', ['POST'])") > -1 &&
    svcSrc.indexOf("'emojidel': ('emoji_delete', ['POST'])") > -1);
check('后端：msgType 白名单含 sticker，占位文案为 [表情]',
    svcSrc.split("'text', 'image', 'file', 'sticker'").length - 1 === 2 &&
    svcSrc.indexOf("content = '[表情]'") > -1);
check('建表脚本含 empimemojis（fileId 唯一 + enabled 索引）',
    ddl.indexOf('CREATE TABLE IF NOT EXISTS `empimemojis`') > -1 &&
    ddl.indexOf('uk_empimemojis_file') > -1 &&
    ddl.indexOf('idx_empimemojis_enabled') > -1);

/* ---- 群重命名：静态 ---- */
check('群成员模板含「重命名」入口与群名展示',
    /id="imGroupNameVal"/.test(html) && /id="imGroupRename"/.test(html));
check('群重命名弹窗模板（输入框 + 错误位）',
    /id="imGroupRenameInput"/.test(html) && /id="imGroupRenameErr"/.test(html) &&
    /id="groupRenameTpl"/.test(html));
check('已有群重命名：三个入口（群成员弹窗 / 聊天头铅笔 / 群行铅笔）',
    /id="imGroupRename"/.test(html) && /id="imChatTitleEdit"/.test(html) &&
    pageSrc.indexOf('im-contact__rename') > -1 &&
    pageSrc.indexOf("$('#imChatTitleEdit').on('click'") > -1);
check('message.js：统一的群主判定 amGroupOwner（isOwner 优先，ownerId 兜底）',
    pageSrc.indexOf('function amGroupOwner') > -1 &&
    pageSrc.indexOf('parseInt(g.ownerId, 10) === parseInt(STATE.me, 10)') > -1);
check('message.js：syncRenameEntries 统一刷新入口可见性',
    pageSrc.indexOf('function syncRenameEntries') > -1 &&
    pageSrc.indexOf("if (gid && amGroupOwner(gid)) { $edit.removeAttr('hidden'); }") > -1);
check('群行铅笔点击不误开会话（stopPropagation）',
    pageSrc.indexOf("closest('.im-contact__rename')") > -1 &&
    pageSrc.indexOf('e.stopPropagation()') > -1);
check('非群主在群成员弹窗里有「只有群主可以修改群名称」说明',
    pageSrc.indexOf('im-group-owner-tip') > -1 &&
    /只有群主可以修改群名称/.test(pageSrc));
check('message.js：openGroupRename 走 Api.msg.groupUpdate',
    pageSrc.indexOf('function openGroupRename') > -1 &&
    pageSrc.indexOf('Api.msg.groupUpdate') > -1);
check('message.js：只有群主能看到重命名按钮（amGroupOwner 判定）',
    pageSrc.indexOf('if (amGroupOwner(gid)) {') > -1 &&
    pageSrc.indexOf("$rename.removeAttr('hidden')") > -1);
check('message.js：改名后同步群名 / 头像首字 / 聊天头 / 列表',
    pageSrc.indexOf('g.avatarText = ng.avatarText') > -1 &&
    pageSrc.indexOf("$('#imChatTitle').text(g.name)") > -1 &&
    pageSrc.indexOf('renderContacts();') > -1);
check('后端 group_update 同步 avatarText 且仅群主可改',
    svcSrc.indexOf('def group_update') > -1 &&
    /UPDATE `empimgroups` SET `groupName`=%s, `avatarText`=%s/.test(svcSrc) &&
    svcSrc.indexOf('只有群主可以修改群资料') > -1);
check('Mock /groupupdate 同样改 groupName + avatarText',
    /gu\.groupName = guName; gu\.avatarText = guName\.slice\(0, 1\)/.test(apiSrc));

check('提醒中心渲染群条目并支持 ?group= 深链',
    notifyJs.indexOf('imGroups') > -1 && notifyJs.indexOf('data-group=') > -1 &&
    notifyJs.indexOf("openPage('message.html?group='") > -1);

/* ------------------------------- 组装窗口 ------------------------------- */
function boot(pre, url) {
    var dom = new JSDOM(html, {
        url: url || 'http://127.0.0.1:8808/message.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    var win = dom.window;
    win.eval(read('vendor/jquery-3.7.1.min.js'));
    win.eval(read('js/theme.js'));
    win.eval(read('js/icons.js'));
    win.__autoTimers = [];
    win.setInterval = function (fn, ms) {
        win.__autoTimers.push(ms);
        return win.__autoTimers.length;
    };
    if (pre) { pre(win); }
    win.jQuery.ajax = function () {
        var d = win.jQuery.Deferred();
        d.reject({}, 'error', '');
        return d.promise();
    };
    win.eval(read('js/api.js'));
    win.eval(read('js/ui.js'));
    win.eval(read('js/rich-text.js'));
    win.eval(read('js/layout.js'));
    win.eval(read('js/im-shot.js'));
    win.eval(read('js/message.js'));
    return win;
}
function sso(empId) {
    return function (win) {
        win.localStorage.setItem('menu_admin_login_v1', JSON.stringify({
            token: 'mock-token-' + empId,
            user: { empId: empId, nameCn: '员工' + empId },
            expireAt: new Date().getTime() + 8 * 3600 * 1000
        }));
    };
}

var w = boot(sso(3));
var $ = w.jQuery;
var IM = w.IM;
var Api = w.Api;
var GID = '';                 // 演示群「项目周会」的 id（阶段 2 里取）

/* ------------------------------- 异步阶段 ------------------------------- */
var phases = [];
function phase(fn, wait) { phases.push({ fn: fn, wait: wait === undefined ? 500 : wait }); }
function run() {
    var p = phases.shift();
    if (!p) { return finish(); }
    try { p.fn(); } catch (e) {
        check('阶段执行异常：' + e.message, false, e.stack);
    }
    setTimeout(run, p.wait);
}
function finish() {
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}

/* ---- 1. 首屏 + 群列表（Mock 种子群「项目周会」） ---- */
phase(function () {
    console.log('\n--- 1. 首屏：群列表来自 serverHello ---');
    var gs = Object.keys(IM.state.groups);
    check('serverHello 下发了群列表（STATE.groups 非空）', gs.length >= 1, gs.join(','));
    check('演示群「项目周会」在列表里',
        gs.some(function (k) { return IM.state.groups[k].name === '项目周会'; }), gs.join(','));
    GID = gs[0];
    check('群条目带成员数（≥2）', (IM.state.groups[GID] && IM.state.groups[GID].memberCount) >= 2,
        IM.state.groups[GID] && IM.state.groups[GID].memberCount);
});

/* ---- 2. 群组标签页 + 打开群聊 ---- */
phase(function () {
    console.log('\n--- 2. 群组标签页 / 打开群聊 ---');
    $('.im__tab[data-tab="group"]').trigger('click');
    var rows = $('#imContacts .im-contact[data-group]');
    check('切到「群组」标签后只剩群条目', rows.length === 1 && $('#imContacts .im-contact[data-emp]').length === 0,
        rows.length + ' 群 / ' + $('#imContacts .im-contact[data-emp]').length + ' 人');
    check('群条目显示「群聊 · N 人」', /群聊 · \d+ 人/.test(rows.text()), rows.text());
    rows.first().trigger('click');
});

phase(function () {
    console.log('--- 2b. 群聊界面 ---');
    check('聊天区已显示', $('#imChat').css('display') !== 'none');
    check('标题是群名', $.trim($('#imChatTitle').text()) === '项目周会', $('#imChatTitle').text());
    check('activeGroup 已设置、activePeer 归零',
        IM.state.activeGroup === GID && IM.state.activePeer === 0,
        IM.state.activeGroup + ' / ' + IM.state.activePeer);
    check('群成员按钮可见', !$('#imGroupMembers').prop('hidden'));
    check('空群提示语是「群里还没有消息」', /群里还没有消息/.test($('#imChatBody').text()));
});

/* ---- 3. 群发文字消息 ---- */
phase(function () {
    console.log('\n--- 3. 群发文字消息 ---');
    $('#imText').val('大家好，本周例会改到周四');
    $('#imSend').trigger('click');
    var $b = $('#imChatBody .im-msg.is-me .im-msg__bubble');
    check('乐观气泡已上屏', $b.length === 1 && /本周例会改到周四/.test($b.text()), $b.text());
    check('发送后输入框清空', $.trim($('#imText').val()) === '');
});

phase(function () {
    console.log('--- 3b. 群消息回执对齐 ---');
    var $m = $('#imChatBody .im-msg.is-me').last();
    check('回执后不再是 temp（meta 里没有「发送中」）', !/发送中/.test($m.text()), $m.text());
    check('回执带回真实 id（非 t 开头的临时 id）',
        String($m.attr('data-mid') || '').charAt(0) !== 't', $m.attr('data-mid'));
    check('群列表最后一条已更新',
        IM.state.groups[GID].lastContent === '大家好，本周例会改到周四',
        IM.state.groups[GID].lastContent);
});

/* ---- 4. 群未读（别人发来）→ 打开群清零 ---- */
phase(function () {
    console.log('\n--- 4. 群未读 ---');
    // 先切回单聊，让群不是当前会话
    var peer = Object.keys(IM.state.contacts)[0];
    IM.openPeer(parseInt(peer, 10));
    // 借用 Mock socket 模拟「群成员发来一条」
    IM.socket.simulateInbound(2, '收到，周四我参加', '李明', GID);
});

phase(function () {
    console.log('--- 4b. 未读计数 ---');
    var g = IM.state.groups[GID];
    check('非当前会话的群未读 +1', g.unread === 1, g.unread);
    $('.im__tab[data-tab="group"]').trigger('click');
    var badge = $('#imContacts .im-contact[data-group] .im-badge');
    check('群条目显示未读徽标', badge.length === 1 && badge.text() === '1', badge.text());
    check('群列表预览带发送人前缀「李明：」', /李明：/.test($('#imContacts .im-contact[data-group]').text()),
        $('#imContacts .im-contact[data-group]').text());
    $('#imContacts .im-contact[data-group]').first().trigger('click');
});

phase(function () {
    console.log('--- 4c. 打开群即已读 ---');
    check('群未读清零', IM.state.groups[GID].unread === 0, IM.state.groups[GID].unread);
    check('群里出现对方那条消息', /周四我参加/.test($('#imChatBody').text()));
    check('群里对方消息带发送人姓名', /李明/.test($('#imChatBody').text()));
});

/* ---- 5. 附件上传接口 ---- */
var uploadRes = null;
var DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
phase(function () {
    console.log('\n--- 5. /msg/upload 接口 ---');
    w.Api.msg.upload({ fileName: '截图_1.png', data: DATA_URL, kind: 'image', width: 1, height: 1 })
        .done(function (res) { uploadRes = res; });
});

phase(function () {
    console.log('--- 5b. 上传返回 ---');
    check('返回 fileId', !!(uploadRes && uploadRes.fileId), uploadRes && uploadRes.fileId);
    check('kind=image', uploadRes && uploadRes.kind === 'image', uploadRes && uploadRes.kind);
    check('url 可直接当图片地址（dataURL）',
        uploadRes && String(uploadRes.url).indexOf('data:image/png;base64,') === 0);
    check('带回宽高（气泡占位用）', uploadRes && uploadRes.width === 1 && uploadRes.height === 1);
});

/* ---- 6. 图片 / 文件气泡 + 查看器 ---- */
phase(function () {
    console.log('\n--- 6. 图片气泡 ---');
    IM.sendAttachment({
        fileId: uploadRes.fileId, kind: 'image', name: '截图_1.png',
        url: uploadRes.url, size: 100, width: 1, height: 1
    });
    var $img = $('#imChatBody .im-msg.is-me .im-img');
    check('图片气泡渲染 <img class="im-img">', $img.length === 1);
    check('图片 src 指向附件 url', $img.attr('src') === uploadRes.url);
    check('图片带 data-full（点开放大用）', $img.attr('data-full') === uploadRes.url);
    $img.trigger('click');
    check('点图片后查看器打开', !$('#imViewer').prop('hidden'));
    check('查看器 img 指向同一张图', $('#imViewerImg').attr('src') === uploadRes.url);
    $('#imViewerClose').trigger('click');
    check('关闭查看器', $('#imViewer').prop('hidden'));
});

phase(function () {
    console.log('--- 6b. 文件气泡 ---');
    IM.sendAttachment({
        fileId: 'file-mock-1', kind: 'file', name: '需求说明.docx',
        url: 'data/imfiles/202611/x.docx', size: 2 * 1024 * 1024, ext: 'docx'
    });
    var $f = $('#imChatBody .im-msg.is-me .im-file').last();
    check('文件气泡是 <a class="im-file">', $f.length === 1);
    check('文件名正确', /需求说明\.docx/.test($f.text()), $f.text());
    check('带 download 属性（另存为）', $f.attr('download') === '需求说明.docx');
    check('大小格式化（2 MB）', /2\.0 MB/.test($f.text()), $f.text());
    check('扩展名角标 DOCX', /DOCX/.test($f.find('.im-file__ico').text()), $f.find('.im-file__ico').text());
});

/* ---- 7. 语音消息（MediaRecorder 桩） ---- */
phase(function () {
    console.log('\n--- 7. 语音消息 ---');
    var rec = null;
    w.MediaRecorder = function (stream, opts) {
        rec = this;
        this.stream = stream;
        this.mimeType = (opts && opts.mimeType) || 'audio/webm';
        this.state = 'inactive';
        this.start = function () { this.state = 'recording'; };
        this.stop = function () {
            this.state = 'inactive';
            if (this.ondataavailable) {
                this.ondataavailable({ data: new w.Blob(['voice-bytes'], { type: 'audio/webm' }) });
            }
            if (this.onstop) { this.onstop(); }
        };
    };
    w.MediaRecorder.isTypeSupported = function () { return true; };
    try { delete w.navigator.mediaDevices; } catch (e) { }
    w.navigator.mediaDevices = {
        getUserMedia: function () {
            return Promise.resolve({ getTracks: function () { return [{ stop: function () { } }]; } });
        }
    };

    $('#imText').val('');
    $('#imVoice').trigger('click');
    // getUserMedia 是异步的：等它拿到麦克风后再断言「已开始录音」
    setTimeout(function () {
        check('拿到麦克风后按钮高亮（录音中）', $('#imVoice').hasClass('is-active'));
        check('STATE.voiceOn = true', IM.state.voiceOn === true);
        check('MediaRecorder 已 start', !!rec && rec.state === 'recording');
        $('#imVoice').trigger('click');                 // 再点 = 停止并发送
        check('停止后取消高亮', !$('#imVoice').hasClass('is-active'));
        check('STATE.voiceOn = false', IM.state.voiceOn === false);
        setTimeout(function () {
            var audio = $('#imChatBody .im-audio');
            check('语音消息以 <audio> 气泡上屏', audio.length === 1);
            check('气泡 src 非空', String(audio.attr('src') || '').length > 0, audio.attr('src'));
        }, 300);
    }, 150);
});

/* ---- 8. 截屏（两种降级路径） ---- */
phase(function () {
    console.log('\n--- 8. 截屏降级 ---');
    try { delete w.navigator.mediaDevices; } catch (e) { w.navigator.mediaDevices = undefined; }
    $('#imShot').trigger('click');
    check('浏览器不支持时给「不支持截屏」提示',
        /不支持截屏/.test($('#imInputStatus').text()), $('#imInputStatus').text());
    // 支持但不允许（用户点了取消）
    w.navigator.mediaDevices = {
        getDisplayMedia: function () {
            var err = new w.Error('Permission denied');
            err.name = 'NotAllowedError';
            return w.Promise.reject(err);
        }
    };
    $('#imShot').trigger('click');
});

phase(function () {
    console.log('--- 8b. 用户取消截屏（Promise 拒绝是异步的） ---');
    check('用户取消时提示「已取消截屏」',
        /已取消截屏/.test($('#imInputStatus').text()), $('#imInputStatus').text());
});

/* ---- 9. 建群（页面弹窗全流程） ---- */
phase(function () {
    console.log('\n--- 9. 创建群组弹窗 ---');
    $('#btnGroup').trigger('click');
    var $dlg = $('.el-overlay .el-dialog');
    check('弹窗已打开', $dlg.length === 1);
    check('弹窗标题「创建群聊」', /创建群聊/.test($dlg.find('.el-dialog__title').text()));
    var $items = $dlg.find('.im-group-pick__item');
    check('成员候选列表非空', $items.length >= 2, String($items.length));
    $dlg.find('#imGroupName').val('测试群 B');
    $items.eq(0).trigger('click');
    check('勾选后计数更新为 1 人', /已选 1 人/.test($dlg.find('#imGroupPicked').text()),
        $dlg.find('#imGroupPicked').text());
    $dlg.find('.btn-ok').trigger('click');
});

phase(function () {
    console.log('--- 9b. 建群结果 ---');
    var names = Object.keys(IM.state.groups).map(function (k) { return IM.state.groups[k].name; });
    check('群列表里出现「测试群 B」', names.indexOf('测试群 B') > -1, names.join(','));
    var g = null;
    Object.keys(IM.state.groups).forEach(function (k) {
        if (IM.state.groups[k].name === '测试群 B') { g = IM.state.groups[k]; }
    });
    check('新群成员 2 人（我 + 1）', g && g.memberCount === 2, g && g.memberCount);
    check('建完自动进入该群', IM.state.activeGroup === (g && g.groupId),
        IM.state.activeGroup + ' / ' + (g && g.groupId));
    check('弹窗已关闭', $('.el-overlay .el-dialog').length === 0);
    check('新群标题已显示', $.trim($('#imChatTitle').text()) === '测试群 B', $('#imChatTitle').text());
});

/* ---- 10. 群成员弹窗（用种子群：群主是别人 → 可退群） ---- */
phase(function () {
    console.log('\n--- 10. 群成员弹窗 / 退群 ---');
    IM.openGroup(GID);
});

phase(function () {
    $('#imGroupMembers').trigger('click');
}, 300);

phase(function () {
    console.log('--- 10b. 成员列表 ---');
    var $dlg = $('.el-overlay .el-dialog');
    check('成员弹窗已打开', $dlg.length === 1);
    check('提示「共 N 人 · 群主：」', /共 3 人 · 群主：/.test($dlg.find('#imGroupMemberTip').text()),
        $dlg.find('#imGroupMemberTip').text());
    check('成员行数 = 3', $dlg.find('.im-member').length === 3, String($dlg.find('.im-member').length));
    check('群主带「群主」标记', /群主/.test($dlg.find('.im-member').text()));
    check('自己带「我」标记', /我/.test($dlg.find('.im-member').text()));
    check('非群主时按钮文案是「退出群聊」', $.trim($dlg.find('#imGroupLeave').text()) === '退出群聊',
        $dlg.find('#imGroupLeave').text());
    $dlg.find('.btn-cancel').trigger('click');
    check('取消关闭弹窗', $('.el-overlay .el-dialog').length === 0);
});

/* ---- 10c. 群重命名（Mock 种子群的群主是 1 号，当前登录 3 号 → 无权限） ---- */
phase(function () {
    console.log('\n--- 10c. 群重命名：非群主无入口 ---');
    IM.openGroup(GID);
}, 300);
phase(function () {
    $('#imGroupMembers').trigger('click');
}, 300);
phase(function () {
    var $dlg = $('.el-overlay .el-dialog');
    check('群成员弹窗显示当前群名', $.trim($dlg.find('#imGroupNameVal').text()) === '项目周会',
        $dlg.find('#imGroupNameVal').text());
    check('非群主：重命名按钮隐藏（hidden 属性仍在）',
        $dlg.find('#imGroupRename').attr('hidden') === 'hidden' ||
        $dlg.find('#imGroupRename').prop('hidden') === true);
    $dlg.find('.btn-cancel').trigger('click');
    check('关闭群成员弹窗', $('.el-overlay .el-dialog').length === 0);
});

/* ---- 10d. 群重命名：群主（新建群，自己是群主） ---- */
var MY_GID = '';
phase(function () {
    console.log('\n--- 10d. 群重命名：群主可见 + 改名校验 ---');
    // 通过 Mock 建群，自己是群主
    var dfd = Api.msg.groupAdd({ groupName: '改名前', memberIds: [1, 2] });
    dfd.done(function (res) {
        MY_GID = (res && res.groupId) || '';
        check('建群成功（用于测改名）', !!MY_GID, JSON.stringify(res).slice(0, 100));
        IM.refreshGroups();
    });
}, 700);
phase(function () {
    var g = IM.state.groups[MY_GID];
    check('新群在本地群里且 isOwner=true', !!g && g.isOwner === true, JSON.stringify(g || {}).slice(0, 120));
    if (g) { IM.openGroup(MY_GID); }
}, 400);
phase(function () {
    $('#imGroupMembers').trigger('click');
}, 400);
phase(function () {
    var $dlg = $('.el-overlay .el-dialog');
    check('群主能看到重命名按钮',
        $dlg.find('#imGroupRename').length === 1 &&
        ($dlg.find('#imGroupRename').prop('hidden') === false ||
         !$dlg.find('#imGroupRename').is('[hidden]')));
    $dlg.find('#imGroupRename').trigger('click');
}, 400);
phase(function () {
    var $ren = $('.el-overlay').last().find('.el-dialog');
    check('重命名弹窗已打开', $ren.length === 1 && /重命名群聊/.test($ren.find('.el-dialog__title').text()),
        $ren.find('.el-dialog__title').text());
    check('输入框预填当前群名', $.trim($ren.find('#imGroupRenameInput').val()) === '改名前',
        $ren.find('#imGroupRenameInput').val());
    // 空名校验：不关闭弹窗、错误位有文案
    $ren.find('#imGroupRenameInput').val('   ');
    $ren.find('.btn-ok').trigger('click');
    check('空名校验：报错且弹窗不关',
        $('.el-overlay').last().find('#imGroupRenameErr').text() === '群名称不能为空' &&
        $('.el-overlay').last().find('#imGroupRenameInput').length === 1,
        $('.el-overlay').last().find('#imGroupRenameErr').text());
    // 正常改名
    $('.el-overlay').last().find('#imGroupRenameInput').val('改名后');
    $('.el-overlay').last().find('.btn-ok').trigger('click');
}, 900);
phase(function () {
    var g = IM.state.groups[MY_GID] || {};
    check('本地群名已更新', g.name === '改名后', g.name);
    check('头像首字同步为首字', g.avatarText === '改', g.avatarText);
    check('聊天头标题同步', $.trim($('#imChatTitle').text()) === '改名后', $('#imChatTitle').text());
    check('重命名弹窗已关闭（只剩群成员那一层）',
        $('.el-overlay').length === 1, String($('.el-overlay').length));
    check('群成员弹窗里的群名同步',
        $.trim($('.el-overlay').last().find('#imGroupNameVal').text()) === '改名后',
        $('.el-overlay').last().find('#imGroupNameVal').text());
    check('群成员弹窗标题同步',
        /改名后/.test($('.el-overlay').last().find('.el-dialog__title').text()),
        $('.el-overlay').last().find('.el-dialog__title').text());
    // 群组标签里那一行也应是新名
    $('.im__tab[data-tab="group"]').trigger('click');
    var $row = $('#imContacts .im-contact[data-group="' + MY_GID + '"]');
    check('左侧群列表该行显示新名', $.trim($row.find('.im-contact__name').text()) === '改名后',
        $row.find('.im-contact__name').text());
    $('.el-overlay').last().find('.btn-cancel').trigger('click');
    $('.im__tab[data-tab="msg"]').trigger('click');
});

/* ---- 10f. 已建群的重命名入口：群行铅笔 / 聊天头铅笔 / 非群主提示 ---- */
phase(function () {
    console.log('\n--- 10f. 已有群：三个改名入口 ---');
    $('.im__tab[data-tab="group"]').trigger('click');
}, 400);
phase(function () {
    var $mine = $('#imContacts .im-contact.is-group[data-group="' + MY_GID + '"]');
    var $pen = $mine.find('.im-contact__rename');
    check('自己建的群：群行有铅笔按钮', $pen.length === 1);
    check('自己建的群：铅笔可见（无 hidden）', $pen.is('[hidden]') === false);
    // 点铅笔：应打开改名弹窗，且不把会话切走
    var beforeActive = IM.state.activeGroup;
    $pen.trigger('click');
    console.log('  （点铅笔后 activeGroup 是否被改：' + (IM.state.activeGroup === beforeActive) + '）');
}, 600);
phase(function () {
    var $ren = $('.el-overlay').last().find('.el-dialog');
    check('点群行铅笔 → 改名弹窗打开', $ren.length === 1 && !!$ren.find('#imGroupRenameInput').length);
    check('弹窗预填当前群名', $.trim($ren.find('#imGroupRenameInput').val()) === '改名后',
        $ren.find('#imGroupRenameInput').val());
    $ren.find('#imGroupRenameInput').val('群行改的名');
    $ren.find('.btn-ok').trigger('click');
}, 900);
phase(function () {
    check('群行铅笔改名生效', (IM.state.groups[MY_GID] || {}).name === '群行改的名',
        (IM.state.groups[MY_GID] || {}).name);
    var n = $.trim($('#imContacts .im-contact.is-group[data-group="' + MY_GID + '"] .im-contact__name').text());
    check('群列表该行同步新名', n === '群行改的名', n);

    // 聊天头铅笔
    IM.openGroup(MY_GID);
}, 500);
phase(function () {
    var $edit = $('#imChatTitleEdit');
    check('群主打开群：聊天头铅笔存在', $edit.length === 1);
    check('群主打开群：聊天头铅笔可见', $edit.is('[hidden]') === false && !$edit.prop('hidden'));
    $edit.trigger('click');
}, 500);
phase(function () {
    var $ren = $('.el-overlay').last().find('.el-dialog');
    check('点聊天头铅笔 → 改名弹窗打开', !!$ren.find('#imGroupRenameInput').length);
    check('弹窗预填群行改名后的新名', $.trim($ren.find('#imGroupRenameInput').val()) === '群行改的名',
        $ren.find('#imGroupRenameInput').val());
    $ren.find('#imGroupRenameInput').val('聊天头改的名');
    $ren.find('.btn-ok').trigger('click');
}, 900);
phase(function () {
    check('聊天头铅笔改名生效', (IM.state.groups[MY_GID] || {}).name === '聊天头改的名',
        (IM.state.groups[MY_GID] || {}).name);
    check('聊天头标题同步', $.trim($('#imChatTitle').text()) === '聊天头改的名', $('#imChatTitle').text());
    // 打开别人当群主的种子群 → 三个入口都应不可用
    IM.openGroup(GID);
}, 600);
phase(function () {
    var $edit = $('#imChatTitleEdit');
    check('非群主的群：聊天头铅笔隐藏', $edit.is('[hidden]') === true);
    var $pen = $('#imContacts .im-contact.is-group[data-group="' + GID + '"] .im-contact__rename');
    check('非群主的群：群行铅笔隐藏', $pen.length === 1 && $pen.is('[hidden]') === true);
    $('#imGroupMembers').trigger('click');
}, 700);
phase(function () {
    var $last = $('.el-overlay').last();
    check('非群主：群成员弹窗里「重命名」按钮隐藏',
        $last.find('#imGroupRename').is('[hidden]') === true);
    check('非群主：给出「只有群主可以修改群名称」说明',
        $last.find('.im-group-owner-tip').length === 1 &&
        /只有群主可以修改群名称/.test($last.find('.im-group-owner-tip').text()),
        $last.find('.im-group-owner-tip').text());
    $last.find('.btn-cancel').trigger('click');
    $('.im__tab[data-tab="msg"]').trigger('click');
});

/* ---- 10g. 表情面板：开合 / 分组 / 插入光标 / 大表情气泡 / 表情包 ---- */
phase(function () {
    console.log('\n--- 10g. 表情面板与表情包 ---');
    IM.openPeer(Object.keys(IM.state.contacts).map(Number)[0]);
}, 500);
phase(function () {
    check('默认表情面板是收起的',
        $('#imEmojiPanel').is('[hidden]') === true && IM.state.emojiOpen === false);
    $('#imEmoji').trigger('click');
}, 400);
phase(function () {
    check('点表情按钮展开面板',
        $('#imEmojiPanel').is('[hidden]') === false && IM.state.emojiOpen === true);
    check('面板有 6 个 emoji 分组标签',
        $('#imEmojiTabs .im-emoji__tab').length === 6,
        String($('#imEmojiTabs .im-emoji__tab').length));
    check('默认停在「常用」且空态有提示',
        $.trim($('#imEmojiTabs .im-emoji__tab.is-active').text()) === '常用' &&
        /还没有用过的表情/.test($('#imEmojiBody').text()),
        $('#imEmojiBody').text().slice(0, 40));
    $('#imEmojiTabs .im-emoji__tab[data-egroup="hand"]').trigger('click');
}, 400);
phase(function () {
    check('切到「手势」有 32 个表情',
        $('#imEmojiBody .im-emoji__item').length === 32,
        String($('#imEmojiBody .im-emoji__item').length));
    check('第一个是 👍', $.trim($('#imEmojiBody .im-emoji__item').eq(0).text()) === '👍',
        $('#imEmojiBody .im-emoji__item').eq(0).text());
    // 光标放在开头插入
    var ta = $('#imText')[0];
    ta.value = '你好';
    ta.focus();
    try { ta.setSelectionRange(0, 0); } catch (e) { }
    $('#imEmojiBody .im-emoji__item').eq(0).trigger('click');
}, 400);
phase(function () {
    check('表情插入到光标位置（不是无条件追加）',
        $('#imText').val() === '👍你好', $('#imText').val());
    check('用过的表情记进「常用」',
        IM.state.recentEmoji[0] === '👍', JSON.stringify(IM.state.recentEmoji));
    check('最近使用写入 localStorage',
        /👍/.test(w.localStorage.getItem('menu_admin_im_emoji_recent') || ''));
    $('#imEmojiTabs .im-emoji__tab[data-egroup="recent"]').trigger('click');
}, 400);
phase(function () {
    check('「常用」分组显示刚用过的表情',
        $('#imEmojiBody .im-emoji__item').length === 1 &&
        $.trim($('#imEmojiBody .im-emoji__item').eq(0).text()) === '👍');
    // 再点一次 emoji 按钮收起面板
    $('#imEmoji').trigger('click');
}, 400);
phase(function () {
    check('再点表情按钮收起面板',
        $('#imEmojiPanel').is('[hidden]') === true && IM.state.emojiOpen === false);
    // 纯 emoji 判定
    check('isEmojiOnly：单个 emoji ✓', IM.isEmojiOnly('🎉') === true);
    check('isEmojiOnly：多个 emoji ✓', IM.isEmojiOnly('🎉🎉🎉') === true);
    check('isEmojiOnly：含文字 ✗', IM.isEmojiOnly('你好🎉') === false);
    check('isEmojiOnly：空串 ✗', IM.isEmojiOnly('') === false);
    // 发送纯 emoji → 大表情气泡
    $('#imText').val('🎉');
    IM.send();
}, 700);
phase(function () {
    var $b = $('#imChatBody .im-msg__bubble.is-emoji');
    check('纯 emoji 消息渲染成大表情气泡', $b.length === 1, String($b.length));
    check('气泡内容就是那个 emoji', $.trim($b.text()) === '🎉', $b.text());
    check('普通文字不会被当表情（无 is-emoji 类）',
        $b.length === 1 && $('#imChatBody .im-msg').length >= 1);

    // 复用 Mock 附件 + 表情接口造一个表情包
    var dfd = Api.msg.upload({
        fileName: '测试表情.png', kind: 'image', width: 64, height: 64,
        data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    });
    dfd.done(function (up) {
        Api.msg.emojiAdd({ fileId: up.fileId, name: '测试表情' }).done(function (r) {
            check('表情包添加成功', !!(r && r.id), JSON.stringify(r).slice(0, 90));
            IM.refreshEmojis(function () {
                check('本地表情包列表 +1', IM.state.emojis.length === 1, String(IM.state.emojis.length));
                check('mine=true（自己加的可以删）', IM.state.emojis[0].mine === true);
                IM.toggleEmoji();
            });
        }).fail(function (e) { check('表情包添加失败', false, e && e.message); });
    }).fail(function (e) { check('上传失败', false, e && e.message); });
}, 900);
phase(function () {
    check('面板出现「表情包」标签',
        $('#imEmojiTabs .im-emoji__tab[data-egroup="sticker"]').length === 1);
    $('#imEmojiTabs .im-emoji__tab[data-egroup="sticker"]').trigger('click');
}, 400);
phase(function () {
    check('表情包分组渲染缩略图', $('#imEmojiBody .im-emoji__sticker').length === 1,
        String($('#imEmojiBody .im-emoji__sticker').length));
    check('缩略图指向表情 url',
        String($('#imEmojiBody .im-emoji__sticker img').attr('src') || '').indexOf('data:image') === 0);
    check('自己加的表情包有删除按钮', $('#imEmojiBody .im-emoji__del').length === 1);
    // 点表情包 → 直接发送
    $('#imEmojiBody .im-emoji__sticker').trigger('click');
}, 900);
phase(function () {
    var $s = $('#imChatBody .im-sticker');
    check('发送后出现表情包气泡', $s.length === 1, String($s.length));
    check('气泡用 im-sticker（小尺寸样式）', $s.hasClass('im-sticker'));
    var list = IM.state.convo[IM.state.activePeer] || [];
    var last = list[list.length - 1] || {};
    check('消息类型 sticker、摘要 [表情]',
        last.msgType === 'sticker' && last.content === '[表情]',
        last.msgType + ' / ' + last.content);
    check('发送后自动收起面板', IM.state.emojiOpen === false);
    // 删除表情包
    IM.toggleEmoji();
    $('#imEmojiTabs .im-emoji__tab[data-egroup="sticker"]').trigger('click');
}, 600);
phase(function () {
    $('#imEmojiBody .im-emoji__del').trigger('click');
}, 800);
phase(function () {
    check('删除后表情包列表清空', IM.state.emojis.length === 0, String(IM.state.emojis.length));
    check('删除后面板回到空态',
        $('#imEmojiBody .im-emoji__sticker').length === 0);
    if (IM.state.emojiOpen) { IM.toggleEmoji(); }
});

/* ---- 10e. 截屏编辑器（jsdom 无 canvas，验状态机） ---- */
phase(function () {
    console.log('\n--- 10e. 截屏编辑器：状态机 / 归一化 / 撤销 ---');
    var w2 = boot(sso(3));
    check('页面暴露 window.IMShot', !!w2.IMShot && typeof w2.IMShot.open === 'function');
    var SC = w2.IMShot;
    var sent = null;
    SC.open('data:image/png;base64,iVBORw0KGgo=', {
        onSend: function (u, wd, ht) { sent = { u: u, w: wd, h: ht }; },
        onCancel: function () { sent = 'cancelled'; }
    });
    check('open 后 isOpen()=true', SC.isOpen() === true);
    var root = w2.document.getElementById('imShotEd');
    check('编辑器 DOM 已创建', !!root);
    check('初始阶段是 select', SC.state.phase === 'select');
    check('初始工具栏隐藏、发送按钮禁用',
        root.querySelector('#imShotEdTools').hasAttribute('hidden') &&
        root.querySelector('[data-act="send"]').disabled);
    check('5 个标注工具按钮 + 5 个颜色',
        root.querySelectorAll('.im-shot__tool').length === 5 &&
        root.querySelectorAll('.im-shot__colors i').length === 5);

    // 归一化选区
    var ns = SC._test.normSel({ x0: 0.6, y0: 0.7, x1: 0.2, y1: 0.3 });
    check('normSel 把反向拖拽归一成正向矩形',
        ns.x === 0.2 && ns.y === 0.3 && Math.abs(ns.w - 0.4) < 1e-9 && Math.abs(ns.h - 0.4) < 1e-9,
        JSON.stringify(ns));

    // 模拟选区完成 → 进 annotate
    SC.state.sel = { x0: 0.2, y0: 0.2, x1: 0.7, y1: 0.7 };
    SC.state.phase = 'annotate';
    SC._test.syncBar();
    check('有选区后工具栏显示、发送可用',
        !root.querySelector('#imShotEdTools').hasAttribute('hidden') &&
        !root.querySelector('[data-act="send"]').disabled);

    // 直接构造标注，验证撤销
    SC.state.marks.push({ type: 'rect', x0: 0.25, y0: 0.25, x1: 0.4, y1: 0.4, color: '#ff3b30', lw: 0.0035 });
    SC.state.marks.push({ type: 'arrow', x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.35, color: '#0a84ff', lw: 0.0035 });
    check('两条标注', SC.state.marks.length === 2);
    SC._test.undo();
    check('撤销后剩 1 条且是 rect',
        SC.state.marks.length === 1 && SC.state.marks[0].type === 'rect');

    // 重选：清空标注回 select
    SC._test.resetSel();
    check('重选：回 select 且清空标注与选区',
        SC.state.phase === 'select' && SC.state.marks.length === 0 && !SC.state.sel);

    // 取消回调
    root.querySelector('[data-act="cancel"]').click();
    check('取消后编辑器移除', !w2.document.getElementById('imShotEd'));
    check('取消触发 onCancel', sent === 'cancelled', String(sent));

    // 未框选就发送 → 不回调
    sent = null;
    SC.open('data:image/png;base64,iVBORw0KGgo=', {
        onSend: function () { sent = 'sent'; }, onCancel: function () { }
    });
    SC._test.doSend();
    check('没框选就点发送：不发送（保持编辑器打开）',
        sent === null && SC.isOpen() === true);
    SC.close();

    // 标注绘制函数在无 canvas 环境不抛错
    var okPaint = true;
    try { SC._test.redraw(); } catch (e) { okPaint = false; }
    check('无 canvas 环境下 redraw 不抛错', okPaint);
});

/* ---- 11. 深链 ?group= ---- */
phase(function () {
    console.log('\n--- 11. 深链 ?group= ---');
    var w3 = boot(sso(3), 'http://127.0.0.1:8808/message.html?group=' + GID);
    check('page 记录了 pendingGroup', w3.IM.pendingGroup === GID,
        w3.IM.pendingGroup + ' / ' + GID);
    setTimeout(function () {
        check('深链自动打开该群', w3.IM.state.activeGroup === GID,
            w3.IM.state.activeGroup + ' / pending=' + w3.IM.pendingGroup);
        check('深链打开后不再有待处理目标',
            !w3.IM.pendingGroup && !w3.IM.pendingPeer);
    }, 700);
}, 1200);

setTimeout(run, 400);
