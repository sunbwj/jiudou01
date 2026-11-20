# -*- coding: utf-8 -*-
"""
数据中心 · 应用架构（AppInfoService / AppSchemaService / schema_ddl / schema_parse）验证
-------------------------------------------------------------------------------------
对应「数据中心 → 应用信息 / 应用结构」这条链路的后端部分：

  · 应用信息：编码 APP + 4 位流水号、一个数据库连接只能挂一个应用、编码查重、
    未绑连接的「纯手工应用」也必须可用（不扫描也能维护结构）；
  · 结构设计态：库 → 表 / 视图 / 存储过程 → 字段；视图与过程必须有定义；
    逻辑类型 + 长度校验；来源（scan / manual / import）与 locked 标记；
  · 版本：每次保存只出一条**草稿**（带整库快照）；发布才生成正式版号 +
    正向 / 回滚脚本，脚本状态 pending 且**永不自动执行**，必须人工回写状态；
    发布以「上一个正式版」为基准重算，旧正式版转 superseded；
  · 方言：同一份设计态在 mysql / postgresql / oracle / sqlserver / sqlite 下的
    建表 / 改列 / 注释差异（引号、自增、注释语法）；
  · DDL 导入：解析 CREATE / ALTER / COMMENT ON，落到设计态（不碰真实库）；
  · 实库对比：只有人工触发，未绑连接直接拒绝，结果落库留存；
  · 菜单与按钮：MNU00029 / MNU00030 挂在 MNG1005、已授权给系统管理员，
    pageopbtn 里收录的按钮与 page_scan 现扫出来的一致（改了按钮忘了重新收录会在这里红）。

测试数据用编码 / 名称前缀 `TESTSA` 的临时应用，跑完立即删除 —— 不碰库里任何真实应用。

用法：python server/test_app_schema.py
"""
import io
import inspect
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402
import connector  # noqa: E402
import db  # noqa: E402
import app_schema  # noqa: E402
import page_scan  # noqa: E402
import schema_ddl  # noqa: E402
import schema_parse  # noqa: E402
import service  # noqa: E402
from errors import BizError  # noqa: E402

PASS = 0
FAIL = 0
svc = service.app_info_service
sc = service.app_schema_service
MARK = 'TESTSA'
WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s   %s' % (name, extra))


def expect_error(name, fn, keyword=''):
    """断言抛出 BizError（可选断言错误文案包含关键字），返回异常文案"""
    try:
        fn()
    except BizError as exc:
        msg = str(exc)
        ok = (keyword in msg) if keyword else True
        check(name, ok, msg)
        return msg
    except Exception as exc:                     # noqa: BLE001
        check(name, False, '抛了非 BizError：%s' % exc)
        return str(exc)
    check(name, False, '没有抛异常')
    return ''


# ---------------------------------------------------------------- 数据清理
# 关掉外键顺序：库/对象/字段/版本/变更/脚本/对比 —— 只按「应用已不存在」反查孤儿
ORPHAN_SQL = (
    'DELETE FROM `appschemadbs` WHERE `appId` NOT IN (SELECT `id` FROM `appinfos`)',
    'DELETE FROM `appschemaobjs` WHERE `dbId` NOT IN (SELECT `id` FROM `appschemadbs`)',
    'DELETE FROM `appschemacols` WHERE `objId` NOT IN (SELECT `id` FROM `appschemaobjs`)',
    'DELETE FROM `appschemavers` WHERE `appId` NOT IN (SELECT `id` FROM `appinfos`)',
    'DELETE FROM `appschemachanges` WHERE `verId` NOT IN (SELECT `id` FROM `appschemavers`)',
    'DELETE FROM `appschemascripts` WHERE `verId` NOT IN (SELECT `id` FROM `appschemavers`)',
    'DELETE FROM `appschemacompares` WHERE `appId` NOT IN (SELECT `id` FROM `appinfos`)',
    'DELETE FROM `appschemacompareitems` WHERE `compareId` NOT IN '
    '(SELECT `id` FROM `appschemacompares`)',
)


def cleanup():
    rows = db.query_all('SELECT `id` FROM `appinfos` WHERE `code` LIKE %s OR `name` LIKE %s',
                        (MARK + '%', MARK + '%')) or []
    for row in rows:
        try:
            svc.delete({'id': row['id']})
        except Exception:                        # noqa: BLE001
            db.execute('DELETE FROM `appinfos` WHERE `id`=%s', (row['id'],))
    for sql in ORPHAN_SQL:                       # 兜底：万一有孤儿（应用删了结构没删）
        try:
            db.execute(sql, ())
        except Exception:                        # noqa: BLE001
            pass
    try:                                         # 自测用的临时数据库连接（name 带前缀）
        db.execute('DELETE FROM `dbinfomgr` WHERE `name` LIKE %s', (MARK + '%',))
    except Exception:                            # noqa: BLE001
        pass


def count(table, where='', args=()):
    sql = 'SELECT COUNT(*) AS `n` FROM `%s`' % table
    if where:
        sql += ' WHERE ' + where
    return int((db.query_one(sql, args) or {}).get('n') or 0)


# ---------------------------------------------------------------- 1. 应用信息
def test_appinfo():
    print('\n--- 1. 应用信息（appinfos：编码 / 连接 1:1 / 纯手工应用） ---')
    meta = svc.meta({})
    check('下拉元数据齐备（应用类型 / 环境 / 数据库类型 / 逻辑类型 / 对象类型）',
          len(meta['appTypes']) >= 4 and len(meta['envs']) >= 3 and len(meta['dbTypes']) >= 5
          and len(meta['logicalTypes']) == 16 and len(meta['objTypes']) == 6,
          str({k: len(v) for k, v in meta.items()}))

    code = svc.next_code({})['code']
    check('取号：APP + 4 位流水号', bool(code) and code.startswith('APP') and len(code) == 7, code)

    app = svc.add({'code': MARK + '01', 'name': MARK + ' 主应用', 'dbType': 'mysql',
                   'appType': 'web', 'env': 'dev', 'dbConnId': None,
                   'description': '接口自测应用'})
    check('新增纯手工应用（不绑连接）成功', app.get('code') == MARK + '01' and app.get('hasConn') is False,
          str(app)[:160])
    check('应用默认启用 + 公用（看不见归属人时按公用处理）',
          app.get('status') is True and app.get('ispub') is True)
    check('派生的中文标签齐备（应用类型 / 环境 / 方言）',
          app.get('appTypeLabel') == 'Web 应用' and app.get('envLabel') == '开发'
          and app.get('dbTypeLabel') == 'MySQL',
          '%s / %s / %s' % (app.get('appTypeLabel'), app.get('envLabel'), app.get('dbTypeLabel')))
    check('新应用结构计数为 0', app.get('dbCount') == 0 and app.get('objCount') == 0)

    expect_error('编码重复被拒且提示重新取号', lambda: svc.add(
        {'code': MARK + '01', 'name': MARK + ' 重复'}), '已存在')
    check('唯一性校验接口认出重复编码', svc.check({'field': 'code', 'value': MARK + '01'})['unique'] is False)
    check('唯一性校验接口放过新编码', svc.check({'field': 'code', 'value': MARK + '99'})['unique'] is True)
    expect_error('编码字符集受限（不许中文 / 空格）', lambda: svc.add(
        {'code': '测试 01', 'name': MARK + ' 脏编码'}), '应用编码只允许')
    expect_error('应用名称必填', lambda: svc.add({'code': MARK + '02'}), '应用名称不能为空')

    # 连接 1:1：自己造一条临时连接（库里现成的连接往往已被真实应用占用，
    # 「取第一个 enabled 连接」的写法在有真实数据的环境里会误判失败）
    conf = config.DB_CONFIG
    temp_conn = str(uuid.uuid4())
    made_conn = False
    try:
        db.execute('INSERT INTO `dbinfomgr` (`id`,`name`,`dbType`,`host`,`port`,`dbName`,`username`,'
                   '`password`,`enabled`,`ispub`) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,1,1)',
                   (temp_conn, MARK + '_conn1', 'mysql', conf['host'], conf['port'], None,
                    conf['user'], connector.encrypt_secret(conf['password'])))
        made_conn = True
    except Exception as exc:                     # noqa: BLE001
        print('  [WARN] 造临时连接失败：%s' % exc)
    conn = {'id': temp_conn, 'dbType': 'mysql'} if made_conn else \
        db.query_one('SELECT `d`.`id`,`d`.`dbType` FROM `dbinfomgr` `d` WHERE `d`.`enabled`=1 '
                     'AND NOT EXISTS (SELECT 1 FROM `appinfos` `a` WHERE `a`.`dbConnId`=`d`.`id`) '
                     'ORDER BY `d`.`id` LIMIT 1')
    if conn:
        app2 = svc.add({'code': MARK + '02', 'name': MARK + ' 绑定应用', 'dbType': conn['dbType'],
                        'dbConnId': conn['id']})
        check('绑定数据库连接成功（hasConn=true）', app2.get('hasConn') is True)
        opt = [one for one in svc.connections({})['list'] if str(one['id']) == str(conn['id'])]
        check('已被占用的连接不再出现在「可用连接」下拉里', not opt, str(opt)[:120])
        expect_error('一个连接只能挂一个应用（再绑同一连接被拒）',
                     lambda: svc.add({'code': MARK + '03', 'name': MARK + ' 抢连接',
                                      'dbType': conn['dbType'], 'dbConnId': conn['id']}),
                     '一个连接只能对应一个应用')
        svc.delete({'id': app2['id']})
    else:
        check('库里没有可用连接，跳过「一个连接只挂一个应用」的两条断言', True)
    if made_conn:                                # 临时连接用完就删，别留在下拉里
        db.execute('DELETE FROM `dbinfomgr` WHERE `id`=%s', (temp_conn,))

    upd = svc.update({'id': app['id'], 'name': MARK + ' 主应用改名', 'env': 'prod'})
    check('修改应用（名称 / 环境）生效', upd.get('name') == MARK + ' 主应用改名'
          and upd.get('env') == 'prod' and upd.get('envLabel') == '生产')

    off = svc.enabled({'id': app['id'], 'status': False})
    check('停用应用后 status=false', off.get('status') is False)
    svc.enabled({'id': app['id'], 'status': True})

    page = svc.page({'keyword': MARK, 'pageNum': 1, 'pageSize': 10})
    check('列表按关键字检索命中自测应用', page.get('total') == 1 and page['list'][0]['id'] == app['id'],
          str(page.get('total')))
    opts = svc.options({})['list']
    check('应用下拉（启用的）里能看到它', any(str(one['id']) == str(app['id']) for one in opts))

    # ---------- 多选筛选（应用类型 / 数据库类型：逗号串，与前端多选下拉同口径） ----------
    extra1 = svc.add({'code': MARK + '11', 'name': MARK + ' 多选一', 'appType': 'service',
                      'dbType': 'mysql', 'dbConnId': None})
    extra2 = svc.add({'code': MARK + '12', 'name': MARK + ' 多选二', 'appType': 'app',
                      'dbType': 'oracle', 'dbConnId': None})

    def total(**kw):
        kw.update({'keyword': MARK, 'pageNum': 1, 'pageSize': 20})
        return svc.page(kw).get('total')

    check('多选应用类型（web,service）命中 2 条', total(appType='web,service') == 2,
          total(appType='web,service'))
    check('单值应用类型照旧生效（service 命中 1 条）', total(appType='service') == 1,
          total(appType='service'))
    check('多选数据库类型（mysql,oracle）命中 3 条', total(dbType='mysql,oracle') == 3,
          total(dbType='mysql,oracle'))
    check('取值前后的空格被忽略', total(appType=' web , service ') == 2,
          total(appType=' web , service '))
    check('重复取值不放大结果', total(appType='web,web') == 1, total(appType='web,web'))
    check('不存在的取值返回空集', total(appType='nope') == 0, total(appType='nope'))
    check('应用类型与数据库类型可以叠加（service,app + oracle）',
          total(appType='service,app', dbType='oracle') == 1,
          total(appType='service,app', dbType='oracle'))

    p1 = svc.page({'keyword': MARK, 'pageNum': 1, 'pageSize': 2})
    p2 = svc.page({'keyword': MARK, 'pageNum': 2, 'pageSize': 2})
    check('分页：每页 2 条且共 2 页以上', len(p1['list']) == 2 and p1['pages'] >= 2,
          '%s / %s' % (len(p1['list']), p1['pages']))
    check('分页：第二页是非空且 id 不与第一页重复',
          len(p2['list']) >= 1 and
          not ({one['id'] for one in p1['list']} & {one['id'] for one in p2['list']}))
    svc.delete({'id': extra1['id']})
    svc.delete({'id': extra2['id']})
    return app


