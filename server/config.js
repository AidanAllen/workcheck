'use strict';

/**
 * 平台凭证的唯一出处：data/config.json 一个文件。
 *
 * 之前凭证散在四处 —— 旧版 data/capsolver.json、ttshitu.json、feishu_app.json 三个文件，
 * 加上环境变量覆盖，再加上一层数据库存储 —— 同一份配置四个来源，改了到底生不生效全靠猜。
 * 现在收敛成一个文件：
 *   - 页面上改 → 直接写这个文件 → 立刻生效（每次用到都重新读，不做模块级缓存）；
 *   - 不再有环境变量覆盖：容器里挂载这个文件即可，避免「页面改了但被环境变量顶掉」；
 *   - 部署参数（端口、数据目录、定时周期）仍然走环境变量，那是进程级的、不属于业务凭证。
 *
 * 升级兼容：首次启动时若 config.json 不存在、但存在旧版三个文件，会把旧值迁进来，
 * 旧文件改名成 *.migrated.json 留档（不删，万一迁错了还能救回来）。
 *
 * 用量快照（*_usage.json）不在这里 —— 那是采样出来的派生数据，随时可重建，
 * 混进配置文件会让文件每天变大、也让「配置」和「数据」两个概念搅在一起。
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./data_dir');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/**
 * 飞书的三项兜底值。
 *
 * 注意：**群 ID 不给默认值**。它是你的实际群标识，写进源码就等于跟着仓库公开出去
 * （公开仓库里任何人拿到都能顺着 open_id 猜你的群配置）。留空时拉取会明确报
 * 「未配置飞书群 ID」，去页面上填一次即可 —— 那份配置存在 data/config.json，不进版本库。
 * 回调地址和 scope 是通用值，不涉及具体账号，可以给默认。
 */
const DEFAULT_CHAT_ID = '';
const DEFAULT_REDIRECT = 'http://localhost:3000/feishu/callback';
const DEFAULT_SCOPE = 'im:message im:chat:readonly';

const DEFAULTS = {
  capsolver: { apiKey: '', lowThreshold: 0.5, unitPricePer1k: 0.8 },
  ttshitu: { username: '', password: '' },
  feishu: { appId: '', appSecret: '', chatId: '', redirectUri: '', scope: '' },
};

const GROUPS = Object.keys(DEFAULTS);
const SECRETS = { capsolver: ['apiKey'], ttshitu: ['password'], feishu: ['appSecret'] };
const REQUIRED = { capsolver: ['apiKey'], ttshitu: ['username', 'password'], feishu: ['appId', 'appSecret'] };
const NUMBERS = { capsolver: ['lowThreshold', 'unitPricePer1k'] };
const FALLBACK = {
  feishu: { chatId: DEFAULT_CHAT_ID, redirectUri: DEFAULT_REDIRECT, scope: DEFAULT_SCOPE },
};
/** 旧版文件名 → 迁移时的字段映射 */
const LEGACY = {
  capsolver: { file: 'capsolver.json', map: (j) => ({ apiKey: j.apiKey, lowThreshold: j.lowThreshold, unitPricePer1k: j.unitPricePer1k }) },
  ttshitu: { file: 'ttshitu.json', map: (j) => ({ username: j.username, password: j.password }) },
  feishu: { file: 'feishu_app.json', map: (j) => ({ appId: j.appId, appSecret: j.appSecret }) },
};

const LABELS = { capsolver: 'CapSolver', ttshitu: 'TT识图', feishu: '飞书' };

const numOr = (v, d) => {
  const n = Number(v);
  return v === '' || v === null || v === undefined || !Number.isFinite(n) ? d : n;
};

/** 掩码只用于展示：前 4 后 2，中间统一打星，长度不泄露 */
function maskValue(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 7) return `${s.slice(0, 1)}${'*'.repeat(Math.max(3, s.length - 1))}`;
  return `${s.slice(0, 4)}${'*'.repeat(8)}${s.slice(-2)}`;
}

function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (j && typeof j === 'object') return j;
  } catch (_) {
    /* 文件不存在或格式损坏 → 走下面的迁移 / 默认值 */
  }
  return migrate();
}

/**
 * 旧版三个凭证文件 → config.json。
 * 只在 config.json 还没生成时执行一次，之后这个文件的写入就是唯一来源。
 */
