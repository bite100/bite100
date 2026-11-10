// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "../src/MerkleDistributor.sol";
import "../src/mock/MockERC20.sol";

/// @title 第 61 轮验收测试（治理加固）——OZ MerkleProof 叶子构造回归（整改 F2）
/// @notice 叶子构造【冻结不变】：leaf = keccak256(abi.encodePacked(account))；
/// 父节点 = sorted-pair 哈希（旧自研库算法，逐行复刻于 _oldFold）。
/// 用旧算法构造的 root/proof 必须能被 OZ MerkleProof.verify 通过。
/// 注：本文件内断言不用字符串消息——via_ir 下测试合约内联 forge-std
/// 带消息断言曾触发 Yul 栈溢出（2026-11-10 实测），故保持瘦断言。
contract Round61MerkleTest is Test {
    /// @dev 旧自研 MerkleProof 的折叠算法（逐行复刻，仅用于生成“既有向量”）
    function _oldFold(bytes32 computedHash, bytes32 proofElement) internal pure returns (bytes32) {
        if (computedHash <= proofElement) {
            return keccak256(abi.encodePacked(computedHash, proofElement));
        }
        return keccak256(abi.encodePacked(proofElement, computedHash));
    }

    function _addrLeaves() internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](4);
        leaves[0] = keccak256(abi.encodePacked(address(0xA0)));
        leaves[1] = keccak256(abi.encodePacked(address(0xA1)));
        leaves[2] = keccak256(abi.encodePacked(address(0xA2)));
        leaves[3] = keccak256(abi.encodePacked(address(0xA3)));
    }

    /// @dev 旧算法自底向上折叠求 root
    function _buildRoot(bytes32[] memory level) internal pure returns (bytes32) {
        uint256 n = level.length;
        while (n > 1) {
            uint256 m = 0;
            for (uint256 i = 0; i + 1 < n; i += 2) {
                level[m++] = _oldFold(level[i], level[i + 1]);
            }
            if (n % 2 == 1) level[m++] = level[n - 1];
            n = m;
        }
        return level[0];
    }

    /// @dev 旧算法下成员 idx 的兄弟路径
    function _proofFor(bytes32[] memory level, uint256 idx) internal pure returns (bytes32[] memory) {
        uint256 n = level.length;
        uint256 depth = 0;
        while (n > 1) {
            depth++;
            n = (n + 1) / 2;
        }
        bytes32[] memory proof = new bytes32[](depth);
        n = level.length;
        uint256 d = 0;
        while (n > 1) {
            uint256 sib = idx % 2 == 0 ? idx + 1 : idx - 1;
            proof[d++] = sib < n ? level[sib] : level[idx];
            bytes32[] memory next = new bytes32[]((n + 1) / 2);
            uint256 m = 0;
            for (uint256 i = 0; i + 1 < n; i += 2) {
                next[m++] = _oldFold(level[i], level[i + 1]);
            }
            if (n % 2 == 1) next[m++] = level[n - 1];
            level = next;
            n = m;
            idx /= 2;
        }
        return proof;
    }

    function test_OZMerkleProof_AcceptsLegacyLeafConstruction() public pure {
        bytes32 root = _buildRoot(_addrLeaves());
        bytes32[] memory leaves = _addrLeaves();
        assertTrue(MerkleProof.verify(_proofFor(_addrLeaves(), 0), root, leaves[0]));
        assertTrue(MerkleProof.verify(_proofFor(_addrLeaves(), 3), root, leaves[3]));
        bytes32 stranger = keccak256(abi.encodePacked(address(0xEE)));
        assertFalse(MerkleProof.verify(_proofFor(_addrLeaves(), 0), root, stranger));
    }
}


/// @notice MerkleDistributor 旧构造叶子回归（独立合约，分散 via_ir 内联压力）
contract Round61DistributorTest is Test {
    MockERC20 internal token;
    MerkleDistributor internal dist;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    bytes32 internal leafA;
    bytes32 internal leafB;

    function _fold(bytes32 computedHash, bytes32 proofElement) internal pure returns (bytes32) {
        if (computedHash <= proofElement) {
            return keccak256(abi.encodePacked(computedHash, proofElement));
        }
        return keccak256(abi.encodePacked(proofElement, computedHash));
    }

    function setUp() public {
        token = new MockERC20("Dist", "DST", 1000e18);
        dist = new MerkleDistributor(address(token));
        // MerkleDistributor 叶子构造（冻结不变）：keccak256(abi.encodePacked(index, account, amount))
        leafA = keccak256(abi.encodePacked(uint256(0), alice, uint256(100e18)));
        leafB = keccak256(abi.encodePacked(uint256(1), bob, uint256(200e18)));
        dist.setMerkleRoot(_fold(leafA, leafB), 300e18);
        token.transfer(address(dist), 300e18);
    }

    function test_MerkleDistributor_LegacyTreeClaimAlice() public {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafB;
        vm.prank(alice);
        dist.claim(0, alice, 100e18, proof);
        assertEq(token.balanceOf(alice), 100e18);
    }

    function test_MerkleDistributor_LegacyTreeClaimBob() public {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafA;
        vm.prank(bob);
        dist.claim(1, bob, 200e18, proof);
        assertEq(token.balanceOf(bob), 200e18);
    }
}
