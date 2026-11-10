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

    // 第 61 轮计量人（按线分权注册；密钥与被计量账户分离）
    address relayMeasurer;
    uint256 relayMeasurerKey;
    address postingMeasurer;
    uint256 postingMeasurerKey;
    address submitterMeasurer;
    uint256 submitterMeasurerKey;
    address gasMeasurer;
    uint256 gasMeasurerKey;
    uint256 nonceSeq;
    bytes32 internal constant EVIDENCE = bytes32(uint256(0xE17DE7CE));

    function setUp() public {
        owner = address(this);
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        (relayMeasurer, relayMeasurerKey) = makeAddrAndKey("relayMeasurer");
        (postingMeasurer, postingMeasurerKey) = makeAddrAndKey("postingMeasurer");
        (submitterMeasurer, submitterMeasurerKey) = makeAddrAndKey("submitterMeasurer");
        (gasMeasurer, gasMeasurerKey) = makeAddrAndKey("gasMeasurer");
        reward = new ContributorReward();
        reward.setMeasurer(0, relayMeasurer, true);
        reward.setMeasurer(1, postingMeasurer, true);
        reward.setMeasurer(2, submitterMeasurer, true);
        reward.setMeasurer(3, gasMeasurer, true);
        token = new MockERC20("Reward", "RWD", 1_000_000e18);
        token.transfer(owner, 1000e18);
    }

    function _measurerKeyFor(uint8 nodeType) internal view returns (uint256) {
        if (nodeType == 0) return relayMeasurerKey;
        if (nodeType == 1) return postingMeasurerKey;
        if (nodeType == 2) return submitterMeasurerKey;
        return gasMeasurerKey;
    }

    /// @notice 由对应线的注册计量人签发 EIP-712 计量证明并提交（提交者 = 测试合约，与签名者分离）
    function _attestAndSubmit(
        string memory period,
        address account,
        uint256 uptime,
        uint256 postingMetric,
        uint256 storageTotalGB,
        uint256 bytesRelayed,
        uint8 nodeType
    ) internal {
        bytes32 pid = keccak256(abi.encodePacked(period));
        uint256 nonce = ++nonceSeq;
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest = reward.metricAttestationDigest(
            account, pid, nodeType, uptime, postingMetric, storageTotalGB, bytesRelayed, 0, 0, EVIDENCE, nonce, deadline
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_measurerKeyFor(nodeType), digest);
        reward.submitProof(period, account, uptime, postingMetric, storageTotalGB, bytesRelayed, nodeType, EVIDENCE, nonce, deadline, abi.encodePacked(r, s, v));
    }

    /// @notice 以指定 nodeType、uptime=1e18、无附加计量提交一期证明（计量人签发）
    /// （四线等基准夹具：各线 base 同为 SCALE，分数应只由定版权重决定；
    ///   第 61 轮起 key 参数废弃——签名者恒为该线注册计量人，保留形参仅为少改调用点）
    function _submitBareProof(string memory period, uint256, address who, uint8 nodeType) internal {
        _attestAndSubmit(period, who, 1e18, 0, 0, 0, nodeType);
    }

    /// @notice gas 库存款证明（submitLiquidityProof，metricType=3 线计量人签发）
    function _submitGasVaultProof(string memory period, uint256, address who, uint256 amount) internal {
        bytes32 pid = keccak256(abi.encodePacked(period));
        uint256 nonce = ++nonceSeq;
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest = reward.liquidityAttestationDigest(who, pid, amount, EVIDENCE, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(gasMeasurerKey, digest);
        reward.submitLiquidityProof(period, who, amount, EVIDENCE, nonce, deadline, abi.encodePacked(r, s, v));
    }

    /// @notice 中继线（nodeType=0、uptime=1e18）证明，中继线计量人签发
    function _submitRelayProof(string memory period, uint256, address who) internal {
        _attestAndSubmit(period, who, 1e18, 0, 0, 0, 0);
    }

    /// @notice 反复领取直到 claimable 归零（单次受奖池 10% 上限）
    function _drainClaims(string memory period, address who) internal {
        for (uint256 i = 0; i < 30; i++) {
            if (reward.claimable(period, address(token), who) == 0) break;
            vm.prank(who);
            reward.claimReward(period, address(token));
        }
    }

    /// @notice 第 61 轮：计量证明摘要（EIP-712）由计量人签名后可恢复出计量人地址
    function test_AttestationDigestRecoversMeasurer() public view {
        bytes32 pid = keccak256(abi.encodePacked("2025-02-01_2025-02-07"));
        bytes32 digest = reward.metricAttestationDigest(
            alice, pid, 1, 0.95e18, 10, 100, 1e9, 0, 0, EVIDENCE, 1, block.timestamp + 1 days
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(postingMeasurerKey, digest);
        address recovered = ecrecover(digest, v, r, s);
        assertEq(recovered, postingMeasurer, "recovered should be the posting measurer");
    }

    function test_SubmitProofAndClaim() public {
        string memory period = "2025-02-01_2025-02-07";
        uint256 uptime = 0.95e18;
        uint256 storageUsedGB = 10;
        uint256 storageTotalGB = 100;
        uint256 bytesRelayed = 1e9;
        uint8 nodeType = 1; // storage

        _attestAndSubmit(period, alice, uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType);

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
        // Alice 与 Bob 同为中继线、同分，各应得可分配额的一半
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

    /// @notice 定版权重（第 42 轮）：四线等基准（base 同为 SCALE、无附加计量）时，
    /// 分数应恰为 35/25/20/20 的比例——挂单（nodeType=1）35、gas 库存款（nodeType=3）25、
    /// 中继（nodeType=0）20、结算提交（nodeType=2）20。存款线的等基准同池
    /// 分配断言见 test_FinalWeightsFourLineDistribution。
    function test_WeightsFinalVersionRatios() public {
        string memory period = "2026-11-02_2026-11-15";
        (address poster, uint256 posterKey) = makeAddrAndKey("poster");
        (address relayer, uint256 relayerKey) = makeAddrAndKey("relayer");
        (address submitter, uint256 submitterKey) = makeAddrAndKey("submitter");

        _submitBareProof(period, posterKey, poster, 1); // 挂单
        _submitBareProof(period, relayerKey, relayer, 0); // 中继
        _submitBareProof(period, submitterKey, submitter, 2); // 结算提交

        // base 均为 SCALE：分数 = SCALE * weight
        assertEq(reward.getContributionScore(period, poster), 35e18, "posting weight 35");
        assertEq(reward.getContributionScore(period, relayer), 20e18, "relay weight 20");
        assertEq(reward.getContributionScore(period, submitter), 20e18, "submitter weight 20");
        assertEq(reward.getPeriodTotalScore(period), 75e18);
    }

    /// @notice 定版权重 + 尺度对齐（第 42 轮）：四人各居一线、等基准同池分配，
    /// 待领总额应按 35:25:20:20 分配可分配额（池 100e18、储备 15% → 可分配 85e18）。
    /// gas 库存款 amount 取 CAP_LIQUIDITY 使 part 封顶 SCALE、base=2*SCALE，
    /// 与其余三线不同——为使四线 base 可比，本测试改用 amount=0 不可（函数拒零），
    /// 故单独校验存款线分数公式：score = (SCALE + part) * 25。
    function test_GasVaultScoreScaleAligned() public {
        string memory period = "2026-11-02_2026-11-15";
        (address depositor, uint256 depositorKey) = makeAddrAndKey("depositor");

        // amount = CAP/2 → part = SCALE/2 → score = 1.5e18 * 25 = 37.5e18
        _submitGasVaultProof(period, depositorKey, depositor, 50000e18);
        assertEq(reward.getContributionScore(period, depositor), 37.5e18, "gas vault score = (1 + 0.5) * 25 SCALE");

        // amount = CAP → part 封顶 SCALE → score = 2e18 * 25 = 50e18
        _submitGasVaultProof(period, depositorKey, depositor, 100000e18);
        assertEq(reward.getContributionScore(period, depositor), 50e18, "gas vault score capped part");
    }

    /// @notice 定版权重同池分配断言：四线各一人、等基准（base 同为 SCALE）同池时，
    /// 待领总额恰按 35:25:20:20 分配可分配额。存款线 amount=1 wei 时
    /// part = 1 * SCALE / CAP_LIQUIDITY 经整除为 0，base 恰为 SCALE，与其余三线可比。
    function test_FinalWeightsFourLineDistribution() public {
        string memory period = "2026-11-16_2026-11-29";
        (address poster, uint256 posterKey) = makeAddrAndKey("poster");
        (address depositor, uint256 depositorKey) = makeAddrAndKey("depositor");
        (address relayer, uint256 relayerKey) = makeAddrAndKey("relayer");
        (address submitter, uint256 submitterKey) = makeAddrAndKey("submitter");

        _submitBareProof(period, posterKey, poster, 1); // 35e18
        _submitGasVaultProof(period, depositorKey, depositor, 1); // 25e18（part 整除为 0）
        _submitBareProof(period, relayerKey, relayer, 0); // 20e18
        _submitBareProof(period, submitterKey, submitter, 2); // 20e18
        assertEq(reward.getPeriodTotalScore(period), 100e18, "total score = 100 SCALE");

        token.approve(address(reward), 100e18);
        reward.setPeriodReward(period, address(token), 100e18); // 可分配 85e18

        assertEq(reward.claimableTotal(period, address(token), poster), 29.75e18, "posting 35%");
        assertEq(reward.claimableTotal(period, address(token), depositor), 21.25e18, "gas vault 25%");
        assertEq(reward.claimableTotal(period, address(token), relayer), 17e18, "relay 20%");
        assertEq(reward.claimableTotal(period, address(token), submitter), 17e18, "submitter 20%");
    }

    /// @notice 挂单线计量入口：postingMetric 按 CAP_POSTING 归一化进分（base + part）* 35
    function test_PostingMetricNormalized() public {
        string memory period = "2026-11-16_2026-11-29";
        (address poster, uint256 posterKey) = makeAddrAndKey("poster");
        // uptime=1e18、postingMetric=CAP/2 → part=SCALE/2 → score = 1.5e18 * 35
        _attestAndSubmit(period, poster, 1e18, 5e23, 0, 0, 1);
        assertEq(reward.getContributionScore(period, poster), 52.5e18, "posting score = 1.5 * 35 SCALE");
    }
}
