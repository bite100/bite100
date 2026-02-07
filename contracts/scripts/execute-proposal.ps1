# 投票期结束后执行治理提案
# 用法：.\scripts\execute-proposal.ps1 -ProposalId 0
# 可选：-RpcUrl "https://..."  -Governance "0x..."
# 依赖：contracts/.env 中 PRIVATE_KEY

param(
    [int] $ProposalId = 0,
    [string] $RpcUrl = "",
    [string] $Governance = ""
)

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

$rpc = if ($RpcUrl) { $RpcUrl } else { "https://ethereum-sepolia.publicnode.com" }
if ($env:SEPOLIA_RPC_URL -and $env:SEPOLIA_RPC_URL.Trim()) { $rpc = $env:SEPOLIA_RPC_URL.Trim() }

$gov = if ($Governance) { $Governance } else { "0x8F107ffaB0FC42E623AA69Bd10d8ad4cfbcE87BB" }

if (-not $env:PRIVATE_KEY) {
    Write-Error "请在 contracts/.env 中配置 PRIVATE_KEY"
    exit 1
}

Write-Host "Execute proposal $ProposalId on Governance $gov (RPC: $rpc)" -ForegroundColor Cyan
cast send $gov "execute(uint256)" $ProposalId --rpc-url $rpc --private-key $env:PRIVATE_KEY
Write-Host "Done." -ForegroundColor Green
