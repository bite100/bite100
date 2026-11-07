# Bit100 Sepolia 测试网部署与结算验证记录（2026-11-07）

本轮（第三轮）将第二轮修复后的合约全套部署到 Sepolia 测试网，并用 Go 节点撮合 + `SubmitTrade`
完成真实链上结算验证。全程未 push、未改前端配置、未触碰旧线上合约（旧地址保持不变）。

## 网络与账户

- 网络：Ethereum Sepolia（chainId 11155111），RPC：`https://ethereum-sepolia.publicnode.com`
- 部署钱包：`0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e`（本轮新建的测试网专用钱包）
  - [Etherscan](https://sepolia.etherscan.io/address/0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e)
  - 水龙头注资 tx：[0x760a38fae2175ff5b52e3f64bd12f74db8aa74ed6ea403b0000ae1eb498f114c](https://sepolia.etherscan.io/tx/0x760a38fae2175ff5b52e3f64bd12f74db8aa74ed6ea403b0000ae1eb498f114c)（0.1025 ETH）
- 测试账户：maker `0xE83D2b08356cb463adFc20406a18B79991F7eE29`、taker `0x87ffF84eb917916587fA7721c843cdC3Ada957eA`

## 新部署合约（forge script Deploy.runWithAmmAndMocks）

| 合约 | 地址 | 部署 tx |
|---|---|---|
| Vault | [0xb4945C5E0208803FF11d0f86173B55489aE87d2A](https://sepolia.etherscan.io/address/0xb4945C5E0208803FF11d0f86173B55489aE87d2A) | [0xe3c252e9…b873e](https://sepolia.etherscan.io/tx/0xe3c252e91a815cda54fa0b995112395e8340e62fd083577d37b657c7b04b873e) |
| FeeDistributor | [0xfb458224973c91ddBa3Fb5B55DAD337038768b21](https://sepolia.etherscan.io/address/0xfb458224973c91ddBa3Fb5B55DAD337038768b21) | [0xc1410a73…eca2](https://sepolia.etherscan.io/tx/0xc1410a735bd0f2e5ee56bbf314288d9e3def2b31bb39ad60b31cae54fd97eca2) |
| Settlement | [0xA4Eaa449360239e1F719608236d087c23379d5A6](https://sepolia.etherscan.io/address/0xA4Eaa449360239e1F719608236d087c23379d5A6) | [0xffa3c817…c111](https://sepolia.etherscan.io/tx/0xffa3c81758b454a2dbfefdba3f8381b241243af5bee2083d8c24c12bab5bc111) |
| MockERC20 TKA (Token0) | [0x903cdDF52963D9DEA0BDF8be9159E08706683654](https://sepolia.etherscan.io/address/0x903cdDF52963D9DEA0BDF8be9159E08706683654) | [0x26cbb76a…9347](https://sepolia.etherscan.io/tx/0x26cbb76a0537451c7c906469d3edc226cb8c3b6c2f80142aeda0489504eb9347) |
| MockERC20 TKB (Token1) | [0x1Ee28c1c490727e49939C95032C749ea5b58b45f](https://sepolia.etherscan.io/address/0x1Ee28c1c490727e49939C95032C749ea5b58b45f) | [0xed94418ae…4dec](https://sepolia.etherscan.io/tx/0xed94418ae2d238ce42d3c62733da0d4c199891858a9bf5129b48b6de7bc64dec) |
| AMMPool | [0x20a78bCb39Ff510AdBa3D3AEC9229a9583C5BDB3](https://sepolia.etherscan.io/address/0x20a78bCb39Ff510AdBa3D3AEC9229a9583C5BDB3) | [0x62300dd2…ea19](https://sepolia.etherscan.io/tx/0x62300dd2ca6fd4a513593c03ec25ce54c153e78067199559d1da3e516284ea19) |

另有 3 笔部署内配置交易（Vault 绑定、FeeDistributor 开发者地址与接收方设置），见本地
`contracts/broadcast/Deploy.s.sol/11155111/runWithAmmAndMocks-latest.json`（该目录被 .gitignore 排除，未入库）。

配置要点（沿用部署脚本）：FeeDistributor 开发者 = 部署钱包，手续费 1% 自动转开发者、
99% 进分配池（接收方 = 部署钱包，shareBps 9900）；Settlement 费率 1bp 双边。

## 结算验证（node/internal/settlement/e2e_sepolia_test.go）

流程：部署者给 maker/taker 注 gas（各 0.01 ETH）与测试币 → maker 存 100 TKA、taker 存 200 TKB 进
Vault → 按 `docs/eip712-order-spec.md`（chainId 11155111）双边 EIP-712 签名（maker 卖 100 TKA @ 2
TKB/TKA，taker 全额吃单）→ 节点撮合 1 笔 → `SubmitTrade` 经部署者提交 `settleTrade`（合约侧验签）
→ 断言 → 同一成交重放。

共完成 **3 笔真实结算**（测试迭代期间各跑一笔）：

| # | 结算 tx | nonce 变化 | 结果 |
|---|---|---|---|
| 1 | [0xbc2108a9…36d5](https://sepolia.etherscan.io/tx/0xbc2108a9d93c22630478a76900794f90c68dc21d937ae3c59dd6574fb5bc36d5) | 0 → 1 | 核心断言通过（手续费断言按旧口径，后经复核为部署配置差异，见下） |
| 2 | [0x5ec35f5e…8c5](https://sepolia.etherscan.io/tx/0x5ec35f5e6cf8f1d407c78e747c605663e9499411c380bb3c2ce24c06970f18c5) | 1 → 2 | 链上最终状态经逐项复核全部正确（测试内 2 项读数被公共 RPC 旧状态误报） |
| 3 | [0xffdd9301…df75](https://sepolia.etherscan.io/tx/0xffdd930182893be5c5600bd9d845c08085c9e00b9d01cda0bc1a078d413bdf75) | 2 → 3 | **全量 PASS：10/10 断言一次收敛 + 重放被拒** |

每笔断言（增量口径，均通过）：

- maker Vault：TKA −100、TKB +199.98
- taker Vault：TKB −200、TKA +99.99
- FeeDistributor：TKA +0.0099、TKB +0.0198（名义手续费 0.01 / 0.02 的 99%）
- 开发者（部署钱包）：TKA +0.0001、TKB +0.0002（手续费 1% 自动转）
- maker / taker 结算 nonce 各 +1
- 重放同一成交：链上拒绝，`Settlement: fill exceeds signed order`

注资 tx（第 1 笔结算前）：maker [0x355ab925…88ae](https://sepolia.etherscan.io/tx/0x355ab925f15c60f2abda73a96d4b9b6b026d158cd55ee5a63b653250757988ae)、
taker [0x521c9f09…df0](https://sepolia.etherscan.io/tx/0x521c9f09df7a2b6eebbb61049e77b7f7ce043561d8f4ddfb83723bb9810afdf0)。

## 本轮对测试做的三处适配（均已写入测试注释）

1. **注资 gas limit 21000 → 500000 并校验回执状态**：经 publicnode 的 Sepolia 入口 gas 计量
   非标准——给新地址的普通 ETH 转账实测消耗约 204600 gas（水龙头注资 tx 同口径），
   21000 必定 OOG 且回执 status=0；原测试未查回执状态，前两跑因此误判已注资、
   在 approve 处报 `gas required exceeds allowance (0)`。
2. **手续费断言改按部署配置口径**：anvil 版未给 FeeDistributor 设开发者地址（FD 留存 100%），
   forge 部署脚本设了 developer=deployer，`receiveFee` 按合约设计先转 1% 给开发者、
   FD 留 99%。断言据此拆分 FD 增量（99%）与开发者钱包增量（1%）。
3. **断言改为增量口径 + 轮询收敛**：增量口径使测试可重复运行（每跑一笔新结算）；
   公共 RPC 多后端状态传播有延迟，个别 `eth_call` 可短暂读到旧状态，断言轮询至
   全部收敛或超时（第 3 笔第 1 轮即收敛）。

## 遗留与说明

- 本次为全新部署，新合约地址与旧线上地址不同；前端仍指向旧地址，本轮未切换（待 Ren 决定）。
- publicnode 免费入口的 gas 计量与状态传播特性如上，生产化验证建议换专用 RPC。
- 部署钱包与测试账户均为测试网专用，私钥不在本仓库内。

## 第四轮追加（2026-11-07）：开发者分成方案 B——1% 改治理可调（上限 5%）

Ren 拍板：将 FeeDistributor 写死的开发者分成（原常量 `DEVELOPER_SHARE_BPS = 100`，注释「永久 1%」）
改为治理可调，保留默认 1%，硬上限 5%。

### 合约改动（contracts/src/FeeDistributor.sol）

- 常量 `DEVELOPER_SHARE_BPS` 改为状态变量 `developerShareBps`（默认 100），另加硬上限常量
  `MAX_DEVELOPER_SHARE_BPS = 500`。
- 新增 `setDeveloperShareBps(uint16)`：仅 owner 或 governance 可调用，超过 500 时 revert
  （`FeeDistributor: share too high`），变更发事件 `DeveloperShareSet(oldBps, newBps)`。
- `receiveFee` 与 `setRecipients` 的上限计算改读该变量；顺带修正了头部注释中误写的「5%」字样。
- 测试：新增 7 个用例（默认值、3% 分成、0%、500 边界、501 revert、未授权 revert、governance 可调），
  forge test **69/69 全绿**（此前基线 62/62）。

### 新 FeeDistributor 部署与配置

| 项目 | 值 / tx |
|---|---|
| 新 FeeDistributor | [0xB63a3D858E5230233e4D1B76052387C2274d6e3A](https://sepolia.etherscan.io/address/0xB63a3D858E5230233e4D1B76052387C2274d6e3A) |
| 部署 tx | [0x1e451d4f…ff90d](https://sepolia.etherscan.io/tx/0x1e451d4fa52f26cf59aa246633c6697beb62faf8b7118ee4f73570835e4ff90d) |
| setDeveloperAddress → Ren 钱包 `0x047df18eF5484945D33fBddB8D58D382597354d9` | [0x6643caac…337f](https://sepolia.etherscan.io/tx/0x6643caacc88364f3c37e487948c076d7bcac768cca067d9493dafcc89d70337f) |
| setRecipients（复制旧配置：部署钱包 9900） | [0x822814cb…9388](https://sepolia.etherscan.io/tx/0x822814cba566aa4342f2b126f5104dbf980ae760576f7e828754a10ec1399388) |

旧 FD 的 governance 为零地址（未设），新 FD 同样未设，无需复制。链上读回确认：
developer = Ren 地址、developerShareBps = 100（默认 1%）、totalShareBps = 9900。

### 链上验证（逐项）

- **可调性**：owner 调 `setDeveloperShareBps(200)` 成功（tx
  [0x27295caa…23e1](https://sepolia.etherscan.io/tx/0x27295caa7348239effb21bb02fc9a437c27f03cf79688a6380a367a432e223e1)，
  读回 200），再调回 100（tx
  [0x31dd21b5…7a17](https://sepolia.etherscan.io/tx/0x31dd21b52d5777bd547fbd056732aa41af6fd91902e89a66c26a4077a17b1c7a)，
  读回 100）；调 501 在链上直接 revert（`FeeDistributor: share too high`）。
- **新 FD 分账**：部署钱包授权并直接调用新 FD 的 `receiveFee(TKA, 100)`（tx
  [0x41cc21ec…53c8](https://sepolia.etherscan.io/tx/0x41cc21ec98486b6c61aa283502b8441c1ba87e8bc5209b38e07cb3b8e9653c8d)）：
  Ren 地址 TKA 0 → **1**（1% 自动到账），新 FD 留存 **99** TKA、accumulated = 99 TKA，与 99/1 口径一致。
- **AMMPool 已切换**：`setFeeDistributor(新 FD)` 成功（tx
  [0xc3263070…0309](https://sepolia.etherscan.io/tx/0xc32630709913b22bf0f2de5951a6abf29434691973c033e007d7415bce369030)），
  读回 AMMPool.feeDistributor = 新 FD。AMM 路径的手续费自此进入新 FD。
- **Settlement 未能切换（阻塞项）**：Settlement 的 `feeDistributor` 仅在构造函数中设定，
  **合约没有 setter**，无法在不重部署 Settlement 的前提下指向新 FD。按任务约束本轮未擅自重部署，
  Settlement 路径的手续费目前仍进入旧 FD `0xfb458224…768b21`（其 developer 仍为部署钱包）。
  因此本轮没有重跑 Settlement 的 e2e 结算来验证新 FD（跑了也只会进旧 FD）；新 FD 的分账改用
  上面的 `receiveFee` 直调完成等效验证。若要全量切换，需 Ren 批准重部署 Settlement
  （并连带处理 Vault/节点对 Settlement 地址的引用）。
