'use strict';

/**
 * 定时拉取调度器。
 *
 * 每隔 N 分钟直接调用 server/checkin_pull.js 拉一次飞书群消息并写库。
 *
 * 以前这里是 spawn 一个子进程跑 scripts/parse_checkin.js --push，脚本再 HTTP POST 回
 * /api/ingest。那条链路要靠 API Key 才能入库，用户一旦删掉对应来源就整条断掉；
 * 而且「待推暂存 + 已推清单」两份外部状态要维护。改成本进程内直写之后：
 *   - 不需要任何 API Key，幂等交给数据库的 UNIQUE(source_id, event_id)；
 *   - 服务没起来就没有拉取这回事，不需要补推暂存；
 *   - 拉取异常只在内存里记一笔状态，不会留下半个写坏的文件。
 *
 * 环境变量：
 *   PULL_INTERVAL_MIN   间隔分钟数，默认 120（每 2 小时）
 *   PULL_ENABLED        设为 0 可关闭定时（只保留页面上的手动触发）
 *   PULL_START_DELAY    启动后首次执行的延迟秒数，默认 8
 *   PULL_RETRY_MIN      失败后补跑的间隔分钟数，默认 15
 *   PULL_TIMEOUT_MS     单次拉取的超时，默认 5 分钟（见 checkin_pull.js）
 */

const { pull } = require('./checkin_pull');

const ENABLED = process.env.PULL_ENABLED !== '0';
const INTERVAL_MIN = Number(process.env.PULL_INTERVAL_MIN || 120);
const START_DELAY_SEC = Number(process.env.PULL_START_DELAY || 8);
// 失败后额外补跑一次的时间，避免因为一次网络抖动就白白等满整个周期
const RETRY_MIN = Number(process.env.PULL_RETRY_MIN || 15);

const state = {
  enabled: ENABLED,
  intervalMin: INTERVAL_MIN,
  running: false,
  lastRunAt: null,
  lastFinishAt: null,
  lastOk: null,
  lastInserted: null,
  lastDuplicated: null,
  lastFetched: null,
  lastError: null,
  lastMode: null,   // 'incremental' | 'full'
  lastPages: null,  // 上次翻了几页 —— 增量生效后这个数应该稳定在 1
  runCount: 0,
  nextRunAt: null,
  retryAt: null,
  history: [],
};

let timer = null;
let retryTimer = null;

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    state.retryAt = null;
    runOnce('retry').catch(() => {});
  }, RETRY_MIN * 60 * 1000);
  retryTimer.unref?.();
  state.retryAt = new Date(Date.now() + RETRY_MIN * 60 * 1000).toISOString();
  console.log(`  [定时拉取] 本次失败，${RETRY_MIN} 分钟后自动补跑一次`);
}

function cancelRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  state.retryAt = null;
}

/**
 * 跑一次。页面上的「立即拉取」和定时器走的是同一个入口，所以状态是同一份。
 * opts 原样透传给 pull —— 页面要「全量重建」时传 { full: true }。
 */
async function runOnce(reason = 'manual', opts = {}) {
  if (state.running) return { skipped: true, reason: '上一次还没跑完' };

  state.running = true;
  state.lastRunAt = new Date().toISOString();
  const started = Date.now();

  let r;
  try {
    r = await pull(opts);
  } catch (e) {
    // pull 内部已经兜住了绝大多数异常，这里只是最后一道防线
    r = { ok: false, error: e && e.message ? e.message : String(e), inserted: 0, duplicated: 0, fetched: 0, parsed: 0, skipped: 0, merged: 0 };
  }

  state.running = false;
  state.lastFinishAt = new Date().toISOString();
  state.lastOk = r.ok;
  state.lastInserted = r.inserted;
  state.lastDuplicated = r.duplicated;
  state.lastFetched = r.fetched;
  state.lastMode = r.mode || null;
  state.lastPages = r.pages ?? null;
  state.lastError = r.ok ? null : r.error || '拉取失败';
  state.runCount += 1;
  state.history.unshift({
    at: state.lastFinishAt,
    reason,
    ok: r.ok,
    mode: r.mode || null,
    inserted: r.inserted,
    duplicated: r.duplicated,
    error: state.lastError,
    ms: Date.now() - started,
  });
  state.history = state.history.slice(0, 20);

  console.log(
    `  [定时拉取] ${r.ok ? '成功' : '失败'}  ${r.mode === 'incremental' ? '增量' : '全量'}拉取 ${r.fetched ?? 0} 条消息` +
      (r.pages ? `（${r.pages} 页）` : '') +
      `  入库 ${r.inserted ?? 0} 条` +
      (r.duplicated ? `  重复 ${r.duplicated} 条` : '') +
      `  耗时 ${Date.now() - started}ms` +
      (r.ok ? '' : `  原因：${state.lastError}`)
  );

  if (r.ok) cancelRetry();
  else if (reason !== 'manual') scheduleRetry();

  return r;
}

function start() {
  if (!ENABLED) {
    console.log('  定时拉取：已关闭（PULL_ENABLED=0），可在「接入配置 → 数据推送」页手动触发');
    return;
  }
  const ms = INTERVAL_MIN * 60 * 1000;
  state.nextRunAt = new Date(Date.now() + START_DELAY_SEC * 1000).toISOString();

  // 启动后先跑一次，把停机期间漏掉的数据补回来
  setTimeout(() => {
    runOnce('startup').catch(() => {});
    state.nextRunAt = new Date(Date.now() + ms).toISOString();
  }, START_DELAY_SEC * 1000);

  timer = setInterval(() => {
    runOnce('scheduled').catch(() => {});
    state.nextRunAt = new Date(Date.now() + ms).toISOString();
  }, ms);

  timer.unref?.();

  console.log(`  定时拉取：每 ${INTERVAL_MIN} 分钟一次，启动 ${START_DELAY_SEC} 秒后先跑一次`);
}

module.exports = { start, runOnce, state };
