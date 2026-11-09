# 第四十七轮：合约永久撤单修复（撤单墓碑）+ 双链测试网重部署准备（2026-11-09）

> 状态：**已完成并上线**（第 48 轮文档纠正时回填）——已合入 main 并推送
> （合并提交 b5424b8、切换记录提交 bd48a16）；双链已按
> [round47-cutover-2026-11-09.md](round47-cutover-2026-11-09.md) 完成重部署
> 切换，第 47 轮栈为现行栈（Sepolia Vault 0x836cEFF0140aB66D8DD984ECb18765736BA121e9 /
> Settlement 0x5697F7B2178352eB391e29fc2c5681Dea864C1d9；Base Sepolia Vault
> 0x295F5529F5BfA4cA39290f395b1feF7EA637f5D3 / Settlement
> 0x1021C7116cCE59f9c85683d6f1b5aD2215795949），中继与索引器已重指新栈；
> 旧栈未动、可回滚。本文初版「未推送、未部署」的表述已被本状态取代。
> 裁定来源：Ren 2026-11-09 11:28「直接改合约吧」+「重部署」（选项②，取代同分钟选项①）。

## 1. 缺陷（第 46 轮 ChatGPT 复审 P1，主聊天对码复核成立）

第 46 轮上线时宣称「锁释放后该订单永远无法再成交」，只对了一半：

- 结算确实无条件经 `Vault.consumeOrderLock`，无锁记录必 revert——锁不存在时结不了；
- 但 `Vault.lockForOrder` 自第 30 轮起无许可（L2），守卫只有验签 / 未过期 / 未上锁 / 余额足，
  **没有已撤单检查**。`releaseOrderLock` 删掉 `orderLocks[digest]` 后，任何人拿
  公开渠道可见的签名单即可重新落锁，再按 maker 签名价、在累计上限内继续成交；
  即使不成交，资金也会被重新困到再次释放或订单过期。
- `lockTombstones` 是落锁时同写的归属记录（供失败单 gas 计量，
  `Settlement.chargeFailedSettlement` 在 Settlement.sol:1062 校验它），
  **不是**撤单标记，本轮不动其语义。

## 2. 合约修复（只动 Vault；Settlement 零改动）

只动 Vault 的论证：缺陷的根在落锁入口无已撤单检查、释放入口不留永久记录，
两者都在 Vault；Settlement 的累计成交上限与 nonce 独占未被击穿，无需配合改动。

`contracts/src/Vault.sol` 改动：

- 新增 `mapping(bytes32 => bool) public cancelledOrders`（撤单墓碑），与
  `lockTombstones` 严格分开；新增事件 `OrderCancelled(digest, user)`。
- `lockForOrder`：digest 算出后先 `require(!cancelledOrders[digest], "Vault: order cancelled")`
  （置于「已上锁」检查之前，保证已作废订单的报错口径明确）。
- `releaseOrderLock`：通过 locker-or-owner 鉴权后置位墓碑并 emit，再走既有
  `_releaseOrderLock` 释放余额。
- `consumeOrderLock`：锁定被成交**完全消耗**（remaining 归零删锁）时同样置位。
- `releaseExpiredOrderLock`：**不**置位。

### 边界定版（逐项）

| # | 边界 | 定版 | 理由 |
|---|---|---|---|
| ① | 部分成交后释放剩余锁 | 置位，余量永久作废 | 这正是撤单语义：释放 = 撤单，余量不得再被任何人重新落锁成交 |
| ② | 完全成交耗尽（consumeOrderLock 删锁） | 置位 | 累计上限本已挡超量成交，但不置位则任何人可无意义重锁、把 maker 余额困到释放/过期；置位后该 digest 彻底关闭。「cancelledOrders」语义在代码注释中写明为「该订单已永久关闭：撤单或完全成交」 |
| ③ | releaseExpiredOrderLock（已过期） | 不置位 | 过期检查（expiresAt）本身永久挡落锁，置位无额外收益；最小改动。前端以此区分呈现 expired-released 态 |
| ④ | locker 释放他人锁 | 同样置位 | locker 是受信运营角色（节点撤单路径即以 locker 身份释放，见 §5）；语义一致才可预期。信任边界（第 48 轮定性纠正）：第 47 轮前 locker 释放锁是**可恢复**的——单还能被重新落锁、继续成交；本轮置位后，locker 的一次释放变成**不可恢复的永久否决**：该单永久作废、任何人（包括订单主人）都无法挽回。因此本轮实际上**扩大了 locker 权力的后果**（原稿「不扩大权力、只是留下永久记录」的说法不准确，已纠正）：locker 名单的授予与撤销从此是高敏感操作。当前测试网 locker 只有部署者本人，无现实风险；**主网上线前，locker 集合的治理（谁能当、如何增删、多签与否）列入上线就绪清单前置条件**，未定版不得开主网 |

