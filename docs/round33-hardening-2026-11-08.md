# 第 33 轮：安全加固——ChatGPT 复审四项新发现（N1–N4）修复（2026-11-08）

> 触发：第 32 轮推送后 ChatGPT 复审在「整改闭环」之外给出 4 项**新发现**，主聊天逐条对照代码核实全部属实。本轮集中修复：N1 Vault 重入（高）、N2 订单簿同 ID 替换的索引残留、N3 ReplaceOrderbook 绕过上限与唯一性、N4 NodeRegistry 钱包占用检查缺失；外加门禁文本补强与 CI/ABI 小对齐。**现行合约地址以本文 §4 为准**（取代链：第 3/8 轮 → 第 15 轮 → 第 27 轮 → 第 30 轮 → 第 32 轮 → **第 33 轮**）。
>
> 项目底线（集成优先）：N1 直接骑 OpenZeppelin 既有 `ReentrancyGuard`（与 Settlement/MakerVault/Governance 同一导入路径，OZ 已是既有依赖）；重部署沿用第 32 轮 DeployR32 部署脚本模式改写为 DeployR33；N2/N3 的共用校验只在引擎内抽内部函数，不引入新框架；E2E 驱动只调用节点自身 match/settlement/storage 包（验毕删除，不入仓）；ABI 防漂移是零依赖纯 Node 小脚本，不自建生成管线。骑乘对照见 §9。

## 1. N1：Vault 重入保护（合约）

**根因**：第 32 轮把 `Vault.deposit` 改为差额记账（记 `balanceBefore` → `transferFrom` → 按实收差额记账）后，恶意代币可在 `transferFrom` 回调中重入 `deposit`——内层调用以「转账虚增后的余额」为 `balanceBefore` 基线，同一笔到账被两层调用各记一次，`balances` 凭空放大。且 Vault 全文件原本无 `ReentrancyGuard`（同仓 Settlement/MakerVault/Governance 均有）。

**改法**（`contracts/src/Vault.sol`）：继承 OZ `ReentrancyGuard`，逐路径审查外部调用面后加 `nonReentrant`：

| 路径 | 外部调用面 | 处置 |
|---|---|---|
| `deposit` | `transferFrom`（代币回调） | ✅ 加（本次漏洞点） |
| `withdraw` | `transfer` 向用户打款（代币回调） | ✅ 加 |
| `lockForOrder` | `settlement.isValidSignature`（外部验证合约回调面） | ✅ 加 |
| `transferOut` | `transfer` 向金库出账（回调面同 withdraw） | ✅ 加 |
| `transferWithinVault` | 无外部调用（纯账本互转） | 不加（注释注明） |
| `consumeOrderLock` / `releaseOrderLock` / `releaseExpiredOrderLock` | 纯账本（Settlement 结算流程单向进入 consume——Settlement 自带守卫，无代币转出） | 不加（注释注明；与 Settlement 的既有跨合约调用关系不变） |

**测试**：新增 `contracts/test/VaultReentrancy.t.sol`——恶意回调代币 `ReentrantToken`（transferFrom/transfer 中按模式回调）**自备 5000 代币并给 Vault 预授无限额度**，确保「没有守卫重入真能成功重复记账」，而非被额度校验顺带拦下：①deposit 重入被 `ReentrancyGuardReentrantCall` 挡下且单次实收记账；②withdraw 打款回调跨函数重入 deposit 被挡、出金账实相符；③未武装时标准存取流程行为不变（与第 32 轮 VaultDeposit 断言口径一致）。第 32 轮的 `VaultDepositTest`、`VaultLockingTest`（25 项）、Settlement/MakerVault/GasRules 全量无回归（见 §8）。

## 2. N2 + N3：订单簿写入路径统一（节点引擎）

