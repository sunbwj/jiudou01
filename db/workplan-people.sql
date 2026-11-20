-- =====================================================================
-- 工作计划任务：责任人 / 参与人员（从员工信息选取）
-- ---------------------------------------------------------------------
-- 背景：workplantasks 原只有自由文本 ownerName。现把责任人改为关联 empinfos.id
--       （ownerId + ownerName 快照），并新增参与人员（ID / 姓名双快照，逗号分隔）。
--       口径与「项目计划 v2」projectplanitems 的 ownerId / participantIds /
--       participantNames 保持一致，便于以后互通。
-- 设计要点：
--   · **可重复执行、非破坏性**：先查 information_schema 再决定是否 ADD COLUMN，
--     不 DROP、不 UPDATE、不 DELETE 任何已有业务数据；
--   · 老数据 ownerName 原样保留，ownerId 默认 0（表示「未关联员工」）；
--   · 参与人员只存快照，不建外键，避免员工离职 / 删除时计划无法保存。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < workplan-people.sql
-- =====================================================================

SET NAMES utf8mb4;
SET @db := DATABASE();

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks' AND COLUMN_NAME = 'ownerId');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplantasks` ADD COLUMN `ownerId` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''责任人（empinfos.id，0=未指定）'' AFTER `ownerName`',
  'SELECT ''skip: workplantasks.ownerId 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks' AND COLUMN_NAME = 'participantIds');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplantasks` ADD COLUMN `participantIds` TEXT DEFAULT NULL COMMENT ''参与人员ID（empinfos.id，逗号分隔）'' AFTER `ownerId`',
  'SELECT ''skip: workplantasks.participantIds 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks' AND COLUMN_NAME = 'participantNames');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplantasks` ADD COLUMN `participantNames` TEXT DEFAULT NULL COMMENT ''参与人员姓名快照（逗号分隔）'' AFTER `participantIds`',
  'SELECT ''skip: workplantasks.participantNames 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks' AND INDEX_NAME = 'idx_workplantasks_owner');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplantasks` ADD KEY `idx_workplantasks_owner` (`ownerId`)',
  'SELECT ''skip: idx_workplantasks_owner 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 回显：确认四列 / 索引都在，且不改动任何已有数据
SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, COLUMN_COMMENT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks'
   AND COLUMN_NAME IN ('ownerName','ownerId','participantIds','participantNames')
 ORDER BY ORDINAL_POSITION;
