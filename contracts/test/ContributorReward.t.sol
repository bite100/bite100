// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/ContributorReward.sol";
import "../src/mock/MockERC20.sol";

contract ContributorRewardTest is Test {
    ContributorReward reward;
    MockERC20 token;

    address owner;
    address alice;
    address bob;
    uint256 aliceKey;
    uint256 bobKey;

    function setUp() public {
        owner = address(this);
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        reward = new ContributorReward();
        token = new MockERC20("Reward", "RWD", 1_000_000e18);
        token.transfer(owner, 1000e18);
    }

    function test_SignatureRecoversToAlice() public {
        bytes32 digest = keccak256(abi.encodePacked(
            "2025-02-01_2025-02-07", uint256(0.95e18), uint256(10), uint256(100), uint256(1e9), uint8(1)
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        address recovered = ecrecover(digest, v, r, s);
        assertEq(recovered, alice, "recovered should be alice");
    }

    function test_SubmitProofAndClaim() public {
        string memory period = "2025-02-01_2025-02-07";
        uint256 uptime = 0.95e18;
        uint256 storageUsedGB = 10;
        uint256 storageTotalGB = 100;
        uint256 bytesRelayed = 1e9;
        uint8 nodeType = 1; // storage

        bytes32 digest = keccak256(abi.encodePacked(
            period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.startPrank(alice);
        reward.submitProof(period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType, sig);
        vm.stopPrank();

        assertEq(reward.getContributionScore(period, alice) > 0, true);
        assertEq(reward.getPeriodTotalScore(period) > 0, true);

        token.approve(address(reward), 100e18);
        reward.setPeriodReward(period, address(token), 100e18);

        uint256 claimableAlice = reward.claimable(period, address(token), alice);
        assertEq(claimableAlice > 0, true);

        vm.prank(alice);
        reward.claimReward(period, address(token));
        assertEq(token.balanceOf(alice), claimableAlice);
    }

    /// @notice 储备比例：可领取额 = 池子 * (10000 - reserveBps) / 10000，储备部分不参与分配
    function test_ReserveBpsReducesClaimable() public {
        reward.setGovernance(address(this));
        reward.setReserveBps(2000); // 20% 储备，可分配 80%

        string memory period = "2025-02-01_2025-02-08";
        bytes32 digest = keccak256(abi.encodePacked(
            period, uint256(1e18), uint256(0), uint256(0), uint256(0), uint8(0)
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        vm.prank(alice);
        reward.submitProof(period, 1e18, 0, 0, 0, 0, abi.encodePacked(r, s, v));

        token.approve(address(reward), 100e18);
        reward.setPeriodReward(period, address(token), 100e18);

        // 仅 Alice 有贡献，总分 = Alice 分数；可分配 = 100 * 80% = 80e18
        uint256 claimableAlice = reward.claimable(period, address(token), alice);
        assertEq(claimableAlice, 80e18, "claimable should be 80% of pool");

        vm.prank(alice);
        reward.claimReward(period, address(token));
        assertEq(token.balanceOf(alice), 80e18);
        assertEq(token.balanceOf(address(reward)), 20e18, "reserve 20% stays in contract");
    }
}
