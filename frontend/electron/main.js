import { app, BrowserWindow, session, dialog, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** P2P 桥接：Go 节点 WebSocket 地址（可通过环境变量 P2P_WS_URL 覆盖，如 ws://localhost:9000） */
const P2P_WS_URL = process.env.P2P_WS_URL || 'ws://localhost:9000';

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
  if (!extPath) return;
  try {
    const ext = await ses.loadExtension(extPath);
    console.log('MetaMask extension loaded:', ext?.id || extPath);
  } catch (err) {
    console.warn('Failed to load MetaMask extension:', err.message);
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

  startP2PBridge(win);
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

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:main');
  try {
    await loadMetaMaskExtension(ses);
  } catch (err) {
    console.warn('MetaMask load skipped:', err?.message || err);
  }
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
