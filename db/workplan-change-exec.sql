-- =====================================================================
-- 工作计划：变更日志 + 多次执行记录（含多附件）
-- ---------------------------------------------------------------------
-- 需求：
--   1) 计划任务发生任何变更时自动生成变更日志，可按时间线展示；
--   2) 每次变更推送即时消息 + 邮件给 计划创建人 / 责任人 / 参与人；
--   3) 任务未标记「已完成」前，可多次提交执行记录单，每次可上传多个文件；
--   4) 执行记录在日历图 / 网格列表里关联显示并可预览附件。
-- 设计要点：
--   · 全部 CREATE TABLE IF NOT EXISTS，可重复执行；不改动、不删除已有数据；
--   · 执行记录与工单通过 orderId 关联，与任务通过 taskId 关联；
--   · 附件内容存服务器磁盘（server/uploads/workplan/），表里只存相对路径与元数据，
--     预览走 /api/workplan/execfile（JSON 返回 dataUrl），避免大字段塞库。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < workplan-change-exec.sql
-- =====================================================================

SET NAMES utf8mb4;

-- ---------- 1) 变更日志 ----------
CREATE TABLE IF NOT EXISTS `workplanchangelogs` (
  `id`            VARCHAR(36)  NOT NULL                COMMENT '主键 UUID',
  `planId`        VARCHAR(36)  NOT NULL                COMMENT '工作计划ID',
  `taskId`        VARCHAR(36)  DEFAULT NULL            COMMENT '任务ID（计划级变更为空）',
  `taskName`      VARCHAR(200) DEFAULT NULL            COMMENT '任务名称快照',
  `action`        VARCHAR(20)  NOT NULL DEFAULT 'update' COMMENT 'add / update / delete / exec / plan / stop',
  `summary`       VARCHAR(500) DEFAULT NULL            COMMENT '变更摘要（时间线展示）',
  `detail`        TEXT                                 COMMENT '字段级明细（field: old → new）',
  `operatorId`    BIGINT UNSIGNED NOT NULL DEFAULT 0   COMMENT '操作人员工ID',
  `operatorName`  VARCHAR(50)  DEFAULT NULL            COMMENT '操作人姓名快照',
  `createTime`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wpchg_plan` (`planId`, `createTime`),
  KEY `idx_wpchg_task` (`taskId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作计划变更日志';

-- ---------- 2) 执行记录单 ----------
CREATE TABLE IF NOT EXISTS `workplanexecs` (
  `id`            VARCHAR(36)  NOT NULL                COMMENT '主键 UUID',
  `planId`        VARCHAR(36)  DEFAULT NULL            COMMENT '工作计划ID',
  `taskId`        VARCHAR(36)  DEFAULT NULL            COMMENT '任务ID',
  `orderId`       VARCHAR(36)  DEFAULT NULL            COMMENT '工单ID（我的任务提交流程）',
  `planName`      VARCHAR(200) DEFAULT NULL            COMMENT '计划名称快照',
  `taskName`      VARCHAR(200) DEFAULT NULL            COMMENT '任务名称快照',
  `title`         VARCHAR(200) DEFAULT NULL            COMMENT '记录标题',
  `content`       TEXT                                 COMMENT '执行说明',
  `progress`      INT          NOT NULL DEFAULT 0      COMMENT '完成百分比',
  `execStatus`    VARCHAR(20)  DEFAULT NULL            COMMENT '提交时的完成状态',
  `actualStartDate` DATE       DEFAULT NULL            COMMENT '实际开始时间',
  `actualEndDate`   DATE       DEFAULT NULL            COMMENT '实际结束时间',
  `operatorId`    BIGINT UNSIGNED NOT NULL DEFAULT 0   COMMENT '提交人员工ID',
  `operatorName`  VARCHAR(50)  DEFAULT NULL            COMMENT '提交人姓名快照',
  `createTime`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wpexec_task` (`taskId`, `createTime`),
  KEY `idx_wpexec_plan` (`planId`),
  KEY `idx_wpexec_order` (`orderId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作计划任务执行记录单（可多次提交）';

-- ---------- 3) 执行记录附件 ----------
CREATE TABLE IF NOT EXISTS `workplanexecfiles` (
  `id`         VARCHAR(36)  NOT NULL                COMMENT '主键 UUID',
  `execId`     VARCHAR(36)  NOT NULL                COMMENT '执行记录ID',
  `name`       VARCHAR(255) DEFAULT NULL            COMMENT '原始文件名',
  `path`       VARCHAR(500) NOT NULL                COMMENT '服务器相对路径',
  `size`       BIGINT       NOT NULL DEFAULT 0      COMMENT '字节数',
  `ext`        VARCHAR(20)  DEFAULT NULL            COMMENT '扩展名',
  `mime`       VARCHAR(100) DEFAULT NULL            COMMENT 'MIME',
  `createTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wpexecfile_exec` (`execId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作计划执行记录附件';
