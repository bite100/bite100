# 比特100（Bit100）与 Hyperliquid 差距分析与改进路线图

> 编写：2026-11-07（代码审计 + 构建验证 + Hyperliquid 公开资料研究后产出）
> 范围：本仓库 `contracts/`（Foundry/Solidity）、`node/`（Go + libp2p）、`frontend/`（React + wagmi），已部署 Sepolia 测试网。
> Hyperliquid 资料来源：其核心撮合引擎**闭源**，本文所有关于 Hyperliquid 的描述均来自公开来源——官方文档 docs.hyperliquid.xyz（HyperCore Overview / Order Book / Fees / Oracle / Liquidations / Protocol Vaults / Nonces and API Wallets 等页面，2026-11-07 查阅）与官方 GitHub 组织 github.com/hyperliquid-dex（`node` 仓库仅含部署指南与 GPG 签名的预编译二进制、无节点源码；`contracts` 仓库仅 Bridge2 等桥合约；Python SDK 为 MIT 开源）。不声称读过其核心源码。

---

## 0. 结论速览

- Bit100 的产品形态其实与 Hyperliquid **不同物种**：Hyperliquid 是自研 L1 + 全链上订单簿；Bit100 是「P2P 网络广播订单 + 各节点链下撮合 + 中继者调用 EVM 合约结算」的混合架构。值得看齐的不是它的链，而是它在**可验证性、签名规范、撮合确定性、费用分层**上的工程纪律。
- 审计中最严重的三个问题（详见 §2）：
  1. **结算与签名脱节**：链上 `Settlement` 根本不校验订单签名（自带的 `verifyOrderSignature` 是死代码，且其 EIP-712 域/结构与前端、节点实际使用的签名格式完全不一致，三方各一套）。结算金额与对手方仅由被授权的中继者断言，链上不可验证。
  2. **节点→链上结算回路未闭合**：Go 节点撮合出成交后，`internal/settlement/submit.go` 只是打日志的占位实现，没有真正的上链提交。
  3. **合约源码在 HEAD 上无法编译**（多处硬错误 + via_ir 栈溢出），已部署的 Sepolia 合约必然来自更早的源码版本，仓库处于「源码与线上不一致」状态。**本次已修复，见 §5。**
- 本次已落地第一个改进：修复合约构建 + 修复 Settlement 中继者信誉**死锁**（新中继者永远无法结算第一笔交易），并补测试。测试现状：合约 46/49 通过（余 3 个为 ContributorReward 的产品语义冲突，需拍板，见 §6）；前端 76/76 通过。

---

## 1. Bit100 现状速写（审计结论）

**订单生命周期**：前端用 EIP-712 签名订单（域 name="比特100"，结构体含 orderId/userAddress/tokenIn/tokenOut/amountIn/amountOut/price/timestamp/expiresAt，**无 nonce**）→ 通过浏览器 libp2p 或 Go 节点 API 发布 → GossipSub 广播、Kademlia DHT 发现 → 各节点在本地内存订单簿（价格-时间优先）独立撮合 → 共识模块（领导者提议 + BFT 投票）确认 → 中继者本应调用 `Settlement.settleTrade` 由 Vault 托管账本完成划转（实际上链环节为占位实现）。

**并行子系统**：AMM 池（恒定乘积，与订单簿无路由整合）；治理（活跃集 Merkle 投票 + 7 天投票期 + 2 天 Timelock + 冷却期）；贡献奖励（每两周一期，签名贡献证明，权重 撮合 40/存储 25/流动性 20/中继 15）；手续费分配 FeeDistributor（开发者自动占 1%）；节点注册/声誉/跨链桥（LayerZero）等外围模块。

**完成度判断**：功能广度很大（撮合、共识、AMM、治理、奖励、跨链、PWA/Electron），但**深度参差**：合约层曾整体不可编译；节点共识有明确 TODO（领导者心跳检测、提议合法性验证未实现）；AMM 无 LP 份额凭证（见 §2.4）；前端与节点的签名约定靠三份代码各自维护、已经漂移。

---

## 2. 逐项对照

### 2.1 订单簿模型

| | Bit100 | Hyperliquid（公开文档） |
|---|---|---|
| 存放位置 | 各节点内存（链下），无全局一致视图 | 链上状态（HyperCore），全网一致 |
| 价格/数量规范 | `float64` 价格、原始整数金额混用；无 tick/lot 概念 | 价格与数量均为 tick size / lot size 的整数倍，链上强制校验 |
| 订单类型 | 限价单 + 过期时间 | GTC/IOC/ALO 等完整类型集、TP/SL |

