# 第 63 轮：桥加固（三个 P1）+ gas库 形态 A + 骑乘项

- 日期：2026-11-10。基线：main `f0d9bc7`。分支：`round63-bridge-gasvault`（worktree `~/workspace/bite100-r63`）。
- 规格：设计包 `~/workspace/research_notes/bit100-bridge-gasvault-design-2026-11-10/report.md`（§1 桥 P1 根因 / §2 编码器迁移硬门 / §4 gas库冻结口径 / §5 管理员清单 / §7 切分表）。
- **本轮只本地提交：不合并、不推送、不部署。** 链上动作仅限桥-4 硬门的只读探测（eth_call / getFee 对拍，Sepolia）。部署与真链实测在部署步执行（§12 清单）。
- 用词：中文一律「gas库」，合约名 GasVault。
- 提交序列：`8f00380` 桥-1 / `21a2466` 桥-2 / `36da897` 桥-3 / `b074855` 桥-4 / `3fae5d1` gas-1 / `c4ba8c1` 桥-2/3 收尾 / `0b8f9e6` gas-2 / `fc7d04d` 骑乘-1 / 本文档收口。

## 1. 桥-1：披露执行复验（P1-②）+ 措辞如实化

- 根因：披露校验只发生在计划期（`planDelivery`）；`executeDelivery` 不带 settings、不复验，披露升版后待决记录仍按旧披露执行。
- 修复：`executeDelivery(account, recordId, settings, deps)` 执行前按**当前**披露版本复验 `hasValidConfirmation`；不通过 → 状态机新迁移 `disclosure-invalidated`（pending-decision → suspended-disclosure，文案「披露已更新，请重新确认」），零链上动作。DeliveryRecords 重载时批量 `revalidatePendingDisclosures`。
- 三通道披露版本 1 → 2，失败文案如实化：删去「记回 Vault」的虚假承诺——跨链失败时资金留在桥侧，用户走桥的重试/人工中继路径，**不得重复发起**；refreshDelivery 的 LayerZero 失败 note 同步改实。
- P2-08 文档口径：`docs/gas-vault-design-2026-11-08.md` 写明 gas 对半收是**正常路径目标**，受单侧上限与参考价可用性约束，差额由 gas库 吸收，不作无条件承诺。
- 测试：状态机迁移、执行门拦截/放行、批量复验（并入 defaultBridge 套件）。

## 2. 桥-2：重复投递防护（P1-①）

- 根因：`executeDelivery` 先落 `initiating`、txHash 只在全程成功后才写；崩溃/断网后记录无对账出口，catch 把「可能已成功」的发送误标为可重试，三家消息桥均无 tradeId 幂等键。
- 意图凭证：DeliveryRecord 新增 `attemptCount / attemptId / initiatedTxPending / sendTxHash / withdrawTxHash / prefetchTrackingId / lastReconcile / lastReconcileAt`。执行时**先**落本次 attempt 凭证再发起；桥执行器钩子在**广播瞬间**回写 hash（每通道 `onSendTxHash`；CCIP 以 staticCall 预取 messageId 在发送前落盘；`withdrawFromVault` 增 `onTxHash`），不再等回执。
- 失败语义拆分：本次 attempt 无任何广播 = 第一方事实，编排器自己记 `missing`；已有 hash 被捕获 → 判定留给对账，不预设。
- `reconcileDelivery(account, recordId, deps)`：发送回执成功 → found（恢复追踪：LZ 从回执解析 guid（新增 `fetchLayerZeroGuidByTxHash`）/ CCIP 用预取 messageId / Wormhole 追踪 ID = txHash；记录转 in-flight，**不重发**）；回执 reverted → missing；节点不认识该 tx 且发起超过 1 小时（`RECONCILE_MISSING_AFTER_MS`）→ missing；仅提款凭据且提款回执终局 → missing（且提款成功时按链上事实把 `fundsLocation` 治愈为 `wallet`，使重试直达桥腿、不重复提款——`c4ba8c1` 补）；其余 → unknown（只落印章）。状态机：`retry` 额外要求 `lastReconcile === 'missing'`；`anomaly → initiated` 恢复边只许对账恢复使用。`retryDelivery` = 先对账 → 非 missing 拒绝 → retry 迁移 → 执行。前端重试按钮与启动重载都走对账。
- 遗留口径（诚实）：桥-2 之前版本留下的无 attemptId、无 hash 的 anomaly 记录，对账给 missing（旧代码是等回执才标失败，未广播过的发送不存在）；卡在 `initiating` 且无任何 hash 的记录对账只能给 unknown，留人工处理（见 §11）。

