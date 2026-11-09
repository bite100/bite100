# 第 54 轮：页面修复轮——完整订单簿页卡死三根因 + 行情页压字 + 治理页文案诚实化 + 第 53 轮复审顺带项（2026-11-09）

> 状态：分支 `round54-page-fixes` 本地提交（基线 main `99d642d`），未推送、未合并、未部署；**contracts/ 零改动**、零新依赖。
> 来源：Ren 2026-11-09 15:58 实测报障（完整订单簿页盘口/参考价/余额全卡在「加载中」）+ 15:59–16:01 网页巡检截图（行情页压字、治理页过期指引）；块 D 为第 53 轮 ChatGPT 复审的顺带项（主聊天已逐条对代码裁定成立）。

## 1. 块 A：完整订单簿页卡死三根因（`frontend/src/OrderBookSection.tsx` 等）

### A1 无限重取循环

- **根因证据**：修复前 `OrderBookSection.tsx:138` 有 `_prevOrderbook` state；`:212` 处 `fetchOrderbook` 的 `useCallback` 依赖为 `[pair, isOnline, orderbook]`，而它自身每次成功都 `setOrderbook(data)`（新对象）+ `setPrevOrderbook(orderbook)`。于是：取簿 → state 变 → 回调换身份 → 数据 effect（依赖该回调）重跑 → `setLoading(true)` 并再次取簿，无限自触发。`loading` 永远回弹，卖盘/买盘面板永远转圈；页面事实上靠这条死循环在「轮询」。
- **改法**：上一份簿改放 `prevOrderbookRef`（`useRef`），已展示的簿（含缓存先行展示、WS 增量）由一个同步 effect 统一写回 ref，供价格动画比较读取；`fetchOrderbook` 依赖收敛为 `[pair, isOnline]`。`loading` 只认「当前交易对的首次加载」（`loadedPairRef` 记录已加载的 pair）：首次进入某 pair 点亮，落定后关闭；同 pair 的后续刷新（P2P 订单事件 `refreshAt`、撤单后刷新）只更新数据、不再闪加载圈。死循环修掉后补正当保鲜机制：显式 15 秒轮询（`setInterval` 触发既有 refresh 通道，卸载清理），与既有 P2P/WS 增量并行。
- **用户可见变化**：完整订单簿页恢复可用——盘口首次加载完成后稳定显示，之后每 15 秒或有新订单事件时静默更新，不再整页反复「加载中」。

### A2 参考价无超时（`frontend/src/hooks/useTokenPrice.ts`）

- **根因证据**：修复前 `:43` 处 CoinGecko 请求是裸 `await fetch(url)`，无超时、无 signal。对端不回时请求永不落定，`loading` 永远为 true，订单簿页永远停在「市场参考价加载中…」，页面既有的「服务暂时不可用」诚实文案永远到不了。
- **改法**：`AbortController` + 8 秒超时，超时 abort 后走既有 catch → `error` 路径（订单簿页据此显示「市场参考价服务暂时不可用，订单簿与下单功能仍可正常使用」）；加在飞标记，30 秒轮询在上一笔未落定时跳过本轮，不再叠加挂死请求。
- **测试**：useTokenPrice.test.ts 新增 2 条——挂死请求 8 秒后 abort 并落到 error（loading 关闭）；在飞时 refetch 不叠加（fetch 只调用 1 次）。
- **用户可见变化**：参考价取不到时最多等 8 秒就明示不可用，不再假装一直在加载。

### A3 余额读取无超时（含同查同修）

- **根因证据**：修复前 `OrderBookSection.tsx:296` 的 `fetchBalance` 经钱包 `BrowserProvider` 直调 `vault.availableBalance(...)`，无应用层超时；钱包 RPC 卡住时该 await 永不落定，`balanceLoading` 永远 true（「余额加载中…」永不消失）。
- **同查结论（同一无超时模式，两处都有）**：
  - `components/dashboard/LimitOrderFormWidget.tsx:138` 展示余额 effect 的 `Promise.all([availableBalance, locked])`，及 `:274` 提交前复核读 `Promise.all([availableBalance, balanceOf])` 与补存流程 `deps.available()` 回读——均无超时，卡住时分别表现为余额永不更新、提交永停「提交中」。
  - `components/dashboard/TradeTabsPanel.tsx:137` 的整组余额读 `Promise.all([balanceOf, balanceOf, availableBalance, locked])`——其上虽有 `.catch(() => 0n)` 兜底，但 catch 只兜 reject、兜不住永不落定的挂死，旧余额会永远挂在界面上。
