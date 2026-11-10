// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GasVault, IGasPriceSource, IWrappedNative} from "../src/GasVault.sol";

/// @dev WETH9 形态的包装原生币替身：deposit 1:1 铸、withdraw 1:1 赎回原生币
contract MockWrappedNative is ERC20, IWrappedNative {
    constructor() ERC20("Wrapped Native", "WN") {}

    function deposit() external payable override {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external override {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "MockWN: native transfer failed");
    }

    receive() external payable {}
}

contract MockToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev 可设价的参考价源替身（生产中只许指向已准入价格面）
contract MockPriceSource is IGasPriceSource {
    mapping(address => uint256) public prices;

    function setPrice(address token, uint256 priceE18) external {
        prices[token] = priceE18;
    }

    function referencePrice(address token) external view override returns (uint256) {
        return prices[token];
    }
}

/// @dev 聚合器替身：按设定费率把 tokenIn 换成资产付回调用者（费率可调，用来
///      把到手推到熔断线上下两侧）。真实链路是 LI.FI/1inch 的 calldata，本替身
///      只复刻「transferFrom 输入 + 按率付资产」的资金形状。
contract MockRouter {
    IWrappedNative public immutable asset;
    uint256 public outPerInE18; // 每 1e18 输入换得的资产（wei）

    constructor(IWrappedNative _asset, uint256 _outPerInE18) {
        asset = _asset;
        outPerInE18 = _outPerInE18;
    }

    function setRate(uint256 _outPerInE18) external {
        outPerInE18 = _outPerInE18;
    }

    function swap(address tokenIn, uint256 amountIn) external returns (uint256 out) {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        out = (amountIn * outPerInE18) / 1e18;
        asset.transfer(msg.sender, out);
    }
}

