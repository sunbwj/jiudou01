-- =====================================================================
-- 升级脚本：用户角色 usergroup 增加「英文名」+ 中文名改为「启用状态内唯一」
-- ---------------------------------------------------------------------
-- 调整点：
--   1. 新增 nameEn（英文名）：必填、全局唯一，唯一索引 uk_usergroup_nameEn；
--   2. 中文名 nameCn 不再全局唯一，改为「仅在启用状态（enabled=1）内唯一」：
--      去掉原来的唯一索引 uk_usergroup_nameCn，改为普通索引；
--      用生成列 nameCnActive（enabled=1 时等于 nameCn，否则 NULL）+ 唯一索引保证 ——
--      MySQL 唯一索引允许多个 NULL，因此停用状态的角色可以重名，且可复用启用角色的名字。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < usergroup-nameen.sql
-- 重复执行会报表/列已存在，可视为已升级完成。
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 新增英文名列（先给默认空串，回填后再加唯一索引）
ALTER TABLE `usergroup`
  ADD COLUMN `nameEn` VARCHAR(100) NOT NULL DEFAULT '' COMMENT '英文名（唯一）' AFTER `nameCn`;

-- 2) 回填既有示例数据的英文名（其余空值按 id 兜底生成，保证唯一索引可创建）
UPDATE `usergroup` SET `nameEn` = 'SystemAdmin'   WHERE `id` = 'a1b2c3d4-0001-4a1b-8c00-000000000001';
UPDATE `usergroup` SET `nameEn` = 'BusinessAdmin' WHERE `id` = 'a1b2c3d4-0002-4a1b-8c00-000000000002';
UPDATE `usergroup` SET `nameEn` = 'NormalUser'    WHERE `id` = 'a1b2c3d4-0003-4a1b-8c00-000000000003';
UPDATE `usergroup` SET `nameEn` = 'Auditor'       WHERE `id` = 'a1b2c3d4-0004-4a1b-8c00-000000000004';
UPDATE `usergroup` SET `nameEn` = CONCAT('Role_', LEFT(REPLACE(`id`, '-', ''), 12)) WHERE `nameEn` = '';

-- 3) 中文名：全局唯一 → 仅在启用状态内唯一
ALTER TABLE `usergroup` DROP INDEX `uk_usergroup_nameCn`,
  ADD KEY `idx_usergroup_nameCn` (`nameCn`);

ALTER TABLE `usergroup`
  ADD COLUMN `nameCnActive` VARCHAR(50)
    GENERATED ALWAYS AS (IF(`enabled` = 1, `nameCn`, NULL)) STORED
    COMMENT '仅启用状态生效的中文名（用于唯一约束，停用为 NULL 不参与）',
  ADD UNIQUE KEY `uk_usergroup_nameCn_active` (`nameCnActive`);

-- 4) 英文名唯一索引
ALTER TABLE `usergroup` ADD UNIQUE KEY `uk_usergroup_nameEn` (`nameEn`);

-- 回显
SHOW INDEX FROM `usergroup`;
SELECT `id`, `nameCn`, `nameEn`, `sortNo`, `enabled` FROM `usergroup` ORDER BY `sortNo`, `id`;
