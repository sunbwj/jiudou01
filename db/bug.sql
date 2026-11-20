-- =====================================================================
-- 缺陷 / 问题管理（客户现场实施遇到的问题）
-- ---------------------------------------------------------------------
-- 业务链路：
--   ① 登记：问题描述 / 所在项目 / 发生时间 / 接收人（组织架构选人）
--            → 给创建人 + 接收人 推送站内即时消息 + 邮件；
--   ② 评估：接收人评估，每条结果追加到 bugevaluations（时间线展示，不改历史）
--            → 每次评估结果给创建人 + 接收人 推送消息 + 邮件；
--   ③ 确认缺陷：指定研发 / 测试 / 验收三组责任人与起止时间（验收人默认创建人）
--            → 自动建成 1 张修复计划 + 3 条任务 + 3 张工单（workplans/tasks/orders），
--              工单进「我的任务」，研发 / 测试工单计入工作量统计。
-- 设计要点：
--   · **可重复执行、非破坏性**：建表用 CREATE TABLE IF NOT EXISTS，
--     加列先查 information_schema，不 DROP / 不 DELETE / 不 UPDATE 业务数据；
--   · 工单不新建表：一个缺陷 = 一张工作计划（WP+6）+ 三条任务 + 三张工单（WO+6），
--     复用现有派单 / 通知 / 我的任务 / 工作量统计全链路，避免双表合并；
--   · workplanorders / workplantasks 增加 orderKind 标记来源：
--       plan（计划任务，默认）/ bug-dev（研发修复）/ bug-test（测试验证）/ bug-accept（验收）
--     验收工单照常生成并进「我的任务」，但**不进工作量统计**（WorkloadService 已排除）；
--   · 评估时间线与需求模块同构（result / reason / reasonHtml / 操作人 / 参与人），
--     每条记录只追加，历史结论可追溯。
-- 依赖：db/workplan.sql（三张工单表）+ db/workplan-exec.sql（工单执行字段）。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/bug.sql
-- 同步：db/rogerorm-schema.sql 末尾有同结构建表（全量建库用）。
-- =====================================================================

SET NAMES utf8mb4;
SET @db := DATABASE();

