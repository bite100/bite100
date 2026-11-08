# Bit100 文档索引（INDEX）

> **项目底线：集成优先，不重复造轮子**——本项目的底层就是集成现成的开源项目、协议、标准与服务，自研只写胶水与差异化核心。全文见仓库根目录 `README.md` 的「项目底线」一节，所有轮次的设计与实现均以此为准。

> 本索引于 2026-11-08 全面清理时新增，只做导航，不改动任何既有文档正文。
>
> **状态口径**：`已上线` = 内容已合入 main 并在双测试网/线上生效；`历史记录` = 当轮留痕，其中合约地址等已被后续轮次取代（文档头部多有取代横幅）；`设计定版待实现` = 设计已拍板、实现代码未动。
>
> **现行合约地址只看第 33 轮文档**（round33-hardening-2026-11-08.md §4）。部署类文档存在取代链：第 3/8 轮 → 第 15 轮 → 第 27 轮 → 第 30 轮 → 第 32 轮 → 第 33 轮，旧文档地址均已过时。

## 一、现行规范与长期设计

| 文档 | 内容 | 状态 |
|---|---|---|
| [eip712-order-spec.md](eip712-order-spec.md) | EIP-712 订单签名规范，全项目唯一规范（域、字段、逐字节口径） | 已上线（现行规范） |
| [order-balance-locking.md](order-balance-locking.md) | 挂单余额锁定设计：按订单摘要落锁、Vault 验签推导金额（第 15 轮设计） | 已上线 |
| [market-orders.md](market-orders.md) | 市价单设计：签名限价保护 + 无签名市价标记、未成交余量自动取消（第 17 轮 Part B） | 已上线 |
| [market-maker-vault-design.md](market-maker-vault-design.md) | 做市金库设计（第 17 轮 Part C），第 27 轮按此实现 Tier 2 合约金库 | 已上线（设计原件） |
| [bridge-abstraction.md](bridge-abstraction.md) | 桥抽象层设计：多桥统一接口与选桥口径，第 19/20 轮实现的依据 | 已上线（设计原件） |
| [nodeless-design-2026-11-07.md](nodeless-design-2026-11-07.md) | 无节点化架构设计（第 24 轮）：中继/落锁/撮合/索引四职能替代与五阶段迁移 | 设计定版，分阶段实施中（阶段 1 已上线；阶段 2 见第 34 轮文档；阶段 3 准入门槛已于第 35 轮修订为合成压测口径、第 36 轮拆为 3A 测试网技术准入 / 3B 主网影子观察） |
| [mainnet-launch-plan-2026-11-08.md](mainnet-launch-plan-2026-11-08.md) | 主网上线计划（2026-11-08 拍板）：第一批三链 Base 主网 / Kaia / BNB Chain（测试完毕后上线）、部署与 gas 预算口径、Kaia 价格源改接 Pyth、自发测试币互刷验证、执行门槛（桥不开通，多 DVN 硬门槛不变） | 已拍板，待执行（前提：阶段 3 合约轮 + 3A 压测等门槛全过） |
| [hyperliquid-gap-roadmap.md](hyperliquid-gap-roadmap.md) | 与 Hyperliquid 的差距分析与改进路线图（第 7 轮），后续多轮的排期母本 | 历史记录（路线图，部分条目已被后续轮次改向） |

## 二、轮次记录（按轮次）

