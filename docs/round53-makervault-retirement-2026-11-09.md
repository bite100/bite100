# 第 53 轮：做市金库（MakerVault）产品退役 + 第 52 轮复审 2 条 P2 顺带修复（2026-11-09）

> 状态：分支 `round53-makervault-retirement` 本地提交（基线 main `45f4fa6`），未推送、未合并、未部署；**contracts/ 零改动**、零新依赖。
> 决策来源：Ren 2026-11-09 15:53 拍板「退役产品、保留代码」。研究依据（主聊天核实）：双链实例 totalAssets/totalSupply 均为 0、从未注资使用；无生产链路依赖（Settlement 仅注释提及，验签为通用 ERC-1271，合约钱包支持不受影响）；资产页卡片因 NAV 绑喂价、喂价过期即失败关闭，长期显示「读数不可用」。gas 库为唯一保留的金库产品线。

## 1. 链上处置（本轮之前已由主聊天完成，本轮只记录）

- Sepolia MakerVault `0x5473D7c58c56BCd855c6f2048614A10e9645F7f0` 已置暂停：pause tx `0x8d8bacca6efad21bd7e50b6a97c298f2af8a8a9ee5574ac8e42ea1c1f59b1d98`（paused=true 链上回读核实，块 12095872）。
- Base Sepolia MakerVault `0x66F43601e4ef88ba38F8AeDDe9D2b0F949427D31` 已置暂停：pause tx `0x5a44faa3b13083cfca2b083cb0914051e1154e91517fd085a80842796679fd3c`（块 56424500）。
- 两实例均为空库（totalAssets/totalSupply = 0），无存款人、无赎回问题。暂停后新存款与签单被挡，赎回路径不受影响（本就无余额）。
- 部署地址保留在本文件备查：前端 chains.ts 的地址配置已随下线删除（见 §2 处置表），将来若重启该产品线，地址以本文件与第 47 轮部署记录为准。

## 2. 块 A：前端下线做市金库产品面

### 用户可见变化（功能变更说明）

- 资产页不再有「做市金库」卡片，快捷动作栏不再有「金库」按钮，页面顶部的「总览 / 金库」页签随金库视图取消而整体移除——资产页回到单页总览，用户再没有任何入口到达做市金库页面。
- 交易、Vault 存取、下单、撤单、跨链交付设置等其余功能一律不受影响；gas 库是此后唯一的金库产品线（另建新合约，未上线前资产页不出现任何金库入口）。

### 逐处处置表

| 位置 | 处置 | 理由 |
| --- | --- | --- |
| `components/AssetsPage.tsx` 做市金库卡片 | 删除 | 产品入口本体 |
| `components/AssetsPage.tsx` 快捷动作「金库」按钮 | 删除 | 指向金库视图的入口 |
| `components/AssetsPage.tsx` `view === 'vault'` 分支 + `AssetsView` 的 `'vault'` | 删除 | 金库视图本体与类型 |
| `components/AssetsPage.tsx` `AssetsTabs`（总览/金库页签）及两处调用 | 删除 | 仅剩「总览」一个页签后页签栏无存在意义；它是金库视图的第三个入口 |
| `components/AssetsPage.tsx` `useMakerVaultData` 调用与导入 | 删除 | 仅为金库卡/金库页供数 |
| `components/MakerVaultPage.tsx` + `MakerVaultPage.css` | 删除（整文件） | 金库页面本体，下线后无引用 |
| `components/assets/makerVaultData.ts` | 删除（整文件） | 仅被 AssetsPage 与 MakerVaultPage 引用 |
| `components/assets/makerVaultMath.ts` | 删除（整文件） | 纯 MakerVault 份额数学（NAV/可提份额/存取估算），仅被上述两文件与 valuation.test.ts 引用 |
| `components/assets/valuation.test.ts` 中 maker vault math 测试组 | 删除（3 条） | 被测函数随 makerVaultMath 删除；valuation 本体的 3 条测试保留 |
| `components/AssetsPage.css` `.assets-tabs*`、`.assets-vault-*` | 删除 | 随组件删除而孤儿化的样式 |
| `config/chains.ts` `contracts.makerVault` 字段与双链地址 | 删除 | 下线后成为死配置：全仓核查确认其唯二读者（MakerVaultPage、makerVaultData）均已删除；stage4 运行器与脚本不引用该字段。类型字段删除后若有遗漏读者会在 tsc/build 暴露（已过） |
| `config/chains.test.ts` 两条 makerVault 地址断言 | 删除 | 随配置字段删除 |
| `services/dualread/chainState.ts:14` 注释「MakerVault 等 ERC-1271 合约签名者的兜底」 | **保留原文** | 这是通用 ERC-1271 合约钱包验签语义（Settlement.verifyOrderSignature 补查路径），MakerVault 只是举例（「等」）；退役的是产品，不是合约钱包支持。逻辑零改动 |
| `services/hardCancel.ts:42` 注释 | 注释级微调 | 原文把 MakerVaultPage 列为 tx.wait() 写法的同写参照，页面删除后该参照失效，仅删去该名字；逻辑与 ERC-1271 语义零改动 |
| `relay/`（orders.ts 注释、orders.test.ts、scripts/verify-1271-live.mjs） | **保留不动** | 中继的 ERC-1271 双路验签是通用合约账户支持；其测试与实链校验脚本以 MakerVault 为已部署的合约账户样本——实例暂停后 `verify-1271-live.mjs` 的预期行为会变（暂停时 isValidSignature 拒绝），若将来再跑该脚本须先意识到这一点。本轮范围为前端，relay 不动 |

