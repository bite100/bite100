// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IERC20.sol";

/// @title FeeDistributor 手续费分配
/// @notice 接收手续费，支持按比例分配与 claim
contract FeeDistributor {
    address public owner;
    address public vault; // 若手续费先入 Vault 再转本合约，可不用；若直接转本合约则需记录

    /// 分配对象与比例（万分比，10000 = 100%）
    struct Recipient {
        address account;
        uint16 shareBps; // basis points
    }
    Recipient[] public recipients;
    uint16 public totalShareBps;

    /// token => 未领取的累计金额
    mapping(address => uint256) public accumulated;
    /// token => account => 已领取
    mapping(address => mapping(address => uint256)) public claimed;

    event FeeReceived(address indexed token, uint256 amount);
    event RecipientSet(uint256 index, address account, uint16 shareBps);
    event Claimed(address indexed account, address indexed token, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "FeeDistributor: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice 设置分配对象（会覆盖原有列表）
    function setRecipients(address[] calldata accounts, uint16[] calldata shareBps) external onlyOwner {
        require(accounts.length == shareBps.length, "FeeDistributor: length mismatch");
        delete recipients;
        totalShareBps = 0;
        for (uint256 i = 0; i < accounts.length; i++) {
            require(accounts[i] != address(0), "FeeDistributor: zero address");
            totalShareBps += shareBps[i];
            recipients.push(Recipient(accounts[i], shareBps[i]));
            emit RecipientSet(i, accounts[i], shareBps[i]);
        }
        require(totalShareBps <= 10000, "FeeDistributor: share > 100%");
    }

    /// @notice 接收手续费（由 Settlement 或 AMM 转入）
    function receiveFee(address token, uint256 amount) external {
        require(token != address(0) && amount > 0, "FeeDistributor: invalid input");
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "FeeDistributor: transfer failed");
        accumulated[token] += amount;
        emit FeeReceived(token, amount);
    }

    /// @notice 领取某代币的应得份额（按当前余额与比例）
    function claim(address token) external {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0 && totalShareBps > 0, "FeeDistributor: nothing to claim");
        uint256 myShareBps = 0;
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i].account == msg.sender) {
                myShareBps = recipients[i].shareBps;
                break;
            }
        }
        require(myShareBps > 0, "FeeDistributor: not recipient");
        uint256 amount = (accumulated[token] * myShareBps) / totalShareBps - claimed[token][msg.sender];
        require(amount > 0, "FeeDistributor: zero amount");
        claimed[token][msg.sender] += amount;
        require(IERC20(token).transfer(msg.sender, amount), "FeeDistributor: transfer failed");
        emit Claimed(msg.sender, token, amount);
    }

    /// @notice 查询某账户在某代币上可领取金额
    function claimable(address token, address account) external view returns (uint256) {
        uint256 myShareBps = 0;
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i].account == account) {
                myShareBps = recipients[i].shareBps;
                break;
            }
        }
        if (myShareBps == 0 || totalShareBps == 0) return 0;
        return (accumulated[token] * myShareBps) / totalShareBps - claimed[token][account];
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "FeeDistributor: zero address");
        owner = newOwner;
        emit OwnershipTransferred(msg.sender, newOwner);
    }
}
