-- =====================================================================
-- 数据中心：数据库连接对象信息（dbinfomgr）
-- ---------------------------------------------------------------------
-- 用途：
--   · 1.1 统一维护各主流数据库的连接信息（连接名称 / 类型 / 主机 / 端口 / 默认库 /
--         账号 / 密码 / 字符集 / 连接参数 / 启用否 / 备注）；
--   · 1.2 双击连接对象后按这些信息连库，扫描「实例（库）→ 表 / 视图 → 字段」。
-- 约定：
--   · 主键 UUID（CHAR(36)），连接名称唯一；
--   · 密码加密存储（`enc:v1:` 前缀，密钥取 config.DBINFO_SECRET），接口只回掩码；
--   · dbType 支持 mysql / mariadb / postgresql / oracle / sqlserver / sqlite（sqlite 用文件路径）；
--   · 允许多条启用（不像服务信箱那样只能启用一条）：enabled 只表示「这条连接可用 / 参与扫描」；
--   · ispub 公用否：1-公用（默认，新增弹窗里可选「私有」），0-私有；
--   · createempinfosid 由后端按登录用户自动写入，页面不展示。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < dbinfomgr.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `dbinfomgr` (
  `id`           CHAR(36)     NOT NULL                          COMMENT '连接ID（UUID 主键，非自增）',
  `name`         VARCHAR(100) NOT NULL                          COMMENT '连接名称（唯一，列表与结构树里展示）',
  `dbType`       VARCHAR(30)  NOT NULL DEFAULT 'mysql'          COMMENT '数据库类型：mysql/mariadb/postgresql/oracle/sqlserver/sqlite',
  `host`         VARCHAR(120) DEFAULT NULL                      COMMENT '主机地址（SQLite 留空，路径写在 dbName）',
  `port`         INT(11)      DEFAULT NULL                      COMMENT '端口（留空按类型默认：3306/5432/1521/1433）',
  `dbName`       VARCHAR(120) DEFAULT NULL                      COMMENT '默认库 / 服务名 / SID / SQLite 库文件路径',
  `username`     VARCHAR(100) DEFAULT NULL                      COMMENT '登录账号',
  `password`     VARCHAR(255) DEFAULT NULL                      COMMENT '登录密码（加密存储，接口不返回明文）',
  `charset`      VARCHAR(40)  DEFAULT NULL                      COMMENT '字符集（如 utf8mb4 / AL32UTF8）',
  `extraParams`  VARCHAR(500) DEFAULT NULL                      COMMENT '附加连接参数（key=value&key=value）',
  `enabled`      TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用否：1-启用，0-停用',
  `lastScanTime` DATETIME     DEFAULT NULL                      COMMENT '最近一次扫描成功时间',
  `lastError`    VARCHAR(500) DEFAULT NULL                      COMMENT '最近一次扫描失败原因',
  `remark`       VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createempinfosid` BIGINT UNSIGNED DEFAULT NULL               COMMENT '创建人员工ID（empinfos.id，后端按登录用户自动带入）',
  `ispub`        TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '公用否：1-公用（默认），0-私有',
  `createTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dbinfomgr_name`    (`name`),
  KEY `idx_dbinfomgr_type`          (`dbType`),
  KEY `idx_dbinfomgr_enabled`       (`enabled`),
  KEY `idx_dbinfomgr_creator`       (`createempinfosid`),
  KEY `idx_dbinfomgr_pub`           (`ispub`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '数据库连接对象信息（数据中心，供结构扫描使用）';

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `dbinfomgr`;
