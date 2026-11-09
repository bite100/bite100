# 第 49 轮：MCP 方案 B——AI 接入交易所在测试网自练（2026-11-09）

> 状态：**本地分支 `round49-mcp-agent-access` 开发完成，未推送、未合并、未部署。**
> 按 Ren 2026-11-09 13:43 定序：本轮只做方案 B 的本地实现；**推进（合并/上线）等无节点收尾（阶段 5）完成后再议**，且正式开放形态还须过安全评审。
> 决策链：Ren 13:33 提出「支持接入 AI / 让 AI 可以在交易所交易」→ 调研报告 `~/workspace/research_notes/bit100-ai-mcp-access-2026-11-09/report.md` → 13:40 补充多 agent 定位 → 13:43 拍板方案 B → 13:46 定终局形态（见 §7）。

## 1. 背景与目标

让 AI 经标准 MCP 协议接入 Bit100：能看订单簿、挂单、吃单撮合、结算上链、查链上状态，先在测试网用测试钱包自练。定位双重：测试手段（AI 当玩家找问题）与产品能力（多 agent 标准入口）。调研结论：所需件全是现成的（官方 MCP SDK + 中继 REST + 前端签名/撮合/结算生产代码 + 开放提交模型 B），自研只写护栏与胶水；两条铁律——护栏必须硬编码在服务端、AI 只当玩家不当裁判（对账裁判是链上读数与脚本）。

## 2. 每块做法

### 块 1：只读 MCP（commit 997d7b9）

新包 `mcp/`（参照 `indexer/` 的包结构）。五个只读工具：`get_chain_config`（链与第 47 轮栈合约配置）、`get_orderbook`、`list_orders`（转调中继 REST）、`get_balances`（原生币 + 各代币钱包/Vault/可用余额，链上直读）、`get_order_status`（按 digest 查链上已成交量/锁定/撤单墓碑）。无私钥、无写路径。工具 schema 用 zod 严格定义（枚举/范围/地址与摘要格式），一切失败返回结构化错误 `{ok:false, error:{code,message}}`，成功为 `{ok:true, data}`——任何 MCP 客户端可机读，无单一客户端假设。同时落地块 2 地基：agent 注册表与 signer 接口（见块 2）。

### 块 2：护栏内核 + 挂单/撤单（commit 73fe9b3）

- **agent 注册表**（JSON 配置）：每 agent 独立 `id`、令牌的 SHA-256 哈希（明文不落盘）、钱包角色（maker/taker/operator）、单笔上限、每日上限、每分钟写频率上限、`enabled` 开关。每进程绑定一个 agent 身份（启动时令牌认证），可单独停用任一 agent。
- **WriteGuard**（服务端硬编码）：写前依次验——agent 启用状态、全局急停、链白名单（仅 11155111/84532，主网直接拒）、交易对白名单（现行 8 个测试对）、单笔/每日/频率限额；拒绝发生在构建签名与任何链/中继副作用之前。限额以计价代币人类单位计名义额（价×量）；计数器为进程内（UTC 日归零），持久账本以审计日志为准（脚手架口径，见 §6）。
- **全局急停**：环境变量 `BIT100_MCP_KILL_SWITCH=1` 或注册表同目录出现 `kill-switch` 文件，任一成立→写工具全拒、读工具照常。
- **私钥纪律**：只在运行时从环境变量指向的 env 文件路径读取（与 `~/workspace/bite100-deployer/*.env` 同格式，取首个私钥），仅存内存；代码、配置、审计、git 历史均无密钥（交付前已自查）。
- **place_order**：骑前端生产代码构建订单（`dualread/digest.buildSignedOrderData` 按规范从原始字段重构签名数据，与 soak 生成器/阶段 4 运行器同路径）+ `orderSigning.fetchOrderNonce` 取链上 nonce + EIP-712 签名（只经 signer 接口），投中继 `POST /orders`（中继入库自带验签）。订单未落锁——与网页端一致，落锁在撮合时由提交方完成。
- **hard_cancel_order**：只做链上硬撤（见 §5 撤单面结论）。
- **审计**：server 层统一拦截，每次工具调用追加一条 JSONL 到 `audit/<agentId>.jsonl`（时间、agent、工具、参数摘要、结果、tx 哈希），append-only。

### 块 3：吃单撮合 + 结算 + 自练实测

