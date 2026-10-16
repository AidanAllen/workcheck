'use strict';

// 通用工具（$ / api / toast / escapeHtml 等）在 common.js，本文件只管看板渲染。

const state = { checkinDays: 30, pane: 'dash' };
let lastCheckinSig = '';

// ---------------------------------------------------------------- 签到日历

function fmtDur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}分${s}秒` : `${s}秒`;
}

// 柱状图已移除：成功与否看日历格子颜色，明细点日历格子看

function renderCheckinSummary(sum) {
  const t = sum.tieba || {};
  const s = sum.sehuatang || {};
  const item = (label, value, cls) =>
    `<span class="cs-item">${label}<b class="${cls || ''}">${value}</b></span>`;

  const html = [
    item('贴吧', `${t.days || 0} 天`, t.failDays ? 'fail' : 'ok'),
    item('签到成功', fmt(t.totalOk), 'ok'),
    item('签到失败', fmt(t.totalFail), t.totalFail ? 'fail' : ''),
    t.successRate != null ? item('成功率', `${(t.successRate * 100).toFixed(1)}%`, t.successRate >= 1 ? 'ok' : 'fail') : '',
    item('色花堂', `${s.days || 0} 天`, s.failDays ? 'fail' : 'ok'),
    item('平均耗时', fmtDur(s.avgSec)),
    s.maxSec != null ? item('最长', fmtDur(s.maxSec)) : '',
    // date 从第三方报文来，渲染前必须转义（服务端已卡格式，这里是第二道）
    sum.lastDate ? item('最新', escapeHtml(sum.lastDate)) : '',
  ].join('');

  const dp = sum.dedupe;
  const dedupeHtml = dp
    ? [
        dp.merged > 0 ? item('已合并重复', `${dp.merged} 条`, 'ok') : '',
        dp.retryDays > 0 ? item('跑过多次', `${dp.retryDays} 天`) : '',
        dp.recoveredDays > 0 ? item('重试后成功', `${dp.recoveredDays} 天`, 'ok') : '',
      ].join('')
    : '';

  $('checkinSummary').innerHTML = html + dedupeHtml;
}

// ---------------------------------------------------------------- 签到日历

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dateOf = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
};
const dayGap = (a, b) => Math.round((dateOf(b) - dateOf(a)) / 86400000);

// 日历始终看全量数据，不受「近 N 天」筛选影响，否则翻到旧月份会一片空白
const cal = { year: 0, month: 0, map: new Map(), selected: null, sig: '', stats: null, range: null };

/** 有记录的最早 / 最晚一天。用于判断「这天是该签到却没签到」还是「那会儿还没开始统计」 */
function calcRange(map) {
  const keys = [...map.keys()].sort();
  if (!keys.length) return null;
  return { min: keys[0], max: keys[keys.length - 1] };
}

/** 两个平台的按天数据合成一张「日期 → 当天」的表 */
function buildDayMap(tieba, sehuatang) {
  const map = new Map();
  const put = (r, key) => {
    const e = map.get(r.date) || { date: r.date };
    e[key] = r;
    map.set(r.date, e);
  };
  tieba.forEach((r) => put(r, 'tieba'));
  sehuatang.forEach((r) => put(r, 'sehuatang'));
  return map;
}

/** 当天综合状态：ok 全成功 / fail 有失败 / none 没签到 */
function dayStatus(e) {
  if (!e || (!e.tieba && !e.sehuatang)) return 'none';
  const items = [e.tieba, e.sehuatang].filter(Boolean);
  if (items.some((r) => !r.success)) return 'fail';
  return 'ok';
}

/** 连续签到：以「当天有记录且没失败」为达标日 */
function calcStreaks(map) {
  const okDays = [...map.values()]
    .filter((e) => dayStatus(e) === 'ok')
    .map((e) => e.date)
    .sort();

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of okDays) {
    run = prev && dayGap(prev, d) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }

  // 当前连续：只认到「昨天为止还连着」的情况，断更太久就归零
  let current = 0;
  const last = okDays[okDays.length - 1];
  if (last) {
    const today = ymd(new Date());
    if (last === today || dayGap(last, today) === 1) {
      current = 1;
      for (let i = okDays.length - 1; i > 0; i--) {
        if (dayGap(okDays[i - 1], okDays[i]) !== 1) break;
        current++;
      }
    }
  }
  return { current, longest, total: okDays.length };
}

function dayTip(key, e) {
  if (!e || (!e.tieba && !e.sehuatang)) {
    return isMissed(key, false) ? `${key}　没有签到记录（漏签）` : `${key}　无签到数据`;
  }
  const parts = [];
  if (e.tieba) {
    const r = e.tieba;
    parts.push(`贴吧 ${r.ok}/${r.total} 成功${r.fail ? `，失败 ${r.fail}` : ''}`);
  }
  if (e.sehuatang) {
    const r = e.sehuatang;
    parts.push(`色花堂 ${r.durationText || fmtDur(r.durationSec)}${r.success ? '' : '（有步骤失败）'}`);
  }
  const retry = [e.tieba, e.sehuatang].filter(Boolean).find((r) => r.attempts > 1);
  if (retry) parts.push(`当天跑了 ${Math.max(e.tieba ? e.tieba.attempts : 0, e.sehuatang ? e.sehuatang.attempts : 0)} 次`);
  return parts.join(' ／ ');
}

// ------------------------------------------------- 最新一次签到（成功？几点？）

const p2 = (n) => String(n).padStart(2, '0');

/** 业务时间带 +08:00 偏移，转成用户本地时钟的时刻串 */
function tsText(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

const hhmmss = (ts) => (tsText(ts) || '').slice(11) || null;

function relDay(date) {
  const gap = dayGap(date, ymd(new Date()));
  if (gap === 0) return '今天';
  if (gap === 1) return '昨天';
  if (gap > 1) return `${gap} 天前`;
  return null;
}

/** 一张平台卡：成功/失败 + 签到时刻 + 关键数字 */
function latestCard(name, rec, kind) {
  if (!rec) {
    return `<div class="latest-card none">
      <div class="lc-top"><span class="lc-name">${name}</span><span class="lc-badge none">无数据</span></div>
      <div class="lc-time">这天没有收到签到卡片</div>
    </div>`;
  }
  const ok = rec.success;
  const when = tsText(rec.timestamp) || '时间未知';

  let meta;
  if (kind === 'tb') {
    meta =
      `签到成功 <b>${fmt(rec.ok)}</b> / 总计 ${fmt(rec.total)}` +
      (rec.fail ? `　失败 <b class="cs-fail">${fmt(rec.fail)}</b>${rec.failReason ? `（${escapeHtml(rec.failReason)}）` : ''}` : '');
  } else {
    const steps = rec.steps
      // steps 的键名是第三方报文里带过来的（checkin 原样透传），必须转义，否则一条
      // { steps: { "<img onerror=...>": true } } 就能在看板上执行脚本
      ? Object.entries(rec.steps).map(([k, v]) => `${escapeHtml(k)}<b class="st-${v ? 'ok' : 'no'}">${v ? '✓' : '✗'}</b>`).join(' ')
      : '';
    meta =
      `耗时 <b>${escapeHtml(rec.durationText || fmtDur(rec.durationSec))}</b>` +
      (steps ? `　${steps}` : '') +
      (rec.failReason ? `　${escapeHtml(rec.failReason)}` : '');
  }

  return `<div class="latest-card ${ok ? 'ok' : 'fail'}">
    <div class="lc-top"><span class="lc-name">${name}</span><span class="lc-badge ${ok ? 'ok' : 'fail'}">${ok ? '成功' : '失败'}</span></div>
    <div class="lc-time">签到时间 <b>${when}</b></div>
    <div class="lc-meta">${meta}</div>
  </div>`;
}

/** 最新有数据的那一天，两个平台各出一张卡 */
function renderLatest() {
  const box = $('latestBox');
  if (!box) return;
  if (!cal.range) {
    box.innerHTML = '<div class="empty">还没有任何签到数据</div>';
    return;
  }
  const date = cal.range.max;
  const e = cal.map.get(date) || {};
  const rel = relDay(date);
  box.innerHTML =
    `<div class="latest-head">最新一次签到 <b>${escapeHtml(date)}</b>${rel ? `<span class="lc-rel">${rel}</span>` : ''}</div>` +
    `<div class="latest-grid">${latestCard('贴吧', e.tieba, 'tb')}${latestCard('色花堂', e.sehuatang, 'st')}</div>`;
}

function renderCalDetail(date) {
  const box = $('calDetail');
  if (!date) {
    box.innerHTML = '<div class="empty">👆 点日历上的任意一天，看当天签到是否成功、几点签的、失败原因</div>';
    return;
  }
  const e = cal.map.get(date);
  const st = dayStatus(e);
  const d = dateOf(date);
  const tagText = st === 'ok' ? '全部成功' : st === 'fail' ? '有失败' : '无签到';
  const head = `<div class="cd-head">
      <span class="cd-date">${escapeHtml(date)}</span>
      <span class="cd-week">周${WEEK_CN[d.getDay()]}</span>
      <span class="tag ${st}">${tagText}</span>
    </div>`;

  if (st === 'none') {
    box.innerHTML = head + '<div>这一天没有收到任何签到卡片。</div>';
    return;
  }

  const lines = [];
  if (e.tieba) {
    const r = e.tieba;
    lines.push(
      `<div class="cd-line"><span class="cd-name">贴吧</span>
        <span>签到成功 <b>${fmt(r.ok)}</b> / 总计 ${fmt(r.total)}${r.fail ? `　失败 <b class="cs-fail">${fmt(r.fail)}</b>` : ''}
        ${r.failReason ? `　${escapeHtml(r.failReason)}` : ''}
        <span class="cd-time">${hhmmss(r.timestamp) || '时间未知'}</span></span></div>`
    );
  }
  if (e.sehuatang) {
    const r = e.sehuatang;
    const steps = r.steps
      // 同上：键名来自外部报文，转义后再拼进 HTML
      ? Object.entries(r.steps).map(([k, v]) => `${escapeHtml(k)}<b class="st-${v ? 'ok' : 'no'}">${v ? '✓' : '✗'}</b>`).join(' ')
      : '';
    lines.push(
      `<div class="cd-line"><span class="cd-name">色花堂</span>
        <span>耗时 <b>${escapeHtml(r.durationText || fmtDur(r.durationSec))}</b>${steps ? `　${steps}` : ''}
        ${r.failReason ? `　${escapeHtml(r.failReason)}` : ''}
        <span class="cd-time">${hhmmss(r.timestamp) || '时间未知'}</span></span></div>`
    );
  }

  const maxAttempts = Math.max((e.tieba && e.tieba.attempts) || 1, (e.sehuatang && e.sehuatang.attempts) || 1);
  const recovered = [e.tieba, e.sehuatang].filter(Boolean).some((r) => r.hadFailure && r.success);
  const retry =
    maxAttempts > 1
      ? `<div class="cd-retry">当天共跑了 ${maxAttempts} 次${recovered ? '（首次失败，重试后成功）' : ''}</div>`
      : '';

  box.innerHTML = head + lines.join('') + retry;
}

/** 这天属于「开始统计之后、已经过去、却没有任何签到」→ 漏签 */
function isMissed(key, hasData) {
  if (hasData || !cal.range) return false;
  const todayKey = ymd(new Date());
  return key >= cal.range.min && key <= todayKey;
}

function renderCalStat() {
  const { year, month } = cal;
  const total = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  let okDays = 0;
  let failDays = 0;
  let missed = 0;
  for (let i = 1; i <= total; i++) {
    const d = new Date(year, month, i);
    const key = ymd(d);
    const st = dayStatus(cal.map.get(key));
    if (st === 'ok') okDays++;
    else if (st === 'fail') failDays++;
    else if (isMissed(key, false)) missed++; // 未来的日子、开始统计之前的日子都不算漏签
  }
  const s = cal.stats || { current: 0, longest: 0 };
  const stats = [
    `本月签到 <b>${okDays + failDays}</b> 天`,
    `成功 <b class="cs-ok">${okDays}</b>`,
    failDays ? `失败 <b class="cs-fail">${failDays}</b>` : '',
    missed ? `漏签 <b class="cs-miss">${missed}</b>` : '',
    `连续 <b>${s.current}</b> 天`,
    `最长 <b>${s.longest}</b> 天`,
  ].filter(Boolean);

  // 整月都在数据起始之前，别报一堆「漏签」，直接说明从哪天开始有数据
  const monthEnd = ymd(new Date(year, month, total));
  if (cal.range && monthEnd < cal.range.min) {
    stats.push(`<span class="cs-sep">数据起始于 ${escapeHtml(cal.range.min)}</span>`);
  }

  $('calStat').innerHTML = stats.join('<span class="cs-sep">·</span>');
}

function renderCalendar() {
  const { year, month } = cal;
  $('calTitle').textContent = `${year} 年 ${month + 1} 月`;

  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const startDay = new Date(year, month, 1 - first.getDay());
  const endDay = new Date(year, month, last.getDate() + (6 - last.getDay()));
  const todayKey = ymd(new Date());

  let html = '';
  for (let d = new Date(startDay); d <= endDay; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const key = ymd(d);
    const inMonth = d.getMonth() === month;
    const e = cal.map.get(key);
    const st = dayStatus(e);
    const cls = ['cal-cell', 'day', st];
    // 1 号之前、月末之后的格子也渲染邻月真实数据，只是弱化显示，不抢当月的焦点
    if (!inMonth) cls.push('out');
    // 漏签只标在当月格子上：邻月补位格保持弱化观感，切到那个月再看漏签
    if (inMonth && isMissed(key, !!e)) cls.push('missed');
    if (inMonth && key === todayKey) cls.push('today');
    if (key > todayKey) cls.push('future');
    if (key === cal.selected) cls.push('sel');

    const mk = (which, rec) => {
      if (!rec) return `<i class="mk ${which}"></i>`;
      return `<i class="mk ${which} ${rec.success ? 'ok' : 'fail'}"></i>`;
    };
    const retry = [e && e.tieba, e && e.sehuatang].filter(Boolean).some((r) => r.attempts > 1);

    html += `<div class="${cls.join(' ')}" data-date="${key}" title="${escapeHtml(dayTip(key, e))}">
      <span class="cal-day">${d.getDate()}</span>
      ${retry ? '<span class="cal-badge">↻</span>' : ''}
      <span class="cal-marks">${mk('tb', e && e.tieba)}${mk('st', e && e.sehuatang)}</span>
    </div>`;
  }

  $('calGrid').innerHTML = html;
  renderCalStat();
  renderCalDetail(cal.selected);
}

function shiftMonth(delta) {
  const d = new Date(cal.year, cal.month + delta, 1);
  cal.year = d.getFullYear();
  cal.month = d.getMonth();
  renderCalendar();
}

async function refreshCalendar(force) {
  let d;
  try {
    d = await api('/api/checkin/daily?days=0');
  } catch (err) {
    console.error(err);
    return;
  }
  const sig = [
    d.tieba.length,
    d.sehuatang.length,
    d.summary.lastDate,
    d.summary.tieba.totalFail,
    d.summary.sehuatang.failDays,
  ].join('|');
  if (!force && sig === cal.sig) return;
  cal.sig = sig;
  cal.map = buildDayMap(d.tieba, d.sehuatang);
  cal.stats = calcStreaks(cal.map);
  cal.range = calcRange(cal.map);
  renderLatest();

  // 首次加载时定位到最新有数据的月份，并选中那一天
  if (!cal.year) {
    const base = d.summary.lastDate ? dateOf(d.summary.lastDate) : new Date();
    cal.year = base.getFullYear();
    cal.month = base.getMonth();
    cal.selected = d.summary.lastDate || ymd(new Date());
  }
  renderCalendar();
}

// 打码平台余额：账号密码在服务端 data/ttshitu.json，前端只见结果不见凭证
async function loadTtshitu() {
  const box = $('ttBody');
  try {
    const d = await api('/api/ttshitu/balance');
    if (!d.configured) {
      box.innerHTML =
        '<div class="empty">未配置打码平台账号。在服务端 data/ttshitu.json 写入 ' +
        '<code class="field">{"username":"账号","password":"密码"}</code> 后点刷新。</div>';
      return;
    }
    if (d.error) {
      box.innerHTML = `<div class="empty" style="color:var(--fail)">${escapeHtml(d.error)}</div>`;
      return;
    }
    const u = d.usage;
    // TT识图官方只有「累计成功/失败数」，没有今日用量接口；
    // 今日识别次数 = 现在的累计数 − 今天首次采样时的累计数，悬停可看统计起点
    const tip = u
      ? `自今天 ${escapeHtml(u.since)} 首次采样起统计，已采样 ${escapeHtml(String(u.samples))} 次` +
        `（成功 ${escapeHtml(String(u.success))} · 失败 ${escapeHtml(String(u.fail))}）。` +
        '官方接口只有累计值，他处调用或服务停机期间的次数不计入'
      : '';
    const usageHtml = `<span${tip ? ` title="${tip}"` : ''}>今日识别 <b>${u ? fmt(u.total) : '—'}</b> 次</span>`;

    box.innerHTML = `
      <div class="tt-balance"><b>${escapeHtml(d.balance)}</b><span>元 · 实时余额</span></div>
      <div class="tt-meta">
        ${usageHtml}
        <span title="账号开通以来的累计消费">累计消费 <b>¥${escapeHtml(d.consumed)}</b></span>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="empty" style="color:var(--fail)">查询失败：${escapeHtml(err.message)}</div>`;
  }
}

// CapSolver（云盾）余额：API Key 在服务端 data/capsolver.json，前端只见结果
async function loadCapsolver() {
  const box = $('csBody');
  try {
    const d = await api('/api/capsolver/balance');
    if (!d.configured) {
      box.innerHTML =
        '<div class="empty">未配置 CapSolver。在服务端 data/capsolver.json 写入 ' +
        '<code class="field">{"apiKey":"CAP-..."}</code> 后点刷新。</div>';
      return;
    }
    if (d.error) {
      box.innerHTML = `<div class="empty" style="color:var(--fail)">${escapeHtml(d.error)}</div>`;
      return;
    }
    const bal = Number(d.balance);
    const show = Number.isFinite(bal) ? bal.toFixed(3) : String(d.balance);
    // 低于阈值时整张卡变警示色，避免余额悄悄见底才被发现
    const low = d.low ? ' low' : '';
    // 官方没有用量统计接口，这里是按「今日首次采样余额 - 当前余额」推算的
    const u = d.usage;
    const usageHtml = !u
      ? ''
      : `<span title="今日首次采样余额 $${escapeHtml(String(u.startBalance))}，按 ${escapeHtml(u.pricePerCallLabel || '')} 折算">
          今日消耗 <b>$${escapeHtml(String(u.spent))}</b>　约 <b>${fmt(u.count)}</b> 次
        </span>`;
    const recharge = u && u.toppedUp ? '<span class="bal-topup">当天充过值</span>' : '';

    box.innerHTML = `
      <div class="tt-balance${low}"><span class="cur">$</span><b>${escapeHtml(show)}</b><span>USD · 实时余额</span></div>
      <div class="tt-meta">
        ${usageHtml}
        ${recharge}
        ${d.low ? `<span class="bal-warn">⚠️ 余额低于 ${escapeHtml(String(d.threshold))}，记得充值</span>` : '<span>余额充足</span>'}
        ${d.packages ? `<span>套餐 <b>${escapeHtml(String(d.packages))}</b> 个</span>` : ''}
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="empty" style="color:var(--fail)">查询失败：${escapeHtml(err.message)}</div>`;
  }
}

function loadBalances() {
  loadTtshitu();
  loadCapsolver();
}

async function refreshCheckin(force) {
  let d;
  try {
    d = await api(`/api/checkin/daily?days=${state.checkinDays}`);
  } catch (err) {
    console.error(err);
    return;
  }
  // 数据没变就不重绘，避免每 10 秒自动刷新时鼠标悬停被中断
  const sig = [
    d.tieba.length,
    d.sehuatang.length,
    d.summary.lastDate,
    d.summary.tieba.totalFail,
    d.summary.sehuatang.avgSec,
    (d.summary.dedupe && d.summary.dedupe.merged) || 0,
  ].join('|');
  if (!force && sig === lastCheckinSig) return;
  lastCheckinSig = sig;

  renderCheckinSummary(d.summary);
  await refreshCalendar(force);
}

// ------------------------------------------------------------ 分页
// 两块运维列表共用同一套服务端 offset 分页：
//   原始报文 = 传统翻页（上一页/下一页），每页 8 条
//   实时日志 = 瀑布流（滚到底再加载一批），每次向 /api/logs 要 10 条，
//              窗口高度正好卡 8 行，多出来的两行要滚一下才看得到
const PAGE_SIZE = 8;
const LOG_FETCH = 10;   // 实时日志每次请求的条数（limit）
const LOG_VIEW_ROWS = 8; // 日志窗口显示几行，容器高度按它实测算
/** 瀑布上限：页面常年开着、新日志还一直往顶部插，不封顶会越来越长 */
const LOG_MAX_ROWS = 200;
const PAGES = {
  logs: {
    page: 0, total: 0, url: '/api/logs', listId: 'logList', footId: 'logFoot', size: LOG_FETCH,
    mode: 'append', loading: false, seen: new Set(),
  },
  events: {
    page: 0, total: 0, url: '/api/events', listId: 'eventList', pagerId: 'rawPager', size: PAGE_SIZE,
    mode: 'replace',
  },
};

const pageCount = (total, size) => Math.max(1, Math.ceil(total / size));
/** 瀑布：还有没加载完的吗（page 在 append 模式下记的是「已加载批数」） */
const hasMore = (p) => p.page * p.size < p.total;
/** 去重键：服务端行带自增 id，用它最准；SSE 推来的也是同一条行 */
const logKey = (r) => String(r.id);

function renderPager(name) {
  const p = PAGES[name];
  const box = p.pagerId && $(p.pagerId);
  if (!box) return;
  if (!p.total) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const cnt = pageCount(p.total, p.size);
  box.hidden = false;
  box.innerHTML = `
    <button class="btn mini" type="button" data-page="prev" ${p.page === 0 ? 'disabled' : ''}>‹ 上一页</button>
    <span class="pager-info">第 ${p.page + 1} / ${cnt} 页 · 共 ${p.total} 条</span>
    <button class="btn mini" type="button" data-page="next" ${p.page >= cnt - 1 ? 'disabled' : ''}>下一页 ›</button>`;
}

/** 瀑布底栏：还有就提示继续滚，到底了就说清楚 */
function renderFoot(name) {
  const p = PAGES[name];
  const el = p.footId && $(p.footId);
  if (!el) return;
  const list = $(p.listId);
  const shown = list ? list.querySelectorAll('.log-row').length : 0;
  if (!p.total) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = hasMore(p)
    ? `向下滚动加载更多 · 已显示 ${shown} / ${p.total} 条`
    : `已经到底了 · 共 ${p.total} 条`;
}

/** 拉第 index 页：只取数据，不动状态 */
async function fetchPage(name, index) {
  const p = PAGES[name];
  const d = await api(`${p.url}?limit=${p.size}&offset=${index * p.size}`);
  p.total = d.total;
  return d.items;
}

/** 传统翻页用：数据变少导致页码越界（例如删了来源）时退回最后一页 */
async function loadPage(name) {
  const p = PAGES[name];
  const max = () => Math.max(0, pageCount(p.total, p.size) - 1);
  if (p.page > max()) p.page = max();
  const items = await fetchPage(name, p.page);
  if (p.page > max()) {
    p.page = max();
    return loadPage(name);
  }
  return items;
}

function scrollListToTop(name) {
  const el = $(PAGES[name].listId);
  if (el) el.scrollTop = 0;
}

/** 再加载一页追加到列表末尾（瀑布流的核心动作） */
async function appendLogs() {
  const p = PAGES.logs;
  if (p.loading || !hasMore(p)) return;
  p.loading = true;
  try {
    const rows = await fetchPage('logs', p.page);
    if (!rows.length) return;
    p.page += 1;
    // 期间有新日志插到头部的话，这一页会跟已渲染的重复几条，按 id 跳过
    const fresh = rows.filter((r) => !p.seen.has(logKey(r)));
    fresh.forEach((r) => p.seen.add(logKey(r)));
    if (fresh.length) {
      const list = $('logList');
      list.insertAdjacentHTML('beforeend', fresh.map((r) => logRowHtml(r, false)).join(''));
      trimLogs();
    }
  } finally {
    p.loading = false;
    renderFoot('logs');
  }
}

/** 日志窗口正好显示 LOG_VIEW_ROWS 行：按实测行高反推容器高度（含 row-gap），
    比写死 px 靠谱 —— 窄屏下日志行会折成两行，行高跟着变 */
function sizeLogWindow() {
  const list = $('logList');
  if (!list) return;
  const first = list.querySelector('.log-row');
  if (!first) return; // 空列表先不作调整，保持样式里的兜底高度
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
  const rowH = first.getBoundingClientRect().height;
  if (!rowH) return;
  const h = Math.ceil(rowH * LOG_VIEW_ROWS + gap * (LOG_VIEW_ROWS - 1));
  // 一条日志现在占两行（竖屏三行），8 条不再像单行时那么矮：
  // 按视口高度留一道封顶，免得矮屏笔记本上日志窗口吞掉整屏
  // 480 与 style.css 里日志三行式的断点保持一致：只有真正的手机竖屏才封到一半屏高
  const cap = window.innerWidth <= 480
    ? Math.round(window.innerHeight * 0.5)
    : Math.round(window.innerHeight * 0.65);
  list.style.maxHeight = `${Math.min(h, cap)}px`;
}

/** 首屏数据量不够铺满窗口时（比如只剩 3 条），顺手再补一批；
    窗口已经填满就打住，剩下的交给滚动 */
async function fillIfShort() {
  const p = PAGES.logs;
  const list = $('logList');
  let guard = 0;
  while (hasMore(p) && list.querySelectorAll('.log-row').length < LOG_VIEW_ROWS && guard < 10) {
    guard += 1;
    const before = p.page;
    await appendLogs();
    if (p.page === before) break; // 没吃到新数据就停，别死循环
  }
}

async function gotoPage(name, page) {
  const p = PAGES[name];
  const next = Math.min(Math.max(0, page), Math.max(0, pageCount(p.total, p.size) - 1));
  if (next === p.page) {
    scrollListToTop(name);
    return;
  }
  p.page = next;
  if (name === 'logs') await loadLogs();
  else await renderEvents();
}

function bindPagers() {
  for (const name of Object.keys(PAGES)) {
    const p = PAGES[name];
    const box = p.pagerId && $(p.pagerId);
    if (box && box.dataset.bound !== '1') {
      box.dataset.bound = '1';
      box.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-page]');
        if (!btn || btn.disabled) return;
        gotoPage(name, p.page + (btn.dataset.page === 'next' ? 1 : -1));
      });
    }
    // 瀑布：滚到底自动再加载一页
    if (p.mode === 'append') {
      const list = $(p.listId);
      if (list && list.dataset.waterfall !== '1') {
        list.dataset.waterfall = '1';
        list.addEventListener(
          'scroll',
          async () => {
            if (list.scrollTop + list.clientHeight >= list.scrollHeight - 60) {
              await appendLogs();
              await fillIfShort();
            }
          },
          { passive: true }
        );
        // 窗口宽度变了要重算高度：窄屏下日志行会折成两行，8 行的高度不再是原来那个数
        let rt;
        window.addEventListener('resize', () => {
          clearTimeout(rt);
          rt = setTimeout(sizeLogWindow, 150);
        });
      }
    }
  }
}

function logRowHtml(r, isNew) {
  const cls = r.ok ? 'ok' : 'fail';
  return `<div class="log-row${isNew ? ' new' : ''}" data-id="${r.id}">
    <span class="log-time">${localTime(r.ts)}</span>
    <span class="log-status ${cls}">${r.status}</span>
    <span class="log-src" title="${escapeHtml(r.source_name)}">${escapeHtml(r.source_name)}</span>
    <span class="log-msg" title="${escapeHtml(r.message)}">${escapeHtml(r.message || '—')}</span>
    <span class="log-ms">${r.latency_ms}ms</span>
  </div>`;
}

function addLog(r, isNew) {
  // 面板收起时不更新 DOM，省掉无谓的重排；展开时会整体重渲染
  if (!opens.logPanel) return;
  const list = $('logList');
  const p = PAGES.logs;
  if (p.seen.has(logKey(r))) return;
  p.total += 1;
  // 先记进 seen 再决定插不插 DOM：否则这条「暂时没插」的日志之后会被 appendLogs
  // 当成没见过的数据追加到列表末尾，最新的一条反而显示在最下面
  p.seen.add(logKey(r));

  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  // 用户正滚在下面时别往头部插，会把视线顶跑：只更新计数与底栏，回到顶部再看是新的
  if (list.scrollTop > 60) {
    renderFoot('logs');
    return;
  }
  const div = document.createElement('div');
  div.innerHTML = logRowHtml(r, isNew);
  list.insertBefore(div.firstElementChild, list.firstChild);
  trimLogs();
  sizeLogWindow(); // 列表原本是空的时候才有第一行的行高可量
  renderFoot('logs');
}

/** 列表封顶：超过上限就从尾巴删。seen 同步跟着瘦，
    否则页面挂一天集合只会变大，而最老那些行永远不会再被用到 */
function trimLogs() {
  const rows = $('logList').querySelectorAll('.log-row');
  for (let i = rows.length - 1; i >= LOG_MAX_ROWS; i--) {
    if (rows[i].dataset.id) PAGES.logs.seen.delete(String(rows[i].dataset.id));
    rows[i].remove();
  }
}

async function loadLogs() {
  // 收起时连请求都不发：本来就要按 pageSize 渲染，没必要白跑一趟
  if (!opens.logPanel) return;
  const p = PAGES.logs;
  p.page = 0;
  p.seen = new Set();
  const rows = await loadPage('logs');
  const list = $('logList');
  if (!rows.length) {
    list.innerHTML = '<div class="empty">暂无日志，推送一条数据后这里会实时出现</div>';
    renderFoot('logs');
    return;
  }
  rows.forEach((r) => p.seen.add(logKey(r)));
  p.page = 1;
  list.innerHTML = rows.map((r) => logRowHtml(r, false)).join('');
  list.scrollTop = 0;
  sizeLogWindow();
  renderFoot('logs');
  await fillIfShort();
}

async function renderEvents() {
  // 面板收起时不必渲染，报文展开时才拉数据
  if (!opens.rawPanel) return;

  const rows = await loadPage('events');
  $('rawCount').textContent = PAGES.events.total;
  $('rawCountWrap').hidden = false;
  const box = $('eventList');
  if (!rows.length) {
    box.innerHTML = '<div class="empty">还没有收到任何数据</div>';
    renderPager('events');
    return;
  }
  box.innerHTML = rows
    .map((e) => {
      let pretty = e.payload;
      try {
        pretty = JSON.stringify(JSON.parse(e.payload), null, 2);
      } catch (_) {
        /* keep raw */
      }
      const clipped = pretty.length > 2000 ? pretty.slice(0, 2000) + '\n…（已截断，完整报文在服务端）' : pretty;
      return `<details class="evt">
        <summary>
          <span class="evt-head">
            <span class="evt-caret">▸</span>
            <span>${escapeHtml(e.source_name || '未知来源')}</span>
            <span><code class="field">${escapeHtml(e.event_id)}</code></span>
            <span>业务时间 ${escapeHtml((e.event_time || '').replace('T', ' ').slice(0, 19))}</span>
            <span>${e.size} 字节</span>
          </span>
        </summary>
        <pre class="payload">${escapeHtml(clipped)}</pre>
      </details>`;
    })
    .join('');
  renderPager('events');
  scrollListToTop('events');
}

// ------------------------------------------------------------ 折叠面板
// 四个数据面板都靠 head[data-toggle] + [data-panel-body] 折叠，
// 各自的展开状态分开记住：默认展开三个、报文默认收起（报文展开时才拉数据）
const OPEN_KEYS = {
  rawPanel: 'workcheck.rawOpen',
  logPanel: 'workcheck.logOpen',
  balancePanel: 'workcheck.balOpen',
  checkinPanel: 'workcheck.checkinOpen',
};
const opens = { rawPanel: false, logPanel: true, balancePanel: true, checkinPanel: true };

/** 事件是否落在标题行自带的控件上（刷新按钮、日期区间等）：是的话不触发折叠 */
function clickOnHeadControl(e) {
  return !!(e && e.target && e.target.closest && e.target.closest('button, a, input, select, .segmented'));
}

function setPanelOpen(id, open) {
  opens[id] = open;
  const panel = $(id);
  const body = panel.querySelector('[data-panel-body]');
  const head = panel.querySelector('[data-toggle]');
  panel.classList.toggle('collapsed', !open);
  body.hidden = !open;
  head.setAttribute('aria-expanded', String(open));
  try {
    localStorage.setItem(OPEN_KEYS[id], open ? '1' : '0');
  } catch (_) {
    /* 隐私模式下写不了，忽略 */
  }
}

/** @param onExpand 展开时才要做的事（拉数据 / 重渲染），收起时什么都不做 */
function bindPanel(id, onExpand) {
  try {
    const saved = localStorage.getItem(OPEN_KEYS[id]);
    if (saved !== null) opens[id] = saved === '1';
  } catch (_) {
    /* ignore */
  }
  setPanelOpen(id, opens[id]);

  const head = $(id).querySelector('[data-toggle]');
  const toggle = (e) => {
    // 标题行里的按钮（刷新、日期区间）不算点标题，别顺手把面板收起来
    if (clickOnHeadControl(e)) return;
    setPanelOpen(id, !opens[id]);
    if (opens[id] && onExpand) onExpand();
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    // 焦点在标题行自带的按钮上时，回车/空格归按钮自己处理，别顺带折叠面板
    if (e.target !== head) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(e);
    }
  });
}

async function refreshAll() {
  // 面板收起时不刷新里面的数据：看不见就没必要发请求
  if (opens.checkinPanel) await refreshCheckin();
  // 和其它面板一样先判开关。renderEvents 内部还有一道同样的判断作兜底，
  // 两层都在：这层省掉无谓的调用，那层保证任何调用方都不会漏。
  if (opens.rawPanel) await renderEvents();
}

function connectStream() {
  const es = new EventSource('/api/stream/logs');
  es.addEventListener('hello', () => {
    $('streamState').textContent = '已连接，实时接收';
    $('liveDot').classList.remove('off');
  });
  es.addEventListener('log', (ev) => {
    try {
      addLog(JSON.parse(ev.data), true);
    } catch (_) {
      /* ignore */
    }
  });
  es.onerror = () => {
    $('streamState').textContent = '连接中断，正在重连…';
    $('liveDot').classList.add('off');
  };
}

/** 标签切换：看板（图形+汇总）与日志/报文分开，首页不被运维细节淹没 */
const PANES = { dash: 'paneDash', logs: 'paneLogs' };

function switchPane(name) {
  if (!PANES[name]) return;
  state.pane = name;
  for (const [key, id] of Object.entries(PANES)) {
    const pane = $(id);
    if (pane) pane.hidden = key !== name;
  }
  // 同步到地址栏：刷新后仍停在当前标签，也方便直接分享 #logs
  if (location.hash !== `#${name}` && typeof history !== 'undefined' && history.replaceState) {
    history.replaceState(null, '', `#${name}`);
  }
  document.querySelectorAll('#mainTabs .tab').forEach((btn) => {
    const on = btn.dataset.pane === name;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  });
}

