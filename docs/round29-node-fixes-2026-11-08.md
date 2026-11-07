# 第二十九轮：节点问题修复轮（2026-11-08）

基线 main `ad99391`，分支 `round29-node-fixes`（本地提交，主聊天验收后统一推）。
触发：Ren 对第 27 轮验收报告的批示「有问题就修」——把第 26/27 轮验收挂账的
节点侧问题一次修清。范围严格限于下方六项；线上更新仅限双节点二进制与公开
API 验证，主网零操作，DVN 1-of-1 门禁不变。

## 0. 结论总表

| # | 问题 | 根因（一句） | 修复 | 线上验证 |
|---|------|------------|------|---------|
| 1 | 已结算订单仍显示 open | 撮合后才 InsertOrder 本单，覆盖了成交回写 | 先落库再撮合 | E2E 双链双腿 filled；存量 stale 行启动自愈 |
| 2 | 成交 amountOut 失真 ×1e18 | 引擎浮点 qty×price 漏除 1e18 | 整数口径派生（DeriveAmountOut） | E2E 口径断言通过；存量 10 行已订正 |
| 3 | /api/trades 返回 null、无 since | ListTrades 空结果 nil 切片；handler 不解析 since | 空切片 + since 参数（非法 400） | live 三态验证通过 |
| 4 | 提交器终态不对账 | 耗尽时最后一笔广播 hash 被丢弃 | hash 随失败留痕 + 清扫期回执对账 | 单测四分支覆盖（live 暂无存量样本） |
| 5 | ErrTxPending 拒单摩擦 | 落锁任何错误一律拒单，违背 lock.go 契约 | pending 视为在途接受 + 后台追踪 | E2E 一次提交成功，无重发 |
| 6 | NodeRewards.setSettlement 死路径 | 从无脚本调用该 setter | ConfigureNodeRewards 配对脚本 + 回读断言 | forge 复刻 revert/修复两案；live 待奖励启用时执行 |

## 1. 已结算订单仍显示 open（节点记账）

**根因**：`cmd/node/main.go` 的 `processOrderLocally`（限价路径）旧顺序是
落锁 → 引擎撮合 → 每笔成交 `recordTrade`（内含 `RecomputeOrderFill`，以成交
表为事实源回写双方订单的 `Filled`/`Status`，第 26 轮设立的唯一回写点）→
**最后才 `InsertOrder(order)` 本单**。`InsertOrder` 是 `INSERT OR REPLACE`，
写入的是入参订单的初始值（`filled=0`/`status=open`）——刚被回写好的 taker
腿成交量被原样覆盖。maker 腿若以挂单身份先行入簿则不受影响，故表现为
「一腿 filled、一腿恒 open」。

线上实证（修复前，Sepolia 库）：订单
`order_r27e2e-sepolia-1794073769_countersell`（其成交已 settled，tx
`0xaa65cf0b…c5c21`）库内 `filled=0`、`status=open`；其对手挂单腿
`…_vaultbuy` 则为 `filled=10000000000000000.000…`、`status=filled`。

**修复**：把 `InsertOrder(order)` 提到撮合之前（落锁成功之后）。先建行，
`RecomputeOrderFill` 的回写自然成为最终状态；落锁失败仍在上游拒单、不经
此处。市价路径本来就在执行后按执行结果统一落库，不受影响。启动恢复
`restoreBookOrder` 的重算回簿逻辑不变，继续作兜底。

**回归测试**（`node/cmd/node/main_test.go`，该目录首个测试文件）：

- `TestProcessOrderLocallyBothLegsFilled`：全额成交后 maker/taker 双腿均为
  `filled` 且 filled 量精确（旧代码下 taker 腿必为 open/0，此测试即锁根因）；
- `TestProcessOrderLocallyPartialFillConsistency`：部分成交时 maker 腿
  `partial` + 精确 filled、taker 腿 `filled`。

**线上验证**：重启后启动恢复把存量 stale 行自愈——countersell 现为
`filled=10000000000000000.000…`/`status=filled` 且不再回簿；双链 E2E
（§8）两腿订单均在成交后即刻呈 `filled`。

## 2. 成交记录 amountOut 失真 ×1e18

