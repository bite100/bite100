// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/WrappedTKA.sol";
import "../src/mock/MockERC20.sol";

/// @notice 第十九轮胶水合约 WrappedTKA 的行为测试：
///         1:1 铸赎、CCIP 管理员钩子、MINTER_ROLE 门控（CCIP 池 / NTT Manager 用）、
///         ERC20Burnable 公开 burn（NTT burning 模式用）。
contract WrappedTKATest is Test {
    MockERC20 internal tka;
    WrappedTKA internal wtka;
    address internal admin = address(0xA11CE);
    address internal user = address(0xB0B);
    address internal pool = address(0x9001);
    address internal stranger = address(0x57AA);

    function setUp() public {
        tka = new MockERC20("Token A", "TKA", 0);
        wtka = new WrappedTKA(address(tka), admin);
        tka.mint(user, 1_000 ether);
    }

    function test_getCCIPAdmin() public view {
        assertEq(wtka.getCCIPAdmin(), admin);
    }

    function test_wrap_mintsOneToOne_andLocksReserve() public {
        vm.startPrank(user);
        tka.approve(address(wtka), 100 ether);
        wtka.wrap(100 ether);
        vm.stopPrank();

        assertEq(wtka.balanceOf(user), 100 ether);
        assertEq(wtka.reserve(), 100 ether);
        assertEq(tka.balanceOf(user), 900 ether);
    }

    function test_wrap_withoutApproval_reverts() public {
        vm.prank(user);
        vm.expectRevert();
        wtka.wrap(1 ether);
    }

    function test_unwrap_redeemsOneToOne() public {
        vm.startPrank(user);
        tka.approve(address(wtka), 100 ether);
        wtka.wrap(100 ether);
        wtka.unwrap(40 ether);
        vm.stopPrank();

        assertEq(wtka.balanceOf(user), 60 ether);
        assertEq(tka.balanceOf(user), 940 ether);
        assertEq(wtka.reserve(), 60 ether);
    }

    function test_unwrap_moreThanBalance_reverts() public {
        vm.prank(user);
        vm.expectRevert();
        wtka.unwrap(1 ether);
    }

    function test_mint_requiresMinterRole() public {
        vm.prank(stranger);
        vm.expectRevert();
        wtka.mint(user, 1 ether);
    }

    function test_grantMintAndBurnRoles_enablesPoolMint() public {
        vm.prank(admin);
        wtka.grantMintAndBurnRoles(pool);

        vm.prank(pool);
        wtka.mint(user, 25 ether);
        assertEq(wtka.balanceOf(user), 25 ether);

        // 桥铸出的 wTKA 同样可 unwrap 赎回（储备需先行注资，与跨链到账语义一致：
        // 对端销毁后本端铸造，储备由对端锁定量在账面上对应——本测试直接验证接口面）
        vm.prank(admin);
        wtka.revokeMintAndBurnRoles(pool);
        vm.prank(pool);
        vm.expectRevert();
        wtka.mint(user, 1 ether);
    }

    function test_grantRoles_requiresAdmin() public {
        vm.prank(stranger);
        vm.expectRevert();
        wtka.grantMintAndBurnRoles(pool);
    }

    function test_publicBurn_forNttBurningMode() public {
        // NTT Manager 在 burning 模式先 transferFrom 到自身，再以自身身份调 burn()
        vm.startPrank(user);
        tka.approve(address(wtka), 10 ether);
        wtka.wrap(10 ether);
        wtka.transfer(pool, 10 ether);
        vm.stopPrank();

        vm.prank(pool);
        wtka.burn(10 ether);
        assertEq(wtka.balanceOf(pool), 0);
        assertEq(wtka.totalSupply(), 0);
    }
}
