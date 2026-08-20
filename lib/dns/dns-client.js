/**
 * ⚠️ DISCLAIMER: This tool is for educational purposes only.
 * Using it to bypass service restrictions may violate ToS.
 * Use at your own risk. The author assumes no liability.
 */
'use strict';

const dgram = require('dgram');

// ============================================================
// 轻量 DNS over UDP 客户端：直接向阿里公共 DNS(223.5.5.5/223.6.6.6)查询。
// 只实现 A/AAAA/CNAME 最小集，支持指针压缩解码，失败时轮换服务器重试。
// ============================================================

const TYPE_A = 1;
const TYPE_CNAME = 5;
const TYPE_AAAA = 28;

function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.');
  const bufs = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'ascii');
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function decodeName(buf, offset) {
  let labels = [];
  let pos = offset;
  let endOffset = offset;
  let jumped = false;
  let hops = 0;
  for (;;) {
    if (++hops > 128) throw new Error('DNS 名称指针循环');
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      if (!jumped) endOffset = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) endOffset = pos + 2;
      pos = ptr;
      jumped = true;
      continue;
    }
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('ascii'));
    pos += len + 1;
    if (!jumped) endOffset = pos;
  }
  return { name: labels.join('.'), offset: endOffset };
}

function buildQuery(id, name, type) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD=1
  header.writeUInt16BE(1, 4);      // QDCOUNT=1
  const question = Buffer.concat([
    encodeName(name),
    Buffer.from([type >> 8, type & 0xff, 0x00, 0x01]), // QTYPE + QCLASS=IN
  ]);
  return Buffer.concat([header, question]);
}

function ipv4ToString(b) { return b.join('.'); }

function ipv6ToString(b) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
  return parts.join(':');
}

function parseResponse(buf) {
  if (buf.length < 12) throw new Error('DNS 响应过短');
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const rcode = flags & 0x0f;
  const truncated = (flags & 0x0200) !== 0;

  let offset = 12;
  for (let i = 0; i < qd; i++) {
    const q = decodeName(buf, offset);
    offset = q.offset + 4;
  }

  const answers = [];
  for (let i = 0; i < an; i++) {
    const name = decodeName(buf, offset);
    offset = name.offset;
    const type = buf.readUInt16BE(offset);
    const klass = buf.readUInt16BE(offset + 2);
    const ttl = buf.readUInt32BE(offset + 4);
    const rdlen = buf.readUInt16BE(offset + 8);
    const data = buf.subarray(offset + 10, offset + 10 + rdlen);

    let value = null;
    if (type === TYPE_A && rdlen === 4) value = ipv4ToString(data);
    else if (type === TYPE_AAAA && rdlen === 16) value = ipv6ToString(data);
    else if (type === TYPE_CNAME) value = decodeName(buf, offset + 10).name;

    answers.push({ type, name: name.name, ttl, value });
    offset += 10 + rdlen;
  }

  return { id, rcode, truncated, answers };
}

class DnsClient {
  constructor({ servers, timeout = 2000, retries = 2 } = {}, logger) {
    this.servers = servers;
    this.timeout = timeout;
    this.retries = retries;
    this.logger = logger;
    this._nextId = (Math.floor(Math.random() * 0xffff) & 0xffff);
  }

  _id() {
    this._nextId = (this._nextId + 1) & 0xffff;
    return this._nextId;
  }

  async query(name, type) {
    let lastErr = null;
    const attempts = 1 + this.retries;
    for (let i = 0; i < attempts; i++) {
      const server = this.servers[i % this.servers.length];
      try {
        return await this._queryOnce(server, name, type);
      } catch (e) {
        lastErr = e;
        if (this.logger) {
          this.logger.debug(`DNS ${name} 服务器 ${server.address} 失败: ${e.message}`);
        }
      }
    }
    throw lastErr || new Error('DNS 查询失败');
  }

  _queryOnce(server, name, type) {
    return new Promise((resolve, reject) => {
      const id = this._id();
      const msg = buildQuery(id, name, type);
      const isV6 = server.type === 'udp6';
      const sock = dgram.createSocket(isV6 ? 'udp6' : 'udp4');
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        try { sock.close(); } catch (_) {}
      };
      const fail = (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      };
      const timer = setTimeout(() => {
        fail(new Error(`DNS 请求超时(${server.address})`));
      }, this.timeout);

      sock.on('message', (resp) => {
        let parsed;
        try { parsed = parseResponse(resp); }
        catch (e) { return fail(e); }
        if (parsed.id !== id) return; // 忽略错乱 ID 的旧响应，继续等
        if (parsed.truncated) return fail(new Error('DNS 响应被截断'));
        if (parsed.rcode !== 0) {
          const err = new Error(`DNS 返回错误码 ${parsed.rcode}`);
          err.rcode = parsed.rcode;
          return fail(err);
        }
        settled = true;
        cleanup();
        resolve(parsed);
      });
      sock.on('error', fail);
      sock.send(msg, server.port, server.address, (err) => {
        if (err) fail(err);
      });
    });
  }

  async resolveA(name) { return this.query(name, TYPE_A); }
  async resolveAAAA(name) { return this.query(name, TYPE_AAAA); }
}

module.exports = { DnsClient, TYPE_A, TYPE_CNAME, TYPE_AAAA };
