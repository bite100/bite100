# Bit100 Base Sepolia 测试网同构部署记录（2026-11-07，第八轮 / 多链 M1 收尾）

> **后续（2026-11-07 第十五轮）**：本链十合约已因挂单余额锁定重新部署，Base Sepolia 现行地址以 `docs/round15-deployment-2026-11-07.md` 为准；本文件保留为历史部署记录。

第二条链选定 **Base Sepolia（chainId 84532）**（Ren 按 gas 成本拍板：Base 在三条候选链中
gas 最低且仓库配置预置最全；桥路线已定为修复现有 LayerZero 桥，属 M2）。本轮用与
Sepolia 相同的一套脚本（第七轮已链参数化，全程带 `TARGET_CHAIN_ID=84532` 护栏）把
十合约同构部署到 Base Sepolia，前端补该链配置。Sepolia 现有部署零影响，默认链不变。

## 网络与账户

- 网络：Base Sepolia（chainId 84532），RPC：`https://sepolia.base.org`（读回验证另经
  publicnode / Tenderly / drpc 三家交叉核对）
- 部署钱包：`0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e`（与 Sepolia 同一测试钱包）
- 测试账户：maker `0xE83D2b08356cb463adFc20406a18B79991F7eE29`、taker `0x87ffF84eb917916587fA7721c843cdC3Ada957eA`

## 资金来源（官方桥；第一笔 revert 后改走 Portal 直存）

部署钱包在 Base Sepolia 初始余额为 0，走官方桥从 Sepolia 注资：

