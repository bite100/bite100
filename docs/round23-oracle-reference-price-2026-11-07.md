# 第二十三轮：接入 Chainlink 预言机——参考价层

> 2026-11-07。决策背景：Ren 在下单面板发现「没有参考价没法报价」，问要不要接入其他价格源，
> 随后拍板「接入」（Chainlink 预言机）。本轮交付：下单面板的**参考价层**——有可信外部喂价的
> 交易对直读 Chainlink 预言机，没有的对用本所市场数据兜底，来源逐项标注、绝不伪造。
>
> 本轮形态：**前端只读**（公开 RPC 直读 AggregatorV3 代理合约）+ 下单面板展示/预填/偏离警告。
> 不改动十合约、不重部署任何现有合约；参考价不参与签名、撮合与结算。
> 工作区纪律：独立 worktree（分支 `round23-oracle-ref-price`），基于第二十轮收尾提交 `e5ab7aa`
> 起步；收尾时第二十一轮已落地其 1/3 提交 `3cce8a7`（仅 contracts/ + node/，含 ChainConfig 的
> ethPriceInQuote 手填参考价——正是 §7 要闭环的那一项），本轮已 rebase 到该提交之上并重跑
> 全部最终门禁。21 轮剩余提交与本轮改动面（frontend/ + 本文档）不重叠；本地提交、未 push，
> 待主聊天验收后统一推送。

## 1. 喂价地址与官方出处

| 链 | 交易对 | AggregatorV3 代理地址 | decimals | 心跳 | 偏差阈值 |
|---|---|---|---|---|---|
| Sepolia (11155111) | ETH/USD | `0x694AA1769357215DE4FAC081bf1f309aDC325306` | 8 | 3600s | —（见 §3 实测口径） |
| Base Sepolia (84532) | ETH/USD | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | 8 | 1200s | 0.15% |

出处与核实方式（不凭记忆落码）：

- Sepolia 地址出自 Chainlink 官方文档《Data Feeds API Reference》页内示例
  （"Network: Sepolia, Data Feed: ETH/USD, Address: 0x694AA1769357215DE4FAC081bf1f309aDC325306"），
  官方地址总表为《Price Feed Contract Addresses》（docs.chain.link/data-feeds/price-feeds/addresses）。
- Base Sepolia 地址在官方地址总表中登记；该页为前端渲染、文本抓取不到表格，故用三方交叉核对 +
  链上自证：Aave 官方地址簿（@bgd-labs/aave-address-book，Aave V3 Base Sepolia Lido 市场的
  WETH ORACLE）登记为同一地址；多个独立项目实读报告一致；本轮 §2 的链上实读
  `description()` 返回 `"ETH / USD"`、`decimals()` 返回 8，与官方登记自洽。
- 配置落点：`frontend/src/config/chains.ts` 的 `ChainConfig.chainlinkFeeds`（可选段，沿用
  第十九轮 ccip/wormhole 的模式），key 为交易对符号。后续新增交易对/链只改配置，
  读取逻辑不变。主网（Ethereum/Base）本轮**不配**——主网合约未部署，先配等于假装可用。

## 2. 两链实读证据（2026-11-07 21:53 JST，cast 直读公开 RPC）

读取方式：`cast call <代理> "latestRoundData()"` + `description()` + `decimals()`；
Sepolia 走 `https://ethereum-sepolia.publicnode.com`，Base Sepolia 走 `https://sepolia.base.org`
（与前端 chains.ts 配置的公开 RPC 一致，前端运行时用 ethers JsonRpcProvider 同口径直读）。

| 链 | description | decimals | answer（原始） | 价格（USD） | updatedAt | 读取时刻年龄 |
|---|---|---|---|---|---|---|
| Sepolia | `ETH / USD` | 8 | 224202584969 | **2242.02584969** | 1794054204 | **1786s（≈30 分钟）** |
| Base Sepolia | `ETH / USD` | 8 | 223840624625 | **2238.40624625** | 1794055305 | **685s（≈11 分钟）** |

附带实测（往前读历史轮次 updatedAt，量更新间隔）：

- Sepolia 相邻轮次间隔 ≈ **3636s**（多轮一致）——与心跳 3600s 吻合，说明该测试网喂价
  基本由心跳驱动、偏差触发极少；读到约 30 分钟的年龄是**常态**，不是异常。
