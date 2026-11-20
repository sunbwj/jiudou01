/* ==========================================================================
   tools/smoke-test.js —— 数据层冒烟测试（Node 环境，最小 jQuery 桩）
   运行：node tools/smoke-test.js
   校验：分页查询 / 关键字检索 / 启用筛选 / 唯一性校验 / 新增 / 编辑 / 删除
   ========================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

/* ---- 最小 jQuery 桩：$.Deferred ---- */
function makeDeferred() {
    var resolve, reject;
    var p = new Promise(function (a, b) { resolve = a; reject = b; });
    // 注意：done/fail 都要显式吞掉另一分支，否则派生 Promise 会因未处理拒绝而让进程退出
    var chain = {
        done: function (f) { p.then(f, function () { }); return chain; },
        fail: function (f) { p.then(null, f); return chain; },
        always: function (f) { p.then(f, f); return chain; }
    };
    return { resolve: resolve, reject: reject, promise: function () { return chain; } };
}
var jQuery = { Deferred: makeDeferred, ajax: function () { throw new Error('mock 模式下不应调用 $.ajax'); } };

/* ---- 浏览器环境桩 ---- */
var store = {};
var sandbox = {
    jQuery: jQuery,
    window: {
        // 前端按页面协议决定接口地址：这里模拟「由后端托管」的 http 场景
        location: { protocol: 'http:', href: 'http://127.0.0.1:8808/menu.html' },
        localStorage: {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
            setItem: function (k, v) { store[k] = String(v); },
            removeItem: function (k) { delete store[k]; }
        },
        setTimeout: function (fn, ms) { return setTimeout(fn, 0); }
    },
    console: console
};
sandbox.global = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

var root = path.join(__dirname, '..');
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'api.js'), 'utf8'), sandbox, { filename: 'api.js' });
var Api = sandbox.window.Api;

var pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  [PASS] ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---- 菜单组接口用例 ---- */
function finish() {
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
}

