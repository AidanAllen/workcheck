'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DATA_DIR } = require('./data_dir'); // 唯一出处，别再各自拼一遍路径
const Database = require('better-sqlite3');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'workcheck.db'));
db.pragma('journal_mode = WAL');

// 注：早期「数值字段自动识别」功能的 metrics 表已随该功能删掉，
// 老库里若还留着这张表，初始化时会被 DROP TABLE 清理掉。
db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  -- 可空：内置来源（飞书签到直写入库用）不经过 HTTP，也就不该持有推送 Key。
  -- SQLite 的 UNIQUE 允许多个 NULL 并存，正好满足「多个来源都可以没有 Key」。
  api_key     TEXT UNIQUE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    INTEGER NOT NULL,
  event_id     TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  event_time   TEXT NOT NULL,
  size         INTEGER NOT NULL,
  payload      TEXT NOT NULL,
  UNIQUE(source_id, event_id)
);

CREATE TABLE IF NOT EXISTS access_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  source_id    INTEGER,
  source_name  TEXT NOT NULL,
  status       INTEGER NOT NULL,
  ok           INTEGER NOT NULL,
  latency_ms   INTEGER NOT NULL,
  inserted     INTEGER NOT NULL DEFAULT 0,
  duplicated   INTEGER NOT NULL DEFAULT 0,
  ip           TEXT,
  message      TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON access_logs(ts);
`);

/**
 * 迁移：老库的 sources.api_key 是 NOT NULL，改成可空。
 *
 * SQLite 不支持 ALTER COLUMN，只能重建表再拷数据。这里用
 * `PRAGMA table_info` 探一下 notnull 标志，只在确实需要时重建，
 * 避免每次启动都白跑一遍 DDL。
 */
function migrateSourcesApiKeyNullable() {
  const col = db.prepare('PRAGMA table_info(sources)').all().find((c) => c.name === 'api_key');
  if (!col || col.notnull === 0) return; // 新库或已迁过

  db.exec(`
    BEGIN;
    CREATE TABLE sources_new (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,
      api_key     TEXT UNIQUE,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    );
    INSERT INTO sources_new (id, name, slug, api_key, enabled, created_at)
      SELECT id, name, slug, api_key, enabled, created_at FROM sources;
    DROP TABLE sources;
    ALTER TABLE sources_new RENAME TO sources;
    COMMIT;
  `);
  console.log('  已迁移 sources 表：api_key 改为可空（内置来源不再需要推送 Key）');
}
migrateSourcesApiKeyNullable();

const S = {
  insertSource: db.prepare('INSERT INTO sources (name, slug, api_key, enabled, created_at) VALUES (?,?,?,1,?)'),
  listSources: db.prepare('SELECT * FROM sources ORDER BY id'),
  getSourceByKey: db.prepare('SELECT * FROM sources WHERE api_key = ?'),
  getSourceById: db.prepare('SELECT * FROM sources WHERE id = ?'),
  deleteSource: db.prepare('DELETE FROM sources WHERE id = ?'),
  toggleSource: db.prepare('UPDATE sources SET enabled = ? WHERE id = ?'),
  clearSourceKey: db.prepare('UPDATE sources SET api_key = NULL WHERE id = ?'),

  insertEvent: db.prepare(
    'INSERT OR IGNORE INTO raw_events (source_id, event_id, received_at, event_time, size, payload) VALUES (?,?,?,?,?,?)'
  ),
  insertLog: db.prepare(
    'INSERT INTO access_logs (ts, source_id, source_name, status, ok, latency_ms, inserted, duplicated, ip, message) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ),
};

/** 分页上限：limit 交给调用方传，但必须封顶 —— 否则 ?limit=99999999 会整表捞进内存 */
const MAX_PAGE = 500;
const clampSize = (limit, dflt) => Math.min(Math.max(1, Math.floor(Number(limit) || dflt)), MAX_PAGE);
const clampOffset = (offset) => Math.max(0, Math.floor(Number(offset) || 0));

/* ------------------------------------------------------------------ 管理员账号
   接入配置页不再裸奔：账号存库，密码用 crypto.scrypt 加盐哈希（不存明文、不用 md5）。
   会话单独一张表，服务端可按 token 查到是谁，也能主动踢掉过期会话。 */
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  admin_id    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
`);

const A = {
  countAdmins: db.prepare('SELECT COUNT(*) AS n FROM admins'),
  getByName: db.prepare('SELECT * FROM admins WHERE username = ?'),
  insertAdmin: db.prepare('INSERT INTO admins (username, salt, hash, created_at) VALUES (?,?,?,?)'),
  insertSession: db.prepare('INSERT INTO sessions (token, admin_id, created_at, expires_at) VALUES (?,?,?,?)'),
  // 会话和用户一起取，顺手过滤掉已过期的，省得调用方再判一次时间
  liveSession: db.prepare(
    `SELECT s.token, s.expires_at, a.id AS admin_id, a.username
     FROM sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token = ? AND s.expires_at > ?`
  ),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE admin_id = ?'),
};

/** 是否已有管理员 —— 决定 setup 页显示「创建账号」还是「登录」 */
function hasAdmin() {
  return A.countAdmins.get().n > 0;
}

function createAdmin(username, salt, hash) {
  const info = A.insertAdmin.run(username, salt, hash, new Date().toISOString());
  return A.getByName.get(username) || { id: info.lastInsertRowid, username };
}

function findAdmin(username) {
  return A.getByName.get(username) || null;
}

