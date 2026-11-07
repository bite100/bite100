// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ChainGuard.sol";
import { IMessageLibManager, SetConfigParam } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import { UlnConfig } from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";

interface IBridgeEndpoint {
    function endpoint() external view returns (address);
}

interface IEndpointConfigReader {
    function getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) external view returns (bytes memory);
}

/// @title ConfigureDvns —— 为 CrossChainBridge 的一条链间路径配置多 DVN（LayerZero V2 ULN）
/// @notice 硬前提（见 docs/bridge-abstraction.md §5）：任何对外开放的主网路径，
///         required DVN 必须 ≥2 家独立运营商（KelpDAO 事故教训：1-of-1 DVN 是单点）。
///         本脚本对「发送库 + 接收库」同时下发同一份 UlnConfig，两侧缺一不可：
///         源链 SendUln 决定要收集哪些 DVN 的签名，目标链 ReceiveUln 决定接受哪些签名。
///
///         环境变量：
///           PRIVATE_KEY   桥的 delegate（= owner）私钥，setConfig 只能由 delegate 调用
///           BRIDGE        本链 CrossChainBridge 地址
///           REMOTE_EID    对端 EID（本链视角的 dst/src EID，两侧同值）
///           DVN_1, DVN_2  必需 DVN 地址（本链部署，≥2 家独立运营商）
///           DVN_3         可选的第三家必需 DVN
///           CONFIRMATIONS 可选；不设则沿用当前生效配置的确认数
///           TARGET_CHAIN_ID 可选；设置后先校验链（ChainGuard）
///
///         用法（每条链各跑一次，REMOTE_EID 填对端）：
///           BRIDGE=0x... REMOTE_EID=40245 DVN_1=0x... DVN_2=0x... \
///             forge script script/ConfigureDvns.s.sol --rpc-url sepolia --broadcast
///         跑完务必用 endpoint.getConfig 读回发送/接收两侧并存档（见
///         docs/bridge-deployment-2026-11-07.md 的读回记录格式）。
/// @dev    2026-11-07 M2a 现状：Sepolia / Base Sepolia 测试网拿不到第二家可用的
///         DVN 部署（默认配置实测 1-of-1 LayerZero Labs），本脚本未在测试网执行；
///         它是主网上线前的必跑项，不是摆设——地址齐备时同一脚本直接可用。
contract ConfigureDvns is ChainGuard {
    uint32 internal constant CONFIG_TYPE_ULN = 2;

    function run() external {
        _assertTargetChain();
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address bridge = vm.envAddress("BRIDGE");
        uint32 remoteEid = uint32(vm.envUint("REMOTE_EID"));

        address[] memory dvns = new address[](3);
        uint256 n = 0;
        dvns[n++] = vm.envAddress("DVN_1");
        dvns[n++] = vm.envAddress("DVN_2");
        address third = vm.envOr("DVN_3", address(0));
        if (third != address(0)) dvns[n++] = third;
        require(n >= 2, "ConfigureDvns: need >= 2 DVNs");
        assembly {
            mstore(dvns, n)
        }
        _sortAscending(dvns);
        for (uint256 i = 1; i < n; i++) {
            require(dvns[i] != dvns[i - 1], "ConfigureDvns: duplicate DVN");
        }

        address endpoint = IBridgeEndpoint(bridge).endpoint();
        IMessageLibManager ep = IMessageLibManager(endpoint);

        address sendLib = ep.getSendLibrary(bridge, remoteEid);
        (address recvLib, ) = ep.getReceiveLibrary(bridge, remoteEid);

        // confirmations：未显式指定则沿用当前发送侧生效值，避免顺手改掉确认深度
        uint64 confirmations = uint64(vm.envOr("CONFIRMATIONS", uint256(0)));
        if (confirmations == 0) {
            bytes memory cur = IEndpointConfigReader(endpoint).getConfig(bridge, sendLib, remoteEid, CONFIG_TYPE_ULN);
            confirmations = abi.decode(cur, (UlnConfig)).confirmations;
        }

        UlnConfig memory uln = UlnConfig({
            confirmations: confirmations,
            requiredDVNCount: uint8(n),
            optionalDVNCount: 0,
            optionalDVNThreshold: 0,
            requiredDVNs: dvns,
            optionalDVNs: new address[](0)
        });
        SetConfigParam[] memory params = new SetConfigParam[](1);
        params[0] = SetConfigParam({ eid: remoteEid, configType: CONFIG_TYPE_ULN, config: abi.encode(uln) });

        vm.startBroadcast(pk);
        ep.setConfig(bridge, sendLib, params); // 发送侧：本链 -> REMOTE_EID
        ep.setConfig(bridge, recvLib, params); // 接收侧：REMOTE_EID -> 本链
        vm.stopBroadcast();

        console.log("Configured multi-DVN ULN for bridge:", bridge);
        console.log("Remote EID:", remoteEid);
        console.log("Required DVN count:", n);
        for (uint256 i = 0; i < n; i++) console.log("  requiredDVN:", dvns[i]);
        console.log("Confirmations:", confirmations);
    }

    function _sortAscending(address[] memory a) internal pure {
        for (uint256 i = 0; i < a.length; i++) {
            for (uint256 j = i + 1; j < a.length; j++) {
                if (a[j] < a[i]) (a[i], a[j]) = (a[j], a[i]);
            }
        }
    }
}
