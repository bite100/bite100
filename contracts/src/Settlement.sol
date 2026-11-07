// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./Vault.sol";
import "./FeeDistributor.sol";
import "./NodeRewards.sol";
import "./MerkleProof.sol";
import "./OrderNonceManager.sol";

/// @title Settlement 交易结算
/// @notice 根据链下撮合结果执行资产划转并收取手续费；0.01% 单边，买卖双方各自代币收取，每边最高等值 1 美元（由 feeCapPerToken 配置）。
/// @notice 当买卖双方无原生代币付 gas 时，可由交易所（relayer）代付；gas 费卖方买方均摊，从成交额中扣除后转给交易所。
contract Settlement is ReentrancyGuard, OrderNonceManager {
    Vault public vault;
    FeeDistributor public feeDistributor;
    address public owner;
    address public governance;
    /// @notice 交易所/中继地址（兼容旧接口）：当有原生代币时代付 gas；与 isRelayer 白名单二选一或同时使用
    address public relayer;
    /// @notice Relayer 白名单：多 relayer 时可在此登记，调用 settleTrade 时 owner 或 relayer 或 isRelayer[msg.sender] 均可
    mapping(address => bool) public isRelayer;
    /// @notice 单笔 settleTrade 允许的 gas 报销上限（token 最小单位之和，gasReimburseIn + gasReimburseOut <= 此值）；0 表示不设上限，防滥用
    uint256 public maxGasReimbursePerTrade;
    
    /// @notice Relayer 限流：每个 relayer 地址在时间窗口内的最大调用次数
    uint256 public relayerRateLimitWindow = 1 hours;
    uint256 public relayerRateLimitMaxCalls = 1000;
    mapping(address => mapping(uint256 => uint256)) private relayerCallCounts; // relayer => timeWindow => count
    
    /// @notice Relayer 信誉机制：记录每个relayer的信誉分数和违规次数
    struct RelayerReputation {
        uint256 score;           // 信誉分数（0-10000）
        uint256 violations;      // 违规次数
        uint256 successfulTrades; // 成功交易数
        uint256 lastUpdateTime;  // 最后更新时间
    }
    mapping(address => RelayerReputation) public relayerReputation;
    uint256 public minRelayerReputation = 5000; // 最小信誉分数（50%）
    /// @notice 新 relayer 的初始信誉（中性值，等于默认门槛）；无初始值时新 relayer 分数为 0，
    /// 永远达不到 minRelayerReputation 且成功结算前无法加分，会陷入死锁，故授权时初始化
    uint256 public constant INITIAL_RELAYER_REPUTATION = 5000;
    uint256 public violationPenalty = 100;     // 每次违规扣分

    uint16 public feeBps = 1; // 0.01%
    address public feeToken; // 保留，兼容旧接口
    /// @notice 每代币手续费上限（该代币最小单位），0 表示不设上限；如 USDC 6 位小数下 1e6 = 1 USD
    mapping(address => uint256) public feeCapPerToken;

    /// @notice 统一订单结构（EIP-712 签名对象）：字段顺序即编码顺序，前端/节点/合约三方规范见 docs/eip712-order-spec.md
    struct Order {
        string orderId;
        address userAddress;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
        uint256 price;
        uint256 timestamp;
        uint256 expiresAt;
        uint256 nonce;
    }

    /// @notice 签名订单（订单 + 其 65 字节 EIP-712 签名）
    struct SignedOrder {
        Order order;
        bytes signature;
    }

    /// @notice 一笔成交的结算请求：双方签名订单 + 实际成交量（tokenIn = maker 卖出，tokenOut = taker 卖出）
    struct Fill {
        SignedOrder makerOrder;
        SignedOrder takerOrder;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
        uint256 gasReimburseIn;
        uint256 gasReimburseOut;
    }

    /// @notice 按订单 digest 累计已结算量（以订单自身方向计：In = 该订单 tokenIn 侧已成交量），支持部分成交且防超额重放
    mapping(bytes32 => uint256) public orderFilledIn;
    mapping(bytes32 => uint256) public orderFilledOut;

    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _ORDER_TYPEHASH =
        keccak256("Order(string orderId,address userAddress,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,uint256 price,uint256 timestamp,uint256 expiresAt,uint256 nonce)");
    bytes32 private constant _DOMAIN_NAME_HASH = keccak256(bytes(unicode"比特100"));
    bytes32 private constant _DOMAIN_VERSION_HASH = keccak256(bytes("1"));

    // 优化事件：减少gas消耗，使用indexed和打包
    event TradeSettled(
        address indexed maker,
        address indexed taker,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount
    );
    event TradeSettledWithGasReimburse(
        address indexed maker,
        address indexed taker,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount,
        uint256 gasReimburseIn,
        uint256 gasReimburseOut,
        address gasRecipient
    );
    event FeeBpsSet(uint16 oldBps, uint16 newBps);
    event FeeTokenSet(address indexed token);
    event FeeCapSet(address indexed token, uint256 cap);
    event RelayerSet(address indexed relayer);
    event RelayerAllowedSet(address indexed account, bool allowed);
    event MaxGasReimbursePerTradeSet(uint256 oldCap, uint256 newCap);
    event GovernanceSet(address indexed governance);
    event TradesBatchSettledWithMerkle(uint256 indexed batchId, bytes32 merkleRoot, uint256 count);
    event GasSavingsDistributed(uint256 userRebateUsdt, uint256 toFeeDistributorUsdt, uint256 toFounderUsdt);
    event RelayerReputationUpdated(address indexed relayer, uint256 score, uint256 violations);
    event RelayerViolationRecorded(address indexed relayer, uint256 newScore);

    address public nodeRewards;
    address public founder;
    address public usdtToken;

    modifier onlyOwner() {
        require(msg.sender == owner, "Settlement: not owner");
        _;
    }

    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner || (governance != address(0) && msg.sender == governance), "Settlement: not auth");
        _;
    }

    constructor(address _vault, address _feeDistributor) {
        require(_vault != address(0) && _feeDistributor != address(0), "Settlement: zero address");
        vault = Vault(_vault);
        feeDistributor = FeeDistributor(_feeDistributor);
        owner = msg.sender;
    }

    /// @notice 设置手续费率（万分比，1 = 0.01%）；owner 或 governance 可调用
    function setFeeBps(uint16 _feeBps) external onlyOwnerOrGovernance {
        require(_feeBps <= 1000, "Settlement: fee too high"); // max 10%
        uint16 old = feeBps;
        feeBps = _feeBps;
        emit FeeBpsSet(old, _feeBps);
    }

    /// @notice 设置某代币手续费上限（该代币最小单位），0 表示不设上限；如 USDC 6 位小数下 1e6 = 1 USD
    function setFeeCap(address token, uint256 cap) external onlyOwnerOrGovernance {
        feeCapPerToken[token] = cap;
        emit FeeCapSet(token, cap);
    }

    /// @notice 设置手续费收取代币（保留兼容）
    function setFeeToken(address _feeToken) external onlyOwnerOrGovernance {
        feeToken = _feeToken;
        emit FeeTokenSet(_feeToken);
    }

    function setGovernance(address _governance) external onlyOwner {
        governance = _governance;
        emit GovernanceSet(_governance);
    }

    /// @notice 设置交易所/中继地址（代付 gas 时接收均摊的 gas 费）；0 表示不启用代付；与 isRelayer 白名单兼容
    function setRelayer(address _relayer) external onlyOwner {
        relayer = _relayer;
        _initRelayerReputationIfNeeded(_relayer);
        emit RelayerSet(_relayer);
    }

    /// @notice 设置 relayer 白名单（多 relayer 时使用）；仅 owner 可调用
    function setRelayerAllowed(address account, bool allowed) external onlyOwner {
        require(account != address(0), "Settlement: zero address");
        isRelayer[account] = allowed;
        if (allowed) _initRelayerReputationIfNeeded(account);
        emit RelayerAllowedSet(account, allowed);
    }

    /// @notice 内部：relayer 尚无任何信誉记录时赋予中性初始分（已有记录——含被扣至 0 分——不重置，防绕过处罚）
    function _initRelayerReputationIfNeeded(address relayerAddr) internal {
        if (relayerAddr == address(0)) return;
        RelayerReputation storage rep = relayerReputation[relayerAddr];
        if (rep.lastUpdateTime == 0) {
            rep.score = INITIAL_RELAYER_REPUTATION;
            rep.lastUpdateTime = block.timestamp;
            emit RelayerReputationUpdated(relayerAddr, rep.score, rep.violations);
        }
    }

    /// @notice 设置单笔 settleTrade 的 gas 报销上限（token 最小单位之和）；0 表示不设上限
    function setMaxGasReimbursePerTrade(uint256 _cap) external onlyOwner {
        uint256 old = maxGasReimbursePerTrade;
        maxGasReimbursePerTrade = _cap;
        emit MaxGasReimbursePerTradeSet(old, _cap);
    }
    
    /// @notice 设置 Relayer 限流参数
    function setRelayerRateLimit(uint256 _window, uint256 _maxCalls) external onlyOwner {
        require(_window > 0 && _maxCalls > 0, "Settlement: invalid rate limit");
        relayerRateLimitWindow = _window;
        relayerRateLimitMaxCalls = _maxCalls;
    }
    
    /// @notice 检查并更新 Relayer 调用频率限制
    function _checkRelayerRateLimit(address relayerAddr) internal {
        if (relayerAddr == address(0)) return;
        uint256 timeWindow = block.timestamp / relayerRateLimitWindow;
        uint256 count = relayerCallCounts[relayerAddr][timeWindow];
        require(count < relayerRateLimitMaxCalls, "Settlement: rate limit exceeded");
        relayerCallCounts[relayerAddr][timeWindow] = count + 1;
    }
    
    /// @notice 检查Relayer信誉（安全优化：信誉机制）
    function _checkRelayerReputation(address relayerAddr) internal view {
        if (relayerAddr == address(0) || relayerAddr == owner) return;
        if (minRelayerReputation > 0) {
            RelayerReputation memory rep = relayerReputation[relayerAddr];
            require(rep.score >= minRelayerReputation, "Settlement: relayer reputation too low");
        }
    }
    
    /// @notice 更新Relayer信誉（成功交易加分）
    function _updateRelayerReputationSuccess(address relayerAddr) internal {
        if (relayerAddr == address(0) || relayerAddr == owner) return;
        RelayerReputation storage rep = relayerReputation[relayerAddr];
        rep.successfulTrades++;
        // 成功交易加分（最多10000分）
        if (rep.score < 10000) {
            rep.score = rep.score + 1 > 10000 ? 10000 : rep.score + 1;
        }
        rep.lastUpdateTime = block.timestamp;
        emit RelayerReputationUpdated(relayerAddr, rep.score, rep.violations);
    }
    
    /// @notice 记录Relayer违规（安全优化：违规扣分）
    function recordRelayerViolation(address relayerAddr) external onlyOwner {
        require(relayerAddr != address(0), "Settlement: zero address");
        RelayerReputation storage rep = relayerReputation[relayerAddr];
        rep.violations++;
        // 违规扣分
        if (rep.score >= violationPenalty) {
            rep.score -= violationPenalty;
        } else {
            rep.score = 0;
        }
        rep.lastUpdateTime = block.timestamp;
        emit RelayerViolationRecorded(relayerAddr, rep.score);
    }
    
    /// @notice 设置最小Relayer信誉分数
    function setMinRelayerReputation(uint256 _minScore) external onlyOwner {
        require(_minScore <= 10000, "Settlement: invalid score");
        minRelayerReputation = _minScore;
    }
    
    /// @notice 设置违规扣分
    function setViolationPenalty(uint256 _penalty) external onlyOwner {
        require(_penalty <= 10000, "Settlement: invalid penalty");
        violationPenalty = _penalty;
    }

    function setNodeRewards(address _nodeRewards) external onlyOwner {
        nodeRewards = _nodeRewards;
    }

    function setFounder(address _founder) external onlyOwner {
        founder = _founder;
    }

    /// @notice 设置 USDT 代币地址（用于 gas 节省减 fee 与分配）
    function setUsdtToken(address _usdtToken) external onlyOwner {
        usdtToken = _usdtToken;
    }

    /// @notice 检查调用者是否为授权结算方（owner、单一 relayer 或白名单 relayer）
    /// @dev 顺序早返回写法：原链式 || 表达式被 via_ir 内联进各结算入口后会触发 Yul stack-too-deep
    function _isSettlementCaller() internal view returns (bool) {
        if (msg.sender == owner) return true;
        if (isRelayer[msg.sender]) return true;
        return relayer != address(0) && msg.sender == relayer;
    }

    /// @notice 内部：按当前费率与每代币上限计算双边手续费（settleTrade 与各批量入口共用，避免逻辑重复）
    function _feesFor(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint16 _feeBps
    ) internal view returns (uint256 feeIn, uint256 feeOut) {
        feeIn = (amountIn * _feeBps) / 10000;
        uint256 capIn = feeCapPerToken[tokenIn];
        if (capIn != 0 && feeIn > capIn) feeIn = capIn;
        feeOut = (amountOut * _feeBps) / 10000;
        uint256 capOut = feeCapPerToken[tokenOut];
        if (capOut != 0 && feeOut > capOut) feeOut = capOut;
    }

    /// @notice 内部：按给定 fee 执行单笔结算（供批量与 gas 节省逻辑复用）
    function _settleOne(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeIn,
        uint256 feeOut,
        uint256 gasReimburseIn,
        uint256 gasReimburseOut
    ) internal {
        // 增强输入验证
        require(maker != address(0) && taker != address(0), "Settlement: zero address");
        require(tokenIn != address(0) && tokenOut != address(0), "Settlement: zero token");
        require(maker != taker, "Settlement: same address");
        require(tokenIn != tokenOut, "Settlement: same token");
        require(amountIn > 0 && amountOut > 0, "Settlement: zero amount");
        require(amountIn >= feeIn + gasReimburseIn, "Settlement: amountIn < fee + gas");
        require(amountOut >= feeOut + gasReimburseOut, "Settlement: amountOut < fee + gas");
        // 防止溢出：检查金额是否在合理范围内（小于 2^128）
        require(amountIn < type(uint128).max && amountOut < type(uint128).max, "Settlement: amount too large");
        address _feeDist = address(feeDistributor);
        address gasRecipient = (gasReimburseIn > 0 || gasReimburseOut > 0) ? msg.sender : address(0);
        uint256 takerReceives = amountIn - feeIn - gasReimburseIn;
        uint256 makerReceives = amountOut - feeOut - gasReimburseOut;

        vault.transferWithinVault(maker, taker, tokenIn, takerReceives);
        if (feeIn != 0 && _feeDist != address(0)) {
            vault.transferOut(maker, address(this), tokenIn, feeIn);
            require(IERC20(tokenIn).approve(_feeDist, feeIn), "Settlement: approve failed");
            FeeDistributor(_feeDist).receiveFee(tokenIn, feeIn);
        }
        if (gasReimburseIn != 0) vault.transferOut(maker, gasRecipient, tokenIn, gasReimburseIn);

        vault.transferWithinVault(taker, maker, tokenOut, makerReceives);
        if (feeOut != 0 && _feeDist != address(0)) {
            vault.transferOut(taker, address(this), tokenOut, feeOut);
            require(IERC20(tokenOut).approve(_feeDist, feeOut), "Settlement: approve failed");
            FeeDistributor(_feeDist).receiveFee(tokenOut, feeOut);
        }
        if (gasReimburseOut > 0) vault.transferOut(taker, gasRecipient, tokenOut, gasReimburseOut);

        if (gasReimburseIn > 0 || gasReimburseOut > 0) {
            emit TradeSettledWithGasReimburse(maker, taker, tokenIn, tokenOut, amountIn, amountOut, feeIn + feeOut, gasReimburseIn, gasReimburseOut, gasRecipient);
        } else {
            emit TradeSettled(maker, taker, tokenIn, tokenOut, amountIn, amountOut, feeIn + feeOut);
        }
    }
    
    /// @notice EIP-712 域分隔符（绑定 chainId 与本合约地址；统一规范见 docs/eip712-order-spec.md）
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_TYPEHASH, _DOMAIN_NAME_HASH, _DOMAIN_VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice 订单的 EIP-712 签名摘要（客户端与测试可用同一摘要签名/验证）
    function orderDigest(Order calldata order) public view returns (bytes32) {
        return _orderDigest(order);
    }

    function _orderDigest(Order calldata order) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            _ORDER_TYPEHASH,
            keccak256(bytes(order.orderId)),
            order.userAddress,
            order.tokenIn,
            order.tokenOut,
            order.amountIn,
            order.amountOut,
            order.price,
            order.timestamp,
            order.expiresAt,
            order.nonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice 验证订单签名（统一规范）：恢复出的签名者必须等于 order.userAddress
    function verifyOrderSignature(Order calldata order, bytes calldata signature) public view returns (bool) {
        if (signature.length != 65) return false;
        (bytes32 r, bytes32 s, uint8 v) = _splitSignature(signature);
        address signer = ecrecover(_orderDigest(order), v, r, s);
        return signer != address(0) && signer == order.userAddress;
    }

    /// @notice 内部：验签并返回订单 digest（签名不符直接 revert，maker/taker 分开报错便于定位）
    function _verifySignedOrder(SignedOrder calldata signedOrder, string memory errMsg) internal view returns (bytes32 digest) {
        digest = _orderDigest(signedOrder.order);
        require(signedOrder.signature.length == 65, "Settlement: invalid signature length");
        (bytes32 r, bytes32 s, uint8 v) = _splitSignature(signedOrder.signature);
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == signedOrder.order.userAddress, errMsg);
    }

    /// @notice 内部：订单时效校验（已生效且未过期）
    function _checkOrderValidity(Order calldata order) internal view {
        require(order.timestamp <= block.timestamp, "Settlement: order not yet valid");
        require(order.expiresAt > 0 && block.timestamp <= order.expiresAt, "Settlement: order expired");
    }

    /// @notice 内部：把一笔成交折算到某个订单自身方向并累加已结算量，累计超签名量即 revert（防超额重放）
    function _accountFill(bytes32 digest, Order calldata order, Fill calldata fill) internal {
        uint256 addIn;
        uint256 addOut;
        if (fill.tokenIn == order.tokenIn) {
            addIn = fill.amountIn;
            addOut = fill.amountOut;
        } else {
            addIn = fill.amountOut;
            addOut = fill.amountIn;
        }
        uint256 newIn = orderFilledIn[digest] + addIn;
        uint256 newOut = orderFilledOut[digest] + addOut;
        require(newIn <= order.amountIn && newOut <= order.amountOut, "Settlement: fill exceeds signed order");
        orderFilledIn[digest] = newIn;
        orderFilledOut[digest] = newOut;
    }

    /// @notice 内部：订单首次结算消耗 nonce（单调水位）；同一订单的部分成交续结（continuation）跳过；
    /// 不同订单复用已被占用的 nonce 时，continuation 必为 false，在此拒绝
    function _consumeOrderNonce(Order calldata order, bool continuation) internal {
        if (usedNonces[order.userAddress][order.nonce]) {
            require(continuation, "Settlement: nonce already used by another order");
            return;
        }
        useNonce(order.userAddress, order.nonce);
    }

    /// @notice 内部：校验一笔 Fill 的双方签名订单（验签/同对/时效/累计上限/nonce），全部通过后才落账
    function _verifyFill(Fill calldata fill) internal {
        Order calldata mo = fill.makerOrder.order;
        Order calldata to = fill.takerOrder.order;
        bytes32 makerDigest = _verifySignedOrder(fill.makerOrder, "Settlement: invalid maker signature");
        bytes32 takerDigest = _verifySignedOrder(fill.takerOrder, "Settlement: invalid taker signature");

        require(mo.userAddress != to.userAddress, "Settlement: maker == taker");
        require(mo.tokenIn == to.tokenIn && mo.tokenOut == to.tokenOut, "Settlement: pair mismatch");
        require(mo.tokenIn != mo.tokenOut, "Settlement: same token");
        require(fill.tokenIn != fill.tokenOut, "Settlement: same token");
        require(fill.amountIn > 0 && fill.amountOut > 0, "Settlement: zero amount");
        require(
            (fill.tokenIn == mo.tokenIn && fill.tokenOut == mo.tokenOut) ||
            (fill.tokenIn == mo.tokenOut && fill.tokenOut == mo.tokenIn),
            "Settlement: token mismatch"
        );
        _checkOrderValidity(mo);
        _checkOrderValidity(to);

        // 先于落账读取「是否已有成交」，供 nonce 独占判定（防同 nonce 异订单在本笔内自证续结）
        bool makerContinuation = orderFilledIn[makerDigest] > 0 || orderFilledOut[makerDigest] > 0;
        bool takerContinuation = orderFilledIn[takerDigest] > 0 || orderFilledOut[takerDigest] > 0;
        _accountFill(makerDigest, mo, fill);
        _accountFill(takerDigest, to, fill);
        _consumeOrderNonce(mo, makerContinuation);
        _consumeOrderNonce(to, takerContinuation);
    }
    
    /// @notice 拆分签名
    function _splitSignature(bytes memory signature) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(signature.length == 65, "Settlement: invalid signature length");
        // 仅按固定偏移读取 signature 内存数组，不写内存、不分配，符合 memory-safe 语义；
        // 缺此标注时 via_ir 的 Yul 优化器会在本合约其它函数上误报 stack-too-deep
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Settlement: invalid v");
    }

    /// @notice 结算一笔成交：双方订单必须为统一规范的 EIP-712 签名订单（docs/eip712-order-spec.md）。
    /// 合约逐项验签、校验累计成交量不超签名量并消耗双方 nonce，中继者只是无须信任的搬运工。
    /// @param fill makerOrder/takerOrder 为双方签名订单；amountIn = maker 卖出 tokenIn 量，amountOut = taker 卖出 tokenOut 量；
    /// gasReimburseIn/Out 为从 maker/taker 侧扣除给 gas 代付方的数量（0 表示无代付），非 0 时受 maxGasReimbursePerTrade 上限约束
    function settleTrade(Fill calldata fill) external nonReentrant {
        require(_isSettlementCaller(), "Settlement: not auth");

        address maker = fill.makerOrder.order.userAddress;
        address taker = fill.takerOrder.order.userAddress;
        require(maker != address(0) && taker != address(0), "Settlement: zero address");
        require(fill.tokenIn != address(0) && fill.tokenOut != address(0), "Settlement: zero token");
        require(fill.amountIn <= type(uint128).max && fill.amountOut <= type(uint128).max, "Settlement: amount overflow");

        bool withGas = fill.gasReimburseIn > 0 || fill.gasReimburseOut > 0;
        if (withGas && maxGasReimbursePerTrade > 0) {
            require(fill.gasReimburseIn + fill.gasReimburseOut <= maxGasReimbursePerTrade, "Settlement: gas reimburse cap");
        }

        // Relayer 限流和信誉检查
        if (msg.sender != owner) {
            _checkRelayerRateLimit(msg.sender);
            _checkRelayerReputation(msg.sender);
        }

        // 验签 + 累计上限 + nonce 消耗（防重放）
        _verifyFill(fill);

        (uint256 feeIn, uint256 feeOut) = _feesFor(fill.tokenIn, fill.tokenOut, fill.amountIn, fill.amountOut, feeBps);

        _settleOne(maker, taker, fill.tokenIn, fill.tokenOut, fill.amountIn, fill.amountOut, feeIn, feeOut, fill.gasReimburseIn, fill.gasReimburseOut);

        // 更新Relayer信誉（成功交易）
        if (msg.sender != owner) {
            _updateRelayerReputationSuccess(msg.sender);
        }
    }

    /// @notice 批量结算多笔成交（节省 Gas）；每笔 Fill 与单笔走同一套验签/防重放校验，无例外路径
    function settleTradesBatch(Fill[] calldata fills) external nonReentrant {
        require(_isSettlementCaller(), "Settlement: not auth");

        // Relayer 限流检查（批量调用只计一次）
        if (msg.sender != owner) {
            _checkRelayerRateLimit(msg.sender);
        }
        uint256 len = fills.length;
        require(len > 0 && len <= 50, "Settlement: batch size 1-50");

        uint16 _feeBps = feeBps;
        for (uint256 i = 0; i < len; i++) {
            _settleBatchItem(fills[i], _feeBps);
        }
    }

    /// @notice 内部：Fill 的默克尔叶子（绑定双方签名订单摘要与成交量，见 settleTradesBatchWithMerkle）
    function _fillLeaf(Fill calldata fill) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            _orderDigest(fill.makerOrder.order),
            _orderDigest(fill.takerOrder.order),
            fill.tokenIn,
            fill.tokenOut,
            fill.amountIn,
            fill.amountOut,
            fill.gasReimburseIn,
            fill.gasReimburseOut
        ));
    }

    /// @notice 内部：批量结算的单笔逻辑（gas 报销上限 + 验签记账 + 计费 + 结算），供三个批量入口共用
    function _settleBatchItem(Fill calldata fill, uint16 _feeBps) internal {
        bool withGas = fill.gasReimburseIn > 0 || fill.gasReimburseOut > 0;
        if (withGas && maxGasReimbursePerTrade > 0) {
            require(fill.gasReimburseIn + fill.gasReimburseOut <= maxGasReimbursePerTrade, "Settlement: gas reimburse cap");
        }

        _verifyFill(fill);

        (uint256 feeIn, uint256 feeOut) = _feesFor(fill.tokenIn, fill.tokenOut, fill.amountIn, fill.amountOut, _feeBps);
        _settleOne(
            fill.makerOrder.order.userAddress, fill.takerOrder.order.userAddress,
            fill.tokenIn, fill.tokenOut, fill.amountIn, fill.amountOut,
            feeIn, feeOut, fill.gasReimburseIn, fill.gasReimburseOut
        );
    }

    /// @notice 批量结算并分配 gas 节省：50% 减 fee 退用户，25% 进 FeeDistributor，25% 进 NodeRewards 创始人积分（按当时 USDT 价值）
    /// @param gasSavingsUsdt6 本次批量相对单笔结算节省的 gas 价值（USDT 6 位小数）；0 则不做分配
    /// 调用前 relayer 需 approve(settlement, gasSavingsUsdt6 * 50%)，用于 25% FD + 25% 创始人
    function settleTradesBatchWithGasSavings(
        Fill[] calldata fills,
        uint256 gasSavingsUsdt6
    ) external nonReentrant {
        require(_isSettlementCaller(), "Settlement: not auth");

        // Relayer 限流检查
        if (msg.sender != owner) {
            _checkRelayerRateLimit(msg.sender);
        }
        uint256 len = fills.length;
        require(len > 0 && len <= 50, "Settlement: batch size 1-50");

        if (gasSavingsUsdt6 == 0) {
            uint16 _feeBps0 = feeBps;
            for (uint256 i = 0; i < len; i++) {
                _settleBatchItem(fills[i], _feeBps0);
            }
            return;
        }

        address _usdt = usdtToken;
        uint16 _feeBps = feeBps;
        uint256 totalFeeUsdt;
        uint256[] memory feeIns = new uint256[](len);
        uint256[] memory feeOuts = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            Fill calldata fill = fills[i];
            bool withGas = fill.gasReimburseIn > 0 || fill.gasReimburseOut > 0;
            if (withGas && maxGasReimbursePerTrade > 0) {
                require(fill.gasReimburseIn + fill.gasReimburseOut <= maxGasReimbursePerTrade, "Settlement: gas reimburse cap");
            }
            _verifyFill(fill);
            (uint256 feeIn, uint256 feeOut) = _feesFor(fill.tokenIn, fill.tokenOut, fill.amountIn, fill.amountOut, _feeBps);
            feeIns[i] = feeIn;
            feeOuts[i] = feeOut;
            if (_usdt != address(0)) {
                if (fill.tokenIn == _usdt) totalFeeUsdt += feeIn;
                if (fill.tokenOut == _usdt) totalFeeUsdt += feeOut;
            }
        }

        uint256 userRebateUsdt;
        if (_usdt != address(0) && totalFeeUsdt > 0) {
            userRebateUsdt = (gasSavingsUsdt6 * 50) / 100;
            if (userRebateUsdt > totalFeeUsdt) userRebateUsdt = totalFeeUsdt;
            _applyUserRebate(feeIns, feeOuts, fills, _usdt, totalFeeUsdt, userRebateUsdt);
        }

        for (uint256 i = 0; i < len; i++) {
            Fill calldata fill = fills[i];
            _settleOne(
                fill.makerOrder.order.userAddress, fill.takerOrder.order.userAddress,
                fill.tokenIn, fill.tokenOut, fill.amountIn, fill.amountOut,
                feeIns[i], feeOuts[i], fill.gasReimburseIn, fill.gasReimburseOut
            );
        }

        _distributeGasSavings(gasSavingsUsdt6, userRebateUsdt);
    }

    /// @notice 内部：按各笔 USDT 手续费占比从 feeIns/feeOuts 中扣减用户返利（gas 节省的 50%）
    function _applyUserRebate(
        uint256[] memory feeIns,
        uint256[] memory feeOuts,
        Fill[] calldata fills,
        address _usdt,
        uint256 totalFeeUsdt,
        uint256 userRebateUsdt
    ) internal pure {
        uint256 len = feeIns.length;
        for (uint256 i = 0; i < len; i++) {
            uint256 feeInUsdt = fills[i].tokenIn == _usdt ? feeIns[i] : 0;
            uint256 feeOutUsdt = fills[i].tokenOut == _usdt ? feeOuts[i] : 0;
            uint256 part = feeInUsdt + feeOutUsdt;
            if (part == 0 || totalFeeUsdt == 0) continue;
            uint256 deduct = (userRebateUsdt * part) / totalFeeUsdt;
            uint256 deductIn = (deduct * feeInUsdt) / part;
            uint256 deductOut = deduct - deductIn;
            if (feeInUsdt >= deductIn) feeIns[i] -= deductIn; else feeIns[i] = 0;
            if (feeOutUsdt >= deductOut) feeOuts[i] -= deductOut; else feeOuts[i] = 0;
        }
    }

    /// @notice 内部：分配 gas 节省的 25% 至 FeeDistributor、25% 至创始人奖励（调用者需先 approve 对应 USDT）
    function _distributeGasSavings(uint256 gasSavingsUsdt6, uint256 userRebateUsdt) internal {
        address _usdt = usdtToken;
        uint256 toFD = (gasSavingsUsdt6 * 25) / 100;
        uint256 toFounder = (gasSavingsUsdt6 * 25) / 100;
        if (toFD + toFounder > 0 && _usdt != address(0) && address(feeDistributor) != address(0) && nodeRewards != address(0) && founder != address(0)) {
            require(IERC20(_usdt).transferFrom(msg.sender, address(this), toFD + toFounder), "Settlement: gas savings transfer");
            if (toFD > 0) {
                require(IERC20(_usdt).approve(address(feeDistributor), toFD), "Settlement: approve FD");
                feeDistributor.receiveFee(_usdt, toFD);
            }
            if (toFounder > 0) {
                require(IERC20(_usdt).approve(nodeRewards, toFounder), "Settlement: approve NR");
                NodeRewards(nodeRewards).depositFounderReward(founder, toFounder);
            }
            emit GasSavingsDistributed(userRebateUsdt, toFD, toFounder);
        }
    }

    /// @notice 批量结算带默克尔根验证（便于审计）；先验证默克尔根，再批量结算（结算仍逐笔验签）
    /// @param batchId 批次 ID（用于事件索引）
    /// @param merkleRoot 所有 Fill 的默克尔根（叶子见 _fillLeaf：绑定双方签名订单摘要与成交量）
    /// @param fills 结算请求数组
    /// @param proofs 每个 Fill 的默克尔证明数组（proofs[i] 对应第 i 个 Fill）
    function settleTradesBatchWithMerkle(
        uint256 batchId,
        bytes32 merkleRoot,
        Fill[] calldata fills,
        bytes32[][] calldata proofs
    ) external nonReentrant {
        require(_isSettlementCaller(), "Settlement: not auth");

        // Relayer 限流检查
        if (msg.sender != owner) {
            _checkRelayerRateLimit(msg.sender);
        }
        uint256 len = fills.length;
        require(len == proofs.length, "Settlement: length mismatch");
        require(len > 0 && len <= 50, "Settlement: batch size 1-50");

        // 验证每个 Fill 的默克尔证明
        for (uint256 i = 0; i < len; i++) {
            bytes32 leaf = _fillLeaf(fills[i]);
            require(MerkleProof.verify(proofs[i], merkleRoot, leaf), "Settlement: invalid merkle proof");
        }

        // 验证通过后批量结算
        uint16 _feeBps = feeBps;
        for (uint256 i = 0; i < len; i++) {
            _settleBatchItem(fills[i], _feeBps);
        }

        emit TradesBatchSettledWithMerkle(batchId, merkleRoot, len);
    }
}
