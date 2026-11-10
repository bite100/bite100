# 第六十一轮：治理加固（快照注册表 / 计量人签名 / 摘假计票 / OZ MerkleProof）

> 依据：`docs/full-review-remediation-plan-2026-11-10.md` 第 61 轮定案 + ChatGPT 回信
> 采纳项（治理 A/B/C 分层、ContributorReward 加固六项）+ 逐模块对照报告模块 9 与
> F2 验收细化。三条规矩照旧：不重复造轮子、只做集成、先查一手资料。
>
> 本轮状态：**已合并推送（main 58accb6）；新 Governance/ContributorReward 已双链
> 部署并完成接线切换，见 §1.1 部署附记**（代码基线 main 673e349）。

## 1. 部署状态核查（开工前链上实测，2026-11-10）

结论：**Governance 与 ContributorReward 在双链都有在跑的实例，且接进了现行
（第 47 轮）栈——但处于休眠状态。本轮只交代码 + 测试 + 文档，不部署。**

| 项 | Sepolia | Base Sepolia |
|---|---|---|
| Governance 实例 | `0x31900dD9C5190F72A2Da96E3efE45014B5748448`（前端 config 在册） | `0x26b608468bf5Dd88B91EAE3D16827A2b4a25BCcE` |
| ContributorReward 实例 | `0x12b8dA1b30771c46025488621bfe3DC665E9C0a8` | `0xFe066c25a25Fddd6433Fac7f7769d5806392663e` |
| 接线 | 现行 Settlement.governance() 与 CR.governance() 均指向上述 Governance | 同左 |
| 活动度 | proposalCount = 0（从未有提案）；owner = 部署者 EOA | 同左 |
| 资金权限 | Vault owner 仍是部署者 EOA——Governance 对资金合约**无任何权限** | 同左 |

- 上述实例不是第 47 轮重部署的产物（47 轮栈 = Vault/Settlement/MakerVault），是
  早期全栈部署留下的实例，被 47 轮 Settlement 以 governance 指针继续引用。
- GovernanceExtended 无部署记录（不在前端 config、部署脚本只部署 Governance），
  本轮改它不影响任何在跑实例。
- **含义**：在跑实例仍是旧代码（含本轮要堵的洞），但洞处于休眠（零提案、无资金
  权限、CR 未注资）。重新部署/换址接线是独立一步——须与前端同轮切换（前端 ABI
  已按新合约改，**不得把新前端单独部署到旧 Governance 上**），等 Ren 拍板后另行
  执行并做部署后复核。本轮分支不含任何部署动作。

### 1.1 部署附记（2026-11-10，合并推送后执行，Ren 全权放行口径内）

新代码（main 58accb6）已双链部署并完成接线切换，旧实例原样保留作回滚。

**接线安全前置核查**：Settlement 对 `governance` 是纯地址存储——结算热路径
不调用 governance，该地址仅作 `onlyOwnerOrGovernance` 的管理权限身份
（setFeeBps/setFeeDistributor 等），`setGovernance` 为 onlyOwner；新
Governance 的快照注册表模型只收紧不放宽该权限的取得路径，故换址不改变
结算行为。ContributorReward 同理：`governance` 仅作 `onlyGovernance`
身份校验（setReserveBps/setFreeFlowBps/setReputation*），不回调。

| 项 | Sepolia | Base Sepolia |
|---|---|---|
| 新 Governance | `0x1A25a086053703b41fec1Fa170A9BE3975afeCce`（部署 tx `0xe2964b18ee29a0dd8b0298460c02997280088b9fa5b0cebaecf0b5a623edee86`） | `0xc3b0ca3128ABAD6721d6C7F07D3129367d521e32`（部署 tx `0xe3b801c237cf3f299c685efd47e5eaeec6090297f475758d5e819664cada2a44`） |
| 新 ContributorReward | `0x10226fD9C696CBef3255E11d22edcA2d8ca03967`（部署 tx `0x0bf45a14e49a052943fd94efc07a45f5c271a7a54907ba02cfed1dfdfee5a425`） | `0x154C9e023597aE973b35568FCEFf0AEbd3532358`（部署 tx `0x38b271dbd3c86885b06e34ae13527c819933e33b59d7a615ad9bb5734083d78d`） |
| CR.setGovernance(新 Gov) | tx `0xa4a4b70ac60429e144c4ca6a3bded2ceb936a5561aaa77525e1b925eee1213af` ✓ | tx `0xae78c7586e4c68b3b908e4fb2da0abebf0a5736888dbac456849d6f3a769fe2a` ✓ |
| Settlement.setGovernance(新 Gov) | tx `0x33049bffed17e20d099af0e1dca568a3236645645b47fdd59b36bfea73988edf` ✓ | tx `0x6f3853c13fd17bc3b8615ca6122048fa57d2cdee873a4f37dc3178457f62613c` ✓ |

