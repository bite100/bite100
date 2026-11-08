# 阶段 4 执行清单：线上前端切到无节点模式需要的确切改动

> Phase P 摸底结论（代码实证，基线 main 478d472）。Phase X 在
> go 时的 main 上落地；本清单逐项给出文件、变量、预期行为与
> 验证方法。地址类数值（新 Settlement/Vault）由阶段 3 切换
> 回填，不在本清单内。

## 结论先行

线上前端今天**不能**在节点停机时完整工作，有一处硬伤（下单
广播）与一处未接线（生产订单簿双读）。阶段 4 的验收主路径
（中继 + 前端撮合 + 索引器 + 链上结算）由运行器以生产模块无头
驱动，不依赖 Pages 页面本身；但「线上前端切无节点模式」作为
阶段 4 的交付面，以下 1、2 两项必须落地，3–5 为如实记录的
降级口径。

## 1.下单广播：节点主发失败即整单失败 → 改双通道任一成功

- 现状（`frontend/src/services/orderService.ts` 的 `submitOrder`）：
先 `await nodePost('/api/order', orderBody)`（节点主发，抛错即
整单失败），成功后才 `dualSendOrderToRelay` 副发中继。节点
停机时主发抛错，**订单根本到不了中继**，前端撮合无单可吃。
- 改法（最小、与既有纪律兼容）：主发与副发改为并行双通道，
成功语义 = 任一通道接单即广播成功；节点失败只记状态区提示
「节点通道不可用，已由中继通道广播」。中继接单口径不变
（`POST /orders`，入库验签）。撤单同理：`submitCancel` 的
节点 `/api/order/cancel` 失败时不得整单失败——软撤单降级为
「仅链上硬撤单」（releaseOrderLock 本就由钱包直发，不经
节点），文案如实标注中继无撤单路由、簿面下架靠过期。
- 验证：节点停机状态下用页面下一单 → 中继簿可见该单
（`GET /orderbook` 按 orderId 查）→ 前端撮合可成交。

## 2.开启前端撮合开关 + 工作流 env 映射补齐

- 开关：`frontend/src/config/matching.ts` 读
`VITE_FRONTEND_MATCHING`（on/true/1 为开，默认关）。开启后
下单广播成功即由用户钱包以 `executeFrontendMatch` 自提批
结算（开放提交 B 模型），下单票据有明示文案（阶段 3 块 C4
已备）。
- 缺口：`.github/workflows/frontend-pages.yml` 的 build env
**没有** `VITE_FRONTEND_MATCHING` 映射（现有 VITE_NODE_API_URL
/ VITE_RELAY_URL / VITE_RELAY_MODE / VITE_INDEXER_URL /
VITE_LIFI_*）。需在本分支给工作流加一行
`VITE_FRONTEND_MATCHING: ${{ secrets.VITE_FRONTEND_MATCHING}}`
并在仓库 Secrets 设 `VITE_FRONTEND_MATCHING=on`（Phase X 由
主聊天执行 `gh secret set`），否则线上产物恒为关。
- 配套（阶段 3 runbook §7 第 4 条）：开启前端撮合时**同步收起
节点提交器**——阶段 4 中节点整体停机，此条自动满足；回滚
恢复节点时须记得节点提交器随之恢复、前端开关另行发令
决定去留。

## 3.中继模式 VITE_RELAY_MODE：保持 shadow，不升 active

- `frontend/src/config/relay.ts`：`RELAY_ACTIVE_WIRED=false`，
请求 active 也降级为 shadow，且生产订单簿（桌面
OrderBookWidget / 移动端 useNodeOrderBook）仍只读节点 API。
**阶段 4 不接线 active**（那是阶段 5「前端默认切公告栏单读」
的工作）：节点停机期间线上页面的订单簿/我的订单视图不可用
或报错，属已知且如实记录的降级，不算阶段 4 失败项；阶段 4
验的是交易全剧本在无节点路径上成立，页面簿视图的单读切换
随阶段 5 落地。

## 4.成交展示：Envio 为权威源，节点源失败自动降级

- `VITE_INDEXER_URL` 已在线上 Secrets 配置（现行端点随阶段 3
切换轮换，Phase X 部署前按例行规程改指最新部署并复跑
Pages 工作流、核验线上 bundle 含新端点）。
- `services/tradesDual.ts` 的合并口径：节点源失败 → 节点行
按空处理、Envio 独有行照常展示；节点停机时成交列表由
Envio 单源供给，行为符合预期，无需改代码。

## 5.节点数据源在停机时的降级行为（双读层，fail-closed 成立）

- `runDualReadRound`：单源失败只降级该源（`errors.node`
记录），中继簿继续走重构/验签/链上状态机；链上快照失败
时全单 UNKNOWN（fail-closed），不会把未证订单放进可成交集。
- 运行器把节点适配器指向本地 `127.0.0.1:8080/8081`（停机即
连接拒绝、快速失败），每轮双读的 `errors.node` 与影子指标
即此降级行为的持续证据，记入 metrics 的 match/cycle 行。

## Phase X 前端部署顺序（与 RUNBOOK 对齐）

1. 阶段 3 切换合入 main 并推送（地址回填完成）；
2. 本分支合入（或按 go 时 main 重开）→ 落地第 1 项广播改动 +
第 2 项工作流映射 → 合并推送；
3. `gh secret set VITE_FRONTEND_MATCHING=on` + 按例行规程把
`VITE_INDEXER_URL` 改指最新 Envio 部署；
4. Pages 工作流重跑，核验线上 bundle 含 `VITE_FRONTEND_MATCHING`
生效标记（撮合开启文案）与新索引器端点；
5. 再按 RUNBOOK 停节点、启运行器。
