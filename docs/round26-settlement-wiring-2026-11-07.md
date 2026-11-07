# 第二十六轮记录：节点结算接线（2026-11-07 → 2026-11-08）

## 1. 背景与根因

此前守护进程的成交处理只做 `store.InsertTrade`，`settlement.SubmitTrade`
写好且有 anvil 测试，却在主程序里零调用方；`epoch.go` 注释里「供 relayer
批量结算」的 relayer 组件从未存在。撮合与结算之间断链：成交只存在于节点
本地账本，链上什么都没发生。2026-11-07 的第一笔公开 API 成交
（`order_1794059270976_firsttrade-order_1794057744727_z5pmteb7-1`，Sepolia）
撮合成功、落库成功，链上零动作——本轮补的就是这一环。

## 2. 实现

### 2.1 结算提交器（新增 `node/internal/settlement/submitter.go`）

单笔串行提交器：内存队列 + storage 状态机 + 链上对账。

- **状态机**（`trades.settle_status`，见 `db.go` 迁移 + `trades.go`）：
  `pending → submitting`（原子领取）`→ settled / retry / failed`。
  `submitting` 是进程崩溃的恢复点：重启时先重置为 `pending`，提交前逐笔
  链上对账。
- **幂等（三层）**：
  1. 本地状态机 + 内存队列按 `trade_id` 去重 + 工作协程串行提交（同一
     运营密钥的链上 nonce 天然有序，任一时刻至多一笔处于 `submitting`）；
     重复落库（gossip 回声等）走 upsert，不回滚结算状态与 `tx_hash`。
  2. 提交前链上对账：读 `Settlement.orderFilledIn/Out`（按订单 digest 的
     累计已结算量），与「本地 settled 成交的累计折算量 + 本笔折算量」比对；
     链上已覆盖本笔即判定已落账（广播后记账前崩溃的那一笔），标记 settled
     并跳过，绝不重复提交。前提：本节点是该 Settlement 的唯一结算提交方。
  3. 提交前 `eth_call` 模拟：必然 revert 的结算不花真实 gas，模拟失败即
     确定性终态。
- **失败分类**：确定性失败 → `failed` 终态（签名订单不可得、Fill 构造失败、
  任一订单已过期、模拟 revert、已广播但链上 revert）；瞬时失败 → `retry` +
  指数退避（默认 12 次、基数 10s、上限 5m）。失败结算的归责扣费
  （第二十一轮 `ChargeFailedSettlement`）不在此自动调用，与第二十一轮
  纪律一致：是否申报由运营策略决定，不由提交器擅自发起。
- **启动清扫 + 周期清扫**：启动时恢复遗留 `submitting`、首次清扫历史未结
  算成交并补交；随后每 2 分钟清扫兜底（经同步协议落库、未经 `Enqueue` 的
  成交也由此接管）。
- **接线**（`node/cmd/node/main.go`）：`recordTrade` 成为成交落库与结算
  提交的统一入口——限价撮合、市价执行、gossip 成交回调三条路径都经此处
  （先落库，再送提交器异步上链）。启用条件与挂单锁定同源：
  `chain.rpc_url`/`settlement` 已配置且运营私钥
  （`VAULT_LOCKER_PRIVATE_KEY`，与 locker 同一身份） 在场；缺失时只记
  日志、不阻断节点启动。签名订单缺失时按订单 ID 从 orders 表以
  `match.BuildSignedOrder` 重建（历史成交与 gossip 成交全靠这条路径）。

### 2.2 成交量回写与启动对账（E2E 中发现的缺口，见 §6）

撮合产生的 `Filled` 此前只存在于引擎内存：`processOrderLocally` 撮合的
是订单副本，撮合完只 `InsertOrder` 原单（`Filled="0"`）；gossip 成交更
只落成交不碰订单。于是已全额成交的订单在库里永远 `open`，节点重启恢复
时原样回簿、被重复撮合，产出链上必然 revert 的成交。本轮补齐：

