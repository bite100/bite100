---
name: fee-governance
description: 手续费分配、FeeDistributor、Governance 治理、提案与投票。修改分成比例、recipients 或治理流程时，需同步合约、前端与文档。Use when editing FeeDistributor, Governance, or proposal/voting logic.
---

# 手续费与治理

## 不可变约束（优化时勿破坏）

1. **FeeDistributor 开发者 1%**：DEVELOPER_SHARE_BPS=100，receiveFee 时 1% 自动转 developerAddress，99% 进入分配池。
2. **recipients 总比例 ≤ 99%**：setRecipients 时 shareBps 总和 ≤ 9500（10000 - 100）。
3. **Governance 提案**：投票期、执行延迟（Timelock）、提案类型扩展需与概念文档一致。
4. **经济模型**：撮合 40%、存储 25%、中继 15%、团队 15%、治理 5%（概念文档）。

## 代码位置

| 组件 | 路径 |
|------|------|
| FeeDistributor | contracts/src/FeeDistributor.sol |
| Governance | contracts/src/Governance.sol |
| 前端 | frontend/src/（GovernanceSection、FeeDisplay） |

## 相关文档

- docs/概念设计文档.md
- docs/API-接口说明.md
- docs/DAO扩展设计.md、DAO扩展实现指南.md

## 优化注意

- 改开发者比例需同步合约常量与文档。
- 治理提案执行前需 Timelock，勿跳过延迟。

## 新手友好（投票与提案）

- **投票**：提案用人话说明（如「调整手续费比例」）；投票入口醒目；大按钮「支持/反对」；签名时提示「确认即完成投票」。勿暴露提案 ID、合约地址等。
- **提案**：模板式提案（调手续费、新增接收方等）；引导式表单填空；提交前一句人话预览；隐藏 calldata、目标合约等技术细节。
