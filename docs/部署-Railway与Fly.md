# 部署 P2P 节点到 Railway / Fly.io（免绑卡）

前端继续用 **GitHub Pages** 免费托管；节点可部署到 Railway 或 Fly.io，用 GitHub 登录即可，无需绑卡。

**还没注册？** 先看 [Railway与Fly领取教程.md](./Railway与Fly领取教程.md) 完成账号注册与免费领取，再按本文部署节点。

---

## 一、前端：GitHub Pages（已有工作流）

- 仓库已配置 `.github/workflows/frontend-pages.yml`，推送到 `main` 后自动构建并发布到 GitHub Pages。
- 在仓库 **Settings → Pages** 里将 Source 选为 **GitHub Actions**。
- 访问地址：`https://<用户名>.github.io/<仓库名>/`。若仓库名不是 `用户名.github.io`，需在 **Settings → Secrets** 中设置 `VITE_BASE=/仓库名/`（如 `/P2P/`），工作流已支持该变量；若使用自定义域名，在 Pages 设置里绑定域名，并设 `VITE_BASE=/` 或不设。

---

## 二、节点：Railway 部署

1. 打开 [railway.app](https://railway.app)，用 **GitHub** 登录。
2. **New Project** → **Deploy from GitHub repo**，选择本仓库。
3. 在项目设置里把 **Root Directory** 设为 **`node`**（重要：这样会使用 `node/Dockerfile` 构建）。
4. **Variables** 里添加：
   - `REWARD_WALLET` = `0x你的领奖地址`（42 字符，必填）。
5. **Settings** 里为服务添加 **Public Networking**，暴露端口 **8080**（HTTP）。
6. 部署完成后，Railway 会给出一个公网 URL（如 `https://xxx.up.railway.app`），前端里的 **节点 API 地址** 填这个 URL 即可（例如 `VITE_NODE_API_URL=https://xxx.up.railway.app`，重新构建前端）。

**注意**：Railway 免费额度有限，超出需绑卡；节点可设为「无流量时休眠」以节省额度。

---

## 三、节点：Fly.io 部署

1. 安装 [Fly CLI](https://fly.io/docs/hub/installing/)（可选，也可用网页）。
2. 在终端进入**仓库里的 node 目录**：
   ```bash
   cd node
   ```
3. 首次部署：
   ```bash
   fly launch --no-deploy
   ```
   按提示选 region、应用名（或直接回车用默认）。
4. 设置领奖地址（Secret）：
   ```bash
   fly secrets set REWARD_WALLET=0x你的领奖地址
   ```
5. 部署：
   ```bash
   fly deploy
   ```
6. 查看公网地址：
   ```bash
   fly open --url
   ```
   或到 [Fly Dashboard](https://fly.io/dashboard) 查看应用 URL。前端 **节点 API 地址** 填该 URL（如 `https://p2p-node.fly.dev`），并在前端构建时设置 `VITE_NODE_API_URL`。

**说明**：`node/fly.toml` 已配置 HTTP 8080、512MB 内存；无配置文件时节点会默认监听 `:8080` 并开启 API。

---

## 四、前端连上云节点

- 前端默认从环境变量读取节点 API：`VITE_NODE_API_URL`（或 `VITE_NODE_API_URLS` 逗号分隔多节点）。
- **本地/本机开发**：在 `frontend/.env` 或 `.env.local` 里写：
  ```env
  VITE_NODE_API_URL=https://你的节点URL
  ```
- **GitHub Pages 线上**：构建时需带上该变量。可在 **Settings → Secrets** 里加 `VITE_NODE_API_URL`，在 `frontend-pages.yml` 的 build 步骤里传入（或使用 GitHub Actions 的 env），例如：
  ```yaml
  - name: Build frontend
    working-directory: frontend
    env:
      VITE_NODE_API_URL: ${{ secrets.VITE_NODE_API_URL }}
    run: npm run build
  ```
  这样推 main 后，Pages 上的前端会连到你部署的节点。

---

## 五、简要对照

| 项目       | 说明 |
|------------|------|
| 前端       | GitHub Pages，用现有 `frontend-pages.yml`，Source 选 GitHub Actions。 |
| 节点 Railway | 根目录选 `node`，设 `REWARD_WALLET`，暴露 8080。 |
| 节点 Fly.io  | `cd node` → `fly launch --no-deploy` → `fly secrets set REWARD_WALLET=0x...` → `fly deploy`。 |
| 前端连节点 | 构建时设置 `VITE_NODE_API_URL` 为节点公网 URL。 |
