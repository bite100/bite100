# 第二十轮：垫资快线接入（求解器/聚合器中间商）

> 2026-11-07。决策背景：Ren 拍板「把这些中间商接进来」——在 LayerZero / CCIP / Wormhole
> 三家**消息桥**之外，再接一条**垫资快线**：做市商（求解器）用自有资金在目的链先付给
> 用户，用户不用等源链最终确认，做市商事后自行过桥平账；费用含在报价里、由选择快线
> 的用户承担。这是钱包里"跨链感觉很快"的同款机制（快 = 有人垫资，慢 = 等证明）。
>
> 本轮形态：桥页第四个可选项「极速到账（做市商垫付）」，与三桥并列、**无预选默认**，
> 沿用知情选择规则（确认前摊开费用/时效/安全模型/回退路径/不可逆）。
> 工作区纪律：本轮在独立 worktree（分支 `round20-fastlane`）完成，基于第十九轮
> 收尾提交 `0634ea2`；本地提交、未 push，待主聊天验收后统一推送。

## 1. 中间商对比（只认官方文档/repo + 2026-11-07 实测端点）

| 维度 | **LI.FI（选定）** | Relay | Socket（Bungee） | Across（直连） | deBridge DLN |
|---|---|---|---|---|---|
| 形态 | **聚合器**：一次接入覆盖 30+ 桥/求解器（Across、Relay、deBridge、Stargate 等在其路由内） | 单一求解器网络 | 聚合器（路由 API + 组件） | 单一意图桥（LP + relayer 网络，ERC-7683 发起方） | 单一求解器网络（0-TVL 订单式） |
| 接入面 | REST API / TS SDK / Widget（本轮用 REST） | REST API / SDK | REST API（Swap V3）/ Widget / SDK | REST API / SDK / 合约直连 | REST API（create-tx）/ Widget |
| 报价 API | `GET /v1/quote`：返回 feeCosts（带 included 标记）+ gasCosts + executionDuration + toAmountMin + 可直接签名的 transactionRequest | `POST /quote/v2`：fees 拆 gas / relayer / relayerGas / relayerService / app | `GET /v3/swap/quote`（多路由） | 现行 Swap API（`/swap/approval`）；`/suggested-fees` 官方已标 **legacy、不再积极维护** | `GET /v1.0/dln/order/create-tx`：estimation.costsDetails 拆分 |
| 状态 API | `GET /v1/status`（DONE / PENDING / FAILED / INVALID / NOT_FOUND） | 有（按 requestId 查询） | 有（状态端点） | `GET /deposit/status` | `GET /v1.0/dln/order/{id}/status` |
| 费用构成 | 平台费 **0.25%** 叠加在报价内（feeCosts 可见）+ 底层路由费；集成方可用 `integrator` + `fee` 参数加收（Portal 登记收款钱包后生效） | 费用全在报价 fees 内拆开；可加 app fee（实测样本 app=0） | Socket 本身不加价、API 免费；集成方可用 feeBps 加收（需先过 API access 申请） | LP 费 + relayer 费（利用率定价）含在价差；`appFee` 可加收（目的链支付给 appFeeRecipient） | 固定费（源链原生币）+ 协议费 4 bps + taker 保证金 ≈4 bps + 运营开销；affiliate fee 可加 |
| Ethereum + Base | ✅（实测 `/v1/chains` 共 65 条链，含 1 与 8453） | ✅（链表含 1 与 8453，75+ 网络） | ✅（30+ 网络） | ✅ | ✅（实测 supported-chains 含 1 与 8453） |
| 是否需要 Ren 注册 API key | **免 key 可调**（限流 200 次/2 小时）；免费 key 在 Partner Portal 自助申请（Ren 一次性动作）→ 200 次/分钟 | 官方文档：`POST /quote/v2` 自 2026-10-02 起**每请求必须带 key**（Dashboard 申请）；2026-11-07 实测无 key 报价仍成功——以文档为准，不可依赖免 key | 生产需 `x-api-key` + `affiliate`，**先申请 API access**；`public-backend` 可免凭据试用（主网数据） | 生产必须 **API key + integrator ID**（2 字节 hex），经团队渠道（Telegram/Slack）**人工开通**；测试网免 key | **基础使用免 key**（官方 FAQ 明示） |
| 测试网可用性 | 经典 API 链列表含 Sepolia/Base Sepolia，但**无求解器流动性**（TKA 不在任何路由内）；staging 需授权（实测 403）；Intents 另有 dev order server（独立面，本轮未用） | 有测试网 API（api.testnets.relay.link），链恰为 Sepolia + Base Sepolia，实测可报价——但只覆盖其自有测试资产/原生币，**非任意 ERC20** | 无公开测试网报价面 | 有测试网 API（testnet.across.to，免 key，测试代币） | 无（实测 supported-chains 18 条全为主网/内部 ID，无 Sepolia/Base Sepolia） |

