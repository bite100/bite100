// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";

/// @title ChainGuard 部署脚本的链参数化护栏（多链地基，2026-11-07 第七轮）
/// @notice 所有部署脚本继承本基类并在每个 run* 入口调用 _assertTargetChain()：
///         若设置了环境变量 TARGET_CHAIN_ID，则当前链（由 --rpc-url 决定）的
///         block.chainid 必须与之相等，否则直接 revert，防止把合约部署到错误的链。
///         未设置 TARGET_CHAIN_ID 时不做校验（保持此前各脚本的原有行为）。
/// @dev 目标链通过 `forge script --rpc-url <链>` 选择：foundry.toml 的 [rpc_endpoints]
///      已定义 sepolia / base_sepolia / arbitrum_sepolia / optimism_sepolia 别名
///      （RPC 地址由对应 *_RPC_URL 环境变量提供）。
abstract contract ChainGuard is Script {
    function _assertTargetChain() internal view {
        uint256 target = vm.envOr("TARGET_CHAIN_ID", uint256(0));
        if (target != 0) {
            require(
                block.chainid == target,
                string.concat(
                    "ChainGuard: chain mismatch, connected chainId=",
                    vm.toString(block.chainid),
                    " TARGET_CHAIN_ID=",
                    vm.toString(target)
                )
            );
        }
        console.log("Target chainId:", block.chainid);
    }
}
