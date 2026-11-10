// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/Governance.sol";

/// @title 第 61 轮：治理活跃集快照发布（薄脚本，管理员操作面）
/// @notice 流程：离线贡献计量 CLI 产出成员清单 → 折成 Merkle 根与人数 →
///         管理员（Governance owner 私钥）运行本脚本发布快照 → 提案按编号引用。
///         发布交易本身即发布者对该清单的签认；快照只增不改。
/// 必需环境变量：
///   PRIVATE_KEY          Governance owner 私钥（现阶段 = 部署者；后续多签接管后改为多签发起）
///   GOVERNANCE_ADDRESS   Governance 合约地址
///   SNAPSHOT_MERKLE_ROOT 成员清单 Merkle 根（叶子 = keccak256(abi.encodePacked(地址))，与链下工具同口径）
///   SNAPSHOT_ACTIVE_COUNT 成员人数
contract PublishSnapshot is Script {
    function run() external {
        address govAddr = vm.envAddress("GOVERNANCE_ADDRESS");
        bytes32 root = vm.envBytes32("SNAPSHOT_MERKLE_ROOT");
        uint256 activeCount = vm.envUint("SNAPSHOT_ACTIVE_COUNT");
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        uint256 snapshotId = Governance(govAddr).publishSnapshot(root, activeCount);
        vm.stopBroadcast();

        console.log("Snapshot published, id:", snapshotId);
    }
}
