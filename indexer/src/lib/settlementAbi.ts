/**
 * Settlement ABI 子集（索引器专用）——事件与 settle 系列入口。
 *
 * 来源与版本标识：contracts/out/Settlement.sol/Settlement.json（Foundry 产物，
 * 对应第 47 轮部署栈：Sepolia 0x5697F7B2178352eB391e29fc2c5681Dea864C1d9 /
 * Base Sepolia 0x1021C7116cCE59f9c85683d6f1b5aD2215795949）。合约接口变更后
 * 须同步更新本文件与 config.yaml 的事件签名（config.yaml 头部有同一标识）。
 * 这里只保留索引器用到的 3 个事件 + 4 个 settle 入口（calldata 解码关联
 * digest 用），其余 ABI 不复制，避免再造一份全量 ABI 副本。
 */

const ORDER_COMPONENTS = [
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
  // 阶段 3 切换（块B-⑧）：Order 末位新增 side（uint8，0=buy / 1=sell），
  // 与 docs/eip712-order-spec.md §2 的元组分量顺序逐字对齐；旧结构体
  // calldata 按新定义解码会错位/失败，属预期（旧单全部作废，见规范 §9）。
  { name: 'side', type: 'uint8' },
] as const

const SIGNED_ORDER_COMPONENTS = [
  { name: 'order', type: 'tuple', components: ORDER_COMPONENTS },
  { name: 'signature', type: 'bytes' },
] as const

const FILL_COMPONENTS = [
  { name: 'makerOrder', type: 'tuple', components: SIGNED_ORDER_COMPONENTS },
  { name: 'takerOrder', type: 'tuple', components: SIGNED_ORDER_COMPONENTS },
  { name: 'tokenIn', type: 'address' },
  { name: 'tokenOut', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'amountOut', type: 'uint256' },
  { name: 'gasReimburseIn', type: 'uint256' },
  { name: 'gasReimburseOut', type: 'uint256' },
] as const

/** settle 系列入口（calldata → Fill[] 解码用） */
export const SETTLEMENT_WRITE_ABI = [
  {
    type: 'function',
    name: 'settleTrade',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'fill', type: 'tuple', components: FILL_COMPONENTS }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settleTradesBatch',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'fills', type: 'tuple[]', components: FILL_COMPONENTS }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settleTradesBatchWithGasSavings',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'fills', type: 'tuple[]', components: FILL_COMPONENTS },
      { name: 'gasSavingsUsdt6', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settleTradesBatchWithMerkle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'batchId', type: 'uint256' },
      { name: 'merkleRoot', type: 'bytes32' },
      { name: 'fills', type: 'tuple[]', components: FILL_COMPONENTS },
      { name: 'proofs', type: 'bytes32[][]' },
    ],
    outputs: [],
  },
] as const

/** 索引事件（与 config.yaml 的事件签名逐字一致） */
export const SETTLEMENT_EVENT_ABI = [
  {
    type: 'event',
    name: 'TradeSettled',
    inputs: [
      { name: 'maker', type: 'address', indexed: true },
      { name: 'taker', type: 'address', indexed: true },
      { name: 'tokenIn', type: 'address', indexed: true },
      { name: 'tokenOut', type: 'address', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TradeSettledWithGasReimburse',
    inputs: [
      { name: 'maker', type: 'address', indexed: true },
      { name: 'taker', type: 'address', indexed: true },
      { name: 'tokenIn', type: 'address', indexed: true },
      { name: 'tokenOut', type: 'address', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
      { name: 'gasReimburseIn', type: 'uint256', indexed: false },
      { name: 'gasReimburseOut', type: 'uint256', indexed: false },
      { name: 'gasRecipient', type: 'address', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'GasCostShared',
    inputs: [
      { name: 'maker', type: 'address', indexed: true },
      { name: 'taker', type: 'address', indexed: true },
      { name: 'gasRecipient', type: 'address', indexed: true },
      { name: 'gasUsed', type: 'uint256', indexed: false },
      { name: 'gasCostWei', type: 'uint256', indexed: false },
      { name: 'reason', type: 'uint8', indexed: false },
      { name: 'makerToken', type: 'address', indexed: false },
      { name: 'makerDeduct', type: 'uint256', indexed: false },
      { name: 'makerShortfall', type: 'uint256', indexed: false },
      { name: 'takerToken', type: 'address', indexed: false },
      { name: 'takerDeduct', type: 'uint256', indexed: false },
      { name: 'takerShortfall', type: 'uint256', indexed: false },
    ],
  },
] as const
