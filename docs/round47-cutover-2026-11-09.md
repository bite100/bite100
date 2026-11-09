# 第四十七轮切换 runbook：永久撤单新栈双链重部署（2026-11-09）

> 执行者：主聊天（本轮工人只备料，不执行部署、不推送）。
> 骨架沿用阶段 3 切换（docs/stage3-cutover-2026-11-08.md），新增第 5 步
> 撤单永久性烟测。**老栈全程不动**（回滚）；**中继 D1 清表前先导出备份**
> （2026-11-08 立的规矩）；chargeFailedSettlement 保持关闭 + 受信门禁不动。

## 0. 前置检查（任一不过不进第 1 步）

- [ ] 分支 `round47-permanent-cancel` 已复核合并并推送到 main（forge 193/193、
      前端 39 文件全过 + build 过，与轮次文档 §7 一致）。
- [ ] 双链节点服务保持停止（阶段 4 起停用中）；无在途未确认结算
      （查 stage4 恢复账本与近期链上回执，无 pending tx）。
- [ ] 部署者钱包（`~/workspace/bite100-deployer/wallet.env` 的 PRIVATE_KEY，
      地址 0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e）双链原生币余额足
      （Sepolia ETH / Base Sepolia ETH 各 ≥ 0.05，按阶段 3 低价参数口径）；
      部署者持有足额测试 USDT 供第 3 步注资（每链 1000）。
- [ ] 部署参数（已于 2026-11-09 从老栈链上回读，执行前再核一次）：

| 参数 | Sepolia (11155111) | Base Sepolia (84532) |
|---|---|---|
| OLD_SETTLEMENT_ADDRESS | 0xbf2B9635B682Ff30E73028a5b2beEB829873a88f | 0x50aFA0d0a407bdeCcdd6b9b3f6d4a68f837F0305 |
| FEE_DISTRIBUTOR_ADDRESS | 0x346DE29B7fEe95F44A5b5385e87182F031E8E1B5 | 0xAeC85272Cba4F22eaf93a0313b0D09164Ca009b7 |
| ASSET（测试 USDT） | 0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e | 0xAAB464E0BE805c199007E27D8f651038319207d6 |
| BASE_TOKEN | 0x8EDa0025C245B10eA1E10c257674B794C85350f3 | 0x151c6bE0D525880626f4757d58Cd141872AF7914 |
| PRICE_FEED | 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43 | 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1 |
| SIGNER_ADDRESS | 0x05040D9ec117A264C58B293Feed7aB40A9B5A726（双链同） | 同左 |

回读命令（示例 Sepolia，Base 换 RPC 与 MakerVault 地址）：
`cast call <老MakerVault> "asset()(address)" --rpc-url <RPC>`（baseToken /
priceFeed 同法）；`cast call <老Settlement> "feeDistributor()(address)"`。

## 1. 部署（双链各一次）

```bash
cd contracts && export PATH=$PATH:~/workspace/tools/foundry
set -a; source ~/workspace/bite100-deployer/wallet.env; set +a
export FEE_DISTRIBUTOR_ADDRESS=… OLD_SETTLEMENT_ADDRESS=… ASSET=… \
       BASE_TOKEN=… PRICE_FEED=… SIGNER_ADDRESS=… TARGET_CHAIN_ID=<链ID>
forge script script/DeployStage3.s.sol \
  --rpc-url <https://ethereum-sepolia.publicnode.com | https://sepolia.base.org> \
  --broadcast --slow   # 沿用阶段 3 低 gas-price 口径时按当时参数追加
```

- 通过标准：脚本无 revert；`contracts/broadcast/DeployStage3.s.sol/<链ID>/run-latest.json`
  落盘；记录三个新地址（Vault / Settlement / MakerVault）与部署块高
  （Settlement CREATE 回执块 = 索引器 start_block）。
- 脚本内已断言：新 Settlement 的 feeDistributor 与传入值、与旧实例读回一致。

## 2. 回读配置 1:1（与老栈逐项比对，全等才继续）

