-- ============================================================================
-- 系统字典业务数据：计划事项状态（project_plan_item_status）
--   字典：计划事项状态 / project_plan_item_status，顶级，sortNo=20，启用
--   键值：待执行 / 执行中 / 完成 / 异常，键值编码 01 / 02 / 03 / 04
--   页面用「键」显示与存储（与 project_type 口径一致）；脚本可重复执行。
-- 执行：mysql -usa -p --default-character-set=utf8mb4 rogerorm < db/sysdict-plan-item-status.sql
-- ============================================================================
SET NAMES utf8mb4;

INSERT INTO `sysdict`
    (`id`, `dictNameCn`, `dictNameEn`, `parentId`, `sortNo`, `remark`, `enabled`, `createTime`, `updateTime`)
VALUES
    ('c0de0001-0002-4a1b-8c00-000000000002', '计划事项状态', 'project_plan_item_status', NULL, 20,
     '项目计划事项 / 任务的状态枚举：待执行 / 执行中 / 完成 / 异常', 1, NOW(), NOW())
ON DUPLICATE KEY UPDATE
    `dictNameCn` = VALUES(`dictNameCn`),
    `dictNameEn` = VALUES(`dictNameEn`),
    `sortNo`     = VALUES(`sortNo`),
    `remark`     = VALUES(`remark`);

INSERT INTO `sysdictitems`
    (`id`, `dictId`, `itemKey`, `itemValue`, `sortNo`, `remark`, `enabled`, `createTime`, `updateTime`)
VALUES
    ('c0de0002-0002-4a1b-8c00-000000000001', 'c0de0001-0002-4a1b-8c00-000000000002', '待执行', '01', 1, NULL, 1, NOW(), NOW()),
    ('c0de0002-0002-4a1b-8c00-000000000002', 'c0de0001-0002-4a1b-8c00-000000000002', '执行中', '02', 2, NULL, 1, NOW(), NOW()),
    ('c0de0002-0002-4a1b-8c00-000000000003', 'c0de0001-0002-4a1b-8c00-000000000002', '完成',   '03', 3, NULL, 1, NOW(), NOW()),
    ('c0de0002-0002-4a1b-8c00-000000000004', 'c0de0001-0002-4a1b-8c00-000000000002', '异常',   '04', 4, NULL, 1, NOW(), NOW())
ON DUPLICATE KEY UPDATE
    `dictId`    = VALUES(`dictId`),
    `itemKey`   = VALUES(`itemKey`),
    `itemValue` = VALUES(`itemValue`),
    `sortNo`    = VALUES(`sortNo`);
