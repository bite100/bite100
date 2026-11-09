/**
 * 签名层 —— 可替换的 signer 接口（Ren 2026-11-09 13:46 终局形态要求）。
 *
 * 产品形态：任何人用任何 AI 客户端接上本 MCP、连上**自己的**钱包即可
 * 交易，交易所永远不碰用户私钥。工具层只依赖下面的 `AgentSigner`
 * 接口，不关心签名到底发生在哪里：
 *
 * - 本轮实现 `TestWalletSigner`：服务端测试钱包签名器——从运行时
 *   环境注入的 env 文件路径读取**测试网**测试钥（无真实价值），是
 *   测试网练习的脚手架，不是产品形态。
 * - 后续产品化实现「用户自带钱包签名器」（外部钱包 / 用户自己的
 *   agent 钱包回签）时，只需新增一个 AgentSigner 实现，工具层零改动。
 *
 * 私钥纪律：只在进程启动/首次使用时从环境变量指向的 env 文件读取，
 * 只存在于内存；绝不写进代码、配置、日志或 git。
 */
import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'
import type { AgentRole } from './agents'
import { ToolError } from './errors'

/** 工具层依赖的全部签名能力（与前端 orderSigning 的 SignerLike 兼容） */
export interface AgentSigner {
  readonly address: string
  getAddress(): Promise<string>
  signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string>
  /** 连接到指定 provider 的可发交易 signer（结算/落锁/硬撤用） */
  connect(provider: ethers.Provider): ethers.Signer
}

/** 本轮实现：服务端测试钱包（ethers.Wallet 适配到 AgentSigner） */
export class TestWalletSigner implements AgentSigner {
  readonly address: string

  constructor(private wallet: ethers.Wallet) {
    this.address = wallet.address
  }

  async getAddress(): Promise<string> {
    return this.address
  }

  signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value)
  }

  connect(provider: ethers.Provider): ethers.Signer {
    return this.wallet.connect(provider)
  }
}

/**
 * 角色 → env 文件路径的环境变量名（路径本身不含密钥）：
 *   BIT100_MCP_KEYFILE_MAKER / _TAKER / _OPERATOR
 * 文件格式与 ~/workspace/bite100-deployer/*.env 相同（含 PRIVATE_KEY=，
 * 取首个 0x<64hex>，与 soak generator 的 loadWallets 同法）。
 */
const KEYFILE_ENV: Record<AgentRole, string> = {
  maker: 'BIT100_MCP_KEYFILE_MAKER',
  taker: 'BIT100_MCP_KEYFILE_TAKER',
  operator: 'BIT100_MCP_KEYFILE_OPERATOR',
}

const signerCache = new Map<AgentRole, AgentSigner>()

/**
 * 无文件系统运行时（如 Cloudflare Workers）的钥注入钩子：宿主在装配时
 * 注入「按角色返回私钥十六进制文本」的提供者，loadSignerForRole 优先
 * 走它；Node/stdio 路径不注入，行为与原来逐字一致（单测覆盖原路径）。
 */
let keyTextProvider: ((role: AgentRole) => string | null) | null = null

export function _setKeyTextProvider(fn: ((role: AgentRole) => string | null) | null): void {
  keyTextProvider = fn
  signerCache.clear()
}

export function loadSignerForRole(role: AgentRole): AgentSigner {
  const cached = signerCache.get(role)
  if (cached) return cached
  if (keyTextProvider) {
    const key = keyTextProvider(role)
    if (!key) {
      throw new ToolError('signer_not_configured', `角色 ${role} 的签名器未配置：运行时未提供测试钥`)
    }
    const injected = new TestWalletSigner(new ethers.Wallet(key))
    signerCache.set(role, injected)
    return injected
  }
  const envName = KEYFILE_ENV[role]
  const path = process.env[envName]
  if (!path) {
    throw new ToolError(
      'signer_not_configured',
      `角色 ${role} 的签名器未配置：环境变量 ${envName} 未设置（应指向测试钥 env 文件路径）`,
    )
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new ToolError('signer_not_configured', `角色 ${role} 的密钥文件不可读（路径来自 ${envName}）`)
  }
  const m = text.match(/0x[0-9a-fA-F]{64}/)
  if (!m) throw new ToolError('signer_not_configured', `角色 ${role} 的密钥文件中未找到私钥`)
  const signer = new TestWalletSigner(new ethers.Wallet(m[0]))
  signerCache.set(role, signer)
  return signer
}

/** 单测用：清空签名器缓存 */
export function _resetSignerCache(): void {
  signerCache.clear()
}
