-- =====================================================================
-- 数据库：rogerorm
-- 内容：菜单项信息表 menuinfros、菜单组信息表 menugroupinfos、
--       菜单组项目设置表 menugroupitemset（菜单组 ↔ 菜单项 的多对多关系与显示序号）
-- 环境：MySQL 5.7+（实测 5.7.22），字符集 utf8mb4 / utf8mb4_general_ci
-- 说明：列名与前端页面（menu-admin）JSON 字段保持一致，后端查询后可直接返回，
--       无需额外做驼峰/下划线转换。
--       执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 < rogerorm-schema.sql
-- =====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------- 1. 创建数据库 ----------------------------
CREATE DATABASE IF NOT EXISTS `rogerorm`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_general_ci;

USE `rogerorm`;

-- ---------------------------- 2. 菜单项信息表 ----------------------------
DROP TABLE IF EXISTS `menuinfros`;
CREATE TABLE `menuinfros` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID（自增）',
  `code`        VARCHAR(64)     NOT NULL                COMMENT '菜单编号（唯一）',
  `nameCn`      VARCHAR(100)    NOT NULL                COMMENT '菜单中文名',
  `nameEn`      VARCHAR(100)    NOT NULL                COMMENT '菜单英文名（唯一）',
  `path`        VARCHAR(255)    DEFAULT NULL            COMMENT '功能页面地址（URL）',
  `icon`        VARCHAR(64)     DEFAULT NULL            COMMENT '菜单图标名称（对应前端图标库 key）',
  `sortNo`      INT             NOT NULL DEFAULT 0      COMMENT '显示序号（查询结果列表按此升序）',
  `enabled`     TINYINT(1)      NOT NULL DEFAULT 1      COMMENT '启用否：1-启用，0-停用',
  `remark`      VARCHAR(200)    DEFAULT NULL            COMMENT '菜单功能说明',
  `createTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_menuinfros_code`   (`code`),
  UNIQUE KEY `uk_menuinfros_nameEn` (`nameEn`),
  KEY `idx_menuinfros_nameCn`  (`nameCn`),
  KEY `idx_menuinfros_enabled` (`enabled`),
  KEY `idx_menuinfros_sortNo`  (`sortNo`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '菜单项信息表';

-- ---------------------------- 3. 菜单组信息表（支持多层级） ----------------------------
DROP TABLE IF EXISTS `menugroupinfos`;
CREATE TABLE `menugroupinfos` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID（自增）',
  `parentId`    BIGINT UNSIGNED NOT NULL DEFAULT 0     COMMENT '上级菜单组ID：0-顶级（无上级）',
  `level`       TINYINT UNSIGNED NOT NULL DEFAULT 1    COMMENT '层级：1-顶级，2-二级…（由 parentId 自动推导，最多 5 级）',
  `sortNo`      INT             NOT NULL DEFAULT 0     COMMENT '同级排序号（数值小的排在前面）',
  `code`        VARCHAR(64)     NOT NULL                COMMENT '菜单组编号（唯一）',
  `nameCn`      VARCHAR(100)    NOT NULL                COMMENT '菜单组中文名',
  `nameEn`      VARCHAR(100)    NOT NULL                COMMENT '菜单组英文名（唯一）',
  `hasChild`    TINYINT(1)      NOT NULL DEFAULT 0      COMMENT '可否绑定菜单项：1-是（可绑定菜单项），0-否（默认否）',
  `path`        VARCHAR(255)    DEFAULT NULL            COMMENT '功能页面路径 URL（hasChild=0 时可填，非必填）',
  `icon`        VARCHAR(64)     DEFAULT NULL            COMMENT '菜单组图标名称（对应前端图标库 key）',
  `enabled`     TINYINT(1)      NOT NULL DEFAULT 1      COMMENT '启用否：1-启用，0-停用',
  `createTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_menugroupinfos_code`   (`code`),
  UNIQUE KEY `uk_menugroupinfos_nameEn` (`nameEn`),
  KEY `idx_menugroupinfos_parentId`  (`parentId`),
  KEY `idx_menugroupinfos_level`     (`level`),
  KEY `idx_menugroupinfos_nameCn`    (`nameCn`),
  KEY `idx_menugroupinfos_hasChild`  (`hasChild`),
  KEY `idx_menugroupinfos_enabled`   (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '菜单组信息表（支持多层级：parentId + level）';

-- ---------------------------- 4. 菜单组项目设置表 ----------------------------
-- 一个菜单组下可配置多个菜单项，一个菜单项也可归属多个菜单组；
-- sortNo 为该菜单项在「当前菜单组」内的显示序号（整型，页面列表按它升序排列）。
DROP TABLE IF EXISTS `menugroupitemset`;
CREATE TABLE `menugroupitemset` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID（自增）',
  `groupId`     BIGINT UNSIGNED NOT NULL                COMMENT '菜单组ID（对应 menugroupinfos.id）',
  `itemId`      BIGINT UNSIGNED NOT NULL                COMMENT '菜单项ID（对应 menuinfros.id）',
  `sortNo`      INT             NOT NULL DEFAULT 0      COMMENT '显示序号（同一菜单组内排序，整型 0-9999）',
  `enabled`     TINYINT(1)      NOT NULL DEFAULT 1      COMMENT '启用否：1-启用，0-停用',
  `remark`      VARCHAR(200)    DEFAULT NULL            COMMENT '备注说明',
  `createTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_menugroupitemset_group_item` (`groupId`, `itemId`),
  KEY `idx_menugroupitemset_groupId` (`groupId`),
  KEY `idx_menugroupitemset_itemId`  (`itemId`),
  KEY `idx_menugroupitemset_sortNo`  (`sortNo`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '菜单组项目设置表（菜单组与菜单项的关联及显示序号）';

-- ---------------------------- 5. 部门组织架构表（支持多层级） ----------------------------
-- 编号规则：DPT + 4 位流水号（如 DPT0001），由服务端按库中已有编号自动生成且唯一；
-- 单独建表 / 初始化示例数据可执行：db/organization-structure.sql
DROP TABLE IF EXISTS `OrganizationStructure`;
CREATE TABLE `OrganizationStructure` (
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

-- ---------------------------- 6. 员工信息表 ----------------------------
-- 工号规则：E + 5 位流水号（如 E00001），由服务端按库中已有编号自动生成且唯一，支持手工编辑；
-- 邮箱必填（服务端与前端双重格式校验），在职状态：1-在职 / 2-试用 / 0-离职；
-- 档案字段（均可空）：出生日期、身份证号（15/18 位）、最高学历、毕业院校、所学专业、
--                    执业资格证书、职称、照片（Base64 DataURL 或图片地址，MEDIUMTEXT）；
-- 单独建表 / 初始化示例数据可执行：db/empinfos.sql；既有库升级执行：db/empinfos-ext.sql
DROP TABLE IF EXISTS `empinfos`;
CREATE TABLE `empinfos` (
  `id`          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT            COMMENT '主键ID（自增）',
  `code`        VARCHAR(16)      NOT NULL                          COMMENT '工号（唯一，规则 E + 5 位流水号，如 E00001；可编辑）',
  `nameCn`      VARCHAR(50)      NOT NULL                          COMMENT '姓名',
  `gender`      TINYINT UNSIGNED NOT NULL DEFAULT 1                COMMENT '性别：1-男，2-女',
  `phone`       VARCHAR(20)      DEFAULT NULL                      COMMENT '手机号（11 位，1 开头）',
  `email`       VARCHAR(100)     NOT NULL                          COMMENT '邮箱（必填，需符合邮箱格式）',
  `deptId`      BIGINT UNSIGNED  NOT NULL DEFAULT 0                 COMMENT '所属部门ID（OrganizationStructure.id，0-未分配）',
  `jobTitle`    VARCHAR(50)      DEFAULT NULL                      COMMENT '岗位',
  `status`      TINYINT UNSIGNED NOT NULL DEFAULT 1                COMMENT '在职状态：1-在职，2-试用，0-离职',
  `hireDate`    DATE             DEFAULT NULL                      COMMENT '入职日期',
  `birthDate`   DATE             DEFAULT NULL                      COMMENT '出生日期（可空）',
  `idCard`      VARCHAR(18)      DEFAULT NULL                      COMMENT '身份证号（可空，15 / 18 位）',
  `education`   VARCHAR(20)      DEFAULT NULL                      COMMENT '最高学历（如：本科 / 硕士）',
  `school`      VARCHAR(100)     DEFAULT NULL                      COMMENT '毕业院校',
  `major`       VARCHAR(100)     DEFAULT NULL                      COMMENT '所学专业',
  `certificates` VARCHAR(200)    DEFAULT NULL                      COMMENT '执业资格证书（多个用顿号分隔）',
  `titleName`   VARCHAR(50)      DEFAULT NULL                      COMMENT '职称（如：主管护师 / 高级工程师）',
  `photo`       MEDIUMTEXT       DEFAULT NULL                      COMMENT '照片（Base64 DataURL 或图片地址）',
  `remark`      VARCHAR(200)     DEFAULT NULL                      COMMENT '备注',
  `createTime`  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_empinfos_code`  (`code`),
  KEY `idx_empinfos_nameCn`      (`nameCn`),
  KEY `idx_empinfos_email`       (`email`),
  KEY `idx_empinfos_phone`       (`phone`),
  KEY `idx_empinfos_deptId`      (`deptId`),
  KEY `idx_empinfos_status`      (`status`),
  KEY `idx_empinfos_hireDate`    (`hireDate`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '员工信息表（工号 E+5 位流水号，邮箱必填）';

-- ---------------------------- 7. 部门负责人设置表 ----------------------------
-- 关联：deptId → OrganizationStructure.id，empId → empinfos.id；
-- uk_dptmgrset_dept(deptId) 唯一 —— 一个部门只能设置一个负责人；
-- 单独建表 / 初始化示例数据可执行：db/dptmgrset.sql
DROP TABLE IF EXISTS `dptmgrset`;
CREATE TABLE `dptmgrset` (
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

-- ---------------------------- 8. 用户角色表（UUID 主键） ----------------------------
-- 角色ID 为 UUID（MySQL 5.7 无原生 UUID 类型，用 CHAR(36) 存标准 36 位 UUID 字符串），非自增；
-- 角色名唯一；sortNo 为列表排序号（升序）；enabled 为启用否。
-- 单独建表 / 初始化示例数据可执行：db/usergroup.sql
DROP TABLE IF EXISTS `usergroup`;
CREATE TABLE `usergroup` (
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

-- ------------------- 9. 角色权限表（角色 ↔ 菜单组 / 菜单项，UUID 主键） -------------------
-- id 为 UUID（CHAR(36)，非自增）；roleId → usergroup.id；menuGroupId → menugroupinfos.id；
-- menuItemId → menuinfros.id（0 表示整组授权，保存时展开为该组全部菜单项）；
-- 唯一键 (roleId, menuGroupId, menuItemId) 防重复授权。
-- 单独建表 / 初始化示例授权可执行：db/usergrouppowerset.sql
DROP TABLE IF EXISTS `usergrouppowerset`;
CREATE TABLE `usergrouppowerset` (
  `id`          CHAR(36)     NOT NULL                          COMMENT '权限ID（UUID 主键，非自增）',
  `roleId`      CHAR(36)     NOT NULL                          COMMENT '角色ID（usergroup.id）',
  `menuGroupId` INT          NOT NULL                          COMMENT '菜单组ID（menugroupinfos.id）',
  `menuItemId`  INT          NOT NULL DEFAULT 0                COMMENT '菜单项ID（menuinfros.id，0=整组授权）',
  `enabled`     TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '授权是否启用：1-启用，0-停用',
  `remark`      VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createTime`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_power_role_group_item` (`roleId`, `menuGroupId`, `menuItemId`),
  KEY `idx_power_role`  (`roleId`),
  KEY `idx_power_group` (`menuGroupId`),
  KEY `idx_power_item`  (`menuItemId`),
  KEY `idx_power_enabled` (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '角色权限表（角色 ↔ 菜单组 / 菜单项，UUID 主键）';

-- ------------------- 10. 页面操作按钮表（操作引导区按钮登记，UUID 主键） -------------------
-- id 为 UUID（CHAR(36)，非自增）；pagePath + btnId 唯一；
-- 数据由管理页 page-op-btn.html 打开时自动扫描收录（server/page_scan.py），无需手工初始化。
-- 单独建表脚本：db/pageopbtn.sql
DROP TABLE IF EXISTS `pageopbtn`;
CREATE TABLE `pageopbtn` (
  `id`         CHAR(36)     NOT NULL                          COMMENT '记录ID（UUID 主键，非自增）',
  `pageName`   VARCHAR(60)  NOT NULL                          COMMENT '所属页面（页面标题）',
  `pagePath`   VARCHAR(120) NOT NULL                          COMMENT '页面路径',
  `btnId`      VARCHAR(64)  NOT NULL                          COMMENT '操作按钮id（页面内元素 id）',
  `btnText`    VARCHAR(60)  NOT NULL                          COMMENT '操作按钮文本',
  `sortNo`     INT          NOT NULL DEFAULT 0                COMMENT '按钮在页面中的顺序',
  `enabled`    TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用否：1-启用，0-停用',
  `remark`     VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pageopbtn_page_btn` (`pagePath`, `btnId`),
  KEY `idx_pageopbtn_page`    (`pagePath`),
  KEY `idx_pageopbtn_enabled` (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '页面操作按钮表（操作引导区按钮登记，UUID 主键）';

-- ----------- 11. 用户角色页面按钮设置表（角色 ↔ 页面操作按钮，UUID 主键） -----------
-- id 为 UUID（CHAR(36)，非自增）；roleId → usergroup.id；pageOpBtnId → pageopbtn.id；
-- 唯一键 (roleId, pageOpBtnId)；与 usergrouppowerset 一起构成完整角色权限（菜单 + 按钮）。
-- 单独建表脚本：db/usergrouppagebtnset.sql
DROP TABLE IF EXISTS `usergrouppagebtnset`;
CREATE TABLE `usergrouppagebtnset` (
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

-- ---------------------------- 12. 员工信息归档表（UUID 主键，整表快照） ----------------------------
-- 一次归档 = 一个批次（batchId UUID + archiveTime 归档时间），把 empinfos 当前全部记录快照留存；
-- 归档记录 id 为 UUID，原员工 id 存 empId；其余字段与 empinfos 一一对应；只追加，不改历史批次。
-- 单独建表脚本：db/empinfoarchive.sql
DROP TABLE IF EXISTS `empinfoarchive`;
CREATE TABLE `empinfoarchive` (
  `id`           CHAR(36)        NOT NULL                         COMMENT '归档记录ID（UUID）',
  `batchId`      CHAR(36)        NOT NULL                         COMMENT '归档批次ID（UUID，一次归档一个批次）',
  `archiveTime`  DATETIME        NOT NULL                         COMMENT '归档时间',
  `empId`        BIGINT UNSIGNED NOT NULL                         COMMENT '原员工ID（empinfos.id）',
  `code`         VARCHAR(16)     NOT NULL                         COMMENT '工号',
  `nameCn`       VARCHAR(50)     NOT NULL                         COMMENT '姓名',
  `gender`       TINYINT UNSIGNED NOT NULL DEFAULT 1              COMMENT '性别：1-男，2-女',
  `phone`        VARCHAR(20)     DEFAULT NULL                     COMMENT '手机号',
  `email`        VARCHAR(100)    NOT NULL                         COMMENT '邮箱',
  `deptId`       BIGINT UNSIGNED NOT NULL DEFAULT 0               COMMENT '所属部门ID（OrganizationStructure.id，0-未分配）',
  `jobTitle`     VARCHAR(50)     DEFAULT NULL                     COMMENT '岗位',
  `status`       TINYINT UNSIGNED NOT NULL DEFAULT 1              COMMENT '在职状态：1-在职，2-试用，0-离职',
  `hireDate`     DATE            DEFAULT NULL                     COMMENT '入职日期',
  `birthDate`    DATE            DEFAULT NULL                     COMMENT '出生日期',
  `idCard`       VARCHAR(18)     DEFAULT NULL                     COMMENT '身份证号',
  `education`    VARCHAR(20)     DEFAULT NULL                     COMMENT '最高学历',
  `school`       VARCHAR(100)    DEFAULT NULL                     COMMENT '毕业院校',
  `major`        VARCHAR(100)    DEFAULT NULL                     COMMENT '所学专业',
  `certificates` VARCHAR(200)    DEFAULT NULL                     COMMENT '执业资格证书',
  `titleName`    VARCHAR(50)     DEFAULT NULL                     COMMENT '职称',
  `photo`        MEDIUMTEXT      DEFAULT NULL                     COMMENT '照片（Base64 DataURL 或图片地址）',
  `remark`       VARCHAR(200)    DEFAULT NULL                     COMMENT '备注',
  `createTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '员工记录创建时间（取自 empinfos.createTime）',
  `updateTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '员工记录更新时间（取自 empinfos.updateTime）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_emparchive_batch_emp` (`batchId`, `empId`),
  KEY `idx_emparchive_batch`   (`batchId`),
  KEY `idx_emparchive_time`    (`archiveTime`),
  KEY `idx_emparchive_code`    (`code`),
  KEY `idx_emparchive_nameCn`  (`nameCn`),
  KEY `idx_emparchive_deptId`  (`deptId`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '员工信息归档表（按批次整表快照，只追加）';

-- ---------------------------- 13. 用户信息表（UUID 主键，账号=员工手机号） ----------------------------
-- 账号唯一、一员工一账号（empId 唯一）；密码存 MD5（32 位小写）；批量创建初始密码 888888；
-- token / tokenExpireTime / lastLoginTime / lastLoginIp 记录最近一次登录授权信息
-- （单点登录：token 一次签发全站共享，有效期默认 8 小时）。
-- 单独建表脚本：db/useinfo.sql（增量迁移：db/useinfo-token-expire.sql）
DROP TABLE IF EXISTS `useinfo`;
CREATE TABLE `useinfo` (
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

-- ---------------------------- 14. 用户角色关联表（UUID 主键，多对多） ----------------------------
DROP TABLE IF EXISTS `useinforoleset`;
CREATE TABLE `useinforoleset` (
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

-- ---------------------------- 15. 服务信箱（UUID 主键，单例表：全表仅一条记录） ----------------------------
-- 收件 / 发件账号：password 加密存储、接口不返回；singleFlag 生成列 + 唯一索引保证「全表只有一条记录」，
-- enabledFlag 生成列 + 唯一索引保证「这条记录只有一个启用状态位」。
-- 单独建表脚本：db/serviceemail.sql；历史库迁移：db/serviceemail-single.sql
DROP TABLE IF EXISTS `serviceemail`;
CREATE TABLE `serviceemail` (
  `id`           CHAR(36)     NOT NULL                          COMMENT '服务信箱ID（UUID 主键，非自增）',
  `email`        VARCHAR(120) NOT NULL                          COMMENT '服务信箱地址（全局唯一）',
  `password`     VARCHAR(255) NOT NULL                          COMMENT '邮箱密码 / 授权码（加密存储，接口不返回）',
  `displayName`  VARCHAR(80)  DEFAULT NULL                      COMMENT '发件人显示名（默认取邮箱前缀）',
  `smtpHost`     VARCHAR(120) DEFAULT NULL                      COMMENT 'SMTP 服务器（留空按邮箱域名自动推断）',
  `smtpPort`     INT(11)      DEFAULT NULL                      COMMENT 'SMTP 端口（留空按服务商默认：465/587）',
  `imapHost`     VARCHAR(120) DEFAULT NULL                      COMMENT 'IMAP 服务器（留空按邮箱域名自动推断）',
  `imapPort`     INT(11)      DEFAULT NULL                      COMMENT 'IMAP 端口（留空默认 993）',
  `useSsl`       TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用 SSL：1-SSL/465，0-STARTTLS/587',
  `enabled`      TINYINT(1)   NOT NULL DEFAULT 0                COMMENT '启用否：1-启用（全表仅一条），0-停用',
  `enabledFlag`  TINYINT(1)   GENERATED ALWAYS AS (IF(`enabled` = 1, 1, NULL)) STORED
                                                                COMMENT '唯一启用标记（生成列，配合唯一索引）',
  `singleFlag`   TINYINT(1)   GENERATED ALWAYS AS (1) STORED     COMMENT '单例标记（生成列恒为 1，配合唯一索引保证全表只有一条记录）',
  `lastSyncTime` DATETIME     DEFAULT NULL                      COMMENT '最近一次收件同步时间',
  `lastError`    VARCHAR(255) DEFAULT NULL                      COMMENT '最近一次收件 / 测试失败原因',
  `remark`       VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_serviceemail_email`   (`email`),
  UNIQUE KEY `uk_serviceemail_enabled` (`enabledFlag`),
  UNIQUE KEY `uk_serviceemail_single`  (`singleFlag`),
  KEY `idx_serviceemail_enabled`       (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '服务信箱（收件 / 发件账号，单例表：全表仅一条）';

-- ---------------------------- 16. 服务信箱邮件（收件 / 发件，UUID 主键） ----------------------------
DROP TABLE IF EXISTS `serviceemailmsg`;
CREATE TABLE `serviceemailmsg` (
  `id`             CHAR(36)     NOT NULL                        COMMENT '邮件ID（UUID 主键，非自增）',
  `serviceEmailId` CHAR(36)     NOT NULL                        COMMENT '所属服务信箱（serviceemail.id）',
  `direction`      VARCHAR(8)   NOT NULL                        COMMENT '方向：in-收件，out-发件',
  `uid`            VARCHAR(120) NOT NULL                        COMMENT '收件=IMAP UID，发件=本地消息ID（去重用）',
  `messageId`      VARCHAR(255) DEFAULT NULL                    COMMENT '邮件 Message-ID',
  `fromAddr`       VARCHAR(255) DEFAULT NULL                    COMMENT '发件人地址',
  `fromName`       VARCHAR(120) DEFAULT NULL                    COMMENT '发件人名称',
  `toAddr`         TEXT                                        COMMENT '收件人（多个以 , 分隔）',
  `ccAddr`         TEXT                                        COMMENT '抄送人（多个以 , 分隔）',
  `subject`        VARCHAR(500) DEFAULT NULL                    COMMENT '主题',
  `sentTime`       DATETIME     DEFAULT NULL                    COMMENT '邮件时间（收件=收信时间，发件=发送时间）',
  `bodyText`       MEDIUMTEXT                                  COMMENT '纯文本正文',
  `bodyHtml`       MEDIUMTEXT                                  COMMENT 'HTML 正文（仅有 HTML 邮件时写入）',
  `hasAttach`      TINYINT(1)   NOT NULL DEFAULT 0              COMMENT '是否带附件：1-是（附件内容不落地）',
  `attachInfo`     VARCHAR(1000) DEFAULT NULL                   COMMENT '附件清单（JSON：[{name,size}]；附件内容不落地）',
  `seen`           TINYINT(1)   NOT NULL DEFAULT 0              COMMENT '是否已读：1-已读，0-未读',
  `createTime`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_serviceemailmsg_uid` (`serviceEmailId`, `direction`, `uid`),
  KEY `idx_serviceemailmsg_list` (`serviceEmailId`, `direction`, `sentTime`),
  KEY `idx_serviceemailmsg_seen` (`serviceEmailId`, `seen`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '服务信箱邮件（in=收件，out=发件，按 IMAP UID 去重）';

-- ---------------------------- dbinfomgr：数据中心 · 数据库连接对象 ----------------------------
CREATE TABLE IF NOT EXISTS `dbinfomgr` (
  `id`           CHAR(36)     NOT NULL                          COMMENT '连接ID（UUID 主键，非自增）',
  `name`         VARCHAR(100) NOT NULL                          COMMENT '连接名称（唯一）',
  `dbType`       VARCHAR(30)  NOT NULL DEFAULT 'mysql'          COMMENT '数据库类型：mysql/mariadb/postgresql/oracle/sqlserver/sqlite',
  `host`         VARCHAR(120) DEFAULT NULL                      COMMENT '主机地址（SQLite 留空）',
  `port`         INT(11)      DEFAULT NULL                      COMMENT '端口（留空按类型默认）',
  `dbName`       VARCHAR(120) DEFAULT NULL                      COMMENT '默认库 / 服务名 / SID / SQLite 库文件路径',
  `username`     VARCHAR(100) DEFAULT NULL                      COMMENT '登录账号',
  `password`     VARCHAR(255) DEFAULT NULL                      COMMENT '登录密码（加密存储，接口不返回）',
  `charset`      VARCHAR(40)  DEFAULT NULL                      COMMENT '字符集',
  `extraParams`  VARCHAR(500) DEFAULT NULL                      COMMENT '附加连接参数',
  `enabled`      TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用否：1-启用，0-停用',
  `lastScanTime` DATETIME     DEFAULT NULL                      COMMENT '最近一次扫描成功时间',
  `lastError`    VARCHAR(500) DEFAULT NULL                      COMMENT '最近一次扫描失败原因',
  `remark`       VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createempinfosid` BIGINT UNSIGNED DEFAULT NULL               COMMENT '创建人员工ID（empinfos.id）',
  `ispub`        TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '公用否：1-公用（默认），0-私有',
  `createTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dbinfomgr_name` (`name`),
  KEY `idx_dbinfomgr_type` (`dbType`),
  KEY `idx_dbinfomgr_enabled` (`enabled`),
  KEY `idx_dbinfomgr_creator` (`createempinfosid`),
  KEY `idx_dbinfomgr_pub` (`ispub`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '数据库连接对象信息（数据中心，供结构扫描使用）';

-- ---------------------------- reportinfos：数据中心 · 报表信息（报表设计器） ----------------------------
CREATE TABLE IF NOT EXISTS `reportinfos` (
  `id`           CHAR(36)      NOT NULL                        COMMENT '报表ID（UUID 主键，非自增）',
  `code`         VARCHAR(60)   NOT NULL                        COMMENT '报表编码（唯一，调用入口）',
  `reportName`   VARCHAR(120)  NOT NULL                        COMMENT '报表名称',
  `reportNameEn` VARCHAR(120)  DEFAULT NULL                    COMMENT '英文名',
  `category`     VARCHAR(60)   DEFAULT NULL                    COMMENT '报表分类',
  `connId`       CHAR(36)      DEFAULT NULL                    COMMENT '数据库连接ID（dbinfomgr.id）',
  `connName`     VARCHAR(100)  DEFAULT NULL                    COMMENT '连接名称快照',
  `connType`     VARCHAR(30)   DEFAULT NULL                    COMMENT '数据源类型快照',
  `connHost`     VARCHAR(120)  DEFAULT NULL                    COMMENT '数据源主机快照',
  `connPort`     INT(11)       DEFAULT NULL                    COMMENT '数据源端口快照',
  `connDbName`   VARCHAR(120)  DEFAULT NULL                    COMMENT '数据源默认库快照',
  `connUsername` VARCHAR(100)  DEFAULT NULL                    COMMENT '数据源登录账号快照',
  `connPassword` VARCHAR(255)  DEFAULT NULL                    COMMENT '数据源登录密码快照（加密）',
  `connCharset`  VARCHAR(40)   DEFAULT NULL                    COMMENT '数据源字符集快照',
  `connExtraParams` VARCHAR(500) DEFAULT NULL                  COMMENT '数据源附加连接参数快照',
  `databaseName` VARCHAR(120)  DEFAULT NULL                    COMMENT '实例 / 库名',
  `mainTable`    VARCHAR(120)  DEFAULT NULL                    COMMENT '主表 / 视图（未写 SQL 时按它自动拼查询）',
  `sqlText`      MEDIUMTEXT                                    COMMENT '报表查询 SQL（可用 :参数名 占位）',
  `paramsJson`   MEDIUMTEXT                                    COMMENT '报表参数定义 JSON',
  `columnsJson`  MEDIUMTEXT                                    COMMENT '报表列定义 JSON',
  `designJson`   MEDIUMTEXT                                    COMMENT '画布设计 JSON',
  `templateJson` MEDIUMTEXT                                    COMMENT '页面模板 JSON',
  `description`  VARCHAR(500)  DEFAULT NULL                    COMMENT '报表说明',
  `enabled`      TINYINT(1)    NOT NULL DEFAULT 1              COMMENT '启用否：1-启用，0-停用',
  `ispublic`     TINYINT(1)    NOT NULL DEFAULT 0              COMMENT '公开否：1-公开（其他用户在清单 / 报表中心可见），0-私有（仅创建人可见）',
  `version`      INT(11)       NOT NULL DEFAULT 1              COMMENT '版本号（每次保存 +1）',
  `runCount`     INT(11)       NOT NULL DEFAULT 0              COMMENT '被调用次数',
  `lastRunTime`  DATETIME      DEFAULT NULL                    COMMENT '最近一次预览 / 调用时间',
  `createEname`  VARCHAR(100)  DEFAULT NULL                    COMMENT '创建人姓名（后端按登录用户自动带入）',
  `createempinfosid` BIGINT UNSIGNED DEFAULT NULL              COMMENT '创建人员工ID（empinfos.id）',
  `updateEname`  VARCHAR(100)  DEFAULT NULL                    COMMENT '最后修改人姓名',
  `updateempinfosid` BIGINT UNSIGNED DEFAULT NULL              COMMENT '最后修改人员工ID（empinfos.id）',
  `createTime`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_reportinfos_code` (`code`),
  KEY `idx_reportinfos_category` (`category`),
  KEY `idx_reportinfos_conn` (`connId`),
  KEY `idx_reportinfos_enabled` (`enabled`),
  KEY `idx_reportinfos_creator` (`createempinfosid`),
  KEY `idx_reportinfos_updater` (`updateempinfosid`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '报表信息表（报表设计器持久化，供后续调用）';

-- ---------------------------- 3.18 项目信息表 projectinfos ----------------------------
-- UUID 主键；项目编号 PRO + 6 位流水号由后端自动生成；ispub 公用否 + createempinfosid
-- 共同决定「本人创建 / 他人公用」的检索可见性。完整注释见 db/projectinfos.sql
CREATE TABLE IF NOT EXISTS `projectinfos` (
  `id`               CHAR(36)      NOT NULL                        COMMENT '项目ID（UUID 主键，非自增）',
  `projectCode`      VARCHAR(30)   NOT NULL                        COMMENT '项目编号（唯一，自动生成：PRO + 6 位流水号）',
  `projectType`      VARCHAR(30)   NOT NULL DEFAULT '其它'          COMMENT '项目类型：研发/实施/测试/设计/产品/需求/数据分析/科研/其它',
  `projectName`      VARCHAR(150)  NOT NULL                        COMMENT '项目名称（唯一）',
  `projectDesc`      MEDIUMTEXT    DEFAULT NULL                    COMMENT '项目说明（富文本 HTML / Word 导入）',
  `projectStatus`    VARCHAR(30)   NOT NULL DEFAULT '未开始'        COMMENT '项目状态：未开始/进行中/已暂停/已完成/已归档',
  `ispub`            TINYINT(1)    NOT NULL DEFAULT 1              COMMENT '公用否：1-公用，0-私有',
  `createEname`      VARCHAR(100)  DEFAULT NULL                    COMMENT '创建人姓名（后端按登录用户自动带入）',
  `createempinfosid` BIGINT UNSIGNED DEFAULT NULL                  COMMENT '创建人员工ID（empinfos.id）',
  `createTime`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `enabled`          TINYINT(1)    NOT NULL DEFAULT 1              COMMENT '启用否：1-启用，0-停用',
  `updateTime`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_projectinfos_code` (`projectCode`),
  UNIQUE KEY `uk_projectinfos_name` (`projectName`),
  KEY `idx_projectinfos_type`       (`projectType`),
  KEY `idx_projectinfos_status`     (`projectStatus`),
  KEY `idx_projectinfos_creator`    (`createempinfosid`),
  KEY `idx_projectinfos_pub`        (`ispub`),
  KEY `idx_projectinfos_enabled`    (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '项目信息表（项目台账，PRO + 6 位流水号）';

-- ---------------------------- 3.19 项目文件信息表 projectfiles ----------------------------
-- file实体写在 data/projectfiles/<YYYYMM>/<UUID>.<ext>，filePath 存相对静态根路径；
-- ispub 公用否 + uploadempinfosid 共同决定检索 / 下载可见性。完整注释见 db/projectfiles.sql
CREATE TABLE IF NOT EXISTS `projectfiles` (
  `id`                CHAR(36)      NOT NULL                       COMMENT '文件ID（UUID 主键，非自增）',
  `projectId`         CHAR(36)      NOT NULL                       COMMENT '项目信息表ID（projectinfos.id）',
  `dirId`             CHAR(36)      DEFAULT NULL                   COMMENT '所属目录ID（projectdirs.id；空=直接关联项目）',
  `projectCode`       VARCHAR(30)   DEFAULT NULL                   COMMENT '项目编号快照',
  `projectName`       VARCHAR(150)  DEFAULT NULL                   COMMENT '项目名称快照',
  `fileType`          VARCHAR(30)   NOT NULL DEFAULT '其它'         COMMENT '文件类型：文档/表格/图片/压缩包/代码/设计稿/其它',
  `fileName`          VARCHAR(255)  NOT NULL                       COMMENT '文件名（含扩展名）',
  `filePath`          VARCHAR(500)  NOT NULL                       COMMENT '文件路径（相对静态根）',
  `fileSize`          BIGINT UNSIGNED NOT NULL DEFAULT 0           COMMENT '文件大小（字节）',
  `fileDesc`          VARCHAR(500)  DEFAULT NULL                   COMMENT '文件说明',
  `ispub`             TINYINT(1)    NOT NULL DEFAULT 1             COMMENT '公用否：1-公用，0-私有',
  `uploadEname`       VARCHAR(100)  DEFAULT NULL                   COMMENT '上传人姓名（后端按登录用户自动带入）',
  `uploadempinfosid`  BIGINT UNSIGNED DEFAULT NULL                 COMMENT '上传人员工ID（empinfos.id）',
  `uploadTime`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上传时间',
  `enabled`           TINYINT(1)    NOT NULL DEFAULT 1             COMMENT '启用否：1-启用，0-停用',
  `createTime`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_projectfiles_project`  (`projectId`),
  KEY `idx_projectfiles_dir`      (`dirId`),
  KEY `idx_projectfiles_type`     (`fileType`),
  KEY `idx_projectfiles_uploader` (`uploadempinfosid`),
  KEY `idx_projectfiles_pub`      (`ispub`),
  KEY `idx_projectfiles_enabled`  (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '项目文件信息表（挂在项目下的文件，含路径与上传人）';

-- ---------------------------- 3.19b 项目目录表 projectdirs ----------------------------
-- parentId 自关联形成目录树；项目文件通过 projectfiles.dirId 归属到目录，
-- dirId 为空则文件直接关联项目。完整注释与幂等变更脚本见 db/projectdirs.sql
CREATE TABLE IF NOT EXISTS `projectdirs` (
  `id`                CHAR(36)      NOT NULL                        COMMENT '目录ID（UUID 主键，非自增）',
  `projectId`         CHAR(36)      NOT NULL                        COMMENT '项目信息表ID（projectinfos.id）',
  `parentId`          CHAR(36)      DEFAULT NULL                    COMMENT '上级目录ID（projectdirs.id，空=项目根目录）',
  `dirName`           VARCHAR(150)  NOT NULL                        COMMENT '目录名',
  `dirDesc`           VARCHAR(500)  DEFAULT NULL                    COMMENT '说明',
  `ispub`             TINYINT(1)    NOT NULL DEFAULT 1              COMMENT '公开否：1-公用，0-私有',
  `createEname`       VARCHAR(100)  DEFAULT NULL                    COMMENT '创建人姓名（后端按登录用户自动带入）',
  `createempinfosid`  BIGINT UNSIGNED DEFAULT NULL                  COMMENT '创建人员工ID（empinfos.id）',
  `createTime`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `enabled`           TINYINT(1)    NOT NULL DEFAULT 1              COMMENT '启用否：1-启用，0-停用',
  `updateTime`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_projectdirs_project` (`projectId`),
  KEY `idx_projectdirs_parent`  (`parentId`),
  KEY `idx_projectdirs_creator` (`createempinfosid`),
  KEY `idx_projectdirs_pub`     (`ispub`),
  KEY `idx_projectdirs_enabled` (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '项目目录表（挂在项目下的多级文件夹）';

-- ---------------------------- 3.20 系统字典表 sysdict ----------------------------
-- 系统配置：字典「键」（中文名 / 英文名唯一 / 上级ID / 显示序号 / 说明 / 启用否）。
-- parentId 指向本表 id，支持字典分组；字典的「值」在 sysdictitems。完整注释见 db/sysdict.sql
CREATE TABLE IF NOT EXISTS `sysdict` (
  `id`           CHAR(36)      NOT NULL                          COMMENT '字典ID（UUID 主键，非自增）',
  `dictNameCn`   VARCHAR(150)  NOT NULL                          COMMENT '键中文名',
  `dictNameEn`   VARCHAR(100)  NOT NULL                          COMMENT '键英文名（唯一，供程序按 key 取字典）',
  `parentId`     CHAR(36)      DEFAULT NULL                      COMMENT '上级ID（sysdict.id；NULL/空=顶级）',
  `sortNo`       INT           NOT NULL DEFAULT 0                COMMENT '显示序号（升序）',
  `remark`       VARCHAR(500)  DEFAULT NULL                      COMMENT '说明',
  `enabled`      TINYINT(1)    NOT NULL DEFAULT 1                COMMENT '启用否：1-启用，0-停用',
  `createTime`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sysdict_nameen` (`dictNameEn`),
  KEY `idx_sysdict_parent`  (`parentId`),
  KEY `idx_sysdict_sort`    (`sortNo`),
  KEY `idx_sysdict_enabled` (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '系统字典表（键：中文名 / 英文名 / 上级 / 显示序号 / 说明 / 启用否）';

-- ---------------------------- 3.21 系统字典明细表 sysdictitems ----------------------------
-- 系统配置：字典「键值」（所属字典ID / 键编码 itemKey / 键值 itemValue / 显示序号 / 说明 / 启用否）。
-- 同一字典下 itemKey 唯一，NULL 时允许有多条（纯枚举字典）。完整注释见 db/sysdictitems.sql
CREATE TABLE IF NOT EXISTS `sysdictitems` (
  `id`          CHAR(36)      NOT NULL                          COMMENT '明细ID（UUID 主键，非自增）',
  `dictId`      CHAR(36)      NOT NULL                          COMMENT '系统字典表ID（sysdict.id）',
  `itemKey`     VARCHAR(150)  DEFAULT NULL                      COMMENT '键（编码 / 选项值，选填；同字典下唯一）',
  `itemValue`   VARCHAR(300)  NOT NULL                          COMMENT '键值（显示值 / 枚举值）',
  `sortNo`      INT           NOT NULL DEFAULT 0                COMMENT '显示序号（升序）',
  `remark`      VARCHAR(500)  DEFAULT NULL                      COMMENT '说明',
  `enabled`     TINYINT(1)    NOT NULL DEFAULT 1                COMMENT '启用否：1-启用，0-停用',
  `createTime`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sysdictitems_key` (`dictId`, `itemKey`),
  KEY `idx_sysdictitems_dict`    (`dictId`),
  KEY `idx_sysdictitems_sort`    (`sortNo`),
  KEY `idx_sysdictitems_enabled` (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '系统字典明细表（挂在各字典下的键值）';

-- ---------------------------- 3.22 系统参数表 syspara ----------------------------
-- 系统配置：参数（中文名 / 英文名唯一 / 参数值 / 显示序号 / 说明 / 启用否）。完整注释见 db/syspara.sql
CREATE TABLE IF NOT EXISTS `syspara` (
  `id`          CHAR(36)      NOT NULL                          COMMENT '参数ID（UUID 主键，非自增）',
  `paraNameCn`  VARCHAR(150)  NOT NULL                          COMMENT '参数中文名',
  `paraNameEn`  VARCHAR(100)  NOT NULL                          COMMENT '参数英文名（唯一，供程序按 key 取值）',
  `paraValue`   VARCHAR(1000) DEFAULT NULL                      COMMENT '参数值（文本 / 数字 / JSON 文本）',
  `sortNo`      INT           NOT NULL DEFAULT 0                COMMENT '显示序号（升序）',
  `remark`      VARCHAR(500)  DEFAULT NULL                      COMMENT '说明',
  `enabled`     TINYINT(1)    NOT NULL DEFAULT 1                COMMENT '启用否：1-启用，0-停用',
  `createTime`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_syspara_nameen` (`paraNameEn`),
  KEY `idx_syspara_sort`    (`sortNo`),
  KEY `idx_syspara_enabled` (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '系统参数表（参数中文名 / 英文名 / 参数值 / 显示序号 / 说明 / 启用否）';

-- ---------------------------- 3.23 员工个人信箱配置 empemailbox ----------------------------
-- 员工个人邮箱助手：一人一条配置（empId 唯一），密码加密存储；autoSync=1 参与后台自动收件。
-- 完整注释见 db/emp-mail.sql
CREATE TABLE IF NOT EXISTS `empemailbox` (
  `id`           CHAR(36)     NOT NULL                          COMMENT '配置ID（UUID 主键，非自增）',
  `empId`        BIGINT UNSIGNED NOT NULL                      COMMENT '归属员工（empinfos.id = useinfo.empId，一人一条）',
  `email`        VARCHAR(120) NOT NULL                          COMMENT '个人邮箱地址',
  `password`     VARCHAR(255) NOT NULL DEFAULT ''               COMMENT '邮箱密码 / 授权码（加密存储，接口不返回）',
  `displayName`  VARCHAR(80)  DEFAULT NULL                      COMMENT '发件人显示名（默认取邮箱前缀）',
  `smtpHost`     VARCHAR(120) DEFAULT NULL                      COMMENT 'SMTP 服务器（留空按邮箱域名推断）',
  `smtpPort`     INT(11)      DEFAULT NULL                      COMMENT 'SMTP 端口',
  `imapHost`     VARCHAR(120) DEFAULT NULL                      COMMENT 'IMAP 服务器（留空按邮箱域名推断）',
  `imapPort`     INT(11)      DEFAULT NULL                      COMMENT 'IMAP 端口',
  `useSsl`       TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用 SSL：1-SSL/465，0-STARTTLS/587',
  `enabled`      TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用否：1-启用，0-停用',
  `autoSync`     TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '自动收件：1-后台每 5 分钟收，0-只手动收',
  `lastSyncTime` DATETIME     DEFAULT NULL                      COMMENT '最近一次收件同步时间',
  `lastError`    VARCHAR(255) DEFAULT NULL                      COMMENT '最近一次收件 / 测试失败原因',
  `remark`       VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_empemailbox_emp`   (`empId`),
  KEY `idx_empemailbox_sync`        (`enabled`, `autoSync`),
  KEY `idx_empemailbox_email`       (`email`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '员工个人信箱配置（一人一条，密码加密存储 / autoSync 自动收件）';

-- ---------------------------- 3.24 员工个人邮件 empmailmsg ----------------------------
-- 每封邮件都带归属员工 empId，后端所有读写强制按登录人过滤，做到「仅本人可见」。
CREATE TABLE IF NOT EXISTS `empmailmsg` (
  `id`             CHAR(36)     NOT NULL                        COMMENT '邮件ID（UUID 主键，非自增）',
  `empId`          BIGINT UNSIGNED NOT NULL                    COMMENT '归属员工（empinfos.id，强隔离字段）',
  `direction`      VARCHAR(8)   NOT NULL                        COMMENT '方向：in-收件，out-发件',
  `uid`            VARCHAR(120) NOT NULL                        COMMENT '收件=IMAP UID，发件=本地消息ID',
  `messageId`      VARCHAR(255) DEFAULT NULL                    COMMENT '邮件 Message-ID',
  `fromAddr`       VARCHAR(255) DEFAULT NULL                    COMMENT '发件人地址',
  `fromName`       VARCHAR(120) DEFAULT NULL                    COMMENT '发件人名称',
  `toAddr`         TEXT                                        COMMENT '收件人（多个以 , 分隔）',
  `ccAddr`         TEXT                                        COMMENT '抄送人（多个以 , 分隔）',
  `subject`        VARCHAR(500) DEFAULT NULL                    COMMENT '主题',
  `sentTime`       DATETIME     DEFAULT NULL                    COMMENT '邮件时间',
  `bodyText`       MEDIUMTEXT                                  COMMENT '纯文本正文',
  `bodyHtml`       MEDIUMTEXT                                  COMMENT 'HTML 正文',
  `hasAttach`      TINYINT(1)   NOT NULL DEFAULT 0              COMMENT '是否带附件（附件内容不落地）',
  `attachInfo`     VARCHAR(1000) DEFAULT NULL                   COMMENT '附件清单（JSON：[{name,size}]）',
  `seen`           TINYINT(1)   NOT NULL DEFAULT 0              COMMENT '是否已读：1-已读，0-未读',
  `createTime`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_empmailmsg_uid`  (`empId`, `direction`, `uid`),
  KEY `idx_empmailmsg_list`       (`empId`, `direction`, `sentTime`),
  KEY `idx_empmailmsg_seen`       (`empId`, `seen`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '员工个人邮件（in=收件，out=发件，按 empId 强隔离 / IMAP UID 去重）';

-- ---------------------------- 3.25 站内消息 emp_msgs ----------------------------
-- 员工之间互发（WebSocket 实时 IM 落库）；归属由登录 token 反查 empId 决定，双方各自软删。
CREATE TABLE IF NOT EXISTS `emp_msgs` (
  `id`              CHAR(36)        NOT NULL                    COMMENT '消息ID（UUID 主键，非自增）',
  `senderId`        BIGINT UNSIGNED NOT NULL                    COMMENT '发件人员工ID（empinfos.id = useinfo.empId）',
  `senderName`      VARCHAR(50)     NOT NULL DEFAULT ''         COMMENT '发件人姓名（发送时快照）',
  `receiverId`      BIGINT UNSIGNED NOT NULL                    COMMENT '收件人员工ID（empinfos.id）',
  `receiverName`    VARCHAR(50)     NOT NULL DEFAULT ''         COMMENT '收件人姓名（发送时快照）',
  `title`           VARCHAR(200)    NOT NULL DEFAULT ''         COMMENT '消息标题',
  `content`         MEDIUMTEXT                                  COMMENT '消息正文',
  `sendTime`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发送时间',
  `readStatus`      TINYINT(1)      NOT NULL DEFAULT 0          COMMENT '收件人是否已读：0-未读，1-已读',
  `senderDeleted`   TINYINT(1)      NOT NULL DEFAULT 0          COMMENT '发件人软删除：1-已删（「已发送」不可见）',
  `receiverDeleted` TINYINT(1)      NOT NULL DEFAULT 0          COMMENT '收件人软删除：1-已删（「收件箱」不可见）',
  `createTime`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (`id`),
  KEY `idx_emp_msgs_inbox`  (`receiverId`, `receiverDeleted`, `sendTime`),
  KEY `idx_emp_msgs_sent`   (`senderId`, `senderDeleted`, `sendTime`),
  KEY `idx_emp_msgs_read`   (`receiverId`, `receiverDeleted`, `readStatus`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '站内消息（员工间互发，按 empId 强隔离：收件箱=receiverId=我且未删，已发送=senderId=我且未删）';

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------- 4. 结构回显（便于人工核对） ----------------------------
SHOW TABLES;

-- 项目组成员（成员来自员工信息，保存时自动通知）
CREATE TABLE IF NOT EXISTS `projectmembers` (
  `id`          CHAR(36)        NOT NULL                        COMMENT '主键（UUID）',
  `projectId`   CHAR(36)        NOT NULL                        COMMENT '项目ID（projectinfos.id）',
  `empId`       BIGINT UNSIGNED NOT NULL                        COMMENT '员工ID（empinfos.id）',
  `empName`     VARCHAR(50)     DEFAULT NULL                    COMMENT '员工姓名快照',
  `deptId`      BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '部门ID快照（OrganizationStructure.id）',
  `deptName`    VARCHAR(100)    DEFAULT NULL                    COMMENT '部门名称快照',
  `jobTitle`    VARCHAR(50)     DEFAULT NULL                    COMMENT '岗位快照',
  `email`       VARCHAR(100)    DEFAULT NULL                    COMMENT '邮箱快照（空 = 不发送邮件）',
  `noticeMsg`   TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '是否已推送站内消息：1-是',
  `noticeMail`  TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '是否已发送邮件：1-是',
  `noticeTime`  DATETIME        DEFAULT NULL                    COMMENT '最近一次通知时间',
  `createTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '加入时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_projectmembers_project_emp` (`projectId`, `empId`),
  KEY `idx_projectmembers_emp` (`empId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='项目组成员（成员来自员工信息，保存时自动通知）';



-- projectplans
CREATE TABLE IF NOT EXISTS `projectplans` (
  `id`               CHAR(36)        NOT NULL                        COMMENT '计划ID（UUID 主键）',
  `projectId`        CHAR(36)        NOT NULL                        COMMENT '所属项目（projectinfos.id）',
  `parentId`         CHAR(36)        DEFAULT NULL                    COMMENT '上级事项ID（任务挂事项；空=顶级）',
  `planCode`         VARCHAR(30)     NOT NULL                        COMMENT '计划编号（PLN + 6 位流水号，唯一）',
  `planName`         VARCHAR(150)    NOT NULL                        COMMENT '计划事项 / 任务名称',
  `planType`         VARCHAR(20)     NOT NULL DEFAULT '事项'          COMMENT '类型：事项 / 任务',
  `planDesc`         TEXT            DEFAULT NULL                    COMMENT '计划说明',
  `ownerId`          BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '责任人员工ID（empinfos.id）',
  `ownerName`        VARCHAR(50)     DEFAULT NULL                    COMMENT '责任人姓名快照',
  `ownerEmail`       VARCHAR(100)    DEFAULT NULL                    COMMENT '责任人邮箱快照（空=不发邮件）',
  `startDate`        DATE            DEFAULT NULL                    COMMENT '计划开始日期',
  `endDate`          DATE            DEFAULT NULL                    COMMENT '计划结束日期',
  `status`           VARCHAR(20)     NOT NULL DEFAULT '未开始'        COMMENT '状态：未开始 / 进行中 / 已完成 / 已暂停',
  `started`          TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '是否已启动执行：1-已生成工单',
  `startTime`        DATETIME        DEFAULT NULL                    COMMENT '启动执行时间',
  `noticeMsg`        TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '责任人是否已收到站内消息',
  `noticeMail`       TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '责任人是否已收到邮件',
  `noticeTime`       DATETIME        DEFAULT NULL                    COMMENT '最近一次通知时间',
  `createEname`      VARCHAR(100)    DEFAULT NULL                    COMMENT '创建人姓名',
  `createempinfosid` BIGINT UNSIGNED DEFAULT NULL                    COMMENT '创建人员工ID',
  `enabled`          TINYINT(1)      NOT NULL DEFAULT 1              COMMENT '启用否',
  `createTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_projectplans_code` (`planCode`),
  UNIQUE KEY `uk_projectplans_project_name` (`projectId`, `planName`),
  KEY `idx_projectplans_project` (`projectId`),
  KEY `idx_projectplans_owner` (`ownerId`),
  KEY `idx_projectplans_parent` (`parentId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='项目计划事项 / 任务（指定责任人时自动通知）';

-- projectworkorders
CREATE TABLE IF NOT EXISTS `projectworkorders` (
  `id`           CHAR(36)        NOT NULL                        COMMENT '工单ID（UUID 主键）',
  `planId`       CHAR(36)        NOT NULL                        COMMENT '来源计划（projectplans.id）',
  `projectId`    CHAR(36)        NOT NULL                        COMMENT '所属项目（projectinfos.id）',
  `orderCode`    VARCHAR(30)     NOT NULL                        COMMENT '工单编号（WO + 6 位流水号，唯一）',
  `orderTitle`   VARCHAR(200)    NOT NULL                        COMMENT '工单标题（取计划名称）',
  `orderDesc`    TEXT            DEFAULT NULL                    COMMENT '工单说明（取计划说明）',
  `ownerId`      BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '责任人员工ID',
  `ownerName`    VARCHAR(50)     DEFAULT NULL                    COMMENT '责任人姓名快照',
  `ownerEmail`   VARCHAR(100)    DEFAULT NULL                    COMMENT '责任人邮箱快照',
  `status`       VARCHAR(20)     NOT NULL DEFAULT '待处理'        COMMENT '状态：待处理 / 处理中 / 已完成',
  `dispatchTime` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '派送时间',
  `noticeMsg`    TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '派送时是否已发站内消息',
  `noticeMail`   TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '派送时是否已发邮件',
  `noticeTime`   DATETIME        DEFAULT NULL                    COMMENT '最近一次通知时间',
  `remark`       VARCHAR(200)    DEFAULT NULL                    COMMENT '备注（通知失败原因等）',
  `createTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workorders_code` (`orderCode`),
  UNIQUE KEY `uk_workorders_plan` (`planId`),
  KEY `idx_workorders_project` (`projectId`),
  KEY `idx_workorders_owner` (`ownerId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='项目工单（计划启动执行时自动派送）';

-- ---------------------------- 工作计划（Visio 风格） ----------------------------
-- 与 db/workplan.sql 同结构；全量建库时直接建出这两张表，业务数据不会被覆盖。
CREATE TABLE IF NOT EXISTS `workplans` (
  `id`               CHAR(36)        NOT NULL                        COMMENT '工作计划ID（UUID）',
  `planCode`         VARCHAR(30)     NOT NULL                        COMMENT '计划编号（WP + 6 位流水号，唯一）',
  `planName`         VARCHAR(150)    NOT NULL                        COMMENT '计划名称',
  `projectId`        CHAR(36)        DEFAULT NULL                    COMMENT '可选：关联项目（projectinfos.id）',
  `projectName`      VARCHAR(150)    DEFAULT NULL                    COMMENT '关联项目名称快照',
  `startDate`        DATE            DEFAULT NULL                    COMMENT '计划开始日期（甘特图时间刻度起点）',
  `endDate`          DATE            DEFAULT NULL                    COMMENT '计划结束日期（甘特图时间刻度终点）',
  `planDesc`         TEXT            DEFAULT NULL                    COMMENT '计划说明 / 目标',
  `scale`            VARCHAR(10)     NOT NULL DEFAULT 'day'          COMMENT '时间刻度：day 日 / week 周 / month 月',
  `skipWeekend`      TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '是否把周末标为非工作日',
  `ispub`            TINYINT(1)      NOT NULL DEFAULT 1              COMMENT '公用否',
  `enabled`          TINYINT(1)      NOT NULL DEFAULT 1              COMMENT '启用否',
  `status`           VARCHAR(20)     NOT NULL DEFAULT '未启动'        COMMENT '启动状态：未启动 / 已启动',
  `startTime`        DATETIME        DEFAULT NULL                    COMMENT '最近一次启动时间',
  `startEname`       VARCHAR(100)    DEFAULT NULL                    COMMENT '启动人姓名',
  `startempinfosid`  BIGINT UNSIGNED DEFAULT NULL                    COMMENT '启动人员工ID',
  `createEname`      VARCHAR(100)    DEFAULT NULL                    COMMENT '创建人姓名',
  `createempinfosid` BIGINT UNSIGNED DEFAULT NULL                    COMMENT '创建人员工ID',
  `createTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workplans_code` (`planCode`),
  KEY `idx_workplans_project` (`projectId`),
  KEY `idx_workplans_owner` (`createempinfosid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作计划（Visio 风格甘特图 / 时间线）';

CREATE TABLE IF NOT EXISTS `workplantasks` (
  `id`           CHAR(36)     NOT NULL                        COMMENT '任务ID（UUID）',
  `planId`       CHAR(36)     NOT NULL                        COMMENT '所属工作计划（workplans.id）',
  `taskName`     VARCHAR(200) NOT NULL                       COMMENT '任务 / 里程碑 / 摘要名称',
  `taskType`     VARCHAR(20)  NOT NULL DEFAULT 'task'        COMMENT 'task 任务 / milestone 里程碑 / summary 摘要任务',
  `orderKind`    VARCHAR(20)  NOT NULL DEFAULT 'plan'        COMMENT '派单来源：plan / bug-dev / bug-test / bug-accept',
  `parentId`     CHAR(36)     DEFAULT NULL                   COMMENT '上级摘要任务（Visio 缩进）',
  `startDate`    DATE         DEFAULT NULL                   COMMENT '开始日期',
  `endDate`      DATE         DEFAULT NULL                   COMMENT '结束日期（里程碑 = 开始日期）',
  `progress`     INT          NOT NULL DEFAULT 0             COMMENT '完成百分比 0~100',
  `execStatus`   VARCHAR(20)  NOT NULL DEFAULT '未开始'      COMMENT '任务完成状态：未开始 / 进行中 / 已完成 / 已延期 / 已取消',
  `actualStartDate` DATE      DEFAULT NULL                   COMMENT '实际开始时间（执行记录）',
  `actualEndDate`   DATE      DEFAULT NULL                   COMMENT '实际结束时间（执行记录）',
  `execRemark`   VARCHAR(1000) DEFAULT NULL                 COMMENT '执行说明 / 完成记录',
  `preTaskIds`   TEXT         DEFAULT NULL                   COMMENT '前置任务ID，逗号分隔',
  `ownerName`    VARCHAR(50)  DEFAULT NULL                   COMMENT '责任人姓名快照（从员工信息选取）',
  `ownerId`      BIGINT UNSIGNED NOT NULL DEFAULT 0         COMMENT '责任人（empinfos.id，0=未指定）',
  `participantIds`   TEXT       DEFAULT NULL                 COMMENT '参与人员ID（empinfos.id，逗号分隔）',
  `participantNames` TEXT       DEFAULT NULL                 COMMENT '参与人员姓名快照（逗号分隔）',
  `sortNo`       INT          NOT NULL DEFAULT 0             COMMENT '排序号（画布行顺序）',
  `color`        VARCHAR(20)  DEFAULT NULL                   COMMENT '任务条自定义颜色',
  `createTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_workplantasks_plan` (`planId`),
  KEY `idx_workplantasks_parent` (`parentId`),
  KEY `idx_workplantasks_owner` (`ownerId`),
  KEY `idx_workplantasks_exec` (`execStatus`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作计划任务（任务 / 里程碑 / 摘要 + 依赖 + 完成百分比 + 执行记录）';

-- 工作计划任务工单：启动后一任务一单，按 taskId 关联 workplantasks，责任人与参与人都进「我的任务」列表
CREATE TABLE IF NOT EXISTS `workplanorders` (
  `id`               CHAR(36)        NOT NULL                     COMMENT '工单ID（UUID）',
  `taskId`           CHAR(36)        NOT NULL                     COMMENT '来源任务（workplantasks.id，一任务一单）',
  `planId`           CHAR(36)        NOT NULL                     COMMENT '所属工作计划（workplans.id）',
  `projectId`        CHAR(36)        DEFAULT NULL                 COMMENT '关联项目（可空）',
  `planCode`         VARCHAR(30)     DEFAULT NULL                 COMMENT '计划编号快照（WP + 6 位）',
  `planName`         VARCHAR(150)    DEFAULT NULL                 COMMENT '计划名称快照',
  `orderCode`        VARCHAR(30)     NOT NULL                     COMMENT '工单编号（WO + 6 位，跨两张工单表全局唯一）',
  `orderTitle`       VARCHAR(200)    NOT NULL                     COMMENT '工单标题（取任务名称）',
  `taskType`         VARCHAR(20)     NOT NULL DEFAULT 'task'      COMMENT 'task / milestone / summary',
  `orderKind`        VARCHAR(20)     NOT NULL DEFAULT 'plan'      COMMENT '来源：plan 计划任务 / bug-dev 缺陷研发 / bug-test 缺陷测试 / bug-accept 缺陷验收',
  `startDate`        DATE            DEFAULT NULL                 COMMENT '任务计划开始日期',
  `endDate`          DATE            DEFAULT NULL                 COMMENT '任务计划结束日期',
  `ownerId`          BIGINT UNSIGNED NOT NULL DEFAULT 0          COMMENT '责任人员工ID',
  `ownerName`        VARCHAR(50)     DEFAULT NULL                 COMMENT '责任人姓名快照',
  `ownerEmail`       VARCHAR(100)    DEFAULT NULL                 COMMENT '责任人邮箱快照',
  `participantIds`   TEXT            DEFAULT NULL                 COMMENT '参与人员ID（逗号分隔，进入其任务列表）',
  `participantNames` TEXT            DEFAULT NULL                 COMMENT '参与人员姓名快照（逗号分隔）',
  `status`           VARCHAR(20)     NOT NULL DEFAULT '待处理'     COMMENT '工单状态：待处理 / 处理中 / 已完成',
  `dispatchTime`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '派送时间',
  `noticeMsg`        TINYINT(1)      NOT NULL DEFAULT 0          COMMENT '是否已发站内即时消息',
  `noticeMail`       TINYINT(1)      NOT NULL DEFAULT 0          COMMENT '是否已发通知邮件',
  `noticeTime`       DATETIME        DEFAULT NULL                 COMMENT '最近一次通知时间',
  `remark`           VARCHAR(500)    DEFAULT NULL                 COMMENT '备注（通知失败原因等）',
  `createTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_wporders_code` (`orderCode`),
  UNIQUE KEY `uk_wporders_task` (`taskId`),
  KEY `idx_wporders_plan` (`planId`),
  KEY `idx_wporders_owner` (`ownerId`),
  KEY `idx_wporders_dispatch` (`dispatchTime`),
  KEY `idx_wporders_kind` (`orderKind`),
  KEY `idx_wporders_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作计划任务工单（启动后一任务一单，按 taskId 关联 workplantasks）';

-- ---------------------------- 3.xx 邮件附件元数据 mailattach（2026-11-10） ----------------------------
-- 服务信箱（mail）与我的邮箱（empmail）共用；二进制内容落盘在 data/mailattach/ 下，
-- 表里只存元信息。收件 / 发件自动登记，历史收件可在读信区按 IMAP UID 补拉。
CREATE TABLE IF NOT EXISTS `mailattach` (
  `id`            CHAR(36)        NOT NULL                        COMMENT '附件ID（UUID，下载接口按它取）',
  `source`        VARCHAR(16)     NOT NULL                        COMMENT '来源：mail-服务信箱 / empmail-我的邮箱',
  `mailId`        CHAR(36)        NOT NULL                        COMMENT '所属邮件ID',
  `empId`         BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '归属员工（empmail 强隔离用；mail 恒为 0）',
  `sortNo`        INT             NOT NULL DEFAULT 0              COMMENT '同一封邮件内的附件序号（从 0 起）',
  `name`          VARCHAR(255)    NOT NULL                        COMMENT '附件文件名（MIME 头解码后）',
  `size`          BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '字节数',
  `contentType`   VARCHAR(150)    DEFAULT NULL                    COMMENT 'MIME 类型',
  `filePath`      VARCHAR(500)    DEFAULT NULL                    COMMENT '相对 WEB_ROOT 的文件路径；NULL=内容未保存',
  `downloadable`  TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '1-可下载，0-只记名字',
  `createTime`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '登记时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_mailattach_item` (`source`,`mailId`,`sortNo`),
  KEY `idx_mailattach_mail` (`source`,`mailId`),
  KEY `idx_mailattach_emp`  (`source`,`empId`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '邮件附件元数据（内容落盘；服务信箱与我的邮箱共用）';

-- ---------------------------- 3.yy 缺陷 / 问题管理（2026-11-18） ----------------------------
-- 客户现场实施问题：登记 → 接收人评估（时间线）→ 确认缺陷自动生成修复工单。
-- 工单复用 workplanorders（orderKind 区分 bug-dev / bug-test / bug-accept），不另建工单表。
CREATE TABLE IF NOT EXISTS `buginfos` (
  `id`               CHAR(36)        NOT NULL                     COMMENT '缺陷ID（UUID）',
  `bugCode`          VARCHAR(20)     NOT NULL                     COMMENT '缺陷编号（BUG + 6 位流水号，唯一）',
  `title`            VARCHAR(200)    NOT NULL                     COMMENT '问题标题（一句话现象）',
  `description`      MEDIUMTEXT      NULL                         COMMENT '问题描述（纯文本）',
  `descriptionHtml`  MEDIUMTEXT      NULL                         COMMENT '问题描述富文本 HTML',
  `projectId`        CHAR(36)        DEFAULT NULL                 COMMENT '所在项目（projectinfos.id）',
  `projectName`      VARCHAR(150)    DEFAULT NULL                 COMMENT '项目名称快照',
  `happenTime`       DATETIME        DEFAULT NULL                 COMMENT '发生时间',
  `level`            VARCHAR(10)     DEFAULT NULL                 COMMENT '严重级别：P0 / P1 / P2 / P3',
  `sourceType`       VARCHAR(20)     NOT NULL DEFAULT '客户现场'  COMMENT '客户现场 / 内部测试 / 用户反馈 / 运维巡检',
  `status`           VARCHAR(20)     NOT NULL DEFAULT '待评估'    COMMENT '待评估 / 已确认 / 非缺陷 / 已转工单 / 已修复 / 已关闭',
  `reporterId`       BIGINT UNSIGNED NOT NULL DEFAULT 0           COMMENT '创建人员工ID',
  `reporterName`     VARCHAR(100)    DEFAULT NULL                 COMMENT '创建人姓名',
  `receiverId`       BIGINT UNSIGNED NOT NULL DEFAULT 0           COMMENT '接收人员工ID',
  `receiverName`     VARCHAR(100)    DEFAULT NULL                 COMMENT '接收人姓名',
  `devOwnerId`       BIGINT UNSIGNED DEFAULT NULL                 COMMENT '研发责任人员工ID',
  `devOwnerName`     VARCHAR(50)     DEFAULT NULL                 COMMENT '研发责任人姓名',
  `devStartDate`     DATE            DEFAULT NULL                 COMMENT '研发开始日期',
  `devEndDate`       DATE            DEFAULT NULL                 COMMENT '研发结束日期',
  `testOwnerId`      BIGINT UNSIGNED DEFAULT NULL                 COMMENT '测试责任人员工ID',
  `testOwnerName`    VARCHAR(50)     DEFAULT NULL                 COMMENT '测试责任人姓名',
  `testStartDate`    DATE            DEFAULT NULL                 COMMENT '测试开始日期',
  `testEndDate`      DATE            DEFAULT NULL                 COMMENT '测试结束日期',
  `acceptOwnerId`    BIGINT UNSIGNED DEFAULT NULL                 COMMENT '验收责任人员工ID（默认创建人）',
  `acceptOwnerName`  VARCHAR(50)     DEFAULT NULL                 COMMENT '验收责任人姓名',
  `acceptStartDate`  DATE            DEFAULT NULL                 COMMENT '验收开始日期',
  `acceptEndDate`    DATE            DEFAULT NULL                 COMMENT '验收结束日期',
  `planId`           CHAR(36)        DEFAULT NULL                 COMMENT '生成的修复计划（workplans.id）',
  `evalCount`        INT             NOT NULL DEFAULT 0           COMMENT '评估记录条数',
  `closeReason`      VARCHAR(500)    DEFAULT NULL                 COMMENT '关闭 / 非缺陷原因',
  `createTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_buginfos_code` (`bugCode`),
  UNIQUE KEY `uk_buginfos_plan` (`planId`),
  KEY `idx_buginfos_status` (`status`),
  KEY `idx_buginfos_receiver` (`receiverId`),
  KEY `idx_buginfos_reporter` (`reporterId`),
  KEY `idx_buginfos_project` (`projectId`),
  KEY `idx_buginfos_happen` (`happenTime`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='缺陷 / 问题单（客户现场实施问题登记与评估）';

CREATE TABLE IF NOT EXISTS `bugevaluations` (
  `id`             CHAR(36)        NOT NULL                  COMMENT '评估记录ID',
  `bugId`          CHAR(36)        NOT NULL                  COMMENT '缺陷ID（buginfos.id）',
  `seq`            INT             NOT NULL DEFAULT 0        COMMENT '评估序号（1 起；同一秒多次评估也能稳定排序）',
  `result`         VARCHAR(20)     NOT NULL                  COMMENT '是缺陷 / 非缺陷 / 需补充信息',
  `level`          VARCHAR(10)     DEFAULT NULL              COMMENT '本次定级',
  `reason`         TEXT            NULL                      COMMENT '评估意见 / 原因',
  `reasonHtml`     MEDIUMTEXT      NULL                      COMMENT '评估意见富文本 HTML',
  `evaluatorId`    BIGINT UNSIGNED DEFAULT NULL              COMMENT '操作人员工ID',
  `evaluatorName`  VARCHAR(100)    DEFAULT NULL              COMMENT '操作人姓名',
  `evaluatorIds`   TEXT            NULL                      COMMENT '参与评估人员ID（逗号分隔）',
  `evaluatorNames` VARCHAR(500)    NULL                      COMMENT '参与评估人员姓名（逗号分隔）',
  `createTime`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_bugeval_bug` (`bugId`),
  KEY `idx_bugeval_time` (`createTime`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='缺陷评估记录单（时间线，按条追加）';

CREATE TABLE IF NOT EXISTS `bugfiles` (
  `id`           CHAR(36)        NOT NULL                  COMMENT '附件ID',
  `bugId`        CHAR(36)        NOT NULL                  COMMENT '缺陷ID（buginfos.id）',
  `name`         VARCHAR(255)    NOT NULL                  COMMENT '文件名',
  `path`         VARCHAR(500)    NOT NULL                  COMMENT '存储相对路径（<bugId>/<uuid>.<ext>）',
  `size`         BIGINT          NOT NULL DEFAULT 0        COMMENT '字节数',
  `ext`          VARCHAR(20)     DEFAULT NULL              COMMENT '扩展名',
  `uploaderId`   BIGINT UNSIGNED DEFAULT NULL              COMMENT '上传人员工ID',
  `uploaderName` VARCHAR(100)    DEFAULT NULL              COMMENT '上传人姓名',
  `uploadTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_bugfiles_bug` (`bugId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='缺陷附件（登记 / 编辑时上传，内容落盘）';