- `storage.RecomputeOrderFill(orderID)`（`orders.go`）：按成交表重算某
  订单的已成交量并回写（`big.Rat` 精确十进制，18 位小数格式与引擎一致），
  状态按 `filled >= amount` 置 `filled`、否则 `partial`、无成交不碰。
  以成交表为事实源**重算而非累加**，重复调用/重复落库都不会多算；结算
  失败的成交同样占量（量一旦撮合即消耗，与结算状态无关）。已撤单的订单
  不碰。配套新增 `ListTradesByOrder`（不限结算状态）。
- `recordTrade` 每笔成交落库后对 maker/taker 双方订单各调一次重算。
- 启动恢复两路（`cmd/node` 的 `restoreBookOrder` 与 `match` 的
  `RestoreOrdersFromStore`）回簿前都先重算：已全额成交者跳过、不再回簿；
  部分成交者按剩余量回簿（引擎入簿口径：剩余量折进 `Amount`、`Filled`
  归零）。两路规则相同，任一独立调用都不得把死单接回盘口。
- `match.SignCancelOrder`（`signature.go`）：撤单签名的签名入口（此前
  只有验签 `VerifyCancelSignature`，脚本化撤单只能手写 EIP-712）。

## 3. 门禁

| 门禁 | 结果 |
|---|---|
| `go vet ./internal/... ./cmd/node/` | 通过（零输出） |
| `go test -count=1 ./internal/...` | 全绿（api/match/relay/reward/settlement/storage；config/metrics/p2p/sync 无测试文件） |
| `go test -race -count=1 ./internal/{settlement,storage,match}/` | 全绿 |
| `forge test`（`contracts/`，合约未动、基线复核） | **119/119 通过**（12 套件） |
| `go build ./cmd/node` | 通过（部署的即此产物） |

新增测试：`TestTradeSettleLifecycle` /
`TestInsertTradePreservesSettleState` /
`TestListTradesForSettlementPredicate`（暂停前已有）、
`TestRecomputeOrderFill`（部分→全额→重复落库不多算→不存在/已撤单）、
`TestRestoreOrdersFromStore_skipsFullyFilled`（死单跳过、部分单按剩余量
回簿）、`TestSignCancelOrder`（签名往返、换时间戳失效）。
`forge test` 会顺手改 `contracts/foundry.lock`（仅补 openzeppelin rev），
已还原，不在提交内。

## 4. 部署

- 二进制：`~/workspace/bite100-r26/node` 构建 →
  `~/workspace/bite100-node/bin/p2p-node`（旧二进制备份为
  `p2p-node.r22.bak`）；`md5` 与构建产物一致。
- 重启 `bite100-node-sepolia` 与 `bite100-node-base`，双节点 `active`，
  本地 `/api/health` 与公开 `https://node.aaxx123456.trade/api/health`、
  `https://node-base.aaxx123456.trade/api/health` 均为 `{"ok":true}`。
  `bite100-reversessh` 保持 `active`。
- `~/workspace/tools/bite100-node/ensure.sh` 已同步：二进制缺失时的重建
  回退源由 `bite100-r22` 改为优先 `bite100-r26`（VM 替换后重建的仍是
  本轮二进制）。配置与 systemd unit 未动。
- 部署窗口内节点另有两次启停（15:36:37、15:38:42 UTC，约 2 分钟间隔），
  非本轮操作，疑为并行第 25 轮在共享节点上的部署动作；15:45:06 部署
  r26c 后进程稳定运行至今（PID 73498，md5 已核对）。

## 5. 挂起成交补结算（2026-11-07 首笔成交）

- 成交：`order_1794059270976_firsttrade-order_1794057744727_z5pmteb7-1`，
  Sepolia，1 TKA @ 1 TKB（maker `0xE83D2b08…` 卖、taker `0x87ffF84e…` 买）。
