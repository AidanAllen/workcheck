'use strict';

/**
 * 签到数据解析核心 —— 服务端接口与拉取脚本共用同一套规则，避免两处逻辑漂移。
 *
 * 两类卡片：
 *   1. 📊 色花堂自动签到 —— 登录/回复/签到 三项状态 + 耗时
 *   2. 📊 贴吧签到结果   —— 总计贴吧 / 签到成功 / 签到失败
 *
 * 本模块不依赖 express / 数据库，纯函数，方便单测。
 */

// ---------------------------------------------------------------- 卡片 → 文本

function cardText(content) {
  try {
    const c = JSON.parse(content);
    const parts = [];
    if (c.title) parts.push(c.title);
    for (const row of c.elements || []) {
      if (Array.isArray(row)) {
        for (const e of row) if (e && e.tag === 'text' && e.text) parts.push(e.text);
      } else if (row && row.tag === 'div' && row.text) {
        parts.push(row.text.content || '');
      }
    }
    return parts.join('');
  } catch (_) {
    return String(content || '');
  }
}

// ---------------------------------------------------------------- 解析规则

const MARK_OK = ['✅', '✔', '成功', 'ok', 'OK'];

function toBool(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (MARK_OK.some((m) => s.includes(m))) return true;
  if (s.includes('❌') || s.includes('✗') || s.includes('失败')) return false;
  return null;
}

/** '3分32秒' / '0分12秒' / '32秒' → 秒 */
function durationToSec(s) {
  const str = String(s || '');
  const m = str.match(/(?:(\d+)\s*分)?\s*(?:(\d+)\s*秒)?/);
  if (!m) return null;
  const min = Number(m[1] || 0);
  const sec = Number(m[2] || 0);
  if (!m[1] && !m[2]) return null;
  return min * 60 + sec;
}

function pick(text, re) {
  const m = String(text).match(re);
  return m ? m[1] : null;
}