- **改法**：`src/utils.ts` 新增小工具 `withTimeout(promise, ms, label)`（竞速超时，超时按失败 reject）+ 常量 `BALANCE_READ_TIMEOUT_MS = 10000`，三处组件的余额读统一套用，超时走各自既有失败路径（清空余额/走外层 catch），不冒充旧值。为什么不骑 tradesDual 的 `callWithTimeout`：它的契约是面向 fetch 的取数器（要求把 AbortSignal 真传进底层请求），ethers 合约读没有 signal 可传，硬套会违背其文档契约；故只写这个十几行的竞速工具，理由在此登记。
- **用户可见变化**：钱包 RPC 卡住时余额最多等 10 秒就按读取失败处理（显示为空并可随后续刷新恢复），不再无限「加载中」。
- **范围外观察（本轮未动）**：`components/AssetsPage.tsx` 的 `availableBalance` 读带有 reject 兜底（`.catch(() => total)` 等）但同样兜不住挂死，属同一类问题；本轮工单只点名上述三处，AssetsPage 留待后续轮次一并处理时参考本节工具。

## 2. 块 B：行情页行内文字重叠（`frontend/src/components/markets/Markets.css`）

- **根因证据**：行情行主列 `.markets-pairline` 是不换行的 flex 行，内容为对名（BTC/USDT）+「现货」pill +「仅同链交易」pill + 星标；pill 本身 `white-space: nowrap`（Shell.css `.pill`），主列虽有 `min-width: 0`，但整行内容宽超过主列可用宽时直接溢出，压到右侧 `.markets-price` 的价格数字上（Ren 截图：BTC/USDT、ETH/USDT 两行「仅同链交易」标签与 `$74,172.63` 等价格重叠；无同链标签的行不压字，与根因吻合）。
- **改法（移动端优先）**：`.markets-pairline` 改 `flex-wrap: wrap` + `row-gap: 3px` + `min-width: 0`，pill 与星标 `flex: none` 不收缩——空间不够时标签成组换行到第二行，而不是溢出压字；`.markets-price` 加 `flex: none`、数字 `white-space: nowrap`。有参考价行（价格 + $ 小字）与无参考价行（暂无成交）都走同一行结构，两种行均不再压字。
- **桌面不回退**：宽屏一行放得下时不触发换行，外观与修复前一致。
- **用户可见变化**：手机窄屏下行情列表每行的标签与价格各占其位，不再重叠。

## 3. 块 C：治理页文案诚实化（`frontend/src/GovernanceSection.tsx`）

- **问题**：节点已于阶段 5 退役，但页面多处仍指引用户「在项目 node 目录运行 `go run ./cmd/merkletool -proof-for …`」生成 proof / 活跃集根——普通用户根本走不通这条死路。全仓核查命中 6 处：投票报错文案（原 :144）、创建报错文案（原 :180）、规则介绍（原 :233，「由节点按贡献选出」）、怎么投票（原 :402）、创建提案说明（原 :446）、高级区标题（原 :465）。
- **改法（只诚实化，不发明新机制）**：删除全部 merkletool / go run 指引；规则介绍保留，仅把「由节点按贡献选出」改为「按贡献选出」；新增置顶「当前状态」说明——当前暂无提案；节点退役后活跃集名单与投票证明的产出路径正在重整，创建提案与需要证明的投票暂时不可用；提案列表查看与已通过提案的执行不受影响。投票/创建两处 hint、两条报错文案与高级区标题（改「高级：活跃集设置（人数与 Merkle 根）」）同步改实。验收：全仓 grep `merkletool`、`go run` 在 frontend/src、frontend/scripts、relay 内零命中。
- **用户可见变化**：治理页不再把用户指向已退役的节点命令；高级操作暂时不可用的事实与原因在页面上明示。

## 4. 块 D：第 53 轮复审顺带项

### D1 索引块高形态校验（`frontend/src/services/tradesDual.ts`）

- **问题**：`fetchIndexerChainProgress` 对块高直接 `Number(row.progressBlock)`（修复前 :244）：`Number(null)=0`、`Number('')=0` 都是有限值，能溜过 `Number.isFinite` 检查——sourceBlock 为 null 时块差被压成 0（漏报滞后），progressBlock 为 null 时块差被放大到整条链高（误报滞后），与同文件「标注只凭实证」口径冲突。
- **改法**：新增 `parseBlockHeight`——只接受有限数字或非空十进制数字字符串，其余 → null；任一块高为 null 时整个进度返回 null（判不出、不标）。
- **测试**：tradesDual.test.ts 新增 1 条——progressBlock=null 经 loadIndexerTrades 不再误标 stale（failed=false、stale=false）；sourceBlock=null 与 progressBlock='' 直查进度返回 null；数字字符串 `'900'/'1000'` 照常算出 lagBlocks=100。

