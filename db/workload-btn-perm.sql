-- =====================================================================
-- 工作量统计页「操作引导区」按钮权限（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 背景：workload-report.html 的操作区是标准 .toolbar，会被 server/page_scan.py
--       收录进 pageopbtn；btnperm.js 对**未授权**按钮是直接隐藏，
--       所以新页上线前必须把「登记 + 授权」补齐，否则除管理员外谁都看不到按钮。
--   · 只有 3 个纯图标按钮，btnText 取 title（page_scan 同口径）；
--   · 默认给所有启用角色授权（与 workplan-btn-perm.sql 一致，等价于「人人可见」的现状）；
--     之后到「角色权限」页按需取消勾选即可收窄；
--   · 只新增、不覆盖：已有记录（含停用 / 人工改过文案）与已有授权（含 enabled=0）都不动。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/workload-btn-perm.sql
-- 可重复执行：两步均 0 行新增。
-- =====================================================================
SET NAMES utf8mb4;

INSERT IGNORE INTO `pageopbtn`
  (`id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo`,`enabled`,`remark`)
SELECT UUID(), s.`pageName`, s.`pagePath`, s.`btnId`, s.`btnText`, s.`sortNo`, 1, '工作量统计页'
FROM (
SELECT '工作量统计' AS `pageName`, 'workload-report.html' AS `pagePath`,
       'wlBtnRefresh' AS `btnId`, '刷新统计' AS `btnText`, 0 AS `sortNo`
UNION ALL SELECT '工作量统计', 'workload-report.html', 'wlBtnExport', '导出 Excel（员工汇总 + 工单明细）', 1
UNION ALL SELECT '工作量统计', 'workload-report.html', 'wlBtnMine', '仅看我的派单（切换）', 2
) s;

INSERT INTO `usergrouppagebtnset` (`id`,`roleId`,`pageOpBtnId`,`enabled`,`remark`)
SELECT MD5(CONCAT(r.`id`,'-',b.`id`)), r.`id`, b.`id`, 1, '工作量统计按钮默认授权（可在角色权限页调整）'
FROM `usergroup` r
JOIN `pageopbtn` b ON b.`pagePath`='workload-report.html' AND b.`enabled`=1
WHERE r.`enabled`=1
  AND NOT EXISTS (SELECT 1 FROM `usergrouppagebtnset` s
                  WHERE s.`roleId`=r.`id` AND s.`pageOpBtnId`=b.`id`);

-- 核对：按钮数应为 3，授权数 = 3 × 启用角色数
SELECT b.`btnId`, b.`btnText`, b.`sortNo`,
       (SELECT COUNT(*) FROM `usergrouppagebtnset` s WHERE s.`pageOpBtnId`=b.`id`) AS `roleCount`
FROM `pageopbtn` b
WHERE b.`pagePath`='workload-report.html'
ORDER BY b.`sortNo`;
