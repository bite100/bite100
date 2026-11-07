/**
 * 按链配置：EIP-712 域的 verifyingContract（Settlement 地址）与交易对代币登记。
 *
 * 唯一规范是主仓库 docs/eip712-order-spec.md：域 name=比特100、version=1、
 * chainId 按链、verifyingContract=该链 Settlement 地址。Settlement 换地址时
 * 只改这里（或部署时以 CHAIN_CONFIG_JSON 环境变量整体覆盖），验签逻辑不写死地址。
 * 代币地址与前端 frontend/src/config/chains.ts 的 tokens 登记一致（第 25 轮
 * MockERC20 部署）；中继只按 (链, 交易对) 查这张表来重建签名订单——查不到的
 * 交易对直接拒绝入库（与节点 pairTokens 缺失时验签失败同口径，但报错更明确）。
 */

export interface ChainRelayConfig {
  chainId: number
  /** Settlement 地址 = EIP-712 域 verifyingContract */
  settlement: string
  /** 公共 RPC（仅 ERC-1271 合约账户验签回退时用；EOA 快路径不走网络） */
  rpcUrl: string
  /** 符号 -> 合约地址（18 位 MockERC20 与 TKA/TKB） */
  tokens: Record<string, string>
}

export const DOMAIN_NAME = '比特100'
export const DOMAIN_VERSION = '1'

export const DEFAULT_CHAIN_ID = 11155111

const SEPOLIA: ChainRelayConfig = {
  chainId: 11155111,
  settlement: '0x9f0636839b6699d530F954F87B939DA6f56c9890',
  rpcUrl: 'https://ethereum-sepolia.publicnode.com',
  tokens: {
    TKA: '0x93a4af54d7cD8aF7c9aEF50D3Dd3977bA1Dde28E',
    TKB: '0x1530b74E6d5C2D0e2b78314b5C253E66bfC4ddc2',
    BTC: '0x8EDa0025C245B10eA1E10c257674B794C85350f3',
    ETH: '0x6851ec177dB923ae0A97F262351437D12B21710A',
    SOL: '0x42f7B1B6c2caFb1F3d930B0C247a08f608b034aa',
    BNB: '0x5657f5DBb2C49DBCd4F6d16ebbCb3D4870aACd29',
    XRP: '0x20191571978478AEea15BC39b7D5609BE343D88e',
    DOGE: '0xAb2D18f97E2dd39450bf1C0E59BC4d2Fb23212C7',
    LINK: '0x74159771935E66Ed7dC13370f2BCe89EC8292b18',
    USDT: '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e',
  },
}

const BASE_SEPOLIA: ChainRelayConfig = {
  chainId: 84532,
  settlement: '0x230887F48960E29066d9D3F593cB68F73Adccc85',
  rpcUrl: 'https://sepolia.base.org',
  tokens: {
    TKA: '0xd3f1136Cb3511b4546BDE5dDAC4F0D5a4D5C5D33',
    TKB: '0x8492ccCE958803F04772C0f5B51DbbC320A54daF',
    BTC: '0xf1a6d8fd31fe9e72664fb9f07ffab8056a84156f',
    ETH: '0x151c6be0d525880626f4757d58cd141872af7914',
    SOL: '0xcb704487d52ccf66cae7680c348966e15fa0e430',
    BNB: '0xf567c000f53c76e14fa21c4b90efecc0e4d586ec',
    XRP: '0x26b58d2528a7fdfe744da338c5605123ea2266f3',
    DOGE: '0x68bf313360021dcf4e359ad18c4506f622a3666d',
    LINK: '0x43dc5f7099d3689d0dc73dbdc1e73e7a47e636e2',
    USDT: '0xaab464e0be805c199007e27d8f651038319207d6',
  },
}

/** 内置链配置（仅测试网；中继不做主网操作） */
export const BUILTIN_CHAINS: Record<number, ChainRelayConfig> = {
  [SEPOLIA.chainId]: SEPOLIA,
  [BASE_SEPOLIA.chainId]: BASE_SEPOLIA,
}

/**
 * 解析生效的链配置：环境变量 CHAIN_CONFIG_JSON（JSON 对象，键为 chainId 字符串）
 * 存在时整体替换内置表——Settlement 重部署换地址时不必改代码重新发版，
 * `wrangler secret put` / dashboard 改变量即可。解析失败时 fail-closed 抛错。
 */
export function resolveChains(
  envJson?: string,
  rpcOverrides: Record<number, string> = {},
): Record<number, ChainRelayConfig> {
  let base: Record<number, ChainRelayConfig>
  if (!envJson || envJson.trim() === '') {
    base = BUILTIN_CHAINS
  } else {
    const parsed = JSON.parse(envJson) as Record<string, ChainRelayConfig>
    const out: Record<number, ChainRelayConfig> = {}
    for (const [k, v] of Object.entries(parsed)) {
      const id = Number(k)
      if (!Number.isInteger(id) || !v || typeof v.settlement !== 'string' || !v.tokens) {
        throw new Error(`invalid CHAIN_CONFIG_JSON entry for chain ${k}`)
      }
      out[id] = {
        chainId: id,
        settlement: v.settlement,
        rpcUrl: typeof v.rpcUrl === 'string' ? v.rpcUrl : '',
        tokens: v.tokens,
      }
    }
    if (Object.keys(out).length === 0) throw new Error('CHAIN_CONFIG_JSON is empty')
    base = out
  }
  // 环境变量 RPC 覆盖（SEPOLIA_RPC_URL / BASE_SEPOLIA_RPC_URL 由 index.ts 汇入）
  const withRpc: Record<number, ChainRelayConfig> = {}
  for (const [k, v] of Object.entries(base)) {
    const override = rpcOverrides[v.chainId]
    withRpc[v.chainId] = override ? { ...v, rpcUrl: override } : v
    void k
  }
  return withRpc
}

/** 取某链某交易对的 (tokenIn=Token0/base, tokenOut=Token1/quote)；未登记返回 null */
export function pairTokens(
  chain: ChainRelayConfig,
  pair: string,
): { tokenIn: string; tokenOut: string } | null {
  const [base, quote] = pair.split('/')
  if (!base || !quote) return null
  const tokenIn = chain.tokens[base]
  const tokenOut = chain.tokens[quote]
  if (!tokenIn || !tokenOut) return null
  return { tokenIn, tokenOut }
}
