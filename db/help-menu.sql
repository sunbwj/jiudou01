-- =====================================================================
-- 菜单数据：帮助中心下新增「使用说明书」功能页（help.html）
-- ---------------------------------------------------------------------
--   · menuinfros        新增菜单项 MNU00027 / help.html（显示名「使用说明书」）
--   · menugroupitemset  绑定到已有的「帮助中心」菜单组（MNG1000）第 2 位
--   · usergrouppowerset 给**全部启用角色**授权（说明书对所有人都该可见）
-- 说明：
--   · 可重复执行（全部带 NOT EXISTS），不改 / 不删任何已有菜单与授权；
--   · 「帮助中心」组（MNG1000，sortNo 99，顶级）数据库里已存在，当前只挂了
--     MNU000099「修改密码」，本脚本只在后面追加一条，不动原有绑定；
--   · help.html 的操作按钮放在自定义容器 .help-tools（不是 .toolbar），
--     刻意不进 pageopbtn —— 打印/置顶按钮不该被角色按钮权限隐藏；
--   · 页面本身是纯静态内容 + 客户端渲染（js/help.js），后端无需新增接口。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < help-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项：使用说明书
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00027','使用说明书','HelpGuide','help.html','document','27','1',
       '帮助中心：系统使用说明书（操作手册 / 状态流转 / 页面速查 / 按账号生成的实时功能地图）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00027' OR `path`='help.html');

-- 2) 绑定到「帮助中心」菜单组（MNG1000）第 2 位（第 1 位是「修改密码」）
INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 2, 1, '帮助中心-使用说明书'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00027'
WHERE g.`code`='MNG1000'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s
      WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

-- 3) 授权：所有**启用**角色都能看到说明书的菜单项
--    （菜单按角色过滤，不授权的话左侧导航里不会出现这一项）
--    ⚠ 主键用 MD5(roleId+groupId+itemId) 而不是 UUID()：
--       INSERT ... SELECT 里 UUID() 只求值一次，多行会撞主键（实测报 1062）。
INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT MD5(CONCAT(r.`id`,'-',g.`id`,'-',m.`id`)), r.`id`, g.`id`, m.`id`, 1, '帮助中心-使用说明书（全角色）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1000'
JOIN `menuinfros` m ON m.`code`='MNU00027'
WHERE r.`enabled`=1
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.`roleId`=r.`id` AND p.`menuGroupId`=g.`id` AND p.`menuItemId`=m.`id`
  );

-- 4) 回显：菜单项、所在组、组内顺序、已授权角色数
SELECT `code`,`nameCn`,`path`,`icon`,`enabled` FROM `menuinfros` WHERE `code`='MNU00027';

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
WHERE m.`code`='MNU00027' AND p.`enabled`=1;
