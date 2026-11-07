// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "./Vault.sol";

/// @notice Chainlink AggregatorV3 最小只读接口（喂价层只读 latestRoundData/decimals）
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title MakerVault 做市金库（第二十七轮，Tier 2 合约金库）
/// @notice 档位 2（设计见 docs/market-maker-vault-design.md §3）：合约持有全部资金，
/// 链上登记授权签名者——签名者只能以金库身份签单交易，不能提款；提款只有份额持有人
/// 按 ERC-4626 赎回、且只能打回持有人本人地址。owner 能暂停与轮换签名者，但没有任何
/// 函数能动用存款人的资金（owner 本人取款也须持有份额、走正常赎回）。
///
/// 份额记账：OpenZeppelin ERC-4626 标准组件（接入优先原则：不手写份额会计）。
/// 计价资产 = quote（USDT，18 位 mock）；NAV = 交易 Vault 内金库余额（quote + base
/// 按 Chainlink 参考价折 quote）+ 金库合约直接持有的余量。做市盈亏直接体现在 NAV
/// 上（份额单价涨跌），与 HLP 同构；手续费照付 0.01%（与所有交易者同价）。
///
/// 交易链路：金库存入的 quote 在 deposit 时自动转入交易 Vault（归属金库地址）；
/// 做市签名者以金库地址为 userAddress 签 EIP-712 订单，Settlement 经 ERC-1271
/// （本合约 isValidSignature）验签；成交结算、锁定、手续费全部走既有路径。
/// 赎回时按需从交易 Vault 拉回可用余额（被挂单锁定的部分提不出——先撤单/等过期）。
///
/// 签名者角色：同一登记表未来也承载 settlement submitter / nodeless relayer
/// 角色（signerRoles 区分用途；订单验签只认「已登记」，不限角色——签名机制相同）。
/// 角色载体不写死：后续轮次为 submitter/relayer 加函数时，直接复用本表做准入。
contract MakerVault is ERC4626, Ownable, Pausable, ReentrancyGuard, IERC1271 {
    using SafeERC20 for IERC20;

    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 internal constant ERC1271_FAIL = 0xffffffff;

    /// @notice 签名者角色（用途标签；订单验签只认登记状态，角色供未来 submitter/relayer 准入复用）
    bytes32 public constant ROLE_MARKET_MAKER = keccak256("MARKET_MAKER");
    bytes32 public constant ROLE_SETTLEMENT_SUBMITTER = keccak256("SETTLEMENT_SUBMITTER");
    bytes32 public constant ROLE_RELAYER = keccak256("RELAYER");

    /// @notice 喂价过期阈值 = heartbeat ×3（第 23 轮规则，heartbeat 3600s → 10800s）
    uint256 public constant PRICE_STALE_AFTER = 10800;

    /// @notice 交易 Vault（余额/锁定/结算的发生地；金库资金归属本合约地址）
    address public immutable tradingVault;
    /// @notice 做市基础资产（Sepolia 为 BTC，Base Sepolia 为 ETH——各链唯一已核实 Chainlink feed 的对）
    address public immutable baseToken;
    /// @notice baseToken/USD Chainlink feed（8 位）；用作 base 库存折 quote 的唯一价格来源
    IAggregatorV3 public priceFeed;

    /// @notice 授权签名者（地址 => 是否授权）；只有登记地址代签的订单能通过 ERC-1271 验签
    mapping(address => bool) public authorizedSigners;
    /// @notice 签名者角色（地址 => 角色）；撤销时清零
    mapping(address => bytes32) public signerRoles;

    event SignerSet(address indexed signer, bytes32 indexed role, bool authorized);
    event PriceFeedSet(address indexed oldFeed, address indexed newFeed);
    event SyncedToTradingVault(address indexed token, uint256 amount);

    constructor(IERC20 asset_, address tradingVault_, address baseToken_, address priceFeed_)
        ERC20("Bit100 Maker Vault", "b100MV")
        ERC4626(asset_)
        Ownable(msg.sender)
    {
        require(tradingVault_ != address(0) && baseToken_ != address(0) && priceFeed_ != address(0), "MakerVault: zero address");
        require(address(asset_) != baseToken_, "MakerVault: asset == base");
        tradingVault = tradingVault_;
        baseToken = baseToken_;
        priceFeed = IAggregatorV3(priceFeed_);
        // 存款转发所需授权：只授给交易 Vault 一个地址；提款方向（tradingVault.withdraw）
        // 不依赖本授权（Vault.withdraw 按余额归属放行，调用方即金库本合约）。
        asset_.forceApprove(tradingVault_, type(uint256).max);
    }

    // ---------- ERC-4626：NAV 与资金进出 ----------

    /// @notice NAV（quote 计价）：交易 Vault 内金库余额（quote 直计 + base 按 Chainlink 折 quote）
    /// + 本合约直接持有的余量。锁定中的挂单库存计入 NAV（仍是金库资产）。
    /// base 库存为 0 时不读喂价（无需价格输入）；base > 0 且喂价过期时 revert（fail-closed，
    /// 不以过期价发份额/赎回）。
    function totalAssets() public view override returns (uint256) {
        uint256 quoteInVault = Vault(tradingVault).balanceOf(address(asset()), address(this));
        uint256 baseInVault = Vault(tradingVault).balanceOf(baseToken, address(this));
        uint256 quoteHere = IERC20(asset()).balanceOf(address(this));
        uint256 baseHere = IERC20(baseToken).balanceOf(address(this));
        uint256 baseTotal = baseInVault + baseHere;
        uint256 baseValue = baseTotal == 0 ? 0 : _baseValueInQuote(baseTotal);
        return quoteInVault + quoteHere + baseValue;
    }

    /// @notice 存款：份额按 OZ 标准逻辑铸造；收到的 quote 立即转入交易 Vault（归属金库地址），
    /// 供签名者挂单交易。暂停期间拒绝新存款（赎回不受暂停影响，见 _withdraw）。
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
        whenNotPaused
    {
        super._deposit(caller, receiver, assets, shares);
        if (assets > 0) {
            Vault(tradingVault).deposit(address(asset()), assets);
        }
    }

    /// @notice 赎回/取款：本合约余额不足时先从交易 Vault 拉回差额（仅可用余额；
    /// 被挂单锁定的部分提不出——赎回随之 revert，须先撤单/等订单过期释放锁定）。
    /// 暂停不阻塞赎回：极端行情下存款人始终可以退出（以可用余额为限）。
    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        uint256 here = IERC20(asset()).balanceOf(address(this));
        if (here < assets) {
            Vault(tradingVault).withdraw(address(asset()), assets - here);
        }
        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    /// @notice 把本合约直接持有的资产转入交易 Vault（归属金库地址）：供运营方处理直接
    /// 打入金库合约的资产（如 base 资产误转入、或 USDT 捐赠）。只进不出——资金始终
    /// 归属金库，任何人无法经此提出。owner 或授权签名者可调用。
    function syncToTradingVault(address token, uint256 amount) external {
        require(msg.sender == owner() || authorizedSigners[msg.sender], "MakerVault: not owner or signer");
        require(token == address(asset()) || token == baseToken, "MakerVault: unsupported token");
        require(amount > 0, "MakerVault: zero amount");
        // 只在额度不足时补到无限：按量授权会削掉构造时设的无限额度，导致后续存款自动转发失败
        if (IERC20(token).allowance(address(this), tradingVault) < amount) {
            IERC20(token).forceApprove(tradingVault, type(uint256).max);
        }
        Vault(tradingVault).deposit(token, amount);
        emit SyncedToTradingVault(token, amount);
    }

    // ---------- 喂价 ----------

    /// @notice 最新参考价与新鲜度（新鲜 = 答案 > 0 且 updatedAt 在阈值内；未来时间戳视为过期）
    function latestPrice() public view returns (int256 price, uint256 updatedAt, bool fresh) {
        (, price, , updatedAt, ) = priceFeed.latestRoundData();
        fresh = price > 0 && updatedAt > 0 && block.timestamp >= updatedAt
            && block.timestamp - updatedAt <= PRICE_STALE_AFTER;
    }

    function isPriceFresh() external view returns (bool) {
        (, , bool fresh) = latestPrice();
        return fresh;
    }

    /// @notice 更换喂价（仅 owner；feed 地址须为已核实 Chainlink feed，见各轮文档的地址表）
    function setPriceFeed(address newFeed) external onlyOwner {
        require(newFeed != address(0), "MakerVault: zero feed");
        address old = address(priceFeed);
        priceFeed = IAggregatorV3(newFeed);
        emit PriceFeedSet(old, newFeed);
    }

    /// @notice base 库存折 quote：baseAmount(wei) × feed价 / 10^feedDecimals，再按计价资产
    /// 小数位换算（USDT mock 为 18 位，与美元 18 位定点同口径）。
    function _baseValueInQuote(uint256 baseAmount) internal view returns (uint256) {
        (int256 price, , bool fresh) = latestPrice();
        require(fresh, "MakerVault: stale price feed");
        uint8 feedDec = priceFeed.decimals();
        uint256 valueUsd18 = (baseAmount * uint256(price)) / (10 ** feedDec);
        uint8 assetDec = IERC20Metadata(address(asset())).decimals();
        if (assetDec == 18) return valueUsd18;
        if (assetDec > 18) return valueUsd18 * (10 ** (assetDec - 18));
        return valueUsd18 / (10 ** (18 - assetDec));
    }

    // ---------- 授权签名者（ERC-1271） ----------

    /// @notice 登记/撤销签名者（仅 owner；撤销时角色清零）。签名者密钥泄露时先调本函数
    /// 撤销，再处置资金——撤销后该密钥签的订单立即无法通过验签。
    function setSigner(address signer, bytes32 role, bool authorized) external onlyOwner {
        require(signer != address(0), "MakerVault: zero signer");
        authorizedSigners[signer] = authorized;
        signerRoles[signer] = authorized ? role : bytes32(0);
        emit SignerSet(signer, role, authorized);
    }

    /// @notice ERC-1271：验证某签名是否为登记签名者对本摘要的签名。Settlement 验签金库
    /// 订单时调用（hash 为 Settlement 域下的订单 EIP-712 摘要）。暂停时一律返回失败
    /// （暂停即停做市）；验签失败返回失败值、永不 revert（ERC-1271 规范）。
    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        if (paused()) return ERC1271_FAIL;
        if (signature.length != 65) return ERC1271_FAIL;
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        if (err != ECDSA.RecoverError.NoError) return ERC1271_FAIL;
        if (signer == address(0) || !authorizedSigners[signer]) return ERC1271_FAIL;
        return ERC1271_MAGIC;
    }

    // ---------- Owner 控制 ----------

    /// @notice 暂停：停新存款 + 停订单验签（即停做市）；赎回与签名者轮换不受影响。
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
