-- =====================================================================
-- 报表设计器（report-designer.html）：按钮文案 + 管理员按钮授权
-- ---------------------------------------------------------------------
-- 说明：
--   · 页面的 6 个操作按钮在「操作引导区」（.toolbar）里，是纯图标按钮，
--     文案放在 title / aria-label 上。扫描器按 title 兜底取文案后，
--     这里把已收录的记录统一成中文，权限页里更好认；
--   · 给系统管理员（SystemAdmin）授权这 6 个按钮，开箱即可用；
--   · 页面里的「保存 / 预览 / 另存为 / 清空」属于基础操作，不在 toolbar 内，不参与按钮权限。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < report-buttons.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 已收录的按钮改中文文案（扫描器取不到文字时用 title）
UPDATE `pageopbtn` SET `btnText`='新建报表'     WHERE `pagePath`='report-designer.html' AND `btnId`='btnNew';
UPDATE `pageopbtn` SET `btnText`='复制报表'     WHERE `pagePath`='report-designer.html' AND `btnId`='btnCopy';
UPDATE `pageopbtn` SET `btnText`='启用报表'     WHERE `pagePath`='report-designer.html' AND `btnId`='btnEnable';
UPDATE `pageopbtn` SET `btnText`='停用报表'     WHERE `pagePath`='report-designer.html' AND `btnId`='btnDisable';
UPDATE `pageopbtn` SET `btnText`='删除报表'     WHERE `pagePath`='report-designer.html' AND `btnId`='btnDelete';
UPDATE `pageopbtn` SET `btnText`='刷新报表清单' WHERE `pagePath`='report-designer.html' AND `btnId`='btnRefresh';

-- 2) 系统管理员授权这 6 个按钮（已授权的跳过）
INSERT INTO `usergrouppagebtnset` (`id`,`roleId`,`pageOpBtnId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, b.`id`, 1, '报表设计'
FROM `usergroup` r
JOIN `pageopbtn` b ON b.`pagePath`='report-designer.html'
WHERE r.`nameEn`='SystemAdmin'
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppagebtnset` p
      WHERE p.`roleId`=r.`id` AND p.`pageOpBtnId`=b.`id`
  );

-- 3) 回显
SELECT `btnId`,`btnText`,`sortNo`,`enabled` FROM `pageopbtn`
WHERE `pagePath`='report-designer.html' ORDER BY `sortNo`;
SELECT r.`nameEn`, COUNT(*) AS n
FROM `usergrouppagebtnset` p
JOIN `usergroup` r ON r.`id`=p.`roleId`
JOIN `pageopbtn` b ON b.`id`=p.`pageOpBtnId`
WHERE b.`pagePath`='report-designer.html'
GROUP BY r.`nameEn`;
