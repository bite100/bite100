# 阶段 3：合约轮 + 前端撮合（Route A 签名方向 / B 开放提交 / 原子批结算）

> 无节点迁移 §8 第三大步。分支 `stage3-contract-matching`（基线 main
> f6a8123），2026-11-08 实施。**本轮未 push、未 merge、未部署**：所有
> 改动只在本地分支与本地 anvil 验证；双链重部署与地址切换是切换日的
> 独立一步，等 3A soak 结案（2026-11-15 13:41:43 JST）后由主聊天单独
> 发令（runbook 在 §7）。正在跑的 3A soak 未受任何影响（未重建包、
> 未重启服务、未动其代码路径的线上行为）。

## 1. 本轮结论先行

- **Route A 落地**：订单方向 `side`（uint8，0=BUY / 1=SELL）进入
  EIP-712 签名结构体末位，前端/节点/中继/合约/索引器五方同轮同步，
  跨语言向量三方逐字一致。第 36 轮起的 SIDE_UNPROVABLE 过渡体制结束：
  dualread 逐单方向证明真实放行可证明订单、对旧结构体订单继续
  fail-closed。
- **Settlement 开放提交（模型 B）**：settleTrade 与三个批入口的提交者
  门禁（relayer 校验/限速/信誉门）全部移除，任何地址可提交有效 Fill；
  合约强制校验（签名、方向、落锁、累计成交、过期、nonce、价格）不减。
  gas 分成记实际提交者（msg.sender）。
- **ERC-1271 长度门修复**：65 字节门槛删除——65B+合法 v 走 ECDSA 快
  路径（行为与旧实现逐字一致），其余长度只要签名者有代码即转
  IERC1271.isValidSignature，变长智能钱包签名（如 Safe 多签编码）
  可达 1271 路径；无效 v 的 65B 签名不再在拆签处 revert。
- **原子批结算**：既有 settleTradesBatch 系列入口沿用（第 12.3 节
  epoch 批结算，不另起炉灶），批大小硬顶收敛为合约常量
  `MAX_BATCH_SIZE = 50`（原三处内联字面量）；记账/gas 对半/FeeDistributor
  99/1 与单笔完全同路径（`_settleOne` 共用）。
- **Vault ⑥**：`lockForOrder(order, signature)` 删除调用者自填的方向
  参数 `payWithTokenIn`，落锁方向只从签名 `order.side` 派生——「落锁
  方向 == 签名方向」由构造保证，另有测试以方向相反的锁尝试结算必须
  失败作证。
- **前端撮合开启（灰度）**：新模块 `services/matching/` 骑 dualread
  可成交集做本地撮合（规则逐条移植节点引擎），市价扫簿走批结算自提
  （预检模拟 + 陈旧腿剔除 + 50 档上限 + 整批原子底线）。开关
  `VITE_FRONTEND_MATCHING` 默认关，关时下单路径零变化（回滚点）。

## 2. 块 A — 合约（contracts/）

提交：ae24be6（核心）、3961579（测试迁移+专项）、1a97902（规格改版）。

