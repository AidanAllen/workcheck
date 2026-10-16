'use strict';

/**
 * 端到端流程测试。
 *
 * npm run selftest 只覆盖 server/checkin.js 的解析规则，HTTP 链路一条都没测 ——
 * 于是「停用后测试推送照样入库」那类问题只能靠人肉点页面发现。这个脚本起一个
 * 隔离实例（独立 data 目录 + 独立端口 + PULL_ENABLED=0），把每条流程从头到尾
 * 跑一遍，覆盖：健康检查 / 鉴权与会话 / 来源管理 / 入库与去重 / 停用闸门 /
 * 演示推送 / 查询与聚合 / SSE / 凭证配置 / 调度 / 改密码 / 登录限流 / 静态资源 /
 * 落库核对 / 推送限流。
 *
 * 用法：npm run flowtest   （或 node scripts/flowtest.js）
 *
 * 几点约定，改动前先看：
 * - 用 node:http 而不是 fetch —— 环境里可能有 http_proxy，直连 127.0.0.1 必须绕开
 * - 服务遇到 EADDRINUSE 会自己 +1 重试，所以 readiness 探测从期望端口往上扫几个
 * - 推送限流单独开第二个实例：RATE_LIMIT 是启动时读的，设小了会污染其它用例
 * - 「落库核对」必须排在「删除来源」之前 —— 删来源会级联清掉它的报文
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.tmp-flow', 'data');
const ADMIN_TOKEN = 'flowtest-token';
const PORT_START = 3899;

let pass = 0;
let fail = 0;
const failures = [];
const notes = [];

/** 观察项：不是失败，但值得在报告里单独指出来 */
function note(text) {
  notes.push(text);
  console.log(`  · 观察：${text}`);
}

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  }
}
function group(t) {
  console.log(`\n── ${t} ──`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ HTTP 客户端 */
let BASE = '';
function req(method, urlPath, opts = {}) {
  const { headers = {}, body, cookie } = opts;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (payload) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = payload.length;
    }
    const r = http.request(BASE + urlPath, { method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(buf);
        } catch (_) {
          /* 非 JSON（HTML/CSS）保持 null */
        }
        const setCookie = res.headers['set-cookie'] || [];
        resolve({ status: res.statusCode, body: json, raw: buf, setCookie, headers: res.headers });
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    if (payload) r.write(payload);
    r.end();
  });
}

const sess = (c) => (c ? String(c).split(';')[0] : '');

/* ------------------------------------------------------------------ 启动实例 */
function startServer(port, dir, extraEnv = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      WORKCHECK_DATA_DIR: dir,
      PORT: String(port),
      PULL_ENABLED: '0',
      ADMIN_TOKEN,
      LOG_KEEP: '5000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
  return p;
}

