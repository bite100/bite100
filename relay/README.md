# Bit100 订单公告栏中继（无节点化阶段 1 · 第 30 轮腿 A）

Cloudflare Workers + D1 实现的**无许可订单公告栏**：maker 的 EIP-712 签名订单
是一张自验签便签，中继只负责存与转——**无用户私钥、无资金经手、不撮合、不裁决
成交**。它能做的最坏的事是藏单或延迟（订单可移植：maker 可同时发给多个中继，
前端多源合并按 digest 去重）。设计依据：主仓库 `docs/nodeless-design-2026-11-07.md`
§1/§2 候选 A；Ren 已拍板 A 为主中继、Nostr 公共中继作并行镜像、自建中继放弃。

配套：每张被接受的订单会 best-effort 镜像一份到 Nostr 公共中继（见 §4）；
前端下单路径已支持「节点主发 + 中继副发」双发（见 §6）。

---

## 1. 接口表

请求/响应形状与现有节点 REST 对齐（节点侧对应实现：
`node/internal/api/server.go`、`node/internal/storage/orders.go`）。
中继路径去掉 `/api` 前缀；订单体与节点 `POST /api/order` **同形状**，
仅多一个可选字段 `chainId`（节点是单链进程不需要它；中继多链，必须知道
按哪条链的 EIP-712 域验签，缺省 = 11155111 Sepolia）。

| 方法 | 路径 | 参数 | 成功响应 | 错误 |
|---|---|---|---|---|
| POST | `/orders` | JSON 体 = 节点 POST /api/order 体（下表），另加可选 `chainId` | `200 {"ok":true,"orderId":"…","digest":"0x…"}`；重复投递 `200 {"ok":true,"orderId":"…","digest":"0x…","duplicate":true}` | 400 字段缺失/非法、未知交易对、不支持的链、订单过期（`order expired`）；401 签名无效（`invalid signature`）；500 中继链配置错误 |
| GET | `/orders` | `chain`（或 `chainId`）、`pair`、`userAddress`（或 `trader`，与节点参数名兼容）、`limit`（默认 50，最大 200） | `200 [ <Order>, … ]`，按 createdAt 降序；**已过期订单不返回** | 400 chain 参数非法 |
| GET | `/orderbook` | `pair`（必填）、`chain`（缺省 Sepolia） | `200 {"pair":"…","bids":[<Order>…],"asks":[…]}`，仅 open/partial 且未过期；买盘价降序、卖盘价升序，同价时间升序（价格-时间，与节点同口径），每侧最多 100 条 | 400 缺 pair（`pair required`，与节点同文案） |
| GET | `/health` | — | `200 {"ok":true,"db":"ok","time":<unix秒>}` | 503 `{"ok":false,"db":"error",…}`（D1 不通） |

`<Order>` 的 JSON 字段与节点 `storage.Order` 逐项一致：`orderId, trader, pair,
side, price, amount, filled, status, nonce, createdAt, expiresAt, signature`
（有 execType 时另带 `execType`）。中继额外附三个扩展字段：`chainId`、
`digest`、`nostrEventId`（镜像成功才有值，否则 null）。与节点的两点有意差异：
① 节点 `/api/orderbook` 在簿为空时 bids/asks 可能为 `null`，中继恒返回 `[]`；
② 节点 `GET /api/orders` 不过滤过期单，中继按任务口径过滤（公告栏上的过期单
没有展示价值）。

POST /orders 请求体（与节点同形状）：

