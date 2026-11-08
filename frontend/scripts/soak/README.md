# 合成压测工具（无节点阶段 3 准入 · 第 35 轮）

阶段 3 的双读准入门槛（第 34 轮文档 §6.3 第 1 条，第 35 轮修订）：
不用真实客户订单（尚不存在），改用**合成压测**——自有测试钱包持续
签发订单流，服务端影子层连续运行 7 天、累计 ≥500 张有效订单，期内
零容忍线（冲突 0、无无效/未知单混入可成交集、过滤准确性 100%、
发现成功率 ≥99%、状态一致率 ≥99.9%）。本目录是这套压测的工具：
生成器 + 服务端轮次执行器 + JSONL 观测记录。

## 组件与骑乘关系（集成优先）

| 本工具的件 | 骑乘的既有件 |
|---|---|
| 订单签发 | 前端既有 `ORDER_TYPES`/`getEIP712Domain`（services/orderSigningTypes）+ ethers `signTypedData` |
| 签名字段重构/digest | dualread 的 `buildSignedOrderData`/`computeOrderDigest`（与前端/节点/中继同一口径，不另写） |
| nonce 读取 | 链上 `Settlement.getCurrentNonce`（与前端 fetchOrderNonce 同口径，viem 直读） |
| 落锁预检 | 链上 `Vault.availableBalance`（viem 直读），义务口径同 node 的 `ObligationForOrder` |
| 影子轮次 | dualread 的 `runDualReadRound`/`ShadowObserver`/`computeShadowMetrics`（生产同一套代码） |
| 链上状态 | dualread 的 `createChainStateReader` + viem multicall 传输层 |
| 中继书籍 | dualread 的 `createRelayBookAdapter`（第 30 轮 relay API 合同） |
| 交易对轮转（第 36 轮） | 前端既有 `TRADE_PAIRS` / `DEFAULT_PAIR` / `getPairTokens`（src/config/pairs），不另立平行表 |
| 打包 | 仓库既有 esbuild（vite 依赖），`build.mjs` |

自有代码只有：生成器的规格/预检/限速胶水、执行器的记账（submitted /
firstSeen 回放）、CLI 编排。

## 前置

1. **本机中继**（relay/ 仓库目录）：
   ```bash
   cd relay
   npx wrangler d1 migrations apply bit100-relay-orders --local
   npx wrangler dev --port 8787   # /health 应返回 {"ok":true,"db":"ok"}
   ```
   正式压测也可指向已部署的中继（改 SOAK_RELAY_URL）。
2. **测试钱包密钥**：`~/workspace/bite100-deployer/{maker,taker}.env`
   必须存在。工具只在运行时读取、只取第一个私钥令牌，绝不打印/落盘。
   钱包须在目标链 Vault 里有可落锁余额（生成器逐单预检，不足跳过并
   报确切缺口；工具绝不自行注资）。
3. **节点 API**：默认公网入口（Sepolia `https://node.aaxx123456.trade`、
   Base Sepolia `https://node-base.aaxx123456.trade`，经 Ren 电脑的
   Cloudflare 隧道——电脑关机时公网入口不可达，节点本身在 VM 上仍跑）。

## 构建与运行

```bash
cd frontend
node scripts/soak/build.mjs          # 产出 scripts/soak/dist/soak.mjs

# 冒烟（双链各一小批 + 一轮以上影子评估，约 1–2 分钟）
SOAK_OUT=~/workspace/soak-data/soak-metrics.jsonl \
  node scripts/soak/dist/soak.mjs smoke

# 持续压测（7 天准入运行由主聊天下令启动；前台进程，Ctrl-C/终止即停）
SOAK_OUT=~/workspace/soak-data/soak-metrics.jsonl \
SOAK_INTERVAL_SEC=600 \
  node scripts/soak/dist/soak.mjs run
```

`run` 模式每周期：双链各签发一小批（买卖两侧、资金可落锁的方向）→
双发 → 每链一轮影子评估（每轮评估覆盖全部交易对）→ JSONL 追加。
低频对抗样本：第 6 周期起每 6 轮一张 120 秒短存活单（喂 EXPIRED 路径）；每 12 轮一张中继侧
side 改写注入（同一签名、先于正本到达中继占住 digest——状态机必须
把它判冲突/未知，绝不进可成交集）。

