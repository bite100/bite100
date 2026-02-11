// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title NodeRewards 上线激励（开发者积分 + 节点积分 + 统一领取 + 防 Sybil 基础）
/// @notice 与 ContributorReward 并列：本合约仅负责「主网上线时」的 devPoints/nodePoints 分配与 claim；周期贡献奖励仍走 ContributorReward
/// @dev 1 开发者积分 = 1 USDT（6 decimals）；节点积分按 snapshot 分配，不按 1:1
contract NodeRewards {
    address public owner;
    IERC20 public usdt;
    /// @notice Settlement 合约地址，可调用 depositFounderReward 将批量结算 gas 节省 25% 记为创始人积分
    address public settlement;

    mapping(address => uint256) public devPoints;
    mapping(address => uint256) public nodePoints;
    /// @notice 防 Sybil：每个钱包已绑定节点数，上限 MAX_NODES_PER_WALLET
    mapping(address => uint256) public boundNodeCount;
    uint256 public constant MAX_NODES_PER_WALLET = 3;

    event PointsAllocated(address indexed wallet, uint256 devAmount, uint256 nodeAmount);
    event RewardsClaimed(address indexed wallet, uint256 total);
    event NodeBound(address indexed wallet, bytes32 nodeId);
    event FounderRewardDeposited(address indexed founder, uint256 usdtAmount6, uint256 points);
    event SettlementSet(address indexed settlement);

    modifier onlyOwner() {
        require(msg.sender == owner, "NodeRewards: not owner");
        _;
    }

    constructor(address _usdt) {
        owner = msg.sender;
        usdt = IERC20(_usdt);
    }

    /// @notice 设置 Settlement 地址（仅 owner）；Settlement 可调用 depositFounderReward
    function setSettlement(address _settlement) external onlyOwner {
        settlement = _settlement;
        emit SettlementSet(_settlement);
    }

    /// @notice 批量结算 gas 节省 25% 以 USDT 转入并记为创始人积分（1 USDT = 1 积分）；仅 Settlement 可调用
    /// @param founder 创始人地址
    /// @param usdtAmount6 USDT 数量（6 位小数）
    function depositFounderReward(address founder, uint256 usdtAmount6) external {
        require(msg.sender == settlement && settlement != address(0), "NodeRewards: not settlement");
        require(founder != address(0) && usdtAmount6 > 0, "NodeRewards: invalid input");
        require(IERC20(usdt).transferFrom(msg.sender, address(this), usdtAmount6), "NodeRewards: transfer failed");
        uint256 points = usdtAmount6 / 1e6;
        if (points > 0) {
            devPoints[founder] += points;
            emit FounderRewardDeposited(founder, usdtAmount6, points);
        }
    }

    /// @notice 绑定钱包并登记节点（前端/节点调用）；防 Sybil：每钱包最多绑定 MAX_NODES_PER_WALLET 个节点
    /// @param nodeId 节点 ID 的 hash（如 keccak256(abi.encodePacked(peerId))），可选存储用于 off-chain 监控
    function bindAndRegister(bytes32 nodeId) external {
        require(boundNodeCount[msg.sender] < MAX_NODES_PER_WALLET, "NodeRewards: max nodes per wallet");
        boundNodeCount[msg.sender]++;
        emit NodeBound(msg.sender, nodeId);
    }

    /// @notice Governance/多签：上线前批量分配开发者积分与节点积分
    /// @param wallets 领奖地址
    /// @param devAmounts 开发者积分（1 积分 = 1 USDT）
    /// @param nodeAmounts 节点积分（按 snapshot 规则，同 1 积分 = 1 USDT 发放）
    function allocatePoints(
        address[] calldata wallets,
        uint256[] calldata devAmounts,
        uint256[] calldata nodeAmounts
    ) external onlyOwner {
        require(
            wallets.length == devAmounts.length && wallets.length == nodeAmounts.length,
            "NodeRewards: length mismatch"
        );
        for (uint256 i = 0; i < wallets.length; i++) {
            devPoints[wallets[i]] += devAmounts[i];
            nodePoints[wallets[i]] += nodeAmounts[i];
            emit PointsAllocated(wallets[i], devAmounts[i], nodeAmounts[i]);
        }
    }

    /// @notice 用户一键领取：开发者积分 + 节点积分，以 USDT 转出（1 积分 = 1 USDT，6 decimals）
    function claimRewards() external {
        uint256 total = devPoints[msg.sender] + nodePoints[msg.sender];
        require(total > 0, "NodeRewards: no rewards");
        uint256 amount = total * 1e6; // USDT 6 decimals
        require(usdt.balanceOf(address(this)) >= amount, "NodeRewards: insufficient USDT pool");

        devPoints[msg.sender] = 0;
        nodePoints[msg.sender] = 0;
        require(usdt.transfer(msg.sender, amount), "NodeRewards: transfer failed");
        emit RewardsClaimed(msg.sender, total);
    }

    /// @notice 查询某地址可领总额（积分）
    function getTotalRewards(address wallet) external view returns (uint256) {
        return devPoints[wallet] + nodePoints[wallet];
    }

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "NodeRewards: zero address");
        owner = newOwner;
    }
}