- 配置同构：旧实例链上实测全部为代码默认值（owner=部署者、timelockDelay
  172800、reserveBps 1500、freeFlowBps 1000、reputationThreshold 0、
  信誉加权关），两合约构造器均无参，新实例部署即同构，无需迁移设置。
- 部署后复核（双链逐项回读）：新 Gov owner=部署者、snapshotCount=0、
  timelockDelay=172800；新 CR owner=部署者、governance=新 Gov、
  reserveBps/freeFlowBps=1500/1000；Settlement.governance()=新 Gov；
  `publishSnapshot` 以 owner 身份 eth_call 模拟（哑根+人数 1）返回编号 0
  且未落链（snapshotCount 仍 0）——函数存在且校验路径可达；未真发布任何
  快照（快照内容属后续管理员决定）。旧 Gov/CR 未做任何写操作。
- 前端 `frontend/src/config/chains.ts` 双链 governance/contributorReward
  地址已同步切换（与本附记同提交）。

## 2. 设计

### 2.1 活跃集快照注册表（堵审查 P1-01：提案人自选活跃集）

旧洞：`createProposal(target, callData, merkleRoot, activeCount)` 的根与人数由
调用者自带，只校验非零——任何人可造一份只有自己的 1 人活跃集，投票自证过半、
执行任意调用。休眠仅因 Governance 尚未接权。

新模型（`Governance.sol`）：

- `publishSnapshot(merkleRoot, activeCount)`（仅 owner）：把根/人数/发布者/时间
  上链固定，返回递增 `snapshotId`。注册表**只增不改**：修正名单只能发新快照，
  已建提案继续绑定其引用编号，历史可审计。
- `createProposal / createMultiStepProposal`（及 GovernanceExtended 三个带元数据
  入口）改为只接受 `snapshotId`；root/count 在建提案时从快照复制绑定进提案
  （`Proposal` 增 `snapshotId` 字段存证），投票验成员与执行过半线全部取快照值。
  引用未发布编号直接回滚（`Governance: snapshot not published`）。

**快照生产流程**（本轮同时补上老问题「活跃集无人产生」）：

1. 链下贡献计量（既有离线计量 CLI：挂单等四线口径）按周期产出成员清单；
2. 清单按冻结的叶子口径折成 Merkle 根（叶子 = `keccak256(abi.encodePacked(地址))`，
   与链上校验及既有工具同口径），得 root + 人数；
3. 治理管理员核对清单后运行 `contracts/script/PublishSnapshot.s.sol`
   （env：`GOVERNANCE_ADDRESS / SNAPSHOT_MERKLE_ROOT / SNAPSHOT_ACTIVE_COUNT /
   PRIVATE_KEY`）发布——**发布交易本身即发布者对该清单的签认**；
4. 提案人按公布的编号创建提案；成员 proof 由名单产出方随快照一并发放。

owner 现阶段 = 部署者 EOA；主网门槛轮迁 Safe 多签后，publishSnapshot 的调用方
随 ownership 一并迁移，流程不变。

### 2.2 voteWithWeight 摘除（审查 P2-03）

旧实现：调基类 `vote()`（计票恒为 1）后再 emit 一个算出来的权重——权重从不
参与计票，是会误导前端与用户的假功能。本轮整体删除 `voteWithWeight`、
`getVotingWeight`、`VoteWeighted` 事件及辅助函数（`getPeriodForTimestamp /
_uint2str`）。真加权计票 = 治理模型产品决策（Ren 缓议），不在本轮；前端同步
删除提案卡片上数值实为票数重标的「投票权重」行（§3 块5）。

### 2.3 ContributorReward 计量人签名 + 期末冻结（审查 P1-02 + 采纳六项）

旧病：`submitProof/Ex`、`submitLiquidityProof` 验 `ecrecover == msg.sender`——
被计量人自签自证，任何人可给自己伪造任意贡献分。

