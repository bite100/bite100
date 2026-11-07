# 第十九轮：三桥选择（LayerZero + Chainlink CCIP + Wormhole）— 2026-11-07

## 1. 结论摘要

- 三桥并列落地：既有 LayerZero 通道保持可用、配置未被扰动（peer/报价读回回归通过），
  新增 Chainlink CCIP 与 Wormhole（NTT）双通道，双链（Sepolia ↔ Base Sepolia）均完成
  部署、注册、互联配置与各一笔真实 10 TKA 跨链到账 E2E。
- 桥页上线交易者自选：不预选任何桥；每家在点选前即展示实时报价（费用资产与扣除方式）、
  预计时效（标注预估）、安全模型与具体风险点；确认弹窗复述费用/时效/风险与不可撤销声明。
- 全程遵循「集成优先」：CCIP 用官方 BurnMintTokenPool + 官方注册流程 + 官方 sender；
  Wormhole 用官方 NTT 仓库的部署/配置脚本原样跑。自写代码只有 WrappedTKA 胶水代币与
  三个最薄配置脚本（见 §8 清单）。
- **DVN 现状单列：LayerZero 两条路径仍为 1-of-1 DVN（仅 LayerZero Labs），与第十六轮
  读回一致；主网开放该桥前必须执行多 DVN 配置并读回核实——硬门禁不变。**

## 2. 核实结论（动手前查官方文档/目录）

### CCIP
- 现行 TKA（MockERC20）无 `owner()`、无 `getCCIPAdmin()`、无 AccessControl，
  按 Chainlink《Token Issuer Guide》无法走免许可自助注册，也没有 `burn()` 供
  BurnMintTokenPool 使用——这是引入 wTKA 胶水代币的根本原因（§3）。
- 双链官方地址经 Chainlink 目录与 chainlink-local 的 RegisterData 双重核对：
  Sepolia 链选择器 16015286601757825753、Router 0x0BF3dE8c…63A59、
  TokenAdminRegistry 0x95F29FEE…7B82、RegistryModuleOwnerCustom 0xa3c796d4…31b0、
  RMN 代理 0xba3f6251…b991；Base Sepolia 选择器 10344971235874465080、
  Router 0xD3b06cEb…8a93、Registry 0x736D0bBb…0e17、RMOC 0x176ae8C6…f3f6、
  RMN 0x99360767…d807。费用可用原生 ETH 支付，未用 LINK。
- 注册流程（官方自助）：registerAdminViaGetCCIPAdmin → acceptAdminRole → setPool →
  双向 applyChainUpdates。无需 Token Manager 网页人工步骤，无需 Ren 本人账号操作。

### Wormhole
- NTT burning 模式要求代币可 `burn()`/`mint()`，且官方 FAQ 明确不支持双锁
  （lock-and-lock）——现行 TKA 不满足，同样指向 wTKA 方案；未改用 TokenBridge，
  因为 NTT 在双测试网完整可用（核心桥 Sepolia 0x4a8bc80E…1A78 / Base Sepolia
  0x79A1027a…F083，链上读回 chainId 10002/10004、messageFee 均为 0）。
- 自动中继在测试网不保证投递：本轮实测 Guardian 签名约 18 分钟出具，但 40 分钟内
  无自动投递，最终以 VAA 手动完成投递——与桥页文案的提示一致（§6）。

## 3. 胶水代币 WrappedTKA（wTKA）

- 合约 `contracts/src/WrappedTKA.sol`：OZ ERC20 + ERC20Burnable + AccessControl 薄封装。
  wrap/unwrap 与 TKA 1:1；`getCCIPAdmin()` 提供 CCIP 注册钩子；
  `grantMintAndBurnRoles()`（IBurnMintERC20 兼容）实际授予 MINTER_ROLE，
  供 CCIP 池与 NTT Manager 铸造；burn 公开（NTT burning 模式所需）。
- 测试 9/9（forge 全量 108/108 = 基线 99 + 9）。
- 部署：Sepolia 0x03ED8203236Bb5409caA6330fDCd16559C914b9a；
  Base Sepolia 0x346DE29B7fEe95F44A5b5385e87182F031E8E1B5。
  ⚠ 地址字符串巧合（引用时必须连链一起看）：Base 的 wTKA 字符串与 Sepolia 的
  FeeDistributor 相同；Base 的 CCIP 池字符串与 Sepolia 的 TKA 相同（CREATE nonce 巧合，
  已链上逐一核实合约身份）。

