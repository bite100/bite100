# 第五十九轮：MCP 加固 + AI 自助接入 + 审查骑乘项清扫（2026-11-10）

> 派工简报：`docs/round59-brief-2026-11-10.md`（主聊天裁定版，未入仓）。
> 基线 main `e6267a8`；分支 `round59-mcp-hardening`。**本轮红线：合约零改动、不部署、不合并、不推送、不对外发有效令牌**——全部交付为本地提交，部署与发令牌留待 Ren 拍板的后续轮次。
> 素材来源：r57/r58 ChatGPT 审查裁定（3×P1）、第 60 轮审查裁定（1×P1+3×P2+1×P3）、Cloudflare 安全审计技能试跑确认项（7 条）、AI 自助接入调研报告（仓外 `~/workspace/research_notes/ai-agent-self-serve-onboarding-20261109-1651/report.md`，Ren 拍板「1+3」：方案 1 主路线 + 方案 3 预留）。

## 1. 块 1 — MCP 记账协议重做（`837c67d`）

修 r57 三条 P1 + 审计 ⑥⑦，stdio 与 Workers 两条路径同口径：

- **记账点统一为「中继接受（HTTP 200）」**：守卫协议从 check/record 两段式改为 check（校验+预留）/ release（释放预留）。check 通过即落速率事件且永不回滚（每个通过 check 的尝试都计速率——关闭审计 ⑥：失败/早退路径零记账）；日额在 check 时预占，release 只回滚日额、只在「中继接受之前失败」（构造/签名抛错、中继非 200）时调用。place_order 与 match_order 同口径——无对手的 match 单从此消耗日额（关闭 P1-①）。旧 `record()` 删除。
- **D1 原子额度（关闭 P1-②）**：日额 = 单条条件 upsert（`INSERT … ON CONFLICT DO UPDATE … WHERE total+excluded <= cap`，changes=0 即超限）；速率 = 单条带门 INSERT（`INSERT … SELECT … WHERE (SELECT COUNT(*) …) < limit`）。请求级预取快照整段删除，DB 即真相。check 中途 D1 失败 → `guard_unavailable` 失败关闭（不签任何单）+ 尽力回滚已落速率事件。stdio WriteGuard 同步实现同一协议（进程内预留语义）。
- **审计先落库后返回（关闭 P1-③）**：Worker 入口改为先 `await flush()` 再返回响应，失败重试一次，仍失败返回 HTTP 500 JSON-RPC 错误（显式丢失、交易可按 digest 对账），waitUntil 异步刷盘删除。顺带修掉 flush 的一个真 bug：旧实现先抽干队列再 await batch，重试刷的是空队列 = 静默丢审计——改为 batch 成功后才出队。
- **额度字段格式校验（审计 ⑦，本块提前落地——注册写入器在本轮块 3 落地，校验必须同轮先行）**：D1 行 per-order/daily 必须匹配金额正则、rate 必须为 1–600 整数，否则该代理视为不存在（401）+ 尽力写一条 `invalid_agent_config` 审计行。非数字 TEXT 让额度变 NaN 静默放行自此关闭。校验正则抽到零依赖叶子模块 `mcp/src/caps.ts`（两后端共用；顺带保住 Worker 打包图不被 node:crypto 污染，块 2 打包时验证了这条纪律的必要性）。

验收测试（新文件 `mcp/test/fakeD1.ts` 内存 D1 + `worker-state.test.ts` + `guard-accounting.test.ts`）：日额并发恰一笔准入、速率并发 6 抢 3 恰 3 过、release 语义、D1 宕机守卫失败关闭、kill-switch/disabled/缺私钥时私钥加载次数与中继投递次数均为 0、match 无对手仍记账。

## 2. 块 2 — match_order 移植 Workers 公开入口（`5921443`）

- 公开入口 7 → **8 工具**：match_order 接入 `entry.ts`，撮合引擎直接骑前端生产代码（`frontend/src/services/matching/execute`），订单簿读取经 RELAY 服务绑定注入口（stdio 路径不变，阶段 4 行为逐字保留）。
- 打包体积 gzip **377,281 B**（终测；含块 3 的注册+说明书），与 r57 的 373 KB 同量级——撮合引擎骑既有打包图、没有引入第二套实现。
- `worker-entry.test.ts` 以真入口 fetch + FakeD1 + RELAY 绑定替身端到端驱动：8 工具清单、审计在响应返回时已落库、无/坏令牌 401、D1 宕机 503、kill-switch 下 place_order 零中继调用、审计落库失败 → HTTP 500。
- `smoke.mjs` 同步 8 工具 + 无对手 match 探针，版本号 0.57.0 → 0.59.0（server/smoke 一致）。**smoke 本轮未运行**（无部署，见 §7）。

