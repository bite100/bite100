# 阶段 3 测试网切换记录（2026-11-08）

> 执行口径：负责人 Ren 2026-11-08 18:15 正式发令「直接切换，不用跑 3A 了」——
> **3A 浸泡正式豁免**（浸泡服务保持停用、不重启），按
> [stage3-contract-matching-2026-11-08.md](stage3-contract-matching-2026-11-08.md) §7 runbook 执行。
> 代码基线：main `478d472`（第 42 轮）。本轮只提交配置与文档（分支 `stage3-cutover`），
> **无业务代码改动**；主聊天核验后合并推送，随推送做 Envio 端点轮换与例行 ChatGPT 复审。

## 1. 新旧地址对照（第 33 轮栈 → 阶段 3 栈）

| 链 | 合约 | 旧（第 33 轮） | 新（阶段 3） | 新部署块 |
|---|---|---|---|---|
| Sepolia 11155111 | Vault | `0x66D4DE542d6329D2b6631170fCD773Ce2518E890` | `0x6b9f8628650118376D14E7a77E8a321F9513c481` | 12089723 |
| Sepolia 11155111 | Settlement | `0xa3F8cBCDc1533299D37836ea80d5004FF59f9094` | `0xbf2B9635B682Ff30E73028a5b2beEB829873a88f` | 12089723 |
| Sepolia 11155111 | MakerVault | `0x41c0f50f9Ff4D895eb33C1590B6DEDCa6C06857a` | `0x47f26952cDB5a3FC5cd693c43819f353D20666C3` | 12089723 |
| Base Sepolia 84532 | Vault | `0x60eaeb651371268EAA96bc0F45ec20Ed000f7b4A` | `0x2d7a577d403719A9773dEaB3052a9257012401e6` | 56039239 |
| Base Sepolia 84532 | Settlement | `0x39037dE0a1d6ca567d50055522f7Ef825dF4FCf9` | `0x50aFA0d0a407bdeCcdd6b9b3f6d4a68f837F0305` | 56039239 |
| Base Sepolia 84532 | MakerVault | `0x35366FB236b67f43A3287efa8f0b461DfC9E3279` | `0x2eD907f44F03B1288F8bCF73dB37D35282558753` | 56039239 / 56039240 |

> 注：Base Sepolia 两地址以 **EIP-55 校验和形式**为准（`0x50aF…F0305`、`0x2d7a…401e6`）。
> 部署广播文件里的小写形式与本表为同一地址；viem 等库对校验和敏感，引用时勿改大小写。

部署 tx（DeployStage3，两链各 12 笔，全部 status=1）：

- Sepolia（全部落块 12089723）：Vault CREATE `0xdee26c644b84845208892d1aeb805b41b8857a7651d0890f434887da175e8506`、Settlement CREATE `0xa4e07bae90e31b892b4a7c89d71a0d376b3c5f26a9992a1d5b9983dd65c0d164`、setGovernance `0x3b4de11fea34d90d7a70efa5caa5af71c2f419beb874fd9f592ce55b0539294d`、setChainConfig `0xead1ddc1df771b4e15687b55fbcef243e09e71d3653c0f750c31ab84d6687723`、setFeeBps `0x93f10344390e785c4e7a022611da5d6d9e2cebd8d3e1699f6103e7d8670d04ee`、setMeterKeepBps `0xd08063f9bcb8bbfcc349bc768121ad40d6586bd37dd3eea3040a61c47b03348e`、setGasDeductCapBps `0xfb28437b7e94542fc9427d3273741d09c7b7151360de68e01a798d662c78096a`、setMaxFailureGasChargeQuote `0x84c1e7d6348088fff7b42a19f70a910fd08b56b388ecd18c9f0dcba9a0842706`、Vault.setSettlement `0x1c7b2320a31489f06b4312d42583ce81361b67810e9e3ce2e30f9b1f73339373`、Vault.setLocker `0xd66c2a510370b9f75acbef61dac5a5bbccf393e8687145a36b6f09108515d9b3`、MakerVault CREATE `0xec6cd502e37807dea5b9bd9767a5d16b13af316ef7a92eabf4bbf11dd5c15819`、MakerVault.setSigner `0x86962df143107acc2204248a39b1612a7380823b4fac2b458f375e1cc9898ec3`。
- Base Sepolia（落块 56039239，MakerVault 两笔 56039240）：Vault CREATE `0x82ecec7c19e2bbf1f94b9881d6b9e6fc2791160b4286fe56d9c11c3d12903878`、Settlement CREATE `0x39f5c4ff91f57fe407463de32da145d2ca7f1b26ef4f09d84cfd8784754e7a32`、setGovernance `0x95632be76a9d797f2f36582caea13a21530c10897e38538faa5ffc45d03a32f9`、setChainConfig `0xac00aed838ebaa99b90a3f498da149e9aa1f4742c3512cdab1d2c47ef9e22c1a`、setFeeBps `0x1d9957b9bb85ff1258ff18075f3be89ae96b56003705f1693200b903ad49c410`、setMeterKeepBps `0x4ecc820f3e1bc965219c88ecf8b550168c4e8f9f40d25825f141abbaa59e3f68`、setGasDeductCapBps `0x76bb7219e8bf4a6dd9d81c572548da477046ed1f79ac98936a501ce15cab1d05`、setMaxFailureGasChargeQuote `0x6d07b7bd45a1b3a88965bf0ef0b326bf9963c2748e83da44f57c331aff3a92c1`、Vault.setSettlement `0xb63bc266c3cec77f73edc5e816d0ad4b35ec168433d5f95d70aa3d4ec7b1807a`、Vault.setLocker `0xe39afa3710e5db42aa8c01cb5465a02af24d98950171bcc3710f7179742b197d`、MakerVault CREATE `0xfabbca3c35778d1e95d3730215515106ac9c51ec275c9ed638c349dde91eca80`、MakerVault.setSigner `0xc76be159606ed0afc23c2b8c1834991e55c4b8320f8665fbf1e1d88662c8bbbb`。

