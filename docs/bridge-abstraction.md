# 桥抽象层（Multi-Bridge Abstraction）

> 2026-11-07 第九轮（M2a）落档。决策背景：Ren 拍板「桥可以全都要」——做一个**可插拔的多桥层**，
> 由交易者在每次转账时**自选**用哪座桥。本文定义统一接口与每座桥向前端暴露的元数据；
> LayerZero 是首个实现，Chainlink CCIP、Wormhole 后续按同一接口接入（本轮不写它们的代码）。
> 选型调研（费用/安全/事故史）见 `~/workspace/bite100-bridge-research.md`（仓库外调研稿）。

## 1. 设计原则

1. **桥是可替换的传输层，不是产品本体。** 产品语义（锁定/解锁、桥费、状态机）由
   Bit100 自己的桥合约与订单系统定义；每座「桥」只负责把一条已签名的跨链意图
   从源链可靠送达目标链。
2. **交易者自选桥。** 前端在发起跨链时列出可用桥及其费用/时延/安全标签，
   用户的选择随订单/转账记录落账，事后可审计「这笔资产是经哪座桥过来的」。
3. **统一状态机。** 无论底层桥如何上报，前端与节点只认四态：
   `Quoted → Initiated → InFlight → Completed | Failed`。
   重放/重复投递在任何桥上都必须被目标侧去重（见 §4）。
4. **费用口径统一。** 报价必须拆成三项返回：协议费（桥网络收的）、目标链执行费
   （可为 0）、Bit100 桥费（从转账额内扣，现行 0.1 TKA/笔）。不许只给一个总数。

## 2. 统一接口（链下视角，供前端/节点调用）

每座桥的适配器（链下服务 + 对应链上合约）必须实现三件事：

```ts
interface BridgeAdapter {
  /** 桥标识与静态元数据（见 §3） */
  readonly id: 'layerzero' | 'ccip' | 'wormhole';
  readonly label: string;            // 前端展示名
  readonly securityModel: string;    // 安全模型标签（见 §3 表格）
  readonly etaSeconds: [number, number]; // 预估时延区间（下限, 上限）

  /** 报价：给源/目标链与金额，返回三分项费用与预计到账净额 */
  quote(req: {
    srcChainId: number; dstChainId: number;
    token: string; amount: bigint; receiver: string;
  }): Promise<{
    protocolFeeNative: bigint;   // 以源链原生币计的协议费（LZ 消息费 / CCIP 费）
    destExecFeeNative: bigint;   // 目标链执行/中继费（无则 0）
    bridgeFeeToken: bigint;      // Bit100 桥费（从金额内扣，代币计）
    netReceived: bigint;         // 预计目标链到账净额
    quoteExpiresAt: number;      // 报价有效期（unix 秒）
  }>;

  /** 发起：执行锁定并提交跨链消息，返回统一追踪键 */
  initiate(req: {
    srcChainId: number; dstChainId: number;
    token: string; amount: bigint; receiver: string;
    maxProtocolFeeNative: bigint; // 用户确认过的报价上限，超出即不发
  }): Promise<{
    transferId: string;  // Bit100 统一顺序号（桥合约 transferCounter）
    srcTxHash: string;   // 源链锁定+发送交易
    messageId: string;   // 桥原生消息 ID（LZ=guid / CCIP=messageId / Wormhole=sequence+emitter）
  }>;

  /** 状态查询：只认统一四态，附桥原生进度原文 */
  status(transferId: string): Promise<{
    state: 'Initiated' | 'InFlight' | 'Completed' | 'Failed';
    dstTxHash?: string;      // 目标链放行交易（Completed 时必填）
    receivedAmount?: bigint; // 实际到账净额（Completed 时必填）
    raw?: unknown;           // 桥原生状态（如 LayerZeroScan / CCIP explorer 返回）
  }>;
}
```

链上侧约定（每座桥一份适配合约或复用同一桥合约的传输实现）：

- 锁定/解锁模型不变：源链桥锁定 `amount`，桥费 `bridgeFee` 留源桥，
  目标链桥从预存流动性中放行 `amount - bridgeFee`。
- 每笔转账有全局逻辑主键 `(srcEid/chainId, transferId)`；目标侧以此去重，
  **任何桥的重复投递都不得二次放行**。
- 发送/完成两侧都落账：源侧 `Pending → （目标确认后由状态服务回填）`，
  目标侧放行即记 `Completed`（含 messageId 反查表）。

## 3. 三座桥的元数据（前端展示口径）

| 桥 | id | 安全模型标签 | 费用口径（ETH↔Base 向，调研值） | 预估时延 | 状态 |
|---|---|---|---|---|---|
| LayerZero V2 | `layerzero` | 「DVN 多签验证（应用自选验证者集）」——**当前测试网部署为 1-of-1（仅 LayerZero Labs DVN），见 §5 如实标注**；主网目标 ≥2 独立 DVN | 按消息动态报价（DVN+执行者费，源链原生币付） | 约 1–15 分钟（源链确认数 + DVN 签名） | ✅ 首个实现（M2a） |
| Chainlink CCIP | `ccip` | 「Chainlink 预言机网络共识（全网统一验证者集，零事故记录）」 | 固定价：ETH→Base $0.50 / Base→ETH $1.50（调研值）；第十九轮实测 10 wTKA Sepolia→Base Sepolia 为 0.0002274 ETH | 约 10–20 分钟（实测约 20 分钟） | ✅ 已接入（M2b，第十九轮） |
| Wormhole | `wormhole` | 「19 Guardian 多签（协议费为零）」 | 协议费 0；测试网 messageFee 实测 0，自动中继在测试网不保证（实测需手动投递） | 约 5–20 分钟出 VAA，投递另计 | ✅ 已接入（M2c，第十九轮） |

