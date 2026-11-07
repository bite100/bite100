// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ChainGuard.sol";
import "../src/CrossChainBridge.sol";

/// @title DeployCrossChainBridge 跨链桥接合约部署脚本
/// @notice 链参数化（第七轮）：目标链由 --rpc-url 决定（foundry.toml 已有
///         sepolia/base_sepolia/arbitrum_sepolia/optimism_sepolia 别名）；
///         LAYERZERO_ENDPOINT 必填——LayerZero V2 Endpoint 在各测试网为同一地址
///         0x6EDCE65403992e310A62460808c4b910D972f10f（见 scripts/deploy-crosschain-bridge.ps1），
///         但仍要求显式传入，防止在未支持的链上误部署；设置 TARGET_CHAIN_ID 时会先校验链。
contract DeployCrossChainBridge is ChainGuard {
    function run() external {
        _assertTargetChain();
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address endpoint = vm.envAddress("LAYERZERO_ENDPOINT");
        address owner = vm.addr(deployerPrivateKey);
        address delegate = vm.envOr("DELEGATE", owner);
        
        vm.startBroadcast(deployerPrivateKey);
        
        // 真实 OApp 构造为 (endpoint, delegate)，owner = 部署者（msg.sender）
        CrossChainBridge bridge = new CrossChainBridge(
            endpoint,
            delegate
        );
        
        console.log("CrossChainBridge deployed at:", address(bridge));
        console.log("Owner:", owner);
        console.log("Delegate:", delegate);
        console.log("Endpoint:", endpoint);
        
        vm.stopBroadcast();
    }
}
