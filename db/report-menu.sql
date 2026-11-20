-- =====================================================================
-- 菜单数据：数据中心 → 报表设计（report-designer.html）
-- ---------------------------------------------------------------------
-- 说明：
--   · menuinfros        菜单项：MNU00014 / report-designer.html
--   · menugroupitemset  绑定：数据中心（MNG1005）→ 报表设计（组内排序 2，排在「数据库」之后）
--   · usergrouppowerset 角色授权：系统管理员整组授权（menuItemId=0，数据中心新增页面自动可见）
--   · 页面按钮（保存 / 预览 / 新建 / 复制 / 删除 …）由「页面操作按钮」扫描收录后，
--     在各角色的「角色权限配置」里按需勾选
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < report-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项：报表设计
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00014','报表设计','ReportDesigner','report-designer.html','chart','2','1',
       '数据中心：拖拽字段设计报表（参数 / 页面模板 / 预览），保存到报表信息表 reportinfos 供后续调用'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00014');

-- 2) 绑定：数据中心 → 报表设计（组内排序 2）
INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 2, 1, '数据中心'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00014'
WHERE g.`code`='MNG1005'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

-- 3) 角色授权：系统管理员（整组授权，若已有整组授权则跳过）
INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, g.`id`, 0, 1, '数据中心（整组授权）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1005'
WHERE r.`nameEn`='SystemAdmin'
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.`roleId`=r.`id` AND p.`menuGroupId`=g.`id` AND p.`menuItemId`=0
  );

-- 4) 回显
SELECT `id`,`code`,`nameCn`,`path`,`icon`,`sortNo`,`enabled` FROM `menuinfros` WHERE `code`='MNU00014';
SELECT s.`id`, s.`groupId`, s.`itemId`, s.`sortNo`, m.`nameCn`
FROM `menugroupitemset` s JOIN `menuinfros` m ON m.`id`=s.`itemId`
WHERE s.`groupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1005') ORDER BY s.`sortNo`;