## 4. 三桥地址总表（均为测试网）

| 通道 | 组件 | Sepolia | Base Sepolia |
|---|---|---|---|
| LayerZero | 桥合约（第十六轮，未动） | 0x7a0eCbc2Ffca2F8f7A1505Fa65e7E4759bE33d50 | 0xA7722A0ba7F2DA1d4D67D5191222C5e4c3835dBB |
| CCIP | Router（官方） | 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59 | 0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93 |
| CCIP | wTKA BurnMintTokenPool（官方合约） | 0x68Bf313360021DcF4E359aD18c4506f622A3666d | 0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E |
| Wormhole | 核心桥（官方） | 0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78 | 0x79A1027a6A159502049F10906D333EC57E95F083 |
| Wormhole | NTT Manager（官方） | 0x5a6Da05af0d9eF61BA85f610556357bEb1DC57D1 | 0x9E45CCB3A5fef0E72bB8e97450b7FcF97EFC4d72 |
| Wormhole | WormholeTransceiver（官方） | 0x1bFb42E93F5860C76ef0E100E063083357b93C8A | 0x74da43aF57134AFa610ADB8fdA1031594b9a494f |
| 载体 | wTKA（胶水） | 0x03ED8203236Bb5409caA6330fDCd16559C914b9a | 0x346DE29B7fEe95F44A5b5385e87182F031E8E1B5 |

## 5. 配置读回

- CCIP：双链 TokenAdminRegistry.getPool(wTKA) 均读回上表池地址；双向
  applyChainUpdates 后 getRemoteToken/getRemotePools 读回对端 wTKA 与池地址无误。
  限额（测试规模，写入配置脚本 `scripts/round19/Bit100ConfigureWTKAPool.s.sol`）：
  双向启用 RateLimiter，桶容量 100,000 wTKA、回填 1,000 wTKA/秒；
  已被 §6 的真实转账验证放行（限额状态 getter 在 CCIP 2.0 签名变更，未单独读回，如实标注）。
  池字节码经优化器构建为 19,601 字节（≤ EIP-170 上限，主网可移植）；
  首个未优化 Sepolia 池（33,724 字节，靠测试网节点未强制上限才部署成功）已弃用，
  其在 wTKA 上的铸造角色已撤销（tx 0xc1b68375…589b），地址 0xF1A6D8Fd…84156f 留档为孤儿部署。
- Wormhole：双侧 NttManager.getPeer 读回对端 Manager 地址 + decimals 18；
  双侧 Manager 均已获 wTKA 的 MINTER_ROLE（grantMintAndBurnRoles 链上成功）；
  Transceiver peer 双向已注册（官方 Configure 脚本）。模式 burning、一致性等级 15
  （finalized）、阈值 1（单个 Wormhole Transceiver）。Sepolia 另有两套未定版 NTT
  （0x8170f15b…/0x203aDBD8… 与 0x53D4b0DC…/0x92C37E88…）为尺寸迭代的孤儿部署，
  未授角色、未配 peer，不被引用。
- LayerZero 回归：双向 peers() 读回互指对方桥地址；quoteBridgeFee 对 10 TKA
  实时报价 0.000104 ETH 正常返回——通道未被本轮改动扰动。

## 6. E2E 证据（各一笔 10 TKA，Sepolia → Base Sepolia）

发送前：Sepolia wrap 20 TKA → 20 wTKA（部署者）；Base 侧部署者 wTKA 0、TKA 999,009.9。

### CCIP
- 发送 tx 0x64ef4e1c41e120ef204ebaab3379509e037866ce779a7914c4b0bf55e0ffc64b，
  2026-11-07T11:00:43Z；messageId 0x79c6152e03d2f48bde9ba984227dd3475aa650b0e531f2d4bd1b4825d9e4e861。
- 费用实付 0.0002274 ETH（原生 ETH，发送前报价锁定；约合固定价口径 $0.50 同量级）。
- 到账：Base wTKA 在 11:19:53Z 轮询仍为 0、11:20:54Z 轮询为 10 → 约 20 分钟内自动投递完成。
- 防重放：CCIP 以 messageId + 序号在 OffRamp 维护消息状态机，Success 为终态，
  同一消息不可二次执行（协议原生机制）。

