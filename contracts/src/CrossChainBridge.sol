// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title CrossChainBridge 跨链资产桥接合约
/// @notice 使用 LayerZero OApp 实现跨链资产转移
/// @dev 支持跨链锁定/解锁资产，目标链铸造/销毁代币
contract CrossChainBridge is OApp {
    using SafeERC20 for IERC20;

    /// @notice 跨链转移请求
    struct BridgeRequest {
        address user;          // 用户地址
        address token;         // 代币地址
        uint256 amount;        // 数量
        uint32 dstChainId;     // 目标链 ID（LayerZero 使用 uint32）
        uint256 timestamp;     // 时间戳（防重放）
    }

    /// @notice 已处理的请求（防重放）
    mapping(bytes32 => bool) public processedRequests;

    /// @notice 支持的代币列表
    mapping(address => bool) public supportedTokens;

    /// @notice 目标链的代币映射（源链代币 => 目标链代币）
    /// @dev 使用 uint16 存储 LayerZero EID（uint32）的低 16 位
    mapping(uint16 => mapping(address => address)) public tokenMapping;

    /// @notice 桥接费用（以代币计价，单位：wei）
    mapping(address => uint256) public bridgeFees;

    /// @notice 事件：跨链转移发起
    event BridgeInitiated(
        bytes32 indexed requestId,
        address indexed user,
        address indexed token,
        uint256 amount,
        uint32 dstChainId
    );

    /// @notice 事件：跨链转移完成
    event BridgeCompleted(
        bytes32 indexed requestId,
        address indexed user,
        address indexed token,
        uint256 amount,
        uint32 srcChainId
    );

    /// @notice 事件：代币添加/移除
    event TokenSupportUpdated(address indexed token, bool supported);

    /// @notice 事件：代币映射更新
    event TokenMappingUpdated(uint16 indexed chainId, address indexed srcToken, address indexed dstToken);

    /// @notice 事件：桥接费用更新
    event BridgeFeeUpdated(address indexed token, uint256 fee);

    modifier onlySupportedToken(address token) {
        require(supportedTokens[token], "Bridge: token not supported");
        _;
    }

    constructor(
        address _endpoint,
        address _owner,
        address _delegate
    ) OApp(_endpoint, _owner, _delegate) {}

    /// @notice 添加/移除支持的代币
    function setSupportedToken(address token, bool supported) external onlyOwner {
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    /// @notice 设置目标链的代币映射
    function setTokenMapping(
        uint32 dstChainId,
        address srcToken,
        address dstToken
    ) external onlyOwner {
        tokenMapping[uint16(dstChainId)][srcToken] = dstToken;
        emit TokenMappingUpdated(uint16(dstChainId), srcToken, dstToken);
    }

    /// @notice 设置桥接费用
    function setBridgeFee(address token, uint256 fee) external onlyOwner {
        bridgeFees[token] = fee;
        emit BridgeFeeUpdated(token, fee);
    }

    /// @notice 发起跨链转移（锁定资产）
    /// @param token 代币地址
    /// @param amount 数量
    /// @param dstChainId 目标链 ID（LayerZero EID）
    /// @param options 跨链选项（Gas、支付方式等）
    function bridgeToken(
        address token,
        uint256 amount,
        uint32 dstChainId,
        bytes calldata options
    ) external payable onlySupportedToken(token) {
        require(amount > 0, "Bridge: amount must be > 0");
        require(tokenMapping[uint16(dstChainId)][token] != address(0), "Bridge: token mapping not set");

        // 计算费用
        uint256 fee = bridgeFees[token];
        require(amount > fee, "Bridge: amount must be > fee");

        // 锁定资产
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // 构建消息
        BridgeRequest memory request = BridgeRequest({
            user: msg.sender,
            token: tokenMapping[uint16(dstChainId)][token], // 使用目标链的代币地址
            amount: amount - fee, // 扣除费用
            dstChainId: dstChainId,
            timestamp: block.timestamp
        });

        bytes memory payload = abi.encode(request);
        
        // 发送跨链消息
        _lzSend(
            uint32(dstChainId),
            payload,
            options,
            MessagingFee(msg.value, 0), // 使用 msg.value 作为 native fee
            payable(msg.sender) // 退款地址
        );
        
        // 生成请求 ID（用于事件）
        bytes32 requestId = keccak256(
            abi.encodePacked(msg.sender, token, amount, dstChainId, block.timestamp, block.number)
        );

        emit BridgeInitiated(requestId, msg.sender, token, amount, dstChainId);
    }

    /// @notice 接收跨链消息（解锁/铸造资产）
    /// @param _origin 源链信息
    /// @param _guid 消息 GUID
    /// @param _payload 消息内容
    /// @param _executor 执行者地址
    /// @param _extraData 额外数据
    function _lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _payload,
        address _executor,
        bytes calldata _extraData
    ) internal override {
        // 解码请求
        BridgeRequest memory request = abi.decode(_payload, (BridgeRequest));

        // 生成请求 ID（与源链一致）
        bytes32 requestId = keccak256(
            abi.encodePacked(
                request.user,
                request.token,
                request.amount,
                _origin.srcEid,
                request.timestamp,
                _guid
            )
        );

        // 防重放
        require(!processedRequests[requestId], "Bridge: request already processed");
        processedRequests[requestId] = true;

        // 验证代币映射（简化：直接使用请求中的代币地址）
        require(request.token != address(0), "Bridge: invalid token address");

        // 如果是原生代币（地址为 0），则铸造
        // 否则解锁代币
        if (request.token == address(0)) {
            // 原生代币：铸造（需要实现 OFT）
            // 这里简化处理，实际应使用 OFT 标准
            revert("Bridge: native token bridging not implemented");
        } else {
            // ERC20 代币：解锁
            IERC20(request.token).safeTransfer(request.user, request.amount);
        }

        emit BridgeCompleted(requestId, request.user, request.token, request.amount, uint32(_origin.srcEid));
    }

    /// @notice 获取跨链费用估算
    /// @param dstChainId 目标链 ID（LayerZero EID，uint32）
    /// @param payload 消息内容
    /// @param options 跨链选项
    function quoteBridgeFee(
        uint32 dstChainId,
        bytes calldata payload,
        bytes calldata options
    ) external view returns (uint256 nativeFee, uint256 lzTokenFee) {
        OApp.MessagingFee memory fee = _quote(dstChainId, payload, options, false);
        return (fee.nativeFee, fee.lzTokenFee);
    }

    /// @notice 提取桥接费用
    function withdrawFees(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice 紧急提取（仅 owner）
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }
}