## 3. 桥-3：中继交付登记（P1-③）

- 根因：幂等只活在浏览器 localStorage，换设备/清缓存即丢。
- 动手前 D1 备份：`~/workspace/bite100-relay-d1-backup-2026-11-10-r63.json`（60 orders + 2 pairs；orders 较第 62 轮 78 条减少是中继到期清理的正常结果）。
- 中继：迁移 `relay/migrations/0003_deliveries.sql`（deliveries 表，主键 delivery_id）+ `relay/src/deliveries.ts`：
  - `POST /deliveries/claim`：原子条件 INSERT（骑第 62 轮块 D 模式）；阻断态 claimed/initiated/delivered；同 attempt 重复 claim 返回 200 duplicate；anomaly/closed 释放后可经条件 UPDATE 再 claim；接管仅当 `supersede=true` **且**原占位陈旧 ≥ `TAKEOVER_AFTER_SEC=1800` 秒、且以 attempt_id 条件 UPDATE 守卫，delivered 永不接管；冲突 → 409 + 现有行 JSON。
  - `POST /deliveries/report`：attempt_id 必须与登记一致，陈旧 attempt 的 report → 409；服务端迁移表（含 anomaly → initiated 的同 attempt 纠正报告）。
  - `GET /deliveries`：按 deliveryId 单查 / 按 account 列表。专用限流（`DELIVERY_POST_RATE_LIMIT_PER_MIN`，默认 120）。定时清理只删终态且超过 30 天的行，非终态占位永不自动删。
  - account 为自报（中继无鉴权，与 pairs.creator 同口径）——防线是状态机本身，不是身份。
- 前端 `registry.ts`（`createHttpRegistry` / `defaultRegistry`）：**claim 是闸门**（未配置/不可达/冲突 → 抛错 → executeDelivery 中止，fail-closed）；**report 是记账**（尽力而为，失败吞掉）。localStorage 降为展示缓存。executeDelivery 在 initiate 迁移**之前** claim（冲突时申请一次 supersede，中继按陈旧度裁决）；initiated/anomaly 后 report；reconcile 的 found/missing 判定也 report。attemptId 加随机后缀（`${id}#${n}.${rand}`），同浏览器多标签页同计数器不再伪装成同一 attempt。
- 测试：中继 workers 32 → **40**（+8），unit 52 不变；前端 defaultBridge 52 → **61**（+9，含登记客户端）。

## 4. 桥-4：编码器迁移（硬门实测）

证据脚本留 /tmp（ccip-gate / ccip-gate2 / lz-gate 等，只读探测，2026-11-10，Sepolia 经 publicnode）。

- **CCIP extraArgs → 官方 SDK**：`@chainlink/ccip-sdk@1.16.1` 的 `encodeExtraArgs`，经 **EVM 子路径** `@chainlink/ccip-sdk/dist/evm/extra-args.js` 引入（根入口会注册全部链族，其 Solana coder 在 jsdom 跨 realm 环境导入即抛错且膨胀打包体积；EVM 子模块无需注册）。参数 = GenericExtraArgsV3 全默认（gasLimit 0、finality 'finalized'、ccvs/executor/tokenReceiver 皆空）。产物与旧手拼常量 `'0xa69dd4aa' + '00'×15` **逐字节相同**（SDK 解码→重编码往返 + 单测双重证明）。手拼常量删除，`buildCcipExtraArgs()` 为唯一产生点。
- **硬门实测（链上只读）**：CCIP Router Sepolia `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59`（typeAndVersion "Router 1.2.0"），目标 Base Sepolia（selector 10344971235874465080），1 枚 wTKA：**getFee 新旧两路同为 240827312650467 wei**；**ccipSend staticCall 成功**，返回 messageId `0x41f22ede…fca8`（无私钥 eth_call + 状态覆写注入余额/授权槽位；槽位须以 AbiCoder 32 字节字编码计算，solidityPacked 地址打包算出的是错槽）。
- **硬门顺带挖出并修复的存量 bug**：前端 `CCIP_ROUTER_ABI` 的元组字段序是 (…, extraArgs, feeToken)，而官方 `Client.EVM2AnyMessage` 是 (…, **feeToken, extraArgs**)。实测：按前端旧 ABI 形状调 getFee **直接 revert**（require(false) 无数据），官方序返回正常报价——即基线 `f0d9bc7` 的前端 CCIP 报价/发送路径在 ABI 层本就是坏的（非本轮引入）。getFee 与 ccipSend 两处 ABI 已按官方序改正并注明。
- **Wormhole NTT 指令 → 官方 layout 序列化**：`@wormhole-foundation/sdk-definitions-ntt@8.0.1` 的 `Ntt.encodeTransceiverInstructions([{index: 0, payload: 空}])` = `0x010000`，与旧常量**逐字节相同**。该子包只把 sdk-base/sdk-definitions 声明为 peer 依赖，故显式补 `@wormhole-foundation/sdk-base@6.1.4` + `@wormhole-foundation/sdk-definitions@6.1.4` 入 package.json。十六进制转换手工拼字节（SDK 返回的跨 realm Uint8Array 会被 ethers hexlify 在 jsdom 拒绝）。整包 `@wormhole-foundation/sdk` 不装（为一个编码器拖全链体积，不值）。
- **LayerZero options —— 与设计包的偏离（证据驱动，不迁）**：设计要求迁 `@layerzerolabs/lz-v2-utilities` 的 Options 构造器，但其零选项产物是 type-3 容器 `'0x0003'`，实测与现行部署**不等价**：Sepolia CrossChainBridge `0x7a0eCbc2…3d50` 的 `quoteBridgeFee(TKA, 1e18, Base EID 40245, maker, '0x0003')` **revert**（未知自定义错误），而 `'0x'` 返回 nativeFee=104027936596558、lzTokenFee=0。迁了就会弄坏现在能用的 LZ 报价/发送路径。处置：三处散落的 `'0x'` 字面量收敛为单一导出常量 `LAYERZERO_OPTIONS_EMPTY = '0x'` 并在注释里钉全证据；lz-v2-utilities 探针装后已卸载（33 包移除）；Options 构造器留待将来真要引入执行器选项（行为变更）的轮次连同其真链测试一起上。**此偏离须经主会话裁决/复核确认。**
- 单测（bridgeExecutors.test.ts，5 例）钉死：CCIP 字节对等 + 解码字段 + buildCcipMessage 接线、LZ `'0x'` 证据钉、NTT 字节对等。

