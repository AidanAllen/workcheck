'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');

const store = require('./db');
const { router: feishuRouter } = require('./feishu');
const { router: ttshituRouter } = require('./ttshitu');
const { router: capsolverRouter } = require('./capsolver');
const scheduler = require('./scheduler');
const checkin = require('./checkin');
const config = require('./config');
const version = require('./version');
const { setLogSink, SOURCE_NAME } = require('./checkin_pull');
const {
  S,
  insertMany,
  logAccess,
  logs,
  recentEvents,
  allEventPayloads,
  pruneLogs,
  hasAdmin,
  createAdmin,
  findAdmin,
  findAdminById,
  changePassword,
  createSession,
  sessionUser,
  dropSession,
  pruneSessions,
} = store;

const { readCookie } = require('./util');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* 飞书 router 下面挂着两个「查配置」的接口（status 会吐出回调地址），前端是在登录后的
   接入配置页里调它们的，服务端却没人看守 —— 因为它比 adminGuard 定义得早、也拿不到那份作用域，
   所以这里提前插一层中间件补上鉴权。function 声明会提升，运行时 adminGuard 已经是可用状态。
   注意只拦 /api/feishu/*：/feishu/auth 与 /feishu/callback 是浏览器跳转用的页面路由，
   加登录会让授权流程直接走不下去。 */
app.use('/api/feishu', (req, res, next) => adminGuard(req, res, next));

app.use(feishuRouter);
app.use(ttshituRouter);
app.use(capsolverRouter);

const PORT = Number(process.env.PORT) || 3000;
const MAX_BATCH = 500;
const RATE_WINDOW = 60_000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 600;

const hits = new Map();
function rateOk(sourceId) {
  const now = Date.now();
  const arr = (hits.get(sourceId) || []).filter((t) => now - t < RATE_WINDOW);
  arr.push(now);
  hits.set(sourceId, arr);
  return arr.length <= RATE_LIMIT;
}

/** 来源 IP 属于运维敏感信息，前端一行都用不到，但日志表和 SSE 里都带着：
    统一在出口剪掉，免得任何人打开看板就能看到推送方的 IP */
const stripIp = (row) => {
  if (!row || !('ip' in row)) return row;
  const { ip, ...rest } = row;
  return rest;
};

const clients = new Set();
function broadcast(payload) {
  const data = JSON.stringify(stripIp(payload));
  for (const res of clients) {
    try {
      res.write(`event: log\ndata: ${data}\n\n`);
    } catch (_) {
      clients.delete(res);
    }
  }
}

function writeLog(row) {
  const saved = logAccess(row);
  broadcast(saved);
  return saved;
}

const ID_KEYS = ['eventId', 'event_id', 'id', 'uid', 'orderId', 'order_id', 'traceId', 'trace_id', 'uuid', 'sn'];
const TIME_KEYS = ['timestamp', 'time', 'ts', 'createdAt', 'created_at', 'eventTime', 'event_time', 'date', 'datetime'];

function toDate(v) {
  // 字符串形式的数字时间戳先转 number —— `new Date("1700000000")` 是 Invalid Date，
  // 而很多采集端（PHP / Python / Java 写的居多）恰恰就是把时间戳当字符串塞过来的。
  //
  // 认这些形态：负号（1970 年前）、10~13 位整数（秒 / 毫秒）、可选的小数部分
  // （"1700000000.123" 这种秒带毫秒的最常见，少了这段就会被整条丢掉）。
  //
  // 刻意不认 14 位及以上：那是 `YYYYMMDDHHmmss` 的长度，当时间戳算会飞到公元 2612 年。
  // 已知边缘（不打算治）：10 位的 `YYYYMMDDHH`、12 位的 `YYYYMMDDHHmm` 落在这个区间里，
  // 会被当成秒/毫秒时间戳算出 1976、2034 这类年份。真要区分只能靠"前四位像不像年份"
  // 这种启发式，而真实时间戳迟早会涨进那个数值区间 —— 届时启发式反而会误伤。
  // 采集端把紧凑日期塞进 time 字段的情况极少，收益不抵风险，留着即可。
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^-?\d{10,13}(?:\.\d+)?$/.test(s)) v = Number(s);
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 1e11 毫秒 ≈ 1973 年，比它小的基本都是秒级时间戳，补个 1000 变成毫秒
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function pickEventId(obj) {
  for (const k of ID_KEYS) {
    if (obj[k] !== undefined && obj[k] !== null && typeof obj[k] !== 'object') return String(obj[k]);
  }
  return null;
}

