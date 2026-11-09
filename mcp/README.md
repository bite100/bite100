# Bit100 MCP 接入说明（给 AI 用的人类说明书）

这一包是 Bit100 交易所的 **MCP 服务**：任何支持 MCP 协议的 AI 客户端
（不限品牌、不限实现），连上它、用测试钱包，就能在**测试网**上看订单簿、
挂单、吃单成交、查成交状态，像真人交易员一样练习。

> ⚠️ 当前是**测试网练习形态**：服务里放的是没价值的测试钥，签名由服务
> 端完成（练习脚手架）。产品终局形态是「任何人带自己的钱包接入、交易
> 所不碰私钥」——签名层已经按可替换接口做好，届时换签名器即可，工具
> 不变。正式开放要等无节点收尾完成并过安全评审（见第 49 轮文档）。

## 1. 准备

```bash
cd mcp
npm ci
npm run build        # 产物 dist/bit100-mcp.mjs
```

准备两个东西：

- **agent 注册表**（一个 JSON 文件）：写清每个 AI 身份。照着
  `agents.example.json` 改：每个 agent 有 `id`、令牌的 SHA-256 哈希
  `tokenHash`、钱包角色 `role`（maker/taker/operator）、单笔上限
  `perOrderMaxQuote`、每日上限 `dailyMaxQuote`、每分钟写次数
  `writeRatePerMinute`、开关 `enabled`。限额单位是计价代币的人类单位
  （比如 TKA/TKB 对里就是 TKB；BTC/USDT 对里就是 USDT）。
  令牌明文自己生成（随机长字符串），只把哈希写进注册表：
  `echo -n '你的令牌' | sha256sum`。
- **测试钥文件路径**（只给路径，不给钥本身）：maker/taker/operator 三个
  角色各一个 env 文件（里面有 `PRIVATE_KEY=` 的那种测试钥文件），路径
  通过下面的环境变量告诉服务。钥只存在于文件和进程内存里，不进配置、
  不进代码、不进 git。

## 2. 在 AI 客户端里接入

服务走标准 MCP（stdio）。在你的 MCP 客户端配置里加一个 server，
命令指向构建产物，并带上环境变量：

```json
{
  "mcpServers": {
    "bit100": {
      "command": "node",
      "args": ["/绝对路径/bite100/mcp/dist/bit100-mcp.mjs"],
      "env": {
        "BIT100_MCP_AGENTS_CONFIG": "/绝对路径/agents.json",
        "BIT100_MCP_AGENT_TOKEN": "本 agent 的令牌明文",
        "BIT100_MCP_KEYFILE_MAKER": "/路径/maker.env",
        "BIT100_MCP_KEYFILE_TAKER": "/路径/taker.env",
        "BIT100_MCP_KEYFILE_OPERATOR": "/路径/wallet.env"
      }
    }
  }
}
```

一个进程绑定一个 agent 身份（由令牌决定）。想同时跑 maker 和 taker
两个 AI，就起两个进程、各用各的令牌。可选环境变量：
`BIT100_MCP_RELAY_URL`（中继地址，缺省为线上中继）、
`BIT100_MCP_AUDIT_DIR`（审计日志目录，缺省 `./audit`）。

## 3. 工具清单

只读（不要钥，急停时也能用）：

| 工具 | 干什么 |
|---|---|
| `get_chain_config` | 查某条链的合约地址（第 47 轮栈）与支持的交易对 |
| `get_orderbook` | 查某交易对的订单簿（买盘/卖盘） |
| `list_orders` | 按交易对/用户查中继上的未过期订单 |
| `get_balances` | 查地址的原生币与各代币余额（钱包/Vault/可用，链上直读） |
| `get_order_status` | 按订单摘要查链上已成交量、锁定状态、是否已永久撤销 |

写（先过护栏，见第 4 节）：

