-- =====================================================================
-- 表：角色权限 usergrouppowerset（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 说明：
--   · id：权限ID，UUID 主键（MySQL 5.7 无原生 UUID 类型，用 CHAR(36) 存标准
--         36 位带连字符的 UUID 字符串），非自增，由服务端 uuid4() 生成；
--   · roleId：角色ID，指向 usergroup.id（同样是 UUID / CHAR(36)）；
--   · menuGroupId：菜单组ID，指向 menugroupinfos.id；
--   · menuItemId：菜单项ID，指向 menuinfros.id；0 表示「整组授权」，
--         保存时由服务端展开为该组已绑定的全部菜单项；
--   · enabled：授权是否启用（1-启用，0-停用；停用的记录保留但不参与鉴权）；
--   · remark：备注（选填）。
--   一行 = 一个角色 对 某个菜单组下某个菜单项 的授权。
--   唯一键 uk_power_role_group_item(roleId, menuGroupId, menuItemId) 防止重复授权。
-- 前端页面：role-power.html（先选角色，再在权限树里勾选菜单组 / 菜单项后保存）
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < usergrouppowerset.sql
-- 重复执行会报表已存在 / 唯一键冲突，可视为已初始化完成。
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `usergrouppowerset` (
  `id`          CHAR(36)     NOT NULL                          COMMENT '权限ID（UUID 主键，非自增）',
  `roleId`      CHAR(36)     NOT NULL                          COMMENT '角色ID（usergroup.id）',
  `menuGroupId` INT          NOT NULL                          COMMENT '菜单组ID（menugroupinfos.id）',
  `menuItemId`  INT          NOT NULL DEFAULT 0                COMMENT '菜单项ID（menuinfros.id，0=整组授权）',
  `enabled`     TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '授权是否启用：1-启用，0-停用',
  `remark`      VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createTime`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_power_role_group_item` (`roleId`, `menuGroupId`, `menuItemId`),
  KEY `idx_power_role`  (`roleId`),
  KEY `idx_power_group` (`menuGroupId`),
  KEY `idx_power_item`  (`menuItemId`),
  KEY `idx_power_enabled` (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '角色权限表（角色 ↔ 菜单组 / 菜单项，UUID 主键）';

-- ---------------------------------------------------------------------
-- 初始示例授权（按库里现有菜单组绑定关系生成，便于演示权限树效果）
-- ---------------------------------------------------------------------
-- 1) 系统管理员：全部启用菜单组的全部菜单项
INSERT INTO `usergrouppowerset` (`id`, `roleId`, `menuGroupId`, `menuItemId`, `enabled`)
SELECT UUID(), 'a1b2c3d4-0001-4a1b-8c00-000000000001', s.`groupId`, s.`itemId`, 1
FROM `menugroupitemset` s
INNER JOIN `menugroupinfos` g ON g.`id` = s.`groupId` AND g.`enabled` = 1
INNER JOIN `menuinfros` m ON m.`id` = s.`itemId` AND m.`enabled` = 1
WHERE s.`enabled` = 1
GROUP BY s.`groupId`, s.`itemId`;

-- 2) 业务管理员：组织架构 / 员工信息管理（人力资源中心）、菜单项管理（菜单管理）
INSERT INTO `usergrouppowerset` (`id`, `roleId`, `menuGroupId`, `menuItemId`, `enabled`)
SELECT UUID(), 'a1b2c3d4-0002-4a1b-8c00-000000000002', s.`groupId`, s.`itemId`, 1
FROM `menugroupitemset` s
INNER JOIN `menugroupinfos` g ON g.`id` = s.`groupId` AND g.`enabled` = 1
INNER JOIN `menuinfros` m ON m.`id` = s.`itemId` AND m.`enabled` = 1
WHERE s.`enabled` = 1
  AND ((g.`nameCn` = '人力资源中心')
    OR (g.`nameCn` = '菜单管理' AND m.`path` = 'menu.html'))
GROUP BY s.`groupId`, s.`itemId`;

-- 3) 普通用户：仅组织架构（只读查看）
INSERT INTO `usergrouppowerset` (`id`, `roleId`, `menuGroupId`, `menuItemId`, `enabled`)
SELECT UUID(), 'a1b2c3d4-0003-4a1b-8c00-000000000003', s.`groupId`, s.`itemId`, 1
FROM `menugroupitemset` s
INNER JOIN `menugroupinfos` g ON g.`id` = s.`groupId` AND g.`enabled` = 1
INNER JOIN `menuinfros` m ON m.`id` = s.`itemId` AND m.`enabled` = 1
WHERE s.`enabled` = 1
  AND m.`path` = 'org.html'
GROUP BY s.`groupId`, s.`itemId`;

-- 4) 审计员（已停用角色）：保留历史授权但标记停用
INSERT INTO `usergrouppowerset` (`id`, `roleId`, `menuGroupId`, `menuItemId`, `enabled`)
SELECT UUID(), 'a1b2c3d4-0004-4a1b-8c00-000000000004', s.`groupId`, s.`itemId`, 0
FROM `menugroupitemset` s
INNER JOIN `menugroupinfos` g ON g.`id` = s.`groupId` AND g.`enabled` = 1
INNER JOIN `menuinfros` m ON m.`id` = s.`itemId` AND m.`enabled` = 1
WHERE s.`enabled` = 1 AND m.`path` = 'org.html'
GROUP BY s.`groupId`, s.`itemId`;

-- 回显（便于人工核对）
SHOW TABLES LIKE 'usergrouppowerset';
SELECT u.`nameCn` AS roleName, COUNT(*) AS powerCount
FROM `usergrouppowerset` p
LEFT JOIN `usergroup` u ON u.`id` = p.`roleId`
GROUP BY p.`roleId`, u.`nameCn`
ORDER BY powerCount DESC;
