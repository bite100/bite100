// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ChainGuard.sol";
import "../src/GasVault.sol";

/// @title 第 63 轮部署脚本：GasVault 形态 A（每链原生币主库）
/// @notice 本脚本随第 63 轮只交付代码，**执行属于部署步**（本轮不部署）。
///         形态 A：settlement 传零地址（creditRecovered 形状冻结、入口关闭；
///         形态 B 接线是主网门决策项）。参数只给水位公式的入参——targetFloat
///         按设计口径（近 30 天日均结算笔数 × 平均计量 gas 成本 × 7 天 × 1.5
///         安全系数）在部署时按当链实测填入 GASVAULT_TARGET_FLOAT；
///         警戒线比例合约出厂 40% 已定版，不在此重设。价源 GASVAULT_PRICE_SOURCE
///         只许填已准入的价格面地址（部署纪律，见轮次文档）。owner 出厂为
///         部署者（PRIVATE_KEY），过渡期移交多签+时锁、最终 renounce 的时序
///         是运维纪律，不在脚本内。
///         必需环境变量：PRIVATE_KEY、WRAPPED_NATIVE（所在链 WETH 地址）、
///         GASVAULT_TARGET_FLOAT、GASVAULT_PRICE_SOURCE、GASVAULT_CONVERSION_CAP、
///         GASVAULT_MIN_INTERVAL、GASVAULT_DUST_THRESHOLD。
///         可选：GASVAULT_ROUTERS（逗号分隔的聚合器路由白名单，部署时一并写入）。
///         仅测试网先行；按链分别跑（TARGET_CHAIN_ID 护栏）。
contract DeployGasVault is ChainGuard {
    function run() external {
        _assertTargetChain();
        address wrappedNative = vm.envAddress("WRAPPED_NATIVE");
        uint256 targetFloat = vm.envUint("GASVAULT_TARGET_FLOAT");
        address priceSource = vm.envAddress("GASVAULT_PRICE_SOURCE");
        uint256 cap = vm.envUint("GASVAULT_CONVERSION_CAP");
        uint256 minInterval = vm.envUint("GASVAULT_MIN_INTERVAL");
        uint256 dust = vm.envUint("GASVAULT_DUST_THRESHOLD");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);
        GasVault vault = new GasVault(
            IWrappedNative(wrappedNative),
            "Bit100 Gas Vault",
            "gvault",
            address(0), // 形态 A：Settlement 不接线
            deployer
        );
        vault.setTargetFloat(targetFloat);
        vault.setPriceSource(IGasPriceSource(priceSource));
        vault.setConversionLimits(cap, minInterval, dust);
        string memory routersCsv = vm.envOr("GASVAULT_ROUTERS", string(""));
        bytes memory csv = bytes(routersCsv);
        if (csv.length > 0) {
            // 简单逗号切分（部署期一次性输入，元素为地址字面量）
            uint256 start = 0;
            for (uint256 i = 0; i <= csv.length; i++) {
                if (i == csv.length || csv[i] == ",") {
                    bytes memory part = new bytes(i - start);
                    for (uint256 j = 0; j < part.length; j++) part[j] = csv[start + j];
                    address router = vm.parseAddress(string(part));
                    vault.setRouter(router, true);
                    start = i + 1;
                }
            }
        }
        vm.stopBroadcast();
        console.log("GasVault deployed:", address(vault));
        console.log("  asset (wrapped native):", wrappedNative);
        console.log("  targetFloat:", targetFloat);
        console.log("  lowWatermark (40%):", vault.lowWatermark());
    }
}
