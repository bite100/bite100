# 无节点阶段 4（停节点总验收）运行器

设计文档 `docs/nodeless-design-2026-11-07.md` §8 阶段 4：**停掉节点
进程**，只用「中继（公告栏）+ 前端撮合 + 索引器 + 链上合约」跑全
剧本并产出对照报告。本目录是该验收的驱动：改造自第 35 轮 soak
影子压测（`scripts/soak/`），但路径完全不同——soak 是双发 + 双读
影子观察，本运行器是**中继单发 + 生产撮合自提结算 + 三方探针**。

## 路径与剧本

每周期（双链各一遍，交易对按 `TRADE_PAIRS` 轮转）：

1. maker 双侧签名订单**只投中继**（不投节点）；
2. 在场探针：中继已接单的单必须出现在中继簿（60s 内），否则按
   「订单丢失」零容忍停跑；
3. taker 双侧经生产 `executeFrontendMatch` 无头撮合：双读（节点源
   指向已停机的本地节点地址，其失败被双读按源降级——这正是要验
   的行为）→ 本地撮合 → 预检剔腿 → `settleTradesBatch` 自提；
4. 结算探针：回执 status、TradeSettled 事件数 == 腿数、taker
   已成交量不超签名量（回执读取带 120s 宽限轮询，宽限内查不到
   = 结算状态未知、按失败关闭停跑——第 45 轮 B4）；Envio 索引器
   成交与回执事件多重集比对（宽限期默认 900s，期内反复复查）——
   第 45 轮起按 Ren 口径只记观察项：索引器只是展示缓存、不是
   账本，滞后/不符不停机（见下「零容忍线」）。

低频剧本（按周期号轮转，与 soak 的低频对抗样本同模式）：

| 周期条件 | 剧本 | 断言 |
|---|---|---|
| %6==5 | 过期单（TTL 150s） | 到期后中继必须清理（先 +120s 看读侧过滤、再 +17min 看 Worker 清理 cron）；绝不可进可成交集 |
| %8==7 | 市价多腿扫簿（三档阶梯 + 市价单） | 必须 ≥2 腿整批成交，否则记 FAIL |
| %10==9 | 硬撤单（自锁 → releaseOrderLock） | 已撤单 filledIn 恒为 0，被结算即零容忍；中继仍列示属预期（无撤单路由，靠链上墓碑过滤） |
| %12==11 | 篡改注入（side 改写副本） | 中继必须在入库验签处拒绝（非 2xx），被接受即零容忍；正本随后正常投递 |
| %16==15 | 双 taker 竞态（两单并发吃同一 maker） | maker 总成交 ≤ 签名量，超量即零容忍；至少一路成交 |
| %24==23 | 失败归责申报 | 过期单结算必 revert（staticCall 取证 + 实发失败 tx），owner 钥调 chargeFailedSettlement(FAIL_ORDER_EXPIRED)；尽力剧本，逐步证据落盘，不作零容忍 |

零容忍线（任一触发立即停跑、保全证据、状态文件标
`zero-tolerance-triggered`、退出码 3）：**订单丢失 0、无效成交
上链 0、篡改单被接受 0、结算状态未知 0**（第 45 轮 B4 新增：
已提交结算在宽限内查不到回执或关键读数重试后仍失败 = 失败
关闭）。索引器不一致**不在**线内（Ren 2026-11-09 口径：链是
唯一账本，索引器只是展示缓存）：滞后记 `lagging`、字段不符记
`mismatch-observed`，均只记观察项、继续复查。

第 45 轮另加：**卡点隔离埋点**——周期路径每个网络调用在 metrics
里落 `call-start`/`call-end` 对（调用名见 engine.ts 的 traceCall
包裹点，如 `book.relay`、`match.execute`、`rpc.getTransactionReceipt`）；
运行若卡死，最后一个未配对的 `call-start` 即卡住的调用。
**B5 恢复账本** `stage4-pending-settlements.json`：已提交未确认的
结算先落盘，启动时先复查确认（口径同结算探针）才进新周期，
确认后清除。

