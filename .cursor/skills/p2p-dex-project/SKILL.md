---
name: p2p-dex-project
description: Guides work on the 比特100 (Bit 100) codebase: doc structure, concept/phase alignment, contract and frontend conventions. Use when editing project docs, adding features, planning work, or when the user asks about this repository's structure or conventions.
---

# 比特100 项目协作指南

## 文档结构（必读）

| 文档 | 路径 | 用途 |
|------|------|------|
| 概念设计文档 | docs/概念设计文档.md | 愿景、去中心化原则、经济模型比例、治理规则、Phase 1–4 路线 |
| 规划与路线图 | docs/规划与路线图.md | 阶段对照、已完成项、近期优先级、Phase 3/4 大块 |
| Phase2-设计文档 | docs/Phase2-设计文档.md | 节点类型、数据同步、贡献证明、M1–M4 里程碑 |
| Phase3-设计文档 | docs/Phase3-设计文档.md | 链下订单簿、撮合节点、中继规模化、经济模型细化 |
| 技术架构说明 | docs/技术架构说明.md | 分层架构、订单/成交结构、Gossip Topic、数据流 |
| 贡献奖励接口 | docs/贡献奖励接口.md | 证明格式、链上校验、贡献分、奖励池与领取 |
| API-接口说明 | docs/API-接口说明.md | 合约 ABI、链配置、Settlement/AMMPool/Governance |
| 部署与使用说明 | docs/部署与使用说明.md | 环境、部署顺序、前端、治理 |
| 主网部署指南 | docs/主网部署指南.md | 主网部署步骤与前端主网构建 |
| 设计文档索引 | docs/设计文档索引.md | 设计文档列表与**维护约定**（以当时修改为准，随时更新设计文档） |

**文档维护原则**：**以当时修改为准**，以每次修改时的内容为当前权威；修改时**保留更改以前的说明**（如「此前规定」「变更说明」），便于分析；功能、参数或阶段有变更时，**随时更新设计文档**（概念设计、规划与路线图、Phase2/Phase3、技术架构说明等），避免文档滞后。参见 [设计文档索引](docs/设计文档索引.md)。

## 阶段对齐

- **Phase 1**：链上合约 + 基础 DEX（Vault、Settlement、FeeDistributor、AMMPool、Governance、ContributorReward、TokenRegistry/ChainConfig）— 已完成。
- **Phase 2**：节点（Go + libp2p）、存储/中继、数据同步、贡献证明与链上 ContributorReward — 已有；可完善保留期、中继指标。
- **Phase 3**：链下订单簿、撮合节点、中继规模化、完整经济模型（40/25/15/15/5）— 见 Phase3-设计文档。
- **Phase 4**：手机端、跨链、治理代币/DAO、第三方接入 — 部分（PWA/主网已做）；**已放弃电脑端/Electron**，以 PWA/浏览器为主。

做设计或排期时，先对照概念文档与对应 Phase 文档，再改规划与路线图或新建/更新设计文档。

## 代码与配置位置

