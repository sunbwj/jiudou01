-- =====================================================================
-- 项目管理：项目文件信息表（projectfiles）
-- ---------------------------------------------------------------------
-- 用途：
--   · 保存挂在项目（projectinfos）下的文件：文件类型 / 文件名 / 文件路径 / 文件说明 /
--     公用否 / 上传人 / 上传时间 / 启用否；
--   · 文件实体由后端写到静态根目录下的 data/projectfiles/<YYYYMM>/<UUID>.<扩展名>，
--     filePath 存的是相对路径（如 data/projectfiles/202611/<uuid>.pdf），
--     由 Flask 的同源静态路由直接提供下载，不需要额外的文件流接口；
--   · projectName / projectCode 是所属项目的名称快照：项目改名后文件列表仍可直接展示，
--     同时保留 projectId 用于关联跳转；项目被删除时一并清理本表记录与磁盘文件；
--   · 「各类检索结果只能是当前用户创建或其他用户标为公用的」：
--     列表 / 详情 / 下载统一按 (uploadempinfosid = 当前登录员工 OR ispub = 1) 过滤，
--     上传人由后端按登录 token 反查 useinfo.empId 自动写入，页面不展示、前端不用传；
--   · 可选 fileSize 记录字节数（列表展示用），fileDesc 是文件说明。
-- 约定：
--   · 主键 UUID（CHAR(36)）；同一项目下文件名允许重复（靠 id 区分，不建唯一索引）；
--   · ispub 公用否：1-公用（默认）/ 0-私有；私有文件只有上传人自己能检索到。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < projectfiles.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `projectfiles` (
  `id`                CHAR(36)      NOT NULL                       COMMENT '文件ID（UUID 主键，非自增）',
  `projectId`         CHAR(36)      NOT NULL                       COMMENT '项目信息表ID（projectinfos.id）',
  `dirId`             CHAR(36)      DEFAULT NULL                   COMMENT '所属目录ID（projectdirs.id；空=直接关联项目，见 db/projectdirs.sql）',
  `projectCode`       VARCHAR(30)   DEFAULT NULL                   COMMENT '项目编号快照',
  `projectName`       VARCHAR(150)  DEFAULT NULL                   COMMENT '项目名称快照',
  `fileType`          VARCHAR(30)   NOT NULL DEFAULT '其它'         COMMENT '文件类型：文档/表格/图片/压缩包/代码/设计稿/其它',
  `fileName`          VARCHAR(255)  NOT NULL                       COMMENT '文件名（含扩展名）',
  `filePath`          VARCHAR(500)  NOT NULL                       COMMENT '文件路径（相对静态根，data/projectfiles/<YYYYMM>/<uuid>.<ext>）',
  `fileSize`          BIGINT UNSIGNED NOT NULL DEFAULT 0           COMMENT '文件大小（字节）',
  `fileDesc`          VARCHAR(500)  DEFAULT NULL                   COMMENT '文件说明',
  `ispub`             TINYINT(1)    NOT NULL DEFAULT 1             COMMENT '公用否：1-公用（其他用户可检索/下载），0-私有（仅上传人可检索/下载）',
  `uploadEname`       VARCHAR(100)  DEFAULT NULL                   COMMENT '上传人姓名（后端按登录用户自动带入）',
  `uploadempinfosid`  BIGINT UNSIGNED DEFAULT NULL                 COMMENT '上传人员工ID（empinfos.id，后端按登录用户自动带入）',
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

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `projectfiles`;
