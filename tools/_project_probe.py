# -*- coding: utf-8 -*-
"""项目管理接口快速探针（真实 HTTP，跑完自动清理测试数据）"""
import base64
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'server'))
import test_api as T  # noqa: E402

TAG = '__probe_project__'
created_project = ''
created_file = ''


def show(name, res, keys=()):
    data = res.get('data') or {}
    brief = {}
    for k in keys:
        if isinstance(data, dict) and k in data:
            brief[k] = data[k]
    print('%-38s code=%s msg=%s %s' % (name, res.get('code'), res.get('message'),
                                       json.dumps(brief, ensure_ascii=False)))
    return data


def main():
    global created_project, created_file
    token = T.login_for_token()
    print('login token:', 'OK' if token else 'FAIL')
    if not token:
        return 1

    print('\n--- project ---')
    show('nextcode', T.get('/api/project/nextcode'), ('code',))
    show('types', T.get('/api/project/types'), ('types', 'statuses'))
    r = T.post('/api/project/add', {
        'projectName': TAG + '九豆探针项目', 'projectType': '研发',
        'projectStatus': '进行中', 'projectDesc': '探针说明', 'ispub': 0, 'enabled': 1
    })
    d = show('add（私有 / 自动生成编号）', r,
             ('id', 'projectCode', 'projectName', 'ispub', 'createEname', 'createempinfosid'))
    created_project = d.get('id', '')
    if not created_project:
        return 1
    show('add 重复名称被拒', T.post('/api/project/add', {
        'projectName': TAG + '九豆探针项目', 'projectType': '研发'}), ())
    show('add 非法类型被拒', T.post('/api/project/add', {
        'projectName': TAG + '非法类型', 'projectType': '不存在'}), ())
    show('check 名称重复', T.get('/api/project/check',
                             {'field': 'projectName', 'value': TAG + '九豆探针项目'}), ('unique',))
    page = show('list', T.get('/api/project/list', {'keyword': TAG}),
                ('total', 'stats'))
    print('  list.items =', json.dumps([{
        'code': x.get('projectCode'), 'name': x.get('projectName'),
        'ispub': x.get('ispub'), 'files': x.get('fileCount')} for x in page.get('list', [])],
        ensure_ascii=False))
    show('list 按类型筛选', T.get('/api/project/list',
                              {'keyword': TAG, 'projectType': '实施'}), ('total',))
    show('detail', T.get('/api/project/detail', {'id': created_project}),
         ('projectCode', 'projectName', 'ispubText'))
    show('options', T.get('/api/project/options', {'keyword': TAG}), ())
    opts = T.get('/api/project/options', {'keyword': TAG}).get('data') or {}
    print('  options.list =', json.dumps([x.get('label') for x in opts.get('list', [])],
                                        ensure_ascii=False))
    show('update', T.post('/api/project/update', {
        'id': created_project, 'projectName': TAG + '九豆探针项目（改）',
        'projectType': '实施', 'projectStatus': '已完成', 'ispub': 1,
        'projectDesc': '改后说明', 'projectCode': 'PRO999999'}),
         ('projectCode', 'projectName', 'projectType', 'ispub'))

    print('\n--- projectfile ---')
    show('types', T.get('/api/projectfile/types'), ('types',))
    content = base64.b64encode('项目文件探针内容 hello'.encode('utf-8')).decode('ascii')
    r = T.post('/api/projectfile/upload', {
        'projectId': created_project, 'fileName': '探针说明.txt', 'fileType': '文档',
        'fileDesc': '探针上传', 'ispub': 0, 'enabled': 1, 'data': content,
        'fileSize': len(content)
    })
    f = show('upload', r,
             ('id', 'fileName', 'filePath', 'downloadUrl', 'fileSize', 'fileSizeText',
              'projectCode', 'projectName', 'uploadEname'))
    created_file = f.get('id', '')
    if f.get('downloadUrl'):
        try:
            with urllib.request.urlopen(T.BASE + f['downloadUrl'], timeout=10) as resp:
                body = resp.read()
            print('%-38s status=%s bytes=%s text=%s' % (
                '静态下载', resp.status, len(body), body.decode('utf-8', 'ignore')))
        except Exception as exc:
            print('静态下载 FAIL:', exc)
    show('list', T.get('/api/projectfile/list', {'projectId': created_project}),
         ('total', 'stats'))
    show('list 按文件类型筛', T.get('/api/projectfile/list',
                                {'projectId': created_project, 'fileType': '图片'}), ('total',))
    show('download', T.get('/api/projectfile/download', {'id': created_file}),
         ('fileName', 'downloadUrl', 'message'))
    show('update（改说明 / 转公用）', T.post('/api/projectfile/update', {
        'id': created_file, 'fileType': '文档', 'fileDesc': '改后说明', 'ispub': 1}),
         ('fileName', 'fileDesc', 'ispub', 'filePath'))
    show('enabled 停用', T.post('/api/projectfile/enabled',
                             {'id': created_file, 'enabled': 0}), ('enabled', 'message'))
    show('download 停用被拒', T.get('/api/projectfile/download', {'id': created_file}), ())
    show('delete 文件', T.post('/api/projectfile/delete', {'id': created_file}),
         ('fileName', 'message'))
    created_file = ''

    print('\n--- cleanup ---')
    show('delete 项目（级联文件）', T.post('/api/project/delete', {'id': created_project}),
         ('message', 'deletedFiles'))
    show('list 清空', T.get('/api/project/list', {'keyword': TAG}), ('total',))
    return 0


if __name__ == '__main__':
    try:
        code = main()
    finally:
        if created_file:
            T.post('/api/projectfile/delete', {'id': created_file})
        if created_project:
            T.post('/api/project/delete', {'id': created_project})
    sys.exit(code)
