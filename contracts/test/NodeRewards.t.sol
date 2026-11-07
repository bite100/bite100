// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/FeeDistributor.sol";
import "../src/NodeRewards.sol";
import "../src/mock/MockERC20.sol";

/// @title 第二十九轮：NodeRewards ↔ Settlement 配对的暗坑复刻与修复证据
/// @notice settleTradesBatchWithGasSavings 的 gas 节省分配会调用
///         NodeRewards.depositFounderReward，其要求 NodeRewards.settlement
///         恰为调用方 Settlement。历史上没有任何脚本调用 setSettlement：
///         只配 Settlement 侧（setNodeRewards/setFounder/setUsdtToken）时，
///         批量结算在分配环节整批 revert。本文件两个用例：漏设 → 整批
///         revert（成交回滚）；按 ConfigureNodeRewards.s.sol 补齐配对 →
///         同一批成功且创始人积分入账。
contract NodeRewardsTest is Test {
    Vault vault;
    Settlement settlement;
    FeeDistributor feeDistributor;
    NodeRewards nodeRewards;
    MockERC20 tokenA;
    MockERC20 tokenB;
    MockERC20 usdt;

    address founder;
    address maker;
    address taker;
    uint256 makerKey;
    uint256 takerKey;

    // gas 节省入参（USDT 6 位口径）：25% 进 FD、25% 记创始人积分
    uint256 constant GAS_SAVINGS = 100_000_000; // 100 USDT
    uint256 constant TO_FD = 25_000_000;
    uint256 constant TO_FOUNDER = 25_000_000;
    uint256 constant FOUNDER_POINTS = 25; // TO_FOUNDER / 1e6

    function setUp() public {
        vm.warp(1_760_000_000);
        founder = makeAddr("founder");
        (maker, makerKey) = makeAddrAndKey("maker");
        (taker, takerKey) = makeAddrAndKey("taker");

        tokenA = new MockERC20("TokenA", "TKA", 1_000_000e18);
        tokenB = new MockERC20("TokenB", "TKB", 1_000_000e18);
        usdt = new MockERC20("USD Tether", "USDT", 1_000_000e18);

        vault = new Vault();
        feeDistributor = new FeeDistributor();
        settlement = new Settlement(address(vault), address(feeDistributor));
        vault.setSettlement(address(settlement));
        vault.setLocker(address(this), true); // 测试合约充当节点 locker

        nodeRewards = new NodeRewards(address(usdt));

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

        // relayer（= 本测试合约）预授权 Settlement 拉取 gas 节省分配额
        usdt.approve(address(settlement), type(uint256).max);
    }

    // ---------- 与 Settlement.t.sol 同源的订单/锁定辅助 ----------

    function _order(address user, string memory orderId, uint256 amountIn, uint256 amountOut, uint256 nonce)
        internal
        view
        returns (Settlement.Order memory)
    {
        return Settlement.Order({
            orderId: orderId,
            userAddress: user,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: amountIn,
            amountOut: amountOut,
            price: (amountOut * 1e18) / amountIn,
            timestamp: block.timestamp,
            expiresAt: block.timestamp + 1 days,
            nonce: nonce
        });
    }

    function _signed(uint256 key, Settlement.Order memory order) internal view returns (Settlement.SignedOrder memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.orderDigest(order));
        return Settlement.SignedOrder({order: order, signature: abi.encodePacked(r, s, v)});
    }

    function _lock(Settlement.SignedOrder memory so, bool payWithTokenIn) internal {
        Settlement.Order memory o = so.order;
        vault.lockForOrder(
            VaultOrder({
                orderId: o.orderId, userAddress: o.userAddress, tokenIn: o.tokenIn, tokenOut: o.tokenOut,
                amountIn: o.amountIn, amountOut: o.amountOut, price: o.price, timestamp: o.timestamp,
                expiresAt: o.expiresAt, nonce: o.nonce
            }),
            so.signature,
            payWithTokenIn
        );
    }

    function _stdFill() internal view returns (Settlement.Fill memory) {
        Settlement.SignedOrder memory m = _signed(makerKey, _order(maker, "m1", 100e18, 100e18, 0));
        Settlement.SignedOrder memory t = _signed(takerKey, _order(taker, "t1", 100e18, 100e18, 0));
        return Settlement.Fill({
            makerOrder: m,
            takerOrder: t,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: 100e18,
            amountOut: 100e18,
            gasReimburseIn: 0,
            gasReimburseOut: 0
        });
    }

    function _batch() internal view returns (Settlement.Fill[] memory fills) {
        fills = new Settlement.Fill[](1);
        fills[0] = _stdFill();
    }

    /// @notice Settlement 侧配齐、唯独漏掉 NodeRewards.setSettlement（历史暗坑的原样复刻）
    function _wireExceptNodeRewardsSettlement() internal {
        settlement.setNodeRewards(address(nodeRewards));
        settlement.setFounder(founder);
        settlement.setUsdtToken(address(usdt));
    }

    // ---------- 用例 ----------

    /// @notice 漏设 NodeRewards.setSettlement → 批量结算整批 revert，成交回滚
    function test_BatchGasSavings_RevertsWhenNodeRewardsSettlementUnset() public {
        _wireExceptNodeRewardsSettlement();
        Settlement.Fill memory fill = _stdFill();
        _lock(fill.makerOrder, true);
        _lock(fill.takerOrder, false);

        // fills 必须在 expectRevert 之前构造好：_batch() 内部会调
        // orderDigest（外部调用），若放在 expectRevert 之后，期望会被那次
        // 调用消耗掉、真正的批量调用反而执行不到（本用例初版即栽于此）。
        Settlement.Fill[] memory fills = _batch();
        vm.expectRevert("NodeRewards: not settlement");
        settlement.settleTradesBatchWithGasSavings(fills, GAS_SAVINGS);

        // 整批回滚：成交未落账
        assertEq(vault.balanceOf(address(tokenA), maker), 500e18);
        assertEq(nodeRewards.devPoints(founder), 0);
    }

    /// @notice 按 ConfigureNodeRewards.s.sol 补齐配对 → 同一批成功，积分入账
    function test_BatchGasSavings_SucceedsAfterPairing() public {
        _wireExceptNodeRewardsSettlement();
        nodeRewards.setSettlement(address(settlement)); // 脚本的关键一步

        Settlement.Fill memory fill = _stdFill();
        _lock(fill.makerOrder, true);
        _lock(fill.takerOrder, false);
        settlement.settleTradesBatchWithGasSavings(_batch(), GAS_SAVINGS);

        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
        assertEq(nodeRewards.devPoints(founder), FOUNDER_POINTS);
        assertEq(usdt.balanceOf(address(feeDistributor)), TO_FD);
        assertEq(usdt.balanceOf(address(nodeRewards)), TO_FOUNDER);
    }
}
