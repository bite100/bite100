// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ChainGuard.sol";
import "../src/Settlement.sol";
import "../src/Vault.sol";

/// @title 第 62 轮部署：nonce 位图新 Settlement（改指现行 Vault，不换 Vault）
/// @notice 路径判断：Vault.setSettlement 是 owner setter，支持改指；且 Vault
///         的锁释放路径（releaseOrderLock / releaseExpiredOrderLock）不经
///         Settlement，改指后旧订单的剩余锁定仍可由用户/locker 释放；旧订单
///         因 EIP-712 域绑定 Settlement 地址而随换址整体作废（与整栈更换同
///         口径，见 docs/round62-nonce-bitmap-2026-11-10.md §10.6）。故本轮
///         只部署新 Settlement 并把现行 Vault 改指，用户余额与 Vault 状态
///         原地保留，无需迁移。配置从旧 Settlement 链上 1:1 复制
///         （governance / chainConfig / feeBps / meterKeepBps /
///         gasDeductCapBps / maxFailureGasChargeQuote；feeDistributor 沿用旧
///         实例），并以环境变量对 feeDistributor 与 governance（第 61 轮
///         Governance）做读回核对，不一致直接 revert。relayer 保持未设
///         （开放提交 B 模型，与旧实例现状一致）。MakerVault 已退役，不
///         部署；Governance 与 ContributorReward 不动。旧 Settlement 原样
///         保留作回滚（Vault 改指回旧地址即回滚）。
///         必需环境变量：PRIVATE_KEY（部署者 = 新 Settlement owner = 现行
///         Vault owner）、OLD_SETTLEMENT_ADDRESS、FEE_DISTRIBUTOR_ADDRESS、
///         EXPECTED_GOVERNANCE。仅测试网；按链分别跑（TARGET_CHAIN_ID 护栏）。
contract DeployR62 is ChainGuard {
    function run() external {
        _assertTargetChain();
        address oldAddr = vm.envAddress("OLD_SETTLEMENT_ADDRESS");
        address fdExpected = vm.envAddress("FEE_DISTRIBUTOR_ADDRESS");
        address govExpected = vm.envAddress("EXPECTED_GOVERNANCE");

        Settlement oldSettlement = Settlement(payable(oldAddr));
        address vaultAddr = address(oldSettlement.vault());
        address feeDistributorAddr = address(oldSettlement.feeDistributor());
        require(feeDistributorAddr == fdExpected, "DeployR62: FD mismatch with old Settlement");
        address governance = oldSettlement.governance();
        require(governance == govExpected, "DeployR62: governance mismatch with old Settlement");
        address chainConfig = oldSettlement.chainConfig();
        uint16 feeBps = oldSettlement.feeBps();
        uint16 meterKeepBps = oldSettlement.meterKeepBps();
        uint16 gasDeductCapBps = oldSettlement.gasDeductCapBps();
        uint256 maxFailureGasChargeQuote = oldSettlement.maxFailureGasChargeQuote();
        console.log("Copying config from old Settlement", oldAddr);
        console.log("  vault (kept, re-pointed)", vaultAddr);
        console.log("  governance", governance);
        console.log("  chainConfig", chainConfig);
        console.log("  feeBps", feeBps);
        console.log("  meterKeepBps", meterKeepBps);
        console.log("  gasDeductCapBps", gasDeductCapBps);
        console.log("  maxFailureGasChargeQuote", maxFailureGasChargeQuote);

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        require(Vault(vaultAddr).owner() == deployer, "DeployR62: vault owner is not deployer");
        vm.startBroadcast(pk);

        Settlement settlement = new Settlement(vaultAddr, feeDistributorAddr);
        console.log("Settlement (new, r62 nonce bitmap)", address(settlement));

        settlement.setGovernance(governance);
        settlement.setChainConfig(chainConfig);
        settlement.setFeeBps(feeBps);
        settlement.setMeterKeepBps(meterKeepBps);
        settlement.setGasDeductCapBps(gasDeductCapBps);
        settlement.setMaxFailureGasChargeQuote(maxFailureGasChargeQuote);
        console.log("Settlement config copied 1:1");

        Vault(vaultAddr).setSettlement(address(settlement));
        console.log("Vault.setSettlement -> new Settlement done");

        vm.stopBroadcast();
    }
}
