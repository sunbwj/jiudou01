-- =====================================================================
-- 报表信息表（reportinfos）：数据源连接快照
-- ---------------------------------------------------------------------
-- 背景（2026-11-06 用户需求）：
--   报表原来只存 connId（指向 dbinfomgr）。一旦有人在「数据库连接管理」里改了主机 / 端口 /
--   账号密码 / 库名，或干脆把连接删了，已保存的报表就执行不了。
--   解决办法：**保存报表时把所选连接对象的全部访问信息一起快照到报表行里**，
--   执行报表时优先用快照（连接对象后来怎么改都不影响已保存的报表）。
-- 约定：
--   · connPassword 沿用 dbinfomgr 的加密格式（`enc:v1:` + XOR 流 + base64，密钥 config.DBINFO_SECRET），
--     接口永远只回掩码，不会把明文密码吐给前端；
--   · 快照列全部可空：老报表没有快照时执行仍回退到 dbinfomgr 的当前值（向后兼容）；
--   · 重新选择数据源并保存 = 刷新快照。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < reportinfos-conn-snapshot.sql
-- =====================================================================

SET NAMES utf8mb4;

ALTER TABLE `reportinfos`
  ADD COLUMN `connType`        VARCHAR(30)  DEFAULT NULL COMMENT '数据源类型快照（mysql/mariadb/postgresql/oracle/sqlserver/sqlite）' AFTER `connName`,
  ADD COLUMN `connHost`        VARCHAR(120) DEFAULT NULL COMMENT '数据源主机快照' AFTER `connType`,
  ADD COLUMN `connPort`        INT(11)      DEFAULT NULL COMMENT '数据源端口快照' AFTER `connHost`,
  ADD COLUMN `connDbName`      VARCHAR(120) DEFAULT NULL COMMENT '数据源默认库 / 服务名 / SQLite 路径快照' AFTER `connPort`,
  ADD COLUMN `connUsername`    VARCHAR(100) DEFAULT NULL COMMENT '数据源登录账号快照' AFTER `connDbName`,
  ADD COLUMN `connPassword`    VARCHAR(255) DEFAULT NULL COMMENT '数据源登录密码快照（加密存储，enc:v1: 前缀）' AFTER `connUsername`,
  ADD COLUMN `connCharset`     VARCHAR(40)  DEFAULT NULL COMMENT '数据源字符集快照' AFTER `connPassword`,
  ADD COLUMN `connExtraParams` VARCHAR(500) DEFAULT NULL COMMENT '数据源附加连接参数快照（key=value&…）' AFTER `connCharset`;

-- 存量回填：已有报表按当前连接对象补一份快照（密码直接复制密文，不解密）
UPDATE `reportinfos` r
  JOIN `dbinfomgr` d ON r.`connId` = d.`id`
   SET r.`connType`        = d.`dbType`,
       r.`connHost`        = d.`host`,
       r.`connPort`        = d.`port`,
       r.`connDbName`      = d.`dbName`,
       r.`connUsername`    = d.`username`,
       r.`connPassword`    = d.`password`,
       r.`connCharset`     = d.`charset`,
       r.`connExtraParams` = d.`extraParams`
 WHERE r.`connId` IS NOT NULL;

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `reportinfos`;