### Wormhole
- 发送 tx 0x80d88e74606514510924b12b6a465c12d2f58265dd6dcd7a747764216c3fd2a5，
  2026-11-07T11:02:56Z；emitter 为 Sepolia Transceiver，sequence 2（0/1 号已被
  配置阶段的 peer 注册消息占用），messageFee 实付 0。
- Guardian 签名（VAA）约 18 分钟后可查（wormholescan testnet API 核实）；
  测试网 40 分钟内无自动投递，按预期手动完成：12:02:12Z 以 VAA 调用 Base
  Transceiver.receiveMessage，tx 0x7edae789c8452c0ff495b6bbbc48319bae4d2897e0143cd6d930e80ebec9258a，
  Base wTKA +10（铸造日志核实）。
- 防重放：同一 VAA 复投 revert `TransferAlreadyCompleted(0x201de9ff…)`
  ——emitter+sequence 唯一性由目标侧 Transceiver/Manager 原生强制，实测有效。

### 对账与 unwrap
- 收尾：Sepolia wTKA 总供应 0（20 全部经两桥销毁）；Sepolia 部署者 TKA 998,970
  （20 锁在 Sepolia wTKA 储备中）；Base 部署者 wTKA 20（两桥到账）；账目守恒。
- unwrap 性质（如实记录）：桥铸造的 wTKA 与本地 wrap 储备是两套供给——目标链
  wTKA 合约初始 TKA 储备为 0，直接 unwrap 会因储备不足 revert（实测
  ERC20InsufficientBalance）。本轮以部署者在 Base wrap 20 TKA 注入本地储备后
  unwrap 20 成功验证赎回路径（Base TKA 收尾回到 999,009.9）。
  含义：wTKA 在任一链的赎回依赖该链本地储备；这是测试网胶水层的已知性质。
  主网若代币本身带 CCIP/NTT 钩子则不需要 wTKA 这一层（见 §9）。

## 7. 前端桥页（费用与风险在确认前摊开）

文件：`frontend/src/components/CrossChainBridge.tsx`、`frontend/src/config/chains.ts`。

- 选择器：三张桥卡片，`selectedBridge` 初始为空——不预选任何一家，更不预选
  风险最高的 LayerZero；未选桥时发起按钮不可用并有文字提示。
- 每张卡在点选前展示：实时报价（LZ 走 quoteBridgeFee、CCIP 走 Router getFee、
  Wormhole 读 messageFee；含「用什么资产付、从哪扣」）、预计时效（标注为预估）、
  安全模型一句话、`<details>` 展开的风险点（客户语言，细节收进展开区）：
  - LayerZero：明示 1-of-1 单一验证方及其含义、KelpDAO 约 $292M 先例与本配置的关系、
    主网多 DVN 硬门禁、测试网大额勿用。
  - CCIP：明示 Chainlink DON + 风险管理网络（RMN）双层验证、费用发送前锁定不补差价、
    池限额为测试规模。
  - Wormhole：明示 19 个 Guardian 13-of-19 签名、2022 年 Solana 侧验签事故与本次
    EVM NTT 非同一组件的区别、手动完成投递的可能。
- 确认弹窗：复述所选桥、金额、费用、时效、安全模型、第一条风险点，并固定声明
  「跨链转账不可撤销、异常时可能需人工完成投递、不要重复发送」；CCIP/Wormhole
  另复述 wTKA 1:1 转换。用户点「确认发起」后才执行。
- 执行路由：LZ 既有桥合约逻辑不变；CCIP 官方 Router ccipSend（先 staticCall 取
  messageId 再实发，状态区给 ccip.chain.link 查询链接）；Wormhole 官方 NTT
  Manager transfer（状态区给 WormholeScan 链接与 VAA 手动投递指引）。
  CCIP/Wormhole 发起时自动把 TKA 按 1:1 wrap 补差额，页面与弹窗均有说明。
- 说明文字按站内立规矩补齐：三桥区别、怎么选、操作步骤、注意事项都在页面上，
  新用户只看页面即可操作。
- chains.ts：双测试网新增 wrappedToken、ccip{router, tokenPool, chainSelector(字符串),
  tokenAdminRegistry}、wormhole{coreBridge, nttManager, nttTransceiver, wormholeChainId}；
  主网配置不写 CCIP/Wormhole（未部署不伪造），桥页对不可用组合有明确标记。

