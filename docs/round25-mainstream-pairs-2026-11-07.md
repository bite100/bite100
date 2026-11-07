# Bit100 第二十五轮：主流交易对上架（2026-11-07）

状态：**完成**（本地提交，未 push、未部署前端）。本轮在 Sepolia + Base Sepolia 部署 7 个主流资产 + USDT 测试币，上架 8 个交易对，交易页支持交易对切换，Chainlink 参考价按「官方清单 + 链上实读」逐对核实，双链各完成一笔 BTC/USDT 成交并验到链上结算。

> 使用说明（随功能逻辑变更同轮交付，见 §3）：交易页顶部新增交易对下拉框，切换后地址栏写入 `?pair=`，统计、K 线、订单簿、下单表单、最新成交全部跟随切换；参考价有已核实 Chainlink feed 的对显示链上价格，无 feed 的对显示「新市场，暂无参考价」或取本市场最新成交/盘口中间价，绝不借用其他资产的价格。

## 1. 测试币部署（MockERC20，18 位，各 1,000,000 枚 → 部署者）

部署脚本：`contracts/script/DeployMainstreamTokens.s.sol`（ChainGuard 保护，`TARGET_CHAIN_ID` 校验）。全部 16 个合约均经 `cast call symbol()/decimals()/totalSupply()` 链上验证通过。Broadcast JSON 在 `contracts/broadcast/DeployMainstreamTokens.s.sol/{11155111,84532}/run-latest.json`（git-ignored，不提交）。

### Sepolia（chainId 11155111）

| 代币 | 地址 | 部署 tx |
|---|---|---|
| BTC | `0x8EDa0025C245B10eA1E10c257674B794C85350f3` | `0x6842f9d2d83672649a67cbb00a674c2cee89803271d7b9fe32e8f857a1d80d2e` |
| ETH | `0x6851ec177dB923ae0A97F262351437D12B21710A` | `0x1ba71cdf4ff9c9c0c76e7661cc573532f0d50b338f95eddf3cf3761f742f0111` |
| SOL | `0x42f7B1B6c2caFb1F3d930B0C247a08f608b034aa` | `0x03e6d1d274834daff2b24b0e10734c6fa8ed6c179debcadda16874e099c2a171` |
| BNB | `0x5657f5DBb2C49DBCd4F6d16ebbCb3D4870aACd29` | `0x0618c11bfa0da3cf8dd22396e887e5575ae3cec956c14826eef974b6e1f4a085` |
| XRP | `0x20191571978478AEea15BC39b7D5609BE343D88e` | `0xa00fa077d00d6bb4dee85179a957bc35a4bc87c8b3d3e3f9b12690655890e2f5` |
| DOGE | `0xAb2D18f97E2dd39450bf1C0E59BC4d2Fb23212C7` | `0x6e199b830dd0f1538c3bba96840d3428caba8104df662b3454524e631fe753f7` |
| LINK | `0x74159771935E66Ed7dC13370f2BCe89EC8292b18` | `0x137c1c1a1550e9b97473bd0852b78a02111c892557b8e81688a504681f75f954` |
| USDT | `0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e` | `0x6e1407425e6f8ddb13b4f64611638dc14e79726baf1e6b9f2e3132ba2c09685b` |

部署后部署者 Sepolia ETH 余额：0.021196472209154003 ETH。

### Base Sepolia（chainId 84532）

