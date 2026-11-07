# 第三十轮：无节点化阶段 1（订单公告栏中继）+ L2 无权限落锁（2026-11-08）

> 决策依据：Ren 2026-11-08 拍板——① 主中继 = **A（Cloudflare Workers + D1）**，
> **B（Nostr 公共中继）作并行镜像**，C 自建中继放弃；② 落锁 = **L2 无权限落锁**。
> 设计依据：`docs/nodeless-design-2026-11-07.md`（§1/§2/§4/§8 阶段 1 与 L2 条款）。
> 本轮基线 main `ad99391`，分支 `round30-nodeless-stage1`，两条腿并行：
> 腿 A = 公告栏中继（Workers + D1 + Nostr 镜像 + 前端双发）；
> 腿 B = L2 合约迁移（新 Vault/Settlement/MakerVault 双链部署 + 节点切换 + E2E）。
> 腿 B 分册：`docs/round30-l2-legb-2026-11-08.md`；中继运维手册：`relay/README.md`。

## 0. 本轮交付一览

| 项 | 状态 |
|---|---|
| 公告栏 Worker（验签入库/去重/过期下架/按链分簿/查询对齐节点形状） | ✅ 本地全链路验证通过；**未部署**（Cloudflare 凭据不足，待办见 §6） |
| Nostr 镜像（只写扇出，kind 30078） | ✅ 代码路径本地 mock 双重验通；公共中继从本 VM 实测不通（§2.3） |
| 前端下单双发（节点主发 + 中继 best-effort 副发，配置开关） | ✅ 已落地，中继 URL 未配置时静默跳过 |
| L2：Vault.lockForOrder 无权限化 | ✅ 合约已改 + 双链迁移完成 + 节点已切换 + E2E 全环通过 |
| 门禁（协调人集成复跑） | forge **140/140**、relay unit **20/20** + workers **12/12**、前端 **178/178**、relay tsc 干净 |

## 1. 腿 A：接口与实现

### 1.1 接口表（形状对齐现有节点 API，路径去 `/api` 前缀）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/orders` | 体 = 节点 POST /api/order 同形状 + 可选 `chainId`（缺省 Sepolia）。流水线：字段校验 → 按链重建签名订单 → 过期校验 → 验签 → digest 去重入库 → 触发 Nostr 镜像（异步 best-effort）。成功 `{ok, orderId, digest}`；重复投递 `{…, duplicate: true}` |
| GET | `/orders` | 参数 `chain` / `pair` / `userAddress`（兼容 `trader`）/ `limit`；过期不返回；响应逐字段对齐 node `storage.Order`，扩展 `chainId` / `digest` / `nostrEventId` |
| GET | `/orderbook` | 参数 `chain` / `pair`；`{pair, bids, asks}` 价格-时间排序、每侧上限 100 |
| GET | `/health` | 存活 + D1 连通 |

错误码与节点同口径：400 缺字段/未知交易对/不支持的链/已过期；401 签名无效。
有意差异一处：orderbook 空簿时中继返回 `[]`，节点可能返回 `null`（已在 README 注明）。

### 1.2 D1 schema 与写入纪律

`relay/migrations/0001_init.sql`：`orders` 表以 EIP-712 digest 为主键（去重 = 单条
`INSERT OR IGNORE`），存 `raw_json` 原文（便签可移植）、重建的 amount_out/token_in/token_out、
`nostr_event_id`；索引 (chain,pair,expires)、(chain,user,expires)、(expires)、(chain,order_id)。
过期处理：查询侧过滤 + wrangler cron（15 分钟）删除过期超过 1 天的行。

D1 写入纪律（外部调研结论，已落实）：D1 单库单线程（约 1000 qps@1ms）、无交互式事务——
本中继全部写入都是**单语句条件写**（入库靠 digest 主键仲裁、镜像回填是按 digest 的单条
UPDATE）；扩容方向 = 按交易对分片，不假设事务。

### 1.3 验签：双路（EOA 本地 + ERC-1271 RPC 回退）

签名订单重建与 Go 节点 `BuildSignedOrder` 逐项一致（tokenIn/Out = 交易对 Token0/Token1、
amountOut = amountIn×price/1e18、域 name=比特100 / version=1、verifyingContract 按链配置，
见 `relay/src/config.ts`，可用 `CHAIN_CONFIG_JSON` 整体覆盖）。只用 viem，不手写 secp256k1。

