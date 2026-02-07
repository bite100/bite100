// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/Vault.sol";
import "../src/FeeDistributor.sol";
import "../src/Settlement.sol";
import "../src/AMMPool.sol";
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