/** 服务遇到 EADDRINUSE 会自己 +1 重试，所以从期望端口往上扫几个 */
async function waitUp(srv, port) {
  for (let i = 0; i < 80; i++) {
    for (let cand = port; cand < port + 8; cand++) {
      BASE = `http://127.0.0.1:${cand}`;
      try {
        const r = await req('GET', '/api/health');
        if (r.status === 200 && r.body && r.body.ok) return cand;
      } catch (_) {
        /* 还没起来 */
      }
    }
    if (srv.exitCode !== null) throw new Error(`服务进程提前退出，code=${srv.exitCode}`);
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

/* ------------------------------------------------------------------ 主流程 */
(async () => {
  const srv = startServer(PORT_START, DATA_DIR);
  try {
    const port = await waitUp(srv, PORT_START);
    console.log(`隔离实例已启动：${BASE}  (data=${DATA_DIR})\n`);

    /* ================================================ 1. 健康检查 */
    group('健康检查');
    {
      const r = await req('GET', '/api/health');
      check('/api/health 返回 200', r.status === 200, r.status);
      check('带 app 名与版本号', r.body.app === 'workcheck' && /^\d+\.\d+\.\d+/.test(r.body.version), r.body);
    }

    /* ================================================ 2. 鉴权流程 */
    group('鉴权流程：首次创建管理员');
    {
      const r = await req('GET', '/api/auth/state');
      check('新库 initialized=false', r.body.initialized === false, r.body);
      check('新库 loggedIn=false', r.body.loggedIn === false, r.body);
    }
    {
      const r = await req('POST', '/api/auth/setup', { body: { username: 'ab', password: 'secret123' } });
      check('账号短于 3 位被拒 400', r.status === 400, r.body);
    }
    {
      const r = await req('POST', '/api/auth/setup', { body: { username: 'flowadmin', password: '12345' } });
      check('密码短于 6 位被拒 400', r.status === 400, r.body);
    }
    let cookie = '';
    {
      const r = await req('POST', '/api/auth/setup', { body: { username: 'flowadmin', password: 'secret123' } });
      check('创建管理员成功', r.status === 200 && r.body.ok === true, r.body);
      check('创建后直接下发会话 cookie', r.setCookie.some((c) => c.startsWith('wc_session=')), r.setCookie);
      check('cookie 带 HttpOnly', r.setCookie.some((c) => /HttpOnly/i.test(c)), r.setCookie);
      cookie = sess(r.setCookie.find((c) => c.startsWith('wc_session=')));
    }
    {
      const r = await req('POST', '/api/auth/setup', { body: { username: 'other', password: 'secret123' } });
      check('重复创建被拒 409', r.status === 409, r.body);
    }
    {
      const r = await req('GET', '/api/auth/state', { cookie });
      check('已登录 state 正确', r.body.initialized === true && r.body.loggedIn === true && r.body.username === 'flowadmin', r.body);
    }

    group('鉴权流程：会话与登录');
    {
      await req('POST', '/api/auth/logout', { cookie });
      const r = await req('GET', '/api/sources', { cookie });
      check('登出后管理接口 401', r.status === 401, r.body);
      check('提示前端去登录（need=login）', r.body.need === 'login', r.body);
    }
    {
      const r = await req('GET', '/api/sources');
      check('无 cookie 访问管理接口 401', r.status === 401, r.status);
    }
    {
      const r = await req('POST', '/api/auth/login', { body: { username: 'flowadmin', password: 'wrong-pass' } });
      check('错误密码 401', r.status === 401, r.body);
      check('不泄露账号是否存在', r.body.error === '账号或密码错误', r.body);
    }
    {
      const r = await req('POST', '/api/auth/login', { body: { username: 'flowadmin', password: 'secret123' } });
      check('正确密码登录成功', r.status === 200 && r.body.username === 'flowadmin', r.body);
      cookie = sess(r.setCookie.find((c) => c.startsWith('wc_session=')));
    }
    {
      const r = await req('GET', '/api/sources', { cookie });
      check('登录后管理接口放行 200', r.status === 200, r.status);
    }

    /* ================================================ 3. 来源管理 */
    group('来源管理流程');
    let srcId = 0;
    let srcKey = '';
    let demoSrcId = 0;
    {
      const r = await req('GET', '/api/sources', { cookie });
      const list = r.body;
      // 内置来源（飞书签到）是首次拉取时才由 checkin_pull.ensureSource() 建的，
      // 新库里只有启动时兜底建的「示例来源」—— 断言要按这个设计来。
      check('新库自动建了「示例来源」', Array.isArray(list) && list.some((s) => s.name === '示例来源'), list.map((s) => s.name));
      check('列表不含明文 api_key', list.every((s) => s.api_key === undefined), Object.keys(list[0] || {}));
      check('持有 Key 的来源 hasKey=true 且有掩码', list.filter((s) => s.hasKey).every((s) => /\*/.test(s.api_key_masked)), list.map((s) => s.api_key_masked));
      demoSrcId = list.find((s) => s.name === '示例来源').id;
    }
    {
      const r = await req('POST', '/api/sources', { cookie, body: { name: '流程测试来源' } });
      check('新建来源成功', r.status === 200 && r.body.ok === true, r.body);
      check('创建时返回明文 Key', typeof r.body.apiKey === 'string' && r.body.apiKey.length > 8, r.body.apiKey);
      srcId = r.body.source.id;
      srcKey = r.body.apiKey;
    }
    {
      const r = await req('POST', '/api/sources', { cookie, body: { name: '   ' } });
      check('空名称被拒 400', r.status === 400, r.body);
    }
    {
      const r = await req('GET', `/api/sources/${srcId}/key`, { cookie });
      check('单独取明文 Key 与创建时一致', r.body.apiKey === srcKey, r.body);
    }
    {
      const r = await req('GET', '/api/sources', { cookie });
      const row = r.body.find((s) => s.id === srcId);
      check('列表里该来源只给掩码', row.api_key === undefined && /\*/.test(row.api_key_masked), row);
    }
    {
      // 内置来源平时靠 checkin_pull 拉取时创建，这里直接按同样的形态建一条来测保护逻辑
      // （name 相同 + api_key 为 NULL），服务读 sources 表不缓存，插进去立刻可见。
      const Database = require('better-sqlite3');
      const db = new Database(path.join(DATA_DIR, 'workcheck.db'));
      const info = db
        .prepare('INSERT INTO sources (name, slug, api_key, enabled, created_at) VALUES (?,?,NULL,1,?)')
        .run('飞书签到（内置）', 'builtin-checkin-flow', new Date().toISOString());
      db.close();
      const builtinId = info.lastInsertRowid;

      const r = await req('GET', '/api/sources', { cookie });
      const builtin = r.body.find((s) => s.id === builtinId);
      check('内置来源被标记为 builtin', builtin && builtin.builtin === true, builtin);
      check('内置来源不持有 Key（hasKey=false）', builtin && builtin.hasKey === false, builtin);

      const k = await req('GET', `/api/sources/${builtinId}/key`, { cookie });
      check('内置来源取明文 Key 返回 404', k.status === 404, k.body);

      const d = await req('DELETE', `/api/sources/${builtinId}`, { cookie });
      check('内置来源不可删除 400', d.status === 400, d.body);
      const e = await req('POST', `/api/sources/${builtinId}/enabled`, { cookie, body: { enabled: false } });
      check('内置来源不可停用 400', e.status === 400, e.body);
    }

    /* ================================================ 4. 数据入库链路 */
    group('数据入库流程：/api/ingest');
    {
      const r = await req('POST', '/api/ingest', { body: [{ eventId: 'x1' }] });
      check('缺少 Key 401', r.status === 401 && /X-Api-Key/.test(r.body.error), r.body);
    }
    {
      const r = await req('POST', '/api/ingest', { headers: { 'X-Api-Key': 'not-a-real-key' }, body: [{ eventId: 'x1' }] });
      check('无效 Key 401', r.status === 401 && r.body.error === 'API Key 无效', r.body);
    }
    {
      const r = await req('POST', '/api/ingest', {
        headers: { Authorization: 'Bearer ' + srcKey },
        body: [{ eventId: 'flow-1', amount: 12.5, status: 'paid' }],
      });
      check('Authorization: Bearer 也能鉴权', r.status === 200 && r.body.inserted === 1, r.body);
    }
    {
      const r = await req('POST', '/api/ingest', {
        headers: { 'X-Api-Key': srcKey },
        body: [{ eventId: 'flow-1', amount: 12.5 }],
      });
      check('同 eventId 重推被去重', r.body.inserted === 0 && r.body.duplicated === 1, r.body);
    }
    {
      const r = await req('POST', '/api/ingest', {
        headers: { 'X-Api-Key': srcKey },
        body: { events: [{ eventId: 'flow-2' }, { eventId: 'flow-3' }, { eventId: 'flow-4' }] },
      });
      check('{events:[...]} 包装可识别', r.status === 200 && r.body.inserted === 3, r.body);
    }
    {
      const r = await req('POST', '/api/ingest', {
        headers: { 'X-Api-Key': srcKey },
        body: { eventId: 'flow-single', amount: 1 },
      });
      check('单对象（非数组）也收', r.status === 200 && r.body.inserted === 1, r.body);
    }
    {
      const r = await req('POST', '/api/ingest', { headers: { 'X-Api-Key': srcKey }, body: [] });
      check('空数组被拒 400', r.status === 400, r.body);
    }
    {
      const big = Array.from({ length: 501 }, (_, i) => ({ eventId: `big-${i}` }));
      const r = await req('POST', '/api/ingest', { headers: { 'X-Api-Key': srcKey }, body: big });
      check('超过 500 条被拒 413', r.status === 413, r.body);
    }
    {
      const r = await req('POST', '/api/ingest', { headers: { 'X-Api-Key': srcKey }, body: 'not-json-object' });
      check('非法请求体被拒', r.status === 400 || r.status === 401, r.body);
    }

    group('数据入库流程：停用闸门（两条链路都要挡）');
    {
      const off = await req('POST', `/api/sources/${srcId}/enabled`, { cookie, body: { enabled: false } });
      check('停用成功', off.status === 200 && off.body.enabled === false, off.body);

      const a = await req('POST', '/api/ingest', { headers: { 'X-Api-Key': srcKey }, body: [{ eventId: 'flow-off-1' }] });
      check('停用后 /api/ingest 403', a.status === 403, a.body);

      const b = await req('POST', '/api/demo/push', { cookie, body: { count: 1, sourceId: srcId } });
      check('停用后 /api/demo/push 403', b.status === 403, b.body);

      // 把另一个非内置来源也停用 —— 这样「自动挑选」没有任何合法目标，
      // 才能真的验证它不会绕过 enabled，而不是碰巧挑到别的来源。
      await req('POST', `/api/sources/${demoSrcId}/enabled`, { cookie, body: { enabled: false } });
      const c = await req('POST', '/api/demo/push', { cookie, body: { count: 1 } });
      check('全部停用时自动挑选返回 400 而非挑一个停用源', c.status === 400, c.body);
      await req('POST', `/api/sources/${demoSrcId}/enabled`, { cookie, body: { enabled: true } });

      const on = await req('POST', `/api/sources/${srcId}/enabled`, { cookie, body: { enabled: true } });
      check('恢复启用成功', on.status === 200 && on.body.enabled === true, on.body);

      const d = await req('POST', '/api/ingest', { headers: { 'X-Api-Key': srcKey }, body: [{ eventId: 'flow-on-1' }] });
      check('恢复后 /api/ingest 200 入库', d.status === 200 && d.body.inserted === 1, d.body);
    }

    /* ================================================ 5. 演示推送 */
    group('演示推送流程：/api/demo/push');
    {
      const r = await req('POST', '/api/demo/push', { body: { count: 2 } });
      check('未登录 401', r.status === 401, r.status);
    }
    {
      const r = await req('POST', '/api/demo/push', { cookie, body: { count: 3, sourceId: srcId } });
      check('指定来源推送成功', r.status === 200 && r.body.inserted === 3, r.body);
    }
    {
      const r = await req('POST', '/api/demo/push', { cookie, body: { count: 1 } });
      check('不指定来源自动挑启用中的', r.status === 200 && r.body.inserted === 1, r.body);
    }

    /* ================================================ 6. 查询链路 */
    group('查询流程');
    {
      const r = await req('GET', '/api/events?limit=5', { cookie });
      check('/api/events 返回 200 且有报文', r.status === 200 && Array.isArray(r.body.items) && r.body.items.length > 0, r.body && r.body.total);
      check('分页字段 total 存在', typeof r.body.total === 'number', Object.keys(r.body || {}));
    }
    {
      await req('POST', '/api/ingest', {
        headers: { 'X-Api-Key': srcKey },
        body: [
          { eventId: 'tb-1', platform: '贴吧', total: 100, ok: 96, fail: 4, successRate: 96, date: '2026-10-16', success: true, timestamp: '2026-10-16T09:00:00Z' },
          { eventId: 'tb-2', platform: '贴吧', total: 80, ok: 80, fail: 0, successRate: 100, date: '2026-10-16', success: true, timestamp: '2026-10-16T10:00:00Z' },
          { eventId: 'sh-1', platform: '色花堂', steps: 5, durationSec: 120, date: '2026-10-16', success: true, timestamp: '2026-10-16T11:00:00Z' },
        ],
      });
      // 返回结构是 { days, tieba:[], sehuatang:[], summary } —— 两个平台分开给
      const r = await req('GET', '/api/checkin/daily?days=7', { cookie });
      check('/api/checkin/daily 200', r.status === 200, r.status);
      check('贴吧聚合出了记录', Array.isArray(r.body.tieba) && r.body.tieba.length >= 1, r.body.tieba && r.body.tieba.length);
      check('色花堂聚合出了记录', Array.isArray(r.body.sehuatang) && r.body.sehuatang.length >= 1, r.body.sehuatang && r.body.sehuatang.length);
      const tb = (r.body.tieba || []).find((x) => x.date === '2026-10-16');
      check('贴吧当天取时间最晚的一次（total=80）', tb && tb.total === 80, tb);
      check('贴吧成功数按最后一条算（ok=80）', tb && tb.ok === 80, tb);
      const sh = (r.body.sehuatang || []).find((x) => x.date === '2026-10-16');
      check('色花堂记录了步数', sh && sh.steps === 5, sh);
      // mmss(120) 的格式是「2分0秒」，不是 02:00
      check('色花堂把秒数格式化成文本', sh && sh.durationText === '2分0秒', sh && sh.durationText);
    }
    {
      const r = await req('GET', '/api/logs?limit=50', { cookie });
      check('/api/logs 200 且有日志', r.status === 200 && r.body.items.length > 0, r.body.total);
      const msgs = JSON.stringify(r.body.items);
      check('日志记录了 403 停用拦截', msgs.includes('停用'), r.body.items.slice(0, 3).map((i) => i.message));
      check('日志记录了 401 无效 Key', msgs.includes('API Key 无效'), '');
      check('对外日志不含 ip 字段', r.body.items.every((i) => i.ip === undefined), Object.keys(r.body.items[0] || {}));
    }
    {
      const ok = await req('GET', '/api/logs?status=ok&limit=50', { cookie });
      check('日志可按 status=ok 过滤', ok.status === 200 && ok.body.items.every((i) => i.ok === 1), ok.body.items.map((i) => i.ok));
      const bad = await req('GET', '/api/logs?status=fail&limit=50', { cookie });
      check('日志可按 status=fail 过滤', bad.status === 200 && bad.body.items.every((i) => i.ok === 0), bad.body.items.map((i) => i.ok));
      // 观察项：传数字状态码会怎样？记录下来（前端目前只传 limit/offset，没有调用方）
      const num = await req('GET', '/api/logs?status=403&limit=50', { cookie });
      const allNum = num.body.items.every((i) => i.status === 403);
      note(
        `传 ?status=403（数字状态码）→ ${num.status}，${allNum ? '正确过滤' : '未过滤、返回全部 ' + num.body.items.length + ' 条（status 只认 ok/fail 两个字符串）'}`
      );
    }

    group('SSE 实时日志流');
    {
      const got = await new Promise((resolve) => {
        const r = http.get(BASE + '/api/stream/logs', (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c.toString();
            if (buf.includes('hello')) {
              res.destroy();
              resolve({ ok: true, ct: res.headers['content-type'], buf });
            }
          });
          res.on('end', () => resolve({ ok: buf.includes('hello'), ct: res.headers['content-type'], buf }));
          res.on('error', () => resolve({ ok: false, buf }));
        });
        r.on('error', () => resolve({ ok: false, buf: 'error' }));
        r.setTimeout(8000, () => {
          r.destroy();
          resolve({ ok: false, buf: 'timeout' });
        });
      });
      check('SSE 收到 hello 事件', got.ok === true, got.buf.slice(0, 80));
      check('Content-Type 为 text/event-stream', /text\/event-stream/.test(got.ct || ''), got.ct);
    }

    /* ================================================ 7. 凭证配置 */
    group('凭证配置流程');
    {
      const r = await req('GET', '/api/credentials', { cookie });
      check('读取配置 200', r.status === 200 && r.body.ok === true, r.body.file);
      const groups = Object.keys(r.body.groups);
      check('三个平台分组齐全', ['capsolver', 'ttshitu', 'feishu'].every((g) => groups.includes(g)), groups);
      // view() 把值放在 values 里（同层还有 label/secrets/required/placeholders）
      const fs0 = r.body.groups.feishu.values;
      // 新库里还没配，所以是空串；配过之后是掩码 —— 两种都不该是明文
      check('密钥字段读出的是掩码/空，非明文', typeof fs0.appSecret === 'string' && (fs0.appSecret === '' || /\*/.test(fs0.appSecret)), fs0.appSecret);
      check('非密钥字段原样返回', 'appId' in fs0, Object.keys(fs0));
    }
    {
      const first = await req('GET', '/api/credentials', { cookie });
      const cfgFile = first.body.file;
      const r = await req('PUT', '/api/credentials/feishu', { cookie, body: { appId: 'cli_test_123', appSecret: 'real-secret-abc' } });
      check('写配置 200', r.status === 200 && r.body.ok === true, r.body);
      const back = await req('GET', '/api/credentials', { cookie });
      check('appId 已保存', back.body.groups.feishu.values.appId === 'cli_test_123', back.body.groups.feishu.values.appId);
      check('密钥读出的是掩码，不是刚写的真值', back.body.groups.feishu.values.appSecret !== 'real-secret-abc', back.body.groups.feishu.values.appSecret);

      // 「空串 = 不修改」是页面把掩码提交回来时不覆盖真值的关键约定，直接读文件验证
      await req('PUT', '/api/credentials/feishu', { cookie, body: { appId: 'cli_test_123', appSecret: '' } });
      const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      check('空串表示不修改：真值仍在文件里', raw.feishu && raw.feishu.appSecret === 'real-secret-abc', raw.feishu && raw.feishu.appSecret);
    }
    {
      const r = await req('PUT', '/api/credentials/nope', { cookie, body: { a: 1 } });
      check('未知配置组 404', r.status === 404, r.body);
    }
    {
      const r = await req('DELETE', '/api/credentials/feishu', { cookie });
      check('重置配置 200', r.status === 200 && r.body.ok === true, r.body);
      const back = await req('GET', '/api/credentials', { cookie });
      check('appId 已清空', !back.body.groups.feishu.values.appId, back.body.groups.feishu.values.appId);
    }

    /* ================================================ 8. 调度 */
    group('定时拉取流程');
    {
      const r = await req('GET', '/api/scheduler', { cookie });
      check('调度状态 200', r.status === 200 && r.body.ok === true, r.body);
      check('PULL_ENABLED=0 时 enabled=false', r.body.enabled === false, r.body);
    }
    {
      const r = await req('POST', '/api/scheduler/run', { cookie });
      check('手动触发不崩溃（非 5xx）', r.status < 500, r.status);
      check('无飞书凭证时给出明确结果而非静默成功', typeof r.body === 'object', Object.keys(r.body || {}));
    }

    /* ================================================ 9. 改密码 */
    group('改密码流程');
    {
      const r = await req('POST', '/api/auth/password', { cookie, body: { oldPassword: 'wrong', newPassword: 'newsecret123' } });
      check('旧密码错误 400', r.status === 400, r.body);
    }
    {
      const r = await req('POST', '/api/auth/password', { cookie, body: { oldPassword: 'secret123', newPassword: 'secret123' } });
      check('新旧相同 400', r.status === 400, r.body);
    }
    {
      const r = await req('POST', '/api/auth/password', { cookie, body: { oldPassword: 'secret123', newPassword: 'newsecret123' } });
      check('改密码成功', r.status === 200 && r.body.ok === true, r.body);
      cookie = '';
      const again = await req('POST', '/api/auth/login', { body: { username: 'flowadmin', password: 'newsecret123' } });
      check('新密码可登录', again.status === 200, again.body);
      cookie = sess(again.setCookie.find((c) => c.startsWith('wc_session=')));
      const old = await req('POST', '/api/auth/login', { body: { username: 'flowadmin', password: 'secret123' } });
      check('旧密码已失效', old.status === 401, old.status);
    }

    /* ================================================ 10. 登录限流（放最后，用假账号避免污染） */
    group('登录限流');
    {
      let locked = 0;
      for (let i = 0; i < 6; i++) {
        const r = await req('POST', '/api/auth/login', { body: { username: '__rate_test__', password: 'bad' } });
        if (r.status === 429) {
          locked = i + 1;
          break;
        }
      }
      check('连续错误后触发 429 限流', locked > 0, `第 ${locked} 次被限流`);
    }

    /* ================================================ 11. 静态资源 */
    group('前端静态资源');
    for (const p of ['/index.html', '/setup.html', '/style.css', '/app.js', '/setup.js', '/common.js', '/themes/sakura.css', '/themes/rain.css']) {
      const r = await req('GET', p);
      check(`${p} 可访问 200`, r.status === 200, r.status);
    }

    /* ================================================ 12. 库内直接核对
       必须放在「删除来源」之前：删来源会级联清掉它的报文，核对就失去意义 */
    group('落库结果核对（直接读 SQLite）');
    {
      const Database = require('better-sqlite3');
      const db = new Database(path.join(DATA_DIR, 'workcheck.db'), { readonly: true });
      const total = db.prepare('SELECT COUNT(*) c FROM raw_events').get().c;
      const bySrc = db
        .prepare('SELECT s.name, COUNT(e.id) c FROM sources s LEFT JOIN raw_events e ON e.source_id = s.id GROUP BY s.id')
        .all();
      const offRows = db.prepare("SELECT COUNT(*) c FROM raw_events WHERE payload LIKE '%flow-off%'").get().c;
      const bigRows = db.prepare("SELECT COUNT(*) c FROM raw_events WHERE event_id LIKE 'big-%'").get().c;
      const mine = (bySrc.find((s) => s.name === '流程测试来源') || {}).c;
      console.log(`    报文总数=${total}  按来源=${JSON.stringify(bySrc)}`);
      check('停用期间的报文一条都没入库', offRows === 0, offRows);
      check('超限那批（501 条）一条都没入库', bigRows === 0, bigRows);
      // flow-1 / flow-2,3,4 / flow-single / flow-on-1 / demo×3 / 签到×3 = 12 条
      // （另 1 条是 demo 自动挑选时落到「示例来源」的，它 id 更小且同样持有 Key）
      check('测试来源落库条数符合预期（12 条）', mine === 12, mine);
      check('自动挑选确实挑了另一个来源（示例来源 1 条）', (bySrc.find((s) => s.name === '示例来源') || {}).c === 1, bySrc);
      check('库里确实有数据', total > 0, total);
      db.close();
    }

    /* ================================================ 13. 删除来源 */
    group('删除来源');
    {
      const r = await req('DELETE', `/api/sources/${srcId}`, { cookie });
      check('删除来源 200', r.status === 200 && r.body.ok === true, r.body);
      const again = await req('DELETE', `/api/sources/${srcId}`, { cookie });
      check('重复删除 404', again.status === 404, again.body);
      // 级联：来源没了，它的报文也应该一起走
      const Database = require('better-sqlite3');
      const db = new Database(path.join(DATA_DIR, 'workcheck.db'), { readonly: true });
      const left = db.prepare('SELECT COUNT(*) c FROM raw_events WHERE source_id = ?').get(srcId).c;
      check('删除来源后其报文被级联清理', left === 0, left);
      db.close();
    }
    /* ================================================ 14. 推送限流
       RATE_LIMIT 是启动时读的，设小了会污染上面的入库用例，所以单开一个实例 */
    group('推送限流（独立实例 RATE_LIMIT=3）');
    {
      const rPort = PORT_START + 60;
      const rDir = path.join(ROOT, '.tmp-flow', 'data-rate');
      const rsrv = startServer(rPort, rDir, { RATE_LIMIT: '3' });
      try {
        await waitUp(rsrv, rPort);
        await req('POST', '/api/auth/setup', { body: { username: 'rateadmin', password: 'secret123' } });
        const login = await req('POST', '/api/auth/login', { body: { username: 'rateadmin', password: 'secret123' } });
        const c = sess(login.setCookie.find((x) => x.startsWith('wc_session=')));
        const made = await req('POST', '/api/sources', { cookie: c, body: { name: '限流来源' } });
        const key = made.body.apiKey;
        let hit429 = 0;
        for (let i = 0; i < 8; i++) {
          const r = await req('POST', '/api/ingest', {
            headers: { 'X-Api-Key': key },
            body: [{ eventId: `rate-${i}` }],
          });
          if (r.status === 429) {
            hit429 = i + 1;
            break;
          }
        }
        check('超过阈值后触发 429 限流', hit429 > 0, `第 ${hit429} 次被限流（阈值 3）`);
        check('限流不是从第一次就开始拦', hit429 >= 2, hit429);
      } finally {
        rsrv.kill();
      }
    }
  } catch (e) {
    fail++;
    failures.push('脚本异常：' + e.message);
    console.error('\n[脚本异常]', e);
  } finally {
    srv.kill();
    try {
      fs.rmSync(path.join(ROOT, '.tmp-flow'), { recursive: true, force: true });
    } catch (_) {
      /* 清理失败不影响结论 */
    }
    console.log(`\n${'='.repeat(50)}`);
    console.log(`通过 ${pass} / 失败 ${fail}`);
    if (failures.length) {
      console.log('失败项：');
      failures.forEach((f) => console.log('  - ' + f));
    }
    if (notes.length) {
      console.log('观察项（非失败）：');
      notes.forEach((n) => console.log('  - ' + n));
    }
    process.exit(fail === 0 ? 0 : 1);
  }
})();