**N2 根因**（`node/internal/match/engine.go` 的 `AddOrder`）：同 ID 替换在函数开头 `removeOrderFromBook` 删旧单但**不清 `orderIDToPair`**，此后替换单在 `left <= 0` 等提前返回路径退出时，索引仍指向一个已不在簿上的订单——后续同 ID 跨 pair 冲突判断、`validateOrderLock` 的 `GetOrderByID` 回查都会踩到这个悬空索引。

**N3 根因**：`ReplaceOrderbook` 逐笔直接 `append` 重建买卖盘，完全绕过 `maxOrdersPerPair`（10000）上限、不查重复 ID（同批内、同簿跨侧、跨 pair 皆然），索引按 append 顺序乱序写入，坏快照可撑爆簿或制造重复索引。

**改法**：把写入校验抽成两个共用内部函数，两条路径都走：

- `normalizeForBook(o)`：字段/过期/剩余量（`Amount - Filled`）校验与归一（返回 `Filled="0"`、`Amount=剩余量` 的簿内副本）——**纯函数，不动簿与索引**；
- `checkInsertable(ob, o)`：容量上限 + 索引入口校验（ID 被另一 pair 占用即拒）。

`AddOrder` 重排顺序为「**先校验、后动簿**」：归一化（含剩余量）与跨 pair 检查全部通过后，才移除同 ID 旧单并插入。语义明确化：零剩余替换单现在被**拒绝且旧单与索引原样保留**（旧行为是删旧单后留脏索引；调用方核查——节点 intake 仅提交新单、恢复路径走 `restoreOpenOrders` 的 AddOrder 且只恢复 status=open 的单、同步走 ReplaceOrderbook——均不依赖旧语义）。

`ReplaceOrderbook` 重建口径与 `AddOrder` 完全一致：逐笔归一化过滤（无效条目跳过）→ 批内先到先得去重（含跨侧）→ 跨 pair 占用 ID 不收录 → 每侧容量截断（按输入序）→ 索引随最终簿内容重建（截断/跳过条目不建索引）；排序与容量判定（静默截断而非整批失败）口径以测试钉死（对端快照同步语义：部分陈旧数据不应让整簿同步失败）。

**测试**：新增 `node/internal/match/engine_r33_test.go` 4 项——零剩余替换单被拒且旧单+索引完好、跨 pair 重复 ID 被拒（旧单不受影响）、ReplaceOrderbook 容量截断+批内去重+跨 pair 跳过（`maxOrdersPerPair=3` 缩比验证）、ReplaceOrderbook 无效条目逐笔跳过。go vet + go test 全绿（§8）。

## 3. N4：NodeRegistry 钱包占用检查（合约）

**根因**：`register()` 有占用检查（`walletToNode[newWallet]` 须为空或等于本 nodeId），但 `updateWallet`（节点自助换钱包）与 `setNodeWallet`（管理员改钱包）都缺——任一路径都能把已绑定他节点的钱包再绑过来，`walletToNode` 与 `nodes[].wallet` 双向映射随即不一致，任何按钱包反查节点的消费方（NodeRewards 按钱包发放口径）都会被误导。

**改法**（`contracts/src/NodeRegistry.sol`）：两条路径补齐与 `register()` 同款 `require`（文案一致 `"NodeRegistry: wallet bound to other node"`）。`setNodeWallet` 的强制迁移语义明确写进注释与文档：管理员须先 `unbindNodeWallet` 释放占用再设置，不提供静默抢占——三条写路径自此共用同一不变量（钱包任一时刻至多绑定一个 nodeId；双向映射由各路径「先清旧、再写新」维持）。

**测试**：`contracts/test/NodeRegistry.t.sol` 新增 4 项——updateWallet 抢占被挡（按钱包与按 owner 两入口）、setNodeWallet 抢占被挡、同钱包幂等重设放行、先解绑后强制迁移全程双向映射一致；既有 3 项无回归。

## 4. 双链重部署（N1 善后）与现行地址

