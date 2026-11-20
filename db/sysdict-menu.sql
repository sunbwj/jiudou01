-- =====================================================================
-- 菜单数据：新增「系统配置」菜单组 + 系统字典 / 字典键值 / 系统参数 三个功能页
-- ---------------------------------------------------------------------
-- 说明：
--   · menuinfros        菜单项：MNU00018 / sysdict.html、MNU00019 / sysdict-item.html、
--                       MNU00020 / syspara.html
--   · menugroupinfos    菜单组：MNG1007「系统配置」（顶级，sortNo=70：排在项目管理 60 之后、
--                       人力资源中心 90 之前）
--   · menugroupitemset  绑定：系统配置 → 系统字典（1）、字典键值（2）、系统参数（3）
--   · usergrouppowerset 角色授权：系统管理员整组授权（menuItemId=0，后续组内新增页面自动可见）
--   · pageopbtn         页面操作按钮登记（与页面 .toolbar 里的按钮一一对应，
--                       也可在「页面操作按钮」管理页点「自动收录」重新扫描生成）
--   · 系统字典 / 明细 / 参数都是全局配置数据，不做「本人创建 OR 公用」可见性过滤，
--     所有已登录用户均可检索维护（与 project / dbinfo / report 的业务数据规则不同）。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < sysdict-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00018','系统字典','SysDict','sysdict.html','setting','18','1',
       '系统配置：字典键维护（键中文名 / 键英文名唯一 / 上级 / 显示序号 / 说明 / 启用否）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00018');

INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00019','字典键值','SysDictItems','sysdict-item.html','document','19','1',
       '系统配置：字典键值明细维护（所属字典 / 键 / 键值 / 显示序号 / 说明 / 启用否）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00019');

INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00020','系统参数','SysPara','syspara.html','tool','20','1',
       '系统配置：系统参数维护（参数中文名 / 参数英文名唯一 / 参数值 / 显示序号 / 说明 / 启用否）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00020');

-- 2) 菜单组：系统配置（顶级，排序号 70）
INSERT INTO `menugroupinfos` (`parentId`,`level`,`sortNo`,`code`,`nameCn`,`nameEn`,`hasChild`,`path`,`icon`,`enabled`)
SELECT 0,1,70,'MNG1007','系统配置','SystemConfig',1,'','setting',1
WHERE NOT EXISTS (SELECT 1 FROM `menugroupinfos` WHERE `code`='MNG1007');

-- 3) 绑定：系统配置 → 系统字典（1）、字典键值（2）、系统参数（3）
INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 1, 1, '系统配置'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00018'
WHERE g.`code`='MNG1007'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 2, 1, '系统配置'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00019'
WHERE g.`code`='MNG1007'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 3, 1, '系统配置'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00020'
WHERE g.`code`='MNG1007'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

-- 4) 角色授权：系统管理员（整组授权）
INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, g.`id`, 0, 1, '系统配置（整组授权）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1007'
WHERE r.`nameEn`='SystemAdmin'
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.`roleId`=r.`id` AND p.`menuGroupId`=g.`id` AND p.`menuItemId`=0
  );

-- 5) 页面操作按钮登记（三页共 20 个，与 .toolbar 顺序一致）
INSERT INTO `pageopbtn` (`id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo`,`enabled`,`remark`)
SELECT UUID(), b.pageName, b.pagePath, b.btnId, b.btnText, b.sortNo, 1, '系统配置'
FROM (
    SELECT '系统字典' AS pageName, 'sysdict.html' AS pagePath, 'btnAdd'      AS btnId, '新增字典'         AS btnText, 0 AS sortNo UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnEdit',    '编辑选中的字典', 1 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnEnable',  '启用选中的字典', 2 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnDisable', '停用选中的字典', 3 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnItems',   '维护键值',       4 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnDelete',  '删除选中的字典', 5 UNION ALL
    SELECT '系统字典',             'sysdict.html',       'btnRefresh', '刷新字典列表',   6 UNION ALL
    SELECT '字典键值',             'sysdict-item.html',  'btnAdd',     '新增键值',       0 UNION ALL
    SELECT '字典键值',             'sysdict-item.html',  'btnEdit',    '编辑选中的键值', 1 UNION ALL
    SELECT '字典键值',             'sysdict-item.html',  'btnEnable',  '启用选中的键值', 2 UNION ALL
    SELECT '字典键值',             'sysdict-item.html',  'btnDisable', '停用选中的键值', 3 UNION ALL
    SELECT '字典键值',             'sysdict-item.html',  'btnDelete',  '删除选中的键值', 4 UNION ALL
    SELECT '字典键值',             'sysdict-item.html',  'btnBack',    '返回字典',       5 UNION ALL
    SELECT '字典键值',             'sysdict-item.html',  'btnRefresh', '刷新键值列表',   6 UNION ALL
    SELECT '系统参数',             'syspara.html',       'btnAdd',     '新增参数',       0 UNION ALL
    SELECT '系统参数',             'syspara.html',       'btnEdit',    '编辑选中的参数', 1 UNION ALL
    SELECT '系统参数',             'syspara.html',       'btnEnable',  '启用选中的参数', 2 UNION ALL
    SELECT '系统参数',             'syspara.html',       'btnDisable', '停用选中的参数', 3 UNION ALL
    SELECT '系统参数',             'syspara.html',       'btnDelete',  '删除选中的参数', 4 UNION ALL
    SELECT '系统参数',             'syspara.html',       'btnRefresh', '刷新参数列表',   5
) b
WHERE NOT EXISTS (
    SELECT 1 FROM `pageopbtn` p WHERE p.`pagePath`=b.pagePath AND p.`btnId`=b.btnId
);

-- 6) 回显
SELECT `id`,`code`,`nameCn`,`path`,`icon`,`sortNo`,`enabled` FROM `menuinfros`
WHERE `code` IN ('MNU00018','MNU00019','MNU00020') ORDER BY `code`;
SELECT `id`,`code`,`nameCn`,`parentId`,`sortNo`,`hasChild`,`icon`,`enabled` FROM `menugroupinfos`
WHERE `code`='MNG1007';
SELECT s.`id`, s.`groupId`, s.`itemId`, s.`sortNo`, m.`nameCn`
FROM `menugroupitemset` s JOIN `menuinfros` m ON m.`id`=s.`itemId`
WHERE s.`groupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1007') ORDER BY s.`sortNo`;
SELECT `pagePath`,`btnId`,`btnText`,`sortNo` FROM `pageopbtn`
WHERE `pagePath` IN ('sysdict.html','sysdict-item.html','syspara.html') ORDER BY `pagePath`,`sortNo`;
