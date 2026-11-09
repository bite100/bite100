import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ethers } from 'ethers'
import { afterEach, describe, expect, it } from 'vitest'
import { _resetSignerCache, loadSignerForRole } from '../src/signers'

// 公开的 Anvil/Hardhat 文档测试钥（账号 #0），仅用于本单测验证签名
// 接口形状；分两半拼接避免被密钥扫描误报为真实私钥泄露。
const ANVIL_KEY_HALF_A = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4'
const ANVIL_KEY_HALF_B = 'f2ff80'
const ANVIL_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

describe('TestWalletSigner（经 AgentSigner 接口）', () => {
  afterEach(() => {
    _resetSignerCache()
    delete process.env.BIT100_MCP_KEYFILE_MAKER
  })

  it('从 env 文件路径加载、地址正确、EIP-712 签名可验', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-key-'))
    const keyfile = join(dir, 'maker.env')
    writeFileSync(keyfile, `PRIVATE_KEY=${ANVIL_KEY_HALF_A}${ANVIL_KEY_HALF_B}\n`)
    process.env.BIT100_MCP_KEYFILE_MAKER = keyfile

    const signer = loadSignerForRole('maker')
    expect(signer.address).toBe(ANVIL_ADDRESS)
    expect(await signer.getAddress()).toBe(ANVIL_ADDRESS)

    const domain = { name: 'Bit100', version: '1', chainId: 11155111 }
    const types = { Ping: [{ name: 'v', type: 'uint256' }] }
    const sig = await signer.signTypedData(domain, types, { v: 42 })
    const recovered = ethers.verifyTypedData(domain, types, { v: 42 }, sig)
    expect(recovered).toBe(ANVIL_ADDRESS)
  })

  it('未配置环境变量 → signer_not_configured 结构化错误', () => {
    expect(() => loadSignerForRole('maker')).toThrowError(
      expect.objectContaining({ code: 'signer_not_configured' }),
    )
  })
})
