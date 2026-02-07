# 治理与配置部署脚本
# 1. 部署 Governance，绑定 Settlement / AMMPool / ContributorReward
# 2. 部署 TokenRegistry、ChainConfig，设置 GOVERNANCE_ADDRESS
#
# 用法：
#   1. 确保 contracts/.env 有 PRIVATE_KEY（owner 私钥）
#   2. 设置环境变量或修改下方地址
#   3. 运行: .\deploy-governance.ps1

$ErrorActionPreference = "Stop"

# Foundry 路径
$env:Path = "$env:USERPROFILE\.foundry\versions\stable;$env:Path"

# 加载 .env
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

# Sepolia 已部署地址（见 README）
$rpc = if ($env:SEPOLIA_RPC_URL) { $env:SEPOLIA_RPC_URL } else { "https://ethereum-sepolia.publicnode.com" }
$env:SEPOLIA_RPC_URL = $rpc   # foundry.toml rpc_endpoints 会读取
$settlement = if ($env:SETTLEMENT_ADDRESS) { $env:SETTLEMENT_ADDRESS } else { "0xDa9f738Cc8bF4a312473f1AAfF4929b367e22C85" }
$ammPool    = if ($env:AMMPOOL_ADDRESS)    { $env:AMMPOOL_ADDRESS }    else { "0x85F18604a8e3ca3C87A1373e4110Ed5C337677d4" }

# ContributorReward：若未部署，脚本会先部署
$contributorReward = $env:CONTRIBUTOR_REWARD_ADDRESS

Set-Location $contractsDir

# Step 0: 若未设置 ContributorReward，先部署
if (-not $contributorReward) {
    Write-Host "=== 部署 ContributorReward ===" -ForegroundColor Cyan
    $out0 = forge script script/Deploy.s.sol:Deploy --sig "runContributorReward()" --rpc-url $rpc --broadcast 2>&1 | Out-String
    Write-Host $out0
    if ($out0 -match "ContributorReward\s+(0x[a-fA-F0-9]{40})") { $contributorReward = $Matches[1] }
    if (-not $contributorReward) {
        $runFile = Get-ChildItem "broadcast/Deploy.s.sol/11155111/run*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($runFile) {
            $j = Get-Content $runFile.FullName -Raw | ConvertFrom-Json
            $tx = $j.transactions | Where-Object { $_.contractName -eq "ContributorReward" } | Select-Object -Last 1
            if ($tx) { $contributorReward = $tx.contractAddress }
        }
    }
    if (-not $contributorReward) { throw "无法解析 ContributorReward 地址，请手动设置 CONTRIBUTOR_REWARD_ADDRESS" }
    Write-Host "ContributorReward: $contributorReward"
}

# Step 1: 部署 Governance 并绑定
Write-Host "`n=== 部署 Governance 并绑定 ===" -ForegroundColor Cyan
$env:SETTLEMENT_ADDRESS = $settlement
$env:AMMPOOL_ADDRESS = $ammPool
$env:CONTRIBUTOR_REWARD_ADDRESS = $contributorReward
$out1 = forge script script/Deploy.s.sol:Deploy --sig "runGovernance()" --rpc-url $rpc --broadcast 2>&1 | Out-String
Write-Host $out1
if ($out1 -match "Governance\s+(0x[a-fA-F0-9]{40})") { $govAddr = $Matches[1] }
if (-not $govAddr) {
    $runFile = Get-ChildItem "broadcast/Deploy.s.sol/11155111/run*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($runFile) {
        $j = Get-Content $runFile.FullName -Raw | ConvertFrom-Json
        $govTx = $j.transactions | Where-Object { $_.contractName -eq "Governance" } | Select-Object -Last 1
        if ($govTx) { $govAddr = $govTx.contractAddress }
    }
}
if (-not $govAddr) { throw "无法解析 Governance 地址，请手动设置 `$env:GOVERNANCE_ADDRESS 后重跑 Step 2" }
Write-Host "Governance: $govAddr"

# Step 2: 部署 TokenRegistry、ChainConfig
Write-Host "`n=== 部署 TokenRegistry、ChainConfig ===" -ForegroundColor Cyan
$env:GOVERNANCE_ADDRESS = $govAddr
forge script script/Deploy.s.sol:Deploy --sig "runTokenRegistryAndChainConfig()" --rpc-url $rpc --broadcast

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "Governance:        $govAddr"
Write-Host "Settlement:        $settlement (已绑定)"
Write-Host "AMMPool:           $ammPool (已绑定)"
Write-Host "ContributorReward: $contributorReward (已绑定)"
Write-Host ""
Write-Host "【必做】将 Governance 地址填入前端配置：" -ForegroundColor Yellow
Write-Host "  打开 frontend/src/config.ts，将 GOVERNANCE_ADDRESS 改为：" -ForegroundColor Yellow
Write-Host "  export const GOVERNANCE_ADDRESS = '$govAddr' as const" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步: 用 merkletool 生成 root/proof，在前端治理区或 cast 完成 创建提案 → 投票 → 执行"
Write-Host "见: docs/治理部署与提案执行指南.md"