差距：**中**。链下订单簿对测试网项目是合理取舍；但浮点价格与无 tick 规范会带来跨节点撮合结果不一致——这是确定性问题，不是性能问题，应修。

### 2.2 撮合

| | Bit100 | Hyperliquid |
|---|---|---|
| 规则 | 价格-时间优先（与 HL 一致） | 价格-时间优先 |
| 一致性 | 每节点独立撮合 + 领导者提议投票确认；提议合法性验证是 TODO，领导者可提议未经验证的成交 | 共识层统一排序：一个区块内语义顺序为「非订单动作 → 撤单 → GTC/IOC 订单」，全网同一结果 |
| 保证金检查 | 无（现货托管模式，Vault 余额即上限） | 开仓时与撮合时对挂单方各检查一次保证金 |

差距：**中**。价格-时间优先已经对齐；差在「撮合结果如何被所有人认可」——Bit100 目前靠未完工的共识投票，且订单簿满 1 万单时静默丢弃最老订单（前端/节点两侧都有），无事件无通知。

### 2.3 结算（差距最大的一项）

| | Bit100 | Hyperliquid |
|---|---|---|
| 结算依据 | 中继者断言的 (maker, taker, 金额)；链上不验订单签名；批量结算变体连 nonce 都不消耗，可被授权中继者重放 | 订单本身即链上交易，签名、nonce、防重放由协议层强制（其 API 钱包体系：每个签名者保存最高 100 个已用 nonce，新交易 nonce 须大于其中最小值且未用过，时间窗 (T-2d, T+1d)） |
| 签名规范 | **三套互不一致**：前端+Go 节点一套（域"比特100"，无 nonce）；`Settlement.verifyOrderSignature` 另一套（域"P2P Exchange"，含 nonce，且从未被调用）；节点的买卖方向分支代码实际相同（历史遗留） | 单一规范，SDK/文档/实现严格同步 |
| 托管 | Vault 合约托管，仅 Settlement 可划转（这一点设计是对的） | 链上原生账户体系 |

差距：**大，且是正确性问题**。修复方向见路线图 P0-2：统一 EIP-712 规范（域、结构体、含 nonce），让 `settleTrade` 真正验签并绑定 nonce，批量路径同样消耗 nonce。这是 Bit100 最该向 Hyperliquid 看齐的一点——**可验证结算**。

### 2.4 流动性 / AMM

| | Bit100 | Hyperliquid |
|---|---|---|
| 模型 | 独立 AMM 池（x*y=k），与订单簿并行、无整合 | 无 AMM 现货池；流动性来自订单簿做市商 + 协议金库 HLP |
| LP 机制 | **无 LP 份额**：添加流动性不校验池内比例，移除按自记金额而非份额比例，可被套利/误操作掏空比例；swap 无 deadline/minAmountOut 参数 | HLP：社区所有的协议金库，运行多策略做市、承担清算、向 Earn 供 USDC，存款锁定 4 天 |

差距：**中**（AMM 内部正确性）+ **不追**（HLP 级金库）。AMM 至少应补：LP 份额凭证、按比例增减、swap 滑点/截止参数。是否保留 AMM 与订单簿双轨，本身是产品决策（见 §6）。

### 2.5 费用

| | Bit100 | Hyperliquid |
|---|---|---|
| 费率 | 统一 feeBps=1（0.01%），maker/taker 不分；每代币可设上限 | 分层：按 14 天滚动加权交易量分档（现货量双倍计）；永续基础 taker 0.045%/maker 0.015%，现货 0.070%/0.040%；HYPE 质押最高 40% 折扣；maker 按做市份额返佣 −0.001%~−0.003% |
| 去向 | FeeDistributor 按份分配，开发者自动取 1% | 全部归社区（HLP、援助基金、部署者）；援助基金自动把费用换成 HYPE 并销毁 |

差距：**小–中**。Bit100 的 0.01% 单一费率对测试网够用；值得借鉴的是 **maker/taker 分化**（鼓励挂单做市）与费率和交易量挂钩的思路，成本都很低。

### 2.6 治理

Bit100 的治理（活跃集证明、>50% 活跃集通过、7 天投票 + 2 天 Timelock + 同目标冷却）在测试网项目里已属完整，甚至偏重。发现两个实现 bug：`Governance._vote` 的委托逻辑写反（设置委托人后，本人投票被记到被委托人名下）；`GovernanceExtended.execute()` 覆写时丢了基类的 `nonReentrant`。Hyperliquid 无代币治理可比（其治理即验证者集与协议参数），此项**不需看齐，修 bug 即可**。

### 2.7 风控 / 清算

