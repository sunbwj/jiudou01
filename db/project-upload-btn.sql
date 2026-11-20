-- =====================================================================
-- 项目信息页新增「上传文件」按钮登记（2026-11-05）
-- ---------------------------------------------------------------------
-- 背景：项目信息页改为左右分栏（左 70% 项目列表 / 右 30% 文件列表），
--   工具栏新增 btnUpload「上传文件」：选中某行项目后点击，弹出项目文件上传弹窗，
--   上传成功后刷新左列表文件数与右栏文件列表。
-- 说明：
--   · 按钮插在「查看文件」(sortNo=4) 与「删除」(原 5) 之间 → 原删除/刷新顺延为 6/7；
--   · 只登记 pageopbtn，不动菜单与授权（页面本身已在 MNG1006 整组授权内）。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < project-upload-btn.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 顺延「删除」「刷新」的排序号，给「上传文件」腾位置
UPDATE `pageopbtn` SET `sortNo`=6
WHERE `pagePath`='project.html' AND `btnId`='btnDelete' AND `sortNo`=5;
UPDATE `pageopbtn` SET `sortNo`=7
WHERE `pagePath`='project.html' AND `btnId`='btnRefresh' AND `sortNo`=6;

-- 2) 登记「上传文件」按钮
INSERT INTO `pageopbtn` (`id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo`,`enabled`,`remark`)
SELECT UUID(), '项目信息', 'project.html', 'btnUpload', '上传项目文件', 5, 1,
       '项目管理：选中项目后弹出上传弹窗，文件挂到该项目下（左右分栏右栏配套）'
WHERE NOT EXISTS (
    SELECT 1 FROM `pageopbtn` WHERE `pagePath`='project.html' AND `btnId`='btnUpload'
);

-- 3) 回显
SELECT `pagePath`,`btnId`,`btnText`,`sortNo`,`enabled` FROM `pageopbtn`
WHERE `pagePath`='project.html' ORDER BY `sortNo`;