## 3. 块 3 — AI 自助注册 + 托管说明书 + 接入页改版（`6d58d12` + `4800311`）

方案 1 主路线（Ren 拍板「1+3」）：

- **迁移 `0002_r59_register.sql`**（只写未应用，见 §7）：agents 加 `name / created_at / source / wallet_address` 四列；新表 `registration_events(ip, ts_ms)` + 索引；config 置 `registration_open='1'`。`deploy.mjs` 已更新为按序应用 0001+0002（0002 重跑仅容忍 duplicate column 错误）。
- **POST /register（公开）**：令牌 = `b100_` + 64 hex（32 随机字节），只存 SHA-256；agent id = `agt_` + 16 hex，冲突重试 3 次。限额**只来自服务端常量，请求体自报限额一律忽略**（测试钉住：body 写 999999 落库仍是常量值）。角色：maker 缺省、taker 可选，**operator 及其它一切值 → 400**（operator 是 Vault 锁定人，审计明示绝不经自助发放）。`walletAddress` 只做格式校验后存档、**不验证、不授予任何东西**——SIWE/ERC-8004 仅预留数据结构与说明书章节，本轮不实现（方案 3 后续加固层）。
- **GET /skill.md（托管说明书）**：与注册同源托管——frontmatter（name/version/api_base）、注册 curl、令牌只显示一次且不得发往其它域名的红线、MCP 配置样例、8 工具自检、限额与爬坡表、**记账口径明示**（中继接受即记账、投递失败计速率不计日额）、错误码、硬撤单锁定人诚实说明、令牌泄露处置、预留的钱包身份章节。
- **防滥用数字与理由**（详见 §6）：默认限额 单笔 10 / 日 50 / 速率 10 每分钟——沿用 r57 冒烟代理在 D1 实读验证过的规模（'10'/'50'），泄露令牌的爆炸半径最小；**首 24 小时爬坡** 5/20/5（调研报告 Moltbook 式新号爬坡，减半起步）；注册端点 per-IP 10/小时、全局 100/小时——调研中 Firecrawl 式端点上限（60/IP/小时、全局千级/日）按本服务测试网规模等比缩小（÷6 / 约 ÷10）；**所有注册尝试（含被拒）先落事件行再判定**，探测本身也消耗预算；另有机会性 24h 旧事件清理、`registration_open` 急停开关、D1 故障 503 失败关闭。
- **AI 接入页改版**（功能变更同轮带说明，项目规矩）：申请制全文删除，改为自助口径——「把这段话发给你的 AI」英文粘贴段 + 复制按钮（≥44px 触控）、接入前提、五步步骤（含手工 curl 兜底）、8 工具清单、新号限额与记账口径、安全护栏、注意事项（令牌丢失=重新注册、未锁定订单撤不掉、钱包身份为预留）。页面单测含负向断言（申请制/占位地址等旧文案不得出现）。`mcp/README.md` §7 同步新口径。

## 4. 块 4 — 中继骑乘项清扫（`e860efa` 中继 + `223095a` 前端）