| 代币 | 地址 | 部署 tx |
|---|---|---|
| BTC | `0xf1a6d8fd31fe9e72664fb9f07ffab8056a84156f` | `0x09acb4bf4b971b798c1762866f9fa0a8f123329a13d2cc88137dc3c8f6911ade` |
| ETH | `0x151c6be0d525880626f4757d58cd141872af7914` | `0xef0b03547e495594eb7c2f890634d9f4d83c3d64fd06463fc927f59b089a59dd` |
| SOL | `0xcb704487d52ccf66cae7680c348966e15fa0e430` | `0xbdea7bad094ef46575a78ea1b81370c670b5db46b736c6425849dbcf2d8e4edf` |
| BNB | `0xf567c000f53c76e14fa21c4b90efecc0e4d586ec` | `0xdd6e1476369f3aceb64e38ab262eef8b500ab5863a85ff8b7089114e70e603db` |
| XRP | `0x26b58d2528a7fdfe744da338c5605123ea2266f3` | `0x5865d38726bc3c1613150d6cfb6008da5a4ec8077e5579ed84cfdadbc4b2dbd9` |
| DOGE | `0x68bf313360021dcf4e359ad18c4506f622a3666d` | `0x31f459d968e357c9fea666dfc9540ff9ad59a780cbc13069c081974ff6372d5f` |
| LINK | `0x43dc5f7099d3689d0dc73dbdc1e73e7a47e636e2` | `0x35a17f84102fb55c4fcd85d6ba44bcb0537cd769ff05439bb25e35d649ea8e40` |
| USDT | `0xaab464e0be805c199007e27d8f651038319207d6` | `0xc9c11ab9575e96a0ccd76fd9b5d6e59c4cf32245150bfa5361165bb924535301` |

注：Base DOGE 地址与 Sepolia 的 CCIP tokenPool 地址字符串相同，系不同链上 CREATE nonce 巧合（第 19 轮已有同类记录），无影响。既有合约地址不变（Sepolia Vault `0xF9695C43…E9f5`、Settlement `0x549690D6…7Ef6`、TKA `0x93a4af54…de28E`、TKB `0x1530b74E…ddc2`；Base Sepolia Vault `0x46592e98…3D50`、Settlement `0x6291E0F2…3671`、TKA `0xd3f1136C…5D33`、TKB `0x8492ccCE…daF`）。

## 2. 交易对与 Chainlink 参考价核实

上架 8 对（默认 `BTC/USDT`）：BTC/USDT、ETH/USDT、SOL/USDT、BNB/USDT、XRP/USDT、DOGE/USDT、LINK/USDT、TKA/TKB。前端注册见 `frontend/src/config/pairs.ts`（`TRADE_PAIRS`、`DEFAULT_PAIR='BTC/USDT'`、`getPairTokens` 未注册返回 null、绝不伪造）。

核实方法：候选地址先对照 Chainlink 官方文档「Price Feed Contract Addresses」，再对双链公共 RPC 做 `cast call description()/decimals()/latestRoundData()` + `cast code` 实读。教训：搜索摘要会混网、截断地址（如 `0x5a493040…` 仅 43 位十六进制，无效），多个候选在双链均无代码，必须以链上实读为准。

### 已核实 feed（X/USD，8 位小数，用作 X/USDT 对的参考价）

| 链 | 对 | Feed 地址 | 实读价格（2026-11-08 ~00:20 JST） | Heartbeat |
|---|---|---|---|---|
| Sepolia | BTC/USDT ← BTC/USD | `0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43` | $75,822.34（answer 7582233986326） | 3600s（实测轮次间隔 3624s ×2） |
| Sepolia | ETH/USDT ← ETH/USD | `0x694AA1769357215DE4FAC081bf1f309aDC325306` | $2,243.36（answer 224336000000） | 3600s（第 23 轮已核实） |
| Base Sepolia | ETH/USDT ← ETH/USD | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | $2,240.34（answer 224033508626） | 1200s（第 23 轮已核实） |

说明：feed 本身是 X/USD（美元计价），用作 X/USDT 对的参考价基于 USDT ≈ 1 美元的近似，已在代码注释与本节写明；这不是用别种资产的价格冒充。陈旧阈值 = heartbeat ×3（下限 3600s），过期数据报「过期」且不降级为本市场数据（第 23 轮规则）。

### 未找到已核实 feed → 标「暂无参考价」，不借用

以下组合在双链公共 RPC 上逐一实读候选地址后均无代码（12+ 个候选），故**不设 feed 条目**：SOL/USD、BNB/USD、XRP/USD、DOGE/USD、LINK/USD、USDT/USD，以及 Base Sepolia 上的 BTC/USD。参考价层（`useReferencePrice`）对这些对回退到本市场最新成交价或盘口中间价；两者皆无时面板显示「新市场，暂无参考价」。TKA/TKB 仍不注册任何外部价格（第 23 轮已清除冒用 CoinGecko 的映射，本轮未重蹈）。

