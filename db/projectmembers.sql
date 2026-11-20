-- =====================================================================
-- 项目管理：项目组成员表（projectmembers）
-- ---------------------------------------------------------------------
-- 用途：
--   · 维护每个项目的项目组成员（成员从「员工信息」empinfos 中选取）；
--   · 保存成员时后端做差异比对：新增的成员自动推送一条站内即时消息
--     （发送人 = 当前操作人），并给「有邮箱」的新成员同步发送通知邮件；
--   · noticeMsg / noticeMail 记录该成员是否已收到站内消息 / 邮件，便于排查与重发；
--   · 项目被删除时按 projectId 级联清理成员（ProjectInfoService.delete 里处理）。
-- 约定：
--   · 主键 UUID（CHAR(36)）；同一项目内 empId 唯一（uk_projectmembers_project_emp）；
--   · empName / deptName / email 为加入时的快照（员工改名 / 换部门后不影响历史通知内容）。
--
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < projectmembers.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `projectmembers` (
  `id`          CHAR(36)        NOT NULL                        COMMENT '主键（UUID）',
  `projectId`   CHAR(36)        NOT NULL                        COMMENT '项目ID（projectinfos.id）',
  `empId`       BIGINT UNSIGNED NOT NULL                        COMMENT '员工ID（empinfos.id）',
  `empName`     VARCHAR(50)     DEFAULT NULL                    COMMENT '员工姓名快照',
  `deptId`      BIGINT UNSIGNED NOT NULL DEFAULT 0              COMMENT '部门ID快照（OrganizationStructure.id）',
  `deptName`    VARCHAR(100)    DEFAULT NULL                    COMMENT '部门名称快照',
  `jobTitle`    VARCHAR(50)     DEFAULT NULL                    COMMENT '岗位快照',
  `email`       VARCHAR(100)    DEFAULT NULL                    COMMENT '邮箱快照（空 = 不发送邮件）',
  `noticeMsg`   TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '是否已推送站内消息：1-是',
  `noticeMail`  TINYINT(1)      NOT NULL DEFAULT 0              COMMENT '是否已发送邮件：1-是',
  `noticeTime`  DATETIME        DEFAULT NULL                    COMMENT '最近一次通知时间',
  `createTime`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '加入时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_projectmembers_project_emp` (`projectId`, `empId`),
  KEY `idx_projectmembers_emp` (`empId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='项目组成员（成员来自员工信息，保存时自动通知）';
