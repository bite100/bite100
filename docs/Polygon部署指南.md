# Polygon 主网部署指南

本文档说明如何将 P2P 交易所部署到 **Polygon 主网**（chainId 137）。Polygon 使用 MATIC 作为 gas，部署与交易费用通常低于 Ethereum 主网。

---

## 一、部署前准备

### 1.1 资金与 Gas

- **Gas**：部署约需少量 MATIC（通常远低于 Ethereum 主网，约数美元量级）
- **RPC**：默认 `https://polygon-rpc.com`；可选 `https://polygon.llamarpc.com` 或 Alchemy/Infura 的 Polygon 端点
- **私钥**：`contracts/.env` 中 `PRIVATE_KEY` 对应的地址需有充足 MATIC

### 1.2 代币选择（Polygon 上 ERC20）

AMM 池需两个 Polygon 上的 ERC20 地址。常见组合（部署前请在 [PolygonScan](https://polygonscan.com) 确认）：

| 组合 | TOKEN0 | TOKEN1 |
|------|--------|--------|
| USDC/USDT | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`（Polygon USDC） | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`（Polygon USDT） |
| WMATIC/USDC | `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270`（WMATIC） | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`（USDC） |

### 1.3 环境变量

在 `contracts` 目录下编辑 `.env`（与 Ethereum 主网共用 `PRIVATE_KEY` 即可）：

```bash
PRIVATE_KEY=0x你的部署私钥
# 可选：POLYGON_RPC_URL=https://polygon-rpc.com
# 可选：FEE_RECIPIENT=0x...
```

---

## 二、一键部署

### 2.1 执行部署脚本

```powershell
cd contracts

# 设置 AMM 池的两代币地址（必填，Polygon 上地址）
$env:TOKEN0_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"   # Polygon USDC
$env:TOKEN1_ADDRESS = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"   # Polygon USDT

.\scripts\deploy-polygon.ps1
```

脚本会提示输入 `YES` 确认。部署成功后终端会输出各合约地址。

### 2.2 部署内容

与 Ethereum 主网相同：Vault、FeeDistributor、Settlement、AMMPool、ContributorReward、Governance、TokenRegistry、ChainConfig，并完成绑定。

---

## 三、前端配置

### 3.1 填入 Polygon 合约地址

编辑 `frontend/src/config.ts`，在 `POLYGON` 对象中填入部署输出的地址（TOKEN0/TOKEN1 与部署时一致）：

```typescript
const POLYGON = {
  VAULT: '0x...',
  SETTLEMENT: '0x...',
  TOKEN0: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',  // 与部署时一致
  TOKEN1: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  AMM_POOL: '0x...',
  CONTRIBUTOR_REWARD: '0x...',
  GOVERNANCE: '0x...',
  TOKEN_REGISTRY: '0x...',
  CHAIN_CONFIG: '0x...',
}
```

### 3.2 构建 Polygon 版本

```bash
cd frontend
npm run build:polygon
```

生成的 `dist/` 连接 Polygon 主网，可部署到 Vercel、Netlify 等。

### 3.3 本地调试 Polygon

```bash
cross-env VITE_NETWORK=polygon npm run dev
```

---

## 四、部署后操作

- **添加流动性**：前端连接 Polygon 后，在「添加流动性」中操作；或使用 cast 对 TOKEN0/TOKEN1 approve 后调用 AMM 的 `addLiquidity`。
- **治理**：与 Sepolia/Ethereum 主网相同，见 [治理部署与提案执行指南](./治理部署与提案执行指南.md)。

---

## 五、相关文档

- [主网部署指南](./主网部署指南.md)（Ethereum 主网）
- [部署与使用说明](./部署与使用说明.md)
- [设计文档索引](./设计文档索引.md)

*以当时修改为准，随时更新设计文档。*
