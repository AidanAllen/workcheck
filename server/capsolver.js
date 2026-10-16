'use strict';

// CapSolver（云盾）打码平台的余额查询。
// 接口：POST https://api.capsolver.com/getBalance  body: { "clientKey": "..." }
// 返回：{ errorId, balance, packages: [] }  —— errorId === 0 才是成功
//
// 官方公开接口只有 createTask / getTaskResult / getBalance 三个，**没有用量统计**
// （试过 getTodayTaskCount / getUserInfo / getStatistics 等十余个路径全是 404，
// dashboard 的统计页要登录 session，不认 clientKey）。所以「当天用了多少」用
// 余额快照来推：每次查到真实余额就落一笔到 data/capsolver_usage.json，
// 用「今日首次采样 - 当前余额」得出当日消耗，再按单价折算大约多少次。
//
// 凭证在「接入配置 → 配置信息」页填写，落在 data/config.json（唯一出处，无环境变量覆盖）。
//   apiKey          打码平台的 clientKey
//   lowThreshold    低于它就提醒充值（美元）
//   unitPricePer1k  每千次的美元单价（默认 0.8，即 reCAPTCHA v2 档，用于把消耗金额折算成次数）
// 没配置时接口返回 configured:false，由前端提示去配置。

const fs = require('fs');
const path = require('path');
const express = require('express');

const { DATA_DIR } = require('./data_dir');
const config = require('./config');

// 用量快照仍是本地文件：它是「采样历史」，属于可随时重建的派生数据，不值得占一张表
const USAGE_FILE = path.join(DATA_DIR, 'capsolver_usage.json');
const API = 'https://api.capsolver.com/getBalance';
const TIMEOUT_MS = 15000;
const CACHE_MS = 30000; // 余额查询不扣费，但也没必要每次刷新都打官方接口
const DEFAULT_LOW = 0.5; // 低于这个额度前端会标红提醒充值
const DEFAULT_PRICE_PER_1K = 0.8; // 每千次单价（美元），用于把消耗金额折算成次数
const MAX_DAYS = 60; // 用量快照最多留两个月

let cache = null; // { at, data }

function readCreds() {
  const { configured, values } = config.get('capsolver');
  if (!configured) return null;
  const per1k = Number(values.unitPricePer1k) || DEFAULT_PRICE_PER_1K;
  return {
    apiKey: String(values.apiKey),
    lowThreshold: Number(values.lowThreshold) || DEFAULT_LOW,
    pricePerCall: per1k / 1000,
    pricePerCallLabel: `$${per1k}/千次`,
  };
}

const dayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function readUsageHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (j && j.days && typeof j.days === 'object') return j;
  } catch (_) {
    /* 首次运行或文件损坏 */
  }
  return { days: {} };
}

/** 每查到一次真实余额就记一笔，供「今日消耗」推算 */
function recordToday(balance) {
  if (!Number.isFinite(balance)) return null;
  const hist = readUsageHistory();
  const key = dayKey();
  const t = hist.days[key] || { first: balance, last: balance, min: balance, max: balance, samples: 0 };
  t.last = balance;
  t.min = Math.min(t.min, balance);
  t.max = Math.max(t.max, balance);
  t.samples += 1;
  hist.days[key] = t;

  const keys = Object.keys(hist.days).sort();
  while (keys.length > MAX_DAYS) delete hist.days[keys.shift()];

  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(hist, null, 2));
  } catch (_) {
    /* 写不了就只影响统计，不影响余额展示 */
  }
  return t;
}

/** 当日消耗 = 今日首次采样余额 - 当前余额；充过值时差值会小于 0，按 0 处理并标注 */
function usageOf(t, creds) {
  if (!t) return null;
  const delta = t.first - t.last;
  const toppedUp = t.max > t.first + 1e-6; // 中途涨过说明充值了
  const spent = Math.max(delta, 0);
  const count = spent > 0 && creds.pricePerCall > 0 ? Math.round(spent / creds.pricePerCall) : 0;
  return {
    date: dayKey(),
    startBalance: Number(t.first.toFixed(3)),
    spent: Number(spent.toFixed(4)),
    count,
    toppedUp,
    samples: t.samples,
    pricePerCallLabel: creds.pricePerCallLabel,
  };
}

async function query() {
  const creds = readCreds();
  if (!creds) {
    // 凭证刚被删掉时旧缓存不能继续用，否则页面上还显示着上一个账号的余额
    cache = null;
    return { configured: false, currency: 'USD' };
  }

  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS && cache.key === creds.apiKey) {
    return { configured: true, currency: 'USD', ...cache.data };
  }

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: creds.apiKey }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    const j = await res.json();

    if (j && j.errorId === 0) {
      const balance = Number(j.balance);
      const today = recordToday(balance);
      cache = {
        at: now,
        key: creds.apiKey,
        data: {
          balance,
          low: Number.isFinite(balance) && balance < creds.lowThreshold,
          threshold: creds.lowThreshold,
          packages: Array.isArray(j.packages) ? j.packages.length : 0,
          usage: usageOf(today, creds),
        },
      };
      return { configured: true, currency: 'USD', ...cache.data };
    }
    // key 无效、余额查询失败等，把官方描述透出来（errorDescription / errorCode）
    return {
      configured: true,
      currency: 'USD',
      error: (j && (j.errorDescription || j.errorCode)) || '查询失败',
    };
  } catch (e) {
    return { configured: true, currency: 'USD', error: `请求 CapSolver 失败：${e.message}` };
  }
}

const router = express.Router();

router.get('/api/capsolver/balance', async (req, res) => {
  res.json(await query());
});

// 后台定时采样：与 TT识图同一套做法，不看板也每 10 分钟记一笔快照，
// 让「今日消耗」的起点尽量早，估算的次数就更接近真实。
const SAMPLE_MS = 10 * 60 * 1000;
setInterval(() => {
  query().catch(() => { /* 采样失败不影响余额接口 */ });
}, SAMPLE_MS).unref?.();
query().catch(() => {});

module.exports = { router, query };
