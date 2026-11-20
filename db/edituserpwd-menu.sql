-- =====================================================================
-- 菜单数据：「帮助中心 → 修改密码」功能页（edituserpwd.html）落地
-- ---------------------------------------------------------------------
-- 背景：库里早就有菜单项 MNU000099「修改密码」，但功能页 edituserpwd.html 一直
--      没实现，点菜单只会提示「页面暂未实现」。本次补上页面，并把它钉成
--      **所有用户都有、且不受角色权限管控**的账号自助能力。
--
-- 本脚本做三件事（全部可重复执行，不删任何已有数据）：
--   1) menuinfros        确保 MNU000099 存在且 path=edituserpwd.html、启用；
--                        已存在时只校正「名称 / 路径 / 图标 / 启用」这四项，
--                        不覆盖 remark 等人工维护的字段；
--   2) menugroupitemset  绑定到「帮助中心」菜单组（MNG1000）第 1 位；
--   3) usergrouppowerset 给**全部启用角色**授权（数据层面先保证人人可见）。
--
-- 除此之外还有两道**不依赖授权数据**的兜底（改的是代码，不是这份 SQL）：
--   · server/service.py  build_nav()：NAV_ALWAYS_PATHS 里的菜单项在真实登录时
--     无条件放行 —— 即使有人在「角色权限配置」里取消勾选，入口依然在；
--   · js/btnperm.js      EXEMPT 名单包含 edituserpwd.html：页面按钮不按角色隐藏。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < edituserpwd-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项：修改密码（已存在则校正路径与启用状态）
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU000099','修改密码','mnuedituserpwd','edituserpwd.html','warning','1','1',
       '帮助中心：当前登录用户自助修改登录密码（所有角色可用，不受权限管控）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU000099');

UPDATE `menuinfros`
   SET `nameCn`='修改密码', `path`='edituserpwd.html', `icon`='warning', `enabled`=1
 WHERE `code`='MNU000099'
   AND (`path`<>'edituserpwd.html' OR `enabled`<>1
        OR `nameCn`<>'修改密码' OR IFNULL(`icon`,'')<>'warning');

-- 2) 绑定到「帮助中心」菜单组（MNG1000）第 1 位
INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 1, 1, '帮助中心-修改密码'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU000099'
WHERE g.`code`='MNG1000'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s
      WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

-- 3) 授权：所有**启用**角色都能看到「修改密码」
--    ⚠ 主键用 MD5(roleId+groupId+itemId) 而不是 UUID()：
--       INSERT ... SELECT 里 UUID() 只求值一次，多行会撞主键（实测 1062）。
INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT MD5(CONCAT(r.`id`,'-',g.`id`,'-',m.`id`)), r.`id`, g.`id`, m.`id`, 1, '帮助中心-修改密码（全角色）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1000'
JOIN `menuinfros` m ON m.`code`='MNU000099'
WHERE r.`enabled`=1
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.`roleId`=r.`id` AND p.`menuGroupId`=g.`id` AND p.`menuItemId`=m.`id`
  );

-- 4) 回显：菜单项 / 帮助中心组内顺序 / 已授权启用角色数
SELECT `code`,`nameCn`,`path`,`icon`,`enabled` FROM `menuinfros` WHERE `code`='MNU000099';

SELECT g.`code` AS groupCode, g.`nameCn` AS groupName, m.`code` AS itemCode, m.`nameCn` AS itemName,
       s.`sortNo` AS itemSort, s.`enabled` AS itemEnabled
FROM `menugroupitemset` s
JOIN `menugroupinfos` g ON g.`id`=s.`groupId`
JOIN `menuinfros` m ON m.`id`=s.`itemId`
WHERE g.`code`='MNG1000'
ORDER BY s.`sortNo`;

SELECT COUNT(*) AS grantedRoles
FROM `usergrouppowerset` p
JOIN `menuinfros` m ON m.`id`=p.`menuItemId`
WHERE m.`code`='MNU000099' AND p.`enabled`=1;
