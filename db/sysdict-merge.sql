-- =====================================================================
-- 系统字典改版：字典键值并入系统字典页（左右分栏）
-- ---------------------------------------------------------------------
-- 变更内容：
--   1. menuinfros：MNU00019「字典键值」停用（enabled=0）——
--      build_nav 只取 enabled=1，因此它会自动从左侧导航消失；
--      页面 sysdict-item.html 仍保留，可直达访问（兼容旧链接 / 书签）。
--   2. menugroupitemset：「系统配置 → 字典键值」的绑定同步停用，
--      避免菜单组项目设置页里还显示一条指向停用菜单项的绑定。
--   3. pageopbtn：sysdict.html 的按钮重登为左右双区的 12 个图标按钮
--      （左区 6 个 + 右区 6 个）；旧的 btnItems「维护键值」已随改版移除。
--      · 已存在的按钮只更新文案 / 顺序，**保留人工停用状态**（不覆盖 enabled）；
--       · 新增按钮默认启用。
--   执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < sysdict-merge.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项停用（字典键值页不再作为独立入口）
UPDATE `menuinfros`
SET `enabled` = 0,
    `remark`  = '系统配置：字典键值，已并入「系统字典」页右区（双击字典维护键值），此菜单项停用'
WHERE `code` = 'MNU00019';

-- 2) 菜单组绑定同步停用
UPDATE `menugroupitemset`
SET `enabled` = 0
WHERE `itemId` = (SELECT `id` FROM `menuinfros` WHERE `code` = 'MNU00019');

-- 3) 页面按钮：移除已删除的「维护键值」，其余按新页面重登
DELETE FROM `pageopbtn`
WHERE `pagePath` = 'sysdict.html' AND `btnId` = 'btnItems';

INSERT INTO `pageopbtn` (`id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo`,`enabled`,`remark`)
SELECT UUID(), b.pageName, b.pagePath, b.btnId, b.btnText, b.sortNo, 1, '系统配置（左右分栏）'
FROM (
    SELECT '系统字典' AS pageName, 'sysdict.html' AS pagePath, 'btnAdd'         AS btnId, '新增字典'         AS btnText, 0 AS sortNo UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnEdit',       '编辑选中的字典', 1 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnEnable',     '启用选中的字典', 2 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnDisable',    '停用选中的字典', 3 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnDelete',     '删除选中的字典', 4 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnRefresh',    '刷新字典列表',   5 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnItemAdd',    '新增键值',       6 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnItemEdit',   '编辑选中的键值', 7 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnItemEnable', '启用选中的键值', 8 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnItemDisable','停用选中的键值', 9 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnItemDelete', '删除选中的键值', 10 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnItemRefresh','刷新键值列表',   11
) b
ON DUPLICATE KEY UPDATE
    `pageName` = VALUES(`pageName`),
    `btnText`  = VALUES(`btnText`),
    `sortNo`   = VALUES(`sortNo`);

-- 4) 回显
SELECT `code`,`nameCn`,`path`,`sortNo`,`enabled` FROM `menuinfros`
WHERE `code` IN ('MNU00018','MNU00019','MNU00020') ORDER BY `code`;

SELECT m.`code`, m.`nameCn`, s.`sortNo`, s.`enabled` AS bindEnabled
FROM `menugroupitemset` s JOIN `menuinfros` m ON m.`id` = s.`itemId`
WHERE s.`groupId` = (SELECT `id` FROM `menugroupinfos` WHERE `code` = 'MNG1007')
ORDER BY s.`sortNo`;

SELECT `pagePath`,`btnId`,`btnText`,`sortNo`,`enabled` FROM `pageopbtn`
WHERE `pagePath` = 'sysdict.html' ORDER BY `sortNo`;
