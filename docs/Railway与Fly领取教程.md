# Railway 与 Fly.io 免费领取与注册教程

不绑卡、无学生身份也可用。用 **GitHub 账号** 登录即可获得免费额度，再按 [部署-Railway与Fly.md](./部署-Railway与Fly.md) 部署 P2P 节点。

---

## 一、Railway 领取与注册

### 1. 打开官网

- 浏览器打开：**https://railway.app**

### 2. 注册 / 登录（免绑卡）

1. 点击页面上的 **「Login」** 或 **「Start a New Project」**。
2. 选择 **「Login with GitHub」**（用 GitHub 登录）。
3. 浏览器会跳转到 GitHub，按提示 **授权 Railway** 访问你的 GitHub 账号（可只授权部分仓库）。
4. 授权后自动回到 Railway，即表示**已注册并登录**，无需邮箱验证、无需绑卡。

### 3. 免费额度说明

- Railway 新用户会获得一定量的 **免费额度**（约 $5 试用等，以官网当前说明为准）。
- 用量在免费额度内：**不会要求绑卡**；超出后如需继续用，才需添加付款方式。
- 可在 **Account → Usage** 或项目 **Usage** 里查看当前用量。
- 建议：把服务设为「无流量时休眠」、只跑一个轻量节点，一般不会很快超限。

### 4. 下一步

- 账号有了之后，按 [部署-Railway与Fly.md#二节点railway-部署](./部署-Railway与Fly.md#二节点railway-部署)：
  - New Project → Deploy from GitHub repo → 选仓库 → **Root Directory 必须填 `node`**（否则会报「Railpack 无法确定如何构建」）→ Variables 里加 `REWARD_WALLET` → Settings 里开 Public Networking 暴露 **8080**。

---

## 二、Fly.io 领取与注册

### 1. 打开官网

- 浏览器打开：**https://fly.io**

### 2. 注册 / 登录（免绑卡）

1. 点击 **「Get Started」** 或 **「Sign Up」**。
2. 选择 **「Sign in with GitHub」**（用 GitHub 登录）。
3. 跳转到 GitHub 后**授权 Fly.io**，授权完成即回到 Fly.io，表示**已注册并登录**。
4. 首次使用可能会提示「验证手机号」：部分区域/账号需要，用于防滥用；**不要求绑卡**。

### 3. 免费额度说明

- Fly.io 提供 **免费 tier**：少量 VM、一定流量等（以官网 **Pricing** 页为准）。
- 在免费额度内使用：**不需要添加信用卡**。
- 可在 **Dashboard** 或 **Account → Billing** 查看用量。
- 本项目的 `node/fly.toml` 已按 512MB 内存、单 VM 配置，一般落在免费范围内。

### 4. 安装 Fly CLI（可选，推荐）

- **Windows（PowerShell）**：
  ```powershell
  iwr https://fly.io/install.ps1 -useb | iex
  ```
- **macOS / Linux**：
  ```bash
  curl -L https://fly.io/install.sh | sh
  ```
- 安装后终端执行 `fly version` 能显示版本即表示成功。
- 首次使用需登录：在终端执行 **`fly auth login`**，按提示用浏览器完成 GitHub 登录。

### 5. 下一步

- 注册并（可选）装好 CLI 后，按 [部署-Railway与Fly.md#三节点flyio-部署](./部署-Railway与Fly.md#三节点flyio-部署)：
  - `cd node` → `fly launch --no-deploy` → `fly secrets set REWARD_WALLET=0x你的地址` → `fly deploy`。

---

## 三、没有 GitHub 怎么办？

- 两个平台都**强烈依赖 GitHub 登录**，没有 GitHub 账号时：
  1. 打开 **https://github.com** → **Sign up**，用邮箱注册（免费）。
  2. 注册后再到 Railway / Fly.io 用 **Login with GitHub** 即可完成「领取」与注册。

---

## 四、简要对照

| 步骤       | Railway | Fly.io |
|------------|---------|--------|
| 打开       | https://railway.app | https://fly.io |
| 注册方式   | Login with GitHub | Sign in with GitHub |
| 是否绑卡   | 否（免费额度内） | 否（免费 tier 内） |
| 可选 CLI   | 网页即可完成部署 | 建议装 `fly` CLI 方便部署 |
| 部署节点   | 见 [部署-Railway与Fly.md#二](./部署-Railway与Fly.md#二节点railway-部署) | 见 [部署-Railway与Fly.md#三](./部署-Railway与Fly.md#三节点flyio-部署) |

完成上述「领取」与注册后，直接按 [部署-Railway与Fly.md](./部署-Railway与Fly.md) 把 P2P 节点部署上去即可；前端继续用 GitHub Pages。
