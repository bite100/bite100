# 本地部署（无需领测试币）

无法领取测试网水龙头时，可先在**本地 Anvil 链**上部署，Gas 为 0，立即可用。

## 步骤

### 1. 开两个终端

**终端 A**：启动本地链（保持运行）

```powershell
cd d:\P2P\contracts
$env:Path = "$env:USERPROFILE\.foundry\versions\stable;$env:Path"
anvil
```

看到 `Listening on 127.0.0.1:8545` 后不要关。

**终端 B**：部署（必须用 Anvil 默认私钥，否则本地链上该地址无余额会报错）

```powershell
cd d:\P2P\contracts
$env:Path = "$env:USERPROFILE\.foundry\versions\stable;$env:Path"
$env:PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast
```

**注意**：不要先加载 `.env`（否则会用到你的钱包私钥，该地址在本地链余额为 0）。上面 `PRIVATE_KEY` 是 Anvil 默认账户，本地链已预填 10000 ETH。

### 2. 可选：同时部署 Mock 代币 + AMM 池

在终端 B 执行（保持上面的 `PRIVATE_KEY` 不要加载 .env）：

```powershell
$env:PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
forge script script/Deploy.s.sol:Deploy --sig "runWithAmmAndMocks()" --rpc-url http://127.0.0.1:8545 --broadcast
```

### 3. 结果

- 终端会打印合约地址。
- 交易记录在 `broadcast/Deploy.s.sol/31337/`（Anvil 链 ID 为 31337）。
- 之后做前端时，把 MetaMask 连到「本地网络」`http://127.0.0.1:8545`、链 ID `31337`，即可用这些合约地址调试。

等能领到 Base Sepolia 测试币后，再用同一套脚本部署到测试网即可。
