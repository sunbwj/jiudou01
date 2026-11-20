-- =====================================================================
-- 菜单更名：站内消息 → 即时对话（message.html）
-- ---------------------------------------------------------------------
-- 背景：message.html 已从「类邮件的异步站内消息」改为 WebSocket 实时 IM（WebQQ 风格），
--       菜单名继续叫「站内消息」容易和「我的邮箱」混淆，故统一改名为「即时对话」。
-- 影响范围：只有显示名称（nameCn / nameEn / remark）与页面按钮的 pageName，
--           **不动 path / icon / 排序 / 授权关系**（menuItemId 未变，角色授权自动跟随）。
-- 【可重复执行 / 非破坏性】只 UPDATE 显示字段，重复执行结果一致。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < db/emp-message-rename-im.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1) 菜单项显示名：站内消息 → 即时对话
UPDATE `menuinfros`
   SET `nameCn` = '即时对话',
       `nameEn` = 'InstantMessage',
       `remark` = '即时对话：WebSocket 实时聊天（WebQQ 风格），全员可互发；消息落库持久保存，离线发送登录后即可看到'
 WHERE `code` = 'MNU00022';

-- 2) 本页操作按钮的 pageName（pageopbtn 按 pagePath + btnId 唯一，改名不影响收录）
UPDATE `pageopbtn`
   SET `pageName` = '即时对话'
 WHERE `pagePath` = 'message.html';
