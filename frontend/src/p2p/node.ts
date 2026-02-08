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
}

export async function createP2PNode(options: P2PNodeOptions = {}): Promise<Libp2p> {
  const { bootstrapList = [] } = options
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
    services: {
      identify: identify(),
      dht: kadDHT({
        clientMode: true
      }),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        msgIdFn: (msg) => {
          const seq = msg.type === 'signed' ? String(msg.sequenceNumber) : `${msg.topic}-${msg.data?.length ?? 0}`
          return new TextEncoder().encode(`${msg.topic}${seq}`)
        },
      })
    },
    connectionManager: {
      maxConnections: 100,
    }
  } as any)

  await node.start()
  console.log('✅ P2P 节点已启动')
  console.log('📍 PeerID:', node.peerId.toString())
  console.log('🔗 传输协议: WebRTC (优先) + WebSocket (fallback)')
  
  return node
}
