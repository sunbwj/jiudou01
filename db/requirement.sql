-- 需求池 / 需求评估 / 工单验收（2026-11-11）
-- 1) 需求主表：全局一个池，按项目分类；需求与研发计划一对一
-- 2) 评估记录：通过 / 不通过；通过填评估工时，不通过填原因
-- 3) 工单：实际开始 / 结束时间 + 验收结果

CREATE TABLE IF NOT EXISTS `requirements` (
  `id`            CHAR(36)     NOT NULL                COMMENT '需求ID（UUID）',
  `reqCode`       VARCHAR(20)  NOT NULL                COMMENT '需求编号：REQ + 6 位',
  `title`         VARCHAR(200) NOT NULL                COMMENT '需求标题',
  `description`   MEDIUMTEXT   NULL                    COMMENT '需求描述 / 验收标准',
  `projectId`     CHAR(36)     NULL                    COMMENT '所属项目ID（可空）',
  `projectName`   VARCHAR(150) NULL                    COMMENT '项目名称快照',
  `sourceType`    VARCHAR(30)  NOT NULL DEFAULT '内部改进' COMMENT '来源：客户需求/售前需求/内部改进/缺陷修复/合规安全/技术债',
  `priority`      VARCHAR(10)  NOT NULL DEFAULT '中'    COMMENT '优先级：高/中/低',
  `expectedDate`  DATE         NULL                    COMMENT '期望完成日期',
  `requesterId`   BIGINT UNSIGNED NULL                 COMMENT '提出人员工ID',
  `requesterName` VARCHAR(100) NULL                    COMMENT '提出人姓名快照',
  `status`        VARCHAR(20)  NOT NULL DEFAULT '待评估' COMMENT '待评估/已通过/已不通过/已转计划/已关闭',
  `estimatedHours` DECIMAL(8,2) NULL                   COMMENT '评估工时（人时）',
  `planId`        CHAR(36)     NULL                    COMMENT '关联工作计划ID（一对一）',
  `createTime`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_requirements_code` (`reqCode`),
  UNIQUE KEY `uk_requirements_plan` (`planId`),
  KEY `idx_requirements_project` (`projectId`),
  KEY `idx_requirements_status` (`status`),
  KEY `idx_requirements_requester` (`requesterId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='需求池（全局一个池，按项目分类）';

CREATE TABLE IF NOT EXISTS `requirementevaluations` (
  `id`             CHAR(36)     NOT NULL                COMMENT '评估记录ID',
  `requirementId`  CHAR(36)     NOT NULL                COMMENT '需求ID',
  `result`         VARCHAR(10)  NOT NULL                COMMENT '通过/不通过',
  `reason`         TEXT         NULL                    COMMENT '不通过原因 / 通过意见',
  `estimatedHours` DECIMAL(8,2) NULL                    COMMENT '评估工时（通过时填写）',
  `evaluatorIds`   TEXT         NULL                    COMMENT '参与评估人员工ID（逗号分隔）',
  `evaluatorNames` VARCHAR(500) NULL                    COMMENT '参与评估人姓名（逗号分隔）',
  `operatorId`     BIGINT UNSIGNED NULL                 COMMENT '操作人ID',
  `operatorName`   VARCHAR(100) NULL                    COMMENT '操作人姓名',
  `createTime`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_requirementeval_req` (`requirementId`),
  KEY `idx_requirementeval_time` (`createTime`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='需求评估记录单';

-- 工单：实际开始 / 结束 + 验收
-- 列由迁移脚本按 information_schema 判断后追加，见 _apply_requirement_schema.py

-- 需求描述富文本 HTML
ALTER TABLE `requirements` ADD COLUMN `descriptionHtml` MEDIUMTEXT NULL COMMENT '需求描述富文本 HTML' AFTER `description`;

-- 需求验收人（默认计划创建人；可指定项目负责人 / 具体员工）
ALTER TABLE 
equirements ADD COLUMN cceptOwnerId BIGINT UNSIGNED NULL COMMENT '需求验收人员工ID' AFTER planId;
ALTER TABLE 
equirements ADD COLUMN cceptOwnerName VARCHAR(100) NULL COMMENT '需求验收人姓名' AFTER cceptOwnerId;

-- 需求附件（base64 上传，落盘 server/uploads/requirement/<requirementId>/）
CREATE TABLE IF NOT EXISTS 
equirementfiles (
  id            CHAR(36)     NOT NULL COMMENT '附件ID',
  
equirementId CHAR(36)     NOT NULL COMMENT '需求ID',
  
ame          VARCHAR(255) NOT NULL COMMENT '文件名',
  path          VARCHAR(500) NOT NULL COMMENT '存储相对路径',
  size          BIGINT       NOT NULL DEFAULT 0 COMMENT '字节数',
  ext           VARCHAR(20)  NULL COMMENT '扩展名',
  uploaderId    BIGINT UNSIGNED NULL COMMENT '上传人员工ID',
  uploaderName  VARCHAR(100) NULL COMMENT '上传人姓名',
  uploadTime    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_requirementfiles_req (
equirementId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='需求附件';

-- 评估原因 / 意见富文本 HTML
ALTER TABLE `requirementevaluations` ADD COLUMN `reasonHtml` MEDIUMTEXT NULL COMMENT '原因/意见富文本 HTML' AFTER `reason`;

-- 评审最终决定：响应 / 决定不响应 / 继续评估
ALTER TABLE `requirementevaluations` ADD COLUMN `finalDecision` VARCHAR(20) NULL COMMENT '本次评审后的最终决定' AFTER `result`;
UPDATE `requirements` SET `status`='响应' WHERE `status`='已通过';
UPDATE `requirementevaluations` SET `finalDecision`='响应' WHERE `result`='通过' AND (`finalDecision` IS NULL OR `finalDecision`='');

CREATE TABLE IF NOT EXISTS `requirementevaluationfiles` (
  `id` CHAR(36) NOT NULL,
  `evaluationId` CHAR(36) NOT NULL,
  `requirementId` CHAR(36) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `path` VARCHAR(500) NOT NULL,
  `size` BIGINT NOT NULL DEFAULT 0,
  `ext` VARCHAR(20) NULL,
  `uploaderId` BIGINT UNSIGNED NULL,
  `uploaderName` VARCHAR(100) NULL,
  `uploadTime` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_evalfiles_eval` (`evaluationId`),
  KEY `idx_evalfiles_req` (`requirementId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='需求评估附件';