function pickTime(obj) {
  for (const k of TIME_KEYS) {
    if (obj[k] !== undefined) {
      const d = toDate(obj[k]);
      if (d) return d;
    }
  }
  return null;
}

function normalize(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    for (const k of ['events', 'data', 'records', 'items', 'list']) {
      if (Array.isArray(body[k])) return body[k];
    }
    return [body];
  }
  return null;
}

function ingestFor(source, body, ip) {
  const started = Date.now();
  const fail = (status, message) => {
    const latencyMs = Date.now() - started;
    writeLog({
      ts: new Date().toISOString(),
      sourceId: source ? source.id : null,
      sourceName: source ? source.name : '未知来源',
      status,
      ok: false,
      latencyMs,
      ip,
      message,
    });
    return { status, body: { ok: false, error: message } };
  };

  if (!rateOk(source.id)) return fail(429, '推送过于频繁，已触发限流');

  const list = normalize(body);
  if (!list) return fail(400, '请求体必须是 JSON 对象或数组');
  if (list.length === 0) return fail(400, '数据为空，未收到任何记录');
  if (list.length > MAX_BATCH) return fail(413, `单次最多 ${MAX_BATCH} 条，本次 ${list.length} 条`);

  const now = new Date().toISOString();
  const rows = [];
  for (const raw of list) {
    const item = raw && typeof raw === 'object' ? raw : { value: raw };
    const payload = JSON.stringify(item);
    const eventId =
      pickEventId(item) ||
      `auto_${crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16)}`;
    rows.push({
      sourceId: source.id,
      eventId: String(eventId),
      receivedAt: now,
      eventTime: pickTime(item) || now,
      size: Buffer.byteLength(payload),
      payload,
    });
  }

  const { inserted, duplicated } = insertMany(rows);
  const latencyMs = Date.now() - started;
  const message =
    duplicated > 0 ? `入库 ${inserted} 条，去重 ${duplicated} 条` : `入库 ${inserted} 条`;
  writeLog({
    ts: now,
    sourceId: source.id,
    sourceName: source.name,
    status: 200,
    ok: true,
    latencyMs,
    inserted,
    duplicated,
    ip,
    message,
  });
  return { status: 200, body: { ok: true, inserted, duplicated, latencyMs } };
}

function readKey(req) {
  const direct = req.get('X-Api-Key');
  if (direct) return direct.trim();
  const auth = req.get('Authorization') || '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return '';
}

app.post('/api/ingest', (req, res) => {
  const key = readKey(req);
  const ip = req.ip || '';
  if (!key) {
    const r = {
      ts: new Date().toISOString(),
      sourceId: null,
      sourceName: '未知来源',
      status: 401,
      ok: false,
      latencyMs: 1,
      ip,
      message: '缺少 API Key，请在请求头 X-Api-Key 中传入',
    };
    writeLog(r);
    return res.status(401).json({ ok: false, error: r.message });
  }
  const source = S.getSourceByKey.get(key);
  if (!source) {
    writeLog({
      ts: new Date().toISOString(),
      sourceId: null,
      sourceName: '未知来源',
      status: 401,
      ok: false,
      latencyMs: 1,
      ip,
      message: 'API Key 无效',
    });
    return res.status(401).json({ ok: false, error: 'API Key 无效' });
  }
  if (!source.enabled) {
    writeLog({
      ts: new Date().toISOString(),
      sourceId: source.id,
      sourceName: source.name,
      status: 403,
      ok: false,
      latencyMs: 1,
      ip,
      message: '该来源已被停用',
    });
    return res.status(403).json({ ok: false, error: '该来源已被停用' });
  }
  const out = ingestFor(source, req.body, ip);
  return res.status(out.status).json(out.body);
});

app.get('/setup', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'setup.html')));