## 2. 选定：LI.FI（一家聚合器）

理由：

1. **一家顶多家**，正中项目既定接入策略：底层履约方随报价在 Across / Relay / deBridge / Stargate 等之间选路，页面按报价如实显示实际履约方名，不假装成自家能力。
2. **费用拆分与 Bit100 三分口径天然对齐**：feeCosts 的 `included` 标记直接区分「从到账扣除」与「另付」，gasCosts 单列源链原生币——知情选择规则（确认前拆开）可原样落地，不用二次估算编造。
3. **胶水最薄**：报价响应自带 transactionRequest（to/data/value），用户钱包直接签名发送；状态端点可映射统一四态；授权地址由报价返回（approvalAddress），页面不硬编码任何聚合器合约地址。
4. **上手零账号动作**：免 key 即可开发与联调；生产 key 是 Ren 在 Partner Portal 的一次性自助动作，不需要找任何团队人工开通（Across 的 integrator ID、Socket 的 access 审核都不可控）。
5. **代价如实**：平台费 0.25% 叠加在报价内（用户在确认弹窗能看到拆分）；免 key 通道限流紧（见 §6 实测 429）——主网上线门槛第 1 条就是申请 key。

落选/备选定位：

- **Relay 直连**：报价质量与费用拆分同样优秀（实测预计到账时间 1–2 秒级），但单一网络、无聚合比价，且官方已宣布报价必须带 key。列为**第二 provider 候选**——本轮 provider 结构已留位，后续可按同一抽象再加一家直连做比价/兜底。
- **Socket**：聚合面好，但生产 API access 需申请审核，节奏不可控；本轮不选。
- **Across 直连**：协议本身优秀（意图标准发起方），但生产凭据需人工开通、suggested-fees 已 legacy 化、现行 Swap API 面超出本轮「垫付跨链」范围；且经 LI.FI 路由时本就可被选到。
- **deBridge DLN**：免 key + 费用结构最透明（4bps + 4bps + 固定费），但单一网络、链覆盖最少（18 条）；列为第二直连候选。

**THORChain / Chainflip 简要评估（本轮不接）**：两者都是**原生资产**跨链流动性协议——THORChain 是 RUNE 计价池的原生资产兑换（资产为 BTC/ETH 等原生形态的白名单集合，报价经 THORNode/Midgard），Chainflip 是自有链 + JIT AMM 的原生互换（同样是白名单原生资产 + 其 broker 体系）。它们解决的是"原生 BTC 这类无法包装资产"的兑换，不是"为任意 EVM 代币垫资"的通用聚合面；任意 ERC20（如未来的 TKA）不在其资产体系内，接入还需引入各自的账户/地址/托管模型，与 Bit100 现阶段 EVM 场景不匹配。未发现比上述五家更干净的 EVM 接法；若将来做原生 BTC 资产，再做专项评估。

## 3. 实现（官方件原样用，胶水只做拼装/解析/映射/拦截）

**官方件（不改、不仿造）**：LI.FI REST API（`/v1/quote`、`/v1/status`、transactionRequest 与状态语义、feeCosts/gasCosts 结构）；LI.FI Diamond 合约（地址由每笔报价返回）；各履约方协议本身。

**胶水（本轮新增）**：