# ---------------------------------------------------------------- 2. 结构设计态
def test_structure(app):
    print('\n--- 2. 结构设计态（库 / 对象 / 字段 + 来源与锁定） ---')
    tree = sc.dbadd({'appId': app['id'], 'dbName': MARK + '_db', 'dbComment': '自测库'})
    dbs = tree.get('databases') or []
    check('手工新增库成功且树里出现', len(dbs) == 1 and dbs[0]['dbName'] == MARK + '_db',
          str(dbs)[:120])
    check('库来源记为 manual', dbs[0].get('source') == 'manual', str(dbs[0].get('source')))
    db_id = dbs[0]['id']

    expect_error('同一应用下库名不能重复',
                 lambda: sc.dbadd({'appId': app['id'], 'dbName': MARK + '_db'}), '已存在')
    expect_error('库名不能为空', lambda: sc.dbadd({'appId': app['id'], 'dbName': ' '}), '库名不能为空')

    res = sc.objadd({'dbId': db_id, 'objName': MARK + '_t', 'objType': 'table',
                     'objComment': '自测表'})
    obj_id = res['id']
    check('新增表成功', bool(obj_id))
    expect_error('视图必须填写定义（DDL 原文）', lambda: sc.objadd(
        {'dbId': db_id, 'objName': MARK + '_v', 'objType': 'view'}), '必须填写定义')
    expect_error('不认识的对象类型被拒绝', lambda: sc.objadd(
        {'dbId': db_id, 'objName': MARK + '_x', 'objType': 'unknown'}), '对象类型只能是')
    expect_error('索引不填定义也拒绝（非表对象必须有 DDL）', lambda: sc.objadd(
        {'dbId': db_id, 'objName': MARK + '.idx_x', 'objType': 'index'}), '必须填写定义')

    view = sc.objadd({'dbId': db_id, 'objName': MARK + '_v', 'objType': 'view',
                      'ddl': 'CREATE VIEW %s_v AS SELECT 1' % MARK})
    proc = sc.objadd({'dbId': db_id, 'objName': MARK + '_p', 'objType': 'procedure',
                      'ddl': 'CREATE PROCEDURE %s_p() BEGIN SELECT 1; END' % MARK})
    tree = sc.tree({'appId': app['id']})
    check('树里 1 库 3 对象（表 / 视图 / 过程）',
          len(tree['databases']) == 1 and len(tree['databases'][0]['objects']) == 3,
          str([o['objType'] for o in tree['databases'][0]['objects']]))
    check('树的汇总计数与前缀一致', tree['dbCount'] == 1 and tree['objCount'] == 3,
          '%s / %s' % (tree['dbCount'], tree['objCount']))

    cols = sc.colsave({'objId': obj_id, 'cols': [
        {'colName': 'id', 'dataType': 'BIGINT', 'isPk': True, 'isAutoInc': True, 'colComment': '主键'},
        {'colName': 'name', 'dataType': 'VARCHAR', 'length': '100', 'nullable': False, 'colComment': '名称'},
        {'colName': 'amount', 'dataType': 'DECIMAL', 'length': '12,2'},
    ]})['list']
    check('批量保存 3 个字段（一次一版）', len(cols) == 3, str(len(cols)))
    check('字段序号按提交顺序 1/2/3', [c['ordinal'] for c in cols] == [1, 2, 3],
          str([c['ordinal'] for c in cols]))
    check('可空 / 主键 / 自增标记正确落库',
          cols[0]['isPk'] is True and cols[0]['isAutoInc'] is True
          and cols[0]['nullable'] is False and cols[1]['nullable'] is False
          and cols[2]['nullable'] is True,
          str([(c['colName'], c['nullable'], c['isPk']) for c in cols]))
    check('字段来源记为 manual', cols[0].get('source') == 'manual', str(cols[0].get('source')))

    expect_error('字段类型必须在逻辑类型清单里', lambda: sc.colsave(
        {'objId': obj_id, 'cols': [{'colName': 'bad', 'dataType': 'MONEY'}]}), '不支持的字段类型')
    expect_error('长度只允许数字或「精度,小数位」', lambda: sc.colsave(
        {'objId': obj_id, 'cols': [{'colName': 'bad', 'dataType': 'VARCHAR', 'length': '100 字符'}]}),
        '字段长度只允许')
    expect_error('同表字段名不能重复', lambda: sc.colsave(
        {'objId': obj_id, 'cols': [{'colName': 'name', 'dataType': 'VARCHAR', 'length': '50'}]}), '已存在')
    expect_error('没有要保存的字段时报错', lambda: sc.colsave({'objId': obj_id, 'cols': []}), '没有要保存')

    # 带 id 的更新是"改"不是"加"
    upd = sc.colsave({'objId': obj_id, 'cols': [
        {'id': cols[1]['id'], 'colName': 'name', 'dataType': 'VARCHAR', 'length': '200',
         'nullable': False, 'colComment': '名称（加长）'}]})['list']
    check('带 id 保存是更新（字段数不变、长度变了）',
          len(upd) == 3 and upd[1]['length'] == '200', str([(c['colName'], c['length']) for c in upd]))

    left = sc.coldel({'objId': obj_id, 'id': cols[2]['id']})['list']
    check('删除字段生效', len(left) == 2 and all(c['colName'] != 'amount' for c in left))

    # 锁定：手工锁住库，扫描不应删除它（此处只验标记能落库 + 回读）
    tree = sc.dbupdate({'id': db_id, 'dbName': MARK + '_db', 'dbComment': '自测库（锁定）', 'locked': True})
    check('库锁定标记可保存并回读', tree['databases'][0]['locked'] is True,
          str(tree['databases'][0].get('locked')))
    sc.dbupdate({'id': db_id, 'dbName': MARK + '_db', 'dbComment': '自测库'})
    return db_id, obj_id


