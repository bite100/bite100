# LayerZero 桥迁移部署记录（第十六轮，2026-11-07）

> 范围：第十五轮全套合约重部署（含新 TKA/TKB）后，第九轮的桥仍绑定上一代
> TKA、与前端指向的新代币不一致，桥实际不可用。本轮将桥重新部署到第十五轮
> 新代币并恢复端到端可用：双链部署 + setPeer 互信 → 代币映射/桥费/流动性 →
> 前端接线 → 一笔真实跨链到账。桥实现未改（沿用第九轮修复版
> `CrossChainBridge.sol`），合约源码零改动。
> 第九轮原始记录见 `docs/bridge-deployment-2026-11-07.md`（其地址已过时）。

## ⚠️ DVN 安全现状（先说清，不许淡化）

新桥双向路径的**生效** ULN 配置经链上读回（`Endpoint.getConfig(桥, sendLib, 对端
EID, CONFIG_TYPE_ULN=2)`）仍是 **1-of-1**：

| 路径 | sendLib | requiredDVNs（生效） | requiredDVNCount | confirmations |
|---|---|---|---|---|
| Sepolia → Base Sepolia | `0xcc1ae8Cf5D3904Cef3360A9532B477529b177cCE` | [`0x8eebf8b423b73bfca51a1db4b7354aa0bfca9193`]（LayerZero Labs） | **1** | 2 |
| Base Sepolia → Sepolia | `0xC1868e054425D378095A003EcbA3823a5D0135C9` | [`0xe1a12515f9ab2764b887bf60b923ca494ebbb2d6`]（LayerZero Labs） | **1** | 2 |

即与第九轮同款的 LayerZero 默认配置，**不是主网安全目标**（与 KelpDAO 事故的
失效形态同形）。测试网拿不到第二家可用 DVN 的结论与第九轮一致（见第九轮记录
§4）。**主网开桥前必须执行 `contracts/script/ConfigureDvns.s.sol`（≥2 家 DVN、
双向同时下发）并读回存档，否则不开放桥**——该门禁与
`docs/bridge-abstraction.md` §5 一致，本轮 E2E 不得被引用为「多 DVN 已验证」。

## 1. 双链部署与 setPeer

LayerZero Endpoint V2（两链同址）：`0x6EDCE65403992e310A62460808c4b910D972f10f`
EID：Sepolia `40161`、Base Sepolia `40245`（沿用）。
构造参数 `(endpoint, delegate=部署者)`，走第七轮链参数化脚本
（`TARGET_CHAIN_ID` 防错链）。Sepolia 部署沿用第十五轮验证过的显式低价定价
（legacy + 0.003 gwei；当时 base fee 19 wei），一次成功，无失败重试烧钱。

| 链 | CrossChainBridge（新） | 部署 tx |
|---|---|---|
| Sepolia (11155111) | `0x7a0eCbc2Ffca2F8f7A1505Fa65e7E4759bE33d50` | `0x5e67392a8620c02378dfd2256d373f20208c3ed65dc7fcc2b467951f50f1902b` |
| Base Sepolia (84532) | `0xA7722A0ba7F2DA1d4D67D5191222C5e4c3835dBB` | `0x43bb7502bbdd653b94acbd81e611bf67c360cbcf9655d84c42c2d61e17ab0001` |

setPeer 双向读回均 == 对端桥地址（bytes32 编码）✓
（Sepolia 侧 setPeer tx `0x268eddaeb6261c74f11697a5454de50640ce8224fadcfbaeb28001a9eb2ca730`；
Base 侧 `0xa7f969ccea6a9f5cd4fe5d3dad5b05bc8ed8a88f56ff8c9264dc14399f998b94`）。

## 2. 代币配置与流动性（绑定第十五轮新 TKA）

桥费：两侧均 `0.1 TKA/笔`（从转账额内扣，留在源桥，owner 可 `withdrawFees` 提取），沿用第九轮口径。

| 项 | Sepolia 桥 | Base Sepolia 桥 |
|---|---|---|
| 支持代币 | 新 TKA `0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E` ✓ | 新 TKA `0xd3f1136Cb3511b4546BDE5dDAC4F0D5a4D5C5D33` ✓ |
| 映射 | (40245, 新 TKA) → Base 新 TKA ✓ | (40161, 新 TKA) → Sepolia 新 TKA ✓ |
| 桥费读回 | 0.1 TKA ✓ | 0.1 TKA ✓ |
| 配置 tx | setSupportedToken `0xa2d2b3a2…`、setTokenMapping `0xcc08a7c1…`、setBridgeFee `0x647d6a1d…` | setSupportedToken `0xf2ecc88c…`、setTokenMapping `0xa0d0014e…`、setBridgeFee `0x1ed58fd7…` |

流动性：Base Sepolia 桥预存 **1000 新 TKA**（MockERC20 `mint` 直达桥地址，
tx `0x54bbf7a15c9249a631f93738f02c60569439fc16c2e24c12ae789b8bd97ef658`，读回
余额 1000 TKA ✓），供解锁放行。Sepolia 侧 deployer 新 TKA 余额充足（999,000），
锁定路径无碍。

## 3. 真实跨链一笔（Sepolia → Base Sepolia，10 新 TKA）

- 发起：deployer 自发自收；报价 `quoteBridgeFee` = 104,027,936,596,558 wei
  （约 0.000104 ETH，与第九轮同值），实付 ×1.2 缓冲 = 124,833,523,915,870 wei。
