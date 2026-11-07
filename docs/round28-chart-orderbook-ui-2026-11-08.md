# 第 28 轮：K 线与订单显示视觉重做（2026-11-08）

- 分支：`round28-chart-orderbook-ui`（worktree `~/workspace/bite100-r28`），基线 main `1be4daf`；本地提交，**未 push**（主聊天验收后统一推）。
- 范围：**只做前端视觉与组件重做**——K 线、订单簿、最新成交、订单/成交表格。不动合约、不动节点逻辑、不改数据口径（唯一的例外见 §3：展示层单位换算，数据本身未动）。
- **皮肤拍板（Ren，2026-11-08）：整体保持现在的白色极简体系，只修线条排版**——图表与盘口面板**不做深色**。本轮全部实现即按浅色落地（白底、浅灰网格、淡色深度条），无深色残留。
- 触发：Ren 原话「k线订单显示你可以看看币安的，也可以抄一下hy的，你现在的太难看了」。

---

## 1. 基准调研（实测取证）

方法：2026-11-08 用无头浏览器实地打开 Binance 现货交易页（BTC/USDT）与 Hyperliquid 交易页，截图 + 像素采样 + 计算样式读取。截图存本机取证（`hl-trade.png`、`binance-trade.png` 等，未入库）。

### 1.1 K 线

| 规格项 | Binance（实测） | Hyperliquid（实测） | 本轮采用 |
|---|---|---|---|
| 蜡烛涨/跌 | 买绿 `#2ebd85` / 卖红 `#f6465d`（像素采样） | `#089981` / `#f23645`（像素采样，与 TradingView 现行默认一致） | **TV/HL 值** `#089981`/`#f23645`（本站图表库即 lightweight-charts，同源默认最自洽） |
| 成交量柱 | 与蜡烛同色半透明，图例 `Vol(BTC) 4.333K Vol(USDT) 329.168M` | 同色半透明 | 同色 45% 透明，置于底部 ~16% 叠加区 |
| 均线 | MA(7) 金 `#fcd535`、MA(25) 粉 `#eb40b5`、MA(99) 紫（采样点少，**近似值** `#8c69c2`） | 未取到（默认视图未显示 MA 图例） | MA7 `#f0b90b`（品牌黄在白底略加深保可读）、MA25 `#eb40b5`；MA99 未做（本站成交稀疏，99 根 bar 几乎永不成立） |
| OHLC 图例 | 图表左上：`2026/11/07 Open 75,844.00 High 76,249.99 Low 75,600.82 Close 75,706.80 CHANGE -0.18% Range 0.85%`，收盘价与涨跌幅按涨跌着色，千分位 | 有同类读数行 | 中文读数行：时间 开/高/低/收 涨跌% 量 + MA 值（各自线色）；随十字光标更新，移出回到最后一根 |
| 最新价线/轴标 | 虚线 + 价格轴色块标签（底色=当下涨跌色、白字） | 虚线 + 实色轴标 | lightweight-charts 最新价虚线，颜色跟随最后一根涨跌；轴标签由库渲染同色底 |
| 轴字体/格式 | 价格千分位 2 位小数；时间轴按粒度切换格式 | 同 | 价格千分位（量级自适应小数位）；时间轴 JST，按刻度粒度：年/月→`YYYY-MM`、日→`MM-DD`、日内→`HH:mm`；十字光标读数 `MM-DD HH:mm` |
| 周期切换 | 文字页签行（15m/1H/4H/1D…） | 同 | 文字页签（15m/1H/4H/1D），选中态加粗 + 强调色下划线 |
| 网格/十字线 | 极淡网格；十字线带双轴标签 | 同 | 网格 `#f1f1f4`；十字线 `#b9b9c0`，标签底 `#191919` |