| 项 | 落点与要点 |
|---|---|
| A1 side 入签名 | `Settlement.Order` 与 `Vault.VaultOrder` 同步加 `uint8 side`（末位）；类型串 `Order(string orderId,address userAddress,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,uint256 price,uint256 timestamp,uint256 expiresAt,uint256 nonce,uint8 side)`；常量 SIDE_BUY=0 / SIDE_SELL=1。语义相对签名交易对朝向：SELL 付 tokenIn、BUY 付 tokenOut。规格见 `docs/eip712-order-spec.md` 改版（§9 写明旧结构体订单自切换起全部作废、无兼容路径） |
| A2 验签重构 | `verifyOrderSignature` 重构：65B 且 v∈{27,28} → ECDSA 恢复比对（快路径与旧行为一致）；其余情况签名者有代码 → 1271；无代码 → false。MakerVault 65B 路径回归测试在册。新增 `Mock1271Wallet`（接受属主 65B 签名 + 任意尾随字节）模拟变长智能钱包签名 |
| A3 开放提交 | settleTrade / settleTradesBatch / settleTradesBatchWithGasSavings / settleTradesBatchWithMerkle 四入口删 `_isSettlementCaller`、限速、信誉门；滥用面测试：陌生人提交篡改 Fill 回滚且 maker 资金无损、重放被累计记账拦截、陌生人可提交有效 Fill 并得 gas 分成 |
| A4 批上限 | `MAX_BATCH_SIZE = 50` 常量替换三处内联 `len <= 50`；理由：单腿约 200–300k gas，50 腿约 10–15M < 30M 区块上限之半。批原子性测试（一腿坏整批回滚）与上限测试（51 腿回滚）在册 |
| A5 方向强制 | `_verifyFill` 新增：双方 side ∈ {0,1}、maker 付款 token 必须等于按其 side 派生的付款侧、taker 同理、且两侧方向必须相反（同向对不能结算） |
| A6 测试 | 基线 152 → **167/167**（+Stage3.t.sol 15 例：side 被签名绑定/非法 side/方向不符/同向对/篡改 side 落锁/BUY 只锁 tokenOut/陌生人结算/批原子/批上限/变长 1271 全程/MakerVault 单被陌生人结算等）。信誉测试按 B 模型改写（分数归零不再阻断结算）；VaultLocking 的旧方向参数死测试改为「落锁方向只从签名派生」 |

**⚠ 标记待裁定（不自行改判）**：`chargeFailedSettlement` **保留**
`_isSettlementCaller` 门禁。理由：该入口的 reporter 由被扣款用户的
Vault 余额领钱、其 gas 消耗不在链上可验，开放给任意地址等于允许
自报 gas 掏空他人余额；且 B 模型下失败结算的 gas 本就由提交者自担
（交易回滚即自付），「发起者自担」已由开放提交本身满足。举报考销
维持受信角色（无节点提交器持 relayer 角色即可）。relayer 管理与
信誉机器保留（ABI/存储兼容），仅不再 gate 结算路径。

## 3. 块 B — 九个面同步落地表

