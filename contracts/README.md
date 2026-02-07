# P2P 交易所 - Phase 1 智能合约

Phase 1 实现：资产托管、交易结算、手续费分配、基础 AMM 交易。

## 依赖

- [Foundry](https://getfoundry.sh/)（推荐）
- 或任意 Solidity 0.8.19 编译器

### 安装 Foundry 与依赖

**方式一：命令行（在「合约目录」下执行）**

```bash
# 安装 Foundry（若未安装）
# Windows: 见 https://getfoundry.sh  或 irm https://win.getfoundry.sh | iex
# Linux/macOS: curl -L https://foundry.paradigm.xyz | bash && foundryup

# 进入合约目录（请用实际路径，若路径含中文可先 cd 到该文件夹再执行）
cd contracts

# 安装 forge-std 测试库
forge install foundry-rs/forge-std --no-commit
```

**方式二：使用脚本（已添加工作区时）**

- 在资源管理器中进入 `contracts` 目录，在 `scripts` 下双击 **`install-and-build.bat`**；或  
- 在终端中先 `cd` 到 `contracts`，再执行：  
  `.\scripts\install-and-build.ps1`（PowerShell）或 `scripts\install-and-build.bat`（cmd）

## 项目结构

```
contracts/
├── foundry.toml
├── src/
│   ├── interfaces/
│   │   └── IERC20.sol
│   ├── mock/
│   │   └── MockERC20.sol
│   ├── Vault.sol          # 资产托管
│   ├── Settlement.sol     # 交易结算（链下撮合 + 链上结算）
│   ├── FeeDistributor.sol # 手续费分配
│   └── AMMPool.sol        # 简易 AMM 池（0.3% 手续费）
└── test/
    ├── Vault.t.sol
    ├── Settlement.t.sol
    └── AMMPool.t.sol
```

## 合约说明

| 合约 | 职责 |
|------|------|
| **Vault** | 用户 deposit/withdraw，仅 Settlement 可 transferOut 用于结算 |
| **Settlement** | 由 owner 调用 settleTrade，从 Vault 划转并扣 0.3% 至 FeeDistributor |
| **FeeDistributor** | 接收手续费，设置 recipients 与比例，claim 领取 |
| **AMMPool** | 单池 AMM，addLiquidity/swap，0.3% 手续费至 FeeDistributor |

## 构建与测试

```bash
cd contracts
forge build
forge test
```

## 部署到测试网

**推荐使用 Gas 最低的网络：Base Sepolia（L2）**，详见 [DEPLOY-SEPOLIA.md](./DEPLOY-SEPOLIA.md)。

### 1. 环境变量

在 `contracts` 目录下复制 `.env.example` 为 `.env`，填入私钥；推荐配置 Base Sepolia RPC：

```bash
cp .env.example .env
# 编辑 .env：PRIVATE_KEY=0x你的私钥
# 推荐：BASE_SEPOLIA_RPC_URL=https://sepolia.base.org（gas 最低）
```

### 2. 部署到 Base Sepolia（Gas 最低）

```powershell
# 加载 .env 后执行（PowerShell）
$rpc = "https://sepolia.base.org"
forge script script/Deploy.s.sol:Deploy --rpc-url $rpc --broadcast
```

### 3. 部署核心合约 + Mock 代币 + AMM 池（演示用）

```powershell
forge script script/Deploy.s.sol:Deploy --sig "runWithAmmAndMocks()" --rpc-url $rpc --broadcast
```

部署成功后，合约地址会打印在终端；交易记录在 `broadcast/` 目录。

### 4. 部署顺序（脚本已按此顺序执行）

1. 部署 `Vault`
2. 部署 `FeeDistributor`，设置 `setRecipients`（默认部署者 100%）
3. 部署 `Settlement(vault, feeDistributor)`，再在 Vault 上 `setSettlement(settlement)`
4. （可选）部署 `AMMPool(token0, token1, feeDistributor)` 与 Mock 代币

## 与文档对应关系

- [概念设计文档](../docs/概念设计文档.md) - Phase 1 目标
- [技术架构说明](../docs/技术架构说明.md) - 合约模块与结算流程
