# 部署到 Arbitrum 主网
# 用法: .\deploy-arbitrum.ps1

param(
    [string]$PrivateKey = $env:PRIVATE_KEY,
    [string]$RpcUrl = $env:ARBITRUM_RPC_URL,
    [string]$Token0Address = $env:ARBITRUM_TOKEN0_ADDRESS,
    [string]$Token1Address = $env:ARBITRUM_TOKEN1_ADDRESS
)

if (-not $PrivateKey) {
    Write-Host "错误: 请设置 PRIVATE_KEY 环境变量" -ForegroundColor Red
    exit 1
}

if (-not $RpcUrl) {
    Write-Host "错误: 请设置 ARBITRUM_RPC_URL 环境变量（如 https://arb1.arbitrum.io/rpc）" -ForegroundColor Red
    exit 1
}

if (-not $Token0Address -or -not $Token1Address) {
    Write-Host "错误: 请设置 ARBITRUM_TOKEN0_ADDRESS 和 ARBITRUM_TOKEN1_ADDRESS 环境变量" -ForegroundColor Red
    exit 1
}

Write-Host "=== 部署到 Arbitrum 主网 ===" -ForegroundColor Cyan
Write-Host "RPC: $RpcUrl"
Write-Host "Token0: $Token0Address"
Write-Host "Token1: $Token1Address"
Write-Host ""

# 设置环境变量
$env:PRIVATE_KEY = $PrivateKey
$env:ARBITRUM_RPC_URL = $RpcUrl
$env:TOKEN0_ADDRESS = $Token0Address
$env:TOKEN1_ADDRESS = $Token1Address

# 创建临时部署脚本
$scriptContent = @"
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/Vault.sol";
import "../src/FeeDistributor.sol";
import "../src/Settlement.sol";
import "../src/AMMPool.sol";
import "../src/ContributorReward.sol";
import "../src/Governance.sol";
import "../src/TokenRegistry.sol";
import "../src/ChainConfig.sol";

contract DeployArbitrum is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address token0Addr = vm.envAddress("TOKEN0_ADDRESS");
        address token1Addr = vm.envAddress("TOKEN1_ADDRESS");
        
        vm.startBroadcast(deployerPrivateKey);
        
        // 1. Vault
        Vault vault = new Vault();
        console.log("Vault", address(vault));
        
        // 2. FeeDistributor
        FeeDistributor feeDistributor = new FeeDistributor();
        console.log("FeeDistributor", address(feeDistributor));
        
        // 3. Settlement
        Settlement settlement = new Settlement(address(vault), address(feeDistributor));
        console.log("Settlement", address(settlement));
        
        // 4. Vault 绑定 Settlement
        vault.setSettlement(address(settlement));
        
        // 5. FeeDistributor 配置
        address developer = vm.envOr("DEVELOPER_ADDRESS", deployer);
        feeDistributor.setDeveloperAddress(developer);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        address[] memory accounts = new address[](1);
        accounts[0] = feeRecipient;
        uint16[] memory shareBps = new uint16[](1);
        shareBps[0] = 9900;
        feeDistributor.setRecipients(accounts, shareBps);
        
        // 6. AMM Pool
        AMMPool ammPool = new AMMPool(token0Addr, token1Addr, address(feeDistributor));
        console.log("AMMPool", address(ammPool));
        
        // 7. ContributorReward
        ContributorReward contributorReward = new ContributorReward();
        console.log("ContributorReward", address(contributorReward));
        
        // 8. Governance
        Governance gov = new Governance();
        console.log("Governance", address(gov));
        
        // 9. TokenRegistry & ChainConfig
        TokenRegistry tokenRegistry = new TokenRegistry();
        ChainConfig chainConfig = new ChainConfig();
        console.log("TokenRegistry", address(tokenRegistry));
        console.log("ChainConfig", address(chainConfig));
        
        // 10. 绑定 Governance
        settlement.setGovernance(address(gov));
        ammPool.setGovernance(address(gov));
        contributorReward.setGovernance(address(gov));
        tokenRegistry.setGovernance(address(gov));
        chainConfig.setGovernance(address(gov));
        
        // 11. 上线奖励
        string memory launchPeriod = vm.envOr("LAUNCH_PERIOD", string("launch"));
        contributorReward.setContributionScore(launchPeriod, developer, 50000e18);
        
        vm.stopBroadcast();
        
        console.log("=== Arbitrum 部署完成 ===");
        console.log("Chain ID: 42161");
        console.log("请更新 frontend/src/config/chains.ts 中的合约地址");
    }
}
"@

$scriptPath = "script/DeployArbitrum.s.sol"
$scriptContent | Out-File -FilePath $scriptPath -Encoding UTF8

Write-Host "创建部署脚本: $scriptPath" -ForegroundColor Yellow

# 执行部署
Write-Host "执行部署..." -ForegroundColor Yellow
try {
    forge script $scriptPath -f $RpcUrl --broadcast -vvv
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n✅ Arbitrum 部署成功!" -ForegroundColor Green
        Write-Host "请将输出的合约地址更新到 frontend/src/config/chains.ts" -ForegroundColor Yellow
    } else {
        Write-Host "`n❌ 部署失败，请检查错误信息" -ForegroundColor Red
        exit 1
    }
} finally {
    # 清理临时脚本
    if (Test-Path $scriptPath) {
        Remove-Item $scriptPath -Force
        Write-Host "已清理临时脚本" -ForegroundColor Gray
    }
}
