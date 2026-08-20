# v6-freedom
白嫖 opencode dsv4f 的小工具。利用 opencode zen 支持 IPv6 + 国内运营商直接给光猫分配 /60 前缀的特性，实现多 IPv6 出口轮换，从而 dsv4f 自由。

> [!CAUTION]
> **免责声明与使用警示**
> 
> 1. **技术原理仅作展示**：本项目旨在演示 IPv6 前缀分配与出口轮换的技术可行性，代码仅供学习网络协议使用。
> 
> 2. **用户完全责任**：使用本工具轮换 IP 访问第三方服务（包括 ds v4f），**可能违反该服务的《用户服务协议》**。由此导致的账号封禁、服务中断、法律纠纷等一切后果，**均由使用者本人独立承担**，与项目作者无关。
> 
> 3. **合规使用建议**：请勿将本工具用于高频请求、数据爬取或任何可能影响他人服务正常运行的行为。建议在使用前咨询相关服务的官方允许范围。

## 特性

- `opencode.ai` 及子域名固定走 IPv6
- Alidns 解析 + 缓存、可复用连接池
- 增量协议解析，不卡死；背压感知转发
- 零第三方依赖，纯 Node 内置模块

## 快速开始

```bash
node index.js          # 默认监听 0.0.0.0:7890
node index.js --port 7890 --prewarm opencode.ai:443
```

客户端代理指向 `127.0.0.1:7890`，然后正常用 opencode 即可。

## 原理

国内宽带 IPv6 一般直接给光猫 /60 前缀（16 个 /64 子网）。配置多出口 IPv6 后，即可实现 DsV4F 自由
详见 [docs/IPV6_MULTI_IP.md](docs/IPV6_MULTI_IP.md)。

## 测试

```bash
node test/smoke.js
node test/e2e.js
```

## 目录

```
index.js                 入口
config.js                全部可调参数
lib/                     模块化实现（protocol/dns/pool/forward/router）
test/                    smoke + e2e 测试
```

## 实测吞吐性能

| 项目 | 结果 |
|---|---|
| 单向吞吐（64KB 缓冲） | **~75-79 Mbps** |
| 直连基线（无代理，同方法） | ~140 Mbps |
| 手动 relay vs 原生 pipe | 78 vs 79 Mbps（几乎无差） |
| HWM 64KB→1MB | 73→79 Mbps（无显著提升） |
| 往返延迟 p50（128B） | ~720us |