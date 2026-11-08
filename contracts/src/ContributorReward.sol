// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
    /// 结算提交贡献：笔数上限（归一化后参与 20% 权重；原撮合线改记）
    uint256 public constant CAP_TRADES_MATCHED = 1e6;
    /// 结算提交贡献：成交量上限（最小单位，如 wei）
    uint256 public constant CAP_VOLUME_MATCHED = 1e24;
    /// gas 库存款贡献：上限（以稳定币计价，如 USDC；原流动性线改记此线）
    uint256 public constant CAP_LIQUIDITY = 100000e18; // 100,000 USDC
    /// 挂单贡献：时长×深度积分上限（积分单位与归一化口径见 docs/round42 设计）
    uint256 public constant CAP_POSTING = 1e24;
    uint256 private constant SCALE = 1e18;
    /// 分配权重（第 42 轮定版，Ren 2026-11-08 拍板：盘口挂单 35%、gas 库存款 25%、
    /// 中继 20%、结算提交 20%，合计 100；取代做市时代口径与旧合约常量
    /// 撮合 40 / 存储 25 / 流动性 20 / 中继 15。四线身份映射：
    /// nodeType 1 = 挂单（原存储线改记）、nodeType 3 = gas 库存款（原流动性线改记）、
    /// nodeType 0 = 中继、nodeType 2 = 结算提交（原撮合线改记）。）
    uint256 private constant WEIGHT_POSTING = 35;
    uint256 private constant WEIGHT_GAS_VAULT = 25;
    uint256 private constant WEIGHT_RELAY = 20;
    uint256 private constant WEIGHT_SUBMITTER = 20;
    /// 领取期限（方案 A 定案，2026-11-07）：周期结束后此时长（秒）内可领取，逾期禁止领取
    uint256 public constant CLAIM_DEADLINE_SECONDS = 90 days;

    /// 是否启用按信誉分分配（true：按信誉分加权分配；false：仅用信誉阈值作为门槛）
    bool public useReputationWeighting = false;
    /// 信誉阈值（最小信誉分数，低于此值的节点无法领取奖励）；0 表示不启用信誉检查
    uint256 public reputationThreshold = 0;
    /// account => 信誉分数（基于转发量、违规次数等计算，范围 0-10000）
    mapping(address => uint256) public reputationScore;

    /// periodId => 该周期结束时间（Unix 秒，UTC 周期结束日 23:59:59）；领取截止 = 该时间 + CLAIM_DEADLINE_SECONDS。
    /// 未设置（0）时不启用截止（视为窗口未开始计时），owner 应在周期结束后及时设置
    mapping(bytes32 => uint256) public periodEndTimestamp;
    /// periodId => token => 该周期已领取总额（用于回流时计算未领余额）
    mapping(bytes32 => mapping(address => uint256)) public periodTotalClaimed;
    /// periodId => token => 逾期未领部分是否已回流到下一期（每个周期每代币只可回流一次）
    mapping(bytes32 => mapping(address => bool)) public unclaimedRolledOver;

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
    event UnclaimedRolledOver(bytes32 indexed fromPeriodId, bytes32 indexed toPeriodId, address indexed token, uint256 amount);
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

    /// @notice 提交贡献证明（扩展版：含结算提交 tradesMatched/volumeMatched（字段名沿用），nodeType=2 为结算提交）
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

    /// @dev 贡献分：按 nodeType 应用定版权重（挂单 35%、gas 库存款 25%、中继 20%、结算提交 20%）
    /// @dev 四线同尺度：score = (base + part) * weight，base/part 均为 SCALE 归一量；
    ///      权重只有在同一尺度下才有分配含义（见 _computeGasVaultScore 的尺度对齐说明）。
    function _computeScore(
        uint256 uptime,
        uint256 postingMetric,
        uint256 /* storageTotalGB */,
        uint256 bytesRelayed,
        uint256 tradesSettled,
        uint256 volumeSettled,
        uint8 nodeType
    ) internal pure returns (uint256) {
        uint256 base = uptime;
        if (nodeType == 2) {
            // 结算提交（原撮合线改记）：settlePart 由提交笔数+成交量归一化，权重 20
            uint256 settlePart = 0;
            if (CAP_TRADES_MATCHED > 0 && tradesSettled > 0) {
                uint256 t = tradesSettled * SCALE / CAP_TRADES_MATCHED;
                if (t > SCALE) t = SCALE;
                settlePart += t / 2; // 50% 笔数
            }
            if (CAP_VOLUME_MATCHED > 0 && volumeSettled > 0) {
                uint256 v = volumeSettled * SCALE / CAP_VOLUME_MATCHED;
                if (v > SCALE) v = SCALE;
                settlePart += v / 2; // 50% 成交量
            }
            if (settlePart > SCALE) settlePart = SCALE;
            return (base + settlePart) * WEIGHT_SUBMITTER;
        }
        if (nodeType == 1) {
            // 挂单（原存储线改记）：权重 35（四线第一位）。
            // postingMetric = 链下按「挂单时长 × 深度」算出的积分（口径见
            // docs/round42 设计与 frontend/src/services/contribution/postingMeter.ts），
            // 按 CAP_POSTING 归一化；uptime 字段承载挂单在线时长比。
            if (CAP_POSTING > 0 && postingMetric > 0) {
                uint256 postingPart = postingMetric * SCALE / CAP_POSTING;
                if (postingPart > SCALE) postingPart = SCALE;
                base += postingPart;
            }
            return base * WEIGHT_POSTING;
        }
        if (nodeType == 3) {
            // gas 库存款：权重 25（通过 submitLiquidityProof 调用，函数名沿用）
            // 注意：存款贡献分通过单独的接口提交，这里仅占位
            return base * WEIGHT_GAS_VAULT;
        }
        // 中继 nodeType == 0：权重 20
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

    /// @notice 设置某周期结束时间（Unix 秒）；领取截止 = 结束时间 + CLAIM_DEADLINE_SECONDS（90 天）
    function setPeriodEndTimestamp(bytes32 periodId, uint256 endTimestamp) external onlyOwner {
        periodEndTimestamp[periodId] = endTimestamp;
        emit PeriodEndTimestampSet(periodId, endTimestamp);
    }

    /// @notice 内部：该周期是否已过领取截止（未设置结束时间时不启用截止）
    function _claimDeadlinePassed(bytes32 pid) internal view returns (bool) {
        uint256 endTs = periodEndTimestamp[pid];
        return endTs != 0 && block.timestamp > endTs + CLAIM_DEADLINE_SECONDS;
    }

    /// @notice 内部：某账户在某周期某代币的待领总额（未封顶、未扣单次上限；过期或已回流返回 0）
    function _remainingEntitlement(bytes32 pid, address token, address account) internal view returns (uint256) {
        if (_claimDeadlinePassed(pid) || unclaimedRolledOver[pid][token]) return 0;

        uint256 myScore = contributionScore[pid][account];
        if (myScore == 0) return 0;

        uint256 pool = periodReward[pid][token];
        if (pool == 0) return 0;
        uint256 distributable = (pool * (10000 - reserveBps)) / 10000;

        if (useReputationWeighting) {
            uint256 myReputation = reputationScore[account];
            if (myReputation == 0) return 0;
            uint256 myWeightedScore = (myScore * myReputation) / 10000;
            uint256 totalWeightedScore = periodTotalWeightedScore[pid];
            if (totalWeightedScore == 0) return 0;
            return (distributable * myWeightedScore) / totalWeightedScore - claimed[pid][token][account];
        }
        uint256 total = periodTotalScore[pid];
        if (total == 0) return 0;
        return (distributable * myScore) / total - claimed[pid][token][account];
    }

    /// @notice 领取某周期某代币的应得奖励（方案 A）：周期结束后 90 天内可领，逾期禁止
    /// @notice 每次领取不超过该周期奖励池的 10%，可多次领取直到领完应得部分
    /// @notice 如果启用信誉加权分配（useReputationWeighting=true），奖励按（贡献分 * 信誉分数/10000）分配
    function claimReward(string calldata period, address token) external {
        bytes32 pid = _periodId(period);

        require(!_claimDeadlinePassed(pid), "ContributorReward: claim deadline passed");
        require(!unclaimedRolledOver[pid][token], "ContributorReward: claim deadline passed");

        // 检查信誉阈值（如果启用）
        if (reputationThreshold > 0) {
            require(reputationScore[msg.sender] >= reputationThreshold, "ContributorReward: reputation too low");
        }
        
        uint256 myScore = contributionScore[pid][msg.sender];
        require(myScore > 0, "ContributorReward: no score");

        uint256 pool = periodReward[pid][token];
        require(pool > 0, "ContributorReward: no reward pool");

        uint256 totalClaimable = _remainingEntitlement(pid, token, msg.sender);
        require(totalClaimable > 0, "ContributorReward: nothing to claim");

        // 每次领取不超过奖励池的 10%（方案 A 保留）
        uint256 maxPerClaim = pool / 10;
        uint256 amount = totalClaimable > maxPerClaim ? maxPerClaim : totalClaimable;

        claimed[pid][token][msg.sender] += amount;
        periodTotalClaimed[pid][token] += amount;
        require(IERC20(token).transfer(msg.sender, amount), "ContributorReward: transfer failed");
        emit RewardClaimed(pid, msg.sender, token, amount);
    }

    /// @notice 回流（方案 A）：某周期领取窗结束后，把逾期未领部分（可分配额 − 已领总额）划入下一期奖池。
    /// 仅 owner 可调用；每个周期每代币只可回流一次；回流后原周期不可再领取（claimable 归零）。
    /// @return amount 实际回流金额
    function rolloverUnclaimed(string calldata fromPeriod, string calldata toPeriod, address token) external onlyOwner returns (uint256 amount) {
        require(token != address(0), "ContributorReward: zero token");
        bytes32 fromPid = _periodId(fromPeriod);
        bytes32 toPid = _periodId(toPeriod);
        require(fromPid != toPid, "ContributorReward: same period");
        require(_claimDeadlinePassed(fromPid), "ContributorReward: claim window not ended");
        require(!unclaimedRolledOver[fromPid][token], "ContributorReward: already rolled over");

        uint256 pool = periodReward[fromPid][token];
        uint256 distributable = (pool * (10000 - reserveBps)) / 10000;
        amount = distributable - periodTotalClaimed[fromPid][token];

        unclaimedRolledOver[fromPid][token] = true;
        periodReward[fromPid][token] = pool - amount;
        periodReward[toPid][token] += amount;
        emit UnclaimedRolledOver(fromPid, toPid, token, amount);
    }
    

    /// @notice 查询某账户在某周期某代币上【单次可领】金额：与 claimReward 实际发放一致，
    /// 即待领总额与奖池 10% 上限取小；已过领取截止或已回流返回 0（前端按此展示，勿再按全额）
    function claimable(string calldata period, address token, address account) external view returns (uint256) {
        bytes32 pid = _periodId(period);
        uint256 remaining = _remainingEntitlement(pid, token, account);
        if (remaining == 0) return 0;
        uint256 maxPerClaim = periodReward[pid][token] / 10;
        return remaining > maxPerClaim ? maxPerClaim : remaining;
    }

    /// @notice 查询某账户在某周期某代币上的【待领总额】（未封顶）；已过领取截止或已回流返回 0
    function claimableTotal(string calldata period, address token, address account) external view returns (uint256) {
        return _remainingEntitlement(_periodId(period), token, account);
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

    /// @notice 提交 gas 库存款贡献证明（函数名沿用 submitLiquidityProof：该线
    ///         原为 AMM 流动性线，第 42 轮改记 gas 库存款——存款人向 gas 库注资后调用）
    /// @param period 周期
    /// @param liquidityAmount 存款数量（以稳定币计价，如 USDC；参数名沿用）
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
        uint256 newScore = _computeGasVaultScore(liquidityAmount);

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

    /// @notice 计算 gas 库存款贡献分
    /// @param liquidityAmount 存款数量（以稳定币计价；参数名沿用）
    /// @dev 尺度对齐（第 42 轮修正）：旧实现为 base * weight / 100，与其他三线
    ///      (base + part) * weight 的尺度差 100 倍——同一周期内跨线分配时，
    ///      该线实际占比被压到名义权重的 1/100，权重数字失去含义。本轮起
    ///      与其他线同尺度：base * WEIGHT_GAS_VAULT（权重 25%）。
    function _computeGasVaultScore(uint256 liquidityAmount) internal pure returns (uint256) {
        uint256 base = SCALE; // 基础分 1e18
        if (CAP_LIQUIDITY > 0 && liquidityAmount > 0) {
            uint256 liquidityPart = liquidityAmount * SCALE / CAP_LIQUIDITY;
            if (liquidityPart > SCALE) liquidityPart = SCALE;
            base += liquidityPart;
        }
        return base * WEIGHT_GAS_VAULT; // 权重 25%
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ContributorReward: zero address");
        owner = newOwner;
        emit OwnershipTransferred(msg.sender, newOwner);
    }
}
