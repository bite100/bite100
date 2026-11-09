/**
 * ERC-1271 回退路径的真实链上只读冒烟（需要网络能直达 Sepolia 公共 RPC）。
 *
 * 【第 54 轮标注：本脚本的样本实例已退役，定位已改为负向验证】
 * 样本是第 47 轮切换栈的 Sepolia MakerVault；该实例已于 2026-11-09
 * 第 53 轮随做市金库产品退役被暂停（paused），其 isValidSignature
 * 在暂停状态下对任何签名者都拒绝。因此现在的预期语义是「拒绝」：
 * 返回 false、或调用以暂停类回滚结束，都只证明「暂停实例恒拒绝」，
 * 不再能证明回退路径对正常合约钱包打通（暂停与未注册签名者两种
 * 拒绝已不可区分）。正向打通验证需要一个未暂停的合约钱包样本，
 * 目前没有——将来若部署了新的测试合约钱包，把下方 VAULT 换成它、
 * 并恢复「未注册签名者应得 false 且不得抛错」的原断言口径。
 *
 * 原始口径（退役前）：拿 MakerVault 地址构造订单、用未注册签名者
 * 签名，经 publicClient.verifyTypedData 走 RPC 调 isValidSignature，
 * 返回 false 而不抛错即证明「中继 → RPC → 合约」回退链打通。
 * 只读校验，不发任何交易。用法：node scripts/verify-1271-live.mjs
 */
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const VAULT = '0x5473D7c58c56BCd855c6f2048614A10e9645F7f0' // Sepolia MakerVault（第 47 轮切换栈；第 53 轮已暂停退役，见文件头）
const SETTLEMENT = '0x5697F7B2178352eB391e29fc2c5681Dea864C1d9' // Sepolia Settlement（第 47 轮切换栈）
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
  console.log(`[1271-live] sample (retired/paused MakerVault) has code: ${code && code !== '0x' ? 'yes' : 'no'}`)
  const verdict = await client.verifyTypedData({
    address: VAULT,
    domain,
    types: ORDER_TYPES,
    primaryType: 'Order',
    message,
    signature,
  })
  console.log(
    `[1271-live] verdict for unregistered signer against the PAUSED sample: ${verdict} (expected rejection under the negative-test semantics — the paused vault rejects every signer; this no longer proves the fallback path works for a live contract wallet)`,
  )
  if (verdict !== false) {
    console.log('[1271-live] UNEXPECTED: a paused instance must not accept any signature')
    process.exitCode = 2
  }
} catch (e) {
  console.log(
    `[1271-live] call ended in error: ${e.message} — consistent with the paused instance reverting (negative-test semantics), or with the RPC being unreachable from this host; the two cannot be distinguished here`,
  )
  process.exitCode = 2
}
