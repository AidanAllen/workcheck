'use strict';

/**
 * 解析规则单测入口。
 *
 * 解析逻辑本身在 server/checkin.js（服务端接口与拉取逻辑共用同一份），
 * 这个脚本只是把它从命令行跑起来。
 *
 * 用法：node scripts/selftest.js
 *
 * 说明：早期还有一个 scripts/parse_checkin.js 用来「独立拉飞书并 HTTP 推送」，
 * 那条链路已经去掉了 —— 数据现在由服务进程直接拉取入库（server/checkin_pull.js），
 * 不再经过任何 API Key，也就不需要一个能脱离服务运行的外部脚本。
 */

const { runSelftest } = require('../server/checkin');

console.log('解析规则单测：');
process.exit(runSelftest());