- 源 tx（Sepolia）：`0x054b22643584e40dd8196bd1833678d90078043e4ee552b64a18420bd7cc18e2`
  （block 12082829，gasUsed 1,811,051，与第九轮同值）。
- **guid**：`0x1d11a42e65e520a906ab4acc74759e5cc4b8da77a5dab92bb0d022ccaf944a76`，transferId = 1。
- 源侧落账 `transfers(1)` 读回：user=deployer、srcToken=Sepolia 新 TKA、
  dstToken=Base 新 TKA、amount=10 TKA、netAmount=9.9 TKA、dstEid=40245、
  lastGuid 与上一致、status=Pending(1) ✓；`guidToTransfer(guid) = 1` ✓；
  Sepolia 桥 TKA 余额恰锁 10 TKA ✓。
- 目标侧到账：**9.9 TKA**（= 10 − 0.1 桥费）。
  - 目标 tx（Base Sepolia）：`0x72077f3d6d0acc3ddfcee54caa6121b709655fcb9b053713ffa5147f602752db`
    （block 55614768）。
  - 落账对账：`deliveries(40161, 1)` = {user: deployer, token: Base 新 TKA,
    amount: 9.9 TKA, guid: 同上, status: Completed(2)} ✓；
    `processedFrom(40161, 1) = true` ✓；Base 桥 `getBridgeStatus(guid)` = Completed ✓。
  - 余额对账：Base deployer 999,000 → 999,009.9 TKA（+9.9 ✓）；
    Base 桥流动性 1000 → 990.1 TKA（−9.9 ✓）；
    Sepolia deployer 999,000 → 998,990 TKA（−10 ✓）。
  - 耗时：源侧 initiatedAt → 目标侧 completedAt 共 **458 秒（约 7.6 分钟）**。
    其中 DVN 验证较早完成（目标 Endpoint 的 `inboundPayloadHash` 已写入），
    LZ 官方执行者在约 10 分钟观察期内未执行，本轮沿用第九轮正道：由 deployer
    调用协议**无许可执行路径** `Endpoint.lzReceive` 触发投递——执行前以
    `keccak256(guid‖message)` 与链上已验证 hash
    （`0xe185cb852f9af928d0bc4d63010b692f98746078e0bca005c820b4cf2e8bd0b8`）
    逐字比对一致，证明执行的正是 DVN 已验证的那条消息，未绕过任何验证环节。
- 防重放（活链实证）：到账后 `inboundPayloadHash` 已清零；以完全相同参数再次
  模拟 `lzReceive`，Endpoint 直接 revert `LZ_PayloadHashNotFound`——同一消息
  在协议层无法二次执行；桥内 `processedFrom(40161,1) = true` 为第二道去重。
  双层均已验证（与第九轮同结论）。

## 4. 前端接线

- `frontend/src/config/chains.ts`：`contracts` 新增 `crossChainBridge` 字段，
  Sepolia / Base Sepolia 填入本轮新桥地址，主网占位链填零地址；
  `chains.test.ts` 补两条桥地址断言（测试总数仍 78）。
- `frontend/src/components/CrossChainBridge.tsx`：
  - 桥地址默认取源链配置（输入框的手填地址仍可覆盖），页面标注的
    「留空使用默认」自此属实；
  - 组件内嵌 ABI 与第九轮后合约对齐——此前组件仍是旧口径签名
    （`quoteBridgeFee(uint32,bytes,bytes)`、`tokenMapping(uint16,…)`、
    `getBridgeStatus` 少一位返回值、`retryBridge(bytes32,…)`、
    `BridgeInitiated` 旧事件形），与已部署合约不一致、实际调用必失败，
    本轮一并修正为现行签名，费用估算改走真实
    `quoteBridgeFee(token, amount, dstEid, user, options)`。
  - 第十四轮桥文案未动（地址属配置层）。
- 验收：`npm test` 78/78；`npm run build` 成功；产物 grep 命中双链新
  Settlement（`0x929ceb05…` / `0x3F9F29A6…`）与双链新桥地址
  （`0x7a0eCbc2…` / `0xA7722A0b…`）。

## 5. 门禁与花销

- 合约零改动；`forge test` 100/100（基线未降）；node/sdk 未动。
- 部署钱包 `0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e`（测试币）：
  - Sepolia：主聊天水龙头补给 0.05 ETH（tx `0xed4bdf01…`）后余额 0.050154 ETH
    起步，本轮净耗约 **0.000160 ETH**（部署 + 4 笔配置/授权 + 桥发送，含随发送
    支付的 LZ 消息费净值），轮后 **0.049995 ETH**。部署创建经 publicnode 计量
    gasUsed 16,088,309（约标准 7 倍，与第十五轮注记同源），显式低价下实付
    有限；全程无失败重试。
  - Base Sepolia：轮前 0.009809 ETH，本轮净耗约 **0.000015 ETH**
    （部署 + 4 笔配置 + 1 笔 lzReceive 执行），轮后 **0.009794 ETH**。

## 6. 遗留与注意

- 第九轮旧桥（Sepolia `0x8711a7046883Fd8DBF0204695deB43531D484153` /
  Base Sepolia `0xB4eaE3903B6734EA06f8fdD4Bd20a048D3F914EC`）仍在链上、仍绑定
  上一代 TKA，前端已不再引用；旧桥内资产（Sepolia 侧锁定的旧 TKA 与 Base 侧
  剩余旧 TKA 流动性）属上一代测试代币，未做回收处理。
- 节点侧落锁默认未启用等第十五轮遗留项与本轮无关，状态不变。
