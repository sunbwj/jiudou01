-- =====================================================================
-- 升级脚本：菜单项 menuinfros 新增「显示序号」sortNo（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 用途：菜单项管理页的查询结果列表按「显示序号」升序展示（同序号按 id 升序）。
--       与「菜单组排序号 menugroupinfos.sortNo」保持同一套习惯：0-9999 的整数，默认 0。
-- 说明：既有数据按 id 顺序回填 1..N，保证升级后顺序与升级前一致。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < menuinfros-sortno.sql
-- 重复执行会报 1060（Column 'sortNo' already exists），可视为已升级完成。
-- =====================================================================

SET NAMES utf8mb4;

ALTER TABLE `menuinfros`
  ADD COLUMN `sortNo` INT NOT NULL DEFAULT 0 COMMENT '显示序号（查询结果列表按此升序）' AFTER `icon`,
  ADD KEY `idx_menuinfros_sortNo` (`sortNo`);

-- 既有记录按 id 顺序回填显示序号 1..N
UPDATE `menuinfros` m
  JOIN (
    SELECT `id`, (@seq := @seq + 1) AS seq
    FROM `menuinfros`, (SELECT @seq := 0) t
    ORDER BY `id`
  ) s ON s.`id` = m.`id`
SET m.`sortNo` = s.seq;

-- 回显（便于人工核对）
SELECT `id`, `code`, `nameCn`, `sortNo` FROM `menuinfros` ORDER BY `sortNo`, `id`;