### D2 运行器 fsync 分类按场景拆分（`frontend/scripts/stage4/engine.ts`、faults）

- **问题**：第 53 轮的统一白名单 `{EINVAL, ENOTSUP, EOPNOTSUPP, EBADF}` 同时用于文件 fsync、目录打开与目录 fsync（修复前 engine.ts:403 起）。其中 EBADF（坏文件描述符）在任何场景下都是调用方自身的错误而非平台不支持，放行等于把 bug 静默成「已落盘」；EINVAL 也只在目录句柄上是部分平台的正常回应。
- **改法**：拆两套判定——`isFileFsyncDowngradeError`（仅 ENOTSUP/EOPNOTSUPP）与 `isDirFsyncDowngradeError`（EINVAL/ENOTSUP/EOPNOTSUPP）；**EBADF 一律上抛**；`fsyncOrDowngrade` 加场景参数，目录打开失败改走目录判定。BUILD_NOTE 叠加第 54 轮条目（旧轮条目原文保留，与既有体例一致）。
- **测试**：faults F9 按新口径重写并扩断言——两分类器逐项；文件 fsync 注入 EBADF **必须抛错**且目标不被 rename 出来；文件 fsync 注入 EINVAL 同样抛错；文件 ENOTSUP + 目录 EINVAL 组合降级完成；目录 fsync 注入 EIO / EBADF 均上抛。默认集 14 个场景全过。

### D3 1271 实链冒烟脚本定位标注（`relay/scripts/verify-1271-live.mjs`）

- **问题**：脚本以 Sepolia MakerVault（`0x5473D7c…F7f0`，第 47 轮栈）为 ERC-1271 实链样本；该实例已于第 53 轮暂停退役，暂停下 isValidSignature 对任何签名者恒拒绝——脚本原口径「返回 false 即证明回退路径打通」不再成立（暂停拒绝与未注册签名者拒绝不可区分）。
- **改法（最小诚实调整，不新部署合约）**：文件头标注样本已退役暂停、脚本定位改为**负向验证**（当前预期语义是「拒绝」：返回 false 或以暂停类回滚结束都只证明暂停实例恒拒绝）；输出口径同步改实，并新增一条真断言——暂停实例若返回 true（接受签名）才判失败（exitCode=2）。正向打通验证需未暂停的合约钱包样本，目前没有，文件头已写明将来换样本时恢复原断言口径。

### D4 主网上线计划过期表述回填（`docs/mainnet-launch-plan-2026-11-08.md` §2）

- 「旧 MakerVault 去向两案待 Ren 拍板」已回填为定案：2026-11-09 Ren 拍板（第 53 轮）退役产品、保留代码——双链实例已暂停、前端下线、合约与测试保留、主网首发不部署 MakerVault。

## 5. 门禁与测试对账

- `npx vitest run`：**37 个文件、427 条全过**。对账：424（第 53 轮）+ 2（块 A2 useTokenPrice 新增）+ 1（块 D1 tradesDual 新增）= 427。
- `npm run build`：通过（仅既有大 chunk 提示，与本轮无关）。
- 故障注入 `node scripts/stage4/faults.test.mjs`：默认集 **14 个场景全过**（F9 为本轮按新口径重写扩展，场景数不变）；F4-slow 变体按既有口径默认跳过（`S4_FAULTS_INCLUDE_SLOW=1` 时运行）。
- `npx tsc --noEmit`：干净。contracts/ 零改动（git diff 核实）；MakerVault 相关仅块 D3 的脚本标注，未动合约与中继验签逻辑。

## 6. 骑乘对照表（零新依赖、零新组件）

| 本轮新代码 | 骑乘的既有件 |
| --- | --- |
| 订单簿页 15 秒保鲜轮询 | 既有 refresh 通道（`refreshAt` + 数据 effect）与既有 P2P/WS 增量，未引入第二套取数 |
| 参考价 8 秒超时 | 平台标准 `AbortController` + 既有 error/诚实文案路径，未引入新请求库 |
| 余额读超时 `withTimeout` | 平台 `Promise.race`；tradesDual 的 `callWithTimeout` 为 fetch 专用契约（须传 signal），合约读无 signal 可传，故在 utils.ts 写十余行竞速工具并在此登记理由，未引入新依赖 |
| 行情页换行修复 | 纯 CSS flex-wrap，复用既有 `.pill` 样式，未改组件结构 |
| fsync 场景分类 | 既有 `writeFileAtomicDurable` 的 sync 注入缝与 faults 框架，未改落盘序 |
| 块高形态校验 | 既有 `fetchIndexerChainProgress` 内新增纯函数校验，未引入新取数路径 |
