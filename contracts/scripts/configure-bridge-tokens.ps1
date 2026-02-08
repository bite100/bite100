# 配置跨链桥接的代币映射
# 用法: .\configure-bridge-tokens.ps1 -BridgeAddress <address> -Chain <chain> -Token <token> -DstChainId <id> -DstToken <address>

param(
    [Parameter(Mandatory=$true)]
    [string]$BridgeAddress,
    
    [Parameter(Mandatory=$true)]
    [ValidateSet("sepolia", "base_sepolia", "arbitrum_sepolia")]
    [string]$Chain = "sepolia",
    
    [Parameter(Mandatory=$true)]
    [string]$Token,
    
    [Parameter(Mandatory=$true)]
    [int]$DstChainId,
    
    [Parameter(Mandatory=$true)]
    [string]$DstToken,
    
    [string]$PrivateKey = $env:PRIVATE_KEY,
    [string]$RpcUrl = $null
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
    }
}

Write-Host "=== 配置跨链桥接代币映射 ===" -ForegroundColor Cyan
Write-Host "桥接合约: $BridgeAddress"
Write-Host "链: $Chain"
Write-Host "源代币: $Token"
Write-Host "目标链 ID: $DstChainId"
Write-Host "目标代币: $DstToken"
Write-Host ""

# 创建配置脚本
$scriptContent = @"
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/CrossChainBridge.sol";

contract ConfigureBridgeTokens is Script {
    function run() external {
        address bridgeAddr = vm.envAddress("BRIDGE_ADDRESS");
        address token = vm.envAddress("TOKEN_ADDRESS");
        uint32 dstChainId = uint32(vm.envUint("DST_CHAIN_ID"));
        address dstToken = vm.envAddress("DST_TOKEN_ADDRESS");
        
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        
        CrossChainBridge bridge = CrossChainBridge(bridgeAddr);
        
        // 设置代币映射
        bridge.setTokenMapping(dstChainId, token, dstToken);
        console.log("代币映射已设置:");
        console.log("源代币:", token);
        console.log("目标链 ID:", dstChainId);
        console.log("目标代币:", dstToken);
        
        // 添加支持的代币
        bridge.setSupportedToken(token, true);
        console.log("代币已添加到支持列表:", token);
        
        vm.stopBroadcast();
    }
}
"@

$scriptPath = "script/ConfigureBridgeTokens.s.sol"
$scriptContent | Out-File -FilePath $scriptPath -Encoding UTF8

Write-Host "创建配置脚本: $scriptPath" -ForegroundColor Yellow

# 设置环境变量
$env:PRIVATE_KEY = $PrivateKey
$env:BRIDGE_ADDRESS = $BridgeAddress
$env:TOKEN_ADDRESS = $Token
$env:DST_CHAIN_ID = $DstChainId.ToString()
$env:DST_TOKEN_ADDRESS = $DstToken

# 执行配置
Write-Host "执行配置..." -ForegroundColor Yellow
try {
    forge script $scriptPath `
        --rpc-url $RpcUrl `
        --broadcast `
        -vvv
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n✅ 代币映射配置成功!" -ForegroundColor Green
    } else {
        Write-Host "`n❌ 配置失败，请检查错误信息" -ForegroundColor Red
        exit 1
    }
} finally {
    # 清理临时脚本
    if (Test-Path $scriptPath) {
        Remove-Item $scriptPath -Force
        Write-Host "已清理临时脚本" -ForegroundColor Gray
    }
}