验收：全仓 grep 前端 `src` 内已无指向 MakerVault 页面的路由/入口/导入（仅剩 chainState.ts 的通用语义注释与 chains.ts 的退役说明注释）；vitest 全绿、build 通过（计数见 §4）。

## 3. 块 B：第 52 轮复审 2 条 P2 顺带修复

### B1 索引 isReady 三态（`frontend/src/services/tradesDual.ts`）

- **问题**：`fetchIndexerChainProgress` 用 `row.isReady === true` 把「字段缺失/非布尔」压成 `false`，随后 stale 公式 `!isReady || lagBlocks > 50` 会把证据不足误标成「索引滞后」——与同文件「标注只凭实证、判不出不标」的既有口径自相矛盾（实测线上端点当前返回 isReady，故暂无实害，属口径债）。
- **改法**：`IndexerChainProgress.isReady` 改为三态 `boolean | null`——只有 _meta 行里明确的布尔值才取 true/false，缺失或非布尔 → `null`；stale 公式改为 `progress.isReady === false || progress.lagBlocks > INDEXER_STALE_LAG_BLOCKS`，块差证据仍独立成立。
- **测试**：tradesDual.test.ts 新增 1 条——isReady 缺失+已追平 → stale=false；isReady 缺失+落后 >50 块 → stale=true（凭块差实证）；isReady 为字符串 → 按缺失处理 stale=false。既有 isReady=false 用例继续通过。

### B2 运行器落盘 fsync 错误分类（`frontend/scripts/stage4/engine.ts`）

- **问题**：`writeFileAtomicDurable` 的文件 fsync 与目录 fsync 两处 catch 吞掉全部错误（含 EIO 等真实 I/O 故障），掉电持久化保证会在真出事时静默失效——比没有保证更危险。
- **改法**：新增降级白名单 `FSYNC_DOWNGRADE_CODES = {EINVAL, ENOTSUP, EOPNOTSUPP, EBADF}`（平台/文件系统「不支持同步」类语义）与分类器 `isFsyncDowngradeError`；两处 fsync 改走 `fsyncOrDowngrade`——白名单内降级跳过，其余错误向上抛，由调用方按失败关闭处理。父目录句柄打开失败同口径：白名单内跳过目录同步，其余上抛。
- **测试缝与注入用例**：`writeFileAtomicDurable` 新增可选第三参数 `sync`（默认 `fsyncSync`，生产调用不变），经 `faults.entry.ts` 再导出；faults.test.mjs 新增 **F9**——分类器白名单内外逐项断言；注入 EIO 于文件 fsync → 上抛且 rename 未发生、目标文件不出现；两步都注入 EINVAL → 降级完成、内容正确、无 .tmp 残留；文件 fsync 正常而目录 fsync 注入 EIO → rename 已生效但仍上抛（不假装已持久化）。

## 4. 门禁与测试对账

- `npx vitest run`：**37 个文件、424 条全过**。对账：426（第 52 轮）− 3（makerVaultMath 测试随文件删除）+ 1（B1 新增 isReady 缺失用例）= 424。
- `npm run build`：通过（仅既有大 chunk 提示，与本轮无关）。
- 故障注入 `node scripts/stage4/faults.test.mjs`：默认集 **14 个场景全过**（第 52 轮 13 个 + 本轮新增 F9）；F4-slow 变体按既有口径默认跳过（`S4_FAULTS_INCLUDE_SLOW=1` 时运行）。
- contracts/ 零改动（git diff 核实）；relay/、indexer/、mcp/ 零改动。

## 5. 骑乘对照表

| 本轮新件 | 骑乘的既有件 |
| --- | --- |
| isReady 三态 | 既有 `_meta` 查询路径与 stale 标注框架（第 52 轮 A3），不引入第二套 GraphQL 客户端 |
| fsync 错误分类 | 既有 `writeFileAtomicDurable` 持久化序（第 52 轮 B2）与 Node `fsyncSync`，仅补错误分类 |
| F9 故障注入 | 既有 faults 框架（esbuild 打包 faults.entry.ts + 结构假件模式，第 50 轮建） |
| MakerVault 合约（保留） | OpenZeppelin ERC-4626 原样保留在仓库（含其测试），本轮零改动 |
| 合约钱包下单能力（保留） | Settlement 通用 ERC-1271 验签（SignatureChecker / verifyOrderSignature 补查路径），与 MakerVault 解耦、本轮零改动 |

零新依赖。

## 6. 登记的观察项（本轮不动）

- `docs/mainnet-launch-plan-2026-11-08.md` 未把 MakerVault 列为部署项（仅 §2 一句「旧 MakerVault 去向两案待 Ren 拍板」的旧表述），按本轮工单口径不改该文件；去向定案记录以本文件与 gas 库设计文档 §6 状态更新为准。主网首发部署时按「不部署 MakerVault」执行。
- `relay/scripts/verify-1271-live.mjs` 以 Sepolia MakerVault 为实链样本，实例已暂停，其断言预期需在下次运行前按暂停语义复核。
