# 第 48 轮：阶段 4 验收运行器修复轮（2026-11-09）

> 状态：**已合入 main 并推送**（2026-11-09，主聊天复核 vitest 450/450、
> build 过、合约零改动后合并，main `3db8f89`）。推送后 ChatGPT 双半
> 审查：骑乘+文档半 = 有条件通过（真问题 1 个：hardCancel 的
> isMethodMissingError 把裸 CALL_EXCEPTION 误当「方法不存在」）；
> 运行器半 = **不通过**（2 个 P1：隔离对账可放行未验真的迟到成交、
> 恢复账本首次创建崩溃窗；2 个 P2：跨进程幂等只查内存、loadPending
> 校验过浅且同哈希异内容静默覆盖）——主聊天逐条对代码核实为真。
> 合计 6 个条件项经 Ren 2026-11-09 14:12 拍板「等第 49 轮做完再
> 统一修」，已由**第 50 轮**修复（见
> [round50-review-condition-fixes-2026-11-09.md](round50-review-condition-fixes-2026-11-09.md)）。
> 下方正文为本轮交付当时的记录，个别表述（如 §3 对 isMethodMissingError
> 分类的描述）以第 50 轮收紧后的实现为准。
> 裁定来源：Ren 2026-11-09 13:32 拍板「现在就开始第一步：修自动测试机器人」；
> 修复清单 = 第 45 轮 ChatGPT 复审运行器半的 3 条 P1 + 全部 P2（主聊天已逐条
> 对着代码验真）+ 第 47 轮复审登记的文档/呈现骑乘项。**零合约改动，零部署。**

## 1. 背景（一句话版）

阶段 4 的验收运行器（`frontend/scripts/stage4/`）是之后 Sepolia 补测与一切
无节点验收的裁判工具；第 45 轮复审证明它自己有三处会「丢账/误判」的硬伤
（先等回执才记账、周期超时管不住在飞的撮合、恢复账本损坏被静默当空）。
裁判不可信之前，不能拿它判任何东西——本轮先把裁判修好，并顺手带上两个
已验真的小产品项（硬取消读容错、节点请求共享截止期）与第 47 轮的文档纠正。

## 2. 块 1：运行器核心修复（`frontend/scripts/stage4/engine.ts` + README）

- **P1-1 先记账再探回执**：`probeSettlement` 改为 txHash 一到手先
  `notePending` 落恢复账本，再去等回执宽限（≤120s）；探量数据缺失时先记账
  再按「结算状态未知」失败关闭停机。窗口期进程被杀，重启后恢复路径能把
  这笔结算认回来。
- **P1-2 周期超时隔离对账**：420s 周期超时（Promise.race 取消不了在飞的
  `executeFrontendMatch`）后，该链进入**隔离状态**：下一周期开始前先执行
  `reconcileAfterTimeout` 对账——① 确认本链内存 pending 并补记；② 从超时
  前区块起扫描 Settlement 的 TradeSettled 事件，把 maker/taker 属于本
  运行器且未记录的迟到成交按回执验真后补记计数（`reconcile` 留痕行）；
  对账失败（非零容忍类）该链本周期不提交任何新单，对账未过绝不放行。
  已知边界：迟到成交以计数 + 对账行方式认回，不构造 SettlementRecord，
  索引器探针不覆盖这类成交（索引器按现行口径只是展示缓存，非账本）。
- **P1-3 账本损坏 fail-closed**：`loadPending` 三分——文件不存在 = 空账本；
  存在但 JSON 解析失败/结构不符 = 抛 `PendingLedgerCorruptError`，启动路径
  按零容忍类停机（退出码 3）并留痕；合法行按 txHash 幂等合并，不重复计。
- **P2 记账顺序**：主路径与恢复路径统一「先写已确认/恢复记录行、再清
  pending」；恢复时发现该 txHash 已在已确认集合中 → 记 `already-confirmed`
  并清 pending，不重复计数。
