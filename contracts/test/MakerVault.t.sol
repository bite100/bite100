// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/FeeDistributor.sol";
import "../src/MakerVault.sol";
import "../src/mock/MockERC20.sol";
import "../src/mock/MockAggregatorV3.sol";

/// @notice 第二十七轮：做市金库（Tier 2）专项测试。
/// 覆盖：ERC-4626 存取款与 NAV（含 base 库存按 Chainlink 折价）、存款自动转入交易 Vault、
/// 赎回从交易 Vault 拉回可用余额（锁定部分提不出）、ERC-1271 金库订单全链路（落锁→结算）、
/// 签名者登记/轮换/撤销、暂停语义（停存款+停验签、不停赎回）、喂价过期 fail-closed。
contract MakerVaultTest is Test {
    Vault vault;
    Settlement settlement;
    FeeDistributor feeDistributor;
    MakerVault makerVault;
    MockERC20 usdt; // 计价资产（asset）
    MockERC20 btc; // 基础资产（base）
    MockAggregatorV3 feed;

    address owner;
    address depositor;
    address signerAddr;
    uint256 signerKey;
    address taker;
    uint256 takerKey;
    address stranger;
    uint256 strangerKey;

    // BTC 参考价 $75,822.34（8 位小数），与第 25 轮 Sepolia 实读值同口径
    int256 internal constant BTC_PRICE = 7582234000000;
    uint256 internal constant PRICE = 75822340000000000000000; // 75822.34e18

    function setUp() public {
        vm.warp(1_760_000_000);
        owner = address(this);
        depositor = address(0xD);
        (signerAddr, signerKey) = makeAddrAndKey("vaultSigner");
        (taker, takerKey) = makeAddrAndKey("taker");
        (stranger, strangerKey) = makeAddrAndKey("stranger");

        usdt = new MockERC20("Test Tether", "USDT", 1_000_000e18);
        btc = new MockERC20("Test Bitcoin", "BTC", 1_000_000e18);
        feed = new MockAggregatorV3(BTC_PRICE, 8);

        vault = new Vault();
        feeDistributor = new FeeDistributor();
        settlement = new Settlement(address(vault), address(feeDistributor));
        vault.setSettlement(address(settlement));
        vault.setLocker(address(this), true);

        makerVault = new MakerVault(IERC20(address(usdt)), address(vault), address(btc), address(feed));
        makerVault.setSigner(signerAddr, makerVault.ROLE_MARKET_MAKER(), true);

        // 存款人：1 万 USDT；taker：1 BTC（放进交易 Vault，供对手盘）
        usdt.transfer(depositor, 10_000e18);
        btc.transfer(taker, 1e18);
        vm.startPrank(depositor);
        usdt.approve(address(makerVault), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(taker);
        btc.approve(address(vault), type(uint256).max);
        vault.deposit(address(btc), 1e18);
        vm.stopPrank();
    }

    // ---------- 辅助 ----------

    function _deposit(uint256 amount) internal returns (uint256 shares) {
        vm.prank(depositor);
        shares = makerVault.deposit(amount, depositor);
    }

    function _vaultOrder(address user, string memory orderId, uint256 amountIn, uint256 amountOut, uint256 nonce, uint8 side)
        internal
        view
        returns (Settlement.Order memory)
    {
        return Settlement.Order({
            orderId: orderId,
            userAddress: user,
            tokenIn: address(btc),
            tokenOut: address(usdt),
            amountIn: amountIn,
            amountOut: amountOut,
            price: PRICE,
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

    function _signed(uint256 key, Settlement.Order memory order)
        internal
        view
        returns (Settlement.SignedOrder memory)
    {
        return Settlement.SignedOrder({order: order, signature: _sign(key, order)});
    }

    function _toVaultOrder(Settlement.Order memory o) internal pure returns (VaultOrder memory) {
        return VaultOrder({
            orderId: o.orderId,
            userAddress: o.userAddress,
            tokenIn: o.tokenIn,
            tokenOut: o.tokenOut,
            amountIn: o.amountIn,
            amountOut: o.amountOut,
            price: o.price,
            timestamp: o.timestamp,
            expiresAt: o.expiresAt,
            nonce: o.nonce,
            side: o.side
        });
    }

    // ---------- ERC-4626 存取款与 NAV ----------

    function testDepositForwardsToTradingVault() public {
        uint256 shares = _deposit(1000e18);
        assertEq(shares, 1000e18, "first deposit 1:1");
        assertEq(vault.balanceOf(address(usdt), address(makerVault)), 1000e18, "funds in trading Vault");
        assertEq(usdt.balanceOf(address(makerVault)), 0, "nothing left in MakerVault");
        assertEq(makerVault.totalAssets(), 1000e18, "NAV == deposit");
        assertEq(makerVault.balanceOf(depositor), 1000e18, "shares to depositor");
    }

    function testTotalAssetsPricesBaseInventory() public {
        _deposit(1000e18);
        // 金库合约直接收到 0.01 BTC，同步进交易 Vault 后 NAV 应含其折价
        btc.transfer(address(makerVault), 0.01e18);
        makerVault.syncToTradingVault(address(btc), 0.01e18);
        // 0.01 BTC × $75,822.34 = $758.2234
        assertEq(makerVault.totalAssets(), 1758223400000000000000, "NAV = 1000 USDT + 0.01 BTC priced");
        // OZ 的 convertToAssets 含 +1 虚拟份额防通胀：结果比精确值小 ≤1 wei
        assertApproxEqAbs(makerVault.convertToAssets(1000e18), 1758223400000000000000, 1, "share price reflects base");
    }

    function testRedeemPullsFromTradingVault() public {
        _deposit(1000e18);
        uint256 before = usdt.balanceOf(depositor);
        vm.prank(depositor);
        makerVault.redeem(400e18, depositor, depositor);
        assertEq(usdt.balanceOf(depositor) - before, 400e18, "redeem pays out");
        assertEq(vault.balanceOf(address(usdt), address(makerVault)), 600e18, "trading Vault drawn down");
        assertEq(makerVault.balanceOf(depositor), 600e18, "shares burned");
    }

    function testRedeemBlockedByLock() public {
        _deposit(1000e18);
        // 金库买单锁定 800 USDT（pay tokenOut），可用只剩 200
        Settlement.Order memory buy =
            _vaultOrder(address(makerVault), "vault-buy-1", 0.01e18, 800e18, 0, 0);
        vault.lockForOrder(_toVaultOrder(buy), _sign(signerKey, buy));
        assertEq(vault.availableBalance(address(makerVault), address(usdt)), 200e18);
        vm.prank(depositor);
        vm.expectRevert();
        makerVault.redeem(400e18, depositor, depositor);
        // 释放锁定后赎回恢复
        vault.releaseOrderLock(settlement.orderDigest(buy));
        vm.prank(depositor);
        makerVault.redeem(400e18, depositor, depositor);
        assertEq(usdt.balanceOf(depositor), 10_000e18 - 1000e18 + 400e18);
    }

    // ---------- ERC-1271 金库订单全链路 ----------

    function testVaultOrderVerifiesViaERC1271() public {
        Settlement.Order memory o = _vaultOrder(address(makerVault), "v-1", 0.01e18, 800e18, 0, 0);
        bytes memory sig = _sign(signerKey, o);
        assertTrue(settlement.verifyOrderSignature(o, sig), "registered signer verifies");
        // 未登记密钥签的同一订单不通过
        bytes memory badSig = _sign(strangerKey, o);
        assertFalse(settlement.verifyOrderSignature(o, badSig), "stranger must not verify");
        // EOA 订单回归：恢复路径不受影响
        Settlement.Order memory eoa = _vaultOrder(taker, "eoa-1", 0.01e18, 800e18, 0, 0);
        assertTrue(settlement.verifyOrderSignature(eoa, _sign(takerKey, eoa)), "EOA path intact");
    }

    function testVaultBuySettlesOnChain() public {
        _deposit(1000e18);
        // 金库买 0.01 BTC（付 758.2234 USDT），taker 卖 0.01 BTC。
        // Fill 语义：amountIn = maker 卖出 tokenIn 量——卖出 BTC 的一方（taker）
        // 是 makerOrder，买入的金库是 takerOrder。
        Settlement.Order memory vaultBuy = _vaultOrder(address(makerVault), "vault-buy", 0.01e18, 7582234e14, 0, 0);
        Settlement.Order memory takerSell = _vaultOrder(taker, "taker-sell", 0.01e18, 7582234e14, 0, 1);
        Settlement.SignedOrder memory vBuy = _signed(signerKey, vaultBuy);
        Settlement.SignedOrder memory tSell = _signed(takerKey, takerSell);
        vault.lockForOrder(_toVaultOrder(vaultBuy), vBuy.signature);
        vault.lockForOrder(_toVaultOrder(takerSell), tSell.signature);

        Settlement.Fill memory fill = Settlement.Fill({
            makerOrder: tSell,
            takerOrder: vBuy,
            tokenIn: address(btc),
            tokenOut: address(usdt),
            amountIn: 0.01e18,
            amountOut: 7582234e14,
            gasReimburseIn: 0,
            gasReimburseOut: 0
        });
        settlement.settleTrade(fill);

        // 金库：BTC +0.01 − 手续费 0.000001 BTC；USDT −758.2234 − 手续费
        assertEq(vault.balanceOf(address(btc), address(makerVault)), 9999000000000000, "vault got BTC net of fee");
        // NAV：剩余 USDT + BTC 折价 ≈ 1000（减双边手续费与取整）
        uint256 nav = makerVault.totalAssets();
        assertGt(nav, 999e18, "NAV near 1000 after round trip leg");
        assertLt(nav, 1000e18, "NAV reduced by fees");
        assertEq(settlement.getCurrentNonce(address(makerVault)), 1, "vault nonce consumed");
    }

    function testVaultRoundTrip() public {
        _deposit(1000e18);
        // 腿 1：金库买 0.01 BTC（taker 卖 BTC，是 Fill 的 maker；金库是 taker）
        Settlement.Order memory vaultBuy = _vaultOrder(address(makerVault), "vault-buy", 0.01e18, 7582234e14, 0, 0);
        Settlement.Order memory takerSell = _vaultOrder(taker, "taker-sell", 0.01e18, 7582234e14, 0, 1);
        vault.lockForOrder(_toVaultOrder(vaultBuy), _signed(signerKey, vaultBuy).signature);
        vault.lockForOrder(_toVaultOrder(takerSell), _signed(takerKey, takerSell).signature);
        settlement.settleTrade(
            Settlement.Fill({
                makerOrder: _signed(takerKey, takerSell),
                takerOrder: _signed(signerKey, vaultBuy),
                tokenIn: address(btc),
                tokenOut: address(usdt),
                amountIn: 0.01e18,
                amountOut: 7582234e14,
                gasReimburseIn: 0,
                gasReimburseOut: 0
            })
        );
        uint256 navAfterBuy = makerVault.totalAssets();
        // 腿 2：金库卖回实有的 0.009999 BTC（第一腿手续费扣了 0.000001 BTC）：
        // 0.009999 × $75,822.34 = 758.14757766 USDT；taker 用 USDT 买
        usdt.transfer(taker, 1000e18);
        vm.startPrank(taker);
        usdt.approve(address(vault), type(uint256).max);
        vault.deposit(address(usdt), 1000e18);
        vm.stopPrank();
        Settlement.Order memory vaultSell = _vaultOrder(address(makerVault), "vault-sell", 9999000000000000, 758147577660000000000, 1, 1);
        Settlement.Order memory takerBuy = _vaultOrder(taker, "taker-buy", 9999000000000000, 758147577660000000000, 1, 0);
        vault.lockForOrder(_toVaultOrder(vaultSell), _signed(signerKey, vaultSell).signature);
        vault.lockForOrder(_toVaultOrder(takerBuy), _signed(takerKey, takerBuy).signature);
        settlement.settleTrade(
            Settlement.Fill({
                makerOrder: _signed(signerKey, vaultSell),
                takerOrder: _signed(takerKey, takerBuy),
                tokenIn: address(btc),
                tokenOut: address(usdt),
                amountIn: 9999000000000000,
                amountOut: 758147577660000000000,
                gasReimburseIn: 0,
                gasReimburseOut: 0
            })
        );
        // 金库回到全 USDT：241.7766 + (758.14757766 − 手续费 0.075814757766) ≈ 999.8484
        uint256 navAfterSell = makerVault.totalAssets();
        assertEq(vault.balanceOf(address(btc), address(makerVault)), 0, "no BTC left");
        assertGt(navAfterSell, 999.8e18, "NAV after round trip");
        assertLt(navAfterSell, 999.9e18, "NAV reduced by two legs of fees");
        assertLt(navAfterSell, navAfterBuy, "second leg costs another fee");
    }

    // ---------- 签名者管理 ----------

    function testSignerRotation() public {
        Settlement.Order memory o = _vaultOrder(address(makerVault), "v-rot", 0.01e18, 800e18, 0, 0);
        assertTrue(settlement.verifyOrderSignature(o, _sign(signerKey, o)));
        // 撤销旧签名者、登记新签名者
        (address newSigner, uint256 newKey) = makeAddrAndKey("signer2");
        makerVault.setSigner(signerAddr, makerVault.ROLE_MARKET_MAKER(), false);
        makerVault.setSigner(newSigner, makerVault.ROLE_MARKET_MAKER(), true);
        assertFalse(settlement.verifyOrderSignature(o, _sign(signerKey, o)), "revoked signer fails");
        assertTrue(settlement.verifyOrderSignature(o, _sign(newKey, o)), "new signer verifies");
        assertEq(uint256(makerVault.signerRoles(signerAddr)), 0, "role cleared on revoke");
        assertEq(makerVault.signerRoles(newSigner), makerVault.ROLE_MARKET_MAKER(), "role set");
    }

    function testIsValidSignatureDirect() public {
        bytes32 digest = keccak256("x");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(makerVault.isValidSignature(digest, sig), bytes4(0x1626ba7e), "magic value");
        (v, r, s) = vm.sign(strangerKey, digest);
        assertEq(makerVault.isValidSignature(digest, abi.encodePacked(r, s, v)), bytes4(0xffffffff), "stranger fails");
        assertEq(makerVault.isValidSignature(digest, hex"00"), bytes4(0xffffffff), "bad length fails");
    }

    // ---------- 暂停 ----------

    function testPauseBlocksDepositAndSigningNotRedeem() public {
        _deposit(1000e18);
        makerVault.pause();
        vm.prank(depositor);
        vm.expectRevert();
        makerVault.deposit(100e18, depositor);
        Settlement.Order memory o = _vaultOrder(address(makerVault), "v-pause", 0.01e18, 800e18, 0, 0);
        assertFalse(settlement.verifyOrderSignature(o, _sign(signerKey, o)), "signing halted while paused");
        assertEq(makerVault.isValidSignature(settlement.orderDigest(o), _sign(signerKey, o)), bytes4(0xffffffff));
        // 赎回不受暂停影响
        vm.prank(depositor);
        makerVault.redeem(100e18, depositor, depositor);
        assertEq(usdt.balanceOf(depositor), 10_000e18 - 1000e18 + 100e18);
        makerVault.unpause();
        assertTrue(settlement.verifyOrderSignature(o, _sign(signerKey, o)), "signing resumes");
    }

    // ---------- 喂价过期 ----------

    function testStaleFeedFailsClosedOnlyWhenBaseHeld() public {
        _deposit(1000e18);
        // 无 base 库存：喂价过期也不影响 NAV（无需价格输入）
        vm.warp(block.timestamp + 10801);
        assertEq(makerVault.totalAssets(), 1000e18, "no base, no price needed");
        // 有 base 库存：喂价过期时 totalAssets revert
        vm.warp(1_760_000_000);
        feed.setUpdatedAt(block.timestamp);
        btc.transfer(address(makerVault), 0.01e18);
        makerVault.syncToTradingVault(address(btc), 0.01e18);
        vm.warp(block.timestamp + 10801);
        vm.expectRevert("MakerVault: stale price feed");
        makerVault.totalAssets();
        // 喂价恢复后 NAV 恢复
        feed.setUpdatedAt(block.timestamp);
        assertEq(makerVault.totalAssets(), 1758223400000000000000);
    }

    // ---------- owner 不能动存款 ----------

    function testOwnerCannotDrainWithoutShares() public {
        _deposit(1000e18);
        // owner 无份额：赎回 1 wei 即 revert；合约无任何 owner 提款函数（仅 pause/轮换/换 feed）
        vm.expectRevert();
        makerVault.redeem(1, owner, owner);
        vm.expectRevert();
        makerVault.withdraw(1, owner, owner);
    }
}