## 5. gas-1：GasVault 形态 A + CR 手工填分入口删除

### 5.1 GasVault（contracts/src/GasVault.sol，334 行）

- 形态：最小 OZ ERC-4626（OZ 5.6.1）；资产 = 所在链包装原生币（构造参数，`IWrappedNative` 接口）。`totalAssets()` = 包装资产余额 + 原生币余额（浮存与资产 1:1 同值，是同一份钱的两种形态）；`_withdraw` 在资产形态流动性不足时自动把原生币包回复付；`receive()` 收原生币（注资/解包回款）；存款走包装形态（前端一键打包，见 gas-2），v1 无 payable 存入包装函数。
- **短缺吸收（形态 A 的 Settlement 零改动承接）**：`absorbShortfall` 骑第 61 轮 ContributorReward 的计量人 EIP-712 attestation 模式（域 "Bit100 GasVault"/"1"；证明体 `ShortfallAttestation(claimId, beneficiary, amount, nonce, deadline)`；计量线编号 **4** 接第 61 轮编号体系；注册表同构 `measurers[metricType][address]`；防重放键 = (计量人， claimId, nonce)）。验签 → 池内封顶校验 → 付款。Settlement.sol **零改动**（`git diff f0d9bc7..HEAD -- contracts/src/Settlement.sol contracts/src/Vault.sol` = 0 行）。
- **库存换汇（Ren 2026-11-10 定版：水位触发 + 公开可触发）**：`triggerConversion` 无许可；放行条件全是合约公式：原生币余额 < 警戒线（`targetFloat × lowWatermarkBps / 10000`，出厂 4000 = 40%，设计公式）；token ≠ 资产；路由在白名单；单次估值 ≤ 上限；距上次换汇 ≥ 最小间隔（首次不挡）；估值 ≥ 粉尘门槛（约 $10 等值，参数化）；**熔断 = 合约自算 `max(调用者 minOut, 参考价估值 × 97%)`**，参考价经 `IGasPriceSource.referencePrice(token)`（1e18 单位 token 的资产计价）；执行 = forceApprove 精确额 → 路由 calldata → 按本合约资产余额增量实测到手，低于熔断整笔回滚 → 到手解包补回原生币浮存。事件 ConversionTriggered。
- `creditRecovered(token, amount, refPriceUsed)`：接口形状按设计 §4.3 冻结；形态 A 实现为纯记账（`creditedBook` 累加 + 事件），绑定构造时 immutable 的 settlement 地址；形态 A 部署传零地址 → 恒回滚 "settlement not set"。Settlement 不调用它（形态 B 是主网门决策）。
- 管理员面（§4.5 四法出厂分类）：Ownable（出厂 owner = 部署者，过渡 → 多签+时锁 → 最后 renounce，运维纪律）；onlyOwner 过渡期参数设置（setTargetFloat / setLowWatermarkBps / setAggregatorRouter（白名单）/ setPriceSource / setConversionParams，皆带事件）；Pausable **只停 deposit/mint**，withdraw/redeem/absorb/convert 永不暂停；**不存在任何资金搬运管理员入口（法①——transferOut/emergencyWithdraw 从未存在，测试以未知选择器回滚钉死）**。价源只许指向已准入价格面属部署纪律（合约层只认接口）。
- 测试（test/GasVault.t.sol，22 例，设计 §4.6 六组矩阵）：① 存取/份额记账（含浮存计入总资产、提款自动打包、首存 1:1）；② 水位门（警戒线含等号不放行、目标未设永不触发、线下放行且解包补浮存）；③ 97% 熔断（96% 回滚且库存不动、98% 放行、调用者 minOut 更严时绑定）；④ 上限/间隔/粉尘/白名单/token 守卫；⑤ 吸收证明（正常付款、防重放、未注册计量人、过期、超池封顶）；⑥ 管理员与暂停（暂停只挡存入、非 owner 设置全回滚、形态 A 记账口关闭、无资金搬运入口）。替身：MockWrappedNative / MockPriceSource / MockRouter（可调费率把到手推到熔断线两侧）。
- 部署脚本 `contracts/script/DeployGasVault.s.sol` 只交代码（本轮未执行）：参数全走环境变量，targetFloat 按设计公式（近 30 天日均结算笔数 × 平均计量 gas 成本 × 7 天 × 1.5）在部署时按当链实测填入。

