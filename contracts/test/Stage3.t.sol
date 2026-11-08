// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/FeeDistributor.sol";
import "../src/MakerVault.sol";
import "../src/mock/MockERC20.sol";
import "../src/mock/MockAggregatorV3.sol";
import "../src/mock/Mock1271Wallet.sol";

/// @notice 阶段 3（无节点迁移 §8 第三大步）合约轮专项测试：
/// Route A（side 入签名）+ 提交者模型 B（开放提交）+ ERC-1271 签名长度门修复
/// + 批量结算原子/上限 + Vault 落锁方向一致性（⑥）。
/// 既有 152 例由各原套件继续覆盖；本文件只锁阶段 3 的新增语义。
contract Stage3Test is Test {
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
    address stranger; // 与订单毫无关系的任意地址（B 模型提交者）
    uint256 strangerKey;

    function setUp() public {
        vm.warp(1_760_000_000);
        owner = address(this);
        (maker, makerKey) = makeAddrAndKey("s3-maker");
        (taker, takerKey) = makeAddrAndKey("s3-taker");
        (stranger, strangerKey) = makeAddrAndKey("s3-stranger");

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

    /// @notice 标准一对：maker SELL 100 A、taker BUY 100 A（1:1），nonce 由参数给
    function _pair(uint256 nonce) internal view returns (Settlement.SignedOrder memory, Settlement.SignedOrder memory) {
        return (
            _signed(makerKey, _order(maker, "m", 100e18, 100e18, nonce, settlement.SIDE_SELL())),
            _signed(takerKey, _order(taker, "t", 100e18, 100e18, nonce, settlement.SIDE_BUY()))
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

    // ---------- Route A：side 进入签名 ----------

    /// @notice 翻转 side 即换 digest：拿 sell 的签名去验 buy 副本必失败（方向是签名事实）
    function test_SideIsBoundBySignature() public view {
        Settlement.Order memory sell = _order(maker, "bind", 100e18, 100e18, 0, settlement.SIDE_SELL());
        bytes memory sig = _sign(makerKey, sell);
        assertTrue(settlement.verifyOrderSignature(sell, sig));

        // 其余字段逐一相同、仅 side 不同的订单（不用内存结构体赋值翻转：
        // 内存结构体赋值存在成员别名写穿，先独立构造再改字段不可靠）
        Settlement.Order memory flipped = _order(maker, "bind", 100e18, 100e18, 0, settlement.SIDE_BUY());
        assertTrue(settlement.orderDigest(flipped) != settlement.orderDigest(sell));
        assertFalse(settlement.verifyOrderSignature(flipped, sig));
    }

    /// @notice 非法 side（∉ {0,1}）签名即便自洽，结算也必须被拒
    function test_InvalidSideRevertsAtSettle() public {
        Settlement.SignedOrder memory bad = _signed(makerKey, _order(maker, "bad-side", 100e18, 100e18, 0, 2));
        (, Settlement.SignedOrder memory to) = _pair(0);
        _lock(to);
        vm.expectRevert("Settlement: invalid maker side");
        settlement.settleTrade(_fill(bad, to, 100e18, 100e18));
    }

    // ---------- 方向强制（Settlement 侧） ----------

    /// @notice 成交付款侧与签名方向相反（把 fill 的 tokenIn/tokenOut 对调）→ maker 方向不一致
    function test_DirectionMismatchReverts() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) = _pair(0);
        _lock(mo);
        _lock(to);
        Settlement.Fill memory fill = _fill(mo, to, 100e18, 100e18);
        // 对调付款侧：等于声称 maker 在付 tokenB——与其 SELL 签名方向矛盾
        fill.tokenIn = address(tokenB);
        fill.tokenOut = address(tokenA);
        vm.expectRevert("Settlement: maker direction mismatch");
        settlement.settleTrade(fill);
    }

    /// @notice 双方同为 BUY：taker 的付款侧（tokenOut=tokenB）与其 BUY 派生付款侧
    /// （tokenOut）本可自洽，但 maker 侧 BUY 派生付款 tokenOut ≠ fill.tokenIn → 被拦。
    /// 该用例锁死「同向两单不可成交」。
    function test_SameSidePairCannotSettle() public {
        Settlement.SignedOrder memory mo = _signed(makerKey, _order(maker, "mb", 100e18, 100e18, 0, settlement.SIDE_BUY()));
        Settlement.SignedOrder memory to = _signed(takerKey, _order(taker, "tb", 100e18, 100e18, 0, settlement.SIDE_BUY()));
        // 双方都按 BUY 落锁（付 tokenB）：maker 无 tokenB 余额，先用转账补齐其 tokenB 仓位再落锁
        tokenB.transfer(maker, 200e18);
        vm.startPrank(maker);
        tokenB.approve(address(vault), type(uint256).max);
        vault.deposit(address(tokenB), 200e18);
        vm.stopPrank();
        _lock(mo);
        _lock(to);
        vm.expectRevert("Settlement: maker direction mismatch");
        settlement.settleTrade(_fill(mo, to, 100e18, 100e18));
    }

    // ---------- ⑥ Vault 落锁方向一致性 ----------

    /// @notice 篡改 side 的订单副本落锁必失败（签名绑死方向，锁只能按签名方向落）
    function test_TamperedSideLockReverts() public {
        (Settlement.SignedOrder memory mo,) = _pair(0);
        VaultOrder memory tampered = _vaultOrder(mo.order);
        tampered.side = settlement.SIDE_BUY(); // 原单是 SELL
        vm.expectRevert("Vault: invalid order signature");
        vault.lockForOrder(tampered, mo.signature);
    }

    /// @notice BUY 单落锁只锁 tokenOut 侧（收取侧 tokenIn 恒不动）
    function test_BuyOrderLocksTokenOutOnly() public {
        (, Settlement.SignedOrder memory to) = _pair(0);
        _lock(to);
        assertEq(vault.locked(taker, address(tokenB)), 100e18);
        assertEq(vault.locked(taker, address(tokenA)), 0);
    }

    // ---------- 提交者模型 B：开放提交 ----------

    /// @notice 任意无关地址提交有效 Fill → 结算成功（无 owner/relayer 身份要求）
    function test_OpenSubmission_StrangerCanSettle() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) = _pair(0);
        _lock(mo);
        _lock(to);
        vm.prank(stranger);
        settlement.settleTrade(_fill(mo, to, 100e18, 100e18));
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
    }

    /// @notice 滥用面：陌生人提交被篡改金额的无效 Fill → revert，maker/taker 资金分毫不动
    function test_OpenSubmission_InvalidFillCannotHarmMaker() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) = _pair(0);
        _lock(mo);
        _lock(to);
        Settlement.Fill memory evil = _fill(mo, to, 100e18, 100e18);
        evil.makerOrder.order.amountIn = 200e18; // 篡改签名订单 → 验签必失败
        uint256 makerBefore = vault.balanceOf(address(tokenA), maker);
        uint256 takerBefore = vault.balanceOf(address(tokenB), taker);
        vm.prank(stranger);
        vm.expectRevert("Settlement: invalid maker signature");
        settlement.settleTrade(evil);
        assertEq(vault.balanceOf(address(tokenA), maker), makerBefore);
        assertEq(vault.balanceOf(address(tokenB), taker), takerBefore);
    }

    /// @notice 滥用面：同一 Fill 全额成交后重复提交 → 累计记账拦截，与提交者是谁无关
    function test_OpenSubmission_ReplayBlockedByCumulativeAccounting() public {
        (Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to) = _pair(0);
        _lock(mo);
        _lock(to);
        Settlement.Fill memory fill = _fill(mo, to, 100e18, 100e18);
        vm.prank(stranger);
        settlement.settleTrade(fill);
        vm.prank(stranger);
        vm.expectRevert("Settlement: fill exceeds signed order");
        settlement.settleTrade(fill);
    }

    // ---------- 批量结算：原子性与硬顶 ----------

    /// @notice 三腿一批由陌生人提交，全部落账（价格/方向各异的一对 + 部分成交一对）
    function test_Batch_StrangerSettlesAtomically() public {
        Settlement.Fill[] memory fills = new Settlement.Fill[](2);
        (Settlement.SignedOrder memory m0, Settlement.SignedOrder memory t0) = _pair(0);
        (Settlement.SignedOrder memory m1, Settlement.SignedOrder memory t1) = _pair(1);
        _lock(m0);
        _lock(t0);
        _lock(m1);
        _lock(t1);
        fills[0] = _fill(m0, t0, 100e18, 100e18);
        fills[1] = _fill(m1, t1, 40e18, 40e18); // 部分成交
        vm.prank(stranger);
        settlement.settleTradesBatch(fills);
        assertEq(vault.balanceOf(address(tokenB), maker), 99.99e18 + 39.996e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18 + 39.996e18);
    }

    /// @notice 原子性：第二腿签名被篡改 → 整批回滚，第一腿的落账也一并撤销
    function test_Batch_OneBadLegRevertsWholeBatch() public {
        Settlement.Fill[] memory fills = new Settlement.Fill[](2);
        (Settlement.SignedOrder memory m0, Settlement.SignedOrder memory t0) = _pair(0);
        (Settlement.SignedOrder memory m1, Settlement.SignedOrder memory t1) = _pair(1);
        _lock(m0);
        _lock(t0);
        _lock(m1);
        _lock(t1);
        fills[0] = _fill(m0, t0, 100e18, 100e18);
        fills[1] = _fill(m1, t1, 100e18, 100e18);
        fills[1].takerOrder.signature = _sign(strangerKey, t1.order); // 冒签
        uint256 makerBefore = vault.balanceOf(address(tokenB), maker);
        vm.prank(stranger);
        vm.expectRevert("Settlement: invalid taker signature");
        settlement.settleTradesBatch(fills);
        // 第一腿未落账、两单的锁原样保留
        assertEq(vault.balanceOf(address(tokenB), maker), makerBefore);
        assertEq(settlement.orderFilledIn(settlement.orderDigest(m0.order)), 0);
    }

    /// @notice 批大小硬顶：MAX_BATCH_SIZE + 1 腿在任何验签之前就被拒
    function test_Batch_SizeCapEnforced() public {
        assertEq(settlement.MAX_BATCH_SIZE(), 50);
        Settlement.Fill[] memory fills = new Settlement.Fill[](settlement.MAX_BATCH_SIZE() + 1);
        vm.expectRevert("Settlement: batch size too large");
        settlement.settleTradesBatch(fills);
    }

    // ---------- ERC-1271 签名长度门修复 ----------

    /// @notice 变长签名（65 字节真签名 + 32 字节填充）必须能到达 1271 路径并验过；
    /// 旧版 Settlement 在长度门处直接 false，本用例即回归锁。
    function test_VariableLengthSignatureReaches1271() public {
        (address walletOwner, uint256 walletKey) = makeAddrAndKey("walletOwner");
        Mock1271Wallet wallet = new Mock1271Wallet(walletOwner);
        Settlement.Order memory order = _order(address(wallet), "w1", 100e18, 100e18, 0, settlement.SIDE_SELL());
        bytes memory sig65 = _sign(walletKey, order);
        bytes memory padded = abi.encodePacked(sig65, bytes32(uint256(0xdead)));
        assertEq(padded.length, 97);
        assertTrue(settlement.verifyOrderSignature(order, padded));
        // 填充不能救活错误签名者的签名
        bytes memory badPadded = abi.encodePacked(_sign(strangerKey, order), bytes32(uint256(0xdead)));
        assertFalse(settlement.verifyOrderSignature(order, badPadded));
        // EOA 地址拿变长签名仍直接 false（无代码不进 1271）
        Settlement.Order memory eoaOrder = _order(maker, "eoa", 100e18, 100e18, 0, settlement.SIDE_SELL());
        bytes memory eoaPadded = abi.encodePacked(_sign(makerKey, eoaOrder), bytes32(uint256(1)));
        assertFalse(settlement.verifyOrderSignature(eoaOrder, eoaPadded));
    }

    /// @notice 智能钱包全链路：变长签名订单落锁 → 陌生人提交结算成功
    function test_VariableLengthSignatureFullSettle() public {
        (address walletOwner, uint256 walletKey) = makeAddrAndKey("walletOwner");
        Mock1271Wallet wallet = new Mock1271Wallet(walletOwner);
        // 钱包在 Vault 中备好 tokenA 仓位（以钱包地址身份存入）
        tokenA.transfer(address(wallet), 200e18);
        vm.startPrank(address(wallet));
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(address(tokenA), 200e18);
        vm.stopPrank();

        Settlement.Order memory order = _order(address(wallet), "w-full", 100e18, 100e18, 0, settlement.SIDE_SELL());
        bytes memory padded = abi.encodePacked(_sign(walletKey, order), bytes32(uint256(0xbeef)));
        Settlement.SignedOrder memory walletOrder = Settlement.SignedOrder({order: order, signature: padded});
        (, Settlement.SignedOrder memory to) = _pair(0);
        _lock(walletOrder);
        _lock(to);
        vm.prank(stranger);
        settlement.settleTrade(_fill(walletOrder, to, 100e18, 100e18));
        assertEq(vault.balanceOf(address(tokenB), address(wallet)), 99.99e18);
        assertEq(vault.balanceOf(address(tokenA), taker), 99.99e18);
    }

    // ---------- ⑦ MakerVault（ERC-1271）× B 开放提交 ----------

    /// @notice MakerVault 金库买单（登记签名者代签、1271 验签）由陌生人提交结算成功：
    /// ⑦ 的端到端路径在阶段 3 后同时证明「合约用户 + 开放提交」组合成立。
    function test_MakerVaultOrderSettledByStranger() public {
        MockERC20 usdt = tokenB; // 本套件以 tokenB 充当计价资产
        MockERC20 btc = tokenA;
        MockAggregatorV3 feed = new MockAggregatorV3(7582234000000, 8);
        MakerVault makerVault = new MakerVault(IERC20(address(usdt)), address(vault), address(btc), address(feed));
        (, uint256 vaultSignerKey) = makeAddrAndKey("s3-vaultSigner");
        address vaultSigner = vm.addr(vaultSignerKey);
        makerVault.setSigner(vaultSigner, makerVault.ROLE_MARKET_MAKER(), true);

        // 出资人存 1000 tokenB 进金库（自动转入交易 Vault）
        address depositor = makeAddr("s3-depositor");
        tokenB.transfer(depositor, 1000e18);
        vm.startPrank(depositor);
        tokenB.approve(address(makerVault), type(uint256).max);
        makerVault.deposit(1000e18, depositor);
        vm.stopPrank();

        // 金库 BUY 0.01 tokenA（付 758.2234 tokenB），taker SELL 对手单
        uint256 px = 75822340000000000000000; // 75822.34e18
        Settlement.Order memory vaultBuy = Settlement.Order({
            orderId: "s3-vault-buy", userAddress: address(makerVault), tokenIn: address(btc), tokenOut: address(usdt),
            amountIn: 0.01e18, amountOut: 7582234e14, price: px, timestamp: block.timestamp,
            expiresAt: block.timestamp + 1 days, nonce: 0, side: settlement.SIDE_BUY()
        });
        Settlement.Order memory takerSell = Settlement.Order({
            orderId: "s3-taker-sell", userAddress: taker, tokenIn: address(btc), tokenOut: address(usdt),
            amountIn: 0.01e18, amountOut: 7582234e14, price: px, timestamp: block.timestamp,
            expiresAt: block.timestamp + 1 days, nonce: 0, side: settlement.SIDE_SELL()
        });
        Settlement.SignedOrder memory vBuy = _signed(vaultSignerKey, vaultBuy);
        Settlement.SignedOrder memory tSell = _signed(takerKey, takerSell);
        // taker 的 tokenA 仓位（setUp 只给了 tokenB）：补存
        tokenA.transfer(taker, 1e18);
        vm.startPrank(taker);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(address(tokenA), 1e18);
        vm.stopPrank();

        _lock(vBuy);
        _lock(tSell);
        Settlement.Fill memory fill = Settlement.Fill({
            makerOrder: tSell, takerOrder: vBuy, tokenIn: address(btc), tokenOut: address(usdt),
            amountIn: 0.01e18, amountOut: 7582234e14, gasReimburseIn: 0, gasReimburseOut: 0
        });
        vm.prank(stranger);
        settlement.settleTrade(fill);
        // 金库收到 0.01 tokenA 扣 0.01% 费；taker 收到 tokenB 扣费
        // （taker 的 tokenB 余额含 setUp 已存入的 500e18）
        assertEq(vault.balanceOf(address(btc), address(makerVault)), 0.01e18 - 0.01e18 / 10000);
        assertEq(vault.balanceOf(address(usdt), taker), 500e18 + 7582234e14 - 7582234e14 / 10000);
    }
}
