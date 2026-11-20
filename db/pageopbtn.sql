-- =====================================================================
-- 表：页面操作按钮 pageopbtn（数据库 rogerorm）
-- ---------------------------------------------------------------------
-- 用途：登记各管理页面「操作引导区」里的操作按钮，便于后续维护
--       （按钮文本统一、启停控制、页面改名后同步等）。
--   · id：记录ID，UUID 主键（MySQL 5.7 无原生 UUID 类型，用 CHAR(36) 存标准
--         36 位 UUID 字符串），非自增，由服务端 uuid4() 生成；
--   · pageName：所属页面（取页面标题，如「员工信息管理」）；
--   · pagePath：页面路径（如 emp.html）；
--   · btnId：操作按钮id（页面内的元素 id，如 btnAdd）；
--   · btnText：操作按钮文本（如「新增员工」）；
--   · sortNo：按钮在页面中的顺序（扫描时按出现顺序编号）；
--   · enabled：启用否；remark：备注（扫描发现页面里已无该按钮时会写提示）。
--   唯一键 uk_pageopbtn_page_btn(pagePath, btnId) —— 同一页面内按钮 id 唯一。
-- 收录方式：管理页 page-op-btn.html 打开时自动扫描收录（也可手动「重新收录」），
--           扫描逻辑见 server/page_scan.py（解析 .toolbar / .pick-toolbar / .form-actions）。
-- 执行：mysql -h localhost -u sa -p --default-character-set=utf8mb4 rogerorm < pageopbtn.sql
-- 说明：本脚本只建表，不插数据 —— 数据由管理页「自动收录」按页面实时生成。
-- =====================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `pageopbtn` (
  `id`         CHAR(36)     NOT NULL                          COMMENT '记录ID（UUID 主键，非自增）',
  `pageName`   VARCHAR(60)  NOT NULL                          COMMENT '所属页面（页面标题）',
  `pagePath`   VARCHAR(120) NOT NULL                          COMMENT '页面路径',
  `btnId`      VARCHAR(64)  NOT NULL                          COMMENT '操作按钮id（页面内元素 id）',
  `btnText`    VARCHAR(60)  NOT NULL                          COMMENT '操作按钮文本',
  `sortNo`     INT          NOT NULL DEFAULT 0                COMMENT '按钮在页面中的顺序',
  `enabled`    TINYINT(1)   NOT NULL DEFAULT 1                COMMENT '启用否：1-启用，0-停用',
  `remark`     VARCHAR(200) DEFAULT NULL                      COMMENT '备注',
  `createTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updateTime` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pageopbtn_page_btn` (`pagePath`, `btnId`),
  KEY `idx_pageopbtn_page`    (`pagePath`),
  KEY `idx_pageopbtn_enabled` (`enabled`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_general_ci
  COMMENT = '页面操作按钮表（操作引导区按钮登记，UUID 主键）';

SHOW TABLES LIKE 'pageopbtn';
