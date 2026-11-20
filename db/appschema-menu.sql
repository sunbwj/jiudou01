-- =====================================================================
-- 菜单数据：数据中心下新增「应用信息」「应用结构」两个功能页
-- ---------------------------------------------------------------------
-- 说明：
--   · menuinfros        菜单项：MNU00029 / appinfo.html（应用信息管理）
--                              MNU00030 / appschema.html（应用数据库结构管理）
--   · menugroupinfos    复用 MNG1005「数据中心」，不再新建菜单组
--   · menugroupitemset  绑定：数据中心 → 应用信息（组内排序 2）、应用结构（组内排序 3）
--   · usergrouppowerset 逐项补「系统管理员」的授权（本平台的菜单权限是**项级**记录，
--                       不是组级一行；只补不覆盖，人工调过的 enabled=0 保持不动）
--   · 其它角色（普通用户等）默认不给这两个菜单，需要时在「角色权限配置」里勾选
--   · 页面按钮（新增 / 编辑 / 删除 / 扫描导入 / 发布 / 对比 …）由「页面操作按钮」
--     的自动收录（pageopbtn scan）登记后，再在各角色的「角色权限配置」里勾选；
--     未授权时 btnperm.js 会把按钮隐藏，先收录 + 授权再验收页面。
-- 执行：cd /d/mysql/mysql_5_7_22_winx64/bin && ./mysql.exe -u sa -proger2019 \
--         --default-character-set=utf8mb4 rogerorm < appschema-menu.sql
-- 幂等：全部按 code / (groupId,itemId) 判重，可重复执行。
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项：应用信息 / 应用结构
INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00029','应用信息','AppInfo','appinfo.html','folder','4','1',
       '应用架构：应用信息维护 + 绑定数据库连接（一个应用一个连接）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00029');

INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00030','应用结构','AppSchema','appschema.html','tool','5','1',
       '应用架构：库/表/视图/存储过程/字段维护 + 扫描导入 + 版本脚本 + 与实库对比'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00030');

-- 2) 绑定到「数据中心」（MNG1005）
INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 2, 1, '数据中心'
FROM `menugroupinfos` g JOIN `menuinfros` m ON m.`code`='MNU00029'
WHERE g.`code`='MNG1005'
  AND NOT EXISTS (SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`);

INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 3, 1, '数据中心'
FROM `menugroupinfos` g JOIN `menuinfros` m ON m.`code`='MNU00030'
WHERE g.`code`='MNG1005'
  AND NOT EXISTS (SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`);

-- 3) 菜单组 hasChild 兜底（组内已有其它页面时一般已为 1）
UPDATE `menugroupinfos` SET `hasChild`=1 WHERE `code`='MNG1005';

-- 4) 授权：系统管理员可见这两个菜单（项级授权；已存在的记录一律不覆盖）
INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT MD5(CONCAT(r.`id`,'-',m.`id`)), r.`id`, g.`id`, m.`id`, 1, '数据中心·应用架构'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1005'
JOIN `menuinfros` m ON m.`code` IN ('MNU00029','MNU00030')
WHERE r.`nameCn`='系统管理员' AND r.`enabled`=1
  AND NOT EXISTS (SELECT 1 FROM `usergrouppowerset` s
                  WHERE s.`roleId`=r.`id` AND s.`menuItemId`=m.`id`);

-- 5) 回显
SELECT `id`,`code`,`nameCn`,`path`,`icon`,`sortNo`,`enabled` FROM `menuinfros`
 WHERE `code` IN ('MNU00029','MNU00030');
SELECT s.`sortNo`, m.`code`, m.`nameCn`, m.`path`
FROM `menugroupitemset` s
JOIN `menuinfros` m ON m.`id`=s.`itemId`
WHERE s.`groupId`=(SELECT `id` FROM `menugroupinfos` WHERE `code`='MNG1005')
ORDER BY s.`sortNo`;
