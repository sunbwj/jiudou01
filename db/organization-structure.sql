-- =====================================================================
-- 表：部门组织架构 OrganizationStructure（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 部门基本信息：编号（DPT + 4 位流水号，自动生成且唯一）、名称、职能说明、
--               启用否、上级部门（parentId，0 表示顶级）、同级排序号
-- 前端页面：org.html（列表 + 组织架构图）、org-form.html（新增 / 编辑）
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < organization-structure.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `OrganizationStructure` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID（自增）',
  `parentId`    BIGINT UNSIGNED NOT NULL DEFAULT 0      COMMENT '上级部门ID：0-顶级（无上级）',
  `level`       TINYINT UNSIGNED NOT NULL DEFAULT 1     COMMENT '层级：1-顶级，2-二级…（由 parentId 自动推导，最多 5 级）',
  `sortNo`      INT             NOT NULL DEFAULT 0      COMMENT '同级排序号（数值小的排在前面）',
  `code`        VARCHAR(64)     NOT NULL                COMMENT '部门编号（唯一，规则 DPT + 4 位流水号，如 DPT0001）',
  `nameCn`      VARCHAR(100)    NOT NULL                COMMENT '部门名称',
  `duty`        VARCHAR(500)    DEFAULT NULL            COMMENT '部门职能说明',
  `enabled`     TINYINT(1)      NOT NULL DEFAULT 1      COMMENT '启用否：1-启用，0-停用',
  `createTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_orgstructure_code` (`code`),
  KEY `idx_orgstructure_parentId` (`parentId`),
  KEY `idx_orgstructure_level`    (`level`),
  KEY `idx_orgstructure_nameCn`   (`nameCn`),
  KEY `idx_orgstructure_enabled`  (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '部门组织架构表（多层级：parentId + level）';

-- 初始示例数据（可按需删除）：顶级公司 → 各部门 → 二级部门
INSERT INTO `OrganizationStructure` (`parentId`, `level`, `sortNo`, `code`, `nameCn`, `duty`, `enabled`) VALUES
  (0, 1, 1, 'DPT0001', '总经理办公室', '负责公司整体经营决策、战略制定与跨部门协调。', 1),
  (1, 2, 1, 'DPT0002', '技术研发部', '负责产品架构设计、研发交付与技术攻关。', 1),
  (2, 3, 1, 'DPT0003', '前端研发组', '负责 Web / 移动端前端页面的开发与维护。', 1),
  (2, 3, 2, 'DPT0004', '后端研发组', '负责服务端接口、业务逻辑与数据持久化开发。', 1),
  (1, 2, 2, 'DPT0005', '市场运营部', '负责品牌推广、渠道运营与客户增长。', 1),
  (1, 2, 3, 'DPT0006', '财务人事部', '负责财务核算、薪酬发放与人事招聘管理。', 1);

-- 结构回显（便于人工核对）
SHOW TABLES LIKE 'OrganizationStructure';
SELECT `id`, `parentId`, `level`, `sortNo`, `code`, `nameCn`, `enabled` FROM `OrganizationStructure` ORDER BY `level`, `sortNo`, `id`;
