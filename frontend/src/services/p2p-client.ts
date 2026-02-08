/**
 * Electron P2P 客户端（Node.js 环境）
 * 使用 TCP transport，比浏览器 WebSocket 更稳定
 */
import { createLibp2p, Libp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@libp2p/gossipsub'
import { kadDHT } from '@libp2p/kad-dht'
import { bootstrap } from '@libp2p/bootstrap'
import { identify } from '@libp2p/identify'

export interface P2PClientOptions {
  /** Bootstrap 节点 multiaddr 列表 */
  bootstrapList?: string[]
  /** 最大连接数（默认 100） */
  maxConnections?: number
  /** 是否启用 DHT 缓存 */
  enableDHTCache?: boolean
}

let p2pNode: Libp2p | null = null

/**
 * 初始化 P2P 客户端（Node.js 环境）
 */
export async function initP2PClient(options: P2PClientOptions = {}): Promise<Libp2p> {
  if (p2pNode) {
    return p2pNode
  }

  const {
    bootstrapList = [],
    maxConnections = 100,
    enableDHTCache = true,
  } = options

  // 获取随机端口（0 = 系统分配）
  const port = 0

  p2pNode = await createLibp2p({
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${port}`],
    },
    transports: [
      // TCP transport（Node.js 环境，比 WebSocket 更稳定）
      tcp(),
    ],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    pubsub: gossipsub({
      // 性能优化：限制连接数
      maxInboundStreams: 32,
      maxOutboundStreams: 32,
    }),
    peerDiscovery: [
      // Bootstrap 节点发现
      ...(bootstrapList.length > 0 ? [bootstrap({ list: bootstrapList })] : []),
      // DHT 节点发现（用于热门订单缓存）
      ...(enableDHTCache ? [kadDHT({
        clientMode: false, // 同时作为 DHT 客户端和服务器
        kBucketSize: 20,
        // DHT 查询优化
        queryTimeout: 10000,
        providers: {
          // 缓存热门订单
          providePrefix: '/p2p-dex/orders/0.0.1',
        },
      })] : []),
      identify(),
    ],
    connectionManager: {
      // 性能优化：限制最大连接数
      maxConnections,
      minConnections: 5,
      // 自动断开低质量连接
      autoDial: true,
      autoDialInterval: 10000,
    },
  })

  // 启动节点
  await p2pNode.start()
  
  console.log('✅ P2P 客户端已启动')
  console.log('📡 监听地址:', p2pNode.getMultiaddrs().map(addr => addr.toString()).join(', '))
  console.log('🔗 最大连接数:', maxConnections)

  // 监听连接事件
  p2pNode.addEventListener('peer:connect', (evt) => {
    console.log('🔗 已连接节点:', evt.detail.toString())
  })

  p2pNode.addEventListener('peer:disconnect', (evt) => {
    console.log('❌ 节点断开:', evt.detail.toString())
  })

  return p2pNode
}

/**
 * 获取 P2P 节点实例
 */
export function getP2PNode(): Libp2p | null {
  return p2pNode
}

/**
 * 停止 P2P 客户端
 */
export async function stopP2PClient(): Promise<void> {
  if (p2pNode) {
    await p2pNode.stop()
    p2pNode = null
    console.log('🛑 P2P 客户端已停止')
  }
}
