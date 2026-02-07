# 本地 Anvil 部署（无需测试币）
# 在 contracts 目录执行: .\scripts\deploy-local.ps1
# 会先启动 Anvil，再执行部署，最后输出合约地址

$ErrorActionPreference = "Stop"
$contractsRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $contractsRoot

$foundryBin = "$env:USERPROFILE\.foundry\versions\stable"
if (Test-Path "$env:USERPROFILE\.foundry\bin\forge.exe") { $foundryBin = "$env:USERPROFILE\.foundry\bin" }
$env:Path = "$foundryBin;$env:Path"

$anvil = Get-Command anvil -ErrorAction SilentlyContinue
if (-not $anvil) {
    Write-Host "未找到 anvil，请先安装 Foundry。"
    exit 1
}

Write-Host "启动本地链 Anvil（后台）..."
$job = Start-Job -ScriptBlock {
    Set-Location $using:contractsRoot
    $env:Path = $using:foundryBin + ";" + $env:Path
    & anvil
}
Start-Sleep -Seconds 3

$rpc = "http://127.0.0.1:8545"
$pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

Write-Host "部署到本地链..."
& forge script script/Deploy.s.sol:Deploy --rpc-url $rpc --broadcast --private-key $pk
$exitCode = $LASTEXITCODE

Stop-Job $job -ErrorAction SilentlyContinue
Remove-Job $job -Force -ErrorAction SilentlyContinue

if ($exitCode -eq 0) {
    Write-Host ""
    Write-Host "本地部署完成。合约在 http://127.0.0.1:8545，链 ID 31337。"
}
exit $exitCode
