-- =====================================================================
-- 升级脚本：员工信息 empinfos 扩展档案字段（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 新增 8 个字段（均可空，不影响既有数据）：
--   birthDate     出生日期（DATE，可空）
--   idCard        身份证号（VARCHAR 18，可空；15 位老证 / 18 位新证）
--   education     最高学历（VARCHAR 20）
--   school        毕业院校（VARCHAR 100）
--   major         所学专业（VARCHAR 100）
--   certificates  执业资格证书（VARCHAR 200）
--   titleName     职称（VARCHAR 50）
--   photo         照片（MEDIUMTEXT，存 Base64 DataURL 或图片地址）
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < empinfos-ext.sql
-- 说明：MySQL 5.7 的 ADD COLUMN 不支持 IF NOT EXISTS，重复执行会报 1060（Column exists），
--       可视为已升级完成，无需处理。
-- =====================================================================

SET NAMES utf8mb4;

ALTER TABLE `empinfos`
  ADD COLUMN `birthDate`    DATE         DEFAULT NULL COMMENT '出生日期（可空）' AFTER `hireDate`,
  ADD COLUMN `idCard`       VARCHAR(18)  DEFAULT NULL COMMENT '身份证号（可空，15 / 18 位）' AFTER `birthDate`,
  ADD COLUMN `education`    VARCHAR(20)  DEFAULT NULL COMMENT '最高学历（如：本科 / 硕士）' AFTER `idCard`,
  ADD COLUMN `school`       VARCHAR(100) DEFAULT NULL COMMENT '毕业院校' AFTER `education`,
  ADD COLUMN `major`        VARCHAR(100) DEFAULT NULL COMMENT '所学专业' AFTER `school`,
  ADD COLUMN `certificates` VARCHAR(200) DEFAULT NULL COMMENT '执业资格证书（多个用顿号分隔）' AFTER `major`,
  ADD COLUMN `titleName`    VARCHAR(50)  DEFAULT NULL COMMENT '职称（如：主管护师 / 高级工程师）' AFTER `certificates`,
  ADD COLUMN `photo`        MEDIUMTEXT   DEFAULT NULL COMMENT '照片（Base64 DataURL 或图片地址）' AFTER `titleName`;

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `empinfos`;
