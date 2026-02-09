# 中继节点 - Windows 电脑端运行脚本（支持自动更新）
# 用法:
#   仅启动:     .\run-relay.ps1
#   后台运行:   .\run-relay.ps1 -Detach
#   自动更新:   .\run-relay.ps1 -AutoUpdate   （拉代码、重新 build、重启容器）
#
# 依赖: Docker Desktop（推荐）或 已安装 Go 时可直接运行二进制

param(
    [switch]$Detach,      # docker compose up -d
    [switch]$AutoUpdate,  # git pull + docker compose build + up -d
    [switch]$Native       # 不用 Docker，用 go run（需本机有 Go）
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$ComposeFile = Join-Path $PSScriptRoot "docker-compose.relay.yml"

function Ensure-Docker {
    if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
    Write-Host "未检测到 Docker。请安装 Docker Desktop 或使用 -Native 用 Go 直接运行。" -ForegroundColor Yellow
    return $false
}

function Start-RelayDocker {
    Push-Location $RepoRoot
    try {
        if ($Detach) {
            docker compose -f $ComposeFile up -d --build
            Write-Host "`n中继节点已在后台启动。API: http://localhost:8080" -ForegroundColor Green
            docker compose -f $ComposeFile ps
        } else {
            docker compose -f $ComposeFile up --build
        }
    } finally {
        Pop-Location
    }
}

function Update-AndRestart {
    Push-Location $RepoRoot
    try {
        Write-Host "拉取最新代码..." -ForegroundColor Cyan
        git pull
        Write-Host "重新构建并启动中继节点..." -ForegroundColor Cyan
        docker compose -f $ComposeFile up -d --build
        Write-Host "`n中继节点已更新并重启。API: http://localhost:8080" -ForegroundColor Green
        docker compose -f $ComposeFile ps
    } finally {
        Pop-Location
    }
}

function Start-RelayNative {
    $nodeDir = Join-Path $RepoRoot "node"
    $configRelay = Join-Path $nodeDir "config.relay-server.yaml"
    $configYaml = Join-Path $nodeDir "config.yaml"
    if (-not (Test-Path $configYaml) -and (Test-Path $configRelay)) {
        Copy-Item $configRelay $configYaml
    }
    Push-Location $nodeDir
    try {
        & go run ./cmd/node -config config.relay-server.yaml
    } finally {
        Pop-Location
    }
}

# --- main ---
if ($AutoUpdate) {
    if (-not (Ensure-Docker)) { exit 1 }
    Update-AndRestart
    exit 0
}

if ($Native) {
    if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
        Write-Host "未检测到 Go。请安装 Go 或使用 Docker 运行。" -ForegroundColor Yellow
        exit 1
    }
    Start-RelayNative
    exit 0
}

if (-not (Ensure-Docker)) { exit 1 }
Start-RelayDocker
