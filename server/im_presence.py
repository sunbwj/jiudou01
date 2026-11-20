# -*- coding: utf-8 -*-
"""
站内消息 · WebSocket 在线状态注册表（IM 实时性基础）

设计要点：
  · 全局唯一的内存注册表：emp_id -> [Conn, ...]（一个员工可能开了多个标签页/设备，
    每个连接一个 Conn；只有该员工所有连接都断开才算「离线」）。
  · 每个 Conn 持有一个出站队列 out_q（queue.Queue，线程安全）：
      - 其它线程（其它连接的 handler、WS 推送逻辑）只往 out_q 里「放」消息，绝不直接调用 ws.send；
      - 只有该连接自己的主循环（receive → drain out_q → ws.send）才会真正把消息写出。
    这样彻底避开「多线程同时在同一 socket 上 send/receive」的并发坑
    （simple_websocket 的 ws 对象不是线程安全的）。
  · 主循环用 receive(timeout=HEARTBEAT) 阻塞，超时后醒来先 drain 出站队列、再发心跳，
    因此离线消息写入 out_q 后，最迟 HEARTBEAT 秒（默认 3s）内就能被对方收到。
  · 所有对注册表的读写都加锁，WS handler 各自跑在独立线程（app.run(threaded=True)），
    数据库访问走 db.py（每次调用独立连接），互不干扰。

WS 协议（JSON，字段 type 区分）：
  客户端 → 服务端：
    {type:'hello', token}        鉴权握手（也可把 token 放 ?token= 查询参数）
    {type:'send', to, content}   发消息给某员工（content 为纯文本）
    {type:'read', peerId}        把与某员工的对话标记为已读，并通知对方
    {type:'typing', to, on}      输入中提示（on=true/false）
    {type:'ping'}                心跳
  服务端 → 客户端：
    {type:'authFail', message}   鉴权失败（随后关闭连接）
    {type:'serverHello', me, contacts}   握手成功：本人信息 + 联系人快照（含在线态/未读/最近消息）
    {type:'presence', empId, online:true}    某人上线
    {type:'offline',  empId, online:false}  某人下线
    {type:'msg', id, senderId, receiverId, content, sendTime, title}  新消息（推给收件人在线连接）
    {type:'ack', id, senderId, receiverId, content, sendTime, title, tempId}
                                  发送回执（推给发件人，tempId 用于前端乐观消息对齐）
    {type:'read', peerId}        已读回执（通知发件人：对方已读你的消息）
    {type:'typing', from, on}    对方正在输入
    {type:'pong'}                心跳回应
"""
import json
import queue
import threading

# 主循环阻塞时长（秒）：到点醒来 drain 出站队列 + 心跳；离线消息最迟此时长内送达
HEARTBEAT = 3
# 服务端→客户端 心跳间隔（秒）：仅用于把空闲连接保持活跃，避免代理层超时断开
SERVER_PING_INTERVAL = 25


class Conn(object):
    """一条 WS 连接：绑定员工 ID、底层 ws 对象、以及一条线程安全的出站队列"""

    __slots__ = ('ws', 'emp_id', 'out_q', 'alive', 'last_active')

    def __init__(self, ws, emp_id):
        self.ws = ws                  # simple_websocket.Server 实例
        self.emp_id = emp_id
        self.out_q = queue.Queue()    # 待发消息（JSON 字符串），由本连接主循环消费
        self.alive = True
        self.last_active = threading.get_ident()


class Presence(object):
    """全局在线状态注册表（线程安全单例）"""

    def __init__(self):
        self._lock = threading.RLock()
        self._conns = {}   # emp_id -> [Conn, ...]

    # ---------------- 连接注册 / 注销 ----------------
    def register(self, emp_id, conn):
        with self._lock:
            self._conns.setdefault(emp_id, []).append(conn)

    def unregister(self, emp_id, conn):
        with self._lock:
            lst = self._conns.get(emp_id)
            if not lst:
                return
            if conn in lst:
                lst.remove(conn)
            if not lst:
                self._conns.pop(emp_id, None)
            conn.alive = False

    # ---------------- 在线状态查询 ----------------
    def is_online(self, emp_id):
        with self._lock:
            return bool(self._conns.get(emp_id))

    def online_count(self):
        with self._lock:
            return len(self._conns)

    def online_emp_ids(self):
        with self._lock:
            return list(self._conns.keys())

    # ---------------- 消息投递（只入队，不直发） ----------------
    def _targets(self, emp_id, exclude_conn=None):
        with self._lock:
            conns = list(self._conns.get(emp_id, []))
        if exclude_conn is not None:
            conns = [c for c in conns if c is not exclude_conn]
        return conns

    def push_to(self, emp_id, payload):
        """把一条消息推给某员工的全部在线连接（payload 为已序列化 JSON 字符串）"""
        for c in self._targets(emp_id):
            try:
                c.out_q.put(payload)
            except Exception:
                pass

    def broadcast(self, payload, exclude_emp_id=None):
        """把一条消息广播给所有在线连接（可排除某人自己）"""
        with self._lock:
            conns = [c for lst in self._conns.values() for c in lst]
        if exclude_emp_id is not None:
            conns = [c for c in conns if c.emp_id != exclude_emp_id]
        for c in conns:
            try:
                c.out_q.put(payload)
            except Exception:
                pass


# 全局唯一注册表实例
presence = Presence()


def dumps(obj):
    """统一 JSON 序列化（确保中文不过滤）"""
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def send_raw(ws, payload_obj):
    """经 ws 直接发送一条已构造好的对象（仅在本连接主循环里调用，保持单线程安全）"""
    try:
        ws.send(dumps(payload_obj))
        return True
    except Exception:
        return False


def enqueue(conn, payload_obj):
    """往某连接的出站队列放一条消息（任何线程都可调用）"""
    try:
        conn.out_q.put(dumps(payload_obj))
        return True
    except Exception:
        return False
