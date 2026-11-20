# -*- coding: utf-8 -*-
"""
connector 纯函数自测（不需要任何数据库）
====================================================================
覆盖多方言的「占位符 / 参数绑定 / 过滤条件 / 分页 SQL」——这些拼错一个字符，
只有真连上那家数据库才会炸，所以单独用单测兜住：

    python tools/connector-test.py

重点：
  · Oracle 用 python-oracledb 的数字位置绑定 `:1 :2 …`（不是 %s），且字面量里的 % 不能再双写；
  · SQLite 用 ?，MySQL / PostgreSQL / SQL Server 用 %s 且字面量 % 要双写成 %%。
"""
from __future__ import print_function

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'server'))

import connector  # noqa: E402

passed = 0
failed = 0


def check(name, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  [PASS] ' + name)
    else:
        failed += 1
        print('  [FAIL] ' + name + ('  → ' + str(extra) if extra != '' else ''))


def test_placeholder():
    print('\n--- 1. 占位符按方言 ---')
    check('SQLite 用 ?', connector._placeholder('sqlite') == '?', connector._placeholder('sqlite'))
    check('MySQL 用 %s', connector._placeholder('mysql') == '%s', connector._placeholder('mysql'))
    check('Oracle 用 :1', connector._placeholder('oracle', 1) == ':1',
          connector._placeholder('oracle', 1))
    check('Oracle 第 3 个值用 :3', connector._placeholder('oracle', 3) == ':3',
          connector._placeholder('oracle', 3))
    check('Oracle 不传序号也不报错', connector._placeholder('oracle') == ':1',
          connector._placeholder('oracle'))


def test_bind():
    print('\n--- 2. :参数名 → 方言占位符 ---')
    sql = 'SELECT * FROM t WHERE a = :x AND c > :x'
    out, args = connector.bind_params(sql, {'x': 7}, 'oracle')
    check('Oracle：同名参数出现两次 → :1 :2（各自绑定）',
          out == 'SELECT * FROM t WHERE a = :1 AND c > :2' and args == [7, 7],
          '%s / %s' % (out, args))

    out, args = connector.bind_params("SELECT * FROM t WHERE a = :x AND b = :y", {'x': 1, 'y': 2},
                                      'oracle')
    check('Oracle：两个不同参数按顺序编号', out.endswith('a = :1 AND b = :2') and args == [1, 2],
          '%s / %s' % (out, args))

    out, args = connector.bind_params('SELECT :x FROM dual', {'x': 1}, 'oracle')
    check('Oracle：占位符在 SELECT 列表里也正确', out == 'SELECT :1 FROM dual', out)

    # 引号内的参数（LIKE '%:name%'）：拆成 CONCAT，值仍然绑定
    out, args = connector.bind_params("SELECT * FROM t WHERE b LIKE '%:y%'", {'y': '张'}, 'oracle')
    check('Oracle：LIKE 里的参数走 CONCAT 且编号连续',
          ':1' in out and 'CONCAT' in out and args == ['张'], '%s / %s' % (out, args))

    # 字面量里的 % 不能双写（Oracle 不做 % 格式化）
    out, args = connector.bind_params("SELECT * FROM t WHERE d LIKE '100%' AND a = :x", {'x': 1},
                                      'oracle')
    check('Oracle：字面量里的 % 原样保留（不双写）',
          "'100%'" in out and '%%' not in out, out)

    # 其它方言保持原样（PyMySQL 会把 % 双写）
    out, args = connector.bind_params("SELECT * FROM t WHERE d LIKE '100%' AND a = :x", {'x': 1},
                                      'mysql')
    check('MySQL：占位符还是 %s，字面量 % 双写',
          'a = %s' in out and "'100%%'" in out and args == [1], out)
    out, args = connector.bind_params('SELECT * FROM t WHERE a = :x', {'x': 1}, 'sqlite')
    check('SQLite：占位符是 ?', 'a = ?' in out and args == [1], out)

    try:
        connector.bind_params('SELECT * FROM t WHERE a = :nope', {}, 'oracle')
        check('未定义的参数应报错', False)
    except connector.ConnError as exc:
        check('未定义的参数给出提示', '没有定义' in exc.message, exc.message[:60])


def test_filters_and_page():
    print('\n--- 3. 数据浏览：过滤条件与分页 ---')
    filters = [{'column': 'name', 'op': 'contains', 'value': '张'},
               {'column': 'age', 'op': 'ge', 'value': '20'},
               {'column': 'memo', 'op': 'null'}]
    where, args = connector._filters_sql(filters, 'oracle')
    check('Oracle：过滤条件按 :1 :2 编号',
          where == ' WHERE "name" LIKE :1 AND "age" >= :2 AND "memo" IS NULL' and
          args == ['%张%', '20'], '%s / %s' % (where, args))
    where2, args2 = connector._filters_sql(filters, 'mysql')
    check('MySQL：过滤条件仍是 %s（值不变）',
          where2.count('%s') == 2 and args2 == ['%张%', '20'], '%s / %s' % (where2, args2))

    sql, page_args = connector._page_sql('oracle', '"EMP"', where, ' ORDER BY "ID"', 50, 100, args)
    check('Oracle：分页接着 WHERE 的编号排（:3 :4）',
          sql.endswith('OFFSET :3 ROWS FETCH NEXT :4 ROWS ONLY') and
          page_args == ['%张%', '20', 100, 50], '%s / %s' % (sql, page_args))

    sql, page_args = connector._page_sql('mysql', '`emp`', where2, '', 50, 100, args2)
    check('MySQL：LIMIT %s OFFSET %s', sql.endswith('LIMIT %s OFFSET %s') and
          page_args == ['%张%', '20', 50, 100], '%s / %s' % (sql, page_args))

    sql, page_args = connector._page_sql('sqlite', '"emp"', '', '', 50, 100, [])
    check('SQLite：LIMIT ? OFFSET ? 且先 size 后 offset',
          sql.endswith('LIMIT ? OFFSET ?') and page_args == [50, 100], '%s / %s' % (sql, page_args))

    sql, page_args = connector._page_sql('sqlserver', '[emp]', '', '', 50, 100, [])
    check('SQL Server：OFFSET 必须有 ORDER BY（没给就补一个空的）',
          'ORDER BY (SELECT NULL)' in sql and 'OFFSET %s ROWS FETCH NEXT %s ROWS ONLY' in sql,
          sql)

    # 2005 / 2008 没有 OFFSET … FETCH（会报 102 Incorrect syntax near 'OFFSET'）→ 走 ROW_NUMBER
    sql, page_args = connector._page_sql('sqlserver', '[emp]', where2, ' ORDER BY [id] ASC', 50, 100,
                                         args2, mssql_mode='rank')
    check('SQL Server 老版本：改用 ROW_NUMBER() 包一层取区间（不再出现 OFFSET / FETCH）',
          'ROW_NUMBER() OVER (ORDER BY [id] ASC) AS __rn' in sql and
          'WHERE __rn > %s AND __rn <= %s' in sql and 'FETCH NEXT' not in sql, sql)
    check('SQL Server 老版本：参数顺序是 WHERE 值 → 起止行号（offset, offset+size）',
          page_args == ['%张%', '20', 100, 150], str(page_args))
    sql, page_args = connector._page_sql('sqlserver', '[emp]', '', '', 50, 0, [], mssql_mode='rank')
    check('SQL Server 老版本：没给排序时 OVER 里补 (SELECT NULL)',
          'ROW_NUMBER() OVER (ORDER BY (SELECT NULL))' in sql and page_args == [0, 50], sql)


def test_oracle_connect_guard():
    print('\n--- 4. Oracle 连接：驱动与参数校验 ---')
    try:
        import oracledb  # noqa: F401
        check('已安装 oracledb 驱动', True)
    except ImportError:
        check('已安装 oracledb 驱动', False, 'pip install oracledb')

    try:
        connector._oracle_connect({'dbType': 'oracle', 'host': '127.0.0.1', 'port': 1521,
                                   'dbName': '', 'username': 'x', 'password': 'y'})
        check('数据库名为空时给出明确提示', False)
    except connector.ConnError as exc:
        check('数据库名为空时给出明确提示',
              '数据库名' in exc.message and 'SID' in exc.message, exc.message[:80])

    try:
        connector._oracle_connect({'dbType': 'oracle', 'host': '127.0.0.1', 'port': 1,
                                   'dbName': 'ORCL', 'username': 'x', 'password': 'y'})
        check('连不上时抛的是「连接失败」而不是「未安装驱动」', False)
    except connector.ConnError as exc:
        check('连不上时抛的是「连接失败」而不是「未安装驱动」',
              '连接 Oracle 失败' in exc.message and '未安装' not in exc.message,
              exc.message[:90])
    except Exception as exc:                       # 驱动自身的异常没被包住也算失败
        check('连不上时抛的是「连接失败」而不是「未安装驱动」', False, repr(exc)[:80])


def test_mssql():
    print('\n--- 5. SQL Server（pymssql）：驱动 / 加密兜底 / 报错翻译 ---')
    try:
        import pymssql  # noqa: F401
        check('已安装 pymssql 驱动', True, '')
    except ImportError:
        check('已安装 pymssql 驱动', False, 'pip install pymssql')

    class FakeMssql(object):
        """假的 pymssql 模块：记录连接参数，按预设抛错"""
        def __init__(self, errors):
            self.calls = []
            self.errors = list(errors)

        def connect(self, **kwargs):
            self.calls.append(kwargs)
            if self.errors:
                err = self.errors.pop(0)
                if err:
                    raise err
            return 'CONN'

    base_conf = {'dbType': 'sqlserver', 'host': '10.0.0.9', 'port': 1433,
                 'dbName': 'demo', 'username': 'sa', 'password': 'p@ss'}

    original_import = connector._import
    try:
        # ① 一次就成功：不应该自己乱加 encryption
        fake = FakeMssql([])
        connector._import = lambda *a, **k: fake
        conn = connector._mssql_connect(base_conf)
        check('正常连接：只连一次且成功', conn == 'CONN' and len(fake.calls) == 1,
              str(len(fake.calls)))
        check('连接参数带上主机 / 端口 / 库 / 登录超时',
              fake.calls[0]['server'] == '10.0.0.9' and fake.calls[0]['port'] == '1433' and
              fake.calls[0]['database'] == 'demo' and
              fake.calls[0]['login_timeout'] == connector.config.DBINFO_TIMEOUT,
              str(fake.calls[0]))
        check('没指定 encryption 时不硬塞（交给驱动默认行为）',
              'encryption' not in fake.calls[0], str(fake.calls[0].get('encryption')))

        # ② 老服务器的 TLS 握手失败（20002）→ 自动关掉加密重试
        fake = FakeMssql([Exception('(20002, b"DB-Lib error message 20002: TDS server connection failed")')])
        connector._import = lambda *a, **k: fake
        conn = connector._mssql_connect(base_conf)
        check('TDS 握手失败（20002）时自动降级为不加密再连一次',
              conn == 'CONN' and len(fake.calls) == 2 and fake.calls[1].get('encryption') == 'off',
              '%d 次 / %s' % (len(fake.calls), fake.calls[-1].get('encryption')))
        check('重试时其余参数保持不变',
              fake.calls[1]['server'] == '10.0.0.9' and fake.calls[1]['database'] == 'demo', '')

        # ③ 密码错（18456）→ 中文提示，且不再重试
        fake = FakeMssql([Exception("(18456, b\"Login failed for user 'sa'\")")])
        connector._import = lambda *a, **k: fake
        try:
            connector._mssql_connect(base_conf)
            check('登录失败翻译成中文提示', False)
        except connector.ConnError as exc:
            check('登录失败翻译成中文提示',
                  '登录失败' in exc.message and '18456' not in exc.message, exc.message[:80])
            check('登录失败不重试（只连一次）', len(fake.calls) == 1, str(len(fake.calls)))

        # ④ 打不开库（4060）→ 提示库名
        fake = FakeMssql([Exception('(4060, b"Cannot open database \\"demo\\" requested by the login")')])
        connector._import = lambda *a, **k: fake
        try:
            connector._mssql_connect(base_conf)
            check('打不开库时提示库名', False)
        except connector.ConnError as exc:
            check('打不开库时提示库名', 'demo' in exc.message, exc.message[:80])

        # ⑤ extraParams 手工指定 tds_version / encryption；charset 不认识就退回 UTF-8
        fake = FakeMssql([])
        connector._import = lambda *a, **k: fake
        connector._mssql_connect(dict(base_conf, charset='utf8mb4',
                                      extraParams='tds_version=7.3&encryption=require'))
        check('extraParams 可指定 tds_version / encryption',
              fake.calls[0].get('tds_version') == '7.3' and
              fake.calls[0].get('encryption') == 'require', str(fake.calls[0]))
        check('MySQL 那套 utf8mb4 不会传给 pymssql（退回 UTF-8）',
              fake.calls[0].get('charset') == 'UTF-8', str(fake.calls[0].get('charset')))
    finally:
        connector._import = original_import


def test_mssql_rows_page():
    print('\n--- 6. SQL Server 数据浏览：老版本 / 兼容级别低时自动降级分页 ---')

    class FakeCursor(object):
        def __init__(self, version, reject_offset, log):
            self.version = version
            self.reject_offset = reject_offset
            self.log = log
            self.description = []
            self._rows = []
            self.page_args = None

        def execute(self, sql, args=None):
            self.log.append(sql)
            text = sql.upper()
            if 'SERVERPROPERTY' in text:
                self._rows = [(self.version,)]
                self.description = [('ProductVersion',)]
                return
            if 'COUNT(*)' in text:
                self._rows = [(3,)]
                self.description = [('c',)]
                return
            if 'ROW_NUMBER' not in text and 'OFFSET' in text:
                if self.reject_offset:
                    raise Exception('(102, b"Incorrect syntax near \'OFFSET\'.")')
                self._rows = [('旧写法',)]
                self.description = [('col',)]
                return
            # ROW_NUMBER 老写法：第一列是排位辅助列 __rn
            self.page_args = args
            self._rows = [(1, 'a'), (2, 'b')]
            self.description = [('__rn',), ('id',)]

        def fetchone(self):
            return self._rows[0] if self._rows else None

        def fetchmany(self, size):
            return self._rows[:size]

        def close(self):
            pass

    class FakeConn(object):
        def __init__(self, version, reject_offset, log):
            self.cur = FakeCursor(version, reject_offset, log)

        def cursor(self):
            return self.cur

        def rollback(self):
            pass

        def close(self):
            pass

    conf = {'dbType': 'sqlserver', 'host': '10.0.0.9', 'port': 1433, 'dbName': 'demo'}
    original_open = connector._open_conn
    connector._MSSQL_PAGE_MODES.clear()
    try:
        # ① 2008（10.50）：一开始就该用 ROW_NUMBER，连 OFFSET 都不尝试
        log = []
        conn1 = FakeConn('10.50.6000.0', False, log)
        connector._open_conn = lambda c, d: (conn1, 'sqlserver', 'demo')
        data = connector.rows(conf, 'demo', 'emp', 2, 50)
        check('2008（10.50）分页不写 OFFSET（避免 102 语法错误）',
              not any('FETCH NEXT' in one.upper() for one in log) and
              any('ROW_NUMBER' in one.upper() for one in log), str([one[:40] for one in log]))
        check('ROW_NUMBER 按「offset → offset+size」取区间（第 2 页 50 条 = 51~100 行）',
              any('WHERE __rn > %s AND __rn <= %s' in one for one in log) and
              conn1.cur.page_args == [50, 100], str(conn1.cur.page_args))
        check('辅助列 __rn 不会出现在返回的列里', data['columns'] == ['id'], str(data['columns']))
        check('辅助列 __rn 也不会出现在每一行里', data['rows'] == [['a'], ['b']], str(data['rows']))
        check('总行数 / 分页信息照常', data['total'] == 3 and data['pageNum'] == 2, str(data['total']))

        # ② 服务器 2012+，但库的兼容级别还停在 2008：OFFSET 仍报 102 → 自动换老写法重试
        connector._MSSQL_PAGE_MODES.clear()
        log = []
        connector._open_conn = lambda c, d: (FakeConn('13.0.5026.0', True, log), 'sqlserver', 'demo')
        data = connector.rows(conf, 'demo', 'emp', 1, 50)
        check('兼容级别低的库：OFFSET 报错后自动用 ROW_NUMBER 重试并成功',
              data['columns'] == ['id'] and data['rows'] == [['a'], ['b']], str(data['rows']))
        check('重试时确实先试过新写法（日志里有 OFFSET，也有 ROW_NUMBER）',
              any('FETCH NEXT' in one.upper() for one in log) and
              any('ROW_NUMBER' in one.upper() for one in log), '')
        check('把「这个库要用老写法」记进缓存',
              connector._MSSQL_PAGE_MODES.get('10.0.0.9:1433/demo') == 'rank',
              str(connector._MSSQL_PAGE_MODES))

        # ③ 同一个库再翻页：直接用老写法，不再先失败一次
        log = []
        connector._open_conn = lambda c, d: (FakeConn('13.0.5026.0', True, log), 'sqlserver', 'demo')
        connector.rows(conf, 'demo', 'emp', 2, 50)
        check('同一库再翻页直接用老写法（不再重复踩 OFFSET）',
              not any('FETCH NEXT' in one.upper() for one in log) and
              any('ROW_NUMBER' in one.upper() for one in log), str([one[:40] for one in log]))

        # ④ 换库名要重新探测（不同库的兼容级别可能不同）
        log = []
        connector._open_conn = lambda c, d: (FakeConn('13.0.5026.0', False, log), 'sqlserver', 'other')
        connector.rows(dict(conf, dbName='other'), 'other', 'emp', 1, 50)
        check('换了库名会重新按版本判断（不串用上一个库的缓存）',
              any('SERVERPROPERTY' in one.upper() for one in log) and
              any('FETCH NEXT' in one.upper() for one in log), str([one[:30] for one in log]))
    finally:
        connector._open_conn = original_open
        connector._MSSQL_PAGE_MODES.clear()


def test_mssql_charset():
    print('\n--- 7. SQL Server 中文字符集：varchar 乱码还原 / nvarchar 不受影响 ---')
    # 客户端字符集：默认 UTF-8（CP936 会让 nvarchar 里的 emoji 直接抛异常，不能默认切）
    check('不填字符集 → 客户端用 UTF-8', connector._mssql_charset({}) == 'UTF-8',
          connector._mssql_charset({}))
    check('填 CP936 按用户指定的来', connector._mssql_charset({'charset': 'cp936'}) == 'CP936',
          connector._mssql_charset({'charset': 'cp936'}))
    check('填 GBK 也认', connector._mssql_charset({'charset': 'GBK'}) == 'GBK',
          connector._mssql_charset({'charset': 'GBK'}))
    check('MySQL 那套 utf8mb4 不认识 → 退回 UTF-8',
          connector._mssql_charset({'charset': 'utf8mb4'}) == 'UTF-8',
          connector._mssql_charset({'charset': 'utf8mb4'}))

    fix = connector._mssql_fix_text
    # FreeTDS 把 GBK 字节当 ISO-8859-1 的典型产物
    check('「ÐìêÝÁú」还原成「徐贻龙」', fix(u'ÐìêÝÁú') == u'徐贻龙', fix(u'ÐìêÝÁú'))
    check('「ÖÐÎÄ²âÊÔ」还原成「中文测试」', fix(u'ÖÐÎÄ²âÊÔ') == u'中文测试', fix(u'ÖÐÎÄ²âÊÔ'))
    check('单字「ÊÕ」还原成「收」', fix(u'ÊÕ') == u'收', fix(u'ÊÕ'))
    check('「ÊÕ·Ñ」还原成「收费」', fix(u'ÊÕ·Ñ') == u'收费', fix(u'ÊÕ·Ñ'))
    check('中英混排「ABCÖÐÎÄ」还原成「ABC中文」', fix(u'ABCÖÐÎÄ') == u'ABC中文', fix(u'ABCÖÐÎÄ'))
    check('已经正常的中文不动', fix(u'中文正常') == u'中文正常', fix(u'中文正常'))
    check('纯 ASCII 不动', fix(u'normal ASCII') == u'normal ASCII', fix(u'normal ASCII'))
    check('西欧文本不被改坏（Müller）', fix(u'Müller') == u'Müller', fix(u'Müller'))
    check('西欧文本不被改坏（café）', fix(u'café') == u'café', fix(u'café'))
    check('空值 / None / 非字符串原样返回',
          fix('') == '' and fix(None) is None and fix(3) == 3, '')

    # _jsonable：只有 mssql=True 才还原，别的库（MySQL 等）行为不变
    check('_jsonable(mssql=True) 还原乱码',
          connector._jsonable(u'ÐìêÝÁú', True) == u'徐贻龙', connector._jsonable(u'ÐìêÝÁú', True))
    check('_jsonable() 默认不还原（不影响 MySQL / Oracle 等）',
          connector._jsonable(u'ÐìêÝÁú') == u'ÐìêÝÁú', connector._jsonable(u'ÐìêÝÁú'))
    check('bytes 在 mssql 下先用 UTF-8、再用 GBK 兜底',
          connector._jsonable(b'\xd0\xec\xea\xdd\xc1\xfa', True) == u'徐贻龙',
          connector._jsonable(b'\xd0\xec\xea\xdd\xc1\xfa', True))
    check('bytes 在别的库下仍只按 UTF-8（二进制保留 0x 前缀）',
          connector._jsonable(b'\xd0\xec\xea\xdd\xc1\xfa').startswith('0x'),
          connector._jsonable(b'\xd0\xec\xea\xdd\xc1\xfa'))


def main():
    test_placeholder()
    test_bind()
    test_filters_and_page()
    test_oracle_connect_guard()
    test_mssql()
    test_mssql_rows_page()
    test_mssql_charset()
    print('\n结果：通过 %d 项，失败 %d 项' % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
