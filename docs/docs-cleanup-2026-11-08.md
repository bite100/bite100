# 文档整理轮（2026-11-08）：全量盘点、INDEX 对齐与取代标注

> 触发：负责人指示「bit100 项目整理一下文档」。范围严格限定 `docs/**` 与仓库根
> `README.md`、`PUSH-AND-DEPLOY.md`，**零代码/合约/配置改动**。分支
> `docs-cleanup-2026-11-08`（基线 main `84248bb`），本地提交，未合并、未推送。
>
> 本轮带入的现行口径（均来自负责人 2026-11-08 决定）：
> ① 项目底线三条——不重复造轮子、只做集成、先查资料再给意见；
> ② **金库改定 gas 库**（17:05 拍板）：金库不再做市，改为吸引存款人资金作
> gas 垫付周转金并吸收计量 shortfall，平台只做中介、不自营；
> ③ 分成权重因 gas 库改定**重算中、尚未拍板**——终版 50/25/15/10 是按做市
> 风险定的，本轮文档只标「重算中」，不写入任何新数字。

> **状态更新（2026-11-08 第 42 轮回填）**：本轮分支其后已合并推送——
> 跨链一期合并提交 64b7fc0、本文档所在整理合并提交 d97df5a，**main =
> d97df5a**；上文「本地提交，未合并、未推送」及 §3/§6 中同义表述均为
> 合并前的整理时点记录，正文保留原样以存档。另：③ 的权重问题已由
> Ren 2026-11-08 17:35 拍板定版（**挂单 35 / gas 库存款人 25 / 中继
> 20 / 结算提交者 20**），回填由第 42 轮完成（见 round42 轮文档）；
> d97df5a 双半复审（文档半）对本文档状态口径的指正即由本更新修复。

## 1. 盘点统计

全量盘点 **47 篇**（`docs/` 下 45 篇含 INDEX 自身 + 仓库根 2 篇）：

| 状态 | 篇数 | 说明 |
|---|---|---|
| 现行有效 | 11 | 现行规范/设计/计划与现行地址源 |
| 历史轮次记录 | 34 | 当轮留痕，其中部署类地址已被取代链推进 |
| 已被取代 | 2 | 核心定位/整篇被后续决定推翻（已加横幅，原文保留） |
| 疑似重复 | 0 篇独立计 | 以「成对/成组」形式列入 §5 待决清单，本轮不删不合 |

## 2. 盘点表（文档 / 状态 / 本轮动作）

### 2.1 现行有效（11）

| 文档 | 状态 | 本轮动作 |
|---|---|---|
| docs/INDEX.md | 现行有效（导航） | 状态全面对齐（见 §3） |
| README.md（根） | 现行有效 | 加金库定位变更标注；文档节补 INDEX 入口 |
| docs/eip712-order-spec.md | 现行有效（唯一签名规范，阶段 3 已修订 side 字段） | 无 |
| docs/order-balance-locking.md | 现行有效（设计，已上线） | 无 |
| docs/market-orders.md | 现行有效（设计，已上线） | 无 |
| docs/bridge-abstraction.md | 现行有效（设计原件） | 无 |
| docs/nodeless-design-2026-11-07.md | 现行有效（设计定版，阶段 1/2 已上线、阶段 3 已合入未部署） | 加状态补充（权重去向已被后续决定推进） |
| docs/mainnet-launch-plan-2026-11-08.md | 现行有效（已拍板，待执行） | **正文修订** §2 种子口径 → gas 库口径（见 §4） |
| docs/round33-hardening-2026-11-08.md | 现行有效（现行合约地址唯一出处） | 无 |
| docs/stage3-contract-matching-2026-11-08.md | 现行有效（已合入 main，未部署） | 加状态更新行（已合并推送、3A 停用口径） |
| docs/stage3-price-fix-2026-11-08.md | 现行有效（已合入 main，未部署） | 加状态更新行（已合并推送、复审有条件通过） |

### 2.2 已被取代（2）