## 2. 配置回读表（cast 实测，两链一致）

| 项 | 期望（第 33 轮栈 1:1） | Sepolia 实测 | Base Sepolia 实测 |
|---|---|---|---|
| Settlement.vault | 本链新 Vault | ✅ | ✅ |
| feeBps | 1 | ✅ 1 | ✅ 1 |
| meterKeepBps | 7600 | ✅ 7600 | ✅ 7600 |
| gasDeductCapBps | 1000 | ✅ 1000 | ✅ 1000 |
| maxFailureGasChargeQuote | 5e18 | ✅ 5e18 | ✅ 5e18 |
| owner | 部署者 EOA `0x4B3f…a93e` | ✅ | ✅ |
| nodeRewards | 0 地址 | ✅ 0x0 | ✅ 0x0 |
| relayer / isRelayer | 开放提交（模型 B）：无门禁 | ✅ 0 / false | ✅ 0 / false |
| feeDistributor / governance / chainConfig | 与旧栈逐链同值（脚本自旧 Settlement 读回复制） | ✅ `0x346d…e1b5` / `0x3190…8448` / `0x52de…aa0c4` | ✅ `0xaec8…009b7` / `0x26b6…bcce` / `0x41b1…9e8` |
| Vault.settlement | 本链新 Settlement | ✅ | ✅ |
| Vault.lockers(部署者) | true | ✅ true | ✅ true |
| Vault 内 USDT 余额 | 1000 USDT（1e21） | ✅ 1e21 | ✅ 1e21 |
| MakerVault.asset / tradingVault | 本链 USDT / 本链新 Vault | ✅ | ✅ |
| MakerVault.signerRoles(金库签名者) | `keccak256("MARKET_MAKER")` = `0xc77b…34e6` | ✅ | ✅ |

充值 tx：Sepolia approve `0x33ebcf9dd78995bf9425784a8cc54fdea749a8abfa04b0a24d736a1709bb00fc` / deposit `0x0a329fb383740e4e70a1043a27157c38c1c3092f42976eb6ce1f24c43e8afd86`；Base approve `0x4c31121fd568d3da44401608acb466bc8273ffd0a99403a9c0a9c4997ae1b32a` / deposit `0x19ac367f780e845b6bfc80b0316abea3510ec2dfd08372f9045d380443202723`。
MakerVault 本体**未注资**：runbook §7 把金库注资列为单独确认项，本轮只部署 + 登记签名者（与「平台不下场、金库改 gas 库」口径一致）。

## 3. 链上冒烟（价格校验实证，双链）

- 好价路径：E2E 的 `settleTrade` / `settleTradesBatch` 在两链均成功——带 `side` 字段的阶段 3
  签名订单被新 Settlement 正常验签并结算（验签失败必 revert，故成功即实证）。
