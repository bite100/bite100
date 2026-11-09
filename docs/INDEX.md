# Bit100 文档索引（INDEX）

> **项目底线：集成优先，不重复造轮子**——本项目的底层就是集成现成的开源项目、协议、标准与服务，自研只写胶水与差异化核心。全文见仓库根目录 `README.md` 的「项目底线」一节，所有轮次的设计与实现均以此为准。

> 本索引于 2026-11-08 新增；同日文档整理轮更新了全部条目状态，并给少数结论已被后续决定取代的文档加了文首标注（原文未删改），整理记录见 [docs-cleanup-2026-11-08.md](docs-cleanup-2026-11-08.md)。
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
| [market-maker-vault-design.md](market-maker-vault-design.md) | 做市金库设计（第 17 轮 Part C），第 27 轮按此实现 Tier 2 合约金库 | 设计原件；**核心定位已被 2026-11-08 决定取代**（金库改 gas 库、不再做市，见该文文首横幅） |
| [bridge-abstraction.md](bridge-abstraction.md) | 桥抽象层设计：多桥统一接口与选桥口径，第 19/20 轮实现的依据 | 已上线（设计原件） |
| [nodeless-design-2026-11-07.md](nodeless-design-2026-11-07.md) | 无节点化架构设计（第 24 轮）：中继/落锁/撮合/索引四职能替代与五阶段迁移 | 设计定版，分阶段实施中（阶段 1、2 已上线；阶段 3 合约轮已合入 main、未部署，切换待 3A；阶段 3 准入门槛已于第 35 轮修订为合成压测口径、第 36 轮拆为 3A 测试网技术准入 / 3B 主网影子观察） |
| [mainnet-launch-plan-2026-11-08.md](mainnet-launch-plan-2026-11-08.md) | 主网上线计划（2026-11-08 拍板）：第一批三链 Base 主网 / Kaia / BNB Chain（测试完毕后上线）、部署与 gas 预算口径（平台资金只有部署费 + gas 备付金；金库已改定为 gas 库、垫付金来自存款人，平台不放种子）、Kaia 价格源改接 Pyth、自发测试币互刷验证、执行门槛（桥不开通，多 DVN 硬门槛不变） | 已拍板，待执行（前提：阶段 3 合约轮 + 3A 压测等门槛全过） |
| [hyperliquid-gap-roadmap.md](hyperliquid-gap-roadmap.md) | 与 Hyperliquid 的差距分析与改进路线图（第 7 轮），后续多轮的排期母本 | 历史记录（路线图，部分条目已被后续轮次改向） |
| [docs-cleanup-2026-11-08.md](docs-cleanup-2026-11-08.md) | 2026-11-08 文档整理轮记录：47 篇全量盘点表、INDEX 对齐明细、取代标注与正文修订清单、疑似重复待决清单 | 现行（整理记录；已合入 main d97df5a，文首有第 42 轮状态回填） |
| [gas-vault-design-2026-11-08.md](gas-vault-design-2026-11-08.md) | gas 库机制设计：垫付周转金持有/垫付/回收、shortfall 由 gas 库吸收的记账口径、平台极端兜底边界、存款人收益与权重线对应；MakerVault 去向两案对比（推荐停用另建） | 设计定版（第 42 轮）；MakerVault 去向待 Ren 拍板 |

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
| 20 | [round20-fastlane-2026-11-07.md](round20-fastlane-2026-11-07.md) | 垫资快线（LI.FI 求解器）接入为第四通道，主网功能、测试网硬阻断 | 已上线（LI.FI key 已于 2026-11-08 取得并存入保险箱、验证有效；待 GitHub 构建密钥接线后主网启用）。注：该 key 经 `VITE_` 变量注入，会进入浏览器构建产物、任何访客可见——按**公开客户端凭据**管理，风险靠 LI.FI 侧额度/限流控制，不按服务端密钥保密 |
| 21 | [round21-gas-rules-2026-11-07.md](round21-gas-rules-2026-11-07.md) | gas 规则落进结算层：双方对半分摊、失败归发起者 | 已上线 |
| 22 | [round22-node-deployment-2026-11-07.md](round22-node-deployment-2026-11-07.md) | 双链节点部署上线（VM systemd + 隧道公网入口） | 已上线 |
| 23 | [round23-oracle-reference-price-2026-11-07.md](round23-oracle-reference-price-2026-11-07.md) | Chainlink 预言机参考价层接入 | 已上线 |
| 24 | [nodeless-design-2026-11-07.md](nodeless-design-2026-11-07.md) | 无节点化架构设计（见上表） | 设计定版，分阶段实施中 |
| 25 | [round25-mainstream-pairs-2026-11-07.md](round25-mainstream-pairs-2026-11-07.md) | 主流交易对上架：8 个 MockERC20 × 双链 + 交易对切换器 | 已上线 |
| 26 | [round26-settlement-wiring-2026-11-07.md](round26-settlement-wiring-2026-11-07.md) | 节点结算接线：守护进程内提交器、待结算成交回补 | 已上线 |
| 27 | [round27-maker-vault-2026-11-08.md](round27-maker-vault-2026-11-08.md) | 做市金库（Tier 2）ERC-4626 上线双链；合约栈后被第 30 轮重部署 | 历史记录（地址已被第 30 轮取代；**金库定位已于 2026-11-08 改定为 gas 库**，见该文文首横幅） |
| 28 | [round28-chart-orderbook-ui-2026-11-08.md](round28-chart-orderbook-ui-2026-11-08.md) | K 线与订单显示视觉重做（含 1e18 显示缩放修复）；截图在 [round28-assets/](round28-assets/) | 已上线 |
| 29 | [round29-node-fixes-2026-11-08.md](round29-node-fixes-2026-11-08.md) | 节点六项问题修复（陈旧挂单、amountOut、/api/trades、提交器对账等） | 已上线 |
| 30 | [round30-nodeless-stage1-2026-11-08.md](round30-nodeless-stage1-2026-11-08.md) | 无节点化阶段 1：订单公告栏中继（Worker+D1+Nostr 镜像）+ 前端双发 | 已上线（中继已于 2026-11-08 部署至 Cloudflare Workers 免费版 + D1，前端 shadow 双读在线） |
| 30 | [round30-l2-legb-2026-11-08.md](round30-l2-legb-2026-11-08.md) | 第 30 轮腿 B：L2 无权限落锁 + 双链全栈重部署 | 历史记录（地址已被第 32 轮取代） |
| 31 | [round31-mobile-skeleton-2026-11-08.md](round31-mobile-skeleton-2026-11-08.md) | 移动端骨架重构**设计方案**（四栏导航、行情一级页、资产/金库子页等）与演示图；实现同日落地（main 0adaa1c） | 已上线（设计原件，文内权重段落为设计时点口径，见文首标注） |
| 32 | [round32-fixes-2026-11-08.md](round32-fixes-2026-11-08.md) | ChatGPT 审查整改三批：文档清理、签名缓存/满员/DHT/治理 ABI/Vault 记账修复、双链重部署、启用前门禁 | 历史记录（地址已被第 33 轮取代） |
| 33 | [round33-hardening-2026-11-08.md](round33-hardening-2026-11-08.md) | 安全加固：Vault 重入保护（N1）、订单簿写入路径统一（N2/N3）、NodeRegistry 钱包占用（N4）、双链重部署（**现行合约地址在此**）、门禁补强、CI/ABI 对齐 | 已上线 |
| 34 | [round34-nodeless-stage2-2026-11-08.md](round34-nodeless-stage2-2026-11-08.md) | 无节点阶段 2：双读基础设施 + 影子指标（阶段 3 准入线）、Envio 索引器 + 成交双源、中继就绪核对与 Settlement 权限事实（阶段 3 定 B 开放提交）；附 M1/M2 修复与行情页无成交行参考价修复 | 已合并推送（main 9627125）；推送后 ChatGPT 复审有条件通过，整改见第 35 轮；中继已部署（免费版）、索引器已上线（Envio 托管，端点随推送轮换）；§6.3 准入门槛已于第 36 轮拆为 3A/3B 并补方向过渡规则 |
| 35 | [round35-review-fixes-2026-11-08.md](round35-review-fixes-2026-11-08.md) | 第 34 轮复审整改：双读可信边界 D1–D4（完整度入门/锁仓方向证据/零值/钉块）、成交双源 D5/D6、ABI 守卫 M2-R、D8 active 未接线门禁；阶段 3 准入门槛改合成压测口径 + 压测工具（frontend/scripts/soak/）与冒烟实证 | 已合并推送（main 9adf762）；推送后 ChatGPT 复审不通过（N1 锁仓方向证据证伪 / N2 ABI 结尾定位 / N3 双源一致非独立 / N4 压测计时），整改见第 36 轮；压测已于 2026-11-08 启动（第 36 轮口径下只计试运行，3A 正式计数自第 36 轮合并起算） |
| 36 | [round36-direction-trust-2026-11-08.md](round36-direction-trust-2026-11-08.md) | 第 35 轮复审整改：方向不可证过渡期（双读观察与可成交认证分离，SIDE_PROOF_AVAILABLE/SIDE_UNPROVABLE，锁仓降为观察旗标）、ABI 守卫词法结尾检测（N2）、soak 逐单真实提交时刻（N4）+ 交易对全表轮转、阶段 3 准入拆 3A/3B 并记方向过渡规则与解除条件 | 已合并推送（main a0d906a）；推送后 ChatGPT 复审不通过（逐单方向证明门缺失 / Pages 工作流同组互取消），整改见第 37 轮 |
| 37 | [round37-review-fixes-2026-11-08.md](round37-review-fixes-2026-11-08.md) | 第 36 轮复审五项最小修复：Pages 部署工作流收敛为单一、逐单方向证明门 sideProof、ABI 扫描模板表达式显式失败、3A 覆盖与计数汇总工具（soak report）、文档同步（中继已部署口径 / Kaia 措辞 / 3A 声明与计数定义 / 阶段 3 同步清单） | 已合并推送（main c9765d6）；推送后增量复审不通过项（runner 篡改单口径）已于第 38 轮关闭 |
| 38 | [round38-adapter-fix-2026-11-08.md](round38-adapter-fix-2026-11-08.md) | 节点源零贡献根因修复：双读适配器 asIntString 接受全零小数定点串并归一化（非全零判无效）、normalizeBookRows 丢弃计数接入 SourceBook 与 soak round 记录（nodeRawRows/nodeDroppedRows）、runner discoveryStats 排除篡改单与 report.mjs/§6.3 对齐；第一个 3A 窗口因测量链缺陷中止、新窗口自换包重启起 7 天（§6.3 已补记） | 已合并推送（main 1f2731f 批）；新 3A 窗口已于 2026-11-08 13:41 重启，后于同日被负责人叫停作废（浸泡停用），切换前重新跑满 7 天 |
| 39 | [round39-dual-source-hardening-2026-11-08.md](round39-dual-source-hardening-2026-11-08.md) | 成交双源健壮性四项（Envio 接线增量复审整改）：双源取数超时真取消（节点 5s/索引器 8s，AbortController 平台标准）、GraphQL errors 检查、服务端排序补 logIndex 次级键、桌面「成交记录」页签接入同一条双源路径 | 已合并推送（main 7fbed7b）；推送后复审有条件通过、已关闭 |
| 40 | [round40-review-followups-2026-11-08.md](round40-review-followups-2026-11-08.md) | 复审跟进批：第 38 轮 F1–F4（asIntString 数字分支安全整数化 + 边界测试、节点适配器形态校验 requireBookSides 前端/runner 共用、droppedRows 口径写明）、Envio 跟进（indexer viem 精确锁 2.57.16）、第 39 轮 F1/测试缺口/F2（tryNodes abort 短路、双挂死双 signal 断言、FetchFn 契约注释）；不重建 soak 包、3A 不受影响 | 已合并推送（main f6a8123）；推送后复审有条件通过，余下三小项已骑乘阶段 3 关闭 |
| 阶段 3 | [stage3-contract-matching-2026-11-08.md](stage3-contract-matching-2026-11-08.md) | 无节点阶段 3：Route A（side 进 EIP-712 签名，五方同轮同步、跨语言向量一致、SIDE_UNPROVABLE 过渡体制结束）、Settlement 开放提交（模型 B）+ ERC-1271 长度门修复 + 批上限常量 50、Vault 落锁方向只从签名派生（⑥）、前端撮合开启（本地撮合骑 dualread 可成交集、批结算自提+预检剔腿、灰度开关默认关）、同单双路径 anvil 对账四项全过（三套链参数）；含切换 runbook 与第 40 轮复审三小项骑乘 | 已合并推送（main 5b9e523），未部署；前端半复审有条件通过、后端半复审 P0 已由价格修复轮关闭；负责人 2026-11-08 18:15 已豁免 3A 并发令直接切换（浸泡保持停用、不重启），按该文 §7 runbook 执行 |
| 阶段 3 修复 | [stage3-price-fix-2026-11-08.md](stage3-price-fix-2026-11-08.md) | 阶段 3 后端复审 P0 修复：Settlement 限价强制（_accountFill 落账前按签名量交叉相乘校验双方限价，SELL 实收不低于签名价 / BUY 实付不高于签名价，无除法不误杀边界小额，四入口全覆盖，ABI 不变）+ Stage3PriceFix.t.sol 14 例（167→181）；骑乘冻结摘要 Solidity 侧向量断言、GasSavings/Merkle 批入口坏腿回滚、chargeFailedSettlement 计费口径入文档 | 已合并推送（main 84248bb），未部署；推送后定向复审有条件通过、P0 确认关闭（余两条微项并入下一合约轮）；测试网切换硬前置之一已满足 |
|  第四十二轮 | [round42-weights-gas-vault-2026-11-08.md](round42-weights-gas-vault-2026-11-08.md) | 贡献权重定版落地（合约常量 35/25/20/20 + 四线身份重映射 + 流动性线标度 bug 修复）、挂单时长×深度计量基础（纯函数层 + 离线 CLI 骑 D1/索引器）、gas 库机制设计（MakerVault 去向推荐停用另建）、chain-unknown 阻断口径修复、d97df5a 文档复审回填 | 已合并推送（main 478d472）；门禁 forge 185 / 前端 404 全过；推送后两半复审已回并裁定：C/D 半经主聊天验码裁定有条件通过（其文档修正项骑乘第 43 轮块 B）、A/B/E 半有条件通过（头号 P1 经主聊天验码证伪，计量加固项登记为发奖前置）；合约常量随下一次部署生效 |
|  阶段 3 切换 | [stage3-cutover-2026-11-08.md](stage3-cutover-2026-11-08.md) | 阶段 3 测试网切换执行记录（3A 经负责人 2026-11-08 豁免）：双链新栈部署（地址对照/部署 tx）、配置回读表、双链冒烟（坏价 fill 被限价校验拒绝）、双链 E2E（单笔+批量，成交与 GasShare 事件核对）、五面回填（前端/索引器/中继含 Worker 重部署与 D1 清空/节点重建重启）、门禁与回滚说明 | 已合并推送；链上新栈已生效，旧栈未动可回滚 |
|  第四十一轮 | [round41-crosschain-default-bridge-phase1-2026-11-08.md](round41-crosschain-default-bridge-phase1-2026-11-08.md) | 跨链默认桥第一期实现：预选默认桥（LZ/CCIP/Wormhole）+ 主场链，成交后按默认通道交付回主场链 Vault；设置级常设授权（全量开关可撤销）+ 披露版本化确认 + 一行非阻塞预估 + 三级询问绝不静默换桥 + 失败退回成交链 Vault；合约/relay/节点零改动，26 文件全在 frontend/，新增 43 例（全量 392 过） | 已合并推送（2026-11-08，与文档整理轮同批合并）；双半复审已回并裁定：桥半有条件通过（3 条 P1 待桥加固轮修复）、文档半指正的状态口径问题由第 42 轮修复；§10 测试网真实小额实测合并后补做 |
| 第四十三轮 | [round43-matching-enablement-2026-11-08.md](round43-matching-enablement-2026-11-08.md) | 前端撮合开启前置清零：多腿 anvil 双路对账（市价吃多档/部分成交余量/陈旧腿与过期腿剪枝/腿数触顶 50+合约硬顶，五场景 32 项断言全过，生产撮合模块对节点引擎）、同价排序差异写入阶段 3 切换 runbook §7.1（口径已经负责人 2026-11-08 确认：开启后以前端撮合结果为准）、第 42 轮复审三处文档修正骑乘（INDEX 第三节标题与第 42 轮状态、gas 库设计 immutable 误述）；生产代码零改动 | 已合并推送；门禁：多腿对账全绿（主聊天独立复跑 EXIT 0）/ 前端 404 / forge 185 |
| 第四十五轮 | [round45-post-stage4-repair-2026-11-09.md](round45-post-stage4-repair-2026-11-09.md) | 阶段 4 后修复轮：运行器 B1/B3/B2-lite 与方案 B 超时硬化入仓、卡点隔离埋点（call-start/call-end）+ 中继拉簿 30s 包裹、B4 失败关闭（结算状态未知才停机；索引器按 Ren 09:13 口径降为观察项）、B5 待确认结算恢复账本；A1 下单双通道竞速+超时（广播期限 20s、中继 fetch 15s）、A2 同 digest 测试、A3 开关口径回归；零合约改动 | 分支 `round45-post-stage4-repair` 本地提交（6 提交），未推送待主聊天复核；门禁：前端 425 全过 / build 过 / 运行器 bundle 重建 + check 自检 EXIT 0 |