contract GasVaultTest is Test {
    MockWrappedNative wn;
    MockToken feeToken; // 库存成交币替身
    MockPriceSource priceSource;
    MockRouter router;
    GasVault vault;

    address depositor = makeAddr("depositor");
    address beneficiary = makeAddr("beneficiary");
    address anyone = makeAddr("anyone");

    uint256 measurerKey = 0xA11CE;
    address measurer;

    function setUp() public {
        wn = new MockWrappedNative();
        feeToken = new MockToken("Fee Token", "FEE");
        priceSource = new MockPriceSource();
        router = new MockRouter(wn, 1e18); // 默认 1:1
        vault = new GasVault(wn, "Bit100 Gas Vault WN", "gvWN", address(0), address(this));
        measurer = vm.addr(measurerKey);
        vault.setMeasurer(4, measurer, true); // METRIC_TYPE_SHORTFALL = 4
        vm.deal(depositor, 1000 ether);
        vm.deal(anyone, 1000 ether);
        vm.deal(address(this), 1000 ether);
        // 路由备好资产库存（模拟聚合器流动性）
        wn.deposit{value: 500 ether}();
        wn.transfer(address(router), 500 ether);
    }

    // ---------- 工具 ----------
    function _wrapDeposit(address who, uint256 amount) internal returns (uint256 shares) {
        vm.startPrank(who);
        wn.deposit{value: amount}();
        wn.approve(address(vault), amount);
        shares = vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _signShortfall(bytes32 claimId, address bene, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = vault.shortfallAttestationDigest(claimId, bene, amount, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(measurerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// 换汇场景基线：目标 10 ether、警戒 40%（=4）、价源 FEE=2 ether/枚、
    /// 上限 100 ether、间隔 60s、粉尘 0.5 ether；库内备 10 枚 FEE 库存。
    function _conversionSetup() internal {
        vault.setTargetFloat(10 ether);
        vault.setPriceSource(priceSource);
        priceSource.setPrice(address(feeToken), 2 ether);
        vault.setConversionLimits(100 ether, 60, 0.5 ether);
        vault.setRouter(address(router), true);
        feeToken.mint(address(vault), 10 ether);
    }

    function _swapCalldata(uint256 amountIn) internal view returns (bytes memory) {
        return abi.encodeWithSelector(MockRouter.swap.selector, address(feeToken), amountIn);
    }

    // ================================================================
    // 组 1：存款/提款/份额记账（含原生币形态计入与提款自动打包）
    // ================================================================

    function test_Group1_DepositWithdrawBasic() public {
        uint256 shares = _wrapDeposit(depositor, 10 ether);
        assertEq(shares, 10 ether); // 首存 1:1（OZ 虚拟份额口径下精确）
        assertEq(vault.totalAssets(), 10 ether);
        vm.prank(depositor);
        vault.withdraw(4 ether, depositor, depositor);
        assertEq(wn.balanceOf(depositor), 4 ether);
        assertEq(vault.totalAssets(), 6 ether);
        assertEq(vault.balanceOf(depositor), 6 ether);
    }

    function test_Group1_NativeFloatCountsInTotalAssets() public {
        _wrapDeposit(depositor, 10 ether);
        vm.prank(anyone);
        vault.fundFloat{value: 5 ether}();
        assertEq(vault.totalAssets(), 15 ether); // 浮存是池资产的一种形态
        assertEq(address(vault).balance, 5 ether);
    }

    function test_Group1_WithdrawAutoWrapsNativeFloat() public {
        _wrapDeposit(depositor, 10 ether);
        vm.prank(anyone);
        vault.fundFloat{value: 8 ether}();
        // 总资产 18（资产形态 10 + 原生形态 8），唯一存款人的 10 份额全额可提 18；
        // 提 12 时资产形态只有 10，必须自动把 2 原生包回资产形态支付
        vm.prank(depositor);
        vault.withdraw(12 ether, depositor, depositor);
        assertEq(wn.balanceOf(depositor), 12 ether);
        assertEq(vault.totalAssets(), 6 ether);
        assertEq(address(vault).balance, 6 ether); // 8 - 2 被包走
    }

    // ================================================================
    // 组 2：水位触发门（警戒线之上不许换、未设目标不许换）
    // ================================================================

    function test_Group2_BlockedAboveWatermark() public {
        _conversionSetup();
        vm.prank(anyone);
        vault.fundFloat{value: 4 ether}(); // 恰达警戒线 4：条件是 < 警戒线，不含等号
        vm.expectRevert("GasVault: float above watermark");
        vault.triggerConversion(address(feeToken), 1 ether, address(router), _swapCalldata(1 ether), 0);
    }

    function test_Group2_BlockedWhenTargetUnset() public {
        // 不设 targetFloat：警戒线为 0，原生余额恒不低于 0 → 永不触发（出厂安全态）
        vault.setPriceSource(priceSource);
        priceSource.setPrice(address(feeToken), 2 ether);
        vault.setConversionLimits(100 ether, 0, 0);
        vault.setRouter(address(router), true);
        feeToken.mint(address(vault), 10 ether);
        vm.expectRevert("GasVault: float above watermark");
        vault.triggerConversion(address(feeToken), 1 ether, address(router), _swapCalldata(1 ether), 0);
    }

    function test_Group2_PassesBelowWatermarkAndRefillsFloat() public {
        _conversionSetup();
        vm.prank(anyone);
        vault.fundFloat{value: 3.9 ether}(); // 警戒线 4 之下
        uint256 nativeBefore = address(vault).balance;
        // 1 FEE 按价源值 2 ether，路由 1:1 口径下 outPerIn=2e18 才对齐估值——
        // 替身费率直接设为「按价源全额」：out = 1 * 2 = 2 ether
        router.setRate(2e18);
        vault.triggerConversion(address(feeToken), 1 ether, address(router), _swapCalldata(1 ether), 0);
        assertEq(feeToken.balanceOf(address(vault)), 9 ether);
        // 换回的 2 ether 已解包补进原生浮存
        assertEq(address(vault).balance, nativeBefore + 2 ether);
        assertEq(vault.lastConversionAt(), block.timestamp);
    }

    // ================================================================
    // 组 3：97% 熔断（合约自算，调用者 minOut 只能加严）
    // ================================================================

    function test_Group3_FuseRevertsAt96Percent() public {
        _conversionSetup();
        router.setRate(1.92 ether); // 估值 2 ether 的 96%
        vm.expectRevert("GasVault: received below fuse");
        vault.triggerConversion(address(feeToken), 1 ether, address(router), _swapCalldata(1 ether), 0);
        // 整笔回滚：库存不动
        assertEq(feeToken.balanceOf(address(vault)), 10 ether);
    }

    function test_Group3_FusePassesAt98Percent() public {
        _conversionSetup();
        router.setRate(1.96 ether); // 估值 2 ether 的 98%
        vault.triggerConversion(address(feeToken), 1 ether, address(router), _swapCalldata(1 ether), 0);
        assertEq(feeToken.balanceOf(address(vault)), 9 ether);
    }

    function test_Group3_CallerMinOutStricterThanFuse() public {
        _conversionSetup();
        router.setRate(1.96 ether); // 98%：过合约熔断（97%），低于调用者 minOut（99%）
        vm.expectRevert("GasVault: received below fuse");
        vault.triggerConversion(
            address(feeToken), 1 ether, address(router), _swapCalldata(1 ether), 1.98 ether
        );
    }

    // ================================================================
    // 组 4：单次上限 / 最小间隔 / 粉尘门槛 / 路由白名单
    // ================================================================

    function test_Group4_DustBelowThresholdReverts() public {
        _conversionSetup();
        // 0.1 FEE 估值 0.2 ether < 粉尘门槛 0.5 ether
        vm.expectRevert("GasVault: below dust threshold");
        vault.triggerConversion(address(feeToken), 0.1 ether, address(router), _swapCalldata(0.1 ether), 0);
    }

    function test_Group4_CapExceededReverts() public {
        _conversionSetup();
        vault.setConversionLimits(5 ether, 60, 0.5 ether); // 上限降到 5 ether 估值
        // 3 FEE 估值 6 ether > 上限
        vm.expectRevert("GasVault: exceeds per-call cap");
        vault.triggerConversion(address(feeToken), 3 ether, address(router), _swapCalldata(3 ether), 0);
    }

    function test_Group4_MinIntervalEnforced() public {
        _conversionSetup();
        router.setRate(2e18);
        vault.triggerConversion(address(feeToken), 1 ether, address(router), _swapCalldata(1 ether), 0);
        vm.expectRevert("GasVault: conversion too soon");
        vault.triggerConversion(address(feeToken), 1 ether, address(router), _swapCalldata(1 ether), 0);
        vm.warp(block.timestamp + 61);
        vault.triggerConversion(address(feeToken), 1 ether, address(router), _swapCalldata(1 ether), 0);
    }

    function test_Group4_RouterWhitelistAndTokenGuards() public {
        _conversionSetup();
        address rogue = makeAddr("rogueRouter");
        vm.expectRevert("GasVault: router not whitelisted");
        vault.triggerConversion(address(feeToken), 1 ether, rogue, _swapCalldata(1 ether), 0);
        // tokenIn = 资产本身不许（资产形态转换走解包，不走换汇）
        vm.expectRevert("GasVault: invalid tokenIn");
        vault.triggerConversion(address(wn), 1 ether, address(router), _swapCalldata(1 ether), 0);
    }

    // ================================================================
    // 组 5：短缺吸收（计量人证明：验签 / 防重放 / 过期 / 池封顶）
    // ================================================================

    function test_Group5_AbsorbPaysBeneficiary() public {
        _wrapDeposit(depositor, 20 ether);
        bytes32 claimId = keccak256("claim-1");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signShortfall(claimId, beneficiary, 3 ether, 1, deadline);
        vault.absorbShortfall(claimId, beneficiary, 3 ether, 1, deadline, sig);
        assertEq(wn.balanceOf(beneficiary), 3 ether);
        assertEq(vault.totalAssets(), 17 ether);
    }

    function test_Group5_AbsorbReplayReverts() public {
        _wrapDeposit(depositor, 20 ether);
        bytes32 claimId = keccak256("claim-2");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signShortfall(claimId, beneficiary, 1 ether, 7, deadline);
        vault.absorbShortfall(claimId, beneficiary, 1 ether, 7, deadline, sig);
        vm.expectRevert("GasVault: attestation replayed");
        vault.absorbShortfall(claimId, beneficiary, 1 ether, 7, deadline, sig);
    }

    function test_Group5_AbsorbUnregisteredMeasurerReverts() public {
        _wrapDeposit(depositor, 20 ether);
        bytes32 claimId = keccak256("claim-3");
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest = vault.shortfallAttestationDigest(claimId, beneficiary, 1 ether, 1, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBEEF, digest); // 未注册密钥
        vm.expectRevert("GasVault: unregistered measurer");
        vault.absorbShortfall(claimId, beneficiary, 1 ether, 1, deadline, abi.encodePacked(r, s, v));
    }

    function test_Group5_AbsorbExpiredAndExceedsPool() public {
        _wrapDeposit(depositor, 5 ether);
        bytes32 claimId = keccak256("claim-4");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signShortfall(claimId, beneficiary, 1 ether, 1, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert("GasVault: attestation expired");
        vault.absorbShortfall(claimId, beneficiary, 1 ether, 1, deadline, sig);
    }

    function test_Group5_AbsorbExceedsPoolReverts() public {
        _wrapDeposit(depositor, 5 ether);
        bytes32 claimId = keccak256("claim-5");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signShortfall(claimId, beneficiary, 6 ether, 1, deadline);
        vm.expectRevert("GasVault: shortfall exceeds pool");
        vault.absorbShortfall(claimId, beneficiary, 6 ether, 1, deadline, sig);
    }

    // ================================================================
    // 组 6：管理员面与暂停语义（只停存入；参数仅 owner；形态 A 记账口关闭）
    // ================================================================

    function test_Group6_PauseBlocksDepositNotWithdraw() public {
        _wrapDeposit(depositor, 10 ether);
        vault.pause();
        vm.startPrank(depositor);
        wn.deposit{value: 1 ether}();
        wn.approve(address(vault), 1 ether);
        vm.expectRevert();
        vault.deposit(1 ether, depositor);
        // 提款不受暂停影响（存款人退出权是出厂口径）
        vault.withdraw(5 ether, depositor, depositor);
        vm.stopPrank();
        assertEq(wn.balanceOf(depositor), 1 ether + 5 ether);
        vault.unpause();
        _wrapDeposit(depositor, 1 ether);
    }

    function test_Group6_NonOwnerCannotSetParams() public {
        vm.startPrank(anyone);
        vm.expectRevert();
        vault.setTargetFloat(1 ether);
        vm.expectRevert();
        vault.setRouter(address(router), true);
        vm.expectRevert();
        vault.setMeasurer(4, anyone, true);
        vm.expectRevert();
        vault.pause();
        vm.stopPrank();
    }

    function test_Group6_CreditRecoveredFormAClosed() public {
        // 本轮部署 settlement = 零地址：形状冻结但入口关闭（形态 B 是主网门决策）
        vm.expectRevert("GasVault: form A - settlement not wired");
        vault.creditRecovered(address(feeToken), 1 ether, 2 ether);
    }

    function test_Group6_NoFundMovingAdminEntry() public {
        // 法①出厂检查：合约不存在任何 owner 提款类入口（未知选择器恒回滚）
        (bool ok1, ) = address(vault).call(
            abi.encodeWithSignature("emergencyWithdraw(address)", address(this))
        );
        assertFalse(ok1);
        (bool ok2, ) = address(vault).call(
            abi.encodeWithSignature("transferOut(address,uint256)", address(wn), 1 ether)
        );
        assertFalse(ok2);
    }
}
