// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/AMMPool.sol";
import "../src/FeeDistributor.sol";
import "../src/mock/MockERC20.sol";

contract AMMPoolTest is Test {
    AMMPool pool;
    FeeDistributor feeDistributor;
    MockERC20 token0;
    MockERC20 token1;

    address owner;
    address liquidityProvider;
    address trader;

    function setUp() public {
        owner = address(this);
        liquidityProvider = makeAddr("lp");
        trader = makeAddr("trader");

        token0 = new MockERC20("Token0", "TK0", 1_000_000e18);
        token1 = new MockERC20("Token1", "TK1", 1_000_000e18);

        feeDistributor = new FeeDistributor();
        pool = new AMMPool(address(token0), address(token1), address(feeDistributor));

        token0.transfer(liquidityProvider, 10000e18);
        token1.transfer(liquidityProvider, 10000e18);
        token0.transfer(trader, 1000e18);
        token1.transfer(trader, 1000e18);

        vm.prank(liquidityProvider);
        token0.approve(address(pool), type(uint256).max);
        vm.prank(liquidityProvider);
        token1.approve(address(pool), type(uint256).max);
        vm.prank(liquidityProvider);
        pool.addLiquidity(1000e18, 1000e18);
    }

    function test_AddLiquidityAndSwap() public {
        assertEq(pool.reserve0(), 1000e18);
        assertEq(pool.reserve1(), 1000e18);

        vm.startPrank(trader);
        token0.approve(address(pool), 100e18);
        uint256 out = pool.swap(address(token0), 100e18);
        vm.stopPrank();

        assertGt(out, 0);
        assertEq(token1.balanceOf(trader), 1000e18 + out);
        assertEq(token0.balanceOf(address(feeDistributor)), 100e18 * 30 / 10000);
    }
}
