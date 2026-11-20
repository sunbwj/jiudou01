-- =====================================================================
-- 站内消息（员工间互发，按 empId 强隔离）：emp_msgs
-- ---------------------------------------------------------------------
-- 业务说明：
--   · 这是平台内部的「站内信」，与「我的邮箱」（IMAP/SMTP 真实邮件）是两套完全不同的东西；
--     站内消息不发往任何邮箱，只在平台内「员工 → 员工」传递，存储在 emp_msgs 表里。
--   · 数据隔离以「发件人 / 收件人」双向归属实现，后端由登录 token 反查 empId（useinfo.empId），
--     **绝不接受前端传来的 senderId / receiverId 作为归属依据**：
--       - 收件箱 = receiverId = 当前员工 且 receiverDeleted = 0（自己删过的看不见）；
--       - 已发送 = senderId   = 当前员工 且 senderDeleted   = 0（自己删过的看不见）；
--       - 别人发给别人的消息、或别人看本应属于自己的消息，一律查不到（不提示「无权访问」，
--         避免泄露消息是否存在）。
--   · 软删除是「按角色」的：收件人点删除只置 receiverDeleted=1（发件人「已发送」里仍可见），
--     发件人点删除只置 senderDeleted=1（收件人「收件箱」里仍可见）；
--     只有当双方都删了（senderDeleted=1 且 receiverDeleted=1）才物理删除，彻底释放空间。
--   · 发件人 / 收件人姓名在发送时快照进 senderName / receiverName，员工改名后历史消息不失真。
--   · 支持「一对多」发送：一次发送写给多个收件人 → 每个收件人一条独立记录（同一 title/content/
--     sendTime），各自独立已读 / 删除，便于分别隔离。
--
-- 【可重复执行 / 非破坏性】
--   · CREATE TABLE IF NOT EXISTS 不改动已有表结构与数据；
--   · 全程不 UPDATE / DELETE 任何业务数据；
--   · 老库没跑本脚本时后端 EmpMessageService 捕获建表异常并降级（/api/health 不受影响）。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/emp-message.sql
-- 增量脚本（按时间顺序，跑过本脚本后按需补）：
--   db/emp-message-media.sql  媒体消息（msgType / attachId / groupId / seq + 附件与群表）
--   db/emp-msg-rich.sql       富文本正文 contentHtml + 群聊 @ 组员 atEmpIds
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------- 站内消息表 ----------------------------
CREATE TABLE IF NOT EXISTS `emp_msgs` (
  `id`              CHAR(36)        NOT NULL                    COMMENT '消息ID（UUID 主键，非自增）',
  `senderId`        BIGINT UNSIGNED NOT NULL                   COMMENT '发件人员工ID（empinfos.id = useinfo.empId）',
  `senderName`      VARCHAR(50)     NOT NULL DEFAULT ''        COMMENT '发件人姓名（发送时快照，改名不丢历史）',
  `receiverId`      BIGINT UNSIGNED NOT NULL                   COMMENT '收件人员工ID（empinfos.id）',
  `receiverName`    VARCHAR(50)     NOT NULL DEFAULT ''        COMMENT '收件人姓名（发送时快照）',
  `title`           VARCHAR(200)    NOT NULL DEFAULT ''        COMMENT '消息标题',
  `content`         MEDIUMTEXT                                  COMMENT '消息正文',
  `sendTime`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发送时间',
  `readStatus`      TINYINT(1)      NOT NULL DEFAULT 0          COMMENT '收件人是否已读：0-未读，1-已读',
  `senderDeleted`   TINYINT(1)      NOT NULL DEFAULT 0          COMMENT '发件人软删除：1-已删（本人「已发送」不可见）',
  `receiverDeleted` TINYINT(1)      NOT NULL DEFAULT 0          COMMENT '收件人软删除：1-已删（本人「收件箱」不可见）',
  `createTime`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (`id`),
  KEY `idx_emp_msgs_inbox`  (`receiverId`, `receiverDeleted`, `sendTime`),
  KEY `idx_emp_msgs_sent`   (`senderId`, `senderDeleted`, `sendTime`),
  KEY `idx_emp_msgs_read`   (`receiverId`, `receiverDeleted`, `readStatus`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '站内消息（员工间互发，按 empId 强隔离：收件箱=receiverId=我且未删，已发送=senderId=我且未删）';

-- ---------------------------- 结构回显（便于人工核对） ----------------------------
SHOW FULL COLUMNS FROM `emp_msgs`;
