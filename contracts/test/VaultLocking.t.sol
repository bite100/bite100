// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/FeeDistributor.sol";
import "../src/mock/MockERC20.sol";

/// @title 挂单余额锁定测试（第十五轮）：设计见 docs/order-balance-locking.md
/// 覆盖：落锁/重复锁/验签/授权/可用额闸门/部分成交消耗/撤单释放/过期释放/
/// 未锁结算被拒且失败不吞状态 等不变量。
contract VaultLockingTest is Test {
    Vault vault;
    Settlement settlement;
    FeeDistributor feeDistributor;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address locker;
    address maker;
    address taker;
    uint256 makerKey;
    uint256 takerKey;

    function setUp() public {
        vm.warp(1_760_000_000);
        locker = makeAddr("locker");
        (maker, makerKey) = makeAddrAndKey("maker");
        (taker, takerKey) = makeAddrAndKey("taker");

        tokenA = new MockERC20("TokenA", "TKA", 1_000_000e18);
        tokenB = new MockERC20("TokenB", "TKB", 1_000_000e18);

        vault = new Vault();
        feeDistributor = new FeeDistributor();
        settlement = new Settlement(address(vault), address(feeDistributor));
        vault.setSettlement(address(settlement));
        vault.setLocker(locker, true);

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

    // ---------- 辅助 ----------

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

    function _sign(uint256 key, Settlement.Order memory order) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.orderDigest(order));
        return abi.encodePacked(r, s, v);
    }

    function _signed(uint256 key, Settlement.Order memory order) internal view returns (Settlement.SignedOrder memory) {
        return Settlement.SignedOrder({order: order, signature: _sign(key, order)});
    }

    function _vaultOrder(Settlement.Order memory o) internal pure returns (VaultOrder memory) {
        return VaultOrder({
            orderId: o.orderId, userAddress: o.userAddress, tokenIn: o.tokenIn, tokenOut: o.tokenOut,
            amountIn: o.amountIn, amountOut: o.amountOut, price: o.price, timestamp: o.timestamp,
            expiresAt: o.expiresAt, nonce: o.nonce
        });
    }

    function _lock(Settlement.SignedOrder memory so, bool payWithTokenIn) internal returns (bytes32) {
        vm.prank(locker);
        return vault.lockForOrder(_vaultOrder(so.order), so.signature, payWithTokenIn);
    }

    /// @notice 卖方口径落锁（锁 tokenIn × amountIn）
    function _lockSell(Settlement.SignedOrder memory so) internal returns (bytes32) {
        return _lock(so, true);
    }

    /// @notice 买方口径落锁（锁 tokenOut × amountOut）
    function _lockBuy(Settlement.SignedOrder memory so) internal returns (bytes32) {
        return _lock(so, false);
    }

    function _fill(Settlement.SignedOrder memory m, Settlement.SignedOrder memory t, uint256 fillIn, uint256 fillOut)
        internal
        pure
        returns (Settlement.Fill memory)
    {
        return Settlement.Fill({
            makerOrder: m, takerOrder: t, tokenIn: m.order.tokenIn, tokenOut: m.order.tokenOut,
            amountIn: fillIn, amountOut: fillOut, gasReimburseIn: 0, gasReimburseOut: 0
        });
    }

    function _stdPair() internal view returns (Settlement.SignedOrder memory, Settlement.SignedOrder memory) {
        return (
            _signed(makerKey, _order(maker, "m1", 100e18, 100e18, 0)),
            _signed(takerKey, _order(taker, "t1", 100e18, 100e18, 0))
        );
    }

    function _assertInvariant(address user, address token) internal view {
        assertLe(vault.locked(user, token), vault.balanceOf(token, user), "invariant: locked <= balance");
    }

    // ---------- 落锁 ----------

    function test_Lock_BasicAccounting() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        bytes32 digest = _lockSell(m);
        assertEq(digest, settlement.orderDigest(m.order));
        assertEq(vault.locked(maker, address(tokenA)), 100e18);
        assertEq(vault.availableBalance(maker, address(tokenA)), 400e18);
        (address user, address token, uint256 remaining,) = vault.orderLocks(digest);
        assertEq(user, maker);
        assertEq(token, address(tokenA));
        assertEq(remaining, 100e18);
        _assertInvariant(maker, address(tokenA));
    }

    function test_Lock_DoubleLockReverts() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        _lockSell(m);
        vm.prank(locker);
        vm.expectRevert("Vault: order already locked");
        vault.lockForOrder(_vaultOrder(m.order), m.signature, true);
    }

    function test_Lock_InvalidSignatureReverts() public {
        Settlement.Order memory order = _order(maker, "m1", 100e18, 100e18, 0);
        bytes memory badSig = _sign(takerKey, order); // 用他人私钥签
        vm.prank(locker);
        vm.expectRevert("Vault: invalid order signature");
        vault.lockForOrder(_vaultOrder(order), badSig, true);
    }

    function test_Lock_NotLockerReverts() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        vm.prank(maker); // 连订单用户本人也不能直接上锁，只有 locker
        vm.expectRevert("Vault: not locker");
        vault.lockForOrder(_vaultOrder(m.order), m.signature, true);
    }

    function test_Lock_InsufficientAvailableReverts() public {
        // 余额 500：锁 600 超额
        Settlement.SignedOrder memory big = _signed(makerKey, _order(maker, "big", 600e18, 600e18, 0));
        vm.prank(locker);
        vm.expectRevert("Vault: insufficient available");
        vault.lockForOrder(_vaultOrder(big.order), big.signature, true);

        // 先锁 400，再锁另一单 200：可用只剩 100，第二单被拒
        Settlement.SignedOrder memory m1 = _signed(makerKey, _order(maker, "m1", 400e18, 400e18, 1));
        _lockSell(m1);
        Settlement.SignedOrder memory m2 = _signed(makerKey, _order(maker, "m2", 200e18, 200e18, 2));
        vm.prank(locker);
        vm.expectRevert("Vault: insufficient available");
        vault.lockForOrder(_vaultOrder(m2.order), m2.signature, true);
    }

    function test_Lock_ExpiredOrderReverts() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        vm.warp(block.timestamp + 2 days);
        vm.prank(locker);
        vm.expectRevert("Vault: order expired");
        vault.lockForOrder(_vaultOrder(m.order), m.signature, true);
    }

    // ---------- 提取闸门 ----------

    function test_Withdraw_GatedByLock() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        _lockSell(m); // 锁 100，可用 400

        vm.prank(maker);
        vm.expectRevert("Vault: insufficient available balance");
        vault.withdraw(address(tokenA), 400e18 + 1);

        vm.prank(maker);
        vault.withdraw(address(tokenA), 400e18); // 恰好提走全部可用
        assertEq(vault.balanceOf(address(tokenA), maker), 100e18);
        assertEq(vault.availableBalance(maker, address(tokenA)), 0);
        _assertInvariant(maker, address(tokenA));
    }

    // ---------- 释放 ----------

    function test_Release_ByLockerAndByUser() public {
        (Settlement.SignedOrder memory m, Settlement.SignedOrder memory t) = _stdPair();
        bytes32 dm = _lockSell(m);
        bytes32 dt = _lockBuy(t);

        vm.prank(locker);
        vault.releaseOrderLock(dm);
        assertEq(vault.locked(maker, address(tokenA)), 0);
        assertEq(vault.availableBalance(maker, address(tokenA)), 500e18);

        vm.prank(taker); // 用户本人释放自己的锁
        vault.releaseOrderLock(dt);
        assertEq(vault.locked(taker, address(tokenB)), 0);
    }

    function test_Release_UnauthorizedAndNonexistentRevert() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        bytes32 dm = _lockSell(m);
        vm.prank(taker); // 既非 locker 也非锁属用户
        vm.expectRevert("Vault: not authorized to release");
        vault.releaseOrderLock(dm);

        vm.prank(locker);
        vm.expectRevert("Vault: order not locked");
        vault.releaseOrderLock(keccak256("nonexistent"));
    }

    function test_ReleaseExpired_Permissionless() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        bytes32 dm = _lockSell(m);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert("Vault: order not expired");
        vault.releaseExpiredOrderLock(dm);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(stranger); // 过期后任何人可释放
        vault.releaseExpiredOrderLock(dm);
        assertEq(vault.locked(maker, address(tokenA)), 0);
        assertEq(vault.availableBalance(maker, address(tokenA)), 500e18);
    }

    // ---------- 结算消费 ----------

    function test_Settle_ConsumesLockFully() public {
        (Settlement.SignedOrder memory m, Settlement.SignedOrder memory t) = _stdPair();
        bytes32 dm = _lockSell(m);
        bytes32 dt = _lockBuy(t);

        settlement.settleTrade(_fill(m, t, 100e18, 100e18));

        assertEq(vault.locked(maker, address(tokenA)), 0);
        assertEq(vault.locked(taker, address(tokenB)), 0);
        (address u1,, uint256 r1,) = vault.orderLocks(dm);
        (address u2,, uint256 r2,) = vault.orderLocks(dt);
        assertEq(u1, address(0)); // 记录已清除
        assertEq(u2, address(0));
        assertEq(r1, 0);
        assertEq(r2, 0);
        // 结算金额与无锁时代口径一致
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
        _assertInvariant(maker, address(tokenA));
        _assertInvariant(taker, address(tokenB));
    }

    function test_Settle_PartialFillsConsumeProportionally_ThenCancelReleasesRemainder() public {
        (Settlement.SignedOrder memory m, Settlement.SignedOrder memory t) = _stdPair();
        bytes32 dm = _lockSell(m);
        _lockBuy(t);

        settlement.settleTrade(_fill(m, t, 60e18, 60e18));
        (, , uint256 remaining,) = vault.orderLocks(dm);
        assertEq(remaining, 40e18);
        assertEq(vault.locked(maker, address(tokenA)), 40e18);
        _assertInvariant(maker, address(tokenA));

        // 撤单：只释放未成交的 40，已成交的 60 不会被重复释放
        vm.prank(locker);
        vault.releaseOrderLock(dm);
        assertEq(vault.locked(maker, address(tokenA)), 0);
        assertEq(vault.balanceOf(address(tokenA), maker), 440e18); // 500 − 60 已结算
        assertEq(vault.availableBalance(maker, address(tokenA)), 440e18);
    }

    function test_Settle_TwoPartialsConsumeAll() public {
        (Settlement.SignedOrder memory m, Settlement.SignedOrder memory t) = _stdPair();
        _lockSell(m);
        _lockBuy(t);
        settlement.settleTrade(_fill(m, t, 60e18, 60e18));
        settlement.settleTrade(_fill(m, t, 40e18, 40e18));
        assertEq(vault.locked(maker, address(tokenA)), 0);
        assertEq(vault.locked(taker, address(tokenB)), 0);
        assertEq(settlement.orderFilledIn(settlement.orderDigest(m.order)), 100e18);
    }

    function test_Settle_UnlockedOrderReverts_AndStateUnchanged() public {
        (Settlement.SignedOrder memory m, Settlement.SignedOrder memory t) = _stdPair();
        // 双方均未落锁
        vm.expectRevert("Vault: order not locked");
        settlement.settleTrade(_fill(m, t, 100e18, 100e18));
        // 结算失败不吞任何状态：成交量未记账、nonce 未消耗、余额未动
        assertEq(settlement.orderFilledIn(settlement.orderDigest(m.order)), 0);
        assertEq(settlement.getCurrentNonce(maker), 0);
        assertEq(vault.balanceOf(address(tokenA), maker), 500e18);

        // 只锁一侧也不行（taker 侧缺锁）
        _lockSell(m);
        vm.expectRevert("Vault: order not locked");
        settlement.settleTrade(_fill(m, t, 100e18, 100e18));
        assertEq(vault.locked(maker, address(tokenA)), 100e18); // maker 的锁未被失败结算吞掉
        assertEq(settlement.orderFilledIn(settlement.orderDigest(m.order)), 0);
    }

    function test_Settle_AfterUserReleaseReverts() public {
        (Settlement.SignedOrder memory m, Settlement.SignedOrder memory t) = _stdPair();
        bytes32 dm = _lockSell(m);
        _lockBuy(t);
        vm.prank(maker); // 用户自行释放（等价撤单意图）后，该单不可再结算
        vault.releaseOrderLock(dm);
        vm.expectRevert("Vault: order not locked");
        settlement.settleTrade(_fill(m, t, 100e18, 100e18));
    }

    // ---------- locker 管理 ----------

    function test_SetLocker_OnlyOwner() public {
        address x = makeAddr("x");
        vm.prank(maker);
        vm.expectRevert("Vault: not owner");
        vault.setLocker(x, true);

        vault.setLocker(x, true);
        assertTrue(vault.lockers(x));
        vault.setLocker(x, false);
        assertFalse(vault.lockers(x));
    }
}