### 5.2 ContributorReward 手工填分入口删除（零调用核实证据）

删除对象（皆 onlyOwner）：`setReputationScore`（原 L513）、`setReputationScores`（原 L520）、`setContributionScore`（原 L595）。

**仓库侧**：全仓 grep 仅两类命中——文档历史提及；合约树内唯一测试引用 `test/Round61.t.sol:417`（冻结后 setContributionScore 的 expectRevert，已随删调整；冻结防线由其上方证明路径回滚断言保留，Round61 套件测试数不减）。frontend / indexer / mcp / relay / scripts 零引用。

**链上侧**（cast logs，2026-11-10）：事件主题 ProofSubmitted `0x8777dfc1…e668` / ReputationScoreSet `0x1cec7922…6b65e` / MeasurerSet `0xacbe2f57…ad90e`。扫描范围覆盖 4 个 CR 实例全生命周期：现行对 Sepolia `0x42a1719A…BE19` / Base Sepolia `0xe39A77A9…f07` 与第一对（回滚）Sepolia `0x10226fD9…3967` / Base `0x154C9e02…2358`，Sepolia 自块 11950000、Base 自块 56750000（均早于第 61 轮部署）至当日链头——**三事件在 4 个实例上全部为 0 条**。

**推理链**：MeasurerSet = 0 ⇒ 从未注册过任何计量人 ⇒ 证明路径（要求签名者是注册计量人）从未可能成功；写分唯一出口 `_applyScore` 恒发 ProofSubmitted，其 = 0 ⇒ 任何路径都从未生效写过分 ⇒ `setContributionScore` 从未生效；ReputationScoreSet = 0 ⇒ `setReputationScore(s)` 从未生效。删除是纯代码面收缩，零行为变化。

**顺带记录（不在本轮删除范围）**：`updateReputationAndRecalculateWeightedScore`（onlyOwner）也能直写 reputationScore——它不在任务书的三函数清单内，本轮未动，列入管理员退出清单的后续项（§11）。

CR 删除后须重新部署接线——属部署步（§12），本轮只改代码 + 测试。

## 6. gas-2：前端 gas库页 + 索引器事件接入

- 前端：治理与贡献页新增第三个子页签「gas库」（`?tab=gas` 直达）。`GasVaultSection` 常驻使用说明四件套（干什么/前提/步骤/注意事项）；`chains.ts` 新增可选 `gasVault` 地址位——**未部署链不填**，页面如实显示「尚未部署开放」+ 防诈骗提醒（请勿向任何自称 gas库 的地址存款），不渲染存取动作、不伪造数据（组件测试钉死）。部署后自动点亮：总资产/原生币浮存/目标水位/警戒线/水位状态/我的份额与可取回额（全直读合约）；存入（包装原生币，含授权）、打包并存入（原生币一键 wrap → approve → deposit）、取回三条真实链路。
- 索引器：schema 新增 `GasVaultFlow` 统一资金流行（五类事件以 kind 区分，字段口径见 schema 注释）；纯映射在 `indexer/src/lib/gasvault.ts`，handler 为薄胶水（沿用现行结构与字段选择口径）；`config.yaml` 落 GasVault 合约定义——**链绑定（地址 + 起始块）留部署步按当轮文档补**（未部署无地址可绑；codegen 已验证未绑定合约可正常生成类型）。
- 索引器附带修复：`test/testindexer.test.ts` 夹具在第 62 轮换址后未跟（仍指 r47 Settlement 地址且合成块号低于 r62 起始块，simulate 被路由过滤）——基线（本轮改动 stash 后）实测同 3 失败，属既存失效、非本轮回归；已对齐 r62 现行地址/块号，索引器全套转绿。

