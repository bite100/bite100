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

    /// @notice 以 relay 节点（nodeType=0、uptime=1e18）身份为 signer 提交一期证明，返回签名者地址
    function _submitRelayProof(string memory period, uint256 key, address who) internal {
        bytes32 digest = keccak256(abi.encodePacked(
            period, uint256(1e18), uint256(0), uint256(0), uint256(0), uint8(0)
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        vm.prank(who);
        reward.submitProof(period, 1e18, 0, 0, 0, 0, abi.encodePacked(r, s, v));
    }

    /// @notice 反复领取直到 claimable 归零（单次受奖池 10% 上限）
    function _drainClaims(string memory period, address who) internal {
        for (uint256 i = 0; i < 30; i++) {
            if (reward.claimable(period, address(token), who) == 0) break;
            vm.prank(who);
            reward.claimReward(period, address(token));
        }
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

        // 方案 A：claimable 为单次可领（受奖池 10% 上限）：池 100e18 → 单次 10e18；
        // 待领总额 = 可分配 85%（默认储备 15%）= 85e18
        uint256 claimableAlice = reward.claimable(period, address(token), alice);
        assertEq(claimableAlice, 10e18);
        assertEq(reward.claimableTotal(period, address(token), alice), 85e18);

        vm.prank(alice);
        reward.claimReward(period, address(token));
        assertEq(token.balanceOf(alice), claimableAlice);

        // 多次领取直至领完应得部分
        _drainClaims(period, alice);
        assertEq(token.balanceOf(alice), 85e18);
        assertEq(reward.claimable(period, address(token), alice), 0);
        assertEq(reward.claimableTotal(period, address(token), alice), 0);
    }

    /// @notice 单次领取上限 = 奖池 10%（方案 A 保留）：应得 85e18 时单笔只发 10e18
    function test_ClaimCappedAtTenPercent() public {
        string memory period = "2025-02-01_2025-02-07";
        _submitRelayProof(period, aliceKey, alice);

        token.approve(address(reward), 100e18);
        reward.setPeriodReward(period, address(token), 100e18);

        vm.prank(alice);
        reward.claimReward(period, address(token));
        assertEq(token.balanceOf(alice), 10e18, "single claim must be capped at 10% of pool");
        assertEq(reward.claimable(period, address(token), alice), 10e18, "next tranche available");
        assertEq(reward.claimableTotal(period, address(token), alice), 75e18);
    }

    /// @notice 储备比例：可分配额 = 池子 * (10000 - reserveBps) / 10000，储备部分不参与分配
    function test_ReserveBpsReducesClaimable() public {
        reward.setGovernance(address(this));
        reward.setReserveBps(2000); // 20% 储备，可分配 80%

        string memory period = "2025-02-01_2025-02-08";
        _submitRelayProof(period, aliceKey, alice);

        token.approve(address(reward), 100e18);
        reward.setPeriodReward(period, address(token), 100e18);

        // 仅 Alice 有贡献：待领总额 = 100 * 80% = 80e18；单次可领受 10% 上限 = 10e18
        assertEq(reward.claimableTotal(period, address(token), alice), 80e18, "total should be 80% of pool");
        assertEq(reward.claimable(period, address(token), alice), 10e18, "per-claim capped at 10% of pool");

        _drainClaims(period, alice);
        assertEq(token.balanceOf(alice), 80e18);
        assertEq(token.balanceOf(address(reward)), 20e18, "reserve 20% stays in contract");
    }

    /// @notice 领取期限（方案 A）：周期结束后 90 天内可领；越过截止 claimable/claimableTotal 归零且 claim revert
    function test_ClaimDeadlinePassed() public {
        string memory period = "2025-02-01_2025-02-07";
        _submitRelayProof(period, aliceKey, alice);

        token.approve(address(reward), type(uint256).max);
        reward.setPeriodReward(period, address(token), 100e18);

        bytes32 pid = keccak256(abi.encodePacked(period));
        // 周期结束日 2025-02-07 23:59:59 UTC
        uint256 periodEnd = 1738972799; // 2025-02-07 23:59:59 UTC
        reward.setPeriodEndTimestamp(pid, periodEnd);

        vm.warp(periodEnd + 1); // 刚结束，90 天窗口内
        assertGt(reward.claimable(period, address(token), alice), 0);
        vm.prank(alice);
        reward.claimReward(period, address(token));
        assertEq(token.balanceOf(alice), 10e18); // 单次上限 10%

        // 再设一个周期，不领取，验证 90 天边界
        string memory period2 = "2025-01-25_2025-01-31";
        _submitRelayProof(period2, aliceKey, alice);
        reward.setPeriodReward(period2, address(token), 100e18);
        bytes32 pid2 = keccak256(abi.encodePacked(period2));
        uint256 period2End = 1738367999; // 2025-01-31 23:59:59 UTC
        reward.setPeriodEndTimestamp(pid2, period2End);

        vm.warp(period2End + 90 days); // 恰在截止时刻：仍可领
        assertGt(reward.claimable(period2, address(token), alice), 0);

        vm.warp(period2End + 90 days + 1); // 越过截止
        assertEq(reward.claimable(period2, address(token), alice), 0);
        assertEq(reward.claimableTotal(period2, address(token), alice), 0);
        vm.prank(alice);
        vm.expectRevert("ContributorReward: claim deadline passed");
        reward.claimReward(period2, address(token));
    }

    /// @notice 回流前置条件：领取窗未结束时不可回流
    function test_RolloverBeforeDeadlineReverts() public {
        string memory period = "2025-02-01_2025-02-07";
        string memory nextPeriod = "2025-02-08_2025-02-14";
        _submitRelayProof(period, aliceKey, alice);
        token.approve(address(reward), 100e18);
        reward.setPeriodReward(period, address(token), 100e18);
        bytes32 pid = keccak256(abi.encodePacked(period));
        reward.setPeriodEndTimestamp(pid, 1738972799);

        vm.warp(1738972799 + 30 days); // 90 天窗口内
        vm.expectRevert("ContributorReward: claim window not ended");
        reward.rolloverUnclaimed(period, nextPeriod, address(token));
    }

    /// @notice 回流（方案 A）：逾期未领部分（可分配额 − 已领）进入下一期奖池，且可在下一期领取
    function test_RolloverUnclaimedToNextPeriod() public {
        string memory period = "2025-02-01_2025-02-07";
        string memory nextPeriod = "2025-02-08_2025-02-14";
        // Alice 与 Bob 同分（各 15e18），各应得可分配额的一半
        _submitRelayProof(period, aliceKey, alice);
        _submitRelayProof(period, bobKey, bob);

        token.approve(address(reward), type(uint256).max);
        reward.setPeriodReward(period, address(token), 100e18); // 可分配 85e18，各 42.5e18

        // Alice 领两次（2 × 10e18 上限），Bob 一次不领
        vm.prank(alice);
        reward.claimReward(period, address(token));
        vm.prank(alice);
        reward.claimReward(period, address(token));
        assertEq(token.balanceOf(alice), 20e18);
        bytes32 pid = keccak256(abi.encodePacked(period));
        assertEq(reward.periodTotalClaimed(pid, address(token)), 20e18);

        // 下一期先注入 50e18
        reward.setPeriodReward(nextPeriod, address(token), 50e18);
        bytes32 pid2 = keccak256(abi.encodePacked(nextPeriod));

        // 设结束时间并越过 90 天领取窗
        reward.setPeriodEndTimestamp(pid, 1738972799);
        vm.warp(1738972799 + 90 days + 1);

        // 逾期后 Bob 在原周期不可领
        vm.prank(bob);
        vm.expectRevert("ContributorReward: claim deadline passed");
        reward.claimReward(period, address(token));

        // 回流：未领 = 85 − 20 = 65e18
        uint256 rolled = reward.rolloverUnclaimed(period, nextPeriod, address(token));
        assertEq(rolled, 65e18);
        // 原周期账面 = 储备 15 + 已领 20 = 35e18；下一期 = 50 + 65 = 115e18
        assertEq(reward.periodReward(pid, address(token)), 35e18);
        assertEq(reward.periodReward(pid2, address(token)), 115e18);
        assertTrue(reward.unclaimedRolledOver(pid, address(token)));
        // 原周期 claimable 归零
        assertEq(reward.claimable(period, address(token), bob), 0);
        assertEq(reward.claimableTotal(period, address(token), bob), 0);

        // 重复回流被拒
        vm.expectRevert("ContributorReward: already rolled over");
        reward.rolloverUnclaimed(period, nextPeriod, address(token));

        // Bob 在下一期提交贡献后，可领到含回流金额的奖池：待领总额 = 115 * 85% = 97.75e18，单次上限 = 115/10 = 11.5e18
        _submitRelayProof(nextPeriod, bobKey, bob);
        assertEq(reward.claimableTotal(nextPeriod, address(token), bob), 97.75e18);
        assertEq(reward.claimable(nextPeriod, address(token), bob), 11.5e18);
        vm.prank(bob);
        reward.claimReward(nextPeriod, address(token));
        assertEq(token.balanceOf(bob), 11.5e18);
    }
}
