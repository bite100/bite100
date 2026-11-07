// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { OApp, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {
    MessagingFee,
    MessagingReceipt
} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title CrossChainBridge 跨链资产桥（LayerZero V2 OApp，锁定/解锁模型）
/// @notice 源链锁定 ERC20、目标链从预存流动性中解锁等额代币（扣桥费后）。
/// @dev 第九轮（M2a）重写要点：
///      - 底座换成 LayerZero 官方 oapp-evm 包的真实 OApp（此前仓库内的
///        lib/oapp-evm 只是本地编译 stub，_lzSend 不调真实 Endpoint）。
///      - 防重放不再依赖消息时间戳（旧版 5 分钟过期校验会拒掉真实投递）：
///        LayerZero 按 (srcEid, sender, nonce) 在 ULN/Endpoint 层天然防重放，
///        桥内再以 (srcEid, transferId) 记账去重。
///      - 请求标识统一：源链每次桥接生成顺序 transferId 并随消息传递；
///        两侧都以 transferId 为逻辑主键、LZ guid 为消息主键（guid 由
///        _lzSend 的 MessagingReceipt 返回），状态可跨链对应。
///      - 重试安全：retryBridge 对同一 transferId 重新发一条 LZ 消息
///        （新 guid）；目标链按 transferId 去重，先到者完成、后到者拒绝，
///        因此原消息迟到也不会双重放行。
///      - 原生代币（token == address(0)）明确不支持：入口直接 revert。
contract CrossChainBridge is OApp {
    using SafeERC20 for IERC20;
    using OptionsBuilder for bytes;

    /// @notice 跨链请求状态
    enum BridgeStatus {
        None,
        Pending, // 源链已发出（或目标链处理中）
        Completed, // 目标链已放行到账
        Failed
    }

    /// @notice 源链侧的发出记录（以 transferId 为键）
    struct Transfer {
        address user;
        address srcToken;
        address dstToken;
        uint256 amount; // 锁定总额（含费）
        uint256 netAmount; // 扣费后应到账额
        uint32 dstEid;
        uint256 initiatedAt;
        uint256 lastAttemptAt;
        uint256 attempts; // 重试次数（首次发送不计）
        bytes32 lastGuid; // 最近一次发送的 LZ 消息 guid
        BridgeStatus status;
    }

    /// @notice 目标链侧的到账记录（以 (srcEid, transferId) 为键）
    struct Delivery {
        address user;
        address token;
        uint256 amount;
        uint256 completedAt;
        bytes32 guid;
        BridgeStatus status;
    }

    /// @notice 本桥发出的顺序号（从 1 开始）
    uint256 public transferCounter;
    mapping(uint256 => Transfer) public transfers;
    /// @notice guid => transferId（本桥发出与收到的消息都能反查）
    mapping(bytes32 => uint256) public guidToTransfer;
    /// @notice 收到侧 guid => 源链 EID（发出侧 guid 此处为 0）
    mapping(bytes32 => uint32) public guidSrcEid;
    /// @notice 目标链侧到账记录
    mapping(uint32 => mapping(uint256 => Delivery)) public deliveries;
    /// @notice 目标链侧去重：(srcEid, transferId) 是否已放行
    mapping(uint32 => mapping(uint256 => bool)) public processedFrom;

    /// @notice 支持的代币列表（源链可锁、目标链可解锁都查这张表）
    mapping(address => bool) public supportedTokens;

    /// @notice 目标链代币映射（dstEid => 源链代币 => 目标链代币），键为完整 uint32 EID
    mapping(uint32 => mapping(address => address)) public tokenMapping;

    /// @notice 桥接费用（以代币计价，从锁定额中扣除，留在源链桥内）
    mapping(address => uint256) public bridgeFees;

    /// @notice 重试配置
    uint256 public maxRetryAttempts = 3;
    uint256 public retryDelay = 5 minutes;

    /// @notice 调用方未传 options 时，自动构造的 lzReceive 执行 gas
    uint128 public defaultReceiveGas = 200_000;

    event BridgeInitiated(
        bytes32 indexed guid,
        uint256 indexed transferId,
        address indexed user,
        address token,
        uint256 amount,
        uint32 dstEid
    );

    event BridgeCompleted(
        bytes32 indexed guid,
        uint256 indexed transferId,
        address indexed user,
        address token,
        uint256 amount,
        uint32 srcEid
    );

    event BridgeRetry(uint256 indexed transferId, bytes32 indexed guid, uint256 attempt, uint256 timestamp);

    event BridgeStatusUpdated(uint256 indexed transferId, BridgeStatus status, uint256 timestamp);

    event TokenSupportUpdated(address indexed token, bool supported);

    event TokenMappingUpdated(uint32 indexed dstEid, address indexed srcToken, address indexed dstToken);

    event BridgeFeeUpdated(address indexed token, uint256 fee);

    modifier onlySupportedToken(address token) {
        require(supportedTokens[token], "Bridge: token not supported");
        _;
    }

    /// @param _endpoint LayerZero V2 Endpoint 地址
    /// @param _delegate OApp delegate（可代 OApp 在 Endpoint 内做配置，通常 = owner）
    constructor(address _endpoint, address _delegate) OApp(_endpoint, _delegate) {}

    // ------------------------------------------------------------------
    // 配置（owner）
    // ------------------------------------------------------------------

    function setSupportedToken(address token, bool supported) external onlyOwner {
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    function setTokenMapping(uint32 dstEid, address srcToken, address dstToken) external onlyOwner {
        tokenMapping[dstEid][srcToken] = dstToken;
        emit TokenMappingUpdated(dstEid, srcToken, dstToken);
    }

    function setBridgeFee(address token, uint256 fee) external onlyOwner {
        require(token != address(0), "Bridge: zero token address");
        require(fee <= 1e18, "Bridge: fee too high"); // 最多1个代币单位
        bridgeFees[token] = fee;
        emit BridgeFeeUpdated(token, fee);
    }

    function setRetryConfig(uint256 _maxAttempts, uint256 _delay) external onlyOwner {
        require(_maxAttempts > 0 && _delay > 0, "Bridge: invalid config");
        maxRetryAttempts = _maxAttempts;
        retryDelay = _delay;
    }

    function setDefaultReceiveGas(uint128 gas) external onlyOwner {
        require(gas > 0, "Bridge: invalid gas");
        defaultReceiveGas = gas;
    }

    // ------------------------------------------------------------------
    // 发送侧
    // ------------------------------------------------------------------

    /// @notice 发起跨链转移（锁定资产）
    /// @param token 源链 ERC20 地址（原生代币不支持，传 address(0) 会 revert）
    /// @param amount 锁定数量（含费）
    /// @param dstEid 目标链 LayerZero EID
    /// @param options LZ type-3 options；传空 bytes 时自动按 defaultReceiveGas 构造
    /// @return transferId 本桥顺序号（跨链逻辑主键）
    /// @return guid 本次 LZ 消息 guid
    function bridgeToken(
        address token,
        uint256 amount,
        uint32 dstEid,
        bytes calldata options
    ) external payable returns (uint256 transferId, bytes32 guid) {
        require(token != address(0), "Bridge: native token not supported");
        require(supportedTokens[token], "Bridge: token not supported");
        require(amount > 0, "Bridge: amount must be > 0");
        address dstToken = tokenMapping[dstEid][token];
        require(dstToken != address(0), "Bridge: token mapping not set");

        uint256 fee = bridgeFees[token];
        require(amount > fee, "Bridge: amount must be > fee");
        uint256 netAmount = amount - fee;

        // 锁定资产（费用部分同样留在桥内，由 owner 以 withdrawFees 提取）
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        transferId = ++transferCounter;

        bytes memory payload = abi.encode(transferId, msg.sender, dstToken, netAmount);
        bytes memory opts = options.length > 0
            ? options
            : OptionsBuilder.newOptions().addExecutorLzReceiveOption(defaultReceiveGas, 0);

        MessagingReceipt memory receipt = _lzSend(
            dstEid,
            payload,
            opts,
            MessagingFee(msg.value, 0), // native fee 由调用方以 msg.value 支付
            payable(msg.sender)
        );
        guid = receipt.guid;

        transfers[transferId] = Transfer({
            user: msg.sender,
            srcToken: token,
            dstToken: dstToken,
            amount: amount,
            netAmount: netAmount,
            dstEid: dstEid,
            initiatedAt: block.timestamp,
            lastAttemptAt: block.timestamp,
            attempts: 0,
            lastGuid: guid,
            status: BridgeStatus.Pending
        });
        guidToTransfer[guid] = transferId;

        emit BridgeStatusUpdated(transferId, BridgeStatus.Pending, block.timestamp);
        emit BridgeInitiated(guid, transferId, msg.sender, token, amount, dstEid);
    }

    /// @notice 重试一笔已发出但未确认到账的跨链请求
    /// @dev 语义：对同一 transferId 重新发送一条新的 LZ 消息（新 guid）。
    ///      目标链按 (srcEid, transferId) 去重，先到者放行、后到者被拒，
    ///      所以原消息即使迟到也不会双重到账。源链无法感知目标链完成状态，
    ///      因此只允许原发起人或 owner 调用，且受次数/间隔限制；
    ///      若原消息其实已到账，重试消息会在目标链被安全拒绝（白付一次消息费）。
    /// @param transferId bridgeToken 返回的顺序号
    /// @param options 同 bridgeToken，传空自动构造
    function retryBridge(
        uint256 transferId,
        bytes calldata options
    ) external payable returns (bytes32 guid) {
        Transfer storage t = transfers[transferId];
        require(t.status == BridgeStatus.Pending, "Bridge: transfer not pending");
        require(msg.sender == t.user || msg.sender == owner(), "Bridge: not authorized");
        require(t.attempts < maxRetryAttempts, "Bridge: max retries exceeded");
        require(block.timestamp >= t.lastAttemptAt + retryDelay, "Bridge: retry too soon");

        bytes memory payload = abi.encode(transferId, t.user, t.dstToken, t.netAmount);
        bytes memory opts = options.length > 0
            ? options
            : OptionsBuilder.newOptions().addExecutorLzReceiveOption(defaultReceiveGas, 0);

        MessagingReceipt memory receipt = _lzSend(
            t.dstEid,
            payload,
            opts,
            MessagingFee(msg.value, 0),
            payable(msg.sender)
        );
        guid = receipt.guid;

        t.attempts += 1;
        t.lastAttemptAt = block.timestamp;
        t.lastGuid = guid;
        guidToTransfer[guid] = transferId;

        emit BridgeRetry(transferId, guid, t.attempts, block.timestamp);
    }

    // ------------------------------------------------------------------
    // 接收侧
    // ------------------------------------------------------------------

    /// @notice 接收跨链消息并解锁代币（由 OAppReceiver 在校验 endpoint 与 peer 后调用）
    function _lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _payload,
        address /* _executor */,
        bytes calldata /* _extraData */
    ) internal override {
        (uint256 transferId, address user, address token, uint256 amount) =
            abi.decode(_payload, (uint256, address, address, uint256));

        require(user != address(0), "Bridge: invalid user address");
        require(token != address(0), "Bridge: invalid token address");
        require(amount > 0, "Bridge: invalid amount");
        require(supportedTokens[token], "Bridge: token not supported");

        // 按逻辑主键去重（LZ 层防重放之外再加一层，保证 retry 语义安全）
        require(!processedFrom[_origin.srcEid][transferId], "Bridge: transfer already processed");
        processedFrom[_origin.srcEid][transferId] = true;

        deliveries[_origin.srcEid][transferId] = Delivery({
            user: user,
            token: token,
            amount: amount,
            completedAt: block.timestamp,
            guid: _guid,
            status: BridgeStatus.Completed
        });
        guidToTransfer[_guid] = transferId;
        guidSrcEid[_guid] = _origin.srcEid;

        // 从本桥预存流动性中解锁。若余额不足，本调用 revert，LZ 会把消息
        // 存为待重试（补足流动性后可由执行者重新投递），不会丢账。
        IERC20(token).safeTransfer(user, amount);

        emit BridgeStatusUpdated(transferId, BridgeStatus.Completed, block.timestamp);
        emit BridgeCompleted(_guid, transferId, user, token, amount, _origin.srcEid);
    }

    // ------------------------------------------------------------------
    // 查询与费用
    // ------------------------------------------------------------------

    /// @notice 估算把一笔 bridgeToken 消息发往 dstEid 的 LZ 费用（native）
    function quoteBridgeFee(
        address token,
        uint256 amount,
        uint32 dstEid,
        address user,
        bytes calldata options
    ) external view returns (uint256 nativeFee, uint256 lzTokenFee) {
        uint256 fee = bridgeFees[token];
        require(amount > fee, "Bridge: amount must be > fee");
        address dstToken = tokenMapping[dstEid][token];
        require(dstToken != address(0), "Bridge: token mapping not set");
        bytes memory payload = abi.encode(transferCounter + 1, user, dstToken, amount - fee);
        bytes memory opts = options.length > 0
            ? options
            : OptionsBuilder.newOptions().addExecutorLzReceiveOption(defaultReceiveGas, 0);
        MessagingFee memory quoted = _quote(dstEid, payload, opts, false);
        return (quoted.nativeFee, quoted.lzTokenFee);
    }

    /// @notice 按 guid 查询（两侧通用）：源链返回发出记录状态，
    ///         目标链返回到账记录状态；guid 未知时返回 None 与 0 值。
    function getBridgeStatus(bytes32 guid) external view returns (
        BridgeStatus status,
        uint256 transferId,
        uint256 initiatedAt,
        uint256 completedAt,
        uint256 attempts
    ) {
        transferId = guidToTransfer[guid];
        if (transferId == 0) {
            return (BridgeStatus.None, 0, 0, 0, 0);
        }
        uint32 srcEid = guidSrcEid[guid];
        if (srcEid != 0) {
            // 本桥是接收侧：返回到账记录
            Delivery storage d = deliveries[srcEid][transferId];
            return (d.status, transferId, 0, d.completedAt, 0);
        }
        // 本桥是发出侧：返回发出记录
        Transfer storage t = transfers[transferId];
        return (t.status, transferId, t.initiatedAt, 0, t.attempts);
    }

    /// @notice 目标链侧到账状态查询
    function getDeliveryStatus(uint32 srcEid, uint256 transferId) external view returns (
        BridgeStatus status,
        uint256 completedAt,
        bytes32 guid
    ) {
        Delivery storage d = deliveries[srcEid][transferId];
        return (d.status, d.completedAt, d.guid);
    }

    // ------------------------------------------------------------------
    // 资金管理（owner）
    // ------------------------------------------------------------------

    /// @notice 提取桥内代币（桥费收入或多余流动性）
    function withdrawFees(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice 紧急提取（仅 owner）
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }
}
