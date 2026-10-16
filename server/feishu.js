'use strict';

/**
 * 飞书用户身份授权（OAuth）路由。
 *
 * 用途：机器人不在群里时，用「用户本人」的身份读取群消息。
 * 用户在群里、能看到的历史消息，用 user_access_token 就能读到。
 *
 * 流程：GET /feishu/auth → 飞书授权页 → 回调 /feishu/callback → 存 token → 拉群消息
 * 回调地址可用 localhost，重定向发生在浏览器端，不需要公网域名。
 *
 * 令牌的读写与续期统一由 server/feishu_token.js 负责（定时脚本也要复用）。
 */

const crypto = require('crypto');
const express = require('express');
const { readCookie } = require('./util');
const {
  hasCred,
  CRED_HINT,
  getAppId,
  getRedirect,
  getScope,
  getChatId,
  writeToken,
  exchangeCode,
  getValidToken,
} = require('./feishu_token');

const router = express.Router();

/** 回调页是手拼的 HTML，里面的文案有一部分来自 URL 查询串（飞书会把错误原因写在
    error_description 上），不转义的话一个构造好的链接就是一次反射型 XSS */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** OAuth 的 state：发起授权时随机生成一枚存进短期列表 + Cookie，回调逐个比对。
    写死 'workcheck' 等于没有 —— 别人拿自己的授权码拼一个回调 URL 诱骗受害者点开，
    服务端就会把受害者的会话绑到攻击者的数据上（CSRF）。 */
const STATE_COOKIE = 'feishu_state';
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map();

function issueState() {
  const now = Date.now();
  for (const [k, exp] of pendingStates) if (exp < now) pendingStates.delete(k);
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, now + STATE_TTL_MS);
  return state;
}

/**
 * 回调地址自检：把用户在开放平台实际填的地址拿回来逐项比对。
 * 错误码 20029 绝大多数是"看起来一样、其实差一两个字符"，肉眼很难发现。
 */
function parseURI(u) {
  try {
    const x = new URL(u);
    return {
      ok: true,
      scheme: x.protocol.replace(':', ''),
      host: x.hostname,
      port: x.port || (x.protocol === 'https:' ? '443' : '80'),
      path: x.pathname,
    };
  } catch (_) {
    return { ok: false };
  }
}

router.get('/feishu/auth', (req, res) => {
  if (!hasCred()) {
    return res.status(500).send(page('未配置飞书凭证', `${escapeHtml(CRED_HINT)}<br>配置好之后再来点一次。`, false));
  }
  const state = issueState();
  const params = new URLSearchParams({
    client_id: getAppId(),
    response_type: 'code',
    redirect_uri: getRedirect(),
    scope: getScope(),
    state,
  });
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=${encodeURIComponent(state)}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax`);
  res.redirect(`https://accounts.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`);
});

router.get('/feishu/callback', async (req, res) => {
  const code = req.query.code;
  const err = req.query.error || req.query.error_description;

  const page = (title, body, ok) => `
    <meta charset="utf-8">
    <div style="font-family:-apple-system,'PingFang SC',sans-serif;max-width:560px;margin:80px auto;padding:32px;
         border:1px solid ${ok ? '#e6e4df' : '#f0c8c8'};border-radius:12px;line-height:1.8;color:#26251f">
      <h2 style="margin:0 0 12px;font-size:17px">${escapeHtml(title)}</h2>
      <div style="font-size:14px;color:#555">${body}</div>
    </div>`;

  // state 校验放在最前面：不匹配的回调连 code 都不必去换，
  // 顺手把用过的一次性值丢掉，避免同一枚 state 被反复使用
  const gotState = String(req.query.state || '');
  const wantState = readCookie(req, STATE_COOKIE);
  if (!gotState || !wantState || gotState !== wantState || !pendingStates.has(gotState)) {
    return res
      .status(400)
      .send(page('授权请求无法确认', '回调里的 state 与本次授权发起时不匹配。<br>请回到「接入配置」页重新点一次「飞书授权」，不要直接刷新这个地址。', false));
  }
  pendingStates.delete(gotState);

  if (err) {
    return res.status(400).send(page('授权未完成', `飞书返回：${escapeHtml(String(err))}<br>请回到终端重新获取授权链接重试。`, false));
  }
  if (!code) {
    return res.status(400).send(page('缺少授权码', '回调地址没有带上 code，检查开放平台的重定向 URL 是否与回调地址完全一致。', false));
  }

  try {
    const t = await exchangeCode(code);
    writeToken(t);
    return res.send(
      page(
        '授权成功',
        `已拿到用户身份令牌，过期会自动续期。<br>
         token 保存在数据目录下的 feishu_token.json。<br><br>
         接下来数据由服务进程直接入库：到「接入配置 → 平台凭证」页点「立即拉取」，
         或等下一个定时周期（默认每 2 小时）自动跑。`,
        true
      )
    );
  } catch (e) {
    return res.status(500).send(page('换取令牌失败', escapeHtml(String(e.message)), false));
  }
});

router.get('/api/feishu/check-redirect', (req, res) => {
  const input = String(req.query.uri || '').trim();
  const want = parseURI(getRedirect());
  const got = parseURI(input);
  const diffs = [];

  if (!input) {
    diffs.push('还没有填入地址');
  } else if (!/^https?:\/\//i.test(input)) {
    diffs.push('缺少 http:// 前缀 —— 必须以 http:// 开头，不能只写 localhost:3000/…');
  } else if (!got.ok) {
    diffs.push('地址无法解析，必须以 http:// 或 https:// 开头，且不能含空格');
  } else {
    if (got.scheme !== want.scheme) {
      diffs.push(`协议不同：需要 ${want.scheme}://，你填的是 ${got.scheme}://`);
    }
    if (got.host !== want.host) {
      const tip = got.host === '127.0.0.1' || want.host === '127.0.0.1'
        ? '（127.0.0.1 和 localhost 在飞书白名单里算两个不同地址，必须字面一致）'
        : '';
      diffs.push(`主机不同：需要 ${want.host}，你填的是 ${got.host}${tip}`);
    }
    if (got.port !== want.port) {
      diffs.push(`端口不同：需要 ${want.port}，你填的是 ${got.port}`);
    }
    if (got.path !== want.path) {
      diffs.push(`路径不同：需要 ${want.path}，你填的是 ${got.path}`);
      if (got.path.endsWith('/') && !want.path.endsWith('/')) {
        diffs.push('末尾多了一个斜杠 /，删掉它');
      } else if (got.path.length < want.path.length && want.path.startsWith(got.path)) {
        diffs.push('路径截断了，后面的 /feishu/callback 没填全');
      }
    }
  }

  res.json({ expected: getRedirect(), input, match: diffs.length === 0, diffs });
});

router.get('/api/feishu/status', async (req, res) => {
  const t = await getValidToken();
  res.json({
    configured: hasCred(),
    authorized: !!t,
    redirectUri: getRedirect(),
    scope: getScope(),
    chatId: getChatId(),
    authUrl: '/feishu/auth',
    expiresAt: t ? new Date(t.expiresAt).toLocaleString('zh-CN') : null,
  });
});

module.exports = { router };
