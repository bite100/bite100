# 第 35 轮：第 34 轮 ChatGPT 复审整改（D1–D6 + M2-R + D8）与准入门槛修订、合成压测工具（2026-11-08）

基线 main 9627125（第 34 轮）。本轮触发：推送后 ChatGPT 复审
（有条件通过）新发现 D1–D8 与 M2 残余 M2-R，主聊天逐条对代码核实
全部属实后立项。本轮范围：整改 D1–D6、ABI 守卫残余 M2-R、D8 模式
标注门禁化；D7 不单独修浏览器观察器——按 Ren 2026-11-08 的修正
（「没客户怎么观察」）把阶段 3 准入门槛改为合成压测口径，观测
记账改由服务端工具落盘，D7 在设计上消解（见 §5）。**合约零改动**
（`git diff --name-only -- contracts/` 为空），节点 Go 代码零改动。

全轮纪律（项目底线）：集成优先、骑乘对照见 §7；功能/文案变更同轮
带页内说明（D8 三态说明、准入段落改写均已随代码上线）。

## 1. A 块 — 双读可信边界（D1–D4，frontend/src/services/dualread/）

### D1（高）：分页完整度进入状态机
`PreparedCandidate` 新增每源 `complete` 记录（prepareCandidates 从
SourceBook 透传）；`evaluateCandidate` 计算 `incompleteOnly`（在场
来源无一完整）：仅被不完整来源证明的订单，有效结论降 UNKNOWN
（原因码 SOURCE_INCOMPLETE），不进可成交集；有完整来源在场时按
完整来源判定，展示/诊断字段（pair/side/剩余量推导）也优先取完整
来源的副本。mergeBooks 不改（过滤口径在评估层已闭合）。
测试 5 例：仅节点不完整 / 仅公告栏不完整 / 两源都不完整 /
一源不完整另一源完整仍 VALID / 下一轮恢复完整回到 VALID。

### D2（高）：未签名字段的可信边界——含一处对复审前提的裁定
复审建议「从已签名字段（tokenIn/tokenOut 对交易对的排序）推导
方向」。**主聊天与本轮复核三方实现后裁定：该前提不成立**——签名
结构里 tokenIn/tokenOut 恒为交易对 (Token0, Token1)，与买卖方向
无关（前端下单表单、节点 BuildSignedOrder、中继 buildSignedOrder
三方一致，digest.ts 文件头与 eip712-order-spec §2/§4 均明载），
方向在现行协议里**无法**从签名字段推导。本轮不改协议，改用链上
权威证据：**Vault 锁仓代币即方向证据**——卖单落锁 tokenIn×amountIn、
买单落锁 tokenOut×amountOut（node/internal/settlement/lock.go 的
ObligationForOrder；Vault.lockForOrder 验签后按订单本身派生锁量，
锁定代币不是来源可填字段）。新增 `deriveSideFromLock`：
- 任一来源自报 side 与锁仓派生方向不符 → SIDE_LOCK_MISMATCH；
- 单源订单且无锁仓佐证 → SIDE_UNCORROBORATED；
- 单源订单声称 execType=market（未签名的非缺省执行类型）→
  EXEC_TYPE_UNPROVEN；缺失/'limit' 按协议缺省限价语义（新增
  normalizeExecType 归一，顺手修掉旧冲突判定把缺失映射成 'GTC'
  导致「一源写 limit、一源不写」误判冲突的口径 bug）；
- 以上只把 VALID 降为 UNKNOWN，不动 INVALID 终局判定；两源交叉
  核对（原 unsignedFieldConflict）保留。
测试 6 例：仅节点 side 改写 / 仅公告栏 side 改写 / 两源同写被改
side（互相抄、冲突检查抓不到、锁仓证据抓出）/ 单源市价声称 /
两源一致（含共同市价）VALID / limit 与不写不算冲突。另改写第 34
轮一条旧测试：单源无锁单原判 VALID/unlocked，现按 D2 判
UNKNOWN/SIDE_UNCORROBORATED（锁由提交者补齐的结算语义不变，
变的是「单源一面之词不进可成交集」）；测试夹具的锁仓代币改为
交易对真实 base 地址（原为任意假地址，不符合落锁口径）。

