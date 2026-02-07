# Phase 3 设计文档：链下订单簿、撮合节点、中继规模化与经济模型

> 版本：v0.1  
> 更新日期：2025-02-07  
> 关联：[概念设计文档](./概念设计文档.md)、[技术架构说明](./技术架构说明.md)、[Phase2-设计文档](./Phase2-设计文档.md)、[贡献奖励接口](./贡献奖励接口.md)

---

## 一、概述

Phase 3 目标：在 Phase 1（链上 AMM + 结算）与 Phase 2（存储/中继节点、贡献证明）基础上，实现**链下订单簿 + 撮合节点 + 规模化中继**，并上线**完整经济模型**（手续费按撮合/存储/中继/团队/治理分配）。

| 模块 | 目标 | 产出 |
|------|------|------|
| 链下订单簿 | 订单格式、同步协议、与链上结算衔接 | 订单/成交数据模型、Gossip 主题、Settlement 调用约定 |
| 撮合节点 | 接收订单、撮合、产出可结算证明 | 撮合引擎、多节点共识/锚定、结算证明格式 |
| 中继规模化 | 主题划分、限流、抗 Sybil | 中继拓扑、配额与信誉、可选质押 |
| 经济模型细化 | 比例、结算周期、领取流程 | 分配比例参数、周期对齐、ContributorReward 扩展 |

---

## 二、链下订单簿

### 2.1 设计原则

- **链下撮合、链上结算**：订单与成交在 P2P 网络内完成；资产划转仅通过 Vault + Settlement 在链上执行。
- **数据保留**：节点存储统一保留两周，与概念文档一致；超期自动清理，不请求、不存储超期数据。
- **可验证**：订单需用户签名；成交可汇总为默克尔证明或批量证明，供 Settlement 校验。

### 2.2 订单与成交结构

