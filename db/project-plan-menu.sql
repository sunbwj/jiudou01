-- =====================================================================
-- 菜单数据：项目管理下新增「项目计划」功能页（project-plan.html）
-- ---------------------------------------------------------------------
--   · menuinfros        菜单项 MNU00023 / project-plan.html
--   · menugroupitemset  绑定到 MNG1006「项目管理」第 3 位
--   · usergrouppowerset 系统管理员整组授权（menuItemId=0 已覆盖，这里补一条显式授权）
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < project-plan-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00023','项目计划','ProjectPlans','project-plan.html','calendar','18','1',
       '项目管理：计划事项 / 任务（责任人自动通知、启动执行生成工单）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00023');

INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 3, 1, '项目管理'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00023'
WHERE g.`code`='MNG1006'
  AND NOT EXISTS (SELECT 1 FROM `menugroupitemset` s WHERE s.groupId=g.`id` AND s.itemId=m.`id`);

INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, g.`id`, m.`id`, 1, '项目计划（系统管理员）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1006'
JOIN `menuinfros` m ON m.`code`='MNU00023'
WHERE r.`nameEn`='SystemAdmin'
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.roleId=r.`id` AND p.menuGroupId=g.`id` AND p.menuItemId=m.`id`
  );

-- 其它角色按需在「角色权限配置」里授权；管理员整组授权后新页面自动可见。