交易对轮转（第 36 轮）：第 35 轮 as-built 只跑了 BTC/USDT 一对，与
3A 门槛「全部交易对」的口径不符。现 run 模式按周期在前端既有配置
`src/config/pairs` 的 `TRADE_PAIRS` 全表轮转（双链同周期同对，不另立
平行表），每周期每链单量与构成不变（Sepolia 3 / Base 2）；某对在某
链未登记、或钱包在该对无可落锁余额时，generator 预检跳过并在日志
写明原因（不注资、不硬凑）。冒烟仍固定默认对 BTC/USDT。

提交时刻口径（第 36 轮 N4）：`submitted` 行的 `submittedAt` 是该单
在提交路径发起网络提交的真实时刻（submitOrder 入口打点，经
SubmitOutcome 穿线到记账），不再是整批提交完成后的记账时刻——旧
口径会让批次内靠前订单的 propagationMs 被系统性低估。自检：
`npm run test:soak-timing`（fetch 桩验证逐单打点与穿线）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| SOAK_KEYS_DIR | `~/workspace/bite100-deployer` | maker.env/taker.env 所在目录 |
| SOAK_RELAY_URL | `http://127.0.0.1:8787` | 中继地址（本机 wrangler dev 或已部署实例） |
| SOAK_NODE_URL_11155111 | `https://node.aaxx123456.trade` | Sepolia 节点 API |
| SOAK_NODE_URL_84532 | `https://node-base.aaxx123456.trade` | Base Sepolia 节点 API |
| SOAK_OUT | `~/workspace/soak-data/soak-metrics.jsonl` | JSONL 观测记录路径 |
| SOAK_INTERVAL_SEC | 600 | run 模式周期间隔（秒） |
| SOAK_SUBMIT_GAP_MS | 2000 | 相邻提交最小间隔（节点接单口有 IP 限流） |

## 读结果（JSONL 口径）

每行一条记录，两种 kind：

- `submitted`：一单的提交记账——digest、链、对、角色、方向、创建/提交
  时刻、节点/中继接单成败、是否 side 改写注入样本。
- `round`：一轮影子评估——`metrics`（与数据页同口径的 11 项指标）、
  `filterOutcomes`（valid/unknown/invalid/tradeable 计数）、
  `discovery`（eligible=已提交超 60s 宽限期且至少一源接单的自造单；
  discoveredAny/Both；successRate）、`newFirstSeen`（本轮新发现的
  逐单逐源首次发现条目，含 orderAgeAtFirstSeenMs 与 propagationMs
  两个分开的延迟口径）、`errors`（本轮各源错误）。

准入核对（压测满 7 天后）：聚合全部 round 行——冲突率（metrics
.conflictRateAmongCommon）恒 0、tradeable 中无 invalid/unknown
（filterOutcomes 与 metrics.falseTradeableRate 交叉核对）、discovery
.successRate ≥99%、stateConsistencyRate ≥99.9%、有效订单累计
（submitted 行中双发成功数）≥500。进程重启不丢记账：启动时回放
JSONL 重建 submitted/firstSeen（尾行损坏自动跳过）。

**覆盖与计数汇总（第 37 轮）**：`node scripts/soak/report.mjs --file
<JSONL 副本>` 一次输出按链、按（链 × 交易对）的提交/双源接单/有效
样本/发现/篡改计数与各链对 500 线的达线状态（`npm run
test:soak-report` 为其自检）。「有效订单」的唯一计数定义见第 34 轮
文档 §6.3（第 37 轮补）。注意三处口径事实（与本工具输出对照阅读）：
① **篡改单不由 runner 的 discoveryStats 计入 eligible，但由
main.ts 在生成时标记 tampered**（第 12 周期注入；计数定义与工具按
「排除篡改单」对齐）。② **JSONL 落盘时刻的特殊形态**：服务重启
瞬间的一批 submitted 行共享同一 submittedAt（重启时统一落盘），
其值不早于真实提交时刻——计数不受影响，传播延迟统计对这批样本
偏乐观，引用时须注明。③ **tradeable 的时间语义**：cycle 11 的
篡改注入在本周期的评估轮次之后才发生（每 12 周期一轮，注入在提交
之后、评估只覆盖注入前状态），故含篡改单的轮次其 tradeable 计数
仍按注入前口径——3A 收尾时以「篡改单被发现的轮次」单独核对，
不要只看 tradeable 总数。

## 安全边界

- 只允许测试网链（11155111/84532），其他 chainId 生成器直接拒绝。
- 金额恒为小额（0.0005–0.001 基础币、价格 2000 的内部一致定价）；
  订单会真实落锁、可能被节点撮合成交并结算（测试网，预期内）。
- 密钥不进日志、不进 JSONL、不进 git；dist/ 已 gitignore。
