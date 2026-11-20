-- =====================================================================
-- 邮件附件下载：mailattach 元数据表（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 背景：原来「服务信箱 / 我的邮箱」只在 hasAttach 里记一个标记，发件邮件
--       顶多在 attachInfo 里记 [{name,size}]，**附件内容从不落地**，所以读信区
--       只能显示「含附件」，没法真正下载。本脚本新增一张附件元数据表：
--         · 二进制内容放在 WEB_ROOT/data/mailattach/<source>/<mailId>/ 下
--           （MySQL 5.7 的 max_allowed_packet 通常只有 1 MB，不能塞进 BLOB）；
--         · 表里只登记 归属邮件 / 序号 / 文件名 / 大小 / 类型 / 相对路径，
--           downloadable=0 表示「超大附件只记名字，内容未保存」；
--         · source=mail → 服务信箱（全员共用，empId=0）；
--           source=empmail → 我的邮箱（empId 是归属员工，下载时强隔离校验）。
--   · 收件 / 发件时由后端自动落盘并登记；历史邮件可在读信区点「获取附件」按
--     IMAP UID 补拉一封，补拉成功后同样登记，之后下载不再连邮箱服务器。
--   · 删除邮件时同步删表记录与磁盘文件（只删 data/mailattach 下自己写的文件）。
--
-- 【可重复执行 / 非破坏性】
--   · CREATE TABLE IF NOT EXISTS 不动已有结构与数据；
--   · 不 UPDATE / DELETE 任何业务表，不影响 serviceemailmsg / empmailmsg 现有邮件；
--   · 老库没跑本脚本时后端自动降级（读信区显示「未保存」，不影响收发与阅读）。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/mail-attach.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `mailattach` (
  `id`            CHAR(36)        NOT NULL                        COMMENT '附件ID（UUID，下载接口按它取）',
  `source`        VARCHAR(16)     NOT NULL                        COMMENT '来源：mail-服务信箱 / empmail-我的邮箱',
  `mailId`        CHAR(36)        NOT NULL                        COMMENT '所属邮件ID',
  `empId`         BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '归属员工（empmail 强隔离用；mail 恒为 0）',
  `sortNo`        INT             NOT NULL DEFAULT 0              COMMENT '同一封邮件内的附件序号（从 0 起）',
  `name`          VARCHAR(255)    NOT NULL                        COMMENT '附件文件名（MIME 头解码后）',
  `size`          BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '字节数',
  `contentType`   VARCHAR(150)    DEFAULT NULL                    COMMENT 'MIME 类型',
  `filePath`      VARCHAR(500)    DEFAULT NULL                    COMMENT '相对 WEB_ROOT 的文件路径；NULL=内容未保存',
  `downloadable`  TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '1-可下载，0-只记名字（超大 / 历史未补拉）',
  `createTime`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '登记时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_mailattach_item` (`source`,`mailId`,`sortNo`),
  KEY `idx_mailattach_mail` (`source`,`mailId`),
  KEY `idx_mailattach_emp`  (`source`,`empId`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '邮件附件元数据（内容落盘；服务信箱与我的邮箱共用）';

-- ---------------------------- 结构回显（便于人工核对） ----------------------------
SHOW FULL COLUMNS FROM `mailattach`;