/** 建会话，返回 token。ttlMs 默认 7 天 */
function createSession(adminId, ttlMs = 7 * 24 * 60 * 60 * 1000) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  A.deleteExpired.run(now.toISOString());
  A.insertSession.run(token, adminId, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
  return token;
}

/** @returns {{username:string, adminId:number}|null} 过期或不存在都是 null */
function sessionUser(token) {
  if (!token) return null;
  const row = A.liveSession.get(token, new Date().toISOString());
  return row ? { username: row.username, adminId: row.admin_id } : null;
}

function dropSession(token) {
  if (token) A.deleteSession.run(token);
}

function pruneSessions() {
  return A.deleteExpired.run(new Date().toISOString()).changes;
}

const slugify = (name) => {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'source';
}

/**
 * 建一个来源。
 *
 * @param {string} name
 * @param {{withKey?:boolean}} [opts] withKey 默认 true。
 *   内置来源（飞书签到直写入库）传 false —— 它不经过 HTTP，没有 Key 才符合实际：
 *   页面上不会出现一把永远用不上的 Key，也少一个「被人拿到就能往里塞数据」的入口。
 */
function createSource(name, opts = {}) {
  const clean = String(name || '').trim() || '未命名来源';
  let slug = slugify(clean);
  const exists = db.prepare('SELECT COUNT(*) c FROM sources WHERE slug = ?').get(slug).c;
  if (exists) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
  const apiKey = opts.withKey === false ? null : `sk_${crypto.randomBytes(16).toString('hex')}`;
  const info = S.insertSource.run(clean, slug, apiKey, new Date().toISOString());
  return S.getSourceById.get(info.lastInsertRowid);
}

const insertMany = db.transaction((rows) => {
  let inserted = 0;
  let duplicated = 0;
  for (const r of rows) {
    const res = S.insertEvent.run(r.sourceId, r.eventId, r.receivedAt, r.eventTime, r.size, r.payload);
    if (res.changes > 0) inserted++;
    else duplicated++;
  }
  return { inserted, duplicated };
});

function logAccess(row) {
  const info = S.insertLog.run(
    row.ts,
    row.sourceId ?? null,
    row.sourceName || '未知来源',
    row.status,
    row.ok ? 1 : 0,
    row.latencyMs,
    row.inserted || 0,
    row.duplicated || 0,
    row.ip || '',
    row.message || ''
  );
  return S.getLog.get(info.lastInsertRowid);
}

S.getLog = db.prepare('SELECT * FROM access_logs WHERE id = ?');

/**
 * 访问日志。**按 id 倒序**（最新在前），支持分页。
 * @returns {{items: object[], total: number}} total 是不加筛选条件时的总条数场景下当前 WHERE 命中的行数，
 *          前端据此算「共几页」
 */
function logs({ limit = 100, offset = 0, status, source } = {}) {
  const where = [];
  const args = [];
  if (status === 'ok') where.push('ok = 1');
  if (status === 'fail') where.push('ok = 0');
  if (source) {
    where.push('source_name = ?');
    args.push(source);
  }
  const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const page = clampOffset(offset);
  const size = clampSize(limit, 100);
  const items = db
    .prepare(`SELECT * FROM access_logs ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, size, page);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM access_logs ${cond}`).get(...args).n;
  return { items, total };
}

/** 原始报文列表，按入库顺序倒序分页 */
function recentEvents(limit = 20, offset = 0) {
  const size = clampSize(limit, 20);
  const page = clampOffset(offset);
  const items = db
    .prepare(
      `SELECT e.id, e.event_id, e.event_time, e.received_at, e.size, e.payload, s.name AS source_name
       FROM raw_events e LEFT JOIN sources s ON s.id = e.source_id
       ORDER BY e.id DESC LIMIT ? OFFSET ?`
    )
    .all(size, page);
  const total = db.prepare('SELECT COUNT(*) AS n FROM raw_events').get().n;
  return { items, total };
}

/**
 * 取全部原始报文用于离线解析（签到这类数据需要按业务字段重算，不能只看入库量）。
 * 只取 payload 一列 —— 解析只需要它，历史报文多的时候少带几列更省。
 */
function allEventPayloads() {
  return db.prepare('SELECT payload FROM raw_events ORDER BY id').all();
}

function deleteSource(id) {
  const src = S.getSourceById.get(id);
  if (!src) return null;
  S.deleteSource.run(id);
  db.prepare('DELETE FROM raw_events WHERE source_id = ?').run(id);
  return src;
}

/**
 * 日志表保留策略：access_logs 只增不减，长期跑会把库撑大，也会拖慢看板首屏。
 * 每次超量就按 id 从小到大删掉最老的一批，只留最近 keep 条。
 * @returns {number} 实际删除的条数
 */
function pruneLogs(keep = Number(process.env.LOG_KEEP) || 20000) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM access_logs').get().n;
  if (n <= keep) return 0;
  const cut = db.prepare('SELECT id FROM access_logs ORDER BY id DESC LIMIT 1 OFFSET ?').get(keep);
  if (!cut) return 0;
  return db.prepare('DELETE FROM access_logs WHERE id < ?').run(cut.id).changes;
}

module.exports = {
  db,
  S,
  createSource,
  insertMany,
  logAccess,
  logs,
  recentEvents,
  allEventPayloads,
  deleteSource,
  pruneLogs,
  hasAdmin,
  createAdmin,
  findAdmin,
  createSession,
  sessionUser,
  dropSession,
  pruneSessions,
};
