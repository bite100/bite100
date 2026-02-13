# 比特100 (Bit100)

**P2P 去中心化交易所** —— 链下订单簿 + 链上结算，libp2p + 公共 bootstrap + DHT 发现（去中心化发现）。

---

## 简介

比特100 是一个结合链下撮合与链上结算的去中心化交易所 (DEX)，通过 P2P 网络与 DHT 实现无中心化注册的节点发现，降低 gas 成本，提升交易体验。

| 层级 | 技术栈 | 功能 |
|------|--------|------|
| **前端** | React + TypeScript + wagmi + Mantine | 钱包连接、订单簿、K 线、挂单、存提款、Swap、治理、跨链桥 |
| **合约** | Solidity (Foundry) | Vault、Settlement、AMMPool、Governance、FeeDistributor、ContributorReward |
| **节点** | Go + libp2p + GossipSub | 链下订单簿、撮合、中继、存储、贡献证明 |

---

## 功能

- **交易**：链下订单簿、限价单、AMM Swap、链上 Settlement 结算（0.01% 手续费）
- **资金**：Vault 存提 ERC20、AMM 流动性
- **治理**：提案与投票、手续费分配
- **贡献奖励**：节点贡献证明、链上领取、Merkle 空投
- **跨链**：LayerZero OApp 跨链桥接
- **P2P**：libp2p + 公共 bootstrap + DHT 发现，GossipSub 订单广播

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

部署详见 [contracts/DEPLOY-SEPOLIA.md](contracts/DEPLOY-SEPOLIA.md)。

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