```jsonc
{
  "orderId": "…",            // 前端 generateOrderId
  "trader": "0x…",           // = 签名内 userAddress
  "pair": "BTC/USDT",
  "side": "buy",             // buy | sell（未签名消息字段）
  "price": "60000000000000000000000",  // wei 整数字符串（签名覆盖）
  "amount": "1000000000000000000",     // wei 整数字符串（= 签名内 amountIn）
  "filled": "0",
  "status": "open",
  "nonce": 0,                // 签名者的链上结算 nonce（签名覆盖）
  "createdAt": 1794085803,   // = 签名内 timestamp（Unix 秒）
  "expiresAt": 1794172203,   // 签名覆盖；缺省 = createdAt + 7 天（节点同口径）
  "signature": "0x…",        // 65 字节 EIP-712 签名
  "execType": "limit",       // 可选：""/limit/market（未签名执行指令）
  "chainId": 11155111        // 可选（中继扩展）：缺省 Sepolia
}
```

入库流水线（顺序不可换）：字段校验 → 按链配置重建签名订单 → **过期校验**
（now > expiresAt 拒绝）→ **EIP-712 验签**（§3）→ 按 digest `INSERT OR IGNORE`
去重 → 后台触发 Nostr 镜像（不阻塞响应）。

---

## 2. D1 schema

`migrations/0001_init.sql`：表 `orders`，一行 = 一张已验签订单。

- 主键 `digest`（EIP-712 订单摘要，按链域计算）——同一订单重复投递必然同
  digest，去重即单条 `INSERT OR IGNORE`，不需要先查后插的两步事务；
- 列：`chain_id, order_id, user_address`（小写）、`pair, side, price, amount,
  amount_out`（按规范公式 `amountIn*price/1e18` 的重建值）、`token_in,
  token_out`（交易对 Token0/Token1）、`filled, status, nonce, created_at,
  expires_at, exec_type, signature, raw_json`（投递原文，便签可移植的凭据）、
  `nostr_event_id`（镜像成功后单条条件 UPDATE 回填）、`received_at`；
- 索引：`(chain_id, pair, expires_at)`、`(chain_id, user_address, expires_at)`、
  `(expires_at)`、`(chain_id, order_id)`；
- 过期下架：查询侧一律带 `expires_at > now` 过滤；另有 wrangler cron
  （每 15 分钟）删除过期超过 1 天的行，只控表体积。

**D1 约束（部署与扩容前必读）**：D1 单库单线程（量级约 1000 qps @1ms 查询），
且没有交互式事务——本中继的全部写入都是**单语句条件写**（入库
`INSERT OR IGNORE` 靠 digest 主键仲裁、镜像回填是按 digest 的单条 UPDATE），
不依赖多步事务；将来若要加「状态推进」类逻辑，必须沿用单语句条件 UPDATE
（带 WHERE 的原子写）或按交易对分库分片，不要假设可以开事务慢慢算。

---

## 3. 验签（双路，与节点两段式同口径）

规范唯一事实源：主仓库 `docs/eip712-order-spec.md`。域：name=`比特100`、
version=`1`、chainId 按链、verifyingContract = 该链 Settlement 地址
（中继 `src/config.ts` 按链配置，Settlement 换地址只改配置或用
`CHAIN_CONFIG_JSON` 环境变量整体覆盖，验签逻辑不写死地址；代币表与前端
`config/chains.ts` 的登记一致，未登记的交易对直接 400）。

签名订单重建与节点 `match.BuildSignedOrder` 逐项一致：tokenIn/tokenOut =
交易对 (Token0, Token1)（与买卖方向无关）；amountOut = amountIn × price / 1e18；
timestamp = createdAt；nonce = 链上结算 nonce。

验签分两路（`src/orders.ts` 的 `verifyOrder`，只用 viem 现成能力，不手写密码学）：

1. **EOA 快路径**：`viem` 纯本地 `verifyTypedData` 做 ecrecover 比对
   userAddress，不走网络——绝大多数订单走这路；
2. **ERC-1271 回退**：快路径失败且该链配了 RPC 时，用
   `publicClient.verifyTypedData({ address, … })`——viem 的现成合约签名校验
   流程：先查 userAddress 有无代码，有代码则 eth_call 其
   `isValidSignature(hash, signature)`。**MakerVault（做市金库）是合约账户**，
   其订单由注册签名者 EOA 代签，ecrecover 恢复地址 ≠ 金库地址，纯本地验签
   必然失败，必须走这路（与第 27 轮 Settlement、节点的链上回退同一口径）。
   RPC 出错 → **fail-closed 拒绝**（与节点「RPC 错误 → 400」一致）。
   RPC 地址按链配置（`rpcUrl`），可用环境变量 `SEPOLIA_RPC_URL` /
   `BASE_SEPOLIA_RPC_URL` 覆盖。

