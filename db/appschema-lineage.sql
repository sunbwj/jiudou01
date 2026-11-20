-- ---------------------------------------------------------------------
-- 应用结构 · 字段级血缘（2026-11-19）
-- 说明：血缘是从「表达式」解析出来的，不是靠列名猜 ——
--       视图的 SELECT、触发器 / 存储过程 / 函数体里的 INSERT / UPDATE。
--       解析结果落这两张表，扫描或点「重新分析」时整体重建（先删后插，不留残骸）。
-- 特性：可重复执行（CREATE TABLE IF NOT EXISTS，不碰已有数据）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `appschemalink` (
  `id`         CHAR(36)     NOT NULL DEFAULT ''               COMMENT '主键（UUID）',
  `appId`      CHAR(36)     NOT NULL                          COMMENT '所属应用（appinfos.id）',
  `dbName`     VARCHAR(120) NOT NULL DEFAULT ''                COMMENT '库名',
  `targetObj`  VARCHAR(120) NOT NULL                          COMMENT '目标对象：视图，或被写入的表',
  `targetType` VARCHAR(12)  NOT NULL DEFAULT 'view'            COMMENT '目标类型：view/table',
  `targetCol`  VARCHAR(120) NOT NULL                          COMMENT '目标字段',
  `sourceObj`  VARCHAR(120) NOT NULL                          COMMENT '来源对象（已展开到最内层，通常是基表）',
  `sourceType` VARCHAR(12)  NOT NULL DEFAULT 'table'           COMMENT '来源类型：table/view',
  `sourceCol`  VARCHAR(120) NOT NULL                          COMMENT '来源字段',
  `transform`  VARCHAR(500) DEFAULT NULL                       COMMENT '最内层表达式（怎么算出来的）',
  `via`        VARCHAR(300) DEFAULT NULL                       COMMENT '途经对象链（视图套视图时记录，可直接来源则为空）',
  `depth`      INT(11)      NOT NULL DEFAULT 0                 COMMENT '展开层数（0=直接来源）',
  `kind`       VARCHAR(12)  NOT NULL DEFAULT 'view'            COMMENT '来源：view/trigger/procedure/function',
  `linkType`   VARCHAR(12)  NOT NULL DEFAULT 'DIRECT'          COMMENT '血缘类型：DIRECT 直接派生 / INDIRECT 间接影响（过滤、连接、分组、排序）',
  `subType`    VARCHAR(16)  NOT NULL DEFAULT ''                COMMENT '子类型：IDENTITY/TRANSFORMATION/AGGREGATION；INDIRECT 侧 JOIN/FILTER/GROUP_BY/SORT/WINDOW',
  `masked`     TINYINT(1)   NOT NULL DEFAULT 0                 COMMENT '值是否经过脱敏 / 哈希（依赖在，原值不传播）',
  `origin`     VARCHAR(12)  NOT NULL DEFAULT ''                COMMENT '边怎么来的：sql-表达式解析 / ref-注释点号引用 / calc-注释口径反查 / manual-人工标注',
  `note`       VARCHAR(500) DEFAULT NULL                       COMMENT '人工标注：为什么这么连 / 口径说明（空=机器解析出来的边）',
  `manualBy`   VARCHAR(60)  DEFAULT NULL                       COMMENT '标注人（员工中文名）',
  `updateTime` DATETIME     DEFAULT NULL                       COMMENT '最近一次人工修改时间',
  `createTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '解析时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_appschemalink` (`appId`,`targetObj`,`targetCol`,`sourceObj`,`sourceCol`,`subType`),
  KEY `idx_appschemalink_target` (`appId`,`targetObj`,`targetCol`),
  KEY `idx_appschemalink_source` (`appId`,`sourceObj`,`sourceCol`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用结构 · 字段级血缘（目标字段 ← 来源字段）';

-- 解析不了的地方要留痕：静默当作「没有血缘」是这类功能最容易埋的雷
CREATE TABLE IF NOT EXISTS `appschemalinknote` (
  `id`         CHAR(36)     NOT NULL DEFAULT ''                COMMENT '主键（UUID）',
  `appId`      CHAR(36)     NOT NULL                          COMMENT '所属应用',
  `objName`    VARCHAR(120) NOT NULL DEFAULT ''                COMMENT '出问题的对象',
  `objType`    VARCHAR(12)  NOT NULL DEFAULT ''                COMMENT '对象类型',
  `reason`     VARCHAR(500) NOT NULL DEFAULT ''                COMMENT '没解析出来的原因',
  `createTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间',
  PRIMARY KEY (`id`),
  KEY `idx_appschemalinknote_app` (`appId`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用结构 · 血缘解析未覆盖的地方（页面要显式提示）';

-- 构建状态：上次什么时候算的、算了多少条（页面顶部显示，避免让人以为没生效）
CREATE TABLE IF NOT EXISTS `appschemalinkmeta` (
  `appId`       CHAR(36)     NOT NULL                          COMMENT '应用ID',
  `builtAt`     DATETIME     DEFAULT NULL                      COMMENT '上次构建时间',
  `edgeCount`   INT(11)      NOT NULL DEFAULT 0                COMMENT '血缘边数',
  `objectCount` INT(11)      NOT NULL DEFAULT 0                COMMENT '参与解析的对象数（视图 + 过程 + 触发器 + 函数）',
  `noteCount`   INT(11)      NOT NULL DEFAULT 0                COMMENT '未解析提示条数',
  `dbType`      VARCHAR(30)  NOT NULL DEFAULT ''                COMMENT '解析用的方言',
  PRIMARY KEY (`appId`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci
  COMMENT = '应用结构 · 血缘构建状态';
