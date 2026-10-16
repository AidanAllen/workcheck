'use strict';

/**
 * 版本号的唯一出处。
 *
 * 部署后最常见的问题就是「我现在跑的到底是哪个版本」—— 尤其用 docker 从远端
 * 仓库构建时，本地没有任何线索。把 package.json 的 version 读出来，
 * 挂在 /api/health 上，curl 一下就有答案。
 *
 * 只读 3 个字段、启动时读一次：这个文件在容器里不会变，没必要每次现读。
 */

const path = require('path');

let pkg = {};
try {
  // server/ 的上一级就是项目根，package.json 在那里
  pkg = require(path.join(__dirname, '..', 'package.json'));
} catch (_) {
  // 读不到不算致命，服务照常跑，只是版本显示不出来
  pkg = {};
}

module.exports = {
  name: pkg.name || 'workcheck',
  version: pkg.version || '0.0.0',
};
