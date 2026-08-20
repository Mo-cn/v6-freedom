/**
 * ⚠️ DISCLAIMER: This tool is for educational purposes only.
 * Using it to bypass service restrictions may violate ToS.
 * Use at your own risk. The author assumes no liability.
 */
'use strict';

// ============================================================
// 入口：组装配置并启动 SOCKS5 代理。
// 运行：node index.js [--port 7890] [--prewarm host:port,...]
// 环境变量：SOCKS_PORT / PORT / SOCKS_LOG_LEVEL
// ============================================================

const config = require('./config');
const { createServer } = require('./lib/server');

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') config.server.port = parseInt(args[i + 1], 10) || config.server.port;
  else if (args[i] === '--prewarm') {
    config.pool.preWarm = args[i + 1].split(',').filter(Boolean).map((s) => {
      const [host, port] = s.split(':');
      return { host, port: parseInt(port, 10) };
    });
  }
}

const { server, ctx, logger } = createServer(config);

async function main() {
  await server.start();
  logger.info('========================================');
  logger.info(`SOCKS5 代理已启动`);
  logger.info(`监听: ${config.server.host}:${config.server.port}`);
  logger.info(`DNS: ${config.dns.servers.map((s) => s.address).join(', ')}`);
  logger.info(`连接池: ${config.pool.enabled ? `启用(maxIdlePerKey=${config.pool.maxIdlePerKey})` : '关闭'}`);
  logger.info(`预热目标: ${config.pool.preWarm.length || '无'}`);
  logger.info('========================================');

  // 预热：提前建立高频目标连接，降低调用方首包延迟
  if (config.pool.preWarm.length) {
    logger.info('开始预热连接池...');
    await server.prewarm(config.pool.preWarm);
    logger.info('预热完成');
  }
}

const shutdown = async () => {
  logger.info('正在关闭...');
  try { await server.stop(); } catch (_) {}
  logger.info('已退出');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  logger.error(`启动失败: ${err.stack || err.message}`);
  process.exit(1);
});

module.exports = { server, ctx, logger };