调研指出 viem 纯本地验签只支持 EOA、不支持 ERC-1271 合约账户（MakerVault 即是），故实现两路：
- `userAddress` 为 EOA → 本地 `verifyTypedData` 快路径；
- 本地失败且该链配有 RPC → viem 现成 `publicClient.verifyTypedData({address, …})`
  （内部查代码 + 调合约 `isValidSignature`）；RPC 出错 **fail-closed** 拒绝。
RPC 按链配置，可经 `SEPOLIA_RPC_URL` / `BASE_SEPOLIA_RPC_URL` 覆盖。

**集成同步（协调人）**：腿 B 本轮换了 Settlement，`relay/src/config.ts` 的内置默认
verifyingContract 已同步为新地址（Sepolia `0x3efb8F22…365E`、Base Sepolia `0x9711644e…12D1`）；
集成后 workers 测试按新配置动态签单仍 12/12 通过。

### 1.4 Nostr 镜像规格

- kind **30078**（NIP-78 自定义 addressable；**不套用** NIP-69 的 38383——那是 BTC/法币专用）；
- 标签：`d`=digest、`pair`、`chain`、`exp`；content = 完整订单原文 JSON（含签名）；
- **标签只是提示（hint）：任何读取方必须重新验 EIP-712 签名并核对链上状态**，不得信任
  Nostr 侧的任何状态断言（README §4 已明写）；
- 镜像为只写扇出：发布失败只记日志，绝不阻塞主入库；event id 回填入库记录。
- 邮差密钥不进仓库：本地演示由脚本从仓库外读取，生产用 `wrangler secret put
  NOSTR_POSTMAN_SECRET_HEX`。

### 1.5 前端双发

`frontend/src/config/relay.ts`：`VITE_RELAY_URL`（空 → 副发静默跳过）、
`VITE_RELAY_DUAL_SEND`（默认开，`false`/`0`/`off` 关）。`services/relayDualSend.ts` 永不抛错、
失败仅 `console.debug`、副发体附 `chainId`。三条下单路径（orderService、OrderBookSection、
LimitOrderFormWidget）均在节点 POST 成功后副发；下单成败语义只由主发决定（集成测试已证：
主发失败不副发、副发失败下单仍成功）。读路径本轮不动（阶段 2 才双读）。

## 2. 腿 A：验证证据

### 2.1 测试（腿 A 自跑；协调人在集成树复跑 relay 与前端，全绿）

- relay unit（node 环境）：**20/20**——重建/派生、验签通过/篡改失败、跨链域、validateBody、
  ERC-1271 五例、Nostr 事件组装验签、mock 发布扇出、本地 ws mock 中继真发；
- relay workers（workerd + miniflare 本地 D1、真实 SQL）：**12/12**——入库/digest 一致、去重一行、
  篡改 401、过期 400、未知对/链 400、Base 链按 Base 域入库、按对/址/链查询、存量过期行不返回、
  orderbook 聚合排序、health、镜像不可达不阻塞入库；
- 前端：**178/178**（基线 169 + 新增 9：副发单测 5 + 下单集成 4）。

### 2.2 本地全链路演示（`bash relay/scripts/run-demo.sh`，9/9 PASS）

health `{"ok":true,"db":"ok"}` → maker 测试钱包真实签名订单 POST 入库 200
（digest `0xe4b9b036…f81b`）→ 重复投递 `duplicate:true` → 按 pair 查回 → 按 userAddress 查回 →
orderbook 查回（bids=1）→ 过期单 400 → 坏签名 401 → 镜像 event id 回填 `43ef7ca3…2f0f`，
与 mock 中继日志收到的事件 id / kind 30078 / d=digest 完全一致。

### 2.3 ERC-1271 实链冒烟与 Nostr 公共中继实测（如实记录）

- ERC-1271：`relay/scripts/verify-1271-live.mjs` 对第 27 轮真实 Sepolia MakerVault
  `0xEFD02ae9…C09f` 用未注册签名者签名，经公共 RPC 得到布尔裁决 `false`（而非抛错）——
  「中继 → RPC → 金库 isValidSignature」链路真实打通。
- Nostr 公共中继：本 VM 出口经代理、wss 直连不通；`relay/scripts/nostr-probe.mjs` 对
  relay.damus.io / nos.lol / relay.nostr.band 逐个实测，**三个全部连接超时**（约 12s；
  探针事件只构造未发出）。代码路径已由本地 mock 中继双重验通；部署到 CF 边缘后需在
  可直连环境复测公共中继可达性与保留策略。

