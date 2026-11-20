# -*- coding: utf-8 -*-
"""
打印分页版式自测（真实 Edge 打印 → PDF → 量文字坐标）
====================================================================
只用 jsdom 测不出「第 2 页页眉压住表头」这类分页问题，所以这里真的打印一次：

  1. tools/report-print-probe.js 用真实设计器生成打印页 HTML（90 行数据、带页眉页脚），
     再让 Edge 打印成 `_tmp_print_check.pdf`；
  2. 本脚本用 pdfminer 读每页文字坐标，断言：
       · 每一页都有页眉文字，且页眉在表格表头之上（不重合，留出可见间距）；
       · 每一页都有页脚文字，且页脚在所有数据行之下；
       · 数据行没有被页眉/页脚吃掉（90 行都在）。

用法：
    python tools/report-print-test.py            # 需要 8808 后端在跑
    python tools/report-print-test.py --keep     # 保留中间文件便于人工看 PDF

依赖：pdfminer.six（pip install pdfminer.six）
"""
from __future__ import print_function

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PDF = os.path.join(ROOT, '_tmp_print_check.pdf')

NODE = os.environ.get('PRINT_TEST_NODE') or r'C:\Users\chx\.workbuddy\binaries\node\versions\22.22.2\node.exe'
NODE_MODULES = os.environ.get('PRINT_TEST_NODE_PATH') or \
    r'C:\Users\chx\.workbuddy\binaries\node\workspace\node_modules'

pass_count = 0
fail_count = 0


def check(name, cond, extra=''):
    global pass_count, fail_count
    if cond:
        pass_count += 1
        print('  [PASS] ' + name)
    else:
        fail_count += 1
        print('  [FAIL] ' + name + ('  → ' + str(extra) if extra else ''))


def run_probe():
    """先跑 node 探针生成 PDF"""
    env = dict(os.environ)
    env['NODE_PATH'] = NODE_MODULES
    cmd = [NODE, os.path.join(HERE, 'report-print-probe.js')]
    print('运行打印探针：' + ' '.join(cmd))
    proc = subprocess.Popen(cmd, cwd=ROOT, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = proc.communicate()[0]
    try:
        text = out.decode('utf-8', 'replace')
    except Exception:
        text = str(out)
    print(text.strip()[-800:])
    return proc.returncode == 0 and os.path.isfile(PDF)


def page_lines(page):
    """把一页的文字块解析成 [(top, bottom, text)]，top 以纸张上边缘为 0"""
    from pdfminer.layout import LTTextContainer
    height = page.height
    items = []
    for el in page:
        if not isinstance(el, LTTextContainer):
            continue
        text = el.get_text().strip().replace('\n', ' ')
        if not text:
            continue
        items.append((round(height - el.y1, 1), round(height - el.y0, 1), text))
    items.sort()
    return height, items


def main():
    keep = '--keep' in sys.argv
    try:
        from pdfminer.high_level import extract_pages      # noqa: F401
    except ImportError:
        print('未安装 pdfminer.six，跳过（pip install pdfminer.six）')
        return 0

    if not run_probe():
        print('探针执行失败（后端 8808 是否在跑？）')
        return 1

    from pdfminer.high_level import extract_pages

    print('\n--- 打印分页：页眉 / 表头 / 页脚 ---')
    pages = []
    for page in extract_pages(PDF):
        pages.append(page_lines(page))

    check('打印结果至少 3 页（90 行数据）', len(pages) >= 3, str(len(pages)))

    all_rows = 0
    for idx, (height, items) in enumerate(pages, start=1):
        head = [one for one in items if 'PAGEHEAD' in one[2]]
        foot = [one for one in items if 'FOOTER' in one[2]]
        th = [one for one in items if '工号' in one[2]]
        cells = [one for one in items if one[2].startswith('E00')]
        all_rows += len(cells)

        check('第 %d 页有页眉' % idx, len(head) == 1,
              str([one[2][:12] for one in items[:3]]))
        check('第 %d 页有表头行' % idx, len(th) == 1, str(len(th)))
        if head and th:
            gap = round(th[0][0] - head[0][1], 1)
            check('第 %d 页页眉与表头不重合（间距 %.1fpt）' % (idx, gap), gap > 0.5,
                  'head bottom=%.1f th top=%.1f' % (head[0][1], th[0][0]))
        if foot and cells:
            last_cell = cells[-1]
            check('第 %d 页页脚在数据行之下' % idx, foot[0][0] > last_cell[1],
                  'foot top=%.1f last row bottom=%.1f' % (foot[0][0], last_cell[1]))
        if idx >= 4:
            break

    check('90 行数据全部打印出来（没有被页眉页脚吃掉）', all_rows == 90, str(all_rows))
    check('页脚出现在每一页', all('FOOTER' in ' '.join(one[2] for one in items)
                            for _h, items in pages), '')

    print('\n结果：通过 %d 项，失败 %d 项' % (pass_count, fail_count))
    if not keep:
        for name in ('_tmp_print_check.html', '_tmp_print_check.pdf'):
            path = os.path.join(ROOT, name)
            if os.path.isfile(path):
                os.remove(path)
    return 0 if fail_count == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
