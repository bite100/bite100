# P2P 去中心化交易所

基于区块链与 P2P 资源的去中心化交易所项目。Phase 1 已完成：智能合约部署于 Sepolia，Web 前端支持连钱包、存提、Swap、添加流动性。

- 概念与架构：[docs/概念设计文档.md](docs/概念设计文档.md) · [docs/技术架构说明.md](docs/技术架构说明.md) · [docs/API-接口说明.md](docs/API-接口说明.md)
- **部署与使用**：[docs/部署与使用说明.md](docs/部署与使用说明.md)（环境、部署顺序、治理、前端）
- **主网部署**：[docs/主网部署指南.md](docs/主网部署指南.md)（Ethereum mainnet）
- 合约开发与部署：[contracts/README.md](contracts/README.md)
- 前端：[frontend/README.md](frontend/README.md)
- P2P 节点：[node/README.md](node/README.md)（Docker 或 Go 运行，无需额外安装）

---

## Windows 客户端（像 YouTube 一样安装即用）

希望**直接下载安装、双击打开**使用（类似 YouTube 桌面端）的用户：

1. **从 GitHub 下载安装包**
   - 打开 [https://github.com/P2P-P2P/p2p](https://github.com/P2P-P2P/p2p)
   - 进入 **Releases**（右侧或顶部），下载最新版的 **P2P 交易所 Setup.exe**（或从 **Actions** → 最新一次 “Build Windows client” 运行 → **Artifacts** 下载 `P2P-Exchange-Windows-xxx` 中的 exe）
2. **安装**
   - 双击下载的 `.exe`，按提示选择安装目录并完成安装。
3. **打开使用**
   - 从开始菜单或桌面快捷方式打开 **「P2P 交易所」**，即可连钱包、存提、Swap、添加流动性，与网页版一致。

若仓库暂无 Release，可到 **Actions** 标签页 → 选择最新的 **Build Windows client** 工作流运行 → 在 **Summary** 页底部 **Artifacts** 中下载 Windows 安装包。

---

## 已部署网络：Sepolia 测试网

| 合约 | 地址 |
|------|------|
| Vault | `0xbe3962Eaf7103d05665279469FFE3573352ec70C` |
| FeeDistributor | `0xeF4BFB58541270De18Af9216EB0Cd8EC07a2547F` |
| Settlement | `0x493Da680973F6c222c89eeC02922E91F1D9404a0` |
| Token A (TKA) | `0x678195277dc8F84F787A4694DF42F3489eA757bf` |
| Token B (TKB) | `0x9Be241a0bF1C2827194333B57278d1676494333a` |
| AMMPool | `0x8d392e6b270238c3a05dDB719795eE31ad7c72AF` |
| ContributorReward | `0x851019107c4F3150D90f1629f6A646eBC1B1E286` |
| Governance | `0x8F107ffaB0FC42E623AA69Bd10d8ad4cfbcE87BB` |
| TokenRegistry | `0x77AF51BC13eE8b83274255f4a9077D3E9498c556` |
| ChainConfig | `0x7639fc976361752c8d9cb82a41bc5D0F423D5169` |

- 区块浏览器：[Sepolia Etherscan](https://sepolia.etherscan.io)
- 链 ID：11155111
- 部署与更新步骤见 [docs/部署与使用说明.md](docs/部署与使用说明.md)

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
├── node/          # P2P 节点（Go + libp2p，Docker 可运行）
├── docs/          # 概念设计、技术架构、API
├── docker-compose.yml
└── README.md
```
