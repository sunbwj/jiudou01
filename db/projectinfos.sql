-- =====================================================================
-- 项目管理：项目信息表（projectinfos）
-- ---------------------------------------------------------------------
-- 用途：
--   · 维护项目台账（项目类型 / 自动编号 / 名称 / 说明 / 状态 / 公用否 / 启用否等），
--     项目文件表 projectfiles 以 projectId 关联到本表；
--   · 项目编号由后端自动生成：PRO + 6 位流水号（PRO000001，最大 PRO999999），
--     扫描库中已有编号取最大流水 +1，并发占位时自动顺延；
--   · 「各类检索结果只能是当前用户创建或其他用户标为公用的」：
--     列表 / 详情 / 下拉统一按 (createempinfosid = 当前登录员工 OR ispub = 1) 过滤，
--     创建人由后端按登录 token 反查 useinfo.empId 自动写入，页面不展示、前端不用传；
--   · enabled 只表示「这条项目可用」，允许多条同时启用；停用的项目不出现在项目下拉里。
-- 约定：
--   · 主键 UUID（CHAR(36)），项目编号唯一、项目名称唯一；
--   · ispub 公用否：1-公用（默认）/ 0-私有；私有项目只有创建人自己能检索到。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < projectinfos.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `projectinfos` (
  `id`               CHAR(36)      NOT NULL                        COMMENT '项目ID（UUID 主键，非自增）',
  `projectCode`      VARCHAR(30)   NOT NULL                        COMMENT '项目编号（唯一，自动生成：PRO + 6 位流水号）',
  `projectType`      VARCHAR(30)   NOT NULL DEFAULT '其它'          COMMENT '项目类型：研发/实施/测试/设计/产品/需求/数据分析/科研/其它',
  `projectName`      VARCHAR(150)  NOT NULL                        COMMENT '项目名称（唯一）',
  `projectDesc`      MEDIUMTEXT    DEFAULT NULL                    COMMENT '项目说明（富文本 HTML，支持文本格式与 Word 导入）',
  `projectStatus`    VARCHAR(30)   NOT NULL DEFAULT '未开始'        COMMENT '项目状态：未开始/进行中/已暂停/已完成/已归档',
  `ispub`            TINYINT(1)    NOT NULL DEFAULT 1              COMMENT '公用否：1-公用（其他用户可检索），0-私有（仅创建人可检索）',
  `createEname`      VARCHAR(100)  DEFAULT NULL                    COMMENT '创建人姓名（后端按登录用户自动带入）',
  `createempinfosid` BIGINT UNSIGNED DEFAULT NULL                  COMMENT '创建人员工ID（empinfos.id，后端按登录用户自动带入）',
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

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `projectinfos`;
