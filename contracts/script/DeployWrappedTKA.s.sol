// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ChainGuard.sol";
import "../src/WrappedTKA.sol";

/// @title DeployWrappedTKA 第十九轮：TKA 包装代币部署脚本
/// @notice 链由 --rpc-url 决定；UNDERLYING_TOKEN 必填（本链第十五轮 TKA 地址），
///         防在错链绑错代币；ADMIN 缺省为部署者（兼 CCIP 管理员登记地址）。
///         设置 TARGET_CHAIN_ID 时先校验链。
contract DeployWrappedTKA is ChainGuard {
    function run() external {
        _assertTargetChain();
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address underlying = vm.envAddress("UNDERLYING_TOKEN");
        address deployer = vm.addr(deployerPrivateKey);
        address admin = vm.envOr("ADMIN", deployer);

        vm.startBroadcast(deployerPrivateKey);

        WrappedTKA wtka = new WrappedTKA(underlying, admin);

        vm.stopBroadcast();

        console.log("WrappedTKA deployed at:", address(wtka));
        console.log("Underlying TKA:", underlying);
        console.log("Admin / CCIP admin:", admin);
    }
}
