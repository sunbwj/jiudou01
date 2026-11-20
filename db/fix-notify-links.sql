-- =============================================================================
-- 通知链接历史数据清理（可选，可重复执行）
-- -----------------------------------------------------------------------------
-- 背景：早期版本用 SERVER_HOST + SERVER_PORT 拼通知链接，库里存过
--       http://127.0.0.1:8808/workplan-design.html?id=xxx 这类「本机地址」。
--       新版本已改为「站内消息用相对路径、邮件用访问地址」，前端渲染时也会把
--       历史内容里的本机地址就地改成相对路径（RichText.sanitize），所以
--       **不跑这个脚本也不影响点击**。
--
-- 什么时候需要跑：
--   · 想彻底清掉历史数据里的 http://127.0.0.1(:端口)，比如导出、审计、检索；
--   · 注意：已发出的邮件在别人邮箱里，无法修改，本脚本只处理站内数据。
--
-- 执行方式（先把 :8808 换成本环境实际端口）：
--   mysql -usa -proger2019 rogerorm < db/fix-notify-links.sql
--
-- 只做字符串替换，不改任何其它字段，重复执行无副作用（替换过的不再匹配）。
-- =============================================================================

-- 1) 站内即时消息（IM / 消息中心）
UPDATE `emp_msgs`
SET `content`     = REPLACE(`content`, 'http://127.0.0.1:8808/', '/'),
    `contentHtml` = REPLACE(`contentHtml`, 'http://127.0.0.1:8808/', '/')
WHERE `content` LIKE '%http://127.0.0.1:8808/%'
   OR `contentHtml` LIKE '%http://127.0.0.1:8808/%';

-- localhost 写法（同一批老数据里也可能出现）
UPDATE `emp_msgs`
SET `content`     = REPLACE(`content`, 'http://localhost:8808/', '/'),
    `contentHtml` = REPLACE(`contentHtml`, 'http://localhost:8808/', '/')
WHERE `content` LIKE '%http://localhost:8808/%'
   OR `contentHtml` LIKE '%http://localhost:8808/%';

-- 2) 工作计划变更邮件队列（还没发出去的；已发送的仅为历史留档）
UPDATE `workplanmailqueue`
SET `body`     = REPLACE(`body`, 'http://127.0.0.1:8808/', '/'),
    `bodyHtml` = REPLACE(`bodyHtml`, 'http://127.0.0.1:8808/', '/')
WHERE `status` IN ('pending', 'retry')
  AND (`body` LIKE '%http://127.0.0.1:8808/%' OR `bodyHtml` LIKE '%http://127.0.0.1:8808/%');

-- 核对：两条都应为 0（若不为 0，说明还有别的端口写法，按实际端口再跑一次）
SELECT COUNT(*) AS msg_left FROM `emp_msgs`
 WHERE `content` LIKE '%127.0.0.1:%' OR `contentHtml` LIKE '%127.0.0.1:%';
SELECT COUNT(*) AS mailq_left FROM `workplanmailqueue`
 WHERE `status` IN ('pending', 'retry')
   AND (`body` LIKE '%127.0.0.1:%' OR `bodyHtml` LIKE '%127.0.0.1:%');
