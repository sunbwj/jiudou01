# -*- coding: utf-8 -*-
"""临时脚本：为 Edge 探针造一份「导入任务」样例 xlsx（用完即删）。

用模板本身作底，按 IMPORT_COLUMNS 的表头顺序填 5 行（4 行合法 + 1 行报错），
存到 tools/_edge_wp_import_sample.xlsx 供浏览器探针 fetch。

用法：python tools/_mk_import_sample.py
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'server'))

import openpyxl      # noqa: E402
import db            # noqa: E402
import service       # noqa: E402

OUT = os.path.join(HERE, '_edge_wp_import_sample.xlsx')


def main():
    svc = service.WorkPlanService()
    raw = svc._import_template_bytes()
    wb = openpyxl.load_workbook(io.BytesIO(raw))
    ws = wb['任务列表']
    names = [c[1] for c in svc.IMPORT_COLUMNS]          # 模板表头顺序（含 * 标记）
    # 表头文字里带 *，按去 * 后匹配更稳
    cols = {}
    for idx in range(1, ws.max_column + 1):
        v = str(ws.cell(row=1, column=idx).value or '').replace('*', '').replace('＊', '').strip()
        cols[v] = idx
    print('模板表头：', sorted(cols.keys()))

    rows = [
        # seq, level, 任务名, 类型, 开始, 结束, 工期, 责任人, 参与人员, 前置
        (1, 1, '导入演示 · 需求分析', '任务', '2026-12-01', '2026-12-03', None,
         'E00001 别文进', 'E00003 杨伟康,E00004 赵建民', ''),
        (2, 1, '导入演示 · 接口联调', '任务', '2026-12-04', '2026-12-08', None,
         'E00003 杨伟康', '', '1'),
        (3, 2, '导入演示 · 联调子项', '任务', '2026-12-04', '2026-12-06', None,
         'E00004 赵建民', 'E00001 别文进', ''),
        (4, 1, '导入演示 · 验收评审', '里程碑', '2026-12-10', '2026-12-10', None,
         'E00001 别文进', '', '2'),
        (5, 1, '导入演示 · 故意报错行', '任务', '2026-12-11', '2026-12-09', None,
         'E99999 不存在的人', '', '99'),
    ]
    for r, data in enumerate(rows, start=2):
        for col, val in zip(svc.IMPORT_COLUMNS, data):
            head = col[1]
            if val is None or val == '':
                continue
            idx = cols.get(head.replace('*', ''))
            if idx:
                ws.cell(row=r, column=idx).value = val

    wb.save(OUT)
    print('已生成：%s（%d 字节）' % (OUT, os.path.getsize(OUT)))

    # 顺手用后端解析函数自检一遍，确认样例真的能出 4 条 / 1 错
    blob = open(OUT, 'rb').read()
    res = svc._parse_import_bytes(blob, '_edge_wp_import_sample.xlsx')
    print('自检 summary =', res['summary'])
    for row in res['rows']:
        print('  row%s seq=%s lvl=%s %s owner=%s parts=%s ok=%s %s' % (
            row['rowNo'], row['seq'], row['level'], row['taskName'],
            row['ownerName'] or '-', row['participantNames'] or '-',
            row['ok'], '；'.join(row.get('errors') or [])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
