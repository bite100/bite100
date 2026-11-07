/**
 * 本地 mock Nostr 中继（仅供本地演示/测试）：接受 EVENT 并回 OK，
 * 把收到的事件 id 与 kind 打到 stdout。不是真中继，不做存储/订阅。
 * 用法：node scripts/mock-relay.mjs [port]   默认 7777
 */
import { WebSocketServer } from 'ws'

const port = Number(process.argv[2] ?? 7777)
const wss = new WebSocketServer({ port, host: '127.0.0.1' })

wss.on('listening', () => console.log(`[mock-relay] listening on ws://127.0.0.1:${port}`))
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg[0] === 'EVENT') {
        const ev = msg[1]
        console.log(`[mock-relay] EVENT id=${ev.id} kind=${ev.kind} tags=${JSON.stringify(ev.tags)}`)
        ws.send(JSON.stringify(['OK', ev.id, true, '']))
      }
    } catch {
      // 非 JSON 消息忽略
    }
  })
})
