#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TVL 示例：从链上读取 Vault 总存款 + AMMPool 流动性，汇总为「当前 TVL」。
依赖: pip install web3 requests
用法: 设置环境变量 RPC_URL、VAULT_ADDRESS、AMM_ADDRESS、TOKEN0/TOKEN1 后运行
      或修改下方 CONFIG。可接入 cron + InfluxDB/Grafana。
"""
from __future__ import annotations

import os

# --------------- 配置 ---------------
RPC_URL = os.environ.get("RPC_URL", "https://ethereum-sepolia.publicnode.com")
VAULT_ADDRESS = os.environ.get("VAULT_ADDRESS", "")      # Vault 合约
AMM_ADDRESS = os.environ.get("AMM_ADDRESS", "")          # AMMPool 合约
TOKEN0 = os.environ.get("TOKEN0", "")                   # AMM token0 地址
TOKEN1 = os.environ.get("TOKEN1", "")                   # AMM token1 地址
# 若需 USD 计价，可接价格 API（如 CoinGecko）；此处仅输出原始余额
# --------------- 配置结束 ---------------

try:
    from web3 import Web3
except ImportError:
    print("pip install web3")
    raise

ERC20_ABI = [
    {"inputs": [{"name": "account", "type": "address"}], "name": "balanceOf", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
]
VAULT_ABI = [
    {"inputs": [{"name": "token", "type": "address"}, {"name": "account", "type": "address"}], "name": "balanceOf", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
]
AMM_ABI = [
    {"inputs": [], "name": "reserve0", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "reserve1", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
]


def get_vault_tvl(w3: Web3, vault_addr: str, tokens: list[str]) -> dict[str, int]:
    """Vault 内各代币总余额（需遍历已知 token 或从事件汇总；此处简化：仅查 Vault 自身持币）"""
    vault = w3.eth.contract(address=Web3.to_checksum_address(vault_addr), abi=VAULT_ABI)
    out = {}
    for t in tokens:
        if not t:
            continue
        token = w3.eth.contract(address=Web3.to_checksum_address(t), abi=ERC20_ABI)
        out[t] = token.functions.balanceOf(Web3.to_checksum_address(vault_addr)).call()
    return out


def get_amm_tvl(w3: Web3, amm_addr: str) -> tuple[int, int]:
    """AMMPool reserve0 / reserve1（原始 wei/最小单位）"""
    amm = w3.eth.contract(address=Web3.to_checksum_address(amm_addr), abi=AMM_ABI)
    r0 = amm.functions.reserve0().call()
    r1 = amm.functions.reserve1().call()
    return r0, r1


def main() -> None:
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        print("RPC not connected")
        return
    tvl_vault = {}
    if VAULT_ADDRESS and (TOKEN0 or TOKEN1):
        tokens = [t for t in [TOKEN0, TOKEN1] if t]
        tvl_vault = get_vault_tvl(w3, VAULT_ADDRESS, tokens)
    r0, r1 = 0, 0
    if AMM_ADDRESS:
        r0, r1 = get_amm_tvl(w3, AMM_ADDRESS)
    print("Vault balances (raw):", tvl_vault)
    print("AMM reserve0:", r0, "reserve1:", r1)
    # 可在此将 r0/r1 与价格 API 换算成 USD，写入 InfluxDB 等
    print("(For USD TVL: plug in price feed and sum; or use DefiLlama adapter)")


if __name__ == "__main__":
    main()
