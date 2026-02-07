// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title TokenRegistry 可交易代币白名单
/// @notice 上币/下币由治理投票决定，仅 governance 可调用 addToken/removeToken
contract TokenRegistry {
    address public owner;
    address public governance;

    mapping(address => bool) public isListed;
    address[] public listedTokens;

    event TokenAdded(address indexed token);
    event TokenRemoved(address indexed token);
    event GovernanceSet(address indexed governance);

    modifier onlyOwner() {
        require(msg.sender == owner, "TokenRegistry: not owner");
        _;
    }

    modifier onlyGovernance() {
        require(msg.sender == governance && governance != address(0), "TokenRegistry: not governance");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setGovernance(address _governance) external onlyOwner {
        governance = _governance;
        emit GovernanceSet(_governance);
    }

    /// @notice 添加可交易代币（治理通过后调用）
    function addToken(address token) external onlyGovernance {
        require(token != address(0), "TokenRegistry: zero address");
        require(!isListed[token], "TokenRegistry: already listed");
        isListed[token] = true;
        listedTokens.push(token);
        emit TokenAdded(token);
    }

    /// @notice 移除可交易代币（治理通过后调用）
    function removeToken(address token) external onlyGovernance {
        require(isListed[token], "TokenRegistry: not listed");
        isListed[token] = false;
        for (uint256 i = 0; i < listedTokens.length; i++) {
            if (listedTokens[i] == token) {
                listedTokens[i] = listedTokens[listedTokens.length - 1];
                listedTokens.pop();
                break;
            }
        }
        emit TokenRemoved(token);
    }

    function listedCount() external view returns (uint256) {
        return listedTokens.length;
    }
}
