# -*- coding: utf-8 -*-
"""业务异常（单独一个模块，避免 service 与 app_schema 互相 import 形成环）"""


class BizError(Exception):
    """业务异常：code != 0，message 直接展示给前端"""

    def __init__(self, message, code=500):
        super(BizError, self).__init__(message)
        self.message = message
        self.code = code
