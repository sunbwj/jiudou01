# -*- coding: utf-8 -*-
"""
站内消息「员工间强隔离 + WebSocket IM」进程内验证（无需启动 Web 服务 / 无需登录）
--------------------------------------------------------------------------
直接 import service.emp_message_service 并连真实 MySQL，用两个（或三个）真实员工的
useinfo.id 构造 _loginUserId，绕过 HTTP 直接调业务方法，重点验证：
  · 状态：empId 取自 token 反查，无视前端伪造 empId；
  · 发送：发件人固定取本人（后端从不读前端 senderId）、支持一对多、
         收件人不存在 / 缺收件人 / 空正文 一律被拒（标题允许为空，IM 单聊可无标题）；
  · 列表 / 详情：只返回「我是收件人且未删」或「我是发件人且未删」的消息；
  · 越权：拿别人的消息 id 查不到 / 改不动 / 删不掉（全部 404 / 0 行）；
  · 软删除按角色：收件人删只置 receiverDeleted（发件人仍可见），发件人删只置
         senderDeleted（收件人仍可见），双方都删才物理删除。
  · IM 新增：contacts（全员联系人 + 在线态 + 未读 + 最近消息）、history（按 peer 取会话并标记已读）、
         persist_send（一对多落库）、mark_peer / mark_peer_raw（已读回执）。

计数类断言一律用「增量（delta）」而非绝对值，避免被库里既有 / 手动测试残留数据污染。
所有写入的测试数据在 finally 里按捕获的 id + 专用标题前缀清理干净，不碰既有业务数据。

用法：python server/test_emp_message_service.py
"""
import os
import sys
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
import service

PASS = 0
FAIL = 0
RUNP = 'IMPR' + datetime.datetime.now().strftime('%Y%m%d%H%M%S') + '_'   # 本运行专用标题前缀
svc = service.emp_message_service   # 模块级单例，供下方 helper 与主流程共用


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s' % name)
    else:
        FAIL += 1
        print('  [FAIL] %s  %s' % (name, extra))


def safe_send(params):
    """send 校验失败会抛 BizError，这里统一收成 {code:非0} 结构便于断言"""
    try:
        return svc.send(params)
    except Exception as exc:
        return {'code': 500, 'message': str(exc)}


def safe_detail(params):
    """detail 越权时会抛 BizError(404)，这里收成 {code:非0} 结构便于断言"""
    try:
        return svc.detail(params)
    except Exception as exc:
        code = getattr(exc, 'code', None) or 500
        return {'code': code, 'message': str(exc)}


