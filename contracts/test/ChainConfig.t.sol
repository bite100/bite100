// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/ChainConfig.sol";

contract ChainConfigTest is Test {
    ChainConfig config;
    address governance;

    function setUp() public {
        config = new ChainConfig();
        governance = makeAddr("governance");
        config.setGovernance(governance);
    }

    function test_AddAndRemoveChain() public {
        vm.prank(governance);
        config.addChain(1);
        assertTrue(config.isSupported(1));
        assertEq(config.supportedCount(), 1);

        vm.prank(governance);
        config.addChain(11155111);
        assertTrue(config.isSupported(11155111));
        assertEq(config.supportedCount(), 2);

        vm.prank(governance);
        config.removeChain(1);
        assertFalse(config.isSupported(1));
        assertTrue(config.isSupported(11155111));
        assertEq(config.supportedCount(), 1);
    }

    function test_OnlyGovernanceCanAdd() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert("ChainConfig: not governance");
        config.addChain(1);
    }

    /// @notice 第二十一轮：gas 换算参考价（quote + ETH 参考价）owner 可设、治理亦可更新、无关地址被拒
    function test_QuotePricing() public {
        address token = makeAddr("quoteToken");
        config.setQuotePricing(token, 2000e18); // 测试合约即 owner
        assertEq(config.quoteToken(), token);
        assertEq(config.ethPriceInQuote(), 2000e18);

        vm.prank(governance);
        config.setQuotePricing(token, 2100e18);
        assertEq(config.ethPriceInQuote(), 2100e18);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert("ChainConfig: not auth");
        config.setQuotePricing(token, 1);
    }
}
