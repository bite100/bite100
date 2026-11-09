# 第 51 轮：无节点阶段 5 — 节点退役（2026-11-09）

- 分支：`round51-stage5-node-retirement`，基线 main `3db8f89`（第 48 轮合并）。
- 范围：本地分支开发；**未 push、未 merge、未部署**；合约 / relay / indexer / mcp / scripts **零逻辑改动**（git 自查见 §7）。
- 触发：阶段 5 前置已齐（第 46 轮网页链上硬取消、第 47 轮永久撤单墓碑）；Ren 2026-11-09 14:30「继续无节点推进」。
- 阶段口径：本轮完成阶段 5 的**代码侧与归档侧**；合并、线上重建与基础设施退役（cron/DNS/隧道/归档原件处置）由主聊天执行（清单见 §6）。设计文档阶段 5 状态已标注「代码侧完成、待合并与基础设施退役」，不标全完成。

## 1. 块 1：依赖测绘（移除 / 改造 / 保留）

测绘面：`nodeClient.ts`、config 节点变量、dualread 全目录、tradesDual、matching 对 dualread 的消费、订单广播、hooks、RelayStatus、TradeTabsPanel、OrderBookSection、全部相关测试；并盘清 scripts/stage4（已关闭的阶段 4 验收运行器）与 scripts/soak（已豁免停用的遗留工具）从 `src` import 的导出清单，保证兼容面不断裂。