N1 动了 Vault，按全栈同版惯例用 `contracts/script/DeployR33.s.sol`（与 DeployR32 同构）双链重部署 Vault/Settlement/MakerVault。配置从第 32 轮栈逐项复制并**回读核验全等**：feeBps=1、meterKeepBps=7600、gasDeductCapBps=1000、maxFailureGasChargeQuote=5e18、Settlement 的 FD/Base 主代币/喂价引用、Vault 锁定开关、做市签名者 `ROLE_MARKET_MAKER` 登记、nodeRewards 保持 0、治理/奖励仍未接线（启用前门禁见 §7）。双链各注资：部署者向 MakerVault 存 1000 USDT（→ 金库再存交易 Vault）、测试钱包各存 1000 USDT 与 0.05 基础代币；最终回读双链一致：金库 `totalAssets=1000e18 / totalSupply=1000e18`、交易 Vault 持 USDT 2000 + 基础代币 0.05。

| 链 | 合约 | 第 32 轮（已被取代） | 第 33 轮（现行） | 部署 tx |
|---|---|---|---|---|
| Sepolia | Vault | 0x7D166575797344F88E6F97EaAA26CaFdb1814E6B | **0x66D4DE542d6329D2b6631170fCD773Ce2518E890** | 0x083e7674eddc06b4aa51be0ec4e86186c0163783a80d38ade764538ec0286559 |
| Sepolia | Settlement | 0x6515b9E8900A9491127c2ff65AD974A8691A468c | **0xa3F8cBCDc1533299D37836ea80d5004FF59f9094** | 0x97413c8867470dd2aaeaf1816e08ed36f46a95025f6f1f878dca8c3313463414 |
| Sepolia | MakerVault | 0xF583A03eDc237c8Ac64e5B07098B59aBC5382053 | **0x41c0f50f9Ff4D895eb33C1590B6DEDCa6C06857a** | 0x02bda87f310cbc459ca6fba8c6a741ccc11285c44cc23b9605a879c0d014e493 |
| Base Sepolia | Vault | 0x6Dd559f35BCE665722035E2231d834502C9E6683 | **0x60eaeb651371268EAA96bc0F45ec20Ed000f7b4A** | 0x4b7ee641fd3559d00099c681b9f427158ea4a9880df1a8ce2a414d7f3f98368c |
| Base Sepolia | Settlement | 0xE9134a6EDAD9De42936F38370f17cf9c0cf067cD | **0x39037dE0a1d6ca567d50055522f7Ef825dF4FCf9** | 0xc8b570c054c3a01c1700bdd0ee26a767b5ebac2db4488c8d86a15ae22d263f01 |
| Base Sepolia | MakerVault | 0xC3C449d2031dF6D4D267Fa7E5316579CECC75912 | **0x35366FB236b67f43A3287efa8f0b461DfC9E3279** | 0x20cf4c1e513dc1d51c87d1f304f349dc0d6d190ffe7fd87aee516c66fcc8ccee |

前端 `frontend/src/config/chains.ts` 已切新地址，地址钉死测试（chains.test.ts、orderSigningTypes.test.ts）同步更新期望值；全仓前端源码无旧栈地址残留（已 grep 核查）。

**部署者余额**：部署前 Sepolia 0.061782 / Base Sepolia 0.009457 ETH（足额，未取水）；全部部署+注资+ E2E 后 Sepolia 0.061169 / Base 0.009364 ETH。过程记录如实备注两点：①首跑 Sepolia 时部署脚本误设 `--gas-limit 12000000` 上限，本地模拟阶段 OutOfGas、先行核对余额/nonce 确认零上链影响后去掉上限重跑成功（沿用低 gas 价参数口径）；②本轮测试钱包的双链模拟代币余额为 0（第 32 轮注资后钱包侧已转空），由部署者先行转付所需代币（Sepolia：向 maker 转 0.05 BTC `0xc245c7d4…`、向 taker 转 1000 USDT `0x17383a78…`；其后入金 tx：部署者存金库 `0x11008475…`、maker 存 BTC `0x8bf98a20…`、taker 存 USDT `0x020f4183…`；Base：部署者存金库 `0x98d6cdb9…`、maker 存 USDT `0xcb238071…`，余笔（部署者转 taker ETH、taker 存 ETH）哈希在执行通道被平台脱敏，最终持仓以链上回读为准——见上段回读口径）。