# ---------------------------------------------------------------- 3. 版本 / 发布 / 脚本
def test_versions(app, obj_id):
    print('\n--- 3. 版本：保存出草稿 → 发布出正式版 + 正/反脚本（永不自动执行） ---')
    vers = sc.versions({'appId': app['id']})['list']
    check('前面每次保存都留了一版草稿', len(vers) >= 3 and vers[0]['kind'] == 'draft',
          '%d 版，最新 kind=%s' % (len(vers), vers[0]['kind']))
    check('草稿没有正式版号', not vers[0].get('versionNo'), str(vers[0].get('versionNo')))
    check('草稿带变更条数与摘要', int(vers[0]['changeCount']) > 0 and bool(vers[0].get('summary')),
          '%s / %s' % (vers[0].get('changeCount'), vers[0].get('summary')))

    draft_id = vers[0]['id']
    detail = sc.version({'verId': draft_id})
    check('草稿明细含变更清单', len(detail['changes']) > 0 and detail['version']['canPublish'] is True)
    check('未发布的草稿没有任何脚本', detail['scripts'] == [])

    expect_error('发布必须指明版本 id', lambda: sc.publish({}), '版本 id')

    pub = sc.publish({'verId': draft_id, 'summary': '首版结构', 'remark': '自测发布'})
    ver = pub['version']
    check('发布后生成正式版号 v1', ver['versionNo'] == 'v1' and ver['kind'] == 'release',
          '%s / %s' % (ver.get('versionNo'), ver.get('kind')))
    check('正式版状态 released（还没在实库执行）', ver['status'] == 'released', ver.get('status'))
    kinds = sorted([s['kind'] for s in pub['scripts']])
    check('一次发布出正向 + 回滚两份脚本', kinds == ['forward', 'rollback'], str(kinds))
    check('脚本状态全部 pending（必须人工执行后回写）',
          all(s['status'] == 'pending' for s in pub['scripts']),
          str([s['status'] for s in pub['scripts']]))
    forward = [s for s in pub['scripts'] if s['kind'] == 'forward'][0]['scriptText']
    rollback = [s for s in pub['scripts'] if s['kind'] == 'rollback'][0]['scriptText']
    check('正向脚本含建表与表注释', 'CREATE TABLE' in forward and MARK + '_t' in forward,
          forward[:120])
    check('正向脚本带字段注释（mysql 内联 COMMENT）', 'COMMENT' in forward, forward[:160])
    check('回滚脚本是 DROP（重建前的状态是空库）', 'DROP' in rollback.upper(), rollback[:120])
    check('脚本头部写明「不会自动执行」类提示',
          ('执行' in forward) and ('确认' in forward or '人工' in forward), forward[:200])

    expect_error('已发布的版本不能再发布', lambda: sc.publish({'verId': draft_id}), '只有草稿')

    # 改字段 → 再发布 v2
    cols = sc.cols({'objId': obj_id})['list']
    sc.colsave({'objId': obj_id, 'cols': [
        {'id': cols[0]['id'], 'colName': 'id', 'dataType': 'BIGINT', 'isPk': True, 'isAutoInc': True,
         'colComment': '主键'},
        {'id': cols[1]['id'], 'colName': 'name', 'dataType': 'VARCHAR', 'length': '300',
         'nullable': False, 'colComment': '名称'}]})
    draft2 = sc.versions({'appId': app['id']})['list'][0]
    check('改字段又出一版新草稿', draft2['kind'] == 'draft' and draft2['id'] != draft_id)
    pub2 = sc.publish({'verId': draft2['id']})
    check('第二次发布是 v2', pub2['version']['versionNo'] == 'v2', pub2['version'].get('versionNo'))
    fwd2 = [s for s in pub2['scripts'] if s['kind'] == 'forward'][0]['scriptText']
    check('v2 正向脚本是 ALTER 而不是再 CREATE', 'ALTER TABLE' in fwd2 and 'CREATE TABLE' not in fwd2,
          fwd2[:160])
    old = [one for one in sc.versions({'appId': app['id']})['list']
           if one['id'] == draft_id][0]
    check('旧正式版转 superseded（脚本保留）', old['status'] == 'superseded', old['status'])
    check('旧正式版的两份脚本还在', len(old['scripts']) == 2, str(len(old['scripts'])))

    # 人工回写执行状态
    fwd_script = [s for s in pub2['scripts'] if s['kind'] == 'forward'][0]
    marked = sc.scriptstatus({'id': fwd_script['id'], 'status': 'failed', 'execError': '权限不足'})
    check('标记执行失败能记下失败原因', marked['status'] == 'failed'
          and marked['execError'] == '权限不足', str(marked.get('execError')))
    marked = sc.scriptstatus({'id': fwd_script['id'], 'status': 'applied'})
    check('标记已执行后脚本 applied 且带确认时间', marked['status'] == 'applied'
          and bool(marked.get('confirmTime')), str(marked.get('confirmTime')))
    ver2 = [one for one in sc.versions({'appId': app['id']})['list']
            if one['id'] == draft2['id']][0]
    check('脚本标记已执行 → 对应版本转 applied', ver2['status'] == 'applied', ver2['status'])
    expect_error('脚本状态值受限', lambda: sc.scriptstatus({'id': fwd_script['id'], 'status': 'done'}),
                 '不支持的脚本状态')

    # 内容没变 → 不出版本（避免空版本淹没历史）
    before_cnt = len(sc.versions({'appId': app['id']})['list'])
    sc.colsave({'objId': obj_id, 'cols': [
        {'id': cols[0]['id'], 'colName': 'id', 'dataType': 'BIGINT', 'isPk': True, 'isAutoInc': True,
         'colComment': '主键'},
        {'id': cols[1]['id'], 'colName': 'name', 'dataType': 'VARCHAR', 'length': '300',
         'nullable': False, 'colComment': '名称'}]})
    check('原样再保存一次不产生新版本',
          len(sc.versions({'appId': app['id']})['list']) == before_cnt, str(before_cnt))

    # 先改成 400（出草稿），再改回 300 → 这份草稿整体等于正式版，不能发布
    sc.colsave({'objId': obj_id, 'cols': [
        {'id': cols[0]['id'], 'colName': 'id', 'dataType': 'BIGINT', 'isPk': True, 'isAutoInc': True,
         'colComment': '主键'},
        {'id': cols[1]['id'], 'colName': 'name', 'dataType': 'VARCHAR', 'length': '400',
         'nullable': False, 'colComment': '名称'}]})
    sc.colsave({'objId': obj_id, 'cols': [
        {'id': cols[0]['id'], 'colName': 'id', 'dataType': 'BIGINT', 'isPk': True, 'isAutoInc': True,
         'colComment': '主键'},
        {'id': cols[1]['id'], 'colName': 'name', 'dataType': 'VARCHAR', 'length': '300',
         'nullable': False, 'colComment': '名称'}]})
    latest = sc.versions({'appId': app['id']})['list'][0]
    check('改动 + 改回各出一版草稿（中间态也留痕）', latest['kind'] == 'draft', latest.get('kind'))
    expect_error('改回原样后与正式版无差异，拒绝发布', lambda: sc.publish({'verId': latest['id']}),
                 '没有差异')
    sc.discard({'verId': latest['id']})
    check('草稿可以丢弃（不发布也不残留）',
          sc.versions({'appId': app['id']})['list'][0]['status'] == 'discarded')
    expect_error('已丢弃的草稿不能再丢弃', lambda: sc.discard({'verId': latest['id']}), '只有草稿')


# ---------------------------------------------------------------- 4. 方言
def test_dialects():
    print('\n--- 4. 五方言脚本生成（引号 / 自增 / 注释 / 改列） ---')
    table = {'objType': 'table', 'objName': 'tsa_dialect', 'objComment': '方言表',
             'columns': [
                 {'colName': 'id', 'dataType': 'BIGINT', 'isPk': True, 'isAutoInc': True,
                  'nullable': False, 'colComment': '主键'},
                 {'colName': 'name', 'dataType': 'VARCHAR', 'length': '50', 'nullable': True,
                  'colComment': '名称'},
             ]}
    def ddl_of(db_type):
        return '\n'.join(schema_ddl.create_table(db_type, table))

    mysql = ddl_of('mysql')
    pg = ddl_of('postgresql')
    ora = ddl_of('oracle')
    mssql = ddl_of('sqlserver')
    lite = ddl_of('sqlite')
    check('mysql 用反引号 + AUTO_INCREMENT + 内联 COMMENT',
          '`tsa_dialect`' in mysql and 'AUTO_INCREMENT' in mysql and 'COMMENT' in mysql,
          mysql[:140])
    check('postgresql 用双引号 + 序列自增 + 独立 COMMENT ON',
          '"tsa_dialect"' in pg and 'BIGSERIAL' in pg and 'COMMENT ON' in pg, pg[:160])
    check('oracle 用双引号 + NUMBER 类型 + 独立 COMMENT ON',
          'TSA_DIALECT' in ora.upper() and 'NUMBER' in ora.upper()
          and 'COMMENT ON' in ora.upper(), ora[:160])
    check('sqlserver 用方括号 + sp_addextendedproperty 写注释',
          '[tsa_dialect]' in mssql and 'sp_addextendedproperty' in mssql, mssql[:160])
    check('sqlite 建表不带注释语句（方言不支持）', 'COMMENT' not in lite, lite[:160])

    before = {'objType': 'table', 'objName': 'tsa_dialect', 'objComment': '方言表',
              'columns': [{'colName': 'name', 'dataType': 'VARCHAR', 'length': '50',
                           'nullable': True}]}
    after = {'objType': 'table', 'objName': 'tsa_dialect', 'objComment': '方言表',
             'columns': [{'colName': 'name', 'dataType': 'VARCHAR', 'length': '100',
                          'nullable': True}]}
    diff = {
        'mysql': '\n'.join(schema_ddl.alter_table('mysql', before, after)),
        'postgresql': '\n'.join(schema_ddl.alter_table('postgresql', before, after)),
        'oracle': '\n'.join(schema_ddl.alter_table('oracle', before, after)),
        'sqlserver': '\n'.join(schema_ddl.alter_table('sqlserver', before, after)),
    }
    check('mysql 改列用 MODIFY', 'MODIFY' in diff['mysql'].upper(), diff['mysql'][:120])
    check('postgresql 改列用 ALTER COLUMN + TYPE', 'TYPE' in diff['postgresql'].upper(),
          diff['postgresql'][:120])
    check('oracle 改列用 MODIFY', 'MODIFY' in diff['oracle'].upper(), diff['oracle'][:120])
    check('sqlserver 改列用 ALTER COLUMN', 'ALTER COLUMN' in diff['sqlserver'].upper(),
          diff['sqlserver'][:120])
    lite_diff = schema_ddl.alter_table('sqlite', before, after)
    check('sqlite 改列走「建新表 → 拷数据 → 换名」重建路径',
          any('CREATE TABLE' in one.upper() for one in lite_diff) and len(lite_diff) >= 3,
          str(len(lite_diff)))
    check('批量拼接：mysql 用分号、sqlserver 用 GO',
          schema_ddl.join_statements('mysql', ['SELECT 1', 'SELECT 2']).count(';') == 2
          and 'GO' in schema_ddl.join_statements('sqlserver', ['SELECT 1', 'SELECT 2']))

    # Oracle 的过程 / 函数正文：DBMS_METADATA.GET_DDL 优先，取不到（没 SELECT_CATALOG_ROLE）
    # 就退回 ALL_SOURCE 源码 —— 早期这里是直接写死空串，页面上「定义」框永远是空的
    class _Lob(object):
        def __init__(self, text):
            self._text = text

        def read(self):
            return self._text

    class _FakeCur(object):
        def __init__(self, ddl=None, fail=False):
            self.ddl, self.fail, self.rolled = ddl, fail, False
            self.connection = self
            self.sqls = []

        def execute(self, sql, params=None):
            self.sqls.append(sql)

        def fetchone(self):
            if self.fail:
                raise RuntimeError('ORA-31603: object not found')
            return (self.ddl,)

        def rollback(self):
            self.rolled = True

    src = {('FUN_A', 'FUNCTION'): 'FUNCTION FUN_A RETURN NUMBER IS\nBEGIN\n  RETURN 1;\nEND;'}
    cur = _FakeCur(ddl=_Lob('CREATE OR REPLACE EDITIONABLE FUNCTION "S"."FUN_A" ...'))
    text = connector._oracle_routine_ddl(cur, src, 'S', 'FUN_A', 'function')
    check('Oracle 函数优先用 DBMS_METADATA.GET_DDL（LOB 也读得出来）',
          text.upper().startswith('CREATE OR REPLACE'), text[:60])
    cur = _FakeCur(fail=True)
    text = connector._oracle_routine_ddl(cur, src, 'S', 'FUN_A', 'function')
    check('取不到 GET_DDL 时退回 ALL_SOURCE，并补上 CREATE OR REPLACE',
          text.startswith('CREATE OR REPLACE FUNCTION FUN_A') and cur.rolled, text[:60])
    cur = _FakeCur(fail=True)
    check('两条路都取不到时返回空串（不影响对象收录，页面可手工粘贴）',
          connector._oracle_routine_ddl(cur, {}, 'S', 'FUN_A', 'procedure') == '')
    check('LOB 文本统一走 _lob_text（bytes / 普通字符串都兼容）',
          connector._lob_text(b'abc') == 'abc' and connector._lob_text(None) == ''
          and connector._lob_text(_Lob('xyz')) == 'xyz')

    # Oracle 的**字段注释**：在 ALL_COL_COMMENTS 里，早期只查 ALL_TAB_COLUMNS 导致扫进来全是空注释
    ora_sql = inspect.getsource(connector._oracle_columns)
    check('Oracle 字段查询 join 了 ALL_COL_COMMENTS（注释的来源）',
          'ALL_COL_COMMENTS' in ora_sql and 'm.COMMENTS' in ora_sql, ora_sql[:120])
    cols = connector._oracle_column_dicts([
        ('ORGAN_NAME', 'VARCHAR2', 'Y', None, 1, '机构名称'),
        ('HP_S_NO', 'VARCHAR2', 'N', "'0'", 2, None),          # 没写注释（NULL）
    ])
    check('Oracle 字段注释映射到 comment（有个别字段没注释也不报错）',
          cols[0]['comment'] == '机构名称' and cols[1]['comment'] == ''
          and cols[1]['defaultValue'] == "'0'" and cols[1]['nullable'] is False,
          str(cols))
    check('Oracle 字段顺序用 COLUMN_ID，短结果（无注释列）也不炸',
          [c['ordinal'] for c in cols] == [1, 2]
          and connector._oracle_column_dicts([('A', 'NUMBER', 'Y', None, 3)])[0]['comment'] == '')


