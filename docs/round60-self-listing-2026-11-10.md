# 第六十轮：用户自助上架（permissionless self-listing）

> Ren 2026-11-10 01:34 亲自下开工令。口径（不可改）：谁的币都能上（粘贴合约地址即可，
> 无审批/治理门槛）；价格要有参考（骑现成聚合报价，查不到老实显示「暂无参考价」，绝不编造；
> 参考价只作预填与偏离警告，成交价以订单簿为准）；最低交易额现阶段不设（Ren 2026-11-10
> 查各家做法后定案：订单簿型场所多在 $1–$10、AMM/意图型多不设；本项目现阶段照后者，
> **主网阶段按链 gas 成本再设**，见 §4.3）；假币/诈骗币风险
> 按知情选择规则在上架确认前与交易区显著披露；平台只做中介撮合，不下场、不背书。
>
> 本轮状态：本地构建 + 本地验证 + Sepolia E2E；**不部署生产**（中继 Worker 与 Pages 的
> 部署是主聊天复验后的独立步骤）。合约零改动（Vault/Settlement 不碰）。

## 1. 调研结论（先查资料再定方案）

### 1.1 参考价数据源：DexScreener（主） vs GeckoTerminal（备）

| | DexScreener API | GeckoTerminal API |
|---|---|---|
| 费用/密钥 | 免费、无 key、无付费档 | 免费、无 key（付费档走 CoinGecko /onchain） |
| 按代币地址查价 | `GET /tokens/v1/{chain}/{tokenAddresses}`（逗号分隔，单次最多 ~30 个），返回该代币的池子数组（裸数组），每项含 `priceUsd`（字符串）、`baseToken/quoteToken{address,name,symbol}`、`liquidity.usd`、`chainId`（字符串 slug） | `GET /simple/networks/{network}/token_price/{addresses}`（最多 30 个）；另有 `/networks/{network}/tokens/{address}`、`/tokens/{address}/pools` |
| 限流 | 数据端点 300 次/分钟（profile 类 60 次/分钟）；超限 429，无 Retry-After | 免费公开档约 10–30 次/分钟（官方文档口径 ~30，第三方实测 ~10），明显更紧 |
| 链标识 | slug：`ethereum` / `base` / `bsc` / `polygon` / `arbitrum` / `optimism` 等 | network id：`eth` / `base` / `bsc` 等 |
| 实测 | 2026-11-10 本轮实测 `GET /tokens/v1/ethereum/0xC02a…6Cc2`（WETH）返回 200，首项 Uniswap v3 WETH/USDC 池 `priceUsd="2132.080"`、流动性与成交量字段齐全 | 未逐项实测（限流口径已足够定主备） |

**定案：主用 DexScreener**（限流宽 10 倍、批量端点一次查 base+quote 两代币、返回结构
直接带池子流动性可挑主池）。GeckoTerminal 只在文档里记为备选，本轮不接（避免双源
口径打架；后续若 DexScreener 覆盖不足再加）。

**诚实边界**：两家都不索引测试网（Sepolia / Base Sepolia）。因此测试网阶段自助上架的
代币在 DexScreener 上必然查不到 → 参考价如实走「暂无参考价 → 本所最近成交/盘口中间价
兜底」（第 23 轮既有口径），绝不拿别的资产的价格冒充。主网链（1/8453/56/137/42161/10）
才有 slug 映射；无映射的链直接返回无参考价。

### 1.2 代币元数据：链上 ERC-20 直读

name/symbol/decimals 一律链上读（ethers/viem 现成 `symbol()/name()/decimals()`），
不用任何第三方元数据 API——地址即真源，无键、无限流口径问题、防符号伪造
（注册表里的符号以中继链上复读为准，见 §3）。

## 2. decimals 摸底（本轮头号技术风险，先行结论）

签名订单的规范事实（docs/eip712-order-spec.md + 合约/中继/前端三方代码核对）：

- 签名结构里 tokenIn 恒为交易对的 base（Token0）、tokenOut 恒为 quote（Token1），
  与买卖方向无关；BUY 付 tokenOut 收 tokenIn，SELL 反之。
- `amountIn` = base 的**原始最小单位数量**；`amountOut = floor(amountIn × price / 1e18)`；
  `price` 是签名内的比值字段。