**旧栈残值**（资金留在第 32 轮合约、可随时提取）：Sepolia 旧 Vault USDT 1999.988 + BTC 0.0499998、旧 MakerVault totalAssets 1031.421509267366734（份额 1000，随喂价浮动）；Base 旧 Vault USDT 1999.9994 + ETH 0.0499998、旧 MakerVault totalAssets 998.470483940556634（份额 1000）。

## 5. 节点切换与双链 E2E（块 3）

- 节点配置（`~/workspace/bite100-node/{sepolia,base}/config.yaml`）与看门狗模板（`~/workspace/tools/bite100-node/ensure.sh`）四处结算/金库引用切第 33 轮栈并重启；启动日志实证 `[lock] … vault=新 Vault、[settle] Settlement … settlement=新 Settlement`，`bite100-node-sepolia` / `bite100-node-base` 均 active，本机 8080/8081 与公网 `node.aaxx123456.trade` / `node-base.aaxx123456.trade` 健康检查全过。
- 本轮有节点代码变化（§2 引擎），按 `-buildvcs=false` 重建二进制替换 `~/workspace/bite100-node/bin/p2p-node`（新 md5 `fcec1e71…`，旧二进制留 `p2p-node.bak-r32`），停服换版重启后健康全过、SQLite 订单/交易记录完整读回。
- **双链真实结算 E2E**（与第 32 轮同构：对手签名卖单 → 第三方非下单人 EOA 预锁 L2 实证 → 金库 ERC-1271 买单 → 节点撮合 → 提交器结算 → NAV 逐 wei 对账）：
  - Sepolia（BTC/USDT 0.002 @ 60000）：预锁 tx `0xd5416ede8bba3526fd80c5b28cea29b1ed7d069b32db3bfb59f40845fab1fa9d`（收方=新 Vault，receipt 核对）、结算 tx `0x86fa42804f9a9d89773414964b6b608962ea416d20934320921f0066367fbef7`（收方=新 Settlement，receipt 核对）；NAV 对账 `totalAssets = 1031421509267366734000` 与「金库账内 USDT 880 + BTC 0.0019998 × 喂价」精确相等。
  - Base Sepolia（ETH/USDT 0.002 @ 3000）：预锁 tx `0xf960060d581748af728a7dd900c87b5544109466f46c2b26589434f6708a0677`、结算 tx `0x54437b1254cd574077a4ea8cd5d73edb215e2f2a359812f10a88c1dc2f3a459e`（收方同法核对）；NAV `998470483940556634000` 精确相等（账内 USDT 994 + ETH 0.0019998 × 喂价）。

## 6. CI 对齐与 ABI 防漂移（块 6 小项）

- **CI**：`.github/workflows/node-tests.yml` 的 setup-go 由 `1.24` 对齐 `go.mod` 的 `1.26.8`（与 node/Dockerfile 的 golang:1.26 口径一致，ChatGPT 复审小项闭环）。
- **ABI 防漂移（轻量版落地）**：新增零依赖脚本 `frontend/scripts/check-governance-abi.mjs`——把 `config.ts` 的 `GOVERNANCE_ABI` 每条 function/event 签名与 forge 产物 `Governance.json` 逐条规范化比对（名称 + 输入/输出类型 + view/pure + indexed 位图；前端声明子集合法、合约多出不算漂移）；接入 `.github/workflows/contracts.yml`（forge build 之后一步，并把 `frontend/src/config.ts` 与脚本本身加入触发路径），前端侧 `npm run check:abi` 可本地跑。实测：现行树 9/9 条一致通过；故意删掉 `executableAt` 字段（第 32 轮同款漂移）即被拦下并给出产物对照行。本轮只覆盖 GOVERNANCE_ABI（漂移实际发生处）；其余手写 ABI 如需同法覆盖，复用脚本加合约名参数即可，不另建管线。