- **P2 恢复路径补齐**：抽出与主路径共用的 `confirmPendingEntry`——回执
  宽限、事件腿数核对、成交量读取 **3 次重试**（`readFilledInWithRetry`，
  主路径同用）、`takerAmountIn === null` 一律按状态未知停机、**不得再当
  「可跳过确认」**、超量成交停机。
- **P2 中继信号与接受未知**：30s 中继簿读取改走产品适配器既有的 fetchFn
  注入点，传入带 `AbortSignal.timeout(30s)` 的 fetch（真取消，不再只是
  外层干等）；`postToRelay` 的 trace 补齐 `res.text()` 一段；超时错误单列
  分类（`isTimeoutError`），超时 → 订单标 `relayUnknown`「中继接受状态
  未知」：不计已接受、不写失败行；`probePresence` 把这类单也纳入查簿，
  簿里出现即就地转正，60s 仍查无 → 记 `probe-inconclusive` 观察行，
  **不触发 orderLost 停机**（慢 ≠ 丢）；篡改单超时同理标未知，不假装被拒。

## 3. 块 2：骑乘项（产品小修 + 证据测试）

- **hardCancel 读容错三态**（`services/hardCancel.ts` + `HardCancelAction`）：
  `readCancelled` 不再把一切错误吞成 null——新增 `isMethodMissingError`
  分类（CALL_EXCEPTION / missing revert data / selector 未识别 = 旧栈没
  读口，才走第 46/47 轮降级语义）；传输/读取失败返回新结果态
  **`unknown`「状态待确认」**（界面橙色呈现 + 原因 + 不要重复提交的说明）；
  已成交量读取失败不再默认 0n（旧行为会把已全部成交误报成已撤单）；
  释放后墓碑回读失败同样转 unknown（锁定已释放是已确认事实，但不报
  released 也不冒充失败）。
- **tryNodes 共享截止期**（`nodeClient.ts`）：`tryNodes` 新增
  `deadlineMs`——整轮只申请一次 `AbortSignal.timeout`，合成信号贯穿所有
  节点；到点抛 `TimeoutError` 命名错误并收尾。`nodePost` 改用共享截止期
  （15s 总限，取代第 46 轮逐节点各一份信号、最长 ~45s 的口径；超时 ≠
  未接单的 UNKNOWN 语义不变）。新增 `isTimeoutError` 分类导出。
- **证据测试补强**：① 双源去重**负控**（dualread.test.ts）：人为复制合并
  结果喂撮合 → 两腿吃满 150，与第 46 轮 P1 断言（一腿封顶 100）正好
  相反，证明断言有牙；② 真签名**失败路径**（orderBroadcast.test.ts）：
  签后篡改 amount、以及拿另一份数据的真签名来验，`verifyOrderSignature
  SignedData` 都必须为 false；③ hardCancel 新增 4 例（方法不存在用真实
  CALL_EXCEPTION 形态、三处读取失败 → unknown、分类器单测）；④
  nodeClient 新增共享截止期断言（信号只申请一次、挂死只打首节点、
  TimeoutError 与一般错误分开断言）。

## 4. 块 3：文档纠正（只改文档）

- 第 47 轮文档**头部状态**回填为已合入 main 推送（b5424b8 / bd48a16）、
  双链已切换、第 47 轮栈现行——不再写「未推送、未部署」；INDEX 第四十七
  轮条目同步回填。
- **locker 定性纠正**（round47 文档边界表 ④）：原稿「本轮不扩大其权力，
  只是留下永久记录」不准确——47 轮前 locker 释放锁可恢复（单可重锁），
  47 轮后一次释放 = **不可恢复的永久否决**，权力后果被实质放大。已改写
  并注明：**主网上线前 locker 集合治理（谁能当、如何增删、多签与否）
  列入上线就绪清单前置条件**；当前测试网 locker 只有部署者，无现实风险。
- runbook §3 注资精度：正文 6 位改为实测 **18 位**（1000×10^18）；执行
  记录附录一字未动。