| 工具 | 干什么 |
|---|---|
| `place_order` | 挂限价单到中继订单簿（签名在服务端完成；未落锁，撮合时落锁） |
| `match_order` | 发一单并立刻走完整撮合：双读订单簿→撮合→落锁→模拟剔腿→结算上链 |
| `hard_cancel_order` | 链上硬撤一单**已落锁**的订单（永久作废，只有 operator 角色能做；未落锁的单没有链上可撤对象，工具会如实说明——中继没有撤单按钮、节点已停机，这类单只能等过期） |

金额参数都用人类单位的十进制字符串：`price: "1.5"`、`amount: "0.5"`。
只支持两条测试网：Sepolia（11155111）与 Base Sepolia（84532）；
交易对只支持配置里登记的 8 个测试交易对。

## 4. 护栏（都在服务端代码里，不靠自觉）

- **身份**：令牌不对，连工具都调不了；每个 agent 可单独停用
  （注册表里 `enabled: false`，或换掉它的令牌哈希）。
- **限额**：单笔上限、每日累计上限、每分钟写次数上限，超了直接拒，
  拒绝发生在签名和发单之前，不产生任何副作用。
- **白名单**：链只许两条测试网（主网 chainId 直接拒），交易对只许
  登记在册的 8 个，合约地址只认交易所配置里的第 47 轮栈。
- **急停**：见第 5 节。
- **审计**：每次工具调用都追加一条 JSONL 到 `audit/<agent-id>.jsonl`
  （时间、agent、工具、参数、结果、交易哈希），只增不改，事后可查账。

## 5. 急停怎么操作

两种方式，任一生效，**所有 agent 的写工具立刻全拒**（读工具照常用）：

1. 启动环境加 `BIT100_MCP_KILL_SWITCH=1` 后重启服务；或
2. 在注册表文件同目录放一个名为 `kill-switch` 的空文件（不用重启，
   下一次写调用即生效）；删掉文件即恢复。

单个 agent 停用：把注册表里它的 `enabled` 改成 `false` 并重启用它的
那个进程。

## 6. 自检

```bash
npm test                                   # 单元测试（护栏/中继/工具，mock）
npm run build && npm run e2e               # 真链自练：双链全环 + 负面用例（需要测试钥与少量测试网 gas）
```

## 7. 公开入口形态（Workers，第 57 轮起）

除上面的 stdio 形态外，本服务还有一个**公开 HTTPS 入口**（Cloudflare
Workers），任何支持 MCP Streamable HTTP 的客户端都能远程接入：

- 端点：`https://bit100-mcp.q3874758.workers.dev`（根路径 POST；
  `GET /health` 免认证只回服务状态）。
- 认证：每请求带 `Authorization: Bearer <你的 agent 令牌>`。令牌由
  项目方按申请发放（申请制不变）；服务端只存哈希（D1 `agents` 表），
  发放/停用/改限额都是改一行 SQL，不用重部署。
- 工具面：只读 5 个 + `place_order` + `hard_cancel_order`，共 7 个。
  `match_order` 暂未移植（撮合引擎的 Workers 适配在后续轮次），其余
  护栏与 stdio 版完全一致：链/对白名单、单笔/每日/频率限额（计数在
  D1）、全局急停（D1 `config.kill_switch` 置 `1` 或绑定
  `KILL_SWITCH=1`）、审计只追加（D1 `audit_log`）。
- AI 客户端配置（远程形态）：

```json
{
  "mcpServers": {
    "bit100": {
      "url": "https://bit100-mcp.q3874758.workers.dev",
      "headers": { "Authorization": "Bearer <你的 agent 令牌>" }
    }
  }
}
```

- 运维（部署者）：`npm run deploy:worker` 重新部署（建 D1/迁移/上传/
  写 secret/开子域一气呵成，脚本在 `worker/deploy.mjs`，经
  custom.cloudflare 连接器）；`npm run smoke:worker` 对线上端点做
  一次性令牌的真实客户端冒烟（结束时自动退役该令牌）。

`npm run e2e` 会真实走完：挂单→吃单→结算→链上核对→部分成交→硬撤，
并验证主网链被拒、白名单外交易对被拒、超限被拒、停用 agent 被拒、
急停时写拒读通。