function bindTabs() {
  const tabs = $('mainTabs');
  if (!tabs) return;
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    switchPane(btn.dataset.pane);
  });
}

// ------------------------------------------------------------ 模块拖动排序

/** 面板顺序记在本地，下次打开还是自己排的样子 */
const ORDER_KEY = 'workcheck.paneOrder';
let defaultOrder = null;
const drag = { panel: null, box: null, moved: false };

function panelsOf(paneId) {
  const box = $(paneId);
  if (!box) return [];
  return Array.from(box.children).filter((el) => el.classList && el.classList.contains('panel'));
}

function currentOrder() {
  const out = {};
  for (const [name, paneId] of Object.entries(PANES)) {
    out[name] = panelsOf(paneId).map((el) => el.id).filter(Boolean);
  }
  return out;
}

/** 按给定顺序重排每个标签页内的面板，顺序里没有的面板保持原位 */
function applyOrder(order) {
  let applied = false;
  for (const [name, paneId] of Object.entries(PANES)) {
    const box = $(paneId);
    const ids = (order && order[name]) || [];
    if (!box || !Array.isArray(ids)) continue;
    for (const id of ids) {
      const el = $(id);
      if (el && el.parentElement === box) {
        box.appendChild(el);
        applied = true;
      }
    }
  }
  return applied;
}