## 7. 骑乘-1：nonce 分配器 Web Locks（兑现第 62 轮评审 P2）

- `allocateNonce` 的「读游标 → 修剪在途 → 扫描 → 写回」临界区整体包入 Web Locks（`navigator.locks.request`），锁名 `bit100:nonce-alloc:<chainId>:<address 小写>`，按（链，钱包）隔离；`fetchOrderNonce` 接线传入锁名。
- 特性检测不到（非安全上下文/旧浏览器/Node/Worker）→ 诚实降级直跑现行流程，**禁自制 localStorage 假锁**；跨设备/跨浏览器撞号仍由中继 409 在途守卫（第 62 轮块 D）+ 链上独占规则兜底。
- 锁管理器可注入（`AllocateNonceOptions.locks`）：并发测试用假 LockManager 落地——慢读词下两路并发分配得到不同 nonce 且临界区最大并发 = 1；无锁名 / `locks: null` 路径不调锁、照常分配。MCP 路径不动（其运行时无 navigator，自动直跑）。

## 8. 桥-2/3 收尾修正（c4ba8c1）

- `executeDelivery` 的 record 声明收窄为 `DeliveryRecord`（闭包内展开赋值过 tsc——vitest 不做类型检查，此问题由 gas-2 的全量 tsc 暴露）；删除未被读取的 `withdrawBroadcast` 记账（桥腿 missing 判定只取决于发送是否广播）。
- reconcile 提款落地时治愈 `fundsLocation='wallet'`（见 §2），新增对账测试一例（成功治愈 / 提款回滚不治愈双断言）。

## 9. 骑乘对照表（集成优先核验）

| 新组件 | 骑乘的既有件 |
|---|---|
| 中继交付登记 claim | 第 62 轮块 D 的原子条件 INSERT 模式（同一防重复投递防线） |
| 前端 registry 客户端 | 既有 `config/relay` 的 RELAY_URL 配置面 |
| 对账 reconcile | bridgeExecutors 既有状态面（LZ getBridgeStatus 族 / CCIP 预取 / 回执原语） |
| 披露复验 | 既有 `hasValidConfirmation` + 披露版本机制（零新协议） |
| CCIP extraArgs 编码 | 官方 `@chainlink/ccip-sdk`（EVM 子模块）；ethers 报价/发送/staticCall 预取保留 |
| Wormhole NTT 指令 | 官方 `@wormhole-foundation/sdk-definitions-ntt` layout 序列化 |
| LayerZero options | 不迁官方构造器（证据见 §4）；收敛为单一常量，等引入执行器选项的轮次再迁 |
| GasVault 份额账目 | OpenZeppelin ERC-4626 / ERC20 / Ownable / Pausable / ReentrancyGuard / SafeERC20 |
| GasVault 短缺吸收验签 | 第 61 轮 ContributorReward 计量人 EIP-712 attestation 模式（OZ EIP712 + ECDSA） |
| GasVault 换汇执行 | 白名单聚合器 calldata（LI.FI/1inch 类既有聚合面），合约只做熔断与记账胶水 |
| gas库前端页 | 既有治理页子页签结构 + config/chains 地址位 + utils 的 provider/signer 通路 |
| 索引器 GasVaultFlow | 既有 Envio 索引器结构（config/schema/handler/lib 四件套同构） |
| nonce Web Locks | 平台 Web Locks API（Baseline）；降级路径 = 现行分配流程 + 中继 409 兜底 |

## 10. 门禁实测（收口全量复跑，2026-11-10）

| 门禁 | 基线 | 本轮实测 | 判定 |
|---|---|---|---|
| forge | 223 | **245 / 245 全过**（+22 GasVault；CR 删除未掉数） | ✅ |
| 前端 vitest | 482 | **511 / 511 全过**（44 文件，+29） | ✅ |
| 前端 tsc + vite build | 过 | **tsc 干净 / build 成功** | ✅ |
| 中继 unit / workers | 52 / 32 | **52 / 40 全过**（+8 登记） | ✅ |
| MCP vitest + tsc | 89 | **89 / 89 不降 / tsc 干净**（本轮零改动） | ✅ |
| 索引器 vitest + tsc | 3 失败（既存夹具失效） | **16 过 / 2 跳过**（跳过 = 真实链 reconcile，既有设计）/ tsc 干净 | ✅ |

