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
    uint256 private constant SCALE = 1e18;

    /// periodId => 该周期总贡献分
    mapping(bytes32 => uint256) public periodTotalScore;
    /// periodId => account => 贡献分
    mapping(bytes32 => mapping(address => uint256)) public contributionScore;
    /// periodId => token => 该周期奖励池总量（owner 注入）
    mapping(bytes32 => mapping(address => uint256)) public periodReward;
    /// periodId => token => account => 已领取
    mapping(bytes32 => mapping(address => mapping(address => uint256))) public claimed;

    event ProofSubmitted(bytes32 indexed periodId, address indexed account, uint256 score);
    event PeriodRewardSet(bytes32 indexed periodId, address indexed token, uint256 amount);
    event RewardClaimed(bytes32 indexed periodId, address indexed account, address indexed token, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ReserveBpsSet(uint16 oldBps, uint16 newBps);
    event FreeFlowBpsSet(uint16 oldBps, uint16 newBps);
    event GovernanceSet(address indexed governance);

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

    /// @notice 提交贡献证明；msg.sender 为领奖地址，签名需由该地址对应私钥生成
    /// @param signature 65 字节 ECDSA：r(32) || s(32) || v(1)，对 keccak256(abi.encodePacked(period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType)) 的签名
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
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            // bytes calldata: .offset points to data start
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
        uint256 newScore = _computeScore(uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType);

        if (oldScore > 0) {
            periodTotalScore[pid] -= oldScore;
        }
        periodTotalScore[pid] += newScore;
        contributionScore[pid][msg.sender] = newScore;

        emit ProofSubmitted(pid, msg.sender, newScore);
    }

    function _computeScore(
        uint256 uptime,
        uint256 storageUsedGB,
        uint256 /* storageTotalGB */,
        uint256 bytesRelayed,
        uint8 nodeType
    ) internal pure returns (uint256) {
        // relay: uptime + bytesRelayed 项；storage: uptime + storage 项
        uint256 storagePart = 0;
        uint256 relayPart = 0;
        if (nodeType == 1) {
            if (CAP_STORAGE_GB > 0 && storageUsedGB > 0) {
                storagePart = storageUsedGB * SCALE / CAP_STORAGE_GB;
                if (storagePart > SCALE) storagePart = SCALE;
            }
        } else {
            if (CAP_BYTES_RELAYED > 0 && bytesRelayed > 0) {
                relayPart = bytesRelayed * SCALE / CAP_BYTES_RELAYED;
                if (relayPart > SCALE) relayPart = SCALE;
            }
        }
        return uptime + storagePart + relayPart;
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

    /// @notice 领取某周期某代币的应得奖励
    function claimReward(string calldata period, address token) external {
        bytes32 pid = _periodId(period);
        uint256 total = periodTotalScore[pid];
        require(total > 0, "ContributorReward: no total score");
        uint256 myScore = contributionScore[pid][msg.sender];
        require(myScore > 0, "ContributorReward: no score");
        uint256 pool = periodReward[pid][token];
        require(pool > 0, "ContributorReward: no reward pool");
        uint256 distributable = (pool * (10000 - reserveBps)) / 10000;
        uint256 amount = (distributable * myScore) / total - claimed[pid][token][msg.sender];
        require(amount > 0, "ContributorReward: nothing to claim");
        claimed[pid][token][msg.sender] += amount;
        require(IERC20(token).transfer(msg.sender, amount), "ContributorReward: transfer failed");
        emit RewardClaimed(pid, msg.sender, token, amount);
    }

    /// @notice 查询某账户在某周期某代币上可领取金额
    function claimable(string calldata period, address token, address account) external view returns (uint256) {
        bytes32 pid = _periodId(period);
        uint256 total = periodTotalScore[pid];
        if (total == 0) return 0;
        uint256 myScore = contributionScore[pid][account];
        if (myScore == 0) return 0;
        uint256 pool = periodReward[pid][token];
        if (pool == 0) return 0;
        uint256 distributable = (pool * (10000 - reserveBps)) / 10000;
        uint256 amount = (distributable * myScore) / total - claimed[pid][token][account];
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

    /// @notice 查询某周期某账户的贡献分
    function getContributionScore(string calldata period, address account) external view returns (uint256) {
        return contributionScore[_periodId(period)][account];
    }

    /// @notice 查询某周期总贡献分
    function getPeriodTotalScore(string calldata period) external view returns (uint256) {
        return periodTotalScore[_periodId(period)];
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ContributorReward: zero address");
        owner = newOwner;
        emit OwnershipTransferred(msg.sender, newOwner);
    }
}