对双链新 Settlement / Vault / MakerVault 用 `cast call` 核：

- [ ] Settlement：feeBps=1、meterKeepBps=7600、gasDeductCapBps=1000、
      maxFailureGasChargeQuote=5×10^18、governance / chainConfig /
      feeDistributor 与老栈同值；vault() == 新 Vault；relayer 未设（模型 B）。
- [ ] Vault：settlement() == 新 Settlement；lockers(部署者)==true；
      **cancelledOrders 为新栈独有读口，老栈调用应 revert、新栈返回 false**
      （以任一 digest 试读，兼作新旧栈判别）。
- [ ] MakerVault：tradingVault()==新 Vault、asset()/baseToken()/priceFeed()
      与第 0 步参数一致；signer 的 ROLE_MARKET_MAKER 已注册。

## 3. 注资

- [ ] 向双链新 Vault 各转入 1000 测试 USDT（部署者转出，沿用阶段 3 手段）。
- 通过标准：`cast call <新Vault> "balanceOf(address)(uint256)" <USDT>`…
  以 Vault 实际口径读回其 USDT 托管余额 ≥ 1000×10^6（按 USDT 6 位精度核）。

## 4. E2E（双链各一轮）

- [ ] 单笔结算一笔成功（maker/taker 测试钱包，新域签单 → 落锁 → 结算），
      回执 status=1，金额与费用（0.01%）对账一致。
- [ ] 批量结算一笔成功（settleTradesBatch ≥2 腿）。
- [ ] 坏价 fill 被签名限价校验 revert（阶段 3 价格修复回归）。

## 5. 撤单永久性烟测（本轮新增，双链各一次）★

1. maker 在新 Vault 存入并签一张新单（新域），任意一方 `lockForOrder` 落锁；
   读 `orderLocks(digest)` 确认锁在。
2. maker（或 locker）调 `releaseOrderLock(digest)`；
   读回：`orderLocks` 清零、**`cancelledOrders(digest)` == true**、余额 locked 扣回。
3. 拿同一签名单再次 `lockForOrder`（分别以陌生账户与 locker 各试一次）：
   **必须 revert `Vault: order cancelled`**。
4. 直接 `settleTrade` 该单剩余量：必须 revert（无锁不可结算）。

- 通过标准：2–4 全如预期；任一不符 → 停，不进第 6 步，老栈仍是现行栈。

## 6. 中继重部署

- [ ] **先备份**：导出 D1 `bit100-relay-orders` 全量
      （`wrangler d1 export bit100-relay-orders --remote` 或 Cloudflare API；
      备份文件存 `~/workspace/` 并在本文件执行记录里登记路径）。
- [ ] `relay/src/config.ts` 双链 settlement 改新地址（提交标注「切换时生效」）。
- [ ] 重新部署 Worker（沿用既有 API 部署路径）；`NOSTR_POSTMAN_SECRET_HEX`
      不动。
- [ ] 生产烟测：双链各投一单 → 中继簿可读回 → 1271 路径抽查（沿用
      relay/scripts 口径，先把脚本内地址按 §8 清单更新）。

## 7. 前端配置回填（单独提交，标注「切换时生效」）

- [ ] `frontend/src/config/chains.ts`：双链 vault / settlement / makerVault
      三地址替换为新值。
- [ ] 连带断言：`frontend/src/config/chains.test.ts`、
      `frontend/src/services/orderSigningTypes.test.ts` 内写死地址同步。
- [ ] vitest 全过 + build 过后推送；GitHub Pages 构建完成，线上 bundle
      grep 到新 Settlement 地址、无旧地址残留。

## 8. 索引器重指

- [ ] `indexer/config.yaml`：双链 Settlement 地址 + start_block（=第 1 步
      部署块）替换；文件头部署记录注释同步（新地址 + CREATE tx）。
- [ ] 连带：`indexer/src/lib/settlementAbi.ts` 注释口径、
      `indexer/test/reconcile.test.ts`、`indexer/test/testindex
...[truncated 615 chars]