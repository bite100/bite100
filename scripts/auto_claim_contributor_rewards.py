#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
贡献分自动领取脚本（离线/后台运行）

用途：
- 周期性遍历一批贡献者地址，调用 ContributorReward.claimReward(period, token)
- 可由 cron / 定时任务触发，相当于“自动代为点领取按钮”

安全提示：
- 脚本使用本地私钥签名交易，仅适合由你信任的钱包代为领取到**同一个钱包地址**。
- 如果希望“直接打到每个用户的钱包”，应改为 Governance/多签批量分发方案，而不是在这里持有用户私钥。
"""
from __future__ import annotations

import os
import sys
import time
from typing import List

from web3 import Web3
from web3.middleware import geth_poa_middleware


RPC_URL = os.environ.get("RPC_URL", "https://ethereum-sepolia.publicnode.com")
PRIVATE_KEY = os.environ.get("AUTO_CLAIM_PRIVATE_KEY")  # 用于执行自动领取的钱包私钥
CONTRACT_ADDR = os.environ.get("CONTRIBUTOR_REWARD_ADDRESS")
TOKEN_ADDR = os.environ.get("REWARD_TOKEN_ADDRESS")  # 本周期对应的奖励代币地址（TKA/TKB 等）
PERIOD = os.environ.get("PERIOD", "2026-01")  # 当前发放周期字符串，需与链上保持一致

# 需要自动领取的地址列表：可从 snapshot、数据库、手动 CSV 等导入
ADDRESSES: List[str] = [
    # "0x1234...",
]


ABI = [
    {
        "inputs": [
            {"internalType": "string", "name": "period", "type": "string"},
            {"internalType": "address", "name": "token", "type": "address"},
        ],
        "name": "claimReward",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "string", "name": "period", "type": "string"},
            {"internalType": "address", "name": "token", "type": "address"},
            {"internalType": "address", "name": "account", "type": "address"},
        ],
        "name": "claimable",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
]


def main() -> None:
    if not PRIVATE_KEY or not CONTRACT_ADDR or not TOKEN_ADDR:
        print("请设置环境变量：AUTO_CLAIM_PRIVATE_KEY、CONTRIBUTOR_REWARD_ADDRESS、REWARD_TOKEN_ADDRESS", file=sys.stderr)
        sys.exit(1)

    if not ADDRESSES:
        print("ADDRESSES 列表为空，请在脚本中配置需要自动领取的地址。", file=sys.stderr)
        sys.exit(1)

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    # Sepolia / 部分侧链需要 POA middleware
    w3.middleware_onion.inject(geth_poa_middleware, layer=0)

    acct = w3.eth.account.from_key(PRIVATE_KEY)
    contract = w3.eth.contract(address=Web3.to_checksum_address(CONTRACT_ADDR), abi=ABI)

    print(f"使用钱包 {acct.address} 触发自动领取，周期={PERIOD}")

    for addr in ADDRESSES:
        addr = addr.strip()
        if not addr:
            continue
        try:
            claimable = contract.functions.claimable(PERIOD, Web3.to_checksum_address(TOKEN_ADDR), Web3.to_checksum_address(addr)).call()
        except Exception as e:  # pylint: disable=broad-except
            print(f"[skip] 查询 claimable 失败 {addr}: {e}")
            continue

        if claimable == 0:
            print(f"[skip] {addr} 本周期无可领奖励")
            continue

        print(f"[claim] 为 {addr} 触发领取，claimable={claimable}")

        try:
            nonce = w3.eth.get_transaction_count(acct.address)
            tx = contract.functions.claimReward(PERIOD, Web3.to_checksum_address(TOKEN_ADDR)).build_transaction(
                {
                    "from": acct.address,
                    "nonce": nonce,
                    "gas": 400_000,
                    "maxFeePerGas": w3.to_wei("3", "gwei"),
                    "maxPriorityFeePerGas": w3.to_wei("1", "gwei"),
                }
            )
            signed = acct.sign_transaction(tx)
            tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)
            print(f"  -> tx = {tx_hash.hex()}")
            # 简单节流，避免 nonce 过快 + 节点限流
            time.sleep(3)
        except Exception as e:  # pylint: disable=broad-except
            print(f"[error] 为 {addr} 触发领取失败: {e}")


if __name__ == "__main__":
    main()

