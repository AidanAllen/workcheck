'use strict';

/**
 * 飞书群签到数据的进程内拉取 + 直写入库。
 *
 * 以前这条链路是「定时起一个子进程跑 scripts/parse_checkin.js --push，脚本再 HTTP POST
 * 到 /api/ingest」—— 绕一圈的原因只有一个：当年想让脚本脱离服务独立运行。
 * 代价却不小：
 *   1. 推送要一把 API Key，而管理接口早已要求登录、且不再下发明文 key，脚本只能直接读库去「偷」；
 *   2. 用户一旦删掉那个来源的 Key，整条链路就断了，而签到数据本来就不该依赖外部可删的凭证；
 *   3. 子进程 + HTTP + 待推暂存文件（checkin_pending.json）+ 已推清单（checkin_pushed_ids.json）
 *      四套状态要维护，任意一个环节出错就丢数据。
 *
 * 现在直接在服务进程里拉、直接 insertMany：
 *   幂等交给数据库的 UNIQUE(source_id, event_id)，不需要「已推送清单」；
 *   服务没起来就没有拉取这件事，也不需要「待推暂存」。
 */

const checkin = require('./checkin');
const { S, insertMany, logAccess, createSource } = require('./db');
const { getValidToken, getChatId, hasCred } = require('./feishu_token');

const BASE = 'https://open.feishu.cn/open-apis';
const PAGE_SIZE = 50;
const TIMEOUT_MS = Number(process.env.PULL_TIMEOUT_MS) || 5 * 60 * 1000;

/** 内置来源：raw_events 要挂在某个 source_id 上，这里固定一个名字，反复用同一个来源 */
const SOURCE_NAME = '飞书签到（内置）';

/** 日志出口。index.js 会把它接到 SSE 广播上，这样拉取结果能实时出现在看板的实时日志里 */
let logSink = null;
function setLogSink(fn) {
  logSink = fn;
}

function writeLog(row) {
  const saved = logAccess(row);
  if (logSink) {
    try {
      logSink(saved);
    } catch (_) {
      /* 广播失败不影响入库结果 */
    }
  }
  return saved;
}

/**
 * 取（必要时创建）内置来源。
 * 用户删掉「飞书」那个推送来源是他的自由，但签到数据仍要落在某个来源下，所以这里按需重建。
 * 即便被删后重建换了 id，看板聚合时会按 eventId 再去重一次，不会显示成两份。
 */
function ensureSource() {
  const hit = S.listSources.all().find((s) => s.name === SOURCE_NAME);
  if (hit) {
    if (!hit.enabled) {
      S.toggleSource.run(1, hit.id);
      hit.enabled = 1;
    }
    return hit;
  }
  return createSource(SOURCE_NAME);
}

/** 拉取群消息（按创建时间升序翻页） */
async function fetchMessages(token, { days = null, signal } = {}) {
  const cutoff = days ? Date.now() - Number(days) * 86400_000 : 0;
  const chatId = getChatId();
  if (!chatId) throw new Error('未配置飞书群 ID，请到「接入配置 → 平台凭证」填写');

  const all = [];
  let pageToken;
  do {
    const u =
      `${BASE}/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}` +
      `&page_size=${PAGE_SIZE}&sort_type=ByCreateTimeAsc${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal });
    const d = await res.json();
    if (d.code !== 0) {
      const e = new Error(d.msg || '拉取群消息失败');
      e.code = d.code;
      throw e;
    }
    all.push(...(d.data.items || []));
    pageToken = d.data.has_more ? d.data.page_token : null;
  } while (pageToken);

  return all.filter((m) => Number(m.create_time) >= cutoff);
}

/** 业务时间 → ISO。缺失时退到日期，再退到当前时间 */
function eventTimeOf(rec, now) {
  if (rec.timestamp) {
    const d = new Date(rec.timestamp);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (rec.date) {
    const d = new Date(`${rec.date}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return now;
}

/**
 * 拉一次并入库。
 * @param {{days?:number}} [opts] days 只拉近 N 天，不传表示全量
 * @returns {Promise<{ok:boolean, inserted:number, duplicated:number, fetched:number, parsed:number, skipped:number, merged:number, error?:string, ms:number}>}
 */
async function pull(opts = {}) {
  const started = Date.now();
  const source = ensureSource();

  const done = (extra) => ({ inserted: 0, duplicated: 0, fetched: 0, parsed: 0, skipped: 0, merged: 0, ...extra, ms: Date.now() - started });
  const fail = (message) => {
    writeLog({
      ts: new Date().toISOString(),
      sourceId: source.id,
      sourceName: source.name,
      status: 500,
      ok: false,
      latencyMs: Date.now() - started,
      ip: '',
      message,
    });
    return done({ ok: false, error: message });
  };

  if (!hasCred()) return fail('未配置飞书应用凭证，请到「接入配置 → 平台凭证」填写 App ID / App Secret');

  // 单次最多跑 TIMEOUT_MS：飞书接口卡住时不让调度器永远停在 running 状态
  const ac = new AbortController();
  const guard = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    const token = await getValidToken();
    if (!token) return fail('飞书未授权或令牌已失效，请到「接入配置」页重新授权');

    const msgs = await fetchMessages(token.accessToken, { days: opts.days || null, signal: ac.signal });
    const parsed = msgs.map(checkin.parseMessage).filter(Boolean);
    const skipped = msgs.length - parsed.length;

    // 按「平台 + 业务时间」去重：同一条签到被重推时飞书会给新的 message_id，
    // 不去重的话同一次签到会被算成两次，成功率直接失真
    const dedup = checkin.dedupeRecords(parsed);
    const now = new Date().toISOString();
    const rows = dedup.records.map((rec) => {
      const payload = JSON.stringify(rec);
      return {
        sourceId: source.id,
        eventId: String(rec.eventId || checkin.makeEventId(rec, rec.messageId) || ''),
        receivedAt: now,
        eventTime: eventTimeOf(rec, now),
        size: Buffer.byteLength(payload),
        payload,
      };
    });

    const { inserted, duplicated } = rows.length ? insertMany(rows) : { inserted: 0, duplicated: 0 };
    const latencyMs = Date.now() - started;
    const message =
      dedup.removed > 0
        ? `拉取 ${msgs.length} 条消息，去重后 ${rows.length} 条，入库 ${inserted} 条`
        : `拉取 ${msgs.length} 条消息，入库 ${inserted} 条`;

    writeLog({
      ts: now,
      sourceId: source.id,
      sourceName: source.name,
      status: 200,
      ok: true,
      latencyMs,
      inserted,
      duplicated,
      ip: '',
      message,
    });

    return done({
      ok: true,
      inserted,
      duplicated,
      fetched: msgs.length,
      parsed: parsed.length,
      skipped,
      merged: dedup.removed,
    });
  } catch (e) {
    const code = e.code === 230002 || e.code === 232011 ? '（该身份不在群里，确认授权的飞书账号本人是群成员）' : '';
    return fail(`${e.name === 'AbortError' ? `拉取超时（超过 ${Math.round(TIMEOUT_MS / 1000)} 秒）` : e.message}${code}`);
  } finally {
    clearTimeout(guard);
  }
}

module.exports = { SOURCE_NAME, pull, fetchMessages, ensureSource, setLogSink };
