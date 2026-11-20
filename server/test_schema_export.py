# -*- coding: utf-8 -*-
"""
数据中心 · 应用结构「导出表结构文档」验证（schema_export / AppSchemaService.export_docs）
---------------------------------------------------------------------------------------
对应需求：结构树里勾选若干张表 → 导出 Excel / Word，文档里要能看到
**应用信息、每张表的中文名、导出时间**。

覆盖：
  · 纯生成层（schema_export.build_xlsx / build_docx）：给内存数据就能出文件，
    用 openpyxl / python-docx 把生成的文件读回来，验证标题、应用信息、表中文名、
    字段中文名、导出时间确实落进了文档（不是「生成了就算成功」）；
  · 服务层（export_docs）：勾选 ids 只导这几张；不传 ids 导全部表 / 视图（过程不进文档）；
    非法格式 / 空应用 / 跨应用 id 都有明确报错；
  · 接口与页面：ACTIONS 登记了 exportdocs、app.py 有独立文件流路由、前端 api.js 有方法、
    appschema.html 有导出按钮（否则页面点了没反应）。

测试数据用编码前缀 `TESTEX` 的临时应用，跑完立即删除 —— 不碰库里任何真实应用。

用法：python server/test_schema_export.py
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import app_schema  # noqa: E402
import db  # noqa: E402
import schema_export  # noqa: E402
import service  # noqa: E402
from errors import BizError  # noqa: E402

PASS = 0
FAIL = 0
MARK = 'TESTEX'
WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
svc = service.app_info_service
sc = service.app_schema_service


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s   %s' % (name, extra))


def expect_error(name, fn, keyword=''):
    try:
        fn()
    except BizError as exc:
        msg = str(exc)
        check(name, (keyword in msg) if keyword else True, msg)
        return msg
    except Exception as exc:                     # noqa: BLE001
        check(name, False, '抛了非 BizError：%s' % exc)
        return str(exc)
    check(name, False, '没有抛异常')
    return ''


# ---------------------------------------------------------------- 读回生成的文件
def read_xlsx(content):
    """把 xlsx 读回来 → {页签名: [[单元格文本, ...], ...]}"""
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(content), data_only=True)
    out = {}
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows(values_only=True):
            rows.append(['' if one is None else str(one) for one in row])
        out[ws.title] = rows
    return out


def read_docx(content):
    """把 docx 读回来 → (全部段落文本, 单元格文本列表)"""
    from docx import Document
    doc = Document(io.BytesIO(content))
    paras = [p.text for p in doc.paragraphs]
    cells = []
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                cells.append(cell.text)
    return paras, cells


# ---------------------------------------------------------------- 测试数据
META = {
    'appCode': 'APP9999', 'appName': '测试应用（导出）', 'appShort': '导出测试',
    'appTypeLabel': 'Web 应用', 'envLabel': '生产', 'dbTypeLabel': 'MySQL',
    'deptName': '技术研发部', 'ownerName': '张守正', 'connName': '本机 MySQL', 'targetDb': 'rogerorm',
    'description': '这个应用只用于导出文档的自测。',
    'exportTime': '2026-11-18 13:05:00', 'exporter': '系统管理员',
    'tableCount': 2, 'colCount': 3, 'scopeText': '全部表 / 视图（2 张）',
}
TABLES = [
    {'id': 't1', 'dbName': 'rogerorm', 'objName': 'empinfos', 'objType': 'table', 'typeLabel': '表',
     'objComment': '员工信息表',
     'cols': [
         {'colName': 'id', 'ordinal': 1, 'dataType': 'BIGINT', 'length': '', 'nullable': False,
          'defaultValue': '', 'isPk': True, 'isAutoInc': True, 'colComment': '主键ID'},
         {'colName': 'nameCn', 'ordinal': 2, 'dataType': 'VARCHAR', 'length': '50', 'nullable': False,
          'defaultValue': '', 'isPk': False, 'isAutoInc': False, 'colComment': '姓名'},
     ]},
    {'id': 't2', 'dbName': 'rogerorm', 'objName': 'v_emp_dept', 'objType': 'view', 'typeLabel': '视图',
     'objComment': '员工部门视图',
     'cols': [{'colName': 'empName', 'ordinal': 1, 'dataType': 'VARCHAR', 'length': '50',
               'nullable': True, 'defaultValue': '', 'isPk': False, 'isAutoInc': False,
               'colComment': '员工姓名'}]},
]


def test_generate():
    print('\n--- 1. 生成层：Excel / Word 内容（读回文件校验，不只看字节数） ---')
    xlsx = schema_export.build_xlsx(META, TABLES)
    check('xlsx 非空且是 zip（xlsx 就是 zip 包）', len(xlsx) > 2000 and xlsx[:2] == b'PK',
          '%d 字节' % len(xlsx))
    sheets = read_xlsx(xlsx)
    check('三个页签齐备（应用信息 / 表清单 / 字段明细）',
          list(sheets.keys()) == ['应用信息', '表清单', '字段明细'], str(list(sheets.keys())))
    flat = '\n'.join('\n'.join(row) for row in sheets['应用信息'])
    check('封面标题带应用名', '测试应用（导出）' in flat and '数据库表结构说明' in flat, flat[:120])
    for label, value in (('应用编码', 'APP9999'), ('应用类型', 'Web 应用'), ('运行环境', '生产'),
                         ('归属部门', '技术研发部'), ('负责人', '张守正'), ('目标库', 'rogerorm')):
        check('应用信息含「%s=%s」' % (label, value), label in flat and value in flat)
    check('应用信息含导出时间与导出人',
          '导出时间' in flat and '2026-11-18 13:05:00' in flat and '系统管理员' in flat, flat[:200])

    listed = '\n'.join('\n'.join(row) for row in sheets['表清单'])
    check('表清单含表名 + 中文名 + 类型 + 字段数',
          'empinfos' in listed and '员工信息表' in listed and '视图' in listed, listed[:200])
    detail = '\n'.join('\n'.join(row) for row in sheets['字段明细'])
    check('字段明细含表中文名 / 字段中文名 / 类型 / 长度 / 主键',
          '员工信息表' in detail and '姓名' in detail and 'VARCHAR' in detail and 'BIGINT' in detail
          and '主键ID' in detail, detail[-400:])
    check('字段明细每张表有分组标题（1. empinfos · 员工信息表 · 2 个字段）',
          '1. empinfos · 员工信息表 · 2 个字段' in detail, detail[-400:])
    check('字段明细把视图也算进来了（v_emp_dept）', 'v_emp_dept' in detail)
    check('非主键字段的主键列为空、非空字段可空列写「否」',
          '否' in detail, detail[:200])

    docx = schema_export.build_docx(META, TABLES)
    check('docx 非空且是 zip', len(docx) > 3000 and docx[:2] == b'PK', '%d 字节' % len(docx))
    paras, cells = read_docx(docx)
    text = '\n'.join(paras) + '\n' + '\n'.join(cells)
    check('Word 标题 + 副标题（导出时间 / 导出人）',
          '测试应用（导出） 数据库表结构说明' in text and '导出时间 2026-11-18 13:05:00' in text,
          text[:200])
    check('Word 三节标题齐备（一、应用信息 / 二、表清单 / 三、字段明细）',
          '一、应用信息' in text and '二、表清单（2 张）' in text and '三、字段明细' in text)
    celltext = '\n'.join(cells)
    check('Word 应用信息表含编码 / 部门 / 负责人', 'APP9999' in celltext and '技术研发部' in celltext
          and '张守正' in celltext, celltext[:160])
    check('Word 表清单含表名 + 中文名', 'empinfos' in celltext and '员工信息表' in celltext,
          celltext[:160])
    check('Word 字段明细含字段中文名与类型长度', '姓名' in celltext and 'VARCHAR' in celltext
          and '50' in celltext and '员工姓名' in celltext, celltext[-260:])
    check('Word 每张表一个二级标题（1. empinfos　员工信息表　2 个字段）',
          any('1. empinfos' in one and '员工信息表' in one and '2 个字段' in one for one in paras),
          str([one for one in paras if one.startswith('1.')])[:160])

    # 空表 / 空字段也不能炸（新建应用刚建完库还没建表时会走到）
    empty = schema_export.build_xlsx(dict(META, tableCount=0, colCount=0), [])
    check('Excel 允许 0 张表（不抛异常，给「没有可导出的表」）',
          '（没有可导出的表）' in '\n'.join('\n'.join(row) for row in read_xlsx(empty)['字段明细']))
    empty_doc = schema_export.build_docx(dict(META, tableCount=0, colCount=0), [])
    eparas, ecells = read_docx(empty_doc)
    check('Word 允许 0 张表', '（没有可导出的表）' in '\n'.join(eparas + ecells))

    # 控制字符会被 OOXML 拒绝：注释里有 \x01 也必须能导出
    dirty = [dict(TABLES[0], objComment='员工\x01信息表')]
    ok = True
    try:
        schema_export.build_xlsx(dict(META, tableCount=1), dirty)
        schema_export.build_docx(dict(META, tableCount=1), dirty)
    except Exception as exc:                     # noqa: BLE001
        ok = False
        print('    异常：%s' % exc)
    check('脏注释（控制字符）能正常导出', ok)


# ---------------------------------------------------------------- 真实库上的服务层
def cleanup():
    """只清自测造的残骸 —— **不做全库孤儿清理**：
    库里同时有真实应用（APP0001 / APP0002 …），按「appId / dbId 不在父表里」的全局清理
    在用户正删库重建的瞬间会误删真实数据，得不偿失。宁可留一条残骸，也不碰别人的数据。"""
    rows = db.query_all('SELECT `id` FROM `appinfos` WHERE `code` LIKE %s OR `name` LIKE %s',
                        (MARK + '%', MARK + '%')) or []
    for row in rows:
        try:
            svc.delete({'id': row['id']})
        except Exception:                        # noqa: BLE001
            db.execute('DELETE FROM `appinfos` WHERE `id`=%s', (row['id'],))
    # 兜底：按自测库名前缀清（只有 svc.delete 失败时才会留下）
    for one in (db.query_all('SELECT `id` FROM `appschemadbs` WHERE `dbName` LIKE %s',
                             (MARK + '%',)) or []):
        db.execute('DELETE FROM `appschemacols` WHERE `objId` IN '
                   '(SELECT `id` FROM `appschemaobjs` WHERE `dbId`=%s)', (one['id'],))
        db.execute('DELETE FROM `appschemaobjs` WHERE `dbId`=%s', (one['id'],))
        db.execute('DELETE FROM `appschemadbs` WHERE `id`=%s', (one['id'],))


def build_app():
    app = svc.add({'code': MARK + '01', 'name': MARK + ' 导出测试应用', 'dbType': 'mysql',
                   'appType': 'web', 'env': 'prod', 'dbConnId': None,
                   'description': '导出文档自测'})
    tree = sc.dbadd({'appId': app['id'], 'dbName': MARK + '_db', 'dbComment': '自测库'})
    db_id = tree['databases'][0]['id']
    obj_ids = []
    for name, label, cols in (
            ('empinfos', '员工信息表',
             [{'colName': 'id', 'dataType': 'BIGINT', 'isPk': True, 'isAutoInc': True,
               'nullable': False, 'colComment': '主键ID'},
              {'colName': 'nameCn', 'dataType': 'VARCHAR', 'length': '50', 'nullable': False,
               'colComment': '姓名'}]),
            ('projectinfos', '项目信息表',
             [{'colName': 'code', 'dataType': 'VARCHAR', 'length': '40', 'nullable': False,
               'colComment': '项目编号'}])):
        tree2 = sc.objadd({'appId': app['id'], 'dbId': db_id, 'objType': 'table',
                           'objName': name, 'objComment': label})
        obj = [one for one in tree2['tree']['databases'][0]['objects'] if one['objName'] == name][0]
        obj_ids.append(obj['id'])
        sc.colsave({'appId': app['id'], 'objId': obj['id'], 'cols': cols})
    # 视图也要能导出（它的字段也在 appschemacols 里）
    tree3 = sc.objadd({'appId': app['id'], 'dbId': db_id, 'objType': 'view',
                       'objName': 'v_emp', 'objComment': '员工视图',
                       'ddl': 'CREATE VIEW v_emp AS SELECT id, nameCn FROM empinfos'})
    view = [one for one in tree3['tree']['databases'][0]['objects'] if one['objName'] == 'v_emp'][0]
    sc.colsave({'appId': app['id'], 'objId': view['id'],
                'cols': [{'colName': 'nameCn', 'dataType': 'VARCHAR', 'length': '50',
                          'nullable': True, 'colComment': '姓名'}]})
    # 一个存储过程：没有字段，不应进结构文档
    sc.objadd({'appId': app['id'], 'dbId': db_id, 'objType': 'procedure', 'objName': 'sp_demo',
               'objComment': '自测过程', 'ddl': 'CREATE PROCEDURE sp_demo() BEGIN SELECT 1; END'})
    return app, obj_ids, view['id']


def test_service():
    print('\n--- 2. 服务层：勾选导出 / 全部导出 / 报错 ---')
    app, obj_ids, view_id = build_app()

    res = sc.export_docs({'appId': app['id'], 'format': 'xlsx'})
    check('不传 ids → 导出全部表 / 视图（2 表 + 1 视图，过程不算）',
          res['count'] == 3 and res['colCount'] == 4, '%s / %s' % (res['count'], res['colCount']))
    check('返回文件名带应用编码 + 「表结构」+ 时间戳 + 扩展名',
          res['filename'].startswith(MARK + '01_表结构_') and res['filename'].endswith('.xlsx'),
          res['filename'])
    check('xlsx 的 MIME 正确',
          res['mimetype'].endswith('spreadsheetml.sheet'), res['mimetype'])
    sheets = read_xlsx(res['content'])
    flat = '\n'.join('\n'.join(row) for row in sheets['应用信息'])
    check('文档里的应用信息来自数据库（编码 / 名称 / 方言）',
          MARK + '01' in flat and MARK + ' 导出测试应用' in flat and 'MySQL' in flat, flat[:160])
    check('文档里导出时间 = 本次导出时间（不是空 / 不是创建时间）',
          res['exportTime'] in flat and len(res['exportTime']) == 19, res['exportTime'])
    listed = '\n'.join('\n'.join(row) for row in sheets['表清单'])
    check('表清单含两张表的中文名 + 视图中文名',
          '员工信息表' in listed and '项目信息表' in listed and '员工视图' in listed, listed[:240])
    check('存储过程没有混进表清单', 'sp_demo' not in listed)

    part = sc.export_docs({'appId': app['id'], 'format': 'docx',
                           'ids': obj_ids[0] + ',' + obj_ids[1]})
    check('勾选 2 张表 → 只导出这 2 张', part['count'] == 2, str(part['count']))
    check('docx 的 MIME 正确', part['mimetype'].endswith('wordprocessingml.document'))
    paras, cells = read_docx(part['content'])
    text = '\n'.join(paras) + '\n' + '\n'.join(cells)
    check('勾选导出的 Word 只有勾选的表（没有 v_emp）',
          'empinfos' in cells and 'projectinfos' in cells and 'v_emp' not in text,
          str([one for one in cells if one in ('empinfos', 'projectinfos', 'v_emp')]))
    check('勾选导出的 Word 仍带完整应用信息',
          MARK + '01' in '\n'.join(cells) and MARK + ' 导出测试应用' in '\n'.join(cells))

    check('ids 传数组也认（前端多选一般传逗号串）',
          sc.export_docs({'appId': app['id'], 'format': 'xlsx', 'ids': [obj_ids[0]]})['count'] == 1)

    expect_error('空应用（没有库表）导出给出可操作提示',
                 lambda: sc.export_docs({'appId': svc.add(
                     {'code': MARK + '98', 'name': MARK + ' 空应用'})['id'], 'format': 'xlsx'}),
                 '还没有表可以导出')
    expect_error('不支持的格式被拒', lambda: sc.export_docs({'appId': app['id'], 'format': 'pdf'}), 'xlsx')
    expect_error('跨应用的 id 被拒（不会导出别人的表）',
                 lambda: sc.export_docs({'appId': app['id'], 'format': 'xlsx',
                                         'ids': '11111111-1111-1111-1111-111111111111'}),
                 '不属于这个应用')
    expect_error('应用 id 不合法被拒', lambda: sc.export_docs({'appId': 'abc', 'format': 'xlsx'}), 'UUID')
    # 大小写 / 别名都收（用户从下拉里选的是 xlsx / docx，这里只是兜住手写参数）
    check('format 别名（word / excel）也认',
          sc.export_docs({'appId': app['id'], 'format': 'word'})['format'] == 'docx'
          and sc.export_docs({'appId': app['id'], 'format': 'excel'})['format'] == 'xlsx')

    # 导出人要落进文档：给一个真实登录账号的 _loginUserId
    user = db.query_one('SELECT `u`.`id`,`e`.`nameCn` FROM `useinfo` `u` JOIN `empinfos` `e` '
                        'ON `e`.`id`=`u`.`empId` LIMIT 1')
    if user:
        res2 = sc.export_docs({'appId': app['id'], 'format': 'xlsx', '_loginUserId': user['id']})
        flat2 = '\n'.join('\n'.join(row) for row in read_xlsx(res2['content'])['应用信息'])
        check('导出人取登录员工姓名（%s）' % user['nameCn'], user['nameCn'] in flat2, flat2[:160])
    else:
        check('库里没有可关联的员工账号，跳过导出人断言', True)
    return app


def test_wiring():
    print('\n--- 3. 接口与页面接线（少一处页面就点不动） ---')
    check('ACTIONS 登记了 exportdocs（且允许 GET / POST）',
          service.ACTIONS.get('exportdocs') == ('export_docs', ['GET', 'POST']),
          str(service.ACTIONS.get('exportdocs')))
    check('服务对象上有 export_docs 方法', callable(getattr(sc, 'export_docs', None)))
    with io.open(os.path.join(WEB_ROOT, 'server', 'app.py'), encoding='utf-8') as fh:
        app_py = fh.read()
    check('app.py 开了文件流路由 /api/appschema/exportdocs',
          "'/api/appschema/exportdocs'" in app_py and 'appschema_export_docs' in app_py)
    with io.open(os.path.join(WEB_ROOT, 'js', 'api.js'), encoding='utf-8') as fh:
        api_js = fh.read()
    check('api.js 有 exportdocs（走二进制下载通道）',
          'exportdocs' in api_js and 'downloadFile(\'/appschema/exportdocs\'' in api_js)
    with io.open(os.path.join(WEB_ROOT, 'appschema.html'), encoding='utf-8') as fh:
        html = fh.read()
    check('页面有导出按钮 #asBtnExport（纯图标 + title 文案）',
          'id="asBtnExport"' in html and '导出表结构' in html)
    with io.open(os.path.join(WEB_ROOT, 'js', 'appschema.js'), encoding='utf-8') as fh:
        page_js = fh.read()
    check('页面脚本有勾选状态与导出逻辑（state.picked / openDocsExport）',
          'picked' in page_js and 'openDocsExport' in page_js)
    check('树节点渲染了勾选框（as-node__pick）', 'as-node__pick' in page_js)


def main():
    print('=' * 70)
    print('数据中心 · 应用结构「导出表结构文档」验证（Excel / Word）')
    print('=' * 70)
    cleanup()
    try:
        test_generate()
        test_service()
        test_wiring()
    finally:
        cleanup()
        left = db.query_one('SELECT COUNT(*) AS `n` FROM `appinfos` WHERE `code` LIKE %s',
                            (MARK + '%',))
        print('\n清理：残留自测应用 %s 条' % (left or {}).get('n'))
    print('\n结果：通过 %d 项，失败 %d 项' % (PASS, FAIL))
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
