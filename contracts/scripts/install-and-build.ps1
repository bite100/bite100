# 在 contracts 目录下运行：安装 forge-std、构建、测试
# 用法：在 PowerShell 中先 cd 到本仓库的 contracts 目录，再执行 .\scripts\install-and-build.ps1
# 需要已安装 Foundry：https://getfoundry.sh

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

if (-not (Get-Command forge -ErrorAction SilentlyContinue)) {
    Write-Host "未找到 forge 命令，请先安装 Foundry: https://getfoundry.sh"
    exit 1
}

if (-not (Test-Path "lib\forge-std")) {
    Write-Host "安装 forge-std..."
    forge install foundry-rs/forge-std --no-commit
}

Write-Host "构建..."
forge build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "运行测试..."
forge test
exit $LASTEXITCODE
