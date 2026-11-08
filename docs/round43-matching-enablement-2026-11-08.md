# 第四十三轮：前端撮合开启前置 + 无节点阶段 3 切换清单补全（2026-11-08）

本轮只做两件事：把阶段 3 前端半 ChatGPT 复审「有条件通过」时挂的
两个开启前置条件关掉——(A) 前端撮合多腿 anvil 集成测试与双路对账；
(B) 同价排序差异正式写进阶段 3 切换 runbook——并骑乘第 42 轮复审
指正的三处文档修正。**无功能逻辑变更**：生产代码（contracts/、
frontend/src、node 业务代码、relay/）零改动，新增的只有测试/对账
设施与文档。

## 块 A：多腿 anvil 集成测试（双路对账）

D1（阶段 3 块 D）双路对账只覆盖单腿。本轮把同一套场景在本地 anvil
上跑两遍并逐项对账：

- **节点路径**：Go 节点撮合引擎（真实 `matching.Engine`）产出腿序列，
  经节点提交面（`SubmitTrade` 逐腿提交，与生产提交器同一代码路径）
  结算；
- **前端路径**：全新 anvil 上用**生产撮合模块**（`matchTaker` /
  `capLegs` / `simulateAndPrune`，即 `VITE_FRONTEND_MATCHING` 开启后
  页面实际执行的代码）撮合并以 `settleTradesBatch` 原子批量结算。

两路部署同一套合约字节、同一批签名订单（EIP-712 摘要逐单同值，
65 张共享订单已断言），差异只剩「撮合器 + 提交方式」本身。

### 场景

| 场景 | 内容 | 断言要点 |
|---|---|---|
| S1 市价吃多档 | 3 档卖单（40@2.0 / 50@2.1 / 60@2.2）+ 市价买 120（保护价 2.5） | 3 腿（40/50/30），余量 0；两路腿序列逐字相等 |
| S2 部分成交余量取消 | 接 S1 余下 30 档，市价买 100 | 只成交 1 腿 30，余量 70 不挂单（节点侧断言簿内无剩余买单；前端侧 IOC 语义不产挂单腿）；m3 跨场景累计 60/132 |
| S3 陈旧腿剪枝 | m5 先被场外单笔成交填满，再以含 m5 的陈旧快照撮合 t3（m4+m5 两腿） | 前端：整批预检失败后逐腿剔除 m5、只结 m4（批降级为单腿批）；节点：m5 的 `SubmitTrade` 链上失败并记为陈旧腿；两路实际成交集合收敛为 [场外腿, m4] |
| S5 腿数触顶 | 55 档同价卖单 + 市价买 60 | 两路撮合均产 55 腿；前端 `capLegs` 截到 50 腿成一批结算，余量 5；前端另断言 51 腿整批 `staticCall` 被合约硬顶 revert（`Settlement: batch size too large`，MAX_BATCH_SIZE=50） |
| S4 过期腿剪枝（前端单方） | x2 落锁时有效、结算前推进时间使其过期 | 生产 `simulateAndPrune` 剔除 x2（revert 原因 `Settlement: order expired`），只结 x1；节点引擎无链上时间推进的等价面，本场景只在前端路径跑，其费用/gas/余额影响在对账中作为已知单方腿计入 |

### 对账结果（compare-multileg.mjs，32 项断言全过）

| 对账项 | 结果 |
|---|---|
| 部署地址（五合约）/ 65 单摘要 | 两路逐字相等 |
| S1/S2/S3/S5 撮合腿序列、实际成交腿、陈旧腿、未成交余量 | 逐场景逐字相等（S5：撮合 55 腿 / 成交 50 腿 / 余量 5 TKA） |
| 链上累计成交账本（65 单 filledIn/Out） | 逐字一致；关键订单绝对值成立（m3 60/132、t4 50/100、c00/c49 各成交 1、c50/c54 零成交；t1/t2/t3/oc = 120/30/10/10） |
| 手续费与 99/1 分账 | 按腿重算（0.01%，开发者逐笔 floor(fee/100)）与两路链上 FD/开发者余额分别对上；扣前端单方 S4 一腿费用后跨路径逐字相等（总额 A 0.022 / B 0.0458 TKB） |
| gas 对半份额恒等 | 节点 56 事件 / 前端 57 事件（含 S4），逐事件 (扣减+shortfall) 两侧按腿价换算等值（容差 ≤4 wei），reason 全 OK；S1/S2/S3 shortfall=0；S5 微腿在 10% 扣减封顶下 shortfall 非零属合约预期行为，只做恒等校验 |
| Vault 净额分解 | 用各路自己的 gas 事件重算 maker/taker/owner 六项余额，与链上读数逐路逐字自洽 |
| nonce 水位 | 节点 {maker 55, taker 4, owner 1}；前端 {61, 5, 1}，差额恰为单方 S4 消耗的 x1(60)/t5(4) |
| 计量 gasUsed（仅报告，入口计量范围不同） | S1 节点 1,387,098 / 前端 1,105,125；S2 393,360 / 394,443；S3 921,394 / 922,477；S5 19,719,148 / 12,911,196（批量按笔均摊显著低于逐笔提交） |

一键复跑：`bash frontend/scripts/stage3-e2e/run-multileg.sh`
（forge build → 打包驱动 → 节点路径 Go 测试 → 全新 anvil 前端路径 →
对账；任一断言失败非零退出）。

### 过程中发现并修正的两个对账设施问题（非生产代码）

1. 对账初版未把前端单方场景 S4 的成交腿计入费用/净额重算，前端
   路径三项「不符」——差额逐项恰等于该腿的量价，属对账覆盖缺口；
   已把 S4 作为单方场景纳入重算并在跨路径手续费比较中显式扣除。
