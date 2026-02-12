---
name: build-then-push
description: 推送或部署前必须先通过前端构建；构建失败则不推送。Run frontend build (npm run build in frontend) before git push; only push if build succeeds. Use when user asks to push, deploy, or 推送/部署.
---

# 构建成功再推送

## 原则

**先构建，再推送**：任何涉及「推送」「部署」「push」「deploy」的操作，必须先在本仓库内执行前端构建并确保成功，再执行 `git push`。构建失败时不得推送，应先修复错误。

## 流程

1. **执行前端构建**
   - 在项目根目录或 frontend 目录执行：
     - `cd frontend; npm run build`（或 `npm run build`，且 package.json 的 build 为 `tsc -b && vite build`）
   - 使用 PowerShell 时用分号连接命令：`cd d:\P2P\frontend; npm run build`

2. **根据结果分支**
   - **构建成功**：再执行 `git add`、`git commit`（如有变更）、`git push`。
   - **构建失败**：根据终端报错修复（常见为 TS 类型错误、未使用变量、缺少导入等），修复后重新执行步骤 1，直到构建成功再推送。

3. **推送前不再额外跑构建**
   - 若本次对话中已成功跑过 `npm run build`，且之后未再改前端或 TS 配置，可直接推送，无需重复构建。

## 构建命令速查

| 环境     | 命令 |
|----------|------|
| 项目根   | `cd frontend; npm run build` |
| 已在 frontend | `npm run build` |

## 注意

- 构建指 **前端** 的 `tsc -b && vite build`；若后续增加节点/合约的 CI 检查，也应在推送前通过。
- 本技能在用户说「推送」「push」「部署」「deploy」或「构建成功再推送」时适用。
