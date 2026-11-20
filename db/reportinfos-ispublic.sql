-- =====================================================================
-- 迁移：reportinfos 增加「公开否 ispublic」字段（2026-11-04）
-- ---------------------------------------------------------------------
-- 需求：
--   · 报表默认私有（ispublic=0），只有创建人能在报表设计器清单 / 报表中心里看到；
--   · 创建人把报表设为公开（ispublic=1）后，其他用户也能在两处列表里看到它。
-- 约定：
--   · TINYINT(1)：1=公开（其他用户可见），0=私有（默认）；
--   · 老数据全部按私有补 0；列表过滤由后端 ReportDesignerService._build_where 实现
--     （createempinfosid = 当前登录人 OR ispublic = 1）。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < reportinfos-ispublic.sql
-- =====================================================================

SET NAMES utf8mb4;

ALTER TABLE `reportinfos`
  ADD COLUMN `ispublic` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '公开否：1-公开（其他用户在清单 / 报表中心可见），0-私有（仅创建人可见）'
    AFTER `enabled`;

-- 老数据处理：升级前所有报表对所有人可见，这里把存量报表全部设为「公开」以保持原可见性；
-- 之后新建的报表默认私有（ispublic=0），由创建人自行决定是否公开
UPDATE `reportinfos` SET `ispublic` = 1;

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `reportinfos` LIKE 'ispublic';