- **审计 ①（本轮最高优先）状态服务端生成**：POST /orders 入库 status/filled 恒为 `'open'`/`'0'`，请求体自报值忽略——堵「未签名状态先写者胜、抢投他人订单伪造 cancelled 把单藏出订单簿」。execType 保留为非权威提示（不参与订单簿过滤，过滤只看服务端 status）。workers 回归测试钉住：投毒订单仍进订单簿、落库行状态干净。
- **审计 ② 时效窗口**：TTL 上限 30 天（`order ttl too long`）+ createdAt 窗口（−1h/+15min，容时钟偏差）；过期检查仍最先（存量测试口径不变）。副作用如实记录：旧 orderbook 排序测试的固定历史/远未来时间戳夹具（2023/2033）被新窗口正当拒绝，夹具已改当前时刻相对值，排序语义不变。
- **审计 ③ 验签放大削减**：digest 存在性检查前置于验签（重复投递零 RPC，垃圾签名重投已存订单 → duplicate 而非 401，测试钉住）；ERC-1271 回退前查地址代码存在性（60 秒/地址缓存，已知 EOA 本地拒绝不再烧 eth_call；getCode 出错按未知处理不短路）；POST /orders 每 IP 每分钟 120 次固定窗口限流（isolate 内存，**只是防滥用层、不是额度账本**——Cloudflare 平台 Rate Limiting 作账本的口径经裁定不采纳，理由同裁定记录：近似计数当不了额度）。
- **pairs 四条**：限流预检移到任何 RPC 之前（第 60 轮 P1-1，超限请求零 RPC，计数替身钉住）；匿名 creator 共享 50/日桶（审计 ④）；落库改带门 `INSERT … SELECT … WHERE` 原子判定（P2-1，并发 49+2 恰一成一 429）；decimals ≤36 且 `18+quote−base ≥ 0`（P2-2，中继注册端 + 前端 readTokenMetadata 同口径）；listPairs 分页 limit/offset + total/truncated，端点数组形状不变、走 `X-Pairs-Total / X-Pairs-Truncated` 响应头，前端顺头翻页取全集（P3-1）。
- **审计 P2-3 美元标注收紧**：行情页 DexScreener 参考价冠 $ 的条件从「符号像稳定币」改为 `isKnownUsdStableToken`（符号在名单内 + 地址与链配置登记的正牌地址逐字一致）；自助对仿冒 USDT 不再骗到美元标注，种子对行为不变。
- **审计 ⑤ NIP-40**：Nostr 镜像事件并行带标准 `expiration` 标签（自有 `exp` 保留兼容）。如实口径：这仍不构成镜像侧撤单墓碑，订单状态以链上为准，不变。

## 5. 块 5 — 审查骑乘测试补强（`87cd316`）

- useTokenPrice 迟到**失败**回归测试：切换 token 后旧请求才 reject，新 token 的 error 保持 null、价格不污染（r58 只钉了迟到成功路径）。
- 阶段 4 运行器：`parseCsvList/parseChains/parsePairs` 导出化；cycle 回落对与 runCheck 预检探针对两处重复规则抽为共用纯函数 `pickCheckPair`（语义逐字不变、缺省不变）；新增 `scripts/stage4/config.test.mjs`（沿 faults 的 esbuild 打包法）13 场景：缺省双链/全 8 对、子集保序去重、显式空/空项抛错、白名单外抛错、代表对三分支。`npm run test:stage4-config` 接线；faults 全套复跑通过。
- D1Guard 单元测试已在块 1 随 `worker-state.test.ts` 交付，本块无欠账。

## 6. 骑乘清单（每个新组件骑哪个既有件）

| 新件 | 骑乘的既有件 |
|---|---|
| D1 原子额度 | D1/SQLite 单语句条件 upsert + 带门 INSERT…SELECT 语义（零新基础设施、零锁、零 KV） |
| stdio 守卫协议 | 既有 WriteGuard 结构与 agents.json 口径，仅协议对齐 |
| 额度格式校验 | 既有金额正则（抽到零依赖叶子 `caps.ts` 两后端共用） |
| match_order Workers 版 | 前端生产撮合引擎 execute.ts + r57 的 build-worker 别名/桩图（零新撮合代码） |
| 自助注册 | 既有 agents 表（迁移扩列）+ config 表急停开关 + state.ts 的 sha256Hex |
| 托管说明书 skill.md | MCP Worker 同源静态路由（零新托管） |
| pairs 带门落库 | SQLite INSERT OR IGNORE … SELECT … WHERE |
| POST /orders 限流 | isolate 内存固定窗口小件（明示非账本；不引入平台 Rate Limiting 依赖） |
| ERC-1271 代码缓存 | 既有 viem PublicClient 的 getCode |
| 前端 pairs 翻页 | 中继新响应头 + 既有 listedCache/inflight 结构 |
| 美元标注收紧 | 既有 CHAIN_TOKENS 链配置表 |
| S4 配置自检 | 既有 esbuild + faults.entry 再导出模式 |

## 7. 诚实遗留（未验证 / 未做，不冒充完成）