/**
 * 日期字段的合法性把关 —— 这里不只是「格式好看」的问题：
 * 结构化报文里的 date 是外部传进来的（谁有来源的 API Key 谁就能写），聚合后会原样
 * 作为日历 Map 的键、再通过 /api/checkin/daily 回到前端。看板把它拼进 HTML 渲染
 * 「最新一次签到」，一条 {"date":"<img src=x onerror=...>"} 就能在所有人打开看板时执行脚本。
 * 所以在入口就卡死：只认 YYYY-MM-DD，其他一律当没有。
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function safeDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : v;
}

function detectPlatform(text) {
  if (text.includes('色花堂')) return '色花堂';
  if (text.includes('贴吧')) return '贴吧';
  return null;
}

/** 解析色花堂卡片 */
function parseSehuatang(text) {
  const time = pick(text, /时间：\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  const login = toBool(pick(text, /登录：\s*([✅❌✔✗^\n]*)/));
  const reply = toBool(pick(text, /回复：\s*([✅❌✔✗^\n]*)/));
  const sign = toBool(pick(text, /签到：\s*([✅❌✔✗^\n]*)/));
  const durRaw = pick(text, /耗时：\s*([\d分秒\s]+)/);

  const steps = { 登录: login, 回复: reply, 签到: sign };
  const failed = Object.entries(steps).filter(([, v]) => v === false).map(([k]) => k);

  return {
    platform: '色花堂',
    timestamp: time ? time.replace(' ', 'T') + '+08:00' : null,
    date: safeDate(time ? time.slice(0, 10) : null),
    success: failed.length === 0 && sign !== false,
    steps,
    durationSec: durationToSec(durRaw),
    durationText: durRaw ? durRaw.trim() : null,
    failReason: failed.length ? failed.join('/') + ' 失败' : null,
  };
}

/** 解析贴吧卡片 */
function parseTieba(text) {
  const date = pick(text, /日期：\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  const total = Number(pick(text, /总计贴吧：\s*(\d+)/) || 0);
  const ok = Number(pick(text, /签到成功：\s*(\d+)/) || 0);
  const bad = Number(pick(text, /签到失败：\s*(\d+)/) || 0);

  return {
    platform: '贴吧',
    timestamp: date ? date.replace(' ', 'T') + '+08:00' : null,
    date: safeDate(date ? date.slice(0, 10) : null),
    success: bad === 0,
    total,
    ok,
    fail: bad,
    successRate: total ? Number((ok / total).toFixed(4)) : null,
    failReason: bad > 0 ? `${bad} 个贴吧签到失败` : null,
  };
}

/** 从卡片文本解析出标准化记录；不是签到消息则返回 null */
function parseText(text) {
  const platform = detectPlatform(text);
  if (!platform) return null;
  return platform === '色花堂' ? parseSehuatang(text) : parseTieba(text);
}

// ---------------------------------------------------------------- 去重键

/**
 * 签到的幂等键：平台 + 业务时间（卡片正文里的「时间：…」，精确到秒）。
 *
 * 不能用飞书的 message_id 当主键：同一条签到被重推时飞书会生成新的 message_id，
 * 于是同一次签到会变成两条记录，看板上的成功/失败次数直接翻倍。
 * 业务时间来自卡片正文，是签到行为自身的时间，重推也保持不变 —— 用它去重才稳。
 *
 * 时间缺失时逐级退化：timestamp → date → message_id，保证任何情况下都能生成唯一键。
 */
function makeEventId(rec, fallbackId) {
  if (!rec || !rec.platform) return fallbackId ? String(fallbackId) : null;
  if (rec.timestamp) return `${rec.platform}@${rec.timestamp}`;
  if (rec.date) return `${rec.platform}@${rec.date}`;
  return fallbackId ? `${rec.platform}@msg:${fallbackId}` : null;
}

/** 飞书 API 原始消息 → 标准化记录 */
function parseMessage(msg) {
  const raw = (msg.body && msg.body.content) || msg.content || '';
  const text = cardText(raw);
  const body = parseText(text);
  if (!body) return null;
  return {
    eventId: makeEventId(body, msg.message_id),
    messageId: msg.message_id || null,
    ...body,
    sender: msg.sender && msg.sender.id,
    rawText: text,
  };
}

/**
 * 已入库的 payload → 标准化记录。
 * 结构化字段已在则直接沿用；缺失（比如早期入库或手工灌入的）就从 rawText 重新解析一遍。
 */
function fromPayload(payload) {
  let obj = payload;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch (_) {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  const hasShape =
    obj.platform && (obj.platform === '色花堂' ? obj.steps || obj.durationSec != null : obj.total != null);

  if (hasShape) {
    return {
      eventId: obj.eventId || null,
      platform: obj.platform,
      date: safeDate(obj.date),
      timestamp: obj.timestamp || null,
      success: obj.success !== false,
      // 贴吧
      total: obj.total ?? null,
      ok: obj.ok ?? null,
      fail: obj.fail ?? null,
      successRate: obj.successRate ?? null,
      // 色花堂
      steps: obj.steps || null,
      durationSec: obj.durationSec ?? null,
      durationText: obj.durationText || null,
      failReason: obj.failReason || null,
      sender: obj.sender || null,
    };
  }

  if (obj.rawText) {
    const body = parseText(obj.rawText);
    if (!body) return null;
    return { eventId: obj.eventId || null, sender: obj.sender || null, ...body };
  }
  return null;
}

// ---------------------------------------------------------------- 去重

/**
 * 按 eventId 去重（等价于「按平台 + 业务时间」去重）。
 *
 * 同一键有多条时保留业务时间最晚的那条作为最终结果 —— 重试后成功了就该显示成功。
 * 但会把尝试次数和「过程中是否失败过」一起带出来，避免把重试掩盖掉。
 *
 * @returns {{records: object[], removed: number, collapsed: object[]}}
 */
function dedupeRecords(records) {
  const map = new Map();
  for (const r of records) {
    if (!r) continue;
    const key = r.eventId || makeEventId(r, r.messageId);
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, r);
      continue;
    }
    // 业务时间晚的胜出；时间相同的用后出现的（更接近最终结果）
    const newer = String(r.timestamp || '') >= String(prev.timestamp || '');
    const keep = newer ? r : prev;
    const drop = newer ? prev : r;
    map.set(key, {
      ...keep,
      attempts: (prev.attempts || 1) + 1,
      hadFailure: Boolean(prev.hadFailure) || drop.success === false,
    });
  }

  const out = [...map.values()].map((r) => ({
    ...r,
    attempts: r.attempts || 1,
    hadFailure: Boolean(r.hadFailure) || r.success === false,
  }));

  return {
    records: out,
    removed: records.filter(Boolean).length - out.length,
    collapsed: out.filter((r) => r.attempts > 1),
  };
}

// ---------------------------------------------------------------- 聚合

const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}分${s % 60}秒`);

/** 按天聚合（同一天多条时取最后一条），并按日期升序 */
function aggregate(records, days) {
  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : null;

  // 两个平台各用一张表：同一天两个平台都会推消息，共用一个以日期为键的 Map 会互相覆盖
  const maps = { 贴吧: new Map(), 色花堂: new Map() };
  // 同一天可能跑了多次（重试、补跑），记录次数与「过程中是否失败过」，别把重试抹掉
  const attempts = { 贴吧: new Map(), 色花堂: new Map() };
  const hadFail = { 贴吧: new Map(), 色花堂: new Map() };
  let rawCount = 0;

  for (const r of records) {
    if (!r || !r.date || !maps[r.platform]) continue;
    if (cutoff && r.date < cutoff) continue;
    rawCount += r.attempts || 1;

    const map = maps[r.platform];
    const prev = map.get(r.date);
    // 同一天多条时保留时间最晚的那条 —— 重试后成功了就该显示成功
    if (!prev || String(r.timestamp || '') >= String(prev.timestamp || '')) map.set(r.date, r);

    const n = r.attempts || 1;
    attempts[r.platform].set(r.date, (attempts[r.platform].get(r.date) || 0) + n);
    hadFail[r.platform].set(
      r.date,
      (hadFail[r.platform].get(r.date) || false) || r.success === false || r.hadFailure === true
    );
  }

  const byDate = [...maps.贴吧.values(), ...maps.色花堂.values()];

  const tieba = [];
  const sehuatang = [];

  byDate
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .forEach((r) => {
      const att = attempts[r.platform].get(r.date) || 1;
      const hf = hadFail[r.platform].get(r.date) || false;
      if (r.platform === '贴吧') {
        tieba.push({
          date: r.date,
          // 当天最后一次签到的业务时间 —— 首页要回答「什么时候签到的」
          timestamp: r.timestamp || null,
          total: r.total ?? 0,
          ok: r.ok ?? 0,
          fail: r.fail ?? 0,
          success: r.success !== false,
          successRate: r.successRate ?? null,
          failReason: r.failReason || null,
          attempts: att,
          hadFailure: hf,
        });
      } else if (r.platform === '色花堂') {
        sehuatang.push({
          date: r.date,
          timestamp: r.timestamp || null,
          durationSec: r.durationSec ?? null,
          durationText: r.durationText || mmss(r.durationSec),
          success: r.success !== false,
          steps: r.steps || null,
          failReason: r.failReason || null,
          attempts: att,
          hadFailure: hf,
        });
      }
    });

  const secs = sehuatang.map((r) => r.durationSec).filter((n) => n != null);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

  const tbOk = tieba.reduce((s, r) => s + (r.ok || 0), 0);
  const tbFail = tieba.reduce((s, r) => s + (r.fail || 0), 0);

  const summary = {
    tieba: {
      days: tieba.length,
      okDays: tieba.filter((r) => r.success).length,
      failDays: tieba.filter((r) => !r.success).length,
      totalOk: tbOk,
      totalFail: tbFail,
      successRate: tbOk + tbFail ? Number((tbOk / (tbOk + tbFail)).toFixed(4)) : null,
    },
    sehuatang: {
      days: sehuatang.length,
      okDays: sehuatang.filter((r) => r.success).length,
      failDays: sehuatang.filter((r) => !r.success).length,
      avgSec: avg(secs),
      minSec: secs.length ? Math.min(...secs) : null,
      maxSec: secs.length ? Math.max(...secs) : null,
    },
    lastDate: [...tieba.map((r) => r.date), ...sehuatang.map((r) => r.date)].sort().pop() || null,
  };

  const keptDays = tieba.length + sehuatang.length;
  const allDays = [...tieba, ...sehuatang];
  summary.dedupe = {
    rawRecords: rawCount, // 去重前的记录条数（含重试）
    keptDays, // 去重后按天保留的条数
    merged: Math.max(0, rawCount - keptDays), // 被合并掉的重复条数
    retryDays: allDays.filter((r) => r.attempts > 1).length, // 跑过多次的日期数
    recoveredDays: allDays.filter((r) => r.hadFailure && r.success).length, // 曾经失败但最终成功
  };

  return { tieba, sehuatang, summary };
}

// ---------------------------------------------------------------- 单测

const TEST_CASES = [
  {
    name: '色花堂 全成功',
    text: '📊 色花堂自动签到时间：2026-08-27 00:03:34\n登录： ✅\n回复： ✅\n签到： ✅\n耗时： 3分32秒',
    want: { platform: '色花堂', success: true, durationSec: 212, date: '2026-08-27' },
  },
  {
    name: '色花堂 签到失败',
    text: '📊 色花堂自动签到时间：2026-09-01 00:05:00\n登录： ✅\n回复： ✅\n签到： ❌\n耗时： 1分5秒',
    want: { platform: '色花堂', success: false, durationSec: 65, steps: { 登录: true, 回复: true, 签到: false } },
  },
  {
    name: '色花堂 只有秒',
    text: '📊 色花堂自动签到时间：2026-09-02 00:05:00\n登录： ✅\n回复： ✅\n签到： ✅\n耗时： 45秒',
    want: { durationSec: 45 },
  },
  {
    name: '贴吧 全成功',
    text: '📊 贴吧签到结果日期： 2026-08-27 00:01:35\n总计贴吧： 85\n签到成功： 85\n签到失败： 0',
    want: { platform: '贴吧', success: true, total: 85, ok: 85, fail: 0, successRate: 1 },
  },
  {
    name: '贴吧 有失败',
    text: '📊 贴吧签到结果日期： 2026-09-03 00:01:35\n总计贴吧： 85\n签到成功： 80\n签到失败： 5',
    want: { success: false, total: 85, ok: 80, fail: 5, successRate: 0.9412 },
  },
];

/** 去重相关的用例：断言的是「同一次签到被重推」与「同一天真的跑了两次」 */
const DEDUPE_CASES = [
  {
    name: '重推同一次签到 → 幂等键相同',
    run: () => {
      const text = '📊 贴吧签到结果日期： 2026-10-14 00:01:35\n总计贴吧： 85\n签到成功： 85\n签到失败： 0';
      const a = parseMessage({ message_id: 'om_aaa', body: { content: JSON.stringify({ title: 'x', elements: [[{ tag: 'text', text }]] }) } });
      const b = parseMessage({ message_id: 'om_bbb', body: { content: JSON.stringify({ title: 'x', elements: [[{ tag: 'text', text }]] }) } });
      return { pass: a.eventId === b.eventId && a.eventId.includes('2026-10-14'), got: `${a.eventId} / ${b.eventId}` };
    },
  },
  {
    name: '重推后去重 → 合并成 1 条且 attempts=2',
    run: () => {
      const mk = (id, ok, bad, fail) =>
        parseMessage({
          message_id: id,
          body: {
            content: JSON.stringify({
              title: 'x',
              elements: [[{ tag: 'text', text: `📊 贴吧签到结果日期： 2026-10-14 00:01:35\n总计贴吧： 85\n签到成功： ${ok}\n签到失败： ${bad}` }]],
            }),
          },
        });
      const r = dedupeRecords([mk('om_1', 80, 5), mk('om_2', 85, 0)]);
      return {
        pass: r.records.length === 1 && r.records[0].attempts === 2 && r.records[0].hadFailure === true && r.records[0].ok === 85,
        got: `剩 ${r.records.length} 条 attempts=${r.records[0].attempts} hadFailure=${r.records[0].hadFailure} ok=${r.records[0].ok}`,
      };
    },
  },
  {
    name: '时间缺失 → 退化用 message_id，不会互相覆盖',
    run: () => {
      const a = makeEventId({ platform: '贴吧' }, 'om_aaa');
      const b = makeEventId({ platform: '贴吧' }, 'om_bbb');
      return { pass: a !== b && a === '贴吧@msg:om_aaa', got: `${a} / ${b}` };
    },
  },
  {
    name: '同一天两次不同时间 → 按天聚合成 1 根柱，attempts=2',
    run: () => {
      const mk = (t, sign) => ({
        platform: '色花堂',
        date: '2026-10-14',
        timestamp: `2026-10-14T${t}+08:00`,
        success: sign,
        durationSec: 100,
      });
      const { sehuatang, summary } = aggregate([mk('00:05:00', false), mk('12:00:00', true)], null);
      return {
        pass: sehuatang.length === 1 && sehuatang[0].attempts === 2 && sehuatang[0].success === true && sehuatang[0].hadFailure === true && summary.dedupe.merged === 1,
        got: `柱 ${sehuatang.length} attempts=${sehuatang[0].attempts} success=${sehuatang[0].success} merged=${summary.dedupe.merged}`,
      };
    },
  },
  {
    name: '不同天的正常数据不会被误并',
    run: () => {
      const mk = (d) => ({ platform: '贴吧', date: d, timestamp: `${d}T00:01:35+08:00`, success: true, total: 85, ok: 85, fail: 0 });
      const { tieba, summary } = aggregate([mk('2026-10-13'), mk('2026-10-14')], null);
      return { pass: tieba.length === 2 && summary.dedupe.merged === 0, got: `${tieba.length} 天 merged=${summary.dedupe.merged}` };
    },
  },
];

/** 跑单测，全部通过返回 0 */
function runSelftest(log = console.log) {
  let pass = 0;
  const total = TEST_CASES.length + DEDUPE_CASES.length;

  TEST_CASES.forEach((c) => {
    const platform = detectPlatform(c.text);
    const got = platform === '色花堂' ? parseSehuatang(c.text) : parseTieba(c.text);
    const diffs = Object.entries(c.want).filter(([k, v]) => {
      const actual = got[k];
      if (v && typeof v === 'object') return JSON.stringify(actual) !== JSON.stringify(v);
      return actual !== v;
    });
    if (diffs.length === 0) {
      pass++;
      log(`  ✓ ${c.name}`);
    } else {
      log(`  ✗ ${c.name}`);
      diffs.forEach(([k, v]) => log(`      期望 ${k}=${JSON.stringify(v)}，实际 ${JSON.stringify(got[k])}`));
    }
  });

  DEDUPE_CASES.forEach((c) => {
    let r;
    try {
      r = c.run();
    } catch (e) {
      r = { pass: false, got: `抛错 ${e.message}` };
    }
    if (r.pass) {
      pass++;
      log(`  ✓ ${c.name}`);
    } else {
      log(`  ✗ ${c.name}`);
      log(`      ${r.got}`);
    }
  });

  log(`\n  ${pass}/${total} 通过`);
  return pass === total ? 0 : 1;
}

module.exports = {
  parseMessage,
  makeEventId,
  dedupeRecords,
  fromPayload,
  aggregate,
  runSelftest,
};
