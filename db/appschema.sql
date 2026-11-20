-- =====================================================================
-- 应用架构：应用信息 + 库 / 表 / 视图 / 存储过程 / 字段 + 版本与变更脚本
-- ---------------------------------------------------------------------
-- 设计口径（与页面、后端 server/app_schema.py 一致）：
--   · 一个应用对应**一个**数据库连接对象（dbinfomgr）：appinfos.dbConnId 唯一索引兜住；
--     允许为空 —— 没拿到账号的老系统 / 外包系统可以纯手工维护结构；
--   · appinfos.dbType 是「生成脚本用」的方言（mysql/postgresql/oracle/sqlserver/sqlite），
--     手工应用自己选，扫描应用首次绑定时从连接对象带入，之后扫描发现不一致会告警；
--   · 结构树（库 → 表 / 视图 / 存储过程 → 字段）**只读本地表**，扫描只是「同步器」；
--     手工录入与扫描写的是同一套表，靠 source（scan/manual/import）+ locked 区分来源；
--   · 每次保存生成一条**草稿版本**（appschemavers.kind='draft'，带整库快照 snapshot）；
--     点「发布」才生成正式版号 + 正向 / 回滚脚本（appschemascripts），脚本**永不自动执行**，
--     必须人工确认后执行，执行结果回写到脚本状态（pending/applied/failed/skipped）；
--   · 结构对比只由人工触发，结果落 appschemacompares / appschemacompareitems（含实库快照时间），
--     不做后台定时扫描；对比类型：same / designOnly / dbOnly / attrDiff / orderDiff；
--   · 删除一律**物理删除**（唯一索引才能正常工作）：历史在版本快照里，不靠软删；
--     扫描同步只删「source=scan 且未锁定」的对象，手工录入的不会被扫描冲掉。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < appschema.sql
--       本项目实际（客户端不在 PATH）：
--       cd /d/mysql/mysql_5_7_22_winx64/bin && ./mysql.exe -u sa -proger2019 \
--         --default-character-set=utf8mb4 rogerorm < appschema.sql
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- 1) 应用信息
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `appinfos` (
  `id`               CHAR(36)     NOT NULL                          COMMENT '应用ID（UUID 主键）',
  `code`             VARCHAR(40)  NOT NULL                          COMMENT '应用编码（APP + 4 位流水号，唯一）',
  `name`             VARCHAR(100) NOT NULL                          COMMENT '应用名称',
  `shortName`        VARCHAR(50)  DEFAULT NULL                      COMMENT '应用简称',
  `appType`          VARCHAR(30)  NOT NULL DEFAULT 'web'            COMMENT '应用类型：web/service/app/middleware/other',
  `dbType`           VARCHAR(30)  NOT NULL DEFAULT 'mysql'          COMMENT '数据库类型（生成脚本方言）：mysql/postgresql/oracle/sqlserver/sqlite',
  `env`              VARCHAR(20)  NOT NULL DEFAULT 'prod'           COMMENT '环境：dev/test/prod',
  `dbConnId`         CHAR(36)     DEFAULT NULL                      COMMENT '数据库连接对象（dbinfomgr.id，一个应用最多一个）',
  `deptId`           BIGINT       DEFAULT NULL                      COMMENT '归属部门（OrganizationStructure.id）',
  `ownerEmpId`       BIGINT       DEFAULT NULL                      COMMENT '负责人（empinfos.id）',
  `status`           TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '状态：1-在用，0-停用',
  `description`      VARCHAR(500) DEFAULT NULL                      COMMENT '应用说明',
  `lastScanTime`     DATETIME     DEFAULT NULL                      COMMENT '最近一次扫描导入成功时间',
  `lastError`        VARCHAR(500) DEFAULT NULL                      COMMENT '最近一次扫描失败原因',
  `ispub`            TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '公用否：1-公用（默认），0-私有',
  `createempinfosid` BIGINT       DEFAULT NULL                      COMMENT '创建人员工ID（后端按登录用户自动带入）',
  `createTime`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_appinfos_code` (`code`),
  UNIQUE KEY `uk_appinfos_conn` (`dbConnId`),
  KEY `idx_appinfos_name` (`name`),
  KEY `idx_appinfos_type` (`appType`),
  KEY `idx_appinfos_status` (`status`),
  KEY `idx_appinfos_creator` (`createempinfosid`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用信息（一个应用一个数据库连接对象）';

-- ---------------------------------------------------------------------
-- 2) 应用下的库（实例）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `appschemadbs` (
  `id`        CHAR(36)     NOT NULL DEFAULT ''                  COMMENT '库ID（UUID）',
  `appId`     CHAR(36)     NOT NULL                             COMMENT '所属应用（appinfos.id）',
  `dbName`    VARCHAR(120) NOT NULL                             COMMENT '库名 / 实例名（SQLite 为文件名）',
  `dbComment` VARCHAR(200) DEFAULT NULL                         COMMENT '库说明',
  `charset`   VARCHAR(40)  DEFAULT NULL                         COMMENT '字符集',
  `source`    VARCHAR(10)  NOT NULL DEFAULT 'manual'            COMMENT '来源：scan-扫描导入 / manual-手工录入 / import-DDL导入',
  `locked`    TINYINT(1)   NOT NULL DEFAULT 0                   COMMENT '锁定否：1-扫描不覆盖、不删除',
  `sortNo`    INT(11)      NOT NULL DEFAULT 0                   COMMENT '显示序号',
  `createTime` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP   COMMENT '创建时间',
  `updateTime` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_appschemadbs` (`appId`, `dbName`),
  KEY `idx_appschemadbs_app` (`appId`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用数据库（库 / 实例）';

-- ---------------------------------------------------------------------
-- 3) 库下的对象：表 / 视图 / 存储过程
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `appschemaobjs` (
  `id`         CHAR(36)     NOT NULL DEFAULT ''                 COMMENT '对象ID（UUID）',
  `dbId`       CHAR(36)     NOT NULL                            COMMENT '所属库（appschemadbs.id）',
  `objType`    VARCHAR(12)  NOT NULL DEFAULT 'table'            COMMENT '对象类型：table/view/procedure',
  `objName`    VARCHAR(120) NOT NULL                            COMMENT '对象名（表名 / 视图名 / 存储过程名）',
  `objComment` VARCHAR(500) DEFAULT NULL                        COMMENT '注释',
  `engine`     VARCHAR(40)  DEFAULT NULL                        COMMENT '存储引擎（MySQL）',
  `charset`    VARCHAR(40)  DEFAULT NULL                        COMMENT '字符集',
  `rowCount`   BIGINT       NOT NULL DEFAULT 0                  COMMENT '行数（扫描时的近似值）',
  `ddl`        LONGTEXT     DEFAULT NULL                        COMMENT '原始 DDL（视图 / 存储过程原文，或扫描到的建表语句）',
  `source`     VARCHAR(10)  NOT NULL DEFAULT 'manual'           COMMENT '来源：scan/manual/import',
  `locked`     TINYINT(1)   NOT NULL DEFAULT 0                  COMMENT '锁定否：1-扫描不覆盖、不删除',
  `sortNo`     INT(11)      NOT NULL DEFAULT 0                  COMMENT '显示序号',
  `createTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP  COMMENT '创建时间',
  `updateTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_appschemaobjs` (`dbId`, `objName`),
  KEY `idx_appschemaobjs_db` (`dbId`),
  KEY `idx_appschemaobjs_type` (`objType`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用库对象（表 / 视图 / 存储过程）';

-- ---------------------------------------------------------------------
-- 4) 字段（表 / 视图；存储过程不存字段，正文在 objs.ddl）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `appschemacols` (
  `id`           CHAR(36)     NOT NULL DEFAULT ''               COMMENT '字段ID（UUID）',
  `objId`        CHAR(36)     NOT NULL                          COMMENT '所属对象（appschemaobjs.id）',
  `colName`      VARCHAR(120) NOT NULL                          COMMENT '字段名',
  `ordinal`      INT(11)      NOT NULL DEFAULT 0                COMMENT '字段顺序（从 1 开始）',
  `dataType`     VARCHAR(30)  NOT NULL DEFAULT 'VARCHAR'        COMMENT '逻辑类型：VARCHAR/INT/BIGINT/DECIMAL/DATETIME/BOOLEAN/TEXT/BLOB/JSON/UUID...',
  `length`       VARCHAR(20)  DEFAULT NULL                      COMMENT '长度 / 精度（如 100、12,2；不需要则留空）',
  `nullable`     TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '可空否：1-可空，0-非空',
  `defaultValue` VARCHAR(255) DEFAULT NULL                      COMMENT '默认值（原样保存，生成脚本时按方言渲染）',
  `isPk`         TINYINT(1)   NOT NULL DEFAULT 0                COMMENT '主键否',
  `isAutoInc`    TINYINT(1)   NOT NULL DEFAULT 0                COMMENT '自增否',
  `colComment`   VARCHAR(500) DEFAULT NULL                      COMMENT '字段注释',
  `source`       VARCHAR(10)  NOT NULL DEFAULT 'manual'         COMMENT '来源：scan/manual/import',
  `locked`       TINYINT(1)   NOT NULL DEFAULT 0                COMMENT '锁定否：1-扫描不覆盖、不删除',
  `createTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_appschemacols` (`objId`, `colName`),
  KEY `idx_appschemacols_obj` (`objId`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用表字段（逻辑类型，生成脚本时按方言渲染）';

-- ---------------------------------------------------------------------
-- 5) 版本：草稿（每次保存一版）+ 正式版（发布后才有 versionNo）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `appschemavers` (
  `id`          CHAR(36)     NOT NULL DEFAULT ''                COMMENT '版本ID（UUID）',
  `appId`       CHAR(36)     NOT NULL                           COMMENT '所属应用（appinfos.id）',
  `kind`        VARCHAR(10)  NOT NULL DEFAULT 'draft'           COMMENT '类型：draft-草稿 / release-正式版',
  `seq`         INT(11)      NOT NULL DEFAULT 1                 COMMENT '应用内递增序号（仅排序用）',
  `versionNo`   VARCHAR(20)  DEFAULT NULL                       COMMENT '正式版号（v1 / v2 ...，草稿为空）',
  `baseVerId`   CHAR(36)     DEFAULT NULL                       COMMENT '本版基于哪个正式版',
  `source`      VARCHAR(10)  NOT NULL DEFAULT 'manual'          COMMENT '来源：scan-扫描导入 / manual-手工 / import-DDL导入 / adopt-采纳实库',
  `status`      VARCHAR(12)  NOT NULL DEFAULT 'draft'           COMMENT '状态：draft/released/applied/superseded/discarded',
  `summary`     VARCHAR(500) DEFAULT NULL                       COMMENT '变更摘要（自动生成，可编辑）',
  `changeCount` INT(11)      NOT NULL DEFAULT 0                 COMMENT '变更项数量',
  `snapshot`    LONGTEXT     DEFAULT NULL                       COMMENT '整库结构快照（JSON：库→对象→字段），对比与生成脚本的唯一依据',
  `snapHash`    VARCHAR(64)  DEFAULT NULL                       COMMENT '快照指纹（SHA1），无变化不再出版本',
  `operatorEmpId` BIGINT     DEFAULT NULL                       COMMENT '操作人员工ID',
  `createTime`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建（保存）时间',
  `releaseTime` DATETIME     DEFAULT NULL                       COMMENT '发布时间',
  `publishEmpId` BIGINT      DEFAULT NULL                       COMMENT '发布人员工ID',
  `remark`      VARCHAR(500) DEFAULT NULL                       COMMENT '发布说明 / 变更原因',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_appschemavers_seq` (`appId`, `seq`),
  KEY `idx_appschemavers_app` (`appId`),
  KEY `idx_appschemavers_kind` (`appId`, `kind`, `status`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用结构版本（草稿 / 正式版，含整库快照）';

-- ---------------------------------------------------------------------
-- 6) 变更明细（每次保存一版 = 与上一版的差异）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `appschemachanges` (
  `id`         CHAR(36)     NOT NULL DEFAULT ''                 COMMENT '明细ID（UUID）',
  `verId`      CHAR(36)     NOT NULL                            COMMENT '所属版本（appschemavers.id）',
  `objType`    VARCHAR(12)  NOT NULL DEFAULT 'table'            COMMENT '对象类型：db/table/view/procedure/column',
  `objName`    VARCHAR(300) NOT NULL                            COMMENT '对象全名（库名.表名[.字段名]，便于按表查历史）',
  `action`     VARCHAR(10)  NOT NULL DEFAULT 'alter'            COMMENT '动作：create/alter/drop',
  `detail`     VARCHAR(500) DEFAULT NULL                        COMMENT '变更说明（人话，如：新增字段 2、修改字段 1）',
  `beforeJson` LONGTEXT     DEFAULT NULL                        COMMENT '变更前（JSON，生成回滚脚本用）',
  `afterJson`  LONGTEXT     DEFAULT NULL                        COMMENT '变更后（JSON）',
  `remark`     VARCHAR(200) DEFAULT NULL                        COMMENT '备注',
  PRIMARY KEY (`id`),
  KEY `idx_appschemachanges_ver` (`verId`),
  KEY `idx_appschemachanges_name` (`objName`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用结构变更明细（每个版本一条或多条）';

-- ---------------------------------------------------------------------
-- 7) 变更脚本（发布时生成，人工确认后才执行）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `appschemascripts` (
  `id`          CHAR(36)     NOT NULL DEFAULT ''                COMMENT '脚本ID（UUID）',
  `verId`       CHAR(36)     NOT NULL                           COMMENT '所属版本（appschemavers.id，仅正式版）',
  `dbType`      VARCHAR(30)  NOT NULL DEFAULT 'mysql'           COMMENT '方言：mysql/postgresql/oracle/sqlserver/sqlite',
  `kind`        VARCHAR(10)  NOT NULL DEFAULT 'forward'         COMMENT '类型：forward-正向 / rollback-回滚',
  `scriptText`  LONGTEXT     DEFAULT NULL                       COMMENT '脚本正文（发布时生成，之后不再重算）',
  `checksum`    VARCHAR(64)  DEFAULT NULL                       COMMENT '正文指纹（SHA1），用于核对是否被改过',
  `status`      VARCHAR(12)  NOT NULL DEFAULT 'pending'         COMMENT '状态：pending-待执行 / applied-已执行 / failed-执行失败 / skipped-外部执行',
  `confirmEmpId` BIGINT      DEFAULT NULL                       COMMENT '确认执行人',
  `confirmTime` DATETIME     DEFAULT NULL                       COMMENT '确认时间',
  `execEmpId`   BIGINT       DEFAULT NULL                       COMMENT '执行人',
  `execTime`    DATETIME     DEFAULT NULL                       COMMENT '执行时间',
  `execError`   VARCHAR(500) DEFAULT NULL                       COMMENT '执行失败原因',
  `createTime`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间',
  PRIMARY KEY (`id`),
  KEY `idx_appschemascripts_ver` (`verId`),
  KEY `idx_appschemascripts_status` (`status`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用结构变更脚本（正向 / 回滚，人工确认后执行）';

-- ---------------------------------------------------------------------
-- 8) 设计态 vs 实库对比（只有人工点「对比」才会产生记录）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `appschemacompares` (
  `id`          CHAR(36)     NOT NULL DEFAULT ''                COMMENT '对比ID（UUID）',
  `appId`       CHAR(36)     NOT NULL                           COMMENT '所属应用',
  `leftKind`    VARCHAR(12)  NOT NULL DEFAULT 'design'          COMMENT '左侧：design-当前设计 / draft-当前草稿 / release-指定正式版',
  `leftVerId`   CHAR(36)     DEFAULT NULL                       COMMENT '左侧版本ID（leftKind=release 时有值）',
  `dbType`      VARCHAR(30)  NOT NULL DEFAULT 'mysql'           COMMENT '方言',
  `dbName`      VARCHAR(120) DEFAULT NULL                       COMMENT '对比的库（空 = 全部）',
  `connId`      CHAR(36)     DEFAULT NULL                       COMMENT '实库连接对象（dbinfomgr.id；上线前可换成生产库连接）',
  `connName`    VARCHAR(100) DEFAULT NULL                       COMMENT '实库连接名（快照，连接改名或删除后仍可追溯）',
  `designDb`    VARCHAR(120) DEFAULT NULL                       COMMENT '对应设计态的库（与 dbName 不同时为库名映射）',
  `snapTime`    DATETIME     DEFAULT NULL                       COMMENT '实库数据取的时间点',
  `sameCount`   INT(11)      NOT NULL DEFAULT 0                 COMMENT '一致对象数',
  `addCount`    INT(11)      NOT NULL DEFAULT 0                 COMMENT '仅设计有（待建）',
  `dropCount`   INT(11)      NOT NULL DEFAULT 0                 COMMENT '仅实库有（未纳管）',
  `alterCount`  INT(11)      NOT NULL DEFAULT 0                 COMMENT '属性不一致',
  `itemCount`   INT(11)      NOT NULL DEFAULT 0                 COMMENT '明细条数',
  `operatorEmpId` BIGINT     DEFAULT NULL                       COMMENT '操作人员工ID',
  `createTime`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '对比时间',
  `remark`      VARCHAR(500) DEFAULT NULL                       COMMENT '备注',
  PRIMARY KEY (`id`),
  KEY `idx_appschemacompares_app` (`appId`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用结构对比记录（人工触发，结果留存）';

CREATE TABLE IF NOT EXISTS `appschemacompareitems` (
  `id`        CHAR(36)     NOT NULL DEFAULT ''                  COMMENT '明细ID（UUID）',
  `compareId` CHAR(36)     NOT NULL                             COMMENT '所属对比（appschemacompares.id）',
  `diffType`  VARCHAR(12)  NOT NULL DEFAULT 'same'              COMMENT '差异类型：same/designOnly/dbOnly/attrDiff/orderDiff',
  `objType`   VARCHAR(12)  NOT NULL DEFAULT 'table'             COMMENT '对象类型：db/table/view/procedure/column',
  `objName`   VARCHAR(300) NOT NULL                             COMMENT '对象全名',
  `leftJson`  LONGTEXT     DEFAULT NULL                         COMMENT '左侧（设计态）定义',
  `rightJson` LONGTEXT     DEFAULT NULL                         COMMENT '右侧（实库）定义',
  `message`   VARCHAR(500) DEFAULT NULL                         COMMENT '差异说明',
  PRIMARY KEY (`id`),
  KEY `idx_appschemacompareitems_cmp` (`compareId`),
  KEY `idx_appschemacompareitems_type` (`diffType`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用结构对比明细';

-- 结构回显（便于人工核对）
SHOW TABLES LIKE 'app%';