2. 前端驱动 S4 块初版漏采结算回执的 GasCostShared 事件（且一处
   调用与 `collectEvents(sc, receipt)` 签名不符直接报错）——已按
   D1 式签名补齐采集。对账断言未作任何放宽。

## 块 B：同价排序差异清单化 + 第 42 轮复审文档修正

1. **stage3 文档 §7 runbook 新增 §7.1**「开启前端撮合前置必查」：
   多腿对账（块 A）与排序差异两项前置逐项写入。排序差异写清：
   节点按插入顺序 FIFO、前端按（价格，时间戳，orderId 字典序）、
   且前端排除自成交；同价同秒且 taker 量不足时「具体哪几笔订单
   被成交」两路可不同（量价总额不受影响）；**建议开启后以前端
   结果为准**（开启时节点提交器已收起、前端是唯一产生成交的
   路径；并存期以链上已结算为准），当时标注待负责人确认；
   **已由负责人 Ren 于 2026-11-08 18:54 确认**（开启后以前端
   撮合结果为准），主聊天已同步回填 stage3 文档 §7.1 与 INDEX。
   同节回填 3A 口径：§7 前提、步骤 4 与 §8 两处
   「等 3A 结案 / soak 重启」按负责人 2026-11-08 18:15 豁免决定
   改为「3A 已豁免、浸泡保持停用」。
2. **INDEX 第三节标题**由「分支上的设计文档（未合入 main）」改为
   「设计文档（均已合入 main；本节留分支原件指针）」，跨链设计行
   状态补「本节仅留分支原件指针」，消除与「设计文档已合入 main」
   的自相矛盾（第 42 轮复审 C/D 半指正 ①）。
3. **INDEX 第四十二轮条目**状态由「未合并、未推送」回填为
   「已合并推送（main 478d472）」并补两半复审裁定摘要（指正 ②）。
   同批顺带回填第二节阶段 3 条目的切换状态（3A 豁免 + 直接切换
   发令），与 §7 runbook 口径一致。
4. **gas-vault-design 的 MakerVault immutable 误述**（指正 ③）：
   两处改正——代码事实段改为「`baseToken` 与 `tradingVault` 为
   immutable；`priceFeed` 是普通状态变量（MakerVault.sol:61），
   owner 可经 `setPriceFeed`（:162）改指」；案一问题段改为
   「`baseToken` 为 immutable、NAV 公式与喂价检查写死（priceFeed
   只有改指 setter，改不了结构）」。案二结论不变。

块 B 的 diff 只有 docs/（外加轮文档本身与 INDEX 第四十三轮一行）。

## 骑乘对照表（不重复造轮子）

| 本轮新增 | 骑乘的既有设施 |
|---|---|
| `node/internal/settlement/e2e_stage3_multileg_test.go`（节点路径场景+断言） | 同包既有 anvil E2E 基建（`loadArtifact`/`deploy`/`transactor`/`LockOrder`/`SubmitTrade`/`TradeToFill`/`VaultBalances`，第 17/阶段 3 轮）+ 生产 `matching.Engine`；零新增基建代码 |
| `frontend/scripts/stage3-e2e/driver-multileg.ts`（前端路径驱动） | D1 的 `driver.ts` 部署/签名/事件采集骨架；**生产**撮合模块 `services/matching/{matcher,prune,execute}` 与 `dualread/digest`；`stage3-e2e` 既有目录 |
| `frontend/scripts/stage3-e2e/build.mjs` | `frontend/scripts/soak/build.mjs` 的 esbuild 打包模式（import.meta.env 替身 + createRequire 横幅），扩为双入口 |
| `frontend/scripts/stage3-e2e/compare-multileg.mjs` | D1 `compare.mjs` 的对账口径（部署/摘要/累计量/分账/对半恒等/净额分解），扩到多腿与单方场景差额 |
| `frontend/scripts/stage3-e2e/run-multileg.sh` | D1 `run.sh` 的双 anvil 编排结构（同 gasprice、同链、逐路新部署） |
| `.gitignore` 一行 | 既有 soak/dist、posting-meter/dist 登记惯例 |

## 门禁（本轮自跑）

| 门禁 | 结果 |
|---|---|
| 多腿对账 `run-multileg.sh` | 全绿（S1/S2/S3/S5 双路对账 + S4 过期腿前端单方验证；对账 32 项断言全过。口径订正 2026-11-08 复审回填：不表述为「五场景双路等价」） |
| 前端 `npm test` | 404/404 通过（与第 42 轮基线一致；本轮未动 src） |
| 前端 `npm run build` | 通过（仅既有 chunk 体积警告） |
| `forge test` | 185/185 通过（基线未动；本轮未改合约） |
| `go vet ./internal/settlement/` | 通过 |

## 未做项与待发令清单

- **排序口径已确认（2026-11-08 18:54，Ren）**：§7.1「开启后以
  前端撮合结果为准」已定版，`VITE_FRONTEND_MATCHING` 开启前置
  齐备；开启随阶段 4 发令执行，本轮未动开关。
- 阶段 3 双链切换：按 stage3 文档 §7 runbook 执行（3A 已豁免），
  等主聊天发令；本轮未部署任何合约、未改任何链上配置。
- 第 42 轮复审登记的 gas 库设计冻结项（shortfall 单位换算口径、
  「垫付周转库」命名收紧）属 gas 库实现轮的前置，不在本轮范围。
- 挂单计量加固（CLI 分侧累计、摘要去重、真实证明源接线）属发奖
  前置，另行排期，本轮未动。
