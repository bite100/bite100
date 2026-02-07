// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/Vault.sol";
import "../src/FeeDistributor.sol";
import "../src/Settlement.sol";
import "../src/AMMPool.sol";
import "../src/ContributorReward.sol";
import "../src/Governance.sol";
import "../src/TokenRegistry.sol";
import "../src/ChainConfig.sol";
import "../src/mock/MockERC20.sol";

/// @title 部署脚本：Vault → FeeDistributor → Settlement → (可选) AMM + Mock 代币
contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Vault
        Vault vault = new Vault();
        console.log("Vault", address(vault));

        // 2. FeeDistributor
        FeeDistributor feeDistributor = new FeeDistributor();
        console.log("FeeDistributor", address(feeDistributor));

        // 3. Settlement
        Settlement settlement = new Settlement(address(vault), address(feeDistributor));
        console.log("Settlement", address(settlement));

        // 4. Vault 绑定 Settlement
        vault.setSettlement(address(settlement));

        // 5. FeeDistributor 设置接收方（部署者 100%）
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        address[] memory accounts = new address[](1);
        accounts[0] = feeRecipient;
        uint16[] memory shareBps = new uint16[](1);
        shareBps[0] = 10000;
        feeDistributor.setRecipients(accounts, shareBps);

        vm.stopBroadcast();

        _logDeployments(address(vault), address(feeDistributor), address(settlement), address(0), address(0), address(0));
    }

    /// @notice 部署核心合约 + 测试用 Mock 代币与 AMM 池（仅测试网）
    function runWithAmmAndMocks() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        Vault vault = new Vault();
        FeeDistributor feeDistributor = new FeeDistributor();
        Settlement settlement = new Settlement(address(vault), address(feeDistributor));
        vault.setSettlement(address(settlement));

        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        address[] memory accounts = new address[](1);
        accounts[0] = feeRecipient;
        uint16[] memory shareBps = new uint16[](1);
        shareBps[0] = 10000;
        feeDistributor.setRecipients(accounts, shareBps);

        // Mock 代币
        MockERC20 token0 = new MockERC20("Test Token A", "TKA", 1_000_000e18);
        MockERC20 token1 = new MockERC20("Test Token B", "TKB", 1_000_000e18);

        // AMM 池
        AMMPool pool = new AMMPool(address(token0), address(token1), address(feeDistributor));

        vm.stopBroadcast();

        console.log("Vault", address(vault));
        console.log("FeeDistributor", address(feeDistributor));
        console.log("Settlement", address(settlement));
        console.log("Token0 (Mock)", address(token0));
        console.log("Token1 (Mock)", address(token1));
        console.log("AMMPool", address(pool));

        _logDeployments(address(vault), address(feeDistributor), address(settlement), address(token0), address(token1), address(pool));
    }

    /// @notice 更新 Sepolia 上已有 Settlement、AMMPool 的费率为 0.05%；需 owner 私钥
    function runSetFeeBpsSepolia() external {
        address settlementAddr = vm.envOr("SETTLEMENT_ADDRESS", address(0xDa9f738Cc8bF4a312473f1AAfF4929b367e22C85));
        address ammPoolAddr = vm.envOr("AMMPOOL_ADDRESS", address(0x85F18604a8e3ca3C87A1373e4110Ed5C337677d4));
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        Settlement(settlementAddr).setFeeBps(5);
        AMMPool(ammPoolAddr).setFeeBps(5);
        vm.stopBroadcast();
        console.log("Settlement feeBps set to 5 (0.05%)");
        console.log("AMMPool feeBps set to 5 (0.05%)");
    }

    /// @notice 部署 Governance 并绑定目标合约
    function runGovernance() external {
        address settlementAddr = vm.envOr("SETTLEMENT_ADDRESS", address(0));
        address ammPoolAddr = vm.envOr("AMMPOOL_ADDRESS", address(0));
        address contributorRewardAddr = vm.envOr("CONTRIBUTOR_REWARD_ADDRESS", address(0));
        require(settlementAddr != address(0) || ammPoolAddr != address(0) || contributorRewardAddr != address(0), "set at least one target");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        Governance gov = new Governance();

        if (settlementAddr != address(0)) {
            Settlement(settlementAddr).setGovernance(address(gov));
        }
        if (ammPoolAddr != address(0)) {
            AMMPool(ammPoolAddr).setGovernance(address(gov));
        }
        if (contributorRewardAddr != address(0)) {
            ContributorReward(contributorRewardAddr).setGovernance(address(gov));
        }

        vm.stopBroadcast();
        console.log("Governance", address(gov));
    }

    /// @notice 部署 TokenRegistry 与 ChainConfig，并设置 Governance
    function runTokenRegistryAndChainConfig() external {
        address govAddr = vm.envOr("GOVERNANCE_ADDRESS", address(0));
        require(govAddr != address(0), "set GOVERNANCE_ADDRESS");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        TokenRegistry tokenRegistry = new TokenRegistry();
        ChainConfig chainConfig = new ChainConfig();
        tokenRegistry.setGovernance(govAddr);
        chainConfig.setGovernance(govAddr);

        vm.stopBroadcast();
        console.log("TokenRegistry", address(tokenRegistry));
        console.log("ChainConfig", address(chainConfig));
    }

    /// @notice 仅部署 ContributorReward（贡献证明与按周期分配奖励）
    function runContributorReward() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);
        ContributorReward contributorReward = new ContributorReward();
        vm.stopBroadcast();
        console.log("ContributorReward", address(contributorReward));
    }

    function _logDeployments(
        address vault,
        address feeDistributor,
        address settlement,
        address token0,
        address token1,
        address ammPool
    ) internal view {
        console.log("--- Deployments (chainId:", block.chainid, ") ---");
        console.log("vault", vault);
        console.log("feeDistributor", feeDistributor);
        console.log("settlement", settlement);
        console.log("token0", token0);
        console.log("token1", token1);
        console.log("ammPool", ammPool);
    }
}