- 坏价路径：maker 签 1:1（SELL 100 TKA ↔ 100 TKB），构造 Fill 尝试 100 进 / 1 出，
  以低层 call 模拟（不广播坏 tx、不花 gas）：两链均 **revert**，原因字符串
  `Settlement: fill breaches signed limit price` —— `_requireSignedLimitPrice` 在新栈真实生效。

## 4. E2E 双链（临时脚本 E2ECutover，骑第 21 轮 E2EGasRules 的订单构造口径；脚本未入仓）

流程：铸币 → maker/taker 双向存款（各 500 TKA + 500 TKB）→ 4 单锁仓 →
`settleTrade` 一笔（100↔100，1:1）+ `settleTradesBatch` 一笔（50↔50）。两链各 18 笔 tx 全部 status=1。

Sepolia（块 12089745–12089762）：

| 步骤 | tx |
|---|---|
| mint ×4 | `0x8941e3e3…27ff6` / `0xe3ade028…f0fa0` / `0x0424ca1b…1472` / `0xf73688ba…e73c` |
| approve+deposit ×4 组 | `0x73fda7d9…8526`+`0x40ecbd08…5510` / `0x9b5b5007…aba5`+`0x7e7b536f…7cc0` / `0xab0bac9f…3c4a`+`0x316e5896…b5cd` / `0x14897ec1…3346`+`0x5eb31195…a25f` |
| lockForOrder ×4 | `0xa146e0ac…e646` / `0xf2528d35…7a25` / `0x7f483794…719a` / `0xf0a169b7…7098` |
| **settleTrade** | `0x8f6b138e8ae232c5a01f214e70a5caca27cb36813130b0b000acaa7a03dfbd26`（块 12089761，gasUsed 1,285,807，26 logs） |
| **settleTradesBatch** | `0x83c209288782ac8c4afc90af9c3155d16ba25a671ab88be826b3ded467ad9334`（块 12089762，gasUsed 1,068,077，26 logs） |

Base Sepolia（块 56042350–56042469）：

| 步骤 | tx |
|---|---|
| mint ×4 | `0xfa6af8ad…d08a` / `0xfd4b4586…c532` / `0x91728a99…dc4d` / `0xb9159591…e37f` |
| approve+deposit ×4 组 | `0x936fadb9…3f4d`+`0x0091ca52…fe25` / `0x3c49354d…1a1c`+`0x5505f5d9…68a6` / `0x3b20952c…4a3d`+`0x6abadbd3…7452` / `0xca637c6c…540b`+`0xff98b781…150c` |
| lockForOrder ×4 | `0xa19ac94e…196f` / `0x28c33370…6384` / `0x104bb66d…9057` / `0x73f18009…8856` |
| **settleTrade** | `0x3ead6a1e29f463640e379b298bddb841a66d1055063a3402db6882ef401da2d1`（块 56042458，gasUsed 478,960，26 logs） |
| **settleTradesBatch** | `0x5dc856c607af6aa87584b7e0850ecae682b95ada908354d56d1f1ec20af4187c`（块 56042469，gasUsed 452,684，26 logs） |

事件核对（两笔结算 tx 各 26 条日志，构成一致）：`TradeSettled`（topic `0xe84be425…`，新
Settlement 发出）×1、`GasCostShared`（topic `0xf25f067a…`）×1、Vault 记账与 FeeDistributor
费/gas 事件齐全。即 runbook 要求的「成交 + GasShare 事件」在双链单笔与批量路径均已落链。
（注：事件 topic 以 `contracts/src/Settlement.sol` 的事件签名为准实测比对；
`TradeSettledWithGasReimburse` 的 topic 前缀与 Vault 的记账事件同为 `0x2af71f10`，勿凭前缀猜事件名。）

## 5. 各面回填（本分支提交内容）

| 面 | 改动 |
|---|---|
| 前端 `frontend/src/config/chains.ts` | 双链 vault/settlement/makerVault → 新地址（Base 两地址用校验和形式） |
| 前端断言 | `chains.test.ts`、`services/orderSigningTypes.test.ts` 的地址期望同步（配置断言，非业务逻辑） |
| 索引器 `indexer/config.yaml` | 双链 Settlement 地址 + start_block 改为部署块 **12089723 / 56039239**；头部部署记录改指本文档 |
| 索引器附带 | `indexer/README.md` 地址表、`src/lib/settlementAbi.ts` 版本标识注释、`test/reconcile.test.ts` / `test/testindexer.test.ts` 的地址常量与合成事件块号（块号必须 ≥ start_block，取部署块后约 100 块：12089800 / 56039300） |
| 中继 `relay/src/config.ts` | 双链 settlement → 新地址 + 头部核对注释更新；`scripts/demo.mjs`、`scripts/verify-1271-live.mjs` 的内置地址同步 |
| Go 节点（仓库外 `~/workspace/bite100-node/`） | 两份 config.yaml 的 settlement/vault 改指新栈（旧配置备份 `config.yaml.r33`）；二进制按 runbook 用当前 main 源码重建（旧二进制留 `bin/p2p-node.bak-s3cutover`）；停服期间把两链订单簿 SQLite 改名备份为 `storage.db.bak-s3cutover-20261108`（旧域订单在新域必然验签失败，不迁移），重启后 `/api/health` 双端 `{"ok":true}`、订单簿为空且接口正常，启动日志确认提交器指向新 Settlement；`bite100-soak` 保持停用（未动） |

