import { app, BrowserWindow, session, dialog, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** P2P 模式：'ws' = WebSocket 桥接到 Go 节点，'libp2p' = JS-libp2p TCP（推荐） */
const P2P_MODE = process.env.P2P_MODE || 'libp2p';
/** P2P 桥接：Go 节点 WebSocket 地址（P2P_MODE=ws 时使用） */
const P2P_WS_URL = process.env.P2P_WS_URL || 'ws://localhost:9000';
/** Bootstrap 节点列表（P2P_MODE=libp2p 时使用） */
const P2P_BOOTSTRAP = process.env.P2P_BOOTSTRAP ? process.env.P2P_BOOTSTRAP.split(',') : [];

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// 防止未捕获异常导致进程直接退出（闪退）
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  try {
    dialog.showErrorBox('P2P 交易所', `程序异常：${err?.message || String(err)}\n请查看控制台或联系支持。`);
  } catch (_) {}
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at', promise, 'reason:', reason);
});

const METAMASK_ID = 'nkbihfbeogaeaoehlefnkodbefgpgknn';

/** 查找 Chrome/Edge 中已安装的 MetaMask 扩展路径 */
function findMetaMaskPath() {
  const basePaths = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    if (localAppData) {
      basePaths.push(path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Extensions', METAMASK_ID));
      basePaths.push(path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Extensions', METAMASK_ID));
    }
  } else if (process.platform === 'darwin') {
    const home = process.env.HOME || '';
    if (home) {
      basePaths.push(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Extensions', METAMASK_ID));
      basePaths.push(path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'Default', 'Extensions', METAMASK_ID));
    }
  } else {
    const home = process.env.HOME || '';
    if (home) {
      basePaths.push(path.join(home, '.config', 'google-chrome', 'Default', 'Extensions', METAMASK_ID));
      basePaths.push(path.join(home, '.config', 'microsoft-edge', 'Default', 'Extensions', METAMASK_ID));
    }
  }
  for (const base of basePaths) {
    try {
      if (!fs.existsSync(base)) continue;
      const versions = fs.readdirSync(base);
      if (versions.length === 0) continue;
      const latest = versions.sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const va = pa[i] || 0;
          const vb = pb[i] || 0;
          if (va !== vb) return vb - va;
        }
        return 0;
      })[0];
      const fullPath = path.join(base, latest);
      if (fs.existsSync(path.join(fullPath, 'manifest.json'))) return fullPath;
    } catch (_) {
      // 权限或路径异常则跳过该路径
    }
  }
  return null;
}

async function loadMetaMaskExtension(ses) {
  const extPath = findMetaMaskPath();
  if (!extPath) {
    console.warn('⚠️ MetaMask 扩展未找到，请确保已在 Chrome 或 Edge 中安装 MetaMask');
    console.warn('   扩展路径查找位置：');
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || '';
      console.warn(`   - ${path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Extensions', METAMASK_ID)}`);
      console.warn(`   - ${path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Extensions', METAMASK_ID)}`);
    }
    return;
  }
  try {
    const ext = await ses.loadExtension(extPath);
    console.log('✅ MetaMask 扩展已加载:', ext?.id || extPath);
    console.log('   扩展名称:', ext?.name || '未知');
    // 等待扩展初始化
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (err) {
    console.error('❌ 加载 MetaMask 扩展失败:', err.message);
    console.error('   错误详情:', err);
  }
}

let mainWindow = null;

function createWindow(ses) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      session: ses,
    },
    title: 'P2P 交易所',
    show: false,
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());

  // 监听页面加载完成，检查扩展状态
  win.webContents.on('did-finish-load', () => {
    // 检查扩展是否已加载
    ses.getAllExtensions().then(extensions => {
      const metamask = extensions.find(ext => ext.id === METAMASK_ID || ext.name?.toLowerCase().includes('metamask'));
      if (metamask) {
        console.log('✅ MetaMask 扩展在页面中可用:', metamask.name);
      } else {
        console.warn('⚠️ MetaMask 扩展未在页面中检测到');
      }
    }).catch(err => {
      console.warn('检查扩展状态失败:', err.message);
    });
  });

  if (isDev) {
    win.loadURL('http://localhost:5173').catch((err) => {
      console.error('Load dev URL failed:', err);
      win.loadURL('data:text/html,<h1>请先运行 npm run dev 启动 Vite</h1><p>再执行 npm run electron:dev</p>');
    });
    win.webContents.openDevTools();
  } else {
    const index = path.join(__dirname, '../dist/index.html');
    if (!fs.existsSync(index)) {
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;padding:2rem;">' +
        '<h1>缺少前端文件</h1><p>请先执行 <code>npm run build:electron</code> 或 <code>npm run dist</code> 再运行桌面版。</p>' +
        '<p>预期文件：' + index + '</p></body></html>'
      ));
    } else {
      win.loadFile(index).catch((err) => {
        console.error('Load file failed:', err);
        dialog.showErrorBox('加载失败', '无法加载 index.html：' + (err?.message || String(err)));
      });
    }
  }

  // 根据模式启动 P2P
  if (P2P_MODE === 'libp2p') {
    startP2PClient(win);
  } else {
    startP2PBridge(win);
  }
}

