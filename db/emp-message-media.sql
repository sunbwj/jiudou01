-- =====================================================================
-- 即时对话 · 媒体消息（图片 / 文件）与群组
-- ---------------------------------------------------------------------
-- 业务说明：
--   · empmsgfiles      附件元数据（实体落在 <WEB_ROOT>/data/imfiles/<YYYYMM>/<uuid>.<ext>）；
--                      先上传拿到 fileId，再随消息发送，落库消息时回填 msgId；
--   · empimgroups      群（群名 / 群主 / 头像字）；
--   · empimgroupmembers 群成员（含 lastReadTime，群未读 = 该群内我未读的消息数）；
--   · emp_msgs         加三列：
--                        msgType  text（文字）/ image（图片）/ file（文件）
--                        attachId 附件 fileId（empmsgfiles.id，空表示纯文字）
--                        groupId  群消息所属群；私聊为空串，群消息 receiverId=0
--
-- 【可重复执行 / 非破坏性】
--   · CREATE TABLE IF NOT EXISTS 不动已有表结构与数据；
--   · 加列前查 information_schema，已存在则跳过（不重复 ALTER，不报 1060）；
--   · 全程不 UPDATE / DELETE 任何业务数据；
--   · 老库没跑本脚本时后端相关接口抛业务异常并提示，不影响其它模块。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/emp-message-media.sql
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------- 1. 即时对话附件 ----------------------------
CREATE TABLE IF NOT EXISTS `empmsgfiles` (
  `id`          CHAR(36)        NOT NULL                     COMMENT '附件ID（UUID，先上传后随消息发送）',
  `msgId`       CHAR(36)        NOT NULL DEFAULT ''          COMMENT '所属消息ID（发送成功后回填；空=已上传未发送）',
  `uploaderId`  BIGINT UNSIGNED NOT NULL                     COMMENT '上传人员工ID（只有上传者能把该附件发出去）',
  `kind`        VARCHAR(16)     NOT NULL DEFAULT 'file'      COMMENT '附件种类：image-图片，file-文件',
  `fileName`    VARCHAR(255)    NOT NULL DEFAULT ''          COMMENT '原始文件名',
  `filePath`    VARCHAR(500)    NOT NULL DEFAULT ''          COMMENT '相对静态根路径 data/imfiles/YYYYMM/uuid.ext',
  `fileSize`    BIGINT UNSIGNED NOT NULL DEFAULT 0           COMMENT '字节数',
  `mimeType`    VARCHAR(120)    NOT NULL DEFAULT ''          COMMENT 'MIME 类型',
  `ext`         VARCHAR(16)     NOT NULL DEFAULT ''          COMMENT '小写扩展名（不含点）',
  `width`       INT             NOT NULL DEFAULT 0           COMMENT '图片宽（像素，非图片为 0）',
  `height`      INT             NOT NULL DEFAULT 0           COMMENT '图片高（像素，非图片为 0）',
  `createTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上传时间',
  PRIMARY KEY (`id`),
  KEY `idx_empmsgfiles_msg` (`msgId`),
  KEY `idx_empmsgfiles_uploader` (`uploaderId`, `createTime`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '即时对话附件（图片 / 文件；实体落盘 data/imfiles）';

-- ---------------------------- 2. 群组 ----------------------------
CREATE TABLE IF NOT EXISTS `empimgroups` (
  `id`          CHAR(36)        NOT NULL                     COMMENT '群ID（UUID）',
  `groupName`   VARCHAR(100)    NOT NULL                     COMMENT '群名称',
  `ownerId`     BIGINT UNSIGNED NOT NULL                     COMMENT '群主员工ID',
  `ownerName`   VARCHAR(50)     NOT NULL DEFAULT ''          COMMENT '群主姓名（建群时快照）',
  `avatarText`  VARCHAR(4)      NOT NULL DEFAULT ''          COMMENT '头像字（群名首字）',
  `enabled`     TINYINT(1)      NOT NULL DEFAULT 1           COMMENT '是否可用：1-正常，0-已解散',
  `createTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '建群时间',
  `updateTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_empimgroups_owner` (`ownerId`, `enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '即时对话群组（群主 + 成员，见 empimgroupmembers）';

CREATE TABLE IF NOT EXISTS `empimgroupmembers` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT     COMMENT '自增主键',
  `groupId`       CHAR(36)        NOT NULL                    COMMENT '群ID',
  `empId`         BIGINT UNSIGNED NOT NULL                    COMMENT '成员工号（empinfos.id = useinfo.empId）',
  `empName`       VARCHAR(50)     NOT NULL DEFAULT ''         COMMENT '成员姓名（入群时快照）',
  `role`          VARCHAR(16)     NOT NULL DEFAULT 'member'   COMMENT '角色：owner-群主，member-成员',
  `lastReadSeq`   BIGINT UNSIGNED NOT NULL DEFAULT 0          COMMENT '最后阅读游标（emp_msgs.seq；群未读 = 该群 seq 大于它的别人消息数）',
  `lastReadTime`  DATETIME        NULL DEFAULT NULL           COMMENT '最后阅读时间（仅供展示，未读判定用 lastReadSeq）',
  `joinTime`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入群时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_empimgroupmembers` (`groupId`, `empId`),
  KEY `idx_empimgroupmembers_emp` (`empId`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '即时对话群成员（含最后阅读游标，用于按人算群未读）';

-- ---------------------------- 3. emp_msgs 加列（幂等） ----------------------------
SET @db := DATABASE();

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'emp_msgs' AND COLUMN_NAME = 'msgType');
SET @sql := IF(@has = 0,
  'ALTER TABLE `emp_msgs` ADD COLUMN `msgType` VARCHAR(16) NOT NULL DEFAULT ''text'' COMMENT ''消息类型：text-文字，image-图片，file-文件'' AFTER `content`',
  'SELECT ''skip: emp_msgs.msgType 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'emp_msgs' AND COLUMN_NAME = 'attachId');
SET @sql := IF(@has = 0,
  'ALTER TABLE `emp_msgs` ADD COLUMN `attachId` CHAR(36) NOT NULL DEFAULT '''' COMMENT ''附件ID（empmsgfiles.id，空=纯文字）'' AFTER `msgType`',
  'SELECT ''skip: emp_msgs.attachId 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'emp_msgs' AND COLUMN_NAME = 'groupId');
SET @sql := IF(@has = 0,
  'ALTER TABLE `emp_msgs` ADD COLUMN `groupId` CHAR(36) NOT NULL DEFAULT '''' COMMENT ''群ID（群消息；私聊为空串，此时 receiverId=0）'' AFTER `attachId`',
  'SELECT ''skip: emp_msgs.groupId 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'emp_msgs' AND INDEX_NAME = 'idx_emp_msgs_group');
SET @sql := IF(@has = 0,
  'ALTER TABLE `emp_msgs` ADD KEY `idx_emp_msgs_group` (`groupId`, `sendTime`)',
  'SELECT ''skip: idx_emp_msgs_group 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 群未读游标：emp_msgs.seq（全局自增，与 UUID 主键并存）+ 成员的 lastReadSeq
--   · 用「序号游标」而不是「时间比较」：DATETIME 只有秒级精度，
--     同一秒内「刚读完」+「又来一条」会把新消息误判成已读（实测建群后立刻发消息必现）；
--   · seq 由 MySQL 自增，插入时不用写，天然单调递增。
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'emp_msgs' AND COLUMN_NAME = 'seq');
SET @sql := IF(@has = 0,
  'ALTER TABLE `emp_msgs` ADD COLUMN `seq` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE COMMENT ''群未读游标（自增，不入业务逻辑）''',
  'SELECT ''skip: emp_msgs.seq 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'empimgroupmembers' AND COLUMN_NAME = 'lastReadSeq');
SET @sql := IF(@has = 0,
  'ALTER TABLE `empimgroupmembers` ADD COLUMN `lastReadSeq` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''最后阅读游标（emp_msgs.seq）'' AFTER `role`',
  'SELECT ''skip: empimgroupmembers.lastReadSeq 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------- 3.5 表情包（图片表情，全站共享） ----------------------------
-- 只登记「已上传附件」的引用（fileId → empmsgfiles.id），文件本身仍由 /api/msg/upload 落盘，
-- 所以不会出现两套文件存储；删除表情包也不删文件（历史消息里可能还在用）。
CREATE TABLE IF NOT EXISTS `empimemojis` (
  `id`         CHAR(36)     NOT NULL                COMMENT '主键 UUID',
  `empId`      INT          NOT NULL DEFAULT 0      COMMENT '上传者员工ID',
  `empName`    VARCHAR(60)  NOT NULL DEFAULT ''     COMMENT '上传者姓名快照',
  `fileId`     CHAR(36)     NOT NULL                COMMENT 'empmsgfiles.id（图片附件）',
  `name`       VARCHAR(100) NOT NULL DEFAULT ''     COMMENT '表情名称（默认取文件名）',
  `sortNo`     INT          NOT NULL DEFAULT 0      COMMENT '排序（小的在前）',
  `enabled`    TINYINT(1)   NOT NULL DEFAULT 1      COMMENT '是否启用',
  `createTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_empimemojis_file` (`fileId`),
  KEY `idx_empimemojis_enabled` (`enabled`, `sortNo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='即时对话表情包（全站共享）';

-- ---------------------------- 4. 结构回显（便于人工核对） ----------------------------
SHOW COLUMNS FROM `emp_msgs` LIKE 'msgType';
SHOW COLUMNS FROM `emp_msgs` LIKE 'attachId';
SHOW COLUMNS FROM `emp_msgs` LIKE 'groupId';
SHOW COLUMNS FROM `emp_msgs` LIKE 'seq';
SHOW COLUMNS FROM `empimgroupmembers` LIKE 'lastReadSeq';
SHOW TABLES LIKE 'emp%';
SHOW COLUMNS FROM `empimemojis` LIKE 'fileId';