| # | 面 | 落点 | 提交 |
|---|---|---|---|
| ① | 前端签名构造 | `orderSigningTypes.ts`（ORDER_TYPES + side、SIDE_BUY/SELL 常量与互转）；`orderService.ts` / `OrderBookSection.tsx` / `LimitOrderFormWidget.tsx` 三处下单构造带 side；`orderVerification.ts` 本地验签消息带 side | 34e7f4b |
| ② | 前端验签 + digest + 证明门 | `dualread/digest.ts` 重构把源行自报 side 写进签名消息（篡改副本自成候选、验签必失败）；`sideProof.ts` 定名 `side`、证明输入改由重构签名消息提供；`protocol.ts` SIDE_PROOF_AVAILABLE=true 并写明切换纪律；`evaluate.ts` 阶段 3 附注（锁旗标只作观察的语义不变） | 34e7f4b |
| ③ | 节点（Go） | storage.SignedOrder.Side；BuildSignedOrder 映射 buy→0/sell→1、未知值映射非法哨兵 0xff 且验签/接单/撮合三层 fail-closed；EIP-712 类型/typed-data/ABI 元组贯通；跨语言向量换新常量（side=1 digest+sig、side=0 digest）；lock.go 删 payWithTokenIn、方向只从签名派生；API 接单层 buy/sell 白名单；节点 SQLite 旧簿在切换时按 runbook 清理（节点以新域重建簿，旧行验签必失败不会进新簿——代码侧由 fail-closed 保证，运维侧清库动作见 §7） | 4a41138 / 4d9a872 / c34ed5b |
| ④ | 中继（relay Worker） | `relay/src/orders.ts` ORDER_TYPES + SignedOrder.side + buildSignedOrder 映射；全仓形状拷贝点清扫（helpers/金库单/demo/1271 冒烟）；类型串断言、side 绑定断言、跨语言向量 digest 与验签断言（单测 20→25）。未部署 | eaa5183 |
| ⑤ | Settlement 验签 | 块 A2 | ae24be6 |
| ⑥ | Vault 方向一致性 | 块 A5 + Vault lockForOrder 删方向参数 | ae24be6 |
| ⑦ | ERC-1271 端到端 | 合约层：Stage3.t.sol 变长签名全程结算 + MakerVault 单被陌生人结算（1271 验签过）；节点层：既有 anvil 1271 全流程测试（TestAnvilVaultERC1271Settles）在新结构体下随套件通过；中继层：1271 冒烟脚本同步新结构 | ae24be6 / 4d9a872 |
| ⑧ | 部署脚本 + 地址/ABI plumbing | `contracts/script/DeployStage3.s.sol`（骑 DeployR33 同构：三件套一次广播、配置 1:1 复制、CHAIN 护栏）；前端 `settlementAbi.ts` 自新工件再生（Order 元组末位 side）；`vaultAbi.ts` 新生成（落锁子集）；indexer association ABI 同步（⑧ 内）；地址回填点清单见 §7 | 320270a / 34e7f4b / 617d47d |
| ⑨ | 历史订单作废 | 规格 §9 定版：旧结构体订单新域下验签必失败（digest 不同），前端 dualread 判 INVALID 而非 UNKNOWN；切换清理三处（节点清簿/中继清 D1/前端新域自然出局）在 §7 runbook。MakerVault 旧金库订单同理作废，金库按新参数重部署后重新挂单 | 1a97902 + §7 |

## 4. 块 C — 前端撮合

提交：0506681。新模块 `frontend/src/services/matching/`：

- **C1 撮合器**（matcher.ts）：规则逐条移植节点 `engine.go`——价格-
  时间优先（同价先到先得，前端以 orderId 字典序兜底同时间戳的确定
  性）、成交价 = maker 价、成交量 Token0 计、quote = qty×price/1e18
  整数公式（节点 DeriveAmountOut 同式）。输入只认 dualread 可成交集
  （fromEvaluated.ts：剩余量按 maker 付款视角换算——SELL 用
  remainingIn；BUY 经 filledOut 代数还原，全程 bigint）。有意口径差
  一处并写明：跳过 taker 本人挂单（自成交在节点引擎可发生，前端自提
  路径下只会白付费用）。
- **C2 批结算提交**（fills.ts / prune.ts / execute.ts）：Fill 组装与
  节点 TradeToFill 逐项同口径（maker 视角金额、gasReimburse 双 0）；
  提交前整批 staticCall 预检 → 逐腿甄别剔除陈旧腿 → 整批再模拟，仍
  不过则整单不提交（原子性底线）；档位上限 50 与合约 MAX_BATCH_SIZE
  对齐；落锁由提交者在结算前补齐双边（Vault 无许可、方向只从签名
  派生）；发送 gasLimit 显式加 25% 缓冲（块 D 实测估算低估教训，见
  §6 注）。
- **C3 双通道与灰度**：`config/matching.ts` 读 `VITE_FRONTEND_MATCHING`
  （默认关）。关：下单广播 → 节点撮合 → 节点守护提交器，与阶段 3 前
  逐字一致（回滚点）。开：广播后前端即时撮合并由用户钱包自提批结算，
  表单明示「前端撮合已开启」与结果口径行。已知代价写明：切换期双通
  道并存时同一订单可能被两路同时提交，链上累计校验保证只成一路、
  另一路回滚且 gas 自担——正式启用前端撮合时应同步收起节点提交器
  （runbook §7）。
