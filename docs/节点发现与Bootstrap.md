# 节点发现与 Bootstrap

本文档说明 P2P 节点如何加入网络、发现对等节点，以及多区域/多运营商下的连通性建议。与 [node/README.md](../node/README.md) 中的运行方式配合使用。

---

## 一、当前发现方式

| 方式 | 说明 |
|------|------|
| **Bootstrap 列表** | 在 `config.yaml` 的 `network.bootstrap` 中配置若干稳定节点的 multiaddr，启动时自动连接并加入 DHT。 |
| **-connect 参数** | 启动时通过 `-connect /ip4/.../tcp/4001/p2p/<PeerID>` 直连指定节点，适合临时测试或单点接入。 |
| **DHT** | 配置了 Bootstrap 后，节点会启动 Kademlia DHT；Bootstrap 连接成功后可通过 DHT 发现更多节点（当前 GossipSub 的 mesh 仍主要依赖已建立的直连）。 |

无 Bootstrap 且未使用 `-connect` 时，节点仅监听本地，需由其他节点主动连接你（例如对方将你的监听地址加入其 Bootstrap 或使用 `-connect` 连到你）。

---

## 二、配置 Bootstrap

### 2.1 获取 Bootstrap 地址

Bootstrap 地址为 **multiaddr** 格式，例如：

```
/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWAbcDef123...
```

- `1.2.3.4`：节点对外 IP（公网或内网）。
- `4001`：该节点监听端口（与 `node.listen` 一致）。
- `12D3KooW...`：该节点的 **PeerID**（启动时在日志中打印：「节点启动 | PeerID: …」）。

在一台已运行的节点上，日志会输出类似：

```
节点启动 | PeerID: 12D3KooW...
  监听: /ip4/0.0.0.0/tcp/4001/p2p/12D3KooW...
```

将 `0.0.0.0` 改为该机器的 **公网 IP**（或对方可访问的 IP），即得到可写入 Bootstrap 的 multiaddr。

### 2.2 写入 config.yaml

在 `node` 目录下（或 `-config` 指定路径）的 `config.yaml` 中：

```yaml
network:
  bootstrap:
    - /ip4/1.2.3.4/tcp/4001/p2p/12D3KooWAbcDef123...
    - /ip4/5.6.7.8/tcp/4001/p2p/12D3KooWXyz789...
  topics:
    - /p2p-exchange/sync/trades
    - /p2p-exchange/sync/orderbook
```

启动后若连接成功，日志会出现「已连接 Bootstrap: \<PeerID\>」。若失败，会打印「连接 bootstrap …: …」，可根据错误排查网络或防火墙。

---

## 三、多区域 / 多运营商连通性

- **公网 IP 与端口**：作为 Bootstrap 的节点需具备可从目标区域访问的 IP，并开放 `node.listen` 中的端口（如 4001）。
- **防火墙**：放行 TCP 4001（或你配置的端口）；若启用 QUIC 等，需一并放行。
- **NAT**：在 NAT 后的节点一般只能「被连接」或通过中继连接；若希望被列为 Bootstrap，建议使用有公网 IP 的 VPS 或做端口映射。
- **多区域部署**：在不同地区/运营商各部署 1～2 个稳定节点，将其 multiaddr 加入公共或团队 Bootstrap 列表，新节点配置同一列表即可接入同一网络，有利于跨区连通。
- **内网测试**：同机或同局域网时，Bootstrap 或 `-connect` 中使用 `127.0.0.1` 或内网 IP 即可；注意同机多节点需用 `-port` 区分端口。

---

## 四、推荐实践

1. **至少配置 1～2 个 Bootstrap**：避免节点孤立；若暂无公共 Bootstrap，可先用自建或团队节点地址。
2. **Bootstrap 节点尽量常在线**：作为入口，短时离线会导致新节点难以入网。
3. **记录并分享 multiaddr**：稳定运行后可将「公网 IP + 端口 + PeerID」整理成 multiaddr 供他人加入 `network.bootstrap`。
4. **与 -connect 配合**：首次部署时可用 `-connect` 先连上一台已知节点，确认连通后再把该节点地址写入 `config.yaml` 的 `bootstrap`，后续重启即可自动连接。

---

## 五、相关文档与配置

| 文档/配置 | 说明 |
|-----------|------|
| [node/README.md](../node/README.md) | 节点运行方式、M1/M2/M3、config 项说明 |
| [node/config.example.yaml](../node/config.example.yaml) | 配置示例，含 `network.bootstrap`、`topics` |
| [Phase2-设计文档](./Phase2-设计文档.md) | 节点类型、同步协议、贡献度量 |
