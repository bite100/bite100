// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title OrderNonceManager 订单Nonce管理器（防重放攻击）
/// @notice 第 62 轮起改为 Permit2（SignatureTransfer）式无序位图语义：
/// 每个用户的 nonce 空间是一张按 256 位分字的位图，nonce 的高 248 位选字
/// （wordPos）、低 8 位选位（bitPos）；某 nonce 被结算消耗 ⇔ 对应位置 1。
/// nonce 之间无顺序关系——先签的单可以后结、低 nonce 不被高 nonce 的
/// 结算阻塞（旧单调水位语义已废除）。语义逐字借 Uniswap Permit2 已审计
/// 实现（nonceBitmap / bitmapPositions / _useUnorderedNonce /
/// invalidateUnorderedNonces），Bit100 只保留自己的事件与零地址防线。
contract OrderNonceManager {
    /// @notice 用户 nonce 位图（user => wordPos => 256 位字），一位对应一个 nonce
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;

    /// @notice 事件：Nonce使用（保持第 62 轮前的事件面，索引/排障口径不变）
    event NonceUsed(address indexed user, uint256 nonce);

    /// @notice 事件：无序 nonce 主动失效（Permit2 同名事件，链上撤单原语）
    event UnorderedNonceInvalidation(address indexed owner, uint256 wordPos, uint256 mask);

    /// @notice nonce 已被消耗/失效时回滚（Permit2 同名错误）
    error InvalidNonce();

    /// @notice nonce 位分解（Permit2 逐字借）：高 248 位 = wordPos，低 8 位 = bitPos
    function bitmapPositions(uint256 nonce) internal pure returns (uint256 wordPos, uint256 bitPos) {
        wordPos = uint248(nonce >> 8);
        bitPos = uint8(nonce);
    }

    /// @notice 某 nonce 是否已被消耗或失效（位测试）
    function _isNonceUsed(address user, uint256 nonce) internal view returns (bool) {
        (uint256 wordPos, uint256 bitPos) = bitmapPositions(nonce);
        return (nonceBitmap[user][wordPos] >> bitPos) & 1 == 1;
    }

    /// @notice 检查并标记 nonce 为已使用（防重放攻击）
    /// @dev Permit2 _useUnorderedNonce 的 XOR 翻转消耗：位已置 1 时翻转后
    /// 变 0 → revert InvalidNonce；一位只能被成功消耗一次。Bit100 的调用
    /// 顺序保持先验签后消耗（见 Settlement._verifyFill），不跟随 Permit2
    /// 的先消耗后验签。
    /// @param user 用户地址
    /// @param nonce 订单nonce
    function useNonce(address user, uint256 nonce) internal {
        require(user != address(0), "OrderNonce: zero address");
        (uint256 wordPos, uint256 bitPos) = bitmapPositions(nonce);
        uint256 bit = 1 << bitPos;
        uint256 flipped = nonceBitmap[user][wordPos] ^= bit;
        if (flipped & bit == 0) revert InvalidNonce();

        emit NonceUsed(user, nonce);
    }

    /// @notice 检查 nonce 是否有效（该位未置且 user 非零地址；无序语义下不再有水位下限）
    function isValidNonce(address user, uint256 nonce) external view returns (bool) {
        if (user == address(0)) return false;
        return !_isNonceUsed(user, nonce);
    }

    /// @notice 主动失效一批无序 nonce（Permit2 逐字借）：mask 中置 1 的位被
    /// OR 进调用者自己的对应字，这些 nonce 从此永远无法被结算消耗。
    /// 只能动自己的位图（以 msg.sender 索引）。注意粒度：掩码应精确到目标
    /// 订单的那一位；整字掩码会连带作废同字内全部未结订单且不可逆。
    function invalidateUnorderedNonces(uint256 wordPos, uint256 mask) external {
        nonceBitmap[msg.sender][wordPos] |= mask;
        emit UnorderedNonceInvalidation(msg.sender, wordPos, mask);
    }
}
