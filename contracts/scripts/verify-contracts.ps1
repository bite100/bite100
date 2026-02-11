# 合约验证脚本：在 Etherscan 等区块浏览器验证源码
# 用法：
#   1. 确保 .env 有 ETHERSCAN_API_KEY（Sepolia）或对应链的 API Key
#   2. 设置合约地址环境变量，或使用默认 Sepolia 地址
#   3. 运行: .\scripts\verify-contracts.ps1
#
# 示例（验证 Sepolia 上单合约）：
#   $env:VAULT_ADDRESS = "0xbe3962Eaf7103d05665279469FFE3573352ec70C"
#   $env:ETHERSCAN_API_KEY = "YourKey"
#   .\scripts\verify-contracts.ps1

$ErrorActionPreference = "Stop"
$env:Path = "$env:USERPROFILE\.foundry\bin;$env:Path"

$contractsDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (Test-Path "$contractsDir\.env") {
    Get-Content "$contractsDir\.env" | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)=(.+)$') {
            $k = $Matches[1].Trim()
            $v = $Matches[2].Trim()
            if ($k -and $v) { [Environment]::SetEnvironmentVariable($k, $v, 'Process') }
        }
    }
}

$rpc = $env:SEPOLIA_RPC_URL ?? "https://ethereum-sepolia.publicnode.com"
$chainId = 11155111
$apiKey = $env:ETHERSCAN_API_KEY
if (-not $apiKey) {
    Write-Host "请设置 ETHERSCAN_API_KEY（从 etherscan.io 获取）" -ForegroundColor Yellow
    Write-Host "示例: `$env:ETHERSCAN_API_KEY = 'YourApiKey'" -ForegroundColor Cyan
    exit 1
}

Set-Location $contractsDir

# Sepolia 默认地址（可覆盖）
$vault = $env:VAULT_ADDRESS ?? "0xbe3962Eaf7103d05665279469FFE3573352ec70C"
$feeDist = $env:FEE_DISTRIBUTOR_ADDRESS ?? "0xeF4BFB58541270De18Af9216EB0Cd8EC07a2547F"
$settlement = $env:SETTLEMENT_ADDRESS ?? "0x493Da680973F6c222c89eeC02922E91F1D9404a0"

$verified = 0

# Vault：无构造函数参数
Write-Host "`n=== 验证 Vault ===" -ForegroundColor Cyan
$out = forge verify-contract $vault src/Vault.sol:Vault --chain-id $chainId --etherscan-api-key $apiKey 2>&1
if ($LASTEXITCODE -eq 0) { Write-Host "Vault OK" -ForegroundColor Green; $verified++ } else { Write-Host $out }

# FeeDistributor：无构造函数参数
Write-Host "`n=== 验证 FeeDistributor ===" -ForegroundColor Cyan
$out = forge verify-contract $feeDist src/FeeDistributor.sol:FeeDistributor --chain-id $chainId --etherscan-api-key $apiKey 2>&1
if ($LASTEXITCODE -eq 0) { Write-Host "FeeDistributor OK" -ForegroundColor Green; $verified++ } else { Write-Host $out }

# Settlement：构造函数 (vault, feeDistributor)
Write-Host "`n=== 验证 Settlement ===" -ForegroundColor Cyan
$ctorArgs = $(cast abi-encode "constructor(address,address)" $vault $feeDist 2>$null)
if ($ctorArgs) {
    $out = forge verify-contract $settlement src/Settlement.sol:Settlement --chain-id $chainId --etherscan-api-key $apiKey --constructor-args $ctorArgs 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host "Settlement OK" -ForegroundColor Green; $verified++ } else { Write-Host $out }
} else {
    Write-Host "需安装 cast 以编码 constructor args，跳过 Settlement" -ForegroundColor Yellow
}

Write-Host "`n=== 完成：已验证 $verified 个合约 ===" -ForegroundColor Green
Write-Host "更多合约（AMMPool、Governance 等）需按构造函数参数手动验证，见 docs/主网部署指南.md"