第 48 轮（第 45 轮运行器半复审 P1/P2 修复，口径变更）：

- **记账时序**：拿到结算 txHash 先写恢复账本、再探回执（旧顺序
  先等 ≤120s 回执宽限才记账，窗口期进程被杀会丢账）；确认时先
  写 probe/恢复记录、再清账本，遗留条目下次启动按 txHash 幂等
  合并复查，不重复计数。
- **周期超时隔离**：单链周期被 420s 硬超时打断后，该链进入隔离
  状态（metrics 落 `quarantine` 行）——被放弃的在飞撮合可能迟到
  上链，下一周期开始前先对账（`reconcileAfterTimeout`：遗留待
  确认结算逐笔链上确认 + 自超时周期起始区块扫描 Settlement
  成交事件、认回涉及本运行器钱包的未知 txHash 并计数，落
  `reconcile`/`quarantine-cleared` 行），对完账才许对该链提新
  单；对账失败保隔离、跳过该链本轮，对账中发现不符按失败关闭
  停机。
- **恢复账本损坏 = 失败关闭**：账本文件不存在是空账本（正常）；
  存在但解析失败/形状不对按零容忍类停机（`PendingLedgerCorruptError`，
  状态标 `zero-tolerance-triggered`），不再静默当空账本。
- **恢复路径补齐**：已成交量读取与主路径共用 3 次重试助手；
  待确认记录缺 taker 签名量时不再跳过超量核对，按结算状态未知
  失败关闭。
- **中继通道口径**：发单请求超时标「接受状态未知」（metrics 落
  `relay-acceptance-unknown` 行）——在场探针连这批单一起查簿，
  在簿即认账补记接单（`relay-unknown-resolved`），到点不在簿只
  记无结论、不按订单丢失计；拉簿经适配器 fetchFn 注入带真实
  `AbortSignal` 的 fetch，超时真正掐断连接（外层硬超时保留为
  第二道保险）；`relay.postOrder` 打点覆盖到响应体读取。错误按
  timeout/http/network 分类（`isTimeoutError`），慢 ≠ 错。

第 50 轮（第 48 轮推送后复审条件项修复，口径变更）：

- **对账不得放行未验真的迟到成交**：事件扫描发现的迟到成交若
  回执在宽限内取不到或 status≠1，对账只留痕（`late-tx-unverified`
  + `incomplete-unverified-late-tx` 行）并抛错——**不报 complete、
  隔离保留**，下一周期重新对账；回执届时可见即认回。自家已记
  账本的结算仍走逐笔确认路径（回执不可见直接失败关闭停机）。
- **恢复账本首次创建崩溃窗兜底**：主账本文件缺失时，若遗留
  `.tmp`（写入后 rename 前被杀），先按全字段 schema 校验它：
  合法则采用并 rename 愈合；不合法按账本损坏失败关闭。
- **恢复账本全字段校验**：每行逐字段验（txHash/chainId/pair/
  takerDigest/legs/takerAmountIn/notedAt）；同 txHash 重复条目
  内容相同合并、内容冲突按账本损坏失败关闭，不再静默覆盖。
- **跨进程幂等判重落盘化**：已确认判重除内存记录外，再查
  metrics 里既有的 probe 记录行——进程死在「probe 行已写、
  pending 未清」时，重启不再重复确认、不再重复追加 probe 行。
- **故障注入自检**：`node scripts/stage4/faults.test.mjs`（假
  provider 驱动账本/恢复/对账四场景；回执始终不可见的变体须
  等满 120s 宽限，默认跳过，`S4_FAULTS_INCLUDE_SLOW=1` 启用）。

## 骑乘对照表（不重复造轮子）

