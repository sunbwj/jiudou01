/* ==========================================================================
   file-preview.js —— 项目文件在线预览（项目信息页右栏 / 项目文件页共用能力）
   --------------------------------------------------------------------------
   · 按扩展名分流 kindOf()：
       image  → <img> 直接展示（png/jpg/jpeg/gif/bmp/webp/svg）
       pdf    → <iframe> 浏览器内置阅读器
       text   → fetch 文本放 <pre>（txt/log/md/csv/json/xml/html/htm，超 512KB 截断）
       word   → .docx 用 docx-preview 组件保真渲染（样式/表格/图片不丢）；
                .doc / .docm 调 /api/preview/pdf 服务端 Office COM 转 PDF 后 iframe 展示
       excel  → .xlsx 自研 OOXML 解析（sharedStrings + workbook + sheets），旧版 .xls 转下载
       ppt    → .pptx 用 PPTXjs 组件按幻灯片保真渲染（文本框/图片/形状/图表）；
                .ppt / .pptm 调 /api/preview/pdf 服务端转 PDF 后 iframe 展示
       其它   → 直接触发下载（opts.onDownload）
   · 第三方组件按需从 /vendor/ 懒加载（docx-preview、PPTXjs、jszip、filereader、d3+nvd3）；
     ⚠ JSZip 双版本隔离：docx-preview 需要 3.x，PPTXjs 内部用 2.x 的同步 zip.load()（3.x 已移除），
       因此 3.x 常驻全局，PPTXjs 渲染期间临时切到 2.x（window.JSZipV2），结束立即还原；
     PPTXjs 还依赖 filereader.js（缺它插件第一行 FileReaderJS.setSync 就抛 ReferenceError）；
   · 兜底链：docx 组件失败 → WordImport.parseDocx；pptx 组件失败 → 服务端转 PDF；
     再失败给「预览失败 + 下载文件」按钮（**不再**把 pptx 降级成抽文本的伪 HTML）；
   · 服务端 /api/preview/pdf：Word/PowerPoint COM（WPS 兜底）转 PDF，带磁盘缓存，
     前端带 token 取流（AppAuth.token()），JSON 响应视为业务错误并展示 message；
   · 所有取数都走同源路径，失败时在弹窗里给出「预览失败 + 下载文件」按钮，不静默。
   ========================================================================== */
