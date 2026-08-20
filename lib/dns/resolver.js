/**
 * ⚠️ DISCLAIMER: This tool is for educational purposes only.
 * Using it to bypass service restrictions may violate ToS.
 * Use at your own risk. The author assumes no liability.
 */
'use strict';

const net = require('net');
const dns = require('dns');
const { promisify } = require('util');

const { DnsClient, TYPE_A, TYPE_AAAA } = require('./dns-client');
const { DnsCache } = require('./cache');
const { ProxyError, REPLY } = require('../errors');

const lookupAsync = promisify(dns.lookup);

// ============================================================
// 解析器：
//   1) 命中缓存直接返回（过期则在陈旧窗口内返回旧值 + 后台刷新）；
//   2) 未命中 -> 阿里公共 DNS 查 A/AAAA；
//   3) 全部失败 -> 回退系统解析器；
//   4) 同一 key 并发查询去重（防击穿，降低负载）。
// 返回 [{ address, family, ttl }]。
// ============================================================

const IP_REGEX = /^[\d.]+$/;

class Resolver {
  constructor(dnsConfig, logger) {
    this.client = new DnsClient(dnsConfig, logger);
    this.cache = new DnsCache(dnsConfig.cache);
    this.systemFallback = dnsConfig.systemFallback !== false;
    this.logger = logger;
    this.inflight = new Map();
    this.stats = {
      alidns: 0, fallback: 0, cacheHits: 0, staleHits: 0, negative: 0, deduped: 0,
    };
  }

  _key(hostname, family) {
    return `${hostname}#${family}`;
  }

  // 提取给定类型的结果并做 CNAME 追踪
  _extract(parsed, qname, type) {
    const fam = type === TYPE_A ? 4 : 6;
    const isIP = (v) => fam === 4 ? IP_REGEX.test(v) : /:/.test(v);

    let list = parsed.answers.filter((a) => a.type === type && isIP(a.value));
    if (list.length) {
      return list.map((a) => ({ address: a.value, family: fam, ttl: a.ttl }));
    }
    // CNAME 链追踪
    const cnameMap = new Map();
    for (const a of parsed.answers) {
      if (a.type === 5) cnameMap.set(a.name.toLowerCase(), a.value);
    }
    let name = qname.toLowerCase();
    const seen = new Set();
    while (cnameMap.has(name)) {
      if (seen.has(name)) break;
      seen.add(name);
      name = cnameMap.get(name).toLowerCase();
      list = parsed.answers.filter((a) => a.type === type && a.name.toLowerCase() === name && isIP(a.value));
      if (list.length) {
        return list.map((a) => ({ address: a.value, family: fam, ttl: a.ttl }));
      }
    }
    return [];
  }

  async _queryAlidns(hostname, family) {
    const wanted = [];
    if (family === 4) wanted.push([TYPE_A, 'A']);
    else if (family === 6) wanted.push([TYPE_AAAA, 'AAAA']);
    else wanted.push([TYPE_AAAA, 'AAAA'], [TYPE_A, 'A']);

    const results = await Promise.all(
      wanted.map(async ([type, label]) => {
        const parsed = await this.client.query(hostname, type);
        const entries = this._extract(parsed, hostname, type);
        if (this.logger) this.logger.debug(`Alidns ${hostname} ${label} -> ${entries.length} 条`);
        return entries;
      })
    );

    const flat = [];
    for (const r of results) for (const e of r) flat.push(e);

    // 对每条 address 去重（AAAA 与 A 可能解析出重复）
    const seen = new Set();
    const unique = [];
    for (const e of flat) {
      const k = `${e.family}:${e.address}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(e);
    }
    return unique;
  }

  async _querySystem(hostname, family) {
    const results = await lookupAsync(hostname, {
      family: typeof family === 'number' ? family : undefined,
      hints: dns.ADDRCONFIG,
      all: false,
    });
    const fam = results.family || (net.isIPv6(results.address) ? 6 : 4);
    return [{ address: results.address, family: fam, ttl: 60 }];
  }

  _cacheKey(hostname, family) {
    return this._key(hostname, family === 'auto' ? 'auto' : family);
  }

  // 主入口：hostname 已是 IP 时直接短路，不走 DNS。
  async resolve(hostname, family = 'auto') {
    const ipFamily = net.isIP(hostname);
    if (ipFamily) {
      return [{ address: hostname, family: ipFamily, ttl: Infinity }];
    }

    const key = this._cacheKey(hostname, family);

    // 1) 缓存
    const hit = this.cache.get(key);
    if (hit) {
      if (hit.entries.length === 0) {
        this.stats.negative++;
        throw new ProxyError(`域名无可用解析结果: ${hostname}`, REPLY.HOST_UNREACHABLE);
      }
      if (hit.stale) this.stats.staleHits++;
      else this.stats.cacheHits++;
      if (hit.stale) this._refreshInBackground(key, hostname, family);
      return hit.entries;
    }

    // 2) 并发去重
    const inflightKey = `${key}:query`;
    if (this.inflight.has(inflightKey)) {
      this.stats.deduped++;
      try {
        return await this.inflight.get(inflightKey);
      } catch (e) {
        throw e;
      }
    }

    const p = this._doQuery(hostname, family, key);
    this.inflight.set(inflightKey, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(inflightKey);
    }
  }

  async _doQuery(hostname, family, key) {
    // 2) 优先 Alidns
    try {
      const entries = await this._queryAlidns(hostname, family);
      this.stats.alidns++;
      this.cache.set(key, entries, { ttl: this._effectiveTtl(entries) });
      if (entries.length === 0) {
        this.stats.negative++;
        throw new ProxyError(`域名无可用解析结果: ${hostname}`, REPLY.HOST_UNREACHABLE);
      }
      return entries;
    } catch (e) {
      // 3) 陈旧缓存兜底（即便已完全过期）
      const stale = this.cache.store.get(key);
      if (stale && stale.entries.length) {
        this.stats.staleHits++;
        return stale.entries;
      }
      // 4) 系统解析器兜底
      if (this.systemFallback) {
        try {
          const entries = await this._querySystem(hostname, family);
          this.stats.fallback++;
          this.cache.set(key, entries, { ttl: 60 });
          return entries;
        } catch (e2) {
          if (this.logger) this.logger.warn(`系统解析失败 ${hostname}: ${e2.message}`);
        }
      }
      throw e;
    }
  }

  _effectiveTtl(entries) {
    let t = Infinity;
    for (const e of entries) t = Math.min(t, e.ttl);
    if (!Number.isFinite(t) || t <= 0) t = 60;
    return t;
  }

  _refreshInBackground(key, hostname, family) {
    // 后台静默刷新，不阻塞当前请求。
    // 直接走 _doQuery（绕过缓存读），并用 inflight 去重，避免陈旧命中导致的
    // 无限刷新循环。
    const inflightKey = `${key}:query`;
    if (this.inflight.has(inflightKey)) return;
    const p = this._doQuery(hostname, family, key).catch(() => {});
    this.inflight.set(inflightKey, p);
    p.finally(() => this.inflight.delete(inflightKey));
  }

  stop() {
    this.cache.stop();
  }
}

module.exports = { Resolver };
