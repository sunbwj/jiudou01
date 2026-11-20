-- =====================================================================
-- 项目管理：项目工单（projectworkorders）
-- ---------------------------------------------------------------------
-- 用途：
--   · 项目计划「启动执行」时，为每条计划事项 / 任务自动生成一张工单，派送给计划责任人；
--   · 工单编号自动生成 WO + 6 位流水号；
--   · 派送时向责任人推送站内即时消息（含工单链接）并按需发送通知邮件，
--     结果记在 noticeMsg / noticeMail，便于排查「为什么没收到」。
-- 约定：主键 UUID；orderCode 唯一；同一计划只保留一张有效工单（uk_workorders_plan）。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < projectworkorders.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `projectworkorders` (
  `id`           CHAR(36)        NOT NULL                        COMMENT '工单ID（UUID 主键）',
  `planId`       CHAR(36)        NOT NULL                        COMMENT '来源计划（projectplans.id）',
  `projectId`    CHAR(36)        NOT NULL                        COMMENT '所属项目（projectinfos.id）',
  `orderCode`    VARCHAR(30)     NOT NULL                        COMMENT '工单编号（WO + 6 位流水号，唯一）',
  `orderTitle`   VARCHAR(200)    NOT NULL                        COMMENT '工单标题（取计划名称）',
  `orderDesc`    TEXT            DEFAULT NULL                    COMMENT '工单说明（取计划说明）',
  `ownerId`      BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '责任人员工ID',
  `ownerName`    VARCHAR(50)     DEFAULT NULL                    COMMENT '责任人姓名快照',
  `ownerEmail`   VARCHAR(100)    DEFAULT NULL                    COMMENT '责任人邮箱快照',
  `status`       VARCHAR(20)     NOT NULL DEFAULT '待处理'        COMMENT '状态：待处理 / 处理中 / 已完成',
  `dispatchTime` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '派送时间',
  `noticeMsg`    TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '派送时是否已发站内消息',
  `noticeMail`   TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '派送时是否已发邮件',
  `noticeTime`   DATETIME        DEFAULT NULL                    COMMENT '最近一次通知时间',
  `remark`       VARCHAR(200)    DEFAULT NULL                    COMMENT '备注（通知失败原因等）',
  `createTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workorders_code` (`orderCode`),
  UNIQUE KEY `uk_workorders_plan` (`planId`),
  KEY `idx_workorders_project` (`projectId`),
  KEY `idx_workorders_owner` (`ownerId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='项目工单（计划启动执行时自动派送）';
