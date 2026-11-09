// E2E 环境备料（不属于 MCP 工具面）：给 maker/taker 的 Vault 各存入
// 测试 TKA/TKB 各 200，提高可用量（旧验收留下的过期锁占用了可用额）。
// 与第 47 轮的外部注资同一性质；交易全环仍 100% 经 MCP 工具。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ethers } from 'ethers'

const KEYS = '/home/hatch/workspace/bite100-deployer'
const keyOf = (f) => readFileSync(join(KEYS, f), 'utf8').match(/0x[0-9a-fA-F]{64}/)[0]
const CHAINS = [
  { id: 11155111, rpc: 'https://ethereum-sepolia.publicnode.com', vault: '0x836cEFF0140aB66D8DD984ECb18765736BA121e9', tka: '0x93a4af54d7cd8af7c9aef50d3dd3977ba1dde28e', tkb: '0x1530b74e6d5c2d0e2b78314b5c253e66bfc4ddc2' },
  { id: 84532, rpc: 'https://sepolia.base.org', vault: '0x295F5529F5BfA4cA39290f395b1feF7EA637f5D3', tka: '0xd3f1136Cb3511b4546BDE5dDAC4F0D5a4D5C5D33', tkb: '0x8492ccCE958803F04772C0f5B51DbbC320A54daF' },
]
const ERC20 = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']
const VAULT = ['function deposit(address,uint256)', 'function availableBalance(address,address) view returns (uint256)']
const AMOUNT = ethers.parseUnits('200', 18)
const GAS = { gasPrice: 100_000_000n, gasLimit: 600_000n }

for (const c of CHAINS) {
  const provider = new ethers.JsonRpcProvider(c.rpc)
  const vault = new ethers.Contract(c.vault, VAULT, provider)
  for (const role of ['maker', 'taker']) {
    const wallet = new ethers.Wallet(keyOf(`${role}.env`), provider)
    for (const [sym, token] of [['TKA', c.tka], ['TKB', c.tkb]]) {
      const erc = new ethers.Contract(token, ERC20, wallet)
      const before = await vault.availableBalance(wallet.address, token)
      if (before >= AMOUNT) { console.log(`chain ${c.id} ${role} ${sym}: avail already ${ethers.formatUnits(before,18)} skip`); continue }
      const tx1 = await erc.approve(c.vault, AMOUNT, GAS); await tx1.wait()
      const tx2 = await new ethers.Contract(c.vault, VAULT, wallet).deposit(token, AMOUNT, GAS); await tx2.wait()
      const after = await vault.availableBalance(wallet.address, token)
      console.log(`chain ${c.id} ${role} ${sym}: deposited 200 (avail ${ethers.formatUnits(before,18)} → ${ethers.formatUnits(after,18)}) approve=${tx1.hash} deposit=${tx2.hash}`)
    }
  }
}
console.log('funding done')
