import { createLibp2p, Libp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { webRTC } from '@libp2p/webrtc'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@libp2p/gossipsub'
import { kadDHT } from '@libp2p/kad-dht'
import { bootstrap } from '@libp2p/bootstrap'
import { identify } from '@libp2p/identify'

export interface P2PNodeOptions {
  /** Bootstrap 节点 multiaddr 列表（可选，用于 DHT 发现） */
  bootstrapList?: string[]
  /** 最大连接数（默认 100） */
  maxConnections?: number
  /** 是否启用 DHT 缓存热门订单 */
  enableDHTCache?: boolean
}

export async function createP2PNode(options: P2PNodeOptions = {}): Promise<Libp2p> {
  const {
    bootstrapList = [],
    maxConnections = 100,
    enableDHTCache = true,
  } = options
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
      bootstrap({
        list: bootstrapList.length > 0 ? bootstrapList : [],
      })
    ],
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
      minConnections: 5,
      // 自动断开低质量连接
      autoDial: true,
      autoDialInterval: 10000,
    }
  } as any)

  await node.start()
  console.log('✅ P2P 节点已启动')
  console.log('📍 PeerID:', node.peerId.toString())
  console.log('🔗 传输协议: WebRTC (优先) + WebSocket (fallback)')
  
  return node
}
