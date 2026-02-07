# Polygon 主网一键部署
# 需设置：PRIVATE_KEY, TOKEN0_ADDRESS, TOKEN1_ADDRESS（Polygon 上 ERC20 地址）
# 可选：FEE_RECIPIENT, POLYGON_RPC_URL
#
# 用法：
#   $env:TOKEN0_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"   # Polygon USDC
#   $env:TOKEN1_ADDRESS = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"   # Polygon USDT
#   .\scripts\deploy-polygon.ps1

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$contractsDir = Split-Path -Parent $scriptDir
$env:Path = "$env:USERPROFILE\.foundry\versions\stable;$env:Path"

if (Test-Path "$contractsDir\.env") {
    Get-Content "$contractsDir\.env" | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)=(.+)$') {
            $k = $Matches[1].Trim()
            $v = $Matches[2].Trim()
            if ($k -and $v) { [Environment]::SetEnvironmentVariable($k, $v, 'Process') }
        }
    }
}

$rpc = if ($env:POLYGON_RPC_URL) { $env:POLYGON_RPC_URL.Trim() } else { "https://polygon-rpc.com" }

if (-not $env:TOKEN0_ADDRESS -or -not $env:TOKEN1_ADDRESS) {
    Write-Host "必须设置 TOKEN0_ADDRESS 和 TOKEN1_ADDRESS（Polygon 上 ERC20 地址）" -ForegroundColor Red
    Write-Host "示例 Polygon USDC: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" -ForegroundColor Gray
    Write-Host "示例 Polygon USDT: 0xc2132D05D31c914a87C6611C10748AEb04B58e8F" -ForegroundColor Gray
    exit 1
}

Write-Host "=== Polygon 主网部署（chainId 137）===" -ForegroundColor Yellow
Write-Host "RPC: $rpc"
Write-Host "TOKEN0: $($env:TOKEN0_ADDRESS)"
Write-Host "TOKEN1: $($env:TOKEN1_ADDRESS)"
Write-Host ""
Write-Host "将消耗真实 MATIC 作为 gas，请确认私钥和资金充足。" -ForegroundColor Red
$confirm = Read-Host "输入 YES 继续部署"
if ($confirm -ne "YES") {
    Write-Host "已取消" -ForegroundColor Gray
    exit 0
}

Set-Location $contractsDir
$out = forge script script/Deploy.s.sol:Deploy --sig "runMainnetFull()" --rpc-url $rpc --broadcast 2>&1 | Out-String
Write-Host $out

Write-Host ""
Write-Host "=== 完成 ===" -ForegroundColor Green
Write-Host "从上方输出复制各合约地址，写入 frontend/src/config.ts 的 POLYGON 对象"
Write-Host "Polygon 区块浏览器: https://polygonscan.com"