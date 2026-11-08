# 第四十二轮：贡献权重定版落地 + gas 库口径 + 文档回填（2026-11-08）

> 状态：**已开发、已本地提交（分支 `round42-weights-gas-vault`），
> 未合并、未推送，待主聊天核验**。基线 main d97df5a；分块提交
> A 8435edb / B 7208072 / C 2908574 / E 85026d8 / D c806db4 / F（本文档）。
>
> 本轮执行的三条底线：① 不重复造轮子 ② 只做集成（自有代码只写胶水
> 与差异化核心）③ 先查资料再给意见。定版决策（Ren 2026-11-08 17:35）：
> 贡献权重 **盘口挂单 35 / gas 库存款人 25 / 中继 20 / 结算提交者 20**；
> 计量 shortfall **由 gas 库（存款人资金）承担**，平台只兜底「发起失败
> 且发起人付不起」的极端情况；平台不做市、不放种子。

## 块 A：权重落地（合约 + 前端 + 节点注释）

**载体盘点结论（先盘点后动手）**：定版前的 50/25/15/10 只存在于文档
横幅，**从未进过合约**；合约 `ContributorReward` 的内部权重一直是
nodeType 计分制的 撮合 40 / 存储 25 / 流动性 20 / 中继 15，部署脚本
无权重项，前端不直接提交证明（证明由 Go 节点与 owner 记分通道提交）。

合约改动（`contracts/src/ContributorReward.sol`）：

- 常量改定版并改名对齐四线身份：`WEIGHT_POSTING=35`（nodeType 1，
  原「存储」线改记挂单）、`WEIGHT_GAS_VAULT=25`（nodeType 3，原
  「流动性」线改记 gas 库存款）、`WEIGHT_RELAY=20`（nodeType 0，
  15→20）、`WEIGHT_SUBMITTER=20`（nodeType 2，原「撮合」线改记
  结算提交，40→20）。
- 挂单线计量接口：nodeType 1 的评分输入改读 `postingMetric`
  （时长 × 深度积分，块 B 产出），按新增 `CAP_POSTING = 1e24`
  （quote wei·秒）归一；nodeType 2 字段口径改 tradesSettled /
  volumeSettled（结算笔数/量），公式不变。
- **顺带修复一处既有标度 bug**：原 `_computeLiquidityScore` 用
  `base * WEIGHT / 100` 而其余三线用 `(base+part) * WEIGHT`——该线
  实际份额被压到名义值的 1/100。本轮改名 `_computeGasVaultScore`
  并删除 `/100` 对齐其余三线；此修复改变该线历史实际分配（本就
  失真），已在此明示。
- `submitLiquidityProof` 函数名保留（部署 ABI 兼容），注释改记
  gas 库存款证明；`CAP_STORAGE_GB` 常量保留未用（注释标注）。

测试（`ContributorReward.t.sol`，7→11 例）：四线裸分比恰为
35/20/20（e18 尺度精确断言）；gas 库线标度（CAP/2→37.5e18、
CAP→50e18）；四线同池 100e18 实分恰为 29.75/21.25/17/17 e18
（每线内 base 与 part 各半的夹具口径）；挂单计量 CAP/2→52.5e18。

前端（功能变更带说明，同轮落地）：贡献区短提示改写为四条线的
身份/比例/shortfall 归属；数据页权重条改定版四段 + 说明（合约
常量已改、随下一次部署生效，线上现行部署在新部署前仍按旧口径）；
飞轮占位组件文案改定版口径。Go 节点仅注释同步（数字映射不变：
relay→0 / storage→1 / match→2，链上语义随合约改名）。

## 块 B：挂单线计量基础（设计 + 最小可用实现）