`frontend/src/config/chains.ts` 中 feeds 仅登记上述三条已核实条目；`useTokenPrice.ts` 的 `PAIR_COINGECKO_IDS` 只注册 7 个真实资产（bitcoin/ethereum/solana/binancecoin/ripple/dogecoin/chainlink + tether），TKA/TKB 仍不注册，且该映射仅用于完整订单簿页的展示价，不进入参考价逻辑。

## 3. 前端：交易对切换器（使用说明）

- **切换位置**：交易页顶部统计条（`PairStatsBar`）的下拉框列出全部 8 对；完整订单簿页（`OrderBookSection`）同样有下拉框，两处共享同一状态。
- **URL 同步**：选中对写入地址栏 `?pair=`（`useCurrentPair`，replaceState + popstate 监听），刷新/分享链接后仍是该对；非法或缺失参数回落默认 `BTC/USDT`。
- **随对切换的内容**：统计条、K 线（`KLineChart`，切换时整列替换）、订单簿、我的订单/成交查询与 Vault 余额（`TradeTabsPanel`）、下单表单（`LimitOrderFormWidget`，标题 `下单 · {pair}`）、最新成交。切换时重置推荐价/中间价/价格拾取与订单簿状态。
- **下单规则**：基础/报价代币取自 `chains.ts` 的 `tokens` 注册表；`tokenIn`=基础币、`tokenOut`=报价币（与买卖方向无关）；价格/数量以 wei 字符串提交；未注册交易对时提交按钮禁用并提示。
- **参考价显示**：有已核实 feed 的对显示链上参考价（点击可预填，偏离 >10% 仅警告不拦截）；无 feed 的对按 §2 回退，见「新市场，暂无参考价」时表示该对暂无任何可信参考价，下单价格需自行判断。
- **已知限制**：前端 `EIP712_DOMAIN` 仍为静态 Sepolia 配置，Base 链的界面下单签名未验证（本轮 Base E2E 用脚本按链域名签名）；前端仅本地构建通过，未部署，线上站点仍是旧包。

改动文件：`frontend/src/config/chains.ts`（tokens 注册表 + 3 条 feed）、`frontend/src/config/pairs.ts`（新增）、`frontend/src/hooks/useCurrentPair.ts`（新增）、`Dashboard.tsx`、`PairStatsBar.tsx`、`OrderBookWidget.tsx`、`RecentTradesWidget.tsx`、`KLineChart.tsx`、`TradeTabsPanel.tsx`、`LimitOrderFormWidget.tsx`、`OrderBookSection.tsx`、`hooks/useTokenPrice.ts`；`usePairStats.ts`、`useTradesOHLC.ts` 本就按对参数化，无需改动。

测试：新增 `config/pairs.test.ts`（7 例，含逐链精确代币地址）、`hooks/useCurrentPair.test.ts`（4 例）、`referencePrice.test.ts` +3 例（BTC/USDT Sepolia、ETH/USDT 双链、有 feed/无 feed 断言）、`useTokenPrice.test.ts` 修复 +1 例。**全套 165 通过（基线 150 → +15），14 个文件；`npm run build`（tsc + vite）通过**；构建包经核查包含 Sepolia/Base BTC 地址、BTC/USD feed 地址与 `BTC/USDT` 字符串。

## 4. 节点确认