| 轮次 | 文档 | 内容 | 状态 |
|---|---|---|---|
| 1–2 | [anvil-e2e-verification.md](anvil-e2e-verification.md) | 本地 anvil 端到端验证记录（P0-3） | 历史记录 |
| 3 | [sepolia-deployment-2026-11-07.md](sepolia-deployment-2026-11-07.md) | Sepolia 十合约首部署与结算验证；地址已被第 15 轮取代 | 历史记录 |
| 7 | [hyperliquid-gap-roadmap.md](hyperliquid-gap-roadmap.md) | 差距分析与路线图（见上表） | 历史记录 |
| 8 | [base-sepolia-deployment-2026-11-07.md](base-sepolia-deployment-2026-11-07.md) | Base Sepolia 同构部署（多链 M1 收尾）；地址已被第 15 轮取代 | 历史记录 |
| 9 | [bridge-deployment-2026-11-07.md](bridge-deployment-2026-11-07.md) | LayerZero 桥部署（M2a）；桥地址已被第 16 轮取代，§4 DVN 1-of-1 现状与主网门禁结论仍有效 | 历史记录 |
| 10 | [dependency-upgrade-2026-11-07.md](dependency-upgrade-2026-11-07.md) | 依赖升级记录（OZ/forge-std/libp2p/React 等） | 历史记录 |
| 11 | [frontend-redesign-2026-11-07.md](frontend-redesign-2026-11-07.md) | 前端重设计说明（现代极简风定版） | 历史记录 |
| 12 | [trade-layout-hyperliquid-benchmark.md](trade-layout-hyperliquid-benchmark.md) | 交易主屏布局对标记录 | 历史记录 |
| 13 | [site-restructure-2026-11-07.md](site-restructure-2026-11-07.md) | 全站界面重构（五分区信息架构） | 历史记录 |
| 14 | [copy-rewrite-2026-11-07.md](copy-rewrite-2026-11-07.md) | 全站文案重写：~130 条文案 + 16 处说明块 | 历史记录 |
| 15 | [round15-deployment-2026-11-07.md](round15-deployment-2026-11-07.md) | 挂单余额锁定版双链重新部署记录 | 历史记录（地址已被第 30 轮取代） |
| 16 | [round16-bridge-migration-2026-11-07.md](round16-bridge-migration-2026-11-07.md) | LayerZero 桥迁移到第 15 轮新 TKA，含真实跨链到账 E2E | 历史记录 |
| 17 | [round17-amm-removal-market-orders-2026-11-07.md](round17-amm-removal-market-orders-2026-11-07.md) | 砍掉 AMM + 市价单落地 + 做市金库设计 + 下单一键补存 | 已上线 |
| 19 | [round19-three-bridges-2026-11-07.md](round19-three-bridges-2026-11-07.md) | 三桥选择上线：LayerZero + CCIP + Wormhole，桥页知情选择 | 已上线 |
| 20 | [round20-fastlane-2026-11-07.md](round20-fastlane-2026-11-07.md) | 垫资快线（LI.FI 求解器）接入为第四通道，主网功能、测试网硬阻断 | 已上线（主网待 key） |
| 21 | [round21-gas-rules-2026-11-07.md](round21-gas-rules-2026-11-07.md) | gas 规则落进结算层：双方对半分摊、失败归发起者 | 已上线 |
| 22 | [round22-node-deployment-2026-11-07.md](round22-node-deployment-2026-11-07.md) | 双链节点部署上线（VM systemd + 隧道公网入口） | 已上线 |
| 23 | [round23-oracle-reference-price-2026-11-07.md](round23-oracle-reference-price-2026-11-07.md) | Chainlink 预言机参考价层接入 | 已上线 |
| 24 | [nodeless-design-2026-11-07.md](nodeless-design-2026-11-07.md) | 无节点化架构设计（见上表） | 设计定版，分阶段实施中 |
| 25 | [round25-mainstream-pairs-2026-11-07.md](round25-mainstream-pairs-2026-11-07.md) | 主流交易对上架：8 个 MockERC20 × 双链 + 交易对切换器 | 已上线 |
| 26 | [round26-settlement-wiring-2026-11-07.md](round26-settlement-wiring-2026-11-07.md) | 节点结算接线：守护进程内提交器、待结算成交回补 | 已上线 |
| 27 | [round27-maker-vault-2026-11-08.md](round27-maker-vault-2026-11-08.md) | 做市金库（Tier 2）ERC-4626 上线双链；合约栈后被第 30 轮重部署 | 历史记录（地址已被第 30 轮取代） |
| 28 | [round28-chart-orderbook-ui-2026-11-08.md](round28-chart-orderbook-ui-2026-11-08.md) | K 线与订单显示视觉重做（含 1e18 显示缩放修复）；截图在 [round28-assets/](round28-assets/) | 已上线 |
| 29 | [round29-node-fixes-2026-11-08.md](round29-node-fixes-2026-11-08.md) | 节点六项问题修复（陈旧挂单、amountOut、/api/trades、提交器对账等） | 已上线 |
| 30 | [round30-nodeless-stage1-2026-11-08.md](round30-nodeless-stage1-2026-11-08.md) | 无节点化阶段 1：订单公告栏中继（Worker+D1+Nostr 镜像）+ 前端双发 | 已上线（中继代码完成，待 Cloudflare 部署） |
| 30 | [round30-l2-legb-2026-11-08.md](round30-l2-legb-2026-11-08.md) | 第 30 轮腿 B：L2 无权限落锁 + 双链全栈重部署 | 历史记录（地址已被第 32 轮取代） |
| 31 | [round31-mobile-skeleton-2026-11-08.md](round31-mobile-skeleton-2026-11-08.md) | 移动端骨架重构实现（四栏导航、行情一级页、资产/金库子页等），设计原件见第三节 | 已上线 |
| 32 | [round32-fixes-2026-11-08.md](round32-fixes-2026-11-08.md) | ChatGPT 审查整改三批：文档清理、签名缓存/满员/DHT/治理 ABI/Vault 记账修复、双链重部署、启用前门禁 | 历史记录（地址已被第 33 轮取代） |
| 33 | [round33-hardening-2026-11-08.md](round33-hardening-2026-11-08.md) | 安全加固：Vault 重入保护（N1）、订单簿写入路径统一（N2/N3）、NodeRegistry 钱包占用（N4）、双链重部署（**现行合约地址在此**）、门禁补强、CI/ABI 对齐 | 已上线 |
| 34 | [round34-nodeless-stage2-2026-11-08.md](round34-nodeless-stage2-2026-11-08.md) | 无节点阶段 2：双读基础设施 + 影子指标（阶段 3 准入线）、Envio 索引器 + 成交双源、中继就绪核对与 Settlement 权限事实（阶段 3 定 B 开放提交）；附 M1/M2 修复与行情页无成交行参考价修复 | 已合并推送（main 9627125）；推送后 ChatGPT 复审有条件通过，整改见第 35 轮；中继已部署（免费版）、索引器待部署；§6.3 准入门槛已于第 36 轮拆为 3A/3B 并补方向过渡规则 |
| 35 | [round35-review-fixes-2026-11-08.md](round35-review-fixes-2026-11-08.md) | 第 34 轮复审整改：双读可信边界 D1–D4（完整度入门/锁仓方向证据/零值/钉块）、成交双源 D5/D6、ABI 守卫 M2-R、D8 active 未接线门禁；阶段 3 准入门槛改合成压测口径 + 压测工具（frontend/scripts/soak/）与冒烟实证 | 已合并推送（main 9adf762）；推送后 ChatGPT 复审不通过（N1 锁仓方向证据证伪 / N2 ABI 结尾定位 / N3 双源一致非独立 / N4 压测计时），整改见第 36 轮；压测已于 2026-11-08 启动（第 36 轮口径下只计试运行，3A 正式计数自第 36 轮合并起算） |
| 36 | [round36-direction-trust-2026-11-08.md](round36-direction-trust-2026-11-08.md) | 第 35 轮复审整改：方向不可证过渡期（双读观察与可成交认证分离，SIDE_PROOF_AVAILABLE/SIDE_UNPROVABLE，锁仓降为观察旗标）、ABI 守卫词法结尾检测（N2）、soak 逐单真实提交时刻（N4）+ 交易对全表轮转、阶段 3 准入拆 3A/3B 并记方向过渡规则与解除条件 | 已合并推送（main a0d906a）；推送后 ChatGPT 复审不通过（逐单方向证明门缺失 / Pages 工作流同组互取消），整改见第 37 轮 |
| 37 | [round37-review-fixes-2026-11-08.md](round37-review-fixes-2026-11-08.md) | 第 36 轮复审五项最小修复：Pages 部署工作流收敛为单一、逐单方向证明门 sideProof、ABI 扫描模板表达式显式失败、3A 覆盖与计数汇总工具（soak report）、文档同步（中继已部署口径 / Kaia 措辞 / 3A 声明与计数定义 / 阶段 3 同步清单） | 待合并（本轮分支 round37-review-fixes；合约/节点/中继零 diff） |
| 38 | [round38-adapter-fix-2026-11-08.md](round38-adapter-fix-2026-11-08.md) | 节点源零贡献根因修复：双读适配器 asIntString 接受全零小数定点串并归一化（非全零判无效）、normalizeBookRows 丢弃计数接入 SourceBook 与 soak round 记录（nodeRawRows/nodeDroppedRows）、runner discoveryStats 排除篡改单与 report.mjs/§6.3 对齐；第一个 3A 窗口因测量链缺陷中止、新窗口自换包重启起 7 天（§6.3 已补记） | 待合并（本轮分支 round38-adapter-fix；合约/节点/中继零 diff）；换包重启 3A 由主聊天在本轮合并推送后执行 |
| 39 | [round39-dual-source-hardening-2026-11-08.md](round39-dual-source-hardening-2026-11-08.md) | 成交双源健壮性四项（Envio 接线增量复审整改）：双源取数超时真取消（节点 5s/索引器 8s，AbortController 平台标准）、GraphQL errors 检查、服务端排序补 logIndex 次级键、桌面「成交记录」页签接入同一条双源路径 | 待合并（本轮分支 round39-dual-source-hardening；仅 frontend/ 与 docs/，零新依赖） |
| 40 | [round40-review-followups-2026-11-08.md](round40-review-followups-2026-11-08.md) | 复审跟进批：第 38 轮 F1–F4（asIntString 数字分支安全整数化 + 边界测试、节点适配器形态校验 requireBookSides 前端/runner 共用、droppedRows 口径写明）、Envio 跟进（indexer viem 精确锁 2.57.16）、第 39 轮 F1/测试缺口/F2（tryNodes abort 短路、双挂死双 signal 断言、FetchFn 契约注释）；不重建 soak 包、3A 不受影响 | 待合并（本轮分支 round40-review-followups；仅 frontend/、indexer/、docs/，零新依赖） |
| 阶段 3 | [stage3-contract-matching-2026-11-08.md](stage3-contract-matching-2026-11-08.md) | 无节点阶段 3：Route A（side 进 EIP-712 签名，五方同轮同步、跨语言向量一致、SIDE_UNPROVABLE 过渡体制结束）、Settlement 开放提交（模型 B）+ ERC-1271 长度门修复 + 批上限常量 50、Vault 落锁方向只从签名派生（⑥）、前端撮合开启（本地撮合骑 dualread 可成交集、批结算自提+预检剔腿、灰度开关默认关）、同单双路径 anvil 对账四项全过（三套链参数）；含切换 runbook 与第 40 轮复审三小项骑乘 | 本地分支 stage3-contract-matching，未 push/未部署；双链切换等 3A 结案后发令 |

## 三、分支上的设计文档（未合入 main）

| 文档 | 所在分支 / worktree | 内容 | 状态 |
|---|---|---|---|
| round31-mobile-skeleton-2026-11-08.md | 分支 `round31-mobile-skeleton` / `~/workspace/bite100-r31` | 第 31 轮移动端四栏骨架设计定版 + 演示图（docs/round31-assets/） | 设计定版待实现（Ren 已批准，暂停中） |
| cross-chain-default-bridge-design-2026-11-08.md | 分支 `crosschain-default-bridge-design` / `~/workspace/bite100-xchain` | 跨链默认桥交易设计：预选默认桥、成交后自动交付、四项拍板已定版 | 设计定版待排期 |

## 四、docs 之外的关键文档

| 路径 | 内容 |
|---|---|
| `relay/README.md`（仓库根目录 relay/） | 第 30 轮中继（Cloudflare Worker + D1）的部署与运维说明，含上线 runbook |
| `~/workspace/research_notes/cross-chain-default-trade-20261108/report.md`（仓库外） | 跨链默认桥设计所依据的外部调研报告 |
