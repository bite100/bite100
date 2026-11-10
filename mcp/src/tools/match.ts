/**
 * 块 3：撮合结算工具。骑前端生产 executeFrontendMatch（双读→本地
 * 撮合→双方落锁→预检模拟剔腿→settleTradesBatch 自提），双读依赖
 * 按阶段 4 运行器同法注入：中继适配器（createRelayBookAdapter）+
 * viem 链状态读取器（createChainStateReader/createViemChainTransport）；
 * 节点适配器走缺省——节点已停机，其失败被双读记为源错误、不拖垮
 * 撮合（阶段 4 已验证的降级语义）。本文件没有自研撮合/结算逻辑，
 * 只有参数校验、护栏与结果整形。
 */
import { assertAllowedChain, assertAllowedPair, relayUrl } from '../config'
import { ToolError } from '../errors'
import { loadSignerForRole } from '../signers'
import { parseArgs, type ToolDef } from './common'
import { buildAndSign, placeOrderSchema } from './orderBuild'

// —— 前端生产代码 ——
import { createRelayBookAdapter } from '../../../frontend/src/services/dualread/adapters'
import {
  createChainStateReader,
  createViemChainTransport,
} from '../../../frontend/src/services/dualread/chainState'
import { executeFrontendMatch } from '../../../frontend/src/services/matching/execute'

const matchOrderSchema = placeOrderSchema

export const matchTools: ToolDef[] = [
  {
    name: 'match_order',
    description:
      '以吃单方身份发起一单并立即走前端撮合全路径：签名订单投中继后，调交易所生产撮合代码（双读订单簿→本地撮合→双方落锁→预检模拟剔腿→整批结算上链）。对手盘无可成交订单时返回 no-match（订单留簿）。结算 gas 由本 agent 的测试钱包承担。',
    schema: matchOrderSchema,
    write: true,
    handler: async (ctx, args) => {
      const input = parseArgs(matchOrderSchema, args)
      assertAllowedChain(input.chainId)
      assertAllowedPair(input.pair)
      const notional = Number(input.price) * Number(input.amount)
      // 第 59 轮记账协议（修第 57 轮 P1-①）：check 即预留；记账时点 =
      // 中继接受。中继 200 之后无论最终成交与否（no-match 留簿同样
      // 消耗）都不回滚；投递失败（组单/签名抛错、中继非 200）才
      // release——旧实现只在 outcome=submitted 时 record，未成交单
      // 零成本，本条即关闭该绕行。
      await ctx.guard.check(ctx.agent, notional)

      let built
      let res
      try {
        built = await buildAndSign(ctx, input)
        res = await ctx.relay.postOrder(built.body)
      } catch (e) {
        await ctx.guard.release(ctx.agent, notional)
        throw e
      }
      if (res.status !== 200) {
        await ctx.guard.release(ctx.agent, notional)
        throw new ToolError('relay_rejected', `中继拒单 HTTP ${res.status}: ${res.text}`)
      }
      // —— 中继已接受：预留转为正式记账，下方撮合结果不再影响记账 ——

      const signer = loadSignerForRole(ctx.agent.role)
      const ethSigner = signer.connect(ctx.chain.provider(input.chainId))
      const deps = {
        // 第 59 轮块 2（Workers 移植）：宿主经 ctx 注入中继地址与服务
        // 绑定 fetch（适配器本就支持 (baseUrl, fetchFn) 注入，阶段 4
        // 运行器同法）；stdio 不注入时回落 relayUrl()，行为不变。
        relayAdapter: createRelayBookAdapter(ctx.relayBaseUrl ?? relayUrl(), ctx.relayFetch),
        chainReader: createChainStateReader(createViemChainTransport()),
      }
      let outcome = await executeFrontendMatch(
        {
          chainId: input.chainId,
          pair: input.pair,
          takerData: built.data,
          takerSignature: built.signature,
          signer: ethSigner,
        },
        deps,
      )
      if (outcome.status === 'no-match') {
        // 与阶段 4 运行器同法：给中继传播留一个重试窗口
        await new Promise((r) => setTimeout(r, 10_000))
        outcome = await executeFrontendMatch(
          {
            chainId: input.chainId,
            pair: input.pair,
            takerData: built.data,
            takerSignature: built.signature,
            signer: ethSigner,
          },
          deps,
        )
      }
      return {
        takerOrderId: built.data.orderId,
        takerDigest: built.digest,
        chainId: input.chainId,
        pair: input.pair,
        status: outcome.status,
        message: outcome.message,
        txHash: outcome.txHash ?? null,
        legsKept: outcome.legsKept,
        legsPruned: outcome.legsPruned,
        legsOverflow: outcome.legsOverflow,
        filledToken0: outcome.filledToken0,
        remainderToken0: outcome.remainderToken0,
      }
    },
  },
]
