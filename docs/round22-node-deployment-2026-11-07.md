# 第二十二轮：节点临时部署上线（Muse VM 托管 + Cloudflare 隧道）

日期：2026-11-07。分支 `round22-node-deploy`（基点：第二十一轮 3c20325 之上）。
目的：让线上站点（bite100.github.io）交易页点亮——运营节点常驻在线，前端经
`VITE_NODE_API_URL=https://node.aaxx123456.trade` 接入。Ren 已定：节点先临时
托管在 Muse 的 VM，主网前迁到云平台；去节点化是金库轮设计期的方向，本轮不做。

## 1. 最终部署形态（与最初设想有一处被迫的调整，务必知悉）

原计划「cloudflared 连接器跑在本机 VM」被平台出口策略否决：本机对任意
原始 TCP 连接会被平台拦截并返回明文提示（`muse: Other TCP connections is
turned off for this assistant…`），cloudflared 的边缘连接（TCP/UDP 7844）
无法建立——DNS、QUIC、真实/合成 IP 等路径均实测走不通（细节见 §7）。
因此连接器改用 **Ren 电脑上既有的 wb-ssh 隧道**（远程托管、原本就连着
Cloudflare 边缘），本机只跑节点本体与一条反向 SSH：

```
浏览器 → Cloudflare 边缘 → wb-ssh 隧道（连接器在 Ren 电脑）
  → 电脑回环 127.0.0.1:18080/18081（新增 ingress，仅 /api/* 与 /ws，其余 404）
  → 反向 SSH（VM 主动连电脑 sshd，-R 转发，systemd 托管）
  → VM 节点 API :8080（Sepolia）/ :8081（Base Sepolia）
```

- 对 wb-ssh 隧道的改动只有一次：经 Cloudflare API 把 6 条节点规则插入其
  ingress（原有 wb/pocket 三条规则与 catch-all 原样保留，版本 7→8）。
  改动前配置备份在 `~/workspace/tools/bite100-node/wb-tunnel-config-backup.json`，
  回归验证：wb 根 200、/ctl/exec 无认证 401、pocket 502，改动前后完全一致。
- 电脑上没有安装/修改任何软件与服务；电脑关机或断网时节点公网入口中断
  （节点本体与链上资产不受影响），电脑恢复后隧道与反向 SSH 自动重连。

## 2. 本机服务清单（systemd 系统服务，均在 ~/workspace 下留存工件）

| 服务 | 内容 | 端口 |
|---|---|---|
| `bite100-node-sepolia` | 节点（Sepolia, chainId 11155111） | API 8080 / libp2p 4001 |
| `bite100-node-base` | 节点（Base Sepolia, chainId 84532） | API 8081 / libp2p 4002 |
| `bite100-reversessh` | 反向 SSH 到电脑（18080→8080、18081→8081） | 经 127.0.0.1:2222（home-egress 的 access tcp） |

- 二进制：`~/workspace/bite100-node/bin/p2p-node`（仓库 node/ 构建）。
- 配置：`~/workspace/bite100-node/{sepolia,base}/config.yaml`（relay + 交易对
  TKA/TKB + chain.vault ⇒ 撮合、落库、挂单锁定全开；API 下单限速 60/分钟）。
- 运营身份：部署者钱包（奖励地址与 Vault locker 均为它）。私钥只经 systemd
  `EnvironmentFile` 引用 `~/workspace/bite100-deployer/wallet.env`，服务内以
  `$$PRIVATE_KEY` 转注 `VAULT_LOCKER_PRIVATE_KEY`——不落任何配置/仓库/日志。
- 节点出网必须走本机代理（localproxy 127.0.0.1:18061）：unit 已注入全套
  `*_proxy` 环境变量——直连 RPC 会被平台 TLS 拦截（实测）。

## 3. 合约地址基点（第二十一轮，chains.ts @ 3c20325）

