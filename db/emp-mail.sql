-- =====================================================================
-- 员工个人邮箱助手：个人信箱配置 empemailbox + 个人邮件 empmailmsg（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 业务说明（参照「服务信箱 / 邮箱助手」，但按登录员工强隔离）：
--   · 服务信箱 serviceemail 是「全系统单例表」，只有一条记录、所有邮件混在一张表里；
--     个人邮箱助手则是**每个员工一条自己的配置**、**邮件按归属员工分开存**：
--       - empemailbox.empId：归属员工（empinfos.id = useinfo.empId），UNIQUE 保证一人一条；
--       - empmailmsg.empId ：每封邮件的归属员工，**所有查询 / 更新 / 删除都强制带 empId**，
--         后端由登录 token 反查（require_login 注入 _loginUserId → useinfo.empId），
--         绝不接受前端传来的 empId，从根上做到「各员只能看本信箱的历史邮件，不能看他人的」。
--   · 员工在「我的邮箱」页右上角「设置」里填自己的邮箱 / 授权码 / 服务器，保存即可收发阅读；
--     autoSync=1 表示这个信箱参与后台自动收件（MailSyncWorker 每 5 分钟遍历一次）。
--   · 密码 / 授权码用 mail_client.encrypt_secret 加密存储，接口永不返回（只给 hasPassword / 掩码）。
--   · 服务器地址留空按邮箱域名自动推断（见 server/mail_client.py: provider_of / servers_of）。
--   · 附件不落库，只记录 hasAttach 标记与 attachInfo（JSON：[{name,size}]）。
--   · (empId, direction, uid) 唯一：收件按 IMAP UID 去重，重复同步不会产生重复邮件；
--     不同员工即使收同一个邮箱，UID 也各算各的，互不干扰。
--
-- 【可重复执行 / 非破坏性】
--   · CREATE TABLE IF NOT EXISTS 不改动已有表结构与数据；
--   · 全程不 UPDATE / DELETE 任何业务数据，不覆盖员工手工维护的启停 / 自动收件开关；
--   · 老库没跑本脚本时后端会自动降级（/api/health 与状态接口捕获异常），不影响其它模块。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/emp-mail.sql
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------- 1. 员工个人信箱配置（一人一条） ----------------------------
CREATE TABLE IF NOT EXISTS `empemailbox` (
  `id`           CHAR(36)     NOT NULL                          COMMENT '配置ID（UUID 主键，非自增）',
  `empId`        BIGINT UNSIGNED NOT NULL                      COMMENT '归属员工（empinfos.id = useinfo.empId，一人一条）',
  `email`        VARCHAR(120) NOT NULL                          COMMENT '个人邮箱地址',
  `password`     VARCHAR(255) NOT NULL DEFAULT ''               COMMENT '邮箱密码 / 授权码（加密存储，接口不返回；空=未设置）',
  `displayName`  VARCHAR(80)  DEFAULT NULL                      COMMENT '发件人显示名（默认取邮箱前缀）',
  `smtpHost`     VARCHAR(120) DEFAULT NULL                      COMMENT 'SMTP 服务器（留空按邮箱域名自动推断）',
  `smtpPort`     INT(11)      DEFAULT NULL                      COMMENT 'SMTP 端口（留空按服务商默认：465/587）',
  `imapHost`     VARCHAR(120) DEFAULT NULL                      COMMENT 'IMAP 服务器（留空按邮箱域名自动推断）',
  `imapPort`     INT(11)      DEFAULT NULL                      COMMENT 'IMAP 端口（留空默认 993）',
  `useSsl`       TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用 SSL：1-SSL/465，0-STARTTLS/587',
  `enabled`      TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用否：1-启用（可收发），0-停用',
  `autoSync`     TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '自动收件：1-参与后台每 5 分钟自动收件，0-只手动收',
  `lastSyncTime` DATETIME     DEFAULT NULL                      COMMENT '最近一次收件同步时间',
  `lastError`    VARCHAR(255) DEFAULT NULL                      COMMENT '最近一次收件 / 测试失败原因',
  `remark`       VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_empemailbox_emp`   (`empId`),
  KEY `idx_empemailbox_sync`        (`enabled`, `autoSync`),
  KEY `idx_empemailbox_email`       (`email`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '员工个人信箱配置（一人一条，密码加密存储 / autoSync 自动收件）';

-- ---------------------------- 2. 员工个人邮件（收件 / 发件） ----------------------------
CREATE TABLE IF NOT EXISTS `empmailmsg` (
  `id`             CHAR(36)     NOT NULL                        COMMENT '邮件ID（UUID 主键，非自增）',
  `empId`          BIGINT UNSIGNED NOT NULL                    COMMENT '归属员工（empinfos.id，强隔离字段：所有读写都带它）',
  `direction`      VARCHAR(8)   NOT NULL                        COMMENT '方向：in-收件，out-发件',
  `uid`            VARCHAR(120) NOT NULL                        COMMENT '收件=IMAP UID，发件=本地消息ID（去重用）',
  `messageId`      VARCHAR(255) DEFAULT NULL                    COMMENT '邮件 Message-ID',
  `fromAddr`       VARCHAR(255) DEFAULT NULL                    COMMENT '发件人地址',
  `fromName`       VARCHAR(120) DEFAULT NULL                    COMMENT '发件人名称',
  `toAddr`         TEXT                                        COMMENT '收件人（多个以 , 分隔）',
  `ccAddr`         TEXT                                        COMMENT '抄送人（多个以 , 分隔）',
  `subject`        VARCHAR(500) DEFAULT NULL                    COMMENT '主题',
  `sentTime`       DATETIME     DEFAULT NULL                    COMMENT '邮件时间（收件=收信时间，发件=发送时间）',
  `bodyText`       MEDIUMTEXT                                  COMMENT '纯文本正文',
  `bodyHtml`       MEDIUMTEXT                                  COMMENT 'HTML 正文（仅有 HTML 邮件时写入）',
  `hasAttach`      TINYINT(1)   NOT NULL DEFAULT 0              COMMENT '是否带附件：1-是（附件内容不落地）',
  `attachInfo`     VARCHAR(1000) DEFAULT NULL                   COMMENT '附件清单（JSON：[{name,size}]；附件内容不落地）',
  `seen`           TINYINT(1)   NOT NULL DEFAULT 0              COMMENT '是否已读：1-已读，0-未读',
  `createTime`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_empmailmsg_uid`  (`empId`, `direction`, `uid`),
  KEY `idx_empmailmsg_list`       (`empId`, `direction`, `sentTime`),
  KEY `idx_empmailmsg_seen`       (`empId`, `seen`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '员工个人邮件（in=收件，out=发件，按 empId 强隔离 / IMAP UID 去重）';

-- ---------------------------- 3. 结构回显（便于人工核对） ----------------------------
SHOW FULL COLUMNS FROM `empemailbox`;
SHOW FULL COLUMNS FROM `empmailmsg`;
