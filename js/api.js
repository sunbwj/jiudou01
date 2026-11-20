/* ==========================================================================
   api.js —— 数据服务层（jQuery + AJAX）
   --------------------------------------------------------------------------
   · 默认使用内置 Mock 服务（数据存于 localStorage，便于离线演示），
     接口调用方式与真实后端完全一致（Promise 风格）；
   · 接入真实后端时只需把 config.useMock 改为 false，并配置 config.baseUrl，
     所有请求会自动切换为原生 $.ajax 请求（见 request 函数）；
   · 菜单项（/menu/*）、菜单组（/group/*）共用同一套服务实现（createService），
     仅在种子数据、唯一性字段、可写字段上有差异；
     菜单组项目（/groupitem/*）单独实现（createGroupItemService），负责
     菜单组 ↔ 菜单项的关联与组内显示序号（批量新增 / 全量同步）。
   · 单点登录（SSO）：登录 token 存 localStorage（menu_admin_login_v1），同源下
     main.html 与全部 iframe 子页共享同一份会话，默认 8 小时有效；
     子页登录失效时**不在子页里跳转**，而是上报给顶层，由 main.html 整体跳登录页。
   ========================================================================== */
window.Api = (function ($) {
    /* 页面是否就跑在访问者本机（file:// 直接打开也算）。
       只有这种情况才允许程序去连 127.0.0.1：
       页面从公网/内网域名打开时，127.0.0.1 指的是**访问者自己的电脑**，
       而且浏览器会按「私有网络访问（PNA）」规则直接拦掉 public → loopback 的请求：
       Access to XMLHttpRequest ... more-private address space `loopback` */
    function isLocalPage() {
        var loc = window.location;
        if (!loc.protocol || loc.protocol === 'file:') { return true; }
        var host = String(loc.hostname || '').toLowerCase();
        return host === '' || host === 'localhost' || host === '127.0.0.1' ||
               host === '::1' || host === '[::1]' || /^127\./.test(host) || /\.localhost$/.test(host);
    }
    var LOCAL_PAGE = isLocalPage();

    // 后端默认地址（server/app.py）：仅当页面本身在本机时用它直连（后端已开启 CORS）
    var REMOTE_BASE = 'http://127.0.0.1:8808/api';

    var config = {
        useMock: false,    // false=真实后端（Python Flask，见 server/app.py）  true=本地模拟服务
        // 真实后端基础地址：
        //  · 页面由后端托管（http://127.0.0.1:8808/main.html）时用同源相对地址 'api'
        //  · 页面以 file:// 直接打开或用独立静态服务打开时用绝对地址（见 detectBackend 自动探测）
        baseUrl: (window.location.protocol === 'http:' || window.location.protocol === 'https:')
            ? 'api' : REMOTE_BASE,
        autoFallback: true,// 真实后端不可用时自动回退到本地模拟服务（仅用于离线演示）
        delay: 240,        // 模拟网络延迟(ms)
        timeout: 15000,    // 普通接口超时(ms)
        // 慢接口超时(ms)：删除库 / 删除表（级联删对象与字段）、导出升级脚本、大结果集导出、
        // 收件同步等，要几十秒到几分钟，用普通超时会被前端先掐掉（后端其实还在跑），
        // 单独给一个更长的值（默认 10 分钟）。
        slowTimeout: 600000,
        // 结构扫描 / 比对类超时(ms)：扫描实库、与实库对比、导入 DDL、发布脚本。
        // 一个库几百张表时单次要跑几十秒到十几分钟，前端先超时的话后端仍在写库，
        // 用户再点一次等于重跑一遍（还可能撞上写冲突），所以这类给足 30 分钟。
        scanTimeout: 1800000
    };

    /* 慢接口名单（按 url 前缀匹配）：只影响超时，不影响返回结构 */
    var SLOW_API = [
        '/appschema/scan',        // 扫描实库 → 导入设计态
        '/appschema/compare',     // 对比 / 历史明细 / 升级脚本 / 批量导出（同前缀）
        '/appschema/importddl',   // 导入 DDL（大脚本解析 + 落库）
        '/appschema/parsesql',    // 只解析 DDL 预览
        '/appschema/publish',     // 发布：给全部对象生成正向 / 回滚脚本
        '/appschema/lineage',     // 字段血缘查询（大表 up / down 明细）
        '/appschema/dbdel',       // 删除库（连带对象与字段）
        '/appschema/objdel',      // 删除表 / 视图 / 存储过程
        '/appschema/exportdocs',  // 导出表结构文档（几百张表 + 上万字段，Word 生成要几十秒）
        '/dbinfo/scan',           // 扫描连接：列实例下的库 + 各库表数（大实例慢）
        '/dbinfo/tables',         // 扫实例下的表与视图
        '/dbinfo/columns',        // 扫表的字段
        '/dbinfo/rows',           // 表数据分页（大表 count 慢）
        '/dbinfo/sqlrun',         // SQL 工作台
        '/report/preview',        // 报表预览
        '/report/run',            // 报表调用
        '/report/export',         // 报表导出（可能查几万行）
        '/workload/export',       // 工作量统计导出
        '/mail/sync',             // 收件（IMAP 逐封拉取）
        '/empmail/sync',          // 员工信箱收件
        '/emp/archive'            // 员工信息整表归档
    ];
    /* 结构扫描 / 比对类（在慢接口之上再放宽到 scanTimeout）：
       这类请求一旦被前端掐掉，后端往往还在写库，重试等于重跑 */
    var SCAN_API = [
        '/appschema/scan',        // 扫描实库 → 导入设计态（几百张表逐张读定义 + 批量写库）
        '/appschema/compare',     // 与实库对比 / 明细 / 升级脚本 / 批量导出（同前缀）
        '/appschema/importddl',   // 导入 DDL（大脚本解析 + 大批写库）
        '/appschema/publish',     // 发布：给全部对象生成正向 / 回滚脚本
        '/appschema/lineagebuild' // 重建字段血缘（逐个视图 / 过程跑 sqlglot，大库要跑一阵）
    ];
    function matchPrefix(list, url) {
        var u = String(url || '');
        for (var i = 0; i < list.length; i++) {
            if (u.indexOf(list[i]) === 0) { return true; }
        }
        return false;
    }
    function isScanApi(url) { return matchPrefix(SCAN_API, url); }
    function isSlowApi(url) { return matchPrefix(SLOW_API, url); }
    /** 该接口该等多久（ms）：扫描比对 → scanTimeout；其它慢接口 → slowTimeout；普通 → timeout */
    function timeoutFor(url) {
        if (isScanApi(url)) { return config.scanTimeout; }
        return isSlowApi(url) ? config.slowTimeout : config.timeout;
    }
    /** 把毫秒说成人话：「30 秒」/「10 分钟」 */
    function waitText(ms) {
        var s = Math.round(Number(ms || 0) / 1000);
        if (s < 60) { return s + ' 秒'; }
        var m = Math.round(s / 60);
        return m + ' 分钟';
    }

    /* ---------- 工具方法 ---------- */
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function now() {
        var d = new Date();
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
               pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    function clone(obj) { return obj == null ? obj : JSON.parse(JSON.stringify(obj)); }
    function like(text, kw) {
        return String(text == null ? '' : text).toLowerCase().indexOf(String(kw == null ? '' : kw).toLowerCase()) > -1;
    }
    /** 数字左补零到指定位数，如 padNum(7, 5) => '00007' */
    function padNum(n, digits) {
        var s = String(n);
        while (s.length < digits) { s = '0' + s; }
        return s;
    }

    /* ---------- 服务信箱 / 邮箱助手共用的小工具（与后端 mail_client 规则一致） ---------- */
    /** 邮箱地址基本格式校验 */
    function mailIsEmail(text) {
        return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(String(text || '').trim());
    }
    /** 由邮箱域名推断收发服务器（与后端 PROVIDERS 表一致；离线演示用） */
    function mailProvider(address) {
        var addr = String(address || '').toLowerCase();
        var domain = addr.split('@').length > 1 ? addr.split('@')[1] : '';
        var map = {
            'qq.com': ['imap.qq.com', 993, 'smtp.qq.com', 465, 'QQ 邮箱'],
            'foxmail.com': ['imap.qq.com', 993, 'smtp.qq.com', 465, 'QQ 邮箱'],
            'vip.qq.com': ['imap.qq.com', 993, 'smtp.qq.com', 465, 'QQ 邮箱'],
            '163.com': ['imap.163.com', 993, 'smtp.163.com', 465, '网易 163'],
            '126.com': ['imap.126.com', 993, 'smtp.126.com', 465, '网易 126'],
            'yeah.net': ['imap.yeah.net', 993, 'smtp.yeah.net', 465, '网易 yeah'],
            'sina.com': ['imap.sina.com', 993, 'smtp.sina.com', 465, '新浪邮箱'],
            'sina.cn': ['imap.sina.cn', 993, 'smtp.sina.cn', 465, '新浪邮箱'],
            'sohu.com': ['imap.sohu.com', 993, 'smtp.sohu.com', 465, '搜狐邮箱'],
            'aliyun.com': ['imap.aliyun.com', 993, 'smtp.aliyun.com', 465, '阿里邮箱'],
            '139.com': ['imap.139.com', 993, 'smtp.139.com', 465, '移动 139'],
            '189.cn': ['imap.189.cn', 993, 'smtp.189.cn', 465, '电信 189'],
            'outlook.com': ['outlook.office365.com', 993, 'smtp.office365.com', 587, 'Outlook'],
            'hotmail.com': ['outlook.office365.com', 993, 'smtp.office365.com', 587, 'Hotmail'],
            'live.com': ['outlook.office365.com', 993, 'smtp.office365.com', 587, 'Outlook'],
            'gmail.com': ['imap.gmail.com', 993, 'smtp.gmail.com', 465, 'Gmail']
        };
        var hit = map[domain];
        if (hit) {
            return { imapHost: hit[0], imapPort: hit[1], smtpHost: hit[2], smtpPort: hit[3], provider: hit[4] };
        }
        return {
            imapHost: domain ? ('imap.' + domain) : '', imapPort: 993,
            smtpHost: domain ? ('smtp.' + domain) : '', smtpPort: 465,
            provider: '自定义域名'
        };
    }

    /** 标准 MD5（32 位小写十六进制）——与后端 hashlib.md5 完全一致，供用户密码的本地模拟存储使用 */
    function md5Hex(text) {
        function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
        function au(x, y) {
            var l = (x & 0xFFFF) + (y & 0xFFFF);
            var m = (x >> 16) + (y >> 16) + (l >> 16);
            return (m << 16) | (l & 0xFFFF);
        }
        function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
        function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
        function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
        function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
        function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

        // 按 UTF-8 取字节串 → 小端 32 位字数组（末尾追加 0x80 与 bit 长度）
        function toWords(str) {
            var s = unescape(encodeURIComponent(str));
            var n = s.length, words = [], i;
            for (i = 0; i < n; i++) {
                words[i >> 2] = (words[i >> 2] || 0) | ((s.charCodeAt(i) & 0xFF) << ((i % 4) * 8));
            }
            words[n >> 2] = (words[n >> 2] || 0) | (0x80 << ((n % 4) * 8));
            var total = (((n + 8) >> 6) + 1) * 16;
            while (words.length < total) { words.push(0); }
            var bits = n * 8;
            words[total - 2] = bits | 0;
            words[total - 1] = Math.floor(bits / 4294967296) | 0;
            for (i = 0; i < words.length; i++) { words[i] = words[i] | 0; }
            return words;
        }

        var x = toWords(String(text));
        var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;

        function block(off) {
            var oa = a, ob = b, oc = c, od = d;
            a = ff(a, b, c, d, x[off], 7, -680876936);
            d = ff(d, a, b, c, x[off + 1], 12, -389564586);
            c = ff(c, d, a, b, x[off + 2], 17, 606105819);
            b = ff(b, c, d, a, x[off + 3], 22, -1044525330);
            a = ff(a, b, c, d, x[off + 4], 7, -176418897);
            d = ff(d, a, b, c, x[off + 5], 12, 1200080426);
            c = ff(c, d, a, b, x[off + 6], 17, -1473231341);
            b = ff(b, c, d, a, x[off + 7], 22, -45705983);
            a = ff(a, b, c, d, x[off + 8], 7, 1770035416);
            d = ff(d, a, b, c, x[off + 9], 12, -1958414417);
            c = ff(c, d, a, b, x[off + 10], 17, -42063);
            b = ff(b, c, d, a, x[off + 11], 22, -1990404162);
            a = ff(a, b, c, d, x[off + 12], 7, 1804603682);
            d = ff(d, a, b, c, x[off + 13], 12, -40341101);
            c = ff(c, d, a, b, x[off + 14], 17, -1502002290);
            b = ff(b, c, d, a, x[off + 15], 22, 1236535329);
            a = gg(a, b, c, d, x[off + 1], 5, -165796510);
            d = gg(d, a, b, c, x[off + 6], 9, -1069501632);
            c = gg(c, d, a, b, x[off + 11], 14, 643717713);
            b = gg(b, c, d, a, x[off], 20, -373897302);
            a = gg(a, b, c, d, x[off + 5], 5, -701558691);
            d = gg(d, a, b, c, x[off + 10], 9, 38016083);
            c = gg(c, d, a, b, x[off + 15], 14, -660478335);
            b = gg(b, c, d, a, x[off + 4], 20, -405537848);
            a = gg(a, b, c, d, x[off + 9], 5, 568446438);
            d = gg(d, a, b, c, x[off + 14], 9, -1019803690);
            c = gg(c, d, a, b, x[off + 3], 14, -187363961);
            b = gg(b, c, d, a, x[off + 8], 20, 1163531501);
            a = gg(a, b, c, d, x[off + 13], 5, -1444681467);
            d = gg(d, a, b, c, x[off + 2], 9, -51403784);
            c = gg(c, d, a, b, x[off + 7], 14, 1735328473);
            b = gg(b, c, d, a, x[off + 12], 20, -1926607734);
            a = hh(a, b, c, d, x[off + 5], 4, -378558);
            d = hh(d, a, b, c, x[off + 8], 11, -2022574463);
            c = hh(c, d, a, b, x[off + 11], 16, 1839030562);
            b = hh(b, c, d, a, x[off + 14], 23, -35309556);
            a = hh(a, b, c, d, x[off + 1], 4, -1530992060);
            d = hh(d, a, b, c, x[off + 4], 11, 1272893353);
            c = hh(c, d, a, b, x[off + 7], 16, -155497632);
            b = hh(b, c, d, a, x[off + 10], 23, -1094730640);
            a = hh(a, b, c, d, x[off + 13], 4, 681279174);
            d = hh(d, a, b, c, x[off], 11, -358537222);
            c = hh(c, d, a, b, x[off + 3], 16, -722521979);
            b = hh(b, c, d, a, x[off + 6], 23, 76029189);
            a = hh(a, b, c, d, x[off + 9], 4, -640364487);
            d = hh(d, a, b, c, x[off + 12], 11, -421815835);
            c = hh(c, d, a, b, x[off + 15], 16, 530742520);
            b = hh(b, c, d, a, x[off + 2], 23, -995338651);
            a = ii(a, b, c, d, x[off], 6, -198630844);
            d = ii(d, a, b, c, x[off + 7], 10, 1126891415);
            c = ii(c, d, a, b, x[off + 14], 15, -1416354905);
            b = ii(b, c, d, a, x[off + 5], 21, -57434055);
            a = ii(a, b, c, d, x[off + 12], 6, 1700485571);
            d = ii(d, a, b, c, x[off + 3], 10, -1894986606);
            c = ii(c, d, a, b, x[off + 10], 15, -1051523);
            b = ii(b, c, d, a, x[off + 1], 21, -2054922799);
            a = ii(a, b, c, d, x[off + 8], 6, 1873313359);
            d = ii(d, a, b, c, x[off + 15], 10, -30611744);
            c = ii(c, d, a, b, x[off + 6], 15, -1560198380);
            b = ii(b, c, d, a, x[off + 13], 21, 1309151649);
            a = ii(a, b, c, d, x[off + 4], 6, -145523070);
            d = ii(d, a, b, c, x[off + 11], 10, -1120210379);
            c = ii(c, d, a, b, x[off + 2], 15, 718787259);
            b = ii(b, c, d, a, x[off + 9], 21, -343485551);
            a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
        }
        for (var off = 0; off < x.length; off += 16) { block(off); }

        function hex(n) {
            var out = '';
            for (var i = 0; i < 4; i++) {
                out += ('0' + ((n >> (i * 8)) & 0xFF).toString(16)).slice(-2);
            }
            return out;
        }
        return hex(a) + hex(b) + hex(c) + hex(d);
    }

    /** 生成标准 36 位 UUID（模拟服务里给「角色 / 权限 / 用户」这类 UUID 主键用） */
    function mockUuid() {
        try {
            if (window.crypto && window.crypto.randomUUID) { return window.crypto.randomUUID(); }
            if (window.crypto && window.crypto.getRandomValues) {
                var buf = new Uint8Array(16);
                window.crypto.getRandomValues(buf);
                buf[6] = (buf[6] & 0x0f) | 0x40;
                buf[8] = (buf[8] & 0x3f) | 0x80;
                var hex = [];
                for (var hx = 0; hx < 16; hx++) { hex.push((buf[hx] + 0x100).toString(16).slice(1)); }
                return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
                    hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('');
            }
        } catch (e) { /* 忽略：退化到下面的伪随机实现 */ }
        var rnd = '';
        while (rnd.length < 12) { rnd += Math.floor(Math.random() * 16).toString(16); }
        var ts = ('00000000' + (new Date().getTime()).toString(16)).slice(-8);
        return ts + '-4000-8000-' + rnd.slice(0, 4) + '-' + (rnd.slice(4, 16) + '000000000000').slice(0, 12);
    }

    /* 角色权限模拟服务默认授予「系统管理员」的角色ID（与 SEED_ROLE 第一条一致） */
    var MOCK_ADMIN_ROLE_ID = 'a1b2c3d4-0001-4a1b-8c00-000000000001';

    /* ---------- 初始种子数据：菜单项 ---------- */
    var SEED_MENU = [
        { code: 'MENU0100', nameCn: '菜单项管理', nameEn: 'MenuManagement', path: 'menu.html', icon: 'menu', enabled: true, remark: '系统功能菜单的检索、新增、编辑与删除。', createTime: '2026-01-06 09:12:33' },
        { code: 'MENU0200', nameCn: '用户管理', nameEn: 'UserManagement', path: 'user.html', icon: 'user', enabled: true, remark: '平台账号的创建、禁用与角色分配。', createTime: '2026-01-06 09:20:11' },
        { code: 'MENU0300', nameCn: '角色权限', nameEn: 'RolePermission', path: 'role.html', icon: 'lock', enabled: true, remark: '角色定义与菜单、按钮级权限配置。', createTime: '2026-01-07 10:02:45' },
        { code: 'MENU0400', nameCn: '系统设置', nameEn: 'SystemSetting', path: 'setting.html', icon: 'setting', enabled: true, remark: '站点参数、字典与基础配置项维护。', createTime: '2026-01-08 14:36:02' },
        { code: 'MENU0500', nameCn: '数据字典', nameEn: 'DataDictionary', path: 'dict.html', icon: 'database', enabled: false, remark: '统一维护业务枚举与字典项。', createTime: '2026-01-09 16:10:57' },
        { code: 'MENU0600', nameCn: '操作日志', nameEn: 'OperationLog', path: 'log.html', icon: 'document', enabled: true, remark: '记录用户登录与关键业务操作轨迹。', createTime: '2026-01-12 08:45:19' },
        { code: 'MENU0700', nameCn: '消息中心', nameEn: 'MessageCenter', path: 'message.html', icon: 'message', enabled: true, remark: '站内消息与通知推送管理。', createTime: '2026-01-13 11:22:08' },
        { code: 'MENU0800', nameCn: '统计报表', nameEn: 'StatisticsReport', path: 'report.html', icon: 'chart', enabled: true, remark: '业务经营数据多维统计与导出。', createTime: '2026-01-15 17:05:41' },
        { code: 'MENU0900', nameCn: '文件管理', nameEn: 'FileManager', path: 'file.html', icon: 'folder', enabled: true, remark: '附件与静态资源的上传、预览与清理。', createTime: '2026-01-16 09:33:26' },
        { code: 'MENU1000', nameCn: '日程安排', nameEn: 'SchedulePlan', path: 'calendar.html', icon: 'calendar', enabled: false, remark: '团队日程、会议与待办提醒。', createTime: '2026-01-19 13:48:00' },
        { code: 'MENU1100', nameCn: '订单中心', nameEn: 'OrderCenter', path: 'order.html', icon: 'cart', enabled: true, remark: '订单查询、审核与售后处理。', createTime: '2026-01-20 15:27:35' },
        { code: 'MENU1200', nameCn: '站点配置', nameEn: 'SiteConfig', path: 'site.html', icon: 'globe', enabled: true, remark: '门户站点、域名与 SEO 配置。', createTime: '2026-01-21 10:14:52' },
        { code: 'MENU1300', nameCn: '标签管理', nameEn: 'TagManagement', path: 'tag.html', icon: 'tag', enabled: true, remark: '内容与客户的标签体系维护。', createTime: '2026-01-22 09:58:17' },
        { code: 'MENU1400', nameCn: '图库资源', nameEn: 'GalleryAssets', path: 'gallery.html', icon: 'image', enabled: false, remark: '图片素材的归类与检索。', createTime: '2026-01-23 14:02:39' },
        { code: 'MENU1500', nameCn: '告警监控', nameEn: 'AlertMonitor', path: 'alert.html', icon: 'warning', enabled: true, remark: '系统异常告警与阈值配置。', createTime: '2026-01-26 08:31:04' }
    ];
    // 显示序号（菜单项管理列表按此升序）：种子数据按顺序 1..N
    for (var _seedNo = 0; _seedNo < SEED_MENU.length; _seedNo++) { SEED_MENU[_seedNo].sortNo = _seedNo + 1; }

    /* ---------- 初始种子数据：页面操作按钮（与页面 HTML 里操作引导区的按钮一致） ----------
       格式：[页面路径, 所属页面, [[按钮id, 按钮文本], ...]]，记录 id 为 UUID，由服务生成 */
    var SEED_PAGEOPBTN = [
        ['emp.html', '员工信息管理', [['btnAdd', '新增员工'], ['btnEdit', '编辑'], ['btnDelete', '删除'], ['btnRefresh', '刷新']]],
        ['menu-form.html', '新增菜单项', [['btnSave', '保存'], ['btnBack', '返回']]],
        ['menu-group-form.html', '新增菜单组', [['btnSave', '保存'], ['btnBack', '返回']]],
        ['menu-group-item-form.html', '新增菜单组项目', [['btnCheckAll', '全选'], ['btnClearAll', '清空'], ['btnSave', '保存'], ['btnBack', '返回']]],
        ['menu-group-item.html', '菜单组项目管理', [['btnAdd', '新增'], ['btnEdit', '编辑'], ['btnDelete', '删除']]],
        ['menu-group.html', '菜单组管理', [['btnAdd', '新增'], ['btnEdit', '编辑'], ['btnDelete', '删除']]],
        ['menu.html', '菜单项管理', [['btnAdd', '新增'], ['btnEdit', '编辑'], ['btnDelete', '删除']]],
        ['org-form.html', '新增部门', [['btnSave', '保存'], ['btnBack', '返回']]],
        ['org.html', '组织架构', [['btnAdd', '新增'], ['btnEdit', '编辑'], ['btnDelete', '删除'], ['btnSetManager', '设置负责人']]],
        ['page-op-btn.html', '页面操作按钮管理', [['btnScan', '重新收录'], ['btnEdit', '编辑'], ['btnEnable', '启用'], ['btnDisable', '停用'], ['btnDelete', '删除'], ['btnRefresh', '刷新']]],
        ['role-power.html', '角色权限配置', [['btnSave', '保存权限'], ['btnAll', '全选'], ['btnInvert', '反选'], ['btnClear', '清空'], ['btnExpand', '展开全部'], ['btnCollapse', '折叠全部'], ['btnRefresh', '刷新']]],
        ['role.html', '用户角色管理', [['btnAdd', '新增角色'], ['btnEdit', '编辑'], ['btnDelete', '删除'], ['btnRefresh', '刷新']]]
    ];

    /* ---------- 初始种子数据：用户角色（主键为 UUID，固定值便于演示） ----------
       nameCn：角色名（唯一）；remark：说明；sortNo：排序号（列表按此升序）；enabled：启用否 */
    var SEED_ROLE = [
        { id: 'a1b2c3d4-0001-4a1b-8c00-000000000001', nameCn: '系统管理员', nameEn: 'SystemAdmin',   remark: '拥有全部功能与配置权限，可管理菜单、组织架构与员工信息。', sortNo: 1, enabled: true, createTime: '2026-10-31 09:50:00' },
        { id: 'a1b2c3d4-0002-4a1b-8c00-000000000002', nameCn: '业务管理员', nameEn: 'BusinessAdmin', remark: '负责业务数据维护，可查看组织架构与员工信息，不可修改菜单配置。', sortNo: 2, enabled: true, createTime: '2026-10-31 09:52:00' },
        { id: 'a1b2c3d4-0003-4a1b-8c00-000000000003', nameCn: '普通用户',   nameEn: 'NormalUser',    remark: '仅可访问已授权的业务菜单，只读为主。', sortNo: 3, enabled: true, createTime: '2026-10-31 09:54:00' },
        { id: 'a1b2c3d4-0004-4a1b-8c00-000000000004', nameCn: '审计员',     nameEn: 'Auditor',       remark: '可查看操作日志与报表，不可修改任何业务数据（历史角色，已停用）。', sortNo: 4, enabled: false, createTime: '2026-10-31 09:56:00' }
    ];

    /* ---------- 初始种子数据：菜单组（支持多层级） ----------
       parentId：上级菜单组 ID，0 表示顶级；level：层级（由 parentId 推导，1 级起）；
       sortNo：同级排序号；hasChild：可否绑定菜单项（无默认值，必选；为「否」时功能页面路径可选、非必填） */
    var SEED_GROUP = [
        { parentId: 0, level: 1, sortNo: 1, code: 'GRP0100', nameCn: '系统管理', nameEn: 'SystemManagement', hasChild: true, path: '', icon: 'setting', enabled: true, createTime: '2026-01-05 09:05:12' },
        { parentId: 1, level: 2, sortNo: 1, code: 'GRP0200', nameCn: '用户管理', nameEn: 'UserManagement', hasChild: true, path: '', icon: 'user', enabled: true, createTime: '2026-01-05 09:18:40' },
        { parentId: 2, level: 3, sortNo: 1, code: 'GRP0300', nameCn: '角色权限', nameEn: 'RolePermission', hasChild: false, path: 'role.html', icon: 'lock', enabled: true, createTime: '2026-01-06 10:31:09' },
        { parentId: 1, level: 2, sortNo: 2, code: 'GRP0400', nameCn: '菜单配置', nameEn: 'MenuConfig', hasChild: true, path: '', icon: 'menu', enabled: true, createTime: '2026-01-06 14:22:57' },
        { parentId: 0, level: 1, sortNo: 2, code: 'GRP0500', nameCn: '业务中心', nameEn: 'BusinessCenter', hasChild: true, path: '', icon: 'dashboard', enabled: true, createTime: '2026-01-07 09:47:36' },
        { parentId: 5, level: 2, sortNo: 1, code: 'GRP0600', nameCn: '订单管理', nameEn: 'OrderManagement', hasChild: true, path: '', icon: 'cart', enabled: true, createTime: '2026-01-08 11:09:23' },
        { parentId: 6, level: 3, sortNo: 1, code: 'GRP0700', nameCn: '订单查询', nameEn: 'OrderQuery', hasChild: false, path: 'order/query.html', icon: 'document', enabled: true, createTime: '2026-01-09 15:52:41' },
        { parentId: 5, level: 2, sortNo: 2, code: 'GRP0800', nameCn: '商品中心', nameEn: 'ProductCenter', hasChild: true, path: '', icon: 'tag', enabled: true, createTime: '2026-01-12 08:36:15' },
        { parentId: 0, level: 1, sortNo: 3, code: 'GRP0900', nameCn: '客户管理', nameEn: 'CustomerManagement', hasChild: true, path: '', icon: 'user', enabled: true, createTime: '2026-01-13 16:04:08' },
        { parentId: 0, level: 1, sortNo: 4, code: 'GRP1000', nameCn: '帮助中心', nameEn: 'HelpCenter', hasChild: false, path: 'help.html', icon: 'document', enabled: true, createTime: '2026-01-14 09:26:50' },
        { parentId: 9, level: 2, sortNo: 1, code: 'GRP1100', nameCn: '客户列表', nameEn: 'CustomerList', hasChild: false, path: 'customer/list.html', icon: 'document', enabled: true, createTime: '2026-01-15 10:48:02' },
        { parentId: 0, level: 1, sortNo: 5, code: 'GRP1200', nameCn: '数据报表', nameEn: 'DataReport', hasChild: true, path: '', icon: 'chart', enabled: true, createTime: '2026-01-16 13:55:27' },
        { parentId: 12, level: 2, sortNo: 1, code: 'GRP1300', nameCn: '支付配置', nameEn: 'PaymentConfig', hasChild: false, path: 'payment.html', icon: 'database', enabled: false, createTime: '2026-01-19 09:12:44' },
        { parentId: 12, level: 2, sortNo: 2, code: 'GRP1400', nameCn: '站点配置', nameEn: 'SiteConfig', hasChild: true, path: '', icon: 'globe', enabled: true, createTime: '2026-01-20 14:37:19' },
        { parentId: 0, level: 1, sortNo: 6, code: 'GRP1500', nameCn: '系统监控', nameEn: 'SystemMonitor', hasChild: false, path: 'monitor.html', icon: 'warning', enabled: false, createTime: '2026-01-21 16:20:35' }
    ];

    /* ---------- 初始种子数据：菜单组项目设置（菜单组 ↔ 菜单项） ----------
       groupId：菜单组 ID；itemId：菜单项 ID；sortNo：该菜单项在组内的显示序号（整型） */
    var SEED_GROUP_ITEM = [
        { groupId: 1, itemId: 1, sortNo: 1, enabled: true, remark: '系统管理-菜单项管理', createTime: '2026-02-02 09:10:05' },
        { groupId: 1, itemId: 4, sortNo: 2, enabled: true, remark: '系统管理-系统设置', createTime: '2026-02-02 09:12:18' },
        { groupId: 1, itemId: 6, sortNo: 3, enabled: true, remark: '系统管理-操作日志', createTime: '2026-02-02 09:15:41' },
        { groupId: 2, itemId: 2, sortNo: 1, enabled: true, remark: '用户管理-用户管理', createTime: '2026-02-02 09:20:07' },
        { groupId: 2, itemId: 3, sortNo: 2, enabled: true, remark: '用户管理-角色权限', createTime: '2026-02-02 09:22:33' },
        { groupId: 4, itemId: 1, sortNo: 1, enabled: true, remark: '菜单配置-菜单项管理', createTime: '2026-02-02 09:30:12' },
        { groupId: 4, itemId: 13, sortNo: 2, enabled: true, remark: '菜单配置-标签管理', createTime: '2026-02-02 09:33:50' },
        { groupId: 5, itemId: 11, sortNo: 1, enabled: true, remark: '业务中心-订单中心', createTime: '2026-02-02 10:02:26' },
        { groupId: 5, itemId: 8, sortNo: 2, enabled: true, remark: '业务中心-统计报表', createTime: '2026-02-02 10:05:48' },
        { groupId: 6, itemId: 11, sortNo: 1, enabled: true, remark: '订单管理-订单中心', createTime: '2026-02-02 10:12:09' },
        { groupId: 8, itemId: 11, sortNo: 1, enabled: true, remark: '商品中心-订单中心', createTime: '2026-02-02 10:20:35' },
        { groupId: 9, itemId: 2, sortNo: 1, enabled: true, remark: '客户管理-用户管理', createTime: '2026-02-02 10:28:57' },
        { groupId: 12, itemId: 8, sortNo: 1, enabled: true, remark: '数据报表-统计报表', createTime: '2026-02-02 10:35:14' },
        { groupId: 12, itemId: 7, sortNo: 2, enabled: true, remark: '数据报表-消息中心', createTime: '2026-02-02 10:38:02' },
        { groupId: 14, itemId: 12, sortNo: 1, enabled: true, remark: '站点配置-站点配置', createTime: '2026-02-02 10:45:39' }
    ];

    /* ---------- 初始种子数据：部门组织架构（多层级） ----------
       parentId：上级部门 ID，0 表示顶级；level：层级（由 parentId 推导，1 级起）；
       sortNo：同级排序号；code：部门编号（DPT + 4 位流水号）；duty：部门职能说明 */
    var SEED_ORG = [
        { parentId: 0, level: 1, sortNo: 1, code: 'DPT0001', nameCn: '总经理办公室', duty: '负责公司整体经营决策、战略制定与跨部门协调。', enabled: true, createTime: '2026-10-31 09:10:00' },
        { parentId: 1, level: 2, sortNo: 1, code: 'DPT0002', nameCn: '技术研发部', duty: '负责产品架构设计、研发交付与技术攻关。', enabled: true, createTime: '2026-10-31 09:12:00' },
        { parentId: 2, level: 3, sortNo: 1, code: 'DPT0003', nameCn: '前端研发组', duty: '负责 Web / 移动端前端页面的开发与维护。', enabled: true, createTime: '2026-10-31 09:15:00' },
        { parentId: 2, level: 3, sortNo: 2, code: 'DPT0004', nameCn: '后端研发组', duty: '负责服务端接口、业务逻辑与数据持久化开发。', enabled: true, createTime: '2026-10-31 09:18:00' },
        { parentId: 1, level: 2, sortNo: 2, code: 'DPT0005', nameCn: '市场运营部', duty: '负责品牌推广、渠道运营与客户增长。', enabled: true, createTime: '2026-10-31 09:22:00' },
        { parentId: 1, level: 2, sortNo: 3, code: 'DPT0006', nameCn: '财务人事部', duty: '负责财务核算、薪酬发放与人事招聘管理。', enabled: true, createTime: '2026-10-31 09:26:00' }
    ];

    /* ---------- 初始种子数据：员工信息（工号 E + 5 位流水号，邮箱必填） ----------
       gender：1-男，2-女；status：1-在职 / 2-试用 / 0-离职；deptId 对应 SEED_ORG 的 id */
    /* ---------- 初始种子数据：部门负责人设置（dptmgrset：部门 ↔ 员工，一个部门仅一个负责人） ----------
       deptId 对应 SEED_ORG 的 id，empId 对应 SEED_EMP 生成后的 id（按顺序 1..6） */
    var SEED_DPTMGR = [
        { deptId: 2, empId: 1, remark: '' },        // 技术研发部 → 张守正
        { deptId: 5, empId: 2, remark: '兼任' }     // 市场运营部 → 李耘创
    ];

    var SEED_EMP = [
        { code: 'E00001', nameCn: '张守正', gender: 1, phone: '13800138001', email: 'zhangshouzheng@jiudou.com', deptId: 2, jobTitle: '研发总监', status: 1, hireDate: '2019-03-01',
          birthDate: '1985-04-12', idCard: '110101198504121234', education: '硕士', school: '清华大学', major: '计算机科学与技术',
          certificates: '信息系统项目管理师、系统架构设计师', titleName: '高级工程师', photo: '', remark: '负责技术研发部整体技术规划', createTime: '2026-10-31 09:30:00' },
        { code: 'E00002', nameCn: '李耘创', gender: 2, phone: '13800138002', email: 'liyunchuang@jiudou.com', deptId: 5, jobTitle: '市场运营经理', status: 1, hireDate: '2020-06-15',
          birthDate: '1990-08-23', idCard: '310101199008231567', education: '本科', school: '复旦大学', major: '市场营销',
          certificates: '中级经济师', titleName: '经济师', photo: '', remark: '负责品牌推广与渠道运营', createTime: '2026-10-31 09:32:00' },
        { code: 'E00003', nameCn: '王多云', gender: 1, phone: '13800138003', email: 'wangduoyun@jiudou.com', deptId: 4, jobTitle: '后端工程师', status: 1, hireDate: '2021-02-08',
          birthDate: '1988-11-05', idCard: '320101198811053456', education: '硕士', school: '南京大学', major: '软件工程',
          certificates: '系统分析师', titleName: '工程师', photo: '', remark: '负责服务端接口开发', createTime: '2026-10-31 09:34:00' },
        { code: 'E00004', nameCn: '赵小雨', gender: 2, phone: '13800138004', email: 'zhaoxiaoyu@jiudou.com', deptId: 3, jobTitle: '前端工程师', status: 2, hireDate: '2025-09-01',
          birthDate: '1997-02-18', idCard: '330101199702184567', education: '本科', school: '浙江大学', major: '数字媒体技术',
          certificates: '', titleName: '助理工程师', photo: '', remark: '试用期，负责 Web 前端页面', createTime: '2026-10-31 09:36:00' },
        { code: 'E00005', nameCn: '陈思远', gender: 1, phone: '13800138005', email: 'chensiyuan@jiudou.com', deptId: 2, jobTitle: '测试工程师', status: 1, hireDate: '2022-11-20',
          birthDate: '1993-06-30', idCard: '440101199306305678', education: '本科', school: '华南理工大学', major: '信息管理与信息系统',
          certificates: '软件评测师', titleName: '工程师', photo: '', remark: '负责自动化测试与质量看板', createTime: '2026-10-31 09:38:00' },
        { code: 'E00006', nameCn: '孙悦', gender: 2, phone: '13800138006', email: 'sunyue@jiudou.com', deptId: 6, jobTitle: '人事专员', status: 0, hireDate: '2018-07-05',
          birthDate: '1992-09-09', idCard: '420101199209096789', education: '大专', school: '武汉职业技术学院', major: '人力资源管理',
          certificates: '人力资源管理师（三级）', titleName: '助理经济师', photo: '', remark: '已离职，历史档案保留', createTime: '2026-10-31 09:40:00' }
    ];

    /* ==========================================================================
       通用本地数据服务：菜单项 / 菜单组共用
       cfg = {
         storeKey      localStorage 键名
         seed          种子数据
         label         业务名称（用于提示文案）
         uniqueFields  唯一性字段 [{field:'code', label:'编号'}, ...]
         boolFields    需要归一化为布尔的字段 ['enabled', 'hasChild']
         tree          是否树形业务（多层级）：true 时启用层级排序、上级校验、级联删除与 /tree
         fields        可写字段（新增 / 编辑时落库）
       }
       ========================================================================== */
    function createService(cfg) {
        var storeKey = cfg.storeKey;
        var memoryStore = null;   // localStorage 不可用时的内存兜底

        // 配置兜底：未声明的可选配置一律补默认值，避免各业务各写一份判空
        cfg.boolFields = cfg.boolFields || [];
        cfg.uniqueFields = cfg.uniqueFields || [];
        cfg.fields = cfg.fields || [];
        cfg.keywordFields = cfg.keywordFields || ['code', 'nameCn', 'nameEn'];

        /* ---------- 主键类型：默认自增整数；uuid=true 时用 UUID 字符串（用户角色等） ---------- */
        function newUuid() {
            try {
                if (window.crypto && window.crypto.randomUUID) { return window.crypto.randomUUID(); }
                if (window.crypto && window.crypto.getRandomValues) {
                    var buf = new Uint8Array(16);
                    window.crypto.getRandomValues(buf);
                    buf[6] = (buf[6] & 0x0f) | 0x40;
                    buf[8] = (buf[8] & 0x3f) | 0x80;
                    var hex = [];
                    for (var hx = 0; hx < 16; hx++) {
                        hex.push((buf[hx] + 0x100).toString(16).slice(1));
                    }
                    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
                        hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('');
                }
            } catch (e) { /* 忽略：退化到下面的伪随机实现 */ }
            // 兜底：时间戳 + 随机数，格式仍为标准 36 位 UUID
            var rnd = '';
            for (var ri = 0; rnd.length < 12; ri++) {
                rnd += Math.floor(Math.random() * 16).toString(16);
            }
            var ts = ('00000000' + (new Date().getTime()).toString(16)).slice(-8);
            return ts + '-4000-8000-' + rnd.slice(0, 4) + '-' + (rnd.slice(4, 16) + '000000000000').slice(0, 12);
        }
        /** 主键比较：uuid 用字符串严格相等，自增用数值相等 */
        function idEquals(a, b) {
            return cfg.uuid ? String(a) === String(b) : Number(a) === Number(b);
        }
        /** 把请求里的 id 解析成存储中的主键类型 */
        function idOf(value) {
            if (cfg.uuid) { return String(value == null ? '' : value); }
            return parseInt(value, 10);
        }

        /* ---------- 本地存储（Mock 数据源） ---------- */
        function readStore() {
            try {
                var raw = window.localStorage.getItem(storeKey);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { /* 忽略：隐私模式 / file 协议限制 */ }
            if (memoryStore) { return memoryStore; }
            var seed = clone(cfg.seed);
            for (var i = 0; i < seed.length; i++) {
                if (cfg.uuid) {
                    if (!seed[i].id) { seed[i].id = newUuid(); }     // uuid 业务可用种子里的固定 id
                } else {
                    seed[i].id = i + 1;
                }
                seed[i].updateTime = seed[i].createTime;
            }
            memoryStore = seed;
            return seed;
        }
        function writeStore(list) {
            memoryStore = list;
            try { window.localStorage.setItem(storeKey, JSON.stringify(list)); } catch (e) { }
        }
        function nextId(list) {
            var max = 0;
            for (var i = 0; i < list.length; i++) { if (list[i].id > max) { max = list[i].id; } }
            return max + 1;
        }
        /* 布尔字段归一化：前端可能传 1/0、"true"、true */
        function normalize(item) {
            for (var i = 0; i < cfg.boolFields.length; i++) {
                var f = cfg.boolFields[i];
                if (item[f] === undefined) { continue; }
                item[f] = (item[f] === true || item[f] === 1 || item[f] === '1' || item[f] === 'true');
            }
            return item;
        }

        /* ---------- 层级工具（仅树形业务，如菜单组） ---------- */
        var MAX_LEVEL = 5;
        function pidOf(item) { return parseInt(item.parentId, 10) || 0; }

        /* 全部后代（子、孙…）ID */
        function descendantIds(list, id) {
            var out = [], stack = [id], i;
            while (stack.length) {
                var cur = stack.pop();
                for (i = 0; i < list.length; i++) {
                    if (pidOf(list[i]) === cur && list[i].id !== cur && out.indexOf(list[i].id) < 0) {
                        out.push(list[i].id);
                        stack.push(list[i].id);
                    }
                }
            }
            return out;
        }
        /* 后代中处于「启用状态」的节点（子、孙…；停用的下级仍继续向下检查） */
        function enabledDescendants(list, id) {
            var out = [], stack = [id], i;
            while (stack.length) {
                var cur = stack.pop();
                for (i = 0; i < list.length; i++) {
                    if (pidOf(list[i]) === cur && list[i].id !== cur && list[i].id !== id) {
                        if (Number(list[i].enabled)) { out.push(list[i]); }
                        stack.push(list[i].id);
                    }
                }
            }
            return out;
        }
        /* 停用 / 删除保护：还有启用的下级时返回错误提示，可放行时返回 null */
        function enabledChildError(list, id, action) {
            var kids = enabledDescendants(list, id), names = [], i;
            if (!kids.length) { return null; }
            for (i = 0; i < kids.length && i < 3; i++) { names.push(kids[i].nameCn); }
            return '该' + cfg.label + '下还有 ' + kids.length + ' 个启用状态的下级' + cfg.label
                + '（' + names.join('、') + (kids.length > 3 ? '等' : '') + '），请先停用这些下级' + cfg.label + '后再' + action;
        }
        /* 由上级推导层级：顶级=1；上级不存在返回 0 */
        function levelOfParent(list, parentId) {
            if (!parentId) { return 1; }
            for (var i = 0; i < list.length; i++) {
                if (list[i].id === parentId) { return (parseInt(list[i].level, 10) || 1) + 1; }
            }
            return 0;
        }
        /* 平铺排序：按「排序号 sortNo」升序，同序号按 id 升序（菜单组列表 / 菜单项列表共用口径） */
        function flatSortNo(list) {
            return list.slice().sort(function (a, b) {
                var sa = parseInt(a.sortNo, 10), sb = parseInt(b.sortNo, 10);
                if (isNaN(sa)) { sa = 0; }
                if (isNaN(sb)) { sb = 0; }
                return (sa - sb) || (a.id - b.id);
            });
        }
        /* 排序：有关键字 → 命中记录按层级排序；无关键字 → 树形深度优先（父紧跟子） */
        function treeSort(list, kw) {
            var arr = list.slice(), i;
            function byOrder(a, b) {
                var la = parseInt(a.level, 10) || 1, lb = parseInt(b.level, 10) || 1;
                var sa = parseInt(a.sortNo, 10) || 0, sb = parseInt(b.sortNo, 10) || 0;
                if (la !== lb) { return la - lb; }
                if (sa !== sb) { return sa - sb; }
                return a.id - b.id;
            }
            if (kw) { arr.sort(byOrder); return arr; }
            var ids = {}, children = {};
            for (i = 0; i < arr.length; i++) { ids[arr[i].id] = true; }
            for (i = 0; i < arr.length; i++) {
                var p = pidOf(arr[i]);
                if (!children[p]) { children[p] = []; }
                children[p].push(arr[i]);
            }
            for (var key in children) { if (children.hasOwnProperty(key)) { children[key].sort(byOrder); } }
            var out = [];
            function walk(node) {
                out.push(node);
                var kids = children[node.id] || [];
                for (var k = 0; k < kids.length; k++) { walk(kids[k]); }
            }
            var roots = [];
            for (i = 0; i < arr.length; i++) { if (!ids[pidOf(arr[i])]) { roots.push(arr[i]); } }
            roots.sort(byOrder);
            for (i = 0; i < roots.length; i++) { walk(roots[i]); }
            return out;
        }
        /* 上级变更后，逐层刷新子孙 level */
        function syncDescendantLevel(list, rootId) {
            var levelMap = {}, i, stack = [rootId];
            for (i = 0; i < list.length; i++) { levelMap[list[i].id] = parseInt(list[i].level, 10) || 1; }
            while (stack.length) {
                var cur = stack.pop();
                for (i = 0; i < list.length; i++) {
                    if (pidOf(list[i]) === cur && list[i].id !== cur) {
                        list[i].level = (levelMap[cur] || 1) + 1;
                        levelMap[list[i].id] = list[i].level;
                        stack.push(list[i].id);
                    }
                }
            }
        }
        /* 补充层级展示字段：上级名称、下级数量、层级全路径 */
        function decorate(list, item) {
            var pid = pidOf(item), pname = '', chain = [], count = 0, i, j;
            for (i = 0; i < list.length; i++) {
                if (pidOf(list[i]) === item.id) { count++; }
                if (list[i].id === pid) { pname = list[i].nameCn; }
            }
            var cur = pid, guard = 0;
            while (cur && guard < MAX_LEVEL + 2) {
                var found = null;
                for (j = 0; j < list.length; j++) { if (list[j].id === cur) { found = list[j]; break; } }
                if (!found) { break; }
                chain.unshift(found.nameCn);
                cur = pidOf(found);
                guard++;
            }
            var copy = clone(item);
            copy.level = parseInt(copy.level, 10) || 1;
            copy.parentName = pname;
            copy.childCount = count;
            copy.pathNames = chain.join(' / ');
            return copy;
        }

        /* 输出前的统一装饰：树形业务补层级字段，业务可再用 cfg.decorateItem 追加展示字段 */
        function outItem(list, item) {
            var copy = cfg.tree ? decorate(list, item) : clone(item);
            if (cfg.decorateItem) { cfg.decorateItem(copy, list); }
            return copy;
        }

        /* ---------- Mock 路由（path 已去掉服务前缀） ---------- */
        function route(method, path, params) {
            var list = readStore();

            // 1. 分页查询
            if (path === '/list' && method === 'GET') {
                var kw = (params.keyword || '').replace(/^\s+|\s+$/g, '');
                var kwFields = cfg.keywordFields || ['code', 'nameCn', 'nameEn'];
                var enabledFilter = (params.enabled === '' || params.enabled === undefined || params.enabled === null)
                    ? null : (params.enabled === '1' || params.enabled === 1 || params.enabled === 'true' || params.enabled === true);
                var rows = [];
                for (var f = 0; f < list.length; f++) {
                    var cur = list[f];
                    if (enabledFilter !== null && !!cur.enabled !== enabledFilter) { continue; }
                    if (kw) {
                        var hit = false;
                        for (var kf = 0; kf < kwFields.length; kf++) {
                            if (like(cur[kwFields[kf]], kw)) { hit = true; break; }
                        }
                        if (!hit) { continue; }
                    }
                    if (cfg.matchExtra && !cfg.matchExtra(cur, params)) { continue; }
                    rows.push(cur);
                }
                // 树形业务：listFlatSort=true → 按「排序号」平铺升序；treeKwDfs=true → 始终深度优先（含检索，
                // 命中行的高级不在批次内时作为局部根，与后端 _sorted_forest 同口径）；否则检索命中行按层级深浅排序
                if (cfg.tree) {
                    rows = cfg.listFlatSort ? flatSortNo(rows)
                        : (cfg.treeKwDfs ? treeSort(rows, '') : treeSort(rows, kw));
                }
                else if (cfg.sortBy) { rows.sort(cfg.sortBy); }
                var pageNum = parseInt(params.pageNum, 10) || 1;
                var pageSize = parseInt(params.pageSize, 10) || 10;
                var total = rows.length;
                var pages = Math.max(1, Math.ceil(total / pageSize));
                if (pageNum > pages) { pageNum = pages; }
                var start = (pageNum - 1) * pageSize;
                var pageRows = [], seg = rows.slice(start, start + pageSize);
                for (var s = 0; s < seg.length; s++) {
                    pageRows.push(outItem(list, seg[s]));
                }
                return {
                    code: 0, message: 'ok',
                    data: {
                        list: pageRows,
                        total: total, pageNum: pageNum, pageSize: pageSize, pages: pages
                    }
                };
            }

            // 1b. 层级下拉数据（仅树形业务）：按树形顺序返回，label 已带缩进
            if (path === '/tree' && method === 'GET' && cfg.tree) {
                var exId = parseInt(params.excludeId, 10) || 0;
                var banned = [];
                if (exId) { banned = descendantIds(list, exId).concat([exId]); }
                var ordered = treeSort(list, '');
                var items = [];
                if (cfg.rootOption) {           // 部门等需要「无上级」选项的业务
                    var topCount = 0;
                    for (var tj = 0; tj < list.length; tj++) { if (pidOf(list[tj]) === 0) { topCount++; } }
                    items.push({
                        id: 0, parentId: 0, level: 0, code: '', nameCn: '（顶级部门）',
                        childCount: topCount, leaf: true, label: '（顶级部门，无上级）'
                    });
                }
                for (var ti = 0; ti < ordered.length; ti++) {
                    var it = ordered[ti];
                    if (banned.indexOf(it.id) >= 0) { continue; }
                    var lv = parseInt(it.level, 10) || 1;
                    var indent = new Array(lv).join('　') + (lv > 1 ? '└ ' : '');
                    var cc = 0;
                    for (var cj = 0; cj < list.length; cj++) { if (pidOf(list[cj]) === it.id) { cc++; } }
                    items.push({
                        id: it.id, parentId: pidOf(it), level: lv, code: it.code,
                        nameCn: it.nameCn, nameEn: it.nameEn, childCount: cc, hasChild: !!it.hasChild,
                        leaf: cc === 0,                     // 无下级节点即叶子节点
                        label: indent + it.nameCn + '（' + it.code + '）'
                    });
                }
                return { code: 0, message: 'ok', data: { list: items } };
            }

            // 2. 详情
            if (path.indexOf('/detail') === 0 && method === 'GET') {
                var id = idOf(params.id);
                for (var j = 0; j < list.length; j++) {
                    if (idEquals(list[j].id, id)) {
                        return { code: 0, message: 'ok', data: outItem(list, list[j]) };
                    }
                }
                return { code: 404, message: cfg.label + '不存在或已被删除' };
            }

            // 3. 唯一性校验  field=code|nameEn  value=值  id=排除自身(编辑时)
            if (path === '/check' && method === 'GET') {
                var field = params.field, val = String(params.value || '').toLowerCase(), selfId = idOf(params.id);
                if (cfg.customCheck) {
                    var custom = cfg.customCheck(field, val, params, list);
                    if (custom !== undefined && custom !== null) {
                        return { code: 0, message: 'ok', data: { unique: !!custom } };
                    }
                }
                var unique = true;
                for (var k = 0; k < list.length; k++) {
                    if (idEquals(list[k].id, selfId)) { continue; }
                    if (String(list[k][field] || '').toLowerCase() === val && val !== '') { unique = false; break; }
                }
                return { code: 0, message: 'ok', data: { unique: unique } };
            }

            // 3b. 编号自动生成（MNU + 5 位流水号）：取库中最大流水号 +1，冲突顺延
            if (path === '/nextcode' && method === 'GET') {
                var prefix = cfg.codePrefix || 'MNU';
                var digits = parseInt(cfg.codeDigits, 10) || 5;
                var maxSeq = 0;
                var reCode = new RegExp('^' + prefix + '(\\d{' + digits + '})$');
                for (var ci = 0; ci < list.length; ci++) {
                    var matched = reCode.exec(String(list[ci].code || '').toUpperCase());
                    if (matched) {
                        var seq = parseInt(matched[1], 10);
                        if (seq > maxSeq) { maxSeq = seq; }
                    }
                }
                var nextSeq = maxSeq + 1;
                var limit = Math.pow(10, digits) - 1;
                var genCode = '';
                while (nextSeq <= limit) {
                    var tmp = prefix + padNum(nextSeq, digits);
                    var dup = false;
                    for (var di = 0; di < list.length; di++) {
                        if (String(list[di].code || '').toUpperCase() === tmp) { dup = true; break; }
                    }
                    if (!dup) { genCode = tmp; break; }
                    nextSeq++;
                }
                if (!genCode) {
                    return { code: 500, message: '编号已超出上限（' + prefix + limit + '），请联系管理员' };
                }
                return { code: 0, message: 'ok', data: { code: genCode } };
            }

            // 4. 新增
            if (path === '/add' && method === 'POST') {
                var item = normalize(clone(params));
                // 业务自定义校验（可在其中做归一化，如工号转大写、邮箱转小写）
                if (cfg.validateItem) {
                    var addErr = cfg.validateItem(item, list, 0);
                    if (addErr) { return { code: 500, message: addErr }; }
                }
                for (var m = 0; m < list.length; m++) {
                    for (var u = 0; u < cfg.uniqueFields.length; u++) {
                        var uf = cfg.uniqueFields[u];
                        if (String(list[m][uf.field] || '').toLowerCase() === String(item[uf.field] || '').toLowerCase()
                            && String(item[uf.field] || '') !== '') {
                            return { code: 500, message: uf.label + '已存在，请重新填写' };
                        }
                    }
                }
                // 树形业务：校验上级菜单组并推导层级
                if (cfg.tree) {
                    var tParent = parseInt(item.parentId, 10) || 0;
                    var tLevel = tParent ? levelOfParent(list, tParent) : 1;
                    if (tParent && !tLevel) { return { code: 500, message: '上级' + cfg.label + '不存在或已被删除' }; }
                    if (tLevel > MAX_LEVEL) { return { code: 500, message: '最多支持 ' + MAX_LEVEL + ' 级' + cfg.label }; }
                    item.parentId = tParent;
                    item.level = tLevel;
                    item.sortNo = parseInt(item.sortNo, 10) || 0;
                }
                delete item.id;
                item.id = cfg.uuid ? newUuid() : nextId(list);
                item.createTime = now();
                item.updateTime = item.createTime;
                var blank = {};
                for (var b = 0; b < cfg.fields.length; b++) {
                    blank[cfg.fields[b]] = item[cfg.fields[b]] === undefined ? '' : item[cfg.fields[b]];
                }
                blank.id = item.id;
                blank.createTime = item.createTime;
                blank.updateTime = item.updateTime;
                normalize(blank);
                list.push(blank);
                if (cfg.tree && blank.parentId) {      // 挂到上级之下后，上级必然「可否绑定菜单项=是」
                    for (var pj = 0; pj < list.length; pj++) {
                        if (list[pj].id === blank.parentId) { list[pj].hasChild = true; break; }
                    }
                }
                writeStore(list);
                return { code: 0, message: '新增成功', data: outItem(list, blank) };
            }

            // 5. 编辑
            if (path === '/update' && method === 'POST') {
                var u2 = normalize(clone(params));
                var uid = idOf(u2.id), target = null;
                for (var n = 0; n < list.length; n++) {
                    if (idEquals(list[n].id, uid)) { target = list[n]; break; }
                }
                if (!target) { return { code: 404, message: cfg.label + '不存在或已被删除' }; }
                // 业务自定义校验（可在其中做归一化，如工号转大写、邮箱转小写）
                if (cfg.validateItem) {
                    var updErr = cfg.validateItem(u2, list, uid);
                    if (updErr) { return { code: 500, message: updErr }; }
                }
                // 停用保护：后代中还有启用状态的记录时不允许停用本条（如：部门有启用子部门）
                if (cfg.guardEnabledChildren && Number(target.enabled) && !Number(u2.enabled)) {
                    var offErr = enabledChildError(list, uid, '停用本' + cfg.label);
                    if (offErr) { return { code: 500, message: offErr }; }
                }
                // 树形业务：上级不能是自身或自己的下级（防环），并重新推导层级
                if (cfg.tree) {
                    var uParent = parseInt(u2.parentId, 10) || 0;
                    if (uParent === uid) { return { code: 500, message: '上级' + cfg.label + '不能是自身' }; }
                    var uDesc = descendantIds(list, uid);
                    if (uParent && uDesc.indexOf(uParent) >= 0) {
                        return { code: 500, message: '不能把' + cfg.label + '移动到自己的下级' + cfg.label + '之下' };
                    }
                    var uLevel = uParent ? levelOfParent(list, uParent) : 1;
                    if (uParent && !uLevel) { return { code: 500, message: '上级' + cfg.label + '不存在或已被删除' }; }
                    if (uLevel > MAX_LEVEL) { return { code: 500, message: '最多支持 ' + MAX_LEVEL + ' 级' + cfg.label }; }
                    u2.parentId = uParent;
                    u2.level = uLevel;
                    u2.sortNo = parseInt(u2.sortNo, 10) || 0;
                    if (uDesc.length) { u2.hasChild = true; }   // 已有下级 → 强制「可否绑定菜单项=是」
                }
                for (var p = 0; p < list.length; p++) {
                    if (idEquals(list[p].id, uid)) { continue; }
                    for (var u3 = 0; u3 < cfg.uniqueFields.length; u3++) {
                        var uf3 = cfg.uniqueFields[u3];
                        if (String(list[p][uf3.field] || '').toLowerCase() === String(u2[uf3.field] || '').toLowerCase()
                            && String(u2[uf3.field] || '') !== '') {
                            return { code: 500, message: uf3.label + '已存在，请重新填写' };
                        }
                    }
                }
                for (var q = 0; q < cfg.fields.length; q++) {
                    var fd = cfg.fields[q];
                    if (u2[fd] === undefined) { continue; }
                    target[fd] = u2[fd];
                }
                normalize(target);
                target.updateTime = now();
                if (cfg.tree) { syncDescendantLevel(list, uid); }
                writeStore(list);
                return { code: 0, message: '修改成功', data: outItem(list, target) };
            }

            // 6. 删除
            if (path === '/delete' && method === 'POST') {
                var did = idOf(params.id), idx = -1;
                for (var r = 0; r < list.length; r++) { if (idEquals(list[r].id, did)) { idx = r; break; } }
                if (idx < 0) { return { code: 404, message: cfg.label + '不存在或已被删除' }; }
                var removed = list[idx];
                // 删除保护：后代中还有启用状态的记录时不允许删除（含级联删除）
                if (cfg.guardEnabledChildren) {
                    var delErr = enabledChildError(list, did, '删除本' + cfg.label);
                    if (delErr) { return { code: 500, message: delErr }; }
                }
                if (cfg.tree) {
                    var kids = descendantIds(list, did);
                    var cascade = (params.cascade === true || params.cascade === 1 || params.cascade === '1' || params.cascade === 'true');
                    if (kids.length && !cascade) {
                        return { code: 500, message: '该' + cfg.label + '下还有 ' + kids.length + ' 个下级' + cfg.label + '，请先删除下级，或使用级联删除' };
                    }
                    var delIds = kids.concat([did]);
                    var rest = [];
                    for (var q = 0; q < list.length; q++) { if (delIds.indexOf(list[q].id) < 0) { rest.push(list[q]); } }
                    writeStore(rest);
                    return { code: 0, message: '删除成功', data: outItem(list, removed) };
                }
                list.splice(idx, 1);
                writeStore(list);
                return { code: 0, message: '删除成功', data: outItem(list, removed) };
            }

            return { code: 404, message: '接口不存在：' + path };
        }

        /* 原始数据（不做 decorateItem 装饰）：供其它服务做关联查询，避免「装饰 → 关联 → 再装饰」的循环调用 */
        function listRaw() { return readStore(); }

        return { route: route, listRaw: listRaw };
    }

    /* ==========================================================================
       菜单组项目设置服务（菜单组 ↔ 菜单项）
       --------------------------------------------------------------------------
       · 与后端 GroupItemService 一一对应：查询必须带 groupId，只返回启用状态的菜单项；
       · add 为批量追加（已存在则更新显示序号），update 为全量同步（移除未勾选的）；
       · Mock 模式下通过 menuSvc / groupSvc 的 /list 读取菜单项与菜单组信息做关联展示。
       ========================================================================== */
    function createGroupItemService(menuSvc, groupSvc) {
        var storeKey = 'menu_admin_groupitem_store_v1';
        var memoryStore = null;

        function readStore() {
            try {
                var raw = window.localStorage.getItem(storeKey);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            if (memoryStore) { return memoryStore; }
            var seed = clone(SEED_GROUP_ITEM);
            for (var i = 0; i < seed.length; i++) {
                seed[i].id = i + 1;
                seed[i].updateTime = seed[i].createTime;
            }
            memoryStore = seed;
            return seed;
        }
        function writeStore(list) {
            memoryStore = list;
            try { window.localStorage.setItem(storeKey, JSON.stringify(list)); } catch (e) { }
        }
        function nextId(list) {
            var max = 0;
            for (var i = 0; i < list.length; i++) { if (list[i].id > max) { max = list[i].id; } }
            return max + 1;
        }

        /* 以 ID 为键索引菜单项 / 菜单组（复用各自 Mock 服务的查询结果） */
        function indexOf(svc, params) {
            var res = svc.route('GET', '/list', params || { pageSize: 200 });
            var rows = (res && res.data && res.data.list) || [];
            var map = {};
            for (var i = 0; i < rows.length; i++) { map[rows[i].id] = rows[i]; }
            return map;
        }
        function join(row, menus, groups) {
            var m = menus[row.itemId] || {};
            var g = groups[row.groupId] || {};
            return {
                id: row.id, groupId: row.groupId, itemId: row.itemId,
                sortNo: parseInt(row.sortNo, 10) || 0,
                enabled: row.enabled === false ? false : true,
                remark: row.remark || '',
                createTime: row.createTime || '', updateTime: row.updateTime || '',
                itemCode: m.code || '', itemNameCn: m.nameCn || '', itemNameEn: m.nameEn || '',
                itemPath: m.path || '', itemIcon: m.icon || '',
                itemEnabled: m.enabled === false ? false : true, itemRemark: m.remark || '',
                groupCode: g.code || '', groupNameCn: g.nameCn || ''
            };
        }
        /* 当前菜单组下的全部记录（按显示序号排序，只含启用状态的菜单项） */
        function listOfGroup(list, groupId, menus, groups, kw) {
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                if (parseInt(list[i].groupId, 10) !== groupId) { continue; }
                var one = join(list[i], menus, groups);
                if (!one.itemEnabled) { continue; }
                if (kw && !(like(one.itemCode, kw) || like(one.itemNameCn, kw) || like(one.itemNameEn, kw))) { continue; }
                rows.push(one);
            }
            rows.sort(function (a, b) {
                if (a.sortNo !== b.sortNo) { return a.sortNo - b.sortNo; }
                return a.id - b.id;
            });
            return rows;
        }

        /* 提交的菜单项 → [{itemId, sortNo}]（去重，以最后一次为准） */
        function parseItems(data) {
            var raw = data.items, pairs = [], i;
            if (Object.prototype.toString.call(raw) === '[object Array]') {
                for (i = 0; i < raw.length; i++) {
                    var one = raw[i] || {};
                    var itemId = parseInt(one.itemId, 10) || 0;
                    if (itemId <= 0) { continue; }
                    pairs.push({ itemId: itemId, sortNo: parseInt(one.sortNo, 10) || 0 });
                }
            }
            var uniq = {}, order = [];
            for (i = 0; i < pairs.length; i++) {
                if (uniq[pairs[i].itemId] === undefined) { order.push(pairs[i].itemId); }
                uniq[pairs[i].itemId] = pairs[i].sortNo;
            }
            var out = [];
            for (i = 0; i < order.length; i++) { out.push({ itemId: order[i], sortNo: uniq[order[i]] }); }
            return out;
        }

        function route(method, path, params) {
            var list = readStore();
            var menus = indexOf(menuSvc, { pageSize: 200 });

            // 1. 分页查询（必须指定菜单组）
            if (path === '/list' && method === 'GET') {
                var gid = parseInt(params.groupId, 10) || 0;
                if (!gid) { return { code: 500, message: '请先选择菜单组' }; }
                var kw = (params.keyword || '').replace(/^\s+|\s+$/g, '');
                var rows = listOfGroup(list, gid, menus, indexOf(groupSvc, { pageSize: 200 }), kw);
                var pageNum = parseInt(params.pageNum, 10) || 1;
                var pageSize = parseInt(params.pageSize, 10) || 10;
                var total = rows.length;
                var pages = Math.max(1, Math.ceil(total / pageSize));
                if (pageNum > pages) { pageNum = pages; }
                var start = (pageNum - 1) * pageSize;
                return {
                    code: 0, message: 'ok',
                    data: {
                        list: rows.slice(start, start + pageSize),
                        total: total, pageNum: pageNum, pageSize: pageSize, pages: pages, groupId: gid
                    }
                };
            }

            // 2. 详情
            if (path.indexOf('/detail') === 0 && method === 'GET') {
                var id = parseInt(params.id, 10);
                for (var d = 0; d < list.length; d++) {
                    if (list[d].id === id) { return { code: 0, message: 'ok', data: join(list[d], menus, indexOf(groupSvc, { pageSize: 200 })) }; }
                }
                return { code: 404, message: '菜单组项目不存在或已被删除' };
            }

            // 3. 批量新增（已存在的只更新显示序号）
            if (path === '/add' && method === 'POST') {
                return save(list, menus, params, false);
            }

            // 4. 全量同步（新增 / 更新序号 / 移除未勾选的）
            if (path === '/update' && method === 'POST') {
                return save(list, menus, params, true);
            }

            // 5. 删除单条
            if (path === '/delete' && method === 'POST') {
                var did = parseInt(params.id, 10), idx = -1;
                for (var r = 0; r < list.length; r++) { if (list[r].id === did) { idx = r; break; } }
                if (idx < 0) { return { code: 404, message: '菜单组项目不存在或已被删除' }; }
                var removed = join(list[idx], menus, indexOf(groupSvc, { pageSize: 200 }));
                list.splice(idx, 1);
                writeStore(list);
                return { code: 0, message: '删除成功', data: removed };
            }

            return { code: 404, message: '接口不存在：' + path };
        }

        /* add（replace=false）/ update（replace=true）共用：差异只在是否移除未勾选的记录 */
        function save(list, menus, params, replace) {
            var gid = parseInt(params.groupId, 10) || 0;
            if (!gid) { return { code: 500, message: '请先选择菜单组' }; }
            var exists = indexOf(groupSvc, { pageSize: 200 });
            if (!exists[gid]) { return { code: 500, message: '菜单组不存在或已被删除' }; }
            var pairs = parseItems(params);
            if (!replace && !pairs.length) { return { code: 500, message: '请至少选择一个菜单项' }; }
            var i, j;
            for (i = 0; i < pairs.length; i++) {
                var m = menus[pairs[i].itemId];
                if (!m) { return { code: 500, message: '菜单项不存在或已被删除：ID=' + pairs[i].itemId }; }
                if (!m.enabled) { return { code: 500, message: '菜单项【' + m.nameCn + '】已停用，不能加入菜单组' }; }
            }

            var added = 0, updated = 0, removed = 0;
            var wanted = {};
            for (i = 0; i < pairs.length; i++) { wanted[pairs[i].itemId] = pairs[i].sortNo; }

            for (i = 0; i < pairs.length; i++) {
                var hit = -1;
                for (j = 0; j < list.length; j++) {
                    if (parseInt(list[j].groupId, 10) === gid && parseInt(list[j].itemId, 10) === pairs[i].itemId) { hit = j; break; }
                }
                if (hit >= 0) {
                    if ((parseInt(list[hit].sortNo, 10) || 0) !== pairs[i].sortNo) {
                        list[hit].sortNo = pairs[i].sortNo;
                        list[hit].updateTime = now();
                        updated++;
                    }
                } else {
                    list.push({
                        id: nextId(list), groupId: gid, itemId: pairs[i].itemId, sortNo: pairs[i].sortNo,
                        enabled: true, remark: '', createTime: now(), updateTime: now()
                    });
                    added++;
                }
            }
            if (replace) {
                var rest = [];
                for (j = 0; j < list.length; j++) {
                    var keep = true;
                    if (parseInt(list[j].groupId, 10) === gid && wanted[parseInt(list[j].itemId, 10)] === undefined) { keep = false; }
                    if (keep) { rest.push(list[j]); } else { removed++; }
                }
                list = rest;
            }
            writeStore(list);
            return {
                code: 0, message: replace ? '修改成功' : '新增成功',
                data: {
                    groupId: gid, added: added, updated: updated, removed: removed,
                    list: listOfGroup(list, gid, menus, indexOf(groupSvc, { pageSize: 200 }), '')
                }
            };
        }

        return { route: route };
    }
    /* ==========================================================================
       角色权限（菜单权限 usergrouppowerset + 按钮权限 usergrouppagebtnset）
       --------------------------------------------------------------------------
       · 与后端 RolePowerService 同口径：list / tree / buttons / save / clear
       · 权限树 = 启用的菜单组 + 组内绑定的启用菜单项（顺序与左侧导航一致），
         每个菜单项（页面）下再挂该页面的操作按钮（pageopbtn，按 pagePath 关联）
       · 保存 = 一次提交菜单权限 + 按钮权限（全量替换）
       · 首次使用时默认把全部菜单项（不含按钮）授予「系统管理员」，方便演示
       ========================================================================== */
    function createRolePowerService(roleSvc, groupSvc, menuSvc, groupItemSvc, pageOpBtnSvc) {
        var storeKey = 'menu_admin_role_power_store_v1';
        var btnStoreKey = 'menu_admin_role_pagebtn_store_v1';
        var memoryStore = null;
        var btnMemory = null;

        function writeStore(list) {
            memoryStore = list;
            try { window.localStorage.setItem(storeKey, JSON.stringify(list)); } catch (e) { }
        }
        function writeBtnStore(list) {
            btnMemory = list;
            try { window.localStorage.setItem(btnStoreKey, JSON.stringify(list)); } catch (e) { }
        }
        function readBtnStore() {
            var list = null;
            try {
                var raw = window.localStorage.getItem(btnStoreKey);
                if (raw) { list = JSON.parse(raw); }
            } catch (e) { }
            if (!list) {
                if (btnMemory) { return btnMemory; }
                list = [];
                writeBtnStore(list);
            }
            return list;
        }

        /* 菜单组 / 菜单项 / 绑定关系（只取启用状态） */
        function meta() {
            var gRes = groupSvc.route('GET', '/list', { pageNum: 1, pageSize: 500 });
            var gRows = (gRes && gRes.data && gRes.data.list) || [];
            var mRes = menuSvc.route('GET', '/list', { pageNum: 1, pageSize: 500 });
            var mRows = (mRes && mRes.data && mRes.data.list) || [];
            var groups = {}, items = [], binds = [], i, j;
            for (i = 0; i < gRows.length; i++) {
                if (!gRows[i].enabled) { continue; }
                groups[parseInt(gRows[i].id, 10)] = {
                    id: parseInt(gRows[i].id, 10),
                    parentId: parseInt(gRows[i].parentId, 10) || 0,
                    level: parseInt(gRows[i].level, 10) || 1,
                    sortNo: parseInt(gRows[i].sortNo, 10) || 0,
                    code: gRows[i].code || '',
                    nameCn: gRows[i].nameCn || ''
                };
            }
            for (i = 0; i < mRows.length; i++) {
                if (!mRows[i].enabled) { continue; }
                items.push({
                    id: parseInt(mRows[i].id, 10),
                    code: mRows[i].code || '',
                    nameCn: mRows[i].nameCn || '',
                    path: mRows[i].path || '',
                    sortNo: parseInt(mRows[i].sortNo, 10) || 0
                });
            }
            var itemMap = {};
            for (i = 0; i < items.length; i++) { itemMap[items[i].id] = items[i]; }
            for (i in groups) {
                if (!groups.hasOwnProperty(i)) { continue; }
                var res = groupItemSvc.route('GET', '/list', { groupId: groups[i].id, pageSize: 200 });
                var rows = (res && res.data && res.data.list) || [];
                for (j = 0; j < rows.length; j++) {
                    var iid = parseInt(rows[j].itemId, 10);
                    if (!itemMap[iid]) { continue; }
                    binds.push({ groupId: groups[i].id, itemId: iid, sortNo: parseInt(rows[j].sortNo, 10) || 0 });
                }
            }
            binds.sort(function (a, b) {
                return (a.groupId - b.groupId) || (a.sortNo - b.sortNo) || (a.itemId - b.itemId);
            });
            return { groups: groups, items: items, itemMap: itemMap, binds: binds };
        }

        /* 页面操作按钮：pagePath → [{pageOpBtnId, btnId, btnText}]（只取启用且页面里仍存在的） */
        function btnMap() {
            var res = pageOpBtnSvc.route('GET', '/list', { pageNum: 1, pageSize: 500 });
            var rows = (res && res.data && res.data.list) || [];
            var out = {};
            for (var i = 0; i < rows.length; i++) {
                var it = rows[i];
                if (it.enabled === false || it.missing) { continue; }
                if (!out[it.pagePath]) { out[it.pagePath] = []; }
                out[it.pagePath].push({
                    pageOpBtnId: String(it.id), btnId: it.btnId, btnText: it.btnText,
                    sortNo: parseInt(it.sortNo, 10) || 0
                });
            }
            return out;
        }

        function sortChain(groups, gid) {
            var chain = [], seen = {}, cur = gid;
            while (cur && groups[cur] && !seen[cur]) {
                seen[cur] = true;
                chain.unshift(groups[cur].sortNo);
                cur = groups[cur].parentId;
            }
            return chain;
        }
        function groupPath(groups, gid) {
            var names = [], seen = {}, cur = gid;
            while (cur && groups[cur] && !seen[cur]) {
                seen[cur] = true;
                names.unshift(groups[cur].nameCn);
                cur = groups[cur].parentId;
            }
            return names.join('/');
        }
        function cmpChain(a, b) {
            var n = Math.min(a.length, b.length);
            for (var i = 0; i < n; i++) { if (a[i] !== b[i]) { return a[i] - b[i]; } }
            return a.length - b.length;
        }

        function readStore() {
            var list = null;
            try {
                var raw = window.localStorage.getItem(storeKey);
                if (raw) { list = JSON.parse(raw); }
            } catch (e) { }
            if (!list) {
                if (memoryStore) { return memoryStore; }
                list = [];
                var m = meta();
                for (var i = 0; i < m.binds.length; i++) {       // 首次：系统管理员拥有全部菜单权限
                    list.push({
                        id: mockUuid(), roleId: MOCK_ADMIN_ROLE_ID,
                        menuGroupId: m.binds[i].groupId, menuItemId: m.binds[i].itemId,
                        enabled: true, remark: '', createTime: now(), updateTime: now()
                    });
                }
                writeStore(list);
                return list;
            }
            // 惰性清理：角色已被删除的授权记录不再保留
            var roleRes = roleSvc.route('GET', '/list', { pageNum: 1, pageSize: 500 });
            var roleRows = (roleRes && roleRes.data && roleRes.data.list) || [];
            var alive = {};
            for (var r = 0; r < roleRows.length; r++) { alive[String(roleRows[r].id)] = true; }
            var kept = [], changed = false;
            for (var k = 0; k < list.length; k++) {
                if (alive[String(list[k].roleId)]) { kept.push(list[k]); } else { changed = true; }
            }
            if (changed) { writeStore(kept); return kept; }
            return list;
        }

        function roleOf(roleId) {
            var res = roleSvc.route('GET', '/list', { pageNum: 1, pageSize: 500 });
            var rows = (res && res.data && res.data.list) || [];
            for (var i = 0; i < rows.length; i++) {
                if (String(rows[i].id) === String(roleId)) { return rows[i]; }
            }
            return null;
        }
        function isUuid(v) {
            return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(v));
        }

        function route(method, path, params) {
            params = params || {};
            var roleId = String(params.roleId == null ? '' : params.roleId);
            if (!isUuid(roleId)) {
                return { code: 500, message: '参数 roleId 不合法（应为 UUID）' };
            }
            var role = roleOf(roleId);
            if (!role) { return { code: 404, message: '角色不存在或已被删除' }; }
            var list = readStore();
            var btnList = readBtnStore();
            var m = meta();
            var bmap = btnMap();

            // 1. 列表（该角色的全部菜单授权记录）
            if (path === '/list' && method === 'GET') {
                var out = [];
                for (var i = 0; i < list.length; i++) {
                    var row = list[i];
                    if (String(row.roleId) !== roleId) { continue; }
                    var g = m.groups[row.menuGroupId] || {};
                    var it = m.itemMap[row.menuItemId] || {};
                    out.push({
                        id: String(row.id), roleId: roleId,
                        menuGroupId: parseInt(row.menuGroupId, 10),
                        menuItemId: parseInt(row.menuItemId, 10),
                        enabled: row.enabled !== false,
                        remark: row.remark || '',
                        createTime: row.createTime || '', updateTime: row.updateTime || '',
                        menuGroupName: g.nameCn || '',
                        menuGroupPath: groupPath(m.groups, parseInt(row.menuGroupId, 10)),
                        menuItemName: it.nameCn || '', menuItemPath: it.path || ''
                    });
                }
                return { code: 0, message: 'ok', data: { list: out, total: out.length, roleId: roleId, roleName: role.nameCn, roleEnabled: !!role.enabled } };
            }

            // 2. 按钮授权清单
            if (path === '/buttons' && method === 'GET') {
                var brow = [];
                for (var b = 0; b < btnList.length; b++) {
                    if (String(btnList[b].roleId) !== roleId) { continue; }
                    var found = null, pp;
                    for (pp in bmap) {
                        if (!bmap.hasOwnProperty(pp)) { continue; }
                        for (var q = 0; q < bmap[pp].length; q++) {
                            if (bmap[pp][q].pageOpBtnId === String(btnList[b].pageOpBtnId)) { found = bmap[pp][q]; break; }
                        }
                        if (found) { break; }
                    }
                    brow.push({
                        id: String(btnList[b].id), roleId: roleId,
                        pageOpBtnId: String(btnList[b].pageOpBtnId),
                        enabled: btnList[b].enabled !== false,
                        pagePath: pp || '', btnId: found ? found.btnId : '',
                        btnText: found ? found.btnText : ''
                    });
                }
                return { code: 0, message: 'ok', data: { list: brow, total: brow.length, roleId: roleId, roleName: role.nameCn } };
            }

            // 3. 权限树（菜单组 → 菜单项(页面) → 操作按钮）
            if (path === '/tree' && method === 'GET') {
                var keyword = String(params.keyword == null ? '' : params.keyword).replace(/^\s+|\s+$/g, '').toLowerCase();
                var has = {}, hasBtn = {};
                for (var q2 = 0; q2 < list.length; q2++) {
                    if (String(list[q2].roleId) === roleId && list[q2].enabled !== false) {
                        has[list[q2].menuGroupId + ':' + list[q2].menuItemId] = true;
                    }
                }
                for (var q3 = 0; q3 < btnList.length; q3++) {
                    if (String(btnList[q3].roleId) === roleId && btnList[q3].enabled !== false) {
                        hasBtn[String(btnList[q3].pageOpBtnId)] = true;
                    }
                }
                var byGroup = {}, order = [];
                for (var bi = 0; bi < m.binds.length; bi++) {
                    var one = m.binds[bi];
                    if (!byGroup[one.groupId]) { byGroup[one.groupId] = []; order.push(one.groupId); }
                    byGroup[one.groupId].push(one.itemId);
                }
                order.sort(function (x, y) {
                    return cmpChain(sortChain(m.groups, x), sortChain(m.groups, y)) || (x - y);
                });
                var groups = [], total = 0, totalChecked = 0, btnTotal = 0, btnCheckedTotal = 0;
                var seenBtnAll = {}, seenBtnChecked = {};
                for (var gi = 0; gi < order.length; gi++) {
                    var gid = order[gi], gnode = m.groups[gid], gpath = groupPath(m.groups, gid);
                    var nodeItems = [], checkedCount = 0;
                    for (var ii = 0; ii < byGroup[gid].length; ii++) {
                        var iid = byGroup[gid][ii], imeta = m.itemMap[iid];
                        var isChecked = !!has[gid + ':' + iid];
                        var pageButtons = bmap[imeta.path] || [];
                        if (keyword && !(like(gpath, keyword) || like(gnode.nameCn, keyword) ||
                            like(imeta.nameCn, keyword) || like(imeta.code, keyword) || like(imeta.path, keyword) ||
                            pageButtons.some(function (x) { return like(x.btnId, keyword) || like(x.btnText, keyword); }))) {
                            continue;
                        }
                        total++;
                        if (isChecked) { checkedCount++; totalChecked++; }

                        var bl = [], bc = 0;
                        for (var bk = 0; bk < pageButtons.length; bk++) {
                            var on = !!hasBtn[pageButtons[bk].pageOpBtnId];
                            if (on) { bc++; }
                            bl.push({
                                pageOpBtnId: pageButtons[bk].pageOpBtnId,
                                btnId: pageButtons[bk].btnId,
                                btnText: pageButtons[bk].btnText,
                                checked: on,
                                disabled: !isChecked
                            });
                        }
                        for (var bx = 0; bx < bl.length; bx++) {
                            var bkey = String(bl[bx].pageOpBtnId);
                            if (!seenBtnAll[bkey]) { seenBtnAll[bkey] = true; btnTotal++; }
                            if (bl[bx].checked && !seenBtnChecked[bkey]) { seenBtnChecked[bkey] = true; btnCheckedTotal++; }
                        }

                        nodeItems.push({
                            menuItemId: iid, code: imeta.code, nameCn: imeta.nameCn, path: imeta.path,
                            crumb: gpath + '/' + imeta.nameCn, checked: isChecked,
                            buttons: bl, buttonCount: bl.length, buttonChecked: bc
                        });
                    }
                    if (!nodeItems.length) { continue; }
                    groups.push({
                        menuGroupId: gid, code: gnode.code, nameCn: gnode.nameCn,
                        level: gnode.level, sortNo: gnode.sortNo, crumb: gpath, items: nodeItems,
                        itemCount: nodeItems.length, checkedCount: checkedCount,
                        checked: checkedCount > 0 && checkedCount === nodeItems.length,
                        indeterminate: checkedCount > 0 && checkedCount < nodeItems.length
                    });
                }
                return {
                    code: 0, message: 'ok',
                    data: {
                        roleId: roleId, roleName: role.nameCn, roleEnabled: !!role.enabled,
                        keyword: keyword, groups: groups, total: total, checked: totalChecked,
                        groupCount: groups.length,
                        buttonTotal: btnTotal, buttonChecked: btnCheckedTotal
                    }
                };
            }

            // 4. 保存（菜单权限 + 按钮权限，全量替换）
            if (path === '/save' && method === 'POST') {
                var hasItems = Object.prototype.hasOwnProperty.call(params, 'items');
                var hasButtons = Object.prototype.hasOwnProperty.call(params, 'buttons');
                if (!hasItems && !hasButtons) {
                    return { code: 500, message: '请至少提交 items（菜单权限）或 buttons（按钮权限）' };
                }

                var pairs = [];
                if (hasItems) {
                    var raw = params.items;
                    if (raw === undefined || raw === null) { raw = []; }
                    if (!Array.isArray(raw)) { return { code: 500, message: 'items 必须是数组：[{menuGroupId, menuItemId}, ...]' }; }
                    var itemsOfGroup = {}, bindSet = {}, x;
                    for (x = 0; x < m.binds.length; x++) {
                        var bb = m.binds[x];
                        bindSet[bb.groupId + ':' + bb.itemId] = true;
                        if (!itemsOfGroup[bb.groupId]) { itemsOfGroup[bb.groupId] = []; }
                        itemsOfGroup[bb.groupId].push(bb.itemId);
                    }
                    var seen = {}, e;
                    for (e = 0; e < raw.length; e++) {
                        var entry = raw[e] || {};
                        var eg = parseInt(entry.menuGroupId, 10);
                        var ei = (entry.menuItemId === undefined || entry.menuItemId === null || String(entry.menuItemId).trim() === '')
                            ? 0 : parseInt(entry.menuItemId, 10);
                        if (isNaN(eg)) { return { code: 500, message: 'menuGroupId 不合法' }; }
                        if (isNaN(ei)) { return { code: 500, message: 'menuItemId 不合法' }; }
                        if (!m.groups[eg]) { return { code: 500, message: '菜单组不存在或已停用（id=' + eg + '）' }; }
                        if (ei === 0) {
                            var all = itemsOfGroup[eg] || [];
                            for (var a = 0; a < all.length; a++) {
                                if (seen[eg + ':' + all[a]]) { continue; }
                                seen[eg + ':' + all[a]] = true;
                                pairs.push({ menuGroupId: eg, menuItemId: all[a] });
                            }
                            continue;
                        }
                        if (!m.itemMap[ei]) { return { code: 500, message: '菜单项不存在或已停用（id=' + ei + '）' }; }
                        if (!bindSet[eg + ':' + ei]) {
                            return { code: 500, message: '菜单项「' + m.itemMap[ei].nameCn + '」不属于菜单组「' + m.groups[eg].nameCn + '」' };
                        }
                        if (seen[eg + ':' + ei]) { continue; }
                        seen[eg + ':' + ei] = true;
                        pairs.push({ menuGroupId: eg, menuItemId: ei });
                    }
                }

                var btnIds = [];
                if (hasButtons) {
                    var rawBtns = params.buttons;
                    if (rawBtns === undefined || rawBtns === null) { rawBtns = []; }
                    if (typeof rawBtns === 'string') { rawBtns = rawBtns.split(','); }
                    if (!Array.isArray(rawBtns)) { return { code: 500, message: 'buttons 必须是数组：[pageOpBtnId, ...]' }; }
                    var aliveBtns = {}, p2;
                    for (p2 in bmap) {
                        if (!bmap.hasOwnProperty(p2)) { continue; }
                        for (var w = 0; w < bmap[p2].length; w++) { aliveBtns[bmap[p2][w].pageOpBtnId] = true; }
                    }
                    var seenBtn = {};
                    for (var v = 0; v < rawBtns.length; v++) {
                        var one2 = rawBtns[v];
                        var bid = (one2 && typeof one2 === 'object')
                            ? String(one2.pageOpBtnId || one2.id || '').trim().toLowerCase()
                            : String(one2 == null ? '' : one2).trim().toLowerCase();
                        if (!bid) { continue; }
                        if (!isUuid(bid)) { return { code: 500, message: 'pageOpBtnId 不合法（应为 UUID）：' + bid }; }
                        if (!aliveBtns[bid]) { return { code: 500, message: '页面操作按钮不存在或已被删除（id=' + bid + '）' }; }
                        if (seenBtn[bid]) { continue; }
                        seenBtn[bid] = true;
                        btnIds.push(bid);
                    }
                }

                if (hasItems) {
                    var rest = [], rr;
                    for (rr = 0; rr < list.length; rr++) {
                        if (String(list[rr].roleId) !== roleId) { rest.push(list[rr]); }
                    }
                    for (var pp2 = 0; pp2 < pairs.length; pp2++) {
                        rest.push({
                            id: mockUuid(), roleId: roleId,
                            menuGroupId: pairs[pp2].menuGroupId, menuItemId: pairs[pp2].menuItemId,
                            enabled: true, remark: '', createTime: now(), updateTime: now()
                        });
                    }
                    writeStore(rest);
                }
                if (hasButtons) {
                    var bkeep = [], r2;
                    for (r2 = 0; r2 < btnList.length; r2++) {
                        if (String(btnList[r2].roleId) !== roleId) { bkeep.push(btnList[r2]); }
                    }
                    for (var b2 = 0; b2 < btnIds.length; b2++) {
                        bkeep.push({
                            id: mockUuid(), roleId: roleId, pageOpBtnId: btnIds[b2],
                            enabled: true, remark: '', createTime: now(), updateTime: now()
                        });
                    }
                    writeBtnStore(bkeep);
                }
                return {
                    code: 0, message: 'ok',
                    data: {
                        roleId: roleId,
                        saved: hasItems ? pairs.length : null,
                        savedButtons: hasButtons ? btnIds.length : null
                    }
                };
            }

            // 5. 清空（菜单 + 按钮）
            if (path === '/clear' && method === 'POST') {
                var keep = [], deleted = 0, k2;
                for (k2 = 0; k2 < list.length; k2++) {
                    if (String(list[k2].roleId) === roleId) { deleted++; } else { keep.push(list[k2]); }
                }
                writeStore(keep);
                var bkeep2 = [], deletedBtn = 0;
                for (k2 = 0; k2 < btnList.length; k2++) {
                    if (String(btnList[k2].roleId) === roleId) { deletedBtn++; } else { bkeep2.push(btnList[k2]); }
                }
                writeBtnStore(bkeep2);
                return { code: 0, message: 'ok', data: { roleId: roleId, deleted: deleted, deletedButtons: deletedBtn } };
            }

            return { code: 404, message: '接口不存在：' + path };
        }

        /* raw：原始菜单授权行（mockNav 按当前登录用户角色过滤导航时读取） */
        return { route: route, raw: readStore };
    }

    var menuSvc = createService({
        storeKey: 'menu_admin_store_v1',
        seed: SEED_MENU,
        label: '菜单项',
        uniqueFields: [{ field: 'code', label: '编号' }, { field: 'nameEn', label: '英文名' }],
        boolFields: ['enabled'],
        codePrefix: 'MNU',                   // 编号自动生成：MNU + 5 位流水号
        codeDigits: 5,
        // 查询结果按「显示序号」升序（同序号按 id），与后端 MenuService.ORDER_BY 一致
        sortBy: function (a, b) {
            var sa = parseInt(a.sortNo, 10), sb = parseInt(b.sortNo, 10);
            if (isNaN(sa)) { sa = 0; }
            if (isNaN(sb)) { sb = 0; }
            return (sa - sb) || (a.id - b.id);
        },
        validateItem: function (item) {
            if (item.sortNo === undefined || item.sortNo === null || String(item.sortNo).trim() === '') {
                item.sortNo = 0;
            }
            var no = parseInt(item.sortNo, 10);
            if (isNaN(no)) { return '显示序号必须是整数'; }
            if (no < 0 || no > 9999) { return '显示序号为 0-9999 之间的整数'; }
            item.sortNo = no;
            return null;
        },
        fields: ['icon', 'sortNo', 'code', 'nameCn', 'nameEn', 'path', 'enabled', 'remark']
    });

    var groupSvc = createService({
        storeKey: 'menu_admin_group_store_v2',   // v2：数据结构升级为多层级（parentId/level/sortNo）
        seed: SEED_GROUP,
        label: '菜单组',
        tree: true,                              // 树形业务：层级排序 / 上级校验 / 级联删除
        treeKwDfs: true,                         // 列表（含关键字检索）都按「父 → 子」深度优先输出，与后端 _sorted_forest 同口径
        uniqueFields: [{ field: 'code', label: '编号' }, { field: 'nameEn', label: '英文名' }],
        boolFields: ['enabled', 'hasChild'],
        codePrefix: 'MNG',                   // 编号自动生成：MNG + 4 位流水号（新增页预取）
        codeDigits: 4,
        fields: ['parentId', 'level', 'sortNo', 'icon', 'code', 'nameCn', 'nameEn', 'hasChild', 'path', 'enabled']
    });

    /* 部门组织架构：多层级（parentId / level / sortNo），编号 DPT + 4 位流水号 */
    var orgSvc = createService({
        storeKey: 'menu_admin_org_store_v1',
        seed: SEED_ORG,
        label: '部门',
        tree: true,                              // 树形业务：层级排序 / 上级校验 / 级联删除
        rootOption: true,                        // 层级下拉中带「（顶级部门，无上级）」选项
        guardEnabledChildren: true,              // 有启用状态的下级部门时，禁止停用 / 删除本部门
        uniqueFields: [{ field: 'code', label: '编号' }],
        boolFields: ['enabled'],
        codePrefix: 'DPT',                       // 编号自动生成：DPT + 4 位流水号
        codeDigits: 4,
        fields: ['parentId', 'level', 'sortNo', 'code', 'nameCn', 'duty', 'enabled'],
        // 补「部门负责人」展示字段（dptmgrset ↔ empinfos，一个部门最多一个）
        decorateItem: function (copy) {
            var mgr = dptMgrSvc ? dptMgrSvc.managerOf(copy.id) : null;
            copy.managerId = mgr ? mgr.empId : 0;
            copy.managerName = mgr ? (mgr.nameCn || '') : '';
            copy.managerCode = mgr ? (mgr.code || '') : '';
            copy.managerJob = mgr ? (mgr.jobTitle || '') : '';
            copy.managerStatus = mgr ? mgr.status : -1;
        }
    });

    /* 菜单组项目设置：菜单组 ↔ 菜单项（依赖上面两个服务做关联展示） */
    var groupItemSvc = createGroupItemService(menuSvc, groupSvc);

    /* 员工信息：非树形，工号 E + 5 位流水号（可编辑、唯一），邮箱必填 + 格式校验 */
    var EMP_STATUS_TEXT = { 1: '在职', 2: '试用', 0: '离职' };
    var RE_EMP_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
    var RE_EMP_PHONE = /^1[3-9]\d{9}$/;
    var RE_EMP_ID_CARD = /^(\d{15}|\d{17}[\dXx])$/;
    var RE_EMP_DATE = /^\d{4}-\d{2}-\d{2}$/;
    var EMP_PHOTO_MAX = 400000;      // 照片（Base64）字符数上限，与后端一致

    /* 从部门服务取「部门ID → 名称」映射（用于列表展示所属部门） */
    function deptNameOf(deptId) {
        var id = parseInt(deptId, 10) || 0;
        if (!id) { return ''; }
        var rows = orgSvc.listRaw();      // 裸数据：员工装饰里再调部门装饰会形成循环
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].id === id) { return rows[i].nameCn; }
        }
        return '';
    }

    /** 本部门 + 全部下级部门的 ID 列表（含孙辈），供「含下级部门」的人员查询 */
    function deptSubtreeIds(rootId) {
        var id = parseInt(rootId, 10) || 0;
        if (!id) { return []; }
        var rows = orgSvc.listRaw(), byParent = {}, i;
        for (i = 0; i < rows.length; i++) {
            var pid = parseInt(rows[i].parentId, 10) || 0;
            if (!byParent[pid]) { byParent[pid] = []; }
            byParent[pid].push(parseInt(rows[i].id, 10));
        }
        var result = [id], stack = [id];
        while (stack.length) {
            var cur = stack.pop();
            var kids = byParent[cur] || [];
            for (i = 0; i < kids.length; i++) {
                if (result.indexOf(kids[i]) < 0) {
                    result.push(kids[i]);
                    stack.push(kids[i]);
                }
            }
        }
        return result;
    }

    var empSvc = createService({
        storeKey: 'menu_admin_emp_store_v2',      // v2：新增出生日期 / 身份证 / 学历 / 院校 / 专业 / 证书 / 职称 / 照片
        seed: SEED_EMP,
        label: '员工',
        uniqueFields: [{ field: 'code', label: '工号' }],
        codePrefix: 'E',                         // 工号自动生成：E + 5 位流水号（如 E00001）
        codeDigits: 5,
        keywordFields: ['code', 'nameCn', 'phone', 'email', 'jobTitle', 'idCard'],
        sortBy: function (a, b) { return String(a.code).localeCompare(String(b.code)); },
        // 在职状态 / 所属部门筛选（非通用 enabled 过滤）
        matchExtra: function (item, params) {
            if (params.status !== '' && params.status !== undefined && params.status !== null
                && Number(item.status) !== Number(params.status)) {
                return false;
            }
            var dept = parseInt(params.deptId, 10) || 0;
            if (dept) {
                // includeChildren=1：连同全部下级部门的员工一起返回
                if (Number(params.includeChildren) === 1 || params.includeChildren === '1' || params.includeChildren === true) {
                    if (deptSubtreeIds(dept).indexOf(Number(item.deptId)) < 0) { return false; }
                } else if (Number(item.deptId) !== dept) {
                    return false;
                }
            }
            return true;
        },
        // 保存前归一化 + 校验（与后端 EmpService.before_save 保持一致）
        validateItem: function (item) {
            item.code = String(item.code || '').replace(/^\s+|\s+$/g, '').toUpperCase();
            item.email = String(item.email || '').replace(/^\s+|\s+$/g, '').toLowerCase();
            item.phone = String(item.phone || '').replace(/[\s-]/g, '');
            if (!item.code) { return '工号不能为空'; }
            if (item.code.length > 16) { return '工号长度不能超过 16 位'; }
            if (!String(item.nameCn || '').replace(/^\s+|\s+$/g, '')) { return '姓名不能为空'; }
            if (!item.email) { return '邮箱不能为空'; }
            if (!RE_EMP_EMAIL.test(item.email)) { return '邮箱格式不正确，请填写形如 name@example.com 的邮箱'; }
            if (item.phone && !RE_EMP_PHONE.test(item.phone)) { return '手机号格式不正确，应为 1 开头的 11 位数字'; }
            var st = Number(item.status === undefined || item.status === '' ? 1 : item.status);
            if ([0, 1, 2].indexOf(st) < 0) { return '在职状态不合法（0-离职 / 1-在职 / 2-试用）'; }
            item.status = st;
            item.gender = Number(item.gender) === 2 ? 2 : 1;
            item.deptId = parseInt(item.deptId, 10) || 0;

            /* ---- 档案字段（均可空）：出生日期 / 身份证 / 学历 / 院校 / 专业 / 证书 / 职称 / 照片 ---- */
            item.birthDate = String(item.birthDate || '').replace(/^\s+|\s+$/g, '');
            if (item.birthDate && !RE_EMP_DATE.test(item.birthDate)) { return '出生日期格式应为 YYYY-MM-DD'; }
            item.idCard = String(item.idCard || '').replace(/\s/g, '').toUpperCase();
            if (item.idCard && !RE_EMP_ID_CARD.test(item.idCard)) {
                return '身份证号格式不正确，应为 15 位或 18 位（18 位末位可为 X）';
            }
            var textLimits = [['education', '最高学历', 20], ['school', '毕业院校', 100],
                              ['major', '所学专业', 100], ['certificates', '执业资格证书', 200],
                              ['titleName', '职称', 50]];
            for (var i = 0; i < textLimits.length; i++) {
                var f = textLimits[i][0];
                item[f] = String(item[f] === undefined || item[f] === null ? '' : item[f]).replace(/^\s+|\s+$/g, '');
                if (item[f].length > textLimits[i][2]) { return textLimits[i][1] + '不能超过 ' + textLimits[i][2] + ' 个字符'; }
            }
            item.photo = String(item.photo || '').replace(/^\s+|\s+$/g, '');
            if (item.photo && item.photo.indexOf('data:image/') !== 0 && item.photo.indexOf('http') !== 0) {
                return '照片格式不正确，请重新上传图片';
            }
            if (item.photo.length > EMP_PHOTO_MAX) { return '照片体积过大，请重新选择更小的图片'; }
            return null;
        },
        // 输出前补展示字段（与后端 _attach 保持一致）
        decorateItem: function (copy) {
            copy.status = Number(copy.status) || 0;
            copy.statusText = EMP_STATUS_TEXT[copy.status] || '';
            copy.genderText = Number(copy.gender) === 2 ? '女' : '男';
            copy.deptName = deptNameOf(copy.deptId);
            copy.hireDate = String(copy.hireDate || '').slice(0, 10);
            copy.birthDate = String(copy.birthDate || '').slice(0, 10);
            copy.photo = copy.photo || '';
            copy.hasPhoto = !!copy.photo;
            var edu = String(copy.education || '').replace(/^\s+|\s+$/g, '');
            var title = String(copy.titleName || '').replace(/^\s+|\s+$/g, '');
            copy.archiveText = [edu, title].filter(function (x) { return !!x; }).join(' / ');
            var name = String(copy.nameCn || '').replace(/^\s+|\s+$/g, '');
            copy.avatarText = copy.hasPhoto ? '' : name.slice(0, 1);   // 无照片时用姓名首字做占位头像
        },
        fields: ['code', 'nameCn', 'gender', 'phone', 'email', 'deptId',
                 'jobTitle', 'status', 'hireDate', 'birthDate', 'idCard',
                 'education', 'school', 'major', 'certificates', 'titleName', 'photo',
                 'remark']
    });

    /* 用户角色（usergroup）：主键为 UUID（非自增），角色名唯一，列表按排序号升序 */
    var roleSvc = createService({
        storeKey: 'menu_admin_role_store_v1',
        seed: SEED_ROLE,
        label: '角色',
        uuid: true,                                  // 主键用 UUID 字符串（与后端 usergroup.id CHAR(36) 一致）
        uniqueFields: [{ field: 'nameEn', label: '英文名' }],   // 英文名全局唯一
        boolFields: ['enabled'],
        keywordFields: ['nameCn', 'nameEn', 'remark', 'id'],    // 关键字：中文名 / 英文名 / 说明 / 角色ID
        sortBy: function (a, b) {
            return ((parseInt(a.sortNo, 10) || 0) - (parseInt(b.sortNo, 10) || 0)) ||
                String(a.id).localeCompare(String(b.id));
        },
        validateItem: function (item, list, selfId) {
            item.nameCn = String(item.nameCn || '').replace(/^\s+|\s+$/g, '');
            if (!item.nameCn) { return '中文名不能为空'; }
            if (item.nameCn.length > 50) { return '中文名不能超过 50 个字符'; }

            item.nameEn = String(item.nameEn || '').replace(/^\s+|\s+$/g, '');
            if (!item.nameEn) { return '英文名不能为空'; }
            if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(item.nameEn)) {
                return '英文名需以字母开头，只能包含字母、数字、下划线（最长 100 位）';
            }

            item.remark = String(item.remark || '').replace(/^\s+|\s+$/g, '');
            if (item.remark.length > 200) { return '说明不能超过 200 个字符'; }
            var raw = item.sortNo;
            var no = (raw === undefined || raw === null || String(raw).trim() === '') ? 0 : parseInt(raw, 10);
            if (isNaN(no)) { return '排序号必须是整数'; }
            if (no < 0 || no > 9999) { return '排序号为 0-9999 之间的整数'; }
            item.sortNo = no;

            // 中文名：只在「本记录为启用状态」时才需要与其它启用角色比较（停用可重名）
            if (item.enabled) {
                for (var i = 0; i < (list || []).length; i++) {
                    if (String(list[i].id) === String(selfId || '')) { continue; }
                    if (list[i].enabled && String(list[i].nameCn) === item.nameCn) {
                        return '中文名【' + item.nameCn + '】已被其它启用状态的角色使用；如需同名，请先停用对方或本角色';
                    }
                }
            }
            return null;
        },
        // 查重接口：中文名按启用状态判定（停用时永远返回 unique=true）
        customCheck: function (field, val, params, list) {
            if (field !== 'nameCn') { return undefined; }
            var enabled = (params.enabled === undefined || params.enabled === null || String(params.enabled).trim() === '')
                ? 1 : Number(params.enabled);
            if (!enabled) { return true; }
            for (var i = 0; i < list.length; i++) {
                if (String(list[i].id) === String(params.id || '')) { continue; }
                if (list[i].enabled && String(list[i].nameCn || '').toLowerCase() === val) { return false; }
            }
            return true;
        },
        fields: ['nameCn', 'nameEn', 'remark', 'sortNo', 'enabled']
    });

    /* ==========================================================================
       页面操作按钮（pageopbtn）：某页面的某个操作按钮，UUID 主键，pagePath + btnId 唯一
       --------------------------------------------------------------------------
       · 与后端 PageOpBtnService 同口径：list / detail / pages / scan / update / delete
       · 真实后端的 scan 会解析 .html 的 .toolbar / .pick-toolbar / .form-actions；
         模拟服务没有文件系统，scan 按内置种子「重新收录」并与现有记录比对
       ========================================================================== */
    function createPageOpBtnService() {
        var storeKey = 'menu_admin_pageopbtn_store_v1';
        var memoryStore = null;
        var MISSING_TIP = '页面中已不存在';

        /* 种子展开成行（pagePath + btnId 唯一，sortNo 按按钮在页面中的顺序） */
        function seedRows() {
            var rows = [];
            for (var i = 0; i < SEED_PAGEOPBTN.length; i++) {
                var page = SEED_PAGEOPBTN[i][0], name = SEED_PAGEOPBTN[i][1], btns = SEED_PAGEOPBTN[i][2];
                for (var j = 0; j < btns.length; j++) {
                    rows.push({
                        id: mockUuid(), pageName: name, pagePath: page,
                        btnId: btns[j][0], btnText: btns[j][1], sortNo: j,
                        enabled: true, remark: '',
                        createTime: now(), updateTime: now()
                    });
                }
            }
            return rows;
        }

        function writeStore(list) {
            memoryStore = list;
            try { window.localStorage.setItem(storeKey, JSON.stringify(list)); } catch (e) { }
        }
        function readStore() {
            var list = null;
            try {
                var raw = window.localStorage.getItem(storeKey);
                if (raw) { list = JSON.parse(raw); }
            } catch (e) { }
            if (!list) {
                if (memoryStore) { return memoryStore; }
                list = seedRows();
                writeStore(list);
            }
            return list;
        }

        function byOrder(a, b) {
            if (a.pagePath !== b.pagePath) { return a.pagePath < b.pagePath ? -1 : 1; }
            if ((a.sortNo || 0) !== (b.sortNo || 0)) { return (a.sortNo || 0) - (b.sortNo || 0); }
            return String(a.id) < String(b.id) ? -1 : 1;
        }
        function out(row) {
            var copy = clone(row);
            copy.enabled = row.enabled !== false;
            copy.sortNo = parseInt(row.sortNo, 10) || 0;
            copy.missing = String(row.remark || '').indexOf(MISSING_TIP) > -1;
            return copy;
        }

        function route(method, path, params) {
            params = params || {};
            var list = readStore();

            // 1. 列表
            if (path === '/list' && method === 'GET') {
                var kw = String(params.keyword == null ? '' : params.keyword).replace(/^\s+|\s+$/g, '').toLowerCase();
                var pagePath = String(params.pagePath == null ? '' : params.pagePath).replace(/^\s+|\s+$/g, '');
                var enabledRaw = params.enabled === undefined || params.enabled === null ? '' : String(params.enabled).trim();
                var rows = [];
                for (var i = 0; i < list.length; i++) {
                    var it = list[i];
                    if (pagePath && it.pagePath !== pagePath) { continue; }
                    if (enabledRaw !== '' && (enabledRaw === '1' ? it.enabled === false : it.enabled !== false)) { continue; }
                    if (kw && !(like(it.pageName, kw) || like(it.pagePath, kw) || like(it.btnId, kw) || like(it.btnText, kw))) { continue; }
                    rows.push(it);
                }
                rows.sort(byOrder);
                var total = rows.length;
                var pageNum = parseInt(params.pageNum, 10) || 1;
                var pageSize = parseInt(params.pageSize, 10) || 10;
                var pages = Math.max(1, Math.ceil(total / pageSize));
                if (pageNum > pages) { pageNum = pages; }
                var start = (pageNum - 1) * pageSize;
                return {
                    code: 0, message: 'ok',
                    data: {
                        list: rows.slice(start, start + pageSize).map(out),
                        total: total, pageNum: pageNum, pageSize: pageSize, pages: pages
                    }
                };
            }

            // 2. 详情
            if (path.indexOf('/detail') === 0 && method === 'GET') {
                for (var d = 0; d < list.length; d++) {
                    if (String(list[d].id) === String(params.id)) { return { code: 0, message: 'ok', data: out(list[d]) }; }
                }
                return { code: 404, message: '页面操作按钮不存在或已被删除' };
            }

            // 3. 页面下拉
            if (path === '/pages' && method === 'GET') {
                var map = {}, order = [], k;
                for (k = 0; k < list.length; k++) {
                    var it2 = list[k];
                    if (!map[it2.pagePath]) {
                        map[it2.pagePath] = { pagePath: it2.pagePath, pageName: it2.pageName, total: 0, enabledCount: 0 };
                        order.push(it2.pagePath);
                    }
                    map[it2.pagePath].total++;
                    if (it2.enabled !== false) { map[it2.pagePath].enabledCount++; }
                }
                var pages2 = [];
                for (k = 0; k < order.length; k++) { pages2.push(map[order[k]]); }
                return { code: 0, message: 'ok', data: { list: pages2, total: pages2.length } };
            }

            // 4. 自动收录（按种子与现有记录比对，模拟「扫描页面」）
            if (path === '/scan' && method === 'POST') {
                var found = seedRows();
                var index = {}, i2;
                for (i2 = 0; i2 < list.length; i2++) { index[list[i2].pagePath + '::' + list[i2].btnId] = list[i2]; }
                var added = 0, updated = 0, same = 0, seen = {};
                for (i2 = 0; i2 < found.length; i2++) {
                    var f = found[i2], key = f.pagePath + '::' + f.btnId;
                    seen[key] = true;
                    var old = index[key];
                    if (!old) {
                        list.push(f);
                        added++;
                    } else if (old.pageName !== f.pageName || old.btnText !== f.btnText || (parseInt(old.sortNo, 10) || 0) !== f.sortNo
                        || String(old.remark || '').indexOf(MISSING_TIP) > -1) {
                        old.pageName = f.pageName;
                        old.btnText = f.btnText;
                        old.sortNo = f.sortNo;
                        old.remark = '';
                        old.updateTime = now();
                        updated++;
                    } else {
                        same++;
                    }
                }
                var missing = 0;
                for (i2 = 0; i2 < list.length; i2++) {
                    var one = list[i2];
                    if (seen[one.pagePath + '::' + one.btnId]) { continue; }
                    if (String(one.remark || '').indexOf(MISSING_TIP) > -1) { continue; }
                    one.remark = MISSING_TIP + '（重新扫描时更新）';
                    missing++;
                }
                writeStore(list);
                return {
                    code: 0, message: 'ok',
                    data: { added: added, updated: updated, unchanged: same, missing: missing,
                        scanned: found.length, total: list.length,
                        pages: (function () {
                            var set = {}, n = 0, p;
                            for (p = 0; p < found.length; p++) { if (!set[found[p].pagePath]) { set[found[p].pagePath] = 1; n++; } }
                            return n;
                        })() }
                };
            }

            // 5. 编辑（只允许改页面名 / 按钮文本 / 启用否 / 备注）
            if (path === '/update' && method === 'POST') {
                var target = null;
                for (var u = 0; u < list.length; u++) {
                    if (String(list[u].id) === String(params.id)) { target = list[u]; break; }
                }
                if (!target) { return { code: 404, message: '页面操作按钮不存在或已被删除' }; }
                var text = String(params.btnText == null ? '' : params.btnText).replace(/^\s+|\s+$/g, '');
                if (!text) { return { code: 500, message: '操作按钮文本不能为空' }; }
                if (text.length > 60) { return { code: 500, message: '操作按钮文本不能超过 60 个字符' }; }
                var pname = String(params.pageName == null ? '' : params.pageName).replace(/^\s+|\s+$/g, '') || target.pageName;
                if (pname.length > 60) { return { code: 500, message: '所属页面不能超过 60 个字符' }; }
                var remark = String(params.remark == null ? '' : params.remark).replace(/^\s+|\s+$/g, '');
                if (remark.length > 200) { return { code: 500, message: '备注不能超过 200 个字符' }; }
                target.pageName = pname;
                target.btnText = text;
                target.enabled = !(params.enabled !== undefined && String(params.enabled) === '0');
                target.remark = remark;
                target.updateTime = now();
                writeStore(list);
                return { code: 0, message: 'ok', data: out(target) };
            }

            // 6. 删除
            if (path === '/delete' && method === 'POST') {
                var idx = -1;
                for (var x = 0; x < list.length; x++) {
                    if (String(list[x].id) === String(params.id)) { idx = x; break; }
                }
                if (idx < 0) { return { code: 404, message: '页面操作按钮不存在或已被删除' }; }
                var removed = list[idx];
                list.splice(idx, 1);
                writeStore(list);
                return { code: 0, message: '删除成功', data: out(removed) };
            }

            return { code: 404, message: '接口不存在：' + path };
        }

        return { route: route };
    }

    /* 页面操作按钮（pageopbtn）：无外部依赖 */
    var pageOpBtnSvc = createPageOpBtnService();

    /* 角色权限（菜单权限 usergrouppowerset + 按钮权限 usergrouppagebtnset） */
    var rolePowerSvc = createRolePowerService(roleSvc, groupSvc, menuSvc, groupItemSvc, pageOpBtnSvc);

    /* ==========================================================================
       部门负责人设置服务（dptmgrset：OrganizationStructure.id ↔ empinfos.id）
       · 一个部门只能有一个负责人：按 deptId 唯一，重复设置即替换
       · /list 以部门为维度输出负责人信息；managerOf(deptId) 供部门服务补展示字段
       ========================================================================== */
    function createDptMgrService(orgSvcRef, empSvcRef) {
        var storeKey = 'menu_admin_dptmgr_store_v1';
        var memoryStore = null;
        var EMP_ST = { 1: '在职', 2: '试用', 0: '离职' };

        function readStore() {
            try {
                var raw = window.localStorage.getItem(storeKey);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            if (memoryStore) { return memoryStore; }
            var seed = clone(SEED_DPTMGR);
            for (var i = 0; i < seed.length; i++) { seed[i].id = i + 1; }
            memoryStore = seed;
            return seed;
        }
        function writeStore(list) {
            memoryStore = list;
            try { window.localStorage.setItem(storeKey, JSON.stringify(list)); } catch (e) { }
        }
        function deptMap() {
            var rows = orgSvcRef.listRaw(), map = {};
            for (var i = 0; i < rows.length; i++) { map[rows[i].id] = rows[i]; }
            return map;
        }
        function empMap() {
            var rows = empSvcRef.listRaw(), map = {};
            for (var i = 0; i < rows.length; i++) { map[rows[i].id] = rows[i]; }
            return map;
        }

        /** 取某部门的负责人（未设置返回 null）；供部门列表 / 架构图补 managerName 等字段 */
        function managerOf(deptId) {
            var id = parseInt(deptId, 10) || 0;
            if (!id) { return null; }
            var list = readStore(), em = empMap();
            for (var i = 0; i < list.length; i++) {
                if (parseInt(list[i].deptId, 10) === id) {
                    var emp = em[list[i].empId] || {};
                    var st = emp.status === undefined ? -1 : Number(emp.status);
                    return {
                        deptId: id, empId: list[i].empId, remark: list[i].remark || '',
                        nameCn: emp.nameCn || '', code: emp.code || '',
                        jobTitle: emp.jobTitle || '', status: st, statusText: EMP_ST[st] || ''
                    };
                }
            }
            return null;
        }

        function route(method, path, params) {
            var list = readStore();

            // 1. 列表（部门 + 负责人）
            if (path === '/list' && method === 'GET') {
                var dm = deptMap(), em = empMap();
                var kw = String(params.keyword || '').replace(/^\s+|\s+$/g, '').toLowerCase();
                var out = [];
                for (var i = 0; i < list.length; i++) {
                    var it = list[i];
                    var d = dm[it.deptId] || {}, e = em[it.empId] || {};
                    var st = e.status === undefined ? -1 : Number(e.status);
                    var row = {
                        id: it.id, deptId: it.deptId, empId: it.empId,
                        deptCode: d.code || '', deptName: d.nameCn || '',
                        empCode: e.code || '', empName: e.nameCn || '',
                        jobTitle: e.jobTitle || '', status: st, statusText: EMP_ST[st] || '',
                        remark: it.remark || '', updateTime: it.updateTime || ''
                    };
                    if (kw) {
                        var blob = (row.deptCode + ' ' + row.deptName + ' ' + row.empCode + ' ' + row.empName).toLowerCase();
                        if (blob.indexOf(kw) < 0) { continue; }
                    }
                    out.push(row);
                }
                return { code: 0, message: 'ok', data: { list: out, total: out.length } };
            }

            // 2. 设置 / 替换负责人（deptId 唯一，已存在则替换）
            if (path === '/set' && method === 'POST') {
                var deptId = parseInt(params.deptId, 10);
                var empId = parseInt(params.empId, 10);
                if (!deptId || !deptMap()[deptId]) { return { code: 500, message: '部门不存在或已被删除' }; }
                if (!empId || !empMap()[empId]) { return { code: 500, message: '员工不存在或已被删除' }; }
                var hit = null;
                for (var j = 0; j < list.length; j++) {
                    if (parseInt(list[j].deptId, 10) === deptId) { hit = list[j]; break; }
                }
                if (hit) {
                    hit.empId = empId;
                    hit.remark = params.remark ? String(params.remark) : '';
                    hit.updateTime = now();
                } else {
                    list.push({
                        id: (function () { var max = 0; for (var k = 0; k < list.length; k++) { if (list[k].id > max) { max = list[k].id; } } return max + 1; })(),
                        deptId: deptId, empId: empId,
                        remark: params.remark ? String(params.remark) : '',
                        createTime: now(), updateTime: now()
                    });
                }
                writeStore(list);
                return { code: 0, message: '设置成功', data: managerOf(deptId) };
            }

            // 3. 清除负责人
            if (path === '/delete' && method === 'POST') {
                var delDept = parseInt(params.deptId, 10) || 0;
                var rest = [], removed = null;
                for (var m = 0; m < list.length; m++) {
                    if (delDept && parseInt(list[m].deptId, 10) === delDept) { removed = list[m]; continue; }
                    if (!delDept && parseInt(list[m].id, 10) === (parseInt(params.id, 10) || 0)) { removed = list[m]; continue; }
                    rest.push(list[m]);
                }
                if (!removed) { return { code: 404, message: '该部门还没有设置负责人' }; }
                writeStore(rest);
                return { code: 0, message: '已清除负责人', data: clone(removed) };
            }

            return { code: 404, message: '接口不存在：' + path };
        }

        return { route: route, managerOf: managerOf };
    }

    /* 部门负责人设置：依赖部门与员工两个服务做关联展示 */
    var dptMgrSvc = createDptMgrService(orgSvc, empSvc);

    /* ---------------- 员工通讯录（addressbook）模拟服务 ----------------
       与后端 AddressBookService 一一对应：**只读**（list / tree），
       且只返回通讯录字段（工号 / 姓名 / 性别 / 手机 / 邮箱 / 部门 / 岗位 / 在职状态），
       身份证、照片、学历、证书等档案字段一律不出现；数据直接取自员工 / 部门 Mock 存储。 */
    function createAddressBookService(empSvcRef, orgSvcRef) {
        var ST = { 1: '在职', 2: '试用', 0: '离职' };

        function emps() { return (empSvcRef.listRaw ? empSvcRef.listRaw() : []) || []; }
        function depts() { return (orgSvcRef.listRaw ? orgSvcRef.listRaw() : []) || []; }
        function deptMap() {
            var all = depts(), map = {};
            for (var i = 0; i < all.length; i++) { map[Number(all[i].id)] = all[i].nameCn || ''; }
            return map;
        }
        /** 通讯录字段白名单（多一个字段都不给） */
        function strip(it, dmap) {
            var status = Number(it.status) || 0;
            return {
                id: it.id,
                code: it.code || '',
                nameCn: it.nameCn || '',
                gender: Number(it.gender) || 1,
                genderText: Number(it.gender) === 2 ? '女' : '男',
                phone: it.phone || '',
                email: it.email || '',
                deptId: Number(it.deptId) || 0,
                deptName: dmap[Number(it.deptId) || 0] || '',
                jobTitle: it.jobTitle || '',
                status: status,
                statusText: ST[status] || '',
                avatarText: String(it.nameCn || '').slice(0, 1)
            };
        }
        function descendantIds(rootId) {
            var all = depts(), out = [], stack = [Number(rootId) || 0];
            while (stack.length) {
                var cur = stack.pop();
                for (var i = 0; i < all.length; i++) {
                    if (Number(all[i].parentId) === cur) {
                        var cid = Number(all[i].id);
                        if (out.indexOf(cid) < 0) { out.push(cid); stack.push(cid); }
                    }
                }
            }
            return out;
        }
        function isOn(v) { return v === 1 || v === '1' || v === true || v === 'true'; }

        function route(method, path, params) {
            params = params || {};
            var dmap = deptMap();

            if (path === '/tree') {
                var all = depts();
                var counts = {}, totalStaff = 0, unassigned = 0;
                var staff = emps();
                for (var s = 0; s < staff.length; s++) {
                    totalStaff++;
                    var did = Number(staff[s].deptId) || 0;
                    if (did <= 0) { unassigned++; } else { counts[did] = (counts[did] || 0) + 1; }
                }
                var nodes = {}, children = {}, i, d;
                for (i = 0; i < all.length; i++) {
                    d = all[i];
                    var nid = Number(d.id);
                    nodes[nid] = {
                        id: nid, parentId: Number(d.parentId) || 0,
                        level: Number(d.level) || 1, code: d.code || '', nameCn: d.nameCn || '',
                        enabled: d.enabled !== false && d.enabled !== 0 && d.enabled !== '0',
                        directCount: counts[nid] || 0, totalCount: counts[nid] || 0, children: []
                    };
                    var pid = Number(d.parentId) || 0;
                    if (!children[pid]) { children[pid] = []; }
                    children[pid].push(nid);
                }
                function build(pid) {
                    var out = [], ids = children[pid] || [];
                    for (var k = 0; k < ids.length; k++) {
                        var node = nodes[ids[k]];
                        node.children = build(ids[k]);
                        for (var c = 0; c < node.children.length; c++) {
                            node.totalCount += node.children[c].totalCount;
                        }
                        out.push(node);
                    }
                    return out;
                }
                return { code: 0, message: 'ok', data: {
                    list: build(0), totalStaff: totalStaff, unassignedCount: unassigned,
                    deptCount: all.length
                } };
            }

            if (path === '/list') {
                var keyword = String(params.keyword || '').trim().toLowerCase();
                var statusFilter = (params.status === '' || params.status === undefined || params.status === null)
                    ? null : Number(params.status);
                var deptId = parseInt(params.deptId, 10) || 0;
                var includeChildren = isOn(params.includeChildren);
                var onlyUnassigned = isOn(params.unassigned);
                var subtree = {};
                if (deptId > 0 && includeChildren) {
                    subtree[deptId] = true;
                    var kids = descendantIds(deptId);
                    for (var q = 0; q < kids.length; q++) { subtree[kids[q]] = true; }
                }
                var rows = [], list = emps(), one;
                for (i = 0; i < list.length; i++) {
                    one = list[i];
                    var itemDept = Number(one.deptId) || 0;
                    if (onlyUnassigned) { if (itemDept > 0) { continue; } }
                    else if (deptId > 0) {
                        if (includeChildren ? !subtree[itemDept] : itemDept !== deptId) { continue; }
                    }
                    if (statusFilter !== null && Number(one.status) !== statusFilter) { continue; }
                    if (keyword) {
                        var blob = String([one.code, one.nameCn, one.phone, one.email, one.jobTitle]
                            .join(' ')).toLowerCase();
                        if (blob.indexOf(keyword) < 0) { continue; }
                    }
                    rows.push(one);
                }
                rows.sort(function (a, b) { return String(a.code).localeCompare(String(b.code)); });
                var pageNum = Math.max(1, parseInt(params.pageNum, 10) || 1);
                var pageSize = Math.min(Math.max(parseInt(params.pageSize, 10) || 12, 1), 200);
                var pages = Math.max(1, Math.ceil(rows.length / pageSize));
                if (pageNum > pages) { pageNum = pages; }
                var slice = rows.slice((pageNum - 1) * pageSize, pageNum * pageSize);
                var items = [];
                for (var t = 0; t < slice.length; t++) { items.push(strip(slice[t], dmap)); }
                return { code: 0, message: 'ok', data: {
                    list: items, total: rows.length, pageNum: pageNum, pageSize: pageSize, pages: pages,
                    deptId: deptId, unassigned: onlyUnassigned, keyword: String(params.keyword || '')
                } };
            }

            return { code: 404, message: '接口不存在：/addressbook' + path };
        }
        return { route: route };
    }

    var addressBookSvc = createAddressBookService(empSvc, orgSvc);

    /* ---------------- 员工信息归档（empinfoarchive）模拟服务 ----------------
       与后端一致：一次归档 = 一个批次（batchId UUID + archiveTime 当前时间），
       把 empinfos 当前全部记录整表快照进来；归档记录 id 用 UUID，原员工 id 存 empId；
       只追加，不修改历史批次。列表展示字段（部门名 / 状态文案 / 学历·职称 / 头像）在读取时补齐。 */
    function createEmpArchiveService(orgSvcRef, empSvcRef) {
        var storeKey = 'menu_admin_emp_archive_store_v1';
        var memoryStore = null;
        var EMP_ST = { 1: '在职', 2: '试用', 0: '离职' };
        // 与后端 EMP_ARCHIVE_COLUMNS 对应：归档时从员工记录复制过去的业务字段
        var ARCH_FIELDS = ['code', 'nameCn', 'gender', 'phone', 'email', 'deptId', 'jobTitle', 'status',
            'hireDate', 'birthDate', 'idCard', 'education', 'school', 'major', 'certificates',
            'titleName', 'photo', 'remark'];

        function readStore() {
            try {
                var raw = window.localStorage.getItem(storeKey);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            return memoryStore || [];
        }
        function writeStore(list) {
            memoryStore = list;
            try { window.localStorage.setItem(storeKey, JSON.stringify(list)); } catch (e) { }
        }
        function deptMap() {
            var rows = orgSvcRef.listRaw(), map = {};
            for (var i = 0; i < rows.length; i++) { map[String(rows[i].id)] = rows[i]; }
            return map;
        }
        /* 与后端 EmpService._attach 对齐的展示字段 */
        function attach(rows) {
            var dmap = deptMap();
            for (var i = 0; i < rows.length; i++) {
                var it = rows[i];
                var st = parseInt(it.status, 10);
                if (isNaN(st)) { st = 1; }
                it.statusText = EMP_ST[st] || '';
                it.genderText = (parseInt(it.gender, 10) === 2) ? '女' : '男';
                it.deptName = (dmap[String(it.deptId)] || {}).nameCn || '';
                var edu = String(it.education || ''), title = String(it.titleName || '');
                it.archiveText = [edu, title].filter(function (x) { return !!x; }).join(' / ');
                it.photo = it.photo || '';
                it.hasPhoto = !!it.photo;
                it.avatarText = it.hasPhoto ? '' : String(it.nameCn || '').slice(0, 1);
                it.hireDate = it.hireDate ? String(it.hireDate).slice(0, 10) : '';
                it.birthDate = it.birthDate ? String(it.birthDate).slice(0, 10) : '';
            }
            return rows;
        }

        function route(method, path, params) {
            var list = readStore();

            // 1. 归档：把当前员工表整表快照进来（新批次）
            if (path === '/archive' && method === 'POST') {
                var rows = empSvcRef.listRaw();
                if (!rows.length) { return { code: 500, message: '员工信息表暂无数据，无需归档' }; }
                var batchId = mockUuid(), archiveTime = now(), added = [];
                for (var i = 0; i < rows.length; i++) {
                    var item = { id: mockUuid(), batchId: batchId, archiveTime: archiveTime, empId: rows[i].id };
                    for (var f = 0; f < ARCH_FIELDS.length; f++) { item[ARCH_FIELDS[f]] = rows[i][ARCH_FIELDS[f]]; }
                    item.createTime = rows[i].createTime || archiveTime;
                    item.updateTime = rows[i].updateTime || archiveTime;
                    added.push(item);
                }
                writeStore(list.concat(added));
                return { code: 0, message: 'ok', data: { batchId: batchId, archiveTime: archiveTime, total: added.length } };
            }

            // 2. 历次归档批次（按归档时间倒序）
            if (path === '/batches' && method === 'GET') {
                var byBatch = {}, order = [];
                for (var b = 0; b < list.length; b++) {
                    var key = String(list[b].batchId || '');
                    if (!byBatch[key]) { byBatch[key] = { batchId: key, archiveTime: list[b].archiveTime || '', total: 0 }; order.push(byBatch[key]); }
                    byBatch[key].total++;
                }
                order.sort(function (x, y) {
                    if (x.archiveTime !== y.archiveTime) { return x.archiveTime < y.archiveTime ? 1 : -1; }
                    return x.batchId < y.batchId ? 1 : -1;
                });
                return { code: 0, message: 'ok', data: { list: order, total: order.length } };
            }

            // 3. 某批次的员工列表（分页 + 关键字 + 在职状态）
            if (path === '/list' && method === 'GET') {
                var batchId2 = String((params && params.batchId) || '');
                if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(batchId2)) {
                    return { code: 500, message: '参数 batchId 不合法（应为 UUID）' };
                }
                var kw = String((params && params.keyword) || '').replace(/^\s+|\s+$/g, '');
                var stFilter = (params && params.status !== undefined && params.status !== null && String(params.status) !== '')
                    ? parseInt(params.status, 10) : null;
                var hits = [];
                for (var r = 0; r < list.length; r++) {
                    var row = list[r];
                    if (String(row.batchId) !== batchId2) { continue; }
                    if (stFilter !== null && parseInt(row.status, 10) !== stFilter) { continue; }
                    if (kw && !(like(row.code, kw) || like(row.nameCn, kw) || like(row.phone, kw) ||
                        like(row.email, kw) || like(row.jobTitle, kw) || like(row.idCard, kw))) { continue; }
                    hits.push(row);
                }
                hits.sort(function (x, y) { return String(x.code) < String(y.code) ? -1 : 1; });
                var pageNum = parseInt(params.pageNum, 10) || 1;
                var pageSize = Math.min(Math.max(parseInt(params.pageSize, 10) || 10, 1), 500);
                var total = hits.length;
                var pages = Math.max(1, Math.ceil(total / pageSize));
                if (pageNum > pages) { pageNum = pages; }
                var start = (pageNum - 1) * pageSize;
                var pageRows = clone(hits.slice(start, start + pageSize));
                attach(pageRows);
                return {
                    code: 0, message: 'ok',
                    data: { list: pageRows, total: total, pageNum: pageNum, pageSize: pageSize, pages: pages }
                };
            }

            return { code: 404, message: '接口不存在：' + path };
        }

        return { route: route };
    }

    /* 员工信息归档：依赖组织（部门名）与员工（快照来源）两个服务 */
    var empArchiveSvc = createEmpArchiveService(orgSvc, empSvc);

    /* ---------------- 用户信息（useinfo）模拟服务 ----------------
       与后端一致：账号默认取员工手机号（唯一）、一员工一账号、密码 MD5 存储且接口不外泄；
       批量创建与重置密码统一用 888888；角色用 useinforoleset 关联（多对多，批量设置=全量替换）。 */
    function createUserInfoService(empSvcRef, roleSvcRef, orgSvcRef) {
        var storeKey = 'menu_admin_useinfo_store_v1';
        var roleStoreKey = 'menu_admin_useinfo_role_store_v1';
        var userMem = null, roleMem = null;
        var DEFAULT_PWD = '888888';
        var RE_ACC = /^[A-Za-z0-9_.@-]{4,50}$/;

        function readUsers() {
            try {
                var raw = window.localStorage.getItem(storeKey);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            return userMem || [];
        }
        function writeUsers(list) {
            userMem = list;
            try { window.localStorage.setItem(storeKey, JSON.stringify(list)); } catch (e) { }
        }
        function readRoles() {
            try {
                var raw = window.localStorage.getItem(roleStoreKey);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            return roleMem || [];
        }
        function writeRoles(list) {
            roleMem = list;
            try { window.localStorage.setItem(roleStoreKey, JSON.stringify(list)); } catch (e) { }
        }
        function empMap() {
            var rows = empSvcRef.listRaw(), map = {};
            for (var i = 0; i < rows.length; i++) { map[String(rows[i].id)] = rows[i]; }
            return map;
        }
        function roleMap() {
            var res = roleSvcRef.route('GET', '/list', { pageNum: 1, pageSize: 500 });
            var rows = (res && res.data && res.data.list) || [], map = {};
            for (var i = 0; i < rows.length; i++) { map[String(rows[i].id)] = rows[i]; }
            return map;
        }
        function deptMap() {
            var rows = orgSvcRef.listRaw(), map = {};
            for (var i = 0; i < rows.length; i++) { map[String(rows[i].id)] = rows[i]; }
            return map;
        }
        /* 组装展示字段：员工信息 + 角色 + 密码/ token 掩码（原始密码与 token 永不外泄） */
        function join(row, emps, rmap, links, dmap) {
            var emp = emps[String(row.empId)] || {};
            var roles = [], i;
            for (i = 0; i < links.length; i++) {
                if (String(links[i].userId) === String(row.id)) {
                    var g = rmap[String(links[i].roleId)];
                    if (g) { roles.push({ id: g.id, nameCn: g.nameCn, nameEn: g.nameEn }); }
                }
            }
            roles.sort(function (x, y) {
                var a = rmap[String(x.id)] || {}, b = rmap[String(y.id)] || {};
                return (parseInt(a.sortNo, 10) || 0) - (parseInt(b.sortNo, 10) || 0);
            });
            var out = {
                id: String(row.id), account: row.account, empId: parseInt(row.empId, 10) || 0,
                empCode: emp.code || '', empName: emp.nameCn || '', phone: emp.phone || '',
                deptId: emp.deptId || 0, deptName: (dmap[String(emp.deptId)] || {}).nameCn || '',
                jobTitle: emp.jobTitle || '', status: emp.status === undefined ? null : emp.status,
                statusText: (emp.status === 0 ? '离职' : (emp.status === 2 ? '试用' : '在职')),
                enabled: row.enabled !== false,
                remark: row.remark || '',
                passwordMask: '******',
                hasToken: !!row.token,
                tokenShort: row.token ? (String(row.token).slice(0, 8) + '…') : '',
                lastLoginTime: row.lastLoginTime || '',
                lastLoginIp: row.lastLoginIp || '',
                createTime: row.createTime || '', updateTime: row.updateTime || '',
                roles: roles,
                roleIds: roles.map(function (x) { return x.id; }),
                roleNames: roles.map(function (x) { return x.nameCn; }).join('、')
            };
            return out;
        }

        function route(method, path, params) {
            var users = readUsers(), links = readRoles();
            var emps = empMap(), rmap = roleMap(), dmap = deptMap();

            function accUsed(account, selfId) {
                for (var i = 0; i < users.length; i++) {
                    if (String(users[i].account) === account && String(users[i].id) !== String(selfId || '')) { return true; }
                }
                return false;
            }
            function empUsed(empId, selfId) {
                for (var i = 0; i < users.length; i++) {
                    if (String(users[i].empId) === String(empId) && String(users[i].id) !== String(selfId || '')) { return users[i]; }
                }
                return null;
            }
            function idsOf(p) {
                var raw = p && p.ids !== undefined ? p.ids : (p && p.id);
                if (raw === undefined || raw === null || raw === '') { return []; }
                if (Object.prototype.toString.call(raw) === '[object Array]') { return raw.map(String); }
                return [String(raw)];
            }
            function writeLinks(userIds, roleIds) {
                var keep = [], i;
                for (i = 0; i < links.length; i++) {
                    if (userIds.indexOf(String(links[i].userId)) < 0) { keep.push(links[i]); }
                }
                for (i = 0; i < userIds.length; i++) {
                    for (var r = 0; r < roleIds.length; r++) {
                        keep.push({ id: mockUuid(), userId: userIds[i], roleId: roleIds[r], createTime: now() });
                    }
                }
                writeRoles(keep);
            }

            // 1. 列表（关键字：账号 / 姓名 / 工号 / 手机号 / 登录IP；启用；员工）
            if (path === '/list' && method === 'GET') {
                var kw = String((params && params.keyword) || '').replace(/^\s+|\s+$/g, '');
                var en = (params && params.enabled !== undefined && params.enabled !== null && String(params.enabled) !== '')
                    ? (String(params.enabled) === '1' || params.enabled === 1 || params.enabled === true) : null;
                var hits = [];
                for (var i = 0; i < users.length; i++) {
                    var one = join(users[i], emps, rmap, links, dmap);
                    if (en !== null && one.enabled !== en) { continue; }
                    if (kw && !(like(one.account, kw) || like(one.empName, kw) || like(one.empCode, kw) ||
                        like(one.phone, kw) || like(one.lastLoginIp, kw))) { continue; }
                    hits.push(one);
                }
                hits.sort(function (x, y) { return String(x.account) < String(y.account) ? -1 : 1; });
                var pageNum = parseInt(params.pageNum, 10) || 1;
                var pageSize = Math.min(Math.max(parseInt(params.pageSize, 10) || 10, 1), 500);
                var total = hits.length;
                var pages = Math.max(1, Math.ceil(total / pageSize));
                if (pageNum > pages) { pageNum = pages; }
                var start = (pageNum - 1) * pageSize;
                return {
                    code: 0, message: 'ok',
                    data: { list: hits.slice(start, start + pageSize), total: total, pageNum: pageNum, pageSize: pageSize, pages: pages }
                };
            }

            // 2. 员工下拉（建账号用）：是否已有账号
            if (path === '/empoptions' && method === 'GET') {
                var rows = empSvcRef.listRaw(), out = [];
                var okw = String((params && params.keyword) || '');
                for (var e = 0; e < rows.length; e++) {
                    var emp = rows[e];
                    var owner = empUsed(emp.id);
                    if (params && String(params.noUser) === '1' && owner) { continue; }
                    if (okw && !(like(emp.code, okw) || like(emp.nameCn, okw) || like(emp.phone, okw) || like(emp.jobTitle, okw))) { continue; }
                    out.push({
                        id: emp.id, code: emp.code, nameCn: emp.nameCn, phone: emp.phone || '',
                        deptId: emp.deptId || 0, deptName: (dmap[String(emp.deptId)] || {}).nameCn || '',
                        jobTitle: emp.jobTitle || '', status: emp.status,
                        statusText: (emp.status === 0 ? '离职' : (emp.status === 2 ? '试用' : '在职')),
                        hasUser: !!owner, userAccount: owner ? owner.account : ''
                    });
                }
                out.sort(function (x, y) { return String(x.code) < String(y.code) ? -1 : 1; });
                return { code: 0, message: 'ok', data: { list: out, total: out.length } };
            }

            // 3. 详情
            if (path === '/detail' && method === 'GET') {
                var did = String((params && params.id) || '');
                for (var d = 0; d < users.length; d++) {
                    if (String(users[d].id) === did) { return { code: 0, message: 'ok', data: join(users[d], emps, rmap, links, dmap) }; }
                }
                return { code: 404, message: '用户不存在或已被删除' };
            }

            // 4. 唯一性校验
            if (path === '/check' && method === 'GET') {
                var field = String((params && params.field) || 'account');
                var value = String((params && params.value) || '');
                if (!value) { return { code: 0, message: 'ok', data: { unique: true } }; }
                if (field === 'empId') {
                    return { code: 0, message: 'ok', data: { unique: !empUsed(value, params.id) } };
                }
                return { code: 0, message: 'ok', data: { unique: !accUsed(value, params.id) } };
            }

            // 5. 新增（单个）
            if (path === '/add' && method === 'POST') {
                var p = params || {};
                var empId = parseInt(p.empId, 10) || 0;
                var emp = emps[String(empId)];
                if (!emp) { return { code: 500, message: '员工不存在或已被删除' }; }
                var exist = empUsed(empId);
                if (exist) { return { code: 500, message: '该员工已创建过用户账号（' + exist.account + '），一个员工只能创建一个账号' }; }
                var account = String(p.account || emp.phone || '').replace(/^\s+|\s+$/g, '');
                if (!account) { return { code: 500, message: '该员工没有手机号，请手工填写登录账号' }; }
                if (!RE_ACC.test(account)) { return { code: 500, message: '账号需为 4-50 位字母、数字、下划线、点、@ 或连字符' }; }
                if (accUsed(account)) { return { code: 500, message: '账号【' + account + '】已存在，请更换' }; }
                var pwd = String(p.password || DEFAULT_PWD);
                if (pwd.length < 6 || pwd.length > 32) { return { code: 500, message: '密码长度需为 6-32 位' }; }
                var uid = mockUuid(), t = now();
                users.push({
                    id: uid, account: account, password: md5Hex(pwd), empId: empId,
                    token: '', lastLoginTime: '', lastLoginIp: '',
                    enabled: !(p.enabled === false || String(p.enabled) === '0'),
                    remark: String(p.remark || '').slice(0, 200), createTime: t, updateTime: t
                });
                writeUsers(users);
                var roleIds = (p.roleIds || []).map(String);
                if (roleIds.length) { writeLinks([uid], roleIds); links = readRoles(); }
                var saved = null;
                for (var s = 0; s < users.length; s++) { if (String(users[s].id) === uid) { saved = users[s]; } }
                return { code: 0, message: 'ok', data: join(saved, emps, rmap, readRoles(), dmap) };
            }

            // 6. 批量创建（初始密码 888888）
            if (path === '/batch' && method === 'POST') {
                var p2 = params || {};
                var rawIds = p2.empIds;
                if (typeof rawIds === 'string') { rawIds = rawIds.split(/[,\s]+/); }
                if (!rawIds || !rawIds.length) { return { code: 500, message: '请选择要创建账号的员工' }; }
                if (rawIds.length > 500) { return { code: 500, message: '单次最多批量创建 500 个账号' }; }
                var roleIds2 = (p2.roleIds || []).map(String);
                var pwdMd5 = md5Hex(DEFAULT_PWD), created = [], skipped = [], newIds = [];
                for (var b = 0; b < rawIds.length; b++) {
                    var eid = parseInt(rawIds[b], 10) || 0;
                    var emp2 = emps[String(eid)];
                    if (!emp2) { skipped.push({ empId: eid, reason: '员工不存在' }); continue; }
                    var ex = empUsed(eid);
                    if (ex) { skipped.push({ empId: eid, code: emp2.code, nameCn: emp2.nameCn, reason: '已存在账号（' + ex.account + '）' }); continue; }
                    var acc = emp2.phone || '';
                    if (!acc) { skipped.push({ empId: eid, code: emp2.code, nameCn: emp2.nameCn, reason: '员工没有手机号，无法作为默认账号' }); continue; }
                    if (!RE_ACC.test(acc)) { skipped.push({ empId: eid, code: emp2.code, nameCn: emp2.nameCn, reason: '手机号【' + acc + '】不符合账号规则' }); continue; }
                    if (accUsed(acc)) { skipped.push({ empId: eid, code: emp2.code, nameCn: emp2.nameCn, reason: '账号【' + acc + '】已被占用' }); continue; }
                    var nid = mockUuid(), nt = now();
                    users.push({
                        id: nid, account: acc, password: pwdMd5, empId: eid,
                        token: '', lastLoginTime: '', lastLoginIp: '', enabled: true,
                        remark: '批量创建', createTime: nt, updateTime: nt
                    });
                    newIds.push(nid);
                    created.push({ id: nid, account: acc, empCode: emp2.code, empName: emp2.nameCn });
                }
                if (created.length) { writeUsers(users); }
                if (newIds.length && roleIds2.length) { writeLinks(newIds, roleIds2); }
                return {
                    code: 0, message: 'ok',
                    data: { created: created.length, skipped: skipped, total: rawIds.length, password: DEFAULT_PWD, accounts: created }
                };
            }

            // 7. 编辑
            if (path === '/update' && method === 'POST') {
                var p3 = params || {};
                var target = null;
                for (var u = 0; u < users.length; u++) { if (String(users[u].id) === String(p3.id)) { target = users[u]; } }
                if (!target) { return { code: 404, message: '用户不存在或已被删除' }; }
                if (p3.account !== undefined && String(p3.account).replace(/^\s+|\s+$/g, '') !== '') {
                    var acc2 = String(p3.account).replace(/^\s+|\s+$/g, '');
                    if (!RE_ACC.test(acc2)) { return { code: 500, message: '账号需为 4-50 位字母、数字、下划线、点、@ 或连字符' }; }
                    if (accUsed(acc2, target.id)) { return { code: 500, message: '账号【' + acc2 + '】已存在，请更换' }; }
                    target.account = acc2;
                }
                if (p3.remark !== undefined) { target.remark = String(p3.remark || '').slice(0, 200); }
                if (p3.enabled !== undefined) { target.enabled = !(p3.enabled === false || String(p3.enabled) === '0'); }
                target.updateTime = now();
                writeUsers(users);
                if (p3.roleIds !== undefined) { writeLinks([String(target.id)], (p3.roleIds || []).map(String)); }
                return { code: 0, message: 'ok', data: join(target, emps, rmap, readRoles(), dmap) };
            }

            // 8. 删除（支持单条 / 批量）
            if (path === '/delete' && method === 'POST') {
                var delIds = idsOf(params);
                if (!delIds.length) { return { code: 500, message: '请先选择用户' }; }
                var keepU = [], removed = 0;
                for (var k = 0; k < users.length; k++) {
                    if (delIds.indexOf(String(users[k].id)) > -1) { removed++; } else { keepU.push(users[k]); }
                }
                writeUsers(keepU);
                var keepL = [];
                for (var k2 = 0; k2 < links.length; k2++) {
                    if (delIds.indexOf(String(links[k2].userId)) < 0) { keepL.push(links[k2]); }
                }
                writeRoles(keepL);
                return { code: 0, message: 'ok', data: { deleted: removed, ids: delIds } };
            }

            // 9. 重置密码（统一 888888）
            if (path === '/resetpwd' && method === 'POST') {
                var rIds = idsOf(params);
                if (!rIds.length) { return { code: 500, message: '请先选择用户' }; }
                var matched = 0;
                for (var m = 0; m < users.length; m++) {
                    if (rIds.indexOf(String(users[m].id)) > -1) {
                        users[m].password = md5Hex(DEFAULT_PWD);
                        users[m].updateTime = now();
                        matched++;
                    }
                }
                if (matched) { writeUsers(users); }
                return { code: 0, message: 'ok', data: { reset: matched, password: DEFAULT_PWD, ids: rIds } };
            }

            // 10. 批量设置角色（全量替换）
            if (path === '/setroles' && method === 'POST') {
                var sIds = idsOf(params);
                if (!sIds.length) { return { code: 500, message: '请先选择用户' }; }
                var sRoleIds = (params.roleIds || []).map(String);
                for (var rr = 0; rr < sRoleIds.length; rr++) {
                    if (!rmap[sRoleIds[rr]]) { return { code: 500, message: '存在已被删除的角色，请刷新后重试' }; }
                }
                writeLinks(sIds, sRoleIds);
                return {
                    code: 0, message: 'ok',
                    data: { users: sIds.length, roles: sRoleIds.length, relations: sIds.length * sRoleIds.length }
                };
            }

            return { code: 404, message: '接口不存在：' + path };
        }

        return { route: route, raw: readUsers, write: writeUsers, rawRoles: readRoles, writeRoles: writeRoles };
    }

    /* 用户信息：依赖员工（账号来源）、角色（授权）、组织（部门名）三个服务 */
    var userInfoSvc = createUserInfoService(empSvc, roleSvc, orgSvc);

    /* ---------------- 登录认证（auth）模拟服务 ----------------
       与后端一致：账号 + 明文密码 → 与 useinfo 中 MD5 比对；成功生成 32 位 token 并记录登录时间/IP；
       停用账号拒绝登录；离线演示时若还没有任何用户，自动种一个「首个员工手机号 / 888888」的示例账号。 */
    function createAuthService(empSvcRef, userSvcRef) {
        var SESSION_LOG = 'menu_admin_auth_log_v1';
        var CODE_KEY = 'menu_admin_emailcode_v1';   // 离线模拟：找回密码验证码（真实后端只发邮件，不落库）
        var captchas = {};                  // captchaId -> {answer, expire}（内存，一次性）
        var CAPTCHA_TTL = 300;              // 5 分钟有效
        var EMAIL_CODE_TTL = 300;           // 邮箱验证码 5 分钟有效
        var EMAIL_CODE_GAP = 60;            // 同一邮箱 60 秒内只能发一次

        function md5(text) { return md5Hex(text); }

        /* ---------- 找回密码用的小工具（与后端 service.py 的规则保持一致） ---------- */
        function maskEmail(email) {
            var text = String(email || '');
            var at = text.indexOf('@');
            if (at < 0) { return text; }
            return text.slice(0, 1) + '***' + text.slice(at);
        }
        function readCodes() {
            try { return JSON.parse(window.localStorage.getItem(CODE_KEY) || '{}') || {}; } catch (e) { return {}; }
        }
        function writeCodes(map) {
            try { window.localStorage.setItem(CODE_KEY, JSON.stringify(map)); } catch (e) { }
        }
        /** 邮箱 → 用户行（empinfos.email 匹配，兼容账号本身就是邮箱） */
        function userByEmail(email) {
            var target = String(email || '').trim().toLowerCase();
            var emps = empSvcRef.listRaw ? empSvcRef.listRaw() : [];
            var empId = null;
            for (var i = 0; i < emps.length; i++) {
                if (String(emps[i].email || '').toLowerCase() === target) { empId = emps[i].id; break; }
            }
            var rows = userSvcRef.raw();
            for (var j = 0; j < rows.length; j++) {
                if (empId !== null && String(rows[j].empId) === String(empId) && rows[j].enabled !== false) {
                    return { user: rows[j], email: target };
                }
            }
            for (var k = 0; k < rows.length; k++) {
                if (String(rows[k].account || '').toLowerCase() === target && rows[k].enabled !== false) {
                    return { user: rows[k], email: target };
                }
            }
            return null;
        }
        function checkNewPassword(pwd) {
            var text = String(pwd || '');
            if (!text) { return '请输入新密码'; }
            if (text.length < 6) { return '新密码至少 6 位'; }
            if (text.length > 32) { return '新密码最多 32 位'; }
            var same = true;
            for (var i = 1; i < text.length; i++) { if (text.charAt(i) !== text.charAt(0)) { same = false; break; } }
            if (same) { return '新密码不能是同一个字符重复（如 111111）'; }
            return '';
        }

        /* 生成一道算术题：只把 captchaId 与题干给前端，答案留在本地“服务”里 */
        function newCaptcha() {
            var ops = ['+', '-', '×'];
            var op = ops[Math.floor(Math.random() * ops.length)];
            var a, b, answer;
            if (op === '-') {
                a = 5 + Math.floor(Math.random() * 5);
                b = 1 + Math.floor(Math.random() * a);      // 结果非负
                answer = a - b;
            } else {
                a = 1 + Math.floor(Math.random() * 9);
                b = 1 + Math.floor(Math.random() * 9);
                answer = (op === '+') ? (a + b) : (a * b);
            }
            var id = mockUuid().replace(/-/g, '');
            var nowTs = new Date().getTime();
            var keys = [];
            for (var k in captchas) {
                if (captchas[k].expire < nowTs) { keys.push(k); }
            }
            for (var i = 0; i < keys.length; i++) { delete captchas[keys[i]]; }
            captchas[id] = { answer: answer, expire: nowTs + CAPTCHA_TTL * 1000 };
            return { captchaId: id, question: a + ' ' + op + ' ' + b + ' = ?', expireIn: CAPTCHA_TTL };
        }

        /* 校验验证码：无论对错都作废（防重放） */
        function verifyCaptcha(params) {
            var id = String((params && params.captchaId) || '');
            var code = String((params && params.captchaCode) || '').replace(/\s+/g, '');
            if (!code) { return '请输入验证码'; }
            if (!id) { return '验证码已失效，请点击图形换一题'; }
            var item = captchas[id];
            delete captchas[id];
            if (!item) { return '验证码已失效，请点击图形换一题'; }
            if (item.expire < new Date().getTime()) { return '验证码已过期，请点击图形换一题'; }
            if (!/^-?\d+$/.test(code) || parseInt(code, 10) !== item.answer) {
                return '验证码不正确，请重新输入';
            }
            return '';
        }

        function findUser(account) {
            var rows = userSvcRef.raw();
            for (var i = 0; i < rows.length; i++) {
                if (String(rows[i].account) === String(account)) { return rows[i]; }
            }
            return null;
        }
        /* 离线演示兜底：没有任何用户时，用第一个员工的手机号种一个 888888 的账号 */
        function seedOnce() {
            var rows = userSvcRef.raw();
            if (rows.length) { return; }
            var emps = empSvcRef.listRaw();
            if (!emps.length) { return; }
            var emp = emps[0];
            var account = String(emp.phone || 'admin').replace(/\s/g, '') || 'admin';
            var t = now();
            rows.push({
                id: mockUuid(), account: account, password: md5('888888'), empId: emp.id,
                token: '', lastLoginTime: '', lastLoginIp: '',
                enabled: true, remark: '离线演示账号', createTime: t, updateTime: t
            });
            userSvcRef.write(rows);
            // 演示账号顺带授予「系统管理员」角色，登录后能带出角色信息
            var links = userSvcRef.rawRoles();
            links.push({ id: mockUuid(), userId: rows[0].id, roleId: MOCK_ADMIN_ROLE_ID, createTime: t });
            userSvcRef.writeRoles(links);
        }
        function detailOf(id) {
            var res = userSvcRef.route('GET', '/detail', { id: id });
            return (res && res.data) || null;
        }
        function remember(account, ok, message) {
            try {
                var log = JSON.parse(window.localStorage.getItem(SESSION_LOG) || '[]');
                log.unshift({ account: account, ok: !!ok, message: message || '', time: now() });
                window.localStorage.setItem(SESSION_LOG, JSON.stringify(log.slice(0, 50)));
            } catch (e) { }
        }

        function route(method, path, params) {
            params = params || {};
            var rows = userSvcRef.raw();

            if (path === '/captcha' && method === 'GET') {
                return { code: 0, message: 'ok', data: newCaptcha() };
            }

            /* 系统品牌（登录页用）：只回 app_name / app_ennme / app_ico 三个键，
               与后端 AuthService.brand 一致；旧种子键 site_name 作为中文名兜底 */
            if (path === '/brand' && method === 'GET') {
                var paraRows = (sysParaSvc && sysParaSvc.raw) ? (sysParaSvc.raw() || []) : [];
                var brand = { app_name: '', app_ennme: '', app_ico: '' };
                for (var bi = 0; bi < paraRows.length; bi++) {
                    var pr = paraRows[bi] || {};
                    if (pr.enabled === false) { continue; }
                    var pk = String(pr.paraNameEn || '');
                    var pv = String(pr.paraValue || '');
                    if (!pv) { continue; }
                    if (brand.hasOwnProperty(pk)) { brand[pk] = pv; }
                    else if (pk === 'site_name' && !brand.app_name) { brand.app_name = pv; }
                }
                return { code: 0, message: 'ok', data: brand };
            }

            if (path === '/login' && method === 'POST') {
                var captchaErr = verifyCaptcha(params);
                if (captchaErr) { return { code: 500, message: captchaErr }; }
                seedOnce();
                rows = userSvcRef.raw();
                var account = String(params.account || '').replace(/^\s+|\s+$/g, '');
                var password = String(params.password || '');
                if (!account) { return { code: 500, message: '请输入登录账号' }; }
                if (!password) { return { code: 500, message: '请输入登录密码' }; }
                // 注意：要直接改 rows 里的那一份记录（raw() 每次返回新数组，改别的引用写不回去）
                var u = null;
                for (var ui = 0; ui < rows.length; ui++) {
                    if (String(rows[ui].account) === account) { u = rows[ui]; break; }
                }
                if (!u) { remember(account, false, '账号不存在'); return { code: 500, message: '账号或密码不正确' }; }
                if (u.enabled === false) { remember(account, false, '账号已停用'); return { code: 500, message: '账号已停用，请联系管理员' }; }
                if (String(u.password) !== md5(password)) {
                    remember(account, false, '密码错误');
                    return { code: 500, message: '账号或密码不正确' };
                }
                u.token = mockUuid().replace(/-/g, '');
                u.lastLoginTime = now();
                u.lastLoginIp = '127.0.0.1';
                // 与后端一致：令牌有效期默认 8 小时（单点登录）
                var ttlMs = DEFAULT_TTL_HOURS * 3600 * 1000;
                u.tokenExpireTime = (function () {
                    var d = new Date(new Date().getTime() + ttlMs);
                    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
                        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
                })();
                userSvcRef.write(rows);
                remember(account, true, '');
                return {
                    code: 0, message: 'ok',
                    data: {
                        token: u.token, loginTime: u.lastLoginTime, loginIp: u.lastLoginIp,
                        expireTime: u.tokenExpireTime, expireIn: DEFAULT_TTL_HOURS * 3600,
                        ttlHours: DEFAULT_TTL_HOURS, user: detailOf(u.id)
                    }
                };
            }

            if (path === '/logout' && method === 'POST') {
                var token = String(params.token || '');
                if (token) {
                    for (var i = 0; i < rows.length; i++) {
                        if (String(rows[i].token) === token) { rows[i].token = ''; rows[i].tokenExpireTime = ''; }
                    }
                    userSvcRef.write(rows);
                }
                return { code: 0, message: 'ok', data: { logout: true } };
            }

            if (path === '/me' && method === 'GET') {
                var tk = String(params.token || '');
                if (!tk) { return { code: 401, message: '登录已失效，请重新登录' }; }
                for (var j = 0; j < rows.length; j++) {
                    if (String(rows[j].token) === tk) { return { code: 0, message: 'ok', data: detailOf(rows[j].id) }; }
                }
                return { code: 401, message: '登录已失效，请重新登录' };
            }

            /* 忘记密码第一步：把 6 位验证码「发」到登记邮箱。
               离线模式没有真实邮箱，验证码写进 localStorage（menu_admin_emailcode_v1）方便演示与测试。 */
            if (path === '/sendcode' && method === 'POST') {
                var mail = String(params.email || '').trim().toLowerCase();
                if (!mail) { return { code: 500, message: '请输入登记的邮箱' }; }
                if (!mailIsEmail(mail)) {
                    return { code: 500, message: '邮箱格式不正确，请填写形如 name@example.com 的邮箱' };
                }
                var hit = userByEmail(mail);
                if (!hit) {
                    return { code: 500, message: '该邮箱未在系统中登记（或对应账号已停用），请确认后重试或联系系统管理员' };
                }
                var store = readCodes(), nowTs = new Date().getTime();
                var old = store[mail];
                if (old && old.sentAt && (nowTs - old.sentAt) < EMAIL_CODE_GAP * 1000) {
                    return { code: 500, message: '验证码发送过于频繁，请 ' +
                        (Math.floor((EMAIL_CODE_GAP * 1000 - (nowTs - old.sentAt)) / 1000) + 1) + ' 秒后再试' };
                }
                var code = String(100000 + Math.floor(Math.random() * 900000));
                store[mail] = { code: code, expire: nowTs + EMAIL_CODE_TTL * 1000, sentAt: nowTs, tries: 0 };
                writeCodes(store);
                return { code: 0, message: 'ok', data: {
                    sent: true, emailMask: maskEmail(mail), expireIn: EMAIL_CODE_TTL,
                    mailbox: 'service@jiudou.com', name: (detailOf(hit.user.id) || {}).empName || '',
                    account: hit.user.account, debugCode: code
                } };
            }

            /* 忘记密码第二步：验证码 + 新密码 → 重置密码（真实后端还会把新密码发回该邮箱） */
            if (path === '/resetbyemail' && method === 'POST') {
                var mail2 = String(params.email || '').trim().toLowerCase();
                var hit2 = userByEmail(mail2);
                if (!hit2) {
                    return { code: 500, message: '该邮箱未在系统中登记（或对应账号已停用），请确认后重试或联系系统管理员' };
                }
                var code2 = String(params.code || '').replace(/\s+/g, '');
                if (!code2) { return { code: 500, message: '请输入邮箱验证码' }; }
                if (!/^\d{6}$/.test(code2)) { return { code: 500, message: '邮箱验证码是 6 位数字' }; }
                var store2 = readCodes(), item2 = store2[mail2];
                if (!item2) { return { code: 500, message: '请先点击「发送验证码」获取邮箱验证码' }; }
                if (item2.expire < new Date().getTime()) { delete store2[mail2]; writeCodes(store2); return { code: 500, message: '验证码已过期，请重新获取' }; }
                if (String(item2.code) !== code2) {
                    item2.tries = (item2.tries || 0) + 1;
                    if (item2.tries >= 5) { delete store2[mail2]; writeCodes(store2); return { code: 500, message: '验证码错误次数过多，请重新获取' }; }
                    writeCodes(store2);
                    return { code: 500, message: '验证码不正确，还可以再试 ' + (5 - item2.tries) + ' 次' };
                }
                delete store2[mail2];
                writeCodes(store2);
                var pwdErr = checkNewPassword(params.newPassword);
                if (pwdErr) { return { code: 500, message: pwdErr }; }
                var all = userSvcRef.raw();
                for (var ri = 0; ri < all.length; ri++) {
                    if (String(all[ri].id) === String(hit2.user.id)) {
                        all[ri].password = md5(String(params.newPassword));
                        all[ri].token = '';
                        all[ri].tokenExpireTime = '';
                    }
                }
                userSvcRef.write(all);
                return { code: 0, message: 'ok', data: {
                    reset: true, mailed: true, emailMask: maskEmail(mail2),
                    account: hit2.user.account, message: ''
                } };
            }

            /* 登录后自助改密：原密码校验通过后写新密码，并作废 token（需重新登录） */
            if (path === '/changepwd' && method === 'POST') {
                // 离线模式下 request() 不会往参数里塞 token，这里从本地登录态补一份（与真实后端同口径）
                var tk2 = String(params.token || '');
                if (!tk2) {
                    var liveSession = readSession();
                    tk2 = String((liveSession && liveSession.token) || '');
                }
                var owner = null;
                for (var ci = 0; ci < rows.length; ci++) {
                    if (tk2 && String(rows[ci].token) === tk2) { owner = rows[ci]; break; }
                }
                if (!owner) { return { code: 401, message: '登录已失效，请重新登录' }; }
                if (!params.oldPassword) { return { code: 500, message: '请输入原密码' }; }
                if (String(owner.password) !== md5(String(params.oldPassword))) {
                    return { code: 500, message: '原密码不正确' };
                }
                var pErr = checkNewPassword(params.newPassword);
                if (pErr) { return { code: 500, message: pErr }; }
                if (md5(String(params.newPassword)) === String(owner.password)) {
                    return { code: 500, message: '新密码不能与原密码相同' };
                }
                owner.password = md5(String(params.newPassword));
                owner.token = '';
                owner.tokenExpireTime = '';
                userSvcRef.write(rows);
                return { code: 0, message: 'ok', data: {
                    changed: true, logout: true, account: owner.account,
                    message: '密码已修改，请用新密码重新登录'
                } };
            }

            return { code: 404, message: '接口不存在：' + path };
        }

        return { route: route };
    }

    var authSvc = createAuthService(empSvc, userInfoSvc);

    /* ---------------- 服务信箱（serviceemail）模拟服务 ----------------
       与后端一致：UUID 主键、**单例表（全表只允许一条记录，add 时已有记录直接拒绝）**、
       这条记录只有一个启用状态位、密码只进不出（列表/详情只给 ******）；
       服务器地址留空时按域名推断。 */
    function createServiceEmailService() {
        var KEY = 'menu_admin_serviceemail_v1';
        var SEED = [{
            id: 'se-0000-4000-8000-000000000001',
            email: 'service@jiudou.com',
            password: 'demo-123456',
            displayName: '九豆服务信箱',
            smtpHost: '', smtpPort: '',
            imapHost: '', imapPort: '',
            useSsl: true,
            enabled: true,
            lastSyncTime: '',
            lastError: '',
            remark: '离线演示用服务信箱（不会真的收发邮件）',
            createTime: '2026-11-01 09:00:00',
            updateTime: '2026-11-01 09:00:00'
        }];
        function read() {
            try {
                var raw = window.localStorage.getItem(KEY);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            var seed = clone(SEED);
            write(seed);
            return seed;
        }
        function write(list) {
            try { window.localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { }
        }
        function hostsOf(one) {
            var guess = mailProvider(one.email);
            return {
                imapHost: one.imapHost || guess.imapHost,
                imapPort: parseInt(one.imapPort, 10) || guess.imapPort,
                smtpHost: one.smtpHost || guess.smtpHost,
                smtpPort: parseInt(one.smtpPort, 10) || guess.smtpPort,
                provider: guess.provider
            };
        }
        function attach(one) {
            if (!one) { return null; }
            var out = clone(one);
            out.hasPassword = !!out.password;
            out.passwordMask = out.password ? '******' : '';
            delete out.password;                     // 密码永不返回
            out.useSsl = !!out.useSsl;
            out.enabled = !!out.enabled;
            out.displayName = out.displayName || String(out.email || '').split('@')[0];
            var h = hostsOf(one);
            out.provider = h.provider;
            out.imapHostText = h.imapHost;
            out.imapPortText = h.imapPort;
            out.smtpHostText = h.smtpHost;
            out.smtpPortText = h.smtpPort;
            out.lastSyncTime = out.lastSyncTime || '';
            out.lastError = out.lastError || '';
            return out;
        }
        function enabledEmail(list) {
            for (var i = 0; i < list.length; i++) { if (list[i].enabled) { return list[i].email; } }
            return '';
        }
        function findById(list, id) {
            for (var i = 0; i < list.length; i++) { if (String(list[i].id) === String(id)) { return list[i]; } }
            return null;
        }
        function isOn(v) { return !(v === 0 || v === '0' || v === false || v === 'false'); }

        function route(method, path, params) {
            params = params || {};
            var rows = read(), i, one;
            if (path === '/list') {
                var keyword = String(params.keyword || '').toLowerCase();
                var want = String(params.enabled === undefined || params.enabled === null ? '' : params.enabled);
                var list = [];
                for (i = 0; i < rows.length; i++) {
                    one = rows[i];
                    if (keyword && String(one.email + ' ' + (one.displayName || '') + ' ' + (one.remark || ''))
                        .toLowerCase().indexOf(keyword) < 0) { continue; }
                    if (want !== '' && (want === '1') !== !!one.enabled) { continue; }
                    list.push(one);
                }
                list.sort(function (a, b) {
                    if (!!b.enabled !== !!a.enabled) { return b.enabled ? 1 : -1; }
                    return String(a.createTime).localeCompare(String(b.createTime));
                });
                var pageNum = Math.max(1, parseInt(params.pageNum, 10) || 1);
                var pageSize = Math.min(Math.max(parseInt(params.pageSize, 10) || 10, 1), 200);
                var pages = Math.max(1, Math.ceil(list.length / pageSize));
                pageNum = Math.min(pageNum, pages);
                var slice = list.slice((pageNum - 1) * pageSize, pageNum * pageSize);
                var items = [];
                for (i = 0; i < slice.length; i++) { items.push(attach(slice[i])); }
                return { code: 0, message: 'ok', data: {
                    list: items, total: list.length, pageNum: pageNum, pageSize: pageSize,
                    pages: pages, enabledEmail: enabledEmail(rows), maxEnabled: 1
                } };
            }
            if (path === '/detail') {
                one = findById(rows, params.id);
                if (!one) { return { code: 404, message: '服务信箱不存在或已被删除' }; }
                return { code: 0, message: 'ok', data: attach(one) };
            }
            if (path === '/check') {
                var field = String(params.field || 'email');
                if (field !== 'email') { return { code: 500, message: '不支持的唯一性校验字段：' + field }; }
                var value = String(params.value || '');
                if (!value) { return { code: 0, message: 'ok', data: { unique: true } }; }
                for (i = 0; i < rows.length; i++) {
                    if (rows[i].email === value && String(rows[i].id) !== String(params.id || '')) {
                        return { code: 0, message: 'ok', data: { unique: false } };
                    }
                }
                return { code: 0, message: 'ok', data: { unique: true } };
            }
            if (path === '/add' || path === '/update') {
                var email = String(params.email || '').toLowerCase();
                if (!email) { return { code: 500, message: '服务信箱地址不能为空' }; }
                if (!mailIsEmail(email)) { return { code: 500, message: '服务信箱地址格式不正确' }; }
                var selfId = path === '/update' ? String(params.id || '') : '';
                var current = path === '/update' ? findById(rows, selfId) : null;
                if (path === '/update' && !current) { return { code: 404, message: '服务信箱不存在或已被删除' }; }
                for (i = 0; i < rows.length; i++) {
                    if (rows[i].email === email && String(rows[i].id) !== selfId) {
                        return { code: 500, message: '该服务信箱已存在，请勿重复添加' };
                    }
                }
                var pwd = String(params.password || '');
                if (path === '/add' && !pwd) { return { code: 500, message: '请填写邮箱密码或授权码' }; }
                // 单例表：全表只保留一条记录（与后端 _assert_single 一致）
                if (path === '/add' && rows.length > 0) {
                    return { code: 500, message: '服务信箱只允许一条记录，请直接编辑已有记录' };
                }
                var wantOn = ('enabled' in params) ? isOn(params.enabled) : (current ? !!current.enabled : false);
                if (wantOn) {
                    for (i = 0; i < rows.length; i++) {
                        if (String(rows[i].id) !== selfId) { rows[i].enabled = false; }
                    }
                }
                var t = now();
                if (path === '/add') {
                    one = {
                        id: mockUuid(), email: email, password: pwd,
                        displayName: String(params.displayName || '').trim() || email.split('@')[0],
                        smtpHost: String(params.smtpHost || '').trim(), smtpPort: String(params.smtpPort || ''),
                        imapHost: String(params.imapHost || '').trim(), imapPort: String(params.imapPort || ''),
                        useSsl: isOn(params.useSsl === undefined ? 1 : params.useSsl),
                        enabled: wantOn, lastSyncTime: '', lastError: '',
                        remark: String(params.remark || '').trim(),
                        createTime: t, updateTime: t
                    };
                    rows.push(one);
                } else {
                    one = current;
                    one.email = email;
                    if (pwd) { one.password = pwd; }
                    one.displayName = String(params.displayName || '').trim() || email.split('@')[0];
                    one.smtpHost = String(params.smtpHost || '').trim();
                    one.smtpPort = String(params.smtpPort || '');
                    one.imapHost = String(params.imapHost || '').trim();
                    one.imapPort = String(params.imapPort || '');
                    one.useSsl = isOn(params.useSsl === undefined ? 1 : params.useSsl);
                    one.enabled = wantOn;
                    one.remark = String(params.remark || '').trim();
                    one.updateTime = t;
                }
                write(rows);
                return { code: 0, message: path === '/add' ? '新增成功' : '保存成功', data: attach(one) };
            }
            if (path === '/enabled') {
                one = findById(rows, params.id);
                if (!one) { return { code: 404, message: '服务信箱不存在或已被删除' }; }
                var on = isOn(params.enabled === undefined ? 1 : params.enabled);
                if (on) {
                    for (i = 0; i < rows.length; i++) {
                        if (String(rows[i].id) !== String(one.id)) { rows[i].enabled = false; }
                    }
                }
                one.enabled = on;
                write(rows);
                var item = attach(one);
                item.enabledEmail = enabledEmail(rows);
                item.message = on ? ('服务信箱「' + one.email + '」已启用') : ('服务信箱「' + one.email + '」已停用');
                return { code: 0, message: item.message, data: item };
            }
            if (path === '/test') {
                one = findById(rows, params.id);
                if (!one) { return { code: 404, message: '服务信箱不存在或已被删除' }; }
                if (!one.password) { return { code: 500, message: '该服务信箱还没有设置密码 / 授权码，请先编辑填写' }; }
                var hh = hostsOf(one);
                return { code: 0, message: '连接测试通过（离线演示，未真实连接邮箱）', data: {
                    ok: true, imap: true, smtp: true, email: one.email, lastError: '',
                    servers: { imapHost: hh.imapHost, imapPort: hh.imapPort, smtpHost: hh.smtpHost, smtpPort: hh.smtpPort },
                    messages: {
                        imap: '收件服务连接成功（离线演示，' + hh.imapHost + ':' + hh.imapPort + '）',
                        smtp: '发件服务连接成功（离线演示，' + hh.smtpHost + ':' + hh.smtpPort + '）'
                    }
                } };
            }
            if (path === '/delete') {
                one = findById(rows, params.id);
                if (!one) { return { code: 404, message: '服务信箱不存在或已被删除' }; }
                var kept = [], removedMsgs = 0;
                for (i = 0; i < rows.length; i++) {
                    if (String(rows[i].id) !== String(one.id)) { kept.push(rows[i]); }
                }
                write(kept);
                // 同一信箱下的邮件一并删除（与后端一致）
                var mails = readMailStore();
                var leftMails = [];
                for (i = 0; i < mails.length; i++) {
                    if (String(mails[i].serviceEmailId) === String(one.id)) { removedMsgs++; }
                    else { leftMails.push(mails[i]); }
                }
                writeMailStore(leftMails);
                var back = attach(one);
                back.removedMails = removedMsgs;
                return { code: 0, message: '删除成功', data: back };
            }
            return { code: 404, message: '接口不存在：/serviceemail' + path };
        }
        return { route: route, raw: read, write: write };
    }

    /* ---------------- 邮箱助手（mail）模拟服务 ----------------
       数据来自「当前启用的服务信箱」；收件在离线模式下会追加一封演示邮件，便于本地演示与页面测试 */
    var MAIL_KEY = 'menu_admin_mail_v1';
    function readMailStore() {
        try {
            var raw = window.localStorage.getItem(MAIL_KEY);
            if (raw) { return JSON.parse(raw); }
        } catch (e) { }
        var seed = [
            {
                id: 'msg-0000-4000-8000-000000000001', serviceEmailId: 'se-0000-4000-8000-000000000001',
                direction: 'in', uid: '1001', messageId: '<demo-1@customer.com>',
                fromAddr: 'customer@example.com', fromName: '张客户',
                toAddr: 'service@jiudou.com', ccAddr: '',
                subject: '关于产品报价的咨询', sentTime: '2026-11-01 09:20:00',
                bodyText: '您好，\n\n我们在官网看到贵公司的综合管理平台，想了解一下 50 人规模团队的报价与实施周期。\n\n谢谢！',
                bodyHtml: '', hasAttach: false, seen: false, createTime: '2026-11-01 09:21:00'
            },
            {
                id: 'msg-0000-4000-8000-000000000002', serviceEmailId: 'se-0000-4000-8000-000000000001',
                direction: 'in', uid: '1002', messageId: '<demo-2@partner.com>',
                fromAddr: 'partner@example.org', fromName: '合作方 李工',
                toAddr: 'service@jiudou.com', ccAddr: 'sales@jiudou.com',
                subject: '接口对接联调时间确认', sentTime: '2026-10-31 17:05:00',
                bodyText: '本周四下午两点联调可以吗？我们这边已经准备好测试环境。',
                bodyHtml: '', hasAttach: true,
                attachments: [mockAttachDemo('联调接口说明.txt'), mockAttachDemo('测试环境清单.csv')],
                seen: true, createTime: '2026-10-31 17:06:00'
            },
            {
                id: 'msg-0000-4000-8000-000000000003', serviceEmailId: 'se-0000-4000-8000-000000000001',
                direction: 'out', uid: 'out-0001', messageId: '',
                fromAddr: 'service@jiudou.com', fromName: '九豆服务信箱',
                toAddr: 'customer@example.com', ccAddr: '',
                subject: 'Re: 关于产品报价的咨询', sentTime: '2026-10-30 10:12:00',
                bodyText: '您好，报价单已整理并附在邮件中，如有疑问随时联系。',
                bodyHtml: '', hasAttach: false, seen: true, createTime: '2026-10-30 10:12:00'
            }
        ];
        try { window.localStorage.setItem(MAIL_KEY, JSON.stringify(seed)); } catch (e) { }
        return seed;
    }
    function writeMailStore(list) {
        try { window.localStorage.setItem(MAIL_KEY, JSON.stringify(list)); } catch (e) { }
    }
    /* ---------- 邮件附件下载（离线演示）：内容以 dataURL 存在邮件对象里 ----------
       真实后端把附件内容落盘到 data/mailattach/，下载走 /mailattach/download 二进制流；
       Mock 里用 dataURL 代替，页面用 <a download> 直接保存，行为一致。 */
    function mockAttachSizeText(size) {
        var n = parseInt(size, 10);
        if (!(n > 0)) { return '0 B'; }
        if (n < 1024) { return n + ' B'; }
        if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }
    /** 造一个演示附件（历史邮件点「获取附件」后补出来的样例） */
    function mockAttachDemo(name) {
        var b64 = 'Sml1ZG91IGRlbW8gYXR0YWNobWVudA==';   // "Jiudou demo attachment"
        return {
            id: mockUuid(), name: name, size: 23, contentType: 'text/plain',
            dataUrl: 'data:text/plain;base64,' + b64, downloadable: true
        };
    }
    function mockAttachDemoList() {
        return [mockAttachDemo('联调接口说明.txt'), mockAttachDemo('测试环境清单.csv')];
    }
    /** 附件原始对象 → 读信区下载清单（与后端 mail_attach_list 同字段） */
    function mockAttachView(list) {
        var out = [], i, a;
        for (i = 0; i < (list || []).length; i++) {
            a = list[i] || {};
            out.push({
                id: a.id || ('ma-' + i), name: a.name || '',
                size: parseInt(a.size, 10) || 0, sizeText: mockAttachSizeText(a.size),
                contentType: a.contentType || '', sortNo: i,
                downloadable: a.downloadable !== false && !!a.dataUrl
            });
        }
        return out;
    }
    /** 把写邮件弹窗传来的 base64 / dataURL 转成 Mock 可下载的 dataURL */
    function mockAttachDataUrl(raw) {
        var text = String(raw || '');
        if (text.indexOf('data:') === 0) { return text; }
        return 'data:application/octet-stream;base64,' + text;
    }
    /** /mailattach/download 的离线实现：按 source 分库、按附件 id 找，empmail 强制带 empId */
    function mockAttachDownload(params) {
        var src = String(params.source || '');
        var rows = src === 'empmail' ? readEmpMails() : (src === 'mail' ? readMailStore() : []);
        var me = parseInt(empMailMe(), 10);
        for (var i = 0; i < rows.length; i++) {
            if (src === 'empmail' && parseInt(rows[i].empId, 10) !== me) { continue; }
            var list = rows[i].attachments || [];
            for (var j = 0; j < list.length; j++) {
                if (String(list[j].id) === String(params.id || '')) {
                    if (!list[j].dataUrl) { return { code: 404, message: '该附件内容未保存，无法下载' }; }
                    return { code: 0, message: 'ok', data: {
                        name: list[j].name, size: list[j].size || 0,
                        contentType: list[j].contentType || 'application/octet-stream',
                        dataUrl: list[j].dataUrl
                    } };
                }
            }
        }
        return { code: 404, message: '附件不存在或已被删除' };
    }

    function createMailService(seSvc) {
        function activeAccount() {
            var rows = seSvc.raw();
            for (var i = 0; i < rows.length; i++) { if (rows[i].enabled) { return rows[i]; } }
            return null;
        }
        function unreadOf(rows, accountId) {
            var n = 0;
            for (var i = 0; i < rows.length; i++) {
                if (String(rows[i].serviceEmailId) === String(accountId) &&
                    rows[i].direction === 'in' && !rows[i].seen) { n++; }
            }
            return n;
        }
        function countsOf(rows, accountId) {
            var inbox = 0, sent = 0;
            for (var i = 0; i < rows.length; i++) {
                if (String(rows[i].serviceEmailId) !== String(accountId)) { continue; }
                if (rows[i].direction === 'in') { inbox++; } else { sent++; }
            }
            return { inbox: inbox, sent: sent };
        }
        function hostInfo(one) {
            var guess = mailProvider(one.email);
            return {
                imapHost: one.imapHost || guess.imapHost, imapPort: parseInt(one.imapPort, 10) || guess.imapPort,
                smtpHost: one.smtpHost || guess.smtpHost, smtpPort: parseInt(one.smtpPort, 10) || guess.smtpPort,
                useSsl: !!one.useSsl, provider: guess.provider
            };
        }
        function route(method, path, params) {
            params = params || {};
            var acc = activeAccount();
            var rows = readMailStore();
            if (path === '/status') {
                if (!acc) {
                    return { code: 0, message: 'ok', data: {
                        configured: false, email: '', displayName: '', unread: 0,
                        counts: { inbox: 0, sent: 0 }, lastSyncTime: '', lastError: '', servers: {}, accounts: seSvc.raw().length,
                        message: '尚未配置服务信箱，请点右上角「设置」按钮新增一条'
                    } };
                }
                return { code: 0, message: 'ok', data: {
                    configured: true, id: acc.id, email: acc.email,
                    displayName: acc.displayName || acc.email.split('@')[0],
                    unread: unreadOf(rows, acc.id), counts: countsOf(rows, acc.id),
                    lastSyncTime: acc.lastSyncTime || '', lastError: acc.lastError || '',
                    servers: hostInfo(acc), accounts: seSvc.raw().length, message: ''
                } };
            }
            if (!acc) { return { code: 500, message: '尚未启用服务信箱，请点邮箱助手右上角的「设置」按钮完成配置并启用' }; }
            if (path === '/list') {
                var folder = String(params.folder || 'inbox');
                var direction = (folder === 'sent' || folder === 'out') ? 'out' : 'in';
                var keyword = String(params.keyword || '').toLowerCase();
                var list = [], i, one;
                for (i = 0; i < rows.length; i++) {
                    one = rows[i];
                    if (String(one.serviceEmailId) !== String(acc.id)) { continue; }
                    if (one.direction !== direction) { continue; }
                    if (keyword && String(one.subject + ' ' + one.fromAddr + ' ' + one.fromName + ' ' + one.toAddr)
                        .toLowerCase().indexOf(keyword) < 0) { continue; }
                    list.push(one);
                }
                list.sort(function (a, b) { return String(b.sentTime).localeCompare(String(a.sentTime)); });
                var pageNum = Math.max(1, parseInt(params.pageNum, 10) || 1);
                var pageSize = Math.min(Math.max(parseInt(params.pageSize, 10) || 20, 1), 100);
                var pages = Math.max(1, Math.ceil(list.length / pageSize));
                pageNum = Math.min(pageNum, pages);
                var slice = list.slice((pageNum - 1) * pageSize, pageNum * pageSize);
                var items = [];
                for (i = 0; i < slice.length; i++) {
                    var it = clone(slice[i]);
                    it.summaryFrom = it.fromName || it.fromAddr;
                    items.push(it);
                }
                return { code: 0, message: 'ok', data: {
                    list: items, total: list.length, pageNum: pageNum, pageSize: pageSize, pages: pages,
                    folder: direction === 'out' ? 'sent' : 'inbox', email: acc.email,
                    unread: unreadOf(rows, acc.id), counts: countsOf(rows, acc.id)
                } };
            }
            if (path === '/detail') {
                var target = null;
                for (var di = 0; di < rows.length; di++) {
                    if (String(rows[di].id) === String(params.id)) { target = rows[di]; break; }
                }
                if (!target) { return { code: 404, message: '邮件不存在或已被删除' }; }
                if (!(params.markRead === 0 || params.markRead === '0' || params.markRead === false) && !target.seen) {
                    target.seen = true;
                    writeMailStore(rows);
                }
                var d = clone(target);
                d.directionText = d.direction === 'out' ? '发件' : '收件';
                d.attachments = mockAttachView(d.attachments);
                d.attachNeedFetch = !!(d.hasAttach && d.direction === 'in' && !d.attachments.length);
                d.unread = unreadOf(rows, acc.id);
                return { code: 0, message: 'ok', data: d };
            }
            if (path === '/attachments') {
                var at = null;
                for (var ai0 = 0; ai0 < rows.length; ai0++) {
                    if (String(rows[ai0].id) === String(params.id)) { at = rows[ai0]; break; }
                }
                if (!at) { return { code: 404, message: '邮件不存在或已被删除' }; }
                var doRefresh = params.refresh === 1 || params.refresh === '1' || params.refresh === true;
                if (doRefresh && at.direction === 'in') {
                    if (!at.attachments || !at.attachments.length) {
                        at.attachments = mockAttachDemoList();
                        at.hasAttach = true;
                        writeMailStore(rows);
                    }
                    return { code: 0, message: 'ok', data: {
                        list: mockAttachView(at.attachments), refreshed: true, needFetch: false,
                        message: '已获取 ' + at.attachments.length + ' 个附件'
                    } };
                }
                return { code: 0, message: 'ok', data: {
                    list: mockAttachView(at.attachments), refreshed: false,
                    needFetch: !!(at.hasAttach && at.direction === 'in' &&
                        (!at.attachments || !at.attachments.length))
                } };
            }
            if (path === '/sync') {
                // 离线演示：补一封「新收到」的演示邮件（真实后端会真的连 IMAP 收件）
                var seq = 0;
                for (var si = 0; si < rows.length; si++) {
                    var u = parseInt(rows[si].uid, 10) || 0;
                    if (u > seq) { seq = u; }
                }
                var t = now();
                var demo = {
                    id: mockUuid(), serviceEmailId: acc.id, direction: 'in',
                    uid: String(seq + 1), messageId: '<demo-' + (seq + 1) + '@example.com>',
                    fromAddr: 'notice@example.com', fromName: '系统通知',
                    toAddr: acc.email, ccAddr: '',
                    subject: '【演示】自动收件成功（' + (seq + 1) + '）', sentTime: t,
                    bodyText: '这是离线演示模式下的模拟收件：真实环境会通过 IMAP 拉取收件箱里的邮件。',
                    bodyHtml: '', hasAttach: false, seen: false, createTime: t
                };
                rows.push(demo);
                writeMailStore(rows);
                var seRows = seSvc.raw();
                for (var k = 0; k < seRows.length; k++) {
                    if (String(seRows[k].id) === String(acc.id)) { seRows[k].lastSyncTime = t; }
                }
                seSvc.write(seRows);
                return { code: 0, message: '收件完成（离线演示）', data: {
                    fetched: 1, saved: 1, email: acc.email, lastSyncTime: t,
                    unread: unreadOf(rows, acc.id), counts: countsOf(rows, acc.id)
                } };
            }
            if (path === '/send') {
                function toList(raw) {
                    var text = String(raw || '').replace(/，/g, ',').replace(/；/g, ',');
                    var parts = text.split(/[,;\s]+/), out = [];
                    for (var pi = 0; pi < parts.length; pi++) {
                        var one = parts[pi];
                        if (!one) { continue; }
                        if (!mailIsEmail(one)) { return { error: '收件人地址格式不正确：' + one }; }
                        if (out.indexOf(one) < 0) { out.push(one); }
                    }
                    return { list: out };
                }
                var to = toList(params.to);
                if (to.error) { return { code: 500, message: to.error }; }
                var cc = toList(params.cc);
                if (cc.error) { return { code: 500, message: cc.error.replace('收件人', '抄送人') }; }
                if (!to.list.length) { return { code: 500, message: '请填写收件人' }; }
                var subject = String(params.subject || '').trim();
                if (!subject) { return { code: 500, message: '请填写邮件主题' }; }
                var body = String(params.body === undefined ? '' : params.body);
                var bodyHtml = String(params.bodyHtml === undefined ? '' : params.bodyHtml);
                if (!body.replace(/\s/g, '') && bodyHtml) { body = mockHtmlToText(bodyHtml); }
                if (!body.replace(/\s/g, '')) { return { code: 500, message: '请填写邮件正文' }; }
                // 附件：真实后端会把 base64 解成二进制塞进 MIME；离线模式只记录名称与大小
                var attach = [], rawAttach = params.attachments;
                if (typeof rawAttach === 'string') {
                    try { rawAttach = rawAttach ? JSON.parse(rawAttach) : []; } catch (e) { rawAttach = []; }
                }
                if (Object.prototype.toString.call(rawAttach) === '[object Array]') {
                    for (var ai = 0; ai < rawAttach.length; ai++) {
                        var raw = rawAttach[ai] || {};
                        var b64 = String(raw.data === undefined ? '' : raw.data);
                        var cut = b64.indexOf(';base64,');
                        if (cut >= 0) { b64 = b64.slice(cut + 8); }
                        var size = parseInt(raw.size, 10);
                        if (!(size > 0)) { size = Math.floor(b64.replace(/=+$/, '').length * 3 / 4); }
                        attach.push({
                            id: mockUuid(), name: String(raw.name || 'attachment'), size: size,
                            contentType: String(raw.type || raw.contentType || 'application/octet-stream'),
                            dataUrl: b64 ? mockAttachDataUrl(b64) : '', downloadable: !!b64
                        });
                    }
                }
                if (attach.length > 5) { return { code: 500, message: '最多只能添加 5 个附件' }; }
                var st = now();
                var item = {
                    id: mockUuid(), serviceEmailId: acc.id, direction: 'out', uid: mockUuid(),
                    messageId: '', fromAddr: acc.email, fromName: acc.displayName || acc.email,
                    toAddr: to.list.join(', '), ccAddr: cc.list.join(', '), subject: subject,
                    sentTime: st, bodyText: body, bodyHtml: bodyHtml, hasAttach: attach.length > 0,
                    attachments: attach, seen: true, createTime: st
                };
                rows.push(item);
                writeMailStore(rows);
                return { code: 0, message: '邮件已发送（离线演示）', data: {
                    id: item.id, to: to.list, cc: cc.list, subject: subject, sentTime: st,
                    attachments: attach, email: acc.email, counts: countsOf(rows, acc.id)
                } };
            }
            if (path === '/mark') {
                var ids = params.ids || params.id;
                if (!ids) { return { code: 500, message: '请先选择邮件' }; }
                ids = Object.prototype.toString.call(ids) === '[object Array]' ? ids : String(ids).split(/[,\s]+/);
                var seen = !(params.seen === 0 || params.seen === '0' || params.seen === false);
                var n = 0;
                for (var mi = 0; mi < rows.length; mi++) {
                    for (var mj = 0; mj < ids.length; mj++) {
                        if (String(rows[mi].id) === String(ids[mj])) { rows[mi].seen = seen; n++; }
                    }
                }
                writeMailStore(rows);
                return { code: 0, message: '操作成功', data: { updated: n, seen: seen, unread: unreadOf(rows, acc.id) } };
            }
            if (path === '/delete') {
                var delIds = params.ids || params.id;
                if (!delIds) { return { code: 500, message: '请先选择邮件' }; }
                delIds = Object.prototype.toString.call(delIds) === '[object Array]' ? delIds : String(delIds).split(/[,\s]+/);
                var left = [], removed = 0;
                for (var li = 0; li < rows.length; li++) {
                    var hit = false;
                    for (var lj = 0; lj < delIds.length; lj++) {
                        if (String(rows[li].id) === String(delIds[lj])) { hit = true; break; }
                    }
                    if (hit) { removed++; } else { left.push(rows[li]); }
                }
                writeMailStore(left);
                return { code: 0, message: '删除成功', data: { deleted: removed, ids: delIds } };
            }
            return { code: 404, message: '接口不存在：/mail' + path };
        }
        return { route: route, raw: readMailStore, write: writeMailStore };
    }

    /* ---------------- 我的邮箱（empmail）模拟服务 ----------------
       与后端 EmpMailService 同口径：一人一条信箱配置、每封邮件带 empId，
       **所有读写都按当前登录员工过滤**，前端传 empId 一律无效（越权演示数据看不到）。
       离线演示：取不到登录态时回退到演示员工 3；真实后端只认 token 反查的 empId。
       /sync 会追加一封演示邮件，用于验证「配置后自动收件」。 */
    var EMPMAIL_BOX_KEY = 'menu_admin_empemailbox_v1';
    var EMPMAIL_MSG_KEY = 'menu_admin_empmailmsg_v1';
    var EMPMAIL_DEMO_EMP = 3;

    function empMailMe() {
        return mockLoginEmpId() || EMPMAIL_DEMO_EMP;
    }
    function readEmpMailBoxes() {
        try {
            var raw = window.localStorage.getItem(EMPMAIL_BOX_KEY);
            if (raw) { return JSON.parse(raw); }
        } catch (e) { }
        var seed = [
            {
                id: 'emb-0000-4000-8000-000000000003', empId: 3,
                email: 'yangweikang@jiudou.com', password: 'demo-123456',
                displayName: '杨伟康', smtpHost: '', smtpPort: '', imapHost: '', imapPort: '',
                useSsl: true, enabled: true, autoSync: true,
                lastSyncTime: '2026-11-06 09:00:00', lastError: '',
                remark: '我的工作邮箱（离线演示）',
                createTime: '2026-11-01 09:00:00', updateTime: '2026-11-06 09:00:00'
            },
            {
                id: 'emb-0000-4000-8000-000000000001', empId: 1,
                email: 'admin@jiudou.com', password: 'demo-admin',
                displayName: '系统管理员', smtpHost: '', smtpPort: '', imapHost: '', imapPort: '',
                useSsl: true, enabled: true, autoSync: false,
                lastSyncTime: '2026-11-05 16:20:00', lastError: '',
                remark: '另一名员工的信箱（用于验证隔离）',
                createTime: '2026-11-01 08:00:00', updateTime: '2026-11-05 16:20:00'
            }
        ];
        writeEmpMailBoxes(seed);
        return seed;
    }
    function writeEmpMailBoxes(list) {
        try { window.localStorage.setItem(EMPMAIL_BOX_KEY, JSON.stringify(list)); } catch (e) { }
    }
    function readEmpMails() {
        try {
            var raw = window.localStorage.getItem(EMPMAIL_MSG_KEY);
            if (raw) { return JSON.parse(raw); }
        } catch (e) { }
        var seed = [
            {
                id: 'emm-0000-4000-8000-000000000031', empId: 3, direction: 'in',
                uid: '2001', messageId: '<emp-31@example.com>',
                fromAddr: 'partner@example.com', fromName: '合作方 王经理',
                toAddr: 'yangweikang@jiudou.com', ccAddr: '',
                subject: '关于下周需求评审的安排', sentTime: '2026-11-06 08:40:00',
                bodyText: '杨工您好，下周二的需求评审材料已经准备好了，麻烦您抽空确认一下时间。\n\n谢谢！',
                bodyHtml: '', hasAttach: false, seen: false, createTime: '2026-11-06 08:41:00'
            },
            {
                id: 'emm-0000-4000-8000-000000000032', empId: 3, direction: 'in',
                uid: '2002', messageId: '<emp-32@example.com>',
                fromAddr: 'hr@example.com', fromName: '人事部',
                toAddr: 'yangweikang@jiudou.com', ccAddr: 'team@example.com',
                subject: '11 月考勤确认提醒', sentTime: '2026-11-05 15:10:00',
                bodyText: '请于本周五前在系统中确认 10 月考勤，逾期将按默认处理。',
                bodyHtml: '', hasAttach: true, seen: true, createTime: '2026-11-05 15:11:00'
            },
            {
                id: 'emm-0000-4000-8000-000000000033', empId: 3, direction: 'out',
                uid: 'out-2001', messageId: '',
                fromAddr: 'yangweikang@jiudou.com', fromName: '杨伟康',
                toAddr: 'partner@example.com', ccAddr: '',
                subject: 'Re: 关于下周需求评审的安排', sentTime: '2026-11-05 10:02:00',
                bodyText: '收到，材料我先看一下，时间暂定周二下午两点。',
                bodyHtml: '', hasAttach: false, seen: true, createTime: '2026-11-05 10:02:00'
            },
            {
                id: 'emm-0000-4000-8000-000000000011', empId: 1, direction: 'in',
                uid: '1001', messageId: '<emp-11@example.com>',
                fromAddr: 'ceo@example.com', fromName: '总经理办公室',
                toAddr: 'admin@jiudou.com', ccAddr: '',
                subject: '【机密】管理员专用邮件（其它员工不应看到）', sentTime: '2026-11-04 11:00:00',
                bodyText: '这封邮件只属于系统管理员，用来验证「各员只看本信箱的历史邮件」。',
                bodyHtml: '', hasAttach: false, seen: false, createTime: '2026-11-04 11:01:00'
            },
            {
                id: 'emm-0000-4000-8000-000000000012', empId: 1, direction: 'out',
                uid: 'out-1001', messageId: '',
                fromAddr: 'admin@jiudou.com', fromName: '系统管理员',
                toAddr: 'ops@example.com', ccAddr: '',
                subject: '管理员发出的邮件', sentTime: '2026-11-03 09:30:00',
                bodyText: '仅管理员可见。', bodyHtml: '',
                hasAttach: false, seen: true, createTime: '2026-11-03 09:30:00'
            }
        ];
        writeEmpMails(seed);
        return seed;
    }
    function writeEmpMails(list) {
        try { window.localStorage.setItem(EMPMAIL_MSG_KEY, JSON.stringify(list)); } catch (e) { }
    }

    function createEmpMailService() {
        function boxOf(rows, empId) {
            for (var i = 0; i < rows.length; i++) {
                if (parseInt(rows[i].empId, 10) === empId) { return rows[i]; }
            }
            return null;
        }
        function hostInfo(one) {
            var guess = mailProvider(one.email);
            return {
                imapHost: one.imapHost || guess.imapHost, imapPort: parseInt(one.imapPort, 10) || guess.imapPort,
                smtpHost: one.smtpHost || guess.smtpHost, smtpPort: parseInt(one.smtpPort, 10) || guess.smtpPort,
                useSsl: !!one.useSsl, provider: guess.provider
            };
        }
        function viewBox(one) {
            if (!one) { return null; }
            var out = clone(one);
            out.hasPassword = !!out.password;
            out.passwordMask = out.password ? '******' : '';
            delete out.password;
            out.useSsl = !!out.useSsl;
            out.enabled = !!out.enabled;
            out.autoSync = !!out.autoSync;
            out.empId = parseInt(out.empId, 10) || 0;
            var h = hostInfo(one);
            out.provider = h.provider;
            out.imapHostText = h.imapHost;
            out.imapPortText = h.imapPort;
            out.smtpHostText = h.smtpHost;
            out.smtpPortText = h.smtpPort;
            out.lastSyncTime = out.lastSyncTime || '';
            out.lastError = out.lastError || '';
            return out;
        }
        /** 员工信息表里的邮箱：首次配置「我的邮箱」时预填（与后端 _emp_email 同口径） */
        function empArchiveEmail(empId) {
            try {
                // empSvc 由 createService 创建，暴露的是 listRaw()（不是 raw()）
                var rows = empSvc.listRaw() || [];
                for (var i = 0; i < rows.length; i++) {
                    if (parseInt(rows[i].id, 10) === parseInt(empId, 10)) {
                        return rows[i].email || '';
                    }
                }
            } catch (e) { /* 员工 store 不可用时静默置空 */ }
            return '';
        }
        function unreadOf(rows, empId) {
            var n = 0;
            for (var i = 0; i < rows.length; i++) {
                if (parseInt(rows[i].empId, 10) === empId &&
                    rows[i].direction === 'in' && !rows[i].seen) { n++; }
            }
            return n;
        }
        function countsOf(rows, empId) {
            var inbox = 0, sent = 0;
            for (var i = 0; i < rows.length; i++) {
                if (parseInt(rows[i].empId, 10) !== empId) { continue; }
                if (rows[i].direction === 'in') { inbox++; } else { sent++; }
            }
            return { inbox: inbox, sent: sent };
        }
        function statusData(boxRows, msgRows, empId) {
            var box = boxOf(boxRows, empId);
            if (!box) {
                return {
                    configured: false, empId: empId, email: '', displayName: '',
                    unread: 0, counts: { inbox: 0, sent: 0 }, lastSyncTime: '',
                    lastError: '', servers: {}, autoSync: true, enabled: true,
                    hasPassword: false,
                    // 首次配置预填：员工信息表里的邮箱（与后端 EmpMailService._emp_email 同口径）
                    suggestEmail: empArchiveEmail(empId),
                    message: '还没有配置个人邮箱，请点右上角「设置」填写邮箱与授权码'
                };
            }
            var out = viewBox(box);
            var h = hostInfo(box);
            out.configured = true;
            out.unread = unreadOf(msgRows, empId);
            out.counts = countsOf(msgRows, empId);
            out.servers = { imapHost: h.imapHost, imapPort: h.imapPort,
                smtpHost: h.smtpHost, smtpPort: h.smtpPort,
                useSsl: !!h.useSsl, provider: h.provider };
            out.message = '';
            return out;
        }
        function isOn(v, def) {
            if (v === undefined || v === null) { return def === undefined ? true : !!def; }
            return !(v === 0 || v === '0' || v === false || v === 'false');
        }
        function route(method, path, params) {
            params = params || {};
            var me = empMailMe();
            var boxRows = readEmpMailBoxes();
            var msgRows = readEmpMails();
            var box = boxOf(boxRows, me);
            var i, one;

            /* ---- 状态（页面初始化） ---- */
            if (path === '/status') {
                return { code: 0, message: 'ok', data: statusData(boxRows, msgRows, me) };
            }
            /* ---- 保存本人配置（一人一条；前端传 empId 无效） ---- */
            if (path === '/save') {
                var email = String(params.email || '').trim().toLowerCase();
                if (!email) { return { code: 500, message: '邮箱地址不能为空' }; }
                if (!mailIsEmail(email)) { return { code: 500, message: '邮箱地址格式不正确' }; }
                var password = String(params.password || '');
                if (!box && !password) { return { code: 500, message: '请填写邮箱密码或授权码' }; }
                if (!box) {
                    box = { id: mockUuid(), empId: me, createTime: now(),
                        lastSyncTime: '', lastError: '' };
                    boxRows.push(box);
                }
                box.email = email;
                if (password) { box.password = password; }
                box.displayName = String(params.displayName || '').trim() || email.split('@')[0];
                box.smtpHost = String(params.smtpHost || '').trim();
                box.smtpPort = String(params.smtpPort || '');
                box.imapHost = String(params.imapHost || '').trim();
                box.imapPort = String(params.imapPort || '');
                box.useSsl = isOn(params.useSsl, true);
                box.enabled = isOn(params.enabled, box.enabled === undefined ? true : box.enabled);
                box.autoSync = isOn(params.autoSync, box.autoSync === undefined ? true : box.autoSync);
                box.remark = String(params.remark || '').trim();
                box.updateTime = now();
                writeEmpMailBoxes(boxRows);
                return { code: 0, message: '保存成功',
                    data: statusData(readEmpMailBoxes(), msgRows, me) };
            }
            /* ---- 测试连接（离线演示） ---- */
            if (path === '/test') {
                if (!box) { return { code: 500, message: '请先配置个人邮箱' }; }
                if (!box.password) {
                    return { code: 500, message: '还没有设置密码 / 授权码，请先在「设置」里填写' };
                }
                var hh = hostInfo(box);
                box.lastError = '';
                writeEmpMailBoxes(boxRows);
                return { code: 0, message: '连接测试通过（离线演示，未真实连接邮箱）', data: {
                    ok: true, imap: true, smtp: true, email: box.email, lastError: '',
                    servers: { imapHost: hh.imapHost, imapPort: hh.imapPort,
                        smtpHost: hh.smtpHost, smtpPort: hh.smtpPort },
                    messages: {
                        imap: '收件服务连接成功（离线演示，' + hh.imapHost + ':' + hh.imapPort + '）',
                        smtp: '发件服务连接成功（离线演示，' + hh.smtpHost + ':' + hh.smtpPort + '）'
                    }
                } };
            }
            if (!box) {
                return { code: 500, message: '请先在右上角「设置」里配置本人邮箱' };
            }
            if (!box.enabled) {
                return { code: 500, message: '个人邮箱已停用，请先在「设置」里启用' };
            }
            /* ---- 收件（离线演示：追加一封；只写当前员工） ---- */
            if (path === '/sync') {
                var seq = 0;
                for (i = 0; i < msgRows.length; i++) {
                    if (parseInt(msgRows[i].empId, 10) !== me) { continue; }
                    var u = parseInt(msgRows[i].uid, 10) || 0;
                    if (u > seq) { seq = u; }
                }
                var t = now();
                msgRows.push({
                    id: mockUuid(), empId: me, direction: 'in',
                    uid: String(seq + 1), messageId: '<emp-auto-' + (seq + 1) + '@example.com>',
                    fromAddr: 'notice@example.com', fromName: '系统通知',
                    toAddr: box.email, ccAddr: '',
                    subject: '【演示】自动收件成功（' + (seq + 1) + '）', sentTime: t,
                    bodyText: '这是离线演示模式下的自动收件：真实环境由后台线程每 5 分钟用 IMAP 拉取本人信箱。',
                    bodyHtml: '', hasAttach: false, seen: false, createTime: t
                });
                writeEmpMails(msgRows);
                var freshBoxes = readEmpMailBoxes();
                var mine = boxOf(freshBoxes, me);
                if (mine) { mine.lastSyncTime = t; mine.lastError = ''; }
                writeEmpMailBoxes(freshBoxes);
                return { code: 0, message: '收件完成（离线演示）', data: {
                    fetched: 1, saved: 1, email: box.email, empId: me,
                    lastSyncTime: t, unread: unreadOf(msgRows, me), counts: countsOf(msgRows, me)
                } };
            }
            /* ---- 邮件列表（强制按 empId） ---- */
            if (path === '/list') {
                var folder = String(params.folder || 'inbox');
                var direction = (folder === 'sent' || folder === 'out') ? 'out' : 'in';
                var keyword = String(params.keyword || '').toLowerCase();
                // unread=1：只看未读（主框架「提醒中心」的新邮件列表，与后端 page(unread=1) 同口径）
                var wantUnread = ['1', 'true', 'yes', 'on']
                    .indexOf(String(params.unread === undefined ? '' : params.unread).trim().toLowerCase()) >= 0;
                var list = [];
                for (i = 0; i < msgRows.length; i++) {
                    one = msgRows[i];
                    if (parseInt(one.empId, 10) !== me) { continue; }   // 别人的邮件一律跳过
                    if (one.direction !== direction) { continue; }
                    if (wantUnread && one.seen) { continue; }
                    if (keyword && String(one.subject + ' ' + one.fromAddr + ' ' +
                        one.fromName + ' ' + one.toAddr).toLowerCase().indexOf(keyword) < 0) { continue; }
                    list.push(one);
                }
                list.sort(function (a, b) { return String(b.sentTime).localeCompare(String(a.sentTime)); });
                var pageNum = Math.max(1, parseInt(params.pageNum, 10) || 1);
                var pageSize = Math.min(Math.max(parseInt(params.pageSize, 10) || 20, 1), 100);
                var pages = Math.max(1, Math.ceil(list.length / pageSize));
                pageNum = Math.min(pageNum, pages);
                var slice = list.slice((pageNum - 1) * pageSize, pageNum * pageSize);
                var items = [];
                for (i = 0; i < slice.length; i++) {
                    var it = clone(slice[i]);
                    it.summaryFrom = it.fromName || it.fromAddr;
                    it.attachments = it.attachments || [];
                    items.push(it);
                }
                return { code: 0, message: 'ok', data: {
                    list: items, total: list.length, pageNum: pageNum, pageSize: pageSize,
                    pages: pages, folder: direction === 'out' ? 'sent' : 'inbox',
                    empId: me, unread: unreadOf(msgRows, me), counts: countsOf(msgRows, me)
                } };
            }
            /* ---- 详情（别人的邮件 id 一律 404，不泄露存在性） ---- */
            if (path === '/detail') {
                var target = null;
                for (i = 0; i < msgRows.length; i++) {
                    if (String(msgRows[i].id) === String(params.id) &&
                        parseInt(msgRows[i].empId, 10) === me) { target = msgRows[i]; break; }
                }
                if (!target) { return { code: 404, message: '邮件不存在或已被删除' }; }
                if (!(params.markRead === 0 || params.markRead === '0' || params.markRead === false) &&
                    !target.seen) {
                    target.seen = true;
                    writeEmpMails(msgRows);
                }
                var d = clone(target);
                d.directionText = d.direction === 'out' ? '发件' : '收件';
                d.attachments = mockAttachView(d.attachments);
                d.attachNeedFetch = !!(d.hasAttach && d.direction === 'in' && !d.attachments.length);
                d.unread = unreadOf(msgRows, me);
                return { code: 0, message: 'ok', data: d };
            }
            /* ---- 附件下载清单（别人的邮件 id 一律 404，不泄露存在性） ---- */
            if (path === '/attachments') {
                var et = null;
                for (i = 0; i < msgRows.length; i++) {
                    if (String(msgRows[i].id) === String(params.id) &&
                        parseInt(msgRows[i].empId, 10) === me) { et = msgRows[i]; break; }
                }
                if (!et) { return { code: 404, message: '邮件不存在或已被删除' }; }
                var doRefresh = params.refresh === 1 || params.refresh === '1' || params.refresh === true;
                if (doRefresh && et.direction === 'in') {
                    if (!et.attachments || !et.attachments.length) {
                        et.attachments = mockAttachDemoList();
                        et.hasAttach = true;
                        writeEmpMails(msgRows);
                    }
                    return { code: 0, message: 'ok', data: {
                        list: mockAttachView(et.attachments), refreshed: true, needFetch: false,
                        message: '已获取 ' + et.attachments.length + ' 个附件'
                    } };
                }
                return { code: 0, message: 'ok', data: {
                    list: mockAttachView(et.attachments), refreshed: false,
                    needFetch: !!(et.hasAttach && et.direction === 'in' &&
                        (!et.attachments || !et.attachments.length))
                } };
            }
            /* ---- 发件（发件人固定取本人配置，忽略前端 fromAddr） ---- */
            if (path === '/send') {
                function toList(raw) {
                    var text = String(raw || '').replace(/，/g, ',').replace(/；/g, ',');
                    var parts = text.split(/[,;\s]+/), out = [];
                    for (var pi = 0; pi < parts.length; pi++) {
                        var addr = parts[pi];
                        if (!addr) { continue; }
                        if (!mailIsEmail(addr)) { return { error: '收件人地址格式不正确：' + addr }; }
                        if (out.indexOf(addr) < 0) { out.push(addr); }
                    }
                    return { list: out };
                }
                var to = toList(params.to);
                if (to.error) { return { code: 500, message: to.error }; }
                var cc = toList(params.cc);
                if (cc.error) { return { code: 500, message: cc.error.replace('收件人', '抄送人') }; }
                if (!to.list.length) { return { code: 500, message: '请填写收件人' }; }
                var subject = String(params.subject || '').trim();
                if (!subject) { return { code: 500, message: '请填写邮件主题' }; }
                var body = String(params.body === undefined ? '' : params.body);
                var bodyHtml = String(params.bodyHtml === undefined ? '' : params.bodyHtml);
                if (!body.replace(/\s/g, '') && bodyHtml) { body = mockHtmlToText(bodyHtml); }
                if (!body.replace(/\s/g, '')) { return { code: 500, message: '请填写邮件正文' }; }
                var attach = [], rawAttach = params.attachments;
                if (typeof rawAttach === 'string') {
                    try { rawAttach = rawAttach ? JSON.parse(rawAttach) : []; } catch (e) { rawAttach = []; }
                }
                if (Object.prototype.toString.call(rawAttach) === '[object Array]') {
                    for (var ai = 0; ai < rawAttach.length; ai++) {
                        var ra = rawAttach[ai] || {};
                        var b64 = String(ra.data === undefined ? '' : ra.data);
                        var cut = b64.indexOf(';base64,');
                        if (cut >= 0) { b64 = b64.slice(cut + 8); }
                        var size = parseInt(ra.size, 10);
                        if (!(size > 0)) { size = Math.floor(b64.replace(/=+$/, '').length * 3 / 4); }
                        attach.push({
                            id: mockUuid(), name: String(ra.name || 'attachment'), size: size,
                            contentType: String(ra.type || ra.contentType || 'application/octet-stream'),
                            dataUrl: b64 ? mockAttachDataUrl(b64) : '', downloadable: !!b64
                        });
                    }
                }
                if (attach.length > 5) { return { code: 500, message: '最多只能添加 5 个附件' }; }
                var st = now();
                var item = {
                    id: mockUuid(), empId: me, direction: 'out', uid: mockUuid(),
                    messageId: '', fromAddr: box.email, fromName: box.displayName || box.email,
                    toAddr: to.list.join(', '), ccAddr: cc.list.join(', '), subject: subject,
                    sentTime: st, bodyText: body, bodyHtml: bodyHtml, hasAttach: attach.length > 0,
                    attachments: attach, seen: true, createTime: st
                };
                msgRows.push(item);
                writeEmpMails(msgRows);
                return { code: 0, message: '邮件已发送（离线演示）', data: {
                    id: item.id, to: to.list, cc: cc.list, subject: subject, sentTime: st,
                    attachments: attach, email: box.email, counts: countsOf(msgRows, me)
                } };
            }
            /* ---- 标记 / 删除（强制带 empId） ---- */
            if (path === '/mark' || path === '/delete') {
                var ids = params.ids || params.id;
                if (!ids) { return { code: 500, message: '请先选择邮件' }; }
                ids = Object.prototype.toString.call(ids) === '[object Array]'
                    ? ids : String(ids).split(/[,\s]+/);
                var hitCount = 0;
                if (path === '/mark') {
                    var seen = !(params.seen === 0 || params.seen === '0' || params.seen === false);
                    for (i = 0; i < msgRows.length; i++) {
                        if (parseInt(msgRows[i].empId, 10) !== me) { continue; }
                        for (var mj = 0; mj < ids.length; mj++) {
                            if (String(msgRows[i].id) === String(ids[mj])) {
                                msgRows[i].seen = seen; hitCount++; break;
                            }
                        }
                    }
                    writeEmpMails(msgRows);
                    return { code: 0, message: '操作成功', data: {
                        updated: hitCount, seen: seen, unread: unreadOf(msgRows, me) } };
                }
                var left = [], removed = 0;
                for (i = 0; i < msgRows.length; i++) {
                    var hit = false;
                    if (parseInt(msgRows[i].empId, 10) === me) {
                        for (var lj = 0; lj < ids.length; lj++) {
                            if (String(msgRows[i].id) === String(ids[lj])) { hit = true; break; }
                        }
                    }
                    if (hit) { removed++; } else { left.push(msgRows[i]); }
                }
                writeEmpMails(left);
                return { code: 0, message: '删除成功', data: { deleted: removed, ids: ids } };
            }
            return { code: 404, message: '接口不存在：/empmail' + path };
        }
        return { route: route, raw: readEmpMails, write: writeEmpMails,
            boxes: readEmpMailBoxes, writeBoxes: writeEmpMailBoxes };
    }

    /* ---------------- 数据中心 · 数据库连接（dbinfo）模拟服务 ----------------
       与后端同口径：连接信息含类型 / 主机端口 / 默认库 / 账号 / 密码（只进不出）/ 字符集 / 附加参数 / 启用否；
       扫描接口返回离线演示用的「实例 → 表 / 视图 → 字段」结构（真实后端连的是真的库）。 */
    var DBINFO_KEY = 'menu_admin_dbinfomgr_v1';
    var DBINFO_TYPES = [
        { value: 'mysql', label: 'MySQL', port: 3306, hasFile: false },
        { value: 'mariadb', label: 'MariaDB', port: 3306, hasFile: false },
        { value: 'postgresql', label: 'PostgreSQL', port: 5432, hasFile: false },
        { value: 'oracle', label: 'Oracle', port: 1521, hasFile: false },
        { value: 'sqlserver', label: 'SQL Server', port: 1433, hasFile: false },
        { value: 'sqlite', label: 'SQLite', port: 0, hasFile: true }
    ];
    function dbinfoType(type) {
        for (var i = 0; i < DBINFO_TYPES.length; i++) {
            if (DBINFO_TYPES[i].value === type) { return DBINFO_TYPES[i]; }
        }
        return DBINFO_TYPES[0];
    }
    function createDbInfoService() {
        var SEED = [
            {
                id: 'db-0000-4000-8000-000000000001', name: '九豆主库（MySQL）', dbType: 'mysql',
                host: '127.0.0.1', port: 3306, dbName: 'jiudou_main', username: 'jiudou',
                password: 'demo-pass', charset: 'utf8mb4', extraParams: '', enabled: true,
                ispub: true, createempinfosid: 1,
                lastScanTime: '', lastError: '', remark: '离线演示连接（不会真的连库）',
                createTime: '2026-11-01 09:00:00', updateTime: '2026-11-01 09:00:00'
            },
            {
                id: 'db-0000-4000-8000-000000000002', name: '报表库（SQLite）', dbType: 'sqlite',
                host: '', port: null, dbName: 'E:/data/jiudou_report.db', username: '',
                password: '', charset: '', extraParams: '', enabled: false,
                ispub: false, createempinfosid: 1,
                lastScanTime: '', lastError: '', remark: '文件型数据库，直接填路径',
                createTime: '2026-11-01 09:05:00', updateTime: '2026-11-01 09:05:00'
            }
        ];
        var MOCK_DBS = [
            { name: 'jiudou_main', tableCount: 5, system: false, current: true },
            { name: 'jiudou_report', tableCount: 3, system: false, current: false },
            { name: 'information_schema', tableCount: 79, system: true, current: false }
        ];
        var MOCK_TABLES = {
            'jiudou_main': [
                { name: 'empinfos', kind: 'table', rows: 6, comment: '员工信息表' },
                { name: 'useinfo', kind: 'table', rows: 6, comment: '用户信息表' },
                { name: 'dbinfomgr', kind: 'table', rows: 2, comment: '数据库连接对象' },
                { name: 'serviceemail', kind: 'table', rows: 1, comment: '服务信箱' },
                { name: 'v_emp_dept', kind: 'view', rows: 0, comment: '员工 + 部门视图' }
            ],
            'jiudou_report': [
                { name: 'rpt_sales', kind: 'table', rows: 1280, comment: '销售明细' },
                { name: 'rpt_stock', kind: 'table', rows: 320, comment: '库存快照' },
                { name: 'v_rpt_summary', kind: 'view', rows: 0, comment: '汇总视图' }
            ],
            'information_schema': [
                { name: 'TABLES', kind: 'view', rows: 0, comment: '' }
            ]
        };
        var MOCK_COLUMNS = {
            empinfos: [
                { name: 'id', dataType: 'bigint(20) unsigned', nullable: false, key: 'PRI', defaultValue: '', extra: 'auto_increment', comment: '主键ID' },
                { name: 'code', dataType: 'varchar(16)', nullable: false, key: 'UNI', defaultValue: '', extra: '', comment: '工号' },
                { name: 'nameCn', dataType: 'varchar(50)', nullable: false, key: 'MUL', defaultValue: '', extra: '', comment: '姓名' },
                { name: 'gender', dataType: 'tinyint(3) unsigned', nullable: false, key: '', defaultValue: '1', extra: '', comment: '性别：1-男，2-女' },
                { name: 'phone', dataType: 'varchar(20)', nullable: true, key: 'MUL', defaultValue: '', extra: '', comment: '手机号' },
                { name: 'email', dataType: 'varchar(120)', nullable: true, key: '', defaultValue: '', extra: '', comment: '邮箱' },
                { name: 'deptId', dataType: 'int(11)', nullable: false, key: 'MUL', defaultValue: '0', extra: '', comment: '所属部门' }
            ]
        };
        function read() {
            try {
                var raw = window.localStorage.getItem(DBINFO_KEY);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            var seed = clone(SEED);
            write(seed);
            return seed;
        }
        function write(list) {
            try { window.localStorage.setItem(DBINFO_KEY, JSON.stringify(list)); } catch (e) { }
        }
        function attach(one) {
            var out = clone(one);
            var meta = dbinfoType(String(out.dbType || 'mysql').toLowerCase());
            out.dbType = meta.value;
            out.typeLabel = meta.label;
            out.hasFile = meta.hasFile;
            out.hasPassword = !!out.password;
            out.passwordMask = out.password ? '******' : '';
            delete out.password;
            out.enabled = !!out.enabled;
            var port = out.port || (meta.hasFile ? '' : meta.port);
            out.port = port || null;
            out.portText = meta.hasFile ? '' : String(port || '');
            out.serverText = meta.hasFile ? String(out.dbName || '') : (out.host || '') + ':' + port;
            out.lastScanTime = out.lastScanTime || '';
            out.lastError = out.lastError || '';
            // 公用否：1-公用（默认）/ 0-私有；老数据没有这个字段，按公用算
            out.ispub = !(out.ispub === false || out.ispub === 0 || out.ispub === '0');
            out.ispubText = out.ispub ? '公用' : '私有';
            out.createempinfosid = parseInt(out.createempinfosid, 10) || 0;
            return out;
        }
        /* 当前登录员工的ID（离线演示也按真实登录态填创建人，与后端 createempinfosid 一致） */
        function mockEmpId() {
            try {
                var raw = window.localStorage ? window.localStorage.getItem('menu_admin_login_v1') : '';
                var sess = raw ? JSON.parse(raw) : null;
                var u = (sess && sess.user) || {};
                return parseInt(u.empId, 10) || 0;
            } catch (e) { return 0; }
        }
        function ispubOf(value) {
            return !(value === 0 || value === '0' || value === false);
        }
        function find(rows, id) {
            for (var i = 0; i < rows.length; i++) {
                if (String(rows[i].id) === String(id)) { return rows[i]; }
            }
            return null;
        }
        function route(method, path, params) {
            params = params || {};
            var rows = read();
            if (path === '/types') {
                return { code: 0, message: 'ok', data: { list: clone(DBINFO_TYPES) } };
            }
            if (path === '/list') {
                var keyword = String(params.keyword || '').toLowerCase();
                var dbType = String(params.dbType || '').toLowerCase();
                var enabled = params.enabled;
                /* 可见性（2026-11-06 用户需求）：只加载本用户创建的 + 其他用户标为公用的连接对象
                   （me=0 表示取不到登录态 → 不过滤，与后端一致） */
                var me = mockEmpId();
                var visible = function (row) {
                    if (me <= 0) { return true; }
                    return (parseInt(row.createempinfosid, 10) || 0) === me || ispubOf(row.ispub);
                };
                var list = [], i, one;
                for (i = 0; i < rows.length; i++) {
                    one = rows[i];
                    if (!visible(one)) { continue; }
                    if (dbType && String(one.dbType) !== dbType) { continue; }
                    if (enabled !== undefined && enabled !== null && String(enabled) !== '' &&
                        (String(one.enabled ? 1 : 0) !== String(enabled === true ? 1 : enabled))) { continue; }
                    if (keyword && String([one.name, one.host, one.dbName, one.username, one.remark]
                        .join(' ')).toLowerCase().indexOf(keyword) < 0) { continue; }
                    list.push(one);
                }
                list.sort(function (a, b) {
                    if (!!a.enabled !== !!b.enabled) { return a.enabled ? -1 : 1; }
                    return String(a.name).localeCompare(String(b.name));
                });
                var pageNum = Math.max(1, parseInt(params.pageNum, 10) || 1);
                var pageSize = Math.min(Math.max(parseInt(params.pageSize, 10) || 10, 1), 200);
                var pages = Math.max(1, Math.ceil(list.length / pageSize));
                pageNum = Math.min(pageNum, pages);
                var slice = list.slice((pageNum - 1) * pageSize, pageNum * pageSize);
                var items = [];
                for (i = 0; i < slice.length; i++) { items.push(attach(slice[i])); }
                return { code: 0, message: 'ok', data: {
                    list: items, total: list.length, pageNum: pageNum, pageSize: pageSize, pages: pages
                } };
            }
            if (path === '/detail') {
                var hit = find(rows, params.id);
                if (!hit) { return { code: 404, message: '数据库不存在或已被删除' }; }
                return { code: 0, message: 'ok', data: attach(hit) };
            }
            if (path === '/check') {
                var value = String(params.value || '');
                var dup = null;
                for (var ci = 0; ci < rows.length; ci++) {
                    if (String(rows[ci].name) === value && String(rows[ci].id) !== String(params.id || '')) {
                        dup = rows[ci];
                    }
                }
                return { code: 0, message: 'ok', data: { unique: !dup && !!value } };
            }
            if (path === '/add' || path === '/update') {
                var name = String(params.name || '').trim();
                if (!name) { return { code: 500, message: '连接名称不能为空' }; }
                var meta = dbinfoType(String(params.dbType || 'mysql').toLowerCase());
                var sameId = path === '/update' ? String(params.id || '') : '';
                for (var ui = 0; ui < rows.length; ui++) {
                    if (String(rows[ui].name) === name && String(rows[ui].id) !== sameId) {
                        return { code: 500, message: '连接名称【' + name + '】已存在，请换一个' };
                    }
                }
                if (!meta.hasFile && !String(params.host || '').trim()) {
                    return { code: 500, message: '主机地址不能为空' };
                }
                if (meta.hasFile && !String(params.dbName || '').trim()) {
                    return { code: 500, message: 'SQLite 请填写库文件路径（默认库 / 文件路径）' };
                }
                var t = now();
                if (path === '/add') {
                    var created = {
                        id: mockUuid(), name: name, dbType: meta.value,
                        host: meta.hasFile ? '' : String(params.host || '').trim(),
                        port: meta.hasFile ? null : (parseInt(params.port, 10) || meta.port),
                        dbName: String(params.dbName || '').trim(),
                        username: String(params.username || '').trim(),
                        password: String(params.password || ''),
                        charset: String(params.charset || '').trim(),
                        extraParams: String(params.extraParams || '').trim(),
                        enabled: !(params.enabled === 0 || params.enabled === '0' || params.enabled === false),
                        ispub: ispubOf(params.ispub),          // 公用否（默认公用）
                        createempinfosid: mockEmpId(),         // 创建人 = 当前登录员工（页面不展示）
                        lastScanTime: '', lastError: '',
                        remark: String(params.remark || '').trim(),
                        createTime: t, updateTime: t
                    };
                    rows.push(created);
                    write(rows);
                    return { code: 0, message: 'ok', data: attach(created) };
                }
                var target = find(rows, params.id);
                if (!target) { return { code: 404, message: '数据库不存在或已被删除' }; }
                target.name = name;
                target.dbType = meta.value;
                target.host = meta.hasFile ? '' : String(params.host || '').trim();
                target.port = meta.hasFile ? null : (parseInt(params.port, 10) || meta.port);
                target.dbName = String(params.dbName || '').trim();
                target.username = String(params.username || '').trim();
                if (String(params.password || '') !== '') { target.password = String(params.password); }
                target.charset = String(params.charset || '').trim();
                target.extraParams = String(params.extraParams || '').trim();
                if (params.enabled !== undefined) {
                    target.enabled = !(params.enabled === 0 || params.enabled === '0' || params.enabled === false);
                }
                if (params.ispub !== undefined) { target.ispub = ispubOf(params.ispub); }
                target.remark = String(params.remark || '').trim();
                target.lastError = '';
                target.updateTime = t;
                write(rows);
                return { code: 0, message: 'ok', data: attach(target) };
            }
            if (path === '/delete') {
                var del = find(rows, params.id);
                if (!del) { return { code: 404, message: '数据库不存在或已被删除' }; }
                var left = [];
                for (var di = 0; di < rows.length; di++) {
                    if (String(rows[di].id) !== String(params.id)) { left.push(rows[di]); }
                }
                write(left);
                return { code: 0, message: 'ok', data: attach(del) };
            }
            if (path === '/enabled') {
                var one2 = find(rows, params.id);
                if (!one2) { return { code: 404, message: '数据库不存在或已被删除' }; }
                one2.enabled = !(params.enabled === 0 || params.enabled === '0' || params.enabled === false);
                write(rows);
                var out2 = attach(one2);
                out2.message = (one2.enabled ? '连接「' + one2.name + '」已启用' : '连接「' + one2.name + '」已停用');
                return { code: 0, message: 'ok', data: out2 };
            }
            if (path === '/test') {
                var one3 = find(rows, params.id);
                if (!one3) { return { code: 404, message: '数据库不存在或已被删除' }; }
                one3.lastScanTime = now();
                one3.lastError = '';
                write(rows);
                var out3 = attach(one3);
                out3.ok = true;
                out3.message = '连接成功：' + out3.serverText + '（离线演示）';
                return { code: 0, message: 'ok', data: out3 };
            }
            if (path === '/scan') {
                var one4 = find(rows, params.id);
                if (!one4) { return { code: 404, message: '数据库不存在或已被删除' }; }
                one4.lastScanTime = now();
                one4.lastError = '';
                write(rows);
                return { code: 0, message: 'ok', data: {
                    connection: { id: one4.id, name: one4.name, dbType: one4.dbType,
                                  typeLabel: dbinfoType(one4.dbType).label },
                    databases: clone(MOCK_DBS), engine: one4.dbType,
                    server: attach(one4).serverText, scannedAt: one4.lastScanTime
                } };
            }
            if (path === '/tables') {
                var database = String(params.database || '');
                var tables = MOCK_TABLES[database] || [];
                var tableN = 0, viewN = 0;
                for (var ti = 0; ti < tables.length; ti++) {
                    if (tables[ti].kind === 'view') { viewN++; } else { tableN++; }
                }
                return { code: 0, message: 'ok', data: {
                    database: database, tables: clone(tables),
                    counts: { table: tableN, view: viewN }, total: tables.length
                } };
            }
            if (path === '/columns') {
                var table = String(params.table || '');
                var cols = MOCK_COLUMNS[table] || [
                    { name: 'id', dataType: 'bigint(20)', nullable: false, key: 'PRI', defaultValue: '', extra: 'auto_increment', comment: '主键' },
                    { name: 'name', dataType: 'varchar(100)', nullable: true, key: '', defaultValue: '', extra: '', comment: '' },
                    { name: 'createTime', dataType: 'datetime', nullable: false, key: '', defaultValue: 'CURRENT_TIMESTAMP', extra: '', comment: '创建时间' }
                ];
                return { code: 0, message: 'ok', data: {
                    database: String(params.database || ''), table: table,
                    columns: clone(cols), total: cols.length
                } };
            }
            /* SQL 工作台：离线模式按「只读校验 + 演示结果」返回，
               校验规则与后端 connector._check_sql 同口径（只放行查询语句、一次一条） */
            if (path === '/sqlrun') {
                var one5 = find(rows, params.id);
                if (!one5) { return { code: 404, message: '数据库不存在或已被删除' }; }
                var text = String(params.sql === undefined || params.sql === null ? '' : params.sql).trim();
                if (!text) { return { code: 500, message: '请输入要执行的 SQL' }; }
                var headMatch = /^(?:\s|--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/)*([A-Za-z_]+)/.exec(text);
                var head = headMatch ? headMatch[1].toLowerCase() : '';
                var HEADS = ['select', 'show', 'desc', 'describe', 'explain', 'pragma', 'with', 'values', 'table'];
                if (HEADS.indexOf(head) < 0) {
                    return { code: 500, message: '数据中心只允许执行查询语句（SELECT / SHOW / DESC / EXPLAIN / PRAGMA），'
                        + '写操作（' + (head ? head.toUpperCase() : '未知') + '）已被禁止' };
                }
                if (/\b(insert|update|delete|replace|merge|alter|drop|truncate|create|rename)\b/i.test(text)) {
                    return { code: 500, message: '语句里包含写操作关键字，数据中心只允许查询，已终止执行' };
                }
                if (/;[\s\S]*\S/.test(text.replace(/;\s*$/, ''))) {
                    return { code: 500, message: '一次只能执行一条 SQL，请只保留一条再执行' };
                }
                var maxRows = Math.min(Math.max(parseInt(params.maxRows, 10) || 200, 1), 2000);
                var cols5 = ['id', 'name', 'remark'];
                var fromMatch = /from\s+([A-Za-z0-9_.`"\[\]]+)/i.exec(text);
                if (fromMatch) {
                    var tName = fromMatch[1].replace(/[`"\[\]]/g, '').split('.').pop();
                    if (MOCK_COLUMNS[tName]) {
                        cols5 = [];
                        for (var ci5 = 0; ci5 < MOCK_COLUMNS[tName].length; ci5++) {
                            cols5.push(MOCK_COLUMNS[tName][ci5].name);
                        }
                    }
                }
                if (head === 'show' || head === 'desc' || head === 'describe') {
                    cols5 = ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'];
                }
                var demoRows = [], rowTotal = Math.min(3, maxRows);
                for (var ri5 = 0; ri5 < rowTotal; ri5++) {
                    var oneRow = [];
                    for (var cj5 = 0; cj5 < cols5.length; cj5++) {
                        oneRow.push(cols5[cj5] + '-' + (ri5 + 1));
                    }
                    demoRows.push(oneRow);
                }
                var colList = [];
                for (var ck5 = 0; ck5 < cols5.length; ck5++) {
                    colList.push({ name: cols5[ck5], index: ck5 });
                }
                return { code: 0, message: 'ok', data: {
                    statement: head.toUpperCase(), columns: colList, rows: demoRows,
                    rowCount: demoRows.length, affected: null, truncated: false, elapsed: 6,
                    database: String(params.database || one5.dbName || ''),
                    dbType: one5.dbType, executedAt: now(), maxRows: maxRows,
                    connection: { id: one5.id, name: one5.name, dbType: one5.dbType,
                                  typeLabel: dbinfoType(one5.dbType).label },
                    message: '执行成功，返回 ' + demoRows.length + ' 行（离线演示数据）'
                } };
            }
            /* 数据浏览：离线模式用 137 行演示数据（>100 行，能演示「滚到底加载下一页」），排序 / 过滤 / 分页与后端同口径 */
            if (path === '/rows') {
                var one6 = find(rows, params.id);
                if (!one6) { return { code: 404, message: '数据库不存在或已被删除' }; }
                var table6 = String(params.table || '');
                if (!table6) { return { code: 500, message: '请先在左侧点选（或双击）一张表 / 视图' }; }
                var cols6 = [], ci6;
                if (MOCK_COLUMNS[table6]) {
                    for (ci6 = 0; ci6 < MOCK_COLUMNS[table6].length; ci6++) {
                        cols6.push(MOCK_COLUMNS[table6][ci6].name);
                    }
                }
                if (!cols6.length) { cols6 = ['id', 'name', 'remark']; }
                var allRows6 = [], r6, c6, cn6;
                for (r6 = 1; r6 <= 137; r6++) {
                    var line6 = [];
                    for (c6 = 0; c6 < cols6.length; c6++) {
                        cn6 = cols6[c6];
                        if (c6 === 0 && /^(id|code)$/i.test(cn6)) { line6.push(r6); }
                        else if (/name/i.test(cn6)) { line6.push('演示名称-' + r6); }
                        else if (/enabled|status/i.test(cn6)) { line6.push(r6 % 2); }
                        else if (/time|date/i.test(cn6)) { line6.push('2026-11-0' + ((r6 % 9) + 1) + ' 09:00:00'); }
                        else if (/email/i.test(cn6)) { line6.push('demo' + r6 + '@jiudou.com'); }
                        else { line6.push(cn6 + '-' + r6); }
                    }
                    allRows6.push(line6);
                }
                var fl6 = params.filters;
                if (typeof fl6 === 'string') {
                    try { fl6 = fl6 ? JSON.parse(fl6) : []; } catch (e) { fl6 = []; }
                }
                if (Object.prototype.toString.call(fl6) === '[object Array]' && fl6.length) {
                    allRows6 = allRows6.filter(function (row) {
                        for (var fi = 0; fi < fl6.length; fi++) {
                            var f6 = fl6[fi] || {};
                            var idx6 = cols6.indexOf(String(f6.column || ''));
                            if (idx6 < 0) { return false; }
                            var cell6 = row[idx6];
                            var val6 = f6.value === undefined || f6.value === null ? '' : String(f6.value);
                            var op6 = String(f6.op || 'eq');
                            var cs6 = cell6 === null || cell6 === undefined ? '' : String(cell6);
                            var num6 = Number(cs6), vnum6 = Number(val6);
                            var isNum6 = cs6 !== '' && val6 !== '' && !isNaN(num6) && !isNaN(vnum6);
                            if (op6 === 'null') { if (cs6 !== '') { return false; } }
                            else if (op6 === 'notnull') { if (cs6 === '') { return false; } }
                            else if (op6 === 'contains') { if (cs6.indexOf(val6) < 0) { return false; } }
                            else if (op6 === 'starts') { if (cs6.indexOf(val6) !== 0) { return false; } }
                            else if (op6 === 'ends') { if (cs6.slice(-val6.length) !== val6) { return false; } }
                            else if (op6 === 'eq') { if (isNum6 ? num6 !== vnum6 : cs6 !== val6) { return false; } }
                            else if (op6 === 'ne') { if (isNum6 ? num6 === vnum6 : cs6 === val6) { return false; } }
                            else if (op6 === 'gt') { if (!(isNum6 ? num6 > vnum6 : cs6 > val6)) { return false; } }
                            else if (op6 === 'ge') { if (!(isNum6 ? num6 >= vnum6 : cs6 >= val6)) { return false; } }
                            else if (op6 === 'lt') { if (!(isNum6 ? num6 < vnum6 : cs6 < val6)) { return false; } }
                            else if (op6 === 'le') { if (!(isNum6 ? num6 <= vnum6 : cs6 <= val6)) { return false; } }
                        }
                        return true;
                    });
                }
                var ob6 = String(params.orderBy || '');
                if (ob6) {
                    var oi6 = cols6.indexOf(ob6);
                    var desc6 = String(params.orderDir || '').toLowerCase() === 'desc';
                    if (oi6 >= 0) {
                        allRows6.sort(function (a, b) {
                            var x = a[oi6], y = b[oi6];
                            var nx = Number(x), ny = Number(y);
                            var cmp;
                            if (x !== '' && y !== '' && !isNaN(nx) && !isNaN(ny)) { cmp = nx - ny; }
                            else { cmp = String(x).localeCompare(String(y)); }
                            return desc6 ? -cmp : cmp;
                        });
                    } else { ob6 = ''; }
                }
                var size6 = Math.min(Math.max(parseInt(params.pageSize, 10) || 100, 1), 500);
                var page6 = Math.max(1, parseInt(params.pageNum, 10) || 1);
                var pages6 = Math.max(1, Math.ceil(allRows6.length / size6));
                page6 = Math.min(page6, pages6);
                var slice6 = allRows6.slice((page6 - 1) * size6, page6 * size6);
                return { code: 0, message: 'ok', data: {
                    columns: cols6, rows: slice6, total: allRows6.length,
                    pageNum: page6, pageSize: size6, pages: pages6,
                    hasMore: page6 * size6 < allRows6.length,
                    orderBy: ob6,
                    orderDir: ob6 ? (String(params.orderDir || '').toLowerCase() === 'desc' ? 'desc' : 'asc') : '',
                    filters: fl6 || [], elapsed: 5,
                    database: String(params.database || one6.dbName || ''), table: table6,
                    dbType: one6.dbType,
                    connection: { id: one6.id, name: one6.name, dbType: one6.dbType,
                                  typeLabel: dbinfoType(one6.dbType).label }
                } };
            }
            return { code: 404, message: '接口不存在：/dbinfo' + path };
        }
        return { route: route, raw: read, write: write };
    }

    var serviceEmailSvc = createServiceEmailService();
    var dbInfoSvc = createDbInfoService();
    var mailSvc = createMailService(serviceEmailSvc);
    var empMailSvc = createEmpMailService();

    /* ---------------- 站内消息（msg）模拟服务 ----------------
       与后端 EmpMessageService 同口径：员工间互发、按 empId 强隔离（收件箱 = receiverId=我且未删，
       已发送 = senderId=我且未删）；发件人固定取本人，支持一对多；软删按角色。 */
    var EMP_MSG_KEY = 'menu_admin_empmsgs_v1';
    var EMP_MSG_DEMO_EMP = 3;

    function msgMe() { return mockLoginEmpId() || EMP_MSG_DEMO_EMP; }

    function readMsgs() {
        try {
            var raw = window.localStorage.getItem(EMP_MSG_KEY);
            if (raw) { return JSON.parse(raw); }
        } catch (e) { }
        var seed = [
            {
                id: 'emg-0000-4000-8000-000000000101', senderId: 1, senderName: '系统管理员',
                receiverId: 3, receiverName: '杨伟康', title: '欢迎使用九豆综合管理平台',
                content: '杨工您好，这是一条站内消息演示。站内消息只在平台内传递，不会发到邮箱。',
                sendTime: '2026-11-06 09:10:00', readStatus: 0,
                senderDeleted: 0, receiverDeleted: 0, createTime: '2026-11-06 09:10:00'
            },
            {
                id: 'emg-0000-4000-8000-000000000102', senderId: 2, senderName: '李明',
                receiverId: 3, receiverName: '杨伟康', title: '本周例会纪要',
                content: '本周例会定于周五下午两点，请准时参加，议题见附件议程。',
                sendTime: '2026-11-05 16:30:00', readStatus: 1,
                senderDeleted: 0, receiverDeleted: 0, createTime: '2026-11-05 16:30:00'
            },
            {
                id: 'emg-0000-4000-8000-000000000103', senderId: 3, senderName: '杨伟康',
                receiverId: 1, receiverName: '系统管理员', title: '服务器巡检报告',
                content: '今早的服务器巡检已完成，各项指标正常，无异常。',
                sendTime: '2026-11-05 10:00:00', readStatus: 1,
                senderDeleted: 0, receiverDeleted: 0, createTime: '2026-11-05 10:00:00'
            },
            {
                id: 'emg-0000-4000-8000-000000000104', senderId: 1, senderName: '系统管理员',
                receiverId: 9, receiverName: '王五', title: '【机密】仅特定员工可见',
                content: '这封消息只发给 empId=9 的王五，用来验证「各员只看与自己相关的消息」。',
                sendTime: '2026-11-04 11:00:00', readStatus: 0,
                senderDeleted: 0, receiverDeleted: 0, createTime: '2026-11-04 11:00:00'
            }
        ];
        writeMsgs(seed);
        return seed;
    }
    function writeMsgs(list) {
        try { window.localStorage.setItem(EMP_MSG_KEY, JSON.stringify(list)); } catch (e) { }
    }

    /* ---- 即时对话扩展：附件（图片 / 文件）与群组 ----
       · 附件：Mock 不落盘，url 直接用上传时的 dataURL（<img src> 与 <a download> 都能用）；
         放在进程内对象里（不写 localStorage，避免大图撑爆 5MB 配额），刷新即失效；
       · 群组：localStorage 存一个数组，每个群自带 members（含 lastReadSeq 阅读游标），
         与后端 empimgroups + empimgroupmembers 同口径；群未读按 seq 比较（不按时间，
         因为 Mock 的 sendTime 也是秒级，同秒会漏判）。 */
    var EMP_GROUP_KEY = 'menu_admin_empimgroups_v1';
    var EMP_EMOJI_KEY = 'menu_admin_empimemojis_v1';   // 表情包（图片表情，全站共享）
    var IM_FILE_MEM = {};

    function readGroups() {
        try {
            var raw = window.localStorage.getItem(EMP_GROUP_KEY);
            if (raw) { return JSON.parse(raw) || []; }
        } catch (e) { }
        var seed = [{
            id: 'img-0000-4000-8000-000000000001',
            groupName: '项目周会', ownerId: 1, ownerName: '系统管理员',
            avatarText: '项', enabled: 1,
            createTime: '2026-11-06 09:00:00', updateTime: '2026-11-06 09:00:00',
            members: [
                { empId: 1, empName: '系统管理员', role: 'owner', lastReadSeq: 0, joinTime: '2026-11-06 09:00:00' },
                { empId: 2, empName: '李明', role: 'member', lastReadSeq: 0, joinTime: '2026-11-06 09:00:00' },
                { empId: 3, empName: '杨伟康', role: 'member', lastReadSeq: 0, joinTime: '2026-11-06 09:00:00' }
            ]
        }];
        writeGroups(seed);
        return seed;
    }
    function writeGroups(list) {
        try { window.localStorage.setItem(EMP_GROUP_KEY, JSON.stringify(list)); } catch (e) { }
    }
    /** 消息序号（Mock 版自增）：群未读用它做游标，避免秒级时间戳同秒漏判 */
    function maxSeqOf(rows) {
        var m = 0;
        for (var i = 0; i < (rows || []).length; i++) {
            var s = parseInt(rows[i].seq, 10) || 0;
            if (s > m) { m = s; }
        }
        return m + 1;
    }

    function createEmpMessageService() {
        /** 员工 id → 姓名（发送时快照；与后端 _emp_name / _emp_names 同口径） */
        function empNameOf(empId) {
            try {
                var rows = empSvc.listRaw() || [];
                for (var i = 0; i < rows.length; i++) {
                    if (parseInt(rows[i].id, 10) === parseInt(empId, 10)) {
                        return rows[i].nameCn || ('员工' + empId);
                    }
                }
            } catch (e) { }
            return '员工' + empId;
        }
        function empIdsExisting() {
            var map = {};
            try {
                var rows = empSvc.listRaw() || [];
                for (var i = 0; i < rows.length; i++) { map[parseInt(rows[i].id, 10)] = true; }
            } catch (e) { }
            return map;
        }
        function unreadOf(rows, me) {
            var n = 0;
            for (var i = 0; i < rows.length; i++) {
                if (parseInt(rows[i].receiverId, 10) === me &&
                    !rows[i].receiverDeleted && !rows[i].readStatus) { n++; }
            }
            return n;
        }
        function countsOf(rows, me) {
            var sent = 0, inbox = 0;
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].senderDeleted && rows[i].receiverDeleted) { continue; }
                if (parseInt(rows[i].senderId, 10) === me && !rows[i].senderDeleted) { sent++; }
                if (parseInt(rows[i].receiverId, 10) === me && !rows[i].receiverDeleted) { inbox++; }
            }
            return { sent: sent, inbox: inbox };
        }
        function statusData(rows, me) {
            return { empId: me, unread: unreadOf(rows, me), counts: countsOf(rows, me), message: '' };
        }

        /* ---------- IM 专属：会话 / 联系人 ---------- */
        // 演示用「在线」员工集合（确定性，便于单测断言；真实后端由 WS 实时注册表决定）
        var MOCK_ONLINE = {};
        MOCK_ONLINE[1] = true; MOCK_ONLINE[2] = true; MOCK_ONLINE[4] = true;

        function convoWith(rows, me, peerId) {
            var arr = [];
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                var s = parseInt(r.senderId, 10), rc = parseInt(r.receiverId, 10);
                if (!((s === me && rc === peerId) || (s === peerId && rc === me))) { continue; }
                if (s === me && r.senderDeleted) { continue; }
                if (rc === me && r.receiverDeleted) { continue; }
                arr.push(r);
            }
            arr.sort(function (a, b) { return String(a.sendTime).localeCompare(String(b.sendTime)); });
            return arr;
        }
        function peerUnread(rows, me, peerId) {
            var n = 0;
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                if (parseInt(r.receiverId, 10) === me && parseInt(r.senderId, 10) === peerId &&
                    !r.receiverDeleted && !r.readStatus) { n++; }
            }
            return n;
        }
        function lastOf(convo) { return convo.length ? convo[convo.length - 1] : null; }
        function deptNameOfId(deptId) {
            try { return deptNameOf(deptId); } catch (e) { return ''; }
        }
        function buildContacts(rows, me) {
            var emps = (empSvc.listRaw && empSvc.listRaw()) || [];
            var list = [], totalUnread = 0, onlineCount = 0;
            for (var i = 0; i < emps.length; i++) {
                var e = emps[i];
                var id = parseInt(e.id, 10);
                if (id === me) { continue; }
                var convo = convoWith(rows, me, id);
                var last = lastOf(convo);
                var unread = peerUnread(rows, me, id);
                var online = !!MOCK_ONLINE[id];
                if (online) { onlineCount++; }
                totalUnread += unread;
                list.push({
                    empId: id,
                    name: e.nameCn || ('员工' + id),
                    deptName: deptNameOfId(e.deptId),
                    jobTitle: e.jobTitle || '',
                    avatarText: String(e.nameCn || '员').slice(0, 1),
                    online: online,
                    unread: unread,
                    lastContent: last ? String(last.content || '').replace(/\s+/g, ' ').slice(0, 40) : '',
                    lastMessage: last ? String(last.content || '').replace(/\s+/g, ' ').slice(0, 40) : '',
                    lastTime: last ? last.sendTime : '',
                    lastIsMe: last ? (parseInt(last.senderId, 10) === me) : false,
                    gender: e.gender
                });
            }
            list.sort(function (a, b) {
                if (a.online !== b.online) { return a.online ? -1 : 1; }     // 在线优先
                var ta = a.lastTime || '', tb = b.lastTime || '';
                if (ta !== tb) { return tb.localeCompare(ta); }              // 最近联系优先
                return a.name.localeCompare(b.name);
            });
            return { me: me, list: list, totalUnread: totalUnread, onlineCount: onlineCount, total: list.length };
        }
        /** @ 组员：只保留确实在群里的成员，返回 "12,30"（与后端 persist_send 同口径） */
        function mockAtIds(raw, members) {
            var out = [], seen = {}, list = [], i;
            var items = (typeof raw === 'string') ? raw.split(/[,\s]+/) : (raw || []);
            for (i = 0; i < (members || []).length; i++) { list.push(parseInt(members[i].empId, 10)); }
            for (i = 0; i < items.length; i++) {
                var n = parseInt(items[i], 10);
                if (!n || seen[n] || list.indexOf(n) < 0) { continue; }
                seen[n] = 1;
                out.push(n);
            }
            return out.join(',');
        }

        function normalizeMsg(r, me) {
            var isMe = parseInt(r.senderId, 10) === me;
            var aid = String(r.attachId || '');
            return {
                id: r.id,
                senderId: parseInt(r.senderId, 10),
                senderName: r.senderName || '',
                receiverId: parseInt(r.receiverId, 10),
                receiverName: r.receiverName || '',
                content: r.content || '',
                contentHtml: r.contentHtml || '',
                atEmpIds: r.atEmpIds || '',
                title: r.title || '',
                sendTime: r.sendTime || r.createTime || '',
                msgType: r.msgType || 'text',
                attachId: aid,
                attach: aid ? attachOf(aid) : null,
                groupId: r.groupId || '',
                isMe: isMe,
                read: isMe ? 1 : (parseInt(r.readStatus, 10) || 0),
                deleted: isMe ? (r.senderDeleted ? 1 : 0) : (r.receiverDeleted ? 1 : 0)
            };
        }
        /** Mock 附件元数据（dataURL 存在进程内映射里；找不到时返回 null，气泡降级成文字） */
        function attachOf(fileId) {
            var f = IM_FILE_MEM[String(fileId || '')];
            if (!f) { return null; }
            return {
                fileId: f.fileId, name: f.fileName, size: f.fileSize, mimeType: f.mimeType,
                ext: f.ext, kind: f.kind, width: f.width, height: f.height,
                url: f.url, sendTime: f.createTime
            };
        }
        /* ---- 表情包（Mock）：只存 fileId 引用，图片本体在 IM_FILE_MEM ---- */
        function readEmojis() {
            try {
                var raw = window.localStorage.getItem(EMP_EMOJI_KEY);
                if (!raw) { return []; }
                var list = JSON.parse(raw);
                return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
            } catch (e) { return []; }
        }
        function writeEmojis(list) {
            try { window.localStorage.setItem(EMP_EMOJI_KEY, JSON.stringify(list)); } catch (e) { }
        }
        function emojiView(one, me) {
            var att = attachOf(one.fileId) || {};
            return {
                id: one.id, fileId: one.fileId,
                name: one.name || att.name || '表情',
                url: att.url || one.url || '',
                width: att.width || one.width || 0,
                height: att.height || one.height || 0,
                uploaderId: parseInt(one.empId, 10) || 0,
                uploaderName: one.empName || '',
                mine: (parseInt(one.empId, 10) || 0) === me,
                createTime: one.createTime || ''
            };
        }

        function peerInfoOf(peerId) {
            var emps = (empSvc.listRaw && empSvc.listRaw()) || [];
            for (var i = 0; i < emps.length; i++) {
                if (parseInt(emps[i].id, 10) === peerId) {
                    return {
                        empId: peerId,
                        name: emps[i].nameCn || ('员工' + peerId),
                        deptName: deptNameOfId(emps[i].deptId),
                        jobTitle: emps[i].jobTitle || '',
                        avatarText: String(emps[i].nameCn || '员').slice(0, 1),
                        online: !!MOCK_ONLINE[peerId]
                    };
                }
            }
            return { empId: peerId, name: ('员工' + peerId), deptName: '', jobTitle: '', avatarText: '员', online: false };
        }

        /* ---------- 群组（Mock，与后端 group_* 同口径） ---------- */
        function groupUnread(g, me) {
            if (!g) { return 0; }
            var mem = null;
            for (var i = 0; i < (g.members || []).length; i++) {
                if (parseInt(g.members[i].empId, 10) === me) { mem = g.members[i]; break; }
            }
            if (!mem) { return 0; }
            var cur = parseInt(mem.lastReadSeq, 10) || 0;
            var rows = readMsgs(), n = 0;
            for (var j = 0; j < rows.length; j++) {
                if (String(rows[j].groupId || '') !== String(g.id)) { continue; }
                if (parseInt(rows[j].senderId, 10) === me) { continue; }
                if ((parseInt(rows[j].seq, 10) || 0) > cur) { n++; }
            }
            return n;
        }
        function touchGroupRead(g, me) {
            if (!g) { return; }
            var top = 0, rows = readMsgs();
            for (var i = 0; i < rows.length; i++) {
                if (String(rows[i].groupId || '') !== String(g.id)) { continue; }
                var s = parseInt(rows[i].seq, 10) || 0;
                if (s > top) { top = s; }
            }
            for (var k = 0; k < (g.members || []).length; k++) {
                if (parseInt(g.members[k].empId, 10) === me) {
                    g.members[k].lastReadSeq = top;
                    g.members[k].lastReadTime = now();
                }
            }
        }
        function myGroups(me) {
            var all = readGroups(), out = [];
            for (var i = 0; i < all.length; i++) {
                if (!parseInt(all[i].enabled === undefined ? 1 : all[i].enabled, 10)) { continue; }
                for (var j = 0; j < (all[i].members || []).length; j++) {
                    if (parseInt(all[i].members[j].empId, 10) === me) {
                        out.push({ g: all[i], mem: all[i].members[j] });
                        break;
                    }
                }
            }
            return out;
        }
        function groupView(g, me) {
            var members = [];
            for (var i = 0; i < (g.members || []).length; i++) {
                var m = g.members[i];
                members.push({
                    empId: parseInt(m.empId, 10), name: m.empName || ('员工' + m.empId),
                    role: m.role || 'member', isOwner: (m.role === 'owner'),
                    joinTime: m.joinTime || '', online: !!MOCK_ONLINE[m.empId]
                });
            }
            return {
                groupId: g.id, isGroup: true, name: g.groupName, groupName: g.groupName,
                ownerId: parseInt(g.ownerId, 10), ownerName: g.ownerName || '',
                avatarText: g.avatarText || String(g.groupName || '群').slice(0, 1),
                memberCount: members.length,
                isOwner: parseInt(g.ownerId, 10) === me,
                members: members, unread: groupUnread(g, me)
            };
        }
        function groupLast(g) {
            var rows = readMsgs(), last = null;
            for (var i = 0; i < rows.length; i++) {
                if (String(rows[i].groupId || '') !== String(g.id)) { continue; }
                if (!last || String(rows[i].sendTime) >= String(last.sendTime)) { last = rows[i]; }
            }
            return last;
        }
        function findGroup(gid) {
            var all = readGroups();
            for (var i = 0; i < all.length; i++) { if (all[i].id === String(gid || '')) { return all[i]; } }
            return null;
        }

        function route(method, path, params) {
            params = params || {};
            var me = msgMe();
            var rows = readMsgs();

            /* ---- 状态（页面初始化） ---- */
            if (path === '/status') {
                return { code: 0, message: 'ok', data: statusData(rows, me) };
            }
            /* ---- 列表（收件箱 / 已发送，强制带 empId） ---- */
            if (path === '/list') {
                var folder = String(params.folder || 'inbox').toLowerCase();
                var isSent = (folder === 'sent' || folder === 'out' || folder === 'outbox');
                var keyword = String(params.keyword || '').toLowerCase();
                var list = [];
                for (var i = 0; i < rows.length; i++) {
                    var one = rows[i];
                    if (isSent) {
                        if (parseInt(one.senderId, 10) !== me || one.senderDeleted) { continue; }
                    } else {
                        if (parseInt(one.receiverId, 10) !== me || one.receiverDeleted) { continue; }
                    }
                    if (keyword &&
                        String(one.title + ' ' + (one.content || '')).toLowerCase().indexOf(keyword) < 0) {
                        continue;
                    }
                    list.push(one);
                }
                list.sort(function (a, b) { return String(b.sendTime).localeCompare(String(a.sendTime)); });
                var pageNum = Math.max(1, parseInt(params.pageNum, 10) || 1);
                var pageSize = Math.min(Math.max(parseInt(params.pageSize, 10) || 20, 1), 100);
                var pages = Math.max(1, Math.ceil(list.length / pageSize));
                pageNum = Math.min(pageNum, pages);
                var slice = list.slice((pageNum - 1) * pageSize, pageNum * pageSize);
                var items = [];
                for (var j = 0; j < slice.length; j++) {
                    var it = clone(slice[j]);
                    it.isInbox = !isSent;
                    it.readStatus = parseInt(it.readStatus, 10) || 0;
                    it.unread = !!(it.isInbox && it.readStatus === 0);
                    if (isSent) { it.peerId = parseInt(it.receiverId, 10); it.peerName = it.receiverName || ''; }
                    else { it.peerId = parseInt(it.senderId, 10); it.peerName = it.senderName || ''; }
                    delete it.content;          // 列表不返回正文
                    items.push(it);
                }
                return { code: 0, message: 'ok', data: {
                    list: items, total: list.length, pageNum: pageNum, pageSize: pageSize,
                    pages: pages, folder: isSent ? 'sent' : 'inbox',
                    empId: me, unread: unreadOf(rows, me), counts: countsOf(rows, me)
                } };
            }
            /* ---- 详情（必须对本人生效，否则查不到） ---- */
            if (path === '/detail') {
                var target = null;
                for (var d = 0; d < rows.length; d++) {
                    var r = rows[d];
                    if (String(r.id) !== String(params.id)) { continue; }
                    var iAmReceiver = parseInt(r.receiverId, 10) === me && !r.receiverDeleted;
                    var iAmSender = parseInt(r.senderId, 10) === me && !r.senderDeleted;
                    if (iAmReceiver || iAmSender) { target = r; break; }
                }
                if (!target) { return { code: 404, message: '消息不存在或已被删除' }; }
                var markRead = !(params.markRead === 0 || params.markRead === '0' ||
                    params.markRead === false);
                if (markRead && parseInt(target.receiverId, 10) === me && !target.readStatus) {
                    target.readStatus = 1;
                    writeMsgs(rows);
                }
                var dd = clone(target);
                dd.isInbox = parseInt(target.receiverId, 10) === me;
                dd.readStatus = parseInt(dd.readStatus, 10) || 0;
                dd.unread = !!(dd.isInbox && dd.readStatus === 0);
                dd.content = dd.content || '';
                dd.senderNameText = dd.senderName || '';
                dd.receiverNameText = dd.receiverName || '';
                dd.unread = unreadOf(rows, me);
                return { code: 0, message: 'ok', data: dd };
            }
            /* ---- 发送（发件人固定取本人，支持一对多） ---- */
            if (path === '/send') {
                var msgType = String(params.msgType || 'text').toLowerCase();
                if (['text', 'image', 'file', 'sticker', 'audio'].indexOf(msgType) < 0) { msgType = 'text'; }
                var attachId = String(params.attachId || '');
                var content0 = String(params.content === undefined ? '' : params.content);
                /* 富文本正文（编辑器产出的 HTML）与 @ 到的组员（atEmpIds="12,30"） */
                var contentHtml0 = String(params.contentHtml === undefined ? '' : params.contentHtml);
                /* ---- 群消息：groupId 优先；全群共享一条记录（receiverId=0） ---- */
                var gidSend = String(params.groupId || '').trim();
                if (gidSend) {
                    var sg = findGroup(gidSend);
                    if (!sg || !parseInt(sg.enabled === undefined ? 1 : sg.enabled, 10)) {
                        return { code: 404, message: '群不存在或已解散' };
                    }
                    var inGroup = false;
                    for (var sgj = 0; sgj < (sg.members || []).length; sgj++) {
                        if (parseInt(sg.members[sgj].empId, 10) === me) { inGroup = true; break; }
                    }
                    if (!inGroup) { return { code: 403, message: '你不是该群成员' }; }
                    var gContent = content0;
                    if (!gContent.replace(/\s/g, '')) {
                        if (!attachId) { return { code: 500, message: '请填写消息内容' }; }
                        gContent = msgType === 'image' ? '[图片]' : (msgType === 'sticker' ? '[表情]' : (msgType === 'audio' ? '[语音]' : '[文件]'));
                    }
                    var gst = now(), gseq = maxSeqOf(rows);
                    var gAt = mockAtIds(params.atEmpIds, sg.members);
                    var gItem = {
                        id: mockUuid(), seq: gseq, senderId: me, senderName: empNameOf(me),
                        receiverId: 0, receiverName: sg.groupName || '',
                        title: String(params.title || '').trim(), content: gContent,
                        contentHtml: contentHtml0, atEmpIds: gAt,
                        msgType: msgType, attachId: attachId, groupId: sg.id, sendTime: gst,
                        readStatus: 0, senderDeleted: 0, receiverDeleted: 0, createTime: gst
                    };
                    rows.push(gItem);
                    writeMsgs(rows);
                    touchGroupRead(sg, me);
                    writeGroups(readGroups().map(function (x) { return x.id === sg.id ? sg : x; }));
                    return { code: 0, message: '发送成功', data: {
                        ids: [gItem.id], count: 1, title: gItem.title, sentTime: gst,
                        groupId: sg.id, msgType: msgType, attachId: attachId,
                        contentHtml: contentHtml0, atEmpIds: gAt,
                        attach: attachId ? attachOf(attachId) : null,
                        counts: countsOf(rows, me), unread: unreadOf(rows, me)
                    } };
                }
                var raw = params.receiverIds;
                if (raw === undefined || raw === null) { raw = params.receiverId; }
                if (raw === undefined || raw === null) { raw = params.receiver; }
                if (raw === undefined || raw === null ||
                    (typeof raw === 'string' && !raw.trim())) {
                    return { code: 500, message: '请选择收件人' };
                }
                var arr = (typeof raw === 'string') ? raw.split(/[,\s]+/) : raw;
                var ids = [], seenMap = {}, exists = empIdsExisting();
                for (var ai = 0; ai < arr.length; ai++) {
                    var x = String(arr[ai]).trim();
                    if (!x) { continue; }
                    var n;
                    try { n = parseInt(x, 10); } catch (e) { return { code: 500, message: '收件人 ID 不合法：' + x }; }
                    if (isNaN(n)) { return { code: 500, message: '收件人 ID 不合法：' + x }; }
                    if (!(n in seenMap)) { seenMap[n] = true; ids.push(n); }
                }
                if (!ids.length) { return { code: 500, message: '请选择收件人' }; }
                for (var mi = 0; mi < ids.length; mi++) {
                    if (!exists[ids[mi]]) {
                        return { code: 500, message: '部分收件人不存在（empId=' + ids[mi] + '），请重新选择' };
                    }
                }
                var title = String(params.title || '').trim();
                // IM 单聊消息可无标题（标题仅用于「系统通知 / 站内信」归档场景）
                var content = content0;
                if (!content.replace(/\s/g, '')) {
                    if (!attachId) { return { code: 500, message: '请填写消息内容' }; }
                    content = msgType === 'image' ? '[图片]' : (msgType === 'sticker' ? '[表情]' : (msgType === 'audio' ? '[语音]' : '[文件]'));
                }
                var senderName = empNameOf(me);
                var st = now();
                var created = [];
                for (var ri = 0; ri < ids.length; ri++) {
                    var item = {
                        id: mockUuid(), seq: maxSeqOf(rows) + ri, senderId: me, senderName: senderName,
                        receiverId: ids[ri], receiverName: empNameOf(ids[ri]),
                        title: title, content: content, contentHtml: contentHtml0, sendTime: st,
                        msgType: msgType, attachId: attachId, groupId: '',
                        readStatus: 0, senderDeleted: 0, receiverDeleted: 0, createTime: st
                    };
                    rows.push(item);
                    created.push(item.id);
                }
                writeMsgs(rows);
                return { code: 0, message: '发送成功', data: {
                    ids: created, count: created.length, title: title, sentTime: st,
                    counts: countsOf(rows, me), unread: unreadOf(rows, me)
                } };
            }
            /* ---- 标记已读（仅收件人本人） ---- */
            if (path === '/mark') {
                var mids = params.ids || params.id;
                if (!mids) { return { code: 500, message: '请先选择消息' }; }
                mids = Object.prototype.toString.call(mids) === '[object Array]'
                    ? mids : String(mids).split(/[,\s]+/);
                var read = !(params.read === 0 || params.read === '0' || params.read === false);
                var hit = 0;
                for (var k = 0; k < rows.length; k++) {
                    if (parseInt(rows[k].receiverId, 10) !== me) { continue; }
                    for (var kj = 0; kj < mids.length; kj++) {
                        if (String(rows[k].id) === String(mids[kj])) {
                            rows[k].readStatus = read ? 1 : 0; hit++; break;
                        }
                    }
                }
                writeMsgs(rows);
                return { code: 0, message: '操作成功', data: {
                    updated: hit, read: read, unread: unreadOf(rows, me) } };
            }
            /* ---- 删除（按当前员工角色软删；双方都删才移除） ---- */
            if (path === '/delete') {
                var dids = params.ids || params.id;
                if (!dids) { return { code: 500, message: '请先选择消息' }; }
                dids = Object.prototype.toString.call(dids) === '[object Array]'
                    ? dids : String(dids).split(/[,\s]+/);
                for (var p = 0; p < rows.length; p++) {
                    var matched = false;
                    for (var pj = 0; pj < dids.length; pj++) {
                        if (String(rows[p].id) === String(dids[pj])) { matched = true; break; }
                    }
                    if (!matched) { continue; }
                    if (parseInt(rows[p].receiverId, 10) === me) { rows[p].receiverDeleted = 1; }
                    if (parseInt(rows[p].senderId, 10) === me) { rows[p].senderDeleted = 1; }
                }
                var left = [];
                for (var q = 0; q < rows.length; q++) {
                    if (rows[q].senderDeleted && rows[q].receiverDeleted) { continue; }
                    left.push(rows[q]);
                }
                writeMsgs(left);
                return { code: 0, message: '删除成功', data: {
                    deleted: dids.length, ids: dids, unread: unreadOf(left, me),
                    counts: countsOf(left, me) } };
            }
            /* ---- IM：联系人 + 在线态 + 未读 + 最近消息 ---- */
            if (path === '/contacts') {
                return { code: 0, message: 'ok', data: buildContacts(rows, me) };
            }
            /* ---- IM：与某人的完整会话（按时间升序），打开即标记已读 ---- */
            if (path === '/history') {
                var peerId = parseInt(params.peerId, 10);
                if (!peerId) { return { code: 500, message: '缺少会话对象' }; }
                var convo = convoWith(rows, me, peerId);
                var before = peerUnread(rows, me, peerId);
                var marked = 0;
                for (var c = 0; c < rows.length; c++) {
                    if (parseInt(rows[c].receiverId, 10) === me &&
                        parseInt(rows[c].senderId, 10) === peerId && !rows[c].readStatus) {
                        rows[c].readStatus = 1; marked++;
                    }
                }
                if (marked) { writeMsgs(rows); }
                var out = [];
                for (var o = 0; o < convo.length; o++) { out.push(normalizeMsg(convo[o], me)); }
                return { code: 0, message: 'ok', data: {
                    list: out,
                    peer: peerInfoOf(peerId),
                    unreadDelta: before,
                    unread: peerUnread(rows, me, peerId),
                    totalUnread: unreadOf(rows, me)
                } };
            }
            /* ---- IM：已读回执（把某人发来的全部未读标记为已读） ---- */
            if (path === '/markpeer') {
                var pid = parseInt(params.peerId, 10);
                if (!pid) { return { code: 500, message: '缺少会话对象' }; }
                var upd = 0;
                for (var m2 = 0; m2 < rows.length; m2++) {
                    if (parseInt(rows[m2].receiverId, 10) === me &&
                        parseInt(rows[m2].senderId, 10) === pid && !rows[m2].readStatus) {
                        rows[m2].readStatus = 1; upd++;
                    }
                }
                if (upd) { writeMsgs(rows); }
                return { code: 0, message: 'ok', data: {
                    updated: upd, peerId: pid,
                    unread: peerUnread(rows, me, pid),
                    totalUnread: unreadOf(rows, me)
                } };
            }
            /* ---- 附件上传（base64 → 进程内映射，返回可直接发送的 fileId） ---- */
            if (path === '/upload') {
                var fName = String(params.fileName || '');
                var fData = String(params.data || '');
                if (!fName) { return { code: 500, message: '文件名不能为空，请重新选择文件' }; }
                if (!fData) { return { code: 500, message: '请选择要上传的文件' }; }
                var fExt = (fName.split('.').pop() || '').toLowerCase();
                var fKind = String(params.kind || '');
                if (fKind !== 'image' && fKind !== 'file') {
                    fKind = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].indexOf(fExt) >= 0 ? 'image' : 'file';
                }
                var fId = mockUuid();
                IM_FILE_MEM[fId] = {
                    fileId: fId, fileName: fName, fileSize: fData.length,
                    mimeType: params.mimeType || ('image/' + (fExt === 'jpg' ? 'jpeg' : (fExt || 'png'))),
                    ext: fExt, kind: fKind,
                    width: parseInt(params.width, 10) || 0,
                    height: parseInt(params.height, 10) || 0,
                    url: fData, createTime: now()
                };
                var fm = IM_FILE_MEM[fId];
                return { code: 0, message: '上传成功', data: {
                    fileId: fId, id: fId, kind: fKind, name: fName, fileName: fName,
                    size: fm.fileSize, fileSize: fm.fileSize, ext: fExt, mimeType: fm.mimeType,
                    width: fm.width, height: fm.height, url: fData, uploaderId: me
                } };
            }
            /* ---- 表情包：列表 / 添加 / 删除 ---- */
            if (path === '/emojis') {
                var eList = [], eRaw = readEmojis();
                for (var ei = 0; ei < eRaw.length; ei++) {
                    if (eRaw[ei].enabled === 0) { continue; }
                    var ev = emojiView(eRaw[ei], me);
                    if (!ev.url) { continue; }
                    eList.push(ev);
                }
                eList.sort(function (a, b) {
                    return (parseInt(a.sortNo, 10) || 0) - (parseInt(b.sortNo, 10) || 0);
                });
                return { code: 0, message: 'ok', data: { me: me, list: eList, total: eList.length } };
            }
            if (path === '/emojiadd') {
                var efId = String(params.fileId || '');
                if (!efId) { return { code: 500, message: '请先上传表情图片' }; }
                var efAtt = attachOf(efId);
                if (!efAtt) { return { code: 500, message: '附件不存在，请重新上传' }; }
                if (String(efAtt.mimeType || '').indexOf('image/') !== 0) {
                    return { code: 500, message: '表情包只支持图片' };
                }
                var eOld = readEmojis();
                if (eOld.length >= 120) { return { code: 500, message: '表情包最多 120 个' }; }
                for (var ej = 0; ej < eOld.length; ej++) {
                    if (eOld[ej].fileId === efId) { return { code: 500, message: '这个表情包已经添加过了' }; }
                }
                var eNew = {
                    id: mockUuid(), empId: me, empName: empNameOf(me),
                    fileId: efId, name: String(params.name || efAtt.name || '表情').slice(0, 100),
                    sortNo: eOld.length, enabled: 1, createTime: now()
                };
                eOld.push(eNew);
                writeEmojis(eOld);
                return { code: 0, message: '表情包已添加',
                         data: $.extend(emojiView(eNew, me), { message: '表情包已添加' }) };
            }
            if (path === '/emojidel') {
                var eDelId = String(params.id || '');
                var eAll = readEmojis(), eHit = null, eKeep = [];
                for (var ek = 0; ek < eAll.length; ek++) {
                    if (String(eAll[ek].id) === eDelId) { eHit = eAll[ek]; }
                    else { eKeep.push(eAll[ek]); }
                }
                if (!eHit) { return { code: 404, message: '表情包不存在' }; }
                if ((parseInt(eHit.empId, 10) || 0) !== me) {
                    return { code: 403, message: '只能删除自己添加的表情包' };
                }
                writeEmojis(eKeep);
                return { code: 0, message: '表情包已删除', data: { id: eDelId, deleted: true, message: '表情包已删除' } };
            }
            /* ---- 我加入的群（含未读 / 最近一条） ---- */
            if (path === '/groups') {
                var mineG = myGroups(me), gList = [], gTotal = 0;
                for (var gi = 0; gi < mineG.length; gi++) {
                    var gg = mineG[gi].g, gmem = mineG[gi].mem;
                    var gUn = groupUnread(gg, me);
                    gTotal += gUn;
                    var gLast = groupLast(gg) || {};
                    gList.push({
                        groupId: gg.id, isGroup: true, name: gg.groupName, groupName: gg.groupName,
                        ownerId: parseInt(gg.ownerId, 10), ownerName: gg.ownerName || '',
                        avatarText: gg.avatarText || String(gg.groupName || '群').slice(0, 1),
                        role: gmem.role || 'member', isOwner: (gmem.role === 'owner'),
                        memberCount: (gg.members || []).length, unread: gUn,
                        lastContent: String(gLast.content || '').slice(0, 120),
                        lastTime: gLast.sendTime || '',
                        lastSenderId: parseInt(gLast.senderId, 10) || 0,
                        lastSenderName: gLast.senderName || '',
                        lastFromMe: parseInt(gLast.senderId, 10) === me
                    });
                }
                gList.sort(function (a, b) { return String(b.lastTime).localeCompare(String(a.lastTime)); });
                return { code: 0, message: 'ok', data: { me: me, list: gList, unread: gTotal } };
            }
            /* ---- 建群 ---- */
            if (path === '/groupadd') {
                var rawG = params.memberIds;
                if (rawG === undefined || rawG === null) { rawG = params.empIds; }
                if (rawG === undefined || rawG === null) { rawG = params.members; }
                var arrG = Object.prototype.toString.call(rawG) === '[object Array]'
                    ? rawG : String(rawG === undefined || rawG === null ? '' : rawG).split(/[,\s]+/);
                var idsG = [], seenG = {}, existsG = empIdsExisting();
                for (var ag = 0; ag < arrG.length; ag++) {
                    var ng2 = parseInt(arrG[ag], 10);
                    if (!ng2 || ng2 === me || seenG[ng2]) { continue; }
                    if (!existsG[ng2]) {
                        return { code: 500, message: '部分成员不存在（empId=' + ng2 + '），请重新选择' };
                    }
                    seenG[ng2] = true;
                    idsG.push(ng2);
                }
                if (!idsG.length) { return { code: 500, message: '请至少选择一位群成员（不能只有自己）' }; }
                var meNameG = empNameOf(me);
                var gName2 = String(params.groupName || '').trim().slice(0, 100);
                if (!gName2) {
                    var parts = [meNameG];
                    for (var pg = 0; pg < Math.min(2, idsG.length); pg++) { parts.push(empNameOf(idsG[pg])); }
                    gName2 = parts.join('、').slice(0, 100);
                }
                var gNow = now();
                var newG = {
                    id: mockUuid(), groupName: gName2, ownerId: me, ownerName: meNameG,
                    avatarText: gName2.slice(0, 1), enabled: 1,
                    createTime: gNow, updateTime: gNow,
                    members: [{ empId: me, empName: meNameG, role: 'owner', lastReadSeq: 0, joinTime: gNow }]
                };
                for (var mg = 0; mg < idsG.length; mg++) {
                    newG.members.push({
                        empId: idsG[mg], empName: empNameOf(idsG[mg]),
                        role: 'member', lastReadSeq: 0, joinTime: gNow
                    });
                }
                var allG2 = readGroups();
                allG2.push(newG);
                writeGroups(allG2);
                return { code: 0, message: '群「' + gName2 + '」创建成功', data: {
                    groupId: newG.id, name: gName2, memberCount: newG.members.length,
                    ownerId: me, message: '群「' + gName2 + '」创建成功',
                    group: groupView(newG, me)
                } };
            }
            /* ---- 群资料 + 成员 ---- */
            if (path === '/groupdetail') {
                var gd = findGroup(params.groupId);
                if (!gd || !parseInt(gd.enabled === undefined ? 1 : gd.enabled, 10)) {
                    return { code: 404, message: '群不存在或已解散' };
                }
                var gdMem = null;
                for (var dj = 0; dj < (gd.members || []).length; dj++) {
                    if (parseInt(gd.members[dj].empId, 10) === me) { gdMem = gd.members[dj]; break; }
                }
                if (!gdMem) { return { code: 403, message: '你不是该群成员' }; }
                var gdView = groupView(gd, me);
                gdView.me = me;
                return { code: 0, message: 'ok', data: gdView };
            }
            /* ---- 群消息历史（打开即已读） ---- */
            if (path === '/grouphistory') {
                var gh = findGroup(params.groupId);
                if (!gh || !parseInt(gh.enabled === undefined ? 1 : gh.enabled, 10)) {
                    return { code: 404, message: '群不存在或已解散' };
                }
                var ghMem = false;
                for (var hj = 0; hj < (gh.members || []).length; hj++) {
                    if (parseInt(gh.members[hj].empId, 10) === me) { ghMem = true; break; }
                }
                if (!ghMem) { return { code: 403, message: '你不是该群成员' }; }
                var gRows = [], gAllRows = readMsgs();
                for (var hr = 0; hr < gAllRows.length; hr++) {
                    if (String(gAllRows[hr].groupId || '') === String(gh.id)) { gRows.push(gAllRows[hr]); }
                }
                gRows.sort(function (a, b) {
                    var d = String(a.sendTime).localeCompare(String(b.sendTime));
                    return d !== 0 ? d : ((parseInt(a.seq, 10) || 0) - (parseInt(b.seq, 10) || 0));
                });
                var gOut = [];
                for (var ho = 0; ho < gRows.length; ho++) { gOut.push(normalizeMsg(gRows[ho], me)); }
                touchGroupRead(gh, me);
                writeGroups(readGroups().map(function (x) { return x.id === gh.id ? gh : x; }));
                var gv = groupView(gh, me);
                gv.unread = 0;
                return { code: 0, message: 'ok', data: {
                    me: me, group: gv, list: gOut, groupName: gh.groupName
                } };
            }
            /* ---- 改群名 / 换成员（仅群主） ---- */
            if (path === '/groupupdate') {
                var gu = findGroup(params.groupId);
                if (!gu || !parseInt(gu.enabled === undefined ? 1 : gu.enabled, 10)) {
                    return { code: 404, message: '群不存在或已解散' };
                }
                if (parseInt(gu.ownerId, 10) !== me) { return { code: 403, message: '只有群主可以修改群资料' }; }
                var guName = String(params.groupName || '').trim().slice(0, 100);
                if (guName) { gu.groupName = guName; gu.avatarText = guName.slice(0, 1); }
                if (params.memberIds !== undefined) {
                    var rawU = params.memberIds;
                    var arrU = Object.prototype.toString.call(rawU) === '[object Array]'
                        ? rawU : String(rawU || '').split(/[,\s]+/);
                    var keepU = [], ownerU = null;
                    for (var uk = 0; uk < (gu.members || []).length; uk++) {
                        if (gu.members[uk].role === 'owner') { ownerU = gu.members[uk]; }
                    }
                    for (var ua = 0; ua < arrU.length; ua++) {
                        var uid2 = parseInt(arrU[ua], 10);
                        if (!uid2 || uid2 === me) { continue; }
                        if (keepU.indexOf(uid2) >= 0) { continue; }
                        keepU.push(uid2);
                    }
                    if (!keepU.length) { return { code: 500, message: '群里至少要留一位成员（除群主外）' }; }
                    var oldByEmp = {};
                    for (var oe = 0; oe < (gu.members || []).length; oe++) {
                        oldByEmp[parseInt(gu.members[oe].empId, 10)] = gu.members[oe];
                    }
                    var newMembers = ownerU ? [ownerU] : [];
                    var topSeq = 0, uRows = readMsgs();
                    for (var us = 0; us < uRows.length; us++) {
                        if (String(uRows[us].groupId || '') !== String(gu.id)) { continue; }
                        var sq = parseInt(uRows[us].seq, 10) || 0;
                        if (sq > topSeq) { topSeq = sq; }
                    }
                    for (var un2 = 0; un2 < keepU.length; un2++) {
                        var oldM = oldByEmp[keepU[un2]];
                        newMembers.push(oldM || {
                            empId: keepU[un2], empName: empNameOf(keepU[un2]),
                            role: 'member', lastReadSeq: topSeq, joinTime: now()
                        });
                    }
                    gu.members = newMembers;
                }
                gu.updateTime = now();
                writeGroups(readGroups().map(function (x) { return x.id === gu.id ? gu : x; }));
                var uv = groupView(gu, me);
                return { code: 0, message: '群资料已更新', data: { groupId: gu.id, message: '群资料已更新', group: uv } };
            }
            /* ---- 群主解散 / 成员退群 ---- */
            if (path === '/groupdelete') {
                var del2 = findGroup(params.groupId);
                if (!del2 || !parseInt(del2.enabled === undefined ? 1 : del2.enabled, 10)) {
                    return { code: 404, message: '群不存在或已解散' };
                }
                var isOwner2 = parseInt(del2.ownerId, 10) === me;
                if (isOwner2) {
                    del2.enabled = 0;
                    del2.updateTime = now();
                    writeGroups(readGroups().map(function (x) { return x.id === del2.id ? del2 : x; }));
                    return { code: 0, message: '群已解散', data: {
                        groupId: del2.id, dissolved: true, left: false,
                        message: '群「' + del2.groupName + '」已解散'
                    } };
                }
                del2.members = (del2.members || []).filter(function (m) {
                    return parseInt(m.empId, 10) !== me;
                });
                writeGroups(readGroups().map(function (x) { return x.id === del2.id ? del2 : x; }));
                return { code: 0, message: '已退出群聊', data: {
                    groupId: del2.id, dissolved: false, left: true, message: '已退出群聊'
                } };
            }
            /* ---- 某群标记已读 ---- */
            if (path === '/markgroup') {
                var mkg = findGroup(params.groupId);
                if (!mkg || !parseInt(mkg.enabled === undefined ? 1 : mkg.enabled, 10)) {
                    return { code: 404, message: '群不存在或已解散' };
                }
                var mkgMem = false;
                for (var mj = 0; mj < (mkg.members || []).length; mj++) {
                    if (parseInt(mkg.members[mj].empId, 10) === me) { mkgMem = true; break; }
                }
                if (!mkgMem) { return { code: 403, message: '你不是该群成员' }; }
                touchGroupRead(mkg, me);
                writeGroups(readGroups().map(function (x) { return x.id === mkg.id ? mkg : x; }));
                return { code: 0, message: 'ok', data: {
                    groupId: mkg.id, updated: 1, unread: groupUnread(mkg, me)
                } };
            }
            return { code: 404, message: '接口不存在：/msg' + path };
        }
        /* ---------- WebSocket IM 客户端（真实 / Mock 二选一） ---------- */
        function RealImSocket(ws) {
            var self = this;
            this._h = {}; this.ws = ws; this.mock = false; this.connected = false;
            ws.onopen = function () { self.connected = true; self._emit('open'); };
            ws.onclose = function () { self.connected = false; self._emit('close'); };
            ws.onerror = function (e) { self._emit('error', e); };
            ws.onmessage = function (ev) {
                try {
                    var obj = JSON.parse(ev.data);
                    if (obj && obj.type) { self._emit('message', obj); }
                } catch (e) { /* 忽略非 JSON 帧 */ }
            };
        }
        RealImSocket.prototype.on = function (t, cb) {
            (this._h[t] = this._h[t] || []).push(cb); return this;
        };
        RealImSocket.prototype._emit = function (t, data) {
            var a = this._h[t] || [];
            for (var i = 0; i < a.length; i++) { try { a[i](data); } catch (e) { } }
        };
        RealImSocket.prototype.send = function (obj) {
            if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); }
        };
        RealImSocket.prototype.close = function () { try { this.ws.close(); } catch (e) { } };

        function MockImSocket() {
            var self = this;
            this._h = {}; this.connected = false; this.closed = false; this.mock = true;
            this.me = mockLoginEmpId() || EMP_MSG_DEMO_EMP;
            window.setTimeout(function () {
                if (self.closed) { return; }
                self._emit('open');
                self._hello();
            }, 60);
        }
        MockImSocket.prototype.on = function (t, cb) {
            (this._h[t] = this._h[t] || []).push(cb); return this;
        };
        MockImSocket.prototype._emit = function (t, data) {
            var a = this._h[t] || [];
            for (var i = 0; i < a.length; i++) { try { a[i](data); } catch (e) { } }
        };
        MockImSocket.prototype._hello = function () {
            var self = this;
            var snap = buildContacts(readMsgs(), self.me);
            var meInfo = peerInfoOf(self.me);
            var gsnap = route('GET', '/groups', {});
            var groups = (gsnap && gsnap.data && gsnap.data.list) || [];
            self.connected = true;
            // 与后端 serverHello 同口径：contacts 是数组（联系人快照 list）+ onlineCount；groups 是群列表
            self._emit('message', {
                type: 'serverHello', me: self.me, meInfo: meInfo,
                contacts: snap.list, onlineCount: snap.onlineCount, groups: groups
            });
        };
        MockImSocket.prototype.send = function (obj) {
            var self = this;
            if (!obj || self.closed) { return; }
            if (obj.type === 'send') {
                var payload = {
                    content: obj.content, title: obj.title || '',
                    contentHtml: obj.contentHtml || '', atEmpIds: obj.atEmpIds || '',
                    msgType: obj.msgType || 'text', attachId: obj.attachId || ''
                };
                if (obj.groupId) { payload.groupId = obj.groupId; }
                else { payload.receiverIds = [obj.to]; }
                var r = route('POST', '/send', payload);
                /* 模拟真实网络：回执异步下发（下一轮事件循环），前端乐观气泡先上屏再对齐 */
                window.setTimeout(function () {
                    if (self.closed) { return; }
                    if (r.code === 0) {
                        self._emit('message', {
                            type: 'ack',
                            tempId: obj.tempId,
                            id: (r.data && r.data.ids && r.data.ids[0]) || null,
                            sendTime: (r.data && r.data.sentTime) || now(),
                            receiverId: obj.to || 0,
                            groupId: obj.groupId || '',
                            msgType: obj.msgType || 'text',
                            attachId: obj.attachId || '',
                            attach: (r.data && r.data.attach) || null,
                            contentHtml: (r.data && r.data.contentHtml) || obj.contentHtml || '',
                            atEmpIds: (r.data && r.data.atEmpIds) || '',
                            content: obj.content
                        });
                    } else {
                        self._emit('message', { type: 'ack', tempId: obj.tempId, error: r.message });
                    }
                }, 30);
            } else if (obj.type === 'ping') {
                self._emit('message', { type: 'pong', t: obj.t });
            }
            // hello / read / typing 在 Mock 下无需服务端参与
        };
        MockImSocket.prototype.close = function () {
            if (this.closed) { return; }
            this.closed = true; this.connected = false; this._emit('close');
        };
        /** 演示 / 探针用：模拟某联系人发来一条消息（写入存储并推送 msg 帧）；groupId 非空则是群消息 */
        MockImSocket.prototype.simulateInbound = function (peerId, content, senderName, groupId, extra) {
            var rows = readMsgs();
            var mid = mockUuid(), st = now();
            extra = extra || {};
            var item = {
                id: mid, seq: maxSeqOf(rows), senderId: peerId,
                senderName: senderName || empNameOf(peerId),
                receiverId: groupId ? 0 : this.me,
                receiverName: groupId ? '' : empNameOf(this.me),
                title: '', content: content, sendTime: st, msgType: 'text', attachId: '',
                contentHtml: extra.contentHtml || '', atEmpIds: extra.atEmpIds || '',
                groupId: groupId || '',
                readStatus: 0, senderDeleted: 0, receiverDeleted: 0, createTime: st
            };
            rows.push(item); writeMsgs(rows);
            this._emit('message', {
                type: 'msg', id: mid, senderId: peerId, senderName: item.senderName,
                content: content, sendTime: st, groupId: groupId || '', msgType: 'text',
                contentHtml: item.contentHtml, atEmpIds: item.atEmpIds
            });
            return mid;
        };

        function connect(opts) {
            opts = opts || {};
            if (!config.useMock) {
                // 真实后端：原生 WebSocket（同源 /ws/msg）
                var sess = (window.readSession ? window.readSession() : null) || readSession();
                var token = (sess && sess.token) || '';
                var proto = (window.location.protocol === 'https:' ? 'wss://' : 'ws://');
                var url = proto + window.location.host + '/ws/msg?token=' + encodeURIComponent(token || '');
                return new RealImSocket(new WebSocket(url));
            }
            return new MockImSocket();
        }

        return { route: route, raw: readMsgs, write: writeMsgs, connect: connect,
                 simulateInbound: function (peerId, content, name) {
                     var s = new MockImSocket(); return s.simulateInbound(peerId, content, name);
                 } };
    }

    var msgSvc = createEmpMessageService();

    /* ---------------- 主框架「提醒中心」模拟服务（notify） ----------------
       与后端 NotifyService.summary 同口径：一次给出「即时对话未读（按人聚合）+ 我的邮箱未读」，
       供 main.html 顶栏铃铛（红点 + 下拉分「新对话 / 新邮件」）与左侧菜单上标使用。
       数据不另存一份，直接复用 /msg 与 /empmail 两个模拟服务的既有存储，避免口径漂移。 */
    function createNotifyService() {
        function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
        function summary() {
            var out = {
                im: { unread: 0, peers: [] },
                mail: { configured: false, unread: 0, items: [] },
                total: 0,
                serverTime: now()
            };
            // 即时对话：联系人快照里 unread>0 的按未读数倒序（后端按最近一条时间倒序，前端展示差异可忽略）
            try {
                var c = msgSvc.route('GET', '/contacts', {});
                if (c && c.code === 0 && c.data) {
                    var peers = [], total = 0;
                    var arr = c.data.list || [];
                    for (var i = 0; i < arr.length; i++) {
                        var it = arr[i], u = num(it.unread);
                        if (u <= 0) { continue; }
                        total += u;
                        peers.push({
                            empId: num(it.empId), name: it.name || ('员工' + it.empId),
                            deptName: it.deptName || '', jobTitle: it.jobTitle || '',
                            avatarText: it.avatarText || String(it.name || '?').slice(0, 1),
                            unread: u, lastContent: it.lastContent || '', lastTime: it.lastTime || ''
                        });
                    }
                    out.im = { empId: num(c.data.me), unread: total, peers: peers.slice(0, 8) };
                }
            } catch (e) { /* 单测 / 无存储时降级为空 */ }
            // 群未读：并入「对话」未读总数，群条目单独一段（与后端 unread_summary.groups 同口径）
            try {
                var gs = msgSvc.route('GET', '/groups', {});
                if (gs && gs.code === 0 && gs.data) {
                    var gitems = [], gtotal = 0, glist = gs.data.list || [];
                    for (var gi = 0; gi < glist.length; gi++) {
                        var gu = num(glist[gi].unread);
                        if (gu <= 0) { continue; }
                        gtotal += gu;
                        gitems.push({
                            groupId: glist[gi].groupId, isGroup: true,
                            name: glist[gi].name || '群聊',
                            avatarText: glist[gi].avatarText || String(glist[gi].name || '群').slice(0, 1),
                            unread: gu, lastContent: glist[gi].lastContent || '',
                            lastTime: glist[gi].lastTime || '',
                            lastSenderName: glist[gi].lastSenderName || ''
                        });
                    }
                    out.im.groups = gitems.slice(0, 8);
                    out.im.groupUnread = gtotal;
                    out.im.unread = num(out.im.unread) + gtotal;
                }
            } catch (e3) { /* 同上 */ }
            // 新邮件：我的邮箱收件未读（未配置信箱时 configured=false，不报错）
            try {
                var s = empMailSvc.route('GET', '/status', {});
                if (s && s.code === 0 && s.data) {
                    var mo = { configured: !!s.data.configured, empId: num(s.data.empId),
                        email: s.data.email || '', unread: num(s.data.unread), items: [] };
                    if (mo.configured && mo.unread > 0) {
                        var l = empMailSvc.route('GET', '/list',
                            { folder: 'inbox', unread: 1, pageNum: 1, pageSize: 5 });
                        var rows = (l && l.code === 0 && l.data && l.data.list) || [];
                        for (var j = 0; j < rows.length; j++) {
                            mo.items.push({
                                id: rows[j].id, fromAddr: rows[j].fromAddr || '',
                                fromName: rows[j].fromName || rows[j].fromAddr || '',
                                subject: rows[j].subject || '(无主题)',
                                sentTime: rows[j].sentTime || ''
                            });
                        }
                    }
                    out.mail = mo;
                }
            } catch (e2) { /* 同上 */ }
            out.total = num(out.im.unread) + num(out.mail.unread);
            return out;
        }
        function route(method, path) {
            if (path === '/summary') { return { code: 0, message: 'ok', data: summary() }; }
            return { code: 404, message: '接口不存在：/notify' + path };
        }
        return { route: route, summary: summary };
    }

    var notifySvc = createNotifyService();

    /* ---------------- 数据中心 · 报表设计器（report）模拟服务 ----------------
       与后端 ReportDesignerService 同口径：报表信息（编码 / 名称 / 分类 / 数据源 / 主表 / SQL /
       参数 / 列 / 画布 / 页面模板）落一份本地存储；预览与调用返回演示数据。
       数据源元数据直接走 /dbinfo 的模拟服务，保证「连接 → 实例 → 表 → 字段」与数据库页一致。 */
    var REPORT_KEY = 'menu_admin_reportinfos_v1';
    var REPORT_DEFAULT_DESIGN = {
        title: '', subtitle: '', headerText: '', footerText: '',
        headerAlign: 'left', footerAlign: 'center',      // 页眉 / 页脚文字对齐
        showTitle: true, showParams: true, zebra: true, bordered: true,
        showSummary: true, groupBy: '', showRowNo: false,
        elements: []                    // 设计区组件（工具箱里的文本 / 线条 / 区域 / 图像 / 图表 / 表格）
    };
    var REPORT_DEFAULT_TEMPLATE = {
        paper: 'A4', orientation: 'portrait',
        marginTop: 12, marginRight: 10, marginBottom: 12, marginLeft: 10,
        fontFamily: 'Microsoft YaHei', fontSize: 12,
        titleSize: 18, titleAlign: 'center', titleBold: true,
        compact: false, showPageNo: true, showTime: true, watermark: '',
        headerLogo: '', headerLogoHeight: 32, headerLogoPos: 'left',
        footerLogo: '', footerLogoHeight: 28, footerLogoPos: 'left'
    };

    function reportMerge(src, defaults) {
        var out = clone(defaults);
        if (src && typeof src === 'object') {
            for (var key in defaults) {
                if (defaults.hasOwnProperty(key) && src[key] !== undefined && src[key] !== null) {
                    out[key] = src[key];
                }
            }
        }
        return out;
    }

    /** 按字段名造演示值（离线预览用）：主键 / 姓名 / 状态 / 时间 / 金额各有形态 */
    function reportDemoCell(name, index) {
        var key = String(name || '');
        if (/^(id|code|no)$/i.test(key)) { return index; }
        if (/name/i.test(key)) { return '演示名称-' + index; }
        if (/enabled|status|flag/i.test(key)) { return index % 2; }
        if (/time|date/i.test(key)) { return '2026-11-0' + ((index % 9) + 1) + ' 09:00:00'; }
        if (/email|mail/i.test(key)) { return 'demo' + index + '@jiudou.com'; }
        if (/phone|mobile|tel/i.test(key)) { return '1380013' + ('0000' + index).slice(-4); }
        if (/amount|money|price|salary|total/i.test(key)) { return (index * 128.5).toFixed(2); }
        if (/qty|count|num|age/i.test(key)) { return index % 37; }
        return key + '-' + index;
    }

    /** 从 SELECT 语句里解析出结果列名（离线模式用来模拟「SQL 只挑了部分列」） */
    function mockSelectFields(sql) {
        var m = /^\s*select\s+([\s\S]+?)\s+from\s/i.exec(String(sql || ''));
        if (!m || /\*/.test(m[1])) { return []; }
        var parts = m[1].split(','), out = [], i;
        for (i = 0; i < parts.length; i++) {
            var one = parts[i].replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
            if (!one) { continue; }
            var as = /\s+as\s+([A-Za-z0-9_]+)$/i.exec(one);
            if (as) { out.push(as[1]); continue; }
            var ident = /([A-Za-z0-9_]+)\s*$/.exec(one);
            if (ident) { out.push(ident[1]); }
        }
        return out;
    }

    function createReportService() {
        /* 当前登录人姓名（离线演示也按真实登录态填创建人）：empName → name → account */
        function mockCreateUser() {
            try {
                var raw = window.localStorage ? window.localStorage.getItem('menu_admin_login_v1') : '';
                var sess = raw ? JSON.parse(raw) : null;
                var u = (sess && sess.user) || {};
                var name = u.empName || u.name || u.account || '';
                return ('' + name).replace(/^\s+|\s+$/g, '') || '系统管理员';
            } catch (e) { return '系统管理员'; }
        }
        /* 当前登录员工的ID（与后端 createempinfosid / updateempinfosid 同源） */
        function mockCreateEmpId() {
            try {
                var raw = window.localStorage ? window.localStorage.getItem('menu_admin_login_v1') : '';
                var sess = raw ? JSON.parse(raw) : null;
                var u = (sess && sess.user) || {};
                return parseInt(u.empId, 10) || 0;
            } catch (e) { return 0; }
        }
        var SEED = [
            {
                id: 'rp-0000-4000-8000-000000000001',
                code: 'RPT0001', reportName: '员工花名册', reportNameEn: 'EmployeeRoster',
                category: '人力资源', connId: 'db-0000-4000-8000-000000000001',
                connName: '九豆主库（MySQL）', databaseName: 'jiudou_main', mainTable: 'empinfos',
                sqlText: '', description: '按部门列出员工基本信息（离线演示报表）',
                params: [
                    { name: 'deptName', label: '部门', type: 'string', control: 'text',
                      required: false, defaultValue: '', options: '', remark: '可留空表示全部部门' }
                ],
                columns: [
                    { field: 'code', label: '工号', table: 'empinfos', width: 110, align: 'left', format: 'text', summary: 'none', visible: true },
                    { field: 'nameCn', label: '姓名', table: 'empinfos', width: 100, align: 'center', format: 'text', summary: 'none', visible: true },
                    { field: 'phone', label: '手机', table: 'empinfos', width: 130, align: 'left', format: 'text', summary: 'none', visible: true },
                    { field: 'email', label: '邮箱', table: 'empinfos', width: 190, align: 'left', format: 'text', summary: 'none', visible: true }
                ],
                design: reportMerge({ title: '员工花名册', subtitle: '九豆综合管理平台', showSummary: false }, REPORT_DEFAULT_DESIGN),
                template: reportMerge({ paper: 'A4', orientation: 'landscape' }, REPORT_DEFAULT_TEMPLATE),
                enabled: true, ispublic: true, version: 1, runCount: 3,
                lastRunTime: '2026-11-01 18:20:00',
                createEname: '系统管理员', createempinfosid: 1,
                updateEname: '系统管理员', updateempinfosid: 1,
                createTime: '2026-11-01 17:00:00', updateTime: '2026-11-01 18:20:00'
            },
            {
                id: 'rp-0000-4000-8000-000000000002',
                code: 'RPT0002', reportName: '邮件收发统计', reportNameEn: 'MailStat',
                category: '经营分析', connId: 'db-0000-4000-8000-000000000001',
                connName: '九豆主库（MySQL）', databaseName: 'jiudou_main', mainTable: 'serviceemail',
                sqlText: 'SELECT `id`, `email` FROM `serviceemail`', description: '服务信箱收发量统计（离线演示报表）',
                params: [
                    { name: 'beginDate', label: '开始日期', type: 'date', control: 'date', required: false, defaultValue: '', options: '', remark: '' },
                    { name: 'endDate', label: '结束日期', type: 'date', control: 'date', required: false, defaultValue: '', options: '', remark: '' }
                ],
                columns: [
                    { field: 'id', label: '编号', table: 'serviceemail', width: 120, align: 'left', format: 'text', summary: 'none', visible: true },
                    { field: 'email', label: '信箱', table: 'serviceemail', width: 220, align: 'left', format: 'text', summary: 'none', visible: true }
                ],
                design: reportMerge({ title: '邮件收发统计' }, REPORT_DEFAULT_DESIGN),
                template: reportMerge({ paper: 'A5', orientation: 'portrait', compact: true }, REPORT_DEFAULT_TEMPLATE),
                enabled: false, ispublic: true, version: 2, runCount: 0,
                lastRunTime: '',
                createEname: '系统管理员', createempinfosid: 1,
                updateEname: '系统管理员', updateempinfosid: 1,
                createTime: '2026-11-01 17:30:00', updateTime: '2026-11-01 17:40:00'
            }
        ];

        var memory = null;
        function read() {
            try {
                var raw = window.localStorage.getItem(REPORT_KEY);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            if (memory) { return memory; }
            memory = clone(SEED);
            return memory;
        }
        function write(list) {
            memory = list;
            try { window.localStorage.setItem(REPORT_KEY, JSON.stringify(list)); } catch (e) { }
        }
        function find(list, id) {
            for (var i = 0; i < list.length; i++) {
                if (String(list[i].id) === String(id)) { return list[i]; }
            }
            return null;
        }
        function textOf(v) { return v === undefined || v === null ? '' : String(v).trim(); }

        function attach(row, full) {
            var out = clone(row);
            out.params = out.params || [];
            out.columns = out.columns || [];
            out.design = reportMerge(out.design, REPORT_DEFAULT_DESIGN);
            out.template = reportMerge(out.template, REPORT_DEFAULT_TEMPLATE);
            out.enabled = out.enabled === true || out.enabled === 1 || out.enabled === '1';
            out.ispublic = out.ispublic === true || out.ispublic === 1 || out.ispublic === '1';
            out.paramCount = out.params.length;
            out.columnCount = out.columns.length;
            out.title = out.design.title || out.reportName;
            out.category = out.category || '未分类';
            out.lastRunTime = out.lastRunTime || '';
            out.connName = out.connName || '';
            /* 数据源连接快照：只回展示字段（**密码只进不出**，只给 hasConnPassword 标记） */
            out.connSnapshot = (out.connType || out.connHost || out.connDbName) ? {
                id: out.connId || '', name: out.connName || '',
                dbType: textOf(out.connType) || 'mysql',
                typeLabel: textOf(out.connType) || 'mysql',
                host: textOf(out.connHost), port: out.connPort || null,
                dbName: textOf(out.connDbName), username: textOf(out.connUsername),
                charset: textOf(out.connCharset), extraParams: textOf(out.connExtraParams),
                hasPassword: !!out.connPassword
            } : {};
            out.hasConnPassword = !!out.connPassword;
            delete out.connPassword;
            out.paperText = (out.template.paper || 'A4') + ' / ' +
                (out.template.orientation === 'landscape' ? '横向' : '纵向');
            if (!full) {
                out.sqlPreview = textOf(out.sqlText).length > 120
                    ? textOf(out.sqlText).slice(0, 120) + '…' : textOf(out.sqlText);
                var pl = [], i;
                for (i = 0; i < Math.min(out.params.length, 3); i++) {
                    pl.push(out.params[i].label || out.params[i].name);
                }
                out.paramSummary = pl.join('、');
                var cl = [];
                for (i = 0; i < Math.min(out.columns.length, 4); i++) {
                    cl.push(out.columns[i].label || out.columns[i].field);
                }
                out.columnSummary = cl.join('、');
                delete out.params;
                delete out.columns;
                delete out.design;
                delete out.template;
                delete out.sqlText;
            }
            return out;
        }

        function cleanParams(items) {
            var out = [], seen = {}, i;
            items = items || [];
            for (i = 0; i < items.length; i++) {
                var one = items[i] || {};
                var name = textOf(one.name);
                if (!name) { return { error: '报表参数名不能为空' }; }
                if (!/^[A-Za-z_][A-Za-z0-9_]{0,29}$/.test(name)) {
                    return { error: '参数名「' + name + '」不合法：只能用字母、数字、下划线，且以字母或下划线开头' };
                }
                if (seen[name]) { return { error: '参数名「' + name + '」重复，请换一个' }; }
                seen[name] = 1;
                out.push({
                    name: name, label: textOf(one.label) || name,
                    type: textOf(one.type) || 'string',
                    control: textOf(one.control) || 'text',
                    required: one.required === true || one.required === 1 || one.required === '1',
                    defaultValue: textOf(one.defaultValue), options: textOf(one.options),
                    remark: textOf(one.remark)
                });
            }
            return { list: out };
        }

        function cleanColumns(items) {
            var out = [], seen = {}, i;
            items = items || [];
            for (i = 0; i < items.length; i++) {
                var one = items[i] || {};
                var field = textOf(one.field);
                if (!field) { return { error: '报表列缺少字段名，请重新从左侧拖一个字段进来' }; }
                if (seen[field]) { continue; }
                seen[field] = 1;
                out.push({
                    field: field, label: textOf(one.label) || field, table: textOf(one.table),
                    width: parseInt(one.width, 10) || 120,
                    align: textOf(one.align) || 'left',
                    headerAlign: textOf(one.headerAlign) || 'center',
                    format: textOf(one.format) || 'text',
                    summary: textOf(one.summary) || 'none',
                    visible: !(one.visible === false || one.visible === 0 || one.visible === '0'),
                    custom: one.custom === true || one.custom === 1 || one.custom === '1'
                });
            }
            return { list: out };
        }

        /* 报表预览：拼 SQL（没写 SQL 就按主表 + 列自动拼）+ 演示数据 */
        function previewOf(payload, paramValues, maxRows) {
            var conn = null, conns = dbInfoSvc.route('GET', '/list', { pageNum: 1, pageSize: 200 });
            var rowsConn = ((conns && conns.data) || {}).list || [];
            for (var ci = 0; ci < rowsConn.length; ci++) {
                if (String(rowsConn[ci].id) === String(payload.connId)) { conn = rowsConn[ci]; }
            }
            if (!conn) { return { code: 500, message: '报表还没有选择数据源连接' }; }
            var values = paramValues || {};
            var paramsDef = payload.params || [];
            for (var pi = 0; pi < paramsDef.length; pi++) {
                var pdef = paramsDef[pi];
                var given = values[pdef.name];
                if ((given === undefined || String(given) === '') &&
                    (pdef.defaultValue === undefined || String(pdef.defaultValue) === '')) {
                    if (pdef.required) {
                        return { code: 500, message: '请先填写报表参数「' + (pdef.label || pdef.name) + '」' };
                    }
                }
            }
            var columns = payload.columns || [];
            var sql = textOf(payload.sqlText);
            if (!sql) {
                if (!textOf(payload.mainTable)) {
                    return { code: 500, message: '请把左侧的表拖进画布，或写一条报表 SQL' };
                }
                var fields = [];
                for (var fi = 0; fi < columns.length; fi++) { fields.push('`' + columns[fi].field + '`'); }
                sql = 'SELECT ' + (fields.length ? fields.join(', ') : '*') +
                    ' FROM `' + textOf(payload.mainTable) + '`';
            }
            var limit = Math.min(Math.max(parseInt(maxRows, 10) || 500, 1), 2000);
            /* 预览列以「这条 SQL 真正会返回的列」为准：能解析出 SELECT 列表就按它，
               解析不了（SELECT * / 复杂函数）或没写 SQL 时才退回画布上的列定义 */
            var names = mockSelectFields(sql);
            if (!names.length) {
                for (var ni = 0; ni < columns.length; ni++) { names.push(columns[ni].field); }
            }
            if (!names.length) { names = ['id', 'name', 'remark']; }
            var total = 23, outRows = [], r, c;
            for (r = 1; r <= Math.min(total, limit); r++) {
                var line = [];
                for (c = 0; c < names.length; c++) { line.push(reportDemoCell(names[c], r)); }
                outRows.push(line);
            }
            var mapped = [], usedName = {};
            for (var mi = 0; mi < columns.length; mi++) {
                var col = columns[mi];
                if (!col || names.indexOf(col.field) < 0) { continue; }   // SQL 没返回这一列 → 预览不显示
                usedName[col.field] = 1;
                mapped.push({
                    field: col.field, label: col.label || col.field,
                    index: names.indexOf(col.field), width: parseInt(col.width, 10) || 120,
                    align: col.align || 'left', format: col.format || 'text',
                    summary: col.summary || 'none',
                    visible: !(col.visible === false || col.visible === 0 || col.visible === '0')
                });
            }
            for (var mj = 0; mj < names.length; mj++) {          // 结果里多出来的列自动补上
                if (usedName[names[mj]]) { continue; }
                mapped.push({ field: names[mj], label: names[mj], index: mj, width: 120,
                              align: 'left', format: 'text', summary: 'none', visible: true });
            }
            var cols = [];
            for (var ck = 0; ck < names.length; ck++) { cols.push({ name: names[ck], index: ck }); }
            return { code: 0, message: 'ok', data: {
                sql: sql, statement: 'SELECT', columns: cols, rows: outRows,
                rowCount: outRows.length, affected: null, truncated: total > limit,
                elapsed: 4, maxRows: limit, executedAt: now(),
                database: textOf(payload.databaseName) || conn.dbName || '',
                dbType: conn.dbType, bindCount: 0,
                mapped: mapped, params: paramsDef, paramValues: values,
                report: { id: payload.id || '', code: payload.code || '',
                          reportName: payload.reportName || '', category: payload.category || '' },
                design: reportMerge(payload.design, REPORT_DEFAULT_DESIGN),
                template: reportMerge(payload.template, REPORT_DEFAULT_TEMPLATE),
                connection: { id: conn.id, name: conn.name, dbType: conn.dbType,
                              typeLabel: dbinfoType(conn.dbType).label },
                message: '预览成功（离线演示数据），返回 ' + outRows.length + ' 行'
            } };
        }

        function nextCode(list) {
            var max = 0;
            for (var i = 0; i < list.length; i++) {
                var m = /^RPT(\d+)$/.exec(String(list[i].code || ''));
                if (m) { max = Math.max(max, parseInt(m[1], 10)); }
            }
            return 'RPT' + ('0000' + (max + 1)).slice(-4);
        }

        function normalize(list, data, current, selfId) {
            var code = textOf(data.code) || textOf(current && current.code) || nextCode(list);
            code = code.toUpperCase();
            if (!/^[A-Z0-9_-]{2,60}$/.test(code)) {
                return { error: '报表编码只能用字母、数字、下划线或短横线（2~60 位）' };
            }
            if (code !== String((current && current.code) || '').toUpperCase()) {
                for (var i = 0; i < list.length; i++) {
                    if (String(list[i].id) !== String(selfId) &&
                        String(list[i].code).toUpperCase() === code) {
                        return { error: '报表编码【' + code + '】已存在，请换一个' };
                    }
                }
            }
            var name = textOf(data.reportName) || textOf(current && current.reportName);
            if (!name) { return { error: '报表名称不能为空' }; }
            if (name.length > 120) { return { error: '报表名称最多 120 个字符' }; }
            var connId = textOf(data.connId) || textOf(current && current.connId);
            if (!connId) { return { error: '请先选择数据源连接，再保存报表' }; }
            var conns = dbInfoSvc.route('GET', '/list', { pageNum: 1, pageSize: 200 });
            var connRows = ((conns && conns.data) || {}).list || [], conn = null;
            for (var ci = 0; ci < connRows.length; ci++) {
                if (String(connRows[ci].id) === String(connId)) { conn = connRows[ci]; }
            }
            if (!conn) { return { error: '数据库连接不存在或已被删除，请重新选择数据源' }; }
            var params = cleanParams(data.params !== undefined ? data.params
                : (current ? current.params : []));
            if (params.error) { return params; }
            var columns = cleanColumns(data.columns !== undefined ? data.columns
                : (current ? current.columns : []));
            if (columns.error) { return columns; }
            var sqlText = data.sqlText !== undefined ? textOf(data.sqlText)
                : textOf(current && current.sqlText);
            if (sqlText.length > 20000) { return { error: '报表 SQL 太长（' + sqlText.length + ' 字符），请精简到 20000 字符以内' }; }
            return { item: {
                code: code, reportName: name,
                reportNameEn: textOf(data.reportNameEn) || '',
                category: textOf(data.category) || '',
                connId: conn.id, connName: conn.name,
                /* 数据源连接快照（2026-11-06）：保存时把连接对象的访问信息一起落库，
                   连接对象后来被改 / 被删，报表仍按保存时的配置执行（与后端同一套字段） */
                connType: textOf(conn.dbType) || 'mysql',
                connHost: textOf(conn.host) || '',
                connPort: conn.port || null,
                connDbName: textOf(conn.dbName) || '',
                connUsername: textOf(conn.username) || '',
                connPassword: textOf(conn.passwordMask || conn.password) || '',
                connCharset: textOf(conn.charset) || '',
                connExtraParams: textOf(conn.extraParams) || '',
                databaseName: textOf(data.databaseName),
                mainTable: textOf(data.mainTable),
                sqlText: sqlText,
                params: params.list, columns: columns.list,
                design: reportMerge(data.design !== undefined ? data.design : (current && current.design),
                    REPORT_DEFAULT_DESIGN),
                template: reportMerge(data.template !== undefined ? data.template : (current && current.template),
                    REPORT_DEFAULT_TEMPLATE),
                description: textOf(data.description),
                enabled: data.enabled === undefined
                    ? (current ? current.enabled : true)
                    : (data.enabled === true || data.enabled === 1 || data.enabled === '1'),
                ispublic: data.ispublic === undefined
                    ? (current ? current.ispublic : false)
                    : (data.ispublic === true || data.ispublic === 1 || data.ispublic === '1')
            } };
        }

        function route(method, path, params) {
            params = params || {};
            var list = read();

            /* /list = 报表设计器清单（可看停用，**只看本用户创建的**）；
               /center = 报表中心（永远只查启用）。
               可见性口径（2026-11-06 起）：
                 · 清单：只加载本用户创建的报表（含停用，方便继续编辑）；
                 · 报表中心：本用户创建的 + 他人公开（ispublic）且启用的报表（非本人创建的停用报表不显示）。
               与后端 ReportDesignerService._visibility_where(mine_only=…) 完全同口径 */
            if ((path === '/list' || path === '/center') && method === 'GET') {
                var isCenter = (path === '/center');
                var kw = textOf(params.keyword).toLowerCase();
                var category = textOf(params.category);
                var connFilter = textOf(params.connId);
                var enabledFilter = isCenter ? '1'
                    : ((params.enabled === undefined || params.enabled === null)
                        ? '' : String(params.enabled));
                var me = mockCreateEmpId();     // 当前登录员工的ID（0 = 未登录，不过滤，与后端一致）
                var isOnRow = function (row) {
                    return row.enabled === true || row.enabled === 1 || row.enabled === '1';
                };
                var isMine = function (row) {
                    return parseInt(row.createempinfosid, 10) === me;
                };
                var isPub = function (row) {
                    return row.ispublic === true || row.ispublic === 1 || row.ispublic === '1';
                };
                var visibleToMe = isCenter
                    ? function (row) { return me <= 0 || isMine(row) || (isPub(row) && isOnRow(row)); }
                    : function (row) { return me <= 0 || isMine(row); };
                var filtered = [], i;
                for (i = 0; i < list.length; i++) {
                    var one = list[i];
                    if (!visibleToMe(one)) { continue; }
                    if (kw) {
                        var hay = [one.code, one.reportName, one.reportNameEn, one.category,
                                   one.connName, one.mainTable, one.description].join(' ').toLowerCase();
                        if (hay.indexOf(kw) < 0) { continue; }
                    }
                    if (category) {
                        var cat = one.category || '未分类';
                        if (cat !== category) { continue; }
                    }
                    if (connFilter && String(one.connId) !== connFilter) { continue; }
                    if (enabledFilter !== '') {
                        var on = one.enabled === true || one.enabled === 1 || one.enabled === '1';
                        if ((enabledFilter === '1') !== on) { continue; }
                    }
                    filtered.push(one);
                }
                /* 启用优先（停用的一律排到下部），同组内按更新时间倒序、编码升序 —— 与后端 ORDER_BY 同口径 */
                filtered.sort(function (a, b) {
                    var oa = isOnRow(a) ? 0 : 1, ob = isOnRow(b) ? 0 : 1;
                    if (oa !== ob) { return oa - ob; }
                    var ta = String(a.updateTime || ''), tb = String(b.updateTime || '');
                    if (ta !== tb) { return ta < tb ? 1 : -1; }
                    return String(a.code) < String(b.code) ? -1 : 1;
                });
                var pageNum = parseInt(params.pageNum, 10) || 1;
                var pageSize = Math.min(Math.max(parseInt(params.pageSize, 10) || 10, 1), 200);
                var pages = Math.max(1, Math.ceil(filtered.length / pageSize));
                pageNum = Math.min(pageNum, pages);
                var start = (pageNum - 1) * pageSize;
                var counts = {};
                for (i = 0; i < list.length; i++) {
                    if (!visibleToMe(list[i])) { continue; }
                    if (isCenter &&
                        !(list[i].enabled === true || list[i].enabled === 1 || list[i].enabled === '1')) {
                        continue;                       // 报表中心的分类下拉只统计启用
                    }
                    var key = list[i].category || '未分类';
                    counts[key] = (counts[key] || 0) + 1;
                }
                var cats = [];
                for (var ck in counts) {
                    if (counts.hasOwnProperty(ck)) { cats.push({ value: ck, count: counts[ck] }); }
                }
                cats.sort(function (a, b) { return b.count - a.count; });
                var out = [];
                var slice = filtered.slice(start, start + pageSize);
                for (i = 0; i < slice.length; i++) { out.push(attach(slice[i], false)); }
                return { code: 0, message: 'ok', data: {
                    list: out, total: filtered.length, pageNum: pageNum,
                    pageSize: pageSize, pages: pages, categories: cats
                } };
            }

            if (path === '/detail' && method === 'GET') {
                var found = find(list, params.id);
                if (!found) { return { code: 404, message: '报表不存在或已被删除' }; }
                return { code: 0, message: 'ok', data: attach(found, true) };
            }

            if (path === '/check' && method === 'GET') {
                var value = textOf(params.value).toUpperCase();
                if (!value) { return { code: 0, message: 'ok', data: { unique: true } }; }
                for (var di = 0; di < list.length; di++) {
                    if (String(list[di].id) !== String(params.id || '') &&
                        String(list[di].code).toUpperCase() === value) {
                        return { code: 0, message: 'ok', data: { unique: false } };
                    }
                }
                return { code: 0, message: 'ok', data: { unique: true } };
            }

            if (path === '/categories' && method === 'GET') {
                var cmap = {}, clist = [];
                for (var cj = 0; cj < list.length; cj++) {
                    var ckey = list[cj].category || '未分类';
                    cmap[ckey] = (cmap[ckey] || 0) + 1;
                }
                for (var ck2 in cmap) {
                    if (cmap.hasOwnProperty(ck2)) { clist.push({ value: ck2, count: cmap[ck2] }); }
                }
                clist.sort(function (a, b) { return b.count - a.count; });
                return { code: 0, message: 'ok', data: { list: clist } };
            }

            if (path === '/connections' && method === 'GET') {
                /* 复用 dbinfo 的 /list：可见性（本用户创建的 + 他人公用的）由那一层统一过滤，
                   这里再挑出启用状态的，两处口径天然一致 */
                var cres = dbInfoSvc.route('GET', '/list', { pageNum: 1, pageSize: 200 });
                var crow = ((cres && cres.data) || {}).list || [], out2 = [];
                for (var ci2 = 0; ci2 < crow.length; ci2++) {
                    if (!(crow[ci2].enabled === true || crow[ci2].enabled === 1 || crow[ci2].enabled === '1')) { continue; }
                    var meta = dbinfoType(crow[ci2].dbType);
                    out2.push({ id: crow[ci2].id, name: crow[ci2].name, dbType: crow[ci2].dbType,
                                typeLabel: meta.label, hasFile: meta.hasFile,
                                dbName: crow[ci2].dbName || '',
                                serverText: crow[ci2].serverText || '' });
                }
                return { code: 0, message: 'ok', data: { list: out2, total: out2.length } };
            }

            if (path === '/databases' && method === 'GET') {
                var dres = dbInfoSvc.route('POST', '/scan', { id: params.connId });
                if (dres.code !== 0) { return dres; }
                return { code: 0, message: 'ok', data: dres.data };
            }

            if (path === '/tables' && method === 'GET') {
                return dbInfoSvc.route('GET', '/tables', { database: params.database });
            }

            if (path === '/columns' && method === 'GET') {
                return dbInfoSvc.route('GET', '/columns', { database: params.database, table: params.table });
            }

            if (path === '/add' && method === 'POST') {
                var built = normalize(list, params, null, '');
                if (built.error) { return { code: 500, message: built.error }; }
                var item2 = built.item;
                item2.id = mockUuid();
                item2.version = 1;
                item2.runCount = 0;
                item2.lastRunTime = '';
                item2.createEname = mockCreateUser();
                item2.createempinfosid = mockCreateEmpId();
                item2.updateEname = item2.createEname;          // 新建即首次保存，修改人先与创建人一致
                item2.updateempinfosid = item2.createempinfosid;
                item2.createTime = now();
                item2.updateTime = item2.createTime;
                list.push(item2);
                write(list);
                return { code: 0, message: '新增成功', data: attach(item2, true) };
            }

            if (path === '/update' && method === 'POST') {
                var target = find(list, params.id);
                if (!target) { return { code: 404, message: '报表不存在或已被删除' }; }
                var built2 = normalize(list, params, target, target.id);
                if (built2.error) { return { code: 500, message: built2.error }; }
                var next = built2.item;
                for (var key2 in next) {
                    if (next.hasOwnProperty(key2)) { target[key2] = next[key2]; }
                }
                target.version = (parseInt(target.version, 10) || 1) + 1;
                target.updateEname = mockCreateUser();          // 修改人 = 当前登录人，每次都刷新
                target.updateempinfosid = mockCreateEmpId();
                target.updateTime = now();
                write(list);
                return { code: 0, message: '修改成功', data: attach(target, true) };
            }

            if (path === '/delete' && method === 'POST') {
                var idx = -1;
                for (var k = 0; k < list.length; k++) {
                    if (String(list[k].id) === String(params.id)) { idx = k; break; }
                }
                if (idx < 0) { return { code: 404, message: '报表不存在或已被删除' }; }
                var removed = list[idx];
                list.splice(idx, 1);
                write(list);
                return { code: 0, message: '删除成功', data: attach(removed, true) };
            }

            if (path === '/enabled' && method === 'POST') {
                var on2 = find(list, params.id);
                if (!on2) { return { code: 404, message: '报表不存在或已被删除' }; }
                on2.enabled = !(params.enabled === 0 || params.enabled === '0' || params.enabled === false);
                on2.updateTime = now();
                write(list);
                var outOn = attach(on2, true);
                outOn.message = '报表「' + on2.reportName + '」已' + (on2.enabled ? '启用' : '停用');
                return { code: 0, message: 'ok', data: outOn };
            }

            if (path === '/copy' && method === 'POST') {
                var src = find(list, params.id);
                if (!src) { return { code: 404, message: '报表不存在或已被删除' }; }
                var copyItem = clone(src);
                copyItem.id = mockUuid();
                copyItem.code = nextCode(list);
                copyItem.reportName = textOf(params.reportName) || (src.reportName + '（副本）');
                copyItem.enabled = false;
                copyItem.ispublic = false;                      // 副本默认私有（创建人 = 执行复制的人）
                copyItem.version = 1;
                copyItem.runCount = 0;
                copyItem.lastRunTime = '';
                copyItem.createEname = mockCreateUser();        // 副本的创建人 = 执行复制的人
                copyItem.createempinfosid = mockCreateEmpId();
                copyItem.updateEname = copyItem.createEname;
                copyItem.updateempinfosid = copyItem.createempinfosid;
                copyItem.createTime = now();
                copyItem.updateTime = copyItem.createTime;
                list.push(copyItem);
                write(list);
                var outCopy = attach(copyItem, true);
                outCopy.message = '已复制为「' + copyItem.code + '」（默认停用）';
                return { code: 0, message: 'ok', data: outCopy };
            }

            if (path === '/preview' && method === 'POST') {
                var payload = {
                    id: '', code: '', reportName: '', category: '',
                    connId: params.connId, databaseName: params.databaseName,
                    mainTable: params.mainTable, sqlText: params.sqlText,
                    columns: params.columns || [], params: params.paramsJson || [],
                    design: params.design, template: params.template
                };
                if (params.id) {
                    var saved = find(list, params.id);
                    if (!saved) { return { code: 404, message: '报表不存在或已被删除' }; }
                    payload = clone(saved);
                    if (params.connId) { payload.connId = params.connId; }
                    if (params.databaseName !== undefined) { payload.databaseName = params.databaseName; }
                    if (params.mainTable !== undefined) { payload.mainTable = params.mainTable; }
                    if (params.sqlText !== undefined) { payload.sqlText = params.sqlText; }
                    if (params.columns) { payload.columns = params.columns; }
                    if (params.paramsJson) { payload.params = params.paramsJson; }
                    if (params.design) { payload.design = params.design; }
                    if (params.template) { payload.template = params.template; }
                }
                return previewOf(payload, params.paramValues, params.maxRows);
            }

            if (path === '/run' && method === 'POST') {
                var runRow = null;
                if (params.id) { runRow = find(list, params.id); }
                else if (params.code) {
                    for (var ri = 0; ri < list.length; ri++) {
                        if (String(list[ri].code).toUpperCase() === textOf(params.code).toUpperCase()) {
                            runRow = list[ri];
                        }
                    }
                }
                if (!runRow) { return { code: 404, message: '报表不存在或已被删除' }; }
                if (!(runRow.enabled === true || runRow.enabled === 1 || runRow.enabled === '1')) {
                    return { code: 500, message: '报表「' + runRow.reportName + '」已停用，不能调用' };
                }
                var runRes = previewOf(runRow, params.paramValues, params.maxRows);
                if (runRes.code !== 0) { return runRes; }
                runRow.runCount = (parseInt(runRow.runCount, 10) || 0) + 1;
                runRow.lastRunTime = now();
                write(list);
                runRes.data.runCount = runRow.runCount;
                runRes.data.lastRunTime = runRow.lastRunTime;
                runRes.data.message = '报表「' + runRow.reportName + '」执行完成（离线演示），返回 ' +
                    runRes.data.rowCount + ' 行';
                return runRes;
            }

            return { code: 404, message: '接口不存在：/report' + path };
        }

        return { route: route, raw: read };
    }

    var reportSvc = createReportService();


    /* ==========================================================================
       项目管理模拟服务：项目信息（project）+ 项目目录（projectdir）+ 项目文件（projectfile）
       --------------------------------------------------------------------------
       · 与后端 ProjectBaseService 同口径：列表 / 详情 / 下拉 / 下载统一按
         「本人创建（或上传） OR ispub=1」过滤；me=0（取不到登录态）时不过滤；
       · 项目编号由服务端生成 PRO + 6 位流水号，前端传的 projectCode 一律忽略；
       · 文件上传只登记元数据（base64 内容不写 localStorage，避免演示数据膨胀），
         下载走 filePath 对应的同源静态路径。
       ========================================================================== */
    var PROJECT_KEY = 'menu_admin_projectinfos_v1';
    var PROJECTFILE_KEY = 'menu_admin_projectfiles_v1';
    var PROJECTDIR_KEY = 'menu_admin_projectdirs_v1';
    var PROJECT_TYPES = ['研发', '实施', '测试', '设计', '产品', '需求', '数据分析', '科研', '其它'];
    var PROJECT_STATUSES = ['未开始', '进行中', '已暂停', '已完成', '已归档'];
    var PROJECT_FILE_TYPES = ['文档', '表格', '图片', '压缩包', '代码', '设计稿', '其它'];
    var PROJECT_TYPE_DICT = 'project_type';

    /** 项目类型下拉（与后端 project_type_dict() 同口径）：每条键值取「键」做文本与
        保存值（键留空时用「键值」），优先取系统字典 project_type 的启用项、按 sortNo
        升序；字典缺失 / 无启用键值时回落内置 PROJECT_TYPES。
        返回 {values, source}，source 为 'dict' / 'builtin'。 */
    function mockProjectTypes() {
        var dicts = [], items = [], head = null, out = [], vals = [], i;
        try { dicts = sysConfigMocks.sysdict.raw() || []; } catch (e) { dicts = []; }
        try { items = sysConfigMocks.sysdictitems.raw() || []; } catch (e) { items = []; }
        for (i = 0; i < dicts.length; i++) {
            if (String(dicts[i].dictNameEn || '') === PROJECT_TYPE_DICT &&
                dicts[i].enabled !== false && Number(dicts[i].enabled) !== 0) {
                head = dicts[i];
                break;
            }
        }
        if (!head) { return { values: PROJECT_TYPES.slice(), source: 'builtin' }; }
        for (i = 0; i < items.length; i++) {
            if (String(items[i].dictId) !== String(head.id)) { continue; }
            if (items[i].enabled === false || Number(items[i].enabled) === 0) { continue; }
            var v = (String(items[i].itemKey == null ? '' : items[i].itemKey).trim() ||
                     String(items[i].itemValue == null ? '' : items[i].itemValue).trim());
            if (v) { out.push({ v: v, s: Number(items[i].sortNo) || 0, id: String(items[i].id) }); }
        }
        out.sort(function (a, b) {
            if (a.s !== b.s) { return a.s - b.s; }
            return a.id.localeCompare(b.id);
        });
        for (i = 0; i < out.length; i++) {
            if (vals.indexOf(out[i].v) < 0) { vals.push(out[i].v); }
        }
        return vals.length ? { values: vals, source: 'dict' }
            : { values: PROJECT_TYPES.slice(), source: 'builtin' };
    }

    /** 当前登录员工ID（Mock 可见性判定；0 = 未登录 / 取不到 → 不过滤，与后端一致） */
    function mockLoginEmpId() {
        try {
            var raw = window.localStorage ? window.localStorage.getItem('menu_admin_login_v1') : '';
            var sess = raw ? JSON.parse(raw) : null;
            var u = (sess && sess.user) || {};
            return parseInt(u.empId, 10) || 0;
        } catch (e) { return 0; }
    }
    /** 公用否：老数据没这个字段按公用算 */
    function mockIsPub(value) { return !(value === 0 || value === '0' || value === false); }
    function mockBool(value, def) {
        if (value === undefined || value === null || value === '') { return !!def; }
        return !(value === 0 || value === '0' || value === false || value === 'false');
    }
    function mockStr(value) { return String(value == null ? '' : value).trim(); }

    /** HTML → 纯文本（Mock 发件时给 bodyText 兜底，与后端 mail_client.html_to_text 同口径） */
    function mockHtmlToText(html) {
        var s = String(html == null ? '' : html)
            .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<li[^>]*>/gi, '\n· ')
            .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article)\s*>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&');
        return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
            .replace(/^\s+|\s+$/g, '');
    }

    function mockSizeText(size) {
        var n = parseFloat(size) || 0;
        if (n < 1024) { return Math.round(n) + ' B'; }
        n /= 1024;
        if (n < 1024) { return n.toFixed(1) + ' KB'; }
        return (n / 1024).toFixed(1) + ' MB';
    }

    function createProjectMockServices() {
        var SEED_PROJECT = [
            { id: 'prj-0000-4000-8000-000000000001', projectCode: 'PRO000001',
              projectName: '九豆综合管理平台研发', projectType: '研发', projectStatus: '进行中',
              projectDesc: '前端 H5 + Flask 后端的一体化综合管理平台', ispub: true,
              createEname: '杨伟康', createempinfosid: 3, enabled: true,
              createTime: '2026-11-01 09:00:00', updateTime: '2026-11-01 09:00:00' },
            { id: 'prj-0000-4000-8000-000000000002', projectCode: 'PRO000002',
              projectName: '客户现场实施项目', projectType: '实施', projectStatus: '未开始',
              projectDesc: '华东区客户现场部署与培训', ispub: true,
              createEname: '李明', createempinfosid: 2, enabled: true,
              createTime: '2026-11-02 10:20:00', updateTime: '2026-11-02 10:20:00' },
            { id: 'prj-0000-4000-8000-000000000003', projectCode: 'PRO000003',
              projectName: '内部测试专项', projectType: '测试', projectStatus: '已完成',
              projectDesc: '回归测试与性能压测', ispub: false,
              createEname: '杨伟康', createempinfosid: 3, enabled: false,
              createTime: '2026-11-03 14:05:00', updateTime: '2026-11-03 14:05:00' },
            { id: 'prj-0000-4000-8000-000000000004', projectCode: 'PRO000004',
              projectName: '他人私有项目（不应可见）', projectType: '其它', projectStatus: '进行中',
              projectDesc: '别人的私有项目，可见性测试用', ispub: false,
              createEname: '王五', createempinfosid: 9, enabled: true,
              createTime: '2026-11-03 15:00:00', updateTime: '2026-11-03 15:00:00' }
        ];
        var SEED_FILE = [
            { id: 'pfl-0000-4000-8000-000000000001', projectId: 'prj-0000-4000-8000-000000000001',
              dirId: 'pdr-0000-4000-8000-000000000001',
              projectCode: 'PRO000001', projectName: '九豆综合管理平台研发',
              fileName: '需求规格说明书.docx', filePath: 'data/projectfiles/demo/requirement.docx',
              fileType: '文档', fileSize: 245760, fileDesc: 'V1.0 需求基线', ispub: true,
              uploadEname: '杨伟康', uploadempinfosid: 3, enabled: true,
              uploadTime: '2026-11-01 10:00:00', createTime: '2026-11-01 10:00:00',
              updateTime: '2026-11-01 10:00:00' },
            { id: 'pfl-0000-4000-8000-000000000002', projectId: 'prj-0000-4000-8000-000000000001',
              dirId: 'pdr-0000-4000-8000-000000000002',
              projectCode: 'PRO000001', projectName: '九豆综合管理平台研发',
              fileName: '架构设计.png', filePath: 'data/projectfiles/demo/architecture.png',
              fileType: '图片', fileSize: 512000, fileDesc: '整体架构图', ispub: false,
              uploadEname: '杨伟康', uploadempinfosid: 3, enabled: true,
              uploadTime: '2026-11-01 11:20:00', createTime: '2026-11-01 11:20:00',
              updateTime: '2026-11-01 11:20:00' },
            { id: 'pfl-0000-4000-8000-000000000003', projectId: 'prj-0000-4000-8000-000000000002',
              projectCode: 'PRO000002', projectName: '客户现场实施项目',
              fileName: '实施计划.xlsx', filePath: 'data/projectfiles/demo/plan.xlsx',
              fileType: '表格', fileSize: 38400, fileDesc: '现场实施排期', ispub: true,
              uploadEname: '李明', uploadempinfosid: 2, enabled: true,
              uploadTime: '2026-11-02 15:30:00', createTime: '2026-11-02 15:30:00',
              updateTime: '2026-11-02 15:30:00' }
        ];
        /* 项目目录种子：项目 PRO000001 下两级目录 + 一条他人私有目录（可见性用） */
        var SEED_DIR = [
            { id: 'pdr-0000-4000-8000-000000000001', projectId: 'prj-0000-4000-8000-000000000001',
              parentId: '', dirName: '需求文档', dirDesc: '需求基线与评审材料', ispub: true,
              createEname: '杨伟康', createempinfosid: 3, enabled: true,
              createTime: '2026-11-01 09:30:00', updateTime: '2026-11-01 09:30:00' },
            { id: 'pdr-0000-4000-8000-000000000002', projectId: 'prj-0000-4000-8000-000000000001',
              parentId: 'pdr-0000-4000-8000-000000000001', dirName: '架构设计',
              dirDesc: '架构图与设计说明', ispub: true,
              createEname: '杨伟康', createempinfosid: 3, enabled: true,
              createTime: '2026-11-01 09:35:00', updateTime: '2026-11-01 09:35:00' },
            { id: 'pdr-0000-4000-8000-000000000003', projectId: 'prj-0000-4000-8000-000000000001',
              parentId: '', dirName: '评审资料', dirDesc: '外部评审材料', ispub: true,
              createEname: '李明', createempinfosid: 2, enabled: true,
              createTime: '2026-11-02 10:00:00', updateTime: '2026-11-02 10:00:00' },
            { id: 'pdr-0000-4000-8000-000000000004', projectId: 'prj-0000-4000-8000-000000000001',
              parentId: '', dirName: '他人私有目录（不应可见）', dirDesc: '可见性测试用', ispub: false,
              createEname: '王五', createempinfosid: 9, enabled: true,
              createTime: '2026-11-03 15:00:00', updateTime: '2026-11-03 15:00:00' }
        ];
        var memProjects = null, memFiles = null, memDirs = null;   // localStorage 不可用时的内存兜底

        function readDirs() {
            try {
                var raw = window.localStorage.getItem(PROJECTDIR_KEY);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            if (memDirs) { return memDirs; }
            var seed = clone(SEED_DIR);
            writeDirs(seed);
            return seed;
        }
        function writeDirs(list) {
            memDirs = list;
            try { window.localStorage.setItem(PROJECTDIR_KEY, JSON.stringify(list)); } catch (e) { }
        }

        function readProjects() {
            try {
                var raw = window.localStorage.getItem(PROJECT_KEY);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            if (memProjects) { return memProjects; }
            var seed = clone(SEED_PROJECT);
            writeProjects(seed);
            return seed;
        }
        function writeProjects(list) {
            memProjects = list;
            try { window.localStorage.setItem(PROJECT_KEY, JSON.stringify(list)); } catch (e) { }
        }
        function readFiles() {
            try {
                var raw2 = window.localStorage.getItem(PROJECTFILE_KEY);
                if (raw2) { return JSON.parse(raw2); }
            } catch (e) { }
            if (memFiles) { return memFiles; }
            var seed2 = clone(SEED_FILE);
            writeFiles(seed2);
            return seed2;
        }
        function writeFiles(list) {
            memFiles = list;
            try { window.localStorage.setItem(PROJECTFILE_KEY, JSON.stringify(list)); } catch (e) { }
        }
        function findById(rows, id) {
            for (var i = 0; i < rows.length; i++) {
                if (String(rows[i].id) === String(id)) { return rows[i]; }
            }
            return null;
        }
        /** 统一可见性：本人创建 / 上传 OR 公用；me=0 时不过滤 */
        function visible(row, ownerField) {
            var me = mockLoginEmpId();
            if (me <= 0) { return true; }
            return (parseInt(row[ownerField], 10) || 0) === me || mockIsPub(row.ispub);
        }
        function paging(list, params) {
            var pageNum = Math.max(1, parseInt(params.pageNum, 10) || 1);
            var pageSize = Math.min(Math.max(parseInt(params.pageSize, 10) || 10, 1), 200);
            var pages = Math.max(1, Math.ceil(list.length / pageSize));
            pageNum = Math.min(pageNum, pages);
            return { list: list.slice((pageNum - 1) * pageSize, pageNum * pageSize),
                     total: list.length, pageNum: pageNum, pageSize: pageSize, pages: pages };
        }
        function enabledMatch(row, value) {
            if (value === undefined || value === null || String(value) === '') { return true; }
            var want = !(value === 0 || value === '0' || value === false || value === 'false');
            return !!row.enabled === want;
        }
        function ispubMatch(row, value) {
            if (value === undefined || value === null || String(value) === '') { return true; }
            var want = !(value === 0 || value === '0' || value === false || value === 'false');
            return mockIsPub(row.ispub) === want;
        }
        function ok(data) { return { code: 0, message: 'ok', data: data }; }
        function err(message, code) { return { code: code || 500, message: message }; }

        /* ---------------- 展示字段（与后端 _attach 同口径） ---------------- */
        /** 富文本 → 纯文本摘要（列表 title / 预览用，避免把 HTML 标签塞进属性） */
        function mockPlain(html) {
            return String(html || '').replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
                .replace(/<\/(?:p|div|li|h[1-6]|tr)\s*>/gi, '\n')
                .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/\s+/g, ' ').trim().slice(0, 200);
        }
        /** 离线通道保存前也按同一套白名单清洗（浏览器加载了 word-import.js 时生效） */
        function mockRich(html) {
            var wi = window.WordImport;
            return (wi && wi.sanitize) ? wi.sanitize(html) : String(html || '');
        }
        function attachProject(one, files) {
            var out = clone(one);
            out.enabled = !!out.enabled;
            out.ispub = mockIsPub(out.ispub);
            out.ispubText = out.ispub ? '公用' : '私有';
            out.projectType = out.projectType || '其它';
            out.projectStatus = out.projectStatus || '未开始';
            out.projectDesc = out.projectDesc || '';
            out.projectDescText = mockPlain(out.projectDesc);
            out.createEname = out.createEname || '';
            out.createempinfosid = parseInt(out.createempinfosid, 10) || 0;
            out.createTime = out.createTime || '';
            out.updateTime = out.updateTime || out.createTime || '';
            var n = 0;
            for (var i = 0; i < files.length; i++) {
                if (String(files[i].projectId) === String(out.id)) { n++; }
            }
            out.fileCount = n;
            return out;
        }
        function attachFile(one) {
            var out = clone(one);
            out.enabled = !!out.enabled;
            out.ispub = mockIsPub(out.ispub);
            out.ispubText = out.ispub ? '公用' : '私有';
            out.uploadempinfosid = parseInt(out.uploadempinfosid, 10) || 0;
            out.fileName = out.fileName || '';
            out.fileType = out.fileType || '其它';
            out.fileDesc = out.fileDesc || '';
            out.projectName = out.projectName || '';
            out.projectCode = out.projectCode || '';
            out.uploadEname = out.uploadEname || '';
            out.fileSize = parseInt(out.fileSize, 10) || 0;
            out.fileSizeText = mockSizeText(out.fileSize);
            out.downloadUrl = out.filePath ? ('/' + String(out.filePath).replace(/^\/+/, '')) : '';
            out.uploadTime = out.uploadTime || out.createTime || '';
            // 目录归属：空字符串 = 上传时未选择目录，文件直接关联项目
            out.dirId = mockStr(out.dirId);
            out.dirName = '';
            if (out.dirId) {
                var dirs = readDirs();
                for (var di = 0; di < dirs.length; di++) {
                    if (String(dirs[di].id) === String(out.dirId)) {
                        out.dirName = dirs[di].dirName || '';
                        break;
                    }
                }
            }
            return out;
        }
        function statsOf(list, field) {
            var out = {}, i;
            for (i = 0; i < list.length; i++) {
                var k = String(list[i][field] || '');
                out[k] = (out[k] || 0) + 1;
            }
            return out;
        }
        function nextProjectCode(rows) {
            var maxSeq = 0, re = /^PRO(\d{6})$/;
            for (var i = 0; i < rows.length; i++) {
                var m = re.exec(String(rows[i].projectCode || ''));
                if (m) { maxSeq = Math.max(maxSeq, parseInt(m[1], 10)); }
            }
            var seq = maxSeq + 1;
            while (seq <= 999999) {
                var code = 'PRO' + padNum(seq, 6), taken = false;
                for (var j = 0; j < rows.length; j++) {
                    if (String(rows[j].projectCode) === code) { taken = true; break; }
                }
                if (!taken) { return code; }
                seq++;
            }
            return '';
        }
        function projectVisibleList(rows, params) {
            params = params || {};
            var kw = mockStr(params.keyword).toLowerCase(), list = [], i, one;
            for (i = 0; i < rows.length; i++) {
                one = rows[i];
                if (!visible(one, 'createempinfosid')) { continue; }
                if (params.projectType && mockStr(one.projectType) !== mockStr(params.projectType)) { continue; }
                if (params.projectStatus && mockStr(one.projectStatus) !== mockStr(params.projectStatus)) { continue; }
                if (!enabledMatch(one, params.enabled) || !ispubMatch(one, params.ispub)) { continue; }
                if (kw && String([one.projectCode, one.projectName, one.projectDesc, one.createEname]
                    .join(' ')).toLowerCase().indexOf(kw) < 0) { continue; }
                list.push(one);
            }
            list.sort(function (a, b) {
                if (!!a.enabled !== !!b.enabled) { return a.enabled ? -1 : 1; }
                if (String(a.createTime) !== String(b.createTime)) {
                    return String(a.createTime) < String(b.createTime) ? 1 : -1;
                }
                return String(a.projectCode).localeCompare(String(b.projectCode));
            });
            return list;
        }
        function fileVisibleList(files, params) {
            params = params || {};
            var kw = mockStr(params.keyword).toLowerCase(), list = [], i, one;
            for (i = 0; i < files.length; i++) {
                one = files[i];
                if (!visible(one, 'uploadempinfosid')) { continue; }
                if (params.projectId && String(one.projectId) !== String(params.projectId)) { continue; }
                if (params.fileType && mockStr(one.fileType) !== mockStr(params.fileType)) { continue; }
                if (params.dirId === 'root' && mockStr(one.dirId)) { continue; }
                if (params.dirId && params.dirId !== 'root' &&
                    String(one.dirId || '') !== String(params.dirId)) { continue; }
                if (!enabledMatch(one, params.enabled) || !ispubMatch(one, params.ispub)) { continue; }
                if (kw && String([one.fileName, one.fileDesc, one.projectName, one.projectCode,
                    one.uploadEname].join(' ')).toLowerCase().indexOf(kw) < 0) { continue; }
                list.push(one);
            }
            list.sort(function (a, b) {
                if (String(params.orderBy || '').toLowerCase() === 'filename') {
                    // 项目信息页右栏：按文件名升序（与后端 ProjectFileService._order_by 同口径）
                    var an = String(a.fileName || ''), bn = String(b.fileName || '');
                    if (an !== bn) { return an < bn ? -1 : 1; }
                    return String(a.id).localeCompare(String(b.id));
                }
                if (!!a.enabled !== !!b.enabled) { return a.enabled ? -1 : 1; }
                if (String(a.uploadTime) !== String(b.uploadTime)) {
                    return String(a.uploadTime) < String(b.uploadTime) ? 1 : -1;
                }
                return String(a.id).localeCompare(String(b.id));
            });
            return list;
        }

        /* ================= project（项目信息） ================= */
        function projectRoute(method, path, params) {
            params = params || {};
            var rows = readProjects(), files = readFiles(), i, one, list, pg;
            if (path === '/types') {
                var mt = mockProjectTypes();
                return ok({ types: mt.values, statuses: PROJECT_STATUSES.slice(),
                            typeSource: mt.source, typeDictNameEn: PROJECT_TYPE_DICT });
            }
            if (path === '/nextcode') {
                var code = nextProjectCode(rows);
                return code ? ok({ code: code }) : err('项目编号已超出上限（PRO999999）');
            }
            /* Word 导入由 Api.project.importDoc 走本地解析（异步 Promise），
               离线通道不会再落到这个同步路由；这里只保留明确的兜底提示。 */
            if (path === '/importdoc') {
                return err('离线通道需要浏览器支持本地解析 docx，请升级浏览器或连接服务端');
            }
            if (path === '/list') {
                list = projectVisibleList(rows, params);
                pg = paging(list, params);
                var items = [];
                for (i = 0; i < pg.list.length; i++) { items.push(attachProject(pg.list[i], files)); }
                return ok({ list: items, total: pg.total, pageNum: pg.pageNum,
                            pageSize: pg.pageSize, pages: pg.pages,
                            stats: statsOf(list, 'projectType') });
            }
            if (path === '/detail') {
                one = findById(rows, params.id);
                if (!one || !visible(one, 'createempinfosid')) { return err('项目不存在或已被删除', 404); }
                return ok(attachProject(one, files));
            }
            if (path === '/check') {
                var field = mockStr(params.field) || 'projectName';
                if (field !== 'projectName' && field !== 'projectCode') {
                    return err('不支持的唯一性校验字段：' + field);
                }
                var value = mockStr(params.value);
                if (!value) { return ok({ unique: true }); }
                var dup = false;
                for (i = 0; i < rows.length; i++) {
                    if (mockStr(rows[i][field]) === value &&
                        String(rows[i].id) !== String(params.id || '')) { dup = true; }
                }
                return ok({ unique: !dup });
            }
            if (path === '/options') {
                list = projectVisibleList(rows, { keyword: params.keyword, enabled: 1 });
                var opts = [];
                for (i = 0; i < list.length && i < 200; i++) {
                    opts.push({ id: list[i].id, projectCode: list[i].projectCode,
                                projectName: list[i].projectName, projectType: list[i].projectType,
                                ispub: mockIsPub(list[i].ispub),
                                label: list[i].projectCode + ' ' + list[i].projectName });
                }
                return ok({ list: opts });
            }
            if (path === '/add' || path === '/update') {
                var name = mockStr(params.projectName);
                if (!name) { return err('项目名称不能为空'); }
                var isEdit = path === '/update';
                var target = isEdit ? findById(rows, params.id) : null;
                if (isEdit && !target) { return err('项目不存在或已被删除', 404); }
                var ptype = mockStr(params.projectType) || '其它';
                /* 合法值 = 字典启用项；再并入该记录原有类型，字典调整后老项目仍可原样保存 */
                var allowedTypes = mockProjectTypes().values;
                var legacyType = isEdit ? mockStr(target.projectType) : '';
                if (legacyType && allowedTypes.indexOf(legacyType) < 0) {
                    allowedTypes = allowedTypes.concat([legacyType]);
                }
                if (allowedTypes.indexOf(ptype) < 0) { return err('不支持的项目类型：' + ptype); }
                var status = mockStr(params.projectStatus) || '未开始';
                if (PROJECT_STATUSES.indexOf(status) < 0) { return err('不支持的项目状态：' + status); }
                for (i = 0; i < rows.length; i++) {
                    if (mockStr(rows[i].projectName) === name &&
                        String(rows[i].id) !== String(params.id || '')) {
                        return err('项目名称【' + name + '】已存在，请换一个');
                    }
                }
                var t = now(), me = mockLoginEmpId();
                if (isEdit) {
                    target.projectName = name;
                    target.projectType = ptype;
                    target.projectStatus = status;
                    if (params.projectDesc !== undefined) { target.projectDesc = mockRich(params.projectDesc); }
                    if (params.ispub !== undefined) { target.ispub = mockIsPub(params.ispub); }
                    if (params.enabled !== undefined) { target.enabled = mockBool(params.enabled, true); }
                    target.updateTime = t;
                    writeProjects(rows);
                    return ok(attachProject(target, files));
                }
                var newCode = nextProjectCode(rows);
                if (!newCode) { return err('项目编号已超出上限（PRO999999）'); }
                one = {
                    id: mockUuid(), projectCode: newCode, projectName: name,
                    projectType: ptype, projectStatus: status,
                    projectDesc: mockRich(params.projectDesc),
                    ispub: params.ispub === undefined ? true : mockIsPub(params.ispub),
                    enabled: params.enabled === undefined ? true : mockBool(params.enabled, true),
                    createEname: '', createempinfosid: me,
                    createTime: t, updateTime: t
                };
                rows.push(one);
                writeProjects(rows);
                return ok(attachProject(one, files));
            }
            if (path === '/delete') {
                one = findById(rows, params.id);
                if (!one) { return err('项目不存在或已被删除', 404); }
                var left = [], leftFiles = [], leftDirs = [], removed = 0, removedDirs = 0;
                for (i = 0; i < rows.length; i++) {
                    if (String(rows[i].id) !== String(params.id)) { left.push(rows[i]); }
                }
                for (i = 0; i < files.length; i++) {
                    if (String(files[i].projectId) !== String(params.id)) { leftFiles.push(files[i]); }
                    else { removed++; }
                }
                var dirs = readDirs();
                for (i = 0; i < dirs.length; i++) {
                    if (String(dirs[i].projectId) !== String(params.id)) { leftDirs.push(dirs[i]); }
                    else { removedDirs++; }
                }
                writeProjects(left);
                writeFiles(leftFiles);
                writeDirs(leftDirs);
                var out = attachProject(one, files);
                out.deletedFiles = removed;
                out.deletedDirs = removedDirs;
                out.message = '项目「' + one.projectName + '」已删除（同时清理 ' +
                    removedDirs + ' 个目录、' + removed + ' 个文件）';
                return ok(out);
            }
            if (path === '/enabled') {
                one = findById(rows, params.id);
                if (!one) { return err('项目不存在或已被删除', 404); }
                one.enabled = mockBool(params.enabled, true);
                writeProjects(rows);
                var out2 = attachProject(one, files);
                out2.message = '项目「' + one.projectName + '」已' + (one.enabled ? '启用' : '停用');
                return ok(out2);
            }
            return { code: 404, message: '接口不存在：/project' + path };
        }

        /* ================= projectfile（项目文件） ================= */
        function fileRoute(method, path, params) {
            params = params || {};
            var rows = readFiles(), projects = readProjects(), i, one, list, pg;
            if (path === '/types') { return ok({ types: PROJECT_FILE_TYPES.slice() }); }
            if (path === '/list') {
                list = fileVisibleList(rows, params);
                pg = paging(list, params);
                var items = [];
                for (i = 0; i < pg.list.length; i++) { items.push(attachFile(pg.list[i])); }
                return ok({ list: items, total: pg.total, pageNum: pg.pageNum,
                            pageSize: pg.pageSize, pages: pg.pages,
                            stats: statsOf(list, 'fileType') });
            }
            if (path === '/detail' || path === '/download') {
                one = findById(rows, params.id);
                if (!one || !visible(one, 'uploadempinfosid')) { return err('项目文件不存在或已被删除', 404); }
                if (path === '/download' && !one.enabled) {
                    return err('文件「' + one.fileName + '」已停用，不能下载');
                }
                var out = attachFile(one);
                if (path === '/download') { out.message = '文件「' + one.fileName + '」可以下载'; }
                return ok(out);
            }
            if (path === '/check') { return ok({ unique: true }); }
            if (path === '/upload' || path === '/add' || path === '/update') {
                var isEdit = path === '/update';
                var target = isEdit ? findById(rows, params.id) : null;
                if (isEdit && !target) { return err('项目文件不存在或已被删除', 404); }
                var hasNew = !!params.data;
                if (!isEdit && !hasNew) { return err('请选择要上传的文件'); }
                var fileName = mockStr(params.fileName) || (target ? target.fileName : '');
                if (!fileName) { return err('文件名不能为空，请重新选择文件'); }
                fileName = fileName.replace(/\\/g, '/').split('/').pop();
                var projectId = mockStr(params.projectId) || (target ? target.projectId : '');
                var project = findById(projects, projectId);
                if (!project || !visible(project, 'createempinfosid')) {
                    return err('所属项目不存在、或不是你创建 / 标为公用的项目', 404);
                }
                // 目录归属：未传则沿用原值；空字符串 = 不选择目录，文件直接关联项目
                var dirId = params.dirId === undefined
                    ? (target ? mockStr(target.dirId) : '') : mockStr(params.dirId);
                if (dirId) {
                    var dirHit = findById(readDirs(), dirId);
                    if (!dirHit || !visible(dirHit, 'createempinfosid') ||
                        String(dirHit.projectId) !== String(project.id)) {
                        return err('所属目录不存在或不属于该项目', 404);
                    }
                }
                var ftype = mockStr(params.fileType) || (target ? target.fileType : '') || '其它';
                if (PROJECT_FILE_TYPES.indexOf(ftype) < 0) { return err('不支持的文件类型：' + ftype); }
                var t2 = now();
                if (isEdit) {
                    target.projectId = project.id;
                    target.dirId = dirId;
                    target.projectCode = project.projectCode;
                    target.projectName = project.projectName;
                    target.fileType = ftype;
                    target.fileDesc = params.fileDesc === undefined ? target.fileDesc : mockStr(params.fileDesc);
                    if (params.ispub !== undefined) { target.ispub = mockIsPub(params.ispub); }
                    if (params.enabled !== undefined) { target.enabled = mockBool(params.enabled, true); }
                    if (hasNew) {
                        target.fileName = fileName;
                        var raw = String(params.data || '');
                        if (raw.indexOf(';base64,') >= 0) { raw = raw.split(';base64,')[1]; }
                        target.fileSize = parseInt(params.fileSize, 10) ||
                            Math.round(raw.replace(/\s/g, '').length * 3 / 4);
                        target.filePath = makePath(fileName);
                    }
                    target.updateTime = t2;
                    writeFiles(rows);
                    return ok(attachFile(target));
                }
                var raw2 = String(params.data || '');
                if (raw2.indexOf(';base64,') >= 0) { raw2 = raw2.split(';base64,')[1]; }
                var rawSize = parseInt(params.fileSize, 10) ||
                    Math.round(raw2.replace(/\s/g, '').length * 3 / 4);
                one = {
                    id: mockUuid(), projectId: project.id, dirId: dirId,
                    projectCode: project.projectCode, projectName: project.projectName,
                    fileType: ftype, fileName: fileName, filePath: makePath(fileName),
                    fileSize: rawSize, fileDesc: mockStr(params.fileDesc),
                    ispub: params.ispub === undefined ? true : mockIsPub(params.ispub),
                    enabled: params.enabled === undefined ? true : mockBool(params.enabled, true),
                    uploadEname: '', uploadempinfosid: mockLoginEmpId(),
                    uploadTime: t2, createTime: t2, updateTime: t2
                };
                rows.push(one);
                writeFiles(rows);
                return ok(attachFile(one));
            }
            if (path === '/delete') {
                one = findById(rows, params.id);
                if (!one) { return err('项目文件不存在或已被删除', 404); }
                var left = [];
                for (i = 0; i < rows.length; i++) {
                    if (String(rows[i].id) !== String(params.id)) { left.push(rows[i]); }
                }
                writeFiles(left);
                var out3 = attachFile(one);
                out3.message = '文件「' + one.fileName + '」已删除';
                return ok(out3);
            }
            if (path === '/enabled') {
                one = findById(rows, params.id);
                if (!one) { return err('项目文件不存在或已被删除', 404); }
                one.enabled = mockBool(params.enabled, true);
                writeFiles(rows);
                var out4 = attachFile(one);
                out4.message = '项目文件「' + one.fileName + '」已' + (one.enabled ? '启用' : '停用');
                return ok(out4);
            }
            return { code: 404, message: '接口不存在：/projectfile' + path };
        }
        /* ================= projectdir（项目目录 / 多级文件夹） ================= */
        function dirChildrenCount(rows, id) {
            var n = 0;
            for (var i = 0; i < rows.length; i++) {
                if (mockStr(rows[i].parentId) === String(id)) { n++; }
            }
            return n;
        }
        function dirFileCount(files, id) {
            var n = 0;
            for (var i = 0; i < files.length; i++) {
                if (mockStr(files[i].dirId) === String(id)) { n++; }
            }
            return n;
        }
        function attachDir(one, rows, files) {
            var out = clone(one), i;
            out.enabled = !!out.enabled;
            out.ispub = mockIsPub(out.ispub);
            out.ispubText = out.ispub ? '公用' : '私有';
            out.parentId = mockStr(out.parentId);
            out.dirName = out.dirName || '';
            out.dirDesc = out.dirDesc || '';
            out.createEname = out.createEname || '';
            out.createempinfosid = parseInt(out.createempinfosid, 10) || 0;
            out.createTime = out.createTime || '';
            out.updateTime = out.updateTime || out.createTime || '';
            var pmap = {};
            for (i = 0; i < rows.length; i++) { pmap[String(rows[i].id)] = rows[i]; }
            out.parentName = pmap[out.parentId] ? (pmap[out.parentId].dirName || '') : '';
            var level = 1, cur = out.parentId, guard = 0;
            while (cur && pmap[cur] && guard < 10) {
                level++; cur = mockStr(pmap[cur].parentId); guard++;
            }
            out.level = level;
            out.childCount = dirChildrenCount(rows, out.id);
            out.fileCount = dirFileCount(files, out.id);
            return out;
        }
        function dirVisibleList(rows, params) {
            params = params || {};
            var kw = mockStr(params.keyword).toLowerCase(), list = [], i, one;
            for (i = 0; i < rows.length; i++) {
                one = rows[i];
                if (!visible(one, 'createempinfosid')) { continue; }
                if (params.projectId && String(one.projectId) !== String(params.projectId)) { continue; }
                if (params.parentId === 'root' && mockStr(one.parentId)) { continue; }
                if (params.parentId && params.parentId !== 'root' &&
                    mockStr(one.parentId) !== String(params.parentId)) { continue; }
                if (!enabledMatch(one, params.enabled) || !ispubMatch(one, params.ispub)) { continue; }
                if (kw && String([one.dirName, one.dirDesc].join(' ')).toLowerCase().indexOf(kw) < 0) { continue; }
                list.push(one);
            }
            list.sort(function (a, b) {
                var an = String(a.dirName || ''), bn = String(b.dirName || '');
                if (an !== bn) { return an < bn ? -1 : 1; }
                return String(a.id).localeCompare(String(b.id));
            });
            return list;
        }
        function dirDescendants(rows, rootId) {
            var banned = {}, stack = [String(rootId)];
            while (stack.length) {
                var cur = stack.pop();
                for (var i = 0; i < rows.length; i++) {
                    var uid = String(rows[i].id);
                    if (mockStr(rows[i].parentId) === cur && !banned[uid]) {
                        banned[uid] = 1; stack.push(uid);
                    }
                }
            }
            return banned;
        }
        function dirRoute(method, path, params) {
            params = params || {};
            var rows = readDirs(), files = readFiles(), projects = readProjects();
            var i, one, list, pg, items;
            if (path === '/list') {
                list = dirVisibleList(rows, params);
                pg = paging(list, params);
                items = [];
                for (i = 0; i < pg.list.length; i++) { items.push(attachDir(pg.list[i], rows, files)); }
                return ok({ list: items, total: pg.total, pageNum: pg.pageNum,
                            pageSize: pg.pageSize, pages: pg.pages });
            }
            if (path === '/detail') {
                one = findById(rows, params.id);
                if (!one || !visible(one, 'createempinfosid')) { return err('项目目录不存在或已被删除', 404); }
                return ok(attachDir(one, rows, files));
            }
            if (path === '/tree') {
                var projectId = mockStr(params.projectId);
                if (!projectId) { return err('参数 projectId 不能为空'); }
                var project = findById(projects, projectId);
                if (!project || !visible(project, 'createempinfosid')) {
                    return err('所属项目不存在、或不是你创建 / 标为公用的项目', 404);
                }
                list = dirVisibleList(rows, { projectId: projectId });
                var pmap = {}, children = {}, banned = {};
                for (i = 0; i < list.length; i++) { pmap[String(list[i].id)] = list[i]; }
                var exclude = mockStr(params.excludeId);
                if (exclude) { banned = dirDescendants(list, exclude); banned[exclude] = 1; }
                for (i = 0; i < list.length; i++) {
                    var key = mockStr(list[i].parentId);
                    if (!children[key]) { children[key] = []; }
                    children[key].push(list[i]);
                }
                var out = [], seen = {};
                function walk(node, level) {
                    var uid = String(node.id);
                    if (seen[uid] || banned[uid]) { return; }
                    seen[uid] = 1;
                    var it = attachDir(node, list, files);
                    it.label = new Array(level).join('　') +
                        (level > 1 ? '└ ' : '') + it.dirName;
                    it.leaf = !children[uid] || !children[uid].length;
                    out.push(it);
                    var kids = children[uid] || [];
                    for (var k = 0; k < kids.length; k++) { walk(kids[k], level + 1); }
                }
                for (i = 0; i < list.length; i++) {
                    if (!pmap[mockStr(list[i].parentId)]) { walk(list[i], 1); }
                }
                for (i = 0; i < list.length; i++) {
                    if (!seen[String(list[i].id)]) { walk(list[i], 1); }
                }
                return ok({ list: out, total: out.length, projectId: projectId });
            }
            if (path === '/add' || path === '/update') {
                var isEdit = path === '/update';
                var target = isEdit ? findById(rows, params.id) : null;
                if (isEdit && !target) { return err('项目目录不存在或已被删除', 404); }
                var pid = mockStr(params.projectId) || (target ? mockStr(target.projectId) : '');
                var proj = findById(projects, pid);
                if (!proj || !visible(proj, 'createempinfosid')) {
                    return err('所属项目不存在、或不是你创建 / 标为公用的项目', 404);
                }
                var name = mockStr(params.dirName) || (target ? mockStr(target.dirName) : '');
                if (!name) { return err('目录名不能为空'); }
                if (name.length > 150) { return err('目录名最多 150 个字符'); }
                var parent = params.parentId === undefined
                    ? (target ? mockStr(target.parentId) : '') : mockStr(params.parentId);
                var selfId = target ? String(target.id) : '';
                if (parent) {
                    if (parent === selfId) { return err('上级目录不能是自己'); }
                    var parentRow = findById(rows, parent);
                    if (!parentRow || mockStr(parentRow.projectId) !== String(proj.id)) {
                        return err('上级目录不存在或已被删除', 404);
                    }
                    if (selfId) {
                        var banned2 = dirDescendants(rows, selfId);
                        if (banned2[parent]) { return err('上级目录不能是自己的子目录'); }
                    }
                    var depth = 1, cur = parent, guard = 0;
                    while (cur && guard < 10) {
                        var curRow = findById(rows, cur);
                        if (!curRow) { break; }
                        depth++; cur = mockStr(curRow.parentId); guard++;
                    }
                    if (depth >= 8) { return err('目录层级不能超过 8 层'); }
                }
                for (i = 0; i < rows.length; i++) {
                    var r = rows[i];
                    if (String(r.id) === selfId) { continue; }
                    if (mockStr(r.projectId) === String(proj.id) && mockStr(r.dirName) === name &&
                        mockStr(r.parentId) === parent) {
                        return err('同级下已存在目录【' + name + '】');
                    }
                }
                var t3 = now();
                if (isEdit) {
                    target.projectId = proj.id;
                    target.parentId = parent;
                    target.dirName = name;
                    target.dirDesc = params.dirDesc === undefined
                        ? mockStr(target.dirDesc) : mockStr(params.dirDesc).slice(0, 500);
                    if (params.ispub !== undefined) { target.ispub = mockIsPub(params.ispub); }
                    if (params.enabled !== undefined) { target.enabled = mockBool(params.enabled, true); }
                    target.updateTime = t3;
                    writeDirs(rows);
                    return ok(attachDir(target, rows, files));
                }
                one = {
                    id: mockUuid(), projectId: proj.id, parentId: parent,
                    dirName: name, dirDesc: mockStr(params.dirDesc).slice(0, 500),
                    ispub: params.ispub === undefined ? true : mockIsPub(params.ispub),
                    enabled: params.enabled === undefined ? true : mockBool(params.enabled, true),
                    createEname: '', createempinfosid: mockLoginEmpId(),
                    createTime: t3, updateTime: t3
                };
                rows.push(one);
                writeDirs(rows);
                return ok(attachDir(one, rows, files));
            }
            if (path === '/delete') {
                one = findById(rows, params.id);
                if (!one) { return err('项目目录不存在或已被删除', 404); }
                var parent2 = mockStr(one.parentId), movedDirs = 0, movedFiles = 0;
                for (i = 0; i < rows.length; i++) {
                    if (mockStr(rows[i].parentId) === String(one.id)) {
                        rows[i].parentId = parent2; movedDirs++;
                    }
                }
                for (i = 0; i < files.length; i++) {
                    if (mockStr(files[i].dirId) === String(one.id)) {
                        files[i].dirId = ''; movedFiles++;
                    }
                }
                var left = [];
                for (i = 0; i < rows.length; i++) {
                    if (String(rows[i].id) !== String(one.id)) { left.push(rows[i]); }
                }
                writeDirs(left); writeFiles(files);
                var out3 = attachDir(one, rows, files);
                out3.movedDirs = movedDirs;
                out3.movedFiles = movedFiles;
                out3.message = '目录「' + one.dirName + '」已删除（' + movedDirs +
                    ' 个子目录上移、' + movedFiles + ' 个文件回到项目根）';
                return ok(out3);
            }
            if (path === '/enabled') {
                one = findById(rows, params.id);
                if (!one) { return err('项目目录不存在或已被删除', 404); }
                one.enabled = mockBool(params.enabled, true);
                writeDirs(rows);
                var out4 = attachDir(one, rows, files);
                out4.message = '目录「' + one.dirName + '」已' + (one.enabled ? '启用' : '停用');
                return ok(out4);
            }
            if (path === '/check') { return ok({ unique: true }); }
            return { code: 404, message: '接口不存在：/projectdir' + path };
        }

        function makePath(fileName) {
            var ext = String(fileName).split('.').length > 1
                ? String(fileName).split('.').pop().toLowerCase().replace(/[^0-9a-z]/g, '').slice(0, 10) : '';
            var d = new Date(), mm = pad(d.getMonth() + 1);
            return 'data/projectfiles/' + d.getFullYear() + mm + '/' + mockUuid() + (ext ? '.' + ext : '');
        }

        return {
            project: { route: projectRoute, raw: readProjects },
            projectdir: { route: dirRoute, raw: readDirs },
            projectfile: { route: fileRoute, raw: readFiles }
        };
    }

    /* ==========================================================================
       工作计划（Visio 风格甘特图 / 时间线）模拟服务
       --------------------------------------------------------------------------
       · 与后端 WorkPlanService 同口径：list / detail / nextcode / add / update /
         delete / save（整图保存：plan + tasks[] 全量替换）；
       · 可见性：本人创建 OR ispub=1（me=0 时不过滤），与项目模块一致；
       · 校验：计划名 / 任务名 / 任务类型 / 日期 / 完成百分比 / 依赖环 / 父子环，
         时间刻度范围自动延伸到任务边界。
       ========================================================================== */
    function createWorkPlanMockService() {
        var PLAN_KEY = 'menu_admin_workplans_v1';
        var TASK_KEY = 'menu_admin_workplantasks_v1';
        var ORDER_KEY = 'menu_admin_workplanorders_v1';
        var EXEC_KEY = 'menu_admin_workplanexecs_v1';
        var LOG_KEY = 'menu_admin_workplanchangelogs_v1';
        var MEMBER_KEY = 'menu_admin_workplanmembers_v1';
        var EXEC_STATUSES = ['未开始', '进行中', '已完成', '已延期', '已取消'];
        var ORDER_STATUSES = ['待处理', '处理中', '已完成'];
        var memPlans = null, memTasks = null, memOrders = null, memMembers = null;
        var memExecs = null, memLogs = null;
        function readJSON(key, fallback) {
            try {
                var raw = window.localStorage.getItem(key);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            return clone(fallback);
        }
        function writeJSON(key, value) {
            try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { }
        }
        function mockNow() {
            var d = new Date();
            function p2(n) { return ('0' + n).slice(-2); }
            return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
                p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
        }
        function isCreator(plan) {
            var me = mockLoginEmpId(), c = parseInt(plan.createempinfosid, 10) || 0;
            return !me || !c || me === c;
        }
        function readExecs() {
            if (!memExecs) { memExecs = readJSON(EXEC_KEY, []); }
            return memExecs;
        }
        function writeExecs(list) { memExecs = list; writeJSON(EXEC_KEY, list); }
        function readLogs() {
            if (!memLogs) { memLogs = readJSON(LOG_KEY, []); }
            return memLogs;
        }
        function writeLogs(list) { memLogs = list; writeJSON(LOG_KEY, list); }
        function mockUuid() {
            return 'ex-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        }
        function execCountOf(taskId) {
            var n = 0, list = readExecs(), i;
            for (i = 0; i < list.length; i++) { if (list[i].taskId === taskId) { n++; } }
            return n;
        }
        function changeCountOf(taskId) {
            var n = 0, list = readLogs(), i;
            for (i = 0; i < list.length; i++) { if (list[i].taskId === taskId) { n++; } }
            return n;
        }
        function logOf(planId, taskId, taskName, action, summary, detail) {
            var logs = readLogs();
            logs.push({ id: mockUuid(), planId: planId, taskId: taskId || '',
                        taskName: taskName || '', action: action, summary: summary,
                        detail: detail || '', operatorId: mockLoginEmpId(), operatorName: '我',
                        createTime: mockNow() });
            writeLogs(logs);
        }
        var P1 = 'wpl-0000-4000-8000-000000000001';
        var P2 = 'wpl-0000-4000-8000-000000000002';
        var P3 = 'wpl-0000-4000-8000-000000000003';
        var T1 = 'wpt-0000-4000-8000-000000000001';
        var T2 = 'wpt-0000-4000-8000-000000000002';
        var T3 = 'wpt-0000-4000-8000-000000000003';
        var T4 = 'wpt-0000-4000-8000-000000000004';
        var T5 = 'wpt-0000-4000-8000-000000000005';
        var T6 = 'wpt-0000-4000-8000-000000000006';
        var T7 = 'wpt-0000-4000-8000-000000000007';
        var SEED_PLANS = [
            { id: P1, planCode: 'WP000001', planName: '四季度产品迭代工作计划',
              projectId: 'prj-0000-4000-8000-000000000001', projectName: '九豆综合管理平台研发',
              startDate: '2026-10-01', endDate: '2026-12-31',
              planDesc: 'Visio 风格示例：摘要任务 / 普通任务 / 里程碑 / 前置依赖 / 完成百分比。',
              scale: 'week', skipWeekend: 1, ispub: 1, enabled: 1,
              createEname: '杨伟康', createempinfosid: 3,
              createTime: '2026-11-01 09:00:00', updateTime: '2026-11-01 09:00:00' },
            { id: P2, planCode: 'WP000002', planName: '客户现场实施排期',
              projectId: 'prj-0000-4000-8000-000000000002', projectName: '客户现场实施项目',
              startDate: '2026-11-10', endDate: '2026-12-20', planDesc: '实施阶段工作安排',
              scale: 'day', skipWeekend: 0, ispub: 1, enabled: 1,
              createEname: '李明', createempinfosid: 2,
              createTime: '2026-11-02 10:20:00', updateTime: '2026-11-02 10:20:00' },
            { id: P3, planCode: 'WP000003', planName: '他人私有计划（不应可见）',
              projectId: '', projectName: '', startDate: '2026-11-01', endDate: '2026-11-30',
              planDesc: '可见性测试用', scale: 'day', skipWeekend: 0, ispub: 0, enabled: 1,
              createEname: '王五', createempinfosid: 9,
              createTime: '2026-11-03 15:00:00', updateTime: '2026-11-03 15:00:00' }
        ];
        var SEED_TASKS = [
            { id: T1, planId: P1, taskName: '一、需求与设计', taskType: 'summary', parentId: '',
              startDate: '2026-10-01', endDate: '2026-10-25', progress: 90, preTaskIds: '',
              ownerName: '杨伟康', sortNo: 0, color: '', createTime: '2026-11-01 09:00:00', updateTime: '' },
            { id: T2, planId: P1, taskName: '需求调研', taskType: 'task', parentId: T1,
              startDate: '2026-10-01', endDate: '2026-10-15', progress: 100, preTaskIds: '',
              ownerName: '杨伟康', ownerId: 3, participantIds: '2,3', participantNames: '李明,杨伟康',
              sortNo: 1, color: '', createTime: '2026-11-01 09:00:00', updateTime: '' },
            { id: T3, planId: P1, taskName: '原型设计与评审', taskType: 'task', parentId: T1,
              startDate: '2026-10-16', endDate: '2026-10-25', progress: 80, preTaskIds: T2,
              ownerName: '李明', ownerId: 2, participantIds: '3', participantNames: '杨伟康',
              sortNo: 2, color: '', createTime: '2026-11-01 09:00:00', updateTime: '' },
            { id: T4, planId: P1, taskName: '需求基线确认', taskType: 'milestone', parentId: '',
              startDate: '2026-10-25', endDate: '2026-10-25', progress: 100, preTaskIds: T3,
              ownerName: '杨伟康', sortNo: 3, color: '', createTime: '2026-11-01 09:00:00', updateTime: '' },
            { id: T5, planId: P1, taskName: '迭代开发', taskType: 'task', parentId: '',
              startDate: '2026-10-26', endDate: '2026-12-10', progress: 35, preTaskIds: T4,
              ownerName: '张三', sortNo: 4, color: '', createTime: '2026-11-01 09:00:00', updateTime: '' },
            { id: T6, planId: P1, taskName: '版本发布', taskType: 'milestone', parentId: '',
              startDate: '2026-12-20', endDate: '2026-12-20', progress: 0, preTaskIds: T5,
              ownerName: '杨伟康', sortNo: 5, color: '', createTime: '2026-11-01 09:00:00', updateTime: '' },
            { id: T7, planId: P1, taskName: '验收与培训', taskType: 'task', parentId: '',
              startDate: '2026-12-21', endDate: '2026-12-30', progress: 0, preTaskIds: T6,
              ownerName: '李明', sortNo: 6, color: '', createTime: '2026-11-01 09:00:00', updateTime: '' },
            { id: 'wpt-0000-4000-8000-000000000008', planId: P2, taskName: '环境准备', taskType: 'task',
              parentId: '', startDate: '2026-11-10', endDate: '2026-11-20', progress: 100,
              preTaskIds: '', ownerName: '李明', sortNo: 0, color: '',
              createTime: '2026-11-02 10:20:00', updateTime: '' },
            { id: 'wpt-0000-4000-8000-000000000009', planId: P2, taskName: '上线切换', taskType: 'milestone',
              parentId: '', startDate: '2026-12-20', endDate: '2026-12-20', progress: 0,
              preTaskIds: 'wpt-0000-4000-8000-000000000008', ownerName: '李明', sortNo: 1,
              color: '', createTime: '2026-11-02 10:20:00', updateTime: '' }
        ];

        function ok(data) { return { code: 0, message: 'ok', data: data }; }
        function err(message, code) { return { code: code || 500, message: message }; }
        function readPlans() {
            try {
                var raw = window.localStorage.getItem(PLAN_KEY);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            if (memPlans) { return memPlans; }
            var seed = clone(SEED_PLANS); writePlans(seed); return seed;
        }
        function writePlans(list) {
            memPlans = list;
            try { window.localStorage.setItem(PLAN_KEY, JSON.stringify(list)); } catch (e) { }
        }
        function readTasks() {
            try {
                var raw = window.localStorage.getItem(TASK_KEY);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            if (memTasks) { return memTasks; }
            var seed = clone(SEED_TASKS); writeTasks(seed); return seed;
        }
        function writeTasks(list) {
            memTasks = list;
            try { window.localStorage.setItem(TASK_KEY, JSON.stringify(list)); } catch (e) { }
        }
        function readOrders() {
            try {
                var raw = window.localStorage.getItem(ORDER_KEY);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            if (memOrders) { return memOrders; }
            writeOrders([]); return [];
        }
        function writeOrders(list) {
            memOrders = list;
            try { window.localStorage.setItem(ORDER_KEY, JSON.stringify(list)); } catch (e) { }
        }
        /* Mock 的项目组成员：项目ID → 员工ID 数组；种子与项目示例数据对齐 */
        function readMembers() {
            try {
                var raw = window.localStorage.getItem(MEMBER_KEY);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            if (memMembers) { return memMembers; }
            var seed = {};
            seed['prj-0000-4000-8000-000000000001'] = [1, 2, 3, 4];
            seed['prj-0000-4000-8000-000000000002'] = [2, 5];
            writeMembers(seed); return seed;
        }
        function writeMembers(map) {
            memMembers = map;
            try { window.localStorage.setItem(MEMBER_KEY, JSON.stringify(map)); } catch (e) { }
        }
        function projectAllowed(projectId) {
            var pid = mockStr(projectId);
            if (!pid) { return false; }
            var projects = (projectMocks && projectMocks.project && projectMocks.project.raw)
                ? projectMocks.project.raw() : [];
            var project = byId(projects, pid);
            if (!project) { return false; }
            var me = mockLoginEmpId();
            var members = readMembers()[pid] || [];
            return parseInt(project.createempinfosid, 10) === me ||
                members.indexOf(me) >= 0 ||
                parseInt(project.ispub, 10) !== 0;
        }

        /* 选人用的员工 / 组织数据：直接调同域的 Mock 服务，字段与真后端一致 */
        function empRows() {
            var res = empSvc.route('GET', '/list', { pageNum: 1, pageSize: 1000 });
            return (res && res.data && res.data.list) || [];
        }
        function orgRows() {
            var res = orgSvc.route('GET', '/tree', {});
            return (res && res.data && res.data.list) || [];
        }
        function personOf(e, fromGroup) {
            return {
                id: parseInt(e.id, 10) || 0,
                nameCn: mockStr(e.nameCn || e.name), name: mockStr(e.nameCn || e.name),
                code: mockStr(e.code), deptId: parseInt(e.deptId, 10) || 0,
                deptName: mockStr(e.deptName) || '—（未分配）',
                jobTitle: mockStr(e.jobTitle), email: mockStr(e.email),
                status: e.status === undefined ? 1 : (parseInt(e.status, 10) || 0),
                statusText: mockStr(e.statusText), fromGroup: !!fromGroup
            };
        }
        function nextOrderSeq(orders) {
            var n = 0, i, c;
            for (i = 0; i < orders.length; i++) {
                c = String(orders[i].orderCode || '');
                if (/^WO\d{6}$/.test(c)) { n = Math.max(n, parseInt(c.slice(2), 10) || 0); }
            }
            return n;
        }
        function byId(list, id) {
            for (var i = 0; i < list.length; i++) { if (String(list[i].id) === String(id)) { return list[i]; } }
            return null;
        }
        function visible(row) {
            var me = mockLoginEmpId();
            if (me <= 0) { return true; }
            return (parseInt(row.createempinfosid, 10) || 0) === me || mockIsPub(row.ispub);
        }
        function tasksOf(planId) {
            var out = [], all = readTasks();
            for (var i = 0; i < all.length; i++) { if (all[i].planId === planId) { out.push(clone(all[i])); } }
            out.sort(function (a, b) { return (a.sortNo || 0) - (b.sortNo || 0); });
            return out;
        }
        function attach(one) {
            var out = clone(one), ts = tasksOf(one.id), sum = 0;
            for (var i = 0; i < ts.length; i++) { sum += parseInt(ts[i].progress, 10) || 0; }
            out.taskCount = ts.length;
            out.progress = ts.length ? Math.round(sum / ts.length) : 0;
            out.ispub = mockIsPub(out.ispub);
            out.enabled = mockBool(out.enabled, true);
            out.skipWeekend = parseInt(out.skipWeekend, 10) || 0;
            /* 启动状态：老数据没跑过 start 时按「未启动」显示，与后端 DDL 默认值一致 */
            out.status = mockStr(one.status) || '未启动';
            out.startTime = mockStr(one.startTime);
            out.startEname = mockStr(one.startEname);
            return out;
        }
        function nextCode() {
            var max = 0, all = readPlans();
            for (var i = 0; i < all.length; i++) {
                var m = /^WP(\d{6})$/.exec(String(all[i].planCode || ''));
                if (m) { max = Math.max(max, parseInt(m[1], 10)); }
            }
            while (max < 999999) {
                max += 1;
                var code = 'WP' + ('000000' + max).slice(-6);
                if (!byId2(all, code)) { return code; }
            }
            return 'WP999999';
        }
        function byId2(all, code) {
            for (var i = 0; i < all.length; i++) { if (all[i].planCode === code) { return true; } }
            return false;
        }
        function dateOf(v, label) {
            var s = mockStr(v).slice(0, 10);
            if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) { throw new Error(label + '格式不正确（应为 YYYY-MM-DD）'); }
            return s;
        }
        function today() {
            var d = new Date();
            return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
        }
        function normPlan(data, old) {
            data = data || {};
            var name = mockStr(data.planName);
            if (!name) { throw new Error('计划名称不能为空'); }
            if (name.length > 150) { throw new Error('计划名称不能超过 150 个字符'); }
            var start = dateOf(data.startDate, '计划开始日期');
            var end = dateOf(data.endDate, '计划结束日期');
            if (start && end && start > end) { throw new Error('计划开始日期不能晚于结束日期'); }
            var scale = mockStr(data.scale) || 'day';
            if (['day', 'week', 'month'].indexOf(scale) < 0) { throw new Error('时间刻度只能是 day / week / month'); }
            var out = {
                planName: name,
                projectId: mockStr(data.projectId), projectName: mockStr(data.projectName),
                startDate: start, endDate: end,
                planDesc: mockStr(data.planDesc).slice(0, 2000),
                scale: scale, skipWeekend: mockBool(data.skipWeekend, false) ? 1 : 0,
                ispub: mockBool(data.ispub, true) ? 1 : 0,
                enabled: mockBool(data.enabled, true) ? 1 : 0
            };
            if (!old) {
                out.createEname = (function () {
                    try {
                        var s = JSON.parse(window.localStorage.getItem('menu_admin_login_v1') || '{}');
                        return (s.user && s.user.nameCn) || '';
                    } catch (e) { return ''; }
                })();
                out.createempinfosid = mockLoginEmpId();
                out.createTime = now();
            }
            /* 编辑已有计划时也要带上主键与编号：saveAll 靠 values.id 清旧任务，
               漏掉会让旧任务残留、新任务 planId 变 undefined。 */
            out.id = old ? old.id : mockUuid();
            out.planCode = old ? old.planCode : nextCode();
            out.updateTime = now();
            return out;
        }
        /* 参与人员 ID / 姓名：数组入参也接受，按 ID 去重后让姓名与 ID 下标对齐
           （与后端 WorkPlanService._people 同口径；姓名可能重名，不能单独去重） */
        function mockPeople(rawIds, rawNames) {
            var ids = (rawIds && Object.prototype.toString.call(rawIds).match(/Array/))
                ? rawIds : String(rawIds == null ? '' : rawIds).split(',');
            var names = (rawNames && Object.prototype.toString.call(rawNames).match(/Array/))
                ? rawNames : String(rawNames == null ? '' : rawNames).split(',');
            var outIds = [], outNames = [], seen = {}, i, s;
            for (i = 0; i < ids.length && outIds.length < 50; i++) {
                s = mockStr(ids[i]).slice(0, 50);
                if (!s || seen[s]) { continue; }
                seen[s] = 1;
                outIds.push(s);
                outNames.push(mockStr(names[i]).slice(0, 50));
            }
            return { ids: outIds.join(','), names: outNames.join(',') };
        }
        function normTasks(tasks) {
            if (tasks === undefined || tasks === null) { tasks = []; }
            if (!Object.prototype.toString.call(tasks).match(/Array/)) {
                throw new Error('任务数据格式不正确（应为数组）');
            }
            if (tasks.length > 200) { throw new Error('一张工作计划最多 200 条任务'); }
            var rows = [], ids = {}, i, j;
            for (i = 0; i < tasks.length; i++) {
                var t = tasks[i] || {};
                var name = mockStr(t.taskName);
                if (!name) { throw new Error('第 ' + (i + 1) + ' 行任务名称不能为空'); }
                if (name.length > 200) { throw new Error('第 ' + (i + 1) + ' 行任务名称不能超过 200 个字符'); }
                var tid = mockStr(t.id) || mockUuid();
                if (ids[tid]) { throw new Error('任务ID重复：' + tid); }
                ids[tid] = 1;
                var kind = mockStr(t.taskType) || 'task';
                if (['task', 'milestone', 'summary'].indexOf(kind) < 0) {
                    throw new Error('任务「' + name + '」的类型不合法');
                }
                var start = dateOf(t.startDate, '任务「' + name + '」开始日期');
                var end = dateOf(t.endDate, '任务「' + name + '」结束日期');
                if (!start && !end) { start = end = today(); }
                start = start || end; end = end || start;
                if (kind === 'milestone') { end = start; }
                if (start > end) { throw new Error('任务「' + name + '」的开始日期不能晚于结束日期'); }
                var preRaw = t.preTaskIds;
                var preList = (preRaw && Object.prototype.toString.call(preRaw).match(/Array/))
                    ? preRaw : String(preRaw == null ? '' : preRaw).split(',');
                var pre = [], seen = {};
                for (j = 0; j < preList.length; j++) {
                    var p = mockStr(preList[j]);
                    if (p && p !== tid && !seen[p]) { seen[p] = 1; pre.push(p); }
                }
                var people = mockPeople(t.participantIds, t.participantNames);
                /* 执行记录：完成状态 / 实际起止 / 说明，与后端 _normalize_tasks 同口径 */
                var exStatus = mockStr(t.execStatus) || '未开始';
                if (EXEC_STATUSES.indexOf(exStatus) < 0) { exStatus = '未开始'; }
                var aStart = dateOf(t.actualStartDate, '实际开始时间');
                var aEnd = dateOf(t.actualEndDate, '实际结束时间');
                if (aStart && aEnd && aStart > aEnd) {
                    throw new Error('任务「' + name + '」的实际开始时间不能晚于实际结束时间');
                }
                rows.push({
                    id: tid, taskName: name, taskType: kind,
                    parentId: mockStr(t.parentId), startDate: start, endDate: end,
                    progress: Math.min(100, Math.max(0, parseInt(t.progress, 10) || 0)),
                    execStatus: exStatus, actualStartDate: aStart, actualEndDate: aEnd,
                    execRemark: mockStr(t.execRemark).slice(0, 1000),
                    preTaskIds: pre.join(','), ownerName: mockStr(t.ownerName).slice(0, 50),
                    ownerId: parseInt(t.ownerId, 10) || 0,
                    participantIds: people.ids, participantNames: people.names,
                    sortNo: parseInt(t.sortNo, 10) || i, color: mockStr(t.color).slice(0, 20),
                    createTime: now(), updateTime: now(), _pre: pre
                });
            }
            for (i = 0; i < rows.length; i++) {
                var keep = [];
                for (j = 0; j < rows[i]._pre.length; j++) {
                    if (ids[rows[i]._pre[j]] && rows[i]._pre[j] !== rows[i].id) { keep.push(rows[i]._pre[j]); }
                }
                rows[i].preTaskIds = keep.join(',');
                if (rows[i].parentId && !ids[rows[i].parentId]) { rows[i].parentId = ''; }
            }
            checkDepCycle(rows);
            checkParentCycle(rows);
            for (i = 0; i < rows.length; i++) { delete rows[i]._pre; }
            return rows;
        }
        function checkDepCycle(rows) {
            var map = {}, state = {}, i;
            for (i = 0; i < rows.length; i++) {
                map[rows[i].id] = rows[i].preTaskIds ? rows[i].preTaskIds.split(',') : [];
            }
            function visit(node) {
                if (state[node] === 1) { throw new Error('前置依赖存在循环，请检查任务之间的链接'); }
                if (state[node] === 2) { return; }
                state[node] = 1;
                var list = map[node] || [];
                for (var k = 0; k < list.length; k++) { visit(list[k]); }
                state[node] = 2;
            }
            for (i = 0; i < rows.length; i++) { visit(rows[i].id); }
        }
        function checkParentCycle(rows) {
            var parents = {}, i;
            for (i = 0; i < rows.length; i++) { parents[rows[i].id] = rows[i].parentId; }
            for (i = 0; i < rows.length; i++) {
                var cur = rows[i].parentId, seen = {};
                while (cur) {
                    if (cur === rows[i].id || seen[cur]) { throw new Error('摘要任务层级存在循环，请调整缩进'); }
                    seen[cur] = 1; cur = parents[cur];
                }
            }
        }
        function mergePlan(old, values) {
            for (var k in values) { if (values.hasOwnProperty(k)) { old[k] = values[k]; } }
            return old;
        }
        /* 计划已启动后保存：给「新增 / 还没派过单」且已填人的任务补派工单（与后端 save 同口径） */
        function dispatchNew(plan, rows) {
            var orders = readOrders(), emps = empRows(), empById = {}, i, j;
            for (i = 0; i < emps.length; i++) { empById[parseInt(emps[i].id, 10)] = emps[i]; }
            var seq = nextOrderSeq(orders), created = 0, notified = 0, mailed = 0;
            for (i = 0; i < rows.length; i++) {
                var t = rows[i], owner = parseInt(t.ownerId, 10) || 0;
                var rawParts = String(t.participantIds || '').split(',');
                var ids = [], seen = {}, has = false;
                if (owner) { seen[owner] = 1; ids.push(owner); }
                for (j = 0; j < rawParts.length; j++) {
                    var pn = parseInt(rawParts[j], 10) || 0;
                    if (pn && !seen[pn]) { seen[pn] = 1; ids.push(pn); }
                }
                if (!ids.length) { continue; }          // 还没填人：等填完责任人再通知
                for (j = 0; j < orders.length; j++) { if (orders[j].taskId === t.id) { has = true; break; } }
                if (has) { continue; }                  // 幂等：已派过单的不重复通知
                var partIds = [], partNames = [], rawNames = String(t.participantNames || '').split(',');
                for (j = 0; j < ids.length; j++) {
                    if (ids[j] === owner) { continue; }
                    partIds.push(String(ids[j]));
                    partNames.push(mockStr((empById[ids[j]] || {}).nameCn) || mockStr(rawNames[j - 1]) || '');
                }
                seq++;
                var code = 'WO' + ('000000' + seq).slice(-6), okMail = false;
                for (j = 0; j < ids.length; j++) {
                    if (mockStr((empById[ids[j]] || {}).email)) { okMail = true; }
                }
                notified += ids.length;                 // Mock 假定站内消息必达
                mailed += okMail ? 1 : 0;
                orders.push({
                    id: mockUuid(), taskId: t.id, planId: plan.id,
                    projectId: plan.projectId || '', planCode: plan.planCode,
                    planName: plan.planName, orderCode: code, orderTitle: t.taskName,
                    taskType: t.taskType || 'task', startDate: t.startDate, endDate: t.endDate,
                    ownerId: owner, ownerName: t.ownerName || '',
                    ownerEmail: mockStr((empById[owner] || {}).email),
                    participantIds: partIds.join(','), participantNames: partNames.join(','),
                    status: '待处理', dispatchTime: now(),
                    noticeMsg: 1, noticeMail: okMail ? 1 : 0, noticeTime: now()
                });
                created++;
            }
            if (created) { writeOrders(orders); }
            return { created: created, receivers: notified, notified: notified, mailed: mailed };
        }
        function saveAll(planData, tasks) {
            var plans = readPlans(), allTasks = readTasks();
            var pid = mockStr(planData.id);
            var old = pid ? byId(plans, pid) : null;
            if (pid && !old) { throw new Error('工作计划不存在或已被删除'); }
            if (old && !visible(old)) { throw new Error('没有权限修改这条工作计划'); }
            var values = normPlan(planData, old);
            var rows = normTasks(tasks);
            var oldRows = old ? tasksOf(old.id) : [];
            var changes = [], ids = {}, r1;
            for (r1 = 0; r1 < rows.length; r1++) { ids[rows[r1].id] = rows[r1]; }
            if (old) {
                var oldMap = {}, r2;
                for (r2 = 0; r2 < oldRows.length; r2++) { oldMap[oldRows[r2].id] = oldRows[r2]; }
                if (!isCreator(old)) {
                    for (r2 = 0; r2 < oldRows.length; r2++) {
                        if (!ids[oldRows[r2].id]) {
                            throw new Error('非本人创建的工作计划，不能删除任务节点（' + oldRows[r2].taskName + '）');
                        }
                    }
                }
                for (r2 = 0; r2 < rows.length; r2++) {
                    var nt = rows[r2], ot = oldMap[nt.id], diffs = [];
                    if (!ot) { changes.push({ action: 'add', taskId: nt.id, taskName: nt.taskName,
                                              summary: '新增任务「' + nt.taskName + '」', detail: '' }); continue; }
                    var f = [['taskName', '任务名称'], ['startDate', '开始日期'], ['endDate', '结束日期'],
                             ['progress', '完成%'], ['execStatus', '完成状态'], ['ownerName', '责任人'],
                             ['participantNames', '参与人员']];
                    for (var fi = 0; fi < f.length; fi++) {
                        var ov = String(ot[f[fi][0]] == null ? '' : ot[f[fi][0]]);
                        var nv = String(nt[f[fi][0]] == null ? '' : nt[f[fi][0]]);
                        if (ov !== nv) { diffs.push(f[fi][1] + '：' + (ov || '空') + ' → ' + (nv || '空')); }
                    }
                    if (diffs.length) {
                        changes.push({ action: 'update', taskId: nt.id, taskName: nt.taskName,
                                       summary: '修改任务「' + nt.taskName + '」', detail: diffs.join('\n') });
                    }
                }
                for (r2 = 0; r2 < oldRows.length; r2++) {
                    if (!ids[oldRows[r2].id]) {
                        changes.push({ action: 'delete', taskId: oldRows[r2].id,
                                       taskName: oldRows[r2].taskName,
                                       summary: '删除任务「' + oldRows[r2].taskName + '」', detail: '' });
                    }
                }
            }
            var i;
            /* 时间刻度范围自动延伸到任务边界（与后端 save 同口径） */
            if (rows.length) {
                var lo = rows[0].startDate, hi = rows[0].endDate;
                for (i = 0; i < rows.length; i++) {
                    if (rows[i].startDate < lo) { lo = rows[i].startDate; }
                    if (rows[i].endDate > hi) { hi = rows[i].endDate; }
                }
                if (!values.startDate || values.startDate > lo) { values.startDate = lo; }
                if (!values.endDate || values.endDate < hi) { values.endDate = hi; }
            }
            if (old) {
                mergePlan(old, values);
            } else {
                plans.push(values);
            }
            var kept = [];
            for (i = 0; i < allTasks.length; i++) { if (allTasks[i].planId !== values.id) { kept.push(allTasks[i]); } }
            for (i = 0; i < rows.length; i++) { rows[i].planId = values.id; kept.push(rows[i]); }
            writePlans(plans); writeTasks(kept);
            var ci;
            for (ci = 0; ci < changes.length; ci++) {
                logOf(values.id, changes[ci].taskId, changes[ci].taskName, changes[ci].action,
                      changes[ci].summary, changes[ci].detail);
            }
            var message = '工作计划已保存（' + values.planCode + '，' + rows.length + ' 条任务）';
            if (changes.length) { message += '；变更 ' + changes.length + ' 项'; }
            var out = { id: values.id, planCode: values.planCode, taskCount: rows.length,
                        changes: changes.length, message: message };
            /* 已启动的计划：保存即给新增任务（已填责任人 / 参与人员）补派工单并通知 */
            if (mockStr((old || values).status) === '已启动') {
                var disp = dispatchNew(old || values, rows);
                if (disp.created || disp.notified || disp.mailed) {
                    message += '；新增任务已派工单 ' + disp.created + ' 张，通知 ' + disp.receivers +
                               ' 人（站内消息 ' + disp.notified + ' 条、邮件 ' + disp.mailed + ' 封）';
                    out.dispatched = disp.created; out.receivers = disp.receivers;
                    out.notified = disp.notified; out.mailed = disp.mailed; out.message = message;
                }
            }
            return out;
        }

        function route(method, path, params) {
            params = params || {};
            try {
                if (path === '/nextcode') { return ok({ code: nextCode() }); }
                if (path === '/list') {
                    var all = readPlans(), out = [], i;
                    var kw = mockStr(params.keyword).toLowerCase();
                    for (i = 0; i < all.length; i++) {
                        var r = all[i];
                        if (!visible(r)) { continue; }
                        if (params.projectId && r.projectId !== params.projectId) { continue; }
                        if (kw && (String(r.planCode) + r.planName + String(r.projectName || '') +
                                   String(r.planDesc || '')).toLowerCase().indexOf(kw) < 0) { continue; }
                        var one = attach(r);
                        one.isCreator = isCreator(r);
                        out.push(one);
                    }
                    out.sort(function (a, b) { return String(b.createTime).localeCompare(String(a.createTime)); });
                    var pageNum = Math.max(1, parseInt(params.pageNum, 10) || 1);
                    var pageSize = Math.min(200, Math.max(1, parseInt(params.pageSize, 10) || 10));
                    return ok({ list: out.slice((pageNum - 1) * pageSize, pageNum * pageSize),
                                total: out.length, pageNum: pageNum, pageSize: pageSize,
                                pages: Math.ceil(out.length / pageSize) });
                }
                if (path === '/detail') {
                    var plans = readPlans(), one = byId(plans, params.id);
                    if (!one || !visible(one)) { return err('工作计划不存在或已被删除', 404); }
                    /* 与后端 detail() 同口径：按 taskId LEFT JOIN 工单，回带工单编号 / 状态 */
                    var dTasks = tasksOf(one.id), dOrders = readOrders(), d2, d3;
                    for (d2 = 0; d2 < dTasks.length; d2++) {
                        var dt = dTasks[d2];
                        dt.execStatus = EXEC_STATUSES.indexOf(mockStr(dt.execStatus)) >= 0
                            ? dt.execStatus : '未开始';
                        dt.actualStartDate = mockStr(dt.actualStartDate);
                        dt.actualEndDate = mockStr(dt.actualEndDate);
                        dt.execRemark = mockStr(dt.execRemark);
                        dt.orderId = ''; dt.orderCode = ''; dt.orderStatus = ''; dt.dispatchTime = '';
                        for (d3 = 0; d3 < dOrders.length; d3++) {
                            if (dOrders[d3].taskId === dt.id) {
                                dt.orderId = dOrders[d3].id;
                                dt.orderCode = dOrders[d3].orderCode;
                                dt.orderStatus = dOrders[d3].status || '待处理';
                                dt.dispatchTime = dOrders[d3].dispatchTime || '';
                                break;
                            }
                        }
                        dt.orderLinked = !!dt.orderId;
                    }
                    for (d2 = 0; d2 < dTasks.length; d2++) {
                        dTasks[d2].execCount = execCountOf(dTasks[d2].id);
                    }
                    var dPlan = attach(one);
                    dPlan.isCreator = isCreator(one);
                    return ok({ plan: dPlan, tasks: dTasks });
                }
                if (path === '/add') {
                    var list = readPlans(), values = normPlan(params, null);
                    list.push(values); writePlans(list);
                    return ok({ id: values.id, planCode: values.planCode,
                                message: '工作计划已创建（' + values.planCode + '）' });
                }
                if (path === '/update') {
                    var ups = readPlans(), target = byId(ups, params.id);
                    if (!target || !visible(target)) { return err('工作计划不存在或已被删除', 404); }
                    mergePlan(target, normPlan(params, target));
                    writePlans(ups);
                    return ok({ id: target.id, planCode: target.planCode, message: '工作计划已更新' });
                }
                if (path === '/delete') {
                    var dels = readPlans(), hit = byId(dels, params.id);
                    if (!hit || !visible(hit)) { return err('工作计划不存在或已被删除', 404); }
                    if (!isCreator(hit)) { return err('非本人创建的工作计划不能删除', 403); }
                    if (mockStr(hit.status) === '已启动') {
                        return err('执行中的工作计划不能删除，请先停止', 403);
                    }
                    var remain = [], cnt = 0, tks = readTasks(), keptTasks = [], k;
                    for (k = 0; k < dels.length; k++) { if (dels[k].id !== hit.id) { remain.push(dels[k]); } }
                    for (k = 0; k < tks.length; k++) {
                        if (tks[k].planId === hit.id) { cnt++; } else { keptTasks.push(tks[k]); }
                    }
                    writePlans(remain); writeTasks(keptTasks);
                    /* 启动派发的工单也随计划一起清掉，避免「我的任务」里出现孤儿记录 */
                    var allOrders = readOrders(), keptOrders = [];
                    for (k = 0; k < allOrders.length; k++) {
                        if (allOrders[k].planId !== hit.id) { keptOrders.push(allOrders[k]); }
                    }
                    writeOrders(keptOrders);
                    return ok({ deleted: 1, taskCount: cnt,
                                message: '工作计划已删除（含 ' + cnt + ' 条任务）' });
                }
                if (path === '/save') {
                    var planData = clone(params.plan || params);
                    if (!planData.id && params.id) { planData.id = params.id; }
                    return ok(saveAll(planData, params.tasks));
                }
                /* 选人数据源：组织架构树 + 员工信息表 + 项目组成员（未关联项目时 members 为空） */
                if (path === '/projectplans') {
                    var ppId = mockStr(params.projectId);
                    var ppProject = byId((projectMocks && projectMocks.project && projectMocks.project.raw) ? projectMocks.project.raw() : [], ppId);
                    if (!ppProject) { return err('项目不存在或已被删除', 404); }
                    var ppMe = mockLoginEmpId();
                    var ppMembers = readMembers()[ppId] || [];
                    var ppAllowed = parseInt(ppProject.createempinfosid, 10) === ppMe ||
                        ppMembers.indexOf(ppMe) >= 0 ||
                        parseInt(ppProject.ispub, 10) !== 0;
                    if (!ppAllowed) { return err('没有权限查看该项目的计划', 403); }
                    var ppPlans = readPlans(), ppTasks = readTasks(), ppOrders = readOrders();
                    var ppKeyword = mockStr(params.keyword).toLowerCase();
                    var ppStatus = mockStr(params.status);
                    var ppList = [], ppI, ppJ;
                    for (ppI = 0; ppI < ppPlans.length; ppI++) {
                        var pp = ppPlans[ppI];
                        if (mockStr(pp.projectId) !== ppId) { continue; }
                        var taskCount = 0, progressSum = 0;
                        for (ppJ = 0; ppJ < ppTasks.length; ppJ++) {
                            if (mockStr(ppTasks[ppJ].planId) !== mockStr(pp.id)) { continue; }
                            taskCount++;
                            progressSum += parseInt(ppTasks[ppJ].progress, 10) || 0;
                        }
                        var orderCount = 0;
                        for (ppJ = 0; ppJ < ppOrders.length; ppJ++) {
                            if (mockStr(ppOrders[ppJ].planId) === mockStr(pp.id)) { orderCount++; }
                        }
                        var one = {
                            id: pp.id, planCode: mockStr(pp.planCode), planName: mockStr(pp.planName),
                            projectId: ppId, projectName: mockStr(ppProject.projectName),
                            status: mockStr(pp.status) || '未启动',
                            startDate: mockStr(pp.startDate), endDate: mockStr(pp.endDate),
                            taskCount: taskCount,
                            progress: taskCount ? Math.round(progressSum / taskCount) : 0,
                            orderCount: orderCount,
                            createEname: mockStr(pp.createEname),
                            createempinfosid: parseInt(pp.createempinfosid, 10) || 0,
                            createTime: mockStr(pp.createTime)
                        };
                        if (ppKeyword && (one.planCode + one.planName).toLowerCase().indexOf(ppKeyword) < 0) {
                            continue;
                        }
                        if (ppStatus && ppStatus !== one.status) { continue; }
                        ppList.push(one);
                    }
                    ppList.sort(function (a, b) {
                        if (a.createTime !== b.createTime) { return a.createTime < b.createTime ? 1 : -1; }
                        return a.planCode.localeCompare(b.planCode);
                    });
                    var ppPage = Math.max(1, parseInt(params.pageNum, 10) || 1);
                    var ppSize = Math.min(100, Math.max(1, parseInt(params.pageSize, 10) || 10));
                    return ok({
                        list: ppList.slice((ppPage - 1) * ppSize, ppPage * ppSize),
                        total: ppList.length, pageNum: ppPage, pageSize: ppSize,
                        projectId: ppId, projectName: mockStr(ppProject.projectName)
                    });
                }
                if (path === '/planorders') {
                    var poPlans = readPlans(), poVisible = {}, poProjects = {}, poHasNone = false, pi;
                    var poPlanId = mockStr(params.planId), poProjectId = mockStr(params.projectId);
                    for (pi = 0; pi < poPlans.length; pi++) {
                        var pp = poPlans[pi];
                        if (poPlanId && pp.id !== poPlanId) { continue; }
                        if (!visible(pp)) { continue; }
                        poVisible[pp.id] = pp;
                        var pk = mockStr(pp.projectId);
                        if (!pk) { poHasNone = true; }
                        else if (!poProjects[pk]) { poProjects[pk] = mockStr(pp.projectName) || pk; }
                    }
                    if (poPlanId && !poVisible[poPlanId]) {
                        var poTarget = byId(readPlans(), poPlanId);
                        if (poTarget && projectAllowed(poTarget.projectId)) {
                            poVisible[poPlanId] = poTarget;   // 项目全员可见
                        }
                    }
                    if (poPlanId && !poVisible[poPlanId]) { return err('没有权限查看该工作计划', 403); }
                    var poFiltered = {}, pk2;
                    for (pk2 in poVisible) {
                        if (!poVisible.hasOwnProperty(pk2)) { continue; }
                        var ppk = mockStr(poVisible[pk2].projectId);
                        if (poProjectId === '__none__' && ppk) { continue; }
                        if (poProjectId && poProjectId !== '__none__' && ppk !== poProjectId) { continue; }
                        poFiltered[pk2] = poVisible[pk2];
                    }
                    var poOrders = readOrders(), poTasks = readTasks(), poTaskMap = {};
                    for (pi = 0; pi < poTasks.length; pi++) { poTaskMap[poTasks[pi].id] = poTasks[pi]; }
                    var poList = [], poKw = mockStr(params.keyword).toLowerCase();
                    var poStatuses = mockStr(params.status).split(',').filter(function (x) { return !!x; });
                    var poExecs = mockStr(params.execStatus).split(',').filter(function (x) { return !!x; });
                    var poOwner = mockStr(params.owner).toLowerCase();
                    var poSummary = {};
                    for (pi = 0; pi < poOrders.length; pi++) {
                        var po = poOrders[pi], poPlan = poFiltered[po.planId];
                        if (!poPlan) { continue; }
                        var poTask = poTaskMap[po.taskId] || {};
                        var pkey = mockStr(poPlan.projectId) || '__none__';
                        var item = {
                            orderId: po.id, orderCode: po.orderCode, taskId: po.taskId,
                            taskName: mockStr(poTask.taskName) || mockStr(po.orderTitle),
                            planId: po.planId, planCode: mockStr(poPlan.planCode),
                            planName: mockStr(poPlan.planName),
                            projectId: pkey === '__none__' ? '' : pkey, projectKey: pkey,
                            projectName: pkey === '__none__' ? '未关联项目'
                                : (mockStr(poPlan.projectName) || pkey),
                            ownerId: parseInt(po.ownerId, 10) || 0, ownerName: mockStr(po.ownerName),
                            participantIds: mockStr(po.participantIds),
                            participantNames: mockStr(po.participantNames),
                            status: mockStr(po.status) || '待处理',
                            execStatus: mockStr(poTask.execStatus) || '未开始',
                            startDate: mockStr(poTask.startDate) || mockStr(po.startDate),
                            endDate: mockStr(poTask.endDate) || mockStr(po.endDate),
                            actualStartDate: mockStr(poTask.actualStartDate),
                            actualEndDate: mockStr(poTask.actualEndDate),
                            progress: parseInt(poTask.progress, 10) || 0,
                            dispatchTime: mockStr(po.dispatchTime),
                            noticeMsg: !!po.noticeMsg, noticeMail: !!po.noticeMail,
                            execCount: execCountOf(po.taskId), changeCount: changeCountOf(po.taskId)
                        };
                        var blob = (item.orderCode + item.taskName + item.planName + item.planCode +
                                    item.ownerName).toLowerCase();
                        if (poKw && blob.indexOf(poKw) < 0) { continue; }
                        if (poStatuses.length && poStatuses.indexOf(item.status) < 0) { continue; }
                        if (poExecs.length && poExecs.indexOf(item.execStatus) < 0) { continue; }
                        if (poOwner && item.ownerName.toLowerCase().indexOf(poOwner) < 0) { continue; }
                        poList.push(item);
                        var sg = poSummary[pkey] || (poSummary[pkey] = {
                            projectKey: pkey, projectName: item.projectName, orders: 0, plans: {}});
                        sg.orders++;
                        sg.plans[item.planId] = item.planName;
                    }
                    poList.sort(function (a, b) {
                        if (a.projectKey === '__none__' && b.projectKey !== '__none__') { return 1; }
                        if (b.projectKey === '__none__' && a.projectKey !== '__none__') { return -1; }
                        var cmp = String(a.projectName || '').localeCompare(String(b.projectName || ''));
                        if (cmp) { return cmp; }
                        cmp = String(a.planCode || '').localeCompare(String(b.planCode || ''));
                        if (cmp) { return cmp; }
                        return String(a.orderCode || '').localeCompare(String(b.orderCode || ''));
                    });
                    var poArr = [], pk3;
                    for (pk3 in poProjects) {
                        if (poProjects.hasOwnProperty(pk3)) {
                            poArr.push({ id: pk3, name: poProjects[pk3] });
                        }
                    }
                    poArr.sort(function (a, b) { return a.name.localeCompare(b.name); });
                    if (poHasNone) { poArr.push({ id: '__none__', name: '未关联项目' }); }
                    var poSumm = [], sk;
                    for (sk in poSummary) {
                        if (poSummary.hasOwnProperty(sk)) {
                            poSumm.push({ projectKey: sk, projectName: poSummary[sk].projectName,
                                          orders: poSummary[sk].orders,
                                          planCount: Object.keys(poSummary[sk].plans).length });
                        }
                    }
                    poSumm.sort(function (a, b) {
                        if (a.projectKey === '__none__') { return 1; }
                        if (b.projectKey === '__none__') { return -1; }
                        return a.projectName.localeCompare(b.projectName);
                    });
                    var poPage = Math.max(1, parseInt(params.pageNum, 10) || 1);
                    var poSize = Math.min(200, Math.max(1, parseInt(params.pageSize, 10) || 10));
                    return ok({ list: poList.slice((poPage - 1) * poSize, poPage * poSize),
                                total: poList.length, pageNum: poPage, pageSize: poSize,
                                pages: Math.ceil(poList.length / poSize),
                                projects: poArr, summary: poSumm });
                }
                if (path === '/people') {
                    var pId = mockStr(params.projectId);
                    var erows = empRows(), employees = [], members = [], p2;
                    for (p2 = 0; p2 < erows.length; p2++) { employees.push(personOf(erows[p2], false)); }
                    var projectName = '', allPlans = readPlans();
                    for (p2 = 0; p2 < allPlans.length; p2++) {
                        if (allPlans[p2].projectId === pId) { projectName = allPlans[p2].projectName || ''; break; }
                    }
                    var mm = readMembers(), groupIds = pId ? (mm[pId] || []) : [], g2, e2;
                    for (g2 = 0; g2 < groupIds.length; g2++) {
                        for (e2 = 0; e2 < erows.length; e2++) {
                            if (parseInt(erows[e2].id, 10) === parseInt(groupIds[g2], 10)) {
                                members.push(personOf(erows[e2], true)); break;
                            }
                        }
                    }
                    /* /org/tree 带 id=0「（顶级部门）」虚拟根，选人树不需要，与后端 people() 同口径过滤 */
                    var orgList = orgRows().filter(function (o) {
                        return parseInt(o.id, 10) !== 0;
                    });
                    return ok({ orgs: orgList, employees: employees, members: members,
                                projectId: pId, projectName: projectName, memberCount: members.length });
                }
                /* 启动：一任务一工单 + 责任人与参与人员的消息 / 邮件；重复启动只补派新任务 */
                if (path === '/start') {
                    var sp = readPlans(), planId = mockStr(params.planId || params.id);
                    var targetPlan = byId(sp, planId);
                    if (!targetPlan || !visible(targetPlan)) { return err('工作计划不存在或已被删除', 404); }
                    if (mockStr(targetPlan.status) === '已启动') {
                        return err('该工作计划已启动，不能重复启动', 400);
                    }
                    var stTasks = tasksOf(planId), sOrders = readOrders(), sEmps = empRows();
                    var empById = {}, s2, s3;
                    for (s2 = 0; s2 < sEmps.length; s2++) { empById[parseInt(sEmps[s2].id, 10)] = sEmps[s2]; }
                    var seq = nextOrderSeq(sOrders);
                    var created = 0, skipped = 0, notified = 0, mailed = 0, receivers = 0;
                    for (s2 = 0; s2 < stTasks.length; s2++) {
                        var t = stTasks[s2], owner = parseInt(t.ownerId, 10) || 0;
                        var rawParts = String(t.participantIds || '').split(',');
                        var ids = [], seen = {};
                        if (owner) { seen[owner] = 1; ids.push(owner); }
                        for (s3 = 0; s3 < rawParts.length; s3++) {
                            var pn = parseInt(rawParts[s3], 10) || 0;
                            if (pn && !seen[pn]) { seen[pn] = 1; ids.push(pn); }
                        }
                        var partIds = [], partNames = [], rawNames = String(t.participantNames || '').split(',');
                        for (s3 = 0; s3 < ids.length; s3++) {
                            if (ids[s3] === owner) { continue; }
                            partIds.push(String(ids[s3]));
                            var er = empById[ids[s3]] || {};
                            partNames.push(mockStr(er.nameCn) || mockStr(rawNames[s3 - 1]) || '');
                        }
                        var hitOrder = null;
                        for (s3 = 0; s3 < sOrders.length; s3++) {
                            if (sOrders[s3].taskId === t.id) { hitOrder = sOrders[s3]; break; }
                        }
                        if (hitOrder) {
                            hitOrder.ownerId = owner; hitOrder.ownerName = t.ownerName || '';
                            hitOrder.participantIds = partIds.join(',');
                            hitOrder.participantNames = partNames.join(',');
                            hitOrder.orderTitle = t.taskName;
                            skipped++; continue;
                        }
                        seq++;
                        var orderCode = 'WO' + ('000000' + seq).slice(-6);
                        var okMail = false;
                        for (s3 = 0; s3 < ids.length; s3++) {
                            receivers++;
                            notified++;                        // Mock 假定站内消息必达
                            var oneEmp = empById[ids[s3]] || {};
                            if (mockStr(oneEmp.email)) { mailed++; okMail = true; }
                        }
                        sOrders.push({
                            id: mockUuid(), taskId: t.id, planId: planId,
                            projectId: targetPlan.projectId || '', planCode: targetPlan.planCode,
                            planName: targetPlan.planName, orderCode: orderCode, orderTitle: t.taskName,
                            taskType: t.taskType || 'task', startDate: t.startDate, endDate: t.endDate,
                            ownerId: owner, ownerName: t.ownerName || '',
                            ownerEmail: mockStr((empById[owner] || {}).email),
                            participantIds: partIds.join(','), participantNames: partNames.join(','),
                            status: '待处理', dispatchTime: now(),
                            noticeMsg: ids.length ? 1 : 0, noticeMail: okMail ? 1 : 0,
                            noticeTime: now()
                        });
                        created++;
                    }
                    targetPlan.status = '已启动';
                    targetPlan.startTime = now();
                    targetPlan.startempinfosid = mockLoginEmpId();
                    try {
                        var sess = JSON.parse(window.localStorage.getItem('menu_admin_login_v1') || '{}');
                        targetPlan.startEname = (sess.user && sess.user.nameCn) || '';
                    } catch (eS) { targetPlan.startEname = ''; }
                    writePlans(sp); writeOrders(sOrders);
                    var sMsg = '已启动：派发工单 ' + created + ' 张，通知 ' + receivers +
                               ' 人（站内消息 ' + notified + ' 条、邮件 ' + mailed + ' 封）';
                    if (skipped) { sMsg += '；' + skipped + ' 张已有工单只同步人员，未重复通知'; }
                    if (!stTasks.length) { sMsg += '；计划下还没有任务，请先在工作计划里添加任务'; }
                    return ok({ created: created, skipped: skipped, notified: notified,
                                mailed: mailed, receivers: receivers, status: '已启动', message: sMsg });
                }
                /* 我的任务：当前登录人作为责任人或参与人员的工单（按 taskId JOIN 关联任务的执行记录） */
                if (path === '/orders') {
                    var me = mockLoginEmpId(), oAll = readOrders(), oTasks = readTasks(), oOut = [], o3;
                    /* 项目筛选按「计划当前关联项目」算，工单里的 projectId 只是派单时快照 */
                    var oPlans = readPlans(), oPlanById = {}, oP;
                    for (oP = 0; oP < oPlans.length; oP++) { oPlanById[oPlans[oP].id] = oPlans[oP]; }
                    for (o3 = 0; o3 < oAll.length; o3++) {
                        var o = oAll[o3], pids = String(o.participantIds || '').split(',');
                        var isOwner = (parseInt(o.ownerId, 10) === me), isPart = false, p3;
                        for (p3 = 0; p3 < pids.length; p3++) {
                            if (me && parseInt(pids[p3], 10) === me) { isPart = true; }
                        }
                        if (me && !isOwner && !isPart) { continue; }
                        var cntParts = 0;
                        for (p3 = 0; p3 < pids.length; p3++) { if (mockStr(pids[p3])) { cntParts++; } }
                        var linked = null;
                        for (p3 = 0; p3 < oTasks.length; p3++) {
                            if (oTasks[p3].id === o.taskId) { linked = oTasks[p3]; break; }
                        }
                        oOut.push({
                            id: o.id, orderCode: o.orderCode, sourceType: '工作计划',
                            taskId: o.taskId || '', taskLinked: !!linked,
                            taskName: (linked && mockStr(linked.taskName)) || o.orderTitle,
                            planName: o.planName, planCode: o.planCode,
                            projectId: (oPlanById[o.planId] && oPlanById[o.planId].projectId) ||
                                       o.projectId || '',
                            role: isOwner ? '责任人' : '参与人员', participantCount: cntParts,
                            ownerName: o.ownerName || '', status: o.status || '待处理',
                            execStatus: linked ? (mockStr(linked.execStatus) || '未开始') : '未开始',
                            actualStartDate: linked ? mockStr(linked.actualStartDate) : '',
                            actualEndDate: linked ? mockStr(linked.actualEndDate) : '',
                            execRemark: linked ? mockStr(linked.execRemark) : '',
                            progress: linked ? (parseInt(linked.progress, 10) || 0) : 0,
                            /* 起止优先取关联任务的当前值（任务改期后工单不会显示过期日期） */
                            startDate: (linked && mockStr(linked.startDate)) || o.startDate || '',
                            endDate: (linked && mockStr(linked.endDate)) || o.endDate || '',
                            execCount: execCountOf(o.taskId),
                            changeCount: changeCountOf(o.taskId),
                            noticeMsg: !!o.noticeMsg, noticeMail: !!o.noticeMail,
                            dispatchTime: o.dispatchTime || '',
                            link: 'workplan-design.html?id=' + o.planId + '&taskId=' + o.taskId
                        });
                    }
                    var oKw = mockStr(params.keyword).toLowerCase();
                    oOut = oOut.filter(function (x) {
                        if (params.sourceType && mockStr(params.sourceType) !== x.sourceType) { return false; }
                        if (params.projectId && mockStr(params.projectId) !== mockStr(x.projectId)) { return false; }
                        if (params.role && mockStr(params.role) !== x.role) { return false; }
                        if (params.status && mockStr(params.status) !== x.status) { return false; }
                        if (params.execStatus && mockStr(params.execStatus) !== x.execStatus) { return false; }
                        if (oKw && (x.orderCode + x.taskName + x.planName + x.planCode)
                                .toLowerCase().indexOf(oKw) < 0) { return false; }
                        return true;
                    });
                    oOut.sort(function (a, b) { return String(b.dispatchTime).localeCompare(String(a.dispatchTime)); });
                    var oPage = Math.max(1, parseInt(params.pageNum, 10) || 1);
                    var oSize = Math.min(200, Math.max(1, parseInt(params.pageSize, 10) || 10));
                    return ok({ list: oOut.slice((oPage - 1) * oSize, oPage * oSize),
                                total: oOut.length, pageNum: oPage, pageSize: oSize,
                                pages: Math.ceil(oOut.length / oSize) });
                }
                /* 执行记录回填：我的任务工单 → 按 taskId 更新关联任务（与后端 exec_record 同口径） */
                if (path === '/exec') {
                    var exOrders = readOrders(), exId = mockStr(params.orderId), exHit = null, e1;
                    for (e1 = 0; e1 < exOrders.length; e1++) {
                        if (exOrders[e1].id === exId) { exHit = exOrders[e1]; break; }
                    }
                    if (!exHit) { return err('工单不存在或已被删除', 404); }
                    var exMe = mockLoginEmpId(), exParts = String(exHit.participantIds || '').split(',');
                    var exAllowed = (parseInt(exHit.ownerId, 10) === exMe);
                    for (e1 = 0; e1 < exParts.length; e1++) {
                        if (exMe && parseInt(exParts[e1], 10) === exMe) { exAllowed = true; }
                    }
                    if (!exAllowed) { return err('只有该工单的责任人或参与人员可以填写执行记录', 403); }
                    var exStatus = mockStr(params.execStatus) || '未开始';
                    if (EXEC_STATUSES.indexOf(exStatus) < 0) { return err('完成状态不合法', 400); }
                    var exOStatus = mockStr(params.status) || exHit.status || '待处理';
                    if (ORDER_STATUSES.indexOf(exOStatus) < 0) { return err('工单状态不合法', 400); }
                    var exAS = dateOf(params.actualStartDate, '实际开始时间');
                    var exAE = dateOf(params.actualEndDate, '实际结束时间');
                    if (exAS && exAE && exAS > exAE) {
                        return err('实际开始时间不能晚于实际结束时间', 400);
                    }
                    if (exStatus === '已完成' && !exAE) { exAE = today(); }
                    var exRemark = mockStr(params.execRemark).slice(0, 1000);
                    var exTasks = readTasks(), exTask = null;
                    for (e1 = 0; e1 < exTasks.length; e1++) {
                        if (exTasks[e1].id === exHit.taskId) { exTask = exTasks[e1]; break; }
                    }
                    var exProgress = params.progress === undefined
                        ? (exTask ? (parseInt(exTask.progress, 10) || 0) : 0)
                        : Math.min(100, Math.max(0, parseInt(params.progress, 10) || 0));
                    if (exTask && mockStr(exTask.execStatus) === '已完成') {
                        return err('任务已完成，不能再提交执行记录；如确需补充请先在计划中调整完成状态', 403);
                    }
                    if (exStatus === '已完成') { exProgress = 100; }
                    exHit.status = exOStatus;
                    if (exTask) {
                        exTask.execStatus = exStatus;
                        exTask.actualStartDate = exAS;
                        exTask.actualEndDate = exAE;
                        exTask.execRemark = exRemark;
                        exTask.progress = exProgress;
                        writeTasks(exTasks);
                    }
                    writeOrders(exOrders);
                    var exFiles = [], exIn = params.files || [], fi2;
                    for (fi2 = 0; fi2 < exIn.length && fi2 < 10; fi2++) {
                        exFiles.push({ id: mockUuid() + '-f' + fi2,
                                       name: mockStr(exIn[fi2].name) || ('附件' + (fi2 + 1)),
                                       size: String(exIn[fi2].data || '').length,
                                       ext: (mockStr(exIn[fi2].name).split('.').pop() || '').toLowerCase(),
                                       data: mockStr(exIn[fi2].data) });
                    }
                    var exList = readExecs();
                    var exRecord = { id: mockUuid(), planId: exHit.planId || '', taskId: exHit.taskId || '',
                                     orderId: exId, title: mockStr(params.title) || '执行记录',
                                     content: exRemark, progress: exProgress, execStatus: exStatus,
                                     actualStartDate: exAS, actualEndDate: exAE,
                                     operatorId: mockLoginEmpId(), operatorName: '我',
                                     createTime: mockNow(), files: exFiles };
                    exList.push(exRecord);
                    writeExecs(exList);
                    if (exHit.taskId) {
                        logOf(exHit.planId, exHit.taskId, exTask ? exTask.taskName : '', 'exec',
                              '提交执行记录（' + exStatus + '，完成 ' + exProgress + '%）', exRemark);
                    }
                    return ok({ execId: exRecord.id, files: exFiles, orderId: exId,
                                taskId: exHit.taskId || '', taskLinked: !!exTask,
                                execStatus: exStatus, actualStartDate: exAS, actualEndDate: exAE,
                                execRemark: exRemark, progress: exProgress, status: exOStatus,
                                message: exTask ? '执行记录已保存' : '执行记录已保存；关联任务不存在，仅更新了工单状态' });
                }
                if (path === '/execs') {
                    var xList = readExecs(), xOut = [], xi;
                    for (xi = 0; xi < xList.length; xi++) {
                        var xe = xList[xi];
                        if (params.orderId && xe.orderId !== mockStr(params.orderId)) { continue; }
                        if (params.taskId && xe.taskId !== mockStr(params.taskId)) { continue; }
                        if (params.planId && xe.planId !== mockStr(params.planId)) { continue; }
                        xOut.push(xe);
                    }
                    xOut.sort(function (a, b) { return String(b.createTime).localeCompare(String(a.createTime)); });
                    return ok({ list: xOut, total: xOut.length });
                }
                if (path === '/execfile') {
                    var fId = mockStr(params.id), fList = readExecs(), fi3, fj;
                    for (fi3 = 0; fi3 < fList.length; fi3++) {
                        var ff = fList[fi3].files || [];
                        for (fj = 0; fj < ff.length; fj++) {
                            if (ff[fj].id === fId) {
                                return ok({ id: fId, name: ff[fj].name, ext: ff[fj].ext,
                                            size: ff[fj].size,
                                            dataUrl: ff[fj].data || '' });
                            }
                        }
                    }
                    return err('附件不存在或已被删除', 404);
                }
                if (path === '/changelogs') {
                    var lg = readLogs(), lOut = [], li;
                    var withPlan = !!(params.withPlan && parseInt(params.withPlan, 10));
                    for (li = 0; li < lg.length; li++) {
                        if (lg[li].planId !== mockStr(params.planId || params.id)) { continue; }
                        if (params.taskId) {
                            var same = lg[li].taskId === mockStr(params.taskId);
                            if (!same && !(withPlan && !lg[li].taskId)) { continue; }
                        }
                        lOut.push(lg[li]);
                    }
                    lOut.sort(function (a, b) { return String(b.createTime).localeCompare(String(a.createTime)); });
                    return ok({ list: lOut, total: lOut.length });
                }
                if (path === '/stop') {
                    var sp2 = readPlans(), sid = mockStr(params.planId || params.id);
                    var spTarget = byId(sp2, sid);
                    if (!spTarget || !visible(spTarget)) { return err('工作计划不存在或已被删除', 404); }
                    if (!isCreator(spTarget)) { return err('只有计划创建人可以停止该工作计划', 403); }
                    if (mockStr(spTarget.status) === '已停止') { return err('该工作计划已停止，无需重复操作', 400); }
                    if (mockStr(spTarget.status) !== '已启动') { return err('只有已启动的工作计划可以停止', 400); }
                    spTarget.status = '已停止';
                    writePlans(sp2);
                    logOf(sid, '', '', 'stop', '停止了工作计划', '');
                    return ok({ id: sid, status: '已停止', message: '工作计划已停止' });
                }
                /* Excel 导入（离线演示）：不解析真实文件，返回一批演示行把预览 / 写入画布跑通 */
                if (path === '/importtasks') {
                    if (!mockStr(params.data)) { return err('请先选择要导入的 Excel 文件', 400); }
                    var imEmps = empRows(), imRows = [], imIdx;
                    function imP(i) {
                        var e = imEmps.length ? imEmps[i % imEmps.length] : {};
                        return { id: parseInt(e.id, 10) || 0,
                                 name: mockStr(e.nameCn || e.name) || ('员工' + (i + 1)) };
                    }
                    function imDay(s) { return Date.UTC(+String(s).slice(0, 4), +String(s).slice(5, 7) - 1,
                        +String(s).slice(8, 10)) / 86400000; }
                    var imA = imP(0), imB = imP(1), imC = imP(2);
                    var imDef = [
                        [1, 1, '需求调研与方案设计', 'summary', '2026-11-02', '2026-11-06',
                         imA.id, imA.name, String(imB.id), imB.name, null, []],
                        [2, 2, '现场调研', 'task', '2026-11-02', '2026-11-03',
                         imB.id, imB.name, '', '', 1, []],
                        [3, 2, '方案评审', 'milestone', '2026-11-06', '2026-11-06',
                         imA.id, imA.name, String(imC.id), imC.name, 1, [2]],
                        [4, 1, '开发实施', 'task', '2026-11-09', '2026-11-20',
                         imC.id, imC.name, '', '', null, [3]]
                    ];
                    for (imIdx = 0; imIdx < imDef.length; imIdx++) {
                        var imD = imDef[imIdx];
                        imRows.push({
                            id: mockUuid() + '-im' + imIdx, seq: imD[0], rowNo: imIdx + 2,
                            level: imD[1], taskName: imD[2], taskType: imD[3],
                            startDate: imD[4], endDate: imD[5],
                            duration: imDay(imD[5]) - imDay(imD[4]) + 1,
                            ownerId: imD[6], ownerName: imD[7],
                            participantIds: imD[8], participantNames: imD[9],
                            /* 原填写文本：与真实接口一致，预览里用作 title（「E00001 张三」） */
                            ownerRaw: imD[7] ? ('E' + ('0000' + (imD[6] || 0)).slice(-4) + ' ' + imD[7]) : '',
                            participantRaw: imD[9] || '',
                            parentSeq: imD[10], preTaskSeqs: imD[11], errors: [], ok: true
                        });
                    }
                    return ok({
                        rows: imRows, errors: [],
                        summary: { total: imRows.length, valid: imRows.length, invalid: 0,
                                   summaries: 1, milestones: 1, withOwner: imRows.length,
                                   participants: 2, maxTasks: 200 },
                        fileName: mockStr(params.fileName), mock: true
                    });
                }
                return err('接口不存在：/workplan' + path, 404);
            } catch (e) {
                return err(e.message || '服务异常');
            }
        }
        return { route: route, raw: readPlans, rawTasks: readTasks };
    }

    var workPlanSvc = createWorkPlanMockService();

    /* ==========================================================================
       员工工作量统计模拟服务（workload）
       --------------------------------------------------------------------------
       · 不单独造数：直接读「工作计划」Mock 落盘的工单（menu_admin_workplanorders_v1），
         所以先在「计划管理」启动一个计划，这里立刻就有数据；
       · 口径与后端 WorkloadService 保持一致（否则页面在 Mock / 真实后端下数字会不同）：
         区间按 dispatchTime、完成率 = 已完成 ÷ 接单数、逾期 = 未完成且 endDate 已过、
         平均耗时按「派单日 → 实际完成日」、ownerId=0 垫底。
       ========================================================================== */
    function createWorkloadMockService() {
        var ORDER_KEY = 'menu_admin_workplanorders_v1';

        function ok(data) { return { code: 0, message: 'ok', data: data }; }
        function err(message, code) { return { code: code || 500, message: message }; }
        function readOrders() {
            try {
                var raw = window.localStorage.getItem(ORDER_KEY);
                return raw ? JSON.parse(raw) : [];
            } catch (e) { return []; }
        }
        function p2(n) { return ('0' + n).slice(-2); }
        function today() {
            var d = new Date();
            return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
        }
        function nowText() {
            var d = new Date();
            return today() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
        }
        function dayOf(v) { return mockStr(v).slice(0, 10); }
        function strOf(v) { return mockStr(v); }
        function dayDiff(a, b) {
            var d0 = new Date(a + 'T00:00:00'), d1 = new Date(b + 'T00:00:00');
            return Math.round((d1 - d0) / 86400000);
        }
        function empMap() {
            var res = empSvc.route('GET', '/list', { pageNum: 1, pageSize: 1000 });
            var list = (res && res.data && res.data.list) || [], map = {}, i, e, id;
            for (i = 0; i < list.length; i++) {
                e = list[i];
                id = parseInt(e.id, 10) || 0;
                map[id] = { code: strOf(e.code), name: strOf(e.nameCn || e.name),
                            dept: strOf(e.deptName || e.dept || '') };
            }
            return map;
        }
        function projectOptions() {
            var res = projectSvc.route('GET', '/list', { pageNum: 1, pageSize: 500 });
            var list = (res && res.data && res.data.list) || [], out = [], i;
            for (i = 0; i < list.length; i++) {
                out.push({ id: strOf(list[i].id), code: strOf(list[i].projectCode),
                           name: strOf(list[i].projectName) });
            }
            return out;
        }
        function rangeOf(params) {
            var s = dayOf(params.startDate), e = dayOf(params.endDate), t = today();
            if (!s && !e) { s = t.slice(0, 8) + '01'; e = t; }
            else if (!s) { s = e.slice(0, 8) + '01'; }
            else if (!e) { e = t; }
            return { start: s, end: e };
        }
        function collect(params) {
            var r = rangeOf(params), orders = readOrders(), out = [], i, o, d;
            var me = mockLoginEmpId(), mine = strOf(params.scope) === 'mine';
            var pid = strOf(params.projectId);
            for (i = 0; i < orders.length; i++) {
                o = orders[i];
                d = dayOf(o.dispatchTime);
                if (!d || d < r.start || d > r.end) { continue; }
                if (mine && (parseInt(o.ownerId, 10) || 0) !== me) { continue; }
                if (pid && strOf(o.projectId) !== pid) { continue; }
                out.push(o);
            }
            return { rows: out, range: r };
        }
        function buildList(rows) {
            var emap = empMap(), map = {}, keys = [], i, o, id, cur, emp, st, endD, actD, dt;
            for (i = 0; i < rows.length; i++) {
                o = rows[i];
                id = parseInt(o.ownerId, 10) || 0;
                cur = map[id];
                if (!cur) {
                    emp = emap[id] || {};
                    cur = map[id] = {
                        ownerId: id,
                        ownerName: emp.name || strOf(o.ownerName) || '未指定',
                        empCode: emp.code || '', deptName: emp.dept || '',
                        orderCount: 0, doneCount: 0, doingCount: 0, todoCount: 0,
                        overdueCount: 0, onTimeCount: 0, costDays: 0, costCount: 0,
                        planIds: {}, lastDispatch: '', unknown: id <= 0
                    };
                    keys.push(id);
                }
                cur.orderCount++;
                st = strOf(o.status) || '待处理';
                endD = dayOf(o.endDate);
                actD = dayOf(o.actualEndTime);
                if (st === '已完成') {
                    cur.doneCount++;
                    if (endD && actD && actD <= endD) { cur.onTimeCount++; }
                    if (actD) {
                        cur.costCount++;
                        cur.costDays += Math.max(0, dayDiff(dayOf(o.dispatchTime), actD));
                    }
                } else if (st === '处理中') { cur.doingCount++; }
                else { cur.todoCount++; }
                if (st !== '已完成' && endD && endD < today()) { cur.overdueCount++; }
                if (strOf(o.planId)) { cur.planIds[strOf(o.planId)] = 1; }
                dt = strOf(o.dispatchTime);
                if (dt > cur.lastDispatch) { cur.lastDispatch = dt; }
            }
            var list = [], it;
            for (i = 0; i < keys.length; i++) {
                it = map[keys[i]];
                it.doneRate = it.orderCount ? Math.round(it.doneCount * 1000 / it.orderCount) / 10 : 0;
                it.onTimeRate = it.doneCount ? Math.round(it.onTimeCount * 1000 / it.doneCount) / 10 : 0;
                it.avgDays = it.costCount ? Math.round(it.costDays * 10 / it.costCount) / 10 : 0;
                it.planCount = Object.keys(it.planIds).length;
                delete it.planIds;
                delete it.onTimeCount;
                delete it.costDays;
                delete it.costCount;
                list.push(it);
            }
            return list;
        }
        function rate(part, whole) {
            return whole ? Math.round(part * 1000 / whole) / 10 : 0;
        }
        function stats(params) {
            var got = collect(params), list = buildList(got.rows);
            var kw = strOf(params.keyword).toLowerCase();
            if (kw) {
                list = list.filter(function (x) {
                    return (x.ownerName + ' ' + x.empCode + ' ' + x.deptName).toLowerCase().indexOf(kw) > -1;
                });
            }
            var sortBy = strOf(params.sortBy) || 'orderCount';
            var desc = strOf(params.sortOrder).toLowerCase() !== 'asc';
            list.sort(function (a, b) { return a.ownerName < b.ownerName ? -1 : (a.ownerName > b.ownerName ? 1 : 0); });
            list.sort(function (a, b) {
                var va = sortBy === 'lastDispatch' ? strOf(a.lastDispatch) : (Number(a[sortBy]) || 0);
                var vb = sortBy === 'lastDispatch' ? strOf(b.lastDispatch) : (Number(b[sortBy]) || 0);
                if (va === vb) { return 0; }
                return (va > vb ? 1 : -1) * (desc ? -1 : 1);
            });
            list = list.filter(function (x) { return !x.unknown; })
                       .concat(list.filter(function (x) { return x.unknown; }));

            var sum = { orderCount: 0, doneCount: 0, doingCount: 0, todoCount: 0,
                        overdueCount: 0, people: list.length };
            var planIds = {}, i;
            for (i = 0; i < list.length; i++) {
                sum.orderCount += list[i].orderCount;
                sum.doneCount += list[i].doneCount;
                sum.doingCount += list[i].doingCount;
                sum.todoCount += list[i].todoCount;
                sum.overdueCount += list[i].overdueCount;
            }
            for (i = 0; i < got.rows.length; i++) {
                if (strOf(got.rows[i].planId)) { planIds[strOf(got.rows[i].planId)] = 1; }
            }
            sum.planCount = Object.keys(planIds).length;
            sum.doneRate = rate(sum.doneCount, sum.orderCount);

            return ok({
                range: { startDate: got.range.start, endDate: got.range.end,
                         days: dayDiff(got.range.start, got.range.end) + 1 },
                summary: sum, list: list, projects: projectOptions(),
                me: { empId: mockLoginEmpId(), name: '' },
                sortBy: sortBy, sortOrder: desc ? 'desc' : 'asc',
                scope: strOf(params.scope) === 'mine' ? 'mine' : 'all',
                generatedAt: nowText(), mock: true
            });
        }
        function details(params) {
            var got = collect(params);
            var ownerId = parseInt(params.ownerId, 10) || 0;
            var rows = got.rows.filter(function (o) {
                return (parseInt(o.ownerId, 10) || 0) === ownerId;
            });
            var st = strOf(params.status);
            if (st) {
                rows = rows.filter(function (o) { return (strOf(o.status) || '待处理') === st; });
            }
            rows.sort(function (a, b) {
                return strOf(a.dispatchTime) < strOf(b.dispatchTime) ? 1 : -1;
            });
            var total = rows.length, done = 0, overdue = 0, i, o, st2, endD;
            for (i = 0; i < rows.length; i++) {
                o = rows[i];
                st2 = strOf(o.status) || '待处理';
                endD = dayOf(o.endDate);
                if (st2 === '已完成') { done++; }
                else if (endD && endD < today()) { overdue++; }
            }
            var pageNum = Math.max(1, parseInt(params.pageNum, 10) || 1);
            var pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize, 10) || 10));
            var page = rows.slice((pageNum - 1) * pageSize, pageNum * pageSize);
            var list = page.map(function (o) {
                var st3 = strOf(o.status) || '待处理', actD = dayOf(o.actualEndTime);
                var endD2 = dayOf(o.endDate), days = null;
                if (st3 === '已完成' && actD && dayOf(o.dispatchTime)) {
                    days = Math.max(0, dayDiff(dayOf(o.dispatchTime), actD));
                }
                return {
                    orderId: strOf(o.id), orderCode: strOf(o.orderCode),
                    taskName: strOf(o.orderTitle), taskId: strOf(o.taskId),
                    taskType: strOf(o.taskType), planId: strOf(o.planId),
                    planCode: strOf(o.planCode), planName: strOf(o.planName),
                    projectId: strOf(o.projectId),
                    projectName: strOf(o.projectName) || '未关联项目',
                    startDate: dayOf(o.startDate), endDate: endD2,
                    dispatchTime: strOf(o.dispatchTime), actualEndTime: actD,
                    status: st3, acceptStatus: strOf(o.acceptStatus),
                    ownerName: strOf(o.ownerName),
                    participantNames: strOf(o.participantNames),
                    days: days,
                    overdue: !!(st3 !== '已完成' && endD2 && endD2 < today())
                };
            });
            return ok({
                list: list, total: total, pageNum: pageNum, pageSize: pageSize,
                pages: Math.max(1, Math.ceil(total / pageSize)),
                range: { startDate: got.range.start, endDate: got.range.end },
                summary: { total: total, done: done, overdue: overdue, doneRate: rate(done, total) },
                mock: true
            });
        }
        function route(method, path, params) {
            try {
                if (path === '/stats' && method === 'GET') { return stats(params); }
                if (path === '/details' && method === 'GET') { return details(params); }
                return err('接口不存在：/workload' + path, 404);
            } catch (e) {
                return err(e.message || '服务异常');
            }
        }
        return { route: route };
    }

    var workloadSvc = createWorkloadMockService();

    var projectMocks = createProjectMockServices();
    var projectSvc = projectMocks.project;
    var projectDirSvc = projectMocks.projectdir;
    var projectFileSvc = projectMocks.projectfile;


    /* ==========================================================================
       系统配置模拟服务：系统字典（sysdict）+ 字典键值（sysdictitems）+ 系统参数（syspara）
       --------------------------------------------------------------------------
       · 与后端 SysConfigBaseService 同口径：UUID 主键、英文名唯一、显示序号升序、
         启用否；**不做**「本人创建 OR 公用」可见性过滤（全局配置数据）；
       · sysdict 支持 parentId 树形分组：tree 返回层级缩进 label，编辑时排除自身与后代；
         删除字典级联清理 sysdictitems 键值明细，并把子字典 parentId 置空；
       · sysdictitems 按 dictId 归属，同一字典下 itemKey 唯一（空键允许多条）。
       ========================================================================== */
    var SYSDICT_KEY = 'menu_admin_sysdict_v1';
    var SYSDICTITEMS_KEY = 'menu_admin_sysdictitems_v1';
    var SYSPARA_KEY = 'menu_admin_syspara_v1';
    var SYS_NAME_EN_RE = /^[A-Za-z][A-Za-z0-9_.\-]*$/;

    function createSysConfigMockServices() {
        var SEED_DICT = [
            { id: 'sd-0000-4000-8000-000000000001', dictNameCn: '用户性别', dictNameEn: 'gender',
              parentId: '', sortNo: 1, remark: '账号资料里的性别下拉', enabled: true,
              createTime: '2026-11-01 09:00:00', updateTime: '2026-11-01 09:00:00' },
            { id: 'sd-0000-4000-8000-000000000002', dictNameCn: '项目状态', dictNameEn: 'project_status',
              parentId: '', sortNo: 2, remark: '项目台账状态枚举', enabled: true,
              createTime: '2026-11-01 09:10:00', updateTime: '2026-11-01 09:10:00' },
            { id: 'sd-0000-4000-8000-000000000003', dictNameCn: '基础配置', dictNameEn: 'basic_config',
              parentId: '', sortNo: 3, remark: '系统基础类字典分组', enabled: true,
              createTime: '2026-11-01 09:20:00', updateTime: '2026-11-01 09:20:00' },
            { id: 'sd-0000-4000-8000-000000000004', dictNameCn: '界面主题', dictNameEn: 'ui_theme',
              parentId: 'sd-0000-4000-8000-000000000003', sortNo: 1,
              remark: '挂在基础配置下的子字典（已停用）', enabled: false,
              createTime: '2026-11-01 09:30:00', updateTime: '2026-11-01 09:30:00' }
        ];
        var SEED_ITEMS = [
            { id: 'si-0000-4000-8000-000000000001', dictId: 'sd-0000-4000-8000-000000000001',
              itemKey: 'M', itemValue: '男', sortNo: 1, remark: '', enabled: true,
              createTime: '2026-11-01 10:00:00', updateTime: '2026-11-01 10:00:00' },
            { id: 'si-0000-4000-8000-000000000002', dictId: 'sd-0000-4000-8000-000000000001',
              itemKey: 'F', itemValue: '女', sortNo: 2, remark: '', enabled: true,
              createTime: '2026-11-01 10:01:00', updateTime: '2026-11-01 10:01:00' },
            { id: 'si-0000-4000-8000-000000000003', dictId: 'sd-0000-4000-8000-000000000001',
              itemKey: 'U', itemValue: '未知', sortNo: 3, remark: '历史选项', enabled: false,
              createTime: '2026-11-01 10:02:00', updateTime: '2026-11-01 10:02:00' },
            { id: 'si-0000-4000-8000-000000000004', dictId: 'sd-0000-4000-8000-000000000002',
              itemKey: 'doing', itemValue: '进行中', sortNo: 1, remark: '', enabled: true,
              createTime: '2026-11-01 10:03:00', updateTime: '2026-11-01 10:03:00' },
            { id: 'si-0000-4000-8000-000000000005', dictId: 'sd-0000-4000-8000-000000000002',
              itemKey: 'done', itemValue: '已完成', sortNo: 2, remark: '', enabled: true,
              createTime: '2026-11-01 10:04:00', updateTime: '2026-11-01 10:04:00' },
            { id: 'si-0000-4000-8000-000000000006', dictId: 'sd-0000-4000-8000-000000000004',
              itemKey: 'light', itemValue: '淡雅灰', sortNo: 1, remark: '停用字典下的键值', enabled: true,
              createTime: '2026-11-01 10:05:00', updateTime: '2026-11-01 10:05:00' }
        ];
        var SEED_PARA = [
            { id: 'sp-0000-4000-8000-000000000001', paraNameCn: '系统名称', paraNameEn: 'site_name',
              paraValue: '九豆综合管理平台', sortNo: 1, remark: '显示在顶部导航与登录页', enabled: true,
              createTime: '2026-11-01 09:00:00', updateTime: '2026-11-01 09:00:00' },
            { id: 'sp-0000-4000-8000-000000000002', paraNameCn: '令牌有效期', paraNameEn: 'token_expire_hours',
              paraValue: '8', sortNo: 2, remark: '单位：小时', enabled: true,
              createTime: '2026-11-01 09:01:00', updateTime: '2026-11-01 09:01:00' },
            { id: 'sp-0000-4000-8000-000000000003', paraNameCn: '每页条数', paraNameEn: 'page_size',
              paraValue: '10', sortNo: 3, remark: '列表默认分页大小', enabled: true,
              createTime: '2026-11-01 09:02:00', updateTime: '2026-11-01 09:02:00' },
            { id: 'sp-0000-4000-8000-000000000004', paraNameCn: '维护公告', paraNameEn: 'maintenance_notice',
              paraValue: '', sortNo: 4, remark: '暂时停用', enabled: false,
              createTime: '2026-11-01 09:03:00', updateTime: '2026-11-01 09:03:00' }
        ];
        var memDict = null, memItem = null, memPara = null;

        function rd(key, mem, seed) {
            try {
                var raw = window.localStorage.getItem(key);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            if (mem) { return mem; }
            var rows = clone(seed);
            wr(key, rows);
            return rows;
        }
        function wr(key, rows) {
            if (key === SYSDICT_KEY) { memDict = rows; }
            else if (key === SYSDICTITEMS_KEY) { memItem = rows; }
            else { memPara = rows; }
            try { window.localStorage.setItem(key, JSON.stringify(rows)); } catch (e) { }
        }
        function readDict() { return rd(SYSDICT_KEY, memDict, SEED_DICT); }
        function readItem() { return rd(SYSDICTITEMS_KEY, memItem, SEED_ITEMS); }
        function readPara() { return rd(SYSPARA_KEY, memPara, SEED_PARA); }

        function ok(data) { return { code: 0, message: 'ok', data: data }; }
        function err(message, code) { return { code: code || 500, message: message }; }
        function s(v) { return String(v == null ? '' : v).replace(/^\s+|\s+$/g, ''); }
        function b(v, def) {
            if (v === undefined || v === null || v === '') { return !!def; }
            return !(v === 0 || v === '0' || v === false || v === 'false');
        }
        function i(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
        function find(rows, id) {
            for (var k = 0; k < rows.length; k++) {
                if (String(rows[k].id) === String(id)) { return rows[k]; }
            }
            return null;
        }
        function paging(list, params) {
            var num = Math.max(1, parseInt(params.pageNum, 10) || 1);
            var size = Math.min(Math.max(parseInt(params.pageSize, 10) || 10, 1), 200);
            var pages = Math.max(1, Math.ceil(list.length / size));
            num = Math.min(num, pages);
            return { list: list.slice((num - 1) * size, num * size),
                     total: list.length, pageNum: num, pageSize: size, pages: pages };
        }
        function matchEnabled(row, value) {
            if (value === undefined || value === null || String(value) === '') { return true; }
            return !!row.enabled === b(value, false);
        }
        function nameEn(value, label) {
            var v = s(value);
            if (!v) { return { e: label + '不能为空' }; }
            if (v.length > 100) { return { e: label + '最多 100 个字符' }; }
            if (!SYS_NAME_EN_RE.test(v)) {
                return { e: label + '只能以字母开头，且只能包含字母、数字、下划线、点、横线' };
            }
            return { v: v };
        }
        function unique(rows, field, value, selfId) {
            var v = s(value).toLowerCase();
            if (!v) { return true; }
            for (var k = 0; k < rows.length; k++) {
                if (String(rows[k].id) === String(selfId || '')) { continue; }
                if (s(rows[k][field]).toLowerCase() === v) { return false; }
            }
            return true;
        }
        function common(one, params, isEdit) {
            one.sortNo = params.sortNo === undefined ? (isEdit ? one.sortNo : 0) : i(params.sortNo);
            if (params.remark !== undefined) { one.remark = s(params.remark).slice(0, 500); }
            if (params.enabled !== undefined) { one.enabled = b(params.enabled, true); }
            one.updateTime = now();
            return one;
        }

        /* ---------------- 展示字段（与后端 _attach 同口径） ---------------- */
        function attachDict(one, dicts, items) {
            var out = clone(one);
            out.enabled = !!out.enabled;
            out.sortNo = i(out.sortNo);
            out.remark = out.remark || '';
            out.parentId = out.parentId || '';
            var parent = find(dicts, out.parentId);
            out.parentName = parent ? parent.dictNameCn : '';
            var level = 1, cur = out.parentId, chain = [], guard = 0;
            while (cur && guard < 7) {
                var p = find(dicts, cur);
                if (!p) { break; }
                chain.push(p.dictNameCn || '');
                level++; cur = p.parentId || ''; guard++;
            }
            out.level = level;
            out.pathNames = chain.reverse().join(' / ');
            var n = 0;
            for (var k = 0; k < items.length; k++) {
                if (String(items[k].dictId) === String(out.id)) { n++; }
            }
            out.itemCount = n;
            out.createTime = out.createTime || '';
            out.updateTime = out.updateTime || out.createTime || '';
            return out;
        }
        function attachItem(one, dicts) {
            var out = clone(one);
            out.enabled = !!out.enabled;
            out.sortNo = i(out.sortNo);
            out.remark = out.remark || '';
            out.itemKey = out.itemKey || '';
            out.itemValue = out.itemValue || '';
            var d = find(dicts, out.dictId) || {};
            out.dictNameCn = d.dictNameCn || '';
            out.dictNameEn = d.dictNameEn || '';
            out.createTime = out.createTime || '';
            out.updateTime = out.updateTime || out.createTime || '';
            return out;
        }
        function attachPara(one) {
            var out = clone(one);
            out.enabled = !!out.enabled;
            out.sortNo = i(out.sortNo);
            out.remark = out.remark || '';
            out.paraValue = out.paraValue || '';
            out.createTime = out.createTime || '';
            out.updateTime = out.updateTime || out.createTime || '';
            return out;
        }
        function byDict(a, b) {
            return (i(a.sortNo) - i(b.sortNo)) ||
                String(a.dictNameEn || '').localeCompare(String(b.dictNameEn || ''));
        }
        function byItem(a, b) {
            return (i(a.sortNo) - i(b.sortNo)) || String(a.id).localeCompare(String(b.id));
        }
        function byPara(a, b) {
            return (i(a.sortNo) - i(b.sortNo)) ||
                String(a.paraNameEn || '').localeCompare(String(b.paraNameEn || ''));
        }

        /* ================= sysdict（系统字典） ================= */
        function dictRoute(method, path, params) {
            params = params || {};
            var dicts = readDict(), items = readItem(), k, one, list, pg;
            if (path === '/list') {
                list = [];
                var kw = s(params.keyword).toLowerCase(), pid = s(params.parentId);
                for (k = 0; k < dicts.length; k++) {
                    one = dicts[k];
                    if (!matchEnabled(one, params.enabled)) { continue; }
                    if (pid && String(one.parentId || '') !== pid) { continue; }
                    if (kw && String([one.dictNameCn, one.dictNameEn, one.remark].join(' '))
                        .toLowerCase().indexOf(kw) < 0) { continue; }
                    list.push(one);
                }
                list.sort(byDict);
                pg = paging(list, params);
                var out = [];
                for (k = 0; k < pg.list.length; k++) { out.push(attachDict(pg.list[k], dicts, items)); }
                return ok({ list: out, total: pg.total, pageNum: pg.pageNum,
                            pageSize: pg.pageSize, pages: pg.pages });
            }
            if (path === '/detail') {
                one = find(dicts, params.id);
                if (!one) { return err('系统字典不存在或已被删除', 404); }
                return ok(attachDict(one, dicts, items));
            }
            if (path === '/check') {
                var field = s(params.field) || 'dictNameEn';
                if (field !== 'dictNameEn') { return err('不支持的唯一性校验字段：' + field); }
                if (!s(params.value)) { return ok({ unique: true }); }
                return ok({ unique: unique(dicts, field, params.value, params.id) });
            }
            if (path === '/tree') {
                var ex = s(params.excludeId), banned = [];
                if (ex) {
                    banned.push(ex);
                    var stack = [ex];
                    while (stack.length) {
                        var cur = stack.pop();
                        for (k = 0; k < dicts.length; k++) {
                            if (String(dicts[k].parentId || '') === cur &&
                                banned.indexOf(String(dicts[k].id)) < 0) {
                                banned.push(String(dicts[k].id));
                                stack.push(String(dicts[k].id));
                            }
                        }
                    }
                }
                var children = {}, ids = {};
                for (k = 0; k < dicts.length; k++) {
                    ids[String(dicts[k].id)] = true;
                    var p = String(dicts[k].parentId || '');
                    if (!children[p]) { children[p] = []; }
                    children[p].push(dicts[k]);
                }
                for (var key in children) {
                    if (children.hasOwnProperty(key)) { children[key].sort(byDict); }
                }
                var out2 = [];
                function walk(node, level) {
                    var uid = String(node.id);
                    if (banned.indexOf(uid) >= 0) { return; }
                    var indent = new Array(level).join('　') + (level > 1 ? '└ ' : '');
                    out2.push({ id: uid, parentId: String(node.parentId || ''), level: level,
                                dictNameCn: node.dictNameCn || '', dictNameEn: node.dictNameEn || '',
                                sortNo: i(node.sortNo), enabled: !!node.enabled,
                                childCount: (children[uid] || []).length,
                                leaf: !(children[uid] || []).length,
                                label: indent + (node.dictNameCn || '') + '（' + (node.dictNameEn || '') + '）' });
                    var kids = children[uid] || [];
                    for (var q = 0; q < kids.length; q++) { walk(kids[q], level + 1); }
                }
                var roots = [];
                for (k = 0; k < dicts.length; k++) {
                    if (!ids[String(dicts[k].parentId || '')]) { roots.push(dicts[k]); }
                }
                roots.sort(byDict);
                for (k = 0; k < roots.length; k++) { walk(roots[k], 1); }
                return ok({ list: out2 });
            }
            if (path === '/options') {
                list = dicts.filter(function (x) { return !!x.enabled; }).sort(byDict);
                var opts = [];
                for (k = 0; k < list.length && k < 200; k++) {
                    opts.push({ id: list[k].id, dictNameCn: list[k].dictNameCn,
                                dictNameEn: list[k].dictNameEn, sortNo: i(list[k].sortNo),
                                label: (list[k].dictNameCn || '') + '（' + (list[k].dictNameEn || '') + '）' });
                }
                return ok({ list: opts });
            }
            if (path === '/add' || path === '/update') {
                var isEdit = path === '/update';
                var target = isEdit ? find(dicts, params.id) : null;
                if (isEdit && !target) { return err('系统字典不存在或已被删除', 404); }
                var cn = s(params.dictNameCn) || (target ? target.dictNameCn : '');
                if (!cn) { return err('键中文名不能为空'); }
                if (cn.length > 150) { return err('键中文名最多 150 个字符'); }
                var enRes = nameEn(params.dictNameEn !== undefined ? params.dictNameEn :
                                   (target ? target.dictNameEn : ''), '键英文名');
                if (enRes.e) { return err(enRes.e); }
                var en = enRes.v;
                if (!unique(dicts, 'dictNameEn', en, params.id)) {
                    return err('键英文名【' + en + '】已存在，请换一个');
                }
                var parent = params.parentId !== undefined ? s(params.parentId) :
                             (target ? s(target.parentId) : '');
                var selfId = isEdit ? String(target.id) : '';
                if (parent) {
                    if (parent === selfId) { return err('上级字典不能是自己'); }
                    if (!find(dicts, parent)) { return err('上级字典不存在或已被删除', 404); }
                    if (selfId) {
                        var seen = [], st = [selfId];
                        while (st.length) {
                            var c = st.pop();
                            for (k = 0; k < dicts.length; k++) {
                                if (String(dicts[k].parentId || '') === c &&
                                    seen.indexOf(String(dicts[k].id)) < 0) {
                                    seen.push(String(dicts[k].id));
                                    st.push(String(dicts[k].id));
                                }
                            }
                        }
                        if (seen.indexOf(parent) >= 0) {
                            return err('不能把字典移动到自己的下级字典之下');
                        }
                    }
                }
                var t = now();
                if (isEdit) {
                    target.dictNameCn = cn;
                    target.dictNameEn = en;
                    target.parentId = parent;
                    common(target, params, true);
                    wr(SYSDICT_KEY, dicts);
                    return ok(attachDict(target, dicts, items));
                }
                one = { id: mockUuid(), dictNameCn: cn, dictNameEn: en, parentId: parent,
                        sortNo: 0, remark: '', enabled: true, createTime: t, updateTime: t };
                common(one, params, false);
                dicts.push(one);
                wr(SYSDICT_KEY, dicts);
                return ok(attachDict(one, dicts, items));
            }
            if (path === '/delete') {
                one = find(dicts, params.id);
                if (!one) { return err('系统字典不存在或已被删除', 404); }
                var left = [], leftItems = [], removed = 0, kids = 0;
                for (k = 0; k < dicts.length; k++) {
                    if (String(dicts[k].id) === String(params.id)) { continue; }
                    if (String(dicts[k].parentId || '') === String(params.id)) {
                        dicts[k].parentId = ''; kids++;
                    }
                    left.push(dicts[k]);
                }
                for (k = 0; k < items.length; k++) {
                    if (String(items[k].dictId) === String(params.id)) { removed++; }
                    else { leftItems.push(items[k]); }
                }
                wr(SYSDICT_KEY, left);
                wr(SYSDICTITEMS_KEY, leftItems);
                var out3 = attachDict(one, left, leftItems);
                out3.deletedItems = removed;
                out3.detachedChildren = kids;
                out3.message = '字典「' + one.dictNameCn + '」已删除（清理 ' + removed +
                               ' 条键值，' + kids + ' 个子字典升为顶级）';
                return ok(out3);
            }
            if (path === '/enabled') {
                one = find(dicts, params.id);
                if (!one) { return err('系统字典不存在或已被删除', 404); }
                one.enabled = b(params.enabled, true);
                wr(SYSDICT_KEY, dicts);
                var out4 = attachDict(one, dicts, items);
                out4.message = '系统字典「' + one.dictNameCn + '」已' + (one.enabled ? '启用' : '停用');
                return ok(out4);
            }
            return { code: 404, message: '接口不存在：/sysdict' + path };
        }

        /* ================= sysdictitems（字典键值） ================= */
        function itemRoute(method, path, params) {
            params = params || {};
            var dicts = readDict(), items = readItem(), k, one, list, pg;
            if (path === '/list') {
                list = [];
                var kw = s(params.keyword).toLowerCase(), dictId = s(params.dictId);
                for (k = 0; k < items.length; k++) {
                    one = items[k];
                    if (!matchEnabled(one, params.enabled)) { continue; }
                    if (dictId && String(one.dictId) !== dictId) { continue; }
                    if (kw && String([one.itemKey, one.itemValue, one.remark].join(' '))
                        .toLowerCase().indexOf(kw) < 0) { continue; }
                    list.push(one);
                }
                list.sort(byItem);
                pg = paging(list, params);
                var out = [];
                for (k = 0; k < pg.list.length; k++) { out.push(attachItem(pg.list[k], dicts)); }
                return ok({ list: out, total: pg.total, pageNum: pg.pageNum,
                            pageSize: pg.pageSize, pages: pg.pages });
            }
            if (path === '/detail') {
                one = find(items, params.id);
                if (!one) { return err('字典键值不存在或已被删除', 404); }
                return ok(attachItem(one, dicts));
            }
            if (path === '/check') {
                var field = s(params.field) || 'itemKey';
                if (field !== 'itemKey') { return err('不支持的唯一性校验字段：' + field); }
                var val = s(params.value), did = s(params.dictId);
                if (!val || !did) { return ok({ unique: true }); }
                for (k = 0; k < items.length; k++) {
                    if (String(items[k].dictId) === did &&
                        s(items[k].itemKey) === val &&
                        String(items[k].id) !== String(params.id || '')) {
                        return ok({ unique: false });
                    }
                }
                return ok({ unique: true });
            }
            if (path === '/add' || path === '/update') {
                var isEdit = path === '/update';
                var target = isEdit ? find(items, params.id) : null;
                if (isEdit && !target) { return err('字典键值不存在或已被删除', 404); }
                var did2 = s(params.dictId) || (target ? target.dictId : '');
                if (!did2) { return err('请选择所属字典'); }
                if (!find(dicts, did2)) { return err('所属字典不存在或已被删除', 404); }
                var value = s(params.itemValue) || (target ? target.itemValue : '');
                if (!value) { return err('键值不能为空'); }
                if (value.length > 300) { return err('键值最多 300 个字符'); }
                var key = params.itemKey !== undefined ? s(params.itemKey) :
                          (target ? s(target.itemKey) : '');
                if (key.length > 150) { return err('键最多 150 个字符'); }
                if (key) {
                    for (k = 0; k < items.length; k++) {
                        if (String(items[k].dictId) === did2 && s(items[k].itemKey) === key &&
                            String(items[k].id) !== String(params.id || '')) {
                            return err('该字典下键【' + key + '】已存在，请换一个');
                        }
                    }
                }
                var t2 = now();
                if (isEdit) {
                    target.dictId = did2; target.itemKey = key; target.itemValue = value;
                    common(target, params, true);
                    wr(SYSDICTITEMS_KEY, items);
                    return ok(attachItem(target, dicts));
                }
                one = { id: mockUuid(), dictId: did2, itemKey: key, itemValue: value,
                        sortNo: 0, remark: '', enabled: true, createTime: t2, updateTime: t2 };
                common(one, params, false);
                items.push(one);
                wr(SYSDICTITEMS_KEY, items);
                return ok(attachItem(one, dicts));
            }
            if (path === '/delete') {
                one = find(items, params.id);
                if (!one) { return err('字典键值不存在或已被删除', 404); }
                var left = [];
                for (k = 0; k < items.length; k++) {
                    if (String(items[k].id) !== String(params.id)) { left.push(items[k]); }
                }
                wr(SYSDICTITEMS_KEY, left);
                var out2 = attachItem(one, dicts);
                out2.message = '字典键值「' + one.itemValue + '」已删除';
                return ok(out2);
            }
            if (path === '/enabled') {
                one = find(items, params.id);
                if (!one) { return err('字典键值不存在或已被删除', 404); }
                one.enabled = b(params.enabled, true);
                wr(SYSDICTITEMS_KEY, items);
                var out3 = attachItem(one, dicts);
                out3.message = '字典键值「' + one.itemValue + '」已' + (one.enabled ? '启用' : '停用');
                return ok(out3);
            }
            return { code: 404, message: '接口不存在：/sysdictitems' + path };
        }

        /* ================= syspara（系统参数） ================= */
        function paraRoute(method, path, params) {
            params = params || {};
            var rows = readPara(), k, one, list, pg;
            if (path === '/list') {
                list = [];
                var kw = s(params.keyword).toLowerCase();
                for (k = 0; k < rows.length; k++) {
                    one = rows[k];
                    if (!matchEnabled(one, params.enabled)) { continue; }
                    if (kw && String([one.paraNameCn, one.paraNameEn, one.paraValue, one.remark]
                        .join(' ')).toLowerCase().indexOf(kw) < 0) { continue; }
                    list.push(one);
                }
                list.sort(byPara);
                pg = paging(list, params);
                var out = [];
                for (k = 0; k < pg.list.length; k++) { out.push(attachPara(pg.list[k])); }
                return ok({ list: out, total: pg.total, pageNum: pg.pageNum,
                            pageSize: pg.pageSize, pages: pg.pages });
            }
            if (path === '/detail') {
                one = find(rows, params.id);
                if (!one) { return err('系统参数不存在或已被删除', 404); }
                return ok(attachPara(one));
            }
            if (path === '/check') {
                var field = s(params.field) || 'paraNameEn';
                if (field !== 'paraNameEn') { return err('不支持的唯一性校验字段：' + field); }
                if (!s(params.value)) { return ok({ unique: true }); }
                return ok({ unique: unique(rows, field, params.value, params.id) });
            }
            if (path === '/add' || path === '/update') {
                var isEdit = path === '/update';
                var target = isEdit ? find(rows, params.id) : null;
                if (isEdit && !target) { return err('系统参数不存在或已被删除', 404); }
                var cn = s(params.paraNameCn) || (target ? target.paraNameCn : '');
                if (!cn) { return err('参数中文名不能为空'); }
                if (cn.length > 150) { return err('参数中文名最多 150 个字符'); }
                var enRes = nameEn(params.paraNameEn !== undefined ? params.paraNameEn :
                                   (target ? target.paraNameEn : ''), '参数英文名');
                if (enRes.e) { return err(enRes.e); }
                var en = enRes.v;
                if (!unique(rows, 'paraNameEn', en, params.id)) {
                    return err('参数英文名【' + en + '】已存在，请换一个');
                }
                var value = params.paraValue !== undefined ? s(params.paraValue) :
                            (target ? s(target.paraValue) : '');
                if (value.length > 1000) { return err('参数值最多 1000 个字符'); }
                var t = now();
                if (isEdit) {
                    target.paraNameCn = cn; target.paraNameEn = en; target.paraValue = value;
                    common(target, params, true);
                    wr(SYSPARA_KEY, rows);
                    return ok(attachPara(target));
                }
                one = { id: mockUuid(), paraNameCn: cn, paraNameEn: en, paraValue: value,
                        sortNo: 0, remark: '', enabled: true, createTime: t, updateTime: t };
                common(one, params, false);
                rows.push(one);
                wr(SYSPARA_KEY, rows);
                return ok(attachPara(one));
            }
            if (path === '/delete') {
                one = find(rows, params.id);
                if (!one) { return err('系统参数不存在或已被删除', 404); }
                var left = [];
                for (k = 0; k < rows.length; k++) {
                    if (String(rows[k].id) !== String(params.id)) { left.push(rows[k]); }
                }
                wr(SYSPARA_KEY, left);
                var out2 = attachPara(one);
                out2.message = '系统参数「' + one.paraNameCn + '」已删除';
                return ok(out2);
            }
            if (path === '/enabled') {
                one = find(rows, params.id);
                if (!one) { return err('系统参数不存在或已被删除', 404); }
                one.enabled = b(params.enabled, true);
                wr(SYSPARA_KEY, rows);
                var out3 = attachPara(one);
                out3.message = '系统参数「' + one.paraNameCn + '」已' + (one.enabled ? '启用' : '停用');
                return ok(out3);
            }
            return { code: 404, message: '接口不存在：/syspara' + path };
        }

        return {
            sysdict: { route: dictRoute, raw: readDict },
            sysdictitems: { route: itemRoute, raw: readItem },
            syspara: { route: paraRoute, raw: readPara }
        };
    }

    var sysConfigMocks = createSysConfigMockServices();
    var sysDictSvc = sysConfigMocks.sysdict;
    var sysDictItemSvc = sysConfigMocks.sysdictitems;
    var sysParaSvc = sysConfigMocks.syspara;


    /* =====================================================================
       数据中心 · 应用架构（应用信息 / 应用结构 / 版本脚本 / 实库对比）Mock
       ---------------------------------------------------------------------
       两份 localStorage：
         menu_admin_appinfos_v1   应用数组
         menu_admin_appschema_v1  { 应用id: { dbs:[库], vers:[版本], compares:[对比] } }
       设计态结构与后端同构（库 → 表/视图/存储过程 → 字段）；离线没有真库，
       「实库」用上一个正式版快照代替（用于演示对比标红），脚本为示意文本。
       ===================================================================== */
    function createAppSchemaMockServices() {
        var APPINFO_KEY = 'menu_admin_appinfos_v1';
        var APPSCHEMA_KEY = 'menu_admin_appschema_v1';
        var APP_TYPES = [
            { value: 'web', label: 'Web 应用' },
            { value: 'service', label: '后台服务' },
            { value: 'app', label: '移动应用' },
            { value: 'middleware', label: '中间件' },
            { value: 'other', label: '其它' }
        ];
        var ENVS = [
            { value: 'dev', label: '开发' },
            { value: 'test', label: '测试' },
            { value: 'prod', label: '生产' }
        ];
        var LOGICAL_TYPES = [
            { value: 'VARCHAR', label: '变长字符串', hasLength: true, lengthHint: '如 100' },
            { value: 'CHAR', label: '定长字符串', hasLength: true, lengthHint: '如 10' },
            { value: 'TEXT', label: '长文本', hasLength: false },
            { value: 'INT', label: '整数', hasLength: false },
            { value: 'BIGINT', label: '长整数', hasLength: false },
            { value: 'SMALLINT', label: '短整数', hasLength: false },
            { value: 'DECIMAL', label: '精确小数', hasLength: true, lengthHint: '如 12,2' },
            { value: 'FLOAT', label: '单精度小数', hasLength: false },
            { value: 'DOUBLE', label: '双精度小数', hasLength: false },
            { value: 'BOOLEAN', label: '布尔', hasLength: false },
            { value: 'DATE', label: '日期', hasLength: false },
            { value: 'DATETIME', label: '日期时间', hasLength: false },
            { value: 'TIME', label: '时间', hasLength: false },
            { value: 'BLOB', label: '二进制', hasLength: false },
            { value: 'JSON', label: 'JSON', hasLength: false },
            { value: 'UUID', label: 'UUID', hasLength: false }
        ];
        var OBJ_TYPES = [
            { value: 'table', label: '表' },
            { value: 'view', label: '视图' },
            { value: 'procedure', label: '存储过程' },
            { value: 'function', label: '函数' },
            { value: 'trigger', label: '触发器' },
            { value: 'index', label: '索引' }
        ];
        var OBJ_LABELS = { table: '表', view: '视图', procedure: '存储过程', function: '函数',
                           trigger: '触发器', index: '索引', db: '库', column: '字段' };
        var VER_STATUS = { draft: '草稿', released: '已发布', applied: '已执行',
                           superseded: '已被取代', discarded: '已丢弃' };
        var SCRIPT_STATUS = { pending: '待执行', applied: '已执行', failed: '执行失败', skipped: '外部执行' };
        var DIFF_LABELS = { same: '一致', designOnly: '仅设计态有', dbOnly: '仅实库有',
                            attrDiff: '属性不同', orderDiff: '顺序不同' };

        function ok(data) { return { code: 0, message: 'ok', data: data }; }
        function err(message, code) { return { code: code || 500, message: message }; }
        function uid() {
            var s = '', i, chars = '0123456789abcdef';
            for (i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * 16)); }
            return s.substr(0, 8) + '-' + s.substr(8, 4) + '-4' + s.substr(13, 3) + '-a' +
                s.substr(17, 3) + '-' + s.substr(20);
        }
        function labelOf(list, value) {
            for (var i = 0; i < list.length; i++) {
                if (list[i].value === value) { return list[i].label; }
            }
            return value;
        }
        function hashOf(obj) {
            var text = JSON.stringify(obj), h1 = 0, h2 = 0, i;
            for (i = 0; i < text.length; i++) {
                h1 = (h1 * 31 + text.charCodeAt(i)) % 2147483647;
                h2 = (h2 * 131 + text.charCodeAt(i)) % 2147483629;
            }
            return h1.toString(16) + h2.toString(16);
        }
        function ispubOf(v) { return !(v === 0 || v === '0' || v === false); }
        function mockEmpId() {
            try {
                var raw = window.localStorage ? window.localStorage.getItem('menu_admin_login_v1') : '';
                var sess = raw ? JSON.parse(raw) : null;
                var u = (sess && sess.user) || {};
                return parseInt(u.empId, 10) || 0;
            } catch (e) { return 0; }
        }
        function findById(rows, id) {
            for (var i = 0; i < rows.length; i++) {
                if (String(rows[i].id) === String(id)) { return rows[i]; }
            }
            return null;
        }
        /* 离线演示用的两条应用（第二条故意不绑连接 → 演示「纯手工维护」） */
        var APP_SEED = [
            { id: 'app-0000-4000-8000-000000000001', code: 'APP0001', name: '九豆综合管理平台',
              shortName: 'menu-admin', appType: 'web', dbType: 'mysql', env: 'prod',
              dbConnId: 'db-0000-4000-8000-000000000001', deptId: '', ownerEmpId: '',
              description: '研发管理平台主应用（离线演示数据，未扫描结构）', status: true, ispub: true,
              createempinfosid: 1, lastScanTime: '', lastError: '',
              createTime: '2026-11-01 09:00:00', updateTime: '2026-11-01 09:00:00' },
            { id: 'app-0000-4000-8000-000000000002', code: 'APP0002', name: '报表服务',
              shortName: 'report-svc', appType: 'service', dbType: 'sqlite', env: 'test',
              dbConnId: '', deptId: '', ownerEmpId: '',
              description: '纯手工维护的应用（没有绑定连接，不能扫描与对比）', status: true, ispub: true,
              createempinfosid: 1, lastScanTime: '', lastError: '',
              createTime: '2026-11-01 09:10:00', updateTime: '2026-11-01 09:10:00' }
        ];

        /* ---------------- 存储 ---------------- */
        function readApps() {
            try {
                var raw = window.localStorage.getItem(APPINFO_KEY);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            var seed = clone(APP_SEED);
            writeApps(seed);
            return seed;
        }
        function writeApps(list) {
            try { window.localStorage.setItem(APPINFO_KEY, JSON.stringify(list)); } catch (e) { }
        }
        function readStore() {
            try {
                var raw = window.localStorage.getItem(APPSCHEMA_KEY);
                if (raw) { return JSON.parse(raw); }
            } catch (e) { }
            return {};
        }
        function writeStore(obj) {
            try { window.localStorage.setItem(APPSCHEMA_KEY, JSON.stringify(obj)); } catch (e) { }
        }
        function packOf(appId, create) {
            var store = readStore(), key = String(appId || '');
            if (!store[key] && create) {
                store[key] = { dbs: [], vers: [], compares: [] };
                writeStore(store);
            }
            var pack = store[key] || { dbs: [], vers: [], compares: [] };
            pack.dbs = pack.dbs || [];
            pack.vers = pack.vers || [];
            pack.compares = pack.compares || [];
            return pack;
        }
        function savePack(appId, pack) {
            var store = readStore();
            store[String(appId || '')] = pack;
            writeStore(store);
        }
        function appIdOf(nodeId, kind) {
            var store = readStore(), key, i, j, k;
            for (key in store) {
                if (!store.hasOwnProperty(key)) { continue; }
                var dbs = store[key].dbs || [];
                for (i = 0; i < dbs.length; i++) {
                    if (kind === 'db' && String(dbs[i].id) === String(nodeId)) { return key; }
                    var objs = dbs[i].objects || [];
                    for (j = 0; j < objs.length; j++) {
                        if (kind === 'obj' && String(objs[j].id) === String(nodeId)) { return key; }
                    }
                }
            }
            return '';
        }
        function resolveApp(params) {
            var appId = params.appId || appIdOf(params.id, 'db') || appIdOf(params.id, 'obj') ||
                appIdOf(params.objId, 'obj') || '';
            var row = findById(readApps(), appId);
            if (!row) { throw new Error('应用不存在或已被删除'); }
            return row;
        }

        /* ---------------- 应用行装饰 ---------------- */
        function attachApp(one) {
            var out = clone(one), pack = packOf(out.id, false), i, objCount = 0, tableCount = 0;
            for (i = 0; i < pack.dbs.length; i++) {
                var objs = pack.dbs[i].objects || [], j;
                objCount += objs.length;
                for (j = 0; j < objs.length; j++) { if (objs[j].objType === 'table') { tableCount++; } }
            }
            out.status = out.status !== false && String(out.status) !== '0';
            out.ispub = ispubOf(out.ispub);
            out.ispubText = out.ispub ? '公用' : '私有';
            out.dbType = String(out.dbType || 'mysql').toLowerCase();
            out.dbTypeLabel = labelOf(DBINFO_TYPES, out.dbType);
            out.appTypeLabel = labelOf(APP_TYPES, out.appType);
            out.envLabel = labelOf(ENVS, out.env);
            out.hasConn = !!out.dbConnId;
            out.connName = out.connName || '';
            out.dbCount = pack.dbs.length;
            out.objCount = objCount;
            out.tableCount = tableCount;
            out.lastScanTime = out.lastScanTime || '';
            out.lastError = out.lastError || '';
            out.ownerName = out.ownerName || '';
            out.deptName = out.deptName || '';
            out.createempinfosid = parseInt(out.createempinfosid, 10) || 0;
            return out;
        }
        function nextCode(rows) {
            var max = 0, i;
            for (i = 0; i < rows.length; i++) {
                var code = String(rows[i].code || '');
                if (!/^APP\d{4}$/.test(code)) { continue; }
                max = Math.max(max, parseInt(code.substr(3), 10) || 0);
            }
            var seq = max + 1;
            while (seq <= 9999) {
                var cand = 'APP' + padNum(seq, 4), dup = false;
                for (i = 0; i < rows.length; i++) { if (String(rows[i].code) === cand) { dup = true; } }
                if (!dup) { return cand; }
                seq++;
            }
            return 'APP9999';
        }
        function normalizeApp(data, current) {
            current = current || {};
            var name = String(data.name === undefined ? current.name : data.name || '').trim();
            if (!name) { throw new Error('应用名称不能为空'); }
            var dbType = String(data.dbType === undefined ? (current.dbType || 'mysql') : data.dbType || 'mysql').toLowerCase();
            var dbConnId = data.dbConnId === undefined ? (current.dbConnId || '') : String(data.dbConnId || '');
            return {
                code: String(data.code === undefined ? (current.code || '') : data.code || '').trim(),
                name: name,
                shortName: String(data.shortName === undefined ? (current.shortName || '') : data.shortName || '').trim(),
                appType: String(data.appType === undefined ? (current.appType || 'web') : data.appType || 'web'),
                dbType: dbType,
                env: String(data.env === undefined ? (current.env || 'dev') : data.env || 'dev'),
                dbConnId: dbConnId,
                deptId: data.deptId === undefined ? (current.deptId || '') : String(data.deptId || ''),
                ownerEmpId: data.ownerEmpId === undefined ? (current.ownerEmpId || '') : String(data.ownerEmpId || ''),
                description: String(data.description === undefined ? (current.description || '') : data.description || ''),
                status: data.status === undefined ? (current.status === false ? false : true) : !!(data.status && String(data.status) !== '0'),
                ispub: data.ispub === undefined ? ispubOf(current.ispub) : ispubOf(data.ispub)
            };
        }

        /* ---------------- 快照 / 差异 ---------------- */
        function snapshotOf(pack) {
            var out = { databases: [] }, i, j;
            for (i = 0; i < pack.dbs.length; i++) {
                var db = pack.dbs[i], objs = [];
                for (j = 0; j < (db.objects || []).length; j++) {
                    var ob = db.objects[j];
                    objs.push({ objName: ob.objName, objType: ob.objType, objComment: ob.objComment || '',
                                ddl: ob.ddl || '', columns: clone(ob.columns || []) });
                }
                out.databases.push({ dbName: db.dbName, dbComment: db.dbComment || '',
                                     charset: db.charset || '', objects: objs });
            }
            return out;
        }
        /* 离线演示 · 字段血缘
           真实后端用 sqlglot 解析（视图 / 触发器 / 过程里的 SQL），这里只认最常见的
           「SELECT 别名.列 [AS 别名] ... FROM 表 别名」—— 够演示「视图字段 ← 基表字段」与页面交互。
           认不出的写法一律进 notes（口径与后端一致：宁可说“没解析出来”，也不假装没有血缘）。 */
        function mockLineage(pack) {
            var objs = {}, edges = [], notes = [], parsedObjs = 0, i, j, key;
            for (i = 0; i < (pack.dbs || []).length; i++) {
                var db = pack.dbs[i];
                for (j = 0; j < (db.objects || []).length; j++) {
                    var ob = db.objects[j];
                    objs[String(ob.objName || '').toLowerCase()] = ob;
                }
            }
            function stripName(text) { return String(text || '').replace(/[`"\[\]]/g, ''); }
            function splitTop(text) {
                var out = [], buf = '', depth = 0, k = 0, ch;
                for (; k < text.length; k++) {
                    ch = text.charAt(k);
                    if (ch === '(') { depth++; }
                    if (ch === ')') { depth--; }
                    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
                    buf += ch;
                }
                if (buf.trim()) { out.push(buf); }
                return out;
            }
            for (key in objs) {
                if (!objs.hasOwnProperty(key)) { continue; }
                var one = objs[key];
                if (!one.ddl) { continue; }
                if (one.objType === 'view' || one.objType === 'trigger' ||
                    one.objType === 'procedure' || one.objType === 'function') { parsedObjs += 1; }
                if (one.objType !== 'view') { continue; }
                var m = /select\s+([\s\S]*?)\s+from\s+([\s\S]+)$/i.exec(String(one.ddl));
                if (!m) {
                    notes.push({ objName: one.objName, objType: 'view',
                                 reason: '离线演示只解析 SELECT ... FROM 形式，完整解析请连真实后端' });
                    continue;
                }
                /* 注意 m[2] 是从 FROM 之后开始的，第一个表没有 from 前缀 → 补一个，否则
                   第一个表的别名映射不上，来源会显示成别名（e.code 而不是 empinfos.code） */
                var alias = {}, re = /(?:from|join)\s+([`"\[\]\w.]+)(?:\s+(?:as\s+)?([`"\[\]\w]+))?/ig, mm;
                while ((mm = re.exec('from ' + m[2]))) {
                    var tname = stripName(mm[1]).split('.').pop();
                    var aname = mm[2] ? stripName(mm[2]) : tname;
                    alias[aname.toLowerCase()] = tname;
                }
                /* 表达式里的「别名.列」→ 真实表（离线模式只认写了表别名的引用，够演示） */
                function qualRefs(text) {
                    var out = [], seen = {}, re2 = /([`"\[\]\w]+)\.([`"\[\]\w]+)/g, m2, t2, c2, k2;
                    while ((m2 = re2.exec(String(text || '')))) {
                        t2 = stripName(m2[1]);
                        c2 = stripName(m2[2]);
                        t2 = alias[t2.toLowerCase()] || t2;
                        k2 = (t2 + '.' + c2).toLowerCase();
                        if (seen[k2]) { continue; }
                        seen[k2] = 1;
                        out.push({ tbl: t2, col: c2 });
                    }
                    return out;
                }
                var items = splitTop(m[1]), k3;
                for (k3 = 0; k3 < items.length; k3++) {
                    var raw = items[k3].trim();
                    if (!raw) { continue; }
                    var cm = /^(?:(\w+)\.)?(\w+)(?:\s+(?:as\s+)?(\w+))?$/i.exec(raw);
                    if (cm) {
                        var tbl = cm[1] ? (alias[cm[1].toLowerCase()] || cm[1])
                                        : (Object.keys(alias).length === 1 ? alias[Object.keys(alias)[0]] : '');
                        if (!tbl) {
                            notes.push({ objName: one.objName, objType: 'view',
                                         reason: '列 ' + cm[2] + ' 没写表别名，判断不出来源' });
                            continue;
                        }
                        edges.push({ dbName: '', targetObj: one.objName, targetType: 'view',
                                     targetCol: cm[3] || cm[2], sourceObj: tbl, sourceType: 'table',
                                     sourceCol: cm[2], transform: raw, via: '', depth: 0, kind: 'view',
                                     linkType: 'DIRECT', subType: 'IDENTITY', subTypeLabel: '原样',
                                     masked: false, linkTypeLabel: '直接派生',
                                     kindLabel: '视图', depthLabel: '直接来源' });
                        continue;
                    }
                    /* 函数 / 表达式：把里面「别名.列」的引用都算成来源，类型按聚合 / 计算区分 */
                    var refs = qualRefs(raw), om = /\s+(?:as\s+)?([`"\[\]\w]+)\s*$/i.exec(raw);
                    var outName = om ? stripName(om[1]) : '';
                    if (!refs.length || !outName) {
                        notes.push({ objName: one.objName, objType: 'view',
                                     reason: '有一列是函数 / 表达式，离线演示未展开：' + raw.slice(0, 40) });
                        continue;
                    }
                    var sub = /(count|sum|avg|min|max|group_concat)\s*\(/i.test(raw) ? 'AGGREGATION' : 'TRANSFORMATION';
                    var ri;
                    for (ri = 0; ri < refs.length; ri++) {
                        edges.push({ dbName: '', targetObj: one.objName, targetType: 'view',
                                     targetCol: outName, sourceObj: refs[ri].tbl, sourceType: 'table',
                                     sourceCol: refs[ri].col, transform: raw, via: '', depth: 0, kind: 'view',
                                     linkType: 'DIRECT', subType: sub,
                                     subTypeLabel: sub === 'AGGREGATION' ? '聚合' : '计算',
                                     masked: /(md5|sha1|sha2?|hash|encrypt|mask\w*)\s*\(/i.test(raw),
                                     linkTypeLabel: '直接派生', kindLabel: '视图', depthLabel: '直接来源' });
                    }
                }
                /* 整表依赖：WHERE / JOIN ON / GROUP BY 用到的列 —— 不提供值，但决定取哪些行、怎么分组 */
                var segs = [
                    [/\bjoin\s+[`"\[\]\w.]+\s*(?:as\s+)?[`"\[\]\w]*\s*on\s+([\s\S]+?)(?=\bwhere\b|\bgroup\s+by\b|\bhaving\b|\border\s+by\b|\b(?:left|right|inner|outer|cross|full)?\s*join\b|$)/i,
                     'JOIN', '连接条件', 'ON '],
                    [/\bwhere\s+([\s\S]+?)(?=\bgroup\s+by\b|\bhaving\b|\border\s+by\b|$)/i, 'FILTER', '过滤条件', 'WHERE '],
                    [/\bgroup\s+by\s+([\s\S]+?)(?=\bhaving\b|\border\s+by\b|$)/i, 'GROUP_BY', '分组', 'GROUP BY ']
                ], si, sj;
                for (si = 0; si < segs.length; si++) {
                    var sm = segs[si][0].exec(String(one.ddl));
                    if (!sm) { continue; }
                    var srefs = qualRefs(sm[1]);
                    for (sj = 0; sj < srefs.length; sj++) {
                        edges.push({ dbName: '', targetObj: one.objName, targetType: 'view',
                                     targetCol: '', sourceObj: srefs[sj].tbl, sourceType: 'table',
                                     sourceCol: srefs[sj].col, transform: segs[si][3] + sm[1].trim(),
                                     via: '', depth: 0, kind: 'view',
                                     linkType: 'INDIRECT', subType: segs[si][1], subTypeLabel: segs[si][2],
                                     masked: false, linkTypeLabel: '间接影响',
                                     kindLabel: '视图', depthLabel: '整表依赖' });
                    }
                }
            }
            /* 每条边都要有个 id：页面上的「编辑标注 / 转手工 / 删除」都按 id 走 */
            for (i = 0; i < edges.length; i++) {
                if (!edges[i].id) { edges[i].id = 'mock-edge-' + (i + 1); }
            }
            return { edges: edges.concat(pack.lineageManual || []), notes: notes, objectCount: parsedObjs };
        }

        function colSig(c) {
            return [c.dataType || '', c.length || '', c.nullable === false ? 'N' : 'Y',
                    c.defaultValue || '', c.isPk ? 'P' : '', c.isAutoInc ? 'A' : '',
                    c.colComment || ''].join('|');
        }

        /* ---------------- 升级脚本（离线演示） ----------------
           真实后端的 DDL 由 server/schema_ddl.py 生成；离线模式这里只覆盖最常见的
           CREATE TABLE / ADD / MODIFY / DROP COLUMN，够演示「差异 → 脚本」这条链路。 */
        function mockQuote(dbType, name) {
            var t = String(dbType || 'mysql').toLowerCase();
            if (t === 'sqlserver') { return '[' + name + ']'; }
            if (t === 'mysql' || t === 'mariadb' || t === 'sqlite') { return '`' + name + '`'; }
            return '"' + name + '"';
        }
        function mockTypeText(col) {
            var t = String((col && col.dataType) || '?');
            return col && col.length ? t + '(' + col.length + ')' : t;
        }
        function mockColBrief(col) {
            var parts = [mockTypeText(col), col.nullable === false ? '非空' : '允许空'];
            if (col.defaultValue) { parts.push('默认 ' + col.defaultValue); }
            if (col.isPk) { parts.push('主键'); }
            if (col.isAutoInc) { parts.push('自增'); }
            if (col.colComment) { parts.push('注释「' + col.colComment + '」'); }
            return parts.join(' ');
        }
        function mockColDef(dbType, col) {
            var out = [mockQuote(dbType, col.colName), mockTypeText(col)];
            if (col.nullable === false) { out.push('NOT NULL'); }
            if (col.defaultValue) { out.push('DEFAULT ' + col.defaultValue); }
            if (col.isAutoInc) { out.push('AUTO_INCREMENT'); }
            return out.join(' ');
        }
        function mockColDetails(left, right) {
            var lcols = left.columns || [], rcols = right.columns || [];
            var lmap = {}, rmap = {}, details = [], parts = [], i, k;
            for (i = 0; i < lcols.length; i++) { lmap[lcols[i].colName] = lcols[i]; }
            for (i = 0; i < rcols.length; i++) { rmap[rcols[i].colName] = rcols[i]; }
            for (i = 0; i < lcols.length; i++) {
                k = lcols[i].colName;
                if (!rmap[k]) {
                    details.push({ kind: 'addCol', colName: k,
                                   text: '实库缺字段「' + k + '」：新增 ' + mockColBrief(lcols[i]) });
                    parts.push('新增字段 ' + k);
                }
            }
            for (i = 0; i < rcols.length; i++) {
                k = rcols[i].colName;
                if (!lmap[k]) {
                    details.push({ kind: 'dropCol', colName: k,
                                   text: '实库多字段「' + k + '」（设计态没有）：' + mockColBrief(rcols[i]) });
                    parts.push('删除字段 ' + k);
                }
            }
            for (i = 0; i < lcols.length; i++) {
                k = lcols[i].colName;
                if (!rmap[k]) { continue; }
                var lc = lcols[i], rc = rmap[k], fields = [];
                if (mockTypeText(lc) !== mockTypeText(rc)) {
                    fields.push('类型 ' + mockTypeText(rc) + ' → ' + mockTypeText(lc));
                }
                if ((lc.nullable !== false) !== (rc.nullable !== false)) {
                    fields.push('可空 ' + (rc.nullable !== false ? '允许' : '不允许') + ' → ' +
                        (lc.nullable !== false ? '允许' : '不允许'));
                }
                if (String(lc.defaultValue || '') !== String(rc.defaultValue || '')) {
                    fields.push('默认值 ' + (rc.defaultValue || '空') + ' → ' + (lc.defaultValue || '空'));
                }
                if (String(lc.colComment || '') !== String(rc.colComment || '')) {
                    fields.push('注释 ' + (rc.colComment ? '「' + rc.colComment + '」' : '空') + ' → ' +
                        (lc.colComment ? '「' + lc.colComment + '」' : '空'));
                }
                if (!!lc.isPk !== !!rc.isPk) {
                    fields.push('主键 ' + (rc.isPk ? '是' : '否') + ' → ' + (lc.isPk ? '是' : '否'));
                }
                if (fields.length) {
                    details.push({ kind: 'alterCol', colName: k,
                                   text: '字段「' + k + '」不同：' + fields.join('，') });
                    parts.push('修改字段 ' + k);
                }
            }
            if (!details.length) {
                var lorder = [], rorder = [];
                for (i = 0; i < lcols.length; i++) { lorder.push(lcols[i].colName); }
                for (i = 0; i < rcols.length; i++) { rorder.push(rcols[i].colName); }
                if (lorder.join(',') !== rorder.join(',')) {
                    details.push({ kind: 'order', text: '字段顺序不同：设计 ' + lorder.join(', ') +
                        '；实库 ' + rorder.join(', ') });
                    parts.push('字段顺序不同');
                }
                if (String(left.objComment || '') !== String(right.objComment || '')) {
                    details.push({ kind: 'comment', text: '表注释「' + (left.objComment || '空') +
                        '」→「' + (right.objComment || '空') + '」' });
                    parts.push('表注释不同');
                }
            }
            if (!details.length) { return { diffType: 'same', message: '', details: [] }; }
            var hasAdd = false, hasDrop = false, hasAlter = false;
            for (i = 0; i < details.length; i++) {
                if (details[i].kind === 'addCol') { hasAdd = true; }
                if (details[i].kind === 'dropCol') { hasDrop = true; }
                if (details[i].kind === 'alterCol' || details[i].kind === 'comment') { hasAlter = true; }
            }
            var diffType = hasAdd ? 'designOnly' : (hasDrop ? 'dbOnly' : '');
            if (hasAlter) { diffType = 'attrDiff'; }
            if (!diffType) { diffType = 'orderDiff'; }
            return { diffType: diffType, details: details,
                     message: (details.length > 1 ? '共 ' + details.length + ' 项：' : '') + parts.join('；') };
        }
        function mockItemDetails(item) {
            var left = item.left, right = item.right;
            var kind = (left || right || {}).objType || item.objType || 'table';
            if (item.diffType === 'same') { return []; }
            if (left && right && kind === 'table') { return mockColDetails(left, right).details; }
            if (left && !right) {
                if (kind === 'table') {
                    return [{ kind: 'create', text: '实库没有这张表，按设计态建表（' +
                        ((left.columns || []).length) + ' 个字段）' }];
                }
                return [{ kind: 'create', text: '实库没有这个' + (OBJ_LABELS[kind] || '对象') + '，按设计态创建' }];
            }
            if (right && !left) {
                if (kind === 'table') {
                    return [{ kind: 'drop', text: '实库有、设计态没有（未纳管，' +
                        ((right.columns || []).length) + ' 个字段）；默认脚本不含删除语句' }];
                }
                return [{ kind: 'drop', text: '实库有、设计态没有这个' +
                    (OBJ_LABELS[kind] || '对象') + '；默认脚本不含删除语句' }];
            }
            return [{ kind: 'rebuild', text: '定义不同，脚本按「先删后建」重建' }];
        }
        /* 删除语句：索引 / 触发器依附于表（objName 是「表名.对象名」），MySQL 系 DROP INDEX 还要带表名 */
        function mockDropSql(dbType, kind, obj) {
            var raw = String((obj || {}).objName || ''), owner = '', plain = raw;
            if (raw.indexOf('.') > -1) {
                owner = raw.split('.')[0];
                plain = raw.split('.').slice(1).join('.');
            }
            var q = mockQuote(dbType, plain), tq = mockQuote(dbType, owner);
            if (kind === 'index') {
                if ((dbType === 'mysql' || dbType === 'mariadb' || dbType === 'sqlserver') && owner) {
                    return 'DROP INDEX ' + q + ' ON ' + tq;
                }
                return 'DROP INDEX ' + q;
            }
            if (kind === 'trigger') {
                return (dbType === 'postgresql' && owner) ? ('DROP TRIGGER ' + q + ' ON ' + tq)
                    : ('DROP TRIGGER ' + q);
            }
            if (kind === 'function') { return 'DROP FUNCTION ' + q; }
            if (kind === 'view') { return 'DROP VIEW ' + q; }
            if (kind === 'procedure') { return 'DROP PROCEDURE ' + q; }
            return 'DROP TABLE ' + q;
        }

        function mockUpgradeStatements(dbType, item, includeDrop) {
            var left = item.left, right = item.right;
            var kind = (left || right || {}).objType || item.objType || 'table';
            var name = (left || right || {}).objName || '';
            var q = mockQuote(dbType, name), out = [], i, k;
            if (kind === 'db' || item.objType === 'db') {
                return { statements: [],
                         note: '库级差异不生成语句：库的创建 / 删除涉及环境与权限，请人工确认' };
            }
            if (left && !right) {
                if (kind !== 'table') {
                    /* 设计有、实库没有 = 新建：直接 CREATE，别再 DROP 一遍 */
                    return { statements: [left.ddl || ('CREATE ' + kind.toUpperCase() + ' ' + q)], note: '' };
                }
                var defs = [], pk = [];
                for (i = 0; i < (left.columns || []).length; i++) {
                    defs.push('  ' + mockColDef(dbType, left.columns[i]));
                    if (left.columns[i].isPk) { pk.push(mockQuote(dbType, left.columns[i].colName)); }
                }
                if (pk.length) { defs.push('  PRIMARY KEY (' + pk.join(',') + ')'); }
                return { statements: ['CREATE TABLE ' + q + ' (\n' + defs.join(',\n') + '\n)'], note: '' };
            }
            if (right && !left) {
                if (!includeDrop) {
                    return { statements: [],
                             note: '实库多出的对象：默认不生成删除语句（勾选「包含删除语句」才生成）' };
                }
                return { statements: [mockDropSql(dbType, kind, right)], note: '' };
            }
            if (kind !== 'table') {
                var kindLabel = OBJ_LABELS[kind] || '对象';
                return { statements: [mockDropSql(dbType, kind, right),
                                      (left.ddl || ('CREATE ' + kind.toUpperCase() + ' ' + q))],
                         note: kindLabel + '按「先删后建」重建' };
            }
            var lmap = {}, rmap = {}, extra = [];
            for (i = 0; i < (right.columns || []).length; i++) { rmap[right.columns[i].colName] = right.columns[i]; }
            for (i = 0; i < (left.columns || []).length; i++) { lmap[left.columns[i].colName] = left.columns[i]; }
            for (k in rmap) {
                if (rmap.hasOwnProperty(k) && !lmap[k]) { extra.push(k); }
            }
            if (includeDrop) {
                for (i = 0; i < extra.length; i++) {
                    out.push('ALTER TABLE ' + q + ' DROP COLUMN ' + mockQuote(dbType, extra[i]));
                }
            }
            for (i = 0; i < (left.columns || []).length; i++) {
                var lc = left.columns[i], rc = rmap[lc.colName];
                if (rc && colSig(lc) !== colSig(rc)) {
                    out.push('ALTER TABLE ' + q + ' MODIFY COLUMN ' + mockColDef(dbType, lc));
                }
            }
            for (i = 0; i < (left.columns || []).length; i++) {
                if (!rmap[left.columns[i].colName]) {
                    out.push('ALTER TABLE ' + q + ' ADD COLUMN ' + mockColDef(dbType, left.columns[i]));
                }
            }
            if (String(left.objComment || '') !== String(right.objComment || '')) {
                out.push("ALTER TABLE " + q + " COMMENT='" +
                    String(left.objComment || '').replace(/'/g, "''") + "'");
            }
            var note = (extra.length && !includeDrop)
                ? ('实库多出的字段 ' + extra.slice(0, 5).join('、') +
                   ' 默认不生成 DROP COLUMN（会丢数据）；需要彻底对齐时勾选「包含删除语句」')
                : '';
            return { statements: out, note: note };
        }
        function mockUpgradePlan(dbType, items, includeDrop) {
            var rank = { designOnly: 0, attrDiff: 1, orderDiff: 1, dbOnly: 2, same: 9 };
            var list = [], groups = [], counts = {}, notes = {}, errors = [], total = 0, covered = 0, i;
            for (i = 0; i < (items || []).length; i++) {
                if (items[i].diffType !== 'same') { list.push(items[i]); }
            }
            list.sort(function (a, b) {
                var ra = rank[a.diffType] === undefined ? 5 : rank[a.diffType];
                var rb = rank[b.diffType] === undefined ? 5 : rank[b.diffType];
                if (ra !== rb) { return ra - rb; }
                return String(a.objName) < String(b.objName) ? -1 : 1;
            });
            for (i = 0; i < list.length; i++) {
                var one = list[i], res;
                try {
                    res = mockUpgradeStatements(dbType, one, includeDrop);
                } catch (e) {
                    res = { statements: [], note: '生成失败：' + (e && e.message ? e.message : e) };
                    errors.push(one.objName);
                }
                counts[one.objName] = res.statements.length;
                if (res.note) { notes[one.objName] = res.note; }
                total += res.statements.length;
                if (res.statements.length) { covered++; }
                groups.push({ objName: one.objName, objType: one.objType, diffType: one.diffType,
                              diffLabel: DIFF_LABELS[one.diffType] || one.diffType,
                              statements: res.statements, note: res.note,
                              details: $.map(one.details || [], function (d) { return d.text; }) });
            }
            return { groups: groups, counts: counts, notes: notes, total: total,
                     objects: covered, diffCount: groups.length, errors: errors };
        }
        function mockUpgradeText(dbType, plan, meta) {
            var head = ['-- ============================================================',
                        '-- ' + (meta.appName || '应用') + ' 结构升级脚本（实库 → 设计态，目标库 ' +
                            (meta.dbName || '—') + '）',
                        '-- 数据库类型 : ' + (labelOf(DBINFO_TYPES, dbType) || dbType),
                        '-- 脚本类型   : 正向（按设计态修改数据库）',
                        '-- 生成方式   : 应用架构 · 实库对比升级（脚本不会自动执行，请人工确认后执行）',
                        '-- ============================================================'];
            var i, j;
            for (i = 0; i < (meta.notes || []).length; i++) { head.push('-- ' + meta.notes[i]); }
            var blocks = [head.join('\n')], skipped = [];
            for (i = 0; i < plan.groups.length; i++) {
                var group = plan.groups[i];
                if (!group.statements.length) { skipped.push(group); continue; }
                var lines = ['-- ------------------------------------------------------------',
                             '-- [' + (OBJ_LABELS[group.objType] || '对象') + '] ' + group.objName + ' · ' +
                                 group.diffLabel + ' · ' + group.statements.length + ' 条语句'];
                for (j = 0; j < (group.details || []).length; j++) { lines.push('--   · ' + group.details[j]); }
                if (group.note) { lines.push('--   注意：' + group.note); }
                lines.push('-- ------------------------------------------------------------');
                blocks.push(lines.join('\n') + '\n' + group.statements.join(';\n\n') + ';');
            }
            if (skipped.length) {
                var tail = ['-- ------------------------------------------------------------',
                            '-- 以下 ' + skipped.length + ' 项差异没有生成语句，需要人工处理：'];
                for (i = 0; i < skipped.length; i++) {
                    tail.push('--   · ' + skipped[i].objName +
                        (skipped[i].note ? '：' + skipped[i].note : ''));
                }
                tail.push('-- ------------------------------------------------------------');
                blocks.push(tail.join('\n'));
            }
            return blocks.join('\n\n') + '\n';
        }
        function indexSnap(snap) {
            var out = { db: {}, obj: {} }, dbs = (snap && snap.databases) || [], i, j;
            for (i = 0; i < dbs.length; i++) {
                out.db[dbs[i].dbName] = dbs[i];
                for (j = 0; j < (dbs[i].objects || []).length; j++) {
                    out.obj[dbs[i].dbName + '.' + dbs[i].objects[j].objName] =
                        { db: dbs[i].dbName, obj: dbs[i].objects[j] };
                }
            }
            return out;
        }
        function diffSnapshots(before, after) {
            var b = indexSnap(before), a = indexSnap(after), changes = [], k, i;
            for (k in b.db) {
                if (b.db.hasOwnProperty(k) && !a.db[k]) {
                    changes.push({ objType: 'db', objName: k, action: 'drop', detail: '删除库 ' + k });
                }
            }
            for (k in a.db) {
                if (a.db.hasOwnProperty(k) && !b.db[k]) {
                    changes.push({ objType: 'db', objName: k, action: 'create', detail: '新增库 ' + k });
                }
            }
            for (k in b.obj) {
                if (b.obj.hasOwnProperty(k) && !a.obj[k]) {
                    changes.push({ objType: b.obj[k].obj.objType, objName: k, action: 'drop',
                                   detail: '删除' + (OBJ_LABELS[b.obj[k].obj.objType] || '对象') + ' ' + k });
                }
            }
            for (k in a.obj) {
                if (!a.obj.hasOwnProperty(k)) { continue; }
                if (!b.obj[k]) {
                    changes.push({ objType: a.obj[k].obj.objType, objName: k, action: 'create',
                                   detail: '新增' + (OBJ_LABELS[a.obj[k].obj.objType] || '对象') + ' ' + k });
                    continue;
                }
                var bo = b.obj[k].obj, ao = a.obj[k].obj, bc = {}, ac = {}, cn;
                for (i = 0; i < (bo.columns || []).length; i++) { bc[bo.columns[i].colName] = bo.columns[i]; }
                for (i = 0; i < (ao.columns || []).length; i++) { ac[ao.columns[i].colName] = ao.columns[i]; }
                for (cn in bc) {
                    if (!bc.hasOwnProperty(cn)) { continue; }
                    if (!ac[cn]) {
                        changes.push({ objType: 'column', objName: k + '.' + cn, action: 'drop',
                                       detail: '删除字段 ' + k + '.' + cn });
                    } else if (colSig(bc[cn]) !== colSig(ac[cn])) {
                        changes.push({ objType: 'column', objName: k + '.' + cn, action: 'alter',
                                       detail: '修改字段 ' + k + '.' + cn + '（' + ac[cn].dataType +
                                           (ac[cn].length ? '(' + ac[cn].length + ')' : '') + '）' });
                    }
                }
                for (cn in ac) {
                    if (!ac.hasOwnProperty(cn) || bc[cn]) { continue; }
                    changes.push({ objType: 'column', objName: k + '.' + cn, action: 'create',
                                   detail: '新增字段 ' + k + '.' + cn });
                }
                if (String(bo.ddl || '') !== String(ao.ddl || '')) {
                    changes.push({ objType: ao.objType, objName: k, action: 'alter', detail: '定义变更 ' + k });
                }
                if (String(bo.objComment || '') !== String(ao.objComment || '')) {
                    changes.push({ objType: ao.objType, objName: k, action: 'alter', detail: '注释变更 ' + k });
                }
            }
            return changes;
        }
        function summarize(changes) {
            var c = { create: 0, alter: 0, drop: 0 }, i;
            for (i = 0; i < changes.length; i++) { c[changes[i].action] = (c[changes[i].action] || 0) + 1; }
            var parts = [];
            if (c.create) { parts.push('新增 ' + c.create); }
            if (c.alter) { parts.push('修改 ' + c.alter); }
            if (c.drop) { parts.push('删除 ' + c.drop); }
            return parts.length ? parts.join('，') : '无变更';
        }
        function buildMockScript(app, changes, kind) {
            var dbType = String(app.dbType || 'mysql').toLowerCase();
            var head = '-- ' + (app.name || '') + ' ' + (app.code || '') + ' 结构' +
                (kind === 'forward' ? '变更' : '回滚') + '脚本（' + labelOf(DBINFO_TYPES, dbType) + '）\n' +
                '-- 本地模拟服务生成，仅用于界面演示；真实脚本请连接后端后发布草稿获取\n' +
                '-- 生成时间：' + now() + '\n';
            var lines = [], i;
            for (i = 0; i < changes.length; i++) {
                var one = changes[i];
                lines.push('-- [' + (one.action === 'create' ? '新增' : (one.action === 'drop' ? '删除' : '修改')) +
                    '] ' + one.detail);
            }
            return head + '\n' + lines.join('\n') + '\n';
        }

        /* ---------------- 应用路由 ---------------- */
        /* 多选筛选参数 → 值数组（与后端 _multi_values 同口径：单值 / 逗号串 / 列表都认） */
        function multiOf(value) {
            if (value === undefined || value === null) { return []; }
            var parts = Object.prototype.toString.call(value) === '[object Array]' ? value : String(value).split(',');
            var out = [];
            for (var i = 0; i < parts.length; i++) {
                var text = String(parts[i] === undefined || parts[i] === null ? '' : parts[i]).replace(/^\s+|\s+$/g, '');
                if (text && $.inArray(text, out) < 0) { out.push(text); }
            }
            return out;
        }
        function appInfoRoute(method, path, params) {
            params = params || {};
            var rows = readApps();
            if (path === '/meta') {
                return ok({ appTypes: APP_TYPES, envs: ENVS, dbTypes: clone(DBINFO_TYPES),
                            logicalTypes: LOGICAL_TYPES, objTypes: OBJ_TYPES });
            }
            if (path === '/nextcode') { return ok({ code: nextCode(rows) }); }
            if (path === '/options') {
                var me0 = mockEmpId(), opts = [], oi;
                for (oi = 0; oi < rows.length; oi++) {
                    var ro = rows[oi];
                    if (!(ro.status !== false && String(ro.status) !== '0')) { continue; }
                    if (me0 > 0 && (parseInt(ro.createempinfosid, 10) || 0) !== me0 && !ispubOf(ro.ispub)) { continue; }
                    opts.push({ id: ro.id, code: ro.code, name: ro.name, dbType: String(ro.dbType || 'mysql').toLowerCase() });
                }
                return ok({ list: opts });
            }
            if (path === '/connections') {
                var conns = [], ci;
                try {
                    var raw = window.localStorage.getItem(DBINFO_KEY);
                    conns = raw ? JSON.parse(raw) : [];
                } catch (e) { conns = []; }
                var me1 = mockEmpId(), used = {}, ui;
                for (ui = 0; ui < rows.length; ui++) {
                    if (rows[ui].dbConnId && String(rows[ui].id) !== String(params.appId || '')) {
                        used[String(rows[ui].dbConnId)] = 1;
                    }
                }
                var outConn = [];
                for (ci = 0; ci < conns.length; ci++) {
                    var cn2 = conns[ci];
                    if (!cn2.enabled) { continue; }
                    if (me1 > 0 && (parseInt(cn2.createempinfosid, 10) || 0) !== me1 && !ispubOf(cn2.ispub)) { continue; }
                    if (used[String(cn2.id)]) { continue; }
                    outConn.push({ id: cn2.id, name: cn2.name, dbType: String(cn2.dbType || 'mysql').toLowerCase(),
                                   dbTypeLabel: labelOf(DBINFO_TYPES, String(cn2.dbType || 'mysql').toLowerCase()),
                                   host: cn2.host || '', port: cn2.port || '', dbName: cn2.dbName || '' });
                }
                return ok({ list: outConn });
            }
            if (path === '/list') {
                var me = mockEmpId(), keyword = String(params.keyword || '').toLowerCase();
                var wantTypes = multiOf(params.appType), wantDb = multiOf(params.dbType), wi;
                var list = [], i;
                for (i = 0; i < rows.length; i++) {
                    var one = rows[i];
                    if (me > 0 && (parseInt(one.createempinfosid, 10) || 0) !== me && !ispubOf(one.ispub)) { continue; }
                    if (wantTypes.length) {
                        var hitType = false;
                        for (wi = 0; wi < wantTypes.length; wi++) {
                            if (String(one.appType || '') === wantTypes[wi]) { hitType = true; }
                        }
                        if (!hitType) { continue; }
                    }
                    if (wantDb.length) {
                        var hitDb = false;
                        for (wi = 0; wi < wantDb.length; wi++) {
                            if (String(one.dbType || '').toLowerCase() === wantDb[wi].toLowerCase()) { hitDb = true; }
                        }
                        if (!hitDb) { continue; }
                    }
                    if (params.status !== undefined && String(params.status) !== '' &&
                        (one.status !== false && String(one.status) !== '0') !== (String(params.status) === '1')) { continue; }
                    if (keyword && String([one.code, one.name, one.shortName, one.description].join(' '))
                        .toLowerCase().indexOf(keyword) < 0) { continue; }
                    list.push(one);
                }
                var attach = [], ai;
                for (ai = 0; ai < list.length; ai++) { attach.push(attachApp(list[ai])); }
                attach.sort(function (a, b) {
                    if (a.status !== b.status) { return a.status ? -1 : 1; }
                    return String(a.code).localeCompare(String(b.code));
                });
                var pn = Math.max(1, parseInt(params.pageNum, 10) || 1);
                var ps = Math.min(Math.max(parseInt(params.pageSize, 10) || 10, 1), 200);
                var pages = Math.max(1, Math.ceil(attach.length / ps));
                pn = Math.min(pn, pages);
                return ok({ list: attach.slice((pn - 1) * ps, pn * ps), total: attach.length,
                            pageNum: pn, pageSize: ps, pages: pages });
            }
            if (path === '/detail') {
                var hit = findById(rows, params.id);
                if (!hit) { return err('应用不存在或已被删除', 404); }
                return ok(attachApp(hit));
            }
            if (path === '/check') {
                var field = params.field === 'name' ? 'name' : 'code';
                var value = String(params.value || '');
                if (!value) { return ok({ unique: true }); }
                var dup = null, di;
                for (di = 0; di < rows.length; di++) {
                    if (String(rows[di][field]) === value && String(rows[di].id) !== String(params.id || '')) {
                        dup = rows[di];
                    }
                }
                return ok({ unique: !dup });
            }
            if (path === '/add' || path === '/update') {
                var sameId = path === '/update' ? String(params.id || '') : '';
                var current = sameId ? findById(rows, sameId) : null;
                if (path === '/update' && !current) { return err('应用不存在或已被删除', 404); }
                var payload;
                try { payload = normalizeApp(params, current || {}); } catch (e) { return err(e.message); }
                if (sameId && payload.dbConnId && String(payload.dbConnId) !== String(current.dbConnId || '')) {
                    for (var cj = 0; cj < rows.length; cj++) {
                        if (String(rows[cj].dbConnId) === payload.dbConnId && String(rows[cj].id) !== sameId) {
                            return err('该数据库连接已被应用「' + rows[cj].name + '」占用，一个连接只能挂一个应用');
                        }
                    }
                }
                if (!sameId && payload.dbConnId) {
                    for (var ck = 0; ck < rows.length; ck++) {
                        if (String(rows[ck].dbConnId) === payload.dbConnId) {
                            return err('该数据库连接已被应用「' + rows[ck].name + '」占用，一个连接只能挂一个应用');
                        }
                    }
                }
                if (payload.dbConnId) {
                    var connType = '';
                    try {
                        var rawc = window.localStorage.getItem(DBINFO_KEY);
                        var allc = rawc ? JSON.parse(rawc) : [];
                        for (var cc = 0; cc < allc.length; cc++) {
                            if (String(allc[cc].id) === payload.dbConnId) {
                                connType = String(allc[cc].dbType || '').toLowerCase();
                            }
                        }
                    } catch (e2) { connType = ''; }
                    if (connType && connType !== payload.dbType) {
                        return err('应用的数据库类型（' + labelOf(DBINFO_TYPES, payload.dbType) +
                            '）与所选连接的类型（' + labelOf(DBINFO_TYPES, connType) + '）不一致');
                    }
                }
                if (path === '/add') {
                    var code = payload.code || nextCode(rows), codeDup = false, cd;
                    for (cd = 0; cd < rows.length; cd++) { if (String(rows[cd].code) === code) { codeDup = true; } }
                    if (codeDup) { return err('应用编码【' + code + '】已存在'); }
                    payload.id = uid();
                    payload.code = code;
                    payload.createempinfosid = mockEmpId() || 1;
                    payload.lastScanTime = '';
                    payload.lastError = '';
                    payload.createTime = now();
                    payload.updateTime = now();
                    rows.push(payload);
                    writeApps(rows);
                    var created = attachApp(payload);
                    created.message = '应用「' + payload.name + '」已创建';
                    return ok(created);
                }
                var nd;
                for (nd = 0; nd < rows.length; nd++) {
                    if (String(rows[nd].id) !== sameId) { continue; }
                    for (var nk in payload) {
                        if (payload.hasOwnProperty(nk)) { rows[nd][nk] = payload[nk]; }
                    }
                    rows[nd].updateTime = now();
                }
                writeApps(rows);
                var updated = attachApp(findById(rows, sameId));
                updated.message = '应用「' + updated.name + '」已保存';
                return ok(updated);
            }
            if (path === '/delete') {
                var delId = String(params.id || ''), idx = -1, k2;
                for (k2 = 0; k2 < rows.length; k2++) { if (String(rows[k2].id) === delId) { idx = k2; } }
                if (idx < 0) { return err('应用不存在或已被删除', 404); }
                var removed = rows.splice(idx, 1)[0];
                writeApps(rows);
                var store2 = readStore();
                delete store2[delId];
                writeStore(store2);
                return ok({ id: delId, message: '应用「' + removed.name + '」及其结构、版本、脚本已删除' });
            }
            if (path === '/enabled') {
                var enId = String(params.id || ''), en = findById(rows, enId);
                if (!en) { return err('应用不存在或已被删除', 404); }
                en.status = !!params.status && String(params.status) !== '0';
                en.updateTime = now();
                writeApps(rows);
                var enOut = attachApp(en);
                enOut.message = '应用「' + en.name + '」已' + (en.status ? '启用' : '停用');
                return ok(enOut);
            }
            return err('接口不存在：/appinfo' + path, 404);
        }

        /* ---------------- 结构路由 ---------------- */
        function verBrief(v) {
            if (!v) { return null; }
            return { id: v.id, kind: v.kind, status: v.status, seq: v.seq, versionNo: v.versionNo || '',
                     summary: v.summary || '', changeCount: v.changeCount || 0,
                     statusLabel: VER_STATUS[v.status] || v.status,
                     createTime: v.createTime || '', releaseTime: v.releaseTime || '' };
        }
        function latestVer(pack, kind, statuses) {
            var hit = null, i;
            for (i = 0; i < pack.vers.length; i++) {
                var v = pack.vers[i];
                if (kind && v.kind !== kind) { continue; }
                if (statuses && statuses.indexOf(v.status) < 0) { continue; }
                if (!hit || (parseInt(v.seq, 10) || 0) > (parseInt(hit.seq, 10) || 0)) { hit = v; }
            }
            return hit;
        }
        function findDb(pack, dbId) {
            for (var i = 0; i < pack.dbs.length; i++) {
                if (String(pack.dbs[i].id) === String(dbId)) { return pack.dbs[i]; }
            }
            return null;
        }
        function findObj(pack, objId) {
            var i, j;
            for (i = 0; i < pack.dbs.length; i++) {
                var objs = pack.dbs[i].objects || [];
                for (j = 0; j < objs.length; j++) {
                    if (String(objs[j].id) === String(objId)) { return { db: pack.dbs[i], obj: objs[j] }; }
                }
            }
            return null;
        }
        function recordVersion(app, source, summary) {
            var pack = packOf(app.id, true), snap = snapshotOf(pack), hash = hashOf(snap);
            var prev = null, i, maxSeq = 0;
            for (i = 0; i < pack.vers.length; i++) {
                var v = pack.vers[i];
                maxSeq = Math.max(maxSeq, parseInt(v.seq, 10) || 0);
                if (v.status !== 'discarded' &&
                    (!prev || (parseInt(v.seq, 10) || 0) > (parseInt(prev.seq, 10) || 0))) { prev = v; }
            }
            if (prev && prev.snapHash === hash) { return null; }
            var changes = diffSnapshots(prev ? prev.snapshot : { databases: [] }, snap);
            if (!changes.length) { return null; }
            var ver = { id: uid(), appId: app.id, kind: 'draft', status: 'draft', seq: maxSeq + 1,
                        versionNo: '', source: source || 'manual', summary: summary || summarize(changes),
                        changeCount: changes.length, snapshot: snap, snapHash: hash,
                        changes: changes, scripts: [], createTime: now(), releaseTime: '', remark: '' };
            pack.vers.push(ver);
            savePack(app.id, pack);
            return ver;
        }
        function touch(app, source, summary) {
            try { return recordVersion(app, source, summary); } catch (e) { return null; }
        }
        /* 「数据库连接」的演示兜底：没打开过连接页时 localStorage 还是空的，
           这里给两条与应用种子对应的连接，保证离线也能演示扫描（有真实 Mock 数据时以它为准） */
        var MOCK_CONN_FALLBACK = {
            'db-0000-4000-8000-000000000001': {
                id: 'db-0000-4000-8000-000000000001', name: '九豆主库（MySQL）', dbType: 'mysql',
                dbName: 'jiudou_main', username: 'jiudou'
            },
            'db-0000-4000-8000-000000000002': {
                id: 'db-0000-4000-8000-000000000002', name: '报表库（SQLite）', dbType: 'sqlite',
                dbName: 'E:/data/jiudou_report.db', username: ''
            }
        };
        /* 应用绑定的连接：Mock 里从「数据库连接」的 localStorage 取（与真实后端同口径） */
        function mockConnList() {
            var list = [];
            try {
                var raw = window.localStorage.getItem(DBINFO_KEY);
                list = raw ? JSON.parse(raw) : [];
            } catch (e) { list = []; }
            list = list || [];
            if (!list.length) {
                /* 离线演示：从没打开过「数据库连接」页时，用内置种子兜底，否则对比页一个连接都选不到 */
                for (var k in MOCK_CONN_FALLBACK) {
                    if (MOCK_CONN_FALLBACK.hasOwnProperty(k)) { list.push(MOCK_CONN_FALLBACK[k]); }
                }
            }
            return list;
        }
        function mockConn(app) {
            if (!app || !app.dbConnId) { return null; }
            var list = mockConnList();
            for (var ci = 0; ci < list.length; ci++) {
                if (String(list[ci].id) === String(app.dbConnId)) { return list[ci]; }
            }
            return MOCK_CONN_FALLBACK[app.dbConnId] || null;
        }
        /* 按 id 取连接（实库对比可以换成另一个连接，比如线上生产库） */
        function mockConnById(connId) {
            if (!connId) { return null; }
            var list = mockConnList();
            for (var ci = 0; ci < list.length; ci++) {
                if (String(list[ci].id) === String(connId)) { return list[ci]; }
            }
            return MOCK_CONN_FALLBACK[connId] || null;
        }
        /* 连接对象里指定的「默认库 / 实例」——sqlite 取文件名、oracle 取账号 schema，其余就是 dbName */
        function mockConnTarget(conn) {
            if (!conn) { return ''; }
            var name = String(conn.dbName || '').trim();
            if (!name) { return ''; }
            var tp = String(conn.dbType || '').toLowerCase();
            if (tp === 'sqlite') { return name.replace(/\\/g, '/').split('/').pop(); }
            if (tp === 'oracle') { return String(conn.username || '').toUpperCase(); }
            return name;
        }

        function treeOf(app) {
            var pack = packOf(app.id, false), out = [], i, j, objCount = 0;
            for (i = 0; i < pack.dbs.length; i++) {
                var db = pack.dbs[i], objs = db.objects || [], list = [];
                for (j = 0; j < objs.length; j++) {
                    list.push({ id: objs[j].id, objName: objs[j].objName, objType: objs[j].objType,
                                objComment: objs[j].objComment || '',
                                colCount: (objs[j].columns || []).length,
                                source: objs[j].source || 'manual', locked: !!objs[j].locked,
                                typeLabel: OBJ_LABELS[objs[j].objType] || '对象' });
                }
                /* 树里表 / 视图在前，依附于表的索引、触发器随后，过程与函数最后 */
                var TYPE_ORDER = { table: 0, view: 1, index: 2, trigger: 3, procedure: 4, function: 5 };
                list.sort(function (a, b) {
                    var ra = TYPE_ORDER[a.objType] === undefined ? 9 : TYPE_ORDER[a.objType];
                    var rb = TYPE_ORDER[b.objType] === undefined ? 9 : TYPE_ORDER[b.objType];
                    if (ra !== rb) { return ra - rb; }
                    return String(a.objName) < String(b.objName) ? -1 : 1;
                });
                objCount += list.length;
                out.push({ id: db.id, dbName: db.dbName, dbComment: db.dbComment || '',
                           charset: db.charset || '', source: db.source || 'manual',
                           locked: !!db.locked, objects: list });
            }
            var treeConn = mockConn(app);
            return {
                app: { id: app.id, code: app.code, name: app.name,
                       dbType: String(app.dbType || 'mysql').toLowerCase(),
                       dbTypeLabel: labelOf(DBINFO_TYPES, String(app.dbType || 'mysql').toLowerCase()),
                       hasConn: !!app.dbConnId, lastScanTime: app.lastScanTime || '',
                       lastError: app.lastError || '',
                       connName: treeConn ? (treeConn.name || '') : '',
                       connDbName: mockConnTarget(treeConn) },
                databases: out, dbCount: out.length, objCount: objCount,
                latest: verBrief(latestVer(pack)),
                draft: verBrief(latestVer(pack, 'draft', ['draft'])),
                release: verBrief(latestVer(pack, 'release', ['released', 'applied']))
            };
        }
        function colsPayload(pack, obj) {
            var db = null, i, cols = obj.columns || [], list = [];
            for (i = 0; i < pack.dbs.length; i++) {
                if (String(pack.dbs[i].id) === String(obj.dbId) ||
                    (pack.dbs[i].objects || []).indexOf(obj) >= 0) { db = pack.dbs[i]; }
            }
            for (i = 0; i < cols.length; i++) {
                var c = cols[i];
                list.push({ id: c.id, colName: c.colName, ordinal: parseInt(c.ordinal, 10) || (i + 1),
                            dataType: c.dataType || 'VARCHAR', length: c.length || '',
                            nullable: c.nullable !== false, defaultValue: c.defaultValue || '',
                            isPk: !!c.isPk, isAutoInc: !!c.isAutoInc, colComment: c.colComment || '',
                            source: c.source || 'manual', locked: !!c.locked });
            }
            return { object: { id: obj.id, objName: obj.objName, objType: obj.objType,
                               objComment: obj.objComment || '', ddl: obj.ddl || '',
                               dbName: db ? db.dbName : '', typeLabel: OBJ_LABELS[obj.objType] || '对象' },
                     list: list };
        }
        function colPayload(raw) {
            var name = String((raw && raw.colName) || '').trim();
            if (!name) { throw new Error('字段名不能为空'); }
            var type = String((raw && raw.dataType) || 'VARCHAR').toUpperCase(), ok2 = false, i;
            for (i = 0; i < LOGICAL_TYPES.length; i++) { if (LOGICAL_TYPES[i].value === type) { ok2 = true; } }
            if (!ok2) { throw new Error('不支持的字段类型：' + type); }
            var len = String((raw && raw.length) || '').trim();
            if (len && !/^\d+(\s*,\s*\d+)?$/.test(len)) {
                throw new Error('字段长度只允许数字，或「精度,小数位」（如 100、12,2）');
            }
            return { colName: name, dataType: type, length: len,
                     nullable: !(raw && (raw.nullable === false || raw.nullable === 0 || raw.nullable === '0')),
                     defaultValue: String((raw && raw.defaultValue) || ''),
                     isPk: !!(raw && (raw.isPk === true || raw.isPk === 1 || raw.isPk === '1')),
                     isAutoInc: !!(raw && (raw.isAutoInc === true || raw.isAutoInc === 1 || raw.isAutoInc === '1')),
                     colComment: String((raw && raw.colComment) || ''),
                     locked: !!(raw && (raw.locked === true || raw.locked === 1)) };
        }

        /* 离线「全库扫描」种子：模拟真实库扫出来的结构 */
        function scanSeed() {
            function C(n, t, len, nullable, def, pk, auto, cm) {
                return { colName: n, dataType: t, length: len || '', nullable: nullable !== false,
                         defaultValue: def || '', isPk: !!pk, isAutoInc: !!auto, colComment: cm || '' };
            }
            return [
                { dbName: 'jiudou_main', dbComment: '主库', objects: [
                    { objName: 'empinfos', objType: 'table', objComment: '员工信息', columns: [
                        C('id', 'BIGINT', '', false, '', 1, 1, '主键ID'),
                        C('code', 'VARCHAR', '16', false, '', 0, 0, '工号'),
                        C('nameCn', 'VARCHAR', '50', false, '', 0, 0, '姓名'),
                        C('phone', 'VARCHAR', '20', true, '', 0, 0, '手机号'),
                        C('deptId', 'INT', '', false, '0', 0, 0, '所属部门')
                    ] },
                    { objName: 'appinfos', objType: 'table', objComment: '应用信息', columns: [
                        C('id', 'CHAR', '36', false, '', 1, 0, '主键'),
                        C('code', 'VARCHAR', '40', false, '', 0, 0, '应用编码'),
                        C('name', 'VARCHAR', '100', false, '', 0, 0, '应用名称'),
                        C('dbType', 'VARCHAR', '30', true, 'mysql', 0, 0, '数据库类型'),
                        C('dbConnId', 'CHAR', '36', true, '', 0, 0, '绑定连接')
                    ] },
                    { objName: 'v_emp_dept', objType: 'view', objComment: '员工部门视图',
                      ddl: 'CREATE VIEW v_emp_dept AS\nSELECT e.code, e.nameCn, d.nameCn AS deptName\n' +
                           '  FROM empinfos e LEFT JOIN OrganizationStructure d ON d.id = e.deptId',
                      columns: [] },
                    /* 索引 / 触发器依附于表：objName 是「表名.对象名」；注释只写「唯一/普通 (字段)」「时机 事件」，
                       与实库扫描（connector._index_comment / _trigger_comment）保持同一个口径 */
                    { objName: 'empinfos.idx_emp_code', objType: 'index', objComment: '唯一 (code)',
                      ddl: 'CREATE UNIQUE INDEX `idx_emp_code` ON `empinfos` (`code`)', columns: [] },
                    { objName: 'appinfos.idx_app_code', objType: 'index', objComment: '唯一 (code)',
                      ddl: 'CREATE UNIQUE INDEX `idx_app_code` ON `appinfos` (`code`)', columns: [] },
                    { objName: 'empinfos.trg_emp_audit', objType: 'trigger', objComment: 'AFTER INSERT',
                      ddl: 'CREATE TRIGGER `trg_emp_audit` AFTER INSERT ON `empinfos` FOR EACH ROW\n' +
                           'BEGIN\n  INSERT INTO emp_audit(empId, action) VALUES (NEW.id, \'create\');\nEND',
                      columns: [] },
                    { objName: 'f_emp_level', objType: 'function', objComment: '按工龄算级别',
                      ddl: 'CREATE FUNCTION `f_emp_level`(years INT) RETURNS VARCHAR(20)\n' +
                           'DETERMINISTIC\nBEGIN\n  RETURN IF(years >= 10, \'资深\', \'普通\');\nEND',
                      columns: [] }
                ] },
                { dbName: 'jiudou_report', dbComment: '报表库', objects: [
                    { objName: 'rpt_sales', objType: 'table', objComment: '销售明细', columns: [
                        C('id', 'BIGINT', '', false, '', 1, 1, '主键'),
                        C('amount', 'DECIMAL', '12,2', true, '', 0, 0, '金额'),
                        C('saleDate', 'DATE', '', true, '', 0, 0, '销售日期')
                    ] },
                    { objName: 'p_rebuild_summary', objType: 'procedure', objComment: '重建汇总',
                      ddl: 'CREATE PROCEDURE p_rebuild_summary()\nBEGIN\n  TRUNCATE TABLE rpt_summary;\nEND',
                      columns: [] },
                    { objName: 'rpt_sales.idx_sale_date', objType: 'index', objComment: '普通 (saleDate)',
                      ddl: 'CREATE INDEX `idx_sale_date` ON `rpt_sales` (`saleDate`)', columns: [] }
                ] }
            ];
        }
        /* 离线 DDL 导入：CREATE TABLE / ALTER TABLE ADD COLUMN / COMMENT ON COLUMN */
        function mockParseSql(sql) {
            var text = String(sql || '').replace(/\r\n/g, '\n'), ops = [], m;
            var reTable = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(([\s\S]*?)\)\s*[^;]*;/gi;
            while ((m = reTable.exec(text))) {
                ops.push({ op: 'create_table', label: '建表', target: m[1].replace(/[`"\[\]]/g, ''),
                           name: m[1].replace(/[`"\[\]]/g, ''), message: '', body: m[2] });
            }
            var reAdd = /ALTER\s+TABLE\s+([^\s]+)\s+ADD\s+(?:COLUMN\s+)?([^\s,;]+)\s+([^,;]+)/gi;
            while ((m = reAdd.exec(text))) {
                ops.push({ op: 'alter_add_column', label: '新增字段',
                           target: m[1].replace(/[`"\[\]]/g, '') + '.' + m[2].replace(/[`"\[\]]/g, ''),
                           name: m[1].replace(/[`"\[\]]/g, ''), message: '',
                           column: { colName: m[2].replace(/[`"\[\]]/g, ''), typeText: m[3] } });
            }
            var reCmt = /COMMENT\s+ON\s+COLUMN\s+([^\s.]+)\.([^\s]+)\s+IS\s+'([^']*)'/gi;
            while ((m = reCmt.exec(text))) {
                ops.push({ op: 'comment_column', label: '字段注释',
                           target: m[1].replace(/[`"\[\]]/g, '') + '.' + m[2].replace(/[`"\[\]]/g, ''),
                           name: m[1].replace(/[`"\[\]]/g, ''), message: '',
                           column: { colName: m[2].replace(/[`"\[\]]/g, ''), comment: m[3] } });
            }
            function canon(typeText) {
                var t = String(typeText || '').toLowerCase(), mm;
                if ((mm = /^(varchar2?|nvarchar2?|char|nchar)\s*\(\s*(\d+)(?:\s*char)?\s*\)/.exec(t))) {
                    return { dataType: /^n?char/.test(mm[1]) ? 'CHAR' : 'VARCHAR', length: mm[2] };
                }
                if ((mm = /^(number|numeric|decimal)\s*\(\s*(\d+)\s*(?:,\s*(\d+))?\s*\)/.exec(t))) {
                    return { dataType: 'DECIMAL', length: mm[3] ? (mm[2] + ',' + mm[3]) : mm[2] };
                }
                if (/^(bigserial|bigint|int8)\b/.test(t)) { return { dataType: 'BIGINT', length: '' }; }
                if (/^(serial|int|integer|int4|mediumint)\b/.test(t)) { return { dataType: 'INT', length: '' }; }
                if (/^(smallint|tinyint|int2)\b/.test(t)) { return { dataType: 'SMALLINT', length: '' }; }
                if (/^(bool|boolean|bit)\b/.test(t)) { return { dataType: 'BOOLEAN', length: '' }; }
                if (/^(datetime|timestamp)/.test(t)) { return { dataType: 'DATETIME', length: '' }; }
                if (/^date/.test(t)) { return { dataType: 'DATE', length: '' }; }
                if (/^time/.test(t)) { return { dataType: 'TIME', length: '' }; }
                if (/^(double|float8)/.test(t)) { return { dataType: 'DOUBLE', length: '' }; }
                if (/^(float|real|float4)/.test(t)) { return { dataType: 'FLOAT', length: '' }; }
                if (/(blob|binary|bytea|image)/.test(t)) { return { dataType: 'BLOB', length: '' }; }
                if (/json/.test(t)) { return { dataType: 'JSON', length: '' }; }
                if (/uuid/.test(t)) { return { dataType: 'UUID', length: '' }; }
                if (/(text|clob|ntext)/.test(t) || /nvarchar\s*\(\s*max\s*\)/.test(t)) { return { dataType: 'TEXT', length: '' }; }
                return { dataType: 'VARCHAR', length: '100' };
            }
            function parseBody(body) {
                var parts = String(body || '').split('\n'), cols = [], i, j;
                for (i = 0; i < parts.length; i++) {
                    var line = $.trim(parts[i]).replace(/,$/, '');
                    if (!line) { continue; }
                    if (/^(primary|unique|key|index|constraint|foreign|check)\b/i.test(line)) {
                        var pkm = /^primary\s+key\s*\(\s*([^)]+)\)/i.exec(line);
                        if (pkm) {
                            var pkName = pkm[1].replace(/[`"\[\]\s]/g, '');
                            for (j = 0; j < cols.length; j++) { if (cols[j].colName === pkName) { cols[j].isPk = true; } }
                        }
                        continue;
                    }
                    var cm = /^(?:`|"|\[)?([A-Za-z_][\w$]*)(?:`|"|\])?\s+([\s\S]+)$/.exec(line);
                    if (!cm) { continue; }
                    var typeText = cm[2], comment = '', ccm = /\bcomment\s+'([^']*)'/i.exec(typeText);
                    if (ccm) { comment = ccm[1]; typeText = typeText.replace(ccm[0], ''); }
                    var def = '', dfm = /\bdefault\s+([^\s,]+)/i.exec(typeText);
                    if (dfm) { def = dfm[1].replace(/^'|'$/g, ''); typeText = typeText.replace(dfm[0], ''); }
                    var cn = canon(typeText);
                    cols.push({ colName: cm[1], dataType: cn.dataType, length: cn.length,
                                nullable: !/\bnot\s+null\b/i.test(typeText), defaultValue: def,
                                isPk: /\bprimary\s+key\b/i.test(typeText),
                                isAutoInc: /auto_increment|identity|serial/i.test(typeText),
                                colComment: comment });
                }
                return cols;
            }
            for (var oi = 0; oi < ops.length; oi++) {
                if (ops[oi].op === 'create_table') { ops[oi].columns = parseBody(ops[oi].body); }
                if (ops[oi].op === 'alter_add_column') {
                    var c2 = canon(ops[oi].column.typeText);
                    ops[oi].column.dataType = c2.dataType;
                    ops[oi].column.length = c2.length;
                    ops[oi].column.nullable = !/\bnot\s+null\b/i.test(ops[oi].column.typeText);
                }
            }
            if (!ops.length) {
                throw new Error('没有识别到可导入的语句（离线模式只支持 CREATE TABLE / ALTER TABLE ADD COLUMN / COMMENT ON COLUMN）');
            }
            return ops;
        }

        function schemaVersionPayload(app, pack, ver, generated) {
            var latestDraft = latestVer(pack, 'draft', ['draft']);
            return {
                version: $.extend(verBrief(ver), {
                    source: ver.source || 'manual', remark: ver.remark || '', baseVerId: ver.baseVerId || '',
                    canPublish: ver.kind === 'draft' && ver.status === 'draft' &&
                        !!latestDraft && String(latestDraft.id) === String(ver.id)
                }),
                app: { id: app.id, code: app.code, name: app.name,
                       dbType: String(app.dbType || 'mysql').toLowerCase(),
                       dbTypeLabel: labelOf(DBINFO_TYPES, String(app.dbType || 'mysql').toLowerCase()) },
                changes: clone(ver.changes || []),
                scripts: (ver.scripts || []).map(function (s) {
                    return $.extend({}, s, { kindLabel: s.kind === 'forward' ? '正向' : '回滚',
                                             statusLabel: SCRIPT_STATUS[s.status] || s.status });
                }),
                generated: generated
            };
        }

        function schemaRoute(method, path, params) {
            params = params || {};
            var app = resolveApp(params);
            var pack = packOf(app.id, true);
            var i, j;

            if (path === '/tree') { return ok(treeOf(app)); }

            /* 手工血缘边（离线演示：只存在内存里，刷新即失效 —— 真后端会落 appschemalink） */
            if (path === '/lineageedgesave') {
                var lmList = pack.lineageManual || (pack.lineageManual = []);
                var lmLink = String(params.linkType || 'DIRECT').toUpperCase();
                var lmSub = String(params.subType || (lmLink === 'DIRECT' ? 'TRANSFORMATION' : 'FILTER')).toUpperCase();
                var lmId = String(params.id || '');
                var lmEdge = null, lmi;
                for (lmi = 0; lmi < lmList.length; lmi++) {
                    if (lmId && lmList[lmi].id === lmId) { lmEdge = lmList[lmi]; }
                }
                if (!lmEdge) {
                    for (lmi = 0; lmi < lmList.length; lmi++) {
                        if (lmList[lmi].targetObj === String(params.targetObj || '') &&
                            lmList[lmi].targetCol === String(params.targetCol || '') &&
                            lmList[lmi].sourceObj === String(params.sourceObj || '') &&
                            lmList[lmi].sourceCol === String(params.sourceCol || '')) {
                            lmEdge = lmList[lmi];
                        }
                    }
                }
                if (!lmEdge) {
                    lmEdge = {
                        id: lmId || ('mock-manual-' + (lmList.length + 1)),
                        dbName: '', targetObj: String(params.targetObj || ''),
                        targetType: 'table', targetCol: String(params.targetCol || ''),
                        sourceObj: String(params.sourceObj || ''), sourceType: 'table',
                        sourceCol: String(params.sourceCol || ''), transform: String(params.transform || ''),
                        via: '', depth: 0, kind: 'manual', kindLabel: '人工标注',
                        linkType: lmLink, subType: lmSub, masked: false,
                        origin: 'manual', originLabel: '人工标注',
                        linkTypeLabel: lmLink === 'DIRECT' ? '直接派生' : '间接影响',
                        depthLabel: '人工标注'
                    };
                    lmList.push(lmEdge);
                }
                lmEdge.origin = 'manual';
                lmEdge.originLabel = '人工标注';
                lmEdge.linkType = lmLink;
                lmEdge.subType = lmSub;
                lmEdge.note = String(params.note || '');
                lmEdge.manualBy = '演示用户';
                lmEdge.updateTime = now();
                lmEdge.editable = true;
                return ok({ saved: true, edge: lmEdge, manualBy: '演示用户' });
            }
            if (path === '/lineagedgedel') {
                var ldList = pack.lineageManual || [], ld = 0;
                for (ld = ldList.length - 1; ld >= 0; ld--) {
                    if (ldList[ld].id === String(params.id || '')) { ldList.splice(ld, 1); }
                }
                return ok({ deleted: true, id: String(params.id || '') });
            }

            if (path === '/lineage' || path === '/lineagebuild') {                var lg = mockLineage(pack);
                var lgObj = String(params.objName || ''), lgCol = String(params.colName || '').toLowerCase();
                var lgLow = lgObj.toLowerCase(), lgFields = [], lgSeen = {}, lgType = '', lgi, lj, lk;
                for (lgi = 0; lgi < (pack.dbs || []).length; lgi++) {
                    for (lj = 0; lj < ((pack.dbs[lgi].objects) || []).length; lj++) {
                        var lob = pack.dbs[lgi].objects[lj];
                        if (!lgObj || String(lob.objName).toLowerCase() !== lgLow) { continue; }
                        lgType = lob.objType || '';
                        for (lk = 0; lk < (lob.columns || []).length; lk++) {
                            var lc = lob.columns[lk];
                            lgFields.push({ colName: lc.colName, colComment: lc.colComment || '',
                                            isPk: !!lc.isPk, upCount: 0, downCount: 0 });
                            lgSeen[String(lc.colName).toLowerCase()] = lgFields[lgFields.length - 1];
                        }
                    }
                }
                var lgUp = [], lgDown = [], lgRowDeps = [], lgDirect = 0, lgIndirect = 0;
                for (lgi = 0; lgi < lg.edges.length; lgi++) {
                    var le = lg.edges[lgi];
                    if (le.linkType === 'INDIRECT') { lgIndirect += 1; } else { lgDirect += 1; }
                    /* 上游只看直接派生（值从哪来）；整表依赖单独一块 */
                    if (lgObj && le.linkType !== 'INDIRECT' && String(le.targetObj).toLowerCase() === lgLow &&
                        (!lgCol || String(le.targetCol).toLowerCase() === lgCol)) {
                        lgUp.push(le);
                        var tk = String(le.targetCol).toLowerCase();
                        if (lgSeen[tk]) { lgSeen[tk].upCount += 1; }
                        else { lgSeen[tk] = { colName: le.targetCol, colComment: '', isPk: false,
                                              upCount: 1, downCount: 0 }; lgFields.push(lgSeen[tk]); }
                    }
                    /* 下游两种都算：被拿去算（DIRECT）+ 被拿去过滤 / 连接（INDIRECT） */
                    if (lgObj && String(le.sourceObj).toLowerCase() === lgLow &&
                        (!lgCol || String(le.sourceCol).toLowerCase() === lgCol)) {
                        lgDown.push(le);
                        var sk = String(le.sourceCol).toLowerCase();
                        if (lgSeen[sk]) { lgSeen[sk].downCount += 1; }
                        else { lgSeen[sk] = { colName: le.sourceCol, colComment: '', isPk: false,
                                              upCount: 0, downCount: 1 }; lgFields.push(lgSeen[sk]); }
                    }
                    if (lgObj && le.linkType === 'INDIRECT' &&
                        String(le.targetObj).toLowerCase() === lgLow) { lgRowDeps.push(le); }
                }
                var lgType2 = String(app.dbType || 'mysql').toLowerCase();
                var lgStat = { appId: app.id, builtAt: now(), edgeCount: lg.edges.length,
                               directCount: lgDirect, indirectCount: lgIndirect,
                               objectCount: lg.objectCount, noteCount: lg.notes.length,
                               dbType: lgType2, dbTypeLabel: dbinfoType(lgType2).label };
                if (path === '/lineagebuild') {
                    lgStat.notes = lg.notes.slice(0, 50);
                    return ok(lgStat);
                }
                lgStat.objName = lgObj;
                lgStat.objType = lgType;
                lgStat.fields = lgFields;
                lgStat.up = lgUp;
                lgStat.down = lgDown;
                lgStat.rowDeps = lgRowDeps;
                lgStat.notes = lg.notes;
                return ok(lgStat);
            }

            if (path === '/scaninfo') {
                var reqConn = String(params.connId || '');
                var sconn = reqConn ? mockConnById(reqConn) : mockConn(app);
                var sconnId = reqConn || (app.dbConnId || '');
                var sinfo = { hasConn: !!sconnId, connId: sconnId,
                              connName: sconn ? (sconn.name || '') : '',
                              dbType: String((sconn && sconn.dbType) || app.dbType || 'mysql').toLowerCase(),
                              dbTypeLabel: '', target: '', needPick: false, databases: [], error: '' };
                sinfo.dbTypeLabel = dbinfoType(sinfo.dbType).label;
                if (!sconnId) {
                    sinfo.error = '这个应用没有绑定数据库连接（纯手工维护），不能扫描';
                    return ok(sinfo);
                }
                if (!sconn) {
                    sinfo.error = reqConn ? '选中的数据库连接不存在或已被删除'
                                          : '应用绑定的数据库连接已被删除，请先在「应用信息」里重新绑定';
                    return ok(sinfo);
                }
                sinfo.target = mockConnTarget(sconn);
                var sseed = scanSeed(), ssi;
                for (ssi = 0; ssi < sseed.length; ssi++) {
                    sinfo.databases.push({ name: sseed[ssi].dbName, system: false,
                                           current: sseed[ssi].dbName === sinfo.target,
                                           tableCount: (sseed[ssi].objects || []).length });
                }
                sinfo.databases.push({ name: 'information_schema', system: true, current: false,
                                       tableCount: 79 });
                if (!sinfo.target) { sinfo.needPick = true; }   /* 弹窗里现场选一个，不拦人 */
                return ok(sinfo);
            }

            if (path === '/compareconns') {
                /* 可选连接：同方言族 + 可见（本人创建 / 公共）；不可见的私有连接不列 */
                var famOf = function (tp) {
                    var v = String(tp || 'mysql').toLowerCase();
                    if (v === 'mssql') { v = 'sqlserver'; }
                    return v === 'mariadb' ? 'mysql' : v;
                };
                var meC = mockEmpId(), outC = [], clist = mockConnList(), cci = 0, famApp = famOf(app.dbType);
                for (; cci < clist.length; cci++) {
                    var cc = clist[cci];
                    if (famOf(cc.dbType) !== famApp) { continue; }
                    var cpub = !(cc.ispub === false || cc.ispub === 0 || cc.ispub === '0');
                    var cowner = parseInt(cc.createempinfosid, 10) || 0;
                    if (meC && !cpub && cowner && cowner !== meC) { continue; }
                    outC.push({ id: cc.id, name: cc.name || '', dbType: famOf(cc.dbType),
                                dbTypeLabel: dbinfoType(cc.dbType).label,
                                host: cc.host || '', port: cc.port || '',
                                defaultDb: mockConnTarget(cc),
                                enabled: !(cc.enabled === false || cc.enabled === 0 || cc.enabled === '0'),
                                ispub: cpub, isBound: String(cc.id) === String(app.dbConnId) });
                }
                return ok({ appId: app.id, appDbType: famApp,
                            appDbTypeLabel: dbinfoType(famApp).label,
                            boundConnId: app.dbConnId || '', list: outC });
            }

            if (path === '/dbadd') {
                var dbName = String(params.dbName || '').trim();
                if (!dbName) { return err('库名不能为空'); }
                for (i = 0; i < pack.dbs.length; i++) {
                    if (pack.dbs[i].dbName === dbName) { return err('库【' + dbName + '】已存在'); }
                }
                pack.dbs.push({ id: uid(), appId: app.id, dbName: dbName,
                                dbComment: params.dbComment || '', charset: params.charset || '',
                                source: 'manual', locked: false, sortNo: pack.dbs.length + 1, objects: [] });
                savePack(app.id, pack);
                touch(app, 'manual', '手工新增库 ' + dbName);
                return ok(treeOf(app));
            }
            if (path === '/dbupdate') {
                var db1 = findDb(pack, params.id);
                if (!db1) { return err('库不存在或已被删除', 404); }
                var newName = String(params.dbName || db1.dbName).trim();
                for (i = 0; i < pack.dbs.length; i++) {
                    if (pack.dbs[i].dbName === newName && String(pack.dbs[i].id) !== String(db1.id)) {
                        return err('库【' + newName + '】已存在');
                    }
                }
                db1.dbName = newName;
                if (params.dbComment !== undefined) { db1.dbComment = String(params.dbComment || ''); }
                if (params.charset !== undefined) { db1.charset = String(params.charset || ''); }
                db1.locked = !!(params.locked === true || params.locked === 1 || params.locked === '1');
                savePack(app.id, pack);
                touch(app, 'manual', '修改库 ' + newName);
                return ok(treeOf(app));
            }
            if (path === '/dbdel') {
                var db2 = null, keepDb = [];
                for (i = 0; i < pack.dbs.length; i++) {
                    if (String(pack.dbs[i].id) === String(params.id)) { db2 = pack.dbs[i]; }
                    else { keepDb.push(pack.dbs[i]); }
                }
                if (!db2) { return err('库不存在或已被删除', 404); }
                pack.dbs = keepDb;
                savePack(app.id, pack);
                touch(app, 'manual', '删除库 ' + db2.dbName);
                return ok(treeOf(app));
            }
            if (path === '/objadd' || path === '/objupdate') {
                var hitObj = path === '/objupdate' ? findObj(pack, params.id) : null;
                if (path === '/objupdate' && !hitObj) { return err('对象不存在或已被删除', 404); }
                var targetDb = path === '/objadd' ? findDb(pack, params.dbId) : hitObj.db;
                if (!targetDb) { return err('库不存在或已被删除', 404); }
                var objName = String(params.objName || (hitObj ? hitObj.obj.objName : '')).trim();
                if (!objName) { return err('对象名不能为空'); }
                var objType = params.objType || (hitObj ? hitObj.obj.objType : 'table');
                for (i = 0; i < targetDb.objects.length; i++) {
                    if (targetDb.objects[i].objName === objName &&
                        String(targetDb.objects[i].id) !== String(params.id || '')) {
                        return err('对象【' + objName + '】已存在');
                    }
                }
                var ddlText = params.ddl === undefined ? (hitObj ? hitObj.obj.ddl : '') : String(params.ddl || '');
                if (objType !== 'table' && !String(ddlText || '').trim()) {
                    return err('视图 / 存储过程必须填写定义（DDL 原文）');
                }
                if (path === '/objadd') {
                    var newObj = { id: uid(), appId: app.id, dbId: targetDb.id, objName: objName, objType: objType,
                                   objComment: params.objComment || '', ddl: ddlText, engine: params.engine || '',
                                   charset: params.charset || '', source: 'manual',
                                   locked: !!(params.locked === true || params.locked === 1), columns: [] };
                    targetDb.objects.push(newObj);
                    savePack(app.id, pack);
                    touch(app, 'manual', '手工新增' + (OBJ_LABELS[objType] || '对象') + ' ' + objName);
                    return ok({ id: newObj.id, tree: treeOf(app) });
                }
                hitObj.obj.objName = objName;
                hitObj.obj.objType = objType;
                if (params.objComment !== undefined) { hitObj.obj.objComment = String(params.objComment || ''); }
                if (params.ddl !== undefined) { hitObj.obj.ddl = String(params.ddl || ''); }
                if (params.engine !== undefined) { hitObj.obj.engine = String(params.engine || ''); }
                if (params.charset !== undefined) { hitObj.obj.charset = String(params.charset || ''); }
                hitObj.obj.locked = !!(params.locked === true || params.locked === 1 || params.locked === '1');
                savePack(app.id, pack);
                touch(app, 'manual', '修改' + (OBJ_LABELS[objType] || '对象') + ' ' + objName);
                return ok({ id: hitObj.obj.id, tree: treeOf(app) });
            }
            if (path === '/objdel') {
                var delHit = findObj(pack, params.id);
                if (!delHit) { return err('对象不存在或已被删除', 404); }
                var keepObj = [];
                for (i = 0; i < delHit.db.objects.length; i++) {
                    if (String(delHit.db.objects[i].id) !== String(params.id)) { keepObj.push(delHit.db.objects[i]); }
                }
                delHit.db.objects = keepObj;
                savePack(app.id, pack);
                touch(app, 'manual', '删除' + (OBJ_LABELS[delHit.obj.objType] || '对象') + ' ' + delHit.obj.objName);
                return ok(treeOf(app));
            }
            if (path === '/cols') {
                var ch = findObj(pack, params.objId);
                if (!ch) { return err('对象不存在或已被删除', 404); }
                return ok(colsPayload(pack, ch.obj));
            }
            if (path === '/colsave') {
                var sh = findObj(pack, params.objId);
                if (!sh) { return err('对象不存在或已被删除', 404); }
                sh.obj.columns = sh.obj.columns || [];
                var rawList = params.cols || [params], maxOrd = 0, si, pl;
                for (si = 0; si < sh.obj.columns.length; si++) {
                    maxOrd = Math.max(maxOrd, parseInt(sh.obj.columns[si].ordinal, 10) || 0);
                }
                for (si = 0; si < rawList.length; si++) {
                    try { pl = colPayload(rawList[si]); } catch (e) { return err(e.message); }
                    var cid = rawList[si] && rawList[si].id;
                    if (cid) {
                        var cc = null, cj;
                        for (cj = 0; cj < sh.obj.columns.length; cj++) {
                            if (String(sh.obj.columns[cj].id) === String(cid)) { cc = sh.obj.columns[cj]; }
                        }
                        if (!cc) { return err('字段不存在或已被删除', 404); }
                        $.extend(cc, pl);
                    } else {
                        maxOrd += 1;
                        sh.obj.columns.push($.extend({ id: uid(), ordinal: maxOrd, source: 'manual' }, pl));
                    }
                }
                savePack(app.id, pack);
                touch(app, 'manual', '维护' + (OBJ_LABELS[sh.obj.objType] || '对象') + ' ' + sh.obj.objName +
                    ' 的字段（' + rawList.length + ' 个）');
                return ok(colsPayload(pack, sh.obj));
            }
            if (path === '/coldel') {
                var dh = findObj(pack, params.objId);
                if (!dh) { return err('对象不存在或已被删除', 404); }
                var colKeep = [], removed = null;
                for (i = 0; i < (dh.obj.columns || []).length; i++) {
                    if (String(dh.obj.columns[i].id) === String(params.id)) { removed = dh.obj.columns[i]; }
                    else { colKeep.push(dh.obj.columns[i]); }
                }
                if (!removed) { return err('字段不存在或已被删除', 404); }
                dh.obj.columns = colKeep;
                savePack(app.id, pack);
                touch(app, 'manual', '删除字段 ' + dh.obj.objName + '.' + removed.colName);
                return ok(colsPayload(pack, dh.obj));
            }
            if (path === '/scan') {
                if (!app.dbConnId) { return err('该应用还没有绑定数据库连接（纯手工维护），不能扫描或对比'); }
                var scanConn = mockConn(app);
                if (!scanConn) { return err('应用绑定的数据库连接已被删除，请先在「应用信息」里重新绑定'); }
                /* 只扫一个库：参数优先，否则用连接对象的「默认库」；两者都没有就拒绝，不退化成全库 */
                var onlyDb = String(params.database || '').trim() || mockConnTarget(scanConn);
                if (!onlyDb) {
                    return err('连接【' + scanConn.name + '】没有指定「默认库」，无法确定扫描哪一个库：' +
                        '请先到「数据库连接」里把默认库填成要扫描的那一个，或在扫描时选一个库');
                }
                var seed = scanSeed(), seedHit = null, shi;
                for (shi = 0; shi < seed.length; shi++) {
                    if (seed[shi].dbName === onlyDb) { seedHit = seed[shi]; }
                }
                if (!seedHit) {
                    var seedNames = [];
                    for (shi = 0; shi < seed.length; shi++) { seedNames.push(seed[shi].dbName); }
                    return err('连接【' + scanConn.name + '】里找不到库 / 实例【' + onlyDb +
                        '】：它下面能访问的是 ' + seedNames.join('、'));
                }
                seed = [seedHit];
                var stats = { databases: 0, tables: 0, views: 0, procedures: 0, functions: 0,
                              indexes: 0, triggers: 0, columns: 0,
                              added: 0, updated: 0, dropped: 0, kept: 0, skipped: 0, warnings: [],
                              target: onlyDb, scope: 'single' };
                for (i = 0; i < seed.length; i++) {
                    var sdb = seed[i];
                    var dbHit = null, li;
                    for (li = 0; li < pack.dbs.length; li++) {
                        if (pack.dbs[li].dbName === sdb.dbName) { dbHit = pack.dbs[li]; }
                    }
                    if (!dbHit) {
                        dbHit = { id: uid(), appId: app.id, dbName: sdb.dbName, dbComment: sdb.dbComment || '',
                                  charset: '', source: 'scan', locked: false,
                                  sortNo: pack.dbs.length + 1, objects: [] };
                        pack.dbs.push(dbHit);
                    }
                    stats.databases++;
                    var seen = {}, so;
                    for (so = 0; so < sdb.objects.length; so++) {
                        var src = sdb.objects[so], objHit = null, oi3;
                        for (oi3 = 0; oi3 < dbHit.objects.length; oi3++) {
                            if (dbHit.objects[oi3].objName === src.objName) { objHit = dbHit.objects[oi3]; }
                        }
                        if (!objHit) {
                            objHit = { id: uid(), objName: src.objName, objType: src.objType,
                                       objComment: src.objComment || '', ddl: src.ddl || '',
                                       source: 'scan', locked: false, columns: [] };
                            dbHit.objects.push(objHit);
                            stats.added++;
                        } else if (!objHit.locked) {
                            objHit.objType = src.objType;
                            objHit.objComment = src.objComment || '';
                            if (src.ddl) { objHit.ddl = src.ddl; }
                            stats.updated++;
                        } else {
                            stats.kept++;
                        }
                        seen[src.objName] = 1;
                        if (src.objType === 'table') { stats.tables++; }
                        else if (src.objType === 'view') { stats.views++; }
                        else if (src.objType === 'index') { stats.indexes++; }
                        else if (src.objType === 'trigger') { stats.triggers++; }
                        else if (src.objType === 'function') { stats.functions++; }
                        else { stats.procedures++; }
                        if (src.objType !== 'table') { continue; }
                        var srcCols = src.columns || [], existing = objHit.columns || [], idx = {}, ei;
                        for (ei = 0; ei < existing.length; ei++) { idx[existing[ei].colName] = existing[ei]; }
                        var finalCols = [], ord = 0, sc;
                        for (sc = 0; sc < srcCols.length; sc++) {
                            ord++;
                            var tgt = idx[srcCols[sc].colName];
                            if (tgt && !tgt.locked) {
                                tgt.dataType = srcCols[sc].dataType;
                                tgt.length = srcCols[sc].length;
                                tgt.nullable = srcCols[sc].nullable;
                                tgt.defaultValue = srcCols[sc].defaultValue;
                                tgt.isPk = srcCols[sc].isPk;
                                tgt.isAutoInc = srcCols[sc].isAutoInc;
                                tgt.colComment = srcCols[sc].colComment;
                                tgt.ordinal = ord;
                                finalCols.push(tgt);
                                stats.updated++;
                            } else if (tgt) {
                                finalCols.push(tgt);
                                stats.kept++;
                            } else {
                                finalCols.push($.extend({ id: uid(), ordinal: ord, source: 'scan', locked: false },
                                    srcCols[sc]));
                                stats.added++;
                            }
                            stats.columns++;
                        }
                        for (ei = 0; ei < existing.length; ei++) {
                            var found = false, sk;
                            for (sk = 0; sk < srcCols.length; sk++) {
                                if (srcCols[sk].colName === existing[ei].colName) { found = true; }
                            }
                            if (found) { continue; }
                            if (existing[ei].locked || existing[ei].source === 'manual') {
                                finalCols.push(existing[ei]);
                                stats.kept++;
                            } else {
                                stats.dropped++;
                            }
                        }
                        objHit.columns = finalCols;
                    }
                    var keepObjs = [], ko;
                    for (ko = 0; ko < dbHit.objects.length; ko++) {
                        var ob = dbHit.objects[ko];
                        if (seen[ob.objName]) { keepObjs.push(ob); }
                        else if (ob.locked || ob.source === 'manual') { keepObjs.push(ob); stats.kept++; }
                        else { stats.dropped++; }
                    }
                    dbHit.objects = keepObjs;
                }
                if (!stats.databases) { return err('没有扫到可导入的库：' + onlyDb); }
                var apps2 = readApps();
                for (i = 0; i < apps2.length; i++) {
                    if (String(apps2[i].id) === String(app.id)) {
                        apps2[i].lastScanTime = now();
                        apps2[i].lastError = '';
                        app = apps2[i];
                    }
                }
                writeApps(apps2);
                savePack(app.id, pack);
                var verS = recordVersion(app, 'scan', '扫描导入 ' + onlyDb + '：库 ' + stats.databases + '、表 ' + stats.tables +
                    '、视图 ' + stats.views + '、存储过程 ' + stats.procedures + '、字段 ' + stats.columns);
                stats.version = verBrief(verS);
                stats.dbType = String(app.dbType || 'mysql').toLowerCase();
                stats.dbTypeLabel = labelOf(DBINFO_TYPES, stats.dbType);
                return ok(stats);
            }
            if (path === '/parsesql') {
                var ops;
                try { ops = mockParseSql(params.sql); } catch (e) { return err('解析失败：' + e.message); }
                return ok({ ops: ops, count: ops.length });
            }
            if (path === '/importddl') {
                var ops2;
                try { ops2 = mockParseSql(params.sql); } catch (e) { return err('解析失败：' + e.message); }
                var defaultDb = String(params.dbName || '').trim();
                if (!defaultDb && pack.dbs.length) { defaultDb = pack.dbs[0].dbName; }
                if (!defaultDb) { defaultDb = 'default_db'; }
                var dbTarget = null, dg;
                for (dg = 0; dg < pack.dbs.length; dg++) {
                    if (pack.dbs[dg].dbName === defaultDb) { dbTarget = pack.dbs[dg]; }
                }
                if (!dbTarget) {
                    dbTarget = { id: uid(), appId: app.id, dbName: defaultDb, dbComment: '', charset: '',
                                 source: 'import', locked: false, sortNo: pack.dbs.length + 1, objects: [] };
                    pack.dbs.push(dbTarget);
                }
                var logs = [], ip;
                for (ip = 0; ip < ops2.length; ip++) {
                    var op = ops2[ip], objT = null, ot;
                    for (ot = 0; ot < dbTarget.objects.length; ot++) {
                        if (dbTarget.objects[ot].objName === op.name) { objT = dbTarget.objects[ot]; }
                    }
                    if (op.op === 'create_table') {
                        var created = !objT;
                        if (!objT) {
                            objT = { id: uid(), objName: op.name, objType: 'table', objComment: '',
                                     ddl: '', source: 'import', locked: false, columns: [] };
                            dbTarget.objects.push(objT);
                        }
                        var newCols = [], nc;
                        for (nc = 0; nc < op.columns.length; nc++) {
                            newCols.push($.extend({ id: uid(), ordinal: nc + 1, source: 'import', locked: false },
                                op.columns[nc]));
                        }
                        objT.columns = newCols;
                        logs.push({ ok: true, target: defaultDb + '.' + op.name,
                                    message: '建表（' + (created ? '新建' : '覆盖字段') + '）' });
                    } else if (op.op === 'alter_add_column') {
                        if (!objT) {
                            logs.push({ ok: false, target: defaultDb + '.' + op.name,
                                        message: '表不存在，先导入它的 CREATE TABLE' });
                            continue;
                        }
                        objT.columns = objT.columns || [];
                        objT.columns.push($.extend({ id: uid(), source: 'import', locked: false,
                            ordinal: objT.columns.length + 1 }, op.column));
                        logs.push({ ok: true, target: defaultDb + '.' + op.name + '.' + op.column.colName,
                                    message: '新增字段' });
                    } else if (op.op === 'comment_column') {
                        var setOk = false;
                        if (objT) {
                            for (var ck = 0; ck < (objT.columns || []).length; ck++) {
                                if (objT.columns[ck].colName === op.column.colName) {
                                    objT.columns[ck].colComment = op.column.comment;
                                    setOk = true;
                                }
                            }
                        }
                        logs.push({ ok: setOk, target: defaultDb + '.' + op.name + '.' + op.column.colName,
                                    message: setOk ? '字段注释已更新' : '找不到该字段' });
                    }
                }
                savePack(app.id, pack);
                var verI = recordVersion(app, 'import', 'DDL 导入：' + ops2.length + ' 条语句');
                return ok({ logs: logs, count: ops2.length, version: verBrief(verI), tree: treeOf(app) });
            }
            if (path === '/versions') {
                var vl = [], vi;
                for (vi = 0; vi < pack.vers.length; vi++) {
                    var vv = pack.vers[vi], brief = verBrief(vv);
                    brief.source = vv.source || 'manual';
                    brief.scripts = (vv.scripts || []).map(function (s) {
                        return { id: s.id, kind: s.kind, status: s.status,
                                 statusLabel: SCRIPT_STATUS[s.status] || s.status };
                    });
                    vl.push(brief);
                }
                vl.sort(function (a, b) { return (b.seq || 0) - (a.seq || 0); });
                return ok({ list: vl, dbType: String(app.dbType || 'mysql').toLowerCase(),
                            dbTypeLabel: labelOf(DBINFO_TYPES, String(app.dbType || 'mysql').toLowerCase()) });
            }
            if (path === '/version') {
                var hitV = null, hj;
                for (hj = 0; hj < pack.vers.length; hj++) {
                    if (String(pack.vers[hj].id) === String(params.verId || params.id)) { hitV = pack.vers[hj]; }
                }
                if (!hitV) { return err('版本不存在或已被删除', 404); }
                return ok(schemaVersionPayload(app, pack, hitV, null));
            }
            if (path === '/publish') {
                var pv = null, pj;
                for (pj = 0; pj < pack.vers.length; pj++) {
                    if (String(pack.vers[pj].id) === String(params.verId || params.id)) { pv = pack.vers[pj]; }
                }
                if (!pv) { return err('版本不存在或已被删除', 404); }
                if (pv.kind !== 'draft' || pv.status !== 'draft') { return err('只有草稿版本可以发布'); }
                var ld = latestVer(pack, 'draft', ['draft']);
                if (ld && String(ld.id) !== String(pv.id)) { return err('存在更新的草稿，请发布最新草稿'); }
                var lastRel = latestVer(pack, 'release', ['released', 'applied', 'superseded']);
                var pChanges = diffSnapshots(lastRel ? lastRel.snapshot : { databases: [] }, pv.snapshot);
                if (!pChanges.length) { return err('这个草稿与上一个正式版没有差异，不需要发布'); }
                var relCount = 0, rj;
                for (rj = 0; rj < pack.vers.length; rj++) { if (pack.vers[rj].kind === 'release') { relCount++; } }
                pv.kind = 'release';
                pv.status = 'released';
                pv.versionNo = 'v' + (relCount + 1);
                pv.summary = String(params.summary || '').trim() || summarize(pChanges);
                pv.changeCount = pChanges.length;
                pv.changes = pChanges;
                pv.releaseTime = now();
                pv.remark = params.remark || '';
                pv.baseVerId = lastRel ? lastRel.id : '';
                pv.scripts = [
                    { id: uid(), verId: pv.id, dbType: String(app.dbType || 'mysql').toLowerCase(),
                      kind: 'forward', status: 'pending', scriptText: buildMockScript(app, pChanges, 'forward') },
                    { id: uid(), verId: pv.id, dbType: String(app.dbType || 'mysql').toLowerCase(),
                      kind: 'rollback', status: 'pending', scriptText: buildMockScript(app, pChanges, 'rollback') }
                ];
                for (rj = 0; rj < pack.vers.length; rj++) {
                    var other = pack.vers[rj];
                    if (String(other.id) !== String(pv.id) && other.kind === 'release' &&
                        (other.status === 'released' || other.status === 'applied')) {
                        other.status = 'superseded';
                    }
                }
                savePack(app.id, pack);
                return ok(schemaVersionPayload(app, pack, pv,
                    { forward: pChanges.length, rollback: pChanges.length, errors: [] }));
            }
            if (path === '/discard') {
                var dv = null, dk;
                for (dk = 0; dk < pack.vers.length; dk++) {
                    if (String(pack.vers[dk].id) === String(params.verId || params.id)) { dv = pack.vers[dk]; }
                }
                if (!dv) { return err('版本不存在或已被删除', 404); }
                if (dv.kind !== 'draft' || dv.status !== 'draft') { return err('只有草稿可以丢弃'); }
                dv.status = 'discarded';
                savePack(app.id, pack);
                return ok({ id: dv.id, message: '草稿已丢弃' });
            }
            if (path === '/scriptstatus') {
                var sc2 = null, sv2 = null, svi, ski;
                for (svi = 0; svi < pack.vers.length; svi++) {
                    var vs = pack.vers[svi];
                    for (ski = 0; ski < (vs.scripts || []).length; ski++) {
                        if (String(vs.scripts[ski].id) === String(params.id)) {
                            sc2 = vs.scripts[ski];
                            sv2 = vs;
                        }
                    }
                }
                if (!sc2) { return err('脚本不存在或已被删除', 404); }
                var newStatus = params.status || 'applied';
                if (!SCRIPT_STATUS[newStatus]) { return err('不支持的脚本状态：' + newStatus); }
                sc2.status = newStatus;
                sc2.confirmTime = now();
                sc2.execTime = now();
                sc2.execError = params.execError || '';
                if (newStatus === 'applied' && sv2.status === 'released') { sv2.status = 'applied'; }
                savePack(app.id, pack);
                return ok($.extend({}, sc2, { statusLabel: SCRIPT_STATUS[newStatus] }));
            }
            if (path === '/compare') {
                var cmpConnId = String(params.connId || '') || String(app.dbConnId || '');
                var cmpConn = cmpConnId ? mockConnById(cmpConnId) : null;
                if (!cmpConnId) { return err('该应用还没有绑定数据库连接（纯手工维护），不能扫描或对比'); }
                if (!cmpConn) { return err('选中的数据库连接不存在或已被删除，请重新选择'); }
                var leftKind = params.leftKind || 'design', leftSnap, leftVer = null;
                if (leftKind === 'draft') {
                    leftVer = latestVer(pack, 'draft', ['draft']);
                    leftSnap = leftVer ? leftVer.snapshot : snapshotOf(pack);
                } else if (leftKind === 'release') {
                    leftVer = latestVer(pack, 'release', ['released', 'applied']);
                    leftSnap = leftVer ? leftVer.snapshot : snapshotOf(pack);
                } else {
                    leftSnap = snapshotOf(pack);
                }
                /* 离线演示：用「最新正式版快照」代替真实库；只比一个库（与后端口径一致） */
                var relForDb = latestVer(pack, 'release', ['released', 'applied', 'superseded']);
                var rightSnap = relForDb ? relForDb.snapshot : snapshotOf(pack);
                var target = String(params.dbName || mockConnTarget(cmpConn) ||
                                    (leftSnap.databases[0] || {}).dbName || '');
                var designDb = String(params.designDb || '');
                if (designDb && designDb === target) { designDb = ''; }
                if (!designDb) {
                    var hasSame = false, dbi0;
                    for (dbi0 = 0; dbi0 < leftSnap.databases.length; dbi0++) {
                        if (String(leftSnap.databases[dbi0].dbName) === target) { hasSame = true; }
                    }
                    /* 与后端一致：同名直接对；只有一个库就自动对上；多个库又没同名则要求选 */
                    if (!hasSame && leftSnap.databases.length === 1) {
                        designDb = String(leftSnap.databases[0].dbName);
                    } else if (!hasSame) {
                        return err('实库里的库【' + target + '】在设计态没有同名库：请先选「对应设计态库」');
                    }
                }
                var items = [], ldi, rdi, oi4, key;
                for (ldi = 0; ldi < leftSnap.databases.length; ldi++) {
                    var ldb = leftSnap.databases[ldi];
                    if (String(ldb.dbName) !== (designDb || target)) { continue; }
                    var rdb = null;
                    for (rdi = 0; rdi < rightSnap.databases.length; rdi++) {
                        if (String(rightSnap.databases[rdi].dbName) === String(target)) {
                            rdb = rightSnap.databases[rdi];
                        }
                    }
                    if (!rdb) {
                        items.push({ diffType: 'designOnly', objType: 'db', objName: target,
                                     left: { dbName: target }, right: null,
                                     message: '设计态有这个库，实库没扫到（离线演示用最新正式版快照代替实库）' });
                        continue;
                    }
                    var lmap = {}, rmap = {};
                    for (oi4 = 0; oi4 < (ldb.objects || []).length; oi4++) {
                        lmap[ldb.objects[oi4].objName] = ldb.objects[oi4];
                    }
                    for (oi4 = 0; oi4 < (rdb.objects || []).length; oi4++) {
                        rmap[rdb.objects[oi4].objName] = rdb.objects[oi4];
                    }
                    for (key in lmap) {
                        if (!lmap.hasOwnProperty(key)) { continue; }
                        var lo = lmap[key], ro = rmap[key], full = target + '.' + key;
                        if (!ro) {
                            items.push({ diffType: 'designOnly', objType: lo.objType, objName: full,
                                         left: lo, right: null,
                                         message: '设计有、实库无（待执行建表脚本）' });
                            continue;
                        }
                        if (String(lo.objType) !== String(ro.objType)) {
                            items.push({ diffType: 'attrDiff', objType: lo.objType, objName: full,
                                         left: lo, right: ro, message: '对象类型不一致' });
                            continue;
                        }
                        if (String(lo.objType) !== 'table') {
                            var sameDdl = String(lo.ddl || '').trim() === String(ro.ddl || '').trim();
                            items.push({ diffType: sameDdl ? 'same' : 'attrDiff', objType: lo.objType,
                                         objName: full, left: lo, right: ro,
                                         message: sameDdl ? '' : ((OBJ_LABELS[lobj.objType] || '对象') + '定义不同') });
                            continue;
                        }
                        var detail = mockColDetails(lo, ro);
                        items.push({ diffType: detail.diffType || 'same', objType: 'table', objName: full,
                                     left: lo, right: ro, message: detail.message,
                                     details: detail.details });
                    }
                    for (key in rmap) {
                        if (!rmap.hasOwnProperty(key) || lmap[key]) { continue; }
                        items.push({ diffType: 'dbOnly', objType: rmap[key].objType,
                                     objName: target + '.' + key, left: null, right: rmap[key],
                                     message: '实库有、设计无（未纳管）' });
                    }
                }
                var plan = mockUpgradePlan(app.dbType, items, false), ii;
                for (ii = 0; ii < items.length; ii++) {
                    items[ii].details = items[ii].details || mockItemDetails(items[ii]);
                    items[ii].upgradeCount = plan.counts[items[ii].objName] || 0;
                    if (plan.notes[items[ii].objName]) { items[ii].upgradeNote = plan.notes[items[ii].objName]; }
                }
                var counts = { same: 0, designOnly: 0, dbOnly: 0, attrDiff: 0, orderDiff: 0 };
                for (ii = 0; ii < items.length; ii++) {
                    counts[items[ii].diffType] = (counts[items[ii].diffType] || 0) + 1;
                }
                var diffCount = items.length - counts.same;
                var cmpDbType = String((cmpConn && cmpConn.dbType) || app.dbType || 'mysql').toLowerCase();
                var cmp = { id: uid(), appId: app.id, leftKind: leftKind, leftVerId: leftVer ? leftVer.id : '',
                            dbType: cmpDbType, dbName: target,
                            connId: cmpConnId, connName: (cmpConn && cmpConn.name) || '',
                            designDb: designDb || '',
                            snapTime: now(), counts: counts, itemCount: items.length, diffCount: diffCount,
                            createTime: now(), items: items,
                            remark: diffCount ? ('差异 ' + diffCount + ' 项') : '完全一致' };
                pack.compares.unshift(cmp);
                savePack(app.id, pack);
                return ok({ id: cmp.id, appId: app.id, leftKind: leftKind, snapTime: cmp.snapTime,
                            dbType: cmp.dbType, dbTypeLabel: labelOf(DBINFO_TYPES, cmp.dbType),
                            dbName: target, outsideDbs: [],
                            connId: cmpConnId, connName: cmp.connName,
                            connHost: (cmpConn && cmpConn.host) || '', connPort: (cmpConn && cmpConn.port) || '',
                            designDb: designDb || '',
                            counts: counts, diffCount: diffCount, itemCount: items.length,
                            upgrade: { dbType: cmp.dbType, dbTypeLabel: labelOf(DBINFO_TYPES, cmp.dbType),
                                       dbName: target, includeDrop: false, count: plan.total,
                                       objects: plan.objects, diffCount: plan.diffCount,
                                       skipped: plan.diffCount - plan.objects, errors: plan.errors.length },
                            items: items.slice(0, 500).map(function (one) {
                                return $.extend({}, one, { diffLabel: DIFF_LABELS[one.diffType] || one.diffType });
                            }), truncated: items.length > 500 });
            }
            if (path === '/compares') {
                var cl = [], cai;
                for (cai = 0; cai < pack.compares.length && cai < 50; cai++) {
                    var cp = pack.compares[cai];
                    cl.push({ id: cp.id, appId: cp.appId, leftKind: cp.leftKind, dbName: cp.dbName || '',
                              connId: cp.connId || '', connName: cp.connName || '',
                              designDb: cp.designDb || '',
                              dbType: cp.dbType, dbTypeLabel: labelOf(DBINFO_TYPES, cp.dbType),
                              snapTime: cp.snapTime, sameCount: cp.counts.same,
                              addCount: cp.counts.designOnly, dropCount: cp.counts.dbOnly,
                              alterCount: cp.counts.attrDiff + cp.counts.orderDiff,
                              itemCount: cp.itemCount, diffCount: cp.diffCount,
                              createTime: cp.createTime, remark: cp.remark });
                }
                return ok({ list: cl });
            }
            if (path === '/compareitems') {
                var hitC = null, hci;
                for (hci = 0; hci < pack.compares.length; hci++) {
                    if (String(pack.compares[hci].id) === String(params.compareId || params.id)) {
                        hitC = pack.compares[hci];
                    }
                }
                if (!hitC) { return err('对比记录不存在', 404); }
                var filtered = [], fi;
                for (fi = 0; fi < hitC.items.length; fi++) {
                    var it = hitC.items[fi];
                    if (params.diffType && it.diffType !== params.diffType) { continue; }
                    if (params.keyword && !like(it.objName, params.keyword)) { continue; }
                    filtered.push($.extend({}, it, { diffLabel: DIFF_LABELS[it.diffType] || it.diffType }));
                }
                var pn = Math.max(1, parseInt(params.pageNum, 10) || 1);
                var ps = Math.min(Math.max(parseInt(params.pageSize, 10) || 100, 1), 500);
                var pg = Math.max(1, Math.ceil(filtered.length / ps));
                pn = Math.min(pn, pg);
                var shown = filtered.slice((pn - 1) * ps, pn * ps), si;
                for (si = 0; si < shown.length; si++) {
                    shown[si].details = shown[si].details || mockItemDetails(shown[si]);
                    if (shown[si].diffType !== 'same') {
                        var onePlan = mockUpgradePlan(hitC.dbType, [shown[si]], false);
                        shown[si].upgradeCount = onePlan.total;
                        if (onePlan.notes[shown[si].objName]) { shown[si].upgradeNote = onePlan.notes[shown[si].objName]; }
                    } else {
                        shown[si].upgradeCount = 0;
                    }
                }
                return ok({ head: { id: hitC.id, snapTime: hitC.snapTime, leftKind: hitC.leftKind,
                                    dbName: hitC.dbName || '', dbType: hitC.dbType },
                            list: shown, total: filtered.length,
                            pageNum: pn, pageSize: ps, pages: pg,
                            counts: { same: hitC.counts.same, designOnly: hitC.counts.designOnly,
                                      dbOnly: hitC.counts.dbOnly, attrDiff: hitC.counts.attrDiff } });
            }
            /* 某次对比 → 升级脚本（实库 → 设计态）；离线模式同样现算 */
            if (path === '/compareupgrade') {
                var hitU = null, hui;
                for (hui = 0; hui < pack.compares.length; hui++) {
                    if (String(pack.compares[hui].id) === String(params.compareId || params.id)) {
                        hitU = pack.compares[hui];
                    }
                }
                if (!hitU) { return err('对比记录不存在', 404); }
                var dropU = String(params.includeDrop || '') === '1';
                var planU = mockUpgradePlan(hitU.dbType, hitU.items, dropU);
                var headU = ['来源：与实库对比（' + String(hitU.id).slice(0, 8) + '）· 实库数据时间点 ' +
                             hitU.snapTime + ' · 目标库 ' + (hitU.dbName || '未指定'),
                             '对比基准：' + (hitU.leftKind === 'draft' ? '最新草稿' :
                                 (hitU.leftKind === 'release' ? '最新正式版' : '当前设计态')),
                             '差异汇总：仅设计有 ' + hitU.counts.designOnly + ' 项 / 仅实库有 ' +
                                 hitU.counts.dbOnly + ' 项 / 属性不一致 ' + hitU.counts.attrDiff +
                                 ' 项（共 ' + hitU.items.length + ' 条明细）',
                             '脚本只覆盖库【' + (hitU.dbName || '') + '】的对象；不会自动执行，执行前请先备份'];
                if (!dropU && hitU.counts.dbOnly > 0) {
                    headU.push('实库多出的 ' + hitU.counts.dbOnly +
                               ' 个对象默认**不生成** DROP 语句（避免误删数据），需要时勾选「包含删除语句」再导出');
                }
                return ok({ compareId: hitU.id, appId: app.id, snapTime: hitU.snapTime,
                            dbName: hitU.dbName || '', dbType: hitU.dbType,
                            dbTypeLabel: labelOf(DBINFO_TYPES, hitU.dbType), includeDrop: dropU,
                            count: planU.total, objects: planU.objects, diffCount: planU.diffCount,
                            skipped: planU.diffCount - planU.objects, errors: planU.errors,
                            text: mockUpgradeText(hitU.dbType, planU, { appName: app.name,
                                                                       dbName: hitU.dbName || '',
                                                                       notes: headU }),
                            groups: planU.groups });
            }
            /* 批量导出：多条对比记录合成一份 .sql */
            if (path === '/compareexport') {
                var dropE = String(params.includeDrop || '') === '1';
                var rawIds = String(params.ids || '');
                var idSet = {};
                if (rawIds) {
                    for (hci = 0; hci < rawIds.split(',').length; hci++) { idSet[rawIds.split(',')[hci]] = 1; }
                }
                var picked = [], hce;
                for (hce = 0; hce < pack.compares.length; hce++) {
                    var cpE = pack.compares[hce];
                    if (rawIds) {
                        if (idSet[cpE.id]) { picked.push(cpE); }
                        continue;
                    }
                    if ((cpE.diffCount || 0) > 0 && picked.length < 20) { picked.push(cpE); }
                }
                if (!picked.length) {
                    return err('这个应用还没有「有差异」的对比记录：先在对比页点「开始对比」');
                }
                var blocksE = [], filesE = [], totalE = 0, he;
                for (he = 0; he < picked.length; he++) {
                    var rowE = picked[he];
                    var planE = mockUpgradePlan(rowE.dbType, rowE.items, dropE);
                    var textE = mockUpgradeText(rowE.dbType, planE, { appName: app.name,
                                                                     dbName: rowE.dbName || '',
                                                                     notes: ['来源：与实库对比（' +
                                                                         String(rowE.id).slice(0, 8) + '）· 实库时间点 ' + rowE.snapTime] });
                    totalE += planE.total;
                    var diffE = (rowE.addCount || 0) + (rowE.dropCount || 0) + (rowE.alterCount || 0);
                    if (!diffE) { diffE = rowE.diffCount || 0; }
                    blocksE.push('-- ############################################################\n' +
                        '-- 第 ' + (he + 1) + '/' + picked.length + ' 段 · 对比 ' + String(rowE.id).slice(0, 8) + '\n' +
                        '-- 实库时间点 ' + rowE.snapTime + ' · 目标库 ' + (rowE.dbName || '') + '\n' +
                        '-- 差异 ' + diffE + ' 项 · 升级语句 ' + planE.total + ' 条\n' +
                        '-- ############################################################\n\n' + textE);
                    filesE.push({ id: rowE.id, snapTime: rowE.snapTime, dbName: rowE.dbName || '',
                                  diffCount: diffE, count: planE.total, objects: planE.objects,
                                  errors: planE.errors });
                }
                var st = new Date(), p2 = function (n) { return (n < 10 ? '0' : '') + n; };
                return ok({ appId: app.id, count: filesE.length, statements: totalE,
                            includeDrop: dropE, dbType: String(app.dbType || 'mysql').toLowerCase(),
                            dbTypeLabel: labelOf(DBINFO_TYPES, app.dbType),
                            fileName: String(app.code || 'app') + '_upgrade_' + st.getFullYear() +
                                p2(st.getMonth() + 1) + p2(st.getDate()) + p2(st.getHours()) + p2(st.getMinutes()) + '.sql',
                            text: blocksE.join('\n\n\n'), files: filesE });
            }
            return err('接口不存在：/appschema' + path, 404);
        }

        return { appinfo: { route: appInfoRoute }, appschema: { route: schemaRoute } };
    }

    var appSchemaMocks = createAppSchemaMockServices();
    var appInfoSvc = appSchemaMocks.appinfo;
    var appSchemaSvc = appSchemaMocks.appschema;


    /* 前缀 → 服务（url 形如 /menu/list、/group/detail、/groupitem/list、/org/list） */
    var SERVICES = [
        { prefix: '/menu', svc: menuSvc },
        { prefix: '/groupitem', svc: groupItemSvc },   // 须排在 /group 之前，避免前缀误匹配
        { prefix: '/group', svc: groupSvc },
        { prefix: '/org', svc: orgSvc },
        { prefix: '/emparchive', svc: empArchiveSvc }, // 须排在 /emp 之前，避免前缀误匹配
        { prefix: '/empmail', svc: empMailSvc },     // 须排在 /emp 之前（长前缀在前）
        { prefix: '/msg', svc: msgSvc },             // 站内消息（员工间互发，按 empId 强隔离）
        { prefix: '/notify', svc: notifySvc },       // 主框架提醒中心（即时对话 + 邮件 未读聚合）
        { prefix: '/useinfo', svc: userInfoSvc },
        { prefix: '/auth', svc: authSvc },
        { prefix: '/emp', svc: empSvc },
        { prefix: '/dptmgr', svc: dptMgrSvc },
        { prefix: '/pageopbtn', svc: pageOpBtnSvc },
        { prefix: '/serviceemail', svc: serviceEmailSvc },   // 服务信箱设置
        { prefix: '/mail', svc: mailSvc },                   // 邮箱助手
        { prefix: '/addressbook', svc: addressBookSvc },      // 员工通讯录（只读）
        { prefix: '/dbinfo', svc: dbInfoSvc },               // 数据中心：数据库 + 结构扫描 / SQL 执行
        { prefix: '/appinfo', svc: appInfoSvc },             // 数据中心：应用信息（应用 + 绑定连接 1:1）
        { prefix: '/appschema', svc: appSchemaSvc },         // 数据中心：应用结构（库/表/视图/过程/字段 + 版本脚本 + 对比）
        { prefix: '/report', svc: reportSvc },               // 数据中心：报表设计器（报表信息 + 预览 + 调用）
        { prefix: '/workplan', svc: workPlanSvc },             // 项目管理：工作计划（Visio 风格甘特图，整图保存）
        { prefix: '/workload', svc: workloadSvc },             // 项目中心：员工工作量统计（读现成工单聚合，不造数）
        { prefix: '/projectfile', svc: projectFileSvc },// 须排在 /project 之前，避免前缀误匹配
        { prefix: '/projectdir', svc: projectDirSvc },  // 须排在 /project 之前，避免前缀误匹配
        { prefix: '/project', svc: projectSvc },             // 项目管理：项目信息
        { prefix: '/sysdictitems', svc: sysDictItemSvc },// 须排在 /sysdict 之前，避免前缀误匹配
        { prefix: '/sysdict', svc: sysDictSvc },               // 系统配置：系统字典（键 / 树形上级）
        { prefix: '/syspara', svc: sysParaSvc },               // 系统配置：系统参数
        { prefix: '/rolepower', svc: rolePowerSvc },   // 须排在 /role 之前
        { prefix: '/role', svc: roleSvc }
    ];

    /* ---------- 统一请求入口 ---------- */
    /**
     * @param {String} method  GET / POST
     * @param {String} url     接口地址（相对 config.baseUrl）
     * @param {Object} data    请求参数
     * @returns {Promise} 成功 resolve(data)，失败 reject(Error)
     */
    /* ---------- 登录 token：单点登录（SSO）会话 ----------
       一次登录只签发一个 token，写在 localStorage（键 menu_admin_login_v1）；
       同一浏览器同源下的 main.html 与全部 iframe 子页读的是同一份存储 → **token 全局共享**。
       token 默认 8 小时有效（后端 config.TOKEN_TTL_HOURS），前端按 expireAt 提前判定：
         · 本地已过期 → 不再发出请求，直接走上报流程，由框架页统一跳登录页；
         · 服务端判定过期（401）→ 同样统一上报，由框架页跳转（子页自己绝不跳转）；
         · 顶层（main.html）负责真正的跳转，保证「框架整体回登录页」而不是 iframe 里回登录页。 */
    var SESSION_KEY = 'menu_admin_login_v1';
    var LOGIN_PAGE = 'login.html';
    var DEFAULT_TTL_HOURS = 8;

    /** 解析后端时间文本 'YYYY-MM-DD HH:MM:SS'（服务器本地时间）→ 毫秒时间戳；失败返回 0 */
    function parseTime(text) {
        var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(text || ''));
        if (!m) { return 0; }
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    }
    /** 读取登录态（原样解析，不做过期判断） */
    function readSession() {
        try {
            var raw = window.localStorage ? window.localStorage.getItem(SESSION_KEY) : '';
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    /** 会话到期时刻（毫秒）：优先 expireAt（登录时按 expireIn 算出），其次 expireTime，最后 time + ttl */
    function expireAtOf(s) {
        if (!s) { return 0; }
        var at = parseInt(s.expireAt, 10);
        if (at > 0) { return at; }
        at = parseTime(s.expireTime);
        if (at > 0) { return at; }
        var loginAt = parseTime(s.time);
        if (loginAt > 0) {
            var ttl = parseFloat(s.ttlHours);
            if (!(ttl > 0)) { ttl = DEFAULT_TTL_HOURS; }
            return loginAt + Math.round(ttl * 3600 * 1000);
        }
        return 0;               // 旧版登录态（无过期信息）：交给服务端判定
    }
    /** 会话是否已过期（无过期信息时按未过期处理，兼容旧登录态） */
    function isExpired(s) {
        var at = expireAtOf(s);
        return at > 0 && at <= (new Date().getTime());
    }
    function clearSession() {
        try { window.localStorage.removeItem(SESSION_KEY); } catch (e) { }
    }
    function sessionToken() {
        var s = readSession();
        if (!s || !s.token) { return ''; }
        if (isExpired(s)) { onAuthExpired('local-expired'); return ''; }   // 本地已过期：不带着废 token 发请求
        return String(s.token);
    }
    /** 把 token 合并进请求参数（不修改调用方对象；显式传入的 token 优先） */
    function withToken(data) {
        var out = {}, k;
        if (data && typeof data === 'object') { for (k in data) { if (data.hasOwnProperty(k)) { out[k] = data[k]; } } }
        var token = sessionToken();
        if (token && !out.token) { out.token = token; }
        return out;
    }

    /* ---------- 登录失效：统一汇聚到顶层框架页跳转 ---------- */
    function isLoginPage() {
        try { return /login\.html$/i.test(String(window.location.pathname || '')); } catch (e) { return false; }
    }
    /** 当前页面是否被嵌在框架页（main.html）里 */
    function inFrame() {
        try { return window.top !== window.self; } catch (e) { return true; }   // 跨域访问 top 抛错 → 一定在框架内
    }
    /** 登录页地址：**固定为 login.html，不带任何查询参数**。
     *  · 不再拼 redirect= —— 登录页会清空上一个账号的会话，重新登录后一律回系统首页，
     *    回跳地址没有意义，还会把上一个账号停留的页面留在地址栏里；
     *  · 超时提示改由 sessionStorage 标记传递（见 markExpiredHint），地址栏保持干净。 */
    function loginUrl() {
        return LOGIN_PAGE;
    }
    var EXPIRED_MARK = 'menu_admin_auth_expired';
    /** 标记「这次是被超时踢回登录页的」，登录页读一次即删（不走 URL 参数） */
    function markExpiredHint(expired) {
        try {
            if (expired === false) { window.sessionStorage.removeItem(EXPIRED_MARK); }
            else { window.sessionStorage.setItem(EXPIRED_MARK, '1'); }
        } catch (e) { /* 隐私模式下忽略 */ }
    }
    /** 顶层跳登录页（只有顶层调用才能真正替换整个框架页） */
    function redirectTop(expired) {
        markExpiredHint(expired);
        var url = loginUrl();
        try { window.top.location.replace(url); }
        catch (e) { try { window.location.replace(url); } catch (e2) { /* jsdom / file:// 忽略 */ } }
    }
    /** iframe 子页里登录失效：只上报，不在子页跳转（否则 iframe 里出现登录页） */
    function notifyTopAuthExpired(reason) {
        // 1) 框架页已注册处理函数（同源最快路径）
        try {
            if (window.top && window.top.AppFrame && typeof window.top.AppFrame.onAuthExpired === 'function') {
                window.top.AppFrame.onAuthExpired(reason || 'expired');
                return;
            }
        } catch (e) { /* 跨域，走 postMessage */ }
        // 2) postMessage：跨域同样可用，由 frame.js 监听
        try {
            if (window.top && window.top.postMessage) {
                window.top.postMessage({ type: 'app:auth-expired', reason: reason || 'expired' }, '*');
            }
        } catch (e) { /* 忽略 */ }
        // 3) 兜底：1.5 秒后顶层仍未跳走（旧版框架页没订阅）→ 同源时直接把顶层送去登录页
        window.setTimeout(function () {
            try {
                var topLoc = window.top.location;
                if (!/login\.html/i.test(String(topLoc.pathname || ''))) {
                    markExpiredHint(true);
                    topLoc.replace(loginUrl());
                }
            } catch (e) { /* 跨域：只能依赖 postMessage */ }
        }, 1500);
    }
    var authExpiredHandled = false;
    /**
     * 后端返回 401 / 本地判定过期：清理登录态并回登录页（只处理一次）
     *  · 顶层（main.html 或子页被单独打开）→ 自己跳登录页
     *  · iframe 子页 → 上报给顶层，由 main.html 整体跳转
     */
    function onAuthExpired(reason) {
        if (authExpiredHandled) { return; }
        authExpiredHandled = true;
        var hadSession = !!readSession();           // 之前有登录态 → 才算「超时」，否则是没登录直接访问
        clearSession();
        if (isLoginPage()) { return; }              // 已在登录页：不跳，避免来回重定向
        if (!inFrame()) { redirectTop(hadSession); return; }
        notifyTopAuthExpired(reason);
    }

    /* ---------- 会话中心：供 frame.js / login.js / home.js 复用 ----------
       统一入口，避免各页面各自解析 localStorage 造成有效期判断不一致 */
    window.AppAuth = {
        KEY: SESSION_KEY,
        ttlHours: DEFAULT_TTL_HOURS,
        session: readSession,
        token: sessionToken,
        expireAt: function () { return expireAtOf(readSession()); },
        /** 剩余有效毫秒（未登录 / 无过期信息时为 0） */
        remain: function () {
            var at = expireAtOf(readSession());
            return at > 0 ? Math.max(0, at - (new Date().getTime())) : 0;
        },
        expired: function () { return isExpired(readSession()); },
        logged: function () {
            var s = readSession();
            return !!(s && s.token && !isExpired(s));
        },
        clear: clearSession,
        loginUrl: loginUrl,
        inFrame: inFrame,
        /** 主动上报登录失效（清会话 + 顶层跳登录页） */
        expire: onAuthExpired
    };

    /* ---------- 二进制下载（报表导出 Excel / PDF）----------
       JSON 通道装不下文件流，这里单独用 XHR（responseType=blob）：
       成功时把响应当文件、从 Content-Disposition 取文件名；失败时后端仍返回 JSON，读出来提示。 */
    function filenameFromDisposition(header, fallback) {
        var text = String(header || '');
        var star = /filename\*=UTF-8''([^;]+)/i.exec(text);
        if (star) {
            try { return decodeURIComponent(star[1].trim()); } catch (e) { }
        }
        var plain = /filename="?([^";]+)"?/i.exec(text);
        if (plain && plain[1]) { return plain[1].trim(); }
        return fallback;
    }

    /**
     * POST 一个 JSON 请求并把响应当文件取回
     * @return {blob, filename, rowCount, truncated}
     */
    function downloadFile(url, data) {
        var dfd = $.Deferred();
        if (config.useMock) {
            window.setTimeout(function () {
                dfd.reject(new Error('离线演示模式不支持导出文件，请连接后端服务后再试'));
            }, 0);
            return dfd.promise();
        }
        var xhr = new window.XMLHttpRequest();
        xhr.open('POST', config.baseUrl + url, true);
        xhr.responseType = 'blob';
        // 导出可能跑几万行（结构文档还要逐表生成 Word），至少给 5 分钟；
        // 慢接口 / 扫描比对类按各自档位（slowTimeout / scanTimeout）再放宽
        xhr.timeout = Math.max(timeoutFor(url), 300000);
        xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
        xhr.onload = function () {
            var type = xhr.getResponseHeader('Content-Type') || '';
            if (xhr.status >= 200 && xhr.status < 300 && type.indexOf('json') < 0) {
                dfd.resolve({
                    blob: xhr.response,
                    filename: filenameFromDisposition(xhr.getResponseHeader('Content-Disposition'), 'report'),
                    rowCount: parseInt(xhr.getResponseHeader('X-Report-Row-Count'), 10) || 0,
                    truncated: xhr.getResponseHeader('X-Report-Truncated') === '1',
                    // 应用结构导出文档会带上表数 / 字段数（X-Report-* 之外的自定义头）
                    tableCount: parseInt(xhr.getResponseHeader('X-Table-Count'), 10) || 0,
                    colCount: parseInt(xhr.getResponseHeader('X-Col-Count'), 10) || 0
                });
                return;
            }
            // 出错时后端返回的是 JSON（{code, message}）
            var reader = new window.FileReader();
            reader.onload = function () {
                var msg = '导出失败';
                try {
                    var parsed = JSON.parse(String(reader.result || ''));
                    msg = parsed.message || msg;
                    if (parsed.code === 401) { onAuthExpired('expired'); }
                } catch (e) { /* 非 JSON：保持默认提示 */ }
                dfd.reject(new Error(msg));
            };
            reader.onerror = function () { dfd.reject(new Error('导出失败')); };
            reader.readAsText(xhr.response);
        };
        xhr.onerror = function () { dfd.reject(new Error('网络异常，导出失败')); };
        xhr.ontimeout = function () { dfd.reject(new Error('导出超时，请先缩小查询范围（加参数）再试')); };
        try {
            xhr.send(JSON.stringify(withToken(data || {})));
        } catch (e) {
            dfd.reject(new Error('请求发送失败：' + (e.message || e)));
        }
        return dfd.promise();
    }

    /**
     * GET 一个二进制附件（邮件附件下载）：resolve {blob, filename}；
     * 离线演示模式走 mockRouter，resolve {dataUrl, filename}（页面用 <a download> 保存）。
     * token 走 query 参数（与全站 request() 的 withToken 口径一致），不用自定义请求头，
     * 避免 CORS 预检白名单里没有 X-Token 的坑。
     */
    function downloadBinary(url, data) {
        var dfd = $.Deferred();
        var payload = withToken(data || {});
        if (config.useMock) {
            window.setTimeout(function () {
                try {
                    var res = mockRouter('GET', url, payload);
                    if (res.code === 0) { dfd.resolve(res.data); }
                    else {
                        var mErr = new Error(res.message || '附件下载失败');
                        mErr.code = res.code;
                        dfd.reject(mErr);
                    }
                } catch (err) {
                    dfd.reject(new Error(err.message || '附件下载失败'));
                }
            }, config.delay);
            return dfd.promise();
        }
        var pairs = [], key;
        for (key in payload) {
            if (!Object.prototype.hasOwnProperty.call(payload, key) ||
                payload[key] === undefined || payload[key] === null) { continue; }
            pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(payload[key])));
        }
        var xhr = new window.XMLHttpRequest();
        xhr.open('GET', config.baseUrl + url + (pairs.length ? '?' + pairs.join('&') : ''), true);
        xhr.responseType = 'blob';
        xhr.timeout = 120000;
        xhr.onload = function () {
            var type = xhr.getResponseHeader('Content-Type') || '';
            if (xhr.status >= 200 && xhr.status < 300 && type.indexOf('json') < 0) {
                dfd.resolve({
                    blob: xhr.response,
                    filename: filenameFromDisposition(xhr.getResponseHeader('Content-Disposition'), 'attachment')
                });
                return;
            }
            var reader = new window.FileReader();
            reader.onload = function () {
                var msg = '附件下载失败';
                try {
                    var parsed = JSON.parse(String(reader.result || ''));
                    msg = parsed.message || msg;
                    if (parsed.code === 401) { onAuthExpired('expired'); }
                } catch (e) { /* 非 JSON：保持默认提示 */ }
                dfd.reject(new Error(msg));
            };
            reader.onerror = function () { dfd.reject(new Error('附件下载失败')); };
            reader.readAsText(xhr.response);
        };
        xhr.onerror = function () { dfd.reject(new Error('网络异常，附件下载失败')); };
        xhr.ontimeout = function () { dfd.reject(new Error('附件下载超时，请稍后再试')); };
        try { xhr.send(); } catch (e) { dfd.reject(new Error('请求发送失败：' + (e.message || e))); }
        return dfd.promise();
    }

    function request(method, url, data) {
        var dfd = $.Deferred();

        if (!config.useMock) {
            // ===== 真实后端：原生 $.ajax =====
            // 本地已知令牌过期（默认 8 小时）：不再发请求，直接按 401 处理并让框架页跳登录页，
            // 避免带着废 token 打后端（也避免把「超时」误报成「账号无权限」等其他错误）。
            var localSession = readSession();
            var isPublic = (url === '/auth/login' || url === '/auth/captcha' || url === '/auth/brand');
            if (!isPublic && localSession && localSession.token && isExpired(localSession)) {
                onAuthExpired('local-expired');
                var expiredErr = new Error('登录已超时，请重新登录');
                expiredErr.code = 401;
                dfd.reject(expiredErr);
                return dfd.promise();
            }
            // 同源没有后端（例如页面由独立静态服务 5500 托管）时，首个请求会 404；
            // 这里自动改连后端默认地址（已开启 CORS）并重试一次，避免误落到本地模拟数据。
            var switched = false;
            var payload = withToken(data);          // 每个请求都带上登录 token
            function send() {
                var wait = timeoutFor(url);
                $.ajax({
                    url: config.baseUrl + url,
                    type: method,
                    timeout: wait,
                    cache: false,
                    dataType: 'json',
                    contentType: 'application/json;charset=UTF-8',
                    data: (method === 'GET') ? payload : JSON.stringify(payload || {})
                }).done(function (res) {
                    if (res && (res.code === 0 || res.code === 200)) {
                        dfd.resolve(res.data);
                    } else {
                        // 业务错误：保留 code（如 401 登录失效），供调用方按码处理
                        var resErr = new Error((res && res.message) || '请求失败');
                        resErr.code = res && res.code;
                        if (resErr.code === 401) { onAuthExpired('expired'); }  // 登录失效：统一回登录页
                        dfd.reject(resErr);
                    }
                }).fail(function (xhr, status) {
                    // 业务错误（后端返回了 {code, message}，如 401 登录失效）→ 原样抛出，不换地址重试
                    var body = xhr && xhr.responseJSON;
                    if (body && body.message) {
                        var bizErr = new Error(body.message);
                        bizErr.code = body.code;
                        if (bizErr.code === 401) { onAuthExpired('expired'); }   // 登录失效：统一回登录页
                        dfd.reject(bizErr);
                        return;
                    }
                    // 超时：后端多半还在跑（扫大库 / 删除大量对象），**不要换地址重发**（重发等于重跑一遍），
                    // 也别提示成「网络异常」让人误以为断网；照实说等了多少秒。
                    if (status === 'timeout') {
                        dfd.reject(new Error('请求超时：已等待 ' + waitText(wait) +
                            '仍未返回。扫描 / 比对大库时后端可能还在处理，稍后刷新页面看结果，别急着再点一次；' +
                            '确实不够可调大 api.js 的 config.scanTimeout / config.slowTimeout 与后端 DBINFO_READ_TIMEOUT。'));
                        return;
                    }
                    // 只对查询类请求做一次「换地址重试」，避免写操作（POST）被重复提交；
                    // 且**仅当页面本身在本机**时才允许改连 127.0.0.1——远程页面改连等于把请求
                    // 打到访问者自己的电脑上，浏览器还会按 PNA 规则直接拦掉。
                    if (!switched && method === 'GET' && LOCAL_PAGE && config.baseUrl !== REMOTE_BASE) {
                        switched = true;
                        config.baseUrl = REMOTE_BASE;         // 直连后端默认地址再试一次
                        markReady();
                        send();
                        return;
                    }
                    dfd.reject(new Error('网络异常，请稍后重试（' + status + '）'));
                });
            }
            send();
            return dfd.promise();
        }

        // ===== 本地模拟服务：与后端约定一致的返回结构 =====
        window.setTimeout(function () {
            try {
                var result = mockRouter(method, url, data || {});
                if (result.code === 0) { dfd.resolve(result.data); }
                else {
                    var mErr = new Error(result.message || '请求失败');
                    mErr.code = result.code;
                    dfd.reject(mErr);
                }
            } catch (err) {
                dfd.reject(new Error(err.message || '服务异常'));
            }
        }, config.delay);
        return dfd.promise();
    }

    /* ---------- Mock 路由分发 ---------- */
    function mockRouter(method, url, params) {
        /* 邮件附件下载：独立于业务服务的二进制路由，Mock 里直接返回 dataURL */
        if (url === '/mailattach/download') {
            try { return mockAttachDownload(params || {}); }
            catch (err) { return { code: 500, message: err.message || '附件下载失败' }; }
        }
        if (url === '/nav' || url.indexOf('/nav') === 0) {          // 左侧导航（跨服务聚合）
            try {
                return { code: 0, message: 'ok', data: mockNav(params) };
            } catch (err) {
                return { code: 500, message: err.message || '服务异常' };
            }
        }
        for (var i = 0; i < SERVICES.length; i++) {
            var s = SERVICES[i];
            if (url.indexOf(s.prefix + '/') === 0) {
                return s.svc.route(method, url.substring(s.prefix.length), params || {});
            }
        }
        return { code: 404, message: '接口不存在：' + url };
    }

    /* ---------- 导航树构造（与后端 service.build_nav 规则一致） ---------- */
    /**
     * @param {Array} groups 启用的菜单组（含 parentId / level / sortNo / hasChild / path / icon）
     * @param {Array} items  启用的菜单项（含 path / icon）
     * @param {Object} binds groupId -> 菜单项数组（含 sortNo，已按序号排序）
     */
    function buildNavTree(groups, items, binds) {
        var nodes = {}, roots = [], i;
        for (i = 0; i < groups.length; i++) {
            var g = groups[i];
            nodes[g.id] = {
                id: g.id,
                parentId: parseInt(g.parentId, 10) || 0,
                level: parseInt(g.level, 10) || 1,
                sortNo: parseInt(g.sortNo, 10) || 0,
                code: g.code || '', nameCn: g.nameCn || '', nameEn: g.nameEn || '',
                icon: g.icon || '', hasChild: g.hasChild ? 1 : 0, path: g.path || '',
                crumb: '', children: [], items: []
            };
        }
        for (i = 0; i < groups.length; i++) {
            var node = nodes[groups[i].id];
            var parent = nodes[node.parentId];
            if (parent && parent.id !== node.id) { parent.children.push(node); }
            else { roots.push(node); }
        }
        // 排序：菜单组按同级排序号 sortNo 升序、组内菜单项按显示序号 sortNo 升序（同序号按 id，保证稳定）
        function navNo(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
        function bySortNo(a, b) { return (navNo(a.sortNo) - navNo(b.sortNo)) || (navNo(a.id) - navNo(b.id)); }
        function sortTree(list) {
            list.sort(bySortNo);
            for (var k = 0; k < list.length; k++) { sortTree(list[k].children); }
        }
        sortTree(roots);
        function fill(one, prefix) {
            one.crumb = prefix ? (prefix + '/' + one.nameCn) : one.nameCn;
            var list = one.hasChild ? (binds[one.id] || []) : [];
            list.sort(bySortNo);
            one.items = list;
            for (var k = 0; k < list.length; k++) { list[k].crumb = one.crumb + '/' + list[k].nameCn; }
            for (var j = 0; j < one.children.length; j++) { fill(one.children[j], one.crumb); }
        }
        for (i = 0; i < roots.length; i++) { fill(roots[i], ''); }

        var bindCount = 0;
        for (var key in binds) { if (binds.hasOwnProperty(key)) { bindCount += binds[key].length; } }
        return { groups: roots, groupCount: groups.length, menuCount: items.length, bindCount: bindCount };
    }

    /**
     * Mock 通道：解析导航的权限主体
     *   · 带 token 且能在本地用户表里找到 → 取该用户的启用角色（与后端一致）
     *   · token 缺失 / 找不到（离线演示、页面单测）→ 取全部启用角色，保证界面不空白（scope='demo'）
     */
    function navScope(token) {
        var text = String(token || '').replace(/^\s+|\s+$/g, '');
        var users = userInfoSvc.raw(), links = userInfoSvc.rawRoles();
        var res = roleSvc.route('GET', '/list', { pageNum: 1, pageSize: 500 });
        var roleRows = ((res && res.data && res.data.list) || []), roleMap = {}, enabledIds = [], i;
        for (i = 0; i < roleRows.length; i++) {
            roleMap[String(roleRows[i].id)] = roleRows[i];
            if (roleRows[i].enabled !== false) { enabledIds.push(String(roleRows[i].id)); }
        }
        if (text) {
            for (i = 0; i < users.length; i++) {
                if (String(users[i].token) === text) {
                    var mine = [], seen = {};
                    for (var j = 0; j < links.length; j++) {
                        if (String(links[j].userId) !== String(users[i].id)) { continue; }
                        var rid = String(links[j].roleId);
                        if (!roleMap[rid] || roleMap[rid].enabled === false || seen[rid]) { continue; }
                        seen[rid] = true;
                        mine.push(rid);
                    }
                    return {
                        roleIds: mine, scope: 'token',
                        roleNames: mine.map(function (x) { return roleMap[x].nameCn; }).join('、')
                    };
                }
            }
        }
        return {
            roleIds: enabledIds, scope: 'demo',
            roleNames: enabledIds.map(function (x) { return roleMap[x].nameCn; }).join('、')
        };
    }

    /** 按角色菜单授权裁剪导航树：没有可见菜单项的菜单组会被裁掉 */
    function filterNavTree(list, granted) {
        var out = [], i;
        for (i = 0; i < list.length; i++) {
            var n = list[i];
            n.children = filterNavTree(n.children || [], granted);
            var items = [], keepItems = [];
            var raw = n.items || [];
            for (var k = 0; k < raw.length; k++) {
                if (granted[String(n.id) + ':' + String(raw[k].id)]) { keepItems.push(raw[k]); }
            }
            n.items = keepItems;
            if (n.items.length || n.children.length) { out.push(n); }
        }
        return out;
    }

    /** Mock 通道：用本地模拟服务的数据构造导航（按当前登录用户角色权限过滤） */
    function mockNav(params) {
        params = params || {};
        var groups = ((groupSvc.route('GET', '/list', { pageNum: 1, pageSize: 200 }).data || {}).list) || [];
        var items = ((menuSvc.route('GET', '/list', { pageNum: 1, pageSize: 200 }).data || {}).list) || [];
        var enabledGroups = [], enabledItems = [], i;
        for (i = 0; i < groups.length; i++) { if (groups[i].enabled !== false) { enabledGroups.push(groups[i]); } }
        for (i = 0; i < items.length; i++) { if (items[i].enabled !== false) { enabledItems.push(items[i]); } }

        var binds = {};
        for (i = 0; i < enabledGroups.length; i++) {
            var g = enabledGroups[i];
            if (!g.hasChild) { continue; }
            var res = groupItemSvc.route('GET', '/list', { groupId: g.id, pageNum: 1, pageSize: 200 });
            var rows = ((res && res.data) || {}).list || [];
            var out = [];
            for (var j = 0; j < rows.length; j++) {
                var r = rows[j];
                out.push({
                    id: r.itemId, code: r.itemCode || '', nameCn: r.itemNameCn || '', nameEn: r.itemNameEn || '',
                    path: r.itemPath || '', icon: r.itemIcon || '',
                    sortNo: parseInt(r.sortNo, 10) || 0, groupId: g.id, crumb: ''
                });
            }
            binds[g.id] = out;
        }

        var scope = navScope(params.token);
        var granted = {}, seenRole = {};
        var rows = rolePowerSvc.raw() || [];
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            if (row.enabled === false) { continue; }
            if (scope.roleIds.indexOf(String(row.roleId)) < 0) { continue; }
            var gid = String(parseInt(row.menuGroupId, 10) || 0);
            var iid = parseInt(row.menuItemId, 10) || 0;
            if (iid === 0) {                                  // 整组授权：展开该组当前绑定的全部菜单项
                var list = binds[gid] || [];
                for (var x = 0; x < list.length; x++) { granted[gid + ':' + String(list[x].id)] = true; }
            } else {
                granted[gid + ':' + String(iid)] = true;
            }
            seenRole[gid] = true;
        }

        var tree = buildNavTree(enabledGroups, enabledItems, binds);
        tree.groups = filterNavTree(tree.groups, granted);

        var visible = 0, groupN = 0;
        (function count(list) {
            for (var i = 0; i < list.length; i++) {
                groupN++;
                visible += (list[i].items || []).length;
                count(list[i].children || []);
            }
        })(tree.groups);

        tree.groupCount = groupN;
        tree.menuCount = visible;
        tree.bindCount = visible;
        tree.roleIds = scope.roleIds;
        tree.roleNames = scope.roleNames;
        tree.scope = scope.scope;
        tree.scoped = scope.scope === 'token';
        tree.empty = visible === 0;
        return tree;
    }

    /* ---------- 对外接口 ---------- */
    /** 菜单项 */
    var menu = {
        page: function (params) { return request('GET', '/menu/list', params); },
        detail: function (id) { return request('GET', '/menu/detail', { id: id }); },
        check: function (field, value, id) { return request('GET', '/menu/check', { field: field, value: value, id: id || 0 }); },
        nextCode: function () { return request('GET', '/menu/nextcode', {}); },   // 新增页：自动生成编号
        add: function (data) { return request('POST', '/menu/add', data); },
        update: function (data) { return request('POST', '/menu/update', data); },
        remove: function (id) { return request('POST', '/menu/delete', { id: id }); }
    };

    /** 菜单组（支持多层级：parentId / level / sortNo；tree 为层级下拉数据） */
    var group = {
        page: function (params) { return request('GET', '/group/list', params); },
        tree: function (params) { return request('GET', '/group/tree', params || {}); },
        detail: function (id) { return request('GET', '/group/detail', { id: id }); },
        check: function (field, value, id) { return request('GET', '/group/check', { field: field, value: value, id: id || 0 }); },
        nextCode: function () { return request('GET', '/group/nextcode', {}); },   // 新增页：编号自动生成（MNG + 4 位流水号）
        add: function (data) { return request('POST', '/group/add', data); },
        update: function (data) { return request('POST', '/group/update', data); },
        remove: function (id, cascade) { return request('POST', '/group/delete', { id: id, cascade: cascade ? 1 : 0 }); }
    };

    /** 部门组织架构（多层级：parentId / level / sortNo；tree 为上级部门下拉数据） */
    var org = {
        page: function (params) { return request('GET', '/org/list', params); },
        tree: function (params) { return request('GET', '/org/tree', params || {}); },
        detail: function (id) { return request('GET', '/org/detail', { id: id }); },
        check: function (field, value, id) { return request('GET', '/org/check', { field: field, value: value, id: id || 0 }); },
        nextCode: function () { return request('GET', '/org/nextcode', {}); },      // 新增页：编号自动生成（DPT + 4 位流水号）
        add: function (data) { return request('POST', '/org/add', data); },
        update: function (data) { return request('POST', '/org/update', data); },
        remove: function (id, cascade) { return request('POST', '/org/delete', { id: id, cascade: cascade ? 1 : 0 }); },
        /**
         * 取某部门下所有「启用状态」的后代部门（子、孙…；停用的下级仍继续向下检查）
         * 用于列表页删除 / 表单页停用前的拦截校验；数据取不到时返回空数组（交由后端兜底）
         */
        enabledDescendants: function (id) {
            var dfd = $.Deferred();
            var rootId = parseInt(id, 10);
            request('GET', '/org/list', { pageNum: 1, pageSize: 1000 }).done(function (data) {
                var list = (data && data.list) || [], out = [], stack = [rootId], i;
                while (stack.length) {
                    var cur = stack.pop();
                    for (i = 0; i < list.length; i++) {
                        var pid = parseInt(list[i].parentId, 10) || 0;
                        if (pid === cur && list[i].id !== cur && list[i].id !== rootId) {
                            if (Number(list[i].enabled)) { out.push(list[i]); }
                            stack.push(list[i].id);
                        }
                    }
                }
                dfd.resolve(out);
            }).fail(function () { dfd.resolve([]); });
            return dfd.promise();
        },
        /**
         * 拼「有启用下级部门」的拦截提示语；允许操作返回空串
         * @param {Number} id     部门 ID
         * @param {String} action 动作名，如「停用本部门」「删除本部门」
         * @returns {Promise} resolve(String)
         */
        enabledChildTip: function (id, action) {
            var dfd = $.Deferred();
            org.enabledDescendants(id).done(function (kids) {
                if (!kids.length) { dfd.resolve(''); return; }
                var names = [];
                for (var i = 0; i < kids.length && i < 3; i++) { names.push(kids[i].nameCn); }
                dfd.resolve('该部门下还有 ' + kids.length + ' 个启用状态的下级部门（' + names.join('、')
                    + (kids.length > 3 ? '等' : '') + '），请先停用这些下级部门后再' + action + '。');
            });
            return dfd.promise();
        }
    };

    /** 菜单组项目设置（菜单组 ↔ 菜单项；list 必须带 groupId，只返回启用状态的菜单项） */
    var groupItem = {
        page: function (params) { return request('GET', '/groupitem/list', params); },
        detail: function (id) { return request('GET', '/groupitem/detail', { id: id }); },
        add: function (data) { return request('POST', '/groupitem/add', data); },        // 批量追加
        update: function (data) { return request('POST', '/groupitem/update', data); },  // 全量同步
        remove: function (id) { return request('POST', '/groupitem/delete', { id: id }); }
    };

    /** 员工信息（empinfos：工号 E + 5 位流水号，邮箱必填；status 在职状态 1/2/0） */
    var emp = {
        page: function (params) { return request('GET', '/emp/list', params); },
        detail: function (id) { return request('GET', '/emp/detail', { id: id }); },
        check: function (field, value, id) { return request('GET', '/emp/check', { field: field, value: value, id: id || 0 }); },
        nextCode: function () { return request('GET', '/emp/nextcode', {}); },      // 新增：工号自动预取（E + 5 位流水号）
        add: function (data) { return request('POST', '/emp/add', data); },
        update: function (data) { return request('POST', '/emp/update', data); },
        remove: function (id) { return request('POST', '/emp/delete', { id: id }); },
        /** 在职状态字典（下拉 / 标签共用） */
        statusList: function () {
            return [
                { value: 1, text: '在职' },
                { value: 2, text: '试用' },
                { value: 0, text: '离职' }
            ];
        }
    };

    /** 用户角色（usergroup）：UUID 主键，角色名唯一；列表按排序号升序 */
    var role = {
        page: function (params) { return request('GET', '/role/list', params); },
        detail: function (id) { return request('GET', '/role/detail', { id: id }); },
        check: function (field, value, id, enabled) { return request('GET', '/role/check', { field: field, value: value, id: id || '', enabled: enabled === undefined ? '' : enabled }); },
        add: function (data) { return request('POST', '/role/add', data); },
        update: function (data) { return request('POST', '/role/update', data); },
        remove: function (id) { return request('POST', '/role/delete', { id: id }); }
    };

    /** 页面操作按钮（pageopbtn）：列表 / 页面下拉 / 自动收录 / 维护 / 删除 */
    var pageOpBtn = {
        page: function (params) { return request('GET', '/pageopbtn/list', params); },
        detail: function (id) { return request('GET', '/pageopbtn/detail', { id: id }); },
        pages: function () { return request('GET', '/pageopbtn/pages', {}); },
        scan: function () { return request('POST', '/pageopbtn/scan', {}); },
        update: function (data) { return request('POST', '/pageopbtn/update', data); },
        remove: function (id) { return request('POST', '/pageopbtn/delete', { id: id }); }
    };

    /** 角色权限（usergrouppowerset）：按角色查授权 / 权限树 / 保存（全量替换）/ 清空 */
    var rolePower = {
        list: function (roleId) { return request('GET', '/rolepower/list', { roleId: roleId }); },
        tree: function (roleId, keyword) { return request('GET', '/rolepower/tree', { roleId: roleId, keyword: keyword || '' }); },
        /** 该角色已授权的页面按钮清单（扁平） */
        buttons: function (roleId) { return request('GET', '/rolepower/buttons', { roleId: roleId }); },
        /** 当前登录角色可用的页面按钮（页面加载时用来禁用未授权按钮） */
        myButtons: function () { return request('GET', '/rolepower/mybuttons', {}); },
        /**
         * 保存权限：菜单 + 按钮一次提交
         * @param {String} roleId
         * @param {Array}  items    菜单权限 [{menuGroupId, menuItemId}]
         * @param {Array}  buttons  按钮权限 [pageOpBtnId, ...]（传了才覆盖，不传则不动按钮权限）
         */
        save: function (roleId, items, buttons) {
            var data = { roleId: roleId };
            if (items !== undefined && items !== null) { data.items = items; }
            if (buttons !== undefined && buttons !== null) { data.buttons = buttons; }
            return request('POST', '/rolepower/save', data);
        },
        clear: function (roleId) { return request('POST', '/rolepower/clear', { roleId: roleId }); }
    };

    /** 部门负责人设置（dptmgrset：一个部门一个负责人；list 以部门为维度返回负责人） */
    var dptMgr = {
        list: function (params) { return request('GET', '/dptmgr/list', params || {}); },
        set: function (data) { return request('POST', '/dptmgr/set', data); },        // {deptId, empId, remark}
        remove: function (deptId) { return request('POST', '/dptmgr/delete', { deptId: deptId }); }
    };

    /** 员工信息归档（empinfoarchive）：一次归档一个批次（整表快照） */
    var empArchive = {
        /** 把当前员工表全部记录归档到 empinfoarchive，返回 {batchId, archiveTime, total} */
        archive: function () { return request('POST', '/emparchive/archive', {}); },
        /** 历次归档批次（归档时间倒序）：{list:[{batchId, archiveTime, total}], total} */
        batches: function (params) { return request('GET', '/emparchive/batches', params || {}); },
        /** 某批次（batchId）的员工列表，支持 pageNum / pageSize / keyword / status */
        page: function (params) { return request('GET', '/emparchive/list', params); }
    };

    /** 用户信息（useinfo）：账号=员工手机号，密码 MD5；批量创建 / 重置密码统一 888888 */
    var useInfo = {
        page: function (params) { return request('GET', '/useinfo/list', params || {}); },
        detail: function (id) { return request('GET', '/useinfo/detail', { id: id }); },
        check: function (field, value, id) { return request('GET', '/useinfo/check', { field: field, value: value, id: id || '' }); },
        /** 员工下拉（建账号用）：params={keyword, noUser:'1'} */
        empOptions: function (params) { return request('GET', '/useinfo/empoptions', params || {}); },
        /** 单个创建：{empId, account?, password?, remark?, enabled?, roleIds?} */
        add: function (data) { return request('POST', '/useinfo/add', data); },
        /** 批量创建：{empIds:[], roleIds:[]}，初始密码固定 888888 */
        batch: function (data) { return request('POST', '/useinfo/batch', data); },
        /** 编辑：{id, account?, remark?, enabled?, roleIds?} */
        update: function (data) { return request('POST', '/useinfo/update', data); },
        /** 删除：支持单个 id 或 ids 数组 */
        remove: function (ids) { return request('POST', '/useinfo/delete', { ids: ids }); },
        /** 批量重置密码为 888888 */
        resetPwd: function (ids) { return request('POST', '/useinfo/resetpwd', { ids: ids }); },
        /** 批量设置角色（全量替换）：{ids:[], roleIds:[]} */
        setRoles: function (ids, roleIds) { return request('POST', '/useinfo/setroles', { ids: ids, roleIds: roleIds }); }
    };

    /** 登录认证（auth）：账号 + 密码换 token / 退出 / 按 token 反查当前用户 */
    var auth = {
        /** 取一道运算表达式验证码：{captchaId, question, expireIn} */
        captcha: function () { return request('GET', '/auth/captcha', {}); },
        /** @param {{account:String, password:String, captchaId:String, captchaCode:String}} data */
        login: function (data) { return request('POST', '/auth/login', data); },
        logout: function (token) { return request('POST', '/auth/logout', { token: token }); },
        me: function (token) { return request('GET', '/auth/me', { token: token }); },
        /** 系统品牌（**登录前也能取**）：{app_name, app_ennme, app_ico}
         *  后端只回这三个键，某个键没配就是空串（页面保留自己的兜底文案） */
        brand: function () { return request('GET', '/auth/brand', {}); },
        /** 忘记密码第一步：往登记邮箱发 6 位验证码（走当前启用的服务信箱） */
        sendcode: function (email) { return request('POST', '/auth/sendcode', { email: email }); },
        /** 忘记密码第二步：{email, code, newPassword} → 重置密码，新密码会发回该邮箱 */
        resetbyemail: function (data) { return request('POST', '/auth/resetbyemail', data); },
        /** 登录后自助改密：{oldPassword, newPassword}（成功后 token 作废，需重新登录） */
        changepwd: function (data) { return request('POST', '/auth/changepwd', data); }
    };

    /** 左侧导航：按菜单组树 + 菜单组项目绑定关系实时生成（接口 /api/nav），按登录用户角色权限过滤 */
    var nav = {
        /** @param {String} token 登录令牌（缺省时后端按 401 拒绝；Mock 通道退化为「全部启用角色」演示） */
        get: function (token) { return request('GET', '/nav', token ? { token: token } : {}); }
    };

    /** 服务信箱（serviceemail）：UUID 主键，**单例表（全表只允许一条记录）**；密码只进不出 */
    var serviceEmail = {
        page: function (params) { return request('GET', '/serviceemail/list', params || {}); },
        detail: function (id) { return request('GET', '/serviceemail/detail', { id: id }); },
        check: function (field, value, id) {
            return request('GET', '/serviceemail/check', { field: field, value: value, id: id || '' });
        },
        /** {email, password, displayName?, smtpHost?, smtpPort?, imapHost?, imapPort?, useSsl?, enabled?, remark?}
         *  已有记录时后端拒绝新增（单例表），此时应改走 update */
        add: function (data) { return request('POST', '/serviceemail/add', data); },
        /** 编辑：password 留空表示不修改 */
        update: function (data) { return request('POST', '/serviceemail/update', data); },
        remove: function (id) { return request('POST', '/serviceemail/delete', { id: id }); },
        /** 启用 / 停用（启用会自动停用其它记录，全表仅一条启用） */
        setEnabled: function (id, enabled) {
            return request('POST', '/serviceemail/enabled', { id: id, enabled: enabled ? 1 : 0 });
        },
        /** 测试 IMAP / SMTP 连接（用库里保存的密码） */
        test: function (id) { return request('POST', '/serviceemail/test', { id: id }); }
    };

    /* ---------- 数据中心 · 数据库连接（dbinfo）：连接信息维护 + 结构扫描（只读） ---------- */
    var dbInfo = {
        /** {keyword, dbType, enabled, pageNum, pageSize} → {list,total,pageNum,pageSize,pages} */
        page: function (params) { return request('GET', '/dbinfo/list', params || {}); },
        detail: function (id) { return request('GET', '/dbinfo/detail', { id: id }); },
        check: function (value, id) {
            return request('GET', '/dbinfo/check', { field: 'name', value: value, id: id || '' });
        },
        /** {name, dbType, host, port, dbName, username, password, charset, extraParams, enabled, remark} */
        add: function (data) { return request('POST', '/dbinfo/add', data); },
        /** 编辑：password 留空表示不修改 */
        update: function (data) { return request('POST', '/dbinfo/update', data); },
        remove: function (id) { return request('POST', '/dbinfo/delete', { id: id }); },
        /** 启用 / 停用（允许多条同时启用） */
        setEnabled: function (id, enabled) {
            return request('POST', '/dbinfo/enabled', { id: id, enabled: enabled ? 1 : 0 });
        },
        /** 测试连接（能列出实例即视为连通） */
        test: function (id) { return request('POST', '/dbinfo/test', { id: id }); },
        /** 数据库类型下拉（含默认端口 / 是否文件型） */
        types: function () { return request('GET', '/dbinfo/types', {}); },
        /** 1.2 扫描可用实例（库）：{databases:[{name,tableCount,system,current}], server, scannedAt} */
        scan: function (id) { return request('POST', '/dbinfo/scan', { id: id }); },
        /** 扫描某实例下的表与视图 */
        tables: function (id, database) {
            return request('GET', '/dbinfo/tables', { id: id, database: database });
        },
        /** 扫描某张表 / 视图的字段 */
        columns: function (id, database, table) {
            return request('GET', '/dbinfo/columns', { id: id, database: database, table: table });
        },
        /** 右区域 SQL 工作台：执行一条只读查询
         *  {id, database, sql, maxRows} → {columns:[{name,index}], rows:[[...]], rowCount, truncated, elapsed, message} */
        sqlrun: function (id, sql, database, maxRows) {
            return request('POST', '/dbinfo/sqlrun',
                { id: id, sql: sql, database: database || '', maxRows: maxRows || '' });
        },
        /** 右区域「数据」标签页：表 / 视图数据分页（懒加载）
         *  {database, table, pageNum, pageSize, orderBy, orderDir, filters:[{column,op,value}]}
         *  → {columns:[名称...], rows:[[...]], total, pageNum, pageSize, pages, hasMore, orderBy, orderDir} */
        rows: function (id, options) {
            var data = options || {};
            return request('POST', '/dbinfo/rows', {
                id: id, database: data.database || '', table: data.table || '',
                pageNum: data.pageNum || 1, pageSize: data.pageSize || 100,
                orderBy: data.orderBy || '', orderDir: data.orderDir || '',
                filters: data.filters || []
            });
        }
    };

    /* ---------- 数据中心 · 应用信息（appinfo）：应用 + 绑定连接 1:1 ---------- */
    var appInfo = {
        /** 自动生成的下一个应用编码（APP + 4 位流水） */
        nextcode: function () { return request('GET', '/appinfo/nextcode', {}); },
        /** 表单下拉：应用类型 / 环境 / 数据库类型 / 逻辑类型 / 对象类型 */
        meta: function () { return request('GET', '/appinfo/meta', {}); },
        /** {keyword, appType, dbType, status, pageNum, pageSize} → {list,total,pageNum,pageSize,pages} */
        page: function (params) { return request('GET', '/appinfo/list', params || {}); },
        detail: function (id) { return request('GET', '/appinfo/detail', { id: id }); },
        /** 唯一性校验：field = 'code' | 'name' */
        check: function (field, value, id) {
            return request('GET', '/appinfo/check', { field: field || 'code', value: value, id: id || '' });
        },
        /** 应用下拉（启用 + 可见），供结构页选应用 */
        options: function () { return request('GET', '/appinfo/options', {}); },
        /** 可用连接下拉：启用的 + 可见的 + 没被其它应用占用（当前应用自己占着的除外） */
        connections: function (appId) { return request('GET', '/appinfo/connections', { appId: appId || '' }); },
        /** {code?, name, shortName, appType, dbType, env, dbConnId, ownerEmpId, deptId,
         *  description, status, ispub} */
        add: function (data) { return request('POST', '/appinfo/add', data); },
        update: function (data) { return request('POST', '/appinfo/update', data); },
        remove: function (id) { return request('POST', '/appinfo/delete', { id: id }); },
        setEnabled: function (id, status) {
            return request('POST', '/appinfo/enabled', { id: id, status: status ? 1 : 0 });
        }
    };

    /* ---------- 数据中心 · 应用结构（appschema）：库 / 对象 / 字段 / 版本 / 脚本 / 对比 ---------- */
    var appSchema = {
        /** 结构树：应用 → 库 → 表 / 视图 / 存储过程（字段懒加载） */
        tree: function (appId) { return request('GET', '/appschema/tree', { appId: appId }); },
        /** 版本列表（草稿 + 正式版 + 脚本状态） */
        versions: function (appId) { return request('GET', '/appschema/versions', { appId: appId }); },
        /** 单个版本详情：变更明细 + 正向 / 回滚脚本 */
        version: function (verId, appId) {
            return request('GET', '/appschema/version', { verId: verId, appId: appId || '' });
        },
        /** 发布草稿 → 正式版号 + 脚本（status=pending，永不自动执行） */
        publish: function (verId, summary, remark, appId) {
            return request('POST', '/appschema/publish',
                { verId: verId, summary: summary || '', remark: remark || '', appId: appId || '' });
        },
        discard: function (verId, appId) {
            return request('POST', '/appschema/discard', { verId: verId, appId: appId || '' });
        },
        /** 人工确认执行后回写脚本状态：status = pending | applied | failed | skipped */
        scriptstatus: function (id, status, execError, appId) {
            return request('POST', '/appschema/scriptstatus',
                { id: id, status: status || 'applied', execError: execError || '', appId: appId || '' });
        },
        /** 与真实数据库对比（人工触发，结果落库留存）
         *  o = {dbName, designDb, connId, leftKind}：connId 可换成线上生产库的连接 */
        compare: function (appId, options) {
            var o = options || {};
            return request('POST', '/appschema/compare',
                { appId: appId, dbName: o.dbName || '', designDb: o.designDb || '',
                  connId: o.connId || '', leftKind: o.leftKind || 'design' });
        },
        /** 历次对比记录 */
        compares: function (appId) { return request('GET', '/appschema/compares', { appId: appId }); },
        /** 对比明细（分页 / 按差异类型过滤） */
        compareitems: function (compareId, params) {
            var p = $.extend({ compareId: compareId }, params || {});
            return request('GET', '/appschema/compareitems', p);
        },
        /** 某次对比 → 升级实库的脚本（实库 → 设计态；历史记录也能导，includeDrop 才生成 DROP） */
        compareupgrade: function (compareId, options) {
            var o = options || {};
            return request('GET', '/appschema/compareupgrade',
                { compareId: compareId, appId: o.appId || '', includeDrop: o.includeDrop ? 1 : 0 });
        },
        /** 批量导出：多条对比记录合成一份 .sql（ids 为空 → 最近 20 条有差异的记录） */
        compareexport: function (appId, options) {
            var o = options || {};
            return request('POST', '/appschema/compareexport',
                { appId: appId, ids: o.ids || '', includeDrop: o.includeDrop ? 1 : 0 });
        },
        /** 导出表结构文档（Excel / Word）：ids 是勾选的表 / 视图，为空则导出全部
         *  → {blob, filename, tableCount, colCount}（二进制走 XHR，不能用 JSON 通道） */
        exportdocs: function (appId, options) {
            var o = options || {};
            return downloadFile('/appschema/exportdocs',
                { appId: appId, ids: o.ids || '', format: o.format || 'xlsx' });
        },
        /** 字段级血缘：字段清单（带上/下游条数）+ 指定字段的上游 / 下游明细 */
        lineage: function (appId, objName, colName) {
            return request('GET', '/appschema/lineage',
                { appId: appId, objName: objName || '', colName: colName || '' });
        },
        /** 重建字段血缘：解析视图 / 触发器 / 存储过程 / 函数里的 SQL（不连真实库） */
        lineagebuild: function (appId) {
            return request('POST', '/appschema/lineagebuild', { appId: appId });
        },
        /** 手工保存血缘边：人画的线（origin=manual），「重新分析」不会覆盖 */
        lineageedgesave: function (payload) {
            return request('POST', '/appschema/lineageedgesave', payload || {});
        },
        /** 删除手工血缘边：自动解析出来的边要先转手工再删（否则重算又长回来） */
        lineageedgedel: function (appId, id) {
            return request('POST', '/appschema/lineageedgedel', { appId: appId, id: id });
        },
        /** 某对象的字段清单 */
        cols: function (objId, appId) { return request('GET', '/appschema/cols', { objId: objId, appId: appId || '' }); },
        /** 保存字段：cols 可以是数组（批量），也可以单条；一次请求只出一条草稿 */
        colsave: function (objId, cols, appId) {
            return request('POST', '/appschema/colsave', { objId: objId, cols: cols, appId: appId || '' });
        },
        coldel: function (objId, id, appId) {
            return request('POST', '/appschema/coldel', { objId: objId, id: id, appId: appId || '' });
        },
        dbadd: function (appId, data) {
            return request('POST', '/appschema/dbadd', $.extend({ appId: appId }, data || {}));
        },
        dbupdate: function (appId, data) {
            return request('POST', '/appschema/dbupdate', $.extend({ appId: appId }, data || {}));
        },
        dbdel: function (appId, id) { return request('POST', '/appschema/dbdel', { appId: appId, id: id }); },
        objadd: function (appId, data) {
            return request('POST', '/appschema/objadd', $.extend({ appId: appId }, data || {}));
        },
        objupdate: function (appId, data) {
            return request('POST', '/appschema/objupdate', $.extend({ appId: appId }, data || {}));
        },
        objdel: function (appId, id) { return request('POST', '/appschema/objdel', { appId: appId, id: id }); },
        /** 扫描前确定目标：连接名 + 默认库 + 可访问库名单（只列名，不读结构）
         *  connId 可换成另一个连接（实库对比面板「选连接 → 选库」复用它） */
        scaninfo: function (appId, connId) {
            return request('GET', '/appschema/scaninfo', { appId: appId, connId: connId || '' });
        },
        /** 实库对比的可选连接：同方言 + 可见（本人创建 / 他人公用），标出应用绑定的那个 */
        compareconns: function (appId) { return request('GET', '/appschema/compareconns', { appId: appId }); },
        /** 从应用绑定的连接扫描结构并导入设计态
         *  **只扫一个库**：database 为空 → 用连接对象的「默认库」；传了就扫那一个（单选） */
        scan: function (appId, database) {
            return request('POST', '/appschema/scan', { appId: appId, database: database || '' });
        },
        /** 只解析不落库（预览导入结果） */
        parse: function (appId, sql) { return request('POST', '/appschema/parsesql', { appId: appId, sql: sql }); },
        /** 把 CREATE / ALTER / DROP / COMMENT ON 应用到设计态（不动真实数据库） */
        importddl: function (appId, sql, dbName) {
            return request('POST', '/appschema/importddl',
                { appId: appId, sql: sql, dbName: dbName || '' });
        }
    };

    /* ---------- 数据中心 · 报表设计器（report）：报表信息 + 数据源 + 预览 + 调用 ---------- */
    var report = {
        /** {keyword, category, connId, enabled, pageNum, pageSize} → {list,total,pageNum,pageSize,pages,categories} */
        page: function (params) { return request('GET', '/report/list', params || {}); },
        /** 报表中心：只查**启用状态**的报表（后端强制 enabled=1，停用报表查不到） */
        center: function (params) { return request('GET', '/report/center', params || {}); },
        /** 单张报表详情：含 params / columns / design / template / sqlText 全量 */
        detail: function (id) { return request('GET', '/report/detail', { id: id }); },
        check: function (value, id) {
            return request('GET', '/report/check', { field: 'code', value: value, id: id || '' });
        },
        /** 报表分类聚合：[{value,count}] */
        categories: function () { return request('GET', '/report/categories', {}); },
        /** 数据源下拉（启用状态的数据库连接） */
        connections: function () { return request('GET', '/report/connections', {}); },
        /** 扫连接下可用的实例（库） */
        databases: function (connId) { return request('GET', '/report/databases', { connId: connId }); },
        /** 某实例下的表与视图 */
        tables: function (connId, database) {
            return request('GET', '/report/tables', { connId: connId, database: database });
        },
        /** 某张表 / 视图的字段 */
        columns: function (connId, database, table) {
            return request('GET', '/report/columns', { connId: connId, database: database, table: table });
        },
        /** 新增报表：{code?, reportName, category, connId, databaseName, mainTable, sqlText,
         *  columns:[], params:[], design:{}, template:{}, description, enabled} */
        add: function (data) { return request('POST', '/report/add', data); },
        /** 编辑报表（同上，另加 id）：version 自动 +1 */
        update: function (data) { return request('POST', '/report/update', data); },
        remove: function (id) { return request('POST', '/report/delete', { id: id }); },
        /** 启用 / 停用（停用的报表不能 run 调用） */
        setEnabled: function (id, enabled) {
            return request('POST', '/report/enabled', { id: id, enabled: enabled ? 1 : 0 });
        },
        /** 复制报表（新编码自动生成，默认停用） */
        copy: function (id, reportName) {
            return request('POST', '/report/copy', { id: id, reportName: reportName || '' });
        },
        /** 预览：未保存也能预览
         *  {id?, connId, databaseName, mainTable, sqlText, columns:[], params:[], paramValues:{}, design, template}
         *  → {sql, columns, rows, rowCount, truncated, mapped, params, paramValues, report, design, template}
         *  注意：报表参数定义在请求里叫 paramsJson（params 是接口入参对象本身，不能复用） */
        preview: function (data) {
            var payload = $.extend({}, data || {});
            if (payload.params !== undefined && payload.paramsJson === undefined) {
                payload.paramsJson = payload.params;
            }
            delete payload.params;
            return request('POST', '/report/preview', payload);
        },
        /** 调用已保存的报表：{id?|code?, paramValues:{}, maxRows?} → 同 preview；runCount 自动 +1 */
        run: function (params) { return request('POST', '/report/run', params || {}); },
        /** 导出「全部查询结果」：{id?|code?, connId, sqlText, columns, paramsJson, paramValues, format:'excel'|'pdf'}
         *  → {blob, filename, rowCount, truncated}（二进制走 XHR，不能用 JSON 通道） */
        exportFile: function (data) { return downloadFile('/report/export', data || {}); }
    };

    /** 邮箱助手（mail）：用当前启用的服务信箱收件 / 看信 / 写信发信 */
    var mail = {
        /** 当前启用的服务信箱 + 未读数 + 收发统计 */
        status: function () { return request('GET', '/mail/status', {}); },
        /** 邮件列表：{folder:'inbox'|'sent', keyword, pageNum, pageSize} */
        page: function (params) { return request('GET', '/mail/list', params || {}); },
        /** 读信正文（默认标记已读）：markRead=0 可只读不标记 */
        detail: function (id, markRead) {
            var data = { id: id };
            if (markRead === 0 || markRead === false) { data.markRead = 0; }
            return request('GET', '/mail/detail', data);
        },
        /** 立即收件（IMAP，按 UID 去重；limit 为本次最多拉取封数） */
        sync: function (limit) { return request('POST', '/mail/sync', limit ? { limit: limit } : {}); },
        /** 写邮件并发送：{to, cc, subject, body, attachments:[{name,size,type,data(base64)}]}
         *  attachments 由前端 FileReader 读成 base64 直接提交，后端解成 MIME 附件发出（内容不落库） */
        send: function (data) { return request('POST', '/mail/send', data); },
        /** 标记已读 / 未读：mark(ids, true/false) */
        mark: function (ids, seen) {
            return request('POST', '/mail/mark', { ids: ids, seen: seen ? 1 : 0 });
        },
        remove: function (ids) { return request('POST', '/mail/delete', { ids: ids }); },
        /** 读信区附件下载清单；refresh=true 时按 IMAP UID 补拉历史邮件的附件内容 */
        attachments: function (id, refresh) {
            return request(refresh ? 'POST' : 'GET', '/mail/attachments',
                { id: id, refresh: refresh ? 1 : 0 });
        },
        /** 下载附件：{blob, filename}（离线演示为 {dataUrl, filename}） */
        downloadAttachment: function (fileId) {
            return downloadBinary('/mailattach/download', { source: 'mail', id: fileId });
        }
    };

    /** 我的邮箱（empmail）：员工个人信箱助手
     *  与 /api/mail（服务信箱单例）不同，这里**一人一条配置、邮件按登录员工强隔离**：
     *  后端只认 token 反查出来的 empId，前端传 empId / 别人的邮件 id 一律无效。 */
    var empMail = {
        /** 当前员工信箱配置（脱敏）+ 未读数 + 收发统计 + 自动收件开关 */
        status: function () { return request('GET', '/empmail/status', {}); },
        /** 保存本人信箱配置：{email, password?, displayName?, smtpHost?, smtpPort?, imapHost?,
         *  imapPort?, useSsl?, enabled?, autoSync?, remark?}；password 留空表示不修改 */
        save: function (data) { return request('POST', '/empmail/save', data || {}); },
        /** 测试本人信箱 IMAP / SMTP 连接（用库里已保存的密码） */
        test: function () { return request('POST', '/empmail/test', {}); },
        /** 邮件列表：{folder:'inbox'|'sent', keyword, pageNum, pageSize} */
        page: function (params) { return request('GET', '/empmail/list', params || {}); },
        /** 读信正文（默认标记已读）：markRead=0 可只读不标记 */
        detail: function (id, markRead) {
            var data = { id: id };
            if (markRead === 0 || markRead === false) { data.markRead = 0; }
            return request('GET', '/empmail/detail', data);
        },
        /** 立即收件（IMAP，按 UID 去重；后台线程也会定期自动收 autoSync=1 的信箱） */
        sync: function (limit) { return request('POST', '/empmail/sync', limit ? { limit: limit } : {}); },
        /** 写邮件并发送：{to, cc, subject, body, attachments}（发件人固定取本人配置） */
        send: function (data) { return request('POST', '/empmail/send', data || {}); },
        /** 标记已读 / 未读 */
        mark: function (ids, seen) {
            return request('POST', '/empmail/mark', { ids: ids, seen: seen ? 1 : 0 });
        },
        remove: function (ids) { return request('POST', '/empmail/delete', { ids: ids }); },
        /** 读信区附件下载清单；refresh=true 时按 IMAP UID 补拉历史邮件的附件内容 */
        attachments: function (id, refresh) {
            return request(refresh ? 'POST' : 'GET', '/empmail/attachments',
                { id: id, refresh: refresh ? 1 : 0 });
        },
        /** 下载附件：{blob, filename}（离线演示为 {dataUrl, filename}），后端按 empId 强隔离 */
        downloadAttachment: function (fileId) {
            return downloadBinary('/mailattach/download', { source: 'empmail', id: fileId });
        }
    };

    /* ---------- 站内消息（msg）：员工间互发，按 empId 强隔离 ----------
       收件箱 = receiverId=我且未删；已发送 = senderId=我且未删；发件人固定取本人（不接受伪造）。 */
    var msg = {
        /** 当前员工的未读数与收发统计（页面初始化） */
        status: function () { return request('GET', '/msg/status', {}); },
        /** 消息列表（历史归档）：{folder:'inbox'|'sent', keyword, pageNum, pageSize} */
        page: function (params) { return request('GET', '/msg/list', params || {}); },
        /** 读信详情（默认标记已读）：markRead=0 可只读不标记 */
        detail: function (id, markRead) {
            var data = { id: id };
            if (markRead === 0 || markRead === false) { data.markRead = 0; }
            return request('GET', '/msg/detail', data);
        },
        /** 发送消息（REST 兜底 / 历史归档写库）：{receiverIds:[...] 或 receiverId, title, content} */
        send: function (data) { return request('POST', '/msg/send', data || {}); },
        /** 标记已读 / 未读（仅收件人本人）：ids 数组或单个 id，read=1/0 */
        mark: function (ids, read) {
            return request('POST', '/msg/mark', { ids: ids, read: read ? 1 : 0 });
        },
        /** 删除（按当前员工角色软删；双方都删才物理删） */
        remove: function (ids) { return request('POST', '/msg/delete', { ids: ids }); },
        /** IM：联系人 + 在线态 + 未读 + 最近消息 */
        contacts: function () { return request('GET', '/msg/contacts', {}); },
        /** IM：与某人的完整会话（按时间升序），打开即标记已读：{peerId} */
        history: function (peerId) { return request('GET', '/msg/history', { peerId: peerId }); },
        /** IM：已读回执（把某人发来的全部未读标记为已读）：{peerId} */
        markPeer: function (peerId) { return request('POST', '/msg/markpeer', { peerId: peerId }); },
        /** IM：上传附件（图片 / 文件）→ 返回 fileId，随后随发送一起带过去
            {fileName, data(base64 或 dataURL), kind:'image'|'file', width, height, mimeType} */
        upload: function (data) { return request('POST', '/msg/upload', data || {}); },
        /** IM：我加入的群（含未读、最近一条、成员数） */
        groups: function () { return request('GET', '/msg/groups', {}); },
        /** IM：建群 {groupName, memberIds:[empId,...]}（群主自动入群；群名可空 → 按成员名自动拼） */
        groupAdd: function (data) { return request('POST', '/msg/groupadd', data || {}); },
        /** IM：群资料 + 成员列表（非成员 403） */
        groupDetail: function (groupId) { return request('GET', '/msg/groupdetail', { groupId: groupId }); },
        /** IM：群消息历史（打开即把本人阅读游标推平 = 已读） */
        groupHistory: function (groupId) { return request('GET', '/msg/grouphistory', { groupId: groupId }); },
        /** IM：改群名 / 全量替换成员（仅群主）：{groupId, groupName, memberIds} */
        groupUpdate: function (data) { return request('POST', '/msg/groupupdate', data || {}); },
        /** IM：群主解散群 / 成员退群 */
        groupRemove: function (groupId) { return request('POST', '/msg/groupdelete', { groupId: groupId }); },
        /** IM：把某个群标记为已读 */
        markGroup: function (groupId) { return request('POST', '/msg/markgroup', { groupId: groupId }); },
        /** IM：表情包列表（全站共享） */
        emojis: function () { return request('GET', '/msg/emojis', {}); },
        /** IM：把已上传的图片登记为表情包 */
        emojiAdd: function (data) { return request('POST', '/msg/emojiadd', data || {}); },
        /** IM：删除表情包（仅本人上传） */
        emojiRemove: function (id) { return request('POST', '/msg/emojidel', { id: id }); },
        /** IM：建立 WebSocket 连接，返回统一接口的 socket（真实 / Mock 自动切换） */
        connect: function (opts) { return msgSvc.connect(opts || {}); }
    };

    /* ---------- 提醒中心（notify）：主框架顶栏铃铛 / 左侧菜单上标 / 语音提醒 ----------
       一次请求聚合两类未读，避免主框架同时轮询 /msg/contacts 与 /empmail/status：
         {im:{empId,unread,peers:[{empId,name,deptName,avatarText,unread,lastContent,lastTime}]},
          mail:{configured,empId,email,unread,items:[{id,fromAddr,fromName,subject,sentTime}]}, total} */
    var notify = {
        summary: function () { return request('GET', '/notify/summary', {}); }
    };

    /* ---------- 员工通讯录（addressbook）：只读查询 ----------
       与后端 AddressBookService 同口径：只有 tree / list 两个读取动作，没有任何写接口；
       返回字段仅限通讯录（工号 / 姓名 / 性别 / 手机 / 邮箱 / 部门 / 岗位 / 在职状态）。 */
    var addressBook = {
        /** 组织架构树 + 人数：{list:[{id,nameCn,directCount,totalCount,children}], totalStaff, unassignedCount} */
        tree: function () { return request('GET', '/addressbook/tree', {}); },
        /** 通讯录列表：{keyword, deptId, includeChildren, unassigned, status, pageNum, pageSize} */
        page: function (params) { return request('GET', '/addressbook/list', params || {}); }
    };

    /* ---------- 项目管理 · 项目信息（project）----------
       检索结果只含「本人创建」+「他人标为公用」；项目编号由后端自动生成 PRO + 6 位流水号。 */
    var project = {
        /** {keyword, projectType, projectStatus, ispub, enabled, pageNum, pageSize}
         *  → {list,total,pageNum,pageSize,pages,stats}；list 额外含 fileCount / ispubText */
        page: function (params) { return request('GET', '/project/list', params || {}); },
        detail: function (id) { return request('GET', '/project/detail', { id: id }); },
        /** 项目名称 / 编号唯一性校验 */
        check: function (field, value, id) {
            return request('GET', '/project/check', { field: field, value: value, id: id || '' });
        },
        /** 项目类型 / 项目状态字典 */
        types: function () { return request('GET', '/project/types', {}); },
        /** 下一个可用编号（新增页里预览，真正保存时后端再生成一次） */
        nextCode: function () { return request('GET', '/project/nextcode', {}); },
        /**
         * Word（.docx / .docm）导入 → {html, text, paragraphs, imagesSkipped, message}
         * 浏览器本地解析优先（离线 Mock 通道也可用）；浏览器不支持 deflate-raw 解压时
         * 自动回落到真实后端 /api/project/importdoc（Python zipfile 同口径解析）。
         * payload = {data: base64 或 data URL, fileName}
         */
        importDoc: function (payload) {
            var dfd = $.Deferred();
            var wi = window.WordImport;
            var data = payload || {};
            function fallback(localErr) {
                if (config.useMock) { dfd.reject(localErr); return; }
                request('POST', '/project/importdoc', data)
                    .done(function (res) { dfd.resolve(res); })
                    .fail(function (e) { dfd.reject(e); });
            }
            if (!wi || !wi.parseBase64) {
                fallback(new Error('Word 解析组件未加载'));
                return dfd.promise();
            }
            wi.parseBase64(data.data, data.fileName).then(
                function (res) { dfd.resolve(res); },
                function (e) {
                    fallback(e instanceof Error ? e : new Error(String((e && e.message) || e)));
                }
            );
            return dfd.promise();
        },
        /** 项目下拉（可见 + 启用），项目文件页用 */
        options: function (keyword) {
            return request('GET', '/project/options', keyword ? { keyword: keyword } : {});
        },
        /** {projectName, projectType, projectStatus, projectDesc, ispub, enabled}；projectCode 不用传 */
        add: function (data) { return request('POST', '/project/add', data); },
        /** 编辑：编号不可改；projectCode 传了也会被忽略 */
        update: function (data) { return request('POST', '/project/update', data); },
        /** 删除项目会级联清理其下的项目文件 */
        remove: function (id) { return request('POST', '/project/delete', { id: id }); },
        setEnabled: function (id, enabled) {
            return request('POST', '/project/enabled', { id: id, enabled: enabled ? 1 : 0 });
        }
    };

    /* ---------- 项目管理 · 项目目录（projectdir）----------
       多级文件夹：parentId 自关联（空=项目根目录），projectId 必填；
       删除目录不删数据（子目录上移、文件回到项目根）；tree 供上传选目录 / 上级下拉 / 树视图复用。 */
    var projectDir = {
        /** {projectId, parentId, keyword, ispub, enabled, pageNum, pageSize} → 同 project.page */
        page: function (params) { return request('GET', '/projectdir/list', params || {}); },
        detail: function (id) { return request('GET', '/projectdir/detail', { id: id }); },
        /** 目录树（深度优先扁平列表，label 带层级缩进）；excludeId 排除自身与后代 */
        tree: function (params) { return request('GET', '/projectdir/tree', params || {}); },
        /** {projectId, parentId, dirName, dirDesc, ispub, enabled} */
        add: function (data) { return request('POST', '/projectdir/add', data); },
        /** {id, parentId, dirName, dirDesc, ispub, enabled}；改上级即移动目录 */
        update: function (data) { return request('POST', '/projectdir/update', data); },
        /** 删除：子目录上移、文件解除归属，返回 movedDirs / movedFiles */
        remove: function (id) { return request('POST', '/projectdir/delete', { id: id }); },
        setEnabled: function (id, enabled) {
            return request('POST', '/projectdir/enabled', { id: id, enabled: enabled ? 1 : 0 });
        }
    };

    /* ---------- 项目管理 · 项目文件（projectfile）----------
       检索 / 下载同样只含「本人上传」+「他人标为公用」；
       upload 用 FileReader 把文件读成 base64 放进 data 字段，后端落盘后返回 filePath / downloadUrl；
       dirId 为所属目录（不传 / 空 = 不选择目录，文件直接与项目关联）。 */
    var projectFile = {
        /** {keyword, projectId, dirId, fileType, ispub, enabled, pageNum, pageSize} → 同 project.page */
        page: function (params) { return request('GET', '/projectfile/list', params || {}); },
        detail: function (id) { return request('GET', '/projectfile/detail', { id: id }); },
        types: function () { return request('GET', '/projectfile/types', {}); },
        /** 上传：{projectId, fileName, fileType, fileDesc, ispub, enabled, fileSize, data(base64)} */
        upload: function (data) { return request('POST', '/projectfile/upload', data); },
        /** 编辑元数据；带 data 时同时替换文件实体 */
        update: function (data) { return request('POST', '/projectfile/update', data); },
        remove: function (id) { return request('POST', '/projectfile/delete', { id: id }); },
        setEnabled: function (id, enabled) {
            return request('POST', '/projectfile/enabled', { id: id, enabled: enabled ? 1 : 0 });
        },
        /** 取可下载地址（同源静态路径）；停用的文件会被拒绝 */
        download: function (id) { return request('GET', '/projectfile/download', { id: id }); }
    };

    /* ---------- 项目管理 · 项目组（projectmember）----------
       成员从员工信息（empinfos）里选取；保存走全量替换，后端做差异增删：
       新加入的成员收站内消息（发送人=当前操作人），有邮箱的再发一封通知邮件。 */
    var projectMember = {
        /** {projectId} → {projectId, projectName, projectCode, emailEnabled, list, memberCount} */
        members: function (projectId) {
            return request('GET', '/projectmember/members', { projectId: projectId });
        },
        /** {projectId, memberIds:[empId...]} → {added, removed, notified, mailed, mailError, message} */
        save: function (data) { return request('POST', '/projectmember/membersave', data); }
    };

    /* ---------- 项目管理 · 项目计划（projectplan）----------
       层级：项目 → 计划（PL+6）→ 事项/任务（IT+6）→ 工单（WO+6，一事项一单）+ 附件。
       · 保存事项指定/变更责任人 → 后端发站内消息（含事项链接）+ 通知邮件，并同步生成工单；
       · start({planId}) 给还没有工单的事项补派工单并通知。 */
    var projectPlan = {
        /** {projectId, keyword, pageNum, pageSize} → 计划分页 */
        page: function (params) { return request('GET', '/projectplan/list', params || {}); },
        detail: function (id) { return request('GET', '/projectplan/detail', { id: id }); },
        add: function (data) { return request('POST', '/projectplan/add', data); },
        update: function (data) { return request('POST', '/projectplan/update', data); },
        remove: function (id) { return request('POST', '/projectplan/delete', { id: id }); },
        /** 某计划下的事项 / 任务清单 */
        items: function (planId) { return request('GET', '/projectplan/items', { planId: planId }); },
        itemDetail: function (id) { return request('GET', '/projectplan/itemdetail', { id: id }); },
        itemAdd: function (data) { return request('POST', '/projectplan/itemadd', data); },
        itemUpdate: function (data) { return request('POST', '/projectplan/itemupdate', data); },
        itemRemove: function (id) { return request('POST', '/projectplan/itemdelete', { id: id }); },
        /** 事项状态下拉（系统字典 project_plan_item_status） */
        itemStatuses: function () { return request('GET', '/projectplan/itemstatuses', {}); },
        /** 启动计划：给没有工单的事项补派工单并通知 */
        start: function (planId) { return request('POST', '/projectplan/start', { planId: planId }); },
        orders: function (params) { return request('GET', '/projectplan/orders', params || {}); },
        itemFiles: function (itemId) { return request('GET', '/projectplan/itemfiles', { itemId: itemId }); },
        itemFileUpload: function (data) { return request('POST', '/projectplan/itemfileadd', data); },
        itemFileDelete: function (id) { return request('POST', '/projectplan/itemfiledelete', { id: id }); },
        itemFileDownload: function (id) { return request('GET', '/projectplan/itemfiledownload', { id: id }); }
    };

    /* ---------- 项目管理 · 工作计划（workplan，Visio 风格）----------
       与「项目计划」表结构解耦，但启动后共用 WO 工单编号序列与「我的任务」列表：
       · 新建：先 nextCode() 预览 WP+6 编号，再 add() 建空计划，然后打页到「工作计划」；
       · 制定页：detail(id) 读整图 → 画布/日历/网格编辑 → save({plan, tasks}) 一次提交（任务全量替换）；
       · 选人：people({projectId}) 一次取回组织架构树 + 员工信息表 + 项目组成员；
       · 启动：start({planId}) 一任务一工单 + 责任人 / 参与人员的站内消息与邮件；
       · orders() 我的任务列表（工作计划按责任人或参与人，项目计划按责任人）。 */
    var workPlan = {
        /** {keyword, projectId, pageNum, pageSize} → {list,total,pageNum,pageSize,pages} */
        page: function (params) { return request('GET', '/workplan/list', params || {}); },
        /** id → {plan:{...}, tasks:[...]} */
        detail: function (id) { return request('GET', '/workplan/detail', { id: id }); },
        nextCode: function () { return request('GET', '/workplan/nextcode', {}); },
        add: function (data) { return request('POST', '/workplan/add', data); },
        update: function (data) { return request('POST', '/workplan/update', data); },
        remove: function (id) { return request('POST', '/workplan/delete', { id: id }); },
        /** 整图保存：{plan:{id?,planName,startDate,endDate,scale,skipWeekend,ispub,...}, tasks:[...]} */
        save: function (data) { return request('POST', '/workplan/save', data); },
        /** {projectId?} → {orgs:[...], employees:[...], members:[...], projectName, memberCount} */
        people: function (params) { return request('GET', '/workplan/people', params || {}); },
        /** {planId} → {created,skipped,notified,mailed,receivers,message}（幂等补派） */
        start: function (planId) { return request('POST', '/workplan/start', { planId: planId }); },
        /** {keyword,role,execStatus,status,pageNum,pageSize} → 我的任务分页（工单 JOIN 关联任务） */
        orders: function (params) { return request('GET', '/workplan/orders', params || {}); },
        /** {orderId,execStatus,actualStartDate,actualEndDate,execRemark,progress,status}
         *  → 从我的任务回填执行记录到计划中的任务（双向关联） */
        exec: function (data) { return request('POST', '/workplan/exec', data || {}); },
        /** 计划 / 项目维度全部工单（所有能看到该计划的人）：
         *  {planId?, projectId?('__none__'=未关联项目), keyword, status, execStatus, owner, pageNum, pageSize}
         *  → {list, total, pages, projects:[{id,name}], summary:[{projectKey,projectName,orders,planCount}]} */
        planOrders: function (params) { return request('GET', '/workplan/planorders', params || {}); },
        /** 项目详情「工作计划」：{projectId,pageNum?,pageSize?,keyword?,status?} → {list,total,projectName} */
        projectPlans: function (params) { return request('GET', '/workplan/projectplans', params || {}); },
        /** {planId,taskId?} → {list:[{action,summary,detail,operatorName,createTime}], total} 变更时间线 */
        changeLogs: function (params) { return request('GET', '/workplan/changelogs', params || {}); },
        /** {orderId|taskId|planId} → {list:[{id,title,content,execStatus,createTime,files:[...]}]} 多次执行记录 */
        execs: function (params) { return request('GET', '/workplan/execs', params || {}); },
        /** 附件预览：id → {name,ext,size,mime,dataUrl} */
        execFile: function (id) { return request('GET', '/workplan/execfile', { id: id }); },
        /** 停止计划（仅创建人；仅已启动可停止） */
        stop: function (planId) { return request('POST', '/workplan/stop', { planId: planId }); },
        /** Excel 导入：{fileName, data(base64)} → {rows, errors, summary}
         *  rows[i] = {id, seq, rowNo, level, taskName, taskType, startDate, endDate, duration,
         *             ownerId, ownerName, participantIds, participantNames,
         *             parentSeq, preTaskSeqs:[序号], errors:[文案], ok:true|false}
         *  只解析、不落库：把行写进画布后，仍由用户点「保存」走整图保存（变更日志 / 派单 / 通知）。
         *  模板下载走 /api/workplan/importtemplate（二进制流，前端直接 window.open）。 */
        importTasks: function (data) { return request('POST', '/workplan/importtasks', data || {}); }
    };

    /* ---------- 项目中心 · 员工工作量统计（workload） ----------
       统计口径在后端 WorkloadService，页面只负责筛选与展示：
       · stats()   按派单时间区间聚合「每个责任人一行」，含接单 / 完成 / 逾期 / 完成率 / 平均耗时；
       · details() 钻取某员工在该区间的工单明细（带 planId / taskId，可直接跳计划工单页或设计器）；
       · 导出走二进制接口 /api/workload/export（汇总 + 明细两个页签，前端 window.open）。 */
    var workload = {
        /** {startDate,endDate,projectId,keyword,scope('mine'|''),sortBy,sortOrder}
         *  → {range,summary,list,projects,generatedAt} */
        stats: function (params) { return request('GET', '/workload/stats', params || {}); },
        /** {ownerId,startDate,endDate,projectId,status,scope,pageNum,pageSize}
         *  → {list,total,pages,summary:{total,done,overdue,doneRate}} */
        details: function (params) { return request('GET', '/workload/details', params || {}); }
    };

    /* ---------- 项目管理 · 需求池（requirement） ---------- */
    var requirement = {
        page: function (params) { return request('GET', '/requirement/list', params || {}); },
        detail: function (id) { return request('GET', '/requirement/detail', { id: id }); },
        add: function (data) { return request('POST', '/requirement/add', data || {}); },
        update: function (data) { return request('POST', '/requirement/update', data || {}); },
        evaluate: function (data) { return request('POST', '/requirement/evaluate', data || {}); },
        respond: function (data) { return request('POST', '/requirement/respond', data || {}); },
        createPlan: function (data) { return request('POST', '/requirement/createplan', typeof data === 'object' ? data : { id: data }); },
        acceptOrder: function (data) { return request('POST', '/requirement/orderaccept', data || {}); },
        upload: function (data) { return request('POST', '/requirement/upload', data || {}); },
        file: function (id) { return request('GET', '/requirement/file', { id: id }); },
        uploadEval: function (data) { return request('POST', '/requirement/evalupload', data || {}); },
        fileEval: function (id) { return request('GET', '/requirement/evalfile', { id: id }); }
    };

    /* ---------- 项目管理 · 缺陷 / 问题管理（bug） ----------
       客户现场实施问题：登记 → 接收人评估（时间线）→ 确认缺陷后自动生成
       1 张修复计划 + 3 条任务（研发 / 测试 / 验收）+ 3 张工单。
       工单复用 workplanorders：进「我的任务」，研发 / 测试计入工作量统计。 */
    var bug = {
        /** {status,projectId,level,receiverId,keyword,pageNum,pageSize} → {list,total,pages} */
        page: function (params) { return request('GET', '/bug/list', params || {}); },
        /** id → {bug, evaluations[], orders[], plan} */
        detail: function (id) { return request('GET', '/bug/detail', { id: id }); },
        add: function (data) { return request('POST', '/bug/add', data || {}); },
        update: function (data) { return request('POST', '/bug/update', data || {}); },
        /** {id,result,level,reason,reasonHtml,evaluatorIds} */
        evaluate: function (data) { return request('POST', '/bug/evaluate', data || {}); },
        /** {id,devOwnerId,devStartDate,devEndDate,testOwnerId,...,acceptOwnerId,...} */
        confirm: function (data) { return request('POST', '/bug/confirm', data || {}); },
        close: function (data) { return request('POST', '/bug/bugclose', data || {}); },
        /** {bugId, files:[{name,size,data(base64)}]} → {files[], message} */
        upload: function (data) { return request('POST', '/bug/upload', data || {}); },
        /** 附件读取 → {name,size,ext,mime,dataUrl} */
        file: function (id) { return request('GET', '/bug/file', { id: id }); }
    };

    /* ---------- 系统配置 · 系统字典（sysdict）----------
       全局配置数据，不做可见性过滤；键英文名唯一、支持 parentId 树形分组；
       删除字典会级联清理 sysdictitems 键值，并把子字典升为顶级。 */
    var sysDict = {
        /** {keyword, parentId, enabled, pageNum, pageSize} → {list,total,pageNum,pageSize,pages} */
        page: function (params) { return request('GET', '/sysdict/list', params || {}); },
        detail: function (id) { return request('GET', '/sysdict/detail', { id: id }); },
        /** 键英文名唯一性校验 */
        check: function (field, value, id) {
            return request('GET', '/sysdict/check', { field: field || 'dictNameEn', value: value, id: id || '' });
        },
        /** 上级字典树（label 带层级缩进）；excludeId 排除自身与后代 */
        tree: function (excludeId) {
            return request('GET', '/sysdict/tree', excludeId ? { excludeId: excludeId } : {});
        },
        /** 所属字典下拉（只含启用的字典） */
        options: function () { return request('GET', '/sysdict/options', {}); },
        /** {dictNameCn, dictNameEn, parentId, sortNo, remark, enabled} */
        add: function (data) { return request('POST', '/sysdict/add', data); },
        update: function (data) { return request('POST', '/sysdict/update', data); },
        remove: function (id) { return request('POST', '/sysdict/delete', { id: id }); },
        setEnabled: function (id, enabled) {
            return request('POST', '/sysdict/enabled', { id: id, enabled: enabled ? 1 : 0 });
        }
    };

    /* ---------- 系统配置 · 字典键值（sysdictitems）----------
       按 dictId 归属；同一字典下 itemKey 唯一；itemKey 留空可存纯枚举。 */
    var sysDictItem = {
        /** {dictId, keyword, enabled, pageNum, pageSize} → 同 sysDict.page */
        page: function (params) { return request('GET', '/sysdictitems/list', params || {}); },
        detail: function (id) { return request('GET', '/sysdictitems/detail', { id: id }); },
        /** 同字典下键唯一性校验，需带 dictId */
        check: function (value, dictId, id) {
            return request('GET', '/sysdictitems/check',
                           { field: 'itemKey', value: value, dictId: dictId, id: id || '' });
        },
        /** {dictId, itemKey, itemValue, sortNo, remark, enabled} */
        add: function (data) { return request('POST', '/sysdictitems/add', data); },
        update: function (data) { return request('POST', '/sysdictitems/update', data); },
        remove: function (id) { return request('POST', '/sysdictitems/delete', { id: id }); },
        setEnabled: function (id, enabled) {
            return request('POST', '/sysdictitems/enabled', { id: id, enabled: enabled ? 1 : 0 });
        }
    };

    /* ---------- 系统配置 · 系统参数（syspara）----------
       参数英文名唯一；参数值最多 1000 字；停用的参数仍可在列表里维护。 */
    var sysPara = {
        /** {keyword, enabled, pageNum, pageSize} → 同 sysDict.page */
        page: function (params) { return request('GET', '/syspara/list', params || {}); },
        detail: function (id) { return request('GET', '/syspara/detail', { id: id }); },
        /** 参数英文名唯一性校验 */
        check: function (field, value, id) {
            return request('GET', '/syspara/check', { field: field || 'paraNameEn', value: value, id: id || '' });
        },
        /** {paraNameCn, paraNameEn, paraValue, sortNo, remark, enabled} */
        add: function (data) { return request('POST', '/syspara/add', data); },
        update: function (data) { return request('POST', '/syspara/update', data); },
        remove: function (id) { return request('POST', '/syspara/delete', { id: id }); },
        setEnabled: function (id, enabled) {
            return request('POST', '/syspara/enabled', { id: id, enabled: enabled ? 1 : 0 });
        }
    };

    /* ---------- 后端可用性探测：不可用时自动回退本地模拟服务 ---------- */
    var readyDfd = $.Deferred();          // 接口地址探测完成信号（导航 / 页面首屏等应等它，避免先拿到模拟数据）
    var isReady = false;                   // 用布尔位判重（部分精简版 jQuery 的 Deferred 没有 state()）
    function markReady() {
        if (isReady) { return; }
        isReady = true;
        readyDfd.resolve();
    }
    function fallbackToMock(reason) {
        if (config.useMock) { markReady(); return; }
        config.useMock = true;
        if (window.console && window.console.warn) {
            window.console.warn('[api.js] 后端不可用（' + reason + '），已回退到本地模拟服务。启动后端： python server/app.py');
        }
        markReady();
    }
    function detectBackend() {
        if (config.useMock || !config.autoFallback) { markReady(); return; }
        probe(config.baseUrl, function (okFlag) {
            if (okFlag) { markReady(); return; }
            // 页面从公网 / 内网域名打开时，绝不再去探测 127.0.0.1：那台机器是访问者自己的电脑，
            // 探测必然被浏览器的私有网络访问（PNA）拦掉，一改成绝对地址整站请求都会跟着失败。
            // 这里保持同源 'api' 不变，让真实的连接错误暴露出来（而不是悄悄换成演示数据）。
            if (!LOCAL_PAGE) {
                if (window.console && window.console.warn) {
                    window.console.warn('[api.js] 同源 ' + config.baseUrl + '/health 不可用；' +
                        '当前页面域名 ' + window.location.host + ' 不是本机，已保持同源地址，不再改连 127.0.0.1。');
                }
                markReady();
                return;
            }
            // 同源没有后端（例如用独立静态服务 5500 打开页面）→ 再探测后端默认地址（后端已开启 CORS），
            // 探测通过就直连后端（左侧导航读的是数据库里的排序号），否则才回退本地模拟服务。
            if (config.baseUrl === REMOTE_BASE) { fallbackToMock('后端不可用'); return; }
            probe(REMOTE_BASE, function (okRemote) {
                if (okRemote) { config.baseUrl = REMOTE_BASE; markReady(); }
                else { fallbackToMock('后端不可用'); }
            });
        });
    }
    function probe(base, callback) {
        try {
            $.ajax({ url: base + '/health', type: 'GET', dataType: 'json', timeout: 3000, cache: false })
                .done(function (res) { callback(!!(res && (res.code === 0 || res.code === 200))); })
                .fail(function () { callback(false); });
        } catch (err) { callback(false); }
    }
    try { detectBackend(); } catch (err) { fallbackToMock(err.message); }

    return {
        config: config,
        menu: menu, group: group, groupItem: groupItem, org: org, emp: emp, role: role,
        rolePower: rolePower, pageOpBtn: pageOpBtn, dptMgr: dptMgr, empArchive: empArchive,
        useInfo: useInfo, auth: auth, nav: nav,
        serviceEmail: serviceEmail, mail: mail, empMail: empMail,
        msg: msg,
        notify: notify,
        addressBook: addressBook,
        dbInfo: dbInfo,
        appInfo: appInfo,                     // 数据中心 · 应用信息（应用 + 绑定连接 1:1）
        appSchema: appSchema,                 // 数据中心 · 应用结构（库/对象/字段 + 版本脚本 + 实库对比）
        report: report,
        project: project,
        projectDir: projectDir,
        projectFile: projectFile,
        projectMember: projectMember,   // 项目管理 · 项目组（成员 + 自动通知）
        projectPlan: projectPlan,       // 项目管理 · 项目计划（计划 / 工单 / 通知）
        workPlan: workPlan,
        workload: workload,                   // 项目中心 · 员工工作量统计（接单 / 完成率 / 明细钻取）
        requirement: requirement,             // 项目管理 · 工作计划（Visio 风格甘特图 / 时间线）
        bug: bug,                             // 项目管理 · 缺陷管理（登记 / 评估时间线 / 转修复工单）
        sysDict: sysDict,
        sysDictItem: sysDictItem,
        sysPara: sysPara,
        /** 接口地址探测完成（已确定用真实后端还是本地模拟服务） */
        ready: readyDfd.promise(),
        /** 等探测完成后执行（已完成则立即执行） */
        whenReady: function (fn) { readyDfd.done(fn); },
        /** 这个接口会等多久（ms）：扫描 / 比对用 config.scanTimeout，其余慢接口用 config.slowTimeout */
        timeoutFor: timeoutFor,
        isSlowApi: isSlowApi,
        isScanApi: isScanApi,
        waitText: waitText,
        util: { now: now, clone: clone }
    };
})(jQuery);
