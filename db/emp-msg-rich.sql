-- =====================================================================
-- 即时对话：消息富文本正文 + 群聊 @ 组员（emp_msgs 增量脚本）
-- ---------------------------------------------------------------------
-- 需求：
--   · 即时对话页查看消息 / 发送消息支持富文本（加粗、颜色、列表、链接等）；
--   · 群聊发消息时可 @ 某组员，被 @ 的人在自己消息流里能一眼看到。
-- 设计要点：
--   · **content 仍存纯文本**：列表摘要、联系人「最近一条」、未读摘要、搜索都靠它，
--     富文本另存 contentHtml（编辑器产出的 HTML 片段，渲染前由前端 RichText.sanitize 清洗）。
--     这样老数据（只有 content）照旧正常显示，不需要数据回填。
--   · **atEmpIds 存逗号分隔的 empId**（如 "12,30"），后端只保留「确实是该群成员」的 id：
--     前端传什么都不可信，也不是所有被 @ 的人都还在群里。
--   · **可重复执行、非破坏性**：加列前查 information_schema，不 DROP / 不 UPDATE 已有数据。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/emp-msg-rich.sql
-- 同步：db/emp-message.sql（主建表）、db/rogerorm-schema.sql（全量建库）。
-- =====================================================================

SET NAMES utf8mb4;
SET @db := DATABASE();

-- ---------- 1) emp_msgs.contentHtml：富文本正文 ----------
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'emp_msgs' AND COLUMN_NAME = 'contentHtml');
SET @sql := IF(@has = 0,
  'ALTER TABLE `emp_msgs` ADD COLUMN `contentHtml` MEDIUMTEXT COMMENT ''富文本正文（HTML 片段；空=纯文本消息，渲染时用 content）'' AFTER `content`',
  'SELECT ''skip: emp_msgs.contentHtml 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------- 2) emp_msgs.atEmpIds：群聊 @ 到的组员 ----------
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'emp_msgs' AND COLUMN_NAME = 'atEmpIds');
SET @sql := IF(@has = 0,
  'ALTER TABLE `emp_msgs` ADD COLUMN `atEmpIds` VARCHAR(500) NOT NULL DEFAULT '''' COMMENT ''群聊 @ 到的组员 empId（逗号分隔；私聊恒为空）'' AFTER `groupId`',
  'SELECT ''skip: emp_msgs.atEmpIds 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------- 3) 结构回显（便于人工核对） ----------
SELECT `COLUMN_NAME` AS `列名`, `COLUMN_TYPE` AS `类型`, `IS_NULLABLE` AS `可空`,
       `COLUMN_DEFAULT` AS `默认值`, `COLUMN_COMMENT` AS `说明`
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'emp_msgs'
  AND COLUMN_NAME IN ('content', 'contentHtml', 'groupId', 'atEmpIds')
ORDER BY `ORDINAL_POSITION`;
