# LayerZero 桥部署记录（第九轮 / M2a，2026-11-07）

> ⚠️ 后续迁移（2026-11-07 第十六轮）：第十五轮重部署新 TKA 后，本记录中的桥
> 地址已过时（仍绑定上一代 TKA）。现行桥地址与迁移 E2E 见
> `docs/round16-bridge-migration-2026-11-07.md`。本文 §4 的 DVN 1-of-1 现状与
> 主网门禁结论继续有效。

> 范围：修复 CrossChainBridge 缺陷集 → 换官方 OApp 底座 → Sepolia ↔ Base Sepolia
> 双链部署 + setPeer 互信 → 代币映射/桥费/流动性 → 一笔真实跨链到账。
> 桥抽象层与多桥路线见 `docs/bridge-abstraction.md`；DVN 安全现状见本文 §4（如实记录）。

## 1. 桥合约修复（commit `157082a`）

动手前发现的根本问题：仓库内 `contracts/lib/oapp-evm` 是**本地桩**（单个 4 KB
OApp.sol，`_lzSend` 只发事件、无 setPeer/lzReceive）——桥从未真正接通过 LayerZero。
处理：从 npm 官方包 vendoring `@layerzerolabs/oapp-evm` 0.4.1、
`lz-evm-protocol-v2` 3.0.168、`lz-evm-messagelib-v2` 3.0.168、
`solidity-bytes-utils` 0.8.3 到 `contracts/lib/`（foundry.toml 加 remappings）；
vendored OAppCore 有一行文档化补丁（OZ 5.x 兼容：`Ownable(msg.sender)`）。

`CrossChainBridge.sol` 逐项修复：

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | `_lzReceive` 5 分钟时间戳过期校验会拒掉真实投递 | 删除。防重放改为两道唯一性：LZ guid/nonce + 桥内 `(srcEid, transferId)` 去重表 `processedFrom` |
| 2 | 收发两侧 requestId 口径不一致、接收侧不落 Completed | 统一逻辑主键：顺序 `transferId` 随 payload 传递 + LZ `guid` 由 MessagingReceipt 回填；源侧 `transfers(transferId)`、目标侧 `deliveries(srcEid, transferId)` 双侧落账，目标放行即 `Completed`，`guidToTransfer` 双向反查 |
| 3 | `retryBridge` 未实现（revert 空壳） | 真实实现：同一 transferId 以新 guid 重发（`_lzSend`），仅原发起人/owner 可调，`maxRetryAttempts`/`retryDelay` 受控；目标侧去重保证先到者放行、后到者被拒，不双重到账 |
| 4 | 原生代币路径未实现 | 明确不支持：`bridgeToken` 对 `token == address(0)` 直接 revert 并给清晰错误（`"Bridge: native token not supported"`） |
| 5 | 目标链靠预存流动性解锁但从未注入 | Base Sepolia 桥预存 1000 TKA（见 §3） |
| 6 | 从未 setPeer | 双向互设并读回（见 §2） |
| 7 | 空 options 时报价/发送不稳定 | 空 options 自动构造 type-3 options（executor lzReceive 200k gas，`defaultReceiveGas` 可调） |
| 8 | `tokenMapping` 键口径 | 以完整 uint32 EID 为键（`mapping[dstEid][srcToken]`） |

测试：桥测试套件以 MockLzEndpoint 重写（完整 send/receive 闭环 + 上述修复点），
`forge test` **84/84**（基线 74 → 84，桥套件 7 → 17）。

## 2. 双链部署与 setPeer

LayerZero Endpoint V2（两链同址）：`0x6EDCE65403992e310A62460808c4b910D972f10f`
EID：Sepolia `40161`、Base Sepolia `40245`（官方部署文档复核）。

| 链 | CrossChainBridge | setPeer tx |
|---|---|---|
| Sepolia (11155111) | `0x8711a7046883Fd8DBF0204695deB43531D484153` | `0xfacd2678…`（全文见链上） |
| Base Sepolia (84532) | `0xB4eaE3903B6734EA06f8fdD4Bd20a048D3F914EC` | `0x570cbe52…` |

setPeer 双向读回均 == 对端桥地址（bytes32 编码）✓。部署走第七轮链参数化脚本
（`TARGET_CHAIN_ID` 防错链），构造参数为真实 OApp 的 `(endpoint, delegate)`。

## 3. 代币配置与流动性

桥费：两侧均 `0.1 TKA/笔`（从转账额内扣，留在源桥，owner 可 `withdrawFees` 提取）。

| 项 | Sepolia 桥 | Base Sepolia 桥 |
|---|---|---|
| 支持代币 | TKA `0x903cdDF52963D9DEA0BDF8be9159E08706683654` ✓ | TKA `0x1ee28c1c490727e49939c95032c749ea5b58b45f` ✓ |
| 映射 | (40245, TKA) → Base TKA ✓ | (40161, TKA) → Sepolia TKA ✓ |
| 桥费读回 | 0.1 TKA ✓ | 0.1 TKA ✓ |
| 配置 tx | setSupportedToken `0x0f40939b…`、setTokenMapping `0xfeaed40b…`、setBridgeFee `0x2ca3f0fa…` | setSupportedToken `0xedf19393…`、setTokenMapping `0xa6cdcc77…`、setBridgeFee `0x441c07b9…` |

流动性：Base Sepolia 桥预存 **1000 TKA**（MockERC20 `mint` 直达桥地址，
tx `0x985b2662…`，读回余额 1000 TKA ✓），供解锁放行。
Sepolia 侧 deployer TKA 余额充足（约 993,900 TKA），锁定路径无碍。

## 4. DVN 配置现状（链上读回，如实记录）

