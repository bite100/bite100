// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice 本文件为本项目本地编译用的最小 OApp stub，实现与真实 LayerZero OApp 接口兼容的外观，
///         以便 CrossChainBridge.sol 能够通过编译与测试。
/// @dev    仅供本地开发与单元测试使用，部署主网或真实跨链环境时必须替换为官方 OApp 实现。
contract OApp {
    address public owner;
    address public endpoint;
    address public delegate;

    struct Origin {
        uint32 srcEid;
        address sender;
    }

    // 与 CrossChainBridge 使用的字段命名保持一致
    struct MessagingFee {
        uint256 nativeFee;
        uint256 lzTokenFee;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "OApp: not owner");
        _;
    }

    constructor(address _endpoint, address _owner, address _delegate) {
        endpoint = _endpoint;
        owner = _owner;
        delegate = _delegate;
    }

    // 供子合约调用的 stub 发送函数，仅触发事件，方便本地测试，不做真实跨链
    event LzSend(
        uint32 dstChainId,
        bytes payload,
        bytes options,
        MessagingFee fee,
        address refundAddress
    );

    function _lzSend(
        uint32 _dstChainId,
        bytes memory _payload,
        bytes memory _options,
        MessagingFee memory _fee,
        address _refundAddress
    ) internal virtual {
        emit LzSend(_dstChainId, _payload, _options, _fee, _refundAddress);
    }

    // 供子合约重写的接收函数，默认空实现
    function _lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _payload,
        address _executor,
        bytes calldata _extraData
    ) internal virtual {}

    /// @notice 本地 stub：返回 0 费用的报价，避免编译错误；真实环境需由 LayerZero Endpoint 提供
    function _quote(
        uint32 /*_dstChainId*/,
        bytes calldata /*_payload*/,
        bytes calldata /*_options*/,
        bool /*_payInLzToken*/
    ) internal view virtual returns (MessagingFee memory) {
        return MessagingFee({nativeFee: 0, lzTokenFee: 0});
    }
}