| 文件 | 内容 |
|---|---|
| `frontend/src/services/fastLane.ts` | provider 胶水：链对支持判断（首批 Ethereum ↔ Base 主网）、报价参数拼装与响应解析、费用拆分（到账内扣 / 另付 / gas 单列）、`/v1/status` → 统一四态映射、USDC/WETH 知名代币跨链地址自动配对、预计时效文案 |
| `frontend/src/services/fastLane.test.ts` | 15 例单测：测试网拦截（断言零网络请求）、未开通链对拦截、报价解析与费用拆分、429 官方错误原样透出、状态映射、代币配对 |
| `frontend/src/components/CrossChainBridge.tsx` | 第四张卡 + 防抖报价刷新（800ms，避免逐键打 API）+ 确认弹窗快线区块 + 执行（发送前重新报价、失败即中止、按 transactionRequest 原样签名）+ 状态轮询（15s） |
| `frontend/.env.example` / `src/vite-env.d.ts` | `VITE_LIFI_API_KEY` / `VITE_LIFI_INTEGRATOR` 可选变量位（留空 = 免 key 通道；本轮默认**不传** integrator、**不加收** Bit100 分成） |

**合约：零改动。** 聚合器路线是链下 API + 用户钱包签名官方返回的交易，本轮不需要、也没有动任何合约与部署。

## 4. 页面标注文案（如实记录 shipped 口径）

- **卡片名**：极速到账（做市商垫付）
- **费用（静态口径）**：主网实时报价（经 LI.FI 聚合多家做市商/桥选路）：做市商与协议费用从到账数量中扣除，发送交易的 gas 以源链原生币另付；点确认前会把每一项拆开展示
- **时效**：主网预计约 1–5 分钟到账（以实时报价为准；做市商在目的链先行垫付，不用等源链最终确认）
- **安全模型（大白话）**：没有跨链消息验证环节——做市商用自有资金在目的链先付给你，事后自行过桥平账；你面对的是报价与履约风险，不是验证方作恶风险
- **实时报价行**（样例格式）：`实时报价（经 Relay 履约）：预计到账 X USDC；费用 A USDC 从到账扣除；gas 约 B ETH 另付；约 1 分钟内到账`（履约方与数字全部来自当笔报价返回）
- **确认弹窗（快线专属）**：预计到账 + 最低到账（低于不执行）；费用拆分逐项（名称/数量/币种，标注从到账扣除 vs gas 另付）；履约方名称 + 垫付说明；回退路径（无人接单/超时：勿重复发送，先查状态，可改走三家消息桥，先确认原单再发新单）；通用项复述不可逆。
- **测试网徽标**：`主网功能 · 测试网不可用`；点确认时的拦截文案：「极速到账（做市商垫付）是主网功能：求解器网络在测试网没有流动性，当前测试网组合下不可用，也不会发起报价。请改选其余三家桥，或等主网上线后使用。」未开通主网方向文案：「极速到账目前只开通 Ethereum ↔ Base 主网方向，其他主网链陆续接入中。」
- **四家无预选默认**：与第十九轮一致，`selectedBridge` 初始为 null，必须用户主动点选。
- **功能说明同轮交付**：页面顶部导览加第 ④ 条选型指引；选快线时代币栏下方出现填法说明（留空 = 原生币、USDC/WETH 自动配对、仅主网）；卡片「风险与细节说明」含测试网不可用/费用口径/履约方/回退/不可逆五条。

## 5. 测试网限制与主网上线门槛

测试网限制（已按此实现）：求解器网络在 Sepolia / Base Sepolia 没有为任意代币垫资的流动性——Relay 测试网 API 只覆盖其自有测试资产，LI.FI 测试网链 ID 出现在链列表里也不等于有路由。因此测试网构建中快线**可见但硬拦截**：卡上有徽标、确认被拦、报价函数在发请求前抛错（单测断言零网络调用），页面上不出现任何编造的报价数字。

主网上线门槛（缺一不可，均为后续动作，本轮未越界执行）：

1. **Ren 本人**在 LI.FI Partner Portal 注册 integrator 并申请免费 API key → 填 `VITE_LIFI_API_KEY`（免 key 通道实测限流，见 §6，不得带此状态上线）。如要开集成方分成：在 Portal 登记收款钱包并由 Ren 拍板 fee 比例（本轮默认不加收）。
2. **主网小额真实 E2E 一笔**：Ethereum → Base，ETH 或 USDC 小额，走完报价 → 签名 → `/v1/status` 到 Completed，核对实际到账与报价（到账额、最低到账、费用拆分）一致后才开放入口。本轮未做任何主网交易（红线）。
3. **资产范围如实**：快线只服务 LI.FI 可路由资产（ETH / USDC 等主流资产）；TKA 等自有代币在被求解器支持、具备主网流动性之前不走快线，页面以报价成败如实呈现，不作承诺。
4. 桥页主网整体开放仍受既有门禁约束（LZ 多 DVN 硬门禁针对消息桥，与快线互不替代，不因快线先行而放宽）。