| 文档 | 状态 | 本轮动作 |
|---|---|---|
| docs/market-maker-vault-design.md | 已被取代（核心定位：做市 → gas 库） | 加「定位变更」横幅，原文保留 |
| PUSH-AND-DEPLOY.md（根） | 已被取代（整篇为 P2P-P2P/p2p 早期仓库指南） | 加「已被取代」横幅，原文保留 |

### 2.3 历史轮次记录（34）

| 文档 | 状态 | 本轮动作 |
|---|---|---|
| docs/anvil-e2e-verification.md | 历史记录（第 1–2 轮） | 无 |
| docs/sepolia-deployment-2026-11-07.md | 历史记录（地址被第 15 轮取代，自带横幅） | 无 |
| docs/base-sepolia-deployment-2026-11-07.md | 历史记录（地址被第 15 轮取代，自带横幅） | 无 |
| docs/bridge-deployment-2026-11-07.md | 历史记录（桥址被第 16 轮取代，自带横幅；DVN 1-of-1 门禁结论仍有效） | 无 |
| docs/dependency-upgrade-2026-11-07.md | 历史记录（第 10 轮） | 无 |
| docs/frontend-redesign-2026-11-07.md | 历史记录（第 11 轮，自带第 12 轮修订注） | 无 |
| docs/trade-layout-hyperliquid-benchmark.md | 历史记录（第 12 轮；「布局对标 HY」定调已被第 31 轮币安口径取代） | 加状态标注 |
| docs/site-restructure-2026-11-07.md | 历史记录（第 13 轮） | 无 |
| docs/copy-rewrite-2026-11-07.md | 历史记录（第 14 轮；含旧权重 40/25/20/15 表述） | 加状态标注（权重口径演进） |
| docs/hyperliquid-gap-roadmap.md | 历史记录（第 7 轮路线图，部分结论已被取代：AMM 已下线、旧权重、做市路线） | 追加状态标注（已有第 17 轮横幅） |
| docs/round15-deployment-2026-11-07.md | 历史记录（地址被第 30 轮取代） | 无 |
| docs/round16-bridge-migration-2026-11-07.md | 历史记录 | 无 |
| docs/round17-amm-removal-market-orders-2026-11-07.md | 历史记录（已上线；Part C 做市金库立项已被 gas 库决定取代） | 加后续定位变更注 |
| docs/round19-three-bridges-2026-11-07.md | 历史记录（已上线） | 无 |
| docs/round20-fastlane-2026-11-07.md | 历史记录（已上线；key 状态见 INDEX 更新） | 无（INDEX 侧更新） |
| docs/round21-gas-rules-2026-11-07.md | 历史记录（已上线；gas 库改定的机制基础） | 无 |
| docs/round22-node-deployment-2026-11-07.md | 历史记录（已上线） | 无 |
| docs/round23-oracle-reference-price-2026-11-07.md | 历史记录（已上线） | 无 |
| docs/round25-mainstream-pairs-2026-11-07.md | 历史记录（已上线；文内「未 push」为成文时状态） | 无 |
| docs/round26-settlement-wiring-2026-11-07.md | 历史记录（已上线） | 无 |
| docs/round27-maker-vault-2026-11-08.md | 历史记录（地址被第 30 轮取代；定位被 gas 库决定取代） | 加「定位变更」横幅 |
| docs/round28-chart-orderbook-ui-2026-11-08.md | 历史记录（已上线） | 无 |
| docs/round29-node-fixes-2026-11-08.md | 历史记录（已上线） | 无 |
| docs/round30-nodeless-stage1-2026-11-08.md | 历史记录（已上线；中继已部署，INDEX 侧更新） | 无（INDEX 侧更新） |
| docs/round30-l2-legb-2026-11-08.md | 历史记录（地址被第 32 轮取代） | 无 |
| docs/round31-mobile-skeleton-2026-11-08.md | 历史记录（设计原件，实现同日上线；含旧权重与中间方案 A 表述） | 加状态标注 |
| docs/round32-fixes-2026-11-08.md | 历史记录（地址被第 33 轮取代） | 无 |
| docs/round34-nodeless-stage2-2026-11-08.md | 历史记录（已合并推送；索引器已上线，INDEX 侧更新） | 无（INDEX 侧更新） |
| docs/round35-review-fixes-2026-11-08.md | 历史记录（已合并推送） | 无 |
| docs/round36-direction-trust-2026-11-08.md | 历史记录（已合并推送） | 无 |
| docs/round37-review-fixes-2026-11-08.md | 历史记录（已合并推送，INDEX 侧更新） | 无（INDEX 侧更新） |
| docs/round38-adapter-fix-2026-11-08.md | 历史记录（已合并推送；3A 窗口作废，INDEX 侧更新） | 无（INDEX 侧更新） |
| docs/round39-dual-source-hardening-2026-11-08.md | 历史记录（已合并推送，INDEX 侧更新） | 无（INDEX 侧更新） |
| docs/round40-review-followups-2026-11-08.md | 历史记录（已合并推送，INDEX 侧更新） | 无（INDEX 侧更新） |

