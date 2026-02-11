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
        // maker 卖 100 tokenA 买 tokenB，taker 卖 tokenB 买 tokenA，1:1 比例；0.01% 双边收取，无 cap
        uint256 amountIn = 100e18;
        uint256 amountOut = 100e18;
        // feeIn = 0.01e18, feeOut = 0.01e18，maker 收 99.99e18 tokenB，taker 收 99.99e18 tokenA
        settlement.settleTrade(maker, taker, address(tokenA), address(tokenB), amountIn, amountOut, 0, 0);

        assertEq(vault.balanceOf(address(tokenA), maker), 400e18);
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenB), taker), 400e18);
        assertEq(tokenA.balanceOf(address(feeDistributor)), 0.01e18);
        assertEq(tokenB.balanceOf(address(feeDistributor)), 0.01e18);
    }

    function test_SettleTrade_WithFeeCap() public {
        // 设置 tokenA 手续费上限 0.005e18（低于 0.01% 的 100e18），tokenB 无 cap
        settlement.setFeeCap(address(tokenA), 0.005e18);
        uint256 amountIn = 100e18;
        uint256 amountOut = 100e18;
        // feeIn 按 0.01% 应为 0.01e18，被 cap 为 0.005e18；feeOut = 0.01e18
        settlement.settleTrade(maker, taker, address(tokenA), address(tokenB), amountIn, amountOut, 0, 0);

        assertEq(vault.balanceOf(address(tokenB), maker), 100e18 - 0.01e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 100e18 - 0.005e18);
        assertEq(tokenA.balanceOf(address(feeDistributor)), 0.005e18);
        assertEq(tokenB.balanceOf(address(feeDistributor)), 0.01e18);
    }

    function test_SettleTrade_WithGasReimburse() public {
        address exchange = makeAddr("exchange");
        settlement.setRelayer(exchange);
        uint256 amountIn = 100e18;
        uint256 amountOut = 100e18;
        uint256 gasIn = 0.5e18;  // 卖方均摊（从 tokenIn 扣给交易所）
        uint256 gasOut = 0.5e18; // 买方均摊（从 tokenOut 扣给交易所）
        vm.prank(exchange);
        settlement.settleTrade(maker, taker, address(tokenA), address(tokenB), amountIn, amountOut, gasIn, gasOut);

        // feeIn=0.01e18, feeOut=0.01e18；maker 收 amountOut - feeOut - gasOut = 99.49e18，taker 收 amountIn - feeIn - gasIn = 99.49e18
        assertEq(vault.balanceOf(address(tokenB), maker), 99.49e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.49e18);
        assertEq(tokenA.balanceOf(address(feeDistributor)), 0.01e18);
        assertEq(tokenB.balanceOf(address(feeDistributor)), 0.01e18);
        assertEq(tokenA.balanceOf(exchange), 0.5e18);
        assertEq(tokenB.balanceOf(exchange), 0.5e18);
    }

    /// @notice Relayer 防滥用：白名单 isRelayer 可调用 settleTrade
    function test_SettleTrade_IsRelayerWhitelist() public {
        address whitelistRelayer = makeAddr("whitelistRelayer");
        settlement.setRelayerAllowed(whitelistRelayer, true);
        uint256 amountIn = 100e18;
        uint256 amountOut = 100e18;
        vm.prank(whitelistRelayer);
        settlement.settleTrade(maker, taker, address(tokenA), address(tokenB), amountIn, amountOut, 0, 0);
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
    }

    /// @notice Relayer 防滥用：maxGasReimbursePerTrade 超限 revert
    function test_SettleTrade_MaxGasReimburseCap() public {
        address exchange = makeAddr("exchange");
        settlement.setRelayer(exchange);
        settlement.setMaxGasReimbursePerTrade(0.5e18); // 单笔 gas 报销上限 0.5e18
        uint256 amountIn = 100e18;
        uint256 amountOut = 100e18;
        uint256 gasIn = 0.3e18;
        uint256 gasOut = 0.3e18; // gasIn + gasOut = 0.6e18 > 0.5e18
        vm.prank(exchange);
        vm.expectRevert("Settlement: gas reimburse cap");
        settlement.settleTrade(maker, taker, address(tokenA), address(tokenB), amountIn, amountOut, gasIn, gasOut);
    }

    /// @notice Relayer 防滥用：maxGasReimbursePerTrade 等于上限可成功
    function test_SettleTrade_MaxGasReimburseAtCap() public {
        address exchange = makeAddr("exchange");
        settlement.setRelayer(exchange);
        settlement.setMaxGasReimbursePerTrade(0.5e18);
        uint256 amountIn = 100e18;
        uint256 amountOut = 100e18;
        uint256 gasIn = 0.25e18;
        uint256 gasOut = 0.25e18; // gasIn + gasOut = 0.5e18 == cap
        vm.prank(exchange);
        settlement.settleTrade(maker, taker, address(tokenA), address(tokenB), amountIn, amountOut, gasIn, gasOut);
        assertEq(tokenA.balanceOf(exchange), 0.25e18);
        assertEq(tokenB.balanceOf(exchange), 0.25e18);
    }
}
