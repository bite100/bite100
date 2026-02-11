# 部署 P2P 节点到 Railway / Fly.io（免绑卡）

前端继续用 **GitHub Pages** 免费托管；节点可部署到 Railway 或 Fly.io，用 GitHub 登录即可，无需绑卡。

**还没注册？** 先看 [Railway与Fly领取教程.md](./Railway与Fly领取教程.md) 完成账号注册与免费领取，再按本文部署节点。

---

## 一、前端：GitHub Pages（推送到仓库即自动更新）

- 仓库已配置 `.github/workflows/frontend-pages.yml`：**只要推送到 `main` 分支，GitHub Actions 会自动构建并发布到 GitHub Pages，交易所网站会更新为最新版本**，无需手动打包或上传。
- 在仓库 **Settings → Pages** 里将 Source 选为 **GitHub Actions**（只需配置一次）。
- 访问地址：`https://<用户名>.github.io/<仓库名>/`（例如 [bite100/bite100](https://github.com/bite100/bite100) 为 `https://bite100.github.io/bite100/`）。若仓库名不是 `用户名.github.io`，需在 **Settings → Secrets** 中设置 `VITE_BASE=/仓库名/`（如 `/bite100/`），工作流已支持该变量；若使用自定义域名，在 Pages 设置里绑定域名，并设 `VITE_BASE=/` 或不设。

---

## 二、节点：Railway 部署（推 main 即自动部署节点）

1. 打开 [railway.app](https://railway.app)，用 **GitHub** 登录。
2. **New Project** → **Deploy from GitHub repo**，选择本仓库（如 bite100/bite100）。
3. **必须**把 **Root Directory** 设为 **`node`**：在 Railway 里点进你刚创建的服务 → 左侧或右上 **Settings** → 找到 **Source** 区域 → 在 **Root Directory** 一栏填 **`node`**（这样构建目录是 `node/`，会使用其中的 `Dockerfile` 和 `railway.json`）。
4. **Variables** 里添加：
   - `REWARD_WALLET` = `0x你的领奖地址`（42 字符，必填）。
5. **Settings** 里为服务添加 **Public Networking**，暴露端口 **8080**（HTTP）。
6. 部署完成后，Railway 会给出一个公网 URL（如 `https://xxx.up.railway.app`）。在 GitHub 仓库 **Settings → Secrets** 里添加 `VITE_NODE_API_URL` = 该 URL，**下次推送到 main 时网站会自动用新节点**，无需本地再构建。

**自动部署节点**：Railway 连接 GitHub 后，**默认会在你推送到所连分支（如 main）时自动重新构建并部署该服务**。可在该服务的 **Settings** 里确认已开启「Deploy on push」或类似选项，这样改完 `node/` 代码后推 main，节点会自动更新。

**注意**：Railway 免费额度有限，超出需绑卡；节点可设为「无流量时休眠」以节省额度。

### 若出现「Railpack 无法确定如何构建」或「start.sh 未找到」

说明 Railway 在用 Nixpacks 从错误目录构建。请检查：

- **Root Directory** 是否已设为 **`node`**（不能为空、不能是仓库根）。设为 `node` 后，构建会在 `node/` 下进行，仓库里的 `node/railway.json` 会指定使用 **Dockerfile** 构建。
- 若已设为 `node` 仍报错：在 Railway 该服务的 **Settings → Build** 中，将 **Builder** 手动选为 **Dockerfile**，再触发一次 **Redeploy**。

---

## 三、节点：Fly.io 部署（推 main 即自动部署节点）

### 首次：在 Fly 上创建应用并配好 Secret

1. 安装 [Fly CLI](https://fly.io/docs/hub/installing/)（可选，也可用网页）。
2. 在终端进入**仓库里的 node 目录**：
   ```bash
   cd node
   ```
3. 首次部署：
   ```bash
   fly launch --no-deploy
   ```
   按提示选 region、应用名（或直接回车用默认，如 `p2p-node`）。
4. 设置领奖地址（Secret）：
   ```bash
   fly secrets set REWARD_WALLET=0x你的领奖地址
   ```
5. 部署一次：
   ```bash
   fly deploy
   ```
6. 查看公网地址：
   ```bash
   fly open --url
   ```
   或到 [Fly Dashboard](https://fly.io/dashboard) 查看应用 URL。在 GitHub 仓库 **Settings → Secrets** 里添加 `VITE_NODE_API_URL` = 该 URL，**下次推送到 main 时网站会自动连到该节点**。

### 自动部署：推 main 后节点自动更新

仓库已配置 `.github/workflows/deploy-node-fly.yml`：**当 `node/` 目录有变更并推送到 `main` 时，GitHub Actions 会自动执行 `fly deploy`，节点会自动更新**。

**需要你在 GitHub 仓库里配置一次**：

1. 打开 [Fly.io Personal Access Tokens](https://fly.io/user/personal_access_tokens)，创建一个 Token（如命名为 `github-actions`）。
2. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 里添加：
   - **`FLY_API_TOKEN`**（必填）：刚才复制的 Fly API Token。
   - **`FLY_APP_NAME`**（可选）：你的 Fly 应用名，与 `node/fly.toml` 里 `app = "..."` 一致可不填。

配置完成后，之后只要改 `node/` 代码并推送到 `main`，节点会自动重新部署，无需再本地执行 `fly deploy`。

**说明**：`node/fly.toml` 已配置 HTTP 8080、512MB 内存；无配置文件时节点会默认监听 `:8080` 并开启 API。

---

## 四、前端连上云节点

- 前端默认从环境变量读取节点 API：`VITE_NODE_API_URL`（或 `VITE_NODE_API_URLS` 逗号分隔多节点）。
- **本地/本机开发**：在 `frontend/.env` 或 `.env.local` 里写：
  ```env
  VITE_NODE_API_URL=https://你的节点URL
  ```
- **GitHub Pages 线上**：在仓库 **Settings → Secrets** 里加 `VITE_NODE_API_URL`（节点公网 URL）即可，工作流已自动传入。**每次推送到 main，网站都会自动重新构建并更新**，线上前端会使用该节点。

---

## 五、日常更新流程（改完代码如何让网站变）

1. 本地改完前端或文档后执行：`git add .` → `git commit -m "..."` → `git push origin main`。
2. 推送到 `main` 后，**GitHub Actions 自动跑 frontend-pages 工作流**，构建并部署到 GitHub Pages。
3. 一两分钟后打开你的 Pages 地址（如 `https://bite100.github.io/bite100/`），**交易所网站已是新版本**，无需再手动发布。

**节点**：Railway 连接 GitHub 后默认「推 main 即自动重新部署」该服务；Fly.io 在配置好 `FLY_API_TOKEN` 后由 `deploy-node-fly.yml` 在推 main 且 `node/` 有变更时自动执行 `fly deploy`，节点也会自动更新。

---

## 六、简要对照

| 项目       | 说明 |
|------------|------|
| 前端 / 网站 | GitHub Pages；**推 main 即自动更新网站**，Source 选 GitHub Actions。 |
| 节点 Railway | 根目录选 `node`，设 `REWARD_WALLET`，暴露 8080；**推 main 即自动部署节点**。 |
| 节点 Fly.io  | 首次 `cd node` → `fly launch` → `fly secrets set REWARD_WALLET` → `fly deploy`；在 GitHub 配好 `FLY_API_TOKEN` 后**推 main 即自动部署节点**（见 workflow `deploy-node-fly.yml`）。 |
| 前端连节点 | 在仓库 Secrets 设置 `VITE_NODE_API_URL` 为节点公网 URL，下次推 main 后线上网站会连到该节点。 |
