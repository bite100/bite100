// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "./Vault.sol";
import "./FeeDistributor.sol";
import "./NodeRewards.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./OrderNonceManager.sol";

/// @notice ChainConfig 中 Settlement 需要的只读接口（gas 换算参考价）
interface IChainConfig {
    function quoteToken() external view returns (address);
    function ethPriceInQuote() external view returns (uint256);
}

/// @title Settlement 交易结算
/// @notice 根据链下撮合结果执行资产划转并收取手续费；0.01% 单边，买卖双方各自代币收取，每边最高等值 1 美元（由 feeCapPerToken 配置）。
/// @notice gas 规则（第二十一轮，Ren 拍板）：中继代付的 gas 不是补贴——结算成功时由合约**链上计量**
/// 本笔实际 gas 成本（gasleft 差值 + 内在成本），按 ChainConfig 参考价换算后，由 maker 与 taker
/// 各承担 50%，以各自收到的资产扣除（单方不超过其收到金额的 gasDeductCapBps，默认 10%，
/// 超出部分协议吸收）；失败/revert 的可归责 gas 由发起者承担（见 chargeFailedSettlement）。
/// Fill.gasReimburseIn/Out 为旧版节点自报字段，自本轮起**被合约忽略**（结构保留以兼容既有 ABI）。
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
    /// @dev 阶段 3 提交者模型 B 后结算路径不再限流（提交开放、滥用靠验签/落锁/
    /// 累计记账与 revert 自担 gas 约束）；本组状态与信誉机制保留，仅作
    /// chargeFailedSettlement 申报角色的治理记录与 ABI 兼容，不再有结算路径读取。
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

    // ---------- gas 对半回收（第二十一轮） ----------
    /// @notice ChainConfig 地址（提供 quoteToken 与 ETH 参考价，供 gas 换算）；0 = 未配置（不扣 gas 分摊）
    address public chainConfig;
    /// @notice 单方 gas 扣除占其该笔收到金额的上限（万分比），默认 1000 = 10%；超出部分协议吸收，不向用户多扣
    uint16 public gasDeductCapBps = 1000;
    /// @notice gasDeductCapBps 硬顶：50%
    uint16 public constant MAX_GAS_DEDUCT_CAP_BPS = 5000;
    /// @notice 批量结算的批大小硬顶（阶段 3 由三处内联字面量收敛为单一常量）：
    /// 单腿结算是全合约最重的执行路径（双边划转 + 手续费 + gas 补扣），实测量级
    /// 约 20–30 万 gas/腿，50 腿约 1000–1500 万 gas，稳在常见 3000 万区块上限的
    /// 一半以内并留足余量；前端市价扫簿的档位上限与本常量对齐（提交层可更小、
    /// 不得更大）。整批单交易执行，任一腿校验失败整批回滚（原子性）。
    uint256 public constant MAX_BATCH_SIZE = 50;
    /// @notice 扣费执行段（补扣划转 + 事件）的固定 gas 预算：计量点在补扣之前，其执行成本以此常量计入
    uint256 public constant GAS_CHARGE_OVERHEAD = 85_000;
    /// @notice 净成本校准系数（万分比）：gasleft() 计量为 SSTORE 退款前的毛 gas，提交者实付为退款
    /// 后净值（回执 gasUsed）。anvil 实测（2026-11-07，详见 docs/round21-gas-rules-2026-11-07.md）：
    /// 全量成交计量 704,117 vs 净 532,047；部分成交计量 682,057 vs 净 557,987。默认 7600 时
    /// 收费误差约 +0.6% / −7.1%——校准纪律：宁可少收（差额协议吸收），不许系统性多收用户；
    /// 主网部署前须在主网分叉重新校准。
    uint16 public meterKeepBps = 7600;
    /// @notice GasCostShared.reason 取值
    uint8 public constant GAS_SHARE_OK = 0;
    uint8 public constant GAS_SHARE_NO_PRICE = 1; // 参考价未配置，整笔不扣
    uint8 public constant GAS_SHARE_NOT_QUOTED = 2; // 交易对两币均非 quote，无法换算，整笔不扣

    // ---------- 失败结算归责扣费（第二十一轮） ----------
    /// @notice 单笔失败扣费的上限（以 quote 计价，最小单位）；0 = 功能关闭（默认）
    uint256 public maxFailureGasChargeQuote;
    /// @notice 订单摘要 => 是否已收过失败扣费（同一订单的失败 gas 只收一次，防重复上报重复扣）
    mapping(bytes32 => bool) public failureCharged;
    /// @notice chargeFailedSettlement 的归责原因（须可链上验证，见函数注释）
    uint8 public constant FAIL_ORDER_EXPIRED = 1;
    uint8 public constant FAIL_LOCK_RELEASED = 2;

    /// @notice 订单方向（阶段 3 Route A：side 进入 EIP-712 签名结构，见 docs/eip712-order-spec.md §2）。
    /// 方向相对签名交易对朝向定义（tokenIn/tokenOut 恒为交易对 Token0/Token1）：
    /// BUY = 签名者付 tokenOut（amountOut）、收 tokenIn（amountIn）；
    /// SELL = 签名者付 tokenIn（amountIn）、收 tokenOut（amountOut）。
    uint8 public constant SIDE_BUY = 0;
    uint8 public constant SIDE_SELL = 1;

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
        /// @notice 方向（SIDE_BUY / SIDE_SELL），阶段 3 起进入签名：结算时合约强制
        /// 「成交付款侧 == 签名方向派生的付款侧」，Vault 落锁方向同样只从本字段派生。
        uint8 side;
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
        keccak256("Order(string orderId,address userAddress,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,uint256 price,uint256 timestamp,uint256 expiresAt,uint256 nonce,uint8 side)");
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
    event FeeDistributorSet(address indexed oldDistributor, address indexed newDistributor);
    event FeeTokenSet(address indexed token);
    event FeeCapSet(address indexed token, uint256 cap);
    /// @notice 每笔结算的 gas 对半回收明细（第二十一轮）：gasUsed/gasCostWei 为本笔计量的实际
    /// gas 与 ETH 成本；maker 侧以 makerToken（其收到的 tokenOut）扣除 makerDeduct，
    /// taker 侧以 takerToken（tokenIn）扣除 takerDeduct；Shortfall 为因安全阀/余额不足
    /// 未能扣足、由协议吸收的部分（同资产计）。reason 见 GAS_SHARE_* 常量。
    event GasCostShared(
        address indexed maker,
        address indexed taker,
        address indexed gasRecipient,
        uint256 gasUsed,
        uint256 gasCostWei,
        uint8 reason,
        address makerToken,
        uint256 makerDeduct,
        uint256 makerShortfall,
        address takerToken,
        uint256 takerDeduct,
        uint256 takerShortfall
    );
    event ChainConfigSet(address indexed oldConfig, address indexed newConfig);
    event GasDeductCapSet(uint16 oldBps, uint16 newBps);
    event MaxFailureGasChargeSet(uint256 oldCapQuote, uint256 newCapQuote);
    event MeterKeepBpsSet(uint16 oldBps, uint16 newBps);
    /// @notice 失败结算归责扣费已执行：digest 为发起者订单摘要，chargedUser 为被扣方（墓碑归属），
    /// reporter 为实际烧掉 gas 的结算提交方（收款方），gasUsedClaimed 为其申报的失败交易 gas 用量
    event FailedSettlementCharged(
        bytes32 indexed digest,
        address indexed chargedUser,
        address indexed reporter,
        address token,
        uint256 amount,
        uint8 reason,
        uint256 gasUsedClaimed
    );
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

    /// @notice 设置手续费分配合约（结算手续费的落地地址）；owner 或 governance 可调用，零地址拒绝。
    /// 此前 feeDistributor 仅能在构造函数中设定，切换手续费落地（如 FeeDistributor 升级）必须
    /// 重部署 Settlement；提供 setter 后切换只需一笔交易。
    function setFeeDistributor(address _feeDistributor) external onlyOwnerOrGovernance {
        require(_feeDistributor != address(0), "Settlement: zero address");
        address old = address(feeDistributor);
        feeDistributor = FeeDistributor(_feeDistributor);
        emit FeeDistributorSet(old, _feeDistributor);
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
    /// @dev 【已弃用，第二十一轮】Fill.gasReimburseIn/Out 自本轮起被合约忽略（gas 改为链上计量
    /// 对半回收），本上限随之失效；保留函数仅为 ABI 兼容，不再有任何结算路径读取它。
    function setMaxGasReimbursePerTrade(uint256 _cap) external onlyOwner {
        uint256 old = maxGasReimbursePerTrade;
        maxGasReimbursePerTrade = _cap;
        emit MaxGasReimbursePerTradeSet(old, _cap);
    }

    /// @notice 设置 ChainConfig（gas 换算参考价来源）；0 地址表示停用换算（结算不扣 gas 分摊）
    function setChainConfig(address _chainConfig) external onlyOwner {
        address old = chainConfig;
        chainConfig = _chainConfig;
        emit ChainConfigSet(old, _chainConfig);
    }

    /// @notice 设置单方 gas 扣除上限比例（万分比，默认 1000 = 收到金额的 10%）；硬顶 50%
    function setGasDeductCapBps(uint16 _bps) external onlyOwnerOrGovernance {
        require(_bps <= MAX_GAS_DEDUCT_CAP_BPS, "Settlement: deduct cap too high");
        uint16 old = gasDeductCapBps;
        gasDeductCapBps = _bps;
        emit GasDeductCapSet(old, _bps);
    }

    /// @notice 设置单笔失败扣费上限（以 quote 计价）；0 = 关闭失败扣费（默认）
    function setMaxFailureGasChargeQuote(uint256 _capQuote) external onlyOwnerOrGovernance {
        uint256 old = maxFailureGasChargeQuote;
        maxFailureGasChargeQuote = _capQuote;
        emit MaxFailureGasChargeSet(old, _capQuote);
    }

    /// @notice 设置净成本校准系数（万分比，≤10000）；主网分叉校准后由治理更新
    function setMeterKeepBps(uint16 _bps) external onlyOwnerOrGovernance {
        require(_bps <= 10_000, "Settlement: keep bps too high");
        uint16 old = meterKeepBps;
        meterKeepBps = _bps;
        emit MeterKeepBpsSet(old, _bps);
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

    /// @notice 检查调用者是否为授权方（owner、单一 relayer 或白名单 relayer）。
    /// @dev 阶段 3 提交者模型 B 后，结算入口（settleTrade / 三个批量入口）已不再
    /// 调用本函数——提交开放给任意地址。本函数仅剩 chargeFailedSettlement 一个
    /// 调用点：失败扣费的收款方是申报人本人、其 gas 支出不可链上验证，故申报
    /// 仍限可信角色。顺序早返回写法：原链式 || 表达式被 via_ir 内联进各结算
    /// 入口后会触发 Yul stack-too-deep。
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
    
    /// @notice 内部：交易内在成本 = 基础 21000 + calldata 成本（按非零字节单价 16 的上界估算，
    /// 零字节实际为 4，上界口径使计量只多不少，差额由安全阀与协议吸收兜底，不会少算用户应担份额的基准）
    function _intrinsicGas() internal view returns (uint256) {
        return 21_000 + msg.data.length * 16;
    }

    /// @notice 内部：读取 gas 换算参考价；未配置 ChainConfig 时返回 (0, 0)
    function _gasPricing() internal view returns (address quote, uint256 ethPrice) {
        if (chainConfig == address(0)) return (address(0), 0);
        quote = IChainConfig(chainConfig).quoteToken();
        ethPrice = IChainConfig(chainConfig).ethPriceInQuote();
    }

    /// @notice 内部：把某方应担的半份 gas（已换算为 quote 计价的 halfQuote）换算为其收到资产的数量。
    /// 收到资产即 quote 时直接相等；否则用本笔成交价换算（对手侧成交量为 quote 量）。
    /// 交易对两币均非 quote 时返回 ok=false（无法换算，整笔不扣）。
    function _gasWantForSide(
        address recvToken,
        uint256 recvTradedAmt,
        address otherToken,
        uint256 otherTradedAmt,
        uint256 halfQuote,
        address quote
    ) internal pure returns (uint256 want, bool ok) {
        if (recvToken == quote) return (halfQuote, true);
        if (otherToken != quote || otherTradedAmt == 0) return (0, false);
        want = (halfQuote * recvTradedAmt) / otherTradedAmt;
        return (want, true);
    }

    /// @notice 内部：对单方执行 gas 扣除，双钳制——安全阀（收到金额的 gasDeductCapBps）与
    /// Vault 可用余额（总余额 − 挂单锁定）；扣除经 transferOut 转给 gas 收款方（结算提交者）。
    /// 未扣足部分即 shortfall，由协议吸收（中继少回收），不向任何人另行收取。
    function _deductGasSide(
        address user,
        address token,
        uint256 want,
        uint256 receivedAmt,
        address gasRecipient
    ) internal returns (uint256 deduct, uint256 shortfall) {
        uint256 cap = (receivedAmt * gasDeductCapBps) / 10_000;
        deduct = want < cap ? want : cap;
        uint256 avail = vault.availableBalance(user, token);
        if (deduct > avail) deduct = avail;
        if (deduct > 0) {
            vault.transferOut(user, gasRecipient, token, deduct);
        }
        shortfall = want - deduct;
    }

    /// @notice 内部：gas 对半回收主逻辑——本笔 gas 成本（ETH）由 maker/taker 各承担一半，
    /// 以各自收到的资产扣除（maker 收 tokenOut、taker 收 tokenIn），与交易费分开记账：
    /// 交易费已在 _settleOne 内按 feeIn/feeOut 落地，本函数只动 gas 这一条线并独立发事件。
    /// makerReceived/takerReceived 为扣交易费后、扣 gas 前的应收额（安全阀基数）。
    function _chargeGasShares(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 makerReceived,
        uint256 takerReceived,
        uint256 gasUsed
    ) internal {
        uint256 gasCostWei = gasUsed * tx.gasprice;
        uint256 makerDeduct;
        uint256 makerShortfall;
        uint256 takerDeduct;
        uint256 takerShortfall;
        uint8 reason = GAS_SHARE_OK;

        if (gasCostWei > 0) {
            (address quote, uint256 ethPrice) = _gasPricing();
            if (quote == address(0) || ethPrice == 0) {
                reason = GAS_SHARE_NO_PRICE;
            } else {
                uint256 halfWei = gasCostWei / 2; // 奇数 wei 时 1 wei 余数由协议吸收，两侧严格同额
                uint256 halfQuote = (halfWei * ethPrice) / 1e18;
                (uint256 wantMaker, bool okMaker) =
                    _gasWantForSide(tokenOut, amountOut, tokenIn, amountIn, halfQuote, quote);
                (uint256 wantTaker, bool okTaker) =
                    _gasWantForSide(tokenIn, amountIn, tokenOut, amountOut, halfQuote, quote);
                if (!okMaker || !okTaker) {
                    reason = GAS_SHARE_NOT_QUOTED;
                } else {
                    (makerDeduct, makerShortfall) =
                        _deductGasSide(maker, tokenOut, wantMaker, makerReceived, msg.sender);
                    (takerDeduct, takerShortfall) =
                        _deductGasSide(taker, tokenIn, wantTaker, takerReceived, msg.sender);
                }
            }
        }

        emit GasCostShared(
            maker, taker, msg.sender, gasUsed, gasCostWei, reason,
            tokenOut, makerDeduct, makerShortfall,
            tokenIn, takerDeduct, takerShortfall
        );
    }

    /// @notice 内部：按 Fill 与已定费用对一笔成交执行 gas 对半回收（各入口在结算落地后调用）
    function _chargeGasForFill(Fill calldata fill, uint256 feeIn, uint256 feeOut, uint256 gasUsed) internal {
        _chargeGasShares(
            fill.makerOrder.order.userAddress,
            fill.takerOrder.order.userAddress,
            fill.tokenIn,
            fill.tokenOut,
            fill.amountIn,
            fill.amountOut,
            fill.amountOut - feeOut, // maker 收到 tokenOut（扣交易费后、扣 gas 前）
            fill.amountIn - feeIn, // taker 收到 tokenIn
            gasUsed
        );
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
            order.nonce,
            order.side
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice 验证订单签名（统一规范）：EOA 恢复路径与此前完全一致（恢复出的签名者
    /// 必须等于 order.userAddress）；userAddress 为合约时追加 ERC-1271 路径
    /// （第二十七轮：做市金库以合约身份下单，登记签名者代签——MakerVault.isValidSignature
    /// 校验签名者是否登记）。合约路径由 SignatureChecker 经 staticcall 调
    /// isValidSignature，失败返回 false 而非 revert；无代码地址直接返回 false。
    /// @dev 阶段 3 修复（ERC-1271 签名长度门）：旧实现以「签名长度 != 65 直接
    /// false」挡在 1271 路径之前，智能钱包的变长签名（如 Safe 的多签聚合签名）
    /// 永远不可达 1271。现改为：65 字节且 v 合法时先走 ECDSA 恢复快路径
    /// （EOA 语义与旧实现逐位一致）；其余任何长度/形态，只要 userAddress
    /// 有代码，一律交给 ERC-1271 判定；无代码地址对非标准签名直接 false。
    function verifyOrderSignature(Order calldata order, bytes calldata signature) public view returns (bool) {
        bytes32 digest = _orderDigest(order);
        if (signature.length == 65) {
            uint8 vRaw = uint8(signature[64]);
            if (vRaw == 27 || vRaw == 28 || vRaw == 0 || vRaw == 1) {
                (bytes32 r, bytes32 s, uint8 v) = _splitSignature(signature);
                address signer = ecrecover(digest, v, r, s);
                if (signer != address(0) && signer == order.userAddress) return true;
            }
        }
        if (order.userAddress.code.length == 0) return false;
        return SignatureChecker.isValidSignatureNow(order.userAddress, digest, signature);
    }

    /// @notice 内部：验签并返回订单 digest（签名不符直接 revert，maker/taker 分开报错便于定位）
    function _verifySignedOrder(SignedOrder calldata signedOrder, string memory errMsg) internal view returns (bytes32 digest) {
        digest = _orderDigest(signedOrder.order);
        require(verifyOrderSignature(signedOrder.order, signedOrder.signature), errMsg);
    }

    /// @notice 内部：订单时效校验（已生效且未过期）
    function _checkOrderValidity(Order calldata order) internal view {
        require(order.timestamp <= block.timestamp, "Settlement: order not yet valid");
        require(order.expiresAt > 0 && block.timestamp <= order.expiresAt, "Settlement: order expired");
    }

    /// @notice 内部：限价强制（阶段 3 价格校验修复轮，P0）：本笔切片在订单自身朝向
    /// 下的实成交比例不得击穿签名限价。签名价的权威表达是签名量本身
    /// （order.amountIn / order.amountOut），故直接交叉相乘比较，全程无除法——
    /// 不经 order.price 的 1e18 定点折算（那是 amountOut/amountIn 的截断商，
    /// 用它比较会在边界上误杀恰在限价的合法小额切片）。
    /// - SELL（付 tokenIn、收 tokenOut）：实收比例不得低于签名价
    ///   addOut/addIn >= amountOut/amountIn ⟺ addOut * amountIn >= addIn * amountOut
    /// - BUY（付 tokenOut、收 tokenIn）：实付比例不得高于签名价
    ///   addOut/addIn <= amountOut/amountIn ⟺ addOut * amountIn <= addIn * amountOut
    /// 乘法溢出时 Solidity 0.8 检查算术直接 revert（失败即关闭，方向安全）；
    /// 实际金额受结算路径的 uint128 上限约束，乘积稳在 2^256 内。
    /// gas 报销/手续费是成交额之外的独立扣项，不进本不等式（校验对象是
    /// fill.amountIn/amountOut 折算出的切片本身）。
    function _requireSignedLimitPrice(Order calldata order, uint256 addIn, uint256 addOut) internal pure {
        if (order.side == SIDE_SELL) {
            require(
                addOut * order.amountIn >= addIn * order.amountOut,
                "Settlement: fill breaches signed limit price"
            );
        } else {
            // side 合法性已在 _verifyFill 先行校验（仅 SIDE_BUY / SIDE_SELL），
            // 此处 else 即 BUY。
            require(
                addOut * order.amountIn <= addIn * order.amountOut,
                "Settlement: fill breaches signed limit price"
            );
        }
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
        // 限价强制：先于累计落账校验本笔切片比例（见 _requireSignedLimitPrice）。
        // 四个结算入口（settleTrade 与三个批量入口）全部经 _verifyFill →
        // _accountFill 至此，无例外路径。
        _requireSignedLimitPrice(order, addIn, addOut);
        uint256 newIn = orderFilledIn[digest] + addIn;
        uint256 newOut = orderFilledOut[digest] + addOut;
        require(newIn <= order.amountIn && newOut <= order.amountOut, "Settlement: fill exceeds signed order");
        orderFilledIn[digest] = newIn;
        orderFilledOut[digest] = newOut;
        // 挂单锁定消费（第十五轮）：把本笔成交折算到订单自身朝向的 (addIn, addOut)
        // 交给 Vault 按锁定 token 取对应侧消费。未落锁的订单在此 revert——无锁定
        // 不结算；与本笔划转同事务，结算失败一并回滚。
        vault.consumeOrderLock(digest, order.tokenIn, addIn, addOut);
    }

    /// @notice 内部：订单首次结算消耗 nonce（第 62 轮起为无序位图位测试，Permit2 式）；
    /// 同一订单的部分成交续结（continuation）跳过；不同订单复用已被占用的 nonce 时，
    /// continuation 必为 false，在此拒绝。nonce 之间无顺序关系，低 nonce 不被高
    /// nonce 的结算阻塞。
    function _consumeOrderNonce(Order calldata order, bool continuation) internal {
        if (_isNonceUsed(order.userAddress, order.nonce)) {
            require(continuation, "Settlement: nonce already used by another order");
            return;
        }
        useNonce(order.userAddress, order.nonce);
    }

    /// @notice 内部：校验一笔 Fill 的双方签名订单（验签/同对/时效/限价/累计上限/nonce），全部通过后才落账
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
        // 方向强制（阶段 3 Route A）：side 已进签名，成交的付款侧必须与签名
        // 方向派生的付款侧一致——SELL 付 tokenIn、BUY 付 tokenOut。
        // Fill 口径：tokenIn = maker 付款侧、tokenOut = taker 付款侧。
        // 旧协议下方向靠簿上自报字段，合约无从校验；自本轮起方向成为
        // 签名事实，方向相反的成交在链上不可能成立（与 Vault 落锁方向
        // 派生同源，见 Vault.lockForOrder）。
        require(mo.side == SIDE_BUY || mo.side == SIDE_SELL, "Settlement: invalid maker side");
        require(to.side == SIDE_BUY || to.side == SIDE_SELL, "Settlement: invalid taker side");
        address makerPayToken = mo.side == SIDE_SELL ? mo.tokenIn : mo.tokenOut;
        address takerPayToken = to.side == SIDE_SELL ? to.tokenIn : to.tokenOut;
        require(makerPayToken == fill.tokenIn, "Settlement: maker direction mismatch");
        require(takerPayToken == fill.tokenOut, "Settlement: taker direction mismatch");
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
    /// gas 自本轮起由合约计量并对半回收（见 _chargeGasShares）；fill.gasReimburseIn/Out 被忽略。
    /// @dev 提交者模型 B（阶段 3，Ren 2026-11-08 拍板）：本入口**无调用者限制**——
    /// 任何地址可提交有效 Fill，安全性全部来自链上强制校验（双方验签、签名方向、
    /// 签名限价、落锁消费、累计成交上限、nonce 独占、时效）；无效 Fill 必然 revert，gas 由
    /// 发起者自担（EVM 原生语义）。gas 对半回收的收款方为实际提交者 msg.sender，
    /// 即「谁提交谁回收」，与提交者身份无关。旧 A 模型（owner/relayer 白名单 +
    /// 限流 + 信誉门）自本轮退出结算路径；relayer 角色仅保留给
    /// chargeFailedSettlement 的归责申报（收款方身份不可链上验证，须可信角色）。
    /// @param fill makerOrder/takerOrder 为双方签名订单；amountIn = maker 卖出 tokenIn 量，amountOut = taker 卖出 tokenOut 量
    function settleTrade(Fill calldata fill) external nonReentrant {
        uint256 gasStart = gasleft();

        address maker = fill.makerOrder.order.userAddress;
        address taker = fill.takerOrder.order.userAddress;
        require(maker != address(0) && taker != address(0), "Settlement: zero address");
        require(fill.tokenIn != address(0) && fill.tokenOut != address(0), "Settlement: zero token");
        require(fill.amountIn <= type(uint128).max && fill.amountOut <= type(uint128).max, "Settlement: amount overflow");

        // 验签 + 累计上限 + nonce 消耗（防重放）
        _verifyFill(fill);

        (uint256 feeIn, uint256 feeOut) = _feesFor(fill.tokenIn, fill.tokenOut, fill.amountIn, fill.amountOut, feeBps);

        _settleOne(maker, taker, fill.tokenIn, fill.tokenOut, fill.amountIn, fill.amountOut, feeIn, feeOut, 0, 0);

        // gas 对半回收：计量 = 执行差值 + 内在成本 + 扣费执行常量（其 gas 在计量点之后发生），
        // 再乘净成本校准系数（毛计量 → 退款后净值）
        uint256 gasUsed = gasStart - gasleft() + _intrinsicGas() + GAS_CHARGE_OVERHEAD;
        gasUsed = (gasUsed * meterKeepBps) / 10_000;
        _chargeGasForFill(fill, feeIn, feeOut, gasUsed);
    }

    /// @notice 批量结算多笔成交（节省 Gas）；每笔 Fill 与单笔走同一套验签/防重放校验，无例外路径。
    /// gas 对半回收：整批计量（入口 gasStart 至全部结算落地的差值 + 内在成本）后按笔均摊，
    /// 逐笔补扣（每笔另加扣费执行常量）——同批同价，归属口径见 docs/round21-gas-rules-2026-11-07.md
    function settleTradesBatch(Fill[] calldata fills) external nonReentrant {
        uint256 gasStart = gasleft();
        // 提交者模型 B（见 settleTrade）：无调用者限制，整批原子——任一腿
        // _verifyFill/结算失败则整笔交易回滚，已落账的前序腿一并撤销。
        uint256 len = fills.length;
        require(len > 0 && len <= MAX_BATCH_SIZE, "Settlement: batch size too large");

        uint16 _feeBps = feeBps;
        for (uint256 i = 0; i < len; i++) {
            _settleBatchItem(fills[i], _feeBps);
        }

        uint256 perItemGas = ((gasStart - gasleft() + _intrinsicGas()) / len + GAS_CHARGE_OVERHEAD) * meterKeepBps / 10_000;
        for (uint256 i = 0; i < len; i++) {
            (uint256 feeIn, uint256 feeOut) =
                _feesFor(fills[i].tokenIn, fills[i].tokenOut, fills[i].amountIn, fills[i].amountOut, _feeBps);
            _chargeGasForFill(fills[i], feeIn, feeOut, perItemGas);
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

    /// @notice 内部：批量结算的单笔逻辑（验签记账 + 计费 + 结算），供三个批量入口共用；
    /// gas 补扣不在此处，由各入口在整批结算后按均摊计量逐笔执行（见 settleTradesBatch）
    function _settleBatchItem(Fill calldata fill, uint16 _feeBps) internal {
        _verifyFill(fill);

        (uint256 feeIn, uint256 feeOut) = _feesFor(fill.tokenIn, fill.tokenOut, fill.amountIn, fill.amountOut, _feeBps);
        _settleOne(
            fill.makerOrder.order.userAddress, fill.takerOrder.order.userAddress,
            fill.tokenIn, fill.tokenOut, fill.amountIn, fill.amountOut,
            feeIn, feeOut, 0, 0
        );
    }

    /// @notice 批量结算并分配 gas 节省：50% 减 fee 退用户，25% 进 FeeDistributor，25% 进 NodeRewards 创始人积分（按当时 USDT 价值）
    /// @param gasSavingsUsdt6 本次批量相对单笔结算节省的 gas 价值（USDT 6 位小数）；0 则不做分配
    /// 调用前 relayer 需 approve(settlement, gasSavingsUsdt6 * 50%)，用于 25% FD + 25% 创始人
    function settleTradesBatchWithGasSavings(
        Fill[] calldata fills,
        uint256 gasSavingsUsdt6
    ) external nonReentrant {
        uint256 gasStart = gasleft();
        // 提交者模型 B（见 settleTrade）：无调用者限制，整批原子。
        uint256 len = fills.length;
        require(len > 0 && len <= MAX_BATCH_SIZE, "Settlement: batch size too large");

        if (gasSavingsUsdt6 == 0) {
            uint16 _feeBps0 = feeBps;
            for (uint256 i = 0; i < len; i++) {
                _settleBatchItem(fills[i], _feeBps0);
            }
            uint256 perItemGas0 = ((gasStart - gasleft() + _intrinsicGas()) / len + GAS_CHARGE_OVERHEAD) * meterKeepBps / 10_000;
            for (uint256 i = 0; i < len; i++) {
                (uint256 feeIn0, uint256 feeOut0) =
                    _feesFor(fills[i].tokenIn, fills[i].tokenOut, fills[i].amountIn, fills[i].amountOut, _feeBps0);
                _chargeGasForFill(fills[i], feeIn0, feeOut0, perItemGas0);
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
                feeIns[i], feeOuts[i], 0, 0
            );
        }

        // gas 对半回收：整批计量后按笔均摊，用返利后的最终费用算各方收到额
        uint256 perItemGas = ((gasStart - gasleft() + _intrinsicGas()) / len + GAS_CHARGE_OVERHEAD) * meterKeepBps / 10_000;
        for (uint256 i = 0; i < len; i++) {
            _chargeGasForFill(fills[i], feeIns[i], feeOuts[i], perItemGas);
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
        uint256 gasStart = gasleft();
        // 提交者模型 B（见 settleTrade）：无调用者限制，整批原子。
        uint256 len = fills.length;
        require(len == proofs.length, "Settlement: length mismatch");
        require(len > 0 && len <= MAX_BATCH_SIZE, "Settlement: batch size too large");

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

        // gas 对半回收：整批计量（含证明验证段）按笔均摊后逐笔补扣
        uint256 perItemGas = ((gasStart - gasleft() + _intrinsicGas()) / len + GAS_CHARGE_OVERHEAD) * meterKeepBps / 10_000;
        for (uint256 i = 0; i < len; i++) {
            (uint256 feeIn, uint256 feeOut) =
                _feesFor(fills[i].tokenIn, fills[i].tokenOut, fills[i].amountIn, fills[i].amountOut, _feeBps);
            _chargeGasForFill(fills[i], feeIn, feeOut, perItemGas);
        }

        emit TradesBatchSettledWithMerkle(batchId, merkleRoot, len);
    }

    /// @notice 失败结算归责扣费（第二十一轮）：一笔结算交易已上链且 revert、gas 已被提交者实际
    /// 消耗时，由提交者（msg.sender，即 gas 的实际承担人）上报，对可归责的发起者收取补偿。
    /// 归责只认链上可验证事实，不认口头归责：
    /// - 订单必须在 Vault 落过锁（lockTombstones 有记录）——被扣用户与资产由 Vault 在验签落锁时
    ///   写定，无法伪造；从未落锁的订单不在此列（其失败应在落锁/接单环节被拦下，无结算 gas 可言）。
    /// - reason = FAIL_ORDER_EXPIRED：订单确已过期（expiresAt < 当前时间），过期后提交必然 revert。
    /// - reason = FAIL_LOCK_RELEASED：订单未被完全结算、但活动锁已不存在（被释放），结算必然
    ///   revert 于 consumeOrderLock；锁正常耗尽 ⟺ 订单已填满，故「未填满而无锁」只能是被释放。
    /// 金额：申报 gasUsed 按 tx.gasprice 与参考价换算为 quote 值，受 maxFailureGasChargeQuote
    /// 单笔上限封顶，再按订单签名价换算为墓碑资产数量，并受被扣方可用余额钳制。gasUsed 本身
    /// 链上不可验证（失败交易的 receipt 不上链），靠上限封顶 + relayer 信誉机制（违规扣分）制衡。
    /// 同一订单只收一次（failureCharged）。不可归责类别（撮合参数错误、重复提交已填满的订单、
    /// 提交方自身问题、系统性失败）不走此入口，gas 由提交方自担；完整归责表见 round21 文档。
    function chargeFailedSettlement(
        SignedOrder calldata signedOrder,
        uint8 reason,
        uint256 gasUsedClaimed
    ) external nonReentrant {
        require(_isSettlementCaller(), "Settlement: not auth");
        require(maxFailureGasChargeQuote > 0, "Settlement: failure charge disabled");
        require(gasUsedClaimed > 0, "Settlement: zero gas claim");

        Order calldata order = signedOrder.order;
        bytes32 digest = _orderDigest(order);
        require(!failureCharged[digest], "Settlement: failure already charged");

        (address tombUser, address tombToken) = vault.lockTombstones(digest);
        require(tombUser != address(0), "Settlement: order never locked");
        require(tombToken == order.tokenIn || tombToken == order.tokenOut, "Settlement: tombstone token mismatch");

        if (reason == FAIL_ORDER_EXPIRED) {
            require(order.expiresAt != 0 && block.timestamp > order.expiresAt, "Settlement: order not expired");
        } else if (reason == FAIL_LOCK_RELEASED) {
            (address lockUser,,,) = vault.orderLocks(digest);
            require(lockUser == address(0), "Settlement: lock still active");
            if (tombToken == order.tokenIn) {
                require(orderFilledIn[digest] < order.amountIn, "Settlement: order already filled");
            } else {
                require(orderFilledOut[digest] < order.amountOut, "Settlement: order already filled");
            }
        } else {
            revert("Settlement: unknown failure reason");
        }

        (address quote, uint256 ethPrice) = _gasPricing();
        require(quote != address(0) && ethPrice != 0, "Settlement: no gas pricing");
        require(quote == order.tokenIn || quote == order.tokenOut, "Settlement: pair not quoted");
        require(order.price > 0, "Settlement: zero order price");

        uint256 wantQuote = (gasUsedClaimed * tx.gasprice * ethPrice) / 1e18;
        uint256 capQuote = wantQuote < maxFailureGasChargeQuote ? wantQuote : maxFailureGasChargeQuote;
        uint256 amount;
        if (tombToken == quote) {
            amount = capQuote;
        } else if (quote == order.tokenOut) {
            // price = amountOut/amountIn（1e18 定点）：quote 在 tokenOut 侧，墓碑资产为 tokenIn（base）
            amount = (capQuote * 1e18) / order.price;
        } else {
            // quote 在 tokenIn 侧，墓碑资产为 tokenOut
            amount = (capQuote * order.price) / 1e18;
        }
        uint256 avail = vault.availableBalance(tombUser, tombToken);
        if (amount > avail) amount = avail;
        require(amount > 0, "Settlement: nothing chargeable");

        failureCharged[digest] = true;
        vault.transferOut(tombUser, msg.sender, tombToken, amount);
        emit FailedSettlementCharged(digest, tombUser, msg.sender, tombToken, amount, reason, gasUsedClaimed);
    }
}