- **C4 产品内说明**：下单票据与非票据两布局的「下单说明」各加一段
  （干什么/只吃已双重验证挂单/整批原子与剔腿/50 笔上限/市价保护价/
  自提 gas 与对半分摊口径/失败自担）；票据 gas 提示行按开关切换文案；
  开关开时提交按钮上方常驻一行明示。

## 5. 骑乘对照表（不重复造轮子清单）

| 新件 | 骑乘的既有件 |
|---|---|
| 撮合器 matcher.ts | 节点 engine.go 撮合规则与 DeriveAmountOut 公式（移植语义，不另创规则）；输入骑 dualread 可成交集与 EvaluatedOrder，不自建有效性判定 |
| Fill 组装 fills.ts | 节点 TradeToFill 口径；maker 字段重构骑 dualread 的 buildSignedOrderData（与验签同一份逻辑）；ContractOrder/Fill 类型骑 settlementService 既有接口 |
| 预检剔腿 prune.ts | ethers staticCall（eth_call 模拟）；算法只做整批→逐腿→整批三段，不自研模拟器 |
| 落锁补齐 | Vault.lockForOrder（第 30 轮 L2 无许可落锁）；ABI 骑工件自动生成的 vaultAbi.ts（与 settlementAbi.ts 同一生成方式） |
| 部署脚本 DeployStage3 | DeployR33 同构（一次广播三件套 + 配置 1:1 复制），不新写部署框架 |
| side 常量/互转 | orderSigningTypes.ts 单点定义，前端各处与 dualread 共用；数值口径与 sideProof 既有别名预留（'0'→buy/'1'→sell）对齐 |
| 跨语言向量 | ethers 生成冻结向量一份，Solidity/Go/TS/relay 四方共同断言（规范 §6） |
| 对照 E2E 驱动 | 节点侧骑既有 anvil 脚手架（loadArtifact/deploy/LockOrder/SubmitTrade）；前端侧骑生产模块（matcher/prune/ABI/签名类型）；anvil 本地链，不碰测试网 |
| **负零口径**（第 40 轮复审骑乘） | adapters.ts asIntString 字符串路径（含定点分支整数部分）把 `-0` 规范化为 `0`，与数字路径对齐；数字/字符串对照测试各一（dualread.test.ts 第 40 轮复审 describe） |
| **顶层数组拒绝**（第 40 轮复审骑乘） | requireBookSides 对 `Array.isArray(data)` 抛错按源错误处理；中继适配器改骑同一 requireBookSides（其原自有宽容解构一并收口，与节点适配器同口径）；顶层数组响应测试一条 |
| **文档状态行**（第 40 轮复审骑乘） | `docs/round40-review-followups-2026-11-08.md` 末尾状态行已改真实状态（已合并推送 main f6a8123） |

## 6. 块 D — 验证

### D1 同单对照 E2E（anvil，三套链参数各一遍：31337 / 11155111 / 84532）

同一场景两路径：maker 卖 100 TKA @2.0、taker 买 100 TKA 限价 2.5
（价格改善可测）；ChainConfig 配置计价（1 ETH = 2000 TKB）使 gas
对半真实发生；FeeDistributor 开发者地址设 anvil #3 使 99/1 可测。
节点路径 = 节点引擎撮合 + LockOrder + SubmitTrade（owner 提交）；
前端路径 = 生产 matcher/fills/prune + VAULT_LOCK_ABI 落锁 +
settleTradesBatch（taker 自提）。部署顺序/账户/订单字段三套参数下
逐字一致（地址与 digest 对照行验证）。

31337 参数对账表（compare.mjs 输出，其余两套参数结论相同）：