- Settlement **不**校验 `amountOut == amountIn×price/1e18` 的等式（第 33 轮后改为用
  amountIn/amountOut 交叉相乘校验限价，见 Settlement.sol 填充校验注释）；真正绑定的是
  amountIn/amountOut 两个原始量。中继验签重建时按同一公式由 body 的 price/amount 派生
  amountOut——所以**前端签名值与中继派生值必须逐位一致**，这是唯一的硬约束。
- 撮合引擎（matcher/fills）、Vault 落锁（按 side 锁 amountIn 或 amountOut 原始量）、
  Settlement 结算，全是原始整数运算，**与 decimals 无关**。

**结论（任意 decimals 的正确编码）**：设 base 小数位 b、quote 小数位 q、用户填的人类价
P（quote/base 人类单位）。令签名 `price = P × 10^(18 + q − b)`、`amountIn = 数量 × 10^b`，
则派生 `amountOut = 数量 × P × 10^q`，恰好是 quote 的原始单位量。**公式与合约零改动**，
只需把前端现行写死的 `parseUnits(x, 18)` 改为按对计算的缩放：
- 数量缩放 = b；
- 价格缩放 = 18 + q − b（下称「价格小数位」；种子对 b=q=18 时退化为 18，与现行完全一致）；
- 展示反向换算同理：人类价 = 原始 price / 10^(价格小数位)，人类量 = 原始 amount / 10^b。

现行写死 18 的位置（本轮逐个改按对换算，种子对行为不变）：
下单表单 LimitOrderFormWidget（parseUnits ×3 + formatTokenAmount 展示）、
orderService.submitOrder（parseUnits ×3）、OrderBookSection 自带下单路径、
useRelayOrderBook / OrderBookWidget / TradeTabsPanel / useTradesOHLC 的 fromScaled(÷1e18)
展示换算、utils.formatTokenAmount（Vault 余额展示，改为可传 decimals）。

## 3. 中继注册表设计（relay/）

### 3.1 表与键

新增迁移 `relay/migrations/0002_pairs.sql`：`pairs` 表
`(chain_id, pair_key)` 复合主键；字段：base_token / quote_token（小写地址）、
base_symbol / quote_symbol / base_name / quote_name、base_decimals / quote_decimals、
creator（自报地址，仅信息）、created_at。索引 `(chain_id, created_at)`。

- **新 pair 键（地址型）**：`<chainId>:<base地址>/<quote地址>`（地址小写），
  如 `11155111:0xabc…/0xdef…`。键自带链与双代币地址，订单的 pair 字符串即此键；
  中继下单校验时解析键 → 查注册表 → 地址必须逐一吻合（大小写不敏感比对后以注册表为准）。
- **种子 8 对保持符号键不变**（`BTC/USDT` 等）：继续走 config.ts 的内置代币表，
  不入注册表表，行为零回退（既有订单簿/下单/撮合/测试全部照旧）。

### 3.2 端点

- `POST /pairs`：body `{chainId, baseToken, quoteToken, creator?}`。
  中继**不信任提交方自报的元数据**：经该链 RPC（现行 config 的 rpcUrl，骑 viem
  publicClient，与 ERC-1271 回退同一条 RPC 通道）链上复读两代币的
  symbol/name/decimals + 合约代码存在性，复读成功才落库；元数据以链上为准。
  响应：新建 201 `{ok, pair: <注册表行>, pairKey}`；已存在 200 同体加 `duplicate: true`（幂等）。
- `GET /pairs?chain=`：返回该链已注册的自助上架对数组（种子对不在内，前端本地合并）。
- `GET /pairs?chain=&pair=<键>` 不单设：列表已够前端缓存使用。

### 3.3 下单校验改动

`POST /orders` 的代币解析改为：符号键 → 内置种子表（原路径）；地址键 → 注册表查询
（键内 chainId 必须与订单 chainId 一致、地址与注册行一致、未注册/对不上 → 400
`unknown pair` 同口径拒绝）。验签重建其余逻辑不变（buildSignedOrder 增加一个
「显式代币」入口，种子路径保持原函数与原测试不动）。

### 3.4 滥用护栏（文档口径，代码同轮落地）

- 格式：chainId 必须是中继支持的链；地址必须 0x+40hex；base ≠ quote；零地址拒；
  creator 若给必须是合法地址。
- 链上门槛：两代币地址都必须有合约代码，且 ERC-20 元数据可读（symbol/name 非空、
  decimals 为 0–255 的整数）；读不到 → 400 拒绝（防把 EOA/假地址注册进来）。