用 Endpoint `getConfig(bridge, sendLib, dstEid, CONFIG_TYPE_ULN=2)` 读**生效**配置：

| 路径 | sendLib | requiredDVNs（生效） | requiredDVNCount | optional | confirmations |
|---|---|---|---|---|---|
| Sepolia → Base Sepolia | `0xcc1ae8Cf5D3904Cef3360A9532B477529b177cCE` | [`0x8eebf8b423b73bfca51a1db4b7354aa0bfca9193`]（LayerZero Labs） | **1** | 无 | 2 |
| Base Sepolia → Sepolia | `0xC1868e054425D378095A003EcbA3823a5D0135C9` | [`0xe1a12515f9ab2764b887bf60b923ca494ebbb2d6`]（LayerZero Labs） | **1** | 无 | 10 |

**结论：两条路径均为 LayerZero 默认配置 = 1-of-1 DVN，不满足本项目
「required DVN ≥ 2」的硬前提**（与 KelpDAO 事故的失效形态同款）。本轮未假装配置：

- 遍查官方部署表与生产项目配置后确认：测试网上第二家 DVN（Google Cloud）
  被生产项目（Lista DAO，其 Sepolia sendLib 与 LZ Labs DVN 地址与本文链上读回
  逐字一致）实测标注为「证明不可靠、要求它会卡住路线」，其测试网策略同为
  仅 LayerZero Labs；其余运营商（Nethermind 等）未公开 Sepolia/Base Sepolia
  可用的 DVN 地址。因此测试网环境确实只能拿到默认配置。
- 缓解与主网门槛：已备参数化脚本 `contracts/script/ConfigureDvns.s.sol`
  （≥2 家 DVN、发送+接收两侧同时下发、跑后 getConfig 读回存档）；
  **上主网前必须执行并读回存档，否则不开放桥**（写入 bridge-abstraction.md §5）。
- 本轮真实跨链（§5）是在默认 1-of-1 配置下完成的——测试网可接受，
  但这笔记录不得被引用为「多 DVN 已验证」。

## 5. 真实跨链一笔（Sepolia → Base Sepolia，10 TKA）

- 发起：deployer 自发自收；报价 `quoteBridgeFee` = 104,027,936,596,558 wei
  （约 0.000104 ETH），实付 ×1.2 缓冲 = 124,833,523,915,869 wei。
- 源 tx（Sepolia）：`0x87bf8577cbff7ce8a7ec5458f044c51776014768f7696c775c2ea4fc7c168430`
  （block 12082058）。事件齐全：TKA `transferFrom` 锁定 10 TKA、
  Endpoint `PacketSent`、SendUln 的 DVN 分配（0x8eebf8b4…）、桥 `BridgeInitiated`。
- **guid**：`0x002635f7d2bfb9c9939427dd60b19fd56ca3db1d6aa5f5849c0699493a492e80`，transferId = 1。
- 源侧落账 `transfers(1)` 读回：user=deployer、amount=10 TKA、netAmount=9.9 TKA、
  dstEid=40245、lastGuid 与上一致、status=Pending(1) ✓。
- 目标侧到账：**9.9 TKA**（= 10 − 0.1 桥费；桥费留源桥，Sepolia 桥读回恰锁 10 TKA ✓）。
  - 目标 tx（Base Sepolia）：`0x1292b9f1a8e56a86936e6165b951b16f6c12327233dfbc68cd6622012a5da911`
    （block 55591626）。事件：TKA `Transfer` 桥→deployer 9.9 TKA、
    `BridgeStatusUpdated(1, Completed)`、`BridgeCompleted(guid, 1, …, 9.9 TKA, 40161)`、
    Endpoint `PacketDelivered`。
  - 余额对账：Base deployer 999,000 → 999,009.9 TKA（+9.9 ✓）；
    Base 桥流动性 1000 → 990.1 TKA（−9.9 ✓）。
  - 落账对账：`deliveries(40161, 1)` = {user: deployer, token: Base TKA,
    amount: 9.9 TKA, guid: 同上, status: Completed(2)} ✓；
    `guidToTransfer(guid) = 1` ✓。
  - 耗时：源 tx 时间戳 1794034944 → 到账 1794035573，约 **10.5 分钟** 落账
    （其中 DVN 验证较早完成——目标 Endpoint 的 `inboundPayloadHash` 已写入；
    LZ 官方执行者在约 17 分钟内未执行，本轮由 deployer 调用协议的
    **无许可执行路径** `Endpoint.lzReceive` 触发投递：执行前以
    `keccak256(guid‖message)` 与链上已验证 hash 逐字比对一致，证明执行的
    正是 DVN 已验证的那条消息，未绕过任何验证环节）。
- 防重放（活链实证）：到账后以完全相同参数再次模拟 `lzReceive`，
  Endpoint 直接 revert `LZ_PayloadHashNotFound`——payload 已在投递时清除，
  同一消息在协议层无法二次执行；桥内 `processedFrom(40161,1) = true`
  为第二道去重。双层均已验证。

## 6. 运维注记

- Sepolia 用的 publicnode 免费 RPC 有非标准 gas 计量（简单 setter 实耗约 13 万、
  桥发送在 150 万上限下耗尽 revert；给足 800 万上限后实耗 1,811,051 成功）。
  经此 RPC 发 Sepolia 交易务必给宽 gas 上限并查 receipt，不要按估算值发。
- 配置类调用曾因函数签名记错（`setSupportedToken` / `setTokenMapping(uint32,address,address)`）
  白付 5 笔 revert 的 gas（测试网 ETH，无实际损失）——以合约源码签名为准，勿凭记忆拼 calldata。
