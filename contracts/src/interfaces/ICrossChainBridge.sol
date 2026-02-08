// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title ICrossChainBridge 跨链桥接接口
interface ICrossChainBridge {
    /// @notice 发起跨链转移
    function bridgeToken(
        address token,
        uint256 amount,
        uint32 dstChainId,
        bytes calldata options
    ) external payable;

    /// @notice 获取跨链费用估算
    function quoteBridgeFee(
        uint32 dstChainId,
        bytes calldata payload,
        bytes calldata options
    ) external view returns (uint256 nativeFee, uint256 lzTokenFee);

    /// @notice 检查代币是否支持
    function supportedTokens(address token) external view returns (bool);

    /// @notice 获取代币映射
    function tokenMapping(uint16 chainId, address token) external view returns (address);
}
