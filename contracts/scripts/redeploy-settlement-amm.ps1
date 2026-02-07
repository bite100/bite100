# Redeploy Settlement and AMMPool (with governance), then bind to Governance.
# Prereq: PRIVATE_KEY in .env is Vault owner.
# Run from contracts dir: .\scripts\redeploy-settlement-amm.ps1

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

$rpc = "https://ethereum-sepolia.publicnode.com"
if ($env:SEPOLIA_RPC_URL -and $env:SEPOLIA_RPC_URL.Trim()) { $rpc = $env:SEPOLIA_RPC_URL.Trim() }

$env:VAULT_ADDRESS           = "0xbe3962Eaf7103d05665279469FFE3573352ec70C"
$env:FEE_DISTRIBUTOR_ADDRESS = "0xeF4BFB58541270De18Af9216EB0Cd8EC07a2547F"
$env:TOKEN0_ADDRESS          = "0x678195277dc8F84F787A4694DF42F3489eA757bf"
$env:TOKEN1_ADDRESS          = "0x9Be241a0bF1C2827194333B57278d1676494333a"
$env:GOVERNANCE_ADDRESS      = "0x8F107ffaB0FC42E623AA69Bd10d8ad4cfbcE87BB"

Write-Host "RPC: $rpc" -ForegroundColor Gray
Write-Host "Vault: $($env:VAULT_ADDRESS)"
Write-Host "Governance: $($env:GOVERNANCE_ADDRESS)"
Write-Host ""
Write-Host "=== Redeploy Settlement + AMMPool and bind Governance ===" -ForegroundColor Cyan

Set-Location $contractsDir
$out = forge script script/Deploy.s.sol:Deploy --sig "runRedeploySettlementAndAmmPool()" --rpc-url $rpc --broadcast 2>&1 | Out-String
Write-Host $out

$newSettlement = $null
$newAmmPool = $null
$lines = $out -split "`n"
for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -match "Settlement\s+(0x[a-fA-F0-9]{40})") { $newSettlement = $Matches[1] }
    if ($line -match "AMMPool\s+(0x[a-fA-F0-9]{40})")   { $newAmmPool = $Matches[1] }
}

if (-not $newSettlement -or -not $newAmmPool) {
    $runDir = "broadcast/Deploy.s.sol/11155111"
    $runFile = Get-ChildItem "$runDir/run*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($runFile) {
        $j = Get-Content $runFile.FullName -Raw | ConvertFrom-Json
        foreach ($tx in $j.transactions) {
            if ($tx.contractName -eq "Settlement") { $newSettlement = $tx.contractAddress }
            if ($tx.contractName -eq "AMMPool")     { $newAmmPool = $tx.contractAddress }
        }
    }
}

if (-not $newSettlement -or -not $newAmmPool) {
    Write-Host "Could not parse Settlement/AMMPool addresses. Copy from forge output above." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "Settlement: $newSettlement"
Write-Host "AMMPool:    $newAmmPool"
Write-Host ""
Write-Host "Update frontend/src/config.ts:" -ForegroundColor Yellow
Write-Host "  SETTLEMENT_ADDRESS = '$newSettlement'"
Write-Host "  AMM_POOL_ADDRESS   = '$newAmmPool'"
Write-Host "Update docs/API-interface: Settlement and AMMPool table." -ForegroundColor Yellow
Write-Host "New AMM pool has no liquidity; add via addLiquidity." -ForegroundColor Gray