### D3（中）：零值订单不可重构
`buildSignedOrderData` 由「只拦负数」改为要求 amountIn>0、
price>0 且规范公式算出的 amountOut>0，与 Settlement._verifyFill
的 `amountIn > 0 && amountOut > 0` 口径对齐；不合者归
INVALID/UNBUILDABLE。边界测试：amountIn=1 wei × price=1 wei
（均非零、amountOut 舍为 0）→ 不可重构；amountOut 恰 1 wei → 通过。

### D4（中）：链上快照钉块
`ChainTransport.multicall` 增加 blockNumber 参数：读取器取到最新
区块后把块号透传，真实传输层把 blockNumber 交给 viem multicall
（原生支持），整份快照（过期判定时间与成交/nonce/锁状态）同属
一个区块，缓存按该块号归属。mock 传输层测试断言钉块号被透传、
新区块重新钉块读取。

## 2. B 块 — 成交双源（D5/D6）

### D5（中）：交易对过滤下沉服务端
`TRADES_QUERY` 的 where 改为按 (tokenIn, tokenOut) 双向组合 `_in`
本对地址集合（索引实体只有代币地址、无 pair 符号）；地址变量带
配置原样 + 小写双形态，防 Envio 落库大小写漂移；新增 offset 与
既有 limit/order_by 组成 Hasura 口径分页。客户端精确集合校验
保留作兜底。`buildTradesQueryVariables` 纯函数可测；测试断言
查询文本结构、变量构造、fetchIndexerTrades 实际请求体三层。

### D6（低-中）：两源独立失败
新增 `loadDualTrades`（allSettled 并发取两源）：节点宕机 → Envio
照常展示（组件页首明示「节点暂不可达，暂显示链上索引数据」）；
索引宕机 → 节点数据标「待索引」展示（原文案）；两源皆宕 →
unavailable，空态明示「节点与链上索引均不可达，成交数据暂不
可用」，不再误报「暂无成交」。RecentTradesWidget 的索引模式改走
该函数，未配置索引时的单源路径行为不变。测试 4 例覆盖三态 + 正常合并。

## 3. C 块 — 守卫与模式诚实（M2-R / D8）

### M2-R（低）：ABI 提取三引号全覆盖
首选路线（TypeScript 编译器 API 走 AST）**实测不可行**：
本仓库 typescript@^7 的主入口只暴露 version，经典 createSourceFile
API 不存在，仅有 `unstable/` 预览 API——CI 守卫不骑不稳定的预览
API（理由已写入脚本头）。按回退路线重写提取层：逐字符扫描器
（跟踪引号/注释状态），单/双/反引号纯字面量一律计数；模板表达式
${...}、反斜杠转义、标识符/展开等非纯元素一律报错，绝不静默
跳过；0 条声明仍拒绝空过。自检由 4 例扩到 9 例：新增反引号正例、
混合引号正例、**混合数组藏伪造声明**负例（漏检才会放行——计数
正确必然因漂移被拦）、模板表达式、表达式元素；双引号由负例转
正例（新口径下合法）。主检查对真实 config 仍 9 条一致。

### D8（中）：active 未接线门禁
config/relay.ts 新增 `RELAY_MODE_REQUESTED`（环境请求值）与
`effectiveRelayMode`：`RELAY_ACTIVE_WIRED=false` 期间，请求 active
的有效模式一律降为 shadow，`RELAY_MODE`（全站生效值）不可能为
active；useShadowMetrics 等消费方行为随之诚实。状态区徽标抽成
纯展示组件 ShadowModePill：请求 active 而有效 shadow 时明示
「正式模式尚未接线 · 当前按影子模式运行」；「合并视图展示中」
只留给真正接线后。同轮加三态模式页内说明（关闭/影子/正式各
干什么、正式为何未接线）。配置解析测试 4 例 + 组件渲染测试 4 例。

