# 比特100 - 智能合约

链下订单簿 + 链上结算的合约层：资产托管（Vault）、签名订单结算
（Settlement）、做市金库（MakerVault）、手续费分配、贡献奖励、治理与
跨链桥。现行双测试网技术栈（Vault / Settlement / MakerVault）与地址以
[`docs/round30-nodeless-stage1-2026-11-08.md`](../docs/round30-nodeless-stage1-2026-11-08.md)
与 `docs/round30-l2-legb-2026-11-08.md` 为准（第 32 轮因 Vault 记账修复
再次换栈后以 `docs/round32-fixes-2026-11-08.md` 为准）。

> 历史注记：本文件早期版本描述的「Phase 1 + AMM 池」结构已不存在——
> AMM 已于第 17 轮移除（合约文件已删除，流动性走订单簿 + 做市金库），
> 本文件已按现行代码重写（第 32 轮，2026-11-08）。

## 依赖

- [Foundry](https://getfoundry.sh/)
- Solidity **0.8.24**、EVM `cancun`、`via_ir`（以 `foundry.toml` 为准）

### 安装 Foundry 与依赖

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
cd contracts
forge build
```

## 项目结构

```
contracts/
├── foundry.toml          # solc 0.8.24 / cancun / via_ir / optimizer 200
├── src/
│   ├── Vault.sol              # 资产托管与订单余额锁定（L2 无权限落锁）
│   ├── Settlement.sol         # EIP-712 签名订单结算（手续费 0.01%）
│   ├── MakerVault.sol         # 做市金库（ERC-4626 + ERC-1271 签名者下单）
│   ├── FeeDistributor.sol     # 手续费分配（开发者 1%，其余进分配）
│   ├── ContributorReward.sol  # 双周贡献奖励（按贡献分占比分配）
│   ├── NodeRewards.sol        # 上线激励积分（开发者/节点积分与领取）
│   ├── NodeRegistry.sol       # 节点 ID => 奖励钱包绑定注册表
│   ├── OrderNonceManager.sol  # 订单 nonce 防重放
│   ├── Governance.sol         # 治理（活跃集 Merkle 投票 + 时间锁）
│   ├── GovernanceExtended.sol # 治理扩展（多步提案）
│   ├── TokenRegistry.sol      # 可交易代币白名单（仅治理可增删）
│   ├── ChainConfig.sol        # 支持的流通链配置（仅治理可增删）
│   ├── CrossChainBridge.sol   # 跨链桥（LayerZero V2 OApp，锁/解锁模型）
│   ├── WrappedTKA.sol         # TKA 的 1:1 包装代币（CCIP/Wormhole 载体）
│   ├── MerkleDistributor.sol  # Merkle 空投分发
│   ├── AirdropDistributor.sol # 空投分发
│   ├── MerkleProof.sol        # Merkle 证明校验（内部库）
│   ├── interfaces/            # ICrossChainBridge / IERC20
│   └── mock/                  # MockERC20 / MockAggregatorV3（测试用）
├── script/               # 部署脚本（ChainGuard 按链护栏；现行栈用 DeployL2）
└── test/                 # forge 测试（Vault/Settlement/MakerVault 等 14 个套件）
```

## 合约说明

| 合约 | 职责 |
|------|------|
| **Vault** | 用户 deposit/withdraw；签名订单的付款义务按订单摘要锁定（任何人可为验签有效的订单落锁，L2）；结算时仅 Settlement 可消费锁定并划转。deposit 按**实际到账**记账（第 32 轮起，余额差额口径） |
| **Settlement** | 校验 EIP-712 签名（含 ERC-1271 合约签名者）后结算成交，从 Vault 划转并扣 **0.01%**（feeBps=1）手续费至 FeeDistributor；gas 由结算双方对半分摊（链上计量） |
| **MakerVault** | ERC-4626 做市金库：存款自动进入交易 Vault 做市，份额按 NAV 计价；登记签名者以金库名义（ERC-1271）签单 |
| **FeeDistributor** | 接收手续费，设置 recipients 与比例，claim 领取 |
| **ContributorReward** | 双周周期贡献奖励：节点提交 ECDSA 签名的贡献证明，按贡献分占比发放该周期奖励池 |
| **NodeRewards** | 主网上线激励：devPoints/nodePoints 分配与统一领取。**启用前门禁见 `docs/round32-fixes-2026-11-08.md`「启用前门禁」一节（nodeId 唯一性/真实性校验未落地前不得接入奖励发放；现行 Settlement 的 nodeRewards 指针双链均为零、未启用）** |
| **NodeRegistry** | 节点 ID 与奖励钱包的绑定注册表（防作弊、可验证） |
| **OrderNonceManager** | 管理每个用户的订单 nonce，防止订单重放 |
| **Governance / GovernanceExtended** | 提案投票（活跃集 = 近 2 周有贡献地址的 Merkle 集，7 天投票 + 2 天时间锁）与多步提案。**接线前门禁见 `docs/round32-fixes-2026-11-08.md`「启用前门禁」一节（活跃集现由提案人自填、未与链上快照绑定；把任何核心合约 owner 交给 Governance 之前必修，现行技术栈 owner 为部署者、Governance 未接线）** |
| **TokenRegistry / ChainConfig** | 可交易代币白名单 / 支持的流通链配置，仅 governance 可增删 |
| **CrossChainBridge** | LayerZero V2 OApp 跨链桥（源链锁定、目标链解锁，扣桥费）；另有 CCIP / Wormhole 通道（官方组件 + WrappedTKA 胶水） |
| **WrappedTKA** | TKA 的 1:1 包装代币，作为 CCIP / Wormhole 桥的载体代币 |

## 构建与测试

```bash
cd contracts
forge build
forge test        # 注意：勿并发跑两个 forge 进程（共享 out/cache 会损坏）
```

## 部署到测试网

现行技术栈的部署与地址见 `docs/round30-nodeless-stage1-2026-11-08.md` /
`docs/round30-l2-legb-2026-11-08.md`（第 32 轮换栈后见
`docs/round32-fixes-2026-11-08.md`）。部署脚本为 `script/DeployL2.s.sol`
（一次广播完成 Vault + Settlement + MakerVault 三件套并从旧 Settlement
复制配置，ChainGuard 按 `TARGET_CHAIN_ID` 护栏）。

[DEPLOY-SEPOLIA.md](./DEPLOY-SEPOLIA.md) 是早期（Phase 1 时代）的部署
记录，其中的费率与步骤**不再适用**，仅作历史留存。
