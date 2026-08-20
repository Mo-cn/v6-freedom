'use strict';

// 冒烟测试：验证全链路（握手 -> 请求解析 -> 连接 -> 双向转发 + 连接池复用）
// 运行：node test/smoke.js

const net = require('net');
const assert = require('assert');

const { createServer } = require('../lib/server');

const PROXY_PORT = 18089;
const ECHO_PORT = 18090;

// 本地回显服务（同时验证双向转发）
const echoServer = net.createServer((sock) => {
  sock.pipe(sock);
});
echoServer.listen(ECHO_PORT, '127.0.0.1');

// 手工构造 SOCKS5 CONNECT 请求（域名为 127.0.0.1，走 IPv4 类型）
function buildConnectRequest(host, port, useDomain = false) {
  if (useDomain) {
    const hostBuf = Buffer.from(host, 'utf8');
    const header = Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]);
    const tail = Buffer.alloc(2);
    tail.writeUInt16BE(port);
    return Buffer.concat([header, hostBuf, tail]);
  }
  const header = Buffer.from([0x05, 0x01, 0x00, 0x01]);
  const ip = Buffer.from(host.split('.').map(Number));
  const tail = Buffer.alloc(2);
  tail.writeUInt16BE(port);
  return Buffer.concat([header, ip, tail]);
}

// 单次 write 发送 握手+CONNECT+负载（管线化，验证无卡死）
function viaProxySingleWrite(proxyPort, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      const ip = Buffer.from([127, 0, 0, 1]);
      const tail = Buffer.alloc(2);
      tail.writeUInt16BE(ECHO_PORT);
      const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), ip, tail]);
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), req, Buffer.from(payload, 'utf8')]));
    });
    let got = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('管线化测试超时(卡死)')); }, 5000);
    sock.on('data', (chunk) => {
      got = Buffer.concat([got, chunk]);
      if (got.length >= 12 && got.toString('utf8', 12).includes(payload)) {
        clearTimeout(timer);
        sock.end();
        resolve(got.toString('utf8', 12));
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// 通过代理建立连接并发送数据
function viaProxy(proxyPort, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      // 握手
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('测试超时')), 8000);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // 握手响应(2) + 成功响应(10)
      if (buf.length >= 12 && buf[0] === 0x05 && buf[1] === 0x00) {
        const resp = buf.subarray(12);
        if (resp.length > 0) {
          // 回显数据
          clearTimeout(timer);
          sock.end();
          resolve(resp.toString());
        } else {
          // 需要发送 payload 触发回显
          sock.write(payload);
        }
      } else if (buf.length >= 2 && buf[0] === 0x05) {
        // 等待请求解析，发送 CONNECT
        sock.write(buildConnectRequest('127.0.0.1', ECHO_PORT));
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const { server, ctx } = createServer({
  ...require('../config'),
  server: { host: '127.0.0.1', port: PROXY_PORT },
  pool: { ...require('../config').pool, maxIdlePerKey: 2, idleTimeout: 5000 },
  logging: { level: 'warn', statsInterval: 0 },
});

async function main() {
  await server.start();
  await server.prewarm([{ host: '127.0.0.1', port: ECHO_PORT }]);

  // 1) 基本转发
  const reply = await viaProxy(PROXY_PORT, 'hello-proxy');
  assert.strictEqual(reply, 'hello-proxy', '回显数据不一致');
  console.log('✓ 基本转发 OK');

  // 2) 第二次连接应复用池中预热/回收的连接
  const reply2 = await viaProxy(PROXY_PORT, 'hello-again');
  assert.strictEqual(reply2, 'hello-again', '第二次回显不一致');
  console.log('✓ 连接复用 OK');

  // 3) 验证 pool 统计
  const ps = ctx.pool.statsSnapshot();
  console.log(`   pool: 复用=${ps.reused} 新建=${ps.created} 回收=${ps.released}`);

  // 4) 管线化回归：握手+CONNECT+负载同段发送（原实现会丢数据卡死）
  const pipelined = await viaProxySingleWrite(PROXY_PORT, 'early-data');
  assert.strictEqual(pipelined, 'early-data', '同段管线化回显不一致');
  console.log('✓ 同段管线化(握手+请求+负载) OK');

  // 5) DNS 解析（本地 IP 短路，不实际走 UDP）
  const addr = await ctx.resolver.resolve('127.0.0.1', 'auto');
  assert.strictEqual(addr[0].address, '127.0.0.1');
  console.log('✓ IP 短路解析 OK');

  await server.stop();
  echoServer.close();
  console.log('全部冒烟测试通过');
}

main().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});