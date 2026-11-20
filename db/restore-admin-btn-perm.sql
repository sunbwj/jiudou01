-- =====================================================================
-- 修复：把「系统管理员」角色的页面按钮授权补回全量（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 背景：server/test_api.py 的「角色权限」用例会调 POST /api/rolepower/clear
--       （该接口**同时**删菜单权限与按钮权限），早前版本只还原了菜单权限，
--       于是每跑一次接口回归，系统管理员的 usergrouppagebtnset 就被清空一次，
--       表现为：管理员登录后**全站所有操作按钮都不出现**（btnperm.js 对未授权按钮是隐藏）。
--       测试侧已修（先备份 buttons 再还原），本脚本负责把这批历史丢失的授权补回来。
-- 口径：系统管理员 = 全量按钮（与各模块 *-btn-perm.sql「默认给所有启用角色授权」一致）。
-- 特性：只补不改 —— 已存在的授权（含人工改成 enabled=0 的）一律不覆盖，可重复执行。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/restore-admin-btn-perm.sql
-- =====================================================================
SET NAMES utf8mb4;

INSERT INTO `usergrouppagebtnset` (`id`,`roleId`,`pageOpBtnId`,`enabled`,`remark`)
SELECT MD5(CONCAT(r.`id`,'-',b.`id`)), r.`id`, b.`id`, 1, '系统管理员全量按钮（历史丢失补回）'
FROM `usergroup` r
JOIN `pageopbtn` b ON b.`enabled`=1
WHERE r.`nameCn`='系统管理员' AND r.`enabled`=1
  AND NOT EXISTS (SELECT 1 FROM `usergrouppagebtnset` s
                  WHERE s.`roleId`=r.`id` AND s.`pageOpBtnId`=b.`id`);

-- 回显：三个角色各自的按钮授权数（系统管理员应 = 启用按钮总数）
SELECT g.`nameCn`, COUNT(s.`id`) AS `btnCount`
FROM `usergroup` g
LEFT JOIN `usergrouppagebtnset` s ON s.`roleId`=g.`id` AND s.`enabled`=1
GROUP BY g.`id`, g.`nameCn`
ORDER BY g.`sortNo`;

SELECT COUNT(*) AS `enabledBtnTotal` FROM `pageopbtn` WHERE `enabled`=1;
