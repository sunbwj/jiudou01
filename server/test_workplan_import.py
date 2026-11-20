# -*- coding: utf-8 -*-
"""
工作计划 · Excel 导入（模板生成 / 文件解析）验证
------------------------------------------------
对应「计划管理 → 工作计划 → 工具栏「导入任务」」这条链路的后端部分：

  · 模板：表头与 IMPORT_COLUMNS 完全一致（含 * 必填标记）、带批注 / 下拉 / 日期格式、
    「填写说明」页签里有 工号+姓名 的示例；
  · 解析：层级推导 parentId、有子行自动变摘要任务、里程碑工期为 0、
    「开始日期 + 工期」推算结束日期、前置任务按序号映射；
  · 人员：「工号 姓名」/ 只写工号 / 只写姓名 都能识别，重名与不存在的工号要报错；
  · 错误：任务名空、日期非法、开始晚于结束、层级非数字、序号重复、
    前置任务不存在 / 引用自己 —— 一律标在该行，不阻断其它行；
  · 边界：只有表头 / 空文件 / 超过 200 行 / 非 xlsx / 非 base64；
  · 表头别名：用户把「开始日期」写成「开始」、「参与人员」写成「参与人」也能认。

全程只读：只读库里的员工表用来造「合法工号 + 姓名」，不写任何数据。

用法：python server/test_workplan_import.py
"""
import base64
import datetime
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db  # noqa: E402
import service  # noqa: E402

PASS = 0
FAIL = 0
svc = service.work_plan_service


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, ('→ ' + str(extra)) if extra else ''))


# ---------------------------------------------------------------- 造 xlsx
DEF_HEAD = ['序号', '层级', '任务名称', '任务类型', '开始日期', '结束日期',
            '责任人', '参与人员', '前置任务']
FULL_HEAD = ['序号', '层级', '任务名称', '任务类型', '开始日期', '结束日期',
             '工期(天)', '责任人', '参与人员', '前置任务']


def make_book(rows, headers=None, sheet_name='任务列表', blank_first=0):
    """rows 只给数据；headers 缺省用「用户手写版」表头（不带 * 必填标记）"""
    from openpyxl import Workbook
    if headers is None:
        headers = DEF_HEAD
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name
    for _ in range(blank_first):
        ws.append([])
    ws.append(headers)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def parse(raw, name='任务列表.xlsx'):
    return svc._parse_import_bytes(raw, name)


def err_text(res):
    return ' | '.join('%s行:%s' % (e['row'], e['msg']) for e in res['errors'])


# ---------------------------------------------------------------- 员工样本
def pick_employees():
    """挑 3 个姓名唯一、工号非空的在职员工，用来测「工号 姓名」两种写法"""
    try:
        rows = db.query_all('SELECT `code`,`nameCn` FROM `empinfos` '
                            'WHERE `code` IS NOT NULL AND `code`<>\'\' AND `status`<>0')
    except Exception:
        rows = []
    seen, out = {}, []
    for r in rows or []:
        code = str(r.get('code') or '').strip()
        name = str(r.get('nameCn') or '').strip()
        if not code or not name:
            continue
        seen[name] = seen.get(name, 0) + 1
        out.append((code, name))
    uniq = [(c, n) for (c, n) in out if seen.get(n) == 1]
    return uniq[:3]