## 3. 腿 B：L2 合约改动

仅 `contracts/src/Vault.sol`：`lockForOrder` 删除 `onlyLocker` → 无权限；函数体逻辑
（强制向 Settlement 验签、摘要派生金额、判重、过期校验、可用余额校验、锁墓碑同写）一行未动；
NatSpec 同步改为 L2 口径。`onlyLocker` 修饰器定义保留作兼容挂点（注释说明）；
`lockers`/`setLocker` 保留（release 路径认 locker 或锁属用户本人）；`consumeOrderLock`
仍仅 Settlement；release 语义与 owner 权限一律未动。
新增部署脚本 `contracts/script/DeployL2.s.sol`（从旧 Settlement 链上读回复制配置，
FeeDistributor 与旧实例核对一致才继续）。

forge 新增/修订（`VaultLocking.t.sol`）：基线 131 → **140**（1 个旧用例语义反转 + 8 个新 L2 用例：
第三方落卖单/买单成功含墓碑断言、无效签名两路 revert、换人重复落锁 revert、过期 revert、
超额 revert、方向写反 fail-closed、第三方落锁后 release 语义不回归、双单第三方落锁后正常结算）。

## 4. 腿 B：L2 滥用面评估（先例对照全文）

| # | 先例/风险 | 结论 | 依据 |
|---|---|---|---|
| 1 | **Arcdesk dust-lock DoS**：无 bond 无权限落锁被用来造大量碎片小额锁占位，其修复是按 (orderId, payer) 分键 | **不成立** | 本 Vault 的锁**没有金额参数**：锁定量恒为签名订单全额义务（amountIn 或 amountOut），无法构造 dust/部分锁；锁以**订单 digest 为唯一键**且 `require(orderLocks[digest].user == address(0))` 使同一订单任何人只能落一次——没有按 payer 分裂的键空间。Arcdesk 的病根（可分片+可任意定额）在此语义下不存在 |
| 2 | 凭空锁他人资金/锁没签过的量 | **不成立** | 落锁前强制经 Settlement 验签（含 ERC-1271）并由 Settlement 算 digest；代币/金额/归属全部从验签订单派生，调用者无法传入金额或指定归属；且只能动签名者本人在 Vault 的预存余额（availableBalance 校验） |
| 3 | 抢锁 maker 已改主意的订单、冻结余额 | **残余存在，低危** | 成本近似对称：攻击者一笔 lock gas，maker 一笔 `releaseOrderLock` 自助解锁，攻击者零资金收益；占用有 `expiresAt` 硬上限（过期后任何人可 `releaseExpiredOrderLock`）；锁的恒是 maker 自签条款 |
| 4 | 方向标志 `payWithTokenIn` 被写反 | **有界残余（fail-closed + 读回校验）** | 方向不在签名覆盖内（第 15 轮既有设计，L2 只扩大「谁能给」）。另一侧无余额时落锁直接 revert（forge 已覆盖）；两侧都有余额时锁记在相反义务，但结算 consume 按锁定代币取对应侧量、划转以签名 Fill 金额为准且有余额校验兜底，无法超签名量动账，最坏是担保口径错位 + 一笔 release 纠正。缓解为既定纪律：落锁后读回 `orderLocks`(token, remaining) 比对，不一致立即释放告警；节点生产路径由订单 side 派生标志（`ObligationForOrder`），不靠猜 |
| 5 | **共享余额先到先锁挤占**：maker 多张已签订单共享一份 Vault 余额，第三方先锁 A 使 maker 本意优先的 B 暂时无法落锁 | **真实存在，不构成实际 DoS** | ① A 本就是 maker 自签条款，A 成交是合法结果非攻击收益；② maker 可一笔 release + 一笔重落锁自助重排（无时间锁、无需同意），攻击者每次重扰都要再付 lock gas 且必须持有 maker 的有效签名订单，maker 停止超签后攻击面消失；③ 占用受 expiresAt 硬上限约束；④ `locked ≤ balance` 恒成立，偿付安全与第三方资金不受影响。定性：maker 自家已签意图间的排序问题，非可用性攻击 |
| 6 | 中继/前端被垃圾锁灌水 | **不成立为新增面** | 落锁 gas 由落锁者自付，协议零消耗；已落锁订单必然有真实签名 + 余额背书，按链上过滤口径是比未落锁单更可信的簿条目 |
| 7 | 重复落锁/落锁-结算竞态 | **不成立** | 判重按 digest 与调用者无关；consume/release 权限语义 L2 未动 |

