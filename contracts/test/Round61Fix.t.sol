// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/ContributorReward.sol";
import "../src/mock/MockERC20.sol";

/// @title 第 61 轮审查修复批验收（P1-01：领取须冻结；P2-01：存款线禁走通用入口）
/// @notice 断言不用字符串消息（via_ir 栈深教训，同 Round61.t.sol 口径）；
/// 每个测试合约只装一组回归，分散内联压力。
contract Round61FixClaimTest is Test {
ContributorReward reward;
MockERC20 token;
address alice;
address bob;
address relayMeasurer;
uint256 relayMeasurerKey;
bytes32 internal constant EVIDENCE = bytes32(uint256(0xE17DE7CE));
string internal constant PERIOD = "2026-11-30_2026-12-13";

function setUp() public {
(alice,) = makeAddrAndKey("alice");
(bob,) = makeAddrAndKey("bob");
(relayMeasurer, relayMeasurerKey) = makeAddrAndKey("relayMeasurer");
reward = new ContributorReward();
reward.setMeasurer(0, relayMeasurer, true);
token = new MockERC20("Reward", "RWD", 1000e18);
}

/// @dev 中继线计量人签发 MetricAttestation 并提交（uptime 可变，供纠错场景改分）
function _attestRelay(address account, uint256 uptime, uint256 nonce) internal {
bytes32 pid = keccak256(abi.encodePacked(PERIOD));
uint256 deadline = block.timestamp + 1 days;
bytes32 digest = reward.metricAttestationDigest(
account, pid, 0, uptime, 0, 0, 0, 0, 0, EVIDENCE, nonce, deadline
);
(uint8 v, bytes32 r, bytes32 s) = vm.sign(relayMeasurerKey, digest);
reward.submitProof(PERIOD, account, uptime, 0, 0, 0, 0, EVIDENCE, nonce, deadline, abi.encodePacked(r, s, v));
}

function _fund() internal {
token.approve(address(reward), 100e18);
reward.setPeriodReward(PERIOD, address(token), 100e18);
}

function _drain(address who) internal {
for (uint256 i = 0; i < 30; i++) {
if (reward.claimable(PERIOD, address(token), who) == 0) break;
vm.prank(who);
reward.claimReward(PERIOD, address(token));
}
}

/// @notice P1-01 回归：未冻结周期领取回滚，且两个领取视图口径一致归零
function test_ClaimBeforeFreezeReverts() public {
_attestRelay(alice, 1e18, 1);
_fund();
assertEq(reward.claimable(PERIOD, address(token), alice), 0);
assertEq(reward.claimableTotal(PERIOD, address(token), alice), 0);
vm.prank(alice);
vm.expectRevert("ContributorReward: period not frozen");
reward.claimReward(PERIOD, address(token));
}

/// @notice P1-01 正路径：证明 → 冻结 → 领取，按冻结份额足额发放
function test_AttestFreezeClaim_PaysFrozenShare() public {
_attestRelay(alice, 1e18, 1);
_attestRelay(bob, 1e18, 2);
_fund();
reward.freezePeriod(PERIOD, bytes32(uint256(0xF20E)));
// 两人同分：可分配 85e18 各半 = 42.5e18
assertEq(reward.claimableTotal(PERIOD, address(token), alice), 42.5e18);
_drain(alice);
assertEq(token.balanceOf(alice), 42.5e18);
assertEq(reward.claimableTotal(PERIOD, address(token), alice), 0);
assertEq(reward.claimableTotal(PERIOD, address(token), bob), 42.5e18);
}

/// @notice P1-01 回归：领取尝试（回滚、无副作用）之后、冻结之前的纠错决定冻结
/// 份额；冻结后任何改分尝试回滚，已冻结应得不被事后纠错改动
function test_CorrectionBeforeFreeze_GovernsFrozenEntitlement() public {
_attestRelay(alice, 1e18, 1); // 20e18
_attestRelay(bob, 1e18, 2); // 20e18
_fund();

// 先尝试领取：未冻结回滚，不产生任何已领记账
vm.prank(alice);
vm.expectRevert("ContributorReward: period not frozen");
reward.claimReward(PERIOD, address(token));

// 纠错（新 nonce 覆盖）：alice 分数 20e18 → 10e18，总量 40e18 → 30e18
_attestRelay(alice, 0.5e18, 3);
assertEq(reward.getContributionScore(PERIOD, alice), 10e18);
assertEq(reward.getPeriodTotalScore(PERIOD), 30e18);

reward.freezePeriod(PERIOD, bytes32(uint256(0xF20E)));
// 期望值由冻结时状态推导：可分配 85e18 × 个人分 / 冻结总量（30e18）
uint256 expected = (85e18 * reward.getContributionScore(PERIOD, alice)) / reward.getPeriodTotalScore(PERIOD);
assertEq(reward.claimableTotal(PERIOD, address(token), alice), expected);

// 冻结后再纠错 → 回滚；应得保持冻结值
bytes32 pid = keccak256(abi.encodePacked(PERIOD));
uint256 deadline = block.timestamp + 1 days;
bytes32 digest = reward.metricAttestationDigest(
alice, pid, 0, 1e18, 0, 0, 0, 0, 0, EVIDENCE, 4, deadline
);
(uint8 v, bytes32 r, bytes32 s) = vm.sign(relayMeasurerKey, digest);
vm.expectRevert("ContributorReward: period frozen");
reward.submitProof(PERIOD, alice, 1e18, 0, 0, 0, 0, EVIDENCE, 4, deadline, abi.encodePacked(r, s, v));
assertEq(reward.claimableTotal(PERIOD, address(token), alice), expected);

_drain(alice);
assertEq(token.balanceOf(alice), expected);
}
}

