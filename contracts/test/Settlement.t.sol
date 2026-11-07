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
    uint256 makerKey;
    uint256 takerKey;

    function setUp() public {
        vm.warp(1_760_000_000); // 固定时间基准，保证订单 timestamp/expiresAt 语义稳定
        owner = address(this);
        (maker, makerKey) = makeAddrAndKey("maker");
        (taker, takerKey) = makeAddrAndKey("taker");

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

    // ---------- 签名订单辅助 ----------

    /// @notice 构造一笔统一规范订单（交易对固定 tokenA/tokenB，price 按 amountOut*1e18/amountIn 派生）
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

    /// @notice 标准成交：maker 订单与 taker 订单各 100e18/100e18（nonce 均为 0），按给定量结算
    function _stdFill(uint256 fillIn, uint256 fillOut, uint256 gasIn, uint256 gasOut)
        internal
        view
        returns (Settlement.Fill memory)
    {
        return _fillWithOrders(
            _signed(makerKey, _order(maker, "m1", 100e18, 100e18, 0)),
            _signed(takerKey, _order(taker, "t1", 100e18, 100e18, 0)),
            fillIn, fillOut, gasIn, gasOut
        );
    }

    function _fillWithOrders(
        Settlement.SignedOrder memory makerOrder,
        Settlement.SignedOrder memory takerOrder,
        uint256 fillIn,
        uint256 fillOut,
        uint256 gasIn,
        uint256 gasOut
    ) internal pure returns (Settlement.Fill memory) {
        return Settlement.Fill({
            makerOrder: makerOrder,
            takerOrder: takerOrder,
            tokenIn: makerOrder.order.tokenIn,
            tokenOut: makerOrder.order.tokenOut,
            amountIn: fillIn,
            amountOut: fillOut,
            gasReimburseIn: gasIn,
            gasReimburseOut: gasOut
        });
    }

    // ---------- 基础结算（原有用例，断言不变） ----------

    function test_SettleTrade() public {
        // maker 卖 100 tokenA 买 tokenB，taker 卖 tokenB 买 tokenA，1:1 比例；0.01% 双边收取，无 cap
        // feeIn = 0.01e18, feeOut = 0.01e18，maker 收 99.99e18 tokenB，taker 收 99.99e18 tokenA
        settlement.settleTrade(_stdFill(100e18, 100e18, 0, 0));

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
        // feeIn 按 0.01% 应为 0.01e18，被 cap 为 0.005e18；feeOut = 0.01e18
        settlement.settleTrade(_stdFill(100e18, 100e18, 0, 0));

        assertEq(vault.balanceOf(address(tokenB), maker), 100e18 - 0.01e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 100e18 - 0.005e18);
        assertEq(tokenA.balanceOf(address(feeDistributor)), 0.005e18);
        assertEq(tokenB.balanceOf(address(feeDistributor)), 0.01e18);
    }

    function test_SettleTrade_WithGasReimburse() public {
        address exchange = makeAddr("exchange");
        settlement.setRelayer(exchange);
        uint256 gasIn = 0.5e18;  // 卖方均摊（从 tokenIn 扣给交易所）
        uint256 gasOut = 0.5e18; // 买方均摊（从 tokenOut 扣给交易所）
        Settlement.Fill memory fill = _stdFill(100e18, 100e18, gasIn, gasOut);
        vm.prank(exchange);
        settlement.settleTrade(fill);

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
        Settlement.Fill memory fill = _stdFill(100e18, 100e18, 0, 0);
        vm.prank(whitelistRelayer);
        settlement.settleTrade(fill);
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
    }

    /// @notice 信誉初始化：新白名单 relayer 初始分为中性 5000（等于默认门槛），可立即结算第一笔
    function test_RelayerReputation_InitializedOnWhitelist() public {
        address r = makeAddr("freshRelayer");
        settlement.setRelayerAllowed(r, true);
        (uint256 score,,,) = settlement.relayerReputation(r);
        assertEq(score, settlement.INITIAL_RELAYER_REPUTATION());
    }

    /// @notice 信誉处罚：违规扣分跌破门槛后被拦截；重新加白名单不重置已有信誉记录
    function test_RelayerReputation_ViolationsBlockAndNoReset() public {
        address r = makeAddr("badRelayer");
        settlement.setRelayerAllowed(r, true);
        for (uint256 i = 0; i < 51; i++) {
            settlement.recordRelayerViolation(r);
        }
        (uint256 score,,,) = settlement.relayerReputation(r);
        assertEq(score, 0);

        // 取消后重新加白名单，已有记录不被初始化逻辑重置
        settlement.setRelayerAllowed(r, false);
        settlement.setRelayerAllowed(r, true);
        (uint256 scoreAfter,,,) = settlement.relayerReputation(r);
        assertEq(scoreAfter, 0);

        Settlement.Fill memory fill = _stdFill(100e18, 100e18, 0, 0);
        vm.prank(r);
        vm.expectRevert("Settlement: relayer reputation too low");
        settlement.settleTrade(fill);
    }

    /// @notice Relayer 防滥用：maxGasReimbursePerTrade 超限 revert
    function test_SettleTrade_MaxGasReimburseCap() public {
        address exchange = makeAddr("exchange");
        settlement.setRelayer(exchange);
        settlement.setMaxGasReimbursePerTrade(0.5e18); // 单笔 gas 报销上限 0.5e18
        uint256 gasIn = 0.3e18;
        uint256 gasOut = 0.3e18; // gasIn + gasOut = 0.6e18 > 0.5e18
        Settlement.Fill memory fill = _stdFill(100e18, 100e18, gasIn, gasOut);
        vm.prank(exchange);
        vm.expectRevert("Settlement: gas reimburse cap");
        settlement.settleTrade(fill);
    }

    /// @notice Relayer 防滥用：maxGasReimbursePerTrade 等于上限可成功
    function test_SettleTrade_MaxGasReimburseAtCap() public {
        address exchange = makeAddr("exchange");
        settlement.setRelayer(exchange);
        settlement.setMaxGasReimbursePerTrade(0.5e18);
        uint256 gasIn = 0.25e18;
        uint256 gasOut = 0.25e18; // gasIn + gasOut = 0.5e18 == cap
        Settlement.Fill memory fill = _stdFill(100e18, 100e18, gasIn, gasOut);
        vm.prank(exchange);
        settlement.settleTrade(fill);
        assertEq(tokenA.balanceOf(exchange), 0.25e18);
        assertEq(tokenB.balanceOf(exchange), 0.25e18);
    }

    // ---------- 验签与防重放（P0-2 新增） ----------

    /// @notice verifyOrderSignature 视图：合法签名 true；篡改金额/他人签名 false
    function test_VerifyOrderSignatureView() public view {
        Settlement.Order memory order = _order(maker, "m-view", 100e18, 100e18, 0);
        bytes memory sig = _sign(makerKey, order);
        assertTrue(settlement.verifyOrderSignature(order, sig));

        Settlement.Order memory tampered = _order(maker, "m-view", 200e18, 100e18, 0);
        assertFalse(settlement.verifyOrderSignature(tampered, sig));

        bytes memory wrongSigner = _sign(takerKey, order);
        assertFalse(settlement.verifyOrderSignature(order, wrongSigner));
    }

    /// @notice 篡改：签名后改大 maker 订单 amountIn 再提交，验签失败
    function test_SettleTrade_TamperedAmountReverts() public {
        Settlement.Order memory signedOrder = _order(maker, "m1", 100e18, 100e18, 0);
        bytes memory sig = _sign(makerKey, signedOrder);
        Settlement.Order memory tampered = _order(maker, "m1", 200e18, 100e18, 0);
        Settlement.SignedOrder memory makerOrder = Settlement.SignedOrder({order: tampered, signature: sig});
        Settlement.Fill memory fill = _fillWithOrders(
            makerOrder, _signed(takerKey, _order(taker, "t1", 100e18, 100e18, 0)), 100e18, 100e18, 0, 0
        );
        vm.expectRevert("Settlement: invalid maker signature");
        settlement.settleTrade(fill);
    }

    /// @notice 伪造：用 taker 的私钥签 maker 的订单
    function test_SettleTrade_WrongSignerReverts() public {
        Settlement.Fill memory fill = _fillWithOrders(
            _signed(takerKey, _order(maker, "m1", 100e18, 100e18, 0)),
            _signed(takerKey, _order(taker, "t1", 100e18, 100e18, 0)),
            100e18, 100e18, 0, 0
        );
        vm.expectRevert("Settlement: invalid maker signature");
        settlement.settleTrade(fill);
    }

    /// @notice 重放：全额成交后重复提交同一 Fill，累计超签名量被拒
    function test_SettleTrade_ReplayReverts() public {
        Settlement.Fill memory fill = _stdFill(100e18, 100e18, 0, 0);
        settlement.settleTrade(fill);
        vm.expectRevert("Settlement: fill exceeds signed order");
        settlement.settleTrade(fill);
    }

    /// @notice 部分成交：一单可分多笔结算（nonce 只消耗一次），累计达上限后再结被拒
    function test_SettleTrade_PartialFills() public {
        Settlement.SignedOrder memory m = _signed(makerKey, _order(maker, "m1", 100e18, 100e18, 0));
        Settlement.SignedOrder memory t = _signed(takerKey, _order(taker, "t1", 100e18, 100e18, 0));

        settlement.settleTrade(_fillWithOrders(m, t, 60e18, 60e18, 0, 0));
        assertEq(settlement.getCurrentNonce(maker), 1); // 首次结算消耗 nonce 0
        settlement.settleTrade(_fillWithOrders(m, t, 40e18, 40e18, 0, 0));
        assertEq(settlement.getCurrentNonce(maker), 1); // 续结不再消耗
        assertEq(settlement.orderFilledIn(settlement.orderDigest(m.order)), 100e18);

        vm.expectRevert("Settlement: fill exceeds signed order");
        settlement.settleTrade(_fillWithOrders(m, t, 1e18, 1e18, 0, 0));
    }

    /// @notice nonce 独占：maker 的第二张订单复用 nonce 0（不同 orderId/金额），即使签名合法也无法结算
    function test_SettleTrade_SameNonceDifferentOrderReverts() public {
        settlement.settleTrade(_stdFill(100e18, 100e18, 0, 0));

        Settlement.Fill memory fill2 = _fillWithOrders(
            _signed(makerKey, _order(maker, "m2", 50e18, 50e18, 0)), // 复用 nonce 0
            _signed(takerKey, _order(taker, "t2", 50e18, 50e18, 1)), // taker 用新 nonce 1
            50e18, 50e18, 0, 0
        );
        vm.expectRevert("Settlement: nonce already used by another order");
        settlement.settleTrade(fill2);
    }

    /// @notice 过期订单不可结算
    function test_SettleTrade_ExpiredOrderReverts() public {
        Settlement.Fill memory fill = _stdFill(100e18, 100e18, 0, 0);
        vm.warp(block.timestamp + 2 days); // 订单 expiresAt = 下单 + 1 天
        vm.expectRevert("Settlement: order expired");
        settlement.settleTrade(fill);
    }

    // ---------- 批量验签（P0-2 新增） ----------

    /// @notice 批量：两笔合法 Fill 一次结算成功（不同订单对、nonce 递进）
    function test_SettleTradesBatch_TwoFills() public {
        Settlement.Fill memory f1 = _fillWithOrders(
            _signed(makerKey, _order(maker, "m1", 100e18, 100e18, 0)),
            _signed(takerKey, _order(taker, "t1", 100e18, 100e18, 0)),
            60e18, 60e18, 0, 0
        );
        Settlement.Fill memory f2 = _fillWithOrders(
            _signed(makerKey, _order(maker, "m2", 100e18, 100e18, 1)),
            _signed(takerKey, _order(taker, "t2", 100e18, 100e18, 1)),
            40e18, 40e18, 0, 0
        );
        Settlement.Fill[] memory fills = new Settlement.Fill[](2);
        fills[0] = f1;
        fills[1] = f2;
        settlement.settleTradesBatch(fills);

        // maker 共卖出 100 tokenA；收 tokenB 100 - (0.006 + 0.004) fee = 99.99
        assertEq(vault.balanceOf(address(tokenA), maker), 400e18);
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenB), taker), 400e18);
    }

    /// @notice 批量：批次中混入伪造签名，整批 revert（且第一笔的账务回滚）
    function test_SettleTradesBatch_TamperedReverts() public {
        Settlement.Fill memory good = _stdFill(60e18, 60e18, 0, 0);
        Settlement.Fill memory bad = _fillWithOrders(
            _signed(takerKey, _order(maker, "m2", 100e18, 100e18, 1)), // 用 taker 私钥冒签 maker 订单
            _signed(takerKey, _order(taker, "t2", 100e18, 100e18, 1)),
            40e18, 40e18, 0, 0
        );
        Settlement.Fill[] memory fills = new Settlement.Fill[](2);
        fills[0] = good;
        fills[1] = bad;
        vm.expectRevert("Settlement: invalid maker signature");
        settlement.settleTradesBatch(fills);
        // 整批回滚：第一笔也未落账
        assertEq(vault.balanceOf(address(tokenA), maker), 500e18);
    }

    /// @notice 批量重放：已全额结算的 Fill 再次进入批次被拒
    function test_SettleTradesBatch_ReplayReverts() public {
        Settlement.Fill memory fill = _stdFill(100e18, 100e18, 0, 0);
        settlement.settleTrade(fill);
        Settlement.Fill[] memory fills = new Settlement.Fill[](1);
        fills[0] = fill;
        vm.expectRevert("Settlement: fill exceeds signed order");
        settlement.settleTradesBatch(fills);
    }
}
