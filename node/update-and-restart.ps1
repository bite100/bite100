# P2P 节点 - 自动更新并自动重启
# 用法: .\update-and-restart.ps1
# 拉代码、重新构建 node.exe，停止当前运行的节点并用保存的领奖地址重新启动
# 可放入 Windows 计划任务定时执行，或由 GUI「检查更新」调用

$ErrorActionPreference = "Stop"
$nodeDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $nodeDir "..")).Path
$savedAddrPath = Join-Path $nodeDir ".last-reward-wallet.txt"

function Stop-P2PNode {
    # 停止本目录下的 node.exe（命令行含 -reward-wallet）或 go run ./cmd/node
    $killed = 0
    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -like "*reward-wallet*"
        } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $script:killed++
        }
        Get-CimInstance Win32_Process -Filter "Name='go.exe'" -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -like "*cmd/node*" -and $_.CommandLine -like "*reward-wallet*"
        } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $script:killed++
        }
    } catch {}
    return $killed
}

Push-Location $repoRoot
try {
    Write-Host "拉取最新代码..." -ForegroundColor Cyan
    $pullOut = git pull 2>&1
    Write-Host $pullOut

    if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
        Write-Host "未检测到 Go，无法重新构建。请安装 Go 后重试，或使用 Docker 部署。" -ForegroundColor Yellow
        exit 1
    }

    Set-Location $nodeDir
    Write-Host "`n重新构建 node.exe ..." -ForegroundColor Cyan
    go build -o node.exe ./cmd/node
    if ($LASTEXITCODE -ne 0) {
        Write-Host "构建失败。" -ForegroundColor Red
        exit 1
    }

    Write-Host "`n正在停止当前节点进程..." -ForegroundColor Cyan
    $n = Stop-P2PNode
    if ($n -gt 0) {
        Write-Host "已停止 $n 个节点进程。"
        Start-Sleep -Seconds 2
    }

    # 读取曾保存的领奖地址（GUI 勾选「记住地址」时写入）
    $addr = ""
    if (Test-Path $savedAddrPath) {
        try {
            $addr = (Get-Content $savedAddrPath -Raw -ErrorAction SilentlyContinue).Trim()
            if ($addr.Length -ne 42 -or -not $addr.StartsWith("0x")) { $addr = "" }
        } catch {}
    }
    if ($addr -eq "" -and $env:REWARD_WALLET) {
        $addr = $env:REWARD_WALLET.Trim()
        if ($addr.Length -ne 42 -or -not $addr.StartsWith("0x")) { $addr = "" }
    }

    Write-Host "`n正在启动节点..." -ForegroundColor Cyan
    if ($addr) {
        $cmd = "Set-Location '$nodeDir'; .\run.ps1 -rewardWallet '$addr'"
        Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmd
        Write-Host "节点已在新窗口启动（领奖地址已从保存/环境变量读取）。" -ForegroundColor Green
    } else {
        $cmd = "Set-Location '$nodeDir'; .\run.ps1"
        Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmd
        Write-Host "节点已在新窗口启动（领奖地址请从配置文件或环境变量 REWARD_WALLET 读取）。" -ForegroundColor Green
    }
} finally {
    Pop-Location
}
