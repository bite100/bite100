# Windows 下安装 Foundry

当前环境未检测到 Foundry（`forge` 命令）。按以下任选一种方式安装后，再在 `contracts` 目录执行验证。

## 方式一：Git BASH + Foundryup（推荐）

1. **安装 Git for Windows**（若未安装）：  
   https://gitforwindows.org/  
   安装后会有 **Git BASH**。

2. **打开 Git BASH**，执行：
   ```bash
   curl -L https://foundry.paradigm.xyz | bash
   ```
   按提示操作，然后执行：
   ```bash
   foundryup
   ```

3. **（可选）把 Foundry 加入 PowerShell 的 PATH**  
   Foundry 会安装在 `C:\Users\<你的用户名>\.foundry\bin`。  
   在 PowerShell 中临时添加：
   ```powershell
   $env:Path += ";$env:USERPROFILE\.foundry\bin"
   ```
   或：**设置 → 系统 → 关于 → 高级系统设置 → 环境变量**，在用户变量 `Path` 中新增：
   `C:\Users\<你的用户名>\.foundry\bin`

4. **关闭并重新打开终端**，然后执行验证：
   ```powershell
   cd d:\P2P\contracts
   .\scripts\install-and-build.ps1
   ```

## 方式二：直接下载预编译包

1. 打开 https://github.com/foundry-rs/foundry/releases  
2. 下载最新版本中的 **Windows 压缩包**（例如 `foundry_nightly_xxx_windows_amd64.zip` 或 release 里的 Windows 包）  
3. 解压到某目录（如 `C:\foundry`），将该目录下的 `bin` 文件夹加入系统 PATH  
4. 在终端执行 `forge --version` 确认可用后，在 `contracts` 目录运行：
   ```powershell
   .\scripts\install-and-build.ps1
   ```

## 验证通过后

- `forge build` 通过：合约编译成功  
- `forge test` 通过：单元测试全部通过  
- 之后可进行部署（见 [README.md](./README.md) 的部署顺序建议）