| 对账项 | 结果 | 明细 |
|---|---|---|
| 部署地址（五合约） | ✓ 相等 | Settlement 0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9 |
| 订单摘要（maker/taker digest） | ✓ 相等 | maker 0xff75f2f6526c5524…（跨语言同值） |
| 成交量 Token0 | ✓ 相等 | 100 TKA（100000000000000000000 wei） |
| 成交额 Token1 | ✓ 相等 | 200 TKB |
| 链上累计成交账本 | ✓ 相等 | filledIn/Out 双单逐字一致 |
| nonce 消耗 | ✓ 相等 | 双方各 +1 |
| 成交价（价格改善） | ✓ 相等 | 两路径均 2.0（taker 限价 2.5，改善 0.5） |
| 手续费总额 | ✓ 相等 | A 侧 0.01 TKA / B 侧 0.02 TKB（0.01%） |
| FeeDistributor 99/1 | ✓ 相等 | 开发者 1% 自动到账（A 0.0001 / B 0.0002），FD 留存 99% |
| gas 对半（节点路径） | ✓ 成立 | 计量 577141 gas；maker 扣 634333870111516000 TKB-wei / taker 扣 317166935055758000 TKA-wei，按成交价换算等值差 0 wei；shortfall 0；净额分解自洽 |
| gas 对半（前端路径） | ✓ 成立 | 计量 577800 gas；maker 扣 635058174952800000 / taker 扣 317529087476400000，等值差 0 wei；shortfall 0；净额分解自洽 |
| 计量 gasUsed 跨路径差 | 报告项 | Δ659 gas（批入口计量含数组解码/循环开销，逐项摊回；扣减额因此差约 0.11%，对半比例不受影响） |

注：gas「对半」的规则本体（两侧等值分摊）在两路径逐 wei 成立；
跨路径的绝对扣减额差来自合约计量范围是各自入口的函数体
（settleTrade vs settleTradesBatch），不是规则差。三套链参数下 Δ
恒为 659 gas。

**D1 附带发现（已修）**：ethers/钱包的 estimateGas 对批结算（及
Sepolia 参数下的合约部署）存在低估——anvil 上静态模拟通过、按估算
发送却 OOG 回滚。execute.ts 发送时显式以估算 ×1.25 为 gasLimit；
驱动部署同法处理。

### D2 全套门禁

| 门禁 | 结果 |
|---|---|
| forge test（contracts） | **167/167 通过**（27 suites；基线 152） |
| frontend npm test | **349/349 通过**（29 文件；基线 330：dualread 改写净 +5、matching 新模块 +14） |
| frontend npm run build | 通过 |
| node go build + go test ./... | 全包通过（settlement 含 D1 双路径测试，无 anvil 时按约定 skip；一次与 forge 并行跑时 storage 包出现资源争用型 flaky，串行复跑全过） |
| relay npm test | **25/25 通过**（基线 20） |
| indexer tsc + vitest | tsc 0 错误；**10 通过 / 2 skipped**（基线 8/2） |
| anvil 全家桶 scripts/anvil-e2e.sh | **全过**（TestAnvilE2E / TestAnvilVaultERC1271Settles / TestAnvilTxVerdict / TestAnvilMarketOrderE2E / TestAnvilStage3NodePath 五件 PASS） |
| soak 自检（report/timing） | 全过（离线，未动运行中服务） |

- soak 工具链：generator 签名消息带 side（骑共享 ORDER_TYPES/
  buildSignedOrderData 自动适配）、篡改注入场景注释改阶段 3 语义
  （中继入库验签拦截）；离线打包至 /tmp 编译通过、report/timing
  自检全过。**未重建 soak 包、未重启服务**——线上 3A 窗口继续跑旧
  结构体口径至 2026-11-15 结案，切换后 soak 需按新结构体重新基线
  （下一轮事项，不在本轮）。

## 7. 切换 runbook（切换日执行，等主聊天发令）

前提：3A soak 结案通过；主聊天发令；切换窗口内节点无
pending/retry/submitting 中的成交。

