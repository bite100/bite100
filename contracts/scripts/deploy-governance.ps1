# 治理与配置部署脚本
# 1. 部署 Governance，绑定 Settlement / AMMPool / ContributorReward
# 2. 部署 TokenRegistry、ChainConfig，设置 GOVERNANCE_ADDRESS
#
# 用法：
#   1. 确保 contracts/.env 有 PRIVATE_KEY（部署 ContributorReward 的钱包即可）
#   2. 若 ContributorReward 已部署：$env:CONTRIBUTOR_REWARD_ADDRESS = "0x851019107c4F3150D90f1629f6A646eBC1B1E286"
#   3. 若非 Settlement/AMMPool 的 owner，设：$env:SKIP_SETTLEMENT_AMM = "1"
#   4. 运行: .\scripts\deploy-governance.ps1

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

# Sepolia 已部署地址（见 README）；必须显式设 RPC，否则 forge 报 --fork-url 缺失
$rpc = "https://ethereum-sepolia.publicnode.com"
if ($env:SEPOLIA_RPC_URL -and $env:SEPOLIA_RPC_URL.Trim()) { $rpc = $env:SEPOLIA_RPC_URL.Trim() }
$env:SEPOLIA_RPC_URL = $rpc
Write-Host "RPC: $rpc"
$settlement      = if ($env:SETTLEMENT_ADDRESS)      { $env:SETTLEMENT_ADDRESS }      else { "0xDa9f738Cc8bF4a312473f1AAfF4929b367e22C85" }
$ammPool         = if ($env:AMMPOOL_ADDRESS)         { $env:AMMPOOL_ADDRESS }         else { "0x85F18604a8e3ca3C87A1373e4110Ed5C337677d4" }
$feeDistributor  = if ($env:FEE_DISTRIBUTOR_ADDRESS) { $env:FEE_DISTRIBUTOR_ADDRESS } else { "0xeF4BFB58541270De18Af9216EB0Cd8EC07a2547F" }

# ContributorReward：若未部署，脚本会先部署
$contributorReward = $env:CONTRIBUTOR_REWARD_ADDRESS

Set-Location $contractsDir

# Step 0: 若未设置 ContributorReward，先部署
if (-not $contributorReward) {
    Write-Host "=== 部署 ContributorReward ===" -ForegroundColor Cyan
    $out0 = forge script script/Deploy.s.sol:Deploy --sig "runContributorReward()" --rpc-url "$rpc" --broadcast 2>&1 | Out-String
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
# 若 PRIVATE_KEY 非 Settlement/AMMPool 的 owner，设 SKIP_SETTLEMENT_AMM=1 仅绑定 ContributorReward
$skipSettlementAmm = $env:SKIP_SETTLEMENT_AMM -eq "1" -or $env:SKIP_SETTLEMENT_AMM -eq "true"
if ($skipSettlementAmm) {
    Write-Host "SKIP_SETTLEMENT_AMM=1：跳过 Settlement/AMMPool/FeeDistributor 绑定，仅绑定 ContributorReward" -ForegroundColor Yellow
    Remove-Item Env:SETTLEMENT_ADDRESS -ErrorAction SilentlyContinue
    Remove-Item Env:AMMPOOL_ADDRESS -ErrorAction SilentlyContinue
    Remove-Item Env:FEE_DISTRIBUTOR_ADDRESS -ErrorAction SilentlyContinue
} else {
    $env:SETTLEMENT_ADDRESS = $settlement
    $env:AMMPOOL_ADDRESS = $ammPool
    $env:FEE_DISTRIBUTOR_ADDRESS = $feeDistributor
}
$env:CONTRIBUTOR_REWARD_ADDRESS = $contributorReward
$out1 = forge script script/Deploy.s.sol:Deploy --sig "runGovernance()" --rpc-url "$rpc" --broadcast 2>&1 | Out-String
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
forge script script/Deploy.s.sol:Deploy --sig "runTokenRegistryAndChainConfig()" --rpc-url "$rpc" --broadcast

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "Governance:        $govAddr"
if ($skipSettlementAmm) {
    Write-Host "Settlement:        未绑定（SKIP_SETTLEMENT_AMM）"
    Write-Host "AMMPool:           未绑定（SKIP_SETTLEMENT_AMM）"
} else {
    Write-Host "Settlement:        $settlement (已绑定)"
    Write-Host "AMMPool:           $ammPool (已绑定)"
}
Write-Host "ContributorReward: $contributorReward (已绑定)"
Write-Host ""
Write-Host "【必做】将 Governance 地址填入前端配置：" -ForegroundColor Yellow
Write-Host "  打开 frontend/src/config.ts，将 GOVERNANCE_ADDRESS 改为：" -ForegroundColor Yellow
Write-Host "  export const GOVERNANCE_ADDRESS = '$govAddr' as const" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步: 用 merkletool 生成 root/proof，在前端治理区或 cast 完成 创建提案 → 投票 → 执行"
Write-Host "见: docs/治理部署与提案执行指南.md"
