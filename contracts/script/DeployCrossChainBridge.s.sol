// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/CrossChainBridge.sol";

/// @title DeployCrossChainBridge 跨链桥接合约部署脚本
contract DeployCrossChainBridge is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address endpoint = vm.envAddress("LAYERZERO_ENDPOINT");
        address owner = vm.addr(deployerPrivateKey);
        address delegate = vm.envOr("DELEGATE", owner);
        
        vm.startBroadcast(deployerPrivateKey);
        
        CrossChainBridge bridge = new CrossChainBridge(
            endpoint,
            owner,
            delegate
        );
        
        console.log("CrossChainBridge deployed at:", address(bridge));
        console.log("Owner:", owner);
        console.log("Delegate:", delegate);
        console.log("Endpoint:", endpoint);
        
        vm.stopBroadcast();
    }
}
