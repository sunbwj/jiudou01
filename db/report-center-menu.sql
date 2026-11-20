-- =====================================================================
-- 菜单数据：数据中心 → 报表中心（report-center.html）
-- ---------------------------------------------------------------------
-- 说明：
--   · menuinfros        菜单项：MNU00015 / report-center.html
--   · menugroupitemset  绑定：数据中心（MNG1005）→ 报表中心（组内排序 3，排在「报表设计」之后）
--   · usergrouppowerset 角色授权：系统管理员整组授权（menuItemId=0，数据中心新增页面自动可见）
--   · 报表中心是只读页面（只有「查询 / 重置」两个按钮 + 卡片点击），不需要额外按钮授权；
--     想看停用报表仍然走「报表设计」
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < report-center-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项：报表中心
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00015','报表中心','ReportCenter','report-center.html','dashboard','3','1',
       '数据中心：按关键词 / 分类检索已启用的报表，卡片列表展示，点开即可填参执行、打印与导出'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00015');

-- 2) 绑定：数据中心 → 报表中心（组内排序 3）
INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 3, 1, '数据中心'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00015'
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
SELECT `id`,`code`,`nameCn`,`path`,`icon`,`sortNo`,`enabled` FROM `menuinfros` WHERE `code`='MNU00015';
SELECT s.`sortNo`, m.`code`, m.`nameCn`, m.`path`
FROM `menugroupitemset` s JOIN `menuinfros` m ON m.`id`=s.`itemId`
WHERE s.`groupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1005') ORDER BY s.`sortNo`;
