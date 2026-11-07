# 第十七轮记录（2026-11-07）：砍掉 AMM + 市价单 + 做市金库设计 + 下单一键补存

> 决策来源：Ren 在 AMM 调研（`~/workspace/research_notes/amm-pool-designs-dex-decision-20261107-0937/`）
> 后拍板「砍掉 AMM：补市价单 + 做市金库，走 HY 路线」；Part D 为 Ren 真机
> 试用后追加（保留 Vault 模型，把存入做顺滑）。
> 本轮全部为本地提交，未 push（主聊天验收后统一推送）。无合约重部署。

提交清单（自旧到新）：
- `8735208` Part A 合约/脚本：删除 AMM 两合约与专属测试，Deploy 脚本去 AMM
- `25a52bd` Part A 节点：删除死代码 chain fetcher 与 amm_pool 配置
- `e642b05` Part A 前端：下线「兑换」分区，导航收敛五分区
- `a3907b3` Part B 节点：市价单 IOC 执行（storage/match/api/cmd/settlement）
- `833770a` Part B 修正：市价单余量口径含价格改善差额
- `00e7e43` Part B：市价单 anvil E2E 双场景 + 脚本覆盖
- `d2d0564` Part B/D 前端：市价单面板 + 一键补存
- `c5b1701` Part C：做市金库设计文档
- （本文档与 IA/roadmap 同步另行一提交）

---

## Part A — 砍掉 AMM

### A.1 引用地图（动手前逐项核实，结论：无运行时依赖，无需重部署）

依赖方向：谁引用 AMM、谁被 AMM 引用——

| 关系 | 核实结论 |
|---|---|
| AMMPool → FeeDistributor | AMMPool.swap 时调 `FeeDistributor.receiveFee`（依赖方向 AMM→FD，删 AMM 不影响 FD） |
| AMMPoolWithLiquidityReward → FD + ContributorReward | 该变体合约**全仓零引用**（无脚本/测试/前端使用），属 AMM 家族死代码，一并删除 |
| FeeDistributor → AMM | 仅一处注释提及（已改述为 Settlement 口径），无代码依赖 |
| ContributorReward → AMM | **不调用**。流动性计分走 `submitLiquidityProof` 签名证明通道（nodeType=3，权重 20），与 AMMPool 无运行时耦合，未动 |
| Governance → AMM | 仅测试 setUp 中部署并 setGovernance（其 3 个测试的提案目标是 Settlement/FeeDistributor），移除 setUp 两行，测试本体不动 |
| Settlement / Vault → AMM | 零引用 |
| 前端 → AMM | App.tsx 内联的 Swap/加流动性 UI；`LiquidityPoolInfo`（数据区读池）；chains.ts 各链 `ammPool` 字段；config 的 AMM 地址/ABI 常量；utils 缓存键 |
| 节点 → AMM | `internal/chain/fetcher.go` 的 `FetchSwapTrades` 等**零调用方**（死代码）；config 的 `amm_pool` 字段 |

**结论：其余合约运行时不调用 AMM，本轮不需要重新部署**（与简预期一致，
为核实结论而非假设）。

### A.2 下线清单

