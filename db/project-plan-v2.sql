-- =====================================================================
-- 项目计划 v2：计划 / 计划事项 / 事项工单 / 事项附件（重构版）
-- ---------------------------------------------------------------------
-- 层级：项目 → 计划（多个）→ 计划事项或任务（多个）→ 工单（一事项一单）+ 附件（多个）
--   · projectplans        计划：PL + 6 位流水号，含所属项目 / 起止时间段 / 说明；
--   · projectplanitems    计划事项或任务：IT + 6 位，含前置事项、输入条件、里程碑输出、
--                         计划起止时间、责任人、参与人员、状态（字典 project_plan_item_status）；
--   · projectworkorders   工单：WO + 6 位，itemId 唯一（一个事项一张工单），派送时通知责任人；
--   · projectplanitemfiles 事项附件：每个事项可上传多个文件，支持在线预览（图/pdf/txt/docx/xlsx/pptx）。
-- 说明：本脚本按「开发期重建」编写（先 DROP 再建），因为 v1 的两张表结构不同且无业务数据。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < project-plan-v2.sql
-- =====================================================================

SET NAMES utf8mb4;

DROP TABLE IF EXISTS `projectplanitemfiles`;
DROP TABLE IF EXISTS `projectworkorders`;
DROP TABLE IF EXISTS `projectplanitems`;
DROP TABLE IF EXISTS `projectplans`;