# ---------------------------------------------------------------- 5. DDL 导入
def test_import(app):
    print('\n--- 5. DDL 导入（解析 → 落设计态，不动真实库） ---')
    sql = ('CREATE TABLE %s_imp (\n'
           '  id BIGINT NOT NULL AUTO_INCREMENT COMMENT \'主键\',\n'
           '  title VARCHAR(200) NOT NULL COMMENT \'标题\',\n'
           '  PRIMARY KEY (id)\n'
           ') COMMENT=\'导入的表\';\n'
           'ALTER TABLE %s_imp ADD COLUMN memo VARCHAR(500) NULL COMMENT \'备注\';\n'
           % (MARK, MARK))
    parsed = sc.parse({'appId': app['id'], 'sql': sql})
    check('解析出 2 条语句（建表 + 加字段）', parsed['count'] == 2, str(parsed['count']))
    labels = [one['label'] for one in parsed['ops']]
    check('解析结果带中文动作标签', '建表' in labels and '新增字段' in labels, str(labels))
    check('只解析不落库（解析后树里还没有这张表）',
          not any(o['objName'] == MARK + '_imp'
                  for one in sc.tree({'appId': app['id']})['databases'] for o in one['objects']))

    res = sc.importddl({'appId': app['id'], 'sql': sql, 'dbName': MARK + '_db'})
    check('导入返回逐条执行日志且全部成功',
          len(res['logs']) == 2 and all(one.get('ok') for one in res['logs']),
          str(res['logs'])[:200])
    tree = sc.tree({'appId': app['id']})
    dbs = [one for one in tree['databases'] if one['dbName'] == MARK + '_db']
    objs = [o for o in dbs[0]['objects'] if o['objName'] == MARK + '_imp'] if dbs else []
    check('表按 CREATE 语句落进设计态', len(objs) == 1, str(len(objs)))
    imp_cols = sc.cols({'objId': objs[0]['id']})['list'] if objs else []
    check('3 个字段按顺序导入（含 ALTER ADD 的那一列）',
          [c['colName'] for c in imp_cols] == ['id', 'title', 'memo'],
          str([c['colName'] for c in imp_cols]))
    check('主键 / 自增 / 非空 / 默认值按 DDL 还原',
          imp_cols[0]['isPk'] is True and imp_cols[0]['isAutoInc'] is True
          and imp_cols[1]['nullable'] is False and imp_cols[2]['nullable'] is True,
          str([(c['colName'], c['nullable'], c['isPk'], c['isAutoInc']) for c in imp_cols]))
    check('字段注释也从 DDL 里抠出来了',
          imp_cols[0]['colComment'] == '主键' and imp_cols[2]['colComment'] == '备注',
          str([c['colComment'] for c in imp_cols]))
    check('导入后来源记为 import / scan', imp_cols[0].get('source') in ('import', 'scan'),
          str(imp_cols[0].get('source')))
    check('导入也留了一版草稿（source=import）',
          sc.versions({'appId': app['id']})['list'][0]['source'] == 'import',
          sc.versions({'appId': app['id']})['list'][0]['source'])
    expect_error('空 SQL 被拒', lambda: sc.importddl({'appId': app['id'], 'sql': '  '}), '请粘贴')
    check('AST 解析器单测：注释与字符串里的分号不切句',
          len(schema_parse.parse_sql('mysql', "CREATE TABLE t (a VARCHAR(10) COMMENT 'a;b'); -- x;\n")) == 1)


# ---------------------------------------------------------------- 6. 实库对比
def test_compare(app):
    print('\n--- 6. 与真实数据库对比（只人工触发，结果留痕） ---')
    expect_error('未绑连接的应用不能对比（纯手工）',
                 lambda: sc.compare({'appId': app['id']}), '没有绑定数据库连接')
    app_row = db.query_one('SELECT `id` FROM `appinfos` WHERE `id`=%s', (app['id'],))
    check('自测应用确实是未绑连接状态', db.query_one(
        'SELECT `dbConnId` FROM `appinfos` WHERE `id`=%s', (app_row['id'],))['dbConnId'] is None)
    check('对比历史初始为空', sc.compares({'appId': app['id']})['list'] == [])


def test_compare_view_ddl():
    print('\n--- 6.1 视图 / 过程定义比对（只读守卫放行 SHOW CREATE、DEFINER 不参与对比） ---')
    # 只读守卫：SHOW CREATE 是读元数据，语句里天生带 CREATE；以前被当写操作拦掉，
    # 结果实库对比一读到视图就整体失败（"写操作关键字「CREATE」"），线上库比不了。
    for sql in ('SHOW CREATE TABLE `d`.`t`', 'SHOW CREATE VIEW `d`.`v`',
                'SHOW CREATE PROCEDURE `d`.`p`'):
        try:
            connector._check_sql(sql)
            ok = True
        except connector.ConnError:
            ok = False
        check('只读守卫放行 %s' % sql.split('`')[0].strip(), ok, sql)
    for sql in ('CREATE TABLE `d`.`t` (`id` INT)', 'SHOW CREATE TABLE `d`.`t`; DROP TABLE `d`.`t`'):
        try:
            connector._check_sql(sql)
            rejected = False
        except connector.ConnError:
            rejected = True
        check('只读守卫仍然拒绝 %s' % sql.split('(')[0].strip()[:40], rejected, sql)

    left = {'databases': [{'dbName': 'd', 'objects': [
        {'objName': 'v_empty', 'objType': 'view', 'ddl': ''},
        {'objName': 'v_same', 'objType': 'view',
         'ddl': 'CREATE ALGORITHM=UNDEFINED DEFINER=`sa`@`%` VIEW `v_same` AS select 1'},
        {'objName': 'v_diff', 'objType': 'view', 'ddl': 'CREATE VIEW `v_diff` AS select 1'}]}]}
    right = {'databases': [{'dbName': 'd', 'objects': [
        {'objName': 'v_empty', 'objType': 'view', 'ddl': 'CREATE VIEW `v_empty` AS select 2'},
        {'objName': 'v_same', 'objType': 'view',
         'ddl': 'CREATE ALGORITHM=UNDEFINED DEFINER=`app`@`10.%` VIEW `v_same` AS\n  select 1'},
        {'objName': 'v_diff', 'objType': 'view', 'ddl': 'CREATE VIEW `v_diff` AS select 2'}]}]}
    items = dict((one['objName'], one) for one in sc._compare_items(left, right))
    check('设计态没存视图定义时不算「定义不同」（不凭空造假差异）',
          items['d.v_empty']['diffType'] == 'same', str(items['d.v_empty']['diffType']))
    check('只有 DEFINER / 换行不一样时视图算一致',
          items['d.v_same']['diffType'] == 'same', str(items['d.v_same']['diffType']))
    check('视图定义真的不同时报差异', items['d.v_diff']['diffType'] == 'attrDiff',
          str(items['d.v_diff']['diffType']) + ' / ' + str(items['d.v_diff'].get('message')))
    check('DEFINER 差异不算「修改定义」（保存两版之间）',
          app_schema._object_diff_detail(
              {'objType': 'view', 'ddl': 'CREATE DEFINER=`sa`@`%` VIEW `v` AS select 1'},
              {'objType': 'view', 'ddl': 'CREATE DEFINER=`app`@`%` VIEW `v` AS select 1'}) == '')


