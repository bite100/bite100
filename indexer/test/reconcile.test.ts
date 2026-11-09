/**
 * 真实链数据回放对账（RECONCILE=1 时才运行，需公共 RPC 可达）：
 * 取阶段 3 切换双链 E2E 结算 tx 的真实回执日志 + 真实 calldata，经 eth_getLogs
 * 口径解码后用 createTestIndexer 的 simulate 回放进真实 handler，断言：
 * - Trade/GasShare 实体与链上日志逐字段一致（不重不漏）；
 * - calldata 关联出的 makerDigest 与链上 Settlement.orderDigest(order)
 *   的 eth_call 返回值逐字一致（链上真值对账，非自说自话）。
 *
 * 定位说明：这是「真实链数据回放测试」，不是 Envio Cloud 实时同步 E2E
 *（后者需要 HyperSync token / 账号，属部署阶段，见 README）。
 * 默认 npm test 不跑本文件（describe.skipIf），避免离线环境误红。
 *
 * 阶段 3 切换后口径（2026-11-08 复审回填）：下方 CASES 已换成新栈
 * Settlement 地址 + 阶段 3 切换 E2E 的单笔结算 tx（见
 * docs/stage3-cutover-2026-11-08.md §4），RECONCILE=1 已实跑通过；
 * 此后每次切换/重部署都必须同步更换 CASES 并重跑一次。
 */
import { describe, it, expect } from 'vitest'
import { createTestIndexer } from 'envio'
import {
  decodeFunctionData,
  encodeFunctionData,
  parseEventLogs,
} from 'viem'
import { SETTLEMENT_EVENT_ABI, SETTLEMENT_WRITE_ABI } from '../src/lib/settlementAbi'
import { decodeSettleCalldata, tradeEntityId } from '../src/lib/association'

const CASES = [
  {
    chainId: 11155111,
    rpc: 'https://ethereum-sepolia.publicnode.com',
    settlement: '0x5697F7B2178352eB391e29fc2c5681Dea864C1d9',
    settleTx: '0x8f6b138e8ae232c5a01f214e70a5caca27cb36813130b0b000acaa7a03dfbd26',
  },
  {
    chainId: 84532,
    rpc: 'https://sepolia.base.org',
    settlement: '0x1021C7116cCE59f9c85683d6f1b5aD2215795949',
    settleTx: '0x3ead6a1e29f463640e379b298bddb841a66d1055063a3402db6882ef401da2d1',
  },
] as const

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = (await res.json()) as { result?: any; error?: { message: string } }
  if (json.error) throw new Error(`${method}: ${json.error.message}`)
  return json.result
}

const ORDER_DIGEST_ABI = [
  {
    type: 'function',
    name: 'orderDigest',
    stateMutability: 'view',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'orderId', type: 'string' },
          { name: 'userAddress', type: 'address' },
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOut', type: 'uint256' },
          { name: 'price', type: 'uint256' },
          { name: 'timestamp', type: 'uint256' },
          { name: 'expiresAt', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          // 阶段 3 切换：Order 元组末位新增 side（uint8），与新 Settlement
          // 的 orderDigest(Order) 入参 ABI 对齐
          { name: 'side', type: 'uint8' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

describe.skipIf(!process.env.RECONCILE)('真实链数据回放对账（阶段 3 切换 E2E 结算 tx）', () => {
  for (const c of CASES) {
    it(`chain ${c.chainId}: 实体与链上日志逐字段一致、digest 与链上真值一致`, async () => {
      const receipt = await rpc(c.rpc, 'eth_getTransactionReceipt', [c.settleTx])
      const tx = await rpc(c.rpc, 'eth_getTransactionByHash', [c.settleTx])
      expect(receipt.status).toBe('0x1')
      const logs = parseEventLogs({
        abi: SETTLEMENT_EVENT_ABI,
        logs: receipt.logs.filter(
          (l: any) => l.address.toLowerCase() === c.settlement.toLowerCase(),
        ),
      }) as Array<any>
      const tradeLogs = logs.filter(
        (l) => l.eventName === 'TradeSettled' || l.eventName === 'TradeSettledWithGasReimburse',
      )
      const gasLogs = logs.filter((l) => l.eventName === 'GasCostShared')
      expect(tradeLogs.length).toBeGreaterThan(0)

      const blockTs = parseInt(
        (await rpc(c.rpc, 'eth_getBlockByHash', [receipt.blockHash, false])).timestamp,
        16,
      )
      const simulate = logs.map((l) => ({
        contract: 'Settlement',
        event: l.eventName,
        params: l.args,
        block: {
          number: parseInt(receipt.blockNumber, 16),
          timestamp: blockTs,
          hash: receipt.blockHash,
        },
        transaction: { hash: c.settleTx, input: tx.input },
        srcAddress: c.settlement,
        logIndex: l.logIndex,
      }))
      const indexer = createTestIndexer()
      await indexer.process({ chains: { [c.chainId]: { simulate } } })

      const trades = await indexer.Trade.getWhere({ chainId: { _eq: c.chainId } })
      expect(trades.length).toBe(tradeLogs.length)
      for (const l of tradeLogs) {
        const t = await indexer.Trade.getOrThrow(tradeEntityId(c.chainId, c.settleTx, l.logIndex))
        expect(t.maker.toLowerCase()).toBe(l.args.maker.toLowerCase())
        expect(t.taker.toLowerCase()).toBe(l.args.taker.toLowerCase())
        expect(t.amountIn).toBe(l.args.amountIn)
        expect(t.amountOut).toBe(l.args.amountOut)
        expect(t.feeAmount).toBe(l.args.feeAmount)
        expect(t.eventKind).toBe(l.eventName)
        // digest 关联：与链上 orderDigest(order) 真值逐字比对
        expect(t.digestAssociated).toBe(true)
        const fills = decodeSettleCalldata(tx.input)!
        const idx = tradeLogs.indexOf(l)
        const onChainDigest = await rpc(c.rpc, 'eth_call', [
          {
            to: c.settlement,
            data: encodeFunctionData({
              abi: ORDER_DIGEST_ABI,
              functionName: 'orderDigest',
              args: [fills[idx].makerOrder as never],
            }),
          },
          'latest',
        ])
        expect(t.makerDigest).toBe(onChainDigest)
      }
      const shares = await indexer.GasShare.getWhere({ chainId: { _eq: c.chainId } })
      expect(shares.length).toBe(gasLogs.length)
      void decodeFunctionData
    }, 120_000)
  }
})
