-- =====================================================================
-- 表：用户信息 useinfo + 用户角色关联 useinforoleset（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 业务说明：
--   · 用户账号由「员工」派生：一个员工最多一个账号，账号默认取员工手机号（唯一，可手工修改）
--   · 密码用 MD5 存储（32 位小写十六进制），接口永不返回密码（列表只显示 ******）
--   · 批量创建用户时初始密码统一为 888888（服务端 MD5 后入库）
--   · token / tokenExpireTime / lastLoginTime / lastLoginIp 由登录流程写入（本模块只做展示与重置）
--   · 单点登录：token 一次签发、全站共享，有效期默认 8 小时（config.TOKEN_TTL_HOURS），
--     过期后由服务端统一返回 401，前端由框架页 main.html 统一跳转登录页
--   · 角色：一个用户可拥有多个角色，用 useinforoleset 关联 usergroup（UUID 主键）
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < useinfo.sql
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------- 1. 用户信息表 ----------------------------
CREATE TABLE IF NOT EXISTS `useinfo` (
  `id`            CHAR(36)     NOT NULL                          COMMENT '用户ID（UUID 主键，非自增）',
  `account`       VARCHAR(50)  NOT NULL                          COMMENT '登录账号（默认员工手机号，唯一，可修改）',
  `password`      CHAR(32)     NOT NULL                          COMMENT '登录密码（MD5，32 位小写十六进制）',
  `empId`         BIGINT UNSIGNED NOT NULL                        COMMENT '员工信息ID（empinfos.id，一员工一账号）',
  `token`         VARCHAR(64)  DEFAULT NULL                      COMMENT '最近一次登录授权 token（全站共享）',
  `tokenExpireTime` DATETIME   DEFAULT NULL                      COMMENT 'token 过期时间（登录时写入，默认登录时间+8小时）',
  `lastLoginTime` DATETIME     DEFAULT NULL                      COMMENT '最后一次登录时间',
  `lastLoginIp`   VARCHAR(45)  DEFAULT NULL                      COMMENT '最后一次登录客户端IP（兼容 IPv6）',
  `enabled`       TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用否：1-启用，0-停用',
  `remark`        VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createTime`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_useinfo_account` (`account`),
  UNIQUE KEY `uk_useinfo_empId`   (`empId`),
  KEY `idx_useinfo_enabled`       (`enabled`),
  KEY `idx_useinfo_token`         (`token`),
  KEY `idx_useinfo_lastLogin`     (`lastLoginTime`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '用户信息表（账号=员工手机号，密码 MD5，一员工一账号）';

-- ---------------------------- 2. 用户角色关联表（多对多） ----------------------------
CREATE TABLE IF NOT EXISTS `useinforoleset` (
  `id`         CHAR(36)     NOT NULL                          COMMENT '关联ID（UUID 主键，非自增）',
  `userId`     CHAR(36)     NOT NULL                          COMMENT '用户ID（useinfo.id）',
  `roleId`     CHAR(36)     NOT NULL                          COMMENT '角色ID（usergroup.id）',
  `createTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_useinfo_role` (`userId`, `roleId`),
  KEY `idx_useinfo_role_user` (`userId`),
  KEY `idx_useinfo_role_role` (`roleId`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '用户角色关联表（用户 ↔ 角色，多对多，UUID 主键）';

-- ---------------------------- 3. 结构回显（便于人工核对） ----------------------------
SHOW FULL COLUMNS FROM `useinfo`;
SHOW FULL COLUMNS FROM `useinforoleset`;
