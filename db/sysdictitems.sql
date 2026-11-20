-- =====================================================================
-- 系统配置：系统字典明细表（sysdictitems）
-- ---------------------------------------------------------------------
-- 用途：
--   · 维护每个系统字典下的「键值」：itemKey（键 / 编码，选填）+ itemValue（键值，必填）；
--     例如字典 gender 下的 1→男、2→女，或纯枚举列表 男 / 女 / 未知；
--   · dictId 关联 sysdict.id（UUID）；列表 / 详情 / 保存时按 dictId 过滤与校验；
--   · sortNo 显示序号（升序），remark 说明，enabled 启用否；
--   · 删除所属字典时后端级联删除本表的键值明细（页面展示的明细数也随之为 0）。
-- 约定：
--   · 主键 UUID（CHAR(36)）；同一字典下 itemKey 唯一（uk_sysdictitems_key），
--     itemKey 为空（NULL）时允许有多条（MySQL 唯一索引允许多个 NULL），适合纯枚举字典；
--   · 不存所属字典名称快照，列表展示的字典名由后端按 dictId 关联查询，
--     字典改名后明细列表自动跟着变，不会出现快照不一致。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < sysdictitems.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `sysdictitems` (
  `id`          CHAR(36)      NOT NULL                          COMMENT '明细ID（UUID 主键，非自增）',
  `dictId`      CHAR(36)      NOT NULL                          COMMENT '系统字典表ID（sysdict.id）',
  `itemKey`     VARCHAR(150)  DEFAULT NULL                      COMMENT '键（编码 / 选项值，选填；同字典下唯一）',
  `itemValue`   VARCHAR(300)  NOT NULL                          COMMENT '键值（显示值 / 枚举值，如：男、女、进行中）',
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
  COMMENT = '系统字典明细表（挂在各字典下的键值，含键编码 / 显示序号 / 说明 / 启用否）';

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `sysdictitems`;
