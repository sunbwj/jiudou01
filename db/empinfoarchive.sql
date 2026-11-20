-- =====================================================================
-- 表：员工信息归档 empinfoarchive（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 用途：把「员工信息表 empinfos」在某一时刻的全部记录整表快照留存，
--       用于历史追溯（人员异动、部门调整、离职后的档案核对等）。
--
-- 字段说明：
--   id          归档记录ID（UUID 主键，非自增；插入时用 UUID() 或服务端 uuid4）
--   batchId     归档批次ID（UUID）：一次归档动作生成一个批次，同一批次内所有记录共用
--   archiveTime 归档时间（DATETIME）：批次时间，同一批次内一致；列表按此倒序展示
--   empId       原员工ID（empinfos.id，仅作溯源参考，不做外键约束：员工可能被删除）
--   其余字段    与 empinfos 一一对应（工号、姓名、性别、手机号、邮箱、所属部门、
--               岗位、在职状态、入职日期、出生日期、身份证号、最高学历、毕业院校、
--               所学专业、执业资格证书、职称、照片、备注、创建时间、更新时间）
--
-- 说明：
--   · 归档只追加，不修改也不删除历史批次（清理由运维按批次执行）
--   · uk_emparchive_batch_emp：同一批次内同一员工只允许一条，防止重复归档
--   · 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < empinfoarchive.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `empinfoarchive` (
  `id`           CHAR(36)        NOT NULL                         COMMENT '归档记录ID（UUID）',
  `batchId`      CHAR(36)        NOT NULL                         COMMENT '归档批次ID（UUID，一次归档一个批次）',
  `archiveTime`  DATETIME        NOT NULL                         COMMENT '归档时间',
  `empId`        BIGINT UNSIGNED NOT NULL                         COMMENT '原员工ID（empinfos.id）',
  `code`         VARCHAR(16)     NOT NULL                         COMMENT '工号',
  `nameCn`       VARCHAR(50)     NOT NULL                         COMMENT '姓名',
  `gender`       TINYINT UNSIGNED NOT NULL DEFAULT 1              COMMENT '性别：1-男，2-女',
  `phone`        VARCHAR(20)     DEFAULT NULL                     COMMENT '手机号',
  `email`        VARCHAR(100)    NOT NULL                         COMMENT '邮箱',
  `deptId`       BIGINT UNSIGNED NOT NULL DEFAULT 0               COMMENT '所属部门ID（OrganizationStructure.id，0-未分配）',
  `jobTitle`     VARCHAR(50)     DEFAULT NULL                     COMMENT '岗位',
  `status`       TINYINT UNSIGNED NOT NULL DEFAULT 1              COMMENT '在职状态：1-在职，2-试用，0-离职',
  `hireDate`     DATE            DEFAULT NULL                     COMMENT '入职日期',
  `birthDate`    DATE            DEFAULT NULL                     COMMENT '出生日期',
  `idCard`       VARCHAR(18)     DEFAULT NULL                     COMMENT '身份证号',
  `education`    VARCHAR(20)     DEFAULT NULL                     COMMENT '最高学历',
  `school`       VARCHAR(100)    DEFAULT NULL                     COMMENT '毕业院校',
  `major`        VARCHAR(100)    DEFAULT NULL                     COMMENT '所学专业',
  `certificates` VARCHAR(200)    DEFAULT NULL                     COMMENT '执业资格证书',
  `titleName`    VARCHAR(50)     DEFAULT NULL                     COMMENT '职称',
  `photo`        MEDIUMTEXT      DEFAULT NULL                     COMMENT '照片（Base64 DataURL 或图片地址）',
  `remark`       VARCHAR(200)    DEFAULT NULL                     COMMENT '备注',
  `createTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '员工记录创建时间（取自 empinfos.createTime）',
  `updateTime`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '员工记录更新时间（取自 empinfos.updateTime）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_emparchive_batch_emp` (`batchId`, `empId`),
  KEY `idx_emparchive_batch`   (`batchId`),
  KEY `idx_emparchive_time`    (`archiveTime`),
  KEY `idx_emparchive_code`    (`code`),
  KEY `idx_emparchive_nameCn`  (`nameCn`),
  KEY `idx_emparchive_deptId`  (`deptId`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '员工信息归档表（按批次整表快照，只追加）';

-- 结构回显（便于人工核对）
SHOW FULL COLUMNS FROM `empinfoarchive`;
