-- ============================================================================
-- 数据中心：把「数据库连接」改名为「数据库」（纯文案，不动结构）
-- ----------------------------------------------------------------------------
-- 涉及的展示名：
--   · menuinfros   MNU00013 菜单项名称（左侧导航 / 面包屑 / 首页卡片）
--   · pageopbtn    dbinfo.html 下所有按钮的 pageName（页面操作按钮 / 角色权限页显示）
-- 执行：mysql -u sa -p rogerorm < db/dbinfo-rename.sql
--       本项目实际执行命令（客户端不在 PATH）：
--       cd /d/mysql/mysql_5_7_22_winx64/bin && ./mysql.exe -u sa -proger2019 \
--         --default-character-set=utf8mb4 rogerorm < db/dbinfo-rename.sql
-- ============================================================================

-- 1) 菜单项：数据库连接 → 数据库
UPDATE `menuinfros`
   SET `nameCn` = '数据库',
       `remark` = '数据中心：数据库信息维护 + 实例/表/视图/字段扫描 + SQL 查询'
 WHERE `code` = 'MNU00013';

-- 2) 页面操作按钮的页面名同步（页面操作按钮页 / 角色权限页按 pageName 展示）
UPDATE `pageopbtn`
   SET `pageName` = '数据库'
 WHERE `pagePath` = 'dbinfo.html';

-- 3) 核对
SELECT `code`, `nameCn`, `path` FROM `menuinfros` WHERE `code` = 'MNU00013';
SELECT DISTINCT `pageName`, `pagePath` FROM `pageopbtn` WHERE `pagePath` = 'dbinfo.html';