## 4. 防重放与失败语义（所有桥共同）

- **防重放**：以桥原生的消息唯一性为第一道（LZ 的 guid/nonce、CCIP 的
  messageId+序号、Wormhole 的 emitter+sequence），Bit100 目标侧
  `(srcChain, transferId)` 去重表为第二道；两道都过才放行。
- **禁止时间戳过期校验**：跨链投递时延不可控（分钟到数十分钟），
  任何「消息太旧就拒收」的逻辑都会误杀真实投递——M2a 已从 LZ 桥删除
  原 5 分钟过期校验，防重放只依赖上述两道唯一性机制。
- **重试**：源侧提供受控重试（原发起人/owner、次数与间隔受限），
  以**同一 transferId、新的 messageId** 重发；目标侧去重保证先到者放行、
  后到者被拒，不会双重到账。重试的额外协议费由重试发起人承担。
- **失败**：消息费已付但投递失败时资产仍锁定在源桥，不自动退回；
  由状态服务标记 `Failed` 并走人工/治理解锁流程（M3 再细化）。

## 5. LayerZero 实现现状（如实记录，2026-11-07）

- 桥合约 `contracts/src/CrossChainBridge.sol` 已换到官方 OApp 底座
  （vendored `@layerzerolabs/oapp-evm` 0.4.1 + protocol/messagelib v2 3.0.168），
  双链部署 + setPeer 互信 + 代币映射/桥费/流动性就绪，并已跑通一笔真实
  Sepolia → Base Sepolia 到账；全量记录见 `docs/bridge-deployment-2026-11-07.md`。
- **DVN 现状（安全短板，明说）**：两条测试网的生效配置经链上 `getConfig`
  读回，均为 LayerZero **默认配置 = 仅 LayerZero Labs 一家 DVN 必需**
  （requiredDVNCount=1）——正是 KelpDAO 事故（1-of-1 DVN + 基础设施被攻破，
  约 $292M）的同款形态，**不满足**本项目「required DVN ≥ 2」的硬前提。
  原因：测试网侧第二家 DVN（Google Cloud）被生产项目实测为证明不可靠、
  要求它会卡住投递路线，其余运营商未在 Sepolia/Base Sepolia 公开可用的
  测试网 DVN 地址。本轮**没有**假装配出多 DVN。
- **主网前置条件（硬性）**：上主网前必须用 `contracts/script/ConfigureDvns.s.sol`
  把两条方向的发送+接收 ULN 配置都设为 ≥2 家独立运营商
  （候选：LayerZero Labs + Google Cloud + Nethermind，主网地址以
  LayerZero 官方 DVN 部署表为准），并以 `getConfig` 读回存档后才允许开放桥。

## 6. 第十九轮实现状态（2026-11-07，CCIP + Wormhole 接入完成）

全量记录见 `docs/round19-three-bridges-2026-11-07.md`，此处只记与本规格的对应关系：

- **统一接口落地形态**：本轮的 quote/initiate/status 落在前端桥页与官方组件上，
  未另建后端抽象服务——quote 分别走各桥官方只读接口（LZ `quoteBridgeFee`、
  CCIP Router `getFee`、Wormhole 核心桥 `messageFee`），initiate 路由到各桥官方
  入口（LZ 桥合约 `bridgeToken`、CCIP Router `ccipSend`、NTT Manager `transfer`），
  status 以桥原生查询页/状态机呈现（LayerZeroScan 口径的合约状态轮询、
  ccip.chain.link 消息页、WormholeScan + VAA）。统一四态状态服务仍待后续轮次
  在节点侧补齐，本轮前端状态文案与四态语义保持一致，不另造口径。
- **载体代币**：CCIP 与 Wormhole 以 wTKA（WrappedTKA，1:1 包装 TKA 的胶水代币）
  为载体——现行 TKA 缺两家官方流程要求的接口（CCIP 注册钩子、burn/mint），
  详见 round-19 文档 §2/§3。wTKA 的跨链铸造与本地 wrap 储备是两套供给，
  目标链赎回依赖本地储备（round-19 文档 §6 如实记录）。
- **防重放**：三家均以桥原生唯一性为第一道并实测/读回——LZ guid（第十六轮已验）、
  CCIP messageId 状态机、Wormhole emitter+sequence（复投实测 revert
  `TransferAlreadyCompleted`）。目标侧统一去重表仍属节点侧后续工作。
- **费用/风险展示**：已按「确认前摊开」落地（round-19 文档 §7）：不预选桥、
  卡片实时报价 + 时效预估 + 安全标签 + 可展开风险、确认弹窗复述。
- **DVN 状态不变**：§5 的 1-of-1 现状与主网硬门禁在本轮后继续有效。