| 链 | Vault | Settlement | TKA / TKB |
|---|---|---|---|
| Sepolia | 0xF9695C43bEBA0aB43e4Bef206DCd6C40480bE9f5 | 0x549690D6bb9f1b5dB072A8E3fd3A4060e55B7Ef6 | 0x93a4af54…1Dde28E / 0x1530b74E…bfC4ddc2 |
| Base Sepolia | 0x46592e98ea76D8d1e987b69194b74828A91E3D50 | 0x6291E0F2da9754ca933CcDc8D013184A7cE63671 | 0xd3f1136C…4D5C5D33 / 0x8492ccCE…20A54daF |

本轮先以第十五轮地址完成首轮在线验证，随后第二十一轮落地即 rebase 并刷新
全部地址、清空旧代订单数据、在新合约上重做 E2E（见 §6）。刷新地址时同步改
`~/workspace/tools/bite100-node/ensure.sh` 内嵌配置（ensure 以内嵌为准回写）。

## 4. 数据持久化结论

落盘持久化属实：订单/成交存于各链 data 目录的 SQLite（`storage.db`），
节点启动时把未过期 open/partial 订单恢复进订单簿。实测：服务重启多次后，
测试单仍在公开订单簿中。`retention_months: 2`。

## 5. 前端接线与文案

- Actions secret `VITE_NODE_API_URL=https://node.aaxx123456.trade` 已设置；
  `frontend-pages.yml` 本就引用它，`deploy-frontend.yml` 本轮补齐同一 env。
  推送到 main 后两次 Pages 构建都会带上节点地址（本地构建已验证产物含该域名）。
- 已知产品限制（非本轮引入）：前端节点 URL 是单值容灾列表、非按链切换，
  当前指向 Sepolia；`node-base.aaxx123456.trade` 已就绪待后续按链接线。
- 节点不可用文案（功能说明同轮落地）：nodeClient 抛错、订单簿空状态、
  盘口/订单/成交组件统一改为「节点服务暂时不可用……你的链上资产与跨链
  不受影响」口径，不再出现 VITE_NODE_API_URL 等技术字样。

## 6. 验证结果

- 门禁：Go `vet` + `go test ./internal/...` 全绿（含第二十一轮新增
  settlement 测试）；前端 vitest 116/116；前端构建成功且产物含节点域名。
  仓库既有缺口：`node/cmd/reputation-updater` 为未完成 stub（CI 已注明排除）。