注意：中继验签只证明「这张便签确实是 userAddress 认可的订单」，不证明链上
状态（落锁/已成交量）——读单方（前端）仍须按设计 §1.2 做链上二次过滤
（Vault.orderLocks、Settlement.orderFilled、expiresAt 三条全过才可吃）。

---

## 4. Nostr 镜像事件方案

- **kind = 30078**（NIP-78 参数化可替换应用数据，30000–39999 段），可用变量
  `NOSTR_KIND` 覆盖。**没有套用** Mostro/NIP-69 的 kind 38383——其标签是
  BTC/法币专用的，与本项目订单语义无关。本项目用自定义 addressable kind：
  同一订单（同 `d` 标签）重复发布在 Nostr 侧收敛为同一条事件。
- **标签**：`["d", <订单 digest>]`、`["pair", <交易对>]`、`["chain",
  <chainId>]`、`["exp", <expiresAt Unix 秒>]`。
- **content**：投递原文 JSON（完整的订单消息 + EIP-712 签名），与
  `POST /orders` 请求体一致——Nostr 订阅方拿到即可独立重建订单。
- **标签只是提示（hint）**：`pair/chain/exp` 等标签与 Nostr 事件本身都不构成
  订单真实性的证明。**任何读取方必须重新验 EIP-712 签名并核对链上状态**
  （落锁存在、未超签名量、未过期）后才可把订单当作可吃单；邮差密钥只是
  传输层身份，伪造的事件过不了 EIP-712 验签这一关。
- **邮差密钥**：一次性/可轮换的专用密钥，与任何用户或运营资金密钥无关。
  只从环境变量 `NOSTR_POSTMAN_SECRET_HEX`（64 位 hex，也接受 nsec）读取：
  生产用 `wrangler secret put NOSTR_POSTMAN_SECRET_HEX` 注入，本地演示用
  gitignore 的 `.dev.vars`（由 `scripts/gen-postman.mjs` 生成到仓库外再转写）。
  **仓库里没有任何私钥**；未配置密钥时镜像自动跳过，主入库不受影响。
- **best-effort**：入库成功后经 `waitUntil` 后台扇出到 `NOSTR_RELAYS`
  （默认 `wss://relay.damus.io, wss://nos.lol, wss://relay.nostr.band`），
  任一中继接受即把其 event id 回填到订单行的 `nostr_event_id`；全部失败
  只记日志（`console.warn`），不改入库结果、不重试轰炸。

**实测（2026-11-08，本开发 VM）**：VM 出口经代理，wss 直连公共中继不通——
`scripts/nostr-probe.mjs` 对三个默认中继逐个实测均为连接超时（约 12s，
事件已构造、id 见演示记录，但**没有发布成功**，不伪造）。代码路径已由
本地 mock 中继完整验证：单测里 nostr-tools 真发到本地 ws mock 中继成功；
全链路演示里 Worker 经同一路径把事件发到 mock 中继，event id 成功回填
入库记录（见 §5）。生产部署在 Cloudflare 边缘网络出站不受此限，部署后应
用探针脚本在可直连 wss 的环境复测一次公共中继可达性。

---

## 5. 本地演示记录（2026-11-08 实跑）

一条命令复现：`bash scripts/run-demo.sh`（生成仓库外邮差密钥 → 写 .dev.vars
→ 起 mock 中继 → 本地 D1 migration → `wrangler dev` → 跑 `scripts/demo.mjs`
→ 自动清理）。demo 用 `~/workspace/bite100-deployer/maker.env` 的测试钱包
真实私钥签名（脚本自读、不打印），maker 地址
`0xE83D2b08356cb463adFc20406a18B79991F7eE29`。实跑结果 **9/9 通过**：

