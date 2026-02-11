// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title AirdropDistributor
/// @notice 简单的批量空投合约，由 Governance / 多签控制，从合约余额中按列表一次性分发代币
/// @dev 使用模式：
/// - 1）将奖励代币转入本合约（如从 FeeDistributor / 国库转入）
/// - 2）由 Governance / 多签调用 batchDistribute，传入 token/address/amounts 列表
/// - 3）所有在列表中的地址会直接收到代币，无需用户自行 claim
contract AirdropDistributor {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event BatchDistributed(address indexed token, uint256 totalRecipients, uint256 totalAmount);

    modifier onlyOwner() {
        require(msg.sender == owner, "AirdropDistributor: not owner");
        _;
    }

    constructor(address _owner) {
        require(_owner != address(0), "AirdropDistributor: zero owner");
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    /// @notice 批量分发某个 ERC20 代币给一组地址（从本合约余额中扣除）
    /// @param token 要分发的 ERC20 代币地址
    /// @param recipients 接收地址列表
    /// @param amounts 每个地址对应的分发数量（与 recipients 一一对应）
    function batchDistribute(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyOwner {
        require(token != address(0), "AirdropDistributor: zero token");
        require(recipients.length == amounts.length, "AirdropDistributor: length mismatch");
        require(recipients.length > 0, "AirdropDistributor: empty recipients");

        IERC20 erc20 = IERC20(token);
        uint256 total = 0;

        // 先计算总额，避免在循环中多次读取 balanceOf
        for (uint256 i = 0; i < amounts.length; i++) {
            total += amounts[i];
        }

        require(erc20.balanceOf(address(this)) >= total, "AirdropDistributor: insufficient balance");

        for (uint256 i = 0; i < recipients.length; i++) {
            address to = recipients[i];
            uint256 amount = amounts[i];
            if (to == address(0) || amount == 0) {
                continue;
            }
            require(erc20.transfer(to, amount), "AirdropDistributor: transfer failed");
        }

        emit BatchDistributed(token, recipients.length, total);
    }

    /// @notice Owner 可转移合约所有权（通常用于移交 Governance / 多签）
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "AirdropDistributor: zero owner");
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    /// @notice 紧急赎回接口（仅限 owner），用于错误配置或下线时回收剩余代币
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "AirdropDistributor: zero to");
        require(token != address(0), "AirdropDistributor: zero token");
        require(amount > 0, "AirdropDistributor: zero amount");
        require(IERC20(token).transfer(to, amount), "AirdropDistributor: transfer failed");
    }
}

