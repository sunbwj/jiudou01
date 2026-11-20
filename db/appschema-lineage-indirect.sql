-- ============================================================================
-- 数据中心 · 应用结构：字段血缘区分「直接派生 / 间接影响」（2026-11-19 补）
-- ----------------------------------------------------------------------------
-- 背景：原来只记「这个字段的值来自哪些字段」，漏掉了 WHERE / JOIN / GROUP BY / ORDER BY
--       里用到的列 —— 它们不提供值，但决定「哪些行存在、怎么分组、什么顺序」。
--       少了这一半，改一列时评估不出「下游哪些数字会变」。
--
-- 变更内容（appschemalink 表新增 3 列 + 唯一键加一列）：
--   1) linkType  DIRECT   值真的由来源算出（原样 / 计算 / 聚合）
--                INDIRECT 只影响行集与顺序，不提供值
--   2) subType   对齐 OpenLineage ColumnLineageDatasetFacet：
--                DIRECT   → IDENTITY / TRANSFORMATION / AGGREGATION
--                INDIRECT → FILTER / JOIN / GROUP_BY / SORT / WINDOW
--   3) masked    值经过 md5 / sha / encrypt / mask 等处理 —— 依赖还在，但原值不再向下游传播
--
-- 约定：
--   · INDIRECT 边的 targetCol 为空串：影响的是「整表 / 整个视图」，不摊到每个输出列；
--   · 存量行按默认值回填成 DIRECT（旧数据本来就只记了直接派生），不需要重算也能用；
--   · 唯一键加 subType：同一列完全可能既是连接键、又是过滤条件，两条语义都要留。
--   · 脚本可重复执行（MySQL 5.7 没有 ADD COLUMN IF NOT EXISTS，用 information_schema 判断）。
--
-- 执行：
--   cd /d/mysql/mysql_5_7_22_winx64/bin && ./mysql.exe -u sa -proger2019 \
--     --default-character-set=utf8mb4 rogerorm < appschema-lineage-indirect.sql
-- ============================================================================

SET NAMES utf8mb4;

SET @db := DATABASE();

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemalink'
                  AND COLUMN_NAME = 'linkType') = 0,
  'ALTER TABLE `appschemalink` ADD COLUMN `linkType` VARCHAR(12) NOT NULL DEFAULT ''DIRECT'' COMMENT ''血缘类型：DIRECT 直接派生 / INDIRECT 间接影响（过滤、连接、分组、排序）'' AFTER `kind`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemalink'
                  AND COLUMN_NAME = 'subType') = 0,
  'ALTER TABLE `appschemalink` ADD COLUMN `subType` VARCHAR(16) NOT NULL DEFAULT '''' COMMENT ''子类型：IDENTITY/TRANSFORMATION/AGGREGATION；INDIRECT 侧 JOIN/FILTER/GROUP_BY/SORT/WINDOW'' AFTER `linkType`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemalink'
                  AND COLUMN_NAME = 'masked') = 0,
  'ALTER TABLE `appschemalink` ADD COLUMN `masked` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''值是否经过脱敏 / 哈希（依赖在，原值不传播）'' AFTER `subType`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 唯一键要把 subType 带上，否则「既是连接键又是过滤条件」的列会被后来的那条覆盖掉
SET @sql := IF((SELECT COUNT(*) FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemalink'
                  AND INDEX_NAME = 'uk_appschemalink' AND COLUMN_NAME = 'subType') = 0,
  'ALTER TABLE `appschemalink` DROP INDEX `uk_appschemalink`, ADD UNIQUE KEY `uk_appschemalink` (`appId`,`targetObj`,`targetCol`,`sourceObj`,`sourceCol`,`subType`)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SHOW FULL COLUMNS FROM `appschemalink`;
SHOW INDEX FROM `appschemalink` WHERE Key_name = 'uk_appschemalink';