(function (window, document) {
    'use strict';

    var KIND_EXTS = {
        image: 'png jpg jpeg gif bmp webp svg',
        pdf: 'pdf',
        text: 'txt log md csv json xml html htm',
        word: 'docx docm doc',
        excel: 'xlsx xlsm xls',
        ppt: 'pptx pptm ppt'
    };
    var TEXT_LIMIT = 512 * 1024;        // 文本预览最多渲染 512KB
    var XLSX_MAX_ROWS = 500;            // 每个 sheet 最多渲染行数
    var XLSX_MAX_COLS = 40;             // 每个 sheet 最多渲染列数

    function extOf(fileName) {
        var m = /\.([0-9a-z]+)$/i.exec(String(fileName || ''));
        return m ? m[1].toLowerCase() : '';
    }
    /** 按文件名判断预览方式：image / pdf / text / word / excel / ppt / download */
    function kindOf(fileName) {
        var ext = extOf(fileName);
        for (var kind in KIND_EXTS) {
            if (KIND_EXTS.hasOwnProperty(kind) &&
                (' ' + KIND_EXTS[kind] + ' ').indexOf(' ' + ext + ' ') >= 0) {
                return kind;
            }
        }
        return 'download';
    }
    function esc(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function fileUrl(file) {
        var url = file && (file.downloadUrl || file.filePath) || '';
        return '/' + String(url).replace(/^\/+/, '');
    }
    function fetchBuffer(url) {
        if (typeof window.fetch !== 'function') {
            return Promise.reject(new Error('当前浏览器不支持在线取文件内容'));
        }
        return window.fetch(url, { credentials: 'same-origin' }).then(function (res) {
            if (!res.ok) { throw new Error('文件不存在或已被删除（HTTP ' + res.status + '）'); }
            return res.arrayBuffer();
        });
    }
    function fetchText(url) {
        if (typeof window.fetch !== 'function') {
            return Promise.reject(new Error('当前浏览器不支持在线取文件内容'));
        }
        return window.fetch(url, { credentials: 'same-origin' }).then(function (res) {
            if (!res.ok) { throw new Error('文件不存在或已被删除（HTTP ' + res.status + '）'); }
            return res.text();
        });
    }

    /* ================= 第三方组件懒加载（/vendor/ 本地文件，失败即回退自研解析） ================= */
    var scriptCache = {};
    function loadScript(src) {
        if (!scriptCache[src]) {
            scriptCache[src] = new Promise(function (resolve, reject) {
                var el = document.createElement('script');
                el.src = src;
                el.onload = function () { resolve(); };
                el.onerror = function () {
                    delete scriptCache[src];
                    reject(new Error('预览组件加载失败：' + src));
                };
                document.head.appendChild(el);
            });
        }
        return scriptCache[src];
    }
    function loadCss(href) {
        return new Promise(function (resolve) {
            if (document.querySelector('link[data-fp-css="' + href + '"]')) { resolve(); return; }
            var el = document.createElement('link');
            el.rel = 'stylesheet';
            el.href = href;
            el.setAttribute('data-fp-css', href);
            el.onload = function () { resolve(); };
            el.onerror = function () { resolve(); };     // 样式缺失不阻断预览
            document.head.appendChild(el);
        });
    }
    /** docx-preview / PPTXjs 需要的 vendor 脚本清单 */
    function loadVendor(names) {
        var chain = Promise.resolve();
        for (var i = 0; i < names.length; i++) {
            (function (src) {
                chain = chain.then(function () { return loadScript('/vendor/' + src); });
            })(names[i]);
        }
        return chain;
    }

    /* ---- JSZip 双版本：docx-preview 用 3.x；PPTXjs 的 `zip.load(file)` 只有 2.x 有 ----
       jszip 2.x 加载时会覆盖 window.JSZip，所以先备份 3.x，加载完立刻还原，
       把 2.x 挂在 window.JSZipV2 上，只在 PPTXjs 渲染期间临时替换全局。 */
    var jszipV2Ready = null;
    function ensureJszipV2() {
        if (jszipV2Ready) { return jszipV2Ready; }
        jszipV2Ready = loadScript('/vendor/jszip.min.js').then(function () {
            if (!window.JSZipV3) { window.JSZipV3 = window.JSZip; }
            return loadScript('/vendor/jszip.v2.min.js');
        }).then(function () {
            window.JSZipV2 = window.JSZip;          // 此刻全局是 2.x
            window.JSZip = window.JSZipV3;          // 立即还原 3.x，docx-preview 不受影响
            return window.JSZipV2;
        });
        return jszipV2Ready;
    }
    function useJszipV2(on) {
        if (on && window.JSZipV2) { window.JSZip = window.JSZipV2; }
        else if (!on && window.JSZipV3) { window.JSZip = window.JSZipV3; }
    }

    /* ================= Word / PowerPoint → PDF（服务端 Office COM 转换） ================= */
    /** 调 /api/preview/pdf 取转换后的 PDF blob（JSON 响应视为业务错误） */
    function fetchConvertedPdf(file) {
        var token = window.AppAuth && typeof window.AppAuth.token === 'function'
            ? window.AppAuth.token() : '';
        var fileId = (file && (file.id || file.fileId)) || '';
        /* 调用方给了 pdfUrl（如工作计划执行记录附件）就走它，默认仍是项目文件转换接口 */
        var url = (file && file.pdfUrl)
            ? String(file.pdfUrl)
            : ('/api/preview/pdf?id=' + encodeURIComponent(fileId) +
               (token ? '&token=' + encodeURIComponent(token) : ''));
        return window.fetch(url, { credentials: 'same-origin' }).then(function (res) {
            var ctype = (res.headers.get('content-type') || '').toLowerCase();
            if (res.ok && ctype.indexOf('application/pdf') >= 0) {
                return res.blob().then(function (blob) {
                    return URL.createObjectURL(blob);
                });
            }
            return res.json().catch(function () { return {}; }).then(function (body) {
                throw new Error((body && body.message) ||
                    ('文档转换服务不可用（HTTP ' + res.status + '）'));
            });
        });
    }
    function pdfStage($stage, blobUrl) {
        $stage.html('<iframe class="fp-frame" src="' + esc(blobUrl) + '" title="文档预览"></iframe>');
    }

    /* ================= xlsx 解析（自研，复用 WordImport.zipHelpers） ================= */
    function parseXml(xmlText) {
        var doc = new window.DOMParser().parseFromString(xmlText, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) {
            throw new Error('表格内容 XML 解析失败，请确认文件由 Excel / WPS 正常保存');
        }
        return doc;
    }
    /** <si> 里的多段 <t> 拼成一个共享字符串 */
    function sharedStrings(doc) {
        var out = [], nodes = doc.getElementsByTagName('si'), i, j, ts, text;
        for (i = 0; i < nodes.length; i++) {
            ts = nodes[i].getElementsByTagName('t');
            text = '';
            for (j = 0; j < ts.length; j++) { text += ts[j].textContent || ''; }
            out.push(text);
        }
        return out;
    }
    function colIndex(cellRef) {
        var m = /^([A-Z]+)\d+$/.exec(String(cellRef || '').toUpperCase());
        if (!m) { return -1; }
        var n = 0, s = m[1], i;
        for (i = 0; i < s.length; i++) { n = n * 26 + (s.charCodeAt(i) - 64); }
        return n - 1;
    }
    function cellText(c, shared) {
        var t = c.getAttribute('t') || 'n';
        if (t === 'inlineStr') {
            var ts = c.getElementsByTagName('t'), text = '', i;
            for (i = 0; i < ts.length; i++) { text += ts[i].textContent || ''; }
            return text;
        }
        var vNode = c.getElementsByTagName('v');
        var v = vNode.length ? (vNode[0].textContent || '') : '';
        if (t === 's') { return shared[parseInt(v, 10)] != null ? shared[parseInt(v, 10)] : ''; }
        if (t === 'b') { return v === '1' ? 'TRUE' : 'FALSE'; }
        return v;
    }
    /** xlsx 字节 → {sheets:[{name, rows:[[..]]}]}（首个表缺失时抛错） */
    function xlsxToSheets(buffer) {
        var zh = window.WordImport && window.WordImport.zipHelpers;
        if (!zh) { throw new Error('缺少 word-import.js，无法解析表格文件'); }
        var bytes = zh.toBytes(buffer);
        var entries = zh.zipEntries(bytes);
        function xmlOf(path, label) {
            var entry = entries[path];
            if (!entry) { throw new Error(label + '缺失，不是有效的 .xlsx 文件'); }
            var raw = zh.entryData(bytes, entry);
            var ready = entry.method === 0 ? Promise.resolve(raw) : zh.inflateRaw(raw);
            return ready.then(function (b) { return zh.utf8Decode(b); });
        }
        return Promise.all([
            xmlOf('xl/sharedStrings.xml', '共享字符串表'),
            xmlOf('xl/workbook.xml', '工作簿定义')
        ]).catch(function (e) {
            // sharedStrings 缺失允许（纯 inlineStr 表）；workbook 缺失才是致命的
            return Promise.all([
                Promise.resolve(null),
                xmlOf('xl/workbook.xml', '工作簿定义')
            ]).then(function (pair) {
                if (!pair[1]) { throw e; }
                return pair;
            });
        }).then(function (pair) {
            var shared = pair[0] ? sharedStrings(parseXml(pair[0])) : [];
            var wb = parseXml(pair[1]);
            var sheetNodes = [], i;
            // 命名空间无关取 sheet 节点
            (function walk(node) {
                for (var n = node.firstChild; n; n = n.nextSibling) {
                    if (n.nodeType !== 1) { continue; }
                    var name = String(n.localName || n.nodeName || '').toLowerCase();
                    if (name === 'sheet') { sheetNodes.push(n); }
                    walk(n);
                }
            })(wb.documentElement);
            if (!sheetNodes.length) { throw new Error('工作簿里没有工作表'); }
            var relEntry = entries['xl/_rels/workbook.xml.rels'];
            var rels = {};
            if (relEntry) {
                var relRaw = zh.entryData(bytes, relEntry);
                var relReady = relEntry.method === 0 ? Promise.resolve(relRaw) : zh.inflateRaw(relRaw);
                return relReady.then(function (b) {
                    var relDoc = parseXml(zh.utf8Decode(b));
                    var rs = [], j;
                    (function walk2(node) {
                        for (var n = node.firstChild; n; n = n.nextSibling) {
                            if (n.nodeType !== 1) { continue; }
                            if (String(n.localName || n.nodeName || '').toLowerCase() === 'relationship') { rs.push(n); }
                            walk2(n);
                        }
                    })(relDoc.documentElement);
                    for (j = 0; j < rs.length; j++) {
                        rels[rs[j].getAttribute('Id') || ''] = rs[j].getAttribute('Target') || '';
                    }
                    return { sheetNodes: sheetNodes, rels: rels, shared: shared, xmlOf: xmlOf };
                });
            }
            return { sheetNodes: sheetNodes, rels: rels, shared: shared, xmlOf: xmlOf };
        }).then(function (ctx) {
            var sheets = [];
            for (var i = 0; i < ctx.sheetNodes.length; i++) {
                var node = ctx.sheetNodes[i];
                var rid = '';
                for (var a = 0; a < node.attributes.length; a++) {
                    if (String(node.attributes[a].localName || node.attributes[a].name)
                        .toLowerCase() === 'id') { rid = node.attributes[a].value; }
                }
                var target = String(ctx.rels[rid] || '');
                var path = 'xl/' + String(target).replace(/^\/xl\//, '').replace(/^\//, '');
                sheets.push({ name: node.getAttribute('name') || ('Sheet' + (i + 1)), path: path });
            }
            // 逐个 sheet 解析（保持顺序）
            var out = [], chain = Promise.resolve();
            for (var k = 0; k < sheets.length; k++) {
                (function (one) {
                    chain = chain.then(function () {
                        return ctx.xmlOf(one.path, '工作表「' + one.name + '」').then(function (xmlText) {
                            out.push({ name: one.name, rows: sheetRows(parseXml(xmlText), ctx.shared) });
                        }).catch(function () {
                            out.push({ name: one.name, rows: [], broken: true });
                        });
                    });
                })(sheets[k]);
            }
            return chain.then(function () { return { sheets: out }; });
        });
    }
    /** worksheet XML → 二维数组（按 r 属性定位列，最多 XLSX_MAX_ROWS × XLSX_MAX_COLS） */
    function sheetRows(doc, shared) {
        var rows = [], rowNodes = doc.getElementsByTagName('row');
        for (var i = 0; i < rowNodes.length && rows.length < XLSX_MAX_ROWS; i++) {
            var cells = rowNodes[i].getElementsByTagName('c'), arr = [], maxCol = 0, j;
            var meta = [];
            for (j = 0; j < cells.length; j++) {
                var idx = colIndex(cells[j].getAttribute('r'));
                if (idx < 0 || idx >= XLSX_MAX_COLS) { continue; }
                meta.push([idx, cellText(cells[j], shared)]);
                if (idx > maxCol) { maxCol = idx; }
            }
            for (j = 0; j <= maxCol; j++) { arr.push(''); }
            for (j = 0; j < meta.length; j++) { arr[meta[j][0]] = meta[j][1]; }
            rows.push(arr);
        }
        return rows;
    }
    function sheetsToHtml(data) {
        var html = '';
        for (var i = 0; i < data.sheets.length; i++) {
            var one = data.sheets[i];
            html += '<div class="fp-sheet"><div class="fp-sheet__name">' + esc(one.name) + '</div>';
            if (one.broken) {
                html += '<div class="fp-empty">该工作表无法解析（可能使用了压缩存储），请下载后查看</div></div>';
                continue;
            }
            if (!one.rows.length) {
                html += '<div class="fp-empty">空工作表</div></div>';
                continue;
            }
            html += '<table class="fp-grid"><tbody>';
            for (var r = 0; r < one.rows.length; r++) {
                html += '<tr' + (r === 0 ? ' class="fp-grid__head"' : '') + '>';
                for (var c = 0; c < one.rows[r].length; c++) {
                    html += '<td>' + esc(one.rows[r][c]) + '</td>';
                }
                html += '</tr>';
            }
            html += '</tbody></table></div>';
        }
        return html;
    }

    /* ================= pptx 解析（按页提取文本） ================= */
    /** pptx 字节 → [{no, paragraphs:[…]}]（无正文页保留空数组占位） */
    /** 判断某个 <p:txBody> 是否属于「标题占位符」：向上找到 <p:sp> 祖先，
     *  再在内部找 <p:cNvSpPr><p:ph type="title|ctrTitle"|idx="0"> */
    function isTitleShape(txBody) {
        var node = txBody;
        while (node && (node.nodeType !== 1 ||
            String(node.localName || node.nodeName || '').toLowerCase() !== 'sp')) {
            node = node.parentNode;
        }
        if (!node || typeof node.getElementsByTagName !== 'function') { return false; }
        var ph = node.getElementsByTagName('p:ph');
        if (ph && ph.length) {
            var t = ph[0].getAttribute('type') || '';
            if (t === 'title' || t === 'ctrTitle' || ph[0].getAttribute('idx') === '0') { return true; }
        }
        return false;
    }
    function pptxToSlides(buffer) {
        var zh = window.WordImport && window.WordImport.zipHelpers;
        if (!zh) { throw new Error('缺少 word-import.js，无法解析演示文稿'); }
        var bytes = zh.toBytes(buffer);
        var entries = zh.zipEntries(bytes);
        var slideNames = [], name;
        for (name in entries) {
            if (entries.hasOwnProperty(name) && /^ppt\/slides\/slide\d+\.xml$/.test(name)) {
                slideNames.push(name);
            }
        }
        if (!slideNames.length) { throw new Error('不是有效的 .pptx 文件（缺少幻灯片）'); }
        slideNames.sort(function (a, b) {
            return (parseInt(a.replace(/\D+/g, ''), 10) || 0) - (parseInt(b.replace(/\D+/g, ''), 10) || 0);
        });
        var slides = [], chain = Promise.resolve();
        for (var i = 0; i < slideNames.length; i++) {
            (function (path, no) {
                chain = chain.then(function () {
                    var entry = entries[path];
                    var raw = zh.entryData(bytes, entry);
                    var ready = entry.method === 0 ? Promise.resolve(raw) : zh.inflateRaw(raw);
                    return ready.then(function (b) {
                        var doc = parseXml(zh.utf8Decode(b));
                        // 命名空间无关收集所有 <p:txBody>（每个文本框独立成块，避免跨框串味）
                        var txBodies = [], j;
                        (function walk(node) {
                            for (var n = node.firstChild; n; n = n.nextSibling) {
                                if (n.nodeType !== 1) { continue; }
                                if (String(n.localName || n.nodeName || '').toLowerCase() === 'txbody') {
                                    txBodies.push(n);
                                }
                                walk(n);
                            }
                        })(doc.documentElement);
                        var title = '', paragraphs = [];
                        for (j = 0; j < txBodies.length; j++) {
                            var isTitle = isTitleShape(txBodies[j]);
                            var ps = txBodies[j].getElementsByTagName('a:p');
                            for (var k = 0; k < ps.length; k++) {
                                var runs = ps[k].getElementsByTagName('a:t');
                                var text = '';
                                for (var m = 0; m < runs.length; m++) { text += (runs[m].textContent || ''); }
                                paragraphs.push(text);
                                if (isTitle && !title && text) { title = text; }
                            }
                        }
                        slides.push({ no: no, title: title, paragraphs: paragraphs });
                    });
                });
            })(slideNames[i], i + 1);
        }
        return chain.then(function () { return slides; });
    }
    function slidesToHtml(slides) {
        var html = '';
        for (var i = 0; i < slides.length; i++) {
            var s = slides[i];
            html += '<section class="fp-slide" data-slide="' + s.no + '">' +
                '<div class="fp-slide__no">第 ' + s.no + ' 页</div>';
            if (s.title) { html += '<div class="fp-slide__title">' + esc(s.title) + '</div>'; }
            html += '<div class="fp-slide__body">';
            var hasText = false;
            for (var j = 0; j < s.paragraphs.length; j++) {
                if (s.paragraphs[j]) { hasText = true; }
                html += '<p>' + esc(s.paragraphs[j]) + '</p>';
            }
            if (!hasText && !s.title) { html += '<p class="fp-empty">（本页没有可提取的文字）</p>'; }
            html += '</div></section>';
        }
        return html;
    }
    /** 在预览舞台上方插入翻页导航（上一页 / 页码 / 下一页），点击平滑滚动到对应幻灯片 */
    function buildSlideNav($stage, total) {
        var $wrap = $stage.closest('.fp-wrap');
        if (!$wrap.length) { return; }
        var idx = 1;
        var $nav = $('<div class="fp-slides-nav"></div>');
        var $prev = $('<button type="button" class="el-button el-button--small">上一页</button>');
        var $next = $('<button type="button" class="el-button el-button--small">下一页</button>');
        var $info = $('<span class="fp-slides-nav__info"></span>');
        $nav.append($prev, $info, $next);
        $stage.before($nav);
        function show(n) {
            idx = Math.max(1, Math.min(total, n));
            var $sec = $('#fpSlides').find('section[data-slide="' + idx + '"]');
            if ($sec.length && $sec[0].scrollIntoView) { $sec[0].scrollIntoView({ block: 'start' }); }
            $info.text('第 ' + idx + ' / 共 ' + total + ' 页');
            $prev.prop('disabled', idx <= 1);
            $next.prop('disabled', idx >= total);
        }
        $prev.on('click', function () { show(idx - 1); });
        $next.on('click', function () { show(idx + 1); });
        show(1);
    }

    /** 用 PPTXjs 组件渲染 pptx（保真：文本框 / 图片 / 形状 / 表格 / 图表）。
     *  · 依赖链：jszip 2.x（同步 zip.load）+ filereader.js（插件入口就用 FileReaderJS）+
     *            d3 v3 / nvd3（图表）+ pptxjs.js 本体；
     *  · 组件异步处理且没有可靠的完成回调：轮询「是否出现 .slide」，超时即 reject 交给调用方回退。 */
    function renderPptxComponent($stage, buffer) {
        var uid = 'fpPptxHost' + new Date().getTime();
        return ensureJszipV2()
            .then(function () {
                return loadVendor(['filereader.js', 'd3.v3.min.js', 'nv.d3.min.js', 'pptxjs.js']);
            })
            .then(function () { return loadCss('/vendor/pptxjs.css'); })
            .then(function () { return loadCss('/vendor/nv.d3.css'); })
            .then(function () {
                if (!window.jQuery || !window.jQuery.fn.pptxToHtml) {
                    throw new Error('PPT 预览组件不可用');
                }
                if (!window.JSZipV2) { throw new Error('PPT 预览组件缺少 JSZip 2.x'); }
                $stage.html('<div class="fp-pptx" id="' + uid + '"></div>');
                var $host = window.jQuery('#' + uid);
                var blob = new window.Blob([buffer], {
                    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                });
                var blobUrl = URL.createObjectURL(blob);
                setTimeout(function () {                    // 渲染完留在页面上，两分钟后再回收
                    try { URL.revokeObjectURL(blobUrl); } catch (e) { }
                }, 120000);

                useJszipV2(true);                           // 只在渲染期间切 2.x
                try {
                    $host.pptxToHtml({
                        pptxFileUrl: blobUrl,
                        slideMode: false,                   // 静态全页展示（不需要放映导航）
                        keyBoardShortCut: false,
                        mediaProcess: false,                // 音视频不处理（预览场景下载查看）
                        themeProcess: true
                    });
                } catch (e) {
                    useJszipV2(false);
                    throw new Error('PPT 预览组件初始化失败：' + ((e && e.message) || e));
                }

                return new Promise(function (resolve, reject) {
                    var waited = 0;
                    (function poll() {
                        var $slides = $host.find('.slide');
                        if ($slides.length > 0) {
                            useJszipV2(false);              // 渲染完成，立刻还原 3.x
                            $host.find('.slides-loadnig-msg').remove();
                            fitSlides($stage, $host, $slides);
                            resolve();
                            return;
                        }
                        if (waited >= 30000) {
                            useJszipV2(false);
                            reject(new Error('PPT 预览组件渲染超时'));
                            return;
                        }
                        waited += 300;
                        setTimeout(poll, 300);
                    })();
                });
            });
    }

    /** 幻灯片按预览窗宽度等比缩放（PPTXjs 输出的是 1280×720 之类固定像素） */
    function fitSlides($stage, $host, $slides) {
        var avail = 0;
        try { avail = $stage.width() || 0; } catch (e) { avail = 0; }
        var real = 0;
        try { real = $slides.first()[0].getBoundingClientRect().width || 0; } catch (e) { real = 0; }
        if (!avail || !real || real <= avail) { return; }
        var scale = Math.max(0.35, Math.min(1, (avail - 8) / real));
        $host.css({ zoom: scale, '-moz-transform': 'scale(' + scale + ')' });
    }

    /* ================= 预览弹窗 ================= */
    var TPL =
        '<div class="fp-wrap">' +
            '<div class="fp-stage"></div>' +
            '<div class="fp-tip"></div>' +
        '</div>';

    function errorStage($stage, message, file, opts) {
        $stage.html(
            '<div class="fp-error"><svg class="svg-ico" viewBox="0 0 24 24"><path fill="currentColor" ' +
            'd="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>' +
            '<p class="fp-error__msg"></p>' +
            '<button type="button" class="el-button el-button--primary el-button--small fp-error__dl">下载文件</button>' +
            '</div>');
        $stage.find('.fp-error__msg').text(message || '预览失败');
        $stage.find('.fp-error__dl').on('click', function () {
            if (opts && typeof opts.onDownload === 'function') { opts.onDownload(file); }
        });
    }
    function downloadNow(file, opts) {
        if (opts && typeof opts.onDownload === 'function') { opts.onDownload(file); }
    }
    function oldFormatTip(ext) {
        return '旧版 .' + ext + ' 格式无法在线预览，已切换为直接下载（可在 Office / WPS 中另存为新格式后在线预览）';
    }

    /**
     * 打开预览弹窗
     * @param {Object} file 项目文件行（fileName / downloadUrl / fileSize / fileType…）
     * @param {Object} opts {onDownload(file), width}
     */
    function preview(file, opts) {
        opts = opts || {};
        var kind = kindOf(file && file.fileName);
        var name = (file && file.fileName) || '文件预览';
        if (kind === 'download') {
            downloadNow(file, opts);
            return Promise.resolve({ kind: kind, downloaded: true });
        }
        var $content = $(TPL);
        var handle = window.UI.dialog({
            title: name, width: opts.width || 880, maximizable: true,
            content: $content,
            onReady: function ($body) {
                $body.closest('.el-dialog').find('.el-dialog__footer').hide();
            }
        });
        var $stage = $content.find('.fp-stage');
        var $tip = $content.find('.fp-tip');
        var sizeText = file && file.fileSizeText ? file.fileSizeText : '';
        $tip.text((kind === 'image' ? '图片预览' : kind === 'pdf' ? 'PDF 预览' :
            kind === 'text' ? '文本预览' : kind === 'word' ? 'Word 文档预览' :
            kind === 'excel' ? '表格预览' : '演示文稿预览') + (sizeText ? ' · ' + sizeText : ''));

        var url = fileUrl(file);
        var job = Promise.resolve();
        if (kind === 'image') {
            $stage.html('<img class="fp-img" alt="' + esc(name) + '">');
            $stage.find('.fp-img').on('error', function () {
                errorStage($stage, '图片加载失败（文件不存在或已删除）', file, opts);
            }).attr('src', url);
        } else if (kind === 'pdf') {
            $stage.html('<iframe class="fp-frame" src="' + esc(url) + '" title="PDF 预览"></iframe>');
        } else if (kind === 'text') {
            job = fetchText(url).then(function (text) {
                var clipped = String(text).length > TEXT_LIMIT;
                $stage.html('<pre class="fp-text"></pre>');
                $stage.find('.fp-text').text(clipped
                    ? String(text).slice(0, TEXT_LIMIT) + '\n…（内容过长，仅展示前 512 KB，可下载查看全文）'
                    : String(text));
            }, function (err) {
                errorStage($stage, (err && err.message) || '文本加载失败', file, opts);
            });
        } else if (kind === 'word') {
            var ext = extOf(name);
            if (ext === 'doc' || ext === 'docm') {
                $tip.text('Word 文档预览 · 服务端转 PDF' + (sizeText ? ' · ' + sizeText : ''));
                job = fetchConvertedPdf(file).then(function (blobUrl) {
                    pdfStage($stage, blobUrl);
                }).then(null, function (err) {
                    errorStage($stage, (err && err.message) || '文档转换失败', file, opts);
                });
            } else {
                job = fetchBuffer(url).then(function (buf) {
                    // 优先 docx-preview 组件保真渲染；失败回退自研 parseDocx
                    return loadVendor(['jszip.min.js', 'docx-preview.min.js'])
                        .then(function () {
                            if (!window.docx || typeof window.docx.renderAsync !== 'function') {
                                throw new Error('docx 预览组件不可用');
                            }
                            $stage.html('<div class="fp-docx"></div>');
                            return window.docx.renderAsync(
                                buf, $stage.find('.fp-docx')[0], null,
                                { inWrapper: true, ignoreLastRenderedPageBreak: false });
                        })
                        .catch(function (compErr) {
                            return window.WordImport.parseDocx(buf).then(function (res) {
                                $stage.html('<div class="fp-doc"></div>');
                                $stage.find('.fp-doc').html(res.html || '<p class="fp-empty">（空文档）</p>');
                                if (res.imagesSkipped) {
                                    $tip.text($tip.text() + ' · 已跳过 ' + res.imagesSkipped + ' 处图片');
                                }
                            }, function () {
                                throw compErr;      // 两条路都失败：暴露组件错误
                            });
                        });
                }).then(null, function (err) {
                    errorStage($stage, (err && err.message) || 'Word 解析失败', file, opts);
                });
            }
        } else if (kind === 'excel') {
            if (extOf(name) === 'xls') {
                $tip.text(oldFormatTip('xls'));
                downloadNow(file, opts);
                errorStage($stage, oldFormatTip('xls'), file, opts);
            } else {
                job = fetchBuffer(url).then(function (buf) {
                    return xlsxToSheets(buf);
                }).then(function (data) {
                    $stage.html('<div class="fp-sheets">' + sheetsToHtml(data) + '</div>');
                }, function (err) {
                    errorStage($stage, (err && err.message) || '表格解析失败', file, opts);
                });
            }
        } else if (kind === 'ppt') {
            if (extOf(name) === 'ppt' || extOf(name) === 'pptm') {
                $tip.text('演示文稿预览 · 服务端转 PDF' + (sizeText ? ' · ' + sizeText : ''));
                job = fetchConvertedPdf(file).then(function (blobUrl) {
                    pdfStage($stage, blobUrl);
                }).then(null, function (err) {
                    errorStage($stage, (err && err.message) || '文档转换失败', file, opts);
                });
            } else {
                job = fetchBuffer(url).then(function (buf) {
                    // 首选 PPTXjs 组件按幻灯片保真渲染；失败再走服务端转 PDF（绝不降级成抽文本的伪 HTML）
                    return renderPptxComponent($stage, buf).then(function () {
                        $tip.text('演示文稿预览 · 组件渲染' + (sizeText ? ' · ' + sizeText : ''));
                    }, function (compErr) {
                        $tip.text('演示文稿预览 · 组件不可用，已切换服务端转 PDF' +
                            (sizeText ? ' · ' + sizeText : ''));
                        return fetchConvertedPdf(file).then(function (blobUrl) {
                            pdfStage($stage, blobUrl);
                        }, function (pdfErr) {
                            throw new Error(((compErr && compErr.message) || '组件渲染失败') +
                                '；转 PDF 也失败：' + ((pdfErr && pdfErr.message) || '未知错误'));
                        });
                    });
                }).then(null, function (err) {
                    errorStage($stage, (err && err.message) || '演示文稿解析失败', file, opts);
                });
            }
        }
        return job.then(function () { return { kind: kind, handle: handle }; });
    }

    window.FilePreview = {
        kindOf: kindOf,
        preview: preview,
        xlsxToSheets: xlsxToSheets,
        sheetsToHtml: sheetsToHtml,
        pptxToSlides: pptxToSlides,
        slidesToHtml: slidesToHtml
    };
})(window, document);