/* ------------------------------------------------------------ 登录与管理鉴权
   接入配置页（/setup）以及它背后的所有管理接口，都需要管理员登录后才能用：
   账号密码存库（scrypt 加盐哈希），登录后发一枚随机 token 放在 httpOnly cookie 里 ——
   httpOnly 是为了 JS 读不到，万一页面被注入脚本也偷不走凭证。
   首次运行库里没有账号，此时 setup 页显示「创建管理员」，创建完自动登录。 */
const SESSION_COOKIE = 'wc_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // 忘记密码时的应急通道，可选

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, salt, hash) {
  const mine = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  // 长度不等时 timingSafeEqual 会抛错，先自己比长度
  return mine.length === stored.length && crypto.timingSafeEqual(mine, stored);
}

/** 登录失败限流：同一个 IP + 用户名，5 分钟内错 5 次就先锁一会儿 */
const loginFails = new Map();
const LOGIN_WINDOW = 5 * 60 * 1000;
const LOGIN_MAX = 5;
let lastSweep = 0;

/** 窗口外的条目要主动丢掉 —— Map 只增不减的话，每个 IP+账号组合都会永久占一条，
    扫一遍哪怕全是无效尝试也能把它撑起来。清理不必多频繁，够挡住增长就行。 */
function sweepLoginFails(now) {
  if (now - lastSweep < LOGIN_WINDOW) return;
  lastSweep = now;
  for (const [k, arr] of loginFails) {
    const kept = arr.filter((t) => now - t < LOGIN_WINDOW);
    if (kept.length) loginFails.set(k, kept);
    else loginFails.delete(k);
  }
}

function loginLocked(key) {
  const now = Date.now();
  const arr = (loginFails.get(key) || []).filter((t) => now - t < LOGIN_WINDOW);
  if (arr.length) loginFails.set(key, arr);
  else loginFails.delete(key);
  return arr.length >= LOGIN_MAX;
}

function noteLoginFail(key) {
  const now = Date.now();
  const arr = loginFails.get(key) || [];
  arr.push(now);
  loginFails.set(key, arr);
  sweepLoginFails(now);
}

app.get('/api/auth/state', (req, res) => {
  const user = sessionUser(readCookie(req, SESSION_COOKIE));
  res.json({ initialized: hasAdmin(), loggedIn: !!user, username: user ? user.username : null });
});

/** 首次运行创建管理员：只要库里还没有账号就能建，建完直接登录 */
app.post('/api/auth/setup', (req, res) => {
  if (hasAdmin()) return res.status(409).json({ ok: false, error: '管理员已存在，请直接登录' });
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (username.length < 3 || username.length > 32) return res.status(400).json({ ok: false, error: '账号需 3~32 个字符' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: '密码至少 6 位' });
  const { salt, hash } = hashPassword(password);
  const admin = createAdmin(username, salt, hash);
  setSessionCookie(res, createSession(admin.id));
  return res.json({ ok: true, username: admin.username });
});

app.post('/api/auth/login', (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const key = `${req.ip || '?'}|${username}`;
  if (loginLocked(key)) return res.status(429).json({ ok: false, error: '尝试次数过多，请 5 分钟后再试' });

  // 账号不存在、密码错误都回同一句话，别让攻击者试出哪些账号是真存在的
  const admin = findAdmin(username);
  if (!admin || !verifyPassword(password, admin.salt, admin.hash)) {
    noteLoginFail(key);
    return res.status(401).json({ ok: false, error: '账号或密码错误' });
  }
  loginFails.delete(key);
  setSessionCookie(res, createSession(admin.id));
  return res.json({ ok: true, username: admin.username });
});

app.post('/api/auth/logout', (req, res) => {
  dropSession(readCookie(req, SESSION_COOKIE));
  clearSessionCookie(res);
  return res.json({ ok: true });
});

/**
 * 改密码。
 *
 * 必须验旧密码 —— 光有会话不够：会话可能是别人趁你没锁屏时顺手拿的，
 * 那台设备上的人不该能直接把密码换掉把你锁在外面。
 * 改完把其它设备的会话全踢掉，只留当前这一个（见 db.changePassword）。
 */