- **match_order**：taker 订单签名后投中继，再骑前端生产 `executeFrontendMatch` 走全路径（双读→本地撮合→双方落锁→预检模拟剔腿→`settleTradesBatch` 自提）。双读依赖按阶段 4 运行器同法注入（`createRelayBookAdapter` + `createChainStateReader(createViemChainTransport())`；节点适配器走缺省——节点已停机，其失败被双读记为源错误，与阶段 4 降级语义一致）。
- **Node 适配层量化（调研点名的最大变量）**：**零行适配层**。`execute.ts` 与 dualread 全家在阶段 4 已被证明可无头运行于 Node；本轮仅复用 stage4 的 esbuild 打包法（`import.meta.env` define 为空对象）把前端生产模块与 MCP 包打成单个 Node ESM。胶水仅 match.ts 里约 5 行依赖注入对象。
- **自练 E2E**（`mcp/src/e2e.ts`）：官方 MCP 客户端 SDK 经 stdio 拉起真实 server 进程，全程只经 MCP 工具完成：看簿→maker 挂单→taker 吃单→结算→链上核对（Settlement 已成交量按摘要精确比对、双方余额增量）→部分成交→operator 硬撤→墓碑与锁释放复核；双链各走全环；负面用例同场验。共享测试簿的现实处理：定额按双方 Vault 可用量动态取；同价旧单可能先被撮合，第一阶段循环挂单+撮合直至链上确认本轮单成交；第二阶段用独立价格（1.49）避开同价队列。开跑前由 operator 经硬撤工具清扫本方未过期悬挂锁。
- **E2E 环境备料（工具面之外，如实记录）**：旧验收（阶段 4 等）留下的过期锁占用了 maker/taker 的 Vault 可用量（Sepolia maker TKA 可用一度仅 0.6），按第 47 轮注资同法，在 E2E 之外给 maker/taker 的 Vault 各存入测试 TKA/TKB 各 200/链（`mcp/fund-vaults.mjs` 留痕，approve+deposit 共 16 笔，Sepolia 8 笔 + Base 8 笔全成功）。交易全环仍 100% 经 MCP 工具。

### 块 4：文档（本文件 + docs/INDEX.md 登记 + mcp/README.md 使用说明）

## 3. 骑乘对照表（不重复造轮子核查）

| 本轮新件 | 骑乘的既有件 |
|---|---|
| MCP 服务端框架 | 官方 `@modelcontextprotocol/sdk` **1.32.2**（精确锁版；调研指出官方正处 v1→v2 换代，本轮锁 v1 稳定线，v2 迁移留待产品化阶段评估） |
| 只读订单数据 | 现有中继 REST（GET /orders、/orderbook、/health），零改动 |
| 链/交易对/合约地址 | `frontend/src/config/chains.ts` + `pairs.ts`（第 47 轮栈的单一事实源，本包不复制地址表） |
| 订单构建与摘要 | 前端生产 `dualread/digest.ts` 的 `buildSignedOrderData`/`computeOrderDigest`（soak/阶段 4 同路径） |
| nonce 与签名域 | 前端生产 `orderSigning.ts`/`orderSigningTypes.ts`（EIP-712） |
| 撮合与结算 | 前端生产 `services/matching/execute.ts`（`executeFrontendMatch`）+ dualread 适配器/链状态读取器（阶段 4 运行器同法注入） |
| 硬撤 | 合约既有 `Vault.releaseOrderLock`（第 46/47 轮语义） |
| 链上读 | ethers 6.17.0（与前端同版）最小 ABI 片段（与 soak generator 的既有模式同构）；viem 2.57.16（与 indexer 同版，dualread 链读传输层需要） |
| 参数校验 | zod（前端生态既有依赖） |
| 打包 | esbuild 0.28.2 + stage4 `build.mjs` 打包法（import.meta.env define） |
| 自练驱动 | 官方 MCP SDK 客户端（stdio 拉起真实 server，只经工具调用） |
| **自研部分（仅胶水与护栏）** | agent 注册表/限额/急停（agents.ts）、signer 接口与测试钱包实现（signers.ts）、工具整形与审计拦截（server.ts/tools）、E2E 驱动脚本 |

## 4. 护栏清单（全部服务端硬编码）