**缓解落地**：链下预检仅作提示（节点 LockOrder 先查既有锁与可用余额再发交易，只省 gas、
不改变链上语义，不表述为安全机制）；使用说明见 §8（落锁后读回校验、maker 勿超签、
被抢/错锁一笔 release 纠正）；**不做**合约层优先级队列/bond——需改签名格式三方协同，
与「一笔可纠正 + expiresAt 兜底」的风险量级不成比例，主网前若出现真实排序争议再评估。

## 5. 腿 B：迁移、新地址与 E2E

### 5.1 新地址表（双链测试网现行）

| | Sepolia (11155111) | Base Sepolia (84532) |
|---|---|---|
| Vault（新，L2） | `0x40aaCB66Bcd1b58d86FF17D3D8e800aF6cAf3b30` | `0x1bFb42E93F5860C76ef0E100E063083357b93C8A` |
| Settlement（新） | `0x3efb8F22B925FC659b46680700936243E1f8365E` | `0x9711644e3E39cec6E099e01cd4029f72244012D1` |
| MakerVault（新） | `0x253a336CbDF20B8e1A2696b7749C22ADD2159b61` | `0x04Da8F47a89421d853FeDAB572d1A62050474098` |

换 Vault 的连带重部署是接线图决定的最小集：Settlement 的 vault 指针只在构造函数设定
（无 setter）→ 新 Settlement 构造指向新 Vault，再 `Vault.setSettlement` 回指；
MakerVault 的 tradingVault 是 immutable → 只能重部署（无改指选项）。

配置 1:1 核对（双链链上回读）：governance、chainConfig、feeDistributor 与旧值一致；
feeBps 1、meterKeepBps 7600、gasDeductCapBps 1000、maxFailureGasChargeQuote 5e18 一致；
relayer/nodeRewards/founder/usdtToken/feeToken 旧新全 0；Settlement.vault → 新 Vault、
Vault.settlement → 新 Settlement、lockers(部署者)=true；金库 asset/base/feed 与旧同参
（BTC/USD `0x1b44F351…` / ETH/USD `0x4aDC6769…`），签名者 `0x05040D9e…` 重新注册
ROLE_MARKET_MAKER 并回读确认。每链 12 笔迁移 tx，receipt 全 status 1（哈希清单见腿 B 分册 §3）。

### 5.2 余额重建（回读核对）

双链金库各由部署者存入 1000 USDT → totalSupply 1000e18、totalAssets 1000e18、
部署者份额 1000e18。测试钱包：Sepolia maker 存 0.05 BTC、taker 存 1000 USDT；
Base taker 存 0.05 ETH、maker 存 1000 USDT（tx 清单见分册 §4）。过程留痕：Sepolia 首轮
两笔 Vault.deposit 因 publicnode 估算超时未发出，回读发现后以显式 gas limit 重发成功。

### 5.3 节点切换

`~/workspace/bite100-node/{sepolia,base}/config.yaml`（vault/settlement 两行）与
`~/workspace/tools/bite100-node/ensure.sh` 模板已同步新地址；双服务重启后 active，
本地与公网（node / node-base.aaxx123456.trade）`/api/health` 均 `{"ok":true}`；
Sepolia 日志确认新域 `verifyingContract=0x3efb8F22…`。**节点二进制未替换**
（重启前后 md5 均为 `d148e777047dbbee19053780c60b9a49`，本腿只改配置）。

### 5.4 E2E 逐笔证据（双链各一笔全环）

- **Base（ETH/USDT @ $2,225.29）**——L2 证明单：以 `lockers()=false` 的 maker 钱包为 taker
  卖单直连落锁，tx `0xb7fdf154…f4e9de`（status 1，digest `0x37fe0553…6494`，回读
  user=taker / remaining 0.01 ETH）；金库单结算 tx `0x89baf889…215f3`（区块 55821295）。
  对账：金库 ETH 0.009999、USDT 977.7471，NAV 回读 999.99777471 = 977.7471 + 0.009999×2225.29
  精确一致；taker ETH 0.04 / USDT 22.25067471；双方 nonce 0→1。
