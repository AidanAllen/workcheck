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

const fs = require('fs');
const path = require('path');
const checkin = require('./checkin');
const { S, insertMany, logAccess, createSource } = require('./db');
const { getValidToken, getChatId, hasCred } = require('./feishu_token');
const { DATA_DIR } = require('./data_dir');

const BASE = 'https://open.feishu.cn/open-apis';
const PAGE_SIZE = 50; // 飞书 page_size 上限就是 50
const TIMEOUT_MS = Number(process.env.PULL_TIMEOUT_MS) || 5 * 60 * 1000;

/**
 * 水位线：上次拉到的最新消息的创建时间。
 *
 * 没有它的时候，每次拉取都是「从群的第一条消息翻到最后一页」—— 群里 100 条消息
 * 每次就要翻 2 页、解析 100 条、然后 100 条全撞 UNIQUE 变成重复。消息涨到几千条
 * 时这个开销会线性放大，而其中 99% 以上是纯粹的重复劳动。
 * 有了它，每次只问飞书「这个时间点之后有什么」，通常一页就完事。
 */
const STATE_FILE = path.join(DATA_DIR, 'feishu_pull_state.json');

/**
 * 回退窗口：给 start_time 往前挪多少秒。默认 1 小时。
 *
 * 飞书没写清 start_time 是开区间还是闭区间，消息也可能延迟到达，所以起点刻意往
 * 回退一点。多拉出来的那点重复由数据库 UNIQUE(source_id, event_id) 幂等吸收，
 * 成本为零；反过来漏掉一条签到，成功率就失真了 —— 宁可多拉不可漏拉。
 */
const OVERLAP_SEC = Number(process.env.PULL_OVERLAP_SEC) || 3600;

/** 单次拉取的翻页上限。200 页 × 50 条 = 一万条，够覆盖「停机很久后补数据」；
    再往上跑不如等下一个周期，免得一次拉取占满 TIMEOUT_MS */
const MAX_PAGES = Number(process.env.PULL_MAX_PAGES) || 200;

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
 *
 * 这个来源走的是进程内 insertMany，不经过 HTTP，所以**不持有推送 Key**。
 * 老版本建的来源可能带一把用不上的 Key（`sk_…`），这里顺手清掉。
 */
function ensureSource() {
  const hit = S.listSources.all().find((s) => s.name === SOURCE_NAME);
  if (hit) {
    if (!hit.enabled) {
      S.toggleSource.run(1, hit.id);
      hit.enabled = 1;
    }
    if (hit.api_key) S.clearSourceKey.run(hit.id);
    return hit;
  }
  return createSource(SOURCE_NAME, { withKey: false });
}

/* ------------------------------------------------------------------ 水位线

   只存三个字段：哪个群、拉到哪了、什么时候拉的。
   群 ID 一起存是关键 —— 换了群之后旧时间点在新群里毫无意义，
   不比对的话会用昨天的水位线去拉一个全新的群，等于第一次之后的增量全丢。 */

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch (_) {
    return null; // 首次运行、或文件被删：都当作「还没有水位线」
  }
}

function writeState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 先写临时文件再改名：写到一半进程被杀不会留下一个解析不了的残文件。
  // 残文件比没文件更糟 —— 解析失败会被当成「没有水位线」而静默全量重来一次。
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/** 清掉水位线，下次拉取自动走全量。给「全量重建」和换群时用 */
function resetState() {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch (_) {
    /* 没有就算了 */
  }
}

