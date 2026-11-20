-- =====================================================================
-- 工作计划：变更通知邮件队列（保存接口不再同步等 SMTP，后台线程重试发送）
-- ---------------------------------------------------------------------
-- 背景：保存时同步给「创建人 / 责任人 / 参与人」逐个发邮件，SMTP 连接慢时
--       整个保存请求会超过前端 15s 超时（表现为「网络异常」）。
-- 方案：保存时只写队列（毫秒级），后台守护线程按队列发送并重试，保证送达。
-- 可重复执行；不修改任何既有数据。
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `workplanmailqueue` (
  `id`         VARCHAR(36)  NOT NULL                COMMENT '主键 UUID',
  `planId`     VARCHAR(36)  DEFAULT NULL            COMMENT '工作计划ID',
  `taskId`     VARCHAR(36)  DEFAULT NULL            COMMENT '任务ID',
  `empId`      BIGINT UNSIGNED NOT NULL DEFAULT 0   COMMENT '收件人员工ID',
  `email`      VARCHAR(100) DEFAULT NULL            COMMENT '收件邮箱',
  `subject`    VARCHAR(200) DEFAULT NULL            COMMENT '邮件主题',
  `body`       MEDIUMTEXT                           COMMENT '纯文本正文',
  `bodyHtml`   MEDIUMTEXT                           COMMENT 'HTML 正文',
  `status`     VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT 'pending / sending / retry / sent / failed',
  `attempts`   INT          NOT NULL DEFAULT 0      COMMENT '已尝试次数',
  `lastError`  VARCHAR(500) DEFAULT NULL            COMMENT '最近一次失败原因',
  `createTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wpmail_status` (`status`, `createTime`),
  KEY `idx_wpmail_plan` (`planId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作计划变更通知邮件队列';
