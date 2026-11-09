/**
 * MCP server 配置：链/交易对/合约地址一律骑前端生产配置
 * （frontend/src/config/chains.ts + pairs.ts，第 47 轮栈地址的单一
 * 事实源在那里，本包不复制地址表，避免第 47 轮切换时出现过的
 * 「三方地址不一致」问题）。
 *
 * 硬约束（护栏的一部分，写死在代码里）：
 * - 只允许 Sepolia(11155111) 与 Base Sepolia(84532) 两条测试网链；
 *   配置里出现任何主网链 ID，调用即拒（assertAllowedChain）。
 * - 交易对只允许 pairs.ts 登记的 8 个测试交易对。
 */
import { getChainConfig, type ChainConfig } from '../../frontend/src/config/chains'
import { TRADE_PAIRS, getPairTokens, type TradePair } from '../../frontend/src/config/pairs'
import { ToolError } from './errors'

export const ALLOWED_CHAIN_IDS = [11155111, 84532] as const
export type AllowedChainId = (typeof ALLOWED_CHAIN_IDS)[number]

export const ALLOWED_PAIRS: readonly string[] = TRADE_PAIRS
export type { TradePair }

export const DEFAULT_RELAY_URL = 'https://bit100-relay.q3874758.workers.dev'

export function relayUrl(): string {
  return (process.env.BIT100_MCP_RELAY_URL ?? DEFAULT_RELAY_URL).replace(/\/+$/, '')
}

/** 链白名单断言：白名单外（含全部主网）一律结构化拒绝 */
export function assertAllowedChain(chainId: number): asserts chainId is AllowedChainId {
  if (!(ALLOWED_CHAIN_IDS as readonly number[]).includes(chainId)) {
    throw new ToolError(
      'chain_not_allowed',
      `chainId ${chainId} 不在测试网白名单内（仅允许 ${ALLOWED_CHAIN_IDS.join(' / ')}），已拒绝`,
    )
  }
}

export function chainConfig(chainId: number): ChainConfig {
  assertAllowedChain(chainId)
  const cfg = getChainConfig(chainId)
  if (!cfg) throw new ToolError('chain_not_configured', `chainId ${chainId} 无链配置`)
  return cfg
}

/** 交易对白名单断言 */
export function assertAllowedPair(pair: string): asserts pair is TradePair {
  if (!ALLOWED_PAIRS.includes(pair)) {
    throw new ToolError(
      'pair_not_allowed',
      `交易对 ${pair} 不在白名单内（仅允许 ${ALLOWED_PAIRS.join(' / ')}），已拒绝`,
    )
  }
}

export function pairTokens(chainId: number, pair: string): { base: string; quote: string } {
  assertAllowedChain(chainId)
  assertAllowedPair(pair)
  const t = getPairTokens(chainId, pair)
  if (!t) throw new ToolError('pair_not_configured', `交易对 ${pair} 在 chainId ${chainId} 未登记代币`)
  return t
}

/** 面向工具返回的链配置摘要（不含任何敏感信息） */
export function chainSummary(chainId: number) {
  const cfg = chainConfig(chainId)
  return {
    chainId: cfg.chainId,
    name: cfg.name,
    rpcUrl: cfg.rpcUrl,
    settlement: cfg.contracts.settlement,
    vault: cfg.contracts.vault,
    makerVault: cfg.contracts.makerVault ?? null,
    pairs: ALLOWED_PAIRS,
    tokens: cfg.tokens ?? {},
  }
}
