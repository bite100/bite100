# 安装 LayerZero OApp EVM 依赖
# 用法: .\install-layerzero.ps1

Write-Host "=== 安装 LayerZero OApp EVM 依赖 ===" -ForegroundColor Cyan

# 检查是否在 contracts 目录
if (-not (Test-Path "foundry.toml")) {
    Write-Host "错误: 请在 contracts 目录下运行此脚本" -ForegroundColor Red
    exit 1
}

# 检查 forge 是否可用
$forgeVersion = forge --version 2>$null
if (-not $forgeVersion) {
    Write-Host "错误: 未找到 forge 命令，请先安装 Foundry" -ForegroundColor Red
    Write-Host "安装方法: https://getfoundry.sh" -ForegroundColor Yellow
    exit 1
}

Write-Host "Foundry 版本: $forgeVersion" -ForegroundColor Green

# 安装 LayerZero OApp EVM
Write-Host "`n安装 LayerZero OApp EVM..." -ForegroundColor Yellow
forge install LayerZero-Labs/oapp-evm --no-commit

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n❌ 安装失败" -ForegroundColor Red
    exit 1
}

Write-Host "`n✅ LayerZero OApp EVM 安装成功!" -ForegroundColor Green

# 更新 remappings
Write-Host "`n更新 remappings..." -ForegroundColor Yellow

$foundryToml = Get-Content "foundry.toml" -Raw

# 检查是否已有 LayerZero remapping
if ($foundryToml -match "@layerzerolabs/oapp-evm") {
    Write-Host "remappings 已包含 LayerZero" -ForegroundColor Gray
} else {
    # 添加 remapping
    $remappingLine = '@layerzerolabs/oapp-evm/=lib/oapp-evm/'
    
    if ($foundryToml -match 'remappings = \[(.*?)\]') {
        $existingRemappings = $matches[1]
        $newRemappings = "$existingRemappings`n$remappingLine"
        $foundryToml = $foundryToml -replace 'remappings = \[(.*?)\]', "remappings = [$newRemappings]"
    } else {
        # 如果没有 remappings，添加
        $foundryToml = $foundryToml -replace '(remappings = \[.*?\])', "`$1`n$remappingLine"
    }
    
    Set-Content "foundry.toml" -Value $foundryToml -NoNewline
    Write-Host "✅ 已添加 LayerZero remapping" -ForegroundColor Green
}

# 添加 OpenZeppelin remapping（如果还没有）
if (-not ($foundryToml -match "@openzeppelin")) {
    Write-Host "添加 OpenZeppelin remapping..." -ForegroundColor Yellow
    $ozRemapping = '@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/'
    
    if ($foundryToml -match 'remappings = \[(.*?)\]') {
        $existingRemappings = $matches[1]
        $newRemappings = "$existingRemappings`n$ozRemapping"
        $foundryToml = $foundryToml -replace 'remappings = \[(.*?)\]', "remappings = [$newRemappings]"
        Set-Content "foundry.toml" -Value $foundryToml -NoNewline
        Write-Host "✅ 已添加 OpenZeppelin remapping" -ForegroundColor Green
    }
}

# 尝试编译
Write-Host "`n验证编译..." -ForegroundColor Yellow
forge build 2>&1 | Out-Null

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ 编译成功!" -ForegroundColor Green
} else {
    Write-Host "⚠️  编译有警告，但依赖已安装" -ForegroundColor Yellow
}

Write-Host "`n=== 安装完成 ===" -ForegroundColor Cyan
Write-Host "下一步: 运行部署脚本部署跨链桥接合约" -ForegroundColor Yellow
