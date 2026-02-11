# 比特100 - 前端

连钱包、读余额（Sepolia 测试网）。

## 功能

- 连接 MetaMask 等钱包
- 自动切换到 Sepolia 网络
- 显示当前账户与钱包 ETH 余额
- 输入代币合约地址，查询该代币在 Vault 中的余额

## 运行

```bash
cd frontend
npm install
npm run dev
```

浏览器打开 http://localhost:5173 ，连接钱包后即可使用。

## Windows 桌面客户端（安装包）

本仓库支持打包为 Windows 安装程序（.exe），用户可像使用 YouTube 桌面端一样下载、安装、双击打开。

- **用户下载**：从 [GitHub Releases](https://github.com/P2P-P2P/p2p/releases) 或 **Actions → Build Windows client → Artifacts** 下载安装包，详见仓库根目录 [README](../README.md#windows-客户端像-youtube-一样安装即用)。
- **本地打包**：
  ```bash
  npm install
  npm run dist
  ```
  安装包输出在 `frontend/release/` 目录（如 `比特100 Setup 0.0.1.exe`）。
- **开发时以桌面窗口运行**：`npm run electron:dev`（会先启动 Vite 再打开 Electron 窗口）。

## 合约地址（Sepolia）

- Vault: `0xC3A92a4D07C6133Ea09CFA359C819070C6030D1f`

配置见 `src/config.ts`。

## 治理

部署 Governance 后，将地址填入 `src/config.ts` 的 `GOVERNANCE_ADDRESS`，前端会显示治理卡片：查看提案、投票、执行、创建提案（改 Settlement 费率）。活跃集与 proof 由 `node/cmd/merkletool` 生成。
