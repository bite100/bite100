// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ChainGuard.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/ChainConfig.sol";

/// @title 第二十一轮：重部署 gas 规则受影响合约（Vault + Settlement + ChainConfig）
/// @notice 背景：Settlement 新增链上 gas 计量/对半回收/失败归责，Vault 新增落锁墓碑，
///         ChainConfig 新增 gas 换算参考价——三者需协同换新。FeeDistributor、Governance、
///         TokenRegistry、ContributorReward、代币与桥合约不引用 Vault/Settlement 地址
///         （桥绑定的是代币），本轮不动，经环境变量复用既有实例。
/// 必需环境变量：
///   PRIVATE_KEY                    部署者（兼新 Vault 的 E2E/节点 locker，可后续再授权他人）
///   FEE_DISTRIBUTOR_ADDRESS        既有 FeeDistributor（开发者分成口径不得回归）
///   GOVERNANCE_ADDRESS             既有 Governance（接线到新 Settlement 与新 ChainConfig）
///   QUOTE_TOKEN                    计价资产（测试网 = TKB）
/// 可选：ETH_PRICE_IN_QUOTE（默认 2000e18，测试参考价）、MAX_FAILURE_GAS_CHARGE_QUOTE（默认 5e18）
contract DeployGasRules is ChainGuard {
    function run() external {
        _assertTargetChain();
        address fdAddr = vm.envAddress("FEE_DISTRIBUTOR_ADDRESS");
        address govAddr = vm.envAddress("GOVERNANCE_ADDRESS");
        address quoteToken = vm.envAddress("QUOTE_TOKEN");
        uint256 ethPrice = vm.envOr("ETH_PRICE_IN_QUOTE", uint256(2000e18));
        uint256 failCap = vm.envOr("MAX_FAILURE_GAS_CHARGE_QUOTE", uint256(5e18));

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);

        Vault vault = new Vault();
        Settlement settlement = new Settlement(address(vault), fdAddr);
        ChainConfig chainConfig = new ChainConfig();

        vault.setSettlement(address(settlement));
        vault.setLocker(deployer, true);

        settlement.setChainConfig(address(chainConfig));
        settlement.setGovernance(govAddr);
        settlement.setMaxFailureGasChargeQuote(failCap);

        chainConfig.setGovernance(govAddr);
        chainConfig.setQuotePricing(quoteToken, ethPrice);

        vm.stopBroadcast();

        console.log("Vault (new)", address(vault));
        console.log("Settlement (new)", address(settlement));
        console.log("ChainConfig (new)", address(chainConfig));
        console.log("FeeDistributor (reused)", fdAddr);
        console.log("Governance (reused)", govAddr);
    }
}
