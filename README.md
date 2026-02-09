# P2P 去中心化交易所

> **让普通人用手机浏览器，像用微信/支付宝一样简单地进行点对点代币交易**

基于区块链与 P2P 网络的去中心化交易所项目。**Phase 3 已完成**：P2P 订单撮合、WebSocket 实时订单簿、链上结算。

## 🎯 项目愿景

用**最小的门槛（手机浏览器）+ 真正的 P2P 撮合 + 可自定义的分成机制**，去挑战主流钱包"方便但中心化"的 Swap 体验。

**核心价值主张**：
- ✅ **去中心化**：无托管、无 KYC、无平台跑路风险
- ✅ **易用性**：手机浏览器即用，无需下载 App
- ✅ **真正 P2P**：订单直接 peer-to-peer 匹配，不经过中心化路由
- ✅ **低成本**：relayer 代付 gas，手续费可自定义分成
- ✅ **开源透明**：代码开源，社区驱动

📖 **了解更多**：[项目价值与定位](./docs/项目价值与定位.md)

## ✨ 核心特性

- 🌐 **P2P 订单撮合**：libp2p + GossipSub 实现去中心化订单广播，真正的 peer-to-peer 匹配
- 📊 **实时订单簿**：WebSocket 推送，毫秒级更新，零滑点限价单撮合
- 🔐 **EIP-712 签名**：订单防伪造，链上可验证
- ⚡ **链上结算**：Settlement 合约原子交易，relayer 代付 gas
- 🐳 **一键部署**：Docker Compose 完整环境
- 📱 **移动端优先**：PWA 支持，手机浏览器即用，可添加到主屏幕
- 🚪 **完全开放**：**节点入网无任何条件**，无需白名单、质押或邀请
- 💰 **自定义分成**：手续费可按治理提案分配给开发者/节点/流动性提供者

## 🌟 为什么选择我们？

| 特性 | 主流钱包 Swap | 现有 P2P DEX | **本项目** |
|------|--------------|-------------|----------|
| **使用门槛** | 需下载 App | 复杂配置 | ✅ **手机浏览器即用** |
| **限价单体验** | 差（AMM 路由） | 有限 | ✅ **零滑点订单簿撮合** |
| **Gas 成本** | 中～高 | 高 | ✅ **relayer 代付** |
| **P2P 程度** | 低（中心化路由） | 高 | ✅ **真正 P2P** |
| **手续费去向** | 协议/LP | 固定 | ✅ **可自定义分成** |
| **开源透明** | 部分 | 部分 | ✅ **完全开源** |

**详细对比**：[项目价值与定位](./docs/项目价值与定位.md)

## 📚 文档

- **🎯 项目价值**：[项目价值与定位](./docs/项目价值与定位.md)（核心意义、差异化优势、发展路径）
- **📖 文档导航**：[设计文档索引](./docs/设计文档索引.md)（推荐阅读顺序与分类）
- **🚀 快速开始**：[快速开始](./docs/快速开始.md)（一键启动）
- **📘 完整指南**：[P2P节点整合交易撮合指南](./docs/P2P节点整合交易撮合指南.md)（步步详解）
- **🏗️ 概念与架构**：[概念设计文档](./docs/概念设计文档.md) · [技术架构说明](./docs/技术架构说明.md)
- **🔌 API 接口**：[API-接口说明](./docs/API-接口说明.md)
- **🚢 部署指南**：[部署与使用说明](./docs/部署与使用说明.md) · [主网部署指南](./docs/主网部署指南.md) · [主网试运行指南](./docs/主网试运行指南.md)
- **📦 模块文档**：[contracts/README.md](./contracts/README.md) · [frontend/README.md](./frontend/README.md) · [node/README.md](./node/README.md)

---

## 🚀 快速开始

### 一键启动（推荐）

**Windows**：
```powershell
.\scripts\start-dev.ps1
```

**Linux / macOS**：
```bash
chmod +x scripts/start-dev.sh
./scripts/start-dev.sh
```

启动后访问：http://localhost:5173

详细步骤见 [docs/快速开始.md](docs/快速开始.md)

---

## 使用方式

**已放弃电脑端/桌面安装包**，请使用 **浏览器** 或 **PWA**（在手机/电脑浏览器中打开前端地址即可，支持「添加到主屏幕」）。

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

