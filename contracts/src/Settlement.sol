// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IERC20.sol";
import "./Vault.sol";
import "./FeeDistributor.sol";

/// @title Settlement 交易结算
/// @notice 根据链下撮合结果执行资产划转并收取手续费
contract Settlement {
    Vault public vault;
    FeeDistributor public feeDistributor;
    address public owner;

    uint16 public feeBps = 30; // 0.3% = 30 bps
    address public feeToken; // 手续费收取的代币（如 USDT）

    event TradeSettled(
        address indexed maker,
        address indexed taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount
    );
    event FeeBpsSet(uint16 oldBps, uint16 newBps);
    event FeeTokenSet(address indexed token);

    modifier onlyOwner() {
        require(msg.sender == owner, "Settlement: not owner");
        _;
    }

    constructor(address _vault, address _feeDistributor) {
        require(_vault != address(0) && _feeDistributor != address(0), "Settlement: zero address");
        vault = Vault(_vault);
        feeDistributor = FeeDistributor(_feeDistributor);
        owner = msg.sender;
    }

    /// @notice 设置手续费率（万分比）
    function setFeeBps(uint16 _feeBps) external onlyOwner {
        require(_feeBps <= 1000, "Settlement: fee too high"); // max 10%
        uint16 old = feeBps;
        feeBps = _feeBps;
        emit FeeBpsSet(old, _feeBps);
    }

    /// @notice 设置手续费收取代币
    function setFeeToken(address _feeToken) external onlyOwner {
        feeToken = _feeToken;
        emit FeeTokenSet(_feeToken);
    }

    /// @notice 结算一笔成交：maker 出 tokenIn 得 tokenOut，taker 出 tokenOut 得 tokenIn，手续费从 tokenOut 扣
    /// @param maker 挂单方
    /// @param taker 吃单方
    /// @param tokenIn maker 卖出的代币
    /// @param tokenOut maker 买入的代币（即 taker 卖出）
    /// @param amountIn maker 卖出数量
    /// @param amountOut maker 得到数量（taker 卖出数量）
    function settleTrade(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external onlyOwner {
        require(maker != address(0) && taker != address(0), "Settlement: zero address");
        require(tokenIn != address(0) && tokenOut != address(0), "Settlement: zero token");
        require(amountIn > 0 && amountOut > 0, "Settlement: zero amount");

        uint256 feeAmount = (amountOut * feeBps) / 10000;
        uint256 makerReceives = amountOut - feeAmount;

        // maker 转出 tokenIn 给 taker（托管账本内划转）
        vault.transferWithinVault(maker, taker, tokenIn, amountIn);
        // taker 转出 tokenOut 给 maker（托管账本内划转）
        vault.transferWithinVault(taker, maker, tokenOut, makerReceives);
        // 手续费：转出到本合约，再由 FeeDistributor.receiveFee 拉取并记账
        if (feeAmount > 0 && address(feeDistributor) != address(0)) {
            vault.transferOut(taker, address(this), tokenOut, feeAmount);
            require(IERC20(tokenOut).approve(address(feeDistributor), feeAmount), "Settlement: approve failed");
            feeDistributor.receiveFee(tokenOut, feeAmount);
        }
        emit TradeSettled(maker, taker, tokenIn, tokenOut, amountIn, amountOut, feeAmount);
    }
}