| 表面 | 节点依赖 | 处置 |
|---|---|---|
| `src/nodeClient.ts`（tryNodes/nodeGet/nodePost/isTimeoutError） | 全部 | **移除**（文件删除；isTimeoutError 仅其自家测试使用，hardCancel 不依赖它） |
| `src/config.ts` 的 `NODE_API_URL`/`NODE_API_URLS`（VITE_NODE_API_URL） | 全部 | **移除**（`NODE_REWARDS_*` 是 NodeRewards 合约地址、与 P2P 节点无关，保留） |
| `src/config/relay.ts` 三态模式（RelayMode/parseRelayMode/effectiveRelayMode/RELAY_MODE*）+ 双发开关 RELAY_DUAL_SEND_ENABLED | 建立在节点在场的前提上 | **移除**；只留 `RELAY_URL` + `RELAY_CONFIGURED` |
| `src/services/relayDualSend.ts`（中继副发） | 副发语义 | **移除**；其发送逻辑（POST /orders + 15s 超时）主发化并入 orderService |
| `src/services/orderService.ts` `broadcastOrderDualChannel` + nodeUnknown 文案 + `cancelOrder`（签名撤单投递节点） | 节点腿 / 节点撤单面 | **改造**：`broadcastOrder` 中继单通道；`cancelOrder` 删除（中继无撤单路由，无投递面） |
| `src/services/dualread/adapters.ts` `createNodeBookAdapter` | nodeGet | **移除**；中继适配器保留并补显式超时（块 3） |
| `src/services/dualread/metrics.ts`（影子指标 ShadowObserver/computeShadowMetrics） | 双源对比 | **移除**（产品侧）；soak 遗留工具的 import 随之失效（登记影响，见 §8） |
| `src/services/dualread/evaluate.ts` `unsignedFieldConflict`/`normalizeExecType` | 双源冲突判定 | **移除**；状态机 1–8 步、验签、链上复核逐条不变；`conflict` 字段保留恒 false 兼容输出形状 |
| `src/services/dualread/index.ts` `runDualReadRound`（双源编排） | 节点源 + 指标 | **改造**：新 `runBookRound` 中继单源编排；旧名保留为兼容别名（忽略 nodeAdapter/mode/observer，node 恒 null、metrics 恒 null），供 scripts/stage4 引用不断裂 |
| `src/services/dualread/types.ts` `BookSource` | `'node' \| 'relay'` | **改造**：收窄为 `'relay'` |
| `src/services/dualread/{digest,chainState,sideProof,protocol}.ts` | 无节点依赖（验签/摘要/链上快照/方向证明） | **保留**（校验语义核心，未动） |
| `src/services/tradesDual.ts` 节点成交合并（mergeTradeSources/loadDualTrades/NodeTrade/normalizeNodeTradeRow） | 节点 /api/trades | **移除**；新增 `loadIndexerTrades` + `indexerTradeToDisplay` 索引器单源；`fetchIndexerTrades`/`IndexerTrade`/`TRADES_QUERY` 原样保留（scripts 引用） |
| `src/services/matching/execute.ts` | runDualReadRound(mode:'shadow') + 「走节点路径」文案 | **改造**：走 runBookRound；文案改「订单已留簿」 |
| `src/services/matching/fills.ts` | maker 原料 `raw.node ?? raw.relay`（测绘补漏点，类型检查时发现） | **改造**：只读 `raw.relay` |
| `src/hooks/useNodeOrderBook.ts` | nodeGet /api/orderbook | **改造**：更名 `useRelayOrderBook.ts`，骑 createRelayBookAdapter |
| `src/hooks/usePairStats.ts` | nodeGet /api/trades | **改造**：数据源改 loadIndexerTrades，聚合口径不变 |
| `src/hooks/useTradesOHLC.ts` | nodeGet /api/trades | **改造**：数据源改 loadIndexerTrades + 30 秒轮询；聚合不变；p2pWS 实时追加保留（浏览器 P2P 通道，非节点 API） |
| `src/hooks/useShadowMetrics.ts` | 影子轮询 | **移除** |
| `src/components/RelayStatus.tsx` 影子对比区 + 4 个说明组件 + 节点口径文案 | 双读呈现 | **移除**影子区；三项健康文案改单源事实；新增「节点退役（无节点阶段 5）」说明项 |
| `src/components/dashboard/OrderBookWidget.tsx` | nodeGet /api/orderbook | **改造**：骑 createRelayBookAdapter |
| `src/components/dashboard/RecentTradesWidget.tsx` | 双源 loadDualTrades / 节点单源 | **改造**：索引器单源 |
| `src/components/dashboard/TradeTabsPanel.tsx` | nodeGet orders/trades、nodePost 签名撤单、双源成交、中继回退态 | **改造**：挂单=中继簿单源（第 46 轮回退路径转正）、成交=索引器单源、签名撤单按钮删除（只剩链上撤单并补说明） |
| `src/components/HardCancelAction.tsx` | 成功后 cancelOrder best-effort 移除节点簿面 | **改造**：删除该步与 bookRemoval 口径；未落锁结果文案改如实呈现（无撤下手段、等到期） |
| `src/components/dashboard/LimitOrderFormWidget.tsx` | 双通道广播 + 节点文案（下单说明/市价说明/前端撮合说明，桌面+移动两份） | **改造**：broadcastOrder 单通道口径；全部节点文案按单源事实重写 |
| `src/OrderBookSection.tsx`（完整订单簿） | nodeGet×4、/api/node 展示、hasNodeApi 门禁、nodePost 撤单 | **改造**：盘口/我的订单=中继簿、成交=索引器、删 /api/node 展示与签名撤单、门禁改 RELAY_CONFIGURED；WS/P2P 实时增量保留（门禁改挂中继配置） |
| `src/config/matching.ts`、`src/config/indexer.ts` 头注释 | 提及节点路径/节点单源 | **改造**：注释按单源事实对齐（开关语义不变） |
| `src/config.ts` 的 `P2P_CONFIG`、`src/services/wsClient.ts`、`src/p2p/*` | 浏览器 libp2p 路径（公共 WS relay），非 Go 节点 API | **保留**（不在本轮退役面；其缺省 WS 地址仍指向本地 8080，属该路径自身的历史缺省，未配置时不连接） |
| scripts/stage4 / scripts/soak | 从 src import dualread/tradesDual/matching | **不改**（导出兼容保持，逐项核对见 §7；soak 的 ShadowObserver 一项除外，见 §8） |

## 2. 块 2：前端单源化改动要点

