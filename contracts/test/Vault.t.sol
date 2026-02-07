// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/FeeDistributor.sol";
import "../src/mock/MockERC20.sol";

contract VaultTest is Test {
    Vault vault;
    Settlement settlement;
    FeeDistributor feeDistributor;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address owner;
    address user1;
    address user2;

    function setUp() public {
        owner = address(this);
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");

        tokenA = new MockERC20("TokenA", "TKA", 1_000_000e18);
        tokenB = new MockERC20("TokenB", "TKB", 1_000_000e18);

        vault = new Vault();
        feeDistributor = new FeeDistributor();
        settlement = new Settlement(address(vault), address(feeDistributor));
        vault.setSettlement(address(settlement));

        tokenA.transfer(user1, 1000e18);
        tokenB.transfer(user2, 1000e18);
    }

    function test_DepositAndWithdraw() public {
        vm.startPrank(user1);
        tokenA.approve(address(vault), 100e18);
        vault.deposit(address(tokenA), 100e18);
        assertEq(vault.balanceOf(address(tokenA), user1), 100e18);
        assertEq(tokenA.balanceOf(user1), 900e18);

        vault.withdraw(address(tokenA), 50e18);
        assertEq(vault.balanceOf(address(tokenA), user1), 50e18);
        assertEq(tokenA.balanceOf(user1), 950e18);
        vm.stopPrank();
    }

    function test_OnlySettlementCanTransferOut() public {
        vm.prank(user1);
        tokenA.approve(address(vault), 100e18);
        vm.prank(user1);
        vault.deposit(address(tokenA), 100e18);

        vm.prank(user2);
        vm.expectRevert("Vault: not settlement");
        vault.transferOut(user1, user2, address(tokenA), 10e18);

        vm.prank(address(settlement));
        vault.transferOut(user1, user2, address(tokenA), 10e18);
        assertEq(vault.balanceOf(address(tokenA), user1), 90e18);
        assertEq(tokenA.balanceOf(user2), 10e18);
    }
}