- Base Sepolia 相邻轮次间隔 ≈ **716–1220s**——心跳 1200s 与 0.15% 偏差触发共同作用。
- 同一时刻两链价格差约 0.16%，源于各自独立更新（更新时刻不同），属正常现象；
  参考价按用户当前所在链读取，不做跨链混用。

## 3. 时效校验与阈值理由

判定（`services/referencePrice.ts` 的 `evaluateFeedReading` / `staleAfterSec`）：

- **阈值 = 心跳 × 3，且不低于 3600s**：Sepolia → 10800s（3 小时）；Base Sepolia → 3600s（1 小时，触下限）。
- 理由：测试网喂价靠心跳驱动（§2 实测），正常年龄可达近一个心跳（Sepolia 约 1 小时，
  读取时刻落在心跳中段就有约 30 分钟）。阈值若按主网清算场景常用的「1 倍心跳」取，
  一轮漏传/延迟就会误杀正常喂价；3 倍心跳容忍一整轮漏传仍可用，而喂价真停摆时年龄
  无限增长、必被判过期。参考价仅供报价参考（非清算价），且面板**同时展示数据时间**，
  用户对新鲜度有直接感知——宽严取舍据此定为 3 倍。
- 年龄恰好等于阈值不判过期（严格大于才 stale）；updatedAt 晚于本地时间（时钟偏差）按年龄 0 处理。
- **零价/负价、updatedAt 缺失、decimals 异常一律判非法**，与读失败同归 `error` 状态，不展示。
- 过期/失败的面板口径：明说「参考价暂时不可用（数据过期/读取失败）」并给出最近更新时间；
  **有喂价的对过期时不降级用本所成交价冒充**——来源标注必须永远真实，宁可无价不可假价。
- 判定随时间自动生效：hook 每 60 秒重估一次，且喂价读数只缓存 30 秒。

## 4. 参考价来源优先级与标注

解析入口 `resolveReferencePrice`（hook `useReferencePrice` 封装，链口径与下单面板合约地址
一致的静态 CHAIN_ID；不依赖钱包连接，未连接钱包也能看）：

| 优先级 | 来源 | 标注文案 | 数据时间 | 适用 |
|---|---|---|---|---|
| 1 | Chainlink 喂价（新鲜） | `Chainlink 预言机` | 喂价 updatedAt | 配置了喂价的交易对（当前 ETH/USD 两链） |
| 2 | 本所最近成交价（节点 /api/trades，经 usePairStats 推导） | `本所最近成交` | 成交时间 | 无喂价的对（TKA/TKB 等） |
| 3 | 盘口中间价 (最高买+最低卖)/2，两边都有才算 | `盘口中间价` | 取盘口时刻 | 无成交但有双边盘口 |
| 4 | 无 | 面板显示「新市场，暂无参考价」并解释价格由挂单双方自行约定 | — | 冷启动 |

- **绝不伪造**：TKA/TKB 不挂任何外部价格。它们在配置里没有喂价条目（单测锁死），
  解析时根本不会发起预言机读取（单测断言 readFeed 未被调用）。
- **顺带摘除一处旧伪造**：旧 `useTokenPrice.ts` 的 `PAIR_COINGECKO_IDS` 把 TKA/TKB 映射到
  CoinGecko 的 ethereum/tether，完整订单簿页据此把 ETH 的美元价显示为 TKA 的「市场参考价」。
  本轮清空该映射并去掉未登记交易对的默认兜底（未登记 = 不发请求、不显示任何外部价）；
  通用 hook 本身保留，将来交易对的代币确为 CoinGecko 收录的同一资产时可显式登记。
  相关旧测试已按新口径改写（断言改为「TKA/TKB 无映射且不发请求」），测试总数只增不减。
- 点击参考价 → 切回限价单并预填价格输入框（与盘口点击带入的既有语义一致）。

## 5. 偏离警告：只警告、不拦截（取舍记录）

- 规则：限价单手填价格与参考价的偏离 **|偏离| > 10%**（`DEVIATION_WARN_PCT`）时，
  在提交按钮前出现红色醒目警告，写清填写价、参考价与偏离百分比及方向
  （如「比参考价高 11.0%——先确认不是手误」）。恰好 10% 不触发（严格大于）。
  10% 的量级理由：正常报价贴参考价的价差远小于此，手滑多打/少打一位、价格数量填反
  等典型错误几乎必然越过 10%；同时 P2P 场景里故意挂远离参考价的单（议价、非标需求）
  并不罕见，阈值再低会把正常议价也淹没在警告里。
