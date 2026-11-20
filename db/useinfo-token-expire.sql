-- =====================================================================
-- 迁移：useinfo 增加「登录令牌过期时间」（token 有效期，默认 8 小时）
-- ---------------------------------------------------------------------
-- 说明：
--   · 单点登录（SSO）场景下，token 由登录接口一次性签发，浏览器所有同源页面
--     （main.html 与 iframe 内的各功能子页）共享同一份 localStorage 登录态；
--   · 服务端以 tokenExpireTime 判定令牌是否仍有效，过期后所有接口统一返回
--     code=401「登录已超时，请重新登录」，前端由框架页（main.html）统一跳登录页；
--   · 有效期时长由后端 config.TOKEN_TTL_HOURS 控制（默认 8 小时），登录时写入。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < useinfo-token-expire.sql
-- =====================================================================

SET NAMES utf8mb4;

-- token 过期时间：登录成功时写入（= 登录时间 + TOKEN_TTL_HOURS 小时），退出登录置 NULL
ALTER TABLE `useinfo`
  ADD COLUMN `tokenExpireTime` DATETIME DEFAULT NULL
      COMMENT 'token 过期时间（登录时写入，默认登录时间+8小时）'
      AFTER `token`;

-- token 查询索引（每个请求都要按 token 反查用户）
ALTER TABLE `useinfo`
  ADD KEY `idx_useinfo_token` (`token`);

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `useinfo`;