**未取到/近似项（诚实标注）**：Binance 浅色主题在无头环境下未能切换成功（页头开关未生效、改 body class 不重绘），故其浅色面值未实测；本轮浅色规格 = 深色实测色相 + 本站既有浅色 token 的适配（深度条透明度、网格灰阶按本站体系取值）。Hyperliquid 的 MA 与表格密度未逐项取到，其盘口字号/行高为实测（下表）。

### 1.2 订单簿

| 规格项 | Binance（实测） | Hyperliquid（实测） | 本轮采用 |
|---|---|---|---|
| 行高/字号 | 行高 **20px**（计算样式）；数字列全精度或缩写混排 | 字体 **12px**，价差行行高 23px | 12px 等宽数字，行高 ~20px（padding 2px + line-height 1.5） |
| 深度条 | 自右向左，侧色低透明填充，宽度=累计量占比 | 同（卖盘 tint 为侧色低 alpha） | 累计量占比，买 `rgba(3,152,85,0.08)` / 卖 `rgba(217,45,32,0.08)`（浅底淡色），圆角 2px |
| 累计列 | 小值全精度（19.684178），**≥10000 缩写**（45.22K） | 千分位 | 价格/数量千分位全显；累计 ≥10000 → K/M/B 缩写（2 位小数） |
| 价差行 | 居中行：最新价大字 + 价差 | 居中 `Spread 0.001` | 居中行：中间价 15px/600 等宽 + `价差 x (y%)` |
| 排列 | 卖盘倒序（高价在上、最佳卖价贴价差行）、价格涨跌语义色、数字右对齐 | 同 | 全部沿用并对齐（原实现已有骨架，本轮修精度/色值/密度） |

### 1.3 订单/成交表格

| 规格项 | 基准共性 | 本轮采用 |
|---|---|---|
| 密度 | 表头小字灰、行高紧凑、行间细分隔线 | 表头 11px `--b100-text-3`，单元格 padding 5px 10px，正文 12.5px |
| 数字 | 等宽、右对齐、千分位 | `.num` 等宽右对齐（含表头），走统一格式化 |
| 时间 | 完整日期时间 | `YYYY-MM-DD HH:mm:ss`（JST 固定时区，不再随访客 locale 漂移） |
| 状态 | 色标/着色文字区分状态 | 胶囊色标：挂单中=琥珀 tint、部分成交=强调色 tint、已成交/已结算/已上链=绿 tint、已撤销/已过期=灰 tint、待结算=琥珀 tint |

---

## 2. 现状缺陷清单（重做前）

取证：重做前本地构建截图（§6）+ 线上站实查 + 代码盘点。

1. **数字单位未换算满屏科学计数法**：节点 `/api/trades`、`/api/orderbook`、`/api/orders` 的 `price` 是 **1e18 定点字符串**、`amount` 是 **wei（18 位）**，交易台各组件从未换算。线上实况：最新价显示 `7.569605e+22`、24h 成交量 `20000000000000000.00 BTC`、K 线价格轴标签畸形为 `7.58e+22.00`（对科学计数法字符串再做 toFixed 的产物）、盘口行溢出卡片。详见 §3。
2. **K 线是「裸图」**：虽已用 lightweight-charts，但零配置——无成交量、无均线、无 OHLC 图例读数、最新价线为默认样式、无 JST 本地化（时间轴截断成 `15:0`）、蜡烛色用 Radix 色板 `#30A46C/#E5484D`（与基准的 TV 色不一致）、周期切换是 Mantine 胶囊控件（与基准的文字页签不符）。
3. **订单簿精度粗暴**：价格/数量/累计一律 `toFixed(4)`——75,696.05 显示成 75696.0500 且无千分位；深度条用语义背景色块（`--b100-error-bg`/`--b100-up-bg`），在白卡上近乎不可见；行距松散。
4. **订单表格**：价格数量固定 4 位小数无千分位；时间用 `toLocaleString()`（随访客时区/locale 漂移）；状态是纯文本无色标；数字列表头未右对齐，与单元格错位。
5. **最新成交**：时间用本地 locale 时间、无千分位、固定 4 位小数。

