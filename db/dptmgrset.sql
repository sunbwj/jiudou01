-- =====================================================================
-- 表：部门负责人设置 dptmgrset（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 把组织架构（OrganizationStructure.id）与员工（empinfos.id）关联起来：
--   deptId → OrganizationStructure.id（部门）
--   empId  → empinfos.id（员工，即该部门负责人）
-- 约束：uk_dptmgrset_dept(deptId) 唯一 —— 一个部门只能设置一个负责人
-- 前端页面：dpt-mgr.html（部门负责人设置）；org.html 的查询结果列表与组织架构图展示负责人姓名
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < dptmgrset.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `dptmgrset` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT   COMMENT '主键ID（自增）',
  `deptId`      BIGINT UNSIGNED NOT NULL                  COMMENT '部门ID（OrganizationStructure.id）',
  `empId`       BIGINT UNSIGNED NOT NULL                  COMMENT '负责人员工ID（empinfos.id）',
  `remark`      VARCHAR(200)    DEFAULT NULL              COMMENT '备注（如：代管、主持工作等）',
  `createTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dptmgrset_dept` (`deptId`),
  KEY `idx_dptmgrset_empId` (`empId`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '部门负责人设置表（一个部门仅一个负责人）';

-- 示例数据（按库中现有部门 / 员工 ID 关联，存在则设置，重复执行不会报错）
INSERT IGNORE INTO `dptmgrset` (`deptId`, `empId`, `remark`)
SELECT d.`id`, e.`id`, NULL
  FROM `OrganizationStructure` d
  JOIN `empinfos` e ON e.`code` = 'E00001'
 WHERE d.`code` = 'DPT0010';

INSERT IGNORE INTO `dptmgrset` (`deptId`, `empId`, `remark`)
SELECT d.`id`, e.`id`, '兼任'
  FROM `OrganizationStructure` d
  JOIN `empinfos` e ON e.`code` = 'E00002'
 WHERE d.`code` = 'DPT0005';

INSERT IGNORE INTO `dptmgrset` (`deptId`, `empId`, `remark`)
SELECT d.`id`, e.`id`, NULL
  FROM `OrganizationStructure` d
  JOIN `empinfos` e ON e.`code` = 'E00003'
 WHERE d.`code` = 'DPT0002';

-- 结构回显（便于人工核对）
SHOW TABLES LIKE 'dptmgrset';
SELECT s.`id`, s.`deptId`, d.`code` AS deptCode, d.`nameCn` AS deptName,
       s.`empId`, e.`code` AS empCode, e.`nameCn` AS empName, s.`remark`
  FROM `dptmgrset` s
  LEFT JOIN `OrganizationStructure` d ON d.`id` = s.`deptId`
  LEFT JOIN `empinfos` e ON e.`id` = s.`empId`
 ORDER BY s.`deptId`;
