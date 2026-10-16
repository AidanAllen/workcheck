'use strict';

// 接入配置页：来源与 API Key 管理、推送示例、链路自检、第三方凭证配置、飞书授权入口。
// 通用工具（$ / api / toast / escapeHtml）见 common.js。

// keys 里缓存「已懒加载出来的明文」，只在用户点开某一行时才去取。
// 列表接口本身已经不再下发明文 key，页面上也就没有成把的凭证摆着。
const state = { sources: [], lang: 'curl', keys: {}, authMode: 'setup' };

/**
 * 管理接口的请求入口。和普通 api() 的区别：拿到 401 不是丢一句报错就算了，
 * 而是把页面切回登录/创账号那一屏 —— 会话过期、被踢下线时不会出现
 * 「点了没反应，只剩一行红字」的死界面。
 */
let onUnauthorized = null;
async function adminApi(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    if (onUnauthorized) await onUnauthorized(data.need || 'login');
    throw new Error(data.error || '请先登录');
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

/** @param mode 'setup' 首次创建账号 | 'login' 登录 */
function showGate(mode) {
  state.authMode = mode;
  const first = mode === 'setup';
  $('authGate').hidden = false;
  $('appBody').hidden = true;
  $('authUser').hidden = true;
  $('btnLogout').hidden = true;
  $('authTitle').textContent = first ? '👤 创建管理员' : '🔒 登录';
  $('authDesc').textContent = first
    ? '首次使用，先建一个账号密码，之后进这个页面都要登录。'
    : '请登录后管理推送来源与 API Key。';
  $('authSubmit').textContent = first ? '创建并登录' : '登录';
  $('authTip').textContent = first ? '密码用加盐哈希存库，服务端不保存明文。' : '';
  $('authErr').hidden = true;
  $('authPassInput').value = '';
  setTimeout(() => (first ? $('authUserInput') : $('authPassInput')).focus(), 60);
}

function enterApp(username) {
  $('authGate').hidden = true;
  $('appBody').hidden = false;
  $('authUser').hidden = false;
  $('authUser').textContent = `已登录 ${username}`;
  $('btnLogout').hidden = false;
}

/** 决定这个页面是给人用（进去管理）还是先看一屏登录；@returns {boolean} 是否已登录 */
async function bootAuth() {
  let st = { initialized: true, loggedIn: false };
  try {
    st = await fetch('/api/auth/state').then((r) => r.json());
  } catch (_) {
    /* 服务不可达时按未登录处理 */
  }
  if (st.loggedIn) {
    enterApp(st.username);
    return true;
  }
  showGate(st.initialized ? 'login' : 'setup');
  return false;
}

async function submitAuth(e) {
  e.preventDefault();
  const username = $('authUserInput').value.trim();
  const password = $('authPassInput').value;
  const errBox = $('authErr');
  errBox.hidden = true;
  const url = state.authMode === 'setup' ? '/api/auth/setup' : '/api/auth/login';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || '操作失败');
    enterApp(d.username || username);
    toast(state.authMode === 'setup' ? '管理员已创建' : '登录成功');
    await reloadApp();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (_) {
    /* 已经是退出状态就无所谓了 */
  }
  toast('已退出登录');
  showGate('login');
}

// ---------------------------------------------------------------- 修改密码

function openPwGate() {
  $('pwErr').hidden = true;
  $('pwOld').value = '';
  $('pwNew').value = '';
  $('pwNew2').value = '';
  $('pwGate').hidden = false;
  setTimeout(() => $('pwOld').focus(), 60);
}

function closePwGate() {
  $('pwGate').hidden = true;
}

