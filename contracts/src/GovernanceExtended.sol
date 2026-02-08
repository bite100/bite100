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

    // 委托投票
    mapping(address => address) public delegates; // 委托人 -> 被委托人
    mapping(address => address[]) public delegators; // 被委托人的委托人列表

    // ContributorReward 合约地址（用于查询贡献分和信誉分）
    address public contributorReward;

    // 提案分类常量
    string public constant CATEGORY_PARAM = "参数调整";
    string public constant CATEGORY_TOKEN = "上币";
    string public constant CATEGORY_UPGRADE = "合约升级";
    string public constant CATEGORY_TREASURY = "资金管理";
    string public constant CATEGORY_OTHER = "其他";

    event ProposalMetadataSet(
        uint256 indexed proposalId,
        string title,
        string category,
        address proposer
    );
    event ProposalCancelled(uint256 indexed proposalId, address cancelledBy);
    event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);
    event VoteWeighted(uint256 indexed proposalId, address indexed voter, uint256 weight);

    modifier whenNotCancelled(uint256 proposalId) {
        require(!cancelled[proposalId], "Governance: proposal cancelled");
        _;
    }

    constructor(address _contributorReward) {
        contributorReward = _contributorReward;
    }

    /// @notice 创建带元数据的提案
    function createProposalWithMetadata(
        address target,
        bytes calldata callData,
        bytes32 merkleRoot,
        uint256 activeCount,
        string memory title,
        string memory description,
        string memory category
    ) external returns (uint256 proposalId) {
        proposalId = createProposal(target, callData, merkleRoot, activeCount);
        
        proposalMetadata[proposalId] = ProposalMetadata({
            title: title,
            description: description,
            category: category,
            ipfsHash: "",
            proposer: msg.sender
        });

        emit ProposalMetadataSet(proposalId, title, category, msg.sender);
    }

    /// @notice 创建带 IPFS 哈希的提案
    function createProposalWithIPFS(
        address target,
        bytes calldata callData,
        bytes32 merkleRoot,
        uint256 activeCount,
        string memory title,
        string memory ipfsHash,
        string memory category
    ) external returns (uint256 proposalId) {
        proposalId = createProposal(target, callData, merkleRoot, activeCount);
        
        proposalMetadata[proposalId] = ProposalMetadata({
            title: title,
            description: "",
            category: category,
            ipfsHash: ipfsHash,
            proposer: msg.sender
        });

        emit ProposalMetadataSet(proposalId, title, category, msg.sender);
    }

    /// @notice 创建多步骤提案（带元数据）
    function createMultiStepProposalWithMetadata(
        address[] calldata targets,
        bytes[] calldata callDataArray,
        bytes32 merkleRoot,
        uint256 activeCount,
        string memory title,
        string memory description,
        string memory category
    ) external returns (uint256 proposalId) {
        proposalId = createMultiStepProposal(targets, callDataArray, merkleRoot, activeCount);
        
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

    /// @notice 带权重的投票（基于贡献分和信誉分）
    function voteWithWeight(
        uint256 proposalId,
        bool support,
        bytes32[] calldata proof
    ) external whenNotCancelled(proposalId) {
        // 先执行基础投票
        vote(proposalId, support, proof);

        // 计算投票权重
        uint256 weight = getVotingWeight(msg.sender, proposalId);
        
        if (weight > 0) {
            emit VoteWeighted(proposalId, msg.sender, weight);
        }
    }

    /// @notice 获取投票权重（基于贡献分和信誉分）
    function getVotingWeight(address voter, uint256 proposalId) public view returns (uint256) {
        if (contributorReward == address(0)) {
            return 1; // 默认权重为 1
        }

        // 获取当前周期（使用提案创建时的周期）
        Proposal storage p = proposals[proposalId];
        string memory proposalPeriod = getPeriodForTimestamp(p.createdAt);
        
        // 查询贡献分
        uint256 contributionScore = ContributorReward(contributorReward)
            .getContributionScore(proposalPeriod, voter);
        
        // 查询信誉分
        uint256 reputation = ContributorReward(contributorReward)
            .reputationScore(voter);
        
        // 如果贡献分为 0，返回 0（无投票权）
        if (contributionScore == 0) {
            return 0;
        }
        
        // 计算权重：贡献分 × (信誉分 / 10000)
        // 如果信誉分为 0，使用贡献分（最低权重）
        if (reputation == 0) {
            return contributionScore;
        }
        
        return (contributionScore * reputation) / 10000;
    }

    /// @notice 根据时间戳获取周期（简化实现）
    function getPeriodForTimestamp(uint256 timestamp) public pure returns (string memory) {
        // 简化实现：返回周数
        uint256 weekNumber = timestamp / (7 days);
        return string(abi.encodePacked("week-", _uint2str(weekNumber)));
    }


    /// @notice 整数转字符串（辅助函数）
    function _uint2str(uint256 _i) internal pure returns (string memory) {
        if (_i == 0) {
            return "0";
        }
        uint256 j = _i;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint256 k = len;
        while (_i != 0) {
            k = k - 1;
            uint8 temp = (48 + uint8(_i - _i / 10 * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }

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
        super.vote(proposalId, support, proof);
    }

    /// @notice 重写执行函数，添加取消检查
    function execute(uint256 proposalId) public override whenNotCancelled(proposalId) {
        super.execute(proposalId);
    }

    /// @notice 设置 ContributorReward 地址
    function setContributorReward(address _contributorReward) external onlyOwner {
        contributorReward = _contributorReward;
    }
}
