'use strict';

/**
 * 飞书令牌管理（纯模块，不依赖 express）。
 *
 * 令牌的读取 / 刷新 / 续期集中在这里，拉取逻辑（server/checkin_pull.js）与 OAuth 路由
 * （server/feishu.js）共用同一份 —— 改一处两边同时生效。
 * 应用凭证本身由 server/config.js 提供（data/config.json）。
 *
 * 应用凭证不再在模块加载时读一次就固定死：以前模块顶层把 App ID 读成常量，
 * 导致在页面上改完必须重启进程才生效。现在每次用到都重新读一遍（见 config.js）。
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./data_dir');
// 凭证与默认值都在 config.js（data/config.json）里 —— 唯一出处
const config = require('./config');

const TOKEN_FILE = path.join(DATA_DIR, 'feishu_token.json');

/** 当前生效的飞书配置。每次调用都重新读文件，页面上改完立刻生效，不用重启 */
function cred() {
  const { values } = config.get('feishu');
  return {
    appId: values.appId || '',
    appSecret: values.appSecret || '',
    chatId: values.chatId || '',
    redirectUri: values.redirectUri || '',
    scope: values.scope || '',
  };
}

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeToken(t) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), 'utf8');
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function pack(raw) {
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresIn: raw.expires_in,
    obtainedAt: Date.now(),
    expiresAt: Date.now() + Number(raw.expires_in || 7200) * 1000,
    scope: raw.scope || '',
  };
}

// 别等到飞书返回一串看不懂的报错才发现凭证是空的
const CRED_HINT = '未配置飞书应用凭证：到「接入配置 → 配置信息 → 飞书应用凭证」页填写 App ID / App Secret';

const hasCred = () => {
  const c = cred();
  return !!(c.appId && c.appSecret);
};

/** 授权码换令牌，v1 失败自动试 v2 */
async function exchangeCode(code) {
  if (!hasCred()) throw new Error(CRED_HINT);
  const { appId, appSecret, redirectUri } = cred();
  const v1 = await postJSON('https://open.feishu.cn/open-apis/authen/v1/access_token', {
    grant_type: 'authorization_code',
    code,
    app_id: appId,
    app_secret: appSecret,
  });
  if (v1 && v1.code === 0 && v1.data && v1.data.access_token) return pack(v1.data);

  const v2 = await postJSON('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
    grant_type: 'authorization_code',
    client_id: appId,
    client_secret: appSecret,
    code,
    redirect_uri: redirectUri,
  });
  if (v2 && v2.code === 0 && v2.access_token) return pack(v2);

  const detail = (v2 && v2.error && v2.error.msg) || (v1 && v1.msg) || '未知错误';
  throw new Error(`换取 user_access_token 失败：${detail}`);
}

/** refresh_token 续期，v1 失败自动试 v2 */
async function refresh(refreshToken) {
  if (!hasCred()) throw new Error(CRED_HINT);
  const { appId, appSecret } = cred();
  const v1 = await postJSON('https://open.feishu.cn/open-apis/authen/v1/refresh_access_token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    app_id: appId,
    app_secret: appSecret,
  });
  if (v1 && v1.code === 0 && v1.data && v1.data.access_token) return pack(v1.data);

  const v2 = await postJSON('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
    grant_type: 'refresh_token',
    client_id: appId,
    client_secret: appSecret,
    refresh_token: refreshToken,
  });
  if (v2 && v2.code === 0 && v2.access_token) return pack(v2);

  throw new Error(`刷新令牌失败：${(v2 && v2.error && v2.error.msg) || (v1 && v1.msg) || '未知错误'}`);
}

/** 取一个当前可用的令牌：没过期直接返回，过期就用 refresh_token 换新并落盘 */
async function getValidToken() {
  const t = readToken();
  if (!t || !t.accessToken) return null;
  if (t.expiresAt && Date.now() < t.expiresAt - 60_000) return t;
  if (!t.refreshToken) return null;
  try {
    const fresh = await refresh(t.refreshToken);
    writeToken(fresh);
    return fresh;
  } catch (_) {
    return null;
  }
}

module.exports = {
  hasCred,
  CRED_HINT,
  cred,
  getAppId: () => cred().appId,
  getRedirect: () => cred().redirectUri || config.DEFAULT_REDIRECT,
  getScope: () => cred().scope || config.DEFAULT_SCOPE,
  getChatId: () => cred().chatId || config.DEFAULT_CHAT_ID,
  writeToken,
  exchangeCode,
  getValidToken,
};