- **发单**：只走中继 `POST /orders`（`broadcastOrder`，15 秒 `AbortSignal.timeout`）。结果三态：中继明确接单（2xx）/ 中继明确拒单（非 2xx，`relayError` 带中继返回原因——确定性失败）/ 传输层失败（`relayUnknown`，沿用第 46 轮 P2-3「待确认」口径，文案换中继版 `BROADCAST_UNKNOWN_MESSAGE`：提示勿立即重复下单、到「当前挂单」确认）。原双通道竞速、节点腿、`nodeUnknown` 语义全部删除。
- **订单簿 / 我的订单**：只读中继簿（`createRelayBookAdapter`，全站同一适配器）。TradeTabsPanel 第 46 轮的中继回退路径转正为唯一路径（其当时注入的 10 秒 timedFetch 不再需要——适配器缺省 fetch 本轮已自带超时，见块 3）。
- **成交**：只读链上索引（`loadIndexerTrades`）。索引失败/未配置 → `failed=true`，界面显示「暂不可用」，不冒充「暂无成交」（Ren 口径：链是唯一账本，索引是展示缓存）。
- **撮合管线**：`runBookRound` 直接消费中继簿：拉簿 → 本地重构订单并重算 EIP-712 digest → 本地验签（失败补链上 ERC-1271）→ 一次链上批量快照 → 状态机评估 → 可成交集。**校验语义与双读时代逐条相同**（evaluate.ts 状态机 1–8 步未动；删除的只有双源冲突判定——单源同 digest 只有一份副本，冲突无从发生）；影子双读脚手架（metrics/observer/三态模式）删除。
- **撤单**：签名撤单（投递节点 `/api/order/cancel`）删除——中继簿无撤单接口、无投递面。唯一撤单路径 = 链上硬取消（第 46/47 轮，钱包上链释放锁定 + 撤单墓碑永久作废）。未落锁订单目前无提前撤下手段（第 49 轮已登记的产品缺口），界面文案如实呈现，不假装已撤。
- **删除**：`nodeClient.ts`、`relayDualSend.ts`、`dualread/metrics.ts`、`hooks/useShadowMetrics.ts`、`hooks/useNodeOrderBook.ts`（更名继任见上）、节点配置项与三态模式。
- **用户可见文案同轮对齐**（项目规矩：功能变更带说明）：下单表单的限价/市价/前端撮合说明（双份）、广播待确认文案、TradeTabsPanel 撤单说明与历史页签说明（中继簿只保留未成交完挂单）、OrderBookSection 页首说明与未配置兜底、RecentTradesWidget/成交页签来源标注、RelayStatus 三项健康文案 + 新增节点退役说明项、HardCancelAction 结果文案。

## 3. 块 3：根因修复（第 45 轮挂账）

- 问题：产品侧 `createRelayBookAdapter` 缺省 fetch 为裸 `fetch(url)`，无超时——阶段 4 运行器挂死的根因嫌疑；第 45 轮只在运行器侧注入带超时 fetch 绕行，产品缺省路径仍无界。
- 修复：缺省 fetch 改为 AbortController + `RELAY_BOOK_TIMEOUT_MS = 10_000`（`createRelayBookAdapter(baseUrl?, fetchFn?, { timeoutMs })`，签名向后兼容，scripts/stage4 的两参调用不受影响；注入 fetchFn 的调用方自带超时纪律不变）。至此产品读取路径的全部网络调用均有显式超时：中继簿 10s（本项）、索引器 8s（第 39 轮既有）、发单 15s、RelayStatus 探活 6s（既有）。
- 证据测试（dualread.test.ts 新增 describe「第 51 轮块 3 根因修复」）：对端永不响应（只在 abort 时 reject 的 fetch 桩）→ `fetchBook` 在截止期内 reject（timeoutMs=50 注入，断言 5 秒内落定）；注入 fetchFn 路径不受缺省超时影响。

## 4. 测试改写登记（原断言 / 为何失效 / 新断言）

基线 450 个 / 39 文件 → 本轮 409 个 / 37 文件，全绿。逐项对账：删除随模块 −25（nodeClient 19 + relayDualSend 6）；dualread 67→61（−6）；tradesDual 22→16（−6）；orderBroadcast 7→9（+2）；orderService 6→4（−2）；config/relay 4→2（−2）；RelayStatus 6→4（−2）；matching 14→14（0）。

### 4.1 随模块删除（被测模块已删除，非覆盖降级）

- `src/nodeClient.test.ts`（19 个）：tryNodes 共享截止期/多节点轮询/超时分类——被测模块 nodeClient 已随节点退役删除。其「读取必须有界」的纪律由继任者各自钉住：中继簿适配器超时（§3 新测）、索引器超时（tradesDual 保留测）、发单 AbortSignal（orderBroadcast 新测）。
- `src/services/relayDualSend.test.ts`（6 个）：副发 best-effort 语义——模块删除，发送逻辑主发化后由 orderBroadcast/orderService 新测覆盖（接单/拒单/UNKNOWN/未配置四态）。

