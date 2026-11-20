# -*- coding: utf-8 -*-
"""
在线状态注册表（im_presence）纯单元验证：不连数据库、不依赖 Web 服务。
重点验证：
  · 单设备 / 多设备在线注册与去重（同 emp_id 多连接只算一个在线）
  · 多标签页场景下「全部断开才算离线」
  · push_to 入队到该 emp 的每条连接；broadcast 广播到所有在线连接（可排除自己）
  · unregister 后在线态正确回落
  · dumps 中文不转义、enqueue 幂等
用法：python server/test_im_presence.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from im_presence import presence, Conn, dumps, enqueue, HEARTBEAT  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, extra))


def fake_ws():
    """Conn 只持有 ws 引用，不在单测里真正 send，用一个空壳即可"""
    class _WS(object):
        def send(self, *a, **k):
            return True
    return _WS()


def drain(conn):
    out = []
    while not conn.out_q.empty():
        out.append(conn.out_q.get_nowait())
    return out


def main():
    # 每次运行前清空全局注册表，避免被其它进程污染
    presence._conns.clear()

    print('--- 1. 在线注册 / 去重 / 查询 ---')
    c1 = Conn(fake_ws(), 1)
    presence.register(1, c1)
    check('注册后 emp=1 在线', presence.is_online(1))
    check('在线人数=1', presence.online_count() == 1, str(presence.online_count()))
    check('在线 emp 列表含 1', 1 in presence.online_emp_ids())

    c1b = Conn(fake_ws(), 1)          # 同员工第二个标签页
    presence.register(1, c1b)
    check('同 emp 多连接仍只算 1 个在线', presence.online_count() == 1,
          str(presence.online_count()))
    check('online_emp_ids 仍是 [1]', presence.online_emp_ids() == [1],
          str(presence.online_emp_ids()))

    c2 = Conn(fake_ws(), 2)
    presence.register(2, c2)
    check('emp=2 上线后在线人数=2', presence.online_count() == 2,
          str(presence.online_count()))
    check('两个 emp 都在线', presence.is_online(1) and presence.is_online(2))

    print('--- 2. push_to 入队到该 emp 的每条连接 ---')
    presence.push_to(1, 'msg-for-1')
    check('emp=1 的两条连接都收到消息',
          drain(c1) == ['msg-for-1'] and drain(c1b) == ['msg-for-1'],
          'c1=%s c1b=%s' % (drain(c1), drain(c1b)))
    check('emp=2 的连接未收到 emp=1 的消息', drain(c2) == [])

    print('--- 3. broadcast 广播（含排除自己） ---')
    presence.broadcast('hello-all')
    check('广播到 emp=1 的两条连接', drain(c1) == ['hello-all'] and drain(c1b) == ['hello-all'])
    check('广播到 emp=2', drain(c2) == ['hello-all'])

    presence.broadcast('exclude-2', exclude_emp_id=2)
    check('排除 emp=2 后，emp=1 收到', drain(c1) == ['exclude-2'] and drain(c1b) == ['exclude-2'])
    check('排除 emp=2 后，emp=2 未收到', drain(c2) == [])

    print('--- 4. 多标签页：全部断开才算离线 ---')
    presence.unregister(1, c1)        # 先关一个标签页
    check('还剩一个标签页时仍在线', presence.is_online(1))
    presence.unregister(1, c1b)       # 第二个也关了
    check('两个标签页都关 → 离线', not presence.is_online(1))
    check('在线人数回落到 1', presence.online_count() == 1, str(presence.online_count()))
    check('断线后不再收到推送',
          (presence.push_to(1, 'x'), drain(c1) == [] and drain(c1b) == []))

    print('--- 5. enqueue / dumps 工具 ---')
    check('enqueue 成功入队', enqueue(c2, {'type': 'pong'}) and drain(c2) == ['{"type":"pong"}'])
    check('dumps 中文不过滤',
          dumps({'name': '张三'}) == '{"name":"张三"}', dumps({'name': '张三'}))
    check('HEARTBEAT 为合理秒数', isinstance(HEARTBEAT, int) and 1 <= HEARTBEAT <= 60,
          str(HEARTBEAT))

    print('\n结果：通过 %d 项，失败 %d 项' % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
