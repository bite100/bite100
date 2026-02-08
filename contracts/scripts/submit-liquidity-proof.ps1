# 提交流动性贡献证明
# 用法: .\submit-liquidity-proof.ps1 -Period <period> -LiquidityAmount <amount> -Chain <chain>

param(
    [Parameter(Mandatory=$true)]
    [string]$Period,
    
    [Parameter(Mandatory=$true)]
    [string]$LiquidityAmount,
    
    [Parameter(Mandatory=$false)]
    [ValidateSet("sepolia", "base_sepolia", "arbitrum_sepolia", "mainnet")]
    [string]$Chain = "sepolia",
    
    [string]$PrivateKey = $env:PRIVATE_KEY,
    [string]$RpcUrl = $null,
    [string]$ContributorRewardAddress = $null
)

if (-not $PrivateKey) {
    Write-Host "错误: 请设置 PRIVATE_KEY 环境变量" -ForegroundColor Red
    exit 1
}

# RPC URL
if (-not $RpcUrl) {
    switch ($Chain) {
        "sepolia" { $RpcUrl = $env:SEPOLIA_RPC_URL ?? "https://ethereum-sepolia.publicnode.com" }
        "base_sepolia" { $RpcUrl = $env:BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org" }
        "arbitrum_sepolia" { $RpcUrl = $env:ARBITRUM_SEPOLIA_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc" }
        "mainnet" { $RpcUrl = $env:MAINNET_RPC_URL ?? "https://ethereum.publicnode.com" }
    }
}

# ContributorReward 地址
if (-not $ContributorRewardAddress) {
    switch ($Chain) {
        "sepolia" { $ContributorRewardAddress = $env:CONTRIBUTOR_REWARD_ADDRESS ?? "0x851019107c4F3150D90f1629f6A646eBC1B1E286" }
        "mainnet" { $ContributorRewardAddress = $env:CONTRIBUTOR_REWARD_ADDRESS }
        default { $ContributorRewardAddress = $env:CONTRIBUTOR_REWARD_ADDRESS }
    }
}

if (-not $ContributorRewardAddress) {
    Write-Host "错误: 请设置 CONTRIBUTOR_REWARD_ADDRESS 环境变量或使用 -ContributorRewardAddress 参数" -ForegroundColor Red
    exit 1
}

Write-Host "=== 提交流动性贡献证明 ===" -ForegroundColor Cyan
Write-Host "周期: $Period"
Write-Host "流动性数量: $LiquidityAmount"
Write-Host "链: $Chain"
Write-Host "ContributorReward: $ContributorRewardAddress"
Write-Host ""

# 创建提交脚本
$scriptContent = @"
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/ContributorReward.sol";

contract SubmitLiquidityProof is Script {
    function run() external {
        address contributorRewardAddr = vm.envAddress("CONTRIBUTOR_REWARD_ADDRESS");
        string memory period = vm.envString("PERIOD");
        uint256 liquidityAmount = vm.envUint("LIQUIDITY_AMOUNT");
        
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address signer = vm.addr(pk);
        
        // 生成签名
        bytes32 digest = keccak256(abi.encodePacked(period, liquidityAmount, uint8(3)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        
        vm.startBroadcast(pk);
        
        ContributorReward contributorReward = ContributorReward(contributorRewardAddr);
        contributorReward.submitLiquidityProof(period, liquidityAmount, signature);
        
        console.log("流动性贡献证明已提交");
        console.log("周期:", period);
        console.log("流动性数量:", liquidityAmount);
        console.log("签名者:", signer);
        
        vm.stopBroadcast();
    }
}
"@

$scriptPath = "script/SubmitLiquidityProof.s.sol"
$scriptContent | Out-File -FilePath $scriptPath -Encoding UTF8

Write-Host "创建提交脚本: $scriptPath" -ForegroundColor Yellow

# 设置环境变量
$env:PRIVATE_KEY = $PrivateKey
$env:CONTRIBUTOR_REWARD_ADDRESS = $ContributorRewardAddress
$env:PERIOD = $Period
$env:LIQUIDITY_AMOUNT = $LiquidityAmount

# 执行提交
Write-Host "执行提交..." -ForegroundColor Yellow
try {
    forge script $scriptPath `
        --rpc-url $RpcUrl `
        --broadcast `
        -vvv
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n✅ 流动性贡献证明提交成功!" -ForegroundColor Green
    } else {
        Write-Host "`n❌ 提交失败，请检查错误信息" -ForegroundColor Red
        exit 1
    }
} finally {
    # 清理临时脚本
    if (Test-Path $scriptPath) {
        Remove-Item $scriptPath -Force
        Write-Host "已清理临时脚本" -ForegroundColor Gray
    }
}