### 4.2 dualread.test.ts（67 → 61）

| 原测试 | 为何失效 | 新断言 |
|---|---|---|
| 影子指标口径（2 个：指标定义计算、截断 trustworthy） | metrics.ts 删除，指标概念随双读退役 | 删除（登记） |
| D1「仅节点且节点分页不完整 → SOURCE_INCOMPLETE」 | 与中继变体断言完全相同，单源后重复 | 删除（中继变体保留并改名「公告栏分页不完整」） |
| D1「两源都在但两源都不完整」/「一源不完整、另一源完整 → VALID」 | 双源前提消失 | 删除（登记）；单源不完整 → UNKNOWN 由保留变体覆盖 |
| D1「下一轮分页恢复完整」 | 用两本同源书凑数 | 改写：同一中继簿先不完整（UNKNOWN）后完整（VALID） |
| (d)「公告栏单源 + 落锁不符」/ (d)「两源同单 + 落锁不符」 | 与首个 (d) 断言完全相同，单源后无区别 | 删除两条重复（首个 (d) 保留） |
| 「execType 一源写 limit、一源不写 → 不算冲突」 | 冲突判定已删除 | 改写：同单在中继簿内重复出现（副本 execType 写法不同）→ 同源同 digest 去重只留一份、仍 VALID |
| 「软撤单：订单只在一源消失不推断撤销」 | 「一源消失」前提消失 | 改写：单源在场按链上状态判 VALID，`sources` 只记 `['relay']` |
| 第 38 轮「节点适配器 SourceBook 带 rawRows/droppedRows」 | 节点适配器删除 | 改写：同一断言改由中继适配器承载（注入 fetch 返回同夹具行） |
| 第 40 轮 F3「节点适配器响应形态校验」（4 个） | 同上 | 改写：改由中继适配器承载（requireBookSides 共用，抛错口径不变） |
| 第 40 轮「顶层数组 → 节点/中继均抛错」 | 节点半边消失 | 改写：只断言中继适配器抛错 |
| 编排「disabled 模式不拉任何源」 | 模式概念删除 | 删除（登记） |
| 编排「公告栏故障轮次指标降级、下一轮恢复」 | 指标/双源前提消失 | 改写（runBookRound）：中继故障 → 簿为空 + errors.relay、下一轮恢复 VALID 进可成交集、sources=['relay'] |
| 编排「RPC 故障 → 全部 UNKNOWN」 | runDualReadRound/指标断言失效 | 改写：runBookRound 下 chainOk=false、errors.rpc、UNKNOWN、不进可成交集 |
| 第 46 轮 P1「双源同单合并+只消费一次」 | 双源同单形态消失 | 改写：同单在中继簿内重复两行 → 去重后候选/可成交/撮合各一份、撮合一腿封顶（负控原样保留） |
| 新增「块 3 根因修复」（2 个） | — | 对端永不响应在截止期内失败；注入 fetchFn 不受缺省超时影响 |
| 其余（状态机、阶段 3 证明门禁、第 42 轮、第 38/40 轮解析口径、链上读取器等） | 仅书源参数机械变化（`book('node', …)` → 中继簿） | 断言逐条不变 |

### 4.3 tradesDual.test.ts（22 → 16）

| 原测试 | 为何失效 | 新断言 |
|---|---|---|
| mergeTradeSources（5 个：精确匹配/独有/冲突抑制/批量配对/未配置索引） | 合并函数与 NodeTrade 删除 | 删除（登记）。其「以链上为准」的口径由单源结构本身保证：展示行只来自链上事件 |
| loadDualTrades D6（4 个：两源独立失败） | 双源取数删除 | 删除（登记）；单源失败口径由 loadIndexerTrades 新测覆盖（失败 → failed=true 不冒充空成交） |
| 第 39 轮双源超时（3 个 hang 用例） | 双源前提消失 | 改写为单源 1 个：索引永不返回 → 超时 failed=true 且 signal 已真 abort |
| normalizeNodeTradeRow（1 个） | 函数删除 | 删除（登记） |
| fetchIndexerTrades / D5 服务端过滤 / GraphQL errors / signal 透传 / 内部超时 / 排序键（9 个） | 不失效 | 断言逐条保留 |
| 新增 indexerTradeToDisplay（2 个）+ loadIndexerTrades（5 个） | — | 买卖两向展示换算；成功/HTTP 失败/未配置/未登记对/超时五态 |

