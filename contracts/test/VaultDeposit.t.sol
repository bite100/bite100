// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/Vault.sol";
import "../src/mock/MockERC20.sol";

/// @notice 转账扣费代币（fee-on-transfer）：每次 transfer/transferFrom 扣 10%
/// 作为「税」销毁，收款方实收 90%。用于证明 Vault.deposit 的差额记账口径。
contract FeeOnTransferToken is ERC20 {
    uint256 public constant FEE_BPS = 1000; // 10%

    constructor(uint256 initialSupply) ERC20("FeeToken", "FEE") {
        if (initialSupply > 0) {
            _mint(msg.sender, initialSupply);
        }
    }

    function _chargeFee(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_BPS) / 10000;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 fee = _chargeFee(amount);
        super.transfer(to, amount - fee);
        if (fee > 0) _burn(msg.sender, fee);
        // 注意：super.transfer 已从 msg.sender 扣 amount-fee 并发出事件；
        // 这里把 fee 直接从发送方销毁，形成「发送 amount、实收 amount-fee」。
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = _chargeFee(amount);
        super.transferFrom(from, to, amount - fee);
        if (fee > 0) _burn(from, fee);
        return true;
    }
}

/// @title 第 32 轮：Vault.deposit 实际到账记账（余额差额口径）
contract VaultDepositTest is Test {
    Vault vault;
    MockERC20 stdToken;
    FeeOnTransferToken feeToken;

    address user1;

    event Deposit(address indexed user, address indexed token, uint256 amount);

    function setUp() public {
        user1 = makeAddr("user1");
        vault = new Vault();
        stdToken = new MockERC20("StdToken", "STD", 1_000_000e18);
        feeToken = new FeeOnTransferToken(1_000_000e18);
        stdToken.transfer(user1, 10_000e18);
        feeToken.transfer(user1, 10_000e18);
        // 构造器给部署者铸 1,000,000；转给 user1 时又扣 10% 税，
        // user1 实际到账 9,000e18——测试数值按下文回读为准，不假设。
    }

    /// 扣费代币：名义存 1000，Vault 实收 900，按 900 记账与发事件，
    /// 内部账与 Vault 的真实代币余额恒一致。
    function test_FeeToken_DepositCreditsReceivedOnly() public {
        vm.startPrank(user1);
        uint256 userBal = feeToken.balanceOf(user1);
        feeToken.approve(address(vault), 1000e18);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Deposit(user1, address(feeToken), 900e18);
        vault.deposit(address(feeToken), 1000e18);
        vm.stopPrank();

        assertEq(vault.balanceOf(address(feeToken), user1), 900e18, "ledger must equal received");
        assertEq(feeToken.balanceOf(address(vault)), 900e18, "vault real balance must equal ledger");
        assertEq(feeToken.balanceOf(user1), userBal - 1000e18, "sender pays nominal amount");
    }

    /// 扣费代币记账后可按记账额全额提取（提取时代币再扣 10%，用户实收 810，
    /// 但 Vault 内部账与转出额一致，不产生坏账）。
    function test_FeeToken_WithdrawAfterDepositConsistent() public {
        vm.startPrank(user1);
        feeToken.approve(address(vault), 1000e18);
        vault.deposit(address(feeToken), 1000e18);
        assertEq(vault.balanceOf(address(feeToken), user1), 900e18);

        vm.expectRevert(bytes("Vault: insufficient available balance"));
        vault.withdraw(address(feeToken), 901e18);

        uint256 before = feeToken.balanceOf(user1);
        vault.withdraw(address(feeToken), 900e18);
        vm.stopPrank();

        assertEq(vault.balanceOf(address(feeToken), user1), 0);
        assertEq(feeToken.balanceOf(address(vault)), 0, "vault must not retain phantom funds");
        assertEq(feeToken.balanceOf(user1), before + 810e18, "withdrawal itself is taxed 10%");
    }

    /// 标准代币：差额记账下行为与旧版完全一致（实收 = 名义额）。
    function test_StdToken_DepositUnchanged() public {
        vm.startPrank(user1);
        stdToken.approve(address(vault), 1000e18);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Deposit(user1, address(stdToken), 1000e18);
        vault.deposit(address(stdToken), 1000e18);
        vm.stopPrank();

        assertEq(vault.balanceOf(address(stdToken), user1), 1000e18);
        assertEq(stdToken.balanceOf(address(vault)), 1000e18);
    }
}
