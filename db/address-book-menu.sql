-- =====================================================================
-- 菜单数据：新增「员工通讯录」功能页（挂在「人力资源中心」菜单组下）
-- ---------------------------------------------------------------------
-- 说明：
--   · menuinfros        菜单项（功能页面）：MNU00012 / address-book.html
--   · menugroupitemset  绑定到人力资源中心（MNG1001），组内排序号 3（排在组织架构、员工信息管理之后）
--   · usergrouppowerset 角色授权：系统管理员可访问（人力资源中心组是按菜单项逐个授权的）
--   · 该页面**只读**（只有查询），没有新增 / 编辑 / 删除按钮，因此不需要额外的按钮权限
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < address-book-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项：员工通讯录
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00012','员工通讯录','AddressBook','address-book.html','user','3','1','按组织架构查询员工联系方式（只读）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00012');

-- 2) 绑定：人力资源中心 → 员工通讯录（组内排序号 3）
INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 3, 1, '人力资源中心'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00012'
WHERE g.`code`='MNG1001'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

-- 3) 角色授权：系统管理员（按菜单项授权，与同组其它菜单项一致）
INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, g.`id`, m.`id`, 1, '人力资源中心-员工通讯录'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1001'
JOIN `menuinfros` m ON m.`code`='MNU00012'
WHERE r.`nameEn`='SystemAdmin'
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.`roleId`=r.`id` AND p.`menuGroupId`=g.`id` AND p.`menuItemId`=m.`id`
  );

-- 4) 回显
SELECT `id`,`code`,`nameCn`,`path`,`icon`,`sortNo`,`enabled` FROM `menuinfros` WHERE `code`='MNU00012';
SELECT s.`groupId`, s.`itemId`, s.`sortNo`, m.`nameCn`
FROM `menugroupitemset` s JOIN `menuinfros` m ON m.`id`=s.`itemId`
WHERE s.`groupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1001') ORDER BY s.`sortNo`;
SELECT p.`roleId`, p.`menuGroupId`, p.`menuItemId`, m.`nameCn`
FROM `usergrouppowerset` p JOIN `menuinfros` m ON m.`id`=p.`menuItemId`
WHERE p.`menuGroupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1001');