### 4.4 orderBroadcast.test.ts（7 → 9）与 orderService.test.ts（6 → 4）

| 原测试 | 为何失效 | 新断言 |
|---|---|---|
| A1 竞速组（先接单即返回/挂死不拖/期限返回/迟到留痕等） | 双通道竞速语义删除 | 改写为单通道四态：接单（请求体含 orderId+chainId、带 AbortSignal）/ 明确拒单带原因 / 网络失败 UNKNOWN / 超时 UNKNOWN / 未配置不发请求 |
| A2 + P2-4 真签名（两通道原文逐字节一致、同 digest、真签名可验） | 「两通道一致」前提消失 | 改写保留核心：中继收到的订单原文经生产路径重构 → digest 与签名时一致、验签通过（下游只认一单的依据不变） |
| orderService 双通道组（节点活+中继败仍成功 / 副发开关关 / 双挂抛节点错误 等 6 个） | 双通道与副发开关删除 | 改写为单通道 4 个：接单成功（请求体核对）/ 拒单抛原因 / 网络失败抛待确认文案 / 未配置抛错不发请求 |

### 4.5 config/relay.test.ts（4 → 2）与 RelayStatus.test.tsx（6 → 4）

| 原测试 | 为何失效 | 新断言 |
|---|---|---|
| parseRelayMode / effectiveRelayMode（active 未接线降级 shadow 等 4 个） | 三态模式删除 | 改写 2 个：RELAY_CONFIGURED 与 URL 空非空一致；RELAY_URL 已规范化（去尾斜杠/空白） |
| ShadowModePill / RelayModesExplanation / DirectionTrustNotice / Stage3AdmissionExplanation（6 个） | 组件随影子区删除 | 改写 4 个：三项健康齐备 / 未配置如实未部署 / 节点退役说明在场（链上撤单+中继无撤单接口）/ 旧文案（双读影子对比、节点单读、待索引、下单仍走节点通道）不得出现 |

### 4.6 matching.test.ts（14 → 14）

- fills 用例夹具：maker 原料原挂 `raw.node` 键——单源后 fills 只读 `raw.relay`，夹具键改 relay，断言逐条不变（登记为夹具来源键改写）。

## 5. 块 4：归档与退役核实

- 归档：`~/workspace/bite100-node`（271M）整体打包为 `~/workspace/bite100-node-archive-2026-11-09.tar.gz`：
  - 大小 142,343,508 字节；sha256 `3a1db8d6b4040dc3aeb14389fffb940976d6cffaf48a012990ea1a8569ebe7a5`；
  - `tar -tzf` 可列目录（29 条目，含 bin/sepolia/base）；**原件未删**（主聊天验收后处置）。
- 退役现状核实（本轮只读核查，未动任何调度/基础设施）：
  - VM 上无 bite100 systemd 单元（`systemctl list-unit-files` 与 `/etc/systemd/system` 均无）；
  - 无 p2p-node 进程在跑（节点自阶段 4 起停机）；
  - 看门狗 cron `bite100-node-watchdog` 的保存定义为 `enabled: false`（禁用待删，删除动作留主聊天）。

## 6. 待主聊天执行的退役清单（本轮未做）

1. 删除 cron `bite100-node-watchdog`（现 disabled），并同步定时任务看板。
2. 删除 Cloudflare 上 `node.aaxx123456.trade` 与 `node-base.aaxx123456.trade` 的 DNS 记录与隧道 ingress 入口（wb 隧道节点规则按第 22 轮 runbook §9 撤除）。
3. 归档原件 `~/workspace/bite100-node` 在验收后处置（删除或保留由主聊天/Ren 定）；归档包 `~/workspace/bite100-node-archive-2026-11-09.tar.gz` 保留。
4. 合并本分支后按既有流程重建站点（VITE_RELAY_URL/VITE_INDEXER_URL 保持现值；VITE_NODE_API_URL 自本轮起前端不再读取，部署侧可择机清理）；Envio 端点轮换按既有节奏另行。
5. 阶段 5 在基础设施退役完成后，方可把设计文档状态改为全完成。