- **RPC**：`https://ethereum-sepolia.publicnode.com`（可设 `SEPOLIA_RPC_URL` 覆盖）
- **链 ID**：11155111
- **区块浏览器**：[Sepolia Etherscan](https://sepolia.etherscan.io)
- **合约地址、RPC 与前端构建**：详见 [docs/部署与使用说明.md](docs/部署与使用说明.md)（含快速复现步骤、前端 `npm run dev` / `npm run build`）。
- **Settlement**：支持交易所代付 gas（`setRelayer`、`settleTrade` 八参数），见 [API-接口说明 §2.3](docs/API-接口说明.md#23-settlement交易结算)。

**主网**：Ethereum 主网见 [docs/主网部署指南.md](docs/主网部署指南.md)；Polygon 主网（gas 更低）见 [docs/Polygon部署指南.md](docs/Polygon部署指南.md)。部署后将合约地址填入 `frontend/src/config.ts` 的 `MAINNET` 或 `POLYGON`，再执行 `npm run build:mainnet` 或 `npm run build:polygon` 构建对应前端。

---

## 前端入口

### 本地运行与构建

```bash
cd frontend
npm install
npm run dev          # 默认连接 Sepolia，浏览器打开 http://localhost:5173
```

**按网络构建**：`npm run build`（Sepolia） / `npm run build:mainnet`（主网） / `npm run build:polygon`（Polygon）；产出在 `frontend/dist/`。

### 在线访问（HTTPS）

将前端打包后部署到 Vercel / Netlify / GitHub Pages 即可获得 https 链接。步骤见 **[frontend/DEPLOY.md](frontend/DEPLOY.md)**。

- **Vercel**：导入 GitHub 仓库，Root 选 `frontend`，自动识别构建，得到 `https://xxx.vercel.app`
- **Netlify**：同上或拖拽 `frontend/dist` 到 [Netlify Drop](https://app.netlify.com/drop)
- **GitHub Pages**：在仓库 **Settings → Pages** 里将 **Source** 选为 **GitHub Actions**，之后每次推送到 `main`/`master` 都会自动部署。详细步骤见 **[PUSH-AND-DEPLOY.md](PUSH-AND-DEPLOY.md)**。部署后地址为：`https://<你的用户名>.github.io/<仓库名>/`

**在线地址**：https://p2p-p2p.github.io/p2p/

### 📱 手机访问（推荐）

**本项目优先支持手机浏览器访问**，无需下载 App，体验类似小程序：

1. **同一 WiFi**：电脑运行 `npm run dev` 后，终端会显示 `Network: http://<IP>:5173/`。手机浏览器输入该地址（如 `http://10.22.8.88:5173`）即可。
2. **公网访问**：前端部署到 Vercel 等后，手机直接打开该 https 链接；使用 MetaMask App 内浏览器或 WalletConnect 连接钱包。
3. **PWA 支持**：页面已做移动端适配（触控区域 ≥48px、安全区、输入框 16px 防缩放等）。在手机浏览器中可「添加到主屏幕」，以独立窗口打开使用，体验接近原生 App。

**在线地址**：https://p2p-p2p.github.io/p2p/

---

## 🏗️ 项目结构

```
P2P/
├── contracts/     # 智能合约（Foundry）
│   ├── Vault.sol           # 资金托管
│   ├── Settlement.sol      # 交易结算（支持 relayer 代付 gas）
│   ├── AMMPool.sol         # AMM 流动性池
│   ├── Governance.sol       # DAO 治理
│   └── CrossChainBridge.sol # 跨链桥接（LayerZero）
├── frontend/      # Web 前端（React + Vite + ethers）
│   ├── PWA 支持            # 手机浏览器优先
│   ├── Electron 桌面版     # Windows 客户端
│   └── libp2p 集成         # P2P 订单撮合
├── node/          # P2P 节点（Go + libp2p）
│   ├── MatchEngine         # 订单撮合引擎
│   ├── GossipSub           # 订单广播
│   └── WebSocket API       # 实时订单簿
├── docs/          # 完整文档
│   ├── 项目价值与定位.md    # 项目意义与差异化
│   ├── 概念设计文档.md      # 愿景与架构
│   └── ...                 # 更多文档
├── docker-compose.yml      # 一键启动
└── README.md
```

## 🤝 参与贡献

我们正在寻找：
- **开发者**：前端、合约、节点开发
- **测试用户**：提供真实使用反馈
- **节点运行者**：运行 P2P 节点，获得手续费分成
- **社区建设者**：推广、文档、社区运营

**如何参与**：
1. Fork 本仓库
2. 创建功能分支
3. 提交 Pull Request
4. 或直接提交 Issue 反馈问题

**当前最缺的**：
- 真实流动性（哪怕先自建小池）
- 更多测试用户反馈
- MatchEngine 稳定性优化
- 社区曝光与推广

详见：[项目价值与定位 - 当前最缺的](./docs/项目价值与定位.md#六当前最缺的让项目有真正意义)

---

## 📄 许可证

本项目采用 MIT 许可证。详见 [LICENSE](./LICENSE) 文件。

---

**⭐ 如果这个项目对你有帮助，请给个 Star！**
