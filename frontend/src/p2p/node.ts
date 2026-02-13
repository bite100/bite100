import { createLibp2p, Libp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { webRTC } from '@libp2p/webrtc'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@libp2p/gossipsub'
import { kadDHT } from '@libp2p/kad-dht'
import { bootstrap } from '@libp2p/bootstrap'
import { identify } from '@libp2p/identify'
import { P2P_CONFIG } from '../config'

/** 订单广播 GossipSub topic（与节点/relay 约定一致） */
export const ORDERS_TOPIC = 'bite100/orders'

/** 公共 Bootstrap 节点（libp2p 官方/社区，用于 DHT 发现引导） */
const DEFAULT_BOOTSTRAP_LIST = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5LpPjTsojpum7',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
]

export interface P2PNodeOptions {
  /** Bootstrap 节点 multiaddr 列表（可选；不传则用 DEFAULT_BOOTSTRAP_LIST + P2P_CONFIG.BOOTSTRAP_PEERS） */
  bootstrapList?: string[]
  /** 最大连接数（默认 100） */
  maxConnections?: number
  /** 是否启用 DHT（Kademlia 发现，默认 true） */
  enableDHTCache?: boolean
}

export async function createP2PNode(options: P2PNodeOptions = {}): Promise<Libp2p> {
  const {
    bootstrapList: customBootstrap = [],
    maxConnections = 100,
    enableDHTCache = true,
  } = options
  const bootstrapList =
    customBootstrap.length > 0
      ? customBootstrap
      : [...DEFAULT_BOOTSTRAP_LIST, ...(P2P_CONFIG.BOOTSTRAP_PEERS ?? [])]
  const node = await createLibp2p({
    addresses: {
      listen: [
        // WebRTC（浏览器间直连，自动 NAT 穿透）
        '/webrtc',
      ]
    },
    transports: [
      // WebRTC 优先（90% NAT 穿透成功率）
      webRTC({
        rtcConfiguration: {
          iceServers: [
            // Google STUN 服务器
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            // Twilio STUN 服务器
            { urls: 'stun:global.stun.twilio.com:3478' },
            // 可选：添加 TURN 服务器（需要自己部署）
            // {
            //   urls: 'turn:turn.p2p-dex.io:3478',
            //   username: 'user',
            //   credential: 'pass'
            // }
          ],
          // 优化 ICE 候选收集
          iceTransportPolicy: 'all', // 尝试所有候选（relay, srflx, host）
          iceCandidatePoolSize: 10, // 预先收集候选
        }
      }),
      // WebSocket 作为 fallback
      webSockets(),
    ],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      // Bootstrap 节点发现
      ...(bootstrapList.length > 0 ? [bootstrap({ list: bootstrapList })] : []),
      // DHT 节点发现（用于热门订单缓存）
      ...(enableDHTCache
        ? [
            kadDHT({
              clientMode: false, // 同时作为 DHT 客户端和服务器
              kBucketSize: 20,
              // 其余 DHT 优化参数在类型中未暴露，这里不显式配置
              providers: {
                providePrefix: '/p2p-dex/orders/0.0.1',
              } as any,
            }),
          ]
        : []),
      identify(),
    ],
    services: {
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        // 性能优化：限制流数量
        maxInboundStreams: 32,
        maxOutboundStreams: 32,
        msgIdFn: (msg) => {
          const seq = msg.type === 'signed' ? String(msg.sequenceNumber) : `${msg.topic}-${msg.data?.length ?? 0}`
          return new TextEncoder().encode(`${msg.topic}${seq}`)
        },
      })
    },
    connectionManager: {
      // 性能优化：限制最大连接数
      maxConnections,
      // minConnections 在类型里暂无定义，这里仅作运行时配置
      minConnections: 5 as any,
      // 自动断开低质量连接
      autoDial: true,
      autoDialInterval: 10000,
    }
  } as any)

  await node.start()

  node.addEventListener('peer:discovery', (evt) => {
    console.log('[libp2p] 发现新 peer:', evt.detail.id.toString())
  })

  console.log('✅ P2P 节点已启动（Bootstrap + DHT）')
  console.log('📍 PeerID:', node.peerId.toString())
  console.log('🔗 传输: WebRTC (优先) + WebSocket (fallback)')

  return node
}

/**
 * 创建浏览器用 P2P 节点（Bootstrap + DHT 发现，GossipSub 订单广播）
 * 供订单簿页或 App 在需要时启动；可与 relay WS 并存，peer 少时 fallback 到 relay。
 */
export async function createBrowserP2PNode(options: P2PNodeOptions = {}): Promise<Libp2p> {
  return createP2PNode(options)
}
