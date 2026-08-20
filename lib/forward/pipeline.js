/**
 * ⚠️ DISCLAIMER: This tool is for educational purposes only.
 * Using it to bypass service restrictions may violate ToS.
 * Use at your own risk. The author assumes no liability.
 */
'use strict';

// ============================================================
// 高性能双向转发（中继）
//
//  - 手动流控：写入失败时暂停读侧，直到对端 drain 再恢复，保证背压，
//    不会把海量数据囤在内存里（.pipe 同原理，这里额外获得字节计数与
//    半关闭语义）。
//  - 半关闭：一端发来 FIN(end) 时向另一端转发 end，支持 HTTP/SSH 等
//    需要先关一个方向的应用；任一侧 close 则整体销毁，杜绝悬挂连接。
//  - 全程只使用原始 Buffer 切片，不拷贝、不转码。
//  - 返回控制句柄，可查询 a->b / b->a 双向字节数（用于判断能否回池）。
// ============================================================

function relay(a, b) {
  const bytes = { a2b: 0, b2a: 0 };

  const wire = (src, dst, counter, countKey) => {
    src.on('data', (chunk) => {
      counter[countKey] += chunk.length;
      if (!dst.write(chunk)) {
        src.pause();
        dst.once('drain', () => src.resume());
      }
    });
    src.on('end', () => {
      if (!dst.destroyed) dst.end();
    });
    src.on('error', () => {
      if (!dst.destroyed) dst.destroy();
    });
    src.on('close', () => {
      if (!dst.destroyed) dst.destroy();
    });
  };

  wire(a, b, bytes, 'a2b');
  wire(b, a, bytes, 'b2a');

  return {
    bytes,
    stop() {
      if (!a.destroyed) a.destroy();
      if (!b.destroyed) b.destroy();
    },
  };
}

module.exports = { relay };
