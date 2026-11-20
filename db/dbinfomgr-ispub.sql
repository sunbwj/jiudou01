-- ============================================================================
-- 数据中心 · 数据库连接（dbinfomgr）：新增「创建人员工ID」与「公用否」
-- ----------------------------------------------------------------------------
-- 变更内容：
--   1) createempinfosid  创建人员工ID（empinfos.id；后端按 token 反查登录人自动带入）
--   2) ispub             公用否：1-公用（默认，大家都能用）/ 0-私有（只有创建人可用）
-- 约定：
--   · 字段在「新增数据库」弹窗里以「公用否」下拉展示，默认公用；
--   · createempinfosid 不在页面上展示，新增时由后端写入，编辑 / 启停都不会改它；
--   · MySQL 5.7 没有 ADD COLUMN IF NOT EXISTS，脚本只执行一次。
--
-- 执行：
--   cd /d/mysql/mysql_5_7_22_winx64/bin && ./mysql.exe -u sa -proger2019 \
--     --default-character-set=utf8mb4 rogerorm < ../../workbuddy-workspace/2026-10-29-12-03-22/menu-admin/db/dbinfomgr-ispub.sql
-- ============================================================================

SET NAMES utf8mb4;

ALTER TABLE `dbinfomgr`
  ADD COLUMN `createempinfosid` BIGINT UNSIGNED DEFAULT NULL
      COMMENT '创建人员工ID（empinfos.id，后端自动带入）' AFTER `remark`,
  ADD COLUMN `ispub`            TINYINT(1)      NOT NULL DEFAULT 1
      COMMENT '公用否：1-公用（默认），0-私有' AFTER `createempinfosid`;

ALTER TABLE `dbinfomgr`
  ADD KEY `idx_dbinfomgr_creator` (`createempinfosid`),
  ADD KEY `idx_dbinfomgr_pub`     (`ispub`);

-- 存量连接没有创建人：留空（NULL）即可，页面展示为「未记录」；ispub 用默认值 1（公用）
UPDATE `dbinfomgr` SET `ispub` = 1 WHERE `ispub` IS NULL;

SHOW FULL COLUMNS FROM `dbinfomgr`;
SELECT `name`, `dbType`, `ispub`, `createempinfosid` FROM `dbinfomgr` ORDER BY `name`;
