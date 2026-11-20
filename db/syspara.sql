-- =====================================================================
-- 系统配置：系统参数表（syspara）
-- ---------------------------------------------------------------------
-- 用途：
--   · 维护系统级参数：参数中文名 / 参数英文名（唯一，供程序按 key 读取）/ 参数值 /
--     显示序号 / 说明 / 启用否；例如 site_name、token_expire_hours、page_size 等；
--   · sortNo 显示序号（升序），remark 说明，enabled 启用否（停用的参数不参与业务读取）。
-- 约定：
--   · 主键 UUID（CHAR(36)）；参数英文名唯一（uk_syspara_nameen）；
--   · paraValue 用 VARCHAR(1000) 存文本值，多行配置可用换行符或 JSON 文本；
--   · 全局配置表，不做「本人创建 OR 公用」的可见性过滤，所有已登录用户都能检索。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < syspara.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `syspara` (
  `id`          CHAR(36)      NOT NULL                          COMMENT '参数ID（UUID 主键，非自增）',
  `paraNameCn`  VARCHAR(150)  NOT NULL                          COMMENT '参数中文名（如：系统名称）',
  `paraNameEn`  VARCHAR(100)  NOT NULL                          COMMENT '参数英文名（唯一，如：site_name，供程序按 key 取值）',
  `paraValue`   VARCHAR(1000) DEFAULT NULL                      COMMENT '参数值（文本 / 数字 / JSON 文本，最多 1000 字）',
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

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `syspara`;
