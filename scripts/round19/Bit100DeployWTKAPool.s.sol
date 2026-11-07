// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {BurnMintTokenPool} from "@chainlink/contracts-ccip/contracts/pools/BurnMintTokenPool.sol";
import {ITokenAdminRegistry} from "@chainlink/contracts-ccip/contracts/interfaces/ITokenAdminRegistry.sol";
import {IBurnMintERC20} from "@chainlink/contracts-ccip/contracts/interfaces/IBurnMintERC20.sol";
import {
    RegistryModuleOwnerCustom
} from "@chainlink/contracts-ccip/contracts/tokenAdminRegistry/RegistryModuleOwnerCustom.sol";

/// @notice Bit100 glue (round 19): deploy the OFFICIAL BurnMintTokenPool for the
/// pre-deployed WrappedTKA, grant it mint/burn roles, and run the official
/// self-serve registration flow (registerAdminViaGetCCIPAdmin -> acceptAdminRole
/// -> setPool). Adapted from the starter kit's Example06, which deploys its own
/// token; here the token already exists, so only the pool + registration steps run.
interface IMintBurnRoleGranter {
    function grantMintAndBurnRoles(address burnAndMinter) external;
}

contract Bit100DeployWTKAPool is Script {
    function run(
        address token,
        address tokenAdminRegistry,
        address registryModuleOwnerCustom,
        address rmnProxy,
        address router
    ) external returns (address pool) {
        require(token != address(0), "token zero");
        vm.startBroadcast();
        BurnMintTokenPool poolContract = new BurnMintTokenPool(
            IBurnMintERC20(token),
            18,
            address(0), // no advanced pool hook
            rmnProxy,
            router
        );
        IMintBurnRoleGranter(token).grantMintAndBurnRoles(address(poolContract));
        RegistryModuleOwnerCustom(registryModuleOwnerCustom).registerAdminViaGetCCIPAdmin(token);
        ITokenAdminRegistry(tokenAdminRegistry).acceptAdminRole(token);
        ITokenAdminRegistry(tokenAdminRegistry).setPool(token, address(poolContract));
        vm.stopBroadcast();
        pool = address(poolContract);
        console2.log("[RESULT] BurnMintTokenPool:", pool);
        console2.log("[RESULT] Registered + setPool for token:", token);
    }
}