- 纯函数计量层 `frontend/src/services/contribution/postingMeter.ts`
  （+10 例单测全过）：输入订单生命周期记录（digest/maker/pair/
  amountIn/price/createdAt/expiresAt/filledAt），输出 per-address
  积分 = Σ 名义额 × 在场秒数。口径：在场区间与计量周期取交集；
  关闭时刻 = min(全量成交时刻, 到期, 周期末)；名义额 =
  amountIn × 签名 price / 1e18（quote wei，与双读/订单簿同口径）；
  **防刷封顶**：同地址同交易对的同时在场名义额封顶（默认 1e24，
  边界处先到先计），跨交易对不互相挤占。
- 离线计量 CLI `frontend/scripts/posting-meter/`：拼装层骑乘中继
  D1 `orders` 导出（时间戳即签名时间）与 Envio 索引器 Trade 导出
  （按 digestAssociated + maker/takerDigest 关联，累计 amountIn
  达订单量即全量成交时刻）；打包骑 soak 的 esbuild 模式。样例
  数据端到端实测拼装正确（部分成交单按到期关闭、秒数与积分
  手算一致）。
- **已知口径边界（如实登记，不硬塞）**：① 撤单无权威链下事件源
  ——软撤单（双读口径）不生成 filledAt，未成交单按到期关闭，属
  系统性高估，后续轮以「双读观察到的消失时刻」做近似修正时须
  单独定版；② 部分成交在剩余深度口径下本轮仍按全量深度计
  （中继 filled 为自报、索引器 filledIn 逐单归属是后续增强）；
  ③ 索引器 Trade.amountIn 按 digest 分别累计是统计近似，权威
  filledIn 在 Settlement 链上状态。合约侧只消费积分输入
  （submitProof nodeType=1），本轮不改合约消费逻辑。

## 块 C：gas 库机制设计（只设计）

新增 `docs/gas-vault-design-2026-11-08.md`：持有/垫付/回收流程
（不改变「提交者先垫、双方各半回收」的既有链路，gas 库在回收端
吸收差额）、shortfall 逐笔记账口径（定义式 + 欠额挂账不自动转
平台支出 + 索引器 GasShare 既有字段对账）、平台极端兜底三条件
边界、存款人收益（权重线 25 = 份额 × 时长，风险对价披露）。
MakerVault 去向两案对比（改造 vs 停用另建，引用代码事实：一
实例一交易对、NAV 与单一喂价强绑定、isValidSignature 签单面
必须消失、immutable 参数使改造≈重写承重部分），**推荐案二
（停用另建、同样骑 OZ ERC-4626），待 Ren 拍板**。本轮未动
MakerVault 合约。

## 块 E：chain-unknown 裁定（修，已落地）

裁定 = **修**（窗口 1 遗留）。事实：`evaluate.ts` 的 fail-closed
此前只靠 `mergeBooks` 的「VALID ∧ 无阻断」合取实现——
`tradableBlockers` 字段本身只表达方向证明，链上未证订单在方向
证明通过时该字段为空数组，任何只读该字段的消费方都会误判
（3A 窗口 1 的 tradeable 异常即此形态）。修复：新增阻断码
`CHAIN_UNPROVEN`（protocol.ts），`chainKnown=false` 时恒置于
tradableBlockers（含不可重构订单），字段本身 fail-closed；
VALID/UNKNOWN/INVALID 语义与 mergeBooks 合取不变。双读测试
65/65（+2 回归：RPC 故障/不可重构单恒阻断、已证 VALID 不误伤）。

## 块 D：文档口径回填（只改文档，复审文档半 P1 修复）

① docs-cleanup 卷首加状态更新（已合入 main d97df5a、正文为合并
前记录），§3/§5 同步注记；② 跨链设计文档加状态更新（一期已合
入 main、§10 实测待补，与 INDEX 一致）；③ 主网上线计划 §2 把
平台备付金与存款人 gas 库资金分开记账，shortfall 按定版写明由
gas 库担、平台兜底边界引用 gas 库设计 §4；④ nodeless §6/§8 与
五篇横幅的「重算中、尚未拍板」一次性回填定版数字 + 取代关系；
⑤ INDEX 第 20 轮行补 LI.FI key 注记（VITE_ 变量进入浏览器构建
产物、按公开客户端凭据管理、靠额度/限流控风险）；⑥ INDEX 同步
第 41 轮复审状态（待回 → 已回并裁定）并新增 gas 库设计条目。
docs-cleanup §5 待决清单 7 项按简报不在本轮范围，未动。