-- ---------- 1) 缺陷 / 问题单 ----------
CREATE TABLE IF NOT EXISTS `buginfos` (
  `id`               CHAR(36)        NOT NULL                     COMMENT '缺陷ID（UUID）',
  `bugCode`          VARCHAR(20)     NOT NULL                     COMMENT '缺陷编号（BUG + 6 位流水号，唯一）',
  `title`            VARCHAR(200)    NOT NULL                     COMMENT '问题标题（一句话现象）',
  `description`      MEDIUMTEXT      NULL                         COMMENT '问题描述（纯文本）',
  `descriptionHtml`  MEDIUMTEXT      NULL                         COMMENT '问题描述富文本 HTML',
  `projectId`        CHAR(36)        DEFAULT NULL                 COMMENT '所在项目（projectinfos.id，可空）',
  `projectName`      VARCHAR(150)    DEFAULT NULL                 COMMENT '项目名称快照',
  `happenTime`       DATETIME        DEFAULT NULL                 COMMENT '发生时间（客户现场实际发生时刻）',
  `level`            VARCHAR(10)     DEFAULT NULL                 COMMENT '严重级别：P0 / P1 / P2 / P3（评估时定级）',
  `sourceType`       VARCHAR(20)     NOT NULL DEFAULT '客户现场'  COMMENT '来源：客户现场 / 内部测试 / 用户反馈 / 运维巡检',
  `status`           VARCHAR(20)     NOT NULL DEFAULT '待评估'    COMMENT '待评估 / 已确认 / 非缺陷 / 已转工单 / 已修复 / 已关闭',
  `reporterId`       BIGINT UNSIGNED NOT NULL DEFAULT 0           COMMENT '创建人（提出人）员工ID',
  `reporterName`     VARCHAR(100)    DEFAULT NULL                 COMMENT '创建人姓名快照',
  `receiverId`       BIGINT UNSIGNED NOT NULL DEFAULT 0           COMMENT '接收人（评估人）员工ID',
  `receiverName`     VARCHAR(100)    DEFAULT NULL                 COMMENT '接收人姓名快照',
  `devOwnerId`       BIGINT UNSIGNED DEFAULT NULL                 COMMENT '研发责任人员工ID',
  `devOwnerName`     VARCHAR(50)     DEFAULT NULL                 COMMENT '研发责任人姓名',
  `devStartDate`     DATE            DEFAULT NULL                 COMMENT '研发开始日期',
  `devEndDate`       DATE            DEFAULT NULL                 COMMENT '研发结束日期',
  `testOwnerId`      BIGINT UNSIGNED DEFAULT NULL                 COMMENT '测试责任人员工ID',
  `testOwnerName`    VARCHAR(50)     DEFAULT NULL                 COMMENT '测试责任人姓名',
  `testStartDate`    DATE            DEFAULT NULL                 COMMENT '测试开始日期',
  `testEndDate`      DATE            DEFAULT NULL                 COMMENT '测试结束日期',
  `acceptOwnerId`    BIGINT UNSIGNED DEFAULT NULL                 COMMENT '验收责任人员工ID（默认创建人）',
  `acceptOwnerName`  VARCHAR(50)     DEFAULT NULL                 COMMENT '验收责任人姓名',
  `acceptStartDate`  DATE            DEFAULT NULL                 COMMENT '验收开始日期',
  `acceptEndDate`    DATE            DEFAULT NULL                 COMMENT '验收结束日期',
  `planId`           CHAR(36)        DEFAULT NULL                 COMMENT '生成的修复计划（workplans.id，一对一）',
  `evalCount`        INT             NOT NULL DEFAULT 0           COMMENT '评估记录条数（列表展示）',
  `closeReason`      VARCHAR(500)    DEFAULT NULL                 COMMENT '关闭 / 非缺陷原因',
  `createTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updateTime`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_buginfos_code` (`bugCode`),
  UNIQUE KEY `uk_buginfos_plan` (`planId`),
  KEY `idx_buginfos_status` (`status`),
  KEY `idx_buginfos_receiver` (`receiverId`),
  KEY `idx_buginfos_reporter` (`reporterId`),
  KEY `idx_buginfos_project` (`projectId`),
  KEY `idx_buginfos_happen` (`happenTime`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='缺陷 / 问题单（客户现场实施问题登记与评估）';

-- 老库增量：所在应用 → 所在项目（改列名保留历史值；已是 projectId 的库自动跳过）
SET @hasApp := (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'buginfos' AND COLUMN_NAME = 'appId');
SET @hasPrj := (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'buginfos' AND COLUMN_NAME = 'projectId');
SET @sql := IF(@hasApp > 0 AND @hasPrj = 0,
  'ALTER TABLE `buginfos` CHANGE COLUMN `appId` `projectId` CHAR(36) DEFAULT NULL COMMENT ''所在项目（projectinfos.id，可空）''',
  'SELECT ''skip: buginfos.projectId 已就绪'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @hasAppName := (SELECT COUNT(*) FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'buginfos' AND COLUMN_NAME = 'appName');
SET @hasPrjName := (SELECT COUNT(*) FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'buginfos' AND COLUMN_NAME = 'projectName');
SET @sql := IF(@hasAppName > 0 AND @hasPrjName = 0,
  'ALTER TABLE `buginfos` CHANGE COLUMN `appName` `projectName` VARCHAR(150) DEFAULT NULL COMMENT ''项目名称快照''',
  'SELECT ''skip: buginfos.projectName 已就绪'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @hasOldIdx := (SELECT COUNT(*) FROM information_schema.STATISTICS
                   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'buginfos' AND INDEX_NAME = 'idx_buginfos_app');
SET @hasNewIdx := (SELECT COUNT(*) FROM information_schema.STATISTICS
                   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'buginfos' AND INDEX_NAME = 'idx_buginfos_project');
SET @sql := IF(@hasOldIdx > 0 AND @hasNewIdx = 0,
  'ALTER TABLE `buginfos` RENAME INDEX `idx_buginfos_app` TO `idx_buginfos_project`',
  'SELECT ''skip: 索引无需改名'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------- 2) 评估时间线（只追加，不改历史） ----------
CREATE TABLE IF NOT EXISTS `bugevaluations` (
  `id`             CHAR(36)        NOT NULL                  COMMENT '评估记录ID',
  `bugId`          CHAR(36)        NOT NULL                  COMMENT '缺陷ID（buginfos.id）',
  `seq`            INT             NOT NULL DEFAULT 0        COMMENT '评估序号（1 起；同一秒多次评估也能稳定排序）',
  `result`         VARCHAR(20)     NOT NULL                  COMMENT '结论：是缺陷 / 非缺陷 / 需补充信息',
  `level`          VARCHAR(10)     DEFAULT NULL              COMMENT '本次定级：P0 / P1 / P2 / P3',
  `reason`         TEXT            NULL                      COMMENT '评估意见 / 原因（纯文本）',
  `reasonHtml`     MEDIUMTEXT      NULL                      COMMENT '评估意见富文本 HTML',
  `evaluatorId`    BIGINT UNSIGNED DEFAULT NULL              COMMENT '操作人（评估人）员工ID',
  `evaluatorName`  VARCHAR(100)    DEFAULT NULL              COMMENT '操作人姓名',
  `evaluatorIds`   TEXT            NULL                      COMMENT '参与评估人员ID（逗号分隔）',
  `evaluatorNames` VARCHAR(500)    NULL                      COMMENT '参与评估人员姓名（逗号分隔）',
  `createTime`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_bugeval_bug` (`bugId`),
  KEY `idx_bugeval_time` (`createTime`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='缺陷评估记录单（时间线，按条追加）';

-- 老库增量：评估序号（时间线排序不能只靠 DATETIME，同秒会退化成按 UUID 排）
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'bugevaluations' AND COLUMN_NAME = 'seq');
SET @sql := IF(@has = 0,
  'ALTER TABLE `bugevaluations` ADD COLUMN `seq` INT NOT NULL DEFAULT 0 COMMENT ''评估序号（1 起；同一秒多次评估也能稳定排序）'' AFTER `bugId`',
  'SELECT ''skip: bugevaluations.seq 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------- 2.1) 缺陷附件（登记 / 编辑时上传，落盘 server/uploads/bug/<bugId>/） ----------
CREATE TABLE IF NOT EXISTS `bugfiles` (
  `id`           CHAR(36)        NOT NULL                  COMMENT '附件ID',
  `bugId`        CHAR(36)        NOT NULL                  COMMENT '缺陷ID（buginfos.id）',
  `name`         VARCHAR(255)    NOT NULL                  COMMENT '文件名',
  `path`         VARCHAR(500)    NOT NULL                  COMMENT '存储相对路径（<bugId>/<uuid>.<ext>）',
  `size`         BIGINT          NOT NULL DEFAULT 0        COMMENT '字节数',
  `ext`          VARCHAR(20)     DEFAULT NULL              COMMENT '扩展名',
  `uploaderId`   BIGINT UNSIGNED DEFAULT NULL              COMMENT '上传人员工ID',
  `uploaderName` VARCHAR(100)    DEFAULT NULL              COMMENT '上传人姓名',
  `uploadTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_bugfiles_bug` (`bugId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='缺陷附件（登记 / 编辑时上传，内容落盘）';

-- ---------- 3) workplanorders：工单来源标记 ----------
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplanorders' AND COLUMN_NAME = 'orderKind');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplanorders` ADD COLUMN `orderKind` VARCHAR(20) NOT NULL DEFAULT ''plan'' COMMENT ''来源：plan 计划任务 / bug-dev 缺陷研发 / bug-test 缺陷测试 / bug-accept 缺陷验收'' AFTER `taskType`',
  'SELECT ''skip: workplanorders.orderKind 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplanorders' AND INDEX_NAME = 'idx_wporders_kind');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplanorders` ADD KEY `idx_wporders_kind` (`orderKind`)',
  'SELECT ''skip: idx_wporders_kind 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------- 4) workplantasks：任务来源标记（保存整图时不丢派单口径） ----------
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workplantasks' AND COLUMN_NAME = 'orderKind');
SET @sql := IF(@has = 0,
  'ALTER TABLE `workplantasks` ADD COLUMN `orderKind` VARCHAR(20) NOT NULL DEFAULT ''plan'' COMMENT ''派单来源：plan / bug-dev / bug-test / bug-accept'' AFTER `taskType`',
  'SELECT ''skip: workplantasks.orderKind 已存在'' AS `msg`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------- 5) 菜单：项目管理 · 缺陷管理 ----------
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00031','缺陷管理','BugManagement','bug.html','warning','22','1',
       '项目管理：客户现场缺陷 / 问题登记、评估时间线、确认后自动生成修复工单并计入工作量'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00031');

INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 22, 1, '项目管理'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00031'
WHERE g.`code`='MNG1006'
  AND NOT EXISTS (SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`);

INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT MD5(CONCAT(r.`id`,'-',g.`id`,'-',m.`id`)), r.`id`, g.`id`, m.`id`, 1, '缺陷管理（默认授权）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1006'
JOIN `menuinfros` m ON m.`code`='MNU00031'
WHERE r.`enabled`=1
  AND NOT EXISTS (SELECT 1 FROM `usergrouppowerset` p
                  WHERE p.`roleId`=r.`id` AND p.`menuGroupId`=g.`id` AND p.`menuItemId`=m.`id`);

-- ---------- 6) 页面按钮登记 + 默认授权 ----------
-- 说明：btnperm.js 对未授权按钮是**直接隐藏**，新页上线必须补齐这两步。
--       page_scan.py 能扫到 .toolbar 里的按钮，这里同时登记一份，
--       保证「先跑 SQL 后上线」也不会出现按钮全隐形。
INSERT IGNORE INTO `pageopbtn`
  (`id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo`,`enabled`,`remark`)
SELECT UUID(), s.`pageName`, s.`pagePath`, s.`btnId`, s.`btnText`, s.`sortNo`, 1, '缺陷管理页'
FROM (
SELECT '缺陷管理' AS `pageName`, 'bug.html' AS `pagePath`,
       'bugBtnAdd' AS `btnId`, '登记缺陷 / 问题' AS `btnText`, 0 AS `sortNo`
UNION ALL SELECT '缺陷管理', 'bug.html', 'bugBtnDetail', '查看详情与评估时间线', 1
UNION ALL SELECT '缺陷管理', 'bug.html', 'bugBtnEvaluate', '评估确认（是缺陷 / 非缺陷 / 需补充信息）', 2
UNION ALL SELECT '缺陷管理', 'bug.html', 'bugBtnConfirm', '确认缺陷并生成修复工单（研发 / 测试 / 验收）', 3
UNION ALL SELECT '缺陷管理', 'bug.html', 'bugBtnEdit', '编辑缺陷信息（未转工单前）', 4
UNION ALL SELECT '缺陷管理', 'bug.html', 'bugBtnClose', '关闭缺陷并记录原因', 5
UNION ALL SELECT '缺陷管理', 'bug.html', 'bugBtnRefresh', '刷新缺陷列表', 6
) s;

INSERT INTO `usergrouppagebtnset` (`id`,`roleId`,`pageOpBtnId`,`enabled`,`remark`)
SELECT MD5(CONCAT(r.`id`,'-',b.`id`)), r.`id`, b.`id`, 1, '缺陷管理按钮默认授权（可在角色权限页调整）'
FROM `usergroup` r
JOIN `pageopbtn` b ON b.`pagePath`='bug.html' AND b.`enabled`=1
WHERE r.`enabled`=1
  AND NOT EXISTS (SELECT 1 FROM `usergrouppagebtnset` s
                  WHERE s.`roleId`=r.`id` AND s.`pageOpBtnId`=b.`id`);

-- ---------- 回显 ----------
SHOW TABLES LIKE 'bug%';
SELECT m.`code`, m.`nameCn`, m.`path`, s.`sortNo`,
       (SELECT COUNT(*) FROM `usergrouppowerset` p WHERE p.`menuItemId`=m.`id`) AS `roleCount`
FROM `menuinfros` m
LEFT JOIN `menugroupitemset` s ON s.`itemId`=m.`id`
WHERE m.`code`='MNU00031';
SELECT b.`btnId`, b.`btnText`,
       (SELECT COUNT(*) FROM `usergrouppagebtnset` s WHERE s.`pageOpBtnId`=b.`id`) AS `roleCount`
FROM `pageopbtn` b
WHERE b.`pagePath`='bug.html'
ORDER BY b.`sortNo`;
