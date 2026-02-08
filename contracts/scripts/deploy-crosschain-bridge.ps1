# 部署跨链桥接合约到测试网
# 用法: .\deploy-crosschain-bridge.ps1 -Chain sepolia|base_sepolia|arbitrum_sepolia

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("sepolia", "base_sepolia", "arbitrum_sepolia")]
    [string]$Chain = "sepolia",
    
    [string]$PrivateKey = $env:PRIVATE_KEY,
    [string]$RpcUrl = $null,
    [string]$LayerZeroEndpoint = $null
)

if (-not $PrivateKey) {
    Write-Host "错误: 请设置 PRIVATE_KEY 环境变量" -ForegroundColor Red
    exit 1
}

# LayerZero Endpoint 地址（测试网）
$endpoints = @{
    "sepolia" = "0x6EDCE65403992e310A62460808c4b910D972f10f"
    "base_sepolia" = "0x6EDCE65403992e310A62460808c4b910D972f10f"
    "arbitrum_sepolia" = "0x6EDCE65403992e310A62460808c4b910D972f10f"
}

# RPC URL（如果未提供，从环境变量读取）
if (-not $RpcUrl) {
    switch ($Chain) {
        "sepolia" { $RpcUrl = $env:SEPOLIA_RPC_URL ?? "https://ethereum-sepolia.publicnode.com" }
        "base_sepolia" { $RpcUrl = $env:BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org" }
        "arbitrum_sepolia" { $RpcUrl = $env:ARBITRUM_SEPOLIA_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc" }
    }
}

if (-not $LayerZeroEndpoint) {
    $LayerZeroEndpoint = $endpoints[$Chain]
}

if (-not $LayerZeroEndpoint) {
    Write-Host "错误: 未找到链 $Chain 的 LayerZero Endpoint" -ForegroundColor Red
    exit 1
}

Write-Host "=== 部署跨链桥接合约到 $Chain ===" -ForegroundColor Cyan
Write-Host "RPC: $RpcUrl"
Write-Host "LayerZero Endpoint: $LayerZeroEndpoint"
Write-Host ""

# 设置环境变量
$env:PRIVATE_KEY = $PrivateKey
$env:LAYERZERO_ENDPOINT = $LayerZeroEndpoint

# 执行部署
Write-Host "执行部署..." -ForegroundColor Yellow
try {
    forge script script/DeployCrossChainBridge.s.sol:DeployCrossChainBridge `
        --rpc-url $RpcUrl `
        --broadcast `
        -vvv
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n✅ 跨链桥接合约部署成功!" -ForegroundColor Green
        Write-Host "`n下一步:" -ForegroundColor Yellow
        Write-Host "1. 记录合约地址"
        Write-Host "2. 运行配置脚本设置代币映射"
        Write-Host "3. 更新前端配置中的桥接合约地址"
    } else {
        Write-Host "`n❌ 部署失败，请检查错误信息" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "`n❌ 部署失败: $_" -ForegroundColor Red
    exit 1
}