| 步骤 | 结果 |
|---|---|
| L1StandardBridge `0xfd0Bf71F60660E2f608ed56e1659C450eB113120`（Base 官方文档地址）`depositETH(200000, 0x)` 0.03 ETH，tx [0x71b3b3a4…55d9d7b](https://sepolia.etherscan.io/tx/0x71b3b3a44ec8f085b9dc35fc98a4d79a83e2e2d353bcceec1e52f9ff755d9d7b) | **revert**（status 0，gasUsed 105896；资金退回。桥合约 eth_call 模拟不 revert、实发 revert，原因未定位） |
| 改走同一官方桥系统的 OptimismPortal `0x49f53e41452C74589E85cA1677426Ba426459e85`（Base 官方文档地址）`depositTransaction(deployer, 0.03 ETH, 200000, false, 0x)`，tx [0xb82df4b1…aa206c3](https://sepolia.etherscan.io/tx/0xb82df4b1ca0ed068df6d41a62e42347dbfdc34a88276bb0dabc7874c6aa206c3) | **成功**，0.03 ETH 中继到账，L2 余额经四家 RPC 一致读回 0.03 ETH |

- Sepolia 侧：部署钱包 0.073915890 → 0.043795721 ETH（Etherscan 核对；总流出
  0.030120169 = 0.03 存入 + 约 0.00012 两笔 gas，含 revert 的桥交易）。
- 过程注记：本轮公共 RPC 读数多次严重发散（Sepolia publicnode 多后端状态不一致；
  sepolia.base.org 一度误报 L2 余额 0.0975，其余三家为 0），最终状态一律以多家 RPC
  收敛一致 + Etherscan 为准才采信。Base Sepolia 的 relay 到账耗时也明显长于名义值。

## 新部署合约（十合约，顺序与 Sepolia 终局同构）

部署入口：`Deploy.runWithAmmAndMocks`（核心六；`DEVELOPER_ADDRESS` 直接传 Ren 地址）→
`runContributorReward` → `runGovernance`（四处回填）→ `runTokenRegistryAndChainConfig`
→ 手工补 `AMMPool.setContributorReward` 一笔。

| 合约 | 地址 | 部署 tx |
|---|---|---|
| Vault | [0xfb458224973c91ddBa3Fb5B55DAD337038768b21](https://sepolia.basescan.org/address/0xfb458224973c91ddBa3Fb5B55DAD337038768b21) | [0xee230607…a0bec2](https://sepolia.basescan.org/tx/0xee230607c589f67b251fce133d37cf7a957c223575a5bfe9860508d494a0bec2) |
| FeeDistributor | [0xAeC85272Cba4F22eaf93a0313b0D09164Ca009b7](https://sepolia.basescan.org/address/0xAeC85272Cba4F22eaf93a0313b0D09164Ca009b7) | [0xccb3a7ad…6b161](https://sepolia.basescan.org/tx/0xccb3a7ad352675bc54a0c5c15de78d2087da1de4d7b11501ee4b9e046b16b161) |
| Settlement | [0x1f81caafa089cfbeb953fc88d272d0a6181e2985](https://sepolia.basescan.org/address/0x1f81caafa089cfbeb953fc88d272d0a6181e2985) | [0x13964998…d0f1e](https://sepolia.basescan.org/tx/0x13964998e6da9f3c38809ef5b51f7a924fd14b0ea08a27b8be52b8417d3d0f1e) |
| MockERC20 TKA (Token0) | [0x1ee28c1c490727e49939c95032c749ea5b58b45f](https://sepolia.basescan.org/address/0x1ee28c1c490727e49939c95032c749ea5b58b45f) | [0x9c00204c…ec673](https://sepolia.basescan.org/tx/0x9c00204cc97a7e9f1f073c8d1fd88f2356f91c067ab66ecc1f065e1cbeeec673) |
| MockERC20 TKB (Token1) | [0x20a78bcb39ff510adba3d3aec9229a9583c5bdb3](https://sepolia.basescan.org/address/0x20a78bcb39ff510adba3d3aec9229a9583c5bdb3) | [0x5ce44e33…4fbd4](https://sepolia.basescan.org/tx/0x5ce44e330577c97397e64120452f1b9388abe723f1249cd645a3cf6af374fbd4) |
| AMMPool | [0x46ac37629a76b6cadce8bc21e5463c6f433bf29b](https://sepolia.basescan.org/address/0x46ac37629a76b6cadce8bc21e5463c6f433bf29b) | [0xab23e8eb…92ccb](https://sepolia.basescan.org/tx/0xab23e8ebc03cd58ddc6d8bb8f4c6ff8a52c5d307fffae1148d676bd8192d2ccb) |
| ContributorReward | [0x7f9371C8a519014eC1ec2Ade4388B627Ec82F8F5](https://sepolia.basescan.org/address/0x7f9371C8a519014eC1ec2Ade4388B627Ec82F8F5) | [0x65e4eebc…423f1](https://sepolia.basescan.org/tx/0x65e4eebc4d348031467d7b2110e3744dd8be7837e61fc6a1fb74bfd4613423f1) |
| Governance | [0x59e4416C5ca7CB977d8225E5E38088B7c801eaeF](https://sepolia.basescan.org/address/0x59e4416C5ca7CB977d8225E5E38088B7c801eaeF) | [0x6d9c57e9…4c49](https://sepolia.basescan.org/tx/0x6d9c57e96391e2ddf03cb35e38cb816196d516f82418570b8e4fcef7ce094c49) |
| TokenRegistry | [0x924A2ac5B56709a9284fB6f99e611F669006F8A7](https://sepolia.basescan.org/address/0x924A2ac5B56709a9284fB6f99e611F669006F8A7) | [0x62938759…6aa90f](https://sepolia.basescan.org/tx/0x62938759b6635bc6ae2019c657817cac80a5b2ea9bbbea2e10746f58136aa90f) |
| ChainConfig | [0xFD170979c08Ab8f06cc01ea9D34CbD2478B6e93c](https://sepolia.basescan.org/address/0xFD170979c08Ab8f06cc01ea9D34CbD2478B6e93c) | [0xaf783ebc…577f](https://sepolia.basescan.org/tx/0xaf783ebcd80931be5e22d033f939a6f8770ad850ff6c6c12459abab3a9d4577f) |

接线交易：Vault.setSettlement [0xc66cc6c9…795175](https://sepolia.basescan.org/tx/0xc66cc6c91624a2714d95d0623645520d7fb95e81a05d1f6115a61dbbd4795175)；
FD.setDeveloperAddress→Ren [0x8afb9393…f5546](https://sepolia.basescan.org/tx/0x8afb93938d2eacc2a1146574a0313c10dd847b6017110ef3247ee9c4ce0f5546)；
FD.setRecipients（部署钱包 9900）[0x21caa42b…64f8](https://sepolia.basescan.org/tx/0x21caa42b898509cb4392e34e5bf82f7ddf08b9a0c0fba6aeda8d8ed214a564f8)；
Settlement.setGovernance [0x945ffb53…141f9](https://sepolia.basescan.org/tx/0x945ffb5329005e40031fcd6eb6670e7c2cf5a18ceb56e6e1d86412ad5d7141f9)；
AMMPool.setGovernance [0x7cca60b5…e4ace](https://sepolia.basescan.org/tx/0x7cca60b57896715050c860b053df964e1f785116de5f97d1a68fe669a5de4ace)；
ContributorReward.setGovernance [0x46695104…c3b1](https://sepolia.basescan.org/tx/0x46695104d55e301ddd5a13f62784cb812dda78effd7915608a8ca99b696dc3b1)；
FeeDistributor.setGovernance [0x0bcf710e…df47](https://sepolia.basescan.org/tx/0x0bcf710eb2955c11eacc27e1e13666ce41e926e9890701347ae1a84ef284df47)；
TokenRegistry.setGovernance [0xf346130c…e36dc](https://sepolia.basescan.org/tx/0xf346130cc2fa721fb526c8105b7fb01a040fa1accb9aad63a88479c3030e36dc)；
ChainConfig.setGovernance [0x83315668…d1ab](https://sepolia.basescan.org/tx/0x83315668333df37dea8bf994d5ba6310380aab813c92560fae8a46039024d1ab)；
AMMPool.setContributorReward [0x4b852466…b16c](https://sepolia.basescan.org/tx/0x4b852466d1be6ad5b6da09290d469174113a3775541e9dcf4a315c594d4bb16c)。

## 链上验证（逐项读回，全部 PASS）

- 十个地址均有代码 ✓
- `Vault.settlement()` == 本链 Settlement ✓
- `Settlement.feeDistributor()` == 本链 FD；`AMMPool.feeDistributor()` == 本链 FD ✓
- 六处 `governance()`（Settlement / AMMPool / FeeDistributor / ContributorReward /
  TokenRegistry / ChainConfig）均 == 本链 Governance `0x59e4416C…01eaeF` ✓
- `FeeDistributor.developerAddress()` == Ren 钱包 `0x047df18eF5484945D33fBddB8D58D382597354d9`，
  `developerShareBps()` == 100 ✓（部署脚本以 `DEVELOPER_ADDRESS` 直接传入，未走部署后改）
- `AMMPool.contributorReward()` == 本链 ContributorReward ✓
- 代币符号读回：token0 = TKA、token1 = TKB（与前端字段映射一致）✓
- 与 Sepolia 同样的尾巴：TokenRegistry / ChainConfig 为空表（填表走治理流程）；
  ContributorReward 未注入周期奖励池；Governance 无提案。

## 结算冒烟（真实跑通一笔）

复用 `node/internal/settlement/e2e_sepolia_test.go`（环境变量全参数化；本轮仅把写死的
期望链 ID 改为可由 `BIT100_E2E_CHAIN_ID` 覆盖、默认仍 11155111，Sepolia 行为不变）：

- 结果 **PASS**：注资 maker/taker 各 0.01 ETH（tx 0xdea9a197… / 0x66a8251f…）→
  双方存币进 Vault → 撮合 1 笔 → 结算 tx
  [0xc754128e…d25164](https://sepolia.basescan.org/tx/0xc754128ece9ebcbe45469629090a6219e1ef529f249551d0f6edb6d891d25164)
- **10/10 断言第 1 轮即收敛**（含手续费 99% 进本链 FD、1% 落 Ren 地址、双方 nonce 0→1），
  同一成交重放被拒（`Settlement: fill exceeds signed order`）✓
- 即第二条链上「存款 → 撮合 → 结算 → 分账」完整闭环与 Sepolia 同构成立。

## 余额消耗（Base Sepolia，ETH）

| 阶段 | 部署钱包余额 |
|---|---|
| 桥到账后 | 0.03 |
| 十合约部署 + 接线后（20 余笔） | 0.029917139（合计仅耗 ≈ 0.0000829，L2 gas 极低） |
| E2E 后（注资 maker/taker 各 0.01 + 结算 gas） | 0.009913174（maker / taker 各余 ≈ 0.0099992） |

## 前端

- `frontend/src/config/chains.ts` 新增 `BASE_SEPOLIA`（84532 / `https://sepolia.base.org` /
  sepolia.basescan.org / 十合约新地址）并接入 `CHAIN_CONFIGS`；**默认链仍为 Sepolia**。
- 顺修盘点错值：`CrossChainBridge.tsx` 的 `LAYERZERO_EIDS` 以太坊主网 30110 → **30101**
  （30110 是 Arbitrum One 的，未动）。
- `chains.test.ts` 补 Base Sepolia 用例；`npm test` **78/78 全绿**（基线 77 + 新增 1）；
  `npm run build` 成功，产物 bundle 已确认含本链 Settlement 与 Governance 地址。
