-- ============================================================================
-- 数据中心 · 应用结构：实库对比支持「选连接对象 → 选数据库」
-- ----------------------------------------------------------------------------
-- 变更内容（appschemacompares 表新增 3 列）：
--   1) connId     实库连接对象（dbinfomgr.id）—— 上线前可以把实库换成线上生产库连接，
--                 不再死绑应用信息里那个开发库连接；
--   2) connName   连接名快照（连接改名 / 删除后，历史对比记录仍能看出当时比的是哪个环境）；
--   3) designDb   对应设计态的库 —— 开发库 db_dev、生产库 db_prod 这种库名不同但结构同源的场景，
--                 对比时把设计态的 designDb 当作实库的 dbName 来比，脚本里的库名仍按实库写。
--
-- 约定：
--   · 存量记录这三列为 NULL：表示「当时用的是应用绑定的连接」，历史脚本头部会标注「历史记录未记录连接」；
--   · 脚本可重复执行（MySQL 5.7 没有 ADD COLUMN IF NOT EXISTS，用 information_schema 判断后动态执行）。
--
-- 执行：
--   cd /d/mysql/mysql_5_7_22_winx64/bin && ./mysql.exe -u sa -proger2019 \
--     --default-character-set=utf8mb4 rogerorm < appschema-compare-conn.sql
-- ============================================================================

SET NAMES utf8mb4;

SET @db := DATABASE();

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemacompares'
                  AND COLUMN_NAME = 'connId') = 0,
  'ALTER TABLE `appschemacompares` ADD COLUMN `connId` CHAR(36) DEFAULT NULL COMMENT ''实库连接对象（dbinfomgr.id）'' AFTER `dbName`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemacompares'
                  AND COLUMN_NAME = 'connName') = 0,
  'ALTER TABLE `appschemacompares` ADD COLUMN `connName` VARCHAR(100) DEFAULT NULL COMMENT ''实库连接名（快照）'' AFTER `connId`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemacompares'
                  AND COLUMN_NAME = 'designDb') = 0,
  'ALTER TABLE `appschemacompares` ADD COLUMN `designDb` VARCHAR(120) DEFAULT NULL COMMENT ''对应设计态的库（库名映射用）'' AFTER `connName`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SHOW FULL COLUMNS FROM `appschemacompares`;
