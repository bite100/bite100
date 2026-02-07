// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/TokenRegistry.sol";

contract TokenRegistryTest is Test {
    TokenRegistry registry;
    address governance;
    address token1;
    address token2;

    function setUp() public {
        registry = new TokenRegistry();
        governance = makeAddr("governance");
        registry.setGovernance(governance);
        token1 = makeAddr("token1");
        token2 = makeAddr("token2");
    }

    function test_AddAndRemoveToken() public {
        vm.prank(governance);
        registry.addToken(token1);
        assertTrue(registry.isListed(token1));
        assertEq(registry.listedCount(), 1);

        vm.prank(governance);
        registry.addToken(token2);
        assertTrue(registry.isListed(token2));
        assertEq(registry.listedCount(), 2);

        vm.prank(governance);
        registry.removeToken(token1);
        assertFalse(registry.isListed(token1));
        assertTrue(registry.isListed(token2));
        assertEq(registry.listedCount(), 1);
    }

    function test_OnlyGovernanceCanAdd() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert("TokenRegistry: not governance");
        registry.addToken(token1);
    }
}
