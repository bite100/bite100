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
  以 Vault 实际口径读回其 USDT 托管余额 ≥ 1000×10^18（按测试 USDT
  实测 18 位精度核；第 48 轮文档纠正：原稿误写 6 位，测试 USDT
  双链 decimals 实测均为 18）。

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
## 附：切换执行记录（2026-11-09）

> 第 1–3 步由主聊天执行并验证；配置回填（第 6 步的配置部分、第 7 步
> 地址与断言、第 8 步索引器）由回填提交登记于此。老栈全程未动。

### 部署结果（第 1 步）

| 链 | 合约 | 新地址 | 部署块 | CREATE tx |
|---|---|---|---|---|
| Sepolia | Vault | 0x836cEFF0140aB66D8DD984ECb18765736BA121e9 | 12094696 | 0xe19e827b0f109bce9fa9b1088b05d1fd9c04da76f6b2cac6ff4f2f2b2dd961e7 |
| Sepolia | Settlement | 0x5697F7B2178352eB391e29fc2c5681Dea864C1d9 | 12094697 | 0xbd3556e5c56d8bb57bb4d7196d8e708ba434fc1a1f77904467bb3705fba6d249 |
| Sepolia | MakerVault | 0x5473D7c58c56BCd855c6f2048614A10e9645F7f0 | 12094705 | 0x0db47b0d0453519eb064b75fbed2fcc41e1085ef395d10e0528e28e1ff13950f |
| Base Sepolia | Vault | 0x295F5529F5BfA4cA39290f395b1feF7EA637f5D3 | 56357189 | 0x905d01e918f5e57a9e232744aefa6fa66172dbf2e3b3db93433aff6cdec60f33 |
| Base Sepolia | Settlement | 0x1021C7116cCE59f9c85683d6f1b5aD2215795949 | 56357193 | 0x4dcbd91be8829457ead8e6f3b27f195e2f0156d8bb098dc5fb3b79fc9ff971ed |
| Base Sepolia | MakerVault | 0x66F43601e4ef88ba38F8AeDDe9D2b0F949427D31 | 56357240 | 0xadc2de0a544c283d3f54535a0e48d20f59964382908210370f3ba1f6833c8e21 |

索引器 start_block 取 Settlement 的 CREATE 块：Sepolia 12094697 /
Base Sepolia 56357193（已回填 indexer/config.yaml）。

### 回读结论（第 2 步，主聊天链上回读）

- 双链新 Settlement 的 feeBps、meterKeepBps、gasDeductCapBps、
  maxFailureGasChargeQuote、feeDistributor、governance、chainConfig
  与老栈逐项全等；vault() 指向新 Vault；relayer 未设（模型 B 开放提交）。
- 新 Vault：settlement() 指向新 Settlement；lockers(部署者)==true；
  **cancelledOrders 读口在新栈存在且返回 false、老栈同调用 revert**
  （新旧栈判别成立，永久撤单代码已上链）。
- 新 MakerVault：tradingVault()==新 Vault，asset()/baseToken()/priceFeed()
  与第 0 步参数一致；signer 的 ROLE_MARKET_MAKER 已注册。

### 注资（第 3 步）

- 双链新 Vault 各转入 1000 测试 USDT（本测试 USDT 为 18 位精度，
  即 1000×10^18），回读托管余额达标。

### 配置回填登记（本提交）

- frontend/src/config/chains.ts：双链 vault/settlement/makerVault 已换新值
  （仅此六行，无关字段未动）；chains.test.ts、
  services/orderSigningTypes.test.ts 写死断言同步。
- indexer/config.yaml：双链 Settlement 地址 + start_block 已换新值，
  文件头部署记录注释同步（新地址/CREATE tx/部署块）；连带
  src/lib/settlementAbi.ts 注释、test/reconcile.test.ts、
  test/testindexer.test.ts、README.md 部署表同步。
- relay/src/config.ts：双链 settlement 已换新值，文件头核对注释同步；
  relay/scripts/demo.mjs、relay/scripts/verify-1271-live.mjs 内
  Sepolia Settlement / MakerVault 地址同步（Worker 重新部署不在本提交内，
  由主聊天在合并后执行）。

### 待主聊天续行

- 第 4 步 E2E、第 5 步撤单永久性烟测、第 6 步 Worker 重新部署
  （含 D1 备份与生产烟测）、第 7 步推送与线上 bundle 核验、
  第 8 步 Envio 轮换。

### E2E 与撤单永久性烟测（第 4/5 步，主聊天 2026-11-09 执行，全过）