async function submitPassword(e) {
  e.preventDefault();
  const errBox = $('pwErr');
  errBox.hidden = true;

  const oldPassword = $('pwOld').value;
  const newPassword = $('pwNew').value;
  const again = $('pwNew2').value;

  // 前端先挡一道明显的错，省一次往返；真正的校验以服务端为准
  if (!oldPassword) return showPwErr('请输入当前密码');
  if (newPassword.length < 6) return showPwErr('新密码至少 6 位');
  if (newPassword !== again) return showPwErr('两次输入的新密码不一致');
  if (newPassword === oldPassword) return showPwErr('新密码不能与当前密码相同');

  const btn = $('pwSubmit');
  btn.disabled = true;
  try {
    const r = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || '修改失败');
    closePwGate();
    toast(d.kicked > 0 ? `密码已修改，已退出其它 ${d.kicked} 台设备的登录` : '密码已修改');
  } catch (err) {
    showPwErr(err.message);
  } finally {
    btn.disabled = false;
  }
}

function showPwErr(msg) {
  const errBox = $('pwErr');
  errBox.textContent = msg;
  errBox.hidden = false;
  return false;
}

/**
 * 没登录就离开这一页。
 *
 * 用 back() 还是直接回首页，不能只看 history.length —— 「有上一页」不等于
 * 「上一页是我们自己的页面」：新标签页输地址进来时上一页是空白页（length 已经是 2），
 * 从外部链接点进来时上一页是别人的站，这两种 back() 都会把人送到不该去的地方
 * （空白页看着像卡死）。所以先确认来源是自己站内且不是 setup 本身，再决定。
 *
 * 回首页用 replace 而不是 href：不然「后退」还能退回 setup，又会被遮罩拦住。
 */
function leaveSetup() {
  let prevIsOurs = false;
  try {
    const ref = new URL(document.referrer);
    prevIsOurs = ref.origin === location.origin && ref.pathname !== '/setup.html';
  } catch (_) {
    /* referrer 为空（直接输地址 / 新标签页）或不是合法 URL，按「没有上一页」处理 */
  }
  if (prevIsOurs && history.length > 1) history.back();
  else location.replace('/');
}

// ---------------------------------------------------------------- 标签切换

function switchTab(name) {
  document.querySelectorAll('#setupTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('panePush').hidden = name !== 'push';
  $('paneConfig').hidden = name !== 'config';
}

// ---------------------------------------------------------------- 来源列表

/**
 * 能在「数据推送」页管理的来源。
 *
 * 内置来源（飞书签到挂数据用的那个）**不在这里出现** —— 用户压根没建过它、
 * 也不该管它：它的数据是服务进程从飞书直接拉取入库的，既不推送也不需要 Key。
 * 更要命的是它的「停用」开关会让签到数据停止入库，那是个纯粹的陷阱。
 * 所以列表里索性完全不显示它，而不是显示出来再禁用几个按钮。
 */
function pushableSources() {
  return state.sources.filter((s) => !s.builtin);
}

function renderSourceList() {
  const box = $('sourceList');
  const list = pushableSources();
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有来源，先创建一个</div>';
    return;
  }
  box.innerHTML = list
    .map((s) => {
      const full = state.keys[s.id];
      const keyCell = `<span class="key-box${full ? ' revealed' : ''}" data-act="key" title="点击显示并复制完整 API Key">${
        full ? escapeHtml(full) : escapeHtml(s.api_key_masked || '••••••••')
      }</span>`;
      return `<div class="src-row" data-id="${s.id}">
      <span class="src-name">${escapeHtml(s.name)}</span>
      ${keyCell}
      <span class="tag ${s.enabled ? 'on' : 'off'}">${s.enabled ? '启用' : '停用'}</span>
      <span class="spacer"></span>
      <button class="btn mini" data-act="toggle">${s.enabled ? '停用' : '启用'}</button>
      <button class="btn mini danger" data-act="del">删除</button>
    </div>`;
    })
    .join('');
}

function sampleBody() {
  return `{
  "orderId": "ORD-1001",
  "amount": 268.5,
  "quantity": 2,
  "status": "paid",
  "channel": "微信支付",
  "timestamp": "${new Date().toISOString()}"
}`;
}