| 步 | 结果要点 |
|---|---|
| GET /health | `{"ok":true,"db":"ok"}` |
| POST /orders 真实签名订单 | 200，digest=`0xe4b9b036…f81b` |
| POST /orders 重复投递 | 200 `duplicate:true`，库内一行 |
| GET /orders?pair=BTC/USDT | 查回该单 |
| GET /orders?userAddress=<maker> | 查回该单 |
| GET /orderbook?pair=BTC/USDT | 该单在 bids（bids=1, asks=0） |
| 过期订单（签名合法、已过期） | 400 `order expired` |
| 坏签名（换另一张单的签名） | 401 `invalid signature` |
| Nostr 镜像 event id | 已回填 `43ef7ca3…2f0f`；mock 中继日志收到同一 id、kind=30078、d 标签 = 订单 digest |

ERC-1271 回退的真实链上只读冒烟（`node scripts/verify-1271-live.mjs`）：
对第 27 轮真实 Sepolia MakerVault `0xEFD02ae9…C09f` 构造订单、用未注册
签名者签名，经公共 RPC 走 `publicClient.verifyTypedData` —— 返回布尔裁决
`false`（金库不认可该签名者）而非抛错，证明「中继 → RPC → 金库
isValidSignature」回退路径真实打通； mock 版双路逻辑另有 5 个单元用例覆盖
（通过/拒绝/RPC 出错 fail-closed/EOA 不触 RPC/无 RPC 时合约单被拒）。

---

## 6. 前端使用说明（双发）

**这是什么**：下单时前端先把订单发给节点（主发，下单成功与否只看它），
成功后再把同一张订单副发一份到本中继（公告栏），为无节点化阶段 2 的
「前端双读」铺路。副发失败只在控制台留一条 debug 日志，**不影响下单**。

**使用前提**：中继已部署（§7 步骤）并拿到其 URL；未部署/未配置时副发
自动静默跳过，前端行为与从前完全一致。

**操作步骤**（构建前端时设置两个环境变量）：

```bash
VITE_RELAY_URL=https://bit100-relay.<你的子域>.workers.dev
VITE_RELAY_DUAL_SEND=true   # 可省略，默认开；设 false/0/off 关闭副发
```

配置定义在 `frontend/src/config/relay.ts`，副发实现
`frontend/src/services/relayDualSend.ts`，接入点为三条下单路径
（`services/orderService.ts`、`OrderBookSection.tsx`、
`components/dashboard/LimitOrderFormWidget.tsx`）的节点 POST 成功之后。

**注意事项**：① 中继 URL 为空 = 副发关闭（不是报错）；② 中继侧会自己验签，
副发被拒（401/400）通常说明该单签名/链配置有问题，应结合节点主发结果排查，
但不要为了副发改下单逻辑；③ 测试网与主网中继分开部署、分开配 URL。

---

## 7. 运维手册

### 本地跑

```bash
cd relay
npm install                 # 依赖只装在本目录（含 wrangler 本地 devDependency）
npm run db:migrate:local    # 建本地 D1 表（wrangler d1 migrations apply --local）
npm run dev                 # wrangler dev，默认 http://127.0.0.1:8787
bash scripts/run-demo.sh    # 或一键全链路演示（自带 mock Nostr 中继）
```

本地镜像调试：在 `.dev.vars`（已 gitignore）里写
`NOSTR_POSTMAN_SECRET_HEX=<hex>` 与 `NOSTR_RELAYS=ws://127.0.0.1:7777`，
再 `node scripts/mock-relay.mjs` 起本地 mock 中继观察事件。

### 测试

```bash
npm test          # unit（node 环境，20 个）+ workers（workerd+本地 D1，12 个）
npm run typecheck # tsc --noEmit
```

