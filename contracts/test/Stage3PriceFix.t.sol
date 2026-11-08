// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/FeeDistributor.sol";
import "../src/MakerVault.sol";
import "../src/mock/MockERC20.sol";
import "../src/mock/MockAggregatorV3.sol";

/// @notice 阶段 3 价格校验修复轮专项测试：Settlement 此前从无「成交比例 vs
/// 双方签名限价」校验——_verifyFill/_accountFill 只查累计量不超签名量，
/// 开放提交（模型 B）下任何人可用两张真实签名订单构造击穿某一方限价的
/// Fill（如卖方签 100↔200、提交 100↔1）且全部检查通过。本文件锁死修复
/// 语义：每笔切片在每张订单自身朝向下以签名量交叉相乘强制限价
/// （SELL 实收比例不低于签名价 / BUY 实付比例不高于签名价，无除法）。
/// 另含本轮骑乘项：阶段 3 冻结摘要的 Solidity 侧向量断言、两个其余批
/// 入口（GasSavings / Merkle）的坏腿整批回滚。
contract Stage3PriceFixTest is Test {
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
    address stranger;
    uint256 strangerKey;


    function setUp() public {
        vm.warp(1_760_000_000);
        owner = address(this);
        (maker, makerKey) = makeAddrAndKey("pf-maker");
        (taker, takerKey) = makeAddrAndKey("pf-taker");
        (stranger, strangerKey) = makeAddrAndKey("pf-stranger");

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

    // ---------- 辅助（与 Stage3.t.sol 同构） ----------

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

    /// @notice maker SELL 签 (mIn, mOut)、taker BUY 签 (tIn, tOut) 的一对
    function _pricedPair(uint256 nonce, uint256 mIn, uint256 mOut, uint256 tIn, uint256 tOut)
        internal
        view
        returns (Settlement.SignedOrder memory, Settlement.SignedOrder memory)
    {
        return (
            _signed(makerKey, _order(maker, "m", mIn, mOut, nonce, settlement.SIDE_SELL())),
            _signed(takerKey, _order(taker, "t", tIn, tOut, nonce, settlement.SIDE_BUY()))
        );
    }

    function _fill(Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to, uint256 inAmt, uint256 outAmt)
        internal
        pure
        returns (Settlement.Fill memory)
    {
        return Settlement.Fill({
            makerOrder: mo,
            takerOrder: to,
            tokenIn: mo.order.tokenIn,
            tokenOut: mo.order.tokenOut,
            amountIn: inAmt,
            amountOut: outAmt,
            gasReimburseIn: 0,
            gasReimburseOut: 0
        });
    }

    function _lock(Settlement.SignedOrder memory so) internal {
        vault.lockForOrder(_vaultOrder(so.order), so.signature);
    }

    function _lockPair(Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) internal {
        _lock(mo);
        _lock(to);
    }

    // ---------- 恶意 Fill：卖方限价被击穿（复审 P0 利用例） ----------

    /// @notice 卖方签 100 A ↔ 200 B（限价 2 B/A），陌生人提交 100 A ↔ 1 B：
    /// 累计量两边都不超签名量（旧校验全过），限价校验必须拦下且资金不动
    function test_SellLimitBreachedReverts() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) =
            _pricedPair(0, 100e18, 200e18, 100e18, 200e18);
        _lockPair(mo, to);
        Settlement.Fill memory evil = _fill(mo, to, 100e18, 1e18);
        uint256 makerBefore = vault.balanceOf(address(tokenA), maker);
        uint256 takerBefore = vault.balanceOf(address(tokenB), taker);
        vm.prank(stranger);
        vm.expectRevert("Settlement: fill breaches signed limit price");
        settlement.settleTrade(evil);
        assertEq(vault.balanceOf(address(tokenA), maker), makerBefore);
        assertEq(vault.balanceOf(address(tokenB), taker), takerBefore);
        assertEq(settlement.orderFilledIn(settlement.orderDigest(mo.order)), 0);
    }

    // ---------- 恶意 Fill：买方限价被击穿 ----------

    /// @notice 双方同签 100↔200，提交 50 A ↔ 150 B（3 B/A）：卖方实收优于
    /// 其限价（其校验通过、累计也不超），买方实付比例击穿其签名上限 2 B/A
    /// ——必须由买方侧限价校验拦下
    function test_BuyLimitBreachedReverts() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) =
            _pricedPair(0, 100e18, 200e18, 100e18, 200e18);
        _lockPair(mo, to);
        Settlement.Fill memory evil = _fill(mo, to, 50e18, 150e18);
        vm.prank(stranger);
        vm.expectRevert("Settlement: fill breaches signed limit price");
        settlement.settleTrade(evil);
        assertEq(settlement.orderFilledIn(settlement.orderDigest(to.order)), 0);
    }

    // ---------- 批量：坏价格腿整批回滚（普通批入口） ----------

    function _batchWithBadPriceLeg() internal view returns (Settlement.Fill[] memory fills, Settlement.SignedOrder memory goodMaker) {
        fills = new Settlement.Fill[](2);
        (Settlement.SignedOrder memory m0, Settlement.SignedOrder memory t0) =
            _pricedPair(0, 100e18, 100e18, 100e18, 100e18);
        (Settlement.SignedOrder memory m1, Settlement.SignedOrder memory t1) =
            _pricedPair(1, 100e18, 200e18, 100e18, 200e18);
        fills[0] = _fill(m0, t0, 100e18, 100e18); // 合法腿
        fills[1] = _fill(m1, t1, 100e18, 1e18); // 击穿卖方限价的坏腿
        goodMaker = m0;
        // 注意：锁不在此处落（expectRevert 前的外部调用无妨，但落锁留给
        // 各用例在构造 fills 后统一处理，保持顺序直观）——见 _lockBatch。
    }

    function _lockBatch(Settlement.Fill[] memory fills) internal {
        for (uint256 i = 0; i < fills.length; i++) {
            _lock(fills[i].makerOrder);
            _lock(fills[i].takerOrder);
        }
    }

    function test_BatchBadPriceLegRevertsWholeBatch() public {
        (Settlement.Fill[] memory fills, Settlement.SignedOrder memory goodMaker) = _batchWithBadPriceLeg();
        _lockBatch(fills);
        uint256 makerBefore = vault.balanceOf(address(tokenB), maker);
        vm.prank(stranger);
        vm.expectRevert("Settlement: fill breaches signed limit price");
        settlement.settleTradesBatch(fills);
        // 合法腿也未落账
        assertEq(vault.balanceOf(address(tokenB), maker), makerBefore);
        assertEq(settlement.orderFilledIn(settlement.orderDigest(goodMaker.order)), 0);
    }

    // ---------- 骑乘：GasSavings 批入口坏腿整批回滚 ----------

    function test_BatchWithGasSavingsBadLegRevertsWholeBatch() public {
        settlement.setUsdtToken(address(tokenB));
        (Settlement.Fill[] memory fills, Settlement.SignedOrder memory goodMaker) = _batchWithBadPriceLeg();
        _lockBatch(fills);
        uint256 makerBefore = vault.balanceOf(address(tokenB), maker);
        vm.prank(stranger);
        vm.expectRevert("Settlement: fill breaches signed limit price");
        settlement.settleTradesBatchWithGasSavings(fills, 100);
        assertEq(vault.balanceOf(address(tokenB), maker), makerBefore);
        assertEq(settlement.orderFilledIn(settlement.orderDigest(goodMaker.order)), 0);
    }

    // ---------- 骑乘：Merkle 批入口坏腿整批回滚 ----------

    function _leaf(Settlement.Fill memory f) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            settlement.orderDigest(f.makerOrder.order),
            settlement.orderDigest(f.takerOrder.order),
            f.tokenIn,
            f.tokenOut,
            f.amountIn,
            f.amountOut,
            f.gasReimburseIn,
            f.gasReimburseOut
        ));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function test_BatchWithMerkleBadLegRevertsWholeBatch() public {
        (Settlement.Fill[] memory fills, Settlement.SignedOrder memory goodMaker) = _batchWithBadPriceLeg();
        _lockBatch(fills);
        bytes32 leaf0 = _leaf(fills[0]);
        bytes32 leaf1 = _leaf(fills[1]);
        bytes32 root = _hashPair(leaf0, leaf1);
        bytes32[][] memory proofs = new bytes32[][](2);
        proofs[0] = new bytes32[](1);
        proofs[0][0] = leaf1;
        proofs[1] = new bytes32[](1);
        proofs[1][0] = leaf0;
        uint256 makerBefore = vault.balanceOf(address(tokenB), maker);
        vm.prank(stranger);
        vm.expectRevert("Settlement: fill breaches signed limit price");
        settlement.settleTradesBatchWithMerkle(7, root, fills, proofs);
        assertEq(vault.balanceOf(address(tokenB), maker), makerBefore);
        assertEq(settlement.orderFilledIn(settlement.orderDigest(goodMaker.order)), 0);
    }

    // ---------- 正当成交：恰在限价的部分成交（含续结） ----------

    function test_PartialFillExactlyAtLimitPasses() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) =
            _pricedPair(0, 100e18, 200e18, 100e18, 200e18);
        _lockPair(mo, to);
        // 第一笔 25 A ↔ 50 B：比例恰为签名价 2 B/A（等号边界）
        settlement.settleTrade(_fill(mo, to, 25e18, 50e18));
        assertEq(vault.balanceOf(address(tokenB), maker), 50e18 - 0.005e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 25e18 - 0.0025e18);
        // 续结剩余 75 A ↔ 150 B：仍恰在限价，逐切片校验不因分笔而放宽/误杀
        settlement.settleTrade(_fill(mo, to, 75e18, 150e18));
        assertEq(vault.balanceOf(address(tokenB), maker), 200e18 - 0.02e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 100e18 - 0.01e18);
    }

    // ---------- 正当成交：对 taker 价格改善 ----------

    /// @notice maker 底价 1 B/A、taker 上限 2 B/A，部分成交于中间价
    /// 1.5 B/A：taker 实付低于其签名上限（价格改善）、maker 实收高于其
    /// 下限，两侧皆过。（全量成交给 maker 150 B 会先撞其 amountOut=100
    /// 的累计接收上限——改善价只能体现在与双方签名量兼容的切片上。）
    function test_PriceImprovementForTakerPasses() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) =
            _pricedPair(0, 100e18, 100e18, 100e18, 200e18);
        _lockPair(mo, to);
        settlement.settleTrade(_fill(mo, to, 50e18, 75e18));
        assertEq(vault.balanceOf(address(tokenB), maker), 75e18 - 0.0075e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 50e18 - 0.005e18);
    }

    // ---------- 正当成交：市价单（签名价 = 保护价） ----------

    /// @notice taker 市价买单：签 amountOut=300 B 为保护上限（3 B/A），
    /// 簿上价 2 B/A 之外、保护内的 2.5 B/A 成交正常通过
    function test_MarketOrderWithinProtectionPasses() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) =
            _pricedPair(0, 100e18, 200e18, 100e18, 300e18);
        _lockPair(mo, to);
        settlement.settleTrade(_fill(mo, to, 50e18, 125e18));
        assertEq(vault.balanceOf(address(tokenB), maker), 125e18 - 0.0125e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 50e18 - 0.005e18);
    }

    /// @notice 同一市价单：成交价 3.2 B/A 击穿保护价 3 B/A → revert
    function test_MarketOrderProtectionBreachReverts() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) =
            _pricedPair(0, 100e18, 200e18, 100e18, 300e18);
        _lockPair(mo, to);
        Settlement.Fill memory evil = _fill(mo, to, 50e18, 160e18);
        vm.expectRevert("Settlement: fill breaches signed limit price");
        settlement.settleTrade(evil);
    }

    // ---------- 舍入边界：交叉相乘无除法，不误杀合法小额切片 ----------

    /// @notice wei 级切片：对 100↔200 的大单提交 1 wei A ↔ 2 wei B（恰为
    /// 签名比例）必须通过；同单再提交 1 wei ↔ 1 wei（比例 1 < 2）必须被拦
    function test_TinySliceAtExactRatioPasses() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) =
            _pricedPair(0, 100e18, 200e18, 100e18, 200e18);
        _lockPair(mo, to);
        settlement.settleTrade(_fill(mo, to, 1, 2));
        assertEq(settlement.orderFilledIn(settlement.orderDigest(mo.order)), 1);
        assertEq(settlement.orderFilledOut(settlement.orderDigest(mo.order)), 2);
        Settlement.Fill memory below = _fill(mo, to, 1, 1);
        vm.expectRevert("Settlement: fill breaches signed limit price");
        settlement.settleTrade(below);
    }

    /// @notice 定点截断误杀回归：BUY 单签 7 付 3（price 字段 = 3e18/7 被截断
    /// 为 428571428571428571）——若按 price 字段折算，买方上限会被算成
    /// 7×trunc(price)/1e18 = 2 < 3，恰在限价的 7↔3 成交将被误杀；
    /// 交叉相乘（3×7 <= 7×3，等号）精确放行
    function test_TinyAmountsTruncatedPriceWouldMisKill() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) = _pricedPair(0, 7, 3, 7, 3);
        // 锁死前提：price 字段确实发生了截断（本用例的意义所在）
        assertEq(mo.order.price, 428571428571428571);
        _lockPair(mo, to);
        settlement.settleTrade(_fill(mo, to, 7, 3));
        assertEq(vault.balanceOf(address(tokenB), maker), 3);
        assertEq(vault.balanceOf(address(tokenA), taker), 7);
    }

    // ---------- MakerVault 订单：合法价陌生人可提交 / 偏离价 revert ----------

    function _makerVaultSetup() internal returns (MakerVault makerVault, uint256 vaultSignerKey) {
        MockAggregatorV3 feed = new MockAggregatorV3(7582234000000, 8);
        makerVault = new MakerVault(IERC20(address(tokenB)), address(vault), address(tokenA), address(feed));
        address vaultSigner;
        (vaultSigner, vaultSignerKey) = makeAddrAndKey("pf-vaultSigner");
        makerVault.setSigner(vaultSigner, makerVault.ROLE_MARKET_MAKER(), true);

        address depositor = makeAddr("pf-depositor");
        tokenB.transfer(depositor, 1000e18);
        vm.startPrank(depositor);
        tokenB.approve(address(makerVault), type(uint256).max);
        makerVault.deposit(1000e18, depositor);
        vm.stopPrank();

        // taker 的 tokenA 仓位（setUp 只备了 tokenB）
        tokenA.transfer(taker, 300e18);
        vm.startPrank(taker);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(address(tokenA), 300e18);
        vm.stopPrank();
    }

    function _vaultPair(MakerVault makerVault, uint256 vaultSignerKey, uint256 nonce, string memory tag)
        internal
        view
        returns (Settlement.SignedOrder memory vaultBuy, Settlement.SignedOrder memory takerSell)
    {
        Settlement.Order memory buyOrder = Settlement.Order({
            orderId: tag, userAddress: address(makerVault), tokenIn: address(tokenA), tokenOut: address(tokenB),
            amountIn: 100e18, amountOut: 200e18, price: 2e18, timestamp: block.timestamp,
            expiresAt: block.timestamp + 1 days, nonce: nonce, side: settlement.SIDE_BUY()
        });
        Settlement.Order memory sellOrder = Settlement.Order({
            orderId: tag, userAddress: taker, tokenIn: address(tokenA), tokenOut: address(tokenB),
            amountIn: 100e18, amountOut: 200e18, price: 2e18, timestamp: block.timestamp,
            expiresAt: block.timestamp + 1 days, nonce: nonce, side: settlement.SIDE_SELL()
        });
        vaultBuy = _signed(vaultSignerKey, buyOrder);
        takerSell = _signed(takerKey, sellOrder);
    }

    /// @notice 金库 BUY 单（1271 验签）在签名价内由陌生人提交 → 结算成功
    function test_MakerVaultLegitPriceByStrangerPasses() public {
        (MakerVault makerVault, uint256 vaultSignerKey) = _makerVaultSetup();
        (Settlement.SignedOrder memory vBuy, Settlement.SignedOrder memory tSell) =
            _vaultPair(makerVault, vaultSignerKey, 0, "mv-ok");
        _lockPair(tSell, vBuy);
        Settlement.Fill memory fill = Settlement.Fill({
            makerOrder: tSell, takerOrder: vBuy, tokenIn: address(tokenA), tokenOut: address(tokenB),
            amountIn: 100e18, amountOut: 200e18, gasReimburseIn: 0, gasReimburseOut: 0
        });
        vm.prank(stranger);
        settlement.settleTrade(fill);
        assertEq(vault.balanceOf(address(tokenA), address(makerVault)), 100e18 - 0.01e18);
        assertEq(vault.balanceOf(address(tokenB), taker), 500e18 + 200e18 - 0.02e18);
    }

    /// @notice 同一金库单：陌生人提交 50 A ↔ 150 B（金库实付 3 B/A，击穿其
    /// 签名价 2 B/A）→ revert，金库资金不动
    function test_MakerVaultDeviatingPriceReverts() public {
        (MakerVault makerVault, uint256 vaultSignerKey) = _makerVaultSetup();
        (Settlement.SignedOrder memory vBuy, Settlement.SignedOrder memory tSell) =
            _vaultPair(makerVault, vaultSignerKey, 0, "mv-bad");
        _lockPair(tSell, vBuy);
        Settlement.Fill memory evil = Settlement.Fill({
            makerOrder: tSell, takerOrder: vBuy, tokenIn: address(tokenA), tokenOut: address(tokenB),
            amountIn: 50e18, amountOut: 150e18, gasReimburseIn: 0, gasReimburseOut: 0
        });
        uint256 vaultBefore = vault.balanceOf(address(tokenB), address(makerVault));
        vm.prank(stranger);
        vm.expectRevert("Settlement: fill breaches signed limit price");
        settlement.settleTrade(evil);
        assertEq(vault.balanceOf(address(tokenB), address(makerVault)), vaultBefore);
    }

    // ---------- 骑乘：阶段 3 冻结摘要向量的 Solidity 侧断言 ----------

    /// @notice 跨语言冻结向量（docs/eip712-order-spec.md §6；Go/Worker/
    /// Indexer/前端四处已断言同一值）：域 = chainId 31337 + 验证合约
    /// 0x5FbDB2315678afecb367f032d93F642f64180aa3（anvil 首部署地址）。
    /// 把 Settlement 本体部署到该地址后，orderDigest 必须逐字节复现
    /// 冻结摘要，且 ethers 生成的向量签名必须验过——Solidity 侧从此
    /// 不再缺席五方对齐。
    function test_FrozenDigestVector() public {
        vm.chainId(31337);
        address target = 0x5FbDB2315678afecb367f032d93F642f64180aa3;
        deployCodeTo("Settlement.sol:Settlement", abi.encode(address(0x1), address(0x2)), target);
        Settlement vec = Settlement(target);

        Settlement.Order memory order = Settlement.Order({
            orderId: "order_vector_1",
            userAddress: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
            tokenIn: 0x1111111111111111111111111111111111111111,
            tokenOut: 0x2222222222222222222222222222222222222222,
            amountIn: 100e18,
            amountOut: 200e18,
            price: 2e18,
            timestamp: 1700000000,
            expiresAt: 1700086400,
            nonce: 0,
            side: 1 // SIDE_SELL
        });
        assertEq(
            vec.orderDigest(order),
            bytes32(0xd793d795036c2d1b548120e9e73ea43a608529b4a23f0d3254c263fde391cec0)
        );
        // ethers 对该向量的签名（anvil 账户 #0）必须在 Solidity 侧验过
        bytes memory ethersSig =
            hex"c7d48a6fdc483a27fa1c04cdfa92b5e4fb162cd94c747ffca46b73222b34f9ae4c2751772e5e43bbcee2b9d84a46eee9a7e472fddcf1bd58542760c0afe9ec9c1b";
        assertTrue(vec.verifyOrderSignature(order, ethersSig));

        // side=0（BUY）变体向量：仅 side 不同，摘要亦冻结
        order.side = 0;
        assertEq(
            vec.orderDigest(order),
            bytes32(0x158420436d13a5daba116dd1d1165168c8a759711f13665f371223d246231b96)
        );
    }
}