新模型（`ContributorReward.sol`，骑 OZ `EIP712` + `ECDSA`）：

- **计量人注册表**：`measurers[metricType][address]`，owner 以 `setMeasurer`
  按贡献线（metricType = nodeType：0 中继 / 1 挂单 / 2 结算提交 / 3 gas 库存款）
  分权注册。一线的计量人签不了另一线（注册校验按提交的 metricType 查表）。
- **证明结构**（EIP-712，域 = "Bit100 ContributorReward"/"1"，含 chainId 与
  合约地址）：`MetricAttestation` 绑定 account、periodId、metricType、全部计量
  字段、**evidenceRoot**（链下计量明细的根，供事后重算核对）、**nonce**、
  **deadline**；存款线为 `LiquidityAttestation`（amount + 同上绑定）。
  摘要由合约公开函数 `metricAttestationDigest / liquidityAttestationDigest`
  给出，计量 CLI 离线签名、任何人可复核。**提交者可为任意人**——证明的对象是
  被计量账户，签名者与提交者、被计量者三方分离。
- **防重放**：`(计量人, 账户, periodId, metricType, nonce)` 成功消费后登记
  `attestationConsumed`，同组重放回滚。同周期纠错 = 计量人以**新 nonce** 出具
  新证明覆盖分数（冻结前）。
- **期末冻结** `freezePeriod(period, scoresRoot)`（owner）：锚定最终分数表折成
  的 `scoresRoot` 与冻结时刻总分/总加权分；冻结后三条改分路径（证明提交、
  `setContributionScore`、信誉重算）全关；领取的分母改读冻结锚定值，不随事后
  记账漂移。**冻结后纠错只能追加到下一周期**，不回改已冻结份额（争议走申诉
  窗口 + 下周期调整，与采纳六项 §6 同口径）。领取不受冻结影响——冻结正是让
  领取所依据的分数定版。
- 权重常量 35/25/20/20（第 42 轮定版）、分配/领取（单次 10% 上限、90 天窗）/
  未领回流的既有语义**零改动**。

**计量人密钥管理**（运维口径，随本轮定版）：

- 计量人 = 离线计量 CLI 的签名身份，**独立密钥**：不得与部署者/operator 密钥、
  被计量账户密钥共用；按线分设（四线可不同人/不同钥，重要线后续可多人）。
- 注册/轮换：owner 调 `setMeasurer(line, addr, true/false)`；轮换 = 先注册新钥、
  再注销旧钥（注销立即生效，旧钥此后证明全回滚——有验收测试）。
- 泄漏处置：注销泄漏钥 + 冻结未冻结周期；已消费 nonce 登记使旧证明无法重放，
  已入账分数可凭 evidenceRoot 对链下明细重算核对。

### 2.4 OZ MerkleProof 换库（骑乘）+ F2 叶子约定

`Governance / MerkleDistributor / Settlement` 三处改用 OpenZeppelin
`MerkleProof`（OZ 5.6.1，仓内既有依赖；`verify` 签名与 sorted-pair 语义与自研
库一致），删除自研 `contracts/src/MerkleProof.sol`。

**F2 约束执行**：本轮**不**引入 `@openzeppelin/merkle-tree`、**不**动任何叶子
构造（三处叶子口径冻结：治理 = `keccak256(abi.encodePacked(地址))`、分发 =
`keccak256(abi.encodePacked(index, account, amount))`、Settlement fill 叶不变），
故换库本体零口径风险；并加叶子回归：用旧自研库算法逐行复刻构造 root/proof，
断言 OZ `verify` 通过且 MerkleDistributor 旧树 claim 仍可达（见 §4）。

## 3. 变更清单（按提交）

| 提交 | 内容 |
|---|---|
| `1ce8629` 块1 | OZ MerkleProof 换库（三消费者 + 删自研库）+ 叶子回归测试 3 个 |
| `418e184` 块2+3 | 快照注册表（Governance + Extended 透传 + PublishSnapshot 脚本）+ voteWithWeight 摘除 + 验收测试 8 个；既有 Governance.t.sol 三测试改走发布→引用 |
| `58b1278` 块4 | ContributorReward 计量人 EIP-712 证明 + 注册表 + 防重放 + 冻结；既有 reward 测试 11 个改走计量人签发（断言不变）；新增验收 7 个 |
| `59f5971` 块5 | 前端：ABI 换 snapshotId 签名 + 治理页创建表单改快照编号（含链上存在性预检）+ 说明文案同轮更新 + 删除「投票权重」行 |