def main():
    svc = service.emp_message_service
    # 取最多 3 个「启用 + 已绑定员工 + empinfos 里确实存在」的账号，作为甲 / 乙 / 丙。
    users = db.query_all(
        'SELECT u.`id`,u.`empId` FROM `useinfo` u '
        'WHERE u.`enabled`=1 AND u.`empId`>0 '
        'ORDER BY u.`id` ASC LIMIT 6')
    valid = []
    for u in users:
        emp_id = int(u['empId'])
        row = db.query_one('SELECT `id` FROM `empinfos` WHERE `id`=%s LIMIT 1', (emp_id,))
        if row:
            valid.append(u)
        if len(valid) >= 3:
            break
    if len(valid) < 2:
        print('需要至少 2 个已绑定员工且 empinfos 存在的启用账号，当前只有 %d 个' % len(valid))
        sys.exit(2)
    a, b = valid[0], valid[1]
    c = valid[2] if len(valid) >= 3 else valid[1]   # 丙可能复用乙（仅影响跨员工越权探针）
    aid, bid, cid = int(a['empId']), int(b['empId']), int(c['empId'])
    pa = {'_loginUserId': a['id']}
    pb = {'_loginUserId': b['id']}
    pc = {'_loginUserId': c['id']}
    print('员工甲 empId=%s / 员工乙 empId=%s / 丙 empId=%s' % (aid, bid, cid))

    created_ids = []
    attach_ids = []      # empmsgfiles.id（媒体附件，finally 里连磁盘文件一起清）
    file_paths = []      # data/imfiles/... 相对路径
    group_ids = []       # empimgroups.id
    emoji_ids = []       # empimemojis.id（表情包，finally 里一并清）

    try:
        # ---------- 0. 状态：强隔离（empId 取自 token） ----------
        print('\n--- 0. 状态强隔离 ---')
        sa = svc.status(pa)
        check('status 返回 empId=甲', sa.get('empId') == aid, str(sa.get('empId')))
        sb = svc.status(pb)
        check('status 返回 empId=乙', sb.get('empId') == bid, str(sb.get('empId')))
        sa_fake = svc.status(dict(pa, empId=bid))
        check('status 无视前端伪造 empId=乙（仍=甲）', sa_fake.get('empId') == aid,
              str(sa_fake.get('empId')))
        check('status 结构含 unread / counts',
              'unread' in sa and isinstance(sa.get('counts'), dict), str(sa))

        # ---------- 1. 发送校验 ----------
        print('\n--- 1. 发送校验 ---')
        r0 = safe_send(dict(pa, receiverIds=[], content='x'))
        check('发送校验：缺收件人 被拒', r0.get('code') not in (0, None) or not r0.get('ids'),
              str(r0))
        r0b = safe_send(dict(pa, receiverIds=[999999], content='x'))
        check('发送校验：收件人不存在 被拒', r0b.get('code') not in (0, None) or not r0b.get('ids'),
              str(r0b))
        r0c = safe_send(dict(pa, receiverIds=[bid], title=RUNP + '空正文', content='   '))
        check('发送校验：空正文 被拒', r0c.get('code') not in (0, None) or not r0c.get('ids'),
              str(r0c))
        r0d = svc.send(dict(pa, receiverIds=[bid], content='无标题也可发（IM 单聊）'))
        check('发送校验：空标题允许（IM 单聊）', bool(r0d.get('ids')),
              str(r0d))
        if r0d.get('ids'):
            created_ids.extend(r0d['ids'])

        # ---------- 2. 正常发送与归属快照 ----------
        print('\n--- 2. 正常发送与归属快照 ---')
        sent_before = svc.status(pa)['counts']['sent']
        r1 = svc.send(dict(pa, receiverIds=[bid, cid], title=RUNP + '一对多', content='甲的一对多正文'))
        created_ids.extend(r1.get('ids') or [])
        sent_after = svc.status(pa)['counts']['sent']
        check('一对多发成功：生成 2 条（乙、丙各一）', len(r1.get('ids') or []) == 2, str(r1.get('ids')))
        check('发送后 counts.sent 增量=2', sent_after - sent_before == 2,
              'before=%s after=%s' % (sent_before, sent_after))
        msg_to_b = (r1.get('ids') or [None, None])[0]
        msg_to_c = (r1.get('ids') or [None, None])[1]
        # 落库归属：发件人固定取本人
        row_b = db.query_one('SELECT `senderId`,`receiverId`,`senderName`,`receiverName`,`title` '
                             'FROM `emp_msgs` WHERE `id`=%s', (msg_to_b,))
        check('落库发件人 = 甲（前端伪造 senderId=乙 无效）', int(row_b['senderId']) == aid,
              str(row_b['senderId']))
        check('落库收件人 = 乙（取真实 empId）', int(row_b['receiverId']) == bid,
              str(row_b['receiverId']))
        check('落库发件人姓名已快照（非空）', bool(row_b['senderName']))
        check('落库收件人姓名已快照（非空）', bool(row_b['receiverName']))

        # ---------- 3. 列表隔离（收件箱 / 已发送） ----------
        print('\n--- 3. 列表隔离（增量断言） ---')
        ib_before = svc.page(dict(pa, folder='inbox'))['total']
        sb_sent_before = svc.page(dict(pb, folder='sent'))['total']
        r2 = svc.send(dict(pb, receiverIds=[aid], title=RUNP + '乙发给甲', content='乙的正文'))
        created_ids.extend(r2.get('ids') or [])
        msg_b_to_a = (r2.get('ids') or [None])[0]
        ib_after = svc.page(dict(pa, folder='inbox'))['total']
        sb_sent_after = svc.page(dict(pb, folder='sent'))['total']
        check('乙的消息使 甲收件箱 +1', ib_after - ib_before == 1,
              'before=%s after=%s' % (ib_before, ib_after))
        check('乙的已发送 +1', sb_sent_after - sb_sent_before == 1,
              'before=%s after=%s' % (sb_sent_before, sb_sent_after))
        list_a = svc.page(dict(pa, folder='inbox'))['list']
        check('列表不返回正文（content 被剔除）',
              all(('content' not in it or it.get('content') in (None, '')) for it in list_a))
        fa_total = svc.page(dict(pa, empId=bid, folder='inbox'))['total']
        check('前端伪造 empId=乙 查列表无效（总数与甲一致）',
              fa_total == ib_after, 'fake=%s real=%s' % (fa_total, ib_after))

        # ---------- 4. 详情越权防护 ----------
        print('\n--- 4. 详情越权防护 ---')
        det = svc.detail(dict(pa, id=msg_to_b))
        check('甲能读自己发的消息（msg_to_b）', det.get('id') == msg_to_b, str(det.get('id')))
        check('详情返回正文', bool(det.get('content')))
        det2 = svc.detail(dict(pa, id=msg_b_to_a))
        check('甲读自己的收件并标记已读', det2.get('id') == msg_b_to_a, str(det2.get('id')))
        check('已读已落库', int(db.query_one('SELECT `readStatus` FROM `emp_msgs` WHERE `id`=%s',
                                            (msg_b_to_a,))['readStatus']) == 1)
        # 越权：丙（第三方，既不是 msg_to_b 的发送者也非收件人）读「甲→乙」必须 404
        det3 = safe_detail(dict(pc, id=msg_to_b))
        check('丙（第三方）读「甲→乙」的消息被拒（404 不泄露存在性）', det3.get('code') in (404, 403, None),
              str(det3.get('code')))

        # ---------- 5. 标记已读越权防护 ----------
        print('\n--- 5. 标记已读越权防护 ---')
        # msg_to_b 是「甲→乙」，乙是收件人，故乙可标记已读；甲（发件人）标记无效
        m = svc.mark(dict(pb, ids=[msg_to_b]))
        check('乙标记自己收件箱的消息 updated=1', m.get('updated') == 1, str(m))
        m2 = svc.mark(dict(pa, ids=[msg_to_b]))
        check('甲（发件人）标记同一条 updated=0', m2.get('updated') == 0, str(m2))
        check('该消息 readStatus=1（只被收件人乙标记）',
              int(db.query_one('SELECT `readStatus` FROM `emp_msgs` WHERE `id`=%s',
                               (msg_to_b,))['readStatus']) == 1)

        # ---------- 6. 软删除按角色 ----------
        print('\n--- 6. 软删除按角色 ---')
        sent_a_before = svc.status(pa)['counts']['sent']
        svc.delete(dict(pa, ids=[msg_to_b]))                 # 甲删自己发的
        sent_a_after = svc.status(pa)['counts']['sent']
        check('甲软删后 sent 减 1（发件人不再可见）', sent_a_after - sent_a_before == -1,
              'before=%s after=%s' % (sent_a_before, sent_a_after))
        rb = db.query_one('SELECT `senderDeleted`,`receiverDeleted` FROM `emp_msgs` WHERE `id`=%s',
                          (msg_to_b,))
        check('甲删除后 senderDeleted=1', int(rb['senderDeleted']) == 1)
        check('甲删除后 receiverDeleted 仍=0（乙仍可见）', int(rb['receiverDeleted']) == 0)
        ib_b_total = svc.page(dict(pb, folder='inbox'))['total']
        check('乙收件箱仍能看到这条（收件人软删未触发）',
              ib_b_total == svc.page(dict(pb, folder='inbox'))['total'])
        svc.delete(dict(pb, ids=[msg_to_b]))                 # 乙也删
        exists_ba = db.query_one('SELECT COUNT(*) AS n FROM `emp_msgs` WHERE `id`=%s', (msg_to_b,))
        check('双方都删后消息物理删除', int(exists_ba['n']) == 0)
        # 单方删除不物理删（msg_to_c 只被甲删）
        svc.delete(dict(pa, ids=[msg_to_c]))
        exists_bc = db.query_one('SELECT COUNT(*) AS n FROM `emp_msgs` WHERE `id`=%s', (msg_to_c,))
        check('单方面删除不物理删（消息仍在）', int(exists_bc['n']) == 1)

        # ---------- 7. IM：contacts / history / persist_send / mark_peer ----------
        print('\n--- 7. IM 实时消息（contacts / history / persist_send / mark_peer） ---')
        # 7.1 contacts：全员联系人 + 在线态 + 未读 + 最近消息
        cts = svc.contacts(pa)
        check('contacts 返回本人 empId=甲', cts.get('me') == aid, str(cts.get('me')))
        clist = cts.get('list') or []
        check('contacts 列表为数组且排除本人', isinstance(clist, list) and
              all(int(x['empId']) != aid for x in clist), str([x.get('empId') for x in clist]))
        check('contacts 含乙、丙', any(int(x['empId']) == bid for x in clist) and
              any(int(x['empId']) == cid for x in clist))
        sample = next((x for x in clist if int(x['empId']) == bid), None)
        check('联系人含在线态布尔字段', sample and isinstance(sample.get('online'), bool), str(sample))
        check('联系人含未读 / 最近消息字段',
              sample and 'unread' in sample and 'lastContent' in sample, str(sample))

        # 7.2 persist_send 一对多落库 + history 按 peer 取并标记已读
        ub_before = svc._unread(bid)               # 乙当前未读（来自甲）
        created_im = svc.persist_send(aid, [bid, cid], 'IM你好（甲→乙,丙）', '')
        created_ids.extend([x['id'] for x in created_im])
        check('persist_send 生成 2 条', len(created_im) == 2, str(len(created_im)))
        check('持久化后 乙未读 +1', svc._unread(bid) - ub_before == 1,
              'before=%s after=%s' % (ub_before, svc._unread(bid)))
        hb = svc.history(dict(pa, peerId=bid))
        check('history(甲,乙) 含甲发给乙的消息',
              any(x.get('senderId') == aid and x.get('content', '').startswith('IM你好') for x in hb['list']),
              str([(x.get('senderId'), x.get('content')) for x in hb['list']]))
        hb2 = svc.history(dict(pb, peerId=aid))
        check('history(乙,甲) 乙能看到甲发的消息',
              any(x.get('receiverId') == bid for x in hb2['list']), str(hb2.get('list')))
        # 只看「乙对甲」这条会话的未读（共享库里乙可能还有别人的未读，不能拿全局未读判归零）
        peer_b = next((x for x in (svc.contacts(pb).get('list') or [])
                       if int(x['empId']) == aid), {})
        check('乙打开会话后未读回执生效（乙对甲的未读归零）',
              int(peer_b.get('unread') or 0) == 0,
              'peer-unread=%s before=%s' % (peer_b.get('unread'), ub_before))

        # 7.3 mark_peer / mark_peer_raw 已读回执
        created_im2 = svc.persist_send(bid, [aid], '乙回甲一条', '')
        created_ids.extend([x['id'] for x in created_im2])
        ua_before = svc._unread(aid)
        check('甲收到乙消息后未读 >=1', ua_before >= 1, str(ua_before))
        svc.mark_peer_raw(aid, bid)                # 甲标记「乙发来的」已读
        check('mark_peer_raw 后 甲未读减少', svc._unread(aid) < ua_before,
              'before=%s after=%s' % (ua_before, svc._unread(aid)))
        mp = svc.mark_peer(dict(pa, peerId=bid))
        check('mark_peer 返回结构含 updated', isinstance(mp.get('updated'), int), str(mp))
        # contacts 的未读统计应反映：甲看乙时，乙发给甲的未读应已清零
        cts2 = svc.contacts(pa)
        c2 = next((x for x in (cts2.get('list') or []) if int(x['empId']) == bid), None)
        check('contacts 反映 乙→甲 未读已清零', c2 and c2.get('unread') == 0, str(c2))

        # ---- 未读聚合 unread_summary：主框架铃铛 / 菜单上标 / 语音提醒的数据源 ----
        # 口径：只算「我是收件人 + 未读 + 未删」，按发件人分组，附带最近一条内容与姓名。
        # 全部用增量断言，避免被库里既有未读污染。
        base = svc.unread_summary(pa)
        base_b = next((int(x['unread']) for x in base['peers'] if int(x['empId']) == bid), 0)
        base_total = int(base['unread'])
        new_rows = svc.persist_send(bid, [aid], RUNP + '聚合未读一', '')
        new_rows += svc.persist_send(bid, [aid], RUNP + '聚合未读二', '')
        created_ids.extend([x['id'] for x in new_rows])
        agg = svc.unread_summary(pa)
        item = next((x for x in agg['peers'] if int(x['empId']) == bid), None)
        check('unread_summary 按发件人聚合（甲看乙的未读 +2）',
              bool(item) and int(item['unread']) == base_b + 2,
              'base=%s now=%s' % (base_b, item and item.get('unread')))
        check('unread_summary 总数同步 +2', int(agg['unread']) == base_total + 2,
              'base=%s now=%s' % (base_total, agg.get('unread')))
        check('unread_summary 带姓名 / 部门 / 最近内容 / 时间',
              bool(item) and bool(item.get('name')) and bool(item.get('lastContent'))
              and bool(item.get('lastTime')) and 'avatarText' in item, str(item))
        check('unread_summary 只含「别人发给我的」（不含自己）',
              all(int(x['empId']) != aid for x in agg['peers']), str(agg['peers']))
        check('unread_summary 支持 limit 截断（默认最多 8 人）',
              len(agg['peers']) <= 8, str(len(agg['peers'])))
        svc.mark_peer_raw(aid, bid)                 # 甲把乙发来的都读掉
        agg2 = svc.unread_summary(pa)
        item2 = next((x for x in agg2['peers'] if int(x['empId']) == bid), None)
        check('已读后 unread_summary 里该发件人归零 / 消失',
              item2 is None or int(item2['unread']) == 0, str(item2))

        # ---- 提醒中心聚合 NotifyService（im + mail 一起给，任一异常都降级） ----
        note = service.notify_service.summary(pa)
        check('NotifyService.summary 结构含 im / mail / total / serverTime',
              all(k in note for k in ('im', 'mail', 'total', 'serverTime')), str(sorted(note.keys())))
        check('NotifyService 的 total = im.unread + mail.unread',
              int(note['total']) == int(note['im'].get('unread') or 0) + int(note['mail'].get('unread') or 0),
              str(note.get('total')))
        check('NotifyService 的 mail 段带 configured / items', 
              'configured' in note['mail'] and isinstance(note['mail'].get('items'), list),
              str(sorted(note['mail'].keys())))
        orig_mail_summary = service.emp_mail_service.unread_summary
        try:
            def _boom(*a, **k):
                raise RuntimeError('模拟邮件子系统异常')
            service.emp_mail_service.unread_summary = _boom
            deg = service.notify_service.summary(pa)
        finally:
            service.emp_mail_service.unread_summary = orig_mail_summary
        check('邮件子系统异常时降级为空（不把主框架轮询带崩）',
              int(deg['mail'].get('unread') or 0) == 0 and 'message' in deg['mail'], str(deg['mail']))
        check('降级时 im 段仍然可用（互不影响）',
              'unread' in deg['im'], str(sorted(deg['im'].keys())))

        # ---------- 9. 媒体附件（图片 / 文件）上传与发送 ----------
        print('\n--- 9. 媒体附件上传 / 发送 ---')
        import base64 as _b64
        png = _b64.b64decode(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
        up = svc.upload(dict(pa, fileName='测试截图.png', kind='image',
                             data='data:image/png;base64,' + _b64.b64encode(png).decode(),
                             width=1, height=1))
        attach_ids.append(up['fileId'])
        file_paths.append(up['url'])
        check('上传图片：返回 fileId', bool(up.get('fileId')), str(up.get('fileId')))
        check('上传图片：kind=image 且 ext=png',
              up.get('kind') == 'image' and up.get('ext') == 'png', str(up.get('kind')))
        check('上传图片：落盘路径在 data/imfiles 下',
              str(up.get('url')).startswith('data/imfiles/'), str(up.get('url')))
        check('上传图片：实体文件真的写到磁盘了',
              os.path.isfile(os.path.join(service.WEB_ROOT_LOCAL, *str(up['url']).split('/'))),
              str(up.get('url')))
        check('上传图片：字节数一致', up.get('size') == len(png), str(up.get('size')))
        upf = svc.upload(dict(pa, fileName='说明.txt', kind='file', data=_b64.b64encode(b'hello').decode()))
        attach_ids.append(upf['fileId'])
        file_paths.append(upf['url'])
        check('上传非图片：kind=file、mime 猜成 text/plain',
              upf.get('kind') == 'file' and 'text/plain' in (upf.get('mimeType') or ''), str(upf.get('mimeType')))
        try:
            svc.upload(dict(pa, fileName='', data=_b64.b64encode(b'x').decode()))
            check('上传校验：空文件名被拒', False)
        except service.BizError as exc:
            check('上传校验：空文件名被拒', True, exc.message)
        try:
            svc.upload(dict(pa, fileName='x.png', kind='image', data=''))
            check('上传校验：空内容被拒', False)
        except service.BizError as exc:
            check('上传校验：空内容被拒', True, exc.message)
        try:
            svc.upload(dict(pa, fileName='a.txt', kind='image', data=_b64.b64encode(b'x').decode()))
            check('上传校验：非图片按 image 上传被拒', False)
        except service.BizError as exc:
            check('上传校验：非图片按 image 上传被拒', True, exc.message)

        r_img = svc.persist_send(aid, [bid], '', '', 'image', up['fileId'])
        created_ids.extend([x['id'] for x in r_img])
        m_img = r_img[0]
        check('发图片：msgType=image', m_img.get('msgType') == 'image', str(m_img.get('msgType')))
        check('发图片：正文自动补「[图片]」', m_img.get('content') == '[图片]', str(m_img.get('content')))
        check('发图片：attach 元数据随消息返回', bool(m_img.get('attach')), str(m_img.get('attach')))
        row_f = db.query_one('SELECT `msgId` FROM `empmsgfiles` WHERE `id`=%s', (up['fileId'],))
        check('发图片：附件行回填 msgId（便于清理孤儿文件）',
              bool(row_f) and row_f['msgId'] == m_img['id'], str(row_f))
        r_file = svc.persist_send(aid, [bid], '', '', 'file', upf['fileId'])
        created_ids.extend([x['id'] for x in r_file])
        check('发文件：msgType=file、正文「[文件]」',
              r_file[0].get('msgType') == 'file' and r_file[0].get('content') == '[文件]',
              str(r_file[0].get('content')))
        try:
            svc.persist_send(bid, [aid], '', '', 'image', up['fileId'])
            check('防盗用：不能拿别人上传的附件发送（403）', False)
        except service.BizError as exc:
            check('防盗用：不能拿别人上传的附件发送（403）', exc.code == 403, exc.message)
        try:
            svc.persist_send(aid, [bid], '', '', 'image', 'no-such-file-id')
            check('发图片：附件不存在被拒', False)
        except service.BizError as exc:
            check('发图片：附件不存在被拒', True, exc.message)

        # ---------- 10. 群组 ----------
        print('\n--- 10. 群组（建群 / 群消息 / 群未读 / 权限） ---')
        try:
            svc.group_add(dict(pa, groupName=RUNP + '空群'))
            check('建群校验：没有成员被拒', False)
        except service.BizError as exc:
            check('建群校验：没有成员被拒', True, exc.message)
        g = svc.group_add(dict(pa, groupName=RUNP + '测试群', memberIds=[bid]))
        gid = g['groupId']
        group_ids.append(gid)
        check('建群：返回 groupId', bool(gid), str(gid))
        check('建群：成员数 = 2（含群主）', g.get('memberCount') == 2, str(g.get('memberCount')))
        check('建群：群主是发起人', g.get('group', {}).get('isOwner') is True, str(g.get('group', {}).get('ownerId')))
        ga = svc.groups(pa)
        check('甲的群列表含该群', any(x['groupId'] == gid for x in ga['list']), str(len(ga['list'])))
        gb = svc.groups(pb)
        check('乙的群列表也含该群', any(x['groupId'] == gid for x in gb['list']), str(len(gb['list'])))

        r_g = svc.persist_send(aid, [0], RUNP + '群消息一', '', 'text', '', gid)
        created_ids.extend([x['id'] for x in r_g])
        check('群消息：groupId 正确、receiverId=0',
              r_g[0].get('groupId') == gid and r_g[0].get('receiverId') == 0,
              '%s / %s' % (r_g[0].get('groupId'), r_g[0].get('receiverId')))
        check('群消息：自己发的不算自己未读',
              next(x['unread'] for x in svc.groups(pa)['list'] if x['groupId'] == gid) == 0)
        ub = next(x['unread'] for x in svc.groups(pb)['list'] if x['groupId'] == gid)
        check('群未读：乙有 1 条未读', ub == 1, str(ub))
        gh = svc.group_history(dict(pb, groupId=gid))
        check('群历史：乙能看到这条消息', any(m['id'] == r_g[0]['id'] for m in gh['list']), str(len(gh['list'])))
        check('群历史：isMe 正确（乙看不是自己发的）',
              all(m['isMe'] is False for m in gh['list'] if m['id'] == r_g[0]['id']))
        ub2 = next(x['unread'] for x in svc.groups(pb)['list'] if x['groupId'] == gid)
        check('群历史：打开后乙未读归零', ub2 == 0, str(ub2))
        r_g2 = svc.persist_send(aid, [0], RUNP + '群消息二', '', 'text', '', gid)
        created_ids.extend([x['id'] for x in r_g2])
        mk = svc.mark_group(dict(pb, groupId=gid))
        check('mark_group：标记已读后未读归零', mk.get('unread') == 0, str(mk))

        # 群未读进「提醒中心」聚合
        r_g3 = svc.persist_send(aid, [0], RUNP + '群消息三', '', 'text', '', gid)
        created_ids.extend([x['id'] for x in r_g3])
        note_g = svc.unread_summary(pb)
        check('unread_summary：im 段带 groups 数组', isinstance(note_g.get('groups'), list),
              str(type(note_g.get('groups'))))
        check('unread_summary：groupUnread 统计到该群',
              int(note_g.get('groupUnread') or 0) >= 1, str(note_g.get('groupUnread')))
        check('unread_summary：群未读已并入 im.unread',
              int(note_g['unread']) >= int(note_g.get('groupUnread') or 0), str(note_g.get('unread')))
        g_items = note_g.get('groups') or []
        check('unread_summary：群条目带 groupId / name / unread',
              bool(g_items) and all(
                  ('groupId' in it and 'name' in it and 'unread' in it) for it in g_items),
              str(g_items)[:120])

        # 权限
        if cid in (aid, bid):
            print('  [SKIP] 越权：非成员读群消息（本次没有第三个员工可用）')
        else:
            try:
                svc.group_history(dict(pc, groupId=gid))
                check('越权：非成员读群消息被拒（403）', False)
            except service.BizError as exc:
                check('越权：非成员读群消息被拒（403）', exc.code == 403, exc.message)
        try:
            svc.group_update(dict(pb, groupId=gid, groupName=RUNP + '乙改名'))
            check('权限：非群主改名被拒（403）', False)
        except service.BizError as exc:
            check('权限：非群主改名被拒（403）', exc.code == 403, exc.message)
        gu = svc.group_update(dict(pa, groupId=gid, groupName=RUNP + '改名OK'))
        check('群主可以改名', gu['group']['name'] == RUNP + '改名OK', str(gu['group'].get('name')))
        d = svc.group_detail(dict(pa, groupId=gid))
        check('群资料：成员列表 2 人且群主排第一',
              len(d.get('members') or []) == 2 and d['members'][0]['isOwner'] is True,
              str(d.get('members')))
        # ---------- 10b. 富文本正文 + 群聊 @ 组员 ----------
        print('\n--- 10b. 富文本正文 + 群聊 @ 组员 ---')
        # 这个测试群只有 甲(群主) + 乙 两人，丙不在群里 → 正好用来验证「非成员被过滤」
        exp_at = str(bid)
        r_rich = svc.persist_send(
            aid, [0], '', '', 'text', '', gid,
            content_html='<b>加粗</b>与<span style="color:#f56c6c">红字</span>',
            at_emp_ids='%s,%s,999999' % (exp_at, cid))
        created_ids.extend([x['id'] for x in r_rich])
        check('富文本群消息：persist_send 返回 contentHtml',
              '<b>加粗</b>' in (r_rich[0].get('contentHtml') or ''),
              str(r_rich[0].get('contentHtml'))[:60])
        check('富文本群消息：纯文本由 HTML 反抽（不带标签）',
              '<b>' not in (r_rich[0].get('content') or '') and '加粗' in (r_rich[0].get('content') or ''),
              str(r_rich[0].get('content'))[:60])
        check('@ 组员：只保留群成员（999999 被丢弃）',
              r_rich[0].get('atEmpIds') == exp_at, str(r_rich[0].get('atEmpIds')))
        gh_rich = svc.group_history(dict(pb, groupId=gid))['list']
        hit_rich = [m for m in gh_rich if m['id'] == r_rich[0]['id']]
        check('群历史回带 contentHtml / atEmpIds',
              len(hit_rich) == 1 and '<b>加粗</b>' in (hit_rich[0].get('contentHtml') or '')
              and hit_rich[0].get('atEmpIds') == exp_at,
              str(hit_rich[0].get('atEmpIds')) if hit_rich else 'not found')

        check('@ 组员：_at_ids_of 去重', svc._at_ids_of('%d,%d' % (bid, bid), gid) == str(bid))
        check('@ 组员：_at_ids_of 过滤非成员', svc._at_ids_of('999999,abc', gid) == '')
        check('@ 组员：_at_ids_of 空入参返回空串',
              svc._at_ids_of('', gid) == '' and svc._at_ids_of(None, gid) == '')

        r_p = svc.persist_send(aid, [bid], '', '', 'text', '', '',
                               content_html='<i>斜体正文</i>', at_emp_ids=str(bid))
        created_ids.extend([x['id'] for x in r_p])
        h_p = svc.history(dict(pb, peerId=aid))['list']
        hit_p = [m for m in h_p if m['id'] == r_p[0]['id']]
        check('私聊：contentHtml 落库',
              len(hit_p) == 1 and '<i>斜体正文</i>' in (hit_p[0].get('contentHtml') or ''),
              str(hit_p[0].get('contentHtml')) if hit_p else 'not found')
        check('私聊：atEmpIds 恒为空（@ 只对群消息有效）',
              len(hit_p) == 1 and not hit_p[0].get('atEmpIds'),
              str(hit_p[0].get('atEmpIds')) if hit_p else '')
        det = svc.detail(dict(pb, id=r_p[0]['id']))
        check('详情接口同样回带 contentHtml', '<i>斜体正文</i>' in (det.get('contentHtml') or ''),
              str(det.get('contentHtml'))[:60])

        r_rest = svc.send(dict(pa, groupId=gid, content='', contentHtml='<u>REST 富文本</u>',
                               atEmpIds=str(bid)))
        created_ids.extend(r_rest.get('ids') or [])
        check('REST 发送：返回 contentHtml / atEmpIds',
              '<u>REST 富文本</u>' in (r_rest.get('contentHtml') or '')
              and r_rest.get('atEmpIds') == str(bid),
              '%s / %s' % (str(r_rest.get('contentHtml'))[:40], r_rest.get('atEmpIds')))

        lv = svc.group_delete(dict(pb, groupId=gid))
        check('成员退群：left=True / dissolved=False',
              lv.get('left') is True and lv.get('dissolved') is False, str(lv))
        check('退群后不在自己的群列表',
              not any(x['groupId'] == gid for x in svc.groups(pb)['list']))
        dis = svc.group_delete(dict(pa, groupId=gid))
        check('群主解散：dissolved=True', dis.get('dissolved') is True, str(dis))
        try:
            svc.group_detail(dict(pa, groupId=gid))
            check('解散后群不可访问（404）', False)
        except service.BizError as exc:
            check('解散后群不可访问（404）', exc.code == 404, exc.message)

        # ---------- 11. 表情包（图片表情：上传 → 登记 → 列表 → 发送 sticker → 删除权限） ----------
        print('\n--- 11. 表情包（全站共享 / 只能删自己的） ---')
        # 先造一张极小的 PNG 附件（复用 upload，走真实落盘）
        png_b64 = ('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGA'
                   'hKmMIQAAAABJRU5ErkJggg==')
        up2 = svc.upload(dict(pa, fileName=RUNP + '表情.png', kind='image',
                              width=1, height=1, data='data:image/png;base64,' + png_b64))
        fid2 = up2.get('fileId')
        attach_ids.append(fid2)
        file_paths.append(up2.get('url'))
        check('表情底图上传成功', bool(fid2), str(up2)[:80])

        em = svc.emoji_add(dict(pa, fileId=fid2, name=RUNP + '表情'))
        emoji_ids.append(em.get('id'))
        check('登记成表情包（返回 id / url）', bool(em.get('id')) and bool(em.get('url')), str(em)[:100])
        check('登记后 mine=True', em.get('mine') is True)

        try:
            svc.emoji_add(dict(pa, fileId=fid2, name='重复'))
            check('同一附件不能重复登记', False)
        except service.BizError as exc:
            check('同一附件不能重复登记', '已经添加过' in exc.message, exc.message)

        try:
            svc.emoji_add(dict(pa, fileId='not-exist-file', name='x'))
            check('不存在的附件被拒绝', False)
        except service.BizError as exc:
            check('不存在的附件被拒绝', '附件不存在' in exc.message, exc.message)

        lst = svc.emojis(pa)
        hit = [x for x in (lst.get('list') or []) if x['id'] == em['id']]
        check('表情包列表能看到自己加的', len(hit) == 1, str(lst.get('total')))
        check('列表带 url / 名称', bool(hit) and bool(hit[0]['url']) and RUNP in hit[0]['name'],
              str(hit[:1])[:100])

        # 发送 sticker：正文可空 → 自动补 [表情]，msgType=sticker
        created_st = svc.persist_send(aid, [bid], '', '', 'sticker', fid2)
        created_ids.append(created_st[0]['id'])
        check('sticker 消息 msgType=sticker', created_st[0].get('msgType') == 'sticker',
              str(created_st[0].get('msgType')))
        check('sticker 正文自动补 [表情]', created_st[0].get('content') == '[表情]',
              str(created_st[0].get('content')))
        hist_st = svc.history(dict(pa, peerId=bid))
        row_st = [x for x in (hist_st.get('list') or []) if x['id'] == created_st[0]['id']]
        check('历史里 sticker 带 attach.url', bool(row_st) and bool((row_st[0].get('attach') or {}).get('url')),
              str(row_st[:1])[:120])

        # 删除权限：别人不能删我的
        try:
            svc.emoji_delete(dict(pb, id=em['id']))
            check('非本人不能删除表情包（403）', False)
        except service.BizError as exc:
            check('非本人不能删除表情包（403）', exc.code == 403, exc.message)

        gone = svc.emoji_delete(dict(pa, id=em['id']))
        check('本人可以删除表情包', gone.get('deleted') is True, str(gone))
        lst2 = svc.emojis(pa)
        check('删除后列表里没有了',
              not [x for x in (lst2.get('list') or []) if x['id'] == em['id']])
        emoji_ids.clear()      # 已删，finally 不用再删

        # ---- WS 握手鉴权：token_row 必须带 empId（否则 _ws_auth 永远取不到员工） ----
        # 真实故障（2026-11-07）：token_row 的 SELECT 漏了 empId → _ws_auth 恒返回 (None, 0)
        # → 带 ?token= 的连接进「等 hello」分支，而前端从不发 hello → 10s 后 authFail，
        #   表现为「站内消息一直连接中 / 提示登录已失效」。HTTP 接口不受影响（用的是 _loginUserId）。
        try:
            import app as appmod
            tok = db.query_one('SELECT `token`,`empId` FROM `useinfo` '
                               'WHERE `token` IS NOT NULL AND `token`<>\'\' AND `enabled`=1 '
                               'AND `empId`>0 AND `tokenExpireTime`>NOW() LIMIT 1')
            if not tok:
                print('  [SKIP] WS 握手鉴权：库里没有可用 token 样本')
            else:
                row = appmod.token_row(tok['token'])
                check('token_row 查出的行带 empId（WS 鉴权前提）',
                      bool(row) and 'empId' in row, str(sorted(row.keys()) if row else row))
                uid, emp = appmod._ws_auth(tok['token'])
                check('_ws_auth 能由 token 反查出员工', bool(uid) and int(emp) == int(tok['empId'] or 0),
                      'uid=%s emp=%s' % (uid, emp))
                check('_ws_auth 拒绝空 token', appmod._ws_auth('') == (None, 0), str(appmod._ws_auth('')))
                check('_ws_auth 拒绝伪造 token', appmod._ws_auth('not-a-real-token') == (None, 0),
                      str(appmod._ws_auth('not-a-real-token')))
        except Exception as exc:
            check('WS 握手鉴权用例执行', False, str(exc))

    finally:
        # 清理：只删本次创建的测试消息（按捕获的 id + 标题前缀双保险）
        try:
            if created_ids:
                holders = ','.join(['%s'] * len(created_ids))
                db.execute('DELETE FROM `emp_msgs` WHERE `id` IN (' + holders + ')', created_ids)
            db.execute('DELETE FROM `emp_msgs` WHERE `title` LIKE %s', (RUNP + '%',))
        except Exception as exc:
            print('清理站内消息失败（请手工检查）：%s' % exc)
        # 清理群组与附件（先成员后群，避免留下悬挂行）
        try:
            for gid in group_ids:
                db.execute('DELETE FROM `emp_msgs` WHERE `groupId`=%s', (gid,))
                db.execute('DELETE FROM `empimgroupmembers` WHERE `groupId`=%s', (gid,))
                db.execute('DELETE FROM `empimgroups` WHERE `id`=%s', (gid,))
            if attach_ids:
                holders = ','.join(['%s'] * len(attach_ids))
                db.execute('DELETE FROM `empmsgfiles` WHERE `id` IN (' + holders + ')', attach_ids)
            for eid in emoji_ids:
                db.execute('DELETE FROM `empimemojis` WHERE `id`=%s', (eid,))
            for rel in file_paths:
                try:
                    full = os.path.join(service.WEB_ROOT_LOCAL, *str(rel).split('/'))
                    if os.path.isfile(full):
                        os.remove(full)
                except OSError:
                    pass
        except Exception as exc:
            print('清理群组 / 附件失败（请手工检查）：%s' % exc)

    print('\n结果：通过 %d 项，失败 %d 项' % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