/// @notice P2-01 回归：gas 库存款线（nodeType==3）禁走通用入口，只认专用存款证明
contract Round61FixLiquidityLineTest is Test {
ContributorReward reward;
address alice;
address gasMeasurer;
uint256 gasMeasurerKey;
bytes32 internal constant EVIDENCE = bytes32(uint256(0xE17DE7CE));
string internal constant PERIOD = "2026-11-30_2026-12-13";

function setUp() public {
(alice,) = makeAddrAndKey("alice");
(gasMeasurer, gasMeasurerKey) = makeAddrAndKey("gasMeasurer");
reward = new ContributorReward();
reward.setMeasurer(3, gasMeasurer, true);
}

/// @dev 由 3 线注册计量人签发一份MetricAttestation（metricType=3）：
/// 修复前该证明可经通用入口按 uptime 占位口径取得存款线分数
function _signMetricType3(uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
bytes32 pid = keccak256(abi.encodePacked(PERIOD));
bytes32 digest = reward.metricAttestationDigest(
alice, pid, 3, 1e18, 0, 0, 0, 0, 0, EVIDENCE, nonce, deadline
);
(uint8 v, bytes32 r, bytes32 s) = vm.sign(gasMeasurerKey, digest);
return abi.encodePacked(r, s, v);
}

function test_SubmitProof_NodeType3Reverts() public {
uint256 deadline = block.timestamp + 1 days;
bytes memory sig = _signMetricType3(1, deadline);
vm.expectRevert("ContributorReward: liquidity line only");
reward.submitProof(PERIOD, alice, 1e18, 0, 0, 0, 3, EVIDENCE, 1, deadline, sig);
assertEq(reward.getContributionScore(PERIOD, alice), 0);
}

function test_SubmitProofEx_NodeType3Reverts() public {
uint256 deadline = block.timestamp + 1 days;
bytes memory sig = _signMetricType3(1, deadline);
vm.expectRevert("ContributorReward: liquidity line only");
reward.submitProofEx(PERIOD, alice, 1e18, 0, 0, 0, 0, 0, 3, EVIDENCE, 1, deadline, sig);
assertEq(reward.getContributionScore(PERIOD, alice), 0);
}

/// @notice 专用入口不受影响：LiquidityAttestation（金额绑定）照常计分
function test_SubmitLiquidityProof_StillWorks() public {
bytes32 pid = keccak256(abi.encodePacked(PERIOD));
uint256 deadline = block.timestamp + 1 days;
bytes32 digest = reward.liquidityAttestationDigest(alice, pid, 100e18, EVIDENCE, 1, deadline);
(uint8 v, bytes32 r, bytes32 s) = vm.sign(gasMeasurerKey, digest);
reward.submitLiquidityProof(PERIOD, alice, 100e18, EVIDENCE, 1, deadline, abi.encodePacked(r, s, v));
// score = (SCALE + 100e18 * SCALE / CAP_LIQUIDITY) * 25 = (1e18 + 1e15) * 25
assertEq(reward.getContributionScore(PERIOD, alice), 25.025e18);
}
}
