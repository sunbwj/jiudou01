-- ============================================================================
-- 数据中心 · 应用结构：字段血缘支持「手工维护 + 图形化标注」（2026-11-20）
-- ----------------------------------------------------------------------------
-- 背景：血缘只有两个来源 —— SQL 表达式解析、字段注释反查。真实库里这两条路都够不着的地方
--       很多（过程里拼动态 SQL、跨系统同步、业务口径只有人知道），而「重新分析」是整体重建，
--       人工补的边会被一次性抹掉。所以让边可以有第三种出身：manual —— 人画的，机器不许动。
--
-- 变更内容（appschemalink 新增 3 列）：
--   note       人工标注（为什么这么连 / 口径说明），图上与表格里都显示；
--   manualBy   标注人（员工中文名），便于回溯「这条是谁说的」；
--   updateTime 最近一次人工修改时间。
--   origin 新增取值 manual：手工连线 / 把自动边「转为手工」（转完重新分析不会被覆盖）。
--
-- 约定：
--   · 重新分析只重建 origin<>'manual' 的边，手工边原样保留（同一条逻辑边以手工为准，
--     不重复插 —— 人去标了它，说明机器算的不准或算不出来）；
--   · 手工边受保护，只能由人在页面上删（lineageedgedel），机器永不删；
--   · 脚本可重复执行（MySQL 5.7 没有 ADD COLUMN IF NOT EXISTS，用 information_schema 判断）。
--
-- 执行：
--   cd /d/mysql/mysql_5_7_22_winx64/bin && ./mysql.exe -u sa -proger2019 \
--     --default-character-set=utf8mb4 rogerorm < appschema-lineage-manual.sql
-- ============================================================================

SET NAMES utf8mb4;

SET @db := DATABASE();

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemalink'
                  AND COLUMN_NAME = 'note') = 0,
  'ALTER TABLE `appschemalink` ADD COLUMN `note` VARCHAR(500) DEFAULT NULL COMMENT ''人工标注：为什么这么连 / 口径说明（空=机器解析出来的边）'' AFTER `origin`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemalink'
                  AND COLUMN_NAME = 'manualBy') = 0,
  'ALTER TABLE `appschemalink` ADD COLUMN `manualBy` VARCHAR(60) DEFAULT NULL COMMENT ''标注人（员工中文名）'' AFTER `note`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemalink'
                  AND COLUMN_NAME = 'updateTime') = 0,
  'ALTER TABLE `appschemalink` ADD COLUMN `updateTime` DATETIME DEFAULT NULL COMMENT ''最近一次人工修改时间'' AFTER `manualBy`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- origin 的取值多了一个 manual，注释跟着改（列属性与默认值保持原样，幂等）
ALTER TABLE `appschemalink`
  MODIFY COLUMN `origin` VARCHAR(12) NOT NULL DEFAULT ''
  COMMENT '边怎么来的：sql-表达式解析 / ref-注释点号引用 / calc-注释口径反查 / manual-人工标注';

SHOW FULL COLUMNS FROM `appschemalink`;
