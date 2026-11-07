// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ChainGuard.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";

/// @title 第五轮：单独重部署 Settlement 并补齐绑定
/// @notice 背景：旧 Settlement 的 feeDistributor 仅在构造函数设定（本轮源码已新增
/// setFeeDistributor，但已部署实例无法原地升级），故重部署一个新实例指向新
/// FeeDistributor，并把 Vault 的 settlement 登记切到新实例——这是旧实例在部署
/// 脚本 Deploy.runWithAmmAndMocks 中唯一的外部绑定（governance/relayer 均为零值，
/// 与新实例默认值一致，无需复制）。
/// 必需环境变量：PRIVATE_KEY（Vault/Settlement owner）、VAULT_ADDRESS、FEE_DISTRIBUTOR_ADDRESS（新 FD）
contract DeploySettlementV2 is ChainGuard {
    function run() external {
        _assertTargetChain();
        address vaultAddr = vm.envAddress("VAULT_ADDRESS");
        address feeDistributorAddr = vm.envAddress("FEE_DISTRIBUTOR_ADDRESS");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        Settlement settlement = new Settlement(vaultAddr, feeDistributorAddr);
        console.log("Settlement (new)", address(settlement));

        Vault(vaultAddr).setSettlement(address(settlement));
        console.log("Vault.setSettlement -> new Settlement done");

        vm.stopBroadcast();
    }
}
