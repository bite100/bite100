// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/Vault.sol";
import "../src/Settlement.sol";
import "../src/mock/MockERC20.sol";

/// @title 第二十一轮双链 E2E（同一脚本两链各跑一遍）
/// MODE=1：铸币 → 双方存款 → 锁定 → 正常结算一笔（100 TKA ↔ 100 TKB，价 1:1）；
///         同时预锁一笔 900 秒后过期的 maker 订单（nonce 1），并把该订单的
///         timestamp / expiresAt 打到日志（EXP_TIMESTAMP / EXP_EXPIRES_AT）。
/// MODE=2：MODE=1 后 ≥100 秒、带 EXP_TIMESTAMP/EXP_EXPIRES_AT 原值运行——
///         以低层调用尝试结算过期订单（内层必因过期 revert），再调
///         chargeFailedSettlement(exp, FAIL_ORDER_EXPIRED=1, 500_000) 申报扣费。
/// 环境变量：PRIVATE_KEY（部署者=locker=结算提交者）、MAKER_KEY、TAKER_KEY、
///          VAULT_ADDRESS、SETTLEMENT_ADDRESS、TOKEN_A、TOKEN_B
contract E2EGasRules is Script {
    uint256 internal constant FAIL_GAS_CLAIMED = 500_000;

    function run() external {
        uint256 mode = vm.envUint("MODE");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 makerKey = vm.envUint("MAKER_KEY");
        uint256 takerKey = vm.envUint("TAKER_KEY");
        address maker = vm.addr(makerKey);
        address taker = vm.addr(takerKey);
        Vault vault = Vault(vm.envAddress("VAULT_ADDRESS"));
        Settlement settlement = Settlement(vm.envAddress("SETTLEMENT_ADDRESS"));
        MockERC20 tokenA = MockERC20(vm.envAddress("TOKEN_A"));
        MockERC20 tokenB = MockERC20(vm.envAddress("TOKEN_B"));

        if (mode == 1) {
            vm.startBroadcast(deployerKey);
            tokenA.mint(maker, 1000e18);
            tokenB.mint(taker, 1000e18);
            vm.stopBroadcast();

            vm.startBroadcast(makerKey);
            tokenA.approve(address(vault), type(uint256).max);
            vault.deposit(address(tokenA), 500e18);
            vm.stopBroadcast();

            vm.startBroadcast(takerKey);
            tokenB.approve(address(vault), type(uint256).max);
            vault.deposit(address(tokenB), 500e18);
            vm.stopBroadcast();

            uint256 ts = block.timestamp;
            Settlement.SignedOrder memory mo =
                _signed(makerKey, settlement, _order(maker, tokenA, tokenB, "e2e-m", 100e18, 100e18, ts, ts + 1 days, 0, 1));
            Settlement.SignedOrder memory to =
                _signed(takerKey, settlement, _order(taker, tokenA, tokenB, "e2e-t", 100e18, 100e18, ts, ts + 1 days, 0, 0));

            vm.startBroadcast(deployerKey);
            vault.lockForOrder(_v(mo.order), mo.signature);
            vault.lockForOrder(_v(to.order), to.signature);
            settlement.settleTrade(_fill(mo, to, 100e18, 100e18));
            // 失败案例预锁：maker 订单 900 秒后过期（nonce 1）。
            // 保险丝必须足够长：低 gas 价下锁定 tx 落链可能耗时数分钟（90 秒曾实测烧完导致 lock revert）
            Settlement.SignedOrder memory exp =
                _signed(makerKey, settlement, _order(maker, tokenA, tokenB, "e2e-m-exp", 100e18, 100e18, ts, ts + 900, 1, 1));
            vault.lockForOrder(_v(exp.order), exp.signature);
            vm.stopBroadcast();
            console.log("EXP_TIMESTAMP", ts);
            console.log("EXP_EXPIRES_AT", ts + 900);
            console.log("EXP_NONCE 1");
            console.log("MODE1 done");
        } else if (mode == 3) {
            // 补锁一笔新的待过期 maker 订单（MODE=1 的预锁若因落链太慢被烧断时使用）
            uint256 nonce = vm.envOr("EXP_NONCE", uint256(2));
            uint256 fuse = vm.envOr("EXP_FUSE", uint256(900));
            uint256 ts = block.timestamp;
            Settlement.SignedOrder memory exp =
                _signed(makerKey, settlement, _order(maker, tokenA, tokenB, "e2e-m-exp", 100e18, 100e18, ts, ts + fuse, nonce, 1));
            vm.startBroadcast(deployerKey);
            vault.lockForOrder(_v(exp.order), exp.signature);
            vm.stopBroadcast();
            console.log("EXP_TIMESTAMP", ts);
            console.log("EXP_EXPIRES_AT", ts + fuse);
            console.log("EXP_NONCE", nonce);
            console.log("MODE3 done");
        } else if (mode == 6) {
            // 只签名不广播：打印过期订单与对手订单的签名，供运行器用 cast send 发真实交易
            // （forge script 的 broadcast 模拟 EVM 中 tx.gasprice 恒为 0，依赖 gasprice 的
            // 扣费逻辑在模拟期必误判 revert——故扣费/结算尝试改走真实交易，见轮次文档）
            uint256 expTs = vm.envUint("EXP_TIMESTAMP");
            uint256 expAt = vm.envUint("EXP_EXPIRES_AT");
            uint256 expNonce = vm.envOr("EXP_NONCE", uint256(1));
            Settlement.SignedOrder memory exp =
                _signed(makerKey, settlement, _order(maker, tokenA, tokenB, "e2e-m-exp", 100e18, 100e18, expTs, expAt, expNonce, 1));
            Settlement.SignedOrder memory to = _signed(
                takerKey, settlement, _order(taker, tokenA, tokenB, "e2e-t2", 100e18, 100e18, expTs, expTs + 1 days, 1, 0)
            );
            console.log("EXP_SIG", vm.toString(exp.signature));
            console.log("TAKER_SIG", vm.toString(to.signature));
            console.log("MODE6 done");
        } else if (mode == 4 || mode == 5) {
            // MODE=2 的拆分版（单调用广播）：4 = 只做过期结算尝试；5 = 只做归责扣费申报
            vm.txGasPrice(3_000_000); // 同 MODE=2：模拟期 gas 价
            uint256 expTs = vm.envUint("EXP_TIMESTAMP");
            uint256 expAt = vm.envUint("EXP_EXPIRES_AT");
            uint256 expNonce = vm.envOr("EXP_NONCE", uint256(1));
            require(block.timestamp > expAt, "E2E: exp order not yet expired");
            Settlement.SignedOrder memory exp =
                _signed(makerKey, settlement, _order(maker, tokenA, tokenB, "e2e-m-exp", 100e18, 100e18, expTs, expAt, expNonce, 1));
            vm.startBroadcast(deployerKey);
            if (mode == 4) {
                Settlement.SignedOrder memory to = _signed(
                    takerKey, settlement, _order(taker, tokenA, tokenB, "e2e-t2", 100e18, 100e18, expTs, expTs + 1 days, 1, 0)
                );
                (bool ok,) = address(settlement).call(
                    abi.encodeWithSelector(Settlement.settleTrade.selector, _fill(exp, to, 100e18, 100e18))
                );
                console.log("expired settle attempt succeeded (expect false):", ok);
                require(!ok, "E2E: expired settle should have reverted");
            } else {
                settlement.chargeFailedSettlement(exp, 1, FAIL_GAS_CLAIMED);
            }
            vm.stopBroadcast();
            console.log("MODE done:", mode);
        } else if (mode == 2) {
            // forge script 本地模拟的 tx.gasprice 默认为 0，会让扣费金额在模拟期算成 0 而误判 revert；
            // 显式设定模拟 gas 价（链上真实执行仍用交易自身的 gasprice，不受此影响）
            vm.txGasPrice(3_000_000);
            uint256 expTs = vm.envUint("EXP_TIMESTAMP");
            uint256 expAt = vm.envUint("EXP_EXPIRES_AT");
            uint256 expNonce = vm.envOr("EXP_NONCE", uint256(1));
            require(block.timestamp > expAt, "E2E: exp order not yet expired");
            // 与预锁时逐字段相同的订单（同 digest、同墓碑）
            Settlement.SignedOrder memory exp =
                _signed(makerKey, settlement, _order(maker, tokenA, tokenB, "e2e-m-exp", 100e18, 100e18, expTs, expAt, expNonce, 1));
            Settlement.SignedOrder memory to = _signed(
                takerKey, settlement, _order(taker, tokenA, tokenB, "e2e-t2", 100e18, 100e18, expTs, expTs + 1 days, 1, 0)
            );
            vm.startBroadcast(deployerKey);
            // 低层调用尝试结算：内层必因订单过期 revert；外层 tx 成功落链。
            // （真实场景中这是一笔独立 revert 的交易，节点从其回执取 gasUsed 申报；
            //  本 E2E 申报值取固定 500_000，核对重点是归责与逐 wei 扣费公式。）
            (bool ok,) = address(settlement).call(
                abi.encodeWithSelector(Settlement.settleTrade.selector, _fill(exp, to, 100e18, 100e18))
            );
            console.log("expired settle attempt succeeded (expect false):", ok);
            require(!ok, "E2E: expired settle should have reverted");
            settlement.chargeFailedSettlement(exp, 1, FAIL_GAS_CLAIMED);
            vm.stopBroadcast();
            console.log("MODE2 done");
        } else {
            revert("E2E: MODE must be 1 or 2");
        }
    }

    function _order(
        address user,
        MockERC20 tokenA,
        MockERC20 tokenB,
        string memory orderId,
        uint256 amountIn,
        uint256 amountOut,
        uint256 timestamp,
        uint256 expiresAt,
        uint256 nonce,
        uint8 side
    ) internal pure returns (Settlement.Order memory) {
        return Settlement.Order({
            orderId: orderId,
            userAddress: user,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: amountIn,
            amountOut: amountOut,
            price: (amountOut * 1e18) / amountIn,
            timestamp: timestamp,
            expiresAt: expiresAt,
            nonce: nonce,
            side: side
        });
    }

    function _signed(uint256 key, Settlement settlement, Settlement.Order memory o)
        internal
        view
        returns (Settlement.SignedOrder memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.orderDigest(o));
        return Settlement.SignedOrder({order: o, signature: abi.encodePacked(r, s, v)});
    }

    function _fill(Settlement.SignedOrder memory mo, Settlement.SignedOrder memory to, uint256 inAmt, uint256 outAmt)
        internal
        pure
        returns (Settlement.Fill memory)
    {
        return Settlement.Fill({
            makerOrder: mo,
            takerOrder: to,
            tokenIn: mo.order.tokenIn,
            tokenOut: mo.order.tokenOut,
            amountIn: inAmt,
            amountOut: outAmt,
            gasReimburseIn: 0,
            gasReimburseOut: 0
        });
    }

    function _v(Settlement.Order memory o) internal pure returns (VaultOrder memory) {
        return VaultOrder({
            orderId: o.orderId, userAddress: o.userAddress, tokenIn: o.tokenIn, tokenOut: o.tokenOut,
            amountIn: o.amountIn, amountOut: o.amountOut, price: o.price, timestamp: o.timestamp,
            expiresAt: o.expiresAt, nonce: o.nonce, side: o.side
        });
    }
}
