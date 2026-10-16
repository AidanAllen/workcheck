'use strict';

/**
 * 飞书「增量拉取」的回归测试。
 *
 * 用法：npm run pulltest
 *
 * 拉取以前是每次把整个群从头翻到最后一页，群里消息越多越慢，而其中绝大多数
 * 是已经入库过的重复数据。现在靠水位线只问「上次之后有什么」，这条链路的正确性
 * 光看代码看不出来 —— start_time 到底有没有被采纳、翻几页、水位线会不会被推错，
 * 都得真跑一遍才知道。
 *
 * 所以这里用一个假飞书接口：把 globalThis.fetch 换掉，消息库、分页、
 * 「是否采纳 start_time」全部可控，跑的是 server/checkin_pull.js 的真代码，
 * 不碰真实 API、不需要真令牌。
 *
 * 为什么单独一个脚本而不是并进 flowtest：mock fetch 必须在**同一个进程**里完成，
 * 而 flowtest 是 spawn 一个子进程起服务，改不到它的全局对象。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.tmp-pulltest');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
// 必须在 require 任何项目模块之前设：data_dir.js 在加载时就把它读成常量
process.env.WORKCHECK_DATA_DIR = TMP;

const CHAT = 'oc_test_chat';
const CHAT2 = 'oc_other_chat';
const DAY = 86400_000;

// ---------------------------------------------------------------- 假飞书
let honorStart = true; // 模拟「飞书是否采纳 start_time」
const calls = [];
let MSGS = [];

function mkMsg(i, ct) {
  const d = new Date(ct);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const text = `📊 色花堂自动签到时间：${date} 00:03:34\n登录： ✅\n回复： ✅\n签到： ✅\n耗时： 3分32秒`;
  return {
    message_id: `om_${i}`,
    create_time: String(ct),
    // 必须按卡片结构造：cardText() 只认 {title, elements}，
    // 纯文本消息的 {"text":"..."} 会被它解析成空串
    body: { content: JSON.stringify({ config: { wide_screen_mode: true }, elements: [{ tag: 'div', text: { content: text } }] }) },
  };
}

const NOW = Date.now();
// 初始 100 条，每天一条，最新一条停在 31 天前 —— 后面留 30 天给「之后新来的」，
// 否则补的消息不比水位线新，增量什么都拉不到（这正是要验证的场景，得造得像真的）
for (let i = 0; i < 100; i++) MSGS.push(mkMsg(i, NOW - (130 - i) * DAY));
// 每天一条保证 date 各不相同 —— 同一天的多条会被 dedupeRecords 合并，测插入数就不准
let seq = 0;
function addFresh(n, fromDaysAgo) {
  for (let j = 0; j < n; j++) MSGS.push(mkMsg(`f${seq++}`, NOW - (fromDaysAgo - j) * DAY));
}

globalThis.fetch = async (url) => {
  const u = new URL(url);
  const start = u.searchParams.get('start_time');
  const sort = u.searchParams.get('sort_type');
  const pageToken = u.searchParams.get('page_token');
  calls.push({ sort, start: start || null, page: pageToken ? 'next' : 'first' });

  let pool = MSGS.slice();
  // 飞书侧按 start_time 过滤（honorStart=false 时模拟"它把这个参数忽略了"）
  if (honorStart && start) pool = pool.filter((m) => Number(m.create_time) >= Number(start) * 1000);
  pool.sort((a, b) =>
    sort === 'ByCreateTimeDesc' ? Number(b.create_time) - Number(a.create_time) : Number(a.create_time) - Number(b.create_time)
  );
  const offset = pageToken ? Number(pageToken) : 0;
  const items = pool.slice(offset, offset + 50);
  const hasMore = offset + 50 < pool.length;
  return {
    json: async () => ({ code: 0, data: { items, has_more: hasMore, page_token: hasMore ? String(offset + 50) : undefined } }),
  };
};

// ---------------------------------------------------------------- 配置与令牌
function writeConfig(chatId) {
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ feishu: { appId: 'cli_test', appSecret: 'secret_test', chatId, redirectUri: '' } }, null, 2)
  );
}
writeConfig(CHAT);
fs.writeFileSync(
  path.join(TMP, 'feishu_token.json'),
  JSON.stringify({ accessToken: 'u-fake', refreshToken: 'r-fake', expiresAt: Date.now() + 7200_000 }, null, 2)
);

const pullMod = require('../server/checkin_pull');

// ---------------------------------------------------------------- 断言
let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}  → ${JSON.stringify(detail)}`); }
}
function note(t) { console.log(`    · ${t}`); }

(async () => {
  /* ============================================ 1. 首次：没有水位线 → 全量 */
  console.log('\n[1] 首次拉取（没有任何水位线）');
  calls.length = 0;
  let r = await pullMod.pull({});
  check('mode=full', r.mode === 'full', r.mode);
  check('翻了 2 页（100 条 / 每页 50）', r.pages === 2, r.pages);
  check('fetched=100', r.fetched === 100, r.fetched);
  check('没带 start_time', calls.every((c) => c.start === null), calls[0]);
  check('水位线已建立', pullMod.watermarkFor(CHAT) > 0, pullMod.readState());
  note(`日志：${String(r.fetched)} 条，入库 ${r.inserted} 条`);
  const wm1 = pullMod.watermarkFor(CHAT);
  note(`水位线 = ${new Date(wm1).toISOString().slice(0, 16)}（1 天前那条）`);

  /* ============================================ 2. 增量：后续只拉新的 */
  console.log('\n[2] 群里新来 20 条后再拉（增量）');
  addFresh(20, 30); // 30 天前 ~ 11 天前
  calls.length = 0;
  r = await pullMod.pull({});
  check('mode=incremental', r.mode === 'incremental', r.mode);
  check('只翻了 1 页', r.pages === 1, r.pages);
  check('带上了 start_time', calls[0] && calls[0].start !== null, calls[0]);
  // 21 = 新来的 20 条 + 回退窗口多带回来的 1 条旧消息（回退窗口是刻意设计的）
  check('fetched=21（20 条新的 + 回退窗口 1 条）', r.fetched === 21, r.fetched);
  check('走的是 asc 主路径', r.fetchMode === 'asc', r.fetchMode);
  check('入库 20 条（旧那条撞 UNIQUE 去重）', r.inserted === 20, { inserted: r.inserted, duplicated: r.duplicated });
  check('水位线往前推了', pullMod.watermarkFor(CHAT) > wm1, pullMod.watermarkFor(CHAT));
  note(`对比：全量要翻 3 页（120 条），增量只翻 1 页`);

  /* ============================================ 3. 反复增量：稳定在 1 页 */
  console.log('\n[3] 没有新消息时再拉一次');
  const wm3 = pullMod.watermarkFor(CHAT);
  calls.length = 0;
  r = await pullMod.pull({});
  check('仍是 incremental', r.mode === 'incremental', r.mode);
  check('仍然只翻 1 页', r.pages === 1, r.pages);
  check('水位线没动（没有更新的消息）', pullMod.watermarkFor(CHAT) === wm3, { got: pullMod.watermarkFor(CHAT), want: wm3 });

  /* ============================================ 4. start_time 不被采纳 → 降序兜底 */
  console.log('\n[4] 模拟飞书忽略 start_time（兜底路径）');
  honorStart = false;
  addFresh(5, 10); // 10 天前 ~ 6 天前，都比当前水位线新
  calls.length = 0;
  r = await pullMod.pull({});
  check('降级到 desc 兜底', r.fetchMode === 'desc', r.fetchMode);
  check('兜底后只拿到新消息（5 条）', r.fetched === 5, r.fetched);
  check('兜底没有退化成翻完整群（总请求 2 次）', calls.length === 2, calls);
  check('第一次是 asc 探测、第二次是 desc', calls[0].sort === 'ByCreateTimeAsc' && calls[1].sort === 'ByCreateTimeDesc', calls);
  honorStart = true;

  /* ============================================ 5. 换群 → 水位线失效 */
  console.log('\n[5] 换成另一个群');
  writeConfig(CHAT2);
  calls.length = 0;
  r = await pullMod.pull({});
  check('换群后 mode=full（旧水位线不算数）', r.mode === 'full', r.mode);
  check('换群后重新全量翻页', r.pages >= 2, r.pages);
  check('新群建立了自己的水位线', pullMod.watermarkFor(CHAT2) > 0, pullMod.readState());
  writeConfig(CHAT);

  /* ============================================ 6. 全量重建 */
  console.log('\n[6] 显式全量重建（full: true）');
  calls.length = 0;
  r = await pullMod.pull({ full: true });
  check('mode=full 即使有水位线', r.mode === 'full', r.mode);
  check('翻了 3 页（125 条）', r.pages === 3, r.pages);
  check('没带 start_time', calls.every((c) => c.start === null), calls[0]);
  check('全部重复（幂等，没算两次）', r.inserted === 0 && r.duplicated > 0, { inserted: r.inserted, duplicated: r.duplicated });

  /* ============================================ 7. 水位线不回退 / 时钟回拨 */
  console.log('\n[7] 水位线的两个保护');
  const before = pullMod.watermarkFor(CHAT);
  const futureWm = before + 10 * DAY;
  pullMod.writeState({ chatId: CHAT, lastCreateTimeMs: futureWm, lastPullAt: new Date().toISOString() });
  r = await pullMod.pull({});
  check('水位线在未来时不会被拉回', pullMod.watermarkFor(CHAT) === futureWm, { got: pullMod.watermarkFor(CHAT), want: futureWm });
  check('未来水位线下不会把老消息再拉一遍', r.fetched === 0, r.fetched);
  pullMod.writeState({ chatId: CHAT, lastCreateTimeMs: before, lastPullAt: new Date().toISOString() });

  // 时钟回拨：消息创建时间在未来
  MSGS.push(mkMsg('future', Date.now() + 30 * DAY));
  r = await pullMod.pull({});
  const wm = pullMod.watermarkFor(CHAT);
  check('消息时间在未来时水位线被 clamp（不越过 now+60s）', wm <= Date.now() + 60_000, { wm, now: Date.now() });
  check('clamp 后水位线仍是有效的', wm > 0, wm);

  console.log(`\n${'='.repeat(46)}\n通过 ${pass} / 失败 ${fail}`);
  if (failures.length) failures.forEach((f) => console.log('  - ' + f));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('[探针异常]', e); process.exit(1); });