## 骑乘对照表（集成优先核对）

| 本轮新件 | 骑乘的既有件 |
|---|---|
| 合约权重定版 | 既有 ContributorReward 计分/分配框架与 nodeType 证明通道，只改常量与字段口径，不新造分配机制 |
| 挂单计量纯函数层 | 既有口径：订单簿 quote 名义额（amountIn × price / 1e18）、双读生命周期口径（关闭=成交/到期） |
| 挂单计量 CLI | 中继 D1 `orders` 表（既有记录）、Envio 索引器 Trade 实体（既有关联字段）、soak 的 esbuild 打包模式 |
| gas 库设计 | 既有 Settlement 计量/回收链路、索引器 GasShare 对账字段、OZ ERC-4626（案二新合约同样骑乘，不另造） |
| CHAIN_UNPROVEN | 既有 tradableBlockers 阻断码机制（与 SIDE_UNPROVABLE 同族），不新造认证通道 |

## 门禁结果（主验证口径，全部本机实跑）

- forge 全量：**185/185 通过**（基线 181 + 块 A 新增 4）；
- 前端 vitest 全量：**404/404 通过**（基线 392 + 块 B 10 + 块 E 2），
  tsc 0 错误，`npm run build` 成功；
- relay：本轮未触及 relay 代码，未跑其测试（无改动面）；
- 块级中间验证：ContributorRewardTest 11/11、dualread 65/65、
  postingMeter 10/10、CLI 样例端到端拼装手算一致。

diff 统计（d97df5a..本文档提交前）：28 个文件，+872 / −78；
按块：A 合约+测试+前端文案+Go 注释 / B 计量层+CLI / C 设计文档 /
D 文档 10 篇 / E 双读 5 文件。

## 偏离与未做项（如实登记）

1. 部署脚本无权重常量可改（盘点结论：权重只在合约常量）；
   FeeDistributor 无权重逻辑（只管费用归属），简报预设的两处
   载体实际只有一处，已按事实处理。
2. 权重生效时点：合约常量已改但**未部署**——线上测试网
   ContributorReward 仍是旧常量，随下一次合约部署（阶段 3 切换
   列车或独立部署）生效；前端文案已如实标注此口径。
3. 挂单计量未接生产调度（双周 CLI 是手动入口）；撤单时刻与
   部分成交深度两处口径边界见块 B 登记，需后续轮定版后才宜
   作为发奖依据。
4. MakerVault 去向未拍板（块 C 给推荐案二）；gas 库合约未写。
5. 治理侧：权重是合约常量，定版不需治理提案执行（部署即生效），
   但 INDEX/nodeless 已注明「治理确认随下一次部署一并处理」。

## 给下一轮（桥加固）的接口说明

- 本轮未触及跨链交付代码（`frontend/src/services/crosschain/`），
  桥加固轮的 3 条 P1（tx.wait 异常与双交付窗口、披露版本在执行
  时刻复检、幂等跨标签页/链上凭证）可直接在现行 d97df5a 代码
  状态上开工；本轮唯一与之相邻的改动是文档口径（INDEX 第 41
  轮行复审状态），无代码冲突面。
- §10 测试网真实小额实测仍欠（TKA 经 LayerZero 测试网），与桥
  加固轮同轮安排最省事：加固改的正是交付执行路径，改后即测。
- 最低交易额 $1 的前端实现（已拍板未落地）不在本轮范围，可与
  桥加固轮的前端批次合并。
- 若桥加固轮需要动 ContributorReward 相邻面：注意本轮已改其
  常量与计分口径，rebase 时以本分支为基线。
