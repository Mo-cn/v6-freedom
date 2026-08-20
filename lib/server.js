'use strict';

const net = require('net');

const { handleSession } = require('./session');
const { relay } = require('./forward/pipeline');
const { ConnectionPool } = require('./pool/connection-pool');
const { Resolver } = require('./dns/resolver');
const { Router } = require('./router');
const { Logger } = require('./logger');
const { createStats, printStats } = require('./stats');

// ============================================================
// 服务器组装：把所有模块注入到会话上下文，便于替换扩展
// （例如换自定义 Router / Resolver / Pool 的实现）。
// ============================================================

function createServer(config = {}) {
  const logger = new Logger(config.logging.level);
  const router = new Router();                      // 可替换 / 追加规则
  const resolver = new Resolver(config.dns, logger);
  const pool = new ConnectionPool(config.pool, config.tcp, logger);
  const stats = createStats();

  const ctx = {
    config,
    logger,
    router,
    resolver,
    pool,
    stats,
    protocol: config.protocol,
    forward: relay,
  };
  stats.refs = { resolver, pool };

  const server = net.createServer({
    allowHalfOpen: false,
    pauseOnConnect: false,
  }, (socket) => {
    stats.activeSessions++;
    handleSession(socket, ctx).finally(() => {
      stats.activeSessions--;
    });
  });

  if (config.server.maxConnections > 0) {
    server.maxConnections = config.server.maxConnections;
  }

  const statsTimer = config.logging.statsInterval > 0
    ? setInterval(() => printStats(stats, logger), config.logging.statsInterval)
    : null;
  if (statsTimer && statsTimer.unref) statsTimer.unref();

  server.on('error', (err) => {
    logger.error(`服务器错误: ${err.message}`);
  });

  server.start = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  server.stop = () => new Promise((resolve) => {
    // 预热池中的连接后关闭
    pool.stop();
    resolver.stop();
    if (statsTimer) clearInterval(statsTimer);
    server.close(() => resolve());
    // 兜底：强制关闭残留连接
    setTimeout(() => { try { server.close(); } catch (_) {} resolve(); }, 2000).unref();
  });

  server.prewarm = async (targets) => {
    for (const t of targets) await pool.preWarm(t.host, t.port);
  };

  return { server, ctx, logger };
}

module.exports = { createServer };