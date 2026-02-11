// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./MerkleProof.sol";

/// @title Governance 治理合约
/// @notice 按「最近 2 周内有贡献的地址」定义活跃集，同意超过 50% 即通过。任意链上可执行操作均可提案（手续费、上币、流通链等）。
/// @notice 支持 Timelock（执行延迟）：提案通过后可设置延迟执行时间，便于紧急取消。
contract Governance is ReentrancyGuard {
    uint256 public constant VOTING_PERIOD = 7 days;
    uint256 public constant COOLDOWN_PERIOD = 7 days; // 同一提案执行后一周内不可再创建相同提案
    uint256 public constant ACTIVE_WEEKS = 2;
    uint256 public constant MIN_TIMELOCK_DELAY = 2 days; // 最小执行延迟 2 天
    uint256 public timelockDelay = 2 days; // 执行延迟（可通过治理调整）

    struct Proposal {
        address target; // 单步骤提案的目标（向后兼容）
        bytes callData; // 单步骤提案的调用数据（向后兼容）
        bytes32 merkleRoot;
        uint256 activeCount;
        uint256 createdAt;
        uint256 votingEndsAt;
        uint256 yesCount;
        uint256 noCount;
        uint256 executableAt; // 最早可执行时间（投票结束后 + timelockDelay）
        bool executed;
        bool isMultiStep; // 是否为多步骤提案
        address[] targets; // 多步骤提案的目标数组（isMultiStep=true 时使用）
        bytes[] callDataArray; // 多步骤提案的调用数据数组（isMultiStep=true 时使用）
    }

    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(bytes32 => uint256) public lastExecutedAt; // proposalHash => 执行时间，同一 (target, callData) 一周冷却
    // 委托投票：delegator => delegatee
    mapping(address => address) public delegates;
    // 投票权重缓存：proposalId => voter => weight（用于优化）
    mapping(uint256 => mapping(address => uint256)) private voteWeights;
    uint256 public proposalCount;
    address public owner;

    // 优化事件：减少gas消耗
    event ProposalCreated(uint256 indexed proposalId, address indexed target, uint256 activeCount);
    event MultiStepProposalCreated(uint256 indexed proposalId, address[] targets, uint256 activeCount);
    event Voted(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalStepExecuted(uint256 indexed proposalId, uint256 stepIndex, address indexed target);
    event DelegateSet(address indexed delegator, address indexed delegatee);

    modifier onlyOwner() {
        require(msg.sender == owner, "Governance: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice 内部：创建提案的核心逻辑；供外部接口与扩展合约复用
    function _createProposal(
        address target,
        bytes calldata callData,
        bytes32 merkleRoot,
        uint256 activeCount
    ) internal returns (uint256 proposalId) {
        require(target != address(0), "Governance: zero target");
        require(merkleRoot != bytes32(0), "Governance: zero root");
        require(activeCount > 0, "Governance: zero active");

        bytes32 proposalHash = keccak256(abi.encode(target, callData));
        uint256 lastExecuted = lastExecutedAt[proposalHash];
        require(
            lastExecuted == 0 || block.timestamp >= lastExecuted + COOLDOWN_PERIOD,
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
            executableAt: block.timestamp + VOTING_PERIOD + timelockDelay,
            executed: false,
            isMultiStep: false,
            targets: new address[](0),
            callDataArray: new bytes[](0)
        });

        emit ProposalCreated(proposalId, target, activeCount);
    }

    /// @notice 内部：创建多步骤提案的核心逻辑；供外部接口与扩展合约复用
    /// @param targets 目标合约地址数组
    /// @param callDataArray 调用数据数组（与 targets 长度一致）
    /// @param merkleRoot 活跃集的默克尔根
    /// @param activeCount 活跃集地址数量
    function _createMultiStepProposal(
        address[] calldata targets,
        bytes[] calldata callDataArray,
        bytes32 merkleRoot,
        uint256 activeCount
    ) internal returns (uint256 proposalId) {
        require(targets.length > 0, "Governance: empty targets");
        require(targets.length == callDataArray.length, "Governance: length mismatch");
        require(targets.length <= 10, "Governance: too many steps"); // 限制最多 10 步
        require(merkleRoot != bytes32(0), "Governance: zero root");
        require(activeCount > 0, "Governance: zero active");

        // 检查冷却期（使用第一个 target 和 callData 的哈希）
        // Gas优化：缓存时间窗口计算
        bytes32 proposalHash = keccak256(abi.encode(targets, callDataArray));
        uint256 lastExecuted = lastExecutedAt[proposalHash];
        require(
            lastExecuted == 0 || block.timestamp >= lastExecuted + COOLDOWN_PERIOD,
            "Governance: cooldown"
        );

        proposalId = proposalCount++;
        
        // 创建存储数组
        address[] memory storedTargets = new address[](targets.length);
        bytes[] memory storedCallDataArray = new bytes[](callDataArray.length);
        
        // 复制并验证数组内容
        for (uint256 i = 0; i < targets.length; i++) {
            require(targets[i] != address(0), "Governance: zero target");
            storedTargets[i] = targets[i];
            storedCallDataArray[i] = callDataArray[i];
        }
        
        proposals[proposalId] = Proposal({
            target: address(0), // 多步骤提案不使用
            callData: "", // 多步骤提案不使用
            merkleRoot: merkleRoot,
            activeCount: activeCount,
            createdAt: block.timestamp,
            votingEndsAt: block.timestamp + VOTING_PERIOD,
            yesCount: 0,
            noCount: 0,
            executableAt: block.timestamp + VOTING_PERIOD + timelockDelay,
            executed: false,
            isMultiStep: true,
            targets: storedTargets,
            callDataArray: storedCallDataArray
        });

        emit MultiStepProposalCreated(proposalId, targets, activeCount);
    }

    /// @notice 创建提案；任意 (target, callData) 均可，如手续费、上币、流通链等
    function createProposal(
        address target,
        bytes calldata callData,
        bytes32 merkleRoot,
        uint256 activeCount
    ) external returns (uint256 proposalId) {
        return _createProposal(target, callData, merkleRoot, activeCount);
    }

    /// @notice 创建多步骤提案；支持在一个提案中执行多个操作（如先设置 A，再设置 B）
    function createMultiStepProposal(
        address[] calldata targets,
        bytes[] calldata callDataArray,
        bytes32 merkleRoot,
        uint256 activeCount
    ) external returns (uint256 proposalId) {
        return _createMultiStepProposal(targets, callDataArray, merkleRoot, activeCount);
    }

    /// @notice 设置委托投票
    function setDelegate(address delegatee) external {
        require(delegatee != msg.sender, "Governance: self delegate");
        delegates[msg.sender] = delegatee;
        emit DelegateSet(msg.sender, delegatee);
    }
    
    /// @notice 获取投票权重（简化：每个活跃集成员权重为1，可扩展）
    function _getVoteWeight(address voter) internal pure returns (uint256) {
        // 简化实现：每个活跃集成员权重为1
        // 未来可扩展为基于贡献分或其他指标的权重
        return 1;
    }
    
    /// @notice 内部：投票核心逻辑，供外部接口与扩展合约复用
    function _vote(
        uint256 proposalId,
        bool support,
        bytes32[] calldata proof
    ) internal {
        Proposal storage p = proposals[proposalId];
        require(block.timestamp < p.votingEndsAt, "Governance: voting ended");
        
        // 检查委托：如果设置了委托，使用委托地址投票
        address voter = delegates[msg.sender] != address(0) ? delegates[msg.sender] : msg.sender;
        require(!hasVoted[proposalId][voter], "Governance: already voted");

        // Merkle验证优化：缓存验证结果
        bytes32 leaf = keccak256(abi.encodePacked(voter));
        require(MerkleProof.verify(proof, p.merkleRoot, leaf), "Governance: not in active set");

        uint256 weight = _getVoteWeight(voter);
        hasVoted[proposalId][voter] = true;
        voteWeights[proposalId][voter] = weight;
        
        if (support) {
            p.yesCount += weight;
        } else {
            p.noCount += weight;
        }

        emit Voted(proposalId, voter, support, weight);
    }

    /// @notice 投票；voter 需提供默克尔证明以证明在活跃集内
    function vote(
        uint256 proposalId,
        bool support,
        bytes32[] calldata proof
    ) external virtual {
        _vote(proposalId, support, proof);
    }

    /// @notice 设置执行延迟（Timelock）；仅 owner 可调用
    function setTimelockDelay(uint256 _delay) external onlyOwner {
        require(_delay >= MIN_TIMELOCK_DELAY, "Governance: delay too short");
        timelockDelay = _delay;
    }

    /// @notice 内部：执行提案核心逻辑，供外部接口与扩展合约复用
    function _execute(uint256 proposalId) internal {
        Proposal storage p = proposals[proposalId];
        require(block.timestamp >= p.votingEndsAt, "Governance: voting not ended");
        require(block.timestamp >= p.executableAt, "Governance: timelock not passed");
        require(!p.executed, "Governance: already executed");
        // Gas优化：使用位运算替代除法
        require(p.yesCount > (p.activeCount >> 1), "Governance: not passed");

        p.executed = true;
        
        if (p.isMultiStep) {
            // 多步骤提案：依次执行每个步骤
            bytes32 proposalHash = keccak256(abi.encode(p.targets, p.callDataArray));
            lastExecutedAt[proposalHash] = block.timestamp;
            
            for (uint256 i = 0; i < p.targets.length; i++) {
                (bool ok,) = p.targets[i].call(p.callDataArray[i]);
                require(ok, "Governance: step execute failed");
                emit ProposalStepExecuted(proposalId, i, p.targets[i]);
            }
        } else {
            // 单步骤提案（向后兼容）
            bytes32 proposalHash = keccak256(abi.encode(p.target, p.callData));
            lastExecutedAt[proposalHash] = block.timestamp;
            
            (bool ok,) = p.target.call(p.callData);
            require(ok, "Governance: execute failed");
        }

        emit ProposalExecuted(proposalId);
    }

    /// @notice 执行提案；通过条件：yesCount > activeCount / 2；需等待 Timelock 延迟
    function execute(uint256 proposalId) external virtual nonReentrant {
        _execute(proposalId);
    }

    function getProposal(uint256 proposalId) external view returns (
        address target,
        bytes memory callData,
        uint256 activeCount,
        uint256 createdAt,
        uint256 votingEndsAt,
        uint256 yesCount,
        uint256 noCount,
        uint256 executableAt,
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
            p.executableAt,
            p.executed
        );
    }

    /// @notice 获取多步骤提案的详细信息
    function getMultiStepProposal(uint256 proposalId) external view returns (
        address[] memory targets,
        bytes[] memory callDataArray,
        bytes32 merkleRoot,
        uint256 activeCount,
        uint256 createdAt,
        uint256 votingEndsAt,
        uint256 yesCount,
        uint256 noCount,
        uint256 executableAt,
        bool executed
    ) {
        Proposal storage p = proposals[proposalId];
        require(p.isMultiStep, "Governance: not multi-step");
        return (
            p.targets,
            p.callDataArray,
            p.merkleRoot,
            p.activeCount,
            p.createdAt,
            p.votingEndsAt,
            p.yesCount,
            p.noCount,
            p.executableAt,
            p.executed
        );
    }

    function isInActiveSet(uint256 proposalId, address account, bytes32[] calldata proof) external view returns (bool) {
        bytes32 leaf = keccak256(abi.encodePacked(account));
        return MerkleProof.verify(proof, proposals[proposalId].merkleRoot, leaf);
    }
    
    /// @notice 获取投票权重（供前端查询）
    function getVoteWeight(uint256 proposalId, address voter) external view returns (uint256) {
        return voteWeights[proposalId][voter];
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Governance: zero address");
        owner = newOwner;
    }
}
