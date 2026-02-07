// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IERC20.sol";

/// @title Vault 资产托管
/// @notice 用户存入/提取资产，仅 Settlement 可划转用于结算
contract Vault {
    address public settlement;
    address public owner;

    /// user => token => balance
    mapping(address => mapping(address => uint256)) public balances;

    event Deposit(address indexed user, address indexed token, uint256 amount);
    event Withdraw(address indexed user, address indexed token, uint256 amount);
    event TransferOut(address indexed fromUser, address indexed to, address indexed token, uint256 amount);
    event SettlementSet(address indexed oldSettlement, address indexed newSettlement);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Vault: not owner");
        _;
    }

    modifier onlySettlement() {
        require(msg.sender == settlement, "Vault: not settlement");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setSettlement(address _settlement) external onlyOwner {
        require(_settlement != address(0), "Vault: zero address");
        address old = settlement;
        settlement = _settlement;
        emit SettlementSet(old, _settlement);
    }

    /// @notice 用户存入代币：需先 approve Vault
    function deposit(address token, uint256 amount) external {
        require(token != address(0) && amount > 0, "Vault: invalid input");
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "Vault: transfer failed");
        balances[msg.sender][token] += amount;
        emit Deposit(msg.sender, token, amount);
    }

    /// @notice 用户提取代币
    function withdraw(address token, uint256 amount) external {
        require(token != address(0) && amount > 0, "Vault: invalid input");
        require(balances[msg.sender][token] >= amount, "Vault: insufficient balance");
        balances[msg.sender][token] -= amount;
        require(IERC20(token).transfer(msg.sender, amount), "Vault: transfer failed");
        emit Withdraw(msg.sender, token, amount);
    }

    /// @notice 结算合约：从 fromUser 扣减并转至 to（仅 Settlement 调用），代币转出到 to 地址
    function transferOut(address fromUser, address to, address token, uint256 amount) external onlySettlement {
        require(token != address(0) && to != address(0) && amount > 0, "Vault: invalid input");
        require(balances[fromUser][token] >= amount, "Vault: insufficient balance");
        balances[fromUser][token] -= amount;
        require(IERC20(token).transfer(to, amount), "Vault: transfer failed");
        emit TransferOut(fromUser, to, token, amount);
    }

    /// @notice 结算合约：在托管账本内划转（仅 Settlement 调用），不转出代币
    function transferWithinVault(address fromUser, address toUser, address token, uint256 amount) external onlySettlement {
        require(token != address(0) && toUser != address(0) && amount > 0, "Vault: invalid input");
        require(balances[fromUser][token] >= amount, "Vault: insufficient balance");
        balances[fromUser][token] -= amount;
        balances[toUser][token] += amount;
        emit TransferOut(fromUser, toUser, token, amount);
    }

    function balanceOf(address token, address user) external view returns (uint256) {
        return balances[user][token];
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Vault: zero address");
        owner = newOwner;
        emit OwnershipTransferred(msg.sender, newOwner);
    }
}