function buildSnippet() {
  // 只挑「持有 Key 的普通来源」：内置来源没有 Key，拿它做示例会生成一段注定 401 的代码。
  // 兜底不再退回 sources[0]，宁可显式提示用户先去建一个来源。
  const list = pushableSources();
  const src = list.find((s) => s.enabled && s.hasKey) || list.find((s) => s.hasKey);

  if (!src) {
    return '// 还没有可用于推送的来源。\n// 先在左侧新建一个来源，拿到 API Key 后这里会自动生成对应的请求示例。';
  }

  const host = location.origin;
  // 明文 key 只有点开某一行时才去单独取，示例代码也用这份缓存
  const key = state.keys[src.id] || '<点上方 API Key 显示后自动填入>';
  const body = sampleBody();

  if (state.lang === 'js') {
    return `await fetch('${host}/api/ingest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Api-Key': '${key}' },
  body: JSON.stringify(${body.replace(/\n/g, '\n  ')})
});

// 批量推送：body 直接放数组即可，单次最多 500 条
// body: JSON.stringify([{ ... }, { ... }])`;
  }

  return `curl -X POST ${host}/api/ingest \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: ${key}" \\
  -d '${body}'`;
}

function renderSnippet() {
  $('snippetBox').textContent = buildSnippet();
}

async function refreshSources() {
  state.sources = await adminApi('/api/sources');
  renderSourceList();
  renderSnippet();
}

