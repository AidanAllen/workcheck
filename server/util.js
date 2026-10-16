'use strict';

/**
 * 服务端共用的小工具。
 * 项目没有引 cookie-parser，只读自己发的那一个 cookie，手写比多一个依赖划算。
 */

/** 从请求头里取指定 cookie；没有或格式怪都返回空串 */
function readCookie(req, name) {
  const raw = req.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

module.exports = { readCookie };