## 4. D 块之一 — 准入门槛修订（Ren 2026-11-08 修正，D7 的消解）

第 34 轮文档 §6.3 第 1 条与 §8、docs/INDEX.md 的 nodeless 设计行、
数据页 RelayStatus 的准入段落，四处同步改写：真实观察 7 天 +
≥500 张有效订单 → **合成压测口径**（自有测试钱包双链全对持续
签发 ≥500 张、含对抗场景；服务端连续运行 7 天；零容忍线不变）。
真实用户观察改为**主网灰度期指标**，不再作阶段 3 门槛。观测记账
服务端逐轮落盘 JSONL（含每源首次发现时刻、发现成功率、订单年龄
与传播延迟分开统计）——浏览器内存观察器的留存问题（D7）由此
在设计上消解，不再单独修补页面观察器。

## 5. D 块之二 — 合成压测工具（frontend/scripts/soak/）

- **generator.ts**：测试钱包签发真实 EIP-712 订单（nonce 取链上
  getCurrentNonce、跨批次游标连续）；逐单预检 Vault 可用余额是否
  覆盖落锁义务，不足跳过并报确切缺口（义务/可用 wei 数字），
  绝不自行注资；双发（节点主发 + 中继副发），提交间隔限速；
  只允许测试网链。密钥只从 `~/workspace/bite100-deployer/` 的
  maker.env/taker.env 运行时读取（只取第一个私钥令牌），不打印、
  不落盘、不进日志。对抗注入：side 改写副本（同一签名）可先于
  正本投递到中继占住 digest，制造跨源篡改样本。
- **runner.ts**：服务端影子轮次执行器——注入自备节点适配器
  （按链指定任意节点 URL，行规范化复用 toRawOrder/sortBookSide）
  与既有中继适配器，调 dualread 的 runDualReadRound（生产同一套
  状态机/指标代码）；记账（submitted/firstSeen）逐轮追加 JSONL，
  进程重启回放重建；发现成功率独立统计（分母=已提交超宽限期且
  至少一源接单的自造单）；首次发现双延迟口径分开记
  （orderAgeAtFirstSeenMs / propagationMs）。
- **main.ts**：`smoke`（双链小批 + 等传播 + 轮次落盘）与 `run`
  （周期间隔循环：签发小批 + 评估 + 落盘；每 6 轮一张短存活单、
  每 12 轮一张 side 改写注入）两模式；配置全走 SOAK_* 环境变量。
- **build.mjs**：既有 esbuild 打包成 dist/soak.mjs（import.meta.env
  define 为 {}——服务端行为不依赖浏览器环境变量，地址/mode 全由
  注入决定；createRequire 垫片处理 ethers 传递依赖的 CJS require）。
- **README.md**：前置（本机中继起法/密钥/节点入口）、构建运行、
  环境变量表、JSONL 口径与准入核对方法、安全边界。

### 冒烟实证（2026-11-08，本机中继 wrangler dev :8787 + 公网节点）
- 本机中继：本地 D1 迁移 applied，/health 返回 {"ok":true,"db":"ok"}。
- 双链 5 单（Sepolia maker 卖/买 + taker 买；Base maker/taker 买，
  0.0005–0.001 BTC @2000）全部签发、双发成功（node=ok、relay=ok），
  无跳过（余额预检：Sepolia maker 金库 USDT≈120/BTC≈0.048、taker
  USDT=1000；Base maker USDT=1000、taker USDT≈6——均覆盖小额义务）。
- Sepolia 上 maker 卖单与随后同价的 maker 买单被节点真实撮合，
  /api/trades 出现成交记录（taker=_2 × maker=_1）——生成器订单是
  协议真单，不是自娱自乐的假流量。
