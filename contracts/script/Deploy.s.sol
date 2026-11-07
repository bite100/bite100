// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ChainGuard.sol";
import "../src/Vault.sol";
import "../src/FeeDistributor.sol";
import "../src/Settlement.sol";
import "../src/ContributorReward.sol";
import "../src/Governance.sol";
import "../src/TokenRegistry.sol";
import "../src/ChainConfig.sol";
import "../src/NodeRegistry.sol";
import "../src/mock/MockERC20.sol";

/// @title 部署脚本：Vault → FeeDistributor → Settlement（+ 可选 Mock 代币 / 治理 / 奖励）
/// @notice 链参数化（第七轮）：目标链由 --rpc-url 决定；设置 TARGET_CHAIN_ID 时
///         各入口会先校验当前 chainId 与之相等，防误部署到错链（见 ChainGuard）。
contract Deploy is ChainGuard {
    function run() external {
        _assertTargetChain();
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
        // 4b. 挂单锁定 locker = 部署/运营身份（第十五轮；主网须换成中继集合，见 docs/order-balance-locking.md）
        vault.setLocker(deployer, true);

        // 5. FeeDistributor：开发者 5% 自动到账，其余 95% 由接收方 claim
        address developer = vm.envOr("DEVELOPER_ADDRESS", deployer);
        feeDistributor.setDeveloperAddress(developer);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        address[] memory accounts = new address[](1);
        accounts[0] = feeRecipient;
        uint16[] memory shareBps = new uint16[](1);
        shareBps[0] = 9900; // 99%，开发者 1% 已单独自动转
        feeDistributor.setRecipients(accounts, shareBps);

        vm.stopBroadcast();

        _logDeployments(address(vault), address(feeDistributor), address(settlement), address(0), address(0));
    }

    /// @notice 部署核心合约 + 测试用 Mock 代币（仅测试网）
    /// @dev 第十七轮 AMM 下线后由此前 runWithAmmAndMocks 更名：不再部署 AMM 池。
    function runWithMocks() external {
        _assertTargetChain();
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        Vault vault = new Vault();
        FeeDistributor feeDistributor = new FeeDistributor();
        Settlement settlement = new Settlement(address(vault), address(feeDistributor));
        vault.setSettlement(address(settlement));
        vault.setLocker(deployer, true); // 挂单锁定 locker = 部署/运营身份（第十五轮）

        address developer = vm.envOr("DEVELOPER_ADDRESS", deployer);
        feeDistributor.setDeveloperAddress(developer);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        address[] memory accounts = new address[](1);
        accounts[0] = feeRecipient;
        uint16[] memory shareBps = new uint16[](1);
        shareBps[0] = 9900; // 99%，开发者 1% 已单独自动转
        feeDistributor.setRecipients(accounts, shareBps);

        // Mock 代币
        MockERC20 token0 = new MockERC20("Test Token A", "TKA", 1_000_000e18);
        MockERC20 token1 = new MockERC20("Test Token B", "TKB", 1_000_000e18);

        vm.stopBroadcast();

        console.log("Vault", address(vault));
        console.log("FeeDistributor", address(feeDistributor));
        console.log("Settlement", address(settlement));
        console.log("Token0 (Mock)", address(token0));
        console.log("Token1 (Mock)", address(token1));

        _logDeployments(address(vault), address(feeDistributor), address(settlement), address(token0), address(token1));
    }

    /// @notice 【已通用化】旧名保留为别名，避免旧文档（DEPLOY-SEPOLIA.md）失效；实现见 runSetFeeBps
    function runSetFeeBpsSepolia() external {
        _setFeeBps();
    }

    /// @notice 更新任意链上已有 Settlement 的费率（链由 --rpc-url 决定）；需 owner 私钥
    /// 必需环境变量：SETTLEMENT_ADDRESS（旧版写死的默认地址指向最早部署、已作废，故改为必填）
    /// 可选环境变量：FEE_BPS（默认 1 = 0.01%）
    function runSetFeeBps() external {
        _setFeeBps();
    }

    function _setFeeBps() internal {
        _assertTargetChain();
        address settlementAddr = vm.envAddress("SETTLEMENT_ADDRESS");
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(1)));
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        Settlement(settlementAddr).setFeeBps(feeBps);
        vm.stopBroadcast();
        console.log("Settlement feeBps set to", feeBps);
    }

    /// @notice 部署 Governance 并绑定目标合约
    /// 可选环境变量：SETTLEMENT_ADDRESS, CONTRIBUTOR_REWARD_ADDRESS, FEE_DISTRIBUTOR_ADDRESS
    function runGovernance() external {
        _assertTargetChain();
        address settlementAddr = vm.envOr("SETTLEMENT_ADDRESS", address(0));
        address contributorRewardAddr = vm.envOr("CONTRIBUTOR_REWARD_ADDRESS", address(0));
        address feeDistributorAddr = vm.envOr("FEE_DISTRIBUTOR_ADDRESS", address(0));
        require(
            settlementAddr != address(0) || contributorRewardAddr != address(0) || feeDistributorAddr != address(0),
            "set at least one target"
        );

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        Governance gov = new Governance();

        if (settlementAddr != address(0)) {
            Settlement(settlementAddr).setGovernance(address(gov));
        }
        if (contributorRewardAddr != address(0)) {
            ContributorReward(contributorRewardAddr).setGovernance(address(gov));
        }
        if (feeDistributorAddr != address(0)) {
            FeeDistributor(feeDistributorAddr).setGovernance(address(gov));
        }

        vm.stopBroadcast();
        console.log("Governance", address(gov));
    }

    /// @notice 部署 TokenRegistry 与 ChainConfig，并设置 Governance
    function runTokenRegistryAndChainConfig() external {
        _assertTargetChain();
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
        _assertTargetChain();
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);
        ContributorReward contributorReward = new ContributorReward();
        vm.stopBroadcast();
        console.log("ContributorReward", address(contributorReward));
        console.log("Note: Inject reward pool via setPeriodReward to enable claiming");
    }

    /// @notice 部署 NodeRegistry（节点钱包绑定，用于上线奖励分发）
    function runNodeRegistry() external {
        _assertTargetChain();
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        NodeRegistry registry = new NodeRegistry();
        vm.stopBroadcast();
        console.log("NodeRegistry", address(registry));
        console.log("Usage: Node operators call register(nodeIdHash, wallet) to bind reward wallet");
    }

    /// @notice 重新部署 Settlement（当前源码含 governance），并绑定 Governance
    /// 依赖现有：VAULT_ADDRESS, FEE_DISTRIBUTOR_ADDRESS, GOVERNANCE_ADDRESS
    /// PRIVATE_KEY 需为 Vault owner（与 Settlement 部署者一致）
    /// @dev 第十七轮 AMM 下线后由此前 runRedeploySettlementAndAmmPool 更名。
    function runRedeploySettlement() external {
        _assertTargetChain();
        address vaultAddr = vm.envAddress("VAULT_ADDRESS");
        address feeDistributorAddr = vm.envAddress("FEE_DISTRIBUTOR_ADDRESS");
        address govAddr = vm.envAddress("GOVERNANCE_ADDRESS");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        Settlement settlement = new Settlement(vaultAddr, feeDistributorAddr);
        console.log("Settlement", address(settlement));

        Vault(vaultAddr).setSettlement(address(settlement));
        settlement.setGovernance(govAddr);

        vm.stopBroadcast();
        console.log("Vault.setSettlement + setGovernance done.");
    }

    /// @notice 主网一键部署：核心 + 治理
    /// 需设置：PRIVATE_KEY
    /// 可选：FEE_RECIPIENT, DEVELOPER_ADDRESS（开发者 1% 自动到账地址，默认同 deployer）, MAINNET_RPC_URL
    function runMainnetFull() external {
        _assertTargetChain();
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        Vault vault = new Vault();
        FeeDistributor feeDistributor = new FeeDistributor();
        Settlement settlement = new Settlement(address(vault), address(feeDistributor));
        vault.setSettlement(address(settlement));
        vault.setLocker(deployer, true); // 挂单锁定 locker = 部署/运营身份（第十五轮）

        address developer = vm.envOr("DEVELOPER_ADDRESS", deployer);
        feeDistributor.setDeveloperAddress(developer);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        address[] memory accounts = new address[](1);
        accounts[0] = feeRecipient;
        uint16[] memory shareBps = new uint16[](1);
        shareBps[0] = 9900; // 99%，开发者 1% 已单独自动转
        feeDistributor.setRecipients(accounts, shareBps);

        ContributorReward contributorReward = new ContributorReward();
        Governance gov = new Governance();

        settlement.setGovernance(address(gov));
        contributorReward.setGovernance(address(gov));

        TokenRegistry tokenRegistry = new TokenRegistry();
        ChainConfig chainConfig = new ChainConfig();
        tokenRegistry.setGovernance(address(gov));
        chainConfig.setGovernance(address(gov));

        vm.stopBroadcast();

        console.log("Vault", address(vault));
        console.log("FeeDistributor", address(feeDistributor));
        console.log("Settlement", address(settlement));
        console.log("ContributorReward", address(contributorReward));
        console.log("Governance", address(gov));
        console.log("TokenRegistry", address(tokenRegistry));
        console.log("ChainConfig", address(chainConfig));
    }

    function _logDeployments(
        address vault,
        address feeDistributor,
        address settlement,
        address token0,
        address token1
    ) internal view {
        console.log("--- Deployments (chainId:", block.chainid, ") ---");
        console.log("vault", vault);
        console.log("feeDistributor", feeDistributor);
        console.log("settlement", settlement);
        console.log("token0", token0);
        console.log("token1", token1);
    }
}
