# P2P 交易所 - 前端

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

## 合约地址（Sepolia）

- Vault: `0xC3A92a4D07C6133Ea09CFA359C819070C6030D1f`

配置见 `src/config.ts`。
