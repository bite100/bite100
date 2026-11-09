# 第四十六轮：网页端链上硬撤单（无节点化阶段 5 前置）

日期：2026-11-09。分支 `round46-ui-hard-cancel`（基点 main be1812b）。**零合约改动**（releaseOrderLock 早已在合约与前端 ABI 中，本轮只补 UI 调用）。

## 1. 读码结论（语义三问，带代码出处）

### ① 现行撤单入口清单（全部只走节点签名撤单）
| 入口 | 文件 | 处理器 |
|---|---|---|
| 交易台「当前挂单」页签（桌面+移动共用） | `frontend/src/components/dashboard/TradeTabsPanel.tsx` | `handleCancel`：`signCancelOrder` → `nodePost('/api/order/cancel')` |
| 完整订单簿「我的订单」 | `frontend/src/OrderBookSection.tsx` | `handleCancel`：同上 |
| 服务层 `cancelOrder(orderID, signer)` | `frontend/src/services/orderService.ts` | 同上；此前**无 UI 调用方**（本轮 HardCancelAction 的簿面 best-effort 移除首次用它） |
| 旧 P2P 通道 `publishCancel` | `frontend/src/p2p/orderPublisher.ts` | 无现行 UI 入口调用，不在本轮范围 |

缺口（阶段 4 裁定）：节点停机时以上路径全断，网页撤不了单，锁住的 Vault 余额只能等过期（`releaseExpiredOrderLock` 需过期后才可调）。

### ② 锁释放后还能不能被结算——不能（合约强制）
- `contracts/src/Settlement.sol` `_verifyFill → _accountFill` 对每笔成交无条件调用 `vault.consumeOrderLock(digest, …)`（四个结算入口全经此路径）。
- `contracts/src/Vault.sol` `consumeOrderLock` 首行 `require(lockRec.user != address(0), "Vault: order not locked")`：无锁记录即 revert，整个结算事务回滚。结算路径不存在「锁没了就动用可用余额」的兜底（`transferWithinVault/transferOut` 只在 consume 成功后执行）。
- `releaseOrderLock`（Vault.sol:228-233）删锁记录并扣回 `locked` 计数，余额立即可用。
- **结论**：锁一释放，该订单永远无法再成交；UI 文案「释放后这张订单无法再成交」与合约逐字对齐。

### ③ 中继订单簿无撤单/移除接口
`relay/src/index.ts` 路由只有 `POST /orders`、`GET /orders`、`GET /orderbook`、`GET /health`，外加定时 `DELETE … WHERE expires_at < ?` 的过期清理。没有签名撤单接口可接。故文案如实处理：中继簿记录留到过期清理，但锁已释放、无法成交（②支持此句）。

## 2. 实现（主块）

- **服务层** `frontend/src/services/hardCancel.ts`：`hardCancelOrderOnChain({order, chainId, signer})`——重算 digest → 读 `orderLocks`（不存在→返回 `not-locked` 不发交易；属他人→抛错）→ 发 `releaseOrderLock` → `tx.wait()` 等回执 → 回读 `orderLocks` 确认锁消失才报 `released`。任一步失败抛错，绝不假成功。合约以最小结构接口注入（单测假件 seam），缺省按 signer 用 ethers Contract 构造。
- **UI 组件** `frontend/src/components/HardCancelAction.tsx`：与签名「撤单」**并列**的第二个动作（不做自动降级：签名撤单免费、链上撤单要自付 gas，自动降级会在用户没预期时弹出付费交易确认；并列+各自标成本才是知情选择）。
  - 确认弹窗（Mantine Modal）：写明立即解锁这张单锁住的余额、钱包发交易、gas 自付、不可撤销；并写明簿面记录可能暂留（中继无撤单接口、等过期清理）但无法成交。
  - 成功后 best-effort 调既有 `cancelOrder` 移除节点簿面：失败不回滚链上结果，结果文案区分「链上已释放 / 簿面已同步移除 / 簿面移除未完成，随到期清理」。
  - 钱包未连接：确认按钮禁用并红字说明原因。
  - 移动端：弹窗单列 Stack，入口按钮与弹窗按钮触控高度 ≥44px，动作格 flex 换行不撑宽表格（无页面级横向滚动，自检通过）。