1. **双链重部署**（每链一遍，环境变量自 `~/workspace/bite100-deployer/`
   对应链的 env 读，密钥不落盘到仓库）：
   ```
   export TARGET_CHAIN_ID=11155111   # Base Sepolia 改 84532
   export OLD_SETTLEMENT_ADDRESS=<现行 Settlement>
   export FEE_DISTRIBUTOR_ADDRESS=<现行 FeeDistributor，与旧实例读回核对>
   export ASSET=<USDT> BASE_TOKEN=<BTC> PRICE_FEED=<Chainlink 喂价> SIGNER_ADDRESS=<金库签名者>
   forge script script/DeployStage3.s.sol --rpc-url <RPC> --broadcast
   ```
   记录新 Vault / Settlement / MakerVault 地址；新 Vault 注资
   （沿用第 33 轮口径，两链各 1000 USDT）与 MakerVault 存款按运营
   需要另行执行（注资是资金动作，切换日单独确认金额）。
2. **地址回填点**：`frontend/src/config/chains.ts`（两链 contracts
   .vault/.settlement/.makerVault 相应字段）；节点配置（两节点实例的
   settlement/vault 地址 env/config）；中继 `relay/src/config.ts`
   （SETTLEMENT_ADDRESS 验签域）；indexer 无需改（事件 ABI 未变，按
   新地址过滤在 Envio 后台改指向）；relay Worker 重新部署
   （`npm run deploy` 于 relay/，切换窗口内执行）；Envio 索引器对新
   Settlement 地址的登记按其后台流程。
3. **旧簿清理**：节点停机后清两实例 SQLite 订单簿（旧单新域验签必
   失败，本就不会进新簿，清库是卫生动作）；中继 D1 清表
   （`wrangler d1 execute bit100-relay-orders --command "DELETE FROM
   orders"`，表名以 relay 现行 schema 为准）；前端无需动作（新域
   自然出局，旧单在 dualread 判 INVALID）。
4. **服务重启序**：节点（新构建）→ 中继（已部署）→ 前端 Pages
   （新构建，VITE_ 系列沿用；`VITE_FRONTEND_MATCHING` 保持关，
   待节点提交器收起后再单独发令开启）→ soak 按新结构体重新基线
   后重启新窗口。
5. **回滚**：任一步失败 → 地址回填全部改回旧栈地址、服务按旧构建
   重启即可（旧合约与旧簿在切换窗口内未被动过；新合约闲置无害）。
   前端撮合开关关即回节点路径，是更细粒度的回滚点。
6. **切换后必查**：双链各跑一笔 E2E 小额结算（新栈）、Envio 双链
   同步 100%、relay /health、节点 /api/orderbook 正常、旧 Vault 锁
   残留清单给 Ren（用户自行 releaseOrderLock 或等过期）。

## 8. 未做 / 待发令清单

- 双链重部署与地址切换（§7，等 3A 结案后主聊天发令）。
- relay Worker 重新部署、Envio 索引指向新地址（随切换日）。
- 前端撮合开关的正式开启（`VITE_FRONTEND_MATCHING=on` + 节点提交器
  收起，随切换日后的单独发令）。
- soak 按新结构体重新基线并开新窗口（切换后下一轮）。
- chargeFailedSettlement 门禁去留（§2 标记项，待主聊天/Ren 裁定）。
- 价格校验修复（阶段 3 后端复审 P0：结算从无「成交比例 vs 双方签名限价」校验）：**已完成**（分支 `stage3-price-fix`，见 [stage3-price-fix-2026-11-08.md](stage3-price-fix-2026-11-08.md)）——双方限价交叉相乘强制 + 14 例新测试（forge 167→181）；**测试网切换硬前置之一：合入并复审通过后方可发令切换**。
- 节点 e2e 的 anvil 实跑在本轮以 D1 双驱动覆盖（节点路径即节点代码
  实跑）；`scripts/anvil-e2e.sh` 全家桶（含 1271/market/locking）随
  套件在本地 anvil 复跑结果见 D2 门禁行。