- 幂等：同 (chain, base, quote) 重复注册返回既有行，不新建、不报错。
- 限流（基础口径）：同一 creator 地址每 UTC 日最多注册 50 个对；全链每小时最多
  新增 200 个对（D1 COUNT 校验，超限 429）。无 creator 时按全链口径计。
  中继是无鉴权的哑公告栏，这只是防灌水的基础线，不是准入审核——口径如实写明。
- 符号真实性提示：元数据链上直读只能保证「这个地址的合约自称这个符号」，同名假币
  无法靠元数据区分——这正是前端必须披露「合约地址须自行核对」的原因（见 §4.4）。

## 4. 前端设计

### 4.1 交易对解析层（新 `frontend/src/services/pairRegistry.ts`）

- 类型：`TokenMeta{address,symbol,name,decimals}`、`ResolvedPair{pair,displayPair,base,quote,source:'seed'|'listed'}`。
- 键工具：`buildPairKey / parsePairKey / isListedPairKey`（纯函数，可测）。
- 种子解析：由 chains.ts 的 tokens 表构造（种子代币均为 18 位 MockERC20，文档明示）。
- 注册表客户端：`fetchListedPairs(chainId)`（RELAY_URL + 8 秒超时，骑第 54 轮
  withTimeout/AbortSignal 口径；模块级缓存 + 失败不缓存）、`registerPair(...)`。
- 同步解析 `resolvePair(chainId, pair)`：种子直解；地址键查缓存（未命中返回 null，
  由 hook 触发拉取后重渲染）。`hooks/useResolvedPair.ts` + `hooks/useListedPairs.ts`。
- 换算工具（纯函数，可测）：`priceDecimalsFor(base,quote)=18+quote.decimals−base.decimals`、
  `humanPriceToRaw / rawPriceToHuman / humanAmountToRaw / rawAmountToHuman`
  （内部骑 ethers parseUnits/formatUnits，不手写定点）。
- `config/pairs.ts` 的 `getPairTokens` 增加注册表缓存兜底（地址键 → 缓存中的地址对），
  使既有调用方（下单表单/页签面板/资产页等）对自助对自动可用；种子路径不变。

### 4.2 参考价（扩展第 23 轮 `services/referencePrice.ts`）

- 新模块 `services/dexReferencePrice.ts`：DexScreener 客户端（骑 fetch + 超时；
  slug 映射仅主网链；挑流动性最高的池取 `priceUsd`；60 秒模块缓存；deps 可注入便于测试）。
- 解析优先级（自助对）：DexScreener（base/quote 两侧 USD 价 → 对价 = baseUSD ÷ quoteUSD；
  只有 base 侧且 quote 为美元稳定币符号时用 baseUSD）→ 本所最近成交 → 盘口中间价 → 无。
  种子对维持现行：Chainlink → 本所兜底（不叠 DexScreener，口径不回退）。
- 来源标签新增 `dexscreener: 'DexScreener 聚合报价'`；面板展示口径与第 23 轮一致
  （标注来源与数据时间，只预填/警告不拦截）。测试网链无 slug → 直接无此源，
  面板如实显示本所兜底或「暂无参考价」。

### 4.3 最低交易额：现阶段不设，主网按链设（Ren 2026-11-10 定案，取代 11-08 的 $1 口径）

本轮初版按 2026-11-08 口径实现了 $1 下单侧硬校验（三锚估值：美元参考价 →
稳定币计价 → 计价币面值；模块 `services/minOrder.ts` + 两处下单路径拦截 + 实时
提示）。2026-11-10 Ren 要求先查各家做法再定：中心化订单簿多在 $1–$5（币安 5、
Bybit/Coinbase 约 1）、链上订单簿更高（Hyperliquid $10、dYdX $1–$10），而
Uniswap/CoW 等 AMM 与签名意图型场所不设协议门槛（太小的单自然无人接/不划算）。
**定案：现阶段（测试网）不设最低额**——本轮推送前已把校验模块、两处拦截与提示
整体移除（`isUsdStableSymbol`  helper 因行情页仍在用，迁入 `referencePrice.ts`）；
**主网阶段按链设门槛**（按各链结算 gas 成本定：贵链设、便宜链可不设或设低值），
列入 §9 遗留与主网上线计划。理由备忘：本项目成交需提交者上链结算，粉尘单大概率
无人提交而自然沉底；真正的 gas 倒贴风险只在主网贵链出现，届时按链处理。

### 4.4 页面与披露

