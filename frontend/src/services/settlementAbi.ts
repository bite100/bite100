/**
 * Settlement 合约 ABI（settle 系列 + getCurrentNonce + 结算事件）
 * 自动生成自 contracts/out/Settlement.sol/Settlement.json，合约接口变更后重新生成，勿手改
 */
export const SETTLEMENT_ABI = [
  {
    "type": "function",
    "name": "getCurrentNonce",
    "inputs": [
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "settleTrade",
    "inputs": [
      {
        "name": "fill",
        "type": "tuple",
        "internalType": "struct Settlement.Fill",
        "components": [
          {
            "name": "makerOrder",
            "type": "tuple",
            "internalType": "struct Settlement.SignedOrder",
            "components": [
              {
                "name": "order",
                "type": "tuple",
                "internalType": "struct Settlement.Order",
                "components": [
                  {
                    "name": "orderId",
                    "type": "string",
                    "internalType": "string"
                  },
                  {
                    "name": "userAddress",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenIn",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenOut",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "amountIn",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "amountOut",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "price",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "timestamp",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "expiresAt",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "nonce",
                    "type": "uint256",
                    "internalType": "uint256"
                  }
                ]
              },
              {
                "name": "signature",
                "type": "bytes",
                "internalType": "bytes"
              }
            ]
          },
          {
            "name": "takerOrder",
            "type": "tuple",
            "internalType": "struct Settlement.SignedOrder",
            "components": [
              {
                "name": "order",
                "type": "tuple",
                "internalType": "struct Settlement.Order",
                "components": [
                  {
                    "name": "orderId",
                    "type": "string",
                    "internalType": "string"
                  },
                  {
                    "name": "userAddress",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenIn",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenOut",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "amountIn",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "amountOut",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "price",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "timestamp",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "expiresAt",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "nonce",
                    "type": "uint256",
                    "internalType": "uint256"
                  }
                ]
              },
              {
                "name": "signature",
                "type": "bytes",
                "internalType": "bytes"
              }
            ]
          },
          {
            "name": "tokenIn",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "tokenOut",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amountIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "amountOut",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "gasReimburseIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "gasReimburseOut",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settleTradesBatch",
    "inputs": [
      {
        "name": "fills",
        "type": "tuple[]",
        "internalType": "struct Settlement.Fill[]",
        "components": [
          {
            "name": "makerOrder",
            "type": "tuple",
            "internalType": "struct Settlement.SignedOrder",
            "components": [
              {
                "name": "order",
                "type": "tuple",
                "internalType": "struct Settlement.Order",
                "components": [
                  {
                    "name": "orderId",
                    "type": "string",
                    "internalType": "string"
                  },
                  {
                    "name": "userAddress",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenIn",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenOut",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "amountIn",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "amountOut",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "price",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "timestamp",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "expiresAt",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "nonce",
                    "type": "uint256",
                    "internalType": "uint256"
                  }
                ]
              },
              {
                "name": "signature",
                "type": "bytes",
                "internalType": "bytes"
              }
            ]
          },
          {
            "name": "takerOrder",
            "type": "tuple",
            "internalType": "struct Settlement.SignedOrder",
            "components": [
              {
                "name": "order",
                "type": "tuple",
                "internalType": "struct Settlement.Order",
                "components": [
                  {
                    "name": "orderId",
                    "type": "string",
                    "internalType": "string"
                  },
                  {
                    "name": "userAddress",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenIn",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenOut",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "amountIn",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "amountOut",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "price",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "timestamp",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "expiresAt",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "nonce",
                    "type": "uint256",
                    "internalType": "uint256"
                  }
                ]
              },
              {
                "name": "signature",
                "type": "bytes",
                "internalType": "bytes"
              }
            ]
          },
          {
            "name": "tokenIn",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "tokenOut",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amountIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "amountOut",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "gasReimburseIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "gasReimburseOut",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settleTradesBatchWithGasSavings",
    "inputs": [
      {
        "name": "fills",
        "type": "tuple[]",
        "internalType": "struct Settlement.Fill[]",
        "components": [
          {
            "name": "makerOrder",
            "type": "tuple",
            "internalType": "struct Settlement.SignedOrder",
            "components": [
              {
                "name": "order",
                "type": "tuple",
                "internalType": "struct Settlement.Order",
                "components": [
                  {
                    "name": "orderId",
                    "type": "string",
                    "internalType": "string"
                  },
                  {
                    "name": "userAddress",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenIn",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenOut",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "amountIn",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "amountOut",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "price",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "timestamp",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "expiresAt",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "nonce",
                    "type": "uint256",
                    "internalType": "uint256"
                  }
                ]
              },
              {
                "name": "signature",
                "type": "bytes",
                "internalType": "bytes"
              }
            ]
          },
          {
            "name": "takerOrder",
            "type": "tuple",
            "internalType": "struct Settlement.SignedOrder",
            "components": [
              {
                "name": "order",
                "type": "tuple",
                "internalType": "struct Settlement.Order",
                "components": [
                  {
                    "name": "orderId",
                    "type": "string",
                    "internalType": "string"
                  },
                  {
                    "name": "userAddress",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenIn",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenOut",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "amountIn",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "amountOut",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "price",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "timestamp",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "expiresAt",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "nonce",
                    "type": "uint256",
                    "internalType": "uint256"
                  }
                ]
              },
              {
                "name": "signature",
                "type": "bytes",
                "internalType": "bytes"
              }
            ]
          },
          {
            "name": "tokenIn",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "tokenOut",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amountIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "amountOut",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "gasReimburseIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "gasReimburseOut",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "gasSavingsUsdt6",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settleTradesBatchWithMerkle",
    "inputs": [
      {
        "name": "batchId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "fills",
        "type": "tuple[]",
        "internalType": "struct Settlement.Fill[]",
        "components": [
          {
            "name": "makerOrder",
            "type": "tuple",
            "internalType": "struct Settlement.SignedOrder",
            "components": [
              {
                "name": "order",
                "type": "tuple",
                "internalType": "struct Settlement.Order",
                "components": [
                  {
                    "name": "orderId",
                    "type": "string",
                    "internalType": "string"
                  },
                  {
                    "name": "userAddress",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenIn",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenOut",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "amountIn",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "amountOut",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "price",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "timestamp",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "expiresAt",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "nonce",
                    "type": "uint256",
                    "internalType": "uint256"
                  }
                ]
              },
              {
                "name": "signature",
                "type": "bytes",
                "internalType": "bytes"
              }
            ]
          },
          {
            "name": "takerOrder",
            "type": "tuple",
            "internalType": "struct Settlement.SignedOrder",
            "components": [
              {
                "name": "order",
                "type": "tuple",
                "internalType": "struct Settlement.Order",
                "components": [
                  {
                    "name": "orderId",
                    "type": "string",
                    "internalType": "string"
                  },
                  {
                    "name": "userAddress",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenIn",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "tokenOut",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "amountIn",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "amountOut",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "price",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "timestamp",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "expiresAt",
                    "type": "uint256",
                    "internalType": "uint256"
                  },
                  {
                    "name": "nonce",
                    "type": "uint256",
                    "internalType": "uint256"
                  }
                ]
              },
              {
                "name": "signature",
                "type": "bytes",
                "internalType": "bytes"
              }
            ]
          },
          {
            "name": "tokenIn",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "tokenOut",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amountIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "amountOut",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "gasReimburseIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "gasReimburseOut",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "proofs",
        "type": "bytes32[][]",
        "internalType": "bytes32[][]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "GasSavingsDistributed",
    "inputs": [
      {
        "name": "userRebateUsdt",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "toFeeDistributorUsdt",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "toFounderUsdt",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TradeSettled",
    "inputs": [
      {
        "name": "maker",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "taker",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "tokenIn",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "tokenOut",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amountIn",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountOut",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "feeAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TradeSettledWithGasReimburse",
    "inputs": [
      {
        "name": "maker",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "taker",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "tokenIn",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "tokenOut",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amountIn",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountOut",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "feeAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "gasReimburseIn",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "gasReimburseOut",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "gasRecipient",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  }
]
