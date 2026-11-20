-- ============================================================================
-- 系统字典业务数据：项目类型字典（project_type）
--   字典：项目类型 / project_type，顶级（parentId=NULL），sortNo=10，启用
--   键值：键（itemKey）= 研发 / 实施 / 测试 / 设计 / 产品 / 需求 / 数据分析 / 科研 / 其它，
--         键值（itemValue）= 01 / 02 / … / 99（编码）。
--   2026-11-05 口径确认：项目类型下拉**显示并存「键」**（中文文本），键值编码暂不参与；
--   其它 sortNo=99（沉底）。
-- 说明：
--   1. 主键用固定 UUID、脚本可重复执行：ON DUPLICATE KEY UPDATE 只刷新键 / 键值 / 序号，
--      **不覆盖 enabled**，保留页面里的人工启停；
--   2. 字典 id 在所有语句里写死（不用 @变量），便于 mysql 客户端或逐条执行都能跑；
--   3. 执行：mysql -usa -p --default-character-set=utf8mb4 rogerorm < db/sysdict-projecttype.sql
-- ============================================================================
SET NAMES utf8mb4;

INSERT INTO `sysdict`
    (`id`, `dictNameCn`, `dictNameEn`, `parentId`, `sortNo`, `remark`, `enabled`, `createTime`, `updateTime`)
VALUES
    ('c0de0001-0001-4a1b-8c00-000000000001', '项目类型', 'project_type', NULL, 10,
     '项目管理里的项目类型枚举：研发 / 实施 / 测试 / 设计 / 产品 / 需求 / 数据分析 / 科研 / 其它',
     1, NOW(), NOW())
ON DUPLICATE KEY UPDATE
    `dictNameCn` = VALUES(`dictNameCn`),
    `dictNameEn` = VALUES(`dictNameEn`),
    `parentId`   = VALUES(`parentId`),
    `sortNo`     = VALUES(`sortNo`),
    `remark`     = VALUES(`remark`);

INSERT INTO `sysdictitems`
    (`id`, `dictId`, `itemKey`, `itemValue`, `sortNo`, `remark`, `enabled`, `createTime`, `updateTime`)
VALUES
    ('c0de0002-0001-4a1b-8c00-000000000001', 'c0de0001-0001-4a1b-8c00-000000000001', '研发',     '01', 1,  NULL, 1, NOW(), NOW()),
    ('c0de0002-0001-4a1b-8c00-000000000002', 'c0de0001-0001-4a1b-8c00-000000000001', '实施',     '02', 2,  NULL, 1, NOW(), NOW()),
    ('c0de0002-0001-4a1b-8c00-000000000003', 'c0de0001-0001-4a1b-8c00-000000000001', '测试',     '03', 3,  NULL, 1, NOW(), NOW()),
    ('c0de0002-0001-4a1b-8c00-000000000004', 'c0de0001-0001-4a1b-8c00-000000000001', '设计',     '04', 4,  NULL, 1, NOW(), NOW()),
    ('c0de0002-0001-4a1b-8c00-000000000005', 'c0de0001-0001-4a1b-8c00-000000000001', '产品',     '05', 5,  NULL, 1, NOW(), NOW()),
    ('c0de0002-0001-4a1b-8c00-000000000006', 'c0de0001-0001-4a1b-8c00-000000000001', '需求',     '06', 6,  NULL, 1, NOW(), NOW()),
    ('c0de0002-0001-4a1b-8c00-000000000007', 'c0de0001-0001-4a1b-8c00-000000000001', '数据分析', '07', 7,  NULL, 1, NOW(), NOW()),
    ('c0de0002-0001-4a1b-8c00-000000000008', 'c0de0001-0001-4a1b-8c00-000000000001', '科研',     '08', 8,  NULL, 1, NOW(), NOW()),
    ('c0de0002-0001-4a1b-8c00-000000000009', 'c0de0001-0001-4a1b-8c00-000000000001', '其它',     '99', 99, NULL, 1, NOW(), NOW())
ON DUPLICATE KEY UPDATE
    `dictId`    = VALUES(`dictId`),
    `itemKey`   = VALUES(`itemKey`),
    `itemValue` = VALUES(`itemValue`),
    `sortNo`    = VALUES(`sortNo`);
