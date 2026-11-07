# 挂单余额锁定设计（第十五轮，2026-11-07）

> 状态：已实现并双链部署（2026-11-07），部署与 E2E 证据见 `docs/round15-deployment-2026-11-07.md`。

Ren 拍板：给挂单加 Vault 余额锁定，行为对标主流交易所——挂单即锁定、
撤单/成交释放。本文先行于实现，记录语义、授权面、不变量与偏离说明。

## 1. 问题（第十四轮核查实证）

订单是 EIP-712 签名消息：链下节点撮合，Settlement 结算时才从 Vault 拉
余额。Vault 此前只有单一余额映射、无锁定：用户挂单后可把 Vault 提空，
订单成交时结算必然失败（`Vault: insufficient balance`），对手方与中继
一起被拖下水；且没有任何机制保证一笔挂单背后有真实资金。

## 2. 语义（本轮实现）

### 2.1 锁定对象与量

- 签名订单按统一规范（docs/eip712-order-spec.md）是**交易对朝向**的：
  `tokenIn/tokenOut` 恒为 (Token0, Token1)、与买卖方向无关，方向只存在
  于节点订单簿（`storage.Order.Side`）。故一笔订单的付款义务按方向
  二选一，且只能是订单自带的两个量：卖方义务 = `(tokenIn, amountIn)`，
  买方义务 = `(tokenOut, amountOut)`（amountOut 已按签名公式
  amountIn × price / 1e18 派生，无需也不许另行折算）。
- 落锁时由节点（locker）给出方向标志 `payWithTokenIn`，Vault 在验签后
  **从订单本身派生**（token, amount），locker 无法传入任意金额。每笔
  订单至多一笔锁定，以订单的 EIP-712 摘要（`Settlement.orderDigest`，
  域绑定 chainId + Settlement 地址）为键。
- 结算消费同理按方向计：Settlement 把本笔成交折算到该订单的
  (addIn, addOut) 一并交给 Vault，Vault 按锁定记录的 token 取对应
  一侧的量消费——卖单消费 addIn、买单消费 addOut，与 `_settleOne`
  的实际扣款（maker 付 fill.tokenIn 侧、taker 付 fill.tokenOut 侧，
  折算到订单自身即上述两侧）恒等。
- Vault 新增：
  - `locked[user][token]`：聚合锁定额；
  - `orderLocks[digest] → {user, token, remaining, expiresAt}`：单笔
    订单的剩余锁定（部分成交按比例消耗、撤单释放余额的依据）。

### 2.2 生命周期

| 事件 | 动作 |
|---|---|
| 订单被节点接受进订单簿 | 节点（locker）调 `Vault.lockForOrder(signedOrder)`：Vault 向 Settlement 验签（`verifyOrderSignature`）+ 取摘要，校验未重复锁定、未过期、可用余额 ≥ amountIn 后落锁 |
| 部分成交（settleTrade 等任一结算入口） | Settlement 在既有 `_verifyFill` 内、与累计成交量记账同一步，对双方订单各调 `Vault.consumeOrderLock(digest, addIn)`（addIn = 该订单自身方向的本笔成交量）：`remaining -= addIn`、`locked -= addIn`；随后既有划转从余额扣款。整笔同事务，结算失败则消耗一并回滚 |
| 全部成交完 | `remaining == 0`，锁记录清除 |
| 撤单 | 节点（locker）或订单用户本人调 `releaseOrderLock(digest)`：释放全部 `remaining`（部分成交后即只剩未成交部分），节点监听 `OrderLockReleased` 事件同步下架订单 |
| 订单过期 | 任何人可调 `releaseExpiredOrderLock(digest)`（`block.timestamp > expiresAt` 后），防节点掉线把资金永久锁死 |
| 提取 | `withdraw` 增加闸门：`amount ≤ balances − locked`（即可用额），超额 revert `Vault: insufficient available balance` |
| 查询 | `availableBalance(user, token)`、`lockedBalance(user, token)` 供节点接单校验与前端展示 |

### 2.3 授权面（最小化，定死）

