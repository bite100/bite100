// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 测试用 ERC20，支持自铸造
contract MockERC20 is ERC20 {
    constructor(string memory _name, string memory _symbol, uint256 initialSupply) ERC20(_name, _symbol) {
        if (initialSupply > 0) {
            _mint(msg.sender, initialSupply);
        }
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