- 影子轮次：首轮（提交约 10 秒后）自造单仅在中继侧被发现（节点
  订单簿收录滞后于链上落锁），其中已被节点落锁佐证方向的一单判
  VALID、未落锁的两单（含 side 改写注入单）判 UNKNOWN 不进可
  成交集——D2 的 fail-closed 在真实链路按设计工作；次轮双链
  5/5 全部被发现。JSONL 落盘于
  `~/workspace/soak-r35-smoke/soak-metrics.jsonl`（仓库外）。
- 传播延迟实测（中继侧首次发现）：约 15–19 秒（含 10 秒轮询粒度）。

## 6. 门禁结果（主执行自测）

- 前端 `npm test`：**292/292**（28 文件；基线 263 + 新增 29），
  `npm run build` 通过，`tsc --noEmit` 干净。
- relay `npm test`：**32/32**（20 unit + 12 workers），未改 relay 代码。
- ABI：`npm run check:abi` 9 条一致；`check:abi:selftest` 9/9。
- `git diff --name-only -- contracts/`：**空**（forge build 的
  foundry.lock 副作用已还原，out/ 为 gitignore 产物）。
- 节点 Go 代码未触碰（本轮无 node/ 改动）。

## 7. 骑乘对照（集成优先核对）

| 本轮新件 | 骑乘的既有件 |
|---|---|
| D1 完整度透传 | 既有 SourceBook.complete（第 34 轮适配器已产出）+ 既有状态机 done() 降级口 |
| D2 方向证据 | 既有 Vault 锁仓语义（第 15 轮 lockForOrder + 节点 ObligationForOrder 口径）+ 既有链上快照的 lock 字段（零新增链读） |
| D3 零值口径 | 既有 Settlement._verifyFill 合约口径 + 既有 UNBUILDABLE fail-closed 通道 |
| D4 钉块 | viem multicall 原生 blockNumber 参数（既有依赖既有能力） |
| D5 服务端过滤 | Envio/Hasura 既有 GraphQL where 口径 + 既有 getPairTokens 登记 |
| D6 独立失败 | 既有 mergeTradeSources 合并口径 + Promise.allSettled |
| M2-R 提取 | 零新依赖（AST 路线因 typescript@7 无稳定 API 而放弃，理由在脚本头） |
| D8 门禁 | 既有 parseRelayMode 解析口径 + 既有 RelayStatus 状态区 |
| 压测签发 | 既有 ORDER_TYPES/getEIP712Domain + dualread 的 digest 重构/摘要 + ethers |
| 压测评估 | dualread 的 runDualReadRound/ShadowObserver/链上读取器（生产同一套） |
| 压测打包 | 既有 esbuild（vite 依赖） |
| 本机中继 | 第 30 轮 relay 的 wrangler dev + 本地 D1 迁移（现成运维路径） |

自有新代码仅限：状态机的完整度/信任上限胶水、查询构造、双源取数
编排、ABI 扫描器、压测的规格/预检/记账——均为差异化核心与胶水。

## 8. 未做 / 待办（如实记录）

- **7 天压测尚未开始**：工具与冒烟已就绪，正式运行（含本机中继的
  持续托管方式）待主聊天下令启动；本轮 wrangler dev 进程为临时
  实例（:8787，r35 worktree 的 relay 目录），重启即停，起法在
  soak README。
- 中继正式部署仍待 Ren 的 Cloudflare 三步；Envio 部署仍待 Ren 的
  账号/token（与第 34 轮一致，未变）。
- 被撮合的冒烟卖单成交后，节点订单簿里对应买单的展示残留
  （open/filled=0）属节点既有行为观察，未在本轮范围（节点代码
  零改动）；如需深究另行立项核对。
- INDEX 中第 34 轮条目的状态文案（「本地完成，待合并推送」）已
  过时——第 34 轮实际已推送 9627125，本轮未顺手改他人轮次条目，
  留主聊天收口时一并订正。
