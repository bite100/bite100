// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice 测试用 ERC-1271 智能钱包（阶段 3 签名长度门修复的回归夹具）。
/// @dev 模拟 Safe 等智能钱包的**变长签名**形态：签名 = 65 字节 EOA 签名
/// （由钱包 owner 对 digest 签署）+ 任意填充字节。isValidSignature 只验
/// 前 65 字节、忽略尾部填充——任何总长度 != 65 的签名在旧版 Settlement
/// （长度门挡在 1271 之前）下永远验不过，本夹具锁死修复后的可达性。
contract Mock1271Wallet {
    address public owner;

    constructor(address _owner) {
        owner = _owner;
    }

    /// @notice ERC-1271：前 65 字节为 owner 的 ECDSA 签名则返回 magic 值，
    /// 其余情况（含长度不足 65）返回 0xffffffff，永不 revert（与真实钱包同口径）。
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length < 65) return bytes4(0xffffffff);
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return bytes4(0xffffffff);
        address signer = ecrecover(hash, v, r, s);
        return signer == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
