// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {BurnMintTokenPool} from "@chainlink/contracts-ccip/contracts/pools/BurnMintTokenPool.sol";
import {ITokenAdminRegistry} from "@chainlink/contracts-ccip/contracts/interfaces/ITokenAdminRegistry.sol";
import {IBurnMintERC20} from "@chainlink/contracts-ccip/contracts/interfaces/IBurnMintERC20.sol";

interface IMintBurnRoleGranter2 {
    function grantMintAndBurnRoles(address burnAndMinter) external;
}

/// @notice Bit100 glue (round 19): redeploy variant for a token that is ALREADY
/// registered in the TokenAdminRegistry (Sepolia). Deploys a fresh official
/// BurnMintTokenPool (optimizer build, EIP-170-sized), grants roles, and points
/// the registry at the new pool via setPool. Registration steps are skipped
/// because registerAdminViaGetCCIPAdmin reverts for an already-registered token.
contract Bit100RedeployWTKAPool is Script {
    function run(address token, address tokenAdminRegistry, address rmnProxy, address router)
        external
        returns (address pool)
    {
        vm.startBroadcast();
        BurnMintTokenPool poolContract =
            new BurnMintTokenPool(IBurnMintERC20(token), 18, address(0), rmnProxy, router);
        IMintBurnRoleGranter2(token).grantMintAndBurnRoles(address(poolContract));
        ITokenAdminRegistry(tokenAdminRegistry).setPool(token, address(poolContract));
        vm.stopBroadcast();
        pool = address(poolContract);
        console2.log("[RESULT] New BurnMintTokenPool:", pool);
    }
}
