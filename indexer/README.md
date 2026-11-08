# Bit100 Settlement 成交索引器（Envio HyperIndex）

第 34 轮（无节点阶段 2C）交付。把双链 Settlement 的链上成交与 gas 分摊索引成
可查询的 GraphQL 数据，供前端成交记录以链上事件为权威源展示（节点 API 为
过渡源，合并口径见 `frontend/src/services/tradesDual.ts`）。

骑乘关系：索引框架整体骑 **Envio HyperIndex v3**（托管索引服务，第 30 轮
阶段 2 决策⑤「用既有托管索引服务，不自建索引器」）；calldata 解码与 digest
重算骑 **viem**；本目录自有代码只有事件→实体的薄映射与顺序关联逻辑。

## 索引内容

事件集合枚举自 `contracts/src/Settlement.sol` 现行结算路径：

| 事件 | 实体 | 说明 |
| --- | --- | --- |
| `TradeSettled` / `TradeSettledWithGasReimburse` | `Trade` | 合约内互斥二选一，每 Fill 恰好其一 → 每笔成交恰好一行，不重不漏 |
| `GasCostShared` | `GasShare` | 每 Fill 一次的 gas 对半回收明细；按同 tx 顺序 + maker/taker 双核对关联 `Trade`（`trade_id` 可空） |

不索引：`TradesBatchSettledWithMerkle` / `GasSavingsDistributed`（批次级聚合，
会与逐笔行重复记账）、`FailedSettlementCharged`（失败扣费，非成交）、其余
治理/配置事件（与成交无关）。

- 成交唯一 ID = `chainId-txHash-logIndex`。
- **订单 digest 关联**：事件不带 digest。handler 经 Envio 的 `fields` 选项
  （v3.7+）取同 tx 的 `transaction.input`，解码 settle 系列 calldata，按
  「第 i 个成交事件 ↔ 第 i 个 Fill」顺序对应，再按统一规范
  （`docs/eip712-order-spec.md`）重算 maker/taker digest。解不出（未知入口/
  数量对不上）留空并标 `digestAssociated=false`，**绝不按地址+金额猜测**。
- `config.yaml` 启用 `disable_default_cross_chain: true`（v3.6+ per-chain
  数据模式）：实体与回滚按链隔离，`chainId` 由框架自动附加。

## 配置口径（部署地址/起始块）

只认第 33 轮轮次文档的部署记录（`config.yaml` 头部有完整出处与 CREATE tx）：

| 链 | Settlement | 起始块（部署块） |
| --- | --- | --- |
| Sepolia 11155111 | `0xa3F8cBCDc1533299D37836ea80d5004FF59f9094` | 12087251 |
| Base Sepolia 84532 | `0x39037dE0a1d6ca567d50055522f7Ef825dF4FCf9` | 55881173 |

合约重部署后必须同步更新地址、起始块与 ABI 子集（`src/lib/settlementAbi.ts`）
并在轮次文档登记。历史轮次地址禁止抄入。

## 本地验证（第 34 轮实测，2026-11-08）

三层分开记录，不混称 E2E：

1. **纯逻辑单测**（`test/association.test.ts`，离线）：digest 重算命中规范
   测试向量；批量 3 Fill 解码按序关联不重不漏；垃圾 calldata 返回 null；
   双链 ID 分隔。5/5 通过。
2. **createTestIndexer 合成事件测试**（`test/testindexer.test.ts`）：官方
   测试库 simulate 模式喂合成事件进真实 handler——批量 tx 两笔成交落库、
   digest 按序关联、GasShare 挂载、calldata 缺失留空、双链分隔。3/3 通过。
3. **真实链数据回放对账**（`test/reconcile.test.ts`，`RECONCILE=1` 显式开）：
   取第 33 轮双链 E2E 结算 tx 的真实回执日志 + 真实 calldata 回放进 handler，
   实体与链上日志逐字段一致，且关联出的 makerDigest 与链上
   `Settlement.orderDigest(order)` 的 eth_call 真值逐字一致。双链 2/2 通过。
4. **未做**：Envio Cloud 实时同步 E2E（需要 HyperSync token / Envio 账号，
   属部署阶段，见下）。

运行：

```bash
npm install
npx envio codegen        # 校验 config/schema/handler 一致性（本轮实测通过）
npm test                 # 纯逻辑 + 合成事件（回放对账默认跳过）
RECONCILE=1 npx vitest run test/reconcile.test.ts
```

`envio dev` 本地全量跑需要 Docker + `ENVIO_API_TOKEN`，本机（Muse 的 VM）
未做；不影响上面三层验证的有效性，部署时在 Envio Cloud 上完成首次同步验收。

## 部署步骤（Envio Cloud，账号动作属 Ren）

1. Ren 注册 Envio 账号（https://envio.dev）并创建 API token
   （HyperSync 用；token 只放部署环境变量，不入 Git）。
2. 在 Envio Cloud 新建索引器，关联本仓库、根目录选 `indexer/`、
   配置文件 `config.yaml`，部署分支按发布流程定。
3. 部署后核对：双链同步高度 ≥ 各自起始块且追上链头；用第 33 轮两笔 E2E
   结算 tx 在 GraphQL 里查 `Trade` 行，字段与链上日志一致（口径同回放对账）。
4. 把控制台给出的 GraphQL 端点 URL 配到前端构建环境变量
   `VITE_INDEXER_URL` 并重新发布前端；数据页「链上索引（Envio）」状态应转
   「健康」，成交区出现来源标注（节点独有标「待索引」）。

**免费开发层运维事实（部署前必读）**：免费开发层部署**最长保留 30 天**，
且**连续 7 天无查询可能被自动删除**——测试网阶段若长期不用，要么定期查询
保活，要么接受到期后按上面步骤重新部署（配置全在仓库，重部署是幂等重跑）。
正式上线前应升级到付费层或迁自托管，并把保活/到期检查纳入运维清单。
