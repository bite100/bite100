// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./FeeDistributor.sol";

/// @title AMMPool 简易 AMM 交易池
/// @notice x*y=k 恒定乘积，0.01% 手续费至 FeeDistributor，每笔最高等值 1 美元（由 feeCapPerToken 配置）
/// @notice 支持流动性贡献分：节点注入流动性可获得贡献分
contract AMMPool is ReentrancyGuard {
    address public token0;
    address public token1;
    address public feeDistributor;
    address public contributorReward; // 贡献奖励合约（可选）
    address public owner;
    address public governance;

    uint16 public feeBps = 1; // 0.01%
    mapping(address => uint256) public feeCapPerToken;
    
    /// @notice 滑点保护：最大价格影响（基点，如 500 = 5%）
    uint256 public maxPriceImpactBps = 1000; // 默认 10%
    
    /// @notice 最小流动性要求（防止精度损失和闪电贷攻击）
    uint256 public constant MIN_LIQUIDITY = 10**3; // 1000 wei

    /// @notice 流动性提供者记录
    struct LiquidityProvider {
        uint256 totalLiquidity0;     // 累计注入的 Token0 数量
        uint256 totalLiquidity1;     // 累计注入的 Token1 数量
        uint256 currentLiquidity0;   // 当前持有的 Token0 数量
        uint256 currentLiquidity1;   // 当前持有的 Token1 数量
        uint256 lastUpdateTime;      // 最后更新时间
    }

    mapping(address => LiquidityProvider) public liquidityProviders;

    // 优化事件：减少gas消耗
    event AddLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event RemoveLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swap(
        address indexed sender,
        address indexed tokenIn,
        uint256 amountIn,
        address indexed tokenOut,
        uint256 amountOut,
        uint256 fee,
        uint256 priceImpactBps
    );
    event FeeCapSet(address indexed token, uint256 cap);
    event GovernanceSet(address indexed governance);
    event ContributorRewardSet(address indexed contributorReward);
    event LiquidityScoreUpdated(address indexed provider, uint256 liquidityAmount);
    event MaxPriceImpactBpsSet(uint256 oldBps, uint256 newBps);

    modifier onlyOwner() {
        require(msg.sender == owner, "AMMPool: not owner");
        _;
    }

    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner || (governance != address(0) && msg.sender == governance), "AMMPool: not auth");
        _;
    }

    constructor(address _token0, address _token1, address _feeDistributor) {
        require(_token0 != _token1 && _token0 != address(0) && _token1 != address(0), "AMMPool: invalid tokens");
        token0 = _token0;
        token1 = _token1;
        feeDistributor = _feeDistributor;
        owner = msg.sender;
    }

    function setFeeDistributor(address _feeDistributor) external onlyOwner {
        feeDistributor = _feeDistributor;
    }

    function setGovernance(address _governance) external onlyOwner {
        governance = _governance;
        emit GovernanceSet(_governance);
    }

    function setContributorReward(address _contributorReward) external onlyOwner {
        contributorReward = _contributorReward;
        emit ContributorRewardSet(_contributorReward);
    }

    function setFeeBps(uint16 _feeBps) external onlyOwnerOrGovernance {
        require(_feeBps <= 1000, "AMMPool: fee too high");
        feeBps = _feeBps;
    }

    function setFeeCap(address token, uint256 cap) external onlyOwnerOrGovernance {
        feeCapPerToken[token] = cap;
        emit FeeCapSet(token, cap);
    }
    
    /// @notice 设置最大价格影响（基点）
    function setMaxPriceImpactBps(uint256 _maxBps) external onlyOwnerOrGovernance {
        require(_maxBps <= 10000, "AMMPool: max impact too high"); // 最大 100%
        uint256 old = maxPriceImpactBps;
        maxPriceImpactBps = _maxBps;
        emit MaxPriceImpactBpsSet(old, _maxBps);
    }
    
    /// @notice 计算价格影响（基点）
    function _calculatePriceImpact(
        uint256 rIn,
        uint256 rOut,
        uint256 amountIn,
        uint256 amountOut
    ) internal pure returns (uint256) {
        if (rIn == 0 || rOut == 0) return 0;
        // 价格影响 = (amountOut / rOut) / (amountIn / rIn) - 1
        // 简化为：amountOut * rIn / (amountIn * rOut) - 1
        uint256 priceRatio = (amountOut * rIn * 10000) / (amountIn * rOut);
        if (priceRatio >= 10000) {
            return priceRatio - 10000;
        }
        return 10000 - priceRatio;
    }

    function reserve0() public view returns (uint256) {
        return IERC20(token0).balanceOf(address(this));
    }

    function reserve1() public view returns (uint256) {
        return IERC20(token1).balanceOf(address(this));
    }

    /// @notice 添加流动性（记录流动性提供者，用于贡献分计算）
    function addLiquidity(uint256 amount0, uint256 amount1) external nonReentrant {
        require(amount0 > 0 && amount1 > 0, "AMMPool: zero amount");
        // 防止精度损失：检查最小流动性
        uint256 r0 = reserve0();
        uint256 r1 = reserve1();
        if (r0 == 0 && r1 == 0) {
            require(amount0 >= MIN_LIQUIDITY && amount1 >= MIN_LIQUIDITY, "AMMPool: min liquidity");
        }
        require(IERC20(token0).transferFrom(msg.sender, address(this), amount0), "AMMPool: transfer0 failed");
        require(IERC20(token1).transferFrom(msg.sender, address(this), amount1), "AMMPool: transfer1 failed");
        
        // 记录流动性提供者
        LiquidityProvider storage provider = liquidityProviders[msg.sender];
        provider.totalLiquidity0 += amount0;
        provider.totalLiquidity1 += amount1;
        provider.currentLiquidity0 += amount0;
        provider.currentLiquidity1 += amount1;
        provider.lastUpdateTime = block.timestamp;
        
        // 触发流动性贡献分更新事件（链下监听并更新贡献分）
        emit LiquidityScoreUpdated(msg.sender, amount0); // 使用 amount0 作为流动性数量（简化）
        
        emit AddLiquidity(msg.sender, amount0, amount1, amount0 + amount1);
    }

    /// @notice 移除流动性（简化：按比例取回，无 LP 凭证）
    /// @notice 节点可以移除自己注入的流动性
    function removeLiquidity(uint256 amount0, uint256 amount1) external nonReentrant {
        LiquidityProvider storage provider = liquidityProviders[msg.sender];
        
        // 如果是 owner，允许移除任意流动性（向后兼容）
        // 否则只能移除自己注入的流动性
        if (msg.sender != owner) {
            require(amount0 <= provider.currentLiquidity0 && amount1 <= provider.currentLiquidity1, "AMMPool: insufficient liquidity");
        }
        
        uint256 r0 = reserve0();
        uint256 r1 = reserve1();
        require(amount0 <= r0 && amount1 <= r1, "AMMPool: insufficient reserve");
        
        // 防止移除所有流动性（保留最小流动性）
        require(r0 - amount0 >= MIN_LIQUIDITY || amount0 == 0, "AMMPool: min liquidity");
        require(r1 - amount1 >= MIN_LIQUIDITY || amount1 == 0, "AMMPool: min liquidity");
        
        if (amount0 > 0) require(IERC20(token0).transfer(msg.sender, amount0), "AMMPool: transfer0 failed");
        if (amount1 > 0) require(IERC20(token1).transfer(msg.sender, amount1), "AMMPool: transfer1 failed");
        
        // 更新流动性记录
        if (msg.sender != owner) {
            provider.currentLiquidity0 -= amount0;
            provider.currentLiquidity1 -= amount1;
            provider.lastUpdateTime = block.timestamp;
            
            // 触发流动性贡献分更新事件
            emit LiquidityScoreUpdated(msg.sender, provider.currentLiquidity0);
        }
        
        emit RemoveLiquidity(msg.sender, amount0, amount1, amount0 + amount1);
    }

    /// @notice 查询流动性提供者的流动性数量
    function getLiquidityAmount(address provider) external view returns (uint256) {
        // 简化：使用 Token0 数量作为流动性数量（直接读取，避免复制整个结构体）
        return liquidityProviders[provider].currentLiquidity0;
    }

    /// @notice 交换：转入 tokenIn 数量 amountIn，获得 tokenOut（扣 0.01% 手续费，最高等值 1 美元）
    function swap(address tokenIn, uint256 amountIn) external nonReentrant returns (uint256 amountOut) {
        require(amountIn > 0, "AMMPool: zero amount");
        address tokenOut = tokenIn == token0 ? token1 : token0;
        require(tokenIn == token0 || tokenIn == token1, "AMMPool: invalid token");
        
        // 闪电贷防护：检查最小流动性
        uint256 rIn = tokenIn == token0 ? reserve0() : reserve1();
        uint256 rOut = tokenIn == token0 ? reserve1() : reserve0();
        require(rIn >= MIN_LIQUIDITY && rOut >= MIN_LIQUIDITY, "AMMPool: insufficient liquidity");

        uint256 feeAmount = (amountIn * feeBps) / 10000;
        uint256 cap = feeCapPerToken[tokenIn];
        if (cap > 0 && feeAmount > cap) feeAmount = cap;
        uint256 amountInWithFee = amountIn - feeAmount;
        
        // 精度损失防护：使用更精确的计算
        // amountOut = (rOut * amountInWithFee) / (rIn + amountInWithFee)
        // 防止除零和溢出
        require(rIn + amountInWithFee > rIn, "AMMPool: overflow");
        amountOut = (rOut * amountInWithFee) / (rIn + amountInWithFee);
        require(amountOut > 0 && amountOut < rOut, "AMMPool: bad amountOut");
        
        // 滑点保护：计算价格影响
        uint256 priceImpactBps = _calculatePriceImpact(rIn, rOut, amountIn, amountOut);
        require(priceImpactBps <= maxPriceImpactBps, "AMMPool: price impact too high");

        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "AMMPool: transfer in failed");
        if (feeAmount > 0 && feeDistributor != address(0)) {
            require(IERC20(tokenIn).approve(feeDistributor, feeAmount), "AMMPool: approve failed");
            FeeDistributor(feeDistributor).receiveFee(tokenIn, feeAmount);
        }
        require(IERC20(tokenOut).transfer(msg.sender, amountOut), "AMMPool: transfer out failed");

        emit Swap(msg.sender, tokenIn, amountIn, tokenOut, amountOut, feeAmount, priceImpactBps);
        return amountOut;
    }

    /// @notice 预览 swap 输出（不含实际转账）
    function getAmountOut(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut) {
        if (amountIn == 0) return 0;
        if (tokenIn != token0 && tokenIn != token1) return 0;
        uint256 rIn = tokenIn == token0 ? reserve0() : reserve1();
        uint256 rOut = tokenIn == token0 ? reserve1() : reserve0();
        if (rIn < MIN_LIQUIDITY || rOut < MIN_LIQUIDITY) return 0;
        uint256 feeAmount = (amountIn * feeBps) / 10000;
        uint256 cap = feeCapPerToken[tokenIn];
        if (cap > 0 && feeAmount > cap) feeAmount = cap;
        uint256 amountInWithFee = amountIn - feeAmount;
        if (rIn + amountInWithFee <= rIn) return 0; // 防止溢出
        return (rOut * amountInWithFee) / (rIn + amountInWithFee);
    }
    
    /// @notice 获取价格影响（基点）
    function getPriceImpact(address tokenIn, uint256 amountIn) external view returns (uint256) {
        if (amountIn == 0 || (tokenIn != token0 && tokenIn != token1)) return 0;
        uint256 rIn = tokenIn == token0 ? reserve0() : reserve1();
        uint256 rOut = tokenIn == token0 ? reserve1() : reserve0();
        if (rIn < MIN_LIQUIDITY || rOut < MIN_LIQUIDITY) return type(uint256).max; // 流动性不足
        uint256 feeAmount = (amountIn * feeBps) / 10000;
        uint256 cap = feeCapPerToken[tokenIn];
        if (cap > 0 && feeAmount > cap) feeAmount = cap;
        uint256 amountInWithFee = amountIn - feeAmount;
        uint256 amountOut = (rOut * amountInWithFee) / (rIn + amountInWithFee);
        return _calculatePriceImpact(rIn, rOut, amountIn, amountOut);
    }
}
