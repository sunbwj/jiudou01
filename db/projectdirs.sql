-- =====================================================================
-- 项目管理：项目目录表（projectdirs）+ 项目文件表新增 dirId 归属列
-- ---------------------------------------------------------------------
-- 用途：
--   · 目录挂在项目（projectinfos）下，parentId 自关联形成任意层级树；
--     parentId 为空表示项目根目录下的第一级目录；
--   · 项目文件（projectfiles）通过 dirId 关联目录：dirId 为空表示
--     「不选择目录，文件直接与项目关联」（上传时留空即可）；
--   · 目录同样遵守「本人创建 OR 公用」的可见性规则（与项目信息 / 项目文件一致）；
--   · 删除目录不删数据：子目录升到被删目录的父级，文件 dirId 置空回到项目根
--     （具体实现见 server/service.py 的 ProjectDirService.delete）。
-- 约定：
--   · 主键 UUID（CHAR(36)），由后端 uuid4 生成；
--   · 同一项目、同一上级下目录名不允许重复（由后端校验，parentId 可为 NULL，
--     故不依赖数据库唯一索引）；
--   · ispub 公用否：1-公用（默认）/ 0-私有；enabled 启用否：1-启用（默认）；
--   · 同一项目内禁止把目录挂到自身或自己的后代下（防环，后端校验）。
--
-- 【可重复执行 / 非破坏性】
--   · CREATE TABLE IF NOT EXISTS 不改动已有表结构与数据；
--   · MySQL 5.7 无 ADD COLUMN IF NOT EXISTS，用 information_schema 判断后
--     以 PREPARE 动态执行 ALTER，列已存在时只跑一条 SELECT 1（空操作）；
--   · 全程不 UPDATE / DELETE 任何业务数据，不覆盖页面里人工维护的启停状态。
--
-- 执行：mysql -usa -p --default-character-set=utf8mb4 rogerorm < db/projectdirs.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `projectdirs` (
  `id`                CHAR(36)      NOT NULL                        COMMENT '目录ID（UUID 主键，非自增）',
  `projectId`         CHAR(36)      NOT NULL                        COMMENT '项目信息表ID（projectinfos.id）',
  `parentId`          CHAR(36)      DEFAULT NULL                    COMMENT '上级目录ID（projectdirs.id，空=项目根目录）',
  `dirName`           VARCHAR(150)  NOT NULL                        COMMENT '目录名',
  `dirDesc`           VARCHAR(500)  DEFAULT NULL                    COMMENT '说明',
  `ispub`             TINYINT(1)    NOT NULL DEFAULT 1              COMMENT '公开否：1-公用（其他用户可检索），0-私有（仅创建人可检索）',
  `createEname`       VARCHAR(100)  DEFAULT NULL                    COMMENT '创建人姓名（后端按登录用户自动带入）',
  `createempinfosid`  BIGINT UNSIGNED DEFAULT NULL                  COMMENT '创建人员工ID（empinfos.id，后端按登录用户自动带入）',
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

-- 项目文件表补 dirId 列 + 索引（幂等：列已存在时不做任何变更）
SET @pj_db = DATABASE();
SET @pj_sql = (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @pj_db AND TABLE_NAME = 'projectfiles' AND COLUMN_NAME = 'dirId') > 0,
    'SELECT 1',
    'ALTER TABLE `projectfiles` ADD COLUMN `dirId` CHAR(36) DEFAULT NULL COMMENT ''所属目录ID（projectdirs.id，空=直接关联项目）'' AFTER `projectId`, ADD KEY `idx_projectfiles_dir` (`dirId`)'
  )
);
PREPARE pj_stmt FROM @pj_sql;
EXECUTE pj_stmt;
DEALLOCATE PREPARE pj_stmt;

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `projectdirs`;
SHOW FULL COLUMNS FROM `projectfiles` LIKE 'dirId';
