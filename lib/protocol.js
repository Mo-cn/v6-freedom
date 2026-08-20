'use strict';

const { ProxyError, REPLY } = require('./errors');

// ============================================================
// SOCKS5 协议解析（RFC 1928）
//
// 原实现用 socket.once('data')，一旦握手与请求合并到一个 TCP 段、
// 或请求被拆成多个段，数据就会丢失/截断，导致永久等待而"卡死"。
// 这里改为"增量缓冲 + 长度推导"，只要数据未到齐就一直累积，到齐即返回，
// 并返回 consumed 供调用方取出同一段里的提前数据（early data）。
// ============================================================

// 握手：VER(1) NMETHODS(1) METHODS(N)  -> 回复 VER=5 METHOD=0
function parseHandshake(buf) {
  if (buf.length < 2) return null;
  if (buf[0] !== 0x05) {
    throw new ProxyError('不支持的 SOCKS 版本', REPLY.NOT_ALLOWED);
  }
  const nmethods = buf[1];
  if (buf.length < 2 + nmethods) return null; // 等待更多数据
  const methods = buf.subarray(2, 2 + nmethods);
  if (!methods.includes(0x00)) {
    throw new ProxyError('客户端不支持无认证方式', REPLY.NOT_ALLOWED);
  }
  return { result: { method: 0x00 }, consumed: 2 + nmethods };
}

// 请求：VER(1) CMD(1) RSV(1) ATYP(1) DST.ADDR DST.PORT
function parseRequest(buf) {
  if (buf.length < 4) return null;
  if (buf[0] !== 0x05) {
    throw new ProxyError('请求版本错误', REPLY.NOT_ALLOWED);
  }
  const cmd = buf[1];
  if (cmd !== 0x01) {
    // 仅支持 CONNECT，UDP ASSOCIATE/BIND 明确拒绝
    throw new ProxyError(`不支持的 CMD: 0x${cmd.toString(16)}`, REPLY.COMMAND_NOT_SUPPORTED);
  }
  const atyp = buf[3];
  let need;
  if (atyp === 0x01) need = 4 + 4 + 2;                        // IPv4
  else if (atyp === 0x03) {                                   // 域名
    if (buf.length < 5) return null;
    need = 4 + 1 + buf[4] + 2;
  } else if (atyp === 0x04) need = 4 + 16 + 2;                // IPv6
  else {
    throw new ProxyError(`不支持的地址类型: 0x${atyp.toString(16)}`, REPLY.ADDRESS_TYPE_NOT_SUPPORTED);
  }
  if (buf.length < need) return null; // 等待更多数据

  let hostname, offset = 4;
  switch (atyp) {
    case 0x01: {
      const ip = buf.subarray(offset, offset + 4).join('.');
      offset += 4;
      hostname = ip;
      break;
    }
    case 0x03: {
      const len = buf[offset];
      offset += 1;
      hostname = buf.subarray(offset, offset + len).toString('utf8');
      offset += len;
      break;
    }
    case 0x04: {
      const parts = [];
      for (let i = 0; i < 8; i++) {
        parts.push(buf.readUInt16BE(offset + i * 2).toString(16));
      }
      hostname = compressIPv6(parts);
      offset += 16;
      break;
    }
  }
  const port = buf.readUInt16BE(offset);
  offset += 2;

  return {
    result: { hostname, port, addrType: atyp },
    consumed: need,
  };
}

function compressIPv6(parts) {
  // 简化 IPv6 压缩：合并最长连续 0 段
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '0') {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen < 2) return parts.join(':');
  const head = parts.slice(0, bestStart).join(':');
  const tail = parts.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

// 通用"读到一条完整消息为止"：
//   parser(buf) -> null(未齐) | { result, consumed }
//   initial：上一步解析残留的同段数据（握手后的请求可能已经到达）。
// 返回 { result, leftover }，leftover 为解析点之后同段内的剩余字节。
function collectMessage(socket, parser, timeoutMs, initial = null) {
  return new Promise((resolve, reject) => {
    const chunks = initial ? [initial] : [];
    let total = initial ? initial.length : 0;
    let settled = false;

    const timer = setTimeout(() => {
      finish(new ProxyError('等待数据超时', REPLY.GENERAL_FAILURE));
    }, timeoutMs);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (err) reject(err);
      else resolve(value);
    };

    const tryParse = () => {
      if (total === 0) return false;
      const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
      const parsed = parser(buf);
      if (parsed === null || parsed === undefined) return false;
      const leftover = total > parsed.consumed
        ? buf.subarray(parsed.consumed)
        : Buffer.alloc(0);
      finish(null, { result: parsed.result, leftover });
      return true;
    };

    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      try {
        tryParse();
      } catch (e) {
        finish(e);
      }
    };
    const onError = (e) => finish(e);
    const onClose = () => finish(new ProxyError('连接在对端消息前关闭', REPLY.GENERAL_FAILURE));

    // 先尝试解析初始残留数据（可能已是一条完整消息）
    if (initial && initial.length) {
      try {
        if (tryParse()) return;
      } catch (e) {
        finish(e);
        return;
      }
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

// 成功响应（沿用 BND.ADDR=0.0.0.0:0，客户端一般只用状态码）
function successReply() {
  return Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

function errorReply(code) {
  return Buffer.from([0x05, code, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

module.exports = {
  parseHandshake,
  parseRequest,
  collectMessage,
  successReply,
  errorReply,
  compressIPv6,
};