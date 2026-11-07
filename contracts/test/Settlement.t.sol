// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/FeeDistributor.sol";
import "../src/ChainConfig.sol";
import "../src/mock/MockERC20.sol";

contract SettlementTest is Test {
    // 与 Settlement.FeeDistributorSet 同签名的本地事件声明（供 expectEmit 比对日志）
    event FeeDistributorSet(address indexed oldDistributor, address indexed newDistributor);

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
        vault.setLocker(address(this), true); // 第十五轮：测试合约充当节点 locker，结算前为订单落锁

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

    // ---------- 挂单锁定辅助（第十五轮） ----------

    function _vaultOrder(Settlement.Order memory o) internal pure returns (VaultOrder memory) {
        return VaultOrder({
            orderId: o.orderId, userAddress: o.userAddress, tokenIn: o.tokenIn, tokenOut: o.tokenOut,
            amountIn: o.amountIn, amountOut: o.amountOut, price: o.price, timestamp: o.timestamp,
            expiresAt: o.expiresAt, nonce: o.nonce
        });
    }

    function _lock(Settlement.SignedOrder memory so, bool payWithTokenIn) internal {
        vault.lockForOrder(_vaultOrder(so.order), so.signature, payWithTokenIn);
    }

    function _lockFill(Settlement.Fill memory fill) internal {
        _lock(fill.makerOrder, true); // maker 为卖方：锁 tokenIn 侧
        _lock(fill.takerOrder, false); // taker 为买方：锁 tokenOut 侧
    }

    /// @notice 落锁后结算（成功路径用例的统一入口；无锁订单结算必 revert，见 VaultLocking.t.sol）
    function _settle(Settlement.Fill memory fill) internal {
        _lockFill(fill);
        settlement.settleTrade(fill);
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
        _settle(_stdFill(100e18, 100e18, 0, 0));

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
        _settle(_stdFill(100e18, 100e18, 0, 0));

        assertEq(vault.balanceOf(address(tokenB), maker), 100e18 - 0.01e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 100e18 - 0.005e18);
        assertEq(tokenA.balanceOf(address(feeDistributor)), 0.005e18);
        assertEq(tokenB.balanceOf(address(feeDistributor)), 0.01e18);
    }

    /// @notice 第二十一轮新口径：Fill.gasReimburseIn/Out 被合约忽略（哪怕填天文数字），
    /// gas 改由链上计量对半回收——本用例配好参考价并设 gasprice，断言扣费只来自计量：
    /// maker 收 tokenB（quote）扣 halfQuote，taker 收 tokenA 按成交价换算扣 halfQuote 等值，
    /// 两侧 ETH 份额恰好各半；收款方为提交结算的 relayer；交易费仍独立进 FeeDistributor。
    function test_SettleTrade_WithGasReimburse() public {
        address exchange = makeAddr("exchange");
        settlement.setRelayer(exchange);

        // 参考价：quote = tokenB，1 ETH = 2000 tokenB；gasprice 1 gwei 使应扣额不触安全阀
        ChainConfig cc = new ChainConfig();
        cc.setQuotePricing(address(tokenB), 2000e18);
        settlement.setChainConfig(address(cc));
        vm.txGasPrice(1 gwei);

        Settlement.Fill memory fill = _stdFill(100e18, 100e18, 5e18, 5e18); // 自报值应被忽略
        _lockFill(fill);
        vm.recordLogs();
        vm.prank(exchange);
        settlement.settleTrade(fill);

        // 从 GasCostShared 事件反推期望扣费（与合约同一整数公式）
        (uint256 gasUsed, uint256 makerDeduct, uint256 takerDeduct) = _lastGasShared();
        uint256 halfQuote = ((gasUsed * 1 gwei) / 2) * 2000e18 / 1e18;
        assertEq(makerDeduct, halfQuote);
        assertEq(takerDeduct, halfQuote); // 1:1 成交价下两侧 token 量相同

        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18 - makerDeduct);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18 - takerDeduct);
        assertEq(tokenA.balanceOf(address(feeDistributor)), 0.01e18);
        assertEq(tokenB.balanceOf(address(feeDistributor)), 0.01e18);
        // gas 扣除转给提交者 exchange 的外部钱包（transferOut 口径）
        assertEq(tokenB.balanceOf(exchange), makerDeduct);
        assertEq(tokenA.balanceOf(exchange), takerDeduct);
    }

    /// @notice 解析最近一条 GasCostShared 事件的 (gasUsed, makerDeduct, takerDeduct)
    function _lastGasShared() internal returns (uint256 gasUsed, uint256 makerDeduct, uint256 takerDeduct) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256(
            "GasCostShared(address,address,address,uint256,uint256,uint8,address,uint256,uint256,address,uint256,uint256)"
        );
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) {
                (uint256 gu,,,, uint256 md,,, uint256 td,) =
                    abi.decode(logs[i].data, (uint256, uint256, uint8, address, uint256, uint256, address, uint256, uint256));
                gasUsed = gu;
                makerDeduct = md;
                takerDeduct = td;
            }
        }
    }

    /// @notice Relayer 防滥用：白名单 isRelayer 可调用 settleTrade
    function test_SettleTrade_IsRelayerWhitelist() public {
        address whitelistRelayer = makeAddr("whitelistRelayer");
        settlement.setRelayerAllowed(whitelistRelayer, true);
        Settlement.Fill memory fill = _stdFill(100e18, 100e18, 0, 0);
        _lockFill(fill);
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

    /// @notice 第二十一轮：旧版自报字段与 maxGasReimbursePerTrade 上限全部失效——
    /// 填值合计远超旧上限也照常结算，且不按填值扣款（无参考价配置时计量扣费为 0，
    /// 事件 reason = GAS_SHARE_NO_PRICE）。防滥用改由链上计量 + 安全阀承担，不再靠自报上限。
    function test_SettleTrade_LegacyGasFieldsIgnored() public {
        address exchange = makeAddr("exchange");
        settlement.setRelayer(exchange);
        settlement.setMaxGasReimbursePerTrade(0.5e18); // 旧上限，结算路径已不再读取
        Settlement.Fill memory fill = _stdFill(100e18, 100e18, 0.3e18, 0.3e18); // 合计 0.6e18 > 旧上限
        _lockFill(fill);
        vm.prank(exchange);
        settlement.settleTrade(fill); // 不 revert

        // 未配参考价 → 不扣 gas 分摊，双方只扣交易费；exchange 拿不到任何自报 gas
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
        assertEq(tokenA.balanceOf(exchange), 0);
        assertEq(tokenB.balanceOf(exchange), 0);
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
        _settle(fill);
        vm.expectRevert("Settlement: fill exceeds signed order");
        settlement.settleTrade(fill);
    }

    /// @notice 部分成交：一单可分多笔结算（nonce 只消耗一次），累计达上限后再结被拒
    function test_SettleTrade_PartialFills() public {
        Settlement.SignedOrder memory m = _signed(makerKey, _order(maker, "m1", 100e18, 100e18, 0));
        Settlement.SignedOrder memory t = _signed(takerKey, _order(taker, "t1", 100e18, 100e18, 0));

        _lock(m, true);
        _lock(t, false);
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
        _settle(_stdFill(100e18, 100e18, 0, 0));

        Settlement.Fill memory fill2 = _fillWithOrders(
            _signed(makerKey, _order(maker, "m2", 50e18, 50e18, 0)), // 复用 nonce 0
            _signed(takerKey, _order(taker, "t2", 50e18, 50e18, 1)), // taker 用新 nonce 1
            50e18, 50e18, 0, 0
        );
        _lockFill(fill2); // 第二张订单同样先落锁，revert 须来自 nonce 独占校验而非缺锁
        vm.expectRevert("Settlement: nonce already used by another order");
        settlement.settleTrade(fill2);
    }

    /// @notice 过期订单不可结算
    function test_SettleTrade_ExpiredOrderReverts() public {
        Settlement.Fill memory fill = _stdFill(100e18, 100e18, 0, 0);
        _lockFill(fill); // 过期前先落锁（过期校验在结算校验链中先于锁消费触发）
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
        _lockFill(f1);
        _lockFill(f2);
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
        _lockFill(good);
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
        _settle(fill);
        Settlement.Fill[] memory fills = new Settlement.Fill[](1);
        fills[0] = fill;
        vm.expectRevert("Settlement: fill exceeds signed order");
        settlement.settleTradesBatch(fills);
    }

    // ---------- setFeeDistributor（第五轮新增：手续费落地可切换） ----------

    /// @notice owner 可设置 feeDistributor 并发出事件
    function test_SetFeeDistributor_OwnerCanSet() public {
        FeeDistributor fd2 = new FeeDistributor();
        vm.expectEmit(true, true, false, false, address(settlement));
        emit FeeDistributorSet(address(feeDistributor), address(fd2));
        settlement.setFeeDistributor(address(fd2));
        assertEq(address(settlement.feeDistributor()), address(fd2));
    }

    /// @notice governance 可设置 feeDistributor
    function test_SetFeeDistributor_GovernanceCanSet() public {
        address gov = makeAddr("gov");
        settlement.setGovernance(gov);
        FeeDistributor fd2 = new FeeDistributor();
        vm.prank(gov);
        settlement.setFeeDistributor(address(fd2));
        assertEq(address(settlement.feeDistributor()), address(fd2));
    }

    /// @notice 未授权账户（普通用户）设置 feeDistributor 被拒
    function test_SetFeeDistributor_UnauthorizedReverts() public {
        FeeDistributor fd2 = new FeeDistributor();
        vm.prank(maker);
        vm.expectRevert("Settlement: not auth");
        settlement.setFeeDistributor(address(fd2));
    }

    /// @notice 零地址被拒
    function test_SetFeeDistributor_ZeroAddressReverts() public {
        vm.expectRevert("Settlement: zero address");
        settlement.setFeeDistributor(address(0));
    }

    /// @notice 切换后结算：手续费落入新 FD，旧 FD 分文未得
    function test_SetFeeDistributor_SettleLandsInNewDistributor() public {
        FeeDistributor fd2 = new FeeDistributor();
        settlement.setFeeDistributor(address(fd2));

        _settle(_stdFill(100e18, 100e18, 0, 0));

        assertEq(tokenA.balanceOf(address(fd2)), 0.01e18);
        assertEq(tokenB.balanceOf(address(fd2)), 0.01e18);
        assertEq(tokenA.balanceOf(address(feeDistributor)), 0);
        assertEq(tokenB.balanceOf(address(feeDistributor)), 0);
    }
}