## 7. 验收自查

- 前端全量 vitest：**409/409 全绿（37 文件）**；基线 450/39 的差额逐项对账见 §4，无静默删测。
- `npm run build`（tsc -b + vite build）：通过。
- git diff 面：仅 `frontend/src/**` 与 `docs/**`；contracts/relay/indexer/mcp/scripts **零改动**（`git status` 核对）；diff 无密钥（新增代码不含任何钥/令牌字面量；测试夹具沿用仓库既有 Hardhat 公开测试私钥，与 dualread.test.ts 既有夹具相同）。
- scripts 兼容面逐项核对：stage4 运行器从 src import 的全部符号（buildSignedOrderData、computeOrderDigest、createRelayBookAdapter、normalizeBookRows、requireBookSides、sortBookSide、BookAdapter、FetchFn、createChainStateReader、createViemChainTransport、ChainStateReader、RawOrder、SourceBook、runDualReadRound、executeFrontendMatch、orderDataToContractOrder、fetchIndexerTrades、IndexerTrade）在本轮后均存在且签名兼容（runDualReadRound 为兼容别名、executeFrontendMatch 第二参沿用 DualReadDeps 形状且 nodeAdapter 被忽略）。

## 8. 未尽事项（如实）

- **soak 遗留工具 import 断裂**：scripts/soak/runner.ts 从 dualread/index import `ShadowObserver`——随 metrics.ts 删除而失效。soak 已于 2026-11-08 经 Ren 豁免停用（3A 免检、服务停用），不在本轮修复面；若将来重启 soak 需先处理此 import。
- **未落锁订单无撤单手段**（第 49 轮已登记的产品缺口）：中继无撤单路由、签名撤单已随节点删除——未落锁挂单只能等到期失效。本轮只做文案如实呈现，未新开撤单面（需 relay 合同变更，超出本轮「不动 relay」范围）。
- **OrderBookSection 成交显示口径变化**：原节点成交的 price/amount 是定点串原样渲染；改索引源后为人类单位数值字符串化——显示数值从 wei 量级变为正常量级（属修正，原口径是既有显示缺陷面，本轮顺带消除，登记备查）。
- **useTradesOHLC 新增 30 秒轮询**：原节点路径为单次拉取 + WS 追加；索引是轮询源，故补轮询（WS 追加保留）。
- **p2p/libp2p 浏览器通道未动**：`P2P_CONFIG`/`wsClient`/`p2p/orderBroadcast` 不在本轮退役面（其对端是公共 WS relay 而非退役的 Go 节点 API）；该路径的后续去留另议。
- 阶段 5 的合并、线上生效与基础设施退役未做（§6 清单），故阶段 5 不标全完成。

## 9. 骑乘对照表（集成优先盘点）

| 新/改组件 | 骑乘的既有件 |
|---|---|
| broadcastOrder（发单单通道） | relay 既有 `POST /orders` 合同 + 第 30 轮 relayDualSend 的发送口径与 15s 超时纪律（主发化）+ 平台 `AbortSignal.timeout` |
| runBookRound（单源编排） | 既有 dualread 的 prepareCandidates/evaluateCandidate/mergeBooks 状态机、chainState 链上快照、digest 重算——只换编排，不重写校验 |
| 中继簿超时（块 3） | 平台 AbortController/AbortSignal（与第 39/48 轮超时工具同族做法） |
| loadIndexerTrades | 既有 fetchIndexerTrades（GraphQL where 过滤/客户端兜底/内部超时）+ 既有 callWithTimeout 竞速兜底 + displayValues 换算口径 |
| useRelayOrderBook / OrderBookWidget / TradeTabsPanel / OrderBookSection 盘口 | 既有 createRelayBookAdapter（第 34 轮）+ tradeFormat 换算 |
| 撤单 | 既有 hardCancel 服务层 + Vault 撤单墓碑（第 46/47 轮合约）——本轮零新增撤单机制 |
| runDualReadRound 兼容别名 | 既有 scripts/stage4 运行器不改一行即继续可运行 |