async function copySnippet() {
  const text = $('snippetBox').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch (_) {
    // 剪贴板不可用时退回选中文本，用户可以手动复制
    const range = document.createRange();
    range.selectNodeContents($('snippetBox'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('已选中，请按 Ctrl+C 复制');
  }
}

async function pushDemo(count) {
  const hint = $('pushResult');
  hint.textContent = '推送中…';
  try {
    const r = await adminApi('/api/demo/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count }),
    });
    hint.textContent = `已推送 ${count} 条，入库 ${r.inserted} 条${r.duplicated ? `，重复 ${r.duplicated} 条` : ''}`;
    toast(`已推送 ${count} 条，入库 ${r.inserted} 条`);
  } catch (err) {
    hint.textContent = '推送失败：' + err.message;
    toast(err.message);
  }
}

// ---------------------------------------------------------------- 飞书与拉取

async function loadFeishuState() {
  const el = $('feishuState');
  try {
    const s = await adminApi('/api/feishu/status');
    if (!s.configured) {
      el.textContent = '未配置应用凭证 · 在下方「飞书应用凭证」里填写';
      el.style.color = 'var(--warn)';
    } else if (s.authorized) {
      const until = s.expiresAt || '未知';
      el.textContent = `已授权 · 令牌有效期至 ${until}`;
      el.style.color = 'var(--ok)';
    } else {
      el.textContent = '未授权 · 点「飞书授权 / 重新授权」';
      el.style.color = 'var(--warn)';
    }
  } catch (_) {
    el.textContent = '状态获取失败';
  }
}

const hhmm = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

async function loadPullState() {
  const el = $('pullState');
  try {
    const s = await adminApi('/api/scheduler');
    const parts = [];
    if (s.enabled) parts.push(`每 ${s.intervalMin} 分钟`);
    else parts.push('定时已关闭');
    if (s.lastFinishAt) {
      const n = s.lastInserted == null ? '—' : `${s.lastInserted} 条`;
      parts.push(s.lastOk ? `上次 ${hhmm(s.lastFinishAt)} 入库 ${n}` : `上次 ${hhmm(s.lastFinishAt)} 失败：${s.lastError}`);
    } else {
      parts.push('还没跑过');
    }
    if (s.nextRunAt) parts.push(`下次 ${hhmm(s.nextRunAt)}`);
    el.textContent = parts.join(' · ');
    el.style.color = s.lastOk === false ? 'var(--fail)' : 'var(--text-3)';
  } catch (_) {
    el.textContent = '调度状态获取失败';
  }
}

async function pullNow() {
  const btn = $('btnPullNow');
  btn.disabled = true;
  $('pullState').textContent = '拉取中…';
  try {
    const r = await adminApi('/api/scheduler/run', { method: 'POST' });
    toast(r.ok ? `拉取完成，入库 ${r.inserted} 条` : `拉取失败：${r.error || '未知原因'}`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    await loadPullState();
  }
}

// ---------------------------------------------------------------- 凭证表单

const GROUP_STATE_ID = { capsolver: 'capState', ttshitu: 'ttState', feishu: 'fsState' };

/** 把接口返回的（掩码）配置填进表单；placeholders 用来提示「留空会用哪个默认值」 */
function fillGroup(name, view) {
  const box = document.querySelector(`[data-group="${name}"]`);
  if (!box) return;
  box.querySelectorAll('[data-field]').forEach((input) => {
    const k = input.dataset.field;
    const isSecret = (view.secrets || []).includes(k);
    const val = view.values ? view.values[k] : '';
    if (isSecret) {
      input.value = ''; // 明文从不回显，留空即表示不修改
      input.placeholder = val ? `已保存（${val}）· 留空不修改` : '未配置';
    } else {
      input.value = val === undefined || val === null ? '' : val;
      if (!input.value && view.placeholders && view.placeholders[k]) input.placeholder = view.placeholders[k];
    }
  });
  const st = $(GROUP_STATE_ID[name]);
  if (st) {
    st.textContent = view.configured ? '已配置' : '未配置';
    st.style.color = view.configured ? 'var(--ok)' : 'var(--warn)';
  }
}

async function loadCredentials() {
  try {
    const { groups } = await adminApi('/api/credentials');
    Object.keys(groups || {}).forEach((name) => fillGroup(name, groups[name]));
  } catch (err) {
    Object.values(GROUP_STATE_ID).forEach((id) => {
      if ($(id)) $(id).textContent = '加载失败';
    });
    throw err;
  }
}

async function saveGroup(name) {
  const box = document.querySelector(`[data-group="${name}"]`);
  if (!box) return;
  const patch = {};
  box.querySelectorAll('[data-field]').forEach((i) => {
    patch[i.dataset.field] = i.value;
  });
  try {
    const view = await adminApi(`/api/credentials/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    fillGroup(name, view);
    toast('已保存，立即生效');
    await loadFeishuState();
  } catch (err) {
    toast(err.message);
  }
}

async function resetGroup(name) {
  const box = document.querySelector(`[data-group="${name}"]`);
  const label = box ? box.querySelector('.panel-title').textContent.trim() : name;
  if (!confirm(`清除「${label}」的全部配置？该平台的余额查询 / 拉取会立刻停用。`)) return;
  try {
    const view = await adminApi(`/api/credentials/${name}`, { method: 'DELETE' });
    fillGroup(name, view);
    toast('已清除');
    await loadFeishuState();
  } catch (err) {
    toast(err.message);
  }
}

/** 回调地址比对：错误码 20029 大多是肉眼难辨的细微差异，逐项比出来 */
async function checkRedirect() {
  const uri = $('redirectInput').value.trim();
  const box = $('checkRedirectResult');
  if (!uri) {
    box.textContent = '先粘贴你在开放平台「安全设置 → 重定向 URL」里填的地址';
    return;
  }
  try {
    const r = await adminApi('/api/feishu/check-redirect?uri=' + encodeURIComponent(uri));
    if (r.match) {
      box.innerHTML = '<span style="color:var(--ok);font-weight:600">完全一致</span>，配置正确，去点「飞书授权」。';
    } else {
      box.innerHTML =
        '<div style="color:var(--fail);font-weight:600">不一致，逐条修正：</div>' +
        r.diffs.map((d) => `<div>· ${escapeHtml(d)}</div>`).join('') +
        `<div style="color:var(--text-3);margin-top:4px">正确值：<code class="field">${escapeHtml(r.expected)}</code></div>`;
    }
  } catch (err) {
    box.textContent = '比对失败：' + err.message;
  }
}

// ---------------------------------------------------------------- 绑定

function bind() {
  // 登录 / 创建账号表单：回车或点按钮都走这里，成功后自动落会话并进管理界面
  $('authForm').addEventListener('submit', submitAuth);
  $('btnLogout').addEventListener('click', logout);

  // 改密码：点右上角「已登录 xxx」打开，点遮罩空白处或 Esc 关闭
  $('authUser').addEventListener('click', openPwGate);
  $('pwForm').addEventListener('submit', submitPassword);
  $('pwCancel').addEventListener('click', closePwGate);
  $('pwGate').addEventListener('click', (e) => {
    if (e.target === $('pwGate')) closePwGate();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('pwGate').hidden) closePwGate();
  });

  // 点卡片以外的空白处 = 离开。判 e.target 是不是遮罩本身，
  // 否则在输入框之间点一下、选中文字都会被误判成「想走」。
  $('authGate').addEventListener('click', (e) => {
    if (e.target !== $('authGate')) return;
    leaveSetup();
  });

  $('setupTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  $('langSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.lang = btn.dataset.lang;
    document.querySelectorAll('#langSwitch button').forEach((b) => b.classList.toggle('active', b === btn));
    renderSnippet();
  });

  $('btnCopy').addEventListener('click', copySnippet);

  $('btnAddSource').addEventListener('click', async () => {
    const input = $('newSourceName');
    const name = input.value.trim();
    if (!name) return toast('请先填写来源名称');
    try {
      const res = await adminApi('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      input.value = '';
      state.keys[res.source.id] = res.apiKey; // 刚创建，明文这一刻是必须给用户的
      await refreshSources();
      toast(`已创建「${name}」，API Key 已生成（点击列表里的 Key 可复制）`);
    } catch (err) {
      toast(err.message);
    }
  });

  $('sourceList').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const row = el.closest('.src-row');
    const id = Number(row && row.dataset.id);

    if (act === 'key') {
      // 列表不带明文，点这一下才去单独取一次
      let key = state.keys[id];
      if (!key) {
        try {
          const r = await adminApi(`/api/sources/${id}/key`);
          key = r.apiKey;
          state.keys[id] = key;
        } catch (err) {
          toast(err.message);
          return;
        }
        renderSourceList();
        renderSnippet(); // 示例代码里的占位符同步换成真 key
      }
      try {
        await navigator.clipboard.writeText(key);
        toast('API Key 已复制到剪贴板');
      } catch (_) {
        toast('已展开 API Key，请手动复制');
      }
      return;
    }

    if (act === 'toggle') {
      const src = state.sources.find((s) => s.id === id);
      await adminApi(`/api/sources/${id}/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !src.enabled }),
      });
      await refreshSources();
    }

    if (act === 'del') {
      const src = state.sources.find((s) => s.id === id);
      if (!confirm(`删除来源「${src.name}」？该来源的历史报文也会一并删除，且不可恢复。`)) return;
      await adminApi(`/api/sources/${id}`, { method: 'DELETE' });
      delete state.keys[id];
      await refreshSources();
      toast('来源已删除');
    }
  });

  $('btnPush1').addEventListener('click', () => pushDemo(1));
  $('btnPush10').addEventListener('click', () => pushDemo(10));

  $('btnCheckRedirect').addEventListener('click', checkRedirect);
  $('redirectInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') checkRedirect();
  });

  $('btnPullNow').addEventListener('click', pullNow);

  // 凭证表单的保存 / 清除：统一委托，省得给六个按钮各绑一次
  document.querySelectorAll('[data-save]').forEach((btn) => {
    btn.addEventListener('click', () => saveGroup(btn.dataset.save));
  });
  document.querySelectorAll('[data-reset]').forEach((btn) => {
    btn.addEventListener('click', () => resetGroup(btn.dataset.reset));
  });
}

async function reloadApp() {
  try {
    await refreshSources();
  } catch (err) {
    $('sourceList').innerHTML = `<div class="empty">加载失败：${escapeHtml(err.message)}</div>`;
  }
  loadFeishuState();
  loadPullState();
  loadCredentials().catch(() => {});
}

(async function init() {
  bind();
  initThemeSwitcher(); // 主题切换器（按钮按 common.js 的 THEMES 注册表生成）
  // 会话过期 / 被踢下线时自动回到登录屏
  onUnauthorized = async (need) => showGate(need === 'setup' ? 'setup' : 'login');
  if (await bootAuth()) await reloadApp();
})();