- 节点对交易对无写死上限：`node/internal/match` 的 `pairTokens` 与 `match.pairs` 配置驱动；但**未在配置中注册的对必然拒单**——签名校验时 `tokenIn/tokenOut` 为空，报 `provided data '' doesn't match type 'address'`（本轮首次 E2E 即因此失败，离线验签证明签名本身正确，问题在节点侧未加载该对）。
- 线上配置：`~/workspace/bite100-node/{sepolia,base}/config.yaml` 的 `match.pairs` 已含全部 8 对（备份 `config.yaml.r25`）；双节点重启后日志确认：`[match] 撮合引擎已启用（relay），交易对: 8`，本地交易对含全部 8 对；签名域与第 26 轮结算提交器均正常（`[settle] 结算提交器已启用`）。
- **watchdog 还原事件（已修复）**：首次改配置并重启后，10 分钟看门狗跑 `~/workspace/tools/bite100-node/ensure.sh`，其 §2 把两份线上配置用内嵌的 TKA/TKB 单对模板强制覆写回 1 对并重启了节点，导致首次 E2E 拒单。修复：把 8 对写入 `ensure.sh` 内嵌模板（与线上配置一致的唯一事实来源），再恢复线上配置并重启；此后看门狗比对无变化，不再重启。**后续改节点配置必须同步改 `ensure.sh` 模板，否则会被看门狗还原。**
- API  quirks（既有，非本轮引入）：`GET /api/trades` 不带 `since` 时返回 `null` 而非空数组，查询须带 `since=0`；本轮 E2E 脚本已按此修正。
- 第 26 轮结算接线已在线上：运行中的二进制含提交器代码，2026-11-07 遗留成交已结算（见 §5 备注）；本轮未改动任何结算代码。

## 5. E2E 证据（BTC/USDT，0.01 BTC @ 75,000 USDT，名义 750 USDT）

测试钱包：maker `0xE83D2b08356cb463adFc20406a18B79991F7eE29`、taker `0x87ffF84eb917916587fA7721c843cdC3Ada957eA`；部署者出资 maker 0.05 BTC、taker 2000 USDT，双链各存入 Vault。E2E 脚本 `/tmp/r25-e2e.cjs`（未入仓；存款幂等，只补差额）。成交价 75,000 USDT 接近实读时 Chainlink BTC/USD $75,822.34。

### Sepolia — 已结算 ✅

- 卖单 `order_1794065950986_limu5li88`（nonce 2）、买单 `order_1794065955748_8qbhprwzy`（nonce 2），均 HTTP 200 接受；撮合 1 笔，买单 `filled`。
- 成交 ID：`order_1794065955748_8qbhprwzy-order_1794065950986_limu5li88-1`；`settleStatus: settled`，`settleAttempts: 1`。
- 结算 tx：`0xa86c0d364d25abb84a3fc996ac9617e90acfcd37268ffe18bbe60e076a18de81`，区块 12084608，status 1，gas 1,795,510，from 部署者（operator）`0x4B3fbb64…fa93e` → Settlement `0x549690D6…7Ef6`。
- 链上余额变化（Vault available）：maker BTC 0.05 → 0.04，maker USDT 0 → 749.925（750 − 0.075 手续费）；taker BTC 0 → 0.009999（0.01 − 0.000001 手续费），taker USDT 2000 → 1250。手续费 1bp 双边，与第 21 轮费率一致；FeeDistributor 收 BTC 0.00000099 + USDT 0.07425，Ren 开发钱包 `0x047df18e…54d9` 收 BTC 0.00000001 + USDT 0.00075（99/1 分账）。
- 双方 Settlement nonce 2 → 3。
- 备注：首次尝试因 watchdog 还原配置而拒单（§4），修复后重跑成功；重跑未重复存款。

### Base Sepolia — 已结算 ✅

- 卖单 `order_1794066225542_1o7jfuzml`（nonce 1）、买单 `order_1794066231713_z99aloeo2`（nonce 1），均 HTTP 200 接受；撮合 1 笔。
- 成交 ID：`order_1794066231713_z99aloeo2-order_1794066225542_1o7jfuzml-1`；`settleStatus: settled`，`settleAttempts: 2`——第 1 次尝试报 `signed orders unavailable for settlement`（第 26 轮提交器的瞬时竞态），重试后成功。
- 结算 tx：`0x2524506fcad14f937388f5846aa913e06f5b1bcf8a758ee3e6042a27703cee5b`，区块 55721873，status 1，gas 520,151，from 部署者 → Settlement `0x6291E0F2…3671`。
- 链上余额变化与 Sepolia 完全一致（maker BTC 0.04 / USDT 749.925；taker BTC 0.009999 / USDT 1250；FeeDistributor BTC 0.00000099 / USDT 0.07425）。双方 nonce 1 → 2。
- 存款 tx：maker approve `0x01bccca6021535899fa958006b6022297a1077b94adde212efa58d7aebdba42f`、deposit `0xe487a708f6e3d15070c8d4ad1141f138eb0d14405a6ce126584cee32c50b747a`；taker approve `0xe269a10aef486697f840da1cd19b9b40c9be5742c33caf9ab4fd2cf9ada30a63`、deposit `0x42bb09aa422bf52657fd4cf1585396d5a87ed378e38816543fbf336d5a4f0795`。

