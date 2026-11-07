// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title WrappedTKA — TKA 的 1:1 包装代币（第十九轮胶水合约）
/// @notice 为什么需要它（集成优先原则下的最薄胶水）：现行 TKA（MockERC20）无法直连
///         另外两座桥的官方组件——
///         1) Chainlink CCIP 的免许可注册要求代币暴露 owner() / getCCIPAdmin() /
///            AccessControl 默认管理员三者之一（Token Issuer Guide 原文），TKA 三者
///            皆无，无法自注册，只能走 Chainlink 人工协助注册；
///         2) Wormhole NTT 的 burning 模式要求代币支持 burn()（NttManager 源码
///            直接调 ERC20Burnable.burn），TKA 没有 burn；且 NTT 官方明确不支持
///            lock-and-lock 双锁模式。
///         本合约用 OpenZeppelin 标准件补齐这两个官方接口，1:1 锚定 TKA：
///         wrap 存入 TKA 铸 wTKA，unwrap 销毁 wTKA 赎回 TKA；桥组件（CCIP 池 /
///         NTT Manager）凭 MINTER_ROLE 在对端销毁/锁定后铸造，赎回时由持有者
///         unwrap 回原生 TKA。LayerZero 通道不经本合约，仍直连原生 TKA。
contract WrappedTKA is ERC20, ERC20Burnable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice 本链原生 TKA 地址（不可变，部署时按链注入）
    IERC20 public immutable underlying;

    address private immutable _ccipAdmin;

    event Wrapped(address indexed user, uint256 amount);
    event Unwrapped(address indexed user, uint256 amount);

    /// @param underlyingToken 本链 TKA 地址
    /// @param admin DEFAULT_ADMIN_ROLE 持有者，同时作为 CCIP 管理员登记地址
    constructor(address underlyingToken, address admin)
        ERC20("Wrapped TKA", "wTKA")
    {
        require(underlyingToken != address(0), "underlying zero");
        require(admin != address(0), "admin zero");
        underlying = IERC20(underlyingToken);
        _ccipAdmin = admin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Chainlink CCIP 免许可管理员注册钩子（官方三种模式之一）
    function getCCIPAdmin() external view returns (address) {
        return _ccipAdmin;
    }

    /// @notice 存入 TKA，1:1 铸造 wTKA
    function wrap(uint256 amount) external {
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
        emit Wrapped(msg.sender, amount);
    }

    /// @notice 销毁 wTKA，1:1 赎回 TKA（储备不足时转账自然 revert，供应恒有足额锚定）
    function unwrap(uint256 amount) external {
        _burn(msg.sender, amount);
        underlying.safeTransfer(msg.sender, amount);
        emit Unwrapped(msg.sender, amount);
    }

    /// @notice 仅桥组件（CCIP 代币池 / Wormhole NTT Manager）：在对端销毁/锁定后铸造
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Chainlink IBurnMintERC20 兼容：给池子授予铸/烧权限。
    ///         burn 是 ERC20Burnable 的公开 burn（烧调用者自身余额），无需角色；
    ///         这里实际授予的是 MINTER_ROLE。
    function grantMintAndBurnRoles(address burnAndMinter)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _grantRole(MINTER_ROLE, burnAndMinter);
    }

    /// @notice Chainlink IBurnMintERC20 兼容：回收铸/烧权限
    function revokeMintAndBurnRoles(address burnAndMinter)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _revokeRole(MINTER_ROLE, burnAndMinter);
    }

    /// @notice 本合约持有的 TKA 储备（应恒 >= wTKA 流通量中由 wrap 产生的部分 +
    ///         桥组件铸出待赎回部分；由 1:1 铸赎规则保证可全额赎回）
    function reserve() external view returns (uint256) {
        return underlying.balanceOf(address(this));
    }
}