| 本运行器的件 | 骑乘的既有件 |
|---|---|
| 订单生成/签名/nonce/落锁预检 | soak 的 `generator.ts`（generateBatch / loadWallets / vaultAvailable，与前端/节点/中继同一签名口径） |
| 撮合 + 批结算 | 生产 `services/matching/execute.ts` 的 `executeFrontendMatch`（双读→matcher→prune→settleTradesBatch，与线上前端同一份代码） |
| 中继簿读取 | dualread 的 `createRelayBookAdapter`（第 30 轮 relay API 合同） |
| 链上状态 | dualread 的 `createChainStateReader` + viem 传输层 |
| 索引器成交探针 | `services/tradesDual.ts` 的 `fetchIndexerTrades`（第 34/39 轮生产查询，含 GraphQL errors 口径） |
| 回执事件解析 | 产品 `SETTLEMENT_ABI`（indexer association 同一 ABI） |
| 已成交量/释锁/归责入口 | 最小 ABI 片段（与 generator 的最小 ABI 模式同构；产品 ABI 子集未覆盖 orderFilledIn/releaseOrderLock/chargeFailedSettlement） |
| 打包 | 仓库既有 esbuild（与 soak 的 build.mjs 同法） |
| 自有代码 | 中继单发、场景轮转、探针编排、JSONL/状态记账、CLI、第 45 轮的调用打点（traceCall）/失败关闭/恢复账本（落盘骑 saveState 同款 tmp+rename 原子写法，不新造框架） |

## 构建与运行

```bash
cd frontend
node scripts/stage4/build.mjs            # 产出 scripts/stage4/dist/stage4.mjs

# 只读预检（Phase P 即可跑；不签单、不发交易）
S4_INDEXER_URL=<现行 Envio 端点> node scripts/stage4/dist/stage4.mjs check

# 正式验收（Phase X：节点已停机、前端已切无节点模式后才可执行）
S4_INDEXER_URL=<切换后现行 Envio 端点> \
S4_INTERVAL_SEC=180 S4_MAX_HOURS=17 \
  node scripts/stage4/dist/stage4.mjs run
```

产物落 `~/workspace/bite100-stage4/`：`stage4-metrics.jsonl`
（逐事件记账，含 call-start/call-end 打点）、`stage4-state.json`
（随时可读的汇总状态：窗口、双链计数、零容忍状态、失败清单
尾部）、`stage4-pending-settlements.json`（B5 恢复账本，正常
确认为空）。run 模式拒绝在 `S4_INDEXER_URL` 未设置时启动
（索引器是展示一致性观察项的数据源）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| S4_KEYS_DIR | `~/workspace/bite100-deployer` | maker.env / taker.env / wallet.env（owner）所在目录 |
| S4_RELAY_URL | `https://bit100-relay.q3874758.workers.dev` | 已部署中继 |
| S4_INDEXER_URL | （无默认，run 必填） | Envio GraphQL 端点（切换后会轮换，go 时给现行值） |
| S4_NODE_URL_11155111 / S4_NODE_URL_84532 | `http://127.0.0.1:8080` / `:8081` | 本地节点 API（阶段 4 中应为停机状态；仅作双读对照源注入） |
| S4_DIR | `~/workspace/bite100-stage4` | 指标/状态落盘目录 |
| S4_INTERVAL_SEC | 180 | 周期间隔（秒） |
| S4_MAX_HOURS | 17 | 窗口上限（小时） |
| S4_TARGET_PER_CHAIN | 150 | 每链目标单数（记账口径，不作提前停跑条件） |
| S4_SUBMIT_GAP_MS | 1500 | maker 相邻投递间隔 |
| S4_INDEXER_GRACE_SEC | 900 | 索引器探针宽限期（秒） |

## 安全边界

- 只允许测试网链（11155111/84532），其他 chainId 直接拒绝；
- 金额恒为小额（0.0004–0.001 基础币、价格 1990–2010 合成定价）；
- 密钥不进日志、不进 JSONL、不进 git；dist/ 已 gitignore；
- 零容忍触发后**不自动重跑**：先保全 metrics/state，向主聊天回报。