前端门禁在 `frontend/`：`npm test`（基线 169 + 双发新增 9 = 178 全绿）。

### 部署（Cloudflare，需 Ren 的账号侧动作）

**当前状态：未部署**——本机无可用 wrangler 凭据（`npx wrangler whoami` 返回
未登录；环境变量 `CLOUDFLARE_API_TOKEN` 未设置；`~/.cloudflared/cert.pem`
是 cloudflared 隧道证书，wrangler 用不了）。不要走交互式 `wrangler login`
（需要用户浏览器）。Ren 备齐凭据后按下面确切步骤执行即可上线：

1. **开 Workers Paid（$5/月，账号侧费用，事实上必需）**：免费版每调用只有
   10ms CPU，而官方口径签名校验类负载通常 10–20ms（本中继每单要做
   EIP-712 哈希 + ecrecover，ERC-1271 回退还要等 RPC），免费版会频繁
   超限报错。开通：dash.cloudflare.com → Workers & Pages → Plans →
   Workers Paid。
2. **建 API token**（dash.cloudflare.com → 右上头像 → My Profile →
   API Tokens → Create Token → Custom token），权限至少勾：
   `Account · Workers Scripts · Edit`、`Account · D1 · Edit`、
   `Account · Workers Tail · Read`（看日志用，可选）。记下 token 值。
3. **查 Account ID**：dash.cloudflare.com → Workers & Pages 页面右侧
   「Account ID」。把凭据交给执行方的方式：设置环境变量
   `CLOUDFLARE_API_TOKEN=<token>` 与 `CLOUDFLARE_ACCOUNT_ID=<account id>`
  （或由 Ren 本人在终端跑下面命令）。
4. **建 D1 并回填 id**：
   ```bash
   cd relay
   npx wrangler d1 create bit100-relay-orders
   # 把输出的 database_id 填回 wrangler.toml 的 [[d1_databases]] database_id
   ```
5. **跑 migration + 部署**：
   ```bash
   npm run db:migrate:remote   # wrangler d1 migrations apply --remote
   npx wrangler secret put NOSTR_POSTMAN_SECRET_HEX   # 粘贴邮差私钥（hex/nsec），不要写进任何文件
   npm run deploy              # wrangler deploy
   ```
6. **验收**：部署输出 `https://bit100-relay.<子域>.workers.dev`，
   `curl <url>/health` 应回 `{"ok":true,"db":"ok"}`；再用
   `RELAY_URL=<url> node scripts/demo.mjs` 跑一遍全链路（mock 中继那步会
   因 NOSTR_RELAYS 指向生产默认公共中继而走真实镜像，观察 event id 回填）。
7. **前端开启副发**：按 §6 设置 `VITE_RELAY_URL` 重新构建发布前端。

日常运维：`npx wrangler tail` 看实时日志（镜像失败是 warn 级、属预期噪音，
重点看 5xx 与 `[relay] chain config error`）；改 Settlement 地址优先用
dashboard 改 `CHAIN_CONFIG_JSON` 变量或更新 `src/config.ts` 后重新 deploy；
过期清理 cron 自动跑，无需人工干预。

### 已知限制

- 验签的 ERC-1271 回退依赖公共 RPC 可用性：RPC 挂了时合约账户订单会被
  fail-closed 拒绝（EOA 订单不受影响）；生产建议在变量里换成自备 RPC。
- 中继不记成交状态：`filled/status` 是投递消息的自述字段，中继不校验、
  不推进；订单是否可吃以链上状态为准（§3 末段）。
- 中继可藏单/延迟（公告栏模型的固有面）：靠多中继 + 前端多源合并缓解，
  不在本轮范围。
- 市价单（execType=market）在节点侧有「对手盘为空即拒绝」的预检，中继
  无盘口裁决职责，一律按普通订单入库——前端撮合阶段处理其 IOC 语义。
- D1 免费/付费额度与单线程上限见 §2；量级上来先按交易对分片，不要先
  假设加机器。
