---
name: amm-swap
description: AMM 池、Swap、流动性。修改 AMMPool 接口、恒定乘积公式或 reserve 逻辑时，需同步前端 Swap 组件与合约 ABI。Use when editing AMM pool, swap, or liquidity logic.
---

# AMM 池与 Swap

## 不可变约束（优化时勿破坏）

1. **恒定乘积**：x * y = k，getAmountOut 与 swap 实现需一致。
2. **手续费**：平台费（如 0.01%）进入 FeeDistributor，比例与概念文档一致。
3. **reserve0/reserve1**：与 token0/token1 顺序一致，前端与合约需对齐。
4. **添加流动性**：按比例添加，前端需正确计算 amount0/amount1。

## 代码位置

| 组件 | 路径 |
|------|------|
| 合约 | contracts/src/AMMPool.sol |
| 前端 | frontend/src/（Swap 相关、LiquidityPoolInfo） |

## 相关文档

- docs/API-接口说明.md
- docs/流动性补充与治理执行指南.md

## 优化注意

- 改手续费比例需同步 FeeDistributor、前端 FeeDisplay。
- 勿引入非恒定乘积公式（如混合曲线）除非有设计文档支持。

## 新手友好

- Swap：选币→填数量→点兑换；类似 Uniswap 的简单界面；内部自动处理授权、存入 Vault 等。
