#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
上线前 Snapshot：生成开发者积分 + 节点积分分配表，输出 JSON 供 NodeRewards.allocatePoints 使用。
依赖: pip install web3
用法: python scripts/snapshot.py
输出: snapshot.json（wallets, devAmounts, nodeAmounts 数组，可直接用于 Governance/多签调用）
"""
from __future__ import annotations

import json
import os
from collections import defaultdict

# 可选：从链上读已绑定节点数等（需 RPC 和合约 ABI）
try:
    from web3 import Web3
    HAS_WEB3 = True
except ImportError:
    HAS_WEB3 = False

# --------------- 配置 ---------------
RPC_URL = os.environ.get("RPC_URL", "https://ethereum-sepolia.publicnode.com")
# NodeRewards 或 ContributorReward 扩展合约地址（上线前部署后填入）
CONTRACT_ADDR = os.environ.get("NODE_REWARDS_ADDRESS", "")
# 离线：开发者积分（从 GitHub API / 手动 CSV 统计）；地址 => 积分
DEV_CONTRIBUTIONS = {
    "0xYourMainWallet": 5000,   # 例：P2P-P2P 主贡献
    "0xAnotherDev": 1200,
}
# 离线：节点积分（从节点心跳/运行时长/撮合量统计）；地址 => 积分
NODE_CONTRIBUTIONS: dict[str, int] = defaultdict(int)
# 若链上已有绑定，可在此合并；此处示例为空
# --------------- 配置结束 ---------------


def load_onchain_bounds(rpc_url: str, contract_addr: str) -> dict[str, int]:
    """从链上读取已绑定节点数等（可选）。需合约暴露 boundNodeCount(address) 等。"""
    if not HAS_WEB3 or not contract_addr:
        return {}
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    if not w3.is_connected():
        return {}
    # 最小 ABI：仅查询用
    abi = [
        {"inputs": [{"name": "wallet", "type": "address"}], "name": "boundNodeCount", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
        {"inputs": [{"name": "wallet", "type": "address"}], "name": "devPoints", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
        {"inputs": [{"name": "wallet", "type": "address"}], "name": "nodePoints", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
    ]
    contract = w3.eth.contract(address=Web3.to_checksum_address(contract_addr), abi=abi)
    # 示例：只对已知地址查；实际可遍历事件或 TheGraph
    result = {}
    for addr in set(DEV_CONTRIBUTIONS) | set(NODE_CONTRIBUTIONS):
        try:
            result[addr] = contract.functions.boundNodeCount(Web3.to_checksum_address(addr)).call()
        except Exception:
            result[addr] = 0
    return result


def build_snapshot() -> list[dict]:
    """合并离线 + 链上数据，生成 allocatePoints 输入格式。"""
    onchain = load_onchain_bounds(RPC_URL, CONTRACT_ADDR) if CONTRACT_ADDR else {}
    snapshot = []
    seen = set()
    for wallet, dev_amt in DEV_CONTRIBUTIONS.items():
        wallet = wallet.strip()
        if not wallet or wallet in seen:
            continue
        seen.add(wallet)
        node_amt = NODE_CONTRIBUTIONS.get(wallet, 0)
        if dev_amt + node_amt > 0:
            snapshot.append({
                "wallet": wallet,
                "devAmount": dev_amt,
                "nodeAmount": node_amt,
                "boundNodeCount": onchain.get(wallet, 0),
            })
    for wallet, node_amt in NODE_CONTRIBUTIONS.items():
        wallet = wallet.strip()
        if not wallet or wallet in seen:
            continue
        seen.add(wallet)
        dev_amt = DEV_CONTRIBUTIONS.get(wallet, 0)
        if dev_amt + node_amt > 0:
            snapshot.append({
                "wallet": wallet,
                "devAmount": dev_amt,
                "nodeAmount": node_amt,
                "boundNodeCount": onchain.get(wallet, 0),
            })
    return snapshot


def main() -> None:
    snapshot = build_snapshot()
    # 输出 allocatePoints 可直接用的数组
    out = {
        "wallets": [s["wallet"] for s in snapshot],
        "devAmounts": [s["devAmount"] for s in snapshot],
        "nodeAmounts": [s["nodeAmount"] for s in snapshot],
        "raw": snapshot,
    }
    with open("snapshot.json", "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print("Snapshot saved to snapshot.json - ready for Governance/multisig allocatePoints call")
    print(f"  Wallets: {len(out['wallets'])}, Total dev: {sum(out['devAmounts'])}, Total node: {sum(out['nodeAmounts'])}")


if __name__ == "__main__":
    main()
