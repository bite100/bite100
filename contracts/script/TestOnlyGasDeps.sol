// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IGasPriceSource, IWrappedNative} from "../src/GasVault.sol";

/// @title TEST-ONLY 测试网专用价格源 —— 禁止用于主网
/// @notice 第 63 轮部署步专用：测试网没有已准入的价格面（Chainlink 为美元计价、
///         DexScreener 不索引测试网），故部署本人工设价实现，只为在测试网跑通
///         GasVault 换汇全流程。价格由部署者手工 setPrice（带 priceUpdatedAt
///         时效面，与 GasVault.maxPriceAge 把关配套）。名字与本注记即诚实标注：
///         它不是预言机、不聚合任何市场数据，主网必须换成已准入价格面。
contract TestOnlyPriceSource is IGasPriceSource {
    address public immutable owner;
    mapping(address => uint256) public prices;
    mapping(address => uint256) public updatedAts;

    constructor() {
        owner = msg.sender;
    }

    function setPrice(address token, uint256 priceE18) external {
        require(msg.sender == owner, "TestOnlyPriceSource: not owner");
        prices[token] = priceE18;
        updatedAts[token] = block.timestamp;
    }

    function setUpdatedAt(address token, uint256 ts) external {
        require(msg.sender == owner, "TestOnlyPriceSource: not owner");
        updatedAts[token] = ts;
    }

    function referencePrice(address token) external view override returns (uint256) {
        return prices[token];
    }

    function priceUpdatedAt(address token) external view override returns (uint256) {
        return updatedAts[token];
    }
}

/// @title TEST-ONLY 测试网专用换汇路由 —— 禁止用于主网
/// @notice 复刻聚合器路由的资金形状（transferFrom 拉输入币 + 按设定费率付回
///         包装原生币给调用者），费率由部署者设定，使熔断两侧都可在测试网
///         复现。真实链路是 LI.FI/1inch 的 calldata；本替身只服务测试网实测。
contract TestOnlySwapRouter {
    IWrappedNative public immutable asset;
    uint256 public outPerInE18; // 每 1e18 输入换得的资产（wei）

    constructor(IWrappedNative _asset, uint256 _outPerInE18) {
        asset = _asset;
        outPerInE18 = _outPerInE18;
    }

    function setRate(uint256 _outPerInE18) external {
        outPerInE18 = _outPerInE18;
    }

    function swap(address tokenIn, uint256 amountIn) external returns (uint256 out) {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        out = (amountIn * outPerInE18) / 1e18;
        asset.transfer(msg.sender, out);
    }
}
