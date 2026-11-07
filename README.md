# 比特100 (Bit100)

**P2P 去中心化交易所** —— 链下订单簿 + 链上结算，libp2p + 公共 bootstrap + DHT 发现（去中心化发现）。

---

## 项目底线：集成优先，不重复造轮子

**本项目的底层就是集成。** 凡是已有成熟开源实现、协议、标准或托管服务的能力，一律接入现成的，不自己重写：

- 跨链桥接现成的（LayerZero / Chainlink CCIP / Wormhole，求解器通道走 LI.FI）；金库用 ERC-4626 标准实现；签名用 EIP-712 / ERC-1271；图表用 lightweight-charts；界面组件用 Mantine；钱包与链交互用 wagmi / viem；中继与索引优先用现成网络与托管服务。
- 自研代码只许写两类：**接入的胶水**，和**差异化核心**（链无关的订单流、gas 透传结算）。除此之外先问一句：现成的为什么不能用？
- 动工前先查现成方案，**包括项目已经引入的依赖**（已在依赖里的库能干的事，不许手写第二份）。新组件交付时须说明它骑乘了哪些既有件；确需自研的，先写明现成方案不适用的理由。
- 这一条对所有在本仓库工作的开发者与 AI 代理同等有效，优先级高于单轮任务的便利。

## 简介

比特100 是一个结合链下撮合与链上结算的去中心化交易所 (DEX)，通过 P2P 网络与 DHT 实现无中心化注册的节点发现，降低 gas 成本，提升交易体验。

| 层级 | 技术栈 | 功能 |
|------|--------|------|
| **前端** | React + TypeScript + wagmi + Mantine | 钱包连接、订单簿、K 线、挂单、存提款、治理、跨链桥 |
| **合约** | Solidity (Foundry) | Vault、Settlement、Governance、FeeDistributor、ContributorReward |
| **节点** | Go + libp2p + GossipSub | 链下订单簿、撮合、中继、存储、贡献证明 |

---

## 功能

- **交易**：链下订单簿、限价单 + 市价单（IOC，带签名保护价）、链上 Settlement 结算（0.01% 手续费）；无自有 AMM，流动性走订单簿 + 做市金库（ERC-4626，第 27/30 轮已部署双测试网，前端金库子页第 31 轮已上线）
- **资金**：Vault 存提 ERC20；下单时 Vault 可用不足可在下单面板内一键补存差额
- **治理**：提案与投票、手续费分配
- **贡献奖励**：节点贡献证明、链上领取、Merkle 空投
- **跨链**：LayerZero OApp 跨链桥接
- **P2P**：libp2p + 公共 bootstrap + DHT 发现，GossipSub 订单广播

> **口径说明（第 32 轮补）**：订单经 P2P 网络去中心化传播、资金由用户
> 签名自托管；但**链上结算目前是许可制**——`Settlement.settleTrade` 只
> 接受合约 owner 或已登记的 relayer 提交（现行由运营节点的结算提交器
> 执行）。「去中心化」在本项目现阶段指订单传播与签名/托管模型，不指
> 结算提交的无许可性；无许可化在无节点改造路线图中分阶段推进
> （见 `docs/nodeless-design-2026-11-07.md`）。

---

## 快速开始

### 前端

```bash
cd frontend
npm install
npm run dev
```

构建主网版本：`npm run build:mainnet`

### 节点

```bash
cd node
# 必填领奖地址
.\run.ps1 -rewardWallet 0x你的领奖地址   # Windows
./run.sh -reward-wallet 0x你的领奖地址   # Linux / macOS

# 或 Docker
docker build -t p2p-node .
docker run -it --rm -p 4001:4001 p2p-node -reward-wallet 0x你的领奖地址
```

### 合约

```bash
cd contracts
forge install foundry-rs/forge-std --no-commit
forge build
forge test
```

部署详见 [contracts/README.md](contracts/README.md)（现行技术栈与地址）；`contracts/DEPLOY-SEPOLIA.md` 为早期部署记录，已被取代、仅作历史留存。

---

## 项目结构

```
├── frontend/           # React 前端（PWA）
│   └── src/
│       ├── p2p/        # libp2p 订单广播
│       └── components/
├── contracts/          # Solidity 合约 (Foundry)
│   └── src/
├── node/               # Go 节点（libp2p、撮合、存储、中继）
│   ├── cmd/
│   └── internal/
└── docs/               # 设计文档
```

---

## 文档

- [node/README.md](node/README.md) — 节点运行、M1/M2 连通、存储与中继
- [contracts/README.md](contracts/README.md) — 合约说明与部署
- [contracts/DEPLOY-SEPOLIA.md](contracts/DEPLOY-SEPOLIA.md) — 测试网部署

---

## License

MIT