1. **迁移 0002 只写未应用**：本轮红线不部署——生产 MCP Worker 仍是 r57 代码（7 工具、旧记账），/register、/skill.md、8 工具、全部新记账都要等 Ren 拍板的部署轮（部署脚本已按序应用迁移）。中继块 4 同理未部署，生产中继仍是第 60 轮代码。
2. **smoke.mjs 已更新未运行**：运行需要已部署 Worker + 已应用迁移的 D1，留部署轮执行。注意 smoke 的注册段每次运行消耗 2 次 per-IP 注册预算（本机 IP 与真实用户共用时需留意节奏）。
3. **没有对任何外部代理发放有效令牌**：注册全程只在 FakeD1 单元测试里演练；令牌明文从未进日志/文档/报告。
4. 审计遗留的 oversize numeric strings（needs_validation）未动——本地 wrangler 实测仍欠，口径不变。
5. 前端 readTokenMetadata 的 decimals ≤36 以代码对齐 + 中继侧测试验证，未单独写前端单测（ethers provider 替身成本过高），如实标注。
6. 治理合约三条主网阻断项与 nonce 语义分别归第 61/62 轮（裁定计划不变），本轮未碰任何合约。
7. GitHub CI 的前端 vitest 启动失败是已知环境瑕疵（非代码），本地门禁为准。

## 8. 验证证据（终测，2026-11-10）

| 门 | 命令 | 结果（基线 → 本轮） |
|---|---|---|
| mcp 测试 | `npm test` | 38/38 → **79/79**（10 文件） |
| mcp 类型 | `npm run typecheck` | 干净 |
| mcp 打包 | `npm run build:worker` | 通过，gzip 377,281 B |
| 中继单测 | `npm run test:unit` | 36 → **49/49** |
| 中继集成 | `npm run test:workers` | 19 → **24/24** |
| 中继类型 | `npm run typecheck` | 干净 |
| 前端测试 | `npx vitest run` | 462/462 → **474/474**（40 文件） |
| 前端类型/构建 | `npx tsc -b` / `npm run build` | 干净 / 通过 |
| S4 配置自检 | `npm run test:stage4-config` | 13/13 场景 |
| S4 故障自检 | `node scripts/stage4/faults.test.mjs` | 全过（F4-slow 按其自有口径 SKIP） |
| 合约 | `git diff` contracts/ | **零改动** |

提交链：`837c67d`（块 1）→ `5921443`（块 2）→ `6d58d12` + `4800311`（块 3）→ `e860efa` + `223095a`（块 4）→ `87cd316`（块 5）→ 本文档提交。

## 9. 审查修复批（2026-11-10，ChatGPT 复审本轮推送 有条件通过 后）

> 复审范围 e6267a8..4d98027（对话与裁定见 `docs/full-review-remediation-plan-2026-11-10.md` 末节）：1×P1 + 1×P2 + 1×P2/P3 必修，另 1 条审计残余接受并记录。基线 main `4d98027`（本轮已合并推送、两 Worker 已部署生产之后）；分支 `round59-review-fixes`，**本地提交，未部署、未合并、未推送**——部署与紧凑复审留待后续部署轮。合约零改动、前端零改动。

- **P1 投递结果不确定先对账（mcp，`f9f02d6`）**：place_order / match_order 的 `postOrder` 网络抛错是「结果不确定」——中继可能已入库、只是响应丢失，旧实现一律 release 每日预留，簿上活单零成本。共用新函数 `deliverOrder`（`mcp/src/tools/orderBuild.ts`，place/match 同口径）按确定性分三路：构建/签名抛错（中继未被接触）维持原 release；明确 HTTP 非 200 → release 后抛 `relay_rejected`；网络抛错 → 先按 digest 骑既有读面 `RelayClient.listOrders`（按本人地址查、摘要逐字比对）向中继对账——在簿则**不退预留**、按已接受返回并标 `deliveryReconciled: true`；确认未入库才 release 并抛原错误；对账本身失败 → fail-closed 不退预留，抛新错误码 `delivery_ambiguous`（预留保留、提示先查 list_orders）。`skill.md` 错误码表同轮补 `delivery_ambiguous` 说明。
- **P2 Nostr 镜像归一化（relay，`7943413`）**：镜像 content 旧实现是请求原文 `rawJson`，可夹带伪造 status/filled 污染镜像消费者（D1 正式行已在块 4 净化、镜像漏了）。新增纯函数 `buildMirrorRecord`（`relay/src/nostr.ts`）：字段集与存储行 / GET 返回一致（全部签名原字段 + 签名 + digest + chainId），status/filled 恒服务端生成 `'open'`/`'0'`、body 自报值直接丢弃；事件 content 改为该记录的固定键序 JSON 序列化。NIP-40 `expiration` 与自有 `exp` 标签行为不变；请求原文仍只存 D1 `raw_json` 列供可移植重发。
- **P2/P3 register 来源桶不信任 XFF（mcp，`b06c00b`）**：`clientIp()` 旧实现在缺 `cf-connecting-ip` 时回退 `x-forwarded-for`——XFF 请求方任意可写，用它分 per-IP 注册限额桶等于换头即绕开。改为缺失时一律归入共享 `unknown` 桶；CF 头存在时行为不变（生产恒经 CF 边缘，此分支只影响异常直达流量）。
- **审计残余（接受并记录，本批不修）**：审计 flush 连续两次失败返回 500 时，该次审计行随请求丢失——是显性失败而非静默成功；额度记账在预留时同步落库、不受影响；订单本身在中继留痕、可按 digest 对账。持久化重放（outbox）列为主网门槛加固候选，测试网不为此引入新基础设施。

