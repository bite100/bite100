// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice 参考价源（gas库 设计 §4.5：只许接「已准入的价格面」——部署纪律约束，
///         合约层只认接口）。返回 1e18 单位 token 的资产计价（资产 wei，1e18 定点）。
interface IGasPriceSource {
    function referencePrice(address token) external view returns (uint256 priceE18);
}

/// @notice 包装原生币接口（WETH9 形态）：gas库 的资产即所在链的包装原生币。
interface IWrappedNative is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title GasVault（gas库）——第 63 轮 gas-1，形态 A
/// @notice 设计定版：docs/gas-vault-design-2026-11-08.md + 第 63 轮设计包 §4。
///
/// 定位：存款人注资的 gas 周转池（每链一座，原生币主库：资产 = 包装原生币）。
/// 三件事：① 存款人存取（OZ ERC-4626 最小形态，份额账目骑标准实现）；
/// ② 计量短缺（shortfall）吸收——不改 Settlement 资金流（形态 A 红线），
///    链下计量后由注册计量人 EIP-712 签名证明（骑第 61 轮 ContributorReward
///    的 attestation 模式，metricType = 4），合约验签后从池中付给受益人；
/// ③ 库存换汇补油箱：回收的成交币种攒在库内，任何人可在原生币水位低于
///    警戒线时公开触发 triggerConversion 经白名单聚合器换回包装原生币并
///    解包补进原生币浮存（Ren 2026-11-10 定版：水位触发 + 公开可触发）。
///
/// 账目口径：totalAssets = 包装原生币余额 + 原生币余额（1:1 同值）——浮存
/// 不是池外资金，它就是存款人资产的一种形态；提款时自动把原生币包回资产
/// 形态支付。换汇输出的包装原生币随即解包补浮存（形态转换，总值不变）。
///
/// 管理员面（设计 §4.5 四法出厂分类，详见轮次文档管理员清单）：
/// - 资金搬运入口：不存在（法①——没有 transferOut / emergencyWithdraw，
///   owner 也搬不走池内一分钱；吸收支付只认计量人签名，换汇只认公式熔断）；
/// - triggerConversion：无许可（任何人可触发，约束全在合约公式里）；
/// - absorbShortfall：无管理员，验签驱动（法③）；
/// - 参数设置（目标水位/警戒线比例/路由白名单/价源/换汇限额）：onlyOwner，
///   过渡期管理面（法②的反面清单）——主网部署后移交多签+时锁，最终随
///   owner 一并 renounce（法④）；价源只许指向已准入价格面（部署纪律）；
/// - pause：只停存入（deposit/mint），永不挡提款与吸收/换汇（存款人退出权
///   与系统补油箱都不受管理员情绪影响）。
contract GasVault is ERC4626, Ownable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice 短缺吸收证明的指标线编号（接第 61 轮计量线编号体系：0 中继 /
    ///         1 挂单 / 2 结算提交 / 3 gas库存款 / 4 = 短缺吸收）
    uint8 public constant METRIC_TYPE_SHORTFALL = 4;

    /// @notice 换汇熔断：到手不得低于参考价估值的 97%（合约自算，与调用者
    ///         给的 minOut 取大者——调用者只能加严，不能放松）
    uint256 public constant FUSE_MIN_BPS = 9700;

    bytes32 private constant SHORTFALL_TYPEHASH = keccak256(
        "ShortfallAttestation(bytes32 claimId,address beneficiary,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    /// @notice Settlement 地址（形态 B 的回收记账入口绑定）。形态 A 部署时
    ///         传零地址：creditRecovered 形状冻结但无人可调（见该函数注记）。
    address public immutable settlement;

    /// @notice 目标浮存（原生币 wei）：水位管理的标尺
    uint256 public targetFloat;
    /// @notice 警戒线比例（bps）：原生币余额 < targetFloat × bps / 10000 时
    ///         允许公开触发换汇。定版口径 = 40%（4000）。
    uint16 public lowWatermarkBps;
    /// @notice 参考价源（已准入价格面）
    IGasPriceSource public priceSource;
    /// @notice 换汇单次上限（按参考价估值的资产 wei 计）
    uint256 public conversionCap;
    /// @notice 两次换汇的最小间隔（秒，全局）
    uint256 public minConversionInterval;
    /// @notice 粉尘门槛：参考价估值低于此（资产 wei，约 $10 等值）的库存不值得换
    uint256 public dustThreshold;
    /// @notice 上次成功换汇时间
    uint256 public lastConversionAt;

    /// @notice 聚合器路由白名单
    mapping(address => bool) public routers;
    /// @notice 计量人注册表（metricType => measurer => enabled），骑第 61 轮同构
    mapping(uint8 => mapping(address => bool)) public measurers;
    /// @notice 已消费的证明（防重放）
    mapping(bytes32 => bool) public attestationConsumed;
    /// @notice 形态 B 回收记账（token => 累计记账额，仅 Settlement 可写）
    mapping(address => uint256) public creditedBook;

    event MeasurerSet(uint8 indexed metricType, address indexed measurer, bool enabled);
    event TargetFloatSet(uint256 oldTarget, uint256 newTarget);
    event LowWatermarkBpsSet(uint16 oldBps, uint16 newBps);
    event PriceSourceSet(address indexed oldSource, address indexed newSource);
    event ConversionLimitsSet(uint256 cap, uint256 minInterval, uint256 dustThreshold);
    event RouterSet(address indexed router, bool allowed);
    event FloatFunded(address indexed from, uint256 amount);
    event ShortfallAbsorbed(bytes32 indexed claimId, address indexed beneficiary, uint256 amount, address indexed measurer);
    event ConversionTriggered(
        address indexed caller, address indexed tokenIn, uint256 amountIn, uint256 assetReceived, uint256 minOut
    );
    event RecoveredCredited(address indexed token, uint256 amount, uint256 refPriceUsed);

    constructor(
        IWrappedNative _asset,
        string memory _name,
        string memory _symbol,
        address _settlement,
        address _initialOwner
    ) ERC20(_name, _symbol) ERC4626(_asset) Ownable(_initialOwner) EIP712("Bit100 GasVault", "1") {
        require(address(_asset) != address(0), "GasVault: zero asset");
        settlement = _settlement;
        lowWatermarkBps = 4000; // 定版：警戒线 = 目标水位 40%
    }

    // ------------------------------------------------------------------
    // 存款人面（ERC-4626）：pause 只停存入，提款永不受阻
    // ------------------------------------------------------------------

    function deposit(uint256 assets, address receiver) public override whenNotPaused returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override whenNotPaused returns (uint256) {
        return super.mint(shares, receiver);
    }

    /// @notice 总资产 = 包装原生币余额 + 原生币浮存（1:1 同值，形态不同而已）
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + address(this).balance;
    }

    /// @dev 提款/吸收付款前保证资产形态的流动性：不足部分把原生币包回资产。
    ///      可包额度恒够：liquid + native = totalAssets ≥ 本次支付额（份额账目保证）。
    function _ensureAssetLiquidity(uint256 needed) internal {
        uint256 liquid = IERC20(asset()).balanceOf(address(this));
        if (liquid < needed) {
            IWrappedNative(asset()).deposit{value: needed - liquid}();
        }
    }

    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        _ensureAssetLiquidity(assets);
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @notice 任何人可为浮存注资原生币（运营可有可无：油箱不必等官方钱包）
    function fundFloat() external payable {
        require(msg.value > 0, "GasVault: zero funding");
        emit FloatFunded(msg.sender, msg.value);
    }

    /// @notice 接收原生币（解包回款 / 直接转账注资）
    receive() external payable {}

    // ------------------------------------------------------------------
    // 短缺吸收（形态 A）：计量人 EIP-712 证明驱动，无管理员入口
    // ------------------------------------------------------------------

    function shortfallAttestationDigest(
        bytes32 claimId,
        address beneficiary,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(SHORTFALL_TYPEHASH, claimId, beneficiary, amount, nonce, deadline))
        );
    }

    /// @notice 凭计量人签名证明吸收一笔计量短缺：从池中向受益人（结算提交者）
    ///         支付 amount 的资产。短缺的计量在链下（Settlement 资金流零改动），
    ///         本函数只验签与付款；池内不足时按实付余额封顶之外一律回滚——
    ///         宁可不付，也不许池外造钱。
    function absorbShortfall(
        bytes32 claimId,
        address beneficiary,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata measurerSignature
    ) external nonReentrant {
        require(beneficiary != address(0), "GasVault: zero beneficiary");
        require(amount > 0, "GasVault: zero amount");
        require(block.timestamp <= deadline, "GasVault: attestation expired");
        bytes32 digest = shortfallAttestationDigest(claimId, beneficiary, amount, nonce, deadline);
        address measurer = ECDSA.recover(digest, measurerSignature);
        require(measurers[METRIC_TYPE_SHORTFALL][measurer], "GasVault: unregistered measurer");
        bytes32 key = keccak256(abi.encode(measurer, claimId, nonce));
        require(!attestationConsumed[key], "GasVault: attestation replayed");
        attestationConsumed[key] = true;
        require(amount <= totalAssets(), "GasVault: shortfall exceeds pool");
        _ensureAssetLiquidity(amount);
        IERC20(asset()).safeTransfer(beneficiary, amount);
        emit ShortfallAbsorbed(claimId, beneficiary, amount, measurer);
    }

    // ------------------------------------------------------------------
    // 库存换汇（公开触发 + 水位门 + 合约自算熔断）
    // ------------------------------------------------------------------

    /// @notice 当前警戒线（原生币 wei）：targetFloat × lowWatermarkBps / 10000
    function lowWatermark() public view returns (uint256) {
        return (targetFloat * uint256(lowWatermarkBps)) / 10000;
    }

    /// @notice 公开触发库存换汇：把库内 tokenIn 库存经白名单聚合器换回包装
    ///         原生币，并立即解包补进原生币浮存。放行条件全是合约公式（与
    ///         调用者无关）：水位低于警戒线 / 路由在白名单 / 距上次换汇够久 /
    ///         估值过粉尘门槛且不超单次上限 / 到手 ≥ max(调用者 minOut, 估值×97%)。
    /// @param swapCalldata 对路由的完整调用数据（聚合器报价单）：输出资产必须
    ///        回到本合约——到手按本合约资产余额增量实测，少于熔断线整笔回滚。
    function triggerConversion(
        address tokenIn,
        uint256 amountIn,
        address router,
        bytes calldata swapCalldata,
        uint256 callerMinOut
    ) external nonReentrant {
        require(tokenIn != address(0) && tokenIn != asset(), "GasVault: invalid tokenIn");
        require(amountIn > 0, "GasVault: zero amountIn");
        require(routers[router], "GasVault: router not whitelisted");
        require(address(this).balance < lowWatermark(), "GasVault: float above watermark");
        require(
            lastConversionAt == 0 || block.timestamp >= lastConversionAt + minConversionInterval,
            "GasVault: conversion too soon"
        );
        require(address(priceSource) != address(0), "GasVault: price source unset");
        uint256 refPrice = priceSource.referencePrice(tokenIn);
        require(refPrice > 0, "GasVault: no reference price");
        uint256 expectedOut = (amountIn * refPrice) / 1e18;
        require(expectedOut >= dustThreshold, "GasVault: below dust threshold");
        require(expectedOut <= conversionCap, "GasVault: exceeds per-call cap");

        uint256 fuseOut = (expectedOut * FUSE_MIN_BPS) / 10000;
        uint256 minOut = callerMinOut > fuseOut ? callerMinOut : fuseOut;

        uint256 balBefore = IERC20(asset()).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(router, amountIn);
        (bool ok, bytes memory ret) = router.call(swapCalldata);
        if (!ok) {
            // 路由失败原因原样上抛，便于链下诊断
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        uint256 received = IERC20(asset()).balanceOf(address(this)) - balBefore;
        require(received >= minOut, "GasVault: received below fuse");

        // 补油箱：换回的包装原生币解包为原生币浮存（形态转换，总资产不变）
        IWrappedNative(asset()).withdraw(received);
        lastConversionAt = block.timestamp;
        emit ConversionTriggered(msg.sender, tokenIn, amountIn, received, minOut);
    }

    // ------------------------------------------------------------------
    // 形态 B 接口形状冻结（本轮不接线）
    // ------------------------------------------------------------------

    /// @notice 回收记账入口（gas-vault 设计 §4 冻结的接口形状）：形态 B 下
    ///         Settlement 结算时把回收额记到本库并附结算所用参考价。形态 A
    ///         的 settlement 为零地址，本函数恒回滚——形状先行，接线是主网门
    ///         决策项，不在本轮。
    function creditRecovered(address token, uint256 amount, uint256 refPriceUsed) external {
        require(settlement != address(0), "GasVault: form A - settlement not wired");
        require(msg.sender == settlement, "GasVault: only settlement");
        creditedBook[token] += amount;
        emit RecoveredCredited(token, amount, refPriceUsed);
    }

    // ------------------------------------------------------------------
    // 过渡期管理面（onlyOwner；分类与退役次序见轮次文档管理员清单）
    // ------------------------------------------------------------------

    function setMeasurer(uint8 metricType, address measurer, bool enabled) external onlyOwner {
        require(measurer != address(0), "GasVault: zero measurer");
        measurers[metricType][measurer] = enabled;
        emit MeasurerSet(metricType, measurer, enabled);
    }

    function setTargetFloat(uint256 newTarget) external onlyOwner {
        uint256 old = targetFloat;
        targetFloat = newTarget;
        emit TargetFloatSet(old, newTarget);
    }

    function setLowWatermarkBps(uint16 newBps) external onlyOwner {
        require(newBps > 0 && newBps <= 10000, "GasVault: invalid bps");
        uint16 old = lowWatermarkBps;
        lowWatermarkBps = newBps;
        emit LowWatermarkBpsSet(old, newBps);
    }

    function setPriceSource(IGasPriceSource newSource) external onlyOwner {
        address old = address(priceSource);
        priceSource = newSource;
        emit PriceSourceSet(old, address(newSource));
    }

    function setConversionLimits(uint256 cap, uint256 minInterval, uint256 dust) external onlyOwner {
        conversionCap = cap;
        minConversionInterval = minInterval;
        dustThreshold = dust;
        emit ConversionLimitsSet(cap, minInterval, dust);
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        require(router != address(0), "GasVault: zero router");
        routers[router] = allowed;
        emit RouterSet(router, allowed);
    }

    /// @notice 暂停：只停存入（见 deposit/mint 的 whenNotPaused），提款与
    ///         吸收/换汇不受影响——这是出厂口径，不是运营选项。
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
