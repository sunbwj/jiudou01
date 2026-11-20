-- =====================================================================
-- 下线「项目计划」功能入口（非破坏性 / 可随时恢复）
-- ---------------------------------------------------------------------
-- 需求：项目计划的功能去掉，由「工作计划（工作计划制定）」统一承接排期、
--       任务、执行记录与工单。
-- 做法：**只停用菜单与授权，不删除任何数据、不删表、不删页面文件、不删后端服务**。
--   · menuinfros MNU00023 enabled=0        → /api/nav 不再下发「项目计划」；
--   · menugroupitemset enabled=0           → 菜单组里不再挂载该项；
--   · usergrouppowerset enabled=0          → 角色授权不再放行；
--   · 项目详情页的「创建计划」按钮在前端移除（js/project.js 同步去掉绑定）。
-- 保留：projectplans / projectplanitems / projectworkorders / 附件表与历史数据，
--       project-plan*.html 页面与 ProjectPlanService（工作计划的通知 / 邮件 /
--       工单编号序列仍复用它的工具方法，删了会连带打断工作计划）。
-- 恢复：把下面三张表里这几条记录的 enabled 改回 1 即可，历史数据完好无损。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < workplan-retire-projectplan.sql
-- =====================================================================

SET NAMES utf8mb4;

UPDATE `menuinfros` SET `enabled` = 0
 WHERE `code` = 'MNU00023' AND `enabled` <> 0;

UPDATE `menugroupitemset` SET `enabled` = 0
 WHERE `enabled` <> 0
   AND `itemId` IN (SELECT `id` FROM (SELECT `id` FROM `menuinfros` WHERE `code` = 'MNU00023') AS m);

UPDATE `usergrouppowerset` SET `enabled` = 0
 WHERE `enabled` <> 0
   AND `menuItemId` IN (SELECT `id` FROM (SELECT `id` FROM `menuinfros` WHERE `code` = 'MNU00023') AS m2);

-- 回显：确认只有「项目计划」被停用，工作计划 / 我的任务仍启用
SELECT `code`,`nameCn`,`path`,`enabled` FROM `menuinfros`
 WHERE `code` IN ('MNU00023','MNU00024','MNU00025') ORDER BY `code`;
SELECT 'projectplans' AS `table`, COUNT(*) AS `rows_kept` FROM `projectplans`
UNION ALL SELECT 'projectplanitems', COUNT(*) FROM `projectplanitems`
UNION ALL SELECT 'projectworkorders', COUNT(*) FROM `projectworkorders`;
