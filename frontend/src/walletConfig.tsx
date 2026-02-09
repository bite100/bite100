/**
 * Wagmi 配置：多链 + 注入钱包（MetaMask 等），用于后续迁移连接逻辑到 useConnect/useAccount
 */
import { createConfig, http } from 'wagmi'
import { mainnet, polygon, sepolia } from 'wagmi/chains'
import { injected, walletConnect } from '@wagmi/connectors'

const SEPOLIA_RPC = 'https://ethereum-sepolia.publicnode.com'
const MAINNET_RPC = 'https://ethereum.publicnode.com'
const POLYGON_RPC = 'https://polygon-rpc.com'

const wcProjectId = import.meta.env.VITE_WC_PROJECT_ID

const connectors = [
  injected(),
  ...(wcProjectId
    ? [
        walletConnect({
          projectId: wcProjectId,
          showQrModal: true,
        }),
      ]
    : []),
]

export const wagmiConfig = createConfig({
  chains: [sepolia, mainnet, polygon],
  connectors,
  transports: {
    [sepolia.id]: http(SEPOLIA_RPC),
    [mainnet.id]: http(MAINNET_RPC),
    [polygon.id]: http(POLYGON_RPC),
  },
})