## 6. 真实报价 API 样本（2026-11-07 只读实测，脱敏节选）

**Relay 主网报价**（POST /quote/v2，无 key 实测成功；0.001 ETH，Ethereum → Base）：

```json
{ "details": { "currencyIn":  { "amount": "1000000000000000" },
               "currencyOut": { "amount": "990212688554745" },
               "timeEstimate": 1 },
  "fees": { "gas":          { "amount": "5663078936260",  "currency": "ETH" },
            "relayer":      { "amount": "9787311445255",  "currency": "ETH" },
            "relayerGas":   { "amount": "164374369450",   "currency": "ETH" },
            "relayerService":{ "amount": "9622937075805", "currency": "ETH" },
            "app":          { "amount": "0" } },
  "steps": [ { "id": "deposit", "kind": "transaction" } ] }
```

**Relay 测试网报价**（POST api.testnets.relay.link/quote/v2；0.001 ETH，Sepolia → Base Sepolia，预计 2 秒）：currencyOut `990922709877466`；fees.gas `33399999966600`、fees.relayer `9077290122534`（gas 163800000910 + service 8913490121624）。证明其测试网仅为自有测试资产沙盒，不构成 TKA 可用性。

**Across 主网 suggested-fees**（GET，无 key 实测成功；0.01 WETH，Ethereum → Base）：`estimatedFillTimeSec: 2`，`relayFeeTotal: 2862104514391`，`capitalFeeTotal: 995833333334`，`lpFeePct: "0"`，附 exclusiveRelayer / fillDeadline 等存款参数。

**LI.FI**：`GET /v1/chains` 实测 200（65 条链，含 1 / 8453 / 11155111 / 84532）；`GET /v1/quote` 免 key 通道在本机共享出口下三次实测均 **429**——`{"message":"Rate limit exceeded, retry in 26 minutes","code":1005}`（限流计数随共享出口用量浮动）。其 Intents 面 `GET order.li.fi/api/v1/integrator/routes` 实测 200，eip155:1 → eip155:8453 有 14 条求解器路由（如 ETH→ETH min 26446867918674 / max 44254598326573376159），证明主网求解器供给真实存在；本轮实现走经典 `/v1/quote` 面，生产前按门槛第 1 条申请 key。

**deBridge DLN**：`GET /v1.0/supported-chains-info` 实测 200，18 条链全为主网/内部 ID，无测试网。

## 7. 回归与验收（本轮实测）

- 合约：零改动；`forge test` **108/108 全绿**，与第十九轮基线一致。
- 前端：`npm test` **116/116 全绿**（第十九轮基线 101 + 本轮新增 15）；`npm run build`（tsc + vite）成功。
- 构建产物检查：含四家通道名（LayerZero / Chainlink CCIP / Wormhole（NTT）/ 极速到账（做市商垫付））、「主网功能 · 测试网不可用」徽标文案、li.quest 端点；既有地址抽查在产物中（Sepolia Settlement `0x929ceb05…`、Base Sepolia Settlement `0x3F9F29A6…`、双链 LZ 桥 `0x7a0eCbc2…` / `0xA7722A0b…`）——`chains.ts` 本轮**零改动**，round-15/16 地址簿未被覆盖。
- 三桥只读回读（不发起任何交易）：LZ 桥 peers 双向读回与第十六轮一致——Sepolia 桥 peers(40245) = `0x…A7722A0b…`（Base Sepolia 桥），Base Sepolia 桥 peers(40161) = `0x…7a0eCbc2…`（Sepolia 桥）。
- 未做事项（如实）：无主网交易、无部署、无 push；LI.FI 免 key 成功报价样本未取得（429，见 §6），主网 E2E 在门槛第 2 条。
