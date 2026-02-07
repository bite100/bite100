import { app, BrowserWindow, session } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

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

function createWindow(ses) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: ses,
    },
    title: 'P2P 交易所',
    show: false,
  });

  win.once('ready-to-show', () => win.show());

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    const index = path.join(__dirname, '../dist/index.html');
    win.loadFile(index);
  }
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:main');
  await loadMetaMaskExtension(ses);
  createWindow(ses);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const ses = session.fromPartition('persist:main');
    createWindow(ses);
  }
});