- **Sepolia（BTC/USDT @ $75,565.61566376）**——L2 证明单：以 `lockers()=false` 的 taker 钱包
  为 maker 卖单落锁，tx `0x1a912376…df57`（status 1，digest `0x5014766e…e2aa`，回读
  user=maker / remaining 0.01 BTC）；金库单结算 tx `0xb417d3d6…40508b`（区块 12086270）。
  对账：金库 BTC 0.009999、USDT 244.3438433624，NAV 回读 999.92443438433624 与公式精确一致；
  maker BTC 0.04 / USDT 755.58059102193624；双方 nonce 0→1。
- 两链金库单均为签名者代签、纯 ecrecover 验签为 false、经 ERC-1271 成交；
  预落锁单经节点幂等 LockOrder 放行入簿（节点 locker 兼容路径同轮验证不回归）。

### 5.5 部署者余额与旧栈退役

Sepolia 余额**未成为卡点**：动手前 0.01163 ETH，以低 gas price 参数广播后三合约部署
实耗仅约 0.00006 ETH（publicnode 的 ~7× 是计量读数、并不按此收费）；全程结束部署者余
Sepolia 0.01152 ETH / Base 0.00951 ETH。下一轮若再做 Sepolia 多合约部署仍建议先领水龙头，
仅为余量保险。

旧栈退役记录（2026-11-08 切换时点，残余测试币不迁移、仍可经旧合约提取）：
Sepolia 旧 Vault `0xF9695C43…E9f5` 残余 USDT 2999.84930395、BTC 0.049998；
旧 Settlement `0x9f063683…9890`、旧 MakerVault `0xEFD02ae9…C09f`（1000 份额、NAV 999.92430395）。
Base 旧 Vault `0x46592e98…3D50` 残余 USDT 2999.92276793、ETH 0.009999；
旧 Settlement `0x230887F4…cc85`、旧 MakerVault `0x73B55e2d…877A`（1000 份额、NAV 999.99776793）。

## 6. Cloudflare 部署状态：未部署（停在「可部署」）

实测凭据：`wrangler whoami` 未登录；`CLOUDFLARE_API_TOKEN` 未设置；`~/.cloudflared/cert.pem`
存在但为 cloudflared 隧道证书、wrangler 不可用（whoami 结果印证）；未尝试交互式 OAuth 登录。
未碰 DNS、未动既有隧道、未碰 bit100.trade 解析。

**Ren 待办（账号侧，确切步骤，全文亦见 `relay/README.md` §7）：**

1. 给 Cloudflare 账号开 **Workers Paid（$5/月）**——免费版每调用仅 10ms CPU，而官方口径
   签名校验类负载通常 10–20ms，免费版事实上不够用；
2. 在 dash.cloudflare.com 创建 Custom API token，勾选 `Account · Workers Scripts · Edit`、
   `Account · D1 · Edit`（可选 `Workers Tail · Read`）；
3. Account ID 在 Workers & Pages 页右侧获取；
4. 把 token 与 Account ID 交给 Muse（或自行在 VM 环境里导出 `CLOUDFLARE_API_TOKEN`），
   之后 Muse 跑：`wrangler d1 create bit100-relay-orders` → 回填 database_id 到
   `relay/wrangler.toml` → `npm run db:migrate:remote` → `wrangler secret put
   NOSTR_POSTMAN_SECRET_HEX` → `npm run deploy` → `curl <url>/health` + demo 复验 →
   前端设 `VITE_RELAY_URL` 重新构建（双发随即生效）。

## 7. 提交清单（分支 round30-nodeless-stage1，未 push）

- `70d8ae6` feat(relay)：Worker + D1 + Nostr 镜像 + 测试 + 脚本 + README（腿 A）
- `0c6df26` feat(frontend)：下单双发（腿 A）
- `73bb85b` feat(vault)：L2 permissionless lockForOrder + dual-chain redeploy（腿 B）
- `87c135d` merge：腿 B 并入集成支
- 集成提交（协调人）：`relay/src/config.ts` 默认 verifyingContract 同步新 Settlement + 本文档

## 8. 使用说明（功能变更）

**公告栏中继（给前端/运维）**
- 干什么：无许可的订单公告栏——接收 EIP-712 签名订单、验签入库、供按对/地址查询与
  订单簿聚合；不撮合、不记成交状态，订单可吃性以链上状态过滤为准。
- 使用前提：部署完成（§6）且前端构建时设置 `VITE_RELAY_URL`；未部署前双发自动静默跳过，
  现网下单不受任何影响。