1. 身份：令牌 SHA-256 哈希比对，未知令牌连工具都调不了；每 agent 可单独 `enabled:false` 停用。
2. 全局急停：环境变量或 kill-switch 文件；急停时写全拒、读照常（单测 + 实测均验）。
3. 链白名单：仅 11155111 / 84532；主网 chainId 在参数校验后、任何副作用前被拒（`chain_not_allowed`）。
4. 交易对白名单：现行 8 个测试交易对（`pair_not_allowed`）。
5. 合约地址：只从 chains 配置读现行第 47 轮栈，无任何硬编码副本（单测断言双链地址与配置一致）。
6. 限额：单笔名义额、每日累计、每分钟写次数（`over_per_order_cap` / `over_daily_cap` / `rate_limited`）。
7. 私钥：仅运行时经环境注入路径读取，不入代码/配置/日志/git。
8. 审计：append-only JSONL 按 agent 分文件，含 tx 哈希，事后可对账。
9. 撤单权限：硬撤仅 locker 身份（当前测试栈只有 operator），非 locker 结构化拒绝（`not_locker`）。

## 5. 撤单面结论（如实记录）

- 中继**没有撤单路由**（只有 POST/GET /orders、GET /orderbook、GET /health）；签名撤单（signCancelOrder）的接收方是 Go 节点，**节点已停机**。
- 因此当前唯一真实可用的撤单面 = **链上硬撤** `Vault.releaseOrderLock`，且只对**已落锁**的订单有意义、只对 **locker** 身份可执行（第 46/47 轮语义：释放锁 + 置永久墓碑）。
- **未落锁的挂单无任何撤单手段**：只能等过期（TTL）或被成交。`hard_cancel_order` 对这类订单如实返回 `cancelled:false, reason:"no_active_lock"` 并说明缺口，**不做假装能撤的工具**。
- 含义：AI 挂出的单在被撮合落锁前不可撤——练习与后续产品设计都须按此约束（产品化阶段若要补齐，需给中继加签名撤单路由或等阶段 5 后的新撤单面设计，属后续轮次议题）。

## 6. 已知缺口与观察项

1. **撤单面缺口**（§5）：未落锁订单不可撤。
2. **中止撮合留悬挂锁**（实测观察）：`executeFrontendMatch` 先落锁后模拟/结算，中途中止时已落的锁保留至订单过期（产品既有行为，阶段 4 已知）。后果：测试钱包 Vault 可用量被历史悬挂锁逐步占用；E2E 以 operator 硬撤未过期锁 + 外部注资对冲。产品化前值得评估锁的回收口径。
3. **限额计数为进程内**：重启清零、跨进程不共享（每 agent 一进程时其每日计数只含本进程）。练习脚手架可接受；审计 JSONL 是持久对账依据。产品化阶段应把计数落到中继/D1 或独立存储。
4. **公共 RPC 限流**：Base Sepolia 公共端点 25 次/秒限流会让密集链读偶发失败（实测 get_balances 重试后恢复）；撮合路径内部的双读/模拟同样吃这个端点。产品化需自备 RPC。
5. **nonce 口径**：place/match 每单现读链上 `getCurrentNonce`（与网页端一致）。同一钱包多单并发未结算时共享同一 nonce，先结算者消耗后其余单结算将失败——网页端同此口径；AI 高频并发挂单的产品化设计需处理（如本地 nonce 游标，soak 生成器已有此模式可骑）。
6. **Sepolia gas 计量放大**：publicnode 的 gas 计量约 ×7 是既有已知现象，撮合路径沿用生产代码的估算×1.25 策略，实测可跑通；主网口径与此无关。
7. E2E 定额与价格是练习参数（TKA/TKB @1.5/1.49），不构成任何定价口径。

## 7. 终局形态 vs 本轮脚手架（Ren 2026-11-09 13:46 定）

**终局形态**：「任何人用任何 AI，只要用了交易所的 MCP，接入钱包，接入交易所都可以进行交易。」即——

- MCP 是面向所有人的**标准入口**：任何人、任何 AI 客户端，接上交易所的 MCP、连上**自己的钱包**即可交易；工具与协议层不含任何针对单一客户端的假设（本轮已按此实现：标准 MCP over stdio + 结构化 JSON 结果）。
- **钱包自托管**：交易所永远不碰用户私钥。签名抽象为可替换的 `AgentSigner` 接口（`mcp/src/signers.ts`），工具层只依赖接口。

**本轮脚手架与终局的区别**：本轮实现的 `TestWalletSigner` 是「服务端测试钱包签名器」——服务端进程持有**无价值的测试钥**替 agent 签名。这是测试网练习的临时形态，**不是产品形态**：它只对测试网测试钥成立，限额/白名单/急停护栏也都是为练习场设的。将来产品化只需新增「用户自带钱包签名器」实现（外部钱包/用户自己的 agent 钱包回签）替换之，**工具层零改动**；正式开放的前置条件 = 无节点收尾完成 + 安全评审。

