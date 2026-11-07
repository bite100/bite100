# P0-3 本地 anvil 端到端验证记录

> 目的：证明「节点撮合 → 真实上链结算」链路在本地链完整跑通。
> 范围：**只连本地 anvil（127.0.0.1:8545，chainId 31337）**，未访问 Sepolia 或任何外部网络，未改动线上合约/配置。
> 日期：2026-11-07。实现：`node/internal/settlement/submit.go`（真实提交，go-ethereum）、`node/internal/settlement/e2e_anvil_test.go`。

## 运行命令

```bash
bash scripts/anvil-e2e.sh
# 内部步骤：forge build → anvil --port 8545 → BIT100_ANVIL_RPC=http://127.0.0.1:8545 \
#   go test ./node/internal/settlement/ -run TestAnvilE2E -v -count=1
```

## 链路步骤（测试内自动完成）

1. 部署 MockERC20×2（TKA/TKB）、Vault、FeeDistributor、Settlement（owner = anvil 账户 #0 `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`），Vault.setSettlement 绑定。
2. 生成 maker/taker 密钥，owner 各转 1 ETH；maker 向 Vault 存入 100 TKA，taker 存入 200 TKB。
3. 以统一规范（`docs/eip712-order-spec.md`）签名订单：maker 卖单、taker 买单，价 2e18、量 100e18、nonce 0（域 chainId=31337、verifyingContract=本地 Settlement）。
4. 撮合引擎 Match 得 1 笔成交；`SubmitTrade` 组装 Fill 并真实提交 `Settlement.settleTrade`。
5. 链上断言 Vault 余额/手续费/nonce，并对同一成交再次提交验证重放被拒。

## 本次运行证据

部署地址：

| 合约 | 地址 |
|---|---|
| TokenA (TKA) | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| TokenB (TKB) | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| Vault | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |
| FeeDistributor | `0x5FC8d32690cc91D4c39d9d3abcBD16989F875707` |
| Settlement | `0x0165878A594ca255338adfa4d48449f69242Eb8F` |

- 结算 tx hash：`0xf9374b25f9c538c4dce7a921f081e23b37f665651837bd7dae1eeae4f5baacba`（receipt 成功）
- 断言结果（全部 OK，费率 0.01% 双边）：
  - maker TKA in vault = 0（100 全部卖出）
  - maker TKB in vault = 199980000000000000000（收到 200 − 0.02 手续费）
  - taker TKB in vault = 0（200 全部付出）
  - taker TKA in vault = 99990000000000000000（收到 100 − 0.01 手续费）
  - feeDistributor TKA = 10000000000000000、TKB = 20000000000000000
  - maker nonce = 1、taker nonce = 1（双方订单 nonce 均已消耗）
- 重放验证：同一成交再次提交被链上拒绝 —— `execution reverted: Settlement: fill exceeds signed order`（按订单 digest 的累计记账拦截）。
- 测试结论：`--- PASS: TestAnvilE2E (13.10s)`。

## 复现

在本机执行 `bash scripts/anvil-e2e.sh` 即可（需要 Foundry 与 Go 工具链）；部署地址/tx hash 每次运行会不同，断言口径不变。
