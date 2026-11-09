# 第 60 轮 E2E：用户自助上架全路径验收（Sepolia）

验证「粘贴地址上架新币 → 挂单 → 订单簿可见 → 撮合结算」全路径在真实
Sepolia 链上走通，主验一对**非 18 位小数**的自助上架对（TKX6 6 位 /
USDT 18 位，价格缩放 30），对照一对 18/18 的 TKX18/USDT。生产中继不碰：
全程走本地 `wrangler dev` 中继 + 本地 D1。

## 组成

- `token/`：迷你 Foundry 工程，只编译 `MockERC20Dec`（小数位可参数化的
  OZ ERC20 测试币，公开 mint）。OZ 依赖骑仓库 `contracts/lib`，不进
  `contracts/src`。先 `forge build` 产出工件。
- `run.ts`：驱动脚本。部署两币 → 负例（未注册对下单 400）→ 注册两对
  （201 + 重复注册 200 幂等）→ 铸币并存入第 47 轮 Vault → maker 签名
  挂卖单（缩放换算骑 `src/services/pairRegistry` 的生产函数）→ 中继
  订单簿可见且原始值逐字对 → taker 经生产 `executeFrontendMatch` 撮合
  结算（注入本地中继簿适配器）→ 回执 status=1、TradeSettled 事件、
  双方 Vault 余额增量在扣费区间内，逐项 PASS/FAIL 打印。
- `build.mjs`：与 `scripts/stage4/build.mjs` 同法，esbuild 打成
  `dist/round60-e2e.mjs`（`import.meta.env` define 为空对象）。

## 运行

```bash
# 1) 本地中继（仓库 relay/）：本地迁移 + dev
cd relay
npx wrangler d1 migrations apply bit100-relay-orders --local
npx wrangler dev --port 8787 --ip 127.0.0.1 --var SEPOLIA_RPC_URL:http://127.0.0.1:8545

# 2) 本地 RPC 转发器（见下方「本机出口坑」）：node /tmp 的一份转发脚本，
#    把 127.0.0.1:8545 的 JSON-RPC 转发到 Sepolia publicnode。

# 3) 代币工件
cd frontend/scripts/round60-e2e/token && forge build

# 4) 打包并运行（钥从测试钱包 env 文件注入环境变量，脚本只打印地址）
cd frontend/scripts/round60-e2e && node build.mjs
DEPLOYER_PK=$(grep -E '^PRIVATE_KEY=' ~/workspace/bite100-deployer/wallet.env | cut -d= -f2-) \
MAKER_PK=$(grep -E '^PRIVATE_KEY=' ~/workspace/bite100-deployer/maker.env | cut -d= -f2-) \
TAKER_PK=$(grep -E '^PRIVATE_KEY=' ~/workspace/bite100-deployer/taker.env | cut -d= -f2-) \
R60_RELAY_URL=http://127.0.0.1:8787 \
node dist/round60-e2e.mjs
```

## 本机出口坑（2026-11-10 实测）

本 VM 出口的中间层会干扰 workerd 的出站 TLS：wrangler dev 里中继直连
`ethereum-sepolia.publicnode.com` / Tenderly 网关时握手收到损坏报文
（TLS InvalidContentType），而同一台机器上 Node/curl 直连正常。故本地
跑中继时把 `SEPOLIA_RPC_URL` 指到本地 Node 转发器（127.0.0.1:8545 →
publicnode）。这只是本地测试管道：生产中继运行在 Cloudflare 网络内，
RPC 直读（含第 47 轮起的 ERC-1271 回退路径）一直正常。

另两个 publicnode 已知口径（与前几轮一致）：gas 记账放大约 7 倍——
脚本内普通发送带低 gasPrice（0.25 gwei）并按放大口径给足 gasLimit；
多后端同步滞后——刚部署的合约可能在个别后端暂时读不到代码，注册
步骤带退避重试，中继的 fail-closed 拒收是正确行为不是 bug。