零触碰面：`contracts/src/Settlement.sol` 与 `contracts/src/Vault.sol` 相对基线 diff = **0 行**（gas-1 红线）；Order 结构体未动；MCP 目录零改动。

## 11. 诚实遗留

1. **LZ options 未迁**（§4）：与设计包字面要求偏离，证据在案（`'0x0003'` 在现行部署 quote 即 revert）。待主会话裁决确认；将来引入执行器选项时连同真链测试再迁。
2. **无 hash 的卡死 `initiating` 记录**：崩溃点恰在广播与钩子落盘之间时，对账只能给 unknown，留人工处理（本轮之前的存量同理）。概率窗口极小但不为零，不假称根除。
3. **中继登记的 account 是自报**：无鉴权中继的既有口径；登记防的是重复执行，不是身份冒认——冒认 account 只能占位/干扰该 account 自己的交付，不能动资金（资金动作全在用户钱包签名侧）。
4. **GasVault 参考价源的测试网形态**：`IGasPriceSource` 只认接口；测试网没有「已准入价格面」可直接指（Chainlink 是 USD 口径、DexScreener 不索引测试网）——部署步需为测试网部署一个如实标注的测试价源（或适配器），主网再接准入面。此项不解决，测试网换汇全链路实测做不完整（§12 已列）。
5. **CR 的 `updateReputationAndRecalculateWeightedScore`** 仍是 owner 直写信誉分的入口（不在本轮三函数清单内，未动）——管理员退出清单后续项。
6. **GasVault 部署参数未定**：targetFloat 公式已定版，但入参（日均结算笔数等）要在部署时按当链实测填，本轮脚本留空待填，不假称已定值。
7. 桥全流程真链实测（§10 清单）**本轮未做**——本地只完成 anvil/单元/集成与桥-4 的只读硬门探测；真链小额实测在部署步执行，不假称已实测。

## 12. 部署步动作清单（本轮不执行，合并推送后按序做）

1. **中继**：先导出新一份 D1 备份 → 应用迁移 `0003_deliveries.sql`（远程）→ 重新部署 relay Worker → 冒烟：claim/report/GET 三端点 + 一次冲突 409。
2. **GasVault 双链部署**：`DeployGasVault.s.sol` 按链跑（环境变量：WRAPPED_NATIVE = 当链 WETH、GASVAULT_TARGET_FLOAT 按公式实测填、GASVAULT_PRICE_SOURCE 见遗留 4、换汇限额三件套、GASVAULT_ROUTERS 白名单）；部署后读回核对（asset / targetFloat / lowWatermark = 40% / owner）；把地址填回前端 `chains.ts` 的 `gasVault` 位并发版；Envio 侧补 `config.yaml` 两链 GasVault 绑定（地址 + 部署块）并轮换端点。
3. **ContributorReward 重部署接线**（删入口后的新实例）：双链部署新 CR（无参构造，owner = 部署者）→ owner 调 `setGovernance(第 61 轮 Governance 地址)` → 读旧 CR 配置逐项核对（reserveBps / freeFlowBps / reputationThreshold / weighting 开关），与新实例默认值不一致的经其治理面补齐并读回 → 前端 `chains.ts` 的 contributorReward 双链换新址并发版 → 冒烟：新 CR 的 governance() 读回 = 现行 Governance、任一 submit*Proof 路径的行为与旧实例一致（计量人注册表旧实例本就为空，无迁移负担）。
4. **§10 测试网真小额全链路实測**（逐项打勾，不许抽测）：
   - LayerZero：wrap → approve → quote（`'0x'` 选项）→ send 小额 → 对端到账核对；故意中断一次重走对账恢复路径（found 不重发）。
   - CCIP：wrap → approve → getFee（新 ABI 序）→ staticCall 预取 messageId → send 小额 → 按预取 ID 追踪到账。
   - Wormhole：小额 send → 手动/自动中继口径按现行测试网实况记录（测试网无自动 relayer 的既有事实如实标注）。
   - GasVault（双链各一遍）：存入（含前端一键打包）→ fundFloat → 压低水位后由**另一账户**公开触发 triggerConversion（测试价源 + 测试路由/真实聚合器测试网可用者）→ 熔断拒绝一例（把 minOut 抬到熔断之上应回滚）→ absorbShortfall 凭测试计量人签名付款一例 → 取回全额。
   - 登记闸门真链一例：同 deliveryId 双端并发 claim，一端 409。