临时验收脚本（骑 soak/generator 签单 + 生产 fills/ABI，验收后已删，不入仓）
双链各跑一遍 TKA/TKB 对（价格 1 合成价，测状态机保真）：

- **第 5 步烟测（双链同结论）**：maker SELL 单落锁（Sepolia 摘要
  0x85dbde04…、锁 tx 0x0985a11b…；Base 摘要 0x5b248737…、锁 tx
  0xbcac5a2a…）→ maker releaseOrderLock（Sepolia 0x2a19faee…；Base
  0xdc2c4064…）→ 读回 orderLocks 清零、**cancelledOrders == true**、
  可用余额恢复 → 陌生账户重落锁 staticCall 与真实发送均 revert
  `Vault: order cancelled`、locker（部署者）重落锁 staticCall 同 revert →
  已撤单直接 settleTrade staticCall revert `Vault: order not locked`。
- **第 4 步 E2E**：单笔 settleTrade 成功（Sepolia tx 0x961d8d82…、
  Base tx 0xdebedd95…，status=1，filledIn=0.5×10^18）；批量
  settleTradesBatch 两腿成功（Sepolia tx 0xe0b58e96…、Base tx
  0x1d0764e1…，status=1，filledIn=0.3/0.2×10^18）；坏价 fill
  staticCall 双链均 revert `Settlement: fill breaches signed limit price`。
- 执行插曲（如实登记）：Sepolia 首播因默认 gas 定价（1 gwei）余额不足
  中途停摆，仅落一个孤儿 Vault（0x2dc73677…，耗测试 gas ≈0.0102 ETH，
  老栈未受影响），改低价参数（0.1/0.05 gwei）+ --start-fresh 后全程
  成功；部署者余额事先由 maker/taker 各转入补足（Sepolia 0.025×2、
  Base 0.010×2）。验收脚本三课：①NonceManager 在 publicnode 多后端下
  计数失同步，串行 await 场景用普通 Wallet 逐笔读 nonce；②Sepolia
  publicnode gas 计量放大，结算 gasLimit 须 ≥15M（实测计量 1.70M，
  1.5M 上限会执行中途耗尽）；③Base 单笔 gasLimit 上限受区块限约束，
  25M 被 RPC 拒收（"gas limit too high"），用 3M。

### 中继重部署（第 6 步，主聊天 2026-11-09 执行）

- 清表前 D1 全量导出备份：150 行存于 Muse 工作区
  `bite100-r47-d1-backup-2026-11-09.json`（仓外）；随后 DELETE 清空。
- Worker 以新 config.ts 重新打包经 API 上传（deployment a44e2c30…），
  cron `*/15` 保留。**邮差密钥被迫轮换**：脚本上传接口要求 secret 必须
  带明文（报错 10021），旧值只写不可读——改用仓库自带 gen-postman.mjs
  生成新邮差密钥并经 secrets 接口注入（新 npub1nvzn80d…）。旧镜像事件
  仍在公共中继上（best-effort 副本），D1 主账不受影响。
- 生产烟测 demo 8/9：health/真实签名订单入库/去重/查回/订单簿/过期拒/
  坏签名拒全过（真实签名按新 Settlement 域验签通过＝新配置已生效）；
  **Nostr 镜像 event id 未回填（已知观察项）**：两次 demo + 换标准密钥
  后仍未回填，本机探针因本机出口代理 wss 不通无法复现 Worker 出口，
  根因未隔离（疑公共中继侧可达性/策略）；镜像按设计为 best-effort，
  D1 为主账，不阻塞切换。后续轮次可加日志可见性再查。

## 附录 B：部署交易清单（第 48 轮从广播文件转录补登）

来源：执行机本地 `contracts/broadcast/DeployStage3.s.sol/{11155111,84532}/run-latest.json`
（该 broadcast 目录被 `contracts/.gitignore` 忽略、不在仓库内，故此前文档无此清单；
哈希逐字转录自文件，未做任何改写）。两链各 **12 笔**（3 笔 CREATE + 9 笔配置 CALL），
共 24 笔。注：Sepolia 同目录的 `run-latest.1794193126214.json` 是第一次
因默认 gas 定价失败的尝试（只落了孤儿 Vault 0x2dc7…adf，永不使用），不在本清单内。

### Sepolia（chainId 11155111，共 12 笔）