### Gas 备注

两笔结算到账均为「成交额 − 1bp 手续费」，未观察到 gas 费用扣除。原因：第 26 轮提交器（`bite100-r26/node/internal/settlement/submit.go` L113–114）当前 `gasReimburseIn/Out` 均传 0，第 21 轮的 gas 对半回收规则在提交器路径上尚未接通。结算正确性不受影响，留待后续轮次处理。

### 成交记录 amountOut 失真（节点侧既有问题，本轮发现）

两条成交记录的 `amountOut` 均为 `750000000000000000013291247438204502016`（≈ 7.5e38），即 `amountIn × price` 未除 1e18 的浮点格式化产物，比正确值 750 USDT（7.5e20）大 1e18 倍。结算本身用的是签名订单的正确数额（链上余额证明），不受影响；但高价对（价格 ≫ 1e18，如 BTC/USDT）的成交历史 `amountOut` 显示会失真，TKA/TKB（价格 1e18）不受影响。建议后续轮次修复撮合引擎的金额格式化。

## 6. 已知限制

1. Chainlink feed 仅覆盖 BTC/ETH（Sepolia）与 ETH（Base Sepolia）；其余 5 对 × 双链无已核实 feed，参考价靠本市场数据或显示「暂无参考价」。
2. 成交记录 `amountOut` 对高价对失真 ×1e18（§5），结算不受影响。
3. `GET /api/trades` 缺省 `since` 返回 null（既有 quirk），须带 `since=0`。
4. 前端 `EIP712_DOMAIN` 仍静态 Sepolia；Base 界面下单签名未验证；前端未部署。
5. Gas 对半回收在提交器侧未接通（`gasReimburse` 传 0），本次结算未扣 gas。
6. Base 结算第 1 次尝试瞬时失败后重试成功（第 26 轮提交器竞态，见 §5）。
7. 第 26 轮自有 E2E 的两条成交显示 `settleStatus: failed`（`Settlement: fill exceeds signed order`，疑似重复提交同一 fill），属第 26 轮自有产物，与本轮成交无关；2026-11-07 遗留成交已结算（tx `0x08fda7b0…09f3`）。
8. 节点配置与 `ensure.sh` 模板在仓库之外（`~/workspace/bite100-node/`、`~/workspace/tools/bite100-node/`），改配置必须双处同步，否则看门狗 10 分钟内还原。
9. 本轮零主网操作；跨链桥 DVN 1-of-1 主网门禁不变；未动 Ren 的钱包（仅测试钱包）。

## 7. 本轮文件清单

- `contracts/script/DeployMainstreamTokens.s.sol`（新增）
- `frontend/src/config/chains.ts`、`frontend/src/config/pairs.ts`（新增）、`frontend/src/hooks/useCurrentPair.ts`（新增）、`frontend/src/components/dashboard/{Dashboard,PairStatsBar,OrderBookWidget,RecentTradesWidget,KLineChart,TradeTabsPanel,LimitOrderFormWidget,OrderBookSection}.tsx`、`frontend/src/hooks/useTokenPrice.ts`
- 测试：`frontend/src/config/pairs.test.ts`、`frontend/src/hooks/useCurrentPair.test.ts`、`frontend/src/referencePrice.test.ts`、`frontend/src/hooks/useTokenPrice.test.ts`
- 本文档：`docs/round25-mainstream-pairs-2026-11-07.md`
- 仓外改动（节点运行所需，非本轮代码提交）：`~/workspace/bite100-node/{sepolia,base}/config.yaml`（8 对）、`~/workspace/tools/bite100-node/ensure.sh`（内嵌配置模板同步 8 对）
