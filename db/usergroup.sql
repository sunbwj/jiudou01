-- =====================================================================
-- 表：用户角色 usergroup（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 说明：
--   · 角色ID 用 UUID 作主键（不是自增）—— MySQL 5.7 没有原生 UUID 类型，
--     这里用 CHAR(36) 存标准 36 位带连字符的 UUID 字符串（如 3f2a…-…-…），
--     由服务端 uuid4() 生成，前端模拟服务同样生成 UUID；跨库迁移到 MySQL 8 时可直接沿用。
--   · nameCn（角色名）唯一，enabled 为启用否，sortNo 为列表排序号（升序），remark 为说明。
-- 前端页面：role.html（单页完成查询 / 新增 / 编辑 / 删除，表单为弹窗）
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < usergroup.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `usergroup` (
  `id`         CHAR(36)     NOT NULL                          COMMENT '角色ID（UUID 主键，非自增）',
  `nameCn`     VARCHAR(50)  NOT NULL                          COMMENT '中文名（启用状态内唯一）',
  `nameEn`     VARCHAR(100) NOT NULL                          COMMENT '英文名（唯一）',
  `remark`     VARCHAR(200) DEFAULT NULL                      COMMENT '说明',
  `sortNo`     INT          NOT NULL DEFAULT 0                COMMENT '排序号（列表按此升序）',
  `enabled`    TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用否：1-启用，0-停用',
  `nameCnActive` VARCHAR(50)
               GENERATED ALWAYS AS (IF(`enabled` = 1, `nameCn`, NULL)) STORED
                                                            COMMENT '仅启用状态生效的中文名（唯一约束用，停用为 NULL）',
  `createTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_usergroup_nameCn` (`nameCn`),
  UNIQUE KEY `uk_usergroup_nameEn` (`nameEn`),
  UNIQUE KEY `uk_usergroup_nameCn_active` (`nameCnActive`),
  KEY `idx_usergroup_sortNo`  (`sortNo`),
  KEY `idx_usergroup_enabled` (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '用户角色表（UUID 主键）';

-- 初始示例数据（可按需删除）：固定 UUID 便于演示与联调
INSERT INTO `usergroup` (`id`, `nameCn`, `nameEn`, `remark`, `sortNo`, `enabled`) VALUES
  ('a1b2c3d4-0001-4a1b-8c00-000000000001', '系统管理员', 'SystemAdmin',   '拥有全部功能与配置权限，可管理菜单、组织架构与员工信息。', 1, 1),
  ('a1b2c3d4-0002-4a1b-8c00-000000000002', '业务管理员', 'BusinessAdmin', '负责业务数据维护，可查看组织架构与员工信息，不可修改菜单配置。', 2, 1),
  ('a1b2c3d4-0003-4a1b-8c00-000000000003', '普通用户',   'NormalUser',    '仅可访问已授权的业务菜单，只读为主。', 3, 1),
  ('a1b2c3d4-0004-4a1b-8c00-000000000004', '审计员',     'Auditor',       '可查看操作日志与报表，不可修改任何业务数据（历史角色，已停用）。', 4, 0);

-- 结构回显（便于人工核对）
SHOW TABLES LIKE 'usergroup';
SELECT `id`, `nameCn`, `nameEn`, `sortNo`, `enabled` FROM `usergroup` ORDER BY `sortNo`, `id`;
