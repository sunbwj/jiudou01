-- =====================================================================
-- 迁移：serviceemailmsg 增加「附件清单」（写邮件支持附件上传与发送）
-- ---------------------------------------------------------------------
-- 说明：
--   · 发件时附件内容只在内存里组装成 MIME（base64）交给 SMTP，**不落库、不写磁盘**；
--     库里只留一份清单（JSON 文本：[{"name":"报价单.xlsx","size":20480}]），
--     供「已发送」列表 / 读信时展示「📎 2 个附件（20.0 KB）」；
--   · 收件侧的附件仍然只标 hasAttach=1（内容不下载），attachInfo 为 NULL；
--   · 数量 / 大小限制由后端 config.MAIL_MAX_ATTACHMENTS / MAIL_MAX_ATTACH_MB /
--     MAIL_MAX_TOTAL_MB 控制（默认 5 个 / 单个 10 MB / 合计 20 MB）。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < serviceemailmsg-attach.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 附件清单：发件时写入（JSON 文本），收件为 NULL
ALTER TABLE `serviceemailmsg`
  ADD COLUMN `attachInfo` VARCHAR(1000) DEFAULT NULL
      COMMENT '附件清单（JSON：[{name,size}]；附件内容不落地）'
      AFTER `hasAttach`;

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `serviceemailmsg`;
