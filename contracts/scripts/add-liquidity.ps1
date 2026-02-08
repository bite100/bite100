# 为 Sepolia AMM 池添加流动性
# 用法: .\add-liquidity.ps1 -Token0Amount <amount> -Token1Amount <amount>
# 示例: .\add-liquidity.ps1 -Token0Amount 1000 -Token1Amount 1000

param(
    [string]$Token0Amount = "1000",
    [string]$Token1Amount = "1000",
    [string]$PrivateKey = $env:PRIVATE_KEY,
    [string]$RpcUrl = $env:SEPOLIA_RPC_URL,
    [string]$AMMPoolAddress = $env:AMMPOOL_ADDRESS,
    [string]$Token0Address = $env:TOKEN0_ADDRESS,
    [string]$Token1Address = $env:TOKEN1_ADDRESS
)

if (-not $PrivateKey) {
    Write-Host "错误: 请设置 PRIVATE_KEY 环境变量或通过 -PrivateKey 参数传入" -ForegroundColor Red
    exit 1
}

if (-not $RpcUrl) {
    Write-Host "错误: 请设置 SEPOLIA_RPC_URL 环境变量或通过 -RpcUrl 参数传入" -ForegroundColor Red
    exit 1
}

if (-not $AMMPoolAddress) {
    Write-Host "错误: 请设置 AMMPOOL_ADDRESS 环境变量或通过 -AMMPoolAddress 参数传入" -ForegroundColor Red
    exit 1
}

if (-not $Token0Address) {
    Write-Host "错误: 请设置 TOKEN0_ADDRESS 环境变量或通过 -Token0Address 参数传入" -ForegroundColor Red
    exit 1
}

if (-not $Token1Address) {
    Write-Host "错误: 请设置 TOKEN1_ADDRESS 环境变量或通过 -Token1Address 参数传入" -ForegroundColor Red
    exit 1
}

Write-Host "=== 为 AMM 池添加流动性 ===" -ForegroundColor Cyan
Write-Host "AMM 池地址: $AMMPoolAddress"
Write-Host "Token0 地址: $Token0Address"
Write-Host "Token1 地址: $Token1Address"
Write-Host "Token0 数量: $Token0Amount"
Write-Host "Token1 数量: $Token1Amount"
Write-Host ""

# 检查 forge 是否安装
$forgeVersion = forge --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "错误: 未找到 forge 命令，请先安装 Foundry" -ForegroundColor Red
    exit 1
}

# 创建临时 Solidity 脚本
$scriptContent = @"
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/AMMPool.sol";
import "../src/interfaces/IERC20.sol";

contract AddLiquidityScript is Script {
    function run() external {
        address ammPoolAddr = vm.envAddress("AMMPOOL_ADDRESS");
        address token0Addr = vm.envAddress("TOKEN0_ADDRESS");
        address token1Addr = vm.envAddress("TOKEN1_ADDRESS");
        uint256 amount0 = vm.envUint("TOKEN0_AMOUNT");
        uint256 amount1 = vm.envUint("TOKEN1_AMOUNT");
        
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        
        AMMPool pool = AMMPool(ammPoolAddr);
        IERC20 token0 = IERC20(token0Addr);
        IERC20 token1 = IERC20(token1Addr);
        
        // 检查余额
        address deployer = vm.addr(pk);
        uint256 bal0 = token0.balanceOf(deployer);
        uint256 bal1 = token1.balanceOf(deployer);
        
        console.log("当前余额:");
        console.log("Token0:", bal0);
        console.log("Token1:", bal1);
        
        require(bal0 >= amount0, "Token0 余额不足");
        require(bal1 >= amount1, "Token1 余额不足");
        
        // 批准
        console.log("批准代币...");
        require(token0.approve(ammPoolAddr, amount0), "Token0 approve 失败");
        require(token1.approve(ammPoolAddr, amount1), "Token1 approve 失败");
        
        // 添加流动性
        console.log("添加流动性...");
        pool.addLiquidity(amount0, amount1);
        
        // 检查池子余额
        uint256 reserve0 = pool.reserve0();
        uint256 reserve1 = pool.reserve1();
        
        console.log("添加成功!");
        console.log("池子 Token0 储备:", reserve0);
        console.log("池子 Token1 储备:", reserve1);
        
        vm.stopBroadcast();
    }
}
"@

$scriptPath = "script/AddLiquidity.s.sol"
$scriptContent | Out-File -FilePath $scriptPath -Encoding UTF8

Write-Host "创建临时脚本: $scriptPath" -ForegroundColor Yellow

# 设置环境变量
$env:AMMPOOL_ADDRESS = $AMMPoolAddress
$env:TOKEN0_ADDRESS = $Token0Address
$env:TOKEN1_ADDRESS = $Token1Address
$env:TOKEN0_AMOUNT = $Token0Amount
$env:TOKEN1_AMOUNT = $Token1Amount
$env:PRIVATE_KEY = $PrivateKey

# 执行脚本
Write-Host "执行脚本..." -ForegroundColor Yellow
try {
    forge script $scriptPath -f $RpcUrl --broadcast -vvv
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n✅ 流动性添加成功!" -ForegroundColor Green
    } else {
        Write-Host "`n❌ 执行失败，请检查错误信息" -ForegroundColor Red
        exit 1
    }
} finally {
    # 清理临时脚本
    if (Test-Path $scriptPath) {
        Remove-Item $scriptPath -Force
        Write-Host "已清理临时脚本" -ForegroundColor Gray
    }
}
