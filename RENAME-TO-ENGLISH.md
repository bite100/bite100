# 将项目文件夹改为英文名

建议英文名：**P2P-Exchange**

## 手动重命名步骤（推荐）

1. **关闭 Cursor**（或其它打开本文件夹的程序），否则可能无法重命名。
2. 在 **资源管理器** 中打开 `D:\`，找到文件夹 **P2P交易所**。
3. 右键该文件夹 → **重命名**，改为 **P2P-Exchange**（或其它英文名，如 `P2PExchange`）。
4. 重新打开 Cursor，**文件 → 打开文件夹**，选择 `D:\P2P-Exchange`。

## 若用命令行（需先关闭 Cursor）

在 **命令提示符** 或 **PowerShell** 中执行（在 `D:\` 下）：

```cmd
cd /d D:\
ren "P2P交易所" "P2P-Exchange"
```

或 PowerShell：

```powershell
Set-Location D:\
Rename-Item -LiteralPath "P2P交易所" -NewName "P2P-Exchange"
```

完成后用 Cursor 打开 `D:\P2P-Exchange` 即可。
