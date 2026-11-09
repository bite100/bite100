// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 第 60 轮 E2E 专用测试代币：小数位可参数化（验证任意 decimals 的
/// 自助上架全路径），公开 mint 与仓库 contracts/src/mock/MockERC20 同口径。
/// 只用于测试网 E2E，不进 contracts/src、不参与任何正式部署。
contract MockERC20Dec is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
