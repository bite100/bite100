# Bind Governance to Settlement and AMMPool (run as owner)
# Ensure .env PRIVATE_KEY is the owner of Settlement/AMMPool

$ErrorActionPreference = "Stop"
$env:Path = "$env:USERPROFILE\.foundry\versions\stable;$env:Path"

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

$rpc = "https://ethereum-sepolia.publicnode.com"
$gov = "0x8F107ffaB0FC42E623AA69Bd10d8ad4cfbcE87BB"
$settlement = "0xDa9f738Cc8bF4a312473f1AAfF4929b367e22C85"
$ammPool = "0x85F18604a8e3ca3C87A1373e4110Ed5C337677d4"

Set-Location $contractsDir

Write-Host "Binding Settlement to Governance..." -ForegroundColor Cyan
cast send $settlement "setGovernance(address)" $gov --rpc-url $rpc --private-key $env:PRIVATE_KEY
if ($LASTEXITCODE -ne 0) { Write-Host "Settlement bind failed. PRIVATE_KEY must be the owner of Settlement." -ForegroundColor Red; exit 1 }

Write-Host "Binding AMMPool to Governance..." -ForegroundColor Cyan
cast send $ammPool "setGovernance(address)" $gov --rpc-url $rpc --private-key $env:PRIVATE_KEY
if ($LASTEXITCODE -ne 0) { Write-Host "AMMPool bind failed. PRIVATE_KEY must be the owner of AMMPool." -ForegroundColor Red; exit 1 }

Write-Host "Done. Settlement and AMMPool are now bound to Governance." -ForegroundColor Green
