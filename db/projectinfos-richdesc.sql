-- =====================================================================
-- 项目管理：项目说明富文本化（projectinfos.projectDesc）
-- ---------------------------------------------------------------------
-- 背景：项目表单由「弹窗」改为「独立页」后，项目说明支持富文本格式与 Word 导入，
--       原 VARCHAR(1000) 放不下带标签的 HTML（Word 一篇文档通常几 KB ~ 几百 KB），
--       因此扩为 MEDIUMTEXT（最大约 16 MB），后端再做长度与标签白名单清洗。
-- 约定：
--   · 本脚本可重复执行（MySQL 5.7 的 MODIFY COLUMN 幂等）；
--   · 已有纯文本说明原样保留，前端富文本编辑器会把纯文本包成 <p> 显示；
--   · db/projectinfos.sql 与 db/rogerorm-schema.sql 已同步为 MEDIUMTEXT。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < projectinfos-richdesc.sql
-- =====================================================================

SET NAMES utf8mb4;

ALTER TABLE `projectinfos`
  MODIFY COLUMN `projectDesc` MEDIUMTEXT NULL
  COMMENT '项目说明（富文本 HTML，支持文本格式与 Word 导入）';

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `projectinfos` LIKE 'projectDesc';