## 3. 显示层单位换算（本轮唯一的「数据相邻」修正，口径未变）

- 事实：节点三接口的价格/数量是链上定点口径（price×1e18、amount wei）。`marketOrder.ts` 文件头早已写明「订单簿行是人类单位（非 wei）」的约定——即换算本应在展示边界发生，是第 22–26 轮接线时漏掉的一环，本轮补齐。
- 做法：新增 `frontend/src/components/dashboard/tradeFormat.ts` 的 `fromScaled()`，在各组件**取数边界**统一换算：`useTradesOHLC`（含 WS 实时成交，WS 与 REST 同构）、`usePairStats`、`OrderBookWidget`、`RecentTradesWidget`、`TradeTabsPanel`。
- 连带修复（均为换算的自然结果，非新逻辑）：Dashboard 中间价、点击盘口带价、市价单预估自此拿到真实人类单位（此前是 1e22 量级，预估必然失真）；`OrderBookWidget` 对外回调（`onBookUpdate`/`onPriceClick`）恢复其文档约定的人类单位口径。
- **未变**：数据源、接口、聚合口径、结算与签名管道（`OrderBookSection` 内部 wei 计算）一律未动；节点与合约零改动。样本核验：BTC/USDT 成交 `7569605×10^16` 定点 → 75,696.05；`10^16` wei → 0.01（与链上结算记录一致）。
- 已知同源问题（不在本轮处理）：节点侧成交记录 `amountOut ×1e18` 失真与 `/api/trades` 空返回 null 是第 29 轮（节点修复轮）的既定事项；本轮换算只作用于 price/amount 展示。

## 4. 实现摘要

**图表库选型**：沿用已在依赖中的 **lightweight-charts ^5.1.0**（TradingView 开源，Apache-2.0）——本就是基准同源组件（HL/Binance 图表观感即源于此体系），接入优先原则下无理由换库或手写 canvas。按许可证要求**保留其署名 logo**（`attributionLogo: true`，截图左下角可见）。本轮是把它的专业能力（成交量/均线/十字读数/价格线/本地化）真正打开，而非换库。

| 文件 | 改动 |
|---|---|
| `components/dashboard/tradeFormat.ts`（新） | 格式化中枢：`fromScaled` 定点换算、`toPlain`、`fmtPrice/fmtAmount/fmtTotal`（千分位+量级小数位+K/M 缩写）、`fmtTime/fmtDateTime/fmtChartTime`（JST 固定）、`sma` 均线 |
| `components/dashboard/tradeFormat.test.ts`（新，18 例） | 换算/格式化/JST 时间/SMA 全覆盖，含真实成交样本 |
| `hooks/useTradesOHLC.ts` + `.test.ts`（新 7 例） | 取数归一化换算；OHLCBar 新增 `volume`（bar 内数量合计）；WS 同步换算 |
| `components/dashboard/KLineChart.tsx`（重写） | 浅色专业主题：TV 蜡烛色、成交量柱（底部叠加）、MA7/MA25、OHLC 图例行（十字光标联动）、最新价虚线随涨跌着色、JST 时间轴分粒度格式、文字周期页签、空/错状态覆盖层、切对/切周期 fitContent |
| `components/dashboard/OrderBookWidget.tsx` | 取数边界换算；数字走 tradeFormat；价差行居中（中间价+价差额+百分比）；深度条/token/密度按 §1.2 |
| `components/dashboard/RecentTradesWidget.tsx` | 换算 + 千分位格式 + JST `HH:mm:ss` |
| `components/dashboard/TradeTabsPanel.tsx` | 价格/数量/已成交换算格式化；时间 JST 全格式；状态胶囊色标（订单状态 + 已上链/待结算）；数字列表头右对齐。**余额页签未动**（其值来自 `formatTokenAmount`，本就是人类单位）。撤单行为未动 |
| `hooks/usePairStats.ts` / `PairStatsBar.tsx` | 统计取数换算（口径不变）；信息条数字统一 tradeFormat |
| `src/index.css` | 新增 token：`--b100-chart-up/down`、`--b100-ma-1/2`、`--b100-depth-bid/ask`、`--b100-grid-line`、`--b100-crosshair` |
| `components/dashboard/TradeScreen.css` | 盘口 12px/~20px 行高、深度条淡色、价差居中、K 线图例/页签样式、表格密度与 `.num/.time/.side` 对齐、`.status-chip` 色标族、行悬停 |

