declare global {
  interface Window {
    // 钱包注入的 EIP-1193 provider（MetaMask / Phantom 等），为简化 TS 类型统一用 any
    ethereum?: any;
    phantom?: {
      ethereum?: any;
    };
  }
}

export {}

