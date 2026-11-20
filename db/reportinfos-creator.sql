-- ============================================================================
-- 数据中心 · 报表信息（reportinfos）：创建人 / 修改人改为「姓名 + 员工ID」
-- ----------------------------------------------------------------------------
-- 变更内容：
--   1) createUser  →  createEname          （只存创建人**姓名**，旧数据原样保留）
--   2) 新增 createempinfosid               （创建人员工ID，empinfos.id）
--   3) 新增 updateEname                    （最后修改人姓名）
--   4) 新增 updateempinfosid               （最后修改人员工ID）
-- 约定：
--   · 四个字段都由后端按 token 反查当前登录人自动写入，**页面不展示、前端不用传**；
--   · 员工ID 用 BIGINT UNSIGNED（与 empinfos.id / useinfo.empId 一致），可能为空（账号没绑员工）；
--   · MySQL 5.7 没有 ADD COLUMN IF NOT EXISTS，脚本只执行一次（重复执行会报 Duplicate column）。
--
-- 执行（客户端不在 PATH，先 cd 到 bin 目录）：
--   cd /d/mysql/mysql_5_7_22_winx64/bin && ./mysql.exe -u sa -proger2019 \
--     --default-character-set=utf8mb4 rogerorm < ../../workbuddy-workspace/2026-10-29-12-03-22/menu-admin/db/reportinfos-creator.sql
-- ============================================================================

SET NAMES utf8mb4;

-- 1) 改名字段（CHANGE 保留原有数据）
ALTER TABLE `reportinfos`
  CHANGE COLUMN `createUser` `createEname` VARCHAR(100) DEFAULT NULL
         COMMENT '创建人姓名（后端按登录用户自动带入）';

-- 2) 三个新字段
ALTER TABLE `reportinfos`
  ADD COLUMN `createempinfosid` BIGINT UNSIGNED DEFAULT NULL
      COMMENT '创建人员工ID（empinfos.id，后端自动带入）' AFTER `createEname`,
  ADD COLUMN `updateEname`      VARCHAR(100)    DEFAULT NULL
      COMMENT '最后修改人姓名（后端按登录用户自动带入）' AFTER `createempinfosid`,
  ADD COLUMN `updateempinfosid` BIGINT UNSIGNED DEFAULT NULL
      COMMENT '最后修改人员工ID（empinfos.id，后端自动带入）' AFTER `updateEname`;

-- 3) 索引：按创建人 / 修改人检索（后续「我创建的报表」这类过滤要用）
ALTER TABLE `reportinfos`
  ADD KEY `idx_reportinfos_creator` (`createempinfosid`),
  ADD KEY `idx_reportinfos_updater` (`updateempinfosid`);

-- 4) 存量数据尽量补员工ID：只补「姓名在 empinfos 里唯一」的行，重名的宁可不补，避免张冠李戴
UPDATE `reportinfos` r
  JOIN (SELECT `nameCn`, MIN(`id`) AS `empId`
          FROM `empinfos`
         GROUP BY `nameCn`
        HAVING COUNT(*) = 1) e
    ON e.`nameCn` = r.`createEname`
   SET r.`createempinfosid` = e.`empId`
 WHERE r.`createempinfosid` IS NULL
   AND r.`createEname` IS NOT NULL
   AND r.`createEname` <> '';

-- 5) 核对
SHOW FULL COLUMNS FROM `reportinfos`;
SELECT `code`, `reportName`, `createEname`, `createempinfosid`,
       `updateEname`, `updateempinfosid`
  FROM `reportinfos`
 ORDER BY `code`;
