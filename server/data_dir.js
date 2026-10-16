'use strict';

/**
 * 数据目录的唯一出处。
 *
 * 之前 db.js / feishu_token.js / ttshitu.js / capsolver.js 各自写着一条
 * path.join(__dirname, '..', 'data')，一旦有人给其中一处加了环境开关，
 * 库文件和凭证文件就会分家 —— 这类隐性分叉排查起来很费时间，所以统一从这里出。
 *
 * 默认项目下的 data/，需要多实例、数据盘外挂或迁移时用 WORKCHECK_DATA_DIR 指定。
 */
const path = require('path');

const DATA_DIR = path.resolve(process.env.WORKCHECK_DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = { DATA_DIR };