5. **Envio 轮换**：随上述推送/部署按现行轮换纪律执行（新端点 _meta 双链 isReady 核对后再更新 CONNECTOR 记录）。
6. **ChatGPT 复核**：按站规，合并推送后送审本轮并回交裁决结果。

## 14. 审查裁决与修复批（2026-11-10）

**审查**：ChatGPT 紧凑审查，对话 https://chatgpt.com/c/6af2ba78-22cc-83ee-9585-88c2b9d02f9a ，总评**有条件通过**。主聊天逐项裁决如下，修复批在分支 `round63-fix`（基线 main `9cfd024`）本地完成，未合并、未推送、未部署、未动链上。

**范围变更（Ren 2026-11-10 17:01，17:03 标为暂定工作方向）**：Ren 提出桥子系统整体删除——LayerZero/CCIP/Wormhole 三桥 + 默认桥编排 + 中继投递登记由后续删除轮整体移除，跨链只走 LI.FI 快速兑换。该方向目前为**暂定**，删除轮执行前须 Ren 最终确认，此前不做任何不可逆动作。第 1、2 项在范围变更到达前已经写完并提交，按指令保留提交（无害）；两条 P1 的风险即便不修，也随桥子系统在删除轮整体移除而消解，删除轮完成前测试网桥路径维持现状（测试币、无真实资金）。第 3、4 项与桥无关，是钱面，按原指令全额完成。

### 14.1 P1-1 对账 missing 判定收紧 —— 裁决：成立（已修，提交 `8e351d4`）

- `txKnownToNode` 改三态（`'known' | 'not-found' | 'error'`）：RPC 抛错/超时返回 `'error'`，绝不冒充查无此交易喂给「超 1 小时判 missing」规则。
- `reconcileDelivery`：无 attemptId 的旧版本遗留 anomaly 记录对账结论一律 `unknown`（人工处理），永不判 missing，旧的直判 missing 兼容分支删除；missing 只在健康查询明确 not-found 且记录超 1 小时时成立（发送 hash 与提款 hash 两路同口径）。
- 回归测试 +8（前端）：遗留 anomaly→unknown 且重试被拒 / txKnown 'error'+2h→unknown / 'known'→unknown / 'not-found'+超 1h→missing 正路 / 'not-found' 未满 1h→unknown / txKnownToNode 三态 3 例。

### 14.2 P1-2 中继占位释放收紧 —— 裁决：成立（已修，提交 `a1b4978` + 跟进 `d378672`）

- **迁移 0004**（`relay/migrations/0004_delivery_release_tightening.sql`；已应用的 0003 未动）：deliveries 表加 `last_reconcile`、`broadcast_evidence` 两列。注：0004 在范围变更到达前已创建并提交；投递登记表本身将随桥删除轮一并处理。
- anomaly 行再 claim 的前提 = 行内已落前端报备的对账结论 `missing`（report 载荷扩展 `reconcile` 并落行）；无结论或结论为 found/unknown 保持占用（409 `delivery_in_flight`）；closed 行不变。
- supersede 接管 claimed/initiated 行：保留陈旧 ≥1800s 条件，新增**零广播证据**要求——`send_tx_hash`/`tracking_id` 任一非空或 `broadcast_evidence=1` 即永不接管（JS 检查与 UPDATE 的 WHERE 双层同口径）。
- 前端：广播已发后报 anomaly 必带广播证据（发送 hash / 预取 trackingId / 显式 `broadcastEvidence` 标记，任一即可，只置位不清零）；未广播的失败报 `reconcile: 'missing'`；anomaly 对账得 missing 时同步把结论报回中继行以便再 claim。
- 回归测试：中继 workers +5（无结论/unknown 结论 anomaly 再 claim 被拒、missing 结论可再 claim 且字段清零；双发窗口——A 广播后报 anomaly 带发送 hash，B 的 claim 与 supersede 均 409 且行未动；带发送 hash 的陈旧 initiated 行永不被接管；零证据陈旧 claimed 行接管正路仍通；仅显式 broadcastEvidence 标记亦锁接管），前端 +4（汇报载荷三态：未广播→missing 结论、已广播→证据字段、anomaly 对账 missing→同步落行）。

### 14.3 GasVault P2 —— 裁决：部分成立，按三项收紧（已修，提交 `fff6851`）

