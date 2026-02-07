# 推送到 GitHub 并开启 Pages 部署

按下面顺序做即可：注册/登录 GitHub → 建仓 → 本地推送 → 开启 Pages（GitHub Actions）→ 记下在线地址并更新 README。

---

## 当前仓库：P2P-P2P/p2p

- **仓库地址**：https://github.com/P2P-P2P/p2p  
- **部署后前端地址**：https://P2P-P2P.github.io/p2p/

推送前请用 **P2P-P2P** 账号登录（或使用该账号的 Personal Access Token）。在项目根目录执行：

```powershell
cd D:\P2P
git remote add origin https://github.com/P2P-P2P/p2p.git
git branch -M main
git push -u origin main
```

若已添加过 remote 但地址不对，可先删除再加：`git remote remove origin`。若提示 `origin already exists`，说明 remote 已正确，直接执行 `git push -u origin main` 即可。

推送成功后，到仓库 **Settings → Pages** 将 **Source** 选为 **GitHub Actions**，即可自动部署。

---

## 1. 新建/使用 GitHub 账号

- 打开 **https://github.com**，若没有账号点 **Sign up** 注册（邮箱 + 密码）。
- 登录后进入首页。

---

## 2. 在 GitHub 上新建仓库

1. 右上角 **+** → **New repository**。
2. **Repository name** 填：`P2P`（或你喜欢的名字，例如 `p2p-exchange`）。
3. 选 **Public**，**不要**勾选 “Add a README” （本地已有代码）。
4. 点 **Create repository**。
5. 记下仓库地址，形如：`https://github.com/你的用户名/P2P.git`。

---

## 3. 在本地初始化 Git 并推送

在项目根目录 `D:\P2P` 下打开终端（PowerShell 或 Git Bash），依次执行：

```powershell
cd D:\P2P

# 若尚未初始化
git init

# 添加所有文件（.gitignore 会排除 .env、node_modules 等）
git add .
git commit -m "Phase 1: 合约 + 前端 + 部署配置"

# 添加远程仓库（把下面地址换成你在第 2 步得到的仓库地址）
git remote add origin https://github.com/你的用户名/P2P.git

# 推送到 main（若默认分支是 master 则写 master）
git branch -M main
git push -u origin main
```

- 若提示要登录，用 GitHub 用户名 + **Personal Access Token**（密码处填 Token）。  
- 生成 Token：GitHub → **Settings → Developer settings → Personal access tokens → Generate new token**，勾选 `repo` 等权限。

---

## 4. 在仓库里开启 GitHub Pages（Actions）

1. 打开你的仓库页面：`https://github.com/你的用户名/P2P`。
2. 点 **Settings** → 左侧 **Pages**。
3. 在 **Build and deployment** 里：
   - **Source** 选 **GitHub Actions**。
4. 保存后，每次推送到 `main`（或 `master`）都会自动跑 `.github/workflows/deploy-frontend.yml`，把前端部署到 Pages。

第一次推送后等 1～2 分钟，到 **Actions** 里看 workflow 是否跑成功。

---

## 5. 记下在线地址并更新 README

- 部署成功后，前端地址为：  
  **https://你的用户名.github.io/P2P/**  
  （若仓库名改成了别的，把 `P2P` 换成仓库名。）

- 打开项目根目录的 **README.md**，找到「部署完成后，将此处替换为你的实际在线地址」那句，改成你的真实链接，例如：

  ```markdown
  部署完成后，前端地址：https://你的用户名.github.io/P2P/
  ```

保存后可以再执行一次 `git add README.md`、`git commit -m "更新在线地址"`、`git push`。

---

## 小结

| 步骤 | 你做啥 |
|------|--------|
| 1 | 在 github.com 注册/登录 |
| 2 | 新建仓库（如 P2P），不要勾选 README |
| 3 | 本地 `git init` → `add` → `commit` → `remote add origin` → `push` |
| 4 | 仓库 **Settings → Pages → Source: GitHub Actions** |
| 5 | 记下 `https://<用户名>.github.io/<仓库名>/`，把 README 里的占位改成这个链接 |

新建 GitHub 账号、建仓、选 Pages 为 GitHub Actions 都在网页完成；推送在本地用上面的命令即可。