无 setter / 无清除路径：墓碑只能由上述两条路径置位，置位后无任何函数可清零
（测试 `test_Cancel_TombstoneCannotBeCleared` 覆盖）。

## 3. 依赖图与最小重部署集合

```
Settlement ──构造参数 vault 地址（无 setter，部署后不可改）──▶ Vault
Vault ──setSettlement（owner 可设）──▶ Settlement
MakerVault ──immutable tradingVault──▶ Vault
MakerVault ──immutable baseToken / ERC-4626 asset（构造）──▶ 标的/资产代币
Settlement ──feeDistributor（构造+setter）──▶ FeeDistributor（沿用旧实例）
```

Vault 换地址 ⇒ Settlement 的 vault 指针无法跟随、MakerVault 的 tradingVault
不可变 ⇒ **最小重部署集合 = Vault + Settlement + MakerVault 整套三件**，
与阶段 3 切换同构。部署脚本 `contracts/script/DeployStage3.s.sol` **零改动**
复用（它部署当前 `src/` 并从旧 Settlement 链上复制配置 1:1；新 Vault 源码
即含本轮修复）。切换语义同阶段 3：EIP-712 域绑定 Settlement 地址，换址即
换 digest——旧栈订单在新域验签必失败、全部作废；旧 Vault 的锁留在旧合约，
用户在旧 Vault 自行释放或等过期。老栈全程不动，作回滚。

dry-run 验证（2026-11-09，Sepolia fork 模拟，未广播）：脚本全程跑通，
旧 Settlement 配置复制与 FeeDistributor 一致性断言通过，模拟估算 gas
约 79.3M（fork 口径 1 gwei 上限估算，实际按阶段 3 的低 gas-price 参数执行）。

## 4. 前端对齐（块 2，与新合约同轮）

- `services/vaultAbi.ts`：从新 `Vault.json` 重新生成，加 `cancelledOrders` /
  `lockTombstones` 两个读口。
- `services/hardCancel.ts`：
  - 无锁状态四态区分（第 46 轮复审 P1-2）：`never-locked`（无锁、无任何墓碑）
    / `already-cancelled`（撤单墓碑在、累计成交 < amountIn）
    / `filled`（撤单墓碑在、累计成交 ≥ amountIn；累计值骑
    `dualread/chainState.ts` 的 `SETTLEMENT_READ_ABI.orderFilledIn` 读取）
    / `expired-released`（无锁、落锁墓碑在、无撤单墓碑）。
  - 释放成功口径收紧：回读锁消失**且**撤单墓碑已置位才报 released。
  - **旧栈降级**：`cancelledOrders` 读口在老 Vault 上不存在（调用 revert），
    捕获后降级为第 46 轮口径（无锁归入 never-locked 的保守呈现）。因此前端
    可先于合约切换上线，切换完成后自动走新口径，无需二次发版配合。
- `components/HardCancelAction.tsx`：确认弹窗与五态结果文案对齐新语义
  （链上撤单 = 立即解锁 + 永久作废）；never-locked 明确警示「订单本身没有
  作废、过期前仍可被落锁成交」；簿面移除文案按 P2-5 收窄为「节点簿记录已
  移除；中继簿记录仍待过期清理」。
- 签名撤单文案（P2-4）三处对齐（TradeTabsPanel 脚注、OrderBookSection 提示、
  LimitOrderFormWidget 说明 ×2）：按节点源码实情表述（见 §5）。

## 5. P2-4 的事实修正（对复审原表述的订正）

ChatGPT 第 46 轮复审 P2-4 的原表述「签名撤单只删簿面、不释放锁定」对
**节点路径不准确**。读 Go 节点源码（`node/cmd/node/main.go`）：
`OnCancelOrder` 在移除订单簿后调用 `vaultLocker.releaseForOrder`，由节点
以 locker 身份调 `Vault.releaseOrderLock` 代为释放；但释放失败**仅记日志、
不阻断撤单**（注释明示）。且无节点场景（节点停机/已退役）根本没有这一环。
故产品文案定版为：「签名撤单只需签名；节点在线时由节点移除簿面并代为
释放锁定（释放不成功不阻断撤单，少数情况余额要等订单到期才释放）；
链上撤单由用户自己的钱包立即释放并永久作废，不依赖节点。」
另注：切换到新 Vault 后，节点以 locker 身份的释放同样置撤单墓碑——
签名撤单经节点路径完成时，该单也永久作废，与 §2 边界④ 一致。

## 6
...[truncated 2089 chars]