- `lockForOrder`：仅 **locker** 角色（`lockers` 映射，Vault owner 管理
  `setLocker`）。且光有角色不够——Vault 强制向 Settlement 验签，
  locker 只能为**真实存在、签名有效**的订单上锁，不能凭空锁任何人
  的钱。上锁时摘要由 Settlement 计算，locker 无法伪造键。
- `consumeOrderLock`：仅 **Settlement**（`onlySettlement`），与既有
  `transferWithinVault/transferOut` 同权限面。
- `releaseOrderLock`：locker 或**锁属用户本人**。用户释放自己的锁等价
  于撤单意图：锁释放后该订单再被撮合，结算会在消费锁定时因锁已清空
  而 revert，不会凭空成交；节点以事件为准下架，竞态窗口内对手方的
  成交失败与任何订单簿的撤单竞态同性质。
- `releaseExpiredOrderLock`：无权限（仅时间条件）。
- 测试网阶段 locker = 部署/运营身份（即节点提交结算的同一运营私钥）。
  **主网前必须换成领导者/BFT 授权的中继集合**（与 Settlement 的
  relayer 白名单同源治理），本文与部署记录均已标注。

### 2.4 不变量（写成 forge 测试）

1. 任一时刻 `locked[user][token] ≤ balances[user][token]`。
2. 同一订单摘要不得重复锁定（`orderLocks[digest]` 已存在即 revert）。
3. 释放量不超过该订单 `remaining`；释放/消费不得使聚合锁定为负。
4. 未锁定的订单结算必须 revert（消费锁定时无记录），且失败不改变
   `orderFilledIn/Out` 与 nonce（整事务回滚）。
5. 锁定额计入后，超可用额提取 revert；恰好提取全部可用额成功。
6. 部分成交按比例消耗：两次部分成交的消耗之和 = 总成交量；撤单只
   释放未成交部分。

## 3. 与目标语义的偏离（及理由）

- **锁定发生在「节点接受订单」的链上交易里，而非用户签名瞬间**：
  订单本质是链下签名，签名时无链上动作；由节点接单时以一笔 locker
  交易落锁是该架构下最早的可行时点。接单→落锁之间订单不进正式
  订单簿（节点先落锁成功才广播/撮合），故不存在「簿上有单、链上
  无锁」的窗口。这是架构允许的最接近实现。
- **AMM 路径不经订单锁定**：AMMPool 是独立资金池、不走 Vault 余额，
  与挂单无关，不在本轮范围。
- **锁定不收费用、不设超时惩罚**：过期自动可释放已覆盖资金安全；
  垃圾挂单的治理属节点信誉层（已有 relayer/订单信誉机制），不在
  Vault 层重复设防。

## 4. 节点侧流程（Go）

- 接单（API 收到签名订单后、进引擎前）：`AvailableBalance(user,
  tokenIn) ≥ amountIn` 校验 → `LockOrder` 落锁成功 → 才 `AddOrder`。
  校验与落锁在 `node/internal/settlement/lock.go` 实现（Vault ABI
  子集 + Settlement `orderDigest` 只读调用），API 层在启用链上锁定
  的配置下调用。本轮节点以运营私钥作 locker（同结算提交身份）。
- 撤单：API 撤单路径在同一配置下调 `ReleaseOrderLock(digest)`；
  摘要由订单经 Settlement `orderDigest` 读回（保证与合约同源）。
- 结算：无需节点额外动作——Settlement 结算时自动消费锁定；节点以
  `OrderLockConsumed/OrderLockReleased` 事件对账（事件定义已留，
  指标接入不在本轮范围）。

## 5. 前端口径

- 资产页与下单面板的余额拆「可用 / 锁定中」：可用 = Vault 余额 −
  锁定；下单可用额、百分比滑杆改按可用额计算。
- 说明文案同步锁定口径（Ren 规则：逻辑变更同轮写说明）：挂单即
  锁定对应余额、撤单释放、成交按比例消耗、提取只能提可用部分；
  第十四轮三处「提空导致结算失败」警告随之改为锁定口径。