/** 启动 JS-libp2p P2P 客户端（Node.js TCP transport，比 WebSocket 更稳定） */
async function startP2PClient(win) {
  try {
    // 动态导入 P2P 客户端（ESM 模块）
    const { initP2PClient, stopP2PClient, getP2PNode } = await import('../dist/src/services/p2p-client.js');
    
    // 初始化 P2P 客户端
    const node = await initP2PClient({
      bootstrapList: P2P_BOOTSTRAP,
      maxConnections: 100,
      enableDHTCache: true,
    });

    console.log('✅ JS-libp2p P2P 客户端已启动');
    console.log('📍 PeerID:', node.peerId.toString());
    console.log('🔗 传输协议: TCP (Node.js)');

    // 订阅 GossipSub 主题（与 types.ts 中的 TOPICS 一致）
    const topics = [
      '/p2p-exchange/order/new',
      '/p2p-exchange/order/cancel',
      '/p2p-exchange/trade/executed',
    ];
    for (const topic of topics) {
      await node.pubsub.subscribe(topic);
      console.log(`📡 已订阅主题: ${topic}`);
    }

    // 监听消息
    node.pubsub.addEventListener('message', (evt) => {
      const { topic, data } = evt.detail;
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send('p2p-message', {
          topic: topic,
          data: data.toString(),
        });
      }
    });

    // IPC：发送消息到 P2P 网络
    ipcMain.handle('p2p-send', async (_event, topic, data) => {
      try {
        await node.pubsub.publish(topic, new TextEncoder().encode(data));
        return { success: true };
      } catch (err) {
        console.error('P2P 发送失败:', err);
        return { success: false, error: err.message };
      }
    });

    // 应用退出时停止 P2P 客户端
    app.on('before-quit', async () => {
      await stopP2PClient();
    });
  } catch (err) {
    console.error('❌ JS-libp2p P2P 客户端启动失败:', err);
    console.log('⚠️  回退到 WebSocket 桥接模式');
    startP2PBridge(win);
  }
}

/** 启动 P2P 桥接：main 进程连 Go 节点 WebSocket，renderer 通过 IPC 发/收订单 */
function startP2PBridge(win) {
  let ws = null;

  function sendToRenderer(topic, data) {
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send('p2p-message', { topic, data });
    }
  }

  function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    try {
      ws = new WebSocket(P2P_WS_URL);
      ws.on('open', () => console.log('P2P 桥接已连接:', P2P_WS_URL));
      ws.on('message', (buf) => {
        try {
          const msg = JSON.parse(buf.toString());
          if (msg && msg.topic != null) sendToRenderer(msg.topic, msg.data ?? msg);
        } catch (_) {
          sendToRenderer('', buf.toString());
        }
      });
      ws.on('close', () => {
        console.log('P2P 桥接断开，5s 后重连');
        setTimeout(connect, 5000);
      });
      ws.on('error', (err) => console.warn('P2P 桥接错误:', err?.message));
    } catch (err) {
      console.warn('P2P 桥接创建失败:', err?.message);
    }
  }

  ipcMain.handle('p2p-send', (_event, topic, data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ topic, data }));
    }
  });

  connect();
}

// 处理打开外部链接
ipcMain.handle('open-external', async (_event, url) => {
  if (!url || typeof url !== 'string') {
    console.error('❌ 无效的 URL:', url);
    return { success: false, error: 'Invalid URL' };
  }
  
  try {
    await shell.openExternal(url);
    console.log('✅ 已打开外部链接:', url);
    return { success: true };
  } catch (err) {
    console.error('❌ 打开外部链接失败:', err);
    return { success: false, error: err?.message || String(err) };
  }
});

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:main');
  
  // 先加载扩展，再创建窗口
  try {
    await loadMetaMaskExtension(ses);
  } catch (err) {
    console.warn('MetaMask load skipped:', err?.message || err);
  }
  
  // 等待扩展初始化
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  createWindow(ses);
}).catch((err) => {
  console.error('app.whenReady failed:', err);
  dialog.showErrorBox('P2P 交易所', '启动失败：' + (err?.message || String(err)));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      const ses = session.fromPartition('persist:main');
      createWindow(ses);
    } catch (err) {
      console.error('activate createWindow failed:', err);
      dialog.showErrorBox('P2P 交易所', '重新打开窗口失败：' + (err?.message || String(err)));
    }
  }
});