def test_lineage(app):
    print('\n--- 6.2 字段血缘（视图 / 视图套视图 / 触发器写入 / 解析不了的要留痕） ---')
    made = []

    def add_obj(name, otype, cols, ddl=''):
        obj_id = str(uuid.uuid4())
        db.execute('INSERT INTO `appschemaobjs` (`id`,`dbId`,`objType`,`objName`,`ddl`,`source`) '
                   'VALUES (%s,%s,%s,%s,%s,%s)', (obj_id, db_id, otype, name, ddl or None, 'manual'))
        for pos, col in enumerate(cols or [], 1):
            db.execute('INSERT INTO `appschemacols` (`id`,`objId`,`colName`,`ordinal`,`dataType`) '
                       'VALUES (%s,%s,%s,%s,%s)', (str(uuid.uuid4()), obj_id, col, pos, 'VARCHAR'))
        made.append(obj_id)
        return obj_id

    db_id = str(uuid.uuid4())
    try:
        db.execute('INSERT INTO `appschemadbs` (`id`,`appId`,`dbName`,`source`,`sortNo`) '
                   'VALUES (%s,%s,%s,%s,%s)', (db_id, app['id'], 'lg_db', 'manual', 1))
        add_obj('emp', 'table', ['id', 'name', 'dept'])
        add_obj('v_emp', 'view', ['id', 'full_name'],
                "CREATE ALGORITHM=UNDEFINED DEFINER=`sa`@`%` VIEW `v_emp` AS "
                "select `e`.`id` AS `id`, concat(`e`.`name`,'-',`e`.`dept`) AS `full_name` from `emp` `e`")
        add_obj('v_emp2', 'view', ['id', 'full_name'],
                "CREATE VIEW `v_emp2` AS select `v`.`id` AS `id`, `v`.`full_name` AS `full_name` "
                "from `v_emp` `v`")
        add_obj('t_log', 'table', ['id', 'nm'])
        add_obj('trg_emp', 'trigger', [],
                "BEGIN INSERT INTO `t_log` (`id`,`nm`) SELECT `e`.`id`, `e`.`name` FROM `emp` `e`; END")
        add_obj('v_bad', 'view', ['x'], 'CREATE VIEW `v_bad` AS select (((')
        # 带过滤 / 聚合 / 分组的视图：用来验证 DIRECT 之外还要记 INDIRECT（过滤、分组）
        add_obj('v_agg', 'view', ['dept', 'total'],
                "CREATE VIEW `v_agg` AS select `e`.`dept` AS `dept`, sum(`e`.`salary`) AS `total` "
                "from `emp` `e` where `e`.`name` is not null group by `e`.`dept`")

        res = sc.lineagebuild({'appId': app['id']})
        check('重建血缘：返回边数 / 参与对象数 / 未解析条数',
              int(res.get('edgeCount') or 0) >= 8 and int(res.get('objectCount') or 0) >= 4
              and int(res.get('noteCount') or 0) >= 1, str(res)[:200])
        check('语法错误的视图不会拖垮整次分析，而是留一条未解析提示',
              any('v_bad' == one['objName'] for one in (res.get('notes') or [])), str(res.get('notes'))[:160])

        one = sc.lineage({'appId': app['id'], 'objName': 'v_emp', 'colName': 'full_name'})
        check('视图字段的上游指到基表字段（表达式里引用了两列 → 两条）',
              len(one['up']) == 2 and all(x['sourceObj'].lower() == 'emp' for x in one['up']),
              str(one['up'])[:200])
        check('上游带「怎么算出来的」表达式与来源类型',
              any('concat' in x['transform'].lower() for x in one['up'])
              and all(x['sourceType'] == 'table' for x in one['up']), str(one['up'])[:160])

        two = sc.lineage({'appId': app['id'], 'objName': 'v_emp2', 'colName': 'full_name'})
        check('视图套视图会一路展开到基表，并记录途经链与层数',
              len(two['up']) == 2 and all(x['depth'] == 1 for x in two['up'])
              and all('v_emp' in x['via'].lower() for x in two['up']), str(two['up'])[:220])

        down = sc.lineage({'appId': app['id'], 'objName': 'emp', 'colName': 'name'})
        targets = sorted(set('%s.%s' % (x['targetObj'], x['targetCol']) for x in down['down']))
        check('字段下游：谁在用这一列（视图 2 个字段 + 触发器写入 1 个字段）',
              'v_emp.full_name' in targets and 'v_emp2.full_name' in targets
              and 't_log.nm' in targets, str(targets))
        check('触发器里的 INSERT ... SELECT 能解析成「写入字段 ← 来源字段」',
              any(x['kind'] == 'trigger' and x['targetObj'] == 't_log' for x in down['down'])
              or any(x['kindLabel'] == '触发器' for x in down['down']), str(down['down'])[:200])

        fields = sc.lineage({'appId': app['id'], 'objName': 'emp'})
        names = dict((one['colName'].lower(), one) for one in fields['fields'])
        check('表字段清单带上/下游计数（没有血缘的字段也在，计数为 0）',
              names.get('name', {}).get('downCount', 0) >= 2 and names.get('dept', {}).get('upCount', 0) == 0,
              str(names.get('name')) + ' / ' + str(names.get('dept')))
        check('字段清单来自设计态（注释 / 主键标记一起带回）',
              'colComment' in names.get('id', {}) and 'isPk' in names.get('id', {}), str(names.get('id')))

        # ---- 血缘类型：DIRECT（值从哪来）vs INDIRECT（决定取哪些行 / 怎么分组）----
        check('重建结果分开报「直接派生」与「间接影响」条数',
              int(res.get('directCount') or 0) >= 8 and int(res.get('indirectCount') or 0) >= 2,
              'direct=%s indirect=%s' % (res.get('directCount'), res.get('indirectCount')))

        agg = sc.lineage({'appId': app['id'], 'objName': 'v_agg'})
        deps = set((one['sourceObj'], one['sourceCol'], one['subType']) for one in agg['rowDeps'])
        check('整表依赖：WHERE 的列记成 INDIRECT / FILTER，GROUP BY 的列记成 INDIRECT / GROUP_BY',
              ('emp', 'name', 'FILTER') in deps and ('emp', 'dept', 'GROUP_BY') in deps, str(sorted(deps)))
        check('整表依赖不影响「这个字段的值」，所以带中文标签且不带目标字段',
              all(one['targetCol'] == '' and one['linkType'] == 'INDIRECT'
                  and one['subTypeLabel'] for one in agg['rowDeps']), str(agg['rowDeps'])[:220])
        up_map = dict((one['sourceCol'], one) for one in agg['up'])
        check('原样搬运的列标成 IDENTITY', up_map.get('dept', {}).get('subType') == 'IDENTITY',
              str(up_map.get('dept')))
        check('跨行聚合的列标成 AGGREGATION（改一行会影响整组结果）',
              any(one['sourceCol'] == 'salary' and one['subType'] == 'AGGREGATION'
                  for one in agg['up']), str(agg['up'])[:200])

        v_emp = sc.lineage({'appId': app['id'], 'objName': 'v_emp', 'colName': 'full_name'})
        check('表达式算出来的列标成 TRANSFORMATION（原样搬运是 IDENTITY）',
              all(one['subType'] == 'TRANSFORMATION' for one in v_emp['up']), str(v_emp['up'])[:160])
        pass_col = sc.lineage({'appId': app['id'], 'objName': 'v_emp', 'colName': 'id'})
        check('直接搬运的列标成 IDENTITY', all(one['subType'] == 'IDENTITY' for one in pass_col['up']),
              str(pass_col['up'])[:160])
        down_filter = sc.lineage({'appId': app['id'], 'objName': 'emp', 'colName': 'name'})
        check('下游带上「被谁拿去当过滤条件」（INDIRECT 也进下游，评估影响才不漏）',
              any(one['targetObj'] == 'v_agg' and one['linkType'] == 'INDIRECT'
                  and one['subType'] == 'FILTER' for one in down_filter['down']),
              str([(x['targetObj'], x['linkType'], x['subType']) for x in down_filter['down']])[:220])
        check('字段计数只算直接派生（INDIRECT 不摊到具体字段上）',
              dict((one['colName'].lower(), one) for one in down_filter['fields'])
              .get('name', {}).get('downCount', 0) >= 2, str(down_filter['fields'])[:200])

        # 快照必须批量取：早先按对象逐个查字段（518 个对象 = 518 次建连，单这一步 20 秒），
        # 血缘重建 / 版本 diff 都被拖到前端 15 秒超时。这里锁住「3 条 SQL 搞定」。
        calls = []
        raw = app_schema.query_all

        def _count(sql, args=None):
            calls.append(sql)
            return raw(sql, args)

        app_schema.query_all = _count
        try:
            snap = sc._snapshot(app['id'])
        finally:
            app_schema.query_all = raw
        objs = [o for d in snap['databases'] for o in d['objects']]
        check('快照只发 3 条 SQL（库 / 对象 / 字段各一条批量查，不按对象逐个建连）',
              len(calls) == 3, '实际 %d 条：%s' % (len(calls), calls))
        check('批量取出的快照把字段挂在正确对象下，且仍按 ordinal 排',
              any(o['objName'] == 'v_emp'
                  and [c['colName'] for c in o['columns']] == ['id', 'full_name'] for o in objs),
              str([(o['objName'], [c['colName'] for c in o['columns']]) for o in objs])[:200])

        # ---- 人工标注（2026-11-20）：人补的边重算不覆盖 ----
        print('\n--- 6.3 手工标注血缘（人工补 / 转手工 / 删除保护） ---')
        saved = sc.lineageedgesave({
            'appId': app['id'], 'targetObj': 't_log', 'targetCol': 'id',
            'sourceObj': 'emp', 'sourceCol': 'id',
            'linkType': 'DIRECT', 'subType': 'IDENTITY',
            'note': '人工补：日志 id 取自员工表（过程里是动态 SQL，解析不出来）'})
        check('手工新增一条边：落库为 origin=manual 并带回标注',
              (saved.get('edge') or {}).get('origin') == 'manual'
              and str((saved.get('edge') or {}).get('note') or '').startswith('人工补'),
              str(saved.get('edge'))[:200])

        logs = sc.lineage({'appId': app['id'], 'objName': 't_log', 'colName': 'id'})
        manual_up = [one for one in logs['up'] if one['origin'] == 'manual']
        check('人工标注的边进了上游明细（页面上直接能看到标注）',
              len(manual_up) == 1 and manual_up[0]['sourceObj'] == 'emp'
              and '动态 SQL' in manual_up[0]['note'], str(logs['up'])[:220])
        check('血缘统计把人工标注单独计数',
              int((logs.get('originCounts') or {}).get('manual') or 0) >= 1,
              str(logs.get('originCounts')))

        again = sc.lineagebuild({'appId': app['id']})
        logs2 = sc.lineage({'appId': app['id'], 'objName': 't_log', 'colName': 'id'})
        keep = [one for one in logs2['up']
                if one['origin'] == 'manual' and one['sourceObj'] == 'emp' and one['sourceCol'] == 'id']
        check('重新分析不会覆盖人工标注的边（人标的东西不能被机器抹掉）',
              len(keep) == 1 and '动态 SQL' in keep[0]['note'], str(logs2['up'])[:220])
        check('重新分析后同一条逻辑边不会重复成两条（人工那条优先）',
              len([one for one in logs2['up']
                   if one['sourceObj'] == 'emp' and one['sourceCol'] == 'id']) == 1,
              str([(one['origin'], one['sourceObj'], one['sourceCol']) for one in logs2['up']])[:200])
        check('重建返回把人工边算进边数与来源分布',
              int(again.get('edgeCount') or 0) >= 1
              and int((again.get('originCounts') or {}).get('manual') or 0) >= 1, str(again)[:200])

        # 转手工：把解析出来的边改成人工维护（以后重算也保留）
        auto = [one for one in sc.lineage({'appId': app['id'], 'objName': 'v_emp',
                                           'colName': 'full_name'})['up'] if one['origin'] == 'sql']
        if auto:
            turn = sc.lineageedgesave({'appId': app['id'], 'id': auto[0]['id'],
                                       'linkType': 'DIRECT', 'subType': 'TRANSFORMATION',
                                       'note': '口径：姓名-部门，部门取简称'})
            check('把解析边转为手工标注：origin 变 manual，端点不变',
                  (turn.get('edge') or {}).get('origin') == 'manual'
                  and (turn.get('edge') or {}).get('sourceObj') == auto[0]['sourceObj']
                  and (turn.get('edge') or {}).get('note') == '口径：姓名-部门，部门取简称',
                  str(turn.get('edge'))[:220])
            after = sc.lineage({'appId': app['id'], 'objName': 'v_emp', 'colName': 'full_name'})
            sc.lineagebuild({'appId': app['id']})
            again2 = sc.lineage({'appId': app['id'], 'objName': 'v_emp', 'colName': 'full_name'})
            check('转手工后重新分析仍然在（不会退回成自动边，也不会被删）',
                  any(one['origin'] == 'manual' and one['note'] == '口径：姓名-部门，部门取简称'
                      for one in again2['up']),
                  '转前：%s / 转后：%s' % (str(after['up'])[:110], str(again2['up'])[:110]))

        # 校验：拼错字段 / 自环 / 子类型与类型不匹配都要拒绝
        expect_error('标注到不存在的字段被拒绝（否则留下一条永远对不上的边）',
                     lambda: sc.lineageedgesave({'appId': app['id'], 'targetObj': 't_log',
                                                 'targetCol': 'nope', 'sourceObj': 'emp',
                                                 'sourceCol': 'id', 'linkType': 'DIRECT',
                                                 'subType': 'IDENTITY'}), '不存在')
        expect_error('来源与目标同一个字段被拒绝（血缘不能自指）',
                     lambda: sc.lineageedgesave({'appId': app['id'], 'targetObj': 'emp',
                                                 'targetCol': 'id', 'sourceObj': 'emp',
                                                 'sourceCol': 'id', 'linkType': 'DIRECT',
                                                 'subType': 'IDENTITY'}), '同一个字段')
        expect_error('子类型与血缘类型不匹配被拒绝',
                     lambda: sc.lineageedgesave({'appId': app['id'], 'targetObj': 't_log',
                                                 'targetCol': 'nm', 'sourceObj': 'emp',
                                                 'sourceCol': 'name', 'linkType': 'DIRECT',
                                                 'subType': 'FILTER'}), '不适用')

        # 删除：解析边不给删（删了重算还会长回来），手工边可以删
        parsed_edge = db.query_one("SELECT `id` FROM `appschemalink` WHERE `appId`=%s "
                                   "AND `origin`<>'manual' LIMIT 1", (app['id'],))
        if parsed_edge:
            expect_error('自动解析的边不能直接删（要先转手工，否则重算又回来）',
                         lambda: sc.lineageedgedel({'appId': app['id'], 'id': parsed_edge['id']}),
                         '转为手工')
        gone = sc.lineageedgedel({'appId': app['id'], 'id': keep[0]['id']}) if keep else {}
        left = sc.lineage({'appId': app['id'], 'objName': 't_log', 'colName': 'id'})
        check('手工边可以删除，删完就不在血缘里了',
              (gone or {}).get('deleted')
              and not [one for one in left['up'] if one['origin'] == 'manual'], str(left['up'])[:200])
        if keep:
            db.execute('DELETE FROM `appschemalinkmeta` WHERE `appId`=%s', (app['id'],))
    finally:
        for obj_id in made:
            try:
                db.execute('DELETE FROM `appschemacols` WHERE `objId`=%s', (obj_id,))
                db.execute('DELETE FROM `appschemaobjs` WHERE `id`=%s', (obj_id,))
            except Exception:                    # noqa: BLE001
                pass
        for table in ('appschemalink', 'appschemalinknote', 'appschemalinkmeta'):
            try:
                db.execute('DELETE FROM `%s` WHERE `appId`=%%s' % table, (app['id'],))
            except Exception:                    # noqa: BLE001
                pass
        try:
            db.execute('DELETE FROM `appschemadbs` WHERE `id`=%s', (db_id,))
        except Exception:                        # noqa: BLE001
            pass


