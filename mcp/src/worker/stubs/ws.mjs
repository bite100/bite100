/**
 * 'ws' 的 Workers 打包打桩（第 57 轮）：本包在任何形态下都只用 HTTP
 * JSON-RPC（ethers JsonRpcProvider 走全局 fetch），从不构造
 * WebSocketProvider。但 ethers 的 provider-websocket 模块在加载期
 * import 'ws'，其 Node 实现拖着 node:http / node:net / node:zlib 等
 * 导入——本账号的 Workers 上传校验实测不接受 node:http（10021）。
 * Workers 打包时把 'ws' 别名到这个空实现：模块可正常加载，真去
 * 构造 WebSocket 时立即抛错（宁可响亮失败，不要静默错行为）。
 */
class WsStub {
  constructor() {
    throw new Error('ws is stubbed in the Workers build: WebSocketProvider is not supported here')
  }
}

export default WsStub
export { WsStub as WebSocket, WsStub as WebSocketServer, WsStub as Server, WsStub as Receiver, WsStub as Sender }
