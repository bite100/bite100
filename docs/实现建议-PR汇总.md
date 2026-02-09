# 实现建议与 PR 汇总

> 针对生产级部署、上线激励、Snapshot、TVL 的实用实现与 PR 要点，便于直接提交到仓库。

---

## 1. Docker Compose 生产级增强

**已落库**：
- `docker-compose.prod.yml`：单节点中枢（p2p-node）+ healthcheck（`/api/health`）、restart、volumes、可选 frontend-dev、watchtower profile。
- `.env.example`（根目录）：`NETWORK`、`REWARD_WALLET`、`BOOTSTRAP_NODES`、`LOG_LEVEL` 等。
- `node/Dockerfile`：增加 `wget` 以支持 healthcheck。

**PR 建议**：
- Title: `chore: add production docker-compose and .env.example`
- 说明：生产部署用 `docker compose -f docker-compose.prod.yml --env-file .env up -d`；可选 `--profile watchtower` 启用自动更新。

详见 [部署与使用说明 - 生产部署](./部署与使用说明.md)、[主网上线与优化总览](./主网上线与优化总览.md)。

---

## 2. Solidity：上线激励 + 防 Sybil 基础

**已落库**：`contracts/src/NodeRewards.sol`

- **功能**：`devPoints` / `nodePoints`（Governance 批量 allocate）；`bindAndRegister(nodeId)` 防 Sybil（每钱包最多 3 节点）；`claimRewards()` 统一领取 USDT（1 积分 = 1 USDT，6 decimals）。
- **与 ContributorReward 关系**：本合约仅负责「主网上线时」一次性激励；周期贡献奖励仍走现有 ContributorReward。

**PR 建议**：
- Title: `feat(contracts): add NodeRewards for launch incentives and basic sybil protection`
- Body: 实现钱包绑定（上限 3 节点）、积分分配、统一 claim；为上线空投准备；后续可加声誉/延迟检测。

部署：主网/USDT 地址确定后部署 NodeRewards(usdtAddress)，owner 移交 Governance/多签，再调用 `allocatePoints`。

---

## 3. Snapshot 脚本（积分分配输入）

**已落库**：`scripts/snapshot.py`

- **用途**：上线前根据离线开发者/节点积分表生成 `snapshot.json`（wallets、devAmounts、nodeAmounts），供 Governance/多签调用 `NodeRewards.allocatePoints`。
- **依赖**：`pip install web3`（可选链上读 boundNodeCount）。
- **用法**：编辑脚本内 `DEV_CONTRIBUTIONS` / `NODE_CONTRIBUTIONS`，运行 `python scripts/snapshot.py` → 生成 `snapshot.json`。

**PR 建议**：
- Title: `chore(scripts): add snapshot.py for launch reward allocation input`

---

## 4. TVL 追踪

**已落库**：
- `docs/TVL追踪建议.md`：DefiLlama API、Dune、自建脚本 + InfluxDB/Grafana 的说明。
- `scripts/tvl_example.py`：从链上读 Vault 余额 + AMM reserve0/reserve1，输出原始 TVL；可接入 cron/InfluxDB。

**PR 建议**：
- Title: `docs: add TVL tracking guide and tvl_example.py`

上线后可将协议提交至 [DefiLlama-Adapters](https://github.com/DefiLlama/DefiLlama-Adapters) 纳入 TVL 统计。

---

*以上内容均可直接作为 PR 提交；实现以仓库当前文件为准。*
