// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title OrderNonceManager 订单Nonce管理器（防重放攻击）
/// @notice 管理每个用户的订单nonce，防止订单重放攻击
contract OrderNonceManager {
    /// @notice 用户nonce映射（user => nonce）
    mapping(address => uint256) public userNonces;
    
    /// @notice 已使用的nonce（user => nonce => used）
    mapping(address => mapping(uint256 => bool)) public usedNonces;
    
    /// @notice 事件：Nonce使用
    event NonceUsed(address indexed user, uint256 nonce);
    
    /// @notice 检查并标记nonce为已使用（防重放攻击）
    /// @param user 用户地址
    /// @param nonce 订单nonce
    function useNonce(address user, uint256 nonce) internal {
        require(user != address(0), "OrderNonce: zero address");
        require(!usedNonces[user][nonce], "OrderNonce: nonce already used");
        
        // 检查nonce必须大于等于当前nonce（防止乱序）
        require(nonce >= userNonces[user], "OrderNonce: nonce too low");
        
        usedNonces[user][nonce] = true;
        userNonces[user] = nonce + 1; // 更新当前nonce
        
        emit NonceUsed(user, nonce);
    }
    
    /// @notice 检查nonce是否有效（未使用且大于等于当前nonce）
    function isValidNonce(address user, uint256 nonce) external view returns (bool) {
        if (user == address(0)) return false;
        if (usedNonces[user][nonce]) return false;
        if (nonce < userNonces[user]) return false;
        return true;
    }
    
    /// @notice 获取用户当前nonce
    function getCurrentNonce(address user) external view returns (uint256) {
        return userNonces[user];
    }
}