## 4. 验收（门禁实测）

- **forge 全量：211/211 通过**（基线 193 + 本轮新增 18；基线口径见文末注）。分块验收：
  - 既有治理测试 3/3、既有 reward 测试 11/11（行为断言不变）改版后全过；
  - 新增 `test/Round61.t.sol` 共 18 个：OZ 叶子回归 3（四叶树成员/非成员 +
    分发旧树双 claim）、快照 8（未发布回滚 ×3 路径、非 owner 发布回滚、
    只增不改、攻击回归：非成员投票被拒 + 法定人数不足执行回滚、正路径
    两票通过执行、扩展入口透传）、voteWithWeight 低级调用无选择器 1、
    计量证明 7（自签回滚、跨线回滚 ×2、防重放、过期、注销失效、冻结禁写
    不禁领 + 锚定核对）。
- **前端：vitest 474/474（与基线一致）、tsc 干净、build ✓**。
- relay / mcp：**零改动**（git diff 核对 0 文件）。

构建注记：via_ir 下把多个重断言塞进单个测试函数曾触发 Yul 栈溢出
（`Variable _31 is 1 too deep`），回归测试按合约/函数拆分后通过——后续给
治理/奖励加测试时沿用拆分写法。

注：基线计数口径——基线 = 基线提交（673e349）同树全量实测 193 个测试 /
19 suites 全过（与 HEAD 树枚举的 193 个测试函数一致）；本轮后 211 = 193 + 18。

## 5. 骑乘对照表（每个新件骑哪个既有件）

| 本轮件 | 骑乘的既有件 | 自研部分（胶水/差异化） |
|---|---|---|
| Merkle 校验 | OpenZeppelin `MerkleProof`（仓内 OZ 5.6.1） | 无（叶子口径冻结沿用） |
| 计量证明签名 | OpenZeppelin `EIP712` + `ECDSA` | 证明字段设计、按线注册表、防重放键、冻结语义（业务差异化） |
| 快照发布 | forge Script 既有脚本形态（ChainGuard 同系） | 注册表与「发布=签认」流程（业务差异化） |
| 前端快照预检 | 既有 ethers Contract 读路径 | 表单与文案 |
| 治理执行延迟 | 既有自研 timelock 字段（本轮不动） | TimelockController 采纳见 §6（不在本轮） |

## 6. 主网门槛剩余（不在本轮实现，仅记录）

- **TimelockController（治理路径 A）**：只引入 OZ TimelockController、保留现有
  投票制度，定为主网门槛轮时锁实现选型——与 Safe 多签一并落地（Vault owner
  时锁可先行，与治理迁移解耦）。本轮未引入。
- **Governor 迁移（路径 B）**：Governor Core + 自定义 Merkle 票源模块
  （`_getVotes`/计票自研，无现成 Merkle 票源件）作为候选，成本/收益调研小结
  仍欠——本轮收尾应另行交付调研结论给 Ren 定（路径 C 转 ERC20Votes 三方
  一致不采用）。真加权计票是否实现同属该决策。
- **接权顺序硬约束**：在重新部署本轮新代码**并完成接线复核之前**，不得给
  Governance 授予任何资金合约权限（与 §1 休眠状态保持一致）。

## 7. 诚实遗留

- **重要类别多方确认（k-of-n）未实现**：注册表已支持一线多计量人，但当前任一
  注册计量人的单签即生效；采纳六项提的「重要类别多签/多方确认」留待后续
  （证明格式已按单签设计，扩 k-of-n 需加入多签聚合入口，格式可兼容演进）。
- **信誉加权口径的一个残余**：冻结锚定了总加权分母与个人贡献分，但个人加权
  分子仍读实时 `reputationScore`；`useReputationWeighting` 现默认关闭且模块
  未注资，启用加权分配前应先把「冻结同时冻结信誉输入」补上或运营上冻结后
  不再改信誉分。
- GovernanceExtended 的 `contributorReward` 配置字段在摘除权重计算后仅剩
  预留用途（地址 + setter 保留未删，避免扩大改动面）。
- 在跑旧实例的处置（重新部署新 Governance/CR 并改 Settlement/CR 接线、前端
  同步切换）不在本轮，见 §1。
