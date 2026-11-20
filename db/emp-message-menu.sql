-- =====================================================================
-- 菜单数据：新增「站内消息」（员工间互发，按 empId 强隔离 message.html）
-- ---------------------------------------------------------------------
-- 说明：
--   · 挂到已有的「邮件中心」菜单组（MNG1004），排在我的邮箱（MNU00021, sortNo 3）之后，sortNo 4；
--   · **给所有启用角色授权这个菜单项**（这是「给每员工」的功能，不是管理员专属）：
--       整组授权（menuItemId=0）的角色本来就覆盖全部菜单项，不必重复插；
--       其它角色补一条具体到 menuItemId 的授权（NOT EXISTS 幂等）；
--   · 同时登记本页 4 个操作按钮（pageopbtn）并给所有启用角色授权，
--     按钮文案与 message.html 实际显示一致（写信 / 标记已读 / 删除 / 刷新）；
--   · 数据隔离不靠菜单权限，靠后端按登录 token 反查 empId 强制过滤（见 server/service.py
--     的 EmpMessageService），因此即使所有员工都能看到这个菜单，也只能读写自己的消息。
--
-- 【可重复执行 / 非破坏性】全部 INSERT ... SELECT ... WHERE NOT EXISTS，不改已有数据。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/emp-message-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项：站内消息
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00022','即时对话','InstantMessage','message.html','chat','4','1',
       '即时对话：WebSocket 实时聊天（WebQQ 风格），全员可互发；消息落库持久保存，离线发送登录后即可看到'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00022');

-- 2) 绑定：邮件中心（MNG1004）→ 站内消息
INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 4, 1, '邮件中心'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00022'
WHERE g.`code`='MNG1004'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

-- 3) 所有启用角色授权「站内消息」这一项（整组授权的角色已覆盖，仍可补一条具体授权，幂等）
INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, g.`id`, m.`id`, 1, '站内消息（全员可用）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1004'
JOIN `menuinfros` m ON m.`code`='MNU00022'
WHERE r.`enabled`=1
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.`roleId`=r.`id` AND p.`menuGroupId`=g.`id` AND p.`menuItemId`=m.`id`
  );

-- 4) 本页 4 个操作按钮（与 message.html 实际显示一致）
INSERT INTO `pageopbtn` (`id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo`,`enabled`,`remark`)
SELECT UUID(), '即时对话', 'message.html', d.`btnId`, d.`btnText`, d.`sortNo`, 1,
       '即时对话：员工间实时聊天（按 empId 强隔离）'
FROM (
    SELECT 'btnWrite'    AS `btnId`, '写信'     AS `btnText`, 0 AS `sortNo`
    UNION ALL SELECT 'btnMarkRead', '标记已读', 1
    UNION ALL SELECT 'btnDelete',   '删除',     2
    UNION ALL SELECT 'btnRefresh',  '刷新',     3
) d
WHERE NOT EXISTS (
    SELECT 1 FROM `pageopbtn` b
    WHERE b.`pagePath`='message.html' AND b.`btnId`=d.`btnId`
);

-- 5) 所有启用角色授权这 4 个按钮（「给每员工」的功能，全员可用；幂等）
INSERT INTO `usergrouppagebtnset` (`id`,`roleId`,`pageOpBtnId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, b.`id`, 1, '站内消息（全员可用）'
FROM `usergroup` r
JOIN `pageopbtn` b ON b.`pagePath`='message.html'
WHERE r.`enabled`=1
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppagebtnset` p
      WHERE p.`roleId`=r.`id` AND p.`pageOpBtnId`=b.`id`
  );

-- 6) 回显
SELECT `id`,`code`,`nameCn`,`path`,`sortNo`,`enabled` FROM `menuinfros` WHERE `code`='MNU00022';
SELECT s.`id`, s.`sortNo`, m.`code`, m.`nameCn`, m.`path`
FROM `menugroupitemset` s JOIN `menuinfros` m ON m.`id`=s.`itemId`
WHERE s.`groupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1004') ORDER BY s.`sortNo`;
SELECT r.`nameCn` AS roleName, p.`menuItemId`, p.`enabled`
FROM `usergrouppowerset` p JOIN `usergroup` r ON r.`id`=p.`roleId`
WHERE p.`menuGroupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1004')
  AND p.`menuItemId`=(SELECT `id` FROM `menuinfros` WHERE `code`='MNU00022');
SELECT `btnId`,`btnText`,`sortNo`,`enabled` FROM `pageopbtn`
WHERE `pagePath`='message.html' ORDER BY `sortNo`;
SELECT r.`nameEn`, COUNT(*) AS btnCount
FROM `usergrouppagebtnset` p JOIN `usergroup` r ON r.`id`=p.`roleId`
JOIN `pageopbtn` b ON b.`id`=p.`pageOpBtnId`
WHERE b.`pagePath`='message.html' GROUP BY r.`nameEn`;
