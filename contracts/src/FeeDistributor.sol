// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title FeeDistributor 手续费分配
/// @notice 接收手续费：开发者固定 5% 自动转至开发者地址；其余按比例由接收方 claim
contract FeeDistributor {
    address public owner;
    /// @notice 治理合约地址，可执行提案设置手续费分成（setRecipients/setDeveloperAddress）
    address public governance;
    address public vault; // 若手续费先入 Vault 再转本合约，可不用；若直接转本合约则需记录

    /// @notice 开发者地址，收取手续费的固定 1%，无需手动领取
    address public developerAddress;
    /// @notice 开发者分成比例（万分比），永久 1%
    uint16 public constant DEVELOPER_SHARE_BPS = 100;

    /// 分配对象与比例（万分比，10000 = 100%）；仅针对「扣除开发者 5% 后的剩余部分」
    struct Recipient {
        address account;
        uint16 shareBps; // basis points
    }
    Recipient[] public recipients;
    uint16 public totalShareBps;

    /// token => 未领取的累计金额（不含已转给开发者的 5%）
    mapping(address => uint256) public accumulated;
    /// token => account => 已领取
    mapping(address => mapping(address => uint256)) public claimed;

    event FeeReceived(address indexed token, uint256 amount);
    event DeveloperPaid(address indexed token, address indexed developer, uint256 amount);
    event DeveloperSet(address indexed developer);
    event RecipientSet(uint256 index, address account, uint16 shareBps);
    event Claimed(address indexed account, address indexed token, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event GovernanceSet(address indexed governance);

    modifier onlyOwner() {
        require(msg.sender == owner, "FeeDistributor: not owner");
        _;
    }

    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner || (governance != address(0) && msg.sender == governance), "FeeDistributor: not auth");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice 设置治理合约；仅 owner 可调用
    function setGovernance(address _governance) external onlyOwner {
        governance = _governance;
        emit GovernanceSet(_governance);
    }

    /// @notice 设置分配对象（会覆盖原有列表）；owner 或 governance 可调用
    function setRecipients(address[] calldata accounts, uint16[] calldata shareBps) external onlyOwnerOrGovernance {
        uint256 len = accounts.length;
        require(len == shareBps.length, "FeeDistributor: length mismatch");
        delete recipients;
        uint16 _total = 0;
        for (uint256 i = 0; i < len; ) {
            address acct = accounts[i];
            require(acct != address(0), "FeeDistributor: zero address");
            _total += shareBps[i];
            recipients.push(Recipient(acct, shareBps[i]));
            emit RecipientSet(i, acct, shareBps[i]);
            unchecked { ++i; }
        }
        uint256 maxBps = developerAddress == address(0) ? 10000 : (10000 - DEVELOPER_SHARE_BPS);
        require(_total <= maxBps, "FeeDistributor: share overflow"); // 开发者 1%，其余最多 99%
        totalShareBps = _total;
    }

    /// @notice 设置开发者地址（收取 1% 手续费，每次到账自动转入）；owner 或 governance 可调用
    function setDeveloperAddress(address _developer) external onlyOwnerOrGovernance {
        developerAddress = _developer;
        emit DeveloperSet(_developer);
    }

    /// @notice 接收手续费（由 Settlement 或 AMM 转入）：1% 自动转开发者，99% 进入分配池供 claim
    function receiveFee(address token, uint256 amount) external {
        require(token != address(0) && amount > 0, "FeeDistributor: invalid input");
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "FeeDistributor: transfer failed");

        address _dev = developerAddress;
        uint256 developerAmount = _dev != address(0) ? (amount * DEVELOPER_SHARE_BPS) / 10000 : 0;
        uint256 toAccumulate;
        if (developerAmount != 0) {
            require(IERC20(token).transfer(_dev, developerAmount), "FeeDistributor: developer transfer failed");
            emit DeveloperPaid(token, _dev, developerAmount);
            unchecked { toAccumulate = amount - developerAmount; }
        } else {
            toAccumulate = amount;
        }
        accumulated[token] += toAccumulate;
        emit FeeReceived(token, amount);
    }

    /// @notice 领取某代币的应得份额（按当前余额与比例）
    function claim(address token) external {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint16 _totalBps = totalShareBps;
        require(balance > 0 && _totalBps > 0, "FeeDistributor: nothing to claim");
        uint256 myShareBps = 0;
        uint256 len = recipients.length;
        for (uint256 i = 0; i < len; ) {
            if (recipients[i].account == msg.sender) {
                myShareBps = recipients[i].shareBps;
                break;
            }
            unchecked { ++i; }
        }
        require(myShareBps > 0, "FeeDistributor: not recipient");
        uint256 acc = accumulated[token];
        uint256 amt;
        unchecked { amt = (acc * myShareBps) / _totalBps - claimed[token][msg.sender]; }
        require(amt > 0, "FeeDistributor: zero amount");
        claimed[token][msg.sender] += amt;
        require(IERC20(token).transfer(msg.sender, amt), "FeeDistributor: transfer failed");
        emit Claimed(msg.sender, token, amt);
    }

    /// @notice 查询某账户在某代币上可领取金额
    function claimable(address token, address account) external view returns (uint256) {
        uint16 _totalBps = totalShareBps;
        if (_totalBps == 0) return 0;
        uint256 myShareBps = 0;
        uint256 len = recipients.length;
        for (uint256 i = 0; i < len; ) {
            if (recipients[i].account == account) {
                myShareBps = recipients[i].shareBps;
                break;
            }
            unchecked { ++i; }
        }
        if (myShareBps == 0) return 0;
        unchecked { return (accumulated[token] * myShareBps) / _totalBps - claimed[token][account]; }
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "FeeDistributor: zero address");
        owner = newOwner;
        emit OwnershipTransferred(msg.sender, newOwner);
    }
}
