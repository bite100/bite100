// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/FeeDistributor.sol";
import "../src/mock/MockERC20.sol";

contract SettlementTest is Test {
    Vault vault;
    Settlement settlement;
    FeeDistributor feeDistributor;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address owner;
    address maker;
    address taker;

    function setUp() public {
        owner = address(this);
        maker = makeAddr("maker");
        taker = makeAddr("taker");

        tokenA = new MockERC20("TokenA", "TKA", 1_000_000e18);
        tokenB = new MockERC20("TokenB", "TKB", 1_000_000e18);

        vault = new Vault();
        feeDistributor = new FeeDistributor();
        settlement = new Settlement(address(vault), address(feeDistributor));
        vault.setSettlement(address(settlement));

        tokenA.transfer(maker, 1000e18);
        tokenB.transfer(taker, 1000e18);

        vm.startPrank(maker);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(address(tokenA), 500e18);
        vm.stopPrank();

        vm.startPrank(taker);
        tokenB.approve(address(vault), type(uint256).max);
        vault.deposit(address(tokenB), 500e18);
        vm.stopPrank();
    }

    function test_SettleTrade() public {
        // maker 卖 100 tokenA 买 tokenB，taker 卖 tokenB 买 tokenA，1:1 比例
        uint256 amountIn = 100e18;
        uint256 amountOut = 100e18; // 0.05% fee = 0.05e18, maker gets 99.95e18
        settlement.settleTrade(maker, taker, address(tokenA), address(tokenB), amountIn, amountOut);

        assertEq(vault.balanceOf(address(tokenA), maker), 400e18);
        assertEq(vault.balanceOf(address(tokenB), maker), 99.95e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 100e18);
        assertEq(vault.balanceOf(address(tokenB), taker), 400e18);
        assertEq(tokenB.balanceOf(address(feeDistributor)), 0.05e18);
    }
}