| | Bit100 | Hyperliquid |
|---|---|---|
| 模式 | 现货 + Vault 托管，无杠杆 → 无清算需求 | 永续保证金体系：维持保证金 = 最大杠杆下初始保证金的 1/2；清算先走订单簿市价单，低于 2/3 维持保证金时由清算金库（HLP 一部分）兜底；大仓位部分清算 |
| 预言机 | 节点 pricefeed 模块（来源与聚合规则简单） | 验证者每 3 秒发布：每家验证者取 8 家交易所现货中间价的加权中位数（权重 3,2,2,1,1,1,1,1），再按质押加权取中位数；驱动资金费率与标记价格 |

差距：**现货阶段不适用**。只有决定上永续/杠杆时，预言机与清算才成为必修课——那是产品级分叉（§6 待决策），不在本路线图默认范围内。

### 2.8 API 与前端体验

| | Bit100 | Hyperliquid |
|---|---|---|
| 接口 | 节点 REST + WebSocket；前端直连 libp2p 网络，无托管 API 层 | REST（info/exchange）+ WebSocket 订阅，延迟中位数 0.2s / p99 0.9s（同机房），主网约 20 万单/秒（瓶颈在执行不在共识） |
| 一致性风险 | 前端自己也跑一份撮合引擎（浏览器内），与节点实现双轨维护 | 单一实现（链） |

差距：**中**。前端构建与单测健康（76/76），问题在架构双轨：浏览器撮合引擎与 Go 节点撮合引擎必须永远行为一致，这正是签名漂移已经发生过的地方。建议明确「前端只做展示与签名，撮合以节点为准」或反之，收敛为单一事实源。

### 2.9 去中心化程度

Bit100 的叙事是 P2P 无服务器，但现实检查：GitHub Pages 托管前端、Fly.io 部署节点、结算依赖被授权的中继者白名单 + 合约 owner 权限、治理需要 owner 注入活跃集——**信任点比叙事多**。Hyperliquid 则是 PoS 验证者集运行的专用 L1（去中心化程度也常被讨论，但其状态一致性是协议级的）。对 Bit100 的实事求是结论：当前是「多节点协作 + 链上托管结算」的半去中心化形态，把信任点如实写进文档、并逐步用验签结算（P0-2）削减中继者信任，比追求叙事更重要。

---

## 3. 改进路线（按价值/成本排序）

### P0 — 正确性与可验证性（先做，每项都是小步可测）

1. **✅ 已完成（本次）：恢复合约可构建基线 + 修复中继者信誉死锁**——见 §5。
2. **统一订单签名规范并让结算验签**：以节点/前端现行格式为基础补 `nonce` 字段，三方（前端 TS、Go 节点、Settlement.sol）同
...[truncated 3880 chars]步更新（域分隔符须包含 chainId 与校验合约地址）；`settleTrade` 与三个批量入口在结算前校验 maker/taker 签名并消耗其 nonce（复用已有 `OrderNonceManager`）。参照 Hyperliquid 的「每签名者 nonce 窗口」思想防重放。完成后中继者从「可信断言者」降级为「无须信任的搬运工」。
3. **闭合节点→链上结算回路**：实现 `internal/settlement/submit.go` 的真实提交（用 `OrderNonceManager` + Vault/Settlement 的 ABI 绑定，先在本地 anvil 全链路测试，再上 Sepolia 手工验证一笔）。这是让系统真正"能跑"的关键一环。
4. **治理两个 bug**：`_vote` 委托方向写反；`GovernanceExtended.execute()` 恢复 `nonReentrant`。
5. **给 contracts 加 CI**（仓库已有 node/frontend 的 workflow，唯独合约没有——这正是合约层腐坏无人察觉的原因）：PR 触发 `forge build` + `forge test`。

### P1 — 一致性与体验

6. **撮合确定性**：价格改定点整数（或明确 tick 规范）；撮合在共识提议层补齐合法性验证（consensus.go 的 TODO：验签、订单有效性、领导者心跳与视图切换）。
7. **AMM 修正**：引入 LP 份额（按份额比例增减流动性）、swap 补 `minAmountOut`/`deadline` 参数；或评估与订单簿合并为单一流动性来源（二选一属产品决策，见 §6）。
8. ** maker/taker 费率分化**：如 maker 0 / taker 2 bps 起步，给挂单方激励；随后可加交易量分档（借鉴 Hyperliquid 的 14 天滚动量分档，简化为 2–3 档即可）。
9. **单一事实源**：前端撮合引擎与 Go 引擎二选一，另一侧只做展示/缓存；签名与撮合的共享逻辑以测试向量跨语言锁定（同一组订单在 TS/Go 两侧产生相同签名与相同成交序列）。