function readSavedOrder() {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY));
    return v && typeof v === 'object' ? v : null;
  } catch (_) {
    return null;
  }
}

function saveOrder() {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(currentOrder()));
  } catch (_) {
    /* 隐私模式写不了，忽略 */
  }
}

function updateResetBtn() {
  const btn = $('resetOrder');
  if (btn) btn.hidden = !readSavedOrder();
}

function onDragMove(e) {
  if (!drag.panel) return;
  drag.moved = true;
  const y = e.clientY;
  for (const el of panelsOf(drag.box.id)) {
    if (el === drag.panel) continue;
    const r = el.getBoundingClientRect();
    if (y < r.top || y > r.bottom) continue;
    // 指针落在对方上半区就插到前面，下半区插到后面
    const ref = y > r.top + r.height / 2 ? el.nextElementSibling : el;
    if (ref !== drag.panel) drag.box.insertBefore(drag.panel, ref);
    return;
  }
}

function onDragEnd() {
  if (!drag.panel) return;
  drag.panel.classList.remove('dragging');
  document.body.classList.remove('dragging');
  const moved = drag.moved;
  drag.panel = null;
  drag.box = null;
  if (moved) {
    saveOrder();
    updateResetBtn();
  }
}

function bindDrag() {
  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest && e.target.closest('.drag-handle');
    if (!handle) return;
    const panel = handle.closest('.panel');
    const box = panel && panel.parentElement;
    if (!panel || !box) return;
    e.preventDefault(); // 防止拖动时选中文本
    drag.panel = panel;
    drag.box = box;
    drag.moved = false;
    panel.classList.add('dragging');
    document.body.classList.add('dragging');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (_) {
      /* 不支持指针捕获时，靠 document 上的 move 也能拖 */
    }
  });

  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragEnd);

  // 手柄在可折叠面板里，点它不该触发折叠
  document.addEventListener(
    'click',
    (e) => {
      if (e.target.closest && e.target.closest('.drag-handle')) e.stopPropagation();
    },
    true
  );
}