| # | 类型 | 目标/新建合约 | 函数 | 交易哈希 |
|---|---|---|---|---|
| 1 | CREATE | Vault | — | `0xe19e827b0f109bce9fa9b1088b05d1fd9c04da76f6b2cac6ff4f2f2b2dd961e7` |
| 2 | CREATE | Settlement | — | `0xbd3556e5c56d8bb57bb4d7196d8e708ba434fc1a1f77904467bb3705fba6d249` |
| 3 | CALL | Settlement | setGovernance(…) | `0xf80cf86abb9cc8cfad28d9e1f3188896ed7e8eaba72669fec3e5673a27d52b6c` |
| 4 | CALL | Settlement | setChainConfig(…) | `0x72d6ef1d4c8bb99d3e02d37d5ebdb0b5c1012e13d5ae1447826395ee0410adbc` |
| 5 | CALL | Settlement | setFeeBps(…) | `0x8b8b06f3f8c74f38c3ed41d21926367affe28b84ee46df7531844a9b717146bf` |
| 6 | CALL | Settlement | setMeterKeepBps(…) | `0xfed30db795085cbd490b4af541671f763ddac38389e934a0b64e887477e4cfa4` |
| 7 | CALL | Settlement | setGasDeductCapBps(…) | `0x885e81e07454807c382708e3ddfb878abd5c978bc4fbc83c67c1947e672b8d50` |
| 8 | CALL | Settlement | setMaxFailureGasChargeQuote(…) | `0xd1a922fb0b0749297f6150293733f19cc02a637ddfc04e35e15f4c6aa9301258` |
| 9 | CALL | Vault | setSettlement(…) | `0xdc5bb9991d56fe9e364880f653a6a334fbbe9a28f9532c0fda8a9cb5715d7385` |
| 10 | CALL | Vault | setLocker(…) | `0x7c9559dd4afcf566ef5ebb8fcfcc33c4b1157ad950bca970c0bedf5f7184080a` |
| 11 | CREATE | MakerVault | — | `0x0db47b0d0453519eb064b75fbed2fcc41e1085ef395d10e0528e28e1ff13950f` |
| 12 | CALL | MakerVault | setSigner(…) | `0x3d59e377f055897322806311797c8bfdac1497a81158fd896aeac8e6503b1263` |

### Base Sepolia（chainId 84532，共 12 笔）

| # | 类型 | 目标/新建合约 | 函数 | 交易哈希 |
|---|---|---|---|---|
| 1 | CREATE | Vault | — | `0x905d01e918f5e57a9e232744aefa6fa66172dbf2e3b3db93433aff6cdec60f33` |
| 2 | CREATE | Settlement | — | `0x4dcbd91be8829457ead8e6f3b27f195e2f0156d8bb098dc5fb3b79fc9ff971ed` |
| 3 | CALL | Settlement | setGovernance(…) | `0x6b1b22fe7fbd5da33b48593770c530cb8e5ff6328f3530de5690b2f0c86eaed5` |
| 4 | CALL | Settlement | setChainConfig(…) | `0x7932dc6585a5ca72b06cfb8fa62278e8a2c8dbdc93c726e85095fe9469498c9b` |
| 5 | CALL | Settlement | setFeeBps(…) | `0x50e36da793f48ba0edcf9fb17872290b651195f5ec82b7fc86672876cd944d33` |
| 6 | CALL | Settlement | setMeterKeepBps(…) | `0x165fd6f5ed60c46d63cef90e788da26f55e29e6883a568c12e304cdfbd36d5fe` |
| 7 | CALL | Settlement | setGasDeductCapBps(…) | `0xeb9896a6cb31857a691c6f23eac2ae102f0234403037321868c688299567b36e` |
| 8 | CALL | Settlement | setMaxFailureGasChargeQuote(…) | `0x2c9eaf58b15396461b789258d3f268bb3c5b81b9fc0cc1fc3c80d6fb27a78303` |
| 9 | CALL | Vault | setSettlement(…) | `0xc8aaf9edc72cbf3fad7af3768b0c85f6237d2c5602f54aff9f52afac363824e7` |
| 10 | CALL | Vault | setLocker(…) | `0x2fe5051a2f81a02ae4bb304609cfb1b73a878487f417fb5d773b092756ceaa1d` |
| 11 | CREATE | MakerVault | — | `0xadc2de0a544c283d3f54535a0e48d20f59964382908210370f3ba1f6833c8e21` |
| 12 | CALL | MakerVault | setSigner(…) | `0xa01538bbe3da791f8743f9ed223d5abbc635c34acdb193736632b5b73e8c9584` |
