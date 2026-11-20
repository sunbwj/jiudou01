-- =====================================================================
-- 应用结构（appschema.html）：导出表结构文档按钮的文案 + 管理员授权
-- ---------------------------------------------------------------------
-- 背景：
--   「勾选表 → 导出 Excel / Word」的按钮是操作引导区里的**纯图标按钮**
--   （#asBtnExport，文案只在 title / aria-label），page_scan 收录时把整段 title
--   当成了按钮文案，权限页里会显示成一大段说明；这里统一改成「导出表结构」。
--
-- 口径：
--   · 该页按钮只授权给「系统管理员」（与 appinfo / appschema 其余按钮一致），
--     其它角色按需在「角色权限」里单独勾；
--   · 只补不改：已存在的授权（含人工停用的）一律不覆盖，脚本可重复执行。
--
-- 前置：先跑一次页面按钮收录（平台「页面操作按钮」页点扫描，或
--       POST /api/pageopbtn/scan），把 #asBtnExport 收进 pageopbtn。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < appschema-export-btn.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 按钮文案改中文（扫描器取的是 title 全文，权限页里太长）
UPDATE `pageopbtn` SET `btnText`='导出表结构'
 WHERE `pagePath`='appschema.html' AND `btnId`='asBtnExport';

-- 2) 系统管理员授权（已授权的跳过，可重复执行）
INSERT INTO `usergrouppagebtnset` (`id`,`roleId`,`pageOpBtnId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, b.`id`, 1, '应用结构 · 导出表结构'
FROM `usergroup` r
JOIN `pageopbtn` b ON b.`pagePath`='appschema.html' AND b.`btnId`='asBtnExport'
WHERE r.`nameEn`='SystemAdmin' AND r.`enabled`=1
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppagebtnset` p
      WHERE p.`roleId`=r.`id` AND p.`pageOpBtnId`=b.`id`);

-- 3) 回显：该页按钮总数 / 管理员已授权数（两者应相等）
SELECT COUNT(*) AS `pageBtnTotal` FROM `pageopbtn` WHERE `pagePath`='appschema.html' AND `enabled`=1;

SELECT COUNT(*) AS `adminGranted`
FROM `usergrouppagebtnset` s
JOIN `pageopbtn` b ON b.`id`=s.`pageOpBtnId`
JOIN `usergroup` g ON g.`id`=s.`roleId`
WHERE b.`pagePath`='appschema.html' AND g.`nameEn`='SystemAdmin' AND s.`enabled`=1;
