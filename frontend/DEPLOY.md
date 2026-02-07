# 前端部署到 Vercel / Netlify / GitHub Pages

打包命令：在 `frontend` 目录下执行 `npm run build`，产物在 `dist/`。

---

## 一、Vercel（推荐，最简单）

1. 打开 [vercel.com](https://vercel.com)，用 GitHub 登录。
2. 点击 **Add New → Project**，导入本仓库（或先 push 到 GitHub 再导入）。
3. **Root Directory** 设为 `frontend`（若仓库根目录就是 frontend 则不用改）。
4. **Build Command** 留空或填 `npm run build`，**Output Directory** 填 `dist`。
5. 点击 **Deploy**，完成后会得到 `https://xxx.vercel.app`。

**或本地用 Vercel CLI：**

```bash
cd frontend
npm i -g vercel
vercel
```

按提示登录并部署，会生成预览与生产链接。

---

## 二、Netlify

1. 打开 [netlify.com](https://www.netlify.com)，用 GitHub 登录。
2. **Add new site → Import an existing project**，选择仓库。
3. **Base directory** 填 `frontend`。
4. **Build command**：`npm run build`；**Publish directory**：`frontend/dist`（或相对仓库根填 `dist` 且 Base 为 `frontend`）。
5. 部署完成后得到 `https://xxx.netlify.app`。

**或拖拽部署：** 在 `frontend` 下执行 `npm run build`，把生成的 `dist` 文件夹拖到 [Netlify Drop](https://app.netlify.com/drop)。

---

## 三、GitHub Pages

1. 在仓库 **Settings → Pages**，Source 选 **GitHub Actions**。
2. 在项目根目录新建 `.github/workflows/deploy-frontend.yml`（见下方示例）。
3. 推送后 Actions 会自动构建并部署。页面地址为 `https://<用户名>.github.io/<仓库名>/`。
4. 若用项目页（带子路径），需在 `frontend/vite.config.ts` 里设置 `base: '/<仓库名>/'`，否则用默认 `base: '/'`（仅当部署到根域名时）。

**Workflow 示例（.github/workflows/deploy-frontend.yml）：**

```yaml
name: Deploy frontend to GitHub Pages
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
        working-directory: frontend
      - run: npm run build
        working-directory: frontend
        env:
          # 若 base 为 /repo-name/，可在此设置
          # VITE_BASE: '/${{ github.event.repository.name }}/'
      - uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: frontend/dist
```

若页面在 `https://xxx.github.io/RepoName/`，需在 `frontend/vite.config.ts` 中设置 `base: '/RepoName/'` 再构建。

---

## 部署后

- 用生成的 **https 链接**在手机或电脑浏览器打开即可。
- 连接钱包时请切换到 **Sepolia** 网络；合约地址已在代码中配置，无需改环境变量。