骑乘清单（修复批）：对账骑 `RelayClient.listOrders` 既有读面 + 前端生产摘要口径（假中继测试以同一份 `buildSignedOrderData`/`computeOrderDigest` 重建 digest）；镜像记录骑中继既有存储行字段集（与 `rowToOrder` 同形状）；XFF 加固零新件（删回退分支）。

验证证据（修复批终测，2026-11-10）：

| 门 | 结果（第 59 轮基线 → 修复批） |
|---|---|
| mcp 测试 `npm test` | 79/79 → **86/86**（+6 投递对账故障注入 +1 XFF 桶） |
| mcp 类型 `npm run typecheck` | 干净 |
| mcp 打包 `npm run build:worker` | 通过，gzip 377,694 B（基线 377,281，同量级） |
| 中继单测 `npm run test:unit` | 49/49 → **51/51**（+2 镜像归一化） |
| 中继集成 `npm run test:workers` | 24/24（不变） |
| 中继类型 `npm run typecheck` | 干净 |
| 前端 / 合约 | 零改动（`git diff` 为空，未跑前端门禁——无前端变更） |

诚实标注：镜像 content 在 workers 集成环境不可直接观测（发布走 waitUntil 且测试中继不可达），归一化性质以 `buildMirrorRecord` + `buildOrderEvent` 的纯函数单测组合钉住；生产镜像内容待部署轮部署后抽查一条真实事件复核。故障注入的「对账」走生产 `listOrders` 代码路径与生产摘要比对逻辑，非测试专用旁路。

## 10. 微修复批（2026-11-10，修复批复审裁定后）+ 运维注意事项

> 复审范围 4d98027..b4f7185（裁定见 `docs/full-review-remediation-plan-2026-11-10.md` 末节「修复批复审裁定」）：3×P2 + 1×P3，其中 2 条并入本批、1 条接受已缓解不修、1 条记录不改码。基线 main `b4f7185`；分支 `round59-micro-fixes`，**本地提交，未部署、未合并、未推送**——随下一部署轮上线。合约零改动、前端零改动。

- **对账换摘要精确查（relay `0ef9d77` + mcp `1bbd8e4`）**：修复批的投递对账骑 `listOrders` 列表扫描（limit 200），复审指出同对订单超 200 时目标单可能被截断在列表外、对账误判未入库（裁定：机制成立、当前不可达——对账已按本人地址+交易对过滤且 MCP 写限 10 次/分钟，同秒同对 200+ 单不可达；但精确查是廉价根治，仍修）。中继 `GET /orders` 新增可选 `digest` 查询参数：按 digest 列精确匹配（参数归一小写后比对），与 chain/pair/userAddress 自由组合；MCP `RelayClient` 新增 `getOrderByDigest`，`deliverOrder()` 对账切换为精确查——命中 ⇒ 预留保留、确认未入库 ⇒ release、对账失败 ⇒ `delivery_ambiguous`，三路语义不变。`listOrders` 本体与其余既有用户（list_orders 工具等）不动。回归钉子：假中继同对预置 250 张更新的存量单时对账仍精确命中（旧扫描实现下必然漏检）。
- **镜像删除 execType（relay，`729bf01`）**：`buildMirrorRecord` 不再带请求体自报的 `execType`（不在签名覆盖内）——镜像只承载签名事实 + 服务端生成状态。D1 存储行与订单簿 API 保留 execType 不变：那里它已声明为非权威提示，撮合不依赖它裁决。
- **重试幂等（接受已缓解，本批不修，记录候选）**：place_order 尚无协议级幂等键；当前恢复契约是 `delivery_ambiguous` 错误文案自带订单摘要原文，并明确指示调用方「先用 list_orders 核对该摘要是否在簿、确认不在簿前不要重下同单」，托管说明书（skill.md）错误码表同口径记载。盲目重下属调用方违背明确指引，与任何交易 API 同理。**协议级幂等键（客户端订单号 + 服务端去重）记为 MCP 后续增强候选**，不在本批范围。

