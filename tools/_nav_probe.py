# -*- coding: utf-8 -*-
"""取真实 /api/nav（系统管理员视角）落盘，供首页卡片 jsdom 探针使用"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'server'))
import test_api as T  # noqa: E402

T.login_for_token()
res = T.get('/api/nav', {'roleId': 'a1b2c3d4-0001-4a1b-8c00-000000000001'})
out = os.path.join(HERE, '_nav_probe.json')
with open(out, 'w', encoding='utf-8') as fp:
    json.dump(res, fp, ensure_ascii=False)
print('nav code=%s groups=%s menuCount=%s -> %s' % (
    res.get('code'), len((res.get('data') or {}).get('groups') or []),
    (res.get('data') or {}).get('menuCount'), out))