- **接入面**：
  - `TradeTabsPanel`：当前挂单行并列两动作。另外：节点拉单失败时「我的订单」**回退中继簿**（骑 dualread `createRelayBookAdapter`，按 trader 过滤），回退态显示来源说明且只给链上撤单——这是节点停机时链上撤单可达的前提。已知降级：中继簿只有未成交挂单，历史页签在回退态与挂单同源。
  - `OrderBookSection`：我的订单行并列两动作（该面节点宕机时显示缓存簿，行在即可撤）。
- **产品内说明同轮对齐**（与实现逐字一致）：TradeTabsPanel 当前挂单脚注、OrderBookSection 顶部说明、LimitOrderFormWidget 下单说明（桌面/移动两处）的撤单句，统一为「签名撤单不上链不付 gas；链上撤单钱包直接上链释放锁定、自付少量 gas、释放后无法再成交」。FeeDisplay 关于「已撤单致结算失败由发起者担 gas」一句不改：那是签名撤单与结算竞速的情形，仍然成立（链上撤单后结算必然 revert 且不产生该笔失败计费路径的语义变化不在本轮断言范围）。

## 3. 捎带块（第 45 轮 ChatGPT 复审裁定项）

- **P2-3 节点发单超时 + UNKNOWN 口径**：`nodeClient.nodePost` 每节点每次尝试补 15s 请求超时（`NODE_POST_TIMEOUT_MS`，骑 `AbortSignal.timeout`，逐节点计时、超时按既有 tryNodes 轮询语义）。广播 `OrderBroadcastOutcome` 新增 `nodeUnknown`：20s 期限到点且节点结果未落定时置位；三处下单路径（orderService.submitOrder、LimitOrderFormWidget、OrderBookSection）在双通道未接单且 `nodeUnknown` 时抛统一文案 `BROADCAST_NODE_UNKNOWN_MESSAGE`（「订单结果待确认……请勿立即重复下单，稍后到『当前挂单』确认」），不再断言失败/未接单；订单随后入簿按 digest/orderId 自然对齐（既有双读/去重口径）。配套测试：nodeClient 超时用例 1（压缩真实超时验证信号申请与 abort 传播；注：`AbortSignal.timeout` 内部计时不受 vitest 假计时器控制，故不用假计时器）+ 既有全等断言补 signal；广播 UNKNOWN 断言 2（挂死→在场、快速双失败→不在场）。
- **P1 证据测试**：dualread.test.ts 新增——同一真签名订单原文同时在节点簿+中继簿：`prepareCandidates` 候选 = 1（sources 双源）、`mergeBooks` 可成交 = 1、`toMatcherOrders` = 1、`matchTaker` 以 150 Token0 需求撮合只出一腿、成交封顶该单余量 100（若双源复制成两份会出两腿 150）。
- **P2-4 广播测试真签名化**：orderBroadcast.test.ts 删除 `./orderSigning` 的假 mock（原 signOrder 恒回 0xab 字节），订单原文改由既有测试钱包（Hardhat #0，与 dualread.test.ts 同夹具）经生产 `signOrder` 真实签名，A2 用例追加生产 `verifyOrderSignatureSignedData` 验签断言（两通道收到同一真单；checkExpiry 关，夹具时间戳固定、本条只验签名）。
- **P2-5（跳过，理由）**：LimitOrderFormWidget 组件级开关分支测试未做。该 widget 892 行、约 20 个模块依赖（p2p 广播、defaultBridge 设置/披露/估算、参考价 hook、Vault 补存读链、StandardConnect 等），驱动其下单分支需整套 mock 面；而开关解析口径已由第 45 轮 `config/matching.test.ts` 12 例钉住，组件内只是单个 `if (FRONTEND_MATCHING_ENABLED)` 消费点（其 false 分支即「不调用 executeFrontendMatch」）。为单个布尔消费点搭整套组件基建成本不成比例，按简报许可跳过；后续若该 widget 进组件测试基建，此条随之补。

## 4. 骑乘对照表（Ren 口径：通用件先盘既有，逐项点名）

