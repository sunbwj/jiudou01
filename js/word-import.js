/* ==========================================================================
   word-import.js —— 项目说明富文本 · Word 导入与 HTML 安全清洗
   --------------------------------------------------------------------------
   · 不引入任何第三方库：.docx 本质是一个 ZIP，用浏览器原生 DecompressionStream
     解压 word/document.xml，再按 OOXML 结构转成 HTML（段落 / 标题 / 表格 /
     粗斜体 / 下划线 / 字号 / 颜色 / 对齐 / 换行 / 制表符）；
   · ZIP 里 method=0（仅存储，不压缩）的条目无需解压，jsdom 里也能完整跑通，
     tools/word-import-test.js 正是用这种 ZIP 做回归；
   · 真实浏览器优先本地解析（离线 Mock 通道同样可用）；若浏览器不支持
     deflate-raw 解压，Api.project.importDoc 会回落到后端 /api/project/importdoc
     （Python zipfile + ElementTree，同口径实现）；
   · sanitize() 是标签 / 属性 / CSS 三层白名单清洗，保存前、Word 粘贴前、
     Word 导入后都会过一遍，后端 server/service.py 另有一份同口径兜底；
   · 旧版 .doc 是二进制格式，无法在浏览器解析，统一提示「另存为 .docx」。
   ========================================================================== */