app.post('/api/auth/password', adminGuard, (req, res) => {
  const user = sessionUser(readCookie(req, SESSION_COOKIE));
  if (!user) return res.status(401).json({ ok: false, error: '请先登录' });

  const oldPassword = String((req.body && req.body.oldPassword) || '');
  const newPassword = String((req.body && req.body.newPassword) || '');

  const admin = findAdminById(user.adminId);
  if (!admin) return res.status(401).json({ ok: false, error: '账号不存在，请重新登录' });
  if (!verifyPassword(oldPassword, admin.salt, admin.hash)) {
    return res.status(400).json({ ok: false, error: '当前密码不正确' });
  }
  if (newPassword.length < 6) return res.status(400).json({ ok: false, error: '新密码至少 6 位' });
  if (newPassword.length > 128) return res.status(400).json({ ok: false, error: '新密码太长了（最多 128 位）' });
  if (newPassword === oldPassword) return res.status(400).json({ ok: false, error: '新密码不能与当前密码相同' });

  const { salt, hash } = hashPassword(newPassword);
  const kicked = changePassword(admin.id, salt, hash, readCookie(req, SESSION_COOKIE));
  return res.json({ ok: true, kicked });
});

/** 管理接口的守门人：有会话放行，否则按「还没建账号 / 没登录」分别提示前端该显示哪一屏 */
function adminGuard(req, res, next) {
  const token = readCookie(req, SESSION_COOKIE);
  const user = sessionUser(token);
  if (user) {
    req.admin = user;
    return next();
  }
  if (ADMIN_TOKEN) {
    const got = req.get('X-Admin-Token') || String(req.get('Authorization') || '').replace(/^bearer\s+/i, '');
    if (got.trim() === ADMIN_TOKEN) return next();
  }
  if (!hasAdmin()) return res.status(401).json({ ok: false, need: 'setup', error: '尚未创建管理员账号' });
  return res.status(401).json({ ok: false, need: 'login', error: '请先登录' });
}