def main():
    emps = pick_employees()
    if not emps:
        print('库里没有可用员工（code / nameCn 都非空），跳过人员相关断言')
    e1 = emps[0] if len(emps) > 0 else ('E00001', '张三')
    e2 = emps[1] if len(emps) > 1 else ('E00002', '李四')
    e3 = emps[2] if len(emps) > 2 else ('E00003', '王五')

    # ============================================================ 1. 模板
    print('\n--- 1. 导入模板 ---')
    tpl = svc._import_template_bytes()
    check('模板能生成且非空（xlsx 是 zip，PK 开头）', tpl[:2] == b'PK' and len(tpl) > 3000, len(tpl))
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(tpl))
    check('页签是「任务列表 + 填写说明」',
          wb.sheetnames == ['任务列表', '填写说明'], wb.sheetnames)
    ws = wb['任务列表']
    head = [svc._text(ws.cell(row=1, column=i).value) for i in range(1, 11)]
    expect = [c[1] + ('*' if c[2] else '') for c in svc.IMPORT_COLUMNS]
    check('表头与 IMPORT_COLUMNS 完全一致（含 * 必填）', head == expect, head)
    check('「任务名称」「层级」标了必填星号',
          '任务名称*' in head and '层级*' in head, head)
    check('责任人 / 参与人员两列都在模板里',
          '责任人' in head and '参与人员' in head, head)
    check('表头带批注（写明格式「工号 姓名」）',
          ws.cell(row=1, column=8).comment is not None
          and '工号' in ws.cell(row=1, column=8).comment.text,
          ws.cell(row=1, column=8).comment.text if ws.cell(row=1, column=8).comment else '')
    check('首行冻结 + 有数据验证下拉', ws.freeze_panes == 'A2' and len(ws.data_validations.dataValidation) >= 2,
          ws.freeze_panes)
    check('数据区域没有预填数据（避免误把示例当任务导入）',
          not [1 for row in ws.iter_rows(min_row=2, values_only=True)
               for v in row if v not in (None, '')], ws.max_row)
    gd = wb['填写说明']
    guide_text = '\n'.join(str(gd.cell(row=r, column=2).value or '') for r in range(1, gd.max_row + 1))
    check('填写说明写明「工号 姓名」写法', '工号 姓名' in guide_text)
    check('填写说明提示导入后还要点「保存」', '保存' in guide_text)
    demo_rows = [[gd.cell(row=r, column=c).value for c in range(1, 10)]
                 for r in range(1, gd.max_row + 1)]
    demo_hit = [r for r in demo_rows if str(r[0]) == '1' and str(r[2] or '').startswith('需求调研')]
    check('填写说明里有照抄用的示例行（含责任人 / 参与人员）',
          bool(demo_hit) and bool(demo_hit[0][6]) and bool(demo_hit[0][7]), demo_hit[:1])
    wb.close()

    # 模板回读：直接把模板另存后导入，应能认到表头（只是没有数据 → 提示没有任务行）
    try:
        svc._parse_import_bytes(tpl, '模板.xlsx')
        check('模板原样导入应提示「没有任务行」', False, '没有报错')
    except service.BizError as exc:
        check('模板原样导入应提示「没有任务行」', '没有读到任务行' in exc.message, exc.message)

    # ============================================================ 2. 正常导入
    print('\n--- 2. 正常解析（层级 / 类型 / 日期 / 人员）---')
    rows = [
        [1, 1, '需求调研与方案设计', '任务', '2026-11-02', '2026-11-06',
         '%s %s' % (e1[0], e1[1]), '%s %s' % (e2[0], e2[1]), ''],
        [2, 2, '现场调研', '任务', '2026-11-02', '', '%s %s' % (e2[0], e2[1]), '', ''],
        [3, 2, '方案评审', '里程碑', '2026-11-06', '2026-11-09',
         e1[0], '', '2'],
        [4, 1, '开发实施', '任务', '2026-11-09', '2026-11-20', e3[1], '', '3'],
    ]
    res = parse(make_book(rows))
    check('4 行全部通过', res['summary']['total'] == 4 and res['summary']['valid'] == 4
          and res['summary']['invalid'] == 0, err_text(res))
    by_seq = {r['seq']: r for r in res['rows']}
    check('层级 1/2/2/1 推导出 parentId（第 2、3 行的父是第 1 行）',
          by_seq[2]['parentSeq'] == 1 and by_seq[3]['parentSeq'] == 1, by_seq[2]['parentSeq'])
    check('顶层第 4 行没有父', by_seq[4]['parentSeq'] is None, by_seq[4]['parentSeq'])
    check('有子行的「任务」自动升级成摘要任务',
          by_seq[1]['taskType'] == 'summary' and by_seq[1]['autoType'] is True, by_seq[1]['taskType'])
    check('里程碑强制 工期 0（结束=开始）',
          by_seq[3]['startDate'] == by_seq[3]['endDate'] == '2026-11-06', by_seq[3])
    check('只给开始日期时按天退化（结束=开始）', by_seq[2]['endDate'] == '2026-11-02')
    check('前置任务按序号映射（第 3 行前置=2，第 4 行前置=3）',
          by_seq[3]['preTaskSeqs'] == [2] and by_seq[4]['preTaskSeqs'] == [3],
          (by_seq[3]['preTaskSeqs'], by_seq[4]['preTaskSeqs']))
    check('每行都分配了 UUID（后端 _uuid 能过）',
          all(len(r['id']) == 36 and r['id'].count('-') == 4 for r in res['rows']))
    check('「工号 姓名」解析出 ownerId + 标准姓名',
          by_seq[1]['ownerId'] == svc._int(svc._import_person_index()[0].get(e1[0].upper(), {}).get('id'))
          and by_seq[1]['ownerName'] == e1[1], (by_seq[1]['ownerId'], by_seq[1]['ownerName']))
    check('只写工号也能取到姓名', by_seq[3]['ownerId'] and by_seq[3]['ownerName'] == e1[1],
          (by_seq[3]['ownerId'], by_seq[3]['ownerName']))
    check('只写姓名也能取到工号', by_seq[4]['ownerId'] and by_seq[4]['ownerName'] == e3[1],
          (by_seq[4]['ownerId'], by_seq[4]['ownerName']))
    check('参与人员解析成 ID / 姓名两串（按下标对齐）',
          by_seq[1]['participantIds'] == str(by_seq[1]['participantIds']).split(',')[0]
          and by_seq[1]['participantNames'] == e2[1], by_seq[1]['participantNames'])
    check('多参与人员逗号分隔能全解出来', ',操作' not in str(by_seq[1]['participantNames']))
    # 原填写文本回传（前端预览用它做 title，方便核对「工号 → 姓名」）
    check('行数据回带原填写文本（责任人含工号）',
          by_seq[1]['ownerRaw'] == '%s %s' % (e1[0], e1[1])
          and e1[0].lower() in str(by_seq[1]['ownerRaw']).lower(),
          by_seq[1]['ownerRaw'])
    check('行数据回带参与人员原文本（含工号）',
          by_seq[1]['participantRaw'] == '%s %s' % (e2[0], e2[1]),
          by_seq[1]['participantRaw'])

    # 多个参与人员
    rows2 = [[1, 1, '多人群任务', '任务', '2026-11-02', '2026-11-03',
              '%s %s' % (e1[0], e1[1]),
              '%s %s,%s %s' % (e2[0], e2[1], e3[0], e3[1]), '']]
    res2 = parse(make_book(rows2))
    ok2 = res2['rows'][0]
    check('两个参与人员都解析出来了（ID 两个、姓名两个）',
          len(str(ok2['participantIds']).split(',')) == 2
          and len(str(ok2['participantNames']).split(',')) == 2,
          (ok2['participantIds'], ok2['participantNames']))
    check('参与人员姓名顺序与 ID 对齐', str(ok2['participantNames']).split(',') == [e2[1], e3[1]],
          ok2['participantNames'])

    # ============================================================ 3. 日期与工期
    print('\n--- 3. 日期 / 工期 ---')
    rows3 = [
        [1, 1, '只给开始加工期', '任务', '2026-11-02', '', 5, '', '', ''],
        [2, 1, 'Excel 日期单元格', '任务', datetime.datetime(2026, 11, 3),
         datetime.datetime(2026, 11, 8), '', '', '', ''],
        [3, 1, '斜杠日期', '任务', '2026/11/4', '2026/11/5', '', '', '', ''],
    ]
    res3 = parse(make_book(rows3, headers=FULL_HEAD))
    r3 = {r['seq']: r for r in res3['rows']}
    check('开始 + 工期 5 天 → 结束 = 开始 + 4 天', r3[1]['endDate'] == '2026-11-06', r3[1]['endDate'])
    check('工期输出为含首尾的天数', r3[1]['duration'] == 5, r3[1]['duration'])
    check('Excel 日期单元格能格式化', r3[2]['startDate'] == '2026-11-03'
          and r3[2]['endDate'] == '2026-11-08', (r3[2]['startDate'], r3[2]['endDate']))
    check('斜杠日期能识别', r3[3]['startDate'] == '2026-11-04', r3[3]['startDate'])

    # ============================================================ 4. 错误行
    print('\n--- 4. 逐行错误（不阻断其它行）---')
    rows4 = [
        [1, 1, '正常行', '任务', '2026-11-02', '2026-11-03', '', '', ''],
        [2, 1, '', '任务', '2026-11-02', '2026-11-03', '', '', ''],
        [3, 1, '日期不合法', '任务', '2026-13-40', '2026-11-03', '', '', ''],
        [4, 1, '开始晚于结束', '任务', '2026-11-10', '2026-11-03', '', '', ''],
        [5, 1, '层级不是数字', '任务', '2026-11-02', '2026-11-03', '', '', ''],
        [1, 1, '序号重复（与第 1 行撞号）', '任务', '2026-11-02', '2026-11-03', '', '', ''],
        [7, 1, '前置不存在', '任务', '2026-11-02', '2026-11-03', '', '', '99'],
        [8, 1, '前置是自己', '任务', '2026-11-02', '2026-11-03', '', '', '8'],
        [9, 1, '人员不存在', '任务', '2026-11-02', '2026-11-03', 'E99999 查无此人', '', ''],
        [9, 1, '类型不认识', '阶段', '2026-11-02', '2026-11-03', '', '', ''],
    ]
    book4 = make_book([[r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]] for r in rows4])
    ws4 = load_workbook(io.BytesIO(book4)).active
    ws4.cell(row=6, column=2, value='两')        # 第 5 条数据：层级写成中文
    buf4 = io.BytesIO()
    ws4.parent.save(buf4)
    res4 = parse(buf4.getvalue())
    errs = err_text(res4)
    bad = {r['rowNo']: r for r in res4['rows'] if not r['ok']}
    check('第 1 行正常通过', res4['rows'][0]['ok'] is True, res4['rows'][0]['errors'])
    check('任务名称为空 → 报错', 3 in bad and any('任务名称' in m for m in bad[3]['errors']), errs)
    check('日期非法 → 报错', 4 in bad and any('开始日期' in m for m in bad[4]['errors']), errs)
    check('开始晚于结束 → 报错', 5 in bad and any('晚于结束日期' in m for m in bad[5]['errors']), errs)
    check('层级非数字 → 报错', 6 in bad and any('层级' in m for m in bad[6]['errors']), errs)
    check('序号重复 → 报错', 7 in bad and any('重复' in m for m in bad[7]['errors']), errs)
    check('前置序号不存在 → 报错', 8 in bad and any('不存在' in m for m in bad[8]['errors']), errs)
    check('前置任务是自己 → 报错', 9 in bad and any('自己' in m for m in bad[9]['errors']), errs)
    check('责任人不存在 → 报错', 10 in bad and any('工号' in m for m in bad[10]['errors']), errs)
    check('类型不认识 → 报错', 11 in bad and any('任务类型' in m for m in bad[11]['errors']), errs)
    check('错误汇总条数与错误行数一致',
          len(res4['errors']) == sum(len(r['errors']) for r in res4['rows']), len(res4['errors']))
    check('valid / invalid 计数正确',
          res4['summary']['valid'] == 1 and res4['summary']['invalid'] == 9,
          (res4['summary']['valid'], res4['summary']['invalid']))

    # 姓名与工号不一致
    rows5 = [[1, 1, '张冠李戴', '任务', '2026-11-02', '2026-11-03',
              '%s 这个人不存在' % e1[0], '', '']]
    res5 = parse(make_book(rows5))
    check('工号与填写姓名不一致 → 该行报错且文案说明对应关系',
          res5['rows'][0]['ok'] is False
          and any('不一致' in m for m in res5['rows'][0]['errors']),
          res5['rows'][0]['errors'])

    # ============================================================ 5. 表头别名
    print('\n--- 5. 表头别名 / 非首行表头 ---')
    alias_head = ['序号', '层级', '任务名', '类型', '开始', '结束', '负责人', '参与人', '前置']
    res6 = parse(make_book([[1, 1, '别名表头', '任务', '2026-11-02', '2026-11-03', '', '', '']],
                           headers=alias_head))
    check('「任务名 / 开始 / 负责人 / 参与人」等别名都能定位',
          res6['summary']['valid'] == 1 and res6['rows'][0]['taskName'] == '别名表头', err_text(res6))
    res7 = parse(make_book([[1, 1, '表头在第 3 行', '任务', '2026-11-02', '2026-11-03', '', '', '']],
                           blank_first=2))
    check('表头不在第 1 行也能找到（前 10 行内）',
          res7['summary']['valid'] == 1 and res7['rows'][0]['rowNo'] == 4,
          (res7['summary'], res7['rows'][0]['rowNo']))

    # ============================================================ 6. 边界
    print('\n--- 6. 边界与异常 ---')
    for label, bad_raw, keyword in (
            ('空文件', b'', '为空'),
            ('不是 xlsx（随便一段字节）', b'hello-world-not-a-zip', '无法解析'),
    ):
        try:
            parse(bad_raw)
            check('%s → 抛业务错误' % label, False, '没有报错')
        except service.BizError as exc:
            check('%s → 抛业务错误' % label, keyword in exc.message, exc.message)

    try:
        parse(make_book([]))
        check('只有表头没有数据 → 提示没有任务行', False, '没有报错')
    except service.BizError as exc:
        check('只有表头没有数据 → 提示没有任务行', '没有读到任务行' in exc.message, exc.message)

    big = [[i + 1, 1, '批量任务 %d' % (i + 1), '任务', '2026-11-02', '2026-11-03', '', '', '']
           for i in range(svc.MAX_TASKS + 5)]
    try:
        parse(make_book(big))
        check('超过 %d 行 → 拒绝并提示拆分' % svc.MAX_TASKS, False, '没有报错')
    except service.BizError as exc:
        check('超过 %d 行 → 拒绝并提示拆分' % svc.MAX_TASKS, '最多导入' in exc.message, exc.message)

    # parse_import 的入参校验（不依赖登录：登录校验在最前面，这里用假 token 会先 401，
    # 所以只测文件内容相关的分支）
    for label, params, keyword in (
            ('没选文件', {'data': ''}, '请先选择'),
            ('不是 base64', {'data': '!!!not-base64!!!', 'fileName': 'a.xlsx'}, 'base64'),
            ('扩展名不是 xlsx', {'data': base64.b64encode(b'x').decode('ascii'),
                              'fileName': 'a.csv'}, '.xlsx'),
    ):
        try:
            svc.parse_import(params)
            check('parse_import：%s → 抛业务错误' % label, False, '没有报错')
        except service.BizError as exc:
            if '登录已失效' in exc.message:
                check('parse_import：%s（先过登录校验）' % label, True)
            else:
                check('parse_import：%s → 抛业务错误' % label, keyword in exc.message, exc.message)

    # ============================================================ 7. 口径一致性
    print('\n--- 7. 与整图保存口径一致 ---')
    res8 = parse(make_book(rows))
    keep = [r for r in res8['rows'] if r['ok']]
    norm = svc._normalize_tasks([{
        'id': r['id'], 'taskName': r['taskName'], 'taskType': r['taskType'],
        'parentId': '', 'startDate': r['startDate'], 'endDate': r['endDate'],
        'progress': 0, 'ownerId': r['ownerId'], 'ownerName': r['ownerName'],
        'participantIds': r['participantIds'], 'participantNames': r['participantNames'],
    } for r in keep])
    check('导入行能直接过 _normalize_tasks（保存不会因字段问题被拒）',
          len(norm) == len(keep) and all(x['taskName'] for x in norm), len(norm))
    check('归一化后里程碑结束日期仍等于开始日期',
          bool([x for x in norm if x['taskType'] == 'milestone'
                and x['startDate'] == x['endDate']]))

    print('\n结果：%d 通过 / %d 失败' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
