'use strict';

const {
  parseHandshake,
  parseRequest,
  collectMessage,
  successReply,
  errorReply,
} = require('./protocol');
const { ProxyError, REPLY } = require('./errors');

// ============================================================
// 单次客户端会话编排：
//   握手 -> 请求解析 -> 路由 -> DNS 解析 -> 连接池取连接 -> 成功响应 -> 双向转发
// 结束后按"双向零字节"决定连接是否回池。
// 所有异常都会映射为对应的 SOCKS5 错误码并写回客户端。
// ============================================================

async function handleSession(clientSocket, ctx) {
  const {
    protocol, router, resolver, pool, logger, stats,
  } = ctx;
  const clientAddr = `${clientSocket.remoteAddress || '?'}:${clientSocket.remotePort || '?'}`;
  let target = null;
  let relayCtrl = null;
  let key = null;
  let used = false;

  try {
    // 1) 握手（增量缓冲，不依赖单次 data 事件）
    const hs = await collectMessage(clientSocket, parseHandshake, protocol.handshakeTimeout);
    clientSocket.write(Buffer.from([0x05, hs.result.method]));
    stats.handshakes++;

    // 2) 请求（与握手同段/跨段均可正确解析，使用握手后残留数据作为初始缓冲）
    const req = await collectMessage(clientSocket, parseRequest, protocol.requestTimeout, hs.leftover);
    const { hostname, port } = req.result;
    logger.info(`[请求] ${clientAddr} -> ${hostname}:${port}`);
    stats.requests++;

    // 3) 路由
    const route = router.route(hostname);
    logger.debug(`[路由] ${hostname} 命中规则: ${route.name} (family=${route.family})`);

    // 4) DNS 解析（Alidns + 缓存 + 降级）
    const addresses = await resolver.resolve(hostname, route.family);
    stats.resolved++;

    // 5) 连接池取连接（复用空闲 or 新建 + 地址失败切换）
    const acq = await pool.acquire({ host: hostname, port, addresses });
    target = acq.socket;
    key = acq.key;
    stats.connections++;

    // 6) 成功响应后开始转发
    clientSocket.write(successReply());

    // 同段内早到的数据（客户端在握手后立刻发送的负载）直接透传
    if (req.leftover && req.leftover.length) {
      target.write(req.leftover);
      used = true; // 已产生传输，不再回池
    }

    relayCtrl = ctx.forward(clientSocket, target);
    logger.info(`[已连接] ${clientAddr} <-> ${hostname}:${port} (${addresses[0].address})`);

  } catch (err) {
    const code = err instanceof ProxyError ? err.replyCode : REPLY.GENERAL_FAILURE;
    logger.warn(`[会话错误] ${clientAddr} -> ${err.message}`);
    try { clientSocket.write(errorReply(code)); } catch (_) {}
    if (relayCtrl) relayCtrl.stop();
    else if (target && !target.destroyed) target.destroy();
    stats.errors++;
    if (!clientSocket.destroyed) clientSocket.destroy();
    return;
  }

  // 7) 会话结束：按"双向零字节"决定连接去向
  const finish = () => {
    const untouched = !used && relayCtrl.bytes.a2b === 0 && relayCtrl.bytes.b2a === 0;
    if (target && !target.destroyed) {
      pool.release(key, target, untouched);
    }
    if (!clientSocket.destroyed) clientSocket.destroy();
    logger.debug(`[关闭] ${clientAddr} 双向${untouched ? '未使用(回池)' : '已使用(销毁)'}`);
  };

  // close 只触发一次（用 once 避免多次回收）
  clientSocket.once('close', finish);
  clientSocket.once('error', () => {
    if (relayCtrl) relayCtrl.stop();
  });
}

module.exports = { handleSession };