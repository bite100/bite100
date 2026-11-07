// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TokenPool} from "@chainlink/contracts-ccip/contracts/pools/TokenPool.sol";
import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";

/// @notice Bit100 glue (round 19): link two official BurnMintTokenPools.
/// Same shape as the starter kit's Example06.run, except the rate limiter is
/// ENABLED at test scale instead of disabled: bucket capacity 100,000 tokens,
/// refill 1,000 tokens/second, both directions. Values recorded in the
/// round-19 doc.
contract Bit100ConfigureWTKAPool is Script {
    function run(address localPool, uint64 remoteChainSelector, address remoteToken, address remotePool) external {
        bytes[] memory remotePoolAddresses = new bytes[](1);
        remotePoolAddresses[0] = abi.encode(remotePool);

        RateLimiter.Config memory testScaleLimiter =
            RateLimiter.Config({isEnabled: true, capacity: 100_000 ether, rate: 1_000 ether});
        TokenPool.ChainUpdate[] memory chainUpdates = new TokenPool.ChainUpdate[](1);
        chainUpdates[0] = TokenPool.ChainUpdate({
            remoteChainSelector: remoteChainSelector,
            remotePoolAddresses: remotePoolAddresses,
            remoteTokenAddress: abi.encode(remoteToken),
            outboundRateLimiterConfig: testScaleLimiter,
            inboundRateLimiterConfig: testScaleLimiter
        });

        bool already = TokenPool(localPool).isSupportedChain(remoteChainSelector);
        uint64[] memory toRemove = already ? new uint64[](1) : new uint64[](0);
        if (already) toRemove[0] = remoteChainSelector;

        vm.startBroadcast();
        TokenPool(localPool).applyChainUpdates(toRemove, chainUpdates);
        vm.stopBroadcast();

        console2.log("[RESULT] Remote token:", abi.decode(TokenPool(localPool).getRemoteToken(remoteChainSelector), (address)));
        console2.log(
            "[RESULT] Remote pool:", abi.decode(TokenPool(localPool).getRemotePools(remoteChainSelector)[0], (address))
        );
    }
}