- **合约**：contracts/script/Deploy.s.sol（部署入口）；contracts/src/*.sol（Vault、Settlement、AMMPool、Governance、ContributorReward 等）。
- **前端**：frontend/src/config.ts（链与合约地址）；frontend/src/App.tsx（主界面、钱包、缓存）；frontend/src/utils.ts（getProvider、withSigner、cache）；仅浏览器/PWA，桌面版已彻底移除。
- **节点**：node/ 下 Go 项目；internal/storage、internal/sync、internal/metrics、internal/reward；cmd/submitproof、cmd/merkletool。
- **部署脚本**：contracts/scripts/（deploy-mainnet.ps1、redeploy-settlement-amm.ps1、deploy-governance.ps1、bind-settlement-amm-to-governance.ps1）。

## 文档与提交约定

- 设计类文档放在 docs/，文件名可用中文（如 概念设计文档.md、规划与路线图.md）。
- 更新阶段状态或优先级时，改 docs/规划与路线图.md；若涉及 Phase 3/4 细节，改或引用 docs/Phase3-设计文档.md。
- 合约/接口/贡献证明有变更时，同步更新 API-接口说明.md、贡献奖励接口.md 或 技术架构说明.md，避免文档与实现脱节。

## 写代码时的原则

- **结合整个项目来考虑**：写代码时要结合整个项目（前端、节点 Go、合约、脚本、文档）一起考虑，避免只改一处导致前后端/节点/文档不一致。例如：节点 API 与前端 nodeClient、订单签名与 orderSigning/orderVerification、配置与 config.example/relay 配置、新增功能与 优化与改进总览/设计文档 的同步。
- **用户功能足够简单**：不懂合约、不懂技术的用户打开交易所，应能直接投票、交易、提案。面向用户的功能要：用大白话、最少步骤、最少术语；隐藏合约地址、calldata、maker/taker 等技术概念；投票用「支持/反对」大按钮；提案用模板式引导；交易用「选币→填数量→点买卖」流程。参见 [优化与改进清单 §〇 新手友好原则](docs/优化与改进清单.md#〇新手友好原则贯穿所有功能)。

## 术语一致

- 链下订单簿、撮合节点、中继节点、存储节点、贡献证明、ContributorReward、Settlement、Governance、Vault、AMMPool、FeeDistributor。
- 经济模型比例：撮合 40%、存储 25%、中继 15%、团队 15%、治理 5%（与概念文档一致）。
- 数据保留：电脑端最多 6 个月、手机端最多 1 个月，超期清理（与概念文档、Phase2、技术架构说明一致）。

## 功能模块 Skill 索引（防止优化跑偏）

优化或修改某功能时，**先查阅对应 skill**，确保不破坏不可变约束。

| 功能 | Skill | 路径 |
|------|-------|------|
| 订单签名 | order-signing | .cursor/skills/order-signing/ |
| 链上结算 | settlement-chain | .cursor/skills/settlement-chain/ |
| 资金托管 | vault-deposit-withdraw | .cursor/skills/vault-deposit-withdraw/ |
| AMM/Swap | amm-swap | .cursor/skills/amm-swap/ |
| 手续费与治理 | fee-governance | .cursor/skills/fee-governance/ |
| 贡献分 | contributor-reward | .cursor/skills/contributor-reward/ |
| 订单簿与撮合 | orderbook-match | .cursor/skills/orderbook-match/ |
| P2P 节点与中继 | p2p-node-relay | .cursor/skills/p2p-node-relay/ |
| 前端主流程 | frontend-ux | .cursor/skills/frontend-ux/ |
| 跨链桥接 | cross-chain-bridge | .cursor/skills/cross-chain-bridge/ |
| PWA 与移动端 | pwa-mobile | .cursor/skills/pwa-mobile/ |
| 节点 API | node-api | .cursor/skills/node-api/ |
| 贡献证明 | contribution-proof | .cursor/skills/contribution-proof/ |
| 数据保留 | data-retention | .cursor/skills/data-retention/ |
| 安全与防滥用 | spam-security | .cursor/skills/spam-security/ |

## 按功能优化：代码与文档入口

全项目按功能优化时，按上表找到对应 Skill 后，再查下表定位主要代码与文档（每项详细约束见各 Skill 内「代码位置」「相关文档」）。

| 功能 | 主要代码位置 | 相关文档（部分） |
|------|--------------|------------------|
| 订单签名 | frontend/services/orderSigning.ts、orderVerification.ts；node/internal/match/signature.go | API-接口说明、贡献奖励接口、公开API文档 |
| 链上结算 | contracts/src/Settlement.sol；node/internal/settlement/；frontend 结算调用 | API-接口说明、技术架构说明 |
| 资金托管 | contracts/src/Vault.sol；frontend 存提流程与 ABI | API-接口说明 |
| AMM/Swap | contracts/src/AMMPool*.sol；frontend Swap/流动性组件 | API-接口说明 |
| 手续费与治理 | contracts/src/FeeDistributor.sol、Governance*.sol；frontend GovernanceSection、governanceUtils | API-接口说明、治理部署与提案执行指南 |
| 贡献分 | contracts/src/ContributorReward.sol；node/internal/reward/、metrics/；frontend UnifiedRewardClaim、contributorRewardUtils | 贡献奖励接口、贡献分领取机制实现指南 |
| 订单簿与撮合 | node/internal/match/、storage/、sync/；frontend OrderBookSection、OrderForm、nodeClient、wsClient | 技术架构说明、P2P节点整合交易撮合指南 |
| P2P 节点与中继 | node/internal/p2p/、relay/；config.example.yaml | 节点部署、Relay部署与Nginx、节点发现与Bootstrap |
| 前端主流程 | frontend/src/App.tsx、walletConfig、config/chains、ChainSwitcher、ErrorDisplay | 部署与使用说明、前端验证-订单簿 |
| 跨链桥接 | contracts/src/CrossChainBridge.sol；frontend CrossChainBridge | 跨链桥接完整指南 |
| PWA 与移动端 | frontend/public/manifest.webmanifest、sw.js；frontend ServiceWorkerUpdate、MobileConnectHint | 手机端开发指南、手机端架构与数据保存策略 |
| 节点 API | node/internal/api/；frontend nodeClient.ts、wsClient.ts | API-接口说明、公开API文档、节点部署 |
| 贡献证明 | node/internal/metrics/、reward/；contracts ContributorReward；证明 payload/签名 | 贡献奖励接口、Phase2-设计文档 |
| 数据保留 | node/internal/storage/（retention、清理逻辑） | Phase2-设计文档、技术架构说明、概念设计文档 |
| 安全与防滥用 | 订单验签、过期拒绝、relayer 限流、node relay 信誉 | 技术架构说明、优化与改进清单 |
