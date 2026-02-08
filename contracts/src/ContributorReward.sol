// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IERC20.sol";

/// @title ContributorReward 贡献奖励（按周期、按贡献分分配固定总量）
/// @notice 节点提交贡献证明（ECDSA 签名），合约按贡献分占比发放该周期奖励池；与 FeeDistributor 并列，不扩展 FeeDistributor
contract ContributorReward {
    address public owner;
    address public governance;

    /// 储备比例 bps，10% = 1000，不参与当周分配；可分配额 = pool * (10000 - reserveBps) / 10000
    uint16 public reserveBps = 1500; // 默认 15%
    /// 自由流动比例 bps，10% = 1000；预留：该部分可按兑换时价格领取，当前实现与可分配额一同按份额发放
    uint16 public freeFlowBps = 1000; // 默认 10%

    /// 贡献分计算上限（GB）
    uint256 public constant CAP_STORAGE_GB = 1000;
    /// 贡献分计算上限（字节），1e12 ≈ 1TB 转发量
    uint256 public constant CAP_BYTES_RELAYED = 1e12;
    /// 撮合贡献：笔数上限（归一化后参与 40% 权重）
    uint256 public constant CAP_TRADES_MATCHED = 1e6;
    /// 撮合贡献：成交量上限（最小单位，如 wei）
    uint256 public constant CAP_VOLUME_MATCHED = 1e24;
    /// 流动性贡献：上限（以稳定币计价，如 USDC）
    uint256 public constant CAP_LIQUIDITY = 100000e18; // 100,000 USDC
    uint256 private constant SCALE = 1e18;
    /// 分配权重（更新：撮合 40%、存储 25%、流动性 20%、中继 15%）
    uint256 private constant WEIGHT_MATCH = 40;
    uint256 private constant WEIGHT_STORAGE = 25;
    uint256 private constant WEIGHT_LIQUIDITY = 20;
    uint256 private constant WEIGHT_RELAY = 15;
    /// 周期结束超过此时长（秒）后禁止领取，未领取不再发放
    uint256 public constant CLAIM_DEADLINE_SECONDS = 14 days;

    /// 是否启用按信誉分分配（true：按信誉分加权分配；false：仅用信誉阈值作为门槛）
    bool public useReputationWeighting = false;
    /// 信誉阈值（最小信誉分数，低于此值的节点无法领取奖励）；0 表示不启用信誉检查
    uint256 public reputationThreshold = 0;
    /// account => 信誉分数（基于转发量、违规次数等计算，范围 0-10000）
    mapping(address => uint256) public reputationScore;

    /// periodId => 该周期结束时间（Unix 秒，UTC 周期结束日 23:59:59）；0 表示未设置，不校验截止（兼容旧数据）
    mapping(bytes32 => uint256) public periodEndTimestamp;

    /// periodId => 该周期总贡献分
    mapping(bytes32 => uint256) public periodTotalScore;
    /// periodId => 该周期总加权贡献分（贡献分 * 信誉分数/10000 的总和，仅在启用信誉加权时使用）
    mapping(bytes32 => uint256) public periodTotalWeightedScore;
    /// periodId => account => 贡献分
    mapping(bytes32 => mapping(address => uint256)) public contributionScore;
    /// periodId => token => 该周期奖励池总量（owner 注入）
    mapping(bytes32 => mapping(address => uint256)) public periodReward;
    /// periodId => token => account => 已领取
    mapping(bytes32 => mapping(address => mapping(address => uint256))) public claimed;

    event ProofSubmitted(bytes32 indexed periodId, address indexed account, uint256 score);
    event PeriodRewardSet(bytes32 indexed periodId, address indexed token, uint256 amount);
    event PeriodEndTimestampSet(bytes32 indexed periodId, uint256 endTimestamp);
    event RewardClaimed(bytes32 indexed periodId, address indexed account, address indexed token, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ReserveBpsSet(uint16 oldBps, uint16 newBps);
    event FreeFlowBpsSet(uint16 oldBps, uint16 newBps);
    event GovernanceSet(address indexed governance);
    event ReputationScoreSet(address indexed account, uint256 score);
    event ReputationThresholdSet(uint256 oldThreshold, uint256 newThreshold);
    event ReputationWeightingEnabled(bool enabled);

    modifier onlyOwner() {
        require(msg.sender == owner, "ContributorReward: not owner");
        _;
    }

    modifier onlyGovernance() {
        require(msg.sender == governance && governance != address(0), "ContributorReward: not governance");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function _periodId(string calldata period) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(period));
    }

    /// @notice 提交贡献证明（兼容旧版：无撮合字段，digest 不含 tradesMatched/volumeMatched）
    /// @param signature 65 字节 ECDSA：对 keccak256(abi.encodePacked(period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType)) 的签名
    function submitProof(
        string calldata period,
        uint256 uptime,
        uint256 storageUsedGB,
        uint256 storageTotalGB,
        uint256 bytesRelayed,
        uint8 nodeType,
        bytes calldata signature
    ) external {
        require(bytes(period).length > 0, "ContributorReward: empty period");
        require(uptime <= SCALE, "ContributorReward: uptime > 1e18");
        require(signature.length == 65, "ContributorReward: bad signature length");
        bytes32 digest = keccak256(abi.encodePacked(
            period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType
        ));
        _verifyAndApplyScore(period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, 0, 0, nodeType, signature, digest);
    }

    /// @notice 提交贡献证明（扩展版：含撮合 tradesMatched/volumeMatched，nodeType=2 为撮合）
    /// @param signature 65 字节 ECDSA：对 keccak256(abi.encodePacked(period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, tradesMatched, volumeMatched, nodeType)) 的签名
    function submitProofEx(
        string calldata period,
        uint256 uptime,
        uint256 storageUsedGB,
        uint256 storageTotalGB,
        uint256 bytesRelayed,
        uint256 tradesMatched,
        uint256 volumeMatched,
        uint8 nodeType,
        bytes calldata signature
    ) external {
        require(bytes(period).length > 0, "ContributorReward: empty period");
        require(uptime <= SCALE, "ContributorReward: uptime > 1e18");
        require(signature.length == 65, "ContributorReward: bad signature length");
        bytes32 digest = keccak256(abi.encodePacked(
            period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, tradesMatched, volumeMatched, nodeType
        ));
        _verifyAndApplyScore(period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, tradesMatched, volumeMatched, nodeType, signature, digest);
    }

    function _verifyAndApplyScore(
        string calldata period,
        uint256 uptime,
        uint256 storageUsedGB,
        uint256 storageTotalGB,
        uint256 bytesRelayed,
        uint256 tradesMatched,
        uint256 volumeMatched,
        uint8 nodeType,
        bytes calldata signature,
        bytes32 digest
    ) internal {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            let ptr := signature.offset
            r := calldataload(ptr)
            s := calldataload(add(ptr, 32))
            v := byte(0, calldataload(add(ptr, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "ContributorReward: invalid v");
        address signer = ecrecover(digest, v, r, s);
        require(signer == msg.sender && signer != address(0), "ContributorReward: invalid signature");

        bytes32 pid = _periodId(period);
        uint256 oldScore = contributionScore[pid][msg.sender];
        uint256 newScore = _computeScore(uptime, storageUsedGB, storageTotalGB, bytesRelayed, tradesMatched, volumeMatched, nodeType);

        if (oldScore > 0) {
            periodTotalScore[pid] -= oldScore;
            // 如果启用信誉加权，更新总加权贡献分
            if (useReputationWeighting) {
                uint256 oldReputation = reputationScore[msg.sender];
                uint256 oldWeightedScore = (oldScore * oldReputation) / 10000;
                periodTotalWeightedScore[pid] -= oldWeightedScore;
            }
        }
        periodTotalScore[pid] += newScore;
        contributionScore[pid][msg.sender] = newScore;
        
        // 如果启用信誉加权，更新总加权贡献分
        if (useReputationWeighting) {
            uint256 myReputation = reputationScore[msg.sender];
            uint256 newWeightedScore = (newScore * myReputation) / 10000;
            periodTotalWeightedScore[pid] += newWeightedScore;
        }

        emit ProofSubmitted(pid, msg.sender, newScore);
    }

    /// @dev 贡献分：按 nodeType 应用 40/25/20/15 权重（撮合 40%、存储 25%、流动性 20%、中继 15%）
    function _computeScore(
        uint256 uptime,
        uint256 storageUsedGB,
        uint256 /* storageTotalGB */,
        uint256 bytesRelayed,
        uint256 tradesMatched,
        uint256 volumeMatched,
        uint8 nodeType
    ) internal pure returns (uint256) {
        uint256 base = uptime;
        if (nodeType == 2) {
            // 撮合：matchPart 由笔数+成交量归一化，权重 40
            uint256 matchPart = 0;
            if (CAP_TRADES_MATCHED > 0 && tradesMatched > 0) {
                uint256 t = tradesMatched * SCALE / CAP_TRADES_MATCHED;
                if (t > SCALE) t = SCALE;
                matchPart += t / 2; // 50% 笔数
            }
            if (CAP_VOLUME_MATCHED > 0 && volumeMatched > 0) {
                uint256 v = volumeMatched * SCALE / CAP_VOLUME_MATCHED;
                if (v > SCALE) v = SCALE;
                matchPart += v / 2; // 50% 成交量
            }
            if (matchPart > SCALE) matchPart = SCALE;
            return (base + matchPart) * WEIGHT_MATCH;
        }
        if (nodeType == 1) {
            // 存储：权重 25
            if (CAP_STORAGE_GB > 0 && storageUsedGB > 0) {
                uint256 storagePart = storageUsedGB * SCALE / CAP_STORAGE_GB;
                if (storagePart > SCALE) storagePart = SCALE;
                base += storagePart;
            }
            return base * WEIGHT_STORAGE;
        }
        if (nodeType == 3) {
            // 流动性：权重 20（通过 submitLiquidityProof 调用）
            // 注意：流动性贡献分通过单独的接口提交，这里仅占位
            return base * WEIGHT_LIQUIDITY;
        }
        // 中继 nodeType == 0：权重 15
        if (CAP_BYTES_RELAYED > 0 && bytesRelayed > 0) {
            uint256 relayPart = bytesRelayed * SCALE / CAP_BYTES_RELAYED;
            if (relayPart > SCALE) relayPart = SCALE;
            base += relayPart;
        }
        return base * WEIGHT_RELAY;
    }

    /// @notice Owner 注入某周期某代币的奖励池（需先 approve 本合约）
    function setPeriodReward(string calldata period, address token, uint256 amount) external onlyOwner {
        require(token != address(0), "ContributorReward: zero token");
        require(amount > 0, "ContributorReward: zero amount");
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "ContributorReward: transfer failed");
        bytes32 pid = _periodId(period);
        periodReward[pid][token] += amount;
        emit PeriodRewardSet(pid, token, amount);
    }

    /// @notice 设置某周期结束时间（Unix 秒）；周期结束超过 14 天后禁止领取，未领取不再发放
    function setPeriodEndTimestamp(bytes32 periodId, uint256 endTimestamp) external onlyOwner {
        periodEndTimestamp[periodId] = endTimestamp;
        emit PeriodEndTimestampSet(periodId, endTimestamp);
    }

    /// @notice 领取某周期某代币的应得奖励；若该周期已设置结束时间且超过结束+14天则禁止领取
    /// @notice 每次领取不超过该周期奖励池的 10%，可多次领取直到领完应得部分
    /// @notice 如果启用信誉加权分配（useReputationWeighting=true），奖励按（贡献分 * 信誉分数/10000）分配
    function claimReward(string calldata period, address token) external {
        bytes32 pid = _periodId(period);
        uint256 endTs = periodEndTimestamp[pid];
        if (endTs != 0) {
            require(block.timestamp <= endTs + CLAIM_DEADLINE_SECONDS, "ContributorReward: claim deadline passed");
        }
        
        // 检查信誉阈值（如果启用）
        if (reputationThreshold > 0) {
            require(reputationScore[msg.sender] >= reputationThreshold, "ContributorReward: reputation too low");
        }
        
        uint256 myScore = contributionScore[pid][msg.sender];
        require(myScore > 0, "ContributorReward: no score");
        
        uint256 pool = periodReward[pid][token];
        require(pool > 0, "ContributorReward: no reward pool");
        uint256 distributable = (pool * (10000 - reserveBps)) / 10000;
        
        uint256 totalClaimable;
        if (useReputationWeighting) {
            // 按信誉分加权分配：计算加权后的总贡献分和我的加权贡献分
            uint256 myReputation = reputationScore[msg.sender];
            if (myReputation == 0) {
                // 无信誉分数的节点无法领取（如果启用加权分配）
                require(false, "ContributorReward: no reputation score");
            }
            uint256 myWeightedScore = (myScore * myReputation) / 10000;
            uint256 totalWeightedScore = periodTotalWeightedScore[pid];
            require(totalWeightedScore > 0, "ContributorReward: no total weighted score");
            totalClaimable = (distributable * myWeightedScore) / totalWeightedScore - claimed[pid][token][msg.sender];
        } else {
            // 传统分配：仅按贡献分分配
            uint256 total = periodTotalScore[pid];
            require(total > 0, "ContributorReward: no total score");
            totalClaimable = (distributable * myScore) / total - claimed[pid][token][msg.sender];
        }
        
        require(totalClaimable > 0, "ContributorReward: nothing to claim");
        
        // 每次领取不超过奖励池的 10%
        uint256 maxPerClaim = pool / 10;
        uint256 amount = totalClaimable > maxPerClaim ? maxPerClaim : totalClaimable;
        
        claimed[pid][token][msg.sender] += amount;
        require(IERC20(token).transfer(msg.sender, amount), "ContributorReward: transfer failed");
        emit RewardClaimed(pid, msg.sender, token, amount);
    }
    

    /// @notice 查询某账户在某周期某代币上可领取金额；若已过领取截止则返回 0
    function claimable(string calldata period, address token, address account) external view returns (uint256) {
        bytes32 pid = _periodId(period);
        uint256 endTs = periodEndTimestamp[pid];
        if (endTs != 0 && block.timestamp > endTs + CLAIM_DEADLINE_SECONDS) return 0;
        
        uint256 myScore = contributionScore[pid][account];
        if (myScore == 0) return 0;
        
        uint256 pool = periodReward[pid][token];
        if (pool == 0) return 0;
        uint256 distributable = (pool * (10000 - reserveBps)) / 10000;
        
        uint256 amount;
        if (useReputationWeighting) {
            uint256 myReputation = reputationScore[account];
            if (myReputation == 0) return 0;
            uint256 myWeightedScore = (myScore * myReputation) / 10000;
            uint256 totalWeightedScore = periodTotalWeightedScore[pid];
            if (totalWeightedScore == 0) return 0;
            amount = (distributable * myWeightedScore) / totalWeightedScore - claimed[pid][token][account];
        } else {
            uint256 total = periodTotalScore[pid];
            if (total == 0) return 0;
            amount = (distributable * myScore) / total - claimed[pid][token][account];
        }
        
        return amount;
    }

    function setReserveBps(uint16 _reserveBps) external onlyGovernance {
        require(_reserveBps <= 5000, "ContributorReward: reserve too high"); // max 50%
        uint16 old = reserveBps;
        reserveBps = _reserveBps;
        emit ReserveBpsSet(old, _reserveBps);
    }

    function setFreeFlowBps(uint16 _freeFlowBps) external onlyGovernance {
        require(_freeFlowBps >= 500 && _freeFlowBps <= 3000, "ContributorReward: freeFlow 5-30%");
        uint16 old = freeFlowBps;
        freeFlowBps = _freeFlowBps;
        emit FreeFlowBpsSet(old, _freeFlowBps);
    }

    function setGovernance(address _governance) external onlyOwner {
        governance = _governance;
        emit GovernanceSet(_governance);
    }

    /// @notice Owner 设置节点的信誉分数（基于链下计算的信誉指标）
    /// @param account 节点地址
    /// @param score 信誉分数（建议范围：0-10000，10000 表示最高信誉）
    function setReputationScore(address account, uint256 score) external onlyOwner {
        require(account != address(0), "ContributorReward: zero address");
        reputationScore[account] = score;
        emit ReputationScoreSet(account, score);
    }

    /// @notice Owner 批量设置多个节点的信誉分数
    function setReputationScores(address[] calldata accounts, uint256[] calldata scores) external onlyOwner {
        require(accounts.length == scores.length, "ContributorReward: length mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            require(accounts[i] != address(0), "ContributorReward: zero address");
            reputationScore[accounts[i]] = scores[i];
            emit ReputationScoreSet(accounts[i], scores[i]);
        }
    }

    /// @notice Governance 设置是否启用按信誉分加权分配
    /// @param enabled true：按（贡献分 * 信誉分数/10000）分配；false：仅用信誉阈值作为门槛
    function setReputationWeighting(bool enabled) external onlyGovernance {
        useReputationWeighting = enabled;
        emit ReputationWeightingEnabled(enabled);
    }

    /// @notice Governance 设置信誉阈值（低于此值的节点无法领取奖励）
    /// @param threshold 信誉阈值（0 表示不启用信誉检查）
    function setReputationThreshold(uint256 threshold) external onlyGovernance {
        uint256 old = reputationThreshold;
        reputationThreshold = threshold;
        emit ReputationThresholdSet(old, threshold);
    }
    
    /// @notice Owner 更新节点信誉分数时，同步更新已提交贡献证明的周期的总加权贡献分
    /// @param account 节点地址
    /// @param newScore 新的信誉分数
    /// @param periods 需要更新的周期列表
    function updateReputationAndRecalculateWeightedScore(
        address account,
        uint256 newScore,
        string[] calldata periods
    ) external onlyOwner {
        uint256 oldScore = reputationScore[account];
        reputationScore[account] = newScore;
        emit ReputationScoreSet(account, newScore);
        
        // 如果启用信誉加权，更新相关周期的总加权贡献分
        if (useReputationWeighting) {
            for (uint256 i = 0; i < periods.length; i++) {
                bytes32 pid = _periodId(periods[i]);
                uint256 contribution = contributionScore[pid][account];
                if (contribution > 0) {
                    uint256 oldWeighted = (contribution * oldScore) / 10000;
                    uint256 newWeighted = (contribution * newScore) / 10000;
                    if (newWeighted > oldWeighted) {
                        periodTotalWeightedScore[pid] += (newWeighted - oldWeighted);
                    } else {
                        periodTotalWeightedScore[pid] -= (oldWeighted - newWeighted);
                    }
                }
            }
        }
    }

    /// @notice 查询某周期某账户的贡献分
    function getContributionScore(string calldata period, address account) external view returns (uint256) {
        return contributionScore[_periodId(period)][account];
    }

    /// @notice 查询某周期总贡献分
    function getPeriodTotalScore(string calldata period) external view returns (uint256) {
        return periodTotalScore[_periodId(period)];
    }

    /// @notice 查询节点是否满足信誉要求（可用于前端提示）
    function isReputationQualified(address account) external view returns (bool) {
        if (reputationThreshold == 0) return true;
        return reputationScore[account] >= reputationThreshold;
    }

    /// @notice Owner 直接设置某地址在某周期的贡献分（用于上线奖励等特殊分配）
    function setContributionScore(string calldata period, address account, uint256 score) external onlyOwner {
        require(account != address(0), "ContributorReward: zero address");
        bytes32 pid = _periodId(period);
        uint256 oldScore = contributionScore[pid][account];
        if (oldScore > 0) {
            periodTotalScore[pid] -= oldScore;
            // 如果启用信誉加权，更新总加权贡献分
            if (useReputationWeighting) {
                uint256 oldReputation = reputationScore[account];
                uint256 oldWeightedScore = (oldScore * oldReputation) / 10000;
                periodTotalWeightedScore[pid] -= oldWeightedScore;
            }
        }
        if (score > 0) {
            periodTotalScore[pid] += score;
            // 如果启用信誉加权，更新总加权贡献分
            if (useReputationWeighting) {
                uint256 myReputation = reputationScore[account];
                uint256 newWeightedScore = (score * myReputation) / 10000;
                periodTotalWeightedScore[pid] += newWeightedScore;
            }
        }
        contributionScore[pid][account] = score;
        emit ProofSubmitted(pid, account, score);
    }

    /// @notice 提交流动性贡献证明（节点注入流动性后调用）
    /// @param period 周期
    /// @param liquidityAmount 流动性数量（以稳定币计价，如 USDC）
    /// @param signature 签名：对 keccak256(abi.encodePacked(period, liquidityAmount, nodeType=3)) 的签名
    function submitLiquidityProof(
        string calldata period,
        uint256 liquidityAmount,
        bytes calldata signature
    ) external {
        require(bytes(period).length > 0, "ContributorReward: empty period");
        require(liquidityAmount > 0, "ContributorReward: zero liquidity");
        require(signature.length == 65, "ContributorReward: bad signature length");
        
        bytes32 digest = keccak256(abi.encodePacked(period, liquidityAmount, uint8(3)));
        
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            let ptr := signature.offset
            r := calldataload(ptr)
            s := calldataload(add(ptr, 32))
            v := byte(0, calldataload(add(ptr, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "ContributorReward: invalid v");
        address signer = ecrecover(digest, v, r, s);
        require(signer == msg.sender && signer != address(0), "ContributorReward: invalid signature");

        bytes32 pid = _periodId(period);
        uint256 oldScore = contributionScore[pid][msg.sender];
        uint256 newScore = _computeLiquidityScore(liquidityAmount);

        if (oldScore > 0) {
            periodTotalScore[pid] -= oldScore;
            if (useReputationWeighting) {
                uint256 oldReputation = reputationScore[msg.sender];
                uint256 oldWeightedScore = (oldScore * oldReputation) / 10000;
                periodTotalWeightedScore[pid] -= oldWeightedScore;
            }
        }
        periodTotalScore[pid] += newScore;
        contributionScore[pid][msg.sender] = newScore;
        
        if (useReputationWeighting) {
            uint256 myReputation = reputationScore[msg.sender];
            uint256 newWeightedScore = (newScore * myReputation) / 10000;
            periodTotalWeightedScore[pid] += newWeightedScore;
        }

        emit ProofSubmitted(pid, msg.sender, newScore);
    }

    /// @notice 计算流动性贡献分
    /// @param liquidityAmount 流动性数量（以稳定币计价）
    function _computeLiquidityScore(uint256 liquidityAmount) internal pure returns (uint256) {
        uint256 base = SCALE; // 基础分 1e18
        if (CAP_LIQUIDITY > 0 && liquidityAmount > 0) {
            uint256 liquidityPart = liquidityAmount * SCALE / CAP_LIQUIDITY;
            if (liquidityPart > SCALE) liquidityPart = SCALE;
            base += liquidityPart;
        }
        return base * WEIGHT_LIQUIDITY / 100; // 权重 20%
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ContributorReward: zero address");
        owner = newOwner;
        emit OwnershipTransferred(msg.sender, newOwner);
    }
}
