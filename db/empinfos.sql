-- =====================================================================
-- 表：员工信息 empinfos（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 员工基本信息：工号（E + 5 位流水号，自动生成、支持编辑、全局唯一）、
--               姓名、性别、手机号、邮箱（必填 + 格式校验）、所属部门、
--               岗位、在职状态（在职 / 试用 / 离职）、入职日期、备注
-- 员工档案信息（均可空）：出生日期、身份证号、最高学历、毕业院校、所学专业、
--               执业资格证书、职称、照片（Base64 DataURL 或图片地址）
-- 前端页面：emp.html（单页完成查询 / 新增 / 编辑 / 删除，表单以弹窗呈现）
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < empinfos.sql
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `empinfos` (
  `id`          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT            COMMENT '主键ID（自增）',
  `code`        VARCHAR(16)      NOT NULL                          COMMENT '工号（唯一，规则 E + 5 位流水号，如 E00001；可编辑）',
  `nameCn`      VARCHAR(50)      NOT NULL                          COMMENT '姓名',
  `gender`      TINYINT UNSIGNED NOT NULL DEFAULT 1                COMMENT '性别：1-男，2-女',
  `phone`       VARCHAR(20)      DEFAULT NULL                      COMMENT '手机号（11 位，1 开头）',
  `email`       VARCHAR(100)     NOT NULL                          COMMENT '邮箱（必填，需符合邮箱格式）',
  `deptId`      BIGINT UNSIGNED  NOT NULL DEFAULT 0                 COMMENT '所属部门ID（OrganizationStructure.id，0-未分配）',
  `jobTitle`    VARCHAR(50)      DEFAULT NULL                      COMMENT '岗位',
  `status`      TINYINT UNSIGNED NOT NULL DEFAULT 1                COMMENT '在职状态：1-在职，2-试用，0-离职',
  `hireDate`    DATE             DEFAULT NULL                      COMMENT '入职日期',
  `birthDate`   DATE             DEFAULT NULL                      COMMENT '出生日期（可空）',
  `idCard`      VARCHAR(18)      DEFAULT NULL                      COMMENT '身份证号（可空，15 / 18 位）',
  `education`   VARCHAR(20)      DEFAULT NULL                      COMMENT '最高学历（如：本科 / 硕士）',
  `school`      VARCHAR(100)     DEFAULT NULL                      COMMENT '毕业院校',
  `major`       VARCHAR(100)     DEFAULT NULL                      COMMENT '所学专业',
  `certificates` VARCHAR(200)    DEFAULT NULL                      COMMENT '执业资格证书（多个用顿号分隔）',
  `titleName`   VARCHAR(50)      DEFAULT NULL                      COMMENT '职称（如：主管护师 / 高级工程师）',
  `photo`       MEDIUMTEXT       DEFAULT NULL                      COMMENT '照片（Base64 DataURL 或图片地址）',
  `remark`      VARCHAR(200)     DEFAULT NULL                      COMMENT '备注',
  `createTime`  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime`  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_empinfos_code`  (`code`),
  KEY `idx_empinfos_nameCn`      (`nameCn`),
  KEY `idx_empinfos_email`       (`email`),
  KEY `idx_empinfos_phone`       (`phone`),
  KEY `idx_empinfos_deptId`      (`deptId`),
  KEY `idx_empinfos_status`      (`status`),
  KEY `idx_empinfos_hireDate`    (`hireDate`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '员工信息表（工号 E+5 位流水号，邮箱必填）';

-- 初始示例数据（可按需删除）：deptId 对应 OrganizationStructure 现有部门
INSERT INTO `empinfos`
  (`code`, `nameCn`, `gender`, `phone`, `email`, `deptId`, `jobTitle`, `status`, `hireDate`,
   `birthDate`, `idCard`, `education`, `school`, `major`, `certificates`, `titleName`, `remark`) VALUES
  ('E00001', '张守正', 1, '13800138001', 'zhangshouzheng@jiudou.com', 30, '研发总监',     1, '2019-03-01',
   '1985-04-12', '110101198504121234', '硕士', '清华大学',       '计算机科学与技术', '信息系统项目管理师、系统架构设计师', '高级工程师', '负责研发中心整体技术规划'),
  ('E00002', '李耘创', 2, '13800138002', 'liyunchuang@jiudou.com',   5,  '市场运营经理', 1, '2020-06-15',
   '1990-08-23', '310101199008231567', '本科', '复旦大学',       '市场营销',         '中级经济师',                       '经济师',     '负责品牌推广与渠道运营'),
  ('E00003', '王多云', 1, '13800138003', 'wangduoyun@jiudou.com',    2,  '数据架构师',   1, '2021-02-08',
   '1988-11-05', '320101198811053456', '硕士', '南京大学',       '软件工程',         '系统分析师',                       '工程师',     '负责医疗大数据平台架构'),
  ('E00004', '赵小雨', 2, '13800138004', 'zhaoxiaoyu@jiudou.com',    32, '产品经理',     2, '2025-09-01',
   '1997-02-18', '330101199702184567', '本科', '浙江大学',       '数字媒体技术',     NULL,                               '助理工程师', '试用期，负责医疗信息化产品线'),
  ('E00005', '陈思远', 1, '13800138005', 'chensiyuan@jiudou.com',    18, '测试工程师',   1, '2022-11-20',
   '1993-06-30', '440101199306305678', '本科', '华南理工大学',   '信息管理与信息系统', '软件评测师',                     '工程师',     '负责自动化测试与质量看板'),
  ('E00006', '孙悦',   2, '13800138006', 'sunyue@jiudou.com',        6,  '人事专员',     0, '2018-07-05',
   '1992-09-09', '420101199209096789', '大专', '武汉职业技术学院', '人力资源管理',   '人力资源管理师（三级）',           '助理经济师', '已离职，历史档案保留');

-- 结构回显（便于人工核对）
SHOW TABLES LIKE 'empinfos';
SELECT `id`, `code`, `nameCn`, `phone`, `email`, `deptId`, `status` FROM `empinfos` ORDER BY `code`;
