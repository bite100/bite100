# 第十五轮部署记录（2026-11-07）：挂单余额锁定版双链重新部署

设计与语义见 `docs/order-balance-locking.md`。本轮因 Vault 增加锁定账本，
按依赖图将十合约在 Sepolia 与 Base Sepolia 全部重新部署并接线；
前端链配置已切换（`frontend/src/config/chains.ts`），节点签名域默认值
已更新为新 Sepolia Settlement。

## Sepolia（chainId 11155111）

| 合约 | 新地址 |
|---|---|
| Vault | 0x7B6aFdd9799ABa60a4Fd77217b40E8191Dc498f5 |
| FeeDistributor | 0x346DE29B7fEe95F44A5b5385e87182F031E8E1B5 |
| Settlement | 0x929ceb054B86Bf222eb94Df7b75aDa4fD22A538A |
| MockERC20 TKA | 0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E |
| MockERC20 TKB | 0x1530b74E6d5C2D0e2b78314b5C253E66bfC4ddc2 |
| AMMPool | 0x744d25a4163Da099c75aF9D10e32704420a76E94 |
| ContributorReward | 0x12b8dA1b30771c46025488621bfe3DC665E9C0a8 |
| Governance | 0x31900dD9C5190F72A2Da96E3efE45014B5748448 |
| TokenRegistry | 0x9d50B1088E483f3A192A018c6a59cb9a5bddeDDd |
| ChainConfig | 0x0f419cA52A47d2cA7Ae5f803cf010263012D2cA1 |

关键交易：Settlement 创建 0x44ad6b89370a278bb43d245fefc84e19165d43f61442673462c04f042686adaf；
Vault.setSettlement（指向真 Settlement）0xe91149040bef961e1dc237ded30977b149689ef2f71f70e0bd883cf20b052bcd。

读回（全部 PASS）：Vault.settlement == Settlement ✓；Vault.lockers(部署者) == true ✓；
FeeDistributor.developerAddress == Ren 钱包 0x047df18eF5484945D33fBddB8D58D382597354d9、
developerShareBps == 100 ✓；Settlement/AMMPool 的 feeDistributor == FD ✓；
AMMPool.contributorReward == CR ✓；六处 governance() 均 == Governance ✓；十地址均有代码 ✓。

### 过程注记（Sepolia 计量异常与资金消耗）

- 经 publicnode 入口的 Sepolia gas 计量显著非标准：分叉实测 Settlement 创建
  耗 25,427,275 gas（标准 EVM 约 3,644,935，约 7 倍），与历史注记
  「普通转账约 204,600 gas」同源。首轮 forge script 广播在 Settlement 创建处
  因 forge 默认约 1 gwei 的费用建议叠加膨胀计量被预留检查拦截
  （单笔预留 0.033 ETH > 当时余额 0.0254 ETH）；其后若干次以默认费用建议的
  创建尝试进一步消耗余额。最终成功序列改用 legacy + 0.003 gwei 显式定价
  （当时 base fee 仅 15 wei）完成全部部署与接线。
- 首轮广播中途失败留下一个插曲：Vault.setSettlement 等接线交易实际已上链，
  曾指向「预测的 Settlement 地址」；该地址后来被一笔 MockERC20 TKA 创建占用，
  已重新指向真 Settlement 并读回确认（见上）。另有一笔网关重试产生的重复
  TKA 合约 0x94d441EB3911E3380Eb8eeb99624d00504a83f4b，未被引用，忽略即可。
- 部署者 Sepolia 余额：轮前 0.025431 ETH → 轮后 0.000154 ETH
  （消耗约 0.02528 ETH，绝大部分烧在上述膨胀计量 × 默认高费用建议的失败
  尝试上；成功部署序列本身仅约 0.0004 ETH）。余额已低，后续 Sepolia 操作
  前需留意补充测试币。

## Base Sepolia（chainId 84532）

标准脚本流一次完成（核心六 → ContributorReward → Governance →
TokenRegistry/ChainConfig → AMMPool.setContributorReward），计量正常。

| 合约 | 新地址 |
|---|---|
| Vault | 0xd09E808D0978bdD06738a5dAfBd3c0a286aE3Fb2 |
| FeeDistributor | 0xAeC85272Cba4F22eaf93a0313b0D09164Ca009b7 |
| Settlement | 0x3F9F29A6Ff7F706Bd769da3f0F4b3dCe70371D4c |
| MockERC20 TKA | 0xd3f1136Cb3511b4546BDE5dDAC4F0D5a4D5C5D33 |
| MockERC20 TKB | 0x8492ccCE958803F04772C0f5B51DbbC320A54daF |
| AMMPool | 0x20F25844bC6823325d67fB8aC71cA416601774a1 |
| ContributorReward | 0xFe066c25a25Fddd6433Fac7f7769d5806392663e |
| Governance | 0x26b608468bf5Dd88B91EAE3D16827A2b4a25BCcE |
| TokenRegistry | 0x8dC560038D392012C8562185E4C6Bf2Ce636E74D |
| ChainConfig | 0x439423AB16A1A3dadf5415243501ee9e6984b813 |