## 3. INDEX 修复明细（docs/INDEX.md）

1. 卷首说明更新：索引不再自称「不改动任何既有文档正文」，改为如实记录本轮
   整理了条目状态并给少数已被取代文档加了文首标注（原文未删改）。
2. 第一节：做市金库设计条目状态改为「设计原件；核心定位已被 2026-11-08
   决定取代」；无节点设计条目补「阶段 3 合约轮已合入 main、未部署」；上线
   计划条目补 gas 库预算口径（平台不放种子、垫付金来自存款人）。
3. 第二节状态批量对齐（原多条停留在成文时点）：
   - 第 20 轮：「主网待 key」→ LI.FI key 已取得并存入保险箱、验证有效，
     待 GitHub 构建密钥接线；
   - 第 27 轮：补金库定位改定 gas 库；
   - 第 30 轮阶段 1：「中继代码完成，待部署」→ 中继已部署（Workers 免费
     版 + D1），前端 shadow 双读在线；
   - 第 31 轮：描述厘清为「设计方案原件」，实现同日落地（main 0adaa1c）；
   - 第 34 轮：「索引器待部署」→ 索引器已上线（Envio 托管，端点随推送
     轮换）；
   - 第 37/38/39/40 轮：「待合并」→ 已合并推送（main c9765d6 / 1f2731f /
     7fbed7b / f6a8123）及各自复审结论；第 38 轮补 3A 窗口重启后被负责人
     叫停作废的现状；
   - 阶段 3 与价格修复：「本地分支，未 push」→ 已合并推送（main 5b9e523 /
     84248bb），未部署，P0 确认关闭，切换待 3A（停用中，切换前重启跑满）。
4. 第三节（分支文档）：第 31 轮设计原件「待实现（暂停中）」→ 已实现并
   上线；跨链默认桥「待排期」→ 一期已在该分支实现（未合并、未推送，合并前记录；其后已合并推送至 main d97df5a，见卷首状态更新），
   并注明链接目标只在该分支存在、main 无此文件。
5. 第四节补两条根目录文档：`README.md`（现行总览）、`PUSH-AND-DEPLOY.md`
   （已被取代，见文首横幅）；另给本文档一行（见 INDEX 第一节末尾）。
6. 链接核查：INDEX 内全部相对链接逐个验证存在性，除本文档（本块新建）
   与第三节跨链设计（分支文件，已在条目内注明）外全部可达。

## 4. 标注与正文修订清单

### 4.1 加标注（横幅/状态行，原文一律未删改，共 12 篇）

| 文档 | 标注内容 |
|---|---|
| docs/market-maker-vault-design.md | 「定位变更」横幅：做市 → gas 库；权重重算中 |
| docs/round27-maker-vault-2026-11-08.md | 「定位变更」横幅（实现事实仍有效，仅定位被取代） |
| docs/round17-amm-removal-market-orders-2026-11-07.md | 后续定位变更注（仅 Part C，其余结论不受影响） |
| README.md（根） | 功能区后「金库定位变更」注 |
| docs/copy-rewrite-2026-11-07.md | 状态标注：旧权重 40/25/20/15 的演进与重算中口径 |
| docs/hyperliquid-gap-roadmap.md | 状态标注：AMM 下线、旧权重、做市路线三项演进 |
| docs/nodeless-design-2026-11-07.md | 状态补充：§6/§8 权重去向已被后续决定推进、现重算中 |
| docs/round31-mobile-skeleton-2026-11-08.md | 状态标注：设计原件已实现上线；文内权重为设计时点口径 |
| docs/trade-layout-hyperliquid-benchmark.md | 状态标注：对标标准已改定币安 App（第 31 轮） |
| docs/stage3-contract-matching-2026-11-08.md | 状态更新：已合并推送、P0 已关闭、3A 停用口径 |
| docs/stage3-price-fix-2026-11-08.md | 状态更新：已合并推送、定向复审有条件通过 |
| PUSH-AND-DEPLOY.md（根） | 「已被取代」横幅：现行仓库 bite100/bite100 + frontend-pages.yml |

