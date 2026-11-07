// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ChainGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/Settlement.sol";
import "../src/MakerVault.sol";
import "../src/Vault.sol";

/// @title 第二十七轮：部署 ERC-1271 版 Settlement + 做市金库 MakerVault
/// @notice 背景：旧 Settlement 只支持 EOA ecrecover 验签，金库合约作为 userAddress
///         时无法验签登记签名者的订单，故必须换新 Settlement（ERC-1271 回退，
///         见 Settlement.verifyOrderSignature）。新实例从旧实例原样复制治理与
///         gas 规则配置（governance / chainConfig / meterKeepBps / gasDeductCapBps /
///         maxFailureGasChargeQuote；feeBps 默认 1；relayer/nodeRewards/founder/
///         usdtToken/feeCap 均为 0，与旧实例一致），然后把交易 Vault 的 settlement
///         指针切到新实例，再部署 MakerVault 并登记签名者。
///         仅测试网；一次广播完成双链各自部署（按链分别跑）。
///         迁移窗口：切换前须确认无 pending/retry/submitting 中的成交（否则新
///         Settlement 的空 orderFilled 状态可能对已结算成交重复结算）；部分成交
///         的未结订单可安全续结（新实例累计从 0 起算）。
///         必需环境变量：PRIVATE_KEY（Vault/Settlement/MakerVault owner = 部署者）、
///         VAULT_ADDRESS、FEE_DISTRIBUTOR_ADDRESS、OLD_SETTLEMENT_ADDRESS、
///         ASSET（金库资产，如 USDT）、BASE_TOKEN（金库标的，如 BTC/ETH）、
///         PRICE_FEED（Chainlink 参考价）、SIGNER_ADDRESS（金库签名者 EOA）
contract DeployMakerVault is ChainGuard {
    function run() external {
        _assertTargetChain();
        address vaultAddr = vm.envAddress("VAULT_ADDRESS");
        address feeDistributorAddr = vm.envAddress("FEE_DISTRIBUTOR_ADDRESS");
        address oldSettlementAddr = vm.envAddress("OLD_SETTLEMENT_ADDRESS");
        address asset = vm.envAddress("ASSET");
        address baseToken = vm.envAddress("BASE_TOKEN");
        address priceFeed = vm.envAddress("PRICE_FEED");
        address signerAddr = vm.envAddress("SIGNER_ADDRESS");

        Settlement oldSettlement = Settlement(payable(oldSettlementAddr));
        address governance = oldSettlement.governance();
        address chainConfig = oldSettlement.chainConfig();
        uint16 meterKeepBps = oldSettlement.meterKeepBps();
        uint16 gasDeductCapBps = oldSettlement.gasDeductCapBps();
        uint256 maxFailureGasChargeQuote = oldSettlement.maxFailureGasChargeQuote();
        console.log("Copying config from old Settlement", oldSettlementAddr);
        console.log("  governance", governance);
        console.log("  chainConfig", chainConfig);
        console.log("  meterKeepBps", meterKeepBps);
        console.log("  gasDeductCapBps", gasDeductCapBps);
        console.log("  maxFailureGasChargeQuote", maxFailureGasChargeQuote);

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        Settlement settlement = new Settlement(vaultAddr, feeDistributorAddr);
        console.log("Settlement (new)", address(settlement));

        settlement.setGovernance(governance);
        settlement.setChainConfig(chainConfig);
        settlement.setMeterKeepBps(meterKeepBps);
        settlement.setGasDeductCapBps(gasDeductCapBps);
        settlement.setMaxFailureGasChargeQuote(maxFailureGasChargeQuote);
        console.log("Settlement config copied (feeBps defaults 1)");

        Vault(vaultAddr).setSettlement(address(settlement));
        console.log("Vault.setSettlement -> new Settlement done");

        MakerVault makerVault = new MakerVault(IERC20(asset), vaultAddr, baseToken, priceFeed);
        console.log("MakerVault", address(makerVault));
        console.log("  asset", asset);
        console.log("  base", baseToken);
        console.log("  feed", priceFeed);

        makerVault.setSigner(signerAddr, makerVault.ROLE_MARKET_MAKER(), true);
        console.log("MakerVault signer registered", signerAddr);

        vm.stopBroadcast();
    }
}
