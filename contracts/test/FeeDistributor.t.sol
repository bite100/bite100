// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/FeeDistributor.sol";
import "../src/mock/MockERC20.sol";

/// @title FeeDistributor 单元测试
/// @notice 覆盖 receiveFee、setRecipients、claim、governance 提案设置分成
contract FeeDistributorTest is Test {
    FeeDistributor fd;
    MockERC20 token;

    address owner;
    address alice;
    address bob;
    address dev;

    function setUp() public {
        owner = address(this);
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        dev = makeAddr("dev");

        fd = new FeeDistributor();
        token = new MockERC20("T", "T", 1_000_000e18);
        // token 构造时已有 1_000_000e18 给 owner，receiveFee 由 transferFrom 转入
    }

    function test_ReceiveFee_NoDeveloper() public {
        token.approve(address(fd), 1000e18);
        fd.receiveFee(address(token), 100e18);

        assertEq(token.balanceOf(address(fd)), 100e18);
        assertEq(fd.accumulated(address(token)), 100e18);
    }

    function test_ReceiveFee_WithDeveloper_Auto1Percent() public {
        fd.setDeveloperAddress(dev);
        token.approve(address(fd), 1000e18);

        fd.receiveFee(address(token), 100e18);
        // 1% = 1e18 给 dev，99e18 进 accumulated
        assertEq(token.balanceOf(dev), 1e18);
        assertEq(token.balanceOf(address(fd)), 99e18);
        assertEq(fd.accumulated(address(token)), 99e18);
    }

    function test_SetRecipients_Owner() public {
        address[] memory accounts = new address[](2);
        accounts[0] = alice;
        accounts[1] = bob;
        uint16[] memory shareBps = new uint16[](2);
        shareBps[0] = 6000;
        shareBps[1] = 4000;

        fd.setRecipients(accounts, shareBps);

        (address r0Account, uint16 r0Share) = fd.recipients(0);
        assertEq(r0Account, alice);
        assertEq(r0Share, 6000);
        (address r1Account, uint16 r1Share) = fd.recipients(1);
        assertEq(r1Account, bob);
        assertEq(r1Share, 4000);
        assertEq(fd.totalShareBps(), 10000);
    }

    function test_SetRecipients_Governance() public {
        address gov = makeAddr("gov");
        fd.setGovernance(gov);

        address[] memory accounts = new address[](1);
        accounts[0] = alice;
        uint16[] memory shareBps = new uint16[](1);
        shareBps[0] = 10000;

        vm.prank(gov);
        fd.setRecipients(accounts, shareBps);

        (address g0Account, uint16 g0Share) = fd.recipients(0);
        assertEq(g0Account, alice);
        assertEq(g0Share, 10000);
    }

    function test_SetRecipients_RevertNotAuth() public {
        address[] memory accounts = new address[](1);
        accounts[0] = alice;
        uint16[] memory shareBps = new uint16[](1);
        shareBps[0] = 10000;

        vm.prank(alice);
        vm.expectRevert("FeeDistributor: not auth");
        fd.setRecipients(accounts, shareBps);
    }

    function test_SetRecipients_ShareOverflow_WithDeveloper() public {
        fd.setDeveloperAddress(dev);
        // 开发者 1%，其余最多 99%
        address[] memory accounts = new address[](1);
        accounts[0] = alice;
        uint16[] memory shareBps = new uint16[](1);
        shareBps[0] = 10000; // 100% 超过 99%

        vm.expectRevert("FeeDistributor: share overflow");
        fd.setRecipients(accounts, shareBps);
    }

    function test_Claim_AndClaimable() public {
        address[] memory accounts = new address[](2);
        accounts[0] = alice;
        accounts[1] = bob;
        uint16[] memory shareBps = new uint16[](2);
        shareBps[0] = 6000;
        shareBps[1] = 4000;
        fd.setRecipients(accounts, shareBps);

        token.approve(address(fd), 1000e18);
        fd.receiveFee(address(token), 100e18);

        assertEq(fd.claimable(address(token), alice), 60e18);
        assertEq(fd.claimable(address(token), bob), 40e18);

        vm.prank(alice);
        fd.claim(address(token));

        assertEq(token.balanceOf(alice), 60e18);
        assertEq(fd.claimable(address(token), alice), 0);

        vm.prank(bob);
        fd.claim(address(token));

        assertEq(token.balanceOf(bob), 40e18);
    }

    function test_Claim_RevertNotRecipient() public {
        address[] memory accounts = new address[](1);
        accounts[0] = alice;
        uint16[] memory shareBps = new uint16[](1);
        shareBps[0] = 10000;
        fd.setRecipients(accounts, shareBps);

        token.approve(address(fd), 1000e18);
        fd.receiveFee(address(token), 100e18);

        vm.prank(bob);
        vm.expectRevert("FeeDistributor: not recipient");
        fd.claim(address(token));
    }

    function test_SetDeveloperAddress_Governance() public {
        address gov = makeAddr("gov");
        fd.setGovernance(gov);

        vm.prank(gov);
        fd.setDeveloperAddress(dev);

        assertEq(fd.developerAddress(), dev);
    }

    function test_TransferOwnership() public {
        fd.transferOwnership(alice);
        assertEq(fd.owner(), alice);

        vm.prank(owner);
        vm.expectRevert("FeeDistributor: not auth");
        fd.setRecipients(new address[](0), new uint16[](0));
    }

    function test_DeveloperShare_DefaultIs1Percent() public {
        // 默认 100 bps = 1%，与改动前常量行为一致
        assertEq(fd.developerShareBps(), 100);
        assertEq(fd.MAX_DEVELOPER_SHARE_BPS(), 500);
    }

    function test_SetDeveloperShareBps_3Percent() public {
        fd.setDeveloperAddress(dev);
        fd.setDeveloperShareBps(300); // 3%

        token.approve(address(fd), 1000e18);
        fd.receiveFee(address(token), 100e18);

        // 3% = 3e18 给 dev，97e18 进 accumulated
        assertEq(token.balanceOf(dev), 3e18);
        assertEq(token.balanceOf(address(fd)), 97e18);
        assertEq(fd.accumulated(address(token)), 97e18);
    }

    function test_SetDeveloperShareBps_Zero() public {
        fd.setDeveloperAddress(dev);
        fd.setDeveloperShareBps(0);

        token.approve(address(fd), 1000e18);
        fd.receiveFee(address(token), 100e18);

        assertEq(token.balanceOf(dev), 0);
        assertEq(token.balanceOf(address(fd)), 100e18);
        assertEq(fd.accumulated(address(token)), 100e18);
    }

    function test_SetDeveloperShareBps_MaxBoundary() public {
        fd.setDeveloperShareBps(500); // 5% 上限，允许
        assertEq(fd.developerShareBps(), 500);
    }

    function test_SetDeveloperShareBps_RevertOverCap() public {
        vm.expectRevert("FeeDistributor: share too high");
        fd.setDeveloperShareBps(501);
    }

    function test_SetDeveloperShareBps_RevertNotAuth() public {
        vm.prank(alice);
        vm.expectRevert("FeeDistributor: not auth");
        fd.setDeveloperShareBps(200);
    }

    function test_SetDeveloperShareBps_Governance() public {
        address gov = makeAddr("gov");
        fd.setGovernance(gov);

        vm.prank(gov);
        fd.setDeveloperShareBps(200);

        assertEq(fd.developerShareBps(), 200);
    }

    function test_ReceiveFee_RevertInvalidInput() public {
        token.approve(address(fd), 100e18);

        vm.expectRevert("FeeDistributor: invalid input");
        fd.receiveFee(address(0), 100e18);

        vm.expectRevert("FeeDistributor: invalid input");
        fd.receiveFee(address(token), 0);
    }
}
