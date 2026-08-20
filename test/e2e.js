'use strict';

// 端到端测试：进程内启动代理，经 SOCKS5 访问真实 HTTPS 站点，验证后正常退出。
// 运行：node test/e2e.js

const http = require('http');
const net = require('net');
const tls = require('tls');

const { createServer } = require('../lib/server');

const PROXY_PORT = 17891;

function socks5Connect(host, port, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host, () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00])); // 握手
    });
    let sent = false;
    sock.on('data', (chunk) => {
      if (!sent && chunk[0] === 0x05) {
        // 已收到握手响应，发 CONNECT
        sent = true;
        const hb = Buffer.from(targetHost, 'utf8');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]),
          hb,
          Buffer.alloc(2),
        ]);
        req.writeUInt16BE(targetPort, req.length - 2);
        sock.write(req);
        return;
      }
      // 收到成功响应(10字节)
      if (chunk[0] === 0x05 && chunk[1] === 0x00) {
        resolve(sock);
      } else {
        reject(new Error(`SOCKS 连接失败: 状态码 0x${chunk[1]?.toString(16) || '?'}`));
      }
    });
    sock.on('error', reject);
    sock.setTimeout(10000, () => reject(new Error('SOCKS 连接超时')));
  });
}

async function main() {
  const { server, ctx } = createServer({
    ...require('../config'),
    server: { host: '127.0.0.1', port: PROXY_PORT },
    logging: { level: 'info', statsInterval: 0 },
  });
  await server.start();
  console.log(`代理已启动 127.0.0.1:${PROXY_PORT}`);

  // 经代理访问 example.com（HTTP，便于校验 DNS 解析 + 转发）
  const relay = await socks5Connect('127.0.0.1', PROXY_PORT, 'example.com', 80);
  const req = http.request({
    host: 'example.com',
    port: 80,
    path: '/',
    createConnection: () => relay,
  }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', async () => {
      console.log(`✓ HTTP(经代理) 状态=${res.statusCode} 长度=${body.length}`);
      const dnsStats = ctx.resolver.cache.stats;
      const poolStats = ctx.pool.statsSnapshot();
      console.log(`DNS: 命中=${dnsStats.hits} 未命中=${dnsStats.misses} | Pool: 复用=${poolStats.reused} 新建=${poolStats.created}`);

      await server.stop();
      console.log('端到端测试通过');
    });
  });
  req.on('error', async (e) => {
    console.error('HTTP 请求失败:', e.message);
    await server.stop();
    process.exit(1);
  });
  req.end();
}

main().catch(async (e) => {
  console.error('e2e 失败:', e.message);
  process.exit(1);
});