### P2 — 规模化（有真实用户量再说）

10. 节点订单簿满载策略：由静默丢单改为拒绝新单 + 事件上报；订单簿快照同步（storage 已有快照表结构预留）。
11. WebSocket 增量推送订单簿 diff，前端不再全量拉取。

### 明确不追（测试网个人项目不需要）

- **自研 L1 / HyperBFT 共识 / HyperEVM**：Hyperliquid 的性能来自专用链，但那是团队级基础设施投入；Bit100 用「P2P 撮合 + EVM 结算」已能验证产品想法，真要链上一致性应借成熟 L2，而非造链。
- **永续 + 保证金 + 清算全家桶**：见 §6 待决策项 2——是产品分叉，不是技术追赶项。
- **HLP 级协议金库做市**：需要真实资金与做市策略团队，测试网阶段无意义。
- **20 万单/秒级性能指标**：当前瓶颈是正确性与回路闭合，不是吞吐。

---

## 4. 构建基线（2026-11-07 本次验证与修复后）

| 模块 | 状态 |
|---|---|
| `contracts/`（Foundry） | ✅ `forge build` 通过；`forge test` **46/49 通过**（余 3 个见 §6，为产品语义冲突而非构建问题）。修复前：完全无法编译 |
| `frontend/` | ✅ `npm ci --legacy-peer-deps` 成功；`npm run build`（tsc + vite）通过；vitest **76/76 通过** |
| `node/`（Go） | ⚠️ 本次修复后除一个 stub 外全绿：修复前 `internal/storage` 缺失/多余 import 导致整树编译失败、撮合引擎含语法错误；修复后 `go build ./...` 仅剩自述为示例的 `cmd/reputation-updater` 无法构建（其目标合约方法不存在，见 §5），`go test ./...` 其余包（api/match/relay/reward/settlement/storage）全过。使用 Go 1.27.3（装于 `~/workspace/tools/go`；go.mod 要求 1.24）验证 |

工具链（装在 workspace 下，非系统级）：Foundry 1.9.0 于 `~/workspace/tools/foundry`，Go 1.27.3 于 `~/workspace/tools/go`，Node v24.22.1（VM 自带）。

---

## 5. 本次已落地的修复（第一个改进）

主题：**恢复全仓可构建基线 + 修复 Settlement 中继者信誉死锁**。

合约侧（`contracts/`）：
- `Settlement.sol` 事件 `TradeSettledWithGasReimburse` 有 4 个 indexed 参数（EVM 上限 3），去掉 `gasRecipient` 的 indexed——这是 HEAD 无法编译的硬错误之一。
- `verifyOrderSignature` 误标 `pure`（内部读 `block.chainid`），改为 `view`。
- `_splitSignature` 的裸 assembly 块加 `("memory-safe")` 标注：该块只按固定偏移读内存、本就符合 memory-safe 语义；缺标注时 via_ir 的 Yul 优化器会在本合约批量函数上误报 stack-too-deep——这是合约在钉死的 `via_ir=true` 配置下始终编译失败的真正元凶（排查中一度被"桩掉鉴权函数后编译通过"的假象误导，特此记录）。
- `GovernanceExtended.sol` 删除与基类重复声明的 `delegates` mapping（编译错误）。
- `mock/MockERC20.sol` 构造函数补第三个参数 `initialSupply`（与多数测试和部署脚本的既有假设一致）；`CrossChainBridge.t.sol` 三处调用点随之补参。
- 批量结算的重复逻辑抽取为内部函数（`_feesFor`/`_settleBatchItem`/`_batchLength`/`_tradeLeaf`/`_applyUserRebate`/`_distributeGasSavings`），语义逐行等价，仅为绕开 8 数组入口的栈深度与便于后续维护。
- **信誉死锁修复（行为修复，核心项）**：`minRelayerReputation` 默认 5000、新中继者初始分 0、成功结算仅 +1 → 白名单中继者永远无法结算第一笔。修复：中继者首次被授权（`setRelayer`/`setRelayerAllowed`）且从无信誉记录（`lastUpdateTime == 0`）时，初始化为中性分 5000（新增常量 `INITIAL_RELAYER_REPUTATION`）；已有记录（含被扣分者）绝不重置，防刷分。新增 2 个回归测试（初始化分值、51 次违规扣至 0 分且重新加白名单不复活、结算被拦截）。
- 测试对齐（不改合约语义，仅让测试跟上已记录的合约演进）：`Governance.t.sol` 执行前 warp 8 天 → 10 天（覆盖 7 天投票 + 2 天 Timelock）；`FeeDistributor.t.sol` 的 revert 文案对齐 `onlyOwnerOrGovernance` 的 "not auth"；`Settlement.t.sol` 的 settleTrade 调用补上合约新增的 maker/taker nonce 参数。

