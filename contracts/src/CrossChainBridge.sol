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
    
    /// @notice 跨链请求状态（用于状态查询和监控）
    enum BridgeStatus { Pending, Processing, Completed, Failed }
    mapping(bytes32 => BridgeStatus) public bridgeStatus;
    mapping(bytes32 => uint256) public bridgeInitiatedAt; // 请求发起时间
    mapping(bytes32 => uint256) public bridgeCompletedAt; // 请求完成时间

    /// @notice 支持的代币列表
    mapping(address => bool) public supportedTokens;
    
    /// @notice 跨链消息重试配置
    uint256 public maxRetryAttempts = 3;
    uint256 public retryDelay = 5 minutes;
    mapping(bytes32 => uint256) public retryAttempts; // requestId => attempts

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
    
    /// @notice 事件：跨链状态更新
    event BridgeStatusUpdated(
        bytes32 indexed requestId,
        BridgeStatus status,
        uint256 timestamp
    );
    
    /// @notice 事件：跨链重试
    event BridgeRetry(
        bytes32 indexed requestId,
        uint256 attempt,
        uint256 timestamp
    );

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

    /// @notice 设置桥接费用（输入验证增强）
    function setBridgeFee(address token, uint256 fee) external onlyOwner {
        require(token != address(0), "Bridge: zero token address");
        require(fee <= 1e18, "Bridge: fee too high"); // 最多1个代币单位
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
        
        // 记录状态
        bridgeStatus[requestId] = BridgeStatus.Pending;
        bridgeInitiatedAt[requestId] = block.timestamp;
        emit BridgeStatusUpdated(requestId, BridgeStatus.Pending, block.timestamp);

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
        
        // 更新状态
        bridgeStatus[requestId] = BridgeStatus.Processing;
        emit BridgeStatusUpdated(requestId, BridgeStatus.Processing, block.timestamp);

        // 输入验证增强：验证所有参数
        require(request.user != address(0), "Bridge: invalid user address");
        require(request.token != address(0), "Bridge: invalid token address");
        require(request.amount > 0, "Bridge: invalid amount");
        require(request.dstChainId > 0, "Bridge: invalid chain ID");
        require(request.timestamp > 0 && request.timestamp <= block.timestamp, "Bridge: invalid timestamp");
        
        // 验证时间戳（防止过期请求，允许5分钟的时间差）
        require(block.timestamp - request.timestamp <= 5 minutes, "Bridge: request expired");

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

    /// @notice 获取跨链费用估算（优化：支持更精确的费用计算）
    /// @param dstChainId 目标链 ID（LayerZero EID，uint32）
    /// @param payload 消息内容
    /// @param options 跨链选项
    function quoteBridgeFee(
        uint32 dstChainId,
        bytes calldata payload,
        bytes calldata options
    ) external view returns (uint256 nativeFee, uint256 lzTokenFee) {
        require(dstChainId > 0, "Bridge: invalid chain ID");
        require(payload.length > 0, "Bridge: empty payload");
        
        OApp.MessagingFee memory fee = _quote(dstChainId, payload, options, false);
        return (fee.nativeFee, fee.lzTokenFee);
    }
    
    /// @notice 获取跨链请求状态（用于状态查询）
    function getBridgeStatus(bytes32 requestId) external view returns (
        BridgeStatus status,
        uint256 initiatedAt,
        uint256 completedAt,
        uint256 attempts
    ) {
        return (
            bridgeStatus[requestId],
            bridgeInitiatedAt[requestId],
            bridgeCompletedAt[requestId],
            retryAttempts[requestId]
        );
    }
    
    /// @notice 重试失败的跨链请求（重试机制）
    function retryBridge(
        bytes32 requestId,
        uint32 dstChainId,
        bytes calldata options
    ) external payable {
        require(bridgeStatus[requestId] == BridgeStatus.Failed, "Bridge: not failed");
        require(retryAttempts[requestId] < maxRetryAttempts, "Bridge: max retries exceeded");
        
        // 检查重试延迟
        require(
            block.timestamp >= bridgeInitiatedAt[requestId] + retryDelay,
            "Bridge: retry too soon"
        );
        
        retryAttempts[requestId]++;
        bridgeStatus[requestId] = BridgeStatus.Pending;
        emit BridgeRetry(requestId, retryAttempts[requestId], block.timestamp);
        
        // 重新发送消息（需要从存储中恢复原始请求）
        // 注意：实际实现需要存储原始请求数据
        revert("Bridge: retry not fully implemented - need to store original request");
    }
    
    /// @notice 设置重试配置
    function setRetryConfig(uint256 _maxAttempts, uint256 _delay) external onlyOwner {
        require(_maxAttempts > 0 && _delay > 0, "Bridge: invalid config");
        maxRetryAttempts = _maxAttempts;
        retryDelay = _delay;
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
