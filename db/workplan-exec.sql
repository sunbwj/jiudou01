-- =====================================================================
-- 工作计划：任务执行记录 + 工单与任务关联的增量脚本
-- ---------------------------------------------------------------------
-- 需求：
--   · 任务增加「完成状态 / 实际开始时间 / 实际结束时间 / 说明」等执行记录；
--   · 工单与计划中的任务明确关联（一任务一单，按 taskId JOIN 取执行记录）。
-- 设计要点：
--   · **可重复执行、非破坏性**：加列 / 加索引先查 information_schema；
--     不 DROP、不 DELETE、不 UPDATE 任何已有业务数据。
--   · 执行记录**只存在 workplantasks 一张表**里，工单不复制副本：
--     /workplan/orders 用 LEFT JOIN workplantasks 读取，/workplan/detail
--     用 LEFT JOIN workplanorders 回带工单编号，避免双写不一致。
--   · **不加物理外键**：整图保存是「先删该计划任务、再按前端 uuid 插回」，
--     外键会阻止删除已派工单的任务；关联由 uk_wporders_task(taskId) +
--     应用层 JOIN 保证，删掉任务时工单保留并标记 taskLinked=0。
--   · 老库已跑过 workplan.sql / workplan-people.sql / workplan-start.sql，
--     本脚本是它们的增量，可单独重复执行。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < workplan-exec.sql
-- 同步：db/workplan.sql（主建表）、db/rogerorm-schema.sql（全量建库）。
-- =====================================================================

SET NAMES utf8mb4;
SET @db := DATABASE();

-- ---------- 1) workplantasks：任务执行记录 ----------
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks' AND COLUMN_NAME = 'execStatus');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplantasks` ADD COLUMN `execStatus` VARCHAR(20) NOT NULL DEFAULT ''未开始'' COMMENT ''任务完成状态：未开始 / 进行中 / 已完成 / 已延期 / 已取消'' AFTER `progress`',
  'SELECT ''skip: workplantasks.execStatus 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks' AND COLUMN_NAME = 'actualStartDate');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplantasks` ADD COLUMN `actualStartDate` DATE DEFAULT NULL COMMENT ''实际开始时间（执行记录）'' AFTER `execStatus`',
  'SELECT ''skip: workplantasks.actualStartDate 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks' AND COLUMN_NAME = 'actualEndDate');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplantasks` ADD COLUMN `actualEndDate` DATE DEFAULT NULL COMMENT ''实际结束时间（执行记录）'' AFTER `actualStartDate`',
  'SELECT ''skip: workplantasks.actualEndDate 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks' AND COLUMN_NAME = 'execRemark');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplantasks` ADD COLUMN `execRemark` VARCHAR(1000) DEFAULT NULL COMMENT ''执行说明 / 完成记录'' AFTER `actualEndDate`',
  'SELECT ''skip: workplantasks.execRemark 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 按完成状态筛选 / 统计的索引（幂等）
SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks' AND INDEX_NAME = 'idx_workplantasks_exec');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplantasks` ADD KEY `idx_workplantasks_exec` (`execStatus`)',
  'SELECT ''skip: idx_workplantasks_exec 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------- 2) workplanorders：关联与执行快照的索引 ----------
-- taskId 已有 UNIQUE KEY uk_wporders_task，天然是关联索引；这里补一个按工单状态筛选的索引。
SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplanorders' AND INDEX_NAME = 'idx_wporders_status');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplanorders` ADD KEY `idx_wporders_status` (`status`)',
  'SELECT ''skip: idx_wporders_status 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------- 回显 ----------
SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks'
   AND COLUMN_NAME IN ('execStatus','actualStartDate','actualEndDate','execRemark')
 ORDER BY ORDINAL_POSITION;
SELECT TABLE_NAME, INDEX_NAME
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = @db
   AND ((TABLE_NAME = 'workplantasks' AND INDEX_NAME = 'idx_workplantasks_exec')
     OR (TABLE_NAME = 'workplanorders' AND INDEX_NAME IN ('uk_wporders_task','idx_wporders_status')))
 GROUP BY TABLE_NAME, INDEX_NAME ORDER BY TABLE_NAME, INDEX_NAME;