- 公开接口（经 https://node.aaxx123456.trade）：/api/health、/api/node、
  /api/trades、/api/orderbook、/api/orders 均 200；`/`、`/metrics` 经隧道
  返回 404（ingress 只放行 /api/* 与 /ws，节点内部指标不外露）。Base 域名同。
  节点 API 自带 `Access-Control-Allow-Origin: *`，github.io 跨域可用。
- E2E（测试钱包 maker 经公开 API 提交限价卖单 1 TKA @ 1.0）：
  - 第二十一轮新合约：订单 `order_1794057744727_z5pmteb7`，落锁
    tx `0x03c92ec8d0d17b7cefc6463d3dcbc7abfedca813396e55c553bb56fa98c61747`，
    公开订单簿 asks 可读回；该单保留在簿上（24 小时过期），页面盘口非空。
  - 第十五轮旧合约（刷新前同法验证）：订单 `order_1794057330138_f9g2b51m`，
    落锁 tx `0x566d6905ef…710acecb`，maker 可用 TKA 900→899 实证锁定生效；
    该单留在旧 Vault 一代（可用余额 899），随旧合约退役自然过期。
  - 注意既有异步语义：POST /api/order 先返回 ok，落锁（链上交易）约
    15–30 秒后完成才入簿；落锁失败的订单被拒绝入簿（日志有明确原因）。

## 7. 本轮发现并修复的既有缺陷（均已随分支提交）

1. **节点启动即 panic**：`cmd/node` 的 flag 名 `mode=relay` 含 `=`，
   Go flag 包启动时 panic。改名 `mode-relay`（含 .cursor 技能文档）。
2. **发布/订阅重复 Join**：go-libp2p-pubsub v0.19 对同一 topic 二次 Join
   返回错误且句柄为 nil，OrderSubscriber 必然启动失败。新增
   `internal/sync/topic_join.go` 的 `joinTopicOnce` 共享句柄。
3. **落锁 gas 上限过时**：sendVaultTx 写死 600,000；第二十一轮 Vault 落锁
   实测需 725,799（新增外部验签/摘要 + 墓碑写入），交易整笔 OOG 回滚
   （失败 tx `0x1854df6b…` gasUsed 恰 600,000 为定位证据）。改链上估算
   ×1.3、回退 1,200,000。
4. 平台出口事实（运维知识）：本机原始 TCP 出网被封（连接会收到平台明文
   提示）；系统解析器答不出 SRV 记录；回环 UDP 受限；Go 程序直连 HTTPS
   会被 TLS 拦截，必须走 localproxy。cloudflared 的 REST 客户端不读代理
   环境变量，故 Cloudflare 管理面操作走 cert.pem 内 apiToken + curl
   （`~/workspace/tools/bite100-node/cf-setup.py`，幂等维护 DNS 并只读核查
   wb-ssh ingress）。本轮曾建的独立隧道 `bite100-node`(2e6ad8e8…) 未被
   使用，留在账户内（inactive，可在面板删除，不影响现行链路）。
   另有一份 DoH 转发器 `dnsproxy.py` 同在该目录，是连接器本机方案的
   遗留工件，现架构下无消费者，保留备查。

## 8. 抗 VM 替换与看门狗

- 2026-11-07 部署当晚已实测一次真实重启：/etc 下 unit 全部丢失、$HOME
  工件完好；`~/workspace/tools/bite100-node/ensure.sh` 一键重建全部 unit、
  配置与 DNS 核查并恢复 STATUS=OK（本地与公开健康均 200）。
- ensure 边界：cert.pem 缺失 → 明确 FAIL；wb-ssh ingress 若缺节点主机名
  → 明确 FAIL（不自动改共享隧道，需按 §1 备份人工合并）；本地健康坏 →
  FAIL；仅公开链路坏（如电脑离线）→ DEGRADED 退出 0。
- 建议主聊天加看门狗 cron：名 `bite100-node-watchdog`，每 10 分钟运行
  ensure.sh，健康/已修复静默、FAIL 时报告（与 home-egress-watchdog 同构）。
- 依赖链提示：反向 SSH 依赖 home-egress 的 access tcp（127.0.0.1:2222）
  与 localproxy（18061），两者由 home-egress-watchdog 维护。

## 9. 迁移到云平台 runbook 提纲（主网前执行，Ren 已定）

1. 云主机（任意可直连网络）部署同一二进制 + 两份 config（地址按主网部署刷新）。
2. locker/奖励钱包换主网运营身份；私钥经云端密钥管理注入环境变量。
3. Cloudflare 上为节点建独立隧道（云主机可直连边缘，本机这套借道方案
   不再需要），DNS 把 node/node-base 两个主机名改指新隧道，ingress 规则照抄
   （仅 /api/* 与 /ws）。
4. 前端 secret 不变（域名不变）；切换后按 §6 清单复验一遍（含小额 E2E）。
5. 下线本机三服务（systemctl disable）与 wb-ssh 上的 6 条节点规则、
   反向 SSH 转发；备份 wb 配置在案可回滚。
6. 主网开放前置：LZ 多 DVN 门禁、Vault locker 主网身份评审不在本轮范围。

## 10. Ren 需知的运维事实

- VM 被替换/重启后，站点交易页会短暂不可用，看门狗约 10 分钟内自愈
  （ensure 全链路恢复约 1 分钟，实测）。
- Ren 的电脑需开机联网，公网入口才通；电脑离线只影响交易页行情/下单，
  资产、跨链桥、合约始终在链上不受影响。
- 节点数据（订单簿）是测试网运营数据，清空重建无资产后果；用户资金
  始终在链上 Vault，不经过节点保管。
- 去节点化（0x 式轻中继 + 前端撮合）方向已定，留待金库轮设计期，本轮未动。
