# P2P 节点 - Docker 无人值守自动更新并重启（Windows）
# 用法: 在仓库根目录执行 .\scripts\docker\auto-update-and-restart.ps1
# 或放入 Windows 计划任务定时执行（程序 powershell.exe，参数 -NoProfile -ExecutionPolicy Bypass -File "D:\P2P\scripts\docker\auto-update-and-restart.ps1"）

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$ComposeFile = Join-Path $RepoRoot "docker-compose.prod.yml"
$EnvFile = Join-Path $RepoRoot ".env"

Set-Location $RepoRoot

Write-Host "拉取最新代码..." -ForegroundColor Cyan
git pull

Write-Host "`n重新构建并启动节点容器..." -ForegroundColor Cyan
if (Test-Path $EnvFile) {
    docker compose -f $ComposeFile --env-file $EnvFile build --no-cache
    docker compose -f $ComposeFile --env-file $EnvFile up -d --force-recreate
} else {
    Write-Host "未找到 .env，使用默认环境变量。建议复制 .env.example 为 .env 并填写 REWARD_WALLET 等。" -ForegroundColor Yellow
    docker compose -f $ComposeFile build --no-cache
    docker compose -f $ComposeFile up -d --force-recreate
}

Write-Host "`n节点已更新并运行。" -ForegroundColor Green
docker compose -f $ComposeFile ps