与 [技术架构说明 §4.2](./技术架构说明.md#42-存储节点数据模型) 对齐并扩展：

**订单（Order）**

| 字段 | 类型 | 说明 |
|------|------|------|
| orderId | bytes32 | 订单唯一 ID（如 keccak256(trader, nonce, pair, side, price, amount)） |
| trader | address | 下单方（EVM 地址，须在 Vault 有足够余额） |
| pair | string / bytes32 | 交易对，如 ETH/USDT |
| side | buy / sell | 买卖方向 |
| price | uint256 | 限价（定点数，与 API 约定精度一致） |
| amount | uint256 | 数量 |
| filled | uint256 | 已成交数量 |
| status | open / partial / filled / cancelled | 状态 |
| nonce | uint64 | 防重放 |
| createdAt | uint64 | 创建时间戳 |
| expiresAt | uint64 | 过期时间，0 表示长期有效 |
| signature | bytes | 对 orderId 或规范 payload 的 ECDSA 签名，链上/节点可验 |

**成交（Trade）**

| 字段 | 类型 | 说明 |
|------|------|------|
| tradeId | bytes32 | 成交 ID |
| pair | string / bytes32 | 交易对 |
| makerOrderId | bytes32 | Maker 订单 ID |
| takerOrderId | bytes32 | Taker 订单 ID |
| maker | address | Maker 地址 |
| taker | address | Taker 地址 |
| tokenIn, tokenOut | address | 结算用代币地址（与链上 TokenRegistry 一致） |
| amountIn, amountOut | uint256 | 数量（与 Settlement.settleTrade 参数对应） |
| fee | uint256 | 本笔手续费（可选，或结算时统一算） |
| timestamp | uint64 | 成交时间 |

### 2.3 订单簿与撮合规则

- **订单簿**：按交易对维护买卖盘；买盘按价格降序、时间升序；卖盘按价格升序、时间升序（Price-Time Priority）。
- **撮合**：新订单（Taker）与对手盘最优档位循环撮合，直到数量耗尽或无可成交价格；每笔成交生成一条 Trade，更新订单 filled/status 并广播。
- **撤单**：用户发 CancelRequest（orderId + signature）；节点校验签名后标记订单 cancelled，并从订单簿移除并广播。

### 2.4 与链上 Settlement 的衔接

- 每笔 Trade 对应链上一次 `Settlement.settleTrade(maker, taker, tokenIn, tokenOut, amountIn, amountOut, gasReimburseIn, gasReimburseOut)`。
- **谁提交**：可由撮合节点、专用「结算聚合者」、用户端或 **交易所（relayer）** 提交。当买卖双方无原生代币付 gas 时，可设置 relayer 由交易所代付；gas 费卖方买方均摊，从成交额中扣除后转给 relayer，交易费与 gas 费扣完后再转给买家/卖家。
- **证明**：链上不存完整订单簿；结算时仅需 maker/taker/数量/代币，可选附加 tradeId 或批量默克尔根以便审计与防重放。
- **手续费**：结算前/后按约定比例转入 FeeDistributor；ContributorReward 的「撮合贡献」按周期汇总撮合成交笔数或金额，用于分配撮合节点 40% 份额。

### 2.5 同步与一致性

- **新订单**：通过 `/order/new` Gossip 广播；存储节点与撮合节点订阅并写入本地。
- **撤单**：`/order/cancel` 广播。
- **成交**：`/trade/executed` 广播；存储节点持久化，用于历史查询与贡献统计。
- **订单簿快照/增量**：`/sync/orderbook` 用于节点间对账与恢复（快照 + OrderbookDelta）；保留期统一两周，超期删除。
- **一致性**：多撮合节点时需「订单路由到同一逻辑订单簿」或「共识出唯一撮合结果」——见第三节撮合节点。

---

## 三、撮合节点

### 3.1 职责

- 接收来自中继的订单，校验签名与余额（链下查询 Vault 或缓存）。
- 维护本机订单簿（或连接同一订单簿服务），执行 Price-Time 撮合。
- 产出成交记录（Trade），广播并通知存储节点；可选产出「可结算证明」供链上 Settlement 使用。
- 上报撮合贡献（笔数/成交量），用于经济模型 40% 分配。

### 3.2 单节点撮合流程

```
收到 Order → 验签、验 nonce、检查 Vault 余额（链下/缓存）
           → 插入订单簿 → 与对手盘撮合
           → 每笔成交：生成 Trade → 更新订单 filled/status → 广播 /trade/executed
           → 可选：将 Trade 加入「待结算队列」，由结算模块批量提交链上
```

### 3.3 多节点与共识

- **方案 A（单主撮合）**：指定或选举一个主撮合节点，所有订单路由到该节点；其他节点仅做只读副本与灾备。实现简单，主节点为瓶颈。
- **方案 B（分片按交易对）**：按 pair 分片，不同交易对由不同撮合节点负责；订单按 pair 路由。扩展性好，需路由与状态划分一致。
- **方案 C（多节点共识）**：多个撮合节点对同一订单簿做共识（如 BFT），输出一致撮合结果。延迟与复杂度高，适合高安全需求。

**建议**：Phase 3 先采用 **方案 A**，主撮合节点 + 多存储/中继；待吞吐量上来再考虑方案 B 分片。

### 3.4 结算证明与链上提交

- 每笔 Trade 对应链上 `settleTrade(...)` 所需参数已明确；可批量打包为多笔一次提交以省 Gas。
- **证明内容**：maker, taker, tokenIn, tokenOut, amountIn, amountOut（及可选 tradeId 列表）；可选对一批 Trade 做默克尔树，根上链，便于审计。
- **防重放**：链上对 (tradeId) 或 (maker, taker, orderId, amount) 做已结算记录，重复提交拒绝。
- **手续费**：结算时从交易额中扣费并转入 FeeDistributor；撮合节点贡献在 ContributorReward 中按周期以「撮合成交量」参与 40% 分配。

### 3.5 贡献度量（撮合）

- 指标：**撮合成交笔数** 和/或 **撮合成交金额**（以稳定币计价）。
- 上报：与 Phase 2 贡献证明一致，按周期（如每周）汇总；在 proof 的 metrics 中增加 `tradesMatched`、`volumeMatched`（可选）。
- 链上：ContributorReward 扩展支持「撮合类型」证明（如 nodeType=2），或沿用现有结构在 metrics 中加字段，贡献分公式加入撮合权重（见第四节经济模型）。

---

## 四、中继规模化

### 4.1 目标

- **扩展性**：支持更多节点、更多 Topic、更大带宽而不单点拥堵。
- **稳定性**：限流、背压，避免恶意或异常流量拖垮网络。
- **抗 Sybil**：避免大量虚假节点骗取中继奖励或干扰路由。

### 4.2 主题（Topic）划分

| Topic | 用途 | 建议策略 |
|-------|------|----------|
| `/order/new` | 新订单 | 按 pair 或全局；高优先级，低延迟 |
| `/order/cancel` | 撤单 | 同 order，限频/节点 |
| `/trade/executed` | 成交 | 按 pair 或全局，可分区 |
| `/sync/orderbook` | 订单簿同步 | 按 pair，大流量时限速 |
| `/sync/trades` | 历史成交同步 | 按时间范围，限速 |
| `/contrib/proof` | 贡献证明 | 按周期，限频 |

可进一步按 `pair` 或 `shard` 拆子主题，使中继 mesh 按主题分区，分散负载。

### 4.3 限流与背压

- **每节点**：对每个 Peer 的发布/转发速率设上限（如每秒消息数、每秒字节数）；超限则丢弃或排队，并可选记录为「异常」用于信誉。
- **全局**：对热点 Topic 可设全网或每 mesh 的带宽上限，防止雪崩。
- **背压**：存储节点或下游若处理不过来，可向中继反馈「慢」或「暂停」，中继临时降频或排队。

### 4.4 抗 Sybil

| 手段 | 说明 |
|------|------|
| **质押** | 中继/撮合节点入网需质押一定代币；作恶或长期离线可罚没。需治理决定是否启用及金额。 |
| **信誉** | 根据历史转发量、在线时长、违规次数计算信誉分；低信誉节点降权或踢出 mesh。 |
| **准入** | 初期可采用 Bootstrap 白名单 + 邀请；开放后改为「质押 + 信誉」或无需准入但奖励仅给高信誉节点。 |
| **贡献证明** | 中继贡献（bytesRelayed）与链上 ContributorReward 绑定；同一领奖地址多节点时，只认一个或设上限，避免一人多号刷量。 |

实现顺序建议：先**限流 + 信誉**，再视需要加**质押**与**准入**。

### 4.5 中继指标与贡献

- 与 Phase 2 一致：统计每周期 **bytesRelayed**、uptime；上报至 ContributorReward，参与 15% 中继分配。
- 规模化后：按 Topic 或按 (Topic, pair) 细分统计，便于计费或治理调参（如某类 Topic 权重更高）。

---

## 五、经济模型细化

### 5.1 分配比例（与概念文档一致）

| 对象 | 比例 | 依据 |
|------|------|------|
| 撮合节点 | 40% | 撮合成交量（笔数/金额） |
| 存储节点 | 25% | 存储量、可用性（uptime） |
| 中继节点 | 15% | 带宽、转发量（bytesRelayed） |
| 开发/运维团队 | 15% | 任务/里程碑，可由治理或多签发放 |
| 治理/储备 | 5% | 协议升级、紧急基金 |

比例可通过治理（Governance）调整；实现上在 FeeDistributor 或 ContributorReward 的配置中体现。

### 5.2 结算周期

- **贡献周期**：与 Phase 2 一致，建议 **7 天（UTC 自然周）**。
- **结算滞后**：当周产生的贡献，对应**下一周**的奖励池（即本周手续费收入作为下周可分配池）；避免「当周未结束就发奖」的时序问题。
- **领取**：节点在周期结束后提交证明；合约计算当周贡献分占比，从「可分配奖励池」中按占比 claim；支持多币种领取（见 [贡献奖励接口 §3.3](./贡献奖励接口.md#33-奖励池与兑换规则)）。

### 5.3 奖励池来源与计价

- **来源**：当周链上手续费收入（AMM Swap + 链下订单簿结算时收取的手续费），汇总到 FeeDistributor 或统一入口，再按比例注入当周「可分配池」。
- **计价**：以**稳定币**为计价单位；多币种领取时按**兑换时**该币对稳定币价格折算（或按结算周平均价格锁定，见贡献奖励接口）。
- **储备与自由流动**：可分配前扣减 reserveBps（如 15%）；自由流动比例 freeFlowBps（如 10%）可由治理调整。

### 5.4 撮合/存储/中继在合约中的统一

- **ContributorReward**：已支持按 period、按地址提交证明（uptime、storage、bytesRelayed、nodeType）；**已扩展**（Phase 3.4）：
  - **nodeType=2（撮合）**：使用 `submitProofEx` 传入 `tradesMatched`、`volumeMatched`；链下证明 metrics 含 `tradesMatched`、`volumeMatched`（见 [贡献奖励接口](./贡献奖励接口.md)）。
  - **贡献分权重**：撮合 40、存储 25、中继 15（`_computeScore` 内 WEIGHT_MATCH/WEIGHT_STORAGE/WEIGHT_RELAY），与 5.1 一致。
- **团队与治理**：15% 与 5% 可通过 FeeDistributor 的固定比例给多签/治理合约地址，或单独周期注入到指定地址，不经过 ContributorReward。

### 5.5 参数与治理

- **可治理参数**：手续费率（feeBps）、储备比例（reserveBps）、自由流动比例（freeFlowBps）、分配比例（撮合/存储/中继/团队/治理的 bps）。
- **通过规则**：与概念文档一致——**最近活跃人员**（过去 2 周有 submitProof）中**同意超过 50%** 即通过；投票期 7 天，执行可由 Timelock 延迟。

---

## 六、实施顺序建议

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **3.1** | 订单/成交数据模型与 Gossip 主题实现；存储节点支持订单簿与成交的持久化与保留期清理（统一两周） | Phase 2 节点与同步协议 |
| **3.2** | 单主撮合节点：接收订单、撮合、广播成交；与 Settlement 对接（单笔/批量 settleTrade） | 3.1；Settlement 权限与接口 |
| **3.3** | 中继主题划分与限流；bytesRelayed/信誉统计；抗 Sybil 基础（限流+信誉） | Phase 2 中继 |
| **3.4** | ContributorReward 扩展：撮合贡献、分配比例（40/25/15）；周期与领取与概念文档对齐 | 现有 ContributorReward |
| **3.5** | 前端：订单簿展示、限价单下单/撤单、成交与结算状态；可选撮合/中继监控与报表 | 3.2、3.3 |

**3.1 已实现**：订单表（orders）、Gossip 主题 `/p2p-exchange/order/new`、`/order/cancel`、`/trade/executed`、`/sync/orderbook` 的订阅与存储节点持久化，以及订单保留期清理（与 trades、orderbook_snapshots 一致）。

**3.2 已实现**：单主撮合节点（`node.type: match`）— 订阅 order/new、order/cancel，内存订单簿、Price-Time 撮合，广播 /trade/executed；Trade 含 maker/taker/tokenIn/tokenOut/amountIn/amountOut 供链上结算。链上提交需 Settlement owner 调用 `settleTrade`（可用 cast 或后续接 abigen binding）。

**3.3 已实现**：中继主题沿用 `network.topics`；按 peer 限流（`relay.rate_limit_bytes_per_sec_per_peer`、`rate_limit_msgs_per_sec_per_peer`），超限丢弃并记违规；每 peer 信誉（BytesRelayed、Violations），供后续降权/踢出；定期 Prune 避免 map 膨胀。质押与准入留待治理。

**3.4 已实现**：ContributorReward 扩展（撮合 nodeType=2、submitProofEx、40/25/15 权重）；节点证明含 tradesMatched/volumeMatched；撮合节点周期统计接入证明生成。

**3.5 已实现**：前端订单簿展示、限价单下单/撤单、成交与结算状态；节点 HTTP API（`api.listen`）提供 `/api/orderbook`、`/api/trades`、`/api/orders`、`POST /api/order`、`POST /api/order/cancel`；前端配置 `VITE_NODE_API_URL` 连接节点；可选展示节点类型（撮合/存储/中继）。

---

## 七、文档与接口索引

| 文档 | 说明 |
|------|------|
| [概念设计文档](./概念设计文档.md) | 经济模型比例、治理规则、数据保留（统一两周） |
| [技术架构说明](./技术架构说明.md) | 订单/成交结构、撮合逻辑、消息 Topic、数据流 |
| [Phase2-设计文档](./Phase2-设计文档.md) | 节点类型、同步协议、贡献证明 |
| [贡献奖励接口](./贡献奖励接口.md) | 证明格式、链上校验、贡献分、奖励池与领取 |
| [API-接口说明](./API-接口说明.md) | Settlement.settleTrade、FeeDistributor、Vault |

---

*Phase 3 设计以当时修改为准，随实现与治理决策随时更新设计文档；参见 [设计文档索引](./设计文档索引.md)。*
