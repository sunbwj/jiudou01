-- =====================================================================
-- 迁移：serviceemail 改为「单例表」——全表只允许一条记录（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 背景：
--   服务信箱是系统的一份配置（收发邮件用的那一个邮箱账号），不是列表。
--   页面入口在「邮箱助手 → 右上角设置按钮」弹出的弹窗：
--     表里没有记录 → 新增；已有记录 → 编辑。
--   业务层（server/service.py: ServiceEmailService.add）已拒绝第二条新增，
--   这里在数据库层再加一道兜底：singleFlag 生成列恒为 1 + 唯一索引 uk_serviceemail_single，
--   第二条 INSERT 必然报 1062 冲突（与 enabledFlag 保证「只有一条启用」是同一套手法）。
--
-- 前置检查（若结果 > 1，请先人工保留需要的那一条，其余删除或合并后再执行本脚本）：
--   SELECT COUNT(*) AS n FROM `serviceemail`;
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < serviceemail-single.sql
-- =====================================================================

SET NAMES utf8mb4;

-- 1. 新增单例标记生成列（恒为 1）
ALTER TABLE `serviceemail`
  ADD COLUMN `singleFlag` TINYINT(1) GENERATED ALWAYS AS (1) STORED
      COMMENT '单例标记（生成列恒为 1，配合唯一索引保证全表只有一条记录）'
      AFTER `enabledFlag`;

-- 2. 唯一索引：第二条记录插入时直接冲突
ALTER TABLE `serviceemail`
  ADD UNIQUE KEY `uk_serviceemail_single` (`singleFlag`);

-- 3. 表注释同步
ALTER TABLE `serviceemail`
  COMMENT = '服务信箱（收件 / 发件账号，单例表：全表仅一条）';

-- 校验：应看到 singleFlag 列与 uk_serviceemail_single 唯一索引
--   SHOW CREATE TABLE `serviceemail`;
