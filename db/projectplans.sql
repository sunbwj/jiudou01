-- =====================================================================
-- 项目管理：项目计划（projectplans）
-- ---------------------------------------------------------------------
-- 用途：
--   · 一个项目下的「计划事项 / 任务」两级结构：planType=事项（可挂任务）或 任务（parentId 指向事项）；
--   · 计划编号自动生成 PLN + 6 位流水号；
--   · 指定责任人（ownerId）时，后端自动向该员工推送站内即时消息（内容含计划链接）
--     并同步发送通知邮件（员工信息里有邮箱才发），结果记在 noticeMsg / noticeMail；
--   · 「启动执行」把未启动的计划置 started=1、status=进行中，并为每条计划生成项目工单
--     （projectworkorders），工单派送同样会通知责任人。
-- 约定：主键 UUID；planCode 唯一；同一项目内计划名称唯一。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < projectplans.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `projectplans` (
  `id`               CHAR(36)        NOT NULL                        COMMENT '计划ID（UUID 主键）',
  `projectId`        CHAR(36)        NOT NULL                        COMMENT '所属项目（projectinfos.id）',
  `parentId`         CHAR(36)        DEFAULT NULL                    COMMENT '上级事项ID（任务挂事项；空=顶级）',
  `planCode`         VARCHAR(30)     NOT NULL                        COMMENT '计划编号（PLN + 6 位流水号，唯一）',
  `planName`         VARCHAR(150)    NOT NULL                        COMMENT '计划事项 / 任务名称',
  `planType`         VARCHAR(20)     NOT NULL DEFAULT '事项'          COMMENT '类型：事项 / 任务',
  `planDesc`         TEXT            DEFAULT NULL                    COMMENT '计划说明',
  `ownerId`          BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '责任人员工ID（empinfos.id）',
  `ownerName`        VARCHAR(50)     DEFAULT NULL                    COMMENT '责任人姓名快照',
  `ownerEmail`       VARCHAR(100)    DEFAULT NULL                    COMMENT '责任人邮箱快照（空=不发邮件）',
  `startDate`        DATE            DEFAULT NULL                    COMMENT '计划开始日期',
  `endDate`          DATE            DEFAULT NULL                    COMMENT '计划结束日期',
  `status`           VARCHAR(20)     NOT NULL DEFAULT '未开始'        COMMENT '状态：未开始 / 进行中 / 已完成 / 已暂停',
  `started`          TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '是否已启动执行：1-已生成工单',
  `startTime`        DATETIME        DEFAULT NULL                    COMMENT '启动执行时间',
  `noticeMsg`        TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '责任人是否已收到站内消息',
  `noticeMail`       TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '责任人是否已收到邮件',
  `noticeTime`       DATETIME        DEFAULT NULL                    COMMENT '最近一次通知时间',
  `createEname`      VARCHAR(100)    DEFAULT NULL                    COMMENT '创建人姓名',
  `createempinfosid` BIGINT UNSIGNED DEFAULT NULL                    COMMENT '创建人员工ID',
  `enabled`          TINYINT(1)      NOT NULL DEFAULT 1              COMMENT '启用否',
  `createTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_projectplans_code` (`planCode`),
  UNIQUE KEY `uk_projectplans_project_name` (`projectId`, `planName`),
  KEY `idx_projectplans_project` (`projectId`),
  KEY `idx_projectplans_owner` (`ownerId`),
  KEY `idx_projectplans_parent` (`parentId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='项目计划事项 / 任务（指定责任人时自动通知）';