### 中继 Worker 重新部署（已执行）

- 按 runbook §7.3：先清空 D1 `orders` 表（实测原有 99 行，`DELETE FROM orders` changes=99），
  再以 Cloudflare 帮手（custom.cloudflare 连接器）上传新 bundle 并重设 cron（`*/15`）与
  workers.dev 子域。**secret `NOSTR_POSTMAN_SECRET_HEX` 未动**（上传脚本不携带 secret，
  原 secret 保持绑定）。
- **D1 清空备份注记（2026-11-08 复审回填）**：本次清空未做删除前导出备份。被删 99 行
  均为旧签名域订单，在新 Settlement 下全部失效、且属测试期订单；回滚旧栈不依赖该
  数据（旧栈订单簿以节点 SQLite 备份 `storage.db.bak-s3cutover-20261108` 为准），
  故无实际损失，但流程不闭环——**此后任何 D1 清空/重置前必须先导出备份留档**。
- 冒烟：`GET /health` → `{"ok":true,"db":"ok"}`；`scripts/demo.mjs` 对生产 URL **9/9 全过**——
  含以新 Settlement 为签名域的真实签名订单入库、去重、查回、订单簿、过期拒、坏签名拒、
  Nostr 镜像 event id 回填（`52e6ffc3…e6e20`）。注意 demo 订单会留在 D1 中（BTC/USDT 一单），
  属预期验收痕迹，过期清理 cron 会自动回收。

## 6. 门禁（切换 worktree 实测）

| 门禁 | 结果 |
|---|---|
| forge test（contracts，未改动） | **185/185 通过**（基线 185） |
| 前端 `npm test` | **404/404 通过**（36 文件） |
| 前端 `npm run build` | ✅ 成功 |
| 中继 `npm test` | **37/37 通过**（unit 25 + workers 12） |
| 索引器 `npm test` | **10 通过 / 2 跳过**（与阶段 3 基线 10/2 一致；跳过为既有的需账号用例） |

过程记录（如实登记）：回填初稿曾出两处执行错误，均已修正并复测全绿——
① Base Sepolia 两地址误用了广播文件的小写原文拼接的伪校验和，viem 严格校验直接报错
（中继单测当场抓住），已按 `cast to-check-sum-address` 的真校验和更正全部引用面；
② 索引器 start_block 初稿误抄了预估块号，已按链上回执更正为 12089723 / 56039239，
合成事件测试块号随之对齐。

## 7. 回滚说明

旧栈合约与旧配置**全程未动**（旧 Vault/Settlement/MakerVault 仍在链上、旧配置备份齐全）。
回滚 = 把各面配置改指旧地址即可：前端/indexer/中继改回第 1 节「旧」列地址
（indexer start_block 回 12087251 / 55881173）、中继重新部署、节点 config 恢复
`config.yaml.r33` + 旧二进制 `p2p-node.bak-s3cutover` + 订单簿备份
`storage.db.bak-s3cutover-20261108` 后重启两服务。无需任何链上操作。

## 8. 未做 / 待主聊天与后续轮次

- 本分支**未合并、未推送**：合并推送后需按例行做 Envio 端点轮换（新 config.yaml 触发新
  deployment → 回填 `VITE_INDEXER_URL` secret → Pages 重跑 → 核验线上包）与 ChatGPT 复审。
- 前端撮合灰度开关 `VITE_FRONTEND_MATCHING` 仍默认关，本轮未开启（开启前置见第 43 轮）。
- 贡献权重第 42 轮常量（35/25/20/20）不在本次部署范围（DeployStage3 不含
  ContributorReward），随其下一次部署生效。
- 历史订单按阶段 3 口径切换即作废，不迁移（runbook §7.1）。