- **不硬拦截**：警告出现后提交按钮状态不变，用户确认是故意报价即可照常下单。
  理由：这是 P2P 交易所，订单价格是用户的签约自由，参考价只是对照系而非官方定价；
  且参考价本身可能滞后（测试网心跳以小时计），拿它当硬闸会把数据源的毛病转嫁成
  用户的下单障碍。市价单不做此警告（其价格由盘口推导、已有保护价机制）。

## 6. 产品内说明（同轮落地，Ren 铁律）

下单面板参考价行下方常驻一段说明（新用户只看页面就能懂）：

> 参考价是什么：报价时的对照值，不是成交价。有 Chainlink 预言机喂价的交易对读预言机
> 聚合价；没有的用本所最近成交价或盘口中间价（来源已在上方标注）。实际成交价以盘口
> 挂单为准，可能与参考价不同。

四种状态各有对应文案：正常（价格+来源+数据时间+「点击价格可填入」）、过期、读失败、
暂无参考价（新市场解释），均已落码。

## 7. 与第二十一轮 gas 的闭环（文档结论，不动 21 轮代码）

- 第 21 轮 gas 对半回收需要 ETH 计价的换算率，现阶段在 ChainConfig 里手填。
- **结论：主网的价格来源定为 Chainlink ETH/USD 喂价——与本轮参考价层同一个源**
  （主网 Ethereum/Base 的 ETH/USD 喂价，心跳 3600s/偏差 0.5%，Chainlink 参考数据目录口径）。
  主网上线门禁据此更新：gas 换算价改读 Chainlink 喂价（含时效校验，口径同 §3），
  ChainConfig 手填值仅作喂价不可用时的治理兜底，不再是主来源。
- 测试网维持手填不变，本轮不改 21 轮任何代码/配置。

## 8. 门禁与改动面

- 前端测试：**150 例全绿**（基线 116 → +34：referencePrice.test.ts 新增 33 例，
  useTokenPrice.test.ts 净 +1 例；覆盖时效拒绝与边界、零/负价拒绝、偏离警告触发/不触发
  与 10% 边界、TKA/TKB 无参考价状态、过期不降级、配置落点四链断言）。
- 构建：`npm run build` 成功；产物 bundle 已核验包含两链喂价地址、「Chainlink 预言机」
  来源标注与「新市场，暂无参考价」文案。
- 改动文件（全在 frontend/）：`src/config/chains.ts`（喂价配置）、
  `src/services/referencePrice.ts` + 测试（新）、`src/hooks/useReferencePrice.ts`（新）、
  `src/hooks/usePairStats.ts`（补最近成交时间）、`src/hooks/useTokenPrice.ts` + 测试
  （摘除冒充映射）、`src/components/dashboard/Dashboard.tsx`（透传最近成交）、
  `src/components/dashboard/LimitOrderFormWidget.tsx`（参考价行/预填/警告/说明）、
  `src/components/dashboard/TradeScreen.css`（参考价数值样式）。

## 9. 已知限制

- 测试网喂价稀疏是结构性的：Sepolia 靠小时级心跳更新，参考价年龄在 0–60 分钟间
  摆动属正常，面板以数据时间如实呈现；主网 ETH/USD 心跳同为 3600s，量级相同。
- 当前交易屏只有 TKA/TKB 一个交易对，它没有喂价——参考价行在主网上线真实交易对
  （如 ETH/USD）之前，实际走的是本所成交/盘口兜底路径；预言机路径已由单测与
  两链实读双重验证，但尚无真实 ETH/USD 交易对的端到端页面实证（等交易对上线时补）。
- 喂价读取走每链单一公开 RPC，无多 RPC 兜底（与现有节点 API 的多节点策略不同）；
  读失败有明确文案且不影响下单，后续可并入 nodeClient 式多路尝试。
- 参考价仅前端展示层使用，未上链、未进节点撮合；若将来标记价/强平要用预言机价，
  必须另行设计链上读取与时效校验，不能复用本层的前端口径充数。
