# -*- coding: utf-8 -*-
"""
即时对话「富文本 + 群聊 @ 组员」真实 HTTP 冒烟（需 8808 在跑）
------------------------------------------------------------
验证 REST 链路上的三个新字段（contentHtml / atEmpIds / 群成员过滤）：
  · POST /api/msg/send（群）带 contentHtml + atEmpIds → 回带落库结果，非群成员被过滤；
  · GET  /api/msg/grouphistory → 历史里带 contentHtml / atEmpIds；
  · GET  /api/msg/detail       → 详情里带 contentHtml；
  · POST /api/msg/send（私聊）→ contentHtml 落库、atEmpIds 恒为空；
  · 无 token 一律 401。
数据隔离：所有数据都是本探针自建的群 + 消息，finally 里按 groupId 精确删除，
不碰用户真实会话（不改动任何既有消息行）。
用法：IM_TOKEN=<useinfo.token> python tools/_im_rich_http_probe.py
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server'))
import db  # noqa: E402

BASE = 'http://127.0.0.1:8808'
TOKEN = os.environ.get('IM_TOKEN', '').strip()
RUNP = 'IMRICH' + datetime.datetime.now().strftime('%H%M%S')
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


def call(method, path, params=None, token=None, timeout=15):
    url = BASE + '/api/' + path
    data = None
    if method == 'GET':
        if params:
            url += '?' + urllib.parse.urlencode(params)
    else:
        data = json.dumps(params or {}).encode('utf-8')
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    tk = TOKEN if token is None else token
    if tk:
        req.add_header('X-Token', tk)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8', 'replace')
            try:
                return json.loads(body), resp.status
            except ValueError:
                return {'raw': body}, resp.status
    except urllib.error.HTTPError as exc:
        body = exc.read().decode('utf-8', 'replace')
        try:
            return json.loads(body), exc.code
        except ValueError:
            return {'raw': body}, exc.code


def main():
    if not TOKEN:
        print('缺少 IM_TOKEN 环境变量（useinfo.token）')
        return 2
    me_row = db.query_one('SELECT `empId` FROM `useinfo` WHERE `token`=%s LIMIT 1', (TOKEN,))
    if not me_row:
        print('token 无效或已过期')
        return 2
    me = int(me_row['empId'])
    other = db.query_one('SELECT `id` FROM `empinfos` WHERE `id`<>%s '
                         'AND `status`=1 ORDER BY `id` ASC LIMIT 1', (me,))
    if not other:
        print('找不到第二个员工用于 @')
        return 2
    peer = int(other['id'])
    print('当前员工 empId=%s，被 @ 的组员 empId=%s' % (me, peer))

    gid = ''
    msg_ids = []
    try:
        print('\n--- 1. 未登录一律 401 ---')
        r, st = call('GET', 'msg/status', token='')
        check('GET /msg/status 无 token → 401', st == 401 or r.get('code') == 401, '%s %s' % (st, r))
        r, st = call('POST', 'msg/send', {'receiverIds': [peer], 'content': 'x'}, token='')
        check('POST /msg/send 无 token → 401', st == 401 or r.get('code') == 401, '%s %s' % (st, r))

        print('\n--- 2. 建临时群（群主=我，成员=@对象） ---')
        r, st = call('POST', 'msg/groupadd', {'groupName': RUNP, 'memberIds': [peer]})
        gid = ((r.get('data') or {}).get('groupId') or '')
        check('建群成功并返回 groupId', r.get('code') == 0 and bool(gid), str(r)[:120])
        if not gid:
            return 1

        print('\n--- 3. 群发富文本 + @ 组员 ---')
        html = ('<b>加粗</b>与<span style="color:#f56c6c">红字</span>'
                '<ul><li>要点一</li></ul>')
        r, st = call('POST', 'msg/send', {
            'groupId': gid, 'content': '', 'contentHtml': html,
            'atEmpIds': '%s,999999' % peer, 'msgType': 'text'
        })
        d = r.get('data') or {}
        msg_ids.extend(d.get('ids') or [])
        check('发送成功且返回 id', r.get('code') == 0 and bool(d.get('ids')), str(r)[:160])
        check('返回体带 contentHtml（HTML 片段原样保存）',
              '<b>加粗</b>' in (d.get('contentHtml') or ''), str(d.get('contentHtml'))[:80])
        check('返回体 atEmpIds 只留群成员（999999 被过滤）',
              str(d.get('atEmpIds')) == str(peer), str(d.get('atEmpIds')))

        print('\n--- 4. 群历史回带富文本与 @ ---')
        r, st = call('GET', 'msg/grouphistory', {'groupId': gid})
        items = ((r.get('data') or {}).get('list') or [])
        hit = [m for m in items if m.get('id') in msg_ids]
        check('群历史能查到这条消息', len(hit) == 1, str(len(items)))
        check('历史条目带 contentHtml', bool(hit) and '<b>加粗</b>' in (hit[0].get('contentHtml') or ''),
              str(hit[0].get('contentHtml'))[:80] if hit else '')
        check('历史条目 atEmpIds 正确',
              bool(hit) and str(hit[0].get('atEmpIds')) == str(peer),
              str(hit[0].get('atEmpIds')) if hit else '')
        check('纯文本 content 由 HTML 反抽（列表摘要可读）',
              bool(hit) and '<b>' not in (hit[0].get('content') or '') and
              '加粗' in (hit[0].get('content') or ''),
              str(hit[0].get('content'))[:60] if hit else '')

        print('\n--- 5. 详情接口 ---')
        if hit:
            r, st = call('GET', 'msg/detail', {'id': hit[0]['id']})
            dd = r.get('data') or {}
            check('详情带 contentHtml',
                  '<b>加粗</b>' in (dd.get('contentHtml') or ''),
                  str(dd.get('contentHtml'))[:80])
            check('详情带 atEmpIds', str(dd.get('atEmpIds')) == str(peer), str(dd.get('atEmpIds')))

        print('\n--- 6. 私聊富文本（@ 无效） ---')
        r, st = call('POST', 'msg/send', {
            'receiverIds': [peer], 'content': '', 'contentHtml': '<i>斜体私聊</i>',
            'atEmpIds': str(peer), 'msgType': 'text'
        })
        d2 = r.get('data') or {}
        msg_ids.extend(d2.get('ids') or [])
        check('私聊发送成功', r.get('code') == 0 and bool(d2.get('ids')), str(r)[:120])
        check('私聊 contentHtml 落库', '<i>斜体私聊</i>' in (d2.get('contentHtml') or ''),
              str(d2.get('contentHtml'))[:60])
        check('私聊 atEmpIds 恒为空（@ 只对群消息有效）',
              not d2.get('atEmpIds'), str(d2.get('atEmpIds')))
        if d2.get('ids'):
            r, st = call('GET', 'msg/detail', {'id': d2['ids'][0]})
            dd2 = r.get('data') or {}
            check('私聊详情 contentHtml 正确', '<i>斜体私聊</i>' in (dd2.get('contentHtml') or ''),
                  str(dd2.get('contentHtml'))[:60])

        print('\n--- 7. 富文本 XSS 兜底（后端 clean_html） ---')
        r, st = call('POST', 'msg/send', {
            'groupId': gid, 'content': 'xss',
            'contentHtml': '<b>正常</b><script>alert(1)</script><img src=a onerror="alert(2)">'
        })
        d3 = r.get('data') or {}
        msg_ids.extend(d3.get('ids') or [])
        cth = str(d3.get('contentHtml') or '')
        check('后端清洗掉 <script> / onerror',
              '<script' not in cth and 'onerror' not in cth, cth[:100])
        check('正常标签保留', '<b>正常</b>' in cth, cth[:100])
        return 0
    finally:
        print('\n--- 清理（只删本次自建数据） ---')
        if gid:
            call('POST', 'msg/groupdelete', {'groupId': gid})
        try:
            if gid:
                db.execute('DELETE FROM `emp_msgs` WHERE `groupId`=%s', (gid,))
                db.execute('DELETE FROM `empimgroupmembers` WHERE `groupId`=%s', (gid,))
                db.execute('DELETE FROM `empimgroups` WHERE `id`=%s', (gid,))
            ids = sorted(set(msg_ids))
            if ids:
                holders = ','.join(['%s'] * len(ids))
                db.execute('DELETE FROM `emp_msgs` WHERE `id` IN (%s)' % holders, tuple(ids))
            row = db.query_one('SELECT COUNT(*) AS n FROM `emp_msgs` '
                               'WHERE `contentHtml` IS NOT NULL '
                               'AND `senderName` LIKE %s', (RUNP + '%',)) or {}
            print('  本次残留消息行：%s' % int(row.get('n') or 0))
            g_left = db.query_one('SELECT COUNT(*) AS n FROM `empimgroups` '
                                  'WHERE `groupName` LIKE %s', (RUNP + '%',)) or {}
            print('  本次残留群：%s' % int(g_left.get('n') or 0))
        except Exception as exc:
            print('  清理异常：%s' % exc)


if __name__ == '__main__':
    code = main()
    print('\n结果：通过 %d 项，失败 %d 项' % (PASS, FAIL))
    sys.exit(code if FAIL == 0 else 1)