/** 当前群可用的水位线（毫秒）。换群、没拉过、被清掉都返回 0 —— 0 表示「从头拉」 */
function watermarkFor(chatId) {
  const s = readState();
  if (!s || s.chatId !== chatId) return 0;
  const ms = Number(s.lastCreateTimeMs);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * 本次拉取的起点（毫秒，0 表示全量）。
 * days 是「重扫最近 N 天」，sinceMs 是增量水位线 —— 哪个更早就用哪个，
 * 因为两个要求必须同时满足：既不能漏掉增量之后的新消息，也不能漏掉回溯窗口里的。
 */
function startOf(days, sinceMs) {
  let fromMs = 0;
  if (days) fromMs = Date.now() - Number(days) * 86400_000;
  if (sinceMs) fromMs = fromMs ? Math.min(fromMs, Number(sinceMs)) : Number(sinceMs);
  return fromMs;
}

/** 水位线写进日志时要能一眼看懂：M月D日 时:分（本地时区，不是 UTC） */
function fmtLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 按给定排序翻页，直到没有下一页、或（降序时）翻到早于 hardStopAtMs 的消息。
 *
 * expectStartSec 非空时，会在**第一页**就验一下飞书有没有采纳 start_time：
 * 返回的消息里出现早于它的，说明这个参数被忽略了。验错时机很关键 —— 放在翻完
 * 之后验的话，兜底就得先白跑完整群再重来，比直接全量还慢。
 */
async function fetchPages({ token, chatId, sort, startTimeSec, hardStopAtMs, signal, expectStartSec }) {
  const all = [];
  let pageToken;
  let pages = 0;
  let complete = true; // 有没有翻完（撞上 MAX_PAGES 时是 false）

  do {
    const u =
      `${BASE}/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}` +
      `&page_size=${PAGE_SIZE}&sort_type=${sort}` +
      `${startTimeSec ? `&start_time=${startTimeSec}` : ''}` +
      `${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal });
    const d = await res.json();
    if (d.code !== 0) {
      const e = new Error(d.msg || '拉取群消息失败');
      e.code = d.code;
      throw e;
    }
    pages += 1;
    const items = d.data.items || [];

    if (pages === 1 && expectStartSec && items.some((m) => Number(m.create_time) < expectStartSec * 1000)) {
      return { items: all, pages, complete, stopped: false, honored: false };
    }

    if (hardStopAtMs) {
      // 降序兜底：从最新往回翻，一旦碰到不比水位线新的，说明新消息已经全拿到了。
      // 同一页内前面的更新、后面的更旧，所以收到第一条旧的就该收工，
      // 但这一页里它前面的那些仍然是新消息，要保留。
      for (const m of items) {
        if (Number(m.create_time) <= hardStopAtMs) return { items: all, pages, complete, stopped: true };
        all.push(m);
      }
    } else {
      all.push(...items);
    }

    pageToken = d.data.has_more ? d.data.page_token : null;
    if (pages >= MAX_PAGES && pageToken) return { items: all, pages, complete: false, stopped: false, honored: true };
  } while (pageToken);

  return { items: all, pages, complete, stopped: false, honored: true };
}

/**
 * 拉取群消息。
 *
 * 两条路径：
 *   1. 主路径 —— 升序 + start_time，让飞书自己把旧消息滤掉，返回的就是增量，
 *      通常一页结束。start_time 是秒级时间戳，往前挪 OVERLAP_SEC 兜边界。
 *   2. 兜底 —— 万一飞书没采纳 start_time（返回里出现了更早的消息），
 *      改降序从最新往回翻，碰到不比水位线新的就停。
 *      没这层的话，start_time 一旦失效就悄悄退化成「每次翻完整群」。
 */
async function fetchMessages(token, { days = null, sinceMs = 0, signal } = {}) {
  const chatId = getChatId();
  if (!chatId) throw new Error('未配置飞书群 ID，请到「接入配置 → 平台凭证」填写');

  const fromMs = startOf(days, sinceMs);
  const startTimeSec = fromMs > 0 ? Math.floor((fromMs - OVERLAP_SEC * 1000) / 1000) : 0;

  const asc = await fetchPages({
    token, chatId, sort: 'ByCreateTimeAsc', startTimeSec, hardStopAtMs: 0, signal,
    expectStartSec: startTimeSec,
  });

  if (asc.honored) {
    return {
      items: asc.items.filter((m) => Number(m.create_time) >= fromMs),
      pages: asc.pages, complete: asc.complete, mode: 'asc', fromMs,
    };
  }

  // 飞书没采纳 start_time（第一页就验出来了）：升序那趟拿到的是全量，丢掉重来
  const desc = await fetchPages({
    token, chatId, sort: 'ByCreateTimeDesc', startTimeSec: 0, hardStopAtMs: fromMs, signal,
  });
  return {
    items: desc.items.filter((m) => Number(m.create_time) >= fromMs),
    pages: desc.pages, complete: desc.complete, mode: 'desc', fromMs,
  };
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
  const { days = null, full = false } = opts;
  const chatId = getChatId();
  // 全量重建时不看水位线；换群后水位线自动失效（watermarkFor 里比对 chatId）
  const sinceMs = full ? 0 : watermarkFor(chatId);
  const mode = sinceMs ? 'incremental' : 'full';

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
    return done({ ok: false, error: message, mode });
  };

  if (!hasCred()) return fail('未配置飞书应用凭证，请到「接入配置 → 平台凭证」填写 App ID / App Secret');

  // 单次最多跑 TIMEOUT_MS：飞书接口卡住时不让调度器永远停在 running 状态
  const ac = new AbortController();
  const guard = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    const token = await getValidToken();
    if (!token) return fail('飞书未授权或令牌已失效，请到「接入配置」页重新授权');

    const res = await fetchMessages(token.accessToken, { days, sinceMs, signal: ac.signal });
    const msgs = res.items;
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

    // 水位线只在「把该拉的都拉完了」时才往前推。撞上翻页上限那次不算翻完，
    // 推了就会把后面没拿到的消息永久跳过；不推的话下次重拉，靠 UNIQUE 去重，
    // 顶多浪费一次请求，不会丢数据。
    let advanced = false;
    if (res.complete && msgs.length) {
      const maxCreate = msgs.reduce((a, m) => Math.max(a, Number(m.create_time) || 0), 0);
      // 时钟回拨保护：水位线跑到未来的话，下次 start_time 在未来，反而会漏掉中间这段
      const safe = Math.min(maxCreate, Date.now() + 60_000);
      if (safe > sinceMs) {
        writeState({
          chatId,
          lastCreateTimeMs: safe,
          lastPullAt: new Date().toISOString(),
          lastCount: msgs.length,
        });
        advanced = true;
      }
    }

    const scope = mode === 'incremental' ? `增量拉取（自 ${fmtLocal(res.fromMs)}）` : '全量拉取';
    const message =
      `${scope} ${msgs.length} 条消息` +
      (dedup.removed > 0 ? `，去重后 ${rows.length} 条` : '') +
      `，入库 ${inserted} 条` +
      (res.mode === 'desc' ? '；注意：start_time 未被飞书采纳，已走降序兜底' : '') +
      (res.complete ? '' : '；未翻完，下次继续');

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
      mode,                 // 'incremental' | 'full'
      sinceMs,              // 本次用的水位线，0 表示从头拉
      pages: res.pages,     // 翻了几页 —— 增量是不是真的省了，看这个数
      fetchMode: res.mode,  // 'asc' 走 start_time / 'desc' 走降序兜底
      complete: res.complete,
      advanced,             // 水位线有没有往前推
    });
  } catch (e) {
    const code = e.code === 230002 || e.code === 232011 ? '（该身份不在群里，确认授权的飞书账号本人是群成员）' : '';
    return fail(`${e.name === 'AbortError' ? `拉取超时（超过 ${Math.round(TIMEOUT_MS / 1000)} 秒）` : e.message}${code}`);
  } finally {
    clearTimeout(guard);
  }
}

module.exports = {
  SOURCE_NAME,
  pull,
  fetchMessages,
  ensureSource,
  setLogSink,
  // 水位线的读写/清理导出给「全量重建」入口与测试用
  readState,
  writeState,
  resetState,
  watermarkFor,
  STATE_FILE,
};
