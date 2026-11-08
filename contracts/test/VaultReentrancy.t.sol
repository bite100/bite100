// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/Vault.sol";

/// @notice 恶意回调代币：在 transferFrom / transfer 执行期间回调
/// Vault.deposit 尝试重入记账。attackMode：0=关闭；1=transferFrom（存入
/// 回调）中重入 deposit；2=transfer（Vault 出金回调）中重入 deposit
/// （跨函数重入）。重入结果记录在 reentryAttempts / lastReentrySucceeded，
/// 供测试断言「攻击确实发生、且确实被守卫挡住」——若无守卫，内层 deposit
/// 会真实走完（代币合约已自备资金与自授权，见 selfApproveVault），外层
/// 随后会把内层转入也算作自己的实收，造成重复记账。
contract ReentrantToken is ERC20 {
    Vault public vault;
    uint8 public attackMode;
    uint256 public reentryAttempts;
    bool public lastReentrySucceeded;

    constructor(uint256 initialSupply) ERC20("ReentrantToken", "RENT") {
        if (initialSupply > 0) {
            _mint(msg.sender, initialSupply);
        }
    }

    function setVault(Vault _vault) external {
        vault = _vault;
    }

    function setAttackMode(uint8 mode) external {
        attackMode = mode;
    }

    /// @notice 代币合约给自己对 Vault 的无限授权：使重入 deposit 若未被
    /// 守卫挡住，能真实走完 transferFrom 并记账——证明测试打中的是守卫
    /// 本身，而不是「重入因缺授权/缺余额失败」这类假阴性。
    function selfApproveVault() external {
        _approve(address(this), address(vault), type(uint256).max);
    }

    function _tryReenter(uint256 amount) internal {
        reentryAttempts++;
        try vault.deposit(address(this), amount) {
            lastReentrySucceeded = true;
        } catch {
            lastReentrySucceeded = false;
        }
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amount);
        if (ok && attackMode == 1 && to == address(vault)) {
            _tryReenter(amount);
        }
        return ok;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool ok = super.transfer(to, amount);
        if (ok && attackMode == 2 && msg.sender == address(vault)) {
            _tryReenter(amount);
        }
        return ok;
    }
}

/// @title 第 33 轮：Vault 重入保护（ChatGPT 复审 N1）
contract VaultReentrancyTest is Test {
    Vault vault;
    ReentrantToken token;
    address user;

    function setUp() public {
        user = makeAddr("user");
        vault = new Vault();
        token = new ReentrantToken(1_000_000e18);
        token.setVault(vault);
        token.transfer(user, 10_000e18);
        // 代币合约自有资金：重入 deposit 的「弹药」
        token.transfer(address(token), 5_000e18);
        token.selfApproveVault();
    }

    /// 攻击路径：用户存 1000 → transferFrom 回调重入 deposit(1000)。
    /// 无守卫时：内层实收 1000 记给代币合约，外层把总差额 2000 记给用户，
    /// 账面合计 3000 > 实际持仓 2000。有守卫时：内层被挡，外层精确记 1000。
    function test_Deposit_ReentryBlocked_NoDoubleCredit() public {
        token.setAttackMode(1);
        vm.startPrank(user);
        token.approve(address(vault), 1000e18);
        vault.deposit(address(token), 1000e18);
        vm.stopPrank();

        assertEq(token.reentryAttempts(), 1, "attack must have been attempted");
        assertFalse(token.lastReentrySucceeded(), "reentry must be blocked by the guard");
        assertEq(vault.balanceOf(address(token), user), 1000e18, "outer deposit credited exactly once");
        assertEq(vault.balanceOf(address(token), address(token)), 0, "reentrant deposit credited nothing");
        assertEq(token.balanceOf(address(vault)), 1000e18, "vault holds exactly the outer inflow");
        assertEq(token.balanceOf(address(token)), 5_000e18, "token contract funds untouched");
    }

    /// 跨函数路径：用户提取 1000 → Vault 出金 transfer 回调重入 deposit。
    /// deposit 与 withdraw 共用同一重入锁，回调期内的存入同样被挡。
    function test_Withdraw_ReentryIntoDepositBlocked() public {
        vm.startPrank(user);
        token.approve(address(vault), 1000e18);
        vault.deposit(address(token), 1000e18);
        vm.stopPrank();

        token.setAttackMode(2);
        vm.prank(user);
        vault.withdraw(address(token), 1000e18);

        assertEq(token.reentryAttempts(), 1, "attack must have been attempted");
        assertFalse(token.lastReentrySucceeded(), "cross-function reentry must be blocked");
        assertEq(vault.balanceOf(address(token), user), 0);
        assertEq(vault.balanceOf(address(token), address(token)), 0);
        assertEq(token.balanceOf(address(vault)), 0, "vault paid out exactly the withdrawal");
        assertEq(token.balanceOf(user), 10_000e18, "user received the full withdrawal");
    }

    /// 未武装时（普通代币行为）：存取流程与账实一致，守卫不误伤正常路径。
    function test_UnarmedToken_NormalFlowsUnaffected() public {
        vm.startPrank(user);
        token.approve(address(vault), 1000e18);
        vault.deposit(address(token), 1000e18);
        assertEq(vault.balanceOf(address(token), user), 1000e18);
        vault.withdraw(address(token), 400e18);
        vm.stopPrank();

        assertEq(vault.balanceOf(address(token), user), 600e18);
        assertEq(token.balanceOf(address(vault)), 600e18);
        assertEq(token.reentryAttempts(), 0);
    }
}
