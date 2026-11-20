-- =====================================================================
-- 数据修复：清理角色权限测试（test_api 8i / 8k）留下的多余菜单授权
-- ---------------------------------------------------------------------
-- 背景：那两个用例会把「整组授权（menuItemId=0）」展开写入，早期版本的还原逻辑用权限树的
-- checked 反推原始授权（树里看不到整组授权，展开出来的菜单项被当成原始项写回），
-- 结果越跑越偏：普通用户 / 业务管理员多出了「数据中心 → 数据库 / 报表设计」的授权，
-- 业务管理员原有的「帮助中心 → 修改密码」还被覆盖掉了。
-- 脚本已同步修好（原始授权改从 /api/rolepower/list 的真实记录读取），这里只把数据恢复回去：
--   · 普通用户 / 业务管理员：删掉数据中心（MNG1005）下的授权
--   · 业务管理员：补回「帮助中心 → 修改密码」（与普通用户 / front 一致）
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < report-fix-rolepower.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 删掉测试造出来的数据中心授权
DELETE p FROM `usergrouppowerset` p
JOIN `usergroup` r ON r.`id` = p.`roleId`
JOIN `menugroupinfos` g ON g.`id` = p.`menuGroupId`
WHERE r.`nameEn` IN ('NormalUser', 'BusinessAdmin')
  AND g.`code` = 'MNG1005';

-- 2) 业务管理员补回「帮助中心 → 修改密码」
INSERT INTO `usergrouppowerset` (`id`,`roleId`,`menuGroupId`,`menuItemId`,`enabled`,`remark`)
SELECT UUID(), r.`id`, g.`id`, m.`id`, 1, '恢复：帮助中心'
FROM `usergroup` r
JOIN `menugroupinfos` g ON g.`code` = 'MNG1000'
JOIN `menuinfros` m ON m.`path` = 'edituserpwd.html'
WHERE r.`nameEn` = 'BusinessAdmin'
  AND NOT EXISTS (
      SELECT 1 FROM `usergrouppowerset` p
      WHERE p.`roleId` = r.`id` AND p.`menuGroupId` = g.`id` AND p.`menuItemId` = m.`id`
  );

-- 3) 回显：各角色当前可见的菜单项
SELECT r.`nameEn` AS role, g.`nameCn` AS grp, m.`nameCn` AS item
FROM `usergrouppowerset` p
JOIN `usergroup` r ON r.`id` = p.`roleId`
JOIN `menugroupinfos` g ON g.`id` = p.`menuGroupId`
LEFT JOIN `menuinfros` m ON m.`id` = p.`menuItemId`
WHERE p.`enabled` = 1
ORDER BY r.`nameEn`, g.`sortNo`, p.`menuItemId`;
