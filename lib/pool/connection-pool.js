/**
 * ⚠️ DISCLAIMER: This tool is for educational purposes only.
 * Using it to bypass service restrictions may violate ToS.
 * Use at your own risk. The author assumes no liability.
 */
'use strict';

const net = require('net');

// ============================================================
// 可复用连接池
//
// 语义：仅缓存"零字节传输"的已建立连接——TCP 握手完成但双方都未发过任何
// 应用数据。这样的连接与全新连接等价，可安全交给下一个客户端，从而省去
// 目标端握手 RTT（对高频目标收益明显，且不破坏 SOCKS5 协议语义）。
//
//  - acquire: 命中空闲连接直接复用；否则按地址列表逐一尝试新建（含失败切换）。
//  - release: 仅当 usable（本次会话双向零字节）且池未满时才回池，否则销毁。
//  - 空闲超时 / 定期清理 / 上限保护，防止占用过多系统资源。
// ============================================================

class ConnectionPool {
  constructor(poolConfig, tcpConfig, logger) {
    this.enabled = poolConfig.enabled !== false;
    this.maxIdlePerKey = poolConfig.maxIdlePerKey ?? 2;
    this.maxIdleTotal = poolConfig.maxIdleTotal ?? 256;
    this.idleTimeout = poolConfig.idleTimeout ?? 30000;
    this.tcp = tcpConfig;
    this.logger = logger;
    this.idle = new Map(); // key -> PooledConnection[]
    this.stats = { reused: 0, created: 0, released: 0, discarded: 0, closedIdle: 0 };
    this._cleanupTimer = setInterval(() => this.cleanup(), poolConfig.cleanupInterval ?? 10000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  keyFor(host, port) {
    return `${host}:${port}`;
  }

  _isHealthy(sock) {
    if (sock.destroyed) return false;
    if (sock.connecting) return false;
    if (!sock.readable || !sock.writable) return false;
    return true;
  }

  // 从池中借一个可用空闲连接；没有则返回 null
  _borrow(key) {
    const list = this.idle.get(key);
    if (!list || list.length === 0) return null;
    for (let i = 0; i < list.length; i++) {
      const pc = list[i];
      if (this._isHealthy(pc.socket)) {
        list.splice(i, 1);
        if (list.length === 0) this.idle.delete(key);
        pc.clearTimers();
        this.stats.reused++;
        return pc.socket;
      }
      this.stats.discarded++;
      pc.destroy();
      list.splice(i, 1);
      i--;
    }
    this.idle.delete(key);
    return null;
  }

  // 建立到目标的新连接，按 addresses 列表依次尝试（自动失败切换，IPv6 优先）。
  _connect(addresses, port) {
    const { connectTimeout, noDelay, keepAlive, highWaterMark } = this.tcp;
    let lastErr = null;
    for (const a of addresses) {
      const ip = a.address;
      try {
        return this._connectOne(ip, port, { connectTimeout, noDelay, keepAlive, highWaterMark });
      } catch (e) {
        lastErr = e;
      }
    }
    return Promise.reject(lastErr || new Error(`无法连接 ${port}`));
  }

  _connectOne(ip, port, { connectTimeout, noDelay, keepAlive, highWaterMark }) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: ip, port, highWaterMark });
      let settled = false;

      const timer = setTimeout(() => {
        sock.destroy();
        fail(new Error(`连接超时 ${ip}:${port}`));
      }, connectTimeout);

      const fail = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      };

      sock.once('connect', () => {
        clearTimeout(timer);
        if (noDelay) sock.setNoDelay(true);
        if (keepAlive) sock.setKeepAlive(true, 15000);
        settled = true;
        resolve(sock);
      });
      sock.once('error', fail);
    });
  }

  // 获取一条可用连接：优先复用空闲，否则新建。
  async acquire({ host, port, addresses }) {
    const key = this.keyFor(host, port);
    if (!this.enabled) {
      return { socket: await this._connect(addresses, port), key, pooled: false };
    }
    const borrowed = this._borrow(key);
    if (borrowed) {
      if (this.logger) this.logger.debug(`[池] 复用 ${key}`);
      return { socket: borrowed, key, pooled: true };
    }
    const socket = await this._connect(addresses, port);
    this.stats.created++;
    return { socket, key, pooled: false };
  }

  // 会话结束释放。usable = 会话双向零字节（连接未被"污染"）。
  release(key, socket, usable) {
    if (!socket || socket.destroyed) return;
    if (!usable || !this.enabled) {
      socket.destroy();
      if (!usable) this.stats.discarded++;
      return;
    }

    const list = this.idle.get(key) || [];
    if (list.length >= this.maxIdlePerKey || this._totalIdle() >= this.maxIdleTotal) {
      socket.destroy();
      this.stats.discarded++;
      return;
    }

    const pc = {
      socket,
      idleTimer: null,
      clearTimers() {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      },
      destroy() {
        this.clearTimers();
        if (!socket.destroyed) socket.destroy();
      },
    };

    // 空闲期间一旦出错/关闭就移出池，避免把死连接借出去
    const onBad = () => {
      const l = this.idle.get(key);
      if (!l) return;
      const idx = l.indexOf(pc);
      if (idx >= 0) l.splice(idx, 1);
      if (l.length === 0) this.idle.delete(key);
      this.stats.closedIdle++;
    };
    pc.onClose = onBad;
    pc.onError = onBad;
    socket.once('close', onBad);
    socket.once('error', onBad);

    pc.idleTimer = setTimeout(() => {
      pc.destroy();
      onBad();
    }, this.idleTimeout);

    list.push(pc);
    this.idle.set(key, list);
    this.stats.released++;
    if (this.logger) this.logger.debug(`[池] 回收 ${key}（空闲 ${list.length}）`);
  }

  _totalIdle() {
    let n = 0;
    for (const list of this.idle.values()) n += list.length;
    return n;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, list] of this.idle) {
      const alive = [];
      for (const pc of list) {
        if (!this._isHealthy(pc.socket)) { pc.destroy(); this.stats.closedIdle++; continue; }
        alive.push(pc);
      }
      if (alive.length) this.idle.set(key, alive);
      else this.idle.delete(key);
    }
  }

  async preWarm(host, port) {
    if (!this.enabled) return;
    try {
      const { socket } = await this.acquire({ host, port, addresses: [{ address: host, family: net.isIP(host) || 4 }] });
      this.release(this.keyFor(host, port), socket, true);
    } catch (e) {
      if (this.logger) this.logger.warn(`预热失败 ${host}:${port} - ${e.message}`);
    }
  }

  statsSnapshot() {
    return { ...this.stats, idleKeys: this.idle.size, idleTotal: this._totalIdle() };
  }

  stop() {
    clearInterval(this._cleanupTimer);
    for (const list of this.idle.values()) {
      for (const pc of list) pc.destroy();
    }
    this.idle.clear();
  }
}

module.exports = { ConnectionPool };