- ① **授权清零**：`triggerConversion` 路由调用成功后 `forceApprove(router, 0)`，路由只许在本次调用内拉款，残额不留。
- ② **(router, selector) 允许表**：新增 `routerSelectors` 映射 + `setRouterSelector`（onlyOwner）+ `RouterSelectorSet` 事件；执行点在水位/间隔/熔断等既有检查之后、`forceApprove` 之前校验 calldata 前 4 字节，短于 4 字节或不在表内回滚（`"GasVault: selector not allowed"` / `"GasVault: calldata too short"`），既有回滚文案预期不受影响。
- ③ **价格时效**：`IGasPriceSource` 扩展 `priceUpdatedAt(token)`；GasVault 加 `maxPriceAge`（出厂 3600 秒，`setMaxPriceAge` onlyOwner + `MaxPriceAgeSet` 事件）；`triggerConversion` 取到参考价后校验未超龄，超龄回滚 `"GasVault: stale reference price"`。`absorbShortfall`（形态 A）不消费参考价，故无此时效面——审查原问及 absorb 路径，此为如实口径：该路径的价格风险不在喂价新鲜度，而在证明绑定的结算台账本身。
- 测试 22 → 27（+5）：只拉半款替身验证换汇后授权残额 = 0；未列 selector 回滚 + 短 calldata 回滚；路由进了白名单但未列任何 selector 时其 swap 亦回滚、补列后放行；价格超龄回滚、刷新后放行；maxPriceAge 出厂值与 owner 门。`MockPriceSource` 同步支持可调更新时间（`setUpdatedAt`）。

### 14.4 CR P2 旁路关闭 —— 裁决：成立（已修，提交 `b7f2188`；推翻 §11 遗留 5 的缓议——CR 本轮本来就要随部署步重部署，缓议的前提不成立）

- 整函数删除外部 onlyOwner 入口 `updateReputationAndRecalculateWeightedScore(address,uint256,string[])`：它绕过第 61 轮计量人签名直接写 `reputationScore` 并重算各周期加权总数；重算逻辑内联于该函数本身、无任何内部调用方，随函数一并删除。删除后 `reputationScore` 无写入方（恒 0；现行各配置 `reputationThreshold = 0`，行为不变），映射与 `ReputationScoreSet` 事件声明保留作接口兼容。
- **零调用核实证据**（2026-11-10，cast logs 实测）：全仓 grep 无任何调用方（合约/测试/前端/索引器/MCP 均无）；双链 4 个 CR 实例全生命周期 `ReputationScoreSet`（topic `0x1cec7922…6b65e`）事件全部 **0 条**——Sepolia 第一对 `0x10226fD9…3967` 自部署块 12101703、现行 `0x42a1719A…BE19` 自部署块 12102379 扫至链头 12103328；Base Sepolia 第一对 `0x154C9e02…2358` 与现行 `0xe39A77A9…f07` 自块 56750000（早于第 61 轮部署）扫至链头 56877967。
- 测试 +1：以原签名低层调用该选择器必须回滚且信誉分恒 0；既有 ContributorReward 11 例与 Round61（18）/Round61Fix（6）套件行为不回归。

### 14.5 编码 P3 —— 裁决：通过

审查认可本轮编码器处理，并明确背书 LZ options 的偏离（§4 实测 `'0x0003'` 构造在现行已部署桥 quote 上回滚，options 保持 `'0x'` 单常量）——与本轮文档口径一致，无动作。

### 14.6 Web Locks P2 —— 裁决：措辞项（扫描完成，无改动）

全仓扫描 nonce 分配器相关用户可见文案与注释（`nonceAllocator.ts`、`orderSigning.ts`、本文件 §7）：分配器头部已有如实边界段（Web Locks 只能缩小不能根除、中继 409 与链上位图兜底），未发现「保证不撞号」类过强表述，无行为与文案改动。

### 14.7 修复批门禁实测（2026-11-10，基线为第 63 轮收口数）

| 门禁 | 基线 | 修复批 | 增量 |
|---|---|---|---|
| forge | 245 | **251 全过** | +6（GasVault 5、CR 1） |
| 前端 vitest | 511 | **523 全过** | +12（P1-1 8、P1-2 4） |
| 前端 tsc / vite build | 过 | **过** | — |
| 中继 workers | 40 | **45 全过** | +5（P1-2） |
| 中继 unit | 52 | 52 | 0 |
| MCP | 89 | 89（零文件改动） | 0 |

`Settlement.sol` / `Vault.sol` 相对 main 零 diff（已核）。部署步（§12）不受本修复批影响，仍待主聊天后续执行；其中 CR 重部署将带上本批删除后的字节码，GasVault 首次部署即带上收紧后的调用面。

（完）
