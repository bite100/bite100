/**
 * 第二十轮垫资快线 provider（LI.FI 聚合）单元测试
 * 重点：测试网链对必须在发任何网络请求之前被拦截；主网报价解析的费用拆分口径正确。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  fastLanePairSupport,
  fetchFastLaneQuote,
  fetchFastLaneStatus,
  parseLifiQuote,
  mapLifiStatus,
  resolveFastLaneTokenPair,
  formatFastLaneEta,
  FastLaneUnavailableError,
  ZERO_ADDRESS,
} from './fastLane'

const USER = '0x4B3fbb64ed7F3CD892484154EC684C1eFC8fa93e'
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const WETH_BASE = '0x4200000000000000000000000000000000000006'

// 形状对齐 LI.FI GET /v1/quote 官方响应（字段取自官方 API 文档，数值是构造样例）
const LIFI_QUOTE_FIXTURE = {
  id: 'quote-fixture-1',
  type: 'lifi',
  tool: 'relay',
  toolDetails: { name: 'Relay', logoURI: 'https://example.invalid/relay.png' },
  action: {
    fromChainId: 1,
    toChainId: 8453,
    fromToken: { address: USDC_ETH, symbol: 'USDC', decimals: 6, chainId: 1 },
    toToken: { address: USDC_BASE, symbol: 'USDC', decimals: 6, chainId: 8453 },
    fromAmount: '100000000',
    fromAddress: USER,
    toAddress: USER,
    slippage: 0.005,
  },
  estimate: {
    fromAmount: '100000000',
    toAmount: '99650000',
    toAmountMin: '99151750',
    approvalAddress: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    executionDuration: 30,
    feeCosts: [
      {
        name: 'LIFI Fee',
        description: 'Fee collected by LI.FI',
        token: { address: USDC_ETH, symbol: 'USDC', decimals: 6, chainId: 1 },
        amount: '250000',
        amountUSD: '0.25',
        percentage: '0.0025',
        included: true,
      },
      {
        name: 'Relay Fee',
        description: 'Solver fee',
        token: { address: USDC_ETH, symbol: 'USDC', decimals: 6, chainId: 1 },
        amount: '100000',
        amountUSD: '0.10',
        percentage: '0.001',
        included: true,
      },
    ],
    gasCosts: [
      {
        type: 'SEND',
        price: '20000000000',
        estimate: '120000',
        limit: '150000',
        amount: '2400000000000000',
        amountUSD: '0.62',
        token: { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18, chainId: 1 },
      },
    ],
  },
  transactionRequest: {
    to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    data: '0xdeadbeef',
    value: '0',
    chainId: 1,
    gasLimit: '150000',
  },
}

function okJsonFetcher(body: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch
}

describe('fastLanePairSupport', () => {
  it('主网 Ethereum ↔ Base 已开通', () => {
    expect(fastLanePairSupport(1, 8453)).toEqual({ supported: true })
    expect(fastLanePairSupport(8453, 1)).toEqual({ supported: true })
  })

  it('含测试网链一律拦截，原因 testnet', () => {
    expect(fastLanePairSupport(11155111, 84532)).toEqual({ supported: false, reason: 'testnet' })
    expect(fastLanePairSupport(11155111, 8453)).toEqual({ supported: false, reason: 'testnet' })
    expect(fastLanePairSupport(1, 84532)).toEqual({ supported: false, reason: 'testnet' })
  })

  it('未开通的主网链对拦截，原因 chain-not-enabled', () => {
    expect(fastLanePairSupport(1, 137)).toEqual({ supported: false, reason: 'chain-not-enabled' })
    expect(fastLanePairSupport(42161, 8453)).toEqual({ supported: false, reason: 'chain-not-enabled' })
    expect(fastLanePairSupport(1, 1)).toEqual({ supported: false, reason: 'chain-not-enabled' })
  })
})

describe('fetchFastLaneQuote 的测试网诚实拦截', () => {
  it('Sepolia → Base Sepolia：抛 FastLaneUnavailableError 且不发任何请求', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch
    await expect(
      fetchFastLaneQuote(
        {
          srcChainId: 11155111,
          dstChainId: 84532,
          fromToken: '0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E',
          toToken: '0xd3f1136Cb3511b4546BDE5dDAC4F0D5a4D5C5D33',
          amountWei: 10n * 10n ** 18n,
          fromAddress: USER,
        },
        fetcher
      )
    ).rejects.toBeInstanceOf(FastLaneUnavailableError)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('未开通主网链对同样不发请求', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch
    await expect(
      fetchFastLaneQuote(
        {
          srcChainId: 1,
          dstChainId: 137,
          fromToken: ZERO_ADDRESS,
          toToken: ZERO_ADDRESS,
          amountWei: 1000n,
          fromAddress: USER,
        },
        fetcher
      )
    ).rejects.toBeInstanceOf(FastLaneUnavailableError)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('fetchFastLaneQuote 主网报价', () => {
  it('拼对 LI.FI 官方端点与参数，并解析费用拆分', async () => {
    const fetcher = okJsonFetcher(LIFI_QUOTE_FIXTURE)
    const q = await fetchFastLaneQuote(
      {
        srcChainId: 1,
        dstChainId: 8453,
        fromToken: USDC_ETH,
        toToken: USDC_BASE,
        amountWei: 100_000_000n,
        fromAddress: USER,
      },
      fetcher
    )
    const calledUrl = String((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(calledUrl).toContain('https://li.quest/v1/quote?')
    expect(calledUrl).toContain('fromChain=1')
    expect(calledUrl).toContain('toChain=8453')
    expect(calledUrl).toContain('fromAmount=100000000')

    expect(q.routeTool).toBe('Relay')
    expect(q.netReceived).toBe(99_650_000n)
    expect(q.toAmountMin).toBe(99_151_750n)
    expect(q.toTokenSymbol).toBe('USDC')
    expect(q.toTokenDecimals).toBe(6)
    expect(q.etaSeconds).toBe(30)
    // 从到账扣除：LI.FI 服务费 + 求解器费共两项
    expect(q.deductedFees).toHaveLength(2)
    expect(q.deductedFees.reduce((s, f) => s + f.amount, 0n)).toBe(350_000n)
    expect(q.upfrontFees).toHaveLength(0)
    // gas 单独一列（源链 ETH，不从到账扣）
    expect(q.gasCosts).toHaveLength(1)
    expect(q.gasCosts[0].symbol).toBe('ETH')
    expect(q.gasCosts[0].amount).toBe(2_400_000_000_000_000n)
    // 执行交易原样透传
    expect(q.transactionRequest?.to).toBe('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE')
    expect(q.approvalAddress).toBe('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE')
  })

  it('LI.FI 报错（如 429 限流）时把官方 message 原样抛出，不伪造报价', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ message: 'Rate limit exceeded, retry in 25 minutes', code: 1005 }),
    })) as unknown as typeof fetch
    await expect(
      fetchFastLaneQuote(
        {
          srcChainId: 1,
          dstChainId: 8453,
          fromToken: ZERO_ADDRESS,
          toToken: ZERO_ADDRESS,
          amountWei: 1000n,
          fromAddress: USER,
        },
        fetcher
      )
    ).rejects.toThrow('Rate limit exceeded')
  })
})

describe('parseLifiQuote', () => {
  it('缺字段时安全降级，不抛错', () => {
    const q = parseLifiQuote({})
    expect(q.netReceived).toBe(0n)
    expect(q.deductedFees).toEqual([])
    expect(q.gasCosts).toEqual([])
    expect(q.transactionRequest).toBeUndefined()
  })
})

describe('状态映射', () => {
  it('DONE → Completed 并带回目的链哈希与到账额', () => {
    const s = mapLifiStatus({ status: 'DONE', receiving: { txHash: '0xabc', amount: '99650000' } })
    expect(s.state).toBe('Completed')
    expect(s.dstTxHash).toBe('0xabc')
    expect(s.receivedAmount).toBe(99_650_000n)
  })

  it('PENDING → InFlight；FAILED/INVALID → Failed；NOT_FOUND → Initiated（不谎报进度）', () => {
    expect(mapLifiStatus({ status: 'PENDING' }).state).toBe('InFlight')
    expect(mapLifiStatus({ status: 'FAILED' }).state).toBe('Failed')
    expect(mapLifiStatus({ status: 'INVALID' }).state).toBe('Failed')
    expect(mapLifiStatus({ status: 'NOT_FOUND' }).state).toBe('Initiated')
  })

  it('fetchFastLaneStatus 对测试网链对同样拦截、不发请求', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch
    await expect(
      fetchFastLaneStatus({ txHash: '0xabc', srcChainId: 11155111, dstChainId: 84532 }, fetcher)
    ).rejects.toBeInstanceOf(FastLaneUnavailableError)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('resolveFastLaneTokenPair', () => {
  it('原生币两链同为零地址', () => {
    expect(resolveFastLaneTokenPair(1, 8453, '')).toEqual([ZERO_ADDRESS, ZERO_ADDRESS])
    expect(resolveFastLaneTokenPair(1, 8453, ZERO_ADDRESS)).toEqual([ZERO_ADDRESS, ZERO_ADDRESS])
  })

  it('USDC / WETH 自动配对到目的链同名资产', () => {
    expect(resolveFastLaneTokenPair(1, 8453, USDC_ETH)).toEqual([USDC_ETH, USDC_BASE])
    expect(resolveFastLaneTokenPair(8453, 1, USDC_BASE)).toEqual([USDC_BASE, USDC_ETH])
    expect(resolveFastLaneTokenPair(1, 8453, WETH_ETH)).toEqual([WETH_ETH, WETH_BASE])
  })

  it('未知代币默认两链同地址（由 LI.FI 校验）', () => {
    const t = '0x1111111111111111111111111111111111111111'
    expect(resolveFastLaneTokenPair(1, 8453, t)).toEqual([t, t])
  })
})

describe('formatFastLaneEta', () => {
  it('秒级 → 约 1 分钟内；分钟级取整', () => {
    expect(formatFastLaneEta(2)).toBe('约 1 分钟内')
    expect(formatFastLaneEta(300)).toBe('约 5 分钟')
    expect(formatFastLaneEta(0)).toBe('以实时报价为准')
  })
})
