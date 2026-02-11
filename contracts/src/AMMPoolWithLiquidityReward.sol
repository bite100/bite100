// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./FeeDistributor.sol";
import "./ContributorReward.sol";

/// @title AMMPoolWithLiquidityReward 支持流动性贡献分的 AMM 池
/// @notice 扩展 AMMPool，记录流动性提供者并自动更新贡献分
contract AMMPoolWithLiquidityReward {
    address public token0;
    address public token1;
    address public feeDistributor;
    address public contributorReward;
    address public owner;
    address public governance;

    uint16 public feeBps = 1; // 0.01%
    mapping(address => uint256) public feeCapPerToken;

    /// @notice 流动性提供者信息
    struct LiquidityProvider {
        uint256 totalLiquidity0;     // 累计注入的 Token0 数量
        uint256 totalLiquidity1;     // 累计注入的 Token1 数量
        uint256 currentLiquidity0;   // 当前持有的 Token0 数量
        uint256 currentLiquidity1;   // 当前持有的 Token1 数量
        uint256 lastUpdateTime;      // 最后更新时间
    }

    /// @notice 流动性提供者记录
    mapping(address => LiquidityProvider) public liquidityProviders;

    /// @notice 流动性贡献分上限（以稳定币计价，如 USDC）
    uint256 public constant CAP_LIQUIDITY = 100000e18; // 100,000 USDC

    /// @notice 最小流动性注入量（以稳定币计价）
    uint256 public minLiquidityAmount = 100e18; // 100 USDC

    /// @notice 流动性锁定时间（秒）
    uint256 public lockPeriod = 7 days;

    event AddLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event RemoveLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swap(address indexed sender, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut, uint256 fee);
    event FeeCapSet(address indexed token, uint256 cap);
    event GovernanceSet(address indexed governance);
    event LiquidityScoreUpdated(address indexed provider, uint256 score);
    event ContributorRewardSet(address indexed contributorReward);

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

    function setContributorReward(address _contributorReward) external onlyOwner {
        contributorReward = _contributorReward;
        emit ContributorRewardSet(_contributorReward);
    }

    function setGovernance(address _governance) external onlyOwner {
        governance = _governance;
        emit GovernanceSet(_governance);
    }

    function setFeeBps(uint16 _feeBps) external onlyOwnerOrGovernance {
        require(_feeBps <= 1000, "AMMPool: fee too high");
        feeBps = _feeBps;
    }

    function setFeeCap(address token, uint256 cap) external onlyOwnerOrGovernance {
        feeCapPerToken[token] = cap;
        emit FeeCapSet(token, cap);
    }

    function setMinLiquidityAmount(uint256 _minAmount) external onlyOwnerOrGovernance {
        minLiquidityAmount = _minAmount;
    }

    function setLockPeriod(uint256 _lockPeriod) external onlyOwnerOrGovernance {
        lockPeriod = _lockPeriod;
    }

    function reserve0() public view returns (uint256) {
        return IERC20(token0).balanceOf(address(this));
    }

    function reserve1() public view returns (uint256) {
        return IERC20(token1).balanceOf(address(this));
    }

    /// @notice 计算流动性数量（以稳定币计价，简化：使用 Token0 数量）
    function _calculateLiquidityAmount(uint256 amount0, uint256 amount1) internal pure returns (uint256) {
        // 简化处理：使用 amount0 作为流动性数量
        // 实际应用中可以根据价格计算等值稳定币数量
        return amount0;
    }

    /// @notice 计算流动性贡献分
    function _calculateLiquidityScore(uint256 liquidityAmount) internal pure returns (uint256) {
        if (liquidityAmount == 0) return 0;
        uint256 liquidityPart = liquidityAmount * 1e18 / CAP_LIQUIDITY;
        if (liquidityPart > 1e18) liquidityPart = 1e18;
        // 权重 20%，基础分 1e18
        return (1e18 + liquidityPart) * 20 / 100;
    }

    /// @notice 更新流动性贡献分
    function _updateLiquidityScore(address provider, uint256 liquidityAmount) internal {
        if (contributorReward == address(0)) return;
        
        uint256 score = _calculateLiquidityScore(liquidityAmount);
        
        // 获取当前周期（简化：使用周数）
        string memory period = _getCurrentPeriod();
        
        // 更新贡献分（需要 ContributorReward 合约支持）
        // 这里简化处理，实际需要调用 ContributorReward.setContributionScore
        // 或通过事件通知链下系统更新
        
        emit LiquidityScoreUpdated(provider, score);
    }

    /// @notice 获取当前周期（简化实现）
    function _getCurrentPeriod() internal view returns (string memory) {
        // 简化：返回周数，实际应使用 UTC 自然周
        uint256 weekNumber = block.timestamp / 1 weeks;
        return _uint2str(weekNumber);
    }

    /// @notice uint256 转 string（简化实现）
    function _uint2str(uint256 _i) internal pure returns (string memory) {
        if (_i == 0) return "0";
        uint256 j = _i;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint256 k = len;
        while (_i != 0) {
            k = k-1;
            uint8 temp = (48 + uint8(_i - _i / 10 * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }

    /// @notice 添加流动性（扩展版：记录流动性提供者）
    function addLiquidity(uint256 amount0, uint256 amount1) external {
        require(amount0 > 0 && amount1 > 0, "AMMPool: zero amount");
        
        // 计算流动性数量
        uint256 liquidityAmount = _calculateLiquidityAmount(amount0, amount1);
        require(liquidityAmount >= minLiquidityAmount, "AMMPool: liquidity too low");
        
        require(IERC20(token0).transferFrom(msg.sender, address(this), amount0), "AMMPool: transfer0 failed");
        require(IERC20(token1).transferFrom(msg.sender, address(this), amount1), "AMMPool: transfer1 failed");
        
        // 更新流动性提供者记录
        LiquidityProvider storage provider = liquidityProviders[msg.sender];
        provider.totalLiquidity0 += amount0;
        provider.totalLiquidity1 += amount1;
        provider.currentLiquidity0 += amount0;
        provider.currentLiquidity1 += amount1;
        provider.lastUpdateTime = block.timestamp;
        
        // 更新贡献分
        _updateLiquidityScore(msg.sender, liquidityAmount);
        
        emit AddLiquidity(msg.sender, amount0, amount1, amount0 + amount1);
    }

    /// @notice 移除流动性（扩展版：更新流动性记录）
    function removeLiquidity(uint256 amount0, uint256 amount1) external {
        LiquidityProvider storage provider = liquidityProviders[msg.sender];
        require(amount0 <= provider.currentLiquidity0 && amount1 <= provider.currentLiquidity1, "AMMPool: insufficient liquidity");
        
        // 检查锁定时间
        require(block.timestamp >= provider.lastUpdateTime + lockPeriod, "AMMPool: liquidity locked");
        
        uint256 r0 = reserve0();
        uint256 r1 = reserve1();
        require(amount0 <= r0 && amount1 <= r1, "AMMPool: insufficient reserve");
        
        if (amount0 > 0) require(IERC20(token0).transfer(msg.sender, amount0), "AMMPool: transfer0 failed");
        if (amount1 > 0) require(IERC20(token1).transfer(msg.sender, amount1), "AMMPool: transfer1 failed");
        
        // 更新流动性记录
        provider.currentLiquidity0 -= amount0;
        provider.currentLiquidity1 -= amount1;
        provider.lastUpdateTime = block.timestamp;
        
        // 更新贡献分
        uint256 remainingLiquidity = _calculateLiquidityAmount(provider.currentLiquidity0, provider.currentLiquidity1);
        _updateLiquidityScore(msg.sender, remainingLiquidity);
        
        emit RemoveLiquidity(msg.sender, amount0, amount1, amount0 + amount1);
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

    /// @notice 查询流动性提供者的流动性数量
    function getLiquidityAmount(address provider) public view returns (uint256) {
        LiquidityProvider memory p = liquidityProviders[provider];
        return _calculateLiquidityAmount(p.currentLiquidity0, p.currentLiquidity1);
    }

    /// @notice 查询流动性贡献分
    function getLiquidityScore(address provider) external view returns (uint256) {
        uint256 liquidityAmount = getLiquidityAmount(provider);
        return _calculateLiquidityScore(liquidityAmount);
    }
}
