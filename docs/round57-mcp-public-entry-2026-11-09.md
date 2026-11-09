# 第 57 轮：MCP 推进——r49 合并复验 + 公开入口（Workers）上线（2026-11-09 晚）

> 状态：**本地分支 `round57-mcp-public-entry` 完成，未推送。**公开入口已实际部署并通过真实客户端冒烟：**https://bit100-mcp.q3874758.workers.dev**（测试网，申请制令牌）。
> 决策链：无节点收官（2026-11-09 16:48）满足第 49 轮文档 §10 的推进条件 → Ren 2026-11-09 17:00 在三选项中拍板「直接做公开入口，慢点没关系」→ 本轮执行两步：① r49 合并与复验；② Workers 公开入口移植与部署。

## 1. 第一步：合并（方向与冲突处理）

- **方向**：把 main（03f7262）合并进 `round49-mcp-agent-access`（合并提交 4654cc9），第 57 轮分支自合并结果分出。理由：冲突面与方向无关（见下），而此方向让已推送的 main 工作树保持原样、零误推风险；将来本分支并回 main 时 main 是其祖先，属干净合并。
- **冲突面实测**：r49 的全部改动只在 `mcp/` 与 `docs/INDEX.md`；与 main 自基线 bd48a16 以来的改动重叠文件**只有 `docs/INDEX.md` 一个**。手工合解：保留 main 的 47（状态更新）/48/50/51/52/53/54/56 全部行，49 行插入 48 与 50 之间并回填状态。
- **任务书担心的两个读口径 bug**（orderLocks 四字段序、Vault.balanceOf 参数序）：修复落在 `mcp/src/chain.ts`（MCP 包自己的链读层），**不在 frontend 文件里**，与 r51/r52/r54 的前端改动零重叠，无回退风险，已逐处核对。
- **合并真正暴露的一处断裂**（当场修复，提交 ae94054）：第 53 轮 MakerVault 退役从 `frontend/src/config/chains.ts` 删除了 `contracts.makerVault` 字段，而 `mcp/src/config.ts` 的 `chainSummary` 还在读它——合并后 typecheck 报 TS2339。修法：删该字段（退役产品不再出现在链配置摘要里）；无测试依赖该字段。

## 2. 合并后门禁（实测）

| 门禁 | 结果 |
|---|---|
| mcp 单测 | **38/38**（与 r49 基线同数） |
| mcp typecheck（tsc --noEmit） | 干净（修完 §1 断裂后） |
| mcp build（esbuild 双 bundle） | 成功 |
| frontend vitest | **427/427**（与 main 基线同数） |
| frontend build / tsc -b | 成功 / 干净 |

## 3. 合并后 E2E 复跑（只经 MCP 工具，Sepolia 全环）

`BIT100_MCP_E2E_CHAINS=11155111 npm run e2e`：**19 PASS / 0 FAIL**。

| 阶段 | 证据 |
|---|---|
| 全量结算 0.5 TKA | tx `0x4d9e32a5a852952d855e2b7e823aff1748c733dc95ed191929ab051e9745f8b7`；maker TKB +0.74992、taker TKA +0.49995、链上 filled == 0.5 |
| 部分成交 0.25 后余量仍锁定 | tx `0x975b5c36241339a984ec542a63cd56a97fadf481534c9e52ed289e5eb0784a15` |
| operator 硬撤余量 | tx `0x23fbf5ad0bc62f2822132d965f600e3f7e4cddc028696c2f020ed6c8cf5b69f8`；墓碑置位、锁释放断言通过 |
| 负面 7 项 | 主网链拒 / 白名单外对拒 / 超单笔拒 / 停用 agent 写拒读通 / 急停写拒读通，全过 |
| 开跑前清扫 | 上一轮（补测 A）悬挂锁 2 单经硬撤清理：`0xd6762e1c…`、`0xf8f758b5…` |

注：合并后的撮合路径骑的是 r51 单源化后的前端撮合代码，本次 E2E 是它与 MCP 工具层组合的首次实链验证，通过。

## 4. 第二步：可行性映射（先映射再写码）

| r49 组件 | Node 依赖 | Workers 处理 |
|---|---|---|
| MCP 传输（stdio） | 官方 SDK StdioServerTransport | SDK 1.32.2 **自带** `WebStandardStreamableHTTPServerTransport`（Web 标准 Request/Response，为边缘运行时设计）→ 无状态模式（sessionIdGenerator 不设）+ enableJsonResponse；每请求新建 server/transport 装配 |
| 工具层（read/write/orderBuild） | zod、ethers、前端 digest/orderSigning | **整层复用零改动**（仅 §6 的 relay fetch 根修与下两项装配级改动） |
| 注册表（JSON 文件） | node:fs | D1 `agents` 表（只存 token_hash）；每请求 Bearer 明文 → WebCrypto SHA-256 → 查表认证 |
| WriteGuard（进程内计数） | 内存 Map | D1 状态层（`src/worker/state.ts`）：请求开始预取当日累计 + 近 60 秒写事件，check/record 判定顺序与错误码逐项同构；record 以增量 upsert + 事件插入入队，waitUntil 刷盘。**并发口径**：跨请求并发下 check 用预取快照，极端并发可能短暂小幅越限，落库总量不受影响——测试网练习可接受，文档如实记录 |
| 急停（env/文件） | process.env + fs | D1 `config.kill_switch='1'` 或绑定 `KILL_SWITCH='1'`，任一成立；切换 = 一行 SQL，不用重部署 |
| 审计（JSONL） | node:fs append | D1 `audit_log` 只追加（无更新/删除路径），经同一 waitUntil 队列落库 |
| 链读（ethers JsonRpcProvider） | ethers Node 构建 | ethers **browser 构建**（见 §6 打包坑 2），JsonRpcProvider 走全局 fetch，在 Workers 实测可用（get_balances 冒烟过） |
| 签名（TestWalletSigner） | node:fs 读钥文件 | signers.ts 加钥文本注入钩子 `_setKeyTextProvider`（Node 路径不注入、行为逐字不变，单测覆盖）；Workers 从 secret 绑定注入三角色测试钥，仍只经 AgentSigner 接口 |
| 中继转调（fetch） | 全局 fetch | Worker 内全局 fetch 打另一个 workers.dev 地址实测 **1042** → 改 **service binding**（metadata 绑 RELAY→bit100-relay），RelayClient 的 fetchFn 注入点现成 |
| match_order（撮合引擎） | 
...[truncated 5836 chars]