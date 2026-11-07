// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/FeeDistributor.sol";
import "../src/ChainConfig.sol";
import "../src/mock/MockERC20.sol";

/// @notice 第二十一轮 gas 规则专项测试：
/// ① 对半回收——链上计量、两侧 ETH 份额恰好各半、以收到资产扣除、与交易费分开记账；
/// ② 换算——quote 直扣 / 按成交价换算；③ 安全阀截断（超出协议吸收）；④ 未配价/非 quote 对跳过；
/// ⑤ 批量均摊；⑥ 失败归责扣费（过期/锁释放/未落锁/关闭/上限/防重复）。
contract GasRulesTest is Test {
    Vault vault;
    Settlement settlement;
    FeeDistributor feeDistributor;
    ChainConfig chainConfig;
    MockERC20 tokenA; // base（数量资产）
    MockERC20 tokenB; // quote（计价资产）

    address owner;
    address maker;
    address taker;
    uint256 makerKey;
    uint256 takerKey;

    uint256 internal constant ETH_PRICE = 2000e18; // 1 ETH = 2000 TKB（测试参考价）
    uint256 internal constant GAS_PRICE = 1 gwei;

    struct GasShared {
        uint256 gasUsed;
        uint256 gasCostWei;
        uint8 reason;
        uint256 makerDeduct;
        uint256 makerShortfall;
        uint256 takerDeduct;
        uint256 takerShortfall;
    }

    function setUp() public {
        vm.warp(1_760_000_000);
        owner = address(this);
        (maker, makerKey) = makeAddrAndKey("maker");
        (taker, takerKey) = makeAddrAndKey("taker");

        tokenA = new MockERC20("TokenA", "TKA", 1_000_000e18);
        tokenB = new MockERC20("TokenB", "TKB", 1_000_000e18);

        vault = new Vault();
        feeDistributor = new FeeDistributor();
        settlement = new Settlement(address(vault), address(feeDistributor));
        vault.setSettlement(address(settlement));
        vault.setLocker(address(this), true);

        chainConfig = new ChainConfig();
        chainConfig.setQuotePricing(address(tokenB), ETH_PRICE);
        settlement.setChainConfig(address(chainConfig));

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

        vm.txGasPrice(GAS_PRICE);
    }

    // ---------- 辅助（与 Settlement.t.sol 同构） ----------

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

    function _lockFill(Settlement.Fill memory fill) internal {
        vault.lockForOrder(_vaultOrder(fill.makerOrder.order), fill.makerOrder.signature, true);
        vault.lockForOrder(_vaultOrder(fill.takerOrder.order), fill.takerOrder.signature, false);
    }

    function _fill(
        Settlement.SignedOrder memory makerOrder,
        Settlement.SignedOrder memory takerOrder,
        uint256 fillIn,
        uint256 fillOut
    ) internal pure returns (Settlement.Fill memory) {
        return Settlement.Fill({
            makerOrder: makerOrder,
            takerOrder: takerOrder,
            tokenIn: makerOrder.order.tokenIn,
            tokenOut: makerOrder.order.tokenOut,
            amountIn: fillIn,
            amountOut: fillOut,
            gasReimburseIn: 0,
            gasReimburseOut: 0
        });
    }

    function _stdFill(uint256 nonce) internal view returns (Settlement.Fill memory) {
        return _fill(
            _signed(makerKey, _order(maker, "m", 100e18, 100e18, nonce)),
            _signed(takerKey, _order(taker, "t", 100e18, 100e18, nonce)),
            100e18,
            100e18
        );
    }

    /// @notice 一次性取回全部 GasCostShared 事件（getRecordedLogs 会排空记录，批量用例须单次取完）
    function _fetchAllGasShared() internal returns (GasShared[] memory arr) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256(
            "GasCostShared(address,address,address,uint256,uint256,uint8,address,uint256,uint256,address,uint256,uint256)"
        );
        uint256 count = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) count++;
        }
        arr = new GasShared[](count);
        uint256 seen = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) {
                GasShared memory g;
                (g.gasUsed, g.gasCostWei, g.reason,, g.makerDeduct, g.makerShortfall,, g.takerDeduct, g.takerShortfall) =
                    abi.decode(logs[i].data, (uint256, uint256, uint8, address, uint256, uint256, address, uint256, uint256));
                arr[seen++] = g;
            }
        }
    }

    /// @notice 取记录日志中第 idx 条 GasCostShared 事件并解码（单次取用场景）
    function _gasSharedAt(uint256 idx) internal returns (GasShared memory out) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256(
            "GasCostShared(address,address,address,uint256,uint256,uint8,address,uint256,uint256,address,uint256,uint256)"
        );
        uint256 seen = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) {
                if (seen == idx) {
                    (out.gasUsed, out.gasCostWei, out.reason,, out.makerDeduct, out.makerShortfall,, out.takerDeduct, out.takerShortfall) =
                        abi.decode(logs[i].data, (uint256, uint256, uint8, address, uint256, uint256, address, uint256, uint256));
                    return out;
                }
                seen++;
            }
        }
        revert("GasCostShared log not found");
    }

    /// @notice 与合约同一整数公式：由 gasUsed 算 halfQuote
    function _halfQuote(uint256 gasUsed) internal pure returns (uint256) {
        return ((gasUsed * GAS_PRICE) / 2) * ETH_PRICE / 1e18;
    }

    // ---------- ① 对半回收 ----------

    function test_GasShare_ExactHalf_OneToOne() public {
        Settlement.Fill memory fill = _stdFill(0);
        _lockFill(fill);
        uint256 thisABefore = tokenA.balanceOf(address(this));
        uint256 thisBBefore = tokenB.balanceOf(address(this));
        vm.recordLogs();
        settlement.settleTrade(fill);
        GasShared memory g = _gasSharedAt(0);

        assertEq(g.reason, 0);
        assertEq(g.gasCostWei, g.gasUsed * GAS_PRICE);
        uint256 halfQuote = _halfQuote(g.gasUsed);
        assertGt(halfQuote, 0);
        assertEq(g.makerDeduct, halfQuote, "maker (quote side) deduct");
        assertEq(g.takerDeduct, halfQuote, "taker (base side, 1:1 price) deduct");
        assertEq(g.makerShortfall, 0);
        assertEq(g.takerShortfall, 0);

        // 到账 = 收到 − 交易费 − gas 扣除；收款方（owner 充当提交者）外部钱包增量收到两侧扣除
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18 - halfQuote);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18 - halfQuote);
        assertEq(tokenB.balanceOf(address(this)), thisBBefore + halfQuote);
        assertEq(tokenA.balanceOf(address(this)), thisABefore + halfQuote);
        // 交易费独立记账，不与 gas 混杂
        assertEq(tokenA.balanceOf(address(feeDistributor)), 0.01e18);
        assertEq(tokenB.balanceOf(address(feeDistributor)), 0.01e18);
    }

    function test_GasShare_PriceConversion_TwoToOne() public {
        // 成交价 2 TKB / TKA：maker 卖 100 TKA 收 200 TKB；taker 卖 200 TKB 收 100 TKA
        Settlement.Fill memory fill = _fill(
            _signed(makerKey, _order(maker, "m2", 100e18, 200e18, 0)),
            _signed(takerKey, _order(taker, "t2", 100e18, 200e18, 0)),
            100e18,
            200e18
        );
        _lockFill(fill);
        vm.recordLogs();
        settlement.settleTrade(fill);
        GasShared memory g = _gasSharedAt(0);

        uint256 halfQuote = _halfQuote(g.gasUsed);
        assertEq(g.makerDeduct, halfQuote); // maker 收 quote，直扣
        // taker 收 base：want = halfQuote × amountIn / amountOut = halfQuote / 2
        assertEq(g.takerDeduct, (halfQuote * 100e18) / 200e18);
        assertEq(g.makerShortfall, 0);
        assertEq(g.takerShortfall, 0);
        // 两侧 ETH 等值恰好各半：taker 扣除按成交价折回 quote 与 maker 侧相等（整数尘埃 ≤ 1）
        uint256 takerBackInQuote = (g.takerDeduct * 200e18) / 100e18;
        assertLe(halfQuote - takerBackInQuote, 1);
    }

    // ---------- ③ 安全阀 ----------

    function test_GasShare_CapTruncation_ProtocolAbsorbs() public {
        vm.txGasPrice(100 gwei); // 应扣额远超安全阀
        Settlement.Fill memory fill = _stdFill(0);
        _lockFill(fill);
        uint256 thisBBefore = tokenB.balanceOf(address(this));
        vm.recordLogs();
        settlement.settleTrade(fill);
        GasShared memory g = _gasSharedAt(0);

        uint256 cap = (99.99e18 * 1000) / 10_000; // 收到 99.99e18 的 10%
        assertEq(g.makerDeduct, cap);
        assertEq(g.takerDeduct, cap);
        assertGt(g.makerShortfall, 0);
        assertGt(g.takerShortfall, 0);
        // 短缺 = 应扣 − 实扣（同资产口径）
        uint256 halfQuote = ((g.gasUsed * 100 gwei) / 2) * ETH_PRICE / 1e18;
        assertEq(g.makerShortfall, halfQuote - cap);
        // 用户最多损失收到额的 10%，收款方不多拿
        assertEq(tokenB.balanceOf(address(this)), thisBBefore + cap);
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18 - cap);
    }

    // ---------- ④ 跳过分支 ----------

    function test_GasShare_NoPriceConfigured_Skips() public {
        settlement.setChainConfig(address(0)); // 停用换算
        Settlement.Fill memory fill = _stdFill(0);
        _lockFill(fill);
        vm.recordLogs();
        settlement.settleTrade(fill);
        GasShared memory g = _gasSharedAt(0);
        assertEq(g.reason, 1); // GAS_SHARE_NO_PRICE
        assertEq(g.makerDeduct, 0);
        assertEq(g.takerDeduct, 0);
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
    }

    function test_GasShare_PairNotQuoted_Skips() public {
        MockERC20 tokenC = new MockERC20("TokenC", "TKC", 1_000_000e18);
        chainConfig.setQuotePricing(address(tokenC), ETH_PRICE); // quote 指向第三种代币
        Settlement.Fill memory fill = _stdFill(0);
        _lockFill(fill);
        vm.recordLogs();
        settlement.settleTrade(fill);
        GasShared memory g = _gasSharedAt(0);
        assertEq(g.reason, 2); // GAS_SHARE_NOT_QUOTED
        assertEq(g.makerDeduct, 0);
        assertEq(g.takerDeduct, 0);
    }

    // ---------- ⑤ 批量均摊 ----------

    function test_GasShare_BatchAveraged() public {
        Settlement.Fill memory f1 = _stdFill(0);
        Settlement.Fill memory f2 = _fill(
            _signed(makerKey, _order(maker, "m", 100e18, 100e18, 1)),
            _signed(takerKey, _order(taker, "t", 100e18, 100e18, 1)),
            50e18,
            50e18
        );
        _lockFill(f1);
        _lockFill(f2);
        Settlement.Fill[] memory fills = new Settlement.Fill[](2);
        fills[0] = f1;
        fills[1] = f2;
        vm.recordLogs();
        settlement.settleTradesBatch(fills);
        GasShared[] memory all = _fetchAllGasShared();
        assertEq(all.length, 2);
        GasShared memory g1 = all[0];
        GasShared memory g2 = all[1];
        // 均摊口径：两笔 gasUsed 完全相同
        assertEq(g1.gasUsed, g2.gasUsed);
        assertEq(g1.makerDeduct, _halfQuote(g1.gasUsed));
        assertEq(g2.makerDeduct, _halfQuote(g2.gasUsed));
        // 第二笔量减半但 gas 分摊同额——安全阀基数是其收到额（49.995e18），仍未触阀
        assertEq(g2.makerShortfall, 0);
    }

    // ---------- ⑥ 失败归责扣费 ----------

    function _expiringMakerOrder() internal view returns (Settlement.Order memory) {
        return Settlement.Order({
            orderId: "m-exp",
            userAddress: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: 100e18,
            amountOut: 100e18,
            price: 1e18,
            timestamp: block.timestamp,
            expiresAt: block.timestamp + 100,
            nonce: 7
        });
    }

    function test_FailureCharge_ExpiredOrder() public {
        settlement.setMaxFailureGasChargeQuote(10e18);
        Settlement.SignedOrder memory so = _signed(makerKey, _expiringMakerOrder());
        vault.lockForOrder(_vaultOrder(so.order), so.signature, true);

        vm.warp(block.timestamp + 200); // 订单过期
        Settlement.Fill memory fill = _fill(so, _signed(takerKey, _order(taker, "t", 100e18, 100e18, 7)), 100e18, 100e18);
        vm.expectRevert("Settlement: order expired");
        settlement.settleTrade(fill); // 失败交易（在真实链上这笔 revert 已烧掉提交者 gas）

        uint256 makerBefore = vault.balanceOf(address(tokenA), maker);
        uint256 takerBefore = vault.balanceOf(address(tokenB), taker);
        uint256 thisABefore = tokenA.balanceOf(address(this));
        settlement.chargeFailedSettlement(so, 1, 500_000); // reason 1 = FAIL_ORDER_EXPIRED

        // wantQuote = 500000 × 1gwei × 2000 = 1e18（quote）；上限 10e18 不 binding；
        // 墓碑资产 = tokenA（base），price=1e18 → 扣 1e18 TKA
        assertEq(vault.balanceOf(address(tokenA), maker), makerBefore - 1e18);
        assertEq(tokenA.balanceOf(address(this)), thisABefore + 1e18); // 提交者收到补偿
        assertEq(vault.balanceOf(address(tokenB), taker), takerBefore); // 对方不被扣
        assertTrue(settlement.failureCharged(settlement.orderDigest(so.order)));

        vm.expectRevert("Settlement: failure already charged");
        settlement.chargeFailedSettlement(so, 1, 500_000);
    }

    function test_FailureCharge_LockReleased() public {
        settlement.setMaxFailureGasChargeQuote(10e18);
        Settlement.SignedOrder memory so = _signed(makerKey, _order(maker, "m-rel", 100e18, 100e18, 3));
        vault.lockForOrder(_vaultOrder(so.order), so.signature, true);
        bytes32 digest = settlement.orderDigest(so.order);
        vault.releaseOrderLock(digest); // 用户释放锁定后，节点在途结算必然 revert

        uint256 makerBefore = vault.balanceOf(address(tokenA), maker);
        settlement.chargeFailedSettlement(so, 2, 500_000); // reason 2 = FAIL_LOCK_RELEASED
        assertEq(vault.balanceOf(address(tokenA), maker), makerBefore - 1e18);
    }

    function test_FailureCharge_NeverLockedReverts() public {
        settlement.setMaxFailureGasChargeQuote(10e18);
        Settlement.SignedOrder memory so = _signed(makerKey, _order(maker, "m-nolock", 100e18, 100e18, 9));
        vm.expectRevert("Settlement: order never locked");
        settlement.chargeFailedSettlement(so, 1, 500_000);
    }

    function test_FailureCharge_DisabledByDefault() public {
        Settlement.SignedOrder memory so = _signed(makerKey, _order(maker, "m-dis", 100e18, 100e18, 11));
        vm.expectRevert("Settlement: failure charge disabled");
        settlement.chargeFailedSettlement(so, 1, 500_000);
    }

    function test_FailureCharge_CapClamps() public {
        settlement.setMaxFailureGasChargeQuote(0.5e18); // 上限低于申报换算值 1e18
        Settlement.SignedOrder memory so = _signed(makerKey, _expiringMakerOrder());
        vault.lockForOrder(_vaultOrder(so.order), so.signature, true);
        vm.warp(block.timestamp + 200);
        uint256 makerBefore = vault.balanceOf(address(tokenA), maker);
        settlement.chargeFailedSettlement(so, 1, 500_000);
        assertEq(vault.balanceOf(address(tokenA), maker), makerBefore - 0.5e18);
    }
}
