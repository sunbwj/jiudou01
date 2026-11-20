-- =====================================================================
-- 菜单数据：项目管理下新增「计划管理」功能页（workplan.html，原名「工作计划」）
-- ---------------------------------------------------------------------
--   · menuinfros        菜单项 MNU00024 / workplan.html（显示名「计划管理」）
--   · menugroupitemset  绑定到 MNG1006「项目管理」第 4 位
--   · usergrouppowerset 系统管理员整组授权（与项目计划 MNU00023 同款）
-- 说明：
--   · 可重复执行（全部带 NOT EXISTS），不改 / 不删任何已有菜单与授权；
--   · 设计器页 workplan-design.html 是打页子页，不进菜单、不出现在 /api/nav 与首页卡片；
--   · 新页面的操作区使用自定义容器 .wp-toolbar（**不带 .toolbar**），
--     因此不会被 server/page_scan.py 收录进 pageopbtn —— 与 project.html 右栏
--     .pj-filepanel__actions 同一处理：不对按钮做角色筛选，所有角色都能用。
--     若以后要纳入「页面按钮维护」，把容器 class 改成 toolbar 后重新收录并逐角色授权即可。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < workplan-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00024','计划管理','WorkPlans','workplan.html','calendar','19','1',
       '项目管理：计划管理（Visio 风格排期，甘特图 / 时间线 / 里程碑 / 依赖 / 完成百分比）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00024');

INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 4, 1, '项目管理'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00024'
WHERE g.`code`='MNG1006'
  AND NOT EXISTS (SELECT 1 FROM `menugroupitemset` s WHERE s.groupId=g.`id` AND s.itemId=m.`id`);

INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, g.`id`, m.`id`, 1, '计划管理（系统管理员）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1006'
JOIN `menuinfros` m ON m.`code`='MNU00024'
WHERE r.`nameEn`='SystemAdmin'
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.roleId=r.`id` AND p.menuGroupId=g.`id` AND p.menuItemId=m.`id`
  );

-- 回显
SELECT `code`,`nameCn`,`path`,`enabled` FROM `menuinfros` WHERE `code`='MNU00024';
