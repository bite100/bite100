/**
 * Electron 相关类型定义
 */

interface ElectronUtils {
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
}

interface ElectronDebug {
  checkEthereum: () => boolean;
}

interface ElectronP2P {
  send: (topic: string, data: unknown) => Promise<void>;
  onMessage: (callback: (msg: { topic: string; data?: unknown }) => void) => void;
  isAvailable: boolean;
}

declare global {
  interface Window {
    electronUtils?: ElectronUtils;
    electronDebug?: ElectronDebug;
    electronP2P?: ElectronP2P;
  }
}

export {};