- **上架页**（新二级页 `ListTokenPage`，从「其他」页功能组进入，与 AI 接入页同级；
  `?tab=list`）：使用说明（干什么/前提/步骤/注意事项）+ 表单
  （base/quote 地址输入 → 「读取代币信息」链上读元数据 + 参考价预览 →
  元数据与 pair 键确认卡 → **风险披露块 + 勾选确认** → 「确认上架」调中继注册 →
  成功后「去交易」）。页面下方列本链已上架对。移动优先单列、大触控目标。
- **选对**：行情页/选对页（MarketsList 两种形态）合并种子行 + 已上架行（带
  「自助上架」徽标）；PairStatsBar 的切换 Select 同步合并；useCurrentPair /
  pairFromSearch / App 路由守卫放行合法地址键（键内链与当前链一致才认）。
- **交易区披露**：当前对为自助上架对时，下单表单上方显著提示（未经审核、任何人可
  上架、注意核对合约地址 + 双代币地址明示）；行情行徽标同口径。
- 显示符号一律取解析层 displayPair（符号/符号），地址键不直接示人（详情处给地址）。

### 4.5 范围外（后续轮次）

- mcp 白名单、阶段 4 运行器保持种子 8 对不动（注册表与之不冲突）。
- 资产页代币清单仍为种子代币（自助对代币的余额行后续补；本轮不崩即可）。
- K 线/成交统计对自助对在索引器未收录前为空态展示（既有空态口径，不崩）。

## 5. 骑乘对照表

| 新组件 | 骑乘的既有件 |
|---|---|
| 中继注册表存储 | Cloudflare D1（现行中继同一库 + 迁移机制） |
| 中继链上复读元数据 | viem publicClient（现行 ERC-1271 回退的同一 RPC 通道与客户端工厂） |
| 订单验签/重建 | 现行 `orders.ts`（verifyTypedData / hashTypedData），只加显式代币入口 |
| 前端元数据读取 | ethers Contract（现行 ERC20 读法） |
| 参考价聚合源 | DexScreener 免费公开 API（无 key）；兜底沿用第 23 轮参考价层 |
| 定点换算 | ethers parseUnits / formatUnits |
| 超时纪律 | 第 54 轮 withTimeout / AbortSignal.timeout 口径 |
| 上架页/说明页骨架 | 「其他」页菜单 + AI 接入页（第 56 轮）的二级页结构与文案风格 |
| E2E 测试代币 | OpenZeppelin ERC20（仓库既有依赖）+ MockERC20 模式 |
| E2E 撮合结算 | 前端生产 `executeFrontendMatch`（与阶段 4 运行器同一条路径） |

## 6. 验证（完成后回填数字）

- 前端 vitest 全量 + build + tsc：见 §7 回填。
- 中继本地验证（vitest workers + 本地 D1）：种子对下单照旧 / 新对注册后可下单 /
  错地址被拒 / 重复注册幂等：见 §7 回填。
- Sepolia E2E（18 位 + 6 位小数新代币各一对）：见 §7 回填（tx 哈希）。

## 7. 验证结果（2026-11-10 实测回填）

**前端门禁**（分支 round60-self-listing，提交 63ef32c）：vitest **470/470**
（40 文件；基线 428，本轮 +42：pairRegistry 15、DexScreener 参考价降级、
$1 校验三锚、参考价 listed 路径、useCurrentPair 地址键、config/pairs
注册表回退）；`tsc --noEmit` 干净；`npm run build` ✓（仅既有 chunk 体积
警告）。**其后变更（2026-11-10，块 4 提交）**：按 §4.3 定案移除最低额校验后，
主聊天复跑 vitest **462/462**（39 文件，减少的正是 minOrder 的 8 个用例与
1 个文件）、`tsc` 干净、`build` ✓。

**中继门禁**（提交 dd31674）：`tsc` 干净；单元测试 **36/36**（nostr 6 +
orders 19 + pairs 新增 11：键构造/解析、符号拒绝、链上复读元数据注册、
重复幂等、无代码/元数据不可读 fail-closed 400、创建者日限 429、
resolveOrderTokens 种子/已上架/未注册/错链）；workers 集成 **19/19**
（既有 12 + pairs 新增 7：GET /pairs 形状、RPC 前置校验 400、直写 D1 的
已上架对可签名下单且簿可见、伪造 quote 400、未注册反向对 400、种子
ETH/USDT 回归 200）。

