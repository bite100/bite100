// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ChainGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/Settlement.sol";
import "../src/MakerVault.sol";
import "../src/Vault.sol";

/// @title 阶段 3：Route A 签名方向 + B 开放提交 —— 新 Vault + 新 Settlement + 新 MakerVault
/// @notice 背景：阶段 3 合约轮（Route A：side 进入 EIP-712 签名结构；
///         Settlement 开放提交 B 模型；ERC-1271 变长签名修复；Vault 落锁
///         方向改由签名 side 派生、删除调用者自填方向参数）。合约不可升级：
///         Settlement 的 vault 指针只在构造函数设定、MakerVault 的
///         tradingVault 为 immutable，故三合约连带重部署。本脚本与第 33 轮
///         DeployR33 同构（一次广播完成部署与接线），配置从旧 Settlement
///         链上原样复制（governance / chainConfig / feeBps / meterKeepBps /
///         gasDeductCapBps / maxFailureGasChargeQuote；feeDistributor 沿用
///         旧实例、由环境变量传入并与旧实例读回值核对）。relayer 角色在
///         B 模型下不再是结算门禁（仅 chargeFailedSettlement 举报考销费
///         用），新实例保持未设，与第 34 轮读回现状一致。
///         切换语义（见 docs/stage3-contract-matching-2026-11-08.md 的
///         runbook）：域绑定 Settlement 地址，换地址即换 digest——旧结构
///         体订单在新域下验签必失败、全部作废；旧 Vault 的锁留在旧合约
///         里，用户在旧 Vault 自行 releaseOrderLock 取回或等过期自动可取。
///           1) 新 Vault；
///           2) 新 Settlement（指向新 Vault，配置复制如上）；
///           3) 新 Vault.setSettlement(新 Settlement) 回指；
///           4) 新 Vault.setLocker(部署者, true)：保留 locker 兼容路径；
///           5) 新 MakerVault（参数与旧金库相同，tradingVault 指向新 Vault）；
///           6) MakerVault.setSigner(签名者, ROLE_MARKET_MAKER, true) 重新注册。
///         仅测试网；按链分别跑（TARGET_CHAIN_ID 护栏）。
///         迁移窗口前提（同第二十七轮）：切换前节点无 pending/retry/submitting
///         中的成交且无带锁的开放订单。
///         必需环境变量：PRIVATE_KEY（部署者 = 新合约 owner）、
///         FEE_DISTRIBUTOR_ADDRESS、OLD_SETTLEMENT_ADDRESS、
///         ASSET（金库资产，如 USDT）、BASE_TOKEN（金库标的，如 BTC/ETH）、
///         PRICE_FEED（Chainlink 参考价）、SIGNER_ADDRESS（金库签名者 EOA）
contract DeployStage3 is ChainGuard {
    function run() external {
        _assertTargetChain();
        address feeDistributorAddr = vm.envAddress("FEE_DISTRIBUTOR_ADDRESS");
        address oldSettlementAddr = vm.envAddress("OLD_SETTLEMENT_ADDRESS");
        address asset = vm.envAddress("ASSET");
        address baseToken = vm.envAddress("BASE_TOKEN");
        address priceFeed = vm.envAddress("PRICE_FEED");
        address signerAddr = vm.envAddress("SIGNER_ADDRESS");

        Settlement oldSettlement = Settlement(payable(oldSettlementAddr));
        require(address(oldSettlement.feeDistributor()) == feeDistributorAddr, "DeployStage3: FD mismatch with old Settlement");
        address governance = oldSettlement.governance();
        address chainConfig = oldSettlement.chainConfig();
        uint16 feeBps = oldSettlement.feeBps();
        uint16 meterKeepBps = oldSettlement.meterKeepBps();
        uint16 gasDeductCapBps = oldSettlement.gasDeductCapBps();
        uint256 maxFailureGasChargeQuote = oldSettlement.maxFailureGasChargeQuote();
        console.log("Copying config from old Settlement", oldSettlementAddr);
        console.log("  governance", governance);
        console.log("  chainConfig", chainConfig);
        console.log("  feeBps", feeBps);
        console.log("  meterKeepBps", meterKeepBps);
        console.log("  gasDeductCapBps", gasDeductCapBps);
        console.log("  maxFailureGasChargeQuote", maxFailureGasChargeQuote);

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);

        Vault vault = new Vault();
        console.log("Vault (new, L2 + reentrancy guard)", address(vault));

        Settlement settlement = new Settlement(address(vault), feeDistributorAddr);
        console.log("Settlement (new)", address(settlement));

        settlement.setGovernance(governance);
        settlement.setChainConfig(chainConfig);
        settlement.setFeeBps(feeBps);
        settlement.setMeterKeepBps(meterKeepBps);
        settlement.setGasDeductCapBps(gasDeductCapBps);
        settlement.setMaxFailureGasChargeQuote(maxFailureGasChargeQuote);
        console.log("Settlement config copied 1:1");

        vault.setSettlement(address(settlement));
        console.log("Vault.setSettlement -> new Settlement done");

        vault.setLocker(deployer, true);
        console.log("Vault.setLocker(deployer, true) done (compat path)");

        MakerVault makerVault = new MakerVault(IERC20(asset), address(vault), baseToken, priceFeed);
        console.log("MakerVault (new)", address(makerVault));
        console.log("  asset", asset);
        console.log("  base", baseToken);
        console.log("  feed", priceFeed);

        makerVault.setSigner(signerAddr, makerVault.ROLE_MARKET_MAKER(), true);
        console.log("MakerVault signer registered", signerAddr);

        vm.stopBroadcast();
    }
}