Go 节点侧（`node/`，均为机械性腐坏，不改行为）：
- `internal/storage/orderbook.go` 补 `time` import；`retention.go` 删未用的 `database/sql` import（整树编译失败的源头）。
- `internal/match/engine.go` 删除一处多余的 `}`（语法错误）与只写不读的 `insertIdx` 变量——**撮合引擎此前连编译都过不了，其单元测试从未真正运行过**；修复后 match 包测试通过。
- `internal/api/server.go` 限流器速率计算引用未定义的 `window`，改为结构体字段 `l.window`；删未用变量 `buf`。
- 未修：`cmd/reputation-updater`——其要调用的 `setReputationScores` 在 ContributorReward 合约中根本不存在，文件内注释亦自述为示例、真实调用被 TODO 注释掉；补完它属于新功能开发（需先给合约加方法并生成绑定），不属于构建修复，留待拍板。

---

## 6. 待决策项（需 Ren 拍板）

1. **ContributorReward 领取语义冲突**（当前 3 个失败测试的根源）：合约 `claimReward` 每次领取上限为奖励池 10%，但 `claimable()` 视图返回全额、前端按全额展示，用户需点约 9 次才能领完；且合约注释明确写了"已取消领取截止时间"，而测试仍按"周期结束 14 天后禁止领取"的旧设计断言。两个问题本质是产品规则未定：单次上限保留还是取消？截止时间恢复还是正式废弃？定了之后改单边即可对齐。
2. **是否上永续/杠杆**：一旦要做，预言机（多源加权中位数）、保证金、清算瀑布、资金费率全套才成为必需（对照 Hyperliquid §2.7）；现货阶段全部不适用。建议现阶段明确不上，先把现货的可验证结算做扎实。
3. **AMM 与订单簿双轨是否保留**：双轨在小体量下分散流动性；Hyperliquid 是纯订单簿 + 协议金库。若保留 AMM，需先补 LP 份额（P1-7）。
4. **部署形态**：长期停在 Sepolia，还是未来迁到成熟 L2 以借用其排序与安全？自研 L1 明确不在考虑内（见 §3「明确不追」）。

---

## 6. 第二轮进展（2026-11-07）

- **P0-2 ✅**：统一 EIP-712 签名规范（`docs/eip712-order-spec.md` 为唯一事实源：四字段域 + Order 含链上结算 nonce + amountOut 公式），前端/Go 节点/Settlement 合约三方对齐；`settleTrade` 与全部批量入口真实验签、按订单 digest 累计记账防超额重放、消耗 nonce。合约测试含伪造/篡改/重放/批量用例。
- **P0-3 ✅**：节点 `internal/settlement/submit.go` 已实现真实上链提交；本地 anvil 全链路验证通过（部署→签名→撮合→结算→链上断言+重放被拒），证据见 `docs/anvil-e2e-verification.md`。Sepolia 手工验证仍待后续（本轮按要求未碰线上）。
- **P0-5 ✅**：新增 `.github/workflows/contracts.yml`（forge build + forge test），另顺带 node/frontend 基础 CI。
- **ContributorReward 方案 A ✅**（Ren 2026-11-07 定案）：单次领取上限=奖池 10%（保留）、领取窗=周期结束后 90 天（恢复并由合约强制）、逾期未领经 `rolloverUnclaimed` 回流下一期；`claimable()` 改为单次可领额、新增 `claimableTotal()`，前端展示已对齐。合约测试 62/62 全绿。
- 基线更新：合约 62/62、前端 77/77、Go 节点 internal 包全绿（`cmd/reputation-updater` 示例 stub 的既有编译错误仍未处理）。

## 附：Hyperliquid 公开来源清单（2026-11-07 查阅）

- 官方文档 docs.hyperliquid.xyz（经官方 GitBook 镜像读取）：HyperCore Overview、Order Book、Fees、Oracle、Liquidations、Protocol Vaults、Nonces and API Wallets 各页面。
- 官方 GitHub 组织 github.com/hyperliquid-dex：`node`（仅部署指南 + 预编译二进制 + GPG 验证说明，无源码）、`contracts`（仅 Bridge2 等）、`hyperliquid-python-sdk`（MIT）。
- 说明：Hyperliquid 核心撮合与共识实现闭源，本文涉及其内部机制的表述均为官方文档的公开描述，未声称读过其源码。
