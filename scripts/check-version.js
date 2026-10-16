#!/usr/bin/env node
'use strict';

/**
 * 版本号一致性检查。
 *
 * 用途：发版前 / CI 里跑一下，确认「四处版本号」没有互相脱节。
 * 本项目自己的版本号散在三个文件、四个位置：
 *
 *   package.json                          version
 *   package-lock.json                     version（顶层）
 *   package-lock.json                     packages[""].version
 *   docker-compose.yaml                   build.context 的 #vX.Y.Z 与 image 的 :vX.Y.Z
 *
 * 漏一处的后果都不轻 —— 尤其是漏了 compose 的 context，用户下到的编排文件
 * 还指着旧版本，部署出来就是旧代码。
 *
 * 用法：
 *   node scripts/check-version.js            检查一致性
 *   node scripts/check-version.js 1.0.1      额外断言等于 1.0.1（发版时用）
 *
 * 退出码 0 = 一致，1 = 不一致（并打印差异）。
 *
 * 注意：package-lock.json 里**依赖包自己的** version 不在检查范围内 ——
 * 它们和本项目版本无关（file-uri-to-path@1.0.0、unpipe@1.0.0 之类），
 * 直接 grep 版本号会误报。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

/** 从 compose 里取「本项目自己的」版本号：context 的 ref 与 image 的 tag */
function composeVersions() {
  const text = fs.readFileSync(path.join(ROOT, 'docker-compose.yaml'), 'utf8');
  const out = {};

  const ctx = text.match(/^\s*context:.*#(v?[\w.\-]+)\s*$/m);
  if (ctx) out['docker-compose.yaml: build.context'] = ctx[1].replace(/^v/, '');

  const img = text.match(/^\s*image:\s*(\S+):(v?[\w.\-]+)\s*$/m);
  if (img) out['docker-compose.yaml: image'] = img[2].replace(/^v/, '');

  return out;
}

function collect() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');

  const found = {
    'package.json: version': pkg.version,
    'package-lock.json: version': lock.version,
  };
  if (lock.packages && lock.packages['']) {
    found['package-lock.json: packages[""].version'] = lock.packages[''].version;
  }
  return Object.assign(found, composeVersions());
}

const found = collect();
const expected = process.argv[2] ? String(process.argv[2]).replace(/^v/, '') : null;

const entries = Object.entries(found);
const values = [...new Set(entries.map(([, v]) => v))];

let bad = false;

// 1) 四处必须彼此一致
if (values.length !== 1) {
  console.log('✗ 版本号不一致：');
  entries.forEach(([where, v]) => console.log(`    ${v.padEnd(12)} ${where}`));
  bad = true;
} else {
  console.log(`✓ 四处版本号一致：${values[0]}`);
}

// 2) 若指定了期望版本，必须等于它
if (expected && values.length === 1 && values[0] !== expected) {
  console.log(`✗ 期望 ${expected}，实际 ${values[0]}`);
  bad = true;
}

// 3) 位置齐全性：缺哪个说明文件被改坏了
const need = [
  'package.json: version',
  'package-lock.json: version',
  'package-lock.json: packages[""].version',
  'docker-compose.yaml: build.context',
  'docker-compose.yaml: image',
];
const missing = need.filter((k) => !(k in found));
if (missing.length) {
  console.log('✗ 这些位置没找到版本号（文件结构变了？）：');
  missing.forEach((m) => console.log(`    ${m}`));
  bad = true;
}

// 4) 预发布版本不该出现在 compose 的 image 上跑生产 —— 只提示，不算失败
if (values.length === 1 && /-/.test(values[0])) {
  console.log(`  提示：当前是预发布版本 ${values[0]}，compose 里 image 也会带这个后缀`);
}

process.exit(bad ? 1 : 0);
