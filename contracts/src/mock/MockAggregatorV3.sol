// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Chainlink AggregatorV3 最小 mock（仅测试用）：价格与更新时间可设，
/// 供 MakerVault 的喂价/过期逻辑测试；生产喂价一律用 Chainlink 官方 feed。
contract MockAggregatorV3 {
    uint8 public decimals;
    string public description;
    uint256 public version = 1;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;

    constructor(int256 _answer, uint8 _decimals) {
        answer = _answer;
        decimals = _decimals;
        description = "MockAggregatorV3";
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 _answer) external {
        answer = _answer;
    }

    function setUpdatedAt(uint256 _updatedAt) external {
        updatedAt = _updatedAt;
    }

    function setRoundData(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function getRoundData(uint80)
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