## 5. 截图证据（同视口，本地构建 + 线上 Sepolia 节点真实数据）

重做前（未改代码构建，`VITE_NODE_API_URL` 指向线上节点）：

- [r28-before-full.png](round28-assets/r28-before-full.png) / [r28-before-trade.png](round28-assets/r28-before-trade.png)：信息条 `7.569605e+22`、K 线轴 `7.58e+22.00`、时间轴 `15:0`
- [r28-before-book.png](round28-assets/r28-before-book.png) / [r28-before-tabs.png](round28-assets/r28-before-tabs.png)

重做后（本轮构建，同法）：

- [r28-after-full.png](round28-assets/r28-after-full.png)：最新价 75,696.05、24h 量 0.02 BTC ≈ 1,506.96 USDT
- [r28-after-trade.png](round28-assets/r28-after-trade.png)：图例读数行、周期页签、千分位价格轴 + 色块最新价标、JST 时间轴、成交量带、TV 署名
- [r28-after-book.png](round28-assets/r28-after-book.png)：卖盘深度条、价差行、最新成交 JST 时间
- [r28-after-trades-tab.png](round28-assets/r28-after-trades-tab.png)：成交记录表（JST 全时间、千分位右对齐、已上链色标）

## 6. 门禁

- `npm test`：**194/194 全绿**（基线 169 + 本轮新增 25：tradeFormat 18 + useTradesOHLC 7）。
- `npm run build`：通过（仅有既存的 chunk 体积警告，非本轮引入）。
- forge / go：**未触碰**。

## 7. 变了什么 / 没变什么（使用说明）

- **用户可见变化**：K 线有了成交量、均线、十字光标读数、规范的价格/时间轴；所有价格数量带千分位与合理小数位；订单簿深度条可见、价差居中；订单/成交表有状态色标与 JST 时间；周期切换为文字页签。操作方式与原来一致（切对、切周期、点盘口带价、撤单入口位置均不变）。
- **未变**：数据来源与口径（仍是节点 `/api/trades` 等同一批数据）、下单/撤单/结算行为、合约与节点。§3 的换算是把屏幕数字从「定点原值」还原为「真实价格数量」，不是改数据。
- **注意**：测试网成交稀疏属正常——BTC/USDT 目前只有 2 笔成交，K 线 bar 少、MA7 需 ≥7 根 bar、MA25 需 ≥25 根 bar 才出现；无成交的交易对显示诚实空状态，不伪造行情。

## 8. 已知限制

1. Binance 浅色主题面值未能实测（见 §1.1），浅色规格为「实测色相 + 本站 token」适配，若 Ren 后续想逐值对齐 Binance 浅色版，需要一次带登录态的实测。
2. 「完整订单簿」全屏视图（`OrderBookSection`）本轮未做视觉打磨（其内部 wei 管道是下单签名口径，不受 §3 影响）；如需统一观感可下一轮顺手处理。
3. 成交量轴与累计列在 ≥10000 时用 K/M 缩写（对齐 Binance），极小量值仍全精度显示。
4. 仓库既存问题：GitHub Frontend CI 在 runner 上 vitest 启动崩溃（undici），与本轮无关，本地门禁为准。
