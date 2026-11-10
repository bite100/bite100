// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {GasVault} from "../src/GasVault.sol";

/// @title 第 63 轮部署步实测辅助：计量人签名 + absorbShortfall 实付
/// @notice 计量人私钥只从环境变量 MEASURER_KEY 读（永不落盘/打印）；签名在
///         脚本内以 vm.sign 对 GasVault 的 EIP-712 摘要完成，随后以调用者
///         CALLER_KEY 广播 absorbShortfall。仅测试网实测用。
contract AbsorbShortfallHelper is Script {
    function run() external {
        GasVault vault = GasVault(payable(vm.envAddress("GASVAULT")));
        bytes32 claimId = vm.envBytes32("CLAIM_ID");
        address beneficiary = vm.envAddress("BENEFICIARY");
        uint256 amount = vm.envUint("AMOUNT");
        uint256 nonce = vm.envUint("NONCE");
        uint256 deadline = vm.envUint("DEADLINE");
        uint256 measurerPk = vm.envUint("MEASURER_KEY");
        uint256 callerPk = vm.envUint("CALLER_KEY");

        bytes32 digest = vault.shortfallAttestationDigest(claimId, beneficiary, amount, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(measurerPk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.startBroadcast(callerPk);
        vault.absorbShortfall(claimId, beneficiary, amount, nonce, deadline, signature);
        vm.stopBroadcast();
    }
}
