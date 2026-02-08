'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 暴露给 renderer 的 P2P 桥接 API（Electron 内置/桥接 Go 节点时使用）
 * - send(topic, data): 通过 main 进程 WebSocket 发送到 Go 节点
 * - onMessage(cb): 接收来自 Go 节点的消息 { topic, data }
 */
contextBridge.exposeInMainWorld('electronP2P', {
  send: (topic, data) => ipcRenderer.invoke('p2p-send', topic, data),
  onMessage: (callback) => {
    ipcRenderer.on('p2p-message', (_event, msg) => callback(msg));
  },
  isAvailable: true,
});

/**
 * 暴露调试信息，帮助检查 MetaMask 扩展状态
 * 扩展会在页面加载后注入 window.ethereum
 */
contextBridge.exposeInMainWorld('electronDebug', {
  checkEthereum: () => {
    // 这个函数会在 renderer 进程中调用
    return typeof window !== 'undefined' && typeof window.ethereum !== 'undefined';
  },
});

/**
 * 暴露工具函数，用于打开外部链接
 */
contextBridge.exposeInMainWorld('electronUtils', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