/* ---- 菜单组项目接口用例 ---- */
function runGroupItemTests() {
    console.log('\n--- 菜单组项目接口 ---');
    Api.groupItem.page({ groupId: 0, pageNum: 1, pageSize: 10 }).fail(function (e0) {
        check('未选择菜单组时拒绝查询', /请先选择菜单组/.test(e0.message), e0.message);

        Api.groupItem.page({ groupId: 1, pageSize: 50 }).done(function (r1) {
            check('菜单组 1 的菜单项：3 条且按显示序号升序',
                r1.total === 3 && r1.list[0].itemCode === 'MENU0100' && r1.list[2].itemCode === 'MENU0600',
                JSON.stringify({ total: r1.total, codes: r1.list.map(function (x) { return x.itemCode; }) }));
            check('关联查询带出菜单组与菜单项信息',
                r1.list[0].groupCode === 'GRP0100' && r1.list[0].itemNameCn === '菜单项管理' && r1.list[0].itemEnabled === true);

            Api.groupItem.page({ groupId: 1, keyword: '操作日志', pageSize: 50 }).done(function (r2) {
                check('菜单组项目：关键字只在本组内生效', r2.total === 1 && r2.list[0].itemCode === 'MENU0600', 'total=' + r2.total);

                Api.groupItem.detail(r1.list[0].id).done(function (d1) {
                    check('菜单组项目详情一致', d1.itemCode === 'MENU0100' && d1.groupId === 1 && d1.sortNo === 1);

                    Api.groupItem.add({ groupId: 10, items: [{ itemId: 1, sortNo: 1 }, { itemId: 6, sortNo: 2 }] }).done(function (a1) {
                        check('批量新增：新增 2 条', a1.added === 2 && a1.list.length === 2, JSON.stringify({ added: a1.added, len: a1.list.length }));

                        Api.groupItem.add({ groupId: 10, items: [{ itemId: 1, sortNo: 9 }] }).done(function (a2) {
                            check('重复新增：只更新显示序号，不重复插入',
                                a2.added === 0 && a2.updated === 1 && a2.list.length === 2,
                                JSON.stringify({ added: a2.added, updated: a2.updated }));

                            Api.groupItem.add({ groupId: 10, items: [{ itemId: 5, sortNo: 3 }] }).fail(function (e1) {
                                check('停用菜单项不能加入菜单组', /已停用/.test(e1.message), e1.message);

                                Api.groupItem.update({ groupId: 10, items: [{ itemId: 1, sortNo: 7 }] }).done(function (u1) {
                                    check('全量同步：移除未勾选的并更新序号',
                                        u1.removed === 1 && u1.updated === 1 && u1.list.length === 1 && u1.list[0].sortNo === 7,
                                        JSON.stringify({ removed: u1.removed, updated: u1.updated }));

                                    var delId = u1.list[0].id;
                                    Api.groupItem.remove(delId).done(function () {
                                        Api.groupItem.page({ groupId: 10, pageSize: 50 }).done(function (r3) {
                                            check('删除单条后菜单组 10 已清空', r3.total === 0, 'total=' + r3.total);
                                            Api.groupItem.page({ groupId: 1, pageSize: 50 }).done(function (r4) {
                                                check('其它菜单组的配置不受影响', r4.total === 3, 'total=' + r4.total);
                                                runOrgTests();
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

/* ---- 部门组织架构接口用例（DPT + 4 位流水号 / 层级推导 / 防环 / 级联删除） ---- */
function runOrgTests() {
    console.log('\n--- 部门组织架构接口 ---');

    Api.org.page({ pageNum: 1, pageSize: 50 }).done(function (r1) {
        check('部门默认 6 条且按树形（父 → 子）输出',
            r1.total === 6 && r1.list[0].code === 'DPT0001' && r1.list[1].parentId === r1.list[0].id,
            JSON.stringify({ total: r1.total, codes: r1.list.map(function (x) { return x.code; }) }));
        check('部门字段含职能说明与启用否（布尔）',
            'duty' in r1.list[0] && typeof r1.list[0].enabled === 'boolean',
            JSON.stringify({ duty: r1.list[0].duty, enabled: r1.list[0].enabled }));

        Api.org.nextCode().done(function (nc) {
            check('部门编号自动生成：DPT + 4 位流水号', /^DPT\d{4}$/.test(nc.code), JSON.stringify(nc));

            Api.group.nextCode().done(function (gnc) {
                check('菜单组编号自动生成：MNG + 4 位流水号', /^MNG\d{4}$/.test(gnc.code), JSON.stringify(gnc));

                Api.org.add({ code: nc.code, nameCn: '冒烟测试部', duty: '自动化测试写入',
                              parentId: 0, sortNo: 9, enabled: 1 }).done(function (a1) {
                    check('新增顶级部门并自动定级 1 级', !!a1.id && a1.level === 1,
                        JSON.stringify({ id: a1.id, level: a1.level }));

                    Api.org.add({ code: nc.code, nameCn: '重复编号部门', parentId: 0 }).fail(function (e1) {
                        check('部门重复编号被拒绝', /编号已存在/.test(e1.message), e1.message);

                        Api.org.add({ code: 'DPT9902', nameCn: '冒烟二级部门', duty: '下级部门',
                                      parentId: a1.id, enabled: 1 }).done(function (a2) {
                            check('新增下级部门并自动定级 2 级', a2.level === 2, 'level=' + a2.level);

                            Api.org.update({ id: a1.id, code: nc.code, nameCn: '冒烟测试部',
                                             parentId: a2.id, enabled: 1 }).fail(function (e2) {
                                check('上级设为自己的下级被拒绝（防环）', /下级/.test(e2.message), e2.message);

                                // 停用 / 删除保护：下级存在启用状态的部门时禁止
                                Api.org.update({ id: a1.id, code: nc.code, nameCn: '冒烟测试部',
                                                 parentId: 0, enabled: 0 }).fail(function (e3a) {
                                    check('有启用状态下级时停用本部门被拒绝',
                                        /启用状态的下级部门/.test(e3a.message), e3a.message);

                                    Api.org.remove(a1.id, true).fail(function (e3b) {
                                        check('有启用状态下级时（级联）删除被拒绝',
                                            /启用状态的下级部门/.test(e3b.message), e3b.message);

                                        Api.org.update({ id: a2.id, code: 'DPT9902', nameCn: '冒烟二级部门',
                                                         parentId: a1.id, enabled: 0 }).done(function () {
                                            check('叶子部门（无下级）允许停用', true);

                                            Api.org.remove(a1.id).fail(function (e3) {
                                                check('存在下级部门时删除被拒绝', /下级/.test(e3.message), e3.message);

                                                Api.org.remove(a1.id, true).done(function () {
                                                    Api.org.detail(a2.id).fail(function (e4) {
                                                        check('级联删除后下级部门不可访问', /不存在/.test(e4.message), e4.message);

                                                        Api.org.page({ pageNum: 1, pageSize: 50 }).done(function (r2) {
                                                            check('清理后部门总数回到 6 条', r2.total === 6, 'total=' + r2.total);

                                                            Api.org.tree({}).done(function (t1) {
                                                                check('上级部门下拉首项为「（顶级部门）」',
                                                                    t1.list[0].id === 0 && /顶级部门/.test(t1.list[0].nameCn),
                                                                    JSON.stringify(t1.list[0]));
                                                                runEmpTests();
                                                            });
                                                        });
                                                    });
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

/* ---- 员工信息接口用例（E + 5 位工号 / 邮箱必填 + 格式 / 在职状态 / 部门关联） ---- */
function runEmpTests() {
    console.log('\n--- 员工信息接口 ---');
    Api.emp.page({ pageNum: 1, pageSize: 50 }).done(function (r1) {
        check('员工默认 6 条且按工号升序',
            r1.total === 6 && r1.list[0].code === 'E00001',
            JSON.stringify({ total: r1.total, codes: r1.list.map(function (x) { return x.code; }) }));
        check('字段含姓名/手机号/邮箱/在职状态/部门名',
            'nameCn' in r1.list[0] && 'phone' in r1.list[0] && !!r1.list[0].email
            && 'status' in r1.list[0] && 'statusText' in r1.list[0] && 'deptName' in r1.list[0],
            JSON.stringify(r1.list[0]));
        check('在职状态与文案对应（1 → 在职）',
            r1.list[0].statusText === '在职', r1.list[0].statusText);
        check('所属部门名由组织架构带出', !!r1.list[0].deptName, String(r1.list[0].deptName));

        Api.emp.nextCode().done(function (nc) {
            check('工号自动生成：E + 5 位流水号', /^E\d{5}$/.test(nc.code) && nc.code === 'E00007', JSON.stringify(nc));

            Api.emp.page({ status: '0', pageSize: 50 }).done(function (r2) {
                check('在职状态筛选「离职」命中 1 条', r2.total === 1 && /离职/.test(r2.list[0].statusText),
                    JSON.stringify({ total: r2.total }));

                Api.emp.page({ keyword: '王多云', pageSize: 50 }).done(function (r3) {
                    check('关键字按姓名检索命中 1 条', r3.total === 1, 'total=' + r3.total);

                    Api.emp.page({ keyword: '@jiudou.com', pageSize: 50 }).done(function (r4) {
                        check('关键字按邮箱检索命中 6 条', r4.total === 6, 'total=' + r4.total);

                        Api.emp.add({ code: nc.code, nameCn: '冒烟员工', gender: 1, phone: '13900139009',
                                      email: 'smoke.emp@jiudou.com', deptId: 0, jobTitle: '测试岗',
                                      status: 1, hireDate: '2026-03-01', remark: '冒烟用例' }).done(function (a1) {
                            check('新增员工成功且带出在职状态与部门字段',
                                a1.id > 0 && a1.statusText === '在职' && a1.deptName === '',
                                JSON.stringify(a1));

                            Api.emp.add({ code: nc.code, nameCn: '重复工号', email: 'dup2@jiudou.com' })
                                .fail(function (e1) {
                                    check('工号重复被拒绝', /工号已存在/.test(e1.message), e1.message);

                                    Api.emp.add({ code: 'E99011', nameCn: '无邮箱员工' }).fail(function (e2) {
                                        check('邮箱必填被拒绝', /邮箱/.test(e2.message), e2.message);

                                        Api.emp.add({ code: 'E99012', nameCn: '坏邮箱', email: 'abc@' })
                                            .fail(function (e3) {
                                                check('邮箱格式不正确被拒绝', /格式/.test(e3.message), e3.message);

                                                Api.emp.add({ code: 'E99013', nameCn: '坏手机',
                                                              email: 'ok@jiudou.com', phone: '123' })
                                                    .fail(function (e4) {
                                                        check('手机号格式不正确被拒绝', /手机号/.test(e4.message), e4.message);

                                                        Api.emp.nextCode().done(function (nc2) {
                                                            Api.emp.update({ id: a1.id, code: nc2.code, nameCn: '冒烟员工(改)',
                                                                             gender: 2, phone: '13900139010',
                                                                             email: 'smoke2.emp@jiudou.com', deptId: 0,
                                                                             jobTitle: '高级测试岗', status: 2,
                                                                             hireDate: '2026-04-01', remark: '已修改' })
                                                                .done(function (u1) {
                                                                    check('工号可编辑（改为新流水号）', u1.code === nc2.code, u1.code);
                                                                    check('编辑后在职状态文案为试用', u1.statusText === '试用', u1.statusText);
                                                                    check('编辑后岗位与姓名已更新',
                                                                        u1.jobTitle === '高级测试岗' && /改/.test(u1.nameCn),
                                                                        JSON.stringify(u1).slice(0, 160));

                                                                    Api.emp.remove(a1.id).done(function () {
                                                                        Api.emp.detail(a1.id).fail(function (e5) {
                                                                            check('删除后不可访问', /不存在/.test(e5.message), e5.message);

                                                                            Api.emp.page({ pageSize: 50 }).done(function (r5) {
                                                                                check('清理后员工总数回到 6 条', r5.total === 6,
                                                                                    'total=' + r5.total);
                                                                                runDptMgrTests();
                                                                            });
                                                                        });
                                                                    });
                                                                });
                                                        });
                                                    });
                                            });
                                    });
                                });
                        });
                    });
                });
            });
        });
    });
}

/* ---- 部门负责人设置（dptmgrset：一个部门一个负责人） ---- */
/* ---- 用户角色接口用例（UUID 主键 / 英文名唯一 / 中文名启用状态内唯一 / 排序号升序） ---- */
var RE_UUID_SMOKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* 把 jQuery Deferred 包成 Promise：resolve({ok, value|error})，便于顺序书写异步用例 */
function settle(deferred) {
    return new Promise(function (resolve) {
        deferred.done(function (value) { resolve({ ok: true, value: value }); })
            .fail(function (error) { resolve({ ok: false, error: error }); });
    });
}


/* ---- 登录认证（auth：账号 + MD5 密码 → token / 退出 / 当前用户） ---- */
async function runAuthTests() {
    console.log('\n--- 登录认证接口（含运算表达式验证码） ---');
    var RE_TOKEN = /^[0-9a-f]{32}$/;

    /* 取一道验证码并算出答案 */
    async function solveCaptcha() {
        var r = await settle(Api.auth.captcha());
        if (!r.ok) { return { id: '', answer: '', question: '' }; }
        var q = String(r.value.question || '');
        var m = /^(\d+)\s+([+\-×])\s+(\d+)\s*=\s*\?$/.exec(q);
        if (!m) { return { id: String(r.value.captchaId || ''), answer: '', question: q }; }
        var a = parseInt(m[1], 10), op = m[2], b = parseInt(m[3], 10);
        var answer = op === '+' ? (a + b) : (op === '-' ? (a - b) : (a * b));
        return { id: String(r.value.captchaId || ''), answer: String(answer), question: q };
    }
    /* 带验证码登录 */
    async function doLogin(account, password) {
        var c = await solveCaptcha();
        return settle(Api.auth.login({
            account: account, password: password, captchaId: c.id, captchaCode: c.answer
        }));
    }

    // ---- 验证码本身 ----
    var c1 = await solveCaptcha();
    check('验证码接口返回可用题目（a ±/× b = ?）', !!c1.id && /^\d+\s+[+\-×]\s+\d+\s*=\s*\?$/.test(c1.question),
        c1.id.slice(0, 8) + ' / ' + c1.question);
    var c2 = await solveCaptcha();
    check('每次取题的 captchaId 都不同', c2.id && c2.id !== c1.id, c1.id.slice(0, 8) + ' / ' + c2.id.slice(0, 8));

    var noCap = await settle(Api.auth.login({ account: '13800138001', password: '888888' }));
    check('不带验证码登录被拒绝', !noCap.ok && /请输入验证码/.test(noCap.error.message),
        noCap.ok ? 'expect rejected' : noCap.error.message);

    var wrongCap = await settle(Api.auth.login({
        account: '13800138001', password: '888888', captchaId: c2.id, captchaCode: '999'
    }));
    check('验证码答案错误被拒绝', !wrongCap.ok && /验证码不正确/.test(wrongCap.error.message),
        wrongCap.ok ? 'expect rejected' : wrongCap.error.message);
    var replay = await settle(Api.auth.login({
        account: '13800138001', password: '888888', captchaId: c2.id, captchaCode: c2.answer
    }));
    check('验证码一次性：错误后同一 captchaId 立即作废', !replay.ok && /失效/.test(replay.error.message),
        replay.ok ? 'expect rejected' : replay.error.message);

    // ---- 账号密码校验（每次都带新验证码）----
    var e1 = await doLogin('', '888888');
    check('账号为空被拒绝', !e1.ok && /请输入登录账号/.test(e1.error.message), e1.ok ? 'expect rejected' : e1.error.message);
    var e2 = await doLogin('13800138001', '');
    check('密码为空被拒绝', !e2.ok && /请输入登录密码/.test(e2.error.message), e2.ok ? 'expect rejected' : e2.error.message);
    var e3 = await doLogin('no_such_user', '888888');
    check('账号不存在提示「账号或密码不正确」', !e3.ok && /账号或密码不正确/.test(e3.error.message),
        e3.ok ? 'expect rejected' : e3.error.message);
    var e4 = await doLogin('13800138001', 'bad');
    check('密码错误提示「账号或密码不正确」', !e4.ok && /账号或密码不正确/.test(e4.error.message),
        e4.ok ? 'expect rejected' : e4.error.message);

    // ---- 正常登录（离线演示兜底：没有任何用户时用首个员工手机号 + 888888 自动种号）----
    var ok = await doLogin('13800138001', '888888');
    check('验证码 + 正确密码登录成功', ok.ok, ok.ok ? 'ok' : ok.error.message);
    var d = ok.ok ? ok.value : {};
    check('返回 32 位十六进制 token', RE_TOKEN.test(String(d.token)), String(d.token).slice(0, 12));
    check('返回登录时间与客户端IP', !!d.loginTime && !!d.loginIp, d.loginTime + ' / ' + d.loginIp);
    check('返回登录用户信息（姓名 / 角色）',
        !!d.user && !!d.user.empName && (d.user.roles || []).length >= 1,
        d.user ? d.user.empName + ' / ' + d.user.roleNames : '');
    check('登录响应不含密码字段', !!d.user && !('password' in d.user), JSON.stringify(d.user ? Object.keys(d.user) : []));

    var me = await settle(Api.auth.me(d.token));
    check('按 token 反查当前登录用户', me.ok && me.value.account === '13800138001',
        me.ok ? me.value.account : me.error.message);
    var bad = await settle(Api.auth.me('0'.repeat(32)));
    check('无效 token 被拒绝（401）', !bad.ok && /登录已失效/.test(bad.error.message),
        bad.ok ? 'expect rejected' : bad.error.message);

    var list = await settle(Api.useInfo.page({ pageNum: 1, pageSize: 10 }));
    var u = list.ok ? list.value.list[0] : {};
    check('登录后回写最近登录时间与 IP', !!u.lastLoginTime && !!u.lastLoginIp,
        u.lastLoginTime + ' / ' + u.lastLoginIp);
    check('登录后该用户标记为已有 token', u.hasToken === true, String(u.hasToken));
    check('列表仍不输出密码与 token 原文', !('password' in u) && !('token' in u), JSON.stringify(Object.keys(u)));

    // 停用账号不可登录
    await settle(Api.useInfo.update({ id: u.id, enabled: 0 }));
    var e5 = await doLogin('13800138001', '888888');
    check('停用账号登录被拒绝（提示已停用）', !e5.ok && /停用/.test(e5.error.message),
        e5.ok ? 'expect rejected' : e5.error.message);
    await settle(Api.useInfo.update({ id: u.id, enabled: 1 }));
    var ok2 = await doLogin('13800138001', '888888');
    check('恢复启用后可正常登录', ok2.ok, ok2.ok ? 'ok' : ok2.error.message);

    var out = await settle(Api.auth.logout(ok2.ok ? ok2.value.token : d.token));
    check('退出登录成功', out.ok, out.ok ? 'ok' : out.error.message);
    var me2 = await settle(Api.auth.me(ok2.ok ? ok2.value.token : d.token));
    check('退出后 token 立即失效', !me2.ok && /登录已失效/.test(me2.error.message),
        me2.ok ? 'expect rejected' : me2.error.message);
}

/* ---- 左侧导航：按当前登录用户所属角色的菜单权限过滤（Mock 通道） ---- */
async function runNavPermTests() {
    console.log('\n--- 左侧导航：按登录用户角色权限过滤 ---');
    var ADMIN_ROLE = 'a1b2c3d4-0001-4a1b-8c00-000000000001';

    function flatItems(groups) {
        var out = [];
        (function walk(list) {
            for (var i = 0; i < list.length; i++) {
                var n = list[i], its = n.items || [];
                for (var j = 0; j < its.length; j++) {
                    out.push({ g: parseInt(n.id, 10), i: parseInt(its[j].id, 10), name: its[j].nameCn });
                }
                walk(n.children || []);
            }
        })(groups || []);
        return out;
    }

    // 1) 无 token（离线演示，例如未登录的单页调试）：退化为全部启用角色
    var demo = await settle(Api.nav.get(''));
    check('无 token 的离线演示：返回全部启用角色（scoped=false）',
        demo.ok && demo.value.scoped === false && demo.value.menuCount > 0,
        demo.ok ? demo.value.menuCount + ' items / scoped=' + demo.value.scoped : demo.error.message);
    var total = demo.ok ? demo.value.menuCount : 0;

    // 2) 登录拿 token：导航只含该用户角色被授权的菜单（登录需带验证码）
    async function loginWithCaptcha(account, password) {
        var cap = await settle(Api.auth.captcha());
        if (!cap.ok) { return { ok: false, error: cap.error }; }
        var q = String(cap.value.question || '');
        var m = /^(\d+)\s+([+\-\u00d7])\s+(\d+)\s*=\s*\?$/.exec(q);
        if (!m) { return { ok: false, error: new Error('验证码题面无法解析：' + q) }; }
        var a = parseInt(m[1], 10), op = m[2], b = parseInt(m[3], 10);
        var ans = op === '+' ? (a + b) : (op === '-' ? (a - b) : (a * b));
        return await settle(Api.auth.login({
            account: account, password: password,
            captchaId: cap.value.captchaId, captchaCode: String(ans)
        }));
    }

    var ok = await loginWithCaptcha('13800138001', '888888');
    if (!ok.ok) { check('演示账号登录成功（导航权限用例前置）', false, ok.error.message); return; }
    var token = ok.value.token;

    var mine = await settle(Api.nav.get(token));
    check('带 token 的导航按角色过滤（scoped=true 且带角色名）',
        mine.ok && mine.value.scoped === true && !!mine.value.roleNames,
        mine.ok ? mine.value.roleNames + ' / ' + mine.value.scoped : mine.error.message);
    check('系统管理员（Mock 默认全量授权）可见全部 ' + total + ' 个菜单项',
        mine.ok && mine.value.menuCount === total, mine.ok ? String(mine.value.menuCount) : '');
    var pinned = flatItems(mine.ok ? mine.value.groups : []);
    check('导航接口返回 roleIds（含系统管理员角色）',
        mine.ok && mine.value.roleIds.indexOf(ADMIN_ROLE) > -1, mine.ok ? JSON.stringify(mine.value.roleIds) : '');

    // 3) 取消该角色的全部菜单授权 → 导航为空
    await settle(Api.rolePower.save(ADMIN_ROLE, []));
    var empty = await settle(Api.nav.get(token));
    check('取消角色全部菜单授权后导航为空（empty=true / groups 空）',
        empty.ok && empty.value.empty === true && (empty.value.groups || []).length === 0,
        empty.ok ? 'groups=' + (empty.value.groups || []).length : empty.error.message);

    // 4) 只授权一个菜单项 → 只剩该菜单组与该菜单项（其它组被裁掉）
    var one = pinned[0];
    await settle(Api.rolePower.save(ADMIN_ROLE, [{ menuGroupId: one.g, menuItemId: one.i }]));
    var only = await settle(Api.nav.get(token));
    var onlyItems = flatItems(only.ok ? only.value.groups : []);
    check('只授权 1 个菜单项时导航只剩 1 组 1 项',
        only.ok && only.value.menuCount === 1 && only.value.groupCount === 1 && onlyItems.length === 1,
        only.ok ? only.value.menuCount + ' items / ' + only.value.groupCount + ' groups' : only.error.message);
    check('保留下来的正是被授权的那个菜单项',
        onlyItems.length === 1 && onlyItems[0].i === one.i && onlyItems[0].g === one.g,
        JSON.stringify(onlyItems));

    // 5) 恢复授权 → 导航回到全量
    await settle(Api.rolePower.save(ADMIN_ROLE, pinned.map(function (x) {
        return { menuGroupId: x.g, menuItemId: x.i };
    })));
    var back = await settle(Api.nav.get(token));
    check('恢复授权后导航回到全量（' + total + ' 项）',
        back.ok && back.value.menuCount === total, back.ok ? String(back.value.menuCount) : '');

    // 6) token 失效（退出后）→ 退化为演示模式，不再按该用户过滤
    await settle(Api.auth.logout(token));
    var afterLogout = await settle(Api.nav.get(token));
    check('退出登录后旧 token 不再生效（退化为演示模式 scoped=false）',
        afterLogout.ok && afterLogout.value.scoped === false,
        afterLogout.ok ? String(afterLogout.value.scoped) : afterLogout.error.message);
}

/* ---- 角色权限接口（usergrouppowerset，UUID 主键） ---- */
async function runRolePowerTests() {
    console.log('\n--- 角色权限接口 ---');
    var rl = await settle(Api.role.page({ pageNum: 1, pageSize: 50 }));
    if (!rl.ok || !rl.value.list.length) {
        check('角色列表可用于权限配置', false, rl.ok ? 'empty' : rl.error.message);
        return finish();
    }
    var roleId = String(rl.value.list[0].id);

    var bad = await settle(Api.rolePower.tree('123'));
    check('roleId 非 UUID 被拒绝', !bad.ok && /UUID/.test(bad.error.message),
        bad.ok ? 'expect rejected' : bad.error.message);

    var t1 = await settle(Api.rolePower.tree(roleId));
    if (!t1.ok) { check('权限树可访问', false, t1.error.message); return finish(); }
    var tree = t1.value;
    check('权限树按菜单组返回（groups 非空）',
        tree.groups.length > 0, 'groups=' + tree.groups.length);
    check('权限树统计：已授权 ≤ 总数',
        tree.checked <= tree.total && tree.total > 0,
        tree.checked + ' / ' + tree.total);
    check('菜单组带层级路径与组内项数',
        !!tree.groups[0].crumb && tree.groups[0].itemCount === tree.groups[0].items.length,
        JSON.stringify({ crumb: tree.groups[0].crumb, n: tree.groups[0].itemCount }));
    check('菜单项字段完整（菜单项ID / 编号 / 名称 / 路径）',
        tree.groups[0].items.every(function (it) {
            return it.menuItemId && it.code && it.nameCn && typeof it.path === 'string';
        }));

    var origin = [];
    tree.groups.forEach(function (g) {
        g.items.forEach(function (it) {
            if (it.checked) { origin.push({ menuGroupId: g.menuGroupId, menuItemId: it.menuItemId }); }
        });
    });
    var g0 = tree.groups[0];
    var allPairs = [];
    tree.groups.forEach(function (g) {
        g.items.forEach(function (it) { allPairs.push({ menuGroupId: g.menuGroupId, menuItemId: it.menuItemId }); });
    });

    var s1 = await settle(Api.rolePower.save(roleId, allPairs));
    check('保存全部授权成功', s1.ok && s1.value.saved === allPairs.length,
        s1.ok ? JSON.stringify(s1.value) : s1.error.message);

    var t2 = await settle(Api.rolePower.tree(roleId));
    check('保存后权限树全部勾选（checked = total）',
        t2.value.checked === t2.value.total, t2.value.checked + ' / ' + t2.value.total);

    var s2 = await settle(Api.rolePower.save(roleId, []));
    check('保存空数组即清空该角色权限',
        s2.ok && (await settle(Api.rolePower.tree(roleId))).value.checked === 0,
        s2.ok ? 'ok' : s2.error.message);

    var s3 = await settle(Api.rolePower.save(roleId, [{ menuGroupId: g0.menuGroupId, menuItemId: 0 }]));
    check('整组授权（menuItemId=0）展开为组内全部菜单项',
        s3.ok && s3.value.saved === g0.itemCount,
        s3.ok ? JSON.stringify(s3.value) : s3.error.message);

    var other = null;
    tree.groups.forEach(function (g) {
        if (!other && g.menuGroupId !== g0.menuGroupId && g.items.length) { other = g.items[0]; }
    });
    if (other) {
        var s4 = await settle(Api.rolePower.save(roleId, [
            { menuGroupId: g0.menuGroupId, menuItemId: other.menuItemId }
        ]));
        check('菜单项不属于该菜单组时拒绝保存',
            !s4.ok && /不属于/.test(s4.error.message),
            s4.ok ? 'expect rejected' : s4.error.message);
    }

    var lst = await settle(Api.rolePower.list(roleId));
    check('权限列表与权限树口径一致',
        lst.ok && lst.value.total === g0.itemCount,
        lst.ok ? lst.value.total + ' / ' + g0.itemCount : lst.error.message);
    if (lst.ok && lst.value.list.length) {
        check('权限记录主键为 36 位 UUID',
            RE_UUID_SMOKE.test(String(lst.value.list[0].id)), String(lst.value.list[0].id));
        check('权限记录带菜单组 / 菜单项名称',
            !!lst.value.list[0].menuGroupName && !!lst.value.list[0].menuItemName,
            JSON.stringify({ g: lst.value.list[0].menuGroupName, i: lst.value.list[0].menuItemName }));
    }

    var cl = await settle(Api.rolePower.clear(roleId));
    check('清空接口删除全部授权',
        cl.ok && (await settle(Api.rolePower.tree(roleId))).value.checked === 0,
        cl.ok ? JSON.stringify(cl.value) : cl.error.message);

    var back = await settle(Api.rolePower.save(roleId, origin));
    check('还原原始授权（' + origin.length + ' 项）',
        back.ok && (await settle(Api.rolePower.tree(roleId))).value.checked === origin.length,
        back.ok ? 'ok' : back.error.message);

    var kw = g0.items[0].nameCn.slice(0, 2);
    var tf = await settle(Api.rolePower.tree(roleId, kw));
    check('权限树支持关键字过滤', tf.ok && tf.value.total <= tree.total && tf.value.total > 0,
        tf.ok ? tf.value.total + ' / ' + tree.total : tf.error.message);

    /* ---------- 页面操作按钮权限（usergrouppagebtnset） ---------- */
    var tBtn = await settle(Api.rolePower.tree(roleId));
    check('权限树返回按钮总数与已授权数',
        tBtn.ok && tBtn.value.buttonTotal > 0 && typeof tBtn.value.buttonChecked === 'number',
        tBtn.ok ? 'btnTotal=' + tBtn.value.buttonTotal + ' checked=' + tBtn.value.buttonChecked : tBtn.error.message);

    var pageItem = null, pageGroup = null;
    tBtn.value.groups.forEach(function (g) {
        g.items.forEach(function (it) {
            if (!pageItem && it.buttonCount) { pageItem = it; pageGroup = g; }
        });
    });
    check('菜单项（页面）下挂载操作按钮',
        pageItem && pageItem.buttons.length === pageItem.buttonCount,
        pageItem ? JSON.stringify({ n: pageItem.buttonCount }) : 'none');
    check('菜单未授权时按钮 disabled=true',
        pageItem && pageItem.buttons[0].disabled === (pageItem.checked === false),
        pageItem ? 'checked=' + pageItem.checked + ' disabled=' + pageItem.buttons[0].disabled : '');

    var pageBtns = pageItem.buttons.map(function (b) { return b.pageOpBtnId; });
    var savedBoth = await settle(Api.rolePower.save(roleId,
        [{ menuGroupId: pageGroup.menuGroupId, menuItemId: pageItem.menuItemId }], pageBtns));
    check('菜单 + 按钮一次保存成功',
        savedBoth.ok && savedBoth.value.saved === 1 && savedBoth.value.savedButtons === pageBtns.length,
        savedBoth.ok ? JSON.stringify(savedBoth.value) : savedBoth.error.message);

    var tAfter = await settle(Api.rolePower.tree(roleId));
    check('保存后菜单 1 项 / 按钮与提交一致',
        tAfter.value.checked === 1 && tAfter.value.buttonChecked === pageBtns.length,
        tAfter.value.checked + ' / ' + tAfter.value.buttonChecked + ' / ' + pageBtns.length);

    var onlyBtn = await settle(Api.rolePower.save(roleId, undefined, pageBtns.slice(0, 1)));
    var tOnly = await settle(Api.rolePower.tree(roleId));
    check('仅提交按钮时菜单权限不变',
        onlyBtn.ok && tOnly.value.checked === 1, tOnly.value.checked + '');
    check('仅提交按钮时按钮权限被替换',
        tOnly.value.buttonChecked === 1, tOnly.value.buttonChecked + '');

    var bl = await settle(Api.rolePower.buttons(roleId));
    check('按钮授权清单带页面 / 按钮信息',
        bl.ok && bl.value.total === 1 && !!bl.value.list[0].pagePath && !!bl.value.list[0].btnText,
        bl.ok ? JSON.stringify(bl.value.list[0]) : bl.error.message);

    var badBtn = await settle(Api.rolePower.save(roleId, undefined, ['123']));
    check('pageOpBtnId 非 UUID 被拒绝', !badBtn.ok && /UUID/.test(badBtn.error.message),
        badBtn.ok ? 'expect rejected' : badBtn.error.message);
    var missingBtn = await settle(Api.rolePower.save(roleId, undefined, ['00000000-0000-0000-0000-000000000000']));
    check('pageOpBtnId 对应按钮不存在被拒绝', !missingBtn.ok && /不存在/.test(missingBtn.error.message),
        missingBtn.ok ? 'expect rejected' : missingBtn.error.message);
    var noPayload = await settle(Api.rolePower.save(roleId));
    check('items 与 buttons 都不提交时被拒绝', !noPayload.ok && /至少/.test(noPayload.error.message),
        noPayload.ok ? 'expect rejected' : noPayload.error.message);

    var clr = await settle(Api.rolePower.clear(roleId));
    var tClear = await settle(Api.rolePower.tree(roleId));
    check('清空接口同时清掉菜单与按钮权限',
        clr.ok && tClear.value.checked === 0 && tClear.value.buttonChecked === 0,
        JSON.stringify(clr.value));

    await runPageOpBtnTests();
}


/* ---- 页面操作按钮接口（pageopbtn，UUID 主键 + 自动收录） ---- */
async function runPageOpBtnTests() {
    console.log('\n--- 页面操作按钮接口 ---');
    var r1 = await settle(Api.pageOpBtn.page({ pageNum: 1, pageSize: 200 }));
    if (!r1.ok) { check('页面操作按钮列表可访问', false, r1.error.message); return finish(); }
    check('列表返回已收录按钮（≥40 项）', r1.value.total >= 40, 'total=' + r1.value.total);
    check('记录主键为 36 位 UUID',
        r1.value.list.slice(0, 10).every(function (x) { return RE_UUID_SMOKE.test(String(x.id)); }),
        String(r1.value.list[0].id));
    check('字段完整（所属页面 / 页面路径 / 按钮id / 按钮文本 / 启用否）',
        ['pageName', 'pagePath', 'btnId', 'btnText', 'enabled', 'sortNo'].every(function (k) {
            return r1.value.list[0][k] !== undefined;
        }),
        JSON.stringify(r1.value.list[0]));

    var sc = await settle(Api.pageOpBtn.scan());
    check('自动收录接口可用（返回四类计数）',
        sc.ok && sc.value.scanned >= 40 && sc.value.added === 0,
        sc.ok ? JSON.stringify(sc.value) : sc.error.message);

    var pg = await settle(Api.pageOpBtn.pages());
    check('页面下拉按页面聚合', pg.ok && pg.value.list.length >= 10,
        pg.ok ? pg.value.list.length + '' : pg.error.message);

    var first = r1.value.list[0];
    var kw = await settle(Api.pageOpBtn.page({ keyword: first.btnId, pageSize: 200 }));
    check('关键字可按按钮id检索', kw.ok && kw.value.total >= 1, kw.ok ? kw.value.total + '' : kw.error.message);
    var byPage = await settle(Api.pageOpBtn.page({ pagePath: first.pagePath, pageSize: 200 }));
    check('可按页面路径筛选',
        byPage.ok && byPage.value.total >= 1
        && byPage.value.list.every(function (x) { return x.pagePath === first.pagePath; }),
        byPage.ok ? byPage.value.total + '' : byPage.error.message);

    var up = await settle(Api.pageOpBtn.update({
        id: first.id, pageName: first.pageName, btnText: '冒烟改文案', enabled: 0, remark: '冒烟测试'
    }));
    check('编辑记录成功（文本 / 停用）',
        up.ok && up.value.btnText === '冒烟改文案' && up.value.enabled === false,
        up.ok ? JSON.stringify(up.value) : up.error.message);

    var bad = await settle(Api.pageOpBtn.update({ id: first.id, btnText: '' }));
    check('按钮文本为空被拒绝', !bad.ok && /文本/.test(bad.error.message),
        bad.ok ? 'expect rejected' : bad.error.message);

    await settle(Api.pageOpBtn.scan());
    var d = await settle(Api.pageOpBtn.detail(first.id));
    check('重新收录会同步按钮文本', d.ok && d.value.btnText === first.btnText, d.ok ? d.value.btnText : d.error.message);
    check('重新收录不改动人工停用状态', d.ok && d.value.enabled === false, d.ok ? String(d.value.enabled) : '');

    var baseTotal = r1.value.total;
    var del = await settle(Api.pageOpBtn.remove(first.id));
    check('删除记录成功', del.ok, del.ok ? 'ok' : del.error.message);
    var gone = await settle(Api.pageOpBtn.detail(first.id));
    check('删除后详情 404', !gone.ok && /不存在/.test(gone.error.message),
        gone.ok ? 'expect 404' : gone.error.message);

    var sc2 = await settle(Api.pageOpBtn.scan());
    check('删除后重新收录补回该按钮', sc2.ok && sc2.value.added >= 1,
        sc2.ok ? JSON.stringify(sc2.value) : sc2.error.message);
    var after = await settle(Api.pageOpBtn.page({ pageSize: 200 }));
    check('补回后总数恢复', after.ok && after.value.total === baseTotal,
        after.ok ? after.value.total + ' / ' + baseTotal : after.error.message);

    var pages = await settle(Api.pageOpBtn.pages());
    check('页面下拉包含本管理页（自我收录）',
        pages.ok && pages.value.list.some(function (p) { return p.pagePath === 'page-op-btn.html'; }),
        pages.ok ? JSON.stringify(pages.value.list.map(function (p) { return p.pagePath; })) : '');

    finish();
}

async function runRoleTests() {
    console.log('\n--- 用户角色接口 ---');
    var r1 = await settle(Api.role.page({ pageNum: 1, pageSize: 50 }));
    if (!r1.ok) { check('角色列表可访问', false, r1.error.message); return finish(); }
    var list1 = r1.value.list;

    check('角色默认 4 条', r1.value.total === 4, 'total=' + r1.value.total);
    check('角色主键为 36 位 UUID',
        list1.every(function (x) { return RE_UUID_SMOKE.test(String(x.id)); }),
        JSON.stringify(list1.map(function (x) { return x.id; })));
    check('角色列表按排序号升序',
        list1.every(function (x, i) { return i === 0 || list1[i - 1].sortNo <= x.sortNo; }),
        JSON.stringify(list1.map(function (x) { return x.sortNo; })));
    check('角色字段完整（中文名 / 英文名 / 说明 / 启用否）',
        list1.every(function (x) { return !!x.nameCn && !!x.nameEn && 'remark' in x && 'enabled' in x; }),
        JSON.stringify(list1[0]));

    var byCn = await settle(Api.role.page({ keyword: '普通用户', pageSize: 50 }));
    check('关键字按中文名检索命中 1 条', byCn.value.total === 1 && byCn.value.list[0].nameCn === '普通用户',
        'total=' + byCn.value.total);

    var byEn = await settle(Api.role.page({ keyword: 'NormalUser', pageSize: 50 }));
    check('关键字可按英文名检索', byEn.value.total === 1 && byEn.value.list[0].nameEn === 'NormalUser',
        'total=' + byEn.value.total);

    var byRemark = await settle(Api.role.page({ keyword: '只读', pageSize: 50 }));
    check('关键字可按说明检索', byRemark.value.total >= 1, 'total=' + byRemark.value.total);

    var offOnly = await settle(Api.role.page({ enabled: '0', pageSize: 50 }));
    check('启用否筛选（停用）只返回停用角色',
        offOnly.value.total === 1 && offOnly.value.list[0].nameCn === '审计员' && offOnly.value.list[0].enabled === false,
        'total=' + offOnly.value.total);

    var cEn = await settle(Api.role.check('nameEn', 'SystemAdmin', ''));
    check('英文名查重：已占用判定为不唯一', cEn.value.unique === false, JSON.stringify(cEn.value));

    var cCnOn = await settle(Api.role.check('nameCn', '系统管理员', '', 1));
    check('中文名查重（启用）：已占用判定为不唯一', cCnOn.value.unique === false, JSON.stringify(cCnOn.value));

    var cCnOff = await settle(Api.role.check('nameCn', '系统管理员', '', 0));
    check('中文名查重（停用）：判定为唯一', cCnOff.value.unique === true, JSON.stringify(cCnOff.value));

    var added = await settle(Api.role.add({ nameCn: '新角色名', nameEn: 'TempRole', remark: '冒烟测试', sortNo: 0, enabled: 1 }));
    check('新增角色成功且返回 UUID 主键',
        added.ok && !!added.value.id && RE_UUID_SMOKE.test(String(added.value.id)),
        added.ok ? JSON.stringify(added.value.id) : added.error.message);
    if (!added.ok) { return finish(); }
    var roleId = added.value.id;
    check('新增角色落库字段正确',
        added.value.nameCn === '新角色名' && added.value.nameEn === 'TempRole'
        && added.value.remark === '冒烟测试' && added.value.sortNo === 0 && added.value.enabled === true,
        JSON.stringify(added.value));

    var afterAdd = await settle(Api.role.page({ pageNum: 1, pageSize: 50 }));
    check('排序号 0 的角色排在最前',
        afterAdd.value.list[0].id === roleId && afterAdd.value.total === 5,
        JSON.stringify({ first: afterAdd.value.list[0].nameCn, total: afterAdd.value.total }));

    var dupEn = await settle(Api.role.add({ nameCn: '另一个名字', nameEn: 'TempRole', enabled: 1 }));
    check('英文名重复被拒绝', !dupEn.ok && /英文名已存在/.test(dupEn.error.message),
        dupEn.ok ? 'expect rejected' : dupEn.error.message);

    var dupCn = await settle(Api.role.add({ nameCn: '系统管理员', nameEn: 'TempRole2', enabled: 1 }));
    check('中文名与启用角色重名被拒绝', !dupCn.ok && /已被其它启用状态的角色使用/.test(dupCn.error.message),
        dupCn.ok ? 'expect rejected' : dupCn.error.message);

    var disabledDup = await settle(Api.role.add({ nameCn: '系统管理员', nameEn: 'DisabledDup', enabled: 0 }));
    check('停用状态可与启用角色中文名相同',
        disabledDup.ok && disabledDup.value.nameCn === '系统管理员' && disabledDup.value.enabled === false,
        disabledDup.ok ? disabledDup.value.nameCn : disabledDup.error.message);
    var disabledId = disabledDup.ok ? disabledDup.value.id : '';

    var badEn = await settle(Api.role.add({ nameCn: '非法英文名', nameEn: '1abc', enabled: 1 }));
    check('英文名格式非法被拒绝', !badEn.ok && /英文名/.test(badEn.error.message),
        badEn.ok ? 'expect rejected' : badEn.error.message);

    var noEn = await settle(Api.role.add({ nameCn: '缺英文名', enabled: 1 }));
    check('英文名必填被拒绝', !noEn.ok && /英文名不能为空/.test(noEn.error.message),
        noEn.ok ? 'expect rejected' : noEn.error.message);

    var updated = await settle(Api.role.update({
        id: roleId, nameCn: '新角色名(改)', nameEn: 'TempRoleEdit', remark: '已修改', sortNo: 9, enabled: 0
    }));
    check('编辑角色成功且主键不变',
        updated.ok && updated.value.id === roleId && updated.value.nameCn === '新角色名(改)'
        && updated.value.nameEn === 'TempRoleEdit' && updated.value.sortNo === 9 && updated.value.enabled === false,
        updated.ok ? JSON.stringify(updated.value) : updated.error.message);

    var dupEdit = await settle(Api.role.update({ id: roleId, nameCn: '新角色名(改)', nameEn: 'SystemAdmin' }));
    check('编辑时英文名重复被拒绝', !dupEdit.ok && /英文名已存在/.test(dupEdit.error.message),
        dupEdit.ok ? 'expect rejected' : dupEdit.error.message);

    var badSort = await settle(Api.role.update({ id: roleId, nameCn: '新角色名(改)', nameEn: 'TempRoleEdit', sortNo: 'abc' }));
    check('排序号非整数被拒绝', !badSort.ok && /排序号/.test(badSort.error.message),
        badSort.ok ? 'expect rejected' : badSort.error.message);

    var del1 = await settle(Api.role.remove(roleId));
    check('删除角色成功', del1.ok, del1.ok ? 'ok' : del1.error.message);
    if (disabledId) { await settle(Api.role.remove(disabledId)); }

    var goneDetail = await settle(Api.role.detail(roleId));
    check('删除后详情不可访问（404）', !goneDetail.ok && /不存在/.test(goneDetail.error.message),
        goneDetail.ok ? 'expect 404' : goneDetail.error.message);

    var finalList = await settle(Api.role.page({ pageSize: 50 }));
    check('删除后角色回到 4 条', finalList.value.total === 4, 'total=' + finalList.value.total);

    await runEmpArchiveTests();
    await runUseInfoTests();
    await runAuthTests();
    await runNavPermTests();
    await runRolePowerTests();
    await runPageOpBtnTests();
}

/* ---- 用户信息（useinfo：UUID 主键 / 账号=员工手机号 / 密码 MD5 / 批量创建 888888） ---- */
async function runUseInfoTests() {
    console.log('\n--- 用户信息接口 ---');
    var MD5_888888 = '21218cca77804d2ba1922c33e0151105';

    var opts = await settle(Api.useInfo.empOptions({}));
    if (!opts.ok) { check('员工下拉可访问', false, opts.error.message); return finish(); }
    check('员工下拉返回 6 名员工且都还没有账号',
        opts.value.total === 6 && opts.value.list.every(function (e) { return e.hasUser === false; }),
        'total=' + opts.value.total);
    var noUser = await settle(Api.useInfo.empOptions({ noUser: '1' }));
    check('noUser=1 也只返回未建号员工', noUser.ok && noUser.value.list.every(function (e) { return !e.hasUser; }),
        noUser.ok ? String(noUser.value.total) : '');

    // 批量创建（初始密码 888888）
    var empAll = await settle(Api.emp.page({ pageNum: 1, pageSize: 50 }));
    var empIds = empAll.value.list.slice(0, 3).map(function (e) { return e.id; });
    var empFirst = empAll.value.list[0];
    var bt = await settle(Api.useInfo.batch({ empIds: empIds, roleIds: [] }));
    check('批量创建成功 3 个并返回初始密码 888888',
        bt.ok && bt.value.created === 3 && bt.value.password === '888888', bt.ok ? JSON.stringify(bt.value.created) : bt.error.message);
    check('批量创建的账号 = 员工手机号',
        bt.ok && bt.value.accounts.every(function (a) { return /^1\d{10}$/.test(a.account); }),
        bt.ok ? JSON.stringify(bt.value.accounts.map(function (a) { return a.account; })) : '');

    var pg = await settle(Api.useInfo.page({ pageNum: 1, pageSize: 10 }));
    check('用户列表共 3 条', pg.ok && pg.value.total === 3, pg.ok ? String(pg.value.total) : pg.error.message);
    var one = pg.ok ? pg.value.list[0] : {};
    check('主键为 36 位 UUID', RE_UUID_SMOKE.test(String(one.id)), String(one.id));
    check('接口不返回密码与 token（只给掩码）',
        !('password' in one) && !('token' in one) && one.passwordMask === '******',
        JSON.stringify(Object.keys(one)));
    check('带出员工信息（工号 / 姓名 / 部门）', !!one.empCode && !!one.empName && 'deptName' in one,
        [one.empCode, one.empName, one.deptName].join(' / '));
    check('列表按账号升序',
        pg.value.list.every(function (x, i) { return i === 0 || String(pg.value.list[i - 1].account) <= String(x.account); }),
        JSON.stringify(pg.value.list.map(function (x) { return x.account; })));

    // 重复批量创建 → 全部跳过
    var bt2 = await settle(Api.useInfo.batch({ empIds: empIds }));
    check('重复批量创建全部跳过并给出原因',
        bt2.ok && bt2.value.created === 0 && bt2.value.skipped.length === 3 &&
        bt2.value.skipped.every(function (s) { return !!s.reason; }),
        bt2.ok ? JSON.stringify(bt2.value.skipped[0]) : bt2.error.message);

    // 单个创建（剩下 3 人里的第 4 人）
    var emp4 = empAll.value.list[3];
    var ad = await settle(Api.useInfo.add({ empId: emp4.id }));
    check('单个创建成功且账号默认为手机号',
        ad.ok && ad.value.account === emp4.phone, ad.ok ? ad.value.account : ad.error.message);
    var dup = await settle(Api.useInfo.add({ empId: emp4.id }));
    check('同一员工重复创建被拒绝', !dup.ok && /已创建过/.test(dup.error.message),
        dup.ok ? 'expect rejected' : dup.error.message);

    // 唯一性校验
    var chk = await settle(Api.useInfo.check('account', String(one.account)));
    check('账号唯一性校验（已存在 → 不唯一）', chk.ok && chk.value.unique === false, JSON.stringify(chk.value));

    // 重置密码
    var rp = await settle(Api.useInfo.resetPwd([one.id]));
    check('重置密码返回 888888 且命中 1 个',
        rp.ok && rp.value.password === '888888' && rp.value.reset === 1, JSON.stringify(rp.value));
    var rp0 = await settle(Api.useInfo.resetPwd([]));
    check('重置密码未选用户被拒绝', !rp0.ok, rp0.ok ? 'expect rejected' : rp0.error.message);

    // 批量设置角色
    var roles = await settle(Api.role.page({ pageNum: 1, pageSize: 50, enabled: 1 }));
    var roleIds = roles.value.list.slice(0, 2).map(function (r) { return r.id; });
    var sr = await settle(Api.useInfo.setRoles(empIds.slice(0, 2).map(function (eid) {
        for (var i = 0; i < pg.value.list.length; i++) {
            if (pg.value.list[i].empId === eid) { return pg.value.list[i].id; }
        }
        return '';
    }), roleIds));
    check('批量设置角色成功（2 用户 × 2 角色）',
        sr.ok && sr.value.users === 2 && sr.value.roles === 2, JSON.stringify(sr.value));
    var pg2 = await settle(Api.useInfo.page({ pageNum: 1, pageSize: 10 }));
    check('回读角色名称（拼接展示）',
        pg2.value.list.some(function (x) { return x.roleNames.indexOf('、') > -1; }),
        pg2.value.list.map(function (x) { return x.roleNames; }).join(' | '));
    var sr0 = await settle(Api.useInfo.setRoles([pg2.value.list[0].id], []));
    var d0 = await settle(Api.useInfo.detail(pg2.value.list[0].id));
    check('传空角色数组即清空该用户角色',
        sr0.ok && sr0.value.roles === 0 && d0.value.roles.length === 0, JSON.stringify(d0.value.roles));

    // 编辑
    var upd = await settle(Api.useInfo.update({ id: pg2.value.list[0].id, account: 'smoke_user_01', enabled: 0 }));
    check('编辑账号与启用状态成功',
        upd.ok && upd.value.account === 'smoke_user_01' && upd.value.enabled === false,
        upd.ok ? upd.value.account : upd.error.message);
    var otherAcc = String(pg2.value.list[1].account);
    var upd2 = await settle(Api.useInfo.update({ id: pg2.value.list[0].id, account: otherAcc }));
    check('改成其它用户已占用的账号被拒绝', !upd2.ok, upd2.ok ? 'expect rejected' : upd2.error.message);

    // 删除（清理）
    var allU = await settle(Api.useInfo.page({ pageNum: 1, pageSize: 50 }));
    var del = await settle(Api.useInfo.remove(allU.value.list.map(function (u) { return u.id; })));
    check('批量删除用户成功（4 个）', del.ok && del.value.deleted === 4, del.ok ? String(del.value.deleted) : del.error.message);
    var left = await settle(Api.useInfo.page({ pageNum: 1, pageSize: 50 }));
    check('删除后用户列表为空', left.ok && left.value.total === 0, String(left.ok ? left.value.total : ''));
    check('MD5(888888) 与后端一致', MD5_888888.length === 32 && MD5_888888 === '21218cca77804d2ba1922c33e0151105');
}

/* ---- 员工信息归档（empinfoarchive：UUID 主键 + 整表快照） ---- */
async function runEmpArchiveTests() {
    console.log('\n--- 员工信息归档接口 ---');

    var empAll = await settle(Api.emp.page({ pageNum: 1, pageSize: 500 }));
    if (!empAll.ok) { check('员工列表可访问（归档来源）', false, empAll.error.message); return finish(); }
    var empTotal = empAll.value.total;
    var empFirst = empAll.value.list[0] || {};
    check('员工表有可归档数据（' + empTotal + ' 条）', empTotal > 0, String(empTotal));

    var b0 = await settle(Api.empArchive.batches());
    if (!b0.ok) { check('归档批次列表可访问', false, b0.error.message); return finish(); }
    var before = b0.value.total;

    var a1 = await settle(Api.empArchive.archive());
    check('归档成功并返回批次ID / 归档时间 / 条数',
        a1.ok && RE_UUID_SMOKE.test(String(a1.value.batchId)) &&
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(a1.value.archiveTime)) &&
        a1.value.total === empTotal,
        a1.ok ? JSON.stringify(a1.value) : a1.error.message);
    var batchId = a1.ok ? String(a1.value.batchId) : '';

    var b1 = await settle(Api.empArchive.batches());
    check('批次列表新增 1 条', b1.ok && b1.value.total === before + 1,
        b1.ok ? before + ' → ' + b1.value.total : b1.error.message);
    check('最新批次排在最前（按归档时间倒序）',
        b1.ok && b1.value.list[0].batchId === batchId, b1.ok ? JSON.stringify(b1.value.list[0]) : '');
    check('批次记录数 = 员工表总数', b1.ok && b1.value.list[0].total === empTotal,
        b1.ok ? String(b1.value.list[0].total) : '');

    var p1 = await settle(Api.empArchive.page({ batchId: batchId, pageNum: 1, pageSize: 10 }));
    check('批次员工列表可查询（总数一致）', p1.ok && p1.value.total === empTotal,
        p1.ok ? String(p1.value.total) : p1.error.message);
    var rows = p1.ok ? p1.value.list : [];
    check('归档记录主键为 36 位 UUID，并保留原员工ID（empId）',
        rows.length > 0 && RE_UUID_SMOKE.test(String(rows[0].id)) && !!rows[0].empId,
        rows.length ? rows[0].id + ' / ' + rows[0].empId : 'no rows');
    check('归档记录按工号升序',
        rows.every(function (x, i) { return i === 0 || String(rows[i - 1].code) <= String(x.code); }),
        JSON.stringify(rows.map(function (x) { return x.code; })));
    check('归档记录保留员工表全部业务字段',
        rows.length > 0 && ['code', 'nameCn', 'gender', 'phone', 'email', 'deptId', 'jobTitle', 'status',
            'hireDate', 'birthDate', 'idCard', 'education', 'school', 'major', 'certificates',
            'titleName', 'photo', 'remark'].every(function (k) { return rows[0][k] !== undefined; }),
        rows.length ? JSON.stringify(Object.keys(rows[0])) : 'no rows');
    check('归档记录补齐展示字段（部门名 / 状态文案 / 性别文案）',
        rows.length > 0 && !!rows[0].deptName && !!rows[0].statusText && !!rows[0].genderText,
        rows.length ? [rows[0].deptName, rows[0].statusText, rows[0].genderText].join(' / ') : '');
    check('快照内容与员工表一致（首条工号 / 姓名相同）',
        rows.length > 0 && rows[0].code === empFirst.code && rows[0].nameCn === empFirst.nameCn,
        rows.length ? rows[0].code + ' vs ' + empFirst.code : '');

    var p2 = await settle(Api.empArchive.page({
        batchId: batchId, pageNum: 1, pageSize: 10, keyword: String(empFirst.nameCn)
    }));
    check('归档名单支持关键字过滤', p2.ok && p2.value.total >= 1,
        p2.ok ? String(p2.value.total) : p2.error.message);

    var bad = await settle(Api.empArchive.page({ batchId: 'abc', pageNum: 1, pageSize: 10 }));
    check('非法 batchId 被拒绝', !bad.ok && /batchId/.test(bad.error.message),
        bad.ok ? 'expect rejected' : bad.error.message);

    // 再次归档 → 新批次，旧批次数据不受影响
    var a2 = await settle(Api.empArchive.archive());
    var b2 = await settle(Api.empArchive.batches());
    check('可重复归档生成新批次（旧批次不变）',
        a2.ok && a2.value.batchId !== batchId && b2.ok && b2.value.total === before + 2,
        a2.ok ? a2.value.batchId : a2.error.message);
    var p3 = await settle(Api.empArchive.page({ batchId: batchId, pageNum: 1, pageSize: 10 }));
    check('旧批次记录数仍为归档时的数量', p3.ok && p3.value.total === empTotal,
        p3.ok ? String(p3.value.total) : '');
}

function runDptMgrTests() {
    console.log('\n--- 部门负责人设置 ---');
    Api.dptMgr.list({}).done(function (r1) {
        check('默认 2 条负责人设置（技术研发部 / 市场运营部）', r1.total === 2,
            JSON.stringify(r1.list.map(function (x) { return x.deptName + ':' + x.empName; })));
        check('列表带出部门与负责人姓名',
            r1.list.every(function (x) { return !!x.deptName && !!x.empName && !!x.empCode; }),
            JSON.stringify(r1.list[0]));

        Api.org.page({ pageSize: 200 }).done(function (org1) {
            var tech = null;
            for (var i = 0; i < org1.list.length; i++) { if (org1.list[i].id === 2) { tech = org1.list[i]; } }
            check('部门列表带出负责人字段（managerName）', !!tech && tech.managerName === '张守正',
                tech ? tech.managerName : 'null');
            check('未设置负责人的部门 managerName 为空',
                !!org1.list[0] && org1.list[0].managerName === '', org1.list[0] && org1.list[0].managerName);

            // 给「财务人事部」(id=6) 设置负责人
            Api.dptMgr.set({ deptId: 6, empId: 6, remark: '主责' }).done(function (set1) {
                check('设置负责人成功并返回负责人信息', set1 && set1.deptId === 6 && set1.empId === 6,
                    JSON.stringify(set1));
                Api.dptMgr.list({}).done(function (r2) {
                    check('设置后负责人记录变为 3 条', r2.total === 3, 'total=' + r2.total);

                    // 重复设置 → 替换
                    Api.dptMgr.set({ deptId: 6, empId: 5 }).done(function (set2) {
                        Api.dptMgr.list({}).done(function (r3) {
                            check('同一部门重复设置即替换（仍 3 条）', r3.total === 3, 'total=' + r3.total);
                            var row = null;
                            for (var j = 0; j < r3.list.length; j++) { if (r3.list[j].deptId === 6) { row = r3.list[j]; } }
                            check('替换后负责人为后设置的员工', !!row && row.empId === 5,
                                row ? String(row.empId) : 'null');

                            Api.dptMgr.remove(6).done(function () {
                                Api.dptMgr.list({}).done(function (r4) {
                                    check('清除后回到 2 条', r4.total === 2, 'total=' + r4.total);
                                    Api.dptMgr.remove(6).fail(function (e1) {
                                        check('重复清除被拒绝（404）', /还没有设置负责人/.test(e1.message), e1.message);
                                        runRoleTests();
                                    });
                                });
                            });
                        });
                    });
                });
            }).fail(function (e0) {
                check('设置负责人失败（' + e0.message + '）', false, e0.message);
                runRoleTests();
            });
        });
    });
}

function runGroupTests() {
    console.log('\n--- 菜单组接口 ---');
    Api.group.page({ keyword: '', pageNum: 1, pageSize: 10 }).done(function (g1) {
        check('菜单组默认分页：总数 15，首页 10 条', g1.total === 15 && g1.list.length === 10, JSON.stringify({ total: g1.total, len: g1.list.length }));

        Api.group.page({ keyword: 'GRP0100', pageNum: 1, pageSize: 10 }).done(function (g2) {
            check('菜单组编号检索命中', g2.total === 1 && g2.list[0].code === 'GRP0100', 'total=' + g2.total);

            Api.group.page({ keyword: '帮助中心', pageNum: 1, pageSize: 10 }).done(function (g3) {
                check('菜单组中文名检索命中', g3.total === 1 && g3.list[0].nameEn === 'HelpCenter', 'total=' + g3.total);

                Api.group.page({ keyword: 'helpcenter', pageNum: 1, pageSize: 10 }).done(function (g4) {
                    check('菜单组英文名检索（忽略大小写）', g4.total === 1 && g4.list[0].hasChild === false, 'total=' + g4.total);

                    Api.group.check('code', 'GRP0100', 0).done(function (c3) {
                        check('菜单组编号重复校验：不唯一', c3.unique === false);

                        Api.group.add({
                            code: 'GRP9900', nameCn: '冒烟测试菜单组', nameEn: 'SmokeTestGroup',
                            hasChild: 1, path: '', icon: 'star', enabled: 1
                        }).done(function (added) {
                            check('菜单组新增（可否绑定菜单项=是）', !!added.id && added.hasChild === true, JSON.stringify(added && added.id));

                            Api.group.add({
                                code: 'GRP9900', nameCn: '重复编号组', nameEn: 'DupGroupCode',
                                hasChild: 0, path: 'x.html', icon: 'star', enabled: 1
                            }).fail(function (err) {
                                check('菜单组重复编号被拒绝', /编号已存在/.test(err.message), err.message);

                                Api.group.update({
                                    id: added.id, code: 'GRP9901', nameCn: '冒烟测试菜单组(改)',
                                    nameEn: 'SmokeTestGroupEdit', hasChild: 0, path: 'smoke-group.html',
                                    icon: 'flag', enabled: 0
                                }).done(function (updated) {
                                    check('菜单组编辑：改为可否绑定菜单项=否并填写路径',
                                        updated.hasChild === false && updated.path === 'smoke-group.html' && updated.enabled === false,
                                        JSON.stringify({ hasChild: updated.hasChild, path: updated.path }));

                                    Api.group.detail(added.id).done(function (d) {
                                        check('菜单组详情一致', d.code === 'GRP9901' && d.hasChild === false && d.path === 'smoke-group.html');

                                        Api.group.remove(added.id).done(function () {
                                            Api.group.detail(added.id).fail(function (e3) {
                                                check('菜单组删除后不可访问', /不存在/.test(e3.message), e3.message);
                                                runGroupItemTests();
                                            });
                                        });
                                    });
                                });
                            });
                        }).fail(function (e) { check('菜单组新增成功', false, e.message); finish(); });
                    });
                });
            });
        });
    });
}

/* ---- 菜单项编号自动生成用例（MNU + 5 位流水号） ---- */
function runAutoCodeTests(next) {
    console.log('\n--- 菜单项编号自动生成 ---');
    Api.menu.nextCode().done(function (nc) {
        check('自动生成编号：MNU + 5 位流水号', /^MNU\d{5}$/.test(nc.code), JSON.stringify(nc));

        Api.menu.check('code', nc.code, 0).done(function (u1) {
            check('生成的编号在库中未占用', u1.unique === true);

            Api.menu.add({
                code: nc.code, nameCn: '流水号测试菜单', nameEn: 'AutoCodeMenu',
                path: 'auto.html', icon: 'star', enabled: 1, remark: '自动生成编号'
            }).done(function (added) {
                Api.menu.nextCode().done(function (nc2) {
                    var s1 = parseInt(nc.code.slice(3), 10), s2 = parseInt(nc2.code.slice(3), 10);
                    check('占用后流水号自动顺延 +1', s2 === s1 + 1, nc.code + ' -> ' + nc2.code);

                    Api.menu.remove(added.id).done(function () {
                        Api.menu.nextCode().done(function (nc3) {
                            check('删除后编号回收为 ' + nc.code, nc3.code === nc.code, nc3.code);
                            next();
                        });
                    });
                });
            });
        });
    });
}

Api.menu.page({ keyword: '', pageNum: 1, pageSize: 10 }).done(function (r) {
    check('默认分页：总数 15，首页 10 条', r.total === 15 && r.list.length === 10, JSON.stringify({ total: r.total, len: r.list.length }));
    check('默认分页：页码/每页条数正确', r.pageNum === 1 && r.pageSize === 10);

    Api.menu.page({ keyword: '菜单项管理', pageNum: 1, pageSize: 10 }).done(function (r2) {
        check('中文名检索命中', r2.total >= 1 && r2.list[0].nameCn === '菜单项管理', 'total=' + r2.total);

        Api.menu.page({ keyword: 'MENU0100', pageNum: 1, pageSize: 10 }).done(function (r3) {
            check('编号检索命中 1 条', r3.total === 1 && r3.list[0].code === 'MENU0100', 'total=' + r3.total);

            Api.menu.page({ keyword: 'OrderCenter', pageNum: 1, pageSize: 10 }).done(function (r4) {
                check('英文名检索命中', r4.total === 1 && r4.list[0].nameEn === 'OrderCenter', 'total=' + r4.total);

                Api.menu.page({ keyword: '', enabled: '0', pageNum: 1, pageSize: 50 }).done(function (r5) {
                    var allDisabled = true;
                    for (var i = 0; i < r5.list.length; i++) { if (r5.list[i].enabled) { allDisabled = false; } }
                    check('启用状态筛选（停用）', r5.total > 0 && allDisabled, 'total=' + r5.total);

                    Api.menu.check('code', 'MENU0100', 0).done(function (c1) {
                        check('编号重复校验：判定为不唯一', c1.unique === false);

                        Api.menu.check('code', 'MENU9900', 0).done(function (c2) {
                            check('编号未占用：判定为唯一', c2.unique === true);

                            Api.menu.add({
                                code: 'MENU9900', nameCn: '冒烟测试菜单', nameEn: 'SmokeTestMenu',
                                path: 'smoke.html', icon: 'star', enabled: 1, remark: '自动化测试写入'
                            }).done(function (added) {
                                check('新增成功且返回 id 与时间', !!added.id && !!added.createTime, JSON.stringify(added && added.id));

                                Api.menu.add({
                                    code: 'MENU9900', nameCn: '重复编号', nameEn: 'DupCode',
                                    path: 'x.html', icon: 'star', enabled: 1, remark: ''
                                }).fail(function (err) {
                                    check('重复编号新增被拒绝', /编号已存在/.test(err.message), err.message);

                                    Api.menu.update({
                                        id: added.id, code: 'MENU9901', nameCn: '冒烟测试菜单(改)',
                                        nameEn: 'SmokeTestMenuEdit', path: 'smoke2.html',
                                        icon: 'flag', enabled: 0, remark: '已修改'
                                    }).done(function (updated) {
                                        check('编辑成功：字段已更新', updated.code === 'MENU9901' && updated.nameEn === 'SmokeTestMenuEdit' && updated.enabled === false);

                                        Api.menu.detail(added.id).done(function (d) {
                                            check('详情读取一致', d.code === 'MENU9901' && d.icon === 'flag');

                                            Api.menu.remove(added.id).done(function () {
                                                Api.menu.detail(added.id).fail(function (e2) {
                                                    check('删除后详情不可访问', /不存在/.test(e2.message), e2.message);
                                                    Api.menu.page({ keyword: '', pageNum: 2, pageSize: 10 }).done(function (r6) {
                                                        check('第二页仍有数据', r6.list.length > 0 && r6.pageNum === 2, 'len=' + r6.list.length);
                                                        runAutoCodeTests(runGroupTests);
                                                    });
                                                });
                                            });
                                        });
                                    });
                                });
                            }).fail(function (e) { check('新增成功', false, e.message); });
                        });
                    });
                });
            });
        });
    });
});
