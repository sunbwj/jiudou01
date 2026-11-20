-- =====================================================================
-- 表：用户角色页面按钮设置 usergrouppagebtnset（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 用途：登记「某个角色」对「某个页面操作按钮」的授权，与 usergrouppowerset（菜单权限）
--       配合，构成完整的角色权限：菜单可见 + 页面按钮可用。
--   · id：设置ID，UUID 主键（MySQL 5.7 无原生 UUID 类型，用 CHAR(36) 存标准
--         36 位 UUID 字符串），非自增，由服务端 uuid4() 生成；
--   · roleId：用户角色id，指向 usergroup.id（UUID / CHAR(36)）；
--   · pageOpBtnId：页面操作按钮id，指向 pageopbtn.id（UUID / CHAR(36)）；
--   · enabled：授权是否启用；remark：备注。
--   唯一键 uk_role_pagebtn(roleId, pageOpBtnId) 防止同一角色的同一按钮重复授权。
-- 维护入口：角色权限配置页 role-power.html（勾选「菜单组 → 菜单项(页面) → 操作按钮」后一次保存）
--           删除角色会级联清理；删除 pageopbtn 记录也会级联清理。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < usergrouppagebtnset.sql
-- 说明：本脚本只建表，不插数据 —— 数据由角色权限配置页保存时生成。
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `usergrouppagebtnset` (
  `id`           CHAR(36)     NOT NULL                          COMMENT '设置ID（UUID 主键，非自增）',
  `roleId`       CHAR(36)     NOT NULL                          COMMENT '用户角色id（usergroup.id）',
  `pageOpBtnId`  CHAR(36)     NOT NULL                          COMMENT '页面操作按钮id（pageopbtn.id）',
  `enabled`      TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '授权是否启用：1-启用，0-停用',
  `remark`       VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_pagebtn` (`roleId`, `pageOpBtnId`),
  KEY `idx_role_pagebtn_role` (`roleId`),
  KEY `idx_role_pagebtn_btn`  (`pageOpBtnId`),
  KEY `idx_role_pagebtn_enabled` (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '用户角色页面按钮设置表（角色 ↔ 页面操作按钮，UUID 主键）';

SHOW TABLES LIKE 'usergrouppagebtnset';