function resetOrder() {
  try {
    localStorage.removeItem(ORDER_KEY);
  } catch (_) {
    /* ignore */
  }
  if (defaultOrder) applyOrder(defaultOrder);
  updateResetBtn();
  toast('已恢复默认顺序');
}

function bindEvents() {
  bindTabs();
  bindDrag();
  const rs = $('resetOrder');
  if (rs) rs.addEventListener('click', resetOrder);

  $('checkinRange').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.checkinDays = Number(btn.dataset.days);
    document.querySelectorAll('#checkinRange button').forEach((b) => b.classList.toggle('active', b === btn));
    refreshCheckin(true);
  });

  $('calPrev').addEventListener('click', () => shiftMonth(-1));
  $('calNext').addEventListener('click', () => shiftMonth(1));
  $('calToday').addEventListener('click', () => {
    const now = new Date();
    cal.year = now.getFullYear();
    cal.month = now.getMonth();
    cal.selected = ymd(now);
    renderCalendar();
  });

  $('calGrid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-cell.day');
    if (!cell) return;
    cal.selected = cell.dataset.date;
    renderCalendar();
  });

  $('balRefresh').addEventListener('click', loadBalances);
}

// 数据变化慢（签到两小时才拉一次），日志走 SSE 实时推送，页面不需要轮询
(async function init() {
  bindEvents();
  bindPanel('balancePanel', loadBalances); // 余额默认展开，展开时重查一次（服务端有 30s 缓存）
  bindPanel('checkinPanel', () => refreshCheckin(true)); // 收起期间可能来过新数据，展开时强制重画
  bindPanel('logPanel', loadLogs); // 日志默认展开；从收起态展开时补拉一次列表
  bindPanel('rawPanel', renderEvents); // 报文默认收起，展开时才拉数据
  bindPagers(); // 日志/报文的翻页按钮
  initThemeSwitcher(); // 主题切换器（按钮按 common.js 的 THEMES 注册表生成）
  defaultOrder = currentOrder(); // HTML 里的原始顺序，供「默认排序」还原
  applyOrder(readSavedOrder() || {});
  updateResetBtn();
  // 支持 #logs 直接进日志页；否则停在默认标签并与 HTML 的 hidden 状态对齐
  const hashPane = String(location.hash || '').replace('#', '');
  switchPane(PANES[hashPane] ? hashPane : state.pane);
  if (opens.balancePanel) loadBalances(); // 上次是收起状态就别白查，等展开时再拉
  await refreshAll();
  await loadLogs();
  connectStream();
})();
