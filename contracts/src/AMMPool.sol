// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IERC20.sol";
import "./FeeDistributor.sol";

/// @title AMMPool 简易 AMM 交易池
/// @notice x*y=k 恒定乘积，0.01% 手续费至 FeeDistributor，每笔最高等值 1 美元（由 feeCapPerToken 配置）
/// @notice 支持流动性贡献分：节点注入流动性可获得贡献分
contract AMMPool {
    address public token0;
    address public token1;
    address public feeDistributor;
    address public contributorReward; // 贡献奖励合约（可选）
    address public owner;
    address public governance;

    uint16 public feeBps = 1; // 0.01%
    mapping(address => uint256) public feeCapPerToken;

    /// @notice 流动性提供者记录
    struct LiquidityProvider {
        uint256 totalLiquidity0;     // 累计注入的 Token0 数量
        uint256 totalLiquidity1;     // 累计注入的 Token1 数量
        uint256 currentLiquidity0;   // 当前持有的 Token0 数量
        uint256 currentLiquidity1;   // 当前持有的 Token1 数量
        uint256 lastUpdateTime;      // 最后更新时间
    }

    mapping(address => LiquidityProvider) public liquidityProviders;

    event AddLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event RemoveLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swap(address indexed sender, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut, uint256 fee);
    event FeeCapSet(address indexed token, uint256 cap);
    event GovernanceSet(address indexed governance);
    event ContributorRewardSet(address indexed contributorReward);
    event LiquidityScoreUpdated(address indexed provider, uint256 liquidityAmount);

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

    function reserve0() public view returns (uint256) {
        return IERC20(token0).balanceOf(address(this));
    }

    function reserve1() public view returns (uint256) {
        return IERC20(token1).balanceOf(address(this));
    }

    /// @notice 添加流动性（记录流动性提供者，用于贡献分计算）
    function addLiquidity(uint256 amount0, uint256 amount1) external {
        require(amount0 > 0 && amount1 > 0, "AMMPool: zero amount");
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
    function removeLiquidity(uint256 amount0, uint256 amount1) external {
        LiquidityProvider storage provider = liquidityProviders[msg.sender];
        
        // 如果是 owner，允许移除任意流动性（向后兼容）
        // 否则只能移除自己注入的流动性
        if (msg.sender != owner) {
            require(amount0 <= provider.currentLiquidity0 && amount1 <= provider.currentLiquidity1, "AMMPool: insufficient liquidity");
        }
        
        uint256 r0 = reserve0();
        uint256 r1 = reserve1();
        require(amount0 <= r0 && amount1 <= r1, "AMMPool: insufficient reserve");
        
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
    function swap(address tokenIn, uint256 amountIn) external returns (uint256 amountOut) {
        require(amountIn > 0, "AMMPool: zero amount");
        address tokenOut = tokenIn == token0 ? token1 : token0;
        require(tokenIn == token0 || tokenIn == token1, "AMMPool: invalid token");

        uint256 rIn = tokenIn == token0 ? reserve0() : reserve1();
        uint256 rOut = tokenIn == token0 ? reserve1() : reserve0();

        uint256 feeAmount = (amountIn * feeBps) / 10000;
        uint256 cap = feeCapPerToken[tokenIn];
        if (cap > 0 && feeAmount > cap) feeAmount = cap;
        uint256 amountInWithFee = amountIn - feeAmount;
        amountOut = (rOut * amountInWithFee) / (rIn + amountInWithFee);
        require(amountOut > 0 && amountOut <= rOut, "AMMPool: bad amountOut");

        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "AMMPool: transfer in failed");
        if (feeAmount > 0 && feeDistributor != address(0)) {
            require(IERC20(tokenIn).approve(feeDistributor, feeAmount), "AMMPool: approve failed");
            FeeDistributor(feeDistributor).receiveFee(tokenIn, feeAmount);
        }
        require(IERC20(tokenOut).transfer(msg.sender, amountOut), "AMMPool: transfer out failed");

        emit Swap(msg.sender, tokenIn, amountIn, tokenOut, amountOut, feeAmount);
        return amountOut;
    }

    /// @notice 预览 swap 输出（不含实际转账）
    function getAmountOut(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut) {
        if (amountIn == 0) return 0;
        if (tokenIn != token0 && tokenIn != token1) return 0;
        uint256 rIn = tokenIn == token0 ? reserve0() : reserve1();
        uint256 rOut = tokenIn == token0 ? reserve1() : reserve0();
        uint256 feeAmount = (amountIn * feeBps) / 10000;
        uint256 cap = feeCapPerToken[tokenIn];
        if (cap > 0 && feeAmount > cap) feeAmount = cap;
        uint256 amountInWithFee = amountIn - feeAmount;
        return (rOut * amountInWithFee) / (rIn + amountInWithFee);
    }
}
