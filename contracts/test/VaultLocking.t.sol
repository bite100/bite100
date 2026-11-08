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

    function _order(address user, string memory orderId, uint256 amountIn, uint256 amountOut, uint256 nonce, uint8 side)
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
            nonce: nonce,
            side: side
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
            expiresAt: o.expiresAt, nonce: o.nonce, side: o.side
        });
    }

    function _lock(Settlement.SignedOrder memory so) internal returns (bytes32) {
        vm.prank(locker);
        return vault.lockForOrder(_vaultOrder(so.order), so.signature);
    }

    /// @notice 卖方口径落锁（锁 tokenIn × amountIn）
    function _lockSell(Settlement.SignedOrder memory so) internal returns (bytes32) {
        return _lock(so);
    }

    /// @notice 买方口径落锁（锁 tokenOut × amountOut）
    function _lockBuy(Settlement.SignedOrder memory so) internal returns (bytes32) {
        return _lock(so);
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
            _signed(makerKey, _order(maker, "m1", 100e18, 100e18, 0, 1)),
            _signed(takerKey, _order(taker, "t1", 100e18, 100e18, 0, 0))
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
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
    }

    function test_Lock_InvalidSignatureReverts() public {
        Settlement.Order memory order = _order(maker, "m1", 100e18, 100e18, 0, 1);
        bytes memory badSig = _sign(takerKey, order); // 用他人私钥签
        vm.prank(locker);
        vm.expectRevert("Vault: invalid order signature");
        vault.lockForOrder(_vaultOrder(order), badSig);
    }

    /// @notice 第三十轮 L2 起本用例语义反转：旧版断言「非 locker 落锁 revert」，
    /// L2 后任何人（含订单用户本人、任意第三方）都可为验签有效的订单落锁。
    /// 完整的 L2 专项覆盖见本文件末尾的 L2 段与 VaultL2 语义注释。
    function test_Lock_NotLockerReverts() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        vm.prank(maker); // L2：订单用户本人可直接自锁，不再 revert
        bytes32 digest = vault.lockForOrder(_vaultOrder(m.order), m.signature);
        assertEq(digest, settlement.orderDigest(m.order));
        assertEq(vault.locked(maker, address(tokenA)), 100e18);
    }

    // ---------- 第三十轮 L2：无权限落锁 ----------

    function test_L2_ThirdPartyLocksValidOrder() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        address stranger = makeAddr("stranger"); // 非 locker、非订单用户
        assertFalse(vault.lockers(stranger));
        vm.prank(stranger);
        bytes32 digest = vault.lockForOrder(_vaultOrder(m.order), m.signature);
        assertEq(digest, settlement.orderDigest(m.order));
        assertEq(vault.locked(maker, address(tokenA)), 100e18);
        assertEq(vault.availableBalance(maker, address(tokenA)), 400e18);
        (address user, address token, uint256 remaining,) = vault.orderLocks(digest);
        assertEq(user, maker); // 锁的归属恒为签名者，与调用者无关
        assertEq(token, address(tokenA));
        assertEq(remaining, 100e18);
        // 墓碑同写（失败归责的凭据不因 L2 而改变）
        (address tombUser, address tombToken) = vault.lockTombstones(digest);
        assertEq(tombUser, maker);
        assertEq(tombToken, address(tokenA));
        _assertInvariant(maker, address(tokenA));
    }

    function test_L2_ThirdPartyLocksBuySide() public {
        (, Settlement.SignedOrder memory t) = _stdPair();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        bytes32 digest = vault.lockForOrder(_vaultOrder(t.order), t.signature);
        (address user, address token, uint256 remaining,) = vault.orderLocks(digest);
        assertEq(user, taker);
        assertEq(token, address(tokenB)); // 买方锁 tokenOut × amountOut
        assertEq(remaining, 100e18);
        assertEq(vault.locked(taker, address(tokenB)), 100e18);
    }

    function test_L2_InvalidSignatureReverts() public {
        Settlement.Order memory order = _order(maker, "m1", 100e18, 100e18, 0, 1);
        bytes memory badSig = _sign(takerKey, order); // 他人私钥签 → 验签不过
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert("Vault: invalid order signature");
        vault.lockForOrder(_vaultOrder(order), badSig);
        // 垃圾签名（随机字节）同样被挡
        vm.prank(stranger);
        vm.expectRevert("Vault: invalid order signature");
        vault.lockForOrder(_vaultOrder(order), new bytes(65));
    }

    function test_L2_DoubleLockReverts() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        address stranger1 = makeAddr("stranger1");
        address stranger2 = makeAddr("stranger2");
        vm.prank(stranger1);
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
        vm.prank(stranger2); // 换一个调用者重复落锁同样被挡（按 digest 判重，与调用者无关）
        vm.expectRevert("Vault: order already locked");
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
    }

    function test_L2_ExpiredOrderReverts() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        vm.warp(block.timestamp + 2 days);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert("Vault: order expired");
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
    }

    function test_L2_InsufficientAvailableReverts() public {
        Settlement.SignedOrder memory big = _signed(makerKey, _order(maker, "big", 600e18, 600e18, 0, 1));
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert("Vault: insufficient available");
        vault.lockForOrder(_vaultOrder(big.order), big.signature);
    }

    function test_Stage3_LockDirectionFromSignedSideOnly() public {
        // 阶段 3 ⑥（旧 test_L2_WrongDirectionFlagFailsClosed 的替代）：落锁方向
        // 参数 payWithTokenIn 已删除，方向只从签名 side 派生。maker 的 SELL 单
        // 由陌生人落锁，只可能锁其签名义务侧 tokenIn×amountIn；tokenB 侧恒 0——
        // 「按错误方向为他人落锁」在新接口下不可表达（第 35 轮复审 N1 关闭）。
        (Settlement.SignedOrder memory m,) = _stdPair();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
        assertEq(vault.locked(maker, address(tokenA)), m.order.amountIn);
        assertEq(vault.locked(maker, address(tokenB)), 0);
    }

    function test_L2_LockByStranger_ReleaseSemanticsUnchanged() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        bytes32 digest = vault.lockForOrder(_vaultOrder(m.order), m.signature);

        // 落锁者本人（非 locker、非锁属用户）无权释放他人的锁
        vm.prank(stranger);
        vm.expectRevert("Vault: not authorized to release");
        vault.releaseOrderLock(digest);

        // 锁属用户本人仍可自助释放（撤单路径不回归）
        vm.prank(maker);
        vault.releaseOrderLock(digest);
        assertEq(vault.locked(maker, address(tokenA)), 0);
        assertEq(vault.availableBalance(maker, address(tokenA)), 500e18);
    }

    function test_L2_LockByStranger_ThenSettlesNormally() public {
        (Settlement.SignedOrder memory m, Settlement.SignedOrder memory t) = _stdPair();
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
        vault.lockForOrder(_vaultOrder(t.order), t.signature);
        vm.stopPrank();
        settlement.settleTrade(_fill(m, t, 100e18, 100e18));
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
    }

    function test_Lock_InsufficientAvailableReverts() public {
        // 余额 500：锁 600 超额
        Settlement.SignedOrder memory big = _signed(makerKey, _order(maker, "big", 600e18, 600e18, 0, 1));
        vm.prank(locker);
        vm.expectRevert("Vault: insufficient available");
        vault.lockForOrder(_vaultOrder(big.order), big.signature);

        // 先锁 400，再锁另一单 200：可用只剩 100，第二单被拒
        Settlement.SignedOrder memory m1 = _signed(makerKey, _order(maker, "m1", 400e18, 400e18, 1, 1));
        _lockSell(m1);
        Settlement.SignedOrder memory m2 = _signed(makerKey, _order(maker, "m2", 200e18, 200e18, 2, 1));
        vm.prank(locker);
        vm.expectRevert("Vault: insufficient available");
        vault.lockForOrder(_vaultOrder(m2.order), m2.signature);
    }

    function test_Lock_ExpiredOrderReverts() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        vm.warp(block.timestamp + 2 days);
        vm.prank(locker);
        vm.expectRevert("Vault: order expired");
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
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
