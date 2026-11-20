-- =====================================================================
-- 菜单数据：项目中心下新增「工作量统计」（workload-report.html）
-- ---------------------------------------------------------------------
--   · menuinfros        MNU00028 / workload-report.html
--   · menugroupitemset  挂到 MNG1006「项目中心」第 21 位（需求管理之后）
--   · usergrouppowerset 默认给**所有启用角色**授权
-- 说明：
--   · 可重复执行（全部带 NOT EXISTS），不改 / 不删任何已有菜单与授权；
--   · 这是给管理者看的产能报表，可见人群由「角色授权」控制：默认全员可见，
--     要收窄就到「角色权限」页取消勾选（不用改数据）；
--   · 页面按钮（刷新 / 导出 / 仅看我的）在 db/workload-btn-perm.sql 里登记授权。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/workload-menu.sql
-- =====================================================================
SET NAMES utf8mb4;

INSERT INTO `menuinfros` (`code`,`nameCn`,`nameEn`,`path`,`icon`,`sortNo`,`enabled`,`remark`)
SELECT 'MNU00028','工作量统计','WorkloadReport','workload-report.html','chart','21','1',
       '项目中心：员工工作量统计（按派单时间统计接单数 / 完成率 / 逾期，支持钻取到工单）'
WHERE NOT EXISTS (SELECT 1 FROM `menuinfros` WHERE `code`='MNU00028');

INSERT INTO `menugroupitemset` (`groupId`,`itemId`,`sortNo`,`enabled`,`remark`)
SELECT g.`id`, m.`id`, 21, 1, '项目中心'
FROM `menugroupinfos` g
JOIN `menuinfros` m ON m.`code`='MNU00028'
WHERE g.`code`='MNG1006'
  AND NOT EXISTS (SELECT 1 FROM `menugroupitemset` s WHERE s.`groupId`=g.`id` AND s.`itemId`=m.`id`);

INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
-- 主键用 MD5(角色+组+菜单项)：既可重复执行，又避免 INSERT..SELECT 里 UUID() 只求值一次的坑
SELECT MD5(CONCAT(r.`id`,'-',g.`id`,'-',m.`id`)), r.`id`, g.`id`, m.`id`, 1, '工作量统计（默认授权）'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code`='MNG1006'
JOIN `menuinfros` m ON m.`code`='MNU00028'
WHERE r.`enabled`=1
  AND NOT EXISTS (SELECT 1 FROM `usergrouppowerset` p
                  WHERE p.`roleId`=r.`id` AND p.`menuGroupId`=g.`id` AND p.`menuItemId`=m.`id`);

-- 回显：菜单项 + 挂在哪个组 + 授权角色数
SELECT m.`code`, m.`nameCn`, m.`path`, s.`sortNo`,
       (SELECT COUNT(*) FROM `usergrouppowerset` p WHERE p.`menuItemId`=m.`id`) AS `roleCount`
FROM `menuinfros` m
LEFT JOIN `menugroupitemset` s ON s.`itemId`=m.`id`
WHERE m.`code`='MNU00028';