**根因**：`node/internal/match/engine.go` 的 Match 买/卖两分支都以浮点
`qty × price` 计算对手币数量，漏除 1e18。两个后果叠加：数量被放大 1e18
倍；`big.Float` 默认 64 位尾数装不下 BTC 量级价格（`7.569605e22`）与数量
的乘积，尾数被磨成乱码（如 `…1384911564645072896`）。落点：买分支的
`Trade.AmountOut`、卖分支的 `Trade.AmountIn`。**结算从未受影响**——
`settlement.TradeToFill` 恒按签名订单价格以整数重算（其注释早已注明该
历史不一致），链上成交额一直正确；失真只在记录/展示层（第 28 轮发现前端
把该原始值直接展示，是同一枚硬币的另一面）。

**修复**：新增 `tradeQuoteAmount(qty, price)`，按与签名订单统一公式逐位
一致的整数口径派生：`DeriveAmountOut(qtyInt, priceInt) = qty × price / 1e18`
（qty、price 均为整数值——最小单位数量与 1e18 定点价——整数派生精确无
舍入）。两分支统一改走此函数。

**回归测试**：`TestMatchAmountOutUsesCanonicalDerivation`
（`node/internal/match/engine_amountout_test.go`），以 BTC/USDT 量级
（0.01 BTC @ 75,696.05 → 对手币恰 756.9605 USDT）双向断言精确字符串。

**历史记录处理：一次性订正（已执行）**。脚本
`~/workspace/tools/bite100-node/fix_trade_amounts.py`（幂等、默认 dry-run）：
逐行以 `trunc(amount) × 签名价 // 1e18` 重算对手币字段——价格优先取成交
自带的 maker 签名订单 JSON（精确整数串），缺失时用 price 列（须为整数值
文本）；方向按 `token_in` 与交易对 token0/token1 判定。执行结果：Sepolia
7/7 行、Base 3/3 行全部订正，基础币字段经核对本就正确、未动。示例：
r27 BTC 成交 `amount_in: 756960500000000000001384911564645072896.000… →
756960500000000000000.000…`（756.9605 USDT）；Base ETH 成交 `→
22320694135800000000.000…`（22.3206941358 USDT）。订正前一致性备份在两
节点数据目录：`storage.db.bak-r29-20261108`。

## 3. GET /api/trades：[] 与 since

**改动**：

- `storage.ListTrades` 空结果返回空切片而非 nil（JSON 不再编码出 `null`；
  同步协议 SyncTrades 同样受益）；handler 再做一次 nil 兜底，双保险。
- 新增 `since` 查询参数（unix 秒）：缺省仍为最近 7 天（旧行为不变）；
  显式传入但非整数/负数 → **400**（不静默忽略，避免调用方误以为过滤
  已生效）。`until` 恒为当前时间。`pair`/`limit` 语义不变。

**使用说明（API 消费方）**：`GET /api/trades?pair=BTC/USDT&limit=50&since=1794000000`
返回自 since 起、按时间倒序的成交数组；无成交时返回 `[]`，消费方无需再
判 null（但保留判空无害）。

**前端兼容核查**：四个消费点（`OrderBookSection.tsx`、`TradeTabsPanel.tsx`、
`RecentTradesWidget.tsx`、`usePairStats.ts`）全部以
`Array.isArray(data) ? data : []` 消费，返回 `[]` 天然兼容，**前端零改动**，
npm 基线未动。

**测试与线上验证**：`TestHandleTradesEmptyArrayAndSince`
（`node/internal/api/server_trades_test.go`）覆盖空库 `[]`、缺省窗口、since
过滤、since 越界仍 `[]`、非法 since 400。线上：Base 空交易对
（DOGE/USDT）返回 `[]`；`since=9999999999` 返回 `[]`；`since=abc` 返回
400；`since=0` 正常返回全量。

## 4. 提交器终态对账缺失

**根因**：瞬时失败（已广播但回执未定论，`ErrTxPending`/`ErrTxDropped`）
重试到 `MaxAttempts`（12）耗尽时，`retryOrFail` 以空 hash 记终态失败——
最后一笔广播交易的 hash 在 `settleOnce` 里只打了一行日志就丢弃。此后
`process()` 永久跳过 failed、清扫只接管 pending/retry，这笔成交到底
结算了没有，永远无人能判定。

**修复**（`node/internal/settlement/submitter.go` + `storage/trades.go`）：

1. `retryOrFail` 透传最后一笔广播的 hash，耗尽时随失败记录保存；
   `settle_error` 保留 `attempts exhausted (N): …` 出处——该 hash 标记的
   是「命运未定的广播」，不是已确认失败的交易，对账据出处区分。
   **连带契约更新**：第 27 轮测试 `TestSubmitterPendingHashRetries` 中
   「失败记录不留 hash」的断言被 supersede（断言与注释已同步改写）：旧
   行为正是本问题根因；保护语义改由出处标记 + 下述对账维持（带 hash 的
   failed 行不被任何路径当作已落账：待结算扫描按状态排除、恢复逻辑只
   碰 submitting 行）。
