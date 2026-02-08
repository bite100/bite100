# 客户端 P2P 运行指南（浏览器 / 桌面端）

本指南说明如何在前端内嵌 **JS-libp2p**，实现“客户端直连”：订单发现与撮合在浏览器或 Electron 内完成，无需依赖中心服务器；链上结算仍通过 Settlement 合约完成（混合模式不变）。

---

## 1. 架构概览

- **P2P 层**：使用 **libp2p**（TypeScript/JS）运行在浏览器或 Electron 渲染进程。
- **传输**：**WebRTC** 优先（NAT 穿透）、**WebSocket** 作为 fallback。
- **协议**：**GossipSub** 广播订单/撤单/成交；**Kad-DHT** 可选，用于 peer 发现。
- **消息格式**：当前使用 **JSON**（与 Go 节点、Phase3 主题一致），见 `frontend/src/p2p/types.ts` 与 `frontend/src/proto/order.proto`（可选 proto 互操作）。
- **Go 节点**：可作为**可选后备**（如 Bootstrap 或 HTTP/WS 桥接），见下文「Go 节点桥接」。

---

## 2. 环境与依赖

前端已纳入 JS-libp2p 相关依赖（见 `frontend/package.json`）：

- `libp2p`、`@libp2p/websockets`、`@libp2p/webrtc`
- `@libp2p/gossipsub`、`@libp2p/kad-dht`、`@libp2p/bootstrap`、`@libp2p/identify`
- `@chainsafe/libp2p-noise`、`@chainsafe/libp2p-yamux`
- `uint8arrays`

安装与本地运行：

```bash
cd frontend
npm install
npm run dev          # 开发
npm run p2p-test     # 同上，用于 P2P 联调
```

**WebRTC 注意**：浏览器中 WebRTC 在 **HTTPS** 或 **localhost** 下可用；部署到 Vercel/Netlify 等已满足 HTTPS。本地用 `npm run dev` 即可；若需外网访问可用 ngrok 暴露为 HTTPS。

---

## 3. 前端 P2P 逻辑位置

| 功能           | 路径 |
|----------------|------|
| 节点创建       | `frontend/src/p2p/node.ts`（WebRTC + WebSocket、GossipSub、DHT、Bootstrap） |
| 订单发布/订阅  | `frontend/src/p2p/orderPublisher.ts`、`orderSubscriber.ts` |
| 撮合引擎       | `frontend/src/p2p/matchEngine.ts`（内存订单簿、Price-Time 优先） |
| 生命周期与桥接 | `frontend/src/p2p/manager.ts`（单例、可选 IndexedDB） |
| 协议常量       | `frontend/src/p2p/types.ts`（TOPICS：order/new、order/cancel、trade/executed） |
| Proto 定义     | `frontend/src/proto/order.proto`（与 Go 互操作时可生成 JS 代码） |

订阅到新订单后会：加入本地订单簿 → 尝试撮合 → 若有成交则**广播成交**并触发 `trade-executed` 事件；前端可在此处调用 Settlement 合约完成链上结算。

---

## 4. React 集成

通过 **P2PContext** 使用（见 `frontend/src/contexts/P2PContext.tsx`）：

- 在根组件外包一层 `<P2PProvider enableStorage={false}>`（或 `true` 启用 IndexedDB）。
- 在子组件中 `useP2P()` 得到 `publishOrder`、`cancelOrder`、`isConnected`、`peerId`、`peerCount` 等。
- 下单时调用 `publishOrder(order)`，订单经 GossipSub 广播；收到成交后可在监听 `trade-executed` 的代码里触发链上结算。

---

## 5. 配置（可选）

`frontend/src/config.ts` 中 **P2P_CONFIG**：

- **WS_URL** / **API_URL**：连接 Go 节点时使用；纯客户端 P2P 可不填或留默认。
- **BOOTSTRAP_PEERS**：由环境变量 `VITE_P2P_BOOTSTRAP` 提供，逗号分隔的 multiaddr，用于 DHT 发现。示例：

```env
VITE_P2P_BOOTSTRAP=/ip4/1.2.3.4/tcp/443/wss/p2p/12D3KooW...
```

若不设，则依赖 WebRTC 直连或手动 `dial`。

---

## 6. Windows 客户端（Electron）与打包

- 已有脚本：`npm run electron:dev`、`npm run electron:build`（或 `npm run dist`）生成 Windows exe。
- **Electron 内 P2P**：与浏览器相同，使用同一套 JS-libp2p 代码；Electron 环境无 HTTPS 限制，WebRTC/WebSocket 均可使用。
- 打包优化：`vite.config.ts` 中已为 libp2p 做 `manualChunks` 与 `optimizeDeps`，便于控制 bundle 体积与加载。

若需将 Go 节点作为“引导服务器”，可在同一台机或服务器运行节点，前端配置 `VITE_P2P_BOOTSTRAP` 指向该节点的 multiaddr。

---

## 7. 测试建议

- **本地**：`npm run dev`，开两个浏览器标签（或一个普通 + 一个无痕），连接钱包后分别下单，在控制台观察「收到新订单」「撮合成功」「收到成交」及后续链上 tx。
- **多机**：同一 WiFi 或公网下，配置公共 Bootstrap 或已知 peer 的 multiaddr，多设备同时打开前端验证 P2P 连通与撮合。
- **在线**：部署到 Vercel（HTTPS）后，用 `node.getPeers()` 或控制台检查 peer 连接数，确认 GossipSub 正常。

---

## 8. 风险与优化

- **防火墙/企业网**：若 WebRTC 被拦，可配置 TURN（如 coturn）；当前 STUN 已配 Google/Twilio。
- **隐私**：订单通过 GossipSub 明文广播，后续可考虑 zk 等方案。
- **激励**：客户端节点可通过 FeeDistributor 等合约领取 relayer 等激励（需与合约与前端逻辑对接）。
- **性能**：连接数已通过 `connectionManager.maxConnections` 限制（如 100）；DHT 可缓存热门订单，减轻重复请求。

---

## 9. 与 Go 节点的关系

- **客户端优先**：默认以浏览器/Electron 内 JS-libp2p 为 P2P 主体，实现真正“客户端直连”。
- **Go 节点为可选**：可用于 Bootstrap、中继或提供 HTTP/WS API（订单簿查询、历史成交等）。前端可同时配置 `P2P_CONFIG.API_URL` / `WS_URL` 与 `BOOTSTRAP_PEERS`，实现混合：发现与撮合在客户端，必要时回退或补充到 Go 节点。

维护原则：功能或配置变更时，请同步更新本指南与 [P2P交易撮合整合步步指南](./P2P交易撮合整合步步指南.md)、[设计文档索引](./设计文档索引.md)。