# ---------------------------------------------------------------- 6. 扫描范围
def test_scan_scope():
    print('\n--- 6. 扫描范围（只扫连接指定的那一个库，不做全库扫描） ---')
    conf = config.DB_CONFIG
    a_db, b_db = 'tesa_scope_a', 'tesa_scope_b'
    made, conn_id, app = [], None, None
    try:
        for one in (a_db, b_db):
            db.execute('CREATE DATABASE IF NOT EXISTS `%s` DEFAULT CHARACTER SET utf8mb4' % one)
            made.append(one)
        # 列顺序故意与字母序相反（zz / aa / mm）：扫描后设计态必须还是这个顺序
        db.execute('DROP TABLE IF EXISTS `%s`.`t_a`' % a_db)
        db.execute('CREATE TABLE `%s`.`t_a` (`id` INT PRIMARY KEY, `zz` VARCHAR(20), '
                   '`aa` INT, `mm` DATE, `name` VARCHAR(20))' % a_db)
        db.execute('CREATE INDEX `idx_t_a_zz` ON `%s`.`t_a` (`zz`)' % a_db)
        db.execute('CREATE TABLE IF NOT EXISTS `%s`.`t_b` (`id` INT PRIMARY KEY)' % b_db)
        made_trigger = made_function = True
        try:
            db.execute('DROP TRIGGER IF EXISTS `%s`.`trg_t_a_bi`' % a_db)
            db.execute('CREATE TRIGGER `%s`.`trg_t_a_bi` BEFORE INSERT ON `%s`.`t_a` '
                       'FOR EACH ROW SET NEW.aa = IFNULL(NEW.aa, 0)' % (a_db, a_db))
        except Exception:                        # noqa: BLE001
            made_trigger = False
        try:
            db.execute('DROP FUNCTION IF EXISTS `%s`.`f_t_a_double`' % a_db)
            db.execute('CREATE FUNCTION `%s`.`f_t_a_double`(x INT) RETURNS INT '
                       'DETERMINISTIC RETURN x * 2' % a_db)
        except Exception:                        # noqa: BLE001
            made_function = False
    except Exception as exc:                     # noqa: BLE001
        print('  [SKIP] 建临时库失败（当前账号没有建库权限？）：%s' % exc)
        for one in made:
            try:
                db.execute('DROP DATABASE IF EXISTS `%s`' % one)
            except Exception:                    # noqa: BLE001
                pass
        return

    try:
        conn_id = str(uuid.uuid4())
        db.execute('INSERT INTO `dbinfomgr` (`id`,`name`,`dbType`,`host`,`port`,`dbName`,`username`,'
                   '`password`,`enabled`,`ispub`) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,1,1)',
                   (conn_id, MARK + '_scan_conn', 'mysql', conf['host'], conf['port'], a_db,
                    conf['user'], connector.encrypt_secret(conf['password'])))
        app = svc.add({'code': MARK + 'S1', 'name': MARK + ' 扫描范围', 'dbType': 'mysql',
                       'dbConnId': conn_id})

        info = sc.scan_info({'appId': app['id']})
        check('扫描前能取到连接名与「默认库」（页面据此预选目标，而不是让人挑一堆库）',
              info['connName'] == MARK + '_scan_conn' and info['target'] == a_db and not info['error'],
              str(info)[:200])
        names = [one['name'] for one in info['databases']]
        check('scan_info 只列库名（不读表结构），目标库与兄弟库都在可访问列表里',
              a_db in names and b_db in names, str(names)[:200])

        res = sc.scan({'appId': app['id']})       # 不传 database → 用连接默认库
        check('不传 database 时只扫连接默认库（scope=single）',
              res['target'] == a_db and res['scope'] == 'single',
              '%s / %s' % (res.get('target'), res.get('scope')))
        check('扫描统计里只有 1 个库、1 张表', res['databases'] == 1 and res['tables'] == 1,
              '%s / %s' % (res['databases'], res['tables']))
        tree = sc.tree({'appId': app['id']})
        dbs_in_tree = [one['dbName'] for one in tree['databases']]
        check('结构树里只多出默认库这一个库（兄弟库没被顺手扫进来）',
              dbs_in_tree == [a_db], str(dbs_in_tree))
        check('tree 带回连接的默认库与连接名（前端预选对比目标用）',
              tree['app']['connDbName'] == a_db and tree['app']['connName'] == MARK + '_scan_conn',
              str(tree['app'])[:180])
        # Flask 默认把 datetime 序列化成 RFC822（Tue, 17 Nov 2026 …），前端 slice 会切错
        stamp = str(tree['app'].get('lastScanTime') or '')
        check('最近扫描时间是「YYYY-MM-DD HH:MM:SS」而不是 RFC822',
              len(stamp) == 19 and stamp[4] == '-' and stamp[10] == ' ', stamp)

        res2 = sc.scan({'appId': app['id'], 'database': b_db})
        check('显式指定另一个库时只扫那一个（单选，可以换库）',
              res2['target'] == b_db and res2['scope'] == 'single' and res2['databases'] == 1,
              '%s / %s / %s' % (res2.get('target'), res2.get('scope'), res2.get('databases')))
        dbs_in_tree = sorted(one['dbName'] for one in sc.tree({'appId': app['id']})['databases'])
        check('两个库各自独立留在树里（换库扫描不覆盖前一个）',
              dbs_in_tree == sorted([a_db, b_db]), str(dbs_in_tree))

        # 字段顺序：ORDINAL_POSITION 落库，不靠「查询结果碰巧有序」
        tree_a = sc.tree({'appId': app['id']})
        obj_a = None
        for one in (tree_a['databases'][0]['objects'] if tree_a['databases'] else []):
            if one['objName'] == 't_a':
                obj_a = one
        check('扫描后设计态里有 t_a', bool(obj_a), str(tree_a['databases'])[:200])
        col_names = [one['colName'] for one in sc.cols({'objId': obj_a['id']})['list']] if obj_a else []
        check('字段顺序与实库一致（id / zz / aa / mm / name，不是字母序 aa / id / mm / name / zz）',
              col_names == ['id', 'zz', 'aa', 'mm', 'name'], str(col_names))
        ordinals = [one['ordinal'] for one in sc.cols({'objId': obj_a['id']})['list']] if obj_a else []
        check('ordinal 落成连续的 1..n（页面上「序号」列不会跳号）',
              ordinals == [1, 2, 3, 4, 5], str(ordinals))

        # 索引 / 触发器 / 函数：不再只收表和视图
        idx_objs = [one for one in tree_a['databases'][0]['objects']
                    if one['objType'] == 'index'] if tree_a['databases'] else []
        trg_objs = [one for one in tree_a['databases'][0]['objects']
                    if one['objType'] == 'trigger'] if tree_a['databases'] else []
        fn_objs = [one for one in tree_a['databases'][0]['objects']
                   if one['objType'] == 'function'] if tree_a['databases'] else []
        check('扫描收录了索引，名字带所属表（t_a.idx_t_a_zz）',
              any(one['objName'] == 't_a.idx_t_a_zz' for one in idx_objs), str(idx_objs)[:220])
        check('索引对象带 typeLabel=索引', all(one['typeLabel'] == '索引' for one in idx_objs),
              str([one['typeLabel'] for one in idx_objs]))
        check('扫描统计里 indexes 计数与树里一致',
              int(res.get('indexes') or 0) == len(idx_objs), '%s / %s' % (res.get('indexes'), len(idx_objs)))
        if made_trigger:
            check('扫描收录了触发器（t_a.trg_t_a_bi）',
                  any(one['objName'] == 't_a.trg_t_a_bi' for one in trg_objs), str(trg_objs)[:220])
        if made_function:
            check('扫描收录了函数（和存储过程区分开，typeLabel=函数）',
                  any(one['objName'] == 'f_t_a_double' and one['typeLabel'] == '函数'
                      for one in fn_objs), str(fn_objs)[:220])
            fn_row = next((one for one in fn_objs if one['objName'] == 'f_t_a_double'), None)
            fn_ddl = str((db.query_one('SELECT `ddl` FROM `appschemaobjs` WHERE `id`=%s',
                                      (fn_row['id'],)) or {}).get('ddl') or '') if fn_row else ''
            check('函数的定义原文也收下来了（页面上「定义」框不能是空的）',
                  'FUNCTION' in fn_ddl.upper() and 'X * 2' in fn_ddl.upper(), fn_ddl[:160])
        if trg_objs:
            trg = db.query_one('SELECT `ddl` FROM `appschemaobjs` WHERE `id`=%s', (trg_objs[0]['id'],))
            check('触发器的 DDL 原文收下来了（能直接生成 CREATE TRIGGER）',
                  'CREATE TRIGGER' in str((trg or {}).get('ddl') or '').upper(),
                  str((trg or {}).get('ddl'))[:160])
        if idx_objs:
            idx = db.query_one('SELECT `ddl` FROM `appschemaobjs` WHERE `id`=%s', (idx_objs[0]['id'],))
            check('索引的 DDL 原文收下来了（CREATE INDEX … ON …）',
                  'CREATE' in str((idx or {}).get('ddl') or '').upper()
                  and 'ON' in str((idx or {}).get('ddl') or '').upper(),
                  str((idx or {}).get('ddl'))[:160])

        expect_error('目标库不存在时给出可访问清单，而不是静默退化成扫全库',
                     lambda: sc.scan({'appId': app['id'], 'database': 'tesa_nope_db'}), '找不到库')

        db.execute('UPDATE `dbinfomgr` SET `dbName`=NULL WHERE `id`=%s', (conn_id,))
        info = sc.scan_info({'appId': app['id']})
        check('连接没填默认库时 scan_info 不报错，而是 needPick=true（弹窗里现场选）',
              (not info['error']) and info['needPick'] is True and len(info['databases']) >= 2,
              'error=%r needPick=%r' % (info.get('error'), info.get('needPick')))
        res3 = sc.scan({'appId': app['id'], 'database': a_db})
        check('弹窗里选中的库能直接扫（未填默认库也不卡人，仍只扫这一个）',
              res3['target'] == a_db and res3['databases'] == 1, str(res3.get('target')))
        expect_error('不传 database 时仍然拒绝（API 侧绝不退化成全库扫描）',
                     lambda: sc.scan({'appId': app['id']}), '没有指定「默认库」')
        expect_error('对比也一样，不传目标就拒绝（不退化成全库对比）',
                     lambda: sc.compare({'appId': app['id']}), '没有指定「默认库」')
        db.execute('UPDATE `dbinfomgr` SET `dbName`=%s WHERE `id`=%s', (a_db, conn_id))

        sc.compare({'appId': app['id']})
        latest = (sc.compares({'appId': app['id']})['list'] or [{}])[0]
        check('对比同样只扫连接默认库，并把实际目标库记在对比记录上',
              latest.get('dbName') == a_db, str(latest.get('dbName')))

        # ---------- 差异详情 + 给实库升级的脚本 ----------
        tree = sc.tree({'appId': app['id']})
        node = [one for one in tree['databases'] if one['dbName'] == a_db][0]
        obj = [one for one in node['objects'] if one['objName'] == 't_a'][0]
        cols = sc.cols({'objId': obj['id']})['list']
        name_col = [one for one in cols if one['colName'] == 'name'][0]
        # 设计态：name 加长到 100 且改非空；新加 memo 列
        sc.colsave({'objId': obj['id'],
                    'cols': [dict(name_col, length='100', nullable=0)]})
        sc.colsave({'objId': obj['id'],
                    'cols': [{'colName': 'memo', 'dataType': 'varchar', 'length': '50',
                              'nullable': 1, 'defaultValue': '', 'colComment': '备注'}]})
        cmp1 = sc.compare({'appId': app['id']})
        row1 = [one for one in cmp1['items'] if one['objName'] == '%s.t_a' % a_db]
        check('对比结果里出现了这张表的差异项', len(row1) == 1, str([one['objName'] for one in cmp1['items']]))
        detail_texts = [one['text'] for one in (row1[0].get('details') or [])]
        check('差异详情逐条列出「实库缺哪个字段」（不是一句话概括）',
              any('memo' in one and '新增' in one for one in detail_texts), str(detail_texts))
        check('差异详情列出字段属性变化（类型 / 可空逐项写明）',
              any('varchar(20) → varchar(100)' in one.lower() for one in detail_texts)
              and any('可空 允许 → 不允许' in one for one in detail_texts), str(detail_texts))
        check('差异详情只比目标库（兄弟库不参与）',
              all(one['objName'].startswith(a_db + '.') or one['objName'] == a_db
                  for one in cmp1['items']),
              str(sorted(set(one['objName'] for one in cmp1['items']))[:6]))
        check('差异项带「升级语句条数」', int(row1[0].get('upgradeCount') or 0) > 0,
              str(row1[0].get('upgradeCount')))
        # 索引回归：_scan_snapshot 取索引结果的键是 indexes（不是 index + 's'），
        # 拼错会让实库侧一条索引都收不到 → 扫描进来的索引全被判成「仅设计有（待建）」。
        idx_cmp = [one for one in cmp1['items'] if one['objType'] == 'index']
        check('扫描进来的索引在对比时判「一致」，不会整体误判成「仅设计有（待建）」',
              bool(idx_cmp) and all(one['diffType'] == 'same' for one in idx_cmp),
              str([(one['objName'], one['diffType']) for one in idx_cmp])[:220])
        check('对比返回里带升级脚本概要（语句数 / 覆盖对象数 / 跳过数）',
              cmp1['upgrade']['count'] >= 1 and cmp1['upgrade']['objects'] >= 1,
              str(cmp1['upgrade']))

        up1 = sc.compareupgrade({'compareId': cmp1['id']})
        up_sql = [one for one in up1['text'].splitlines()
                  if one.strip() and not one.strip().startswith('--')]
        check('升级脚本按「实库 → 设计态」给出 ADD COLUMN / MODIFY COLUMN',
              any('ADD COLUMN' in one and 'memo' in one for one in up_sql)
              and any('MODIFY COLUMN' in one for one in up_sql), str(up_sql[:4]))
        check('升级脚本头部写明这是「实库对比升级」且不会自动执行',
              '实库对比升级' in up1['text'] and '不会自动执行' in up1['text'])
        check('升级脚本把每条差异作为注释跟在对象分组下面',
              '实库缺字段' in up1['text'] and '%s.t_a' % a_db in up1['text'])
        check('升级脚本不带 DROP（这次没有要删的列）',
              not any('DROP ' in one for one in up_sql), str(up_sql[:4]))

        # 设计态删掉 name 列 → 实库多一列：默认不删，勾选后才出 DROP COLUMN
        sc.coldel({'objId': obj['id'], 'id': name_col['id']})
        cmp2 = sc.compare({'appId': app['id']})
        up2 = sc.compareupgrade({'compareId': cmp2['id']})
        up2_sql = [one for one in up2['text'].splitlines()
                   if one.strip() and not one.strip().startswith('--')]
        check('实库多出来的字段默认不生成 DROP COLUMN（避免误删数据）',
              not any('DROP COLUMN' in one for one in up2_sql), str(up2_sql[:4]))
        check('默认跳过时在注释里写明「要彻底对齐得勾选包含删除」',
              '需要彻底对齐时勾选' in up2['text'], up2['text'][-300:])
        up3 = sc.compareupgrade({'compareId': cmp2['id'], 'includeDrop': 1})
        up3_sql = [one for one in up3['text'].splitlines()
                   if one.strip() and not one.strip().startswith('--')]
        check('勾选「包含删除语句」后才生成 DROP COLUMN',
              any('DROP COLUMN' in one and 'name' in one for one in up3_sql), str(up3_sql[:4]))

        # ---------- 属性差异 + 列顺序差异同时存在：同一列不重复改两遍 ----------
        def _col(name, dtype, length, nullable, ordinal, pk=0):
            return {'colName': name, 'dataType': dtype, 'length': length,
                    'nullable': nullable, 'isPk': pk, 'isAutoInc': pk,
                    'defaultValue': '', 'colComment': '', 'ordinal': ordinal}
        ord_design = {'objName': 't_ord', 'objType': 'table', 'objComment': '', 'columns': [
            _col('id', 'int', '', 0, 1),
            _col('name', 'varchar', '100', 0, 2),
            _col('memo', 'varchar', '50', 1, 3)]}
        ord_real = {'objName': 't_ord', 'objType': 'table', 'objComment': '', 'columns': [
            _col('id', 'int', '', 0, 1),
            _col('memo', 'varchar', '50', 1, 2),
            _col('name', 'varchar', '20', 1, 3)]}
        ord_sql, ord_note = app_schema._item_upgrade_sql(
            'mysql', {'objName': 't_ord', 'objType': 'table', 'diffType': 'attrDiff',
                      'left': ord_design, 'right': ord_real})
        ord_mods = [app_schema._modify_column_name(one) for one in ord_sql]
        check('属性差异与列顺序差异叠加时，同一列不会出两条 MODIFY（顺序语句已带完整定义）',
              len(ord_mods) == len(set(ord_mods)) and 'name' in ord_mods, str(ord_mods))
        check('列顺序被重排时在备注里说明「调整了 N 个字段的顺序」',
              '调整了' in ord_note and '顺序' in ord_note, ord_note)
        check('重排语句用的是设计态定义（varchar(100) NOT NULL），不是实库的旧定义',
              any('name' in one and 'varchar(100)' in one.lower() for one in ord_sql),
              str(ord_sql))

        hist = sc.compareitems({'compareId': cmp1['id'], 'pageSize': 200})
        check('历史对比记录回看时也能看到逐条明细（靠左右两侧 JSON 现算）',
              any(len(one.get('details') or []) for one in hist['list'])
              and all('diffLabel' in one for one in hist['list']),
              str([len(one.get('details') or []) for one in hist['list']][:5]))

        exp1 = sc.compareexport({'appId': app['id']})
        check('批量导出：多条对比记录合成一份脚本',
              exp1['count'] >= 2 and '第 1/' in exp1['text'] and exp1['statements'] >= 1,
              'count=%s statements=%s' % (exp1.get('count'), exp1.get('statements')))
        check('批量导出给出可直接落盘的文件名',
              exp1['fileName'].endswith('.sql') and exp1['fileName'].startswith('TESTSA'),
              exp1['fileName'])
        exp2 = sc.compareexport({'appId': app['id'], 'ids': cmp1['id']})
        check('按 ids 批量导出只取指定的那一条', exp2['count'] == 1, str(exp2['count']))
        expect_error('指定的对比记录都不存在时给出明确提示',
                     lambda: sc.compareexport({'appId': app['id'], 'ids': str(uuid.uuid4())}), '还没有')

        # ---------- 选连接对象 → 选数据库：上线前拿生产库比一次，生成部署升级脚本 ----------
        prod_db = 'tesa_scope_prod'
        db.execute('CREATE DATABASE IF NOT EXISTS `%s` DEFAULT CHARACTER SET utf8mb4' % prod_db)
        made.append(prod_db)
        db.execute('DROP TABLE IF EXISTS `%s`.`t_a`' % prod_db)
        db.execute('CREATE TABLE `%s`.`t_a` (`id` INT PRIMARY KEY, `zz` VARCHAR(20), '
                   '`aa` INT, `mm` DATE, `name` VARCHAR(20))' % prod_db)
        conn2_id = str(uuid.uuid4())
        db.execute('INSERT INTO `dbinfomgr` (`id`,`name`,`dbType`,`host`,`port`,`dbName`,`username`,'
                   '`password`,`enabled`,`ispub`) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,1,1)',
                   (conn2_id, MARK + '_prod_conn', 'mysql', conf['host'], conf['port'], prod_db,
                    conf['user'], connector.encrypt_secret(conf['password'])))
        conn3_id = str(uuid.uuid4())
        db.execute('INSERT INTO `dbinfomgr` (`id`,`name`,`dbType`,`dbName`,`username`,'
                   '`password`,`enabled`,`ispub`) VALUES (%s,%s,%s,%s,%s,%s,1,1)',
                   (conn3_id, MARK + '_sqlite_conn', 'sqlite', 'E:/data/tesa_scope.db', '', ''))
        try:
            conns = sc.compare_conns({'appId': app['id']})
            cand_ids = [one['id'] for one in conns['list']]
            check('对比可选连接里同时有「应用绑定」与「生产库」连接',
                  conn_id in cand_ids and conn2_id in cand_ids, str(cand_ids)[:200])
            check('标出哪个是应用绑定的连接（页面默认选它）',
                  conns['boundConnId'] == conn_id
                  and [one['id'] for one in conns['list'] if one['isBound']] == [conn_id],
                  str([(one['name'], one['isBound']) for one in conns['list']]))
            check('不同方言的连接不进候选（sqlite 与 mysql 比不出东西）',
                  conn3_id not in cand_ids, str(cand_ids)[:200])
            prod_item = next((one for one in conns['list'] if one['id'] == conn2_id), {})
            check('候选连接带回它的默认库（选中连接就能预选库）',
                  prod_item.get('defaultDb') == prod_db, str(prod_item)[:200])

            cmp_prod = sc.compare({'appId': app['id'], 'connId': conn2_id, 'dbName': prod_db,
                                   'designDb': a_db})
            check('用另一个连接（生产库）当实库能直接对比',
                  cmp_prod['connId'] == conn2_id and cmp_prod['dbName'] == prod_db
                  and cmp_prod['designDb'] == a_db,
                  str((cmp_prod.get('connId'), cmp_prod.get('dbName'), cmp_prod.get('designDb'))))
            check('对比记录里留下连接名（历史回看知道比的是哪台机器）',
                  cmp_prod['connName'] == MARK + '_prod_conn', str(cmp_prod.get('connName')))
            prod_items = [one for one in cmp_prod['items'] if one['objName'] == prod_db + '.t_a']
            check('库名映射后差异项用实库库名（脚本在生产库上执行）', len(prod_items) == 1,
                  str([one['objName'] for one in cmp_prod['items']])[:200])
            check('生产库缺的 memo 列被识别为待建（说明确实比的是生产库结构）',
                  any('memo' in (d.get('text') or '') for d in (prod_items[0].get('details') or [])),
                  str([d.get('text') for d in (prod_items[0].get('details') or [])])[:200])
            hist_prod = (sc.compares({'appId': app['id']})['list'] or [{}])[0]
            check('对比历史列表带回连接名与映射库（页面下拉能直接看出来）',
                  hist_prod.get('connName') == MARK + '_prod_conn'
                  and hist_prod.get('designDb') == a_db, str(hist_prod)[:220])
            up_prod = sc.compareupgrade({'compareId': cmp_prod['id']})
            check('升级脚本头部写明实库连接 + 目标库 + 库名映射',
                  MARK + '_prod_conn' in up_prod['text'] and prod_db in up_prod['text']
                  and ('设计态库【%s】对应实库库【%s】' % (a_db, prod_db)) in up_prod['text'],
                  up_prod['text'][:400])

            expect_error('库名不同且设计态有多个库时不猜，要求选「对应设计态库」',
                         lambda: sc.compare({'appId': app['id'], 'connId': conn2_id, 'dbName': prod_db}),
                         '没有同名库')
            expect_error('指定了不存在的设计态库时给出可选清单',
                         lambda: sc.compare({'appId': app['id'], 'connId': conn2_id, 'dbName': prod_db,
                                             'designDb': 'tesa_nope_design'}), '设计态里没有库')
            expect_error('指定了不存在的连接时明确报错（不悄悄退回绑定连接）',
                         lambda: sc.compare({'appId': app['id'], 'connId': str(uuid.uuid4()),
                                             'dbName': prod_db}), '连接不存在')
        finally:
            for cid in (conn2_id, conn3_id):
                try:
                    db.execute('DELETE FROM `dbinfomgr` WHERE `id`=%s', (cid,))
                except Exception:                # noqa: BLE001
                    pass
    finally:
        if app:
            try:
                svc.delete({'id': app['id']})
            except Exception:                    # noqa: BLE001
                pass
        if conn_id:
            try:
                db.execute('DELETE FROM `dbinfomgr` WHERE `id`=%s', (conn_id,))
            except Exception:                    # noqa: BLE001
                pass
        for one in made:
            try:
                db.execute('DROP DATABASE IF EXISTS `%s`' % one)
            except Exception:                    # noqa: BLE001
                pass


