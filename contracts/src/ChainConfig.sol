// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title ChainConfig 支持的流通链配置
/// @notice 添加/移除支持的链由治理投票决定，仅 governance 可调用 addChain/removeChain；
/// 另存 gas 分摊换算用的参考价（第二十一轮）：本链计价资产（quote）与 1 ETH 的 quote 参考价，
/// 供 Settlement 把结算 gas 成本换算为用户收到资产扣除。主网的价格来源（预言机）是主网门禁，本轮仅存可治理更新的参考值。
contract ChainConfig {
    address public owner;
    address public governance;

    /// chainId => 是否支持
    mapping(uint256 => bool) public isSupported;
    uint256[] public supportedChainIds;

    /// @notice 本链计价资产（quote token）地址；gas 换算的锚。0 表示未配置（结算不扣 gas 分摊）
    address public quoteToken;
    /// @notice 1 ETH 可兑换的 quote 数量（quote 最小单位整数，如 18 位代币下 2000e18 = 1 ETH 兑 2000 quote）
    uint256 public ethPriceInQuote;

    event ChainAdded(uint256 indexed chainId);
    event ChainRemoved(uint256 indexed chainId);
    event GovernanceSet(address indexed governance);
    event QuotePricingSet(address indexed quoteToken, uint256 ethPriceInQuote);

    modifier onlyOwner() {
        require(msg.sender == owner, "ChainConfig: not owner");
        _;
    }

    modifier onlyGovernance() {
        require(msg.sender == governance && governance != address(0), "ChainConfig: not governance");
        _;
    }

    modifier onlyOwnerOrGovernance() {
        require(
            msg.sender == owner || (governance != address(0) && msg.sender == governance),
            "ChainConfig: not auth"
        );
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setGovernance(address _governance) external onlyOwner {
        governance = _governance;
        emit GovernanceSet(_governance);
    }

    /// @notice 添加支持的链（治理通过后调用）
    function addChain(uint256 chainId) external onlyGovernance {
        require(chainId != 0, "ChainConfig: zero chainId");
        require(!isSupported[chainId], "ChainConfig: already supported");
        isSupported[chainId] = true;
        supportedChainIds.push(chainId);
        emit ChainAdded(chainId);
    }

    /// @notice 移除支持的链（治理通过后调用）
    function removeChain(uint256 chainId) external onlyGovernance {
        require(isSupported[chainId], "ChainConfig: not supported");
        isSupported[chainId] = false;
        for (uint256 i = 0; i < supportedChainIds.length; i++) {
            if (supportedChainIds[i] == chainId) {
                supportedChainIds[i] = supportedChainIds[supportedChainIds.length - 1];
                supportedChainIds.pop();
                break;
            }
        }
        emit ChainRemoved(chainId);
    }

    function supportedCount() external view returns (uint256) {
        return supportedChainIds.length;
    }

    /// @notice 设置 gas 换算参考价：计价资产与 1 ETH 的 quote 参考价；owner 或 governance 可更新。
    /// 参考价只用于把结算 gas 成本换算成用户资产扣除额（见 Settlement 的 gas 对半回收），
    /// 不参与订单定价。设 ethPriceInQuote 为 0 即关闭换算（结算不扣 gas 分摊）。
    function setQuotePricing(address _quoteToken, uint256 _ethPriceInQuote) external onlyOwnerOrGovernance {
        require(_quoteToken != address(0), "ChainConfig: zero token");
        quoteToken = _quoteToken;
        ethPriceInQuote = _ethPriceInQuote;
        emit QuotePricingSet(_quoteToken, _ethPriceInQuote);
    }
}
