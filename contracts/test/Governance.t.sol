// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/Governance.sol";
import "../src/Settlement.sol";
import "../src/ContributorReward.sol";
import "../src/Vault.sol";
import "../src/FeeDistributor.sol";
import "../src/AMMPool.sol";
import "../src/mock/MockERC20.sol";

contract GovernanceTest is Test {
    Governance gov;
    Settlement settlement;
    ContributorReward reward;
    AMMPool pool;

    address owner;
    address alice;
    address bob;

    function setUp() public {
        owner = address(this);
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        gov = new Governance();
        Vault vault = new Vault();
        FeeDistributor fd = new FeeDistributor();
        settlement = new Settlement(address(vault), address(fd));
        reward = new ContributorReward();
        MockERC20 t0 = new MockERC20("T0", "T0", 1e24);
        MockERC20 t1 = new MockERC20("T1", "T1", 1e24);
        pool = new AMMPool(address(t0), address(t1), address(fd));

        settlement.setGovernance(address(gov));
        pool.setGovernance(address(gov));
        reward.setGovernance(address(gov));
    }

    function test_CreateAndExecuteProposal() public {
        vm.warp(8 days); // 满足同一提案冷却期（lastExecutedAt 初值为 0，需 >= 7 天）
        // Create proposal: set Settlement feeBps to 8
        bytes memory callData = abi.encodeWithSelector(Settlement.setFeeBps.selector, uint16(8));
        bytes32 root = _singleAddressRoot(alice);
        uint256 pid = gov.createProposal(
            address(settlement),
            callData,
            root,
            1 // activeCount
        );

        assertEq(settlement.feeBps(), 1);

        // Alice votes yes
        bytes32[] memory proof = _singleAddressProof(alice);
        vm.prank(alice);
        gov.vote(pid, true, proof);

        (, , , , , uint256 yes, uint256 no, ) = gov.getProposal(pid);
        assertEq(yes, 1);
        assertEq(no, 0);

        // Fast forward past voting period
        vm.warp(block.timestamp + 8 days);

        gov.execute(pid);

        assertEq(settlement.feeBps(), 8);
    }

    /// @dev 两地址默克尔树，与 node/cmd/merkletool 一致：叶子 keccak256(abi.encodePacked(addr))，排序后父节点 hash(min, max)
    function test_TwoAddressMerkleMatchesMerkletool() public {
        bytes32 leafA = keccak256(abi.encodePacked(alice));
        bytes32 leafB = keccak256(abi.encodePacked(bob));
        (bytes32 low, bytes32 high) = leafA <= leafB ? (leafA, leafB) : (leafB, leafA);
        bytes32 root = keccak256(abi.encodePacked(low, high));

        vm.warp(8 days);
        bytes memory callData = abi.encodeWithSelector(Settlement.setFeeBps.selector, uint16(10));
        uint256 pid = gov.createProposal(address(settlement), callData, root, 2);

        // Alice 的 proof：兄弟节点是 Bob 的叶子
        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        vm.prank(alice);
        gov.vote(pid, true, proofA);

        // Bob 的 proof：兄弟节点是 Alice 的叶子
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = leafA;
        vm.prank(bob);
        gov.vote(pid, true, proofB);

        (, , , , , uint256 yes, , ) = gov.getProposal(pid);
        assertEq(yes, 2);

        vm.warp(block.timestamp + 8 days);
        gov.execute(pid);
        assertEq(settlement.feeBps(), 10);
    }

    function _singleAddressRoot(address a) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a)); // single-leaf: root = leaf
    }

    function _singleAddressProof(address) internal pure returns (bytes32[] memory) {
        return new bytes32[](0); // single-leaf tree has empty proof
    }
}
