/**
 * ⚠️ DISCLAIMER: This tool is for educational purposes only.
 * Using it to bypass service restrictions may violate ToS.
 * Use at your own risk. The author assumes no liability.
 */
'use strict';

// 统一配置入口，所有模块从这里读取参数，便于调优。
// 全部参数均可通过环境变量覆盖。

const env = process.env;

module.exports = {
  server: {
    host: env.SOCKS_HOST || '0.0.0.0',
    port: parseInt(env.SOCKS_PORT || env.PORT || '7890', 10),
    maxConnections: parseInt(env.SOCKS_MAX_CONN || '0', 10) || 0, // 0 = 不限制
    backlog: 511,
  },

  // 协议交互超时（毫秒）——原实现只有 once('data') + 10s 兜底，容易卡死，
  // 这里改成增量缓冲解析 + 分段超时。
  protocol: {
    handshakeTimeout: 5000,
    requestTimeout: 5000,
  },

  dns: {
    servers: [
      { address: '223.5.5.5', port: 53, type: 'udp4' }, // 阿里公共 DNS
      { address: '223.6.6.6', port: 53, type: 'udp4' },
    ],
    timeout: 2000,           // 单次查询超时
    retries: 2,              // 失败后重试次数（会轮换服务器）
    cache: {
      ttl: 300,              // 成功记录缓存秒数（取响应 TTL 与该项的较小值）
      stale: 60,             // 过期后的"陈旧可用"窗口（秒），期间返回旧值并后台刷新
      negativeTtl: 10,       // NXDOMAIN / 空结果缓存秒数
      maxEntries: 10000,
      cleanupInterval: 60000,// 缓存清理间隔 ms
    },
    systemFallback: true,     // Alidns 全部失败时回退系统解析器
  },

  // 可复用连接池：仅回收"零字节传输"的未使用连接（TCP 握手已建立、无应用数据），
  // 语义上等价于一条全新连接，可安全交给下一个客户端，省去握手 RTT。
  pool: {
    enabled: true,
    maxIdlePerKey: 2,         // 每个 host:port 最多保留的空闲连接数
    maxIdleTotal: 256,        // 全局空闲连接上限
    idleTimeout: 30000,       // 空闲连接存活时间 ms
    preWarm: [],              // 预热目标列表 [{host, port}]，启动时提前建连
    cleanupInterval: 10000,   // 过期/失效连接清理间隔 ms
  },

  tcp: {
    noDelay: true,            // 禁用 Nagle，降低调用方延迟
    keepAlive: true,
    highWaterMark: 65536,     // 64KB 缓冲，减少系统调用
    connectTimeout: 10000,    // 目标连接超时 ms
  },

  logging: {
    level: env.SOCKS_LOG_LEVEL || 'info', // debug | info | warn | error
    statsInterval: 60000,     // 统计打印间隔 ms，0 = 关闭
  },
};
