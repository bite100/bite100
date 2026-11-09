/**
 * 块 1：只读工具（无私钥、无写路径）。
 * 数据源：订单簿/订单列表骑中继 REST；余额/成交量/锁定状态骑链上读。
 */
import { ethers } from 'ethers'
import { z } from 'zod'
import { assertAllowedChain, assertAllowedPair, chainSummary } from '../config'
import { loadSignerForRole } from '../signers'
import { addressField, chainIdField, digestField, parseArgs, type ToolDef } from './common'

const getChainConfigSchema = z.object({ chainId: chainIdField })

const getOrderbookSchema = z.object({
  chainId: chainIdField,
  pair: z.string().min(3),
  depth: z.number().int().min(1).max(50).optional(),
})

const listOrdersSchema = z.object({
  chainId: chainIdField,
  pair: z.string().min(3).optional(),
  userAddress: addressField.optional(),
  limit: z.number().int().min(1).max(200).optional(),
})

const getBalancesSchema = z.object({
  chainId: chainIdField,
  address: addressField.optional(),
})

const getOrderStatusSchema = z.object({
  chainId: chainIdField,
  digest: digestField,
})

function fmt(wei: bigint): { wei: string; human: string } {
  return { wei: wei.toString(), human: ethers.formatUnits(wei, 18) }
}

export const readTools: ToolDef[] = [
  {
    name: 'get_chain_config',
    description:
      '查看某条测试网链的配置：第 47 轮栈的 Settlement/Vault/MakerVault 合约地址、支持的交易对与代币地址。chainId 只允许 11155111（Sepolia）或 84532（Base Sepolia），主网一律拒绝。',
    schema: getChainConfigSchema,
    write: false,
    handler: async (_ctx, args) => {
      const { chainId } = parseArgs(getChainConfigSchema, args)
      assertAllowedChain(chainId)
      return chainSummary(chainId)
    },
  },
  {
    name: 'get_orderbook',
    description:
      '查看某交易对的订单簿（中继聚合的挂单，买盘/卖盘各按价格优先排序）。数据来自中继 REST，不上链。',
    schema: getOrderbookSchema,
    write: false,
    handler: async (ctx, args) => {
      const { chainId, pair, depth } = parseArgs(getOrderbookSchema, args)
      assertAllowedChain(chainId)
      assertAllowedPair(pair)
      const book = await ctx.relay.orderbook({ chainId, pair })
      const n = depth ?? 20
      return { pair, chainId, bids: book.bids.slice(0, n), asks: book.asks.slice(0, n) }
    },
  },
  {
    name: 'list_orders',
    description:
      '按交易对和/或用户地址查询中继上的未过期订单（最新在前）。不传 userAddress 则返回该链（或该交易对）的全部未过期订单。',
    schema: listOrdersSchema,
    write: false,
    handler: async (ctx, args) => {
      const { chainId, pair, userAddress, limit } = parseArgs(listOrdersSchema, args)
      assertAllowedChain(chainId)
      if (pair) assertAllowedPair(pair)
      const orders = await ctx.relay.listOrders({ chainId, pair, userAddress, limit: limit ?? 50 })
      return { chainId, count: orders.length, orders }
    },
  },
  {
    name: 'get_balances',
    description:
      '查询某个地址在指定链上的余额：原生币（gas）+ 每个已登记代币的钱包余额、Vault 余额与 Vault 可用余额（全部链上直读）。不传 address 时默认查本 agent 钱包角色对应的测试钱包地址。',
    schema: getBalancesSchema,
    write: false,
    handler: async (ctx, args) => {
      const { chainId, address } = parseArgs(getBalancesSchema, args)
      assertAllowedChain(chainId)
      let addr = address
      if (!addr) {
        // 只读默认地址解析：仅取地址，不做任何签名
        addr = loadSignerForRole(ctx.agent.role).address
      }
      const summary = chainSummary(chainId)
      const tokens: Record<string, unknown> = {}
      for (const [symbol, token] of Object.entries(summary.tokens)) {
        const [wallet, vault, available] = await Promise.all([
          ctx.chain.tokenBalance(chainId, token, addr),
          ctx.chain.vaultBalance(chainId, token, addr),
          ctx.chain.vaultAvailable(chainId, token, addr),
        ])
        tokens[symbol] = {
          token,
          wallet: fmt(wallet),
          vault: fmt(vault),
          vaultAvailable: fmt(available),
        }
      }
      const native = await ctx.chain.nativeBalance(chainId, addr)
      return { chainId, address: addr, native: fmt(native), tokens }
    },
  },
  {
    name: 'get_order_status',
    description:
      '按订单摘要（digest）查链上状态：已成交量（Settlement 记录）、当前锁定（Vault orderLocks）、是否已被永久撤销（第 47 轮 cancelledOrders 墓碑）。链是唯一账本，本工具只读链。',
    schema: getOrderStatusSchema,
    write: false,
    handler: async (ctx, args) => {
      const { chainId, digest } = parseArgs(getOrderStatusSchema, args)
      assertAllowedChain(chainId)
      const [filled, lock, cancelled] = await Promise.all([
        ctx.chain.orderFilledIn(chainId, digest),
        ctx.chain.orderLock(chainId, digest),
        ctx.chain.orderCancelled(chainId, digest),
      ])
      return {
        chainId,
        digest,
        filledIn: fmt(filled),
        locked: lock !== null,
        lock,
        cancelled,
      }
    },
  },
]
