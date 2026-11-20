-- =====================================================================
-- 菜单数据：新增「数据中心」菜单组 + 「数据库」功能页（dbinfo.html）
-- ---------------------------------------------------------------------
-- 说明：
--   · menuinfros        菜单项：MNU00013 / dbinfo.html
--   · menugroupinfos    菜单组：MNG1005「数据中心」（顶级，sortNo=50：排在邮件中心之后、系统管理之前）
--   · menugroupitemset  绑定：数据中心 → 数据库（组内排序 1）
--   · usergrouppowerset 角色授权：系统管理员整组授权（menuItemId=0，后续数据中心新增页面自动可见）
--   · 该页面含新增 / 编辑 / 启用 / 停用 / 测试连接 / 扫描结构 / 删除 等按钮，
--     按钮权限由「页面操作按钮」自动收录（pageopbtn scan）后在各角色的「角色权限配置」里勾选
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < dbinfo-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项：数据库
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00013','数据库','DbInfoMgr','dbinfo.html','tool','1','1','数据中心：数据库信息维护 + 实例/表/视图/字段扫描 + SQL 查询'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00013');

-- 2) 菜单组：数据中心（顶级，排序号 50）
INSERT INTO `menugroupinfos` (`parentId`,`level`,`sortNo`,`code`,`nameCn`,`nameEn`,`hasChild`,`path`,`icon`,`enabled`)
SELECT 0,1,50,'MNG1005','数据中心','DataCenter',1,'','dashboard',1
WHERE NOT EXISTS (SELECT 1 FROM `menugroupinfos` WHERE `code`='MNG1005');

-- 3) 绑定：数据中心 → 数据库
INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 1, 1, '数据中心'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00013'
WHERE g.`code`='MNG1005'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

-- 4) 角色授权：系统管理员（整组授权）
INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, g.`id`, 0, 1, '数据中心（整组授权）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1005'
WHERE r.`nameEn`='SystemAdmin'
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.`roleId`=r.`id` AND p.`menuGroupId`=g.`id` AND p.`menuItemId`=0
  );

-- 5) 回显
SELECT `id`,`code`,`nameCn`,`path`,`icon`,`sortNo`,`enabled` FROM `menuinfros` WHERE `code`='MNU00013';
SELECT `id`,`code`,`nameCn`,`parentId`,`sortNo`,`hasChild`,`icon`,`enabled` FROM `menugroupinfos` WHERE `code`='MNG1005';
SELECT s.`id`, s.`groupId`, s.`itemId`, s.`sortNo`, m.`nameCn`
FROM `menugroupitemset` s JOIN `menuinfros` m ON m.`id`=s.`itemId`
WHERE s.`groupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1005') ORDER BY s.`sortNo`;
SELECT p.`roleId`, p.`menuGroupId`, p.`menuItemId`, p.`enabled`
FROM `usergrouppowerset` p
WHERE p.`menuGroupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1005');