### 运维注意事项（部署/运维侧，改配置前必读）

- **MCP Worker 路由不得启用剥离访客 IP 头的 Managed Transform**：注册限流按 `cf-connecting-ip` 分桶（每来源 10 次/小时、全局 100 次/小时）；缺该头时一律归入共享 `unknown` 桶。若在 Cloudflare 侧为 `bit100-mcp` 的路由启用会剥离/改写访客 IP 头的 Managed Transform，全部注册请求将看不到 `cf-connecting-ip`、一齐落进 `unknown` 桶——等于全局注册被压到 10 次/小时（且任一来源的滥用会挤占所有人）。当前生产未启用此类 Transform，此为配置红线而非代码问题（复审 P3，记录不改码）。

骑乘清单（微修复批）：对账骑中继既有 `GET /orders` 读面加一个精确匹配参数 + MCP 既有 `RelayClient`/`getJson` 通道，零新端点、零新基础设施；镜像修法是删一个字段的透传，无新件；运维注意事项纯文档。

验证证据（微修复批终测，2026-11-10）：

| 门 | 结果（修复批基线 → 微修复批） |
|---|---|
| mcp 测试 `npm test` | 86/86 → **89/89**（+2 getOrderByDigest 客户端、+1 对账 250 单回归） |
| mcp 类型 `npm run typecheck` | 干净 |
| mcp 打包 `npm run build:worker` | 通过，gzip 377,727 B（修复批 377,694，同量级） |
| 中继单测 `npm run test:unit` | 51/51 → **52/52**（+1 镜像 execType 不透传） |
| 中继集成 `npm run test:workers` | 24/24 → **25/25**（+1 digest 精确查） |
| 中继类型 `npm run typecheck` | 干净 |
| 前端 / 合约 | 零改动（`git diff b4f7185 -- frontend contracts` 为空） |

## 11. 纳米修复批（2026-11-10，微修复批终审裁定后）

终审（ChatGPT 审 b4f7185..6166160：有条件通过，仅余 1×P2；主审已对代码确认成立）：`GET /orders` 的 digest 精确查建立在 `expires_at > now` 的基础查询上，摘要查继承了过期过滤——已过期但仍在库的订单会被投递对账误判为未入库，并释放其每日额度预留。语义错位：摘要查应回答「是否入库」，而非「是否在架」。**现场复现**：微修复批重新部署中继时，生产冒烟单的 TTL 只有 120 秒，订单已入库、但在按摘要对账前过期，对账查询返回 `[]`（订单实际仍在库中）。

修法（`relay/src/index.ts` 的 `handleGetOrders`）：`digest` 参数存在时改走存在性语义——查询不套 `expires_at` 过滤；`digest` 缺席时列表查询与此前逐字一致（过期过滤照旧）。chain / pair / userAddress 等其余过滤照旧可组合。

回归测试（`relay/test/workers/relay.test.ts` +1）：入库口会拒已过期订单，故按既有夹具路数直接插库一行已过期的存量订单，断言 ① 按摘要查命中该行；② 无摘要的普通列表查仍不返回该行（过期过滤未动）。已验证：该测试在修复前代码上失败、修复后通过。

验证证据（纳米修复批，2026-11-10）：中继单测 **52/52**、中继集成 25/25 → **26/26**、中继类型干净；改动面仅 `relay/` + `docs/`（`mcp/`、`frontend/`、`contracts/` 零 diff）。