| 本轮新逻辑 | 骑乘的既有件 |
|---|---|
| 链上撤单发交易 | 既有钱包签名者通路 `getSigner()`（App.tsx，ethers BrowserProvider）+ `new ethers.Contract(addr, ABI, signer)` + 方法调用——与 AssetsPage 存/提、MakerVaultPage 同一写法；**未用 wagmi 的 writeContract**：全仓现行写链路径均为此 ethers 模式（wagmi 只作钱包连接层存在于 walletConfig），混入第二套写链栈反而分裂口径 |
| 等回执 | ethers `tx.wait()`（AssetsPage/MakerVaultPage/Claim 组件同一原语） |
| 读 orderLocks（发前校验+发后回读） | 同一 ethers Contract 读方法（TradeTabsPanel 读 Vault 余额同一写法）；ABI 骑 `services/vaultAbi.ts` 的 `VAULT_LOCK_ABI`（合约自动生成子集） |
| 订单 digest 重算 | `services/dualread/digest.ts` 的 `buildSignedOrderData` + `computeOrderDigest`（与节点/中继/双读三方同口径，未写第二套摘要） |
| 簿面 best-effort 移除 | 既有 `orderService.cancelOrder`（签名撤单服务函数，此前无 UI 调用方，本轮复用） |
| 确认弹窗 | `@mantine/core` 的 `Modal`（应用既有 UI 库，main.tsx 已有 MantineProvider；全仓此前无弹窗组件，未手写浮层） |
| 中继簿回退（节点宕机时挂单来源） | `services/dualread/adapters.ts` 的 `createRelayBookAdapter`（双读既有适配器）；超时经其既有 `FetchFn` 注入点注入带超时的 fetch |
| nodePost 超时 / 中继拉簿超时 | 平台 `AbortSignal.timeout`（与第 45 轮 relayDualSend 同模式，特性检测同款） |
| 金额/价格格式化 | 调用面既有格式化（TradeTabsPanel 的 fmtPriceCell/fmtAmountCell、tradeFormat），组件只收 summary 字符串 |
| 错误呈现 | 既有 `utils.formatError` |
| 测试签名/验签 | 生产 `orderSigning.signOrder` / `orderVerification.verifyOrderSignatureSignedData` + 既有测试钱包夹具（Hardhat #0，dualread.test.ts 同款） |
| 测试撮合消费 | 生产 `matching/matcher.matchTaker` + `matching/fromEvaluated.toMatcherOrders` + dualread 既有夹具（signedRaw/book/state/snapshot） |

**手写的通用逻辑逐条交代**（均已查过现成件）：
- `hardCancel.ts` 的「读锁→属主校验→发交易→回读」编排：查过 wagmi（`useWriteContract`/`useWaitForTransactionReceipt` 是 React hook，服务层不可用且全仓写链不用它）、viem（仓内只在 dualread/chainState 作只读 transport 与 indexer，无写链助手）、既有服务层（settlementService 是结算提交、tokenOps 是 ERC20 授权，皆非 Vault 锁接口）——无现成「释放订单锁」助手可骑，本文件只做编排胶水，所有原语（签名者、Contract、wait、ABI、digest）全是既有件。
- TradeTabsPanel 里注入适配器的 timed fetch（约 8 行）：适配器缺省 fetch 无超时是第 45 轮已登记的产品项，本轮按其预留的 `FetchFn` 注入点在调用侧解决，未改适配器本体（其根治仍按 45 轮登记在后续轮）。
- `VaultLockContractLike` 最小结构接口：ethers Contract 的动态方法在 TS 下无静态类型，此接口只是既有 seam 写法（adapters 的 BookAdapter 同法），非第二套实现。

## 5. 验证

- 全量 vitest：**433/433 全过**（基线 425 + 新增 8：hardCancel 6、nodeClient 超时 1、dualread P1 1；另有既有断言按新行为更新：nodeClient fetch 参数补 signal、广播期限/双失败用例补 nodeUnknown 断言、orderBroadcast 去假 mock 改真签名）。
- `npm run build`（tsc -b + vite build）：通过。
- 定向：hardCancel 6/6、nodeClient 13/13、orderBroadcast 6/6、dualread 66/66、orderService 6/6。
- 零合约改动、零新依赖。

## 6. 未决 / 超范围（单列，未自行处理）

1. 节点簿的行在链上撤单后靠节点自身何时剔除，本轮未读节点服务端剔除逻辑；UI 文案只承诺「尽力同步移除（best-effort 签名撤单）/随到期清理」，未断言节点簿即时消失。
2. 中继簿在节点宕机回退态只含双发到中继的订单，节点独占期下的订单不在其中——文案已标「可能不全」。
3. 第 45 轮登记的 dualread 适配器缺省 fetch 无超时（产品根治项）仍在队列，本轮只在新调用点用注入点绕开，未动适配器本体。