function migrate() {
  const out = {};
  let moved = false;

  for (const name of GROUPS) {
    const next = { ...DEFAULTS[name] };
    const legacy = LEGACY[name];
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, legacy.file), 'utf8');
      const mapped = legacy.map(JSON.parse(raw)) || {};
      for (const [k, v] of Object.entries(mapped)) {
        if (v !== undefined && v !== null && v !== '') next[k] = v;
      }
      // 旧文件改名留档，避免以后有人改了它却以为生效
      fs.renameSync(path.join(DATA_DIR, legacy.file), path.join(DATA_DIR, `${legacy.file}.migrated`));
      moved = true;
    } catch (_) {
      /* 没有旧文件很正常，用默认值 */
    }
    out[name] = next;
  }

  writeAll(out);
  if (moved) console.log(`  已把旧版凭证文件合并进 ${CONFIG_FILE}（原文件改名 *.migrated 留档）`);
  return out;
}

/** 原子写：先写临时文件再改名，避免写一半进程被杀导致配置文件损坏 */
function writeAll(obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  try {
    fs.chmodSync(CONFIG_FILE, 0o600); // 里面是各家平台的凭证，别让同机其他用户可读
  } catch (_) {
    /* Windows 没有 chmod，忽略 */
  }
}

/** 一组配置的当前值（补齐默认值） */
function group(name) {
  if (!DEFAULTS[name]) return null;
  const all = readAll();
  const stored = (all && all[name]) || {};
  const values = { ...DEFAULTS[name] };
  for (const k of Object.keys(DEFAULTS[name])) {
    if (stored[k] !== undefined && stored[k] !== null) values[k] = stored[k];
  }
  for (const k of NUMBERS[name] || []) values[k] = numOr(values[k], DEFAULTS[name][k]);
  return values;
}

/**
 * 取一组凭证。缺的字段用 FALLBACK 兜底（飞书的群 ID / 回调地址 / scope 有历史默认值）。
 * @returns {{configured:boolean, values:object}}
 */
function get(name) {
  const v = group(name);
  if (!v) return { configured: false, values: {} };
  const fb = FALLBACK[name] || {};
  const values = {};
  for (const k of Object.keys(v)) {
    const cur = v[k] === '' || v[k] === null || v[k] === undefined ? fb[k] : v[k];
    values[k] = cur === undefined ? '' : cur;
  }
  const configured = (REQUIRED[name] || []).every((k) => String(values[k] || '').trim() !== '');
  return { configured, values };
}

/** 给页面看的视图：密钥一律换成掩码，明文不出这个文件以外的任何响应 */
function view(name) {
  const g = get(name);
  if (!g) return null;
  const values = {};
  for (const k of Object.keys(g.values)) {
    values[k] = (SECRETS[name] || []).includes(k) ? maskValue(g.values[k]) : g.values[k];
  }
  return {
    name,
    label: LABELS[name] || name,
    configured: g.configured,
    secrets: SECRETS[name] || [],
    required: REQUIRED[name] || [],
    // 有兜底值的字段把兜底值给页面当 placeholder，避免用户以为留空就没生效
    placeholders: { ...(FALLBACK[name] || {}) },
    values,
  };
}

/**
 * 写入一组配置。
 * 密钥字段传空串表示「不改」—— 页面上往往只改账号不换密码，
 * 让用户把掩码原样提交回来覆盖掉真值就得不偿失了。
 */
function save(name, patch) {
  if (!DEFAULTS[name]) return { ok: false, error: `未知的配置组：${name}` };
  const all = readAll();
  const stored = (all && all[name]) || {};
  const next = { ...stored };
  const src = patch && typeof patch === 'object' ? patch : {};

  for (const k of Object.keys(DEFAULTS[name])) {
    if (!(k in src)) continue;
    const v = src[k];
    if ((SECRETS[name] || []).includes(k) && (v === '' || v === null || v === undefined)) {
      if (stored[k] !== undefined) next[k] = stored[k];
      continue;
    }
    next[k] = (NUMBERS[name] || []).includes(k) ? numOr(v, DEFAULTS[name][k]) : String(v ?? '').trim();
  }

  writeAll({ ...all, [name]: next });
  return { ok: true, ...view(name) };
}

/** 把一组恢复成默认值（页面上的「清除」按钮） */
function reset(name) {
  if (!DEFAULTS[name]) return { ok: false, error: `未知的配置组：${name}` };
  const all = readAll();
  writeAll({ ...all, [name]: { ...DEFAULTS[name] } });
  return { ok: true, ...view(name) };
}

module.exports = {
  CONFIG_FILE,
  GROUPS,
  DEFAULT_CHAT_ID,
  DEFAULT_REDIRECT,
  DEFAULT_SCOPE,
  get,
  view,
  save,
  reset,
  maskValue,
};
