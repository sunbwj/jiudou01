-- =====================================================================
-- 工作计划（Visio 风格）：workplans / workplantasks
-- ---------------------------------------------------------------------
-- 参照 Microsoft Visio「甘特图 / 时间线」的工作计划模型：
--   · workplans      工作计划：WP + 6 位流水号，含日期范围、时间刻度、非工作日、可关联项目；
--   · workplantasks  计划任务：task（任务）/ milestone（里程碑，工期 0）/ summary（摘要任务），
--                    含父子缩进、前置依赖（画箭头）、完成百分比、责任人 / 参与人员、排序；
--   · workplanorders 任务工单：计划「启动」后一任务一单（taskId 关联 workplantasks），
--                    同时给责任人与参与人员发站内即时消息 + 通知邮件，进入「我的任务」；
--   · 任务带「完成状态 / 实际开始 / 实际结束 / 说明」执行记录，工单不复制副本，
--     由 /workplan/orders 与 /workplan/detail 双向 JOIN 读取，保证工单与任务始终对得上。
-- 「项目计划」功能已下线（db/workplan-retire-projectplan.sql 停用菜单与授权，
--  历史表 / 页面 / 服务保留，工作计划仍复用它的通知、邮件与 WO 编号序列工具方法）。
-- 设计要点：
--   · **可重复执行、非破坏性**：CREATE TABLE IF NOT EXISTS，不 DROP / 不 UPDATE / 不 DELETE 业务数据；
--   · 与既有「项目计划 v2」（projectplans / projectplanitems / 工单 / 通知）表结构解耦，
--     但工单编号 WO+6 共用同一序列、任务列表统一展示；projectId 只作可选关联（快照项目名）；
--   · 可见性与项目模块同口径：本人创建 OR ispub=1；他人公用记录仍可编辑。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < workplan.sql
-- 同步：db/rogerorm-schema.sql 末尾有同结构建表（全量建库用）。
-- 老库升级：db/workplan-people.sql（任务人员列）+ db/workplan-start.sql（启动状态 / 工单表 / 菜单）
--           + db/workplan-exec.sql（执行记录列 / 关联索引）
--           + db/workplan-retire-projectplan.sql（下线「项目计划」菜单）。
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `workplans` (
  `id`               CHAR(36)        NOT NULL                        COMMENT '工作计划ID（UUID）',
  `planCode`         VARCHAR(30)     NOT NULL                        COMMENT '计划编号（WP + 6 位流水号，唯一）',
  `planName`         VARCHAR(150)    NOT NULL                        COMMENT '计划名称',
  `projectId`        CHAR(36)        DEFAULT NULL                    COMMENT '可选：关联项目（projectinfos.id）',
  `projectName`      VARCHAR(150)    DEFAULT NULL                    COMMENT '关联项目名称快照',
  `startDate`        DATE            DEFAULT NULL                    COMMENT '计划开始日期（甘特图时间刻度起点）',
  `endDate`          DATE            DEFAULT NULL                    COMMENT '计划结束日期（甘特图时间刻度终点）',
  `planDesc`         TEXT            DEFAULT NULL                    COMMENT '计划说明 / 目标',
  `scale`            VARCHAR(10)     NOT NULL DEFAULT 'day'          COMMENT '时间刻度：day 日 / week 周 / month 月',
  `skipWeekend`      TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '是否把周末标为非工作日（Visio 配置工作时间）',
  `ispub`            TINYINT(1)      NOT NULL DEFAULT 1              COMMENT '公用否（公用 = 全员可见）',
  `enabled`          TINYINT(1)      NOT NULL DEFAULT 1              COMMENT '启用否',
  `status`           VARCHAR(20)     NOT NULL DEFAULT '未启动'        COMMENT '启动状态：未启动 / 已启动',
  `startTime`        DATETIME        DEFAULT NULL                    COMMENT '最近一次启动时间',
  `startEname`       VARCHAR(100)    DEFAULT NULL                    COMMENT '启动人姓名',
  `startempinfosid`  BIGINT UNSIGNED DEFAULT NULL                    COMMENT '启动人员工ID',
  `createEname`      VARCHAR(100)    DEFAULT NULL                    COMMENT '创建人姓名',
  `createempinfosid` BIGINT UNSIGNED DEFAULT NULL                    COMMENT '创建人员工ID（可见性依据）',
  `createTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workplans_code` (`planCode`),
  KEY `idx_workplans_project` (`projectId`),
  KEY `idx_workplans_owner` (`createempinfosid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作计划（Visio 风格甘特图 / 时间线）';

CREATE TABLE IF NOT EXISTS `workplantasks` (
  `id`           CHAR(36)     NOT NULL                        COMMENT '任务ID（UUID）',
  `planId`       CHAR(36)     NOT NULL                        COMMENT '所属工作计划（workplans.id）',
  `taskName`     VARCHAR(200) NOT NULL                       COMMENT '任务 / 里程碑 / 摘要名称',
  `taskType`     VARCHAR(20)  NOT NULL DEFAULT 'task'        COMMENT 'task 任务 / milestone 里程碑 / summary 摘要任务',
  `parentId`     CHAR(36)     DEFAULT NULL                   COMMENT '上级摘要任务（Visio 缩进）',
  `startDate`    DATE         DEFAULT NULL                   COMMENT '开始日期',
  `endDate`      DATE         DEFAULT NULL                   COMMENT '结束日期（里程碑 = 开始日期，工期 0）',
  `progress`     INT          NOT NULL DEFAULT 0             COMMENT '完成百分比 0~100（任务条内深色填充）',
  `execStatus`   VARCHAR(20)  NOT NULL DEFAULT '未开始'      COMMENT '任务完成状态：未开始 / 进行中 / 已完成 / 已延期 / 已取消',
  `actualStartDate` DATE      DEFAULT NULL                   COMMENT '实际开始时间（执行记录）',
  `actualEndDate`   DATE      DEFAULT NULL                   COMMENT '实际结束时间（执行记录）',
  `execRemark`   VARCHAR(1000) DEFAULT NULL                 COMMENT '执行说明 / 完成记录',
  `preTaskIds`   TEXT         DEFAULT NULL                   COMMENT '前置任务ID，逗号分隔（甘特图画依赖箭头）',
  `ownerName`    VARCHAR(50)  DEFAULT NULL                   COMMENT '责任人姓名快照（从员工信息选取）',
  `ownerId`      BIGINT UNSIGNED NOT NULL DEFAULT 0         COMMENT '责任人（empinfos.id，0=未指定）',
  `participantIds`   TEXT       DEFAULT NULL                 COMMENT '参与人员ID（empinfos.id，逗号分隔）',
  `participantNames` TEXT       DEFAULT NULL                 COMMENT '参与人员姓名快照（逗号分隔）',
  `sortNo`       INT          NOT NULL DEFAULT 0             COMMENT '排序号（画布行顺序）',
  `color`        VARCHAR(20)  DEFAULT NULL                   COMMENT '任务条自定义颜色（可空 = 按类型取色）',
  `createTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_workplantasks_plan` (`planId`),
  KEY `idx_workplantasks_parent` (`parentId`),
  KEY `idx_workplantasks_owner` (`ownerId`),
  KEY `idx_workplantasks_exec` (`execStatus`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作计划任务（任务 / 里程碑 / 摘要 + 依赖 + 完成百分比 + 执行记录）';

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
  KEY `idx_wporders_dispatch` (`dispatchTime`),
  KEY `idx_wporders_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作计划任务工单（启动后一任务一单，按 taskId 关联 workplantasks）';

-- 老库（已建过 workplantasks / workplans）请再执行 db/workplan-people.sql 与 db/workplan-start.sql：
-- 两个脚本都用 information_schema 判断 / NOT EXISTS，可重复执行且不改动已有数据。

-- 回显：确认三张表都在，且不改动任何已有数据
SHOW TABLES LIKE 'workplan%';
