'use strict';

const net = require('net');

// ============================================================
// 路由规则引擎：按顺序匹配，首条命中生效。每个规则返回影响行为的路由配置。
//
// 规则字段：
//   name   - 规则名称（日志用）
//   match  - (hostname) => boolean
//   config - { family: 4|6|'auto', poolable: bool, keepAlive: ms }
//
// 新增自定义规则：router.addRule({ name, match, config })，插到最前优先匹配。
// ============================================================

const isPrivateIPv4 = (h) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || a === 0 || a === 100 && b >= 64 && b <= 127;
};

const DEFAULT_RULES = [
  {
    name: 'opencode-ipv6',
    match: (h) => h === 'opencode.ai' || h.endsWith('.opencode.ai'),
    config: { family: 6, poolable: true },
  },
  {
    name: 'private-ipv4',
    match: (h) => isPrivateIPv4(h),
    config: { family: 4, poolable: true },
  },
  {
    name: 'ipv6-direct',
    match: (h) => net.isIPv6(h),
    config: { family: 6, poolable: true },
  },
  {
    name: 'default',
    match: () => true,
    config: { family: 'auto', poolable: true },
  },
];

class Router {
  constructor(rules = DEFAULT_RULES) {
    this.rules = rules.slice();
  }

  // 首条匹配即返回配置（含规则名）
  route(hostname) {
    for (const rule of this.rules) {
      try {
        if (rule.match(hostname)) {
          return { name: rule.name, ...rule.config };
        }
      } catch (_) {
        // 单条规则异常不影响整体
      }
    }
    return { name: 'default', family: 'auto', poolable: true };
  }

  addRule(rule, { priority = 0 } = {}) {
    if (priority > 0) this.rules.unshift(rule);
    else this.rules.push(rule);
    return this;
  }
}

module.exports = { Router, DEFAULT_RULES, isPrivateIPv4 };