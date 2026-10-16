'use strict';

// 看板页与接入配置页共用的基础工具。必须先于 app.js / setup.js 加载。

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function localTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

/* ---------------------------------------------------------------- 主题切换
   主题 = public/themes/<id>.css 一个变量文件，切换只换 <link id="themeCss">。
   加主题：往 public/themes/ 丢一个同结构的 css，并在下面 THEMES 注册；
   icon 会同时用在切换按钮、顶栏品牌图标和浏览器标签标题上。 */

const THEMES = [
  { id: 'sakura', icon: '🌸', name: '初樱' },
  { id: 'rain', icon: '🌧', name: '雨夜' },
];
const THEME_KEY = 'workcheck.theme';

function currentThemeId() {
  try {
    return localStorage.getItem(THEME_KEY) || THEMES[0].id;
  } catch (_) {
    return THEMES[0].id;
  }
}

/** 品牌图标跟着主题换：顶栏的 🌸/🌧 和浏览器标签页标题都受影响。
    body[data-title] 存不带图标的原始标题，避免每次切换都一点点被吃掉。 */
function renderBrand(theme) {
  const el = document.getElementById('brandIcon');
  if (el) el.textContent = theme.icon;
  const base = document.body && document.body.dataset ? document.body.dataset.title : '';
  if (base) document.title = `${theme.icon} ${base}`;
}

/** 首屏防闪：common.js 之外的内联脚本在 DOM 就绪后先套一次图标 */
function syncBrandIcon() {
  renderBrand(THEMES.find((t) => t.id === currentThemeId()) || THEMES[0]);
}

function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  const link = document.getElementById('themeCss');
  if (link) {
    if (theme.id === THEMES[0].id) link.removeAttribute('href'); // 默认主题走 style.css 兜底值
    else link.setAttribute('href', `/themes/${theme.id}.css`);
  }
  try {
    localStorage.setItem(THEME_KEY, theme.id);
  } catch (_) {
    /* 隐私模式下写不了，忽略 */
  }
  renderBrand(theme);
  document.querySelectorAll('#themeSwitch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === theme.id);
  });
}

function initThemeSwitcher() {
  const box = document.getElementById('themeSwitch');
  if (!box) return;
  box.innerHTML = THEMES.map(
    (t) => `<button type="button" data-theme="${t.id}">${t.icon} ${t.name}</button>`
  ).join('');
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-theme]');
    if (btn) applyTheme(btn.dataset.theme);
  });
  applyTheme(currentThemeId());
}
