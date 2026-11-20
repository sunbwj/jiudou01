-- =====================================================================
-- 系统配置：系统字典表（sysdict）
-- ---------------------------------------------------------------------
-- 用途：
--   · 维护系统字典的「键」：键中文名 / 键英文名（唯一，供程序按 key 读取字典）；
--   · parentId 为本表 id（UUID），支持字典分组 / 多级层级；NULL 或空串表示顶级；
--   · sortNo 显示序号（升序），remark 说明，enabled 启用否；
--   · 字典的「值」放在 sysdictitems，一条字典下可挂多条键值明细；
--   · 删除字典时后端会级联清理 sysdictitems 里的键值明细，
--     并把子字典的 parentId 置空（避免留下指向已删字典的孤儿上级）。
-- 约定：
--   · 主键 UUID（CHAR(36)）；键英文名唯一（uk_sysdict_nameen）；
--   · 系统字典 / 字典明细 / 系统参数都是全局配置，不做「本人创建 OR 公用」的可见性过滤，
--     所有已登录用户都能检索（与项目 / 连接 / 报表的业务数据可见性规则不同）。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < sysdict.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `sysdict` (
  `id`           CHAR(36)      NOT NULL                          COMMENT '字典ID（UUID 主键，非自增）',
  `dictNameCn`   VARCHAR(150)  NOT NULL                          COMMENT '键中文名（如：用户性别）',
  `dictNameEn`   VARCHAR(100)  NOT NULL                          COMMENT '键英文名（唯一，如：gender，供程序按 key 取字典）',
  `parentId`     CHAR(36)      DEFAULT NULL                      COMMENT '上级ID（sysdict.id；NULL/空=顶级，支持字典分组）',
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

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `sysdict`;