- runbook 新增**附录 B 部署交易清单**：从执行机广播文件
  `contracts/broadcast/DeployStage3.s.sol/{11155111,84532}/run-latest.json`
  逐字转录——两链各 **12 笔**（3 CREATE + 9 配置 CALL），共 24 笔（工单
  原写 11 笔，以文件为准纠正）。附注：该 broadcast 目录被
  `contracts/.gitignore` 忽略、不在仓库内（此前「broadcast 文件在仓库
  里」的说法不准确）；失败的首播文件单独注明，不在清单内。
- 本文档新增并登记进 INDEX。

## 5. 骑乘对照表（三条常设规矩①②的交付核对）

| 本轮新/改组件 | 骑乘的既有件 |
|---|---|
| P1-1/P2 恢复账本时序与重试 | 第 45 轮既有 B5 恢复账本（`Stage4Ledger`/`stage4-pending-settlements.json`）与既有回执宽限、成交量读取函数，只改调用顺序与共用抽取，不新写账本 |
| P1-2 隔离对账的事件扫描 | 既有 ethers provider `getLogs` + 既有 Settlement 接口 `parseLog`/`parseTradeEvents`，不新写索引/解析 |
| 中继簿 30s 真超时 | 产品适配器 `createRelayBookAdapter` 既有的 fetchFn 注入参数 + 平台 `AbortSignal.timeout`，不改产品代码 |
| `isTimeoutError`（运行器/ nodeClient 各一） | 平台错误命名约定（TimeoutError/AbortError），无新依赖 |
| hardCancel 三态呈现 | 既有 `HardCancelResult` 联合类型 + `HardCancelAction` 既有分状态呈现结构，只加一态 |
| tryNodes 共享截止期 | 既有 `AbortSignal.timeout`/`AbortSignal.any` 平台能力 + 既有 tryNodes 轮询骨架 |
| 去重负控/签名失败路径测试 | 第 46 轮既有 P1 测试的夹具与生产 `signOrder`/`verifyOrderSignatureSignedData`，不新造签名工具 |
| 部署交易清单附录 | forge 既有广播文件（run-latest.json）程序化转录，零手抄 |

新增依赖：**无**。新写代码只在胶水与本项目差异化语义（账本时序、隔离
对账、三态口径），无通用轮子重造。

## 6. 验证证据（本轮实测）

- 前端全量：`npx vitest run` → **39 文件 / 450 例全过**（基线 438，本轮
  新增 12 例：hardCancel +4、nodeClient +6、orderBroadcast +1、dualread
  +1；块 2 涉及的四文件曾单独复跑 108 例全过）。
- `npm run build` → 通过。
- 运行器：`node scripts/stage4/build.mjs` → bundle 构建通过；engine.ts +
  main.ts 以与块 1 相同的 ad-hoc tsc 参数（`--types node,vite/client`）
  类型检查零错误。说明：`frontend/scripts/` 不在项目 tsconfig 的
  `include`（仅 `src`）内，项目自带 `tsc -b` 本就不覆盖运行器脚本，
  这是仓库现状、非本轮引入；运行器没有独立的自检命令，bundle + 类型
  检查即其既有验证面。
- 合约：零改动（`git diff` 自查：块 1/2/3 变更文件仅限 stage4 运行器、
  上述前端服务/组件/测试与 docs/，无 contracts/、无无关文件）。

## 7. 未做项登记（明确不在本轮）

- 链上边界补测（部分成交后释放置位、全额消耗置位的上链实测）→ 之后的
  Sepolia 补测步（用本轮修好的运行器当裁判）。
- Nostr 镜像日志可见性（第 47 轮切换后镜像 event id 未回填的观察项）
  → 中继相关轮。
- 阶段 5 退节点 → 下一步单独轮次（前置：硬取消 46 轮 ✓、永久作废 47
  轮 ✓、运行器可信 本轮 ✓）。
- 产品 dualread 适配器本体的 fetch 无超时问题：第 45 轮审计结论为运行器
  侧已用注入解决；产品本体是否同样注入超时信号，留阶段 5 退节点清理
  时一并裁定，本轮不动产品适配器。
- 回滚演练（第 47 轮复审登记）仍是主网门禁项，与本轮无关、不在此处理。
