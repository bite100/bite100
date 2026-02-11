declare global {
  interface Window {
    // 钱包注入的 EIP-1193 provider；部分环境为数组（多扩展时取首个），utils.getEthereum() 会做归一化
    ethereum?: any;
    phantom?: { ethereum?: any };
    trustwallet?: any;
  }
}

export {}

