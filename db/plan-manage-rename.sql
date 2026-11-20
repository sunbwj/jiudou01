-- =====================================================================
-- 菜单改名：项目管理下的「工作计划」→「计划管理」（2026-11-09）
-- ---------------------------------------------------------------------
-- 只改**显示名**，不动 code / nameEn / path / id / 排序 / 启用状态：
--   · menuinfros.nameCn          '工作计划'            → '计划管理'（MNU00024，workplan.html）
--   · usergrouppowerset.remark   '工作计划（系统管理员）' → '计划管理（系统管理员）'
-- 说明：
--   · 可重复执行：WHERE 里带旧值判断，第二次执行影响 0 行；
--   · 可回滚：把下面两条 UPDATE 的新旧值对调再执行即可；
--   · 页面标题 / 页内左菜单文字在 HTML 里，跟着一起改（workplan*.html）。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < plan-manage-rename.sql
-- =====================================================================

SET NAMES utf8mb4;

UPDATE `menuinfros`
   SET `nameCn` = '计划管理'
 WHERE `code` = 'MNU00024'
   AND `nameCn` = '工作计划';

UPDATE `usergrouppowerset`
   SET `remark` = '计划管理（系统管理员）'
 WHERE `remark` = '工作计划（系统管理员）';

-- 回显（nameCn 应为「计划管理」）
SELECT `code`, `nameCn`, `nameEn`, `path`, `enabled`
  FROM `menuinfros`
 WHERE `code` = 'MNU00024';
