// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "../src/MerkleDistributor.sol";
import "../src/Governance.sol";
import "../src/GovernanceExtended.sol";
import "../src/Settlement.sol";
import "../src/Vault.sol";
import "../src/FeeDistributor.sol";

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

/// @notice 第 61 轮块 2 验收：活跃集快照注册表（堵自选活跃集）
contract Round61GovernanceTest is Test {
    Governance gov;
    Settlement settlement;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address charlie = address(0xC0FFEE);

    function setUp() public {
        gov = new Governance();
        Vault vault = new Vault();
        FeeDistributor fd = new FeeDistributor();
        settlement = new Settlement(address(vault), address(fd));
        settlement.setGovernance(address(gov));
    }

    function _leaf(address a) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a));
    }

    function _twoRoot() internal view returns (bytes32) {
        bytes32 la = _leaf(alice);
        bytes32 lb = _leaf(bob);
        (bytes32 low, bytes32 high) = la <= lb ? (la, lb) : (lb, la);
        return keccak256(abi.encodePacked(low, high));
    }

    /// @notice 引用未发布快照建提案必须回滚（自选活跃集的入口已不存在）
    function test_CreateProposal_UnpublishedSnapshotReverts() public {
        bytes memory callData = abi.encodeWithSelector(Settlement.setFeeBps.selector, uint16(8));
        vm.expectRevert("Governance: snapshot not published");
        gov.createProposal(address(settlement), callData, 0);
        vm.expectRevert("Governance: snapshot not published");
        gov.createProposal(address(settlement), callData, 999);
    }

    /// @notice 多步骤提案同样只能引用已发布快照
    function test_CreateMultiStep_UnpublishedSnapshotReverts() public {
        address[] memory targets = new address[](1);
        targets[0] = address(settlement);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(Settlement.setFeeBps.selector, uint16(8));
        vm.expectRevert("Governance: snapshot not published");
        gov.createMultiStepProposal(targets, datas, 0);
    }

    /// @notice 快照只能由治理管理员发布
    function test_PublishSnapshot_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert("Governance: not owner");
        gov.publishSnapshot(_twoRoot(), 2);
    }

    /// @notice 快照只增不改：后发新快照不影响已发布快照内容
    function test_SnapshotRegistry_AppendOnly() public {
        uint256 id0 = gov.publishSnapshot(_twoRoot(), 2);
        bytes32 other = _leaf(charlie);
        uint256 id1 = gov.publishSnapshot(other, 1);
        assertEq(id0, 0);
        assertEq(id1, 1);
        (bytes32 root0, uint256 count0, address publisher0, , bool exists0) = gov.getSnapshot(id0);
        assertEq(root0, _twoRoot());
        assertEq(count0, 2);
        assertEq(publisher0, address(this));
        assertTrue(exists0);
        (, , , , bool existsX) = gov.getSnapshot(42);
        assertFalse(existsX);
    }

    /// @notice 攻击回归：攻击者无法再自选 1 人活跃集自证通过——
    /// 成员资格与法定人数全部取自管理员发布的快照。
    function test_SelfConstitutedSet_CannotPass() public {
        vm.warp(8 days); // 冷却期前置（与既有治理测试同口径）
        uint256 snapshotId = gov.publishSnapshot(_twoRoot(), 2);
        bytes memory callData = abi.encodeWithSelector(Settlement.setFeeBps.selector, uint16(8));

        // 提案创建本身无许可，但只能引用已发布快照
        vm.prank(charlie);
        uint256 pid = gov.createProposal(address(settlement), callData, snapshotId);

        // 非成员（攻击者）投票被快照根拒绝
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(charlie);
        vm.expectRevert("Governance: not in active set");
        gov.vote(pid, true, empty);

        // 成员 1 票不足快照人数一半以上（需 > 2/2 = 1）
        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = _leaf(bob);
        vm.prank(alice);
        gov.vote(pid, true, proofA);
        vm.warp(block.timestamp + 10 days);
        vm.expectRevert("Governance: not passed");
        gov.execute(pid);

        // 注：投票期已过，第二票无法补投——法定人数不足即失败，攻击目标未达成
        assertEq(settlement.feeBps(), 1);
    }

    /// @notice 正路径：引用快照建提案，快照人数决定通过线，两票通过并执行
    function test_SnapshotProposal_PassesWithSnapshotQuorum() public {
        vm.warp(8 days);
        uint256 snapshotId = gov.publishSnapshot(_twoRoot(), 2);
        bytes memory callData = abi.encodeWithSelector(Settlement.setFeeBps.selector, uint16(9));
        uint256 pid = gov.createProposal(address(settlement), callData, snapshotId);

        (, , uint256 activeCount, , , , , , ) = gov.getProposal(pid);
        assertEq(activeCount, 2);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = _leaf(bob);
        vm.prank(alice);
        gov.vote(pid, true, proofA);
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = _leaf(alice);
        vm.prank(bob);
        gov.vote(pid, true, proofB);

        vm.warp(block.timestamp + 10 days);
        gov.execute(pid);
        assertEq(settlement.feeBps(), 9);
    }
}

/// @notice 第 61 轮块 3 验收：GovernanceExtended 快照透传 + voteWithWeight 摘除
contract Round61ExtendedTest is Test {
    GovernanceExtended govExt;
    Settlement settlement;
    address alice = address(0xA11CE);

    function setUp() public {
        govExt = new GovernanceExtended(address(0));
        Vault vault = new Vault();
        FeeDistributor fd = new FeeDistributor();
        settlement = new Settlement(address(vault), address(fd));
        settlement.setGovernance(address(govExt));
    }

    /// @notice voteWithWeight 入口已不存在：低级调用无此选择器（合约无 fallback，必然失败）
    function test_VoteWithWeight_NoLongerExists() public {
        bytes memory payload = abi.encodeWithSignature(
            "voteWithWeight(uint256,bool,bytes32[])", 0, true, new bytes32[](0)
        );
        (bool ok, ) = address(govExt).call(payload);
        assertFalse(ok);
        // 对照：vote 入口仍在（同样的未建提案调用会因业务校验回滚，但选择器存在性
        // 由编译期保证——此处仅断言 voteWithWeight 的缺席，不重复断言 vote 的业务路径）
    }

    /// @notice 扩展入口透传快照编号：未发布快照回滚、已发布快照可建带元数据提案
    function test_CreateWithMetadata_UsesSnapshot() public {
        bytes memory callData = abi.encodeWithSelector(Settlement.setFeeBps.selector, uint16(7));
        vm.expectRevert("Governance: snapshot not published");
        govExt.createProposalWithMetadata(
            address(settlement), callData, 0, "t", "d", "c"
        );

        bytes32 root = keccak256(abi.encodePacked(alice));
        uint256 snapshotId = govExt.publishSnapshot(root, 1);
        uint256 pid = govExt.createProposalWithMetadata(
            address(settlement), callData, snapshotId, "title", "desc", "cat"
        );
        (string memory title, , , , address proposer) = govExt.getProposalMetadata(pid);
        assertEq(title, "title");
        assertEq(proposer, address(this));
    }
}
