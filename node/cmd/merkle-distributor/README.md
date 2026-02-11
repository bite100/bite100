# MerkleDistributor 工具

为 `contracts/src/MerkleDistributor.sol` 生成 Merkle root 与 proof。

## 用法

1. 准备奖励列表 CSV（`rewards.csv`），格式：`address,amount`（每行，amount 为 token 最小单位如 wei）

   ```
   0x1234...,1000000000000000000
   0x5678...,2000000000000000000
   ```

2. 生成 root 与 totalAmount：
   ```bash
   go run ./cmd/merkle-distributor -list rewards.csv
   ```

3. 获取某地址的 proof（用于前端 claim）：
   ```bash
   go run ./cmd/merkle-distributor -list rewards.csv -proof-for 0x你的地址
   ```

4. 部署 MerkleDistributor 合约，调用 `setMerkleRoot(root, totalAmount)`，转入代币，用户调用 `claim(index, account, amount, proof)` 领取。
