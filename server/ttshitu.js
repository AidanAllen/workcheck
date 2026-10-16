'use strict';

// TT识图（ttshitu.com）打码平台的余额查询。
// 官方文档：http://www.ttshitu.com/docs/index.html
// 接口：GET http://api.ttshitu.com/queryAccountInfo.json?username=&password=
// 返回：{ success, code, message, data: { balance, consumed, successNum, failNum } }
//
// 注意 successNum / failNum / consumed 都是**累计值**，官方没有「今日用量」接口，
// 所以跟 CapSolver 一样用快照差值推算：每次查到真实数据就往 data/ttshitu_usage.json
// 落一笔，用「今日首次采样 → 当前」的增量得出当天的识别次数和消耗金额。
// 局限同样存在：当天第一次采样之前用掉的量算不进去（前端会标注起始时刻）。
//
// 凭证在「接入配置 → 配置信息」页填写，落在 data/config.json（唯一出处，无环境变量覆盖）。
// 没配置时接口返回 configured:false，由前端提示去配置。

const fs = require('fs');
const path = require('path');
const express = require('express');

const { DATA_DIR } = require('./data_dir');
const config = require('./config');

const USAGE_FILE = path.join(DATA_DIR, 'ttshitu_usage.json');
const API = 'http://api.ttshitu.com/queryAccountInfo.json';
const TIMEOUT_MS = 15000;
const CACHE_MS = 30000; // 余额查询不扣费，但也没必要每次刷新都打官方接口
const MAX_DAYS = 60; // 用量快照最多留两个月

let cache = null; // { at, data }

function readCreds() {
  const { configured, values } = config.get('ttshitu');
  if (!configured) return null;
  return { username: String(values.username), password: String(values.password) };
}

const dayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const hhmm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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

/** 每查到一次真实数据就记一笔累计值，供「今日识别次数」推算 */
function recordToday(snap) {
  const hist = readUsageHistory();
  const key = dayKey();
  const t = hist.days[key] || { first: snap, last: snap, samples: 0, at: Date.now() };
  t.last = snap;
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

/** 当天识别次数 = 当前累计 - 今日首次采样累计；累计值只增不减，充过值只会让 consumed 不动 */
function usageOf(t) {
  if (!t) return null;
  const success = Math.max(t.last.success - t.first.success, 0);
  const fail = Math.max(t.last.fail - t.first.fail, 0);
  const total = success + fail;
  const spent = Number(Math.max(t.last.consumed - t.first.consumed, 0).toFixed(4));
  return {
    date: dayKey(),
    total,
    success,
    fail,
    spent,
    // TT识图失败不扣费，均价按成功次数折算；没有成功量就不显示单价
    unitPrice: success > 0 && spent > 0 ? Number((spent / success).toFixed(4)) : null,
    since: hhmm(t.at),
    samples: t.samples,
  };
}

async function query() {
  const creds = readCreds();
  if (!creds) {
    // 凭证刚被删掉时旧缓存不能继续用，否则页面上还显示着上一个账号的余额
    cache = null;
    return { configured: false, currency: 'CNY' };
  }

  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS && cache.key === creds.username) {
    return { configured: true, currency: 'CNY', ...cache.data };
  }

  const url = `${API}?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    const j = await res.json();
    if (j && j.success) {
      const d = j.data || {};
      const snap = { success: num(d.successNum), fail: num(d.failNum), consumed: num(d.consumed) };
      const today = recordToday(snap);
      cache = {
        at: now,
        key: creds.username,
        data: {
          balance: d.balance,
          consumed: d.consumed,
          successNum: d.successNum,
          failNum: d.failNum,
          usage: usageOf(today),
        },
      };
      return { configured: true, currency: 'CNY', ...cache.data };
    }
    // 账号密码错误、用户被禁用等，把官方 message 透出来
    return { configured: true, currency: 'CNY', error: (j && j.message) || '查询失败' };
  } catch (e) {
    return { configured: true, currency: 'CNY', error: `请求打码平台失败：${e.message}` };
  }
}

const router = express.Router();

router.get('/api/ttshitu/balance', async (req, res) => {
  res.json(await query());
});

// 后台定时采样：不等看板被打开也每 10 分钟记一笔快照。
// 「今日识别次数」靠的是「今天首次采样 → 当前」的差值，采样越密、起点越早，
// 当天的次数就越准。服务一直开着的话，起点基本就是今天第一次记账的时刻。
const SAMPLE_MS = 10 * 60 * 1000;
const timer = setInterval(() => {
  query().catch(() => { /* 采样失败不影响余额接口，下一轮再试 */ });
}, SAMPLE_MS);
timer.unref?.(); // 别因为这个定时器拖住进程退出
query().catch(() => {}); // 启动即采一笔：服务启动后就用不掉之前的量了

module.exports = { router, query };
