#!/bin/bash
# 为 Sepolia AMM 池添加流动性
# 用法: ./add-liquidity.sh <token0_amount> <token1_amount>
# 示例: ./add-liquidity.sh 1000 1000

set -e

TOKEN0_AMOUNT=${1:-1000}
TOKEN1_AMOUNT=${2:-1000}
PRIVATE_KEY=${PRIVATE_KEY:-}
RPC_URL=${SEPOLIA_RPC_URL:-}
AMMPOOL_ADDRESS=${AMMPOOL_ADDRESS:-}
TOKEN0_ADDRESS=${TOKEN0_ADDRESS:-}
TOKEN1_ADDRESS=${TOKEN1_ADDRESS:-}

if [ -z "$PRIVATE_KEY" ]; then
    echo "错误: 请设置 PRIVATE_KEY 环境变量"
    exit 1
fi

if [ -z "$RPC_URL" ]; then
    echo "错误: 请设置 SEPOLIA_RPC_URL 环境变量"
    exit 1
fi

if [ -z "$AMMPOOL_ADDRESS" ]; then
    echo "错误: 请设置 AMMPOOL_ADDRESS 环境变量"
    exit 1
fi

if [ -z "$TOKEN0_ADDRESS" ]; then
    echo "错误: 请设置 TOKEN0_ADDRESS 环境变量"
    exit 1
fi

if [ -z "$TOKEN1_ADDRESS" ]; then
    echo "错误: 请设置 TOKEN1_ADDRESS 环境变量"
    exit 1
fi

echo "=== 为 AMM 池添加流动性 ==="
echo "AMM 池地址: $AMMPOOL_ADDRESS"
echo "Token0 地址: $TOKEN0_ADDRESS"
echo "Token1 地址: $TOKEN1_ADDRESS"
echo "Token0 数量: $TOKEN0_AMOUNT"
echo "Token1 数量: $TOKEN1_AMOUNT"
echo ""

# 检查 forge 是否安装
if ! command -v forge &> /dev/null; then
    echo "错误: 未找到 forge 命令，请先安装 Foundry"
    exit 1
fi

# 创建临时 Solidity 脚本
SCRIPT_PATH="script/AddLiquidity.s.sol"
cat > "$SCRIPT_PATH" << 'EOF'
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
EOF

echo "创建临时脚本: $SCRIPT_PATH"

# 设置环境变量
export AMMPOOL_ADDRESS
export TOKEN0_ADDRESS
export TOKEN1_ADDRESS
export TOKEN0_AMOUNT
export TOKEN1_AMOUNT
export PRIVATE_KEY

# 执行脚本
echo "执行脚本..."
if forge script "$SCRIPT_PATH" -f "$RPC_URL" --broadcast -vvv; then
    echo ""
    echo "✅ 流动性添加成功!"
else
    echo ""
    echo "❌ 执行失败，请检查错误信息"
    rm -f "$SCRIPT_PATH"
    exit 1
fi

# 清理临时脚本
rm -f "$SCRIPT_PATH"
echo "已清理临时脚本"
