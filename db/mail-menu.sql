-- =====================================================================
-- 菜单数据：新增「邮件中心」菜单组 + 两个功能页（服务信箱设置 / 邮箱助手）
-- ---------------------------------------------------------------------
-- 说明：
--   · menuinfros        菜单项（功能页面）
--   · menugroupinfos    菜单组（parentId=0 表示顶级）
--   · menugroupitemset  菜单组 ↔ 菜单项 绑定（sortNo 控制组内顺序）
--   · usergrouppowerset 角色权限：系统管理员授权「邮件中心」整组（menuItemId=0 表示展开整组）
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < mail-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项：服务信箱设置 / 邮箱助手
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00010','服务信箱设置','ServiceEmail','service-email.html','mail','1','1','服务信箱（收件/发件账号）设置'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00010');

INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00011','邮箱助手','MailAssistant','mail.html','message','2','1','服务信箱自动收件、查看邮件、写发邮件'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00011');

-- 2) 菜单组：邮件中心（顶级，排序号 40：排在人力资源中心之后、系统管理之前）
INSERT INTO `menugroupinfos` (`parentId`,`level`,`sortNo`,`code`,`nameCn`,`nameEn`,`hasChild`,`path`,`icon`,`enabled`)
SELECT 0,1,40,'MNG1004','邮件中心','MailCenter',1,'','mail',1
WHERE NOT EXISTS (SELECT 1 FROM `menugroupinfos` WHERE `code`='MNG1004');

-- 3) 绑定：邮件中心 → 服务信箱设置(1) / 邮箱助手(2)
INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, m.`sortNo`, 1, '邮件中心'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code` IN ('MNU00010','MNU00011')
WHERE g.`code`='MNG1004'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

-- 4) 角色授权：系统管理员（整组授权：menuItemId=0 → 展开整组所有菜单项）
INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, g.`id`, 0, 1, '邮件中心（整组授权）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1004'
WHERE r.`nameEn`='SystemAdmin'
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.`roleId`=r.`id` AND p.`menuGroupId`=g.`id` AND p.`menuItemId`=0
  );

-- 5) 回显
SELECT `id`,`code`,`nameCn`,`path`,`sortNo`,`enabled` FROM `menuinfros` WHERE `code` IN ('MNU00010','MNU00011');
SELECT `id`,`code`,`nameCn`,`parentId`,`sortNo`,`hasChild`,`icon`,`enabled` FROM `menugroupinfos` WHERE `code`='MNG1004';
SELECT s.`id`, s.`groupId`, s.`itemId`, s.`sortNo`, m.`nameCn`
FROM `menugroupitemset` s JOIN `menuinfros` m ON m.`id`=s.`itemId`
WHERE s.`groupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1004') ORDER BY s.`sortNo`;
