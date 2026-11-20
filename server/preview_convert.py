# -*- coding: utf-8 -*-
"""
Office 文档在线预览的 PDF 转换（doc / docx / ppt / pptx → pdf）
--------------------------------------------------------------
· 通过本机 Office COM 自动化（MS Office 优先，WPS 兜底）把文档转成 PDF；
· 转换结果缓存到 <WEB_ROOT>/data/previewcache/<sha1>.pdf，键 = 源文件路径 + 修改时间 + 大小，
  源文件变了缓存自动失效；
· COM 是单线程 Apartments：用全局锁串行化转换（Flask threaded=True 下防并发崩 Office）；
· 每次转换前 pythoncom.CoInitialize()（每个请求线程一个 STA），结束后 CoUninitialize + Quit。
"""
import hashlib
import os
import threading
import traceback

WEB_ROOT_LOCAL = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
PREVIEW_CACHE_ROOT = os.path.join(WEB_ROOT_LOCAL, 'data', 'previewcache')

# 支持「在线转 PDF 预览」的扩展名（pdf 本身无需转换）
CONVERT_EXTS = ('doc', 'docm', 'docx', 'ppt', 'pptm', 'pptx')

# Word / PowerPoint 的另存为 PDF 常量：wdFormatPDF=17 / ppSaveAsPDF=32
PDF_FORMAT_WORD = 17
PDF_FORMAT_PPT = 32

_CONVERT_LOCK = threading.Lock()


def _app_quit(app):
    try:
        app.Quit()
    except Exception:
        pass


def _convert_with_word(src, dst):
    """MS Word COM：doc/docx/docm → PDF；失败返回 False（交由 WPS 兜底）"""
    import win32com.client as wc
    app = wc.Dispatch('Word.Application')
    try:
        app.Visible = False
        app.DisplayAlerts = 0
        doc = app.Documents.Open(src, ReadOnly=True, AddToRecentFiles=False)
        try:
            doc.ExportAsFixedFormat(dst, PDF_FORMAT_WORD)
        finally:
            doc.Close(False)
        return os.path.isfile(dst) and os.path.getsize(dst) > 0
    finally:
        _app_quit(app)


def _convert_with_wps_word(src, dst):
    """WPS 文字（KWps.Application）兜底：API 与 MS Word 兼容"""
    import win32com.client as wc
    app = wc.Dispatch('KWps.Application')
    try:
        app.Visible = False
        doc = app.Documents.Open(src, ReadOnly=True)
        try:
            doc.SaveAs2(dst, PDF_FORMAT_WORD)
        finally:
            doc.Close(False)
        return os.path.isfile(dst) and os.path.getsize(dst) > 0
    finally:
        _app_quit(app)


def _convert_with_powerpoint(src, dst):
    """MS PowerPoint COM：ppt/pptx/pptm → PDF"""
    import win32com.client as wc
    app = wc.Dispatch('PowerPoint.Application')
    try:
        pres = app.Presentations.Open(src, ReadOnly=True, Untitled=False, WithWindow=False)
        try:
            pres.SaveAs(dst, PDF_FORMAT_PPT)
        finally:
            pres.Close()
        return os.path.isfile(dst) and os.path.getsize(dst) > 0
    finally:
        _app_quit(app)


def _convert_with_wps_ppt(src, dst):
    """WPS 演示（KWpp.Application）兜底"""
    import win32com.client as wc
    app = wc.Dispatch('KWpp.Application')
    try:
        app.Visible = False
        pres = app.Presentations.Open(src, ReadOnly=True, WithWindow=False)
        try:
            pres.SaveAs(dst, PDF_FORMAT_PPT)
        finally:
            pres.Close()
        return os.path.isfile(dst) and os.path.getsize(dst) > 0
    finally:
        _app_quit(app)


def _cache_path(src):
    """缓存键：源路径 + 修改时间 + 大小（内容变化即换新键）"""
    try:
        stat = os.stat(src)
        key = '%s|%s|%s' % (os.path.abspath(src), stat.st_mtime, stat.st_size)
    except OSError:
        key = os.path.abspath(src)
    return os.path.join(PREVIEW_CACHE_ROOT,
                        hashlib.sha1(key.encode('utf-8')).hexdigest() + '.pdf')


def convert_to_pdf(src, ext):
    """
    把 <src>（绝对路径）转成 PDF，返回缓存 PDF 的绝对路径。
    ext 必须在 CONVERT_EXTS 里（调用方已校验）。转换失败抛 RuntimeError。
    """
    import pythoncom
    ext = (ext or '').lower().lstrip('.')
    dst = _cache_path(src)
    if os.path.isfile(dst) and os.path.getsize(dst) > 0:
        return dst

    if not os.path.isdir(PREVIEW_CACHE_ROOT):
        try:
            os.makedirs(PREVIEW_CACHE_ROOT)
        except OSError as exc:
            raise RuntimeError('预览缓存目录不可写：%s' % exc)

    # 走了半截的旧缓存（上次转换中断）先清掉
    try:
        if os.path.isfile(dst):
            os.remove(dst)
    except OSError:
        pass

    if ext in ('doc', 'docm', 'docx'):
        attempts = [(_convert_with_word, 'Word'), (_convert_with_wps_word, 'WPS 文字')]
    else:
        attempts = [(_convert_with_powerpoint, 'PowerPoint'), (_convert_with_wps_ppt, 'WPS 演示')]

    errors = []
    with _CONVERT_LOCK:
        pythoncom.CoInitialize()
        try:
            for fn, label in attempts:
                try:
                    if fn(src, dst):
                        return dst
                    errors.append('%s：转换结果为空' % label)
                except Exception as exc:
                    errors.append('%s：%s' % (label, str(exc)[:200]))
                    traceback.print_exc()
        finally:
            pythoncom.CoUninitialize()

    raise RuntimeError('文档转换失败（' + '；'.join(errors) + '）')