## 8. 官方组件原样 vs 自写胶水（集成优先专节）

官方组件原样接入（未改源码）：
- CCIP：官方 BurnMintTokenPool 合约本体、Router、TokenAdminRegistry、
  RegistryModuleOwnerCustom 注册流程、官方 starter kit 的 sender
  （SendCCTTokenWithExtraArgsV3DefaultFinality）完成 E2E 发送。
- Wormhole：官方 NTT 仓库 DeployWormholeNtt / ConfigureWormholeNtt 脚本原样运行
  （仅以环境变量与官方 cfg JSON 喂参；部署用其仓库自带 prod profile 的 via_ir 构建，
  解决默认构建 27,568 字节超 EIP-170 的问题——这是用官方生产配置，未改合约）。
- LayerZero：第十六轮官方 OApp 底座，本轮未动。

自写胶水（均为最薄层，附原因）：
- WrappedTKA（§3）：现行 TKA 缺 CCIP 注册钩子与 burn/mint 接口，两家官方流程都
  接不进去；用 OZ 标准件补接口的唯一办法就是这层 1:1 包装。代币若 natively 支持
  两家钩子，此层可整层删除。
- Bit100DeployWTKAPool / Bit100RedeployWTKAPool（scripts/round19/）：官方 Example06
  会顺带发一个新代币，我们已有 wTKA，只需「部署官方池 + 授角色 + 注册」三步，
  故按 Example06 同形状裁剪；Redeploy 变体是因已注册代币重复注册会 revert 而拆出的
  「只换池」版本。
- Bit100ConfigureWTKAPool（scripts/round19/）：与官方 Example06 的 applyChainUpdates
  同形状，只把限额从「关闭」改为测试规模启用值——限额口径是产品决策，不属官方默认。
- 前端 CCIP extraArgs 常量：V3 基本编码（tag 0xa69dd4aa + gasLimit 0 + 默认最终性），
  与官方 EncodeExtraArgsOffchain.encodeV3Basic(0) 逐字节一致，前端无法引用 Solidity
  库，只能以常量复现。

## 9. 花销与余额

- 部署钱包 0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e（未换钱包）。
- 开工基线（任务书）：Sepolia ≈0.049995 ETH、Base Sepolia ≈0.009794 ETH。
- 收工：Sepolia 0.049764 ETH、Base Sepolia 0.009697 ETH。
- 本轮花费约 Sepolia 0.000231 ETH（大头为 CCIP E2E 费用 0.0002274 ETH，其余为
  显式 legacy 0.003 gwei 下的部署/配置交易）+ Base Sepolia 约 0.000097 ETH。
- 未领 LINK（CCIP 费用全程原生 ETH）；未领任何新测试币。

## 10. 门禁结果

- forge test：108/108 通过（基线 99 + WrappedTKA 9，只升不降）。
- npm test：101/101 通过（基线 97 + 新增 4 例 chains 三桥配置断言，清单见提交说明）。
- 前端构建成功；产物 grep 命中三桥双链地址（LZ 桥 ×2、CCIP 池 ×2、NTT Manager ×2、
  wTKA ×2）与双链 Settlement 地址。
- Go 节点未动。金库（Vault）相关代码未动（第十八轮暂停状态不变）。
- 本轮提交（本地，未 push）：104b68e（wTKA）、8455f41（前端选择器）、本文件所在提交。

## 11. 存疑与后续

- CCIP 限额状态 getter 在 2.0 签名变更，限额值以配置脚本 + 真实转账放行为据，
  未做单独读回；如需审计级证据，可后续按新 ABI 补读。
- Wormhole 测试网自动中继缺位已实测确认：主网使用前需接入 Executor/自动中继
  服务或保留手动投递兜底流程（产品决策项）。
- wTKA 储备性质（§6）决定了它只适合测试网阶段；主网代币方案（原生钩子代币 vs
  继续 wTKA + 储备管理）需在主网部署轮次单独拍板。
- **LayerZero DVN 仍为 1-of-1（单列重申）：主网开放该桥前必须先执行多 DVN 配置
  并 getConfig 读回，此门禁不因本轮新增两桥而改变。**
