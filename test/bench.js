'use strict';

// 基准测试：单进程内 代理 + 接收端，测单向吞吐与往返延迟。
// 运行：node test/bench.js
//
// 注意：吞吐测试必须用"纯丢弃"接收端（不回显），否则回显会触发背压
// 传导阻塞，测出的不是吞吐而是回环带宽。

const net = require('net');

const { createServer } = require('../lib/server');

const PROXY_PORT = 17893;
const SINK_PORT = 17894;   // 丢弃接收端
const ECHO_PORT = 17895;   // 回显端（测延迟）
const TOTAL = 128 * 1024 * 1024;   // 128MB
const CHUNK = 65536;

function socks5Connect(proxyPort, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let sent = false;
    sock.on('data', (chunk) => {
      if (!sent && chunk[0] === 0x05) {
        sent = true;
        const hb = Buffer.from(targetHost, 'utf8');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.alloc(2),
        ]);
        req.writeUInt16BE(targetPort, req.length - 2);
        sock.write(req);
        return;
      }
      if (chunk[0] === 0x05 && chunk[1] === 0x00) resolve(sock);
      else reject(new Error(`SOCKS 失败 0x${chunk[1]?.toString(16) || '?'}`));
    });
    sock.on('error', reject);
  });
}

async function main() {
  // 纯丢弃接收端
  let sinkReceived = 0;
  let sinkResolve;
  const sinkDone = new Promise((r) => { sinkResolve = r; });
  const sink = net.createServer((s) => {
    s.on('data', (c) => {
      sinkReceived += c.length;
      if (sinkReceived >= TOTAL) sinkResolve();
    });
    s.on('error', () => {});
  });
  sink.listen(SINK_PORT, '127.0.0.1');

  // 回显端（测延迟）
  const echo = net.createServer((s) => {
    s.pipe(s);
    s.on('error', () => {});
  });
  echo.listen(ECHO_PORT, '127.0.0.1');

  const { server } = createServer({
    ...require('../config'),
    server: { host: '127.0.0.1', port: PROXY_PORT },
    pool: { ...require('../config').pool, maxIdlePerKey: 2, idleTimeout: 10000 },
    logging: { level: 'warn', statsInterval: 0 },
  });
  await server.start();

  // ---- 单向吞吐：client -> proxy -> sink（丢弃）----
  const sock = await socks5Connect(PROXY_PORT, '127.0.0.1', SINK_PORT);
  const buf = Buffer.alloc(CHUNK); // 复用同一块，隔离分配器开销
  let sent = 0;
  const t0 = process.hrtime.bigint();
  await new Promise((resolve, reject) => {
    const writeLoop = () => {
      while (sent < TOTAL) {
        if (!sock.write(buf)) {
          sock.once('drain', writeLoop);
          return;
        }
        sent += CHUNK;
      }
    };
    sock.once('error', reject);
    writeLoop();
    sinkDone.then(() => resolve());
  });
  const t1 = process.hrtime.bigint();
  const secs = Number(t1 - t0) / 1e9;
  const mbps = (TOTAL / 1e6) / secs;
  console.log(`单向吞吐 128MB: ${(TOTAL / 1e6).toFixed(0)}MB in ${secs.toFixed(3)}s => ${mbps.toFixed(0)} Mbps (~${(mbps / 8).toFixed(0)} MB/s)`);
  sock.destroy();

  // ---- 往返延迟：client -> proxy -> echo -> back，1000 次 ----
  const s = await socks5Connect(PROXY_PORT, '127.0.0.1', ECHO_PORT);
  const pkt = Buffer.alloc(128);
  const lat = [];
  const startTimes = new Array(1000);
  await new Promise((resolve) => {
    let i = 0;
    s.on('data', () => {
      if (i < 1000) {
        lat.push(process.hrtime.bigint() - startTimes[i]);
        i++;
        startTimes[i] = process.hrtime.bigint();
        s.write(pkt);
      } else {
        resolve();
      }
    });
    startTimes[0] = process.hrtime.bigint();
    s.write(pkt);
  });
  const sorted = [...lat].sort((a, b) => Number(a) - Number(b));
  const avgUs = Number(lat.reduce((a, b) => a + b, 0n) / BigInt(lat.length) / 1000n);
  console.log(`往返延迟(1000次,128B): avg=${avgUs}us p50=${Number(sorted[500]) / 1000}us p99=${Number(sorted[990]) / 1000}us`);

  s.destroy();
  await server.stop();
  sink.close();
  echo.close();
  console.log('基准测试完成');
}

main().catch((e) => { console.error('bench 失败:', e.message); process.exit(1); });