- 操作：本地跑 `cd relay && npm install && npm run dev` 后用 `bash scripts/run-demo.sh`
  复现全链路；投递订单 = POST /orders（体与节点下单同形状）；查询见 §1.1 接口表。
- 注意事项：ERC-1271 合约账户（金库）订单的验签依赖 RPC，RPC 不可用时这类订单会被
  fail-closed 拒绝（EOA 不受影响），生产建议换自备 RPC；中继存的 filled/status 是投递
  自述、不作数。

**L2 无权限落锁（给 maker / 前端 / 任何落锁者）**
- 干什么：任何人可为任意**验签有效**的签名订单调 `Vault.lockForOrder` 落锁，不再需要
  locker 白名单；节点既有 locker 路径继续可用（兼容）。
- 使用前提：订单必须已签名、未过期，且 maker 在（新）Vault 里有足够可用余额；
  落锁量恒为订单全额义务，调用者只能给方向标志 `payWithTokenIn`（由订单 side 派生）。
- 操作步骤：签单 → （发公告栏/节点）→ 任一账户调 lockForOrder → **落锁后读回
  `orderLocks[digest]` 的 (token, remaining) 与本意比对**，不一致立即 `releaseOrderLock`
  纠正；撤单仍是 maker 本人 `releaseOrderLock`，过期后任何人可 `releaseExpiredOrderLock`。
- 注意事项：maker 不要超签——多张已签订单共享同一份余额时先到先锁，被先锁的单占用
  余额后其余单暂时落不了锁（可一笔 release 自助重排）；方向标志写反在对侧无余额时
  直接 revert、两侧都有余额时口径错位但无法超签名量动账，发现即 release 纠正。

**金库（承接第 27 轮说明，地址已换）**：新 MakerVault 地址见 §5.1；存款/取款/NAV
口径与第 27 轮一致（ERC-4626），签名者仍为 `0x05040D9e…`（ROLE_MARKET_MAKER 已重新注册）。

## 9. 已知限制

- 中继**未部署**：双发在 `VITE_RELAY_URL` 配置前不生效；Nostr 公共中继的可达性与保留
  策略只能在部署后于可直连环境实测（本 VM wss 全超时，属环境限制非代码问题）。
- ERC-1271 验签依赖公共 RPC（延迟与可用性）；中继不做市价单对手盘预检（节点有），
  市价单按普通单入库，IOC 语义留阶段 3 前端撮合。
- 方向标志 `payWithTokenIn` 不在签名覆盖内（第 15 轮既有设计），靠落锁后读回校验兜底；
  根除需订单格式三方变更。
- 前端 ChainConfig 无 MakerVault 字段（金库无 UI，第 27 轮既有限制），金库新地址以 §5.1 为准。
- 旧栈残余测试币未迁移（§5.5），仍可经旧合约提取；本轮未做提取。
- 主网门禁不变：L2 下 locker 仅剩 release 兼容角色、换 Vault 的余额迁移方案需在主网
  清单改写（本轮不擅改判）；DVN 1-of-1 未碰；失败扣费主网默认关闭等既有门禁照旧。

## 10. 后续阶段衔接与合并提示

- 阶段 2（前端双读）开工时：中继读路径已就绪（形状对齐），前端按数据源开关灰度即可；
  若 Settlement 再换地址，中继只需改 `CHAIN_CONFIG_JSON` 或 `relay/src/config.ts` 默认值。
- 阶段 3 的市价原子批前提（预检 + 剔除过期腿 + 档位上限）与索引器（Envio 优先）均为
  已拍板事项，不在本轮范围。
- **合并提示（给主聊天）**：本轮基线为 `ad99391`；其间 main 已因第 28/29 轮前进
  （已知至少到 `ba081af`/`5b35cff`）。第 28 轮重写过 `OrderBookSection.tsx` 与
  `LimitOrderFormWidget.tsx`——正是腿 A 双发改过的两个文件，本分支并回 main 时这两个
  文件大概率冲突，需把双发钩子手工移植到第 28 轮版本上；`chains.ts` 与
  `orderSigningTypes.test.ts` 的地址断言亦需与 main 现状对齐复核。节点侧：第 29 轮的
  节点修复与本轮的配置切换共用同一对线上服务，本轮切换只改配置未换二进制
  （md5 `d148e777…` 前后一致），与第 29 轮成果不冲突。
