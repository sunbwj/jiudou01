-- =====================================================================
-- 工作计划「启动执行」：计划状态 + 任务工单（workplanorders）
-- ---------------------------------------------------------------------
-- 需求：工作计划启动后，给每个任务的【责任人 + 参与人员】同时发送
--       ① 站内即时消息（emp_msgs，WS 实时推送）② 服务信箱通知邮件，
--       并为每个任务生成一张工单，推送到相关人员统一的「我的任务」列表。
-- 设计要点：
--   · **可重复执行、非破坏性**：加列先查 information_schema；建表 CREATE TABLE
--     IF NOT EXISTS；菜单 / 授权全部带 NOT EXISTS。不 DROP、不 UPDATE、
--     不 DELETE 任何已有业务数据（用户手工创建的 4 条工作计划保持原样）。
--   · 一个任务一张工单（uk_wporders_task）；重复启动只补派新增任务的工单，
--     已存在的工单只同步人员快照、不重复发通知（幂等）。
--   · 工单编号 WO + 6 位，与项目计划 v2 的 projectworkorders 共用同一序列，
--     由后端跨两表取最大值生成，保证全局不重复。
--   · 「我的任务」页（MNU00025）合并展示工作计划工单与项目计划事项工单：
--     工作计划按 ownerId OR FIND_IN_SET(empId, participantIds) 归属，
--     项目计划按 ownerId 归属；两类都进同一个任务列表，用户找得到。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < workplan-start.sql
-- 同步：db/workplan.sql（主建表）、db/rogerorm-schema.sql（全量建库）。
-- =====================================================================

SET NAMES utf8mb4;
SET @db := DATABASE();

-- ---------- 1) workplans：启动状态 / 启动时间 / 启动人 ----------
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplans' AND COLUMN_NAME = 'status');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplans` ADD COLUMN `status` VARCHAR(20) NOT NULL DEFAULT ''未启动'' COMMENT ''启动状态：未启动 / 已启动'' AFTER `enabled`',
  'SELECT ''skip: workplans.status 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplans' AND COLUMN_NAME = 'startTime');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplans` ADD COLUMN `startTime` DATETIME DEFAULT NULL COMMENT ''最近一次启动时间'' AFTER `status`',
  'SELECT ''skip: workplans.startTime 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplans' AND COLUMN_NAME = 'startEname');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplans` ADD COLUMN `startEname` VARCHAR(100) DEFAULT NULL COMMENT ''启动人姓名'' AFTER `startTime`',
  'SELECT ''skip: workplans.startEname 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplans' AND COLUMN_NAME = 'startempinfosid');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplans` ADD COLUMN `startempinfosid` BIGINT UNSIGNED DEFAULT NULL COMMENT ''启动人员工ID'' AFTER `startEname`',
  'SELECT ''skip: workplans.startempinfosid 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------- 2) workplanorders：一任务一工单 ----------
CREATE TABLE IF NOT EXISTS `workplanorders` (
  `id`               CHAR(36)        NOT NULL                     COMMENT '工单ID（UUID）',
  `taskId`           CHAR(36)        NOT NULL                     COMMENT '来源任务（workplantasks.id，一任务一单）',
  `planId`           CHAR(36)        NOT NULL                     COMMENT '所属工作计划（workplans.id）',
  `projectId`        CHAR(36)        DEFAULT NULL                 COMMENT '关联项目（可空）',
  `planCode`         VARCHAR(30)     DEFAULT NULL                 COMMENT '计划编号快照（WP + 6 位）',
  `planName`         VARCHAR(150)    DEFAULT NULL                 COMMENT '计划名称快照',
  `orderCode`        VARCHAR(30)     NOT NULL                     COMMENT '工单编号（WO + 6 位，跨两张工单表全局唯一）',
  `orderTitle`       VARCHAR(200)    NOT NULL                     COMMENT '工单标题（取任务名称）',
  `taskType`         VARCHAR(20)     NOT NULL DEFAULT 'task'      COMMENT 'task / milestone / summary',
  `startDate`        DATE            DEFAULT NULL                 COMMENT '任务计划开始日期',
  `endDate`          DATE            DEFAULT NULL                 COMMENT '任务计划结束日期',
  `ownerId`          BIGINT UNSIGNED NOT NULL DEFAULT 0          COMMENT '责任人员工ID',
  `ownerName`        VARCHAR(50)     DEFAULT NULL                 COMMENT '责任人姓名快照',
  `ownerEmail`       VARCHAR(100)    DEFAULT NULL                 COMMENT '责任人邮箱快照',
  `participantIds`   TEXT            DEFAULT NULL                 COMMENT '参与人员ID（逗号分隔，进入其任务列表）',
  `participantNames` TEXT            DEFAULT NULL                 COMMENT '参与人员姓名快照（逗号分隔）',
  `status`           VARCHAR(20)     NOT NULL DEFAULT '待处理'     COMMENT '工单状态：待处理 / 处理中 / 已完成',
  `dispatchTime`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '派送时间',
  `noticeMsg`        TINYINT(1)      NOT NULL DEFAULT 0          COMMENT '是否已发站内即时消息',
  `noticeMail`       TINYINT(1)      NOT NULL DEFAULT 0          COMMENT '是否已发通知邮件',
  `noticeTime`       DATETIME        DEFAULT NULL                 COMMENT '最近一次通知时间',
  `remark`           VARCHAR(500)    DEFAULT NULL                 COMMENT '备注（通知失败原因等）',
  `createTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_wporders_code` (`orderCode`),
  UNIQUE KEY `uk_wporders_task` (`taskId`),
  KEY `idx_wporders_plan` (`planId`),
  KEY `idx_wporders_owner` (`ownerId`),
  KEY `idx_wporders_dispatch` (`dispatchTime`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作计划任务工单（启动后一任务一单，推送到责任人与参与人任务列表）';

-- ---------- 3) 菜单：项目管理 → 我的任务（MNU00025） ----------
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00025','我的任务','MyWorkTasks','workplan-task.html','calendar','20','1',
       '统一的个人任务列表：工作计划任务工单（责任人 / 参与人）+ 项目计划事项工单（责任人）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00025');

INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 5, 1, '项目管理'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00025'
WHERE g.`code`='MNG1006'
  AND NOT EXISTS (SELECT 1 FROM `menugroupitemset` s WHERE s.groupId=g.`id` AND s.itemId=m.`id`);

INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, g.`id`, m.`id`, 1, '我的任务（系统管理员）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1006'
JOIN `menuinfros` m ON m.`code`='MNU00025'
WHERE r.`nameEn`='SystemAdmin'
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.roleId=r.`id` AND p.menuGroupId=g.`id` AND p.menuItemId=m.`id`
  );

-- 回显
SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplans'
   AND COLUMN_NAME IN ('status','startTime','startEname','startempinfosid')
 ORDER BY ORDINAL_POSITION;
SELECT 'workplanorders' AS `table`, COUNT(*) AS `columns`
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplanorders';
SELECT `code`,`nameCn`,`path`,`enabled` FROM `menuinfros` WHERE `code` IN ('MNU00024','MNU00025');
