-- =====================================================================
-- 数据中心：报表信息表（reportinfos）
-- ---------------------------------------------------------------------
-- 用途：
--   · 报表设计器（report-designer.html）把「拖出来的报表」持久化到这里，
--     设计内容（列定义 / 参数 / 页面模板）全部以 JSON 文本随报表一起保存，
--     一条记录就是一个可直接调用的报表；
--   · 后续调用：GET  /api/report/run?id=<UUID>（或 code=报表编码）&paramValues={...}
--     返回报表元信息 + 查询结果，并累加 runCount / 刷新 lastRunTime。
-- 约定：
--   · 主键 UUID（CHAR(36)），报表编码 code 唯一（调用入口，建议 RPT + 4 位流水）；
--   · connId 指向 dbinfomgr.id（数据库连接），connName 保存连接名称快照，便于列表直接展示；
--   · sqlText 允许用 :参数名 占位（如 WHERE hireDate >= :beginDate），参数定义在 paramsJson；
--   · columnsJson / designJson / templateJson 为设计器序列化结果，只由设计器读写，
--     用 MEDIUMTEXT（16MB）避免长报表被截断；
--   · enabled 只表示「这条报表可被调用」，允许多条同时启用；
--   · createEname / createempinfosid / updateEname / updateempinfosid 由后端按当前登录人
--     （token → useinfo → empinfos）自动写入，页面不展示、前端不用传。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < reportinfos.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `reportinfos` (
  `id`           CHAR(36)      NOT NULL                        COMMENT '报表ID（UUID 主键，非自增）',
  `code`         VARCHAR(60)   NOT NULL                        COMMENT '报表编码（唯一，调用入口，如 RPT0001）',
  `reportName`   VARCHAR(120)  NOT NULL                        COMMENT '报表名称（设计器标题默认取它）',
  `reportNameEn` VARCHAR(120)  DEFAULT NULL                    COMMENT '英文名（选填）',
  `category`     VARCHAR(60)   DEFAULT NULL                    COMMENT '报表分类（如 人力资源 / 经营分析）',
  `connId`       CHAR(36)      DEFAULT NULL                    COMMENT '数据库连接ID（dbinfomgr.id）',
  `connName`     VARCHAR(100)  DEFAULT NULL                    COMMENT '连接名称快照（列表直接展示）',
  `connType`     VARCHAR(30)   DEFAULT NULL                    COMMENT '数据源类型快照（mysql/mariadb/postgresql/oracle/sqlserver/sqlite）',
  `connHost`     VARCHAR(120)  DEFAULT NULL                    COMMENT '数据源主机快照',
  `connPort`     INT(11)       DEFAULT NULL                    COMMENT '数据源端口快照',
  `connDbName`   VARCHAR(120)  DEFAULT NULL                    COMMENT '数据源默认库 / 服务名 / SQLite 路径快照',
  `connUsername` VARCHAR(100)  DEFAULT NULL                    COMMENT '数据源登录账号快照',
  `connPassword` VARCHAR(255)  DEFAULT NULL                    COMMENT '数据源登录密码快照（加密存储，enc:v1: 前缀，接口只回掩码）',
  `connCharset`  VARCHAR(40)   DEFAULT NULL                    COMMENT '数据源字符集快照',
  `connExtraParams` VARCHAR(500) DEFAULT NULL                  COMMENT '数据源附加连接参数快照（key=value&…）',
  `databaseName` VARCHAR(120)  DEFAULT NULL                    COMMENT '实例 / 库名（SQLite 留空）',
  `mainTable`    VARCHAR(120)  DEFAULT NULL                    COMMENT '主表 / 视图（未写 SQL 时按它 + 列定义自动拼查询）',
  `sqlText`      MEDIUMTEXT                                    COMMENT '报表查询 SQL（可用 :参数名 占位，只允许查询语句）',
  `paramsJson`   MEDIUMTEXT                                    COMMENT '报表参数定义 JSON：[{name,label,type,control,required,defaultValue,options,remark}]',
  `columnsJson`  MEDIUMTEXT                                    COMMENT '报表列定义 JSON：[{field,label,width,align,format,summary,visible}]',
  `designJson`   MEDIUMTEXT                                    COMMENT '画布设计 JSON：{title,subtitle,headerText,footerText,showTitle,showParams,zebra,groupBy...}',
  `templateJson` MEDIUMTEXT                                    COMMENT '页面模板 JSON：{paper,orientation,margin...,fontSize,titleSize,showPageNo,watermark...}',
  `description`  VARCHAR(500)  DEFAULT NULL                    COMMENT '报表说明',
  `enabled`      TINYINT(1)    NOT NULL DEFAULT 1              COMMENT '启用否：1-启用，0-停用',
  `ispublic`     TINYINT(1)    NOT NULL DEFAULT 0              COMMENT '公开否：1-公开（其他用户在清单 / 报表中心可见），0-私有（仅创建人可见）',
  `version`      INT(11)       NOT NULL DEFAULT 1              COMMENT '版本号（每次保存 +1）',
  `runCount`     INT(11)       NOT NULL DEFAULT 0              COMMENT '被调用次数',
  `lastRunTime`  DATETIME      DEFAULT NULL                    COMMENT '最近一次预览 / 调用时间',
  `createEname`  VARCHAR(100)  DEFAULT NULL                    COMMENT '创建人姓名（后端按登录用户自动带入，页面不展示）',
  `createempinfosid` BIGINT UNSIGNED DEFAULT NULL              COMMENT '创建人员工ID（empinfos.id，后端按登录用户自动带入）',
  `updateEname`  VARCHAR(100)  DEFAULT NULL                    COMMENT '最后修改人姓名（后端按登录用户自动带入，页面不展示）',
  `updateempinfosid` BIGINT UNSIGNED DEFAULT NULL              COMMENT '最后修改人员工ID（empinfos.id，后端按登录用户自动带入）',
  `createTime`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_reportinfos_code`    (`code`),
  KEY `idx_reportinfos_category`      (`category`),
  KEY `idx_reportinfos_conn`          (`connId`),
  KEY `idx_reportinfos_enabled`       (`enabled`),
  KEY `idx_reportinfos_creator`       (`createempinfosid`),
  KEY `idx_reportinfos_updater`       (`updateempinfosid`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '报表信息表（报表设计器持久化，供后续调用）';

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `reportinfos`;