### 4.2 正文修订（仅 2 处）

1. `docs/mainnet-launch-plan-2026-11-08.md` §2「不含」条：删除作废的
   「金库做市的种子流动性（运营资金，上线前由负责人另行定数额）」，改
   为 gas 库口径——垫付周转金来自存款人注资、平台不放种子资金、平台侧
   资金只有部署费与 gas 备付金。
2. `README.md`「文档」节：补 `docs/INDEX.md` 入口一行（此前 README 未
   指向文档索引）。

## 5. 待决清单（疑似重复/可合并与待同步项，本轮未动，提请负责人决定）

1. **设计原件 ↔ 轮次记录成对文档**（同一主题两份）：`order-balance-locking.md`
   ↔ 第 15 轮、`market-orders.md` ↔ 第 17 轮、`market-maker-vault-design.md`
   ↔ 第 27 轮、`bridge-abstraction.md` ↔ 第 9/16/19 轮。是仓库既有约定
   （设计定版 + 实现留痕）还是合并为一份，请定调；本轮按约定保留。
2. **UI 历史四件套内容重叠**：第 11 轮 `frontend-redesign`、第 12 轮
   `trade-layout-hyperliquid-benchmark`、第 13 轮 `site-restructure` 与
   第 31 轮 `round31-mobile-skeleton`。第 31 轮已定版新标准（币安骨架、
   四栏 IA），前三篇是否归档为一份「UI 演进史」请决定。
3. **部署记录取代链七件同构**：第 3/8/15/27/30（腿 B）/32/33 轮部署文档
   结构高度一致（部署 + 地址表）。是否抽一份「部署总表」滚动更新、旧文
   只留指针请决定；现行地址仍以第 33 轮文档为准。
4. **上线计划 §5 门槛第 3 项措辞待同步**：「节点托管迁移（主网不能依赖
   当前临时托管）」与负责人已定的无节点终局口径（终局无节点可托管、
   过渡期测试网节点跑在 Muse VM 至阶段 4 切换）存在张力，本轮未擅改
   计划正文，待确认后修订。
5. **设计演示资产内的旧文案**：`docs/round31-assets/demo-govern.html` 等
   演示文件仍含旧权重（40/25/20/15）与中间方案文案。非 .md 文档，本轮
   未动；是否随第 31 轮设计资产一并归档请决定。
6. **INDEX 中路线图双列**：`hyperliquid-gap-roadmap.md` 在 INDEX 第一、
   二节各出现一次（长期母本 + 第 7 轮记录的交叉引用）。如嫌重复可只
   留一处，本轮保留原样。
7. **权重数字的文档回填**：分成权重重算拍板后，需一次性回填
   `nodeless-design` §6、`ContributorReward` 相关轮次文档与前端文案口
   径；本轮只标「重算中」，数字以拍板为准。**（第 42 轮注：此项已完成——权重定版 35/25/20/20 并回填合约、前端与文档，见 round42 轮文档。）**

## 6. 提交与范围证明

- 提交（分支 `docs-cleanup-2026-11-08`）：块 1 INDEX 对齐 / 块 2 取代标
  注 / 块 3 正文修订 / 块 4 本文档。
- 范围自证：`git diff --stat 84248bb..HEAD` 的文件列表只含 `docs/**`、
  `README.md`、`PUSH-AND-DEPLOY.md`，无任何代码、合约、配置、脚本文件。
