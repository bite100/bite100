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
}
