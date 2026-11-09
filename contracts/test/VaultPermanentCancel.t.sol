// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/FeeDistributor.sol";
import "../src/mock/MockERC20.sol";

/// @title 永久撤单（撤单墓碑）测试（第四十七轮）
/// @notice 背景：第 46 轮 ChatGPT 复审 P1——第三十轮 L2 落锁无权限后，
/// releaseOrderLock 只删活动锁记录，任何人拿公开签名单可重新落锁并
/// 继续成交，「释放后无法再成交」不成立。本轮 Vault 新增
/// cancelledOrders 撤单墓碑：releaseOrderLock 置位、锁定完全消耗
/// （完全成交）置位，lockForOrder 遇标记 revert，标记无清除路径。
/// 边界定版见 docs/round47-permanent-cancel-2026-11-09.md。
/// 脚手架与 VaultLocking.t.sol 同构（同部署/签名/落锁助手口径）。
contract VaultPermanentCancelTest is Test {
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

    // ---------- 辅助（与 VaultLocking.t.sol 同口径） ----------

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

    // ---------- 撤单墓碑：释放 → 重落锁必拒 ----------

    function test_Cancel_UserRelease_SetsTombstoneAndBlocksRelock() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        // 第三方（L2）为 maker 落锁——正是可被滥用重锁的公开路径
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        bytes32 digest = vault.lockForOrder(_vaultOrder(m.order), m.signature);
        assertFalse(vault.cancelledOrders(digest));

        // 用户本人链上撤单：释放 + 置墓碑 + 发 OrderCancelled
        vm.expectEmit(true, true, false, false, address(vault));
        emit Vault.OrderCancelled(digest, maker);
        vm.prank(maker);
        vault.releaseOrderLock(digest);
        assertTrue(vault.cancelledOrders(digest));
        assertEq(vault.locked(maker, address(tokenA)), 0);
        assertEq(vault.availableBalance(maker, address(tokenA)), 500e18);

        // 同一第三方拿同一公开签名单重新落锁 → 被墓碑挡下
        vm.prank(stranger);
        vm.expectRevert("Vault: order cancelled");
        vault.lockForOrder(_vaultOrder(m.order), m.signature);

        // locker 亲自来重锁同样被挡（墓碑与调用者无关）
        vm.prank(locker);
        vm.expectRevert("Vault: order cancelled");
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
    }

    function test_Cancel_LockerRelease_SetsTombstoneAndBlocksRelock() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        bytes32 digest = _lock(m);

        // locker（受信运营角色）释放他人锁：与用户本人释放同语义，置墓碑
        vm.prank(locker);
        vault.releaseOrderLock(digest);
        assertTrue(vault.cancelledOrders(digest));

        vm.prank(maker);
        vm.expectRevert("Vault: order cancelled");
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
    }

    function test_Cancel_BuySideOrder() public {
        (, Settlement.SignedOrder memory t) = _stdPair();
        bytes32 digest = _lock(t); // taker 的 BUY 单，锁 tokenOut
        vm.prank(taker);
        vault.releaseOrderLock(digest);
        assertTrue(vault.cancelledOrders(digest));
        vm.prank(taker);
        vm.expectRevert("Vault: order cancelled");
        vault.lockForOrder(_vaultOrder(t.order), t.signature);
    }

    // ---------- 部分成交后撤单：余量永久作废 ----------

    function test_Cancel_PartialFillThenRelease_RemainderPermanentlyDead() public {
        (Settlement.SignedOrder memory m, Settlement.SignedOrder memory t) = _stdPair();
        bytes32 dm = _lock(m);
        _lock(t);

        settlement.settleTrade(_fill(m, t, 60e18, 60e18));
        assertFalse(vault.cancelledOrders(dm)); // 部分成交不置位：锁还在、余量可继续成交

        // maker 撤单释放剩余 40
        vm.prank(maker);
        vault.releaseOrderLock(dm);
        assertTrue(vault.cancelledOrders(dm));
        assertEq(vault.availableBalance(maker, address(tokenA)), 440e18); // 500 − 60 已成交

        // 余量 40 永久不可再成交：重锁被墓碑挡
        vm.expectRevert("Vault: order cancelled");
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
        // 即便绕开落锁直接提交结算也 revert（无锁可消费），已成交量不回滚
        vm.expectRevert("Vault: order not locked");
        settlement.settleTrade(_fill(m, t, 40e18, 40e18));
        assertEq(settlement.orderFilledIn(dm), 60e18);
    }

    // ---------- 完全成交耗尽：一并置位，防无意义重锁困资金 ----------

    function test_FullFill_SetsTombstone_RelockReverts() public {
        (Settlement.SignedOrder memory m, Settlement.SignedOrder memory t) = _stdPair();
        bytes32 dm = _lock(m);
        bytes32 dt = _lock(t);

        settlement.settleTrade(_fill(m, t, 100e18, 100e18));
        (address u,,,) = vault.orderLocks(dm);
        assertEq(u, address(0)); // 锁记录已随耗尽删除
        assertTrue(vault.cancelledOrders(dm)); // 墓碑已置位
        assertTrue(vault.cancelledOrders(dt));

        // 用户余额充足、订单未过期，重锁仍被挡——资金不会被困进死单
        vm.prank(maker);
        vm.expectRevert("Vault: order cancelled");
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
    }

    // ---------- 过期释放不置位（最小改动边界） ----------

    function test_ExpiredRelease_DoesNotSetTombstone() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        bytes32 dm = _lock(m);
        vm.warp(block.timestamp + 1 days + 1);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vault.releaseExpiredOrderLock(dm);
        assertEq(vault.locked(maker, address(tokenA)), 0);
        assertFalse(vault.cancelledOrders(dm)); // 过期释放不产生撤单语义
        // 重锁由时效检查挡下，与墓碑无关
        vm.prank(stranger);
        vm.expectRevert("Vault: order expired");
        vault.lockForOrder(_vaultOrder(m.order), m.signature);
    }

    // ---------- 墓碑不可清除 / 不可绕过 ----------

    function test_Cancel_TombstoneCannotBeCleared() public {
        (Settlement.SignedOrder memory m,) = _stdPair();
        bytes32 dm = _lock(m);
        vm.prank(maker);
        vault.releaseOrderLock(dm);
        assertTrue(vault.cancelledOrders(dm));

        // 再次释放：无锁可释，revert，且墓碑不动
        vm.prank(maker);
        vm.expectRevert("Vault: order not locked");
        vault.releaseOrderLock(dm);
        assertTrue(vault.cancelledOrders(dm));

        // 时间走到过期之后：过期释放同样无锁可释、墓碑仍在；
        // 重锁先撞时效检查——两条路径都关死
        vm.warp(block.timestamp + 2 days);
        vm.prank(locker);
        vm.expectRevert("Vault: order not locked");
        vault.releaseExpiredOrderLock(dm);
        assertTrue(vault.cancelledOrders(dm));
        vm.expectRevert("Vault: order expired");
        vault.lockForOrder(_vaultOrder(m.order), m.signature);

        // cancelledOrders 在 Vault 源码中无 setter/清除入口（仅两处置位：
        // releaseOrderLock 与 consumeOrderLock 耗尽分支）——本断言配合源码
        // 审查成立：置位后没有任何公开函数能把 true 写回 false。
    }

    // ---------- 未撤单订单全流程不受影响（按摘要隔离） ----------

    function test_OtherOrder_UnaffectedByCancel() public {
        (Settlement.SignedOrder memory m, Settlement.SignedOrder memory t) = _stdPair();
        bytes32 dm = _lock(m);
        vm.prank(maker);
        vault.releaseOrderLock(dm);
        assertTrue(vault.cancelledOrders(dm));

        // 同一用户另一张单（不同 orderId/nonce）：落锁、成交全流程正常
        Settlement.SignedOrder memory m2 = _signed(makerKey, _order(maker, "m2", 100e18, 100e18, 1, 1));
        Settlement.SignedOrder memory t2 = _signed(takerKey, _order(taker, "t2", 100e18, 100e18, 1, 0));
        bytes32 dm2 = _lock(m2);
        _lock(t2);
        assertFalse(vault.cancelledOrders(dm2));
        settlement.settleTrade(_fill(m2, t2, 100e18, 100e18));
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
    }
}
