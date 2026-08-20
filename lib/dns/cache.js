'use strict';

// ============================================================
// DNS 解析缓存：
//  - 按 key(hostname#family) 缓存，命中后零成本返回，避免反复向 DNS 发 UDP。
//  - TTL 取 DNS 响应 TTL 与配置 ttl 的较小值，到期后进入"陈旧可用"窗口：
//    期间直接返回旧结果（不增加调用方延迟），并后台静默刷新。
//  - 周期性清理 + 上限保护，防止内存无限增长。
// ============================================================

class DnsCache {
  constructor({ ttl = 300, stale = 60, negativeTtl = 10, maxEntries = 10000, cleanupInterval = 60000 } = {}) {
    this.ttl = ttl;
    this.stale = stale;
    this.negativeTtl = negativeTtl;
    this.maxEntries = maxEntries;
    this.store = new Map();
    this.timer = setInterval(() => this.cleanup(), cleanupInterval);
    if (this.timer.unref) this.timer.unref();
    this.stats = { hits: 0, staleHits: 0, misses: 0, sets: 0, evictions: 0 };
  }

  get(key, now = Date.now()) {
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    if (now < entry.expiresAt) {
      this.stats.hits++;
      return { entries: entry.entries, stale: false };
    }
    if (now < entry.staleUntil) {
      this.stats.staleHits++;
      return { entries: entry.entries, stale: true };
    }
    this.store.delete(key);
    this.stats.misses++;
    return null;
  }

  set(key, entries, { ttl, negative = false } = {}) {
    const now = Date.now();
    const t = negative ? (this.negativeTtl) : Math.min(ttl ?? this.ttl, this.ttl);
    this.store.set(key, {
      entries,
      fetchedAt: now,
      expiresAt: now + t * 1000,
      staleUntil: now + (t + this.stale) * 1000,
    });
    this.stats.sets++;
    if (this.store.size > this.maxEntries) this._evict();
  }

  _evict() {
    // 简单策略：删除最早的 10%
    const keys = [...this.store.keys()].sort((a, b) => {
      const ea = this.store.get(a);
      const eb = this.store.get(b);
      return (ea ? ea.fetchedAt : 0) - (eb ? eb.fetchedAt : 0);
    });
    const drop = Math.ceil(keys.length * 0.1);
    for (let i = 0; i < drop; i++) {
      this.store.delete(keys[i]);
      this.stats.evictions++;
    }
  }

  cleanup(now = Date.now()) {
    for (const [key, entry] of this.store) {
      if (now >= entry.staleUntil) this.store.delete(key);
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { DnsCache };