CREATE TABLE `projectplans` (
  `id`               CHAR(36)        NOT NULL                        COMMENT '计划ID（UUID）',
  `projectId`        CHAR(36)        NOT NULL                        COMMENT '所属项目（projectinfos.id）',
  `planCode`         VARCHAR(30)     NOT NULL                        COMMENT '计划编号（PL + 6 位流水号，唯一）',
  `planName`         VARCHAR(150)    NOT NULL DEFAULT ''             COMMENT '计划名称（可选，便于识别）',
  `startDate`        DATE            DEFAULT NULL                    COMMENT '计划开始日期',
  `endDate`          DATE            DEFAULT NULL                    COMMENT '计划结束日期',
  `planDesc`         TEXT            DEFAULT NULL                    COMMENT '计划说明',
  `createEname`      VARCHAR(100)    DEFAULT NULL                    COMMENT '创建人姓名',
  `createempinfosid` BIGINT UNSIGNED DEFAULT NULL                    COMMENT '创建人员工ID',
  `enabled`          TINYINT(1)      NOT NULL DEFAULT 1              COMMENT '启用否',
  `createTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_plans_code` (`planCode`),
  KEY `idx_plans_project` (`projectId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='项目计划（一个项目可多个计划）';

CREATE TABLE `projectplanitems` (
  `id`                CHAR(36)        NOT NULL                        COMMENT '事项ID（UUID）',
  `planId`            CHAR(36)        NOT NULL                        COMMENT '所属计划（projectplans.id）',
  `projectId`         CHAR(36)        NOT NULL                        COMMENT '所属项目（冗余，便于按项目检索）',
  `itemCode`          VARCHAR(30)     NOT NULL                        COMMENT '事项编号（IT + 6 位流水号，唯一）',
  `itemName`          VARCHAR(200)    NOT NULL                        COMMENT '事项或任务名称',
  `itemType`          VARCHAR(20)     NOT NULL DEFAULT '事项'          COMMENT '类型：事项 / 任务',
  `preItemId`         CHAR(36)        DEFAULT NULL                    COMMENT '前置事项或任务ID',
  `itemDesc`          TEXT            DEFAULT NULL                    COMMENT '事项或任务说明',
  `inputCond`         TEXT            DEFAULT NULL                    COMMENT '输入条件',
  `milestoneOut`      TEXT            DEFAULT NULL                    COMMENT '里程碑输出',
  `startTime`         DATETIME        DEFAULT NULL                    COMMENT '计划开始时间',
  `endTime`           DATETIME        DEFAULT NULL                    COMMENT '计划结束时间',
  `ownerId`           BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '责任人（empinfos.id）',
  `ownerName`         VARCHAR(50)     DEFAULT NULL                    COMMENT '责任人姓名快照',
  `ownerEmail`        VARCHAR(100)    DEFAULT NULL                    COMMENT '责任人邮箱快照',
  `participantIds`    TEXT            DEFAULT NULL                    COMMENT '参与人员ID（逗号分隔）',
  `participantNames`  TEXT            DEFAULT NULL                    COMMENT '参与人员姓名（逗号分隔）',
  `status`            VARCHAR(30)     NOT NULL DEFAULT '待执行'        COMMENT '状态：待执行 / 执行中 / 完成 / 异常（字典 project_plan_item_status）',
  `sortNo`            INT             NOT NULL DEFAULT 0              COMMENT '排序号',
  `noticeMsg`         TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '责任人是否已收到站内消息',
  `noticeMail`        TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '责任人是否已收到邮件',
  `noticeTime`        DATETIME        DEFAULT NULL                    COMMENT '最近一次通知时间',
  `createTime`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_items_code` (`itemCode`),
  KEY `idx_items_plan` (`planId`),
  KEY `idx_items_project` (`projectId`),
  KEY `idx_items_owner` (`ownerId`),
  KEY `idx_items_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='计划事项或任务（一个计划可多个事项）';

CREATE TABLE `projectworkorders` (
  `id`           CHAR(36)        NOT NULL                        COMMENT '工单ID（UUID）',
  `itemId`       CHAR(36)        NOT NULL                        COMMENT '来源事项（projectplanitems.id，一事项一单）',
  `planId`       CHAR(36)        NOT NULL                        COMMENT '所属计划',
  `projectId`    CHAR(36)        NOT NULL                        COMMENT '所属项目',
  `orderCode`    VARCHAR(30)     NOT NULL                        COMMENT '工单编号（WO + 6 位流水号，唯一）',
  `orderTitle`   VARCHAR(200)    NOT NULL                        COMMENT '工单标题（取事项名称）',
  `ownerId`      BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '责任人员工ID',
  `ownerName`    VARCHAR(50)     DEFAULT NULL                    COMMENT '责任人姓名快照',
  `ownerEmail`   VARCHAR(100)    DEFAULT NULL                    COMMENT '责任人邮箱快照',
  `status`       VARCHAR(20)     NOT NULL DEFAULT '待处理'        COMMENT '工单状态：待处理 / 处理中 / 已完成',
  `dispatchTime` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '派送时间',
  `noticeMsg`    TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '派送时是否已发站内消息',
  `noticeMail`   TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '派送时是否已发邮件',
  `noticeTime`   DATETIME        DEFAULT NULL                    COMMENT '最近一次通知时间',
  `remark`       VARCHAR(200)    DEFAULT NULL                    COMMENT '备注（通知失败原因等）',
  `createTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_orders_code` (`orderCode`),
  UNIQUE KEY `uk_orders_item` (`itemId`),
  KEY `idx_orders_plan` (`planId`),
  KEY `idx_orders_owner` (`ownerId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='事项工单（一事项一单）';

CREATE TABLE `projectplanitemfiles` (
  `id`           CHAR(36)        NOT NULL                        COMMENT '附件ID（UUID）',
  `itemId`       CHAR(36)        NOT NULL                        COMMENT '所属事项（projectplanitems.id）',
  `projectId`    CHAR(36)        NOT NULL                        COMMENT '所属项目',
  `fileName`     VARCHAR(255)    NOT NULL                        COMMENT '文件名',
  `filePath`     VARCHAR(500)    NOT NULL                        COMMENT '服务器相对路径',
  `fileType`     VARCHAR(30)     NOT NULL DEFAULT '其它'          COMMENT '文件类型：图片 / 文档 / 表格 / 其它',
  `fileSize`     BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '文件大小（字节）',
  `fileDesc`     VARCHAR(500)    DEFAULT NULL                    COMMENT '文件说明',
  `ispub`        TINYINT(1)      NOT NULL DEFAULT 1              COMMENT '公用否',
  `enabled`      TINYINT(1)      NOT NULL DEFAULT 1              COMMENT '启用否',
  `uploadEname`  VARCHAR(100)    DEFAULT NULL                    COMMENT '上传人姓名',
  `uploadempinfosid` BIGINT UNSIGNED DEFAULT NULL                COMMENT '上传人员工ID',
  `uploadTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_itemfiles_item` (`itemId`),
  KEY `idx_itemfiles_project` (`projectId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='计划事项附件（支持在线预览）';
