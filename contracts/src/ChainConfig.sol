// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title ChainConfig 支持的流通链配置
/// @notice 添加/移除支持的链由治理投票决定，仅 governance 可调用 addChain/removeChain
contract ChainConfig {
    address public owner;
    address public governance;

    /// chainId => 是否支持
    mapping(uint256 => bool) public isSupported;
    uint256[] public supportedChainIds;

    event ChainAdded(uint256 indexed chainId);
    event ChainRemoved(uint256 indexed chainId);
    event GovernanceSet(address indexed governance);

    modifier onlyOwner() {
        require(msg.sender == owner, "ChainConfig: not owner");
        _;
    }

    modifier onlyGovernance() {
        require(msg.sender == governance && governance != address(0), "ChainConfig: not governance");
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
}
