# Relay 部署与 Nginx 反代（wss + HTTPS）

> 路径 2：用户手机浏览器打开前端 → 连公共 relay（wss）→ gasless 交易。Relay 由项目方/社区在 VPS 上运行，轻量模式仅广播 + WebSocket。

---

## 一、Relay 节点轻量模式

在 VPS 上运行节点时，使用 **`--mode=relay`** 可只启 GossipSub + WebSocket，不启撮合引擎与存储，适合纯转发：

```bash
# 示例：轻量 relay（需领奖地址）
./node -config config.yaml -reward-wallet 0xYourAddress --mode=relay
```

- **效果**：不跑 MatchEngine、不落库，只订阅/转发订单主题并向 WebSocket 客户端推送。
- **端口**：API 默认 `:8080`（HTTP + WS），libp2p 默认 `4001`；确保防火墙放行。

---

## 二、Nginx 反代 + wss（HTTPS）

前端需使用 **wss://** 连接 relay，浏览器限制非安全页不能连 ws://。用 Nginx 反代 + Certbot 免费证书即可。

### 2.1 安装 Nginx 与 Certbot（Ubuntu/Debian）

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

### 2.2 申请证书（Let's Encrypt）

```bash
# 先确保域名已解析到本机
sudo certbot --nginx -d relay1.p2p-p2p.xyz
```

按提示选择为域名申请证书，Certbot 会自动修改 Nginx 配置以启用 HTTPS。

### 2.3 Nginx 配置（反代 WebSocket + HTTP API）

在 `/etc/nginx/sites-available/relay1` 新建配置（或放在 `sites-available/default` 的 server 块中）：

```nginx
# HTTP -> HTTPS 重定向（可选）
server {
    listen 80;
    server_name relay1.p2p-p2p.xyz;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name relay1.p2p-p2p.xyz;

    # Certbot 会写入以下路径，若未自动写入可手动指定
    ssl_certificate     /etc/letsencrypt/live/relay1.p2p-p2p.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay1.p2p-p2p.xyz/privkey.pem;

    # WebSocket 反代（wss）
    location /ws {
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_pass http://127.0.0.1:8080;
    }

    # HTTP API 反代
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用并重载：

```bash
sudo ln -sf /etc/nginx/sites-available/relay1 /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 2.4 前端配置

生产环境将 relay 的 wss 地址配置到前端（构建时或运行时）：

```bash
# 构建时注入（示例）
VITE_P2P_WS_URLS=wss://relay1.p2p-p2p.xyz/ws,wss://relay2.p2p-p2p.xyz/ws npm run build
```

用户打开前端后会自动按列表依次尝试连接，断线则 fallback 到下一个 relay。

---

## 三、证书续期

Let's Encrypt 证书约 90 天有效，可用 cron 自动续期：

```bash
sudo crontab -e
# 每月 1 日 3 点续期
0 3 1 * * certbot renew --quiet && systemctl reload nginx
```

---

## 四、相关文档

- [部署与使用说明](./部署与使用说明.md)
- [节点部署](./节点部署.md)
- [设计文档索引](./设计文档索引.md)