2. 终态对账 `reconcileFailed` 随清扫运行（启动首轮 + 每 2 分钟周期）：
   输入集为新查询 `ListFailedTradesWithTxHash`（failed 且带 hash）；逐笔
   按回执（新接口 `TxReceiptChecker`，生产实现走 RPC）定论——
   - 已上链且成功 → 改判 `settled`（保留原 hash，note 记明对账改判）；
   - 已上链且 revert → 维持 failed，settle_error 追加 `[receipt-verified]`
     标记，后续清扫跳过、不再重复查同一回执；
   - 查无此交易（dropped）且出处为 attempts exhausted → 新方法
     `ResetFailedTradeForResubmit` 重置为 pending（清 hash 与尝试计数，
     note 留痕），由同轮清扫接管重提；重提先走 settleOnce 既有的链上
     filled 对账——若另有更早的广播其实已落账，会在对账处直接改判
     settled，绝不重复提交。其余出处的 failed+hash 查无回执属异常情形
     （确定性 revert 的记录必然见过回执），保持原样待人工处理。

**测试**：`internal/settlement/submitter_reconcile_test.go` 四个用例
（改判 settled / dropped 重提并最终 settled / revert 维持且只查一次 /
无 hash 与异常出处不动）+ `internal/storage/trades_reconcile_test.go`
（输入集口径与重置语义，含对 settled 行的误动防护）。

**已知残余竞态（如实记录）**：若最后一笔广播被回执判 revert、而更早一笔
广播其实已落账（要求早笔在整段等待窗口后、恰在次笔对账与上链之间的极
窄窗口才落账），对账会保守地维持 failed。链上累计上限保证不会重复结算，
该行可由人工按订单 filled 对账改判；概率极低，不为此扩大本轮范围。

**线上状态**：两链现存 failed 成交均无「attempts exhausted + 带 hash」
样本（第 26 轮两笔 Sepolia failed 无 hash 留痕，正是旧行为的产物；其
成交已由后续重复提交 settled，见第 26 轮记录），对账上线即为空转待命，
逻辑由单测锁定。

## 5. ErrTxPending 拒单摩擦

**根因**：`vaultLocker.lockForBookOrder` 对 `settlement.LockOrder` 的任何
错误一律上抛，`processOrderLocally`/`processMarketOrderLocally` 据此拒单。
但 LockOrder 内部等待上链超时、交易已广播未定论时返回 `ErrTxPending`，
lock.go 注释明写「调用方不得按失败处理」——调用方恰恰按失败处理了：链
拥堵时用户订单被拒，而那笔落锁交易稍后照常上链（锁已生效），用户被迫
在不知情下反复重发。

**修复**（`node/cmd/node/main.go`）：落锁结果四分类 `classifyLockErr`——

- 成功 → 入簿（不变）；
- `ErrTxPending` → **按在途接受入簿**，并起后台追踪 `trackPendingLock`：
  每 20 秒以 `LockOrder` 幂等重驱定论（其先查既有锁，锁已上链即成功
  返回；原交易后被丢弃则重驱即重新落锁），6 分钟未定论只记日志，锁定
  最终由结算端 Vault 消费校验与订单到期/撤单释放兜底；
- `ErrTxDropped` → 立即幂等重驱一次，其结果再按同一分类处置；
- 其余（余额不足、验签不过等确定性失败）→ 拒单（不变）。

限价与市价两条路径共用 `lockForBookOrder`，同轮一并生效。安全性：结算
时 Vault 强制消费锁定，未落锁的订单无法结算，不存在无锁成交；残余竞态
（成交在落锁确认前被提交结算）由提交器的链上 filled 对账 + 模拟 revert
分类兜底，与既有「maker 在途撤单」失败类同级，如实记录在此。

**测试**：`TestClassifyLockErr`（四分类含 `%w` 包装情形）。真实 pending
在 anvil 上不可复现（瞬时出块），故在途接受的行为由分类单测 + 本轮线上
E2E（双链订单一次提交成功、无重发）共同佐证。

## 6. NodeRewards.setSettlement 死路径

