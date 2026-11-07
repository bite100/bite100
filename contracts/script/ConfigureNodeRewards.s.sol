// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ChainGuard.sol";
import "../src/Settlement.sol";
import "../src/NodeRewards.sol";

/// @title 第二十九轮：NodeRewards ↔ Settlement 配对接线（一次性配置脚本）
/// @notice 暗坑背景：Settlement.settleTradesBatchWithGasSavings 在分配 gas
///         节省时调用 NodeRewards.depositFounderReward，而该函数要求
///         NodeRewards.settlement 恰为本 Settlement（且非零）。历史上没有任何
///         部署/配置脚本调用过 NodeRewards.setSettlement：一旦将来启用奖励
///         时只在 Settlement 侧 setNodeRewards/setFounder/setUsdtToken、漏掉
///         NodeRewards 侧这一步，批量结算会在结算全部完成后的分配环节整批
///         revert——成交越多、发现越晚。本脚本把配对做成单一入口：两侧指针
///         一次设齐，广播后回读断言，配对不全即整轮失败，绝不留半接线状态。
///         证据：contracts/test/NodeRewards.t.sol 复刻了漏设时的整批 revert
///         与补设后的成功路径。
/// 使用（仅测试网；先 dry-run 核对输出，再加 --broadcast 正式执行）：
///   必需环境变量：PRIVATE_KEY（Settlement 与 NodeRewards 的共同 owner）、
///   SETTLEMENT_ADDRESS、NODE_REWARDS_ADDRESS；
///   可选环境变量：FOUNDER_ADDRESS、USDT_TOKEN_ADDRESS（提供时一并设置并回读断言）。
///   forge script script/ConfigureNodeRewards.s.sol --rpc-url <RPC> [--broadcast]
contract ConfigureNodeRewards is ChainGuard {
    function run() external {
        _assertTargetChain();
        address settlementAddr = vm.envAddress("SETTLEMENT_ADDRESS");
        address nodeRewardsAddr = vm.envAddress("NODE_REWARDS_ADDRESS");
        address founder = vm.envOr("FOUNDER_ADDRESS", address(0));
        address usdt = vm.envOr("USDT_TOKEN_ADDRESS", address(0));

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        Settlement settlement = Settlement(payable(settlementAddr));
        NodeRewards nodeRewards = NodeRewards(nodeRewardsAddr);

        nodeRewards.setSettlement(settlementAddr);
        settlement.setNodeRewards(nodeRewardsAddr);
        if (founder != address(0)) {
            settlement.setFounder(founder);
        }
        if (usdt != address(0)) {
            settlement.setUsdtToken(usdt);
        }

        vm.stopBroadcast();

        // 回读断言：任一指针不符即 revert，运维侧立刻可见，不留暗坑
        require(nodeRewards.settlement() == settlementAddr, "ConfigureNodeRewards: NodeRewards.settlement mismatch");
        require(settlement.nodeRewards() == nodeRewardsAddr, "ConfigureNodeRewards: Settlement.nodeRewards mismatch");
        if (founder != address(0)) {
            require(settlement.founder() == founder, "ConfigureNodeRewards: Settlement.founder mismatch");
        }
        if (usdt != address(0)) {
            require(settlement.usdtToken() == usdt, "ConfigureNodeRewards: Settlement.usdtToken mismatch");
        }
        console.log("NodeRewards <-> Settlement pairing OK");
        console.log("  settlement", settlementAddr);
        console.log("  nodeRewards", nodeRewardsAddr);
    }
}
