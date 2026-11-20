-- =====================================================================
-- 菜单数据：新增「项目管理」菜单组 + 「项目信息」/「项目文件」两个功能页
-- ---------------------------------------------------------------------
-- 说明：
--   · menuinfros        菜单项：MNU00016 / project.html、MNU00017 / project-file.html
--   · menugroupinfos    菜单组：MNG1006「项目管理」（顶级，sortNo=60：排在数据中心之后、人力资源中心之前）
--   · menugroupitemset  绑定：项目管理 → 项目信息（1）、项目文件（2）
--   · usergrouppowerset 角色授权：系统管理员整组授权（menuItemId=0，后续组内新增页面自动可见）
--   · pageopbtn         页面操作按钮登记（与页面 .toolbar 里的按钮一一对应，
--                       也可在「页面操作按钮」管理页点「自动收录」重新扫描生成）
--   · 检索可见性由后端 service 保证：project / projectfile 的列表、详情、下拉、下载
--     统一按「本人创建 OR ispub=1」过滤（见 ProjectBaseService._visibility_where）
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < project-menu.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项：项目信息 / 项目文件
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00016','项目信息','ProjectInfos','project.html','folder','16','1',
       '项目管理：项目台账（PRO+6位流水编号 / 类型 / 状态 / 公用否 / 启用否）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00016');

INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00017','项目文件','ProjectFiles','project-file.html','document','17','1',
       '项目管理：项目文件上传 / 下载 / 说明 / 公用否 / 启用否'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00017');

-- 2) 菜单组：项目管理（顶级，排序号 60）
INSERT INTO `menugroupinfos` (`parentId`,`level`,`sortNo`,`code`,`nameCn`,`nameEn`,`hasChild`,`path`,`icon`,`enabled`)
SELECT 0,1,60,'MNG1006','项目管理','ProjectCenter',1,'','folder',1
WHERE NOT EXISTS (SELECT 1 FROM `menugroupinfos` WHERE `code`='MNG1006');

-- 3) 绑定：项目管理 → 项目信息（1）、项目文件（2）
INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 1, 1, '项目管理'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00016'
WHERE g.`code`='MNG1006'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 2, 1, '项目管理'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00017'
WHERE g.`code`='MNG1006'
  AND NOT EXISTS (
      SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`
  );

-- 4) 角色授权：系统管理员（整组授权）
INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, g.`id`, 0, 1, '项目管理（整组授权）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1006'
WHERE r.`nameEn`='SystemAdmin'
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.`roleId`=r.`id` AND p.`menuGroupId`=g.`id` AND p.`menuItemId`=0
  );

-- 5) 页面操作按钮登记（两页各 8 个，与 .toolbar 顺序一致）
INSERT INTO `pageopbtn` (`id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo`,`enabled`,`remark`)
SELECT UUID(), b.pageName, b.pagePath, b.btnId, b.btnText, b.sortNo, 1, '项目管理'
FROM (
    SELECT '项目信息' AS pageName, 'project.html' AS pagePath, 'btnAdd'     AS btnId, '新增项目'       AS btnText, 0 AS sortNo UNION ALL
    SELECT '项目信息',             'project.html',       'btnEdit',    '编辑选中的项目', 1 UNION ALL
    SELECT '项目信息',             'project.html',       'btnEnable',  '启用选中的项目', 2 UNION ALL
    SELECT '项目信息',             'project.html',       'btnDisable', '停用选中的项目', 3 UNION ALL
    SELECT '项目信息',             'project.html',       'btnFiles',   '查看项目文件',   4 UNION ALL
    SELECT '项目信息',             'project.html',       'btnDelete',  '删除选中的项目', 5 UNION ALL
    SELECT '项目信息',             'project.html',       'btnRefresh', '刷新项目列表',   6 UNION ALL
    SELECT '项目文件',             'project-file.html',  'btnAdd',     '上传项目文件',   0 UNION ALL
    SELECT '项目文件',             'project-file.html',  'btnEdit',    '编辑选中的文件', 1 UNION ALL
    SELECT '项目文件',             'project-file.html',  'btnDownload','下载选中的文件', 2 UNION ALL
    SELECT '项目文件',             'project-file.html',  'btnEnable',  '启用选中的文件', 3 UNION ALL
    SELECT '项目文件',             'project-file.html',  'btnDisable', '停用选中的文件', 4 UNION ALL
    SELECT '项目文件',             'project-file.html',  'btnDelete',  '删除选中的文件', 5 UNION ALL
    SELECT '项目文件',             'project-file.html',  'btnRefresh', '刷新文件列表',   6
) b
WHERE NOT EXISTS (
    SELECT 1 FROM `pageopbtn` p WHERE p.`pagePath`=b.pagePath AND p.`btnId`=b.btnId
);

-- 6) 回显
SELECT `id`,`code`,`nameCn`,`path`,`icon`,`sortNo`,`enabled` FROM `menuinfros`
WHERE `code` IN ('MNU00016','MNU00017') ORDER BY `code`;
SELECT `id`,`code`,`nameCn`,`parentId`,`sortNo`,`hasChild`,`icon`,`enabled` FROM `menugroupinfos`
WHERE `code`='MNG1006';
SELECT s.`id`, s.`groupId`, s.`itemId`, s.`sortNo`, m.`nameCn`
FROM `menugroupitemset` s JOIN `menuinfros` m ON m.`id`=s.`itemId`
WHERE s.`groupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1006') ORDER BY s.`sortNo`;
SELECT `pagePath`,`btnId`,`btnText`,`sortNo` FROM `pageopbtn`
WHERE `pagePath` IN ('project.html','project-file.html') ORDER BY `pagePath`,`sortNo`;
