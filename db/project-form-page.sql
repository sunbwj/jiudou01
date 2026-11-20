-- =====================================================================
-- 项目管理：项目维护页 project-form.html（打页模式）按钮登记
-- ---------------------------------------------------------------------
-- 新增 / 编辑项目不再弹窗，改为独立页 project-form.html?mode=add|edit，
-- 该页不作为菜单项（由 project.html 打页进入），只在 pageopbtn 里登记按钮，
-- 供角色权限按页面 + 按钮授权。
-- 4 个按钮：保存项目 / 返回列表（.form-actions，可被 scan 自动收录）、
--           导入 Word / 查看源码（编辑区头部）。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < project-form-page.sql
-- =====================================================================

SET NAMES utf8mb4;

INSERT INTO `pageopbtn` (`id`,`pageName`,`pagePath`,`btnId`,`btnText`,`sortNo`,`enabled`,`remark`)
SELECT UUID(), b.pageName, b.pagePath, b.btnId, b.btnText, b.sortNo, 1, '项目管理/项目维护页'
FROM (
    SELECT '项目维护' AS pageName, 'project-form.html' AS pagePath, 'btnSave'         AS btnId, '保存项目'      AS btnText, 0 AS sortNo UNION ALL
    SELECT '项目维护',             'project-form.html',       'btnBack',         '返回列表',     1 UNION ALL
    SELECT '项目维护',             'project-form.html',       'btnImportWord',   '导入 Word',    2 UNION ALL
    SELECT '项目维护',             'project-form.html',       'btnToggleSource', '查看源码',     3
) b
WHERE NOT EXISTS (
    SELECT 1 FROM `pageopbtn` p WHERE p.`pagePath`=b.pagePath AND p.`btnId`=b.btnId
);

-- 回显
SELECT `pagePath`,`btnId`,`btnText`,`sortNo` FROM `pageopbtn`
WHERE `pagePath`='project-form.html' ORDER BY `sortNo`;
