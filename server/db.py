# -*- coding: utf-8 -*-
"""数据库访问层：基于 PyMySQL 的轻量封装（参数化查询，防 SQL 注入）"""
import datetime
import pymysql
from config import DB_CONFIG


class DuplicateError(Exception):
    """唯一索引冲突（MySQL 1062）"""


def _connect():
    return pymysql.connect(cursorclass=pymysql.cursors.DictCursor, **DB_CONFIG)


def query_all(sql, args=None):
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, args or ())
            return cur.fetchall()
    finally:
        conn.close()


def query_one(sql, args=None):
    rows = query_all(sql, args)
    return rows[0] if rows else None


def execute(sql, args=None):
    """执行写操作，返回 (lastrowid, rowcount)；唯一键冲突抛 DuplicateError"""
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, args or ())
            return cur.lastrowid, cur.rowcount
    except pymysql.err.IntegrityError as e:
        if e.args and e.args[0] == 1062:
            raise DuplicateError(str(e.args[1] if len(e.args) > 1 else e))
        raise
    finally:
        conn.close()


def transaction(fn):
    """
    在一个事务里执行 fn(cursor)，成功提交、异常回滚。

    用于「全量替换」这类多语句写入（例如角色权限保存：先删后插），
    避免中途失败留下半套数据。
    """
    conn = _connect()
    try:
        conn.begin()
        with conn.cursor() as cur:
            result = fn(cur)
        conn.commit()
        return result
    except pymysql.err.IntegrityError as e:
        conn.rollback()
        if e.args and e.args[0] == 1062:
            raise DuplicateError(str(e.args[1] if len(e.args) > 1 else e))
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def dump_row(row):
    """把数据库行转成前端可直接使用的 JSON 对象：布尔化 + 时间格式化"""
    if not row:
        return None
    out = {}
    for key, value in row.items():
        if isinstance(value, (datetime.datetime, datetime.date)):
            out[key] = value.strftime('%Y-%m-%d %H:%M:%S')
        elif isinstance(value, (bytes, bytearray)):
            out[key] = value.decode('utf-8', 'ignore')
        else:
            out[key] = value
    return out
