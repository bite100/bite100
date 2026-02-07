# 主网（Ethereum mainnet）一键部署
# 需设置：PRIVATE_KEY, TOKEN0_ADDRESS, TOKEN1_ADDRESS（主网真实 ERC20，如 USDT/USDC/WETH）
# 可选：FEE_RECIPIENT, MAINNET_RPC_URL
#
# 用法：
#   $env:TOKEN0_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"   # USDC
#   $env:TOKEN1_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7"   # USDT
#   .\scripts\deploy-mainnet.ps1

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

$rpc = if ($env:MAINNET_RPC_URL) { $env:MAINNET_RPC_URL.Trim() } else { "https://ethereum.publicnode.com" }

if (-not $env:TOKEN0_ADDRESS -or -not $env:TOKEN1_ADDRESS) {
    Write-Host "必须设置 TOKEN0_ADDRESS 和 TOKEN1_ADDRESS（主网 ERC20 地址）" -ForegroundColor Red
    Write-Host "示例：USDC 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, USDT 0xdAC17F958D2ee523a2206206994597C13D831ec7" -ForegroundColor Gray
    exit 1
}

Write-Host "=== 主网部署（Ethereum mainnet，chainId 1）===" -ForegroundColor Yellow
Write-Host "RPC: $rpc"
Write-Host "TOKEN0: $($env:TOKEN0_ADDRESS)"
Write-Host "TOKEN1: $($env:TOKEN1_ADDRESS)"
Write-Host ""
Write-Host "主网使用真实 ETH，请确认私钥和资金充足。" -ForegroundColor Red
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
Write-Host "从上方输出复制各合约地址，写入 frontend/src/config.ts 的 MAINNET 对象"
Write-Host "主网区块浏览器: https://etherscan.io"
