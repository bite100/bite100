// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ChainGuard.sol";
import "../src/mock/MockERC20.sol";

/// @title 部署脚本：主流交易对测试币（第二十五轮）
/// @notice 仅测试网：部署 BTC / ETH / SOL / BNB / XRP / DOGE / LINK + USDT 的
///         MockERC20（均为 18 位，与 TKA/TKB 同口径），各铸 1,000,000 给部署者。
///         不动任何现有合约，不改 Vault/Settlement/节点配置。
///         运行：TARGET_CHAIN_ID=<链> PRIVATE_KEY=<部署私钥>
///               forge script script/DeployMainstreamTokens.s.sol --rpc-url <链> --broadcast
contract DeployMainstreamTokens is ChainGuard {
    function run() external {
        _assertTargetChain();
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        MockERC20 btc = new MockERC20("Test Bitcoin", "BTC", 1_000_000e18);
        MockERC20 eth = new MockERC20("Test Ethereum", "ETH", 1_000_000e18);
        MockERC20 sol = new MockERC20("Test Solana", "SOL", 1_000_000e18);
        MockERC20 bnb = new MockERC20("Test BNB", "BNB", 1_000_000e18);
        MockERC20 xrp = new MockERC20("Test XRP", "XRP", 1_000_000e18);
        MockERC20 doge = new MockERC20("Test Dogecoin", "DOGE", 1_000_000e18);
        MockERC20 link = new MockERC20("Test Chainlink", "LINK", 1_000_000e18);
        MockERC20 usdt = new MockERC20("Test Tether", "USDT", 1_000_000e18);

        vm.stopBroadcast();

        console.log("Deployer", deployer);
        console.log("BTC", address(btc));
        console.log("ETH", address(eth));
        console.log("SOL", address(sol));
        console.log("BNB", address(bnb));
        console.log("XRP", address(xrp));
        console.log("DOGE", address(doge));
        console.log("LINK", address(link));
        console.log("USDT", address(usdt));
    }
}
