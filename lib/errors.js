/**
 * ⚠️ DISCLAIMER: This tool is for educational purposes only.
 * Using it to bypass service restrictions may violate ToS.
 * Use at your own risk. The author assumes no liability.
 */
'use strict';

// 带错误码与 SOCKS5 响应码的错误类型。
// replyCode 对应 RFC 1928 第 6 节：
// 0x00 成功 0x01 一般失败 0x02 规则不允许 0x03 网络不可达
// 0x04 主机不可达 0x05 连接被拒 0x06 TTL 过期 0x07 命令不支持 0x08 地址类型不支持
const REPLY = Object.freeze({
  SUCCESS: 0x00,
  GENERAL_FAILURE: 0x01,
  NOT_ALLOWED: 0x02,
  NETWORK_UNREACHABLE: 0x03,
  HOST_UNREACHABLE: 0x04,
  CONNECTION_REFUSED: 0x05,
  TTL_EXPIRED: 0x06,
  COMMAND_NOT_SUPPORTED: 0x07,
  ADDRESS_TYPE_NOT_SUPPORTED: 0x08,
});

class ProxyError extends Error {
  constructor(message, replyCode = REPLY.GENERAL_FAILURE, cause) {
    super(message);
    this.name = 'ProxyError';
    this.replyCode = replyCode;
    if (cause) this.cause = cause;
  }
}

module.exports = { ProxyError, REPLY };
