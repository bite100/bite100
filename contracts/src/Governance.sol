// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./MerkleProof.sol";

/// @title Governance 治理合约
/// @notice 按「最近 2 周内有贡献的地址」定义活跃集，同意超过 50% 即通过。任意链上可执行操作均可提案（手续费、上币、流通链等）。
contract Governance {
    uint256 public constant VOTING_PERIOD = 7 days;
    uint256 public constant COOLDOWN_PERIOD = 7 days; // 同一提案执行后一周内不可再创建相同提案
    uint256 public constant ACTIVE_WEEKS = 2;

    struct Proposal {
        address target;
        bytes callData;
        bytes32 merkleRoot;
        uint256 activeCount;
        uint256 createdAt;
        uint256 votingEndsAt;
        uint256 yesCount;
        uint256 noCount;
        bool executed;
    }

    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(bytes32 => uint256) public lastExecutedAt; // proposalHash => 执行时间，同一 (target, callData) 一周冷却
    uint256 public proposalCount;
    address public owner;

    event ProposalCreated(uint256 indexed proposalId, address target, uint256 activeCount);
    event Voted(uint256 indexed proposalId, address indexed voter, bool support);
    event ProposalExecuted(uint256 indexed proposalId);

    modifier onlyOwner() {
        require(msg.sender == owner, "Governance: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice 创建提案；任意 (target, callData) 均可，如手续费、上币、流通链等
    function createProposal(
        address target,
        bytes calldata callData,
        bytes32 merkleRoot,
        uint256 activeCount
    ) external returns (uint256 proposalId) {
        require(target != address(0), "Governance: zero target");
        require(merkleRoot != bytes32(0), "Governance: zero root");
        require(activeCount > 0, "Governance: zero active");

        bytes32 proposalHash = keccak256(abi.encode(target, callData));
        require(
            block.timestamp >= lastExecutedAt[proposalHash] + COOLDOWN_PERIOD,
            "Governance: cooldown"
        );

        proposalId = proposalCount++;
        proposals[proposalId] = Proposal({
            target: target,
            callData: callData,
            merkleRoot: merkleRoot,
            activeCount: activeCount,
            createdAt: block.timestamp,
            votingEndsAt: block.timestamp + VOTING_PERIOD,
            yesCount: 0,
            noCount: 0,
            executed: false
        });

        emit ProposalCreated(proposalId, target, activeCount);
    }

    /// @notice 投票；voter 需提供默克尔证明以证明在活跃集内
    function vote(
        uint256 proposalId,
        bool support,
        bytes32[] calldata proof
    ) external {
        Proposal storage p = proposals[proposalId];
        require(block.timestamp < p.votingEndsAt, "Governance: voting ended");
        require(!hasVoted[proposalId][msg.sender], "Governance: already voted");

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender));
        require(MerkleProof.verify(proof, p.merkleRoot, leaf), "Governance: not in active set");

        hasVoted[proposalId][msg.sender] = true;
        if (support) {
            p.yesCount++;
        } else {
            p.noCount++;
        }

        emit Voted(proposalId, msg.sender, support);
    }

    /// @notice 执行提案；通过条件：yesCount > activeCount / 2
    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(block.timestamp >= p.votingEndsAt, "Governance: voting not ended");
        require(!p.executed, "Governance: already executed");
        require(p.yesCount > p.activeCount / 2, "Governance: not passed");

        p.executed = true;
        bytes32 proposalHash = keccak256(abi.encode(p.target, p.callData));
        lastExecutedAt[proposalHash] = block.timestamp;

        (bool ok,) = p.target.call(p.callData);
        require(ok, "Governance: execute failed");

        emit ProposalExecuted(proposalId);
    }

    function getProposal(uint256 proposalId) external view returns (
        address target,
        bytes memory callData,
        uint256 activeCount,
        uint256 createdAt,
        uint256 votingEndsAt,
        uint256 yesCount,
        uint256 noCount,
        bool executed
    ) {
        Proposal storage p = proposals[proposalId];
        return (
            p.target,
            p.callData,
            p.activeCount,
            p.createdAt,
            p.votingEndsAt,
            p.yesCount,
            p.noCount,
            p.executed
        );
    }

    function isInActiveSet(uint256 proposalId, address account, bytes32[] calldata proof) external view returns (bool) {
        bytes32 leaf = keccak256(abi.encodePacked(account));
        return MerkleProof.verify(proof, proposals[proposalId].merkleRoot, leaf);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Governance: zero address");
        owner = newOwner;
    }
}
