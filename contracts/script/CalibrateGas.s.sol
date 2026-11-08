// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/FeeDistributor.sol";
import "../src/ChainConfig.sol";
import "../src/mock/MockERC20.sol";

/// @notice 本地 anvil 校准脚本（不部署到任何真实网络）：部署全栈 → 锁定 → 结算一笔，
/// 事后用 cast 对比 GasCostShared 事件的计量 gasUsed 与交易回执的真实 gasUsed，校准 GAS_CHARGE_OVERHEAD。
/// 运行：PRIVATE_KEY=<anvil 账户0> MAKER_KEY=<anvil 账户1> TAKER_KEY=<anvil 账户2> forge script script/CalibrateGas.s.sol --rpc-url http://127.0.0.1:8546 --broadcast
contract CalibrateGas is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 makerKey = vm.envUint("MAKER_KEY");
        uint256 takerKey = vm.envUint("TAKER_KEY");
        address maker = vm.addr(makerKey);
        address taker = vm.addr(takerKey);

        vm.startBroadcast(deployerKey);
        MockERC20 tokenA = new MockERC20("TokenA", "TKA", 1_000_000e18);
        MockERC20 tokenB = new MockERC20("TokenB", "TKB", 1_000_000e18);
        Vault vault = new Vault();
        FeeDistributor fd = new FeeDistributor();
        Settlement settlement = new Settlement(address(vault), address(fd));
        vault.setSettlement(address(settlement));
        vault.setLocker(vm.addr(deployerKey), true);
        ChainConfig cc = new ChainConfig();
        cc.setQuotePricing(address(tokenB), 2000e18);
        settlement.setChainConfig(address(cc));
        tokenA.transfer(maker, 1000e18);
        tokenB.transfer(taker, 1000e18);
        vm.stopBroadcast();

        vm.startBroadcast(makerKey);
        tokenA.approve(address(vault), type(uint256).max);
        vault.deposit(address(tokenA), 500e18);
        vm.stopBroadcast();
        vm.startBroadcast(takerKey);
        tokenB.approve(address(vault), type(uint256).max);
        vault.deposit(address(tokenB), 500e18);
        vm.stopBroadcast();

        Settlement.Order memory mo = Settlement.Order({
            orderId: "cal-m", userAddress: maker, tokenIn: address(tokenA), tokenOut: address(tokenB),
            amountIn: 100e18, amountOut: 100e18, price: 1e18, timestamp: block.timestamp,
            expiresAt: block.timestamp + 1 days, nonce: 0, side: 1
        });
        Settlement.Order memory to = Settlement.Order({
            orderId: "cal-t", userAddress: taker, tokenIn: address(tokenA), tokenOut: address(tokenB),
            amountIn: 100e18, amountOut: 100e18, price: 1e18, timestamp: block.timestamp,
            expiresAt: block.timestamp + 1 days, nonce: 0, side: 0
        });
        bytes memory mSig = _sign(makerKey, settlement, mo);
        bytes memory tSig = _sign(takerKey, settlement, to);

        // FILL 环境变量控制成交量：100 = 全量（锁记录被删除，产生 SSTORE 退款）；50 = 部分（无删除）
        uint256 fillAmt = vm.envOr("FILL", uint256(100e18));
        vm.startBroadcast(deployerKey);
        vault.lockForOrder(_v(mo), mSig);
        vault.lockForOrder(_v(to), tSig);
        Settlement.Fill memory fill = Settlement.Fill({
            makerOrder: Settlement.SignedOrder({order: mo, signature: mSig}),
            takerOrder: Settlement.SignedOrder({order: to, signature: tSig}),
            tokenIn: address(tokenA), tokenOut: address(tokenB),
            amountIn: fillAmt, amountOut: fillAmt, gasReimburseIn: 0, gasReimburseOut: 0
        });
        settlement.settleTrade(fill);
        vm.stopBroadcast();

        console.log("SETTLEMENT", address(settlement));
    }

    function _sign(uint256 key, Settlement settlement, Settlement.Order memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.orderDigest(o));
        return abi.encodePacked(r, s, v);
    }

    function _v(Settlement.Order memory o) internal pure returns (VaultOrder memory) {
        return VaultOrder({
            orderId: o.orderId, userAddress: o.userAddress, tokenIn: o.tokenIn, tokenOut: o.tokenOut,
            amountIn: o.amountIn, amountOut: o.amountOut, price: o.price, timestamp: o.timestamp,
            expiresAt: o.expiresAt, nonce: o.nonce, side: o.side
        });
    }
}
