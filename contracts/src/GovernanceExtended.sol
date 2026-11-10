// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Governance.sol";
import "./ContributorReward.sol";

/// @title GovernanceExtended DAO 扩展功能
/// @notice 扩展 Governance 合约，添加提案元数据、取消机制、委托投票等功能
contract GovernanceExtended is Governance {
    // 提案元数据
    struct ProposalMetadata {
        string title;           // 提案标题
        string description;    // 提案描述（IPFS hash 或简短描述）
        string category;        // 提案分类（如 "参数调整"、"上币"、"合约升级"）
        string ipfsHash;       // IPFS 存储的详细描述（可选）
        address proposer;       // 提案创建者
    }

    mapping(uint256 => ProposalMetadata) public proposalMetadata;
    mapping(uint256 => bool) public cancelled; // 提案是否已取消

    // 委托投票（delegates 映射继承自 Governance：委托人 -> 被委托人）
    mapping(address => address[]) public delegators; // 被委托人的委托人列表

    // ContributorReward 合约地址（用于查询贡献分和信誉分）
    address public contributorReward;

    // 提案分类常量（使用 Unicode 字符串避免非 ASCII 报错）
    string public constant CATEGORY_PARAM = unicode"参数调整";
    string public constant CATEGORY_TOKEN = unicode"上币";
    string public constant CATEGORY_UPGRADE = unicode"合约升级";
    string public constant CATEGORY_TREASURY = unicode"资金管理";
    string public constant CATEGORY_OTHER = unicode"其他";

    event ProposalMetadataSet(
        uint256 indexed proposalId,
        string title,
        string category,
        address proposer
    );
    event ProposalCancelled(uint256 indexed proposalId, address cancelledBy);
    event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);
    // 第 61 轮：VoteWeighted 事件随 voteWithWeight 一并摘除——该入口只 emit 权重、
    // 实际计票恒为 1，属假功能；真加权计票等治理模型定案后再议。

    modifier whenNotCancelled(uint256 proposalId) {
        require(!cancelled[proposalId], "Governance: proposal cancelled");
        _;
    }

    constructor(address _contributorReward) {
        contributorReward = _contributorReward;
    }

    /// @notice 创建带元数据的提案（第 61 轮起引用已发布快照编号）
    function createProposalWithMetadata(
        address target,
        bytes calldata callData,
        uint256 snapshotId,
        string memory title,
        string memory description,
        string memory category
    ) external returns (uint256 proposalId) {
        proposalId = _createProposal(target, callData, snapshotId);
        
        proposalMetadata[proposalId] = ProposalMetadata({
            title: title,
            description: description,
            category: category,
            ipfsHash: "",
            proposer: msg.sender
        });

        emit ProposalMetadataSet(proposalId, title, category, msg.sender);
    }

    /// @notice 创建带 IPFS 哈希的提案（第 61 轮起引用已发布快照编号）
    function createProposalWithIPFS(
        address target,
        bytes calldata callData,
        uint256 snapshotId,
        string memory title,
        string memory ipfsHash,
        string memory category
    ) external returns (uint256 proposalId) {
        proposalId = _createProposal(target, callData, snapshotId);
        
        proposalMetadata[proposalId] = ProposalMetadata({
            title: title,
            description: "",
            category: category,
            ipfsHash: ipfsHash,
            proposer: msg.sender
        });

        emit ProposalMetadataSet(proposalId, title, category, msg.sender);
    }

    /// @notice 创建多步骤提案（带元数据；第 61 轮起引用已发布快照编号）
    function createMultiStepProposalWithMetadata(
        address[] calldata targets,
        bytes[] calldata callDataArray,
        uint256 snapshotId,
        string memory title,
        string memory description,
        string memory category
    ) external returns (uint256 proposalId) {
        proposalId = _createMultiStepProposal(targets, callDataArray, snapshotId);
        
        proposalMetadata[proposalId] = ProposalMetadata({
            title: title,
            description: description,
            category: category,
            ipfsHash: "",
            proposer: msg.sender
        });

        emit ProposalMetadataSet(proposalId, title, category, msg.sender);
    }

    /// @notice 取消提案（仅创建者或 owner）
    function cancelProposal(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        ProposalMetadata storage meta = proposalMetadata[proposalId];
        
        require(
            msg.sender == meta.proposer || msg.sender == owner,
            "Governance: not authorized"
        );
        require(block.timestamp < p.votingEndsAt, "Governance: voting ended");
        require(!p.executed, "Governance: already executed");
        require(!cancelled[proposalId], "Governance: already cancelled");

        cancelled[proposalId] = true;
        emit ProposalCancelled(proposalId, msg.sender);
    }

    /// @notice 委托投票权
    function delegate(address to) external {
        require(to != msg.sender, "Governance: self-delegation");
        require(to != address(0), "Governance: zero address");

        address currentDelegate = delegates[msg.sender];
        
        // 移除旧的委托关系
        if (currentDelegate != address(0)) {
            _removeDelegator(currentDelegate, msg.sender);
        }

        // 设置新的委托关系
        delegates[msg.sender] = to;
        delegators[to].push(msg.sender);

        emit DelegateChanged(msg.sender, currentDelegate, to);
    }

    /// @notice 撤销委托
    function undelegate() external {
        address currentDelegate = delegates[msg.sender];
        require(currentDelegate != address(0), "Governance: not delegated");

        _removeDelegator(currentDelegate, msg.sender);
        delete delegates[msg.sender];

        emit DelegateChanged(msg.sender, currentDelegate, address(0));
    }

    /// @notice 移除委托关系（内部函数）
    function _removeDelegator(address delegatee, address delegator) internal {
        address[] storage list = delegators[delegatee];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == delegator) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
    }

    // 第 61 轮摘除：voteWithWeight / getVotingWeight 及其辅助函数
    // （getPeriodForTimestamp / _uint2str）已整体 removal——原实现调用基类
    // vote()（计票恒为 1）后仅 emit 计算权重，是“假计票”。真实加权计票
    // 须待治理模型定案（见整改方案第 61 轮与轮次文档），不在本轮实现。

    /// @notice 获取提案元数据
    function getProposalMetadata(uint256 proposalId) external view returns (
        string memory title,
        string memory description,
        string memory category,
        string memory ipfsHash,
        address proposer
    ) {
        ProposalMetadata storage meta = proposalMetadata[proposalId];
        return (
            meta.title,
            meta.description,
            meta.category,
            meta.ipfsHash,
            meta.proposer
        );
    }

    /// @notice 获取委托人的委托人列表
    function getDelegators(address delegatee) external view returns (address[] memory) {
        return delegators[delegatee];
    }

    /// @notice 重写投票函数，添加取消检查
    function vote(
        uint256 proposalId,
        bool support,
        bytes32[] calldata proof
    ) public override whenNotCancelled(proposalId) {
        _vote(proposalId, support, proof);
    }

    /// @notice 重写执行函数，添加取消检查
    function execute(uint256 proposalId) public override whenNotCancelled(proposalId) {
        _execute(proposalId);
    }

    /// @notice 设置 ContributorReward 地址
    function setContributorReward(address _contributorReward) external onlyOwner {
        contributorReward = _contributorReward;
    }
}
