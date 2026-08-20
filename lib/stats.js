/**
 * ⚠️ DISCLAIMER: This tool is for educational purposes only.
 * Using it to bypass service restrictions may violate ToS.
 * Use at your own risk. The author assumes no liability.
 */
'use strict';

// ============================================================
// 轻量运行统计：仅累加计数，不影响热路径性能。
// ============================================================

function createStats() {
  return {
    startTime: Date.now(),
    handshakes: 0,
    requests: 0,
    resolved: 0,
    connections: 0,
    errors: 0,
    activeSessions: 0,
    // 由各模块在 stop 时汇总
    modules: {},
  };
}

function mergeStats(stats, { resolver, pool }) {
  stats.modules.resolver = {
    cacheHits: resolver.cache.stats.hits,
    staleHits: resolver.stats.staleHits,
    misses: resolver.cache.stats.misses,
    alidnsQueries: resolver.stats.alidns,
    systemFallbacks: resolver.stats.fallback,
    deduped: resolver.stats.deduped,
    negative: resolver.stats.negative,
    cacheEntries: resolver.cache.store.size,
  };
  stats.modules.pool = pool.statsSnapshot();
  return stats;
}

function printStats(stats, logger) {
  const s = mergeStats(stats, stats.refs);
  const uptime = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const r = s.modules.resolver;
  const p = s.modules.pool;
  logger.info(
    `统计(运行${uptime}s) 握手=${s.handshakes} 请求=${s.requests} 连接=${s.connections} 错误=${s.errors} 活动=${s.activeSessions} | ` +
    `DNS: 命中=${r.cacheHits} 陈旧命中=${r.staleHits} 未命中=${r.misses} Alidns=${r.alidnsQueries} 降级=${r.systemFallbacks} 去重=${r.deduped} 缓存项=${r.cacheEntries} | ` +
    `连接池: 复用=${p.reused} 新建=${p.created} 回收=${p.released} 丢弃=${p.discarded} 空闲=${p.idleTotal}`
  );
}

module.exports = { createStats, mergeStats, printStats };
