-- ============================================================================
-- 数据中心 · 应用结构：字段血缘记录「这条边是怎么得出来的」（2026-11-19 补）
-- ----------------------------------------------------------------------------
-- 背景：血缘原来只有一条来源 —— 从 SQL 表达式解析（视图 SELECT、过程 INSERT/UPDATE）。
--       真实库里大量出处只写在**字段注释**里，例如
--         emp_msgs.attachId        「附件ID（empmsgfiles.id，空=纯文字）」
--         empimgroupmembers.empId  「成员工号（empinfos.id = useinfo.empId）」
--         projectdirs.parentId     「上级目录ID（projectdirs.id，空=项目根目录）」
--       这类信息 SQL 解析永远拿不到，但它确实存在库里、也确实可靠（是作者写下的）。
--
-- 变更内容（appschemalink 新增 1 列）：
--   origin  sql  —— 表达式解析推出来的（值确实这么算）
--           ref  —— 注释里写明的「表.列」点号引用（作者明说，可信）
--           calc —— 注释里的中文口径，按中文名反查回来（推断，页面要标低置信）
--
-- 约定：
--   · 同一逻辑边（目标列 + 来源列）只留一条，SQL 优先 —— SQL 是机器算的，注释是人写的；
--     两者都有时用 SQL 的 subType，origin 记 sql，另一条不重复插入；
--   · origin 不参与唯一键：它描述「这一条边的出身」，不是边的身份；
--   · 存量行按默认值回填 sql（旧数据本来就全部来自解析）；
--   · 脚本可重复执行（MySQL 5.7 没有 ADD COLUMN IF NOT EXISTS，用 information_schema 判断）。
--
-- 执行：
--   cd /d/mysql/mysql_5_7_22_winx64/bin && ./mysql.exe -u sa -proger2019 \
--     --default-character-set=utf8mb4 rogerorm < appschema-lineage-origin.sql
-- ============================================================================

SET NAMES utf8mb4;

SET @db := DATABASE();

SET @sql := IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemalink'
                  AND COLUMN_NAME = 'origin') = 0,
  'ALTER TABLE `appschemalink` ADD COLUMN `origin` VARCHAR(12) NOT NULL DEFAULT ''sql'' COMMENT ''边怎么来的：sql-表达式解析 / ref-注释点号引用 / calc-注释口径反查'' AFTER `masked`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'appschemalink'
                  AND INDEX_NAME = 'idx_appschemalink_origin') = 0,
  'ALTER TABLE `appschemalink` ADD KEY `idx_appschemalink_origin` (`appId`,`origin`)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SHOW FULL COLUMNS FROM `appschemalink`;