## 7. 启用前门禁（承接第 32 轮 §6，本轮补强）

治理与 NodeRewards 仍未接线启用（Settlement 的 `nodeRewards` 双链为零、无实际资金风险）。启用前必须逐项关闭以下门禁，口径在第 32 轮文档 §6 的基础上按 ChatGPT 复审意见补强：

- **Governance 选民集门禁（补强）**：除第 32 轮已列的「可审计贡献记录 + 周期快照」外，本轮明确其**数据前提缺口**——现行 `NodeRegistry` 只记录 nodeId / 钱包 / 注册时间，**不记录任何贡献数据**，链上没有任何可快照的贡献来源。故本门禁的关闭标准必须包含：**可审计的贡献记录与周期快照机制——快照生成者、快照区块、选民资格与 Merkle 根的绑定关系**四要素齐备且可复核，缺一不算关闭；在此之前 Governance 的选民集评级不得按现行代码认定。
- **NodeRewards 身份门禁（更新）**：N4 已在本轮修复——NodeRegistry 三条写路径的钱包占用不变量与双向映射一致性已统一（§3），「同一钱包被两节点占用」的误导面关闭。本门禁剩余两项仍为启用前必修：nodeId 全局唯一性的**接入层**保证（合约外分配/注册流程）、以及发放前的**贡献验证**（与 Governance 门禁共用同一套贡献记录与快照机制，不得各建一套）。
- 其余门禁（治理多步执行、多签/时锁接线、DHT 生产 bootstrap、ABI 防漂移全覆盖）维持第 32 轮 §6 口径；其中 ABI 防漂移的治理部分已由 §6 的轻量检查先行落地。

## 8. 门禁结果（最终树）

| 门禁 | 基线（第 32 轮） | 本轮结果 |
|---|---|---|
| forge test 全量串行 | 145/145（15 套件） | **152/152（16 套件）**：+VaultReentrancy 3、+NodeRegistry 4 |
| node `go vet` + `go test ./...` | 全绿 | **全绿（8 个测试包）**：+engine_r33_test 4 项 |
| frontend `npm test` + build | 233/233 + build | **233/233（23 文件）+ build 通过**（地址期望值已随新栈更新） |
| ABI 防漂移脚本 | —（本轮新增） | 正例 9/9 通过、负例（删字段）被拦 |
| 双链 E2E + NAV 对账 | 第 32 轮栈各一笔 | 第 33 轮栈各一笔 settled、NAV 逐 wei 相等（§5） |

## 9. 骑乘对照（集成优先核对）

| 本轮新件 | 骑乘的既有件 |
|---|---|
| Vault 重入守卫 | OpenZeppelin `ReentrancyGuard`（既有依赖，与 Settlement/MakerVault/Governance 同一导入） |
| DeployR33 | 第 32 轮 DeployR32 脚本模式（同构改写：喂价/FD/基础代币引用沿用、Vault 部署后 configure） |
| 引擎共用校验 | 引擎自身内部函数抽取（`normalizeForBook` / `checkInsertable`），无新框架 |
| NodeRegistry 占用检查 | `register()` 既有 `require` 原样平移到另两条写路径 |
| E2E 驱动 | 节点自身 match/settlement/storage 包（临时件，验毕删除） |
| ABI 防漂移 | forge 既有产物（Governance.json）+ Node 标准库零依赖小脚本，接入既有 contracts.yml |
| 前端/节点切换 | chains.ts 地址常量与既有 config/ensure.sh 模板位点，无新机制 |
