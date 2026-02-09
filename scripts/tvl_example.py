"""
简单 TVL 脚本示例：
- 读取 Vault 与 AMM 池中的 TKA/TKB 余额
- 按当前价格（可选，默认 1:1）估算 TVL

用法：
    python scripts/tvl_example.py

依赖：
    pip install web3
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Optional
import os

from web3 import Web3


@dataclass
class ChainConfig:
  rpc_url: str
  vault: str
  amm_pool: str
  token0: str
  token1: str


# 默认使用 Sepolia，地址与 frontend/src/config/chains.ts 中一致
DEFAULT_CONFIG = ChainConfig(
  rpc_url=os.environ.get("RPC_URL", "https://ethereum-sepolia.publicnode.com"),
  vault="0xbe3962Eaf7103d05665279469FFE3573352ec70C",
  amm_pool="0x8d392e6b270238c3a05dDB719795eE31ad7c72AF",
  token0="0x678195277dc8F84F787A4694DF42F3489eA757bf",  # TKA
  token1="0x9Be241a0bF1C2827194333B57278d1676494333a",  # TKB
)


ERC20_ABI = [
  {
    "constant": True,
    "inputs": [{"name": "_owner", "type": "address"}],
    "name": "balanceOf",
    "outputs": [{"name": "balance", "type": "uint256"}],
    "type": "function",
  }
]

VAULT_ABI = [
  {
    "constant": True,
    "inputs": [{"name": "token", "type": "address"}, {"name": "user", "type": "address"}],
    "name": "balanceOf",
    "outputs": [{"name": "balance", "type": "uint256"}],
    "type": "function",
  }
]

AMM_ABI = [
  {
    "constant": True,
    "inputs": [],
    "name": "reserve0",
    "outputs": [{"name": "", "type": "uint256"}],
    "type": "function",
  },
  {
    "constant": True,
    "inputs": [],
    "name": "reserve1",
    "outputs": [{"name": "", "type": "uint256"}],
    "type": "function",
  },
]


def wei_to_decimal(value: int, decimals: int = 18) -> Decimal:
  return Decimal(value) / (Decimal(10) ** decimals)


def get_vault_tvl(web3: Web3, cfg: ChainConfig) -> Decimal:
  vault = web3.eth.contract(address=cfg.vault, abi=VAULT_ABI)
  # Vault 按 token 地址 + 用户地址记录余额，这里用零地址统计「总余额」示例
  zero = "0x0000000000000000000000000000000000000000"
  bal0 = vault.functions.balanceOf(cfg.token0, zero).call()
  bal1 = vault.functions.balanceOf(cfg.token1, zero).call()
  return wei_to_decimal(bal0) + wei_to_decimal(bal1)


def get_amm_tvl(web3: Web3, cfg: ChainConfig) -> Decimal:
  amm = web3.eth.contract(address=cfg.amm_pool, abi=AMM_ABI)
  r0 = amm.functions.reserve0().call()
  r1 = amm.functions.reserve1().call()
  return wei_to_decimal(r0) + wei_to_decimal(r1)


def main(cfg: Optional[ChainConfig] = None) -> None:
  cfg = cfg or DEFAULT_CONFIG
  web3 = Web3(Web3.HTTPProvider(cfg.rpc_url))

  print(f"RPC_URL = {cfg.rpc_url}")
  print(f"Vault   = {cfg.vault}")
  print(f"AMMPool = {cfg.amm_pool}")

  vault_tvl = get_vault_tvl(web3, cfg)
  amm_tvl = get_amm_tvl(web3, cfg)
  total_tvl = vault_tvl + amm_tvl

  print(f"Vault TVL (TKA+TKB): {vault_tvl:.6f}")
  print(f"AMM   TVL (TKA+TKB): {amm_tvl:.6f}")
  print(f"Total TVL (TKA+TKB): {total_tvl:.6f}")


if __name__ == "__main__":
  main()

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