**Sepolia E2E**（`frontend/scripts/round60-e2e/`，本地 wrangler dev 中继 +
本地 D1，生产中继未碰；20 项检查全 PASS）：

- 新代币部署：TKX18 `0x4Ed5487d0b9eC84d3422eF457B2556d85f6Ec56A`
  （tx `0xf70812a4616c3f796b8b320f82a23b8bc28f9543aa71541b6f81266fbfa85997`）、
  TKX6 `0xE619046bc755CF901C10fC425465D129c01C8135`
  （tx `0x5dd312276efb36bf8275ccf40a8acd871145be375c0065cdefbc4db822d573e3`）；
  链上回读 decimals 6/18 无误。
- 未注册对下单先被中继拒（400 unknown pair）；注册两对 201、重复注册
  200 幂等；中继链上复读元数据与部署一致（TKX6 base 6 位，价格缩放
  priceDecimals=30）。
- 存入第 47 轮 Vault（tx `0xc09b5a87…1709c` / `0xb2875f31…4a8c` /
  `0x6e33ec08…5c7f0d`）后挂单→簿可见→撮合结算：
  - **TKX6/USDT（主验，6 位）**：卖单 100 TKX6 @ 2，簿上原始值
    price=`2000000000000000000000000000000`（2×10³⁰，缩放 30）、
    amount=`100000000`（缩放 6）逐字对；结算 tx
    `0x7e02127935b80d3c260a230c60a3095f42c6527cd43461ee53092fe8f630eefc`
    status=1、TradeSettled 1 件；taker 实收 39,996,000 TKX6 原始单位
    （40 TKX6 扣 0.01% 手续费）、maker 实收 79.992 USDT。
  - **TKX18/USDT（18/18 对照）**：卖单 10 @ 3，price=`3×10¹⁸`、
    amount=`10×10¹⁸`；结算 tx
    `0xfb25929efd943200577cdae7618ef796e51c02a312c2a6305b4202b501a68ce6`
    status=1、TradeSettled 1 件；taker 实收 9.999 TKX18、maker 实收
    29.997 USDT。
- 结论：§2 的 decimals 口径（价格缩放 `18 + quoteDecimals −
  baseDecimals`、数量缩放 baseDecimals，前端签名值 ≡ 中继重建值）在
  6 位小数对上链上真实结算成立，**合约零改动**得到验证。

**本地 E2E 管道注记**：本 VM 出口中间层干扰 workerd 出站 TLS（直连
publicnode/Tenderly 握手损坏，Node/curl 正常），本地中继经
`SEPOLIA_RPC_URL` 指向本地 Node 转发器（127.0.0.1:8545 → publicnode）
完成验证；生产中继在 Cloudflare 网络内直读 RPC 不受影响。细节见
`frontend/scripts/round60-e2e/README.md`。

## 8. 部署计划（留给主聊天复验后执行，本轮不做）

1. 中继：`wrangler d1 migrations apply bit100-relay-orders --remote`（0002_pairs）
   → `wrangler deploy`（relay/）；
2. 前端：照常 Pages 构建发布（VITE_RELAY_URL 不变，注册表端点同源于中继）；
3. 上线后冒烟：生产中继注册一个测试对 → 前端选对可见 → 小额挂单/撤单走通。

## 9. 遗留项

- **主网阶段按链设最低交易额**（Ren 2026-11-10 定案，见 §4.3）：主网部署轮次
  按各链结算 gas 成本为每条链定最低额（前端校验 + 必要时中继口径），贵链
  （如以太坊主网）必设，便宜链（Base/Kaia 等）可不设或设低值。
- mcp 与阶段 4 运行器接入注册表（后续轮次；本轮按范围保持种子 8 对）。
- 资产页展示自助对代币余额行（后续）。
- GeckoTerminal 备源未接（DexScreener 覆盖不足时再议）。
- OrderBookSection（旧交易页组件）的订单簿/我的订单表直接渲染中继原始
  缩放字符串——种子对时代的既有行为，主交易界面（盘口组件）已按
  decimals 正确换算；本轮未动该页以免扰动第 54 轮已验表面，后续清理。
- DexScreener 对同一代币多池取最大流动池价；极端情况下小池操纵报价的
  影响仅限预填/偏离警告与 $1 校验锚（成交价以订单簿为准），主网前可
  再议是否加多源交叉。
- 本地 wrangler dev 在本 VM 出口下需本地 RPC 转发器（见 §7 注记与 E2E
  README）；仅本地开发管道事项，生产无此问题。