读回（全部 PASS）：与 Sepolia 同清单逐项核对（settlement 指针、locker、
FD 开发者=Ren/份额 100、FD 指针、AMM→CR、六处 governance)✓。
部署者 Base Sepolia 余额：0.009898 → 0.009809 ETH（消耗约 0.000089 ETH）。

## 双链 E2E 全闭环（TestChainLockingLoopE2E，两链各一遍 PASS）

流程：存款（maker 1000 TKA / taker 1000 TKB）→ 订单 A 落锁 → 超额提取被拒
→ 撤单释放 → 订单 B + taker 单撮合落锁 → 结算 → 分账断言 → 重放被拒。

Sepolia 证据：
- 落锁 A tx 0xa9da434f7c36fddd387728cf1eb90b38ea8c65aa0a5ca1e4d2436aba3c7acd5d，
  摘要 0x79f794c78ada04072cba698f8a4a5b030edbf00419226d6b8a7019c9148a6806；
  读回 balance/locked/available = 1000/100/900 TKA ✓
- 超额提取（可用 900 时提 900+1 wei）被拒：`Vault: insufficient available balance` ✓
- 释放 tx 0xd83f7494cf71a5bc843321dfb31b93095920c4e5d7f2a7e383396b0ef810150c；
  读回 locked=0、available=1000 ✓
- 落锁 B tx 0xa21b08454803013e8aba61aac27c066c143996d42669cf4d31bfbc996a757c9e；
  taker 落锁 tx 0xf8a6131f8bc7ad88fc35637f3fcedf5f2d014d426740be98f1d284711c9d1707
  （读回 maker 锁 100 TKA / taker 锁 200 TKB）✓
- 结算 tx 0x6b2b02fde385cd946e6805bd7fc1b9d6b1e4ecb8fbf50ba9ed0e0771f6c7d8f3；
  增量断言：maker TKA 1000→900、TKB 0→199.98；taker TKB 1000→800、TKA 0→99.99；
  FD +0.0099 TKA / +0.0198 TKB（99%），Ren 钱包 +0.0001 TKA / +0.0002 TKB（1%)✓
- 结算后双边 locked=0 ✓；同一成交重放被拒（`Settlement: fill exceeds signed order`)✓

Base Sepolia 证据（同一测试，BIT100_E2E_CHAIN_ID=84532）：
- 落锁 A tx 0x8dd3eaa87c962ac568a537dbbb790ecaf7837d2fb122722a09a188d2e6aaf5e7，
  摘要 0x13d9b7b545db61b18680452d54ac30bd9bb6323e0b7524360c78a57981deeafb；读回 1000/100/900 ✓
- 超额提取被拒（同上错误）✓；释放 tx 0x51f420c279216e3899d34373013ed66c3308fa2ca2900d3ba2f955a6dd949176，读回 0/1000 ✓
- 落锁 B tx 0x830f42c8c9c7175f5070c65db511c4373bc66e64d5cd13685bae124cb7cd9e73；
  taker 落锁 tx 0x29e1666cbe11182cfa7f5eedbfc15d53c8bc891fe85b8523d5b42128559b4cb5 ✓
- 结算 tx 0x55ed205bdbcc38e2be35b49da08c0a128c19464e49f585069ffe7df3058adda0；
  分账增量同 Sepolia 口径全对 ✓；锁定清零 ✓；重放被拒 ✓

## 遗留与注意

- **跨链桥未随本轮迁移**：LayerZero 桥（Sepolia 0x8711a7046883Fd8DBF0204695deB43531D484153 /
  Base Sepolia 0xB4eaE3903B6734EA06f8fdD4Bd20a048D3F914EC）仍绑定上一代 TKA；
  前端桥页面现指向新代币，与旧桥的绑定不一致——桥接功能需单独一轮重新部署
  桥并重新配对后才可用（多 DVN 主网门禁不变）。
- 旧部署（第五/八轮地址）合约仍在链上，未做迁移；TokenRegistry/ChainConfig
  仍为空表（填充需治理提案，与此前状态一致）。
- 节点启用落锁需配置 `chain.vault` 并设置环境变量 `VAULT_LOCKER_PRIVATE_KEY`
  （见 node/config.example.yaml）；未启用时节点行为与此前一致。