- 结算交易：[`0x08fda7b0dee08829f7950607c25853da58ab776dc819fbda2dc14133ba2f09f3`](https://sepolia.etherscan.io/tx/0x08fda7b0dee08829f7950607c25853da58ab776dc819fbda2dc14133ba2f09f3)，
  区块 12084485，`status=1`，gas 1,071,560，提交方运营地址
  `0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e`。
- 验收逐项核对（结算前 → 结算后）：
  - `userNonces`：taker 1 → **2**、maker 1 → **2**（`usedNonces(·,1)=true`）。
  - Vault 余额：taker TKA 99.986255076 → 100.986155059839596（+0.999899983839596），
    TKB 400 → 399（−1）；maker TKA 399.999355504 → 398.999355504（−1），
    TKB 99.986255076 → 100.986155059839596（+0.999899983839596）。
    每方到账 = 1 − 手续费 0.0001（feeBps=1，即 0.01%）− gas 报销
    0.000000016160404（第二十一轮 50/50 分摊口径）。
  - 手续费：收据含 `TradeSettled` 事件（`feeAmount=2e14`，双边各 0.0001），
    TKA/TKB 各 0.0001 由 Settlement 转入 FeeDistributor
    `0x346DE29B7fEe95F44A5b5385e87182F031E8E1B5`（注意：部署文档里记的
    `0xB63a3D85…` 不是 Sepolia Settlement 指向的 FeeDistributor，
    以链上 `feeDistributor()` 读回为准）；FeeDistributor 留存 1%
    （`accumulated` TKA 0.019899 / TKB 0.029799，含此前成交累计），
    99% 转开发者 `0x047df18e…`。
  - 事件证据：收据含 `NonceUsed`×2（双方 nonce=1）、`TradeSettled`、
    `TradeSettledWithGasReimburse`、Vault 划转与 gas 报销事件；本地库该
    笔成交已记 `settled`、`tx_hash` 回填、尝试 1 次、无错误。

## 6. E2E 中发现的事故：陈旧订单簿重复撮合（已修复并复验）

第一次 Sepolia E2E（订单 `order_r26e2e-sepolia-1794064970_*`，nonce 2）
失败：两笔新单没有互相撮合，而是各吃到了 2026-11-07 首笔成交遗留的旧
单（库内仍为 `open`、`filled=0`，§2.2 的根因），产出两笔成交；提交器
模拟正确拒绝（`Settlement: fill exceeds signed order`），零 gas 浪费，
两笔成交记 `failed` 终态。修复（§2.2）部署后复验通过。事故期锁处理：

- 两笔失败 E2E 订单已撤单释锁：maker 锁定释放 tx
  `0xcff67322ff47a5df230d8799c7c0edfb11074a7e11f01ac55e416bc231bb1f2f`、
  taker 锁定释放 tx
  `0xacb2f3fb5219eabf3fb08eb40711b475b803c0c17ad196e7b0b57042b149c7a7`；
  撤单后 maker TKA 锁定 101 → 100、taker TKB 锁定 1 → 0。
- 旧单在修复后首次重启时被重算为 `filled`（旧单 `filled` 显示为 2，因
  事故成交也占量——按 §2.2 规则，量一旦撮合即消耗），不再回簿。
- 残留：maker TKA 锁定仍有 **100 为历史遗留**（早于本轮的测试订单锁定，
  未定位到具体订单摘要，本轮未擅自释放；到期后可用
  `releaseExpiredOrderLock` 兜底，留待后续清理）。

## 7. 双链全环 E2E 复验（公开 API 下单 → 撮合 → 链上结算）

E2E 工具：`node/cmd/e2e26-r26`（临时脚手架，提交前已移出 worktree；
源码留存 `~/workspace/tmp-build/e2e26-r26-src/main.go`，二进制
`~/workspace/tmp-build/e2e26-r26`）。它用仓库自身的 EIP-712 代码签名，
链上实时读 nonce，`POST /api/order` 到公开域名，轮询 `/api/trades`
等结算。测试钱包只用 `~/workspace/bite100-deployer/` 的 maker/taker，
未动 Ren 的钱包。

### 7.1 Sepolia（TKA/TKB，1 TKA @ 1.0）

- 订单：maker `order_r26e2e-sepolia-1794066867_maker`（卖）、taker
  `order_r26e2e-sepolia-1794066867_taker`（买），nonce 3。
- 落锁：maker tx `0xd5539a1e0e050092a0f5393f181bc5f92644a0f46cd6f48c160baf18188b550e`、
  taker tx `0xd51b779b3b10cd9c9344961247403884609ae45c6b96928ffacb3a0ea92bc3a6`。
- 成交：`order_r26e2e-sepolia-1794066867_taker-order_r26e2e-sepolia-1794066867_maker-1`。
- 结算：[`0xed1326f50aef6e470e51e66b0f108216e5fa0c1a5a0748aee99954835dd65640`](https://sepolia.etherscan.io/tx/0xed1326f50aef6e470e51e66b0f108216e5fa0c1a5a0748aee99954835dd65640)，
  区块 12084682，`status=1`，gas 1,072,008。
- 核对：双方 `userNonces` 3 → **4**；taker TKA +0.999899983826370、
  TKB −1，maker TKA −1、TKB +0.999899983826370；FeeDistributor
  `accumulated` TKA 0.019899 → 0.019998、TKB 0.029799 → 0.029898
  （各 +0.000099，即手续费 0.0001 的 99% 留存）。

### 7.2 Base Sepolia（TKA/TKB，1 TKA @ 1.0）

- 订单：maker `order_r26e2e-base-1794067167_maker`、taker
  `order_r26e2e-base-1794067167_taker`，nonce 2。
- 成交：`order_r26e2e-base-1794067167_taker-order_r26e2e-base-1794067167_maker-1`。
- 结算：[`0x3d54b3a1990118c6c39a246619949e224adbcbc3d5776efe0b2bef250b1eb5f2`](https://sepolia.basescan.org/tx/0x3d54b3a1990118c6c39a246619949e224adbcbc3d5776efe0b2bef250b1eb5f2)，
  区块 55726601，`status=1`，gas 437,568，`effectiveGasPrice` 6,000,000 wei。
- 核对：双方 `userNonces` 2 → **3**；taker TKA +0.997216398、TKB −1，
  maker TKA −1、TKB +0.997216398。到账 = 1 − 手续费 0.0001 − gas 报销
  0.002683602/方（Base 链 `ethPriceInQuote` 为测试网手设值，报销额按
  437,568 gas × 6e6 wei × ≈2000 折算，与第二十一轮公式一致）。

### 7.3 E2E 途中另一次落锁超时（已处理，非本轮回归）

第二次 Sepolia E2E 前，maker 落锁交易
`0x1c14a7bc996be9a68ada6253fb3ce3b0e88f81f1f64e81726e5603790ffb4cbd`
（legacy 定价 20 gwei）在 mempool 滞留约 3 分钟才上链（区块 12084662），
节点 `sendVaultTx` 等回执 3 分钟超时，误判落锁失败、拒绝订单——但锁
实际上链，造成 1 TKA 悬空锁定。已处理：taker 单撤单释锁
（tx `0xeaa8f7b308b5e3ffd1cf2e0f631ae24233d2ebfe9eff06b62942bd1a10fdd067`），
maker 悬空锁以运营 key 直接调 `releaseOrderLock` 释放
（tx `0x5f42b3e5751332083daa333d41a781107a3625a3f7ef8f618c5cdd575f115726`）；
验证 maker TKA 锁定回落至 100、taker TKB 锁定回落至 0、订单簿为空后
重跑 E2E（§7.1）通过。遗留问题：落锁/结算的发交易在 gas 波动时可能
「交易已上链、节点已超时放弃」，造成锁悬空或订单误拒；后续轮次宜给
`sendVaultTx` 加动态 gas 价与「超时后按 hash 查回执再定论」的逻辑，
本轮未动该路径（超出接线范围）。

## 8. 并行活动观察（第 25 轮在同一钱包/节点上）

- E2E 期间，第 25 轮执行方在同一测试钱包、同一 Settlement 上活动：
  其批量结算交易
  [`0xa86c0d364d25abb84a3fc996ac9617e90acfcd37268ffe18bbe60e076a18de81`](https://sepolia.etherscan.io/tx/0xa86c0d364d25abb84a3fc996ac9617e90acfcd37268ffe18bbe60e076a18de81)
  （Sepolia 区块 12084608，`settleTrade`，maker/taker 订单
  `order_1794065950986_limu5li88` / `order_1794065955748_8qbhprwzy`）
  消耗了双方 nonce 2——本轮 E2E 因此读到 nonce 3（工具每次链上实时读
  nonce，不受影响）。该笔成交经本节点撮合、由本节点提交器结算成功，
  本轮 E2E 之外的独立佐证。
- Base 节点库内另有一笔第 25 轮成交
  （`order_1794066231713_z99aloeo2-order_1794066225542_1o7jfuzml-1`，
  结算 tx `0x2524506fcad14f937388f5846aa913e06f5b1bcf8a758ee3e6042a27703cee5b`），
  亦由本节点提交器结算成功；其订单经 `RecomputeOrderFill` 记为 `filled`。

## 9. 已知限制

- 提交器前提：本节点是该 Settlement 的唯一结算提交方；若有外部提交方
  代结同一订单，链上对账口径会偏移（模拟与合约累计上限仍兜底）。
- 单笔提交，未做批量 epoch 结算（未来设想）。
- `failed` 终态的成交不再自动重试，需人工介入（查 `settle_error`、修
  数据问题后由运营决定是否手工结算或撤单释锁）。
- 落锁交易的回执超时误判问题（§7.3）未在本轮修。
- maker TKA 锁定残留历史 100（§6），待定位清理。
- FeeDistributor 地址以链上 `feeDistributor()` 为准；部署文档里的 Sepolia
  FD 地址（`0xB63a3D85…`）与链上指向不一致，文档待订正（非本轮文件，
  未改）。
- 跨链桥 DVN 1-of-1 的主网门禁不变；本轮零主网操作；未打印/提交任何私钥。

## 10. 使用说明（运营）

- **结算状态查看**：`GET /api/trades` 每笔成交带 `settleStatus`
 （`pending/submitting/settled/retry/failed`）与 `txHash`；库内
  `trades` 表同名字段为准。`settled` 且 `txHash` 非空即已上链。
- **新成交自动结算**：撮合落库后提交器自动提交，无需人工操作；启动
  时自动清扫历史未结算成交；周期每 2 分钟兜底。
- **结算失败处理**：先看日志 `[settle] trade=…` 与库内 `settle_error`。
  `retry` 会自动退避重试；`failed` 为终态不重试——常见原因：订单已过
  期、签名订单缺失、模拟 revert（如 §6 的超额成交）。修好数据问题后，
  如需手工补结算，用测试钱包直接调 `Settlement.settleTrade`（需双方签
  名订单与 Fill），或联系主聊天。
- **撤单与释锁**：前端撤单或 `POST /api/order/cancel`（EIP-712
  `CancelOrder` 签名）会释放该订单剩余锁定；锁定已被结算全部消费时释
  放会 revert，只记日志、不阻断撤单。**不要直接改库把订单置回 open**——
  启动恢复会按成交表重算，改状态瞒不过对账。
- **重启行为**：重启后订单簿按成交表重算回簿——已全额成交的订单不再出
  现，部分成交的只剩剩余量；未结算成交由提交器启动清扫补交（提交前先
  链上对账，不会重复提交）。
- **取消签名（脚本用）**：`match.SignCancelOrder(key, orderID,
  userAddress, timestamp)` 与节点验签配对；本轮 E2E 脚手架
  （`~/workspace/tmp-build/e2e26-r26-src/main.go`）含 `cancel` / `release`
  两种用法示例：`cancel` 走公开 API 撤单释锁；`release` 用于订单被拒未
  入库、但落锁交易已上链的悬空锁（以运营 key 直接调
  `Vault.releaseOrderLock`）。
- **监控要点**：节点日志关键字 `[settle]`（提交成功/失败/清扫）、
  `[storage] 恢复订单 … 已全额成交，跳过回簿`（重启对账）、`[lock]`
  （落锁/释锁）。提交器未启用时启动日志会明示原因（缺私钥或 settlement
  地址）。
