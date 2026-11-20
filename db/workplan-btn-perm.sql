-- =====================================================================
-- 工作计划三页「操作引导区」按钮权限初始化（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 背景：workplan.html / workplan-design.html / workplan-task.html 的操作区
--       统一改成标准 .toolbar，纳入 page_scan.py 自动收录；
--       本脚本一次性补齐「按钮登记 + 角色授权」，避免收录后所有角色
--       突然看不到按钮（btnperm.js 对未授权按钮是直接隐藏）。
--   · 按钮清单由 server/page_scan.py 扫描三页生成（纯图标按钮取 title 作 btnText）；
--   · 默认给所有启用角色授权，等价于收录前「人人可见」的现状；
--     之后到「角色权限」页按需取消勾选即可收窄权限；
--   · 只新增、不覆盖：已存在的 pageopbtn 记录（含停用 / 人工改过文案）不动，
--     已有的授权记录（含 enabled=0 的主动取消）也不动。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/workplan-btn-perm.sql
-- 可重复执行：重复执行时两步均 0 行新增。
-- =====================================================================
SET NAMES utf8mb4;

INSERT IGNORE INTO `pageopbtn`
  (`id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo`,`enabled`,`remark`)
SELECT UUID(), s.`pageName`, s.`pagePath`, s.`btnId`, s.`btnText`, s.`sortNo`, 1, NULL FROM (
SELECT '计划管理' AS `pageName`, 'workplan.html' AS `pagePath`, 'wpBtnAdd' AS `btnId`, '新建工作计划' AS `btnText`, 0 AS `sortNo`
UNION ALL SELECT '计划管理' AS `pageName`, 'workplan.html' AS `pagePath`, 'wpBtnOpen' AS `btnId`, '工作计划（维护任务）' AS `btnText`, 1 AS `sortNo`
UNION ALL SELECT '计划管理' AS `pageName`, 'workplan.html' AS `pagePath`, 'wpBtnStart' AS `btnId`, '启动计划（派发工单并通知责任人与参与人员）' AS `btnText`, 2 AS `sortNo`
UNION ALL SELECT '计划管理' AS `pageName`, 'workplan.html' AS `pagePath`, 'wpBtnMyTask' AS `btnId`, '我的任务' AS `btnText`, 3 AS `sortNo`
UNION ALL SELECT '计划管理' AS `pageName`, 'workplan.html' AS `pagePath`, 'wpBtnDelete' AS `btnId`, '删除工作计划' AS `btnText`, 4 AS `sortNo`
UNION ALL SELECT '计划管理' AS `pageName`, 'workplan.html' AS `pagePath`, 'wpBtnRefresh' AS `btnId`, '刷新' AS `btnText`, 5 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnSave' AS `btnId`, '保存工作计划' AS `btnText`, 0 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnTask' AS `btnId`, '新增任务' AS `btnText`, 1 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnMilestone' AS `btnId`, '新增里程碑（工期 0 天）' AS `btnText`, 2 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnSummary' AS `btnId`, '新增摘要任务（分组汇总）' AS `btnText`, 3 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnProp' AS `btnId`, '任务属性（执行记录 / 责任人与参与人员）' AS `btnText`, 4 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnLink' AS `btnId`, '前置依赖（设置前置任务）' AS `btnText`, 5 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnIndent' AS `btnId`, '缩进（降一级，成为上一条的子任务）' AS `btnText`, 6 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnOutdent' AS `btnId`, '升级（升一级，提升缩进层级）' AS `btnText`, 7 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnUp' AS `btnId`, '上移任务' AS `btnText`, 8 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnDown' AS `btnId`, '下移任务' AS `btnText`, 9 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnDelete' AS `btnId`, '删除任务' AS `btnText`, 10 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnStart' AS `btnId`, '启动计划（派发工单并通知责任人与参与人员）' AS `btnText`, 11 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnMyTask' AS `btnId`, '我的任务' AS `btnText`, 12 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnPrint' AS `btnId`, '打印 / 导出' AS `btnText`, 13 AS `sortNo`
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnBack' AS `btnId`, '返回列表' AS `btnText`, 14 AS `sortNo`
-- 「从 Excel 导入任务」（2026-11-12 新增）：页面上紧跟「新增摘要任务」，
-- 脚本里的 sortNo 只是新库首次插入时的占位；真实顺序以 server/page_scan.py 扫描回写的为准
-- （本库已回写为 7）。中间插号会让已上线的库与脚本里的序号对不上（本脚本只在缺失时新增）。
UNION ALL SELECT '工作计划' AS `pageName`, 'workplan-design.html' AS `pagePath`, 'wpDBtnImport' AS `btnId`, '从 Excel 导入任务（责任人 / 参与人员写「工号 姓名」）' AS `btnText`, 15 AS `sortNo`
UNION ALL SELECT '我的任务' AS `pageName`, 'workplan-task.html' AS `pagePath`, 'wtBtnRefresh' AS `btnId`, '刷新' AS `btnText`, 0 AS `sortNo`
UNION ALL SELECT '我的任务' AS `pageName`, 'workplan-task.html' AS `pagePath`, 'wtBtnOpenTask' AS `btnId`, '打开任务（跳到工作计划并定位该任务）' AS `btnText`, 1 AS `sortNo`
UNION ALL SELECT '我的任务' AS `pageName`, 'workplan-task.html' AS `pagePath`, 'wtBtnExec' AS `btnId`, '执行记录（回填完成状态 / 实际起止 / 说明）' AS `btnText`, 2 AS `sortNo`
UNION ALL SELECT '我的任务' AS `pageName`, 'workplan-task.html' AS `pagePath`, 'wtBtnGoPlan' AS `btnId`, '去计划管理（返回计划列表）' AS `btnText`, 3 AS `sortNo`
) s;

INSERT INTO `usergrouppagebtnset`
  (`id`,`roleId`,`pageOpBtnId`,`enabled`,`remark`)
-- 主键用 MD5(角色+按钮) 而不是 UUID()：INSERT ... SELECT 里 UUID() 有被优化成只求值一次的坑
-- （help-menu.sql 实测撞过 1062），MD5 既确定又天然幂等。
SELECT MD5(CONCAT(r.`id`, '-', b.`id`)), r.`id`, b.`id`, 1,
       '工作计划三页按钮默认授权（可在角色权限页调整）'
FROM `usergroup` r
JOIN `pageopbtn` b
  ON b.`pagePath` IN ('workplan.html','workplan-design.html','workplan-task.html')
 AND b.`enabled` = 1
WHERE r.`enabled` = 1
  AND NOT EXISTS (SELECT 1 FROM `usergrouppagebtnset` s
                  WHERE s.`roleId` = r.`id` AND s.`pageOpBtnId` = b.`id`);

-- 核对：三页按钮数 = 30（计划管理 8 + 工作计划 18 + 我的任务 4）＝ 下面各页 COUNT；
--       授权数 = 30 × 启用角色数。
--       ⚠ 本脚本显式列了 26 条；另 4 条（workplan.html 的 wpBtnStop / wpBtnOrders、
--       workplan-design.html 的 wpDBtnStop / wpDBtnLog）由「页面操作按钮」页点「扫描」收录并自动登记，
--       收录后请到「角色权限」页补勾选，否则未授权角色看不到这些按钮（btnperm.js 直接隐藏）。
SELECT b.`pagePath`, COUNT(*) AS `btnCount`
FROM `pageopbtn` b
WHERE b.`pagePath` IN ('workplan.html','workplan-design.html','workplan-task.html')
GROUP BY b.`pagePath`;
