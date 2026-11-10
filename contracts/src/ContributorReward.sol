// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ContributorReward 贡献奖励（按周期、按贡献分分配固定总量）
/// @notice 合约按贡献分占比发放该周期奖励池；与 FeeDistributor 并列，不扩展 FeeDistributor。
/// @notice 第 61 轮起废除自签自证：贡献事实须由【注册计量人】以 EIP-712 签名证明
///         （计量人按贡献线分权注册、密钥与被计量账户分离，签名绑定 chainId/周期/
///         账户/指标/证据根/nonce/截止时间，nonce 一次性消费防重放）；周期结束由
///         owner 冻结（冻结后禁再提交/改分，分配分母锚定冻结时刻总数，纠错只能
///         走下一周期追加；领取须在冻结后进行）。计量签名是「可审计贡献事实的
///         认证」，不是事实本身。
contract ContributorReward is EIP712 {
    address public owner;
    address public governance;

    /// EIP-712 计量证明类型哈希：指标线 = nodeType（0 中继 / 1 挂单 / 2 结算提交 / 3 gas 库存款）
    bytes32 private constant METRIC_ATTESTATION_TYPEHASH = keccak256(
        "MetricAttestation(address account,bytes32 periodId,uint8 metricType,uint256 uptime,uint256 postingMetric,uint256 storageTotalGB,uint256 bytesRelayed,uint256 tradesMatched,uint256 volumeMatched,bytes32 evidenceRoot,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant LIQUIDITY_ATTESTATION_TYPEHASH = keccak256(
        "LiquidityAttestation(address account,bytes32 periodId,uint256 amount,bytes32 evidenceRoot,uint256 nonce,uint256 deadline)"
    );

    /// metricType => 计量人 => 是否授权（按线分权：一线的计量人不能签另一线）
    mapping(uint8 => mapping(address => bool)) public measurers;
    /// 已消费证明键 = keccak256(abi.encode(计量人, 账户, periodId, metricType, nonce))
    mapping(bytes32 => bool) public attestationConsumed;
    /// periodId => 是否已冻结
    mapping(bytes32 => bool) public periodFrozen;
    /// periodId => 冻结时锚定的最终分数根（链下按最终分数表折成，供事后审计重算）
    mapping(bytes32 => bytes32) public periodScoresRoot;
    /// periodId => 冻结时刻的总贡献分 / 总加权分（冻结后分配分母以此为准）
    mapping(bytes32 => uint256) public periodFrozenTotalScore;
    mapping(bytes32 => uint256) public periodFrozenTotalWeightedScore;

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
    /// account => 信誉分数。历史上唯一的写入入口（owner 手填分入口）已在
    /// 第 63 轮审查修复批删除（零调用核实：4 个已部署实例全生命周期
    /// ReputationScoreSet 事件 0 条——见 round63 文档 §14），故本映射在本
    /// 版本恒为 0：仅保留存储与 getter 供既有部署的接口兼容；双周计量的
    /// 正道是计量人签名证明（submitAttestation），信誉若将来启用须走同一
    /// 签名门，不得再开手填入口。
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
    event MeasurerSet(uint8 indexed metricType, address indexed measurer, bool enabled);
    event PeriodFrozen(bytes32 indexed periodId, bytes32 scoresRoot, uint256 totalScore, uint256 totalWeightedScore);
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

    constructor() EIP712("Bit100 ContributorReward", "1") {
        owner = msg.sender;
    }

    /// @notice 注册/注销某贡献线的计量人（仅 owner）。计量人是离线计量 CLI 的
    ///         签名身份，私钥独立保管、不得与被计量账户或部署者共用（见轮次文档）。
    function setMeasurer(uint8 metricType, address measurer, bool enabled) external onlyOwner {
        require(measurer != address(0), "ContributorReward: zero address");
        measurers[metricType][measurer] = enabled;
        emit MeasurerSet(metricType, measurer, enabled);
    }

    /// @notice 冻结某周期（仅 owner）：冻结后该周期的证明提交与一切改分路径关闭，
    ///         分配分母锚定冻结时刻总数，最终分数根上链存证。纠错只能走下一周期
    ///         追加记录，不得回改已冻结周期的份额。领取以冻结为前置条件（审查
    ///         修复批 P1-01）：未冻结周期不可领取——冻结正是让领取所依据的分数定版。
    /// @param scoresRoot 链下按最终分数表（账户→分数）折成的 Merkle 根，事后可重算核对
    function freezePeriod(string calldata period, bytes32 scoresRoot) external onlyOwner {
        bytes32 pid = _periodId(period);
        require(!periodFrozen[pid], "ContributorReward: already frozen");
        periodFrozen[pid] = true;
        periodScoresRoot[pid] = scoresRoot;
        periodFrozenTotalScore[pid] = periodTotalScore[pid];
        periodFrozenTotalWeightedScore[pid] = periodTotalWeightedScore[pid];
        emit PeriodFrozen(pid, scoresRoot, periodTotalScore[pid], periodTotalWeightedScore[pid]);
    }

    /// @notice 计量证明的 EIP-712 摘要（供计量人离线签名与任何人复核；域含 chainId 与本合约）
    function metricAttestationDigest(
        address account,
        bytes32 periodId,
        uint8 metricType,
        uint256 uptime,
        uint256 postingMetric,
        uint256 storageTotalGB,
        uint256 bytesRelayed,
        uint256 tradesMatched,
        uint256 volumeMatched,
        bytes32 evidenceRoot,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            METRIC_ATTESTATION_TYPEHASH,
            account,
            periodId,
            metricType,
            uptime,
            postingMetric,
            storageTotalGB,
            bytesRelayed,
            tradesMatched,
            volumeMatched,
            evidenceRoot,
            nonce,
            deadline
        )));
    }

    /// @notice gas 库存款证明的 EIP-712 摘要（metricType 固定为 3）
    function liquidityAttestationDigest(
        address account,
        bytes32 periodId,
        uint256 amount,
        bytes32 evidenceRoot,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            LIQUIDITY_ATTESTATION_TYPEHASH,
            account,
            periodId,
            amount,
            evidenceRoot,
            nonce,
            deadline
        )));
    }

    /// @dev 校验计量人证明并消费 nonce：签名者必须是该指标线的注册计量人；
    ///      同一（计量人, 账户, 周期, 指标, nonce）组合只能成功提交一次。
    function _verifyMeasurer(
        bytes32 digest,
        bytes calldata signature,
        uint8 metricType,
        address account,
        bytes32 pid,
        uint256 nonce,
        uint256 deadline
    ) internal {
        require(block.timestamp <= deadline, "ContributorReward: attestation expired");
        address measurer = ECDSA.recover(digest, signature);
        require(measurers[metricType][measurer], "ContributorReward: unregistered measurer");
        bytes32 key = keccak256(abi.encode(measurer, account, pid, metricType, nonce));
        require(!attestationConsumed[key], "ContributorReward: attestation replayed");
        attestationConsumed[key] = true;
    }

    /// @dev 把新分数记到账户（同周期重交以新证明为准：扣旧加新，含信誉加权口径）
    function _applyScore(bytes32 pid, address account, uint256 newScore) internal {
        uint256 oldScore = contributionScore[pid][account];
        if (oldScore > 0) {
            periodTotalScore[pid] -= oldScore;
            if (useReputationWeighting) {
                uint256 oldWeightedScore = (oldScore * reputationScore[account]) / 10000;
                periodTotalWeightedScore[pid] -= oldWeightedScore;
            }
        }
        periodTotalScore[pid] += newScore;
        contributionScore[pid][account] = newScore;
        if (useReputationWeighting) {
            uint256 newWeightedScore = (newScore * reputationScore[account]) / 10000;
            periodTotalWeightedScore[pid] += newWeightedScore;
        }
        emit ProofSubmitted(pid, account, newScore);
    }

    function _periodId(string calldata period) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(period));
    }

    /// @notice 提交贡献证明（基础版：无结算提交字段，摘要中 trades/volume 记 0）
    /// @dev 第 61 轮起：signature 必须是该 nodeType 线【注册计量人】对 EIP-712
    ///      MetricAttestation 的签名（见 metricAttestationDigest）；account 是被
    ///      计量账户，提交者可为任意人（自签自证已废除）。evidenceRoot 绑定链下
    ///      证据（如计量明细的 Merkle 根），nonce 在（计量人, 账户, 周期, 指标）
    ///      内唯一且一次性消费。
    function submitProof(
        string calldata period,
        address account,
        uint256 uptime,
        uint256 storageUsedGB,
        uint256 storageTotalGB,
        uint256 bytesRelayed,
        uint8 nodeType,
        bytes32 evidenceRoot,
        uint256 nonce,
        uint256 deadline,
        bytes calldata measurerSignature
    ) external {
        require(bytes(period).length > 0, "ContributorReward: empty period");
        require(account != address(0), "ContributorReward: zero address");
        require(uptime <= SCALE, "ContributorReward: uptime > 1e18");
        // 审查修复批（P2-01）：gas 库存款线（nodeType==3）只接受 submitLiquidityProof
        // 的 LiquidityAttestation（绑定存款金额）；通用入口对该线一律回滚，防止以
        // MetricAttestation 的 uptime 占位口径绕过金额绑定取得存款线分数。
        require(nodeType != 3, "ContributorReward: liquidity line only");
        bytes32 pid = _periodId(period);
        require(!periodFrozen[pid], "ContributorReward: period frozen");
        bytes32 digest = metricAttestationDigest(
            account, pid, nodeType, uptime, storageUsedGB, storageTotalGB, bytesRelayed, 0, 0, evidenceRoot, nonce, deadline
        );
        _verifyMeasurer(digest, measurerSignature, nodeType, account, pid, nonce, deadline);
        uint256 newScore = _computeScore(uptime, storageUsedGB, storageTotalGB, bytesRelayed, 0, 0, nodeType);
        _applyScore(pid, account, newScore);
    }

    /// @notice 提交贡献证明（扩展版：含结算提交 tradesMatched/volumeMatched，nodeType=2 为结算提交线）
    function submitProofEx(
        string calldata period,
        address account,
        uint256 uptime,
        uint256 storageUsedGB,
        uint256 storageTotalGB,
        uint256 bytesRelayed,
        uint256 tradesMatched,
        uint256 volumeMatched,
        uint8 nodeType,
        bytes32 evidenceRoot,
        uint256 nonce,
        uint256 deadline,
        bytes calldata measurerSignature
    ) external {
        require(bytes(period).length > 0, "ContributorReward: empty period");
        require(account != address(0), "ContributorReward: zero address");
        require(uptime <= SCALE, "ContributorReward: uptime > 1e18");
        // 审查修复批（P2-01）：同 submitProof——gas 库存款线只走 submitLiquidityProof。
        require(nodeType != 3, "ContributorReward: liquidity line only");
        bytes32 pid = _periodId(period);
        require(!periodFrozen[pid], "ContributorReward: period frozen");
        bytes32 digest = metricAttestationDigest(
            account, pid, nodeType, uptime, storageUsedGB, storageTotalGB, bytesRelayed, tradesMatched, volumeMatched, evidenceRoot, nonce, deadline
        );
        _verifyMeasurer(digest, measurerSignature, nodeType, account, pid, nonce, deadline);
        uint256 newScore = _computeScore(uptime, storageUsedGB, storageTotalGB, bytesRelayed, tradesMatched, volumeMatched, nodeType);
        _applyScore(pid, account, newScore);
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
            // gas 库存款：权重 25。审查修复批（P2-01）后通用入口已拦截 nodeType==3，
            // 本分支自外部不可达（存款分只由 submitLiquidityProof 的
            // _computeGasVaultScore 产生）；保留为防御性占位，不再是计分路径。
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
    /// @dev 审查修复批（P1-01）：领取以周期冻结为前置——未冻结周期一律返回 0，
    ///      claimReward 据此回滚、claimable/claimableTotal 视图口径与之保持一致。
    ///      原「未冻结时读实时总量」的三元回退自此在所有读取方均不可达，已删；
    ///      分母只读冻结时刻锚定值，不随事后记账漂移。
    function _remainingEntitlement(bytes32 pid, address token, address account) internal view returns (uint256) {
        if (!periodFrozen[pid]) return 0;
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
            // 分母 = 冻结时刻锚定的总加权分
            uint256 totalWeightedScore = periodFrozenTotalWeightedScore[pid];
            if (totalWeightedScore == 0) return 0;
            return (distributable * myWeightedScore) / totalWeightedScore - claimed[pid][token][account];
        }
        // 分母 = 冻结时刻锚定的总贡献分
        uint256 total = periodFrozenTotalScore[pid];
        if (total == 0) return 0;
        return (distributable * myScore) / total - claimed[pid][token][account];
    }

    /// @notice 领取某周期某代币的应得奖励（方案 A）：周期结束后 90 天内可领，逾期禁止
    /// @notice 每次领取不超过该周期奖励池的 10%，可多次领取直到领完应得部分
    /// @notice 如果启用信誉加权分配（useReputationWeighting=true），奖励按（贡献分 * 信誉分数/10000）分配
    /// @notice 审查修复批（P1-01）：领取须以该周期已冻结为前置——冻结前分数与总量
    ///         仍可变，按未定版份额发放会造成超领/剩余应得下溢，故未冻结一律回滚。
    function claimReward(string calldata period, address token) external {
        bytes32 pid = _periodId(period);

        require(periodFrozen[pid], "ContributorReward: period not frozen");
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

    // 第 63 轮（gas-1 搭车，管理员趋零法③）：setReputationScore / setReputationScores
    // 两个手工填信誉分入口已删除——信誉/贡献数据只许经计量人 EIP-712 证明进入，
    // 不再有 owner 直接写分。删除前零调用核实（全仓引用 + 双链双 CR 实例全生命
    // 周期事件扫描：ProofSubmitted / ReputationScoreSet / MeasurerSet 均为 0）
    // 证据见 docs/round63-bridge-gasvault-2026-11-10.md。

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
    
    // 注（第 63 轮审查修复批删除）：原外部入口
    // updateReputationAndRecalculateWeightedScore（owner 手填信誉分并同步重算
    // 各周期加权总数）已整函数删除——它是绕过计量人签名的管理面旁路，且无
    // 任何内部调用方（重算逻辑内联于该函数本身，随之删除）。删除前零调用
    // 核实：全仓 grep 无调用方；双链 4 个已部署实例全生命周期
    // ReputationScoreSet 事件 0 条（证据见 round63 文档 §14）。

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

    // 第 63 轮（gas-1 搭车，管理员趋零法③）：setContributionScore 手工填贡献分
    // 入口已删除——贡献分只许经计量人 EIP-712 证明（下方各 submit*Proof）进入。
    // 零调用核实证据同上（轮次文档）。

    /// @notice 提交 gas 库存款贡献证明（函数名沿用 submitLiquidityProof：该线
    ///         原为 AMM 流动性线，第 42 轮改记 gas 库存款）。
    /// @dev 第 61 轮起：signature 必须是 gas 库存款线（metricType=3）注册计量人对
    ///      EIP-712 LiquidityAttestation 的签名（见 liquidityAttestationDigest）。
    function submitLiquidityProof(
        string calldata period,
        address account,
        uint256 liquidityAmount,
        bytes32 evidenceRoot,
        uint256 nonce,
        uint256 deadline,
        bytes calldata measurerSignature
    ) external {
        require(bytes(period).length > 0, "ContributorReward: empty period");
        require(account != address(0), "ContributorReward: zero address");
        require(liquidityAmount > 0, "ContributorReward: zero liquidity");
        bytes32 pid = _periodId(period);
        require(!periodFrozen[pid], "ContributorReward: period frozen");
        bytes32 digest = liquidityAttestationDigest(account, pid, liquidityAmount, evidenceRoot, nonce, deadline);
        _verifyMeasurer(digest, measurerSignature, 3, account, pid, nonce, deadline);
        _applyScore(pid, account, _computeGasVaultScore(liquidityAmount));
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