## 8. E2E 证据（双链全环，经 MCP 工具）

交易对 TKA/TKB，定额 0.5（按可用量动态定额的上限值），全量价 1.5、部分阶段价 1.49。断言口径：已成交量按订单摘要在链上精确比对（Settlement.orderFilledIn），余额为钱包+Vault 合计增量（扣 0.01% 手续费与 gas 抵扣后）。

| 链 | 阶段 | 结果 | 链上证据 |
|---|---|---|---|
| Sepolia 11155111 | maker 挂单 → taker 吃单全量结算 | ✓ 成交 0.5（链上精确一致） | 结算 tx `0x8e82d9752d0e43fa7ef1fb2d8c6798fa1d8af40dc3de35c217fe70cf1d1e01e6`；maker TKB +0.74992、taker TKA +0.49995 |
| Sepolia 11155111 | 部分成交 0.25 后余量仍锁定 | ✓ filled=0.25、locked=true | 部分结算 tx `0xcd957d9d1b4d483d8af88fc05eda73962f629672345d22e7c1713936a6098ff2` |
| Sepolia 11155111 | operator 硬撤余量 | ✓ 墓碑置位、锁释放 | 硬撤 tx `0x08f8de4b2a60d0751574f888e6e9423f93d90089492fb0815a689ec74ae53302` |
| Base Sepolia 84532 | maker 挂单 → taker 吃单全量结算 | ✓ 成交 0.5（链上精确一致） | 结算 tx `0xc1ab2cb805f6fe2e05b7296bc89f603d14988e8b24dcda2f945d7acc1bbc5856`；maker TKB +0.74698、taker TKA +0.49995 |
| Base Sepolia 84532 | 部分成交 0.25 后余量仍锁定 | ✓ filled=0.25、locked=true | 部分结算 tx `0xb442f44e31772954ff7df20ccc2b4d2a7a63ede847b6718bac9bafebff45f973` |
| Base Sepolia 84532 | operator 硬撤余量 | ✓ 墓碑置位、锁释放 | 硬撤 tx `0x3f9c8c847f85e698a565b8969dca2201dc011da3d38f18c4cf28490ad3117c28` |

另有开跑前清扫的硬撤实证（Sepolia）：operator 硬撤上一轮悬挂锁订单 tx `0x5b9c7c120c4bd5df3bb6f0677c1b8892351d16f0173d4847e41a3064432c438d`。审计日志样本在 `mcp/audit/*.jsonl`（本地，未入 git）。Base 公共 RPC 在密集调用下限流（25 次/秒 + 空响应），E2E 读路径以顺序读 + 重试对冲，最终全过；此为 §6-4 的实测依据。首轮 E2E 还实测抓到并修复了两个真实读口径 bug：Vault.orderLocks 返回结构是 (user, token, remaining, expiresAt) 四字段（非五字段）、Vault.balanceOf 参数序为 (token, user) 与 availableBalance 相反——均已按 Vault.sol 源码核对修正（chain.ts）。

负面测试（实测，与正环同场）：主网 chainId → `chain_not_allowed` ✓；白名单外交易对 → `pair_not_allowed` ✓；超单笔上限 → `over_per_order_cap` ✓；停用 agent 写 → `agent_disabled`、读照常 ✓；全局急停写 → `kill_switch_on`、读照常 ✓。单元测试另覆盖：每日上限累计、频率上限、急停文件形态、注册表认证、signer 签名可验、中继错误映射、硬撤 no_active_lock/幂等 等。

## 9. 测试与门禁

- mcp 包单测：**38/38**（6 文件：config/agents/relay/read-tools/signers/write-tools）。
- mcp typecheck（tsc --noEmit）干净；esbuild 双 bundle（server + e2e）构建成功。
- frontend 既有 vitest：**438/438**（本分支基线，未回退；本轮未改 frontend 任何文件）；frontend build 成功。
- git 自查：本轮全部改动只在 `mcp/` 与 `docs/`；无密钥（密钥只在运行时经环境路径读取；单测用的 Anvil 公开文档测试钥以分半拼接形式出现，已在测试内注明）。
- 合约零改动；中继零改动；未 push、未 merge、未部署（遵 Ren 定序）。

## 10. 后续推进条件

1. 无节点收尾（阶段 5）完成后，再议本分支的合并/上线。
2. 产品化（任何人自带钱包接入）须先过安全评审，并补：用户钱包签名器实现、限额计数持久化、自备 RPC、（如需）未落锁订单的撤单面设计。