- 合约：`src/AMMPool.sol`、`src/AMMPoolWithLiquidityReward.sol`、
  `test/AMMPool.t.sol` 删除；`Governance.t.sol` setUp 去 AMM；
  `Deploy.s.sol` 删除 AMM 分支（`runWithAmmAndMocks`→`runWithMocks`、
  `runRedeploySettlementAndAmmPool`→`runRedeploySettlement`），活文档
  （contracts/README、DEPLOY-LOCAL、DEPLOY-SEPOLIA）同步新函数名；
  历史部署记录（docs/*-deployment-*.md）**未改写**——它们记录当时实际
  执行过的部署，改史即造假。
- 节点：`internal/chain/fetcher.go` 整包删除（唯一文件、零引用）；
  `amm_pool` 配置字段从 config 与三份示例配置移除。
- 前端：导航 **六分区 → 五分区**（交易/资产/跨链桥/治理与贡献/数据），
  「兑换」入口删除，旧 `?tab=swap` 链接落到交易页；App.tsx 的 Swap/
  AddLiquidity 状态、处理函数与 JSX 全删；数据区 `LiquidityPoolInfo`
  删除（**贡献奖励池 `RewardPoolInfo` 保留**）；页脚合约地址 AMM 行、
  chains.ts `ammPool` 字段（8 条链条目）、config 的 AMM 常量、utils 的
  储备/兑换缓存键、App.css 的 `.swap-*` 样式一并清。
- 文案：按立规矩同步清理——不再有任何指向兑换/流动性池的用户可见文字
  （useTokenPrice 里一处注释顺带改述）；README 功能表同步。

### A.3 测试基线变化

- forge：100 → **99**（仅删 AMMPool.t.sol 的 1 个用例文件/1 例；
  Governance 测试 3 例保留且全绿）。
- npm：78 → **78**（测试在逻辑层，chains 地址断言不受 AMM 字段移除影响）。
- go：基线不变（删除的是零引用死代码）。

### A.4 遗留待拍板

贡献奖励「流动性 20%」权重：AMM 下线后失去原对象，**本轮未擅自改**。
再分配候选见 Part C 设计文档 §7（A 金库存入 / B 拆分 / C 盘口挂单口径 /
D 并入撮合），与金库档位一并等 Ren 拍板。

---

## Part B — 市价单（设计 `docs/market-orders.md`）

### B.1 设计成立性（按代码核实）

首选设计成立，**未换方案**：EIP-712 签名结构零改动、不重部署。
市价单 = 签名的限价单（price = 保护价）+ 未签名执行指令
`execType: "market"`（`storage.Order` 的 JSON 字段，随 API 与 gossip 传播，
不进签名、不入库 schema）。安全性论证（文档 §1）：指令未签名，但它只能
影响订单自身的执行方式，且一切成交被签名保护价封顶——篡改的最坏结果是
该订单以其自签价格立即成交、或退化为以保护价挂簿的限价单，不构成对他人
订单的伪造面。

核实中得到的关键事实：
- 生产路径的 HTTP API 只验签 + gossip 发布，本地接单处理在
  `cmd/node.processOrderLocally`——IOC 分支落在这里，与限价路径同构；
- `match.Engine.Match` 本就不把 taker 入簿（入簿是 `AddOrder` 的职责），
  IOC = 不调 AddOrder 直接 Match，语义天然；
- Settlement 对市价成交**无需改动**：fill 与限价成交同构（累计量校验、
  maker 价改善均为既有行为），anvil E2E 复证；
- **锁定释放的硬约束**（由 Vault 接口形状推导）：`releaseOrderLock` 释放
  全部剩余量，而成交消费异步逐笔发生——提前释放会使已成交未结算部分
  revert。故：零成交立即全额释放；有成交异步轮询 `orderLocks.remaining`，
  待降至「应剩量」（锁定义务 − Σfill.AmountOut，**含未成交余量与买单价格
  改善差额两个来源**）时精确释放；超时记日志，订单到期
  `releaseExpiredOrderLock` 为硬兜底。实现中一度漏掉价格改善来源、经
  复核修正（提交 `833770a`）——全额成交的买单同样会留余量。
- 既有状态如实记录：`settlement.SubmitTrade` 在生产代码中尚无调用方
  （结算提交目前由库/E2E 驱动），此为既有架构状态，非本轮引入。

### B.2 实现

- 节点：`storage.Order.ExecType` + `IsMarketOrder()`；撮合
  `ExecuteMarketOrder`（不入簿逐档、保护价止步、返回成交/余量）与
  `HasOppositeLiquidity`；API 校验 execType 合法性 + 市价单空盘口同步
  400 拒绝（明确文案）；cmd/node 市价专有路径（按保护价落锁 → IOC →
  最终状态落库 filled/cancelled → 余量释放）；settlement 包
  `ReleaseRemainderAfterSettlement` 等待-释放助手。
- 前端：下单面板订单类型成真功能；市价模式 = 滑点容忍（默认 1%）→
  保护价自动推导 + 逐档预估均价/可成交量 + 空盘口/深度不足/保护价封顶
  提示；点击盘口切回限价带入价；nodeClient 错误带服务端响应体（拒绝
  原因可见）。纯逻辑在 `marketOrder.ts`。
- 说明文案随功能同轮上线（市价单怎么成交/保护价是什么/余量为何取消/
  锁定何时释放），在面板底部。

### B.3 测试与 E2E 证据

- Go：match 市价 6 例（逐档/部分余量不入簿/保护价止步/空盘口/卖向/过期）
  + api 预检 4 例（空盘口拒绝/有对手盘放行/非法 execType/限价不受影响），
  全绿。
- anvil E2E `TestAnvilMarketOrderE2E`（`scripts/anvil-e2e.sh` 已覆盖）：
  场景一 两档卖单（50@2.0、50@2.1）挂簿落锁，市价买 80（保护价 2.2）
  逐档成交 50@2.0 + 30@2.1，双边 1bp 费用断言精确到 wei；结算后 taker
  锁定剩价格改善余量 13 TKB（锁 176、实付 163），经等待-释放助手精确
  释放、读回锁定 0 / 可用 37 TKB；maker2 限价单未成交 20 TKA 锁定原样
  保留。场景二 保护价 2.05 止步（簿上 2.1 残档与 3.0 新档均不越）→
  零成交 → 全额锁定立即释放读回，maker 挂单与锁定不受影响。全过。

---

## Part C — 做市金库设计（`docs/market-maker-vault-design.md`，只设计）

要点：金库在本架构里就是普通大交易者（资金进 Vault、签名挂单、既有
结算），交易/结算层零改动；三档托管模型（1 运营方 EOA 全托管、最快；
2 合约金库 + 链上登记授权签名者、能交易不能提款；3 协议金库、最接近
HLP、工程量最大）逐档列了代价与风险；含份额记账（quote 计价 NAV、
冷静期防挤兑）、做市策略草案（价差/库存偏斜/刷新/再平衡）、风控表、
分阶段路线（P1 试点 → P2 正式 → P3 协议化）。

**需要 Ren 决定的一件事：先落哪一档**（1 / 2 / 3）；附带子问题：
流动性 20% 权重再分配候选 A/B/C/D（文档 §7），不阻塞主决定。

---

## Part D — 下单面板一键补存差额（Ren 追加，保留 Vault 模型）

- 动机：Ren 真机试用后明确不满「下单前还要专门去资产页存钱」，同时
  确认保留 Vault 结算模型（不改钱包直连）。
- 实现（`vaultTopUp.ts` 纯逻辑 + 面板接线，限价与市价两条路径共用）：
  签名前以**刚读回的链上值**复核本单义务（卖 = amountIn；买 = amountIn
  × 有效价格，市价按保护价），Vault 可用不足时面板直接显示差额，主按钮
  变「补存 X 并下单」：授权（如需，恰好差额）→ 存入恰好差额 → 回读可用
  确认到账 → 继续签名提交，全程不离面板。
- 失败处理：钱包余额连差额都不够 / 授权或存入被拒 / 交易失败 / 回读仍
  不足——四种都抛错停在签名前并给明确中文原因，**绝不带着不足余额继续
  签名**（节点落锁本来也会拒，但体验上必须在面板内闭环）。
- 资产页保持现状（主动管理）；面板说明同轮补齐：为何下单用 Vault 余额
  （结算与锁定都走 Vault）、补存会发生什么（可能两次钱包确认）、补存的
  钱随时可在资产页提取。
- 测试：`vaultTopUp.test.ts` 10 例（两侧义务口径、差额、充足不触发、
  授权跳过、步骤顺序、钱包不足、用户拒绝、交易失败、回读仍不足）。

---

## 门禁结果（本轮末）

- forge test：99/99（基线 100 − AMM 1 例，逐项如 A.3）。
- go build ./internal/... ./cmd/node/ OK；go test ./internal/... 与基线
  一致全绿（含新增 match/api 用例）。
- npm test：97/97（78 基线 + 市价 9 + 补存 10）。
- npm run build 成功；产物含双链现行 Settlement 地址
  （0x929ceb05… Sepolia / 0x3F9F29A6… Base Sepolia）。
- anvil E2E：`TestAnvilE2E` 与 `TestAnvilMarketOrderE2E` 双过。
- IA 同步：导航五分区（A.2）；`docs/hyperliquid-gap-roadmap.md` 头部加
  第十七轮决议注记；README 功能表同步；`docs/market-orders.md` 与
  `docs/market-maker-vault-design.md` 为本轮新增设计文档。

## 存疑/待办（非阻塞）

- FeeDisplay 20/30/50 硬编码与链上开发者分成 1% 不符：第十四、十五轮已
  标记，本轮未动，仍待 Ren 决定是否修。
- 市价单在多节点 gossip 视图下的入口预检是近似（文档已声明）：最坏
  零成交+取消，无错误成交风险；接单节点视图权威。
- 节点锁定为 opt-in（`chain.vault` 配置 + locker 密钥）：未启用锁定的
  节点接市价单时余量释放路径自动跳过，与限价单现状一致。
