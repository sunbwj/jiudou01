-- =====================================================================
-- 表：服务信箱 serviceemail + 邮件 serviceemailmsg（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 业务说明：
--   · 服务信箱 = 系统对外收发邮件用的邮箱账号（如 service@jiudou.com）
--     - **单例表：全表只允许一条记录**（服务信箱是系统的一份配置，不是列表）：
--       singleFlag 生成列（常量 1）+ 唯一索引 uk_serviceemail_single 在数据库层兜底，第二条 INSERT 必然冲突；
--       页面上「邮箱助手 → 右上角设置按钮」弹出的弹窗里，无记录 = 新增、有记录 = 编辑。
--     - 主键 id 用 UUID（CHAR(36)），邮箱地址全局唯一；
--     - password 存的是「加密后的密码 / 邮箱授权码」，接口永不返回明文（列表只显示 ******）；
--     - 兼容历史的「全表最多只能有一条启用记录」：由生成列 enabledFlag（enabled=1 时取 1，否则 NULL）+ 唯一索引
--       uk_serviceemail_enabled 在数据库层兜底（MySQL 唯一索引允许多个 NULL），业务层切换启用时用事务先停用其它；
--     - smtpHost / smtpPort / imapHost / imapPort 可选：留空按邮箱域名自动推断（见 server/mail_client.py）。
--   · 邮件 serviceemailmsg = 服务信箱收进来的邮件（direction=in）与系统发出去的邮件（direction=out）
--     - (serviceEmailId, direction, uid) 唯一：收件按 IMAP UID 去重，重复同步不会产生重复邮件；
--     - 附件不落库，只记录 hasAttach 标记。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < serviceemail.sql
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------- 1. 服务信箱（发件 / 收件账号） ----------------------------
CREATE TABLE IF NOT EXISTS `serviceemail` (
  `id`           CHAR(36)     NOT NULL                          COMMENT '服务信箱ID（UUID 主键，非自增）',
  `email`        VARCHAR(120) NOT NULL                          COMMENT '服务信箱地址（全局唯一）',
  `password`     VARCHAR(255) NOT NULL                          COMMENT '邮箱密码 / 授权码（加密存储，接口不返回）',
  `displayName`  VARCHAR(80)  DEFAULT NULL                      COMMENT '发件人显示名（默认取邮箱前缀）',
  `smtpHost`     VARCHAR(120) DEFAULT NULL                      COMMENT 'SMTP 服务器（留空按邮箱域名自动推断）',
  `smtpPort`     INT(11)      DEFAULT NULL                      COMMENT 'SMTP 端口（留空按服务商默认：465/587）',
  `imapHost`     VARCHAR(120) DEFAULT NULL                      COMMENT 'IMAP 服务器（留空按邮箱域名自动推断）',
  `imapPort`     INT(11)      DEFAULT NULL                      COMMENT 'IMAP 端口（留空默认 993）',
  `useSsl`       TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用 SSL：1-SSL/465，0-STARTTLS/587',
  `enabled`      TINYINT(1)   NOT NULL DEFAULT 0                COMMENT '启用否：1-启用（全表仅一条），0-停用',
  `enabledFlag`  TINYINT(1)   GENERATED ALWAYS AS (IF(`enabled` = 1, 1, NULL)) STORED
                                                                COMMENT '唯一启用标记（生成列：启用=1，停用=NULL，配合唯一索引保证只有一条启用）',
  `singleFlag`   TINYINT(1)   GENERATED ALWAYS AS (1) STORED     COMMENT '单例标记（生成列恒为 1，配合唯一索引保证全表只有一条记录）',
  `lastSyncTime` DATETIME     DEFAULT NULL                      COMMENT '最近一次收件同步时间',
  `lastError`    VARCHAR(255) DEFAULT NULL                      COMMENT '最近一次收件 / 测试失败原因',
  `remark`       VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_serviceemail_email`   (`email`),
  UNIQUE KEY `uk_serviceemail_enabled` (`enabledFlag`),
  UNIQUE KEY `uk_serviceemail_single`  (`singleFlag`),
  KEY `idx_serviceemail_enabled`       (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '服务信箱（收件 / 发件账号，单例表：全表仅一条）';

-- ---------------------------- 2. 邮件（收件 / 发件） ----------------------------
CREATE TABLE IF NOT EXISTS `serviceemailmsg` (
  `id`             CHAR(36)     NOT NULL                        COMMENT '邮件ID（UUID 主键，非自增）',
  `serviceEmailId` CHAR(36)     NOT NULL                        COMMENT '所属服务信箱（serviceemail.id）',
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
  UNIQUE KEY `uk_serviceemailmsg_uid` (`serviceEmailId`, `direction`, `uid`),
  KEY `idx_serviceemailmsg_list` (`serviceEmailId`, `direction`, `sentTime`),
  KEY `idx_serviceemailmsg_seen` (`serviceEmailId`, `seen`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '服务信箱邮件（in=收件，out=发件，按 IMAP UID 去重）';

-- ---------------------------- 3. 结构回显（便于人工核对） ----------------------------
SHOW FULL COLUMNS FROM `serviceemail`;
SHOW FULL COLUMNS FROM `serviceemailmsg`;