## 三、设计文档（均已合入 main；本节留分支原件指针）

| 文档 | 原始分支 / worktree | 内容 | 状态 |
|---|---|---|---|
| round31-mobile-skeleton-2026-11-08.md | 分支 `round31-mobile-skeleton` / `~/workspace/bite100-r31` | 第 31 轮移动端四栏骨架设计定版 + 演示图（docs/round31-assets/） | 设计定版，**已实现并上线**（见第二节第 31 轮条目，main 0adaa1c）；本节仅留分支原件指针 |
| cross-chain-default-bridge-design-2026-11-08.md | 分支 `crosschain-default-bridge-design` / `~/workspace/bite100-xchain` | 跨链默认桥交易设计：预选默认桥、成交后自动交付、四项拍板已定版 | 设计定版；设计文档已随一期实现合并入 main，一期已合并推送（见第二节第四十一轮条目）；本节仅留分支原件指针 |

## 四、docs 之外的关键文档

| 路径 | 内容 |
|---|---|
| `README.md`（仓库根目录） | 项目总览与「项目底线：集成优先」全文；「文档」一节链回本索引 |
| `PUSH-AND-DEPLOY.md`（仓库根目录） | 项目早期（P2P-P2P/p2p 时期）的推送与 Pages 开启指南，**已被现行仓库（bite100/bite100）设置取代**，仅作历史留存，勿按此操作（见该文文首横幅） |
| `relay/README.md`（仓库根目录 relay/） | 第 30 轮中继（Cloudflare Worker + D1）的部署与运维说明，含上线 runbook |
| `~/workspace/research_notes/cross-chain-default-trade-20261108/report.md`（仓库外） | 跨链默认桥设计所依据的外部调研报告 |