# ---------------------------------------------------------------- 7. 菜单与按钮
def test_menu_and_buttons():
    print('\n--- 7. 菜单与页面按钮（收录一致 + 管理员授权） ---')
    menus = db.query_all('SELECT `id`,`code`,`path`,`enabled` FROM `menuinfros` '
                         'WHERE `code` IN (%s,%s) ORDER BY `code`', ('MNU00029', 'MNU00030'))
    check('两个菜单项已登记（应用信息 / 应用结构）', len(menus) == 2
          and [one['path'] for one in menus] == ['appinfo.html', 'appschema.html'],
          str([one['path'] for one in menus]))
    bound = db.query_one("SELECT COUNT(*) AS `n` FROM `menugroupitemset` s "
                         "JOIN `menugroupinfos` g ON g.`id`=s.`groupId` "
                         "WHERE g.`code`='MNG1005' AND s.`itemId` IN (%s,%s)", (menus[0]['id'], menus[1]['id']))
    check('两个菜单已挂到「数据中心」（MNG1005）', int(bound['n']) == 2, str(bound['n']))

    for page, expect_min in (('appinfo.html', 7), ('appschema.html', 22)):
        scanned = page_scan.scan_page(os.path.join(WEB_ROOT, page), page)
        stored = db.query_all('SELECT `btnId` FROM `pageopbtn` WHERE `pagePath`=%s', (page,)) or []
        s_ids = sorted(one['btnId'] for one in scanned)
        d_ids = sorted(str(one['btnId']) for one in stored)
        check('%s 的按钮已被 pageopbtn 收录（%d 个）' % (page, len(s_ids)),
              len(s_ids) >= expect_min and s_ids == d_ids,
              '扫描 %d / 库 %d：差集 %s' % (len(s_ids), len(d_ids),
                                          str(set(s_ids) ^ set(d_ids))[:160]))

    admin = db.query_one("SELECT `id` FROM `usergroup` WHERE `nameEn`='SystemAdmin' LIMIT 1")
    granted = db.query_one("SELECT COUNT(*) AS `n` FROM `usergrouppagebtnset` s "
                           "JOIN `pageopbtn` b ON b.`id`=s.`pageOpBtnId` "
                           "WHERE s.`roleId`=%s AND s.`enabled`=1 "
                           "AND b.`pagePath` IN ('appinfo.html','appschema.html')", (admin['id'],))
    total = db.query_one("SELECT COUNT(*) AS `n` FROM `pageopbtn` "
                         "WHERE `pagePath` IN ('appinfo.html','appschema.html')")
    check('系统管理员已获两页全部按钮授权（否则 btnperm 会把工具栏隐藏）',
          int(granted['n']) == int(total['n']) and int(total['n']) >= 29,
          '授权 %s / 登记 %s' % (granted['n'], total['n']))

    # 导航：管理员「数据中心」组里能直接点进这两页
    tok = db.query_one("SELECT `token` FROM `useinfo` WHERE `token` IS NOT NULL AND `token`<>'' "
                       "AND `tokenExpireTime`>NOW() LIMIT 1")
    if tok:
        nav = service.build_nav({'token': tok['token'], 'roleId': admin['id']})
        paths = []
        for grp in nav.get('groups') or []:
            for it in grp.get('items') or []:
                paths.append(str(it.get('path') or ''))
        check('管理员导航里出现「应用信息 / 应用结构」',
              'appinfo.html' in paths and 'appschema.html' in paths,
              str([one for one in paths if one.endswith('.html')][:12]))
        # 请求头传 token 的场景：require_login 写 `_token`，导航也要认（与其它接口一致）
        nav2 = service.build_nav({'_token': tok['token'], 'roleId': admin['id']})
        check('导航也认请求头传来的 token（_token）',
              bool(nav2.get('groups')) and len(nav2.get('groups') or []) == len(nav.get('groups') or []))
    else:
        check('库里没有有效 token，跳过导航用例', True)


# ---------------------------------------------------------------- main
def main():
    print('=' * 70)
    print('数据中心 · 应用架构后端验证（应用信息 / 应用结构 / 版本脚本 / 对比）')
    print('=' * 70)
    cleanup()
    try:
        app = test_appinfo()
        db_id, obj_id = test_structure(app)
        test_versions(app, obj_id)
        test_dialects()
        test_import(app)
        test_compare(app)
        test_compare_view_ddl()
        test_lineage(app)
        test_scan_scope()
        test_menu_and_buttons()
    finally:
        cleanup()
        left = count('appinfos', '`code` LIKE %s', (MARK + '%',))
        print('\n清理：残留自测应用 %d 条' % left)
    print('\n结果：通过 %d 项，失败 %d 项' % (PASS, FAIL))
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
