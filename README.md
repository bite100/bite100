# P2P 去中心化交易所

基于区块链与 P2P 资源的去中心化交易所项目。Phase 1 已完成：智能合约部署于 Sepolia，Web 前端支持连钱包、存提、Swap、添加流动性。

- 概念与架构：[docs/概念设计文档.md](docs/概念设计文档.md) · [docs/技术架构说明.md](docs/技术架构说明.md)
- 合约开发与部署：[contracts/README.md](contracts/README.md)
- 前端：[frontend/README.md](frontend/README.md)

---

## 已部署网络：Sepolia 测试网

| 合约 | 地址 |
|------|------|
| Vault | `0xbe3962Eaf7103d05665279469FFE3573352ec70C` |
| FeeDistributor | `0xeF4BFB58541270De18Af9216EB0Cd8EC07a2547F` |
| Settlement | `0xDa9f738Cc8bF4a312473f1AAfF4929b367e22C85` |
| Token A (TKA) | `0x678195277dc8F84F787A4694DF42F3489eA757bf` |
| Token B (TKB) | `0x9Be241a0bF1C2827194333B57278d1676494333a` |
| AMMPool | `0x85F18604a8e3ca3C87A1373e4110Ed5C337677d4` |

- 区块浏览器：[Sepolia Etherscan](https://sepolia.etherscan.io)
- 链 ID：11155111

---

## 前端入口

### 本地运行

```bash
cd frontend
npm install
npm run dev
```

浏览器打开 **http://localhost:5173**。

### 在线访问（HTTPS）

将前端打包后部署到 Vercel / Netlify / GitHub Pages 即可获得 https 链接。步骤见 **[frontend/DEPLOY.md](frontend/DEPLOY.md)**。

- **Vercel**：导入 GitHub 仓库，Root 选 `frontend`，自动识别构建，得到 `https://xxx.vercel.app`
- **Netlify**：同上或拖拽 `frontend/dist` 到 [Netlify Drop](https://app.netlify.com/drop)
- **GitHub Pages**：在仓库 **Settings → Pages** 里将 **Source** 选为 **GitHub Actions**，之后每次推送到 `main`/`master` 都会自动部署。详细步骤见 **[PUSH-AND-DEPLOY.md](PUSH-AND-DEPLOY.md)**。部署后地址为：`https://<你的用户名>.github.io/<仓库名>/`

**在线地址**：https://p2p-p2p.github.io/p2p/

### 手机访问

1. **同一 WiFi**：电脑运行 `npm run dev` 后，终端会显示 `Network: http://<IP>:5173/`。手机浏览器输入该地址（如 `http://10.22.8.88:5173`）即可。
2. **公网**：前端部署到 Vercel 等后，手机直接打开该 https 链接；使用 MetaMask App 内浏览器或 WalletConnect 连接钱包。
3. 页面已做移动端适配（触控区域、安全区、输入框字号等），手机浏览器可直接使用。

---

## 项目结构

```
P2P/
├── contracts/     # 智能合约（Foundry）
├── frontend/      # Web 前端（React + Vite + ethers）
├── docs/          # 概念设计、技术架构
└── README.md
```