**暗坑**：`Settlement.settleTradesBatchWithGasSavings` 分配 gas 节省时调用
`NodeRewards.depositFounderReward`，其要求 `NodeRewards.settlement` 恰为
调用方。历史上**没有任何**部署/配置脚本部署或配置过 NodeRewards（脚本
目录零引用）；将来启用奖励时若只在 Settlement 侧
`setNodeRewards/setFounder/setUsdtToken`、漏掉 NodeRewards 侧这一步，
批量结算会在全部成交结算完成后的分配环节**整批 revert**。

**修复（配置接线，不动已部署合约、不重部署 Settlement）**：

- 新增 **`contracts/script/ConfigureNodeRewards.s.sol`**：单一入口一次设齐
  两侧指针（`NodeRewards.setSettlement` + `Settlement.setNodeRewards`，
  可选 `FOUNDER_ADDRESS`/`USDT_TOKEN_ADDRESS` 一并设），广播后**回读四项
  断言**，配对不全即整轮 revert，绝不留半接线状态。使用：设
  `PRIVATE_KEY`/`SETTLEMENT_ADDRESS`/`NODE_REWARDS_ADDRESS`（+可选两项）
  后 `forge script script/ConfigureNodeRewards.s.sol --rpc-url <RPC>` 先
  dry-run 核对、再加 `--broadcast`。
- `NodeRewards.setSettlement` 处补配对铁律注释，指向该脚本与证据测试。

**证据测试**（`contracts/test/NodeRewards.t.sol`，forge 新增 2 例）：
`test_BatchGasSavings_RevertsWhenNodeRewardsSettlementUnset`（漏设 → 整批
以 `NodeRewards: not settlement` revert 且成交回滚）与
`test_BatchGasSavings_SucceedsAfterPairing`（补齐配对 → 同批成功，创始人
积分 25、FeeDistributor 收到 25 USDT 口径金额）。

**线上状态**：两链 Settlement 的 `nodeRewards()` 现均为零地址、NodeRewards
尚未部署——奖励通道整体未启用，分配环节当前被合约守卫整体跳过，无
live 风险。本轮交付脚本 + 证据 + 文档步骤；真正执行（含 NodeRewards 的
部署与 founder/USDT 口径决定）属奖励启用动作，留待 Ren 拍板时一并走。

## 7. 门禁结果

- `go vet ./...` 干净；`go test ./...` 全绿（含本轮新增：cmd/node 3 例、
  api 1 例、match 1 例、settlement 对账 4 例 + 更新 1 例、storage 1 例）。
- forge：**133/133**（131 基线全过 + 本轮新增 NodeRewards 2 例）。
- 前端零改动，npm 未跑（基线不受影响；注：并行第 28 轮已把 main 的 npm
  基线推进到 194，本分支无前端 diff，合并无冲突面）。

## 8. 线上更新与验证

- 二进制：r29 worktree 以 `-buildvcs=false` 构建（55,866,328 字节）→
  `~/workspace/bite100-node/bin/p2p-node`；停双服务 → 换二进制 + §2 的
  存量订正 → 启双服务。本地与公开健康检查均 200。
- 看门狗加固：`~/workspace/tools/bite100-node/ensure.sh` 的缺失重建回退链
  （已删除的 r26/r22 worktree）改为只从主 checkout 构建并加
  `-buildvcs=false`；二进制存在时看门狗从不覆写。改后实跑 `STATUS=OK`。
- 双链公开 API 全环 E2E（脚本 `~/workspace/tools/bite100-node/e2e-r29.cjs`，
  maker 卖 1 TKA @2.0、taker 买 1 TKA @2.0）：

| 链 | 结算 tx | 双腿订单 | amountIn / amountOut |
|----|--------|---------|---------------------|
| Sepolia | `0x07dbcc3d913419b024aae749b07a45d0fa0329cf5a93a62ccafd6f60581f93ee` | 均 filled | `1.000…e18` / `2.000…e18`（精确） |
| Base Sepolia | `0xe514b228fb5aa595cf92b4ffe68d2eaf5a4daf8ba98d90c93fed0e2f19647958` | 均 filled | 同上（精确） |

## 9. 遗留与注意事项

- `node/cmd/node/main_test.go` 被 `node/.gitignore` 的宽泛 `node` 规则误伤
  （该目录此前无测试文件即源于此），提交时以 `git add -f` 纳入；.gitignore
  本身未动（不在本轮范围）。
- 第 4、5 项各自记录了一处极窄残余竞态（见正文），均有链上/提交器兜底，
  不为本轮范围外扩。
- 本分支基线为 `ad99391`；并行第 28 轮已使 main 推进至 `ba081af`（仅前端
  与其轮文档），合并预期无冲突。