(function (window, document) {
    'use strict';

    /* ---------------- 白名单（与 server/service.py 同口径） ---------------- */
    var ALLOW = {};
    var TAGS = ('p div span br b strong i em u s strike del sub sup ul ol li '
        + 'table thead tbody tfoot tr td th h1 h2 h3 h4 h5 h6 '
        + 'blockquote hr pre code img a font').split(' ');
    for (var t = 0; t < TAGS.length; t++) { ALLOW[TAGS[t]] = true; }
    var DROP_CONTENT = { script: 1, style: 1, iframe: 1, object: 1, embed: 1,
        template: 1, noscript: 1, title: 1 };
    var STYLE_PROPS = {};
    var PROPS = ('text-align font-size font-weight font-style text-decoration color '
        + 'background-color line-height margin margin-left margin-right padding '
        + 'padding-left text-indent border-collapse width height vertical-align '
        + 'font-family white-space border border-color border-width').split(' ');
    for (var p = 0; p < PROPS.length; p++) { STYLE_PROPS[PROPS[p]] = true; }
    var ATTRS = {
        '*': { style: 1, align: 1, title: 1 },
        a: { href: 1, target: 1, rel: 1 },
        img: { src: 1, alt: 1, width: 1, height: 1 },
        td: { colspan: 1, rowspan: 1, width: 1, valign: 1 },
        th: { colspan: 1, rowspan: 1, width: 1, valign: 1 },
        table: { border: 1, cellpadding: 1, cellspacing: 1, width: 1 },
        font: { color: 1, size: 1, face: 1 }
    };
    var BAD_CSS = /expression|javascript:|url\(|@import|behavior:|position:|filter:|[<>]/i;
    var NUMERIC = /^\d{1,4}(%|px|pt)?$/i;
    var SAFE_URL = /^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i;
    var SAFE_IMG_DATA = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/i;

    function safeUrl(value, isImg) {
        var text = String(value || '').replace(/\x00/g, '').trim();
        var low = text.toLowerCase();
        if (/^(javascript:|vbscript:|file:|data:text|data:application)/.test(low)) { return false; }
        if (/^data:/.test(low)) { return !!(isImg && SAFE_IMG_DATA.test(text)); }
        if (SAFE_URL.test(text)) { return true; }
        return !/^[a-z][a-z0-9+.\-]*:/i.test(low);
    }
    function safeStyle(value) {
        var parts = String(value || '').split(';'), out = [];
        for (var i = 0; i < parts.length; i++) {
            var idx = parts[i].indexOf(':');
            if (idx < 0) { continue; }
            var key = parts[i].slice(0, idx).trim().toLowerCase();
            var val = parts[i].slice(idx + 1).trim();
            if (!STYLE_PROPS[key] || !val || BAD_CSS.test(val)) { continue; }
            out.push(key + ':' + val);
        }
        return out.join(';');
    }
    function tagOf(node) {
        return String(node.nodeName || '').toLowerCase().split(':').pop();
    }

    /** 递归清洗：危险标签连同内容丢弃；未知标签只丢标签、保留已清洗的内容 */
    function cleanChildren(parent) {
        var node = parent.firstChild;
        while (node) {
            var next = node.nextSibling;
            if (node.nodeType === 8) {                       // 注释（Word 条件注释）
                parent.removeChild(node); node = next; continue;
            }
            if (node.nodeType === 3) { node = next; continue; }
            if (node.nodeType !== 1) { parent.removeChild(node); node = next; continue; }
            var tag = tagOf(node);
            if (DROP_CONTENT[tag]) { parent.removeChild(node); node = next; continue; }
            cleanChildren(node);                             // 先清子节点，再决定是否保留本标签
            if (!ALLOW[tag]) {
                while (node.firstChild) { parent.insertBefore(node.firstChild, node); }
                parent.removeChild(node); node = next; continue;
            }
            var attrs = node.attributes, drop = [], hasSrc = false, j, an, av;
            for (j = attrs.length - 1; j >= 0; j--) {
                an = String(attrs[j].name || '').toLowerCase();
                av = String(attrs[j].value || '');
                if (/^on/.test(an) || !(ATTRS['*'][an] || (ATTRS[tag] && ATTRS[tag][an]))) {
                    drop.push(an); continue;
                }
                if (an === 'style') {
                    var st = safeStyle(av);
                    if (!st) { drop.push(an); } else { node.setAttribute(an, st); }
                } else if (an === 'href' || an === 'src') {
                    if (!safeUrl(av, an === 'src')) { drop.push(an); }
                    else if (an === 'src') { hasSrc = true; }
                } else if (/^(colspan|rowspan|width|height|border|cellpadding|cellspacing|size)$/.test(an)) {
                    if (!NUMERIC.test(av.trim())) { drop.push(an); }
                } else if (/^(align|valign|target|color|face|title|alt|rel)$/.test(an)) {
                    if (av.length > 200) { drop.push(an); }
                }
            }
            for (j = 0; j < drop.length; j++) { node.removeAttribute(drop[j]); }
            if (tag === 'img' && !hasSrc) { parent.removeChild(node); }
            node = next;
        }
    }

    /** HTML 白名单清洗 → 可安全写入 contenteditable / 回显的片段 */
    function sanitize(html) {
        var holder = document.createElement('div');
        holder.innerHTML = String(html == null ? '' : html);
        cleanChildren(holder);
        return holder.innerHTML;
    }

    /** Word 粘贴清洗：先去掉条件注释、o:p 与 Mso 类名，再走统一白名单 */
    function cleanWordPaste(html) {
        var text = String(html == null ? '' : html);
        text = text.replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<o:p\b[^>]*>[\s\S]*?<\/o:p>/gi, '')
            .replace(/\sclass\s*=\s*["']?Mso[^"'\s>]*["']?/gi, '')
            .replace(/<span\b[^>]*>\s*<\/span>/gi, '');
        return sanitize(text);
    }

    /** HTML → 纯文本（段落 / 换行转成空格），用于列表 title 与字数统计 */
    function toText(html) {
        var clean = sanitize(html)
            .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
            .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)\s*>/gi, '\n');
        var box = document.createElement('div');
        box.innerHTML = clean;
        return String(box.textContent || '').replace(/\s+/g, ' ').trim();
    }

    /* ---------------- ZIP / OOXML 解析 ---------------- */
    function toBytes(buffer) {
        if (buffer instanceof Uint8Array) { return buffer; }
        return new Uint8Array(buffer);
    }
    function utf8Decode(bytes) {
        var arr = [], i = 0, c, cp;
        while (i < bytes.length) {
            c = bytes[i++];
            if (c < 0x80) { arr.push(String.fromCharCode(c)); }
            else if (c < 0xE0) {
                arr.push(String.fromCharCode(((c & 0x1F) << 6) | (bytes[i++] & 0x3F)));
            } else if (c < 0xF0) {
                arr.push(String.fromCharCode(((c & 0x0F) << 12) |
                    ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F)));
            } else {
                cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) |
                    ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
                cp -= 0x10000;
                arr.push(String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)));
            }
        }
        return arr.join('');
    }
    /** 从 EOCD 反查 central directory，返回 {文件名: {method,size,offset}} */
    function zipEntries(bytes) {
        var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        var eocd = -1;
        for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) { throw new Error('不是有效的 Word 文档（未找到 ZIP 结尾）'); }
        var count = dv.getUint16(eocd + 10, true);
        var pos = dv.getUint32(eocd + 16, true);
        var out = {};
        for (var n = 0; n < count; n++) {
            if (pos + 46 > bytes.length || dv.getUint32(pos, true) !== 0x02014b50) { break; }
            var method = dv.getUint16(pos + 10, true);
            var size = dv.getUint32(pos + 20, true);
            var nameLen = dv.getUint16(pos + 28, true);
            var extraLen = dv.getUint16(pos + 30, true);
            var commentLen = dv.getUint16(pos + 32, true);
            var offset = dv.getUint32(pos + 42, true);
            var name = utf8Decode(new Uint8Array(bytes.buffer, bytes.byteOffset + pos + 46, nameLen));
            out[name] = { method: method, size: size, offset: offset };
            pos += 46 + nameLen + extraLen + commentLen;
        }
        return out;
    }
    function entryData(bytes, entry) {
        var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        var pos = entry.offset;
        if (pos + 30 > bytes.length || dv.getUint32(pos, true) !== 0x04034b50) {
            throw new Error('Word 文档结构损坏（ZIP 本地头无效）');
        }
        var nameLen = dv.getUint16(pos + 26, true);
        var extraLen = dv.getUint16(pos + 28, true);
        var start = pos + 30 + nameLen + extraLen;
        if (start + entry.size > bytes.length) { throw new Error('Word 文档结构损坏（正文长度异常）'); }
        return new Uint8Array(bytes.buffer, bytes.byteOffset + start, entry.size);
    }
    function inflateRaw(raw) {
        if (typeof window.DecompressionStream === 'undefined' ||
            typeof window.Response === 'undefined' || !window.Blob ||
            !window.Blob.prototype.stream) {
            throw new Error('当前浏览器不支持本地解压 docx，已切换到服务端解析');
        }
        var ds = new window.DecompressionStream('deflate-raw');
        var stream = new window.Blob([raw]).stream().pipeThrough(ds);
        return window.Response && new window.Response(stream).arrayBuffer()
            .then(function (buf) { return new Uint8Array(buf); });
    }

    /* ---------------- OOXML DOM → HTML ---------------- */
    function xname(node) {
        return String(node && (node.localName || node.nodeName) || '').toLowerCase().split(':').pop();
    }
    function xattr(el, name) {
        if (!el || !el.attributes) { return ''; }
        for (var i = 0; i < el.attributes.length; i++) {
            var a = el.attributes[i];
            if (String(a.localName || a.name || '').toLowerCase().split(':').pop() === name) {
                return String(a.value || '');
            }
        }
        return '';
    }
    function xkids(el, name) {
        var out = [];
        for (var n = el && el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 1 && xname(n) === name) { out.push(n); }
        }
        return out;
    }
    function xkid(el, name) { var a = xkids(el, name); return a.length ? a[0] : null; }
    function esc(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function stateNew() { return { paragraphs: 0, images: 0 }; }

    function runHtml(run, state) {
        var rpr = xkid(run, 'rpr'), css = [], i;
        if (rpr) {
            if (xkid(rpr, 'b')) { css.push('font-weight:bold'); }
            if (xkid(rpr, 'i')) { css.push('font-style:italic'); }
            if (xkid(rpr, 'u')) { css.push('text-decoration:underline'); }
            if (xkid(rpr, 'strike') || xkid(rpr, 'dstrike')) { css.push('text-decoration:line-through'); }
            var color = xattr(xkid(rpr, 'color'), 'val');
            if (/^[0-9a-f]{6}$/i.test(color)) { css.push('color:#' + color); }
            var sz = xattr(xkid(rpr, 'sz'), 'val');
            if (/^\d+$/.test(sz) && +sz >= 4 && +sz <= 160) { css.push('font-size:' + (+sz / 2) + 'pt'); }
            var vert = xattr(xkid(rpr, 'vertalign'), 'val').toLowerCase();
            if (vert === 'superscript') { css.push('vertical-align:super'); }
            else if (vert === 'subscript') { css.push('vertical-align:sub'); }
        }
        var inner = [];
        for (var n = run.firstChild; n; n = n.nextSibling) {
            if (n.nodeType !== 1) { continue; }
            var tag = xname(n);
            if (tag === 't') { inner.push(esc(n.textContent || '')); }
            else if (tag === 'br') { inner.push('<br>'); }
            else if (tag === 'tab') { inner.push('&nbsp;&nbsp;&nbsp;&nbsp;'); }
            else if (tag === 'nobreakhyphen') { inner.push('-'); }
            else if (tag === 'drawing' || tag === 'pict' || tag === 'object') { state.images++; }
        }
        var text = inner.join('');
        if (!text) { return ''; }
        return css.length ? '<span style="' + css.join(';') + '">' + text + '</span>' : text;
    }
    function paragraphHtml(p, state) {
        var ppr = xkid(p, 'ppr'), align = '', heading = 0, bullet = false;
        if (ppr) {
            var jc = xattr(xkid(ppr, 'jc'), 'val').toLowerCase();
            align = { center: 'center', right: 'right', both: 'justify', left: 'left' }[jc] || '';
            var style = xattr(xkid(ppr, 'pstyle'), 'val').toLowerCase();
            var m = /^(?:heading|h)([1-6])$/.exec(style);
            if (m) { heading = +m[1]; }
            else if (style === 'title' || style === 'subtitle') { heading = 1; }
            bullet = !!xkid(ppr, 'numpr');
        }
        var parts = [], runs = xkids(p, 'r'), links = xkids(p, 'hyperlink'), i, j;
        for (i = 0; i < runs.length; i++) { parts.push(runHtml(runs[i], state)); }
        for (i = 0; i < links.length; i++) {
            var lr = xkids(links[i], 'r');
            for (j = 0; j < lr.length; j++) { parts.push(runHtml(lr[j], state)); }
        }
        var inner = parts.join('');
        state.paragraphs++;
        var css = [];
        if (align) { css.push('text-align:' + align); }
        if (bullet) { css.push('margin-left:24px'); inner = '• ' + inner; }
        var tag = heading ? 'h' + heading : 'p';
        return '<' + tag + (css.length ? ' style="' + css.join(';') + '"' : '') + '>' +
            (inner || '<br>') + '</' + tag + '>';
    }
    function tableHtml(tbl, state) {
        var rows = xkids(tbl, 'tr'), out = [];
        for (var i = 0; i < rows.length; i++) {
            var cells = xkids(rows[i], 'tc'), td = [];
            for (var j = 0; j < cells.length; j++) {
                var ps = xkids(cells[j], 'p'), body = [];
                for (var k = 0; k < ps.length; k++) { body.push(paragraphHtml(ps[k], state)); }
                td.push('<td>' + (body.join('') || '<br>') + '</td>');
            }
            if (td.length) { out.push('<tr>' + td.join('') + '</tr>'); }
        }
        return out.length ? '<table border="1" style="border-collapse:collapse;width:100%">' +
            out.join('') + '</table>' : '';
    }
    function documentXmlToHtml(xmlText) {
        var doc = new window.DOMParser().parseFromString(xmlText, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) {
            throw new Error('Word 正文 XML 解析失败，请确认文件由 Word / WPS 正常保存');
        }
        var body = xkid(doc.documentElement, 'body');
        if (!body) { throw new Error('Word 文档没有正文内容'); }
        var state = stateNew(), parts = [];
        for (var n = body.firstChild; n; n = n.nextSibling) {
            if (n.nodeType !== 1) { continue; }
            var tag = xname(n);
            if (tag === 'p') { parts.push(paragraphHtml(n, state)); }
            else if (tag === 'tbl') { parts.push(tableHtml(n, state)); }
        }
        return { html: sanitize(parts.join('')), meta: state };
    }

    /** 解析 docx 字节 → {html,text,paragraphs,imagesSkipped}（返回原生 Promise） */
    function parseDocx(buffer) {
        return Promise.resolve().then(function () {
            var bytes = toBytes(buffer);
            var entries = zipEntries(bytes);
            var entry = entries['word/document.xml'];
            if (!entry) {
                throw new Error('不是有效的 Word 文档（缺少 word/document.xml），请先另存为 .docx');
            }
            var raw = entryData(bytes, entry);
            var ready = entry.method === 0 ? Promise.resolve(raw) : inflateRaw(raw);
            return ready.then(function (xmlBytes) {
                var out = documentXmlToHtml(utf8Decode(xmlBytes));
                return {
                    html: out.html,
                    text: toText(out.html),
                    paragraphs: out.meta.paragraphs,
                    imagesSkipped: out.meta.images
                };
            });
        });
    }
    function decorate(res, fileName) {
        res.fileName = fileName || '';
        res.message = '已导入「' + (fileName || 'Word 文档') + '」（' + res.paragraphs +
            ' 个段落' + (res.imagesSkipped ? '，跳过 ' + res.imagesSkipped + ' 处图片' : '') + '）';
        return res;
    }
    function assertName(fileName) {
        var name = String(fileName || 'document.docx').toLowerCase();
        if (/\.doc$/.test(name)) {
            throw new Error('旧版 .doc 不支持直接导入，请在 Word / WPS 中另存为 .docx 后重试');
        }
        if (!/\.(docx|docm)$/.test(name)) {
            throw new Error('只支持 .docx / .docm 格式的 Word 文档');
        }
    }

    /** 解析 base64 / data URL → 同上结果 */
    function parseBase64(data, fileName) {
        return Promise.resolve().then(function () {
            assertName(fileName);
            var text = String(data == null ? '' : data);
            if (text.slice(0, 5).toLowerCase() === 'data:') {
                var comma = text.indexOf(',');
                text = comma >= 0 ? text.slice(comma + 1) : '';
            }
            text = text.replace(/\s+/g, '');
            if (!text) { throw new Error('请先选择要导入的 Word 文档'); }
            var bin, bytes, i;
            try { bin = window.atob(text); }
            catch (e) {
                throw new Error('Word 文档内容不是有效的 base64 数据，请重新选择 .docx 文件');
            }
            bytes = new Uint8Array(bin.length);
            for (i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
            return parseDocx(bytes.buffer).then(function (res) { return decorate(res, fileName); });
        });
    }
    /** File → ArrayBuffer，兼容没有 file.arrayBuffer() 的浏览器 */
    function readAsArrayBuffer(file) {
        return new Promise(function (resolve, reject) {
            if (file && typeof file.arrayBuffer === 'function') {
                file.arrayBuffer().then(resolve, reject); return;
            }
            var fr = new window.FileReader();
            fr.onload = function () { resolve(fr.result); };
            fr.onerror = function () { reject(new Error('读取 Word 文件失败')); };
            fr.readAsArrayBuffer(file);
        });
    }
    /** File → data URL（供后端兜底解析用） */
    function fileToBase64(file) {
        return new Promise(function (resolve, reject) {
            var fr = new window.FileReader();
            fr.onload = function () { resolve(String(fr.result || '')); };
            fr.onerror = function () { reject(new Error('读取 Word 文件失败')); };
            fr.readAsDataURL(file);
        });
    }
    function importFile(file) {
        return Promise.resolve().then(function () {
            assertName(file && file.name);
            return readAsArrayBuffer(file);
        }).then(function (buf) {
            return parseDocx(buf);
        }).then(function (res) { return decorate(res, file && file.name); });
    }
    /** 纯文本说明（老数据）包成段落，避免编辑时光标直接贴在 div 上 */
    function ensureHtml(value) {
        var text = String(value == null ? '' : value);
        if (!text) { return ''; }
        if (/</.test(text)) { return sanitize(text); }
        return '<p>' + esc(text).replace(/\n/g, '</p><p>') + '</p>';
    }

    window.WordImport = {
        sanitize: sanitize,
        cleanWordPaste: cleanWordPaste,
        toText: toText,
        ensureHtml: ensureHtml,
        parseDocx: parseDocx,
        parseBase64: parseBase64,
        importFile: importFile,
        fileToBase64: fileToBase64,
        /**
         * ZIP / OOXML 底层工具，供 file-preview.js 解析 xlsx / pptx 复用：
         *   toBytes(buffer) → Uint8Array；utf8Decode(bytes) → 字符串；
         *   zipEntries(bytes) → {文件名: {method,size,offset}}（从 EOCD 反查 central directory）；
         *   entryData(bytes, entry) → 条目原始字节；inflateRaw(raw) → Promise<Uint8Array>（deflate-raw）。
         */
        zipHelpers: {
            toBytes: toBytes,
            utf8Decode: utf8Decode,
            zipEntries: zipEntries,
            entryData: entryData,
            inflateRaw: inflateRaw
        },
        supported: function () {
            return typeof window.DOMParser !== 'undefined' && typeof window.atob !== 'undefined';
        }
    };
})(window, document);
