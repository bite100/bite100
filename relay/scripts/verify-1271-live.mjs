/**
 * ERC-1271 回退路径的真实链上只读冒烟（需要网络能直达 Sepolia 公共 RPC）：
 * 拿第 27 轮真实 MakerVault 地址构造一张订单，用未注册签名者的钥签名，
 * 经 publicClient.verifyTypedData 走 RPC 调金库 isValidSignature——
 * 预期返回 false（金库不认识这个签名者），而不是抛错：返回布尔裁决就证明
 * 回退路径真实打通了「中继 → RPC → 金库合约」这条链。
 * 只读校验，不发任何交易。用法：node scripts/verify-1271-live.mjs
 */
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const VAULT = '0x47f26952cDB5a3FC5cd693c43819f353D20666C3' // Sepolia MakerVault（阶段 3 切换栈，2026-11-08）
const SETTLEMENT = '0xbf2B9635B682Ff30E73028a5b2beEB829873a88f' // Sepolia Settlement（阶段 3 切换栈）
const BTC = '0x8EDa0025C245B10eA1E10c257674B794C85350f3'
const USDT = '0x6Ca8cb68Ee5BB15474f1cfFE07B895C974Ab9c6e'

const ORDER_TYPES = {
  Order: [
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
    { name: 'side', type: 'uint8' },
  ],
}

const stranger = privateKeyToAccount(generatePrivateKey()) // 未注册签名者
const now = Math.floor(Date.now() / 1000)
const message = {
  orderId: 'live-1271-smoke',
  userAddress: VAULT,
  tokenIn: BTC,
  tokenOut: USDT,
  amountIn: 1000000000000000000n,
  amountOut: 60000000000000000000000n,
  price: 60000000000000000000000n,
  timestamp: BigInt(now),
  expiresAt: BigInt(now + 3600),
  nonce: 0n,
  side: 0, // buy（规范 §2：buy ↔ 0；本脚本只验 1271 回退路径，方向取任一合法值）
}
const domain = { name: '比特100', version: '1', chainId: 11155111, verifyingContract: SETTLEMENT }
const signature = await stranger.signTypedData({
  domain,
  types: ORDER_TYPES,
  primaryType: 'Order',
  message,
})

const client = createPublicClient({
  chain: sepolia,
  transport: http('https://ethereum-sepolia.publicnode.com', { timeout: 15000 }),
})

try {
  const code = await client.getCode({ address: VAULT })
  console.log(`[1271-live] MakerVault has code: ${code && code !== '0x' ? 'yes' : 'no'}`)
  const verdict = await client.verifyTypedData({
    address: VAULT,
    domain,
    types: ORDER_TYPES,
    primaryType: 'Order',
    message,
    signature,
  })
  console.log(
    `[1271-live] publicClient.verifyTypedData verdict for unregistered signer: ${verdict} (expected false — a boolean verdict means the RPC→isValidSignature path works)`,
  )
} catch (e) {
  console.log(`[1271-live] RPC path error (network unreachable from this host?): ${e.message}`)
  process.exitCode = 2
}
