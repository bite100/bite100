/** 单测共用 mock 上下文：假中继（fetch 注入）+ 假链读（接口实现）。 */
import { join } from 'node:path'
import { AgentRegistry, WriteGuard, type AgentEntry } from '../src/agents'
import { nullAudit } from '../src/audit'
import type { ChainReader, LockInfo } from '../src/chain'
import { RelayClient, type FetchFn } from '../src/relay'
import type { ToolContext } from '../src/tools/common'

export const FIXTURE_REGISTRY = join(__dirname, 'fixtures', 'agents.json')

export const MAKER_ADDR = '0xE83D2b08356cb463adFc20406a18B79991F7eE29'
export const DIGEST = '0x' + 'ab'.repeat(32)

export class FakeChainReader implements ChainReader {
  filled = 0n
  lock: LockInfo | null = null
  cancelled = false
  native = 10n ** 18n
  tokenBal = 500n * 10n ** 18n
  vaultBal = 100n * 10n ** 18n
  vaultAvail = 90n * 10n ** 18n

  async nativeBalance(): Promise<bigint> {
    return this.native
  }
  async tokenBalance(): Promise<bigint> {
    return this.tokenBal
  }
  async vaultBalance(): Promise<bigint> {
    return this.vaultBal
  }
  async vaultAvailable(): Promise<bigint> {
    return this.vaultAvail
  }
  async orderFilledIn(): Promise<bigint> {
    return this.filled
  }
  async orderLock(): Promise<LockInfo | null> {
    return this.lock
  }
  async orderCancelled(): Promise<boolean> {
    return this.cancelled
  }
  provider(): never {
    throw new Error('FakeChainReader.provider 不应在只读/护栏单测中被调用')
  }
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const sampleOrder = {
  orderId: 'ord-1',
  trader: MAKER_ADDR,
  pair: 'TKA/TKB',
  side: 'sell',
  price: '1500000000000000000',
  amount: '500000000000000000',
  filled: '0',
  status: 'open',
  nonce: 7,
  createdAt: 1700000000,
  expiresAt: 1700003600,
  signature: '0x' + 'cd'.repeat(65),
  chainId: 11155111,
  digest: DIGEST,
}

export function makeCtx(opts?: {
  agentId?: string
  fetchFn?: FetchFn
  chain?: FakeChainReader
}): { ctx: ToolContext; registry: AgentRegistry; agent: AgentEntry; chain: FakeChainReader } {
  const registry = AgentRegistry.load(FIXTURE_REGISTRY)
  const agent = registry.byId(opts?.agentId ?? 'maker-test')!
  const chain = opts?.chain ?? new FakeChainReader()
  const fetchFn: FetchFn =
    opts?.fetchFn ??
    (async (url: string) => {
      if (url.includes('/orderbook')) return jsonResponse({ pair: 'TKA/TKB', bids: [], asks: [sampleOrder] })
      if (url.includes('/orders')) return jsonResponse([sampleOrder])
      if (url.includes('/health')) return jsonResponse({ ok: true, db: 'ok', time: 1 })
      return jsonResponse({ error: 'not found' }, 404)
    })
  const ctx: ToolContext = {
    relay: new RelayClient('https://relay.invalid', fetchFn),
    chain,
    registry,
    guard: new WriteGuard(registry),
    audit: nullAudit,
    agent,
  }
  return { ctx, registry, agent, chain }
}