// 签到数据按天聚合（贴吧 / 色花堂），供看板日历、最新状态与柱状图使用。days=0 或不传表示全部
app.get('/api/checkin/daily', (req, res) => {
  const days = Number(req.query.days) > 0 ? Number(req.query.days) : null;
  try {
    const parsed = [];
    for (const row of allEventPayloads()) {
      const rec = checkin.fromPayload(row.payload);
      if (rec) parsed.push(rec);
    }
    // 入库已按「平台@业务时间」幂等，这里再按同一键兜一层：
    // 老数据或手工灌入的记录键可能不一致，聚合前先合并，保证一天一根柱。
    const { records } = checkin.dedupeRecords(parsed);
    res.json({ days, ...checkin.aggregate(records, days) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/logs', (req, res) => {
  // 分页：limit 每页条数、offset 偏移量，返回 { items, total }
  const raw = req.query.status;
  let status = '';
  if (raw !== undefined && String(raw) !== '') {
    status = String(raw);
    // 只认 ok / fail / 三位数字状态码。别的（比如写错成 "40"、"error"）一律明确报错：
    // 默默忽略的话，调用方会以为筛选生效了，拿到的却是全量日志。
    if (status !== 'ok' && status !== 'fail' && !/^\d{3}$/.test(status)) {
      return res.status(400).json({ ok: false, error: `status 只支持 ok / fail / 三位数字状态码，收到「${status}」` });
    }
  }
  const data = logs({
    limit: Number(req.query.limit) || 100,
    offset: Number(req.query.offset) || 0,
    status,
    source: req.query.source,
  });
  res.json({ ...data, items: data.items.map(stripIp) });
});

app.get('/api/events', (req, res) => {
  // 同上，最近原始报文分页
  res.json(recentEvents(Number(req.query.limit) || 20, Number(req.query.offset) || 0));
});

app.get('/api/stream/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      /* ignore */
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

/** 列表接口不再带明文 key —— 之前 `{ ...s }` 把整行（含 api_key）都发出去了，
    加的掩码形同虚设。需要明文时走下面的 /api/sources/:id/key（同样在 guard 之下） */
function publicSource(s) {
  const { api_key, ...rest } = s;
  // 内置来源是服务进程拉飞书数据直写入库时挂数据用的：不提供推送、不持有 Key、也不允许删
  return {
    ...rest,
    api_key_masked: api_key ? mask(api_key) : '',
    hasKey: !!api_key,
    builtin: s.name === SOURCE_NAME,
  };
}

app.get('/api/sources', adminGuard, (_req, res) => {
  res.json(S.listSources.all().map(publicSource));
});

function mask(key) {
  return `${key.slice(0, 6)}${'*'.repeat(18)}${key.slice(-4)}`;
}

/** 明文 key 单独一个口子：列表页懒加载用，拿到列表不等于拿到凭证 */
app.get('/api/sources/:id/key', adminGuard, (req, res) => {
  const src = S.getSourceById.get(Number(req.params.id));
  if (!src) return res.status(404).json({ ok: false, error: '来源不存在' });
  if (!src.api_key) return res.status(404).json({ ok: false, error: '该来源不持有推送 Key' });
  return res.json({ ok: true, apiKey: src.api_key });
});

app.post('/api/sources', adminGuard, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '来源名称不能为空' });
  const src = store.createSource(name);
  // 只有「刚创建这一次」把明文发回去（页面要展示给用户复制），列表里不再有
  return res.json({ ok: true, source: publicSource(src), apiKey: src.api_key });
});

app.post('/api/sources/:id/enabled', adminGuard, (req, res) => {
  const id = Number(req.params.id);
  const src = S.getSourceById.get(id);
  if (!src) return res.status(404).json({ ok: false, error: '来源不存在' });
  // 内置来源页面上已经不显示了，这里再挡一道：把它停用会让签到数据停止入库，
  // 而用户根本不会意识到自己点的是这个东西。它就该一直是启用的。
  if (src.name === SOURCE_NAME) {
    return res.status(400).json({ ok: false, error: '内置来源（飞书签到的数据挂在它下面）不能停用' });
  }
  const enabled = req.body && req.body.enabled === false ? 0 : 1;
  S.toggleSource.run(enabled, id);
  return res.json({ ok: true, enabled: !!enabled });
});

app.delete('/api/sources/:id', adminGuard, (req, res) => {
  const id = Number(req.params.id);
  const src = S.getSourceById.get(id);
  if (src && src.name === SOURCE_NAME) {
    return res.status(400).json({
      ok: false,
      error: '这是内置来源（飞书签到的数据挂在它下面），不能删除。想让签到数据换来源请直接改代码里的 SOURCE_NAME，否则历史报文会散在两个 source_id 上',
    });
  }
  const removed = store.deleteSource(id);
  if (!removed) return res.status(404).json({ ok: false, error: '来源不存在' });
  hits.delete(id); // 来源都没了，它的限流计数没必要再挂在内存里
  return res.json({ ok: true, removed: removed.name });
});

/* ------------------------------------------------------------ 第三方凭证配置
   三个平台的凭证统一放在 data/config.json（见 server/config.js）。
   读出来给页面的一律是掩码：明文从配置文件出来之后就不再离开服务端，
   页面回传空串表示「不改」，避免用户把掩码原样提交回来把真值覆盖掉。 */
app.get('/api/credentials', adminGuard, (_req, res) => {
  const groups = {};
  for (const name of config.GROUPS) groups[name] = config.view(name);
  res.json({ ok: true, file: config.CONFIG_FILE, groups });
});

app.put('/api/credentials/:group', adminGuard, (req, res) => {
  const name = String(req.params.group || '');
  if (!config.GROUPS.includes(name)) return res.status(404).json({ ok: false, error: `未知的配置组：${name}` });
  const out = config.save(name, req.body);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

app.delete('/api/credentials/:group', adminGuard, (req, res) => {
  const name = String(req.params.group || '');
  if (!config.GROUPS.includes(name)) return res.status(404).json({ ok: false, error: `未知的配置组：${name}` });
  const out = config.reset(name);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

const DEMO_CHANNELS = ['支付宝', '微信支付', '银行卡', '余额'];
const DEMO_REGIONS = ['华东', '华北', '华南', '西南'];
const DEMO_STATUS = ['paid', 'paid', 'paid', 'refunded', 'failed'];

function demoEvent() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return {
    orderId: `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    amount: Math.round(Math.random() * 4800 + 20) / 1,
    quantity: Math.ceil(Math.random() * 5),
    status: pick(DEMO_STATUS),
    channel: pick(DEMO_CHANNELS),
    region: pick(DEMO_REGIONS),
    latency: Math.round(Math.random() * 300),
    timestamp: new Date().toISOString(),
  };
}

app.post('/api/demo/push', adminGuard, (req, res) => {
  const count = Math.min(Math.max(Number((req.body && req.body.count) || 1), 1), 50);
  const id = Number((req.body && req.body.sourceId) || 0);
  // 默认挑第一个「用户自己建的、且启用中」的来源：内置来源是飞书签到挂数据用的，
  // 拿它看演示数据会把两类不相干的数据混在同一条趋势里。
  // 自动挑选必须带上 enabled 判断 —— 少了它，刚被停用的来源照样会被演示数据灌进去，
  // 用户以为「停用」把入口关了，其实只关了正式推送那条。
  // 优先选持有 Key 的（那才是「可推送」的来源），没有再退回任意启用中的非内置来源。
  const all = S.listSources.all();
  const source =
    (id && S.getSourceById.get(id)) ||
    all.find((s) => s.name !== SOURCE_NAME && s.enabled && s.api_key) ||
    all.find((s) => s.name !== SOURCE_NAME && s.enabled) ||
    null;
  if (!source) return res.status(400).json({ ok: false, error: '还没有启用中的来源，先新建一个或把停用的来源启用' });

  // 和 /api/ingest 同一道闸：停用的来源不接受任何入库，测试推送也不例外
  if (!source.enabled) {
    writeLog({
      ts: new Date().toISOString(),
      sourceId: source.id,
      sourceName: source.name,
      status: 403,
      ok: false,
      latencyMs: 1,
      ip: '127.0.0.1',
      message: '该来源已被停用（测试推送）',
    });
    return res.status(403).json({ ok: false, error: '该来源已被停用' });
  }
  const events = Array.from({ length: count }, demoEvent);
  const out = ingestFor(source, events, '127.0.0.1');
  return res.status(out.status).json(out.body);
});

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString(), app: version.name, version: version.version }));

// ---------------------------------------------------------------- 定时拉取

app.get('/api/scheduler', adminGuard, (_req, res) => {
  res.json({ ok: true, ...scheduler.state, now: new Date().toISOString() });
});

app.post('/api/scheduler/run', adminGuard, async (_req, res) => {
  if (scheduler.state.running) return res.status(409).json({ ok: false, error: '上一次还没跑完' });
  const r = await scheduler.runOnce('api');
  res.json({ ok: true, ...r, state: scheduler.state });
});

function start(port, attempt = 0) {
  const server = app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log('');
    console.log('  workcheck 已启动');
    console.log(`  看板页面   ${url}`);
    console.log(`  接入配置   ${url}/setup`);
    console.log(`  接收接口   ${url}/api/ingest`);
    console.log(`  配置文件   ${config.CONFIG_FILE}`);
    console.log('');
    scheduler.start();
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      console.log(`  端口 ${port} 被占用，改用 ${port + 1}`);
      start(port + 1, attempt + 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}

// 进程兜底：没有这层的话，任何一个没接住的 Promise 异常都会让整个服务直接退出
process.on('unhandledRejection', (err) => {
  console.error('[未处理的 Promise 异常]', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err && err.message ? err.message : err);
});

// 日志表无限增长，会话也会越堆越多：一起定期清理
const LOG_KEEP = Number(process.env.LOG_KEEP) || 20000;
function prune() {
  try {
    const cut = pruneLogs(LOG_KEEP);
    if (cut) console.log(`  已清理历史日志 ${cut} 条（保留最近 ${LOG_KEEP} 条）`);
    const sess = pruneSessions();
    if (sess) console.log(`  已清理过期会话 ${sess} 个`);
  } catch (e) {
    console.error('[清理失败]', e.message);
  }
}

if (S.listSources.all().length === 0) store.createSource('示例来源');

// 拉取结果也走 SSE：看板的实时日志里能直接看到每轮拉了多少条、入库多少条
setLogSink(broadcast);

prune();
setInterval(prune, 6 * 60 * 60 * 1000).unref();

start(PORT);
