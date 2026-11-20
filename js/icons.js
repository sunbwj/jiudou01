/* ==========================================================================
   图标库：纯内联 SVG（无外部字体依赖，保证离线与各浏览器一致渲染）
   ========================================================================== */
window.Icons = (function () {
    var S = 'stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
    var list = [
        { name: 'menu', label: '菜单', tone: 'is-blue', inner: '<path fill="currentColor" d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h12v2H3v-2z"/>' },
        { name: 'dashboard', label: '仪表盘', tone: 'is-blue', inner: '<path fill="currentColor" d="M3 3h8v8H3V3zm10 0h8v5h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/>' },
        { name: 'user', label: '用户', tone: 'is-cyan', inner: '<path fill="currentColor" d="M12 12.5a4.25 4.25 0 100-8.5 4.25 4.25 0 000 8.5zm0 1.8c-4.2 0-7.6 2.2-7.6 4.9V21h15.2v-1.8c0-2.7-3.4-4.9-7.6-4.9z"/>' },
        { name: 'setting', label: '系统设置', tone: 'is-gray', inner: '<circle cx="12" cy="12" r="3" ' + S + '/><path ' + S + ' d="M12 2.8l1.3 2.1 2.5-.6 1.1 2.3 2.3 1.1-.6 2.5 2.1 1.3-1.4 2.2.9 2.4-2.4.9-1.3 2.1-2.2-1.4-2.4.9-1.1-2.3-2.3-1.1.6-2.5-2.1-1.3L6 12.4l.9-2.4 1.3-2.1 2.5.6 2.2-1.4z"/>' },
        { name: 'document', label: '文档', tone: 'is-blue', inner: '<path fill="currentColor" d="M6 2h7l5 5v15H6V2zm6 1.5V8h4.5L12 3.5zM8.5 12h7v1.6h-7V12zm0 4h7v1.6h-7V16z"/>' },
        { name: 'folder', label: '文件夹', tone: 'is-orange', inner: '<path fill="currentColor" d="M3 5.5A1.5 1.5 0 014.5 4h4.2l2 2.4h8.8A1.5 1.5 0 0121 7.9v10.6A1.5 1.5 0 0119.5 20h-15A1.5 1.5 0 013 18.5v-13z"/>' },
        { name: 'chart', label: '统计图表', tone: 'is-green', inner: '<path fill="currentColor" d="M4 20V10h3.2v10H4zm6.4 0V4h3.2v16h-3.2zM16.8 20v-7H20v7h-3.2z"/>' },
        { name: 'calendar', label: '日历', tone: 'is-red', inner: '<path fill="currentColor" d="M7 2v2H5.5A1.5 1.5 0 004 5.5V7h16V5.5A1.5 1.5 0 0018.5 4H17V2h-2v2H9V2H7zM4 9h16v11.5A1.5 1.5 0 0118.5 22h-13A1.5 1.5 0 014 20.5V9z"/>' },
        { name: 'message', label: '消息', tone: 'is-cyan', inner: '<path fill="currentColor" d="M4 4h16a1 1 0 011 1v10a1 1 0 01-1 1H9l-5 4V5a1 1 0 011-1z"/>' },
        { name: 'mail', label: '邮件', tone: 'is-blue', inner: '<path fill="currentColor" d="M3 5h18a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1zm1.8 2L12 12.4 19.2 7H4.8zM4 9.2V17h16V9.2l-7.4 5.5a1 1 0 01-1.2 0L4 9.2z"/>' },
        { name: 'cart', label: '订单', tone: 'is-orange', inner: '<path ' + S + ' d="M3 4h2.2l2.6 11h9.4l2.3-8H7"/><circle cx="9.5" cy="19" r="1.6" fill="currentColor"/><circle cx="17" cy="19" r="1.6" fill="currentColor"/>' },
        { name: 'star', label: '收藏', tone: 'is-orange', inner: '<path fill="currentColor" d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z"/>' },
        { name: 'lock', label: '权限', tone: 'is-red', inner: '<path fill="currentColor" d="M12 2a5 5 0 00-5 5v2.6H6v12h12v-12h-1V7a5 5 0 00-5-5zm0 2.2A2.8 2.8 0 0114.8 7v2.6H9.2V7A2.8 2.8 0 0112 4.2z"/>' },
        { name: 'search', label: '检索', tone: 'is-gray', inner: '<circle cx="10.5" cy="10.5" r="6" ' + S + '/><path ' + S + ' d="M15 15l5 5"/>' },
        { name: 'location', label: '定位', tone: 'is-green', inner: '<path fill="currentColor" d="M12 2c-4 0-7 3-7 6.8C5 15 12 22 12 22s7-7 7-13.2C19 5 16 2 12 2zm0 9.4a2.6 2.6 0 110-5.2 2.6 2.6 0 010 5.2z"/>' },
        { name: 'cloud', label: '云服务', tone: 'is-cyan', inner: '<path fill="currentColor" d="M7 19a4.5 4.5 0 01-.4-8.99A6 6 0 0118.4 9.2 4.4 4.4 0 0118 19H7z"/>' },
        { name: 'tag', label: '标签', tone: 'is-purple', inner: '<path fill="currentColor" d="M11.6 2.6l9.8 9.8a1.6 1.6 0 010 2.3l-7 7a1.6 1.6 0 01-2.3 0L2.3 11.9a1.6 1.6 0 01-.47-1.13V3.6A1.6 1.6 0 013.43 2h7.3c.42 0 .82.17 1.12.47l-.25.13z"/>' },
        { name: 'clock', label: '时间', tone: 'is-gray', inner: '<circle cx="12" cy="12" r="9" ' + S + '/><path ' + S + ' d="M12 7v5.4l3.4 2"/>' },
        { name: 'image', label: '图片', tone: 'is-purple', inner: '<path fill="currentColor" d="M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm2 12h12l-3.6-4.8-2.6 3.3-1.8-2.1L6 17z"/><circle cx="15.5" cy="9" r="1.4" fill="#fff"/>' },
        { name: 'database', label: '数据', tone: 'is-green', inner: '<ellipse cx="12" cy="6" rx="7.5" ry="3" ' + S + '/><path ' + S + ' d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3"/>' },
        { name: 'globe', label: '站点', tone: 'is-blue', inner: '<circle cx="12" cy="12" r="9" ' + S + '/><path ' + S + ' d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"/>' },
        { name: 'warning', label: '告警', tone: 'is-red', inner: '<path fill="currentColor" d="M12 3l9.5 16.5H2.5L12 3zm-1 6v5.4h2V9h-2zm0 6.8v2h2v-2h-2z"/>' },
        { name: 'bell', label: '通知', tone: 'is-orange', inner: '<path fill="currentColor" d="M12 2a6 6 0 00-6 6v4l-2 3h16l-2-3V8a6 6 0 00-6-6zm-2.6 16a2.6 2.6 0 005.2 0h-5.2z"/>' },
        { name: 'tool', label: '工具', tone: 'is-gray', inner: '<path fill="currentColor" d="M10 4h11v2H10V4zm0 7h11v2H10v-2zm0 7h11v2H10v-2zM4 4h3v3H4V4zm0 7h3v3H4v-3zm0 7h3v3H4v-3z"/>' },
        { name: 'flag', label: '标记', tone: 'is-purple', inner: '<path fill="currentColor" d="M6 2v20H4V2h2zm2 0h11l-2.4 5.2L19 12H8V2z"/>' }
    ];

    var map = {};
    for (var i = 0; i < list.length; i++) { map[list[i].name] = list[i]; }

    function get(name) { return map[name] || null; }

    /** 返回完整 svg 字符串 */
    function svg(name, size) {
        var it = get(name);
        if (!it) {
            return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '"><circle cx="12" cy="12" r="9" ' + S + '/></svg>';
        }
        return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '">' + it.inner + '</svg>';
    }

    return { list: list, get: get, svg: svg };
})();
